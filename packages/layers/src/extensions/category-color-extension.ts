// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * CategoryColorExtension - GPU-based categorical color lookup.
 *
 * Passes per-feature category indices to the GPU and performs the palette
 * lookup in the fragment shader. Replaces a CPU O(n) RGBA expansion that
 * was the dominant cost on real categorical datasets (AIS vessel types,
 * airport codes, MMSI prefixes).
 *
 * Benefits:
 * - Eliminates the O(n) per-tile CPU loop and the 4n-byte RGBA buffer it
 *   produces. The on-GPU representation is a Uint16-backed Float32 attribute
 *   (4 bytes/feature) plus a single 4096×4-byte palette texture per palette
 *   CONTENT per GPU device — every sublayer of a layer family binds the same
 *   texture, created and uploaded exactly once (content-addressed cache).
 * - Dynamic palette changes bind one freshly-uploaded texture instead of
 *   touching every tile.
 *
 * IMPLEMENTATION:
 * The palette is uploaded as a CATEGORY_PALETTE_SIZE × 1 RGBA texture and
 * sampled by category index in the fragment shader. We use a texture rather
 * than a large `vec4[]` uniform array because uniform array size limits vary
 * across GL backends and 4096 entries exceeds most platforms' guarantees.
 *
 * Why 4096 entries: the AIS dataset reaches ~3500 distinct MMSI country
 * prefixes; the airport-code datasets push ~2000. 256 (the previous limit)
 * silently wrapped these into incorrect colors. Increasing the texture width
 * costs 16 KB per distinct palette per device, which is negligible.
 *
 * Usage:
 * ```ts
 * new ScatterplotLayer({
 *   extensions: [new CategoryColorExtension()],
 *   categoryPalette: [[255, 0, 0, 255], ...], // up to 4096 colors
 *   getCategoryIndex: d => d.category,
 *   useCategoryColor: true,
 * });
 * ```
 * Or, in binary mode, supply `instanceCategoryIndex` as a size-1 float
 * attribute on the data object.
 */

import { LayerExtension } from '@deck.gl/core';
import type {
  Accessor,
  Color,
  DefaultProps,
  Layer,
  LayerContext,
  UpdateParameters,
} from '@deck.gl/core';
import type { Device, Texture } from '@luma.gl/core';
import { colorListDigest } from '../lib/style-digest.js';
import { warnOnce } from '../lib/log.js';

/**
 * Width of the palette texture. The bump from 256 to 4096 covers real-world
 * category spaces (AIS MMSI prefixes, airport codes) that the previous limit
 * silently wrapped. See module docstring for the rationale.
 */
export const CATEGORY_PALETTE_SIZE = 4096;

/** Props for layers using CategoryColorExtension. */
export type CategoryColorExtensionProps<DataT = unknown> = {
  /**
   * Color palette (up to {@link CATEGORY_PALETTE_SIZE} entries).
   * @default []
   */
  categoryPalette?: Color[];
  /**
   * Accessor returning the category index (0..{@link CATEGORY_PALETTE_SIZE}-1).
   * @default 0
   */
  getCategoryIndex?: Accessor<DataT, number>;
  /**
   * Enable categorical coloring. Off by default — the layer must opt in.
   * @default false
   */
  useCategoryColor?: boolean;
};

type CategoryColorUniformProps = {
  paletteSize: number;
  useCategoryColor: number;
};

// layout(std140) matches upstream extension convention; scalar-only blocks
// pack identically either way, but the explicit layout keeps the block safe
// the day someone adds a vec3.
const glslUniformBlock = `\
layout(std140) uniform categoryColorUniforms {
  float paletteSize;
  float useCategoryColor;
} categoryColor;

uniform sampler2D categoryColor_paletteTexture;
`;

// Shader module definition for deck.gl 9.x. The sampler lives outside the
// uniform block because textures cannot be UBO members; it is bound via
// getUniforms — same pattern as deck.gl's own FillStyleExtension.
//
// Exported for the ShaderInputs-based regression test — the getUniforms
// contract below is invisible to attribute-wiring tests.
export const categoryColorUniforms = {
  name: 'categoryColor',
  vs: glslUniformBlock,
  fs: glslUniformBlock,
  uniformTypes: {
    paletteSize: 'f32',
    useCategoryColor: 'f32',
  },
  // CRITICAL (luma.gl 9.3 contract): when a module defines getUniforms, its
  // return value REPLACES the incoming props for that setProps call
  // (`@luma.gl/engine` shader-inputs.ts — `module.getUniforms?.(moduleProps,
  // oldUniforms) || moduleProps`). So the scalars MUST be passed through
  // alongside the renamed texture binding; returning only the binding drops
  // paletteSize/useCategoryColor every frame and the UBO stays
  // zero-initialized. Mirrors upstream FillStyleExtension's
  // getPatternUniforms, which returns all scalars next to the texture.
  getUniforms: (
    opts?: { paletteTexture?: Texture } & Partial<CategoryColorUniformProps>,
  ) => {
    if (!opts) {
      return {};
    }
    const uniforms: Record<string, unknown> = {};
    if ('paletteTexture' in opts && opts.paletteTexture) {
      uniforms.categoryColor_paletteTexture = opts.paletteTexture;
    }
    if (opts.paletteSize !== undefined) {
      uniforms.paletteSize = opts.paletteSize;
    }
    if (opts.useCategoryColor !== undefined) {
      uniforms.useCategoryColor = opts.useCategoryColor;
    }
    return uniforms;
  },
};

const defaultProps: DefaultProps<CategoryColorExtensionProps> = {
  categoryPalette: { type: 'array', value: [], compare: true },
  getCategoryIndex: { type: 'accessor', value: 0 },
  useCategoryColor: false,
};

/**
 * Device-scoped, content-addressed palette texture cache.
 *
 * The extension used to create one 16 KB texture per LAYER — and the animated
 * composite layers emit one sublayer per tile, so the same palette was created
 * and uploaded once per visible tile. Textures now live here, keyed by palette
 * CONTENT per GPU device: every sublayer of a layer family (and any other
 * layer using the same palette) binds the same texture, created and uploaded
 * exactly once. Entries are refcounted by the layers bound to them and
 * destroyed when the last layer unbinds (finalize or palette change), so a
 * dataset switch cannot leak textures.
 */
interface PaletteTextureEntry {
  texture: Texture;
  refs: number;
}

const paletteTextureCaches = new WeakMap<
  Device,
  Map<string, PaletteTextureEntry>
>();

/** Content key for a palette: entry count + RGBA digest (memoized per array reference). */
function paletteDigest(palette: readonly Color[]): string {
  return `${Math.min(palette.length, CATEGORY_PALETTE_SIZE)}|${colorListDigest(palette)}`;
}

function acquirePaletteTexture(
  device: Device,
  palette: readonly Color[],
  digest: string,
): Texture {
  let cache = paletteTextureCaches.get(device);
  if (!cache) {
    cache = new Map();
    paletteTextureCaches.set(device, cache);
  }
  let entry = cache.get(digest);
  if (!entry) {
    const texture = device.createTexture({
      width: CATEGORY_PALETTE_SIZE,
      height: 1,
      format: 'rgba8unorm',
      sampler: {
        minFilter: 'nearest',
        magFilter: 'nearest',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      },
    });
    const paletteSize = Math.min(palette.length, CATEGORY_PALETTE_SIZE);
    const data = new Uint8Array(CATEGORY_PALETTE_SIZE * 4);
    for (let i = 0; i < paletteSize; i++) {
      const color = palette[i];
      data[i * 4] = color[0] ?? 0;
      data[i * 4 + 1] = color[1] ?? 0;
      data[i * 4 + 2] = color[2] ?? 0;
      data[i * 4 + 3] = color[3] ?? 255;
    }
    texture.copyImageData({ data });
    entry = { texture, refs: 0 };
    cache.set(digest, entry);
  }
  entry.refs++;
  return entry.texture;
}

function releasePaletteTexture(device: Device, digest: string): void {
  const cache = paletteTextureCaches.get(device);
  const entry = cache?.get(digest);
  if (!entry) return;
  entry.refs--;
  if (entry.refs <= 0) {
    cache!.delete(digest);
    entry.texture.destroy();
  }
}

/**
 * Layer extension for GPU-based categorical color lookup.
 *
 * Always include in the layer's extension list when categorical coloring is a
 * possibility — the shader branch is gated by `useCategoryColor`, so a layer
 * with the extension installed but the toggle off still draws normally.
 */
export class CategoryColorExtension extends LayerExtension {
  static defaultProps = defaultProps;
  static extensionName = 'CategoryColorExtension';

  getShaders(
    this: Layer<CategoryColorExtensionProps>,
    _extension: CategoryColorExtension,
  ) {
    return {
      modules: [categoryColorUniforms],
      inject: {
        'vs:#decl': `
          in float instanceCategoryIndex;
          out float vCategoryIndex;
        `,
        'vs:#main-end': `
          vCategoryIndex = instanceCategoryIndex;
        `,
        'fs:#decl': `
          in float vCategoryIndex;
        `,
        // Sample the palette texture in the FS. Gated by useCategoryColor so
        // the same layer can still render its constant / property color when
        // the extension is installed but unused.
        'fs:DECKGL_FILTER_COLOR': `
          if (categoryColor.useCategoryColor > 0.5 && categoryColor.paletteSize > 0.0) {
            float idx = clamp(vCategoryIndex, 0.0, categoryColor.paletteSize - 1.0);
            // Sample the centre of texel idx in a CATEGORY_PALETTE_SIZE-wide texture.
            float u = (idx + 0.5) / ${CATEGORY_PALETTE_SIZE}.0;
            vec4 palette = texture(categoryColor_paletteTexture, vec2(u, 0.5));
            // Compose with the INCOMING alpha instead of replacing it:
            // extensions run in list order ([timeFilter, categoryColor]) and
            // the time filter has already written the temporal fade/wake
            // alpha into color.a — replacing the whole vec4 would pin every
            // categorical feature at the palette's own alpha.
            color = vec4(palette.rgb, palette.a * color.a);
          }
        `,
      },
    };
  }

  initializeState(
    this: Layer<CategoryColorExtensionProps>,
    context: LayerContext,
    extension: CategoryColorExtension,
  ): void {
    const attributeManager = this.getAttributeManager();
    if (attributeManager) {
      // add() + stepMode:'dynamic' — NOT addInstanced(), which overrides
      // stepMode to 'instance' and breaks non-instanced models: on
      // SolidPolygonLayer's fill model a divisor-1 attribute reads element 0
      // for every vertex ("all polygons take the first feature's color").
      // 'dynamic' resolves to 'instance' on instanced models (unchanged) and
      // 'vertex' on non-instanced ones — see TimeFilterExtension for the
      // upstream precedent (DataFilterExtension's filterValues).
      attributeManager.add({
        instanceCategoryIndex: {
          size: 1,
          accessor: 'getCategoryIndex',
          type: 'float32',
          stepMode: 'dynamic',
          defaultValue: 0,
        },
      });
    }

    extension.bindPalette(this, context.device);
  }

  updateState(
    this: Layer<CategoryColorExtensionProps>,
    params: UpdateParameters<Layer<CategoryColorExtensionProps>>,
    extension: CategoryColorExtension,
  ): void {
    // Reference check is only the trigger; bindPalette keys by CONTENT, so a
    // re-created but identical palette array never re-uploads or rebinds.
    if (params.props.categoryPalette !== params.oldProps.categoryPalette) {
      extension.bindPalette(this, params.context.device);
    }
  }

  finalizeState(
    this: Layer<CategoryColorExtensionProps>,
    context: LayerContext,
    _extension: CategoryColorExtension,
  ): void {
    const digest = this.state.paletteDigest as string | undefined;
    if (digest !== undefined) {
      releasePaletteTexture(context.device, digest);
    }
  }

  draw(
    this: Layer<CategoryColorExtensionProps>,
    _params: unknown,
    _extension: CategoryColorExtension,
  ): void {
    const { categoryPalette = [], useCategoryColor = false } = this.props;

    // Hard cap: callers must size their palettes within the texture. We
    // assert (warn + clamp) rather than silently wrap, which was the bug in
    // the 256-wide era — categories beyond the limit took whatever color
    // sat at (index mod paletteSize), producing visually-plausible but
    // wrong colors.
    if (categoryPalette.length > CATEGORY_PALETTE_SIZE) {
      warnOnce(
        'CategoryColorExtension:overflow',
        `[CategoryColorExtension] palette has ${categoryPalette.length} ` +
          `entries; only the first ${CATEGORY_PALETTE_SIZE} are uploaded ` +
          'to the palette texture.',
      );
    }

    const paletteSize = Math.min(categoryPalette.length, CATEGORY_PALETTE_SIZE);

    this.setShaderModuleProps({
      categoryColor: {
        paletteSize,
        useCategoryColor: useCategoryColor ? 1.0 : 0.0,
        paletteTexture: this.state.paletteTexture,
      },
    });
  }

  /**
   * Bind the layer to the cache texture for its current `categoryPalette`
   * content, acquiring (and on a content change, releasing the previous)
   * cache entry. Public so the static-bound lifecycle methods can invoke it
   * via the `extension` argument.
   */
  bindPalette(layer: Layer<CategoryColorExtensionProps>, device: Device): void {
    const palette = layer.props.categoryPalette || [];
    const digest = paletteDigest(palette);
    const previous = layer.state.paletteDigest as string | undefined;
    if (previous === digest) return;
    // Acquire before release: never destroy-then-recreate a still-needed entry.
    const paletteTexture = acquirePaletteTexture(device, palette, digest);
    layer.setState({ paletteTexture, paletteDigest: digest });
    if (previous !== undefined) {
      releasePaletteTexture(device, previous);
    }
  }
}

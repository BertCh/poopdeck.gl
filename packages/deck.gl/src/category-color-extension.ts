// @stt/deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/deck.gl contributors

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
 *   (4 bytes/feature) plus a one-time 4096×4-byte palette texture.
 * - Dynamic palette changes update one texture upload instead of every tile.
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
 * costs 16 KB per layer extension instance, which is negligible.
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
import type { Texture } from '@luma.gl/core';
import { warnOnce } from './log';

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

const glslUniformBlock = `\
uniform categoryColorUniforms {
  float paletteSize;
  float useCategoryColor;
} categoryColor;

uniform sampler2D categoryColor_paletteTexture;
`;

// Shader module definition for deck.gl 9.x. The sampler lives outside the
// uniform block because textures cannot be UBO members; it is bound via
// getUniforms — same pattern as deck.gl's own FillStyleExtension.
const categoryColorUniforms = {
  name: 'categoryColor',
  vs: glslUniformBlock,
  fs: glslUniformBlock,
  uniformTypes: {
    paletteSize: 'f32',
    useCategoryColor: 'f32',
  },
  getUniforms: (opts?: { paletteTexture?: Texture } & Partial<CategoryColorUniformProps>) => {
    const uniforms: Record<string, unknown> = {};
    if (opts && 'paletteTexture' in opts && opts.paletteTexture) {
      uniforms.categoryColor_paletteTexture = opts.paletteTexture;
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
 * Layer extension for GPU-based categorical color lookup.
 *
 * Always include in the layer's extension list when categorical coloring is a
 * possibility — the shader branch is gated by `useCategoryColor`, so a layer
 * with the extension installed but the toggle off still draws normally.
 */
export class CategoryColorExtension extends LayerExtension {
  static defaultProps = defaultProps;
  static extensionName = 'CategoryColorExtension';

  getShaders(this: Layer<CategoryColorExtensionProps>, _extension: CategoryColorExtension) {
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
            color = texture(categoryColor_paletteTexture, vec2(u, 0.5));
          }
        `
      }
    };
  }

  initializeState(
    this: Layer<CategoryColorExtensionProps>,
    context: LayerContext,
    extension: CategoryColorExtension
  ): void {
    const attributeManager = this.getAttributeManager();
    if (attributeManager) {
      attributeManager.addInstanced({
        instanceCategoryIndex: {
          size: 1,
          accessor: 'getCategoryIndex',
          type: 'float32',
          stepMode: 'dynamic',
          defaultValue: 0
        }
      });
    }

    // Create the palette texture once. Contents are uploaded here and
    // re-uploaded in updateState whenever the palette prop changes.
    const paletteTexture = context.device.createTexture({
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

    this.setState({ paletteTexture });
    extension.uploadPalette(this);
  }

  updateState(
    this: Layer<CategoryColorExtensionProps>,
    params: UpdateParameters<Layer<CategoryColorExtensionProps>>,
    extension: CategoryColorExtension
  ): void {
    if (params.props.categoryPalette !== params.oldProps.categoryPalette) {
      extension.uploadPalette(this);
    }
  }

  finalizeState(
    this: Layer<CategoryColorExtensionProps>,
    _context: LayerContext,
    _extension: CategoryColorExtension
  ): void {
    const tex = this.state.paletteTexture as Texture | undefined;
    tex?.destroy();
  }

  draw(
    this: Layer<CategoryColorExtensionProps>,
    _params: unknown,
    _extension: CategoryColorExtension
  ): void {
    const {
      categoryPalette = [],
      useCategoryColor = false,
    } = this.props;

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
   * Write the layer's current `categoryPalette` prop into the palette
   * texture. Public so the static-bound lifecycle methods can invoke it via
   * the `extension` argument.
   */
  uploadPalette(layer: Layer<CategoryColorExtensionProps>): void {
    const tex = layer.state.paletteTexture as Texture | undefined;
    if (!tex) return;

    const palette = layer.props.categoryPalette || [];
    const paletteSize = Math.min(palette.length, CATEGORY_PALETTE_SIZE);

    const data = new Uint8Array(CATEGORY_PALETTE_SIZE * 4);
    for (let i = 0; i < paletteSize; i++) {
      const color = palette[i];
      data[i * 4] = color[0] ?? 0;
      data[i * 4 + 1] = color[1] ?? 0;
      data[i * 4 + 2] = color[2] ?? 0;
      data[i * 4 + 3] = color[3] ?? 255;
    }

    tex.copyImageData({ data });
  }
}

/**
 * CategoryColorExtension - GPU-based categorical color lookup
 *
 * Performance optimization (120fps target):
 * Instead of expanding category indices to RGBA on the CPU (O(n) per tile),
 * this extension passes category indices directly to the GPU and performs
 * palette lookup in the fragment shader.
 *
 * Benefits:
 * - Eliminates O(n) CPU loop for color expansion
 * - Reduces memory: 1 byte per feature instead of 4 bytes
 * - Dynamic palette changes without re-uploading attribute data
 *
 * IMPLEMENTATION:
 * The palette is uploaded as a 256x1 RGBA texture and sampled in the fragment
 * shader by category index. A texture is used (rather than a large `vec4[256]`
 * uniform array) because it is robust across GL backends and avoids uniform
 * array size limits.
 *
 * Usage:
 * ```typescript
 * new ScatterplotLayer({
 *   extensions: [new CategoryColorExtension()],
 *   categoryPalette: [[255, 0, 0, 255], [0, 255, 0, 255], ...], // Up to 256 colors
 *   getCategoryIndex: d => d.category, // Returns 0-255
 * });
 * ```
 */

import { LayerExtension } from '@deck.gl/core';
import type { Layer, LayerContext, Accessor, UpdateParameters } from '@deck.gl/core';
import type { Color } from '@deck.gl/core';
import type { Texture } from '@luma.gl/core';

// Maximum palette size (texture width)
const MAX_PALETTE_SIZE = 256;

/**
 * Props for layers using CategoryColorExtension
 */
export type CategoryColorExtensionProps<DataT = any> = {
  /** Color palette array (up to 256 colors) */
  categoryPalette?: Color[];
  /** Accessor to get category index (0-255) from each data object */
  getCategoryIndex?: Accessor<DataT, number>;
  /** Enable categorical coloring (default: true when palette is provided) */
  useCategoryColor?: boolean;
};

// Uniform types for the shader module (scalars only - the palette is a texture)
type CategoryColorUniformProps = {
  paletteSize: number;
  useCategoryColor: number;
};

// Shader uniform block + palette sampler.
// The sampler is declared OUTSIDE the uniform block (textures cannot live in
// a uniform block) and is bound via getUniforms - same pattern as deck.gl's
// own FillStyleExtension.
const glslUniformBlock = `\
uniform categoryColorUniforms {
  float paletteSize;
  float useCategoryColor;
} categoryColor;

uniform sampler2D categoryColor_paletteTexture;
`;

// Shader module definition for deck.gl 9.x
const categoryColorUniforms = {
  name: 'categoryColor',
  vs: glslUniformBlock,
  fs: glslUniformBlock,
  uniformTypes: {
    paletteSize: 'f32',
    useCategoryColor: 'f32',
  },
  // Map the texture passed via setShaderModuleProps to the sampler uniform.
  getUniforms: (opts?: { paletteTexture?: Texture } & Partial<CategoryColorUniformProps>) => {
    const uniforms: Record<string, unknown> = {};
    if (opts && 'paletteTexture' in opts && opts.paletteTexture) {
      uniforms.categoryColor_paletteTexture = opts.paletteTexture;
    }
    return uniforms;
  },
};

const defaultProps: Required<CategoryColorExtensionProps> = {
  categoryPalette: [] as Color[],
  getCategoryIndex: { type: 'accessor', value: 0 } as any,
  useCategoryColor: true,
};

/**
 * Layer extension for GPU-based categorical color lookup
 *
 * Passes category indices as an attribute and performs palette lookup
 * in the fragment shader against a 256x1 RGBA palette texture.
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
        // Override the color in the fragment shader using a palette texture lookup.
        'fs:DECKGL_FILTER_COLOR': `
          if (categoryColor.useCategoryColor > 0.5 && categoryColor.paletteSize > 0.0) {
            float idx = clamp(vCategoryIndex, 0.0, categoryColor.paletteSize - 1.0);
            // Sample the centre of texel idx in a 256-wide texture.
            float u = (idx + 0.5) / ${MAX_PALETTE_SIZE}.0;
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

    // Create the 256x1 RGBA palette texture once. Contents are uploaded via
    // copyImageData here and re-uploaded in updateState when the palette prop
    // changes.
    const paletteTexture = context.device.createTexture({
      width: MAX_PALETTE_SIZE,
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
    // Re-upload the palette texture when the palette prop changes.
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
      useCategoryColor = true,
    } = this.props;

    const paletteSize = Math.min(categoryPalette.length, MAX_PALETTE_SIZE);

    this.setShaderModuleProps({
      categoryColor: {
        paletteSize,
        useCategoryColor: useCategoryColor ? 1.0 : 0.0,
        // Bind the palette texture to the sampler (mapped by getUniforms).
        paletteTexture: this.state.paletteTexture,
      },
    });
  }

  /**
   * Write the layer's current `categoryPalette` prop into the palette texture.
   * Called on init and whenever the palette prop changes.
   *
   * Public so the static-bound lifecycle methods (where `this` is the Layer)
   * can invoke it via the `extension` argument they receive.
   */
  uploadPalette(layer: Layer<CategoryColorExtensionProps>): void {
    const tex = layer.state.paletteTexture as Texture | undefined;
    if (!tex) return;

    const palette = layer.props.categoryPalette || [];
    const paletteSize = Math.min(palette.length, MAX_PALETTE_SIZE);

    const data = new Uint8Array(MAX_PALETTE_SIZE * 4);
    for (let i = 0; i < paletteSize; i++) {
      const color = palette[i];
      data[i * 4] = color[0] ?? 0;
      data[i * 4 + 1] = color[1] ?? 0;
      data[i * 4 + 2] = color[2] ?? 0;
      data[i * 4 + 3] = color[3] ?? 255;
    }

    // luma.gl 9.x: upload typed-array data into the texture.
    tex.copyImageData({ data });
  }
}

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
/**
 * Layer extension for GPU-based categorical color lookup
 *
 * Passes category indices as an attribute and performs palette lookup
 * in the fragment shader, avoiding O(n) CPU color expansion.
 */
export declare class CategoryColorExtension extends LayerExtension {
    static defaultProps: Required<CategoryColorExtensionProps<any>>;
    static extensionName: string;
    getShaders(this: Layer<CategoryColorExtensionProps>, _extension: CategoryColorExtension): {
        modules: {
            name: string;
            vs: string;
            fs: string;
            uniformTypes: {
                paletteSize: string;
                useCategoryColor: string;
            };
        }[];
        inject: {
            'vs:#decl': string;
            'vs:#main-end': string;
            'fs:#decl': string;
            'fs:DECKGL_FILTER_COLOR': string;
        };
    };
    initializeState(this: Layer<CategoryColorExtensionProps>, _context: LayerContext, _extension: CategoryColorExtension): void;
    updateState(this: Layer<CategoryColorExtensionProps>, _params: UpdateParameters<Layer<CategoryColorExtensionProps>>, _extension: CategoryColorExtension): void;
    draw(this: Layer<CategoryColorExtensionProps>, _params: unknown, _extension: CategoryColorExtension): void;
}
//# sourceMappingURL=category-color-extension.d.ts.map
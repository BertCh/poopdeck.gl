/**
 * AnimatedPointLayer - GPU-efficient point rendering with time filtering
 *
 * Uses deck.gl's binary data interface for maximum performance:
 * - Passes typed arrays directly to GPU (no accessor function calls)
 * - Time filtering happens entirely in the shader via TimeFilterExtension
 * - Sub-layer caching prevents buffer regeneration
 * - Layer props reused with same ID - deck.gl diffing preserves GPU state
 * - TimeFilterExtension.draw() updates time uniforms each frame (no clone overhead)
 *
 * Performance: Targets 120fps by eliminating layer.clone() allocations
 */
import type { Color, Layer } from '@deck.gl/core';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
export interface AnimatedPointLayerProps extends SpatioTemporalLayerProps {
    /** Radius scale multiplier */
    radiusScale?: number;
    /** Radius units ('pixels' | 'meters' | 'common') */
    radiusUnits?: 'pixels' | 'meters' | 'common';
    /** Fill color - constant value or property name for categorical coloring */
    fillColor?: Color | string;
    /** Radius - constant value or property name for radius */
    radius?: number | string;
    /** Color palette for categorical properties */
    colorPalette?: Color[];
    /**
     * Enable 3D positions (altitude/elevation support)
     * When true, positions will include altitude component
     */
    use3D?: boolean;
    /**
     * Property name to extract elevation from (e.g., 'altitude', 'elevation')
     * Used when positions don't have embedded altitude but it's available in properties
     * Only used when use3D is true
     */
    elevationProperty?: string;
    /**
     * Scale factor for elevation values (e.g., to convert feet to meters)
     * Only used when use3D is true
     */
    elevationScale?: number;
    /** Fade-in duration for appearing points (ms) */
    fadeInDuration?: number;
    /** Fade-out duration for disappearing points (ms) */
    fadeOutDuration?: number;
}
/**
 * Animated point layer using deck.gl binary interface
 *
 * Performance optimizations:
 * - Typed arrays passed directly to GPU (zero accessor calls)
 * - TimeFilterExtension handles temporal filtering in shaders
 * - Layer caching prevents unnecessary buffer recreation
 * - Only time-varying props are updated on animation frames
 * - Cached accessor functions and updateTriggers for stable references
 */
export declare class AnimatedPointLayer extends SpatioTemporalLayer<AnimatedPointLayerProps> {
    static layerName: string;
    private cachedUpdateTriggers;
    private lastFillColor;
    private lastRadius;
    private lastColorPalette;
    private cachedColorRadiusProps;
    private lastFillColorForProps;
    private lastRadiusForProps;
    static defaultProps: {
        radiusScale: {
            type: string;
            value: number;
            min: number;
        };
        radiusUnits: string;
        fillColor: {
            type: string;
            value: Color;
        };
        radius: {
            type: string;
            value: number;
        };
        colorPalette: {
            type: string;
            value: Color[];
        };
        use3D: boolean;
        elevationProperty: any;
        elevationScale: {
            type: string;
            value: number;
            min: number;
        };
        fadeInDuration: {
            type: string;
            value: number;
            min: number;
        };
        fadeOutDuration: {
            type: string;
            value: number;
            min: number;
        };
        data: {
            type: string;
            value: string;
            compare: boolean;
        };
        currentTime: {
            type: string;
            value: number;
            compare: boolean;
        };
        timeWindow: {
            type: string;
            value: number;
            compare: boolean;
        };
        timeRange: {
            type: string;
            value: any;
            compare: boolean;
        };
        timeController: {
            type: string;
            value: any;
            compare: boolean;
        };
        maxRequests: {
            type: string;
            value: number;
            compare: boolean;
        };
        debounceTime: {
            type: string;
            value: number;
            compare: boolean;
        };
        maxCacheSize: {
            type: string;
            value: number;
            compare: boolean;
        };
        maxCacheByteSize: {
            type: string;
            value: number;
            compare: boolean;
        };
        enablePrefetch: {
            type: string;
            value: boolean;
            compare: boolean;
        };
        prefetchAhead: {
            type: string;
            value: number;
            compare: boolean;
        };
        prefetchSteps: {
            type: string;
            value: number;
            compare: boolean;
        };
        onViewportLoad: {
            type: string;
            value: any;
            optional: boolean;
        };
        onTileLoad: {
            type: string;
            value: any;
            optional: boolean;
        };
        onTileUnload: {
            type: string;
            value: any;
            optional: boolean;
        };
        loadOptions: {
            type: string;
            value: {};
            compare: boolean;
        };
    };
    renderLayers(): Layer[];
    /**
     * Create a ScatterplotLayer for the given binary data.
     *
     * PERFORMANCE OPTIMIZATION:
     * - Caches the `data` object per BinaryFeatures + props combo so deck.gl recognizes
     *   unchanged data and skips GPU buffer re-uploads
     * - Creates new layer instances with updated time props each frame
     *   (this is lightweight - deck.gl efficiently diffs and updates uniforms)
     * - NO MUTATION: data objects are built complete upfront, never mutated after caching
     */
    private createLayer;
    /**
     * Get or create a complete data object for the given binary features.
     *
     * The cache key includes the property names used for color/radius so that
     * when props change, we create a new data object rather than mutating.
     */
    private getOrCreateDataObject;
    /**
     * Build the complete binary data object for deck.gl.
     * Includes all attributes based on current props - no mutation after creation.
     */
    private buildDataObject;
    /**
     * Get color and radius props for constant values only.
     * Property-based values are handled in buildDataObject as attributes.
     *
     * PERFORMANCE OPTIMIZATION:
     * Returns a cached object when props haven't changed. This ensures deck.gl
     * sees stable references and can skip expensive deep comparisons.
     */
    private getColorAndRadiusProps;
    /**
     * Get radius attribute from numeric property if specified
     */
    private getRadiusAttribute;
    /**
     * Get fill color attribute from categorical property if specified.
     * Cached per BinaryFeatures + property + palette combination.
     */
    private getFillColorAttribute;
}
//# sourceMappingURL=animated-point-layer.d.ts.map
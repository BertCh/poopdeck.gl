/**
 * AnimatedPointLayer - GPU-efficient point rendering with time filtering
 *
 * PERFORMANCE OPTIMIZED (v2 - Consolidated Rendering):
 * - Consolidates ALL tiles into a SINGLE ScatterplotLayer (1 draw call instead of N)
 * - Uses deck.gl's binary data interface for maximum performance
 * - Time filtering happens entirely in the shader via TimeFilterExtension
 * - Consolidated data cached per tile set - only rebuilt when tiles change
 * - Layer instance memoized to avoid recreation on time-only updates
 *
 * Performance: Targets 200fps by eliminating per-tile layer overhead
 */
import type { Color, Layer, LayerContext } from '@deck.gl/core';
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
 * Performance optimizations (v2):
 * - SINGLE draw call: All tiles consolidated into one ScatterplotLayer
 * - Typed arrays passed directly to GPU (zero accessor calls)
 * - TimeFilterExtension handles temporal filtering in shaders
 * - Consolidated data cached - only rebuilt when tiles change (frameNumber)
 * - Layer instance memoized for time-only updates
 */
export declare class AnimatedPointLayer extends SpatioTemporalLayer<AnimatedPointLayerProps> {
    static layerName: string;
    private consolidatedDataCache;
    private cachedLayer;
    private cachedLayerFrameNumber;
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
        elevationProperty: null;
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
            value: null;
            compare: boolean;
        };
        timeController: {
            type: string;
            value: null;
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
            value: null;
            optional: boolean;
        };
        onTileLoad: {
            type: string;
            value: null;
            optional: boolean;
        };
        onTileUnload: {
            type: string;
            value: null;
            optional: boolean;
        };
        loadOptions: {
            type: string;
            value: {};
            compare: boolean;
        };
    };
    finalizeState(context: LayerContext): void;
    /**
     * PERFORMANCE OPTIMIZED renderLayers:
     * - Creates a SINGLE ScatterplotLayer for ALL tiles (1 draw call)
     * - Caches consolidated data - only rebuilds when tiles change
     * - TRULY MEMOIZES layer instance - returns SAME layer for time-only updates
     * - Time updates happen via getTime() getter in TimeFilterExtension.draw()
     */
    renderLayers(): Layer[];
    /**
     * Get or create consolidated data from all tiles.
     * Cached by frameNumber - only rebuilds when tiles actually change.
     */
    private getConsolidatedData;
    /**
     * Build consolidated data by merging all tile binary data.
     * Converts relative times to absolute times during consolidation.
     */
    private buildConsolidatedData;
    /**
     * Create a single ScatterplotLayer with consolidated data.
     *
     * PERFORMANCE: Uses getTime() getter instead of currentTime prop.
     * This allows the layer to be memoized - time updates happen in
     * TimeFilterExtension.draw() via the getter, not via layer recreation.
     */
    private createConsolidatedLayer;
    /**
     * Get color and radius props for constant values only.
     * Property-based values are handled in buildConsolidatedData as attributes.
     *
     * PERFORMANCE OPTIMIZATION:
     * Returns a cached object when props haven't changed. This ensures deck.gl
     * sees stable references and can skip expensive deep comparisons.
     */
    private getColorAndRadiusProps;
}
//# sourceMappingURL=animated-point-layer.d.ts.map
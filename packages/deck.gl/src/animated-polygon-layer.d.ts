/**
 * AnimatedPolygonLayer - GPU-efficient polygon rendering with time filtering
 *
 * Uses deck.gl's binary data interface for maximum performance:
 * - Passes typed arrays directly to GPU where possible
 * - Time filtering done in JavaScript (SolidPolygonLayer doesn't support TimeFilterExtension)
 * - Uses startIndices for variable-length polygon geometries
 *
 * PERFORMANCE OPTIMIZED:
 * - Caches extracted geometry per tile/visible set combination
 * - Reuses arrays between frames when visible set unchanged
 * - Color attributes cached per tile
 * - Layer instances are cached and reused when possible
 */
import type { Color, Layer, LayerContext } from '@deck.gl/core';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
export interface AnimatedPolygonLayerProps extends SpatioTemporalLayerProps {
    /** Whether to draw an outline around each polygon */
    stroked?: boolean;
    /** Whether to fill the polygon */
    filled?: boolean;
    /** Line width in pixels (if stroked) */
    lineWidthUnits?: 'pixels' | 'meters' | 'common';
    /** Line width */
    lineWidth?: number | string;
    /** Line color - constant value or property name */
    lineColor?: Color | string;
    /** Fill color - constant value or property name */
    fillColor?: Color | string;
    /** Color palette for categorical properties */
    colorPalette?: Color[];
    /** Elevation - constant value or property name (for extruded polygons) */
    elevation?: number | string;
    /** Whether polygons are extruded */
    extruded?: boolean;
    /** Fade-in duration for appearing polygons (ms) */
    fadeInDuration?: number;
    /** Fade-out duration for disappearing polygons (ms) */
    fadeOutDuration?: number;
}
/**
 * Animated polygon layer using deck.gl binary interface
 *
 * Performance optimizations:
 * - Caches extracted geometry per tile when visible set is stable
 * - Reuses typed arrays between frames
 * - Color attributes cached per tile+palette combination
 * - Layer instances cached and reused when visible set unchanged
 */
export declare class AnimatedPolygonLayer extends SpatioTemporalLayer<AnimatedPolygonLayerProps> {
    static layerName: string;
    private layerCache;
    private activeLayerIds;
    static defaultProps: {
        stroked: boolean;
        filled: boolean;
        lineWidthUnits: "pixels";
        lineWidth: {
            type: string;
            value: number;
        };
        lineColor: {
            type: string;
            value: Color;
        };
        fillColor: {
            type: string;
            value: Color;
        };
        colorPalette: {
            type: string;
            value: Color[];
        };
        elevation: {
            type: string;
            value: number;
        };
        extruded: boolean;
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
    finalizeState(context: LayerContext): void;
    renderLayers(): Layer[];
    /**
     * Get a cached layer or create a new one.
     */
    private getOrCreateLayer;
    /**
     * Remove cached layers that are no longer active
     */
    private cleanupCache;
    /**
     * Get indices of features visible in the current time window.
     * Returns both the indices and a hash for cache invalidation.
     */
    private getVisibleFeatureIndices;
    /**
     * Create a SolidPolygonLayer for visible features using binary data.
     * Uses cached geometry when the visible set hasn't changed.
     */
    private createBinaryPolygonLayer;
    /**
     * Extract positions for visible polygons only
     */
    private extractVisiblePolygons;
    /**
     * Get fill color attribute for visible features.
     * Cached per tile + property + palette + visible set combination.
     */
    private getFillColorAttribute;
}
//# sourceMappingURL=animated-polygon-layer.d.ts.map
/**
 * AnimatedTripsLayer - GPU-efficient animated trips/trajectories
 *
 * Provides a "vehicle moving along route" effect where paths are progressively
 * drawn with a trailing fade effect.
 *
 * PERFORMANCE OPTIMIZED:
 * - Uses PathLayer with binary data interface (no per-frame JS object creation)
 * - Trail rendering done entirely in GPU via TimeFilterExtension
 * - Per-vertex progress computed once and cached per tile
 * - Layer instances are cached and cloned to avoid recreation overhead
 */
import type { Color, Layer, LayerContext } from '@deck.gl/core';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
export interface AnimatedTripsLayerProps extends SpatioTemporalLayerProps {
    /** Width scale multiplier */
    widthScale?: number;
    /** Minimum width in pixels */
    widthMinPixels?: number;
    /** Maximum width in pixels */
    widthMaxPixels?: number;
    /** Trip color - constant value or property name */
    tripColor?: Color | string;
    /** Trip width - constant value or property name */
    tripWidth?: number | string;
    /** Color palette for categorical properties */
    colorPalette?: Color[];
    /** Trail length in time units (milliseconds) */
    trailLength?: number;
    /** Whether the trail fades out (always true for this implementation) */
    fadeTrail?: boolean;
    /** Round caps on path ends */
    capRounded?: boolean;
    /** Round joints between path segments */
    jointRounded?: boolean;
}
/**
 * Animated trips layer for trajectory data with progressive drawing
 *
 * Performance optimizations:
 * - Uses PathLayer with deck.gl binary data interface (zero accessor calls)
 * - TimeFilterExtension handles trail rendering entirely in GPU shaders
 * - Per-vertex progress computed once and cached per tile (not per frame)
 * - Layer caching prevents unnecessary buffer recreation
 */
export declare class AnimatedTripsLayer extends SpatioTemporalLayer<AnimatedTripsLayerProps> {
    static layerName: string;
    private layerCache;
    private activeLayerIds;
    static defaultProps: {
        widthScale: {
            type: string;
            value: number;
            min: number;
        };
        widthMinPixels: {
            type: string;
            value: number;
        };
        widthMaxPixels: {
            type: string;
            value: number;
        };
        tripColor: {
            type: string;
            value: Color;
        };
        tripWidth: {
            type: string;
            value: number;
        };
        colorPalette: {
            type: string;
            value: Color[];
        };
        trailLength: {
            type: string;
            value: number;
            min: number;
        };
        fadeTrail: boolean;
        capRounded: boolean;
        jointRounded: boolean;
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
    renderLayers(): Layer[];
    /**
     * Get a cached layer or create a new one.
     * PERFORMANCE: Uses getTime() getter so layers can be memoized.
     */
    private getOrCreateLayer;
    /**
     * Remove cached layers that are no longer active
     */
    private cleanupCache;
    /**
     * Create a PathLayer using deck.gl's binary data interface with trail support.
     * PERFORMANCE: Uses getTime() getter for dynamic time updates.
     */
    private createBinaryPathLayer;
    /**
     * Get or compute per-vertex progress (0-1) for each vertex along its path.
     * Cached per BinaryFeatures instance to avoid recomputation.
     */
    private getVertexProgress;
    /**
     * Expand per-feature start/end times to per-vertex arrays.
     * This is needed because PathLayer processes vertices, not instances.
     * Cached per BinaryFeatures instance to avoid recomputation.
     */
    private expandTimesToVertices;
    /**
     * Get width attribute from numeric property if specified
     */
    private getWidthAttribute;
    /**
     * Get color attribute from categorical property if specified.
     * Cached per BinaryFeatures + property + palette combination.
     */
    private getColorAttribute;
}
//# sourceMappingURL=animated-trips-layer.d.ts.map
/**
 * HeatmapTimeLayer - Temporal heatmap visualization
 *
 * Aggregates point data into a density heatmap that animates over time.
 * Uses GPU acceleration for real-time aggregation.
 *
 * PERFORMANCE OPTIMIZED:
 * - Caches extracted points per tile to avoid re-extraction
 * - Only recomputes visible points when tile set changes
 * - Uses typed arrays for position/weight data
 * - Layer instance cached and reused when point count stable
 */
import type { Color, Layer, LayerContext } from '@deck.gl/core';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
export interface HeatmapTimeLayerProps extends SpatioTemporalLayerProps {
    /** Radius of influence in pixels */
    radiusPixels?: number;
    /** Intensity multiplier for each point */
    intensity?: number;
    /** Aggregation method for overlapping points */
    aggregation?: 'SUM' | 'MEAN';
    /** Color range from low to high density */
    colorRange?: Color[];
    /** Property name for weight values (if using a numeric property) */
    weightProperty?: string;
}
/**
 * Temporal heatmap layer
 *
 * Performance optimizations:
 * - Caches all points per tile (extracted once on tile load)
 * - Only time-filtering loop runs per frame (no object creation)
 * - Uses flat typed arrays for minimal memory churn
 * - Caches layer instance for reuse
 */
export declare class HeatmapTimeLayer extends SpatioTemporalLayer<HeatmapTimeLayerProps> {
    static layerName: string;
    static defaultProps: {
        radiusPixels: {
            type: string;
            value: number;
            min: number;
        };
        intensity: {
            type: string;
            value: number;
            min: number;
        };
        aggregation: string;
        colorRange: {
            type: string;
            value: Color[];
            compare: boolean;
        };
        weightProperty: null;
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
    private visiblePositions;
    private visibleWeights;
    private cachedLayer;
    private cachedVisibleCount;
    finalizeState(context: LayerContext): void;
    renderLayers(): Layer[];
    /**
     * Filter visible points from all tiles based on time window.
     * Uses cached tile point data and reuses output arrays.
     * Returns the number of visible points.
     */
    private filterVisiblePoints;
    /**
     * Get or create cached point data for a tile layer.
     * Extracts positions, weights, and times once per tile.
     */
    private getCachedTilePoints;
}
//# sourceMappingURL=heatmap-time-layer.d.ts.map
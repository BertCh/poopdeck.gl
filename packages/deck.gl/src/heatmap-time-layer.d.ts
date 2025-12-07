/**
 * Layer for temporal heatmap visualization
 */
import type { Accessor, Color, Layer, Position } from '@deck.gl/core';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
import type { Feature } from '@stt/core';
export interface HeatmapTimeLayerProps extends SpatioTemporalLayerProps {
    /** Radius of influence in pixels */
    radiusPixels?: number;
    /** Intensity multiplier for each point */
    intensity?: number;
    /** Aggregation method for overlapping points */
    aggregation?: 'SUM' | 'MEAN';
    /** Color range from low to high density */
    colorRange?: Color[];
    /** Weight accessor for each data point */
    getWeight?: Accessor<Feature, number>;
    /** Position accessor - returns [lon, lat] */
    getPosition?: Accessor<Feature, Position>;
}
/**
 * Temporal heatmap layer
 *
 * Aggregates point data into a density heatmap that animates over time.
 * Uses GPU acceleration for real-time aggregation.
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
        getWeight: {
            type: string;
            value: number;
        };
        getPosition: {
            type: string;
            value: null;
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
    renderLayers(): Layer[];
    private isFeatureVisible;
}
//# sourceMappingURL=heatmap-time-layer.d.ts.map
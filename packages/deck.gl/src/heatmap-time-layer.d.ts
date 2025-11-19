/**
 * Layer for temporal heatmap visualization
 */
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
import type { Feature } from '@stt/core';
export interface HeatmapTimeLayerProps extends SpatioTemporalLayerProps {
    /** Radius of influence in pixels */
    radiusPixels?: number;
    /** Intensity of each point */
    intensity?: number;
    /** Aggregation method ('SUM' | 'MEAN') */
    aggregation?: 'SUM' | 'MEAN';
    /** Color range (low to high) */
    colorRange?: [number, number, number, number][];
    /** Get weight for each point */
    getWeight?: (feature: Feature) => number;
    /** Get position [lon, lat] */
    getPosition?: (feature: Feature) => [number, number];
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
            compare: boolean;
        };
        intensity: {
            type: string;
            value: number;
            compare: boolean;
        };
        aggregation: {
            type: string;
            value: string;
            compare: boolean;
        };
        colorRange: {
            type: string;
            value: number[][];
            compare: boolean;
        };
        getWeight: {
            type: string;
            value: number;
        };
        getPosition: {
            type: string;
            value: (_f: Feature) => number[];
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
        opacity: {
            type: string;
            value: number;
            compare: boolean;
        };
        visible: {
            type: string;
            value: boolean;
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
        prefetchTimeSteps: {
            type: string;
            value: number;
            compare: boolean;
        };
        prefetchTimeIncrement: {
            type: string;
            value: number;
            compare: boolean;
        };
        onViewportLoad: {
            type: string;
            value: null;
            compare: boolean;
        };
        onTileLoad: {
            type: string;
            value: null;
            compare: boolean;
        };
        onTileUnload: {
            type: string;
            value: null;
            compare: boolean;
        };
    };
    renderLayers(): any[];
    private isFeatureVisible;
}
//# sourceMappingURL=heatmap-time-layer.d.ts.map
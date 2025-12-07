/**
 * Layer for animating point data over time
 */
import type { Accessor, Color, Layer } from '@deck.gl/core';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
import type { Feature } from '@stt/core';
export interface AnimatedPointLayerProps extends SpatioTemporalLayerProps {
    /** Radius scale multiplier */
    radiusScale?: number;
    /** Radius units ('pixels' | 'meters' | 'common') */
    radiusUnits?: 'pixels' | 'meters' | 'common';
    /** Fill color accessor - returns [r, g, b, a] */
    getFillColor?: Accessor<Feature, Color>;
    /** Radius accessor */
    getRadius?: Accessor<Feature, number>;
    /** Position accessor - returns [lon, lat] */
    getPosition?: Accessor<Feature, [number, number]>;
    /** Fade-in duration for appearing points (ms) */
    fadeInDuration?: number;
    /** Fade-out duration for disappearing points (ms) */
    fadeOutDuration?: number;
}
/**
 * Animated point layer for time-series point data
 *
 * Features:
 * - Smooth fade-in/out for appearing/disappearing points
 * - Optional interpolation between time frames
 * - GPU-accelerated rendering via TimeFilterExtension
 * - Automatic filtering by time window
 */
export declare class AnimatedPointLayer extends SpatioTemporalLayer<AnimatedPointLayerProps> {
    static layerName: string;
    static defaultProps: {
        radiusScale: {
            type: string;
            value: number;
            min: number;
        };
        radiusUnits: string;
        getFillColor: {
            type: string;
            value: Color;
        };
        getRadius: {
            type: string;
            value: number;
        };
        getPosition: {
            type: string;
            value: null;
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
}
//# sourceMappingURL=animated-point-layer.d.ts.map
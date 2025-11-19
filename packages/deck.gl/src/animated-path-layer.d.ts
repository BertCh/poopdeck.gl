/**
 * Layer for animating path/trajectory data over time
 */
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
import type { Feature } from '@stt/core';
export interface AnimatedPathLayerProps extends SpatioTemporalLayerProps {
    /** Width of paths in pixels */
    widthScale?: number;
    /** Width units ('pixels' | 'meters') */
    widthUnits?: 'pixels' | 'meters';
    /** Get path color [r, g, b, a] */
    getColor?: (feature: Feature) => [number, number, number, number];
    /** Get path width */
    getWidth?: (feature: Feature) => number;
    /** Get path coordinates [[lon, lat], ...] */
    getPath?: (feature: Feature) => number[][];
    /** Show trailing effect (gradient fade) */
    trail?: boolean;
    /** Trail length in milliseconds */
    trailLength?: number;
}
/**
 * Animated path layer for trajectory data
 *
 * Features:
 * - Smooth path rendering over time
 * - Optional trailing effect (shows path history)
 * - Interpolation between time frames
 * - Efficient rendering with GPU instancing
 */
export declare class AnimatedPathLayer extends SpatioTemporalLayer<AnimatedPathLayerProps> {
    static layerName: string;
    static defaultProps: {
        widthScale: {
            type: string;
            value: number;
            compare: boolean;
        };
        widthUnits: {
            type: string;
            value: string;
            compare: boolean;
        };
        getColor: {
            type: string;
            value: number[];
        };
        getWidth: {
            type: string;
            value: number;
        };
        getPath: {
            type: string;
            value: (_f: Feature) => never[];
        };
        trail: {
            type: string;
            value: boolean;
            compare: boolean;
        };
        trailLength: {
            type: string;
            value: number;
            compare: boolean;
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
//# sourceMappingURL=animated-path-layer.d.ts.map
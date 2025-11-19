/**
 * Layer for animating point data over time
 */
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
import type { Feature } from '@stt/core';
export interface AnimatedPointLayerProps extends SpatioTemporalLayerProps {
    /** Radius of points in pixels */
    radiusScale?: number;
    /** Radius units ('pixels' | 'meters') */
    radiusUnits?: 'pixels' | 'meters';
    /** Get fill color [r, g, b, a] */
    getFillColor?: (feature: Feature) => [number, number, number, number];
    /** Get radius */
    getRadius?: (feature: Feature) => number;
    /** Get position [lon, lat] */
    getPosition?: (feature: Feature) => [number, number];
    /** Fade-in duration for new points (ms) */
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
 * - GPU-accelerated rendering
 * - Automatic filtering by time window
 */
export declare class AnimatedPointLayer extends SpatioTemporalLayer<AnimatedPointLayerProps> {
    static layerName: string;
    static defaultProps: {
        radiusScale: {
            type: string;
            value: number;
            compare: boolean;
        };
        radiusUnits: {
            type: string;
            value: string;
            compare: boolean;
        };
        getFillColor: {
            type: string;
            value: number[];
        };
        getRadius: {
            type: string;
            value: number;
        };
        fadeInDuration: {
            type: string;
            value: number;
            compare: boolean;
        };
        fadeOutDuration: {
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
    /**
     * Extract position from feature geometry
     *
     * Coordinates are stored as ABSOLUTE values within the tile extent (0-4096),
     * NOT delta-encoded. See Rust tiler: crates/stt-build/src/tiler.rs line 555
     * and crates/stt-build/src/main.rs line 165 (use_delta_encoding: false)
     *
     * Format: [command, x, y] where:
     * - command = 9 (MoveTo with count 1)
     * - x, y = absolute tile coordinates (0 to extent)
     */
    private extractPositionWithDelta;
}
//# sourceMappingURL=animated-point-layer.d.ts.map
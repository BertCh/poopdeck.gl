/**
 * Layer for animating path/trajectory data over time
 */
import type { Accessor, Color, Layer, Position } from '@deck.gl/core';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
import type { Feature } from '@stt/core';
export interface AnimatedPathLayerProps extends SpatioTemporalLayerProps {
    /** Width scale multiplier */
    widthScale?: number;
    /** Width units ('pixels' | 'meters') */
    widthUnits?: 'pixels' | 'meters';
    /** Path color accessor - returns [r, g, b, a] */
    getColor?: Accessor<Feature, Color>;
    /** Path width accessor */
    getWidth?: Accessor<Feature, number>;
    /** Path coordinates accessor - returns [[lon, lat], ...] */
    getPath?: Accessor<Feature, Position[]>;
    /** Enable trailing effect (gradient fade) */
    trail?: boolean;
    /** Trail length in milliseconds */
    trailLength?: number;
    /** Fade-in duration for appearing paths (ms) */
    fadeInDuration?: number;
    /** Fade-out duration for disappearing paths (ms) */
    fadeOutDuration?: number;
}
/**
 * Animated path layer for trajectory data
 *
 * Features:
 * - Smooth path rendering over time
 * - Optional trailing effect (shows path history)
 * - GPU-accelerated time filtering via TimeFilterExtension
 * - Efficient rendering with GPU instancing
 */
export declare class AnimatedPathLayer extends SpatioTemporalLayer<AnimatedPathLayerProps> {
    static layerName: string;
    static defaultProps: {
        widthScale: {
            type: string;
            value: number;
            min: number;
        };
        widthUnits: string;
        getColor: {
            type: string;
            value: Color;
        };
        getWidth: {
            type: string;
            value: number;
        };
        getPath: {
            type: string;
            value: null;
        };
        trail: boolean;
        trailLength: {
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
//# sourceMappingURL=animated-path-layer.d.ts.map
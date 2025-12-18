/**
 * AnimatedPathLayer - GPU-efficient path/trajectory rendering with time filtering
 *
 * Uses deck.gl's binary data interface for maximum performance:
 * - Passes typed arrays directly to GPU (no accessor function calls)
 * - Uses startIndices for variable-length paths
 * - Time filtering happens entirely in the shader via TimeFilterExtension
 * - Layer instances are cached and cloned to avoid recreation overhead
 */
import type { Color, Layer, LayerContext } from '@deck.gl/core';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
export interface AnimatedPathLayerProps extends SpatioTemporalLayerProps {
    /** Width scale multiplier */
    widthScale?: number;
    /** Width units ('pixels' | 'meters') */
    widthUnits?: 'pixels' | 'meters';
    /** Path color - constant value or property name for categorical coloring */
    pathColor?: Color | string;
    /** Path width - constant value or property name */
    pathWidth?: number | string;
    /** Color palette for categorical properties */
    colorPalette?: Color[];
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
 * Animated path layer using deck.gl binary interface
 *
 * Performance optimizations:
 * - Typed arrays passed directly to GPU (zero accessor calls)
 * - Uses startIndices for variable-length path geometries
 * - TimeFilterExtension handles temporal filtering in shaders
 * - Layer caching prevents unnecessary buffer recreation
 */
export declare class AnimatedPathLayer extends SpatioTemporalLayer<AnimatedPathLayerProps> {
    static layerName: string;
    private layerCache;
    private activeLayerIds;
    static defaultProps: {
        widthScale: {
            type: string;
            value: number;
            min: number;
        };
        widthUnits: string;
        pathColor: {
            type: string;
            value: Color;
        };
        pathWidth: {
            type: string;
            value: number;
        };
        colorPalette: {
            type: string;
            value: Color[];
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
     * Create a PathLayer using deck.gl's binary data interface
     */
    private createBinaryPathLayer;
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
//# sourceMappingURL=animated-path-layer.d.ts.map
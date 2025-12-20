import { LayerExtension } from '@deck.gl/core';
import type { Layer, LayerContext, Accessor, UpdateParameters } from '@deck.gl/core';
/**
 * Props for layers using TimeFilterExtension
 */
export type TimeFilterExtensionProps<DataT = any> = {
    /** Current time for filtering (Unix milliseconds) */
    currentTime?: number;
    /**
     * PERFORMANCE OPTIMIZATION: Time getter function for dynamic time updates.
     * When provided, this is called in draw() to get the current time.
     * This allows the layer to be cached and reused - only uniforms are updated each frame.
     * Takes priority over currentTime prop.
     */
    getTime?: () => number;
    /** Time window size in milliseconds */
    timeWindow?: number;
    /** Fade-in duration for appearing objects (ms) */
    fadeInDuration?: number;
    /** Fade-out duration for disappearing objects (ms) */
    fadeOutDuration?: number;
    /**
     * Trail length in milliseconds (for path/trips effect).
     * When set > 0, enables progressive drawing with trailing fade.
     * The path is drawn from (currentTime - trailLength) to currentTime.
     */
    trailLength?: number;
    /** Accessor to get start time from each data object */
    getInstanceStartTime?: Accessor<DataT, number>;
    /** Accessor to get end time from each data object */
    getInstanceEndTime?: Accessor<DataT, number>;
};
/**
 * Layer extension for GPU-based temporal filtering
 *
 * Filters and fades objects based on their time range relative to the current time.
 * Works with any layer that has temporal data.
 *
 * Supports two modes:
 * 1. Window mode (trailLength = 0): Show features whose time range overlaps with time window
 * 2. Trail mode (trailLength > 0): Progressive drawing with trailing fade for paths/trajectories
 *    - For trail mode, optionally provide instanceVertexProgress (0-1) for per-vertex time interpolation
 */
export declare class TimeFilterExtension extends LayerExtension {
    static defaultProps: Required<TimeFilterExtensionProps<any>>;
    static extensionName: string;
    getShaders(this: Layer<TimeFilterExtensionProps>, _extension: TimeFilterExtension): {
        modules: {
            name: string;
            vs: string;
            fs: string;
            uniformTypes: {
                currentTime: string;
                windowHalf: string;
                fadeIn: string;
                fadeOut: string;
                trailLength: string;
            };
        }[];
        inject: {
            'vs:#decl': string;
            'vs:#main-start': string;
            'fs:#decl': string;
            'fs:#main-start': string;
            'fs:DECKGL_FILTER_COLOR': string;
        };
    };
    initializeState(this: Layer<TimeFilterExtensionProps>, _context: LayerContext, _extension: TimeFilterExtension): void;
    updateState(this: Layer<TimeFilterExtensionProps>, _params: UpdateParameters<Layer<TimeFilterExtensionProps>>, _extension: TimeFilterExtension): void;
    draw(this: Layer<TimeFilterExtensionProps>, _params: unknown, _extension: TimeFilterExtension): void;
}
//# sourceMappingURL=time-filter-extension.d.ts.map
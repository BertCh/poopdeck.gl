import { LayerExtension } from '@deck.gl/core';
import type { Layer, LayerContext, Accessor, UpdateParameters } from '@deck.gl/core';
/**
 * Props for layers using TimeFilterExtension
 */
export type TimeFilterExtensionProps<DataT = any> = {
    /** Current time for filtering (Unix milliseconds) */
    currentTime?: number;
    /** Time window size in milliseconds */
    timeWindow?: number;
    /** Fade-in duration for appearing objects (ms) */
    fadeInDuration?: number;
    /** Fade-out duration for disappearing objects (ms) */
    fadeOutDuration?: number;
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
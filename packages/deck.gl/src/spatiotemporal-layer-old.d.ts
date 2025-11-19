/**
 * Base layer for spatiotemporal tile visualization
 */
import { CompositeLayer } from '@deck.gl/core';
import { STTArchive } from '@stt/core';
import type { Tile } from '@stt/core';
import { TimeController } from './time-controller';
export interface SpatioTemporalLayerProps {
    /** URL to STT archive */
    data: string;
    /** Current time to display (Unix milliseconds) */
    currentTime: number;
    /** Time window (milliseconds before and after currentTime) */
    timeWindow?: number;
    /** Time controller (optional, for synchronized animation) */
    timeController?: TimeController;
    /** Opacity */
    opacity?: number;
    /** Visible flag */
    visible?: boolean;
    /** Interpolation enabled */
    interpolation?: boolean;
    /** Tile cache size in bytes */
    cacheSize?: number;
}
interface SpatioTemporalLayerState {
    archive: STTArchive | null;
    tiles: Tile[];
    currentTime: number;
}
/**
 * Base layer for spatiotemporal tile visualization
 *
 * This is an abstract base class that handles:
 * - Loading tiles from STT archive
 * - Filtering features by time
 * - Managing tile cache
 * - Time-based animation
 *
 * Subclasses implement specific visualization types (points, paths, heatmaps, etc.)
 */
export declare class SpatioTemporalLayer<Props extends SpatioTemporalLayerProps = SpatioTemporalLayerProps> extends CompositeLayer<Props> {
    static layerName: string;
    static defaultProps: {
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
        interpolation: {
            type: string;
            value: boolean;
            compare: boolean;
        };
        cacheSize: {
            type: string;
            value: number;
            compare: boolean;
        };
    };
    state: SpatioTemporalLayerState & {
        [key: string]: any;
    };
    initializeState(): void;
    finalizeState(): void;
    updateState({ changeFlags }: any): void;
    private initArchive;
    private loadTilesForTime;
    private prefetchNearbyTiles;
    private getViewportBounds;
    private getZoomLevel;
    private onTimeUpdate;
    /**
     * Subclasses override this to render actual visualization layers
     */
    renderLayers(): any[];
}
export {};
//# sourceMappingURL=spatiotemporal-layer-old.d.ts.map
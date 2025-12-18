/**
 * Refactored SpatioTemporalLayer using Tileset pattern
 *
 * Based on deck.gl TileLayer architecture with loaders.gl integration
 */
import { CompositeLayer } from '@deck.gl/core';
import type { CompositeLayerProps, UpdateParameters, LayerContext } from '@deck.gl/core';
import { STTArchive } from '@stt/core';
import { SpatiotemporalTileset } from '@stt/core';
import type { Tile, ArchiveMetadata } from '@stt/core';
import { TimeController } from './time-controller';
export interface SpatioTemporalLayerProps extends CompositeLayerProps {
    /** URL to STT archive */
    data: string;
    /** Current time to display (Unix milliseconds) */
    currentTime: number;
    /** Time window (milliseconds before and after currentTime) */
    timeWindow?: number;
    /** Full time range of the dataset */
    timeRange?: {
        start: number;
        end: number;
    };
    /** Time controller (optional, for synchronized animation) */
    timeController?: TimeController;
    /** Maximum concurrent tile requests (deck.gl TileLayer pattern) */
    maxRequests?: number;
    /** Debounce time for viewport changes in ms (deck.gl TileLayer pattern) */
    debounceTime?: number;
    /** Maximum number of tiles to cache */
    maxCacheSize?: number;
    /** Maximum cache size in bytes */
    maxCacheByteSize?: number;
    /** Enable predictive prefetching for smooth animation */
    enablePrefetch?: boolean;
    /** How far ahead to prefetch in animation time (milliseconds) */
    prefetchAhead?: number;
    /** Number of time steps to prefetch ahead */
    prefetchSteps?: number;
    /** Callback when all tiles in viewport are loaded */
    onViewportLoad?: (tiles: Tile[]) => void;
    /** Callback when a tile loads */
    onTileLoad?: (tile: Tile) => void;
    /** Callback when a tile is evicted from cache */
    onTileUnload?: (tile: Tile) => void;
    /** Loaders.gl options */
    loadOptions?: Record<string, unknown>;
}
interface SpatioTemporalLayerState {
    archive: STTArchive | null;
    tileset: SpatiotemporalTileset | null;
    metadata: ArchiveMetadata | null;
    tiles: Tile[];
    currentTime: number;
    isLoaded: boolean;
    frameNumber?: number;
    playStateHandler?: (playing: boolean, speed: number) => void;
    tickHandler?: (time: number) => void;
}
/**
 * Base layer for spatiotemporal tile visualization
 *
 * Architecture based on deck.gl TileLayer + loaders.gl:
 * - Separates tile management (Tileset) from data loading (Archive)
 * - Request concurrency control (maxRequests: 24)
 * - Debouncing for smooth viewport changes
 * - LRU cache with size limits
 * - Frame-based rendering optimization
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
    state: SpatioTemporalLayerState & {
        [key: string]: unknown;
    };
    initializeState(_context: LayerContext): void;
    finalizeState(_context: LayerContext): void;
    /**
     * deck.gl layer lifecycle: decide if layer needs to update
     * Following deck.gl TileLayer pattern - return true for any change including viewport
     */
    shouldUpdateState(params: {
        changeFlags: any;
    }): boolean;
    updateState(params: UpdateParameters<this>): void;
    /**
     * Handle time updates from TimeController tick events
     *
     * PERFORMANCE OPTIMIZED:
     * - Only updates currentTime without full tile re-evaluation
     * - Tiles are updated less frequently via a throttled tileset update
     * - Layer caching in subclasses ensures GPU state is preserved
     */
    private _handleTimeUpdate;
    /**
     * Check if the tiles array has actually changed (not just reference)
     */
    private _tilesChanged;
    private _updateTileset;
    private _initArchiveAndTileset;
    private getViewportBounds;
    private getZoomLevel;
    /**
     * Check if layer is fully loaded
     */
    get isLoaded(): boolean;
    /**
     * Subclasses override this to render actual visualization layers
     */
    renderLayers(): any[];
}
export {};
//# sourceMappingURL=spatiotemporal-layer.d.ts.map
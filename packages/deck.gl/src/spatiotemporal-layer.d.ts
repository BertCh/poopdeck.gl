/**
 * Refactored SpatioTemporalLayer using Tileset pattern
 *
 * Based on deck.gl TileLayer architecture with loaders.gl integration
 */
import { CompositeLayer } from '@deck.gl/core';
import { STTArchive } from '@stt/core';
import { SpatiotemporalTileset } from '@stt/core';
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
    /** Maximum concurrent tile requests (deck.gl TileLayer pattern) */
    maxRequests?: number;
    /** Debounce time for viewport changes in ms (deck.gl TileLayer pattern) */
    debounceTime?: number;
    /** Maximum number of tiles to cache */
    maxCacheSize?: number;
    /** Maximum cache size in bytes */
    maxCacheByteSize?: number;
    /** Enable predictive prefetching for animations */
    enablePrefetch?: boolean;
    /** Number of time steps to prefetch ahead */
    prefetchTimeSteps?: number;
    /** Time increment for each prefetch step (milliseconds) */
    prefetchTimeIncrement?: number;
    /** Callback when all tiles in viewport are loaded */
    onViewportLoad?: (tiles: Tile[]) => void;
    /** Callback when a tile loads */
    onTileLoad?: (tile: Tile) => void;
    /** Callback when a tile is evicted from cache */
    onTileUnload?: (tile: Tile) => void;
}
interface SpatioTemporalLayerState {
    archive: STTArchive | null;
    tileset: SpatiotemporalTileset | null;
    tiles: Tile[];
    currentTime: number;
    isLoaded: boolean;
    frameNumber?: number;
}
/**
 * Base layer for spatiotemporal tile visualization
 *
 * Architecture based on deck.gl TileLayer + loaders.gl:
 * - Separates tile management (Tileset) from data loading (Archive)
 * - Request concurrency control (maxRequests: 6)
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
    state: SpatioTemporalLayerState & {
        [key: string]: any;
    };
    initializeState(): void;
    finalizeState(): void;
    /**
     * deck.gl layer lifecycle: decide if layer needs to update
     * Following deck.gl TileLayer pattern - return true for any change including viewport
     */
    shouldUpdateState({ changeFlags }: any): boolean;
    updateState({ changeFlags }: any): void;
    private _updateTileset;
    private initArchiveAndTileset;
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
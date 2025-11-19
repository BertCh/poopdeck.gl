/**
 * Spatiotemporal Tileset Manager
 *
 * Inspired by deck.gl's Tileset2D but extended for the temporal dimension.
 * Manages tile lifecycle, request queue, caching, and viewport-based tile selection.
 */
import type { Tile, TileId, BoundingBox } from './types';
export interface SpatiotemporalTilesetOptions {
    /** Maximum concurrent tile requests */
    maxRequests?: number;
    /** Debounce time in milliseconds before loading tiles */
    debounceTime?: number;
    /** Maximum number of tiles to cache */
    maxCacheSize?: number;
    /** Maximum cache size in bytes */
    maxCacheByteSize?: number;
    /** Minimum zoom level available in data */
    minZoom?: number;
    /** Maximum zoom level available in data */
    maxZoom?: number;
    /** Refinement strategy: 'best-available' (load parent tiles as fallback) or 'no-overlap' (only exact zoom) */
    refinementStrategy?: 'best-available' | 'no-overlap';
    /** Enable predictive prefetching for animations */
    enablePrefetch?: boolean;
    /** Number of time steps to prefetch ahead */
    prefetchTimeSteps?: number;
    /** Time increment for each prefetch step (milliseconds) */
    prefetchTimeIncrement?: number;
    /** Callback to get available tiles for bounds/time */
    getAvailableTiles: (bounds: BoundingBox, zoom: number, timeRange: {
        start: number;
        end: number;
    }) => Promise<TileId[]>;
    /** Callback to fetch tile data */
    getTileData: (tileId: TileId) => Promise<Tile | null>;
    /** Callback when tile loads */
    onTileLoad?: (tile: Tile) => void;
    /** Callback when tile unloads */
    onTileUnload?: (tile: Tile) => void;
    /** Callback on error */
    onTileError?: (error: Error, tileId: TileId) => void;
}
export interface SpatiotemporalTileHeader {
    id: TileId;
    tile: Tile | null;
    isLoaded: boolean;
    isLoading: boolean;
    isCancelled: boolean;
    lastUsed: number;
    byteSize: number;
}
/**
 * Manages spatiotemporal tile loading with:
 * - Request concurrency control (maxRequests)
 * - Debouncing for viewport changes
 * - LRU cache eviction
 * - Temporal + spatial tile selection
 */
export declare class SpatiotemporalTileset {
    options: Required<SpatiotemporalTilesetOptions>;
    private tiles;
    private requestQueue;
    private activeRequests;
    private currentViewport;
    private debounceTimer;
    private frameNumber;
    private cacheStats;
    constructor(options: SpatiotemporalTilesetOptions);
    /**
     * Update tileset with new viewport
     * Returns new frame number if tiles changed
     */
    update(viewport: {
        bounds: BoundingBox;
        zoom: number;
        time: number;
        timeWindow: number;
    }, skipDebounce?: boolean): number;
    /**
     * Get zoom levels to load based on refinement strategy
     *
     * 'best-available': Load requested zoom + parent tiles as fallback
     * 'no-overlap': Only load requested zoom level
     *
     * This follows deck.gl TileLayer patterns for LOD (Level of Detail)
     */
    private getZoomLevelsToLoad;
    /**
     * Select tiles for current viewport and queue for loading
     * Now includes predictive prefetching for animation playback
     */
    private selectAndLoadTiles;
    /**
     * Load tiles for a specific time range
     */
    private loadTilesForTimeRange;
    /**
     * Prefetch tiles ahead of current time for smooth animation
     * This loads multiple time slices into the future
     */
    private prefetchFutureTiles;
    /**
     * Process request queue with concurrency limit
     */
    private processRequestQueue;
    /**
     * Evict tiles not recently used (LRU)
     * Very conservative eviction to support smooth animation loops
     * With massively increased cache sizes for seamless playback
     */
    private evictUnusedTiles;
    /**
     * Actually evict tiles from cache
     */
    private evictTiles;
    /**
     * Get visible tiles for rendering
     * Returns tiles that overlap with current time window
     */
    getVisibleTiles(): Tile[];
    /**
     * Get tiles specifically for current viewport (for filtering)
     */
    getViewportTiles(): Tile[];
    /**
     * Get cache statistics
     */
    getCacheStats(): {
        tileCount: number;
        activeRequests: number;
        queuedRequests: number;
        hits: number;
        misses: number;
        evictions: number;
    };
    /**
     * Clear all tiles
     */
    clear(): void;
    /**
     * Finalize and cleanup
     */
    finalize(): void;
    private tileIdToKey;
    private estimateTileSize;
}
//# sourceMappingURL=spatiotemporal-tileset.d.ts.map
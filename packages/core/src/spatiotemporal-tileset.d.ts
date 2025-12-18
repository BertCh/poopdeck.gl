/**
 * Spatiotemporal Tileset Manager
 *
 * Inspired by deck.gl's Tileset2D but extended for the temporal dimension.
 * Manages tile lifecycle, request queue, caching, and viewport-based tile selection.
 *
 * Performance optimizations (120fps target):
 * - Priority queue ensures current tiles load before prefetch
 * - Prefetch capped to 20% of maxRequests to avoid network saturation
 * - Prefetch intensity scales with playback speed
 * - Reduced default prefetchSteps from 10 to 5
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
    /** How far ahead to prefetch (in milliseconds of animation time) */
    prefetchAhead?: number;
    /** Number of time window steps to prefetch */
    prefetchSteps?: number;
    /** Callback to get available tiles for bounds/time */
    getAvailableTiles: (bounds: BoundingBox, zoom: number, timeRange: {
        start: number;
        end: number;
    }) => Promise<TileId[]>;
    /** Callback to fetch tile data (with optional abort signal for cancellation) */
    getTileData: (tileId: TileId, signal?: AbortSignal) => Promise<Tile | null>;
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
    abortController?: AbortController;
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
    private activeRequests;
    private currentViewport;
    private debounceTimer;
    private frameNumber;
    private cacheStats;
    private animationSpeed;
    private lastUpdateTime;
    private isAnimating;
    private priorityQueue;
    private prefetchQueue;
    private neededTileKeys;
    private neededTilesVersion;
    constructor(options: SpatiotemporalTilesetOptions);
    /**
     * Update animation state for prefetching
     * Call this when animation starts/stops or speed changes
     */
    setAnimationState(isAnimating: boolean, speed?: number): void;
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
     */
    private selectAndLoadTiles;
    /**
     * Prefetch tiles ahead of current animation time
     * This ensures smooth playback by loading tiles before they're needed
     *
     * PERFORMANCE: Prefetch intensity scales with playback speed:
     * - Paused/slow: fewer steps (1-2)
     * - Normal speed: moderate steps (3-4)
     * - Fast playback: full prefetch steps
     */
    private prefetchFutureTiles;
    /**
     * Process request queues with concurrency limit
     * Priority queue is processed first, prefetch queue uses remaining capacity
     *
     * PERFORMANCE: Prefetch capped to 20% of maxRequests to avoid network saturation
     * and ensure priority tiles always have bandwidth available.
     */
    private processRequestQueue;
    /**
     * Start loading a single tile
     * Returns true if load was started, false if skipped
     *
     * PERFORMANCE: Uses AbortController to cancel superseded requests
     * when viewport/time changes significantly.
     */
    private startTileLoad;
    /**
     * Cancel in-flight requests for tiles that are no longer needed
     * Called when viewport/time changes significantly
     */
    cancelSupersededRequests(neededTileKeys: Set<string>): number;
    /**
     * Evict tiles not recently used (LRU)
     *
     * PERFORMANCE: Grace period reduced from 5 minutes to 60 seconds
     * to prevent memory bloat while still supporting animation loops.
     */
    private evictUnusedTiles;
    /**
     * Actually evict tiles from cache
     */
    private evictTiles;
    /**
     * Get visible tiles for rendering
     *
     * PERFORMANCE OPTIMIZED - O(k) where k = needed tiles count:
     * - Uses pre-computed neededTileKeys from selectAndLoadTiles()
     * - No searching through all cached tiles
     * - Just iterates over the known-needed set and returns loaded ones
     *
     * The neededTileKeys set is computed using spatial/temporal knowledge:
     * - Viewport bounds + zoom -> which (x,y) tiles are visible
     * - Current time + window -> which temporal tiles overlap
     * - This is already computed in selectAndLoadTiles() via getTileIdsInBounds()
     */
    getVisibleTiles(): Tile[];
    /**
     * Get tiles specifically for current viewport (for filtering)
     * Uses the same optimized method as getVisibleTiles
     */
    getViewportTiles(): Tile[];
    /**
     * Get cache statistics
     */
    getCacheStats(): {
        tileCount: number;
        activeRequests: number;
        priorityQueueLength: number;
        prefetchQueueLength: number;
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
/**
 * Spatiotemporal Tileset Manager
 *
 * Inspired by deck.gl's Tileset2D but extended for the temporal dimension.
 * Manages tile lifecycle, request queue, caching, and viewport-based tile selection.
 */
/**
 * Manages spatiotemporal tile loading with:
 * - Request concurrency control (maxRequests)
 * - Debouncing for viewport changes
 * - LRU cache eviction
 * - Temporal + spatial tile selection
 */
export class SpatiotemporalTileset {
    constructor(options) {
        // Tile registry
        this.tiles = new Map();
        // Request queue
        this.requestQueue = [];
        this.activeRequests = new Set();
        // Viewport state
        this.currentViewport = null;
        // Debounce timer
        this.debounceTimer = null;
        // Frame tracking (for render optimization)
        this.frameNumber = 0;
        // Cache statistics
        this.cacheStats = {
            hits: 0,
            misses: 0,
            evictions: 0,
        };
        this.options = {
            maxRequests: options.maxRequests ?? 24, // 4x from original 6 - VERY aggressive for fast scrubbing
            debounceTime: options.debounceTime ?? 50, // Reduced from 100ms for instant response
            maxCacheSize: options.maxCacheSize ?? 5000, // 25x increase from 200 - cache entire datasets
            maxCacheByteSize: options.maxCacheByteSize ?? 4 * 1024 * 1024 * 1024, // 4GB for massive caching
            minZoom: options.minZoom ?? 0,
            maxZoom: options.maxZoom ?? 14,
            refinementStrategy: options.refinementStrategy ?? 'best-available', // Default: load parent tiles as fallback
            enablePrefetch: options.enablePrefetch ?? true, // Enable by default
            prefetchTimeSteps: options.prefetchTimeSteps ?? 30, // Prefetch 30 time steps ahead (3x from 10)
            prefetchTimeIncrement: options.prefetchTimeIncrement ?? 86400000, // 1 day default
            getAvailableTiles: options.getAvailableTiles,
            getTileData: options.getTileData,
            onTileLoad: options.onTileLoad ?? (() => { }),
            onTileUnload: options.onTileUnload ?? (() => { }),
            onTileError: options.onTileError ?? ((err) => console.error(err)),
        };
    }
    /**
     * Update tileset with new viewport
     * Returns new frame number if tiles changed
     */
    update(viewport, skipDebounce = false) {
        this.currentViewport = viewport;
        // Cancel pending debounce if viewport changed
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        // Skip debounce for time-only changes during animation
        if (skipDebounce || this.options.debounceTime === 0) {
            this.selectAndLoadTiles();
        }
        else {
            // Debounce for viewport changes (pan/zoom)
            this.debounceTimer = setTimeout(() => {
                this.selectAndLoadTiles();
            }, this.options.debounceTime);
        }
        return this.frameNumber;
    }
    /**
     * Get zoom levels to load based on refinement strategy
     *
     * 'best-available': Load requested zoom + parent tiles as fallback
     * 'no-overlap': Only load requested zoom level
     *
     * This follows deck.gl TileLayer patterns for LOD (Level of Detail)
     */
    getZoomLevelsToLoad(requestedZoom) {
        const { refinementStrategy, minZoom, maxZoom } = this.options;
        // Clamp requested zoom to available range
        const clampedZoom = Math.max(minZoom, Math.min(maxZoom, requestedZoom));
        if (refinementStrategy === 'no-overlap') {
            // Only load the exact zoom level
            return [clampedZoom];
        }
        // 'best-available': Load requested zoom + parent tiles for fallback
        // This ensures we always have something to show while detailed tiles load
        const zoomLevels = [clampedZoom];
        // Add parent zoom levels (up to 2 levels back)
        // This provides smooth progressive refinement
        if (clampedZoom > minZoom) {
            zoomLevels.push(clampedZoom - 1);
        }
        if (clampedZoom > minZoom + 1) {
            zoomLevels.push(clampedZoom - 2);
        }
        return zoomLevels;
    }
    /**
     * Select tiles for current viewport and queue for loading
     * Now includes predictive prefetching for animation playback
     */
    async selectAndLoadTiles() {
        if (!this.currentViewport)
            return;
        const { bounds, zoom, time, timeWindow } = this.currentViewport;
        // Calculate temporal range for current viewport
        const timeRange = {
            start: time - timeWindow / 2,
            end: time + timeWindow / 2,
        };
        // Get zoom levels to load (supports LOD with parent tiles)
        const zoomLevels = this.getZoomLevelsToLoad(zoom);
        // Mark tiles as used (for LRU)
        const now = Date.now();
        const neededTileKeys = new Set();
        // Load tiles for current viewport (highest priority)
        await this.loadTilesForTimeRange(bounds, zoomLevels, timeRange, neededTileKeys, now, true);
        // PREFETCHING: Load tiles ahead of animation if enabled
        if (this.options.enablePrefetch) {
            await this.prefetchFutureTiles(bounds, zoom, time, timeWindow, neededTileKeys, now);
        }
        // Remove tiles not in viewport (with grace period)
        this.evictUnusedTiles(neededTileKeys);
        // Process request queue
        this.processRequestQueue();
        // Increment frame number
        this.frameNumber++;
    }
    /**
     * Load tiles for a specific time range
     */
    async loadTilesForTimeRange(bounds, zoomLevels, timeRange, neededTileKeys, now, highPriority = false) {
        // Load tiles for each zoom level
        // Primary zoom (most detailed) is loaded first, then parent zooms as fallback
        for (const z of zoomLevels) {
            // Query archive for available tiles at this zoom level
            const availableTileIds = await this.options.getAvailableTiles(bounds, z, timeRange);
            for (const tileId of availableTileIds) {
                const key = this.tileIdToKey(tileId);
                neededTileKeys.add(key);
                let header = this.tiles.get(key);
                if (!header) {
                    // Create new tile header
                    header = {
                        id: tileId,
                        tile: null,
                        isLoaded: false,
                        isLoading: false,
                        isCancelled: false,
                        lastUsed: now,
                        byteSize: 0,
                    };
                    this.tiles.set(key, header);
                    // Add to request queue
                    // Higher zoom (more detailed) tiles get priority
                    if (highPriority) {
                        // Current viewport - highest priority (add to front)
                        this.requestQueue.unshift(tileId);
                    }
                    else {
                        // Prefetch - lower priority (add to back)
                        this.requestQueue.push(tileId);
                    }
                }
                else {
                    // Update last used time
                    header.lastUsed = now;
                }
            }
        }
    }
    /**
     * Prefetch tiles ahead of current time for smooth animation
     * This loads multiple time slices into the future
     */
    async prefetchFutureTiles(bounds, zoom, currentTime, timeWindow, neededTileKeys, now) {
        const { prefetchTimeSteps, prefetchTimeIncrement } = this.options;
        // Only load primary zoom for prefetch (not parent tiles) to avoid overloading
        const zoomLevels = [zoom];
        // Prefetch N time steps into the future
        for (let step = 1; step <= prefetchTimeSteps; step++) {
            const futureTime = currentTime + (step * prefetchTimeIncrement);
            const futureTimeRange = {
                start: futureTime - timeWindow / 2,
                end: futureTime + timeWindow / 2,
            };
            // Load tiles for this future time range (lower priority)
            await this.loadTilesForTimeRange(bounds, zoomLevels, futureTimeRange, neededTileKeys, now - (step * 1000), // Slightly lower lastUsed time for LRU ordering
            false // Not high priority
            );
        }
    }
    /**
     * Process request queue with concurrency limit
     */
    async processRequestQueue() {
        while (this.requestQueue.length > 0 &&
            this.activeRequests.size < this.options.maxRequests) {
            const tileId = this.requestQueue.shift();
            const key = this.tileIdToKey(tileId);
            // Skip if already loading or loaded
            const header = this.tiles.get(key);
            if (!header || header.isLoading || header.isLoaded) {
                continue;
            }
            // Mark as loading
            header.isLoading = true;
            this.activeRequests.add(key);
            // Load tile
            this.options.getTileData(tileId)
                .then((tile) => {
                if (!header.isCancelled && tile) {
                    header.tile = tile;
                    header.isLoaded = true;
                    header.byteSize = this.estimateTileSize(tile);
                    this.cacheStats.hits++;
                    this.options.onTileLoad?.(tile);
                    // Trigger re-render
                    this.frameNumber++;
                }
            })
                .catch((error) => {
                this.options.onTileError?.(error, tileId);
            })
                .finally(() => {
                header.isLoading = false;
                this.activeRequests.delete(key);
                // Process next in queue
                this.processRequestQueue();
            });
        }
    }
    /**
     * Evict tiles not recently used (LRU)
     * Very conservative eviction to support smooth animation loops
     * With massively increased cache sizes for seamless playback
     */
    evictUnusedTiles(neededTileKeys) {
        const now = Date.now();
        const GRACE_PERIOD = 300000; // 5 minutes (increased from 2 min) - allows long animation loops to reuse tiles
        // Calculate current cache usage
        let currentCacheSize = 0;
        let currentCacheBytes = 0;
        for (const [, header] of this.tiles) {
            if (header.isLoaded && header.tile) {
                currentCacheSize++;
                currentCacheBytes += header.byteSize;
            }
        }
        // Only evict if we're significantly over limits (give more headroom)
        const overSizeLimit = currentCacheSize > this.options.maxCacheSize * 1.1; // 10% buffer
        const overByteLimit = currentCacheBytes > this.options.maxCacheByteSize * 1.1; // 10% buffer
        if (!overSizeLimit && !overByteLimit) {
            // Under limits - only evict tiles outside grace period
            const tilesToEvict = [];
            for (const [tileKey, header] of this.tiles) {
                const isNeeded = neededTileKeys.has(tileKey);
                const isRecent = (now - header.lastUsed) < GRACE_PERIOD;
                if (!isNeeded && !isRecent) {
                    tilesToEvict.push(tileKey);
                }
            }
            this.evictTiles(tilesToEvict);
            return;
        }
        // Over limits - use LRU to evict oldest tiles
        // But NEVER evict tiles in current viewport (neededTileKeys)
        const sortedTiles = Array.from(this.tiles.entries())
            .filter(([key]) => !neededTileKeys.has(key)) // Never evict needed tiles
            .sort((a, b) => a[1].lastUsed - b[1].lastUsed); // Oldest first
        const tilesToEvict = [];
        // Only evict until we're back under limits (not under buffer)
        for (const [tileKey, header] of sortedTiles) {
            if (!header.isLoaded)
                continue;
            // Check if we're still over the actual limits (not buffer)
            const stillOverSize = currentCacheSize > this.options.maxCacheSize;
            const stillOverBytes = currentCacheBytes > this.options.maxCacheByteSize;
            if (!stillOverSize && !stillOverBytes) {
                break; // We're under limits now, stop evicting
            }
            tilesToEvict.push(tileKey);
            currentCacheSize--;
            currentCacheBytes -= header.byteSize;
        }
        this.evictTiles(tilesToEvict);
    }
    /**
     * Actually evict tiles from cache
     */
    evictTiles(tileKeys) {
        for (const tileKey of tileKeys) {
            const header = this.tiles.get(tileKey);
            if (header) {
                if (header.tile) {
                    this.options.onTileUnload?.(header.tile);
                }
                this.tiles.delete(tileKey);
                this.cacheStats.evictions++;
            }
        }
    }
    /**
     * Get visible tiles for rendering
     * Returns tiles that overlap with current time window
     */
    getVisibleTiles() {
        if (!this.currentViewport) {
            // No viewport set yet - return all loaded tiles
            const tiles = [];
            for (const header of this.tiles.values()) {
                if (header.isLoaded && header.tile) {
                    tiles.push(header.tile);
                }
            }
            return tiles;
        }
        const { time, timeWindow } = this.currentViewport;
        const timeStart = time - timeWindow / 2;
        const timeEnd = time + timeWindow / 2;
        const tiles = [];
        // Only return tiles whose time range overlaps with current window
        for (const header of this.tiles.values()) {
            if (header.isLoaded && header.tile) {
                const tileTimeRange = header.tile.timeRange;
                // Check if tile's time range overlaps with current time window
                if (tileTimeRange.end >= timeStart && tileTimeRange.start <= timeEnd) {
                    tiles.push(header.tile);
                }
            }
        }
        return tiles;
    }
    /**
     * Get tiles specifically for current viewport (for filtering)
     */
    getViewportTiles() {
        if (!this.currentViewport)
            return [];
        const { time, timeWindow } = this.currentViewport;
        const timeStart = time - timeWindow / 2;
        const timeEnd = time + timeWindow / 2;
        const tiles = [];
        for (const header of this.tiles.values()) {
            if (header.isLoaded && header.tile) {
                // Check if tile's time range overlaps with current time window
                const tileTimeRange = header.tile.timeRange;
                if (tileTimeRange.end >= timeStart && tileTimeRange.start <= timeEnd) {
                    tiles.push(header.tile);
                }
            }
        }
        return tiles;
    }
    /**
     * Get cache statistics
     */
    getCacheStats() {
        return {
            ...this.cacheStats,
            tileCount: this.tiles.size,
            activeRequests: this.activeRequests.size,
            queuedRequests: this.requestQueue.length,
        };
    }
    /**
     * Clear all tiles
     */
    clear() {
        for (const header of this.tiles.values()) {
            if (header.tile) {
                this.options.onTileUnload?.(header.tile);
            }
        }
        this.tiles.clear();
        this.requestQueue = [];
        this.activeRequests.clear();
    }
    /**
     * Finalize and cleanup
     */
    finalize() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.clear();
    }
    // Helper methods
    tileIdToKey(id) {
        return `${id.z}/${id.x}/${id.y}/${id.t}`;
    }
    // Helper methods removed - now using archive's getTileIdsInBounds
    // which has its own spatial tile calculation
    estimateTileSize(tile) {
        // Rough estimate: count features and properties
        let size = 1000; // Base overhead
        for (const layer of tile.layers) {
            for (const feature of layer.features) {
                size += 100; // Per feature
                size += feature.geometry.length * 4; // Geometry array
                size += JSON.stringify(feature.properties).length; // Properties
            }
        }
        return size;
    }
}
//# sourceMappingURL=spatiotemporal-tileset.js.map
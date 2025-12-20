/**
 * Spatiotemporal Tileset Manager
 * 
 * Inspired by deck.gl's Tileset2D but extended for the temporal dimension.
 * Manages tile lifecycle, request queue, caching, and viewport-based tile selection.
 * 
 * Performance optimizations (120fps target):
 * - Priority queue ensures current tiles load before prefetch
 * - Prefetch uses up to 50% of maxRequests for smooth animation
 * - Prefetch is aggressive by default to prevent flashing
 * - Prefetch steps scaled based on playback speed
 */

import type {
  Tile,
  TileId,
  BoundingBox,
} from './types';

const DEBUG = false;

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
  getAvailableTiles: (
    bounds: BoundingBox,
    zoom: number,
    timeRange: { start: number; end: number }
  ) => Promise<TileId[]>;
  
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
  lastUsed: number; // Timestamp for LRU
  byteSize: number; // Estimated size for cache management
  abortController?: AbortController; // For cancelling in-flight requests
}

/**
 * Manages spatiotemporal tile loading with:
 * - Request concurrency control (maxRequests)
 * - Debouncing for viewport changes
 * - LRU cache eviction
 * - Temporal + spatial tile selection
 */
export class SpatiotemporalTileset {
  options: Required<SpatiotemporalTilesetOptions>;
  
  // Tile registry
  private tiles: Map<string, SpatiotemporalTileHeader> = new Map();
  
  // Active requests tracking
  private activeRequests: Set<string> = new Set();
  
  // Viewport state
  private currentViewport: {
    bounds: BoundingBox;
    zoom: number;
    time: number;
    timeWindow: number;
  } | null = null;
  
  // Debounce timer
  private debounceTimer: NodeJS.Timeout | null = null;
  
  // Frame tracking (for render optimization)
  private frameNumber = 0;
  
  // Cache statistics
  private cacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
  };
  
  // Animation state for prefetching
  private animationSpeed: number = 0;
  private lastUpdateTime: number = 0;
  private isAnimating: boolean = false;
  
  // Separate queues for priority management
  private priorityQueue: TileId[] = []; // High priority - current time tiles
  private prefetchQueue: TileId[] = []; // Low priority - future tiles
  
  // Currently needed tile keys - computed during selectAndLoadTiles()
  // This is the authoritative set of tiles that should be visible for current viewport/time
  // getVisibleTiles() just returns loaded tiles from this set - O(k) not O(n)
  private neededTileKeys: Set<string> = new Set();
  
  // Version tracking for cache invalidation
  private neededTilesVersion: number = 0;
  
  constructor(options: SpatiotemporalTilesetOptions) {
    this.options = {
      maxRequests: options.maxRequests ?? 64, // Higher for parallel animation loading
      debounceTime: options.debounceTime ?? 0, // No debounce by default for smooth animation
      maxCacheSize: options.maxCacheSize ?? 2000, // Large cache for animation loops with big datasets
      maxCacheByteSize: options.maxCacheByteSize ?? 2 * 1024 * 1024 * 1024, // 2GB for large datasets
      minZoom: options.minZoom ?? 0,
      maxZoom: options.maxZoom ?? 14,
      refinementStrategy: options.refinementStrategy ?? 'best-available', // Default: load parent tiles as fallback
      enablePrefetch: options.enablePrefetch ?? true, // Enable by default
      prefetchAhead: options.prefetchAhead ?? 60000, // 60 seconds ahead default for smooth animation
      prefetchSteps: options.prefetchSteps ?? 15, // Aggressive prefetching to prevent flashing
      getAvailableTiles: options.getAvailableTiles,
      getTileData: options.getTileData,
      onTileLoad: options.onTileLoad ?? (() => {}),
      onTileUnload: options.onTileUnload ?? (() => {}),
      onTileError: options.onTileError ?? ((err) => console.error(err)),
    };
  }
  
  /**
   * Update animation state for prefetching
   * Call this when animation starts/stops or speed changes
   */
  setAnimationState(isAnimating: boolean, speed: number = 0): void {
    if (DEBUG) console.log('[Tileset] setAnimationState:', { isAnimating, speed, enablePrefetch: this.options.enablePrefetch });
    const wasAnimating = this.isAnimating;
    this.isAnimating = isAnimating;
    this.animationSpeed = speed;
    
    if (this.currentViewport) {
      if (isAnimating && this.options.enablePrefetch) {
        // When animation starts, trigger prefetch immediately
        if (DEBUG) console.log('[Tileset] Triggering immediate prefetch');
        this.prefetchFutureTiles();
      } else if (!isAnimating && wasAnimating) {
        // When animation pauses, ensure tiles for current time are loaded
        // This handles the case where loading was lagging behind animation
        if (DEBUG) console.log('[Tileset] Animation paused, ensuring current time tiles are loaded');
        this.selectAndLoadTiles();
      }
    }
  }
  
  /**
   * Update tileset with new viewport
   * Returns new frame number if tiles changed
   */
  update(viewport: {
    bounds: BoundingBox;
    zoom: number;
    time: number;
    timeWindow: number;
  }, skipDebounce: boolean = false): number {
    const previousTime = this.currentViewport?.time;
    this.currentViewport = viewport;
    
    // Track animation speed based on time changes
    const now = Date.now();
    if (previousTime !== undefined && this.lastUpdateTime > 0) {
      const realTimeDelta = now - this.lastUpdateTime;
      const simTimeDelta = viewport.time - previousTime;
      if (realTimeDelta > 0 && realTimeDelta < 1000) { // Ignore large gaps
        this.animationSpeed = simTimeDelta / realTimeDelta;
      }
    }
    this.lastUpdateTime = now;
    
    // Cancel pending debounce if viewport changed
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    
    // Skip debounce for time-only changes during animation
    if (skipDebounce || this.options.debounceTime === 0) {
      this.selectAndLoadTiles();
    } else {
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
  private getZoomLevelsToLoad(requestedZoom: number): number[] {
    const { refinementStrategy, minZoom, maxZoom } = this.options;
    
    // Clamp requested zoom to available range
    const clampedZoom = Math.max(minZoom, Math.min(maxZoom, requestedZoom));
    
    if (refinementStrategy === 'no-overlap') {
      // Only load the exact zoom level
      return [clampedZoom];
    }
    
    // 'best-available': Load requested zoom + parent tiles for fallback
    // This ensures we always have something to show while detailed tiles load
    const zoomLevels: number[] = [clampedZoom];
    
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
   */
  private async selectAndLoadTiles(): Promise<void> {
    if (!this.currentViewport) return;
    
    const { bounds, zoom, time, timeWindow } = this.currentViewport;
    
    // Calculate temporal range
    const timeRange = {
      start: time - timeWindow / 2,
      end: time + timeWindow / 2,
    };
    
    // Get zoom levels to load (supports LOD with parent tiles)
    const zoomLevels = this.getZoomLevelsToLoad(zoom);
    
    // Mark tiles as used (for LRU)
    const now = Date.now();
    const neededTileKeys = new Set<string>();
    
    // Query available tiles for ALL zoom levels IN PARALLEL
    // This is much faster than sequential queries, especially for initial load
    const tileIdsByZoom = await Promise.all(
      zoomLevels.map(async (z) => ({
        zoom: z,
        tileIds: await this.options.getAvailableTiles(bounds, z, timeRange),
      }))
    );
    
    // Process results - primary zoom first for proper queue ordering
    for (const { zoom: z, tileIds: availableTileIds } of tileIdsByZoom) {
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
          
          // Add to HIGH PRIORITY queue for current time tiles
          // These always load before prefetch tiles
          if (z === zoom) {
            // Primary zoom - front of priority queue
            this.priorityQueue.unshift(tileId);
          } else {
            // Parent zoom - back of priority queue (still before prefetch)
            this.priorityQueue.push(tileId);
          }
        } else {
          // Update last used time
          header.lastUsed = now;
        }
      }
    }
    
    // Store the needed tile keys for getVisibleTiles()
    // This is the authoritative set - no searching needed later
    this.neededTileKeys = neededTileKeys;
    this.neededTilesVersion++;
    
    // Cancel in-flight requests for tiles that are no longer needed
    // This frees up bandwidth for current tiles
    this.cancelSupersededRequests(neededTileKeys);
    
    // Always prefetch when enabled - don't wait for animation to start
    // This ensures tiles are pre-loaded for smooth playback from the beginning
    if (this.options.enablePrefetch) {
      if (DEBUG) console.log('[Tileset] Prefetch enabled, triggering prefetch');
      this.prefetchFutureTiles();
    }
    
    // Remove tiles not in viewport (with grace period)
    this.evictUnusedTiles(neededTileKeys);
    
    // Process request queues - priority first, then prefetch
    this.processRequestQueue();
    
    // Increment frame number
    this.frameNumber++;
  }
  
  /**
   * Prefetch tiles ahead of current animation time
   * This ensures smooth playback by loading tiles before they're needed
   * 
   * PERFORMANCE: Prefetch intensity scales with playback speed:
   * - Paused/slow: fewer steps (1-2)
   * - Normal speed: moderate steps (3-4)
   * - Fast playback: full prefetch steps
   */
  private async prefetchFutureTiles(): Promise<void> {
    if (!this.currentViewport) return;
    
    const { bounds, zoom, time, timeWindow } = this.currentViewport;
    const { prefetchAhead, prefetchSteps } = this.options;
    
    // Determine prefetch direction based on animation speed
    const direction = this.animationSpeed >= 0 ? 1 : -1;
    
    // Scale prefetch steps based on animation speed
    // We're more aggressive now to prevent flashing during playback
    // Speed = sim time delta / real time delta (typically 100-1000x for most datasets)
    const absSpeed = Math.abs(this.animationSpeed);
    let effectiveSteps: number;
    if (absSpeed < 0.01) {
      // Completely paused - still prefetch a few steps for scrubbing
      effectiveSteps = Math.max(5, Math.floor(prefetchSteps * 0.5));
    } else if (absSpeed < 1.0) {
      // Very slow playback - moderate prefetch
      effectiveSteps = Math.max(8, Math.floor(prefetchSteps * 0.7));
    } else {
      // Normal to fast playback - full prefetch
      effectiveSteps = prefetchSteps;
    }
    
    // prefetchAhead is expected to already be in SIMULATION TIME units
    // (App.tsx calculates it as: playbackSpeed * 5000 or timeWindow, whichever is larger)
    // So we use it directly without additional scaling
    // When paused (animationSpeed ~= 0), use timeWindow as sensible default
    const effectivePrefetchAhead = prefetchAhead > 0 ? prefetchAhead : timeWindow;
    
    if (DEBUG) console.log('[Tileset] prefetchFutureTiles:', { 
      time: new Date(time).toISOString(),
      timeWindow,
      effectivePrefetchAhead,
      effectiveSteps,
      absSpeed,
      direction
    });
    
    // Get zoom levels to prefetch
    const zoomLevels = this.getZoomLevelsToLoad(zoom);
    const now = Date.now();
    
    // Build all prefetch queries to run in parallel
    // Instead of nested sequential loops, we create all query combinations upfront
    const prefetchQueries: Array<{
      step: number;
      zoom: number;
      timeRange: { start: number; end: number };
    }> = [];
    
    for (let step = 1; step <= effectiveSteps; step++) {
      const futureTime = time + (direction * effectivePrefetchAhead * step);
      const futureTimeRange = {
        start: futureTime - timeWindow / 2,
        end: futureTime + timeWindow / 2,
      };
      
      for (const z of zoomLevels) {
        prefetchQueries.push({ step, zoom: z, timeRange: futureTimeRange });
      }
    }
    
    if (DEBUG) console.log('[Tileset] Prefetch queries:', prefetchQueries.length, 'first:', prefetchQueries[0]?.timeRange);
    
    // Execute ALL prefetch queries IN PARALLEL
    const results = await Promise.allSettled(
      prefetchQueries.map(async (query) => {
        const tileIds = await this.options.getAvailableTiles(
          bounds,
          query.zoom,
          query.timeRange
        );
        return { ...query, tileIds };
      })
    );
    
    // Count total tiles found
    let totalTilesFound = 0;
    let newTilesAdded = 0;
    
    // Process successful results
    for (const result of results) {
      if (result.status === 'rejected') {
        // Ignore prefetch errors - they're best-effort
        console.debug('[Tileset] Prefetch error:', result.reason);
        continue;
      }
      
      const { tileIds } = result.value;
      totalTilesFound += tileIds.length;
      
      for (const tileId of tileIds) {
        const key = this.tileIdToKey(tileId);
        let header = this.tiles.get(key);
        
        if (!header) {
          // Create header for prefetch tile
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
          
          // Add to LOW PRIORITY prefetch queue
          // These only load when priority queue has capacity
          this.prefetchQueue.push(tileId);
          newTilesAdded++;
        } else {
          // Update last used time to prevent eviction
          header.lastUsed = now;
        }
      }
    }
    
    // Log prefetch results
    if (DEBUG) {
      console.log('[Tileset] Prefetch results:', { totalTilesFound, newTilesAdded, prefetchQueueLength: this.prefetchQueue.length });
    }
    
    // Process the prefetch queue now that tiles are added
    if (newTilesAdded > 0) {
      this.processRequestQueue();
    }
  }
  
  /**
   * Process request queues with concurrency limit
   * Priority queue is processed first, prefetch queue uses remaining capacity
   * 
   * PERFORMANCE: Prefetch can use up to 50% of maxRequests for aggressive pre-loading.
   * Priority tiles always processed first to ensure current frame tiles load quickly.
   */
  private async processRequestQueue(): Promise<void> {
    // Calculate how many more requests we can start
    const availableSlots = this.options.maxRequests - this.activeRequests.size;
    if (DEBUG && (this.priorityQueue.length > 0 || this.prefetchQueue.length > 0)) {
      console.log('[Tileset] processRequestQueue:', { 
        availableSlots, 
        activeRequests: this.activeRequests.size,
        priorityQueue: this.priorityQueue.length, 
        prefetchQueue: this.prefetchQueue.length 
      });
    }
    if (availableSlots <= 0) return;
    
    // Allow prefetch to use up to 75% of slots for aggressive pre-loading during animation
    // Priority tiles are always processed first, so they get bandwidth when needed
    // During animation, prefetch is critical to prevent flashing
    const maxPrefetchSlots = this.isAnimating 
      ? Math.floor(this.options.maxRequests * 0.75)  // 75% during animation for smooth playback
      : Math.floor(this.options.maxRequests * 0.5); // 50% when paused
    // Reserve minimal slots for priority - prefetch is more important for streaming
    const priorityReserved = this.isAnimating ? Math.min(2, availableSlots) : 0;
    
    let usedSlots = 0;
    
    // Process HIGH PRIORITY queue first (current time tiles)
    while (
      this.priorityQueue.length > 0 &&
      usedSlots < availableSlots
    ) {
      const tileId = this.priorityQueue.shift()!;
      if (this.startTileLoad(tileId)) {
        usedSlots++;
      }
    }
    
    // Process LOW PRIORITY prefetch queue with remaining slots
    // Allow prefetch up to 50% of total capacity for smooth animation
    const remainingSlots = availableSlots - Math.max(usedSlots, priorityReserved);
    const prefetchSlots = Math.min(remainingSlots, maxPrefetchSlots);
    let prefetchUsed = 0;
    
    while (
      this.prefetchQueue.length > 0 &&
      prefetchUsed < prefetchSlots
    ) {
      const tileId = this.prefetchQueue.shift()!;
      if (this.startTileLoad(tileId)) {
        prefetchUsed++;
      }
    }
  }
  
  /**
   * Start loading a single tile
   * Returns true if load was started, false if skipped
   * 
   * PERFORMANCE: Uses AbortController to cancel superseded requests
   * when viewport/time changes significantly.
   */
  private startTileLoad(tileId: TileId): boolean {
    const key = this.tileIdToKey(tileId);
    
    // Skip if already loading or loaded
    const header = this.tiles.get(key);
    if (!header || header.isLoading || header.isLoaded) {
      return false;
    }
    
    // Create AbortController for this request
    const abortController = new AbortController();
    
    // Mark as loading
    header.isLoading = true;
    header.abortController = abortController;
    this.activeRequests.add(key);
    
    // Load tile with abort signal
    this.options.getTileData(tileId, abortController.signal)
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
        // Ignore abort errors - they're expected when cancelling
        if (error.name !== 'AbortError') {
          this.options.onTileError?.(error, tileId);
        }
      })
      .finally(() => {
        header.isLoading = false;
        header.abortController = undefined;
        this.activeRequests.delete(key);
        
        // Process next in queue
        this.processRequestQueue();
      });
    
    return true;
  }
  
  /**
   * Cancel in-flight requests for tiles that are no longer needed
   * Called when viewport/time changes significantly
   */
  cancelSupersededRequests(neededTileKeys: Set<string>): number {
    let cancelledCount = 0;
    
    for (const [key, header] of this.tiles) {
      // Cancel if loading but not in needed set
      if (header.isLoading && header.abortController && !neededTileKeys.has(key)) {
        header.abortController.abort();
        header.isCancelled = true;
        cancelledCount++;
      }
    }
    
    if (DEBUG && cancelledCount > 0) {
      console.log(`[Tileset] Cancelled ${cancelledCount} superseded requests`);
    }
    
    return cancelledCount;
  }
  
  /**
   * Evict tiles not recently used (LRU)
   * 
   * PERFORMANCE: Grace period reduced from 5 minutes to 60 seconds
   * to prevent memory bloat while still supporting animation loops.
   */
  private evictUnusedTiles(neededTileKeys: Set<string>): void {
    const now = Date.now();
    // Grace period scales with animation: longer during animation to keep prefetched tiles
    // 120 seconds during animation (2 minutes of real-time buffer)
    // 30 seconds when paused (keep recently viewed tiles)
    const GRACE_PERIOD = this.isAnimating ? 120000 : 30000;
    
    // Calculate current cache usage
    let currentCacheSize = 0;
    let currentCacheBytes = 0;
    
    for (const [, header] of this.tiles) {
      if (header.isLoaded && header.tile) {
        currentCacheSize++;
        currentCacheBytes += header.byteSize;
      }
    }
    
    // Only evict if we're over limits
    const overSizeLimit = currentCacheSize > this.options.maxCacheSize;
    const overByteLimit = currentCacheBytes > this.options.maxCacheByteSize;
    
    if (!overSizeLimit && !overByteLimit) {
      // Under limits - only evict tiles outside grace period
      const tilesToEvict: string[] = [];
      
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
    
    const tilesToEvict: string[] = [];
    
    for (const [tileKey, header] of sortedTiles) {
      if (!header.isLoaded) continue;
      
      // Check if we're still over limits
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
  private evictTiles(tileKeys: string[]): void {
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
  getVisibleTiles(): Tile[] {
    // Fast path: iterate only over tiles we know we need
    // This is O(k) where k = neededTileKeys.size (typically 10-50 tiles)
    // Not O(n) where n = total cached tiles (could be 1000+)
    
    const tiles: Tile[] = [];
    
    for (const key of this.neededTileKeys) {
      const header = this.tiles.get(key);
      if (header?.isLoaded && header.tile) {
        tiles.push(header.tile);
      }
    }
    
    return tiles;
  }
  
  /**
   * Get tiles specifically for current viewport (for filtering)
   * Uses the same optimized method as getVisibleTiles
   */
  getViewportTiles(): Tile[] {
    // Delegate to getVisibleTiles which uses optimized sorted index
    return this.getVisibleTiles();
  }
  
  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      ...this.cacheStats,
      tileCount: this.tiles.size,
      activeRequests: this.activeRequests.size,
      priorityQueueLength: this.priorityQueue.length,
      prefetchQueueLength: this.prefetchQueue.length,
    };
  }
  
  /**
   * Clear all tiles
   */
  clear(): void {
    for (const header of this.tiles.values()) {
      if (header.tile) {
        this.options.onTileUnload?.(header.tile);
      }
    }
    
    // Clear needed tiles tracking
    this.neededTileKeys.clear();
    this.neededTilesVersion++;
    
    this.tiles.clear();
    this.priorityQueue = [];
    this.prefetchQueue = [];
    this.activeRequests.clear();
  }
  
  /**
   * Finalize and cleanup
   */
  finalize(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.clear();
  }
  
  // Helper methods
  
  private tileIdToKey(id: TileId): string {
    return `${id.z}/${id.x}/${id.y}/${id.t}`;
  }
  
  // Helper methods removed - now using archive's getTileIdsInBounds
  // which has its own spatial tile calculation
  
  private estimateTileSize(tile: Tile): number {
    // Calculate tile size from binary features
    let size = 1000; // Base overhead
    
    if (!tile?.layers) {
      return size;
    }
    
    for (const layer of tile.layers) {
      const features = layer?.features;
      if (!features) {
        continue;
      }
      
      // Use binary feature sizes directly
      size += features.positions.byteLength;
      size += features.featureIds.byteLength;
      size += features.startTimes.byteLength;
      size += features.endTimes.byteLength;
      
      if (features.startIndices) {
        size += features.startIndices.byteLength;
      }
      
      for (const arr of Object.values(features.numericProps)) {
        size += arr.byteLength;
      }
      
      for (const { indices } of Object.values(features.categoricalProps)) {
        size += indices.byteLength;
      }
    }
    
    return size;
  }
}


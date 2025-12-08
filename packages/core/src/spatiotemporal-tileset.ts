/**
 * Spatiotemporal Tileset Manager
 * 
 * Inspired by deck.gl's Tileset2D but extended for the temporal dimension.
 * Manages tile lifecycle, request queue, caching, and viewport-based tile selection.
 */

import type {
  Tile,
  TileId,
  BoundingBox,
} from './types';

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
  lastUsed: number; // Timestamp for LRU
  byteSize: number; // Estimated size for cache management
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
  
  constructor(options: SpatiotemporalTilesetOptions) {
    this.options = {
      maxRequests: options.maxRequests ?? 60, // Increased default for animation
      debounceTime: options.debounceTime ?? 300,
      maxCacheSize: options.maxCacheSize ?? 200, // Increased from 100
      maxCacheByteSize: options.maxCacheByteSize ?? 500 * 1024 * 1024, // 500MB (increased from 200MB)
      minZoom: options.minZoom ?? 0,
      maxZoom: options.maxZoom ?? 14,
      refinementStrategy: options.refinementStrategy ?? 'best-available', // Default: load parent tiles as fallback
      enablePrefetch: options.enablePrefetch ?? true, // Enable by default
      prefetchAhead: options.prefetchAhead ?? 10000, // 10 seconds ahead default
      prefetchSteps: options.prefetchSteps ?? 3, // 3 steps ahead
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
    this.isAnimating = isAnimating;
    this.animationSpeed = speed;
    
    // When animation starts, trigger prefetch immediately
    if (isAnimating && this.options.enablePrefetch && this.currentViewport) {
      this.prefetchFutureTiles();
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
    
    // Load tiles for each zoom level
    // Primary zoom (most detailed) is loaded first, then parent zooms as fallback
    for (const z of zoomLevels) {
      // Query archive for available tiles at this zoom level
      const availableTileIds = await this.options.getAvailableTiles(
        bounds,
        z,
        timeRange
      );
      
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
    
    // Prefetch future tiles if animation is active
    if (this.options.enablePrefetch && (this.isAnimating || Math.abs(this.animationSpeed) > 0.1)) {
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
   */
  private async prefetchFutureTiles(): Promise<void> {
    if (!this.currentViewport) return;
    
    const { bounds, zoom, time, timeWindow } = this.currentViewport;
    const { prefetchAhead, prefetchSteps } = this.options;
    
    // Determine prefetch direction based on animation speed
    const direction = this.animationSpeed >= 0 ? 1 : -1;
    
    // Calculate how far ahead to prefetch based on animation speed
    // If animating at 1000x, prefetch more aggressively
    const speedFactor = Math.max(1, Math.abs(this.animationSpeed) / 1000);
    const effectivePrefetchAhead = prefetchAhead * speedFactor;
    
    // Get zoom levels to prefetch
    const zoomLevels = this.getZoomLevelsToLoad(zoom);
    const now = Date.now();
    
    // Prefetch multiple time windows ahead
    for (let step = 1; step <= prefetchSteps; step++) {
      const futureTime = time + (direction * effectivePrefetchAhead * step);
      
      const futureTimeRange = {
        start: futureTime - timeWindow / 2,
        end: futureTime + timeWindow / 2,
      };
      
      for (const z of zoomLevels) {
        try {
          const futureTileIds = await this.options.getAvailableTiles(
            bounds,
            z,
            futureTimeRange
          );
          
          for (const tileId of futureTileIds) {
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
            } else {
              // Update last used time to prevent eviction
              header.lastUsed = now;
            }
          }
        } catch (error) {
          // Ignore prefetch errors - they're best-effort
          console.debug('[Tileset] Prefetch error:', error);
        }
      }
    }
  }
  
  /**
   * Process request queues with concurrency limit
   * Priority queue is processed first, prefetch queue uses remaining capacity
   */
  private async processRequestQueue(): Promise<void> {
    // Calculate how many more requests we can start
    const availableSlots = this.options.maxRequests - this.activeRequests.size;
    if (availableSlots <= 0) return;
    
    // Reserve slots: priority queue gets what it needs, prefetch gets the rest
    // During animation, reserve at least 4 slots for priority tiles
    const priorityReserved = this.isAnimating ? Math.min(4, availableSlots) : 0;
    
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
    // But respect the priority reservation during animation
    const prefetchSlots = availableSlots - Math.max(usedSlots, priorityReserved);
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
   */
  private startTileLoad(tileId: TileId): boolean {
    const key = this.tileIdToKey(tileId);
    
    // Skip if already loading or loaded
    const header = this.tiles.get(key);
    if (!header || header.isLoading || header.isLoaded) {
      return false;
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
    
    return true;
  }
  
  /**
   * Evict tiles not recently used (LRU)
   * More conservative eviction to support smooth animation loops
   */
  private evictUnusedTiles(neededTileKeys: Set<string>): void {
    const now = Date.now();
    const GRACE_PERIOD = 120000; // 2 minutes - allows animation loops to reuse tiles
    
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
   * Returns tiles that overlap with current time window
   */
  getVisibleTiles(): Tile[] {
    if (!this.currentViewport) {
      // No viewport set yet - return all loaded tiles
      const tiles: Tile[] = [];
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
    
    const tiles: Tile[] = [];
    
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
  getViewportTiles(): Tile[] {
    if (!this.currentViewport) return [];
    
    const { time, timeWindow } = this.currentViewport;
    const timeStart = time - timeWindow / 2;
    const timeEnd = time + timeWindow / 2;
    
    const tiles: Tile[] = [];
    
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
    // Rough estimate: count features and properties
    let size = 1000; // Base overhead
    
    if (!tile?.layers) {
      return size;
    }
    
    for (const layer of tile.layers) {
      if (!layer?.features) {
        continue;
      }
      for (const feature of layer.features) {
        if (!feature) {
          continue;
        }
        size += 100; // Per feature
        const positionCount = feature.positions?.length ?? 0;
        size += positionCount * 16; // Approximate lon/lat pairs
        if (feature.properties) {
          try {
            size += JSON.stringify(feature.properties).length; // Properties
          } catch {
            size += 100; // Fallback
          }
        }
      }
    }
    
    return size;
  }
}


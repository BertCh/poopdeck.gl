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
  
  // Request queue
  private requestQueue: TileId[] = [];
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
  
  constructor(options: SpatiotemporalTilesetOptions) {
    this.options = {
      maxRequests: options.maxRequests ?? 6,
      debounceTime: options.debounceTime ?? 300,
      maxCacheSize: options.maxCacheSize ?? 200, // Increased from 100
      maxCacheByteSize: options.maxCacheByteSize ?? 500 * 1024 * 1024, // 500MB (increased from 200MB)
      minZoom: options.minZoom ?? 0,
      maxZoom: options.maxZoom ?? 14,
      refinementStrategy: options.refinementStrategy ?? 'best-available', // Default: load parent tiles as fallback
      getAvailableTiles: options.getAvailableTiles,
      getTileData: options.getTileData,
      onTileLoad: options.onTileLoad ?? (() => {}),
      onTileUnload: options.onTileUnload ?? (() => {}),
      onTileError: options.onTileError ?? ((err) => console.error(err)),
    };
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
    this.currentViewport = viewport;
    
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
          
          // Add to request queue
          // Higher zoom (more detailed) tiles get priority
          if (z === zoom) {
            // Primary zoom - highest priority (add to front)
            this.requestQueue.unshift(tileId);
          } else {
            // Parent zoom - lower priority (add to back)
            this.requestQueue.push(tileId);
          }
        } else {
          // Update last used time
          header.lastUsed = now;
        }
      }
    }
    
    // Remove tiles not in viewport (with grace period)
    this.evictUnusedTiles(neededTileKeys);
    
    // Process request queue
    this.processRequestQueue();
    
    // Increment frame number
    this.frameNumber++;
  }
  
  /**
   * Process request queue with concurrency limit
   */
  private async processRequestQueue(): Promise<void> {
    while (
      this.requestQueue.length > 0 &&
      this.activeRequests.size < this.options.maxRequests
    ) {
      const tileId = this.requestQueue.shift()!;
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
      queuedRequests: this.requestQueue.length,
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
    this.requestQueue = [];
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


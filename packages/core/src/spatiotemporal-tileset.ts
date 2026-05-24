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
import { estimateTileSize } from './archive';

const DEBUG = false;

/**
 * Number of consecutive frames a reversed time-delta must persist before the
 * prefetch direction actually flips. Prevents a single backward scrub frame
 * from inverting the prefetch direction (direction hysteresis).
 */
const DIRECTION_FLIP_THRESHOLD = 3;

/** O(n) set equality used to decide whether the needed-tile set actually changed. */
function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const k of a) {
    if (!b.has(k)) return false;
  }
  return true;
}

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
  
  /** 
   * Temporal bucket size in milliseconds (from archive metadata).
   * When set, enables deterministic tile prefetching aligned to bucket boundaries.
   * This significantly improves cache hits and reduces loading churn.
   */
  temporalBucketMs?: number;
  
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

  // Prefetch direction hysteresis. `prefetchDirection` is the committed
  // direction (+1 forward / -1 backward); `pendingFlipCount` counts how many
  // consecutive frames pointed the opposite way.
  private prefetchDirection: 1 | -1 = 1;
  private pendingFlipCount: number = 0;

  // Running byte total of decoded tiles held in `this.tiles`. Maintained
  // incrementally so eviction never re-sums every frame.
  private currentCacheBytes: number = 0;
  
  // Separate queues for priority management
  private priorityQueue: TileId[] = []; // High priority - current time tiles
  private prefetchQueue: TileId[] = []; // Low priority - future tiles

  // Prefetch wall-clock debounce. Without this, every tick of the time
  // controller that crosses the tileset update threshold triggers a full
  // prefetchFutureTiles() pass — building thousands of getAvailableTiles
  // queries each time. We coalesce to one pass per ~250ms wall-clock.
  private static readonly PREFETCH_DEBOUNCE_MS = 250;
  private lastPrefetchAt = 0;
  private prefetchPendingTimer: ReturnType<typeof setTimeout> | null = null;
  
  // Currently needed tile keys - computed during selectAndLoadTiles()
  // This is the authoritative set of tiles that should be visible for current viewport/time
  // getVisibleTiles() just returns loaded tiles from this set - O(k) not O(n)
  private neededTileKeys: Set<string> = new Set();
  
  // Version tracking for cache invalidation
  private neededTilesVersion: number = 0;
  
  constructor(options: SpatiotemporalTilesetOptions) {
    this.options = {
      // 12 is the practical ceiling: browsers cap concurrent fetches per
      // origin (~6 HTTP/1.1, more under HTTP/2 multiplexing) and beyond that
      // we just queue inside the browser while the main-thread decode
      // backlog grows.
      maxRequests: options.maxRequests ?? 12,
      debounceTime: options.debounceTime ?? 0,
      maxCacheSize: options.maxCacheSize ?? 2000,
      maxCacheByteSize: options.maxCacheByteSize ?? 2 * 1024 * 1024 * 1024,
      minZoom: options.minZoom ?? 0,
      maxZoom: options.maxZoom ?? 14,
      temporalBucketMs: options.temporalBucketMs ?? 3600 * 1000,
      refinementStrategy: options.refinementStrategy ?? 'best-available',
      enablePrefetch: options.enablePrefetch ?? true,
      // Defaults sized for a few real-time seconds of buffer. See the
      // matching tuning notes in SpatioTemporalLayer.defaultProps.
      prefetchAhead: options.prefetchAhead ?? 30000,
      prefetchSteps: options.prefetchSteps ?? 4,
      getAvailableTiles: options.getAvailableTiles,
      getTileData: options.getTileData,
      onTileLoad: options.onTileLoad ?? (() => {}),
      onTileUnload: options.onTileUnload ?? (() => {}),
      onTileError: options.onTileError ?? ((err) => console.error(err)),
    };
  }
  
  /**
   * Update the committed prefetch direction with hysteresis.
   *
   * A single frame whose time delta points opposite to the committed direction
   * does NOT flip prefetch — the opposite sign must persist for
   * {@link DIRECTION_FLIP_THRESHOLD} consecutive frames. This stops a stray
   * backward scrub frame from inverting (and invalidating) the prefetch queue.
   */
  private updatePrefetchDirection(simTimeDelta: number): void {
    if (simTimeDelta === 0) return; // No movement: keep current direction.

    const observed: 1 | -1 = simTimeDelta > 0 ? 1 : -1;
    if (observed === this.prefetchDirection) {
      this.pendingFlipCount = 0;
      return;
    }

    this.pendingFlipCount++;
    if (this.pendingFlipCount >= DIRECTION_FLIP_THRESHOLD) {
      this.prefetchDirection = observed;
      this.pendingFlipCount = 0;
    }
  }

  /** Current committed prefetch direction (+1 forward, -1 backward). */
  getPrefetchDirection(): 1 | -1 {
    return this.prefetchDirection;
  }

  /** Most recent estimated animation speed (sim-ms per real-ms). */
  getAnimationSpeed(): number {
    return this.animationSpeed;
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
        // When animation starts, schedule prefetch (debounced). This used to
        // call prefetchFutureTiles() directly, which combined with the
        // selectAndLoadTiles() prefetch above produced two back-to-back fans
        // of thousands of queries.
        this.schedulePrefetch();
      } else if (!isAnimating && wasAnimating) {
        // When animation pauses, ensure tiles for current time are loaded
        // This handles the case where loading was lagging behind animation
        if (DEBUG) console.log('[Tileset] Animation paused, ensuring current time tiles are loaded');
        this.selectAndLoadTiles();
      }
    }
  }

  /**
   * Run prefetchFutureTiles(), but at most once per PREFETCH_DEBOUNCE_MS of
   * wall-clock time. Coalesces the per-tick "selectAndLoadTiles → prefetch"
   * storm during fast playback into one prefetch pass per ~quarter-second.
   */
  private schedulePrefetch(): void {
    if (this.prefetchPendingTimer !== null) {
      // Already deferred; the existing timer will run a fresh prefetch.
      return;
    }
    const now = Date.now();
    const elapsed = now - this.lastPrefetchAt;
    if (elapsed >= SpatiotemporalTileset.PREFETCH_DEBOUNCE_MS) {
      this.lastPrefetchAt = now;
      this.prefetchFutureTiles();
      return;
    }
    const wait = SpatiotemporalTileset.PREFETCH_DEBOUNCE_MS - elapsed;
    this.prefetchPendingTimer = setTimeout(() => {
      this.prefetchPendingTimer = null;
      this.lastPrefetchAt = Date.now();
      this.prefetchFutureTiles();
    }, wait);
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
    if (previousTime !== undefined) {
      const simTimeDelta = viewport.time - previousTime;
      // Direction tracking only needs the SIGN of the time delta — update it
      // regardless of wall-clock spacing (consecutive updates may share a ms).
      this.updatePrefetchDirection(simTimeDelta);

      if (this.lastUpdateTime > 0) {
        const realTimeDelta = now - this.lastUpdateTime;
        if (realTimeDelta > 0 && realTimeDelta < 1000) { // Ignore large gaps
          this.animationSpeed = simTimeDelta / realTimeDelta;
        }
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

          // Cache MISS: a needed tile that must be fetched from the network.
          this.cacheStats.misses++;

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

          if (header.isLoaded) {
            // Cache HIT: already-decoded tile served straight from memory.
            this.cacheStats.hits++;
          } else {
            // Tile has a header but is not loaded yet. It may have been
            // created by prefetch (low priority) or previously cancelled.
            // Either way it is now needed at PRIORITY, so:
            //  - reset the one-way isCancelled latch so it can load again,
            //  - promote it out of the prefetch queue into the priority queue.
            header.isCancelled = false;

            if (!header.isLoading) {
              const inPriority = this.priorityQueue.some(
                (qid) => this.tileIdToKey(qid) === key
              );
              if (!inPriority) {
                // Remove from the low-priority prefetch queue if present.
                const pfIdx = this.prefetchQueue.findIndex(
                  (qid) => this.tileIdToKey(qid) === key
                );
                if (pfIdx !== -1) {
                  this.prefetchQueue.splice(pfIdx, 1);
                }
                // Enqueue at priority (front for primary zoom).
                if (z === zoom) {
                  this.priorityQueue.unshift(tileId);
                } else {
                  this.priorityQueue.push(tileId);
                }
              }
            }
          }
        }
      }
    }
    
    // Compare against the previous needed set BEFORE overwriting it. The
    // frameNumber is the cache key consumers (AnimatedTripsLayer etc.) use
    // to decide whether to re-consolidate hundreds of MB of vertex data, so
    // bumping it on every selectAndLoadTiles() call — which fires every
    // React render of the demo at 60Hz — defeats the whole memoization
    // architecture and rebuilds the trip consolidation every frame.
    const neededChanged = !setsEqual(this.neededTileKeys, neededTileKeys);

    // Store the needed tile keys for getVisibleTiles()
    // This is the authoritative set - no searching needed later
    this.neededTileKeys = neededTileKeys;
    if (neededChanged) {
      this.neededTilesVersion++;
    }

    // Cancel in-flight requests for tiles that are no longer needed
    // This frees up bandwidth for current tiles
    this.cancelSupersededRequests(neededTileKeys);

    // Prefetch when enabled, but debounced to once per PREFETCH_DEBOUNCE_MS
    // of wall-clock — see schedulePrefetch().
    if (this.options.enablePrefetch) {
      this.schedulePrefetch();
    }

    // Remove tiles not in viewport (with grace period)
    this.evictUnusedTiles(neededTileKeys);

    // Process request queues - priority first, then prefetch
    this.processRequestQueue();

    // Bump frameNumber only when the needed-tile set actually changed.
    // Tile-load completions in startTileLoad() bump it separately, so a
    // newly-arrived tile still wakes the consumer's render path.
    if (neededChanged) {
      this.frameNumber++;
    }
  }
  
  /**
   * Prefetch tiles ahead of current animation time
   * This ensures smooth playback by loading tiles before they're needed
   * 
   * OPTIMIZATION: Uses deterministic bucket-aligned prefetching when temporalBucketMs is set.
   * Instead of arbitrary future times, we prefetch at exact bucket boundaries.
   * This ensures:
   * - Predictable tile IDs (better cache hits)
   * - Fewer unique queries (buckets are shared across time windows)
   * - Reduced loading churn during animation
   */
  private async prefetchFutureTiles(): Promise<void> {
    if (!this.currentViewport) return;
    
    const { bounds, zoom, time, timeWindow } = this.currentViewport;
    const { prefetchAhead, prefetchSteps } = this.options;
    
    // Use the hysteresis-smoothed committed prefetch direction. A single
    // backward scrub frame will not flip this (see updatePrefetchDirection).
    const direction = this.prefetchDirection;
    
    // Get zoom levels to prefetch
    const zoomLevels = this.getZoomLevelsToLoad(zoom);
    const now = Date.now();
    
    // Calculate the time range we need to prefetch
    // prefetchAhead is in simulation time units
    const effectivePrefetchAhead = prefetchAhead > 0 ? prefetchAhead : timeWindow;
    const prefetchEndTime = time + (direction * effectivePrefetchAhead * prefetchSteps);
    
    // One query per zoom level covering the whole prefetch range. The previous
    // implementation enumerated every bucket boundary in [startTime, endTime]
    // and issued one getAvailableTiles() call per (bucket × zoom). For datasets
    // with large prefetch ranges and small temporal buckets (e.g. earthquakes:
    // 76 days × 4 steps lookahead, 1-hour buckets → 8192 queries), the loop
    // dominated the main thread — ~215 ms per pass × 4 passes/sec, collapsing
    // FPS to single digits. The collapsed query returns the SAME tile IDs
    // (getAvailableTiles already filters by interval overlap), just in O(zoomLevels)
    // queries instead of O(buckets × zoomLevels).
    const startTime = direction > 0 ? time : prefetchEndTime;
    const endTime = direction > 0 ? prefetchEndTime : time;
    const fullRange = {
      start: startTime - timeWindow / 2,
      end: endTime + timeWindow / 2,
    };

    if (DEBUG) console.log('[Tileset] Wide-range prefetch:', {
      time: new Date(time).toISOString(),
      zoomLevels,
      fullRangeStart: new Date(fullRange.start).toISOString(),
      fullRangeEnd: new Date(fullRange.end).toISOString(),
    });

    const results = await Promise.allSettled(
      zoomLevels.map(async (z) => {
        const tileIds = await this.options.getAvailableTiles(bounds, z, fullRange);
        return { zoom: z, tileIds };
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
   * Process request queues with concurrency limit.
   *
   * Priority (current-time) tiles always get first call on the available
   * slots. Prefetch is capped to half of maxRequests (animating) or a third
   * when paused — both substantially below the old 75 % / 50 % share. The
   * priority queue can drain into prefetch's reserved slots, but prefetch
   * never starves priority: if the priority queue is non-empty after this
   * pass, no prefetch starts at all.
   */
  private async processRequestQueue(): Promise<void> {
    const availableSlots = this.options.maxRequests - this.activeRequests.size;
    if (DEBUG && (this.priorityQueue.length > 0 || this.prefetchQueue.length > 0)) {
      console.log('[Tileset] processRequestQueue:', {
        availableSlots,
        activeRequests: this.activeRequests.size,
        priorityQueue: this.priorityQueue.length,
        prefetchQueue: this.prefetchQueue.length,
      });
    }
    if (availableSlots <= 0) return;

    let usedSlots = 0;

    // Drain HIGH PRIORITY queue first — current viewport tiles always come
    // before any prefetch work.
    while (this.priorityQueue.length > 0 && usedSlots < availableSlots) {
      const tileId = this.priorityQueue.shift()!;
      if (this.startTileLoad(tileId)) {
        usedSlots++;
      }
    }

    // If priority is still backed up after we used every slot, do not start
    // prefetch on this pass — let the next finally-handler retry.
    if (this.priorityQueue.length > 0) return;

    const remainingSlots = availableSlots - usedSlots;
    // Animation phase tolerates more prefetch (smoothing the play head);
    // paused phase keeps a tight cap so a stale prefetch queue can't tie up
    // bandwidth when the user starts panning again.
    const prefetchShare = this.isAnimating ? 0.5 : 0.33;
    const prefetchCap = Math.max(
      1,
      Math.floor(this.options.maxRequests * prefetchShare),
    );
    const prefetchSlots = Math.min(remainingSlots, prefetchCap);
    let prefetchUsed = 0;

    while (this.prefetchQueue.length > 0 && prefetchUsed < prefetchSlots) {
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

    // Skip if already loading, loaded, or cancelled.
    // The isCancelled latch is reset in selectAndLoadTiles() when a tile is
    // re-needed, so a cancelled-then-re-needed tile CAN load again.
    const header = this.tiles.get(key);
    if (!header || header.isLoading || header.isLoaded || header.isCancelled) {
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
          header.byteSize = estimateTileSize(tile);
          // Incremental byte accounting — never re-summed every frame.
          this.currentCacheBytes += header.byteSize;

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

    // Loaded-tile count is derived from the map; byte total is the incrementally
    // maintained running counter (no per-frame re-sum).
    let loadedCount = 0;
    for (const [, header] of this.tiles) {
      if (header.isLoaded && header.tile) loadedCount++;
    }
    let cacheBytes = this.currentCacheBytes;

    // Only evict if we're over limits
    const overSizeLimit = loadedCount > this.options.maxCacheSize;
    const overByteLimit = cacheBytes > this.options.maxCacheByteSize;

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
      const stillOverSize = loadedCount > this.options.maxCacheSize;
      const stillOverBytes = cacheBytes > this.options.maxCacheByteSize;

      if (!stillOverSize && !stillOverBytes) {
        break; // We're under limits now, stop evicting
      }

      tilesToEvict.push(tileKey);
      loadedCount--;
      cacheBytes -= header.byteSize;
    }

    this.evictTiles(tilesToEvict);
  }

  /**
   * Actually evict tiles from cache. Keeps the running byte counter accurate.
   */
  private evictTiles(tileKeys: string[]): void {
    for (const tileKey of tileKeys) {
      const header = this.tiles.get(tileKey);
      if (header) {
        if (header.tile) {
          this.options.onTileUnload?.(header.tile);
          // Incrementally decrement the running byte total.
          this.currentCacheBytes -= header.byteSize;
        }
        this.tiles.delete(tileKey);
        this.cacheStats.evictions++;
      }
    }
  }
  
  /**
   * Get visible tiles for rendering.
   *
   * With `refinementStrategy: 'best-available'` we also load parent tiles
   * one and two zooms below the requested zoom, so the viewport has
   * SOMETHING to show while the detailed tiles stream in. Once the detailed
   * tiles arrive the parents become redundant — but they still appear in
   * `neededTileKeys` and would otherwise get consolidated into the same
   * draw call, which on a high-density dataset (e.g. ship-traffic ~1.29 M
   * points) tripled the per-rebuild work and produced 2–3 s consolidation
   * stalls during playback.
   *
   * Here we de-dupe: emit every loaded tile at the highest zoom present in
   * the needed set, then for each loaded lower-zoom parent only emit it if
   * at least one of its primary-zoom children is missing (i.e. it's still
   * earning its keep as a fallback).
   *
   * O(k) overall, where k = neededTileKeys.size — the inner cover-check is
   * 4^(maxZoomDiff) which in practice is 16 (zDiff ≤ 2).
   */
  getVisibleTiles(): Tile[] {
    if (this.neededTileKeys.size === 0) return [];

    // Find the primary (highest) zoom level that has a loaded tile.
    let primaryZoom = -1;
    for (const key of this.neededTileKeys) {
      const header = this.tiles.get(key);
      if (!header?.isLoaded) continue;
      if (header.id.z > primaryZoom) primaryZoom = header.id.z;
    }
    if (primaryZoom < 0) return []; // Nothing loaded yet.

    const tiles: Tile[] = [];
    // Cover set at primary zoom: "x/y/t" of loaded primary tiles.
    const primaryCover = new Set<string>();

    for (const key of this.neededTileKeys) {
      const header = this.tiles.get(key);
      if (!header?.isLoaded || !header.tile) continue;
      if (header.id.z === primaryZoom) {
        tiles.push(header.tile);
        primaryCover.add(`${header.id.x}/${header.id.y}/${header.id.t}`);
      }
    }

    // Pass 2: keep a parent only if at least one of its child cells at the
    // primary zoom is uncovered. This avoids paying the parent's
    // consolidation cost once the children have finished streaming, while
    // still preserving the "show coarse data until detail arrives" promise.
    for (const key of this.neededTileKeys) {
      const header = this.tiles.get(key);
      if (!header?.isLoaded || !header.tile) continue;
      if (header.id.z === primaryZoom) continue;
      const { z, x, y, t } = header.id;
      const zDiff = primaryZoom - z;
      // Defensive: tiles at zooms ABOVE the primary should not appear, but
      // if they do, fall through to include them.
      if (zDiff <= 0) {
        tiles.push(header.tile);
        continue;
      }
      const range = 1 << zDiff;
      const baseX = x << zDiff;
      const baseY = y << zDiff;
      let needed = false;
      for (let dy = 0; dy < range && !needed; dy++) {
        for (let dx = 0; dx < range; dx++) {
          if (!primaryCover.has(`${baseX + dx}/${baseY + dy}/${t}`)) {
            needed = true;
            break;
          }
        }
      }
      if (needed) tiles.push(header.tile);
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
   * Get cache statistics.
   *
   * `hits` and `misses` reflect genuine cache behaviour: a hit is a needed tile
   * already decoded in memory, a miss is a needed tile that required a fetch.
   */
  getCacheStats() {
    const total = this.cacheStats.hits + this.cacheStats.misses;
    return {
      ...this.cacheStats,
      tileCount: this.tiles.size,
      cacheBytes: this.currentCacheBytes,
      hitRate: total > 0 ? this.cacheStats.hits / total : 0,
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
    this.currentCacheBytes = 0;
  }
  
  /**
   * Finalize and cleanup
   */
  finalize(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    if (this.prefetchPendingTimer !== null) {
      clearTimeout(this.prefetchPendingTimer);
      this.prefetchPendingTimer = null;
    }
    this.clear();
  }
  
  // Helper methods
  
  private tileIdToKey(id: TileId): string {
    return `${id.z}/${id.x}/${id.y}/${id.t}`;
  }
  
  // Tile-size estimation lives in archive.ts (estimateTileSize) so the archive
  // and the tileset share one complete, consistent accounting implementation.
}


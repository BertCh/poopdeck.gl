// @stt/core
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/core contributors

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

/**
 * Safety cap on how many priority tiles go into a single coalesced batch. The
 * coalescer collapses byte-adjacent tiles into a handful of range requests, so
 * sending the whole viewport×window working set in ONE batch is what removes
 * the old ⌈N / maxRequests⌉ serial-batch floor. This cap only bounds abort
 * granularity and array sizes for a pathologically large working set; the
 * archive separately bounds in-flight HTTP requests (`maxConcurrentRequests`).
 */
const MAX_COALESCE_BATCH = 1024;

/**
 * How far ahead to prefetch during animation, expressed in REAL playback time
 * (ms). Converted to sim-time via the measured animation speed, so a fast scrub
 * (e.g. 43 years in 60 s) prefetches a large *contiguous* span of buckets that
 * coalesces into a few range requests — instead of the old fixed 30 sim-second
 * lookahead, which a fast animation outruns every frame (→ a request per frame).
 */
const PREFETCH_LOOKAHEAD_REAL_MS = 8000;
/**
 * Re-issue the wide prefetch only after the play head has consumed this fraction
 * of the previously prefetched span. Keeps the debounced scheduler from
 * re-coalescing the same chunk ~4×/second; the wide load then happens roughly
 * once per `(1 - fraction) × LOOKAHEAD` of real time.
 */
const PREFETCH_RELOAD_FRACTION = 0.5;

/**
 * Fraction of the tile-count cache budget the forward prefetch runway may
 * occupy in a single pass.
 *
 * The steady-state "thousands of tiny requests" failure is a cache THRASH, not
 * a data problem: the lookahead is sized in SIM-TIME (speed × LOOKAHEAD), so a
 * fast playback (drifters: ~43 yr in 60 s ⇒ ~14.6 years / ~760 weekly buckets
 * ahead) enqueues far more tiles than the LRU holds. They are evicted before
 * the play head arrives, and the priority path then re-fetches each one
 * individually — and because the leading-edge bucket of each spatial cell is
 * byte-scattered from its neighbours, those re-fetches don't coalesce, so they
 * land as a flood of tiny single-tile requests.
 *
 * Capping the prefetch working set to a fraction of the cache keeps the runway
 * RESIDENT, so the play head hits cache instead of re-fetching. Paired with
 * temporal ordering (nearest upcoming bucket first), a finite budget always
 * covers the IMMINENT future rather than a spatially-arbitrary slice of a
 * multi-year span.
 */
const PREFETCH_CACHE_FRACTION = 0.5;

/**
 * Default byte ceiling for PARENT-fallback tiles. Above this, a coarse
 * lower-zoom placeholder tile is skipped rather than fetched.
 *
 * Dense datasets produce enormous low-zoom tiles — a single z10 Manhattan cell
 * over a 1-hour bucket measures 10–20 MB (taxi). Under a z14 / 20-second view
 * the `best-available` strategy would still pull z10–z11 as fallback, spending
 * 14 MB to placeholder a street view it discards the instant the z14 detail
 * arrives. 2 MB keeps cheap fallback (z12/z13) while dropping the giants. The
 * primary display zoom is NEVER subject to this — we always load what we draw.
 */
const DEFAULT_MAX_PARENT_TILE_BYTES = 2 * 1024 * 1024;

/** O(n) set equality used to decide whether the needed-tile set actually changed. */
function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const k of a) {
    if (!b.has(k)) return false;
  }
  return true;
}

/**
 * Tile-tier dispatch mode for archives that carry a server-aggregated
 * summary tier alongside their raw tiles.
 *
 * - `raw`     — always fetch raw tiles, ignoring any summary tier.
 * - `summary` — always fetch summary tiles. Returns no tiles for archives
 *               with no summary tier.
 * - `auto`    — fetch summary tiles when the current zoom is inside the
 *               archive's `summaryTier.[minZoom..=maxZoom]` range, raw
 *               tiles otherwise. The default.
 */
export type TileTier = 'raw' | 'summary' | 'auto';

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

  /**
   * Tile-tier dispatch mode. Defaults to `'auto'`. See {@link TileTier}.
   * When set to `'auto'`, the tileset asks `getAvailableTilesForTier` (if
   * provided) for summary tile IDs at zooms inside the summary range and
   * raw tile IDs elsewhere. If only `getAvailableTiles` is provided, the
   * tier setting is informational and the tileset always uses raw tiles.
   */
  tier?: TileTier;

  /**
   * Inclusive zoom range covered by the archive's summary tier. When set,
   * `'auto'` tier dispatches to summary inside this range and raw outside.
   * Ignored when `tier !== 'auto'`.
   */
  summaryZoomRange?: { minZoom: number; maxZoom: number };

  /** Callback to get available raw tiles for bounds/time. */
  getAvailableTiles: (
    bounds: BoundingBox,
    zoom: number,
    timeRange: { start: number; end: number }
  ) => Promise<TileId[]>;

  /**
   * Optional callback to get available SUMMARY tiles for bounds/time. When
   * unset, `tier: 'summary'` and `tier: 'auto'` (inside the summary range)
   * both behave as `tier: 'raw'`. Pass `STTArchive.getSummaryTileIdsInBounds`
   * here when wiring a tileset against an archive with a summary tier.
   */
  getAvailableSummaryTiles?: (
    bounds: BoundingBox,
    zoom: number,
    timeRange: { start: number; end: number }
  ) => Promise<TileId[]>;

  /** Callback to fetch tile data (with optional abort signal for cancellation) */
  getTileData: (tileId: TileId, signal?: AbortSignal) => Promise<Tile | null>;

  /**
   * Optional batched fetch. When provided, each processRequestQueue pass
   * sends the tiles it would otherwise fetch one-by-one as a SINGLE call,
   * letting the archive coalesce their (Hilbert-adjacent, hence usually
   * byte-adjacent) ranges into a handful of HTTP Range requests instead of
   * one per tile. Wire `STTArchive.getTiles` here. The per-tile `getTileData`
   * path is retained for single-tile loads and as the fallback. Returns
   * tiles in the same order as the input ids; missing tiles are `null`.
   */
  getTileDataBatch?: (
    tileIds: TileId[],
    signal?: AbortSignal
  ) => Promise<(Tile | null)[]>;

  /**
   * Optional SYNCHRONOUS lookup of a tile's compressed byte size from the
   * archive directory (wire `STTArchive.getTileByteSize`). When provided, the
   * tileset skips PARENT-fallback tiles larger than {@link maxParentTileBytes}
   * — a giant low-zoom tile (e.g. a 14 MB z10 Manhattan tile) is a near-useless
   * coarse placeholder under a deep-zoom view and costs far more to fetch +
   * decode than the detail tiles it stands in for. The PRIMARY display zoom is
   * never skipped. Returns `undefined` for unknown tiles (then never skipped).
   */
  getTileByteSize?: (tileId: TileId) => number | undefined;

  /**
   * Byte ceiling above which a PARENT-fallback tile is skipped (requires
   * {@link getTileByteSize}). Defaults to {@link DEFAULT_MAX_PARENT_TILE_BYTES}.
   */
  maxParentTileBytes?: number;

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
  /** End of the last prefetched span in sim-time (throttle runway anchor). */
  private lastPrefetchEndTime?: number;

  // Running byte total of decoded tiles held in `this.tiles`. Maintained
  // incrementally so eviction never re-sums every frame.
  private currentCacheBytes: number = 0;

  // Running loaded-tile count. Same rationale as `currentCacheBytes`: the
  // eviction path used to walk every header in `this.tiles` just to count
  // loaded entries (per call). At a few thousand tiles this was the
  // visible cost of the eviction loop.
  private loadedTileCount: number = 0;

  // Last `selectAndLoadTiles` parameters. When `update()` arrives with
  // identical (bounds, zoom, timeStart, timeEnd) we skip the awaited
  // `getAvailableTiles` Promise.all entirely — the result would just
  // re-mark the same `neededTileKeys` set we already published. This
  // dominates the steady-state cost for tightly-throttled time ticks.
  private lastSelectKey: string = '';
  
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
      // Concurrency budget for the single-tile / prefetch paths. The COALESCED
      // priority path no longer caps its batch by this (it sends the whole
      // viewport×window working set in one globally-coalesced request and lets
      // the archive bound in-flight HTTP requests internally), so this is now
      // only the per-tile + prefetch fan-out ceiling. 24 keeps us under an
      // object store's per-connection stream cap (R2 ~75) with HTTP/2/3
      // multiplexing.
      maxRequests: options.maxRequests ?? 24,
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
      tier: options.tier ?? 'auto',
      summaryZoomRange: options.summaryZoomRange ?? null,
      getAvailableTiles: options.getAvailableTiles,
      getAvailableSummaryTiles: options.getAvailableSummaryTiles ?? null,
      getTileData: options.getTileData,
      getTileDataBatch: options.getTileDataBatch ?? null,
      getTileByteSize: options.getTileByteSize ?? null,
      maxParentTileBytes: options.maxParentTileBytes ?? DEFAULT_MAX_PARENT_TILE_BYTES,
      onTileLoad: options.onTileLoad ?? (() => {}),
      onTileUnload: options.onTileUnload ?? (() => {}),
      onTileError: options.onTileError ?? ((err) => console.error(err)),
    } as Required<SpatiotemporalTilesetOptions>;
  }

  /**
   * Decide which tile-tier callback to use for a given zoom. Encapsulates the
   * `tier: 'auto' | 'summary' | 'raw'` policy so `selectAndLoadTiles` and
   * `prefetchFutureTiles` agree.
   *
   * Returns `'summary'` when the configured tier IS summary OR when tier is
   * `'auto'` and `zoom` falls inside `summaryZoomRange`. Falls back to
   * `'raw'` whenever no summary callback was provided (so the tier setting
   * never breaks an archive without a summary tier).
   */
  private pickTierForZoom(zoom: number): 'raw' | 'summary' {
    const { tier, summaryZoomRange, getAvailableSummaryTiles } = this.options;
    if (!getAvailableSummaryTiles) return 'raw';
    if (tier === 'raw') return 'raw';
    if (tier === 'summary') return 'summary';
    // 'auto': use summary when in range, raw otherwise.
    if (!summaryZoomRange) return 'raw';
    if (zoom >= summaryZoomRange.minZoom && zoom <= summaryZoomRange.maxZoom) {
      return 'summary';
    }
    return 'raw';
  }

  /**
   * One unified "available tiles" call that respects the active tier. Used
   * by both `selectAndLoadTiles` and `prefetchFutureTiles`.
   */
  private async fetchAvailableTilesForZoom(
    bounds: BoundingBox,
    zoom: number,
    timeRange: { start: number; end: number },
  ): Promise<TileId[]> {
    const tier = this.pickTierForZoom(zoom);
    if (tier === 'summary' && this.options.getAvailableSummaryTiles) {
      return this.options.getAvailableSummaryTiles(bounds, zoom, timeRange);
    }
    return this.options.getAvailableTiles(bounds, zoom, timeRange);
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
      // Direction reversed: the prefetched span is now behind the play head, so
      // force the next prefetch to re-issue immediately (don't throttle).
      this.lastPrefetchEndTime = undefined;
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
   * This follows deck.gl TileLayer patterns for LOD (Level of Detail). The
   * parent fallback list is large enough to bridge archives built with
   * sparse-tile skipping (`stt-build --min-features-per-tile > 1`), where
   * deep-zoom tiles in low-density regions are intentionally omitted and the
   * renderer must walk further back to find a covering ancestor.
   */
  private getZoomLevelsToLoad(requestedZoom: number): number[] {
    const { refinementStrategy, minZoom, maxZoom } = this.options;

    // Clamp requested zoom to available range
    const clampedZoom = Math.max(minZoom, Math.min(maxZoom, requestedZoom));

    if (refinementStrategy === 'no-overlap') {
      // Only load the exact zoom level
      return [clampedZoom];
    }

    // 'best-available': primary zoom + up to PARENT_FALLBACK_LEVELS parents.
    // 4 levels covers the common case for sparse global point datasets:
    // a feature isolated within ~150 km at z=10 typically clusters into a
    // 2+ feature tile by z=6 (300 km/cell). Higher numbers don't add load
    // pressure (each lower zoom has 4x fewer cells) but they DO grow the
    // O(4^zDiff) ancestor-cover check in getVisibleTiles, so we cap.
    const PARENT_FALLBACK_LEVELS = 4;
    const zoomLevels: number[] = [clampedZoom];
    for (let i = 1; i <= PARENT_FALLBACK_LEVELS; i++) {
      const z = clampedZoom - i;
      if (z < minZoom) break;
      zoomLevels.push(z);
    }

    return zoomLevels;
  }
  
  /**
   * Whether a tile is an OVERSIZED parent-fallback tile that should be skipped.
   *
   * Parent tiles (zoom below the primary display zoom) are coarse placeholders
   * shown while detail streams in. A giant one — e.g. a 14 MB z10 tile under a
   * z14 view — costs far more to fetch + decode than the detail tiles it stands
   * in for and is discarded the moment they arrive, so loading it is pure waste.
   * The primary display zoom is NEVER skipped (we always load what we draw), and
   * skipping is inert unless a `getTileByteSize` lookup is wired.
   */
  private isOversizedParent(tileId: TileId, primaryZoom: number): boolean {
    if (tileId.z >= primaryZoom) return false; // primary (or deeper) — always load
    const getSize = this.options.getTileByteSize;
    if (!getSize) return false;
    const bytes = getSize(tileId);
    return bytes !== undefined && bytes > this.options.maxParentTileBytes;
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

    // Cheap fast-path: when the (bounds, zoom, time-range) signature is
    // identical to the previous call we'd just rebuild the same
    // `neededTileKeys` set and recompute equality. Skip the awaited
    // `getAvailableTiles` chain entirely. Running on a TimeController
    // tick that hasn't crossed a bucket boundary, this is the common
    // case and the await round-trip is the dominant cost.
    const selectKey =
      `${bounds.minLon}|${bounds.minLat}|${bounds.maxLon}|${bounds.maxLat}` +
      `|${zoom}|${timeRange.start}|${timeRange.end}`;
    if (selectKey === this.lastSelectKey) {
      return;
    }
    this.lastSelectKey = selectKey;

    // Get zoom levels to load (supports LOD with parent tiles). The first
    // entry is the primary (clamped display) zoom; the rest are coarser parents.
    const zoomLevels = this.getZoomLevelsToLoad(zoom);
    const primaryZoom = zoomLevels[0];

    // Mark tiles as used (for LRU)
    const now = Date.now();
    const neededTileKeys = new Set<string>();
    
    // Query available tiles for ALL zoom levels IN PARALLEL
    // This is much faster than sequential queries, especially for initial load.
    // Dispatches between raw and summary tiers per zoom based on the
    // configured tier setting (see pickTierForZoom).
    const tileIdsByZoom = await Promise.all(
      zoomLevels.map(async (z) => ({
        zoom: z,
        tileIds: await this.fetchAvailableTilesForZoom(bounds, z, timeRange),
      }))
    );
    
    // Process results - primary zoom first for proper queue ordering
    for (const { zoom: z, tileIds: availableTileIds } of tileIdsByZoom) {
      for (const tileId of availableTileIds) {
        // Skip giant low-zoom parent-fallback tiles — coarse placeholders not
        // worth a multi-MB fetch under a deep-zoom view. Never skips the primary.
        if (this.isOversizedParent(tileId, primaryZoom)) continue;

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
    const primaryZoom = zoomLevels[0];
    const now = Date.now();
    
    // How far ahead to prefetch, in SIM time. During a running animation, cover
    // a fixed slice of REAL playback time (speed × LOOKAHEAD) so a fast scrub
    // prefetches one big contiguous chunk that coalesces into a few range
    // requests. Fall back to the configured window-based lookahead when paused
    // (speed ≈ 0) so a stationary view still warms its immediate neighbourhood.
    const speed = Math.abs(this.animationSpeed); // sim-ms per real-ms
    const windowAhead = (prefetchAhead > 0 ? prefetchAhead : timeWindow) * prefetchSteps;
    const effectiveAhead = Math.max(windowAhead, speed * PREFETCH_LOOKAHEAD_REAL_MS);
    const prefetchEndTime = time + direction * effectiveAhead;

    // Throttle on the remaining prefetched "runway": skip the wide load while the
    // play head still has more than (1 − fraction) × lookahead of already-
    // prefetched span ahead of it. This re-issues when the head has consumed
    // ~half the span, AND whenever the span GROWS (e.g. the animation speeds up,
    // making the previous end-time fall short) — the earlier start-time-anchored
    // throttle wrongly suppressed that case, leaving playback to drip per-frame.
    if (this.lastPrefetchEndTime !== undefined) {
      const runway = direction * (this.lastPrefetchEndTime - time);
      if (runway > effectiveAhead * (1 - PREFETCH_RELOAD_FRACTION)) {
        return;
      }
    }
    this.lastPrefetchEndTime = prefetchEndTime;
    
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
        const tileIds = await this.fetchAvailableTilesForZoom(bounds, z, fullRange);
        return { zoom: z, tileIds };
      })
    );
    
    // Flatten the candidate tiles across all zoom levels into one list.
    const candidates: TileId[] = [];
    for (const result of results) {
      if (result.status === 'rejected') {
        // Ignore prefetch errors - they're best-effort
        console.debug('[Tileset] Prefetch error:', result.reason);
        continue;
      }
      for (const tileId of result.value.tileIds) candidates.push(tileId);
    }
    const totalTilesFound = candidates.length;

    // Order candidates by temporal distance from the play head IN THE PLAYBACK
    // DIRECTION, so the buckets the head reaches SOONEST are enqueued first.
    // Tiles already behind the head (wrong side) sort to the very end. Without
    // this, the budget below would enqueue a spatially-arbitrary slice of a
    // multi-year span instead of the next few seconds of playback.
    const aheadDist = (id: TileId): number => {
      const d = direction > 0 ? id.t - time : time - id.t;
      return d >= 0 ? d : Number.MAX_SAFE_INTEGER + d; // behind-head tiles last
    };
    candidates.sort((a, b) => aheadDist(a) - aheadDist(b));

    // Bound the prefetch runway to a fraction of the cache (see
    // PREFETCH_CACHE_FRACTION) so it can never overflow the LRU and thrash.
    // Nearest-first ordering means this budget always buys the most imminent
    // buckets; the runway then slides forward as the head consumes it.
    const prefetchBudget = Math.max(
      64,
      Math.floor(this.options.maxCacheSize * PREFETCH_CACHE_FRACTION),
    );

    let newTilesAdded = 0;
    for (const tileId of candidates) {
      if (newTilesAdded >= prefetchBudget) break;
      // Don't prefetch giant low-zoom parent placeholders either (see
      // isOversizedParent); they'd evict the runway they're meant to warm.
      if (this.isOversizedParent(tileId, primaryZoom)) continue;
      const key = this.tileIdToKey(tileId);
      const header = this.tiles.get(key);

      if (!header) {
        // Create header for prefetch tile and add to the LOW PRIORITY queue.
        // These only load when the priority queue has capacity.
        this.tiles.set(key, {
          id: tileId,
          tile: null,
          isLoaded: false,
          isLoading: false,
          isCancelled: false,
          lastUsed: now,
          byteSize: 0,
        });
        this.prefetchQueue.push(tileId);
        newTilesAdded++;
      } else {
        // Update last used time to prevent eviction
        header.lastUsed = now;
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
    // before any prefetch work. When a batched fetch is available, send this
    // pass's tiles as one coalesced request (Hilbert-adjacent tiles collapse
    // into a few byte ranges) instead of one fetch per tile.
    const batchFn = this.options.getTileDataBatch;
    if (!batchFn || this.priorityQueue.length <= 1) {
      while (this.priorityQueue.length > 0 && usedSlots < availableSlots) {
        const tileId = this.priorityQueue.shift()!;
        if (this.startTileLoad(tileId)) {
          usedSlots++;
        }
      }
    } else {
      // Coalesced path: send the WHOLE current priority working set in one
      // batch (capped only for safety) instead of slicing it into
      // ⌈N / availableSlots⌉ serial batches. The archive coalesces byte-
      // adjacent tiles into a few range requests and bounds in-flight HTTP
      // requests itself, so one big batch collapses a viewport×window into a
      // handful of parallel requests rather than a serial fan of 12-tile
      // chunks.
      const candidates: TileId[] = [];
      while (this.priorityQueue.length > 0 && candidates.length < MAX_COALESCE_BATCH) {
        candidates.push(this.priorityQueue.shift()!);
      }
      usedSlots += this.startTileBatch(candidates);
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
    if (prefetchSlots <= 0) return; // priority work is saturating the connection

    if (!batchFn || this.prefetchQueue.length <= 1) {
      // Per-tile fallback: `prefetchSlots` bounds in-flight single fetches.
      let prefetchUsed = 0;
      while (this.prefetchQueue.length > 0 && prefetchUsed < prefetchSlots) {
        const tileId = this.prefetchQueue.shift()!;
        if (this.startTileLoad(tileId)) {
          prefetchUsed++;
        }
      }
    } else {
      // Coalesced prefetch: take a LARGE chunk (same cap as the priority path)
      // so a big prefetch queue collapses into a few range requests. Draining
      // `prefetchSlots` (≈3) tiles per pass instead fired ~one tiny request per
      // 3 tiles — hundreds of requests for a wide-window animation like the
      // drifters globe. The archive bounds actual in-flight HTTP requests
      // (`maxConcurrentRequests`), so batch size no longer needs throttling here.
      const candidates: TileId[] = [];
      while (this.prefetchQueue.length > 0 && candidates.length < MAX_COALESCE_BATCH) {
        candidates.push(this.prefetchQueue.shift()!);
      }
      this.startTileBatch(candidates);
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
          // Incremental accounting — never re-summed every frame.
          this.currentCacheBytes += header.byteSize;
          this.loadedTileCount++;

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
   * Start loading a batch of tiles in ONE coalesced fetch.
   *
   * Mirrors `startTileLoad`'s per-tile state machine (isLoading / activeRequests
   * / onTileLoad / byte accounting) but issues a single `getTileDataBatch` call
   * so the archive can collapse the tiles' Hilbert-adjacent byte ranges into a
   * few HTTP Range requests. Candidates that aren't loadable (already loading /
   * loaded / cancelled / unknown) are skipped exactly as `startTileLoad` would.
   *
   * Cancellation is at BATCH granularity: all tiles in one batch share an
   * AbortController. This is the deliberate trade-off the audit called for —
   * the bulk viewport fill rides the coalescer; per-tile cancellation precision
   * is retained on the single-tile `startTileLoad` path.
   *
   * Returns the number of tiles actually started.
   */
  private startTileBatch(tileIds: TileId[]): number {
    const batchFn = this.options.getTileDataBatch;
    if (!batchFn) return 0;

    // Filter to loadable tiles, marking each as loading under ONE shared abort.
    const abortController = new AbortController();
    const started: { id: TileId; key: string; header: SpatiotemporalTileHeader }[] = [];
    for (const tileId of tileIds) {
      const key = this.tileIdToKey(tileId);
      const header = this.tiles.get(key);
      if (!header || header.isLoading || header.isLoaded || header.isCancelled) {
        continue;
      }
      header.isLoading = true;
      header.abortController = abortController;
      this.activeRequests.add(key);
      started.push({ id: tileId, key, header });
    }
    if (started.length === 0) return 0;

    batchFn(
      started.map((s) => s.id),
      abortController.signal,
    )
      .then((tiles) => {
        for (let i = 0; i < started.length; i++) {
          const { header } = started[i];
          const tile = tiles[i];
          if (!header.isCancelled && tile) {
            header.tile = tile;
            header.isLoaded = true;
            header.byteSize = estimateTileSize(tile);
            this.currentCacheBytes += header.byteSize;
            this.loadedTileCount++;
            this.options.onTileLoad?.(tile);
          }
        }
        this.frameNumber++;
      })
      .catch((error) => {
        if (error.name !== 'AbortError') {
          for (const { id } of started) this.options.onTileError?.(error, id);
        }
      })
      .finally(() => {
        for (const { key, header } of started) {
          header.isLoading = false;
          header.abortController = undefined;
          this.activeRequests.delete(key);
        }
        this.processRequestQueue();
      });

    return started.length;
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

    // Loaded-tile count and byte total are both maintained incrementally
    // (see `loadedTileCount` / `currentCacheBytes`). The previous version
    // walked every header to recount loaded tiles on every eviction pass —
    // visibly expensive at a few thousand cached tiles.
    let loadedCount = this.loadedTileCount;
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
   * Actually evict tiles from cache. Keeps the running byte counter +
   * loaded-tile count accurate.
   */
  private evictTiles(tileKeys: string[]): void {
    for (const tileKey of tileKeys) {
      const header = this.tiles.get(tileKey);
      if (header) {
        if (header.tile) {
          this.options.onTileUnload?.(header.tile);
          // Incrementally decrement the running counters.
          this.currentCacheBytes -= header.byteSize;
          if (header.isLoaded) this.loadedTileCount--;
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
    this.loadedTileCount = 0;
    // Force the next selectAndLoadTiles to run — the previous selection is
    // no longer authoritative once we've torn down the tile registry.
    this.lastSelectKey = '';
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


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
 * Prefetch dispatches in small time-ordered SLICES instead of one giant
 * batch — the streaming-video segment model (hls.js/Shaka fetch a few seconds
 * of media at a time, strictly in playback order). Slices are sized in BYTES
 * from the measured network throughput so one slice ≈ this many ms of
 * download. Two properties fall out:
 *
 * - The "hostage window" is bounded: a tile the play head reaches while its
 *   slice is in flight waits ≈ one slice, not an unbounded 1024-tile batch.
 * - The nearest-future tiles (the queue is drained nearest-first) land and
 *   render first; a flush (seek / pan / direction flip) wastes at most one
 *   slice of bandwidth.
 *
 * One slice is in flight at a time; its finally-handler dispatches the next,
 * so the pipeline stays busy with at most ~1 RTT of idle between slices —
 * and every slice boundary is a fresh chance for priority work to dispatch
 * first (late commitment, the Cesium RequestScheduler principle).
 */
const PREFETCH_SLICE_TARGET_REAL_MS = 1000;
/**
 * Slice-size floor: below this, coalescing degrades (byte-adjacent tiles get
 * split across slices for no scheduling benefit) and per-slice overhead
 * (planning pass + range-request RTTs) dominates on slow links.
 */
const PREFETCH_SLICE_MIN_BYTES = 1 * 1024 * 1024;
/**
 * Slice-size ceiling: bounds the memory burst and the worst-case hostage
 * window on very fast links, where TARGET_REAL_MS alone would allow huge
 * slices.
 */
const PREFETCH_SLICE_MAX_BYTES = 16 * 1024 * 1024;
/**
 * Slice size before the throughput estimator has a sample (cold start):
 * moderate, so the first slice both seeds the estimator and can't flood a
 * link that turns out to be slow.
 */
const PREFETCH_SLICE_COLD_BYTES = 4 * 1024 * 1024;
/**
 * Per-tile byte guess when the directory size lookup is unavailable
 * (`getTileByteSize` unset or the id is unknown). Turns the byte budget into
 * an effective count cap (e.g. cold 4 MiB / 64 KiB = 64 tiles).
 */
const PREFETCH_UNKNOWN_TILE_BYTES = 64 * 1024;

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
 * Real-time margin (ms) for SPEED-AWARE seek detection in `update()`: a time
 * jump is a seek only when it exceeds
 * `max(timeWindow, |animationSpeed| × this)`. Continuous playback advances
 * `speed × realDt` per update (realDt ≲ 100–250 ms in practice), so one
 * second of margin cleanly separates playback steps from genuine jumps. A
 * window-only threshold misclassified ordinary high-speed steps as seeks
 * (speed × 100 ms can exceed a whole window) and flushed the prefetch runway
 * every pass. Explicit seeks (scrub commits, story beats) don't rely on this
 * detection — the PlaybackGovernor calls `flushPrefetch()` directly.
 */
const SEEK_DETECTION_REAL_MS = 1000;

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

/**
 * Real-time lookahead (ms) used to size the DEFAULT probe horizon of
 * {@link SpatiotemporalTileset.getBufferedRunway}: the horizon covers at
 * least `|animationSpeed| × 10 s` of sim-time, i.e. ten wall-seconds of
 * playback at the current speed.
 */
const RUNWAY_HORIZON_REAL_MS = 10_000;

/** Default cap on the number of ranges returned by `getBufferedRanges`. */
const DEFAULT_MAX_BUFFERED_RANGES = 64;

/**
 * Minimum spacing (ms of wall time) between `onBufferChange` invocations —
 * a trailing-edge throttle at ≤10 Hz, so a burst of tile loads coalesces
 * into one runway recomputation instead of recomputing per tile.
 */
const BUFFER_CHANGE_THROTTLE_MS = 100;

/**
 * "All of time" query range used to build the coverage index: the directory
 * slice for the current viewport across the FULL dataset time range. Bounds
 * are the ECMAScript Date range, so every directory entry overlaps it.
 */
const FULL_TIME_RANGE = { start: -8.64e15, end: 8.64e15 };

/** Whole-world bounds used to enumerate the overview (storyboard) tier. */
const WORLD_BOUNDS: BoundingBox = { minLon: -180, minLat: -90, maxLon: 180, maxLat: 90 };

/**
 * Default byte budget for {@link SpatiotemporalTileset.preloadOverviewTier}.
 * The overview tier is meant to be a TINY always-resident storyboard; when
 * the coarsest tiles across the full time range cost more than this, the
 * preload is rejected (some datasets have enormous coarse tiles — satellites
 * z0 is ~17 MB *per tile* — and pinning those would wreck the cache).
 */
const DEFAULT_OVERVIEW_BUDGET_BYTES = 20 * 1024 * 1024;

/** Default deepest zoom included in the overview (storyboard) tier. */
const DEFAULT_OVERVIEW_MAX_ZOOM = 1;

/**
 * The buffered-runway report: how much contiguous sim-time ahead of the play
 * head is fully loaded for the current viewport at the primary zoom.
 *
 * This is the readiness primitive the playback governor builds on — "can the
 * clock advance into [t, t+Δ] without rendering a partial frame?" — and is
 * pure directory + cache math (zero network).
 */
export interface BufferedRunway {
  /**
   * Contiguous sim-time (ms) ahead of the probed `time` in `direction` for
   * which EVERY needed tile is loaded. Stops at the first temporal bucket
   * with a missing tile; clamped to the probed horizon.
   */
  simMs: number;
  /**
   * Directory byte sum of needed-but-not-loaded tiles within the probed
   * horizon (in-flight tiles count as not loaded — honesty over optimism).
   * `0` when `getTileByteSize` is not wired (tile sizes unknown).
   */
  bytesPending: number;
  /** How far (sim-ms) the probe looked ahead. */
  horizonSimMs: number;
  /**
   * `true` when the runway reached the horizon — or the edge of the dataset's
   * available data in the travel direction — with nothing missing.
   */
  complete: boolean;
}

/** Per-bucket needed-tile records inside the coverage index. */
interface CoverageBucket {
  /** Registry keys (`z/x/y/t`) of the tiles addressed at this bucket. */
  keys: string[];
  /** Compressed byte length per tile (0 when `getTileByteSize` is unwired). */
  bytes: number[];
}

/**
 * Directory-derived coverage index: every tile id (plus its directory byte
 * length) at the PRIMARY zoom for the current viewport bounds, across the
 * FULL dataset time range, grouped by temporal bucket. Built once per
 * spatial viewport change (async — one `getAvailableTiles` call); loaded/
 * missing status is then resolved live against the tile registry, so the
 * runway / buffered-ranges / cost queries are cheap synchronous walks.
 */
interface CoverageIndex {
  /** Spatial signature (`bounds|primaryZoom`) this index was built for. */
  signature: string;
  /** Distinct bucket start times, ascending. */
  bucketStarts: number[];
  /** Bucket start time → needed tiles addressed at that bucket. */
  buckets: Map<number, CoverageBucket>;
  /**
   * `[first bucket start, last bucket end]` of the viewport's available
   * data, or `null` when the viewport has no tiles at any time.
   */
  timeRange: { start: number; end: number } | null;
}

/** Bookkeeping for the single overview (storyboard) preload attempt. */
interface OverviewState {
  /** Returned to EVERY `preloadOverviewTier()` caller (idempotency). */
  promise: Promise<OverviewPreloadResult>;
  resolve: (result: OverviewPreloadResult) => void;
  /** Latched once `resolve` has been called. */
  settled: boolean;
  /** Registry keys of pinned tiles whose fetch hasn't reached a final state. */
  pendingKeys: Set<string>;
  /** Directory byte sum of the candidate tiles. */
  bytes: number;
  /** Candidate tile count. */
  tiles: number;
}

/** First index in ascending `arr` with `arr[i] >= x` (`arr.length` if none). */
function lowerBound(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The result of a {@link SpatiotemporalTileset.preloadOverviewTier} attempt —
 * the data player's analog of a video storyboard (thumbnail strip): a tiny,
 * always-resident coarse tier covering the full dataset time range so a
 * scrub always has SOMETHING to render via the parent-zoom fallback.
 */
export interface OverviewPreloadResult {
  /** `true` when the overview tier is resident (pinned in the cache). */
  loaded: boolean;
  /**
   * Directory byte sum of the candidate overview tiles — reported even when
   * the preload was rejected, so callers can see how far over budget the
   * dataset is. `0` when `getTileByteSize` is unwired (sizes unknown).
   */
  bytes: number;
  /** Number of candidate overview tiles. */
  tiles: number;
  /**
   * Why the tier did NOT load (`loaded: false` only):
   * - `'over-budget'` — the directory byte sum exceeds the budget; nothing
   *   was fetched.
   * - `'no-tiles'`    — the directory has no tiles at the overview zooms.
   * - `'disabled'`    — the tileset was cleared/finalized mid-preload.
   * - `'error'`       — the directory enumeration failed.
   */
  reason?: 'over-budget' | 'no-tiles' | 'disabled' | 'error';
}

/**
 * Request tier: current-viewport (priority), lookahead (prefetch), or
 * pinned-storyboard (overview) work. Overview is the LOWEST tier — it only
 * dispatches when no priority work is queued — but unlike prefetch it is
 * never flushed or superseded (its tiles are pinned).
 */
type RequestTier = 'priority' | 'prefetch' | 'overview';

/**
 * Optional per-batch hooks for {@link SpatiotemporalTilesetOptions.getTileDataBatch}.
 * Mirrors the archive's `TileRequestOptions` incremental-delivery contract
 * without importing it (the batch callback may be backed by anything).
 */
export interface TileBatchHooks {
  /** Delivers `(indexIntoBatch, tile)` as each tile decodes, before the batch resolves. */
  onTileReady?: (index: number, tile: Tile) => void;
  /** Browser fetch-priority hint for the batch's HTTP requests. */
  fetchPriority?: 'high' | 'low' | 'auto';
}

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
   *
   * `hooks.onTileReady`, when forwarded to the archive, delivers each tile
   * (by input index) as soon as ITS coalesced range group decodes, so the
   * tileset can mark tiles loaded incrementally instead of waiting for the
   * whole batch to settle. `hooks.fetchPriority` is the browser
   * fetch-priority hint for the batch's HTTP requests (`'low'` for
   * lookahead tiers). Implementations may ignore both.
   */
  getTileDataBatch?: (
    tileIds: TileId[],
    signal?: AbortSignal,
    hooks?: TileBatchHooks
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

  /**
   * Callback invoked with a fresh {@link BufferedRunway} (probed from the
   * current play-head time in the committed prefetch direction) whenever a
   * needed tile loads, a tile is evicted, or the needed-tile set changes.
   * Trailing-edge throttled to ≤10 Hz, so a burst of tile arrivals costs one
   * recomputation, not one per tile. Wiring this enables coverage-index
   * maintenance (one extra `getAvailableTiles` call per viewport change).
   */
  onBufferChange?: (runway: BufferedRunway) => void;

  /**
   * Network throughput probe used by {@link SpatiotemporalTileset.estimateTimeToReadyMs}
   * to convert pending bytes into an honest ETA. Wire
   * `STTArchive.getThroughputEstimate` here (the consuming layer does this).
   * `bytesPerMs` is `null` until the estimator has at least one sample.
   */
  getThroughput?: () => { bytesPerMs: number | null; samples: number };

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
  /**
   * Pinned overview (storyboard) tile: never evicted, never aborted by
   * `flushPrefetch()` / `cancelSupersededRequests()`. Its bytes still count
   * in cache accounting. Set by `preloadOverviewTier()`.
   */
  isPinned?: boolean;
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
  
  // ── Buffer model state (WS-A) ──────────────────────────────────────────
  // Coverage tracking is LAZY: the index costs one extra getAvailableTiles
  // call per spatial viewport change, so it's only maintained once a buffer
  // API is used (or `onBufferChange` is wired).
  private bufferTrackingEnabled = false;
  private coverageIndex: CoverageIndex | null = null;
  /** Signature of an in-flight coverage build (de-dupes concurrent builds). */
  private coverageBuildSignature: string | null = null;
  /** Trailing-edge throttle state for onBufferChange. */
  private bufferChangeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBufferChangeAt = 0;

  /**
   * Spatial signature (`bounds|zoom`) of the previous selection pass. A
   * change means the prefetch runway was planned for a viewport the camera
   * has left, so it's auto-flushed (WS-C3 — "viewport is a second seek
   * axis"). Time seeks are detected in `update()` instead, where the
   * pre-jump speed estimate is still available.
   */
  private lastSpatialKey?: string;

  /**
   * In-flight PREFETCH-tier requests (shared AbortController + the registry
   * keys it covers). `flushPrefetch()` aborts exactly these — priority-tier
   * requests are never touched. The same registry EXEMPTS these keys from
   * `cancelSupersededRequests`: prefetch tiles are intentionally ahead of
   * the current window, so "not in the needed set" is their normal operating
   * condition, not supersession.
   */
  private inflightPrefetch = new Set<{ controller: AbortController; keys: string[] }>();

  /**
   * In-flight PRIORITY-tier batches. A batch shares one AbortController
   * across all members, so `cancelSupersededRequests` must judge it as a
   * whole: it aborts a batch only when EVERY member has left the needed set
   * (a seek landed elsewhere). During ordinary playback the window's
   * trailing edge always supersedes a few members per pass; aborting then
   * would kill the still-needed rest of the batch with them.
   */
  private inflightPriority = new Set<{ controller: AbortController; keys: string[] }>();

  // ── Overview (storyboard) tier state (WS-C4) ─────────────────────────────
  /** Pinned-overview tiles awaiting fetch; drained ONLY when priority is idle. */
  private overviewQueue: TileId[] = [];
  /**
   * The single overview preload attempt (idempotency anchor): repeat calls
   * to `preloadOverviewTier()` return `promise` rather than re-fetching.
   * `pendingKeys` tracks which pinned tiles haven't finished loading yet;
   * the promise resolves when it drains. Reset by `clear()`.
   */
  private overviewState: OverviewState | null = null;
  /** One-shot warn latch for "pinned overview alone exceeds cache limits". */
  private warnedPinnedOverCacheLimit = false;

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
      onBufferChange: options.onBufferChange ?? null,
      getThroughput: options.getThroughput ?? null,
      onTileLoad: options.onTileLoad ?? (() => {}),
      onTileUnload: options.onTileUnload ?? (() => {}),
      onTileError: options.onTileError ?? ((err) => console.error(err)),
    } as Required<SpatiotemporalTilesetOptions>;

    // A wired onBufferChange implies the caller wants live buffer reports,
    // so start maintaining the coverage index from the first update().
    if (options.onBufferChange) {
      this.bufferTrackingEnabled = true;
    }
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
      // Direction reversed: the prefetched span (queued AND in flight) is now
      // behind the play head — dead weight the in-flight supersession
      // exemption would otherwise let run to completion. Flush it; that also
      // resets the runway anchor so the next prefetch re-plans immediately
      // in the new direction.
      this.flushPrefetch();
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

    // A signed speed is an AUTHORITATIVE direction signal (e.g. a ping-pong
    // controller reversing at a boundary), so commit it immediately and bypass
    // the observed-delta hysteresis in updatePrefetchDirection() — that
    // hysteresis only exists to ignore stray single-frame scrubs, not a known
    // reversal. Without this, prefetch keeps aiming the old way for a few
    // frames after the reverse and the play head loads into un-prefetched
    // buckets reactively → a flash. Flush the old-direction runway (queued
    // and in flight — it's behind the head now) so the next prefetch
    // re-plans in the new direction at once.
    if (speed !== 0) {
      const dir: 1 | -1 = speed > 0 ? 1 : -1;
      if (dir !== this.prefetchDirection) {
        this.prefetchDirection = dir;
        this.pendingFlipCount = 0;
        this.flushPrefetch();
      }
    }

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

      // Seek detection (WS-C3), SPEED-AWARE: a jump beyond what continuous
      // playback could plausibly cover between updates is a seek — the
      // prefetch runway points at stale buckets, so flush it. The threshold
      // scales with |speed| because at high sim-speeds an ordinary
      // 100 ms-spaced update legitimately advances many time windows; the
      // old window-only threshold misread those steps as seeks and flushed
      // the runway every pass. A seek's delta is also NOT evidence of
      // animation speed or direction (feeding it to the estimator would
      // balloon the next prefetch span), so the seek branch skips both.
      const seekThreshold = Math.max(
        viewport.timeWindow,
        Math.abs(this.animationSpeed) * SEEK_DETECTION_REAL_MS,
      );
      if (Math.abs(simTimeDelta) > seekThreshold) {
        this.flushPrefetch();
      } else {
        // Direction tracking only needs the SIGN of the time delta — update it
        // regardless of wall-clock spacing (consecutive updates may share a ms).
        this.updatePrefetchDirection(simTimeDelta);

        if (this.lastUpdateTime > 0) {
          const realTimeDelta = now - this.lastUpdateTime;
          // Ignore large gaps, and ignore zero sim-deltas: a frozen clock (e.g.
          // a playback governor holding the playhead while it buffers) is not
          // evidence of zero speed — overwriting the signalled speed here would
          // collapse the prefetch span exactly when the gate needs it most.
          if (realTimeDelta > 0 && realTimeDelta < 1000 && simTimeDelta !== 0) {
            this.animationSpeed = simTimeDelta / realTimeDelta;
          }
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

    // Spatial viewport change (pan/zoom): the prefetch runway was planned
    // for the previous bounds/zoom, so it now warms tiles the camera has
    // left — flush it and let the next prefetch pass re-plan for the new
    // viewport. Time SEEKS are detected in update() instead (speed-aware,
    // before the jump can poison the speed estimate). flushPrefetch clears
    // lastSelectKey, so assign it AFTER the flush.
    const spatialKey =
      `${bounds.minLon}|${bounds.minLat}|${bounds.maxLon}|${bounds.maxLat}|${zoom}`;
    if (this.lastSpatialKey !== undefined && this.lastSpatialKey !== spatialKey) {
      this.flushPrefetch();
    }
    this.lastSpatialKey = spatialKey;
    this.lastSelectKey = selectKey;

    // Keep the coverage index aligned with the spatial viewport (no-op until
    // a buffer API or onBufferChange enables tracking; cheap signature check
    // thereafter).
    if (this.bufferTrackingEnabled) {
      this.maybeRebuildCoverageIndex(bounds, zoom);
    }

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
        // FETCH-skip only: an oversized parent that is ALREADY loaded (e.g. a
        // pinned overview tile, or a leftover from a shallower view) costs
        // nothing to keep in the needed/visible set — excluding it would blank
        // the very fallback it exists to provide.
        if (this.isOversizedParent(tileId, primaryZoom)) {
          const key = this.tileIdToKey(tileId);
          const loadedHeader = this.tiles.get(key);
          if (loadedHeader?.isLoaded) {
            neededTileKeys.add(key);
            loadedHeader.lastUsed = now;
            this.cacheStats.hits++;
          }
          continue;
        }

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
      this.notifyBufferChange();
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
    //
    // EXCEPT when the prefetch pipeline is idle: the planner's enqueue is
    // budget-capped (a fraction of the cache), so one pass may cover only part
    // of the span it claimed via lastPrefetchEndTime. If the queue and the
    // in-flight set have both drained, the consumed-runway rule must not block
    // a re-plan — with a frozen playhead (a buffering gate holding the clock)
    // the head consumes nothing, the rule never re-arms, and loading stops
    // exactly when the gate is waiting for it (the high-speed stall deadlock).
    // A re-plan that finds nothing new enqueues zero tiles and stops cleanly.
    const pipelineIdle =
      this.prefetchQueue.length === 0 && this.inflightPrefetch.size === 0;
    if (this.lastPrefetchEndTime !== undefined && !pipelineIdle) {
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

    // Keys already sitting in either queue: a dead header (see below) must not
    // be double-enqueued. Built once per pass — the candidate loop would be
    // O(candidates × queue) otherwise.
    const queuedKeys = new Set<string>();
    for (const qid of this.prefetchQueue) queuedKeys.add(this.tileIdToKey(qid));
    for (const qid of this.priorityQueue) queuedKeys.add(this.tileIdToKey(qid));

    let newTilesAdded = 0;
    // Furthest ahead-of-head distance actually ENQUEUED this pass — the
    // honest frontier when the budget truncates the span (behind-head
    // sentinel distances are ignored).
    let coveredAheadMs = 0;
    const noteEnqueued = (id: TileId): void => {
      const d = aheadDist(id);
      if (d <= effectiveAhead) coveredAheadMs = Math.max(coveredAheadMs, d);
    };
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
        noteEnqueued(tileId);
      } else if (
        !header.isLoaded &&
        !header.isLoading &&
        !queuedKeys.has(key)
      ) {
        // DEAD header: a previous fetch was aborted (its shared batch was
        // superseded by a viewport/time change) or failed, leaving a header
        // that is neither loaded, loading, nor queued. Without this branch it
        // silently blocks the tile from ever being planned again — the
        // buffered runway then plateaus at "whatever survived" and a gated
        // high-speed playback starves forever. Reset the one-way isCancelled
        // latch (mirrors the priority-path reset in selectAndLoadTiles) and
        // re-enqueue.
        header.isCancelled = false;
        header.lastUsed = now;
        this.prefetchQueue.push(tileId);
        queuedKeys.add(key);
        newTilesAdded++;
        noteEnqueued(tileId);
      } else {
        // Update last used time to prevent eviction
        header.lastUsed = now;
      }
    }

    // Budget-capped pass: the optimistic claim above (lastPrefetchEndTime =
    // prefetchEndTime, set before the await as a re-entry guard) covers the
    // FULL speed-scaled span, but the enqueue stopped at the budget. Anchor
    // the runway throttle at the furthest bucket actually planned, so the
    // next pass re-plans when the head nears the REAL frontier instead of
    // trusting a span nobody fetched. (Only correct our own claim — a
    // concurrent flush/flip may have reset it while we awaited.)
    if (newTilesAdded >= prefetchBudget && this.lastPrefetchEndTime === prefetchEndTime) {
      this.lastPrefetchEndTime =
        time + direction * (coveredAheadMs + this.options.temporalBucketMs);
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
   * Process request queues. Priority (current-time) tiles always dispatch
   * first; two accounting models, one per dispatch path:
   *
   * - BATCHED (`getTileDataBatch` wired): in-flight accounting is per BATCH,
   *   not per tile. The archive coalesces a batch into a few HTTP range
   *   requests and bounds its own connection concurrency, so a 300-tile
   *   batch is NOT 300 requests and must not consume 300 "slots" — the old
   *   tile-granular slot math let one big in-flight batch drive
   *   `availableSlots ≤ 0` and block ALL dispatch (including priority) until
   *   it settled. Priority batches dispatch unconditionally; prefetch runs
   *   at most ONE batch at a time, and only once the priority queue drained.
   *
   * - PER-TILE (fallback): a tile IS a request, so the `maxRequests` slot
   *   budget applies per tile, with prefetch capped to a share of the slots
   *   (half animating, a third paused) and never starving priority.
   */
  private async processRequestQueue(): Promise<void> {
    if (DEBUG && (this.priorityQueue.length > 0 || this.prefetchQueue.length > 0)) {
      console.log('[Tileset] processRequestQueue:', {
        activeRequests: this.activeRequests.size,
        priorityQueue: this.priorityQueue.length,
        prefetchQueue: this.prefetchQueue.length,
      });
    }

    // Time-proximity ordering (WS-E): drain the priority queue nearest-to-
    // the-play-head first, keeping the existing primary-zoom-before-parent
    // precedence. Under a constrained pool this loads the tiles the user is
    // looking AT before the window's far edges and parent fallbacks.
    this.sortPriorityQueueByPlayhead();

    const batchFn = this.options.getTileDataBatch;

    if (!batchFn) {
      // ── Per-tile path: slot accounting in tiles (a tile IS a request). ──
      const availableSlots = this.options.maxRequests - this.activeRequests.size;
      if (availableSlots <= 0) return;

      let usedSlots = 0;
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
      if (prefetchSlots <= 0) return; // priority work is saturating the connection

      let prefetchUsed = 0;
      while (this.prefetchQueue.length > 0 && prefetchUsed < prefetchSlots) {
        const tileId = this.prefetchQueue.shift()!;
        if (this.startTileLoad(tileId, 'prefetch')) {
          prefetchUsed++;
        }
      }

      this.drainOverviewQueue();
      return;
    }

    // ── Batched (coalesced) path: per-batch accounting. ─────────────────────
    // Send the WHOLE current priority working set in one batch (capped only
    // for safety) instead of slicing it into serial chunks: the archive
    // collapses byte-adjacent tiles into a few range requests and bounds
    // in-flight HTTP requests itself, so one big batch collapses a
    // viewport×window into a handful of parallel requests.
    if (this.priorityQueue.length > 0) {
      const candidates: TileId[] = [];
      while (this.priorityQueue.length > 0 && candidates.length < MAX_COALESCE_BATCH) {
        candidates.push(this.priorityQueue.shift()!);
      }
      this.startTileBatch(candidates);
    }
    // A working set beyond the safety cap: leave the remainder (and all
    // lookahead work) to the next pass — the batch finally-handlers re-run
    // this queue.
    if (this.priorityQueue.length > 0) return;

    // Prefetch: ONE small SLICE in flight at a time, sized in bytes to
    // ≈ PREFETCH_SLICE_TARGET_REAL_MS of measured download (see the slice
    // constants). The queue is drained nearest-to-playhead-first, so each
    // slice is exactly the next most-imminent stretch of runway; the
    // finally-handler (plus extendPrefetchIfDrained) dispatches the next
    // slice the moment this one settles, and re-checks priority work first.
    // A second concurrent slice would only add bandwidth contention against
    // priority fetches.
    if (this.prefetchQueue.length > 0 && this.inflightPrefetch.size === 0) {
      const budget = this.prefetchSliceBytes();
      const sizeFn = this.options.getTileByteSize;
      const candidates: TileId[] = [];
      let sliceBytes = 0;
      while (this.prefetchQueue.length > 0 && candidates.length < MAX_COALESCE_BATCH) {
        const next = this.prefetchQueue[0];
        const size = sizeFn?.(next) ?? PREFETCH_UNKNOWN_TILE_BYTES;
        // A slice always takes at least one tile, even one bigger than the
        // whole budget — it has to load eventually and alone is its own slice.
        if (candidates.length > 0 && sliceBytes + size > budget) break;
        this.prefetchQueue.shift();
        candidates.push(next);
        sliceBytes += size;
      }
      this.startTileBatch(candidates, 'prefetch');
    }

    // Overview (storyboard) tier last: it only dispatches once the priority
    // queue is fully drained on this pass, so it can never starve viewport
    // work.
    this.drainOverviewQueue();
  }

  /**
   * Byte budget for the next prefetch slice: ≈ PREFETCH_SLICE_TARGET_REAL_MS
   * of download at the measured throughput, clamped to [MIN, MAX]; a fixed
   * cold-start size until the estimator has a sample. Sizing by TIME (not a
   * fixed byte count) keeps the hostage window — how long a play head that
   * catches the slice must wait for it — roughly constant across link speeds.
   */
  private prefetchSliceBytes(): number {
    const bytesPerMs = this.options.getThroughput?.().bytesPerMs ?? null;
    if (bytesPerMs === null || bytesPerMs <= 0) return PREFETCH_SLICE_COLD_BYTES;
    return Math.min(
      PREFETCH_SLICE_MAX_BYTES,
      Math.max(PREFETCH_SLICE_MIN_BYTES, bytesPerMs * PREFETCH_SLICE_TARGET_REAL_MS),
    );
  }

  /**
   * Order the priority queue by temporal distance from the play head,
   * primary-zoom tiles strictly before parent fallbacks (preserving the
   * existing primary-vs-parent precedence; proximity sorts WITHIN each
   * class). Runs at drain time, so a queue built up across several
   * selection passes is still consumed nearest-first.
   */
  private sortPriorityQueueByPlayhead(): void {
    if (this.priorityQueue.length <= 1 || !this.currentViewport) return;
    const { time, zoom } = this.currentViewport;
    const primaryZoom = this.getZoomLevelsToLoad(zoom)[0];
    this.priorityQueue.sort((a, b) => {
      const classA = a.z === primaryZoom ? 0 : 1;
      const classB = b.z === primaryZoom ? 0 : 1;
      if (classA !== classB) return classA - classB;
      return Math.abs(a.t - time) - Math.abs(b.t - time);
    });
  }
  
  /**
   * Start loading a single tile
   * Returns true if load was started, false if skipped
   *
   * PERFORMANCE: Uses AbortController to cancel superseded requests
   * when viewport/time changes significantly.
   *
   * `tier` tags the request so `flushPrefetch()` can abort in-flight
   * PREFETCH work without touching priority fetches.
   */
  private startTileLoad(tileId: TileId, tier: RequestTier = 'priority'): boolean {
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

    // Register prefetch-tier requests so flushPrefetch can abort them.
    const inflightRecord =
      tier === 'prefetch' ? { controller: abortController, keys: [key] } : null;
    if (inflightRecord) this.inflightPrefetch.add(inflightRecord);

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
          this.notifyBufferChange();
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
        if (inflightRecord) this.inflightPrefetch.delete(inflightRecord);
        if (tier === 'overview') this.settleOverviewKeys([key]);

        // Process next in queue
        this.processRequestQueue();
        this.extendPrefetchIfDrained();
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
   * `tier` tags the batch so `flushPrefetch()` can abort in-flight PREFETCH
   * batches without touching priority fetches.
   *
   * Returns the number of tiles actually started.
   */
  private startTileBatch(tileIds: TileId[], tier: RequestTier = 'priority'): number {
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

    // Register the batch so tier-aware cancellation can find it: PREFETCH
    // batches are abortable only via flushPrefetch; PRIORITY batches are
    // judged whole-batch by cancelSupersededRequests. (Overview batches need
    // no registry — their members' pinned flag already exempts them.)
    const inflightRecord = { controller: abortController, keys: started.map((s) => s.key) };
    const registry =
      tier === 'prefetch'
        ? this.inflightPrefetch
        : tier === 'priority'
          ? this.inflightPriority
          : null;
    if (registry) registry.add(inflightRecord);

    // Incremental delivery: mark a member loaded the moment its coalesced
    // range group decodes (via the onTileReady hook), instead of when the
    // whole batch settles — the nearest tiles of a slice become renderable
    // while the farther groups are still in flight. `delivered` guards
    // double-accounting when the resolved array replays hook-delivered tiles.
    const delivered: boolean[] = new Array(started.length).fill(false);
    const deliverTile = (i: number, tile: Tile): void => {
      const { header } = started[i];
      if (delivered[i] || header.isCancelled || header.isLoaded) return;
      delivered[i] = true;
      header.tile = tile;
      header.isLoaded = true;
      header.byteSize = estimateTileSize(tile);
      this.currentCacheBytes += header.byteSize;
      this.loadedTileCount++;
      this.options.onTileLoad?.(tile);
      this.frameNumber++;
      this.notifyBufferChange();
    };

    batchFn(
      started.map((s) => s.id),
      abortController.signal,
      {
        onTileReady: deliverTile,
        // Lookahead tiers yield to concurrent need-now fetches at the
        // browser's connection scheduler; priority keeps the default.
        fetchPriority: tier === 'priority' ? 'auto' : 'low',
      },
    )
      .then((tiles) => {
        for (let i = 0; i < started.length; i++) {
          const { header, id, key } = started[i];
          const tile = tiles[i];
          if (!header.isCancelled && tile) {
            // Backstop for batch implementations that ignore the hook.
            deliverTile(i, tile);
          } else if (!header.isCancelled && !tile && tier === 'priority') {
            // The batch resolved but this member is absent. When the
            // directory says the tile exists, the archive's retry + per-tile
            // fallback both failed for it — surface that PER TILE instead of
            // silently leaving a hole (a missing-from-directory tile, where
            // getTileByteSize is undefined, is legitimately null). Prefetch
            // tiles stay best-effort: they re-surface at priority if the
            // play head actually reaches them.
            const sizeFn = this.options.getTileByteSize;
            if (sizeFn && sizeFn(id) !== undefined) {
              this.options.onTileError?.(
                new Error(`Tile fetch failed after retries: ${key}`),
                id,
              );
            }
          }
        }
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
        if (registry) registry.delete(inflightRecord);
        if (tier === 'overview') this.settleOverviewKeys(started.map((s) => s.key));
        this.processRequestQueue();
        this.extendPrefetchIfDrained();
      });

    return started.length;
  }

  /**
   * Keep the prefetch runway extending while the animation (or a buffering
   * gate impersonating one) is consuming it: a planning pass is budget-capped,
   * so when the queue and in-flight set drain before the claimed span is
   * covered, plan the next slice. A pass that finds nothing new enqueues zero
   * tiles, so this converges instead of spinning.
   */
  private extendPrefetchIfDrained(): void {
    if (!this.isAnimating || !this.options.enablePrefetch) return;
    if (this.prefetchQueue.length > 0 || this.inflightPrefetch.size > 0) return;
    this.schedulePrefetch();
  }

  /**
   * Cancel in-flight requests for tiles that are no longer needed.
   * Called on every selection pass whose needed-tile set changed.
   *
   * TIER-AWARE — the policy that keeps the prefetch runway alive during
   * playback:
   *
   * - PREFETCH-tier work is fully exempt. Its tiles are intentionally AHEAD
   *   of the current window, so "not in the needed set" is their normal
   *   operating condition, not supersession. Treating it as supersession
   *   aborted every in-flight prefetch batch on every selection pass during
   *   playback — at fast speeds (selection every ~100 ms wall) no batch ever
   *   completed, collapsing the runway into reactive local fetches. Prefetch
   *   is invalidated only by `flushPrefetch()` (seeks, spatial viewport
   *   changes, direction flips — all of which call it automatically).
   *
   * - PRIORITY-tier batches share one AbortController across all members, so
   *   they are judged per BATCH: aborted only when EVERY member has left the
   *   needed set (a seek landed elsewhere). During ordinary playback the
   *   window's trailing edge supersedes a few members per pass; aborting
   *   then would kill the still-needed rest of the batch with them.
   *
   * - Per-tile (non-batch) requests keep the original per-tile abort.
   *
   * - PINNED overview tiles are exempt as before: they are needed at EVERY
   *   time (that is the storyboard contract).
   */
  cancelSupersededRequests(neededTileKeys: Set<string>): number {
    let cancelledCount = 0;

    // Keys owned by registered in-flight batches: prefetch keys are exempt
    // from supersession entirely; priority-batch keys are decided batch-wise
    // below — either way the per-tile sweep must skip them.
    const exemptKeys = new Set<string>();
    for (const rec of this.inflightPrefetch) {
      for (const key of rec.keys) exemptKeys.add(key);
    }

    for (const rec of this.inflightPriority) {
      let anyNeeded = false;
      for (const key of rec.keys) {
        if (neededTileKeys.has(key)) {
          anyNeeded = true;
          break;
        }
      }
      if (anyNeeded) {
        // Still delivering needed data — superseded members ride along (their
        // bytes are already largely in flight; eviction reclaims them later).
        for (const key of rec.keys) exemptKeys.add(key);
        continue;
      }
      // Every member superseded: the batch serves a window that no longer
      // exists. Kill it whole.
      rec.controller.abort();
      for (const key of rec.keys) {
        exemptKeys.add(key);
        const header = this.tiles.get(key);
        if (header && !header.isLoaded && !header.isPinned) {
          header.isCancelled = true;
          cancelledCount++;
        }
      }
    }

    // Per-tile sweep (single-tile loads on the non-batch path).
    for (const [key, header] of this.tiles) {
      if (
        header.isLoading &&
        header.abortController &&
        !neededTileKeys.has(key) &&
        !header.isPinned &&
        !exemptKeys.has(key)
      ) {
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

  // ── Buffer model + readiness API (WS-A) ──────────────────────────────────

  /**
   * Probe how much contiguous sim-time ahead of `time` (in `direction`) is
   * fully buffered for the current viewport at the primary zoom.
   *
   * A temporal bucket is "ready" iff every tile addressed at that bucket
   * (per the coverage index — the same `getAvailableTiles` universe that
   * `selectAndLoadTiles` fetches from, at the primary zoom for the current
   * bounds) is loaded in the tileset cache. The walk proceeds bucket by
   * bucket from `time` until the first non-ready bucket or the horizon;
   * buckets with no tiles are trivially ready. Reaching the edge of the
   * viewport's available data counts as `complete`.
   *
   * Cheap and synchronous — a bounded walk over the in-memory coverage
   * index with O(1) loaded checks; safe to call several times per second.
   * Until the (async, once-per-viewport) coverage index is built it
   * conservatively reports an empty, incomplete runway.
   *
   * @param time         Sim-time (ms) to probe from — normally the play head.
   * @param direction    +1 forward, -1 backward.
   * @param horizonSimMs How far to probe. Defaults to
   *                     `max(4 × timeWindow, |animationSpeed| × 10 s)`, and
   *                     always at least one temporal bucket.
   */
  getBufferedRunway(time: number, direction: 1 | -1, horizonSimMs?: number): BufferedRunway {
    this.ensureBufferTracking();
    const bucketMs = this.options.temporalBucketMs;
    const timeWindow = this.currentViewport?.timeWindow ?? bucketMs;
    const speed = Math.abs(this.animationSpeed);
    const horizon = Math.max(
      horizonSimMs ?? Math.max(4 * timeWindow, speed * RUNWAY_HORIZON_REAL_MS),
      bucketMs,
    );

    const idx = this.coverageIndex;
    if (!idx) {
      // Index not built yet (no viewport, or the async directory slice is
      // still in flight): report "nothing buffered" rather than guessing.
      return { simMs: 0, bytesPending: 0, horizonSimMs: horizon, complete: false };
    }
    if (idx.timeRange === null) {
      // The viewport has no tiles at ANY time: nothing can be missing.
      return { simMs: horizon, bytesPending: 0, horizonSimMs: horizon, complete: true };
    }

    // Clamp the probe at the edge of the available data in the travel
    // direction — reaching the dataset end with nothing missing is complete.
    const horizonEnd = time + direction * horizon;
    const probeEnd =
      direction > 0
        ? Math.min(horizonEnd, idx.timeRange.end)
        : Math.max(horizonEnd, idx.timeRange.start);
    const spanStart = Math.min(time, probeEnd);
    const spanEnd = Math.max(time, probeEnd);

    // One pass over the buckets intersecting the probed span. `firstMissing`
    // bounds the forward runway, `lastMissing` the backward one;
    // `bytesPending` accumulates over the WHOLE span either way.
    const starts = idx.bucketStarts;
    let bytesPending = 0;
    let firstMissing: number | null = null;
    let lastMissing: number | null = null;
    for (
      let i = lowerBound(starts, spanStart - bucketMs);
      i < starts.length && starts[i] <= spanEnd;
      i++
    ) {
      const b = starts[i];
      if (b + bucketMs <= spanStart) continue; // touches the span edge only
      const bucket = idx.buckets.get(b)!;
      let missing = false;
      for (let j = 0; j < bucket.keys.length; j++) {
        if (!this.tiles.get(bucket.keys[j])?.isLoaded) {
          missing = true;
          bytesPending += bucket.bytes[j];
        }
      }
      if (missing) {
        if (firstMissing === null) firstMissing = b;
        lastMissing = b;
      }
    }

    // The runway stops at the NEAR edge of the first non-ready bucket in the
    // travel direction; with nothing missing it reaches the probe end.
    const boundary =
      direction > 0
        ? firstMissing
        : lastMissing === null
          ? null
          : lastMissing + bucketMs;
    const complete = boundary === null;
    const reach = complete ? probeEnd : boundary;
    const simMs = Math.max(
      0,
      Math.min(direction > 0 ? reach - time : time - reach, horizon),
    );
    return { simMs, bytesPending, horizonSimMs: horizon, complete };
  }

  /**
   * Merged, ascending sim-time ranges that are fully loaded for the current
   * viewport at the primary zoom, across the FULL dataset time range — the
   * data behind a scrubber's "buffered" bar.
   *
   * One pass over the coverage index's temporal buckets: a bucket is
   * buffered iff every tile addressed at it is loaded; consecutive buffered
   * buckets merge, including across bucket gaps that contain no tiles at
   * all (nothing to load there). Output is capped at `maxRanges`
   * (default 64); buckets beyond the cap are truncated. Cheap enough to
   * poll at ~1 Hz. Returns `[]` until the coverage index is built.
   */
  getBufferedRanges(opts?: { maxRanges?: number }): Array<{ start: number; end: number }> {
    this.ensureBufferTracking();
    const idx = this.coverageIndex;
    if (!idx || idx.timeRange === null) return [];
    const maxRanges = Math.max(1, Math.floor(opts?.maxRanges ?? DEFAULT_MAX_BUFFERED_RANGES));
    const bucketMs = this.options.temporalBucketMs;

    const ranges: Array<{ start: number; end: number }> = [];
    let current: { start: number; end: number } | null = null;
    for (const b of idx.bucketStarts) {
      const bucket = idx.buckets.get(b)!;
      let ready = true;
      for (const key of bucket.keys) {
        if (!this.tiles.get(key)?.isLoaded) {
          ready = false;
          break;
        }
      }
      if (!ready) {
        current = null;
        continue;
      }
      if (current) {
        current.end = b + bucketMs;
      } else {
        if (ranges.length === maxRanges) break; // truncate beyond the cap
        current = { start: b, end: b + bucketMs };
        ranges.push(current);
      }
    }
    return ranges;
  }

  /**
   * Exact cost of making `range` fully buffered for the current viewport at
   * the primary zoom: the directory byte sum (and count) of tiles whose
   * bucket intersects the range and are NOT loaded. In-flight tiles count
   * as not loaded — honesty over optimism. Pure directory math, zero
   * network. `bytes` is 0 when `getTileByteSize` is unwired (sizes unknown)
   * or before the coverage index is built.
   */
  estimateCost(range: { start: number; end: number }): { bytes: number; tiles: number } {
    this.ensureBufferTracking();
    const idx = this.coverageIndex;
    if (!idx || idx.timeRange === null) return { bytes: 0, tiles: 0 };
    const bucketMs = this.options.temporalBucketMs;
    const starts = idx.bucketStarts;

    let bytes = 0;
    let tiles = 0;
    for (
      let i = lowerBound(starts, range.start - bucketMs);
      i < starts.length && starts[i] <= range.end;
      i++
    ) {
      const b = starts[i];
      if (b + bucketMs < range.start) continue;
      const bucket = idx.buckets.get(b)!;
      for (let j = 0; j < bucket.keys.length; j++) {
        if (!this.tiles.get(bucket.keys[j])?.isLoaded) {
          bytes += bucket.bytes[j];
          tiles++;
        }
      }
    }
    return { bytes, tiles };
  }

  /**
   * Honest ETA (ms) until `range` could be fully buffered:
   * `estimateCost(range).bytes / measured throughput`. Returns `null` when
   * no `getThroughput` option is wired or the estimator has no signal yet
   * (`bytesPerMs` null/0) — callers should show an indeterminate state, not
   * a fake number. A video player cannot compute this; STT can because the
   * directory knows every tile's byte length in advance.
   */
  estimateTimeToReadyMs(range: { start: number; end: number }): number | null {
    const getThroughput = this.options.getThroughput;
    if (!getThroughput) return null;
    const { bytesPerMs } = getThroughput();
    if (!bytesPerMs) return null;
    return this.estimateCost(range).bytes / bytesPerMs;
  }

  /**
   * Drop ALL pending prefetch work (WS-C3): clears the prefetch queue,
   * aborts in-flight prefetch-tier requests (priority-tier requests are
   * untouched), and resets the prefetch runway bookkeeping so the next
   * prefetch pass re-plans from the new play-head position.
   *
   * Called automatically whenever the planned runway goes stale: a time
   * jump beyond the speed-aware seek threshold (see `update()`), a spatial
   * viewport change (pan/zoom), or a committed prefetch-direction flip.
   * These are the ONLY ways in-flight prefetch work is ever aborted —
   * `cancelSupersededRequests` exempts it (ahead-of-window is prefetch's
   * normal operating condition). Safe to call manually at any time.
   */
  flushPrefetch(): void {
    // (1) Queued-but-not-started prefetch tiles: drop their headers
    //     entirely. prefetchFutureTiles only enqueues ids with NO header, so
    //     a lingering unloaded header would permanently shadow the tile from
    //     future prefetch passes. PINNED overview headers survive — the
    //     overview tier owns them and will (re)load them itself.
    for (const id of this.prefetchQueue) {
      const key = this.tileIdToKey(id);
      const header = this.tiles.get(key);
      if (header && !header.isLoading && !header.isLoaded && !header.isPinned) {
        this.tiles.delete(key);
      }
    }
    this.prefetchQueue = [];

    // (2) In-flight prefetch-tier requests: abort the shared controller,
    //     latch isCancelled so a late resolution can't store into the
    //     registry, and drop the headers for the same reason as (1). A pinned
    //     member of an aborted batch keeps its header WITHOUT the cancel
    //     latch, so the overview drain re-fetches it on the next pass.
    //     (Overview-tier batches are never registered here, so a flush can
    //     never abort a pinned-overview fetch itself.)
    for (const inflight of this.inflightPrefetch) {
      inflight.controller.abort();
      for (const key of inflight.keys) {
        const header = this.tiles.get(key);
        if (header && !header.isLoaded && !header.isPinned) {
          header.isCancelled = true;
          this.tiles.delete(key);
        }
      }
    }

    // (3) Re-plan: clear the runway anchor so the next prefetch pass
    //     re-issues immediately, and invalidate the selection fast-path so a
    //     flushed tile that is ALSO needed at priority is re-enqueued by the
    //     next selection pass.
    this.lastPrefetchEndTime = undefined;
    this.lastSelectKey = '';
  }

  // ── Overview (storyboard) tier (WS-C4) ───────────────────────────────────

  /**
   * Eagerly load and PIN the coarsest tiles (zooms `minZoom..maxZoom`,
   * default 0..1) across the FULL dataset time range and world bounds — the
   * data player's analog of a video storyboard / thumbnail strip. Once
   * resident, the existing parent-zoom fallback in {@link getVisibleTiles}
   * renders these as the scrub preview whenever primary-zoom tiles for the
   * target time aren't loaded yet, so scrubbing always shows something.
   *
   * Budget-gated: the candidates' directory byte sum is checked BEFORE any
   * fetch, and the preload resolves `{ loaded: false, reason: 'over-budget' }`
   * when it exceeds `budgetBytes` (default 20 MiB) — some datasets have giant
   * coarse tiles (satellites z0 is ~17 MB *per tile*) that must never be
   * pinned. Fetches ride the normal coalesced-batch machinery at the LOWEST
   * tier (dispatched only when the priority queue is idle, so viewport work
   * is never starved) and the pinned headers are exempt from LRU eviction,
   * `flushPrefetch()`, and `cancelSupersededRequests()`. Pinned bytes still
   * count in cache accounting; the budget gate keeps that contribution small
   * (warns once if pinned tiles alone somehow exceed the cache limits).
   *
   * Pinned tiles deliberately do NOT count toward the primary-zoom readiness
   * APIs (`getBufferedRunway` / `estimateCost` / `getBufferedRanges`) — those
   * are honest about the PRIMARY zoom; the overview is a preview tier. (When
   * the viewport's primary zoom IS an overview zoom, normal accounting
   * applies naturally.)
   *
   * Idempotent: repeat calls return the original attempt's promise (current
   * result or still-in-flight) — nothing is fetched twice. Resolves once
   * every pinned tile's fetch has settled; a tile whose fetch ultimately
   * fails surfaces via `onTileError` but does not fail the preload
   * (best-effort, like every other tier).
   */
  preloadOverviewTier(opts?: {
    /** Reject (without fetching) above this directory byte sum. @default 20 MiB */
    budgetBytes?: number;
    /** Deepest zoom included in the overview tier. @default 1 */
    maxZoom?: number;
  }): Promise<OverviewPreloadResult> {
    if (this.overviewState) return this.overviewState.promise;

    let resolve!: (result: OverviewPreloadResult) => void;
    const promise = new Promise<OverviewPreloadResult>((r) => {
      resolve = r;
    });
    const state: OverviewState = {
      promise,
      resolve,
      settled: false,
      pendingKeys: new Set(),
      bytes: 0,
      tiles: 0,
    };
    this.overviewState = state;
    void this.startOverviewPreload(
      state,
      opts?.budgetBytes ?? DEFAULT_OVERVIEW_BUDGET_BYTES,
      opts?.maxZoom ?? DEFAULT_OVERVIEW_MAX_ZOOM,
    );
    return promise;
  }

  /** Enumerate, budget-gate, pin, and enqueue the overview candidates. */
  private async startOverviewPreload(
    state: OverviewState,
    budgetBytes: number,
    maxZoom: number,
  ): Promise<void> {
    const zooms: number[] = [];
    const zMax = Math.min(maxZoom, this.options.maxZoom);
    for (let z = Math.max(0, this.options.minZoom); z <= zMax; z++) zooms.push(z);

    // Directory slice: every overview-zoom tile, whole world, all of time —
    // the same enumeration pattern the coverage index uses (zero tile I/O).
    let ids: TileId[];
    try {
      const perZoom = await Promise.all(
        zooms.map((z) =>
          this.fetchAvailableTilesForZoom(WORLD_BOUNDS, z, { ...FULL_TIME_RANGE }),
        ),
      );
      ids = perZoom.flat();
    } catch {
      this.settleOverview(state, { loaded: false, bytes: 0, tiles: 0, reason: 'error' });
      return;
    }
    // The tileset was cleared/finalized while we awaited the directory.
    if (this.overviewState !== state || state.settled) return;

    // De-dupe defensively (directories shouldn't repeat ids, but a pinned
    // double-count would corrupt the pending bookkeeping).
    const seen = new Set<string>();
    const candidates: TileId[] = [];
    for (const id of ids) {
      const key = this.tileIdToKey(id);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(id);
    }

    if (candidates.length === 0) {
      this.settleOverview(state, { loaded: false, bytes: 0, tiles: 0, reason: 'no-tiles' });
      return;
    }

    // Budget gate on DIRECTORY bytes — decided before a single fetch.
    const getSize = this.options.getTileByteSize;
    let bytes = 0;
    for (const id of candidates) {
      bytes += (getSize ? getSize(id) : undefined) ?? 0;
    }
    state.bytes = bytes;
    state.tiles = candidates.length;
    if (bytes > budgetBytes) {
      this.settleOverview(state, {
        loaded: false,
        bytes,
        tiles: candidates.length,
        reason: 'over-budget',
      });
      return;
    }

    // Pin every candidate; queue the not-yet-loaded ones at the overview tier.
    const now = Date.now();
    for (const id of candidates) {
      const key = this.tileIdToKey(id);
      let header = this.tiles.get(key);
      if (!header) {
        header = {
          id,
          tile: null,
          isLoaded: false,
          isLoading: false,
          isCancelled: false,
          lastUsed: now,
          byteSize: 0,
        };
        this.tiles.set(key, header);
      }
      header.isPinned = true;
      header.lastUsed = now;
      if (header.isLoaded) continue; // already resident — pinning is enough
      header.isCancelled = false; // re-arm a previously cancelled header
      state.pendingKeys.add(key);
      this.overviewQueue.push(id);
    }

    if (state.pendingKeys.size === 0) {
      this.finishOverviewLoad(state);
    } else {
      this.processRequestQueue();
    }
  }

  /**
   * Dispatch queued overview-tier fetches. LOWEST tier: bails whenever
   * priority work is queued — the batch finally-handlers re-run the request
   * queue, so the overview resumes as soon as viewport work drains.
   */
  private drainOverviewQueue(): void {
    if (this.overviewQueue.length === 0) return;
    if (this.priorityQueue.length > 0) return;

    const state = this.overviewState;
    const requeue: TileId[] = [];
    const candidates: TileId[] = [];
    while (this.overviewQueue.length > 0 && candidates.length < MAX_COALESCE_BATCH) {
      const id = this.overviewQueue.shift()!;
      const key = this.tileIdToKey(id);
      const header = this.tiles.get(key);
      if (!header || header.isLoaded || header.isCancelled) {
        // Already resident (e.g. loaded via the priority path because the
        // viewport needed it too) or in a terminal state: nothing to fetch.
        state?.pendingKeys.delete(key);
        continue;
      }
      if (header.isLoading) {
        // In flight via another tier; re-checked when that request settles
        // (its finally-handler re-runs the queue → this drain).
        requeue.push(id);
        continue;
      }
      candidates.push(id);
    }
    for (const id of requeue) this.overviewQueue.push(id);

    if (candidates.length > 0) {
      // Same batch-vs-per-tile dispatch as processRequestQueue: coalesced
      // when a batch callback is wired, per-tile fallback otherwise.
      const batchFn = this.options.getTileDataBatch;
      if (!batchFn) {
        for (const id of candidates) this.startTileLoad(id, 'overview');
      } else {
        this.startTileBatch(candidates, 'overview');
      }
    }
    this.maybeFinishOverview(state);
  }

  /**
   * Mark overview keys as having reached a final state (loaded OR failed —
   * best-effort either way) and resolve the preload when none remain.
   * Called from the overview-tier fetch finally-handlers.
   */
  private settleOverviewKeys(keys: string[]): void {
    const state = this.overviewState;
    if (!state || state.settled) return;
    for (const key of keys) state.pendingKeys.delete(key);
    this.maybeFinishOverview(state);
  }

  /** Resolve the preload once every pinned tile's fetch has settled. */
  private maybeFinishOverview(state: OverviewState | null): void {
    if (!state || state.settled) return;
    if (state.pendingKeys.size === 0) this.finishOverviewLoad(state);
  }

  /**
   * Successful-completion path: sanity-check the pinned footprint against
   * the cache limits (the budget gate should make this impossible; warn once
   * if not — eviction will never reclaim pinned bytes) and resolve.
   */
  private finishOverviewLoad(state: OverviewState): void {
    this.overviewQueue = []; // anything left is already in a terminal state

    let pinnedBytes = 0;
    let pinnedCount = 0;
    for (const header of this.tiles.values()) {
      if (header.isPinned && header.isLoaded) {
        pinnedBytes += header.byteSize;
        pinnedCount++;
      }
    }
    if (
      !this.warnedPinnedOverCacheLimit &&
      (pinnedBytes > this.options.maxCacheByteSize || pinnedCount > this.options.maxCacheSize)
    ) {
      this.warnedPinnedOverCacheLimit = true;
      console.warn(
        `[Tileset] Pinned overview tier (${pinnedCount} tiles, ${pinnedBytes} bytes) ` +
          `alone exceeds the cache limits (maxCacheSize=${this.options.maxCacheSize}, ` +
          `maxCacheByteSize=${this.options.maxCacheByteSize}); eviction cannot reclaim ` +
          'pinned tiles — lower the overview budget or raise the cache limits.',
      );
    }

    this.settleOverview(state, { loaded: true, bytes: state.bytes, tiles: state.tiles });
  }

  /** Resolve the overview attempt exactly once (keeps result for repeat calls). */
  private settleOverview(state: OverviewState, result: OverviewPreloadResult): void {
    if (state.settled) return;
    state.settled = true;
    state.pendingKeys.clear();
    state.resolve(result);
  }

  /**
   * Turn on coverage tracking (idempotent) and kick an index build if a
   * viewport is already known. Tracking is lazy because the index costs one
   * extra `getAvailableTiles` call per spatial viewport change — consumers
   * that never use the buffer APIs never pay it.
   */
  private ensureBufferTracking(): void {
    this.bufferTrackingEnabled = true;
    if (this.currentViewport) {
      this.maybeRebuildCoverageIndex(this.currentViewport.bounds, this.currentViewport.zoom);
    }
  }

  /**
   * (Re)build the coverage index when the spatial viewport (bounds at the
   * primary zoom) has changed. Async — one full-time-range
   * `getAvailableTiles` query returns the directory slice for the viewport;
   * tile byte lengths come from the synchronous `getTileByteSize` lookup
   * (0 when unwired). Stale builds (superseded by a newer viewport) are
   * discarded. A cheap signature check makes repeat calls free.
   */
  private maybeRebuildCoverageIndex(bounds: BoundingBox, zoom: number): void {
    const primaryZoom = this.getZoomLevelsToLoad(zoom)[0];
    const signature =
      `${bounds.minLon}|${bounds.minLat}|${bounds.maxLon}|${bounds.maxLat}|${primaryZoom}`;
    if (this.coverageIndex?.signature === signature) return;
    if (this.coverageBuildSignature === signature) return; // build in flight
    this.coverageBuildSignature = signature;

    this.fetchAvailableTilesForZoom(bounds, primaryZoom, { ...FULL_TIME_RANGE })
      .then((ids) => {
        if (this.coverageBuildSignature !== signature) return; // superseded
        this.coverageBuildSignature = null;

        const getSize = this.options.getTileByteSize;
        const buckets = new Map<number, CoverageBucket>();
        for (const id of ids) {
          let bucket = buckets.get(id.t);
          if (!bucket) {
            bucket = { keys: [], bytes: [] };
            buckets.set(id.t, bucket);
          }
          bucket.keys.push(this.tileIdToKey(id));
          bucket.bytes.push((getSize ? getSize(id) : undefined) ?? 0);
        }
        const bucketStarts = Array.from(buckets.keys()).sort((a, b) => a - b);
        const bucketMs = this.options.temporalBucketMs;
        const timeRange =
          bucketStarts.length > 0
            ? {
                start: bucketStarts[0],
                end: bucketStarts[bucketStarts.length - 1] + bucketMs,
              }
            : null;
        this.coverageIndex = { signature, bucketStarts, buckets, timeRange };
        this.notifyBufferChange();
      })
      .catch(() => {
        // Best-effort: a failed build just leaves the previous index (or
        // none) in place; the next viewport change retries.
        if (this.coverageBuildSignature === signature) {
          this.coverageBuildSignature = null;
        }
      });
  }

  /**
   * Schedule an `onBufferChange` emission, trailing-edge throttled to
   * ≤10 Hz: the first trigger emits on the next tick; further triggers
   * inside the throttle window coalesce into one emission at its end. The
   * emitted runway probes from the play-head time the tileset already
   * tracks, in the committed prefetch direction.
   */
  private notifyBufferChange(): void {
    if (!this.options.onBufferChange) return;
    if (this.bufferChangeTimer !== null) return; // emission already queued
    const wait = Math.max(
      0,
      this.lastBufferChangeAt + BUFFER_CHANGE_THROTTLE_MS - Date.now(),
    );
    this.bufferChangeTimer = setTimeout(() => {
      this.bufferChangeTimer = null;
      this.lastBufferChangeAt = Date.now();
      const callback = this.options.onBufferChange;
      const viewport = this.currentViewport;
      if (!callback || !viewport) return;
      callback(this.getBufferedRunway(viewport.time, this.prefetchDirection));
    }, wait);
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

        // An in-flight header must never be deleted out from under its
        // batch: the batch's deliverTile() holds a direct reference and
        // would resurrect the orphan outside the registry, inflating
        // currentCacheBytes / loadedTileCount forever. It gets re-judged
        // on the pass after its load settles.
        if (!isNeeded && !isRecent && !header.isPinned && !header.isLoading) {
          tilesToEvict.push(tileKey);
        }
      }

      this.evictTiles(tilesToEvict);
      return;
    }

    // Over limits - use LRU to evict oldest tiles
    // But NEVER evict tiles in current viewport (neededTileKeys) or PINNED
    // overview tiles (the always-resident storyboard; their bytes still count
    // against the limits — the preload byte budget keeps that contribution
    // small, and preloadOverviewTier warns once if it somehow isn't).
    const sortedTiles = Array.from(this.tiles.entries())
      .filter(([key, header]) => !neededTileKeys.has(key) && !header.isPinned)
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
    let evictedLoaded = false;
    for (const tileKey of tileKeys) {
      const header = this.tiles.get(tileKey);
      if (header) {
        if (header.isLoading && !header.isLoaded) {
          // Belt-and-braces: a deleted in-flight header could still receive
          // a late deliverTile() through the batch's captured reference and
          // leak its bytes into the running counters. Latch the cancel flag
          // so that delivery no-ops. (No abort here — batch members share
          // one AbortController, and the batch may carry needed tiles.)
          header.isCancelled = true;
        }
        if (header.tile) {
          this.options.onTileUnload?.(header.tile);
          // Incrementally decrement the running counters.
          this.currentCacheBytes -= header.byteSize;
          if (header.isLoaded) this.loadedTileCount--;
          evictedLoaded = true;
        }
        this.tiles.delete(tileKey);
        this.cacheStats.evictions++;
      }
    }
    // Evicting a loaded tile can shrink the buffered runway.
    if (evictedLoaded) this.notifyBufferChange();
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
  /**
   * True when the current selection has SETTLED: nothing the selection
   * queued is still waiting to dispatch and no needed tile is in flight.
   * Mirrors upstream `Tileset2D.isLoaded` semantics including its error
   * stance — a tile whose fetch failed (after the archive's retries) or
   * was cancelled counts as settled, otherwise one permanent hole would
   * pin the signal false forever. Prefetch/overview lookahead never blocks
   * this: it is intentionally ahead of the needed set.
   */
  get isLoaded(): boolean {
    if (this.priorityQueue.length > 0) return false;
    for (const key of this.neededTileKeys) {
      if (this.tiles.get(key)?.isLoading) return false;
    }
    return true;
  }

  /**
   * Monotonic needed-set version: bumps exactly when a selection pass
   * changes WHICH tiles the viewport×window needs — never on tile arrival.
   * Stays 0 until the first selection that needs anything. Consumers pair
   * it with {@link isLoaded} to derive once-per-settle viewport-load events
   * (a settled version fires once, then re-fires only after the selection
   * itself changes — the `TileLayer.onViewportLoad` contract).
   */
  get selectionVersion(): number {
    return this.neededTilesVersion;
  }

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
      if (header.isLoading) {
        // A delivery into a cleared registry would inflate the running
        // counters forever (the header is unreachable after `tiles.clear()`).
        // Latch the cancel flag so deliverTile() no-ops, and abort the
        // transport — after clear() NOTHING in flight is wanted.
        header.isCancelled = true;
        header.abortController?.abort();
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

    // The pinned overview tier went down with the registry. Settle a
    // still-pending preload (its promise must never hang) and reset, so a
    // post-clear preloadOverviewTier() starts fresh.
    this.overviewQueue = [];
    if (this.overviewState && !this.overviewState.settled) {
      this.settleOverview(this.overviewState, {
        loaded: false,
        bytes: this.overviewState.bytes,
        tiles: this.overviewState.tiles,
        reason: 'disabled',
      });
    }
    this.overviewState = null;
    this.warnedPinnedOverCacheLimit = false;
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
    if (this.bufferChangeTimer !== null) {
      clearTimeout(this.bufferChangeTimer);
      this.bufferChangeTimer = null;
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


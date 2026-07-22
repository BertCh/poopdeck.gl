// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

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

import type { Tile, TileId, BoundingBox, TemporalLodLevel } from './types.js';
import { estimateTileSize } from './archive.js';

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
 * Hard ceiling on the prefetch horizon, expressed in temporal buckets. At very
 * fast playback the horizon terms below balloon in SIM time — a full year in
 * 120 s runs at ~2.6e5 sim-ms per real-ms, so `windowAhead` (prefetchAhead ×
 * prefetchSteps) reaches ~60 days and even the `speed × LOOKAHEAD` term reaches
 * ~24 days. Each prefetch pass then walks the directory over that whole slice
 * and sorts ~1-2k candidate tile ids ON THE MAIN THREAD, ~twice per second, per
 * tileset — a documented FPS sink (see the enumerate-every-bucket note below).
 * Bounding the horizon caps the per-pass walk+sort. Only fast demos hit it;
 * normal-speed playback stays well under the cap, and the resident-window
 * SELECTION (not prefetch) still loads cumulative "draw-and-persist" datasets
 * in full. NB the cap is NOT a pure constant: the governor's buffered-runway
 * gates are speed-scaled, so the applied cap is
 * `max(MAX_PREFETCH_BUCKETS × bucketMs, speed × PREFETCH_CAP_FLOOR_REAL_MS)`
 * — a fixed 64-bucket ceiling alone is BELOW the gates at fast playback
 * (year-in-120s with 2 h buckets consumes ~36.5 buckets/s; the resume gate
 * alone needs ~146 buckets), which would stall the gate it exists to feed.
 */
const MAX_PREFETCH_BUCKETS = 64;
/**
 * Wall-clock floor (ms) for the prefetch cap. The playback governor's gates
 * are speed-scaled: the start gate wants ~2 s of wall-clock runway buffered
 * and the resume-after-stall gate 2× that (see PlaybackGovernor's
 * startGateWallMs/resumeFactor defaults). If the capped horizon can't cover
 * the resume gate, one throughput dip ends in the full start-wait freeze and
 * then permanent degraded creep. 5 s = 4 s resume gate + 1 s margin; with the
 * 50% reload fraction the steady-state floor (~2.5 s wall) stays above the
 * 2 s start gate.
 */
const PREFETCH_CAP_FLOOR_REAL_MS = 5000;
/**
 * Re-issue the wide prefetch only after the play head has consumed this fraction
 * of the previously prefetched span. Keeps the debounced scheduler from
 * re-coalescing the same chunk ~4×/second; the wide load then happens roughly
 * once per `(1 - fraction) × LOOKAHEAD` of real time.
 */
const PREFETCH_RELOAD_FRACTION = 0.5;

/**
 * Pressure-adaptive prefetch horizon (Shaka's "shrink the goal" ladder):
 * degrade the speculative lookahead under memory pressure instead of letting
 * the cache thrash. The self-regulation loop: a full cache forces the
 * over-limit eviction pass into the protected runway (a tier-C/D eviction —
 * the thrash signal) → `prefetchPressureScale` decays by
 * {@link PRESSURE_SCALE_DECAY} (floored at {@link PRESSURE_SCALE_MIN}) →
 * the next prefetch plan reaches ahead by a shorter horizon and enqueues
 * fewer speculative tiles → the cache drops back under its limits → after
 * {@link PRESSURE_RECOVERY_QUIET_MS} of wall-clock with no runway eviction,
 * the scale recovers by {@link PRESSURE_SCALE_RECOVERY_STEP} back toward 1 —
 * rate-limited to one step per {@link PRESSURE_RECOVERY_STEP_INTERVAL_MS} of
 * WALL time (recovery paced by plan frequency rebounds floor→1 in ~2 s and
 * oscillates). While pressured (scale < 1) the scaled horizon is floored at
 * `max(bucketMs, timeWindow, speed × PREFETCH_CAP_FLOOR_REAL_MS)` so the
 * resident window keeps loading and the governor's speed-scaled gates stay
 * satisfiable — the ladder shrinks speculation, never the playhead's own
 * data. At scale 1 the ladder is a strict no-op (byte-identical horizon).
 */
const PRESSURE_SCALE_MIN = 0.25;
const PRESSURE_SCALE_DECAY = 0.7;
const PRESSURE_SCALE_RECOVERY_STEP = 0.1;
const PRESSURE_RECOVERY_QUIET_MS = 5000;
const PRESSURE_RECOVERY_STEP_INTERVAL_MS = 1000;

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
 * Spatial flush tolerance, as a FRACTION of the viewport extent. A spatial
 * viewport change flushes the prefetch runway (it was planned for the old
 * bounds — see `selectAndLoadTiles`), but a controlled camera that DRIFTS
 * smoothly (an AV ego-follow tracking the car, an easing pan) shifts the bounds
 * a sub-tile sliver every frame. Without a tolerance that flushed — and aborted
 * every in-flight prefetch — ~60×/second, so the runway could never build while
 * the camera moved and tiles loaded reactively (visible motion stutter).
 *
 * The flush decision keys on bounds QUANTIZED to this fraction of the viewport
 * span, so drift within ~1/8 of a viewport keeps the same key (no flush) while
 * a genuine pan/zoom that shifts the viewport past a grid cell — or changes
 * zoom — still crosses a cell and flushes the now-stale runway. The exact-bounds
 * `selectKey` fast-path is untouched, so tile SELECTION still tracks the true
 * viewport; only the (destructive) flush is debounced.
 */
const SPATIAL_FLUSH_TOLERANCE = 1 / 8;

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
 * How many zoom levels below the primary display zoom the 'best-available'
 * refinement strategy loads as coarse fallbacks (see getZoomLevelsToLoad).
 * 4 levels covers the common case for sparse global point datasets: a feature
 * isolated within ~150 km at z=10 typically clusters into a 2+ feature tile
 * by z=6 (300 km/cell). Higher numbers don't add load pressure (each lower
 * zoom has 4x fewer cells) but they DO grow the O(4^zDiff) ancestor-cover
 * check in getVisibleTiles, so we cap. Also the clamp ceiling for the
 * scrub-LOD spatial degrade ({@link ScrubLodOptions.spatialZoomDrop}) — a
 * drop inside this band targets tiles the parent-fallback path already
 * fetches, so a degraded scrub often needs zero new fetches.
 */
const PARENT_FALLBACK_LEVELS = 4;

/**
 * Default {@link ScrubLodOptions.spatialZoomDrop}: two zooms coarser is a
 * crisp preview at 1/16th the tile count, and stays well inside the
 * parent-fallback band (largely already-resident tiles).
 */
const DEFAULT_SCRUB_ZOOM_DROP = 2;

/**
 * Bound on how many zoom levels finer {@link SpatiotemporalTileset.getVisibleTiles}'s
 * zoom-out stand-in pass will search for an already-resident descendant tile
 * (see {@link SpatiotemporalTileset.collectLoadedDescendants}). Mirrors
 * `PARENT_FALLBACK_LEVELS`'s reasoning in spirit but capped tighter — the
 * search is a pure `this.tiles` lookup (no fetch), yet still O(4^depth) per
 * missing cell, so 2 levels (16 lookups) caps the worst case while covering
 * the common one-or-two-clicks zoom-out gesture.
 */
const CHILD_LOOKAHEAD_LEVELS = 2;

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
const WORLD_BOUNDS: BoundingBox = {
  minLon: -180,
  minLat: -90,
  maxLon: 180,
  maxLat: 90,
};

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
   * Every registry key in the index, flat — the membership test the
   * grace-period evictor uses to protect the buffered timeline (see
   * evictUnusedTiles): a tile in here is one the buffered-ranges bar reports
   * and the playback governor gates on, so reclaiming it on a wall-clock
   * timer (rather than under real memory pressure) silently un-buffers time
   * the player was told is ready.
   */
  keySet: Set<string>;
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
  /**
   * Current play-head time (sim-ms) for the process-shared request scheduler's
   * cross-source earliest-deadline-first priority (multi-source coordination,
   * Phase 2 §2.8). The tileset populates it from its current viewport time so a
   * batch implementation backed by `STTArchive.getTiles` can forward it as
   * `TileRequestOptions.playheadTime`, letting the scheduler rank range-groups
   * by distance-to-playhead comparably ACROSS archives that share this
   * play-head. Optional; implementations that don't share a scheduler ignore it.
   */
  playheadTime?: number;
  /** Play-head travel direction (+1 forward / -1 backward) paired with {@link playheadTime}. */
  playheadDirection?: 1 | -1;
  /**
   * Current viewport center (geographic). The tileset populates it from its
   * current viewport bounds so a batch implementation backed by
   * `STTArchive.getTiles` can forward it as `TileRequestOptions.viewportCenter`,
   * letting the scheduler add a small spatial tie-break — among range-groups
   * already tied in EDF/enqueue order, the one nearer the viewport center
   * resolves first (mirrors MapLibre's `coveringTiles()` distanceSq sort).
   * Optional; implementations that don't share a scheduler ignore it.
   */
  viewportCenter?: { lon: number; lat: number };
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

/**
 * Scrub-time LOD degradation — the "motion tier" served while the user drags
 * the timeline (docs/roadmap/scrub-lod-2026-07.md §5–6). Both axes default
 * OFF (the kill switch): with this option absent, {@link
 * SpatiotemporalTileset.setInteractive} stores the interactive bit and
 * changes nothing else, so today's behavior is byte-identical.
 *
 * The degraded tier is PREVIEW-ONLY (the plan's G7 contract): tile
 * SELECTION degrades while interactive, but the readiness/buffer APIs
 * (`getBufferedRunway` / `getBufferedRanges` / `estimateCost`) and the
 * prefetch planner keep measuring/warming the FINE base tier, so a
 * playback gate on scrub release re-arms against full detail — never
 * against the coarse preview.
 */
export interface ScrubLodOptions {
  /**
   * SPATIAL axis (plan P1): while interactive, drop the requested (primary)
   * zoom by {@link spatialZoomDrop} so selection targets coarser tiles —
   * usually ones the parent-fallback path already fetched.
   * @default false
   */
  spatial?: boolean;

  /**
   * Zoom levels dropped while interactive (spatial axis). Clamped to
   * `[0, PARENT_FALLBACK_LEVELS]` so the coarse target stays inside the
   * band the fallback path already loads.
   * @default 2
   */
  spatialZoomDrop?: number;

  /**
   * TEMPORAL axis (plan P2): while interactive, route selection through the
   * archive's temporal-LOD pyramid — the coarsest level covering the
   * requested zoom (the `pickTemporalLodForZoom` snap) — instead of the
   * base-bucket tiles. No-ops cleanly unless the archive was built with
   * `--temporal-lod` AND both {@link SpatiotemporalTilesetOptions.temporalLodLevels}
   * and {@link SpatiotemporalTilesetOptions.getAvailableTemporalLodTiles}
   * are wired (capability detection). Zooms dispatched to the summary tier
   * keep using it — summary is already a reduced tier.
   * @default false
   */
  temporal?: boolean;
}

export interface SpatiotemporalTilesetOptions {
  /** Maximum concurrent tile requests */
  maxRequests?: number;

  /** Debounce time in milliseconds before loading tiles */
  debounceTime?: number;

  /** Maximum number of tiles to cache */
  maxCacheSize?: number;

  /**
   * Maximum cache size in bytes (decoded tiles; default 2 GiB). Byte
   * accounting is alias-deduped (each backing buffer counted once), so
   * zero-copy datasets genuinely occupy up to this budget — the old
   * double-counting estimator made them plateau around half of it.
   * Memory-constrained deployments (mobile Safari) should set this
   * explicitly.
   */
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

  /**
   * Level-of-detail composition across zoom levels.
   * - `'parent-fallback'` (default): render the single best (highest loaded)
   *   zoom; coarser parents are transient fallbacks dropped by
   *   {@link getVisibleTiles} the moment their children finish streaming.
   * - `'additive'`: render the UNION of zoom levels `[minZoom..requestedZoom]`
   *   simultaneously and keep every level resident. For ADDITIVE-OCTREE point
   *   clouds (built with `stt-build --min-zoom-field=--max-zoom-field=<col>`),
   *   where each point lives at exactly ONE zoom: a coarse tile holds a sparse
   *   overview, finer tiles add ONLY the residual detail, so there is no
   *   double-drawing and zooming in fetches only the deeper levels (the coarse
   *   tiles are already resident from when the camera was zoomed out).
   * @default 'parent-fallback'
   */
  lodMode?: 'parent-fallback' | 'additive';

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

  /**
   * Scrub-time LOD degradation policy (see {@link ScrubLodOptions}).
   * Absent/empty = the kill switch: {@link SpatiotemporalTileset.setInteractive}
   * becomes stored state only and behavior is identical to today.
   */
  scrubLod?: ScrubLodOptions;

  /**
   * The archive's temporal-LOD pyramid levels (from
   * `ArchiveMetadata.temporalLod`), enabling the scrub-LOD temporal axis.
   * Absent for archives built without `--temporal-lod` — the temporal axis
   * then no-ops regardless of {@link scrubLod}.
   */
  temporalLodLevels?: TemporalLodLevel[];

  /**
   * Optional callback to enumerate the tiles of ONE temporal-LOD tier (wire
   * `STTArchive.getTileIdsInBoundsForTemporalLod` here). Used only while
   * interactive with `scrubLod.temporal` enabled; the base
   * {@link getAvailableTiles} keeps serving every other query (selection at
   * rest, prefetch, coverage index, overview preload).
   */
  getAvailableTemporalLodTiles?: (
    bounds: BoundingBox,
    zoom: number,
    timeRange: { start: number; end: number },
    bucketMs: number,
  ) => Promise<TileId[]>;

  /** Callback to get available raw tiles for bounds/time. */
  getAvailableTiles: (
    bounds: BoundingBox,
    zoom: number,
    timeRange: { start: number; end: number },
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
    timeRange: { start: number; end: number },
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
    hooks?: TileBatchHooks,
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

  /**
   * Loader-side fair-share weight setter, forwarded by
   * {@link SpatiotemporalTileset.setBandwidthWeight} (the governor's
   * bandwidth re-balancing hook). Wire `STTArchive.setSchedulerWeight` here
   * so a weight change re-shares this source's queued work in the
   * process-shared request scheduler immediately.
   */
  setSchedulerWeight?: (weight: number) => void;

  /** Callback when tile loads */
  onTileLoad?: (tile: Tile) => void;

  /** Callback when tile unloads */
  onTileUnload?: (tile: Tile) => void;

  /**
   * Callback on error. `tileId` is usually the failing tile; a DATASET-level
   * failure (a selection pass that could not query the directory, e.g. a
   * transient paged-leaf fetch failure) is signalled with the sentinel
   * `{x: -1, y: -1}` — this callback's signature requires a TileId, so
   * consumers keying per-tile state should ignore negative coordinates
   * (`@poopdeck.gl/layers` translates the sentinel to `undefined` at its
   * prop boundary).
   */
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

  // Cache statistics. `runwayEvictions` counts over-limit evictions that had
  // to reach INTO the protected playhead window (tiers C/D of
  // evictUnusedTiles) — the observable fetch-evict-refetch thrash signal.
  private cacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    runwayEvictions: 0,
  };

  // Animation state for prefetching
  private animationSpeed: number = 0;
  private lastUpdateTime: number = 0;
  private isAnimating: boolean = false;

  /**
   * Interactive/motion bit (scrub-LOD P0): true while the user is actively
   * scrubbing the timeline (the PlaybackGovernor broadcasts its drag bracket
   * here via {@link setInteractive}). Stored state only unless a
   * {@link ScrubLodOptions} axis is enabled.
   */
  private interactive: boolean = false;

  // Prefetch direction hysteresis. `prefetchDirection` is the committed
  // direction (+1 forward / -1 backward); `pendingFlipCount` counts how many
  // consecutive frames pointed the opposite way.
  private prefetchDirection: 1 | -1 = 1;
  private pendingFlipCount: number = 0;
  /** End of the last prefetched span in sim-time (throttle runway anchor). */
  private lastPrefetchEndTime?: number;

  /**
   * Pressure-adaptive prefetch horizon scale ∈ [{@link PRESSURE_SCALE_MIN}, 1].
   * Decayed by tier-C/D (runway) evictions, recovered by quiet prefetch plans
   * — see the PRESSURE_* constants for the full self-regulation loop.
   */
  private prefetchPressureScale = 1;
  /** Wall time of the last recovery step (rate-limits the ladder's rebound).
   * -Infinity so the first eligible step is never suppressed at epoch 0. */
  private lastPressureRecoveryAt = -Infinity;
  /** Wall time of the last tier-C/D (runway) eviction (0 = never). */
  private lastRunwayEvictionAt = 0;
  /**
   * Governor-imposed forward run-ahead cap in sim-ms, `null` = uncapped.
   * See {@link setPrefetchRunAheadLimit}.
   */
  private prefetchRunAheadLimitMs: number | null = null;

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

  /**
   * Monotonic stamp for the async `selectAndLoadTiles` pass. A pass captures it
   * before its awaited directory slice and bails if a newer pass has started by
   * the time it resolves, so a stale (slower) viewport's result can't clobber
   * the current needed-tile set. `lastSelectKey` only dedupes passes with
   * IDENTICAL params; it cannot order two concurrent different-param passes.
   */
  private selectGeneration = 0;
  /**
   * Monotonic stamp for the async `prefetchFutureTiles` pass, mirroring
   * {@link selectGeneration}: a pass captures it before its awaited
   * directory queries and bails afterwards if a newer pass — or a
   * `flushPrefetch()` (seek, spatial move, direction flip) — superseded it,
   * so a stale plan can't enqueue tiles for the wrong playhead/direction.
   */
  private prefetchGeneration = 0;

  // Separate queues for priority management
  private priorityQueue: TileId[] = []; // High priority - current time tiles
  private prefetchQueue: TileId[] = []; // Low priority - future tiles

  /**
   * Set true whenever `selectAndLoadTiles` enqueues priority tiles; cleared by
   * `sortPriorityQueueByPlayhead` after it sorts. Draining the queue (shift
   * from the front) preserves sort order, so ONLY enqueues invalidate the
   * play-head-proximity sort — this flag stops `processRequestQueue` from
   * re-sorting an unchanged queue on every batch finally-handler re-entry.
   */
  private priorityQueueDirty = false;

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
   * Viewport bounds + zoom of the previous selection pass. A SIGNIFICANT
   * change (center pan or span/zoom change beyond `SPATIAL_FLUSH_TOLERANCE` of
   * the viewport) means the prefetch runway was planned for a viewport the
   * camera has left, so it's auto-flushed (WS-C3 — "viewport is a second seek
   * axis"). A sub-tile DRIFT (follow-cam tracking the ego, easing pan) stays
   * under the tolerance and does NOT flush, so the runway survives continuous
   * camera motion. Time seeks are detected in `update()` instead, where the
   * pre-jump speed estimate is still available.
   */
  private lastSpatialBounds?: BoundingBox;
  private lastSpatialZoom?: number;

  /**
   * In-flight PREFETCH-tier requests (shared AbortController + the registry
   * keys it covers). `flushPrefetch()` aborts exactly these — priority-tier
   * requests are never touched. The same registry EXEMPTS these keys from
   * `cancelSupersededRequests`: prefetch tiles are intentionally ahead of
   * the current window, so "not in the needed set" is their normal operating
   * condition, not supersession.
   */
  private inflightPrefetch = new Set<{
    controller: AbortController;
    keys: string[];
  }>();

  /**
   * In-flight PRIORITY-tier batches. A batch shares one AbortController
   * across all members, so `cancelSupersededRequests` must judge it as a
   * whole: it aborts a batch only when EVERY member has left the needed set
   * (a seek landed elsewhere). During ordinary playback the window's
   * trailing edge always supersedes a few members per pass; aborting then
   * would kill the still-needed rest of the batch with them.
   */
  private inflightPriority = new Set<{
    controller: AbortController;
    keys: string[];
  }>();

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
      lodMode: options.lodMode ?? 'parent-fallback',
      enablePrefetch: options.enablePrefetch ?? true,
      // Defaults sized for a few real-time seconds of buffer. See the
      // matching tuning notes in SpatioTemporalLayer.defaultProps.
      prefetchAhead: options.prefetchAhead ?? 30000,
      prefetchSteps: options.prefetchSteps ?? 4,
      tier: options.tier ?? 'auto',
      summaryZoomRange: options.summaryZoomRange ?? null,
      // Scrub-LOD (motion tier): all axes default OFF — the kill switch.
      scrubLod: options.scrubLod ?? null,
      temporalLodLevels: options.temporalLodLevels ?? null,
      getAvailableTemporalLodTiles:
        options.getAvailableTemporalLodTiles ?? null,
      getAvailableTiles: options.getAvailableTiles,
      getAvailableSummaryTiles: options.getAvailableSummaryTiles ?? null,
      getTileData: options.getTileData,
      getTileDataBatch: options.getTileDataBatch ?? null,
      getTileByteSize: options.getTileByteSize ?? null,
      maxParentTileBytes:
        options.maxParentTileBytes ?? DEFAULT_MAX_PARENT_TILE_BYTES,
      onBufferChange: options.onBufferChange ?? null,
      getThroughput: options.getThroughput ?? null,
      setSchedulerWeight: options.setSchedulerWeight ?? null,
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
    if (DEBUG)
      console.log('[Tileset] setAnimationState:', {
        isAnimating,
        speed,
        enablePrefetch: this.options.enablePrefetch,
      });
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
        if (DEBUG)
          console.log(
            '[Tileset] Animation paused, ensuring current time tiles are loaded',
          );
        this.selectAndLoadTiles();
      }
    }
  }

  /**
   * Set the interactive/motion bit (scrub-LOD P0). The PlaybackGovernor
   * broadcasts `true` on beginScrub and `false` on endScrub through the
   * optional `BufferSource.setInteractive` hook, exactly like its
   * `setAnimationState` keep-alive.
   *
   * With no {@link ScrubLodOptions} axis enabled (the default) this is
   * STORED STATE ONLY — no selection change, no fetch, byte-identical
   * behavior (the kill switch). With an axis enabled, the transition
   * invalidates the selection fast-path and re-runs selection immediately:
   * on `true` the next pass serves the degraded motion tier; on `false` the
   * fine settle tier is restored without waiting for the next clock tick
   * (release must not leave a coarse selection as the priority working set
   * while the post-seek gate fills — the G7 contract).
   */
  setInteractive(interactive: boolean): void {
    if (this.interactive === interactive) return;
    this.interactive = interactive;
    if (!this.scrubLodEnabled()) return; // kill switch: bit only, zero behavior change
    this.lastSelectKey = '';
    this.selectAndLoadTiles();
  }

  /** Current interactive/motion bit (see {@link setInteractive}). */
  get isInteractive(): boolean {
    return this.interactive;
  }

  /**
   * Governor run-ahead fairness hook (optional `BufferSource` method — the
   * Shaka MAX_RUN_AHEAD analog): cap the forward prefetch horizon to at most
   * `simMs` of sim-time ahead of the playhead. In a composited scene, runway
   * buffered beyond the min-gated intersection of all required sources is
   * dead weight; the governor caps each leader near the neediest source's
   * frontier so the shared bandwidth budget flows to the laggard.
   *
   * The cap is enforced with an internal safety floor of
   * `max(bucketMs, timeWindow, |animationSpeed| × PREFETCH_CAP_FLOOR_REAL_MS)`
   * so it can never starve this tileset's own speed-scaled gates. Lowering
   * the cap below the already-planned runway flushes NOTHING — fetched tiles
   * stay resident, the cap only stops further extension. `null` clears.
   */
  setPrefetchRunAheadLimit(simMs: number | null): void {
    this.prefetchRunAheadLimitMs =
      typeof simMs === 'number' && Number.isFinite(simMs) && simMs > 0
        ? simMs
        : null;
  }

  /**
   * Update this source's fair-share weight in the process-shared request
   * scheduler (optional `BufferSource` method — the governor's bandwidth
   * re-balancing hook, effective immediately for queued work). Forwards to
   * the wired loader (normally `STTArchive.setSchedulerWeight`); no-op when
   * the {@link SpatiotemporalTilesetOptions.setSchedulerWeight} callback
   * isn't wired.
   */
  setBandwidthWeight(weight: number): void {
    this.options.setSchedulerWeight?.(weight);
  }

  /** True when ANY scrub-LOD axis is switched on (the feature's master gate). */
  private scrubLodEnabled(): boolean {
    const cfg = this.options.scrubLod;
    return !!cfg && (cfg.spatial === true || cfg.temporal === true);
  }

  /**
   * The zoom SELECTION should target: the viewport zoom, minus the scrub-LOD
   * spatial drop while interactive (plan P1, §5.2). Clamped so the drop
   * never exceeds the parent-fallback band (those coarse tiles are what the
   * fallback path already fetches — often zero new fetches) nor undershoots
   * `minZoom`. Selection-only: the coverage index, buffer/readiness APIs,
   * prefetch planner, and overview tier all keep using the undegraded zoom.
   */
  private effectiveSelectionZoom(zoom: number): number {
    if (!this.interactive) return zoom;
    const cfg = this.options.scrubLod;
    if (!cfg?.spatial) return zoom;
    const drop = Math.max(
      0,
      Math.min(
        Math.floor(cfg.spatialZoomDrop ?? DEFAULT_SCRUB_ZOOM_DROP),
        PARENT_FALLBACK_LEVELS,
      ),
    );
    return Math.max(this.options.minZoom, zoom - drop);
  }

  /**
   * The temporal-LOD bucket selection should request while interactive
   * (plan P2), or `null` for the base tier. Non-null only when: the drag is
   * held, the temporal axis is enabled, the archive declares a pyramid AND
   * the LOD enumeration callback is wired (capability detection — archives
   * built without `--temporal-lod` no-op here), and the picked level is
   * genuinely coarser than the base bucket. The pick mirrors
   * `STTArchive.pickTemporalLodForZoom`: the coarsest level whose
   * `maxZoomLevel` covers the requested (already-degraded) zoom.
   */
  private scrubTemporalLodBucketMs(selectionZoom: number): number | null {
    if (!this.interactive) return null;
    const cfg = this.options.scrubLod;
    if (!cfg?.temporal) return null;
    const levels = this.options.temporalLodLevels;
    if (!levels || levels.length === 0) return null;
    if (!this.options.getAvailableTemporalLodTiles) return null;
    let pick: TemporalLodLevel | null = null;
    for (const level of levels) {
      if (
        selectionZoom <= level.maxZoomLevel &&
        (pick === null || level.bucketMs > pick.bucketMs)
      ) {
        pick = level;
      }
    }
    if (!pick || pick.bucketMs === this.options.temporalBucketMs) return null;
    return pick.bucketMs;
  }

  /**
   * The "available tiles" call for the SELECTION pass only: while a scrub
   * holds a temporal-LOD bucket, raw-tier zooms are served from that LOD
   * tier; summary-tier zooms keep the summary dispatch (already a reduced
   * tier). Every other caller (prefetch, coverage index, overview) stays on
   * {@link fetchAvailableTilesForZoom} — the settle tier.
   */
  private async fetchSelectionTilesForZoom(
    bounds: BoundingBox,
    zoom: number,
    timeRange: { start: number; end: number },
    scrubBucketMs: number | null,
  ): Promise<TileId[]> {
    if (scrubBucketMs !== null && this.pickTierForZoom(zoom) === 'raw') {
      const ids = await this.options.getAvailableTemporalLodTiles!(
        bounds,
        zoom,
        timeRange,
        scrubBucketMs,
      );
      // `STTArchive.getTileIdsInBoundsForTemporalLod` stamps `bucketMs`
      // itself; normalize for custom callbacks so a LOD id can never alias
      // a base tile's keys (tileIdToKey folds the bucket in).
      return ids.map((id) =>
        id.bucketMs === undefined ? { ...id, bucketMs: scrubBucketMs } : id,
      );
    }
    return this.fetchAvailableTilesForZoom(bounds, zoom, timeRange);
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
  update(
    viewport: {
      bounds: BoundingBox;
      zoom: number;
      time: number;
      timeWindow: number;
    },
    skipDebounce: boolean = false,
  ): number {
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

    // ADDITIVE-OCTREE LOD: load the FULL union [minZoom..clampedZoom]. Each
    // point lives at exactly one home zoom, so every level contributes distinct
    // points and they are all kept resident + rendered together (no parent
    // de-dup in getVisibleTiles). Zooming in only adds the new deepest levels;
    // the coarse levels were already fetched when the camera was zoomed out.
    if (this.options.lodMode === 'additive') {
      const zoomLevels: number[] = [];
      for (let z = clampedZoom; z >= minZoom; z--) zoomLevels.push(z);
      return zoomLevels;
    }

    // 'best-available': primary zoom + up to PARENT_FALLBACK_LEVELS parents
    // (see the module constant for the sizing rationale).
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
    // Additive LOD: coarse levels are intentional (the sparse overview), not
    // throwaway fallbacks — never skip them. They are also small by construction
    // (one representative per coarse voxel), so the oversize concern doesn't apply.
    if (this.options.lodMode === 'additive') return false;
    if (tileId.z >= primaryZoom) return false; // primary (or deeper) — always load
    const getSize = this.options.getTileByteSize;
    if (!getSize) return false;
    const bytes = getSize(tileId);
    return bytes !== undefined && bytes > this.options.maxParentTileBytes;
  }

  /**
   * Quantize the viewport bounds to a ~{@link SPATIAL_FLUSH_TOLERANCE} grid of
   * their own extent, yielding a signature that is STABLE under sub-tile camera
   * drift (an AV ego-follow tracking the car, an easing pan) but that changes
   * once the viewport pans past ~1/8 of its span or the zoom changes. Used as
   * the coverage-index signature so a smoothly drifting camera doesn't re-run
   * the FULL-time-range directory slice (the heaviest query in the system) on
   * every ~10 Hz selection pass — the buffered-runway estimate is a viewport
   * approximation that tolerates sub-tile slack. This mirrors the tolerance the
   * prefetch flush applies via its own center/span-delta check in
   * `selectAndLoadTiles` (which can't be a grid key — it needs the pre-move
   * bounds to measure drift, not a quantized snapshot).
   */
  private quantizedSpatialKey(bounds: BoundingBox, zoom: number): string {
    const lonSpan = bounds.maxLon - bounds.minLon || 1e-9;
    const latSpan = bounds.maxLat - bounds.minLat || 1e-9;
    const qLon = lonSpan * SPATIAL_FLUSH_TOLERANCE;
    const qLat = latSpan * SPATIAL_FLUSH_TOLERANCE;
    return (
      `${Math.round(bounds.minLon / qLon)}|${Math.round(bounds.minLat / qLat)}` +
      `|${Math.round(bounds.maxLon / qLon)}|${Math.round(bounds.maxLat / qLat)}|${zoom}`
    );
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

    // Scrub-LOD motion tier (docs/roadmap/scrub-lod-2026-07.md): while the
    // interactive bit is held AND an axis is enabled, SELECTION degrades —
    // a coarser requested zoom (P1) and/or the temporal-LOD pyramid tier
    // (P2). Both resolve to the pass-through values when off, and both are
    // selection-only: coverage/runway math, prefetch, and the overview tier
    // stay on the fine settle tier (the G7 preview-only contract).
    const selectionZoom = this.effectiveSelectionZoom(zoom);
    const scrubBucketMs = this.scrubTemporalLodBucketMs(selectionZoom);

    // Cheap fast-path: when the (bounds, zoom, time-range) signature is
    // identical to the previous call we'd just rebuild the same
    // `neededTileKeys` set and recompute equality. Skip the awaited
    // `getAvailableTiles` chain entirely. Running on a TimeController
    // tick that hasn't crossed a bucket boundary, this is the common
    // case and the await round-trip is the dominant cost. The scrub-LOD
    // degrade state is part of the signature so an interactive toggle
    // between identical viewports still reselects.
    const selectKey =
      `${bounds.minLon}|${bounds.minLat}|${bounds.maxLon}|${bounds.maxLat}` +
      `|${zoom}|${selectionZoom}|${scrubBucketMs ?? ''}|${timeRange.start}|${timeRange.end}`;
    if (selectKey === this.lastSelectKey) {
      return;
    }

    // Spatial viewport change (pan/zoom): the prefetch runway was planned for
    // the previous viewport, so a real move now warms tiles the camera has left
    // — flush it and let the next prefetch pass re-plan (WS-C3, "viewport is a
    // second seek axis"). But flush ONLY on a SIGNIFICANT change: the center
    // panned, or the span/zoom changed, by more than SPATIAL_FLUSH_TOLERANCE of
    // the viewport extent. A controlled camera that DRIFTS a sub-tile sliver per
    // frame (follow-cam, easing pan) stays under the tolerance and keeps its
    // prefetch — without this it flushed (and aborted every in-flight prefetch)
    // ~60×/s, so the runway never built while the camera moved. Time SEEKS are
    // detected in update() instead (speed-aware, before the jump poisons the
    // speed estimate). flushPrefetch clears lastSelectKey, so assign it AFTER.
    const prev = this.lastSpatialBounds;
    let spatialFlush = false;
    if (prev !== undefined) {
      const lonSpan = Math.max(
        bounds.maxLon - bounds.minLon,
        prev.maxLon - prev.minLon,
        1e-9,
      );
      const latSpan = Math.max(
        bounds.maxLat - bounds.minLat,
        prev.maxLat - prev.minLat,
        1e-9,
      );
      const dCenterLon =
        Math.abs(bounds.minLon + bounds.maxLon - (prev.minLon + prev.maxLon)) /
        2;
      const dCenterLat =
        Math.abs(bounds.minLat + bounds.maxLat - (prev.minLat + prev.maxLat)) /
        2;
      const dSpanLon = Math.abs(
        bounds.maxLon - bounds.minLon - (prev.maxLon - prev.minLon),
      );
      const dSpanLat = Math.abs(
        bounds.maxLat - bounds.minLat - (prev.maxLat - prev.minLat),
      );
      spatialFlush =
        zoom !== this.lastSpatialZoom ||
        dCenterLon > lonSpan * SPATIAL_FLUSH_TOLERANCE ||
        dCenterLat > latSpan * SPATIAL_FLUSH_TOLERANCE ||
        dSpanLon > lonSpan * SPATIAL_FLUSH_TOLERANCE ||
        dSpanLat > latSpan * SPATIAL_FLUSH_TOLERANCE;
    }
    if (spatialFlush) {
      this.flushPrefetch();
    }
    // Copy (not alias) — the layer reuses its cached bounds object across frames.
    this.lastSpatialBounds = {
      minLon: bounds.minLon,
      minLat: bounds.minLat,
      maxLon: bounds.maxLon,
      maxLat: bounds.maxLat,
    };
    this.lastSpatialZoom = zoom;
    this.lastSelectKey = selectKey;

    // Keep the coverage index aligned with the spatial viewport (no-op until
    // a buffer API or onBufferChange enables tracking; cheap signature check
    // thereafter).
    if (this.bufferTrackingEnabled) {
      this.maybeRebuildCoverageIndex(bounds, zoom);
    }

    // Get zoom levels to load (supports LOD with parent tiles). The first
    // entry is the primary (clamped display) zoom; the rest are coarser
    // parents. Built from the (possibly scrub-degraded) selection zoom.
    const zoomLevels = this.getZoomLevelsToLoad(selectionZoom);
    const primaryZoom = zoomLevels[0];

    // Mark tiles as used (for LRU)
    const now = Date.now();
    const neededTileKeys = new Set<string>();

    // Generation guard: this method is async (the getAvailableTiles slice can
    // be a real network round-trip for paged directories), so two passes for
    // DIFFERENT viewports may be in flight at once. If the earlier (now stale)
    // one resolves LAST it would clobber `neededTileKeys` and the queues with
    // the wrong viewport's tiles. Stamp this pass and bail after the await once
    // a newer selection supersedes it. (`lastSelectKey` only dedupes passes
    // with IDENTICAL params; it cannot order concurrent different-param ones.)
    const generation = ++this.selectGeneration;

    // Query available tiles for ALL zoom levels IN PARALLEL
    // This is much faster than sequential queries, especially for initial load.
    // Dispatches between raw and summary tiers per zoom based on the
    // configured tier setting (see pickTierForZoom).
    let tileIdsByZoom: Array<{ zoom: number; tileIds: TileId[] }>;
    try {
      tileIdsByZoom = await Promise.all(
        zoomLevels.map(async (z) => ({
          zoom: z,
          tileIds: await this.fetchSelectionTilesForZoom(
            bounds,
            z,
            timeRange,
            scrubBucketMs,
          ),
        })),
      );
    } catch (error) {
      // A transient directory failure (e.g. a paged-leaf range request
      // blipping) used to escape as an unhandled rejection — no caller
      // awaits this method — and the selection pass silently died. Worse,
      // `lastSelectKey` was stamped above, so the next identical update()
      // short-circuited on the fast path and never retried. Clear the key
      // (only if no newer pass superseded us — its key is the current
      // truth) so the next update() re-runs the selection, and surface the
      // failure through the existing per-tile error channel. The sentinel
      // x/y of -1 marks a selection-pass failure: no single tile is
      // implicated. Aborts are expected supersession, not errors.
      if (generation === this.selectGeneration) this.lastSelectKey = '';
      if (!(error instanceof Error) || error.name !== 'AbortError') {
        this.options.onTileError?.(
          error instanceof Error ? error : new Error(String(error)),
          { z: zoom, x: -1, y: -1, t: time },
        );
      }
      return;
    }

    // A newer selection started while we awaited — its viewport is the current
    // truth. Drop this stale result before it mutates any shared state.
    if (generation !== this.selectGeneration) return;

    // Queue-membership snapshots so the promote-from-prefetch branch below is
    // O(N + Q) instead of O(N·Q): the old code did a `.some()` over the
    // priority queue AND a `.findIndex()` over the prefetch queue PER candidate
    // (and the playhead sweeping into a band of prefetched buckets promotes many
    // tiles at once). We test membership against these Sets and batch the
    // prefetch removals into ONE filter pass after the loop — mirroring the
    // `queuedKeys` pattern prefetchFutureTiles already uses.
    const priorityKeys = new Set<string>();
    for (const qid of this.priorityQueue)
      priorityKeys.add(this.tileIdToKey(qid));
    const prefetchKeys = new Set<string>();
    for (const qid of this.prefetchQueue)
      prefetchKeys.add(this.tileIdToKey(qid));
    const promotedFromPrefetch = new Set<string>();
    let enqueuedPriority = false;

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
          if (z === selectionZoom) {
            // Primary zoom - front of priority queue
            this.priorityQueue.unshift(tileId);
          } else {
            // Parent zoom - back of priority queue (still before prefetch)
            this.priorityQueue.push(tileId);
          }
          priorityKeys.add(key);
          enqueuedPriority = true;
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

            // Promote to priority unless it is already loading or already
            // queued at priority. Membership is tested against the Sets built
            // before the loop (O(1)) rather than scanning the queues per tile.
            if (!header.isLoading && !priorityKeys.has(key)) {
              // Mark for removal from the prefetch queue (batched into one
              // filter pass after the loop) instead of an O(Q) splice here.
              if (prefetchKeys.has(key)) {
                promotedFromPrefetch.add(key);
                prefetchKeys.delete(key);
              }
              // Enqueue at priority (front for primary zoom).
              if (z === selectionZoom) {
                this.priorityQueue.unshift(tileId);
              } else {
                this.priorityQueue.push(tileId);
              }
              priorityKeys.add(key);
              enqueuedPriority = true;
            }
          }
        }
      }
    }

    // Drop the promoted tiles from the prefetch queue in a single O(Q) pass
    // (they are now queued at priority) instead of an O(Q) splice per tile.
    if (promotedFromPrefetch.size > 0) {
      this.prefetchQueue = this.prefetchQueue.filter(
        (qid) => !promotedFromPrefetch.has(this.tileIdToKey(qid)),
      );
    }

    // A fresh priority enqueue makes the play-head-proximity sort stale; flag
    // it so the next processRequestQueue re-sorts (and only then). See
    // sortPriorityQueueByPlayhead.
    if (enqueuedPriority) this.priorityQueueDirty = true;

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

    // Get zoom levels to prefetch. Deliberately the UNdegraded viewport zoom
    // even mid-scrub: prefetch is what warms the FINE settle tier while a
    // settle-commit gate holds (scrub-LOD G7 — the coarse motion tier is
    // selection-only and preview-only).
    const zoomLevels = this.getZoomLevelsToLoad(zoom);
    const primaryZoom = zoomLevels[0];
    const now = Date.now();

    // How far ahead to prefetch, in SIM time. During a running animation, cover
    // a fixed slice of REAL playback time (speed × LOOKAHEAD) so a fast scrub
    // prefetches one big contiguous chunk that coalesces into a few range
    // requests. Fall back to the configured window-based lookahead when paused
    // (speed ≈ 0) so a stationary view still warms its immediate neighbourhood.
    const speed = Math.abs(this.animationSpeed); // sim-ms per real-ms
    const windowAhead =
      (prefetchAhead > 0 ? prefetchAhead : timeWindow) * prefetchSteps;
    let effectiveAhead = Math.max(
      windowAhead,
      speed * PREFETCH_LOOKAHEAD_REAL_MS,
    );
    // Bound the horizon (see MAX_PREFETCH_BUCKETS) so a fast playback can't
    // inflate it to tens of days — which would make each pass walk+sort the
    // directory over that whole slice on the main thread. The speed-scaled
    // floor keeps the cap from undercutting the governor's speed-scaled
    // buffered-runway gates at very fast playback.
    const bucketMs = this.options.temporalBucketMs;
    if (bucketMs > 0) {
      effectiveAhead = Math.min(
        effectiveAhead,
        Math.max(
          MAX_PREFETCH_BUCKETS * bucketMs,
          speed * PREFETCH_CAP_FLOOR_REAL_MS,
        ),
      );
    }
    // Governor run-ahead fairness cap (see setPrefetchRunAheadLimit). The
    // internal safety floor keeps a cooperating-but-misjudged cap from
    // starving this tileset's own speed-scaled gates: the horizon never drops
    // below the resident window nor below what the governor's wall-clock
    // gates consume at the current speed (same sizing as the bucket cap
    // above — see PREFETCH_CAP_FLOOR_REAL_MS).
    if (this.prefetchRunAheadLimitMs !== null) {
      effectiveAhead = Math.min(
        effectiveAhead,
        Math.max(
          this.prefetchRunAheadLimitMs,
          bucketMs,
          timeWindow,
          speed * PREFETCH_CAP_FLOOR_REAL_MS,
        ),
      );
    }
    // Pressure ladder (see the PRESSURE_* constants): recover the scale when
    // no runway eviction happened recently — at most one step per
    // PRESSURE_RECOVERY_STEP_INTERVAL_MS of wall time, NOT per plan (plans
    // fire every ~250 ms during playback, which would rebound the scale from
    // floor to 1 in ~2 s and oscillate fetch→evict indefinitely under
    // sustained pressure). Then apply the scale AFTER every cap so pressure
    // always shrinks the final horizon. At scale 1 the branch is skipped
    // entirely — the un-pressured horizon must stay byte-identical to the
    // pre-ladder behavior (no floor may RAISE it). Under pressure the floor
    // keeps the resident window loading and — same sizing as the run-ahead
    // cap above — never shrinks below what the governor's speed-scaled
    // wall-clock gates consume, so a decay step can't turn a recoverable
    // stall into the maxStartWaitMs escape hatch at high sim-speed.
    if (
      this.prefetchPressureScale < 1 &&
      now - this.lastRunwayEvictionAt >= PRESSURE_RECOVERY_QUIET_MS &&
      now - this.lastPressureRecoveryAt >= PRESSURE_RECOVERY_STEP_INTERVAL_MS
    ) {
      this.prefetchPressureScale = Math.min(
        1,
        this.prefetchPressureScale + PRESSURE_SCALE_RECOVERY_STEP,
      );
      this.lastPressureRecoveryAt = now;
    }
    if (this.prefetchPressureScale < 1) {
      effectiveAhead = Math.max(
        effectiveAhead * this.prefetchPressureScale,
        bucketMs,
        timeWindow,
        speed * PREFETCH_CAP_FLOOR_REAL_MS,
      );
    }
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

    if (DEBUG)
      console.log('[Tileset] Wide-range prefetch:', {
        time: new Date(time).toISOString(),
        zoomLevels,
        fullRangeStart: new Date(fullRange.start).toISOString(),
        fullRangeEnd: new Date(fullRange.end).toISOString(),
      });

    const generation = ++this.prefetchGeneration;
    const results = await Promise.allSettled(
      zoomLevels.map(async (z) => {
        const tileIds = await this.fetchAvailableTilesForZoom(
          bounds,
          z,
          fullRange,
        );
        return { zoom: z, tileIds };
      }),
    );

    // A flush (seek / spatial move / direction flip) or a newer prefetch
    // pass superseded this plan while we awaited the directory queries —
    // enqueuing its candidates now would warm buckets for a stale playhead
    // or direction (and recreate headers flushPrefetch just dropped).
    if (generation !== this.prefetchGeneration) return;

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
    if (
      newTilesAdded >= prefetchBudget &&
      this.lastPrefetchEndTime === prefetchEndTime
    ) {
      this.lastPrefetchEndTime =
        time + direction * (coveredAheadMs + this.options.temporalBucketMs);
    }

    // Log prefetch results
    if (DEBUG) {
      console.log('[Tileset] Prefetch results:', {
        totalTilesFound,
        newTilesAdded,
        prefetchQueueLength: this.prefetchQueue.length,
      });
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
    if (
      DEBUG &&
      (this.priorityQueue.length > 0 || this.prefetchQueue.length > 0)
    ) {
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
      const availableSlots =
        this.options.maxRequests - this.activeRequests.size;
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
      while (
        this.priorityQueue.length > 0 &&
        candidates.length < MAX_COALESCE_BATCH
      ) {
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
      while (
        this.prefetchQueue.length > 0 &&
        candidates.length < MAX_COALESCE_BATCH
      ) {
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
    if (bytesPerMs === null || bytesPerMs <= 0)
      return PREFETCH_SLICE_COLD_BYTES;
    return Math.min(
      PREFETCH_SLICE_MAX_BYTES,
      Math.max(
        PREFETCH_SLICE_MIN_BYTES,
        bytesPerMs * PREFETCH_SLICE_TARGET_REAL_MS,
      ),
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
    // Only re-sort when a selection has added priority tiles since the last
    // sort. processRequestQueue calls this on every re-entry (each batch's
    // finally-handler), but draining the queue (shift from the front) keeps it
    // sorted, so re-sorting an unchanged queue is wasted O(Q log Q). Enqueues
    // happen only in selectAndLoadTiles, which sets the dirty flag.
    if (!this.priorityQueueDirty) return;
    this.priorityQueueDirty = false;
    const { time, zoom } = this.currentViewport;
    // Class boundary matches what selection enqueued: the (possibly
    // scrub-degraded) primary zoom, so a coarse motion-tier primary still
    // sorts ahead of its parents during a drag.
    const primaryZoom = this.getZoomLevelsToLoad(
      this.effectiveSelectionZoom(zoom),
    )[0];
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
  private startTileLoad(
    tileId: TileId,
    tier: RequestTier = 'priority',
  ): boolean {
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
    this.options
      .getTileData(tileId, abortController.signal)
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
  private startTileBatch(
    tileIds: TileId[],
    tier: RequestTier = 'priority',
  ): number {
    const batchFn = this.options.getTileDataBatch;
    if (!batchFn) return 0;

    // Filter to loadable tiles, marking each as loading under ONE shared abort.
    const abortController = new AbortController();
    const started: {
      id: TileId;
      key: string;
      header: SpatiotemporalTileHeader;
    }[] = [];
    for (const tileId of tileIds) {
      const key = this.tileIdToKey(tileId);
      const header = this.tiles.get(key);
      if (
        !header ||
        header.isLoading ||
        header.isLoaded ||
        header.isCancelled
      ) {
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
    const inflightRecord = {
      controller: abortController,
      keys: started.map((s) => s.key),
    };
    const registry =
      tier === 'prefetch'
        ? this.inflightPrefetch
        : tier === 'priority'
          ? this.inflightPriority
          : null;
    if (registry) registry.add(inflightRecord);

    // TEMP-DIAGNOSTIC (flash repro): record batch dispatches per tier with
    // queue state, so offline analysis can see whether the play head is being
    // served by prefetch (ahead-of-time) or priority (on-demand) loads.
    const probeBatch = (
      globalThis as unknown as {
        __sttProbe?: { enabled?: boolean; batches?: unknown[] };
      }
    ).__sttProbe;
    const probeT0 = typeof performance !== 'undefined' ? performance.now() : 0;
    if (probeBatch?.enabled && Array.isArray(probeBatch.batches)) {
      probeBatch.batches.push({
        wall: probeT0,
        tier,
        n: started.length,
        prioQ: this.priorityQueue.length,
        prefQ: this.prefetchQueue.length,
        sim: this.currentViewport?.time,
        ts: started.map((s) => s.id.t),
      });
    }

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
        // Cross-source EDF hint (multi-source coordination, Phase 2 §2.8): the
        // current play-head time + committed prefetch direction, so a batch
        // backed by a shared-scheduler archive can rank range-groups by
        // distance-to-playhead comparably across archives. Forwarded by the
        // layer's getTileDataBatch into STTArchive.getTiles({playheadTime}).
        playheadTime: this.currentViewport?.time,
        playheadDirection: this.prefetchDirection,
        // Spatial scheduler tie-break (perf research 2026-07): among
        // range-groups already tied in EDF/enqueue order, the one nearer the
        // viewport center resolves first. Forwarded the same way as
        // playheadTime, into STTArchive.getTiles({viewportCenter}).
        viewportCenter: this.currentViewport
          ? {
              lon:
                (this.currentViewport.bounds.minLon +
                  this.currentViewport.bounds.maxLon) /
                2,
              lat:
                (this.currentViewport.bounds.minLat +
                  this.currentViewport.bounds.maxLat) /
                2,
            }
          : undefined,
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
        if (tier === 'overview')
          this.settleOverviewKeys(started.map((s) => s.key));
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
  getBufferedRunway(
    time: number,
    direction: 1 | -1,
    horizonSimMs?: number,
  ): BufferedRunway {
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
      return {
        simMs: 0,
        bytesPending: 0,
        horizonSimMs: horizon,
        complete: false,
      };
    }
    if (idx.timeRange === null) {
      // The viewport has no tiles at ANY time: nothing can be missing.
      return {
        simMs: horizon,
        bytesPending: 0,
        horizonSimMs: horizon,
        complete: true,
      };
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
  getBufferedRanges(opts?: {
    maxRanges?: number;
  }): Array<{ start: number; end: number }> {
    this.ensureBufferTracking();
    const idx = this.coverageIndex;
    if (!idx || idx.timeRange === null) return [];
    const maxRanges = Math.max(
      1,
      Math.floor(opts?.maxRanges ?? DEFAULT_MAX_BUFFERED_RANGES),
    );
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
  estimateCost(range: { start: number; end: number }): {
    bytes: number;
    tiles: number;
  } {
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
    //     next selection pass. Bump the prefetch generation so an in-flight
    //     prefetchFutureTiles pass (awaiting its directory queries) drops
    //     its now-stale plan instead of enqueuing against the flushed state.
    this.prefetchGeneration++;
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
    for (let z = Math.max(0, this.options.minZoom); z <= zMax; z++)
      zooms.push(z);

    // Directory slice: every overview-zoom tile, whole world, all of time —
    // the same enumeration pattern the coverage index uses (zero tile I/O).
    let ids: TileId[];
    try {
      const perZoom = await Promise.all(
        zooms.map((z) =>
          this.fetchAvailableTilesForZoom(WORLD_BOUNDS, z, {
            ...FULL_TIME_RANGE,
          }),
        ),
      );
      ids = perZoom.flat();
    } catch {
      this.settleOverview(state, {
        loaded: false,
        bytes: 0,
        tiles: 0,
        reason: 'error',
      });
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
      this.settleOverview(state, {
        loaded: false,
        bytes: 0,
        tiles: 0,
        reason: 'no-tiles',
      });
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
    while (
      this.overviewQueue.length > 0 &&
      candidates.length < MAX_COALESCE_BATCH
    ) {
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
      (pinnedBytes > this.options.maxCacheByteSize ||
        pinnedCount > this.options.maxCacheSize)
    ) {
      this.warnedPinnedOverCacheLimit = true;
      console.warn(
        `[Tileset] Pinned overview tier (${pinnedCount} tiles, ${pinnedBytes} bytes) ` +
          `alone exceeds the cache limits (maxCacheSize=${this.options.maxCacheSize}, ` +
          `maxCacheByteSize=${this.options.maxCacheByteSize}); eviction cannot reclaim ` +
          'pinned tiles — lower the overview budget or raise the cache limits.',
      );
    }

    this.settleOverview(state, {
      loaded: true,
      bytes: state.bytes,
      tiles: state.tiles,
    });
  }

  /** Resolve the overview attempt exactly once (keeps result for repeat calls). */
  private settleOverview(
    state: OverviewState,
    result: OverviewPreloadResult,
  ): void {
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
      this.maybeRebuildCoverageIndex(
        this.currentViewport.bounds,
        this.currentViewport.zoom,
      );
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
    // Deliberately the UNdegraded zoom: the coverage index (and every
    // readiness API on top of it) stays honest about the FINE primary tier
    // even while a scrub-LOD drag degrades selection (G7 — gates on release
    // must re-arm against full detail, never the coarse preview).
    const primaryZoom = this.getZoomLevelsToLoad(zoom)[0];
    // Quantize to the SAME tolerance the prefetch flush applies (see
    // quantizedSpatialKey): a smoothly drifting camera (AV ego-follow, eased
    // pan) otherwise re-runs this FULL-time-range directory slice — the
    // heaviest getAvailableTiles query in the system — on every ~10 Hz
    // selection pass, even though the buffered-runway estimate tolerates
    // sub-tile spatial slack. A real pan/zoom past ~1/8 of the viewport (or any
    // zoom change) still moves the key and rebuilds.
    const signature = this.quantizedSpatialKey(bounds, primaryZoom);
    if (this.coverageIndex?.signature === signature) return;
    if (this.coverageBuildSignature === signature) return; // build in flight
    this.coverageBuildSignature = signature;

    this.fetchAvailableTilesForZoom(bounds, primaryZoom, { ...FULL_TIME_RANGE })
      .then((ids) => {
        if (this.coverageBuildSignature !== signature) return; // superseded
        this.coverageBuildSignature = null;

        const getSize = this.options.getTileByteSize;
        const buckets = new Map<number, CoverageBucket>();
        const keySet = new Set<string>();
        for (const id of ids) {
          let bucket = buckets.get(id.t);
          if (!bucket) {
            bucket = { keys: [], bytes: [] };
            buckets.set(id.t, bucket);
          }
          const key = this.tileIdToKey(id);
          bucket.keys.push(key);
          keySet.add(key);
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
        this.coverageIndex = {
          signature,
          bucketStarts,
          buckets,
          keySet,
          timeRange,
        };
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
   * Evict cached tiles: a wall-clock grace timer while under the cache
   * limits, a playhead-relative tiered policy (never plain LRU — see the
   * over-limit branch) once over them.
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

      // Tiles in the coverage index (current viewport at the primary zoom,
      // FULL time range) are exempt from the wall-clock grace timer: they are
      // exactly the tiles getBufferedRanges() reports as buffered and the
      // PlaybackGovernor gates on, so timing them out un-buffers time the
      // player was just told is ready — the runway evaporates while paused
      // (30 s grace) or whenever playback hasn't reached a prefetched bucket
      // within 2 min, and the bar visibly drops ranges ahead of the playhead
      // before the priority path re-fetches the same bytes. Video players
      // trim the back/forward buffer by SIZE, never by wall-clock age; the
      // over-limit LRU below still reclaims these under real memory
      // pressure. Tiles from previous viewports are not in the index and
      // still age out on the timer. (`coverageIndex` is null for consumers
      // that never touch the buffer APIs — their behavior is unchanged.)
      const bufferedKeys = this.coverageIndex?.keySet;

      for (const [tileKey, header] of this.tiles) {
        const isNeeded =
          neededTileKeys.has(tileKey) || (bufferedKeys?.has(tileKey) ?? false);
        const isRecent = now - header.lastUsed < GRACE_PERIOD;

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

    // Over limits — evict by a PLAYHEAD-RELATIVE, coverage-protected tiered
    // policy, not plain LRU. Under memory pressure the runway just prefetched
    // ahead of the playhead is the most valuable content in the cache; plain
    // LRU reclaims exactly that (prefetched = least-recently *touched*), and
    // the priority path then re-fetches the same bytes seconds later — the
    // multi-dataset "flashing tiles" thrash. Media players trim the buffer
    // relative to the playhead instead (back-buffer first, distant
    // speculation next, the imminent window last). Candidates: NEVER tiles in
    // the current viewport (neededTileKeys) or PINNED overview tiles (the
    // always-resident storyboard; their bytes still count against the limits
    // — the preload byte budget keeps that contribution small, and
    // preloadOverviewTier warns once if it somehow isn't), and never
    // in-flight headers (see the under-limit note above).
    const candidates: Array<[string, SpatiotemporalTileHeader]> = [];
    for (const [key, header] of this.tiles) {
      if (
        !neededTileKeys.has(key) &&
        !header.isPinned &&
        !header.isLoading &&
        header.isLoaded
      ) {
        candidates.push([key, header]);
      }
    }

    const coverageKeys = this.coverageIndex?.keySet;
    const playhead = this.currentViewport?.time;
    const bucketMs = this.options.temporalBucketMs;

    // Ordered eviction plan. `runway` marks tiers C/D — evictions that reach
    // into the protected playhead window (the thrash signal).
    let plan: Array<{ key: string; header: SpatiotemporalTileHeader }>;
    let runwayFrom: number;

    if (!coverageKeys || playhead === undefined) {
      // No coverage index / no playhead (consumers that never touch the
      // buffer APIs): the original LRU behavior, unchanged.
      plan = candidates
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed) // Oldest first
        .map(([key, header]) => ({ key, header }));
      runwayFrom = plan.length; // nothing counts as a runway eviction
    } else {
      const direction = this.prefetchDirection;
      const timeWindow = this.currentViewport?.timeWindow ?? bucketMs;
      // Back-buffer keep + protected forward window, in sim-ms. A tile's
      // bucket spans [t, t + bucketMs]; distances are signed along the
      // committed playback direction.
      const keepBehind = Math.max(timeWindow, bucketMs);
      const protectedAhead = Math.max(timeWindow, 2 * bucketMs);

      type Ranked = {
        key: string;
        header: SpatiotemporalTileHeader;
        metric: number;
      };
      const tierA: Ranked[] = []; // non-coverage (stale viewports/zooms)
      const tierB: Ranked[] = []; // coverage, far behind the playhead
      const tierC: Ranked[] = []; // coverage, far ahead (distant speculation)
      const tierD: Ranked[] = []; // near-playhead protected window
      for (const [key, header] of candidates) {
        const t = header.id.t;
        if (!coverageKeys.has(key) || !Number.isFinite(t)) {
          // A timeless header can't be placed on the timeline; rank it with
          // the stale tiles.
          tierA.push({ key, header, metric: header.lastUsed });
          continue;
        }
        const behind = direction > 0 ? playhead - (t + bucketMs) : t - playhead;
        const ahead = direction > 0 ? t - playhead : playhead - (t + bucketMs);
        if (behind > keepBehind) {
          tierB.push({ key, header, metric: behind });
        } else if (ahead > protectedAhead) {
          tierC.push({ key, header, metric: ahead });
        } else {
          tierD.push({ key, header, metric: header.lastUsed });
        }
      }
      tierA.sort((a, b) => a.metric - b.metric); // LRU: oldest first
      tierB.sort((a, b) => b.metric - a.metric); // furthest behind first
      tierC.sort((a, b) => b.metric - a.metric); // furthest ahead first
      tierD.sort((a, b) => a.metric - b.metric); // LRU (last resort)

      plan = [...tierA, ...tierB, ...tierC, ...tierD];
      runwayFrom = tierA.length + tierB.length;
    }

    const tilesToEvict: string[] = [];
    let runwayEvicted = false;

    for (let i = 0; i < plan.length; i++) {
      // Check if we're still over limits
      const stillOverSize = loadedCount > this.options.maxCacheSize;
      const stillOverBytes = cacheBytes > this.options.maxCacheByteSize;

      if (!stillOverSize && !stillOverBytes) {
        break; // We're under limits now, stop evicting
      }

      const { key, header } = plan[i];
      tilesToEvict.push(key);
      loadedCount--;
      cacheBytes -= header.byteSize;
      if (i >= runwayFrom) {
        this.cacheStats.runwayEvictions++;
        runwayEvicted = true;
      }
    }

    // A tier-C/D eviction means the limits forced us into the protected
    // runway: shrink the prefetch horizon (degrade speculation) instead of
    // letting the fetch-evict-refetch loop continue. Recovery happens in
    // prefetchFutureTiles after PRESSURE_RECOVERY_QUIET_MS of quiet — see the
    // PRESSURE_* constants for the full loop.
    if (runwayEvicted) {
      this.prefetchPressureScale = Math.max(
        PRESSURE_SCALE_MIN,
        this.prefetchPressureScale * PRESSURE_SCALE_DECAY,
      );
      this.lastRunwayEvictionAt = Date.now();
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

    // ADDITIVE-OCTREE LOD: render EVERY loaded tile in the needed set across all
    // zoom levels — no parent de-dup. Each point lives at exactly one home zoom,
    // so a coarse z14 tile and a fine z18 tile hold DISJOINT points (the coarse
    // overview vs. the residual detail); dropping the coarse parent once its
    // children load would erase the sparse points that exist nowhere else. The
    // union is the complete cloud.
    if (this.options.lodMode === 'additive') {
      const out: Tile[] = [];
      for (const key of this.neededTileKeys) {
        const header = this.tiles.get(key);
        if (header?.isLoaded && header.tile) out.push(header.tile);
      }
      return out;
    }

    // Find the primary (highest) zoom level NEEDED — not necessarily loaded
    // yet. `neededTileKeys` already carries a header for every needed tile
    // the moment selectAndLoadTiles selects it (see there), so this is safe
    // even before anything has loaded: passes 1-2 below still gate on
    // `isLoaded` and simply contribute nothing in that case, but pass 3 (the
    // zoom-out finer-descendant stand-in) NEEDS a primaryZoom even when the
    // new primary tile is still in flight — that's exactly the case it
    // exists to cover, so deriving primaryZoom from loaded-only tiles would
    // make it unreachable right when it matters.
    let primaryZoom = -1;
    for (const key of this.neededTileKeys) {
      const header = this.tiles.get(key);
      if (!header) continue; // defensive; every needed key has a header
      if (header.id.z > primaryZoom) primaryZoom = header.id.z;
    }
    if (primaryZoom < 0) return []; // Defensive: neededTileKeys guarantees headers.

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

    // Pass 3: primary-zoom cells that are NEEDED but not yet loaded — the
    // common case right after a zoom-OUT, while the new coarser tile is
    // still in flight — fall back to already-resident FINER descendant
    // tiles as a temporary stand-in. Pure reuse of tiles already sitting in
    // `this.tiles` (typically what was on screen a moment ago): no new
    // network requests, no change to what selectAndLoadTiles fetches. Only
    // meaningful for 'best-available', which is the only strategy that ever
    // shows anything but the exact requested zoom.
    if (this.options.refinementStrategy !== 'no-overlap') {
      for (const key of this.neededTileKeys) {
        const header = this.tiles.get(key);
        if (!header || header.id.z !== primaryZoom || header.isLoaded) continue;
        const { z, x, y, t } = header.id;
        this.collectLoadedDescendants(
          z,
          x,
          y,
          t,
          CHILD_LOOKAHEAD_LEVELS,
          tiles,
        );
      }
    }

    return tiles;
  }

  /**
   * Recursively collect already-loaded, resident tiles at zoom+1..zoom+depth
   * covering `(zoom, x, y, t)` into `out`. Stops descending into a quadrant
   * the instant a loaded tile covers it — checking deeper under an
   * already-covered cell would just double-render the same area. Render-time
   * only (see {@link getVisibleTiles}): a quadrant with no resident tile at
   * any depth is simply left uncovered, never fetched.
   */
  private collectLoadedDescendants(
    zoom: number,
    x: number,
    y: number,
    t: number,
    depth: number,
    out: Tile[],
  ): void {
    if (depth <= 0 || zoom >= this.options.maxZoom) return;
    const childZoom = zoom + 1;
    const childCoords: Array<[number, number]> = [
      [2 * x, 2 * y],
      [2 * x + 1, 2 * y],
      [2 * x, 2 * y + 1],
      [2 * x + 1, 2 * y + 1],
    ];
    for (const [cx, cy] of childCoords) {
      const key = this.tileIdToKey({ z: childZoom, x: cx, y: cy, t });
      const header = this.tiles.get(key);
      if (header?.isLoaded && header.tile) {
        out.push(header.tile);
      } else {
        this.collectLoadedDescendants(childZoom, cx, cy, t, depth - 1, out);
      }
    }
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
      prefetchPressureScale: this.prefetchPressureScale,
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
    // `@<bucketMs>` keeps a temporal-LOD (scrub preview) tile's identity
    // distinct from the base tile sharing its z/x/y/t across EVERY keyed
    // registry (cache headers, needed set, priority/prefetch queues). Base
    // ids keep the historical key, so the coverage index — built from the
    // base-tier enumeration — stays base-keyed and a resident LOD tile can
    // never satisfy base coverage (the G7 preview-only contract).
    return id.bucketMs !== undefined
      ? `${id.z}/${id.x}/${id.y}/${id.t}@${id.bucketMs}`
      : `${id.z}/${id.x}/${id.y}/${id.t}`;
  }

  // Tile-size estimation lives in archive.ts (estimateTileSize) so the archive
  // and the tileset share one complete, consistent accounting implementation.
}

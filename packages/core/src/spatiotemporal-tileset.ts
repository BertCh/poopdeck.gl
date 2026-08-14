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

import type {
  Tile,
  TileId,
  BoundingBox,
  SelectionCost,
  TemporalLodLevel,
} from './types.js';
import { tileKey, type TileKey } from './tile-key.js';
import {
  addressableTemporalTiers,
  estimateTileSize,
  temporalTierArgmin,
  tileXSpanForLonRange,
  wrapLon,
} from './archive.js';
import {
  PrefetchPolicy,
  PREFETCH_CACHE_FRACTION,
  PREFETCH_COLD_BYTE_EXPANSION,
  byteExpansionRatio,
  type HorizonBytesOracle,
} from './prefetch-policy.js';
import { normalizeViewportBounds } from './geo/viewport-bounds.js';
import {
  emit as emitProbe,
  isProbeEnabled,
  recordViewport,
  type EvictionTier,
  type EvictProbeSample,
} from './telemetry.js';

const DEBUG = false;

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
 * Per-tile byte guess when the directory size lookup is unavailable
 * (`getTileByteSize` unset or the id is unknown). COMPRESSED currency, like
 * every other per-tile charge in the prefetch budget. Turns the byte budget
 * into an effective count cap (e.g. cold 4 MiB / 64 KiB = 64 tiles).
 */
const PREFETCH_UNKNOWN_TILE_BYTES = 64 * 1024;

/**
 * Bounds on the per-pass walk that measures the decoded/compressed expansion
 * (see {@link SpatioTemporalTileset.prefetchByteExpansion}): at most this many
 * priced tiles, and at most this many headers examined looking for them. The
 * sample is byte-weighted, so a few hundred tiles already pin the rate; the
 * examined cap keeps a huge cache from making the walk the expensive part of a
 * planning pass.
 */
const PREFETCH_EXPANSION_MAX_SAMPLES = 512;
const PREFETCH_EXPANSION_SCAN_LIMIT = 4096;

/**
 * Break ties WITHIN an eviction tier by descending byte size (M6/BH-7b) —
 * the DEFAULT for {@link setEvictionByteDensityBands}.
 *
 * The over-limit loop evicts until the cache is back under BOTH limits, so
 * among candidates the tier ordering already considers equally valuable, the
 * big ones end the pass soonest — fewer tiles evicted per over-budget event,
 * and fewer of them to re-fetch. "Equally valuable" is quantized to one
 * temporal bucket: distance still dominates across bands, byte size only
 * decides inside one. Tier A (LRU) and tier D (the last-resort recency order)
 * are deliberately untouched.
 *
 * ## Unconditional by design — NOT loop-gated
 *
 * BH-7 has two halves answering two DIFFERENT §9.4 gaps, with two separate
 * kill switches, and they must not be conflated:
 *
 * - **(a) loop rotation** answers gap 2 (a wrap inverts "behind ⇒ never
 *   needed again"). It is active only while a loop is declared; its kill
 *   switch is {@link SpatioTemporalTileset.setLoopWindow}`(null)`.
 * - **(b) this band sort** answers gap 1 (byte-blindness *within* a tier),
 *   whose measurable is refetched bytes per session under memory pressure —
 *   one-directional playback included. Gating it on a declared loop would
 *   leave it dead on every non-looping route, i.e. on almost every route
 *   where over-budget eviction actually happens.
 *
 * Say the consequence plainly, because it is easy to state wrongly: with no
 * loop declared the eviction plan is byte-identical to the pre-BH-7 plan
 * **only with this switch disengaged**. With it engaged (the default) two
 * candidates sharing a band come out biggest-first, where the incumbent left
 * them in cache-insertion order — no loop required.
 *
 * ## Why that EXTENDS the pinned B→C→D tiering rather than replacing it
 *
 * A band is exactly one temporal bucket wide and every tier-B/C metric is
 * derived from the tile's bucket start, so under the incumbent (un-rotated)
 * metric two tiles in one band have *identical* distance: the incumbent
 * comparator returned 0 for them and the surviving order fell out of the
 * `this.tiles` Map iteration order — tile ARRIVAL order. This sort replaces
 * that non-order with a deterministic one. Tier membership, the B→C→D tier
 * order, and the across-band distance dominance are all untouched: nothing
 * moves across a tier or across a band. (Under rotation a loop span that is
 * not a whole number of buckets can fold two buckets into one band; there the
 * band is a genuine approximation, bounded by one bucket.)
 */
export const EVICTION_BYTE_DENSITY_BANDS_DEFAULT = true;

/** Live value of the BH-7b band sort; see {@link setEvictionByteDensityBands}. */
let evictionByteDensityBands: boolean = EVICTION_BYTE_DENSITY_BANDS_DEFAULT;

/**
 * The documented BH-7b rollback, made operable (and therefore testable):
 * `setEvictionByteDensityBands(false)` restores the pre-BH-7 within-tier
 * comparator EXACTLY — identity bands, no byte tiebreak, so tiers B and C sort
 * on the raw metric alone. Returns the PREVIOUS value so a caller can restore
 * it.
 *
 * Deliberately a module-level knob rather than a per-tileset option: rolling
 * BH-7b back is a program-level decision, not a per-map one. It is
 * intentionally NOT re-exported from the package index — this is a rollback
 * lever and a test seam, not public API.
 */
export function setEvictionByteDensityBands(enabled: boolean): boolean {
  const previous = evictionByteDensityBands;
  evictionByteDensityBands = enabled;
  return previous;
}

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
 * λ — the blank-cell-ms exchange rate in the placeholder-fetch expected-value
 * rule (CO-6, problems §8.3): how many ms of download this tileset will spend to
 * avert ONE visible primary cell staying blank for ONE ms. The rule fetches a
 * coarse parent `u` iff
 *
 * ```
 *   bytes(u) / θ̂   <   λ · A(u) · Ê[coverMs]
 *   └ time to get u ┘      └ blank cell-ms it averts ┘
 * ```
 *
 * with `A(u)` = visible primary child cells under `u` and `Ê[coverMs]` the ETA
 * of `u`'s still-missing children (capped, see
 * {@link PLACEHOLDER_COVER_HORIZON_MS}).
 *
 * FIT: 1/16 reproduces the flat 2 MiB rule's verdicts on the two cases that rule
 * was chosen from — a 300 KB z13 parent under a z14 view is fetched (needs
 * λ > ≈0.023), a 14 MB z10 Manhattan parent is skipped (would need λ > ≈0.23) —
 * while letting link speed and actual child cost move the boundary in between,
 * which a constant cannot. It is a DERIVED default, not a measured one: the
 * measured fit needs the blank-frame instrumentation that is still NEEDS-HARNESS
 * (implementation plan, CO-6 Evaluation). Override via
 * {@link SpatioTemporalTilesetOptions.placeholderValueLambda}.
 */
const DEFAULT_PLACEHOLDER_VALUE_LAMBDA = 1 / 16;

/**
 * Saturation horizon (ms) for the `Ê[coverMs]` term of the placeholder rule.
 *
 * Without it the rule is scale-INVARIANT in throughput and the estimator is
 * decorative: both `bytes(u)/θ̂` and `childBytes/θ̂` scale as `1/θ̂`, so θ̂
 * cancels and a 2 MB placeholder is judged identically on a 20 MB/s link and a
 * 100 KB/s one. It should not be: the value of averting blankness has an
 * ABSOLUTE time scale (a frame blank for 200 ms is nearly free; one blank for
 * 30 s has already cost the user the session), whereas the placeholder's own
 * arrival time does not saturate. Capping the benefit term — and only it —
 * restores that asymmetry, which is what makes "same parent, slow link ⇒ don't
 * bother" come out of the arithmetic rather than out of a second rule.
 *
 * 10 s is one order of magnitude above the ~1 s a placeholder is normally
 * useful for and comfortably past any interaction the user is still waiting on.
 */
const PLACEHOLDER_COVER_HORIZON_MS = 10_000;

/**
 * Ceiling on how many primary cells the expected-value rule will walk to price
 * ONE parent. The walk is already clamped to the viewport's tile box, so the
 * common case is tens of cells; this only bounds the pathological one (a
 * whole-world viewport at a deep primary zoom, where the clamp removes
 * nothing). Above it the rule ABSTAINS and the flat cutoff answers — the same
 * fallback every other unavailable input takes, chosen over sampling the block
 * because a sampled child byte sum is a guess wearing a measurement's clothes.
 * 256 = a 4-level parent's full block, i.e. the deepest the fetch ladder goes.
 */
const PLACEHOLDER_EV_MAX_CELLS = 256;

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
 * Bound on how many zoom levels finer {@link SpatioTemporalTileset.getVisibleTiles}'s
 * zoom-out stand-in pass will search for an already-resident descendant tile
 * (see {@link SpatioTemporalTileset.collectLoadedDescendants}). Mirrors
 * `PARENT_FALLBACK_LEVELS`'s reasoning in spirit but capped tighter — the
 * search is a pure `this.tiles` lookup (no fetch), yet still O(4^depth) per
 * missing cell, so 2 levels (16 lookups) caps the worst case while covering
 * the common one-or-two-clicks zoom-out gesture.
 */
const CHILD_LOOKAHEAD_LEVELS = 2;

/**
 * Real-time lookahead (ms) used to size the DEFAULT probe horizon of
 * {@link SpatioTemporalTileset.getBufferedRunway}: the horizon covers at
 * least `|animationSpeed| × 10 s` of sim-time, i.e. ten wall-seconds of
 * playback at the current speed.
 */
const RUNWAY_HORIZON_REAL_MS = 10_000;

/** Default cap on the number of ranges returned by `getBufferedRanges`. */
const DEFAULT_MAX_BUFFERED_RANGES = 64;

/**
 * How many times a NEEDED tile may FAIL to produce data before the readiness
 * APIs stop waiting on it.
 *
 * This is a READINESS budget, not a retry budget — the two used to be the same
 * number and that was the defect. A tile whose batch resolves `null` (the
 * archive's retries and its per-tile fallback both failed) used to be left
 * `{isLoaded: false, isLoading: false, isCancelled: false}` — still in
 * `neededTileKeys`, in NO queue, and invisible to the only site that enqueues
 * needed tiles, because the exact-bounds `selectKey` fast path short-circuits
 * every identical `update()`. Measured: zero re-requests across 30 identical
 * updates; only a playhead nudge healed it. The first fix bounded the revival
 * at three attempts AND latched `isFailed` one-way for the header's lifetime,
 * which was strictly worse: all three attempts land inside ~1.5 s, a NEEDED
 * tile's header is never replaced (eviction hard-excludes `neededTileKeys`),
 * so a 1.5-second network blip blanked that region for the rest of the session
 * and no pan, seek or wait healed it.
 *
 * So the two jobs are now split. {@link SpatioTemporalTileHeader.isFailed} is
 * still latched here and still STICKY — once a tile has failed this many times
 * the readiness APIs write it off permanently, because a hole that keeps
 * counting as missing pins the buffered runway at zero and the playback
 * governor never lets the clock advance again, and un-writing-it-off on every
 * retry would re-pin the runway once per backoff window. Whether the tile is
 * ever FETCHED again is a separate question, answered by
 * {@link FAILED_TILE_RETRY_COOLDOWN_MS}'s backoff ladder.
 */
const FAILED_TILE_MAX_ATTEMPTS = 3;

/**
 * Base wall-clock spacing (ms) between a settle-without-data and the retry it
 * schedules. Each further settle DOUBLES the wait, up to
 * {@link FAILED_TILE_RETRY_MAX_BACKOFF_MS}.
 *
 * Exponential backoff rather than a flat cooldown or a hard give-up, because
 * the two constraints pull in opposite directions and only a decaying rate
 * satisfies both:
 *
 * - "heals after a blip, with no user action": the ladder's first four rungs
 *   (0.5 / 1 / 2 / 4 s) are all spent inside the first ~8 seconds, so a
 *   dropped connection, a 502 from a cold edge node, or a re-issued range
 *   request recovers about as fast as a flat 500 ms cooldown would — and
 *   crucially it keeps going afterwards, where the one-way latch stopped.
 * - "does not re-fetch a genuinely-absent tile at ~1 Hz forever": the ladder
 *   reaches the ceiling after ~8 settles, so the steady-state cost of a tile
 *   the origin will never serve is one probe per minute. Those probes are
 *   re-enqueued at priority and therefore COALESCE — every written-off tile in
 *   the viewport rides one batch, so the cost is per-minute, not per-tile.
 *
 * The ladder is deliberately NOT reset by camera activity: it lives on the
 * header, and the header outlives every pan and seek that keeps the tile
 * needed. Resetting on selection is what let the camera, rather than the
 * tile's own history, decide the request rate.
 */
const FAILED_TILE_RETRY_COOLDOWN_MS = 500;

/**
 * Ceiling on the {@link FAILED_TILE_RETRY_COOLDOWN_MS} backoff ladder: one
 * probe per minute per permanently-absent tile. A ceiling rather than a hard
 * stop because "absent" is not knowable from the client — a 404 during a
 * fleet republish, an R2 object still propagating, an offline tab coming back
 * — and a hard stop means the only cure is a page reload.
 */
const FAILED_TILE_RETRY_MAX_BACKOFF_MS = 60_000;

/**
 * Settles — of ANY kind, aborts included — after which a tile stops counting
 * as missing for readiness, even though it keeps being retried.
 *
 * The abort exemption above is what stops a flaky transport from writing off
 * good tiles, but on its own it is UNBOUNDED, and that re-opens the exact
 * constraint {@link FAILED_TILE_MAX_ATTEMPTS} exists to hold: a transport that
 * aborts EVERY request (a dead origin behind a proxy that stalls rather than
 * refuses, a request timeout that always fires) never advances `attempts`,
 * never latches `isFailed`, and so pins the buffered runway at zero forever —
 * playback gated behind a tile that will never arrive. Aborts are not evidence
 * about the tile, but an unbounded number of them is evidence about the
 * session.
 *
 * Sized off the ladder rather than picked: at 8 settles the backoff has just
 * reached its 60 s ceiling (0.5 + 1 + 2 + 4 + 8 + 16 + 32 ≈ 64 s of trying),
 * so this fires only once a tile has been unreachable for over a minute — far
 * past any blip, and still short of the user giving up on the frame. Retries
 * continue at the ceiling regardless; only the readiness accounting changes.
 */
const FAILED_TILE_READINESS_WRITEOFF_SETTLES = 8;

/**
 * How many zoom levels COARSER than the primary {@link
 * SpatioTemporalTileset.getVisibleTiles}'s stand-in pass will search for an
 * already-resident ANCESTOR tile to cover a needed-but-unloaded primary cell.
 * The mirror of {@link CHILD_LOOKAHEAD_LEVELS} (zoom-out) for the zoom-IN
 * gesture, and capped for the same reason: the search is a pure `this.tiles`
 * lookup, but each level up must also verify that NO primary cell under that
 * ancestor is already loaded (4^depth lookups) before it may draw.
 *
 * RETAINED as the `coverSearch: 'capped'` escape hatch only — the default cover
 * path is the DP, whose band is {@link COVER_DP_ANCESTOR_LEVELS}.
 */
const ANCESTOR_LOOKBACK_LEVELS = 2;

/**
 * The DP cover band, ZOOM-OUT half: how many levels FINER than the primary the
 * stand-in search reaches. Deliberately unchanged from
 * {@link CHILD_LOOKAHEAD_LEVELS}, and the asymmetry with
 * {@link COVER_DP_ANCESTOR_LEVELS} is the point. The two directions have
 * opposite delivery costs: ONE ancestor covers 4^up cells, so reaching further
 * up costs one extra tile in the delivered list, whereas reaching one level
 * further DOWN multiplies the delivered descendants per blank cell by four. At
 * depth 3 a single blank cell can hand the renderer 64 tiles — the draw-call
 * pathology `/drive` already exhibits (measurements §10.2) — so the search cost
 * argument that the DP dissolves is replaced by a delivery cost argument that
 * it does not. This is the `[z*−4, z*+2]` band the implementation plan names.
 */
const COVER_DP_DESCENDANT_LEVELS = CHILD_LOOKAHEAD_LEVELS;

/**
 * The DP cover band, ZOOM-IN half: how many levels COARSER than the primary the
 * stand-in search reaches — the de-capped half (2 → 4).
 *
 * The depth-2 cap existed because each level up cost a 4^up block scan per
 * candidate cell. The DP propagates "this block already has content" UPWARD
 * from the covered cells instead (one walk per covered cell, `O(|covered| ×
 * levels)`), so the block test is a set lookup and the cap has no cost left to
 * justify it. Matched to {@link PARENT_FALLBACK_LEVELS} so the render side can
 * reuse everything the fetch side was willing to load: below the DP, a
 * three-notch zoom-in threw away a resident ancestor the fetch ladder had
 * deliberately fetched as that exact fallback.
 */
const COVER_DP_ANCESTOR_LEVELS = PARENT_FALLBACK_LEVELS;

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
 * Default byte budget for {@link SpatioTemporalTileset.preloadOverviewTier}.
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
  keys: TileKey[];
  /** Compressed byte length per tile (0 when `getTileByteSize` is unwired). */
  bytes: number[];
  /**
   * Σ {@link bytes} — accumulated as the bucket is filled, not by a second
   * pass, so the byte-density profile costs the index build one add per tile.
   */
  totalBytes: number;
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
  keySet: Set<TileKey>;
  /**
   * `[first bucket start, last bucket end]` of the viewport's available
   * data, or `null` when the viewport has no tiles at any time.
   */
  timeRange: { start: number; end: number } | null;
  /**
   * Σ directory bytes per bucket, ALIGNED WITH {@link bucketStarts} (index i
   * is the total for `bucketStarts[i]`). Totals, not missing bytes: residency
   * cost is a property of the data, whereas what is missing changes with every
   * tile that settles.
   */
  bucketByteTotals: Float64Array;
  /**
   * Prefix sums of {@link bucketByteTotals}, length `bucketStarts.length + 1`
   * with `cumulativeBytes[0] === 0`. Bytes over any bucket span `[i, j)` are
   * `cumulativeBytes[j] - cumulativeBytes[i]`, which is what turns
   * {@link SpatioTemporalTileset.bytesForHorizon} into two binary searches
   * instead of a walk — the property a horizon SOLVE (rather than a horizon
   * probe) needs, since it evaluates many candidate horizons per plan.
   */
  cumulativeBytes: Float64Array;
  /**
   * `true` when every tile in the index has a known compressed length. False
   * when `getTileByteSize` is unwired, or wired but blind to some tile: the
   * per-tile fallback is `0`, so the byte columns would read as "free" rather
   * than "unknown". The byte queries refuse to answer in that state instead of
   * publishing a total that is a floor pretending to be a fact.
   */
  bytesKnown: boolean;
}

/** Bookkeeping for the single overview (storyboard) preload attempt. */
interface OverviewState {
  /** Returned to EVERY `preloadOverviewTier()` caller (idempotency). */
  promise: Promise<OverviewPreloadResult>;
  resolve: (result: OverviewPreloadResult) => void;
  /** Latched once `resolve` has been called. */
  settled: boolean;
  /** Registry keys of pinned tiles whose fetch hasn't reached a final state. */
  pendingKeys: Set<TileKey>;
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

/** First index in ascending `arr` with `arr[i] > x` (`arr.length` if none). */
function upperBound(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The result of a {@link SpatioTemporalTileset.preloadOverviewTier} attempt —
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
 * Optional per-batch hooks for {@link SpatioTemporalTilesetOptions.getTileDataBatch}.
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
   * docs/roadmap/playback-and-loading.md §5). The tileset populates it from
   * its current viewport time so a
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

/**
 * Viewport tile-x coverage at `zoom`, as ONE or TWO ascending `[x0, x1]`
 * column intervals inside `[0, 2^zoom − 1]`.
 *
 * A viewport that straddles the antimeridian — either UNWRAPPED
 * (`WebMercatorViewport.unproject` reports `{minLon: 174, maxLon: 184}` at
 * lon 179) or CROSSING (`minLon > maxLon`) — covers columns at BOTH edges of
 * the world, which no single interval can express. The wrap-aware span comes
 * from {@link tileXSpanForLonRange} (the same primitive the archive's
 * `boundsToTiles` scan uses, so selection and this render-side cover check
 * can never disagree); it is split here at the world edge.
 *
 * A non-crossing viewport yields exactly one interval, identical to the old
 * `[lonToTileClamped(minLon), lonToTileClamped(maxLon)]` pair.
 */
function viewportTileXIntervals(
  bounds: BoundingBox,
  zoom: number,
): Array<[number, number]> {
  const n = 1 << zoom;
  const { start, count } = tileXSpanForLonRange(
    bounds.minLon,
    bounds.maxLon,
    zoom,
  );
  if (count <= 0) return [];
  const end = start + count - 1;
  if (end <= n - 1) return [[start, end]];
  // The span ran off the east edge: the remainder re-enters at column 0.
  return [
    [start, n - 1],
    [0, end - n],
  ];
}

/**
 * Longitude extent of a viewport, in degrees, for a possibly seam-crossing box.
 *
 * `minLon > maxLon` is the antimeridian-CROSSING encoding, whose naive
 * `maxLon − minLon` is NEGATIVE — and every spatial tolerance in the selection
 * path is a fraction of the viewport extent, so a negative span made the
 * tolerance collapse to zero: each pass then read as a "significant" spatial
 * change and flushed the prefetch runway. UNWRAPPED bounds (`maxLon > 180`,
 * what `WebMercatorViewport.unproject` actually returns) need no correction —
 * their span is already positive and correct.
 */
function lonSpanOf(bounds: BoundingBox): number {
  const span = bounds.maxLon - bounds.minLon;
  return span >= 0 ? span : span + 360;
}

/**
 * Longitude centre of a viewport, seam-crossing aware. Anchored at `minLon`
 * (never the `(min + max) / 2` midpoint, which lands on the far side of the
 * globe for a crossing box) so it stays continuous as an unwrapped viewport —
 * `[168, 188]` → `[170, 190]` → the crossing `[172, -168]` — drifts east.
 */
function lonCenterOf(bounds: BoundingBox): number {
  return bounds.minLon + lonSpanOf(bounds) / 2;
}

/** Web-Mercator lat → slippy tile y at `zoom`, clamped into [0, 2^zoom − 1]. */
function latToTileClamped(lat: number, zoom: number): number {
  const n = 1 << zoom;
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
  );
  return Math.max(0, Math.min(n - 1, y));
}

// ── The frustum cut (FS-2) ──────────────────────────────────────────────────
// Small, total, allocation-light helpers over a quadtree CUT — a mixed-zoom
// set of `(z, x, y)` SPATIAL addresses. Every one of them resolves uncertainty
// toward INCLUSION or toward `null` (which means "take the incumbent box
// path", a strict superset); none of them may ever silently shrink a cover.

/** Deepest zoom a cut cell may address — well past the spec's tile-zoom cap. */
const MAX_CUT_ZOOM = 30;

/** A cut cell's canonical string address (also its de-duplication key). */
function cutCellKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

/**
 * Validate, de-duplicate and sign a caller-supplied cut.
 *
 * Returns `null` — meaning "there is no usable cut, take the incumbent box
 * path" — for a missing, empty or wholly unusable list. Individual malformed
 * cells are dropped rather than repaired: a cell address is integers, and there
 * is no defensible guess at what a fractional or out-of-world one meant.
 *
 * The signature is ORDER-INDEPENDENT (sorted keys). That matters because it
 * gates the prefetch-runway flush: a chassis that rebuilds the same cut in a
 * different order must not read as a camera move and throw the runway away.
 */
function normalizeTileCells(
  cells: readonly TileId[] | null | undefined,
): { cells: TileId[]; signature: string } | null {
  if (!cells || !Array.isArray(cells) || cells.length === 0) return null;
  const seen = new Set<string>();
  const out: TileId[] = [];
  for (const cell of cells) {
    if (!cell) continue;
    const { z, x, y } = cell;
    if (!Number.isInteger(z) || z < 0 || z > MAX_CUT_ZOOM) continue;
    const world = 2 ** z;
    if (!Number.isInteger(x) || x < 0 || x >= world) continue;
    if (!Number.isInteger(y) || y < 0 || y >= world) continue;
    const key = cutCellKey(z, x, y);
    if (seen.has(key)) continue;
    seen.add(key);
    // `t` is deliberately dropped: a cut cell is a SPATIAL address and the
    // temporal coordinate comes from the selection's own time range.
    out.push({ z, x, y, t: 0 });
  }
  if (out.length === 0) return null;
  return { cells: out, signature: [...seen].sort().join(',') };
}

/**
 * Reduce a cell set to an ANTICHAIN, keeping the ANCESTOR and dropping the
 * descendant whenever two members nest.
 *
 * Direction matters and only one direction is safe: an ancestor covers
 * everything its descendants do, so dropping downward costs resolution, while
 * dropping upward would cost AREA — the blank-region symptom class. A cut
 * arrives as an antichain, but the scrub-LOD spatial drop can lift a deep cell
 * onto a shallow one's block, so the reduction runs after it.
 */
function reduceToAntichain(cells: readonly TileId[]): TileId[] {
  const keys = new Set<string>();
  for (const c of cells) keys.add(cutCellKey(c.z, c.x, c.y));
  const kept: TileId[] = [];
  for (const c of cells) {
    let nested = false;
    for (let az = c.z - 1; az >= 0; az--) {
      const shift = 2 ** (c.z - az);
      if (
        keys.has(
          cutCellKey(az, Math.floor(c.x / shift), Math.floor(c.y / shift)),
        )
      ) {
        nested = true;
        break;
      }
    }
    if (!nested) kept.push(c);
  }
  return kept;
}

/**
 * Apply the scrub-LOD spatial drop to a cut: a uniform `−k` on every branch's
 * target zoom, floored at `minZoom`.
 *
 * This is `effectiveSelectionZoom`'s clamp logic lifted onto a per-branch cut —
 * the one shape change the plan asks for. Coarsening can make two branches
 * nest, so the result is re-reduced to an antichain.
 */
function applyCutZoomDrop(
  cells: readonly TileId[],
  drop: number,
  minZoom: number,
): TileId[] {
  if (drop <= 0) return cells as TileId[];
  const seen = new Set<string>();
  const out: TileId[] = [];
  for (const c of cells) {
    // A cell already at or below the floor is kept where it is: the drop is a
    // degrade, never a promotion. Without the outer `min` a cell shallower than
    // `minZoom` would be re-labelled at `minZoom` while keeping its old x/y —
    // a different piece of ground, which is the silent-wrong-data class.
    const z = Math.min(c.z, Math.max(minZoom, c.z - drop));
    const dz = c.z - z;
    const x = dz > 0 ? Math.floor(c.x / 2 ** dz) : c.x;
    const y = dz > 0 ? Math.floor(c.y / 2 ** dz) : c.y;
    const key = cutCellKey(z, x, y);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ z, x, y, t: 0 });
  }
  return reduceToAntichain(out);
}

/**
 * The coarser stand-in cells a cut needs, `levels` zooms up from each member
 * and never above `minZoom`.
 *
 * This is `getZoomLevelsToLoad`'s parent band expressed per branch instead of
 * per screen. Under `lodMode: 'additive'` the caller passes the full depth, and
 * the result is the union of the cut's ancestor chains — which is exactly the
 * set of interior nodes the quadtree walk visited on its way to the cut, at
 * zero extra enumeration. Cells that are already IN the cut are excluded, so a
 * far-field branch that cuts at z6 never re-enters as its own neighbour's
 * parent.
 */
function cutAncestors(
  cells: readonly TileId[],
  levels: number,
  minZoom: number,
): TileId[] {
  if (levels <= 0) return [];
  const inCut = new Set<string>();
  for (const c of cells) inCut.add(cutCellKey(c.z, c.x, c.y));
  const seen = new Set<string>();
  const out: TileId[] = [];
  for (const c of cells) {
    for (let i = 1; i <= levels; i++) {
      const z = c.z - i;
      if (z < minZoom || z < 0) break;
      const shift = 2 ** i;
      const x = Math.floor(c.x / shift);
      const y = Math.floor(c.y / shift);
      const key = cutCellKey(z, x, y);
      if (inCut.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ z, x, y, t: 0 });
    }
  }
  return out;
}

/** O(n) set equality used to decide whether the needed-tile set actually changed. */
function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
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
 * the timeline (docs/roadmap/playback-and-loading.md §5–6). Both axes default
 * OFF (the kill switch): with this option absent, {@link
 * SpatioTemporalTileset.setInteractive} stores the interactive bit and
 * changes nothing else, so today's behavior is byte-identical.
 *
 * The degraded tier is PREVIEW-ONLY: tile
 * SELECTION degrades while interactive, but the readiness/buffer APIs
 * (`getBufferedRunway` / `getBufferedRanges` / `estimateCost`) and the
 * prefetch planner keep measuring/warming the FINE base tier, so a
 * playback gate on scrub release re-arms against full detail — never
 * against the coarse preview.
 */
export interface ScrubLodOptions {
  /**
   * SPATIAL axis: while interactive, drop the requested (primary)
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
   * TEMPORAL axis: while interactive, route selection through the
   * archive's temporal-LOD pyramid — the coarsest level covering the
   * requested zoom (the `pickTemporalLodForZoom` snap) — instead of the
   * base-bucket tiles. No-ops cleanly unless the archive was built with
   * `--temporal-lod` AND both {@link SpatioTemporalTilesetOptions.temporalLodLevels}
   * and {@link SpatioTemporalTilesetOptions.getAvailableTemporalLodTiles}
   * are wired (capability detection). Zooms dispatched to the summary tier
   * keep using it — summary is already a reduced tier.
   * @default false
   */
  temporal?: boolean;
}

export interface SpatioTemporalTilesetOptions {
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
   * Absent/empty = the kill switch: {@link SpatioTemporalTileset.setInteractive}
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

  /**
   * How a temporal-LOD tier is chosen when the temporal axis is live (CO-5).
   *
   * - `'zoom-threshold'` (default): the incumbent snap — the coarsest declared
   *   level whose `maxZoomLevel` covers the requested zoom, exactly
   *   `STTArchive.pickTemporalLodForZoom`. Knows nothing about the window, so
   *   a narrow window over-fetches and a wide one under-aggregates.
   * - `'cost-argmin'`: price every addressable tier with the selection-cost
   *   oracle and take the cheapest under
   *   `bytes + tiles × requestOverheadBytes` (ties to the COARSER tier).
   *   Requires {@link estimateSelectionCost} and
   *   {@link getRequestOverheadBytes}; falls back to the zoom threshold
   *   whenever either is unwired or any tier prices with `unknownTiles > 0`.
   *
   * The default is preserved DELIBERATELY. Temporal-LOD selection is currently
   * scrub-only ("inert until the `scrubLod.temporal` axis is switched on"), so
   * with the default nothing about today's behaviour moves; flipping it is a
   * separate, measured decision.
   * @default 'zoom-threshold'
   */
  temporalTierPolicy?: 'zoom-threshold' | 'cost-argmin';

  /**
   * CO-1's SYNCHRONOUS selection-cost oracle (wire
   * `STTArchive.estimateSelectionCost`): exact compressed bytes for a
   * (bounds × zoom × window × tier) query, read straight off resident
   * directory entries with zero network.
   *
   * Consumed by {@link temporalTierPolicy}`: 'cost-argmin'`. `unknownTiles`
   * rides in the answer and is honoured — a selection the reader cannot see is
   * counted, and the tier pick abstains rather than comparing lower bounds.
   */
  estimateSelectionCost?: (
    bounds: BoundingBox,
    zoom: number,
    timeRange: { start: number; end: number },
    opts?: { bucketMs?: number; variantId?: number },
  ) => SelectionCost;

  /**
   * The bytes-equivalent price of ONE request — CO-7's fitted `L̂ × θ̂`, i.e.
   * how many bytes the link would move in the time one extra round trip
   * costs (wire `STTArchive.effectiveCoalesceGap`).
   *
   * This is the exchange rate that makes a tile COUNT commensurable with a
   * byte count in {@link temporalTierPolicy}'s objective, and it is
   * deliberately the SAME number the archive's range coalescer fuses on —
   * one estimator, one exchange rate.
   */
  getRequestOverheadBytes?: () => number;

  /** Callback to get available raw tiles for bounds/time. */
  getAvailableTiles: (
    bounds: BoundingBox,
    zoom: number,
    timeRange: { start: number; end: number },
  ) => Promise<TileId[]>;

  /**
   * Optional CELL-ADDRESSED directory slice (wire
   * `STTArchive.getAvailableTilesForCells`) — the callback the frustum
   * selection path needs and the ONLY thing that makes
   * {@link SpatioTemporalTileset.update}'s `tileCells` do anything.
   *
   * A frustum cut is a mixed-zoom antichain, so there is no `(bounds, zoom)`
   * pair that describes it and the three bounds callbacks above cannot serve
   * it. This one takes the cells verbatim and dispatches the SAME three tiers
   * through its `opts` bag: default = base raw, `{ bucketMs }` = a temporal-LOD
   * tier, `{ tier: 'summary' }` = the declared summary variant with its zoom
   * gate applied per cell.
   *
   * CAPABILITY-GATED, and that is the kill switch: with this unwired, a
   * `tileCells` viewport falls straight back to the incumbent per-zoom box
   * enumeration. Selection then behaves exactly as it does today.
   */
  getAvailableTilesForCells?: (
    cells: readonly TileId[],
    timeRange: { start: number; end: number },
    opts?: { tier?: 'raw' | 'summary'; bucketMs?: number },
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
   *
   * Under the default `placeholderPolicy: 'expected-value'` this is the FALLBACK
   * rule, applied whenever the expected-value rule cannot be priced (throughput
   * estimator cold, tile size unknown, viewport degenerate) and whenever
   * `placeholderPolicy: 'flat'` pins it.
   */
  maxParentTileBytes?: number;

  /**
   * How a coarse PARENT-fallback placeholder is judged worth fetching.
   *
   * - `'expected-value'` (default): fetch iff the time to download it is less
   *   than the blank-cell-ms it averts (see
   *   {@link DEFAULT_PLACEHOLDER_VALUE_LAMBDA}) — a rule that reads the tile's
   *   real size, the visible area it would cover, its children's real cost and
   *   the measured link speed, instead of one constant. Falls back to the flat
   *   {@link maxParentTileBytes} rule, bit-for-bit, whenever any of those inputs
   *   is unavailable.
   * - `'flat'`: the pre-CO-6 rule — skip any parent over
   *   {@link maxParentTileBytes}, full stop. The kill switch.
   *
   * The PRIMARY display zoom is never skipped under either policy, and
   * `lodMode: 'additive'` bypasses both.
   * @default 'expected-value'
   */
  placeholderPolicy?: 'expected-value' | 'flat';

  /**
   * λ for the expected-value placeholder rule — ms of download this tileset
   * will spend per blank visible-cell-ms averted. Higher fetches more
   * placeholders. See {@link DEFAULT_PLACEHOLDER_VALUE_LAMBDA} for the fit.
   * Ignored under `placeholderPolicy: 'flat'`.
   */
  placeholderValueLambda?: number;

  /**
   * How {@link SpatioTemporalTileset.getVisibleTiles}'s stand-in pass searches
   * the resident set for a cover.
   *
   * - `'dp'` (default): one bottom-up DP over the resident loaded set across
   *   `[z* − COVER_DP_ANCESTOR_LEVELS, z* + COVER_DP_DESCENDANT_LEVELS]`,
   *   emitting the maximum-detail antichain.
   * - `'capped'`: the pre-CO-6 walks, bounded at {@link CHILD_LOOKAHEAD_LEVELS}
   *   / {@link ANCESTOR_LOOKBACK_LEVELS} in each direction. Retained for one
   *   release as the escape hatch.
   *
   * Both honour the identical contracts (single cover per visible cell,
   * descendants before ancestors, ancestors only over a wholly blank block,
   * fail-open on a degenerate viewport, base-tier-only stand-ins);
   * `lodMode: 'additive'` bypasses the pass entirely under both.
   * @default 'dp'
   */
  coverSearch?: 'dp' | 'capped';

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
   * Network throughput probe used by {@link SpatioTemporalTileset.estimateTimeToReadyMs}
   * to convert pending bytes into an honest ETA. Wire
   * `STTArchive.getThroughputEstimate` here (the consuming layer does this).
   * `bytesPerMs` is `null` until the estimator has at least one sample.
   */
  getThroughput?: () => { bytesPerMs: number | null; samples: number };

  /**
   * Loader-side fair-share weight setter, forwarded by
   * {@link SpatioTemporalTileset.setBandwidthWeight} (the governor's
   * bandwidth re-balancing hook). Wire `STTArchive.setSchedulerWeight` here
   * so a weight change re-shares this source's queued work in the
   * process-shared request scheduler immediately.
   */
  setSchedulerWeight?: (weight: number) => void;

  /**
   * Loader-side concurrency setter, forwarded by
   * {@link SpatioTemporalTileset.setOptions} whenever {@link maxRequests}
   * changes. Wire `STTArchive.setMaxConcurrentRequests` here so the knob
   * reaches the RANGE COALESCER's own in-flight cap — the tileset's
   * `maxRequests` only bounds its per-tile / prefetch fan-out, and the
   * coalesced batch path (the one that actually moves the bytes) is bounded
   * by the archive. Without this the archive keeps the cap it was
   * CONSTRUCTED with and a post-mount `maxRequests` change is half-applied.
   */
  setMaxConcurrentRequests?: (maxConcurrentRequests: number) => void;

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

/**
 * Fill in every default, so `this.options` is `Required<>` and no read site
 * has to repeat a fallback. Shared by the constructor and
 * {@link SpatioTemporalTileset.setOptions} — which is the whole point: a
 * post-construction change must land on exactly the value a fresh
 * construction would have produced, so the two can never drift.
 *
 * IDEMPOTENT on an already-normalized bag (every default is a `??`, and no
 * normalized value is `undefined`), which is what lets `setOptions` re-run it
 * over `{...current, ...partial}` and leave the untouched keys — including
 * the `onTile*` callback identities — exactly as they were.
 */
function normalizeTilesetOptions(
  options: SpatioTemporalTilesetOptions,
): Required<SpatioTemporalTilesetOptions> {
  return {
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
    getAvailableTemporalLodTiles: options.getAvailableTemporalLodTiles ?? null,
    // CO-5: the tier pick stays on the incumbent zoom threshold until a
    // caller explicitly asks for the cost argmin AND wires both oracles.
    temporalTierPolicy: options.temporalTierPolicy ?? 'zoom-threshold',
    estimateSelectionCost: options.estimateSelectionCost ?? null,
    getRequestOverheadBytes: options.getRequestOverheadBytes ?? null,
    getAvailableTiles: options.getAvailableTiles,
    getAvailableTilesForCells: options.getAvailableTilesForCells ?? null,
    getAvailableSummaryTiles: options.getAvailableSummaryTiles ?? null,
    getTileData: options.getTileData,
    getTileDataBatch: options.getTileDataBatch ?? null,
    getTileByteSize: options.getTileByteSize ?? null,
    maxParentTileBytes:
      options.maxParentTileBytes ?? DEFAULT_MAX_PARENT_TILE_BYTES,
    placeholderPolicy: options.placeholderPolicy ?? 'expected-value',
    placeholderValueLambda:
      options.placeholderValueLambda ?? DEFAULT_PLACEHOLDER_VALUE_LAMBDA,
    coverSearch: options.coverSearch ?? 'dp',
    onBufferChange: options.onBufferChange ?? null,
    getThroughput: options.getThroughput ?? null,
    setSchedulerWeight: options.setSchedulerWeight ?? null,
    setMaxConcurrentRequests: options.setMaxConcurrentRequests ?? null,
    onTileLoad: options.onTileLoad ?? (() => {}),
    onTileUnload: options.onTileUnload ?? (() => {}),
    onTileError: options.onTileError ?? ((err) => console.error(err)),
  } as Required<SpatioTemporalTilesetOptions>;
}

/**
 * The scrub-LOD axes as a comparable scalar (`'<spatial><temporal><drop>'`).
 * {@link SpatioTemporalTileset.setOptions} compares THIS rather than the
 * object identity so an equal-but-fresh `scrubLod={{spatial: true}}` literal
 * — which React hands down on every render — is correctly a no-op.
 */
function scrubAxes(cfg: ScrubLodOptions | null | undefined): string {
  if (!cfg) return '';
  return `${cfg.spatial === true}|${cfg.temporal === true}|${cfg.spatialZoomDrop ?? ''}`;
}

export interface SpatioTemporalTileHeader {
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
  /**
   * How many times a fetch for this tile FAILED — counted at settle, never at
   * dispatch, and never for an ABORT (supersession, a prefetch flush, a
   * transport-level timeout). Feeds only the readiness write-off at
   * {@link FAILED_TILE_MAX_ATTEMPTS}; the retry schedule is
   * {@link retrySettles}'s job.
   */
  attempts?: number;
  /**
   * How many times a fetch for this tile settled without data and scheduled a
   * revival — aborts INCLUDED. Drives the exponential backoff ladder (see
   * {@link FAILED_TILE_RETRY_COOLDOWN_MS}) and nothing else. Aborts are exempt
   * from the readiness budget but must still slow the retry rate down, or a
   * transport that aborts every request (a per-request timeout against a dead
   * origin) becomes a 2 Hz fetch loop that no cap ever stops.
   */
  retrySettles?: number;
  /**
   * Wall-clock ms before which this tile must not be dispatched again. THE
   * dispatch gate — every enqueue and every start path consults it through
   * `isQuarantined`. Expiring is the point: it is what lets a hole heal on its
   * own after the network recovers.
   */
  retryAfter?: number;
  /**
   * Latched once {@link attempts} reaches {@link FAILED_TILE_MAX_ATTEMPTS},
   * and then STICKY for the header's lifetime: the readiness APIs
   * (`getBufferedRunway` / `getBufferedRanges` / `estimateCost`) stop counting
   * this tile as missing, because a permanent hole that counts as missing pins
   * the buffered runway at zero and the playback governor never lets the clock
   * advance again.
   *
   * Deliberately NOT a fetch gate (it was, and that was the bug): retries keep
   * going on the backoff ladder long after this latches, and clearing the
   * latch for each of those retries would re-pin the runway once per backoff
   * window — a stutter every 60 s instead of one clean write-off.
   */
  isFailed?: boolean;
}

/**
 * Return type of {@link SpatioTemporalTileset.getCacheStats} — the tileset's
 * client-side cache/QoE counters.
 *
 * `evictionsByTier` and `bytesEvicted` are the P0-2 additions: they EXTEND the
 * existing `cacheStats` object rather than standing up a parallel one, so
 * every consumer of the incumbent fields keeps working unchanged.
 */
export interface TilesetCacheStats {
  /** Needed tiles already decoded in memory. */
  hits: number;
  /** Needed tiles that required a fetch. */
  misses: number;
  /** Tiles removed from the registry over the tileset's lifetime. */
  evictions: number;
  /**
   * Over-limit evictions that reached INTO the protected playhead window
   * (tiers C/D) — the fetch-evict-refetch thrash signal.
   */
  runwayEvictions: number;
  /**
   * Evictions attributed to the three playhead-relative tiers: `b` = coverage
   * far behind the playhead (back buffer), `c` = coverage far ahead (distant
   * speculation), `d` = the near-playhead protected window (last resort).
   * Tier A (stale/non-coverage LRU, the grace sweep, the no-coverage
   * fallback) is not a playhead-relative decision and is recoverable as
   * `evictions - (b + c + d)`; the `evict` probe channel carries it explicitly.
   */
  evictionsByTier: Record<'b' | 'c' | 'd', number>;
  /** Decoded bytes released by eviction over the tileset's lifetime. */
  bytesEvicted: number;
  /** Headers currently in the registry (loaded + in-flight). */
  tileCount: number;
  /** Decoded bytes currently resident. */
  cacheBytes: number;
  /** `hits / (hits + misses)`; 0 before the first needed tile. */
  hitRate: number;
  activeRequests: number;
  priorityQueueLength: number;
  prefetchQueueLength: number;
  /** The prefetch policy's current speculation scale (1 = full horizon). */
  prefetchPressureScale: number;
}

/**
 * Manages spatiotemporal tile loading with:
 * - Request concurrency control (maxRequests)
 * - Debouncing for viewport changes
 * - LRU cache eviction
 * - Temporal + spatial tile selection
 */
export class SpatioTemporalTileset {
  options: Required<SpatioTemporalTilesetOptions>;

  // Tile registry
  private tiles: Map<TileKey, SpatioTemporalTileHeader> = new Map();

  // Active requests tracking
  private activeRequests: Set<TileKey> = new Set();

  // Viewport state
  private currentViewport: {
    bounds: BoundingBox;
    zoom: number;
    time: number;
    timeWindow: number;
    /**
     * The frustum-quadtree CUT for this camera, already validated and
     * de-duplicated, or `null` for the incumbent box path. `bounds`/`zoom` are
     * ALWAYS present and always the AABB values: the cut governs which cells
     * selection addresses, while the box keeps serving the prefetch-flush
     * tolerance, the coverage index and every readiness estimate.
     */
    tileCells: readonly TileId[] | null;
    /** Order-independent signature of `tileCells`; `''` when there is no cut. */
    cutSignature: string;
  } | null = null;

  // Debounce timer
  private debounceTimer: NodeJS.Timeout | null = null;

  // Frame tracking (for render optimization)
  private frameNumber = 0;

  // Cache statistics. `runwayEvictions` counts over-limit evictions that had
  // to reach INTO the protected playhead window (tiers C/D of
  // evictUnusedTiles) — the observable fetch-evict-refetch thrash signal.
  //
  // P0-2 extends the SAME object (never a parallel one) with per-tier
  // attribution and a byte total: `runwayEvictions` says only that *some*
  // eviction reached the runway, which is not enough to tell a healthy
  // back-buffer trim (tier B) from distant-speculation loss (C) from a
  // near-playhead emergency (D).
  private cacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    runwayEvictions: 0,
    /**
     * Evictions attributed to the three PLAYHEAD-RELATIVE tiers. Tier A
     * (stale/non-coverage LRU, the grace sweep, and the no-coverage fallback)
     * is deliberately absent — it is not a playhead-relative decision, and
     * `evictions - (b + c + d)` recovers it. The `evict` probe channel does
     * carry an `'a'` tier for those samples.
     */
    evictionsByTier: { b: 0, c: 0, d: 0 } as Record<'b' | 'c' | 'd', number>,
    /** Total decoded bytes released by eviction over the tileset's lifetime. */
    bytesEvicted: 0,
  };

  /**
   * Playback state + speculative-loading decisions: direction hysteresis, the
   * pressure ladder, the run-ahead cap and the horizon/slice sizing. The
   * tileset supplies measurements and performs all the I/O the policy's
   * answers imply; the policy itself never fetches or schedules.
   */
  private readonly prefetch = new PrefetchPolicy();

  private lastUpdateTime: number = 0;

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

  /** Pending deferred prefetch pass; the policy decides when it may fire. */
  private prefetchPendingTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Declared playback LOOP window in sim-time, or `null` when playback is
   * one-directional (the default). `null` means the eviction metric is the
   * incumbent one-directional distance — it reverts BH-7's ROTATION half
   * only; the BH-7b band sort is unconditional and has its own switch (see
   * {@link EVICTION_BYTE_DENSITY_BANDS_DEFAULT}). Pushed by the
   * PlaybackGovernor through the optional `BufferSource.setLoopWindow` hook —
   * see {@link setLoopWindow}.
   */
  private loopRange: { start: number; end: number } | null = null;

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
   * The cut signature the previous selection pass ran with, under the frustum
   * path. It stands in for `lastSpatialZoom` in the prefetch-flush test there:
   * a quadtree cut has no single zoom to compare, and its own identity is the
   * honest "did the camera actually move to a different working set?" signal.
   * Sub-tile drift leaves the cut untouched and so keeps the runway, exactly
   * as the centre/span tolerance does for the box — the CONSTANTS are
   * untouched, only the key changes.
   */
  private lastSpatialCutKey?: string;

  /**
   * The cut the most recent selection pass actually addressed, AFTER the
   * scrub-LOD spatial drop and the antichain reduction that follows it — or
   * `null` whenever the pass ran on the incumbent box path.
   *
   * Published for FS-3, which owns the mixed-zoom delivery semantics
   * downstream (`getVisibleTiles` still derives ONE `primaryZoom` today).
   * Nothing in this file reads it.
   */
  private selectionCut: readonly TileId[] | null = null;

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
    keys: TileKey[];
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
    keys: TileKey[];
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

  /**
   * One-shot warn latch for "update() was handed a non-finite viewport box".
   * One-shot because the producing bug is per-camera-path, not per-frame: a
   * renderer that emits one NaN box emits sixty a second.
   */
  private warnedRejectedViewport = false;

  /**
   * Needed tiles whose fetch settled without data and are waiting out their
   * per-header backoff (`retryAfter`) before being re-enqueued. Drained by a
   * SINGLE shared timer ({@link retryTimer}) — one timer per failure would be
   * one timer per hole in a bad network minute.
   */
  private retryKeys: Set<TileKey> = new Set();

  /** The single pending failed-tile retry timer, or null when none is due. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Wall-clock time {@link retryTimer} is set to fire at. Held separately so
   * `scheduleRetrySweep` can tell whether the pending timer already fires
   * early enough for a newly-added key — re-arming on every settle would
   * either push the sweep later than the earliest due tile (holes heal late)
   * or churn a timer per settle during a bad network minute.
   */
  private retryDueAt: number | null = null;

  // Currently needed tile keys - computed during selectAndLoadTiles()
  // This is the authoritative set of tiles that should be visible for current viewport/time
  // getVisibleTiles() just returns loaded tiles from this set - O(k) not O(n)
  private neededTileKeys: Set<TileKey> = new Set();

  // Version tracking for cache invalidation
  private neededTilesVersion: number = 0;

  constructor(options: SpatioTemporalTilesetOptions) {
    this.options = normalizeTilesetOptions(options);

    // A wired onBufferChange implies the caller wants live buffer reports,
    // so start maintaining the coverage index from the first update().
    if (options.onBufferChange) {
      this.bufferTrackingEnabled = true;
    }
  }

  /**
   * Apply an option change AFTER construction — the STT analog of upstream
   * `Tileset2D.setOptions`, which `TileLayer.updateState` calls on every
   * `propsChanged` pass. Without it every option here is frozen at build time
   * and a post-mount `tier` toggle or `maxCacheSize` cut silently does
   * nothing (the consuming layer had to warn instead).
   *
   * CONTRACT — a key PRESENT in `options` lands in exactly the state the
   * constructor would have given it, including `undefined`, which resets that
   * key to its default (`{scrubLod: undefined}` is how you switch the motion
   * tier back off). A key ABSENT from `options` is untouched. `this.options`
   * is mutated in place, so any reference a consumer captured stays live.
   *
   * Changing an option is not enough on its own — several of them feed
   * DERIVED state that would otherwise go stale, so this re-derives:
   *
   * - `tier` / `summaryZoomRange` / `getAvailableSummaryTiles` decide which
   *   directory a zoom is enumerated from, so the coverage index (built from
   *   the same tier-dispatched call) is dropped and selection re-runs.
   * - `lodMode` / `refinementStrategy` / `minZoom` / `maxZoom` change WHICH
   *   zoom levels are selected and how parents are composited, so selection
   *   re-runs, the prefetch plan is re-anchored, and the render epoch bumps
   *   (`getVisibleTiles` output changes even when the needed set doesn't).
   * - `maxCacheSize` / `maxCacheByteSize` evict IMMEDIATELY down to the new
   *   bound through the normal tiered policy, not at the next natural pass.
   * - `maxRequests` re-dispatches the queues and, when
   *   {@link SpatioTemporalTilesetOptions.setMaxConcurrentRequests} is wired,
   *   reaches the archive's range coalescer (its own in-flight cap).
   * - `debounceTime` re-arms an already-pending debounce at the new delay.
   * - `enablePrefetch` / `prefetchAhead` / `prefetchSteps` re-plan the runway.
   *
   * TILE-CACHE DECISION — a `tier` or `lodMode` change does NOT invalidate
   * resident tiles. Both are SELECTION policies: they change which tile
   * addresses the viewport asks for, never what the bytes at a given address
   * are. The raw and summary tiers share one directory entry per
   * `(z, x, y, t)` — `getSummaryTileIdsInBounds` literally delegates to
   * `getTileIdsInBounds` — and both LOD modes address the ordinary pyramid,
   * so a resident tile is exactly as valid after the change as before, and
   * dropping the cache would blank the map for a full round-trip to re-fetch
   * identical bytes. (Contrast the temporal-LOD tier, whose payloads DO
   * differ at a shared address — which is why `tileKey` stamps it with
   * `@bucketMs`. A custom `getAvailableSummaryTiles` returning different
   * payloads at a raw tile's address must stamp a discriminator the same
   * way; without one it would alias, here and in the byte caches below.)
   * Consumers that really are swapping datasets call {@link clear}.
   */
  setOptions(options: Partial<SpatioTemporalTilesetOptions>): void {
    const prev = { ...this.options };
    // Re-normalize the MERGED bag so a present-but-undefined key falls back
    // to the constructor's default and an absent one keeps its current
    // (already-normalized, hence idempotent under `??`) value.
    const next = normalizeTilesetOptions({
      ...this.options,
      ...options,
    } as SpatioTemporalTilesetOptions);
    // Mutate in place: `options` is a public field consumers may hold.
    Object.assign(this.options, next);

    const changed = (key: keyof SpatioTemporalTilesetOptions): boolean =>
      !Object.is(prev[key], this.options[key]);

    // Which tiles the viewport asks for.
    const selectionChanged =
      changed('tier') ||
      changed('summaryZoomRange') ||
      changed('getAvailableSummaryTiles') ||
      changed('getAvailableTemporalLodTiles') ||
      changed('temporalLodLevels') ||
      // Which temporal tier the scrub axis addresses (CO-5).
      changed('temporalTierPolicy') ||
      changed('estimateSelectionCost') ||
      changed('getRequestOverheadBytes') ||
      changed('lodMode') ||
      changed('refinementStrategy') ||
      changed('minZoom') ||
      changed('maxZoom') ||
      changed('getAvailableTiles') ||
      // Wiring (or unwiring) the cell-addressed slice flips the whole
      // selection path between the frustum cut and the incumbent box
      // enumeration, so it is exactly as selection-relevant as its siblings.
      changed('getAvailableTilesForCells') ||
      changed('maxParentTileBytes') ||
      changed('getTileByteSize') ||
      // Which parent placeholders the fetch ladder is willing to buy.
      changed('placeholderPolicy') ||
      changed('placeholderValueLambda') ||
      // scrubLod only bites while interactive, but the axes are compared
      // structurally so an equal-but-fresh object literal is a no-op.
      scrubAxes(prev.scrubLod) !== scrubAxes(this.options.scrubLod);

    // What `getVisibleTiles` composites from an UNCHANGED needed set.
    const compositionChanged =
      changed('lodMode') ||
      changed('refinementStrategy') ||
      changed('coverSearch');

    // The tier the coverage index (and every readiness API on top of it) was
    // enumerated from. `lodMode`/`refinementStrategy` don't qualify: the
    // index keys off `getZoomLevelsToLoad(zoom)[0]`, which is the clamped
    // display zoom under every strategy.
    const coverageStale =
      changed('tier') ||
      changed('summaryZoomRange') ||
      changed('getAvailableSummaryTiles') ||
      changed('getAvailableTiles') ||
      changed('temporalBucketMs');

    const prefetchStale =
      changed('prefetchAhead') ||
      changed('prefetchSteps') ||
      changed('temporalBucketMs') ||
      selectionChanged;

    if (coverageStale) {
      // Drop the index rather than trusting a slice enumerated from the old
      // tier; the next selection pass rebuilds it (signature check is free).
      this.coverageIndex = null;
      this.coverageBuildSignature = null;
    }

    // A newly-wired onBufferChange means the caller now wants live buffer
    // reports — same implication the constructor draws.
    if (this.options.onBufferChange && !prev.onBufferChange) {
      this.ensureBufferTracking();
    }

    // Cache limits: evict down to the NEW bound now, through the existing
    // playhead-relative tiered policy (never a special-cased LRU), so a cut
    // is honored immediately instead of at the next natural eviction. Only
    // when we are actually over — calling it while under limits would run
    // the wall-clock grace sweep, which is a selection-pass concern.
    if (changed('maxCacheSize') || changed('maxCacheByteSize')) {
      if (this.options.maxCacheSize > prev.maxCacheSize) {
        // Headroom returned: let the pinned-overview warning fire again.
        this.warnedPinnedOverCacheLimit = false;
      }
      if (
        this.loadedTileCount > this.options.maxCacheSize ||
        this.currentCacheBytes > this.options.maxCacheByteSize
      ) {
        this.evictUnusedTiles(this.neededTileKeys);
      }
    }

    // Concurrency: forward to the loader's own in-flight cap (the archive's
    // range coalescer) when wired, then re-dispatch — a RAISED budget should
    // start using its new slots now, not at the next tile arrival.
    if (changed('maxRequests')) {
      this.options.setMaxConcurrentRequests?.(this.options.maxRequests);
      void this.processRequestQueue();
    }

    // An already-armed debounce is still counting down at the OLD delay;
    // re-arm it so the new value governs this pending selection too.
    if (changed('debounceTime') && this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      if (this.options.debounceTime === 0) {
        void this.selectAndLoadTiles();
      } else {
        this.debounceTimer = setTimeout(() => {
          void this.selectAndLoadTiles();
        }, this.options.debounceTime);
      }
    }

    if (changed('enablePrefetch') && !this.options.enablePrefetch) {
      // Turned off: drop the queued + in-flight lookahead immediately
      // (flushPrefetch also re-anchors the runway and clears the selection
      // fast-path, so the re-plan below is a no-op in this direction).
      this.flushPrefetch();
    } else if (prefetchStale || changed('enablePrefetch')) {
      // Re-plan WITHOUT flushing: tiles already fetched stay resident and
      // in-flight lookahead runs to completion — the same stance
      // `setPrefetchRunAheadLimit` takes on a lowered horizon. Clearing the
      // anchor (and the wall-clock coalescing window, which an explicit
      // option change should not have to wait out) makes the next pass
      // re-plan against the new horizon immediately; bumping the generation
      // drops any plan still awaiting its directory slice under the old one.
      this.prefetch.invalidatePlan();
      this.prefetch.clearDebounce();
      if (this.options.enablePrefetch && this.currentViewport) {
        this.schedulePrefetch();
      }
    }

    if (compositionChanged) {
      // getVisibleTiles() composites differently from the SAME needed set, so
      // wake the consumer's render path even if selection settles unchanged.
      this.frameNumber++;
    }

    if (selectionChanged) {
      this.lastSelectKey = ''; // defeat the identical-params fast path
      void this.selectAndLoadTiles();
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
   * Feed one observed sim-time delta to the policy's direction hysteresis and
   * act on a flip: the prefetched span (queued AND in flight) is now behind
   * the play head — dead weight the in-flight supersession exemption would
   * otherwise let run to completion. Flushing it also resets the runway anchor
   * so the next prefetch re-plans immediately in the new direction.
   */
  private updatePrefetchDirection(simTimeDelta: number): void {
    if (this.prefetch.observeTimeDelta(simTimeDelta)) this.flushPrefetch();
  }

  /** Current committed prefetch direction (+1 forward, -1 backward). */
  getPrefetchDirection(): 1 | -1 {
    return this.prefetch.direction;
  }

  /** Most recent estimated animation speed (sim-ms per real-ms). */
  getAnimationSpeed(): number {
    return this.prefetch.animationSpeed;
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
    const { wasAnimating, directionFlipped } = this.prefetch.setAnimationState(
      isAnimating,
      speed,
    );

    // A signed speed commits a new direction outright (see the policy). Flush
    // the old-direction runway — queued and in flight, all of it behind the
    // head now — so the next prefetch re-plans the new direction at once.
    if (directionFlipped) this.flushPrefetch();

    if (this.currentViewport) {
      if (isAnimating && this.options.enablePrefetch) {
        // Debounced, not direct: a direct pass here would combine with the
        // selectAndLoadTiles() prefetch into two back-to-back query fans.
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
   * Set the interactive/motion bit that drives scrub-LOD. The PlaybackGovernor
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
   * while the post-seek gate fills).
   */
  setInteractive(interactive: boolean): void {
    if (!this.prefetch.setInteractive(interactive)) return;
    if (!this.scrubLodEnabled()) return; // kill switch: bit only, zero behavior change
    this.lastSelectKey = '';
    this.selectAndLoadTiles();
  }

  /** Current interactive/motion bit (see {@link setInteractive}). */
  get isInteractive(): boolean {
    return this.prefetch.isInteractive;
  }

  /**
   * Governor run-ahead fairness hook (optional `BufferSource` method — the
   * Shaka MAX_RUN_AHEAD analog): cap the forward prefetch horizon to at most
   * `simMs` of sim-time ahead of the playhead. In a composited scene, runway
   * buffered beyond the min-gated intersection of all required sources is
   * dead weight; the governor caps each leader near the neediest source's
   * frontier so the shared bandwidth budget flows to the laggard.
   *
   * The policy enforces the cap with an internal safety floor so it can never
   * starve this tileset's own speed-scaled gates. Lowering the cap below the
   * already-planned runway flushes NOTHING — fetched tiles stay resident, the
   * cap only stops further extension. `null` clears.
   */
  setPrefetchRunAheadLimit(simMs: number | null): void {
    this.prefetch.setRunAheadLimit(simMs);
  }

  /**
   * Declare the playback LOOP window (optional `BufferSource` method, M6/BH-7).
   * The PlaybackGovernor already knows the loop boundary — it subscribes to the
   * clock's `wrap` event — and pushes the range here on source-add and on
   * loop-mode change; `null` clears it.
   *
   * What it buys: cache eviction becomes loop-modular. Under a loop, "behind
   * the playhead" stops meaning "done with" — a tile just past the loop START
   * is the most imminent thing in the cache when the head is near the loop END.
   * The incumbent tiering evicts furthest-behind FIRST, i.e. exactly the
   * inverse of Belady across the wrap, so a looping demo re-fetches its whole
   * loop-start working set on every lap. With a range declared, distances are
   * measured modulo the loop span and those tiles are protected instead.
   *
   * Storage only — no fetch, no selection change, no eviction pass is triggered
   * by this call. A degenerate range (non-finite, or `end <= start`) is treated
   * as `null`.
   *
   * **Scope of the kill switch, stated exactly.** `setLoopWindow(null)` is the
   * rollback for the ROTATION half of BH-7 and for nothing else: with no range
   * declared, tier classification and the tier metrics are the incumbent
   * one-directional ones, tile for tile. It does NOT restore the pre-BH-7
   * eviction plan byte for byte, because BH-7's other half — the within-tier
   * byte-density band sort — is unconditional by design and reorders
   * same-band candidates whether or not a loop is declared. That half's
   * rollback is {@link setEvictionByteDensityBands}`(false)`; both are pinned
   * in `eviction-playhead-tiers.test.ts`.
   */
  setLoopWindow(range: { start: number; end: number } | null): void {
    if (
      !range ||
      !Number.isFinite(range.start) ||
      !Number.isFinite(range.end) ||
      range.end <= range.start
    ) {
      this.loopRange = null;
      return;
    }
    this.loopRange = { start: range.start, end: range.end };
  }

  /**
   * The archive's temporal bucket size in ms (optional `BufferSource` method,
   * M6/BH-7). The governor uses it to quantize its own playhead-relative
   * reasoning onto the same grid the loader tiles on, so the two agree on what
   * "one bucket away" means. `0` when the archive declares no buckets.
   */
  getTemporalBucketMs(): number {
    return this.options.temporalBucketMs;
  }

  /**
   * Update this source's fair-share weight in the process-shared request
   * scheduler (optional `BufferSource` method — the governor's bandwidth
   * re-balancing hook, effective immediately for queued work). Forwards to
   * the wired loader (normally `STTArchive.setSchedulerWeight`); no-op when
   * the {@link SpatioTemporalTilesetOptions.setSchedulerWeight} callback
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
   * spatial drop while interactive. Clamped so the drop
   * never exceeds the parent-fallback band (those coarse tiles are what the
   * fallback path already fetches — often zero new fetches) nor undershoots
   * `minZoom`. Selection-only: the coverage index, buffer/readiness APIs,
   * prefetch planner, and overview tier all keep using the undegraded zoom.
   */
  private effectiveSelectionZoom(zoom: number): number {
    if (!this.prefetch.isInteractive) return zoom;
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
   * The temporal-LOD bucket selection should request while interactive,
   * or `null` for the base tier. Non-null only when: the drag is
   * held, the temporal axis is enabled, the archive declares a pyramid AND
   * the LOD enumeration callback is wired (capability detection — archives
   * built without `--temporal-lod` no-op here), and the picked level is
   * genuinely coarser than the base bucket.
   *
   * WHICH level is picked is {@link SpatioTemporalTilesetOptions.temporalTierPolicy}'s
   * business: the default `'zoom-threshold'` mirrors
   * `STTArchive.pickTemporalLodForZoom` (the coarsest level whose
   * `maxZoomLevel` covers the requested, already-degraded zoom), while
   * `'cost-argmin'` prices the tiers and takes the cheapest. Both live behind
   * the SAME `scrubLod.temporal` kill switch — the gates below are unchanged
   * and run first, so an archive or a config that no-opped before still
   * no-ops, whatever the policy says.
   */
  private scrubTemporalLodBucketMs(
    selectionZoom: number,
    bounds: BoundingBox,
    timeRange: { start: number; end: number },
  ): number | null {
    if (!this.prefetch.isInteractive) return null;
    const cfg = this.options.scrubLod;
    if (!cfg?.temporal) return null;
    const levels = this.options.temporalLodLevels;
    if (!levels || levels.length === 0) return null;
    if (!this.options.getAvailableTemporalLodTiles) return null;
    const bucketMs =
      this.costArgminTemporalBucketMs(selectionZoom, bounds, timeRange) ??
      this.zoomThresholdTemporalBucketMs(selectionZoom, levels);
    // A pick equal to the base bucket is not a degrade — it IS the base tier,
    // so selection stays on the ordinary path (`null`), exactly as when no
    // level applies at all.
    if (bucketMs === null || bucketMs === this.options.temporalBucketMs) {
      return null;
    }
    return bucketMs;
  }

  /**
   * The INCUMBENT tier rule, retained verbatim as the fallback: the coarsest
   * declared level whose `maxZoomLevel` covers `selectionZoom`, or `null` when
   * none does. Byte-for-byte `STTArchive.pickTemporalLodForZoom`.
   */
  private zoomThresholdTemporalBucketMs(
    selectionZoom: number,
    levels: TemporalLodLevel[],
  ): number | null {
    let pick: TemporalLodLevel | null = null;
    for (const level of levels) {
      if (
        selectionZoom <= level.maxZoomLevel &&
        (pick === null || level.bucketMs > pick.bucketMs)
      ) {
        pick = level;
      }
    }
    return pick?.bucketMs ?? null;
  }

  /**
   * CO-5's cost argmin over the addressable tier set, or `null` when the
   * comparison cannot be made — which routes the caller straight back to
   * {@link zoomThresholdTemporalBucketMs}. It returns `null` when:
   *
   *  - the policy is the default `'zoom-threshold'` (the option kill switch);
   *  - either oracle is unwired, or the base bucket is unknown, so there is no
   *    exchange rate / no base candidate to compare against;
   *  - only the base tier is addressable at this zoom (nothing to choose);
   *  - any tier priced with `unknownTiles > 0` — a non-resident directory leaf.
   *    The reader COUNTS what it cannot see and abstains; it never guesses,
   *    and a cheapest-of-lower-bounds is a guess.
   *
   * Synchronous by construction: the oracle reads resident directory entries
   * with no I/O, so the selection fast-path keeps its shape and no await is
   * introduced ahead of the `selectKey` short-circuit. Cost is one directory
   * walk per addressable tier per selection pass, and it is paid ONLY while a
   * drag is held with the temporal axis and this policy both switched on —
   * every gate above returns first otherwise. Deliberately uncached: the
   * answer depends on which directory leaves are resident, and a memo keyed
   * on the viewport alone would pin an abstention after the leaves arrived.
   */
  private costArgminTemporalBucketMs(
    selectionZoom: number,
    bounds: BoundingBox,
    timeRange: { start: number; end: number },
  ): number | null {
    if (this.options.temporalTierPolicy !== 'cost-argmin') return null;
    const price = this.options.estimateSelectionCost;
    const requestPrice = this.options.getRequestOverheadBytes;
    if (!price || !requestPrice) return null;
    const base = this.options.temporalBucketMs;
    if (typeof base !== 'number' || !Number.isFinite(base) || base <= 0) {
      return null;
    }
    const tiers = addressableTemporalTiers(
      this.options.temporalLodLevels,
      base,
      selectionZoom,
    );
    if (tiers.length <= 1) return null;
    const argmin = temporalTierArgmin(
      tiers.map((bucketMs) => ({
        bucketMs,
        selection: price(bounds, selectionZoom, timeRange, { bucketMs }),
      })),
      requestPrice(),
    );
    return argmin.pick?.bucketMs ?? null;
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
      // a base tile's keys (tileKey folds the bucket in).
      return ids.map((id) =>
        id.bucketMs === undefined ? { ...id, bucketMs: scrubBucketMs } : id,
      );
    }
    return this.fetchAvailableTilesForZoom(bounds, zoom, timeRange);
  }

  /**
   * {@link fetchSelectionTilesForZoom} for a frustum CUT: one grouped,
   * cell-addressed directory slice per distinct zoom, all in parallel.
   *
   * The grouping is by ZOOM because that is the only thing tier dispatch
   * depends on — `pickTierForZoom` is a function of the zoom alone, so within a
   * group every cell shares a tier and one call serves it. Under a mixed-zoom
   * cut this means the summary tier can legitimately serve the far-field cells
   * while raw serves the near-field ones in the SAME pass, which the box path
   * (one zoom for the whole screen) could never express.
   *
   * Groups are ordered deepest-first: the near field is what the user is
   * looking at, and the loop that consumes this unshifts primaries onto the
   * priority queue in the order they arrive. Stand-ins follow, all marked
   * non-primary, so they queue behind everything the camera actually draws.
   *
   * Zooms outside the archive's `[minZoom, maxZoom]` are dropped rather than
   * clamped: clamping would move a cell to an address that covers a DIFFERENT
   * piece of ground. The cover primitive already clamps its own targets to the
   * same range, so this only fires on a hand-built cut.
   */
  private async fetchSelectionTilesForCut(
    cut: readonly TileId[],
    standIns: readonly TileId[],
    timeRange: { start: number; end: number },
    scrubBucketMs: number | null,
  ): Promise<Array<{ zoom: number; primary: boolean; tileIds: TileId[] }>> {
    const { minZoom, maxZoom } = this.options;
    const groups: Array<{ zoom: number; primary: boolean; cells: TileId[] }> =
      [];
    for (const [cells, primary] of [
      [cut, true],
      [standIns, false],
    ] as Array<[readonly TileId[], boolean]>) {
      const byZoom = new Map<number, TileId[]>();
      for (const cell of cells) {
        if (cell.z < minZoom || cell.z > maxZoom) continue;
        const list = byZoom.get(cell.z);
        if (list) list.push(cell);
        else byZoom.set(cell.z, [cell]);
      }
      for (const zoom of [...byZoom.keys()].sort((a, b) => b - a)) {
        groups.push({ zoom, primary, cells: byZoom.get(zoom)! });
      }
    }

    return Promise.all(
      groups.map(async (group) => ({
        zoom: group.zoom,
        primary: group.primary,
        tileIds: await this.fetchCellsForZoom(
          group.cells,
          group.zoom,
          timeRange,
          scrubBucketMs,
        ),
      })),
    );
  }

  /**
   * One tier-dispatched, cell-addressed slice. The dispatch ladder is
   * {@link fetchSelectionTilesForZoom}'s, rule for rule: a held scrub with a
   * temporal-LOD bucket serves raw-tier zooms from that tier, summary-tier
   * zooms keep the summary dispatch, everything else is the base tier.
   */
  private async fetchCellsForZoom(
    cells: readonly TileId[],
    zoom: number,
    timeRange: { start: number; end: number },
    scrubBucketMs: number | null,
  ): Promise<TileId[]> {
    const slice = this.options.getAvailableTilesForCells!;
    const tier = this.pickTierForZoom(zoom);
    if (scrubBucketMs !== null && tier === 'raw') {
      const ids = await slice(cells, timeRange, { bucketMs: scrubBucketMs });
      // Normalize for custom callbacks exactly as the box path does, so a LOD
      // id can never alias a base tile's keys (tileKey folds the bucket in).
      return ids.map((id) =>
        id.bucketMs === undefined ? { ...id, bucketMs: scrubBucketMs } : id,
      );
    }
    return slice(cells, timeRange, { tier });
  }

  /**
   * The frustum CUT the most recent selection pass addressed — post scrub-LOD
   * drop, post antichain reduction — or `null` when that pass ran on the
   * incumbent box path.
   *
   * FS-2 stops here: the cut governs which cells are FETCHED. FS-3 owns what a
   * mixed-zoom working set means downstream, where `getVisibleTiles` still
   * derives ONE `primaryZoom` from the needed set and treats everything coarser
   * as fallback. This accessor is how it gets the antichain it needs; nothing
   * in this file reads it.
   */
  getSelectionCut(): readonly TileId[] | null {
    return this.selectionCut;
  }

  /**
   * Run prefetchFutureTiles() as soon as the policy's wall-clock pacing allows,
   * deferring behind a single timer otherwise. Coalesces the per-tick
   * "selectAndLoadTiles → prefetch" storm during fast playback into one pass
   * per debounce window.
   */
  private schedulePrefetch(): void {
    if (this.prefetchPendingTimer !== null) {
      // Already deferred; the existing timer will run a fresh prefetch.
      return;
    }
    const wait = this.prefetch.msUntilNextRun();
    if (wait === 0) {
      this.prefetch.markRunStarted();
      this.prefetchFutureTiles();
      return;
    }
    this.prefetchPendingTimer = setTimeout(() => {
      this.prefetchPendingTimer = null;
      this.prefetch.markRunStarted();
      this.prefetchFutureTiles();
    }, wait);
  }

  /**
   * Update tileset with new viewport
   * Returns new frame number if tiles changed
   *
   * DEFENCE IN DEPTH (docs/roadmap/tile-loading-3d-2026-07.md §4.3): the box
   * arriving here is camera-derived, and every backend has at least one camera
   * for which its derivation produces a DEGENERATE box — deck's two-corner AABB
   * inverts past `bearing > atan2(h, w)`, an above-horizon unproject
   * (`pitch + fovy/2 > 90°`) returns a point behind the camera, three's globe
   * solve can collapse to a zero-height line, cesium hands back
   * `Rectangle.MAX_VALUE`. Fixing each producer is necessary but not
   * sufficient: core must survive a bad box from ANY producer, including a
   * host application driving `update()` directly. So the box is repaired here
   * as well, by the SAME primitive the backends use, and a box that carries no
   * usable information at all is REJECTED — we keep the previous viewport
   * rather than select against garbage. An inverted latitude box would
   * otherwise make `boundsToTiles`' row loop never execute (zero tiles) while
   * `getBufferedRunway` reports `complete: true` and `isLoaded` reports
   * settled: a blank map with every readiness signal saying it is fine.
   *
   * `viewport.tileCells` (FS-2, OPTIONAL) is the frustum-quadtree CUT for this
   * camera — a mixed-zoom antichain of `(z, x, y)` cells from
   * `coverFrustumQuadtree`. When it is present AND
   * {@link SpatioTemporalTilesetOptions.getAvailableTilesForCells} is wired,
   * selection addresses exactly those cells instead of enumerating
   * `[minZoom..zoom]` boxes. `bounds` and `zoom` are still REQUIRED alongside
   * it and are still the AABB values: the box keeps serving the prefetch-flush
   * tolerance, the coverage index, the prefetch planner and every readiness
   * estimate, so a cut can only ever narrow which cells are FETCHED — it never
   * silently redefines what the viewport is. Anything about the cut this method
   * cannot vouch for (not an array, empty, a non-integer or out-of-world
   * address) drops the cut and takes the incumbent path, which is a strict
   * superset by construction.
   */
  update(
    viewport: {
      bounds: BoundingBox;
      zoom: number;
      time: number;
      timeWindow: number;
      tileCells?: readonly TileId[] | null;
    },
    skipDebounce: boolean = false,
  ): number {
    const normalized = normalizeViewportBounds(viewport.bounds);
    if (!normalized) {
      // Non-finite somewhere in the box. There is no repair that preserves any
      // information, and the previous viewport is strictly better than a
      // guess: hold it, select nothing new, and leave what is on screen alone.
      if (!this.warnedRejectedViewport) {
        this.warnedRejectedViewport = true;
        console.warn(
          '[Tileset] update() received a non-finite viewport box ' +
            `(${viewport.bounds.minLon}, ${viewport.bounds.minLat}, ` +
            `${viewport.bounds.maxLon}, ${viewport.bounds.maxLat}); keeping the ` +
            'previous viewport. This is a camera→bounds derivation bug in the ' +
            'calling renderer, not a data problem.',
        );
      }
      return this.frameNumber;
    }

    const previousTime = this.currentViewport?.time;
    // The REPAIRED box, in a viewport object of our own. `normalizeViewportBounds`
    // returns a fresh bounds object, which also ends the aliasing the old
    // `currentViewport = viewport` assignment carried: the deck chassis reuses
    // one cached bounds object across frames, so a caller that mutates it in
    // place used to change what the tileset believed the last frame was.
    const cut = normalizeTileCells(viewport.tileCells);
    this.currentViewport = {
      bounds: normalized.bounds,
      zoom: viewport.zoom,
      time: viewport.time,
      timeWindow: viewport.timeWindow,
      tileCells: cut?.cells ?? null,
      cutSignature: cut?.signature ?? '',
    };

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
        Math.abs(this.prefetch.animationSpeed) * SEEK_DETECTION_REAL_MS,
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
            this.prefetch.observeSpeed(simTimeDelta / realTimeDelta);
          }
        }
      }
    }
    this.lastUpdateTime = now;

    // ── Trajectory publication (observation only) ────────────────────────────
    // This is the ONE place that sees the repaired box, the play-head and the
    // window together, so it is where the trace recorder's trajectory comes
    // from (`tools/bench/src/policy-record.mjs` feature-detects
    // `snapshots['tileset.viewport']` and refuses to write a trace without it).
    //
    // Placed AFTER the direction/speed observation above so `direction` is the
    // one this update committed, and BEFORE selection so a throwing selection
    // pass cannot swallow the sample. Deliberately NOT inside
    // `selectAndLoadTiles`: a debounced pan must still record where the camera
    // went, and the rejected-box early return above must record nothing (the
    // tileset kept its previous viewport, so the previous sample is still the
    // truth).
    //
    // Probe off ⇒ one property read inside `recordViewport`, no allocation —
    // the gate is in the callee precisely so the bounds array is never built
    // on this per-tick path. Nothing below reads what it publishes.
    recordViewport(
      this.currentViewport.bounds,
      this.currentViewport.zoom,
      this.currentViewport.time,
      this.currentViewport.timeWindow,
      this.prefetch.direction,
      this.prefetch.isAnimating,
    );

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
   * THE parent-placeholder fetch gate (CO-6): `true` skips the fetch.
   *
   * Under the default `placeholderPolicy: 'expected-value'` the verdict comes
   * from {@link placeholderWorthFetching}; whenever that abstains — a cold
   * throughput estimator, an unknown tile size, a viewport whose tile box could
   * not be computed — the decision falls through to the flat
   * {@link isOversizedParent} cutoff BIT-FOR-BIT. So a session that never
   * measures throughput behaves exactly as it did before CO-6, and the first
   * throughput sample is the only thing that changes the rule in play.
   *
   * The two invariants above the policy: `lodMode: 'additive'` never skips
   * anything, and the primary display zoom is never skipped — we always load
   * what we draw.
   */
  private shouldSkipParentFetch(tileId: TileId, primaryZoom: number): boolean {
    if (this.options.lodMode === 'additive') return false;
    if (tileId.z >= primaryZoom) return false;
    if (this.options.placeholderPolicy !== 'expected-value') {
      return this.isOversizedParent(tileId, primaryZoom);
    }
    const worth = this.placeholderWorthFetching(tileId, primaryZoom);
    if (worth === null) return this.isOversizedParent(tileId, primaryZoom);
    return !worth;
  }

  /**
   * Expected-value verdict on ONE coarse parent placeholder: is the time to
   * download it less than the blank visible-cell-ms it averts?
   *
   * ```
   *   bytes(u) / θ̂   <   λ · A(u) · min(Ê[coverMs], PLACEHOLDER_COVER_HORIZON_MS)
   * ```
   *
   * `A(u)` counts the primary-zoom cells under `u` that are inside the
   * viewport's tile box — the same clamped arithmetic pass 2 of
   * {@link getVisibleTiles} runs, and the reason a parent much larger than the
   * frame is priced on what it actually shows rather than on its nominal 4^d
   * block. `Ê[coverMs]` prices the blankness there is to avert: the ETA of `u`'s
   * still-MISSING children only, so a parent whose children have already landed
   * is worth nothing however cheap it is.
   *
   * Returns `null` — abstains, and the caller falls back to the flat rule —
   * rather than guessing, whenever an input is missing: no size lookup, an
   * unknown size for `u`, no throughput probe, no throughput sample yet, no
   * viewport, or a viewport whose tile box is degenerate. The last is the
   * fail-open stance the cover side takes for the same reason: "I could not
   * work out what you can see" must never be spent as a reason to withhold a
   * fallback.
   */
  private placeholderWorthFetching(
    tileId: TileId,
    primaryZoom: number,
  ): boolean | null {
    const getSize = this.options.getTileByteSize;
    if (!getSize) return null;
    const bytes = getSize(tileId);
    if (bytes === undefined) return null;

    const getThroughput = this.options.getThroughput;
    if (!getThroughput) return null;
    const { bytesPerMs } = getThroughput();
    if (bytesPerMs === null || !(bytesPerMs > 0)) return null;

    const bounds = this.currentViewport?.bounds;
    if (!bounds) return null;

    const zDiff = primaryZoom - tileId.z;
    if (zDiff <= 0) return null; // caller guarantees a parent; be defensive
    const n = 1 << primaryZoom;
    const xSpans = viewportTileXIntervals(bounds, primaryZoom);
    const vpMinY = latToTileClamped(bounds.maxLat, primaryZoom); // y is flipped
    const vpMaxY = latToTileClamped(bounds.minLat, primaryZoom);
    if (xSpans.length === 0 || vpMinY > vpMaxY) return null; // fail open

    const range = 1 << zDiff;
    const baseX = tileId.x << zDiff;
    const baseY = tileId.y << zDiff;
    const y0 = Math.max(baseY, vpMinY);
    const y1 = Math.min(baseY + range - 1, vpMaxY, n - 1);
    // Price the walk before running it: a whole-world viewport at a deep
    // primary zoom clamps to nothing, and this is called once per candidate
    // parent per selection AND per prefetch pass.
    const rows = Math.max(0, y1 - y0 + 1);
    let plannedCells = 0;
    for (const [vx0, vx1] of xSpans) {
      const width =
        Math.min(baseX + range - 1, vx1, n - 1) - Math.max(baseX, vx0) + 1;
      if (width > 0) plannedCells += width * rows;
    }
    if (plannedCells > PLACEHOLDER_EV_MAX_CELLS) return null;

    let visibleCells = 0;
    let missingChildBytes = 0;
    for (const [vx0, vx1] of xSpans) {
      const x0 = Math.max(baseX, vx0);
      const x1 = Math.min(baseX + range - 1, vx1, n - 1);
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          visibleCells++;
          const childId: TileId = {
            z: primaryZoom,
            x: cx,
            y: cy,
            t: tileId.t,
          };
          // A child already resident averts nothing — it is the detail the
          // placeholder would be standing in for.
          if (this.tiles.get(tileKey(childId))?.isLoaded) continue;
          missingChildBytes += getSize(childId) ?? 0;
        }
      }
    }
    // Covers nothing the camera can see: not evidence about the tile, just an
    // answer we can't price (the render box is a frame or two ahead of the
    // selection pass). Hand it back to the flat rule.
    if (visibleCells === 0) return null;

    const arrivalMs = bytes / bytesPerMs;
    const coverMs = Math.min(
      missingChildBytes / bytesPerMs,
      PLACEHOLDER_COVER_HORIZON_MS,
    );
    const avertedValueMs =
      this.options.placeholderValueLambda * visibleCells * coverMs;
    return arrivalMs < avertedValueMs;
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
    const lonSpan = lonSpanOf(bounds) || 1e-9;
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

    const { bounds, zoom, time, timeWindow, tileCells, cutSignature } =
      this.currentViewport;

    // The frustum path runs only when BOTH halves are present: a validated cut
    // from the chassis and the cell-addressed directory slice to serve it.
    // Either one missing is the incumbent box path, unchanged.
    const cellSlice = this.options.getAvailableTilesForCells;
    const hasCut = tileCells !== null && cellSlice !== null;

    // Calculate temporal range
    const timeRange = {
      start: time - timeWindow / 2,
      end: time + timeWindow / 2,
    };

    // Scrub-LOD motion tier (docs/roadmap/playback-and-loading.md): while the
    // interactive bit is held AND an axis is enabled, SELECTION degrades —
    // a coarser requested zoom (spatial axis) and/or the temporal-LOD pyramid
    // tier (temporal axis). Both resolve to the pass-through values when off,
    // and both are selection-only: coverage/runway math, prefetch, and the
    // overview tier stay on the fine settle tier (preview-only).
    const selectionZoom = this.effectiveSelectionZoom(zoom);
    const scrubBucketMs = this.scrubTemporalLodBucketMs(
      selectionZoom,
      bounds,
      timeRange,
    );

    // Cheap fast-path: when the (bounds, zoom, time-range) signature is
    // identical to the previous call we'd just rebuild the same
    // `neededTileKeys` set and recompute equality. Skip the awaited
    // `getAvailableTiles` chain entirely. Running on a TimeController
    // tick that hasn't crossed a bucket boundary, this is the common
    // case and the await round-trip is the dominant cost. The scrub-LOD
    // degrade state is part of the signature so an interactive toggle
    // between identical viewports still reselects.
    // ── The cut this pass will address, if it has a usable one ────────────
    //
    // Built here, ahead of the select key, because whether it is usable at all
    // is part of what the key identifies. The scrub-LOD spatial drop is the
    // SAME `−k` the box path applies to one global zoom, here applied to every
    // branch's target; `getZoomLevelsToLoad`'s parent band becomes
    // `cutAncestors`'s per-branch band, at the identical depth
    // (`PARENT_FALLBACK_LEVELS`, or all the way to `minZoom` under additive
    // LOD, or none at all under `no-overlap`).
    //
    // A cut with no member the archive can serve is NOT treated as a cut. It
    // would otherwise select nothing at all — a blank map — where the box path
    // clamps into range and returns something. Fail open, always.
    const { minZoom, maxZoom, refinementStrategy } = this.options;
    let cut: readonly TileId[] = [];
    let cutStandIns: readonly TileId[] = [];
    let useCells = false;
    if (hasCut) {
      const dropped = applyCutZoomDrop(
        tileCells,
        zoom - selectionZoom,
        minZoom,
      );
      if (dropped.some((c) => c.z >= minZoom && c.z <= maxZoom)) {
        cut = dropped;
        cutStandIns = cutAncestors(
          cut,
          refinementStrategy === 'no-overlap'
            ? 0
            : this.options.lodMode === 'additive'
              ? MAX_CUT_ZOOM
              : PARENT_FALLBACK_LEVELS,
          minZoom,
        );
        useCells = true;
      }
    }

    // Under the frustum path the cut is what selection actually addresses, so
    // it has to be in the key: two cameras can share a box and a zoom and cut
    // the quadtree differently. It contributes the empty string on the box
    // path, leaving that path's equality semantics exactly as they were.
    const selectKey =
      `${bounds.minLon}|${bounds.minLat}|${bounds.maxLon}|${bounds.maxLat}` +
      `|${zoom}|${selectionZoom}|${scrubBucketMs ?? ''}|${timeRange.start}|${timeRange.end}` +
      `|${useCells ? cutSignature : ''}`;
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
      // Seam-crossing-aware span/centre (see lonSpanOf / lonCenterOf): a
      // `minLon > maxLon` viewport otherwise reports a NEGATIVE span, which
      // zeroes the tolerance and flushes the prefetch runway every pass.
      const boundsLonSpan = lonSpanOf(bounds);
      const prevLonSpan = lonSpanOf(prev);
      const lonSpan = Math.max(boundsLonSpan, prevLonSpan, 1e-9);
      const latSpan = Math.max(
        bounds.maxLat - bounds.minLat,
        prev.maxLat - prev.minLat,
        1e-9,
      );
      const dCenterLon = Math.abs(lonCenterOf(bounds) - lonCenterOf(prev));
      const dCenterLat =
        Math.abs(bounds.minLat + bounds.maxLat - (prev.minLat + prev.maxLat)) /
        2;
      const dSpanLon = Math.abs(boundsLonSpan - prevLonSpan);
      const dSpanLat = Math.abs(
        bounds.maxLat - bounds.minLat - (prev.maxLat - prev.minLat),
      );
      // The zoom term becomes a CUT term under the frustum path: a quadtree
      // cut has no single zoom to compare, and its identity is the honest
      // "did the working set change?" signal. Only the KEY changes here —
      // `SPATIAL_FLUSH_TOLERANCE` and the four tolerance tests below are
      // untouched (D6's "one physical cost, three constants").
      const spatialTermChanged = useCells
        ? cutSignature !== this.lastSpatialCutKey
        : zoom !== this.lastSpatialZoom;
      spatialFlush =
        spatialTermChanged ||
        dCenterLon > lonSpan * SPATIAL_FLUSH_TOLERANCE ||
        dCenterLat > latSpan * SPATIAL_FLUSH_TOLERANCE ||
        dSpanLon > lonSpan * SPATIAL_FLUSH_TOLERANCE ||
        dSpanLat > latSpan * SPATIAL_FLUSH_TOLERANCE;
    }
    if (spatialFlush) {
      // Spatial flush only — a slice the playhead has already entered is kept
      // (see flushPrefetch's `preserveNeeded`). Seeks and direction flips
      // still flush everything.
      this.flushPrefetch(true);
    }
    // Copy (not alias) — the layer reuses its cached bounds object across frames.
    this.lastSpatialBounds = {
      minLon: bounds.minLon,
      minLat: bounds.minLat,
      maxLon: bounds.maxLon,
      maxLat: bounds.maxLat,
    };
    this.lastSpatialZoom = zoom;
    this.lastSpatialCutKey = useCells ? cutSignature : undefined;
    this.lastSelectKey = selectKey;

    // Keep the coverage index aligned with the spatial viewport (no-op until
    // a buffer API or onBufferChange enables tracking; cheap signature check
    // thereafter).
    if (this.bufferTrackingEnabled) {
      this.maybeRebuildCoverageIndex(bounds, zoom);
    }

    // Zoom levels for the BOX path: the first entry is the primary (clamped
    // display) zoom, the rest coarser parents. Built from the (possibly
    // scrub-degraded) selection zoom. The frustum path's equivalent — the cut
    // and its stand-ins — was built above the select key.
    const zoomLevels = this.getZoomLevelsToLoad(selectionZoom);
    let primaryZoom = zoomLevels[0];
    if (useCells) {
      // Every CUT member is primary at its own zoom — the mixed-zoom cover IS
      // what the camera draws. Taking the cut's shallowest zoom as the
      // "primary" for the placeholder gate therefore exempts the whole cut
      // from parent-skipping (`z >= primaryZoom` for every member) and leaves
      // only the stand-ins, which really are placeholders, in its scope.
      let shallowest = Number.POSITIVE_INFINITY;
      for (const c of cut) if (c.z < shallowest) shallowest = c.z;
      if (Number.isFinite(shallowest)) primaryZoom = shallowest;
    }
    this.selectionCut = useCells ? cut : null;

    // Mark tiles as used (for LRU)
    const now = Date.now();
    const neededTileKeys = new Set<TileKey>();

    // Generation guard: this method is async (the getAvailableTiles slice can
    // be a real network round-trip for paged directories), so two passes for
    // DIFFERENT viewports may be in flight at once. If the earlier (now stale)
    // one resolves LAST it would clobber `neededTileKeys` and the queues with
    // the wrong viewport's tiles. Stamp this pass and bail after the await once
    // a newer selection supersedes it. (`lastSelectKey` only dedupes passes
    // with IDENTICAL params; it cannot order concurrent different-param ones.)
    const generation = ++this.selectGeneration;

    // Query available tiles for every group IN PARALLEL — much faster than
    // sequential queries, especially for initial load. Each group carries
    // `primary`, which is the queue-position decision the loop below makes:
    // what the camera draws goes to the FRONT of the priority queue, coarse
    // stand-ins behind it. Tier dispatch (raw / summary / temporal-LOD) is
    // per zoom on BOTH paths — see pickTierForZoom.
    let tileIdsByZoom: Array<{
      zoom: number;
      primary: boolean;
      tileIds: TileId[];
    }>;
    try {
      tileIdsByZoom = useCells
        ? await this.fetchSelectionTilesForCut(
            cut,
            cutStandIns,
            timeRange,
            scrubBucketMs,
          )
        : await Promise.all(
            zoomLevels.map(async (z) => ({
              zoom: z,
              primary: z === selectionZoom,
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
    // O(N + Q), not O(N·Q). Rescanning the queues per candidate — a `.some()`
    // over the priority queue plus a `.findIndex()` over the prefetch queue —
    // goes quadratic exactly when it hurts: the playhead sweeping into a band
    // of prefetched buckets promotes many tiles at once. Membership is tested
    // against these Sets and the prefetch removals batched into ONE filter
    // pass after the loop, mirroring the `queuedKeys` pattern in
    // prefetchFutureTiles.
    const priorityKeys = new Set<TileKey>();
    for (const qid of this.priorityQueue) priorityKeys.add(tileKey(qid));
    const prefetchKeys = new Set<TileKey>();
    for (const qid of this.prefetchQueue) prefetchKeys.add(tileKey(qid));
    const promotedFromPrefetch = new Set<TileKey>();
    let enqueuedPriority = false;

    // Process results - primary zoom first for proper queue ordering
    for (const {
      primary: isPrimaryGroup,
      tileIds: availableTileIds,
    } of tileIdsByZoom) {
      for (const tileId of availableTileIds) {
        // Skip parent-fallback placeholders that are not worth their bytes —
        // coarse stand-ins whose download costs more than the blank screen time
        // they avert (see shouldSkipParentFetch). Never skips the primary.
        // FETCH-skip only: a skipped parent that is ALREADY loaded (e.g. a
        // pinned overview tile, or a leftover from a shallower view) costs
        // nothing to keep in the needed/visible set — excluding it would blank
        // the very fallback it exists to provide.
        if (this.shouldSkipParentFetch(tileId, primaryZoom)) {
          const key = tileKey(tileId);
          const loadedHeader = this.tiles.get(key);
          if (loadedHeader?.isLoaded) {
            neededTileKeys.add(key);
            loadedHeader.lastUsed = now;
            this.cacheStats.hits++;
          }
          continue;
        }

        const key = tileKey(tileId);
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
          if (isPrimaryGroup) {
            // What the camera draws - front of priority queue
            this.priorityQueue.unshift(tileId);
          } else {
            // Coarse stand-in - back of priority queue (still before prefetch)
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
            // A tile serving out its retry backoff is skipped: selection runs
            // on every viewport and playhead change, so without this gate the
            // request rate for a failing tile would be set by the camera
            // rather than by the tile's own history. The gate EXPIRES (unlike
            // the one-way `isFailed` latch it replaced), so a tile that failed
            // during a blip is picked straight back up by the next selection
            // once its backoff is over.
            if (
              !header.isLoading &&
              !this.isQuarantined(header) &&
              !priorityKeys.has(key)
            ) {
              // Mark for removal from the prefetch queue (batched into one
              // filter pass after the loop) instead of an O(Q) splice here.
              if (prefetchKeys.has(key)) {
                promotedFromPrefetch.add(key);
                prefetchKeys.delete(key);
              }
              // Enqueue at priority (front for what the camera draws).
              if (isPrimaryGroup) {
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
        (qid) => !promotedFromPrefetch.has(tileKey(qid)),
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

    // Prefetch when enabled, coalesced on wall-clock — see schedulePrefetch().
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
   * Decoded cache bytes per COMPRESSED directory byte, measured from the tiles
   * this tileset is holding right now (M6/BH-2, F3 repair).
   *
   * The prefetch budget has to compare a compressed sum against a decoded cap
   * (see {@link PREFETCH_COLD_BYTE_EXPANSION}); this is the only exchange rate
   * available without guessing, and it is a fact rather than a constant because
   * a resident tile has been priced BOTH ways — `getTileByteSize` gave its
   * `entry.length` before the fetch, and `estimateTileSize` gave its in-memory
   * footprint after the decode, which is exactly what the LRU charges it.
   *
   * A ratio OF SUMS, not a mean of ratios: big tiles should dominate the rate
   * the budget is converted with, because they dominate the cache. Re-derived
   * per planning pass rather than accumulated over the session, so the rate
   * tracks the current zoom/variant mix and depends on no history — same cache
   * contents, same answer, whatever order they arrived in.
   *
   * Bounded: the walk stops after {@link PREFETCH_EXPANSION_MAX_SAMPLES}
   * priced tiles or {@link PREFETCH_EXPANSION_SCAN_LIMIT} examined headers,
   * whichever comes first, so a 100k-header cache cannot make a planning pass
   * quadratic. `Map` iteration is insertion-ordered, so the truncated sample is
   * deterministic too.
   *
   * Falls back to the conservative cold value when the directory is byte-blind
   * or too few tiles are resident to measure.
   */
  private prefetchByteExpansion(): number {
    const getSize = this.options.getTileByteSize;
    if (!getSize) return PREFETCH_COLD_BYTE_EXPANSION;

    let compressed = 0;
    let decoded = 0;
    let samples = 0;
    let examined = 0;
    for (const header of this.tiles.values()) {
      if (++examined > PREFETCH_EXPANSION_SCAN_LIMIT) break;
      // Only LOADED tiles carry a decoded byteSize; a queued prefetch header
      // still reads 0 and would drag the rate toward zero if counted.
      if (!header.isLoaded || !(header.byteSize > 0)) continue;
      const entryBytes = getSize(header.id);
      if (entryBytes === undefined || !(entryBytes > 0)) continue;
      compressed += entryBytes;
      decoded += header.byteSize;
      if (++samples >= PREFETCH_EXPANSION_MAX_SAMPLES) break;
    }
    return byteExpansionRatio(compressed, decoded, samples);
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
    const bucketMs = this.options.temporalBucketMs;

    // Get zoom levels to prefetch. Deliberately the UNdegraded viewport zoom
    // even mid-scrub: prefetch is what warms the FINE settle tier while a
    // settle-commit gate holds (the coarse scrub-LOD motion tier is
    // selection-only and preview-only).
    const zoomLevels = this.getZoomLevelsToLoad(zoom);
    const primaryZoom = zoomLevels[0];
    const now = Date.now();

    // CO-2: hand the policy a directory ORACLE so the horizon is solved against
    // the cache budget instead of discovered through tier-C/D evictions. Offered
    // only when coverage tracking is ALREADY on — the oracle reads the coverage
    // index, and asking for it would otherwise enable index maintenance (one
    // extra full-time-range `getAvailableTiles` per viewport change) for
    // consumers that never wanted the readiness APIs. Without it the policy runs
    // its pressure ladder exactly as before, so the plan stays byte-identical.
    const direction = this.prefetch.direction;
    const bytesForHorizon: HorizonBytesOracle | null = this
      .bufferTrackingEnabled
      ? (horizonSimMs: number): { bytes: number; exact: boolean } =>
          this.bytesForHorizon(time, direction, horizonSimMs)
      : null;

    // The exchange rate between this pass's two byte currencies, measured once
    // and used by BOTH budgets below (F3). Everything a pass can price before
    // fetching — the horizon oracle's prefix sums and the per-candidate charge
    // alike — is in COMPRESSED directory bytes; `maxCacheByteSize` is a DECODED
    // cap. Converting the cap once, here, is what makes the two comparisons
    // honest instead of off by the compression ratio.
    const byteExpansion = this.prefetchByteExpansion();
    /** The DECODED cache cap expressed in the directory's own bytes. */
    const compressedCacheShare =
      (PREFETCH_CACHE_FRACTION * this.options.maxCacheByteSize) / byteExpansion;

    // Ask the policy for the horizon. `null` means the play head still has
    // enough planned runway ahead of it that another pass is wasted work; a
    // plan CLAIMS its span, so from here on the pass must either enqueue
    // against it or hand the anchor back via anchorTruncatedRunway.
    const plan = this.prefetch.plan({
      time,
      timeWindow,
      bucketMs,
      prefetchAhead,
      prefetchSteps,
      pipelineIdle:
        this.prefetchQueue.length === 0 && this.inflightPrefetch.size === 0,
      // The runway's share of the BYTE cache, in the oracle's currency. The
      // enqueue below is bounded by the SAME converted share
      // (`enqueueBudgetBytes`, BH-2) plus the tile-count budget as the
      // byte-blind guard, so the horizon the policy solves for and the runway
      // the pass actually commits are denominated in one unit — and that unit
      // is the one `bytesForHorizon` answers in (compressed `entry.length`
      // sums), not the decoded one the cache cap is written in.
      byteBudget: bytesForHorizon ? compressedCacheShare : null,
      bytesForHorizon,
    });
    if (!plan) return;
    const { effectiveAhead } = plan;

    if (DEBUG)
      console.log('[Tileset] Wide-range prefetch:', {
        time: new Date(time).toISOString(),
        zoomLevels,
        fullRangeStart: new Date(plan.queryRange.start).toISOString(),
        fullRangeEnd: new Date(plan.queryRange.end).toISOString(),
      });

    const pass = this.prefetch.beginPass();
    const results = await Promise.allSettled(
      zoomLevels.map(async (z) => {
        const tileIds = await this.fetchAvailableTilesForZoom(
          bounds,
          z,
          plan.queryRange,
        );
        return { zoom: z, tileIds };
      }),
    );

    // A flush (seek / spatial move / direction flip) or a newer prefetch
    // pass superseded this plan while we awaited the directory queries —
    // enqueuing its candidates now would warm buckets for a stale playhead
    // or direction (and recreate headers flushPrefetch just dropped).
    if (!this.prefetch.isCurrentPass(pass)) return;

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
    candidates.sort(
      (a, b) => plan.aheadDistance(a.t) - plan.aheadDistance(b.t),
    );

    // Bound the prefetch runway to a fraction of the cache so it can never
    // overflow the LRU and thrash. Nearest-first ordering means this budget
    // always buys the most imminent buckets; the runway then slides forward as
    // the head consumes it.
    //
    // TWO budgets, whichever binds first (M6/BH-2). Tiles are not fungible —
    // one satellite tile is ~17 MB where one sparse leaf is ~5 KB — so a
    // count-only budget can pass a runway several times the size of the BYTE
    // cache, which is the LRU's actual binding constraint. The byte budget
    // prices the runway in the unit the cache is denominated in; the count
    // budget survives as the guard for byte-blind directories, where per-tile
    // sizes are unknown (or reported as 0) and the byte budget never binds.
    //
    // ONE CURRENCY (F3). Both sides of the byte comparison are COMPRESSED
    // directory bytes: the charge is `getTileByteSize` (`entry.length`), and
    // the ceiling is the DECODED cache cap divided by the measured expansion.
    // Comparing the raw cap against compressed charges over-admits the runway
    // by the compression ratio — several-fold on real archives — which is the
    // residency failure this budget exists to prevent, not a rounding error.
    const prefetchBudget = this.prefetch.enqueueBudget(
      this.options.maxCacheSize,
    );
    const prefetchBudgetBytes = this.prefetch.enqueueBudgetBytes(
      this.options.maxCacheByteSize,
      byteExpansion,
    );
    // Same lookup + same fallback the slice sizer uses, so one pass prices a
    // tile identically whether it is being budgeted or being dispatched.
    const getTileBytes = this.options.getTileByteSize;

    // Keys already sitting in either queue: a dead header (see below) must not
    // be double-enqueued. Built once per pass — the candidate loop would be
    // O(candidates × queue) otherwise.
    const queuedKeys = new Set<TileKey>();
    for (const qid of this.prefetchQueue) queuedKeys.add(tileKey(qid));
    for (const qid of this.priorityQueue) queuedKeys.add(tileKey(qid));

    let newTilesAdded = 0;
    /** Directory bytes this pass has committed to the runway (BH-2). */
    let enqueuedBytes = 0;
    /** Set when the BYTE budget (rather than the count budget) ended the pass. */
    let byteBudgetSpent = false;
    // Furthest ahead-of-head distance actually ENQUEUED this pass — the
    // honest frontier when the budget truncates the span (behind-head
    // sentinel distances are ignored).
    let coveredAheadMs = 0;
    const noteEnqueued = (id: TileId): void => {
      const d = plan.aheadDistance(id.t);
      if (d <= effectiveAhead) coveredAheadMs = Math.max(coveredAheadMs, d);
    };
    for (const tileId of candidates) {
      if (newTilesAdded >= prefetchBudget) break;
      // Don't prefetch low-value low-zoom parent placeholders either (see
      // shouldSkipParentFetch); they'd evict the runway they're meant to warm.
      if (this.shouldSkipParentFetch(tileId, primaryZoom)) continue;
      const key = tileKey(tileId);
      const header = this.tiles.get(key);

      // DEAD header: a previous fetch was aborted (its shared batch was
      // superseded by a viewport/time change) or failed, leaving a header
      // that is neither loaded, loading, nor queued. Without reviving it, it
      // silently blocks the tile from ever being planned again — the
      // buffered runway then plateaus at "whatever survived" and a gated
      // high-speed playback starves forever. The revival resets the one-way
      // isCancelled latch (mirrors the priority-path reset in
      // selectAndLoadTiles) and re-enqueues.
      //
      // The retry backoff (isQuarantined) is the missing bound on that
      // revival: a tile the origin will NEVER serve came back here on every
      // planning pass, so the runway spent its whole budget re-fetching the
      // same 404 for as long as the viewport contained it. The gate is a
      // decaying rate rather than a permanent write-off, so lookahead work
      // lost to one bad minute is still planned again afterwards.
      const revivable =
        header !== undefined &&
        !header.isLoaded &&
        !header.isLoading &&
        !this.isQuarantined(header) &&
        !queuedKeys.has(key);

      if (header === undefined || revivable) {
        // BYTE BUDGET (BH-2), charged only against tiles this pass actually
        // commits to the runway. The first tile is admitted unconditionally —
        // the same progress guarantee the slice sizer makes for a tile bigger
        // than a whole slice — and after that the runway stops BEFORE it
        // exceeds its share of the byte cache.
        const size = getTileBytes?.(tileId) ?? PREFETCH_UNKNOWN_TILE_BYTES;
        if (newTilesAdded > 0 && enqueuedBytes + size > prefetchBudgetBytes) {
          byteBudgetSpent = true;
          break;
        }
        enqueuedBytes += size;

        if (header === undefined) {
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
        } else {
          header.isCancelled = false;
          header.lastUsed = now;
          this.prefetchQueue.push(tileId);
          queuedKeys.add(key);
        }
        newTilesAdded++;
        noteEnqueued(tileId);
      } else if (header !== undefined) {
        // Update last used time to prevent eviction
        header.lastUsed = now;
      }
    }

    // Budget-capped pass: the plan claimed the FULL speed-scaled span, but the
    // enqueue stopped at the budget (either one). Hand the honest frontier back
    // so the next pass re-plans against what was actually planned.
    if (newTilesAdded >= prefetchBudget || byteBudgetSpent) {
      this.prefetch.anchorTruncatedRunway(plan, coveredAheadMs, bucketMs);
    }

    // Log prefetch results
    if (DEBUG) {
      console.log('[Tileset] Prefetch results:', {
        totalTilesFound,
        newTilesAdded,
        enqueuedBytes,
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
      const prefetchShare = this.prefetch.isAnimating ? 0.5 : 0.33;
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

    // Prefetch: ONE small SLICE in flight at a time, sized in bytes to a fixed
    // wall-clock span of measured download (the policy sizes it). The queue is
    // drained nearest-to-playhead-first, so each
    // slice is exactly the next most-imminent stretch of runway; the
    // finally-handler (plus extendPrefetchIfDrained) dispatches the next
    // slice the moment this one settles, and re-checks priority work first.
    // A second concurrent slice would only add bandwidth contention against
    // priority fetches.
    if (this.prefetchQueue.length > 0 && this.inflightPrefetch.size === 0) {
      const budget = this.prefetch.sliceBytes(
        this.options.getThroughput?.().bytesPerMs ?? null,
      );
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
    const key = tileKey(tileId);

    // Skip if already loading, loaded, cancelled, or serving out a retry
    // backoff. The isCancelled latch is reset in selectAndLoadTiles() when a
    // tile is re-needed, so a cancelled-then-re-needed tile CAN load again;
    // the backoff gate (isQuarantined) EXPIRES, so a failed tile can too.
    const header = this.tiles.get(key);
    if (
      !header ||
      header.isLoading ||
      header.isLoaded ||
      header.isCancelled ||
      this.isQuarantined(header)
    ) {
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

    // Whether this request ended in an ABORT rather than a failure — read by
    // the settle handler. Both halves matter: `signal.aborted` catches the
    // teardown paths in this class, and the AbortError check catches an abort
    // raised INSIDE the transport (a per-request timeout, a connection-pool
    // kill) against a signal we never touched. The second half is the one the
    // old `isCancelled` test could not see, so a timing-out origin burned the
    // whole attempt budget in three flaky seconds.
    let sawAbort = false;

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
        if (error.name === 'AbortError') sawAbort = true;
        else this.options.onTileError?.(error, tileId);
      })
      .finally(() => {
        header.isLoading = false;
        header.abortController = undefined;
        this.releaseActiveRequest(key, header);
        if (inflightRecord) this.inflightPrefetch.delete(inflightRecord);
        if (tier === 'overview') this.settleOverviewKeys([key]);
        else {
          this.noteSettledWithoutTile(
            key,
            header,
            sawAbort || abortController.signal.aborted,
          );
        }

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
      key: TileKey;
      header: SpatioTemporalTileHeader;
    }[] = [];
    for (const tileId of tileIds) {
      const key = tileKey(tileId);
      const header = this.tiles.get(key);
      if (
        !header ||
        header.isLoading ||
        header.isLoaded ||
        header.isCancelled ||
        this.isQuarantined(header)
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
    /** See `sawAbort` in startTileLoad — the batch mirror. */
    let sawAbort = false;
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
        // Cross-source EDF hint (docs/roadmap/playback-and-loading.md §5): the
        // current play-head time + committed prefetch direction, so a batch
        // backed by a shared-scheduler archive can rank range-groups by
        // distance-to-playhead comparably across archives. Forwarded by the
        // layer's getTileDataBatch into STTArchive.getTiles({playheadTime}).
        playheadTime: this.currentViewport?.time,
        playheadDirection: this.prefetch.direction,
        // Spatial scheduler tie-break (perf research 2026-07): among
        // range-groups already tied in EDF/enqueue order, the one nearer the
        // viewport center resolves first. Forwarded the same way as
        // playheadTime, into STTArchive.getTiles({viewportCenter}).
        viewportCenter: this.currentViewport
          ? {
              // Seam-crossing aware, then folded back into [-180, 180): the
              // scheduler projects this as a GEOGRAPHIC longitude, so an
              // unwrapped 184 (or a crossing box's far-side midpoint) would
              // put the "nearest" tile on the wrong side of the world.
              lon: wrapLon(lonCenterOf(this.currentViewport.bounds)),
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
        // See `sawAbort` in startTileLoad: the AbortError branch also covers a
        // timeout raised inside the transport, which never touches our signal
        // and never sets `isCancelled` — the settle handler must not charge
        // that against the readiness budget.
        if (error.name === 'AbortError') sawAbort = true;
        else
          for (const { id } of started) this.options.onTileError?.(error, id);
      })
      .finally(() => {
        for (const { key, header } of started) {
          header.isLoading = false;
          header.abortController = undefined;
          this.releaseActiveRequest(key, header);
        }
        if (registry) registry.delete(inflightRecord);
        if (tier === 'overview')
          this.settleOverviewKeys(started.map((s) => s.key));
        else {
          const aborted = sawAbort || abortController.signal.aborted;
          for (const { key, header } of started)
            this.noteSettledWithoutTile(key, header, aborted);
        }
        this.processRequestQueue();
        this.extendPrefetchIfDrained();
      });

    return started.length;
  }

  /**
   * Release a key from the in-flight set at settle time — but only if this
   * request still OWNS it.
   *
   * `activeRequests` is keyed by tile, while a request holds a captured
   * `header` reference, and the two can diverge: `flushPrefetch()` and
   * `evictTiles()` both drop a header while its fetch is still in flight, and
   * the next selection pass then creates a FRESH header for the same key and
   * dispatches it. When the original request finally settles, an unconditional
   * `delete(key)` removes the entry belonging to its REPLACEMENT — the
   * in-flight accounting under-counts, and on the per-tile dispatch path the
   * freed "slot" lets `processRequestQueue` over-subscribe the connection.
   *
   * Deleting only on an exact header match would leak in the opposite
   * direction (a dropped header with no replacement would pin its key in the
   * set forever), so the release also fires when nobody else is loading it.
   */
  private releaseActiveRequest(
    key: TileKey,
    owner: SpatioTemporalTileHeader,
  ): void {
    const current = this.tiles.get(key);
    if (current === owner || !current?.isLoading) {
      this.activeRequests.delete(key);
    }
  }

  /**
   * Whether this tile is serving out its retry backoff and must not be
   * dispatched yet.
   *
   * THE dispatch gate for a tile that has settled without data — every
   * enqueue site (selection's promote branch, the prefetch dead-header
   * revival) and both start paths consult this. It replaced a one-way
   * `isFailed` check at each of those sites, which is what made a written-off
   * tile immortal: selection runs on every camera and playhead change, so
   * without a per-header gate the camera resets the budget, but with a
   * PERMANENT one the tile can never come back at all. A time-boxed gate is
   * the only version of "not right now" that is not also "not ever".
   */
  private isQuarantined(header: SpatioTemporalTileHeader): boolean {
    return header.retryAfter !== undefined && Date.now() < header.retryAfter;
  }

  /**
   * Record that a fetch for a NEEDED tile settled without producing data, and
   * schedule the revival.
   *
   * The only site that enqueues a needed tile is `selectAndLoadTiles`'s
   * candidate loop, and it is unreachable for this tile: the exact-bounds
   * `selectKey` fast path short-circuits every identical `update()`, so a
   * stationary camera never re-runs selection at all. The tile is left in
   * `neededTileKeys`, in no queue, with a header that looks eligible but that
   * nothing will ever pick up — a permanent hole that also pins the buffered
   * runway at zero, because the coverage index counts it as missing forever.
   *
   * `aborted` separates the two outcomes that both arrive here as "no tile".
   * An abort is not evidence about the tile: it is the transport being torn
   * down, by supersession, by a prefetch flush, or — the case `isCancelled`
   * cannot see, because only this class's own teardown paths set it — by a
   * timeout raised INSIDE the fetch. Charging those against the readiness
   * budget wrote off perfectly good tiles after three flaky seconds. They
   * still advance the backoff ladder, though: an abort loop is as expensive as
   * a failure loop.
   */
  private noteSettledWithoutTile(
    key: TileKey,
    header: SpatioTemporalTileHeader,
    aborted: boolean,
  ): void {
    // Loaded is success; cancelled is supersession (selection re-arms the
    // latch and re-enqueues on its own); pinned belongs to the overview tier,
    // which owns its own retry story. None of those are failures.
    if (header.isLoaded || header.isCancelled || header.isPinned) return;
    // A header that has already been replaced (flushed / evicted mid-flight)
    // is not ours to write off — the replacement is in charge now.
    if (this.tiles.get(key) !== header) return;

    // The count is charged on EVERY tier, not just the needed one: the
    // prefetch planner has its own revival for dead headers, and without a
    // shared budget a tile the origin will never serve came back through it
    // on every planning pass forever.
    if (!aborted) {
      const attempts = (header.attempts ?? 0) + 1;
      header.attempts = attempts;
      if (attempts >= FAILED_TILE_MAX_ATTEMPTS && !header.isFailed) {
        header.isFailed = true;
        // The readiness APIs stop counting this tile as missing the moment the
        // latch is set, so the runway that was pinned behind it can advance —
        // tell whoever is gating on it.
        this.notifyBufferChange();
      }
    }

    // Decaying retry rate: fast enough that a blip heals while the user is
    // still looking at the hole, slow enough that a tile the origin will never
    // serve costs one coalesced probe a minute. See
    // FAILED_TILE_RETRY_COOLDOWN_MS for why neither a flat cooldown nor a hard
    // give-up satisfies both halves.
    const settles = (header.retrySettles ?? 0) + 1;
    header.retrySettles = settles;
    header.retryAfter =
      Date.now() +
      Math.min(
        FAILED_TILE_RETRY_COOLDOWN_MS * 2 ** (settles - 1),
        FAILED_TILE_RETRY_MAX_BACKOFF_MS,
      );

    // Bound the abort exemption. Aborts deliberately do not advance `attempts`,
    // so a transport that aborts EVERY request would never latch `isFailed` and
    // would pin the runway at zero for the whole session — the failure mode the
    // attempt cap exists to prevent, reached through the abort door instead.
    // See FAILED_TILE_READINESS_WRITEOFF_SETTLES.
    if (!header.isFailed && settles >= FAILED_TILE_READINESS_WRITEOFF_SETTLES) {
      header.isFailed = true;
      this.notifyBufferChange();
    }

    // The scheduled revival is for NEEDED tiles only. Lookahead work the
    // playhead never reached is not a hole in anything the user can see, and
    // the prefetch planner re-proposes it on its own schedule (under the same
    // backoff ladder, via isQuarantined).
    if (!this.neededTileKeys.has(key)) return;
    this.retryKeys.add(key);
    this.scheduleRetrySweep();
  }

  /**
   * (Re)arm the single shared retry timer for the EARLIEST pending deadline.
   *
   * One timer, not one per key: a bad network minute produces one failed
   * settle per hole per round-trip, and a timer each would be hundreds of
   * live timers whose only job is to wake up and find nothing due. The
   * `retryDueAt` comparison keeps the arm/re-arm cost at zero in the common
   * case — a fresh failure whose deadline is later than the pending sweep
   * needs no timer work at all, because that sweep re-arms for whatever is
   * still outstanding when it runs.
   */
  private scheduleRetrySweep(): void {
    let earliest = Number.POSITIVE_INFINITY;
    for (const key of this.retryKeys) {
      const due = this.tiles.get(key)?.retryAfter ?? 0;
      if (due < earliest) earliest = due;
    }
    if (!Number.isFinite(earliest)) return;

    if (this.retryTimer !== null) {
      if (this.retryDueAt !== null && this.retryDueAt <= earliest) return;
      clearTimeout(this.retryTimer);
    }
    this.retryDueAt = earliest;
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        this.retryDueAt = null;
        this.retryFailedTiles();
      },
      Math.max(0, earliest - Date.now()),
    );
  }

  /**
   * Re-enqueue the tiles whose backoff has expired and that are still needed,
   * still unloaded, and still unqueued. Anything that healed on its own in the
   * meantime (a neighbouring batch delivered it, the viewport moved off it) is
   * dropped silently — this path only ever fills holes.
   *
   * A WRITTEN-OFF tile (`isFailed`) is deliberately still retried here. The
   * latch is the readiness verdict, not a fetch verdict: readiness has to stop
   * waiting or the runway pins at zero, but the pixels are still missing and
   * the ladder has already slowed the asking down to once a minute.
   */
  private retryFailedTiles(): void {
    if (this.retryKeys.size === 0) return;

    // Queue membership up front: re-enqueuing a tile that is already queued
    // would dispatch it twice and double-count the backoff ladder.
    const queued = new Set<TileKey>();
    for (const id of this.priorityQueue) queued.add(tileKey(id));
    for (const id of this.prefetchQueue) queued.add(tileKey(id));

    const now = Date.now();
    let enqueued = false;
    for (const key of Array.from(this.retryKeys)) {
      const header = this.tiles.get(key);
      // Gone, healed, already in flight, or off screen: drop the bookkeeping.
      // (Selection re-queues an off-screen tile if the camera comes back, and
      // its ladder rides along on the surviving header.)
      if (
        !header ||
        header.isLoaded ||
        header.isLoading ||
        !this.neededTileKeys.has(key)
      ) {
        this.retryKeys.delete(key);
        continue;
      }
      // Not due yet — this sweep was armed for an earlier tile's deadline.
      // Leave it pending; the re-arm at the bottom covers it.
      if (header.retryAfter !== undefined && now < header.retryAfter) continue;
      this.retryKeys.delete(key);
      if (queued.has(key)) continue;
      header.isCancelled = false;
      header.lastUsed = now;
      this.priorityQueue.push(header.id);
      queued.add(key);
      enqueued = true;
    }
    if (enqueued) {
      this.priorityQueueDirty = true;
      this.processRequestQueue();
    }
    // Whatever was not due yet (or was re-added by a settle while this ran)
    // needs the next sweep armed for it.
    this.scheduleRetrySweep();
  }

  /**
   * Keep the prefetch runway extending while the animation (or a buffering
   * gate impersonating one) is consuming it: a planning pass is budget-capped,
   * so when the queue and in-flight set drain before the claimed span is
   * covered, plan the next slice. A pass that finds nothing new enqueues zero
   * tiles, so this converges instead of spinning.
   */
  private extendPrefetchIfDrained(): void {
    if (!this.prefetch.isAnimating || !this.options.enablePrefetch) return;
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
  cancelSupersededRequests(neededTileKeys: Set<TileKey>): number {
    let cancelledCount = 0;

    // Keys owned by registered in-flight batches: prefetch keys are exempt
    // from supersession entirely; priority-batch keys are decided batch-wise
    // below — either way the per-tile sweep must skip them.
    const exemptKeys = new Set<TileKey>();
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
   * Whether a coverage-index tile has reached a state the readiness APIs can
   * stop waiting on: loaded, or written off after
   * {@link FAILED_TILE_MAX_ATTEMPTS} failed settles.
   *
   * The `isFailed` half is what keeps ONE permanently-absent tile from pinning
   * the buffered runway at zero for the whole session — the playback governor
   * gates the clock on `getBufferedRunway`, so a tile that will never arrive
   * but still counts as missing stops playback forever. This mirrors the
   * stance {@link isLoaded} already takes (a failed fetch counts as settled,
   * otherwise one permanent hole pins the signal false).
   *
   * MONOTONE by construction, and that is why `isFailed` stays latched even
   * though the tile keeps being retried on the backoff ladder: if readiness
   * un-wrote-off a tile for each retry, the runway would collapse to zero and
   * the governor would stall the clock once per backoff window — a periodic
   * stutter in place of one clean write-off. A retry that SUCCEEDS flips this
   * to ready through `isLoaded` instead, which is the direction that matters.
   */
  private isCoverageReady(key: TileKey): boolean {
    const header = this.tiles.get(key);
    if (!header) return false;
    return header.isLoaded || header.isFailed === true;
  }

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
    const speed = Math.abs(this.prefetch.animationSpeed);
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
        if (!this.isCoverageReady(bucket.keys[j])) {
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
        if (!this.isCoverageReady(key)) {
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
        // A written-off tile costs nothing to "finish": no fetch will ever be
        // issued for it again, so billing its bytes would inflate every ETA
        // built on this number for the rest of the session.
        if (!this.isCoverageReady(bucket.keys[j])) {
          bytes += bucket.bytes[j];
          tiles++;
        }
      }
    }
    return { bytes, tiles };
  }

  /**
   * The byte-density profile of `range`: for every temporal bucket the range
   * touches, how many directory bytes that bucket costs in total, and how many
   * of them are still missing.
   *
   * {@link estimateCost} collapses the same walk to one number, which is
   * exactly what a controller reasoning about *time* cannot use: "2 GB missing
   * somewhere in the next hour" is feasible if it is spread evenly and
   * hopeless if it is one wall two seconds ahead. The per-bucket arrays are the
   * cumulative-vs-deadline check the governor's fluid feasibility test needs,
   * and the bucket grid the prefetch horizon solve bisects over.
   *
   * All three arrays are aligned and ascending in `bucketStarts`. The bucket
   * set is byte-identical to {@link estimateCost}'s, so
   * `Σ missingBytes === estimateCost(range).bytes` for the same range —
   * written-off tiles are excluded from BOTH by {@link isCoverageReady}, since
   * no fetch will ever be issued for them again.
   *
   * Returns `null` — abstains rather than guesses — when the coverage index
   * has not been built yet, or when the byte channel is blind (no
   * `getTileByteSize`, or one wired but unable to size some tile). A blind
   * channel reports `0` per tile, and a caller cannot tell "free" from
   * "unknown"; `null` says which it is. Callers must treat `null` as "no
   * profile" and keep whatever behaviour they had before asking.
   */
  getByteDensityProfile(range: { start: number; end: number }): {
    bucketStarts: number[];
    totalBytes: number[];
    missingBytes: number[];
  } | null {
    this.ensureBufferTracking();
    const idx = this.coverageIndex;
    if (!idx || !idx.bytesKnown) return null;
    const bucketMs = this.options.temporalBucketMs;
    const starts = idx.bucketStarts;

    const outStarts: number[] = [];
    const totalBytes: number[] = [];
    const missingBytes: number[] = [];
    // Same bucket-intersection rule as estimateCost, deliberately: the two are
    // pinned equal by test and by contract.
    for (
      let i = lowerBound(starts, range.start - bucketMs);
      i < starts.length && starts[i] <= range.end;
      i++
    ) {
      const b = starts[i];
      if (b + bucketMs < range.start) continue;
      const bucket = idx.buckets.get(b)!;
      let missing = 0;
      for (let j = 0; j < bucket.keys.length; j++) {
        if (!this.isCoverageReady(bucket.keys[j])) missing += bucket.bytes[j];
      }
      outStarts.push(b);
      totalBytes.push(idx.bucketByteTotals[i]);
      missingBytes.push(missing);
    }
    return { bucketStarts: outStarts, totalBytes, missingBytes };
  }

  /**
   * Total directory bytes the viewport's tiles occupy over a probe horizon —
   * `horizonSimMs` of sim-time from `time` in `direction` — in O(log buckets)
   * off the coverage index's prefix sums.
   *
   * TOTAL, not missing, and that is the point: this prices RESIDENCY (does the
   * runway a prefetch plan is about to demand fit in the cache?), which is a
   * property of the horizon alone and therefore stable enough to bisect over.
   * A caller pricing the FETCH instead wants
   * {@link getByteDensityProfile}'s `missingBytes`, which changes with every
   * tile that settles.
   *
   * `exact` is the honesty flag and carries the same meaning as
   * {@link SelectionCost.unknownTiles} on the archive: `false` means the index
   * is missing or its byte channel is blind, `bytes` is then a floor (`0` in
   * the un-built case), and the caller must fall back rather than solve on it.
   * The horizon is used AS GIVEN (clamped only at 0) — no bucket floor — so a
   * solver's candidate horizons map monotonically onto byte totals.
   */
  bytesForHorizon(
    time: number,
    direction: 1 | -1,
    horizonSimMs: number,
  ): { bytes: number; exact: boolean } {
    this.ensureBufferTracking();
    const idx = this.coverageIndex;
    if (!idx) return { bytes: 0, exact: false };
    const horizon = Number.isFinite(horizonSimMs)
      ? Math.max(0, horizonSimMs)
      : 0;
    const bucketMs = this.options.temporalBucketMs;
    const starts = idx.bucketStarts;
    const far = time + direction * horizon;
    const spanStart = Math.min(time, far);
    const spanEnd = Math.max(time, far);
    // Half-open bucket window [lo, hi): the same intersection rule the walking
    // queries use, resolved by two binary searches instead of a scan.
    const lo = lowerBound(starts, spanStart - bucketMs);
    const hi = upperBound(starts, spanEnd);
    const bytes =
      hi > lo ? idx.cumulativeBytes[hi] - idx.cumulativeBytes[lo] : 0;
    return { bytes, exact: idx.bytesKnown };
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
   *
   * `preserveNeeded` is the SPATIAL flush's concession to a fact the tier tag
   * cannot express: a request's tier is stamped once at dispatch and never
   * promoted, so a slice the playhead has since ARRIVED AT is still labelled
   * `prefetch` even though its tiles are exactly what is being drawn right
   * now. Aborting those on a pan of 1/8 of the viewport throws away bytes the
   * priority path immediately re-requests, and the runway collapses while the
   * user is still moving. A seek or a direction flip stays TOTAL: there the
   * playhead really has left, so no in-flight slice is worth keeping.
   */
  flushPrefetch(preserveNeeded: boolean = false): void {
    // (1) Queued-but-not-started prefetch tiles: drop their headers
    //     entirely. prefetchFutureTiles only enqueues ids with NO header, so
    //     a lingering unloaded header would permanently shadow the tile from
    //     future prefetch passes. PINNED overview headers survive — the
    //     overview tier owns them and will (re)load them itself.
    for (const id of this.prefetchQueue) {
      const key = tileKey(id);
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
      // Spatial path only: a record holding a key the CURRENT selection needs
      // is serving the playhead, whatever tier it was dispatched under. The
      // needed set read here is the previous pass's — the spatial flush runs
      // from `selectAndLoadTiles` BEFORE the new set is computed — which is
      // exactly the right question to ask: "has the playhead already entered
      // this slice?", not "will it be in the set we are about to build?".
      if (
        preserveNeeded &&
        inflight.keys.some((key) => this.neededTileKeys.has(key))
      ) {
        continue;
      }
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
    this.prefetch.invalidatePlan();
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
    const seen = new Set<TileKey>();
    const candidates: TileId[] = [];
    for (const id of ids) {
      const key = tileKey(id);
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
      const key = tileKey(id);
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
      const key = tileKey(id);
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
  private settleOverviewKeys(keys: TileKey[]): void {
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
    // even while a scrub-LOD drag degrades selection (gates on release must
    // re-arm against full detail, never the coarse preview).
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
        const keySet = new Set<TileKey>();
        // Blind until proven otherwise per tile: one unknown length makes the
        // whole byte channel a floor, and a floor must not be published as a
        // total (see CoverageIndex.bytesKnown).
        let bytesKnown = true;
        for (const id of ids) {
          let bucket = buckets.get(id.t);
          if (!bucket) {
            bucket = { keys: [], bytes: [], totalBytes: 0 };
            buckets.set(id.t, bucket);
          }
          const key = tileKey(id);
          bucket.keys.push(key);
          keySet.add(key);
          const size = getSize ? getSize(id) : undefined;
          if (size === undefined) bytesKnown = false;
          const bytes = size ?? 0;
          bucket.bytes.push(bytes);
          // Same loop, not a second pass over `ids`: the per-bucket total is
          // the only quantity the density profile needs that the existing
          // build did not already have.
          bucket.totalBytes += bytes;
        }
        const bucketStarts = Array.from(buckets.keys()).sort((a, b) => a - b);
        const bucketMs = this.options.temporalBucketMs;
        // Bucket-aligned byte columns + their prefix sums. O(buckets), which is
        // strictly smaller than the O(tiles) loop above, and the only work the
        // profile adds to the build.
        const bucketByteTotals = new Float64Array(bucketStarts.length);
        const cumulativeBytes = new Float64Array(bucketStarts.length + 1);
        for (let i = 0; i < bucketStarts.length; i++) {
          const total = buckets.get(bucketStarts[i])!.totalBytes;
          bucketByteTotals[i] = total;
          cumulativeBytes[i + 1] = cumulativeBytes[i] + total;
        }
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
          bucketByteTotals,
          cumulativeBytes,
          bytesKnown,
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
      callback(this.getBufferedRunway(viewport.time, this.prefetch.direction));
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
  private evictUnusedTiles(neededTileKeys: Set<TileKey>): void {
    const now = Date.now();
    // Grace period scales with animation: longer during animation to keep prefetched tiles
    // 120 seconds during animation (2 minutes of real-time buffer)
    // 30 seconds when paused (keep recently viewed tiles)
    const GRACE_PERIOD = this.prefetch.isAnimating ? 120000 : 30000;

    // Loaded-tile count and byte total are both maintained incrementally
    // (see `loadedTileCount` / `currentCacheBytes`) and must stay that way:
    // walking every header to recount loaded tiles on each eviction pass is
    // visibly expensive at a few thousand cached tiles.
    let loadedCount = this.loadedTileCount;
    let cacheBytes = this.currentCacheBytes;

    // Only evict if we're over limits
    const overSizeLimit = loadedCount > this.options.maxCacheSize;
    const overByteLimit = cacheBytes > this.options.maxCacheByteSize;

    if (!overSizeLimit && !overByteLimit) {
      // Under limits - only evict tiles outside grace period
      const tilesToEvict: TileKey[] = [];

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

      // The grace sweep is not a playhead-relative decision — it reports as
      // tier A on the probe channel (and does not touch `evictionsByTier`).
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
    const candidates: Array<[TileKey, SpatioTemporalTileHeader]> = [];
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
    // into the protected playhead window (the thrash signal). `tierFrom` marks
    // where each tier starts in `plan`, so an eviction can be attributed to
    // the tier that freed its bytes (P0-2, observation only — the plan order
    // and the runway boundary are unchanged).
    let plan: Array<{ key: TileKey; header: SpatioTemporalTileHeader }>;
    let runwayFrom: number;
    let bFrom: number;
    let cFrom: number;
    let dFrom: number;

    if (!coverageKeys || playhead === undefined) {
      // No coverage index / no playhead (consumers that never touch the
      // buffer APIs): the original LRU behavior, unchanged.
      plan = candidates
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed) // Oldest first
        .map(([key, header]) => ({ key, header }));
      runwayFrom = plan.length; // nothing counts as a runway eviction
      // Every entry is the stale/LRU bucket — tier A.
      bFrom = cFrom = dFrom = plan.length;
    } else {
      const direction = this.prefetch.direction;
      const timeWindow = this.currentViewport?.timeWindow ?? bucketMs;
      // Back-buffer keep + protected forward window, in sim-ms. A tile's
      // bucket spans [t, t + bucketMs]; distances are signed along the
      // committed playback direction.
      const keepBehind = Math.max(timeWindow, bucketMs);
      const protectedAhead = Math.max(timeWindow, 2 * bucketMs);

      // LOOP ROTATION (BH-7a). Under a declared loop, "behind the playhead"
      // stops meaning "done with": the head will come back round, so the right
      // metric is the distance to the tile ALONG THE LOOP, i.e. modulo its
      // span. A tile just past the loop start, seen from a head near the loop
      // end, is the most imminent thing in the cache — the incumbent rule
      // classifies it tier B and evicts it FIRST, which is the exact inverse of
      // Belady and re-fetches the loop-start working set on every lap.
      //
      // The clamp is load-bearing: below it the modular metric degenerates
      // (every tile lands inside protectedAhead + keepBehind, so everything is
      // protected and the pass cannot free the bytes it must free). A loop that
      // short is already entirely inside the protected window under the
      // incumbent rule anyway, so nothing is lost by not rotating it.
      const loop = this.loopRange;
      const loopSpan = loop ? loop.end - loop.start : 0;
      const rotate = loopSpan > protectedAhead + keepBehind;

      type Ranked = {
        key: TileKey;
        header: SpatioTemporalTileHeader;
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
        if (!rotate || loop === null) {
          if (behind > keepBehind) {
            tierB.push({ key, header, metric: behind });
          } else if (ahead > protectedAhead) {
            tierC.push({ key, header, metric: ahead });
          } else {
            tierD.push({ key, header, metric: header.lastUsed });
          }
          continue;
        }

        // A tile whose whole bucket falls OUTSIDE the declared loop is never
        // replayed at all, so it must not be handed a (meaningless) wrapped
        // distance that could protect it over an in-loop tile. It goes to the
        // head of tier B, ahead of every in-loop candidate.
        if (t + bucketMs < loop.start || t > loop.end) {
          tierB.push({ key, header, metric: loopSpan + bucketMs });
          continue;
        }

        // aheadMod = ((d × (t − playhead)) mod span + span) mod span, carrying
        // the same bucket-end correction the incumbent `ahead` already applies
        // for backward playback — so with an un-wrapped tile ahead of the head
        // this is `ahead` exactly, and the rotation is a strict generalization.
        const aheadMod = ((ahead % loopSpan) + loopSpan) % loopSpan;
        // ...and the wrapped mirror of `behind`, on the same bucket geometry.
        const behindMod = loopSpan - aheadMod - bucketMs;
        if (aheadMod <= protectedAhead || behindMod <= keepBehind) {
          // The protected window, now including the wrap-around approach.
          tierD.push({ key, header, metric: header.lastUsed });
        } else if (aheadMod * 2 > loopSpan) {
          // Nearer BEHIND than ahead: the head has just passed it and will not
          // want it again until the far side of the wrap — evict first.
          tierB.push({ key, header, metric: aheadMod });
        } else {
          // Genuinely upcoming, just distant: tier C, furthest-ahead first.
          tierC.push({ key, header, metric: aheadMod });
        }
      }

      // Within-tier byte density (BH-7b): distance dominates ACROSS bands
      // (one temporal bucket wide), byte size decides INSIDE one. Never
      // crosses a tier boundary; tiers A and D keep their pure recency order.
      //
      // UNCONDITIONAL — this half of BH-7 does NOT depend on `rotate`/`loop`
      // (see EVICTION_BYTE_DENSITY_BANDS_DEFAULT for why, and for the
      // register-compliance argument). One read per pass so the comparator
      // cannot see the switch change mid-sort.
      const banded = evictionByteDensityBands;
      const band =
        banded && bucketMs > 0
          ? (m: number): number => Math.floor(m / bucketMs)
          : (m: number): number => m;
      const byDistanceThenBytes = (a: Ranked, b: Ranked): number =>
        band(b.metric) - band(a.metric) ||
        (banded ? b.header.byteSize - a.header.byteSize : 0);

      tierA.sort((a, b) => a.metric - b.metric); // LRU: oldest first
      tierB.sort(byDistanceThenBytes); // furthest first, big first inside a band
      tierC.sort(byDistanceThenBytes); // furthest first, big first inside a band
      tierD.sort((a, b) => a.metric - b.metric); // LRU (last resort)

      plan = [...tierA, ...tierB, ...tierC, ...tierD];
      runwayFrom = tierA.length + tierB.length;
      bFrom = tierA.length;
      cFrom = bFrom + tierB.length;
      dFrom = cFrom + tierC.length;
    }

    const tilesToEvict: TileKey[] = [];
    const evictTiers: EvictionTier[] = [];
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
      evictTiers.push(
        i >= dFrom ? 'd' : i >= cFrom ? 'c' : i >= bFrom ? 'b' : 'a',
      );
      loadedCount--;
      cacheBytes -= header.byteSize;
      if (i >= runwayFrom) {
        this.cacheStats.runwayEvictions++;
        runwayEvicted = true;
      }
    }

    // A tier-C/D eviction means the limits forced us into the protected
    // runway: shrink the prefetch horizon (degrade speculation) instead of
    // letting the fetch-evict-refetch loop continue. The policy recovers the
    // scale once the evictions stop — see its pressure ladder.
    if (runwayEvicted) this.prefetch.noteRunwayEviction();

    this.evictTiles(tilesToEvict, evictTiers);
  }

  /**
   * Actually evict tiles from cache. Keeps the running byte counter +
   * loaded-tile count accurate.
   *
   * `tiers` (optional, P0-2) is a parallel array naming the eviction tier that
   * selected each key. Omitted ⇒ tier A (the stale/LRU bucket: the grace
   * sweep and the no-coverage fallback). Observation only: no key is skipped,
   * reordered or retained on account of its tier.
   */
  private evictTiles(tileKeys: TileKey[], tiers?: EvictionTier[]): void {
    let evictedLoaded = false;
    // One property read when the probe is off; gates the payload ALLOCATION,
    // not just the emit (telemetry.ts's probe-off contract).
    const probeOn = isProbeEnabled();
    for (let i = 0; i < tileKeys.length; i++) {
      const key = tileKeys[i];
      const header = this.tiles.get(key);
      if (header) {
        if (header.isLoading && !header.isLoaded) {
          // Belt-and-braces: a deleted in-flight header could still receive
          // a late deliverTile() through the batch's captured reference and
          // leak its bytes into the running counters. Latch the cancel flag
          // so that delivery no-ops. (No abort here — batch members share
          // one AbortController, and the batch may carry needed tiles.)
          header.isCancelled = true;
        }
        let releasedBytes = 0;
        if (header.tile) {
          this.options.onTileUnload?.(header.tile);
          // Incrementally decrement the running counters.
          this.currentCacheBytes -= header.byteSize;
          if (header.isLoaded) this.loadedTileCount--;
          evictedLoaded = true;
          releasedBytes = header.byteSize;
        }
        this.tiles.delete(key);
        this.cacheStats.evictions++;
        this.cacheStats.bytesEvicted += releasedBytes;
        const tier = tiers?.[i] ?? 'a';
        if (tier !== 'a') this.cacheStats.evictionsByTier[tier]++;
        if (probeOn) {
          emitProbe<EvictProbeSample>('evict', {
            key,
            tier,
            bytes: releasedBytes,
            playheadMs: this.currentViewport?.time ?? null,
          });
        }
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
    // Registry keys already emitted. The stand-in passes can reach the same
    // resident tile from several directions (one ancestor covers up to
    // 4^depth missing cells), and a tile pushed twice is drawn twice.
    const emitted = new Set<TileKey>();
    // Cover set at primary zoom: "x/y/t" of loaded primary tiles.
    const primaryCover = new Set<string>();
    // "x/y/t" of primary cells the viewport NEEDS and has not received. These
    // are the only cells OUTSIDE the viewport's own tile box that can still
    // justify holding a coarse parent on screen — see the slack ring below.
    const primaryPending = new Set<string>();
    // The same cells as `primaryCover`, kept STRUCTURED for the pass-3 DP: it
    // propagates "this block already has content" upward by shifting x/y, which
    // wants integers, not the string form the cover tests key on.
    const primaryCoverIds: TileId[] = [];
    // Coarse parents pass 2 decided to keep. Also DP input: an emitted parent
    // puts content into every block above it, so no ancestor stand-in may draw
    // over one.
    const parentCoverIds: TileId[] = [];

    for (const key of this.neededTileKeys) {
      const header = this.tiles.get(key);
      if (!header || header.id.z !== primaryZoom) continue;
      const cell = `${header.id.x}/${header.id.y}/${header.id.t}`;
      if (header.isLoaded && header.tile) {
        tiles.push(header.tile);
        emitted.add(key);
        primaryCover.add(cell);
        primaryCoverIds.push(header.id);
      } else {
        primaryPending.add(cell);
      }
    }

    // Pass 2: keep a parent only if at least one of its child cells at the
    // primary zoom is uncovered. This avoids paying the parent's
    // consolidation cost once the children have finished streaming, while
    // still preserving the "show coarse data until detail arrives" promise.
    //
    // The child-cell scan is CLAMPED to the viewport's primary-zoom tile
    // range: a parent spatially larger than the viewport (a z4 parent under
    // a z8 view) always contains child cells outside the viewport, which are
    // never selected and so can never enter `primaryCover` — without the
    // clamp such a parent passes the "some child uncovered" test FOREVER and
    // keeps rendering on top of the fully-streamed primary tiles. On a
    // full-duplication archive (every zoom carries every feature, the
    // no-thinning default) that is a permanent extra full copy of the data
    // per parent level. Cells outside the viewport are invisible either way,
    // so covering them is irrelevant for rendering; cells INSIDE the
    // viewport keep the existing semantics, which also preserves the
    // sparse-archive contract (`--min-features-per-tile` omits deep-zoom
    // tiles entirely, so an in-viewport cell with no primary tile keeps its
    // parent — that parent is the only holder of those features).
    const vpBounds = this.currentViewport?.bounds;
    const nPrimary = 1 << primaryZoom;
    const worldSpans: Array<[number, number]> = [[0, nPrimary - 1]];
    // One interval normally; TWO when the viewport straddles the antimeridian
    // (see viewportTileXIntervals) — the parent's child-cell scan below is
    // intersected against each in turn.
    let vpXSpans: Array<[number, number]> = vpBounds
      ? viewportTileXIntervals(vpBounds, primaryZoom)
      : worldSpans;
    let vpMinY = vpBounds
      ? latToTileClamped(vpBounds.maxLat, primaryZoom) // y is flipped
      : 0;
    let vpMaxY = vpBounds
      ? latToTileClamped(vpBounds.minLat, primaryZoom)
      : nPrimary - 1;
    // An EMPTY viewport intersection is the one case where the clamp must not
    // be applied at all. With no columns, or with `vpMinY > vpMaxY`, the inner
    // loops never execute, `needed` stays false, and the coarse parent is
    // DROPPED — but for a FALLBACK tile "I could not work out what you can
    // see" has to mean KEEP, never discard. That inversion is reachable from a
    // degenerate camera box (docs/roadmap/tile-loading-3d-2026-07.md §1) and it
    // is precisely how a missing tile becomes a visible FLASH: the parent
    // painted the pitched frame a moment ago and is then removed from content
    // already on screen. Fall back to the unclamped child scan instead.
    if (vpXSpans.length === 0 || vpMinY > vpMaxY) {
      vpXSpans = worldSpans;
      vpMinY = 0;
      vpMaxY = nPrimary - 1;
    }
    // One primary-zoom tile of slack around the clamp, so an off-by-one at the
    // frame edge — the render-time box is the CURRENT camera's, while
    // `primaryCover` was built by a selection pass that may be a frame or two
    // behind it — cannot drop a parent that is still painting the boundary.
    // Ring cells are qualified below: they are never selected, so counting
    // them like in-box cells would make every parent whose block reaches past
    // the frame edge permanently "needed" — reinstating the full-copy-per-
    // parent-level cost the clamp exists to remove.
    const slackMinY = Math.max(0, vpMinY - 1);
    const slackMaxY = Math.min(nPrimary - 1, vpMaxY + 1);
    const slackXSpans: Array<[number, number]> = vpXSpans.map(([x0, x1]) => [
      Math.max(0, x0 - 1),
      Math.min(nPrimary - 1, x1 + 1),
    ]);
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
        emitted.add(key);
        continue;
      }
      const range = 1 << zDiff;
      const baseX = x << zDiff;
      const baseY = y << zDiff;
      // Intersect the parent's child-cell range with the SLACKENED viewport
      // range; the unslackened one still decides how each cell is judged.
      const y0 = Math.max(baseY, slackMinY);
      const y1 = Math.min(baseY + range - 1, slackMaxY);
      let needed = false;
      for (let s = 0; s < slackXSpans.length && !needed; s++) {
        const [sx0, sx1] = slackXSpans[s];
        const [vpMinX, vpMaxX] = vpXSpans[s];
        const x0 = Math.max(baseX, sx0);
        const x1 = Math.min(baseX + range - 1, sx1);
        for (let cy = y0; cy <= y1 && !needed; cy++) {
          const inRowBand = cy >= vpMinY && cy <= vpMaxY;
          for (let cx = x0; cx <= x1; cx++) {
            const cell = `${cx}/${cy}/${t}`;
            if (primaryCover.has(cell)) continue;
            // INSIDE the viewport box: unchanged semantics — any uncovered
            // cell keeps the parent, including a cell the archive has no tile
            // for at all (`--min-features-per-tile` omits deep-zoom tiles in
            // sparse regions, and the parent is then the only holder of those
            // features). IN THE SLACK RING: only a cell the viewport actually
            // asked for and has not received.
            if (
              (inRowBand && cx >= vpMinX && cx <= vpMaxX) ||
              primaryPending.has(cell)
            ) {
              needed = true;
              break;
            }
          }
        }
      }
      if (needed) {
        tiles.push(header.tile);
        emitted.add(key);
        parentCoverIds.push(header.id);
      }
    }

    // Pass 3: primary-zoom cells that are NEEDED but not yet loaded fall back
    // to an already-resident tile from the zoom the camera just left — a FINER
    // descendant after a zoom-out, a COARSER ancestor after a zoom-in. Pure
    // reuse of what is already sitting in `this.tiles` (typically what was on
    // screen a moment ago): it issues no fetches and changes nothing about
    // what `selectAndLoadTiles` requests.
    //
    // Deliberately NOT gated on the refinement strategy. It was, on the
    // reading that 'no-overlap' means "show exactly the requested zoom" — but
    // 'no-overlap' exists to stop a parent and its children being DRAWN ON TOP
    // OF EACH OTHER, and neither stand-in here can do that: a descendant
    // covers only the area of a cell that has nothing else in it, and the
    // ancestor branch refuses to draw when any primary cell under it is
    // already loaded. All ten storm4d tilesets run 'no-overlap', so with the
    // gate in place a single integer-zoom crossing — one scroll notch — blanked
    // every layer at once with neither a parent nor a descendant to stand in.
    // Run in TWO sub-passes, descendants first, because an ancestor covers
    // 4^up primary cells and therefore has to know what happened to its
    // SIBLING cells before it may draw. Interleaved (one cell fully resolved
    // at a time, as this ran originally) the outcome depended on
    // `neededTileKeys` iteration order: a cell that reached for an ancestor
    // before its sibling had picked up its descendants got both, with the
    // coarse tile laid straight over the finer stand-ins. On an opaque layer
    // that is invisible; on a translucent one — every storm4d volume and
    // isoline layer, the heatmaps, the flow corridors — it is a patch of
    // doubled density that vanishes when the real primary tile lands.
    //
    // CO-6 replaced the ancestor half of this with a bottom-up DP over the
    // resident set (see coverWithAncestorDp) and lifted its depth cap from 2 to
    // PARENT_FALLBACK_LEVELS. `coverSearch: 'capped'` restores the pre-CO-6
    // walks verbatim.
    const capped = this.options.coverSearch === 'capped';
    const downLevels = capped
      ? CHILD_LOOKAHEAD_LEVELS
      : COVER_DP_DESCENDANT_LEVELS;
    const standInCover = new Set<string>();
    const standInIds: TileId[] = [];
    const uncovered: TileId[] = [];
    for (const key of this.neededTileKeys) {
      const header = this.tiles.get(key);
      if (!header || header.id.z !== primaryZoom || header.isLoaded) continue;
      const { z, x, y, t } = header.id;
      if (
        this.collectLoadedDescendants(z, x, y, t, downLevels, tiles, emitted)
      ) {
        // Finer detail wins when both exist, and taking only one of the two
        // keeps the "never overlap" property: an ancestor drawn on top of a
        // descendant of the same cell would double-paint that area.
        standInCover.add(`${x}/${y}/${t}`);
        standInIds.push(header.id);
      } else {
        uncovered.push(header.id);
      }
    }
    if (uncovered.length === 0) return tiles;
    if (capped) {
      for (const { z, x, y, t } of uncovered) {
        this.collectLoadedAncestor(
          z,
          x,
          y,
          t,
          primaryCover,
          standInCover,
          tiles,
          emitted,
        );
      }
      return tiles;
    }
    this.coverWithAncestorDp(
      primaryZoom,
      uncovered,
      [primaryCoverIds, standInIds],
      parentCoverIds,
      tiles,
      emitted,
    );

    return tiles;
  }

  /**
   * The ancestor half of the cover pass, as a bottom-up DP over the resident
   * loaded set (CO-6). Every still-blank primary cell in `uncovered` gets the
   * NEAREST resident ancestor whose whole visible block is blank, or nothing.
   *
   * Two things change versus the capped walk it replaces, and both fall out of
   * the same restructuring:
   *
   * - THE DEPTH CAP GOES (2 → {@link COVER_DP_ANCESTOR_LEVELS}). The cap paid
   *   for a 4^up block scan per candidate cell. Here "this block already has
   *   content" is PROPAGATED UPWARD once per covered cell instead — `O(|covered|
   *   × levels)` set inserts — so the block test is a single lookup and depth
   *   costs a shift. A three-notch zoom-in now reuses the resident ancestor the
   *   fetch ladder had already bought as exactly that fallback.
   * - THE CROSS-ANCESTOR OVERLAP CLOSES. The capped walk resolved one CELL at a
   *   time and recorded nothing when it emitted, so a cell whose only cover was
   *   a grandparent could emit it, and a sibling cell processed later could then
   *   emit its own (resident, still "blank") parent INSIDE that grandparent's
   *   block — two covers over the same area, decided by `neededTileKeys`
   *   iteration order. Going LEVEL-MAJOR (all up=1 candidates, then all up=2, …)
   *   and blocking an emitted node's own ancestors makes that unreachable: the
   *   finer cover always wins, and the coarser one sees a block that is no
   *   longer blank. This is the same class of order-dependence the
   *   descendants-before-ancestors split fixed one layer up.
   *
   * Contracts held, unchanged: at most one cover per visible cell; an ancestor
   * draws only over a WHOLLY blank block; base-tier only (the synthesized ids
   * carry no `bucketMs`, so a temporal-LOD scrub preview can never stand in for
   * a settled base cell); nothing here fetches, pins, or touches the needed set.
   *
   * Deterministic: `uncovered` arrives in `neededTileKeys` order and each level
   * is walked in that order, so the delivered list is a pure function of the
   * resident set.
   *
   * @param coveredCellSets Primary cells that already have content — loaded
   *                        primaries and descendant stand-ins. Kept as separate
   *                        arrays only to avoid concatenating them per frame.
   * @param parentCoverIds  Coarse parents pass 2 kept: they put content into
   *                        every block ABOVE them.
   */
  private coverWithAncestorDp(
    primaryZoom: number,
    uncovered: TileId[],
    coveredCellSets: TileId[][],
    parentCoverIds: TileId[],
    out: Tile[],
    emitted: Set<TileKey>,
  ): void {
    const maxUp = Math.min(
      COVER_DP_ANCESTOR_LEVELS,
      primaryZoom - Math.max(0, this.options.minZoom),
    );
    if (maxUp < 1) return;

    // The DP table: quadtree nodes in [z*−maxUp, z*−1] that may NOT draw,
    // because some primary cell inside their block already has content. Built
    // bottom-up — one walk up from each covered cell — which is what makes the
    // "is this whole block blank?" question O(1) at every level instead of
    // O(4^up). Monotone by construction: a blocked node's own ancestors span a
    // superset of its block, so they are blocked too.
    const blocked = new Set<string>();
    const blockAbove = (
      x: number,
      y: number,
      t: number,
      from: number,
    ): void => {
      for (let up = from; up <= maxUp; up++) {
        blocked.add(`${primaryZoom - up}/${x >> up}/${y >> up}/${t}`);
      }
    };
    for (const cells of coveredCellSets) {
      for (const { x, y, t } of cells) blockAbove(x, y, t, 1);
    }
    // A pass-2 parent is on screen at its own level; everything coarser than it
    // would be laid over it. (Its own level is caught by the `emitted` test.)
    for (const { z, x, y, t } of parentCoverIds) {
      const up = primaryZoom - z;
      if (up >= 1 && up < maxUp) blockAbove(x << up, y << up, t, up + 1);
    }

    // Level-major sweep, nearest ancestor first. A cell drops out of `remaining`
    // the moment it is covered — or the moment it is provably uncoverable,
    // which is what `blocked` decides: if the node at this level would
    // double-paint, so would every coarser one (strict superset), exactly the
    // early-out the capped walk made per cell.
    let remaining = uncovered;
    for (let up = 1; up <= maxUp && remaining.length > 0; up++) {
      const z = primaryZoom - up;
      const next: TileId[] = [];
      for (const cell of remaining) {
        const ax = cell.x >> up;
        const ay = cell.y >> up;
        const node = `${z}/${ax}/${ay}/${cell.t}`;
        if (blocked.has(node)) continue;
        // Base tier only, deliberately: the synthesized id carries no
        // `bucketMs`, so this matches a base-tier ancestor and never a
        // temporal-LOD one.
        const key = tileKey({ z, x: ax, y: ay, t: cell.t });
        // Already on screen — a pass-2 parent, or this level's own emission for
        // a sibling cell. Either way this cell has its one cover.
        if (emitted.has(key)) continue;
        const header = this.tiles.get(key);
        if (!header?.isLoaded || !header.tile) {
          next.push(cell); // nothing resident here; try one level coarser
          continue;
        }
        out.push(header.tile);
        emitted.add(key);
        // Its block now has content, so nothing coarser may draw over it.
        blockAbove(ax << up, ay << up, cell.t, up + 1);
      }
      remaining = next;
    }
  }

  /**
   * Recursively collect already-loaded, resident tiles at zoom+1..zoom+depth
   * covering `(zoom, x, y, t)` into `out`. Stops descending into a quadrant
   * the instant a loaded tile covers it — checking deeper under an
   * already-covered cell would just double-render the same area. Render-time
   * only (see {@link getVisibleTiles}): a quadrant with no resident tile at
   * any depth is simply left uncovered, never fetched.
   *
   * Returns whether ANY descendant was emitted, so the caller knows the cell
   * already has a stand-in and does not also reach for a coarser one.
   */
  private collectLoadedDescendants(
    zoom: number,
    x: number,
    y: number,
    t: number,
    depth: number,
    out: Tile[],
    emitted: Set<TileKey>,
  ): boolean {
    if (depth <= 0 || zoom >= this.options.maxZoom) return false;
    const childZoom = zoom + 1;
    const childCoords: Array<[number, number]> = [
      [2 * x, 2 * y],
      [2 * x + 1, 2 * y],
      [2 * x, 2 * y + 1],
      [2 * x + 1, 2 * y + 1],
    ];
    let any = false;
    for (const [cx, cy] of childCoords) {
      // BASE-TIER ONLY, deliberately: the synthesized id carries no
      // `bucketMs`, so this matches base-tier descendants and never a
      // temporal-LOD one. LOD tiles are scrub previews — standing one in for
      // a settled tile would show a coarser time bucket than the viewport
      // asked for, and outlive the scrub that produced it.
      const key = tileKey({ z: childZoom, x: cx, y: cy, t });
      const header = this.tiles.get(key);
      if (header?.isLoaded && header.tile) {
        if (!emitted.has(key)) {
          out.push(header.tile);
          emitted.add(key);
        }
        any = true;
      } else if (
        this.collectLoadedDescendants(
          childZoom,
          cx,
          cy,
          t,
          depth - 1,
          out,
          emitted,
        )
      ) {
        any = true;
      }
    }
    return any;
  }

  /**
   * Emit the nearest already-resident ANCESTOR of a needed-but-unloaded
   * primary cell — the zoom-IN mirror of {@link collectLoadedDescendants}, and
   * the case that leaves a `no-overlap` tileset with nothing at all on screen
   * when one scroll notch crosses an integer zoom: the previous zoom's tiles
   * are still resident, but nothing in the needed set refers to them.
   *
   * The overlap guard is what makes this safe to run under every refinement
   * strategy: an ancestor covers 4^up primary cells, and any of those that
   * already has content is being drawn in its own right, so laying the coarse
   * copy over the top would render the same features twice. It draws only when
   * the whole block it covers is still blank. Render-time only — nothing here
   * fetches, pins, or changes the needed set.
   *
   * "Has content" is BOTH cover sets. `primaryCover` (loaded primary tiles)
   * was the only one consulted originally, which missed the case this pass
   * exists for: a camera sitting between two zooms, where some cells still
   * hold the finer children they were drawn from and others hold nothing.
   * Those descendant stand-ins are on screen exactly like a loaded primary
   * is, so an ancestor spanning them double-paints exactly the same way.
   */
  private collectLoadedAncestor(
    primaryZoom: number,
    x: number,
    y: number,
    t: number,
    primaryCover: Set<string>,
    standInCover: Set<string>,
    out: Tile[],
    emitted: Set<TileKey>,
  ): void {
    for (let up = 1; up <= ANCESTOR_LOOKBACK_LEVELS; up++) {
      const z = primaryZoom - up;
      if (z < this.options.minZoom || z < 0) return;
      const ax = x >> up;
      const ay = y >> up;
      // Base tier only, for the same reason as the descendant walk.
      const key = tileKey({ z, x: ax, y: ay, t });
      // Already on screen — either as a genuine parent fallback (pass 2) or
      // as a sibling cell's stand-in. Either way this cell is covered.
      if (emitted.has(key)) return;
      const header = this.tiles.get(key);
      if (!header?.isLoaded || !header.tile) continue;
      const span = 1 << up;
      const baseX = ax << up;
      const baseY = ay << up;
      for (let cy = baseY; cy < baseY + span; cy++) {
        for (let cx = baseX; cx < baseX + span; cx++) {
          // A coarser ancestor covers a strict superset of this block, so if
          // this one would double-paint, so would every one above it.
          const cell = `${cx}/${cy}/${t}`;
          if (primaryCover.has(cell) || standInCover.has(cell)) return;
        }
      }
      out.push(header.tile);
      emitted.add(key);
      return;
    }
  }

  /**
   * Get cache statistics.
   *
   * `hits` and `misses` reflect genuine cache behaviour: a hit is a needed tile
   * already decoded in memory, a miss is a needed tile that required a fetch.
   */
  getCacheStats(): TilesetCacheStats {
    const total = this.cacheStats.hits + this.cacheStats.misses;
    return {
      ...this.cacheStats,
      // Copy the nested counter so a caller holding the snapshot cannot
      // mutate the tileset's live accounting.
      evictionsByTier: { ...this.cacheStats.evictionsByTier },
      tileCount: this.tiles.size,
      cacheBytes: this.currentCacheBytes,
      hitRate: total > 0 ? this.cacheStats.hits / total : 0,
      activeRequests: this.activeRequests.size,
      priorityQueueLength: this.priorityQueue.length,
      prefetchQueueLength: this.prefetchQueue.length,
      prefetchPressureScale: this.prefetch.pressureScale,
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

    // The failed-tile revival is bookkeeping ABOUT headers that no longer
    // exist; firing it after a clear would enqueue ids from the torn-down
    // registry.
    this.retryKeys.clear();
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryDueAt = null;

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

  // Tile-size estimation lives in archive.ts (estimateTileSize) so the archive
  // and the tileset share one complete, consistent accounting implementation.
}

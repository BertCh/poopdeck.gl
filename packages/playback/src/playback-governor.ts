// @poopdeck.gl/playback
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/playback contributors

/**
 * PlaybackGovernor — the buffering state machine between user intent and the
 * {@link TimeController}.
 *
 * The TimeController stays a dumb wall-clock × speed rAF clock; this governor
 * wraps it and supplies the coupling video players have and data players
 * historically lacked: it gates `play()` on a buffered runway ahead of the
 * playhead, freezes the clock (instead of advancing into unloaded time) when
 * the runway drains, applies resume hysteresis (a resumeFactor× gate after a
 * stall, so one honest stall replaces a burst of micro-stalls — it bounds
 * oscillation, it does not abolish it: a link whose throughput sits at the
 * consumption rate still alternates stall and resume at the hysteresis
 * period), and turns seeks/scrubs into preview-vs-commit operations with a
 * post-seek gate. See docs/roadmap/playback-and-loading.md for the full rationale
 * and the SOTA survey behind the default thresholds.
 *
 * All thresholds are denominated in WALL-clock milliseconds × current |speed|,
 * because playback speed multiplies the data-consumption rate: 2 s of runway
 * at 1× is 2 sim-seconds; at a 65-sim-days-per-real-second drifter sweep it is
 * ~130 sim-days. A speed change is therefore a re-plan event.
 */

import { TimeController } from './time-controller.js';
import {
  SPEED_STEPS,
  DISPERSION_SCALE_K,
  dispersionScale,
} from './auto-speed.js';
import {
  emit as emitProbe,
  isProbeEnabled,
  snapshot as snapshotProbe,
  PLAYBACK_STATE_SNAPSHOT,
  type PlaybackStateSnapshot,
} from './telemetry.js';
import {
  computeProgressiveFillWeights,
  computeRunwayShedWeights,
  type ProgressiveFillProbe,
} from './fairness.js';

/**
 * Snapshot of the contiguous loaded span ahead of the playhead, as reported
 * by the core tileset's coverage index (see
 * docs/roadmap/playback-and-loading.md, the merged player-buffering record).
 */
export interface BufferedRunway {
  /** Contiguous sim-time span ahead of the query time for which every needed tile is resident. */
  simMs: number;
  /** Bytes still in flight / queued inside the measured horizon. */
  bytesPending: number;
  /** The horizon the runway was measured against (sim-ms). */
  horizonSimMs: number;
  /**
   * True when the runway reaches the dataset end (or everything inside the
   * horizon is loaded) — there is nothing left to wait for, so the governor
   * must never stall on it.
   */
  complete: boolean;
  /**
   * Optional (audit B8): true when the runway ends at a tile the loader has
   * classified as PERMANENTLY unavailable (a 4xx pack, a written-off fetch).
   * Nothing further will ever arrive for it, so gating on it would hold the
   * clock until the escape hatch: the governor treats such a runway as
   * buffered for gating purposes (it never stalls on it, like `complete`)
   * and counts the write-off in
   * {@link PlaybackQoeStats.blockedPermanentlyCount}. Absent on loaders
   * that predate the flag, and read as `false` then.
   */
  blockedPermanently?: boolean;
}

/**
 * Structural readiness/cost oracle the governor consumes. `@poopdeck.gl/core`'s
 * `SpatioTemporalTileset` satisfies this interface; defining it here keeps the
 * governor decoupled from core (it never imports tileset types) and lets tests
 * drive it with a plain object.
 */
export interface BufferSource {
  getBufferedRunway(
    time: number,
    direction: 1 | -1,
    horizonSimMs?: number,
  ): BufferedRunway;
  getBufferedRanges(opts?: {
    maxRanges?: number;
  }): Array<{ start: number; end: number }>;
  estimateCost(range: { start: number; end: number }): {
    bytes: number;
    tiles: number;
  };
  estimateTimeToReadyMs(range: { start: number; end: number }): number | null;
  flushPrefetch(): void;
  /**
   * Optional (the core tileset has it, as `SpatioTemporalTileset.getByteDensityProfile`):
   * the per-bucket byte-density profile of `range` — for every temporal bucket
   * the range touches, its ascending start and how many directory bytes of it
   * are still MISSING.
   *
   * {@link estimateCost} collapses the same walk to one number, which is
   * exactly what a controller reasoning about TIME cannot use: "2 GB missing
   * somewhere in the next minute" is comfortable if it is spread evenly and
   * hopeless if it is one wall two seconds ahead. With this the governor runs
   * the FLUID feasibility check (cumulative-missing-vs-deadline at every bucket
   * boundary) instead of the one-window ETA compare, which is what catches the
   * byte cliff two windows out (M5/CO-3).
   *
   * Honesty contract, inherited verbatim from the core implementation: `null`
   * means "no profile" — the coverage index is not built, or the byte channel
   * is blind (a blind channel reports 0 bytes per tile and a caller cannot tell
   * "free" from "unknown"). The governor treats `null`, a missing method on ANY
   * required source, and a cold throughput estimator all the same way: it falls
   * back to the incumbent one-window path, unchanged. Never guessed at.
   *
   * `bucketStarts` and `missingBytes` are aligned and `bucketStarts` ascends.
   */
  getByteDensityProfile?(range: { start: number; end: number }): {
    bucketStarts: number[];
    missingBytes: number[];
  } | null;
  /**
   * Optional (the core tileset has it): keep the loader's prefetch machinery
   * running at the given signed speed. The governor asserts this while a gate
   * holds the clock frozen — without it, freezing the clock reads as "paused"
   * to the loader, prefetch stops reaching ahead, and the gate can never fill
   * its own runway (a stall deadlock that only the escape hatch breaks).
   */
  setAnimationState?(isAnimating: boolean, speed?: number): void;
  /**
   * Optional (the core tileset has it): the interactive/motion bit — true
   * from {@link PlaybackGovernor.beginScrub} until {@link
   * PlaybackGovernor.endScrub} (scrub-LOD P0, docs/roadmap/playback-and-loading.md).
   * A loader MAY serve a cheaper preview tier while it is held (coarser
   * spatial zoom and/or a coarser temporal-LOD bucket) and MUST restore its
   * settle tier when it clears. Preview-only by contract: readiness
   * reporting ({@link getBufferedRunway} et al.) stays honest about the fine
   * tier, so gates on release re-arm against full detail.
   */
  setInteractive?(interactive: boolean): void;
  /**
   * Optional (the core tileset has it): run-ahead fairness (§5–6 of
   * docs/roadmap/playback-and-loading.md). Cap the loader's forward prefetch
   * horizon to at most `simMs` of sim-time ahead of the playhead; `null`
   * clears the cap. Shaka caps any track ~1 segment past the neediest for
   * the same reason: the clock min-gates on the required laggard (MSE
   * intersection), so buffer a leader holds beyond that intersection is dead
   * weight — it cannot be played before the laggard catches up, yet it feeds
   * cache-pressure eviction in the loader (which can evict the very runway
   * the gate is waiting on). The loader may enforce its own internal safety
   * floor.
   */
  setPrefetchRunAheadLimit?(simMs: number | null): void;
  /**
   * Optional (the core tileset has it): update this source's fair-share
   * weight in the process-shared request scheduler, effective immediately
   * for queued work. The governor re-weights dynamically in the fairness
   * pass — leaders shed share toward the required laggard, base weights are
   * restored when fairness deactivates (Phase 2 of multi-source coordination).
   */
  setBandwidthWeight?(weight: number): void;
  /**
   * Optional (the core tileset has it): declare the LOOPING range the playhead
   * wraps within, or `null` when playback is not looping (BH-7, §9.4).
   *
   * Cache eviction scores tiles by their distance ahead of / behind the
   * playhead. Under a loop that metric is the exact inverse of Belady at the
   * wrap: the tiles at the loop START are the furthest "behind" the playhead as
   * it approaches the loop END, so a wrap-blind policy evicts precisely the
   * tiles it is about to need. Given the range, a loader can compute that
   * distance in loop-modular arithmetic instead and stop doing that.
   *
   * The governor is the one component that knows the boundary (it already
   * routes the clock's `wrap` event through seek semantics), so it pushes the
   * range: on source registration, and whenever the clock's loop mode or range
   * changes (observed at the next gate/probe evaluation, or immediately via
   * {@link PlaybackGovernor.syncLoopWindows}). Sources without the method are
   * never called and behave exactly as they do today.
   */
  setLoopWindow?(range: { start: number; end: number } | null): void;
  /**
   * Optional (the core tileset has it, as its `temporalBucketMs` option): the
   * source's DECLARED temporal bucket size in sim-ms — the cadence at which its
   * buffered horizon can advance at all (BH-4, §11.2).
   *
   * The cadence tolerance band (see {@link PlaybackGovernorOptions.runwayToleranceMs})
   * exists to absorb the horizon misalignment between sources chunked at
   * DIFFERENT cadences. A single wall-ms constant cannot: 200 ms × |speed| is
   * far too small to cover a 1-hour-bucketed radar field next to a 1-minute
   * fronts overlay (false stalls), and needlessly generous for two fine-grained
   * sources. With the declared bucket the band becomes per-source —
   * `τ_i = max(Δ_i, Δ_leader) + probe-staleness` — so it absorbs exactly the
   * quantization each pair actually has.
   *
   * Report the bucket in SIM-ms (it is a property of the archive, not of the
   * playback rate); `0`, a negative value, or a missing method all mean
   * "undeclared" and fall back to the wall-ms default band — never to a zero
   * band, which would re-introduce the raw-min false stall.
   */
  getTemporalBucketMs?(): number;
  /**
   * Optional (the core tileset has it): `true` once the source has been torn
   * down and can never load another byte — a finalized `SpatioTemporalTileset`.
   *
   * A dead source is not a slow source. Its tile registry is cleared but its
   * coverage index survives, so every readiness API keeps answering "nothing
   * buffered, not complete" forever — and the gate is `min(runway)` over the
   * REQUIRED set, so ONE stale entry pins the clock at zero for the rest of the
   * session. The renderer is supposed to unregister on teardown, but a layer
   * whose id changes underneath it (a dataset swap that keeps the same time
   * range) hands the old tileset to `finalize()` without any callback the app
   * can hang an `unregisterSource` off. This bit is what lets the governor
   * notice on its own: {@link PlaybackGovernor} drops inert sources from the
   * registry at the top of every evaluation, so a leaked one self-heals instead
   * of deadlocking playback.
   *
   * Sources without the method are never inert (the incumbent behaviour).
   */
  isInert?(): boolean;
}

/** Network throughput estimate (archive dual-EWMA, see WS-A5). */
export interface ThroughputEstimate {
  bytesPerMs: number | null;
  samples?: number;
  /**
   * Standard deviation of the sampled rate around the slow average, in bytes
   * per ms — the dispersion channel `@poopdeck.gl/core`'s `ThroughputEstimator`
   * publishes alongside the point min (M5/CO-3).
   *
   * OPTIONAL BY CONTRACT: absent from a cold estimator and from any producer
   * that predates dispersion tracking, and read as `0` in both cases. Every
   * consumer here degenerates to its incumbent constant at `stdDev = 0`, so a
   * missing channel is the incumbent behaviour, not a degraded one.
   */
  stdDev?: number;
}

/**
 * Governor states:
 * - `idle`      — paused (user intent is "not playing").
 * - `starting`  — user pressed play; waiting for the start gate.
 * - `playing`   — clock running.
 * - `buffering` — runway drained mid-playback; clock frozen, waiting for the
 *                 resume gate (resumeFactor × start gate — ExoPlayer-style
 *                 hysteresis so stall/resume never oscillates).
 * - `seeking`   — a committed seek while intent is "playing"; clock frozen,
 *                 waiting for a plain (startup-sized) post-seek gate.
 */
export type PlaybackGovernorState =
  | 'idle'
  | 'starting'
  | 'playing'
  | 'buffering'
  | 'seeking';

export interface PlaybackGovernorOptions {
  /**
   * The readiness/cost oracle (normally the core tileset). Arrives async in
   * real apps — settable later via {@link PlaybackGovernor.setSource}.
   */
  source?: BufferSource | null;
  /**
   * Wall-seconds of runway required to start (or resume after a seek).
   * Required runway = `startGateWallMs × |speed|` (sim-ms).
   * @default 2000
   */
  startGateWallMs?: number;
  /**
   * Stall threshold while playing: freeze the clock when the runway drops
   * under `lowWatermarkWallMs × |speed|` and the runway is not complete.
   * @default 600
   */
  lowWatermarkWallMs?: number;
  /**
   * Resume-gate multiplier after a stall (gate = resumeFactor × start gate).
   * @default 2
   */
  resumeFactor?: number;
  /**
   * How long a scrub position must rest unchanged (while still dragging)
   * before the UI should commit it as a real seek. The governor doesn't run
   * this timer itself — it is exposed so scrubbing UIs share one knob.
   * @default 200
   */
  seekSettleMs?: number;
  /**
   * Escape hatch: if a gate hasn't passed after this long, start anyway
   * (degraded) — a broken network must never hard-lock playback.
   * @default 8000
   */
  maxStartWaitMs?: number;
  /**
   * Optional throughput getter (wire from the layer/archive EWMA). Used by
   * {@link PlaybackGovernor.getAutoSpeedSuggestion}; when absent the governor
   * falls back to the throughput implied by the source's own
   * `estimateTimeToReadyMs` (which core computes with the same estimator).
   */
  getThroughput?: (() => ThroughputEstimate) | null;
  /**
   * Cadence tolerance band (wall-ms × |speed| → sim-ms), Phase 1 of
   * multi-source coordination. When several REQUIRED sources are composited
   * they almost never share a temporal chunking/cadence, so their buffered
   * horizons land at fractionally-different sim-times even when all are
   * comfortably ahead. A raw `min()` over those horizons then spuriously
   * stalls the clock the instant the fastest-cadence source's runway dips a
   * few ms below a peer's — exactly the W3C Bug 26436 misfire (see
   * docs/roadmap/playback-and-loading.md §4: this tolerance is
   * NOT an inherited MSE/HTML mechanism, we must implement it ourselves).
   *
   * The band coalesces sub-tolerance horizon differences BETWEEN required
   * sources: a source whose runway is within `runwayToleranceMs × |speed|` of
   * the LEADING required frontier is treated as if it reached the leader (its
   * lagging tile is cadence jitter that is about to align), so it no longer
   * drags the combined min/frontier down. A source genuinely further behind
   * keeps its real (small) runway and still drags the floor — the band absorbs
   * jitter WITHOUT lowering the actual low-watermark stall protection (it never
   * lets a genuinely-starved source play past real data; see §6 Decision 1).
   * Setting this to 0 reproduces the exact Wave-1 raw-min/AND behavior.
   *
   * Denominated in WALL-ms (like every other threshold here) and scaled by
   * |speed| at evaluation time, because horizon misalignment between cadences
   * grows with the consumption rate. The default ties to the tick-probe scale
   * ({@link TICK_PROBE_INTERVAL_MS}, the wall cadence at which the frontier is
   * re-sampled): differences smaller than one probe interval of consumption
   * are below the governor's own observation resolution and must not gate.
   *
   * PRECEDENCE (BH-4). Authoring this value pins the band GLOBALLY: every
   * source is banded at `runwayToleranceMs × |speed|`, exactly as before, and
   * `0` still reproduces the raw min/AND fold bit-for-bit. Leaving it unset
   * switches the band to the per-source cadence derivation — for source *i*
   * against the leading source *L*, `τ_i = max(Δ_i, Δ_L) + 200 ms × |speed|`,
   * where Δ are the buckets sources declare via
   * {@link BufferSource.getTemporalBucketMs}. Sources that declare nothing keep
   * this default, so the derivation can only ever WIDEN the band — never
   * narrow it — and never below the probe-staleness residue it is built on.
   *
   * The derived widening is only applied when the leading source is
   * MEASURABLE — its runway is inside the horizon the probe asked for (audit
   * B7). A probe capped at the watermark or gate window reports a healthy
   * leader AT that cap, which says nothing about how far ahead it really is,
   * and a bucket-sized band measured against it lifted a starved laggard
   * past the watermark on every bucket-coarse composite. Against a capped
   * leader the band is the wall default above.
   * @default 200
   */
  runwayToleranceMs?: number;
  /**
   * Kill switch for multi-source run-ahead fairness + dynamic bandwidth
   * weights (§5–6). When true (default) and ≥2 sources are registered with an
   * incomplete required one among them, every runway probe also caps each
   * non-laggard source's forward prefetch at the laggard's frontier + slack
   * ({@link BufferSource.setPrefetchRunAheadLimit}) and re-weights required
   * sources' fair share ({@link BufferSource.setBandwidthWeight}). Set false
   * to disable both passes entirely (any outstanding caps are cleared and
   * base weights restored once). Single-source setups are unaffected either
   * way — fairness only engages with 2+ sources.
   * @default true
   */
  multiSourceFairness?: boolean;
  /**
   * Kill switch for the FLUID feasibility check (M5/CO-3). When true (default)
   * and EVERY required source exposes
   * {@link BufferSource.getByteDensityProfile} — and the throughput estimator
   * has a rate to be conservative about — the canplaythrough predictor walks
   * bucket boundaries comparing cumulative missing bytes against a moving
   * deadline, instead of comparing one window's ETA against the runway. Set
   * false to pin the incumbent one-window path even where profiles exist.
   *
   * Note the primary rollback is not this flag: a source that stops exposing
   * the profile routes to the incumbent path all by itself.
   * @default true
   */
  fluidFeasibility?: boolean;
  /**
   * Wall-ms of lookahead the fluid check spans (× |speed| → sim-ms). The walk
   * stops at the dataset end all by itself — the profile simply has no buckets
   * past it — so this only bounds the work, never the honesty. Floored at the
   * gate window being evaluated, so the fluid check can never see LESS than the
   * one-window path it replaces.
   * @default 60000
   */
  fluidCheckHorizonWallMs?: number;
  /**
   * Standard deviations of headroom for the conservative rate the fluid check
   * spends: `max(0, bytesPerMs − z·stdDev)` — the quantile-not-point-min rule.
   * `0` reproduces the point estimate exactly; a producer with no `stdDev`
   * channel does too, for any z.
   * @default 1
   */
  conservativeRateZ?: number;
  /**
   * The `k` of the shared jitter re-fit `clamp(1 + k·cv, 1, 3)`
   * (see `dispersionScale`), where `cv = stdDev / bytesPerMs`. One knob, two
   * consumers: the EFFECTIVE low watermark scales UP with it (a jittery link
   * stalls earlier and honestly) and the auto-speed safety factor scales DOWN
   * with it (a jittery link rises more slowly).
   *
   * The configured `startGateWallMs` / `lowWatermarkWallMs` / `resumeFactor`
   * stay the base — only the effective watermark moves, and it is additionally
   * held under the start gate so the re-fit can never collapse the two
   * thresholds into one. `0` disables both re-fits.
   * @default 2
   */
  dispersionK?: number;
  /**
   * Base speed (TimeController units — sim-ms per wall-ms) for ONE multiplier
   * step, i.e. `SttPlayer.baseRate`. Supplying it switches
   * {@link PlaybackGovernor.getAutoSpeedSuggestion} to LADDER evaluation
   * (M5/CO-4): every multiplier in the ladder is priced over ITS OWN horizon,
   * so a density spike that only a faster candidate's window would sweep is
   * seen before Auto upshifts into it — instead of being measured once at the
   * current speed and extrapolated.
   *
   * Pass the function form when the base rate is mutable (`SttPlayer.baseRate`
   * has a setter); it is read at evaluation time. `null`/absent/non-positive ⇒
   * candidates cannot be expressed in speed units, so the governor keeps the
   * incumbent single-point computation, bit-for-bit.
   *
   * The multiplier↔speed conversion policy stays with `SttPlayer`; this is only
   * the exchange rate it hands over.
   * @default null
   */
  baseSpeed?: number | (() => number | null) | null;
  /**
   * The multiplier ladder auto-speed evaluates, descending. Must match whatever
   * the consumer passes to `decideAutoSpeedMultiplier`'s `steps` or the
   * governor will price candidates the consumer can never select.
   * @default SPEED_STEPS (the canonical 13-step ladder)
   */
  speedSteps?: readonly number[];
  /**
   * Kill switch for auto-speed ladder evaluation (M5/CO-4). `false` restores
   * the single-point computation even when {@link baseSpeed} is supplied.
   * @default true
   */
  ladderEvaluation?: boolean;
}

/** Payload of the 'ready' event (a gate passed and the clock started). */
export interface GovernorReadyEvent {
  /** True when the maxStartWaitMs escape hatch fired instead of a real gate pass. */
  degraded: boolean;
}

/** Payload of the 'waiting' event (a gate was entered; the clock is frozen). */
export interface GovernorWaitingEvent {
  state: PlaybackGovernorState;
  /** Honest time-to-ready for the gate window, when computable. */
  etaMs: number | null;
}

export type GovernorEventMap = {
  statechange: (state: PlaybackGovernorState) => void;
  waiting: (event: GovernorWaitingEvent) => void;
  ready: (event: GovernorReadyEvent) => void;
  progress: (runway: BufferedRunway) => void;
  /** Playback parked at a non-looping range boundary (media-element 'ended'). */
  ended: (time: number) => void;
  /**
   * The scrubber was grabbed (payload: playhead at the grab). Everything
   * until 'scrubend' is preview-only; sources were told via
   * {@link BufferSource.setInteractive}.
   */
  scrubstart: (time: number) => void;
  /** The scrubber was released (payload: the committed position). */
  scrubend: (time: number) => void;
};

/**
 * Playback quality-of-experience counters (Conviva-style). Accumulated on the
 * governor's own state transitions, so a CI probe asserting `stallCount`
 * stays bounded catches the freeze/lurch failure modes the unit-level state
 * machine tests cannot see. Snapshot via
 * {@link PlaybackGovernor.getQoeStats}; every snapshot is also pushed on the
 * telemetry `playback` channel at each waiting/ready/state transition.
 */
export interface PlaybackQoeStats {
  /** Mid-playback rebuffer events (entries into 'buffering'). */
  stallCount: number;
  /** Cumulative wall ms spent in 'buffering', including any in-progress stall. */
  totalStallMs: number;
  /**
   * Wall ms the most recent start gate took (requestPlay → 'ready').
   * Null until the first start completes.
   */
  startupMs: number | null;
  /** 'ready' events that fired via the maxStartWaitMs escape hatch. */
  degradedResumeCount: number;
  /**
   * Cumulative wall ms spent in degraded creep (playhead pinned to the
   * frontier, advancing at data-arrival rate), including in-progress creep.
   */
  creepMs: number;
  /** {@link totalStallMs} under the tile-loading audit's canonical name (G2). */
  stallMs: number;
  /**
   * Committed seeks: `seekTo`, an `endScrub` release, a replay restart. A
   * loop wrap is a teleport the clock performed on its own, not a seek, and
   * is not counted here (it is a `seeking` gate entry below).
   */
  seekCount: number;
  /**
   * Median wall ms from a committed seek to its post-seek gate passing
   * (nearest-rank over the last {@link SEEK_SETTLE_SAMPLE_CAP} seeks). A
   * seek committed while paused opens no gate and contributes no sample.
   * Null until one seek has settled.
   */
  seekSettleMsP50: number | null;
  /**
   * Gate entries by reason — every time the clock was frozen and why.
   * `buffering` equals {@link stallCount}; `starting` and `seeking` are the
   * start gate and the post-seek / post-wrap gate.
   */
  gateEntriesByReason: { starting: number; buffering: number; seeking: number };
  /**
   * Gate HOLDS by reason (G3-4c): the subset of {@link gateEntriesByReason}
   * whose first evaluation did not pass — the clock actually stayed frozen
   * past `enterGate`. An entry that passes synchronously (a wrap or a seek
   * into resident time) is an entry but not a hold; a real stall is both.
   */
  gateHoldsByReason: { starting: number; buffering: number; seeking: number };
  /**
   * Backward playhead snaps to the buffered frontier on the per-tick clamp
   * path — each is a visible jump followed by a stall (audit B6/G3). Creep
   * pins are the design, not a defect, and are not counted.
   */
  frontierSnapBacks: number;
  /**
   * Sources whose runway flipped to {@link BufferedRunway.blockedPermanently}
   * (edge-triggered per source, so a re-probe of the same block is not a new
   * event): every count is a range the clock played through because nothing
   * will ever arrive for it (audit B8).
   */
  blockedPermanentlyCount: number;
}

/**
 * Scrub quality-of-experience counters for ONE drag bracket
 * ({@link PlaybackGovernor.beginScrub} … {@link PlaybackGovernor.endScrub}).
 *
 * These are the §11.6 measurements the scrub-LOD keep-vs-delete decision
 * hinges on, made readable without a browser harness. Snapshot via
 * {@link PlaybackGovernor.getScrubQoeStats}; one sample per bracket is also
 * pushed on the telemetry `scrub` channel at `scrubstart` and `scrubend`.
 *
 * OBSERVATION ONLY. Nothing here gates, degrades, or restores anything — the
 * preview-never-gates contract and the restore invariant are measured, never
 * tuned (they are in the standing do-not-touch register).
 *
 * COST. Accumulation is unconditional (so the getter is honest with or without
 * a probe bag installed) and costs one {@link PlaybackGovernor.getBufferedRanges}
 * read per preview position — the same read a buffered-range bar already
 * performs. `scrubTo` is pointer-paced, not render-paced, so this never lands
 * in the steady-state frame budget. Only the `scrub` CHANNEL emission and the
 * `bytesDuringScrub` attribution depend on the probe.
 */
export interface ScrubQoeStats {
  /**
   * Wall ms from the drag's FIRST {@link PlaybackGovernor.scrubTo} until the
   * previewed instant is covered by the required sources' buffered ranges —
   * i.e. until a frame CAN show data at the new instant. `0` when the very
   * first preview already landed on resident data (the target case: a
   * resident coarse tile inside one 60 Hz frame). `null` when the drag never
   * reached coverage, or when no preview was issued.
   *
   * This is a data-readiness proxy for time-to-first-pixel: the governor sees
   * the clock and the buffered ranges, not the compositor. A browser harness
   * that can time the actual presented frame should report ITS number and use
   * this as the lower bound.
   */
  timeToFirstPixelMs: number | null;
  /**
   * Fraction of the drag's preview positions whose instant was already
   * covered by resident data at preview time — "% of drag frames showing
   * current-instant data, any tier". `0` when the drag issued no previews.
   */
  freshFrameFraction: number;
  /**
   * Bytes fetched during the bracket, attributed by windowing the core
   * `requests` probe channel over `[bracket start, bracket end]`. Requires
   * `globalThis.__sttProbe` to be installed (the channel does not exist
   * otherwise); `0` when it is not.
   */
  bytesDuringScrub: number;
  /**
   * Wall ms from {@link PlaybackGovernor.endScrub} until the post-release
   * gate cleared — the settle-to-full-detail latency (the gate measures the
   * FINE tier by the preview-only contract, so this is honest about full
   * detail). `0` when the release did not gate at all. Reports the elapsed
   * time so far while a settle is still pending, and `null` before the first
   * release.
   */
  settleMs: number | null;
  /**
   * Interactive-bit transitions broadcast to sources during the bracket — the
   * pop/oscillation count. A clean drag is 2 (degrade at grab, restore at
   * release); extra counts mean sources joined/left or were swapped mid-drag,
   * each of which is a visible tier change.
   */
  tierSwitchCount: number;
}

/**
 * Per-source runway probe for a multi-track buffered bar / debug panel
 * (Phase 4 of multi-source coordination). One entry per registered source,
 * probed at the current playhead time + travel direction. Pure read — no side
 * effects. See {@link PlaybackGovernor.getSourceRunways}.
 */
export interface SourceRunway {
  /** The id the source was registered under (addSource key; 'default' for setSource). */
  id: string;
  /** Whether this source gates the clock (true) or continue-and-degrades (false). */
  required: boolean;
  /** Contiguous sim-time span ahead of the playhead this source has resident. */
  runwaySimMs: number;
  /** True when this source has nothing left to load (dataset end / fully buffered). */
  complete: boolean;
  /** Bytes still in flight / queued inside the source's measured horizon. */
  bytesPending: number;
}

export type GovernorEventName = keyof GovernorEventMap;

/** Re-evaluation cadence while gated (never per-rAF). */
const EVAL_INTERVAL_MS = 250;
/**
 * Wall-clock spacing of the tick-driven runway probe while PLAYING. Stall
 * detection must not depend on network events arriving: when playback has
 * nearly caught the loaded frontier, batches are by definition completing
 * slowly (often seconds apart), and an event-only watermark check lets the
 * playhead sail far past the frontier between events. The probe is a bounded
 * in-memory bucket walk — cheap at 5 Hz.
 */
const TICK_PROBE_INTERVAL_MS = 200;
/**
 * Frontier-clamp sanity bound: a single playback step can plausibly overrun
 * the (≤ TICK_PROBE_INTERVAL_MS stale) frontier by at most ~a second of
 * wall-time × |speed|. An overrun beyond this is an external seek (legacy
 * code calling `timeController.setTime` directly), which must not be snapped
 * back — the frontier is re-probed instead. Mirrors the tileset's
 * SEEK_DETECTION_REAL_MS reasoning.
 */
const CLAMP_MAX_OVERRUN_REAL_MS = 1000;
/** Ring size for {@link PlaybackQoeStats.seekSettleMsP50}'s samples. */
const SEEK_SETTLE_SAMPLE_CAP = 64;
/**
 * How many stalls the anti-flap check may swallow back-to-back before the
 * governor says so. A few are ordinary — the watermark and the resume gate
 * measure different windows, so they disagree at the margin. A stream of them
 * means they disagree STRUCTURALLY, and that is a threshold bug worth a line
 * in the console rather than a silently thinner runway.
 */
const FLAP_WARN_THRESHOLD = 20;
/** Auto-speed lookahead: cost of the next N wall-seconds at current speed. */
const AUTO_SPEED_HORIZON_WALL_MS = 8000;
/** Auto-speed safety factor (rise cautiously — same spirit as ABR's 0.7×). */
const AUTO_SPEED_SAFETY = 0.7;
/**
 * Floor for the canplaythrough predictor: when the missing remainder of a
 * gate/watermark window is predicted to download within this wall time, treat
 * it as ready with only a thin buffered runway (a cold seek on a fast network
 * must start as soon as its own bucket is resident, not wait for a
 * speed-scaled runway that can be huge at high sim-speeds). Never with NO
 * runway: see {@link PlaybackGovernor.predictsPlaythrough} (G3-4a).
 */
const PLAYTHROUGH_MIN_WALL_MS = 250;
/**
 * Run-ahead fairness slack floor (wall-ms; × |speed| → sim-ms at evaluation):
 * non-laggard sources may prefetch at most this far past the required
 * laggard's frontier (Shaka caps any track ~1 segment past the neediest —
 * buffer beyond the min-gated intersection is dead weight). Floored against
 * `runwayToleranceMs` so the cap can never bite inside the cadence-jitter
 * band the gate itself ignores.
 */
const RUN_AHEAD_SLACK_WALL_MS = 3000;
/**
 * Default lookahead of the FLUID feasibility check, in wall-ms (× |speed| →
 * sim-ms). 60 s is ~30× the default start gate: far enough out that a byte
 * cliff several windows ahead is seen while there is still runway to spend
 * reacting to it, and still a bounded, sub-millisecond walk over the coverage
 * index's prefix sums.
 */
const FLUID_CHECK_HORIZON_WALL_MS = 60_000;
/**
 * The re-fit must not collapse the two thresholds (standing register entry).
 * The effective low watermark is therefore held at this fraction of the START
 * GATE — a jittery link stalls earlier, but the watermark can never climb into
 * the gate and turn the two-threshold hysteresis into one. Only binds when the
 * configured watermark was already below the gate; a configuration that puts
 * them the other way round is left exactly as configured.
 */
const WATERMARK_GATE_HEADROOM = 0.9;
/** Fairness write throttle: caps/weights re-send only past this relative change. */
const FAIRNESS_RESEND_FRACTION = 0.2;
/**
 * Laggard-classification hysteresis, as fractions of the slack. Near-tied
 * required sources must not swap laggard identity across evaluations: a
 * to/from-null cap transition legitimately bypasses the 20% write throttle,
 * so identity flapping would re-send caps (and flush/replan prefetch
 * horizons) on every evaluation. A source ENTERS the co-laggard set only
 * within the tight band of the min; once in, it EXITS only past the wider
 * band.
 */
const LAGGARD_ENTER_BAND_FRACTION = 0.25;
const LAGGARD_EXIT_BAND_FRACTION = 0.5;
/**
 * BH-3 rollback switch (one release). `true` runs the byte-aware progressive
 * fill (`computeProgressiveFillWeights`); flipping it to `false` restores the
 * incumbent `1/x` runway shed (`computeRunwayShedWeights`) with no other
 * change — the fairness pass consumes both through the same map. Typed
 * `boolean` on purpose so the fallback branch stays live code, not something
 * the compiler narrows away.
 */
const USE_PROGRESSIVE_FILL_WEIGHTS: boolean = true;

/**
 * One probe of one registered source. A single per-source probe per
 * evaluation feeds the frontier fold AND the run-ahead-fairness/weight pass
 * (see {@link PlaybackGovernor.applyMultiSourceFairness}) — no double probing.
 */
interface SourceProbe {
  id: string;
  required: boolean;
  /** The registered (base) Phase 2 fair-share weight. */
  baseWeight: number;
  source: BufferSource;
  runway: BufferedRunway;
  /**
   * The source's DECLARED temporal bucket in sim-ms at probe time (BH-4), or
   * null when it declares none. Collected here — not re-read inside the fold —
   * so every consumer of one probe sweep sees one consistent cadence vector.
   */
  bucketMs: number | null;
}

/**
 * One required source's contribution to the frontier fold: its runway plus the
 * cadence it was probed at. The pair travels together because the lift band is
 * now per-source (`τ_i = max(Δ_i, Δ_L) + π|s|`, BH-4) and a runway without its
 * Δ cannot be banded.
 */
interface RunwayFoldEntry {
  runway: BufferedRunway;
  /** Declared temporal bucket in sim-ms, or null (undeclared → wall default). */
  bucketMs: number | null;
}

export class PlaybackGovernor {
  /** Exposed so scrubbing UIs can share the settle knob (see options). */
  readonly seekSettleMs: number;

  private readonly timeController: TimeController;
  private readonly startGateWallMs: number;
  private readonly lowWatermarkWallMs: number;
  private readonly resumeFactor: number;
  private readonly maxStartWaitMs: number;
  private readonly getThroughput: (() => ThroughputEstimate) | null;
  /** Cadence tolerance in WALL-ms; scaled by |speed| per evaluation. See options. */
  private readonly runwayToleranceMs: number;
  /**
   * True when `runwayToleranceMs` was AUTHORED. An authored band wins globally
   * (BH-4 precedence): the per-source cadence derivation replaces only the
   * default, so `runwayToleranceMs: 0` still folds the exact raw min.
   */
  private readonly runwayToleranceAuthored: boolean;
  /** Kill switch for run-ahead fairness + dynamic weights (see options). */
  private readonly multiSourceFairness: boolean;
  /** Kill switch for the fluid feasibility check (see options). */
  private readonly fluidFeasibility: boolean;
  /** Fluid-check lookahead in WALL-ms; scaled by |speed| per evaluation. */
  private readonly fluidCheckHorizonWallMs: number;
  /** Standard deviations of headroom on the conservative rate (see options). */
  private readonly conservativeRateZ: number;
  /** `k` of the shared jitter re-fit `clamp(1 + k·cv, 1, 3)` (see options). */
  private readonly dispersionK: number;
  /** Base speed for auto-speed ladder candidates, or null (see options). */
  private readonly baseSpeed: number | (() => number | null) | null;
  /** Multiplier ladder auto-speed evaluates (see options). */
  private readonly speedSteps: readonly number[];
  /** Kill switch for auto-speed ladder evaluation (see options). */
  private readonly ladderEvaluation: boolean;

  /**
   * The classified source registry (Phase 0 of multi-source coordination).
   * Replaces the historical single `source`. Each entry carries a `required`
   * flag (gates the clock) and a base `weight` (Phase 2 bandwidth share, now
   * wired: {@link applyMultiSourceFairness} re-weights required sources
   * around it — leaders shed toward the laggard — and deactivation restores
   * it). The clock's combined buffer health is folded over the REQUIRED
   * subset only — `min` runway, `AND` complete, nearest frontier — while
   * side-effects (prefetch keep-alive, flush, run-ahead caps) broadcast to
   * ALL sources. See docs/roadmap/playback-and-loading.md §5–6.
   */
  private sources = new Map<
    string,
    { source: BufferSource; required: boolean; weight: number }
  >();
  /**
   * Fairness write throttles: the last cap / weight actually SENT per source
   * id (absent = never sent). A cap re-sends only on a to/from-null
   * transition or a >20% change; a weight only on a >20% change from the last
   * sent (or base) value — runway jitter must not spam the loader/scheduler.
   */
  private lastSentCaps = new Map<string, number | null>();
  private lastSentWeights = new Map<string, number>();
  /**
   * Loop-window write memo (BH-7): the range last pushed per source id, or
   * null when the last push cleared it. Absent = never pushed, which is the
   * same state a fresh source is in — so a non-looping session never calls
   * {@link BufferSource.setLoopWindow} at all.
   */
  private lastSentLoopRanges = new Map<
    string,
    { start: number; end: number } | null
  >();
  /**
   * β memo (BH-3): the last frontier byte density computed per source id,
   * keyed by the (frontier bucket, Δ) it was measured over. `estimateCost` is a
   * directory walk; the probe cadence would otherwise pay one per source per
   * 200 ms. Invalidated by the key, so it re-measures exactly when the frontier
   * crosses a bucket or the speed changes Δ.
   */
  private betaMemo = new Map<string, { key: string; beta: number | null }>();
  /** Laggard ids from the last fairness pass (removing one deactivates fairness). */
  private lastLaggardIds = new Set<string>();
  /** Wall time of the last SELF-probed fairness pass (gated-path rate limit).
   * Starts at -Infinity so the FIRST gated pass is never suppressed (a fake
   * clock — or a real one — may sit at epoch 0 when the gate opens). */
  private lastFairnessSelfProbeWall = -Infinity;
  private _state: PlaybackGovernorState = 'idle';
  /**
   * What the USER wants, tracked separately from the machine state so a pause
   * pressed during 'buffering'/'starting' sticks (the gate must not resume a
   * playback the user no longer wants).
   */
  private userWantsPlayback = false;
  /** Gate multiplier for the CURRENT gate: 1 for start/seek, resumeFactor after a stall. */
  private gateFactor = 1;
  /** Wall timestamp the current gate was entered (drives maxStartWaitMs). */
  private gateStartedAtWall = 0;
  /**
   * Watermark stalls suppressed by the anti-flap check since the runway was
   * last healthy. Diagnostic: a healthy session leaves this at 0, and a
   * persistent disagreement between the resume gate and the watermark reports
   * itself once instead of oscillating silently.
   */
  private flapSuppressedStalls = 0;
  /** One-shot latch for the flap warning (never warn per frame). */
  private warnedGateFlap = false;
  private evalTimer: ReturnType<typeof setInterval> | null = null;
  private scrubbing = false;
  /**
   * Settle-commit memo: the position {@link seekTo} committed while the thumb
   * was still held. Releasing on the same position must not pay a second
   * prefetch flush + gate — endScrub just lifts the scrub hold.
   */
  private scrubCommittedTime: number | null = null;
  /**
   * True while parked at a non-looping range boundary. Distinct from a user
   * pause: the next requestPlay restarts from the range start (media-element
   * replay convention) instead of passing a complete-at-end gate only for the
   * first tick to re-clamp — a one-frame no-op.
   */
  private endedAtBoundary = false;
  private disposed = false;
  private warnedDisposedUse = false;
  /**
   * Absolute sim-time of the buffered frontier in the current travel
   * direction (`+Infinity`/`-Infinity` when the runway is complete, `null`
   * when unknown — no source, zero speed, or invalidated by a seek/gate).
   * The playhead is never allowed past it: the per-tick clamp below snaps an
   * overrun back to the frontier so a stall always lands ON loaded data —
   * never on a blank frame deep in unloaded time.
   */
  private bufferedUntil: number | null = null;
  /** Direction `bufferedUntil` was probed in; a flip invalidates it. */
  private frontierDirection: 1 | -1 = 1;
  /** Wall timestamp of the last frontier probe (throttles the tick path). */
  private lastFrontierProbeWall = 0;
  /**
   * Degraded-creep mode: set when a gate passed via the maxStartWaitMs
   * escape hatch (the runway could NOT fill — sustained throughput deficit,
   * prefetch budget cap, …). Re-entering 'buffering' would then just freeze
   * for another maxStartWaitMs and lurch, over and over. Instead the
   * low-watermark stall is suppressed and the per-tick clamp pins the
   * playhead AT the frontier, so playback advances exactly as fast as data
   * arrives — the best possible behavior under a deficit. Normal stalling
   * re-arms once the runway recovers past the resume gate.
   */
  private degradedCreep = false;
  /** Guards the tick subscription against reacting to our own setTime calls. */
  private suppressTickClamp = false;
  // ── QoE accounting (see PlaybackQoeStats) ─────────────────────────────────
  private qoeStallCount = 0;
  private qoeTotalStallMs = 0;
  private qoeStartupMs: number | null = null;
  private qoeDegradedResumeCount = 0;
  private qoeCreepMs = 0;
  private qoeSeekCount = 0;
  private qoeFrontierSnapBacks = 0;
  private qoeBlockedPermanentlyCount = 0;
  private readonly qoeGateEntries = { starting: 0, buffering: 0, seeking: 0 };
  private readonly qoeGateHolds = { starting: 0, buffering: 0, seeking: 0 };
  /** Wall ms from commit to gate pass, newest last (bounded ring). */
  private readonly qoeSeekSettleSamples: number[] = [];
  /**
   * Wall timestamp of the seek awaiting its post-seek gate, or null when no
   * committed seek is pending a settle sample (paused seeks, loop wraps).
   */
  private seekCommittedAtWall: number | null = null;
  /** Sources currently reporting a permanent block (edge detection). */
  private readonly blockedSourceIds = new Set<string>();
  /**
   * A source WITHOUT the buffering API was offered (and rejected). The
   * registry stays empty by design, but the escape hatch must still resolve
   * the gate — that is the documented degrade for a loader predating the
   * API — whereas an empty registry nobody has offered anything to must NOT
   * hatch (audit G8 / CS-9: there is nothing to be degraded about).
   */
  private hatchArmedByRejectedSource = false;
  /** Wall timestamp the current 'buffering' state was entered. */
  private stallEnteredAtWall = 0;
  /** Wall timestamp the current degraded creep began. */
  private creepStartedAtWall = 0;
  // ── Scrub QoE accounting (see ScrubQoeStats) ──────────────────────────────
  /**
   * The bracket being accumulated: the live drag while `scrubbing`, otherwise
   * the most recently completed one. Null before the first `beginScrub`.
   */
  private scrubQoe: {
    /** Wall stamp of beginScrub — the left edge of the byte window. */
    startedAtWall: number;
    /** Wall stamp of endScrub; null while the thumb is still held. */
    endedAtWall: number | null;
    /** Wall stamp of the first scrubTo in this bracket; null until one lands. */
    firstPreviewAtWall: number | null;
    /** Wall stamp of the first preview instant observed as covered. */
    firstFreshAtWall: number | null;
    /** Preview positions issued in this bracket. */
    previews: number;
    /** Previews whose instant was already covered at preview time. */
    freshPreviews: number;
    /** Interactive-bit broadcasts inside the bracket. */
    tierSwitches: number;
    /** Wall stamp endScrub entered a gate; null when not settling. */
    settlePendingSince: number | null;
    /** Closed settle latency; null until the post-release gate clears. */
    settleMs: number | null;
  } | null = null;
  /**
   * Guards the playState subscription against reacting to OUR OWN play/pause
   * calls (the controller notifies synchronously).
   */
  private suppressPlayStateSync = false;

  private listeners: { [K in GovernorEventName]: Set<GovernorEventMap[K]> } = {
    statechange: new Set(),
    waiting: new Set(),
    ready: new Set(),
    progress: new Set(),
    ended: new Set(),
    scrubstart: new Set(),
    scrubend: new Set(),
  };

  /**
   * Keeps the governor's model in sync with the clock when something else
   * touches it: an external `pause()` (e.g. the clock clamped at a non-looping
   * range end, or legacy code pausing directly) drops user intent; a speed
   * change (which fires playState while playing) is a re-plan event.
   */
  private readonly playStateHandler = (
    playing: boolean,
    _speed: number,
  ): void => {
    if (this.suppressPlayStateSync || this.disposed) return;
    if (!playing && this._state === 'playing' && this.userWantsPlayback) {
      // External pause — honor it as user intent so we don't resurrect playback.
      // Every non-looping range-end clamp routes through here, so lift the
      // fairness interventions exactly as requestPause does — otherwise
      // run-ahead caps and shed weights stay applied for the whole time the
      // demo sits parked at its end.
      this.userWantsPlayback = false;
      this.stopEvalTimer();
      this.deactivateFairness();
      this.setState('idle');
      return;
    }
    if (playing && this._state === 'idle' && !this.userWantsPlayback) {
      // External play (legacy direct timeController.play()) — adopt it.
      this.userWantsPlayback = true;
      this.endedAtBoundary = false;
      this.setState('playing');
      return;
    }
    // Speed changes (and bounce reversals) re-evaluate gates immediately:
    // required runway is denominated in wall-time × |speed|.
    this.evaluateNow();
  };

  /**
   * Per-tick frontier enforcement while PLAYING (the clock is a free-running
   * wall × speed rAF loop that knows nothing about data):
   *
   * 1. Every TICK_PROBE_INTERVAL_MS, re-probe the buffered frontier and run
   *    the low-watermark check — stall detection driven by the CLOCK, so a
   *    quiet network (no buffer events) can no longer blind it while the
   *    playhead burns through the remaining runway.
   * 2. If the playhead crossed the frontier anyway (probe staleness at high
   *    sim-speed), snap it back and stall THERE — the frozen frame is then
   *    fully-loaded data with its trail intact, and the resume gate measures
   *    from the true frontier instead of from a point in the void.
   * 3. In degraded-creep mode, (2) pins without re-gating: playback advances
   *    at data-arrival rate instead of looping 8 s freezes.
   * 4. A crossing is checked against a FRESH frontier before it snaps or
   *    gates (audit B6/G3): the cached one can be up to a probe interval
   *    old, and a bucket that landed inside that window (with no buffer
   *    event, or one the coalescing below absorbed) used to cost a spurious
   *    one-frame stall plus a backward jump of one frame × |speed|. The
   *    re-probe is taken AT the cached frontier — not at the overrun
   *    playhead, where a runway honestly reads zero and would move the
   *    frontier onto the playhead itself, a stall in the void. One probe per
   *    crossing, never per frame: the clock stops (gate) or the frontier
   *    moved ahead (no crossing until it is reached again).
   */
  private readonly tickHandler = (time: number): void => {
    if (this.disposed || this.suppressTickClamp || this.scrubbing) return;
    if (this._state !== 'playing' || !this.userWantsPlayback) return;
    if (!this.timeController.isPlaying()) return;
    if (!this.hasAnySource()) return;
    const speed = this.timeController.getSpeed();
    if (speed === 0) return;
    const direction: 1 | -1 = speed < 0 ? -1 : 1;

    let probedThisTick = false;
    if (
      this.bufferedUntil === null ||
      direction !== this.frontierDirection ||
      nowWall() - this.lastFrontierProbeWall >= TICK_PROBE_INTERVAL_MS
    ) {
      this.refreshFrontier();
      probedThisTick = true;
      // A fresh probe that found the head PAST the frontier — its own bucket
      // is not resident, and refreshFrontier anchored the frontier at the end
      // of the data behind it (G3-4b) — belongs to the clamp below: snap
      // back onto loaded data, then gate THERE. Running the watermark first
      // would freeze the clock where it stands, in the void.
      if (
        !this.degradedCreep &&
        !this.headPastFrontier(time, direction, Math.abs(speed))
      ) {
        this.checkLowWatermark();
        if (this._state !== 'playing') return; // the watermark gated; clock frozen
      }
    }

    let frontier = this.bufferedUntil;
    if (frontier === null || !Number.isFinite(frontier)) return;
    let overrunSimMs = direction > 0 ? time - frontier : frontier - time;
    if (overrunSimMs <= 0) return;
    if (overrunSimMs > Math.abs(speed) * CLAMP_MAX_OVERRUN_REAL_MS) {
      // Far past the frontier in one step: an external seek, not playback —
      // never snap a seek back. Invalidate and let the next tick re-probe.
      this.bufferedUntil = null;
      return;
    }
    if (!this.degradedCreep && !probedThisTick) {
      // (4) above. Creep is exempt: its pin IS the design (no gate, no
      // stall), and re-probing it per frame would be per-frame O(N) work —
      // creep keeps the data-paced refresh in evaluateNow instead.
      frontier = this.reprobeFrontierFrom(frontier, direction, Math.abs(speed));
      if (!Number.isFinite(frontier)) return;
      overrunSimMs = direction > 0 ? time - frontier : frontier - time;
      if (overrunSimMs <= 0) return; // the data landed — nothing to snap
    }
    this.setClockTime(frontier);
    if (!this.degradedCreep) {
      this.qoeFrontierSnapBacks++;
      this.enterGate('buffering', this.resumeFactor);
    }
  };

  /**
   * Loop-wrap subscription: a wrap is a teleport-seek the clock performed on
   * its own — the playhead jumps the full range span, so the resident tile
   * window and the cached frontier are both invalid. Route it through the
   * same commit path as a user seek: flush stale prefetch and re-gate at the
   * PLAIN startup gate (gateFactor 1). Falling through to checkLowWatermark
   * instead would charge the wrap the resumeFactor× RESUME gate after a
   * probe-interval ungated blind window — paid on every loop of every demo
   * on slow networks. A wrap into fully-cached time passes the gate
   * synchronously, so seamless loops stay seamless.
   */
  private readonly wrapHandler = (_time: number): void => {
    if (this.disposed || this.scrubbing) return;
    // A wrap is the strongest possible evidence that the clock is looping and
    // that the range is the one it just wrapped within (BH-7): push it before
    // anything else, so the post-wrap refill's eviction pass already scores in
    // loop-modular arithmetic.
    this.syncLoopWindows();
    // The frontier is stale after a wrap regardless of machine state.
    this.bufferedUntil = null;
    if (this._state !== 'playing' || !this.userWantsPlayback) return;
    // Only a source that never received the loop window has STALE prefetch at
    // a wrap. A source that accepts `setLoopWindow` plans its runway modulo
    // the loop (tile-loading audit 2026-08, B5): the buckets after the wrap
    // are exactly the ones it warmed while the head approached the end, and
    // its in-flight lookahead is the loop start — flushing it here would turn
    // every lap into a cold seek, which is the defect B5 removed. The gate
    // below still re-checks the frontier, so a loop-aware source that is
    // genuinely behind is caught the same way as before.
    for (const source of this.allSources()) {
      if (typeof source.setLoopWindow !== 'function') source.flushPrefetch();
    }
    this.setDegradedCreep(false);
    // A wrap is the clock's own teleport, not a committed seek: it must not
    // contribute a seek-settle sample (QoE G2).
    this.seekCommittedAtWall = null;
    this.enterGate('seeking', 1);
  };

  /**
   * Range-boundary stop from the clock (non-loop clamp). The clamp's own
   * pause() already routed through {@link playStateHandler} (external pause →
   * idle); this marks the stop as ENDED — distinct from a user pause — so UIs
   * can show a replay affordance and requestPlay restarts from the range start.
   */
  private readonly endedHandler = (time: number): void => {
    if (this.disposed) return;
    this.endedAtBoundary = true;
    this.emit('ended', time);
  };

  constructor(
    timeController: TimeController,
    opts: PlaybackGovernorOptions = {},
  ) {
    this.timeController = timeController;
    this.startGateWallMs = opts.startGateWallMs ?? 2000;
    this.lowWatermarkWallMs = opts.lowWatermarkWallMs ?? 600;
    this.resumeFactor = opts.resumeFactor ?? 2;
    this.seekSettleMs = opts.seekSettleMs ?? 200;
    this.maxStartWaitMs = opts.maxStartWaitMs ?? 8000;
    this.getThroughput = opts.getThroughput ?? null;
    // Tolerance defaults to one tick-probe interval of consumption (see option
    // docs + §6 Decision 1). A negative value would invert the band, so clamp.
    this.runwayToleranceMs = Math.max(
      0,
      opts.runwayToleranceMs ?? TICK_PROBE_INTERVAL_MS,
    );
    // An authored band pins every source at it (BH-4 precedence); only the
    // DEFAULT hands the band over to the per-source cadence derivation.
    this.runwayToleranceAuthored = opts.runwayToleranceMs !== undefined;
    this.multiSourceFairness = opts.multiSourceFairness ?? true;
    this.fluidFeasibility = opts.fluidFeasibility ?? true;
    this.fluidCheckHorizonWallMs = positiveOr(
      opts.fluidCheckHorizonWallMs,
      FLUID_CHECK_HORIZON_WALL_MS,
    );
    // z and k are the two BOUNDED knobs of the re-fit; both accept 0 (which
    // reproduces the incumbent constants exactly), neither accepts a negative
    // value (which would invert the conservatism).
    this.conservativeRateZ = nonNegativeOr(opts.conservativeRateZ, 1);
    this.dispersionK = nonNegativeOr(opts.dispersionK, DISPERSION_SCALE_K);
    this.baseSpeed = opts.baseSpeed ?? null;
    this.speedSteps =
      opts.speedSteps && opts.speedSteps.length > 0
        ? opts.speedSteps
        : SPEED_STEPS;
    this.ladderEvaluation = opts.ladderEvaluation ?? true;
    if (opts.source) this.setSource(opts.source);

    this.timeController.on('playState', this.playStateHandler);
    this.timeController.on('tick', this.tickHandler);
    this.timeController.on('wrap', this.wrapHandler);
    this.timeController.on('ended', this.endedHandler);
  }

  /** Current machine state. */
  get state(): PlaybackGovernorState {
    return this._state;
  }

  /**
   * User intent, HTMLMediaElement-shaped: true when the user does not want
   * playback. Stays false through 'starting'/'buffering'/'seeking' gates (the
   * user pressed play; the machine is just not there yet), so UIs can drive
   * the play/pause glyph from this single bit instead of mirroring intent.
   */
  get paused(): boolean {
    return !this.userWantsPlayback;
  }

  /** True while parked at a non-looping range boundary (media-element 'ended'). */
  get ended(): boolean {
    return this.endedAtBoundary;
  }

  /**
   * True while the scrubber is held ({@link beginScrub} … {@link endScrub}).
   * The same bit that suppresses gates internally, exposed so UIs/loaders
   * can observe the drag bracket (scrub-LOD P0).
   */
  get isScrubbing(): boolean {
    return this.scrubbing;
  }

  /**
   * True while in degraded creep: a gate passed via the maxStartWaitMs
   * escape hatch and playback is advancing pinned to the buffered frontier
   * (data-arrival rate) instead of free-running wall-clock × speed. UIs can
   * surface this as a subtle "waiting for data" hint; it clears by itself
   * once the runway recovers past the resume gate.
   */
  get isCreeping(): boolean {
    return this._state === 'playing' && this.degradedCreep;
  }

  /** Register an event listener. Returns an unsubscribe function. */
  on<K extends GovernorEventName>(
    event: K,
    callback: GovernorEventMap[K],
  ): () => void {
    this.listeners[event].add(callback);
    return () => this.off(event, callback);
  }

  /** Unregister an event listener. */
  off<K extends GovernorEventName>(
    event: K,
    callback: GovernorEventMap[K],
  ): void {
    this.listeners[event].delete(callback);
  }

  /**
   * Register (or replace) one classified readiness oracle in the multi-source
   * registry, keyed by `id`. Required sources gate the clock; optional ones
   * never do (they continue-and-degrade — see §2.3) but still load and still
   * count toward cost/ETA. The tileset arrives async in real apps, so the
   * governor may sit in 'starting' with no required source resident yet — it
   * then either passes the gate the moment the required set proves readiness,
   * or starts degraded after `maxStartWaitMs`.
   *
   * Sources missing the buffering API (a core build that predates WS-A) are
   * ignored so gating degrades to the escape hatch instead of throwing at
   * runtime (mirrors the historical {@link setSource} guard).
   *
   * @param opts.required defaults to `true` (the source gates the clock).
   * @param opts.weight   bandwidth-share hint for the Phase 2 shared
   *                       scheduler; defaults to `1`, not consumed by gating.
   */
  addSource(
    id: string,
    source: BufferSource,
    opts: { required?: boolean; weight?: number } = {},
  ): void {
    if (
      typeof (source as Partial<BufferSource>).getBufferedRunway !== 'function'
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        '[PlaybackGovernor] source lacks the buffering API (getBufferedRunway); ' +
          'gating degrades to the maxStartWaitMs escape hatch.',
      );
      if (!this.hasAnySource()) {
        // Something WAS offered, so the degrade applies — timed from the
        // offer, like a real registration (see hatchArmedByRejectedSource).
        this.hatchArmedByRejectedSource = true;
        if (this.isGated()) this.gateStartedAtWall = nowWall();
      }
      return;
    }
    if (!this.hasAnySource()) {
      // First source into an empty registry (audit G8 / CS-9): the escape
      // hatch is timed from HERE, not from a requestPlay that may have been
      // issued seconds earlier by an embed's visibility autoplay — until now
      // there was no runway to probe, so none of that time was a gate the
      // runway failed to fill. A real source also supersedes the legacy arm.
      this.hatchArmedByRejectedSource = false;
      if (this.isGated()) this.gateStartedAtWall = nowWall();
    }
    // Replacing an existing id must not inherit its predecessor's throttle
    // memos: the write throttle would treat the replacement source as
    // already capped/re-weighted and suppress the first sends, leaving it
    // silently uncapped at full weight while the governor believes it is
    // constrained. (No restore call on the predecessor — it is leaving the
    // registry; a fresh fairness pass re-establishes the replacement.)
    if (this.sources.has(id)) {
      this.lastSentCaps.delete(id);
      this.lastSentWeights.delete(id);
      this.lastLaggardIds.delete(id);
      // The loop window and the β measurement belong to the OUTGOING object
      // too: the replacement has been told nothing and has measured nothing.
      this.lastSentLoopRanges.delete(id);
      this.betaMemo.delete(id);
      this.blockedSourceIds.delete(id);
    }
    this.sources.set(id, {
      source,
      required: opts.required ?? true,
      weight: opts.weight ?? 1,
    });
    // Assert the CURRENT interactive bit on registration (mirrors the
    // animation-state re-assertion gates make on every source): a source
    // registered mid-drag must see `true` — the broadcast in beginScrub
    // predates it — and a source carrying a stale `true` from an earlier
    // lifecycle is synchronized back to `false` outside a drag.
    this.noteScrubTierSwitch();
    source.setInteractive?.(this.scrubbing);
    // Same reasoning for the loop window (BH-7): a source registered into a
    // looping session must learn the wrap boundary now — nothing else pushes
    // it until the next evaluation, and a wrap-blind eviction pass in between
    // discards exactly the tiles the wrap is about to need.
    this.syncLoopWindows();
    this.evaluateNow();
  }

  /** Remove a source from the registry by id (no-op if absent). */
  removeSource(id: string): void {
    // A source dropped mid-drag would otherwise keep interactive=true
    // forever — endScrub's clearing broadcast only reaches sources still
    // registered. Clear the bit on its way out.
    if (this.scrubbing) {
      this.noteScrubTierSwitch();
      this.sources.get(id)?.source.setInteractive?.(false);
    }
    // Same reasoning for fairness state: a departing source must not keep a
    // stale run-ahead cap or shed weight (no future pass can reach it).
    const departing = this.sources.get(id);
    if (departing) {
      if (typeof this.lastSentCaps.get(id) === 'number') {
        departing.source.setPrefetchRunAheadLimit?.(null);
      }
      const sentWeight = this.lastSentWeights.get(id);
      if (sentWeight !== undefined && sentWeight !== departing.weight) {
        departing.source.setBandwidthWeight?.(departing.weight);
      }
      this.lastSentCaps.delete(id);
      this.lastSentWeights.delete(id);
      this.blockedSourceIds.delete(id);
      // A departing source must not keep a loop window either: no future
      // sync can reach it, and a stale wrap boundary would keep rotating its
      // eviction scores around a range it is no longer being played through.
      if (this.lastSentLoopRanges.get(id)) {
        departing.source.setLoopWindow?.(null);
      }
      this.lastSentLoopRanges.delete(id);
      this.betaMemo.delete(id);
    }
    this.sources.delete(id);
    // Dropping the LAGGARD leaves every peer capped against a stale floor;
    // dropping under 2 sources ends fairness altogether. Deactivate (clear
    // caps, restore base weights) — the next probe re-establishes fairness
    // against the new laggard if one exists.
    if (this.lastLaggardIds.has(id) || this.sources.size < 2) {
      this.deactivateFairness();
    }
    this.evaluateNow();
  }

  /**
   * Back-compat single-source shim: clears the registry and (when non-null)
   * registers `source` as the required `'default'` source. Predates the
   * N-source registry; new code should call {@link addSource}/{@link
   * removeSource} directly so optional overlays can be classified.
   *
   * Always re-evaluates after the attempted swap — including when `source` is
   * a bad object that {@link addSource} rejects (lacks `getBufferedRunway`).
   * Without the unconditional re-evaluate, replacing the live required source
   * with a bad one would empty the registry yet leave the clock gated on the
   * stale combined runway: the registry would now report a never-stall
   * unbounded runway (zero required sources) but nothing would re-open the
   * gate. Re-evaluating folds the now-empty required set and starts (or
   * escape-hatches) correctly.
   */
  setSource(source: BufferSource | null): void {
    // Sources swapped out mid-drag must not keep interactive=true forever —
    // clear the bit before they leave the registry (endScrub can no longer
    // reach them). The replacement gets the current bit via addSource.
    if (this.scrubbing) {
      this.noteScrubTierSwitch();
      for (const s of this.allSources()) s.setInteractive?.(false);
    }
    // Outgoing sources also shed any fairness caps/weights — and any loop
    // window — on the way out.
    this.deactivateFairness();
    this.clearLoopWindows();
    this.betaMemo.clear();
    this.blockedSourceIds.clear();
    this.sources.clear();
    // addSource calls evaluateNow on success; on a bad-source rejection it
    // returns early WITHOUT evaluating, so re-evaluate here unconditionally.
    // (A successful add re-evaluates twice — cheap and idempotent.)
    if (source) this.addSource('default', source, { required: true });
    this.evaluateNow();
  }

  /** True once {@link dispose} has run — the instance is permanently inert. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Warn-once guard for user-intent methods: calling them on a disposed
   * governor is always a consumer lifecycle bug. The classic case is React
   * StrictMode's dev-only remount reusing a state-held instance whose effect
   * cleanup already disposed it — create the governor inside the effect so
   * the remount gets a fresh one. (Plumbing callbacks like notifyBufferChange
   * stay silent: in-flight events during teardown are normal.)
   */
  private rejectDisposedUse(): boolean {
    if (!this.disposed) return false;
    if (!this.warnedDisposedUse) {
      this.warnedDisposedUse = true;
      console.warn(
        '[PlaybackGovernor] called after dispose(); every call is a no-op. ' +
          'If this is React StrictMode, create the governor inside an effect ' +
          'so the remount gets a fresh instance.',
      );
    }
    return true;
  }

  /** User pressed play. Gate the start on the buffered runway. */
  requestPlay(): void {
    if (this.rejectDisposedUse()) return;
    this.userWantsPlayback = true;
    if (this.endedAtBoundary) {
      // Media-element replay convention: play at the range end restarts from
      // the start (or from the end when travelling in reverse). Without this
      // the gate passes on a complete-at-end runway and the first tick
      // re-clamps — a one-frame no-op.
      this.endedAtBoundary = false;
      const range = this.timeController.getTimeRange();
      if (range) {
        this.commitSeek(
          this.timeController.getSpeed() < 0 ? range.end : range.start,
        );
        return;
      }
    }
    if (this._state === 'idle') {
      this.enterGate('starting', 1);
    }
    // Already 'playing' or gated: the existing gate/intent carries on.
  }

  /** User pressed pause. Sticks even while a gate is in progress. */
  requestPause(): void {
    if (this.rejectDisposedUse()) return;
    this.userWantsPlayback = false;
    this.stopEvalTimer();
    this.bufferedUntil = null;
    this.setDegradedCreep(false);
    this.pauseClock();
    // A real pause (unlike a gate) should drop EVERY loader back to its paused
    // budget — undo any animating-at-speed assertion a gate made. Broadcasts
    // to all sources (required AND optional): optional sources never gate the
    // clock but they DO load, so they must also be told to stand down.
    for (const source of this.allSources())
      source.setAnimationState?.(false, 0);
    // Fairness follows the stand-down: caps/shed weights are relative to a
    // moving playhead, which no longer exists.
    this.deactivateFairness();
    this.setState('idle');
  }

  /**
   * The scrubber was grabbed. Freezes the clock for a stable preview; no
   * state change and no fetch churn — every position until
   * {@link endScrub} is preview-only.
   *
   * Scrub-LOD P0: the interactive bit is broadcast to EVERY source
   * (required + optional — optional sources load too) via the optional
   * {@link BufferSource.setInteractive}, and 'scrubstart' fires, so loaders
   * MAY degrade to a cheaper preview tier for the duration of the drag.
   * Idempotent: a second grab of an already-held thumb is the same drag.
   */
  beginScrub(): void {
    if (this.rejectDisposedUse()) return;
    if (this.scrubbing) return; // already dragging — same bracket
    this.scrubbing = true;
    this.pauseClock();
    // Open a fresh QoE bracket BEFORE the broadcast so the degrade counts as
    // this drag's first tier switch.
    const startedAtWall = nowWall();
    this.scrubQoe = {
      startedAtWall,
      endedAtWall: null,
      firstPreviewAtWall: null,
      firstFreshAtWall: null,
      previews: 0,
      freshPreviews: 0,
      tierSwitches: 0,
      settlePendingSince: null,
      settleMs: null,
    };
    this.noteScrubTierSwitch();
    for (const source of this.allSources()) source.setInteractive?.(true);
    this.emit('scrubstart', this.timeController.getTime());
    emitProbe('scrub', {
      event: 'scrubstart',
      startedAtWall,
      time: this.timeController.getTime(),
    });
  }

  /**
   * Preview a scrub position: move the clock (so resident tiles render at the
   * new time) WITHOUT committing a seek — no tileset update storm, no fetches.
   */
  scrubTo(time: number): void {
    if (this.rejectDisposedUse()) return;
    this.timeController.setTime(time);
    this.noteScrubPreview(time);
  }

  /** The scrubber was released — commit the final position as a real seek. */
  endScrub(time: number): void {
    if (this.rejectDisposedUse()) return;
    const wasScrubbing = this.scrubbing;
    this.scrubbing = false;
    if (wasScrubbing) {
      // Close the QoE bracket at the release instant, before the restore
      // broadcast (which counts as this drag's last tier switch).
      const bracket = this.scrubQoe;
      if (bracket) {
        bracket.endedAtWall = nowWall();
        bracket.tierSwitches++;
      }
      // Clear the interactive bit BEFORE the commit below: a scrub-LOD
      // loader restores its fine (settle) tier first, so the commit's flush
      // + post-seek gate measure full detail — the G7 preview-only contract.
      for (const source of this.allSources()) source.setInteractive?.(false);
      this.emit('scrubend', time);
    }
    const alreadyCommitted = this.scrubCommittedTime === time;
    this.scrubCommittedTime = null;
    if (alreadyCommitted) {
      // The settle timer already committed this exact position; releasing the
      // thumb just lifts the no-resume-while-scrubbing hold. Re-base the
      // escape-hatch clock so a long-held thumb cannot fire it (degraded) the
      // instant it lets go.
      if (this.isGated()) {
        this.gateStartedAtWall = nowWall();
        this.evaluateNow();
      }
      if (wasScrubbing) this.closeScrubBracket();
      return;
    }
    this.commitSeek(time);
    if (wasScrubbing) this.closeScrubBracket();
  }

  /**
   * Arm the settle clock (if the release gated) and publish the bracket's
   * roll-up on the `scrub` channel. Runs AFTER the commit so `isGated()`
   * reflects the post-release gate.
   */
  private closeScrubBracket(): void {
    const bracket = this.scrubQoe;
    if (!bracket) return;
    if (this.isGated()) {
      bracket.settlePendingSince = bracket.endedAtWall ?? nowWall();
    } else {
      // No gate on release ⇒ full detail was already resident.
      bracket.settleMs = 0;
    }
    emitProbe('scrub', {
      event: 'scrubend',
      startedAtWall: bracket.startedAtWall,
      endedAtWall: bracket.endedAtWall,
      ...this.getScrubQoeStats(),
    });
  }

  /**
   * Count one interactive-bit broadcast against the live bracket (the
   * pop/oscillation signal). Called from every place the governor asserts the
   * bit mid-drag: the grab, the release, and source add/remove/swap.
   */
  private noteScrubTierSwitch(): void {
    if (this.scrubQoe && this.scrubbing) this.scrubQoe.tierSwitches++;
  }

  /**
   * Record one preview position against the live bracket and, if the instant
   * is already covered by resident data, close the time-to-first-pixel span.
   * Pure observation — the coverage probe is the same read the buffered bar
   * already performs.
   */
  private noteScrubPreview(time: number): void {
    const bracket = this.scrubQoe;
    if (!bracket || !this.scrubbing) return;
    const now = nowWall();
    bracket.previews++;
    if (bracket.firstPreviewAtWall === null) bracket.firstPreviewAtWall = now;
    if (this.isTimeBuffered(time)) {
      bracket.freshPreviews++;
      if (bracket.firstFreshAtWall === null) bracket.firstFreshAtWall = now;
    }
  }

  /** True when `time` falls inside the required sources' combined buffered span. */
  private isTimeBuffered(time: number): boolean {
    const ranges = this.getBufferedRanges();
    for (const r of ranges) {
      if (time >= r.start && time <= r.end) return true;
    }
    return false;
  }

  /** Programmatic committed seek (keyboard arrows, jump-to-start, story beats). */
  seekTo(time: number): void {
    if (this.rejectDisposedUse()) return;
    this.commitSeek(time);
    // A settle-commit mid-drag: memo the position so releasing the thumb on
    // it doesn't pay a second prefetch flush + gate (see endScrub).
    if (this.scrubbing) this.scrubCommittedTime = time;
  }

  /**
   * Consumer-forwarded buffer event (layer `onBufferChange` → here). Triggers
   * an immediate gate/stall evaluation in addition to the 250 ms cadence.
   * While playing, the frontier walk it would otherwise trigger is coalesced
   * to one per {@link TICK_PROBE_INTERVAL_MS} per source (see
   * {@link evaluateNow}); the stall check itself always runs.
   */
  notifyBufferChange(runway: BufferedRunway): void {
    if (this.disposed) return;
    // While the thumb is held, arriving data is the ONLY thing that can close
    // the time-to-first-pixel span for a preview position the user is resting
    // on (no further scrubTo will land). Observation only.
    this.noteScrubCoverageProbe();
    this.emit('progress', runway);
    this.evaluateNow();
    // Republish the state snapshot on the playback PULSE, not only on
    // transitions: during steady playback the state machine is silent for
    // minutes at a time, and a harness sampling `playback.state` would read a
    // play-head frozen at the last transition. This is the busiest callback
    // the governor has that is still data-paced (tiles landing) rather than
    // frame-paced — no timer is added, and it is the last statement in the
    // method so nothing observes what it publishes.
    this.publishStateSnapshot();
  }

  /**
   * Publish the governor's latest state + QoE counters as the `playback.state`
   * probe snapshot (see `telemetry.ts` for why the key and its field names are
   * a consumer contract).
   *
   * OBSERVATION ONLY, and gated: `getQoeStats()` allocates, so the whole thing
   * is skipped on one property read when no probe bag is installed. Callers
   * are the two places the value can change — every {@link setState} and every
   * {@link notifyBufferChange}.
   */
  private publishStateSnapshot(): void {
    if (!isProbeEnabled()) return;
    const speed = this.timeController.getSpeed();
    snapshotProbe<PlaybackStateSnapshot>(PLAYBACK_STATE_SNAPSHOT, {
      state: this._state,
      playheadMs: this.timeController.getTime(),
      speed,
      direction: speed < 0 ? -1 : 1,
      // Intent, not clock motion: a gate FREEZES the clock while re-asserting
      // animating-at-speed on every source, so a replay that keyed eviction
      // grace off "is the clock ticking" would see a paused session at exactly
      // the moment the loader is reaching hardest.
      animating: this.userWantsPlayback && speed !== 0,
      ...this.getQoeStats(),
    });
  }

  /**
   * Re-check whether the CURRENT preview instant became covered, without
   * counting a new preview. Closes `timeToFirstPixelMs` when data lands under
   * a resting thumb.
   *
   * DELIBERATELY NOT PROBE-GATED. The scrub bracket accumulates unconditionally
   * so {@link getScrubQoeStats} is honest with or without a probe bag installed
   * (that is the documented contract on {@link ScrubQoeStats}, and the
   * `scrub-cost` harness reads the getter, not the channel) — gating this would
   * make the getter silently under-report `timeToFirstPixelMs` in exactly the
   * probe-off configuration a CI run uses. The off-drag cost is bounded at one
   * null property read: `scrubQoe` is null until the first `beginScrub`, and
   * after that `!this.scrubbing` short-circuits before any work. The single
   * `isTimeBuffered` call is reached only mid-drag, at pointer cadence, and
   * never from the render path.
   */
  private noteScrubCoverageProbe(): void {
    const bracket = this.scrubQoe;
    if (
      !bracket ||
      !this.scrubbing ||
      bracket.firstPreviewAtWall === null ||
      bracket.firstFreshAtWall !== null
    ) {
      return;
    }
    if (this.isTimeBuffered(this.timeController.getTime())) {
      bracket.firstFreshAtWall = nowWall();
    }
  }

  /**
   * Honest ETA (wall-ms) until the current gate window is ready: the MAX
   * `estimateTimeToReadyMs` across ALL sources (required + optional) — the
   * window is "ready" only once the slowest source has it. Null when no source
   * yields a finite estimate (or there are no sources).
   */
  getEtaMs(): number | null {
    const range = this.gateRange();
    let eta: number | null = null;
    for (const source of this.allSources()) {
      const e = source.estimateTimeToReadyMs(range);
      if (e == null) continue;
      eta = eta == null ? e : Math.max(eta, e);
    }
    return eta;
  }

  /**
   * Loaded time ranges for a buffered-range bar. Folded over the REQUIRED set
   * as an INTERSECTION (the span the clock actually treats as loaded — a
   * required source with a gap there gates regardless of optional coverage).
   * Returns [] when there are no required sources. (Phase 4 may surface a
   * richer per-source multi-track bar; this keeps the single-bar contract.)
   */
  getBufferedRanges(opts?: {
    maxRanges?: number;
  }): Array<{ start: number; end: number }> {
    const required = this.requiredSources();
    if (required.length === 0) return [];
    // Probe each source WITHOUT maxRanges for the intersection inputs: a
    // per-source truncation could drop a range that would have intersected a
    // peer's, silently shrinking the combined buffered span. Intersect the
    // full per-source lists, then apply the caller's maxRanges slice once at
    // the very end (a range cap is a presentation concern on the COMBINED
    // result, not on each input).
    let acc = required[0].getBufferedRanges();
    for (let i = 1; i < required.length; i++) {
      acc = intersectRanges(acc, required[i].getBufferedRanges());
      if (acc.length === 0) break;
    }
    if (opts?.maxRanges != null && acc.length > opts.maxRanges) {
      acc = acc.slice(0, opts.maxRanges);
    }
    return acc;
  }

  /**
   * Byte/tile cost of making `range` fully buffered for the current viewport,
   * SUMMED across ALL sources (required + optional) — the total work the
   * composite must do. Zeros without any source. UIs use it for ETA chips and
   * timeline density strips.
   */
  estimateCost(range: { start: number; end: number }): {
    bytes: number;
    tiles: number;
  } {
    let bytes = 0;
    let tiles = 0;
    for (const source of this.allSources()) {
      const c = source.estimateCost(range);
      bytes += c.bytes;
      tiles += c.tiles;
    }
    return { bytes, tiles };
  }

  /**
   * Per-source runway probe at the CURRENT playhead time + travel direction —
   * the data behind a multi-track buffered bar or debug panel (Phase 4 of
   * multi-source coordination). One {@link SourceRunway} per registered source,
   * in registration order (required and optional alike). PURE READ: every
   * source is probed via {@link BufferSource.getBufferedRunway}; nothing is
   * mutated, no clock, gate, or frontier state is touched.
   *
   * The travel direction is the sign of the current speed (forward at zero
   * speed, matching the gate/frontier convention). The GATING source — the one
   * the clock is (or would be) held by — is the required entry with the
   * smallest `runwaySimMs` among those not yet `complete` (an incomplete
   * required source is what the combined min-gate folds to); callers identify
   * it by filtering `required && !complete` and taking the min `runwaySimMs`.
   * Returns [] when no source is registered.
   */
  getSourceRunways(): SourceRunway[] {
    if (this.sources.size === 0) return [];
    const speed = this.timeController.getSpeed();
    const direction: 1 | -1 = speed < 0 ? -1 : 1;
    const time = this.timeController.getTime();
    const out: SourceRunway[] = [];
    for (const [id, entry] of this.sources) {
      const r = entry.source.getBufferedRunway(time, direction);
      out.push({
        id,
        required: entry.required,
        runwaySimMs: r.simMs,
        complete: r.complete,
        bytesPending: r.bytesPending,
      });
    }
    return out;
  }

  /**
   * Snapshot of the session's playback-QoE counters. In-progress stall/creep
   * spans are included, so a probe can read mid-stall without waiting for the
   * transition out. Counters accumulate for the governor's lifetime (one
   * governor per mounted player).
   */
  getQoeStats(): PlaybackQoeStats {
    const now = nowWall();
    let totalStallMs = this.qoeTotalStallMs;
    if (this._state === 'buffering') {
      totalStallMs += now - this.stallEnteredAtWall;
    }
    let creepMs = this.qoeCreepMs;
    if (this.degradedCreep) {
      creepMs += now - this.creepStartedAtWall;
    }
    return {
      stallCount: this.qoeStallCount,
      totalStallMs,
      startupMs: this.qoeStartupMs,
      degradedResumeCount: this.qoeDegradedResumeCount,
      creepMs,
      stallMs: totalStallMs,
      seekCount: this.qoeSeekCount,
      seekSettleMsP50: nearestRankMedian(this.qoeSeekSettleSamples),
      gateEntriesByReason: { ...this.qoeGateEntries },
      gateHoldsByReason: { ...this.qoeGateHolds },
      frontierSnapBacks: this.qoeFrontierSnapBacks,
      blockedPermanentlyCount: this.qoeBlockedPermanentlyCount,
    };
  }

  /**
   * Measured coefficient of variation of the link's throughput,
   * `stdDev / bytesPerMs`, or `0` when there is no variance channel to read
   * (no `getThroughput` wired, a cold estimator, a producer with no `stdDev`,
   * or a perfectly steady link).
   *
   * `0` is the incumbent-behaviour value everywhere it is consumed, so a caller
   * may read this unconditionally. Exposed so the consumer-side half of the
   * re-fit — `decideAutoSpeedMultiplier`'s `dispersionCv` — is fed from the same
   * measurement as the governor's own two knobs, instead of a second estimator.
   */
  getThroughputDispersionCv(): number {
    const estimate = this.getThroughput?.();
    if (!estimate) return 0;
    const rate = estimate.bytesPerMs;
    const stdDev = estimate.stdDev;
    if (rate == null || !Number.isFinite(rate) || rate <= 0) return 0;
    if (typeof stdDev !== 'number' || !Number.isFinite(stdDev) || stdDev <= 0) {
      return 0;
    }
    return stdDev / rate;
  }

  /**
   * The low watermark actually in force, in wall-ms — the configured
   * `lowWatermarkWallMs` scaled by the measured jitter
   * (`× clamp(1 + k·cv, 1, 3)`) and held under the start gate so the re-fit can
   * never collapse the two thresholds (M5/CO-3).
   *
   * Equal to the configured value on a calm link, with no variance channel, and
   * at `dispersionK: 0`. Diagnostic only — nothing reads it but the stall check
   * and debug surfaces.
   */
  get effectiveLowWatermarkWallMs(): number {
    const scaled =
      this.lowWatermarkWallMs *
      dispersionScale(this.getThroughputDispersionCv(), this.dispersionK);
    // The START GATE, the WATERMARK and the resumeFactor HYSTERESIS are three
    // distinct behaviours and must stay that way: a jittery link may stall
    // earlier, but never so early that the watermark reaches the gate it is
    // supposed to sit below. A configuration that already puts the watermark
    // at/above the gate is left alone — that is the operator's call, not a
    // re-fit artefact.
    const ceiling = Math.max(
      this.lowWatermarkWallMs,
      this.startGateWallMs * WATERMARK_GATE_HEADROOM,
    );
    return Math.min(scaled, ceiling);
  }

  /**
   * Snapshot of the CURRENT drag's scrub-QoE counters while the thumb is held,
   * otherwise of the most recently completed drag. All-zero / null before the
   * first {@link beginScrub}, so a harness can read it unconditionally.
   *
   * In-progress spans are reported as elapsed-so-far (same convention as
   * {@link getQoeStats}'s `totalStallMs`), so a mid-drag read is meaningful.
   */
  getScrubQoeStats(): ScrubQoeStats {
    const bracket = this.scrubQoe;
    if (!bracket) {
      return {
        timeToFirstPixelMs: null,
        freshFrameFraction: 0,
        bytesDuringScrub: 0,
        settleMs: null,
        tierSwitchCount: 0,
      };
    }
    const timeToFirstPixelMs =
      bracket.firstPreviewAtWall !== null && bracket.firstFreshAtWall !== null
        ? Math.max(0, bracket.firstFreshAtWall - bracket.firstPreviewAtWall)
        : null;
    let settleMs = bracket.settleMs;
    if (settleMs === null && bracket.settlePendingSince !== null) {
      settleMs = Math.max(0, nowWall() - bracket.settlePendingSince);
    }
    return {
      timeToFirstPixelMs,
      freshFrameFraction:
        bracket.previews > 0 ? bracket.freshPreviews / bracket.previews : 0,
      bytesDuringScrub: sumRequestBytesInWindow(
        bracket.startedAtWall,
        bracket.endedAtWall ?? nowWall(),
      ),
      settleMs,
      tierSwitchCount: bracket.tierSwitches,
    };
  }

  /**
   * Opt-in "Auto" speed (WS-D): the maximum sustainable playback speed
   * (TimeController units — sim-ms per wall-ms) the measured network can
   * feed, derived from the COMBINED byte cost of the upcoming horizon across
   * every REQUIRED source.
   *
   * THE CONTENDED BOUND (multi-heavy fix). N required sources do not each own
   * the link — they share ONE pipe. The honest sustainable speed is therefore
   * the aggregate throughput divided by the SUM of every required source's
   * byte-rate demand, not the min over each source's own optimistic full-pipe
   * estimate (which assumes each source has the whole link to itself and so
   * runs ~N× too fast with N comparably-heavy sources — the "racing ahead"
   * stall, the deferred Wave-1 MEDIUM finding):
   *
   *   Σbytes        = Σ over required of estimateCost(horizon).bytes
   *   bytesPerSimMs = Σbytes / horizonSimMs          (combined demand per sim-ms)
   *   maxSustainable = aggregateThroughputBytesPerMs / bytesPerSimMs × 0.7
   *
   * THROUGHPUT ASSUMPTION. `getThroughput()` (when wired) is read as the
   * AGGREGATE / shared-link rate — the only honest numerator for a bound that
   * divides one pipe across N sources. This holds because the core archive's
   * estimator samples its whole BUSY WINDOW as one `(totalBytes, wallClockMs)`
   * sample (archive.ts endTransferSample), i.e. the link's aggregate delivered
   * rate while that archive was loading, not a per-request slice. (When the
   * composite wires ONE archive's getter as the governor's `getThroughput`,
   * that archive's busy-window rate is the best available proxy for the shared
   * link; a future Phase-2 shared scheduler would expose a true link-wide
   * estimate here.) When no getter is wired, the shared-link rate is recovered
   * per source as bytes_i / eta_i — each source's estimateTimeToReadyMs is
   * bytes_i / sharedLinkRate, so this quotient yields that ONE shared rate for
   * every source. We take the max (all are ~equal; max is the most defensible
   * single estimate) as the aggregate numerator and divide it across Σbytes
   * below — NOT Σbytes / maxEta, which double-counts the one pipe by ~N and
   * silently reproduces the optimistic per-source speed (the multi-heavy bug).
   *
   * Returns `Infinity` when the upcoming horizon has nothing left to load
   * across ALL required sources (everything buffered ⇒ the network imposes no
   * cap) — consumers clamp it to their max step, so a fully-cached dataset
   * rises to full speed instead of freezing at whatever multiplier Auto last
   * chose. Returns null when the math cannot be honest: throughput unknown, or
   * tiles pending whose byte sizes the directory doesn't expose. Consumers
   * apply their own snapping/clamping/hysteresis; the governor only does the
   * honest math.
   *
   * LADDER EVALUATION (M5/CO-4). Measuring demand ONCE over a horizon scaled by
   * the CURRENT speed is myopic: a faster candidate sweeps a LONGER window,
   * which may cross a density spike the current-speed window never sees, so
   * Auto upshifts straight into a stall (the §11.4 gap). When
   * {@link PlaybackGovernorOptions.baseSpeed} is supplied, every multiplier in
   * the ladder is instead priced over ITS OWN horizon, descending, and the
   * answer is the sustainable value at the LARGEST FEASIBLE candidate — where
   * feasible means `Σbytes_c / H ≤ η · Ĉ`, equivalently "the speed this
   * candidate's own window says is sustainable is at least the candidate
   * itself". Below the top of the ladder that value is capped at the candidate,
   * because the step above it was measured and refused and consumers snap to
   * the nearest step. Without a base speed there is no way to express
   * candidates in speed units, so the single-point computation runs unchanged.
   *
   * Everything below is enforced PER EVALUATED CANDIDATE, not once: the
   * `Infinity`-when-nothing-pending contract, the `null`-when-blind contracts,
   * and the contended aggregate-rate recovery.
   */
  getAutoSpeedSuggestion(): number | null {
    const required = this.requiredSources();
    if (required.length === 0) return null;
    const speed = this.timeController.getSpeed();
    const absSpeed = Math.abs(speed);
    if (absSpeed <= 0) return null;

    const time = this.timeController.getTime();
    const direction: 1 | -1 = speed < 0 ? -1 : 1;
    // η, shrunk by measured dispersion (a jittery link rises more slowly).
    // Exactly AUTO_SPEED_SAFETY on a calm link / with no variance channel.
    const safety =
      AUTO_SPEED_SAFETY /
      dispersionScale(this.getThroughputDispersionCv(), this.dispersionK);

    const candidates = this.autoSpeedCandidates();
    if (candidates === null) {
      // Incumbent single-point path (no base speed, or ladder evaluation pinned
      // off): one measurement at the current speed, exactly as before.
      return this.evaluateAutoSpeedCandidate(
        required,
        time,
        direction,
        absSpeed,
        safety,
      );
    }

    // Descending: the FIRST feasible candidate is the largest feasible one.
    let smallest: number | null = null;
    for (let i = 0; i < candidates.length; i++) {
      const candidateSpeed = candidates[i];
      const sustainable = this.evaluateAutoSpeedCandidate(
        required,
        time,
        direction,
        candidateSpeed,
        safety,
      );
      // Honesty short-circuit: a candidate whose window cannot be priced makes
      // the whole evaluation dishonest, exactly as the single-point path's
      // blind cases do. Abstain rather than fall through to a smaller (and
      // therefore optimistically cheaper) window.
      if (sustainable === null) return null;
      if (sustainable < candidateSpeed) {
        smallest = sustainable;
        continue; // infeasible — try the next step down
      }
      // Feasible. At the TOP of the ladder there is nothing above to protect
      // against, so the raw value is reported — including `Infinity`, which is
      // the fully-cached "network imposes no cap" contract.
      if (i === 0) return sustainable;
      // Below the top, the value is capped at the candidate itself. The step
      // ABOVE this one was priced over its own longer window and REFUSED, and
      // consumers snap the answer to the nearest ladder step — so reporting the
      // uncapped `sustainable` (which this candidate's shorter, spike-free
      // window can easily put above the next step) is exactly the myopic
      // upshift-into-a-stall this item exists to remove.
      return Math.min(sustainable, candidateSpeed);
    }
    // Nothing on the ladder is sustainable — report the slowest candidate's
    // honest value and let the consumer's clamp land it on the bottom step.
    return smallest;
  }

  /**
   * The ladder in ABSOLUTE speed units, descending, or `null` when candidates
   * cannot be enumerated (ladder evaluation pinned off, or no usable base
   * speed) — in which case {@link getAutoSpeedSuggestion} keeps its incumbent
   * single-point computation.
   */
  private autoSpeedCandidates(): number[] | null {
    if (!this.ladderEvaluation) return null;
    const raw =
      typeof this.baseSpeed === 'function' ? this.baseSpeed() : this.baseSpeed;
    if (raw == null || !Number.isFinite(raw)) return null;
    const base = Math.abs(raw);
    if (base <= 0) return null;
    const out: number[] = [];
    for (let i = this.speedSteps.length - 1; i >= 0; i--) {
      const step = this.speedSteps[i];
      if (!Number.isFinite(step) || step <= 0) continue;
      out.push(step * base);
    }
    // The ladder is declared ascending; defend the descending contract rather
    // than assume it, so a custom `speedSteps` can't silently invert the
    // largest-feasible-first walk.
    out.sort((a, b) => b - a);
    return out.length > 0 ? out : null;
  }

  /**
   * Price ONE candidate speed: the contended sustainable speed over the horizon
   * that candidate would sweep, or `null` when the math cannot be honest.
   *
   * This is the incumbent computation verbatim, parameterised by the candidate
   * speed. In particular the aggregate-rate recovery on the no-`getThroughput`
   * path is `max_i(bytes_i / eta_i)` and stays that way — it is a standing
   * do-not-touch entry, and the alternative (`Σbytes / max eta`) is the
   * recorded racing-ahead bug.
   */
  private evaluateAutoSpeedCandidate(
    required: BufferSource[],
    time: number,
    direction: 1 | -1,
    candidateAbsSpeed: number,
    safety: number,
  ): number | null {
    const horizonSimMs = AUTO_SPEED_HORIZON_WALL_MS * candidateAbsSpeed;
    const range =
      direction < 0
        ? { start: time - horizonSimMs, end: time }
        : { start: time, end: time + horizonSimMs };

    // Combined (contended) bound over the required set: sum the byte demand of
    // every required source, then divide the ONE shared pipe across it. A
    // composite plays only as fast as the shared link can feed the SUM of its
    // required sources — never the optimistic per-source min.
    let sumBytes = 0;
    let sumTiles = 0;
    // The ETA-implied fallback recovers the SHARED-LINK rate from each source's
    // own honest ETA. Each source computes estimateTimeToReadyMs as
    // bytes_i / sharedLinkRate (core spatiotemporal-tileset), so the per-source
    // implied rate is bytes_i / eta_i — which equals that one shared link rate
    // for every source (they all measure the same pipe). We take the max of
    // these per-source rates as the aggregate numerator: it is the shared link's
    // delivered rate, NOT a sum (summing would double-count the one pipe and
    // reproduce the old optimistic per-source speed — the multi-heavy bug). The
    // contention then lives entirely in dividing this ONE rate across Σbytes.
    let maxLinkRateBytesPerMs: number | null = null;
    let anyEtaBlind = false;
    // Mirror of anyEtaBlind for the byte-size oracle: a required source with
    // pending tiles whose byte sizes the directory does NOT expose
    // (cost.tiles > 0 && cost.bytes <= 0). In the SINGLE-source case the
    // `sumBytes <= 0` floor below already catches this. Under COMPOSITION a
    // heavy peer keeps Σbytes positive, so the blind source's missing bytes
    // silently under-count the combined demand and INFLATE the suggested speed —
    // the composite then "races ahead" of a required track whose true cost is
    // unknown. Restoring the single-source contract: if ANY required source is
    // bytes-blind there is no honest combined Σbytes, so return null (exactly as
    // the ETA-blind path does). A multi-source review finding — see
    // docs/roadmap/playback-and-loading.md.
    let anyBytesBlind = false;
    for (const source of required) {
      const cost = source.estimateCost(range);
      if (!cost) continue;
      sumBytes += cost.bytes;
      sumTiles += cost.tiles;
      if (cost.tiles > 0) {
        if (cost.bytes <= 0) anyBytesBlind = true;
        const etaMs = source.estimateTimeToReadyMs(range);
        if (etaMs == null) anyEtaBlind = true;
        else if (etaMs > 0 && cost.bytes > 0) {
          const linkRate = cost.bytes / etaMs; // = sharedLinkRate (see above)
          maxLinkRateBytesPerMs =
            maxLinkRateBytesPerMs == null
              ? linkRate
              : Math.max(maxLinkRateBytesPerMs, linkRate);
        }
      }
    }

    if (sumTiles === 0) return Infinity; // nothing left to load anywhere — uncapped
    // Any required source with pending tiles but unknown byte sizes ⇒ Σbytes is
    // under-counted (the single-source `sumBytes <= 0` contract generalized to
    // composition): no honest combined demand, so no honest speed. Checked
    // BEFORE the `sumBytes <= 0` floor so a bytes-blind source alongside a heavy
    // peer (Σbytes > 0) is still rejected.
    if (anyBytesBlind) return null;
    if (sumBytes <= 0) return null; // tiles pending but sizes unknown — no honest math

    let aggregateBytesPerMs: number | null = null;
    const throughput = this.getThroughput?.();
    if (
      throughput &&
      throughput.bytesPerMs != null &&
      throughput.bytesPerMs > 0
    ) {
      // Read as the AGGREGATE shared-link rate (see throughput assumption above).
      aggregateBytesPerMs = throughput.bytesPerMs;
    } else if (
      !anyEtaBlind &&
      maxLinkRateBytesPerMs != null &&
      maxLinkRateBytesPerMs > 0
    ) {
      // No direct estimator wired — imply the shared-link rate from the per-source
      // ETAs (bytes_i / eta_i, all equal to the one link rate; max is the most
      // defensible single estimate). Contention is applied below by dividing this
      // ONE rate across Σbytes, matching the getThroughput path exactly.
      aggregateBytesPerMs = maxLinkRateBytesPerMs;
    }
    if (aggregateBytesPerMs == null || aggregateBytesPerMs <= 0) return null;

    const bytesPerSimMs = sumBytes / horizonSimMs;
    // `safety` is AUTO_SPEED_SAFETY on a calm link / with no variance channel,
    // so this is the incumbent expression bit-for-bit in the default case.
    return (aggregateBytesPerMs / bytesPerSimMs) * safety;
  }

  /** Detach from the TimeController and stop all timers. The clock is left as-is. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopEvalTimer();
    this.timeController.off('playState', this.playStateHandler);
    this.timeController.off('tick', this.tickHandler);
    this.timeController.off('wrap', this.wrapHandler);
    this.timeController.off('ended', this.endedHandler);
    this.listeners.statechange.clear();
    this.listeners.waiting.clear();
    this.listeners.ready.clear();
    this.listeners.progress.clear();
    this.listeners.ended.clear();
    this.listeners.scrubstart.clear();
    this.listeners.scrubend.clear();
    // Disposal mid-drag: the endScrub that would clear the interactive bit
    // will never come (the instance is inert), so stand every source down
    // before dropping the registry — a loader must not stay pinned to its
    // degraded scrub tier forever.
    if (this.scrubbing) {
      this.noteScrubTierSwitch();
      for (const s of this.allSources()) s.setInteractive?.(false);
    }
    // Loaders outlive the governor: leaving a run-ahead cap, a shed weight, or
    // a loop window behind would steer them forever with nothing left to lift
    // it. (clearLoopWindows runs before `disposed` gates syncLoopWindows —
    // this is the direct write path, not the sync.)
    this.deactivateFairness();
    this.clearLoopWindows();
    this.betaMemo.clear();
    this.sources.clear();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Every registered source (required + optional). */
  private allSources(): BufferSource[] {
    const out: BufferSource[] = [];
    for (const entry of this.sources.values()) out.push(entry.source);
    return out;
  }

  /** Only the gating (required) sources. */
  private requiredSources(): BufferSource[] {
    const out: BufferSource[] = [];
    for (const entry of this.sources.values()) {
      if (entry.required) out.push(entry.source);
    }
    return out;
  }

  /**
   * Drop every registered source that reports itself INERT — torn down, and so
   * permanently unable to buffer another byte (see {@link BufferSource.isInert}).
   *
   * This is a SAFETY NET for the registration contract, not a substitute for
   * it: a renderer that swaps datasets should still `unregisterSource` the ids
   * it is retiring. But a layer whose id changes with the dataset finalizes its
   * old tileset with no callback the app can hook, and a finalized required
   * source answers "runway 0, not complete" for the rest of the session — which
   * the min-gate reads as a laggard that never catches up, so the clock never
   * advances again. Leaving is the only correct thing such a source can do.
   *
   * No restore calls on the way out (unlike {@link removeSource}): a finalized
   * source cannot act on `setPrefetchRunAheadLimit` / `setBandwidthWeight` /
   * `setLoopWindow`, so we only drop the bookkeeping that named it. Fairness is
   * deactivated on the same terms as a removal — losing the laggard leaves
   * every peer capped against a stale floor.
   */
  private pruneInertSources(): void {
    let removedLaggard = false;
    let removedAny = false;
    for (const [id, entry] of this.sources) {
      if (entry.source.isInert?.() !== true) continue;
      this.lastSentCaps.delete(id);
      this.lastSentWeights.delete(id);
      this.lastSentLoopRanges.delete(id);
      this.betaMemo.delete(id);
      this.blockedSourceIds.delete(id);
      if (this.lastLaggardIds.delete(id)) removedLaggard = true;
      this.sources.delete(id);
      removedAny = true;
    }
    if (removedAny && (removedLaggard || this.sources.size < 2)) {
      this.deactivateFairness();
    }
  }

  /** True once any source (required or not) is resident — the historical `this.source` truthiness check. */
  private hasAnySource(): boolean {
    return this.sources.size > 0;
  }

  /** The cadence tolerance band as sim-ms at the given |speed| (see options). */
  private toleranceSimMs(absSpeed: number): number {
    return this.runwayToleranceMs * absSpeed;
  }

  /**
   * Combined buffer health folded over the REQUIRED sources only — the
   * weakest-link / min-gate the SoTA prescribes (MSE intersection, §2.1):
   *   simMs        = min over required (clock holds at the laggard)
   *   complete     = AND over required (nothing left to wait for anywhere)
   *   bytesPending = sum over required
   * A completed required source never lowers the floor (its runway reads as
   * unbounded for the min) so a finished source never gates. With ZERO
   * required sources the clock is treated as fully buffered + complete so it
   * never stalls — optional-only compositions free-run.
   *
   * CADENCE TOLERANCE BAND (Phase 1, §2.2). The raw min above spuriously
   * stalls heterogeneous-cadence required sources whose horizons land a few
   * ms apart (W3C Bug 26436). `toleranceSimMs` coalesces those sub-tolerance
   * differences: each incomplete source whose runway is within tolerance of
   * the LEADING (max) incomplete required runway is lifted to the leader
   * before the min is taken, so cadence jitter around a shared, healthy
   * frontier no longer drags the combined runway/frontier down. The lift is
   * measured BETWEEN sources (against the leader), never against the gate or
   * watermark — a source genuinely further than tolerance behind keeps its
   * real (small) runway and still drags the min, so true starvation still
   * stalls and the low-watermark protection is never lowered. `tolSimMs <= 0`
   * is the exact raw-min behavior (the lift condition `lead - simMs <= 0` only
   * fires for the leader itself, a no-op).
   */
  private combinedRequiredRunway(
    time: number,
    direction: 1 | -1,
    horizonSimMs: number | undefined,
    tolSimMs = 0,
    absSpeed = 0,
  ): BufferedRunway {
    const entries: RunwayFoldEntry[] = [];
    for (const [id, entry] of this.sources) {
      if (!entry.required) continue;
      const runway = entry.source.getBufferedRunway(
        time,
        direction,
        horizonSimMs,
      );
      this.noteBlockedRunway(id, runway);
      entries.push({ runway, bucketMs: declaredBucketMs(entry.source) });
    }
    return this.foldRequiredRunways(entries, horizonSimMs, tolSimMs, absSpeed);
  }

  /**
   * Audit B6: re-probe the required frontier FROM a cached frontier the
   * playhead just crossed. Asks the one question the clamp needs answered —
   * "did data land past the frontier I know about?" — by probing at that
   * frontier, so a runway that has moved on is found and one that has not
   * confirms the snap target as loaded data. Returns the fresh absolute
   * frontier (±Infinity when complete) and caches it like
   * {@link refreshFrontier} does; no fairness pass (one probe, one purpose).
   */
  private reprobeFrontierFrom(
    frontier: number,
    direction: 1 | -1,
    absSpeed: number,
  ): number {
    const runway = this.combinedRequiredRunway(
      frontier,
      direction,
      undefined,
      this.toleranceSimMs(absSpeed),
      absSpeed,
    );
    const fresh = runway.complete
      ? direction * Infinity
      : frontier + direction * runway.simMs;
    this.frontierDirection = direction;
    this.bufferedUntil = fresh;
    this.lastFrontierProbeWall = nowWall();
    return fresh;
  }

  /**
   * Audit B8 bookkeeping: count a source's runway flipping INTO a permanent
   * block once, however many probes see it, and forget the block when the
   * source reports past it again (so a later block is a new event).
   */
  private noteBlockedRunway(id: string, runway: BufferedRunway): void {
    if (isBlockedForGating(runway)) {
      if (!this.blockedSourceIds.has(id)) {
        this.blockedSourceIds.add(id);
        this.qoeBlockedPermanentlyCount++;
      }
    } else {
      this.blockedSourceIds.delete(id);
    }
  }

  /**
   * Whether the maxStartWaitMs escape hatch may fire (audit G8 / CS-9). With
   * nothing registered and nothing offered there is no runway the gate is
   * failing to fill — a hatch then free-runs the clock into the timeline
   * with no clamp, and the eventual `addSource` pins creep wherever it got
   * to. The hatch waits for a source; the first registration re-bases its
   * clock.
   */
  private hatchArmed(): boolean {
    return this.hasAnySource() || this.hatchArmedByRejectedSource;
  }

  /**
   * The per-source lift band τ_i (BH-4, §11.2).
   *
   * An AUTHORED `runwayToleranceMs` wins globally — every source is banded at
   * the authored wall constant × |speed|, so `0` still folds the raw min.
   * Otherwise the band is derived from the cadences the two sources actually
   * declare: `τ_i = max(Δ_i, Δ_L) + TICK_PROBE_INTERVAL_MS × |speed|`. The
   * residue is the probe staleness — the fold reads runways that are up to one
   * probe interval old, and that much misalignment is below the governor's own
   * observation resolution. It is also exactly the incumbent default, so a
   * derived band is never NARROWER than today's: a pair that declares nothing
   * (`Δ = 0` / no method) falls straight back to it, which is the whole
   * degradation contract — an undeclared `temporalBucketMs` must land on the
   * wall default, never on τ = 0.
   *
   * `leadCapped` (audit B7 / G2): the leader's runway sits AT the horizon the
   * probe asked for. The watermark probe asks for `600 ms × |speed|` and the
   * source floors that at its own bucket, so on every bucket-coarse composite
   * a healthy leader reads exactly `max(watermark, Δ_L)` — and `τ_i ≥ Δ_L +
   * 200 ms × |speed|` then lifted EVERY incomplete laggard to it, a starved
   * one at zero included: the min-gate degenerated to a max-gate and the
   * laggard played through its missing bucket. A capped leader carries no
   * information about how far ahead it really is, so the bucket-derived
   * widening cannot be measured against it; the band is the wall default
   * there, which is exactly the authored-default fold.
   */
  private liftBandSimMs(
    bucketMs: number | null,
    leadBucketMs: number | null,
    tolSimMs: number,
    absSpeed: number,
    leadCapped: boolean,
  ): number {
    if (this.runwayToleranceAuthored) return tolSimMs;
    const declared = Math.max(bucketMs ?? 0, leadBucketMs ?? 0);
    if (!(declared > 0) || leadCapped) return tolSimMs;
    return declared + TICK_PROBE_INTERVAL_MS * absSpeed;
  }

  /**
   * The fold half of {@link combinedRequiredRunway}, split out so callers
   * that already hold per-source probes (the tick-path frontier probe, which
   * shares ONE probe per source with the fairness pass) can fold without
   * re-probing.
   */
  private foldRequiredRunways(
    entries: RunwayFoldEntry[],
    horizonSimMs: number | undefined,
    tolSimMs: number,
    absSpeed = 0,
  ): BufferedRunway {
    if (entries.length === 0) {
      // No gating source: never stall. Report a complete, unbounded runway.
      return {
        simMs: horizonSimMs ?? Infinity,
        bytesPending: 0,
        horizonSimMs: horizonSimMs ?? Infinity,
        complete: true,
      };
    }
    // First pass: collect each incomplete source's runway + the leading
    // (max) one. Complete sources never gate, so they are excluded from both
    // the min floor and the lead (they read as unbounded).
    let bytesPending = 0;
    let allComplete = true;
    let leadSimMs = -Infinity;
    /** Cadence of the LEADING incomplete source — the Δ_L of every τ_i. */
    let leadBucketMs: number | null = null;
    const incomplete: RunwayFoldEntry[] = [];
    for (const e of entries) {
      const r = e.runway;
      bytesPending += r.bytesPending;
      // A permanently-blocked runway (audit B8) is buffered for gating
      // purposes: nothing will ever arrive, so waiting is a hold until the
      // escape hatch, not a stall that data can end.
      if (r.complete || isBlockedForGating(r)) continue;
      allComplete = false;
      incomplete.push(e);
      if (r.simMs > leadSimMs) {
        leadSimMs = r.simMs;
        leadBucketMs = e.bucketMs;
      }
    }
    if (allComplete) {
      // Every required source is complete — unbounded, which `complete`
      // already encodes (mirrors the historical Infinity floor).
      return {
        simMs: Infinity,
        bytesPending,
        horizonSimMs: horizonSimMs ?? Infinity,
        complete: true,
      };
    }
    // Second pass: lift any source within ITS OWN band τ_i of the leader to
    // the leader, then take the min. Sources further behind keep their real
    // runway (full stall protection). The lift is still measured BETWEEN
    // sources against the leader — never against the gate or the watermark
    // (the §11.2 structural constraint) — and complete sources are still
    // excluded from both the lead and the min.
    // The leader is "capped" when it reads at/over the horizon this probe
    // asked for (see liftBandSimMs). The frontier path asks for no horizon
    // and is never capped; the gate and watermark paths are.
    const leadCapped =
      horizonSimMs !== undefined &&
      Number.isFinite(horizonSimMs) &&
      leadSimMs >= horizonSimMs;
    let minSimMs = Infinity;
    for (const e of incomplete) {
      const simMs = e.runway.simMs;
      const tau = this.liftBandSimMs(
        e.bucketMs,
        leadBucketMs,
        tolSimMs,
        absSpeed,
        leadCapped,
      );
      const effective = leadSimMs - simMs <= tau ? leadSimMs : simMs;
      if (effective < minSimMs) minSimMs = effective;
    }
    return {
      simMs: minSimMs,
      bytesPending,
      horizonSimMs: horizonSimMs ?? minSimMs,
      complete: false,
    };
  }

  private emit<K extends GovernorEventName>(
    event: K,
    payload: Parameters<GovernorEventMap[K]>[0],
  ): void {
    for (const listener of this.listeners[event]) {
      (listener as (arg: typeof payload) => void)(payload);
    }
  }

  private setState(next: PlaybackGovernorState): void {
    if (this._state === next) return;
    const prev = this._state;
    // QoE stall accounting rides the transitions themselves so no caller can
    // forget it: every entry into 'buffering' is one rebuffer event, every
    // exit closes its wall-clock span.
    const now = nowWall();
    if (prev === 'buffering') {
      this.qoeTotalStallMs += now - this.stallEnteredAtWall;
    }
    if (next === 'buffering') {
      this.qoeStallCount++;
      this.stallEnteredAtWall = now;
    }
    // Settle-to-full-detail closes the FIRST time the post-release gate lets
    // go (the gate measures the fine tier, so this is honest about full
    // detail). A later stall opens a new gate but does not reopen this span.
    const bracket = this.scrubQoe;
    if (
      bracket &&
      bracket.settleMs === null &&
      bracket.settlePendingSince !== null &&
      next !== 'starting' &&
      next !== 'buffering' &&
      next !== 'seeking'
    ) {
      bracket.settleMs = Math.max(0, now - bracket.settlePendingSince);
      bracket.settlePendingSince = null;
    }
    this._state = next;
    this.emit('statechange', next);
    emitProbe('playback', {
      event: 'statechange',
      state: next,
      ...this.getQoeStats(),
    });
    // Same counters, latest-value: a measurement window that contains no
    // transition at all still gets a reading (the channel would be empty).
    this.publishStateSnapshot();
  }

  /**
   * Single write path for degraded creep so the QoE creep clock can never
   * leak: opening a span stamps it, closing it accumulates the wall time.
   */
  private setDegradedCreep(on: boolean): void {
    if (this.degradedCreep === on) return;
    const now = nowWall();
    if (on) {
      this.creepStartedAtWall = now;
    } else {
      this.qoeCreepMs += now - this.creepStartedAtWall;
    }
    this.degradedCreep = on;
  }

  private isGated(): boolean {
    return (
      this._state === 'starting' ||
      this._state === 'buffering' ||
      this._state === 'seeking'
    );
  }

  /**
   * Commit path for every real seek: flush stale prefetch (so the new window
   * doesn't compete with old lookahead for the request pool), move the clock,
   * then re-gate at the plain (startup-sized) gate if intent is playing.
   */
  private commitSeek(time: number): void {
    // Any committed seek leaves the ended boundary and invalidates a prior
    // settle-commit memo (seekTo re-stamps it when scrubbing).
    this.endedAtBoundary = false;
    this.scrubCommittedTime = null;
    // Flush stale prefetch on EVERY source so the new window doesn't compete
    // with old lookahead for the request pool (optional sources included —
    // they load too).
    for (const source of this.allSources()) source.flushPrefetch();
    // Freeze the clock BEFORE moving it: with a running clock the seek target
    // would tick forward (and hit the frontier clamp) for a frame before the
    // gate takes over. A seek also invalidates the frontier and any creep.
    this.pauseClock();
    this.bufferedUntil = null;
    this.setDegradedCreep(false);
    this.timeController.setTime(time);
    this.qoeSeekCount++;
    if (this.userWantsPlayback) {
      // The settle sample closes when this seek's gate passes (evaluateGate).
      this.seekCommittedAtWall = nowWall();
      this.enterGate('seeking', 1);
    } else {
      this.seekCommittedAtWall = null;
      this.stopEvalTimer();
      this.setState('idle');
    }
  }

  private enterGate(
    state: 'starting' | 'buffering' | 'seeking',
    factor: number,
  ): void {
    this.gateFactor = factor;
    this.gateStartedAtWall = nowWall();
    this.qoeGateEntries[state]++;
    this.pauseClock();
    // Freezing the clock makes the layer report "paused" to the loader, which
    // would shut down ahead-of-playhead prefetch — the very thing that must
    // fill this gate. Re-assert animating-at-target-speed on EVERY source so
    // every loader keeps reaching ahead while we wait (the stall deadlock fix;
    // see BufferSource). Broadcast to optional sources too: they must keep
    // loading even though they don't gate.
    const gateSpeed = this.timeController.getSpeed();
    for (const source of this.allSources())
      source.setAnimationState?.(true, gateSpeed);
    this.setState(state);
    const etaMs = this.getEtaMs();
    this.emit('waiting', { state, etaMs });
    emitProbe('playback', {
      event: 'waiting',
      state,
      etaMs,
      ...this.getQoeStats(),
    });
    // Evaluate once immediately (the gate may already be satisfied — e.g. a
    // backward seek into cached time); otherwise poll at the gated cadence.
    // Only the latter is a HOLD (G3-4c): the clock stayed frozen.
    if (!this.evaluateGate()) {
      this.qoeGateHolds[state]++;
      this.startEvalTimer();
    }
  }

  /**
   * Push the clock's LOOPING range to every registered source (BH-7), or
   * `null` when playback is not looping. Idempotent and write-throttled by an
   * exact-value memo, so a non-looping session never calls
   * {@link BufferSource.setLoopWindow} at all and a looping one calls it once
   * per source per boundary change.
   *
   * The governor runs this itself on source registration and on every gate /
   * probe evaluation, which covers every path that can change the answer with
   * at most one evaluation of lag. It is public because
   * `TimeController.setLoop`/`setTimeRange` announce nothing — a host that
   * toggles looping outside a play/pause/seek can call this to push the change
   * immediately instead of waiting for the next evaluation.
   */
  syncLoopWindows(): void {
    if (this.disposed) return;
    // `bounce` (which takes precedence over `loop` in the clock) is NOT
    // exposed by TimeController, so it cannot be excluded here. A bouncing
    // clock never wraps — it reflects — so a loop window pushed under
    // `{loop: true, bounce: true}` would describe a boundary the clock does
    // not cross. That combination is already contradictory at the clock; if a
    // bounce accessor lands, gate this on it.
    const range = this.timeController.getLoop()
      ? (this.timeController.getTimeRange() ?? null)
      : null;
    for (const [id, entry] of this.sources) {
      this.sendLoopWindow(id, entry.source, range);
    }
  }

  /**
   * Throttled loop-window write: "never sent" and "sent null" are the same
   * state (a fresh source has no loop window), so a non-looping session is
   * byte-for-byte the incumbent — zero calls.
   */
  private sendLoopWindow(
    id: string,
    source: BufferSource,
    range: { start: number; end: number } | null,
  ): void {
    const last = this.lastSentLoopRanges.get(id) ?? null;
    if (range === null) {
      if (last === null) {
        // Record the (default) state so the memo is authoritative per id.
        this.lastSentLoopRanges.set(id, null);
        return;
      }
      this.lastSentLoopRanges.set(id, null);
      source.setLoopWindow?.(null);
      return;
    }
    if (last !== null && last.start === range.start && last.end === range.end) {
      return;
    }
    this.lastSentLoopRanges.set(id, { start: range.start, end: range.end });
    source.setLoopWindow?.({ start: range.start, end: range.end });
  }

  /**
   * Clear every outstanding loop window ONCE (registry teardown / swap): a
   * source leaving the governor must not keep rotating its eviction scores
   * around a wrap boundary nothing is driving any more.
   */
  private clearLoopWindows(): void {
    if (this.lastSentLoopRanges.size === 0) return;
    for (const [id, entry] of this.sources) {
      if (this.lastSentLoopRanges.get(id)) entry.source.setLoopWindow?.(null);
    }
    this.lastSentLoopRanges.clear();
  }

  /** Immediate re-evaluation: gate check while gated, stall check while playing. */
  private evaluateNow(): void {
    if (this.disposed) return;
    // Evict any source that has been torn down under us BEFORE reading the
    // registry: a finalized tileset reports a bone-dry, never-complete runway
    // forever, and the gate min()s over the required set (see
    // BufferSource.isInert).
    this.pruneInertSources();
    // Loop mode / range can change without announcing itself (the clock has no
    // event for either), so re-derive on the evaluation cadence. Two getters
    // and a numeric compare per source — no probe, no timer of its own.
    this.syncLoopWindows();
    if (this.isGated()) {
      this.evaluateGate();
    } else if (this._state === 'playing' && !this.scrubbing) {
      // The frontier walk is coalesced to the tick-probe cadence (audit G6):
      // N sources each firing ≤10 Hz buffer events made this O(N²) runway
      // walks per second on composites, and the frontier only feeds the
      // per-tick clamp, which re-probes before it snaps anyway (B6). Creep
      // is the exception — there the frontier IS the playhead (the pin
      // advances at data-arrival rate), so it stays data-paced, and the
      // creep re-arm rides it. The watermark check is the honest part and
      // still runs on every event.
      if (
        this.degradedCreep ||
        this.bufferedUntil === null ||
        nowWall() - this.lastFrontierProbeWall >= TICK_PROBE_INTERVAL_MS
      ) {
        this.refreshFrontier();
      }
      if (!this.degradedCreep) this.checkLowWatermark();
    }
  }

  /**
   * Would a gate of multiplier `gateFactor` pass RIGHT NOW, on the runway
   * alone (no escape hatch, no state change)? The single implementation of
   * "is there enough buffered to run", shared by the gate that waits on it and
   * by the watermark, which must never stall into a state this answers `true`
   * for.
   *
   * `applyFairness` is the gated-cadence piggyback and belongs to the gate's
   * own evaluation only: the watermark asks this question mid-playback, where
   * the tick probe already drives the fairness pass, and a second intervention
   * per stall decision would re-cap leaders off a probe capped at the gate
   * window.
   */
  private gateWouldPass(
    gateFactor: number,
    absSpeed: number,
    applyFairness: boolean,
  ): boolean {
    const requiredSimMs = this.startGateWallMs * absSpeed * gateFactor;
    // Zero speed consumes no data — nothing to gate on.
    if (requiredSimMs <= 0) return true;
    if (!this.hasAnySource()) return false;
    const direction: 1 | -1 = this.timeController.getSpeed() < 0 ? -1 : 1;
    const time = this.timeController.getTime();
    // Combined over REQUIRED sources: min runway (cadence-tolerance-banded),
    // AND complete. With zero required sources this reports complete (never
    // gates).
    const runway = this.combinedRequiredRunway(
      time,
      direction,
      requiredSimMs,
      this.toleranceSimMs(absSpeed),
      absSpeed,
    );
    let passed = runway.complete || runway.simMs >= requiredSimMs;
    if (!passed) {
      // canplaythrough-style predictor (HAVE_ENOUGH_DATA): start when the
      // MISSING remainder of the gate window is predicted to download in less
      // wall time than the already-buffered runway plays out (with a small
      // floor so an instant network passes a cold gate). Without this, gates
      // scale linearly with |speed| and a 10× sweep can demand sim-years of
      // runway that no loader is meant to hold up front.
      passed = this.predictsPlaythrough(
        time,
        direction,
        requiredSimMs,
        runway,
        absSpeed,
      );
    }
    // Self-probing: the probe above is capped at the gate window, which would
    // misread every leader as tied at that horizon.
    if (applyFairness) this.applyMultiSourceFairness(null, absSpeed);
    return passed;
  }

  /**
   * Can the current gate open? Passes when the runway covers
   * `startGateWallMs × |speed| × gateFactor`, when the runway is complete
   * (dataset end / everything loaded), or — degraded — when the gate has been
   * held for `maxStartWaitMs`.
   */
  private evaluateGate(): boolean {
    // The gate min()s over the required set, so it must not read a source that
    // has been torn down under it. `evaluateNow` already prunes, but
    // `enterGate` evaluates ONCE directly (the gate may already be satisfied) —
    // without this, a gate entered while a dead source is still registered
    // holds for one eval-timer cadence before it can notice.
    this.pruneInertSources();
    if (!this.userWantsPlayback) {
      // Intent evaporated while gated (requestPause already handled state;
      // this is pure defense).
      this.stopEvalTimer();
      this.setState('idle');
      return false;
    }

    if (this.scrubbing) {
      // A gate must never start the clock under a held thumb — video players
      // warm the pipeline on a settled scrub but resume only on release.
      // Covers both the settle-commit's own 'seeking' gate and a pre-existing
      // gate ('starting'/'buffering') the user began dragging through. The
      // maxStartWaitMs escape hatch is suspended too: degraded playback under
      // a held thumb is worse than a longer-held preview (endScrub re-bases
      // the hatch clock on release).
      return false;
    }

    const absSpeed = Math.abs(this.timeController.getSpeed());

    // Fairness piggybacks on the GATED eval cadence (the tick probe is frozen
    // with the clock, and a gate is exactly when leaders extending runway past
    // a buffering laggard hurts most).
    let passed = this.gateWouldPass(this.gateFactor, absSpeed, true);
    let degraded = false;
    if (
      !passed &&
      this.hatchArmed() &&
      nowWall() - this.gateStartedAtWall >= this.maxStartWaitMs
    ) {
      // Escape hatch — never hard-lock playback on a broken network.
      passed = true;
      degraded = true;
    }
    if (!passed) return false;

    this.stopEvalTimer();
    // QoE (G2): a committed seek settles when ITS gate passes. A wrap or a
    // stall gate in between nulls the stamp, so the sample is never charged
    // to the wrong gate.
    if (this._state === 'seeking' && this.seekCommittedAtWall !== null) {
      this.qoeSeekSettleSamples.push(nowWall() - this.seekCommittedAtWall);
      if (this.qoeSeekSettleSamples.length > SEEK_SETTLE_SAMPLE_CAP) {
        this.qoeSeekSettleSamples.shift();
      }
    }
    this.seekCommittedAtWall = null;
    // The gate filled (or the hatch fired) — the pre-gate frontier is stale,
    // and trusting it would clamp the freshly-resumed playback straight back.
    // Null it; the first tick re-probes.
    this.bufferedUntil = null;
    this.lastFrontierProbeWall = 0;
    // QoE: the starting gate's duration is the session's startup time; an
    // escape-hatch pass of ANY gate is a degraded resume.
    if (this._state === 'starting') {
      this.qoeStartupMs = nowWall() - this.gateStartedAtWall;
    }
    if (degraded) {
      this.qoeDegradedResumeCount++;
    }
    // An escape-hatch pass means the runway could NOT fill: switch to creep
    // (pin at the frontier, no re-gating) instead of letting the next buffer
    // event re-enter 'buffering' for another maxStartWaitMs freeze. An honest
    // pass always clears creep.
    this.setDegradedCreep(degraded);
    this.setState('playing');
    this.playClock();
    this.emit('ready', { degraded });
    emitProbe('playback', {
      event: 'ready',
      state: 'playing',
      degraded,
      ...this.getQoeStats(),
    });
    return true;
  }

  /**
   * Re-probe the buffered frontier at the source's own (generous, ~10 wall-s)
   * default horizon and cache it as an ABSOLUTE sim-time bound for the
   * per-tick clamp. Deliberately separate from the watermark probe, whose
   * small horizon caps the reported runway far short of the real frontier.
   * Also the creep re-arm point: once the runway again covers the full
   * resume gate (or completes), degraded creep ends and normal stalling
   * applies.
   */
  private refreshFrontier(): void {
    this.lastFrontierProbeWall = nowWall();
    const speed = this.timeController.getSpeed();
    if (!this.hasAnySource() || speed === 0) {
      this.bufferedUntil = null;
      return;
    }
    const absSpeed = Math.abs(speed);
    const direction: 1 | -1 = speed < 0 ? -1 : 1;
    const time = this.timeController.getTime();
    // ONE probe per registered source (at the generous default horizon, as
    // this path always used) feeds BOTH the frontier fold below and the
    // fairness/weight pass — the playing-cadence piggyback, no double probe.
    // With the fairness kill switch off, optional sources feed neither
    // consumer, so don't pay their probes at all (the switch must remove
    // the cost the feature introduced, not just its writes).
    const probes = this.probeAllRunways(
      time,
      direction,
      !this.multiSourceFairness,
    );
    const requiredRunways: RunwayFoldEntry[] = [];
    for (const p of probes) {
      if (p.required) {
        requiredRunways.push({ runway: p.runway, bucketMs: p.bucketMs });
      }
    }
    // The NEAREST required-source frontier (cadence-tolerance-banded min
    // simMs); complete = AND over required. The same band that keeps the gate
    // from false-stalling must also lift the cached frontier so the per-tick
    // clamp doesn't snap the playhead back to a fractionally-behind cadence
    // peer. With zero required sources this is complete ⇒ unbounded.
    const runway = this.foldRequiredRunways(
      requiredRunways,
      undefined,
      this.toleranceSimMs(absSpeed),
      absSpeed,
    );
    this.frontierDirection = direction;
    // A zero runway means the head's OWN bucket is not resident: the frontier
    // is then behind the head, not at it (G3-4b) — anchoring it at the head
    // made the clamp snap the clock to where it already was, one frame
    // further into unloaded data per probe.
    this.bufferedUntil = runway.complete
      ? direction * Infinity
      : runway.simMs > 0
        ? time + direction * runway.simMs
        : this.residentFrontierBehind(time, direction);
    if (this.degradedCreep) {
      const required = this.startGateWallMs * absSpeed * this.resumeFactor;
      if (runway.complete || runway.simMs >= required) {
        this.setDegradedCreep(false);
      }
    }
    this.applyMultiSourceFairness(probes, absSpeed);
  }

  /**
   * G3-4b: where the resident data ENDS behind a head whose own bucket is not
   * resident — the end of the last buffered range at or before the head
   * travelling forward (the start of the first at or after it, backward),
   * folded over the required set exactly as {@link getBufferedRanges} is.
   * A range that contains the head (a required-set fold can read zero at a
   * cadence seam) anchors at its far edge, never behind; with nothing
   * resident behind at all, the head itself is the only honest answer — the
   * pre-G3-4 behavior, which the clamp then leaves alone.
   */
  private residentFrontierBehind(time: number, direction: 1 | -1): number {
    let behind = time;
    for (const r of this.getBufferedRanges()) {
      if (direction > 0) {
        if (r.start <= time && time < r.end) return r.end;
        if (r.end <= time) behind = r.end; // ascending: the last such wins
      } else {
        if (r.start < time && time <= r.end) return r.start;
        if (r.start >= time) return r.start; // ascending: the first such wins
      }
    }
    return behind;
  }

  /**
   * True when `time` is past the cached frontier by a playback-sized step —
   * within the clamp's own bound, so not an external seek.
   */
  private headPastFrontier(
    time: number,
    direction: 1 | -1,
    absSpeed: number,
  ): boolean {
    const frontier = this.bufferedUntil;
    if (frontier === null || !Number.isFinite(frontier)) return false;
    const overrun = direction > 0 ? time - frontier : frontier - time;
    return overrun > 0 && overrun <= absSpeed * CLAMP_MAX_OVERRUN_REAL_MS;
  }

  /** One {@link BufferSource.getBufferedRunway} probe per REGISTERED source
   * (required + optional alike, at the source's generous default horizon).
   * `requiredOnly` skips optional sources for callers that only fold the
   * required set (the fairness-off frontier path). */
  private probeAllRunways(
    time: number,
    direction: 1 | -1,
    requiredOnly = false,
  ): SourceProbe[] {
    const out: SourceProbe[] = [];
    for (const [id, entry] of this.sources) {
      if (requiredOnly && !entry.required) continue;
      const runway = entry.source.getBufferedRunway(time, direction);
      this.noteBlockedRunway(id, runway);
      out.push({
        id,
        required: entry.required,
        baseWeight: entry.weight,
        source: entry.source,
        runway,
        bucketMs: declaredBucketMs(entry.source),
      });
    }
    return out;
  }

  /**
   * Run-ahead fairness + dynamic fair-share weights (Phase 2 of multi-source
   * coordination, §5–6 of docs/roadmap/playback-and-loading.md). The clock
   * min-gates on the required laggard (MSE intersection), so any buffer a
   * leader holds past `laggard + slack` is dead weight: it cannot render
   * before the laggard catches up, its fetches contend with the laggard's in
   * the shared scheduler, and it feeds cache-pressure eviction in the loader
   * (which can evict the protected runway the gate is waiting on). Two
   * levers, both write-throttled (see the memo fields):
   *
   * - CAP (Shaka-style run-ahead limit): every source that is NOT (one of)
   *   the laggard(s) gets `setPrefetchRunAheadLimit(laggard + slack)`;
   *   laggard(s) get `null` (run free). Optional sources are capped too —
   *   one ahead of the required laggard is pure dead weight; one behind is
   *   unaffected, since the cap only limits run-AHEAD.
   *
   * - WEIGHT (BH-3, §11.3): each incomplete REQUIRED source is priced by the
   *   BYTES it must still buy to reach the leader — `N_i = β_i × deficit_i` —
   *   and weights are filled proportional to `N_i`, normalized so the neediest
   *   lands on `4 × base` and a source already inside the slack band sheds to
   *   `0.25 × base` (see {@link computeProgressiveFillWeights}). β is this
   *   source's byte density at its own frontier, measured through
   *   {@link BufferSource.estimateCost} over one bucket
   *   ({@link frontierByteDensity}); a bytes-blind source reads β = 1 and the
   *   fill degrades to the runway-only shed it replaces
   *   ({@link computeRunwayShedWeights}, retained as the named fallback).
   *   DRR is work-conserving, so this only matters while leaders still have
   *   legitimate queued work (e.g. refetching near-window evictions); the
   *   run-ahead cap does most of the work. Optional/complete sources stay at
   *   base.
   *
   * Piggybacks on the existing probe cadences (playing tick-probe +
   * gated eval) — never its own timer. Skips — clearing outstanding
   * caps/weights once — when disabled, under 2 sources, no incomplete
   * required source, or idle.
   */
  private applyMultiSourceFairness(
    probes: SourceProbe[] | null,
    absSpeed: number,
  ): void {
    if (
      !this.multiSourceFairness ||
      this.sources.size < 2 ||
      this._state === 'idle'
    ) {
      this.deactivateFairness();
      return;
    }
    if (probes === null) {
      // Gated path: evaluations are event-driven (buffer events on top of
      // the 250 ms timer) and can burst far past the playing tick cadence,
      // and the self-probe here is a full per-source sweep. Rate-limit it
      // to the same TICK_PROBE_INTERVAL_MS the playing path runs at —
      // skipping is safe, caps/weights only drift as fast as runways do.
      const now = nowWall();
      if (now - this.lastFairnessSelfProbeWall < TICK_PROBE_INTERVAL_MS) {
        return;
      }
      this.lastFairnessSelfProbeWall = now;
      const gatedSpeed = this.timeController.getSpeed();
      const gatedDirection: 1 | -1 = gatedSpeed < 0 ? -1 : 1;
      probes = this.probeAllRunways(
        this.timeController.getTime(),
        gatedDirection,
      );
    }
    // The playhead the probes were taken at — the anchor β measures from. Both
    // entry paths probe at the clock's CURRENT time/direction, so re-reading
    // them here is the same pair, not a second sample.
    const speed = this.timeController.getSpeed();
    const direction: 1 | -1 = speed < 0 ? -1 : 1;
    const time = this.timeController.getTime();
    // laggard = min runway over incomplete REQUIRED sources (complete sources
    // never gate, so they never define the floor).
    let laggardSimMs = Infinity;
    for (const p of probes) {
      if (p.required && !p.runway.complete && p.runway.simMs < laggardSimMs) {
        laggardSimMs = p.runway.simMs;
      }
    }
    if (!Number.isFinite(laggardSimMs)) {
      this.deactivateFairness();
      return;
    }
    // Same wall-ms × |speed| denomination as every gate threshold (callers
    // pass the exact |speed| the gate/keep-alive math uses).
    const slackSimMs =
      Math.max(this.runwayToleranceMs, RUN_AHEAD_SLACK_WALL_MS) * absSpeed;
    const capSimMs = laggardSimMs + slackSimMs;
    // WEIGHTS (BH-3): price every incomplete required source's deficit in
    // BYTES and fill share proportional to that need. β is only worth
    // measuring when there are at least two of them — one source has nobody to
    // be fair against, and the fill returns base weights for it either way, so
    // the directory walk would be pure cost.
    const weights = this.computeFairnessWeights(
      probes,
      slackSimMs,
      time,
      direction,
    );
    // Hysteresis bands (see LAGGARD_*_BAND_FRACTION): membership from the
    // PREVIOUS pass widens a source's band, so a near-tie can't flap
    // identity — and cap writes — across evaluations.
    const prevLaggards = this.lastLaggardIds;
    const nextLaggards = new Set<string>();
    for (const p of probes) {
      const band =
        slackSimMs *
        (prevLaggards.has(p.id)
          ? LAGGARD_EXIT_BAND_FRACTION
          : LAGGARD_ENTER_BAND_FRACTION);
      const isLaggard =
        p.required &&
        !p.runway.complete &&
        p.runway.simMs <= laggardSimMs + band;
      if (isLaggard) nextLaggards.add(p.id);
      this.sendRunAheadCap(p.id, p.source, isLaggard ? null : capSimMs);
      const weight = weights.get(p.id);
      if (weight !== undefined) {
        this.sendBandwidthWeight(p.id, p.source, weight, p.baseWeight);
      }
    }
    this.lastLaggardIds = nextLaggards;
  }

  /**
   * The fair-share weight per incomplete REQUIRED source id (BH-3). Optional
   * and complete sources are absent from the map and are therefore never
   * written — they stay at their registered base weight, exactly as before.
   *
   * Returns the byte-aware progressive fill by default; flipping
   * {@link USE_PROGRESSIVE_FILL_WEIGHTS} restores the incumbent `1/x` runway
   * shed through the identical map interface (the one-release rollback).
   */
  private computeFairnessWeights(
    probes: SourceProbe[],
    slackSimMs: number,
    time: number,
    direction: 1 | -1,
  ): Map<string, number> {
    const contenders: SourceProbe[] = [];
    for (const p of probes) {
      if (p.required && !p.runway.complete) contenders.push(p);
    }
    if (contenders.length === 0) return new Map();
    // Δ for the β walk: one declared bucket, floored at the slack the fill
    // measures need against, so a source that declares nothing still samples a
    // meaningful span. Bounded to ONE bucket on purpose (the BH-3 risk note):
    // the density is a local rate, not a horizon sum.
    const fill: ProgressiveFillProbe[] = [];
    for (const p of contenders) {
      const deltaSimMs = Math.max(p.bucketMs ?? 0, slackSimMs);
      const beta =
        contenders.length < 2
          ? null
          : this.frontierByteDensity(p, deltaSimMs, time, direction);
      fill.push({
        id: p.id,
        runwaySimMs: p.runway.simMs,
        // A bytes-blind source (no measurable density) prices at 1 byte per
        // sim-ms, which is what makes the fill degrade to a runway-only shed
        // instead of guessing.
        betaBytesPerSimMs: beta ?? 1,
        baseWeight: p.baseWeight,
      });
    }
    return USE_PROGRESSIVE_FILL_WEIGHTS
      ? computeProgressiveFillWeights(fill, slackSimMs)
      : computeRunwayShedWeights(fill, slackSimMs);
  }

  /**
   * β_i: bytes still missing per sim-ms at THIS source's own frontier, or null
   * when the source cannot answer in bytes (BH-3).
   *
   * Measured with the existing {@link BufferSource.estimateCost} over one Δ
   * immediately past the source's frontier — the span the source would buy
   * next — so a source whose tiles are 10× heavier prices 10× the need for the
   * same sim-ms of deficit. `0` bytes is read as BLIND, not as free: a byte
   * channel with no `getTileByteSize` wired reports 0 for every tile and a
   * caller cannot tell the two apart (the same honesty contract
   * {@link BufferSource.getByteDensityProfile} states).
   *
   * MEMOIZED per (source, frontier bucket, Δ): `estimateCost` is a directory
   * walk and this runs on the 200 ms probe cadence. The key changes exactly
   * when the frontier crosses a bucket boundary or |speed| changes Δ.
   */
  private frontierByteDensity(
    probe: SourceProbe,
    deltaSimMs: number,
    time: number,
    direction: 1 | -1,
  ): number | null {
    if (!(deltaSimMs > 0) || !Number.isFinite(deltaSimMs)) return null;
    const runwaySimMs = probe.runway.simMs;
    if (!Number.isFinite(runwaySimMs)) return null;
    const frontier = time + direction * Math.max(0, runwaySimMs);
    if (!Number.isFinite(frontier)) return null;
    const key = `${Math.floor(frontier / deltaSimMs)}|${deltaSimMs}`;
    const memo = this.betaMemo.get(probe.id);
    if (memo && memo.key === key) return memo.beta;
    const start = direction > 0 ? frontier : frontier - deltaSimMs;
    const cost = probe.source.estimateCost({
      start,
      end: start + deltaSimMs,
    });
    const bytes = cost?.bytes;
    const beta =
      typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0
        ? bytes / deltaSimMs
        : null;
    this.betaMemo.set(probe.id, { key, beta });
    return beta;
  }

  /** Throttled cap write: re-send only on a to/from-null transition or a >20% change. */
  private sendRunAheadCap(
    id: string,
    source: BufferSource,
    capSimMs: number | null,
  ): void {
    const last = this.lastSentCaps.get(id); // undefined = never sent
    if (capSimMs === null) {
      if (last === null) return; // already uncapped
      this.lastSentCaps.set(id, null);
      source.setPrefetchRunAheadLimit?.(null);
      return;
    }
    if (
      typeof last === 'number' &&
      Math.abs(capSimMs - last) <= last * FAIRNESS_RESEND_FRACTION
    ) {
      return;
    }
    this.lastSentCaps.set(id, capSimMs);
    source.setPrefetchRunAheadLimit?.(capSimMs);
  }

  /**
   * Throttled weight write: the reference is the last SENT value, or the base
   * weight when none was — so a source sitting at base (the laggard, by
   * construction of the shed formula) is never written at all.
   */
  private sendBandwidthWeight(
    id: string,
    source: BufferSource,
    weight: number,
    baseWeight: number,
  ): void {
    const ref = this.lastSentWeights.get(id) ?? baseWeight;
    if (Math.abs(weight - ref) <= ref * FAIRNESS_RESEND_FRACTION) return;
    this.lastSentWeights.set(id, weight);
    source.setBandwidthWeight?.(weight);
  }

  /**
   * Lift every outstanding fairness intervention ONCE: clear caps to null and
   * restore base weights on the sources still registered, then drop the
   * memos. Called when fairness deactivates — kill switch / under 2 sources /
   * no incomplete required source / idle (via the skip path), plus pause,
   * laggard removal, setSource, and dispose (explicitly — no probe runs
   * there). O(1) when nothing is outstanding.
   */
  private deactivateFairness(): void {
    this.lastLaggardIds.clear();
    if (this.lastSentCaps.size === 0 && this.lastSentWeights.size === 0) return;
    for (const [id, entry] of this.sources) {
      if (typeof this.lastSentCaps.get(id) === 'number') {
        entry.source.setPrefetchRunAheadLimit?.(null);
      }
      const sentWeight = this.lastSentWeights.get(id);
      if (sentWeight !== undefined && sentWeight !== entry.weight) {
        entry.source.setBandwidthWeight?.(entry.weight);
      }
    }
    this.lastSentCaps.clear();
    this.lastSentWeights.clear();
  }

  /** Move the clock without the tick subscription clamping our own write. */
  private setClockTime(time: number): void {
    this.suppressTickClamp = true;
    try {
      this.timeController.setTime(time);
    } finally {
      this.suppressTickClamp = false;
    }
  }

  /**
   * Stall detection while playing: freeze the clock when the runway drops
   * under the low watermark and is NOT complete (complete means dataset end /
   * everything loaded — never stall then). Resumes through a resumeFactor×
   * gate (hysteresis), so one honest stall replaces many micro-stalls.
   */
  private checkLowWatermark(): void {
    if (!this.hasAnySource() || !this.userWantsPlayback) return;
    const speed = this.timeController.getSpeed();
    const absSpeed = Math.abs(speed);
    if (absSpeed <= 0) return;

    // EFFECTIVE watermark: the configured value scaled by measured link jitter
    // (see effectiveLowWatermarkWallMs). Identical to `lowWatermarkWallMs` on a
    // calm link, so today's transitions are reproduced exactly; a jittery link
    // stalls earlier and honestly instead of sailing into a dry-out.
    const watermarkSimMs = this.effectiveLowWatermarkWallMs * absSpeed;
    const direction: 1 | -1 = speed < 0 ? -1 : 1;
    const time = this.timeController.getTime();
    // Combined over REQUIRED sources: stall when the LAGGARD's runway drops
    // under the watermark (and the required set isn't all complete). The
    // cadence band only coalesces sources within tolerance of the leader, so
    // a source genuinely below the watermark still drags the combined runway
    // under it and stalls — the watermark itself is never lowered.
    const runway = this.combinedRequiredRunway(
      time,
      direction,
      watermarkSimMs,
      this.toleranceSimMs(absSpeed),
      absSpeed,
    );
    if (runway.complete || runway.simMs >= watermarkSimMs) {
      // Healthy: whatever the floor swallowed was a resume onto a filling
      // runway, not a standing disagreement. Start the flap count over.
      this.flapSuppressedStalls = 0;
      return;
    }
    // Same canplaythrough predictor as the gate: don't stall when the loader
    // is predicted to outrun consumption — a thin runway on a fast network is
    // fine; a thin runway on a slow one is an imminent dry-out.
    if (
      this.predictsPlaythrough(
        time,
        direction,
        watermarkSimMs,
        runway,
        absSpeed,
      )
    ) {
      return;
    }
    // ANTI-FLAP: never stall into a state the resume gate would open again on
    // the spot. The two thresholds are one-way ordered on the runway compare
    // (watermark < resumeFactor × start gate) but NOT on every path that can
    // open a gate — `predictsPlaythrough` and a probe taken at a different
    // horizon each answer a question this check does not ask — so the two can
    // genuinely disagree. A stall that resumes in the same instant is not a
    // stall: it is a pause + a play, and `evaluateGate` nulls the cached
    // frontier on the way out, so the next tick re-probes and re-decides
    // immediately. That is an oscillation, one lap per frame, and in a React
    // host each lap is a state update whose render draws deck.gl, which ticks
    // this clock again — the loop terminates as "Maximum update depth
    // exceeded" rather than as jank.
    if (this.gateWouldPass(this.resumeFactor, absSpeed, false)) {
      this.noteSuppressedStall();
      return;
    }
    this.flapSuppressedStalls = 0;
    this.enterGate('buffering', this.resumeFactor);
  }

  /**
   * Count a stall the anti-flap check swallowed, and say so ONCE per session
   * when the count can no longer be a coincidence. Suppressing is always the
   * right call in the moment (a stall the resume gate would undo on the spot
   * is not a stall); a standing disagreement is still a defect, and this is
   * what makes it visible instead of merely quiet.
   */
  private noteSuppressedStall(): void {
    this.flapSuppressedStalls++;
    if (this.flapSuppressedStalls < FLAP_WARN_THRESHOLD || this.warnedGateFlap)
      return;
    this.warnedGateFlap = true;
    console.warn(
      '[PlaybackGovernor] the low watermark wants to stall in a state the ' +
        `resume gate would re-open immediately (${this.flapSuppressedStalls} ` +
        'in a row). Playback continues — the two thresholds want a look.',
    );
  }

  /**
   * HAVE_ENOUGH_DATA predictor. Two implementations, one contract:
   *
   * - FLUID (M5/CO-3, preferred): when every required source exposes
   *   {@link BufferSource.getByteDensityProfile} and the estimator has a rate,
   *   walk the merged bucket boundaries and require cumulative missing bytes
   *   through each boundary to fit inside that boundary's own deadline. This is
   *   what sees a byte cliff two windows out; the one-window compare below
   *   cannot, because it folds the whole window into a single number and so
   *   passes "thin now, wall later".
   * - ONE-WINDOW (incumbent, retained as the fallback): true when the
   *   needed-but-missing bytes inside `windowSimMs` ahead of `time` are
   *   estimated to download within the wall time the buffered runway already
   *   buys (floored at {@link PLAYTHROUGH_MIN_WALL_MS} so instant networks pass
   *   cold gates).
   *
   * Both are conservative when blind: false while the throughput estimator has
   * no samples yet. Anything that makes the fluid check unanswerable — one
   * source without the method, one `null` profile, a cold estimator, the kill
   * switch — routes to the incumbent path unchanged, never to a guess.
   */
  private predictsPlaythrough(
    time: number,
    direction: 1 | -1,
    windowSimMs: number,
    runway: BufferedRunway,
    absSpeed: number,
  ): boolean {
    const required = this.requiredSources();
    if (required.length === 0) return true; // nothing gates ⇒ always plays through
    if (absSpeed <= 0) return false;
    // HAVE_ENOUGH_DATA implies HAVE_CURRENT_DATA (G3-4a, tile-loading audit
    // 2026-08). Both predictors price the MISSING remainder against the wall
    // time the buffered runway buys, and with nothing under the head it buys
    // none — a stale rate (no transfer completed since the link slowed) then
    // "covered" the first missing buckets and the gate opened onto unloaded
    // data: one frame of advance per two ticks, a zero-length gate and a
    // snap-back per step (467 entries, 688 wall-ms past resident data in
    // 60 s). The head's own data comes first — see the floor.
    if (
      !runway.complete &&
      runway.simMs < this.playthroughRunwayFloorSimMs(absSpeed)
    ) {
      return false;
    }
    const fluid = this.predictsPlaythroughFluid(
      required,
      time,
      direction,
      windowSimMs,
      runway,
      absSpeed,
    );
    if (fluid !== null) return fluid;
    const window =
      direction > 0
        ? { start: time, end: time + windowSimMs }
        : { start: time - windowSimMs, end: time };
    // ALL required sources must predict playthrough ≡ the MAX ETA across them
    // is within budget. `runway.simMs` is already the laggard's runway (the
    // combined min), so a per-source ETA is compared against the combined
    // runway the slowest source actually buys.
    let maxEtaMs: number | null = null;
    for (const source of required) {
      const etaMs = source.estimateTimeToReadyMs(window);
      if (etaMs == null) return false; // blind on any required source ⇒ conservative
      maxEtaMs = maxEtaMs == null ? etaMs : Math.max(maxEtaMs, etaMs);
    }
    if (maxEtaMs == null) return false;
    const runwayWallMs = runway.simMs / absSpeed;
    return maxEtaMs <= Math.max(runwayWallMs, PLAYTHROUGH_MIN_WALL_MS);
  }

  /**
   * The runway the canplaythrough predictor needs before it may release
   * (G3-4a): one temporal bucket of the finest-grained required source, or
   * one probe interval at the current speed when that is shorter — the
   * clamp's own window, so the clock cannot outrun a fresh probe before the
   * next one. Never zero at a non-zero speed, so HAVE_ENOUGH_DATA can no
   * longer be claimed without HAVE_CURRENT_DATA.
   */
  private playthroughRunwayFloorSimMs(absSpeed: number): number {
    let floor = TICK_PROBE_INTERVAL_MS * absSpeed;
    for (const source of this.requiredSources()) {
      const bucketMs = declaredBucketMs(source);
      if (bucketMs !== null && bucketMs < floor) floor = bucketMs;
    }
    return floor;
  }

  /**
   * The FLUID feasibility check (M5/CO-3): one pass over the merged bucket
   * boundaries `T_k` of every required source's byte-density profile, out to
   * `min(dataset end, fluidCheckHorizonWallMs × |speed|)`, asserting
   *
   *   cumulative missing bytes through `T_k`
   *     ≤ conservative rate × (buffered-runway wall time + `T_k`'s wall offset)
   *
   * The one-window compare it replaces asks a strictly weaker question — "do
   * the whole window's missing bytes fit in the runway's wall time" — which a
   * window whose bytes are FLAT now and a WALL later passes trivially. Here
   * every boundary carries its own deadline, so the wall is priced at the
   * instant the playhead would actually hit it.
   *
   * `T_k`'s wall offset is measured from the buffered frontier (the runway
   * already covers everything nearer than that), which makes the budget at a
   * boundary beyond the runway exactly `(T_k − playhead) / |speed|` — the wall
   * time until the playhead arrives. The {@link PLAYTHROUGH_MIN_WALL_MS} floor
   * is carried over verbatim so an instant network still passes a cold gate.
   *
   * Returns `null` — meaning "not answerable here, use the incumbent path" —
   * when the kill switch is off, when any required source lacks the profile
   * method or returns `null`/malformed arrays, or when there is no conservative
   * rate to spend. Never guesses a byte count and never guesses a rate.
   *
   * Deterministic: a pure function of the profiles, the rate, the runway and
   * the arguments. Boundaries are ordered by a total comparator so a tie
   * between two sources' buckets can never depend on registry iteration order.
   */
  private predictsPlaythroughFluid(
    required: BufferSource[],
    time: number,
    direction: 1 | -1,
    windowSimMs: number,
    runway: BufferedRunway,
    absSpeed: number,
  ): boolean | null {
    if (!this.fluidFeasibility) return null;
    for (const source of required) {
      if (typeof source.getByteDensityProfile !== 'function') return null;
    }
    const rate = this.conservativeRateBytesPerMs();
    if (rate === null || !(rate > 0)) return null;

    // Floored at the window being evaluated so the fluid check never sees LESS
    // than the one-window path it replaces. The dataset end needs no clamp of
    // its own: the profile simply has no buckets past it.
    const horizonSimMs = Math.max(
      windowSimMs,
      this.fluidCheckHorizonWallMs * absSpeed,
    );
    const span =
      direction > 0
        ? { start: time, end: time + horizonSimMs }
        : { start: time - horizonSimMs, end: time };

    // One entry per bucket that still owes bytes: how far ahead of the playhead
    // the playhead ENTERS it (sim-ms), and what it costs.
    const deadlines: Array<{ distSimMs: number; bytes: number }> = [];
    for (let s = 0; s < required.length; s++) {
      const profile = required[s].getByteDensityProfile!(span);
      if (!profile) return null;
      const starts = profile.bucketStarts;
      const missing = profile.missingBytes;
      if (
        !Array.isArray(starts) ||
        !Array.isArray(missing) ||
        starts.length !== missing.length
      ) {
        return null;
      }
      for (let i = 0; i < starts.length; i++) {
        const bytes = missing[i];
        if (!Number.isFinite(bytes) || bytes <= 0) continue;
        // Travelling forward the playhead enters a bucket at its START;
        // travelling backward, at its RIGHT edge — which is the next bucket's
        // start (`bucketStarts` ascends), or the playhead itself for the last.
        const entry = direction > 0 ? starts[i] : (starts[i + 1] ?? span.end);
        if (!Number.isFinite(entry)) continue;
        deadlines.push({
          distSimMs: Math.max(0, direction > 0 ? entry - time : time - entry),
          bytes,
        });
      }
    }
    if (deadlines.length === 0) return true; // nothing missing anywhere ahead

    // Total order: nearest deadline first, ties broken by byte count so the
    // walk is independent of source registration order.
    deadlines.sort((a, b) =>
      a.distSimMs !== b.distSimMs
        ? a.distSimMs - b.distSimMs
        : a.bytes - b.bytes,
    );

    const runwayWallMs = Math.max(
      runway.simMs / absSpeed,
      PLAYTHROUGH_MIN_WALL_MS,
    );
    let cumulativeBytes = 0;
    for (const d of deadlines) {
      cumulativeBytes += d.bytes;
      const beyondRunwaySimMs = Math.max(0, d.distSimMs - runway.simMs);
      const budgetWallMs = runwayWallMs + beyondRunwaySimMs / absSpeed;
      if (cumulativeBytes > rate * budgetWallMs) return false;
    }
    return true;
  }

  /**
   * The quantile-style lower bound on the link rate the feasibility check
   * spends: `max(0, bytesPerMs − z·stdDev)`, or `null` when there is no
   * estimate at all.
   *
   * This is the same rule `@poopdeck.gl/core`'s `conservativeRateFromEstimate`
   * applies — restated rather than imported because this package has ZERO
   * runtime dependencies by design and only ever sees a {@link
   * ThroughputEstimate} across the `getThroughput()` boundary, never the
   * estimator itself. `null` in ⇒ `null` out; a producer with no `stdDev` reads
   * as 0 dispersion and therefore returns the point estimate unchanged.
   */
  private conservativeRateBytesPerMs(): number | null {
    const estimate = this.getThroughput?.();
    if (!estimate) return null;
    const point = estimate.bytesPerMs;
    if (point == null || !Number.isFinite(point)) return null;
    const stdDev =
      typeof estimate.stdDev === 'number' && Number.isFinite(estimate.stdDev)
        ? Math.max(0, estimate.stdDev)
        : 0;
    return Math.max(0, point - this.conservativeRateZ * stdDev);
  }

  /** The sim-time window the current (or a would-be) gate must cover. */
  private gateRange(): { start: number; end: number } {
    const speed = this.timeController.getSpeed();
    const factor = this.isGated() ? this.gateFactor : 1;
    const spanSimMs = Math.max(
      1,
      this.startGateWallMs * Math.abs(speed) * factor,
    );
    const time = this.timeController.getTime();
    return speed < 0
      ? { start: time - spanSimMs, end: time }
      : { start: time, end: time + spanSimMs };
  }

  private startEvalTimer(): void {
    if (this.evalTimer !== null) return;
    this.evalTimer = setInterval(() => this.evaluateNow(), EVAL_INTERVAL_MS);
  }

  private stopEvalTimer(): void {
    if (this.evalTimer === null) return;
    clearInterval(this.evalTimer);
    this.evalTimer = null;
  }

  /** Pause the clock without the playState subscription mistaking it for an external pause. */
  private pauseClock(): void {
    this.suppressPlayStateSync = true;
    try {
      this.timeController.pause();
    } finally {
      this.suppressPlayStateSync = false;
    }
  }

  /** Start the clock without the playState subscription re-entering evaluation. */
  private playClock(): void {
    this.suppressPlayStateSync = true;
    try {
      this.timeController.play();
    } finally {
      this.suppressPlayStateSync = false;
    }
  }
}

/** performance.now when available (browsers, vitest), Date.now otherwise. */
function nowWall(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * A source's DECLARED temporal bucket in sim-ms, or null (BH-4).
 *
 * Feature-detected, never assumed: a source without the method, one that
 * throws, and one that declares `0` (an archive whose `temporalBucketMs` was
 * never set) are all "undeclared" — which routes the lift band back to the
 * wall-ms default, never to a zero band.
 */
/**
 * Audit B8: a runway that ends at a permanent block is buffered for gating
 * purposes. `complete` already says "nothing to wait for"; the flag only
 * matters when it is NOT complete (a complete-and-blocked runway is just
 * complete, and is not counted as a block).
 */
function isBlockedForGating(runway: BufferedRunway): boolean {
  return runway.blockedPermanently === true && !runway.complete;
}

/**
 * Nearest-rank median of a sample list (no interpolation, so the figure is
 * always an observed value); null on no samples.
 */
function nearestRankMedian(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = samples.slice().sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length / 2) - 1];
}

function declaredBucketMs(source: BufferSource): number | null {
  const read = source.getTemporalBucketMs;
  if (typeof read !== 'function') return null;
  const bucketMs = read.call(source);
  return typeof bucketMs === 'number' &&
    Number.isFinite(bucketMs) &&
    bucketMs > 0
    ? bucketMs
    : null;
}

/** Option sanitiser: a finite POSITIVE number, else the documented default. */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/**
 * Option sanitiser: a finite NON-NEGATIVE number, else the documented default.
 * Distinct from {@link positiveOr} because `0` is a meaningful setting for the
 * two re-fit knobs — it pins the incumbent constant.
 */
function nonNegativeOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

/** Shape of a core `requests` probe sample, as far as byte windowing cares. */
interface RequestSampleLike {
  bytes?: unknown;
  completedAt?: unknown;
  dispatchedAt?: unknown;
}

/**
 * Sum bytes on the core `requests` probe channel whose request COMPLETED
 * inside `[fromWall, toWall]` — the byte attribution for a scrub bracket.
 *
 * Reads `globalThis.__sttProbe.requests` directly: `@poopdeck.gl/playback` has
 * zero runtime dependencies by design, so it cannot import
 * `@poopdeck.gl/core`'s telemetry module — but both packages write the ONE
 * shared probe bag, and both stamp `performance.now()`, so the window is
 * directly comparable. Returns 0 when the probe (or the channel) is absent,
 * and defensively ignores malformed samples: a diagnostic must never throw
 * into the drag path. Samples with `dispatchedAt === 0` never occupied a slot
 * (superseded while queued) and moved no bytes, so they are skipped.
 */
function sumRequestBytesInWindow(fromWall: number, toWall: number): number {
  const bag = (
    globalThis as unknown as { __sttProbe?: Record<string, unknown> }
  ).__sttProbe;
  if (!bag || bag.enabled === false) return 0;
  const samples = bag.requests;
  if (!Array.isArray(samples)) return 0;
  let total = 0;
  for (const raw of samples as RequestSampleLike[]) {
    if (!raw || typeof raw !== 'object') continue;
    const completedAt = raw.completedAt;
    const bytes = raw.bytes;
    if (typeof completedAt !== 'number' || typeof bytes !== 'number') continue;
    if (raw.dispatchedAt === 0) continue;
    if (completedAt < fromWall || completedAt > toWall) continue;
    total += bytes;
  }
  return total;
}

/**
 * Intersection of two sorted, non-overlapping range lists — the span both
 * sources have buffered (MSE `HTMLMediaElement.buffered` semantics, §2.1).
 * Inputs need not be pre-sorted; they are sorted defensively. O(n+m) after the
 * sort. Used to fold {@link PlaybackGovernor.getBufferedRanges} over the
 * required set.
 */
function intersectRanges(
  a: Array<{ start: number; end: number }>,
  b: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  if (a.length === 0 || b.length === 0) return [];
  const as = [...a].sort((x, y) => x.start - y.start);
  const bs = [...b].sort((x, y) => x.start - y.start);
  const out: Array<{ start: number; end: number }> = [];
  let i = 0;
  let j = 0;
  while (i < as.length && j < bs.length) {
    const start = Math.max(as[i].start, bs[j].start);
    const end = Math.min(as[i].end, bs[j].end);
    if (start < end) out.push({ start, end });
    // Advance whichever range ends first.
    if (as[i].end < bs[j].end) i++;
    else j++;
  }
  return out;
}

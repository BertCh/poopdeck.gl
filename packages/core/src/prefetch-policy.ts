// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * Prefetch policy: the decision surface for speculative (lookahead) tile
 * loading, separated from the machinery that performs the fetches.
 *
 * The policy owns four coupled state machines:
 *
 * - DIRECTION HYSTERESIS — the committed playback direction. A reversed time
 *   delta must persist before it flips; a signed speed declares it outright.
 * - PRESSURE LADDER — a scale in `[PRESSURE_SCALE_MIN, 1]` that shrinks the
 *   speculative horizon under cache thrash and recovers on a wall-clock timer.
 * - HORIZON — how far ahead of the play head to plan, under the bucket cap,
 *   the governor's run-ahead cap and the pressure scale.
 * - PACING — the consumed-runway throttle, the wall-clock debounce, and the
 *   supersession generation that drops a stale plan.
 *
 * It performs NO I/O: it never fetches, never touches a tile map, never
 * schedules a timer, and knows nothing about the archive. Callers hand it
 * measurements and act on what it returns. Wall time arrives through the
 * injected {@link Clock}, so the time-driven pressure recovery is exercisable
 * without real delays.
 */

/** Wall-clock source in ms. */
export type Clock = () => number;

/**
 * Number of consecutive frames a reversed time-delta must persist before the
 * prefetch direction actually flips. Prevents a single backward scrub frame
 * from inverting the prefetch direction (direction hysteresis).
 */
export const DIRECTION_FLIP_THRESHOLD = 3;

/**
 * How far ahead to prefetch during animation, expressed in REAL playback time
 * (ms). Converted to sim-time via the measured animation speed, so a fast scrub
 * (e.g. 43 years in 60 s) prefetches a large *contiguous* span of buckets that
 * coalesces into a few range requests. A fixed sim-time lookahead instead gets
 * outrun by a fast animation every frame, degenerating into a request per frame.
 */
export const PREFETCH_LOOKAHEAD_REAL_MS = 8000;

/**
 * Hard ceiling on the prefetch horizon, expressed in temporal buckets. At very
 * fast playback the horizon terms balloon in SIM time — a full year in 120 s
 * runs at ~2.6e5 sim-ms per real-ms, so `windowAhead` (prefetchAhead ×
 * prefetchSteps) reaches ~60 days and even the `speed × LOOKAHEAD` term reaches
 * ~24 days. Each prefetch pass then walks the directory over that whole slice
 * and sorts ~1-2k candidate tile ids ON THE MAIN THREAD, ~twice per second, per
 * tileset — an FPS sink. Bounding the horizon caps the per-pass walk+sort. Only
 * fast demos hit it; normal-speed playback stays well under the cap, and the
 * resident-window SELECTION (not prefetch) still loads cumulative
 * "draw-and-persist" datasets in full. NB the cap is NOT a pure constant: the
 * governor's buffered-runway gates are speed-scaled, so the applied cap is
 * `max(MAX_PREFETCH_BUCKETS × bucketMs, speed × PREFETCH_CAP_FLOOR_REAL_MS)`
 * — a fixed 64-bucket ceiling alone is BELOW the gates at fast playback
 * (year-in-120s with 2 h buckets consumes ~36.5 buckets/s; the resume gate
 * alone needs ~146 buckets), which would stall the gate it exists to feed.
 */
export const MAX_PREFETCH_BUCKETS = 64;

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
export const PREFETCH_CAP_FLOOR_REAL_MS = 5000;

/**
 * Re-issue the wide prefetch only after the play head has consumed this fraction
 * of the span the last pass planned. Keeps the debounced scheduler from
 * re-coalescing the same chunk ~4×/second; the wide load then happens roughly
 * once per `(1 - fraction) × LOOKAHEAD` of real time.
 */
export const PREFETCH_RELOAD_FRACTION = 0.5;

/**
 * Pressure-adaptive prefetch horizon (Shaka's "shrink the goal" ladder):
 * degrade the speculative lookahead under memory pressure instead of letting
 * the cache thrash. The self-regulation loop: a full cache forces the
 * over-limit eviction pass into the protected runway (a tier-C/D eviction —
 * the thrash signal, reported via {@link PrefetchPolicy.noteRunwayEviction}) →
 * the pressure scale decays by {@link PRESSURE_SCALE_DECAY} (floored at
 * {@link PRESSURE_SCALE_MIN}) → the next plan reaches ahead by a shorter
 * horizon and enqueues fewer speculative tiles → the cache drops back under its
 * limits → after {@link PRESSURE_RECOVERY_QUIET_MS} of wall-clock with no
 * runway eviction, the scale recovers by {@link PRESSURE_SCALE_RECOVERY_STEP}
 * back toward 1 — rate-limited to one step per
 * {@link PRESSURE_RECOVERY_STEP_INTERVAL_MS} of WALL time (recovery paced by
 * plan frequency instead rebounds floor→1 in ~2 s and oscillates). While
 * pressured (scale < 1) the scaled horizon is floored at
 * `max(bucketMs, timeWindow, speed × PREFETCH_CAP_FLOOR_REAL_MS)` so the
 * resident window keeps loading and the governor's speed-scaled gates stay
 * satisfiable — the ladder shrinks speculation, never the playhead's own
 * data. At scale 1 the ladder is a strict no-op (byte-identical horizon).
 */
export const PRESSURE_SCALE_MIN = 0.25;
export const PRESSURE_SCALE_DECAY = 0.7;
export const PRESSURE_SCALE_RECOVERY_STEP = 0.1;
export const PRESSURE_RECOVERY_QUIET_MS = 5000;
export const PRESSURE_RECOVERY_STEP_INTERVAL_MS = 1000;

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
export const PREFETCH_CACHE_FRACTION = 0.5;

/** Floor on the per-pass enqueue budget, whatever the cache budget scales to. */
export const PREFETCH_MIN_BUDGET_TILES = 64;

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
export const PREFETCH_SLICE_TARGET_REAL_MS = 1000;

/**
 * Slice-size floor: below this, coalescing degrades (byte-adjacent tiles get
 * split across slices for no scheduling benefit) and per-slice overhead
 * (planning pass + range-request RTTs) dominates on slow links.
 */
export const PREFETCH_SLICE_MIN_BYTES = 1 * 1024 * 1024;

/**
 * Slice-size ceiling: bounds the memory burst and the worst-case hostage
 * window on very fast links, where TARGET_REAL_MS alone would allow huge
 * slices.
 */
export const PREFETCH_SLICE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Slice size before the throughput estimator has a sample (cold start):
 * moderate, so the first slice both seeds the estimator and can't flood a
 * link that turns out to be slow.
 */
export const PREFETCH_SLICE_COLD_BYTES = 4 * 1024 * 1024;

/**
 * Wall-clock coalescing window for planning passes. Without it, every tick of
 * the time controller that crosses the tileset update threshold triggers a
 * full planning pass — building thousands of directory queries each time.
 */
export const PREFETCH_DEBOUNCE_MS = 250;

/** Everything one planning pass needs to know about the world. */
export interface PrefetchPlanRequest {
  /** Play-head sim-time (ms). */
  time: number;
  /** Resident time window (ms) centred on the play head. */
  timeWindow: number;
  /** Archive temporal bucket size (ms); 0 when the archive declares none. */
  bucketMs: number;
  /** Configured lookahead per step (ms); values ≤ 0 fall back to `timeWindow`. */
  prefetchAhead: number;
  /** Configured number of lookahead steps. */
  prefetchSteps: number;
  /**
   * True when neither queued nor in-flight prefetch work remains. An idle
   * pipeline bypasses the consumed-runway throttle: a pass is budget-capped,
   * so the span it claimed can exceed what it actually enqueued, and a play
   * head frozen by a buffering gate consumes nothing — the throttle would
   * never re-arm and loading would stop exactly when the gate waits for it.
   */
  pipelineIdle: boolean;
}

/** What one planning pass decided. */
export interface PrefetchPlan {
  /** Committed direction this plan was built for (+1 forward, -1 backward). */
  readonly direction: 1 | -1;
  /** Play-head sim-time the plan is anchored at. */
  readonly time: number;
  /** Horizon in sim-ms, after every cap and the pressure scale. */
  readonly effectiveAhead: number;
  /** Far edge of the planned span: `time + direction × effectiveAhead`. */
  readonly endTime: number;
  /**
   * Directory query range for the whole span, widened by half a window at
   * both edges so a bucket straddling either end still overlaps.
   */
  readonly queryRange: { start: number; end: number };
  /**
   * Sim-ms from the play head to `bucketStart` ALONG the plan's direction.
   * Buckets already behind the head yield a sentinel above every genuine
   * ahead-distance, so ordering candidates by this value sorts them last.
   */
  aheadDistance(bucketStart: number): number;
}

/** Outcome of an authoritative animation-state change. */
export interface PrefetchAnimationTransition {
  /** Whether the animation was already running before this call. */
  wasAnimating: boolean;
  /**
   * True when a signed speed committed a new direction. The planned span is
   * then behind the play head and the caller must flush it.
   */
  directionFlipped: boolean;
}

export class PrefetchPolicy {
  private readonly clock: Clock;

  /** Committed prefetch direction (+1 forward, -1 backward). */
  private committedDirection: 1 | -1 = 1;
  /** Consecutive observed deltas pointing against the committed direction. */
  private pendingFlipCount = 0;

  /** Estimated animation speed in sim-ms per real-ms, signed. */
  private speedSimPerReal = 0;
  private animating = false;

  /**
   * Interactive/motion bit: true while the user is actively scrubbing the
   * timeline. Playback state the policy tracks on the caller's behalf; the
   * horizon does not depend on it.
   */
  private interactiveBit = false;

  /** End of the last planned span in sim-time (the runway throttle anchor). */
  private lastPlannedEndTime?: number;

  /** Pressure-adaptive horizon scale in `[PRESSURE_SCALE_MIN, 1]`. */
  private pressure = 1;
  /**
   * Wall time of the last recovery step (rate-limits the ladder's rebound).
   * -Infinity so the first eligible step is never suppressed at epoch 0.
   */
  private lastPressureRecoveryAt = -Infinity;
  /** Wall time of the last tier-C/D (runway) eviction (0 = never). */
  private lastRunwayEvictionAt = 0;

  /** Governor-imposed forward run-ahead cap in sim-ms, `null` = uncapped. */
  private runAheadLimit: number | null = null;

  /** Monotonic stamp identifying the newest planning pass. */
  private generation = 0;
  /** Wall time the last planning pass was released (debounce anchor). */
  private lastRunAt = 0;

  constructor(clock: Clock = Date.now) {
    this.clock = clock;
  }

  // ── Playback state ────────────────────────────────────────────────────

  /** Committed prefetch direction (+1 forward, -1 backward). */
  get direction(): 1 | -1 {
    return this.committedDirection;
  }

  /** Most recent estimated animation speed (sim-ms per real-ms), signed. */
  get animationSpeed(): number {
    return this.speedSimPerReal;
  }

  get isAnimating(): boolean {
    return this.animating;
  }

  get isInteractive(): boolean {
    return this.interactiveBit;
  }

  /**
   * Feed one observed sim-time delta to the direction hysteresis. A delta
   * pointing against the committed direction must repeat
   * {@link DIRECTION_FLIP_THRESHOLD} times in a row to flip it, so a stray
   * backward scrub frame cannot invert (and invalidate) the runway.
   *
   * Returns true when the direction just flipped: the planned span is now
   * behind the play head and the caller must flush it.
   */
  observeTimeDelta(simTimeDelta: number): boolean {
    if (simTimeDelta === 0) return false; // No movement: keep current direction.

    const observed: 1 | -1 = simTimeDelta > 0 ? 1 : -1;
    if (observed === this.committedDirection) {
      this.pendingFlipCount = 0;
      return false;
    }

    this.pendingFlipCount++;
    if (this.pendingFlipCount < DIRECTION_FLIP_THRESHOLD) return false;
    this.committedDirection = observed;
    this.pendingFlipCount = 0;
    return true;
  }

  /**
   * Record the measured animation speed (sim-ms per real-ms) without touching
   * the direction hysteresis, which keys on the SIGN of individual deltas.
   */
  observeSpeed(speed: number): void {
    this.speedSimPerReal = speed;
  }

  /**
   * Apply an authoritative animation-state change.
   *
   * A signed speed is an AUTHORITATIVE direction signal (e.g. a ping-pong
   * controller reversing at a boundary), so it commits immediately and
   * bypasses the observed-delta hysteresis — that hysteresis exists to ignore
   * stray single-frame scrubs, not a known reversal. Without this, prefetch
   * keeps aiming the old way for a few frames after the reverse and the play
   * head loads into un-prefetched buckets reactively (a visible flash).
   */
  setAnimationState(
    isAnimating: boolean,
    speed: number,
  ): PrefetchAnimationTransition {
    const wasAnimating = this.animating;
    this.animating = isAnimating;
    this.speedSimPerReal = speed;

    let directionFlipped = false;
    if (speed !== 0) {
      const dir: 1 | -1 = speed > 0 ? 1 : -1;
      if (dir !== this.committedDirection) {
        this.committedDirection = dir;
        this.pendingFlipCount = 0;
        directionFlipped = true;
      }
    }
    return { wasAnimating, directionFlipped };
  }

  /** Store the interactive/motion bit. Returns true when the value changed. */
  setInteractive(interactive: boolean): boolean {
    if (this.interactiveBit === interactive) return false;
    this.interactiveBit = interactive;
    return true;
  }

  // ── Run-ahead cap ─────────────────────────────────────────────────────

  /**
   * Governor run-ahead fairness hook (the Shaka MAX_RUN_AHEAD analog): cap the
   * forward horizon to at most `simMs` of sim-time ahead of the play head. In
   * a composited scene, runway buffered beyond the min-gated intersection of
   * all required sources is dead weight; the governor caps each leader near
   * the neediest source's frontier so the shared bandwidth budget flows to the
   * laggard. Non-finite, non-positive and non-numeric values clear the cap.
   *
   * The cap carries an internal safety floor (see {@link plan}) so it can
   * never starve the source's own speed-scaled gates, and lowering it flushes
   * NOTHING — it only stops further extension.
   */
  setRunAheadLimit(simMs: number | null): void {
    this.runAheadLimit =
      typeof simMs === 'number' && Number.isFinite(simMs) && simMs > 0
        ? simMs
        : null;
  }

  /** Governor-imposed forward run-ahead cap in sim-ms, `null` = uncapped. */
  get runAheadLimitMs(): number | null {
    return this.runAheadLimit;
  }

  // ── Pressure ladder ───────────────────────────────────────────────────

  /** Current pressure-adaptive horizon scale in `[PRESSURE_SCALE_MIN, 1]`. */
  get pressureScale(): number {
    return this.pressure;
  }

  /**
   * Report that the over-limit eviction pass had to reach INTO the protected
   * playhead runway — the fetch-evict-refetch thrash signal. Shrinks the
   * speculative horizon one rung down the ladder and restarts the quiet
   * period the recovery in {@link plan} waits out.
   */
  noteRunwayEviction(): void {
    this.pressure = Math.max(
      PRESSURE_SCALE_MIN,
      this.pressure * PRESSURE_SCALE_DECAY,
    );
    this.lastRunwayEvictionAt = this.clock();
  }

  // ── Pacing ────────────────────────────────────────────────────────────

  /**
   * Wall-ms the caller must wait before releasing the next planning pass;
   * 0 means "run now". Coalesces the per-tick planning storm during fast
   * playback into one pass per {@link PREFETCH_DEBOUNCE_MS}.
   */
  msUntilNextRun(): number {
    return Math.max(0, PREFETCH_DEBOUNCE_MS - (this.clock() - this.lastRunAt));
  }

  /** Stamp a planning pass as released, re-arming the debounce window. */
  markRunStarted(): void {
    this.lastRunAt = this.clock();
  }

  /**
   * Drop the debounce window so the next pass runs immediately. An explicit
   * configuration change must not have to wait out a coalescing window meant
   * for the playback clock.
   */
  clearDebounce(): void {
    this.lastRunAt = 0;
  }

  // ── Supersession ──────────────────────────────────────────────────────

  /**
   * Open a planning pass and return its stamp. The caller re-checks the stamp
   * with {@link isCurrentPass} after every await, so a plan that lost the race
   * against a newer pass — or against {@link invalidatePlan} — is dropped
   * instead of enqueuing tiles for a stale playhead or direction.
   */
  beginPass(): number {
    return ++this.generation;
  }

  isCurrentPass(pass: number): boolean {
    return pass === this.generation;
  }

  /**
   * Abandon the planned span: supersede any pass still in flight and clear the
   * runway anchor so the next pass re-plans immediately. Called on a seek, a
   * spatial move, a direction flip, or a horizon-affecting option change.
   */
  invalidatePlan(): void {
    this.generation++;
    this.lastPlannedEndTime = undefined;
  }

  // ── Planning ──────────────────────────────────────────────────────────

  /**
   * Decide the next prefetch horizon, or `null` when the play head still has
   * enough already-planned runway ahead of it that another pass is wasted work.
   *
   * A non-null result CLAIMS the span: the runway anchor moves to
   * `plan.endTime` so the throttle measures against it. When the enqueue is cut
   * short by {@link enqueueBudget}, the caller must re-anchor with
   * {@link anchorTruncatedRunway} so the next pass re-plans at the real
   * frontier rather than a span nobody fetched.
   *
   * The pressure-recovery step runs on every call, including calls that return
   * `null` — recovery is paced by wall time, not by how often a pass survives
   * the throttle.
   */
  plan(request: PrefetchPlanRequest): PrefetchPlan | null {
    const {
      time,
      timeWindow,
      bucketMs,
      prefetchAhead,
      prefetchSteps,
      pipelineIdle,
    } = request;

    const direction = this.committedDirection;
    const speed = Math.abs(this.speedSimPerReal);
    const now = this.clock();

    // During a running animation, cover a fixed slice of REAL playback time
    // (speed × LOOKAHEAD) so a fast scrub plans one big contiguous chunk that
    // coalesces into a few range requests. The configured window-based
    // lookahead is the floor, so a stationary view (speed ≈ 0) still warms its
    // immediate neighbourhood.
    const windowAhead =
      (prefetchAhead > 0 ? prefetchAhead : timeWindow) * prefetchSteps;
    let effectiveAhead = Math.max(
      windowAhead,
      speed * PREFETCH_LOOKAHEAD_REAL_MS,
    );

    // Bucket cap (see MAX_PREFETCH_BUCKETS) so a fast playback can't inflate
    // the horizon to tens of days — every pass would then walk+sort the
    // directory over that whole slice on the main thread. The speed-scaled
    // floor keeps the cap from undercutting the governor's speed-scaled
    // buffered-runway gates at very fast playback.
    if (bucketMs > 0) {
      effectiveAhead = Math.min(
        effectiveAhead,
        Math.max(
          MAX_PREFETCH_BUCKETS * bucketMs,
          speed * PREFETCH_CAP_FLOOR_REAL_MS,
        ),
      );
    }

    // Governor run-ahead fairness cap. The internal safety floor keeps a
    // cooperating-but-misjudged cap from starving this source's own
    // speed-scaled gates: the horizon never drops below the resident window
    // nor below what those wall-clock gates consume at the current speed.
    if (this.runAheadLimit !== null) {
      effectiveAhead = Math.min(
        effectiveAhead,
        Math.max(
          this.runAheadLimit,
          bucketMs,
          timeWindow,
          speed * PREFETCH_CAP_FLOOR_REAL_MS,
        ),
      );
    }

    // Pressure ladder: recover the scale when no runway eviction happened
    // recently, at most one step per PRESSURE_RECOVERY_STEP_INTERVAL_MS of
    // WALL time — not per plan, because plans fire every ~250 ms during
    // playback, which rebounds the scale from floor to 1 in ~2 s and
    // oscillates fetch→evict indefinitely under sustained pressure.
    if (
      this.pressure < 1 &&
      now - this.lastRunwayEvictionAt >= PRESSURE_RECOVERY_QUIET_MS &&
      now - this.lastPressureRecoveryAt >= PRESSURE_RECOVERY_STEP_INTERVAL_MS
    ) {
      this.pressure = Math.min(1, this.pressure + PRESSURE_SCALE_RECOVERY_STEP);
      this.lastPressureRecoveryAt = now;
    }
    // The scale applies AFTER every cap, so pressure always shrinks the final
    // horizon. At scale 1 the branch is skipped entirely — the un-pressured
    // horizon must stay byte-identical to a ladder-free one, so no floor here
    // may RAISE it. Under pressure the floor keeps the resident window loading
    // and — same sizing as the run-ahead cap above — never shrinks below what
    // the governor's speed-scaled wall-clock gates consume, so a decay step
    // can't turn a recoverable stall into the maxStartWaitMs escape hatch at
    // high sim-speed.
    if (this.pressure < 1) {
      effectiveAhead = Math.max(
        effectiveAhead * this.pressure,
        bucketMs,
        timeWindow,
        speed * PREFETCH_CAP_FLOOR_REAL_MS,
      );
    }

    const endTime = time + direction * effectiveAhead;

    // Throttle on the remaining planned runway: skip the pass while the play
    // head still has more than (1 − fraction) × horizon of already-planned
    // span ahead of it. This re-issues when the head has consumed ~half the
    // span, AND whenever the span GROWS (e.g. the animation speeds up, so the
    // last claim falls short) — anchoring the throttle on the claim's START
    // time instead suppresses that case and leaves playback to drip per-frame.
    if (this.lastPlannedEndTime !== undefined && !pipelineIdle) {
      const runway = direction * (this.lastPlannedEndTime - time);
      if (runway > effectiveAhead * (1 - PREFETCH_RELOAD_FRACTION)) return null;
    }
    this.lastPlannedEndTime = endTime;

    // One query covering the whole span. Enumerating every bucket boundary
    // instead costs O(buckets × zoomLevels) directory calls for the SAME tile
    // ids (availability already filters by interval overlap) — for a large
    // span with small buckets that dominates the main thread.
    const nearEdge = direction > 0 ? time : endTime;
    const farEdge = direction > 0 ? endTime : time;

    return {
      direction,
      time,
      effectiveAhead,
      endTime,
      queryRange: {
        start: nearEdge - timeWindow / 2,
        end: farEdge + timeWindow / 2,
      },
      aheadDistance(bucketStart: number): number {
        const d = direction > 0 ? bucketStart - time : time - bucketStart;
        return d >= 0 ? d : Number.MAX_SAFE_INTEGER + d; // behind-head last
      },
    };
  }

  /**
   * Ceiling on how many tiles one pass may enqueue: a fraction of the tile-count
   * cache budget, never below {@link PREFETCH_MIN_BUDGET_TILES}. Bounding the
   * runway this way keeps it RESIDENT — an enqueue larger than the LRU is
   * evicted before the play head arrives and re-fetched one tile at a time.
   */
  enqueueBudget(maxCacheSize: number): number {
    return Math.max(
      PREFETCH_MIN_BUDGET_TILES,
      Math.floor(maxCacheSize * PREFETCH_CACHE_FRACTION),
    );
  }

  /**
   * Re-anchor the runway throttle after a budget-truncated pass:
   * `plan.endTime` claimed the FULL span, but the enqueue stopped at the
   * budget. Anchoring at the furthest bucket actually planned makes the
   * next pass re-plan when the head nears the REAL frontier instead of
   * trusting a span nobody fetched. A no-op once a concurrent flush or flip
   * has already moved the anchor — only this pass's own claim gets corrected.
   *
   * @param coveredAheadMs Furthest ahead-of-head distance actually enqueued.
   * @param bucketMs       One bucket of slack, so the frontier bucket itself
   *                       counts as covered.
   */
  anchorTruncatedRunway(
    plan: PrefetchPlan,
    coveredAheadMs: number,
    bucketMs: number,
  ): void {
    if (this.lastPlannedEndTime !== plan.endTime) return;
    this.lastPlannedEndTime =
      plan.time + plan.direction * (coveredAheadMs + bucketMs);
  }

  /**
   * Byte budget for the next prefetch slice: ≈ PREFETCH_SLICE_TARGET_REAL_MS
   * of download at the measured throughput, clamped to [MIN, MAX]; a fixed
   * cold-start size until the estimator has a sample. Sizing by TIME (not a
   * fixed byte count) keeps the hostage window — how long a play head that
   * catches the slice must wait for it — roughly constant across link speeds.
   *
   * @param bytesPerMs Measured throughput, or `null` when unmeasured.
   */
  sliceBytes(bytesPerMs: number | null): number {
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
}

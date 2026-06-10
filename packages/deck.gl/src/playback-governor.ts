// @stt/deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/deck.gl contributors

/**
 * PlaybackGovernor — the buffering state machine between user intent and the
 * {@link TimeController}.
 *
 * The TimeController stays a dumb wall-clock × speed rAF clock; this governor
 * wraps it and supplies the coupling video players have and data players
 * historically lacked: it gates `play()` on a buffered runway ahead of the
 * playhead, freezes the clock (instead of advancing into unloaded time) when
 * the runway drains, applies resume hysteresis so stall/resume never
 * oscillates, and turns seeks/scrubs into preview-vs-commit operations with a
 * post-seek gate. See docs/roadmap/player-buffering.md for the full rationale
 * and the SOTA survey behind the default thresholds.
 *
 * All thresholds are denominated in WALL-clock milliseconds × current |speed|,
 * because playback speed multiplies the data-consumption rate: 2 s of runway
 * at 1× is 2 sim-seconds; at a 65-sim-days-per-real-second drifter sweep it is
 * ~130 sim-days. A speed change is therefore a re-plan event.
 */

import { TimeController } from './time-controller';

/**
 * Snapshot of the contiguous loaded span ahead of the playhead, as reported
 * by the core tileset's coverage index (WS-A of the player-buffering plan).
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
}

/**
 * Structural readiness/cost oracle the governor consumes. `@stt/core`'s
 * `SpatiotemporalTileset` satisfies this interface; defining it here keeps the
 * governor decoupled from core (it never imports tileset types) and lets tests
 * drive it with a plain object.
 */
export interface BufferSource {
  getBufferedRunway(time: number, direction: 1 | -1, horizonSimMs?: number): BufferedRunway;
  getBufferedRanges(opts?: { maxRanges?: number }): Array<{ start: number; end: number }>;
  estimateCost(range: { start: number; end: number }): { bytes: number; tiles: number };
  estimateTimeToReadyMs(range: { start: number; end: number }): number | null;
  flushPrefetch(): void;
  /**
   * Optional (the core tileset has it): keep the loader's prefetch machinery
   * running at the given signed speed. The governor asserts this while a gate
   * holds the clock frozen — without it, freezing the clock reads as "paused"
   * to the loader, prefetch stops reaching ahead, and the gate can never fill
   * its own runway (a stall deadlock that only the escape hatch breaks).
   */
  setAnimationState?(isAnimating: boolean, speed?: number): void;
}

/** Network throughput estimate (archive dual-EWMA, see WS-A5). */
export interface ThroughputEstimate {
  bytesPerMs: number | null;
  samples?: number;
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
export type PlaybackGovernorState = 'idle' | 'starting' | 'playing' | 'buffering' | 'seeking';

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
};

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
/** Auto-speed lookahead: cost of the next N wall-seconds at current speed. */
const AUTO_SPEED_HORIZON_WALL_MS = 8000;
/** Auto-speed safety factor (rise cautiously — same spirit as ABR's 0.7×). */
const AUTO_SPEED_SAFETY = 0.7;
/**
 * Floor for the canplaythrough predictor: when the missing remainder of a
 * gate/watermark window is predicted to download within this wall time, treat
 * it as ready even with zero buffered runway (a cold seek on a fast network
 * must start instantly, not wait for a speed-scaled runway that can be huge
 * at high sim-speeds).
 */
const PLAYTHROUGH_MIN_WALL_MS = 250;

export class PlaybackGovernor {
  /** Exposed so scrubbing UIs can share the settle knob (see options). */
  readonly seekSettleMs: number;

  private readonly timeController: TimeController;
  private readonly startGateWallMs: number;
  private readonly lowWatermarkWallMs: number;
  private readonly resumeFactor: number;
  private readonly maxStartWaitMs: number;
  private readonly getThroughput: (() => ThroughputEstimate) | null;

  private source: BufferSource | null = null;
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
  private evalTimer: ReturnType<typeof setInterval> | null = null;
  private scrubbing = false;
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
  };

  /**
   * Keeps the governor's model in sync with the clock when something else
   * touches it: an external `pause()` (e.g. the clock clamped at a non-looping
   * range end, or legacy code pausing directly) drops user intent; a speed
   * change (which fires playState while playing) is a re-plan event.
   */
  private readonly playStateHandler = (playing: boolean, _speed: number): void => {
    if (this.suppressPlayStateSync || this.disposed) return;
    if (!playing && this._state === 'playing' && this.userWantsPlayback) {
      // External pause — honor it as user intent so we don't resurrect playback.
      this.userWantsPlayback = false;
      this.stopEvalTimer();
      this.setState('idle');
      return;
    }
    if (playing && this._state === 'idle' && !this.userWantsPlayback) {
      // External play (legacy direct timeController.play()) — adopt it.
      this.userWantsPlayback = true;
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
   */
  private readonly tickHandler = (time: number): void => {
    if (this.disposed || this.suppressTickClamp || this.scrubbing) return;
    if (this._state !== 'playing' || !this.userWantsPlayback) return;
    if (!this.timeController.isPlaying()) return;
    if (!this.source) return;
    const speed = this.timeController.getSpeed();
    if (speed === 0) return;
    const direction: 1 | -1 = speed < 0 ? -1 : 1;

    if (
      this.bufferedUntil === null ||
      direction !== this.frontierDirection ||
      nowWall() - this.lastFrontierProbeWall >= TICK_PROBE_INTERVAL_MS
    ) {
      this.refreshFrontier();
      if (!this.degradedCreep) this.checkLowWatermark();
      if (this._state !== 'playing') return; // the watermark gated; clock frozen
    }

    const frontier = this.bufferedUntil;
    if (frontier === null || !Number.isFinite(frontier)) return;
    const overrunSimMs = direction > 0 ? time - frontier : frontier - time;
    if (overrunSimMs <= 0) return;
    if (overrunSimMs > Math.abs(speed) * CLAMP_MAX_OVERRUN_REAL_MS) {
      // Far past the frontier in one step: an external seek, not playback —
      // never snap a seek back. Invalidate and let the next tick re-probe.
      this.bufferedUntil = null;
      return;
    }
    this.setClockTime(frontier);
    if (!this.degradedCreep) {
      this.enterGate('buffering', this.resumeFactor);
    }
  };

  constructor(timeController: TimeController, opts: PlaybackGovernorOptions = {}) {
    this.timeController = timeController;
    this.startGateWallMs = opts.startGateWallMs ?? 2000;
    this.lowWatermarkWallMs = opts.lowWatermarkWallMs ?? 600;
    this.resumeFactor = opts.resumeFactor ?? 2;
    this.seekSettleMs = opts.seekSettleMs ?? 200;
    this.maxStartWaitMs = opts.maxStartWaitMs ?? 8000;
    this.getThroughput = opts.getThroughput ?? null;
    if (opts.source) this.setSource(opts.source);

    this.timeController.on('playState', this.playStateHandler);
    this.timeController.on('tick', this.tickHandler);
  }

  /** Current machine state. */
  get state(): PlaybackGovernorState {
    return this._state;
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

  /** Register an event listener. */
  on<K extends GovernorEventName>(event: K, callback: GovernorEventMap[K]): void {
    this.listeners[event].add(callback);
  }

  /** Unregister an event listener. */
  off<K extends GovernorEventName>(event: K, callback: GovernorEventMap[K]): void {
    this.listeners[event].delete(callback);
  }

  /**
   * Attach (or replace) the readiness oracle. The tileset arrives async in
   * real apps, so the governor may sit in 'starting' with no source — it then
   * either passes the gate the moment the source proves readiness, or starts
   * degraded after `maxStartWaitMs`.
   *
   * Sources missing the buffering API (a core build that predates WS-A) are
   * treated as absent so gating degrades to the escape hatch instead of
   * throwing at runtime.
   */
  setSource(source: BufferSource | null): void {
    if (source && typeof (source as Partial<BufferSource>).getBufferedRunway !== 'function') {
      // eslint-disable-next-line no-console
      console.warn(
        '[PlaybackGovernor] source lacks the buffering API (getBufferedRunway); ' +
          'gating degrades to the maxStartWaitMs escape hatch.',
      );
      source = null;
    }
    this.source = source;
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
    this.degradedCreep = false;
    this.pauseClock();
    // A real pause (unlike a gate) should drop the loader back to its paused
    // budget — undo any animating-at-speed assertion a gate made.
    this.source?.setAnimationState?.(false, 0);
    this.setState('idle');
  }

  /**
   * The scrubber was grabbed. Freezes the clock for a stable preview; no
   * state change and no fetch churn — every position until
   * {@link endScrub} is preview-only.
   */
  beginScrub(): void {
    if (this.rejectDisposedUse()) return;
    this.scrubbing = true;
    this.pauseClock();
  }

  /**
   * Preview a scrub position: move the clock (so resident tiles render at the
   * new time) WITHOUT committing a seek — no tileset update storm, no fetches.
   */
  scrubTo(time: number): void {
    if (this.rejectDisposedUse()) return;
    this.timeController.setTime(time);
  }

  /** The scrubber was released — commit the final position as a real seek. */
  endScrub(time: number): void {
    if (this.rejectDisposedUse()) return;
    this.scrubbing = false;
    this.commitSeek(time);
  }

  /** Programmatic committed seek (keyboard arrows, jump-to-start, story beats). */
  seekTo(time: number): void {
    if (this.rejectDisposedUse()) return;
    this.commitSeek(time);
  }

  /**
   * Consumer-forwarded buffer event (layer `onBufferChange` → here). Triggers
   * an immediate gate/stall evaluation in addition to the 250 ms cadence.
   */
  notifyBufferChange(runway: BufferedRunway): void {
    if (this.disposed) return;
    this.emit('progress', runway);
    this.evaluateNow();
  }

  /**
   * Honest ETA (wall-ms) until the current gate window is ready, from the
   * source's directory cost math ÷ measured throughput. Null when unknown.
   */
  getEtaMs(): number | null {
    if (!this.source) return null;
    return this.source.estimateTimeToReadyMs(this.gateRange());
  }

  /** Loaded time ranges for a buffered-range bar (passthrough; [] without a source). */
  getBufferedRanges(opts?: { maxRanges?: number }): Array<{ start: number; end: number }> {
    return this.source?.getBufferedRanges(opts) ?? [];
  }

  /**
   * Opt-in "Auto" speed (WS-D): the maximum sustainable playback speed
   * (TimeController units — sim-ms per wall-ms) the measured network can
   * feed, derived from the byte cost of the upcoming horizon:
   *
   *   bytesPerSimMs = cost(next 8 wall-s at current speed) / horizonSimMs
   *   maxSustainable = throughputBytesPerMs / bytesPerSimMs × 0.7
   *
   * Returns null when cost or throughput is unknown — including when the
   * upcoming horizon costs zero bytes (everything buffered ⇒ no cap needed).
   * Consumers apply their own snapping/clamping/hysteresis; the governor only
   * does the honest math.
   */
  getAutoSpeedSuggestion(): number | null {
    if (!this.source) return null;
    const speed = this.timeController.getSpeed();
    const absSpeed = Math.abs(speed);
    if (absSpeed <= 0) return null;

    const horizonSimMs = AUTO_SPEED_HORIZON_WALL_MS * absSpeed;
    const time = this.timeController.getTime();
    const range =
      speed < 0
        ? { start: time - horizonSimMs, end: time }
        : { start: time, end: time + horizonSimMs };

    const cost = this.source.estimateCost(range);
    if (!cost || cost.bytes <= 0) return null; // fully buffered ahead — no cap

    let bytesPerMs: number | null = null;
    const throughput = this.getThroughput?.();
    if (throughput && throughput.bytesPerMs != null && throughput.bytesPerMs > 0) {
      bytesPerMs = throughput.bytesPerMs;
    } else {
      // No direct estimator wired — imply one from the source's own honest
      // ETA (core computes it with the archive-wired estimator anyway).
      const etaMs = this.source.estimateTimeToReadyMs(range);
      if (etaMs != null && etaMs > 0) bytesPerMs = cost.bytes / etaMs;
    }
    if (bytesPerMs == null || bytesPerMs <= 0) return null;

    const bytesPerSimMs = cost.bytes / horizonSimMs;
    return (bytesPerMs / bytesPerSimMs) * AUTO_SPEED_SAFETY;
  }

  /** Detach from the TimeController and stop all timers. The clock is left as-is. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopEvalTimer();
    this.timeController.off('playState', this.playStateHandler);
    this.timeController.off('tick', this.tickHandler);
    this.listeners.statechange.clear();
    this.listeners.waiting.clear();
    this.listeners.ready.clear();
    this.listeners.progress.clear();
    this.source = null;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

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
    this._state = next;
    this.emit('statechange', next);
  }

  private isGated(): boolean {
    return this._state === 'starting' || this._state === 'buffering' || this._state === 'seeking';
  }

  /**
   * Commit path for every real seek: flush stale prefetch (so the new window
   * doesn't compete with old lookahead for the request pool), move the clock,
   * then re-gate at the plain (startup-sized) gate if intent is playing.
   */
  private commitSeek(time: number): void {
    this.source?.flushPrefetch();
    // Freeze the clock BEFORE moving it: with a running clock the seek target
    // would tick forward (and hit the frontier clamp) for a frame before the
    // gate takes over. A seek also invalidates the frontier and any creep.
    this.pauseClock();
    this.bufferedUntil = null;
    this.degradedCreep = false;
    this.timeController.setTime(time);
    if (this.userWantsPlayback) {
      this.enterGate('seeking', 1);
    } else {
      this.stopEvalTimer();
      this.setState('idle');
    }
  }

  private enterGate(state: 'starting' | 'buffering' | 'seeking', factor: number): void {
    this.gateFactor = factor;
    this.gateStartedAtWall = nowWall();
    this.pauseClock();
    // Freezing the clock makes the layer report "paused" to the loader, which
    // would shut down ahead-of-playhead prefetch — the very thing that must
    // fill this gate. Re-assert animating-at-target-speed so the loader keeps
    // reaching ahead while we wait (the stall deadlock fix; see BufferSource).
    this.source?.setAnimationState?.(true, this.timeController.getSpeed());
    this.setState(state);
    this.emit('waiting', { state, etaMs: this.getEtaMs() });
    // Evaluate once immediately (the gate may already be satisfied — e.g. a
    // backward seek into cached time); otherwise poll at the gated cadence.
    if (!this.evaluateGate()) {
      this.startEvalTimer();
    }
  }

  /** Immediate re-evaluation: gate check while gated, stall check while playing. */
  private evaluateNow(): void {
    if (this.disposed) return;
    if (this.isGated()) {
      this.evaluateGate();
    } else if (this._state === 'playing' && !this.scrubbing) {
      // Keep the frontier fresh on every buffer/speed event too (not just the
      // throttled tick path) — it also re-arms normal stalling after a
      // degraded creep once the runway recovers.
      this.refreshFrontier();
      if (!this.degradedCreep) this.checkLowWatermark();
    }
  }

  /**
   * Can the current gate open? Passes when the runway covers
   * `startGateWallMs × |speed| × gateFactor`, when the runway is complete
   * (dataset end / everything loaded), or — degraded — when the gate has been
   * held for `maxStartWaitMs`.
   */
  private evaluateGate(): boolean {
    if (!this.userWantsPlayback) {
      // Intent evaporated while gated (requestPause already handled state;
      // this is pure defense).
      this.stopEvalTimer();
      this.setState('idle');
      return false;
    }

    const speed = this.timeController.getSpeed();
    const absSpeed = Math.abs(speed);
    const requiredSimMs = this.startGateWallMs * absSpeed * this.gateFactor;

    let passed = false;
    let degraded = false;
    if (requiredSimMs <= 0) {
      // Zero speed consumes no data — nothing to gate on.
      passed = true;
    } else if (this.source) {
      const direction: 1 | -1 = speed < 0 ? -1 : 1;
      const time = this.timeController.getTime();
      const runway = this.source.getBufferedRunway(time, direction, requiredSimMs);
      passed = runway.complete || runway.simMs >= requiredSimMs;
      if (!passed) {
        // canplaythrough-style predictor (HAVE_ENOUGH_DATA): start when the
        // MISSING remainder of the gate window is predicted to download in
        // less wall time than the already-buffered runway plays out (with a
        // small floor so an instant network passes a cold gate). Without
        // this, gates scale linearly with |speed| and a 10× sweep can demand
        // sim-years of runway that no loader is meant to hold up front.
        passed = this.predictsPlaythrough(time, direction, requiredSimMs, runway, absSpeed);
      }
    }
    if (!passed && nowWall() - this.gateStartedAtWall >= this.maxStartWaitMs) {
      // Escape hatch — never hard-lock playback on a broken network.
      passed = true;
      degraded = true;
    }
    if (!passed) return false;

    this.stopEvalTimer();
    // The gate filled (or the hatch fired) — the pre-gate frontier is stale,
    // and trusting it would clamp the freshly-resumed playback straight back.
    // Null it; the first tick re-probes.
    this.bufferedUntil = null;
    this.lastFrontierProbeWall = 0;
    // An escape-hatch pass means the runway could NOT fill: switch to creep
    // (pin at the frontier, no re-gating) instead of letting the next buffer
    // event re-enter 'buffering' for another maxStartWaitMs freeze. An honest
    // pass always clears creep.
    this.degradedCreep = degraded;
    this.setState('playing');
    this.playClock();
    this.emit('ready', { degraded });
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
    if (!this.source || speed === 0) {
      this.bufferedUntil = null;
      return;
    }
    const direction: 1 | -1 = speed < 0 ? -1 : 1;
    const time = this.timeController.getTime();
    const runway = this.source.getBufferedRunway(time, direction);
    this.frontierDirection = direction;
    this.bufferedUntil = runway.complete
      ? direction * Infinity
      : time + direction * runway.simMs;
    if (this.degradedCreep) {
      const required =
        this.startGateWallMs * Math.abs(speed) * this.resumeFactor;
      if (runway.complete || runway.simMs >= required) {
        this.degradedCreep = false;
      }
    }
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
    if (!this.source || !this.userWantsPlayback) return;
    const speed = this.timeController.getSpeed();
    const absSpeed = Math.abs(speed);
    if (absSpeed <= 0) return;

    const watermarkSimMs = this.lowWatermarkWallMs * absSpeed;
    const direction: 1 | -1 = speed < 0 ? -1 : 1;
    const time = this.timeController.getTime();
    const runway = this.source.getBufferedRunway(time, direction, watermarkSimMs);
    if (!runway.complete && runway.simMs < watermarkSimMs) {
      // Same canplaythrough predictor as the gate: don't stall when the
      // loader is predicted to outrun consumption — a thin runway on a fast
      // network is fine; a thin runway on a slow one is an imminent dry-out.
      if (this.predictsPlaythrough(time, direction, watermarkSimMs, runway, absSpeed)) return;
      this.enterGate('buffering', this.resumeFactor);
    }
  }

  /**
   * HAVE_ENOUGH_DATA predictor: true when the needed-but-missing bytes inside
   * `windowSimMs` ahead of `time` are estimated to download within the wall
   * time the buffered runway already buys (floored at
   * {@link PLAYTHROUGH_MIN_WALL_MS} so instant networks pass cold gates).
   * Conservative when blind: returns false while the throughput estimator has
   * no samples yet.
   */
  private predictsPlaythrough(
    time: number,
    direction: 1 | -1,
    windowSimMs: number,
    runway: BufferedRunway,
    absSpeed: number,
  ): boolean {
    if (!this.source || absSpeed <= 0) return false;
    const window =
      direction > 0
        ? { start: time, end: time + windowSimMs }
        : { start: time - windowSimMs, end: time };
    const etaMs = this.source.estimateTimeToReadyMs(window);
    if (etaMs == null) return false;
    const runwayWallMs = runway.simMs / absSpeed;
    return etaMs <= Math.max(runwayWallMs, PLAYTHROUGH_MIN_WALL_MS);
  }

  /** The sim-time window the current (or a would-be) gate must cover. */
  private gateRange(): { start: number; end: number } {
    const speed = this.timeController.getSpeed();
    const factor = this.isGated() ? this.gateFactor : 1;
    const spanSimMs = Math.max(1, this.startGateWallMs * Math.abs(speed) * factor);
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

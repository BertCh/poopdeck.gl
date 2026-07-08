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
 * the runway drains, applies resume hysteresis so stall/resume never
 * oscillates, and turns seeks/scrubs into preview-vs-commit operations with a
 * post-seek gate. See docs/roadmap/playback-and-loading.md for the full rationale
 * and the SOTA survey behind the default thresholds.
 *
 * All thresholds are denominated in WALL-clock milliseconds × current |speed|,
 * because playback speed multiplies the data-consumption rate: 2 s of runway
 * at 1× is 2 sim-seconds; at a 65-sim-days-per-real-second drifter sweep it is
 * ~130 sim-days. A speed change is therefore a re-plan event.
 */

import { TimeController } from './time-controller.js';
import { emit as emitProbe } from './telemetry.js';

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
}

/**
 * Structural readiness/cost oracle the governor consumes. `@poopdeck.gl/core`'s
 * `SpatiotemporalTileset` satisfies this interface; defining it here keeps the
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
   * PlaybackGovernor.endScrub} (scrub-LOD P0, docs/roadmap/scrub-lod-2026-07.md).
   * A loader MAY serve a cheaper preview tier while it is held (coarser
   * spatial zoom and/or a coarser temporal-LOD bucket) and MUST restore its
   * settle tier when it clears. Preview-only by contract: readiness
   * reporting ({@link getBufferedRunway} et al.) stays honest about the fine
   * tier, so gates on release re-arm against full detail.
   */
  setInteractive?(interactive: boolean): void;
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
   * @default 200
   */
  runwayToleranceMs?: number;
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
  /** Cadence tolerance in WALL-ms; scaled by |speed| per evaluation. See options. */
  private readonly runwayToleranceMs: number;

  /**
   * The classified source registry (Phase 0 of multi-source coordination).
   * Replaces the historical single `source`. Each entry carries a `required`
   * flag (gates the clock) and a `weight` (Phase 2 bandwidth-share hint, not
   * yet consumed here). The clock's combined buffer health is folded over the
   * REQUIRED subset only — `min` runway, `AND` complete, nearest frontier —
   * while side-effects (prefetch keep-alive, flush) broadcast to ALL sources.
   * See docs/roadmap/playback-and-loading.md §5–6.
   */
  private sources = new Map<
    string,
    { source: BufferSource; required: boolean; weight: number }
  >();
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
  /** Wall timestamp the current 'buffering' state was entered. */
  private stallEnteredAtWall = 0;
  /** Wall timestamp the current degraded creep began. */
  private creepStartedAtWall = 0;
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
      this.userWantsPlayback = false;
      this.stopEvalTimer();
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
   */
  private readonly tickHandler = (time: number): void => {
    if (this.disposed || this.suppressTickClamp || this.scrubbing) return;
    if (this._state !== 'playing' || !this.userWantsPlayback) return;
    if (!this.timeController.isPlaying()) return;
    if (!this.hasAnySource()) return;
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
    // The frontier is stale after a wrap regardless of machine state.
    this.bufferedUntil = null;
    if (this._state !== 'playing' || !this.userWantsPlayback) return;
    for (const source of this.allSources()) source.flushPrefetch();
    this.setDegradedCreep(false);
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
      return;
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
    source.setInteractive?.(this.scrubbing);
    this.evaluateNow();
  }

  /** Remove a source from the registry by id (no-op if absent). */
  removeSource(id: string): void {
    // A source dropped mid-drag would otherwise keep interactive=true
    // forever — endScrub's clearing broadcast only reaches sources still
    // registered. Clear the bit on its way out.
    if (this.scrubbing) this.sources.get(id)?.source.setInteractive?.(false);
    this.sources.delete(id);
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
      for (const s of this.allSources()) s.setInteractive?.(false);
    }
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
    for (const source of this.allSources()) source.setInteractive?.(true);
    this.emit('scrubstart', this.timeController.getTime());
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
    const wasScrubbing = this.scrubbing;
    this.scrubbing = false;
    if (wasScrubbing) {
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
      return;
    }
    this.commitSeek(time);
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
   */
  notifyBufferChange(runway: BufferedRunway): void {
    if (this.disposed) return;
    this.emit('progress', runway);
    this.evaluateNow();
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
   */
  getAutoSpeedSuggestion(): number | null {
    const required = this.requiredSources();
    if (required.length === 0) return null;
    const speed = this.timeController.getSpeed();
    const absSpeed = Math.abs(speed);
    if (absSpeed <= 0) return null;

    const horizonSimMs = AUTO_SPEED_HORIZON_WALL_MS * absSpeed;
    const time = this.timeController.getTime();
    const range =
      speed < 0
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
    return (aggregateBytesPerMs / bytesPerSimMs) * AUTO_SPEED_SAFETY;
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
      for (const s of this.allSources()) s.setInteractive?.(false);
    }
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
  ): BufferedRunway {
    const required = this.requiredSources();
    if (required.length === 0) {
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
    const incomplete: number[] = [];
    for (const source of required) {
      const r = source.getBufferedRunway(time, direction, horizonSimMs);
      bytesPending += r.bytesPending;
      if (r.complete) continue;
      allComplete = false;
      incomplete.push(r.simMs);
      if (r.simMs > leadSimMs) leadSimMs = r.simMs;
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
    // Second pass: lift any source within tolerance of the leader to the
    // leader, then take the min. Sources further behind keep their real
    // runway (full stall protection).
    let minSimMs = Infinity;
    for (const simMs of incomplete) {
      const effective = leadSimMs - simMs <= tolSimMs ? leadSimMs : simMs;
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
    this._state = next;
    this.emit('statechange', next);
    emitProbe('playback', {
      event: 'statechange',
      state: next,
      ...this.getQoeStats(),
    });
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
    if (this.userWantsPlayback) {
      this.enterGate('seeking', 1);
    } else {
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

    const speed = this.timeController.getSpeed();
    const absSpeed = Math.abs(speed);
    const requiredSimMs = this.startGateWallMs * absSpeed * this.gateFactor;

    let passed = false;
    let degraded = false;
    if (requiredSimMs <= 0) {
      // Zero speed consumes no data — nothing to gate on.
      passed = true;
    } else if (this.hasAnySource()) {
      const direction: 1 | -1 = speed < 0 ? -1 : 1;
      const time = this.timeController.getTime();
      // Combined over REQUIRED sources: min runway (cadence-tolerance-banded),
      // AND complete. With zero required sources this reports complete (never
      // gates).
      const runway = this.combinedRequiredRunway(
        time,
        direction,
        requiredSimMs,
        this.toleranceSimMs(absSpeed),
      );
      passed = runway.complete || runway.simMs >= requiredSimMs;
      if (!passed) {
        // canplaythrough-style predictor (HAVE_ENOUGH_DATA): start when the
        // MISSING remainder of the gate window is predicted to download in
        // less wall time than the already-buffered runway plays out (with a
        // small floor so an instant network passes a cold gate). Without
        // this, gates scale linearly with |speed| and a 10× sweep can demand
        // sim-years of runway that no loader is meant to hold up front.
        passed = this.predictsPlaythrough(
          time,
          direction,
          requiredSimMs,
          runway,
          absSpeed,
        );
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
    const direction: 1 | -1 = speed < 0 ? -1 : 1;
    const time = this.timeController.getTime();
    // The NEAREST required-source frontier (cadence-tolerance-banded min
    // simMs); complete = AND over required. The same band that keeps the gate
    // from false-stalling must also lift the cached frontier so the per-tick
    // clamp doesn't snap the playhead back to a fractionally-behind cadence
    // peer. With zero required sources this is complete ⇒ unbounded.
    const runway = this.combinedRequiredRunway(
      time,
      direction,
      undefined,
      this.toleranceSimMs(Math.abs(speed)),
    );
    this.frontierDirection = direction;
    this.bufferedUntil = runway.complete
      ? direction * Infinity
      : time + direction * runway.simMs;
    if (this.degradedCreep) {
      const required =
        this.startGateWallMs * Math.abs(speed) * this.resumeFactor;
      if (runway.complete || runway.simMs >= required) {
        this.setDegradedCreep(false);
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
    if (!this.hasAnySource() || !this.userWantsPlayback) return;
    const speed = this.timeController.getSpeed();
    const absSpeed = Math.abs(speed);
    if (absSpeed <= 0) return;

    const watermarkSimMs = this.lowWatermarkWallMs * absSpeed;
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
    );
    if (!runway.complete && runway.simMs < watermarkSimMs) {
      // Same canplaythrough predictor as the gate: don't stall when the
      // loader is predicted to outrun consumption — a thin runway on a fast
      // network is fine; a thin runway on a slow one is an imminent dry-out.
      if (
        this.predictsPlaythrough(
          time,
          direction,
          watermarkSimMs,
          runway,
          absSpeed,
        )
      )
        return;
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
    const required = this.requiredSources();
    if (required.length === 0) return true; // nothing gates ⇒ always plays through
    if (absSpeed <= 0) return false;
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

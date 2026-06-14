// @poopdeck.gl/playback
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/playback contributors

/**
 * SttPlayer — the HTMLMediaElement-shaped facade over {@link TimeController}
 * + {@link PlaybackGovernor}.
 *
 * Why it exists (player-ergonomics review §4): without it an integrator must
 * understand three objects and their choreography — construct a controller,
 * wrap it in a governor, route play/pause/seek through the governor but speed
 * through the controller, hand-roll a base-rate × multiplier speed model and
 * a throttled UI clock, and never call `controller.play()/setTime()` directly.
 * The 300-line showcase hook was the de-facto quick start. This facade is
 * that choreography behind the one API every web developer already knows:
 * `play()/pause()`, `paused`, `ended`, `currentTime`, `duration`,
 * `playbackRate`, `seekable`, `buffered`, and the matching events.
 *
 * Two deliberate data-player departures from the media element:
 * - Speed is `baseRate × playbackRate`. Video's literal 1× is meaningless for
 *   sim time; the data-player convention is a per-dataset base rate (sim-ms
 *   per wall-ms — "the dataset plays in its target duration") with the
 *   user-facing multiplier layered on top. The facade owns that split so no
 *   consumer reimplements it.
 * - Times are absolute sim milliseconds (the controller's native currency),
 *   not zero-based seconds — `seekable` says where the range lives.
 *
 * The wrapped pieces stay exposed (`timeController` for layer wiring,
 * `governor` for advanced use). The standing rule "never drive the controller
 * directly while a governor is attached" still applies — the facade IS the
 * driver; layers only READ the clock.
 */

import { TimeController } from './time-controller';
import {
  PlaybackGovernor,
  type BufferSource,
  type BufferedRunway,
  type GovernorReadyEvent,
  type GovernorWaitingEvent,
  type PlaybackGovernorOptions,
  type PlaybackGovernorState,
} from './playback-governor';

export interface SttPlayerOptions {
  /** The dataset's time range (absolute sim-ms). Drives `duration`/`seekable`. */
  timeRange: { start: number; end: number };
  /** Initial playhead position. @default timeRange.start */
  initialTime?: number;
  /**
   * Sim-ms advanced per wall-ms at `playbackRate` 1 — the per-dataset "1×"
   * (e.g. `span / targetDurationMs` so the dataset plays in a target wall
   * duration). @default 1
   */
  baseRate?: number;
  /** User-facing speed multiplier over `baseRate`. @default 1 */
  playbackRate?: number;
  /** Wrap to the range start at the end (routed through seek semantics). @default false */
  loop?: boolean;
  /** Ping-pong at the boundaries instead of wrapping (see TimeControllerOptions.bounce). @default false */
  bounce?: boolean;
  /**
   * 'timeupdate' event cadence (media elements fire ~4 Hz). Throttles ONLY
   * the event — the internal clock still advances every animation frame, and
   * layers read it directly — so React-style consumers fall into the pit of
   * success instead of re-rendering at 60 Hz. @default 4
   */
  timeupdateHz?: number;
  /** Governor tuning (gates, watermarks, escape hatch). The source is wired via {@link SttPlayer.setSource}. */
  governor?: Omit<PlaybackGovernorOptions, 'source'>;
}

export type SttPlayerEventMap = {
  /** Playhead time (absolute sim-ms), throttled to `timeupdateHz` while playing; emitted immediately when the clock freezes or a seek/scrub moves it. */
  timeupdate: (time: number) => void;
  /** User intent became "playing" — from this facade's play() or an adopted external play. */
  play: () => void;
  /** User intent became "paused" — from pause(), an external clock pause, or the range-end clamp. */
  pause: () => void;
  /** Governor machine state changed (idle/starting/playing/buffering/seeking). */
  statechange: (state: PlaybackGovernorState) => void;
  /** A gate was entered; the clock is frozen (media-element 'waiting'). */
  waiting: (event: GovernorWaitingEvent) => void;
  /** A gate passed and the clock started (media-element 'canplay'/'playing'). */
  ready: (event: GovernorReadyEvent) => void;
  /** Forwarded buffer-runway event (media-element 'progress'). */
  progress: (runway: BufferedRunway) => void;
  /** Playback parked at a non-looping range boundary. */
  ended: (time: number) => void;
  /** `playbackRate` changed (the multiplier — `baseRate` changes do not fire it). */
  ratechange: (rate: number) => void;
};

export type SttPlayerEventName = keyof SttPlayerEventMap;

export class SttPlayer {
  /** The wrapped clock — pass to STT layers as their `timeController` prop (read-only for them). */
  readonly timeController: TimeController;
  /** The wrapped buffering state machine, exposed for advanced use (QoE probes, custom gating UIs). */
  readonly governor: PlaybackGovernor;
  /** Shared scrub-settle knob (see PlaybackGovernorOptions.seekSettleMs). */
  readonly seekSettleMs: number;

  private range: { start: number; end: number };
  private _baseRate: number;
  private _playbackRate: number;
  private readonly timeupdateIntervalMs: number;
  private lastTimeupdateWall = 0;
  /** Last intent observed, for diffing governor.paused into 'play'/'pause' events. */
  private lastPaused = true;
  private destroyed = false;
  /** Unsubscribers for our controller/governor subscriptions (torn down in destroy). */
  private readonly unsubscribers: Array<() => void> = [];

  private listeners: { [K in SttPlayerEventName]: Set<SttPlayerEventMap[K]> } = {
    timeupdate: new Set(),
    play: new Set(),
    pause: new Set(),
    statechange: new Set(),
    waiting: new Set(),
    ready: new Set(),
    progress: new Set(),
    ended: new Set(),
    ratechange: new Set(),
  };

  constructor(options: SttPlayerOptions) {
    this.range = { ...options.timeRange };
    this._baseRate = options.baseRate ?? 1;
    this._playbackRate = options.playbackRate ?? 1;
    const hz = options.timeupdateHz ?? 4;
    this.timeupdateIntervalMs = hz > 0 ? 1000 / hz : 0;

    this.timeController = new TimeController({
      initialTime: options.initialTime ?? this.range.start,
      speed: this._baseRate * this._playbackRate,
      loop: options.loop ?? false,
      bounce: options.bounce ?? false,
      timeRange: { ...this.range },
      // The facade owns the 'timeupdate' cadence; the clock itself must tick
      // unthrottled so layers (which read it per-frame) and the governor's
      // tick-driven stall detection see every frame.
      tickThrottleMs: 0,
    });
    this.governor = new PlaybackGovernor(this.timeController, options.governor ?? {});
    this.seekSettleMs = this.governor.seekSettleMs;

    this.unsubscribers.push(
      this.timeController.on('tick', this.handleTick),
      this.timeController.on('playState', this.handlePlayState),
      this.governor.on('statechange', this.handleStateChange),
      this.governor.on('waiting', (e) => this.emit('waiting', e)),
      this.governor.on('ready', (e) => this.emit('ready', e)),
      this.governor.on('progress', (r) => this.emit('progress', r)),
      this.governor.on('ended', (t) => this.emit('ended', t)),
    );
  }

  // ── HTMLMediaElement-shaped surface ─────────────────────────────────────

  /** Begin (gated) playback. At the ended boundary, replays from the range start. */
  play(): void {
    this.governor.requestPlay();
  }

  /** Pause. Sticks even while a gate is in progress. */
  pause(): void {
    this.governor.requestPause();
  }

  /** User intent (media-element semantics): stays `false` through 'starting'/'buffering'/'seeking' gates. */
  get paused(): boolean {
    return this.governor.paused;
  }

  /** True while parked at a non-looping range boundary. */
  get ended(): boolean {
    return this.governor.ended;
  }

  /** Playhead position (absolute sim-ms). */
  get currentTime(): number {
    return this.timeController.getTime();
  }

  /**
   * Committed seek: flushes stale prefetch, moves the clock, re-gates if
   * intent is playing. For drag interactions use the scrub trio instead —
   * previews are free; every setter call here costs a prefetch flush.
   */
  set currentTime(time: number) {
    this.governor.seekTo(time);
  }

  /** Range span (sim-ms). */
  get duration(): number {
    return this.range.end - this.range.start;
  }

  /** The user-facing speed multiplier over {@link baseRate}. */
  get playbackRate(): number {
    return this._playbackRate;
  }

  /**
   * Set the speed multiplier (magnitude model — in bounce mode the travel
   * direction belongs to the boundary reflection and is steered separately
   * via `timeController.setDirection`). Fires 'ratechange'. The governor sees
   * the resulting controller speed change as a re-plan event.
   */
  set playbackRate(rate: number) {
    if (rate === this._playbackRate) return;
    this._playbackRate = rate;
    this.applyEffectiveSpeed();
    this.emit('ratechange', rate);
  }

  /** Sim-ms per wall-ms at playbackRate 1 (the per-dataset "1×"). */
  get baseRate(): number {
    return this._baseRate;
  }

  /**
   * Re-base the speed model (e.g. on a dataset switch). Re-applies the
   * effective speed; does NOT fire 'ratechange' — the user-facing multiplier
   * didn't move, only what "1×" means.
   */
  set baseRate(rate: number) {
    if (rate === this._baseRate) return;
    this._baseRate = rate;
    this.applyEffectiveSpeed();
  }

  /** The seekable window — the configured time range (a defensive copy). */
  get seekable(): { start: number; end: number } {
    return { ...this.range };
  }

  /** Replace the time range (dataset switch). Updates `duration`/`seekable` and the clock's clamp range. */
  setTimeRange(range: { start: number; end: number }): void {
    this.range = { ...range };
    this.timeController.setTimeRange({ ...range });
  }

  /** Governor machine state (the media-element readyState analog). */
  get state(): PlaybackGovernorState {
    return this.governor.state;
  }

  /** Loaded time ranges for a buffered-bar UI (`[]` before the source arrives). */
  get buffered(): Array<{ start: number; end: number }> {
    return this.governor.getBufferedRanges();
  }

  /** True while playback advances pinned to the frontier at data-arrival rate (degraded creep). */
  get isCreeping(): boolean {
    return this.governor.isCreeping;
  }

  // ── Scrubbing (preview vs commit — see the governor docs) ───────────────

  /** Scrubber grabbed: freeze the clock; everything until endScrub is preview-only. */
  beginScrub(): void {
    this.governor.beginScrub();
  }

  /** Preview a scrub position (resident tiles render at the new time; no fetches). */
  scrubTo(time: number): void {
    this.governor.scrubTo(time);
  }

  /** Scrubber released: commit the final position as a real seek. */
  endScrub(time: number): void {
    this.governor.endScrub(time);
  }

  // ── Plumbing (layer callbacks → governor) ───────────────────────────────

  /** Wire the layer's `onTilesetReady` here (the tileset is the governor's BufferSource). */
  setSource(source: BufferSource | null): void {
    this.governor.setSource(source);
  }

  /** Wire the layer's `onBufferChange` here (re-emitted as 'progress'; re-evaluates gates immediately). */
  notifyBufferChange(runway: BufferedRunway): void {
    this.governor.notifyBufferChange(runway);
  }

  /** Honest wall-ms ETA until the current gate window is ready; null when unknown. */
  getEtaMs(): number | null {
    return this.governor.getEtaMs();
  }

  /** Byte/tile cost of making `range` fully buffered (directory math; for ETA chips, density strips). */
  estimateCost(range: { start: number; end: number }): { bytes: number; tiles: number } {
    return this.governor.estimateCost(range);
  }

  /** Session playback-QoE counters (stalls, startup, creep). */
  getQoeStats(): ReturnType<PlaybackGovernor['getQoeStats']> {
    return this.governor.getQoeStats();
  }

  /** Raw sustainable-speed suggestion in controller units (sim-ms per wall-ms); see the governor docs. */
  getAutoSpeedSuggestion(): number | null {
    return this.governor.getAutoSpeedSuggestion();
  }

  /**
   * The auto-speed suggestion expressed in this facade's multiplier units
   * (suggestion ÷ baseRate) — directly comparable to {@link playbackRate}.
   * May be `Infinity` (fully-buffered horizon ⇒ the network imposes no cap):
   * consumers clamp/snap/damp it via `decideAutoSpeedMultiplier`, never apply
   * it raw. Null when the honest math isn't possible yet.
   */
  getAutoSpeedMultiplierSuggestion(): number | null {
    const suggestion = this.governor.getAutoSpeedSuggestion();
    if (suggestion == null || this._baseRate <= 0) return null;
    return suggestion / this._baseRate;
  }

  // ── Events ──────────────────────────────────────────────────────────────

  /** Register an event listener. Returns an unsubscribe function. */
  on<K extends SttPlayerEventName>(event: K, callback: SttPlayerEventMap[K]): () => void {
    this.listeners[event].add(callback);
    return () => this.off(event, callback);
  }

  /** Unregister an event listener. */
  off<K extends SttPlayerEventName>(event: K, callback: SttPlayerEventMap[K]): void {
    this.listeners[event].delete(callback);
  }

  /** Dispose the governor, destroy the clock, drop all listeners. Safe to call twice. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.governor.dispose();
    this.timeController.destroy();
    for (const set of Object.values(this.listeners)) set.clear();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private applyEffectiveSpeed(): void {
    // setSpeed keeps magnitude semantics: a positive product never flips a
    // bounce-mode return leg (direction is the controller's, not ours).
    this.timeController.setSpeed(this._baseRate * this._playbackRate);
  }

  /**
   * Clock tick → throttled 'timeupdate'. Paused-clock ticks are explicit
   * setTime calls (seek commit, scrub preview, boundary clamp, frontier snap
   * landing) — final values a UI must land on, so they bypass the throttle;
   * only free-running playback ticks are rate-limited.
   */
  private readonly handleTick = (time: number): void => {
    if (!this.timeController.isPlaying()) {
      this.emitTimeupdateNow(time);
      return;
    }
    const now = nowWall();
    if (this.timeupdateIntervalMs > 0 && now - this.lastTimeupdateWall < this.timeupdateIntervalMs) {
      return;
    }
    this.lastTimeupdateWall = now;
    this.emit('timeupdate', time);
  };

  /**
   * Clock freeze/start → 'timeupdate' housekeeping. On any stop (user pause,
   * gate entry, scrub grab, range clamp) emit immediately so the UI lands on
   * the exact resting time — the throttled cadence may have skipped the last
   * frames (the useDemoPlayback playState-snap trick, now owned here). On
   * start, reset the throttle so the first tick after resume notifies.
   */
  private readonly handlePlayState = (playing: boolean): void => {
    if (!playing) {
      this.emitTimeupdateNow(this.timeController.getTime());
    } else {
      this.lastTimeupdateWall = 0;
    }
  };

  /**
   * Governor state → 'statechange', plus intent diffing into 'play'/'pause'.
   * Intent only ever changes alongside a state transition (facade
   * play()/pause(), an external clock pause the governor honors, an adopted
   * external play), so diffing `governor.paused` here catches every path with
   * one subscription — including ones this facade didn't initiate.
   */
  private readonly handleStateChange = (state: PlaybackGovernorState): void => {
    this.emit('statechange', state);
    const paused = this.governor.paused;
    if (paused !== this.lastPaused) {
      this.lastPaused = paused;
      if (paused) {
        this.emit('pause');
      } else {
        this.emit('play');
      }
    }
  };

  private emitTimeupdateNow(time: number): void {
    this.lastTimeupdateWall = nowWall();
    this.emit('timeupdate', time);
  }

  private emit<K extends SttPlayerEventName>(
    event: K,
    ...args: Parameters<SttPlayerEventMap[K]>
  ): void {
    for (const listener of this.listeners[event]) {
      (listener as (...a: Parameters<SttPlayerEventMap[K]>) => void)(...args);
    }
  }
}

/** performance.now when available (browsers, vitest), Date.now otherwise. */
function nowWall(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

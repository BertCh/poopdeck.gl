// @poopdeck.gl/playback
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/playback contributors

/**
 * Time controller for managing temporal animation
 */

export interface TimeControllerOptions {
  /** Initial time (Unix milliseconds) */
  initialTime?: number;
  /** Playback speed multiplier (1.0 = real-time) */
  speed?: number;
  /** Loop animation */
  loop?: boolean;
  /**
   * Ping-pong at the range boundaries instead of jumping. When `true`, hitting
   * `timeRange.end`/`start` reflects the overshoot back into the range and
   * reverses playback direction, so time stays CONTINUOUS across the boundary.
   * Takes precedence over `loop`.
   *
   * Why it exists: a hard loop-wrap teleports `currentTime` by the full range
   * span in one frame. For trail/window-based layers that one-frame jump both
   * (a) shifts the resident tile window past its own width → a mass evict+reload
   * blink, and (b) pops the rendered `[t-trail, t]` segment set to a disjoint
   * set → a visible layer flash. Bouncing keeps the window sliding smoothly so
   * neither happens. The cost is that the animation reverses at the boundary —
   * fine for an ambient, slow drift; not what you want for directional replay.
   * @default false
   */
  bounce?: boolean;
  /** Time range */
  timeRange?: { start: number; end: number };
  /**
   * Minimum wall-clock interval (ms) between 'tick' notifications during
   * playback. The internal time still advances every animation frame; this
   * only throttles how often listeners are notified, so downstream layers
   * are not asked to update more often than needed. 0 = notify every frame.
   */
  tickThrottleMs?: number;
}

export interface TimeControllerState {
  currentTime: number;
  playing: boolean;
  /** Signed effective rate: direction × magnitude (sim-ms per wall-ms). */
  speed: number;
  /** Travel direction, kept separate from the rate (bounce flips only this). */
  direction: 1 | -1;
  loop: boolean;
}

export type TimeUpdateCallback = (time: number) => void;
export type PlayStateCallback = (playing: boolean, speed: number) => void;

/**
 * Upper bound on a single frame's wall-clock delta. Browsers suspend rAF in
 * background tabs, so without this the first frame after a refocus advances
 * time by the ENTIRE background duration — a playhead teleport the governor's
 * frontier clamp deliberately refuses to snap back (it reads as an external
 * seek). Any real frame longer than this is dropped-frames jank where
 * advancing playback by the full gap would only compound the stutter.
 */
const MAX_FRAME_DELTA_MS = 250;

export class TimeController {
  private currentTime: number;
  private playing: boolean = false;
  /**
   * Rate magnitude, kept separate from {@link direction} so a bounce reversal
   * never corrupts the user's chosen rate (HTMLMediaElement keeps
   * playbackRate magnitude-only for the same reason). `getSpeed()` still
   * returns the signed product — the contract the governor and loaders read.
   */
  private speedMagnitude: number = 1.0;
  private direction: 1 | -1 = 1;
  private loop: boolean = false;
  private bounce: boolean = false;
  private timeRange?: { start: number; end: number };
  private listeners: Set<TimeUpdateCallback> = new Set();
  private playStateListeners: Set<PlayStateCallback> = new Set();
  private wrapListeners: Set<TimeUpdateCallback> = new Set();
  private endedListeners: Set<TimeUpdateCallback> = new Set();
  private animationFrameId?: number;
  private lastUpdateTime?: number;
  private tickThrottleMs: number = 0;
  private lastTickNotifyTime: number = 0;
  /** True while a frame step runs — guards play() against forking a second rAF loop. */
  private inTick = false;
  /**
   * When true, an external render loop (e.g. deck.gl via onBeforeRender →
   * {@link advanceFrame}) owns the per-frame advance and the internal rAF is
   * suppressed, so the playhead and the GPU draw share one frame clock.
   * Default false: the controller self-drives via requestAnimationFrame, which
   * is what maplibre/three/standalone/headless consumers rely on.
   */
  private externalDriver = false;

  /**
   * The animation-frame token {@link advanceFrame} last advanced on, so a
   * frame that draws more than once still advances the playhead exactly once.
   * `null` until the first host-driven advance.
   */
  private lastAdvancedFrameToken: number | null = null;

  /**
   * Re-anchor the frame clock on tab refocus: rAF was suspended in the
   * background, so the next frame's raw delta is the whole background
   * duration. MAX_FRAME_DELTA_MS bounds the damage; re-anchoring removes
   * even the clamped jump.
   */
  private readonly visibilityHandler = (): void => {
    if (document.visibilityState === 'visible' && this.playing) {
      this.lastUpdateTime = performance.now();
    }
  };

  constructor(options: TimeControllerOptions = {}) {
    // Use ?? not || so an explicit initialTime/speed of 0 is honored.
    this.currentTime = options.initialTime ?? Date.now();
    const initialSpeed = options.speed ?? 1.0;
    this.speedMagnitude = Math.abs(initialSpeed);
    this.direction = initialSpeed < 0 ? -1 : 1;
    this.loop = options.loop ?? false;
    this.bounce = options.bounce ?? false;
    this.timeRange = options.timeRange;
    this.tickThrottleMs = options.tickThrottleMs ?? 0;
  }

  /** Get current time */
  getTime(): number {
    return this.currentTime;
  }

  /** Set current time */
  setTime(time: number): void {
    // TEMP-DIAGNOSTIC (flash repro): record backward sim-time jumps while
    // playing — the governor's frontier clamp lands here via setClockTime.
    if (this.playing && time < this.currentTime) {
      const probe = (
        globalThis as unknown as {
          __sttProbe?: { enabled?: boolean; backjumps?: unknown[] };
        }
      ).__sttProbe;
      if (probe?.enabled && Array.isArray(probe.backjumps)) {
        probe.backjumps.push({
          wall: performance.now(),
          from: this.currentTime,
          to: time,
          deltaSimMs: this.currentTime - time,
        });
      }
    }
    this.currentTime = time;
    this.notifyListeners();
  }

  /** Check if playing */
  isPlaying(): boolean {
    return this.playing;
  }

  /** Get playback speed (signed: direction × magnitude). */
  getSpeed(): number {
    return this.direction * this.speedMagnitude;
  }

  /**
   * Set playback speed. The magnitude is always adopted. A negative value
   * explicitly selects reverse; a positive value restores forward travel —
   * EXCEPT in bounce mode, where direction belongs to the boundary
   * reflection: a UI pushing a positive magnitude mid-reverse (speed slider
   * during the return leg) must change only the rate, never the travel
   * direction. Use {@link setDirection} to steer explicitly.
   */
  setSpeed(speed: number): void {
    this.speedMagnitude = Math.abs(speed);
    if (speed < 0) {
      this.direction = -1;
    } else if (speed > 0 && !this.bounce) {
      this.direction = 1;
    }
    if (this.playing) {
      this.notifyPlayStateListeners();
    }
  }

  /** Travel direction (bounce reversals flip this, not the rate). */
  getDirection(): 1 | -1 {
    return this.direction;
  }

  /** Set travel direction explicitly. Announced while playing (a re-plan event for loaders). */
  setDirection(direction: 1 | -1): void {
    if (direction === this.direction) return;
    this.direction = direction;
    if (this.playing) {
      this.notifyPlayStateListeners();
    }
  }

  /** Set time range */
  setTimeRange(timeRange: { start: number; end: number }): void {
    this.timeRange = timeRange;
  }

  /** The configured time range, if any (a defensive copy). */
  getTimeRange(): { start: number; end: number } | undefined {
    return this.timeRange ? { ...this.timeRange } : undefined;
  }

  /**
   * Toggle wrapping at the range end (the media-element `loop` attribute).
   * Live: flipping it mid-playback only changes what happens at the NEXT
   * boundary crossing — it never moves the playhead. `bounce` still takes
   * precedence when set.
   */
  setLoop(loop: boolean): void {
    this.loop = loop;
  }

  /** Whether the clock wraps at the range end rather than ending there. */
  getLoop(): boolean {
    return this.loop;
  }

  /** Start playback */
  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.lastUpdateTime = performance.now();
    // Reset throttle so the first tick after play notifies immediately.
    this.lastTickNotifyTime = 0;
    // Registered only while playing: a playing controller is already rooted
    // by its self-rescheduling rAF loop, so the document listener adds no new
    // leak surface for undisposed instances. `document` is absent in
    // workers/Node — the frame-delta clamp alone covers those.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
    this.notifyPlayStateListeners();
    // Re-entrant resume (a wrap/playState listener resumed playback from
    // inside tick(), e.g. the governor's instantly-passing post-wrap gate):
    // skip the synchronous tick — the outer tick's tail reschedules the one
    // rAF loop; a second sync tick would fork a second loop (2× speed).
    //
    // In external-driver mode the host render loop (deck.gl) pumps
    // advanceFrame() each frame, so we never start the internal rAF here — the
    // next host frame advances the playhead instead.
    if (!this.externalDriver && !this.inTick) this.tick();
  }

  /** Pause playback. No-op (and no playState notification) when already paused — mirrors play(). */
  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = undefined;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    this.notifyPlayStateListeners();
  }

  /**
   * Hand the per-frame advance to an external render loop (e.g. deck.gl's
   * animation loop calling {@link advanceFrame} from `onBeforeRender`). The
   * internal rAF is suppressed so there is exactly one frame clock and no phase
   * skew between "time advanced" and "scene drawn". Idempotent.
   */
  attachExternalClock(): void {
    if (this.externalDriver) return;
    this.externalDriver = true;
    // A fresh host loop starts un-billed: the token of the frame it attaches
    // in must not suppress that frame's first advance.
    this.lastAdvancedFrameToken = null;
    // Stop the self-owned loop; the host loop takes over from here.
    if (this.animationFrameId !== undefined) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = undefined;
    }
    // Re-anchor so the first host frame doesn't bill the gap since the last
    // internal tick as elapsed sim-time (MAX_FRAME_DELTA_MS would clamp it, but
    // this avoids even the clamped jump).
    if (this.playing) this.lastUpdateTime = performance.now();
  }

  /**
   * Restore the self-owned rAF loop (host loop detaching, e.g. deck.gl unmount).
   * Resumes the internal loop if mid-playback. Idempotent.
   */
  detachExternalClock(): void {
    if (!this.externalDriver) return;
    this.externalDriver = false;
    if (this.playing) {
      this.lastUpdateTime = performance.now();
      if (!this.inTick) this.tick();
    }
  }

  /**
   * Advance the playhead by one host-driven frame. Call once per frame from the
   * external render loop after {@link attachExternalClock}. No-op unless an
   * external clock is attached; the underlying step also no-ops while paused, so
   * it is safe to call every frame regardless of play state.
   *
   * COALESCED per animation frame: a host that draws several times inside one
   * frame advances the playhead once. This is not a nicety — deck.gl's React
   * wrapper redraws SYNCHRONOUSLY from a dependency-less layout effect
   * (`deck.redraw('Initial render')` in `DeckGLWithRef`), so `onBeforeRender`
   * fires once per React COMMIT, not once per frame. Without the coalesce the
   * clock ticks per render, and any playback state a tick produces (a stall
   * freezing the clock, a gate opening it) re-enters React from inside its own
   * commit → render → draw → tick → … chain. That chain is what React reports
   * as "Maximum update depth exceeded"; it also multiplies the governor's
   * per-tick work by the app's render rate.
   *
   * No sim-time is lost by skipping a draw: {@link _step} integrates
   * `performance.now() - lastUpdateTime`, so the next accepted advance covers
   * the whole elapsed span.
   *
   * The frame token is `document.timeline.currentTime`, which the browser
   * updates once per rendering opportunity and holds constant for every task
   * in between — so it is the same value for all draws in a frame regardless
   * of callback ORDER (an rAF-callback token cannot promise that: whether the
   * host schedules its next frame before or after drawing would decide it).
   * Where no document timeline exists (workers, Node, headless hosts) every
   * call advances, exactly as before.
   */
  advanceFrame(): void {
    if (!this.externalDriver) return;
    const token = currentFrameToken();
    if (token !== null) {
      if (token === this.lastAdvancedFrameToken) return;
      this.lastAdvancedFrameToken = token;
    }
    this._step();
  }

  /** Toggle play/pause */
  toggle(): void {
    if (this.playing) {
      this.pause();
    } else {
      this.play();
    }
  }

  /** Seek to specific time */
  seek(time: number): void {
    this.setTime(time);
  }

  /** Seek by relative offset */
  seekBy(delta: number): void {
    this.setTime(this.currentTime + delta);
  }

  /** Register listener for time updates. Returns an unsubscribe function. */
  on(event: 'tick', callback: TimeUpdateCallback): () => void;
  on(event: 'playState', callback: PlayStateCallback): () => void;
  on(event: 'wrap', callback: TimeUpdateCallback): () => void;
  on(event: 'ended', callback: TimeUpdateCallback): () => void;
  on(
    event: string,
    callback: TimeUpdateCallback | PlayStateCallback,
  ): () => void {
    if (event === 'tick') {
      this.listeners.add(callback as TimeUpdateCallback);
    } else if (event === 'playState') {
      this.playStateListeners.add(callback as PlayStateCallback);
    } else if (event === 'wrap') {
      this.wrapListeners.add(callback as TimeUpdateCallback);
    } else if (event === 'ended') {
      this.endedListeners.add(callback as TimeUpdateCallback);
    }
    return () => this.removeListener(event, callback);
  }

  /** Unregister listener */
  off(event: 'tick', callback: TimeUpdateCallback): void;
  off(event: 'playState', callback: PlayStateCallback): void;
  off(event: 'wrap', callback: TimeUpdateCallback): void;
  off(event: 'ended', callback: TimeUpdateCallback): void;
  off(event: string, callback: TimeUpdateCallback | PlayStateCallback): void {
    this.removeListener(event, callback);
  }

  private removeListener(
    event: string,
    callback: TimeUpdateCallback | PlayStateCallback,
  ): void {
    if (event === 'tick') {
      this.listeners.delete(callback as TimeUpdateCallback);
    } else if (event === 'playState') {
      this.playStateListeners.delete(callback as PlayStateCallback);
    } else if (event === 'wrap') {
      this.wrapListeners.delete(callback as TimeUpdateCallback);
    } else if (event === 'ended') {
      this.endedListeners.delete(callback as TimeUpdateCallback);
    }
  }

  /** Get current state */
  getState(): TimeControllerState {
    return {
      currentTime: this.currentTime,
      playing: this.playing,
      speed: this.getSpeed(),
      direction: this.direction,
      loop: this.loop,
    };
  }

  /** Destroy controller */
  destroy(): void {
    this.pause(); // also unregisters the visibilitychange handler
    this.listeners.clear();
    this.playStateListeners.clear();
    this.wrapListeners.clear();
    this.endedListeners.clear();
  }

  /**
   * Advance the playhead by one frame's worth of wall-clock × speed, handle
   * range boundaries, and notify listeners. Does NOT schedule the next frame —
   * the caller owns scheduling: {@link tick} reschedules the internal rAF;
   * {@link advanceFrame} is called by the external host loop instead.
   */
  private _step = (): void => {
    if (!this.playing) return;

    const now = performance.now();
    // Explicit undefined check: a lastUpdateTime of 0 is a valid timestamp.
    // The clamp bounds background-tab refocus (see MAX_FRAME_DELTA_MS).
    const elapsed =
      this.lastUpdateTime !== undefined
        ? Math.min(now - this.lastUpdateTime, MAX_FRAME_DELTA_MS)
        : 0;
    this.lastUpdateTime = now;

    this.inTick = true;
    try {
      // Update time based on elapsed time and speed
      const timeIncrement = elapsed * this.speedMagnitude * this.direction;
      this.currentTime += timeIncrement;

      // Handle time range boundaries
      if (this.timeRange) {
        const { start, end } = this.timeRange;
        if (this.currentTime > end) {
          if (this.bounce) {
            // Reflect the overshoot back into the range and reverse direction so
            // time stays continuous (no teleport → no window evict / ribbon pop).
            this.currentTime = Math.max(start, end - (this.currentTime - end));
            this.direction = -1;
            // Announce the reversal so downstream tile loaders can re-aim their
            // prefetch immediately. Without this the tileset only infers the new
            // direction from observed time deltas (with a multi-frame hysteresis),
            // so it keeps prefetching the OLD direction for a moment and the
            // tiles the play head now moves into load reactively → a flash.
            this.notifyPlayStateListeners();
          } else if (this.loop) {
            this.currentTime = start;
            // Announce the wrap: it is a teleport-seek the clock performed on
            // its own, and the governor must route it through seek semantics
            // (flush stale prefetch, plain startup gate) instead of letting
            // playback run ungated into possibly-unloaded time.
            this.notifyWrapListeners();
          } else {
            this.currentTime = end;
            this.pause();
            // Distinct from a user pause: the clock ran out of range. This is
            // the media-element 'ended' signal — UIs show a replay affordance
            // and the governor restarts from the range start on the next play.
            this.notifyEndedListeners();
          }
        } else if (this.currentTime < start) {
          if (this.bounce) {
            this.currentTime = Math.min(
              end,
              start + (start - this.currentTime),
            );
            this.direction = 1;
            this.notifyPlayStateListeners();
          } else if (this.loop) {
            this.currentTime = end;
            this.notifyWrapListeners();
          } else {
            this.currentTime = start;
            this.pause();
            this.notifyEndedListeners();
          }
        }
      }

      // Throttle tick notifications: advance time every frame but only notify
      // listeners every `tickThrottleMs` of wall-clock time. Boundary events
      // (loop/clamp handled above) still notify on the next eligible tick.
      if (this.tickThrottleMs <= 0) {
        this.notifyListeners();
      } else if (now - this.lastTickNotifyTime >= this.tickThrottleMs) {
        this.lastTickNotifyTime = now;
        this.notifyListeners();
      }
    } finally {
      this.inTick = false;
    }

    // TEMP-DIAGNOSTIC (flash repro): ~20Hz (wall, simTime) timeline so tile
    // arrivals can be correlated against the playhead offline.
    {
      const probe = (
        globalThis as unknown as {
          __sttProbe?: {
            enabled?: boolean;
            timeline?: unknown[];
            _tlLast?: number;
          };
        }
      ).__sttProbe;
      if (probe?.enabled && Array.isArray(probe.timeline)) {
        if (now - (probe._tlLast ?? 0) >= 50) {
          probe._tlLast = now;
          probe.timeline.push({ wall: now, sim: this.currentTime });
        }
      }
    }
  };

  /**
   * Self-driven frame: advance once via {@link _step}, then reschedule the
   * internal rAF. Used only when {@link externalDriver} is false; in
   * external-driver mode the host loop calls {@link advanceFrame} and this
   * never runs.
   */
  private tick = (): void => {
    this._step();
    // Reschedule unless we stopped (ended → pause) or a host loop now drives us.
    if (this.playing && !this.externalDriver) {
      this.animationFrameId = requestAnimationFrame(this.tick);
    }
  };

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener(this.currentTime);
    }
  }

  private notifyPlayStateListeners(): void {
    for (const listener of this.playStateListeners) {
      listener(this.playing, this.getSpeed());
    }
  }

  private notifyWrapListeners(): void {
    for (const listener of this.wrapListeners) {
      listener(this.currentTime);
    }
  }

  private notifyEndedListeners(): void {
    for (const listener of this.endedListeners) {
      listener(this.currentTime);
    }
  }
}

/**
 * A token identifying the CURRENT animation frame, or `null` where the host
 * has no document timeline (workers, Node, headless renderers).
 *
 * `document.timeline.currentTime` advances once per rendering opportunity and
 * is constant for every task that runs between two of them — which is exactly
 * the "same frame" equivalence {@link TimeController.advanceFrame} needs, and
 * unlike an rAF-callback counter it does not depend on the order in which the
 * host schedules its next frame relative to its draw.
 *
 * `currentTime` is typed `CSSNumberish` (a number in every browser that ships
 * it today, a `CSSNumericValue` in principle), so anything non-finite after
 * coercion reads as "no token" and every call advances.
 */
function currentFrameToken(): number | null {
  if (typeof document === 'undefined') return null;
  const timeline = document.timeline as { currentTime?: unknown } | undefined;
  if (!timeline) return null;
  const value = Number(timeline.currentTime);
  return Number.isFinite(value) ? value : null;
}

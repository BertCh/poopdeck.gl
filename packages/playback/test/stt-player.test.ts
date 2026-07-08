/**
 * SttPlayer facade tests: the HTMLMediaElement-shaped surface delegates to
 * the wrapped TimeController + PlaybackGovernor correctly — gated play,
 * intent-shaped `paused`, committed seeks via the currentTime setter, the
 * baseRate × playbackRate speed model, the throttled 'timeupdate' cadence
 * with its pause snap, ended/replay semantics, and idempotent teardown.
 *
 * Mirrors playback-governor.test.ts: fake timers (incl. performance) for
 * deterministic gate cadence, rAF stubbed out (re-stubbed with a frame queue
 * where boundary clamps need real tick stepping), and a plain mutable mock
 * BufferSource.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SttPlayer, type SttPlayerOptions } from '../src/stt-player';
import type { BufferSource, BufferedRunway } from '../src/playback-governor';

/** Mutable mock BufferSource: tests poke `runwaySimMs`/`complete` directly. */
function makeSource() {
  const state = {
    runwaySimMs: 0,
    complete: false,
    bytesPending: 0,
    ranges: [] as Array<{ start: number; end: number }>,
    costBytes: 0,
    costTiles: 0,
    etaMs: null as number | null,
    flushes: 0,
  };
  const source: BufferSource = {
    getBufferedRunway(_time, _direction, horizonSimMs) {
      return {
        simMs: state.runwaySimMs,
        bytesPending: state.bytesPending,
        horizonSimMs: horizonSimMs ?? state.runwaySimMs,
        complete: state.complete,
      };
    },
    getBufferedRanges() {
      return state.ranges;
    },
    estimateCost() {
      return { bytes: state.costBytes, tiles: state.costTiles };
    },
    estimateTimeToReadyMs() {
      return state.etaMs;
    },
    flushPrefetch() {
      state.flushes++;
    },
  };
  return { source, state };
}

function runway(simMs: number, complete = false): BufferedRunway {
  return { simMs, bytesPending: 0, horizonSimMs: simMs, complete };
}

describe('SttPlayer', () => {
  let player: SttPlayer | null;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'performance',
      ],
    });
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    player = null;
  });

  afterEach(() => {
    player?.destroy();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Default player: 10 sim-ms per wall-ms at 1×, big range starting at 0. */
  function makePlayer(opts: Partial<SttPlayerOptions> = {}) {
    player = new SttPlayer({
      timeRange: { start: 0, end: 10_000_000 },
      initialTime: 0,
      baseRate: 10,
      ...opts,
    });
    return player;
  }

  it('play() routes through the governor gate: full runway → playing immediately', () => {
    const { source, state } = makeSource();
    state.runwaySimMs = 1_000_000;
    const p = makePlayer();
    p.setSource(source);
    const onPlay = vi.fn();
    p.on('play', onPlay);

    expect(p.paused).toBe(true);
    p.play();
    expect(p.state).toBe('playing');
    expect(p.paused).toBe(false);
    expect(p.timeController.isPlaying()).toBe(true);
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it('paused reflects intent through a gate (false while starting, sticks on pause)', () => {
    const { source } = makeSource(); // runway 0 → gate cannot pass
    const p = makePlayer();
    p.setSource(source);
    const onPause = vi.fn();
    p.on('pause', onPause);

    p.play();
    expect(p.state).toBe('starting');
    expect(p.timeController.isPlaying()).toBe(false); // clock frozen…
    expect(p.paused).toBe(false); // …but intent is "playing"

    p.pause();
    expect(p.paused).toBe(true);
    expect(p.state).toBe('idle');
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('currentTime setter commits a seek: prefetch flushed, seeking while intent plays, timeupdate snaps', () => {
    const { source, state } = makeSource();
    state.runwaySimMs = 1_000_000;
    const p = makePlayer();
    p.setSource(source);
    const times: number[] = [];
    p.on('timeupdate', (t) => times.push(t));
    p.play();
    expect(p.state).toBe('playing');

    state.runwaySimMs = 0; // destination not buffered
    const flushesBefore = state.flushes;
    p.currentTime = 200_000;
    expect(state.flushes).toBe(flushesBefore + 1);
    expect(p.currentTime).toBe(200_000);
    expect(p.state).toBe('seeking'); // intent playing → post-seek gate
    expect(p.paused).toBe(false);
    // The seek's setTime fired on a frozen clock → emitted immediately, no
    // throttle: UIs land on the committed position.
    expect(times.at(-1)).toBe(200_000);
  });

  it('playbackRate setter applies baseRate × rate to the controller and fires ratechange once', () => {
    const p = makePlayer({ baseRate: 10 });
    const onRate = vi.fn();
    p.on('ratechange', onRate);

    p.playbackRate = 2.5;
    expect(p.playbackRate).toBe(2.5);
    expect(p.timeController.getSpeed()).toBe(25);
    expect(onRate).toHaveBeenCalledWith(2.5);

    p.playbackRate = 2.5; // no-op set must not re-fire
    expect(onRate).toHaveBeenCalledTimes(1);

    // baseRate re-bases the model without touching the user-facing multiplier.
    p.baseRate = 100;
    expect(p.timeController.getSpeed()).toBe(250);
    expect(p.playbackRate).toBe(2.5);
    expect(onRate).toHaveBeenCalledTimes(1); // no ratechange for baseRate
  });

  it("throttles 'timeupdate' to timeupdateHz during playback and snaps on pause", () => {
    const { source, state } = makeSource();
    state.complete = true; // never stall/clamp — this test is about cadence
    const p = makePlayer({ timeupdateHz: 4 }); // 250 ms interval
    p.setSource(source);
    const times: number[] = [];
    p.on('timeupdate', (t) => times.push(t));

    vi.advanceTimersByTime(1000); // move the fake wall clock off epoch 0
    p.play(); // sync gate pass; the initial tick emits (throttle was reset)
    const afterPlay = times.length;
    expect(afterPlay).toBeGreaterThan(0);

    // Playback ticks inside the 250 ms window are swallowed…
    p.timeController.setTime(100);
    p.timeController.setTime(150);
    expect(times.length).toBe(afterPlay);

    // …a tick past the window emits…
    vi.advanceTimersByTime(250);
    p.timeController.setTime(200);
    expect(times.length).toBe(afterPlay + 1);
    expect(times.at(-1)).toBe(200);

    // …and pause emits the FINAL value immediately, mid-window, so the UI
    // never rests on a stale frame (the playState-snap trick).
    p.timeController.setTime(300);
    expect(times.length).toBe(afterPlay + 1); // still throttled
    p.pause();
    expect(times.at(-1)).toBe(300);
  });

  it("fires 'ended' at a non-loop range end; play() afterwards replays from the range start", () => {
    // Re-stub rAF with a frame queue so the clock can actually tick to the boundary.
    const frames: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      frames.push(cb);
      return frames.length;
    });
    const frame = (ms: number) => {
      vi.advanceTimersByTime(ms);
      for (const cb of frames.splice(0, frames.length)) cb();
    };

    const { source, state } = makeSource();
    state.complete = true;
    const p = makePlayer({
      timeRange: { start: 0, end: 1000 },
      baseRate: 1,
      loop: false,
    });
    p.setSource(source);
    const onEnded = vi.fn();
    const onPause = vi.fn();
    p.on('ended', onEnded);
    p.on('pause', onPause);

    p.play();
    expect(p.state).toBe('playing');
    for (let i = 0; i < 6; i++) frame(200); // 6 × 200 sim-ms = 1200 > end

    expect(p.currentTime).toBe(1000); // clamped at the boundary
    expect(p.ended).toBe(true);
    expect(p.paused).toBe(true); // media convention: ended implies paused…
    expect(onPause).toHaveBeenCalledTimes(1); // …and 'pause' fired before 'ended'
    expect(onEnded).toHaveBeenCalledWith(1000);
    expect(p.state).toBe('idle');

    // Replay convention: play at the end restarts from the range start.
    p.play();
    expect(p.currentTime).toBe(0);
    expect(p.ended).toBe(false);
    expect(p.state).toBe('playing'); // complete runway → gate passed synchronously
  });

  it('exposes buffered/seekable/duration and setTimeRange updates them', () => {
    const { source, state } = makeSource();
    state.ranges = [{ start: 0, end: 500 }];
    const p = makePlayer({ timeRange: { start: 0, end: 1000 } });
    expect(p.buffered).toEqual([]); // no source yet
    p.setSource(source);
    expect(p.buffered).toEqual([{ start: 0, end: 500 }]);
    expect(p.duration).toBe(1000);
    expect(p.seekable).toEqual({ start: 0, end: 1000 });

    p.setTimeRange({ start: 5000, end: 9000 });
    expect(p.duration).toBe(4000);
    expect(p.seekable).toEqual({ start: 5000, end: 9000 });
    expect(p.timeController.getTimeRange()).toEqual({ start: 5000, end: 9000 });
  });

  it('converts the auto-speed suggestion into multiplier units (and passes Infinity through)', () => {
    const { source, state } = makeSource();
    // Governor math: horizon 8000 wall-ms × speed 10 = 80_000 sim-ms; cost
    // 800_000 bytes → 10 bytes/sim-ms; throughput 100 → 100/10 × 0.7 = 7
    // controller units → ÷ baseRate 10 = 0.7× multiplier.
    state.costBytes = 800_000;
    state.costTiles = 100;
    const p = makePlayer({
      baseRate: 10,
      governor: { getThroughput: () => ({ bytesPerMs: 100, samples: 5 }) },
    });
    p.setSource(source);
    expect(p.getAutoSpeedSuggestion()).toBeCloseTo(7);
    expect(p.getAutoSpeedMultiplierSuggestion()).toBeCloseTo(0.7);

    state.costBytes = 0;
    state.costTiles = 0; // fully buffered horizon → uncapped
    expect(p.getAutoSpeedMultiplierSuggestion()).toBe(Infinity);
  });

  it('mirrors the scrub bracket: isScrubbing + forwarded scrubstart/scrubend events', () => {
    const { source } = makeSource();
    const p = makePlayer();
    p.setSource(source);
    const starts: number[] = [];
    const ends: number[] = [];
    p.on('scrubstart', (t) => starts.push(t));
    p.on('scrubend', (t) => ends.push(t));

    expect(p.isScrubbing).toBe(false);
    p.beginScrub();
    expect(p.isScrubbing).toBe(true);
    expect(starts).toEqual([0]); // playhead at the grab

    p.scrubTo(4_000); // preview only — no bracket events
    expect(starts).toEqual([0]);
    expect(ends).toEqual([]);

    p.endScrub(4_000);
    expect(p.isScrubbing).toBe(false);
    expect(ends).toEqual([4_000]);
    expect(p.currentTime).toBe(4_000);
  });

  it('on() returns a working unsubscriber', () => {
    const { source, state } = makeSource();
    state.runwaySimMs = 1_000_000;
    const p = makePlayer();
    p.setSource(source);
    const onState = vi.fn();
    const unsubscribe = p.on('statechange', onState);
    unsubscribe();
    p.play();
    expect(p.state).toBe('playing');
    expect(onState).not.toHaveBeenCalled();
  });

  it('destroy is idempotent and tears down both wrapped pieces', () => {
    const { source, state } = makeSource();
    state.runwaySimMs = 1_000_000;
    const p = makePlayer();
    p.setSource(source);
    p.play();
    expect(p.timeController.isPlaying()).toBe(true);

    p.destroy();
    expect(p.governor.isDisposed).toBe(true);
    expect(p.timeController.isPlaying()).toBe(false);
    expect(() => p.destroy()).not.toThrow(); // safe to call twice

    // Post-destroy, events are inert (subscriptions removed, listeners cleared).
    const onTime = vi.fn();
    p.on('timeupdate', onTime);
    p.timeController.setTime(123); // direct poke — facade must not relay it
    expect(onTime).not.toHaveBeenCalled();
  });
});

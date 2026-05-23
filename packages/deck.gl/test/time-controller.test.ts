/**
 * TimeController tests: play/pause, loop, speed, tick throttling.
 *
 * The controller drives playback off requestAnimationFrame + performance.now().
 * Tests install controllable stubs for both so ticks can be stepped
 * deterministically without real time passing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TimeController } from '../src/time-controller';

/** Controllable rAF / performance.now harness. */
function installFrameHarness() {
  const state = { now: 0 };
  const callbacks: Array<(t: number) => void> = [];

  // performance.now is not always reassignable via globalThis; spy on the
  // method itself so the controller's `performance.now()` calls are stubbed.
  const perfSpy = vi.spyOn(performance, 'now').mockImplementation(() => state.now);

  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    callbacks.push(cb);
    return callbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});

  return {
    /** Advance virtual wall clock by `ms` and run all queued frames. */
    advance(ms: number) {
      state.now += ms;
      const pending = callbacks.splice(0, callbacks.length);
      for (const cb of pending) cb(state.now);
    },
    restore() {
      perfSpy.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}

describe('TimeController', () => {
  let harness: ReturnType<typeof installFrameHarness>;

  beforeEach(() => {
    harness = installFrameHarness();
  });
  afterEach(() => {
    harness.restore();
  });

  it('starts paused and reports initial time', () => {
    const tc = new TimeController({ initialTime: 1000 });
    expect(tc.isPlaying()).toBe(false);
    expect(tc.getTime()).toBe(1000);
  });

  it('play/pause toggles playing state', () => {
    const tc = new TimeController({ initialTime: 0 });
    tc.play();
    expect(tc.isPlaying()).toBe(true);
    tc.pause();
    expect(tc.isPlaying()).toBe(false);
    tc.toggle();
    expect(tc.isPlaying()).toBe(true);
    tc.toggle();
    expect(tc.isPlaying()).toBe(false);
  });

  it('advances time by elapsed * speed during playback', () => {
    const tc = new TimeController({ initialTime: 0, speed: 2 });
    tc.play();
    harness.advance(100); // 100ms elapsed * 2x speed = +200
    expect(tc.getTime()).toBeCloseTo(200, 0);
    harness.advance(50); // +100
    expect(tc.getTime()).toBeCloseTo(300, 0);
  });

  it('setSpeed changes the playback rate', () => {
    const tc = new TimeController({ initialTime: 0, speed: 1 });
    tc.play();
    harness.advance(100); // +100
    tc.setSpeed(4);
    harness.advance(100); // +400
    expect(tc.getTime()).toBeCloseTo(500, 0);
  });

  it('clamps and pauses at the end of range when loop is off', () => {
    const tc = new TimeController({
      initialTime: 0,
      speed: 1,
      loop: false,
      timeRange: { start: 0, end: 100 },
    });
    tc.play();
    harness.advance(250); // would overshoot end
    expect(tc.getTime()).toBe(100);
    expect(tc.isPlaying()).toBe(false);
  });

  it('wraps to range start when loop is on', () => {
    const tc = new TimeController({
      initialTime: 0,
      speed: 1,
      loop: true,
      timeRange: { start: 0, end: 100 },
    });
    tc.play();
    harness.advance(120); // overshoots end -> wraps
    expect(tc.getTime()).toBe(0);
    expect(tc.isPlaying()).toBe(true);
  });

  it('notifies tick listeners on every frame when throttling is off', () => {
    const tc = new TimeController({ initialTime: 0, speed: 1 });
    const listener = vi.fn();
    tc.on('tick', listener);
    tc.play(); // play() runs one synchronous tick -> 1 notification
    harness.advance(16);
    harness.advance(16);
    harness.advance(16);
    // 1 (play) + 3 (frames) with no throttling.
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('throttles tick notifications to tickThrottleMs', () => {
    const tc = new TimeController({ initialTime: 0, speed: 1, tickThrottleMs: 100 });
    const listener = vi.fn();
    tc.on('tick', listener);
    tc.play();

    // First eligible tick fires (throttle reset on play).
    harness.advance(20); // t=20
    // Sub-throttle frames are suppressed.
    harness.advance(20); // t=40
    harness.advance(20); // t=60
    const afterShortFrames = listener.mock.calls.length;
    expect(afterShortFrames).toBeLessThanOrEqual(1);

    // Cross the 100ms throttle boundary -> another notification.
    harness.advance(80); // t=120 (>= 100ms since last notify)
    expect(listener.mock.calls.length).toBeGreaterThan(afterShortFrames);
  });

  it('setTime / seek always notify immediately regardless of throttle', () => {
    const tc = new TimeController({ initialTime: 0, tickThrottleMs: 10_000 });
    const listener = vi.fn();
    tc.on('tick', listener);
    tc.seek(5000);
    expect(listener).toHaveBeenCalledWith(5000);
    expect(tc.getTime()).toBe(5000);
  });

  it('notifies play-state listeners on play and pause', () => {
    const tc = new TimeController({ initialTime: 0, speed: 3 });
    const stateListener = vi.fn();
    tc.on('playState', stateListener);
    tc.play();
    expect(stateListener).toHaveBeenCalledWith(true, 3);
    tc.pause();
    expect(stateListener).toHaveBeenCalledWith(false, 3);
  });

  it('off() removes a tick listener', () => {
    const tc = new TimeController({ initialTime: 0, speed: 1 });
    const listener = vi.fn();
    tc.on('tick', listener);
    tc.off('tick', listener);
    tc.play();
    harness.advance(16);
    expect(listener).not.toHaveBeenCalled();
  });

  it('seekBy advances time by a relative delta', () => {
    const tc = new TimeController({ initialTime: 1000 });
    tc.seekBy(250);
    expect(tc.getTime()).toBe(1250);
    tc.seekBy(-500);
    expect(tc.getTime()).toBe(750);
  });
});

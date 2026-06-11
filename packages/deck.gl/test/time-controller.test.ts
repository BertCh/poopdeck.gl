/**
 * TimeController tests: play/pause, loop, speed, tick throttling.
 *
 * The controller drives playback off requestAnimationFrame + performance.now().
 * Tests install controllable stubs for both so ticks can be stepped
 * deterministically without real time passing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TimeController } from '../src/playback/time-controller';

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

  it('bounces and reverses direction at the end of range (no teleport)', () => {
    const tc = new TimeController({
      initialTime: 90,
      speed: 1,
      bounce: true,
      timeRange: { start: 0, end: 100 },
    });
    tc.play(); // sync tick at 90, dt=0
    harness.advance(20); // 90 -> would be 110, reflects to 90, reverses
    expect(tc.getTime()).toBeCloseTo(90, 0);
    expect(tc.isPlaying()).toBe(true);
    harness.advance(20); // now moving backward: 90 -> 70
    expect(tc.getTime()).toBeCloseTo(70, 0);
  });

  it('bounces and reverses direction at the start of range', () => {
    const tc = new TimeController({
      initialTime: 10,
      speed: 1,
      bounce: true,
      timeRange: { start: 0, end: 100 },
    });
    // Seed backward motion, then let it cross the start boundary.
    tc.play();
    harness.advance(5); // 10 -> 15 (forward); flip to backward via overshoot below
    // Force a backward overshoot of start: jump near start moving forward is
    // awkward to set up, so drive it past end first to reverse, then to start.
    harness.advance(200); // overshoots end -> reflects, reverses to backward
    expect(tc.getTime()).toBeLessThanOrEqual(100);
    harness.advance(2000); // long backward run overshoots start -> reflects, forward
    expect(tc.getTime()).toBeGreaterThanOrEqual(0);
    expect(tc.getTime()).toBeLessThanOrEqual(100);
    expect(tc.isPlaying()).toBe(true);
  });

  it('setSpeed(negative) selects reverse; setSpeed(positive) restores forward outside bounce', () => {
    const tc = new TimeController({ initialTime: 0, speed: 1 });
    tc.setSpeed(-3);
    expect(tc.getSpeed()).toBe(-3);
    expect(tc.getDirection()).toBe(-1);
    // A positive magnitude restores forward travel — direction is not sticky
    // outside bounce mode.
    tc.setSpeed(2);
    expect(tc.getSpeed()).toBe(2);
    expect(tc.getDirection()).toBe(1);
  });

  it('setSpeed(positive) during a bounce return leg changes only the rate, never the direction', () => {
    const tc = new TimeController({
      initialTime: 90,
      speed: 1,
      bounce: true,
      timeRange: { start: 0, end: 100 },
    });
    tc.play();
    harness.advance(20); // reflects at end → travel flips to backward
    expect(tc.getDirection()).toBe(-1);
    expect(tc.getSpeed()).toBe(-1); // observable bounce contract: signed product

    // Speed slider pushes a positive magnitude mid-reverse: bounce owns the
    // direction, so only the rate changes.
    tc.setSpeed(2);
    expect(tc.getDirection()).toBe(-1);
    expect(tc.getSpeed()).toBe(-2);
    harness.advance(10); // still backward, at the new rate: 90 → 70
    expect(tc.getTime()).toBeCloseTo(70, 0);
  });

  it('setDirection announces playState while playing (a re-plan event), and only on change', () => {
    const tc = new TimeController({ initialTime: 0, speed: 2 });
    const stateListener = vi.fn();
    tc.on('playState', stateListener);
    tc.play();
    stateListener.mockClear();

    tc.setDirection(-1);
    expect(stateListener).toHaveBeenCalledTimes(1);
    expect(stateListener).toHaveBeenCalledWith(true, -2);
    tc.setDirection(-1); // same direction — no notification
    expect(stateListener).toHaveBeenCalledTimes(1);

    tc.pause();
    stateListener.mockClear();
    tc.setDirection(1); // silent while paused
    expect(tc.getDirection()).toBe(1);
    expect(stateListener).not.toHaveBeenCalled();
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

  it('on() returns an unsubscribe function', () => {
    const tc = new TimeController({ initialTime: 0, speed: 1 });
    const listener = vi.fn();
    const off = tc.on('tick', listener);
    off();
    tc.play();
    harness.advance(16);
    expect(listener).not.toHaveBeenCalled();
  });

  it('getTimeRange returns a defensive copy (or undefined when unconfigured)', () => {
    const tc = new TimeController({ timeRange: { start: 0, end: 100 } });
    const range = tc.getTimeRange()!;
    expect(range).toEqual({ start: 0, end: 100 });
    range.end = 5; // mutating the copy must not corrupt the controller
    expect(tc.getTimeRange()).toEqual({ start: 0, end: 100 });
    expect(new TimeController().getTimeRange()).toBeUndefined();
  });

  it('getState reports the signed speed and the separated direction', () => {
    const tc = new TimeController({ initialTime: 7, speed: -2 });
    expect(tc.getState()).toMatchObject({
      currentTime: 7,
      playing: false,
      speed: -2,
      direction: -1,
    });
  });

  it('seekBy advances time by a relative delta', () => {
    const tc = new TimeController({ initialTime: 1000 });
    tc.seekBy(250);
    expect(tc.getTime()).toBe(1250);
    tc.seekBy(-500);
    expect(tc.getTime()).toBe(750);
  });

  it('clamps a single frame delta to 250ms (background-tab refocus)', () => {
    const tc = new TimeController({ initialTime: 0, speed: 1 });
    tc.play();
    // The tab sat in the background for a minute: rAF was suspended, so the
    // first refocus frame sees the whole gap as one delta. Without the clamp
    // this teleports the playhead by 60_000 sim-ms.
    harness.advance(60_000);
    expect(tc.getTime()).toBe(250);
    // Normal frames advance normally afterwards.
    harness.advance(16);
    expect(tc.getTime()).toBe(266);
  });

  it('re-anchors the frame clock on visibilitychange so refocus advances ~0', () => {
    const fakeDocument = {
      visibilityState: 'visible' as 'visible' | 'hidden',
      listeners: new Map<string, () => void>(),
      addEventListener(event: string, cb: () => void) {
        this.listeners.set(event, cb);
      },
      removeEventListener(event: string) {
        this.listeners.delete(event);
      },
    };
    vi.stubGlobal('document', fakeDocument);
    const tc = new TimeController({ initialTime: 0, speed: 1 });
    // Listener lifetime tracks the rAF loop: registered on play, not construct.
    expect(fakeDocument.listeners.has('visibilitychange')).toBe(false);
    tc.play();
    expect(fakeDocument.listeners.has('visibilitychange')).toBe(true);
    harness.advance(16); // t=16

    // Tab hides for a minute; the browser fires visibilitychange on refocus
    // BEFORE the next rAF callback runs.
    harness.advance(60_000); // wall clock moves; rAF queue would run, but the
    // visibilitychange handler re-anchored first in a real browser. Emulate
    // the ordering: re-anchor, then run a fresh frame.
    fakeDocument.listeners.get('visibilitychange')!();
    harness.advance(16);
    // Only the post-re-anchor frame advanced time (the 60s frame ran before
    // re-anchoring and was bounded by the clamp).
    expect(tc.getTime()).toBeLessThanOrEqual(16 + 250 + 16);

    // destroy() unregisters the handler.
    tc.destroy();
    expect(fakeDocument.listeners.has('visibilitychange')).toBe(false);
  });

  it('notifies wrap listeners on a loop wrap (not on plain ticks)', () => {
    const tc = new TimeController({
      initialTime: 0,
      speed: 1,
      loop: true,
      timeRange: { start: 0, end: 100 },
    });
    const wrap = vi.fn();
    tc.on('wrap', wrap);
    tc.play();
    harness.advance(50); // mid-range — no wrap
    expect(wrap).not.toHaveBeenCalled();
    harness.advance(70); // overshoots end → wraps to start
    expect(wrap).toHaveBeenCalledTimes(1);
    expect(wrap).toHaveBeenCalledWith(0);
    tc.off('wrap', wrap);
    harness.advance(120); // wraps again, but the listener is gone
    expect(wrap).toHaveBeenCalledTimes(1);
  });

  it('notifies wrap listeners on a backward loop wrap', () => {
    const tc = new TimeController({
      initialTime: 50,
      speed: -1,
      loop: true,
      timeRange: { start: 0, end: 100 },
    });
    const wrap = vi.fn();
    tc.on('wrap', wrap);
    tc.play();
    harness.advance(70); // undershoots start → wraps to end
    expect(wrap).toHaveBeenCalledTimes(1);
    expect(wrap).toHaveBeenCalledWith(100);
  });

  it('a wrap listener that pauses and resumes does not fork a second rAF loop', () => {
    const tc = new TimeController({
      initialTime: 0,
      speed: 1,
      loop: true,
      timeRange: { start: 0, end: 100 },
    });
    // Governor-shaped listener: a wrap gate that passes instantly pauses and
    // immediately resumes the clock from INSIDE tick(). The re-entrant play()
    // must not run a second synchronous tick, or two rAF loops each advance
    // time every frame (2× speed).
    tc.on('wrap', () => {
      tc.pause();
      tc.play();
    });
    tc.play();
    harness.advance(120); // wrap fires
    const t0 = tc.getTime();
    harness.advance(20); // exactly one queued frame must advance time
    expect(tc.getTime() - t0).toBeCloseTo(20, 0);
  });

  it("fires 'ended' (with the clamp time) on a forward non-loop clamp", () => {
    const tc = new TimeController({
      initialTime: 0,
      speed: 1,
      loop: false,
      timeRange: { start: 0, end: 100 },
    });
    const ended = vi.fn();
    tc.on('ended', ended);
    tc.play();
    harness.advance(250); // overshoots end → clamps + pauses
    expect(tc.getTime()).toBe(100);
    expect(tc.isPlaying()).toBe(false);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledWith(100);
  });

  it("fires 'ended' on a backward non-loop clamp at the range start", () => {
    const tc = new TimeController({
      initialTime: 50,
      speed: -1,
      loop: false,
      timeRange: { start: 0, end: 100 },
    });
    const ended = vi.fn();
    tc.on('ended', ended);
    tc.play();
    harness.advance(70); // undershoots start → clamps + pauses
    expect(tc.getTime()).toBe(0);
    expect(tc.isPlaying()).toBe(false);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledWith(0);
  });

  it("does not fire 'ended' on a loop wrap or a bounce reflection", () => {
    const ended = vi.fn();

    const looper = new TimeController({
      initialTime: 0,
      speed: 1,
      loop: true,
      timeRange: { start: 0, end: 100 },
    });
    looper.on('ended', ended);
    looper.play();
    harness.advance(120); // wraps — playback continues
    expect(looper.isPlaying()).toBe(true);
    looper.destroy();

    const bouncer = new TimeController({
      initialTime: 0,
      speed: 1,
      bounce: true,
      timeRange: { start: 0, end: 100 },
    });
    bouncer.on('ended', ended);
    bouncer.play();
    harness.advance(120); // reflects — playback continues
    expect(bouncer.isPlaying()).toBe(true);
    bouncer.destroy();

    expect(ended).not.toHaveBeenCalled();
  });
});

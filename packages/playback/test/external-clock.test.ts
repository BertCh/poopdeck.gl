/**
 * External-driver mode: the controller can hand its per-frame advance to a host
 * render loop (deck.gl's animation loop via `advanceFrame()`) instead of its own
 * requestAnimationFrame, so the playhead and the GPU draw share one frame clock.
 *
 * The harness stubs rAF + performance.now so frames step deterministically. The
 * stubbed `cancelAnimationFrame` actually removes the queued callback (unlike a
 * no-op) so "is the internal loop scheduled?" can be asserted via pendingFrames.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TimeController } from '../src/time-controller';

function installFrameHarness() {
  const state = { now: 0, nextId: 1 };
  const cbs = new Map<number, (t: number) => void>();
  const perfSpy = vi
    .spyOn(performance, 'now')
    .mockImplementation(() => state.now);

  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    const id = state.nextId++;
    cbs.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    cbs.delete(id);
  });

  return {
    /** Advance the virtual wall clock by `ms` and run all queued frames. */
    advance(ms: number) {
      state.now += ms;
      const pending = [...cbs.values()];
      cbs.clear();
      for (const cb of pending) cb(state.now);
    },
    /** Advance the virtual wall clock by `ms` WITHOUT running queued frames. */
    setNow(ms: number) {
      state.now += ms;
    },
    /** How many internal rAF callbacks are currently scheduled. */
    pendingFrames: () => cbs.size,
    restore() {
      perfSpy.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}

describe('TimeController external-driver mode', () => {
  let h: ReturnType<typeof installFrameHarness>;
  beforeEach(() => {
    h = installFrameHarness();
  });
  afterEach(() => {
    h.restore();
  });

  it('play() does not start the internal rAF when an external clock is attached', () => {
    const tc = new TimeController({ initialTime: 0, speed: 1 });
    tc.attachExternalClock();
    tc.play();
    expect(tc.isPlaying()).toBe(true);
    expect(h.pendingFrames()).toBe(0);
  });

  it('advanceFrame() advances by elapsed × speed × direction', () => {
    const tc = new TimeController({ initialTime: 0, speed: 2 });
    tc.attachExternalClock();
    tc.play();
    h.setNow(100); // 100ms elapsed × 2× = +200
    tc.advanceFrame();
    expect(tc.getTime()).toBeCloseTo(200, 0);
    h.setNow(50); // +100
    tc.advanceFrame();
    expect(tc.getTime()).toBeCloseTo(300, 0);
    // The internal loop never scheduled itself.
    expect(h.pendingFrames()).toBe(0);
  });

  it('advanceFrame() is a no-op while paused', () => {
    const tc = new TimeController({ initialTime: 500, speed: 1 });
    tc.attachExternalClock();
    h.setNow(100);
    tc.advanceFrame();
    expect(tc.getTime()).toBe(500);
  });

  it('advanceFrame() is a no-op when no external clock is attached', () => {
    const tc = new TimeController({ initialTime: 500, speed: 1 });
    // Not attached, not playing.
    tc.advanceFrame();
    expect(tc.getTime()).toBe(500);
  });

  it('attachExternalClock() while playing cancels the internal rAF loop', () => {
    const tc = new TimeController({ initialTime: 0, speed: 1 });
    tc.play(); // internal mode → schedules one frame
    expect(h.pendingFrames()).toBe(1);
    tc.attachExternalClock();
    expect(h.pendingFrames()).toBe(0); // internal loop cancelled, host takes over
  });

  it('detachExternalClock() while playing restarts the internal rAF loop', () => {
    const tc = new TimeController({ initialTime: 0, speed: 1 });
    tc.attachExternalClock();
    tc.play();
    expect(h.pendingFrames()).toBe(0); // external: no internal rAF
    tc.detachExternalClock();
    expect(h.pendingFrames()).toBe(1); // internal loop resumed
  });

  it('preserves bounce boundary handling under advanceFrame()', () => {
    const tc = new TimeController({
      initialTime: 90,
      speed: 1,
      timeRange: { start: 0, end: 100 },
      bounce: true,
    });
    tc.attachExternalClock();
    tc.play();
    h.setNow(20); // 90 + 20 = 110 overshoots end=100 → reflect to 90, reverse
    tc.advanceFrame();
    expect(tc.getDirection()).toBe(-1);
    expect(tc.getTime()).toBeCloseTo(90, 0);
  });

  it('preserves loop wrap (+ wrap event) under advanceFrame()', () => {
    const tc = new TimeController({
      initialTime: 95,
      speed: 1,
      timeRange: { start: 0, end: 100 },
      loop: true,
    });
    const wraps: number[] = [];
    tc.on('wrap', (t) => wraps.push(t));
    tc.attachExternalClock();
    tc.play();
    h.setNow(10); // 95 + 10 = 105 > end → wrap to start
    tc.advanceFrame();
    expect(tc.getTime()).toBeCloseTo(0, 0);
    expect(wraps.length).toBe(1);
  });
});

/**
 * Per-frame coalescing. deck.gl's React wrapper redraws SYNCHRONOUSLY from a
 * dependency-less layout effect, so `onBeforeRender` — and therefore
 * `advanceFrame()` — fires once per React COMMIT, not once per frame. The
 * controller must still advance once per frame: without that, a state change a
 * tick produces re-enters React from inside its own commit → render → draw →
 * tick chain, which React reports as "Maximum update depth exceeded".
 *
 * The frame identity comes from `document.timeline.currentTime`, which the
 * browser holds constant for every task between two rendering opportunities.
 */
describe('TimeController advanceFrame coalescing', () => {
  let h: ReturnType<typeof installFrameHarness>;
  const timeline = { currentTime: 0 };

  beforeEach(() => {
    h = installFrameHarness();
    timeline.currentTime = 1000;
    vi.stubGlobal('document', {
      timeline,
      visibilityState: 'visible',
      addEventListener: () => {},
      removeEventListener: () => {},
    });
  });
  afterEach(() => {
    h.restore();
  });

  it('advances once per frame however many times the host draws', () => {
    const tc = new TimeController({ initialTime: 0, speed: 1 });
    tc.attachExternalClock();
    tc.play();

    // One frame, three draws (the React commit chain deck.gl redraws from).
    h.setNow(16);
    tc.advanceFrame();
    h.setNow(4); // wall time DOES pass between commits — it must not be billed
    tc.advanceFrame();
    h.setNow(4);
    tc.advanceFrame();
    expect(tc.getTime()).toBeCloseTo(16, 0);

    // Next frame: one draw, and the skipped wall time is still billed — the
    // step integrates from the last ACCEPTED advance, so no sim-time is lost.
    timeline.currentTime += 16;
    h.setNow(8);
    tc.advanceFrame();
    expect(tc.getTime()).toBeCloseTo(32, 0);
  });

  it('lets a listener draw re-entrantly without advancing again', () => {
    const tc = new TimeController({ initialTime: 0, speed: 1 });
    tc.attachExternalClock();
    tc.play();
    // The shape of the crash: a tick listener changes React state, the render
    // draws deck.gl, and the draw calls back in — inside the same frame.
    let reentries = 0;
    tc.on('tick', () => {
      if (reentries++ > 3) return;
      h.setNow(1);
      tc.advanceFrame();
    });
    h.setNow(16);
    tc.advanceFrame();
    expect(reentries).toBe(1); // the re-entrant draws never reached _step
    expect(tc.getTime()).toBeCloseTo(16, 0);
  });

  it('a fresh attach is never suppressed by the frame it attaches in', () => {
    const tc = new TimeController({ initialTime: 0, speed: 1 });
    tc.attachExternalClock();
    tc.play();
    h.setNow(16);
    tc.advanceFrame();
    expect(tc.getTime()).toBeCloseTo(16, 0);
    // Same frame: a surface unmounts and another mounts onto the same clock.
    tc.detachExternalClock();
    tc.attachExternalClock();
    h.setNow(8);
    tc.advanceFrame();
    expect(tc.getTime()).toBeCloseTo(24, 0);
  });
});

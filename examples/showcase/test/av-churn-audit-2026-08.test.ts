/**
 * /drive React churn (tile-loading audit 2026-08, showcase report; measured
 * on av-synthetic with a real GPU by a sibling session):
 *
 *   (a) `AvDeck` published `setEgoTime` on every 60 Hz controller tick —
 *       CONFIRMED as the dominant commit source (119 commits/s × ~440
 *       components); at 10 Hz it is 18.8 commits/s. Frame rate did not move
 *       (display-capped), so this is main-thread headroom, not fps.
 *   (b) `MetricCharts` rebuilt a ~1,300-point SVG `d` per field per tick —
 *       INFERRED, not profiled. Fix: memoize per visible index range, scroll
 *       by translate, decimate to ≤ 2× the strip width.
 *   (c) `AvCockpitImpl`'s inline `resolveFrameUrl` arrow was a `useEffect`
 *       dep in `CameraInset`, re-subscribing a tick listener per render —
 *       INFERRED. Fix: `useCallback`. Pinned at the source level (the
 *       showcase test env has no DOM renderer).
 *
 * The showcase test env is `node` with no DOM / testing-library, so (a) and
 * (b) are pinned on the pure helpers the components now delegate to.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  UI_TICK_INTERVAL_MS,
  subscribeThrottledTick,
} from '../src/components/av/throttledTick';
import {
  HOLD_WINDOWS,
  buildTracePath,
  createTraceCache,
  decimateIndices,
  traceOffset,
  type Samples,
  type TraceGeometry,
} from '../src/components/av/stripTrace';

/** Minimal TimeController double: `on('tick' | 'playState')` + `getTime`. */
function fakeController(t0 = 0) {
  const ticks = new Set<(t: number) => void>();
  const plays = new Set<(playing: boolean, speed: number) => void>();
  let time = t0;
  return {
    on(event: string, cb: unknown) {
      const set = event === 'tick' ? ticks : plays;
      set.add(cb as never);
      return () => set.delete(cb as never);
    },
    getTime: () => time,
    tick(t: number) {
      time = t;
      for (const cb of ticks) cb(t);
    },
    pause() {
      for (const cb of plays) cb(false, 0);
    },
    listeners: () => ticks.size + plays.size,
  } as const;
}

describe('(a) AvDeck ego tick is throttled to the 10 Hz UI clock', () => {
  it('publishes ≤ 1 per interval across a 60 Hz second, and the first tick immediately', () => {
    const c = fakeController();
    let wall = 0;
    const seen: number[] = [];
    const off = subscribeThrottledTick(
      c as never,
      (t) => seen.push(t),
      UI_TICK_INTERVAL_MS,
      () => wall,
    );
    for (let i = 0; i < 60; i++) {
      wall = (i * 1000) / 60;
      c.tick(i);
    }
    // 60 ticks → at most ceil(1000 / 100) + 1 publishes; before the fix every
    // tick published (60).
    expect(seen.length).toBeLessThanOrEqual(11);
    expect(seen.length).toBeGreaterThanOrEqual(10);
    expect(seen[0]).toBe(0);
    off();
    expect(c.listeners()).toBe(0);
  });

  it('a pause flushes the exact stop time even inside the throttle interval', () => {
    const c = fakeController();
    let wall = 0;
    const seen: number[] = [];
    subscribeThrottledTick(
      c as never,
      (t) => seen.push(t),
      100,
      () => wall,
    );
    c.tick(0); // publishes (first)
    wall = 30;
    c.tick(5); // suppressed
    c.pause(); // flush the controller's current time
    expect(seen).toEqual([0, 5]);
  });

  it('UI_TICK_INTERVAL_MS is the same 10 Hz rule usePlayback applies', () => {
    expect(UI_TICK_INTERVAL_MS).toBe(100);
  });
});

/** A ~160 Hz telemetry field over 10 s — ~1,300 samples in an 8 s window. */
function denseSamples(n = 1600, dtMs = 6.25): Samples {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = i * dtMs;
    out.push([t, Math.sin(t / 300) * 10 + (i % 37 === 0 ? 4 : 0)]);
  }
  return out;
}

const W = 220;
const geom: TraceGeometry = {
  W,
  windowMs: 8000,
  yOf: (v) => 30 - v,
  maxPoints: 2 * W,
};

describe('(b) MetricCharts strip trace: decimated and memoized per visible range', () => {
  const samples = denseSamples();
  const end = samples.length - 1;
  const start = end - 1279; // 1,280 visible samples, as an 8 s window at 160 Hz

  it('a 1,280-sample window is drawn with ≤ 2 × W points, keeping its extrema', () => {
    const idx = decimateIndices(samples, start, end, geom.maxPoints);
    expect(idx.length).toBeLessThanOrEqual(geom.maxPoints);
    expect(idx.length).toBeGreaterThan(geom.maxPoints / 2);
    // Time-ordered, unique, inside the range.
    for (let i = 1; i < idx.length; i++)
      expect(idx[i]).toBeGreaterThan(idx[i - 1]);
    expect(idx[0]).toBeGreaterThanOrEqual(start);
    expect(idx[idx.length - 1]).toBeLessThanOrEqual(end);
    let min = Infinity;
    let max = -Infinity;
    let iMin = -1;
    let iMax = -1;
    for (let i = start; i <= end; i++) {
      const v = samples[i][1];
      if (v < min) {
        min = v;
        iMin = i;
      }
      if (v > max) {
        max = v;
        iMax = i;
      }
    }
    expect(idx).toContain(iMin);
    expect(idx).toContain(iMax);
    // Under the budget nothing is dropped.
    expect(decimateIndices(samples, 10, 50, geom.maxPoints)).toHaveLength(41);
  });

  it('the d string is rebuilt only when the visible index range changes', () => {
    const cache = createTraceCache(samples, geom);
    const a = cache.get(start, end);
    const b = cache.get(start, end);
    expect(b).toBe(a);
    expect(cache.builds).toBe(1);
    const c = cache.get(start - 1, end - 1);
    expect(c).not.toBe(a);
    expect(cache.builds).toBe(2);
    expect(a.d.split('L').length).toBeLessThanOrEqual(geom.maxPoints + 1);
    expect(a.d.startsWith('M')).toBe(true);
    expect(
      a.d.endsWith(
        `L${HOLD_WINDOWS * W} ${geom.yOf(samples[end][1]).toFixed(1)}`,
      ),
    ).toBe(true);
  });

  it('trace frame + translate reproduces the per-tick right-pinned window', () => {
    const t = samples[end][0] + 3; // playhead just past the last sample
    const trace = createTraceCache(samples, geom).get(start, end);
    const dx = traceOffset(trace.tBase, t, geom.windowMs, W);
    const firstX = Number(/^M(-?[\d.]+)/.exec(trace.d)![1]);
    const expectedFirstX =
      ((samples[start][0] - (t - geom.windowMs)) / geom.windowMs) * W;
    expect(firstX + dx).toBeCloseTo(expectedFirstX, 1);
    // An empty range draws nothing.
    expect(buildTracePath(samples, 5, 4, 0, geom)).toBe('');
  });
});

describe('(c) AvCockpitImpl.resolveFrameUrl is referentially stable', () => {
  it('is a useCallback keyed on the dataset, not an inline arrow', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/pages/AvCockpitImpl.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).not.toMatch(/const resolveFrameUrl = \(rel: string\) =>/);
    expect(src).toMatch(/const resolveFrameUrl = useCallback\(/);
  });
});

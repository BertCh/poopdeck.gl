/**
 * Strip-chart trace geometry for the AV cockpit's telemetry panel.
 *
 * The panel's `Strip` used to rebuild a ~1,300-point SVG `d` string per field
 * per rAF tick — ~5× oversampled for a ~256 px strip and rebuilt even when the
 * playhead had not crossed a new sample (tile-loading audit 2026-08, /drive
 * React churn; INFERRED from the code, not profiled). Two changes, both pure:
 *
 * 1. The trace is built in a frame anchored at `tBase` (the first visible
 *    sample) and memoized per visible index range `[start, end]`; scrolling is
 *    a per-tick `translate(dx 0)` on the `<path>`, so the string is rebuilt
 *    only when a sample enters or leaves the window.
 * 2. When the window holds more than `maxPoints` samples they are decimated
 *    by min/max per column (≤ 2 points per column, time-ordered), which keeps
 *    every extremum a 1.5 px stroke could show.
 */

/** `[t, v]` telemetry samples, ascending in `t`. */
export type Samples = readonly (readonly [number, number])[];

export interface TraceGeometry {
  /** Strip width in SVG user units. */
  W: number;
  /** Moving-window span (ms) mapped onto `W`. */
  windowMs: number;
  /** value → y (already domain-scaled by the caller). */
  yOf: (v: number) => number;
  /** Point budget for one trace; ≥ 2 × the strip's pixel width is invisible. */
  maxPoints: number;
}

/**
 * Where the right-edge "hold last value" segment ends, in trace units. The
 * playhead sits at `(t − tBase) / windowMs × W` in the trace frame and keeps
 * moving right while no new sample arrives; a hold far past any plausible gap
 * (5,000 windows) is clipped by the SVG, so it reads as "reaches the cursor"
 * without a per-tick rebuild.
 */
export const HOLD_WINDOWS = 5000;

/**
 * Sample indices to draw for `[start, end]`, decimated to ≤ `maxPoints` by
 * min/max per column. Below the budget every index is returned.
 */
export function decimateIndices(
  samples: Samples,
  start: number,
  end: number,
  maxPoints: number,
): number[] {
  const n = end - start + 1;
  const out: number[] = [];
  if (n <= 0) return out;
  if (n <= maxPoints) {
    for (let i = start; i <= end; i++) out.push(i);
    return out;
  }
  const columns = Math.max(1, Math.floor(maxPoints / 2));
  for (let c = 0; c < columns; c++) {
    const a = start + Math.floor((c * n) / columns);
    const b = start + Math.floor(((c + 1) * n) / columns) - 1;
    if (b < a) continue;
    let iMin = a;
    let iMax = a;
    for (let i = a + 1; i <= b; i++) {
      const v = samples[i][1];
      if (v < samples[iMin][1]) iMin = i;
      if (v > samples[iMax][1]) iMax = i;
    }
    if (iMin === iMax) out.push(iMin);
    else if (iMin < iMax) out.push(iMin, iMax);
    else out.push(iMax, iMin);
  }
  return out;
}

/**
 * The `d` string for `[start, end]` in the trace frame (x = 0 at `tBase`),
 * ending with the right-edge hold. Empty when the range is empty.
 */
export function buildTracePath(
  samples: Samples,
  start: number,
  end: number,
  tBase: number,
  geom: TraceGeometry,
): string {
  if (end < start || samples.length === 0) return '';
  const { W, windowMs, yOf, maxPoints } = geom;
  let d = '';
  let first = true;
  for (const i of decimateIndices(samples, start, end, maxPoints)) {
    const x = ((samples[i][0] - tBase) / windowMs) * W;
    const y = yOf(samples[i][1]);
    d += `${first ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    first = false;
  }
  const lastY = yOf(samples[end][1]);
  d += `L${(HOLD_WINDOWS * W).toFixed(0)} ${lastY.toFixed(1)}`;
  return d;
}

/**
 * Horizontal offset that scrolls a trace built at `tBase` so its samples sit
 * where a window `[t − windowMs, t]` pinned at the right edge would put them:
 * `x_trace + dx = (sample_t − (t − windowMs)) / windowMs × W`.
 */
export function traceOffset(
  tBase: number,
  t: number,
  windowMs: number,
  W: number,
): number {
  return ((tBase - (t - windowMs)) / windowMs) * W;
}

export interface Trace {
  d: string;
  tBase: number;
}

/**
 * Memoized trace per visible index range. `get` returns the SAME object while
 * `[start, end]` is unchanged, so a caller can skip the `d` write by identity.
 */
export function createTraceCache(samples: Samples, geom: TraceGeometry) {
  let key0 = -1;
  let key1 = -2;
  let trace: Trace = { d: '', tBase: 0 };
  let builds = 0;
  return {
    get(start: number, end: number): Trace {
      if (start === key0 && end === key1) return trace;
      key0 = start;
      key1 = end;
      builds++;
      if (end < start || samples.length === 0) {
        trace = { d: '', tBase: 0 };
      } else {
        const tBase = samples[start][0];
        trace = { d: buildTracePath(samples, start, end, tBase, geom), tBase };
      }
      return trace;
    },
    /** Number of `d` rebuilds so far (test hook). */
    get builds() {
      return builds;
    },
  };
}

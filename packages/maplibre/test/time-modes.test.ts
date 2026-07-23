/**
 * Oracle-parity tests for the wake + cumulative time modes (campaign D8).
 *
 * `shaders/time-window.glsl.ts` carries hand-written GLSL plus a JS reference
 * impl per mode. The GLSL is what ships; the JS reference is what we can test.
 * The contract pinned here is three-way:
 *
 *   1. JS reference  ==  core `time-filter.ts` (THE oracle) — exactly, in
 *      double math, across a dense sweep including every boundary.
 *   2. JS reference  ==  core `shader-codegen.ts`'s `evalExpr(ALPHA_EXPR[mode])`
 *      (the second, branchless oracle the other backends emit from).
 *   3. GLSL source   ==  JS reference, by structural lock (the GLSL cannot be
 *      executed here — no GL context — so the formula lines are asserted
 *      verbatim; editing one without the other fails).
 *
 * Both oracles disagree with each other at two out-of-contract inputs
 * (`wakeLength <= 0`, negative `fadeIn`); those points are pinned explicitly
 * below rather than avoided, so a change in either oracle surfaces here.
 */

import { describe, it, expect } from 'vitest';
import {
  TIME_WAKE_GLSL,
  TIME_CUMULATIVE_GLSL,
  TIME_WINDOW_GLSL,
  TIME_TRAIL_GLSL,
  wakeAlphaJS,
  wakeSizeScaleJS,
  cumulativeAlphaJS,
} from '../src/shaders/time-window.glsl';
import {
  wakeAlpha,
  cumulativeAlpha,
  wakeSizeScale,
  timeFilterAlpha,
  MAX_RELATIVE_TIME_MS,
  DEFAULT_WAKE_TAIL_SCALE,
} from '@poopdeck.gl/core/time-filter';
import { ALPHA_EXPR, evalExpr } from '@poopdeck.gl/core/shader-codegen';

/** Tile-relative "now" values the sweeps run against, incl. the f32 ceiling. */
const CURRENT_TIMES = [
  0,
  1,
  -1,
  1000,
  -2500.5,
  12345.678,
  1e6,
  MAX_RELATIVE_TIME_MS / 2,
];
/** Mode lengths/fades: sub-ms, ms, minute, hour — plus the degenerate 0. */
const DURATIONS = [0.5, 1, 7, 100, 1000, 60_000, 3_600_000];
/** Age multipliers relative to a duration: before, at both edges, past, far. */
const AGE_FACTORS = [
  -2, -1, -0.001, 0, 0.001, 0.25, 0.5, 0.999, 1, 1.001, 2, 5,
];

describe('wake mode — JS reference vs core time-filter oracle', () => {
  it('agrees exactly across a dense (currentTime × wakeLength × age) sweep', () => {
    let cases = 0;
    for (const currentTime of CURRENT_TIMES) {
      for (const wakeLength of DURATIONS) {
        for (const f of AGE_FACTORS) {
          const startTime = currentTime - wakeLength * f;
          const got = wakeAlphaJS(startTime, currentTime, wakeLength);
          const want = wakeAlpha(currentTime, startTime, wakeLength);
          // Exact: both derive `age` with the identical subtraction, so there
          // is no rounding slack to absorb.
          expect(got).toBe(want);
          cases++;
        }
      }
    }
    expect(cases).toBe(
      CURRENT_TIMES.length * DURATIONS.length * AGE_FACTORS.length,
    );
  });

  it('agrees with the `timeFilterAlpha` dispatcher (mode routing)', () => {
    for (const currentTime of CURRENT_TIMES) {
      for (const wakeLength of DURATIONS) {
        for (const f of AGE_FACTORS) {
          const startTime = currentTime - wakeLength * f;
          expect(wakeAlphaJS(startTime, currentTime, wakeLength)).toBe(
            timeFilterAlpha('wake', currentTime, startTime, startTime + 5, {
              wakeLength,
            }),
          );
        }
      }
    }
  });

  it('pins the boundary values (head, tail, both sides of each edge)', () => {
    const L = 1000;
    const now = 5000;
    expect(wakeAlphaJS(now, now, L)).toBe(1); // age == 0 → head, full alpha
    expect(wakeAlphaJS(now - L / 2, now, L)).toBe(0.5); // mid-wake
    expect(wakeAlphaJS(now - L, now, L)).toBe(0); // age == wakeLength → tail
    expect(wakeAlphaJS(now - L - 1e-6, now, L)).toBe(0); // just past the tail
    expect(wakeAlphaJS(now + 1e-6, now, L)).toBe(0); // future feature
    expect(wakeAlphaJS(now + 1e9, now, L)).toBe(0); // far future
    expect(wakeAlphaJS(now - 1e9, now, L)).toBe(0); // long dead
  });

  it('ignores endTime (deck reads only instanceStartTime in wake mode)', () => {
    const now = 1000;
    for (const endTime of [-1e9, 0, now, now + 1e9]) {
      expect(
        timeFilterAlpha('wake', now, now - 250, endTime, { wakeLength: 1000 }),
      ).toBe(wakeAlphaJS(now - 250, now, 1000));
    }
  });

  it('DOCUMENTED DIVERGENCE: wakeLength <= 0 returns 0, never NaN', () => {
    const now = 1000;
    // Non-positive length is out of contract (layers select wake only when
    // wakeLength > 0). We return 0; the codegen oracle agrees for every input;
    // core's scalar oracle agrees everywhere EXCEPT age == 0, where it divides
    // 0/0. Pinned so a change to either oracle is loud.
    for (const L of [0, -1, -1000]) {
      for (const age of [-10, -1, 1, 10, 1e6]) {
        expect(wakeAlphaJS(now - age, now, L)).toBe(0);
        expect(wakeAlpha(now, now - age, L)).toBe(0);
        expect(
          evalExpr(ALPHA_EXPR.wake, {
            currentTime: now,
            startTime: now - age,
            wakeLength: L,
          }),
        ).toBe(0);
      }
    }
    expect(wakeAlphaJS(now, now, 0)).toBe(0);
    expect(Number.isNaN(wakeAlpha(now, now, 0))).toBe(true); // core: 0/0
    expect(
      evalExpr(ALPHA_EXPR.wake, {
        currentTime: now,
        startTime: now,
        wakeLength: 0,
      }),
    ).toBe(0);
  });
});

describe('wake tail size multiplier', () => {
  it('matches core `wakeSizeScale` across alpha × tailScale', () => {
    for (const tail of [0, 0.1, DEFAULT_WAKE_TAIL_SCALE, 0.5, 1]) {
      for (const a of [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1]) {
        expect(wakeSizeScaleJS(a, tail)).toBe(wakeSizeScale(a, tail));
      }
    }
  });

  it('is full size at the head and `wakeTailScale` at the tail', () => {
    expect(wakeSizeScaleJS(1, DEFAULT_WAKE_TAIL_SCALE)).toBe(1);
    expect(wakeSizeScaleJS(0, DEFAULT_WAKE_TAIL_SCALE)).toBe(
      DEFAULT_WAKE_TAIL_SCALE,
    );
  });
});

describe('cumulative mode — JS reference vs core time-filter oracle', () => {
  const FADES = [0, 0.5, 1, 100, 1000, 3_600_000];

  it('agrees exactly across a dense (currentTime × fadeIn × elapsed) sweep', () => {
    for (const currentTime of CURRENT_TIMES) {
      for (const fadeIn of FADES) {
        for (const f of AGE_FACTORS) {
          // elapsed spans before-start (negative) through far-past-the-ramp.
          const startTime = currentTime - Math.max(fadeIn, 1) * f;
          expect(cumulativeAlphaJS(startTime, currentTime, fadeIn)).toBe(
            cumulativeAlpha(currentTime, startTime, fadeIn),
          );
          expect(cumulativeAlphaJS(startTime, currentTime, fadeIn)).toBe(
            timeFilterAlpha(
              'cumulative',
              currentTime,
              startTime,
              startTime + 5,
              { fadeIn },
            ),
          );
        }
      }
    }
  });

  it('pins the reveal boundary and the ramp', () => {
    const now = 10_000;
    expect(cumulativeAlphaJS(now + 1e-6, now, 0)).toBe(0); // not yet born
    expect(cumulativeAlphaJS(now + 1e9, now, 1000)).toBe(0); // far future
    expect(cumulativeAlphaJS(now, now, 0)).toBe(1); // exactly at start, hard pop
    expect(cumulativeAlphaJS(now, now, 1000)).toBe(0); // exactly at start, ramping
    expect(cumulativeAlphaJS(now - 250, now, 1000)).toBe(0.25); // mid-ramp
    expect(cumulativeAlphaJS(now - 1000, now, 1000)).toBe(1); // ramp complete
    expect(cumulativeAlphaJS(now - 1e9, now, 1000)).toBe(1); // persists forever
  });

  it('zero fade is a hard pop-in; a fade longer than the elapsed span still ramps', () => {
    const now = 0;
    expect(cumulativeAlphaJS(-1, now, 0)).toBe(1);
    // fadeIn wider than the whole dataset span: alpha stays proportional.
    expect(cumulativeAlphaJS(-1, now, 1e9)).toBeCloseTo(1e-9, 15);
  });

  it('ignores endTime (deck ignores instanceEndTime in cumulative mode)', () => {
    const now = 1000;
    for (const endTime of [-1e9, 0, now, now + 1e9]) {
      expect(
        timeFilterAlpha('cumulative', now, now - 500, endTime, { fadeIn: 100 }),
      ).toBe(cumulativeAlphaJS(now - 500, now, 100));
    }
  });

  it('DOCUMENTED DIVERGENCE: negative fadeIn follows core (1), not the AST (0)', () => {
    // `resolveFadeDurations` clamps fades at 0 before they reach a uniform, so
    // this input cannot occur in the layer path. core `cumulativeAlpha` gates
    // on `fadeIn > 0`; the codegen AST gates on `fadeIn != 0`. We follow core.
    const now = 1000;
    expect(cumulativeAlphaJS(now - 500, now, -100)).toBe(1);
    expect(cumulativeAlpha(now, now - 500, -100)).toBe(1);
    expect(
      evalExpr(ALPHA_EXPR.cumulative, {
        currentTime: now,
        startTime: now - 500,
        fadeIn: -100,
      }),
    ).toBe(0);
  });
});

describe('codegen AST parity (the second oracle)', () => {
  it('wake: evalExpr(ALPHA_EXPR.wake) == wakeAlphaJS over the sweep', () => {
    for (const currentTime of CURRENT_TIMES) {
      for (const wakeLength of DURATIONS) {
        for (const f of AGE_FACTORS) {
          const startTime = currentTime - wakeLength * f;
          expect(
            evalExpr(ALPHA_EXPR.wake, { currentTime, startTime, wakeLength }),
          ).toBeCloseTo(wakeAlphaJS(startTime, currentTime, wakeLength), 12);
        }
      }
    }
  });

  it('cumulative: evalExpr(ALPHA_EXPR.cumulative) == cumulativeAlphaJS over the sweep', () => {
    for (const currentTime of CURRENT_TIMES) {
      for (const fadeIn of [0, 1, 100, 1000, 3_600_000]) {
        for (const f of AGE_FACTORS) {
          const startTime = currentTime - Math.max(fadeIn, 1) * f;
          expect(
            evalExpr(ALPHA_EXPR.cumulative, { currentTime, startTime, fadeIn }),
          ).toBeCloseTo(cumulativeAlphaJS(startTime, currentTime, fadeIn), 12);
        }
      }
    }
  });
});

describe('GLSL ↔ JS reference structural lock', () => {
  it('wake GLSL states the same formula as wakeAlphaJS', () => {
    expect(TIME_WAKE_GLSL).toMatch(
      /float sttWakeAlpha\(\s*\n\s*vec2 timeRange/,
    );
    expect(TIME_WAKE_GLSL).toContain('if (wakeLength <= 0.0) return 0.0;');
    expect(TIME_WAKE_GLSL).toContain('float age = currentTime - timeRange.x;');
    expect(TIME_WAKE_GLSL).toContain(
      'if (age < 0.0 || age > wakeLength) return 0.0;',
    );
    expect(TIME_WAKE_GLSL).toContain(
      'return clamp(1.0 - age / wakeLength, 0.0, 1.0);',
    );
    expect(TIME_WAKE_GLSL).toContain('float sttWakeSizeScale(');
    expect(TIME_WAKE_GLSL).toContain(
      'return wakeTailScale * (1.0 - alpha) + alpha;',
    );
  });

  it('cumulative GLSL states the same formula as cumulativeAlphaJS', () => {
    expect(TIME_CUMULATIVE_GLSL).toMatch(
      /float sttCumulativeAlpha\(\s*\n\s*vec2 timeRange/,
    );
    expect(TIME_CUMULATIVE_GLSL).toContain(
      'if (startTime > currentTime) return 0.0;',
    );
    expect(TIME_CUMULATIVE_GLSL).toContain('if (fadeIn > 0.0) {');
    expect(TIME_CUMULATIVE_GLSL).toContain(
      'return clamp((currentTime - startTime) / fadeIn, 0.0, 1.0);',
    );
    expect(TIME_CUMULATIVE_GLSL).toContain('return 1.0;');
  });

  it('the four mode snippets are independently includable', () => {
    const snippets = [
      TIME_WINDOW_GLSL,
      TIME_TRAIL_GLSL,
      TIME_WAKE_GLSL,
      TIME_CUMULATIVE_GLSL,
    ];
    for (const s of snippets) {
      // Call sites own the uniform/attribute/varying declarations — a snippet
      // that declared its own would collide when two modes share a program.
      expect(s).not.toMatch(/\b(uniform|attribute|varying|precision)\b/);
    }
    // No duplicate function names across snippets (all four in one program).
    const names = snippets
      .join('\n')
      .match(/^float (stt\w+)\(/gm)!
      .map((m) => m.trim());
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(5); // window, trail, wake, wakeSizeScale, cumulative
  });
});

describe('f32 precision contract (MAX_RELATIVE_TIME_MS)', () => {
  const fr = Math.fround;

  /** wakeAlphaJS with every intermediate rounded to f32, as the shader runs. */
  function wakeAlphaF32(
    startTime: number,
    currentTime: number,
    wakeLength: number,
  ): number {
    const s = fr(startTime);
    const c = fr(currentTime);
    const L = fr(wakeLength);
    if (L <= 0) return 0;
    const age = fr(c - s);
    if (age < 0 || age > L) return 0;
    return Math.max(0, Math.min(1, fr(1 - fr(age / L))));
  }

  /** cumulativeAlphaJS with every intermediate rounded to f32. */
  function cumulativeAlphaF32(
    startTime: number,
    currentTime: number,
    fadeIn: number,
  ): number {
    const s = fr(startTime);
    const c = fr(currentTime);
    const f = fr(fadeIn);
    if (s > c) return 0;
    if (f > 0) return Math.max(0, Math.min(1, fr(fr(c - s) / f)));
    return 1;
  }

  it('integer ms inside ±2^24 survive the f32 round-trip', () => {
    for (const t of [0, 1, 1000, 3_600_000, MAX_RELATIVE_TIME_MS]) {
      expect(fr(t)).toBe(t);
      expect(fr(-t)).toBe(-t);
    }
    // One ms past the ceiling is where granularity starts doubling.
    expect(fr(MAX_RELATIVE_TIME_MS + 1)).toBe(MAX_RELATIVE_TIME_MS);
  });

  it('wake alpha under simulated f32 tracks the double reference to 1e-6', () => {
    // Whole span inside the precision contract (|relative time| <= 2^24).
    const now = MAX_RELATIVE_TIME_MS - 1;
    for (const L of [1000, 60_000, 3_600_000]) {
      for (const f of AGE_FACTORS) {
        const startTime = Math.round(now - L * f);
        const exact = wakeAlphaJS(startTime, now, L);
        const approx = wakeAlphaF32(startTime, now, L);
        // Visibility gate must agree bit-for-bit; only the ramp may round.
        expect(approx > 0).toBe(exact > 0);
        expect(Math.abs(approx - exact)).toBeLessThan(1e-6);
      }
    }
  });

  it('cumulative reveal stays monotone past 2^24 (its declared exception)', () => {
    // Cumulative intentionally spans years: 40 days of relative time, where the
    // f32 step is ~256 ms. The reveal must never go backwards as the playhead
    // advances, and must reach full alpha.
    const startTime = 40 * 24 * 3_600_000; // ≈ 3.456e9 ms ≫ MAX_RELATIVE_TIME_MS
    const fadeIn = 24 * 3_600_000; // 1-day appear ramp
    let prev = -1;
    let sawZero = false;
    let sawFull = false;
    for (let i = 0; i <= 400; i++) {
      const now = startTime - fadeIn / 2 + (i * fadeIn * 2) / 400;
      const a = cumulativeAlphaF32(startTime, now, fadeIn);
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
      if (a === 0) sawZero = true;
      if (a === 1) sawFull = true;
    }
    expect(sawZero).toBe(true);
    expect(sawFull).toBe(true);
  });

  it('cumulative alpha under simulated f32 tracks the double reference to 1e-6 in range', () => {
    const now = 1_000_000;
    for (const fadeIn of [1000, 60_000, 3_600_000]) {
      for (const f of AGE_FACTORS) {
        const startTime = Math.round(now - fadeIn * f);
        const exact = cumulativeAlphaJS(startTime, now, fadeIn);
        const approx = cumulativeAlphaF32(startTime, now, fadeIn);
        expect(approx > 0).toBe(exact > 0);
        expect(Math.abs(approx - exact)).toBeLessThan(1e-6);
      }
    }
  });
});

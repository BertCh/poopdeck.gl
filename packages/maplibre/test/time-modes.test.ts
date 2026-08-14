/**
 * Oracle-parity tests for ALL FOUR time modes (campaign D8 covered wake +
 * cumulative; window + trail were added later — they had leg 1 only, and only
 * against a hand-transcribed deck reference in `time-window.test.ts`, with
 * neither leg 2 nor leg 3 anywhere).
 *
 * `shaders/time-window.glsl.ts` carries hand-written GLSL plus a JS reference
 * impl per mode. The GLSL is what ships; the JS reference is what we can test.
 * The contract pinned here is three-way, for `window`, `trail`, `wake` and
 * `cumulative` alike:
 *
 *   1. JS reference  ==  core `time-filter.ts` (THE oracle) — exactly, in
 *      double math, across a dense sweep including every boundary. `trail` is
 *      the ONE mode that cannot claim exact; see its divergence note below.
 *   2. JS reference  ==  core `shader-codegen.ts`'s `evalExpr(ALPHA_EXPR[mode])`
 *      (the second, branchless oracle — an independent re-derivation of the
 *      same four formulas, NOT something any backend's shader is emitted from;
 *      every backend hand-writes its own dialect and owes this same pin).
 *   3. GLSL source   ==  JS reference, by structural lock (the GLSL cannot be
 *      executed here — no GL context — so the formula lines are asserted
 *      verbatim; editing one without the other fails).
 *
 * The oracles disagree with each other at out-of-contract inputs, and every
 * such point is pinned explicitly below rather than avoided, so a change in
 * either oracle surfaces here:
 *
 *   - `wakeLength <= 0`  — core NaN at age 0; JS ref and AST both 0.
 *   - negative `fadeIn`  — cumulative: core (and the JS ref) 1, AST 0.
 *   - negative `fadeIn` / `fadeOut` — window: the same split as cumulative, on
 *     either knob independently.
 *   - `trailLength <= 0` — a THREE-way split at `vertexTime == currentTime`:
 *     core NaN, AST `clamp01(1 - trailFade)`, JS ref 0.
 *   - `trail`'s blend arrangement — the JS reference differs from BOTH oracles
 *     by up to one ULP at ordinary in-contract inputs; see `trail mode` below.
 */

import { describe, it, expect } from 'vitest';
import {
  TIME_WAKE_GLSL,
  TIME_CUMULATIVE_GLSL,
  TIME_WINDOW_GLSL,
  TIME_TRAIL_GLSL,
  timeWindowAlphaJS,
  trailAlphaJS,
  wakeAlphaJS,
  wakeSizeScaleJS,
  cumulativeAlphaJS,
} from '../src/shaders/time-window.glsl';
import {
  wakeAlpha,
  windowAlpha,
  trailAlpha,
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

describe('window mode — JS reference vs core time-filter oracle', () => {
  /** Fade ramps, incl. the degenerate 0 (hard cut) at both ends. */
  const FADES = [0, 0.5, 1, 100, 1000, 3_600_000];
  const OUT_FADES = [0, 1, 1000];

  /**
   * The sweep both legs share. `timeWindowAlphaJS` takes the resolved
   * `[windowStart, windowEnd]`; core and the AST take `windowHalf` — the
   * conversion is `cur ± win/2`, done once here so the two sides cannot drift
   * on the vocabulary rather than the formula.
   */
  function sweep(
    fn: (a: {
      currentTime: number;
      startTime: number;
      endTime: number;
      windowHalf: number;
      fadeIn: number;
      fadeOut: number;
    }) => void,
  ): number {
    let cases = 0;
    for (const currentTime of CURRENT_TIMES) {
      for (const win of DURATIONS) {
        const windowHalf = win / 2;
        for (const f of AGE_FACTORS) {
          const startTime = currentTime - win * f;
          const endTime = startTime + win * 0.3; // features narrower than the window
          for (const fadeIn of FADES) {
            for (const fadeOut of OUT_FADES) {
              fn({
                currentTime,
                startTime,
                endTime,
                windowHalf,
                fadeIn,
                fadeOut,
              });
              cases++;
            }
          }
        }
      }
    }
    return cases;
  }

  it('agrees exactly across a dense (currentTime × window × offset × fades) sweep', () => {
    const cases = sweep((a) => {
      const got = timeWindowAlphaJS(
        a.startTime,
        a.endTime,
        a.currentTime - a.windowHalf,
        a.currentTime + a.windowHalf,
        a.fadeIn,
        a.fadeOut,
      );
      const want = windowAlpha(
        a.currentTime,
        a.startTime,
        a.endTime,
        a.windowHalf,
        a.fadeIn,
        a.fadeOut,
      );
      // Exact, not close: the two differ only in WHERE they clamp (core clamps
      // the product once at the end; the kernel clamps each ramp factor). Both
      // ramp factors are already in [0,1) whenever their branch is taken, so
      // every clamp is a no-op and the surviving multiplications are identical.
      expect(got).toBe(want);
    });
    expect(cases).toBe(
      CURRENT_TIMES.length *
        DURATIONS.length *
        AGE_FACTORS.length *
        FADES.length *
        OUT_FADES.length,
    );
  });

  it('agrees with the `timeFilterAlpha` dispatcher (mode routing)', () => {
    sweep((a) => {
      expect(
        timeWindowAlphaJS(
          a.startTime,
          a.endTime,
          a.currentTime - a.windowHalf,
          a.currentTime + a.windowHalf,
          a.fadeIn,
          a.fadeOut,
        ),
      ).toBe(
        timeFilterAlpha('window', a.currentTime, a.startTime, a.endTime, {
          windowHalf: a.windowHalf,
          fadeIn: a.fadeIn,
          fadeOut: a.fadeOut,
        }),
      );
    });
  });

  it('pins the overlap boundary (inclusive on both edges)', () => {
    const ws = 900;
    const we = 1100;
    expect(timeWindowAlphaJS(0, ws - 1e-6, ws, we, 0, 0)).toBe(0); // ends just before
    expect(timeWindowAlphaJS(0, ws, ws, we, 0, 0)).toBe(1); // ends exactly AT windowStart
    expect(timeWindowAlphaJS(we, 1e9, ws, we, 0, 0)).toBe(1); // starts exactly AT windowEnd
    expect(timeWindowAlphaJS(we + 1e-6, 1e9, ws, we, 0, 0)).toBe(0); // starts just after
    expect(timeWindowAlphaJS(950, 1050, ws, we, 0, 0)).toBe(1); // fully inside
    expect(timeWindowAlphaJS(-1e9, 1e9, ws, we, 0, 0)).toBe(1); // spans the window
  });

  it('pins both ramps, independently and together', () => {
    const ws = 900;
    const we = 1100;
    // age = windowEnd - startTime; 1100 - 1080 = 20; 20/50 = 0.4
    expect(timeWindowAlphaJS(1080, 1090, ws, we, 50, 0)).toBeCloseTo(0.4, 12);
    // remaining = endTime - windowStart; 910 - 900 = 10; 10/50 = 0.2
    expect(timeWindowAlphaJS(800, 910, ws, we, 0, 50)).toBeCloseTo(0.2, 12);
    // both edges bite on a short feature at the leading edge: 0.4 × (190/40 → 1)
    expect(timeWindowAlphaJS(1080, 1090, ws, we, 50, 40)).toBeCloseTo(0.4, 12);
    // a ramp longer than the overlap: age 20 of a 1e9 ms fade
    expect(timeWindowAlphaJS(1080, 1090, ws, we, 1e9, 0)).toBeCloseTo(2e-8, 15);
    // age >= fadeIn ⇒ the ramp is skipped entirely, not clamped from above
    expect(timeWindowAlphaJS(1000, 1050, ws, we, 50, 0)).toBe(1);
  });

  it('a zero window still lights a feature that straddles the instant', () => {
    // windowHalf 0 collapses the window to the playhead — the hard-cut default.
    expect(timeWindowAlphaJS(900, 1100, 1000, 1000, 0, 0)).toBe(1);
    expect(timeWindowAlphaJS(1001, 1100, 1000, 1000, 0, 0)).toBe(0);
    expect(timeWindowAlphaJS(900, 999, 1000, 1000, 0, 0)).toBe(0);
  });

  it('DOCUMENTED DIVERGENCE: a negative fade follows core (no ramp), not the AST (0)', () => {
    // Same split as cumulative's negative `fadeIn`, and for the same reason:
    // core gates each ramp on `fade > 0`, the codegen AST's `select(fade, …)`
    // fires on any NON-ZERO fade and then clamps a negative ratio to 0. Window
    // has TWO knobs, so pin both independently. `resolveFadeDurations` clamps
    // fades at 0 before a uniform is set, so this cannot occur in the layer path.
    const ws = 900;
    const we = 1100;
    const env = {
      currentTime: 1000,
      startTime: 950,
      endTime: 1050,
      windowHalf: 100,
    };
    for (const [fadeIn, fadeOut] of [
      [-100, 0],
      [0, -100],
      [-100, -100],
      [-100, 100],
      [100, -100],
    ]) {
      expect(timeWindowAlphaJS(950, 1050, ws, we, fadeIn, fadeOut)).toBe(1);
      expect(windowAlpha(1000, 950, 1050, 100, fadeIn, fadeOut)).toBe(1);
      expect(evalExpr(ALPHA_EXPR.window, { ...env, fadeIn, fadeOut })).toBe(0);
    }
  });
});

describe('trail mode — JS reference vs core time-filter oracle', () => {
  const FADE_TRAILS = [0, 0.25, 0.5, 0.75, 1];

  /**
   * DOCUMENTED DIVERGENCE (arrangement, not semantics). Both oracles compute
   * the head→tail blend as `1·(1 - trailFade) + faded·trailFade`; the kernel's
   * JS reference — mirroring the GLSL's `mix(1.0, faded, fadeTrail)`, which
   * drivers are free to lower to the fma-friendly `x + a·(y - x)` — computes
   * `1 + (faded - 1)·trailFade`. Algebraically identical, NOT bit-identical:
   * the two disagree by up to one ULP on roughly a sixth of random in-contract
   * inputs. So leg 1 for trail is an ULP bound, not `toBe`. Anything larger
   * than one ULP is a real formula change and fails.
   *
   * The VISIBILITY GATE is still held to exact agreement: a feature must be
   * lit/unlit identically, since that is what a discard threshold reads.
   */
  const ONE_ULP = Number.EPSILON; // 2^-52 ≈ 2.22e-16

  it('agrees with core `trailAlpha` to within one ULP across a dense sweep', () => {
    let cases = 0;
    let inexact = 0;
    for (const currentTime of CURRENT_TIMES) {
      for (const trailLength of DURATIONS) {
        for (const f of AGE_FACTORS) {
          for (const trailFade of FADE_TRAILS) {
            const vertexTime = currentTime - trailLength * f;
            const got = trailAlphaJS(
              vertexTime,
              currentTime,
              trailLength,
              trailFade,
            );
            const want = trailAlpha(
              currentTime,
              vertexTime,
              trailLength,
              trailFade,
            );
            expect(Math.abs(got - want)).toBeLessThanOrEqual(ONE_ULP);
            expect(got > 0).toBe(want > 0); // the gate, exactly
            if (got !== want) inexact++;
            cases++;
          }
        }
      }
    }
    expect(cases).toBe(
      CURRENT_TIMES.length *
        DURATIONS.length *
        AGE_FACTORS.length *
        FADE_TRAILS.length,
    );
    // The bound is load-bearing, not decorative: this grid really does contain
    // inputs where the two arrangements land on different doubles. (A randomized
    // grid disagrees on roughly a sixth of samples.) The specific ones are
    // pinned by value in the next test.
    expect(inexact).toBeGreaterThan(0);
  });

  it('DOCUMENTED DIVERGENCE: the JS reference is the outlier, by exactly one double step', () => {
    // A worked instance of the arrangement split, pinned by value so the claim
    // above is checkable rather than asserted. Note WHICH implementation is odd
    // one out: core and the codegen AST agree bit-for-bit (both spell the blend
    // `(1 - trailFade) + faded·trailFade`); the maplibre JS reference spells the
    // `mix` form `1 + (faded - 1)·trailFade` and lands one step away.
    //
    // Sub-ULP, so it is invisible in an 8-bit colour channel — recorded, not
    // "fixed", because aligning the JS reference to core would ALSO move it
    // away from how a driver may lower the shipped GLSL's `mix`, and this file
    // exists to describe the shipped shader, not to flatter the oracle.
    const currentTime = 1000;
    const trailLength = 7;
    const trailFade = 0.75;
    const vertexTime = currentTime - trailLength * 0.999;

    const js = trailAlphaJS(vertexTime, currentTime, trailLength, trailFade);
    const core = trailAlpha(currentTime, vertexTime, trailLength, trailFade);
    const ast = evalExpr(ALPHA_EXPR.trail, {
      currentTime,
      vertexTime,
      trailLength,
      trailFade,
    });

    expect(js).toBe(0.2507499999999945);
    expect(core).toBe(0.2507499999999944);
    expect(ast).toBe(core); // the two oracles agree with each other exactly
    expect(js).not.toBe(core);
    expect(Math.abs(js - core)).toBeLessThanOrEqual(ONE_ULP);
  });

  it('is bit-exact where the blend degenerates (solid trail)', () => {
    // trailFade = 0 ⇒ both arrangements reduce to the constant 1 inside the
    // window, with no multiply-add left to round.
    for (const currentTime of CURRENT_TIMES) {
      for (const trailLength of DURATIONS) {
        for (const f of AGE_FACTORS) {
          const vertexTime = currentTime - trailLength * f;
          expect(trailAlphaJS(vertexTime, currentTime, trailLength, 0)).toBe(
            trailAlpha(currentTime, vertexTime, trailLength, 0),
          );
        }
      }
    }
  });

  it('agrees with the `timeFilterAlpha` dispatcher (mode routing)', () => {
    // The dispatcher reads the per-VERTEX time (6th arg, defaulting to
    // startTime), not the feature interval — trail is the only mode that does.
    for (const currentTime of CURRENT_TIMES) {
      for (const trailLength of DURATIONS) {
        for (const f of AGE_FACTORS) {
          for (const trailFade of FADE_TRAILS) {
            const vertexTime = currentTime - trailLength * f;
            expect(
              timeFilterAlpha(
                'trail',
                currentTime,
                -1e9, // startTime: ignored once vertexTime is supplied
                1e9, // endTime: ignored in trail mode
                { trailLength, trailFade },
                vertexTime,
              ),
            ).toBe(trailAlpha(currentTime, vertexTime, trailLength, trailFade));
          }
        }
      }
    }
  });

  it('defaults trailFade to 1 (full head→tail fade) in the dispatcher', () => {
    const now = 1000;
    expect(
      timeFilterAlpha('trail', now, now - 250, now, { trailLength: 1000 }),
    ).toBe(trailAlphaJS(now - 250, now, 1000, 1));
  });

  it('pins the boundary values (head, tail, both sides of each edge)', () => {
    const L = 1000;
    const now = 5000;
    expect(trailAlphaJS(now, now, L, 1)).toBe(1); // age 0 → head
    expect(trailAlphaJS(now - L / 2, now, L, 1)).toBe(0.5); // mid-trail
    expect(trailAlphaJS(now - L, now, L, 1)).toBe(0); // age == trailLength → tail
    expect(trailAlphaJS(now - L - 1e-6, now, L, 1)).toBe(0); // just past the tail
    expect(trailAlphaJS(now + 1e-6, now, L, 1)).toBe(0); // future vertex
    expect(trailAlphaJS(now - L / 2, now, L, 0)).toBe(1); // solid snake, no fade
    expect(trailAlphaJS(now - L / 2, now, L, 0.5)).toBe(0.75); // half-blended
  });

  it('DOCUMENTED DIVERGENCE: trailLength <= 0 splits all THREE implementations', () => {
    // Out of contract (a layer selects trail only when trailLength > 0; those
    // without a window kernel resolve to `off`). For a NEGATIVE length the
    // window is empty and all three agree on 0. For EXACTLY 0 the window
    // collapses to the single instant `vertexTime == currentTime`, and there:
    //   - the JS reference short-circuits on its `trailLength <= 0` guard → 0
    //   - core divides 0/0 → NaN, then clamps a NaN → NaN
    //   - the AST's `select(trailLength, …, 0)` makes `faded` 0, leaving the
    //     blend's constant term → clamp01(1 - trailFade)
    // Pinned so a change to any one of the three is loud.
    const now = 1000;
    for (const L of [0, -1, -1000]) {
      for (const vertexTime of [now - 1e6, now - 1, now + 1, now + 1e6]) {
        expect(trailAlphaJS(vertexTime, now, L, 1)).toBe(0);
        expect(trailAlpha(now, vertexTime, L, 1)).toBe(0);
        expect(
          evalExpr(ALPHA_EXPR.trail, {
            currentTime: now,
            vertexTime,
            trailLength: L,
            trailFade: 1,
          }),
        ).toBe(0);
      }
    }
    // The measure-zero point where they part company.
    for (const trailFade of FADE_TRAILS) {
      expect(trailAlphaJS(now, now, 0, trailFade)).toBe(0);
      expect(Number.isNaN(trailAlpha(now, now, 0, trailFade))).toBe(true);
      expect(
        evalExpr(ALPHA_EXPR.trail, {
          currentTime: now,
          vertexTime: now,
          trailLength: 0,
          trailFade,
        }),
      ).toBeCloseTo(1 - trailFade, 15);
    }
    // A negative length keeps every implementation at 0 even at that instant,
    // because the window is inverted rather than collapsed.
    expect(trailAlphaJS(now, now, -1, 1)).toBe(0);
    expect(trailAlpha(now, now, -1, 1)).toBe(0);
    expect(
      evalExpr(ALPHA_EXPR.trail, {
        currentTime: now,
        vertexTime: now,
        trailLength: -1,
        trailFade: 1,
      }),
    ).toBe(0);
  });
});

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
  it('window: evalExpr(ALPHA_EXPR.window) == timeWindowAlphaJS over the sweep', () => {
    for (const currentTime of CURRENT_TIMES) {
      for (const win of DURATIONS) {
        const windowHalf = win / 2;
        for (const f of AGE_FACTORS) {
          const startTime = currentTime - win * f;
          const endTime = startTime + win * 0.3;
          for (const fadeIn of [0, 1, 100, 1000, 3_600_000]) {
            for (const fadeOut of [0, 1, 1000]) {
              expect(
                evalExpr(ALPHA_EXPR.window, {
                  currentTime,
                  startTime,
                  endTime,
                  windowHalf,
                  fadeIn,
                  fadeOut,
                }),
              ).toBeCloseTo(
                timeWindowAlphaJS(
                  startTime,
                  endTime,
                  currentTime - windowHalf,
                  currentTime + windowHalf,
                  fadeIn,
                  fadeOut,
                ),
                12,
              );
            }
          }
        }
      }
    }
  });

  it('trail: evalExpr(ALPHA_EXPR.trail) == trailAlphaJS over the sweep', () => {
    for (const currentTime of CURRENT_TIMES) {
      for (const trailLength of DURATIONS) {
        for (const f of AGE_FACTORS) {
          for (const trailFade of [0, 0.25, 0.5, 0.75, 1]) {
            const vertexTime = currentTime - trailLength * f;
            expect(
              evalExpr(ALPHA_EXPR.trail, {
                currentTime,
                vertexTime,
                trailLength,
                trailFade,
              }),
            ).toBeCloseTo(
              trailAlphaJS(vertexTime, currentTime, trailLength, trailFade),
              12,
            );
          }
        }
      }
    }
  });

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
  it('window GLSL states the same formula as timeWindowAlphaJS', () => {
    expect(TIME_WINDOW_GLSL).toMatch(
      /float sttTimeWindowAlpha\(\s*\n\s*vec2 timeRange/,
    );
    expect(TIME_WINDOW_GLSL).toContain('float startTime = timeRange.x;');
    expect(TIME_WINDOW_GLSL).toContain('float endTime   = timeRange.y;');
    // The overlap test — inclusive on both edges, matching the JS `if` exactly.
    expect(TIME_WINDOW_GLSL).toContain(
      'if (endTime < windowStart || startTime > windowEnd) {',
    );
    expect(TIME_WINDOW_GLSL).toContain('float alpha = 1.0;');
    // fade-in: measured from the LEADING edge (windowEnd - startTime), which is
    // the deck-parity arrangement; the asymmetric maplibre original measured
    // from windowStart. Locked verbatim so it cannot silently flip back.
    expect(TIME_WINDOW_GLSL).toContain('if (fadeIn > 0.0) {');
    expect(TIME_WINDOW_GLSL).toContain('float age = windowEnd - startTime;');
    expect(TIME_WINDOW_GLSL).toContain('if (age < fadeIn) {');
    expect(TIME_WINDOW_GLSL).toContain(
      'alpha *= clamp(age / fadeIn, 0.0, 1.0);',
    );
    // fade-out: measured from the TRAILING edge (endTime - windowStart).
    expect(TIME_WINDOW_GLSL).toContain('if (fadeOut > 0.0) {');
    expect(TIME_WINDOW_GLSL).toContain(
      'float remaining = endTime - windowStart;',
    );
    expect(TIME_WINDOW_GLSL).toContain('if (remaining < fadeOut) {');
    expect(TIME_WINDOW_GLSL).toContain(
      'alpha *= clamp(remaining / fadeOut, 0.0, 1.0);',
    );
    expect(TIME_WINDOW_GLSL).toContain('return alpha;');
    // The kernel takes the RESOLVED window, not a half-width: a shader that
    // recomputed `currentTime ± windowHalf` would need those two uniforms, and
    // the call sites do not declare them for this mode.
    expect(TIME_WINDOW_GLSL).not.toContain('windowHalf');
  });

  it('trail GLSL states the same formula as trailAlphaJS', () => {
    expect(TIME_TRAIL_GLSL).toMatch(
      /float sttTrailAlpha\(\s*\n\s*float vertexTime/,
    );
    expect(TIME_TRAIL_GLSL).toContain(
      'if (vertexTime > currentTime) return 0.0;',
    );
    expect(TIME_TRAIL_GLSL).toContain('if (trailLength <= 0.0) return 0.0;');
    expect(TIME_TRAIL_GLSL).toContain('float age = currentTime - vertexTime;');
    expect(TIME_TRAIL_GLSL).toContain('if (age > trailLength) return 0.0;');
    expect(TIME_TRAIL_GLSL).toContain(
      'float faded = clamp(1.0 - age / trailLength, 0.0, 1.0);',
    );
    // `mix(1.0, faded, fadeTrail)` is the head→tail blend. The JS reference
    // spells the same thing as `1 + (faded - 1)·fadeTrail`, which is why leg 1
    // for trail is an ULP bound — see the trail-mode divergence note above.
    expect(TIME_TRAIL_GLSL).toContain(
      'return clamp(mix(1.0, faded, fadeTrail), 0.0, 1.0);',
    );
    // fadeTrail is CONTINUOUS: a threshold (`fadeTrail > 0.5 ? … : …`) would
    // drop every intermediate value the numeric `fadeTrail` prop can set.
    expect(TIME_TRAIL_GLSL).not.toMatch(/fadeTrail\s*[<>]/);
  });

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

  /** timeWindowAlphaJS with every intermediate rounded to f32. */
  function timeWindowAlphaF32(
    startTime: number,
    endTime: number,
    windowStart: number,
    windowEnd: number,
    fadeIn: number,
    fadeOut: number,
  ): number {
    const s = fr(startTime);
    const e = fr(endTime);
    const ws = fr(windowStart);
    const we = fr(windowEnd);
    const fi = fr(fadeIn);
    const fo = fr(fadeOut);
    if (e < ws || s > we) return 0;
    let alpha = 1;
    if (fi > 0) {
      const age = fr(we - s);
      if (age < fi) alpha = fr(alpha * Math.max(0, Math.min(1, fr(age / fi))));
    }
    if (fo > 0) {
      const rem = fr(e - ws);
      if (rem < fo) alpha = fr(alpha * Math.max(0, Math.min(1, fr(rem / fo))));
    }
    return alpha;
  }

  /** trailAlphaJS with every intermediate rounded to f32. */
  function trailAlphaF32(
    vertexTime: number,
    currentTime: number,
    trailLength: number,
    fadeTrail: number,
  ): number {
    const v = fr(vertexTime);
    const c = fr(currentTime);
    const L = fr(trailLength);
    const t = fr(fadeTrail);
    if (v > c) return 0;
    if (L <= 0) return 0;
    const age = fr(c - v);
    if (age > L) return 0;
    const faded = Math.max(0, Math.min(1, fr(1 - fr(age / L))));
    return Math.max(0, Math.min(1, fr(1 + fr(fr(faded - 1) * t))));
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

  it('window alpha under simulated f32 tracks the double reference to 1e-6', () => {
    // window is the DEFAULT mode and the one every layer compiles, so its
    // precision is the one that matters most; it had no f32 pin at all.
    const now = MAX_RELATIVE_TIME_MS - 1; // right at the contract's ceiling
    for (const win of [1000, 60_000, 3_600_000]) {
      const half = win / 2;
      for (const f of AGE_FACTORS) {
        for (const [fi, fo] of [
          [0, 0],
          [win / 4, 0],
          [0, win / 4],
          [win / 4, win / 8],
        ]) {
          const startTime = Math.round(now - win * f);
          const endTime = startTime + Math.round(win * 0.3);
          const exact = timeWindowAlphaJS(
            startTime,
            endTime,
            now - half,
            now + half,
            fi,
            fo,
          );
          const approx = timeWindowAlphaF32(
            startTime,
            endTime,
            now - half,
            now + half,
            fi,
            fo,
          );
          // Visibility gate must agree bit-for-bit; only the ramps may round.
          expect(approx > 0).toBe(exact > 0);
          expect(Math.abs(approx - exact)).toBeLessThan(1e-6);
        }
      }
    }
  });

  it('trail alpha under simulated f32 tracks the double reference to 1e-6', () => {
    const now = MAX_RELATIVE_TIME_MS - 1;
    for (const L of [1000, 60_000, 3_600_000]) {
      for (const f of AGE_FACTORS) {
        for (const fadeTrail of [0, 0.5, 1]) {
          const vertexTime = Math.round(now - L * f);
          const exact = trailAlphaJS(vertexTime, now, L, fadeTrail);
          const approx = trailAlphaF32(vertexTime, now, L, fadeTrail);
          expect(approx > 0).toBe(exact > 0);
          expect(Math.abs(approx - exact)).toBeLessThan(1e-6);
        }
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

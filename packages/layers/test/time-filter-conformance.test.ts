// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT

/**
 * Oracle-conformance tests for deck.gl's `TimeFilterExtension`.
 *
 * `src/extensions/time-filter-extension.ts` carries hand-written GLSL ES 3.00
 * in its `vs:#main-start` inject. The GLSL is what ships; a JS reference of the
 * same branch is what we can execute. The contract pinned here is three-way,
 * matching `packages/maplibre/test/time-modes.test.ts` (the pattern's reference
 * implementation):
 *
 *   1. JS reference  ==  core `time-filter.ts` (THE oracle) — across a dense
 *      sweep including every boundary and the degenerate durations.
 *   2. JS reference  ==  core `shader-codegen.ts`'s `evalExpr(ALPHA_EXPR[mode])`
 *      (the second, independently-derived branchless oracle).
 *   3. GLSL source   ==  JS reference, by structural lock — the GLSL cannot be
 *      executed here (no GL context), so the formula lines are asserted; editing
 *      one without the other fails.
 *
 * WHY THIS FILE EXISTS: until it was added, `@poopdeck.gl/layers` — the flagship
 * backend — referenced NEITHER oracle from any test. `cumulative-mode.test.ts`
 * kept a local `cumulativeAlphaRef` checked against hand-typed expectations: a
 * mirror of a mirror, never tied to core, and covering only one of four modes.
 * The repo nonetheless claimed "conformance tests pin all four backends to the
 * oracle". docs/spec/render-spec.json now states the obligation per backend and
 * `packages/core/test/render-spec-contract.test.ts` enforces it structurally.
 *
 * ── MODE DISPATCH IS BY UNIFORM VALUE ────────────────────────────────────────
 * Unlike maplibre (which picks a mode's snippet at shader-BUILD time) deck ships
 * ONE program containing all four branches and selects at DRAW time from uniform
 * values, in a fixed precedence: cumulative → wake → trail → window. That
 * precedence is load-bearing and untestable from the oracle (which takes an
 * explicit mode), so it is pinned separately at the bottom of this file.
 */

import { describe, it, expect } from 'vitest';
import { TimeFilterExtension } from '../src/extensions/time-filter-extension';
import {
  timeFilterAlpha,
  type TimeFilterMode,
} from '@poopdeck.gl/core/time-filter';
import { ALPHA_EXPR, evalExpr } from '@poopdeck.gl/core/shader-codegen';

// ─── GLSL builtins, so the reference reads like the shader it mirrors ────────
const clamp = (x: number, lo: number, hi: number) =>
  Math.min(Math.max(x, lo), hi);
const mix = (a: number, b: number, t: number) => a * (1 - t) + b * t;

/** The `timeFilterUniforms` UBO fields the alpha branch reads. */
interface TimeFilterUniformValues {
  currentTime: number;
  windowHalf: number;
  fadeIn: number;
  fadeOut: number;
  trailLength: number;
  trailFade: number;
  wakeLength: number;
  cumulative: number;
  /**
   * 1 = `instanceEndTime` carries the NEXT VERTEX's time, not the feature's
   * end. Trail mode then culls per SEGMENT in the vertex stage and fades per
   * FRAGMENT off the interpolated `vSegTime`; window mode stops reading the
   * slot. See {@link deckSegmentTrailAlphaJS}.
   */
  segmentTime: number;
}

const ZERO_UNIFORMS: TimeFilterUniformValues = {
  currentTime: 0,
  windowHalf: 0,
  fadeIn: 0,
  fadeOut: 0,
  trailLength: 0,
  trailFade: 1,
  wakeLength: 0,
  cumulative: 0,
  segmentTime: 0,
};

/** The `NEVER_ENDS` literal the window branch substitutes under segmentTime. */
const GLSL_NEVER_ENDS = 3.4028235e38;

/**
 * Line-by-line JS mirror of the `vs:#main-start` inject's `vTimeAlpha`
 * computation. Keep this in lockstep with the GLSL — the structural lock below
 * is what makes "keep in lockstep" enforceable rather than aspirational.
 */
function deckAlphaJS(
  timeFilter: TimeFilterUniformValues,
  instanceStartTime: number,
  instanceEndTime: number,
  instanceVertexTime: number,
): number {
  let vTimeAlpha = 1.0;

  if (timeFilter.cumulative > 0.0) {
    if (instanceStartTime > timeFilter.currentTime) {
      vTimeAlpha = 0.0;
    } else if (timeFilter.fadeIn > 0.0) {
      const age = timeFilter.currentTime - instanceStartTime;
      if (age < timeFilter.fadeIn) {
        vTimeAlpha = age / timeFilter.fadeIn;
      }
    }
  } else if (timeFilter.wakeLength > 0.0) {
    const age = timeFilter.currentTime - instanceStartTime;
    if (age < 0.0 || age > timeFilter.wakeLength) {
      vTimeAlpha = 0.0;
    } else {
      vTimeAlpha = 1.0 - age / timeFilter.wakeLength;
    }
  } else if (timeFilter.trailLength > 0.0) {
    const trailStart = timeFilter.currentTime - timeFilter.trailLength;
    if (timeFilter.segmentTime > 0.5) {
      const segLo = Math.min(instanceVertexTime, instanceEndTime);
      const segHi = Math.max(instanceVertexTime, instanceEndTime);
      vTimeAlpha =
        segHi < trailStart || segLo > timeFilter.currentTime ? 0.0 : 1.0;
    } else {
      const vertexTime = instanceVertexTime;
      if (vertexTime > timeFilter.currentTime) {
        vTimeAlpha = 0.0;
      } else if (vertexTime < trailStart) {
        vTimeAlpha = 0.0;
      } else {
        const age = timeFilter.currentTime - vertexTime;
        const faded = clamp(1.0 - age / timeFilter.trailLength, 0.0, 1.0);
        vTimeAlpha = mix(1.0, faded, timeFilter.trailFade);
      }
    }
  } else {
    const timeStart = timeFilter.currentTime - timeFilter.windowHalf;
    const timeEnd = timeFilter.currentTime + timeFilter.windowHalf;
    const featureEnd =
      timeFilter.segmentTime > 0.5 ? GLSL_NEVER_ENDS : instanceEndTime;
    if (featureEnd < timeStart || instanceStartTime > timeEnd) {
      vTimeAlpha = 0.0;
    }
    if (vTimeAlpha > 0.0 && timeFilter.fadeIn > 0.0) {
      const age = timeEnd - instanceStartTime;
      if (age < timeFilter.fadeIn) {
        vTimeAlpha *= age / timeFilter.fadeIn;
      }
    }
    if (vTimeAlpha > 0.0 && timeFilter.fadeOut > 0.0) {
      const remaining = featureEnd - timeStart;
      if (remaining < timeFilter.fadeOut) {
        vTimeAlpha *= remaining / timeFilter.fadeOut;
      }
    }
  }

  return vTimeAlpha;
}

/**
 * JS mirror of the `vs:#main-end` interpolation (`pathSegmentTime` variant):
 * the time at a fragment `segT` of the way along a segment whose endpoints are
 * `instanceVertexTime` and `instanceEndTime`.
 */
function deckSegTimeJS(
  instanceVertexTime: number,
  instanceEndTime: number,
  segT: number,
): number {
  return mix(instanceVertexTime, instanceEndTime, clamp(segT, 0, 1));
}

/**
 * JS mirror of the module's `sttSegmentTrailAlpha()` — the trail fade, moved to
 * the FRAGMENT stage so it varies continuously along a segment. Structurally
 * the SAME formula as the vertex-stage trail branch, just fed the interpolated
 * time; that identity is what keeps the per-fragment path conformant with the
 * core oracle, and it is asserted below.
 */
function deckSegmentTrailAlphaJS(
  timeFilter: TimeFilterUniformValues,
  vSegTime: number,
): number {
  const age = timeFilter.currentTime - vSegTime;
  if (age < 0.0 || age > timeFilter.trailLength) return 0.0;
  const faded = clamp(1.0 - age / timeFilter.trailLength, 0.0, 1.0);
  return mix(1.0, faded, timeFilter.trailFade);
}

/** Configure the UBO so `mode`'s branch is the one the dispatch selects. */
function uniformsFor(
  mode: Exclude<TimeFilterMode, 'none'>,
  p: {
    windowHalf?: number;
    fadeIn?: number;
    fadeOut?: number;
    wakeLength?: number;
    trailLength?: number;
    trailFade?: number;
  },
  currentTime: number,
): TimeFilterUniformValues {
  const u = { ...ZERO_UNIFORMS, currentTime };
  switch (mode) {
    case 'cumulative':
      return { ...u, cumulative: 1, fadeIn: p.fadeIn ?? 0 };
    case 'wake':
      return { ...u, wakeLength: p.wakeLength ?? 0 };
    case 'trail':
      return {
        ...u,
        trailLength: p.trailLength ?? 0,
        trailFade: p.trailFade ?? 1,
      };
    case 'window':
      return {
        ...u,
        windowHalf: p.windowHalf ?? 0,
        fadeIn: p.fadeIn ?? 0,
        fadeOut: p.fadeOut ?? 0,
      };
  }
}

// ─── The sweep (mirrors maplibre's shape: times × durations × age factors) ───

/** Tile-relative "now" values, spanning sign and magnitude. */
const CURRENT_TIMES = [0, 1, -1, 1000, -2500.5, 12_345.678, 1e6];
/** Mode lengths/fades: sub-ms, ms, minute, hour. The degenerate 0 is separate. */
const DURATIONS = [0.5, 1, 7, 100, 1000, 60_000, 3_600_000];
/** Age multipliers relative to a duration: before, at both edges, past, far. */
const AGE_FACTORS = [
  -2, -1, -0.001, 0, 0.001, 0.25, 0.5, 0.999, 1, 1.001, 2, 5,
];

describe('deck.gl TimeFilterExtension — JS reference vs BOTH oracles', () => {
  it('window: agrees with the oracle and with evalExpr across the sweep', () => {
    for (const currentTime of CURRENT_TIMES) {
      for (const windowHalf of DURATIONS) {
        for (const fadeIn of [0, ...DURATIONS]) {
          for (const fadeOut of [0, DURATIONS[3]]) {
            for (const f of AGE_FACTORS) {
              const startTime = currentTime + f * windowHalf;
              const endTime = startTime + windowHalf * 0.5;
              const params = { windowHalf, fadeIn, fadeOut };
              const got = deckAlphaJS(
                uniformsFor('window', params, currentTime),
                startTime,
                endTime,
                startTime,
              );
              expect(got).toBeCloseTo(
                timeFilterAlpha(
                  'window',
                  currentTime,
                  startTime,
                  endTime,
                  params,
                ),
                9,
              );
              expect(got).toBeCloseTo(
                evalExpr(ALPHA_EXPR.window, {
                  currentTime,
                  startTime,
                  endTime,
                  windowHalf,
                  fadeIn,
                  fadeOut,
                }),
                9,
              );
            }
          }
        }
      }
    }
  });

  it('wake: agrees with the oracle and with evalExpr across the sweep', () => {
    for (const currentTime of CURRENT_TIMES) {
      for (const wakeLength of DURATIONS) {
        for (const f of AGE_FACTORS) {
          const startTime = currentTime - f * wakeLength;
          const got = deckAlphaJS(
            uniformsFor('wake', { wakeLength }, currentTime),
            startTime,
            0,
            startTime,
          );
          expect(got).toBeCloseTo(
            timeFilterAlpha('wake', currentTime, startTime, 0, { wakeLength }),
            9,
          );
          expect(got).toBeCloseTo(
            evalExpr(ALPHA_EXPR.wake, { currentTime, startTime, wakeLength }),
            9,
          );
        }
      }
    }
  });

  it('cumulative: agrees with the oracle and with evalExpr across the sweep', () => {
    for (const currentTime of CURRENT_TIMES) {
      for (const fadeIn of [0, ...DURATIONS]) {
        for (const f of AGE_FACTORS) {
          const startTime = currentTime - f * (fadeIn || 1000);
          const got = deckAlphaJS(
            uniformsFor('cumulative', { fadeIn }, currentTime),
            startTime,
            0,
            startTime,
          );
          expect(got).toBeCloseTo(
            timeFilterAlpha('cumulative', currentTime, startTime, 0, {
              fadeIn,
            }),
            9,
          );
          expect(got).toBeCloseTo(
            evalExpr(ALPHA_EXPR.cumulative, {
              currentTime,
              startTime,
              fadeIn,
            }),
            9,
          );
        }
      }
    }
  });

  it('trail: agrees with the oracle and with evalExpr across the sweep', () => {
    for (const currentTime of CURRENT_TIMES) {
      for (const trailLength of DURATIONS) {
        for (const trailFade of [0, 0.25, 0.5, 1]) {
          for (const f of AGE_FACTORS) {
            const vertexTime = currentTime - f * trailLength;
            const params = { trailLength, trailFade };
            const got = deckAlphaJS(
              uniformsFor('trail', params, currentTime),
              0,
              0,
              vertexTime,
            );
            expect(got).toBeCloseTo(
              timeFilterAlpha('trail', currentTime, 0, 0, params, vertexTime),
              9,
            );
            expect(got).toBeCloseTo(
              evalExpr(ALPHA_EXPR.trail, {
                currentTime,
                vertexTime,
                trailLength,
                trailFade,
              }),
              9,
            );
          }
        }
      }
    }
  });
});

describe('deck.gl time filter — boundary and degenerate inputs', () => {
  it('window: a feature exactly touching either edge is visible', () => {
    const u = uniformsFor('window', { windowHalf: 100 }, 1000);
    // endTime == timeStart (900) and startTime == timeEnd (1100) both count as
    // overlapping: the GLSL cut is strict (`<` / `>`), matching windowAlpha.
    expect(deckAlphaJS(u, 800, 900, 800)).toBe(1);
    expect(deckAlphaJS(u, 1100, 1200, 1100)).toBe(1);
    expect(deckAlphaJS(u, 800, 899.999, 800)).toBe(0);
    expect(deckAlphaJS(u, 1100.001, 1200, 1100.001)).toBe(0);
  });

  it('wake: alpha is 1 at the playhead and 0 at the tail', () => {
    const u = uniformsFor('wake', { wakeLength: 60 }, 100);
    expect(deckAlphaJS(u, 100, 0, 100)).toBe(1); // age 0
    expect(deckAlphaJS(u, 70, 0, 70)).toBeCloseTo(0.5, 9); // age 30/60
    expect(deckAlphaJS(u, 40, 0, 40)).toBe(0); // age == wakeLength
    expect(deckAlphaJS(u, 110, 0, 110)).toBe(0); // ahead of the playhead
  });

  it('trail: trailFade 0 is a solid trail, 1 is a head→tail ramp', () => {
    const solid = uniformsFor(
      'trail',
      { trailLength: 100, trailFade: 0 },
      1000,
    );
    const faded = uniformsFor(
      'trail',
      { trailLength: 100, trailFade: 1 },
      1000,
    );
    expect(deckAlphaJS(solid, 0, 0, 950)).toBe(1);
    expect(deckAlphaJS(faded, 0, 0, 950)).toBeCloseTo(0.5, 9);
    // Outside the trail, both are hard 0 regardless of trailFade.
    expect(deckAlphaJS(solid, 0, 0, 899)).toBe(0);
    expect(deckAlphaJS(faded, 0, 0, 1001)).toBe(0);
  });

  it('segmentTime: the per-fragment fade IS the oracle, at the interpolated time', () => {
    // The whole conformance claim for the fragment stage: `sttSegmentTrailAlpha`
    // is the oracle's trail formula fed `vSegTime`. Sweep the segment.
    const u = { ...uniformsFor('trail', { trailLength: 100 }, 1000) };
    const [t0, t1] = [910, 990];
    for (const segT of [0, 0.25, 0.5, 0.75, 1]) {
      const segTime = deckSegTimeJS(t0, t1, segT);
      expect(deckSegmentTrailAlphaJS(u, segTime)).toBeCloseTo(
        timeFilterAlpha(
          'trail',
          u.currentTime,
          0,
          0,
          { trailLength: 100, trailFade: 1 },
          segTime,
        ),
        9,
      );
    }
  });

  it('segmentTime: a segment stays lit while the head crosses it', () => {
    // THE regression this exists for. Vertices 80 apart, trail only 50 long:
    // at t=1000 the start vertex (910) has aged out of the trail, but the head
    // is mid-segment. The staircase path blanks the whole segment — a trip that
    // pops out and back in — while segmentTime keeps it drawn and fades it
    // per-fragment.
    const trailLength = 50;
    const [t0, t1] = [910, 990];
    const staircase = uniformsFor('trail', { trailLength }, 1000);
    const segment = { ...staircase, segmentTime: 1 };

    expect(deckAlphaJS(staircase, 0, t1, t0)).toBe(0); // blanked
    expect(deckAlphaJS(segment, 0, t1, t0)).toBe(1); // kept, fades per fragment

    // …and the fragment fade is a genuine ramp across the visible part: the
    // head end is brightest, the tail crosses zero partway along the segment
    // (t=950 is exactly trailLength old) and stays dark from there back.
    const alphaAt = (segT: number) =>
      deckSegmentTrailAlphaJS(segment, deckSegTimeJS(t0, t1, segT));
    expect(alphaAt(1)).toBeCloseTo(0.8, 9);
    expect(alphaAt(0.75)).toBeCloseTo(0.4, 9);
    expect(alphaAt(0.5)).toBe(0);
    expect(alphaAt(0)).toBe(0);
  });

  it('segmentTime: a segment entirely outside the trail is culled in the vertex stage', () => {
    const u = {
      ...uniformsFor('trail', { trailLength: 50 }, 1000),
      segmentTime: 1,
    };
    expect(deckAlphaJS(u, 0, 940, 900)).toBe(0); // both ends older than the tail
    expect(deckAlphaJS(u, 0, 1100, 1010)).toBe(0); // both ends ahead of the head
  });

  it('segmentTime: window mode stops reading the re-pointed end slot', () => {
    // instanceEndTime holds a per-vertex time here, so window mode must fall
    // back to NEVER_ENDS — otherwise a trail archive that momentarily runs at
    // trailLength 0 would hide features by a number that means something else.
    const u = { ...uniformsFor('window', { windowHalf: 100 }, 1000) };
    const seg = { ...u, segmentTime: 1 };
    expect(deckAlphaJS(u, 500, 600, 550)).toBe(0); // ends before the window
    expect(deckAlphaJS(seg, 500, 600, 550)).toBe(1); // never ends
  });

  it('a zero-length duration is UNREACHABLE in deck (the dispatch guards it)', () => {
    // Both oracles are out of contract at `wakeLength === 0` — `wakeAlpha`
    // returns NaN there (0/0), and maplibre's suite pins that disagreement
    // explicitly. deck cannot reach it: the branch is entered only when
    // `wakeLength > 0.0`, so a 0 falls through to the window branch instead.
    // This asserts the guard, NOT agreement with the oracle at 0.
    expect(
      Number.isNaN(timeFilterAlpha('wake', 100, 100, 0, { wakeLength: 0 })),
    ).toBe(true);
    const u = { ...ZERO_UNIFORMS, currentTime: 100, wakeLength: 0 };
    expect(deckAlphaJS(u, 100, 100, 100)).toBe(1); // window branch, windowHalf 0
    expect(Number.isNaN(deckAlphaJS(u, 100, 100, 100))).toBe(false);
  });

  it('trail: the same guard applies to a zero trailLength', () => {
    const u = { ...ZERO_UNIFORMS, currentTime: 100, trailLength: 0 };
    expect(Number.isNaN(deckAlphaJS(u, 100, 100, 100))).toBe(false);
  });
});

// ─── Leg 3: the structural lock on the shipped GLSL ─────────────────────────

/** Collapse whitespace so the lock survives reformatting but not edits. */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function shadersFor(opts?: { pathSegmentTime?: boolean }): {
  modules: { fs?: string }[];
  inject: Record<string, string>;
} {
  const ext = new TimeFilterExtension(opts);
  // getShaders only reads its `extension` arg (not `this`), so a bare object is
  // a fine receiver — same trick as cumulative-mode.test.ts.
  return (
    ext.getShaders as unknown as (
      this: unknown,
      e: TimeFilterExtension,
    ) => { modules: { fs?: string }[]; inject: Record<string, string> }
  ).call({}, ext);
}

function mainStartInject(): string {
  return norm(shadersFor().inject['vs:#main-start']);
}

describe('deck.gl time filter — shipped GLSL is locked to the JS reference', () => {
  const FORMULA_LINES = [
    // dispatch, in precedence order
    'if (timeFilter.cumulative > 0.0) {',
    '} else if (timeFilter.wakeLength > 0.0) {',
    '} else if (timeFilter.trailLength > 0.0) {',
    // cumulative
    'if (instanceStartTime > timeFilter.currentTime) {',
    'vTimeAlpha = age / timeFilter.fadeIn;',
    // wake
    'if (age < 0.0 || age > timeFilter.wakeLength) {',
    'vTimeAlpha = 1.0 - (age / timeFilter.wakeLength);',
    // trail
    'float trailStart = timeFilter.currentTime - timeFilter.trailLength;',
    'float faded = clamp(1.0 - (age / timeFilter.trailLength), 0.0, 1.0);',
    'vTimeAlpha = mix(1.0, faded, timeFilter.trailFade);',
    // window
    // segment-time trail (the per-SEGMENT visibility flag)
    'float segLo = min(instanceVertexTime, instanceEndTime);',
    'float segHi = max(instanceVertexTime, instanceEndTime);',
    'vTimeAlpha = (segHi < trailStart || segLo > timeFilter.currentTime) ? 0.0 : 1.0;',
    // window
    'float timeStart = timeFilter.currentTime - timeFilter.windowHalf;',
    'float timeEnd = timeFilter.currentTime + timeFilter.windowHalf;',
    'float featureEnd = timeFilter.segmentTime > 0.5 ? 3.4028235e38 : instanceEndTime;',
    'if (featureEnd < timeStart || instanceStartTime > timeEnd) {',
    'float age = timeEnd - instanceStartTime;',
    'vTimeAlpha *= (age / timeFilter.fadeIn);',
    'float remaining = featureEnd - timeStart;',
    'vTimeAlpha *= (remaining / timeFilter.fadeOut);',
  ];

  it.each(FORMULA_LINES)('GLSL still contains: %s', (line) => {
    expect(mainStartInject()).toContain(norm(line));
  });

  // The trail fade moved to the fragment stage under segmentTime, so the lock
  // has to reach the module source and the #main-end inject too — otherwise the
  // half of the formula that now runs per-fragment is unpinned.
  it.each([
    'float age = timeFilter.currentTime - vSegTime;',
    'if (age < 0.0 || age > timeFilter.trailLength) return 0.0;',
    'float faded = clamp(1.0 - age / timeFilter.trailLength, 0.0, 1.0);',
    'return mix(1.0, faded, timeFilter.trailFade);',
  ])('fragment-stage GLSL still contains: %s', (line) => {
    const fs = shadersFor()
      .modules.map((m) => m.fs ?? '')
      .join('\n');
    expect(norm(fs)).toContain(norm(line));
  });

  it('interpolates the segment time only under pathSegmentTime', () => {
    const withPath = norm(
      shadersFor({ pathSegmentTime: true }).inject['vs:#main-end'],
    );
    expect(withPath).toContain(
      norm(
        'float segT = vPathLength > 0.0 ? clamp(vPathPosition.y / vPathLength, 0.0, 1.0) : 0.0;',
      ),
    );
    expect(withPath).toContain(
      norm('vSegTime = mix(instanceVertexTime, instanceEndTime, segT);'),
    );
    // vPathPosition / vPathLength exist ONLY in PathLayer's shader. Emitting
    // them by default would fail to compile on every scatterplot/arc/polygon
    // layer that shares this extension, so the default MUST stay clean.
    const withoutPath = norm(shadersFor().inject['vs:#main-end']);
    expect(withoutPath).not.toContain('vPathPosition');
    expect(withoutPath).not.toContain('vPathLength');
    // Both flavours still collapse fully-hidden geometry in the vertex stage.
    for (const src of [withPath, withoutPath]) {
      expect(src).toContain(norm('gl_Position = vec4(0.);'));
    }
  });

  it('keeps the mode dispatch in cumulative → wake → trail → window order', () => {
    const src = mainStartInject();
    const at = (needle: string) => src.indexOf(norm(needle));
    const cumulative = at('if (timeFilter.cumulative > 0.0)');
    const wake = at('} else if (timeFilter.wakeLength > 0.0)');
    const trail = at('} else if (timeFilter.trailLength > 0.0)');
    expect(cumulative).toBeGreaterThanOrEqual(0);
    expect(cumulative).toBeLessThan(wake);
    expect(wake).toBeLessThan(trail);
  });
});

describe('deck.gl time filter — uniform-value mode precedence', () => {
  // deck ships ONE program and selects at draw time, so overlapping mode knobs
  // resolve by precedence rather than erroring. Pinned so the resolution can't
  // change silently: a layer that sets both wake and trail gets WAKE.
  const currentTime = 1000;

  it('cumulative outranks every other mode knob', () => {
    const u: TimeFilterUniformValues = {
      ...ZERO_UNIFORMS,
      currentTime,
      cumulative: 1,
      wakeLength: 100,
      trailLength: 100,
      windowHalf: 100,
    };
    // Cumulative persists a long-created feature; wake would have zeroed it.
    expect(deckAlphaJS(u, 0, 0, 0)).toBe(1);
  });

  it('wake outranks trail and window', () => {
    const u: TimeFilterUniformValues = {
      ...ZERO_UNIFORMS,
      currentTime,
      wakeLength: 100,
      trailLength: 100,
      windowHalf: 100,
    };
    // age 50 of a 100 wake ⇒ 0.5. The trail branch would have used vertexTime.
    expect(deckAlphaJS(u, 950, 0, 0)).toBeCloseTo(0.5, 9);
  });

  it('trail outranks window', () => {
    const u: TimeFilterUniformValues = {
      ...ZERO_UNIFORMS,
      currentTime,
      trailLength: 100,
      trailFade: 1,
      windowHalf: 100,
    };
    // Reads vertexTime (950 ⇒ 0.5), not the feature interval.
    expect(deckAlphaJS(u, 0, 0, 950)).toBeCloseTo(0.5, 9);
  });
});

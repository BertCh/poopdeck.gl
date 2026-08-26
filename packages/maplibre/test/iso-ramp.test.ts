/**
 * Parity tests for the iso-level shader math (`src/shaders/iso-ramp.glsl.ts`).
 *
 * The chunk ships a JS twin for every GLSL function precisely so this suite can
 * hold the two to the same numbers with no GL context — the
 * `test/time-window.test.ts` idiom. But a twin is only an oracle if something
 * checks that it still says what the GLSL says, so this file does not simply
 * exercise the JS: it TRANSPILES each GLSL function body (the handful of
 * constructs the chunk uses — `clamp`, `mix`, `floor`, `abs`, `min`, `max`,
 * swizzles, a fixed-count loop) into a JS function and sweeps both
 * implementations over the same inputs.
 *
 * That makes an unmirrored edit to either side a loud failure instead of a
 * silent rendering drift, which is the whole contract the chunk's header
 * claims. The independent numeric goldens below (hand-computed, not derived
 * from either implementation) are what stops the pair from agreeing on a
 * wrong answer.
 */

import { describe, it, expect } from 'vitest';
import {
  ISO_RAMP_GLSL,
  ISO_RAMP_UNIFORMS_GLSL,
  MAX_ISO_RAMP_STOPS,
  fitIsoRamp,
  isoLevelTJS,
  isoMajorJS,
  isoRampColorJS,
  isoWidthJS,
  resolveIsoRampUniformLocations,
} from '../src/shaders/iso-ramp.glsl';
import type { RGBA } from '../src/base-layer';

// ─────────────────────────── the GLSL → JS bridge ───────────────────────────

/** Body of `name`'s definition in `src`, brace-matched (no regex nesting). */
function functionBody(src: string, name: string): string {
  const at = src.indexOf(`${name}(`);
  expect(at).toBeGreaterThan(-1);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/** Parameter names of `name`'s definition, in order. */
function functionParams(src: string, name: string): string[] {
  const at = src.indexOf(`${name}(`);
  const args = src.slice(at + name.length + 1, src.indexOf(')', at));
  return args
    .split(',')
    .map((a) => a.trim().split(/\s+/).pop()!)
    .filter(Boolean);
}

const PRELUDE = `
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const mix = (a, b, t) =>
    Array.isArray(a) ? a.map((v, i) => v + (b[i] - v) * t) : a + (b - a) * t;
  const abs = Math.abs, floor = Math.floor, min = Math.min, max = Math.max;
`;

/**
 * Compile one GLSL function from the chunk into a JS function. Deliberately
 * NOT a general GLSL parser — it handles exactly the constructs this chunk
 * uses, and anything else it silently mistranslates would surface immediately
 * as a sweep mismatch below.
 */
function transpile(name: string, extraArgs: string[] = []): Function {
  const params = functionParams(ISO_RAMP_GLSL, name);
  const body = functionBody(ISO_RAMP_GLSL, name)
    // Strip comments before anything else — they contain prose with dots.
    .replace(/\/\/[^\n]*/g, '')
    // `float(k)` / `int(x)` constructor casts.
    .replace(/\b(?:float|int)\s*\(/g, 'Number(')
    // Declarations of every scalar/vector type this chunk declares.
    .replace(/\b(?:float|int|vec2|vec4)\s+(\w+)\s*=/g, 'let $1 =')
    // Swizzles on the vec2 parameters (`domain.x` → `domain[0]`).
    .replace(/\.x\b/g, '[0]')
    .replace(/\.y\b/g, '[1]');
  return new Function(...params, ...extraArgs, PRELUDE + body);
}

const glslIsoLevelT = transpile('sttIsoLevelT') as (
  level: number,
  domain: readonly [number, number],
) => number;
const glslIsoMajor = transpile('sttIsoMajor') as (
  level: number,
  interval: number,
) => number;
const glslIsoWidth = transpile('sttIsoWidth') as (
  t: number,
  baseWidth: number,
  enabled: number,
  widthRange: readonly [number, number],
) => number;
const glslIsoRampColor = transpile('sttIsoRampColor', [
  'uIsoRamp',
  'uIsoRampCount',
]) as (t: number, ramp: ReadonlyArray<RGBA>, count: number) => RGBA;

/** GLSL's uniform array is fixed-length; a shorter caller ramp pads to it. */
function padRamp(ramp: ReadonlyArray<RGBA>): RGBA[] {
  const out: RGBA[] = [];
  for (let i = 0; i < MAX_ISO_RAMP_STOPS; i++) {
    out.push([...(ramp[Math.min(i, ramp.length - 1)] ?? [0, 0, 0, 0])] as RGBA);
  }
  return out;
}

const RAMP3: RGBA[] = [
  [0, 0, 1, 1],
  [0, 1, 0, 1],
  [1, 0, 0, 1],
];

// ────────────────────────────── sttIsoLevelT ──────────────────────────────

describe('sttIsoLevelT — GLSL vs JS twin', () => {
  const cases: Array<[number, [number, number]]> = [
    [500, [480, 560]],
    [480, [480, 560]],
    [560, [480, 560]],
    [470, [480, 560]], // below the domain — clamps to 0
    [600, [480, 560]], // above — clamps to 1
    [500, [500, 500]], // degenerate domain
    [-30, [-40, 0]],
    [0, [10, -10]], // inverted domain: span is negative, still finite
  ];
  it.each(cases)('level %s in domain %j agrees', (level, domain) => {
    expect(glslIsoLevelT(level, domain)).toBeCloseTo(
      isoLevelTJS(level, domain),
      12,
    );
  });

  it('hits hand-computed goldens (independent of both implementations)', () => {
    // (500 - 480) / (560 - 480) = 20 / 80 = 0.25
    expect(isoLevelTJS(500, [480, 560])).toBe(0.25);
    expect(isoLevelTJS(560, [480, 560])).toBe(1);
    expect(isoLevelTJS(480, [480, 560])).toBe(0);
  });

  it('a degenerate domain pins to 0 rather than dividing by zero', () => {
    // The header's argument: one contour level must render as a COLOUR, not a
    // NaN that blanks the tile.
    expect(isoLevelTJS(500, [500, 500])).toBe(0);
    expect(Number.isNaN(isoLevelTJS(500, [500, 500]))).toBe(false);
    expect(glslIsoLevelT(500, [500, 500])).toBe(0);
  });
});

// ───────────────────────────── sttIsoRampColor ─────────────────────────────

describe('sttIsoRampColor — GLSL vs JS twin', () => {
  it.each([0, 0.1, 0.25, 0.5, 0.5001, 0.75, 1, -0.4, 1.7])(
    't = %s agrees stop-for-stop',
    (t) => {
      const glsl = glslIsoRampColor(t, padRamp(RAMP3), RAMP3.length);
      const js = isoRampColorJS(t, RAMP3);
      for (let i = 0; i < 4; i++) expect(glsl[i]).toBeCloseTo(js[i], 6);
    },
  );

  it('lerps between stops rather than bucketing them', () => {
    // t = 0.25 with 3 stops → scaled = 0.5 → half way from stop 0 to stop 1.
    expect(isoRampColorJS(0.25, RAMP3)).toEqual([0, 0.5, 0.5, 1]);
    // A bucketing implementation would return a stop verbatim here.
    expect(isoRampColorJS(0.25, RAMP3)).not.toEqual(RAMP3[0]);
  });

  it('a single-stop ramp is a constant colour in both implementations', () => {
    const one: RGBA[] = [[0.2, 0.4, 0.6, 0.8]];
    expect(isoRampColorJS(0.7, one)).toEqual([0.2, 0.4, 0.6, 0.8]);
    const glsl = glslIsoRampColor(0.7, padRamp(one), 1);
    expect([...glsl]).toEqual([0.2, 0.4, 0.6, 0.8]);
  });

  it('the GLSL loop is bounded by MAX_ISO_RAMP_STOPS (WebGL1 constant index)', () => {
    // GLSL ES 1.00 does not guarantee dynamic indexing of uniform arrays; the
    // compare-in-a-fixed-loop is the reason this chunk links on WebGL1 at all.
    expect(ISO_RAMP_GLSL).toContain(
      `for (int k = 0; k < ${MAX_ISO_RAMP_STOPS}`,
    );
    expect(ISO_RAMP_UNIFORMS_GLSL).toContain(
      `uniform vec4 uIsoRamp[${MAX_ISO_RAMP_STOPS}]`,
    );
  });
});

describe('fitIsoRamp', () => {
  it('passes a short ramp through stop-for-stop (no resampling error)', () => {
    const out = fitIsoRamp(RAMP3);
    expect(out).toEqual(RAMP3);
    expect(out[0]).not.toBe(RAMP3[0]); // copied, not aliased
  });

  it('RESAMPLES a long ramp instead of truncating it', () => {
    const long: RGBA[] = Array.from(
      { length: 40 },
      (_, i) => [i / 39, 0, 0, 1] as RGBA,
    );
    const out = fitIsoRamp(long);
    expect(out).toHaveLength(MAX_ISO_RAMP_STOPS);
    // Endpoints preserved: truncation would drop the top of the ramp, which on
    // a contour map reads as "the storm core is missing".
    expect(out[0][0]).toBeCloseTo(0, 12);
    expect(out[MAX_ISO_RAMP_STOPS - 1][0]).toBeCloseTo(1, 12);
    // ...and the interior is the shader's own lerp, not a stride.
    expect(out[8][0]).toBeCloseTo(
      isoRampColorJS(8 / (MAX_ISO_RAMP_STOPS - 1), long)[0],
      12,
    );
  });
});

// ─────────────────────────────── sttIsoMajor ───────────────────────────────

describe('sttIsoMajor — GLSL vs JS twin', () => {
  const cases: Array<[number, number]> = [
    [500, 60],
    [540, 60],
    [520, 20],
    [850, 50],
    [850.02, 50],
    [-120, 60],
    [0, 60],
    [500, 0], // disabled
    [500, -10], // disabled
    [1e6 + 1, 1000],
  ];
  it.each(cases)('level %s interval %s agrees', (level, interval) => {
    expect(glslIsoMajor(level, interval)).toBe(isoMajorJS(level, interval));
  });

  it('hits hand-computed goldens', () => {
    expect(isoMajorJS(540, 60)).toBe(1); // 540 = 9 × 60
    expect(isoMajorJS(530, 60)).toBe(0);
    expect(isoMajorJS(0, 60)).toBe(1); // zero is on every interval
    expect(isoMajorJS(-120, 60)).toBe(1); // and so are negative multiples
  });

  it('an interval of 0 disables emphasis rather than matching everything', () => {
    expect(isoMajorJS(500, 0)).toBe(0);
    expect(glslIsoMajor(500, 0)).toBe(0);
  });

  it('tolerates an f32 ulp — a strict equality would flicker between tiles', () => {
    const level = Math.fround(850); // exact, but quantisation can nudge it
    const nudged = level + level * 1e-7;
    expect(isoMajorJS(nudged, 50)).toBe(1);
    expect(glslIsoMajor(nudged, 50)).toBe(1);
    // A thousandth of the interval is the stated tolerance, and it is TIGHT:
    // one part in 20 of the way to the next contour is not "on the interval".
    expect(isoMajorJS(850 + 2.5, 50)).toBe(0);
    expect(ISO_RAMP_GLSL).toContain('interval * 1e-3');
  });
});

// ─────────────────────────────── sttIsoWidth ───────────────────────────────

describe('sttIsoWidth — GLSL vs JS twin', () => {
  const cases: Array<[number, number, number, [number, number]]> = [
    [0, 2, 1, [1, 5]],
    [0.5, 2, 1, [1, 5]],
    [1, 2, 1, [1, 5]],
    [0.5, 2, 0, [1, 5]], // disabled ⇒ the base width survives
    [0.5, 2, 0.5, [1, 5]], // partially enabled (the uniform is a product)
    [-1, 2, 1, [1, 5]], // t clamps
    [4, 2, 1, [5, 1]], // descending range
  ];
  it.each(cases)(
    't=%s base=%s enabled=%s range=%j agrees',
    (t, base, enabled, range) => {
      expect(glslIsoWidth(t, base, enabled, range)).toBeCloseTo(
        isoWidthJS(t, base, enabled, range),
        12,
      );
    },
  );

  it('hits hand-computed goldens', () => {
    expect(isoWidthJS(0.5, 2, 1, [1, 5])).toBe(3); // mid of [1,5]
    expect(isoWidthJS(0, 2, 1, [1, 5])).toBe(1);
    expect(isoWidthJS(1, 2, 1, [1, 5])).toBe(5);
  });

  it('a tile with no level column keeps its flat width', () => {
    // `enabled` is the AND of "the option is on" and "this tile has the
    // column" — a column-less tile must not collapse to widthRange.x.
    expect(isoWidthJS(0, 2.5, 0, [1, 5])).toBe(2.5);
    expect(isoWidthJS(1, 2.5, 0, [1, 5])).toBe(2.5);
    expect(glslIsoWidth(1, 2.5, 0, [1, 5])).toBeCloseTo(2.5, 12);
  });
});

// ──────────────────────────── the uniform block ────────────────────────────

describe('ISO_RAMP_UNIFORMS_GLSL / resolveIsoRampUniformLocations', () => {
  it('resolves exactly the names the block declares', () => {
    const declared = [
      ...ISO_RAMP_UNIFORMS_GLSL.matchAll(/uniform\s+\w+\s+(\w+)/g),
    ].map((m) => m[1]);
    const asked: string[] = [];
    const gl = {
      getUniformLocation: (_p: unknown, n: string) => {
        asked.push(n);
        return { n };
      },
    } as unknown as WebGLRenderingContext;
    const locs = resolveIsoRampUniformLocations(gl, {} as WebGLProgram);
    expect(new Set(asked)).toEqual(new Set(declared));
    expect(new Set(Object.keys(locs))).toEqual(new Set(declared));
    // The array resolves by its BARE name — one uniform4fv fills onward
    // from element 0.
    expect(asked).toContain('uIsoRamp');
    expect(asked).not.toContain('uIsoRamp[0]');
  });

  it('the block ends with a newline (the .trimEnd() splice contract)', () => {
    expect(ISO_RAMP_UNIFORMS_GLSL.endsWith('\n')).toBe(true);
  });
});

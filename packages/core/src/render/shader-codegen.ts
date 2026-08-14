// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * The SECOND ORACLE for the scalar time-filter alpha.
 *
 * `./time-filter`'s `timeFilterAlpha` is THE oracle: the single framework-free
 * definition of the alpha math, written with `if`/early-return control flow.
 * This module states the same four mode formulas a second time, independently
 * derived, as a BRANCHLESS expression AST (`ALPHA_EXPR`) over a frozen op-set,
 * plus a CPU evaluator (`evalExpr`). The two must agree numerically — a 2000-
 * sample randomized sweep in `../../test/shader-codegen.test.ts` pins them.
 *
 * WHY a second implementation rather than one: two independent derivations
 * disagree where the SPECIFICATION is ambiguous, which a single implementation
 * can never reveal. `packages/maplibre/test/time-modes.test.ts` documents two
 * real out-of-contract inputs (`wakeLength <= 0`, negative `fadeIn`) found
 * exactly this way and pins them explicitly. Every renderer backend hand-writes
 * its own shader in its own dialect and is held to BOTH oracles by a conformance
 * test — see docs/spec/render-spec.json for the per-backend obligations, and
 * docs/api/render-kernel.md for the architecture.
 *
 * NOT a shader compiler, and no longer pretends to be one. This module emits no
 * GLSL at all: the `emitGLSL300` string emitter and its sole caller,
 * `@poopdeck.gl/cesium`'s `timeFilterAlphaGlsl`, were removed at the 0.6.0 cut
 * because no shipped shader was ever generated from them (`emitGLSL100` had
 * gone the same way earlier, for the same reason). Every backend hand-writes
 * its shader in its own dialect. What survives is the load-bearing half — the
 * AST and `evalExpr` — because its VALUE, not its text, is what the conformance
 * tests compare against each backend.
 *
 * Re-adding an emitter is a small, mechanical job (walk the frozen op-set,
 * emitting `step`/`min`/`max`/`clamp`/ternary, which is valid in GLSL ES 1.00
 * and 3.00 alike). Do it when something actually compiles the output — not
 * before, since an emitter nothing calls cannot be wrong in any way a test
 * would notice.
 *
 * SCOPE: LINEAR alpha modes only — `window`, `wake`, `cumulative`, `trail`. The
 * surfel/splat temporal-Gaussian weight (`exp(dt²·-0.5)`) and radial falloff
 * (`exp(-falloff·r²)`), plus the `wakeSizeScale` VERTEX-stage multiplier, use
 * transcendentals OUTSIDE this frozen op-set and are DELIBERATELY excluded —
 * they stay per-backend, pinned to the CPU oracle by parity tests. Widening the
 * op-set requires the spec edit + the conformance-obligation gate it documents.
 *
 * The frozen op-set: uniform, attr, const, add, sub, mul, div, min, max, step,
 * clamp01, select. `select(c,t,f)` is `c != 0 ? t : f` and is emitted as a GLSL
 * ternary (lazy — only the taken branch is evaluated), which is what keeps a
 * `div`-by-zero fade guard from producing NaN without needing an epsilon.
 */

export type Expr =
  | { op: 'uniform'; name: string }
  | { op: 'attr'; name: string }
  | { op: 'const'; value: number }
  | {
      op: 'add' | 'sub' | 'mul' | 'div' | 'min' | 'max' | 'step';
      a: Expr;
      b: Expr;
    }
  | { op: 'clamp01'; a: Expr }
  | { op: 'select'; c: Expr; t: Expr; f: Expr };

// ─── AST builders ────────────────────────────────────────────────────────────
const u = (name: string): Expr => ({ op: 'uniform', name });
const at = (name: string): Expr => ({ op: 'attr', name });
const k = (value: number): Expr => ({ op: 'const', value });
const add = (a: Expr, b: Expr): Expr => ({ op: 'add', a, b });
const sub = (a: Expr, b: Expr): Expr => ({ op: 'sub', a, b });
const mul = (a: Expr, b: Expr): Expr => ({ op: 'mul', a, b });
const div = (a: Expr, b: Expr): Expr => ({ op: 'div', a, b });
/** step(edge, x) = x >= edge ? 1 : 0 (matches GLSL `step`). */
const step = (edge: Expr, x: Expr): Expr => ({ op: 'step', a: edge, b: x });
const clamp01 = (a: Expr): Expr => ({ op: 'clamp01', a });
/** select(c, t, f) = c != 0 ? t : f. */
const select = (c: Expr, t: Expr, f: Expr): Expr => ({ op: 'select', c, t, f });

// ─── Canonical env variable names (the shader's uniform/attr identifiers) ─────
export const TIME_FILTER_VARS = {
  currentTime: 'currentTime', // uniform, relative to offset
  startTime: 'startTime', // attr
  endTime: 'endTime', // attr
  vertexTime: 'vertexTime', // attr (trail)
  windowHalf: 'windowHalf', // uniform
  fadeIn: 'fadeIn', // uniform
  fadeOut: 'fadeOut', // uniform
  wakeLength: 'wakeLength', // uniform
  trailLength: 'trailLength', // uniform
  trailFade: 'trailFade', // uniform
} as const;

const cur = u('currentTime');
const startT = at('startTime');
const endT = at('endTime');
const vtx = at('vertexTime');
const windowHalf = u('windowHalf');
const fadeIn = u('fadeIn');
const fadeOut = u('fadeOut');
const wakeLength = u('wakeLength');
const trailLength = u('trailLength');
const trailFade = u('trailFade');

// window: visible while [start,end] overlaps [cur ± windowHalf], with optional
// leading (fadeIn) / trailing (fadeOut) ramps. Branchless via step + select.
const timeStart = sub(cur, windowHalf);
const timeEnd = add(cur, windowHalf);
const windowExpr: Expr = mul(
  mul(step(timeStart, endT), step(startT, timeEnd)), // visible
  mul(
    select(fadeIn, clamp01(div(sub(timeEnd, startT), fadeIn)), k(1)), // fadeIn factor
    select(fadeOut, clamp01(div(sub(endT, timeStart), fadeOut)), k(1)), // fadeOut factor
  ),
);

// wake: visible in [0, wakeLength] behind the playhead, fading to 0 at the tail.
const wakeAge = sub(cur, startT);
const wakeExpr: Expr = mul(
  mul(step(k(0), wakeAge), step(wakeAge, wakeLength)), // 0 <= age <= wakeLength
  select(wakeLength, clamp01(sub(k(1), div(wakeAge, wakeLength))), k(0)),
);

// cumulative: appears at startTime and persists; optional fadeIn ramp.
const cumulativeExpr: Expr = mul(
  step(startT, cur), // cur >= startTime
  select(fadeIn, clamp01(div(sub(cur, startT), fadeIn)), k(1)),
);

// trail: per-vertex; visible in [cur - trailLength, cur]; trailFade blends solid
// (0) vs head→tail linear fade (1).
const trailStart = sub(cur, trailLength);
const trailAge = sub(cur, vtx);
const trailFaded = select(
  trailLength,
  clamp01(sub(k(1), div(trailAge, trailLength))),
  k(0),
);
const trailExpr: Expr = mul(
  mul(step(vtx, cur), step(trailStart, vtx)), // trailStart <= vtx <= cur
  clamp01(add(sub(k(1), trailFade), mul(trailFaded, trailFade))),
);

export type TimeFilterModeKey = 'window' | 'wake' | 'cumulative' | 'trail';

/** The frozen per-mode alpha ASTs (linear modes only). `none` ⇒ constant 1. */
export const ALPHA_EXPR: Record<TimeFilterModeKey, Expr> = {
  window: windowExpr,
  wake: wakeExpr,
  cumulative: cumulativeExpr,
  trail: trailExpr,
};

// ─── CPU oracle ──────────────────────────────────────────────────────────────

/**
 * Evaluate an {@link Expr} against an environment of uniform/attr values. This is
 * the numerical oracle the emitted shaders must match; a conformance test asserts
 * `evalExpr(ALPHA_EXPR[mode], env)` equals `timeFilterAlpha(mode, …)` from
 * `./time-filter`. `select` is lazy (only the taken branch is evaluated), so a
 * fade `div` by a zero denominator is never computed when its `select` guard is 0.
 */
export function evalExpr(e: Expr, env: Record<string, number>): number {
  switch (e.op) {
    case 'uniform':
    case 'attr':
      return env[e.name] ?? 0;
    case 'const':
      return e.value;
    case 'add':
      return evalExpr(e.a, env) + evalExpr(e.b, env);
    case 'sub':
      return evalExpr(e.a, env) - evalExpr(e.b, env);
    case 'mul':
      return evalExpr(e.a, env) * evalExpr(e.b, env);
    case 'div':
      return evalExpr(e.a, env) / evalExpr(e.b, env);
    case 'min':
      return Math.min(evalExpr(e.a, env), evalExpr(e.b, env));
    case 'max':
      return Math.max(evalExpr(e.a, env), evalExpr(e.b, env));
    case 'step': {
      const edge = evalExpr(e.a, env);
      const x = evalExpr(e.b, env);
      return x >= edge ? 1 : 0;
    }
    case 'clamp01': {
      const v = evalExpr(e.a, env);
      return v < 0 ? 0 : v > 1 ? 1 : v;
    }
    case 'select':
      return evalExpr(e.c, env) !== 0 ? evalExpr(e.t, env) : evalExpr(e.f, env);
  }
}

// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * STT shader codegen — the scalar time-filter alpha authored ONCE as an
 * expression AST and machine-emitted to each backend's shading dialect, so the
 * GPU math has no hand-maintained copy to drift (see
 * docs/roadmap/renderer-abstraction-2026-06.md §4.3 tier 2). `evalExpr` is the
 * CPU oracle and MUST equal `./time-filter`'s `timeFilterAlpha` numerically (a
 * conformance test pins this); `emitGLSL100` / `emitGLSL300` are pure string
 * emitters that produce deck's inject snippet and maplibre's GLSL; `emitTSL`
 * lives in `@poopdeck.gl/three` (it needs `three/tsl`) and consumes the same
 * `Expr` data.
 *
 * SCOPE: LINEAR alpha modes only — `window`, `wake`, `cumulative`, `trail`. The
 * surfel/splat temporal-Gaussian weight (`exp(dt²·-0.5)`) and radial falloff
 * (`exp(-falloff·r²)`), plus the `wakeSizeScale` VERTEX-stage multiplier, use
 * transcendentals OUTSIDE this frozen op-set and are DELIBERATELY excluded — they
 * stay per-backend, pinned to the CPU oracle by parity tests. Adding an op to the
 * set is gated on all three emitters compiling it.
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

// ─── GLSL emitters ─────────────────────────────────────────────────────────────

/** Format a JS number as a GLSL float literal (always with a decimal point). */
function glslFloat(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`cannot emit non-finite const ${v}`);
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

/**
 * Emit a GLSL expression string for an {@link Expr}. `nameMap` optionally rewrites
 * the canonical uniform/attr identifiers to the host shader's actual variable
 * names. The emitted subset (step/min/max/clamp/ternary) is valid in BOTH GLSL ES
 * 1.00 and 3.00, so {@link emitGLSL100} and {@link emitGLSL300} share it today;
 * they stay separate entry points so a future op can diverge per dialect.
 */
function emitGLSLExpr(e: Expr, nameMap?: Record<string, string>): string {
  const name = (n: string) => nameMap?.[n] ?? n;
  const go = (x: Expr): string => emitGLSLExpr(x, nameMap);
  switch (e.op) {
    case 'uniform':
    case 'attr':
      return name(e.name);
    case 'const':
      return glslFloat(e.value);
    case 'add':
      return `(${go(e.a)} + ${go(e.b)})`;
    case 'sub':
      return `(${go(e.a)} - ${go(e.b)})`;
    case 'mul':
      return `(${go(e.a)} * ${go(e.b)})`;
    case 'div':
      return `(${go(e.a)} / ${go(e.b)})`;
    case 'min':
      return `min(${go(e.a)}, ${go(e.b)})`;
    case 'max':
      return `max(${go(e.a)}, ${go(e.b)})`;
    case 'step':
      return `step(${go(e.a)}, ${go(e.b)})`;
    case 'clamp01':
      return `clamp(${go(e.a)}, 0.0, 1.0)`;
    case 'select':
      return `((${go(e.c)}) != 0.0 ? ${go(e.t)} : ${go(e.f)})`;
  }
}

export function emitGLSL300(e: Expr, nameMap?: Record<string, string>): string {
  return emitGLSLExpr(e, nameMap);
}

export function emitGLSL100(e: Expr, nameMap?: Record<string, string>): string {
  return emitGLSLExpr(e, nameMap);
}

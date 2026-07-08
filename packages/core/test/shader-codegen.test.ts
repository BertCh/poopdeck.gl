// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import {
  ALPHA_EXPR,
  evalExpr,
  emitGLSL100,
  emitGLSL300,
  type Expr,
  type TimeFilterModeKey,
} from '../src/render/shader-codegen';
import {
  timeFilterAlpha,
  type TimeFilterParams,
} from '../src/render/time-filter';

// Deterministic LCG so the conformance sweep is reproducible (no Math.random).
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Build the Expr env + oracle params for a mode from a random source. */
function sample(mode: TimeFilterModeKey, rnd: () => number) {
  const currentTime = rnd() * 1e6;
  // Durations avoid 0 (0-length windows are invalid config; the AST guards them
  // for NaN-safety but the oracle would divide by zero).
  const dur = () => 1 + rnd() * 1e5;
  const startTime = currentTime + (rnd() - 0.5) * 4e5;
  const endTime = startTime + rnd() * 1e5;
  const vertexTime = currentTime + (rnd() - 0.5) * 4e5;
  const windowHalf = dur();
  // Fades: allow exactly 0 (hard cut) AND >0 — both must match the oracle.
  const fadeIn = rnd() < 0.3 ? 0 : dur();
  const fadeOut = rnd() < 0.3 ? 0 : dur();
  const wakeLength = dur();
  const trailLength = dur();
  const trailFade = rnd();

  const env: Record<string, number> = {
    currentTime,
    startTime,
    endTime,
    vertexTime,
    windowHalf,
    fadeIn,
    fadeOut,
    wakeLength,
    trailLength,
    trailFade,
  };
  const params: TimeFilterParams = {
    windowHalf,
    fadeIn,
    fadeOut,
    wakeLength,
    trailLength,
    trailFade,
  };
  return { env, params };
}

const MODES: TimeFilterModeKey[] = ['window', 'wake', 'cumulative', 'trail'];

describe('shader-codegen ALPHA_EXPR matches the time-filter oracle', () => {
  for (const mode of MODES) {
    it(`evalExpr(${mode}) == timeFilterAlpha(${mode}) over 2000 random envs`, () => {
      const rnd = lcg(0xc0ffee + mode.length);
      let maxErr = 0;
      for (let i = 0; i < 2000; i++) {
        const { env, params } = sample(mode, rnd);
        const got = evalExpr(ALPHA_EXPR[mode], env);
        const want = timeFilterAlpha(
          mode,
          env.currentTime,
          env.startTime,
          env.endTime,
          params,
          env.vertexTime,
        );
        maxErr = Math.max(maxErr, Math.abs(got - want));
      }
      expect(maxErr).toBeLessThan(1e-6);
    });
  }

  it('matches at window boundary conditions (equality edges + age==fadeIn)', () => {
    // Feature exactly at the trailing edge: endTime == currentTime - windowHalf.
    const cur = 1000,
      wh = 100,
      fi = 20,
      fo = 20;
    const cases = [
      { startTime: cur - wh, endTime: cur - wh }, // just entering (leading)
      { startTime: cur + wh, endTime: cur + wh }, // just at trailing edge
      { startTime: cur, endTime: cur }, // center
      { startTime: cur + wh - fi, endTime: cur + wh }, // age == fadeIn
    ];
    for (const c of cases) {
      const env = {
        currentTime: cur,
        startTime: c.startTime,
        endTime: c.endTime,
        windowHalf: wh,
        fadeIn: fi,
        fadeOut: fo,
      };
      const got = evalExpr(ALPHA_EXPR.window, env);
      const want = timeFilterAlpha('window', cur, c.startTime, c.endTime, {
        windowHalf: wh,
        fadeIn: fi,
        fadeOut: fo,
      });
      expect(got).toBeCloseTo(want, 9);
    }
  });
});

describe('GLSL emitters', () => {
  it('emit a stable, decimal-formatted expression for each mode', () => {
    for (const mode of MODES) {
      const s = emitGLSL300(ALPHA_EXPR[mode] as Expr);
      expect(s).not.toContain('undefined');
      expect(s).not.toContain('NaN');
      // GLSL float literals: no bare integer token (every const carries a `.`).
      expect(s).not.toMatch(/(?<![\d.])\d+(?![\d.])/);
    }
  });

  it('GLSL ES 1.00 and 3.00 emit the same string for the linear op-set', () => {
    for (const mode of MODES) {
      expect(emitGLSL100(ALPHA_EXPR[mode])).toBe(emitGLSL300(ALPHA_EXPR[mode]));
    }
  });

  it('honors a nameMap for host-specific identifiers', () => {
    const s = emitGLSL300(ALPHA_EXPR.cumulative, {
      currentTime: 'uCur',
      startTime: 'vStart',
      fadeIn: 'uFadeIn',
    });
    expect(s).toContain('uCur');
    expect(s).toContain('vStart');
    expect(s).not.toContain('currentTime');
  });

  it('window emit is deterministic and structurally complete', () => {
    const s = emitGLSL300(ALPHA_EXPR.window);
    // Deterministic: same AST → identical string every call.
    expect(emitGLSL300(ALPHA_EXPR.window)).toBe(s);
    // Contains the visibility (step), fade ramp (clamp), and fade guard (ternary).
    expect(s).toContain('step(');
    expect(s).toContain('clamp(');
    expect(s).toContain('!= 0.0 ?');
    // Every referenced var appears.
    for (const v of [
      'currentTime',
      'windowHalf',
      'startTime',
      'endTime',
      'fadeIn',
      'fadeOut',
    ]) {
      expect(s).toContain(v);
    }
    // Balanced parentheses.
    let depth = 0;
    for (const ch of s) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
});

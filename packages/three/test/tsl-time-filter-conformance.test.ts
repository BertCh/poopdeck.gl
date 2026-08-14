// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
/**
 * Oracle-conformance tests for the three backend's time filter.
 *
 * The three backend ships TWO artefacts for the same math, and before this file
 * NEITHER was pinned to the cross-backend oracles:
 *
 *   • `src/tsl/time-filter-math.ts` — the CPU mirror. Its `*Alpha` half is a
 *     RE-EXPORT of core's `time-filter.ts` (so it is pinned only in the trivial
 *     sense that it *is* the oracle — asserted below, because a future edit
 *     could fork it). Its `*Visible` half is three-LOCAL logic that exists
 *     NOWHERE else in the monorepo and had only spot-check coverage.
 *   • `src/tsl/time-filter.ts` — the TSL node graph that actually ships to the
 *     GPU. Nothing in the repo referenced `timeFilterAlphaNode` /
 *     `timeFilterVisibleNode`; its "keep the two in lockstep" header was
 *     enforced by a comment and nothing else.
 *
 * The contract pinned here is five-way:
 *
 *   1. three's `*Alpha` re-exports ARE core `time-filter.ts`'s functions
 *      (identity, not just equality) — so the alpha oracle cannot silently fork.
 *   2. three's LOCAL `*Visible`  ⟷  the core oracle, via the load-bearing
 *      safe-collapse invariant
 *
 *          visible === 0  ⟹  alpha === 0     (equivalently alpha > 0 ⟹ visible === 1)
 *
 *      over a dense sweep including boundaries, degenerate 0-length durations
 *      and negative fades. This is not decorative: `*Visible` is multiplied into
 *      a primitive's SIZE / SCALE in the VERTEX stage, so a false 0 makes a
 *      feature that should draw collapse to zero extent and VANISH.
 *   3. three's LOCAL `*Visible`  ==  the `step(...)·step(...)` visibility factor
 *      that core `shader-codegen.ts`'s `ALPHA_EXPR[mode]` multiplies in — the
 *      second, branchless oracle. For `window` / `cumulative` / `trail` this is
 *      an EXACT equality once the ramp knobs are set to their no-op value; for
 *      `wake` (whose ramp has no "off" setting) it is the same implication.
 *   4. the shipped TSL node graph  ==  `time-filter-math.ts`, NUMERICALLY — the
 *      graph is EXECUTED, not string-matched (see below).
 *   5. the shipped TSL node graph  ==  `evalExpr(ALPHA_EXPR[mode])`.
 *
 * ── WHAT IS AND IS NOT ENFORCEABLE HEADLESS ──────────────────────────────────
 * TSL is a runtime node graph, not source text, and every node three emits for
 * this math is plain-old-data introspectable in node: `ConstNode`/`UniformNode`
 * carry `.value`, `OperatorNode` carries `.op` + `.aNode`/`.bNode`, `MathNode`
 * carries `.method` + `.aNode`/`.bNode`/`.cNode`, `ConditionalNode` carries
 * `.condNode`/`.ifNode`/`.elseNode`, `VarNode` wraps `.node`. So — unlike
 * maplibre's GLSL, which can only be structurally locked — the SHIPPED graph is
 * built ONCE per mode and then EVALUATED on the CPU by {@link evalTSL} below,
 * with the per-instance attributes bound to uniform nodes whose `.value` we vary
 * exactly the way a draw call varies them. That is a real execution of the real
 * graph: delete a node, flip a comparison, or drop the EPS guard and the numbers
 * move.
 *
 * What this canNOT prove, and is not claimed:
 *   • three's WGSL/GLSL CODE GENERATOR is not exercised. `evalTSL` implements
 *     each node class's op semantics directly; it does not call `NodeBuilder`.
 *     GPU compilation stays browser-verified (see `vitest.config.ts`).
 *   • f64, not f32. Same caveat the CPU oracle itself carries; maplibre's test
 *     owns the f32 precision contract for the shared formula.
 *   • `evalTSL` THROWS on any node class or op it does not know, so a graph
 *     rewritten with a new operator fails loudly here instead of silently
 *     passing — that is deliberate, not an oversight.
 *
 * ── DOCUMENTED DIVERGENCES ───────────────────────────────────────────────────
 * Three input classes where the implementations genuinely disagree are pinned
 * explicitly at the bottom rather than avoided or tolerance-fudged, so a change
 * in ANY of the three implementations surfaces here:
 *   A. zero-length `wakeLength` / `trailLength` at age exactly 0 — TSL 1, core
 *      NaN, codegen AST 0 (a three-way split).
 *   B. negative `fadeIn`/`fadeOut` — TSL follows core (ramp off ⇒ 1); the AST
 *      gates on `!= 0` and returns 0. Same divergence maplibre pins.
 *   C. sub-EPS (< 1e-6 ms) fade/duration — the TSL graph's `max(x, 1e-6)`
 *      division guard changes the ramp slope where core divides by x directly.
 * All three are out of contract (layers clamp fades at 0 and select wake/trail
 * only when the length is > 0), and A/B are inherited from the shared oracles
 * rather than introduced by three.
 */

import { describe, it, expect } from 'vitest';
import {
  TimeFilterUniforms,
  timeFilterAlphaNode,
  timeFilterVisibleNode,
  wakeSizeScaleNode,
  updateTimeFilterUniforms,
} from '../src/tsl/time-filter';
import { uniform, float } from '../src/tsl/nodes';
import type { TSLNode, UniformNode } from '../src/tsl/nodes';
import * as threeMath from '../src/tsl/time-filter-math';
import {
  windowVisible,
  wakeVisible,
  cumulativeVisible,
  trailVisible,
  timeFilterVisible,
} from '../src/tsl/time-filter-math';
import {
  timeFilterAlpha,
  windowAlpha,
  wakeAlpha,
  cumulativeAlpha,
  trailAlpha,
  wakeSizeScale,
  MAX_RELATIVE_TIME_MS,
  DEFAULT_WAKE_TAIL_SCALE,
} from '@poopdeck.gl/core/time-filter';
import type {
  TimeFilterMode,
  TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';
import { ALPHA_EXPR, evalExpr } from '@poopdeck.gl/core/shader-codegen';
import type { TimeFilterModeKey } from '@poopdeck.gl/core/shader-codegen';

// ─────────────────────────────────────────────────────────────────────────────
// The TSL graph interpreter.
//
// Walks the REAL node objects the shipped builders returned and evaluates them.
// `eager` mirrors the fact that three's codegen is free to lower a
// `ConditionalNode` to an if/else block that assigns a var (both sides
// evaluated) rather than a lazy ternary: in eager mode BOTH branches are
// evaluated and every intermediate is checked finite, which is what proves the
// graph's `max(x, EPS)` division guards actually make every branch safe.
//
// Unknown node classes / ops THROW — see the header.
// ─────────────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */

interface EvalOpts {
  /** Evaluate both branches of every conditional and require finite results. */
  eager?: boolean;
}

function evalTSL(node: any, opts: EvalOpts = {}): number | boolean {
  const v = evalNode(node, opts);
  if (opts.eager && typeof v === 'number' && !Number.isFinite(v)) {
    throw new Error(`non-finite intermediate ${v}`);
  }
  return v;
}

function evalNode(node: any, opts: EvalOpts): number | boolean {
  if (node == null) throw new Error('null TSL node');
  // Inputs: ConstNode (literal) and UniformNode (per-draw value).
  if (node.isConstNode || node.isUniformNode) {
    const value = node.value;
    if (typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error(`non-scalar input node value: ${String(value)}`);
    }
    return value;
  }
  if (node.isOperatorNode) {
    const a = evalTSL(node.aNode, opts) as any;
    const b = evalTSL(node.bNode, opts) as any;
    switch (node.op) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        return a / b;
      case '>=':
        return a >= b;
      case '<=':
        return a <= b;
      case '>':
        return a > b;
      case '<':
        return a < b;
      case '&&':
        return Boolean(a) && Boolean(b);
      case '||':
        return Boolean(a) || Boolean(b);
      default:
        throw new Error(`evalTSL: unhandled OperatorNode op "${node.op}"`);
    }
  }
  if (node.isMathNode) {
    const a = evalTSL(node.aNode, opts) as number;
    switch (node.method) {
      case 'max':
        return Math.max(a, evalTSL(node.bNode, opts) as number);
      case 'min':
        return Math.min(a, evalTSL(node.bNode, opts) as number);
      // GLSL/WGSL step(edge, x) = x >= edge ? 1 : 0.
      case 'step':
        return (evalTSL(node.bNode, opts) as number) >= a ? 1 : 0;
      // `saturate(x)` lowers to clamp(x, 0, 1).
      case 'clamp': {
        const lo = evalTSL(node.bNode, opts) as number;
        const hi = evalTSL(node.cNode, opts) as number;
        return Math.min(Math.max(a, lo), hi);
      }
      case 'mix': {
        const b = evalTSL(node.bNode, opts) as number;
        const t = evalTSL(node.cNode, opts) as number;
        return a * (1 - t) + b * t;
      }
      default:
        throw new Error(`evalTSL: unhandled MathNode method "${node.method}"`);
    }
  }
  // ConditionalNode — `select(cond, ifNode, elseNode)`.
  if (node.condNode !== undefined) {
    const cond = evalTSL(node.condNode, opts);
    if (opts.eager) {
      const t = evalTSL(node.ifNode, opts);
      const f = evalTSL(node.elseNode, opts);
      return cond ? t : f;
    }
    return cond ? evalTSL(node.ifNode, opts) : evalTSL(node.elseNode, opts);
  }
  // VarNode — a transparent wrapper the fluent `.add()/.mul()/…` chain inserts.
  if (node.constructor?.name === 'VarNode' && node.node !== undefined) {
    return evalTSL(node.node, opts);
  }
  throw new Error(
    `evalTSL: unhandled node class "${node.constructor?.name}" ` +
      `(keys: ${Object.keys(node).join(',')})`,
  );
}

/** Count nodes reachable from a graph — a cheap "did we actually walk it" check. */
function nodeCount(node: any, seen = new Set<any>()): number {
  if (node == null || typeof node !== 'object' || seen.has(node)) return 0;
  seen.add(node);
  let n = 1;
  for (const key of [
    'aNode',
    'bNode',
    'cNode',
    'condNode',
    'ifNode',
    'elseNode',
    'node',
  ]) {
    n += nodeCount(node[key], seen);
  }
  return n;
}

/** Collect `{class, op|method}` descriptors for every node in a graph. */
function graphOps(
  node: any,
  out: string[] = [],
  seen = new Set<any>(),
): string[] {
  if (node == null || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  const cls = node.constructor?.name ?? '?';
  out.push(
    node.op ? `${cls}:${node.op}` : node.method ? `${cls}:${node.method}` : cls,
  );
  for (const key of [
    'aNode',
    'bNode',
    'cNode',
    'condNode',
    'ifNode',
    'elseNode',
    'node',
  ]) {
    graphOps(node[key], out, seen);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// A "program": the shipped graph built ONCE per mode, with the per-instance
// attributes bound to uniform nodes we re-point per case (exactly how a draw
// call varies them).
// ─────────────────────────────────────────────────────────────────────────────

interface Program {
  u: TimeFilterUniforms;
  startTime: UniformNode;
  endTime: UniformNode;
  vertexTime: UniformNode;
  alpha: TSLNode;
  visible: TSLNode;
}

function buildProgram(mode: TimeFilterMode): Program {
  const u = new TimeFilterUniforms();
  const startTime = uniform(0);
  const endTime = uniform(0);
  const vertexTime = uniform(0);
  return {
    u,
    startTime,
    endTime,
    vertexTime,
    alpha: timeFilterAlphaNode(mode, u, startTime, endTime, vertexTime),
    visible: timeFilterVisibleNode(mode, u, startTime, endTime, vertexTime),
  };
}

interface Case {
  currentTime: number;
  startTime: number;
  endTime: number;
  vertexTime: number;
  params: TimeFilterParams;
}

function bind(p: Program, c: Case): void {
  updateTimeFilterUniforms(p.u, c.currentTime, c.params);
  p.startTime.value = c.startTime;
  p.endTime.value = c.endTime;
  p.vertexTime.value = c.vertexTime;
}

const runAlpha = (p: Program, c: Case, opts?: EvalOpts): number => {
  bind(p, c);
  return evalTSL(p.alpha, opts) as number;
};
const runVisible = (p: Program, c: Case, opts?: EvalOpts): number => {
  bind(p, c);
  return evalTSL(p.visible, opts) as number;
};

/** The env `evalExpr` wants, from the same case. */
function astEnv(c: Case): Record<string, number> {
  return {
    currentTime: c.currentTime,
    startTime: c.startTime,
    endTime: c.endTime,
    vertexTime: c.vertexTime,
    windowHalf: c.params.windowHalf ?? 0,
    fadeIn: c.params.fadeIn ?? 0,
    fadeOut: c.params.fadeOut ?? 0,
    wakeLength: c.params.wakeLength ?? 0,
    trailLength: c.params.trailLength ?? 0,
    trailFade: c.params.trailFade ?? 1,
  };
}

// ─── Sweeps ──────────────────────────────────────────────────────────────────

const MODES: TimeFilterMode[] = [
  'window',
  'wake',
  'cumulative',
  'trail',
  'none',
];
const AST_MODES: TimeFilterModeKey[] = [
  'window',
  'wake',
  'cumulative',
  'trail',
];

/** Tile-relative "now" values, incl. the f32 ceiling (matches maplibre's sweep). */
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

/**
 * IN-CONTRACT durations: sub-ms through hour, every one ≥ the graph's 1e-6 EPS.
 * The degenerate 0 and negatives are swept ONLY by the invariant + divergence
 * blocks, where their behaviour is pinned explicitly.
 */
const DURATIONS = [0.5, 1, 7, 100, 1000, 60_000, 3_600_000];
/** IN-CONTRACT fades: 0 (hard cut) plus ramps ≥ EPS. */
const FADES = [0, 0.5, 1, 100, 1000, 3_600_000];
/** Age multipliers relative to a duration: before, at both edges, past, far. */
const AGE_FACTORS = [
  -2, -1, -0.001, 0, 0.001, 0.25, 0.5, 0.999, 1, 1.001, 2, 5,
];
/** Degenerate + negative durations/fades, for the invariant sweep only. */
const DEGENERATE = [0, -1, -1000];

/** Build the per-mode case list for a mode, given a duration/fade pool. */
function casesFor(
  mode: TimeFilterMode,
  durations: number[],
  fades: number[],
): Case[] {
  const out: Case[] = [];
  for (const currentTime of CURRENT_TIMES) {
    for (const d of durations) {
      for (const f of AGE_FACTORS) {
        for (const fade of fades) {
          for (const span of [0, 15]) {
            // Scale the offset by the duration so the sweep lands ON the edges.
            const startTime = currentTime - Math.max(Math.abs(d), 1) * f;
            const endTime = startTime + span;
            const params: TimeFilterParams = {
              windowHalf: d,
              fadeIn: fade,
              fadeOut: fade,
              wakeLength: d,
              trailLength: d,
              trailFade: 1,
            };
            out.push({
              currentTime,
              startTime,
              endTime,
              vertexTime: startTime,
              params,
            });
            if (mode === 'trail') {
              // trailFade blends solid (0) vs head→tail fade (1).
              for (const trailFade of [0, 0.25]) {
                out.push({
                  currentTime,
                  startTime,
                  endTime,
                  vertexTime: startTime,
                  params: { ...params, trailFade },
                });
              }
            }
          }
        }
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The alpha re-export is IDENTITY, not a copy.
// ─────────────────────────────────────────────────────────────────────────────

describe('time-filter-math re-exports ARE the core oracle (identity)', () => {
  it('every *Alpha export is the same function object as core', () => {
    // `time-filter-math.ts` claims to re-export so "the alpha math lives in
    // exactly one place". Identity — not numeric equality — is what makes that
    // claim non-forkable; a hand-copied fork would pass an equality sweep on
    // the swept points and drift everywhere else.
    expect(threeMath.windowAlpha).toBe(windowAlpha);
    expect(threeMath.wakeAlpha).toBe(wakeAlpha);
    expect(threeMath.cumulativeAlpha).toBe(cumulativeAlpha);
    expect(threeMath.trailAlpha).toBe(trailAlpha);
    expect(threeMath.wakeSizeScale).toBe(wakeSizeScale);
    expect(threeMath.timeFilterAlpha).toBe(timeFilterAlpha);
  });

  it('the *Visible half is three-LOCAL (absent from the core kernel)', async () => {
    // The flip side: these have no core counterpart, which is exactly why the
    // sweeps below exist. If core ever grows them, this fails and the local
    // copies should be deleted in favour of the shared ones.
    const core = await import('@poopdeck.gl/core/time-filter');
    for (const name of [
      'windowVisible',
      'wakeVisible',
      'cumulativeVisible',
      'trailVisible',
      'timeFilterVisible',
    ]) {
      expect(name in core).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The safe-collapse invariant, three-local *Visible vs the core oracle.
// ─────────────────────────────────────────────────────────────────────────────

describe('safe-collapse invariant — *Visible vs the core time-filter oracle', () => {
  // visible === 0 ⟹ alpha === 0  (equivalently alpha > 0 ⟹ visible === 1).
  //
  // A false 0 here does not dim a feature — it multiplies the primitive's
  // vertex-stage SIZE / SCALE by zero, so the feature collapses to zero extent
  // and disappears entirely. The sweep deliberately includes degenerate 0-length
  // durations and negative fades/lengths, where the alpha oracle can return NaN
  // (`NaN > 0` is false, so the implication is vacuously satisfied there — the
  // NaN itself is pinned in the divergence block below).
  for (const mode of MODES) {
    it(`holds over a dense sweep incl. degenerate/negative params (${mode})`, () => {
      const cases = casesFor(
        mode,
        [...DURATIONS, ...DEGENERATE],
        [...FADES, ...DEGENERATE],
      );
      let checked = 0;
      for (const c of cases) {
        const a = timeFilterAlpha(
          mode,
          c.currentTime,
          c.startTime,
          c.endTime,
          c.params,
          c.vertexTime,
        );
        const v = timeFilterVisible(
          mode,
          c.currentTime,
          c.startTime,
          c.endTime,
          c.params,
          c.vertexTime,
        );
        expect(v === 0 || v === 1).toBe(true); // hard 0|1, never a ramp
        if (a > 0) expect(v).toBe(1); // alpha would draw ⟹ never collapse
        if (v === 0) expect(a).toBe(0); // collapsed ⟹ alpha was already 0
        checked++;
      }
      expect(checked).toBeGreaterThan(1000);
    });
  }

  it('is TIGHT: each mode has a razor-edge where alpha === 0 yet visible === 1', () => {
    // The reverse implication must NOT hold, or the "hard visibility is a strict
    // subset of the alpha-zero region" design has silently become an equality
    // (and the collapse would then be clipping the fade band).
    expect(windowAlpha(100, 150, 150, 50, 20, 0)).toBe(0); // start === timeEnd, fadeIn
    expect(windowVisible(100, 150, 150, 50)).toBe(1);
    expect(wakeAlpha(100, 40, 60)).toBe(0); // age === wakeLength (tail)
    expect(wakeVisible(100, 40, 60)).toBe(1);
    expect(cumulativeAlpha(100, 100, 20)).toBe(0); // born exactly now, ramping
    expect(cumulativeVisible(100, 100)).toBe(1);
    expect(trailAlpha(100, 50, 50, 1)).toBe(0); // vertex at the trail tail
    expect(trailVisible(100, 50, 50)).toBe(1);
  });

  it('pins the inclusive boundaries the invariant rests on', () => {
    expect(windowVisible(100, 50, 50, 50)).toBe(1); // touches timeStart
    expect(windowVisible(100, 150, 150, 50)).toBe(1); // touches timeEnd
    expect(windowVisible(100, 0, 49.999, 50)).toBe(0);
    expect(windowVisible(100, 150.001, 200, 50)).toBe(0);
    expect(wakeVisible(100, 100, 60)).toBe(1); // age 0
    expect(wakeVisible(100, 40, 60)).toBe(1); // age === wakeLength
    expect(wakeVisible(100, 39.999, 60)).toBe(0);
    expect(wakeVisible(100, 100.001, 60)).toBe(0);
    expect(cumulativeVisible(100, 100)).toBe(1);
    expect(cumulativeVisible(100, 100.001)).toBe(0);
    expect(trailVisible(100, 100, 50)).toBe(1);
    expect(trailVisible(100, 50, 50)).toBe(1);
    expect(trailVisible(100, 49.999, 50)).toBe(0);
    expect(trailVisible(100, 100.001, 50)).toBe(0);
    // Degenerate 0-length: only the single instant survives.
    expect(wakeVisible(100, 100, 0)).toBe(1);
    expect(wakeVisible(100, 99.999, 0)).toBe(0);
    expect(trailVisible(100, 100, 0)).toBe(1);
    expect(trailVisible(100, 99.999, 0)).toBe(0);
    // Negative length can never be visible.
    for (const L of [-1, -1000]) {
      expect(wakeVisible(100, 100, L)).toBe(0);
      expect(trailVisible(100, 100, L)).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. *Visible vs the codegen AST (the second, branchless oracle).
// ─────────────────────────────────────────────────────────────────────────────

describe('*Visible vs the codegen AST visibility factor', () => {
  for (const mode of AST_MODES) {
    it(`the AST's alpha is 0 wherever visible is 0, and > 0 ⟹ visible (${mode})`, () => {
      const cases = casesFor(
        mode,
        [...DURATIONS, ...DEGENERATE],
        [...FADES, ...DEGENERATE],
      );
      for (const c of cases) {
        const v = timeFilterVisible(
          mode,
          c.currentTime,
          c.startTime,
          c.endTime,
          c.params,
          c.vertexTime,
        );
        const a = evalExpr(ALPHA_EXPR[mode], astEnv(c));
        expect(Number.isNaN(a)).toBe(false); // the AST is NaN-free by construction
        // `a === 0`, not `toBe(0)`: with a NEGATIVE fade the AST's ramp factor
        // is `clamp01(-0)`, which JS's `v < 0 ? 0 : …` passes through as a
        // signed -0, and `0 * -0` is -0. Harmless on a GPU (both compare equal
        // and both render as fully transparent) but `Object.is(-0, 0)` is false.
        if (v === 0) expect(a === 0).toBe(true);
        if (a > 0) expect(v).toBe(1);
      }
    });
  }

  it('EXACT equality once the ramp knobs are neutral (window/cumulative/trail)', () => {
    // `ALPHA_EXPR[mode]` is literally `visibilityFactor * rampFactor`. Drive the
    // ramp to a hard 1 (fades 0; trailFade 0 ⇒ solid trail) and the AST reduces
    // to the visibility term, which must equal three's `*Visible` bit-for-bit.
    // `wake` is excluded: its ramp has no "off" setting, so it keeps the
    // implication form above.
    const neutral: TimeFilterParams = {
      fadeIn: 0,
      fadeOut: 0,
      trailFade: 0,
    };
    for (const mode of ['window', 'cumulative', 'trail'] as const) {
      for (const c of casesFor(mode, [...DURATIONS, ...DEGENERATE], [0])) {
        const cc: Case = { ...c, params: { ...c.params, ...neutral } };
        expect(evalExpr(ALPHA_EXPR[mode], astEnv(cc))).toBe(
          timeFilterVisible(
            mode,
            cc.currentTime,
            cc.startTime,
            cc.endTime,
            cc.params,
            cc.vertexTime,
          ),
        );
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The SHIPPED TSL node graph, executed.
// ─────────────────────────────────────────────────────────────────────────────

describe('shipped TSL graph — the interpreter really walks it', () => {
  it('every mode builds a non-trivial graph the interpreter fully covers', () => {
    // Guards the degenerate failure mode where the graph collapsed to a constant
    // (which would make every numeric assertion below pass vacuously).
    const sizes: Record<string, [number, number]> = {};
    for (const mode of MODES) {
      const p = buildProgram(mode);
      sizes[mode] = [nodeCount(p.alpha), nodeCount(p.visible)];
    }
    for (const mode of ['window', 'wake', 'cumulative', 'trail']) {
      expect(sizes[mode][0]).toBeGreaterThan(8); // alpha graph
      expect(sizes[mode][1]).toBeGreaterThan(2); // visible graph
    }
    // `none` is a literal 1 in both stages, by design (a ConstNode, possibly
    // behind one wrapper — never a real expression).
    expect(sizes.none[0]).toBeLessThanOrEqual(2);
    expect(sizes.none[1]).toBeLessThanOrEqual(2);
  });

  it('the visibility graphs are BRANCH-FREE (step/mul only — no conditionals)', () => {
    // `time-filter.ts` documents these as "built branch-free with step() (no
    // select()), which is both cheaper and varying-safe". Numbers cannot see
    // that; this can. A `select()` creeping in here would be a silent perf +
    // varying-safety regression.
    for (const mode of ['window', 'wake', 'cumulative', 'trail'] as const) {
      const ops = graphOps(buildProgram(mode).visible);
      expect(ops.some((o) => o.startsWith('ConditionalNode'))).toBe(false);
      for (const op of ops) {
        expect([
          'VarNode',
          'ConstNode',
          'UniformNode',
          'MathNode:step',
          'OperatorNode:*',
          'OperatorNode:-',
          'OperatorNode:+',
        ]).toContain(op);
      }
      expect(ops.filter((o) => o === 'MathNode:step').length).toBeGreaterThan(
        0,
      );
    }
  });

  it('no branch of any alpha graph can produce NaN/Infinity (EPS guards hold)', () => {
    // Evaluated EAGERLY: three's codegen may lower a ConditionalNode to an
    // if/else that assigns a var rather than a lazy ternary, so BOTH sides must
    // be finite — which is precisely what the `max(x, EPS)` divisors buy. Swept
    // over degenerate and negative durations/fades, the only places a naive
    // `x / 0` would appear.
    for (const mode of MODES) {
      const p = buildProgram(mode);
      for (const c of casesFor(
        mode,
        [...DURATIONS, ...DEGENERATE],
        [...FADES, ...DEGENERATE],
      )) {
        const a = runAlpha(p, c, { eager: true });
        const v = runVisible(p, c, { eager: true });
        expect(Number.isFinite(a)).toBe(true);
        expect(Number.isNaN(a)).toBe(false);
        expect(v === 0 || v === 1).toBe(true);
      }
    }
  });
});

describe('shipped TSL graph == time-filter-math.ts (numeric, in contract)', () => {
  for (const mode of MODES) {
    it(`alpha node matches timeFilterAlpha across the dense sweep (${mode})`, () => {
      const p = buildProgram(mode);
      let checked = 0;
      for (const c of casesFor(mode, DURATIONS, FADES)) {
        const got = runAlpha(p, c);
        const want = timeFilterAlpha(
          mode,
          c.currentTime,
          c.startTime,
          c.endTime,
          c.params,
          c.vertexTime,
        );
        // Not exact-equal: the graph clamps each fade factor before multiplying
        // while core multiplies then clamps, so the two can differ in the last
        // ulp. 1e-12 is far below any perceptible alpha and far above f64 noise.
        expect(got).toBeCloseTo(want, 12);
        checked++;
      }
      expect(checked).toBeGreaterThan(500);
    });

    it(`visible node matches timeFilterVisible EXACTLY, incl. degenerates (${mode})`, () => {
      // Exact: both sides are pure comparisons, no arithmetic to round.
      const p = buildProgram(mode);
      for (const c of casesFor(
        mode,
        [...DURATIONS, ...DEGENERATE],
        [...FADES, ...DEGENERATE],
      )) {
        expect(runVisible(p, c)).toBe(
          timeFilterVisible(
            mode,
            c.currentTime,
            c.startTime,
            c.endTime,
            c.params,
            c.vertexTime,
          ),
        );
      }
    });
  }

  it('the graph obeys the safe-collapse invariant too (alpha > 0 ⟹ visible 1)', () => {
    for (const mode of MODES) {
      const p = buildProgram(mode);
      for (const c of casesFor(
        mode,
        [...DURATIONS, ...DEGENERATE],
        [...FADES, ...DEGENERATE],
      )) {
        const a = runAlpha(p, c);
        const v = runVisible(p, c);
        if (a > 0) expect(v).toBe(1);
        if (v === 0) expect(a).toBe(0);
      }
    }
  });

  it('wakeSizeScaleNode matches core wakeSizeScale over alpha × tailScale', () => {
    const u = new TimeFilterUniforms();
    const alphaU = uniform(0);
    const node = wakeSizeScaleNode(u, alphaU);
    for (const tail of [0, 0.1, DEFAULT_WAKE_TAIL_SCALE, 0.5, 1]) {
      for (const a of [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1]) {
        u.wakeTailScale.value = tail;
        alphaU.value = a;
        expect(evalTSL(node) as number).toBeCloseTo(wakeSizeScale(a, tail), 12);
      }
    }
  });

  it('`none` is a constant 1 in both stages', () => {
    const p = buildProgram('none');
    const c: Case = {
      currentTime: 12345,
      startTime: -1e9,
      endTime: 1e9,
      vertexTime: 0,
      params: { windowHalf: 0, fadeIn: 0, fadeOut: 0 },
    };
    expect(runAlpha(p, c)).toBe(1);
    expect(runVisible(p, c)).toBe(1);
    expect(evalTSL(timeFilterAlphaNode('none', p.u, float(0), float(0)))).toBe(
      1,
    );
    expect(
      evalTSL(timeFilterVisibleNode('none', p.u, float(0), float(0))),
    ).toBe(1);
  });

  it('updateTimeFilterUniforms pushes every param (and defaults the rest)', () => {
    // The graph is only as correct as the values bound to it; an omitted push
    // would leave a stale uniform and every sweep above would still pass.
    const u = new TimeFilterUniforms();
    updateTimeFilterUniforms(u, 42, {
      windowHalf: 1,
      fadeIn: 2,
      fadeOut: 3,
      wakeLength: 4,
      trailLength: 5,
      trailFade: 6,
      wakeTailScale: 7,
    });
    expect([
      u.currentTime.value,
      u.windowHalf.value,
      u.fadeIn.value,
      u.fadeOut.value,
      u.wakeLength.value,
      u.trailLength.value,
      u.trailFade.value,
      u.wakeTailScale.value,
    ]).toEqual([42, 1, 2, 3, 4, 5, 6, 7]);
    updateTimeFilterUniforms(u, 0);
    expect([
      u.currentTime.value,
      u.windowHalf.value,
      u.fadeIn.value,
      u.fadeOut.value,
      u.wakeLength.value,
      u.trailLength.value,
      u.trailFade.value,
      u.wakeTailScale.value,
    ]).toEqual([0, 0, 0, 0, 0, 0, 1, DEFAULT_WAKE_TAIL_SCALE]);
  });
});

describe('shipped TSL graph == evalExpr(ALPHA_EXPR[mode]) (in contract)', () => {
  for (const mode of AST_MODES) {
    it(`agrees with the branchless AST across the dense sweep (${mode})`, () => {
      const p = buildProgram(mode);
      for (const c of casesFor(mode, DURATIONS, FADES)) {
        expect(runAlpha(p, c)).toBeCloseTo(
          evalExpr(ALPHA_EXPR[mode], astEnv(c)),
          12,
        );
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DOCUMENTED DIVERGENCES — pinned, not papered over.
// ─────────────────────────────────────────────────────────────────────────────

describe('DOCUMENTED DIVERGENCE A: zero-length wake/trail at age exactly 0', () => {
  // A three-way split at the single instant `age === 0` when the mode length is
  // 0. Out of contract — the layers select wake/trail only when the length is
  // > 0 — but pinned so a change in ANY of the three implementations is loud.
  //
  //   TSL graph : 1   (its `max(len, EPS)` divisor makes `1 - 0/1e-6` = 1)
  //   core      : NaN (`clamp01(1 - 0/0)`)
  //   codegen   : 0   (`select(len, …, 0)` gates on len != 0)
  //
  // The safe-collapse invariant survives all three: `visible` is 1 there, and
  // `NaN > 0` is false, so nothing is wrongly collapsed.
  const wakeP = buildProgram('wake');
  const trailP = buildProgram('trail');

  it('wake: TSL 1, core NaN, AST 0 — visible stays 1', () => {
    const now = 1000;
    const c: Case = {
      currentTime: now,
      startTime: now,
      endTime: now,
      vertexTime: now,
      params: { wakeLength: 0 },
    };
    expect(runAlpha(wakeP, c)).toBe(1);
    expect(Number.isNaN(wakeAlpha(now, now, 0))).toBe(true);
    expect(
      evalExpr(ALPHA_EXPR.wake, {
        currentTime: now,
        startTime: now,
        wakeLength: 0,
      }),
    ).toBe(0);
    expect(runVisible(wakeP, c)).toBe(1);
    expect(wakeVisible(now, now, 0)).toBe(1);
  });

  it('trail: TSL 1, core NaN, AST 0 (trailFade 1) — visible stays 1', () => {
    const now = 1000;
    const c: Case = {
      currentTime: now,
      startTime: now,
      endTime: now,
      vertexTime: now,
      params: { trailLength: 0, trailFade: 1 },
    };
    expect(runAlpha(trailP, c)).toBe(1);
    expect(Number.isNaN(trailAlpha(now, now, 0, 1))).toBe(true);
    expect(
      evalExpr(ALPHA_EXPR.trail, {
        currentTime: now,
        vertexTime: now,
        trailLength: 0,
        trailFade: 1,
      }),
    ).toBe(0);
    expect(runVisible(trailP, c)).toBe(1);
    expect(trailVisible(now, now, 0)).toBe(1);
    // With a SOLID trail (trailFade 0) the AST instead returns 1 — its ramp
    // factor collapses to `clamp01(1 - 0)` — while core is still NaN.
    expect(
      evalExpr(ALPHA_EXPR.trail, {
        currentTime: now,
        vertexTime: now,
        trailLength: 0,
        trailFade: 0,
      }),
    ).toBe(1);
    expect(Number.isNaN(trailAlpha(now, now, 0, 0))).toBe(true);
  });

  it('away from age 0, a zero length hides everything in all three', () => {
    const now = 1000;
    for (const age of [-1e-3, 1e-3, 1, 1e6]) {
      const c: Case = {
        currentTime: now,
        startTime: now - age,
        endTime: now - age,
        vertexTime: now - age,
        params: { wakeLength: 0, trailLength: 0, trailFade: 1 },
      };
      expect(runAlpha(wakeP, c)).toBe(0);
      expect(wakeAlpha(now, now - age, 0)).toBe(0);
      expect(
        evalExpr(ALPHA_EXPR.wake, {
          currentTime: now,
          startTime: now - age,
          wakeLength: 0,
        }),
      ).toBe(0);
      expect(runVisible(wakeP, c)).toBe(0);
      expect(runAlpha(trailP, c)).toBe(0);
      expect(runVisible(trailP, c)).toBe(0);
    }
  });
});

describe('DOCUMENTED DIVERGENCE B: negative fadeIn/fadeOut', () => {
  // `resolveTimeFilterParams` never emits a negative fade, so this is out of
  // contract. core and the TSL graph both gate the ramp on `fade > 0` (ramp off
  // ⇒ factor 1); the codegen AST gates on `fade != 0` and therefore ramps with a
  // negative divisor ⇒ clamps to 0. three follows core — the SAME resolution
  // maplibre pins in its own test. If the AST is ever fixed to gate on `> 0`,
  // this block fails and all four backends can be unified.
  it('cumulative: TSL 1, core 1, AST 0', () => {
    const p = buildProgram('cumulative');
    const now = 1000;
    const c: Case = {
      currentTime: now,
      startTime: now - 500,
      endTime: now,
      vertexTime: now - 500,
      params: { fadeIn: -100 },
    };
    expect(runAlpha(p, c)).toBe(1);
    expect(cumulativeAlpha(now, now - 500, -100)).toBe(1);
    expect(
      evalExpr(ALPHA_EXPR.cumulative, {
        currentTime: now,
        startTime: now - 500,
        fadeIn: -100,
      }),
    ).toBe(0);
  });

  it('window: TSL 1, core 1, AST 0', () => {
    const p = buildProgram('window');
    const now = 1000;
    const c: Case = {
      currentTime: now,
      startTime: now - 10,
      endTime: now + 10,
      vertexTime: now - 10,
      params: { windowHalf: 50, fadeIn: -100, fadeOut: -100 },
    };
    expect(runAlpha(p, c)).toBe(1);
    expect(windowAlpha(now, now - 10, now + 10, 50, -100, -100)).toBe(1);
    expect(
      evalExpr(ALPHA_EXPR.window, {
        currentTime: now,
        startTime: now - 10,
        endTime: now + 10,
        windowHalf: 50,
        fadeIn: -100,
        fadeOut: -100,
      }),
    ).toBe(0);
  });
});

describe('DOCUMENTED DIVERGENCE C: sub-EPS (< 1e-6 ms) fades and lengths', () => {
  // The TSL graph divides by `max(x, 1e-6)` where core divides by `x`. Above
  // 1e-6 ms the guard is inert and the two agree exactly (the whole DURATIONS /
  // FADES sweep above lives there). Below it the graph's ramp is shallower.
  // 1e-6 ms is a nanosecond — far under any real playback cadence — so this is
  // out of contract, but it IS a genuine three-only divergence (core and the AST
  // agree with each other here and the graph does not), so it is pinned.
  it('wake: a sub-EPS wakeLength flattens the graph ramp (core/AST agree, TSL does not)', () => {
    const p = buildProgram('wake');
    // `now` MUST be 0 here: at a nanosecond scale, `1000 - 5e-8` then
    // `1000 - that` is catastrophic cancellation and the age is no longer 5e-8.
    const now = 0;
    const L = 1e-7;
    const age = 5e-8; // exactly mid-wake
    const c: Case = {
      currentTime: now,
      startTime: now - age,
      endTime: now,
      vertexTime: now - age,
      params: { wakeLength: L },
    };
    expect(wakeAlpha(now, now - age, L)).toBeCloseTo(0.5, 12);
    expect(
      evalExpr(ALPHA_EXPR.wake, {
        currentTime: now,
        startTime: now - age,
        wakeLength: L,
      }),
    ).toBeCloseTo(0.5, 12);
    expect(runAlpha(p, c)).toBeCloseTo(1 - age / 1e-6, 12); // 0.95, not 0.5
    // Visibility is unaffected — it never divides.
    expect(runVisible(p, c)).toBe(1);
    expect(wakeVisible(now, now - age, L)).toBe(1);
  });

  it('cumulative: a sub-EPS fadeIn flattens the graph ramp the same way', () => {
    const p = buildProgram('cumulative');
    const now = 0; // see the cancellation note above
    const fadeIn = 1e-7;
    const elapsed = 5e-8;
    const c: Case = {
      currentTime: now,
      startTime: now - elapsed,
      endTime: now,
      vertexTime: now - elapsed,
      params: { fadeIn },
    };
    expect(cumulativeAlpha(now, now - elapsed, fadeIn)).toBeCloseTo(0.5, 12);
    expect(runAlpha(p, c)).toBeCloseTo(elapsed / 1e-6, 12); // 0.05, not 0.5
  });

  it('at and above 1e-6 the guard is inert — graph and core agree exactly', () => {
    const p = buildProgram('wake');
    const now = 1000;
    for (const L of [1e-6, 1e-5, 1e-3, 0.5]) {
      for (const f of [0, 0.25, 0.5, 1]) {
        const c: Case = {
          currentTime: now,
          startTime: now - L * f,
          endTime: now,
          vertexTime: now - L * f,
          params: { wakeLength: L },
        };
        expect(runAlpha(p, c)).toBeCloseTo(wakeAlpha(now, now - L * f, L), 12);
      }
    }
  });
});

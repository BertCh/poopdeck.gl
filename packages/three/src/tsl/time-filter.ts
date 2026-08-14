// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * TSL node mirror of `./time-filter-math.ts`. These builders compose the same
 * per-feature alpha expression as deck.gl's `TimeFilterExtension`, but as a
 * Three Shading Language node graph that runs on the WebGPU/WebGL2 backend.
 *
 * Usage: a material binds its per-instance `startTime` / `endTime` / `vertexTime`
 * attribute nodes, picks a mode, and consumes TWO complementary nodes:
 *
 *   • {@link timeFilterAlphaNode} — the SOFT ramp — feeds `opacityNode` in the
 *     FRAGMENT stage (fade-in / fade-out / wake ramp / trail head→tail fade, plus
 *     it composes with SDF edge antialiasing).
 *   • {@link timeFilterVisibleNode} — a hard `0 | 1` — is multiplied into the
 *     primitive's per-instance / per-vertex SIZE / SCALE (or the vertex offset
 *     that builds its quad / prism) in the VERTEX stage, so a primitive whose
 *     feature is outside the HARD time window collapses to zero extent and dies at
 *     primitive assembly (zero fragment cost). This replaces the old alpha-cutoff
 *     fragment `discard` for the on/off cut — deck.gl #7509 documents that
 *     fragment-discard time filtering keeps full raster cost and defeats early-Z.
 *     `alphaTest` discard remains ONLY for SDF edge AA (the disc / atlas mask).
 *
 * The visible node is `0` ONLY on the HARD out-of-window region, which is a
 * subset of where the alpha node is `0` — so `visible === 0 ⟹ alpha === 0`: a
 * collapsed primitive is always one the alpha would have drawn at opacity 0
 * anyway, and the on-screen result is unchanged. (The reverse does not hold: at
 * a fade razor-edge alpha is exactly 0 while visible is 1 — that primitive is
 * NOT collapsed, it just rasterises at opacity 0, exactly as today.)
 *
 * The shared {@link TimeFilterUniforms} are updated once per frame from the
 * playback clock (relativised by the tile's `timeOffset`, f32-exact) via
 * {@link updateTimeFilterUniforms}.
 *
 * The CPU functions in `./time-filter-math.ts` are the unit-tested source of
 * truth for BOTH the alpha and the visibility math; keep the two in lockstep
 * (the `*Visible` mirror lives there alongside the `*Alpha` mirror).
 *
 * That lockstep is ENFORCED, not merely asked for: `three/test/
 * tsl-time-filter-conformance.test.ts` builds each graph below once, binds the
 * per-instance attributes to uniform nodes, and EXECUTES the node graph on the
 * CPU (three's nodes are plain-old-data introspectable), pinning it numerically
 * to `./time-filter-math.ts`, to core's `time-filter.ts` oracle and to core's
 * `shader-codegen.ts` `ALPHA_EXPR` AST — plus a structural lock that the
 * visibility graphs stay branch-free. What that CANNOT cover is three's
 * WGSL/GLSL code generator and f32 behaviour; those stay browser-verified.
 */

import { uniform, float, select, saturate, max, mix, step } from './nodes.js';
import type { TSLNode, UniformNode } from './nodes.js';
import type { TimeFilterMode, TimeFilterParams } from './time-filter-math.js';
import { DEFAULT_WAKE_TAIL_SCALE } from '@poopdeck.gl/core/time-filter';

// The loose TSL node aliases live in ./nodes (see that file for why); re-export
// so existing `import { TSLNode } from './time-filter.js'` consumers keep working.
export type { TSLNode, UniformNode };

/** Tiny epsilon guarding divisions by a zero ramp width. */
const EPS = 1e-6;

/**
 * The shared per-frame uniforms. One instance per material; the scene loop sets
 * `.value` each tick. All times are RELATIVE to the tile's `timeOffset`.
 */
export class TimeFilterUniforms {
  readonly currentTime: UniformNode = uniform(0);
  readonly windowHalf: UniformNode = uniform(0);
  readonly fadeIn: UniformNode = uniform(0);
  readonly fadeOut: UniformNode = uniform(0);
  readonly wakeLength: UniformNode = uniform(0);
  readonly wakeTailScale: UniformNode = uniform(DEFAULT_WAKE_TAIL_SCALE);
  readonly trailLength: UniformNode = uniform(0);
  readonly trailFade: UniformNode = uniform(1);
}

/** `window` alpha node — overlap of `[startTime,endTime]` with `[cur±windowHalf]`. */
export function windowAlphaNode(
  u: TimeFilterUniforms,
  startTime: TSLNode,
  endTime: TSLNode,
): TSLNode {
  const cur = u.currentTime;
  const timeStart = cur.sub(u.windowHalf);
  const timeEnd = cur.add(u.windowHalf);
  const inWindow = endTime
    .greaterThanEqual(timeStart)
    .and(startTime.lessThanEqual(timeEnd));
  const fadeInFactor = select(
    u.fadeIn.greaterThan(0),
    saturate(timeEnd.sub(startTime).div(max(u.fadeIn, float(EPS)))),
    float(1),
  );
  const fadeOutFactor = select(
    u.fadeOut.greaterThan(0),
    saturate(endTime.sub(timeStart).div(max(u.fadeOut, float(EPS)))),
    float(1),
  );
  return select(inWindow, fadeInFactor.mul(fadeOutFactor), float(0));
}

/** `wake` alpha node — linear fade over `[0, wakeLength]` ms behind the playhead. */
export function wakeAlphaNode(
  u: TimeFilterUniforms,
  startTime: TSLNode,
): TSLNode {
  const age = u.currentTime.sub(startTime);
  const visible = age.greaterThanEqual(0).and(age.lessThanEqual(u.wakeLength));
  const a = saturate(float(1).sub(age.div(max(u.wakeLength, float(EPS)))));
  return select(visible, a, float(0));
}

/** Wake tail size multiplier — head full size, tail toward `wakeTailScale`. */
export function wakeSizeScaleNode(
  u: TimeFilterUniforms,
  alpha: TSLNode,
): TSLNode {
  return mix(u.wakeTailScale, float(1), alpha);
}

/** `cumulative` alpha node — appears at `startTime`, persists (optional fadeIn). */
export function cumulativeAlphaNode(
  u: TimeFilterUniforms,
  startTime: TSLNode,
): TSLNode {
  const created = startTime.lessThanEqual(u.currentTime);
  const ramp = select(
    u.fadeIn.greaterThan(0),
    saturate(u.currentTime.sub(startTime).div(max(u.fadeIn, float(EPS)))),
    float(1),
  );
  return select(created, ramp, float(0));
}

/** `trail` alpha node — per-vertex trips fade over `[cur-trailLength, cur]`. */
export function trailAlphaNode(
  u: TimeFilterUniforms,
  vertexTime: TSLNode,
): TSLNode {
  const trailStart = u.currentTime.sub(u.trailLength);
  const visible = vertexTime
    .lessThanEqual(u.currentTime)
    .and(vertexTime.greaterThanEqual(trailStart));
  const age = u.currentTime.sub(vertexTime);
  const faded = saturate(float(1).sub(age.div(max(u.trailLength, float(EPS)))));
  const a = mix(float(1), faded, u.trailFade);
  return select(visible, a, float(0));
}

/**
 * Build the alpha node for the active mode. `startTime`/`endTime`/`vertexTime`
 * are per-instance attribute nodes (relative to `timeOffset`).
 */
export function timeFilterAlphaNode(
  mode: TimeFilterMode,
  u: TimeFilterUniforms,
  startTime: TSLNode,
  endTime: TSLNode,
  vertexTime: TSLNode = startTime,
): TSLNode {
  switch (mode) {
    case 'window':
      return windowAlphaNode(u, startTime, endTime);
    case 'wake':
      return wakeAlphaNode(u, startTime);
    case 'cumulative':
      return cumulativeAlphaNode(u, startTime);
    case 'trail':
      return trailAlphaNode(u, vertexTime);
    case 'none':
    default:
      return float(1);
  }
}

// ── Hard visibility nodes (vertex-stage collapse) ────────────────────────────
//
// Each returns a hard `0 | 1` float — the boolean core of a mode's in-window
// test WITHOUT the fade ramp — for multiplying into a primitive's SIZE / SCALE
// in the vertex stage. Built branch-free with `step()` (no `select()`), which is
// both cheaper and varying-safe, and stays f32-exact 0/1. CPU mirror:
// `timeFilterVisible` & friends in ./time-filter-math.ts.
//
// TSL `step(edge, x)` follows GLSL: `x >= edge ? 1 : 0`. The `>=` / `<=`
// boundaries below match the CPU mirror (and the alpha functions' zero region)
// exactly, so `visible === 0 ⟺ alpha === 0` on the boundary too.

/** `window` visible — `1` while `[start,end]` overlaps `[cur ± windowHalf]`. */
export function windowVisibleNode(
  u: TimeFilterUniforms,
  startTime: TSLNode,
  endTime: TSLNode,
): TSLNode {
  const timeStart = u.currentTime.sub(u.windowHalf);
  const timeEnd = u.currentTime.add(u.windowHalf);
  // endTime >= timeStart AND startTime <= timeEnd.
  return step(timeStart, endTime).mul(step(startTime, timeEnd));
}

/** `wake` visible — `1` while `age ∈ [0, wakeLength]` behind the playhead. */
export function wakeVisibleNode(
  u: TimeFilterUniforms,
  startTime: TSLNode,
): TSLNode {
  const age = u.currentTime.sub(startTime);
  // age >= 0 AND age <= wakeLength.
  return step(float(0), age).mul(step(age, u.wakeLength));
}

/** `cumulative` visible — `1` once `startTime <= cur` (appear-and-persist). */
export function cumulativeVisibleNode(
  u: TimeFilterUniforms,
  startTime: TSLNode,
): TSLNode {
  // startTime <= cur.
  return step(startTime, u.currentTime);
}

/** `trail` visible (per-vertex) — `1` while `vertexTime ∈ [cur-trailLength, cur]`. */
export function trailVisibleNode(
  u: TimeFilterUniforms,
  vertexTime: TSLNode,
): TSLNode {
  const trailStart = u.currentTime.sub(u.trailLength);
  // vertexTime >= trailStart AND vertexTime <= cur.
  return step(trailStart, vertexTime).mul(step(vertexTime, u.currentTime));
}

/**
 * Build the hard-visibility node for the active mode — the vertex-collapse
 * companion to {@link timeFilterAlphaNode}. Materials MULTIPLY this into their
 * per-instance / per-vertex size / scale (vertex stage); the alpha node keeps
 * feeding `opacityNode` for the soft band. `startTime`/`endTime`/`vertexTime`
 * are per-instance attribute nodes (relative to `timeOffset`).
 */
export function timeFilterVisibleNode(
  mode: TimeFilterMode,
  u: TimeFilterUniforms,
  startTime: TSLNode,
  endTime: TSLNode,
  vertexTime: TSLNode = startTime,
): TSLNode {
  switch (mode) {
    case 'window':
      return windowVisibleNode(u, startTime, endTime);
    case 'wake':
      return wakeVisibleNode(u, startTime);
    case 'cumulative':
      return cumulativeVisibleNode(u, startTime);
    case 'trail':
      return trailVisibleNode(u, vertexTime);
    case 'none':
    default:
      return float(1);
  }
}

/**
 * Push the current playhead + mode params into the uniforms. `relativeCurrentTime`
 * is the absolute playhead minus the tile's `timeOffset` (computed on the JS side,
 * f32-exact). Call once per frame per material.
 */
export function updateTimeFilterUniforms(
  u: TimeFilterUniforms,
  relativeCurrentTime: number,
  params: TimeFilterParams & { wakeTailScale?: number } = {},
): void {
  u.currentTime.value = relativeCurrentTime;
  u.windowHalf.value = params.windowHalf ?? 0;
  u.fadeIn.value = params.fadeIn ?? 0;
  u.fadeOut.value = params.fadeOut ?? 0;
  u.wakeLength.value = params.wakeLength ?? 0;
  u.wakeTailScale.value = params.wakeTailScale ?? DEFAULT_WAKE_TAIL_SCALE;
  u.trailLength.value = params.trailLength ?? 0;
  u.trailFade.value = params.trailFade ?? 1;
}

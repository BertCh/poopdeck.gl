// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * TSL node mirror of `./time-filter-math.ts`. These builders compose the same
 * per-feature alpha expression as deck.gl's `TimeFilterExtension`, but as a
 * Three Shading Language node graph that runs on the WebGPU/WebGL2 backend.
 *
 * Usage: a material binds its per-instance `startTime` / `endTime` / `vertexTime`
 * attribute nodes, picks a mode, and multiplies the returned alpha into its
 * `opacityNode`. The shared {@link TimeFilterUniforms} are updated once per frame
 * from the playback clock (relativised by the tile's `timeOffset`, f32-exact) via
 * {@link updateTimeFilterUniforms}.
 *
 * The CPU functions in `./time-filter-math.ts` are the unit-tested source of
 * truth for the math; keep the two in lockstep.
 */

import { uniform, float, select, saturate, max, mix } from './nodes.js';
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
  const inWindow = endTime.greaterThanEqual(timeStart).and(startTime.lessThanEqual(timeEnd));
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
export function wakeAlphaNode(u: TimeFilterUniforms, startTime: TSLNode): TSLNode {
  const age = u.currentTime.sub(startTime);
  const visible = age.greaterThanEqual(0).and(age.lessThanEqual(u.wakeLength));
  const a = saturate(float(1).sub(age.div(max(u.wakeLength, float(EPS)))));
  return select(visible, a, float(0));
}

/** Wake tail size multiplier — head full size, tail toward `wakeTailScale`. */
export function wakeSizeScaleNode(u: TimeFilterUniforms, alpha: TSLNode): TSLNode {
  return mix(u.wakeTailScale, float(1), alpha);
}

/** `cumulative` alpha node — appears at `startTime`, persists (optional fadeIn). */
export function cumulativeAlphaNode(u: TimeFilterUniforms, startTime: TSLNode): TSLNode {
  const created = startTime.lessThanEqual(u.currentTime);
  const ramp = select(
    u.fadeIn.greaterThan(0),
    saturate(u.currentTime.sub(startTime).div(max(u.fadeIn, float(EPS)))),
    float(1),
  );
  return select(created, ramp, float(0));
}

/** `trail` alpha node — per-vertex trips fade over `[cur-trailLength, cur]`. */
export function trailAlphaNode(u: TimeFilterUniforms, vertexTime: TSLNode): TSLNode {
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

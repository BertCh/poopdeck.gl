// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * The CPU time-filter reference moved to the framework-free kernel in
 * `@poopdeck.gl/core/time-filter` (see docs/roadmap/renderer-architecture.md).
 * This module re-exports every soft-alpha function so the TSL materials, the
 * CPU-interpolated layers, and the package barrel keep resolving unchanged while
 * the alpha math lives in exactly one place. The TSL node graph in
 * `./time-filter.ts` remains the structural mirror of these functions.
 *
 * ── HARD VISIBILITY (the vertex-collapse mirror) ─────────────────────────────
 * The `*Visible` helpers below are the CPU reference for the vertex-stage window
 * collapse the materials now use INSTEAD of an alpha-cutoff fragment `discard`
 * for the hard on/off cut (deck.gl #7509: fragment-discard time filtering keeps
 * full raster cost for out-of-window features and defeats early-Z). Each returns
 * a hard `0 | 1` — the boolean core of a mode's in-window test, WITHOUT the fade
 * ramp. Each is `0` ONLY on the HARD out-of-window region, which is a subset of
 * where the matching alpha function is `0`, giving the safe-collapse invariant:
 *
 *   visible === 0  ⟹  alpha === 0        (equivalently  alpha > 0 ⟹ visible === 1)
 *
 * So multiplying the visibility into a primitive's per-instance / per-vertex
 * SIZE / SCALE (vertex stage) collapses ONLY primitives the alpha would have
 * zeroed anyway — the on-screen result is unchanged, only the off-window path
 * becomes a zero-extent primitive (dies at assembly) instead of a full-cost
 * fragment discard. (The reverse does not hold: at a fade razor-edge alpha is
 * exactly 0 while visible is 1 — that primitive rasterises at opacity 0, as
 * today.) These live here (not in the core kernel, which is out of this module's
 * edit lane) but MUST stay in lockstep with {@link timeFilterVisibleNode} in
 * `./time-filter.ts`.
 *
 * Both halves are pinned by `three/test/tsl-time-filter-conformance.test.ts`:
 * the `*Alpha` re-exports by FUNCTION IDENTITY against core (so they cannot
 * fork), the three-local `*Visible` half by a dense sweep of the safe-collapse
 * invariant against BOTH core's `time-filter.ts` and core's `shader-codegen.ts`
 * `ALPHA_EXPR` AST, and the TSL graph by CPU execution against this file. Read
 * that file's header for what is and is not enforceable without a GPU.
 */

import type {
  TimeFilterMode,
  TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';

export {
  windowAlpha,
  wakeAlpha,
  cumulativeAlpha,
  trailAlpha,
  wakeSizeScale,
  timeFilterAlpha,
} from '@poopdeck.gl/core/time-filter';
export type {
  TimeFilterMode,
  TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';

/**
 * `window` hard visibility — `1` while `[startTime,endTime]` overlaps the
 * symmetric window `[currentTime ± windowHalf]`, else `0`. Complement of the
 * `windowAlpha === 0` region (`endTime < timeStart || startTime > timeEnd`).
 */
export function windowVisible(
  currentTime: number,
  startTime: number,
  endTime: number,
  windowHalf: number,
): number {
  const timeStart = currentTime - windowHalf;
  const timeEnd = currentTime + windowHalf;
  return endTime >= timeStart && startTime <= timeEnd ? 1 : 0;
}

/**
 * `wake` hard visibility — `1` while the feature's age lies in `[0, wakeLength]`
 * behind the playhead, else `0`. Complement of the `wakeAlpha === 0` region.
 */
export function wakeVisible(
  currentTime: number,
  startTime: number,
  wakeLength: number,
): number {
  const age = currentTime - startTime;
  return age >= 0 && age <= wakeLength ? 1 : 0;
}

/**
 * `cumulative` hard visibility — `1` once the feature has been created
 * (`startTime <= currentTime`), else `0`. Complement of `cumulativeAlpha === 0`.
 */
export function cumulativeVisible(
  currentTime: number,
  startTime: number,
): number {
  return startTime <= currentTime ? 1 : 0;
}

/**
 * `trail` hard visibility (per-vertex) — `1` while the vertex timestamp lies in
 * `[currentTime - trailLength, currentTime]`, else `0`. Complement of the
 * `trailAlpha === 0` region.
 */
export function trailVisible(
  currentTime: number,
  vertexTime: number,
  trailLength: number,
): number {
  const trailStart = currentTime - trailLength;
  return vertexTime <= currentTime && vertexTime >= trailStart ? 1 : 0;
}

/**
 * Dispatch the hard visibility for the active mode — the CPU mirror of
 * {@link timeFilterVisibleNode}. `startTime`/`endTime`/`vertexTime` relative to
 * the time offset. `none` is always visible (`1`).
 */
export function timeFilterVisible(
  mode: TimeFilterMode,
  currentTime: number,
  startTime: number,
  endTime: number,
  params: TimeFilterParams = {},
  vertexTime = startTime,
): number {
  switch (mode) {
    case 'window':
      return windowVisible(
        currentTime,
        startTime,
        endTime,
        params.windowHalf ?? 0,
      );
    case 'wake':
      return wakeVisible(currentTime, startTime, params.wakeLength ?? 0);
    case 'cumulative':
      return cumulativeVisible(currentTime, startTime);
    case 'trail':
      return trailVisible(currentTime, vertexTime, params.trailLength ?? 0);
    case 'none':
    default:
      return 1;
  }
}

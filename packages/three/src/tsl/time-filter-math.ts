// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * CPU reference implementation of the STT time-filter alpha — the exact math the
 * TSL `timeFilterAlpha` node graph mirrors (see `./time-filter.ts`). This is a
 * verbatim port of deck.gl's `TimeFilterExtension` (`packages/layers/src/
 * extensions/time-filter-extension.ts`) so the two renderers animate identically.
 *
 * Kept as plain functions (not nodes) for two reasons:
 *   1. it is the unit-tested spec — TSL graphs can't run headless, so the math
 *      is pinned here and the node version is a structural mirror;
 *   2. the CPU bounding-box layer and any CPU-interpolated path reuse it.
 *
 * ── PRECISION CONTRACT ───────────────────────────────────────────────────────
 * Every time argument is RELATIVE to the tile's `timeOffset` (absolute epoch-ms
 * minus the offset), exactly like deck. `currentTime` is relativised the same way
 * on the JS side before it reaches a uniform, so the subtractions below stay
 * f32-exact even across multi-hour spans.
 */

export type TimeFilterMode = 'window' | 'wake' | 'cumulative' | 'trail' | 'none';

export interface TimeFilterParams {
  /** Half-width of the symmetric window (ms). `window` mode. */
  windowHalf?: number;
  /** Fade-in ramp at the window's leading edge (ms). `window` / `cumulative`. */
  fadeIn?: number;
  /** Fade-out ramp at the window's trailing edge (ms). `window`. */
  fadeOut?: number;
  /** Length of the wake behind the playhead (ms). `wake` mode. */
  wakeLength?: number;
  /** Trail length behind the playhead (ms). `trail` mode. */
  trailLength?: number;
  /** 1 ⇒ trail fades head→tail; 0 ⇒ solid trail. `trail` mode. */
  trailFade?: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * `window` — a feature is visible while its `[startTime, endTime]` interval
 * overlaps the symmetric window `[currentTime ± windowHalf]`, with optional
 * fade-in / fade-out ramps at the window edges.
 */
export function windowAlpha(
  currentTime: number,
  startTime: number,
  endTime: number,
  windowHalf: number,
  fadeIn = 0,
  fadeOut = 0,
): number {
  const timeStart = currentTime - windowHalf;
  const timeEnd = currentTime + windowHalf;
  if (endTime < timeStart || startTime > timeEnd) return 0;
  let alpha = 1;
  if (fadeIn > 0) {
    const age = timeEnd - startTime;
    if (age < fadeIn) alpha *= age / fadeIn;
  }
  if (fadeOut > 0) {
    const remaining = endTime - timeStart;
    if (remaining < fadeOut) alpha *= remaining / fadeOut;
  }
  return clamp01(alpha);
}

/**
 * `wake` — visible only in `[0, wakeLength]` ms behind the playhead, fading
 * linearly to 0 at the tail. (The matching tail size-shrink — `mix(wakeTailScale,
 * 1, alpha)` — is applied in the material's size node, not here.)
 */
export function wakeAlpha(currentTime: number, startTime: number, wakeLength: number): number {
  const age = currentTime - startTime;
  if (age < 0 || age > wakeLength) return 0;
  return clamp01(1 - age / wakeLength);
}

/**
 * `cumulative` — a feature appears at its `startTime` and stays forever after
 * (draw-and-persist). `fadeIn`, if set, ramps its alpha 0→1 over that many ms.
 */
export function cumulativeAlpha(currentTime: number, startTime: number, fadeIn = 0): number {
  if (startTime > currentTime) return 0;
  if (fadeIn > 0) return clamp01((currentTime - startTime) / fadeIn);
  return 1;
}

/**
 * `trail` — per-vertex animation (trips): a vertex is visible while its
 * timestamp lies in `[currentTime - trailLength, currentTime]`; `trailFade`
 * blends between a solid trail (0) and a head→tail linear fade (1).
 */
export function trailAlpha(
  currentTime: number,
  vertexTime: number,
  trailLength: number,
  trailFade: number,
): number {
  const trailStart = currentTime - trailLength;
  if (vertexTime > currentTime || vertexTime < trailStart) return 0;
  const age = currentTime - vertexTime;
  const faded = clamp01(1 - age / trailLength);
  return clamp01(1 * (1 - trailFade) + faded * trailFade);
}

/**
 * Wake-mode tail size multiplier: tail shrinks toward `wakeTailScale`, head stays
 * full size. Mirrors deck's `DECKGL_FILTER_SIZE` wake branch.
 */
export function wakeSizeScale(alpha: number, wakeTailScale: number): number {
  return wakeTailScale * (1 - alpha) + 1 * alpha;
}

/** Dispatch to the active mode. `startTime`/`endTime`/`vertexTime` relative to offset. */
export function timeFilterAlpha(
  mode: TimeFilterMode,
  currentTime: number,
  startTime: number,
  endTime: number,
  params: TimeFilterParams = {},
  vertexTime = startTime,
): number {
  switch (mode) {
    case 'window':
      return windowAlpha(
        currentTime,
        startTime,
        endTime,
        params.windowHalf ?? 0,
        params.fadeIn ?? 0,
        params.fadeOut ?? 0,
      );
    case 'wake':
      return wakeAlpha(currentTime, startTime, params.wakeLength ?? 0);
    case 'cumulative':
      return cumulativeAlpha(currentTime, startTime, params.fadeIn ?? 0);
    case 'trail':
      return trailAlpha(
        currentTime,
        vertexTime,
        params.trailLength ?? 0,
        params.trailFade ?? 1,
      );
    case 'none':
    default:
      return 1;
  }
}

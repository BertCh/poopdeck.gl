// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * CPU reference for the GPU range filter — the general-column sibling of
 * `time-filter-math.ts`. It is the unit-tested source of truth for BOTH the
 * hard visibility (vertex-stage collapse) and the soft fade the TSL node graph
 * in `./data-filter.ts` mirrors, and it resolves the deck-shaped
 * `filterRange` / `filterSoftRange` / `filterEnabled` props into the plain
 * scalar uniforms both stages read.
 *
 * The math is a byte-faithful port of `STTDataFilterExtension` in
 * `@poopdeck.gl/layers` (`src/extensions/data-filter-extension.ts`): a feature is
 * shown when its baked `filterValue` lies inside the inclusive `[min, max]`
 * hard range; a `filterSoftRange` INSIDE that range fades features across the
 * margin instead of hard-clipping. `filterSize` is 1 (a single scalar column),
 * matching that extension's v1 scope.
 *
 * ── HARD VISIBILITY (the vertex-collapse mirror) ─────────────────────────────
 * {@link dataFilterVisible} returns a hard `0 | 1` — the boolean core of the
 * hard-range test WITHOUT the soft fade — for multiplying into a primitive's
 * per-instance / per-vertex SIZE / SCALE in the vertex stage, so an
 * out-of-range primitive collapses to zero extent and dies at assembly (no
 * fragment cost, keeps early-Z; deck.gl #7509), exactly like the time filter's
 * window collapse. It is `1` when the filter idles (disabled, or no valid
 * range) so the attribute can be bound up-front and the range animated later
 * purely by uniform.
 *
 * The load-bearing safety property (with the default `filterTransformColor`):
 *
 *   dataFilterAlpha > 0  ⟹  dataFilterVisible === 1
 *
 * so the soft fade never draws a feature the hard collapse would have removed.
 * Keep this file in lockstep with `./data-filter.ts` (both are tested here).
 */

/** An inclusive `[min, max]` filter bound (mirrors the deck `DataFilterRange`). */
export type DataFilterRange = readonly [number, number];

/** Guards divisions by a zero (or inverted) soft-ramp width. */
const EPS = 1e-6;

/** GLSL `step(edge, x)` — `x >= edge ? 1 : 0`. */
function step(edge: number, x: number): number {
  return x >= edge ? 1 : 0;
}

/** GLSL `mix(a, b, t)` — linear blend (used with a hard `0 | 1` selector). */
function mix(a: number, b: number, t: number): number {
  return a * (1 - t) + b * t;
}

/**
 * GLSL `smoothstep(e0, e1, x)` with an EPS-guarded denominator so an inverted
 * or zero-width ramp (`e1 <= e0`) never divides by zero — the guarded value is
 * always masked out by the hard-vs-soft `step()` selector below (matching
 * `./data-filter.ts`, which guards the same way for varying-safety).
 */
function smoothstep(e0: number, e1: number, x: number): number {
  let t = (x - e0) / Math.max(e1 - e0, EPS);
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return t * t * (3 - 2 * t);
}

/** Construction / draw-time props, mirroring the deck `DataFilterExtension`. */
export interface DataFilterOptions {
  /**
   * Enable/disable the filter. When disabled (or no valid range) every feature
   * renders — the filter idles. @default true
   */
  filterEnabled?: boolean;
  /** Inclusive `[min, max]` hard bounds; `null` idles the filter. @default null */
  filterRange?: DataFilterRange | null;
  /**
   * Optional `[min, max]` INSIDE {@link filterRange} across whose margin
   * features fade instead of hard-clipping. @default null
   */
  filterSoftRange?: DataFilterRange | null;
  /**
   * When a feature is faded (soft band only), also shrink its size/width.
   * Layers without a size hook (arc/line/trips/column/polygon here — like deck's
   * PathLayer) ignore it; kept for surface parity. @default true
   */
  filterTransformSize?: boolean;
  /** When a feature is faded (soft band only), also lower its opacity. @default true */
  filterTransformColor?: boolean;
}

/** The plain scalar uniforms both the CPU math and the TSL nodes read. */
export interface ResolvedDataFilter {
  filterMin: number;
  filterMax: number;
  filterSoftMin: number;
  filterSoftMax: number;
  /** 1 when the filter is active (enabled + a finite range), else 0. */
  enabled: number;
  /** 1 when a finite soft range is supplied (smoothstep fade), else 0. */
  useSoftMargin: number;
  transformSize: number;
  transformColor: number;
}

function isFiniteRange(
  r: DataFilterRange | null | undefined,
): r is DataFilterRange {
  return (
    Array.isArray(r) &&
    r.length >= 2 &&
    Number.isFinite(r[0]) &&
    Number.isFinite(r[1])
  );
}

/**
 * Resolve deck-shaped props into scalar uniforms — the single value-resolution
 * step shared by the TSL uniform push and the CPU tests (byte-faithful to the
 * deck `DataFilterExtension.draw`). The filter is active only when explicitly
 * enabled AND handed a finite `[min, max]`; a soft range collapses onto the
 * hard edges when absent so the soft branch is a no-op.
 */
export function resolveDataFilter(
  opts: DataFilterOptions = {},
): ResolvedDataFilter {
  const {
    filterEnabled = true,
    filterRange = null,
    filterSoftRange = null,
    filterTransformSize = true,
    filterTransformColor = true,
  } = opts;

  const active = filterEnabled && isFiniteRange(filterRange);
  const useSoft = active && isFiniteRange(filterSoftRange);

  const filterMin = active ? filterRange![0] : 0;
  const filterMax = active ? filterRange![1] : 0;

  return {
    filterMin,
    filterMax,
    filterSoftMin: useSoft ? filterSoftRange![0] : filterMin,
    filterSoftMax: useSoft ? filterSoftRange![1] : filterMax,
    enabled: active ? 1 : 0,
    useSoftMargin: useSoft ? 1 : 0,
    transformSize: filterTransformSize ? 1 : 0,
    transformColor: filterTransformColor ? 1 : 0,
  };
}

/**
 * Hard visibility — `1` when `value` is inside the inclusive `[min, max]` hard
 * range (or the filter idles), else `0`. Mirror of {@link dataFilterVisibleNode}.
 */
export function dataFilterVisible(
  value: number,
  p: ResolvedDataFilter,
): number {
  const hardStep = step(p.filterMin, value) * step(value, p.filterMax);
  return mix(1, hardStep, p.enabled);
}

/**
 * Soft opacity multiplier — the fade the fragment stage applies. `1` when the
 * filter idles or `filterTransformColor` is off; inside the hard range it is the
 * `filterSoftRange` smoothstep fade (or a hard `1` with no soft range); outside
 * the hard range it is `0` (though the primitive is already collapsed there).
 * Mirror of {@link dataFilterAlphaNode}.
 */
export function dataFilterAlpha(value: number, p: ResolvedDataFilter): number {
  const leftInRange = mix(
    smoothstep(p.filterMin, p.filterSoftMin, value),
    step(p.filterMin, value),
    step(p.filterSoftMin, p.filterMin),
  );
  const rightInRange = mix(
    1 - smoothstep(p.filterSoftMax, p.filterMax, value),
    step(value, p.filterMax),
    step(p.filterMax, p.filterSoftMax),
  );
  const softFade = leftInRange * rightInRange;
  return mix(1, softFade, p.enabled * p.transformColor);
}

/**
 * Single source of truth for STT's column range-filter GLSL — the maplibre
 * analogue of `@poopdeck.gl/layers`'s `DataFilterExtension`.
 *
 * A feature is shown when its value in ONE baked numeric column falls inside
 * `filterRange`, hidden otherwise, with an optional `filterSoftRange` that
 * fades across the margin instead of hard-clipping. Semantics are deck's,
 * verbatim — same prop names, same per-edge truncation rule, same inclusive
 * bounds — so a tile filtered by the deck backend and by this one lights up
 * the same features at the same slider positions
 * (`packages/layers/src/extensions/data-filter-extension.ts`).
 *
 * Like `time-window.glsl.ts` this file ships GLSL **and** a JS reference impl
 * of the identical formula, kept side by side so the two cannot drift; the
 * parity test compares the JS ref against a standalone re-implementation of
 * deck's `step`/`smoothstep`/`mix` expression.
 *
 * The snippet expects the *caller* to declare (splice
 * {@link DATA_FILTER_ATTRIBUTE_GLSL} + {@link DATA_FILTER_UNIFORMS_GLSL} into
 * its own shader source):
 *   - `attribute float aFilterValue` — per-instance filter value, expanded
 *     from the per-FEATURE column by {@link expandFilterValues} for layers
 *     whose instances are segments/vertices rather than features.
 *   - `uniform vec2 uFilterRange` / `uniform vec2 uFilterSoftRange` /
 *     `uniform float uFilterEnabled` (+ the two transform flags).
 *
 * Composition: the returned factor is an independent 0..1 multiplier, so it
 * commutes with the time-window / trail alpha and with per-feature colour —
 * `vAlpha *= sttDataFilterAlpha(...)` is all a layer needs — the existing
 * `if (vAlpha <= 0.0) discard;` in every fragment shader then covers deck's
 * `discard`. Layers should also collapse a fully-filtered vertex
 * (`if (vAlpha <= 0.0) gl_Position = vec4(0.0);` after projection), matching
 * upstream's `vs:#main-end` injection: the value is per-FEATURE, so a feature
 * collapses whole and no segment is left pinned at the origin. Layers that can
 * shrink geometry additionally honour `uFilterTransformSize` (deck's
 * `filterTransformSize`); layers without a size hook ignore that uniform,
 * exactly as PathLayer does upstream.
 *
 * Deliberate deck-faithful behaviours, all covered by tests:
 *   - **Inclusive** bounds on both edges (`step(min, v) * step(v, max)`).
 *   - A soft edge at or beyond its hard edge carries no margin and truncates
 *     to a hard step (upstream dodges `smoothstep`'s undefined `edge0 ==
 *     edge1` with `mix(..., step(soft, hard))`; we branch, which is uniform-
 *     driven and therefore fully coherent, and cannot produce the NaN that
 *     `mix` with a degenerate `smoothstep` operand can).
 *   - An INVERTED range (`min > max`) hides everything — no auto-swap.
 *   - A missing column is NOT a filter: the layer resolves `enabled` to 0 and
 *     the tile renders unfiltered ({@link resolveDataFilterUniforms}).
 */

import type { BinaryFeatures } from '@poopdeck.gl/core';

/** An inclusive `[min, max]` filter bound (deck's `DataFilterRange`). */
export type DataFilterRange = readonly [number, number];

/**
 * Layer-facing props, mirroring deck's `DataFilterExtension` surface for
 * `filterSize: 1`. `filterProperty` is the accessor-alias adaptation: STT
 * tiles are binary columns, so callers name a baked column instead of passing
 * a per-row `getFilterValue` function.
 */
export interface STTDataFilterOptions {
  /**
   * Name of the baked NUMERIC column to range-filter by. Unset ⇒ the layer
   * binds no attribute and compiles no filter branch.
   */
  filterProperty?: string;
  /**
   * Inclusive `[min, max]` bounds. `null`/absent means "no range yet" — the
   * filter idles and everything renders, so the attribute can be bound
   * up-front and the range animated later (a slider) purely by uniform.
   */
  filterRange?: DataFilterRange | null;
  /**
   * Optional fade margin. Values between `filterRange` and `filterSoftRange`
   * render partially faded instead of clipped. Must sit INSIDE `filterRange`
   * to have any effect; a soft edge outside the hard edge is ignored per-edge.
   */
  filterSoftRange?: DataFilterRange | null;
  /** Master switch. Default true. */
  filterEnabled?: boolean;
  /** Shrink faded features toward zero size/width. Default true. */
  filterTransformSize?: boolean;
  /** Lower the opacity of faded features. Default true. */
  filterTransformColor?: boolean;
}

/**
 * Attribute / uniform names the GLSL below declares. Layers resolve locations
 * through these constants so five call sites cannot drift on a string.
 */
export const DATA_FILTER_NAMES = Object.freeze({
  attribute: 'aFilterValue',
  range: 'uFilterRange',
  softRange: 'uFilterSoftRange',
  enabled: 'uFilterEnabled',
  transformSize: 'uFilterTransformSize',
  transformColor: 'uFilterTransformColor',
} as const);

/** Attribute declaration to splice into a layer's vertex source. */
export const DATA_FILTER_ATTRIBUTE_GLSL = `
  attribute float aFilterValue;  // per-instance value from the baked filter column
`;

/**
 * Uniform declarations to splice into a layer's vertex source. All five are
 * declared together: a layer that ignores the transform flags simply never
 * reads them, the compiler strips them, and `getUniformLocation` returns null
 * (a no-op for the `uniform1f` call) — the same tolerance the existing
 * `uUseFeature*` uniforms rely on.
 */
export const DATA_FILTER_UNIFORMS_GLSL = `
  uniform vec2 uFilterRange;            // [min, max], inclusive
  uniform vec2 uFilterSoftRange;        // == uFilterRange ⇒ hard step, no margin
  uniform float uFilterEnabled;         // 0 = idle (everything renders)
  uniform float uFilterTransformSize;   // 1 = shrink faded geometry
  uniform float uFilterTransformColor;  // 1 = fade faded geometry
`;

/**
 * Canonical call expression, so every layer passes the uniforms in the same
 * order and the `> 0.5` float→bool convention stays in one place.
 */
export const DATA_FILTER_CALL_GLSL =
  'sttDataFilterAlpha(aFilterValue, uFilterRange, uFilterSoftRange, uFilterEnabled > 0.5)';

/**
 * The kernel. Returns 1.0 inside the hard range, 0.0 outside it, and a smooth
 * ramp across whichever soft margins are present. Disabled ⇒ 1.0 (never 0.0:
 * an idle filter must not blank a tile).
 */
export const DATA_FILTER_GLSL = `
float sttDataFilterAlpha(
  float filterValue,
  vec2 range,       // [min, max], inclusive hard bounds
  vec2 softRange,   // [softMin, softMax]; an edge at/beyond its hard edge ⇒ hard step
  bool enabled
) {
  if (!enabled) return 1.0;
  // A baked "no value" entry (NaN, see extractVertexFloats in core) can never
  // be inside a range. Decide it here rather than leave it to comparison
  // behaviour GLSL ES 1.00 does not require to be defined.
  if (filterValue != filterValue) return 0.0;
  float lo = range.x;
  float hi = range.y;
  // Left edge: no margin (softMin at or below min) ⇒ inclusive hard step.
  float left = (softRange.x <= lo)
    ? (filterValue >= lo ? 1.0 : 0.0)
    : smoothstep(lo, softRange.x, filterValue);
  // Right edge: no margin (softMax at or above max) ⇒ inclusive hard step.
  float right = (softRange.y >= hi)
    ? (filterValue <= hi ? 1.0 : 0.0)
    : 1.0 - smoothstep(softRange.y, hi, filterValue);
  return left * right;
}
`;

/**
 * Locations of the uniforms {@link DATA_FILTER_UNIFORMS_GLSL} declares, minus
 * the size transform. Lives here rather than in `base-layer.ts` so a rename of
 * a GLSL symbol, its {@link DATA_FILTER_NAMES} entry and the field that holds
 * its location is one edit in one file.
 *
 * A layer extends this and adds its own locations:
 *   `interface XxxHandles extends DataFilterUniformLocations { program: …; … }`
 *
 * Every member is null when the layer compiled no filter branch, which the
 * `gl.uniform*` calls ignore — a layer resolves one handles shape whether or
 * not `filterProperty` was set.
 */
export interface DataFilterUniformLocations {
  uFilterRange: WebGLUniformLocation | null;
  uFilterSoftRange: WebGLUniformLocation | null;
  uFilterEnabled: WebGLUniformLocation | null;
  uFilterTransformColor: WebGLUniformLocation | null;
}

/**
 * `uFilterTransformSize`'s location, kept out of
 * {@link DataFilterUniformLocations} so a layer with no size hook does not
 * carry a field it never sets. The GLSL declares the uniform either way (the
 * block is all five); a layer that cannot shrink geometry simply never reads
 * it, matching upstream PathLayer / SolidPolygonLayer.
 */
export interface FilterTransformSizeUniformLocation {
  uFilterTransformSize: WebGLUniformLocation | null;
}

/**
 * Resolve every {@link DataFilterUniformLocations} member against a linked
 * program. An absent (or compiled-out) uniform resolves to null.
 */
export function resolveDataFilterUniformLocations(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  program: WebGLProgram,
): DataFilterUniformLocations {
  return {
    uFilterRange: gl.getUniformLocation(program, DATA_FILTER_NAMES.range),
    uFilterSoftRange: gl.getUniformLocation(
      program,
      DATA_FILTER_NAMES.softRange,
    ),
    uFilterEnabled: gl.getUniformLocation(program, DATA_FILTER_NAMES.enabled),
    uFilterTransformColor: gl.getUniformLocation(
      program,
      DATA_FILTER_NAMES.transformColor,
    ),
  };
}

/** Resolve the size transform's location; for layers that can shrink geometry. */
export function resolveFilterTransformSizeUniformLocation(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  program: WebGLProgram,
): FilterTransformSizeUniformLocation {
  return {
    uFilterTransformSize: gl.getUniformLocation(
      program,
      DATA_FILTER_NAMES.transformSize,
    ),
  };
}

/** GLSL `smoothstep` semantics, for the JS reference impl. */
function smoothstepJS(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * JS-side reference implementation of {@link DATA_FILTER_GLSL}, kept in the
 * same file so the two stay in lock-step. Used by the parity tests and by any
 * CPU-side preview of what the GPU will hide.
 *
 * `range` / `softRange` are `ArrayLike` so the `Float32Array` pairs in
 * {@link DataFilterUniforms} can be handed straight in.
 */
export function dataFilterAlphaJS(
  filterValue: number,
  range: ArrayLike<number>,
  softRange: ArrayLike<number>,
  enabled: boolean,
): number {
  if (!enabled) return 1;
  if (Number.isNaN(filterValue)) return 0;
  const lo = range[0];
  const hi = range[1];
  const left =
    softRange[0] <= lo
      ? filterValue >= lo
        ? 1
        : 0
      : smoothstepJS(lo, softRange[0], filterValue);
  const right =
    softRange[1] >= hi
      ? filterValue <= hi
        ? 1
        : 0
      : 1 - smoothstepJS(softRange[1], hi, filterValue);
  return left * right;
}

/**
 * Uniform payload for one draw. Mutable and caller-owned: layers allocate one
 * with {@link createDataFilterUniforms} at construction and re-resolve it in
 * place every draw, so the hot path allocates nothing.
 */
export interface DataFilterUniforms {
  /** `uFilterRange` — feed to `gl.uniform2fv`. */
  readonly range: Float32Array;
  /** `uFilterSoftRange` — feed to `gl.uniform2fv`. */
  readonly softRange: Float32Array;
  /** `uFilterEnabled` — 1 when a valid range AND the tile has the column. */
  enabled: number;
  /** `uFilterTransformSize` — 0/1. */
  transformSize: number;
  /** `uFilterTransformColor` — 0/1. */
  transformColor: number;
}

/** Allocate a payload once per layer; {@link resolveDataFilterUniforms} fills it. */
export function createDataFilterUniforms(): DataFilterUniforms {
  return {
    range: new Float32Array(2),
    softRange: new Float32Array(2),
    enabled: 0,
    transformSize: 1,
    transformColor: 1,
  };
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
 * Resolve the per-draw uniform values from layer options + whether THIS tile
 * baked the column, mirroring `DataFilterExtension.draw()`.
 *
 * The filter is active only when explicitly enabled AND handed a finite
 * `[min, max]` AND the tile supplies the column — so a tile missing the
 * column renders unfiltered rather than blank. With no soft range the soft
 * edges collapse onto the hard edges, which the kernel reads as "no margin"
 * (hard step on both sides).
 *
 * Mutates and returns `out`.
 */
export function resolveDataFilterUniforms(
  out: DataFilterUniforms,
  opts: STTDataFilterOptions,
  hasColumn: boolean,
): DataFilterUniforms {
  const active =
    hasColumn &&
    opts.filterEnabled !== false &&
    isFiniteRange(opts.filterRange);
  const lo = active ? (opts.filterRange as DataFilterRange)[0] : 0;
  const hi = active ? (opts.filterRange as DataFilterRange)[1] : 0;
  const useSoft = active && isFiniteRange(opts.filterSoftRange);
  out.range[0] = lo;
  out.range[1] = hi;
  out.softRange[0] = useSoft
    ? (opts.filterSoftRange as DataFilterRange)[0]
    : lo;
  out.softRange[1] = useSoft
    ? (opts.filterSoftRange as DataFilterRange)[1]
    : hi;
  out.enabled = active ? 1 : 0;
  out.transformSize = opts.filterTransformSize === false ? 0 : 1;
  out.transformColor = opts.filterTransformColor === false ? 0 : 1;
  return out;
}

/** Result of {@link extractFilterColumn}. */
export interface FilterColumn {
  /**
   * Zero-copy view of the baked per-FEATURE column, or null when the tile has
   * no range-filterable column of that name.
   */
  values: Float32Array | null;
  /** True when a numeric column was found — the `enabled` gate for this tile. */
  hasColumn: boolean;
  /**
   * True when the name resolved to a CATEGORICAL column. Not range-filterable
   * in v1; the caller warns once (deck's `filterPropertyCategorical`) and
   * renders the tile unfiltered.
   */
  categorical: boolean;
}

const NO_FILTER_COLUMN: FilterColumn = Object.freeze({
  values: null,
  hasColumn: false,
  categorical: false,
});

const CATEGORICAL_FILTER_COLUMN: FilterColumn = Object.freeze({
  values: null,
  hasColumn: false,
  categorical: true,
});

/**
 * Pull the named filter column out of a tile's binary features, following the
 * same convention as the layers' `radiusProperty` / `widthProperty` reads
 * (`STTBaseLayer.getNumericProperty`): a zero-copy `Float32Array` view when
 * present, null when absent.
 *
 * Absence — no `filterProperty`, no such column, or a column that is
 * categorical rather than numeric — degrades to `hasColumn: false`, which
 * {@link resolveDataFilterUniforms} turns into `enabled: 0` and therefore an
 * UNFILTERED tile. Never all-hidden: a tile that simply lacks the column must
 * not vanish under a slider it knows nothing about.
 */
export function extractFilterColumn(
  features: Pick<BinaryFeatures, 'numericProps' | 'categoricalProps'>,
  filterProperty?: string | null,
): FilterColumn {
  if (!filterProperty) return NO_FILTER_COLUMN;
  const values = features.numericProps[filterProperty];
  if (values) return { values, hasColumn: true, categorical: false };
  if (features.categoricalProps[filterProperty]) {
    return CATEGORICAL_FILTER_COLUMN;
  }
  return NO_FILTER_COLUMN;
}

/**
 * Expand a per-FEATURE column to the per-INSTANCE layout used by layers whose
 * draw unit is a segment (line/trips) or a vertex (polygon), repeating each
 * feature's value across the instances it contributed. Point layers draw one
 * instance per feature and bind {@link FilterColumn.values} directly.
 *
 * `counts[fi]` is the instance count feature `fi` contributed; `total` is
 * their sum (the layer already knows it — it sized the position buffers with
 * it). Tile-upload time only, never per frame.
 */
export function expandFilterValues(
  perFeature: Float32Array,
  counts: ArrayLike<number>,
  total: number,
): Float32Array {
  const out = new Float32Array(total);
  let w = 0;
  const featureCount = Math.min(perFeature.length, counts.length);
  for (let fi = 0; fi < featureCount; fi++) {
    const v = perFeature[fi];
    const n = counts[fi];
    for (let i = 0; i < n && w < total; i++) out[w++] = v;
  }
  return out;
}

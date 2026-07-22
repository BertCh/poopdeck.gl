// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * AnimatedPathLayer - GPU-efficient path/trajectory rendering with time filtering.
 *
 * WINDOW MODE (default): each feature is shown (with optional fade) when its
 * `[startTime, endTime]` overlaps the current time window. Whole paths render
 * at once. For a "vehicle moving along the route" effect with a trailing fade,
 * use AnimatedTripsLayer instead.
 *
 * PROGRESSIVE-REVEAL / TRAIL MODE (opt-in via `revealTrail`): a path is drawn
 * progressively up to the play head — each vertex appears as time reaches its
 * per-vertex timestamp — so a timeless line inks itself in along its length
 * over the feature's time span. Uses the same TimeFilterExtension trail branch
 * as the trips layer, fed by the tile's `vertexTimestamps` when present or
 * monotone times synthesized from the feature span otherwise. `reducedMotion`
 * suppresses it back to the whole-path window render.
 *
 * ARCHITECTURE (v3 - Per-tile binary sublayers):
 * - One PathLayer per (tile, layer) pair. No cross-tile consolidation.
 * - Each sublayer uses deck.gl's binary `data: { length, startIndices,
 *   attributes }` interface, with attribute typed arrays referenced
 *   directly from the tile's BinaryFeatures (zero-copy from the Arrow buffer).
 * - Per-tile `timeOffset` — each sublayer rebases time independently in its
 *   own TimeFilterExtension instance.
 * - `getTime` callback drives the window uniform per draw without layer
 *   recreation.
 *
 * Streaming is additive: a new tile creates one sublayer and one GPU upload.
 * Existing tiles' GPU buffers are untouched.
 */

import { PathLayer } from '@deck.gl/layers';
import type { Color, DefaultProps, Layer, LayerContext } from '@deck.gl/core';
import {
  SpatioTemporalLayer,
  SpatioTemporalLayerProps,
} from '../spatiotemporal-layer.js';
import { NoPickingPathLayer } from '../internal/no-picking-path-layer.js';
import { TimeFilterExtension } from '../../extensions/time-filter-extension.js';
import { DataFilterExtension } from '../../extensions/data-filter-extension.js';
import type { DataFilterRange } from '../../extensions/data-filter-extension.js';
import {
  CategoryColorExtension,
  CATEGORY_PALETTE_SIZE,
} from '../../extensions/category-color-extension.js';
// Progressive-reveal / trail mode reuses the trips layer's per-vertex time
// synthesis (interpolate a feature's [startTime,endTime] span along its path by
// cumulative distance) so a timeless line inks itself in over the play window.
import { synthesizeVertexTimes } from '../trips/animated-trips-layer.js';
import { emit } from '../../lib/telemetry.js';
import { warnOnce } from '../../lib/log.js';
import {
  colorListDigest,
  colorMappingDigest,
  inheritedPropsDigest,
  structuralDigest,
  updateTriggersDigest,
} from '../../lib/style-digest.js';
import { resolveAccessorAlias } from '../../lib/accessor-alias.js';
import type {
  ColorAccessorValue,
  NumericAccessorValue,
  WeightAccessorValue,
} from '../../lib/accessor-alias.js';
import { DEFAULT_LINE_PALETTE } from '@poopdeck.gl/core';
import type {
  Tile,
  Layer as TileLayer,
  BinaryFeatures,
} from '@poopdeck.gl/core';

const DEBUG = false;

/** Props added by {@link AnimatedPathLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link AnimatedPathLayerProps}). */
export interface _AnimatedPathLayerProps {
  /**
   * Width multiplier.
   * @default 1
   */
  widthScale?: number;
  /**
   * Units for path width.
   * @default 'pixels'
   */
  widthUnits?: 'pixels' | 'meters';
  /** Clamp path width to at least this many on-screen pixels. */
  widthMinPixels?: number;
  /** Clamp path width to at most this many on-screen pixels. */
  widthMaxPixels?: number;
  /**
   * Path color — constant {@link Color}, or property name for categorical coloring.
   * @default [0, 150, 255, 255]
   */
  pathColor?: Color | string;
  /**
   * Upstream-vocabulary (PathLayer) alias of {@link pathColor}. NOTE: unlike
   * upstream deck.gl, this accepts a constant Color OR a property-column
   * NAME — NOT a function accessor (binary tiles can't run per-feature JS;
   * a function warns once and falls back to `pathColor`). When set, it wins
   * over `pathColor`.
   */
  getColor?: ColorAccessorValue | null;
  /**
   * Path width — constant number, or property name for per-feature width.
   * @default 3
   */
  pathWidth?: number | string;
  /**
   * Upstream-vocabulary alias of {@link pathWidth}. Accepts a constant
   * number OR a property-column NAME — NOT a function accessor (a function
   * warns once and falls back to `pathWidth`). When set, it wins over
   * `pathWidth`.
   */
  getWidth?: NumericAccessorValue | null;
  /**
   * Color palette for categorical `pathColor`.
   */
  colorPalette?: Color[];
  /**
   * Explicit category-string → color map for categorical `pathColor`.
   * Resolved per-tile against each tile's own category dictionary, so colors
   * stay consistent across tiles (unlike `colorPalette`, whose indices are
   * assigned per-tile in first-seen order). Takes precedence over
   * `colorPalette` when set. Mirrors `AnimatedPointLayer.colorMapping` and
   * `AnimatedTripsLayer.colorMapping`.
   *
   * Unlike the point layer, this stays on the GPU `CategoryColorExtension`
   * path: the mapping is projected onto the tile's category dictionary to
   * build a per-tile palette aligned with `instanceCategoryIndex`, so the same
   * map layer (e.g. HD-map `lane_divider`) renders the same color in every
   * tile without a per-tile CPU RGBA expansion.
   */
  colorMapping?: Record<string, Color> | null;
  /** Fallback color for categories absent from `colorMapping`. */
  colorMappingDefault?: Color;
  /**
   * Fade-in duration for appearing paths (ms).
   * @default 300
   */
  fadeInDuration?: number;
  /**
   * Fade-out duration for disappearing paths (ms).
   * @default 300
   */
  fadeOutDuration?: number;
  /**
   * Rounded line caps. Rounded caps are the dominant fragment-shader cost
   * at small widths and are visually indistinguishable from flat below ~10 px.
   * @default false
   */
  capRounded?: boolean;
  /**
   * Rounded line joints; same fragment-cost tradeoff as `capRounded`.
   * @default false
   */
  jointRounded?: boolean;
  /**
   * Miter-joint length cap (multiples of line width) — PathLayer pass-through,
   * applies when `jointRounded` is false.
   * @default 4
   */
  miterLimit?: number;
  /**
   * Extrude lines in screen space (always face the camera) — PathLayer
   * pass-through.
   * @default false
   */
  billboard?: boolean;
  /**
   * Lift every vertex of a path to a per-FEATURE elevation (metres of altitude),
   * sourced from this property column. Turns flat ground-plane lines into a 3D
   * relief — e.g. density iso-contours stacked by their density band (the
   * classic 3D contour plot). The whole path rides at one height (its feature's
   * value), so nested contour rings terrace into a hill.
   *
   * Resolution mirrors `pathColor`: a CATEGORICAL column resolves through
   * {@link elevationMapping} (category string → metres); a NUMERIC column uses
   * the value directly. Either way the result is scaled by {@link
   * elevationScale}. When the column is absent from a tile (or categorical with
   * no mapping) that tile stays 2D / flat, byte-identical to the unset render.
   * Unset ⇒ flat (the tile's `positions` ride to the GPU zero-copy).
   */
  elevationProperty?: string | null;
  /**
   * Category-string → elevation (metres) map for a CATEGORICAL {@link
   * elevationProperty} — the height analogue of `colorMapping`. Categories
   * absent from the map elevate to 0. No effect for a numeric column.
   */
  elevationMapping?: Record<string, number> | null;
  /**
   * Multiplier applied to each {@link elevationProperty} value (after the
   * categorical map) before it becomes the path's z. No effect when
   * `elevationProperty` is unset.
   * @default 1
   */
  elevationScale?: number;
  /**
   * Height-graded opacity for a stacked relief: fade each path's color alpha by
   * its real altitude, so the upper layers go translucent and a stacked iso
   * surface reads coherently from a TOP-DOWN view (you see down through the roof
   * to the ground instead of the top slab occluding everything below). The
   * multiplier ramps LINEARLY from {@link elevationOpacityNear} at the low end of
   * {@link elevationOpacityRange} to {@link elevationOpacityFar} at the high end
   * (clamped outside), keyed on the RAW {@link elevationProperty} value in metres
   * (pre-{@link elevationScale}), so the fade is consistent across tiles
   * regardless of each tile's own z spread. Only applies on the categorical-color
   * (per-vertex `getColor`) path and when the elevation column is NUMERIC; unset
   * ⇒ no grading (alpha is the band color's own). Requires {@link
   * elevationProperty}.
   */
  elevationOpacityRange?: [number, number] | null;
  /**
   * Alpha multiplier (0–1) at the LOW end of {@link elevationOpacityRange} — the
   * ground. @default 1
   */
  elevationOpacityNear?: number;
  /**
   * Alpha multiplier (0–1) at the HIGH end of {@link elevationOpacityRange} — the
   * top of the stack. `< 1` fades the upper layers translucent. @default 1
   */
  elevationOpacityFar?: number;

  /**
   * GPU range filter — the NAME of a baked numeric column to filter paths by
   * (installs {@link DataFilterExtension}). A path renders when its value in
   * this column is inside {@link filterRange}, else it is hidden (or soft-faded
   * via {@link filterSoftRange}). Composes WITH the time filter (a path must
   * pass both). The per-feature value is expanded per-vertex like the path's
   * time attributes, so multi-vertex paths filter as a whole.
   *
   * Accessor-alias of deck.gl's `getFilterValue`: pass a column NAME, not a
   * function (STT tiles are binary — a function warns once and is ignored).
   * Unset (default) ⇒ the extension is not installed: zero cost.
   *
   * ATTRIBUTE-BUDGET: PathLayer's fp64 position split leaves the per-pipeline
   * vertex-attribute count tight. On the default non-pickable path
   * (`NoPickingPathLayer`, which reclaims the picking slot) the count sits at 15
   * with `TimeFilterExtension`, and adding the CategoryColorExtension attribute
   * OR this filter attribute lands it at WebGL2's guaranteed 16-slot floor —
   * installing BOTH would make 17, a fatal link failure (blank paths) on GPUs
   * that report exactly 16. Because the path family never uses the GPU category
   * path (categorical color is expanded on the CPU into `getColor`), the layer
   * DROPS the idle `CategoryColorExtension` whenever a filter is installed and
   * spends that slot on `filterValue` instead — so the default path stays at 16
   * and links fine everywhere. CAVEAT: with `pickable: true` the sublayer is the
   * stock `PathLayer` (keeps `instancePickingColors`), so filter + picking is 17
   * and overflows on exactly-16 GPUs (see the separate `pickable` warning);
   * prefer `pickable: false` (the default) when filtering, or `AnimatedPointLayer`
   * where the budget is roomy.
   * @default null
   */
  filterProperty?: WeightAccessorValue | null;

  /**
   * Inclusive `[min, max]` bounds for {@link filterProperty}. `null` (default)
   * idles the filter (renders all) while keeping the column bound, so a range
   * set later animates by uniform with no re-preparation. No effect unless
   * `filterProperty` is set.
   * @default null
   */
  filterRange?: DataFilterRange | null;

  /**
   * Optional soft `[min, max]` inside {@link filterRange} for a fade instead of
   * a hard clip. No effect unless `filterProperty` + `filterRange` are set.
   * @default null
   */
  filterSoftRange?: DataFilterRange | null;

  /**
   * Enable/disable the column filter without dropping the bound attribute.
   * Effective only with `filterProperty` + a valid `filterRange`.
   * @default true
   */
  filterEnabled?: boolean;

  /**
   * Progressive-reveal / TRAIL mode. When `true` (and {@link reducedMotion} is
   * not set), a path is drawn PROGRESSIVELY up to the play head instead of
   * appearing whole: each vertex becomes visible as the play head reaches its
   * per-vertex time, so a TIMELESS line (one with a feature `[startTime,
   * endTime]` span but no baked per-vertex times) inks itself in ALONG its
   * length over that span. Reuses {@link TimeFilterExtension}'s trail branch,
   * fed by the tile's own `vertexTimestamps` when present, otherwise by
   * monotone times synthesized from each feature's time span (mirrors the trips
   * layer). Off (default) keeps the whole-path window mode, byte-identical to
   * the pre-reveal layer.
   * @default false
   */
  revealTrail?: boolean;
  /**
   * Trailing-window length in ms for {@link revealTrail}. `0` (default) PERSISTS
   * the whole revealed portion (draw-and-keep: the line stays once drawn); a
   * positive value renders a finite comet trail that erases behind the head
   * after this many ms. No effect unless `revealTrail` is on.
   * @default 0
   */
  revealDuration?: number;
  /**
   * In {@link revealTrail} mode, fade the trail head→tail (`true`, the classic
   * comet) or draw it at constant opacity (`false`, a solid snake). No effect
   * outside reveal mode.
   * @default true
   */
  fadeTrail?: boolean;
  /**
   * Accessibility: when `true`, suppress the {@link revealTrail} animation and
   * render the WHOLE path (window mode, no progressive draw). Wire the host's
   * `prefers-reduced-motion` here. No effect when `revealTrail` is off.
   * @default false
   */
  reducedMotion?: boolean;
}

/** Complete props accepted by {@link AnimatedPathLayer}. */
export type AnimatedPathLayerProps = _AnimatedPathLayerProps &
  SpatioTemporalLayerProps;

// Shared with the maplibre adapter (single source of truth in
// @poopdeck.gl/core).
const DEFAULT_PALETTE: Color[] = DEFAULT_LINE_PALETTE;

// Effectively-infinite trail length (ms) used for "reveal and PERSIST": a
// `revealDuration` of 0 keeps every vertex visible once the play head passes it
// (the trail never erases behind the head). Implemented as a trailLength larger
// than any feature's own internal time span, so `trailStart = currentTime -
// trailLength` stays below every vertex time and nothing fades out. The bound is
// per-FEATURE data-time (age = currentTime − vertexTime), NOT wall-clock playback
// span: a single path feature whose OWN vertices straddle more than this many ms
// would start shedding its oldest vertices once the head is this far past them.
// 250 years clears every shipped dataset (the widest single-feature span is the
// drifters' ~43-year tracks) with headroom. (Such multi-decade single features
// are already outside TimeFilterExtension's float32 ±2^24-ms exactness envelope —
// see its module docstring — so reveal-persist's practical target is the short
// timeless-line datasets, e.g. flight/taxi paths, where the bound is never
// approached.) See the `revealDuration` prop.
const REVEAL_PERSIST_TRAIL_MS = 250 * 365 * 24 * 60 * 60 * 1000;

/** See AnimatedTripsLayer for the rationale; same cache shape, window-mode attrs. */
interface PreparedTile {
  tileKey: string;
  styleKey: string;
  data: {
    length: number;
    startIndices: Uint32Array;
    attributes: Record<
      string,
      { value: any; size: number; normalized?: boolean }
    >;
  };
  timeOffset: number;
  dims: number;
  /** Resolved palette when GPU categorical-color path is active for this tile. */
  gpuPalette: Color[] | null;
  /** Source tile + decoded columns — picking enrichment context (references, not copies). */
  tile: Tile;
  features: BinaryFeatures;
}

function makeTileKey(tile: Tile, layer: TileLayer): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}:${layer.name}`;
}

/**
 * Expand a PER-FEATURE scalar (e.g. a feature's start/end time) to one value
 * PER-VERTEX, using the path `startIndices`. PathLayer renders SEGMENTS as
 * instances and maps a per-vertex attribute onto them via its tessellator, so a
 * per-vertex buffer is the correct granularity — a per-feature one (length =
 * featureCount) UNDER-SIZES the instanced draw on multi-vertex paths and throws
 * "vertex buffer is not big enough" on strict drivers (ANGLE/Metal). All vertices
 * of a feature share its value, so the per-segment read is exact. The output
 * keeps the source typed-array type (preserving the time precision the layer
 * already relies on). Mirrors AnimatedTripsLayer's per-vertex time/color.
 */
function expandFeatureScalarToVertex<
  T extends { [i: number]: number; length: number },
>(
  src: T,
  startIndices: Uint32Array,
  featureCount: number,
  totalVerts: number,
): T {
  // Same constructor as the source → same element type (Float64Array stays
  // Float64Array, so unix-ms times keep the precision the per-feature path had).
  const out = new (src.constructor as new (n: number) => T)(totalVerts);
  for (let f = 0; f < featureCount; f++) {
    const val = src[f];
    const end = startIndices[f + 1];
    for (let v = startIndices[f]; v < end; v++) out[v] = val;
  }
  return out;
}

/**
 * Resolve each feature's categorical color from the palette and expand it to one
 * RGBA PER-VERTEX. Same instance-granularity reason as {@link
 * expandFeatureScalarToVertex}: PathLayer carries `getColor` as a per-vertex
 * attribute its tessellator maps onto segment instances, so a per-feature
 * `instanceCategoryIndex` (the GPU CategoryColorExtension path, correct for the
 * point layer) under-sizes the draw for multi-vertex paths. Mirrors
 * AnimatedTripsLayer.expandCategoryColors.
 */
function expandCategoryColors(
  indices: Uint16Array,
  palette: Color[],
  startIndices: Uint32Array,
  featureCount: number,
  totalVerts: number,
  fallback: Color,
  alphaScale: Float32Array | null,
): Uint8Array {
  const out = new Uint8Array(totalVerts * 4);
  for (let f = 0; f < featureCount; f++) {
    const c = palette[indices[f]] ?? fallback;
    const r = c[0];
    const g = c[1];
    const b = c[2];
    // Height-graded alpha (alphaScale, 0–1) folds onto the band color's own alpha
    // so the fade COMPOSES with the density-band opacity ramp rather than
    // replacing it. Rounded back into the u8 channel.
    const a = alphaScale
      ? Math.round((c[3] ?? 255) * alphaScale[f])
      : (c[3] ?? 255);
    for (let v = startIndices[f]; v < startIndices[f + 1]; v++) {
      const o = v * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  return out;
}

/**
 * Per-feature alpha multiplier (0–1) from a feature's RAW altitude, linearly
 * ramping `near → far` across `[z0, z1]` metres (clamped outside). Used to fade
 * the upper layers of a stacked iso relief translucent so it reads from a
 * top-down view. Keyed on the NUMERIC elevation column directly (pre-scale), so
 * the same real altitude grades to the same alpha in every tile; returns null
 * when the column is absent (or non-numeric) and the caller skips grading.
 */
function elevationAlphaScales(
  binary: BinaryFeatures,
  prop: string,
  range: [number, number],
  near: number,
  far: number,
): Float32Array | null {
  const num = binary.numericProps[prop];
  if (!num) return null;
  const count = binary.featureCount;
  const z0 = range[0];
  const span = range[1] - range[0];
  const out = new Float32Array(count);
  for (let f = 0; f < count; f++) {
    let t = span !== 0 ? (num[f] - z0) / span : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    out[f] = near + (far - near) * t;
  }
  return out;
}

/**
 * Resolve a PER-FEATURE elevation (metres) for every feature in the tile, from
 * an elevation property column. Mirrors the color resolution: a CATEGORICAL
 * column maps each feature's category through `mapping` (absent → 0); a NUMERIC
 * column uses the value directly. The result is scaled by `scale`. Returns null
 * when the column is absent (or categorical with no mapping) — the caller then
 * leaves the tile flat / zero-copy.
 */
function resolveFeatureElevations(
  binary: BinaryFeatures,
  prop: string,
  mapping: Record<string, number> | null | undefined,
  scale: number,
): Float64Array | null {
  const count = binary.featureCount;
  const cat = binary.categoricalProps[prop];
  if (cat && mapping) {
    const out = new Float64Array(count);
    for (let f = 0; f < count; f++) {
      out[f] = (mapping[cat.categories[cat.indices[f]]] ?? 0) * scale;
    }
    return out;
  }
  const num = binary.numericProps[prop];
  if (num) {
    const out = new Float64Array(count);
    for (let f = 0; f < count; f++) out[f] = num[f] * scale;
    return out;
  }
  return null;
}

/**
 * Lift a flat (or already-3D) path-position buffer to XYZ, writing each
 * feature's elevation into the z of all its vertices (the whole path rides at
 * one height — correct for stacked iso-contours). Allocates one
 * `totalVerts × 3` Float64Array per (tile, elevation change); cheap relative to
 * tesselation and amortized across animation frames, like the per-vertex color
 * expansion above.
 */
function buildElevatedPositions(
  src: Float64Array,
  srcDims: number,
  startIndices: Uint32Array,
  featureCount: number,
  totalVerts: number,
  zPerFeature: Float64Array,
): Float64Array {
  const out = new Float64Array(totalVerts * 3);
  for (let f = 0; f < featureCount; f++) {
    const z = zPerFeature[f];
    const end = startIndices[f + 1];
    for (let v = startIndices[f]; v < end; v++) {
      out[v * 3] = src[v * srcDims];
      out[v * 3 + 1] = src[v * srcDims + 1];
      out[v * 3 + 2] = z;
    }
  }
  return out;
}

/**
 * Build a per-tile palette by mapping the tile's own category dictionary
 * through an explicit string→color map. Because `instanceCategoryIndex` indexes
 * into the same per-tile `categories` array, the resulting palette makes each
 * category render the same color in every tile (stable colors), while keeping
 * the GPU `CategoryColorExtension` path — no per-tile CPU RGBA expansion.
 * Mirrors `paletteFromMapping` in animated-trips-layer.ts.
 */
function paletteFromMapping(
  categories: readonly string[],
  mapping: Record<string, Color>,
  fallback: Color,
): Color[] {
  return categories.map((c) => mapping[c] ?? fallback);
}

/**
 * Animated path layer (window mode) with per-tile binary sublayers.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`paths`**.
 * `_subLayerProps: { paths: { type: MyLayer, ...props } }` swaps the
 * sublayer class / overrides sublayer props (deck's CompositeLayer
 * contract). Without a `type` override the class is `PathLayer` when
 * `pickable` and the attribute-stripped `NoPickingPathLayer` otherwise.
 */
export class AnimatedPathLayer<
  ExtraPropsT extends {} = {},
> extends SpatioTemporalLayer<ExtraPropsT & Required<_AnimatedPathLayerProps>> {
  static layerName = 'AnimatedPathLayer';

  static defaultProps: DefaultProps<AnimatedPathLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    widthScale: { type: 'number', value: 1, min: 0 },
    widthUnits: 'pixels',
    widthMinPixels: { type: 'number', value: 0, min: 0 },
    widthMaxPixels: { type: 'number', value: Number.MAX_SAFE_INTEGER, min: 0 },
    // Permissive descriptors ({type:'object'} validates anything): these
    // props legally hold a constant OR a column-name string, which the
    // 'color'/'number' validators would reject in deck's debug mode.
    pathColor: { type: 'object', value: [0, 150, 255, 255], compare: true },
    pathWidth: { type: 'object', value: 3, compare: true },
    // Accessor-named aliases (see the prop docs): unset by default so the
    // legacy props win unless the caller opts into the upstream vocabulary.
    getColor: { type: 'object', value: null, optional: true, compare: true },
    getWidth: { type: 'object', value: null, optional: true, compare: true },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE, compare: true },
    // Digested by content in computeLayerPropsKey/styleKey (compare:false here);
    // a same-shape mapping edit invalidates via the digest, not deck's diff.
    colorMapping: {
      type: 'object',
      value: null,
      optional: true,
      compare: false,
    },
    colorMappingDefault: { type: 'color', value: [120, 120, 120, 255] },
    // Elevation: unset ⇒ flat (zero-copy positions). Digested by content in the
    // styleKey / layerPropsKey (compare:false on the mapping), like colorMapping.
    elevationProperty: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    elevationMapping: {
      type: 'object',
      value: null,
      optional: true,
      compare: false,
    },
    elevationScale: { type: 'number', value: 1 },
    // Height-graded alpha: unset range ⇒ no grading. Range/near/far ride the
    // styleKey so a tweak re-prepares the tiles (re-expands getColor).
    elevationOpacityRange: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    elevationOpacityNear: { type: 'number', value: 1 },
    elevationOpacityFar: { type: 'number', value: 1 },
    fadeInDuration: { type: 'number', value: 300, min: 0 },
    fadeOutDuration: { type: 'number', value: 300, min: 0 },
    capRounded: false,
    jointRounded: false,
    miterLimit: { type: 'number', value: 4, min: 0 },
    billboard: false,

    // Column range filter (DataFilterExtension). Unset ⇒ not installed.
    // Permissive {type:'object'} descriptors (see the point layer).
    filterProperty: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    filterRange: { type: 'object', value: null, optional: true, compare: true },
    filterSoftRange: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    filterEnabled: true,

    // Progressive-reveal / trail mode. Off by default ⇒ window mode (whole path
    // on/off + fade), byte-identical to the pre-reveal layer. `reducedMotion`
    // forces the whole path (no animation) even when `revealTrail` is set.
    revealTrail: false,
    revealDuration: { type: 'number', value: 0, min: 0 },
    fadeTrail: true,
    reducedMotion: false,
  };

  private preparedTileCache = new Map<string, PreparedTile>();
  /**
   * Per-tile sublayer-instance cache — see the matching field on
   * AnimatedTripsLayer for the rationale. Returning the SAME PathLayer
   * reference across renderLayers() calls lets deck.gl short-circuit prop
   * diff for unchanged tiles.
   */
  private sublayerCache = new Map<
    string,
    { layer: PathLayer; preparedKey: PreparedTile; layerPropsKey: string }
  >();
  private lastLayerPropsKey: string = '';
  /** Tile-array identity from the previous render — see AnimatedTripsLayer.lastTilesRef. */
  private lastTilesRef: Tile[] | null = null;
  /**
   * Single TimeFilterExtension shared by every sublayer. It registers all
   * three time attributes unconditionally (the `mode` option is a no-op —
   * forward-compat only), so the same instance serves BOTH the default window
   * mode (reads `instanceStartTime`/`instanceEndTime`) and progressive-reveal
   * trail mode (reads the per-vertex `instanceVertexTime` we feed only when
   * `revealActive()`). The `mode: 'window'` arg documents the default intent;
   * it does not drop the vertex-time slot. What keeps the fp64-position + time
   * + category combo under WebGL2's 16-slot floor is NoPickingPathLayer freeing
   * the picking slot, not attribute pruning here.
   */
  private readonly timeFilterExtension = new TimeFilterExtension({
    mode: 'window',
  });
  private readonly categoryColorExtension = new CategoryColorExtension();
  /**
   * Singleton DataFilterExtension, composed in only when `filterProperty` is
   * set (per-layer constant ⇒ stable list). When installed it REPLACES the
   * idle CategoryColorExtension in the sublayer extension list so the path
   * pipeline stays at WebGL2's 16-slot vertex-attribute floor rather than
   * overflowing to 17 — see the `filterProperty` prop docs.
   */
  private readonly dataFilterExtension = new DataFilterExtension({
    filterSize: 1,
  });
  private readonly boundGetTime: () => number = () => this.getCurrentTime();

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.preparedTileCache.clear();
    this.sublayerCache.clear();
  }

  /**
   * Accessor-alias resolution (audit B1): the upstream-named alias wins when
   * set; a function-valued alias warns once and falls back to the legacy
   * prop. Same value domain as the legacy props (constant or column name).
   */
  private colorValue(): Color | string | undefined {
    return resolveAccessorAlias(
      'AnimatedPathLayer',
      'getColor',
      this.props.getColor,
      this.props.pathColor,
    );
  }

  /**
   * Progressive-reveal / trail mode is EFFECTIVE only when opted in via
   * `revealTrail` AND not suppressed by `reducedMotion`. Under reduced motion
   * the layer degrades to its window-mode whole-path render (no per-vertex
   * trail, no animation) — the accessibility contract every animated surface in
   * this codebase honors. When false, prepareTile/buildSublayer take the exact
   * pre-reveal path (no `instanceVertexTime`, no `trailLength`), so the
   * whole-path output stays byte-identical.
   */
  private revealActive(): boolean {
    return this.props.revealTrail === true && this.props.reducedMotion !== true;
  }

  private widthValue(): number | string | undefined {
    return resolveAccessorAlias(
      'AnimatedPathLayer',
      'getWidth',
      this.props.getWidth,
      this.props.pathWidth,
    );
  }

  /**
   * Resolve `filterProperty` to a baked-column NAME (accessor-alias of deck's
   * `getFilterValue`; a function warns once and is ignored — no legacy prop, so
   * the fallback is "no filter").
   */
  private filterPropertyValue(): string | undefined {
    return resolveAccessorAlias<string | undefined>(
      'AnimatedPathLayer',
      'filterProperty',
      this.props.filterProperty,
      undefined,
    );
  }

  private computeLayerPropsKey(): string {
    const color = this.colorValue();
    const width = this.widthValue();
    return [
      this.props.widthScale,
      this.props.widthUnits,
      this.props.widthMinPixels,
      this.props.widthMaxPixels,
      this.props.capRounded,
      this.props.jointRounded,
      this.props.miterLimit,
      this.props.billboard,
      this.props.fadeInDuration,
      this.props.fadeOutDuration,
      // Composite props that getSubLayerProps bakes into every sublayer
      // (opacity/pickable/visible, coordinate system, _subLayerProps, …)
      // plus the user's updateTriggers.
      inheritedPropsDigest(this.props),
      updateTriggersDigest(this.props.updateTriggers),
      this.props.timeWindow,
      this.props.timeHeightScale,
      this.props.timeHeightOrigin,
      this.props.elevationScale,
      Array.isArray(color) ? color.join(',') : '',
      typeof width === 'number' ? width : 0,
      // Column-filter uniforms (DataFilterExtension) — a range/enabled edit is
      // uniform-only, so it rebuilds the cached sublayers (whose props carry the
      // values) rather than re-preparing tiles, like timeWindow above.
      Array.isArray(this.props.filterRange)
        ? this.props.filterRange.join(',')
        : '',
      Array.isArray(this.props.filterSoftRange)
        ? this.props.filterSoftRange.join(',')
        : '',
      this.props.filterEnabled,
      // Reveal/trail mode. revealTrail + reducedMotion decide whether the trail
      // is active at all (also folded into the prepared-tile styleKey, which
      // gates the instanceVertexTime attribute); revealDuration + fadeTrail are
      // baked as sublayer props, so a change must rebuild the cached sublayers.
      this.revealActive(),
      this.props.revealDuration,
      this.props.fadeTrail,
    ].join('|');
  }

  renderLayers(): Layer[] {
    const t0 = performance.now();
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) {
      this.lastTilesRef = null;
      return [];
    }

    // Skip O(cacheSize) prune walks when the parent re-rendered with the
    // same tile-array ref — the live and cached sets are then identical.
    if (this.lastTilesRef !== tiles) {
      const live = new Set<string>();
      for (const tile of tiles) {
        for (const tileLayer of tile.layers)
          live.add(makeTileKey(tile, tileLayer));
      }
      for (const key of this.preparedTileCache.keys()) {
        if (!live.has(key)) this.preparedTileCache.delete(key);
      }
      for (const key of this.sublayerCache.keys()) {
        if (!live.has(key)) this.sublayerCache.delete(key);
      }
      this.lastTilesRef = tiles;
    }

    const layerPropsKey = this.computeLayerPropsKey();
    if (layerPropsKey !== this.lastLayerPropsKey) {
      this.lastLayerPropsKey = layerPropsKey;
      this.sublayerCache.clear();
    }

    const sublayers: Layer[] = [];
    for (const tile of tiles) {
      for (const tileLayer of tile.layers) {
        const prepared = this.prepareTile(tile, tileLayer);
        if (!prepared) continue;
        const cached = this.sublayerCache.get(prepared.tileKey);
        if (
          cached &&
          cached.preparedKey === prepared &&
          cached.layerPropsKey === layerPropsKey
        ) {
          sublayers.push(cached.layer);
          continue;
        }
        const layer = this.buildSublayer(prepared);
        this.sublayerCache.set(prepared.tileKey, {
          layer,
          preparedKey: prepared,
          layerPropsKey,
        });
        sublayers.push(layer);
      }
    }

    emit('renderLayers', {
      layer: 'AnimatedPathLayer',
      tiles: tiles.length,
      sublayers: sublayers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `AnimatedPathLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`,
      );
    }
    return sublayers;
  }

  private prepareTile(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0 || !binary.startIndices) return null;

    const colorValue = this.colorValue();
    const widthValue = this.widthValue();
    const colorProp = typeof colorValue === 'string' ? colorValue : '';
    const widthProp = typeof widthValue === 'string' ? widthValue : '';
    const filterProp = this.filterPropertyValue() ?? '';
    const elevProp =
      typeof this.props.elevationProperty === 'string'
        ? this.props.elevationProperty
        : '';
    // Palette / mapping keyed by CONTENT, not length — a same-size swap must
    // invalidate cached tiles. The digests are memoized per object reference
    // (style-digest.ts), so this is a WeakMap lookup per tile, not a
    // re-serialization. The mapping branch keys CONTENT so editing one mapping
    // entry (same key count) re-projects the GPU palette. The user's
    // updateTriggers ride the key too so a trigger bump re-prepares the tile.
    const mapSig = this.props.colorMapping
      ? `m${colorMappingDigest(this.props.colorMapping)}`
      : '';
    // Elevation signature — column + scale + (categorical) mapping content, so a
    // height-ramp edit re-prepares the tile (rebuilds the 3D positions buffer).
    const elevSig = elevProp
      ? `e${elevProp}:${this.props.elevationScale}:${
          this.props.elevationMapping
            ? structuralDigest(this.props.elevationMapping)
            : ''
        }`
      : '';
    // Height-graded alpha signature — a range/near/far tweak re-expands getColor.
    const opacityRange = this.props.elevationOpacityRange;
    const elevOpacSig =
      elevProp && opacityRange
        ? `o${opacityRange[0]},${opacityRange[1]}:${this.props.elevationOpacityNear}:${this.props.elevationOpacityFar}`
        : '';
    // Filter column NAME is baked (per-vertex) into `filterValue`, so a change
    // re-prepares tiles and — via the new preparedKey — rebuilds sublayers,
    // covering the unset↔set toggle that adds/removes DataFilterExtension.
    const filterSig = filterProp ? `f${filterProp}` : '';
    const styleKey = `${colorProp}|${widthProp}|${
      colorProp
        ? colorListDigest(this.props.colorPalette ?? DEFAULT_PALETTE)
        : 0
    }|${mapSig}|${elevSig}|${elevOpacSig}|${filterSig}|${updateTriggersDigest(this.props.updateTriggers)}${this.revealActive() ? '|rv1' : ''}`;

    const tileKey = makeTileKey(tile, tileLayer);
    const cached = this.preparedTileCache.get(tileKey);
    if (cached && cached.styleKey === styleKey) {
      emit('tilePrepare', {
        layer: 'AnimatedPathLayer',
        tileKey,
        cached: true,
        ms: 0,
      });
      return cached;
    }

    const t0 = performance.now();
    const srcDims = binary.positionDimensions ?? 2;
    const totalVerts = binary.startIndices[binary.featureCount];

    // Per-feature elevation (z, metres) → a synthesized XYZ positions buffer.
    // Lifts flat contour rings into a 3D relief (stacked-by-density iso-lines).
    // Unset / missing column ⇒ flat: `dims` stays the source value and positions
    // ride to the GPU zero-copy (byte-identical to before).
    const zPerFeature = elevProp
      ? resolveFeatureElevations(
          binary,
          elevProp,
          this.props.elevationMapping,
          this.props.elevationScale ?? 1,
        )
      : null;
    const dims = zPerFeature ? 3 : srcDims;
    const positions = zPerFeature
      ? buildElevatedPositions(
          binary.positions,
          srcDims,
          binary.startIndices,
          binary.featureCount,
          totalVerts,
          zPerFeature,
        )
      : binary.positions;

    const attributes: PreparedTile['data']['attributes'] = {
      // Accessor-name key for PathLayer's own attribute.
      getPath: { value: positions, size: dims },
      // Extension-registered attribute names: must match
      // TimeFilterExtension.initializeState exactly. EXPANDED PER-VERTEX (not
      // per-feature) — PathLayer instances are SEGMENTS, so a per-feature buffer
      // under-sizes the instanced draw on multi-vertex paths ("vertex buffer is
      // not big enough" on ANGLE/Metal). Short lines happened to work because
      // segments≈features; dense contours / long lane lines do not.
      instanceStartTime: {
        value: expandFeatureScalarToVertex(
          binary.startTimes,
          binary.startIndices,
          binary.featureCount,
          totalVerts,
        ),
        size: 1,
      },
      instanceEndTime: {
        value: expandFeatureScalarToVertex(
          binary.endTimes,
          binary.startIndices,
          binary.featureCount,
          totalVerts,
        ),
        size: 1,
      },
    };

    // Progressive-reveal / trail mode: feed the PER-VERTEX time that the trail
    // branch of TimeFilterExtension reads. Prefer the tile's own zero-copy
    // `vertexTimestamps`; otherwise synthesize monotone times by interpolating
    // each feature's [startTime,endTime] span along its path (reused from the
    // trips layer) so a timeless line draws itself in along its length. The
    // `instanceVertexTime` slot is ALREADY registered by the extension in every
    // mode (its `mode` option is a no-op), so this adds DATA, not a GPU
    // attribute — the WebGL2 16-slot vertex-attribute budget is unchanged.
    // Gated on revealActive() so window-mode output is byte-identical when the
    // reveal prop is off (or reduced motion suppresses it).
    if (this.revealActive()) {
      const vertexTimes =
        binary.vertexTimestamps && binary.vertexTimestamps.length >= totalVerts
          ? binary.vertexTimestamps
          : synthesizeVertexTimes(binary);
      attributes.instanceVertexTime = { value: vertexTimes, size: 1 };
    }

    // Categorical color: resolve each feature's color on the CPU and expand it
    // PER-VERTEX into `getColor`. The GPU CategoryColorExtension path uploaded a
    // per-FEATURE `instanceCategoryIndex`, which under-sizes the instanced draw
    // for multi-vertex paths exactly like the time attributes above — `getColor`
    // is a native PathLayer accessor its tessellator maps onto segment instances.
    // Mirrors AnimatedTripsLayer (GPU palette stays null; the extension sits idle
    // but installed so the shader-pipeline cache key is constant).
    const gpuPalette: Color[] | null = null;
    if (colorProp) {
      const cat = binary.categoricalProps[colorProp];
      if (cat) {
        // Explicit colorMapping wins over colorPalette: project the string→color
        // map onto THIS tile's category dictionary so the same category renders
        // the same color in every tile (stable), unlike colorPalette's
        // first-seen per-tile index assignment.
        const palette = this.props.colorMapping
          ? paletteFromMapping(
              cat.categories,
              this.props.colorMapping,
              this.props.colorMappingDefault ?? [120, 120, 120, 255],
            )
          : (this.props.colorPalette ?? DEFAULT_PALETTE);
        // Height-graded alpha (top of a stacked relief fades translucent): keyed
        // on the raw numeric elevation column. Null unless opted in + numeric.
        const alphaScale =
          elevProp && opacityRange
            ? elevationAlphaScales(
                binary,
                elevProp,
                opacityRange,
                this.props.elevationOpacityNear ?? 1,
                this.props.elevationOpacityFar ?? 1,
              )
            : null;
        attributes.getColor = {
          value: expandCategoryColors(
            cat.indices,
            palette,
            binary.startIndices,
            binary.featureCount,
            totalVerts,
            this.props.colorMappingDefault ?? [120, 120, 120, 255],
            alphaScale,
          ),
          size: 4,
          normalized: true,
        };
      }
    }

    if (widthProp) {
      const values = binary.numericProps[widthProp];
      if (values) {
        // getWidth is a native PathLayer accessor, carried as a PER-VERTEX
        // attribute its tessellator maps onto segment instances. A per-FEATURE
        // buffer (length = featureCount) under-sizes the instanced draw on
        // multi-vertex paths exactly like the time attributes above and throws
        // "vertex buffer is not big enough" on ANGLE/Metal — deck binds a
        // named binary buffer verbatim, so it must already be per-vertex.
        // Force Float32 (getWidth is a float32 attribute) before expanding.
        const widthValues =
          values instanceof Float32Array ? values : new Float32Array(values);
        attributes.getWidth = {
          value: expandFeatureScalarToVertex(
            widthValues,
            binary.startIndices,
            binary.featureCount,
            totalVerts,
          ),
          size: 1,
        };
      }
    }

    // Column range filter (DataFilterExtension). The value is per-FEATURE, but —
    // exactly like the time attributes above — PathLayer instances are SEGMENTS,
    // so a per-feature buffer under-sizes the instanced draw on multi-vertex
    // paths ("vertex buffer is not big enough" on ANGLE/Metal). Expand it
    // per-VERTEX; every vertex of a path shares its feature's value. Absent
    // column ⇒ no attribute → the sublayer idles the filter for this tile. A
    // categorical column can't be range-filtered in v1 — warn once.
    if (filterProp) {
      const values = binary.numericProps[filterProp];
      if (values) {
        const filterValues =
          values instanceof Float32Array ? values : new Float32Array(values);
        attributes.filterValue = {
          value: expandFeatureScalarToVertex(
            filterValues,
            binary.startIndices,
            binary.featureCount,
            totalVerts,
          ),
          size: 1,
        };
      } else if (binary.categoricalProps[filterProp]) {
        warnOnce(
          'AnimatedPathLayer:filterPropertyCategorical',
          `[AnimatedPathLayer] filterProperty "${filterProp}" is a categorical ` +
            'column; v1 range-filters NUMERIC columns only. The filter is ignored ' +
            'for tiles where the column is categorical.',
        );
      }
    }

    const prepared: PreparedTile = {
      tileKey,
      styleKey,
      data: {
        length: binary.featureCount,
        startIndices: binary.startIndices,
        attributes,
      },
      timeOffset: binary.timeOffset,
      dims,
      gpuPalette,
      tile,
      features: binary,
    };
    this.preparedTileCache.set(tileKey, prepared);
    emit('tilePrepare', {
      layer: 'AnimatedPathLayer',
      tileKey,
      cached: false,
      features: binary.featureCount,
      gpuPalette: gpuPalette !== null,
      ms: performance.now() - t0,
    });
    return prepared;
  }

  private buildSublayer(prepared: PreparedTile): PathLayer {
    const colorValue = this.colorValue();
    const widthValue = this.widthValue();
    const constColor = (
      Array.isArray(colorValue) ? colorValue : [0, 150, 255, 255]
    ) as Color;
    const constWidth = typeof widthValue === 'number' ? widthValue : 2;
    // `Required<>`-typed: the defaultProps value guarantees a number here.
    const timeWindow = this.props.timeWindow;

    const useGpuCategory = prepared.gpuPalette !== null;
    if (useGpuCategory && prepared.gpuPalette!.length > CATEGORY_PALETTE_SIZE) {
      warnOnce(
        'AnimatedPathLayer:paletteOverflow',
        `[AnimatedPathLayer] colorPalette has ${prepared.gpuPalette!.length} ` +
          `entries; only the first ${CATEGORY_PALETTE_SIZE} will be used by ` +
          'CategoryColorExtension.',
      );
    }

    // Column range filter — install DataFilterExtension only when a column is
    // named (per-layer constant ⇒ stable list). `hasFilter` gates the per-tile
    // enable so a tile missing the column renders unfiltered.
    const filterProp = this.filterPropertyValue();
    const hasFilter = !!prepared.data.attributes.filterValue;

    // Keep the extension list constant across sublayers — see
    // animated-trips-layer.ts for the cache-storm rationale. User extensions
    // from the top-level `extensions` prop are appended (composeExtensions).
    //
    // ATTRIBUTE-BUDGET: the non-pickable path pipeline (NoPickingPathLayer, 12
    // attrs) + TimeFilterExtension's 3 sits at 15, then ONE more extension
    // attribute lands it at WebGL2's guaranteed 16-slot floor. Installing BOTH
    // CategoryColorExtension (`instanceCategoryIndex`) AND DataFilterExtension
    // (`filterValue`) would make 17 — a fatal per-pipeline link FAILURE (blank
    // paths) on the many GPUs that report exactly 16 slots. The path family
    // never uses the GPU category path (categorical color is expanded on the
    // CPU into `getColor`; `gpuPalette` is always null here), so the
    // CategoryColorExtension is pure dead weight. When a column filter is
    // installed we therefore DROP the idle CategoryColorExtension and spend that
    // one free slot on `filterValue` instead — net 16, no overflow. `filterProp`
    // is a per-LAYER constant, so the list stays stable across this layer's
    // sublayers (the shader-cache contract holds). See the `filterProperty`
    // prop docs.
    const extensions = this.composeExtensions(
      filterProp
        ? [this.timeFilterExtension, this.dataFilterExtension]
        : [this.timeFilterExtension, this.categoryColorExtension],
    );
    // getSubLayerProps inheritance (opacity/pickable/visible, coordinate
    // system, highlight props, …) + user `_subLayerProps.paths` overrides.
    // Only runs inside this cache-gated build path — never per frame.
    // positionFormat is passed explicitly (sublayerProps beats inheritance):
    // the composite's default 'XYZ' would misread 2D tile buffers.
    const props = this.composeSubLayerProps('paths', prepared.tileKey, {
      data: prepared.data,
      // Identity comparator pairs with the preparedTileCache: deck.gl skips
      // the entire prop-diff for `data` when the same object reference
      // comes back.
      dataComparator: (a: any, b: any) => a === b,
      _pathType: 'open',
      positionFormat: prepared.dims === 3 ? 'XYZ' : 'XY',
      // `Required<>`-typed (defaults guarantee values) — no `??` refetches.
      widthUnits: this.props.widthUnits,
      widthScale: this.props.widthScale,
      widthMinPixels: this.props.widthMinPixels,
      widthMaxPixels: this.props.widthMaxPixels,
      capRounded: this.props.capRounded,
      jointRounded: this.props.jointRounded,
      miterLimit: this.props.miterLimit,
      billboard: this.props.billboard,

      getColor: constColor,
      getWidth: constWidth,

      extensions,
      getTime: this.boundGetTime,
      timeOffset: prepared.timeOffset,
      timeWindow,
      fadeInDuration: this.props.fadeInDuration,
      fadeOutDuration: this.props.fadeOutDuration,
      // Progressive-reveal / trail mode (gated by revealTrail + !reducedMotion).
      // A non-zero `trailLength` flips TimeFilterExtension into its trail branch,
      // which reveals the path up to the play head via `instanceVertexTime`. A
      // zero/unset `revealDuration` PERSISTS the whole revealed portion
      // (draw-and-keep) through an effectively-infinite trail; a positive one is
      // a finite comet trail. Omitted entirely when reveal is inactive, so the
      // window-mode sublayer props stay byte-identical.
      ...(this.revealActive()
        ? {
            trailLength:
              this.props.revealDuration && this.props.revealDuration > 0
                ? this.props.revealDuration
                : REVEAL_PERSIST_TRAIL_MS,
            fadeTrail: this.props.fadeTrail,
          }
        : {}),
      // Time-as-height (space-time cube). Window mode lifts whole features
      // by start time (the per-vertex attribute defaults to 0 here).
      timeHeightScale: this.props.timeHeightScale,
      timeHeightOrigin: this.props.timeHeightOrigin,

      // TileLayer convention: the source tile rides on the sublayer so the
      // base getPickingInfo can enrich info.tile / decode the picked path.
      tile: prepared.tile,
      sttFeatures: prepared.features,

      useCategoryColor: useGpuCategory,
      ...(useGpuCategory ? { categoryPalette: prepared.gpuPalette! } : {}),

      // DataFilterExtension wiring (only when a filterProperty is set). The
      // constant getFilterValue is the fallback for tiles missing the column;
      // filterEnabled is additionally gated on THIS tile having baked it.
      ...(filterProp
        ? {
            getFilterValue: 0,
            filterEnabled: hasFilter && this.props.filterEnabled !== false,
            filterRange: this.props.filterRange ?? null,
            filterSoftRange: this.props.filterSoftRange ?? null,
          }
        : {}),
    });
    // Pickable sublayers must use the stock PathLayer: NoPickingPathLayer
    // strips `instancePickingColors`, so forwarding pickable:true into it
    // produced silently-broken picking (zeroed picking colors). The stock
    // layer's extra attribute can push the fp64 + TimeFilter + CategoryColor
    // combo past WebGL2's 16-slot minimum on GPUs that report exactly 16 —
    // accepted, with a warning. The picked instance index is the path index
    // within the tile; getPickingInfo decodes its properties from there.
    // A `_subLayerProps: { paths: { type } }` override beats both defaults.
    if (this.props.pickable) {
      warnOnce(
        'AnimatedPathLayer:pickableAttributeBudget',
        '[AnimatedPathLayer] pickable:true renders through the stock PathLayer ' +
          'so picking works, but its instancePickingColors attribute can exceed ' +
          "WebGL2's 16-vertex-attribute minimum on some GPUs (link warning).",
      );
      const SubLayerClass = this.getSubLayerClass('paths', PathLayer);
      return new SubLayerClass(props as any);
    }
    // NoPickingPathLayer drops `instancePickingColors` from both the JS
    // attribute-manager registration AND the compiled vertex shader. With
    // PathLayer's hard-coded 13 attrs + TimeFilterExtension's 3 +
    // CategoryColorExtension's 1 = 17, the layer otherwise blows past the
    // WebGL2 16-attribute minimum and the per-pipeline link fails on GPUs
    // that report exactly 16. Sublayers here are non-pickable, so there is
    // no behavioural change. See `no-picking-path-layer.ts`.
    const SubLayerClass = this.getSubLayerClass('paths', NoPickingPathLayer);
    return new SubLayerClass(props as any);
  }
}

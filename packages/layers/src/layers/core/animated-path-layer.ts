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
import { STTDataFilterExtension } from '../../extensions/data-filter-extension.js';
import type { DataFilterRange } from '../../extensions/data-filter-extension.js';
// Progressive-reveal / trail mode reuses the trips layer's per-vertex time
// synthesis (interpolate a feature's [startTime,endTime] span along its path by
// cumulative distance) so a timeless line inks itself in over the play window.
import { synthesizeVertexTimes } from '../trips/animated-trips-layer.js';
import { emit } from '../../lib/telemetry.js';
import { warnOnce } from '../../lib/log.js';
import { expectGeometry } from '../../lib/geometry-guard.js';
import {
  colorListDigest,
  colorMappingDigest,
  inheritedPropsDigest,
  structuralDigest,
  updateTriggersDigest,
} from '../../lib/style-digest.js';
import {
  buildLayerPropsKey,
  type PropEffects,
} from '../../lib/layer-props-key.js';
import { resolveAccessorAlias } from '../../lib/accessor-alias.js';
import type {
  ColorAccessorValue,
  NumericAccessorValue,
  WeightAccessorValue,
} from '../../lib/accessor-alias.js';
import {
  DEFAULT_LINE_PALETTE,
  GeometryType,
  tileLayerKey,
} from '@poopdeck.gl/core';
import type {
  Tile,
  STTTileLayer as TileLayer,
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
   * Units for path width — the full upstream `Unit` domain.
   *
   * DEFAULT DRIFT: `'pixels'`, where upstream PathLayer defaults to `'meters'`.
   * Deliberate — tile-sourced paths are drawn as map furniture (routes, lane
   * lines, contours) whose on-screen weight should not collapse as you zoom out.
   * Pass `'meters'` explicitly for ground-truth widths.
   * @default 'pixels'
   */
  widthUnits?: 'pixels' | 'meters' | 'common';
  /** Clamp path width to at least this many on-screen pixels. */
  widthMinPixels?: number;
  /** Clamp path width to at most this many on-screen pixels. */
  widthMaxPixels?: number;
  /**
   * Path color — constant {@link Color}, or property name for categorical coloring.
   *
   * DEFAULT DRIFT: STT blue, where upstream PathLayer's `getColor` defaults to
   * opaque black `[0, 0, 0, 255]`. Deliberate — a black default is invisible on
   * the dark basemaps these tiles are usually drawn over.
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
   * Path width — constant number, or property name for per-feature width. In
   * {@link widthUnits}; also the fallback width for tiles that do not carry the
   * named column.
   *
   * DEFAULT DRIFT: `3`, where upstream PathLayer's `getWidth` defaults to `1`.
   * Deliberate — `1` in the `'pixels'` units this layer defaults to is a hairline
   * that all but disappears on a HiDPI display.
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
   * Path topology, forwarded to PathLayer's `_pathType`.
   *
   * `'open'` (default) draws a START_CAP at the first vertex and an END_CAP at
   * the last. On CLOSED geometry (contour rings, lane loops, footprints baked as
   * LineStrings) that leaves a visible notch at the ring seam where a mitred
   * joint belongs. `'loop'` closes the joint instead.
   *
   * ⚠ `'loop'` is NOT a drop-in for arbitrary tiles, for two reasons:
   *
   *  1. **It is tile-WIDE, not per-feature.** STT tiles feed PathLayer binary
   *     data (`normalize: false`), and its tessellator then reads closedness from
   *     the `loop` flag alone rather than comparing each path's endpoints
   *     (`path-tesselator.ts` `isClosed()`). Every feature in every tile is
   *     treated as closed — so only set it for datasets that are ALL rings.
   *  2. **The buffer must already carry the +2 wrap vertices.** For a closed path
   *     the tessellator expects `numPoints + 2` vertices — the ring followed by a
   *     repeat of its first TWO vertices (`B0 B1 B2 B3 B0 B1`) — and it reads
   *     that padding out of the tile's own `positions`/`startIndices`; the binary
   *     path never synthesizes it (`getGeometrySize` is bypassed when
   *     `startIndices` is supplied). A ring baked in the usual first-vertex-
   *     repeated-last form does NOT satisfy this and renders a short, mis-capped
   *     final segment. The layer checks the tile's buffers for the padding and
   *     warns once when it is missing.
   *
   * @default 'open'
   */
  pathType?: 'open' | 'loop';
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
   * (installs {@link STTDataFilterExtension}). A path renders when its value in
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
   * vertex-attribute count tight. Counting the `in` declarations in the SHIPPED
   * deck.gl 9.3 vertex shaders (a WebGL2 driver allocates a slot per declaration,
   * bound or not):
   *
   *   stock PathLayer                     13
   *   NoPickingPathLayer (picking strip)  12
   *   + TimeFilterExtension                3
   *   + STTDataFilterExtension             1   (this prop)
   *
   * so the four combinations are 15 (default), 16 (filter), 16 (pickable) and
   * **17** (filter + pickable) — and 17 is a fatal per-pipeline link failure
   * (blank paths) on the GPUs that report WebGL2's guaranteed minimum of exactly
   * 16. Only that last combination overflows: prefer `pickable: false` (the
   * default) when filtering, or `AnimatedPointLayer`, where the budget is roomy.
   * The layer warns once if you ask for both.
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
   *
   * ⚠ PERSISTENCE IS A SHADER PROPERTY, NOT A TILE-RESIDENCY ONE — the same
   * caveat {@link TimeFilterExtension} documents for its `cumulative` prop.
   * The shader keeps every vertex the play head has passed, but tile SELECTION
   * still follows `getEffectiveTimeWindow()`: once the head is more than
   * `timeWindow / 2` past a feature, its tile is deselected and the "persisted"
   * ink disappears mid-playback. A FINITE `revealDuration` is handled for you
   * (the layer widens the load window to `2 × revealDuration`, like the trips
   * layer does for `trailLength`), but `0` means "forever", which no finite load
   * window can satisfy. To actually persist, set {@link
   * SpatioTemporalLayerProps.tileLoadTimeWindow} wide enough to hold the span you
   * want to keep on screen (typically the whole dataset's time range) — the
   * render window stays narrow, since TimeFilterExtension filters per feature,
   * not per tile. The layer warns once if you leave it unset.
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

/**
 * Where each own prop lands, and therefore whether editing it has to throw
 * away the per-tile sublayer cache. `'sublayer'` values are frozen into a
 * cached PathLayer at construction and ride {@link computeLayerPropsKey};
 * `'prepare'` values reach the GPU only through a tile's baked attributes,
 * which the prepare-time styleKey covers and the prepared-object identity
 * check turns into a sublayer rebuild.
 *
 * The {@link PropEffects} annotation makes the table total: a prop added to
 * {@link _AnimatedPathLayerProps} without an entry here fails to compile,
 * which is the only thing standing between an unclassified prop and a stale
 * sublayer nobody notices until they look at the map.
 */
const PATH_PROP_EFFECTS: PropEffects<_AnimatedPathLayerProps> = {
  widthScale: 'sublayer',
  widthUnits: 'sublayer',
  widthMinPixels: 'sublayer',
  widthMaxPixels: 'sublayer',
  pathColor: 'sublayer',
  getColor: 'sublayer',
  pathWidth: 'sublayer',
  getWidth: 'sublayer',
  // Categorical color resolves entirely inside prepareTile — the palette, the
  // explicit mapping and its unknown-category fallback are baked into the
  // tile's per-vertex getColor buffer, never read while constructing a
  // sublayer.
  colorPalette: 'prepare',
  colorMapping: 'prepare',
  colorMappingDefault: 'prepare',
  fadeInDuration: 'sublayer',
  fadeOutDuration: 'sublayer',
  capRounded: 'sublayer',
  jointRounded: 'sublayer',
  miterLimit: 'sublayer',
  billboard: 'sublayer',
  pathType: 'sublayer',
  // The elevation ramp is baked into the tile's synthesized XYZ positions and
  // its height-graded getColor alpha; the sublayer reads neither.
  elevationProperty: 'prepare',
  elevationMapping: 'prepare',
  elevationScale: 'sublayer',
  elevationOpacityRange: 'prepare',
  elevationOpacityNear: 'prepare',
  elevationOpacityFar: 'prepare',
  filterProperty: 'sublayer',
  filterRange: 'sublayer',
  filterSoftRange: 'sublayer',
  filterEnabled: 'sublayer',
  revealTrail: 'sublayer',
  revealDuration: 'sublayer',
  fadeTrail: 'sublayer',
  reducedMotion: 'sublayer',
};

// Shared with the maplibre adapter (single source of truth in
// @poopdeck.gl/core).
const DEFAULT_PALETTE: Color[] = DEFAULT_LINE_PALETTE;

// Single source of truth for the constant color / width fallbacks: the same
// values back `defaultProps` AND the buildSublayer fallbacks taken when the
// resolved prop is a COLUMN NAME that a given tile did not bake. Two literals
// drifted apart before (the width fallback said 2, the documented default 3),
// which rendered two different "no data" widths inside one layer whenever only
// some tiles carried the width column.
const DEFAULT_PATH_COLOR: Color = [0, 150, 255, 255];
const DEFAULT_PATH_WIDTH = 3;
const DEFAULT_MAPPING_DEFAULT: Color = [120, 120, 120, 255];

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

/** One deck binary-attribute descriptor. */
interface BinaryAttr {
  value: any;
  size: number;
  normalized?: boolean;
}

/** See AnimatedTripsLayer for the rationale; same cache shape, window-mode attrs. */
interface PreparedTile {
  tileKey: string;
  styleKey: string;
  data: {
    length: number;
    startIndices: Uint32Array;
    attributes: Record<string, BinaryAttr>;
  };
  timeOffset: number;
  /**
   * 2 or 3 — the dimensionality of the `getPath` buffer this tile was built
   * with (3 once {@link _AnimatedPathLayerProps.elevationProperty} lifts it).
   * INFORMATIONAL: deck reads the geometry stride from the descriptor's own
   * `size`, never from `positionFormat` (`Tesselator.updateGeometry` prefers
   * `geometryBuffer.size`), so nothing downstream consumes this.
   */
  dims: number;
  /** Source tile + decoded columns — picking enrichment context (references, not copies). */
  tile: Tile;
  features: BinaryFeatures;
}

// ── Per-tile, style-INDEPENDENT attribute memo ──────────────────────────────
// The descriptors below are pure functions of a tile's decoded `binary` (its
// positions, per-feature times, and one named column) — none of them depend on
// the palette, the color mapping, the elevation-opacity ramp, `revealTrail`, or
// the user's updateTriggers. But ALL of those ride the per-tile `styleKey`, so
// any style edit re-runs `prepareTile`, and before this memo that rebuilt every
// descriptor object from scratch.
//
// A fresh descriptor is not free even when its CONTENTS are unchanged: deck's
// tesselator copies it into `buffers`, and `AttributeManager.update` →
// `Attribute.setExternalBuffer` compares the incoming descriptor by OBJECT
// IDENTITY (`attribute.ts`). A new object always mismatches, so deck re-runs
// `setData` — for `getPath` that means a `toDoublePrecisionArray` pass and a
// full fp64 re-upload of the position buffer, on every palette tweak. The
// per-vertex expansions (`instanceStartTime`/`instanceEndTime`) and the reveal
// mode's `synthesizeVertexTimes` (an O(totalVerts) haversine sweep) also paid
// their CPU cost again each time.
//
// Keying on the `binary` object identity — stable while a tile is loaded, GC'd
// with it — computes each exactly once per tile-load and hands back the SAME
// descriptor object afterwards, so deck's identity check short-circuits and the
// GPU buffer is left alone. The arrays are read-only after construction, so
// sharing them is byte-identical to recomputing. Mirrors the sibling trips
// layer's `vertexTimeMemo`.
interface TileAttrMemo {
  /** Zero-copy positions descriptor (no elevation column in play). */
  flatPath?: BinaryAttr;
  /** Elevated (XYZ) positions, plus the elevation signature that produced them. */
  elevatedPath?: { sig: string; attr: BinaryAttr };
  startTime?: BinaryAttr;
  endTime?: BinaryAttr;
  vertexTime?: BinaryAttr;
  width?: { prop: string; attr: BinaryAttr };
  filter?: { prop: string; attr: BinaryAttr };
}

const tileAttrMemo = new WeakMap<BinaryFeatures, TileAttrMemo>();

function memoFor(binary: BinaryFeatures): TileAttrMemo {
  let memo = tileAttrMemo.get(binary);
  if (!memo) {
    memo = {};
    tileAttrMemo.set(binary, memo);
  }
  return memo;
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
 * True when every feature in the tile carries the +2 wrap vertices that
 * PathLayer's `_pathType: 'loop'` expects.
 *
 * With binary data the tessellator does NOT synthesize the wrap: it takes the
 * caller's `startIndices` verbatim and, for a closed path of `n` points, expects
 * `n + 2` entries laid out `B0 B1 … Bn-1 B0 B1` (see `path-tesselator.ts`
 * `getGeometrySize` / `_updateSegmentTypes`). So the check is exact and cheap —
 * two vertex comparisons per feature — and it runs only when the caller opts
 * into `'loop'`. Degenerate runs (< 5 vertices, which `getGeometrySize` would
 * reject as a ring anyway) are skipped rather than failed.
 */
function hasLoopPadding(
  positions: Float64Array,
  dims: number,
  startIndices: Uint32Array,
  featureCount: number,
): boolean {
  for (let f = 0; f < featureCount; f++) {
    const start = startIndices[f];
    const size = startIndices[f + 1] - start;
    if (size < 5) continue;
    const a = start * dims;
    const b = (start + 1) * dims;
    const wrap0 = (start + size - 2) * dims;
    const wrap1 = (start + size - 1) * dims;
    if (
      positions[a] !== positions[wrap0] ||
      positions[a + 1] !== positions[wrap0 + 1] ||
      positions[b] !== positions[wrap1] ||
      positions[b + 1] !== positions[wrap1 + 1]
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Build a per-tile palette by mapping the tile's own category dictionary
 * through an explicit string→color map, so the same category renders the same
 * color in every tile (stable colors) rather than following each tile's own
 * first-seen index order. The result is consumed by the CPU per-vertex
 * expansion in {@link expandCategoryColors}. Mirrors `paletteFromMapping` in
 * animated-trips-layer.ts.
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
 * `pickable` and the attribute-stripped `NoPickingPathLayer` otherwise; the
 * choice is encoded in the sublayer id (`…-<tileKey>:np|pk`) so a runtime
 * `pickable` flip REPLACES the sublayer rather than being matched onto the
 * other class's transferred GPU state.
 */

/** One cached per-tile sublayer plus the keys it was built for. */
interface CachedPathSublayer {
  layer: PathLayer;
  preparedKey: PreparedTile;
  layerPropsKey: string;
}

/**
 * Everything the render path caches between frames, in ONE bag so it can live
 * on `this.state` and survive deck's `_transferState`. See
 * {@link AnimatedPathLayer.pathCaches}.
 */
interface PathCaches {
  prepared: Map<string, PreparedTile>;
  sublayers: Map<string, CachedPathSublayer>;
  layerPropsKey: string;
  tilesRef: Tile[] | null;
}

const PATH_CACHE_SLOT = '_sttPathCaches';

function freshPathCaches(): PathCaches {
  return {
    prepared: new Map(),
    sublayers: new Map(),
    layerPropsKey: '',
    tilesRef: null,
  };
}

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
    pathColor: { type: 'object', value: DEFAULT_PATH_COLOR, compare: true },
    pathWidth: { type: 'object', value: DEFAULT_PATH_WIDTH, compare: true },
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
    colorMappingDefault: { type: 'color', value: DEFAULT_MAPPING_DEFAULT },
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
    // Path topology. 'open' matches the pre-prop behaviour (and, unlike
    // upstream's `_pathType: null`, keeps the tessellator's normalize pass OFF
    // so the tile's binary buffers ride to the GPU zero-copy). See the prop docs
    // for the +2 wrap-vertex requirement 'loop' imposes.
    pathType: 'open',

    // Column range filter (STTDataFilterExtension). Unset ⇒ not installed.
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

  /**
   * Render caches, held on `this.state` rather than in class FIELDS.
   *
   * deck's `_transferState` moves only `state`/`internalState` onto the
   * instance React hands it each render, while class-field initializers re-run
   * on that instance. Held as fields these caches were silently emptied by any
   * unmemoized `new AnimatedPathLayer({...})` inside a React render — the
   * deck-documented idiom — so every visible tile got a fresh descriptor
   * container and a full GPU re-upload on frames where the layer re-renders.
   * `AnimatedTripsLayer` diagnosed and fixed exactly this; this is the port.
   */
  private get pathCaches(): PathCaches {
    return this.stateSlot(PATH_CACHE_SLOT, freshPathCaches);
  }

  // Accessors keep the historical field NAMES (the shared harnesses and sibling
  // layers speak them) while the storage lives on `state`.

  private get preparedTileCache(): Map<string, PreparedTile> {
    return this.pathCaches.prepared;
  }
  private set preparedTileCache(value: Map<string, PreparedTile>) {
    this.pathCaches.prepared = value;
  }
  /**
   * Per-tile sublayer-instance cache — see the matching entry on
   * AnimatedTripsLayer for the rationale. Returning the SAME PathLayer
   * reference across renderLayers() calls lets deck.gl short-circuit prop
   * diff for unchanged tiles.
   */
  private get sublayerCache(): Map<string, CachedPathSublayer> {
    return this.pathCaches.sublayers;
  }
  private set sublayerCache(value: Map<string, CachedPathSublayer>) {
    this.pathCaches.sublayers = value;
  }
  private get lastLayerPropsKey(): string {
    return this.pathCaches.layerPropsKey;
  }
  private set lastLayerPropsKey(value: string) {
    this.pathCaches.layerPropsKey = value;
  }
  /** Tile-array identity from the previous render — see AnimatedTripsLayer.lastTilesRef. */
  private get lastTilesRef(): Tile[] | null {
    return this.pathCaches.tilesRef;
  }
  private set lastTilesRef(value: Tile[] | null) {
    this.pathCaches.tilesRef = value;
  }
  /**
   * Single TimeFilterExtension shared by every sublayer. It registers all
   * three time attributes unconditionally (the `mode` option is a no-op —
   * forward-compat only), so the same instance serves BOTH the default window
   * mode (reads `instanceStartTime`/`instanceEndTime`) and progressive-reveal
   * trail mode (reads the per-vertex `instanceVertexTime` we feed only when
   * `revealActive()`). The `mode: 'window'` arg documents the default intent;
   * it does not drop the vertex-time slot. What keeps the fp64-position + time
   * combo under WebGL2's 16-slot floor is NoPickingPathLayer freeing the picking
   * slot, not attribute pruning here.
   *
   * NOTE there is deliberately no CategoryColorExtension alongside it. This
   * family resolves categorical color on the CPU into a per-vertex `getColor`
   * (PathLayer instances are SEGMENTS, so the extension's per-FEATURE
   * `instanceCategoryIndex` would under-size the draw), so the extension could
   * never fire here — while still costing a real vertex-attribute slot, because
   * its `initializeState` registers the attribute and injects the `in`
   * declaration unconditionally.
   */
  private readonly timeFilterExtension = new TimeFilterExtension({
    mode: 'window',
  });
  /**
   * Singleton STTDataFilterExtension, composed in only when `filterProperty` is
   * set (per-layer constant ⇒ stable list). See the `filterProperty` prop docs
   * for the slot arithmetic it participates in.
   */
  private readonly dataFilterExtension = new STTDataFilterExtension({
    filterSize: 1,
  });
  private readonly boundGetTime: () => number = () => this.getCurrentTime();

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.preparedTileCache.clear();
    this.sublayerCache.clear();
  }

  /**
   * Accessor-alias resolution: the upstream-named alias wins when
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

  /**
   * Progressive-reveal needs the tiles BEHIND the play head to stay selected —
   * the shader can only keep drawing a vertex whose tile is still resident.
   * A finite {@link _AnimatedPathLayerProps.revealDuration} bounds how far back
   * that reaches, so widen the LOAD window to twice it (exactly what the trips
   * layer does for `trailLength`); the RENDER window is untouched, since
   * TimeFilterExtension filters per feature.
   *
   * `revealDuration: 0` (reveal-and-PERSIST) is unbounded by construction —
   * "keep everything already drawn" has no finite widening — so it is left to
   * `tileLoadTimeWindow`, and the mismatch is warned about rather than silently
   * papered over with a guess at the dataset's span.
   */
  protected getEffectiveTimeWindow(): number {
    const base = super.getEffectiveTimeWindow();
    if (!this.revealActive()) return base;
    const duration = this.props.revealDuration;
    if (duration && duration > 0) return Math.max(base, duration * 2);
    if (!this.props.tileLoadTimeWindow) {
      warnOnce(
        'AnimatedPathLayer:revealPersistLoadWindow',
        '[AnimatedPathLayer] revealTrail with revealDuration:0 persists the ' +
          'revealed path in the SHADER, but tile selection still follows ' +
          'timeWindow — a feature more than timeWindow/2 behind the play head ' +
          'has its tile evicted and its "persisted" ink vanishes mid-playback. ' +
          'Set tileLoadTimeWindow to the span you want to keep on screen ' +
          '(typically the dataset time range); the render window is unaffected.',
      );
    }
    return base;
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
    return buildLayerPropsKey<_AnimatedPathLayerProps>(
      this.props,
      PATH_PROP_EFFECTS,
      {
        // Values the sublayer is actually built from: `getColor` / `getWidth`
        // win over their legacy props, so keying the legacy prop raw would
        // leave every cached sublayer at the old value when only the alias
        // changes. `filterProperty` resolves to a column NAME — a function is
        // ignored, and keying it raw would clear the cache every render for a
        // caller who passes a fresh function that changes nothing.
        overrides: {
          pathColor: this.colorValue(),
          pathWidth: this.widthValue(),
          filterProperty: this.filterPropertyValue(),
        },
        extra: [
          // Composite props that getSubLayerProps bakes into every sublayer
          // (opacity/pickable/visible, coordinate system, _subLayerProps, …)
          // plus the user's updateTriggers.
          inheritedPropsDigest(this.props),
          updateTriggersDigest(this.props.updateTriggers),
          // Inherited time props the sublayers carry as uniforms.
          this.props.timeWindow,
          this.props.timeHeightScale,
          this.props.timeHeightOrigin,
          // What the sublayer's trail branch is actually gated on. revealTrail
          // and reducedMotion are keyed raw above; this stays a distinct input
          // so the key follows the gate even if its inputs grow.
          this.revealActive(),
        ],
      },
    );
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
          live.add(tileLayerKey(tile.id, tileLayer.name));
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
    // Polygon tiles carry `startIndices` too, so the guard above does not
    // separate them — but their runs are RINGS, not open paths, and this layer
    // would silently draw every ring's outline as a stray polyline. Skip
    // anything that is not LineString with one named warning.
    if (
      !expectGeometry(
        binary.geometryType,
        [GeometryType.LineString],
        this.props.id,
        tileLayer.name,
      )
    ) {
      return null;
    }

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
    // colorMappingDefault is load-bearing TWICE over — it is the palette slot
    // `paletteFromMapping` gives a category the mapping doesn't name, and the
    // out-of-range fallback `expandCategoryColors` writes — and both are baked
    // into the per-vertex `getColor` bytes. Without it in the key, editing the
    // default alone produced a byte-identical styleKey, so the cached tile (and
    // then the cached sublayer) came straight back and nothing re-rendered.
    // Folded UNCONDITIONALLY, mirroring AnimatedLineLayer: the re-prepare is
    // cheap now that the style-independent descriptors are memoized per tile.
    const mapDefault = (
      this.props.colorMappingDefault ?? DEFAULT_MAPPING_DEFAULT
    ).join(',');
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
    // covering the unset↔set toggle that adds/removes STTDataFilterExtension.
    const filterSig = filterProp ? `f${filterProp}` : '';
    const styleKey = `${colorProp}|${widthProp}|${
      colorProp
        ? colorListDigest(this.props.colorPalette ?? DEFAULT_PALETTE)
        : 0
    }|${mapSig}|d${mapDefault}|${elevSig}|${elevOpacSig}|${filterSig}|${updateTriggersDigest(this.props.updateTriggers)}${this.revealActive() ? '|rv1' : ''}`;

    const tileKey = tileLayerKey(tile.id, tileLayer.name);
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
    // Style-independent descriptors are reused ACROSS style changes — see the
    // TileAttrMemo docstring for why descriptor IDENTITY (not just content) is
    // what saves the re-upload.
    const memo = memoFor(binary);

    // Per-feature elevation (z, metres) → a synthesized XYZ positions buffer.
    // Lifts flat contour rings into a 3D relief (stacked-by-density iso-lines).
    // Unset / missing column ⇒ flat: `dims` stays the source value and positions
    // ride to the GPU zero-copy (byte-identical to before). The elevation build
    // is memoized under its own signature, so only an actual height-ramp edit
    // reallocates it; a palette swap reuses the same buffer AND descriptor.
    let pathAttr: BinaryAttr;
    if (elevSig && memo.elevatedPath?.sig === elevSig) {
      pathAttr = memo.elevatedPath.attr;
    } else {
      const zPerFeature = elevProp
        ? resolveFeatureElevations(
            binary,
            elevProp,
            this.props.elevationMapping,
            this.props.elevationScale ?? 1,
          )
        : null;
      if (zPerFeature) {
        pathAttr = {
          value: buildElevatedPositions(
            binary.positions,
            srcDims,
            binary.startIndices,
            binary.featureCount,
            totalVerts,
            zPerFeature,
          ),
          size: 3,
        };
        memo.elevatedPath = { sig: elevSig, attr: pathAttr };
      } else {
        // Flat: one shared zero-copy descriptor over the tile's own buffer.
        pathAttr = memo.flatPath ??= { value: binary.positions, size: srcDims };
      }
    }
    const dims = pathAttr.size;

    const attributes: PreparedTile['data']['attributes'] = {
      // Accessor-name key for PathLayer's own attribute.
      getPath: pathAttr,
      // Extension-registered attribute names: must match
      // TimeFilterExtension.initializeState exactly. EXPANDED PER-VERTEX (not
      // per-feature) — PathLayer instances are SEGMENTS, so a per-feature buffer
      // under-sizes the instanced draw on multi-vertex paths ("vertex buffer is
      // not big enough" on ANGLE/Metal). Short lines happened to work because
      // segments≈features; dense contours / long lane lines do not.
      instanceStartTime: (memo.startTime ??= {
        value: expandFeatureScalarToVertex(
          binary.startTimes,
          binary.startIndices,
          binary.featureCount,
          totalVerts,
        ),
        size: 1,
      }),
      instanceEndTime: (memo.endTime ??= {
        value: expandFeatureScalarToVertex(
          binary.endTimes,
          binary.startIndices,
          binary.featureCount,
          totalVerts,
        ),
        size: 1,
      }),
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
    // reveal prop is off (or reduced motion suppresses it). Memoized per tile:
    // `synthesizeVertexTimes` is an O(totalVerts) haversine sweep, and reveal
    // mode composes with palettes/mappings that re-prepare the tile.
    if (this.revealActive()) {
      attributes.instanceVertexTime = memo.vertexTime ??= {
        value:
          binary.vertexTimestamps &&
          binary.vertexTimestamps.length >= totalVerts
            ? binary.vertexTimestamps
            : synthesizeVertexTimes(binary),
        size: 1,
      };
    }

    // Categorical color: resolve each feature's color on the CPU and expand it
    // PER-VERTEX into `getColor`. The GPU CategoryColorExtension path uploads a
    // per-FEATURE `instanceCategoryIndex`, which under-sizes the instanced draw
    // for multi-vertex paths exactly like the time attributes above — `getColor`
    // is a native PathLayer accessor its tessellator maps onto segment instances.
    // Mirrors AnimatedTripsLayer. This is the ONLY categorical-color path here,
    // which is why the extension is not installed at all (see
    // `timeFilterExtension`). Genuinely style-dependent, so it is NOT memoized.
    if (colorProp) {
      const cat = binary.categoricalProps[colorProp];
      if (cat) {
        // Explicit colorMapping wins over colorPalette: project the string→color
        // map onto THIS tile's category dictionary so the same category renders
        // the same color in every tile (stable), unlike colorPalette's
        // first-seen per-tile index assignment.
        const mappingFallback =
          this.props.colorMappingDefault ?? DEFAULT_MAPPING_DEFAULT;
        const palette = this.props.colorMapping
          ? paletteFromMapping(
              cat.categories,
              this.props.colorMapping,
              mappingFallback,
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
            mappingFallback,
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
        // Keyed by column name in the memo: the expansion depends only on the
        // tile and that name, never on the palette.
        if (memo.width?.prop !== widthProp) {
          const widthValues =
            values instanceof Float32Array ? values : new Float32Array(values);
          memo.width = {
            prop: widthProp,
            attr: {
              value: expandFeatureScalarToVertex(
                widthValues,
                binary.startIndices,
                binary.featureCount,
                totalVerts,
              ),
              size: 1,
            },
          };
        }
        attributes.getWidth = memo.width.attr;
      }
    }

    // Column range filter (STTDataFilterExtension). The value is per-FEATURE, but —
    // exactly like the time attributes above — PathLayer instances are SEGMENTS,
    // so a per-feature buffer under-sizes the instanced draw on multi-vertex
    // paths ("vertex buffer is not big enough" on ANGLE/Metal). Expand it
    // per-VERTEX; every vertex of a path shares its feature's value. Absent
    // column ⇒ no attribute → the sublayer idles the filter for this tile. A
    // categorical column can't be range-filtered in v1 — warn once.
    if (filterProp) {
      const values = binary.numericProps[filterProp];
      if (values) {
        // Memoized by column name for the same reason as `getWidth` above: the
        // per-vertex expansion is a function of the tile, not of the style. The
        // filter RANGE is a uniform and never touches this buffer.
        if (memo.filter?.prop !== filterProp) {
          const filterValues =
            values instanceof Float32Array ? values : new Float32Array(values);
          memo.filter = {
            prop: filterProp,
            attr: {
              value: expandFeatureScalarToVertex(
                filterValues,
                binary.startIndices,
                binary.featureCount,
                totalVerts,
              ),
              size: 1,
            },
          };
        }
        attributes.filterValue = memo.filter.attr;
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
      tile,
      features: binary,
    };
    this.preparedTileCache.set(tileKey, prepared);
    emit('tilePrepare', {
      layer: 'AnimatedPathLayer',
      tileKey,
      cached: false,
      features: binary.featureCount,
      ms: performance.now() - t0,
    });
    return prepared;
  }

  private buildSublayer(prepared: PreparedTile): PathLayer {
    const colorValue = this.colorValue();
    const widthValue = this.widthValue();
    // Fallbacks for a COLUMN-NAME-valued prop on a tile that didn't bake the
    // column: the documented defaults, so one layer never renders two different
    // "no data" widths across a partially-baked dataset.
    const constColor = (
      Array.isArray(colorValue) ? colorValue : DEFAULT_PATH_COLOR
    ) as Color;
    const constWidth =
      typeof widthValue === 'number' ? widthValue : DEFAULT_PATH_WIDTH;
    // `Required<>`-typed: the defaultProps value guarantees a number here.
    const timeWindow = this.props.timeWindow;

    // Column range filter — install STTDataFilterExtension only when a column is
    // named (per-layer constant ⇒ stable list). `hasFilter` gates the per-tile
    // enable so a tile missing the column renders unfiltered.
    const filterProp = this.filterPropertyValue();
    const hasFilter = !!prepared.data.attributes.filterValue;

    // Keep the extension list constant across sublayers — see
    // animated-trips-layer.ts for the cache-storm rationale. User extensions
    // from the top-level `extensions` prop are appended (composeExtensions).
    // The CategoryColorExtension is deliberately absent (see the
    // `timeFilterExtension` field docstring): it could never fire on this
    // family, but its `initializeState` registers `instanceCategoryIndex` and
    // injects the matching `in` declaration unconditionally, so carrying it cost
    // a real slot out of WebGL2's 16.
    const extensions = this.composeExtensions(
      filterProp
        ? [this.timeFilterExtension, this.dataFilterExtension]
        : [this.timeFilterExtension],
    );

    // Path topology. `'loop'` closes the ring joint at the seam instead of
    // capping it, but with binary data the tessellator takes the caller's
    // `startIndices` verbatim and expects the +2 wrap vertices to be present
    // already — check the tile's own buffers and say so precisely when they
    // aren't, rather than shipping a mis-capped final segment.
    const pathType = this.props.pathType ?? 'open';
    if (
      pathType === 'loop' &&
      !hasLoopPadding(
        prepared.data.attributes.getPath.value,
        prepared.dims,
        prepared.data.startIndices,
        prepared.data.length,
      )
    ) {
      warnOnce(
        'AnimatedPathLayer:loopPaddingMissing',
        "[AnimatedPathLayer] pathType:'loop' needs each feature's vertex run to " +
          'END with a repeat of its FIRST TWO vertices (deck.gl tessellates a ' +
          'closed path as numPoints + 2 and, on binary data, never synthesizes ' +
          'that padding). This archive does not carry it, so the last segment of ' +
          "every ring renders short and mis-capped. Use pathType:'open', or " +
          'rebuild the archive with the wrap vertices baked in.',
      );
    }

    // Class choice is part of the sublayer IDENTITY, not just its props: deck
    // matches a new layer to an old one by id ALONE and then calls
    // `_transferState` + `_update`, never `_initialize`. A `pickable` flip
    // therefore hands the stripped NoPickingPathLayer's transferred state (its
    // AttributeManager, minus the `instancePickingColors` its `initializeState`
    // removed) to a stock PathLayer, whose `updateState` only rebuilds the model
    // on `extensionsChanged` — so the null-picking-colour shader stays compiled
    // and picking is dead for the life of the layer (and the mirror image on the
    // reverse flip). Folding the class into the id makes the swap a REPLACEMENT,
    // which runs `_initialize` and gets a correct pipeline either way. Derived
    // from the resolved class, so a `_subLayerProps.paths.type` override — the
    // same class in both branches — keeps a stable id.
    const SubLayerClass = this.getSubLayerClass(
      'paths',
      this.props.pickable ? PathLayer : NoPickingPathLayer,
    );
    const instanceKey = `${prepared.tileKey}:${
      SubLayerClass === NoPickingPathLayer ? 'np' : 'pk'
    }`;

    // getSubLayerProps inheritance (opacity/pickable/visible, coordinate
    // system, highlight props, …) + user `_subLayerProps.paths` overrides.
    // Only runs inside this cache-gated build path — never per frame.
    // NOTE no `positionFormat`: PathLayer derives the geometry stride from
    // `data.attributes.getPath.size` and only falls back to `positionFormat`
    // when the descriptor carries no `size` (`Tesselator.updateGeometry`) — and
    // this layer always sets it. Passing it was inert.
    const props = this.composeSubLayerProps('paths', instanceKey, {
      data: prepared.data,
      // Identity comparator pairs with the preparedTileCache: deck.gl skips
      // the entire prop-diff for `data` when the same object reference
      // comes back.
      dataComparator: (a: any, b: any) => a === b,
      _pathType: pathType,
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

      // STTDataFilterExtension wiring (only when a filterProperty is set). The
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
    // produced silently-broken picking (zeroed picking colors). The picked
    // instance index is the path index within the tile; getPickingInfo decodes
    // its properties from there. Non-pickable sublayers take the stripped
    // subclass, which reclaims that slot — with the CategoryColorExtension gone
    // the four combinations sit at 15 (default), 16 (filter), 16 (pickable) and
    // 17 (filter + pickable); only the last one exceeds WebGL2's guaranteed
    // 16-slot floor, so that is the only case worth warning about. See
    // `no-picking-path-layer.ts` and the `filterProperty` prop docs.
    if (this.props.pickable && filterProp) {
      warnOnce(
        'AnimatedPathLayer:pickableAttributeBudget',
        '[AnimatedPathLayer] pickable:true + filterProperty needs 17 vertex ' +
          'attributes (stock PathLayer 13 + time 3 + filterValue 1), one past ' +
          "WebGL2's guaranteed 16 — the pipeline can fail to link (blank paths) " +
          'on GPUs that report exactly 16. Drop one of the two, or filter with ' +
          'AnimatedPointLayer, where the budget is roomy.',
      );
    }
    return new SubLayerClass(props as any);
  }
}

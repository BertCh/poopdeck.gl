// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * AnimatedPolygonLayer - GPU-filtered polygon rendering with time windowing.
 *
 * ARCHITECTURE (v3 - GPU time filtering, per-tile sublayers):
 * - One SolidPolygonLayer per (tile, layer). Same pattern as
 *   AnimatedPath/Trips/Point layers.
 * - Time filtering lifted to the GPU via the shared TimeFilterExtension. The
 *   previous CPU pass (`getVisibleFeatureIndices` + `extractVisiblePolygons`)
 *   ran every render, scaled O(featureCount × renderRate), and at 100k
 *   polygons dominated the frame budget. With this extension polygons are
 *   uploaded ONCE per tile and time-window changes only update uniforms.
 * - Categorical fill colors lift to the GPU via CategoryColorExtension —
 *   same wiring as the other animated layers.
 * - PER-VERTEX EXPANSION: SolidPolygonLayer's fill model is NON-instanced, so
 *   the extension attributes (stepMode 'dynamic') resolve to 'vertex' there
 *   and the binary `data.attributes` buffers must carry ONE VALUE PER VERTEX.
 *   deck.gl does NOT expand per-feature buffers supplied by attribute name
 *   (`Attribute.setExternalBuffer` binds them verbatim; the
 *   `setBinaryValue`/startIndices expansion path is bypassed whenever the
 *   tile's startIndices are the very ref the tesselator adopted, which is
 *   always the case with `_normalize: false`). prepareTile therefore expands
 *   start/end times and category indices across each feature's vertex range
 *   once per tile — see expandPerVertex.
 * - Per-tile timeOffset on each sublayer (no layer-wide rebasing).
 * - dataComparator: (a, b) => a === b lets deck.gl short-circuit prop diff
 *   when the cached prepared data ref is unchanged.
 *
 * TILE SEAMS: `stt-build` clips polygon coverage to each tile rect exactly
 * (`polygon_buffer_degrees: 0`), so a polygon spanning a boundary arrives as
 * two pieces whose FILLS abut watertight — flat fills show no seam. What did
 * show was extrusion: SolidPolygonLayer grows a side wall on every ring edge,
 * including the synthetic edges the clipper laid along the tile boundary, so
 * an extruded fill drew a full-height curtain along every tile edge its shape
 * crossed and the tile grid read straight through the surface. prepareTile now
 * supplies `instanceVertexValid` itself (see {@link computePolygonWallMask}),
 * masking walls on tile-cut edges and on ring closures — the latter also kills
 * the wall deck otherwise stitched from the end of a polygon's exterior to the
 * start of its first hole. `seamWalls: true` restores deck's raw behaviour.
 *
 * EXTRUSION FLOOR: the same shader line that walls seams (`pos.z += elevations
 * * elevationScale`) also anchors every extrusion to the ground, because STT
 * polygon geometry is 2D. A band whose elevation column describes a SURFACE in
 * the air — the storm-4d cloud-top canopy, 2–12 km up — therefore drew the
 * whole prism under it. `baseElevation` / `elevationThickness` give the
 * extrusion a floor: prepareTile synthesises a 3-wide position buffer (z =
 * floor × elevationScale, pre-scaled) and rewrites elevation to the thickness
 * above it, so the walls span exactly [floor, top]. Off by default — the
 * ground-anchored path keeps the zero-copy geometry.
 */

import { SolidPolygonLayer } from '@deck.gl/layers';
import type {
  Color,
  DefaultProps,
  Layer,
  LayerContext,
  Material,
} from '@deck.gl/core';
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
  appendNullCategorySlot,
  categoryIndicesToFloat32,
} from '../../extensions/category-color-extension.js';
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
import { DEFAULT_POLYGON_PALETTE } from '@poopdeck.gl/core';
import { computePolygonWallMask } from '@poopdeck.gl/core/geometry';
import type {
  Tile,
  Layer as TileLayer,
  BinaryFeatures,
} from '@poopdeck.gl/core';

const DEBUG = false;

/** Props added by {@link AnimatedPolygonLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link AnimatedPolygonLayerProps}). */
export interface _AnimatedPolygonLayerProps {
  /**
   * Fill the polygon.
   * @default true
   */
  filled?: boolean;

  /**
   * Fill color — constant {@link Color}, or column name for categorical coloring.
   * @default [255, 140, 0, 180]
   */
  fillColor?: Color | string;

  /**
   * Upstream-vocabulary alias of {@link fillColor}. NOTE: unlike upstream
   * deck.gl, this accepts a constant Color OR a property-column NAME — NOT
   * a function accessor (binary tiles can't run per-feature JS; a function
   * warns once and falls back to `fillColor`). When set, it wins over
   * `fillColor`.
   */
  getFillColor?: ColorAccessorValue | null;

  /** Color palette for the categorical `fillColor` path. */
  colorPalette?: Color[];

  /**
   * Explicit category-string → color map for the categorical `fillColor` path.
   * When set together with a string `fillColor`, each tile resolves its own
   * category dictionary through this map to build a per-tile palette, so a band
   * keeps the SAME color across tiles whose dictionaries differ in order or
   * subset. The bare `colorPalette` assigns colors by first-seen category index
   * and therefore drifts tile to tile — this is the only way to get stable
   * categorical fills. Categories absent from the map use `colorMappingDefault`.
   *
   * Unlike the point layer's `colorMapping` (a CPU per-feature RGBA expansion),
   * the polygon path stays on the GPU CategoryColorExtension: the mapping only
   * changes how the per-tile palette is built, not how it's sampled.
   */
  colorMapping?: Record<string, Color> | null;

  /** Fallback color for categories absent from `colorMapping`. @default transparent */
  colorMappingDefault?: Color;

  /**
   * Elevation — constant number, or property name.
   * @default 0
   */
  elevation?: number | string;

  /**
   * Upstream-vocabulary alias of {@link elevation}. Accepts a constant
   * number OR a property-column NAME — NOT a function accessor (a function
   * warns once and falls back to `elevation`). When set, it wins over
   * `elevation`.
   */
  getElevation?: NumericAccessorValue | null;

  /**
   * Extruded (3D) polygons.
   * @default false
   */
  extruded?: boolean;

  /**
   * Multiplier applied to every elevation value on the GPU (constant AND
   * column-driven) — SolidPolygonLayer pass-through. Only takes effect when
   * `extruded` is true.
   * @default 1
   */
  elevationScale?: number;

  /**
   * FLOOR of the extrusion, in the same metres as {@link elevation} — the
   * polygon FLOATS between this altitude and `elevation` instead of rising
   * out of the ground. Constant number, or a property-column name for a
   * per-feature floor.
   *
   * deck's `SolidPolygonLayer` extrudes from the polygon's own vertex z
   * (`pos.z += elevations * elevationScale`), and STT polygon geometry is 2D
   * (z = 0) — so an extruded band representing a sheet 12 km up hangs a
   * full-height curtain all the way down to the basemap. Setting a floor
   * synthesises the vertex z once per tile (pre-multiplied by
   * `elevationScale`, which the shader applies only to the thickness above
   * it), turning the prism into a slab at altitude.
   *
   * Only takes effect when `extruded` is true. When `stroked` is also on, the
   * outline rides the FLOOR plane with the fill.
   * @default 0 (ground)
   */
  baseElevation?: number | string;

  /**
   * Constant-thickness SHELL — the shorthand for data that carries only a TOP
   * surface (a cloud-top height, a sea-surface height, a canopy): extrude
   * DOWNWARD from {@link elevation} by this many metres, i.e. the floor is
   * `elevation - elevationThickness` per feature. Wins over
   * {@link baseElevation} when both are set; `0` leaves an infinitely thin
   * floating sheet (top face only, no walls).
   *
   * The difference from `baseElevation`: a constant `baseElevation` gives
   * every polygon the SAME floor (nested bands read as one terraced mesa),
   * while a thickness hugs each polygon's own top (nested bands read as
   * separate floating shelves you can see between). Only takes effect when
   * `extruded` is true.
   * @default null (off — extrude from `baseElevation`)
   */
  elevationThickness?: number | null;

  /**
   * Draw the edges of extruded polygons as a wireframe (sides + top outline)
   * — SolidPolygonLayer pass-through. Only takes effect when `extruded` is
   * true.
   * @default false
   */
  wireframe?: boolean;

  /**
   * Raise side walls on the SYNTHETIC edges the tiler laid along tile
   * boundaries when it clipped a polygon into per-tile pieces.
   *
   * Those edges are not part of the polygon, so extruding them draws a
   * full-height curtain along every tile boundary the shape crosses — the tile
   * grid printed through the surface. Default `false` suppresses them (and the
   * ring-closure walls deck would otherwise stitch across holes), leaving walls
   * only on real polygon edges; the abutting tile's piece continues the surface
   * across the seam. Set `true` for deck's raw `SolidPolygonLayer` behaviour —
   * e.g. a dataset whose polygons are genuinely tile-aligned cells and want
   * their boundary walls. Only takes effect when `extruded` is true.
   * @default false
   */
  seamWalls?: boolean;

  /**
   * Lighting material for extruded polygons — SolidPolygonLayer pass-through.
   * `true` for the default phong material, `false` to disable lighting, or a
   * material spec `{ambient, diffuse, shininess, specularColor}`.
   * @default true
   */
  material?: Material;

  /**
   * Draw the polygon-ring OUTLINES. Mirrors deck.gl's composite PolygonLayer,
   * which pairs a `SolidPolygonLayer` fill with a `PathLayer` stroke: when
   * `true`, this layer emits a SECOND sublayer per tile — an outline PathLayer
   * fed from the SAME baked ring `positions` + `startIndices` (zero extra
   * decode) and time-filtered in lock-step with the fill. `false` (the
   * default) is byte-identical to the fill-only render with zero extra cost —
   * no outline sublayer is constructed.
   *
   * The outline is styled by `getLineColor` / `getLineWidth` /
   * `lineWidthUnits` / `lineWidthMinPixels` / `lineJointRounded` /
   * `lineMiterLimit` / `lineDashJustified`.
   *
   * NOTE (tile-seam overdraw): like the fill, an outline whose polygon spans a
   * tile boundary double-draws along the seam (the ring is split across
   * sublayers). Accepted — same limitation documented for the fill.
   * @default false
   */
  stroked?: boolean;

  /**
   * Outline / wireframe color — a constant {@link Color}. Feeds BOTH the
   * `stroked` outline PathLayer AND the `wireframe:true` extruded-edge color
   * (`SolidPolygonLayer.getLineColor`), which otherwise stays locked at black.
   * Accepts a constant Color (the accessor-alias convention: a function warns
   * once and falls back to the deck default). @default [0, 0, 0, 255]
   */
  getLineColor?: ColorAccessorValue | null;

  /**
   * Outline width — a constant number, or a property-column NAME for
   * per-feature width. Only takes effect when `stroked` is true. Interpreted
   * in {@link lineWidthUnits} and clamped by {@link lineWidthMinPixels}.
   * A function accessor warns once and falls back to the constant default.
   * @default 1
   */
  getLineWidth?: NumericAccessorValue | null;

  /**
   * Units for {@link getLineWidth} — outline PathLayer pass-through. Deck's
   * composite PolygonLayer defaults to `'meters'`. @default 'meters'
   */
  lineWidthUnits?: 'pixels' | 'meters' | 'common';

  /**
   * Clamp the outline width to at least this many on-screen pixels so thin
   * borders stay visible at low zoom — outline PathLayer pass-through. Only
   * applies when `stroked` is true. @default 0
   */
  lineWidthMinPixels?: number;

  /**
   * Rounded outline joints — outline PathLayer pass-through
   * (`PathLayer.jointRounded`). Only applies when `stroked` is true.
   * @default false
   */
  lineJointRounded?: boolean;

  /**
   * Miter-joint length cap (multiples of line width) for the outline —
   * outline PathLayer pass-through (`PathLayer.miterLimit`), applies when
   * `lineJointRounded` is false. Only applies when `stroked` is true.
   * @default 4
   */
  lineMiterLimit?: number;

  /**
   * Justify outline dashes to segment endpoints — outline PathLayer
   * pass-through (`PathLayer.dashJustified`). Inert unless a `PathStyleExtension`
   * dash is also supplied via the top-level `extensions` prop; surfaced for
   * deck parity. Only applies when `stroked` is true. @default false
   */
  lineDashJustified?: boolean;

  /**
   * Tesselate XYZ (3D) polygons on their largest-area plane instead of
   * assuming the ground plane — `SolidPolygonLayer._full3d` pass-through.
   * @default false
   */
  _full3d?: boolean;

  /**
   * Fade-in duration (ms).
   * @default 500
   */
  fadeInDuration?: number;

  /**
   * Fade-out duration (ms).
   * @default 500
   */
  fadeOutDuration?: number;

  /**
   * Time-as-height ("space-time cube") lift, in METERS of altitude per
   * simulation millisecond — {@link TimeFilterExtension} pass-through. When
   * non-zero every polygon vertex is raised by
   * `(featureStartTime - timeHeightOrigin) * timeHeightScale` meters, so a
   * flat choropleth stands up into a stack whose height encodes each feature's
   * time. A single GPU uniform, so animating it (the flat-map ⇄ cube "squash"
   * morph) costs nothing per frame. Pairs with {@link timeHeightOrigin}
   * (inherited from the base props — the absolute time mapped to altitude 0).
   *
   * NOTE this is the WINDOW-mode lift: polygons rise by their per-feature start
   * time, not per vertex. Gated by {@link reducedMotion} (forced to 0 when the
   * viewer prefers reduced motion — the map stays flat).
   * @default 0 (off — byte-identical flat render)
   */
  timeHeightScale?: number;

  /**
   * Honor `prefers-reduced-motion`. When `true`, motion-amplifying surfaces
   * degrade gracefully: the {@link timeHeightScale} space-time-cube lift is
   * forced to 0 so the polygons stay flat (no rise / no squash morph). Time
   * playback + fades are unaffected. `false` (default) renders normally.
   * @default false
   */
  reducedMotion?: boolean;

  /**
   * GPU range filter — the NAME of a baked numeric column to filter polygons
   * by (installs {@link DataFilterExtension}). A polygon renders when its value
   * in this column is inside {@link filterRange}, else it is hidden (or
   * soft-faded via {@link filterSoftRange}). Composes WITH the time filter (a
   * polygon must pass both) and the categorical fill path. The per-feature
   * value is expanded per-vertex like the time attributes, so every vertex of a
   * polygon shares its feature's value and the polygon filters as a whole.
   *
   * Accessor-alias of deck.gl's `getFilterValue`: pass a column NAME, not a
   * function (STT tiles are binary — a function warns once and is ignored).
   * Unset (default) ⇒ the extension is not installed: zero attribute, zero
   * uniform, zero shader change. A categorical column can't be range-filtered
   * in v1 (warns once).
   * @default null
   */
  filterProperty?: WeightAccessorValue | null;

  /**
   * Inclusive `[min, max]` bounds for {@link filterProperty}. `null` (default)
   * idles the filter (renders all) while keeping the column bound, so a range
   * set later animates by uniform with no tile re-preparation. No effect unless
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
}

/** Complete props accepted by {@link AnimatedPolygonLayer}. */
export type AnimatedPolygonLayerProps = _AnimatedPolygonLayerProps &
  SpatioTemporalLayerProps;

// Shared with the maplibre adapter (single source of truth in
// @poopdeck.gl/core).
const DEFAULT_PALETTE: Color[] = DEFAULT_POLYGON_PALETTE;

/**
 * Per-tile prepared data. Cached so the `data` object reference handed to
 * SolidPolygonLayer is stable across renders — pairs with dataComparator
 * to short-circuit deck.gl's prop diff.
 */
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
  /**
   * Constant `getElevation` for the sublayer, or null when the tile carries a
   * per-vertex `getElevation` buffer (or no elevation at all, leaving deck's
   * own default). Resolved during prepare because the FLOATING-extrusion path
   * (see {@link _AnimatedPolygonLayerProps.baseElevation}) rewrites elevation
   * to a THICKNESS above the synthesised floor, which may collapse a
   * column-driven top to a constant.
   */
  elevationConstant: number | null;
  /** Resolved palette for the GPU categorical-color path, or null. */
  gpuPalette: Color[] | null;
  /**
   * True when the tile carried a pre-baked `triangles` index buffer (MLT
   * mode). Lets the sublayer construction path skip deck.gl's internal
   * PolygonTesselator (earcut) by setting `_normalize: false` and feeding
   * the indices directly through `data.attributes.indices`.
   */
  hasPreBakedTriangles: boolean;
  /**
   * PER-VERTEX outline widths for the `stroked` outline PathLayer, resolved
   * when `getLineWidth` is a property-column NAME. Null for constant widths
   * (the constant rides on the sublayer prop). Length = vertexCount.
   *
   * PathLayer draws SEGMENTS as instances, and with binary `data` +
   * `_pathType:'loop'` its tessellator sets numInstances to the total
   * ring-vertex count (the startIndices sentinel), NOT featureCount. Because
   * deck.gl binds a buffer supplied by attribute name verbatim (the
   * startIndices auto-expansion path is bypassed when the tile's startIndices
   * are the very ref the tessellator adopted — always the case here), a
   * per-FEATURE buffer under-sizes the instanced draw and throws "vertex
   * buffer is not big enough" on ANGLE/Metal. So this is expanded per-vertex
   * exactly like the fill's time / elevation attributes — see expandPerVertex.
   */
  outlineWidths: Float32Array | null;
  /** Source tile + decoded columns — picking enrichment context (references, not copies). */
  tile: Tile;
  features: BinaryFeatures;
}

function makeTileKey(tile: Tile, layer: TileLayer): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}:${layer.name}`;
}

/**
 * Expand a per-FEATURE value array to per-VERTEX for SolidPolygonLayer.
 *
 * The fill model is non-instanced, so every extension attribute (stepMode
 * 'dynamic' → 'vertex' there) consumes one value per vertex. deck.gl binds
 * binary buffers supplied by attribute name verbatim (no startIndices
 * expansion — see the module docstring), so the layer must do the expansion
 * itself: all vertices of feature i carry value[i]. Runs once per tile prep
 * and is cached in PreparedTile, so it is NOT on the draw path.
 */
function expandPerVertex(
  values: ArrayLike<number>,
  startIndices: Uint32Array,
  featureCount: number,
  vertexCount: number,
): Float32Array {
  const out = new Float32Array(vertexCount);
  for (let f = 0; f < featureCount; f++) {
    const start = startIndices[f];
    // startIndices carries a trailing sentinel (= vertexCount) by the deck.gl
    // binary convention; fall back to vertexCount if a producer omits it.
    const end = f + 1 < startIndices.length ? startIndices[f + 1] : vertexCount;
    out.fill(values[f], start, end);
  }
  return out;
}

/**
 * Animated polygon layer with GPU time filtering and per-tile sublayers.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`polygons`**.
 * `_subLayerProps: { polygons: { type: MyLayer, ...props } }` swaps the
 * sublayer class (default `SolidPolygonLayer`) / overrides sublayer props
 * (deck's CompositeLayer contract).
 */
export class AnimatedPolygonLayer<
  ExtraPropsT extends {} = {},
> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_AnimatedPolygonLayerProps>
> {
  static layerName = 'AnimatedPolygonLayer';

  static defaultProps: DefaultProps<AnimatedPolygonLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    filled: true,
    // Permissive descriptor ({type:'object'} validates anything): fillColor
    // legally holds a constant OR a column-name string, which the 'color'
    // validator would reject in deck's debug mode.
    fillColor: { type: 'object', value: [255, 140, 0, 180], compare: true },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE, compare: true },
    // Object-valued mapping — compare:false (digest content via styleKey). The
    // transparent default drops categories the caller didn't map, matching the
    // point layer.
    colorMapping: {
      type: 'object',
      value: null,
      optional: true,
      compare: false,
    },
    colorMappingDefault: { type: 'color', value: [0, 0, 0, 0] },
    elevation: { type: 'object', value: 0, compare: true },
    // Accessor-named aliases (see the prop docs): unset by default so the
    // legacy props win unless the caller opts into the upstream vocabulary.
    getFillColor: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    getElevation: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    extruded: false,
    elevationScale: { type: 'number', value: 1, min: 0 },
    // Permissive descriptor: constant metres OR a column name (same domain as
    // `elevation`). 0 keeps the ground-anchored render byte-identical.
    baseElevation: { type: 'object', value: 0, compare: true },
    elevationThickness: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    wireframe: false,
    seamWalls: false,
    // Same permissive descriptor SolidPolygonLayer uses: boolean or material spec.
    material: { type: 'object', value: true, compare: true },
    // Outline subsystem (deck PolygonLayer parity). Off by default → the
    // fill-only render is byte-identical and pays zero extra cost.
    stroked: false,
    // Permissive descriptor ({type:'object'}): getLineColor holds a constant
    // Color (the 'color' validator would reject a function/column string in
    // deck's debug mode). Default = deck SolidPolygonLayer's black edge color.
    getLineColor: { type: 'object', value: [0, 0, 0, 255], compare: true },
    // Constant OR column name — permissive descriptor. Default matches deck
    // PolygonLayer's getLineWidth.
    getLineWidth: { type: 'object', value: 1, compare: true },
    lineWidthUnits: 'meters',
    lineWidthMinPixels: { type: 'number', value: 0, min: 0 },
    lineJointRounded: false,
    lineMiterLimit: { type: 'number', value: 4, min: 0 },
    lineDashJustified: false,
    _full3d: false,
    fadeInDuration: { type: 'number', value: 500, min: 0 },
    fadeOutDuration: { type: 'number', value: 500, min: 0 },
    // Space-time-cube lift. 0 (off) keeps the flat render byte-identical.
    // timeHeightOrigin is inherited from SpatioTemporalLayer.defaultProps.
    timeHeightScale: { type: 'number', value: 0 },
    reducedMotion: false,
    // Column range filter (DataFilterExtension). Unset ⇒ not installed.
    // Permissive {type:'object'} descriptors: these hold a column-name string /
    // [min,max] tuple / null, which the 'array'/'accessor' validators would
    // reject in deck's debug mode (see the path layer).
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
  };

  /** Per-tile prepared-data cache. Pruned to the live tile set each render. */
  private preparedTileCache = new Map<string, PreparedTile>();

  /**
   * Per-tile sublayer-instance cache. Mirrors the other animated layers'
   * pattern: returning the SAME SolidPolygonLayer reference per tile across
   * renderLayers() lets deck.gl short-circuit prop diff entirely.
   */
  private sublayerCache = new Map<
    string,
    { layers: Layer[]; preparedKey: PreparedTile; layerPropsKey: string }
  >();

  /** Digest of every prop baked into a sublayer at construction. */
  private lastLayerPropsKey: string = '';
  /** Tile-array identity from the previous render — see AnimatedTripsLayer.lastTilesRef. */
  private lastTilesRef: Tile[] | null = null;

  /** Singleton extensions, reused by every sublayer (stateless w.r.t. data). */
  private readonly timeFilterExtension = new TimeFilterExtension({
    mode: 'window',
  });
  private readonly categoryColorExtension = new CategoryColorExtension();
  /**
   * Singleton DataFilterExtension, composed into the sublayer extension list
   * only when `filterProperty` is set (per-layer constant ⇒ stable list, so the
   * shader-cache contract holds). SolidPolygonLayer's non-instanced fill has a
   * roomy attribute budget, so it composes ALONGSIDE the time + category
   * extensions (unlike the tight PathLayer family, which must drop one).
   */
  private readonly dataFilterExtension = new DataFilterExtension({
    filterSize: 1,
  });

  /** Stable getTime; preserved across renders to keep prop refs stable. */
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
  private fillColorValue(): Color | string | undefined {
    return resolveAccessorAlias(
      'AnimatedPolygonLayer',
      'getFillColor',
      this.props.getFillColor,
      this.props.fillColor,
    );
  }

  private elevationValue(): number | string | undefined {
    return resolveAccessorAlias(
      'AnimatedPolygonLayer',
      'getElevation',
      this.props.getElevation,
      this.props.elevation,
    );
  }

  /**
   * Resolve the FLOATING-extrusion request (see `baseElevation` /
   * `elevationThickness`), or null when the polygons rise from the ground —
   * the default, in which case the prepare path stays byte-identical and the
   * tile geometry rides to the GPU zero-copy.
   *
   * `thickness` wins over `base` when both are set (documented precedence).
   */
  private floorSpec():
    | { thickness: number }
    | { base: number | string }
    | null {
    if (!this.props.extruded) return null;
    const thickness = this.props.elevationThickness;
    if (typeof thickness === 'number' && Number.isFinite(thickness)) {
      // Clamped: a negative thickness would put the floor ABOVE the top and
      // invert every wall.
      return { thickness: Math.max(0, thickness) };
    }
    const base = this.props.baseElevation;
    if (typeof base === 'string' && base) return { base };
    if (typeof base === 'number' && base !== 0) return { base };
    return null;
  }

  /**
   * Resolve the constant outline / wireframe color. Constant-only (accessor
   * alias): a function warns once and falls back to deck's black edge default.
   * Used by both the `wireframe:true` fill edges and the `stroked` outline.
   */
  private lineColorValue(): Color {
    return resolveAccessorAlias(
      'AnimatedPolygonLayer',
      'getLineColor',
      this.props.getLineColor as Color | undefined,
      [0, 0, 0, 255] as Color,
    );
  }

  /**
   * Resolve the outline width — a constant number OR a property-column name.
   * A function warns once and falls back to the constant default (1).
   */
  private lineWidthValue(): number | string | undefined {
    return resolveAccessorAlias<number | string>(
      'AnimatedPolygonLayer',
      'getLineWidth',
      this.props.getLineWidth,
      1,
    );
  }

  /**
   * Resolve `filterProperty` to a baked-column NAME (accessor-alias of deck's
   * `getFilterValue`; a function warns once and is ignored — no legacy prop, so
   * the fallback is "no filter").
   */
  private filterPropertyValue(): string | undefined {
    return resolveAccessorAlias<string | undefined>(
      'AnimatedPolygonLayer',
      'filterProperty',
      this.props.filterProperty,
      undefined,
    );
  }

  /**
   * Effective space-time-cube lift. `reducedMotion` forces it to 0 so the
   * polygons stay flat for viewers who prefer reduced motion (no rise, no
   * squash morph); otherwise the caller's `timeHeightScale` rides through.
   */
  private effectiveTimeHeightScale(): number {
    return this.props.reducedMotion ? 0 : this.props.timeHeightScale;
  }

  private computeLayerPropsKey(): string {
    const fillColor = this.fillColorValue();
    const elevation = this.elevationValue();
    const lineColor = this.lineColorValue();
    const lineWidth = this.lineWidthValue();
    return [
      this.props.filled,
      this.props.extruded,
      this.props.elevationScale,
      this.props.wireframe,
      this.props._full3d,
      structuralDigest(this.props.material),
      typeof elevation === 'number' ? elevation : 0,
      // Composite props that getSubLayerProps bakes into every sublayer
      // (opacity/pickable/visible, coordinate system, _subLayerProps, …)
      // plus the user's updateTriggers.
      inheritedPropsDigest(this.props),
      updateTriggersDigest(this.props.updateTriggers),
      this.props.timeWindow,
      this.props.fadeInDuration,
      this.props.fadeOutDuration,
      // Space-time-cube lift — uniform-only, so a scale/origin/reduced-motion
      // edit rebuilds the cached sublayers (whose props carry the values)
      // rather than re-preparing tiles, like timeWindow above.
      this.effectiveTimeHeightScale(),
      this.props.timeHeightOrigin,
      this.props.reducedMotion,
      // Column-filter uniforms (DataFilterExtension) — a range/enabled edit is
      // uniform-only; same rebuild-not-reprepare rationale as timeWindow.
      Array.isArray(this.props.filterRange)
        ? this.props.filterRange.join(',')
        : '',
      Array.isArray(this.props.filterSoftRange)
        ? this.props.filterSoftRange.join(',')
        : '',
      this.props.filterEnabled,
      // fillColor constant branch only; categorical branch lives in `prepared`.
      Array.isArray(fillColor) ? fillColor.join(',') : '',
      // Outline subsystem — toggling any of these rebuilds the cached sublayers
      // (fill edge color + the whole outline PathLayer).
      this.props.stroked,
      Array.isArray(lineColor) ? lineColor.join(',') : '',
      typeof lineWidth === 'number' ? lineWidth : 0,
      this.props.lineWidthUnits,
      this.props.lineWidthMinPixels,
      this.props.lineJointRounded,
      this.props.lineMiterLimit,
      this.props.lineDashJustified,
    ].join('|');
  }

  renderLayers(): Layer[] {
    const t0 = performance.now();
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) {
      // No setState here — the empty result is itself the signal to deck.gl
      // that the previous sublayers should unmount.
      this.preparedTileCache.clear();
      this.sublayerCache.clear();
      this.lastTilesRef = null;
      return [];
    }

    // Skip O(cacheSize) prune walks when the tile-array ref is unchanged.
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
          for (const l of cached.layers) sublayers.push(l);
          continue;
        }
        // Fill first (draws under the outline), then the optional stroke.
        const layers: Layer[] = [this.buildSublayer(prepared)];
        if (this.props.stroked) {
          const outline = this.buildOutlineSublayer(prepared);
          if (outline) layers.push(outline);
        }
        this.sublayerCache.set(prepared.tileKey, {
          layers,
          preparedKey: prepared,
          layerPropsKey,
        });
        for (const l of layers) sublayers.push(l);
      }
    }

    emit('renderLayers', {
      layer: 'AnimatedPolygonLayer',
      tiles: tiles.length,
      sublayers: sublayers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `AnimatedPolygonLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`,
      );
    }
    return sublayers;
  }

  private prepareTile(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0 || !binary.startIndices) return null;

    const fillColorValue = this.fillColorValue();
    const elevationValue = this.elevationValue();
    const lineWidthValue = this.lineWidthValue();
    const fillColorProp =
      typeof fillColorValue === 'string' ? fillColorValue : '';
    const elevationProp =
      typeof elevationValue === 'string' ? elevationValue : '';
    // Property-column name for a per-feature outline width (else '').
    const lineWidthProp =
      typeof lineWidthValue === 'string' ? lineWidthValue : '';
    // Property-column name for the DataFilterExtension range filter (else '').
    const filterProp = this.filterPropertyValue() ?? '';
    // Palette keyed by CONTENT (memoized digest), not length — matches the
    // sibling layers' stale-key fix. updateTriggers ride the key so a user
    // trigger bump re-prepares the tile.
    // colorMappingDefault feeds both palette modes (unmapped categories and
    // the appended NULL slot), so it must invalidate prepared tiles too.
    const mapDefault = (this.props.colorMappingDefault ?? [0, 0, 0, 0]).join(
      ',',
    );
    // filterProp rides the styleKey (covers the unset↔set toggle that
    // adds/removes the per-vertex `filterValue` buffer). The RANGE/enabled are
    // uniform-only and live in the layerPropsKey instead.
    const filterSig = filterProp ? `f${filterProp}` : '';
    // The side-wall mask is baked into the tile's attributes, so both switches
    // that decide whether it exists must invalidate the prepared tile.
    const wallSig = `w${this.props.extruded ? 1 : 0}${this.props.seamWalls ? 1 : 0}`;
    // Floating extrusion bakes the FLOOR into the tile's vertex z, and bakes it
    // PRE-SCALED (the shader multiplies only the thickness above it) — so
    // elevationScale, normally a live uniform, has to invalidate the prepared
    // tile too. Only while floating: the ground-anchored path keeps its
    // uniform-only scale.
    // A CONSTANT elevation is baked into that floor too (top − thickness), so
    // it joins the key here; without a floor it stays a sublayer prop and rides
    // the layerPropsKey as before.
    const floor = this.floorSpec();
    const floorSig = floor
      ? `z${'thickness' in floor ? `t${floor.thickness}` : `b${floor.base}`}` +
        `s${this.props.elevationScale}` +
        `e${typeof elevationValue === 'number' ? elevationValue : ''}`
      : '';
    const styleKey = `${fillColorProp}|${elevationProp}|${lineWidthProp}|${filterSig}|${wallSig}|${floorSig}|${
      fillColorProp
        ? this.props.colorMapping
          ? `m${colorMappingDigest(this.props.colorMapping)}`
          : colorListDigest(this.props.colorPalette ?? DEFAULT_PALETTE)
        : 0
    }|d${mapDefault}|${updateTriggersDigest(this.props.updateTriggers)}`;

    const tileKey = makeTileKey(tile, tileLayer);
    const cached = this.preparedTileCache.get(tileKey);
    if (cached && cached.styleKey === styleKey) {
      emit('tilePrepare', {
        layer: 'AnimatedPolygonLayer',
        tileKey,
        cached: true,
        ms: 0,
      });
      return cached;
    }

    const t0 = performance.now();
    const dims = binary.positionDimensions ?? 2;
    const featureCount = binary.featureCount;
    const vertexCount = binary.positions.length / dims;
    const startIndices = binary.startIndices;

    // Positions and startIndices ride zero-copy straight from the
    // Arrow-backed tile buffers to the GPU. The per-feature scalar columns
    // (times, category index, elevation) must be expanded to PER-VERTEX
    // because SolidPolygonLayer's fill model is non-instanced — see the
    // module docstring and expandPerVertex. One expansion pass per tile
    // prep, cached in PreparedTile; still strictly cheaper than the v2 path,
    // which re-allocated `positions` + `startIndices` via
    // extractVisiblePolygons() on EVERY render.
    const attributes: PreparedTile['data']['attributes'] = {
      // SolidPolygonLayer's geometry accessor — keyed by accessor name.
      getPolygon: { value: binary.positions, size: dims },
      // TimeFilterExtension attribute names (shared with the other animated
      // layers); per-vertex-expanded for the non-instanced polygon model.
      instanceStartTime: {
        value: expandPerVertex(
          binary.startTimes,
          startIndices,
          featureCount,
          vertexCount,
        ),
        size: 1,
      },
      instanceEndTime: {
        value: expandPerVertex(
          binary.endTimes,
          startIndices,
          featureCount,
          vertexCount,
        ),
        size: 1,
      },
    };

    let gpuPalette: Color[] | null = null;
    if (fillColorProp) {
      const cat = binary.categoricalProps[fillColorProp];
      if (cat) {
        // With a colorMapping, resolve THIS tile's category dictionary into a
        // per-tile palette (palette[i] = mapping[categories[i]]) so the shader,
        // which samples palette[categoryIndex], yields a stable per-string color
        // regardless of the tile's dictionary order. Without one, fall back to
        // the single global palette (colors then follow first-seen index).
        const mapping = this.props.colorMapping;
        const basePalette = mapping
          ? cat.categories.map(
              (c) =>
                mapping[c] ??
                this.props.colorMappingDefault ??
                ([0, 0, 0, 0] as Color),
            )
          : (this.props.colorPalette ?? DEFAULT_PALETTE);
        // Redirect NULL (0xffff) per-FEATURE indices onto the appended default
        // slot BEFORE the per-vertex expansion, so NULL polygons render the
        // default color instead of masquerading as the last dictionary entry.
        attributes.instanceCategoryIndex = {
          value: expandPerVertex(
            categoryIndicesToFloat32(
              cat.indices,
              featureCount,
              basePalette.length,
              'AnimatedPolygonLayer',
            ),
            startIndices,
            featureCount,
            vertexCount,
          ),
          size: 1,
        };
        gpuPalette = appendNullCategorySlot(
          basePalette,
          this.props.colorMappingDefault as Color | undefined,
        );
      }
    }

    if (elevationProp) {
      const values = binary.numericProps[elevationProp];
      if (values) {
        // Same per-vertex contract as the time attributes: SolidPolygonLayer's
        // own `elevations` attribute is vertex-stepped on the fill model and
        // deck binds this buffer verbatim.
        attributes.getElevation = {
          value: expandPerVertex(
            values,
            startIndices,
            featureCount,
            vertexCount,
          ),
          size: 1,
        };
      }
    }
    // Constant elevation for the sublayer prop (null ⇒ the per-vertex buffer
    // above, or deck's own default when neither is present). The floating
    // branch below may rewrite it.
    let elevationConstant =
      typeof elevationValue === 'number' ? elevationValue : null;
    let outDims = dims;

    // FLOATING EXTRUSION ---------------------------------------------------
    // SolidPolygonLayer's shader is `pos.z += elevations * elevationScale`:
    // the polygon's own vertex z is the extrusion FLOOR and `elevations` is
    // only the thickness stacked above it. STT polygon geometry is 2D (z = 0),
    // so an extruded band whose elevation column says "12 km up" draws a
    // curtain from the basemap all the way to 12 km — the whole prism, not the
    // sheet the data describes. When a floor is requested we synthesise a
    // 3-wide position buffer ONCE per tile (XY copied from the tile geometry,
    // z = floor × elevationScale — pre-scaled, because the shader scales only
    // the thickness) and rewrite elevation to `top − floor`, so the walls span
    // exactly [floor, top] and the polygon reads as a slab at altitude.
    //
    // Costs 1.5× the position buffer per tile, once, and only for layers that
    // opt in; everything else keeps the zero-copy geometry path.
    if (floor) {
      const topPerVertex =
        (attributes.getElevation?.value as Float32Array | undefined) ?? null;
      const constTop = typeof elevationValue === 'number' ? elevationValue : 0;
      // An elevation COLUMN this tile doesn't carry leaves no altitude to hang
      // the shell from — `constTop` is a placeholder 0, not a real top.
      const hasTop =
        topPerVertex !== null || typeof elevationValue === 'number';

      // Per-vertex floor, or a constant when nothing varies per feature.
      let floorPerVertex: Float32Array | null = null;
      let constFloor = 0;
      if ('thickness' in floor) {
        if (topPerVertex) {
          floorPerVertex = new Float32Array(vertexCount);
          for (let i = 0; i < vertexCount; i++) {
            floorPerVertex[i] = topPerVertex[i] - floor.thickness;
          }
        } else if (hasTop) {
          // Clamped: a shell thicker than its own constant top would otherwise
          // hang below the basemap.
          constFloor = Math.max(0, constTop - floor.thickness);
        }
        // No top at all ⇒ floor stays on the ground (a flat slab is a better
        // degradation than a shell buried under the map).
      } else if (typeof floor.base === 'string') {
        const values = binary.numericProps[floor.base];
        if (values) {
          floorPerVertex = expandPerVertex(
            values,
            startIndices,
            featureCount,
            vertexCount,
          );
        }
        // Column absent from this tile ⇒ constFloor stays 0 (ground) — the
        // same "missing column idles the feature" rule the other columns use.
      } else {
        constFloor = floor.base;
      }

      const src = binary.positions;
      const scale = this.props.elevationScale;
      const lifted = new Float64Array(vertexCount * 3);
      for (let i = 0, s = 0, d = 0; i < vertexCount; i++, s += dims, d += 3) {
        lifted[d] = src[s];
        lifted[d + 1] = src[s + 1];
        // Geometry-native z (3D polygon tiles, not emitted today) rides along
        // as an absolute metre offset on top of the requested floor.
        lifted[d + 2] =
          (floorPerVertex ? floorPerVertex[i] : constFloor) * scale +
          (dims > 2 ? src[s + 2] : 0);
      }
      attributes.getPolygon = { value: lifted, size: 3 };
      outDims = 3;

      // Elevation now means THICKNESS above the floor, never a total altitude.
      if ('thickness' in floor) {
        // Uniform by construction — drop the per-vertex buffer entirely.
        delete attributes.getElevation;
        // With a CONSTANT top the floor may have been clamped to the ground,
        // which thins the slab to whatever room was left under it.
        elevationConstant =
          !topPerVertex && hasTop ? constTop - constFloor : floor.thickness;
      } else if (topPerVertex) {
        const delta = new Float32Array(vertexCount);
        for (let i = 0; i < vertexCount; i++) {
          delta[i] = Math.max(
            0,
            topPerVertex[i] - (floorPerVertex ? floorPerVertex[i] : constFloor),
          );
        }
        attributes.getElevation = { value: delta, size: 1 };
        elevationConstant = null;
      } else {
        elevationConstant = Math.max(0, constTop - constFloor);
      }
    }

    // Side-wall mask. deck's own `instanceVertexValid` updater only knows
    // FEATURE boundaries here (the binary path has no hole indices), and knows
    // nothing about which edges the tiler synthesised when it clipped a polygon
    // to this tile's rect — so it walls the tile seams and bridges every hole.
    // Supplying the attribute by name short-circuits that updater with a mask
    // computed from the tile's own geometry (see the module docstring). Only
    // the extruded path consumes it: the top model excludes the attribute, and
    // without `extruded` deck builds no side/wireframe model at all.
    if (this.props.extruded && !this.props.seamWalls) {
      const wallMask = computePolygonWallMask(binary, tile.id);
      if (wallMask) {
        attributes.instanceVertexValid = { value: wallMask, size: 1 };
      }
    }

    // MLT-style pre-baked triangle indices. When the tile carries a
    // `triangles` sidecar (the Rust writer ran with `--pre-tessellate`),
    // we route it through deck.gl's `indices` binary attribute so the
    // PolygonTesselator skips its own earcut on tile arrival. Indices in
    // BinaryFeatures.triangles are already GLOBAL (the decoder applied
    // the per-feature `startIndices` shift), so no further translation is
    // needed here.
    const hasPreBakedTriangles =
      !!binary.triangles && binary.triangles.length > 0;
    if (hasPreBakedTriangles) {
      attributes.indices = { value: binary.triangles!, size: 1 };
    }

    // Per-vertex outline width column (stroked outline PathLayer). Only when
    // getLineWidth resolves to a property-column name that the tile carries.
    // Constant widths ride on the sublayer prop instead. Baked regardless of
    // `stroked` (a layer-level prop) so toggling stroked on reuses the cache.
    // EXPANDED PER-VERTEX (not per-feature): PathLayer's binary-mode
    // tessellator sizes the instanced draw to the total ring-vertex count, so a
    // per-feature buffer under-sizes it and throws on ANGLE/Metal — see the
    // PreparedTile.outlineWidths doc and expandPerVertex.
    let outlineWidths: Float32Array | null = null;
    if (lineWidthProp) {
      const values = binary.numericProps[lineWidthProp];
      if (values) {
        outlineWidths = expandPerVertex(
          values,
          startIndices,
          featureCount,
          vertexCount,
        );
      }
    }

    // Column range filter (DataFilterExtension). The value is per-FEATURE, but
    // SolidPolygonLayer's non-instanced fill (and the outline PathLayer's
    // instanced segments) consume the `filterValue` attribute PER-VERTEX — the
    // same per-vertex contract as the time / elevation attributes above, and
    // for the same reason (deck binds the buffer verbatim; a per-feature buffer
    // under-sizes the draw). Every vertex of a polygon shares its feature's
    // value, so the polygon filters as a whole. Absent column ⇒ no attribute →
    // the sublayer idles the filter for this tile. A categorical column can't be
    // range-filtered in v1 — warn once and skip.
    if (filterProp) {
      const values = binary.numericProps[filterProp];
      if (values) {
        attributes.filterValue = {
          value: expandPerVertex(
            values,
            startIndices,
            featureCount,
            vertexCount,
          ),
          size: 1,
        };
      } else if (binary.categoricalProps[filterProp]) {
        warnOnce(
          'AnimatedPolygonLayer:filterPropertyCategorical',
          `[AnimatedPolygonLayer] filterProperty "${filterProp}" is a categorical ` +
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
      dims: outDims,
      elevationConstant,
      gpuPalette,
      hasPreBakedTriangles,
      outlineWidths,
      tile,
      features: binary,
    };
    this.preparedTileCache.set(tileKey, prepared);
    emit('tilePrepare', {
      layer: 'AnimatedPolygonLayer',
      tileKey,
      cached: false,
      features: binary.featureCount,
      gpuPalette: gpuPalette !== null,
      preBakedTriangles: hasPreBakedTriangles,
      ms: performance.now() - t0,
    });
    return prepared;
  }

  private buildSublayer(prepared: PreparedTile): SolidPolygonLayer {
    // `Required<>`-typed: the defaultProps value (86400000, inherited from
    // the base) guarantees a number — the old `|| 86400000 * 30` fallback
    // was dead code once the default merged.
    const timeWindow = this.props.timeWindow;
    const fillColorValue = this.fillColorValue();
    const constFillColor = (
      Array.isArray(fillColorValue)
        ? fillColorValue
        : ([255, 140, 0, 180] as Color)
    ) as Color;

    const useGpuCategory = prepared.gpuPalette !== null;
    if (useGpuCategory && prepared.gpuPalette!.length > CATEGORY_PALETTE_SIZE) {
      warnOnce(
        'AnimatedPolygonLayer:paletteOverflow',
        `[AnimatedPolygonLayer] colorPalette has ${prepared.gpuPalette!.length} ` +
          `entries; only the first ${CATEGORY_PALETTE_SIZE} will be used by ` +
          'CategoryColorExtension.',
      );
    }

    // Column range filter — install DataFilterExtension only when a column is
    // named (per-layer constant ⇒ stable list). `hasFilter` gates the per-tile
    // enable so a tile missing the column renders unfiltered. Unlike the tight
    // PathLayer family, SolidPolygonLayer's non-instanced fill has attribute
    // headroom, so the filter composes ALONGSIDE the time + category extensions.
    const filterProp = this.filterPropertyValue();
    const hasFilter = !!prepared.data.attributes.filterValue;

    // getSubLayerProps inheritance (opacity/pickable/visible, coordinate
    // system, highlight props, …) + user `_subLayerProps.polygons` overrides.
    // Only runs inside this cache-gated build path — never per frame.
    const props = this.composeSubLayerProps('polygons', prepared.tileKey, {
      data: prepared.data as any,
      dataComparator: (a: any, b: any) => a === b,

      // Pre-tesselated polygon data; SolidPolygonLayer normally re-normalizes
      // user-supplied polygons. Bypassing that keeps tile data zero-copy.
      _normalize: false,
      _windingOrder: 'CCW',

      filled: this.props.filled,
      extruded: this.props.extruded,
      elevationScale: this.props.elevationScale,
      wireframe: this.props.wireframe,
      material: this.props.material,
      _full3d: this.props._full3d,

      // Constant fallback — used when binary getFillColor isn't present.
      getFillColor: constFillColor,
      // Wireframe edge color (SolidPolygonLayer draws the extruded outline with
      // this). Without it the edges lock at deck's black default — surfacing
      // getLineColor here makes `wireframe:true` colorable even without stroked.
      getLineColor: this.lineColorValue(),
      // Constant elevation resolved during prepare — the floating path rewrites
      // it to the slab THICKNESS above the synthesised floor (see PreparedTile).
      ...(this.props.extruded && prepared.elevationConstant !== null
        ? { getElevation: prepared.elevationConstant }
        : {}),

      // Constant extension list (cache-storm rationale — see
      // animated-trips-layer.ts); user extensions are appended. The column
      // filter is composed in only when a `filterProperty` is set (per-layer
      // constant ⇒ the list stays stable across this layer's sublayers).
      extensions: this.composeExtensions(
        filterProp
          ? [
              this.timeFilterExtension,
              this.categoryColorExtension,
              this.dataFilterExtension,
            ]
          : [this.timeFilterExtension, this.categoryColorExtension],
      ),

      // TimeFilterExtension wiring (same prop names the old polygon fork used)
      getTime: this.boundGetTime,
      timeOffset: prepared.timeOffset,
      timeWindow,
      fadeInDuration: this.props.fadeInDuration,
      fadeOutDuration: this.props.fadeOutDuration,
      // Time-as-height (space-time cube). Window mode lifts whole polygons by
      // their start time (the per-vertex time attribute defaults to 0). Forced
      // to 0 under reducedMotion so the map stays flat.
      timeHeightScale: this.effectiveTimeHeightScale(),
      timeHeightOrigin: this.props.timeHeightOrigin,

      // CategoryColorExtension wiring (gated by useCategoryColor)
      categoryPalette: useGpuCategory ? prepared.gpuPalette! : [],
      useCategoryColor: useGpuCategory,

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

      // TileLayer convention: the source tile rides on the sublayer so the
      // base getPickingInfo can enrich info.tile / decode the picked polygon.
      tile: prepared.tile,
      sttFeatures: prepared.features,
    });
    // `_subLayerProps: { polygons: { type } }` swaps the sublayer class.
    const SubLayerClass = this.getSubLayerClass('polygons', SolidPolygonLayer);
    return new SubLayerClass(props as any);
  }

  /**
   * Build the `stroked` outline sublayer — deck's composite PolygonLayer draws
   * the ring strokes with a `PathLayer` alongside the `SolidPolygonLayer`
   * fill; this replicates that. The outline is fed the SAME baked ring
   * `positions` + `startIndices` as the fill (zero extra decode) with
   * `_pathType:'loop'` so each feature's ring closes, and it reuses the fill's
   * per-vertex `instanceStartTime` / `instanceEndTime` buffers so the outline
   * time-filters and fades in lock-step with the fill.
   *
   * MULTI-RING / HOLES: the tile format carries only feature-level
   * `startIndices` (one contiguous vertex run per feature — the decoder packs a
   * polygon's exterior + holes, or a MultiPolygon's parts, into one run and
   * discards the ring boundaries; see the module docstring). PathLayer strokes
   * that whole run as a SINGLE closed loop, so a holed / multi-ring polygon
   * draws a spurious BRIDGE segment from the last vertex of one ring to the
   * first of the next (a visible diagonal cutting across the polygon), plus a
   * closing segment — the interior holes are not separately outlined. This is
   * the best fidelity available from the binary geometry; a faithful per-ring
   * outline needs per-ring sub-indices baked into the tile format, which it
   * does not currently carry. Single-ring polygons (the common case) are exact.
   *
   * Non-pickable (the fill owns picking) → routes through `NoPickingPathLayer`
   * to stay inside WebGL2's 16-vertex-attribute budget (PathLayer's picking
   * attribute + TimeFilterExtension's three would otherwise crowd it).
   * Returns null when the tile has no usable ring geometry.
   */
  private buildOutlineSublayer(prepared: PreparedTile): Layer | null {
    const positions = prepared.data.attributes.getPolygon;
    if (!positions || prepared.data.length === 0) return null;

    const lineColorValue = this.lineColorValue();
    const lineWidthValue = this.lineWidthValue();
    const constLineWidth =
      typeof lineWidthValue === 'number' ? lineWidthValue : 1;

    // Reuse the fill's per-vertex time buffers so the stroke filters/fades with
    // the fill; add a per-vertex getWidth column only when width is data-driven.
    const attributes: PreparedTile['data']['attributes'] = {
      getPath: { value: positions.value, size: prepared.dims },
      instanceStartTime: prepared.data.attributes.instanceStartTime,
      instanceEndTime: prepared.data.attributes.instanceEndTime,
    };
    if (prepared.outlineWidths) {
      attributes.getWidth = { value: prepared.outlineWidths, size: 1 };
    }
    // Reuse the fill's per-vertex `filterValue` buffer so a range-filtered
    // polygon hides its outline in lock-step with its fill. Attribute budget:
    // NoPickingPathLayer (12) + TimeFilterExtension (3) + this (1) = 16, right
    // at WebGL2's guaranteed floor — links fine (see the path layer). Present
    // only when a numeric filterProperty was baked into this tile.
    const filterProp = this.filterPropertyValue();
    const hasFilter = !!prepared.data.attributes.filterValue;
    if (hasFilter) {
      attributes.filterValue = prepared.data.attributes.filterValue;
    }

    const outlineData = {
      length: prepared.data.length,
      startIndices: prepared.data.startIndices,
      attributes,
    };

    const props = this.composeSubLayerProps('outline', prepared.tileKey, {
      data: outlineData as any,
      dataComparator: (a: any, b: any) => a === b,
      // Each feature's ring is a closed loop; 'loop' adds the closing segment
      // (a no-op degenerate segment for already-closed rings).
      _pathType: 'loop',
      positionFormat: prepared.dims === 3 ? 'XYZ' : 'XY',

      getColor: lineColorValue,
      getWidth: constLineWidth,
      widthUnits: this.props.lineWidthUnits,
      widthMinPixels: this.props.lineWidthMinPixels,
      jointRounded: this.props.lineJointRounded,
      miterLimit: this.props.lineMiterLimit,
      dashJustified: this.props.lineDashJustified,

      // Time filtering (constant color → no CategoryColorExtension, which keeps
      // the PathLayer attribute count within the WebGL2 minimum). The column
      // filter is composed in alongside it only when a `filterProperty` is set
      // — net 16 attributes, still at the floor.
      extensions: this.composeExtensions(
        filterProp
          ? [this.timeFilterExtension, this.dataFilterExtension]
          : [this.timeFilterExtension],
      ),
      getTime: this.boundGetTime,
      timeOffset: prepared.timeOffset,
      timeWindow: this.props.timeWindow,
      fadeInDuration: this.props.fadeInDuration,
      fadeOutDuration: this.props.fadeOutDuration,
      // Lift the outline with the fill so the space-time cube's ring strokes
      // ride at the same altitude (0 under reducedMotion).
      timeHeightScale: this.effectiveTimeHeightScale(),
      timeHeightOrigin: this.props.timeHeightOrigin,

      // DataFilterExtension wiring — mirrors the fill so the stroke clips/fades
      // with it. filterEnabled is gated on THIS tile having baked the column.
      ...(filterProp
        ? {
            getFilterValue: 0,
            filterEnabled: hasFilter && this.props.filterEnabled !== false,
            filterRange: this.props.filterRange ?? null,
            filterSoftRange: this.props.filterSoftRange ?? null,
          }
        : {}),

      // Outlines are not pick targets; the fill enriches picking.
      pickable: false,

      tile: prepared.tile,
      sttFeatures: prepared.features,
    });
    // `_subLayerProps: { outline: { type } }` swaps the outline sublayer class.
    const SubLayerClass = this.getSubLayerClass('outline', NoPickingPathLayer);
    return new SubLayerClass(props as any);
  }
}

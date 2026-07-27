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
 *   same wiring as the other animated layers, EXCEPT when `extruded` is on.
 *   SolidPolygonLayer computes phong lighting in the VERTEX shader
 *   (`lighting_getLightColor` → `vColor`, solid-polygon-layer-vertex-main.glsl)
 *   and the fragment shader only forwards it (`fragColor = vColor`) before
 *   running `DECKGL_FILTER_COLOR`; the extension injects there and REPLACES
 *   rgb, which would discard the lighting and render every extruded prism
 *   flat and unlit. So the extruded path expands the palette on the CPU into a
 *   per-vertex `getFillColor` buffer instead — see prepareTile. Flat fills
 *   (the common case) keep the zero-CPU GPU path; nothing is lit there.
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
import { STTDataFilterExtension } from '../../extensions/data-filter-extension.js';
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
  DEFAULT_POLYGON_PALETTE,
  GeometryType,
  tileLayerKey,
} from '@poopdeck.gl/core';
import { computePolygonWallMask } from '@poopdeck.gl/core/geometry';
import { expectGeometry } from '../../lib/geometry-guard.js';
import type {
  Tile,
  STTTileLayer as TileLayer,
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
   *
   * DELIBERATE DEFAULT DRIFT from deck: upstream `PolygonLayer.getFillColor`
   * defaults to opaque black `[0, 0, 0, 255]`. STT polygons are almost always
   * a translucent overlay on a basemap, where opaque black reads as "the map
   * failed to load"; the amber default is legible over both light and dark
   * basemaps and its alpha shows the basemap through. Pass `[0, 0, 0, 255]`
   * for byte-exact deck parity.
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
   *
   * NOTE this default is 0 (flat), NOT deck's
   * `SolidPolygonLayer.getElevation` default of 1000. A column name the tile
   * does not carry falls back to this 0 too (with a one-time warning) rather
   * than letting deck's 1000 through — a typo'd column name must not silently
   * extrude the whole archive a kilometre.
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
   * `lineWidthUnits` / `lineWidthScale` / `lineWidthMinPixels` /
   * `lineWidthMaxPixels` / `lineJointRounded` / `lineMiterLimit` /
   * `lineDashJustified`.
   *
   * DELIBERATE DEFAULT DRIFT from deck: upstream `PolygonLayer.stroked`
   * defaults to `true`. Here it is `false`, because upstream draws ONE
   * composite per dataset while this layer draws one per (tile, layer) — an
   * outline nobody asked for would double the sublayer count and the draw
   * calls on every tiled archive. Set `true` for deck's look.
   *
   * IGNORED FOR GROUND-ANCHORED EXTRUSION (deck parity): upstream gates the
   * stroke on `!extruded` (polygon-layer.ts) because an extruded polygon's
   * ring stroke stays at the geometry's own z — a ghost ring lying on the
   * basemap under each prism. The one divergence is STT's FLOATING extrusion
   * ({@link baseElevation} / {@link elevationThickness}), which lifts the
   * GEOMETRY itself to the floor plane: there the outline rides the slab with
   * the fill and is the intended look, so it is kept (and, following
   * upstream's extruded ordering, drawn BEFORE the fill so translucent slabs
   * blend the way deck's do).
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
   * in {@link lineWidthUnits}, multiplied by {@link lineWidthScale} and
   * clamped by {@link lineWidthMinPixels} / {@link lineWidthMaxPixels}.
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
   * Global multiplier applied to every outline width — outline PathLayer
   * `widthScale` pass-through, mirroring deck's `PolygonLayer.lineWidthScale`.
   * Lets a whole layer's borders be thickened/thinned without touching the
   * per-feature widths. Only applies when `stroked` is true. @default 1
   */
  lineWidthScale?: number;

  /**
   * Clamp the outline width to at least this many on-screen pixels so thin
   * borders stay visible at low zoom — outline PathLayer pass-through. Only
   * applies when `stroked` is true. @default 0
   */
  lineWidthMinPixels?: number;

  /**
   * Clamp the outline width to at most this many on-screen pixels — outline
   * PathLayer `widthMaxPixels` pass-through, mirroring deck's
   * `PolygonLayer.lineWidthMaxPixels`. Load-bearing with the deck-matching
   * `lineWidthUnits: 'meters'` default: without an upper clamp a metres-unit
   * border grows without bound as you zoom in, until the outline is a slab
   * covering its own polygon. Only applies when `stroked` is true.
   * @default Number.MAX_SAFE_INTEGER (no clamp)
   */
  lineWidthMaxPixels?: number;

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
   *
   * INERT AGAINST TODAY'S ARCHIVES, and kept only so the prop is already in
   * place when that changes. Upstream `_full3d` reaches a render exclusively
   * through `getSurfaceIndices` inside deck's PolygonTesselator, and neither
   * precondition holds here: the STT polygon decoder emits
   * `positionDimensions: 2` unconditionally (`packages/core/src/tile.ts`), so
   * there is no z to tesselate on, and any multi-ring tile ships pre-baked
   * `triangles` (the builder bakes them whenever ANY feature is multi-ring),
   * which bypasses the tesselator entirely. The same goes for the
   * `dims > 2` branch in the floating-extrusion path: it is the other half of
   * this prop, waiting on the same format change. Both stay so that an
   * archive carrying XYZ polygon geometry works the day the format emits one,
   * rather than needing a layer change as well.
   * @default false
   */
  _full3d?: boolean;

  /**
   * Ring winding order of the tile geometry — `SolidPolygonLayer._windingOrder`
   * pass-through, effective only while {@link _normalize} is false (which is
   * this layer's default). Drives deck's `RING_WINDING_ORDER_CW` define, which
   * swaps `pos`/`nextPos` in the extruded SIDE shader and therefore FLIPS the
   * wall normal — i.e. it decides whether extruded walls are lit from outside
   * or from inside. Fills are unaffected.
   *
   * `'CCW'` (this layer's default) suits geometry whose exteriors wind
   * counter-clockwise, which is the GeoJSON/OGC convention and what the Rust
   * builder produces wherever it normalizes winding at all — but it only does
   * so on the antimeridian-split path (`fix_winding` in `stt-build/src/clip.rs`
   * is scoped to that path), so a source that was already wound the other way
   * survives into the archive as-is. The shipped WILDFIRES dataset is exactly
   * that case: `stt-generate` writes ArcGIS-native CLOCKWISE exteriors with
   * counter-clockwise holes, so its extruded perimeter walls are lit from
   * inside until this prop is set to `'CW'`. There is no per-tile way to
   * detect this (a signed-area test can't distinguish an exterior from a
   * hole without ring roles), so it is a per-dataset styling decision.
   * @default 'CCW'
   */
  _windingOrder?: 'CW' | 'CCW';

  /**
   * Hand the tile geometry back to deck's PolygonTesselator for normalization
   * — `SolidPolygonLayer._normalize` pass-through. `false` (this layer's
   * default, and the reason the tile path is zero-copy) feeds the baked ring
   * `positions` + `startIndices` straight to the GPU.
   *
   * ESCAPE HATCH, not a supported render mode. Setting `true` re-runs earcut
   * on every tile (so the pre-baked `triangles` sidecar is dropped — keeping
   * it would index the pre-normalization vertex order), makes
   * {@link _windingOrder} inert (deck's define reads it only when
   * `_normalize` is false), and — the real hazard — normalization may not
   * preserve the tile's vertex ORDER or COUNT, while this layer's per-vertex
   * time / category / filter / elevation buffers are all expanded against it.
   * Surfaced for deck parity and for hand-built non-STT data passed through
   * `_subLayerProps`; a one-time warning fires when it is turned on.
   * @default false
   */
  _normalize?: boolean;

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
   * by (installs {@link STTDataFilterExtension}). A polygon renders when its value
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

/**
 * Where each own prop lands, and therefore whether editing it has to throw
 * away the per-tile sublayer cache. `'sublayer'` values are frozen into a
 * cached SolidPolygonLayer (or its outline PathLayer) at construction and ride
 * {@link computeLayerPropsKey}; `'prepare'` values reach the GPU only through a
 * tile's baked attributes, which the prepare-time styleKey covers and the
 * prepared-object identity check turns into a sublayer rebuild.
 *
 * The {@link PropEffects} annotation makes the table total: a prop added to
 * {@link _AnimatedPolygonLayerProps} without an entry here fails to compile,
 * which is the only thing standing between an unclassified prop and a stale
 * sublayer nobody notices until they look at the map.
 */
const POLYGON_PROP_EFFECTS: PropEffects<_AnimatedPolygonLayerProps> = {
  filled: 'sublayer',
  fillColor: 'sublayer',
  getFillColor: 'sublayer',
  // Categorical fill resolves entirely inside prepareTile — the palette, the
  // explicit mapping and its unknown-category fallback are baked into the
  // tile's per-vertex getFillColor / instanceCategoryIndex buffers, and the
  // sublayer takes the resolved palette off the prepared tile.
  colorPalette: 'prepare',
  colorMapping: 'prepare',
  colorMappingDefault: 'prepare',
  elevation: 'sublayer',
  getElevation: 'sublayer',
  extruded: 'sublayer',
  elevationScale: 'sublayer',
  // Both decide whether the extrusion FLOATS, which floorSpec() answers on the
  // sublayer-construction path (it gates the outline sublayer) as well as
  // during prepare.
  baseElevation: 'sublayer',
  elevationThickness: 'sublayer',
  wireframe: 'sublayer',
  // Only prepareTile reads it: the side-wall mask is a baked attribute.
  seamWalls: 'prepare',
  material: 'sublayer',
  stroked: 'sublayer',
  getLineColor: 'sublayer',
  getLineWidth: 'sublayer',
  lineWidthUnits: 'sublayer',
  lineWidthScale: 'sublayer',
  lineWidthMinPixels: 'sublayer',
  lineWidthMaxPixels: 'sublayer',
  lineJointRounded: 'sublayer',
  lineMiterLimit: 'sublayer',
  lineDashJustified: 'sublayer',
  _full3d: 'sublayer',
  _windingOrder: 'sublayer',
  _normalize: 'sublayer',
  fadeInDuration: 'sublayer',
  fadeOutDuration: 'sublayer',
  timeHeightScale: 'sublayer',
  reducedMotion: 'sublayer',
  filterProperty: 'sublayer',
  filterRange: 'sublayer',
  filterSoftRange: 'sublayer',
  filterEnabled: 'sublayer',
};

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
   * per-vertex `getElevation` buffer. Never null when it does not: a named
   * column the tile lacks resolves to this layer's own documented default (0),
   * because leaving the prop unset would hand the sublayer deck's
   * `SolidPolygonLayer` default of 1000 m instead. Resolved during prepare
   * because the FLOATING-extrusion path (see
   * {@link _AnimatedPolygonLayerProps.baseElevation}) rewrites elevation to a
   * THICKNESS above the synthesised floor, which may collapse a column-driven
   * top to a constant.
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
 * CPU analogue of CategoryColorExtension's palette lookup: resolve each
 * feature's palette slot to RGBA and write it across that feature's vertex
 * run, producing the `fillColors` buffer SolidPolygonLayer feeds into its
 * lighting.
 *
 * Used only on the EXTRUDED path, where the GPU lookup would land after
 * lighting and erase it (see the module docstring). `slots` comes straight
 * from `categoryIndicesToFloat32`, so NULL features already point at the
 * appended default slot and overflowing categories are already clamped —
 * every value indexes `palette` in range.
 */
function expandCategoryColorsPerVertex(
  slots: Float32Array,
  palette: readonly Color[],
  startIndices: Uint32Array,
  featureCount: number,
  vertexCount: number,
): Uint8Array {
  const out = new Uint8Array(vertexCount * 4);
  for (let f = 0; f < featureCount; f++) {
    const color = palette[slots[f]];
    const r = color?.[0] ?? 0;
    const g = color?.[1] ?? 0;
    const b = color?.[2] ?? 0;
    const a = color?.[3] ?? 255;
    const start = startIndices[f];
    // Trailing sentinel by the deck.gl binary convention — same fallback as
    // expandPerVertex for producers that omit it.
    const end = f + 1 < startIndices.length ? startIndices[f + 1] : vertexCount;
    for (let v = start; v < end; v++) {
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
    lineWidthScale: { type: 'number', value: 1, min: 0 },
    lineWidthMinPixels: { type: 'number', value: 0, min: 0 },
    // Deck PolygonLayer's own default — no clamp until the caller asks for one.
    lineWidthMaxPixels: {
      type: 'number',
      value: Number.MAX_SAFE_INTEGER,
      min: 0,
    },
    lineJointRounded: false,
    lineMiterLimit: { type: 'number', value: 4, min: 0 },
    lineDashJustified: false,
    _full3d: false,
    // Geometry-interpretation escape hatches (see the prop docs). The defaults
    // ARE the zero-copy tile path — changing either is a per-dataset decision.
    _windingOrder: 'CCW',
    _normalize: false,
    fadeInDuration: { type: 'number', value: 500, min: 0 },
    fadeOutDuration: { type: 'number', value: 500, min: 0 },
    // Space-time-cube lift. 0 (off) keeps the flat render byte-identical.
    // timeHeightOrigin is inherited from SpatioTemporalLayer.defaultProps.
    timeHeightScale: { type: 'number', value: 0 },
    reducedMotion: false,
    // Column range filter (STTDataFilterExtension). Unset ⇒ not installed.
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
   * Singleton STTDataFilterExtension, composed into the sublayer extension list
   * only when `filterProperty` is set (per-layer constant ⇒ stable list, so the
   * shader-cache contract holds). SolidPolygonLayer's non-instanced fill has a
   * roomy attribute budget, so it composes ALONGSIDE the time + category
   * extensions (unlike the tight PathLayer family, which must drop one).
   */
  private readonly dataFilterExtension = new STTDataFilterExtension({
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
   * Accessor-alias resolution: the upstream-named alias wins when
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
    return buildLayerPropsKey<_AnimatedPolygonLayerProps>(
      this.props,
      POLYGON_PROP_EFFECTS,
      {
        // Values the sublayers are actually built from. `getFillColor` /
        // `getElevation` win over their legacy props, and the three resolvers
        // below fall back to a constant when handed a function, so keying the
        // raw props would either leave cached sublayers stale on an alias-only
        // edit or clear the cache every render for a fresh function reference.
        overrides: {
          fillColor: this.fillColorValue(),
          elevation: this.elevationValue(),
          getLineColor: this.lineColorValue(),
          getLineWidth: this.lineWidthValue(),
          filterProperty: this.filterPropertyValue(),
          // reducedMotion forces the space-time-cube lift to 0, so the key has
          // to track the EFFECTIVE scale, not the raw prop.
          timeHeightScale: this.effectiveTimeHeightScale(),
        },
        extra: [
          // Composite props that getSubLayerProps bakes into every sublayer
          // (opacity/pickable/visible, coordinate system, _subLayerProps, …)
          // plus the user's updateTriggers.
          inheritedPropsDigest(this.props),
          updateTriggersDigest(this.props.updateTriggers),
          // Inherited time props the sublayers carry. Uniform-only edits, so
          // they rebuild the cached sublayers (whose props hold the values)
          // rather than re-preparing tiles.
          this.props.timeWindow,
          this.props.timeHeightOrigin,
        ],
      },
    );
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
          for (const l of cached.layers) sublayers.push(l);
          continue;
        }
        const layers: Layer[] = this.buildTileSublayers(prepared);
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

  /**
   * Emit one tile's sublayers in deck's PolygonLayer order.
   *
   * Upstream returns `[!extruded && fill, stroke, extruded && fill]`
   * (polygon-layer.ts): the stroke exists only for a FLAT fill, and when the
   * fill is extruded it is drawn LAST so translucent prisms blend correctly.
   * Both halves matter here.
   *
   * The stroke gate is upstream's, with one deliberate divergence. Deck
   * suppresses the stroke under `extruded` because a PathLayer stroke rides
   * the polygon's own vertex z — with STT's GROUND-anchored extrusion (2D
   * geometry, height entirely in the `elevations` attribute) that is z = 0, so
   * `extruded + stroked` printed a ghost ring on the basemap beneath every
   * prism. The FLOATING extrusion path is different in kind: it lifts the
   * VERTICES to the floor plane, so the same stroke lands on the slab's own
   * base and is exactly the outline the caller asked for — kept, and (per
   * upstream's extruded ordering) emitted before the fill.
   */
  private buildTileSublayers(prepared: PreparedTile): Layer[] {
    const fill = this.buildSublayer(prepared);
    // `floorSpec()` is null unless `extruded` — so this reads "extruded, but
    // anchored to the ground", the one case deck's gate is about.
    const groundAnchoredPrism = this.props.extruded && !this.floorSpec();
    const outline =
      this.props.stroked && !groundAnchoredPrism
        ? this.buildOutlineSublayer(prepared)
        : null;
    if (!outline) return [fill];
    // Extruded ⇒ fill last (blending); flat ⇒ fill first (the stroke draws on
    // top of the fill it outlines).
    return this.props.extruded ? [outline, fill] : [fill, outline];
  }

  private prepareTile(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0 || !binary.startIndices) return null;
    // `!startIndices` alone does NOT identify a polygon tile — LineString
    // tiles carry startIndices too, and would sail into this path to be
    // tesselated as (degenerate) polygons. Skip the layer with one named
    // warning instead.
    if (
      !expectGeometry(
        binary.geometryType,
        [GeometryType.Polygon],
        this.props.id,
        tileLayer.name,
      )
    ) {
      return null;
    }

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
    // Property-column name for the STTDataFilterExtension range filter (else '').
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
    // `extruded` rides here for a SECOND reason: it also picks the categorical
    // fill path (GPU palette lookup when flat, CPU per-vertex RGBA when
    // extruded — see below), which is likewise baked into the attributes.
    const wallSig = `w${this.props.extruded ? 1 : 0}${this.props.seamWalls ? 1 : 0}`;
    // `_normalize: true` drops the pre-baked triangle indices (they address the
    // pre-normalization vertex order), so it changes the baked attributes too.
    const normSig = this.props._normalize ? 'n' : '';
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
    const styleKey = `${fillColorProp}|${elevationProp}|${lineWidthProp}|${filterSig}|${wallSig}${normSig}|${floorSig}|${
      fillColorProp
        ? this.props.colorMapping
          ? `m${colorMappingDigest(this.props.colorMapping)}`
          : colorListDigest(this.props.colorPalette ?? DEFAULT_PALETTE)
        : 0
    }|d${mapDefault}|${updateTriggersDigest(this.props.updateTriggers)}`;

    const tileKey = tileLayerKey(tile.id, tileLayer.name);
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
        const slots = categoryIndicesToFloat32(
          cat.indices,
          featureCount,
          basePalette.length,
          'AnimatedPolygonLayer',
        );
        const palette = appendNullCategorySlot(
          basePalette,
          this.props.colorMappingDefault as Color | undefined,
        );
        if (this.props.extruded) {
          // EXTRUDED ⇒ CPU expansion, not the GPU palette lookup.
          // SolidPolygonLayer applies phong lighting in the VERTEX shader and
          // the fragment shader only forwards the result, so
          // CategoryColorExtension's `fs:DECKGL_FILTER_COLOR` hook — which
          // REPLACES rgb with the sampled palette entry — would overwrite the
          // lit color and flatten every prism into an unlit silhouette (top
          // and side models alike; both run `calculatePosition`). Expanding
          // the palette into the `fillColors` attribute instead feeds the
          // color in BEFORE lighting, where deck's own `getFillColor`
          // accessor would have put it. Costs 4 bytes/vertex once per tile
          // prep; the flat path (no lighting to lose) keeps the GPU lookup.
          attributes.getFillColor = {
            value: expandCategoryColorsPerVertex(
              slots,
              palette,
              startIndices,
              featureCount,
              vertexCount,
            ),
            size: 4,
            normalized: true,
          };
        } else {
          attributes.instanceCategoryIndex = {
            value: expandPerVertex(
              slots,
              startIndices,
              featureCount,
              vertexCount,
            ),
            size: 1,
          };
          gpuPalette = palette;
        }
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
    // Constant elevation for the sublayer prop; null ⇒ the per-vertex buffer
    // baked above owns it. The floating branch below may rewrite it.
    let elevationConstant =
      typeof elevationValue === 'number' ? elevationValue : null;
    if (elevationConstant === null && !attributes.getElevation) {
      // Nothing resolved: an elevation COLUMN this tile doesn't carry (a typo,
      // or one layer of a multi-layer archive that simply lacks it). Leaving
      // both the attribute and the prop unset hands the sublayer over to
      // `SolidPolygonLayer.defaultProps.getElevation`, which is 1000 — every
      // polygon silently extruded a kilometre, with nothing on screen to
      // suggest the column name was the problem. Fall back to this layer's own
      // documented default (0) and say so once, mirroring how `filterProperty`
      // warns and `fillColor` degrades to its constant.
      elevationConstant = 0;
      if (elevationProp) {
        warnOnce(
          `AnimatedPolygonLayer:missingElevationColumn:${elevationProp}`,
          `[AnimatedPolygonLayer] elevation column "${elevationProp}" is not on ` +
            `tile layer ${JSON.stringify(tileLayer.name)}; those polygons render ` +
            `flat (elevation 0) instead of taking deck's 1000 m default. Check ` +
            `the column name, or set a constant \`elevation\` for layers that ` +
            `don't carry it.`,
        );
      }
    }
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
    // needed here. Skipped under `_normalize: true`, where deck re-normalizes
    // the geometry and these indices would address the pre-normalization
    // vertex order.
    const hasPreBakedTriangles =
      !this.props._normalize &&
      !!binary.triangles &&
      binary.triangles.length > 0;
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

    // Column range filter (STTDataFilterExtension). The value is per-FEATURE, but
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

    // Column range filter — install STTDataFilterExtension only when a column is
    // named (per-layer constant ⇒ stable list). `hasFilter` gates the per-tile
    // enable so a tile missing the column renders unfiltered. Unlike the tight
    // PathLayer family, SolidPolygonLayer's non-instanced fill has attribute
    // headroom, so the filter composes ALONGSIDE the time + category extensions.
    const filterProp = this.filterPropertyValue();
    const hasFilter = !!prepared.data.attributes.filterValue;

    if (this.props._normalize) {
      warnOnce(
        'AnimatedPolygonLayer:normalize',
        '[AnimatedPolygonLayer] `_normalize: true` hands tile geometry back to ' +
          "deck's PolygonTesselator: the pre-baked triangle indices are dropped " +
          '(earcut runs per tile), `_windingOrder` becomes inert, and the ' +
          'per-vertex time / category / filter / elevation buffers this layer ' +
          'bakes assume the TILE vertex order, which normalization need not ' +
          'preserve. Leave it false for STT archives.',
      );
    }

    // getSubLayerProps inheritance (opacity/pickable/visible, coordinate
    // system, highlight props, …) + user `_subLayerProps.polygons` overrides.
    // Only runs inside this cache-gated build path — never per frame.
    const props = this.composeSubLayerProps('polygons', prepared.tileKey, {
      data: prepared.data as any,
      dataComparator: (a: any, b: any) => a === b,

      // Pre-tesselated polygon data; SolidPolygonLayer normally re-normalizes
      // user-supplied polygons, and bypassing that is what keeps the tile data
      // zero-copy. Both are caller-overridable (see the prop docs) because
      // `_windingOrder` is the ONLY control over which way extruded side walls
      // face, and the builder does not normalize winding except on the
      // antimeridian-split path — so a clockwise-exterior archive needs 'CW'.
      // `?? ` because an explicitly-undefined prop shadows defaultProps in
      // deck's merge — the repo-wide gotcha — and these two decide how the
      // geometry is READ, so a silent undefined is not survivable.
      _normalize: this.props._normalize ?? false,
      _windingOrder: this.props._windingOrder ?? 'CCW',

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
   * `positions` as the fill (zero extra decode) with `_pathType:'loop'` so each
   * ring closes, and it reuses the fill's per-vertex `instanceStartTime` /
   * `instanceEndTime` buffers so the outline time-filters and fades in
   * lock-step with the fill.
   *
   * MULTI-RING / HOLES: strokes ONE PATH PER RING, from
   * {@link BinaryFeatures.ringIndices} — the per-ring vertex offsets the
   * decoder surfaces alongside the feature-level `startIndices` for exactly
   * this reason (the same array {@link computePolygonWallMask} walks). The
   * fill's `startIndices` collapse a polygon's exterior + holes (or a
   * MultiPolygon's parts) into ONE contiguous run, so feeding those to
   * PathLayer strokes the whole run as a single loop: because the builder
   * stores rings CLOSED, each ring came out right and then one spurious
   * segment ran from the exterior's first vertex to the first hole's first
   * vertex — a diagonal slash across every lake or burn scar — while the holes
   * themselves were never outlined. Upstream `PolygonLayer` promises hole
   * outlines, and with the ring breaks it can be kept.
   *
   * The per-vertex time / width / filter buffers need no change: ring breaks
   * fall INSIDE feature vertex runs, so those buffers still line up 1:1 with
   * vertices. deck sets `normalize: !props._pathType` and this passes
   * `_pathType: 'loop'`, so its tesselator adopts `data.startIndices` verbatim
   * as `vertexStarts` and sizes the instanced draw from `startIndices[length]`
   * — hence `length` must be the RING count here, not the feature count.
   * Archives predating the `ringIndices` column fall back to `startIndices`
   * (the old one-loop-per-feature behaviour).
   *
   * Non-pickable (the fill owns picking) → routes through `NoPickingPathLayer`
   * to stay inside WebGL2's 16-vertex-attribute budget (PathLayer's picking
   * attribute + TimeFilterExtension's three would otherwise crowd it).
   * Returns null when the tile has no usable ring geometry.
   */
  private buildOutlineSublayer(prepared: PreparedTile): Layer | null {
    const positions = prepared.data.attributes.getPolygon;
    if (!positions || prepared.data.length === 0) return null;

    // One PATH per ring. `ringIndices` carries every feature boundary too, so
    // it subsumes `startIndices`; without it (pre-column archives) the rings
    // collapse back to features.
    const ringStarts =
      prepared.features.ringIndices ?? prepared.data.startIndices;
    const ringCount = ringStarts.length - 1;
    if (ringCount <= 0) return null;

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
      length: ringCount,
      startIndices: ringStarts,
      attributes,
    };

    const props = this.composeSubLayerProps('outline', prepared.tileKey, {
      data: outlineData as any,
      dataComparator: (a: any, b: any) => a === b,
      // Each RING is a closed loop; 'loop' adds the closing segment (a no-op
      // degenerate segment for the closed rings the builder stores).
      _pathType: 'loop',
      positionFormat: prepared.dims === 3 ? 'XYZ' : 'XY',

      getColor: lineColorValue,
      getWidth: constLineWidth,
      widthUnits: this.props.lineWidthUnits,
      widthScale: this.props.lineWidthScale ?? 1,
      widthMinPixels: this.props.lineWidthMinPixels,
      // `?? ` so an explicit undefined can't strip the clamp back to deck's
      // PathLayer default — which is also MAX_SAFE_INTEGER, but only by
      // coincidence; the guard states the intent.
      widthMaxPixels: this.props.lineWidthMaxPixels ?? Number.MAX_SAFE_INTEGER,
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

      // STTDataFilterExtension wiring — mirrors the fill so the stroke clips/fades
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

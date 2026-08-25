// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * AnimatedColumnLayer - time-filtered extruded columns at point features.
 *
 * ARCHITECTURE (v3 - Per-tile binary sublayers):
 * - One deck.gl `ColumnLayer` per (tile, layer) pair. No cross-tile
 *   consolidation. ColumnLayer is instanced at points exactly like
 *   ScatterplotLayer, so this layer mirrors AnimatedPointLayer's WINDOW-mode
 *   structure: each sublayer uses the binary `data: { length, attributes }`
 *   interface, with positions / startTimes / endTimes referenced DIRECTLY from
 *   the tile's BinaryFeatures (zero-copy from the Arrow buffer).
 * - Per-tile `timeOffset` — each sublayer rebases time independently in its own
 *   TimeFilterExtension instance. No layer-wide rebasing pass.
 * - `getTime` callback drives the window uniform per draw without layer
 *   recreation, so the demo's tick handler only calls `setNeedsRedraw()`.
 * - Prepared per-tile data is cached so the `data` object reference is stable
 *   across renderLayers() calls; deck.gl short-circuits GPU re-uploads when the
 *   reference matches (paired with `dataComparator: (a, b) => a === b`).
 *
 * Streaming is additive: a new tile creates one sublayer and one GPU upload.
 * Existing tiles' GPU buffers are untouched.
 *
 * COLUMN HEIGHT comes from a per-feature numeric property (`getElevation` /
 * `elevation` = a property-column NAME). Because ColumnLayer is instanced at
 * points, the elevation buffer is one size-1 value PER FEATURE — the same
 * per-feature/instanced contract as AnimatedPointLayer's getRadius, NOT the
 * per-vertex expansion AnimatedPolygonLayer needs for its non-instanced fill
 * model. The numeric column rides zero-copy when present.
 *
 * Categorical fill colors resolve on the CPU into a per-feature RGBA
 * `getFillColor` buffer whenever the columns are EXTRUDED (the default), and
 * lift to the GPU CategoryColorExtension only for flat disks
 * (`extruded: false`). The split is forced by the shader: ColumnLayer computes
 * lighting BEFORE `DECKGL_FILTER_COLOR` — gouraud into `vColor` in the vertex
 * stage, phong into `fragColor` under `flatShading` — and the extension's hook
 * REPLACES rgb (`color = vec4(palette.rgb, palette.a * color.a)`), so a GPU
 * palette write on an extruded column discards the lit color and every bar
 * renders as a flat single-tone silhouette. AnimatedPointLayer can use the GPU
 * path unconditionally because its markers are unlit; AnimatedPointCloudLayer
 * (lit, like this one) makes the same CPU choice. A `colorMapping` (explicit
 * `{ category: Color }`) always CPU-expands, extruded or not — a category
 * string can't hash to a palette slot on the GPU. A baked numeric column can
 * also drive a GPU STTDataFilterExtension range filter
 * (`filterProperty`/`filterRange`).
 *
 * There is no cumulative-slab path: columns are an overview/aggregate primitive
 * (a few thousand bars at low zoom), so the per-tile-sublayer count never climbs
 * into the thousands the way a cumulative point reveal does.
 */

import { ColumnLayer } from '@deck.gl/layers';
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
import { TimeFilterExtension } from '../../extensions/time-filter-extension.js';
import { STTDataFilterExtension } from '../../extensions/data-filter-extension.js';
import type { DataFilterRange } from '../../extensions/data-filter-extension.js';
import {
  CategoryColorExtension,
  CATEGORY_PALETTE_SIZE,
  appendNullCategorySlot,
  categoryIndicesToFloat32,
} from '../../extensions/category-color-extension.js';
import { emit, isProbeEnabled } from '../../lib/telemetry.js';
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
import { expectGeometry } from '../../lib/geometry-guard.js';
import { expandCategoricalColors as coreExpandCategoricalColors } from '@poopdeck.gl/core/style';
import type { RGBA255 } from '@poopdeck.gl/core/style';
import { GeometryType, tileLayerKey } from '@poopdeck.gl/core';
import type {
  Tile,
  STTTileLayer as TileLayer,
  BinaryFeatures,
} from '@poopdeck.gl/core';

const DEBUG = false;

/** Props added by {@link AnimatedColumnLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link AnimatedColumnLayerProps}). */
export interface _AnimatedColumnLayerProps {
  /**
   * Number of sides used to render the column's disk cross-section.
   * @default 20
   */
  diskResolution?: number;

  /**
   * Disk radius in units specified by {@link radiusUnits}.
   *
   * DEFAULT DIVERGENCE: deck.gl's own `ColumnLayer` defaults `radius` to
   * **1000**; this layer defaults to **100**, sized for the point archives it
   * renders (a metro-scale bar chart, not a continental hex grid). Porting a
   * deck config that relied on the upstream default therefore yields columns
   * 10× narrower — pass `radius` explicitly. This is the ONLY value in the
   * column surface that diverges from upstream.
   * @default 100
   */
  radius?: number;

  /**
   * Disk rotation, counter-clockwise in degrees — ColumnLayer pass-through.
   */
  angle?: number;

  /**
   * Custom disk geometry: replaces the default regular polygon with explicit
   * vertices — ColumnLayer pass-through.
   */
  vertices?: [number, number][] | null;

  /**
   * Disk offset from the position, relative to the radius — ColumnLayer
   * pass-through.
   */
  offset?: [number, number];

  /**
   * Radius multiplier (0..1) — ColumnLayer pass-through.
   * @default 1
   */
  coverage?: number;

  /**
   * Extrude the columns into 3D. When `false` they render as flat disks.
   *
   * Also selects how a categorical {@link fillColor} is resolved: extruded
   * columns are LIT, so the palette is CPU-expanded into a per-feature RGBA
   * buffer; flat disks take the GPU CategoryColorExtension path. Toggling this
   * therefore re-prepares tiles (same colors either way).
   * @default true
   */
  extruded?: boolean;

  /**
   * Draw a line wireframe of each extruded column — ColumnLayer pass-through.
   * Only takes effect when `extruded` is true.
   * @default false
   */
  wireframe?: boolean;

  /**
   * Fill the column body.
   * @default true
   */
  filled?: boolean;

  /**
   * Draw an outline around the disks.
   * @default false
   */
  stroked?: boolean;

  /**
   * Flat (vs. smooth) shading on the column's vertical surfaces — ColumnLayer
   * pass-through.
   * @default false
   */
  flatShading?: boolean;

  /**
   * Units for {@link radius} — ColumnLayer pass-through. Deck-parity default
   * (world-space meters), unlike AnimatedPointLayer whose STT default is
   * 'pixels'.
   * @default 'meters'
   */
  radiusUnits?: 'meters' | 'pixels' | 'common';

  /**
   * Column height — constant number, or property name for per-feature height
   * (baked from `numericProps[name]` into the binary getElevation attribute).
   * @default 1000
   */
  elevation?: number | string;

  /**
   * Upstream-vocabulary alias of {@link elevation}. Accepts a constant number
   * OR a property-column NAME — NOT a function accessor (binary tiles can't run
   * per-feature JS; a function warns once and falls back to `elevation`). When
   * set, it wins over `elevation`.
   */
  getElevation?: NumericAccessorValue | null;

  /**
   * Multiplier applied to every elevation value on the GPU (constant AND
   * column-driven) — ColumnLayer pass-through.
   * @default 1
   */
  elevationScale?: number;

  /**
   * Fill color — constant {@link Color}, or property name for categorical
   * coloring. Extruded columns (the default) CPU-expand the palette into a
   * per-feature RGBA buffer so the bars stay LIT; flat disks
   * (`extruded: false`) take the cheaper GPU lookup via
   * CategoryColorExtension. See the class docstring for why the split exists.
   * @default [255, 140, 0, 255]
   */
  fillColor?: Color | string;

  /**
   * Upstream-vocabulary alias of {@link fillColor}. NOTE: unlike upstream
   * deck.gl, this accepts a constant Color OR a property-column NAME — NOT a
   * function accessor (a function warns once and falls back to `fillColor`).
   * When set, it wins over `fillColor`.
   */
  getFillColor?: ColorAccessorValue | null;

  /** Color palette for the categorical `fillColor` path. */
  colorPalette?: Color[];

  /**
   * Stable per-category color map for the categorical `fillColor` path: an
   * explicit `{ categoryValue: Color }` lookup keyed by the category STRING, so
   * a given category always draws the SAME color regardless of its index within
   * a tile (the index-driven {@link colorPalette} path can assign different
   * colors to the same category across tiles). When set it takes precedence
   * over `colorPalette` and is CPU-expanded into a per-feature `getFillColor`
   * buffer via the shared categorical-color helper — a category string can't be
   * hashed to a palette slot on the GPU, so this leaves the GPU
   * CategoryColorExtension path idle. Unknown categories fall back to
   * {@link colorMappingDefault}. No effect when `fillColor` names a constant.
   * @default null
   */
  colorMapping?: Record<string, Color> | null;

  /**
   * Fallback color for categories absent from {@link colorMapping}.
   * @default [0, 0, 0, 0] (transparent)
   */
  colorMappingDefault?: Color;

  /**
   * GPU range filter — the NAME of a baked numeric column to filter columns by
   * (installs {@link STTDataFilterExtension}). Columns whose value in this column
   * falls inside {@link filterRange} render; the rest are hidden (or soft-faded
   * via {@link filterSoftRange}). Composes WITH the time filter — a column must
   * pass both the time window and the column range.
   *
   * Accessor-alias of deck.gl's `getFilterValue`: pass a column NAME, not a
   * function (STT tiles are binary — a function warns once and is ignored).
   * Unset (the default) ⇒ the extension is not installed at all: zero
   * attribute, zero uniform, zero shader change. A tile that lacks the named
   * column renders unfiltered (the filter idles for that tile).
   * @default null
   */
  filterProperty?: WeightAccessorValue | null;

  /**
   * Inclusive `[min, max]` bounds for {@link filterProperty}. `null` (default)
   * means "no range yet" — the column is still bound, so a range set later
   * animates purely by uniform with no tile re-preparation. No effect unless
   * `filterProperty` is set.
   * @default null
   */
  filterRange?: DataFilterRange | null;

  /**
   * Optional soft `[min, max]` inside {@link filterRange}: columns between the
   * soft and hard bounds fade rather than hard-clip. No effect unless
   * `filterProperty` + `filterRange` are set.
   * @default null
   */
  filterSoftRange?: DataFilterRange | null;

  /**
   * Enable/disable the column filter without dropping the bound attribute.
   * Effective only when `filterProperty` + a valid `filterRange` are set.
   * @default true
   */
  filterEnabled?: boolean;

  /**
   * Outline stroke color (constant) — used when `stroked` is true.
   * @default [0, 0, 0, 255]
   */
  lineColor?: Color;

  /**
   * Upstream-vocabulary alias of {@link lineColor} (constant Color only — same
   * domain as the legacy prop; a function accessor warns once and falls back
   * to `lineColor`). When set, it wins over `lineColor`.
   */
  getLineColor?: ColorAccessorValue | null;

  /**
   * Outline stroke width (constant) in units specified by {@link lineWidthUnits}.
   * @default 1
   */
  lineWidth?: number;

  /**
   * Upstream-vocabulary alias of {@link lineWidth} (constant number only — a
   * function accessor warns once and falls back to `lineWidth`). When set, it
   * wins over `lineWidth`.
   */
  getLineWidth?: NumericAccessorValue | null;

  /**
   * Units for the outline width — ColumnLayer pass-through.
   * @default 'meters'
   */
  lineWidthUnits?: 'pixels' | 'meters' | 'common';

  /**
   * Multiplier applied to every outline width — ColumnLayer pass-through. Only
   * takes effect when `stroked` is true.
   * @default 1
   */
  lineWidthScale?: number;

  /**
   * Minimum outline width in pixels — ColumnLayer pass-through. Clamps the
   * rendered outline so it stays visible when zoomed out. Only takes effect
   * when `stroked` is true.
   * @default 0
   */
  lineWidthMinPixels?: number;

  /**
   * Maximum outline width in pixels — ColumnLayer pass-through. Clamps the
   * rendered outline so it stops growing when zoomed in. Only takes effect when
   * `stroked` is true.
   * @default Number.MAX_SAFE_INTEGER
   */
  lineWidthMaxPixels?: number;

  /**
   * Lighting material for extruded columns — ColumnLayer pass-through. `true`
   * for the default phong material, `false` to disable lighting, or a material
   * spec `{ambient, diffuse, shininess, specularColor}`.
   * @default true
   */
  material?: Material;

  /**
   * Fade-in duration for appearing columns (ms) — TimeFilterExtension window.
   * @default 300
   */
  fadeInDuration?: number;

  /**
   * Fade-out duration for disappearing columns (ms) — TimeFilterExtension
   * window.
   * @default 300
   */
  fadeOutDuration?: number;

  /**
   * Honor `prefers-reduced-motion`. When `true`, motion-amplifying surfaces
   * degrade gracefully: the space-time-cube lift (`timeHeightScale`, inherited
   * from the base props) is forced to 0 so the columns stay at their base
   * altitude — no rise, no flat↔cube squash morph. Time playback + fades are
   * unaffected. `false` (default) renders normally.
   * @default false
   */
  reducedMotion?: boolean;
}

/** Complete props accepted by {@link AnimatedColumnLayer}. */
export type AnimatedColumnLayerProps = _AnimatedColumnLayerProps &
  SpatioTemporalLayerProps;

/**
 * Where each own prop lands, and therefore whether editing it has to throw
 * away the per-tile sublayer cache. `'sublayer'` values are frozen into a
 * cached ColumnLayer at construction and ride {@link computeLayerPropsKey};
 * `'prepare'` values reach the GPU only through a tile's baked attributes,
 * which `computeStyleKey()` covers and the prepared-object identity check
 * turns into a sublayer rebuild.
 *
 * The {@link PropEffects} annotation makes the table total: a prop added to
 * {@link _AnimatedColumnLayerProps} without an entry here fails to compile,
 * which is the only thing standing between an unclassified prop and a stale
 * sublayer nobody notices until they look at the map.
 */
const COLUMN_PROP_EFFECTS: PropEffects<_AnimatedColumnLayerProps> = {
  diskResolution: 'sublayer',
  radius: 'sublayer',
  angle: 'sublayer',
  vertices: 'sublayer',
  offset: 'sublayer',
  coverage: 'sublayer',
  extruded: 'sublayer',
  wireframe: 'sublayer',
  filled: 'sublayer',
  stroked: 'sublayer',
  flatShading: 'sublayer',
  radiusUnits: 'sublayer',
  elevation: 'sublayer',
  getElevation: 'sublayer',
  elevationScale: 'sublayer',
  fillColor: 'sublayer',
  getFillColor: 'sublayer',
  // Categorical fill resolves entirely inside prepareTile — the palette, the
  // explicit mapping and its unknown-category fallback are baked into the
  // tile's getFillColor / instanceCategoryIndex buffers, never read while
  // constructing a sublayer (which takes the resolved palette off the prepared
  // tile). All three ride computeStyleKey().
  colorPalette: 'prepare',
  colorMapping: 'prepare',
  colorMappingDefault: 'prepare',
  filterProperty: 'sublayer',
  filterRange: 'sublayer',
  filterSoftRange: 'sublayer',
  filterEnabled: 'sublayer',
  lineColor: 'sublayer',
  getLineColor: 'sublayer',
  lineWidth: 'sublayer',
  getLineWidth: 'sublayer',
  lineWidthUnits: 'sublayer',
  lineWidthScale: 'sublayer',
  lineWidthMinPixels: 'sublayer',
  lineWidthMaxPixels: 'sublayer',
  material: 'sublayer',
  fadeInDuration: 'sublayer',
  fadeOutDuration: 'sublayer',
  reducedMotion: 'sublayer',
};

// Default color palette for categorical data (matches AnimatedPolygonLayer's
// opaque tableau ramp — columns are usually fully opaque so lighting reads).
const DEFAULT_PALETTE: Color[] = [
  [255, 140, 0, 255],
  [31, 119, 180, 255],
  [44, 160, 44, 255],
  [214, 39, 40, 255],
  [148, 103, 189, 255],
  [140, 86, 75, 255],
  [227, 119, 194, 255],
  [127, 127, 127, 255],
  [188, 189, 34, 255],
  [23, 190, 207, 255],
];

/**
 * Per-tile prepared data. Cached so the `data` object reference handed to
 * deck.gl is stable across renders — deck.gl compares `data` by reference (with
 * our dataComparator: ===) to decide whether to re-upload GPU buffers.
 *
 * Mirrors AnimatedPointLayer's PreparedTile shape.
 */
interface PreparedTile {
  /** Resolved (tile, layer) cache key. */
  tileKey: string;
  /** Hash of style props that affect the prepared `attributes`. */
  styleKey: string;
  /** Reference-stable data object for ColumnLayer's binary interface. */
  data: {
    length: number;
    attributes: Record<
      string,
      { value: any; size: number; normalized?: boolean }
    >;
  };
  /** Per-tile time reference; passed to TimeFilterExtension as `timeOffset`. */
  timeOffset: number;
  /**
   * When the GPU categorical-color path is active for this tile, the resolved
   * palette to pass to the extension. Null when constant color is in use.
   */
  gpuPalette: Color[] | null;
  /** Source tile + decoded columns — picking enrichment context (references, not copies). */
  tile: Tile;
  layerName: string;
  features: BinaryFeatures;
}

/**
 * Pad a 2D Float64Array of positions [x0,y0, x1,y1, ...] into a 3D buffer
 * [x0,y0,0, x1,y1,0, ...] for ColumnLayer's size-3 getPosition attribute. The
 * column's height is the elevation, so the z here is the base altitude (0 for
 * a 2D tile). One allocation per tile in the prepare step.
 */
function padPositionsTo3D(src: Float64Array, count: number): Float64Array {
  const out = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    out[i * 3] = src[i * 2];
    out[i * 3 + 1] = src[i * 2 + 1];
    // out[i * 3 + 2] = 0; (already zero-initialized)
  }
  return out;
}

/**
 * CPU-expand the index-driven {@link _AnimatedColumnLayerProps.colorPalette}
 * into a per-feature RGBA buffer, using the EXACT slot semantics
 * CategoryColorExtension applies on the GPU: {@link categoryIndicesToFloat32}
 * folds the NULL sentinel onto the trailing default slot and clamps palette
 * overflow onto the last real entry (warning once), and
 * {@link appendNullCategorySlot} supplies that trailing slot. Flipping
 * `extruded` therefore only moves WHERE the lookup happens — never what color
 * a feature gets.
 */
function expandPaletteColors(
  indices: Uint16Array,
  count: number,
  palette: readonly Color[],
  fallback: Color | undefined,
): Uint8Array {
  const slots = appendNullCategorySlot(palette, fallback);
  const lastSlot = slots[slots.length - 1];
  const resolved = categoryIndicesToFloat32(
    indices,
    count,
    palette.length,
    'AnimatedColumnLayer',
  );
  const out = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const c = slots[resolved[i]] ?? lastSlot;
    const o = i * 4;
    out[o] = c[0];
    out[o + 1] = c[1];
    out[o + 2] = c[2];
    out[o + 3] = c[3] ?? 255;
  }
  return out;
}

/**
 * Animated column layer with per-tile binary sublayers — time-filtered
 * extruded columns at point features (the 3D-bars primitive).
 *
 * Each visible tile produces one ColumnLayer instance that is cached across
 * renders. Time updates flow through getTime() on the extension; tile arrivals
 * only construct one new sublayer + one GPU upload, never touching the buffers
 * of already-loaded tiles.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`columns`**.
 * `_subLayerProps: { columns: { type: MyLayer, ...props } }` swaps the sublayer
 * class (default `ColumnLayer`) / overrides sublayer props (deck's
 * CompositeLayer contract).
 */
export class AnimatedColumnLayer<
  ExtraPropsT extends {} = {},
> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_AnimatedColumnLayerProps>
> {
  static layerName = 'AnimatedColumnLayer';

  static defaultProps: DefaultProps<AnimatedColumnLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    diskResolution: { type: 'number', value: 20, min: 4 },
    // Deliberate divergence from deck's ColumnLayer default of 1000 — see the
    // `radius` prop doc.
    radius: { type: 'number', value: 100, min: 0 },
    angle: { type: 'number', value: 0 },
    vertices: { type: 'object', value: null, optional: true, compare: true },
    offset: { type: 'array', value: [0, 0] },
    coverage: { type: 'number', value: 1, min: 0, max: 1 },
    extruded: true,
    wireframe: false,
    filled: true,
    stroked: false,
    flatShading: false,
    radiusUnits: 'meters',
    // Permissive descriptors ({type:'object'} validates anything): these props
    // legally hold a constant OR a column-name string, which the
    // 'color'/'number' validators would reject in deck's debug mode.
    elevation: { type: 'object', value: 1000, compare: true },
    fillColor: { type: 'object', value: [255, 140, 0, 255], compare: true },
    // Accessor-named aliases (see the prop docs): unset by default so the
    // legacy props win unless the caller opts into the upstream vocabulary.
    getElevation: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    getFillColor: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    getLineColor: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    getLineWidth: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    elevationScale: { type: 'number', value: 1, min: 0 },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE, compare: true },
    // Stable per-category color map (CPU-expanded) + its unknown-category
    // fallback. Permissive {type:'object'} descriptor: holds a string→Color
    // record OR null (rejected by 'object' validation only in some deck builds,
    // but null is the documented default → keep it permissive/optional).
    colorMapping: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    // Fallback color must be defined (never explicit-undefined) so its absence
    // resolves to fully-transparent, matching AnimatedPointLayer.
    colorMappingDefault: { type: 'color', value: [0, 0, 0, 0] },
    lineColor: { type: 'color', value: [0, 0, 0, 255] },
    lineWidth: { type: 'number', value: 1, min: 0 },
    lineWidthUnits: 'meters',
    // Outline-width scale/clamp trio (deck ColumnLayer defaults) — only take
    // effect when `stroked` is true. Symmetric with lineWidthUnits/lineWidth.
    lineWidthScale: { type: 'number', value: 1, min: 0 },
    lineWidthMinPixels: { type: 'number', value: 0, min: 0 },
    lineWidthMaxPixels: {
      type: 'number',
      value: Number.MAX_SAFE_INTEGER,
      min: 0,
    },
    // Same permissive descriptor ColumnLayer uses: boolean or material spec.
    material: { type: 'object', value: true, compare: true },
    // Fade ramps, forwarded to TimeFilterExtension (window mode).
    fadeInDuration: { type: 'number', value: 300, min: 0 },
    fadeOutDuration: { type: 'number', value: 300, min: 0 },

    // Column range filter (STTDataFilterExtension). Unset ⇒ not installed.
    // Permissive {type:'object'} descriptors: filterProperty holds a column
    // name; the ranges hold a [min,max] tuple OR null (rejected by 'array').
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
    // prefers-reduced-motion gate for the space-time-cube lift. false (default)
    // keeps the timeHeightScale render byte-identical.
    reducedMotion: false,
  };

  /** Per-tile prepared-data cache. Pruned to the live tile set each render. */
  private preparedTileCache = new Map<string, PreparedTile>();

  /**
   * Per-tile sublayer-instance cache. Returning the SAME ColumnLayer reference
   * across renderLayers() calls lets deck.gl short-circuit prop diff entirely
   * — see AnimatedPointLayer for the frame-time rationale.
   */
  private sublayerCache = new Map<
    string,
    { layer: ColumnLayer; preparedKey: PreparedTile; layerPropsKey: string }
  >();

  /** Digest of every prop baked into a sublayer at construction time. */
  private lastLayerPropsKey: string = '';
  /** Tile-array identity from the previous render — see AnimatedTripsLayer.lastTilesRef. */
  private lastTilesRef: Tile[] | null = null;

  /**
   * Singleton TimeFilterExtension reused by every sublayer. Columns animate in
   * window-mode (whole feature on/off + fade), so only the per-feature
   * start/end attributes are needed — the per-vertex time attribute is unused.
   */
  private readonly timeFilterExtension = new TimeFilterExtension({
    mode: 'window',
  });

  /**
   * Singleton CategoryColorExtension. Always installed; when a tile lacks
   * `instanceCategoryIndex` the shader branch is gated off via the
   * `useCategoryColor` uniform.
   */
  private readonly categoryColorExtension = new CategoryColorExtension();

  /**
   * Singleton STTDataFilterExtension. Composed into a sublayer's extension list
   * ONLY when `filterProperty` is set (a per-layer constant, so the list stays
   * stable across this layer's sublayers). Constructed unconditionally — a
   * no-op object alloc; it contributes no attribute, uniform or shader unless
   * actually installed.
   */
  private readonly dataFilterExtension = new STTDataFilterExtension({
    filterSize: 1,
  });

  /**
   * Stable getTime reference. Critical: deck.gl re-runs work when accessor
   * function references change; a fresh arrow every render defeats the cache.
   */
  private readonly boundGetTime: () => number = () => this.getCurrentTime();

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.preparedTileCache.clear();
    this.sublayerCache.clear();
  }

  /**
   * Accessor-alias resolution: the upstream-named alias wins when
   * set; a function-valued alias warns once and falls back to the legacy prop.
   * Same value domain as the legacy props (constant or column name).
   */
  private fillColorValue(): Color | string | undefined {
    return resolveAccessorAlias(
      'AnimatedColumnLayer',
      'getFillColor',
      this.props.getFillColor,
      this.props.fillColor,
    );
  }

  private elevationValue(): number | string | undefined {
    return resolveAccessorAlias(
      'AnimatedColumnLayer',
      'getElevation',
      this.props.getElevation,
      this.props.elevation,
    );
  }

  private lineColorValue(): Color {
    return resolveAccessorAlias(
      'AnimatedColumnLayer',
      'getLineColor',
      this.props.getLineColor as Color | undefined,
      this.props.lineColor,
    );
  }

  private lineWidthValue(): number {
    return resolveAccessorAlias(
      'AnimatedColumnLayer',
      'getLineWidth',
      this.props.getLineWidth as number | undefined,
      this.props.lineWidth,
    );
  }

  /**
   * Resolve `filterProperty` to a baked-column NAME. Accessor-alias of deck's
   * `getFilterValue`: a function-valued prop warns once and is ignored (there
   * is no legacy prop, so the fallback is "no filter" — `undefined`).
   */
  private filterPropertyValue(): string | undefined {
    return resolveAccessorAlias<string | undefined>(
      'AnimatedColumnLayer',
      'filterProperty',
      this.props.filterProperty,
      undefined,
    );
  }

  /**
   * Effective space-time-cube lift. `reducedMotion` forces it to 0 so the
   * columns stay at their base altitude for viewers who prefer reduced motion
   * (no rise, no squash morph); otherwise the caller's `timeHeightScale`
   * (inherited from the base props) rides through.
   */
  private effectiveTimeHeightScale(): number {
    return this.props.reducedMotion ? 0 : this.props.timeHeightScale;
  }

  /**
   * Compute a digest of the layer-level props that affect every sublayer. When
   * this changes we throw away the entire sublayer cache.
   */
  private computeLayerPropsKey(): string {
    return buildLayerPropsKey<_AnimatedColumnLayerProps>(
      this.props,
      COLUMN_PROP_EFFECTS,
      {
        // Values the sublayer is actually built from. Each upstream-named alias
        // wins over its legacy prop, so keying the legacy prop raw would leave
        // every cached sublayer at the old value when only the alias changes.
        overrides: {
          fillColor: this.fillColorValue(),
          elevation: this.elevationValue(),
          lineColor: this.lineColorValue(),
          lineWidth: this.lineWidthValue(),
          // Resolves to a column NAME; a function-valued prop is ignored, and
          // keying it raw would clear the cache on every render for a caller
          // who passes a fresh function that changes nothing.
          filterProperty: this.filterPropertyValue(),
        },
        extra: [
          // Composite props that getSubLayerProps bakes into every sublayer
          // (opacity/pickable/visible, coordinateSystem, modelMatrix, highlight
          // props, _subLayerProps overrides…) plus the user's updateTriggers.
          inheritedPropsDigest(this.props),
          updateTriggersDigest(this.props.updateTriggers),
          // Inherited time props the sublayers carry. Uniform-only edits, so
          // they rebuild the cached sublayers (whose props hold the values)
          // rather than re-preparing tiles.
          this.props.timeWindow,
          // reducedMotion forces the space-time-cube lift to 0, so the key has
          // to track the EFFECTIVE scale, not the raw prop.
          this.effectiveTimeHeightScale(),
          this.props.timeHeightOrigin,
        ],
      },
    );
  }

  /**
   * Pre-`renderLayers()` prepare for one tile, so the chassis can meter
   * tile commits per frame (`tileCommitBudgetMs`); the result lands in the
   * prepared-tile cache the render loop reads.
   */
  protected warmTile(tile: Tile): void {
    for (const tileLayer of tile.layers) this.prepareTile(tile, tileLayer);
  }

  renderLayers(): Layer[] {
    const probe = isProbeEnabled();
    const t0 = probe ? performance.now() : 0;
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) {
      this.preparedTileCache.clear();
      this.sublayerCache.clear();
      this.lastTilesRef = null;
      return [];
    }

    // Prune cache only when the tile-array ref changed — when the parent hands
    // us the same `state.tiles` instance, the live and cached sets are
    // identical by construction and the walks are pure overhead.
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

    // Any layer-level prop change invalidates every cached sublayer.
    const layerPropsKey = this.computeLayerPropsKey();
    if (layerPropsKey !== this.lastLayerPropsKey) {
      this.lastLayerPropsKey = layerPropsKey;
      this.sublayerCache.clear();
    }

    const sublayers: Layer[] = [];
    // Draw only the tiles whose covering time range can intersect the render
    // window; the rest stay resident (caches intact) until the playhead wakes
    // them — see SpatioTemporalLayer.cullTilesByTimeRange.
    const liveTiles = this.cullTilesByTimeRange(tiles);
    for (const tile of liveTiles) {
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

    if (probe) {
      emit('renderLayers', {
        layer: 'AnimatedColumnLayer',
        tiles: tiles.length,
        liveTiles: liveTiles.length,
        sublayers: sublayers.length,
        ms: performance.now() - t0,
      });
    }
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `AnimatedColumnLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`,
      );
    }
    return sublayers;
  }

  /**
   * styleKey digest of the props that change a tile's prepared `attributes`
   * (which color/elevation column, palette content). Used by the per-tile
   * cache check.
   */
  private computeStyleKey(): string {
    const fillColor = this.fillColorValue();
    const elevation = this.elevationValue();
    const fillColorProp = typeof fillColor === 'string' ? fillColor : '';
    const elevationProp = typeof elevation === 'string' ? elevation : '';
    // A colorMapping is CPU-expanded into the prepared getFillColor buffer, so
    // any change to it (or its NULL/unmapped fallback) must re-prepare the tile.
    const mapping = this.props.colorMapping;
    const mapDefault = (this.props.colorMappingDefault ?? [0, 0, 0, 0]).join(
      ',',
    );
    // Filter column NAME is baked into the `filterValue` attribute, so a change
    // must re-prepare tiles (and, via the new preparedKey, rebuild sublayers —
    // covering the unset↔set toggle that adds/removes STTDataFilterExtension).
    const filterProp = this.filterPropertyValue() ?? '';
    // `extruded` SELECTS the categorical-color branch (CPU-expanded RGBA when
    // lit, GPU category index when flat), so it changes the prepared attributes
    // and must re-prepare the tile — not just rebuild the sublayer.
    const extruded = this.props.extruded !== false ? 1 : 0;
    // Palette identity matters only when fillColor is a column name. Digests
    // are memoized per object reference (style-digest.ts), so this stays a
    // WeakMap lookup per tile, not a re-serialization.
    return `${fillColorProp}|${elevationProp}|${
      fillColorProp
        ? colorListDigest(this.props.colorPalette ?? DEFAULT_PALETTE)
        : 0
    }|${mapping ? `m${colorMappingDigest(mapping)}` : 'g'}|d${mapDefault}|x${extruded}|f${filterProp}|${updateTriggersDigest(
      this.props.updateTriggers,
    )}`;
  }

  /**
   * Fetch the cached binary `data` object for a single tile, building (and
   * caching) it on a miss. Returns a reference-stable PreparedTile so deck.gl
   * can short-circuit GPU re-uploads.
   */
  private prepareTile(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0) return null;
    // ColumnLayer is instanced AT POINTS: `positions` is indexed by FEATURE.
    // A linestring/polygon tile would silently bunch every bar onto the first
    // few paths' leading vertices — warn once and skip instead.
    if (
      !expectGeometry(
        binary.geometryType,
        [GeometryType.Point],
        'AnimatedColumnLayer',
        tileLayer.name,
      )
    )
      return null;
    const styleKey = this.computeStyleKey();
    const tileKey = tileLayerKey(tile.id, tileLayer.name);
    const cached = this.preparedTileCache.get(tileKey);
    const probe = isProbeEnabled();
    if (cached && cached.styleKey === styleKey) {
      if (probe) {
        emit('tilePrepare', {
          layer: 'AnimatedColumnLayer',
          tileKey,
          cached: true,
          ms: 0,
        });
      }
      return cached;
    }

    const fillColorValue = this.fillColorValue();
    const elevationValue = this.elevationValue();
    const fillColorProp =
      typeof fillColorValue === 'string' ? fillColorValue : '';
    const elevationProp =
      typeof elevationValue === 'string' ? elevationValue : '';

    const t0 = probe ? performance.now() : 0;
    const count = binary.featureCount;
    const srcDims = binary.positionDimensions ?? 2;

    // ColumnLayer expects size=3 positions (the z is the column's base
    // altitude). Keep a stride-3 buffer zero-copy; pad a 2D buffer once.
    const positions: Float64Array =
      srcDims === 3
        ? binary.positions
        : padPositionsTo3D(binary.positions, count);

    const attributes: PreparedTile['data']['attributes'] = {
      getPosition: { value: positions, size: 3 },
      // Extension-registered attribute names — must match
      // TimeFilterExtension.initializeState exactly. Zero-copy: the tile's own
      // Float32Arrays (relative to binary.timeOffset) ride straight to the GPU.
      instanceStartTime: { value: binary.startTimes, size: 1 },
      instanceEndTime: { value: binary.endTimes, size: 1 },
    };

    let gpuPalette: Color[] | null = null;

    // Property-driven (categorical) fill color. Three paths:
    //  - `colorMapping` set → CPU branch: a category STRING can't be hashed to a
    //    palette slot on the GPU, so expand the explicit map into a per-feature
    //    RGBA `getFillColor` buffer via the shared helper. Stable per-category:
    //    a category always draws its assigned color regardless of tile index.
    //  - EXTRUDED (the default) → CPU branch as well, this time over the
    //    index-driven `colorPalette`. ColumnLayer lights the column BEFORE
    //    DECKGL_FILTER_COLOR (gouraud into `vColor`, or phong into `fragColor`
    //    under flatShading), and the extension's hook REPLACES rgb — so a GPU
    //    palette write would discard the lit color and flatten every bar into a
    //    single-tone silhouette. Riding `instanceFillColors` keeps the lighting.
    //  - flat disks (`extruded: false`) → GPU branch: hand category indices to
    //    the CategoryColorExtension. Nothing is lit there, so the palette write
    //    is exactly what we want and the per-tile RGBA expansion is skipped.
    if (fillColorProp) {
      const cat = binary.categoricalProps[fillColorProp];
      if (cat) {
        const palette = this.props.colorPalette ?? DEFAULT_PALETTE;
        const fallback = this.props.colorMappingDefault as Color | undefined;
        if (this.props.colorMapping) {
          attributes.getFillColor = {
            value: coreExpandCategoricalColors(
              binary,
              {
                property: fillColorProp,
                colorMapping: this.props.colorMapping as Record<
                  string,
                  RGBA255
                >,
                colorMappingDefault: (fallback ?? [0, 0, 0, 0]) as RGBA255,
              },
              'u8',
            ) as Uint8Array,
            size: 4,
            normalized: true,
          };
        } else if (this.props.extruded !== false) {
          attributes.getFillColor = {
            value: expandPaletteColors(cat.indices, count, palette, fallback),
            size: 4,
            normalized: true,
          };
        } else {
          attributes.instanceCategoryIndex = {
            value: categoryIndicesToFloat32(
              cat.indices,
              count,
              palette.length,
              'AnimatedColumnLayer',
            ),
            size: 1,
          };
          gpuPalette = appendNullCategorySlot(palette, fallback);
        }
      }
    }

    // Property-driven column height — already Float32Array, rides zero-copy.
    // ColumnLayer is instanced at points, so this is one value PER FEATURE
    // (size 1), like the point layer's getRadius — NOT per-vertex.
    if (elevationProp) {
      const values = binary.numericProps[elevationProp];
      if (values) {
        attributes.getElevation = { value: values, size: 1 };
      }
    }

    // Column range filter (STTDataFilterExtension): bind the named numeric column
    // to the `filterValue` attribute zero-copy (already a Float32Array). Absent
    // column ⇒ no attribute baked → the sublayer idles the filter for this tile
    // (renders unfiltered), mirroring how a missing color/elevation column falls
    // back. A categorical column can't be range-filtered in v1 — warn once.
    const filterProp = this.filterPropertyValue();
    if (filterProp) {
      const values = binary.numericProps[filterProp];
      if (values) {
        attributes.filterValue = { value: values, size: 1 };
      } else if (binary.categoricalProps[filterProp]) {
        warnOnce(
          'AnimatedColumnLayer:filterPropertyCategorical',
          `[AnimatedColumnLayer] filterProperty "${filterProp}" is a categorical ` +
            'column; v1 range-filters NUMERIC columns only. The filter is ignored ' +
            'for tiles where the column is categorical.',
        );
      }
    }

    const prepared: PreparedTile = {
      tileKey,
      styleKey,
      data: { length: count, attributes },
      timeOffset: binary.timeOffset,
      gpuPalette,
      tile,
      layerName: tileLayer.name,
      features: binary,
    };
    this.preparedTileCache.set(tileKey, prepared);
    if (probe) {
      emit('tilePrepare', {
        layer: 'AnimatedColumnLayer',
        tileKey,
        cached: false,
        features: count,
        gpuPalette: gpuPalette !== null,
        ms: performance.now() - t0,
      });
    }
    return prepared;
  }

  private buildSublayer(prepared: PreparedTile): ColumnLayer {
    // `Required<>`-typed: the defaultProps value guarantees values here.
    const timeWindow = this.props.timeWindow;
    const elevationValue = this.elevationValue();
    const fillColorValue = this.fillColorValue();
    const constElevation =
      typeof elevationValue === 'number' ? elevationValue : 1000;
    const constFillColor = (
      Array.isArray(fillColorValue)
        ? fillColorValue
        : ([255, 140, 0, 255] as Color)
    ) as Color;

    // CategoryColorExtension props: when this tile uses the GPU palette path we
    // pass the resolved palette + useCategoryColor=true. Otherwise the
    // extension idles (its shader branch is gated by useCategoryColor).
    const useGpuCategory = prepared.gpuPalette !== null;
    if (useGpuCategory && prepared.gpuPalette!.length > CATEGORY_PALETTE_SIZE) {
      warnOnce(
        'AnimatedColumnLayer:paletteOverflow',
        `[AnimatedColumnLayer] colorPalette has ${prepared.gpuPalette!.length} ` +
          `entries; only the first ${CATEGORY_PALETTE_SIZE} will be used by ` +
          'CategoryColorExtension.',
      );
    }

    // Column range filter: install STTDataFilterExtension only when a
    // filterProperty is set (a per-layer constant → the list stays stable
    // across this layer's sublayers). `hasFilter` is whether THIS tile actually
    // baked the column — a tile lacking it idles the filter (renders all).
    const filterProp = this.filterPropertyValue();
    const hasFilter = !!prepared.data.attributes.filterValue;

    // Keep the extension list constant across sublayers — see
    // animated-trips-layer.ts for the cache-storm rationale. User extensions
    // from the top-level `extensions` prop are appended (composeExtensions).
    const extensions = this.composeExtensions([
      this.timeFilterExtension,
      this.categoryColorExtension,
      // Column range filter, when a filterProperty is set. Multiplies its own
      // in/out (or soft-fade) factor into color.a — commutes with the time and
      // categorical alphas, so it composes cleanly with both.
      ...(filterProp ? [this.dataFilterExtension] : []),
    ]);

    // getSubLayerProps inheritance (opacity/pickable/visible, coordinate
    // system, highlight props, …) + user `_subLayerProps.columns` overrides.
    // Only runs inside this cache-gated build path — never per frame.
    const props = this.composeSubLayerProps('columns', prepared.tileKey, {
      data: prepared.data as any,
      // Identity comparator: deck.gl skips prop-diff for `data` entirely when
      // the same object reference comes back. Pairs with the preparedTileCache
      // which guarantees stable identity.
      dataComparator: (a: any, b: any) => a === b,

      // Geometry / styling pass-through.
      diskResolution: this.props.diskResolution,
      radius: this.props.radius,
      radiusUnits: this.props.radiusUnits,
      angle: this.props.angle,
      vertices: this.props.vertices,
      offset: this.props.offset,
      coverage: this.props.coverage,
      extruded: this.props.extruded,
      wireframe: this.props.wireframe,
      filled: this.props.filled,
      stroked: this.props.stroked,
      flatShading: this.props.flatShading,
      elevationScale: this.props.elevationScale,
      material: this.props.material,
      lineWidthUnits: this.props.lineWidthUnits,
      lineWidthScale: this.props.lineWidthScale,
      lineWidthMinPixels: this.props.lineWidthMinPixels,
      lineWidthMaxPixels: this.props.lineWidthMaxPixels,

      // Constant fallbacks — used when the binary attribute is absent. The
      // binary getElevation / getFillColor wins when present.
      getElevation: constElevation,
      getFillColor: constFillColor,
      getLineColor: this.lineColorValue(),
      getLineWidth: this.lineWidthValue(),

      extensions,

      // TimeFilterExtension wiring — per-tile timeOffset and window.
      getTime: this.boundGetTime,
      timeOffset: prepared.timeOffset,
      timeWindow,
      fadeInDuration: this.props.fadeInDuration,
      fadeOutDuration: this.props.fadeOutDuration,
      // Time-as-height (space-time cube). Window mode lifts whole columns by
      // start time — a single uniform, so animating the flat↔cube morph is
      // free. Forced to 0 under reducedMotion so the columns stay flat.
      timeHeightScale: this.effectiveTimeHeightScale(),
      timeHeightOrigin: this.props.timeHeightOrigin,

      // TileLayer convention: the source tile rides on the sublayer so the base
      // getPickingInfo can enrich info.tile / decode the picked feature.
      tile: prepared.tile,
      sttFeatures: prepared.features,

      // Always set `useCategoryColor` so tests / debug tooling can distinguish
      // the two paths via prop inspection. The extension itself only does work
      // when the flag is true.
      useCategoryColor: useGpuCategory,
      ...(useGpuCategory ? { categoryPalette: prepared.gpuPalette! } : {}),

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
    // `_subLayerProps: { columns: { type } }` swaps the sublayer class — the
    // CompositeLayer-native override point.
    const SubLayerClass = this.getSubLayerClass('columns', ColumnLayer);
    return new SubLayerClass(props as any);
  }
}

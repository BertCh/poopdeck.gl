// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * AnimatedPointLayer - GPU-efficient point rendering with time filtering.
 *
 * ARCHITECTURE (v3 - Per-tile binary sublayers):
 * - One ScatterplotLayer per (tile, layer) pair. No cross-tile consolidation.
 * - Each sublayer uses deck.gl's binary `data: { length, attributes }`
 *   interface, with positions / startTimes / endTimes referenced DIRECTLY
 *   from the tile's BinaryFeatures (zero-copy from the Arrow buffer).
 * - Per-tile `timeOffset` — each sublayer rebases time independently in its
 *   own TimeFilterExtension instance. No layer-wide rebasing pass.
 * - `getTime` callback drives the window uniform per draw without layer
 *   recreation, so the demo's tick handler only calls `setNeedsRedraw()`.
 * - Prepared per-tile data is cached so the `data` object reference is
 *   stable across renderLayers() calls; deck.gl short-circuits GPU
 *   re-uploads when the reference matches.
 *
 * Streaming is additive: a new tile creates one sublayer and one GPU upload.
 * Existing tiles' GPU buffers are untouched.
 *
 * The previous v2 consolidation path allocated a single ~3.6 GB chunk at
 * 100M points (one Float64Array for positions + two Float32Array for times)
 * and re-uploaded it on every tile arrival. Per-tile sublayers replace that
 * with one ~36 MB Arrow-backed view per tile and zero copies.
 *
 * Categorical colors lift to the GPU via CategoryColorExtension when the
 * caller does NOT provide a `colorMapping` (which is inherently CPU-side
 * because it indexes by category STRING). With a mapping set, we fall back
 * to the legacy CPU-expansion path on the cold tile-prepare step.
 *
 * CUMULATIVE MODE (`cumulative: true`) takes a different render path. The
 * "draws itself" datasets widen the loader window to the whole dataset span,
 * so tiles are never evicted and the per-tile-sublayer count climbs into the
 * thousands by end of playback — one draw call each, re-issued on every
 * pan/zoom frame. That is what collapses a long cumulative playback to
 * single-digit FPS. So in cumulative mode we pack points append-only into a
 * small number of consolidated "slabs" (one ScatterplotLayer per slab, capped
 * at SLAB_CAPACITY_POINTS): frozen slabs keep a stable `data` ref (zero
 * re-upload), only the single open slab grows. Per-tile times are rebased to
 * one common slab offset — Float32-safe here because cumulative reveal already
 * tolerates tens-of-seconds time quantization (see TimeFilterExtension.draw).
 */

import { ScatterplotLayer } from '@deck.gl/layers';
import type {
  Color,
  DefaultProps,
  GetPickingInfoParams,
  Layer,
  LayerContext,
} from '@deck.gl/core';
import {
  SpatioTemporalLayer,
  SpatioTemporalLayerProps,
  SpatioTemporalPickingInfo,
} from '../spatiotemporal-layer';
import { TimeFilterExtension } from '../../extensions/time-filter-extension';
import { SplatExtension } from '../../extensions/splat-extension';
import {
  CategoryColorExtension,
  CATEGORY_PALETTE_SIZE,
} from '../../extensions/category-color-extension';
import { emit } from '../../lib/telemetry';
import { warnOnce } from '../../lib/log';
import {
  colorListDigest,
  colorMappingDigest,
  functionId,
  inheritedPropsDigest,
  updateTriggersDigest,
} from '../../lib/style-digest';
import { resolveAccessorAlias } from '../../lib/accessor-alias';
import type { ColorAccessorValue, NumericAccessorValue } from '../../lib/accessor-alias';
import { getFeatureProperties, DEFAULT_CATEGORICAL_PALETTE } from '@poopdeck.gl/core';
import type { Tile, TileId, Layer as TileLayer, BinaryFeatures } from '@poopdeck.gl/core';
import { expandCategoricalColors as coreExpandCategoricalColors } from '@poopdeck.gl/core/style';
import type { RGBA255 } from '@poopdeck.gl/core/style';

const DEBUG = false;

/**
 * Cumulative consolidation: target points per consolidated slab. Sized so a
 * metro-scale cumulative playback resolves to a handful of slabs (≈ a handful
 * of draw calls) instead of thousands of per-tile sublayers, while keeping the
 * open slab's per-append re-upload small (≈ 250k × 36 B ≈ 9 MB worst case).
 */
const SLAB_CAPACITY_POINTS = 250_000;

/** Props added by {@link AnimatedPointLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link AnimatedPointLayerProps}). */
export interface _AnimatedPointLayerProps {
  /**
   * Radius scale multiplier.
   * @default 1
   */
  radiusScale?: number;

  /**
   * Radius units.
   * @default 'pixels'
   */
  radiusUnits?: 'pixels' | 'meters' | 'common';

  /**
   * Fill color — constant {@link Color}, or property name for categorical coloring.
   * @default [255, 128, 0, 255]
   */
  fillColor?: Color | string;

  /**
   * Upstream-vocabulary alias of {@link fillColor}. NOTE: unlike upstream
   * deck.gl, this accepts a constant Color OR a property-column NAME — NOT a
   * function accessor (binary tiles can't run per-feature JS; a function
   * warns once and falls back to `fillColor`). When set, it wins over
   * `fillColor`.
   */
  getFillColor?: ColorAccessorValue | null;

  /**
   * Radius — constant number, or property name for per-feature radius.
   * @default 5
   */
  radius?: number | string;

  /**
   * Upstream-vocabulary alias of {@link radius}. Accepts a constant number
   * OR a property-column NAME — NOT a function accessor (a function warns
   * once and falls back to `radius`). When set, it wins over `radius`.
   */
  getRadius?: NumericAccessorValue | null;

  /** Color palette for categorical `fillColor`. */
  colorPalette?: Color[];

  /**
   * Explicit category-to-color map. When set together with a string `fillColor`
   * property, each feature's color is `colorMapping[categoryValue]`, using
   * `colorMappingDefault` (or transparent) for unknown values. This is the
   * only way to get stable colors across tiles whose categorical column
   * contains different category subsets — the first-seen palette index
   * fallback assigns the same band a different palette slot per tile.
   *
   * NOTE: setting this forces the CPU palette-expansion path (one Uint8Array
   * RGBA per tile) because the GPU palette texture has no way to look up by
   * the category STRING. With `colorMapping` unset, the GPU CategoryColorExtension
   * handles the lookup in the fragment shader against the `colorPalette`.
   */
  colorMapping?: Record<string, Color> | null;

  /** Fallback color for categories absent from `colorMapping`. */
  colorMappingDefault?: Color;

  /**
   * Per-point RGB straight from three NUMERIC columns (each 0–255), e.g. LIDAR
   * returns colored by projecting them into camera images at build time (see
   * `waymo_extract.py --colorize`). When set to `['r','g','b']`, each feature's
   * fill is `[r, g, b, 255]` read directly from those columns — no palette, no
   * category lookup. Takes precedence over `fillColor`/`colorMapping`. Ignored
   * (falls back to the normal color path) if any of the three columns is absent
   * from the tile. Alpha comes from the layer `opacity`.
   */
  rgbColorColumns?: [string, string, string] | null;

  /**
   * Per-point RGBA from ONE interleaved VECTOR column (`FixedSizeList<UInt8,4>`,
   * baked by `stt-build --vector-group name=r,g,b,a:u8`). When the tile carries
   * it, the contiguous u8 buffer is bound to `getFillColor` **zero-copy** — no
   * per-point re-interleave on the main thread (the GPU-ready analogue of
   * {@link rgbColorColumns}). Takes precedence over every other colour path.
   * Ignored if the column is absent from the tile. @default 'point_rgba'
   */
  colorVectorColumn?: string | null;

  /**
   * Render points as soft gaussian "splats" instead of hard disks (installs
   * {@link SplatExtension}). Overlapping splats blend into continuous surfaces —
   * a colored point-cloud / photogrammetry look. Best with a slightly larger
   * `radius`, some transparency, and `billboard: true`. @default false
   */
  splat?: boolean;

  /**
   * Per-feature radius transform, applied to the numeric value of the
   * `radius` property column before the GPU receives it. Useful for
   * non-linear scalings (e.g. magnitude → area).
   */
  radiusTransform?: ((value: number) => number) | null;

  /** Minimum on-screen radius in pixels. Forwarded to ScatterplotLayer. */
  radiusMinPixels?: number;

  /** Maximum on-screen radius in pixels. Forwarded to ScatterplotLayer. */
  radiusMaxPixels?: number;

  /** Outline stroke width in pixels. Forwarded to ScatterplotLayer. */
  lineWidthMinPixels?: number;

  /**
   * Whether to render an outline stroke around each point.
   * @default false
   */
  stroked?: boolean;

  /** Stroke color (constant). */
  strokeColor?: Color;

  /**
   * Upstream-vocabulary alias of {@link strokeColor} (constant Color only —
   * same domain as the legacy prop; a function accessor warns once and falls
   * back to `strokeColor`). When set, it wins over `strokeColor`.
   */
  getLineColor?: ColorAccessorValue | null;

  /**
   * Outline stroke width — constant number, or property name for per-feature
   * width. Interpreted in {@link lineWidthUnits} (deck parity: meters by
   * default) and clamped by `lineWidthMinPixels`/`lineWidthMaxPixels`.
   * NOTE: in `cumulative` mode a property-column value is ignored (slabs
   * don't pack stroke widths) — the constant branch still applies.
   * @default 1
   */
  strokeWidth?: number | string;

  /**
   * Upstream-vocabulary alias of {@link strokeWidth}. Accepts a constant
   * number OR a property-column NAME — NOT a function accessor (a function
   * warns once and falls back to `strokeWidth`). When set, it wins over
   * `strokeWidth`.
   */
  getLineWidth?: NumericAccessorValue | null;

  /**
   * Units for `strokeWidth` — ScatterplotLayer pass-through. Deck-parity
   * default: world-space meters (unlike `radiusUnits`, whose STT default is
   * 'pixels').
   * @default 'meters'
   */
  lineWidthUnits?: 'pixels' | 'meters' | 'common';

  /**
   * Stroke width multiplier — ScatterplotLayer pass-through.
   * @default 1
   */
  lineWidthScale?: number;

  /** Maximum on-screen stroke width in pixels. Forwarded to ScatterplotLayer. */
  lineWidthMaxPixels?: number;

  /**
   * Render markers as billboards (always face the camera in 3D views) —
   * ScatterplotLayer pass-through.
   * @default false
   */
  billboard?: boolean;

  /**
   * Smooth-edge antialiasing — ScatterplotLayer pass-through. Disable to fix
   * blending artifacts under some depth-test `parameters` configurations.
   * @default true
   */
  antialiasing?: boolean;

  /**
   * Whether to fill the marker.
   * @default true
   */
  filled?: boolean;

  /**
   * Fade-in duration for appearing points (ms).
   * @default 300
   */
  fadeInDuration?: number;

  /**
   * Fade-out duration for disappearing points (ms).
   * @default 300
   */
  fadeOutDuration?: number;

  /**
   * Wake length in milliseconds. When > 0, switches the layer into a
   * one-sided "ship wake" rendering: each point is visible only while
   * `0 <= currentTime - startTime <= wakeLength`, its alpha fades linearly
   * to 0 at the trailing edge, and its on-screen radius shrinks to
   * `wakeTailScale` × head radius. Takes precedence over the symmetric
   * window/fadeIn/fadeOut filter inherited from TimeFilterExtension.
   *
   * The caller must ensure `timeWindow >= 2 × wakeLength` so the tile
   * loader actually fetches the past half of the wake — the shader filter
   * is independent of the tile-loading window.
   */
  wakeLength?: number;

  /**
   * Trailing-edge size multiplier in wake mode (0..1). Head = 1.0, tail =
   * `wakeTailScale`. Defaults to 0.15.
   */
  wakeTailScale?: number;

  /**
   * Cumulative ("draw and persist") mode — see TimeFilterExtension. When true,
   * each point appears at its `startTime` and stays visible for the rest of
   * playback (the map "draws itself"). `fadeInDuration` doubles as the appear
   * ramp. The caller must widen the tile loader's window so revealed tiles stay
   * resident (the shader does the progressive reveal, not the loader).
   * @default false
   */
  cumulative?: boolean;

  /**
   * Enable 3D positions (altitude / elevation). The v3 layer infers 3D from
   * the tile's `positionDimensions` automatically — the prop is kept for
   * API compatibility with v2 callers and forwarded as a hint. 2D tiles
   * are padded with z=0; 3D tiles ride zero-copy.
   *
   * Setting {@link elevationProperty} is sufficient to source per-point z from
   * a numeric column regardless of this flag — `use3D` is purely an enabling
   * hint and does not gate the elevation column.
   */
  use3D?: boolean;

  /**
   * Property name to source per-point elevation (z) from a numeric tile
   * column. The tile geometry is 2D (lon/lat) — z comes ONLY from this
   * property: each point is placed at `z = column[i] × elevationScale`.
   * Negative and zero values pass through unchanged (e.g. below-grade to
   * rooftop LIDAR returns). With this unset (the common case) z stays 0,
   * byte-identical to a flat 2D render.
   *
   * Applies to BOTH the per-tile sublayer path and the cumulative slab path.
   */
  elevationProperty?: string | null;

  /**
   * Multiplier applied to each {@link elevationProperty} value before it
   * becomes the point's z. No effect when `elevationProperty` is unset.
   * @default 1
   */
  elevationScale?: number;
}

/** Complete props accepted by {@link AnimatedPointLayer}. */
export type AnimatedPointLayerProps = _AnimatedPointLayerProps & SpatioTemporalLayerProps;

// Default color palette for categorical data — the single source of truth in
// @poopdeck.gl/core, shared with the maplibre adapter.
const DEFAULT_PALETTE: Color[] = DEFAULT_CATEGORICAL_PALETTE;

/**
 * Per-tile prepared data. Cached so the `data` object reference handed to
 * deck.gl is stable across renders — deck.gl compares `data` by reference
 * (with our dataComparator: ===) to decide whether to re-upload GPU buffers.
 *
 * Mirrors AnimatedTripsLayer / AnimatedPathLayer's PreparedTile shape.
 */
interface PreparedTile {
  /** Resolved (tile, layer) cache key. */
  tileKey: string;
  /** Hash of style props that affect the prepared `attributes`. */
  styleKey: string;
  /** Reference-stable data object for ScatterplotLayer's binary interface. */
  data: {
    length: number;
    attributes: Record<string, { value: any; size: number; normalized?: boolean }>;
  };
  /** Per-tile time reference; passed to TimeFilterExtension as `timeOffset`. */
  timeOffset: number;
  /**
   * When the GPU categorical-color path is active for this tile, the resolved
   * palette to pass to the extension. Null when CPU-side colors / constant
   * color are in use.
   */
  gpuPalette: Color[] | null;
  /** Source tile + decoded columns — picking enrichment context (references, not copies). */
  tile: Tile;
  layerName: string;
  features: BinaryFeatures;
}

/**
 * One absorbed tile's feature range within a consolidated slab. Holds the
 * tile ID (not the Tile) — a slab outlives spatially-evicted tiles, and a
 * live reference would pin their decoded Arrow buffers in memory, defeating
 * the slab's whole copy-then-release design. `getPickingInfo` resolves the
 * id against the CURRENT visible set; an absorbed-but-evicted tile yields
 * `info.tile === null`.
 */
interface SlabProvenance {
  /** First slab feature index this tile's points occupy. */
  start: number;
  count: number;
  tileId: TileId;
  layerName: string;
}

/** Binary-search the provenance range containing slab feature `index`. */
function findSlabProvenance(
  entries: SlabProvenance[],
  index: number,
): SlabProvenance | null {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = entries[mid];
    if (index < e.start) hi = mid - 1;
    else if (index >= e.start + e.count) lo = mid + 1;
    else return e;
  }
  return null;
}

/**
 * Optional per-feature attributes a consolidated slab carries. Derived once
 * from the first absorbed tile — every tile in a slab shares one styleKey, so
 * one schema describes them all.
 */
interface SlabSchema {
  hasFillColor: boolean;
  hasCategoryIndex: boolean;
  hasRadius: boolean;
  gpuPalette: Color[] | null;
}

/**
 * Append-only consolidated buffer for cumulative mode. Many tiles' points are
 * packed into one set of typed arrays → one ScatterplotLayer → one draw call.
 * Frozen slabs are never rewritten (stable `data` ref ⇒ zero re-upload); only
 * the single open slab grows as new tiles arrive. Arrays are allocated at
 * `capacity` up front; the trailing unused tail of the final (open) slab is
 * the only wasted space.
 */
interface ConsolidatedSlab {
  capacity: number;
  count: number;
  positions: Float64Array; // size 3 (padded from 2D tiles)
  startTimes: Float32Array; // rebased to the layer's common slab offset
  endTimes: Float32Array;
  fillColors: Uint8Array | null; // size 4, normalized
  categoryIndex: Float32Array | null;
  radii: Float32Array | null;
  frozen: boolean;
  /** Per-absorbed-tile feature ranges, ordered by `start` — picking provenance. */
  provenance: SlabProvenance[];
  /** Bumped on every append; the cached data + layer are rebuilt when they fall behind. */
  version: number;
  /** Reference-stable binary `data` object, keyed by `dataVersion` (== `version`). */
  dataRef: { length: number; attributes: Record<string, any> } | null;
  dataVersion: number;
  layer: ScatterplotLayer | null;
  builtVersion: number;
}

function deriveSlabSchema(built: PreparedTile): SlabSchema {
  const a = built.data.attributes;
  return {
    hasFillColor: !!a.getFillColor,
    hasCategoryIndex: !!a.instanceCategoryIndex,
    // Per-feature radius only — a constant radius rides a scalar prop, not an attribute.
    hasRadius: !!a.getRadius && a.getRadius.value instanceof Float32Array,
    gpuPalette: built.gpuPalette,
  };
}

function makeTileKey(tile: Tile, layer: TileLayer): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}:${layer.name}`;
}

/**
 * For categorical columns with no `colorMapping`, hand the category indices
 * straight to the GPU as a single-component float attribute. The
 * CategoryColorExtension samples the palette texture in the fragment shader.
 *
 * `indices` arrive as Uint16Array (4096 categories max); the extension reads
 * them as float32. We do a narrowing copy here rather than running a shader
 * permutation per integer type.
 */
function indicesToFloat32(indices: Uint16Array, count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = indices[i];
  return out;
}

/**
 * Animated point layer with per-tile binary sublayers.
 *
 * Each visible tile produces one ScatterplotLayer instance that is cached
 * across renders. Time updates flow through getTime() on the extension; tile
 * arrivals only construct one new sublayer + one GPU upload, never touching
 * the buffers of already-loaded tiles.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`points`** — covers
 * both the per-tile ScatterplotLayers and the cumulative-mode slab layers.
 * `_subLayerProps: { points: { type: MyLayer, ...props } }` swaps the
 * sublayer class / overrides sublayer props (deck's CompositeLayer contract).
 */
export class AnimatedPointLayer<ExtraPropsT extends {} = {}> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_AnimatedPointLayerProps>
> {
  static layerName = 'AnimatedPointLayer';

  static defaultProps: DefaultProps<AnimatedPointLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    radiusScale: { type: 'number', value: 1, min: 0 },
    radiusUnits: 'pixels',
    radiusMinPixels: { type: 'number', value: 0, min: 0 },
    radiusMaxPixels: { type: 'number', value: Number.MAX_SAFE_INTEGER, min: 0 },
    // Permissive descriptors ({type:'object'} validates anything): these
    // props legally hold a constant OR a column-name string, which the
    // 'color'/'number' validators would reject in deck's debug mode.
    fillColor: { type: 'object', value: [255, 128, 0, 255], compare: true },
    radius: { type: 'object', value: 5, compare: true },
    // Accessor-named aliases (see the prop docs): unset by default so the
    // legacy props win unless the caller opts into the upstream vocabulary.
    getFillColor: { type: 'object', value: null, optional: true, compare: true },
    getRadius: { type: 'object', value: null, optional: true, compare: true },
    getLineColor: { type: 'object', value: null, optional: true, compare: true },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE, compare: true },
    colorMapping: { type: 'object', value: null, optional: true, compare: false },
    // Transparent fallback: features whose category is absent from
    // `colorMapping` disappear rather than render a misleading color.
    colorMappingDefault: { type: 'color', value: [0, 0, 0, 0] },
    // Per-point RGB from three numeric columns; null = use the normal color path.
    rgbColorColumns: { type: 'object', value: null, optional: true, compare: true },
    colorVectorColumn: { type: 'object', value: 'point_rgba', optional: true, compare: true },
    splat: false,
    radiusTransform: { type: 'function', value: null, optional: true, compare: false },

    // Marker styling forwarded to ScatterplotLayer.
    stroked: false,
    filled: true,
    strokeColor: { type: 'color', value: [0, 0, 0, 255] },
    // Constant-or-column domain, same permissive descriptor as fillColor/radius.
    strokeWidth: { type: 'object', value: 1, compare: true },
    getLineWidth: { type: 'object', value: null, optional: true, compare: true },
    lineWidthUnits: 'meters',
    lineWidthScale: { type: 'number', value: 1, min: 0 },
    lineWidthMinPixels: { type: 'number', value: 0, min: 0 },
    lineWidthMaxPixels: { type: 'number', value: Number.MAX_SAFE_INTEGER, min: 0 },
    billboard: false,
    antialiasing: true,

    // Fade ramps, forwarded to TimeFilterExtension (window mode); in
    // cumulative mode `fadeInDuration` doubles as the appear ramp.
    fadeInDuration: { type: 'number', value: 300, min: 0 },
    fadeOutDuration: { type: 'number', value: 300, min: 0 },

    // Wake-mode props. wakeLength=0 keeps the symmetric window behavior.
    wakeLength: { type: 'number', value: 0, min: 0 },
    wakeTailScale: { type: 'number', value: 0.15, min: 0 },

    // Cumulative "draws itself" reveal — see the file header.
    cumulative: false,

    // 3D props (see prop docstrings). The v3 layer reads 3D geometry directly
    // from the tile's positionDimensions; `elevationProperty` additionally
    // sources per-point z from a numeric column on 2D tiles. `use3D` is a hint.
    use3D: false,
    elevationProperty: { type: 'object', value: null, optional: true, compare: true },
    // Allow negative scale (e.g. invert depth) — z values themselves may be
    // negative (below-grade returns), so the multiplier is unconstrained too.
    elevationScale: { type: 'number', value: 1 },
  };

  /** Per-tile prepared-data cache. Pruned to the live tile set each render. */
  private preparedTileCache = new Map<string, PreparedTile>();

  /**
   * Per-tile sublayer-instance cache. Returning the SAME ScatterplotLayer
   * reference across renderLayers() calls lets deck.gl short-circuit prop
   * diff entirely. Allocating a fresh layer per visible tile per frame (as
   * the v2 consolidation rewrite would in any non-trivial workflow) was the
   * single largest source of frame-time variance at 50+ tiles.
   */
  private sublayerCache = new Map<
    string,
    { layer: ScatterplotLayer; preparedKey: PreparedTile; layerPropsKey: string }
  >();

  /** Digest of every prop baked into a sublayer at construction time. */
  private lastLayerPropsKey: string = '';
  /** Tile-array identity from the previous render — see AnimatedTripsLayer.lastTilesRef. */
  private lastTilesRef: Tile[] | null = null;

  /* ── Cumulative consolidation state (cumulative mode only) ─────────────── */
  /** Packed slabs, in arrival order. The last entry is the open (growing) slab. */
  private slabs: ConsolidatedSlab[] = [];
  /** Tile keys already packed into a slab — skipped on subsequent renders. */
  private absorbedTileKeys = new Set<string>();
  /** Common timeOffset every slab's times are rebased to (Float32-safe in cumulative). */
  private slabBaseOffset = 0;
  /** `styleKey|zoom` of the current slabs; a change forces a full data rebuild. */
  private slabSchemaKey: string | null = null;
  /** Optional-attribute schema shared by every slab (from the first absorbed tile). */
  private slabSchema: SlabSchema | null = null;
  /** Visual layer-prop digest; a change rebuilds slab LAYERS but keeps the packed data. */
  private lastSlabLayerPropsKey = '';

  /**
   * Singleton TimeFilterExtension reused by every sublayer. Extensions are
   * stateless w.r.t. data; per-tile timeOffset is passed as a layer prop.
   *
   * Point layer uses window-mode filtering (whole feature on/off + fade) so
   * the per-vertex time attribute is unused. Restricting registration to
   * start/end frees a vertex-attribute slot for the picking buffer.
   */
  private readonly timeFilterExtension = new TimeFilterExtension({ mode: 'window' });

  /**
   * Singleton CategoryColorExtension. Like the time filter, it's stateless —
   * the palette and `useCategoryColor` toggle ride through layer props. We
   * always include it in the layer's extension list: when the per-tile data
   * lacks `instanceCategoryIndex`, the shader branch is gated off via the
   * uniform.
   */
  private readonly categoryColorExtension = new CategoryColorExtension();

  /**
   * Singleton SplatExtension. Stateless soft-gaussian fragment effect; added to
   * the sublayer extension list only when `props.splat` is set (a per-layer
   * constant, so the list stays stable across this layer's sublayers).
   */
  private readonly splatExtension = new SplatExtension();

  /**
   * Stable getTime reference. Critical: deck.gl re-runs work when accessor
   * function references change; a fresh arrow every render defeats the cache.
   */
  private readonly boundGetTime: () => number = () => this.getCurrentTime();

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.preparedTileCache.clear();
    this.sublayerCache.clear();
    this.slabs = [];
    this.absorbedTileKeys.clear();
    this.slabSchema = null;
    this.slabSchemaKey = null;
  }

  /**
   * Accessor-alias resolution (audit B1): the upstream-named alias wins when
   * set; a function-valued alias warns once and falls back to the legacy
   * prop. Same value domain as the legacy props (constant or column name).
   */
  private fillColorValue(): Color | string | undefined {
    return resolveAccessorAlias(
      'AnimatedPointLayer',
      'getFillColor',
      this.props.getFillColor,
      this.props.fillColor,
    );
  }

  private radiusValue(): number | string | undefined {
    return resolveAccessorAlias(
      'AnimatedPointLayer',
      'getRadius',
      this.props.getRadius,
      this.props.radius,
    );
  }

  private lineColorValue(): Color {
    return resolveAccessorAlias(
      'AnimatedPointLayer',
      'getLineColor',
      this.props.getLineColor as Color | undefined,
      this.props.strokeColor,
    );
  }

  private lineWidthValue(): number | string | undefined {
    return resolveAccessorAlias(
      'AnimatedPointLayer',
      'getLineWidth',
      this.props.getLineWidth,
      this.props.strokeWidth,
    );
  }

  /**
   * Compute a digest of the layer-level props that affect every sublayer.
   * When this changes we throw away the entire sublayer cache.
   */
  private computeLayerPropsKey(): string {
    const fillColor = this.fillColorValue();
    const radius = this.radiusValue();
    const lineColor = this.lineColorValue();
    const lineWidth = this.lineWidthValue();
    return [
      this.props.radiusScale,
      this.props.radiusUnits,
      this.props.radiusMinPixels,
      this.props.radiusMaxPixels,
      this.props.lineWidthUnits,
      this.props.lineWidthScale,
      this.props.lineWidthMinPixels,
      this.props.lineWidthMaxPixels,
      this.props.stroked,
      this.props.filled,
      this.props.billboard,
      this.props.antialiasing,
      Array.isArray(lineColor) ? lineColor.join(',') : '',
      // strokeWidth constant branch only — the column branch lives in
      // `prepared` and is keyed via styleKey/preparedKey.
      typeof lineWidth === 'number' ? lineWidth : 0,
      // Composite props that getSubLayerProps bakes into every sublayer
      // (opacity/pickable/visible, coordinateSystem, modelMatrix, highlight
      // props, _subLayerProps overrides…) plus the user's updateTriggers.
      inheritedPropsDigest(this.props),
      updateTriggersDigest(this.props.updateTriggers),
      this.props.timeWindow,
      this.props.fadeInDuration,
      this.props.fadeOutDuration,
      this.props.wakeLength,
      this.props.wakeTailScale,
      this.props.timeHeightScale,
      this.props.timeHeightOrigin,
      // fillColor/radius constant branches only — the property-driven path
      // lives in `prepared` and is keyed via preparedKey.
      Array.isArray(fillColor) ? fillColor.join(',') : '',
      typeof radius === 'number' ? radius : 0,
    ].join('|');
  }

  renderLayers(): Layer[] {
    // Cumulative "draws itself" datasets use a consolidated, append-only path:
    // packing points into a few slabs instead of one sublayer per resident
    // tile is what keeps a long playback off the thousands-of-draw-calls cliff.
    if (this.props.cumulative) {
      return this.renderConsolidated();
    }

    const t0 = performance.now();
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) {
      this.lastTilesRef = null;
      return [];
    }

    // Prune cache only when the tile-array ref changed — when the parent
    // hands us the same `state.tiles` instance, the live and cached sets are
    // identical by construction and the walks are pure overhead.
    if (this.lastTilesRef !== tiles) {
      const live = new Set<string>();
      for (const tile of tiles) {
        for (const tileLayer of tile.layers) live.add(makeTileKey(tile, tileLayer));
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
      layer: 'AnimatedPointLayer',
      tiles: tiles.length,
      sublayers: sublayers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`AnimatedPointLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`);
    }
    return sublayers;
  }

  /**
   * styleKey digest of the props that change a tile's prepared `attributes`
   * (which color/radius column, palette/mapping content, CPU-vs-GPU color
   * path, radius transform). Shared by the per-tile cache check and the
   * slab-schema invalidation.
   */
  private computeStyleKey(): string {
    const fillColor = this.fillColorValue();
    const radius = this.radiusValue();
    const lineWidth = this.lineWidthValue();
    const fillColorProp = typeof fillColor === 'string' ? fillColor : '';
    const radiusProp = typeof radius === 'string' ? radius : '';
    const lineWidthProp = typeof lineWidth === 'string' ? lineWidth : '';
    // Palette identity matters only when fillColor is a column name. The
    // mapping branch keys CONTENT (not just the CPU/GPU toggle) — editing a
    // mapping entry must invalidate the CPU-expanded RGBA buffers. Digests
    // are memoized per object reference (style-digest.ts), so this stays a
    // WeakMap lookup per tile, not a re-serialization.
    const mapping = this.props.colorMapping;
    // radiusTransform is baked into the prepared getRadius buffer; function
    // identity (not body) is the invalidation contract for function props.
    const transform = this.props.radiusTransform;
    // Elevation column + scale are baked into the prepared `positions` z, so
    // they belong in the styleKey: changing either must re-pad the buffer
    // (and, in cumulative mode, re-pack the slabs).
    const elevProp = typeof this.props.elevationProperty === 'string'
      ? this.props.elevationProperty
      : '';
    const elevScale = elevProp ? (this.props.elevationScale ?? 1) : 0;
    // Per-point RGB is baked into the prepared getFillColor buffer, so the
    // chosen columns belong in the styleKey: changing them must re-expand it.
    const rgb = this.props.rgbColorColumns;
    const rgbKey = rgb ? `rgb${rgb.join(',')}` : '';
    const colorVecKey = typeof this.props.colorVectorColumn === 'string' ? `cv${this.props.colorVectorColumn}` : '';
    return `${colorVecKey}|${fillColorProp}|${radiusProp}|${lineWidthProp}|${
      fillColorProp ? colorListDigest(this.props.colorPalette ?? DEFAULT_PALETTE) : 0
    }|${mapping ? `m${colorMappingDigest(mapping)}` : 'g'}|${
      transform ? `r${functionId(transform)}` : ''
    }|e${elevProp}:${elevScale}|${rgbKey}|${updateTriggersDigest(this.props.updateTriggers)}`;
  }

  /**
   * Fetch the cached binary `data` object for a single tile, building (and
   * caching) it on a miss. Returns a reference-stable PreparedTile so deck.gl
   * can short-circuit GPU re-uploads.
   */
  private prepareTile(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    if (tileLayer.features.featureCount === 0) return null;
    const styleKey = this.computeStyleKey();
    const tileKey = makeTileKey(tile, tileLayer);
    const cached = this.preparedTileCache.get(tileKey);
    if (cached && cached.styleKey === styleKey) {
      emit('tilePrepare', { layer: 'AnimatedPointLayer', tileKey, cached: true, ms: 0 });
      return cached;
    }
    const prepared = this.buildTileData(tile, tileLayer);
    if (prepared) this.preparedTileCache.set(tileKey, prepared);
    return prepared;
  }

  /**
   * Build the binary `data` object for a single tile from scratch (no caching).
   * Shared by the cached per-tile path (`prepareTile`) and the cumulative
   * consolidation path, which copies the result into a slab and discards it.
   */
  private buildTileData(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0) return null;

    const fillColorValue = this.fillColorValue();
    const radiusValue = this.radiusValue();
    const fillColorProp = typeof fillColorValue === 'string' ? fillColorValue : '';
    const radiusProp = typeof radiusValue === 'string' ? radiusValue : '';
    const styleKey = this.computeStyleKey();
    const tileKey = makeTileKey(tile, tileLayer);

    const t0 = performance.now();
    const count = binary.featureCount;
    const srcDims = binary.positionDimensions ?? 2;

    // Per-point elevation (z) from a numeric column. The tile geometry is 2D
    // (lon/lat); z comes ONLY from this property — `positions[i*3+2] =
    // column[i] * elevationScale`. Resolve the column here so both the pad
    // path and the rare 3D-tile path can apply it. Unset / missing column ⇒
    // z stays 0 (byte-identical to a flat render).
    const elevProp = typeof this.props.elevationProperty === 'string'
      ? this.props.elevationProperty
      : '';
    const elevValues = elevProp ? binary.numericProps[elevProp] : undefined;
    const elevScale = this.props.elevationScale ?? 1;

    // ScatterplotLayer expects size=3 positions. When the tile is 2D we pad
    // once into a fresh Float64Array (baking in z if an elevation column is
    // set). 3D tiles ride the original buffer zero-copy — UNLESS an elevation
    // column overrides z, in which case we copy first so the Arrow buffer is
    // never mutated. The pad/copy is per-tile, not per-tile-set, so cost is
    // amortized across animation frames.
    let positions: Float64Array;
    if (srcDims === 3) {
      if (elevValues) {
        // Single pass: copy x/y from the Arrow buffer and bake in the
        // elevation-column z, so the source buffer is never mutated and we
        // avoid a second sweep over `positions`.
        const src = binary.positions;
        positions = new Float64Array(count * 3);
        for (let i = 0; i < count; i++) {
          positions[i * 3] = src[i * 3];
          positions[i * 3 + 1] = src[i * 3 + 1];
          positions[i * 3 + 2] = elevValues[i] * elevScale;
        }
      } else {
        positions = binary.positions;
      }
    } else {
      positions = padPositionsTo3D(binary.positions, count, elevValues, elevScale);
    }

    const attributes: PreparedTile['data']['attributes'] = {
      getPosition: { value: positions, size: 3 },
      // Extension-registered attribute names — must match
      // TimeFilterExtension.initializeState exactly. Zero-copy: the tile's
      // own Float32Arrays (relative to binary.timeOffset) ride straight to
      // the GPU.
      instanceStartTime: { value: binary.startTimes, size: 1 },
      instanceEndTime: { value: binary.endTimes, size: 1 },
    };

    let gpuPalette: Color[] | null = null;

    // Per-point RGBA from ONE interleaved vector column (baked at build time):
    // bind the contiguous u8 buffer straight to the GPU, zero re-pack. Wins over
    // every other colour path; falls through when the column is absent.
    const colorVecN = typeof this.props.colorVectorColumn === 'string' ? this.props.colorVectorColumn : '';
    const colorVec = colorVecN ? binary.vectorProps?.[colorVecN] : undefined;

    // Per-point RGB from three numeric columns (build-time camera-sampled
    // colors). Wins over the categorical / palette color path; falls through
    // to it if any of the three columns is absent from this tile. numericProps
    // are Float32Array of 0–255 ints → truncate straight into a Uint8 RGBA.
    const rgbCols = this.props.rgbColorColumns;
    const rArr = rgbCols ? binary.numericProps[rgbCols[0]] : undefined;
    const gArr = rgbCols ? binary.numericProps[rgbCols[1]] : undefined;
    const bArr = rgbCols ? binary.numericProps[rgbCols[2]] : undefined;

    // Property-driven color
    if (colorVec && colorVec.size === 4) {
      attributes.getFillColor = { value: colorVec.value, size: 4, normalized: true };
    } else if (rArr && gArr && bArr) {
      const out = new Uint8Array(count * 4);
      for (let i = 0; i < count; i++) {
        const o = i * 4;
        out[o] = rArr[i];
        out[o + 1] = gArr[i];
        out[o + 2] = bArr[i];
        out[o + 3] = 255;
      }
      attributes.getFillColor = { value: out, size: 4, normalized: true };
    } else if (fillColorProp) {
      const cat = binary.categoricalProps[fillColorProp];
      const num = binary.numericProps[fillColorProp];
      const palette = this.props.colorPalette ?? DEFAULT_PALETTE;

      if (cat) {
        if (this.props.colorMapping) {
          // CPU branch: indexed by category string → no way to do this on the
          // GPU without a string→int hash on every frame.
          const fallback =
            this.props.colorMappingDefault ?? ([0, 0, 0, 0] as Color);
          attributes.getFillColor = {
            value: coreExpandCategoricalColors(
              binary,
              {
                property: fillColorProp,
                colorMapping: this.props.colorMapping as Record<string, RGBA255>,
                colorMappingDefault: fallback as RGBA255,
              },
              'u8',
            ) as Uint8Array,
            size: 4,
            normalized: true,
          };
        } else {
          // GPU branch: hand category indices to the CategoryColorExtension.
          attributes.instanceCategoryIndex = {
            value: indicesToFloat32(cat.indices, count),
            size: 1,
          };
          gpuPalette = palette;
        }
      } else if (num && this.props.colorMapping) {
        // Numeric column + mapping: stringify lookup (rare).
        const fallback =
          this.props.colorMappingDefault ?? ([0, 0, 0, 0] as Color);
        const out = new Uint8Array(count * 4);
        for (let i = 0; i < count; i++) {
          const color = this.props.colorMapping[String(num[i])] || fallback;
          const o = i * 4;
          out[o] = color[0];
          out[o + 1] = color[1];
          out[o + 2] = color[2];
          out[o + 3] = color[3] ?? 255;
        }
        attributes.getFillColor = { value: out, size: 4, normalized: true };
      }
    }

    // Property-driven radius — already Float32Array, ride zero-copy unless
    // radiusTransform is set (which forces a per-tile pass).
    if (radiusProp) {
      const values = binary.numericProps[radiusProp];
      if (values) {
        const transform = this.props.radiusTransform;
        if (transform) {
          const out = new Float32Array(count);
          for (let i = 0; i < count; i++) out[i] = transform(values[i]);
          attributes.getRadius = { value: out, size: 1 };
        } else {
          attributes.getRadius = { value: values, size: 1 };
        }
      }
    }

    // Property-driven stroke width — zero-copy Float32Array ride-along.
    // Cumulative slabs don't pack this attribute (absorbTile copies a fixed
    // schema), so warn there instead of silently rendering constant widths.
    const lineWidthValue = this.lineWidthValue();
    const lineWidthProp = typeof lineWidthValue === 'string' ? lineWidthValue : '';
    if (lineWidthProp) {
      if (this.props.cumulative) {
        warnOnce(
          'AnimatedPointLayer:cumulativeStrokeWidthColumn',
          '[AnimatedPointLayer] property-driven strokeWidth/getLineWidth is not ' +
            'packed into cumulative slabs; strokes render at the constant width.',
        );
      } else {
        const values = binary.numericProps[lineWidthProp];
        if (values) attributes.getLineWidth = { value: values, size: 1 };
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
    emit('tilePrepare', {
      layer: 'AnimatedPointLayer',
      tileKey,
      cached: false,
      features: count,
      gpuPalette: gpuPalette !== null,
      ms: performance.now() - t0,
    });
    return prepared;
  }

  private buildSublayer(prepared: PreparedTile): ScatterplotLayer {
    // `Required<>`-typed: the defaultProps value guarantees a number here.
    const timeWindow = this.props.timeWindow;
    const radiusValue = this.radiusValue();
    const fillColorValue = this.fillColorValue();
    const constRadius = typeof radiusValue === 'number' ? radiusValue : 5;
    const constColor = (Array.isArray(fillColorValue)
      ? fillColorValue
      : ([255, 128, 0, 255] as Color)) as Color;

    // CategoryColorExtension props: when this tile uses the GPU palette path
    // we pass the resolved palette + useCategoryColor=true. Otherwise the
    // extension idles (its shader branch is gated by useCategoryColor).
    const useGpuCategory = prepared.gpuPalette !== null;
    if (
      useGpuCategory &&
      prepared.gpuPalette!.length > CATEGORY_PALETTE_SIZE
    ) {
      warnOnce(
        'AnimatedPointLayer:paletteOverflow',
        `[AnimatedPointLayer] colorPalette has ${prepared.gpuPalette!.length} ` +
          `entries; only the first ${CATEGORY_PALETTE_SIZE} will be used by ` +
          'CategoryColorExtension.',
      );
    }

    // Keep the extension list constant across sublayers — see
    // animated-trips-layer.ts for the cache-storm rationale. User extensions
    // from the top-level `extensions` prop are appended (composeExtensions).
    const extensions = this.composeExtensions([
      this.timeFilterExtension,
      this.categoryColorExtension,
      // Soft-gaussian splat shaping runs LAST so it shapes the final alpha (after
      // the time-fade + any categorical color). `splat` is a per-layer constant,
      // so including it conditionally keeps the list stable across sublayers.
      ...(this.props.splat ? [this.splatExtension] : []),
    ]);
    // getSubLayerProps inheritance (opacity/pickable/visible, coordinate
    // system, highlight props, …) + user `_subLayerProps.points` overrides.
    // Only runs inside this cache-gated build path — never per frame.
    const props = this.composeSubLayerProps('points', prepared.tileKey, {
      data: prepared.data as any,
      // Identity comparator: deck.gl skips prop-diff for `data` entirely when
      // the same object reference comes back. Pairs with the preparedTileCache
      // which guarantees stable identity.
      dataComparator: (a: any, b: any) => a === b,

      ...this.commonStyleProps(),

      // Constant fallbacks — used when the binary attribute is absent.
      getRadius: constRadius,
      getFillColor: constColor,

      extensions,

      // TimeFilterExtension wiring — per-tile timeOffset and window.
      getTime: this.boundGetTime,
      timeOffset: prepared.timeOffset,
      timeWindow,

      // TileLayer convention: the source tile rides on the sublayer so the
      // base getPickingInfo can enrich info.tile / decode the picked feature.
      tile: prepared.tile,
      sttFeatures: prepared.features,

      // Always set `useCategoryColor` so tests / debug tooling can distinguish
      // the two paths via prop inspection. The extension itself only does
      // work when the flag is true.
      useCategoryColor: useGpuCategory,
      ...(useGpuCategory ? { categoryPalette: prepared.gpuPalette! } : {}),
    });
    // `_subLayerProps: { points: { type } }` swaps the sublayer class — the
    // CompositeLayer-native renderSubLayers-style override point.
    const SubLayerClass = this.getSubLayerClass('points', ScatterplotLayer);
    return new SubLayerClass(props as any);
  }

  /**
   * Visual + time-filter props shared by every ScatterplotLayer this layer
   * emits, whether a per-tile sublayer or a consolidated slab. Excludes the
   * bits that differ per path: `data`/`dataComparator`, the constant
   * radius/color fallbacks, `extensions`, and the time wiring
   * (`getTime`/`timeOffset`/`timeWindow`). `opacity`/`visible`/`pickable`
   * are no longer listed here — getSubLayerProps inherits them from the
   * composite with the exact values this method used to forward.
   */
  private commonStyleProps(): Record<string, any> {
    const lineWidthValue = this.lineWidthValue();
    // `Required<>`-typed (defaults guarantee values) — no `??` refetches.
    return {
      radiusUnits: this.props.radiusUnits,
      radiusScale: this.props.radiusScale,
      radiusMinPixels: this.props.radiusMinPixels,
      radiusMaxPixels: this.props.radiusMaxPixels,
      stroked: this.props.stroked,
      filled: this.props.filled,
      billboard: this.props.billboard,
      antialiasing: this.props.antialiasing,
      getLineColor: this.lineColorValue(),
      // Constant fallback — the binary getLineWidth attribute wins when present.
      getLineWidth: typeof lineWidthValue === 'number' ? lineWidthValue : 1,
      lineWidthUnits: this.props.lineWidthUnits,
      lineWidthScale: this.props.lineWidthScale,
      lineWidthMinPixels: this.props.lineWidthMinPixels,
      lineWidthMaxPixels: this.props.lineWidthMaxPixels,
      fadeInDuration: this.props.fadeInDuration,
      fadeOutDuration: this.props.fadeOutDuration,
      wakeLength: this.props.wakeLength,
      wakeTailScale: this.props.wakeTailScale,
      cumulative: this.props.cumulative,
      // Time-as-height (space-time cube): whole points lift by start time.
      timeHeightScale: this.props.timeHeightScale,
      timeHeightOrigin: this.props.timeHeightOrigin,
    };
  }

  /* ── Cumulative consolidation path ──────────────────────────────────────
   * Pack resident tiles append-only into a few ScatterplotLayer "slabs"
   * instead of one sublayer per tile. See the file header for why.
   */

  private renderConsolidated(): Layer[] {
    const t0 = performance.now();
    const { tiles } = this.state;

    // Data switch / pre-load: collapse everything so the next archive starts clean.
    if (!tiles || tiles.length === 0) {
      if (this.slabs.length) {
        this.slabs = [];
        this.absorbedTileKeys.clear();
        this.slabSchema = null;
        this.slabSchemaKey = null;
      }
      return [];
    }

    // All resident tiles share one zoom (the viewport's). styleKey + that zoom
    // key the packed attributes; a change in either (restyle, or zoom in/out)
    // means the existing slabs no longer describe the current view → full
    // rebuild from the now-resident tiles. Cheap: zoom/style changes are rare
    // and user-driven, unlike the per-frame tile arrivals consolidation targets.
    const zoom = tiles[0].id.z;
    const schemaKey = `${this.computeStyleKey()}|${zoom}`;
    if (schemaKey !== this.slabSchemaKey) {
      this.slabSchemaKey = schemaKey;
      this.slabs = [];
      this.absorbedTileKeys.clear();
      this.slabSchema = null;
      this.slabBaseOffset = this.props.timeRange?.start ?? 0;
    }

    // Append every not-yet-packed tile into the open slab. In cumulative mode
    // tiles are only ever added (the loader keeps the whole span resident), so
    // there is no removal path — a tile spatially evicted then revisited stays
    // in `absorbedTileKeys` and is not re-packed. This append-only persistence
    // is what makes the fast path O(new points), not O(resident points).
    for (const tile of tiles) {
      for (const tileLayer of tile.layers) {
        const key = makeTileKey(tile, tileLayer);
        if (this.absorbedTileKeys.has(key)) continue;
        this.absorbedTileKeys.add(key); // mark even if empty so we never retry it
        const built = this.buildTileData(tile, tileLayer);
        if (!built) continue;
        if (!this.slabSchema) this.slabSchema = deriveSlabSchema(built);
        this.absorbTile(built);
      }
    }

    // Visual-only prop change (opacity, radiusScale, stroke…): rebuild the slab
    // LAYERS but keep the packed data — no need to re-copy millions of points.
    const layerPropsKey = this.computeLayerPropsKey();
    if (layerPropsKey !== this.lastSlabLayerPropsKey) {
      this.lastSlabLayerPropsKey = layerPropsKey;
      for (const slab of this.slabs) {
        slab.layer = null;
        slab.builtVersion = -1;
      }
    }

    const sublayers: Layer[] = this.slabs.map((slab, i) => this.buildSlabLayer(slab, i));

    emit('renderLayers', {
      layer: 'AnimatedPointLayer',
      mode: 'cumulative',
      tiles: tiles.length,
      sublayers: sublayers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `AnimatedPointLayer[cumulative]: ${tiles.length} tiles → ${sublayers.length} slabs`,
      );
    }
    return sublayers;
  }

  /** Copy one prepared tile's attributes into the open slab, rebasing times. */
  private absorbTile(built: PreparedTile): void {
    const n = built.data.length;
    if (n === 0) return;
    const slab = this.slabForAppend(n);
    const o = slab.count;
    const a = built.data.attributes;

    // Picking provenance: which (tile, layer) this feature range came from.
    // IDs only — see the SlabProvenance docstring for why not Tile refs.
    slab.provenance.push({
      start: o,
      count: n,
      tileId: built.tile.id,
      layerName: built.layerName,
    });

    slab.positions.set(a.getPosition.value as Float64Array, o * 3);

    // Rebase the tile's per-tile-relative times onto the common slab offset:
    //   absolute = built.timeOffset + tileRelative  ⇒  slabRelative = tileRelative + delta
    // Computed via JS doubles, stored as Float32. Magnitudes reach the dataset
    // span (~years); the resulting tens-of-seconds quantization is below what
    // the cumulative reveal can show (see TimeFilterExtension.draw precision note).
    const delta = built.timeOffset - this.slabBaseOffset;
    const st = a.instanceStartTime.value as Float32Array;
    const et = a.instanceEndTime.value as Float32Array;
    for (let i = 0; i < n; i++) {
      slab.startTimes[o + i] = st[i] + delta;
      slab.endTimes[o + i] = et[i] + delta;
    }

    if (slab.fillColors && a.getFillColor) {
      slab.fillColors.set(a.getFillColor.value as Uint8Array, o * 4);
    }
    if (slab.categoryIndex && a.instanceCategoryIndex) {
      slab.categoryIndex.set(a.instanceCategoryIndex.value as Float32Array, o);
    }
    if (slab.radii && a.getRadius && a.getRadius.value instanceof Float32Array) {
      slab.radii.set(a.getRadius.value, o);
    }

    slab.count += n;
    slab.version++;
  }

  /**
   * The open slab if it has room for `n` more points, else seal it and open a
   * fresh one. A single tile larger than the cap gets its own oversized slab.
   */
  private slabForAppend(n: number): ConsolidatedSlab {
    const open = this.slabs[this.slabs.length - 1];
    if (open && !open.frozen && open.count + n <= open.capacity) return open;
    if (open && !open.frozen) open.frozen = true;

    const schema = this.slabSchema!;
    const capacity = Math.max(SLAB_CAPACITY_POINTS, n);
    const slab: ConsolidatedSlab = {
      capacity,
      count: 0,
      positions: new Float64Array(capacity * 3),
      startTimes: new Float32Array(capacity),
      endTimes: new Float32Array(capacity),
      fillColors: schema.hasFillColor ? new Uint8Array(capacity * 4) : null,
      categoryIndex: schema.hasCategoryIndex ? new Float32Array(capacity) : null,
      radii: schema.hasRadius ? new Float32Array(capacity) : null,
      frozen: false,
      provenance: [],
      version: 0,
      dataRef: null,
      dataVersion: -1,
      layer: null,
      builtVersion: -1,
    };
    this.slabs.push(slab);
    return slab;
  }

  /**
   * Reference-stable binary `data` object for one slab, rebuilt only when the
   * slab's content `version` advances. Subarray views share the slab's backing
   * buffer (no copy); a fresh object reference is what tells deck.gl to
   * re-upload the grown open slab — and reusing it across a style-only rebuild
   * is what lets deck.gl SKIP re-upload when only a uniform changed.
   */
  private slabData(slab: ConsolidatedSlab): { length: number; attributes: Record<string, any> } {
    if (slab.dataRef && slab.dataVersion === slab.version) return slab.dataRef;
    const count = slab.count;
    const attributes: Record<string, any> = {
      getPosition: { value: slab.positions.subarray(0, count * 3), size: 3 },
      instanceStartTime: { value: slab.startTimes.subarray(0, count), size: 1 },
      instanceEndTime: { value: slab.endTimes.subarray(0, count), size: 1 },
    };
    if (slab.fillColors) {
      attributes.getFillColor = {
        value: slab.fillColors.subarray(0, count * 4),
        size: 4,
        normalized: true,
      };
    }
    if (slab.categoryIndex) {
      attributes.instanceCategoryIndex = { value: slab.categoryIndex.subarray(0, count), size: 1 };
    }
    if (slab.radii) {
      attributes.getRadius = { value: slab.radii.subarray(0, count), size: 1 };
    }
    slab.dataRef = { length: count, attributes };
    slab.dataVersion = slab.version;
    return slab.dataRef;
  }

  /**
   * Build (or return the cached) ScatterplotLayer for one slab. Frozen slabs
   * keep a stable layer reference (their `version` never advances ⇒ no GPU
   * re-upload); the open slab rebuilds whenever it grew since last render.
   */
  private buildSlabLayer(slab: ConsolidatedSlab, index: number): ScatterplotLayer {
    if (slab.layer && slab.builtVersion === slab.version) return slab.layer;

    const radiusValue = this.radiusValue();
    const fillColorValue = this.fillColorValue();
    const constRadius = typeof radiusValue === 'number' ? radiusValue : 5;
    const constColor = (Array.isArray(fillColorValue)
      ? fillColorValue
      : ([255, 128, 0, 255] as Color)) as Color;
    const useGpuCategory = !!this.slabSchema?.gpuPalette;

    // Same `points` short id as the per-tile path: one `_subLayerProps.points`
    // override covers both render modes. Only runs when a slab grew/restyled.
    const props = this.composeSubLayerProps('points', `slab-${index}`, {
      data: this.slabData(slab),
      dataComparator: (a: any, b: any) => a === b,

      ...this.commonStyleProps(),

      getRadius: constRadius,
      getFillColor: constColor,

      // Constant extension list (cache-storm rationale, as in buildSublayer);
      // user extensions from the top-level prop are appended.
      extensions: this.composeExtensions([
        this.timeFilterExtension,
        this.categoryColorExtension,
      ]),

      // TimeFilterExtension wiring — one shared offset for every slab.
      getTime: this.boundGetTime,
      timeOffset: this.slabBaseOffset,
      timeWindow: this.props.timeWindow,

      // A slab merges many tiles, so there is no single `tile` to carry;
      // picking resolves the source tile through the provenance ranges
      // (see getPickingInfo). The array reference is stable across appends.
      tile: null,
      sttSlabProvenance: slab.provenance,

      useCategoryColor: useGpuCategory,
      ...(useGpuCategory ? { categoryPalette: this.slabSchema!.gpuPalette } : {}),
    });

    const SubLayerClass = this.getSubLayerClass('points', ScatterplotLayer);
    const layer = new SubLayerClass(props as any);
    slab.layer = layer;
    slab.builtVersion = slab.version;
    return layer;
  }

  /**
   * Slab-aware picking. Cumulative slabs merge many tiles into one
   * sublayer, so the base tile/sttFeatures path can't apply; instead the
   * picked slab index is mapped back through the slab's provenance ranges
   * to its source (tile, layer) and decoded from that tile's columns.
   * The tile is resolved from the CURRENT visible set (provenance holds
   * ids only) — a pick on a feature whose absorbed tile has since been
   * spatially evicted reports `tile: null` with `info.object` undefined,
   * the price of not pinning evicted tiles' decoded buffers.
   */
  getPickingInfo(params: GetPickingInfoParams): SpatioTemporalPickingInfo {
    const info = super.getPickingInfo(params);
    const provenance = (
      params.sourceLayer?.props as { sttSlabProvenance?: SlabProvenance[] } | undefined
    )?.sttSlabProvenance;
    if (!provenance || info.index < 0) return info;
    const entry = findSlabProvenance(provenance, info.index);
    if (!entry) return info;
    const { z, x, y, t } = entry.tileId;
    const tile =
      this.state.tiles?.find(
        (candidate) =>
          candidate.id.z === z &&
          candidate.id.x === x &&
          candidate.id.y === y &&
          candidate.id.t === t,
      ) ?? null;
    info.tile = tile;
    info.sourceTile = tile;
    if (tile && info.object === undefined) {
      const tileLayer = tile.layers.find((l) => l.name === entry.layerName);
      if (tileLayer) {
        info.object =
          getFeatureProperties(tileLayer.features, info.index - entry.start) ?? undefined;
      }
    }
    return info;
  }
}

/**
 * Pad a 2D Float64Array of positions [x0,y0, x1,y1, ...] into a 3D buffer
 * [x0,y0,z0, x1,y1,z1, ...] for ScatterplotLayer's size-3 attribute. This is
 * the only allocation per tile in the prepare step; the previous v2 path
 * allocated this AND the consolidated buffer for every tile in the visible set.
 *
 * `elevValues` (optional) supplies per-point z from a numeric column:
 * `z = elevValues[i] * elevScale`. Negative/zero values pass through. When it
 * is undefined, z stays 0 (the Float64Array is already zero-initialized), so
 * the no-elevation output is byte-identical to the prior flat behavior.
 */
function padPositionsTo3D(
  src: Float64Array,
  count: number,
  elevValues?: Float32Array,
  elevScale = 1,
): Float64Array {
  const out = new Float64Array(count * 3);
  if (elevValues) {
    for (let i = 0; i < count; i++) {
      out[i * 3] = src[i * 2];
      out[i * 3 + 1] = src[i * 2 + 1];
      out[i * 3 + 2] = elevValues[i] * elevScale;
    }
  } else {
    for (let i = 0; i < count; i++) {
      out[i * 3] = src[i * 2];
      out[i * 3 + 1] = src[i * 2 + 1];
      // out[i * 3 + 2] = 0; (already zero-initialized)
    }
  }
  return out;
}

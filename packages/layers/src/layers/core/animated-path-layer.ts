// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * AnimatedPathLayer - GPU-efficient path/trajectory rendering with time filtering.
 *
 * Operates in WINDOW MODE: each feature is shown (with optional fade) when
 * its `[startTime, endTime]` overlaps the current time window. Whole paths
 * render at once. For a "vehicle moving along the route" effect with a
 * trailing fade, use AnimatedTripsLayer instead.
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
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from '../spatiotemporal-layer';
import { NoPickingPathLayer } from '../internal/no-picking-path-layer';
import { TimeFilterExtension } from '../../extensions/time-filter-extension';
import {
  CategoryColorExtension,
  CATEGORY_PALETTE_SIZE,
} from '../../extensions/category-color-extension';
import { emit } from '../../lib/telemetry';
import { warnOnce } from '../../lib/log';
import {
  colorListDigest,
  colorMappingDigest,
  inheritedPropsDigest,
  structuralDigest,
  updateTriggersDigest,
} from '../../lib/style-digest';
import { resolveAccessorAlias } from '../../lib/accessor-alias';
import type { ColorAccessorValue, NumericAccessorValue } from '../../lib/accessor-alias';
import type { Tile, Layer as TileLayer, BinaryFeatures } from '@poopdeck.gl/core';

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
}

/** Complete props accepted by {@link AnimatedPathLayer}. */
export type AnimatedPathLayerProps = _AnimatedPathLayerProps & SpatioTemporalLayerProps;

const DEFAULT_PALETTE: Color[] = [
  [0, 150, 255, 255],
  [255, 127, 14, 255],
  [44, 160, 44, 255],
  [214, 39, 40, 255],
  [148, 103, 189, 255],
  [140, 86, 75, 255],
  [227, 119, 194, 255],
  [127, 127, 127, 255],
  [188, 189, 34, 255],
  [23, 190, 207, 255],
];

/** See AnimatedTripsLayer for the rationale; same cache shape, window-mode attrs. */
interface PreparedTile {
  tileKey: string;
  styleKey: string;
  data: {
    length: number;
    startIndices: Uint32Array;
    attributes: Record<string, { value: any; size: number; normalized?: boolean }>;
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
function expandFeatureScalarToVertex<T extends { [i: number]: number; length: number }>(
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
      : c[3] ?? 255;
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
export class AnimatedPathLayer<ExtraPropsT extends {} = {}> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_AnimatedPathLayerProps>
> {
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
    colorMapping: { type: 'object', value: null, optional: true, compare: false },
    colorMappingDefault: { type: 'color', value: [120, 120, 120, 255] },
    // Elevation: unset ⇒ flat (zero-copy positions). Digested by content in the
    // styleKey / layerPropsKey (compare:false on the mapping), like colorMapping.
    elevationProperty: { type: 'object', value: null, optional: true, compare: true },
    elevationMapping: { type: 'object', value: null, optional: true, compare: false },
    elevationScale: { type: 'number', value: 1 },
    // Height-graded alpha: unset range ⇒ no grading. Range/near/far ride the
    // styleKey so a tweak re-prepares the tiles (re-expands getColor).
    elevationOpacityRange: { type: 'object', value: null, optional: true, compare: true },
    elevationOpacityNear: { type: 'number', value: 1 },
    elevationOpacityFar: { type: 'number', value: 1 },
    fadeInDuration: { type: 'number', value: 300, min: 0 },
    fadeOutDuration: { type: 'number', value: 300, min: 0 },
    capRounded: false,
    jointRounded: false,
    miterLimit: { type: 'number', value: 4, min: 0 },
    billboard: false,
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
   * Path layer is window-mode only (whole feature on/off + fade), so the
   * per-vertex time attribute is unused. Registering only the start/end pair
   * keeps the per-pipeline vertex-attribute count under WebGL2's 16-slot
   * minimum when stacked with PathLayer's fp64 position split + picking +
   * CategoryColorExtension.
   */
  private readonly timeFilterExtension = new TimeFilterExtension({ mode: 'window' });
  private readonly categoryColorExtension = new CategoryColorExtension();
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

  private widthValue(): number | string | undefined {
    return resolveAccessorAlias(
      'AnimatedPathLayer',
      'getWidth',
      this.props.getWidth,
      this.props.pathWidth,
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
      console.log(`AnimatedPathLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`);
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
    const elevProp =
      typeof this.props.elevationProperty === 'string' ? this.props.elevationProperty : '';
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
          this.props.elevationMapping ? structuralDigest(this.props.elevationMapping) : ''
        }`
      : '';
    // Height-graded alpha signature — a range/near/far tweak re-expands getColor.
    const opacityRange = this.props.elevationOpacityRange;
    const elevOpacSig =
      elevProp && opacityRange
        ? `o${opacityRange[0]},${opacityRange[1]}:${this.props.elevationOpacityNear}:${this.props.elevationOpacityFar}`
        : '';
    const styleKey = `${colorProp}|${widthProp}|${
      colorProp ? colorListDigest(this.props.colorPalette ?? DEFAULT_PALETTE) : 0
    }|${mapSig}|${elevSig}|${elevOpacSig}|${updateTriggersDigest(this.props.updateTriggers)}`;

    const tileKey = makeTileKey(tile, tileLayer);
    const cached = this.preparedTileCache.get(tileKey);
    if (cached && cached.styleKey === styleKey) {
      emit('tilePrepare', { layer: 'AnimatedPathLayer', tileKey, cached: true, ms: 0 });
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
          : this.props.colorPalette ?? DEFAULT_PALETTE;
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
        // getWidth is a native PathLayer accessor — its tessellator expands the
        // per-feature value across the path's segments, so per-feature is fine.
        attributes.getWidth = { value: values, size: 1 };
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
    const constColor = (Array.isArray(colorValue)
      ? colorValue
      : [0, 150, 255, 255]) as Color;
    const constWidth = typeof widthValue === 'number' ? widthValue : 2;
    // `Required<>`-typed: the defaultProps value guarantees a number here.
    const timeWindow = this.props.timeWindow;

    const useGpuCategory = prepared.gpuPalette !== null;
    if (
      useGpuCategory &&
      prepared.gpuPalette!.length > CATEGORY_PALETTE_SIZE
    ) {
      warnOnce(
        'AnimatedPathLayer:paletteOverflow',
        `[AnimatedPathLayer] colorPalette has ${prepared.gpuPalette!.length} ` +
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
    ]);
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

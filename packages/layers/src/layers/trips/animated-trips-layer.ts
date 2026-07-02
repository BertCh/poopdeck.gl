// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * AnimatedTripsLayer - GPU-efficient animated trips/trajectories
 *
 * Renders a "vehicle moving along the route" effect with a trailing fade.
 *
 * ARCHITECTURE (v3 - Per-tile binary sublayers):
 * - One PathLayer per (tile, layer) pair. No cross-tile consolidation.
 * - Each sublayer uses deck.gl's binary `data: { length, startIndices,
 *   attributes }` interface, with attribute typed arrays referenced directly
 *   from the tile's BinaryFeatures (zero-copy from the Arrow buffer).
 * - Per-tile `timeOffset` — each sublayer rebases time independently in its
 *   own TimeFilterExtension instance. No layer-wide rebasing pass.
 * - `getTime` callback drives the trail uniform per draw without layer
 *   recreation, so the demo's tick handler only calls `setNeedsRedraw()`.
 * - Prepared per-tile data is cached so the `data` object reference is
 *   stable across renderLayers() calls; deck.gl short-circuits GPU
 *   re-uploads when the reference matches.
 *
 * Streaming is now additive: a new tile creates one new sublayer and one
 * GPU upload. Existing tiles' GPU buffers are untouched. The previous
 * consolidation path rebuilt every buffer on every tile arrival.
 */

import { PathLayer } from '@deck.gl/layers';
import type { Color, DefaultProps, Layer, LayerContext } from '@deck.gl/core';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from '../spatiotemporal-layer';
import { NoPickingPathLayer } from '../internal/no-picking-path-layer';
import { TimeFilterExtension } from '../../extensions/time-filter-extension';
import { CategoryColorExtension } from '../../extensions/category-color-extension';
import { emit } from '../../lib/telemetry';
import { warnOnce } from '../../lib/log';
import {
  colorListDigest,
  colorMappingDigest,
  inheritedPropsDigest,
  updateTriggersDigest,
} from '../../lib/style-digest';
import { resolveAccessorAlias } from '../../lib/accessor-alias';
import type { ColorAccessorValue, NumericAccessorValue } from '../../lib/accessor-alias';
import { DEFAULT_TRIPS_PALETTE } from '@poopdeck.gl/core';
import type { Tile, Layer as TileLayer, BinaryFeatures } from '@poopdeck.gl/core';

const DEBUG = false;

/** Props added by {@link AnimatedTripsLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link AnimatedTripsLayerProps}). */
export interface _AnimatedTripsLayerProps {
  /**
   * Units for `tripWidth`. 'pixels' (default) is screen-space; 'meters' makes
   * widths world-space so trails thicken/thin with zoom like real objects
   * (clamped by widthMin/MaxPixels), mirroring the maritime point layer.
   * @default 'pixels'
   */
  widthUnits?: 'pixels' | 'meters' | 'common';
  /**
   * Width multiplier.
   * @default 1
   */
  widthScale?: number;
  /**
   * Minimum on-screen path width in pixels.
   * @default 2
   */
  widthMinPixels?: number;
  /**
   * Maximum on-screen path width in pixels.
   * @default 10
   */
  widthMaxPixels?: number;
  /**
   * Trip color — constant {@link Color}, or property name for categorical coloring.
   * @default [253, 128, 93, 255]
   */
  tripColor?: Color | string;
  /**
   * Upstream-vocabulary (TripsLayer/PathLayer) alias of {@link tripColor}.
   * NOTE: unlike upstream deck.gl, this accepts a constant Color OR a
   * property-column NAME — NOT a function accessor (binary tiles can't run
   * per-feature JS; a function warns once and falls back to `tripColor`).
   * When set, it wins over `tripColor`.
   */
  getColor?: ColorAccessorValue | null;
  /**
   * Trip width — constant number, or property name for per-feature width.
   * @default 3
   */
  tripWidth?: number | string;
  /**
   * Upstream-vocabulary alias of {@link tripWidth}. Accepts a constant
   * number OR a property-column NAME — NOT a function accessor (a function
   * warns once and falls back to `tripWidth`). When set, it wins over
   * `tripWidth`.
   */
  getWidth?: NumericAccessorValue | null;
  /** Color palette for categorical `tripColor`. */
  colorPalette?: Color[];
  /**
   * Explicit category-string → color map for categorical `tripColor`.
   * Resolved per-tile against each tile's own category dictionary, so colors
   * stay consistent across tiles (unlike `colorPalette`, whose indices are
   * assigned per-tile in first-seen order). Takes precedence over
   * `colorPalette` when set. Mirrors `AnimatedPointLayer.colorMapping`.
   */
  colorMapping?: Record<string, Color> | null;
  /** Fallback color for categories absent from `colorMapping`. */
  colorMappingDefault?: Color;
  /**
   * Per-vertex gradient coloring. Names which `BinaryFeatures` per-vertex
   * scalar channel to color by — currently only `'vertexValues'` (e.g. SST).
   * When set and the tile carries that channel, each vertex's value is mapped
   * through {@link gradientColorRamp} over {@link gradientDomain}, shading the
   * line *along its length*. Takes precedence over categorical `tripColor`.
   * `NaN` values fall back to {@link colorMappingDefault}.
   */
  gradientProperty?: string | null;
  /** `[min, max]` value range mapped onto `gradientColorRamp`. */
  gradientDomain?: [number, number];
  /** Low→high color stops for the gradient ramp. */
  gradientColorRamp?: Color[];
  /**
   * Trail length in milliseconds.
   * @default 180000
   */
  trailLength?: number;
  /**
   * Fade the trail older→transparent.
   * @default true
   */
  fadeTrail?: boolean;
  /**
   * Rounded line caps.
   * @default true
   */
  capRounded?: boolean;
  /**
   * Rounded line joints.
   * @default true
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
}

/** Complete props accepted by {@link AnimatedTripsLayer}. */
export type AnimatedTripsLayerProps = _AnimatedTripsLayerProps & SpatioTemporalLayerProps;

// Shared with the maplibre adapter (single source of truth in
// @poopdeck.gl/core).
const DEFAULT_PALETTE: Color[] = DEFAULT_TRIPS_PALETTE;

/**
 * Build a per-tile palette by mapping the tile's own category dictionary
 * through an explicit string→color map. Because `instanceCategoryIndex`
 * indexes into the same per-tile `categories` array, the resulting palette
 * makes each category render the same color in every tile.
 */
function paletteFromMapping(
  categories: string[],
  mapping: Record<string, Color>,
  fallback: Color,
): Color[] {
  return categories.map((c) => mapping[c] ?? fallback);
}

/**
 * Per-tile prepared data. Cached so the `data` object reference handed to
 * deck.gl is stable across renders — deck.gl compares `data` by reference
 * to decide whether to re-tessellate / re-upload GPU buffers.
 */
interface PreparedTile {
  /** Resolved (tile, layer) cache key */
  tileKey: string;
  /** Hash of style props that affect the prepared `attributes` (color/width prop names + palette ref) */
  styleKey: string;
  /** Reference-stable data object for PathLayer's binary interface */
  data: {
    length: number;
    startIndices: Uint32Array;
    attributes: Record<string, { value: any; size: number; normalized?: boolean }>;
  };
  /** Per-tile time reference; passed to TimeFilterExtension as `timeOffset`. */
  timeOffset: number;
  /** 2 or 3 — drives `positionFormat`. */
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
 * Per-vertex time fallback when the tile lacks `vertexTimestamps`.
 *
 * Distributes each feature's [startTime, endTime] across its vertices by
 * cumulative haversine distance — matches the Rust side
 * (`interpolate_vertex_times` in stt-build/src/columnar.rs). Index-based
 * fallback (the previous behaviour) made long segments "flash" because a
 * single long edge got the same time delta as a short urban-block edge.
 *
 * The build path normally populates `binary.vertexTimestamps` directly, so
 * this only fires for tiles whose producer didn't compute per-vertex times
 * (older datasets, ad-hoc inputs). Allocated once per tile (cached in
 * PreparedTile) — not per frame.
 */
export function synthesizeVertexTimes(binary: BinaryFeatures): Float32Array {
  const startIndices = binary.startIndices!;
  const totalVerts = startIndices[binary.featureCount];
  const out = new Float32Array(totalVerts);
  const dims = binary.positionDimensions ?? 2;
  const positions = binary.positions;

  // Reused per-feature distance buffer. featureCount-bounded growth means a
  // single allocation lives across all features in this tile.
  let cum = new Float64Array(0);

  for (let i = 0; i < binary.featureCount; i++) {
    const v0 = startIndices[i];
    const v1 = startIndices[i + 1];
    const numVerts = v1 - v0;
    const featureStart = binary.startTimes[i];
    const featureEnd = binary.endTimes[i];
    const duration = featureEnd - featureStart;

    if (numVerts <= 1) {
      if (numVerts === 1) out[v0] = featureStart;
      continue;
    }
    if (duration <= 0) {
      for (let v = 0; v < numVerts; v++) out[v0 + v] = featureStart;
      continue;
    }

    if (cum.length < numVerts) cum = new Float64Array(numVerts);
    cum[0] = 0;
    let total = 0;
    for (let v = 1; v < numVerts; v++) {
      const aBase = (v0 + v - 1) * dims;
      const bBase = (v0 + v) * dims;
      total += haversineMeters(
        positions[aBase],
        positions[aBase + 1],
        positions[bBase],
        positions[bBase + 1],
      );
      cum[v] = total;
    }

    if (total <= 0) {
      for (let v = 0; v < numVerts; v++) out[v0 + v] = featureStart;
      continue;
    }
    for (let v = 0; v < numVerts; v++) {
      const frac = cum[v] / total;
      out[v0 + v] = featureStart + frac * duration;
    }
  }
  return out;
}

const EARTH_RADIUS_M = 6_371_000;

/** Haversine distance in meters. Inputs in degrees. */
function haversineMeters(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const lat1Rad = (lat1 * Math.PI) / 180;
  const lat2Rad = (lat2 * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const a =
    sinDLat * sinDLat +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/**
 * Resolve each feature's categorical color from the palette and expand it to
 * one RGBA per vertex. PathLayer renders segments as instances and maps a
 * per-vertex `getColor` onto them via its tessellator, so a per-vertex buffer
 * is the correct granularity here — a per-feature one under-sizes the draw
 * call (the cause of "vertex buffer is not big enough").
 */
function expandCategoryColors(
  indices: Uint16Array,
  palette: Color[],
  startIndices: Uint32Array,
  featureCount: number,
  totalVerts: number,
  fallback: Color,
): Uint8Array {
  const out = new Uint8Array(totalVerts * 4);
  for (let f = 0; f < featureCount; f++) {
    const c = palette[indices[f]] ?? fallback;
    const r = c[0];
    const g = c[1];
    const b = c[2];
    const a = c[3] ?? 255;
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
 * Map a per-vertex scalar array through a color ramp to one RGBA per vertex,
 * so PathLayer shades each line *along its length* (its tessellator carries
 * `getColor` as a per-vertex attribute and interpolates it across segments).
 * Each value is normalized into `[0,1]` over `domain`, then piecewise-lerped
 * across the ramp stops. `NaN` (no value) gets `fallback`.
 */
function expandGradientColors(
  values: Float32Array,
  domain: [number, number],
  ramp: Color[],
  totalVerts: number,
  fallback: Color,
): Uint8Array {
  const out = new Uint8Array(totalVerts * 4);
  const [lo, hi] = domain;
  const span = hi - lo;
  const n = ramp.length;
  const fr = fallback[0];
  const fg = fallback[1];
  const fb = fallback[2];
  const fa = fallback[3] ?? 255;
  // Guard against a degenerate ramp/domain so the loop stays branch-light.
  const safeSpan = span !== 0 ? span : 1;
  for (let v = 0; v < totalVerts; v++) {
    const o = v * 4;
    const value = values[v];
    if (n === 0 || Number.isNaN(value)) {
      out[o] = fr;
      out[o + 1] = fg;
      out[o + 2] = fb;
      out[o + 3] = fa;
      continue;
    }
    let t = (value - lo) / safeSpan;
    if (t <= 0 || n === 1) {
      const c = ramp[0];
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = c[3] ?? 255;
      continue;
    }
    if (t >= 1) {
      const c = ramp[n - 1];
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = c[3] ?? 255;
      continue;
    }
    // Locate the bracketing stops and lerp between them.
    const scaled = t * (n - 1);
    const i0 = Math.floor(scaled);
    const f = scaled - i0;
    const c0 = ramp[i0];
    const c1 = ramp[i0 + 1];
    out[o] = c0[0] + (c1[0] - c0[0]) * f;
    out[o + 1] = c0[1] + (c1[1] - c0[1]) * f;
    out[o + 2] = c0[2] + (c1[2] - c0[2]) * f;
    out[o + 3] = (c0[3] ?? 255) + ((c1[3] ?? 255) - (c0[3] ?? 255)) * f;
  }
  return out;
}

/**
 * Animated trips layer (trail mode) with per-tile binary sublayers.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`trips`**.
 * `_subLayerProps: { trips: { type: MyLayer, ...props } }` swaps the
 * sublayer class / overrides sublayer props (deck's CompositeLayer
 * contract). Without a `type` override the class is `PathLayer` when
 * `pickable` and the attribute-stripped `NoPickingPathLayer` otherwise.
 */
/** Shared stable empties for the `extraTrips*` hooks — a fresh `[]`/`{}` per
 * call would defeat deck's per-extension-set shader-pipeline cache. */
const EMPTY_EXTENSIONS: unknown[] = [];
const EMPTY_SUBLAYER_PROPS: Record<string, unknown> = {};

export class AnimatedTripsLayer<ExtraPropsT extends {} = {}> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_AnimatedTripsLayerProps>
> {
  static layerName = 'AnimatedTripsLayer';

  static defaultProps: DefaultProps<AnimatedTripsLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    widthUnits: 'pixels',
    widthScale: { type: 'number', value: 1, min: 0 },
    widthMinPixels: { type: 'number', value: 2 },
    widthMaxPixels: { type: 'number', value: 10 },
    // Permissive descriptors ({type:'object'} validates anything): these
    // props legally hold a constant OR a column-name string, which the
    // 'color'/'number' validators would reject in deck's debug mode.
    tripColor: { type: 'object', value: [253, 128, 93, 255], compare: true },
    tripWidth: { type: 'object', value: 3, compare: true },
    // Accessor-named aliases (see the prop docs): unset by default so the
    // legacy props win unless the caller opts into the upstream vocabulary.
    getColor: { type: 'object', value: null, optional: true, compare: true },
    getWidth: { type: 'object', value: null, optional: true, compare: true },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE, compare: true },
    colorMapping: { type: 'object', value: null, optional: true, compare: false },
    colorMappingDefault: { type: 'color', value: [120, 120, 120, 255] },
    gradientProperty: { type: 'object', value: null, optional: true, compare: true },
    gradientDomain: { type: 'array', value: [0, 1], compare: true },
    gradientColorRamp: { type: 'array', value: [], compare: true },
    trailLength: { type: 'number', value: 180_000, min: 0 },
    fadeTrail: true,
    capRounded: true,
    jointRounded: true,
    miterLimit: { type: 'number', value: 4, min: 0 },
    billboard: false,
  };

  /** Per-tile prepared-data cache. Pruned to the currently-visible tile set on each render. */
  private preparedTileCache = new Map<string, PreparedTile>();

  /**
   * Per-tile sublayer-instance cache. Returning the SAME `PathLayer`
   * reference across renderLayers() calls lets deck.gl short-circuit layer
   * matching + the entire prop-diff pass for that tile. Allocating a fresh
   * PathLayer per visible tile per frame (as the previous code did) showed
   * up as 30-60% of frame time once 50+ tiles were on screen — the JS-side
   * constructor + props object literal dominated even though the GPU buffer
   * upload was already short-circuited via `prepared.data`.
   *
   * Cache key is the tileKey (z/x/y/t:layer). The value carries the cache
   * keys we baked into the layer at construction time (`preparedKey`,
   * `layerPropsKey`); we reuse the cached layer iff BOTH still match.
   */
  private sublayerCache = new Map<
    string,
    { layer: PathLayer; preparedKey: PreparedTile; layerPropsKey: string }
  >();

  /**
   * Cached digest of every prop on `this.props` that we bake into a sublayer
   * at construction time. When this changes, every cached PathLayer is
   * invalidated and rebuilt on the next render.
   */
  private lastLayerPropsKey: string = '';

  /**
   * Tile-array identity from the previous render. When the parent layer
   * returns the SAME `state.tiles` reference (i.e. no setState during this
   * render cycle) we skip the prune walks over `preparedTileCache` and
   * `sublayerCache` entirely — the live set is unchanged by construction.
   */
  private lastTilesRef: Tile[] | null = null;

  /**
   * Singleton TimeFilterExtension reused by every sublayer. Extensions are
   * stateless w.r.t. data; the per-tile timeOffset is passed as a layer prop.
   */
  /**
   * Trips run in trail mode (per-vertex time + trail uniform). The
   * `mode: 'trail'` arg is forward-compat only and a NO-OP today (see the
   * TimeFilterMode docstring): the extension registers all three time
   * attributes (`instanceVertexTime` + `instanceStartTime`/`instanceEndTime`)
   * unconditionally, and the shader's trailLength branch selects per-vertex
   * time at draw. What keeps PathLayer's fp64 split + time + category combo
   * under WebGL2's 16-attribute floor is NoPickingPathLayer freeing the
   * `instancePickingColors` slot — not attribute pruning here.
   */
  private readonly timeFilterExtension = new TimeFilterExtension({ mode: 'trail' });

  /**
   * Singleton CategoryColorExtension. Replaces the per-tile CPU
   * expandPaletteColors() RGBA expansion with a one-time palette texture
   * upload and a Float32 category-index attribute per tile. The shader
   * branch is gated by useCategoryColor so the extension is inert on tiles
   * without categorical color (constant tripColor, etc.).
   */
  private readonly categoryColorExtension = new CategoryColorExtension();

  /**
   * Stable getTime reference. Critical: deck.gl re-runs work when accessor
   * function references change; a fresh arrow every render would defeat the
   * cache. The extension reads this from layer props on every draw().
   */
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
      'AnimatedTripsLayer',
      'getColor',
      this.props.getColor,
      this.props.tripColor,
    );
  }

  private widthValue(): number | string | undefined {
    return resolveAccessorAlias(
      'AnimatedTripsLayer',
      'getWidth',
      this.props.getWidth,
      this.props.tripWidth,
    );
  }

  /**
   * Compute a digest of the layer-level props that affect every sublayer.
   * When this changes we throw away the entire sublayer cache.
   */
  private computeLayerPropsKey(): string {
    const color = this.colorValue();
    const width = this.widthValue();
    return [
      this.props.widthUnits,
      this.props.widthScale,
      this.props.widthMinPixels,
      this.props.widthMaxPixels,
      this.props.capRounded,
      this.props.jointRounded,
      this.props.miterLimit,
      this.props.billboard,
      this.props.trailLength,
      this.props.fadeTrail,
      // Composite props that getSubLayerProps bakes into every sublayer
      // (opacity/pickable/visible, coordinate system, _subLayerProps, …)
      // plus the user's updateTriggers.
      inheritedPropsDigest(this.props),
      updateTriggersDigest(this.props.updateTriggers),
      this.props.timeWindow,
      this.props.timeHeightScale,
      this.props.timeHeightOrigin,
      // tripColor / tripWidth: only their "constant fallback" branch is
      // baked into the layer. The categorical/property-driven path lives
      // in `prepared` and is keyed via preparedKey.
      Array.isArray(color) ? color.join(',') : '',
      typeof width === 'number' ? width : 0,
    ].join('|');
  }

  /**
   * Trail rendering needs tiles spanning at least `trailLength` of sim time
   * before the play head. Widen the tileset time window if `timeWindow` is
   * narrower than that.
   */
  protected getEffectiveTimeWindow(): number {
    // Both `Required<>`-typed: the defaultProps values guarantee numbers here.
    return Math.max(this.props.timeWindow, this.props.trailLength * 2);
  }

  renderLayers(): Layer[] {
    const t0 = performance.now();
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) {
      this.lastTilesRef = null;
      return [];
    }

    // Skip the O(cacheSize) prune walk when the parent handed us the SAME
    // tile-array reference (no setState since the last render). The live set
    // is then identical to the cached set by construction.
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

    // If any layer-level prop changed since the last render, every cached
    // sublayer is stale — drop them all so the loop below rebuilds.
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
        // Two-part hit check: the prepared-data object reference (which
        // captures style key + tile identity) AND the layer-level props
        // digest. We pass the SAME PathLayer reference back unless either
        // changed.
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
      layer: 'AnimatedTripsLayer',
      tiles: tiles.length,
      sublayers: sublayers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`AnimatedTripsLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`);
    }
    return sublayers;
  }

  /**
   * Build the binary `data` object for a single tile, or return the cached
   * entry when the tile and style key are unchanged.
   */
  /**
   * The per-vertex scalar array fed to the gradient ramp. Base: the static
   * `vertexValues` channel (e.g. drifter SST). {@link FlowCorridorLayer}
   * overrides this to select/blend a time-bucket column from a per-vertex value
   * matrix, so the corridor geometry stays resident on the GPU while the
   * playhead picks the colors.
   */
  protected gradientValuesFor(
    binary: BinaryFeatures,
    _totalVerts: number,
  ): Float32Array | undefined {
    return this.props.gradientProperty === 'vertexValues' ? binary.vertexValues : undefined;
  }

  /**
   * Post-process the freshly-expanded per-vertex RGBA color buffer (from the
   * gradient ramp) in place, before it is uploaded as the `getColor` attribute.
   * Base is a no-op; {@link FlowCorridorLayer} overrides it to pack a SECOND
   * per-vertex signal (instantaneous per-trip flow) into the alpha byte without
   * adding a GPU attribute — the RGB carries the aggregate ramp color, the alpha
   * carries the instant. Called only on the gradient path.
   */
  protected finalizeGradientColorBuffer(
    _colors: Uint8Array,
    _binary: BinaryFeatures,
    _totalVerts: number,
  ): void {
    // no-op
  }

  /**
   * PER-VERTEX chevron direction sign (length `totalVerts`), or `undefined` to
   * leave direction to the geometry winding. {@link FlowCorridorLayer} overrides
   * it (when `signedFlow`) to read the sign of the SIGNED value matrix's active
   * bucket, so `ChevronFlowExtension({ perBucketDirection: true })` flips the
   * arrows per time-step. Wired to the `instanceChevronDir` attribute — the same
   * per-vertex plumbing as the gradient `getColor` / dynamic `getWidth` buffers.
   */
  protected chevronDirectionsFor(
    _binary: BinaryFeatures,
    _totalVerts: number,
  ): Float32Array | undefined {
    return undefined;
  }

  /**
   * Extra token folded into the prepared-tile `styleKey` so a time-driven
   * gradient invalidates the CPU-expanded per-vertex colors as the playhead
   * advances. Base: '' (the static gradient never varies with time).
   */
  protected gradientStyleSuffix(_binary: BinaryFeatures): string {
    return '';
  }

  /**
   * Per-feature `[start, end]` times (relative to the tile `timeOffset`) to feed
   * the window-mode time filter's `instanceStartTime`/`instanceEndTime`, or
   * `null` to leave them at the accessor default (0). Base returns null — trail
   * trips animate via `instanceVertexTime`, not these. {@link FlowCorridorLayer}
   * returns the corridor's FULL range so its static geometry stays visible
   * under `trailLength: 0` (otherwise the window hides it once the playhead
   * passes `windowHalf`, since the unset attributes default to 0).
   */
  protected timeBoundsForSublayer(
    _binary: BinaryFeatures,
  ): { start: number; end: number } | null {
    return null;
  }

  /**
   * PER-VERTEX width override (length `totalVerts`, aligned 1:1 with `positions`
   * exactly like the gradient `getColor` buffer — PathLayer's `instanceStrokeWidths`
   * is per-SEGMENT-instanced, so a shorter per-feature buffer under-sizes the draw).
   * Base: `undefined`, so the static `getWidth`/`tripWidth` accessor wins.
   * {@link FlowStrokeLayer} overrides it to make width breathe with the active
   * time-bucket volume (√-scaled) and taper along each trunk, reusing the same
   * sub-step cache machinery as the gradient color (recomputes exactly when
   * `gradientStyleSuffix` changes). Anything shorter than `totalVerts` is ignored.
   */
  protected widthsFor(
    _binary: BinaryFeatures,
    _featureCount: number,
  ): Float32Array | undefined {
    return undefined;
  }

  /**
   * Extra deck extensions appended (after the time-filter + category-color
   * singletons) to every sublayer of this instance. MUST return a stable
   * reference per instance — deck caches compiled shader pipelines per extension
   * set, so a fresh array each call defeats that cache. Base: a shared empty
   * array. {@link FlowStrokeLayer} adds a `PathStyleExtension({offset:true})` for
   * the twin-ribbon offset.
   */
  protected extraTripsExtensions(): unknown[] {
    return EMPTY_EXTENSIONS;
  }

  /**
   * Extra sublayer props merged into every trips sublayer (e.g. the constant
   * `getOffset` that pairs with {@link FlowStrokeLayer}'s offset extension).
   * Base: a shared empty object. User `_subLayerProps.trips` still wins, as it
   * is applied last by `composeSubLayerProps`.
   */
  protected extraTripsSubLayerProps(): Record<string, unknown> {
    return EMPTY_SUBLAYER_PROPS;
  }

  /**
   * Whether to install the (idle-for-trips) CategoryColorExtension. Base: true.
   * A subclass that never categorically colors AND needs an extra attribute slot
   * (e.g. {@link FlowStrokeLayer}, which adds PathStyleExtension's offset) returns
   * false to drop `instanceCategoryIndex` and stay under WebGL2's 16-attribute
   * floor. Must be constant per instance (shader-pipeline cache).
   */
  protected includeCategoryColorExtension(): boolean {
    return true;
  }

  private prepareTile(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0 || !binary.startIndices) return null;

    const colorValue = this.colorValue();
    const widthValue = this.widthValue();
    const colorProp = typeof colorValue === 'string' ? colorValue : '';
    const widthProp = typeof widthValue === 'string' ? widthValue : '';
    // Palette / mapping / ramp keyed by CONTENT, not length or key-count — a
    // same-size swap must invalidate the CPU-expanded per-vertex colors.
    // Digests are memoized per object reference (style-digest.ts), so this is
    // a WeakMap lookup per tile, not a re-serialization.
    const mapSig = this.props.colorMapping
      ? `m${colorMappingDigest(this.props.colorMapping)}`
      : '';
    // Gradient signature: property + domain + ramp content. Including the
    // domain invalidates the cached per-vertex colors when the scale changes.
    const gradSig = this.props.gradientProperty
      ? `g${this.props.gradientProperty}:${(this.props.gradientDomain ?? [0, 1]).join(',')}:${
          this.props.gradientColorRamp ? colorListDigest(this.props.gradientColorRamp) : ''
        }`
      : '';
    const styleKey = `${colorProp}|${widthProp}|${
      colorProp ? colorListDigest(this.props.colorPalette ?? DEFAULT_PALETTE) : 0
    }|${mapSig}|${gradSig}${this.gradientStyleSuffix(binary)}|${updateTriggersDigest(
      this.props.updateTriggers,
    )}`;

    const tileKey = makeTileKey(tile, tileLayer);
    const cached = this.preparedTileCache.get(tileKey);
    if (cached && cached.styleKey === styleKey) {
      emit('tilePrepare', { layer: 'AnimatedTripsLayer', tileKey, cached: true, ms: 0 });
      return cached;
    }

    const t0 = performance.now();
    const dims = binary.positionDimensions ?? 2;
    const totalVerts = binary.startIndices[binary.featureCount];

    // Per-vertex time: prefer the tile's own array (zero-copy from Arrow).
    // Fallback synthesizes from feature start/end times; allocated once and
    // cached on the PreparedTile so subsequent renders reuse it.
    //
    // EXCEPTION — per-bucket chevron direction (FlowCorridorLayer signedFlow):
    // this slot carries the per-vertex DIRECTION SIGN instead. Flow-corridor tiles
    // run window mode, where TimeFilterExtension never reads instanceVertexTime
    // (only trail mode does), so ChevronFlowExtension({ perBucketDirection }) reads
    // it for the sign — reusing an allocated-but-idle attribute rather than adding
    // one (PathLayer already sits at WebGL2's 16-attribute link ceiling).
    const chevronDirs = this.chevronDirectionsFor(binary, totalVerts);
    const vertexTimes: Float32Array =
      chevronDirs && chevronDirs.length >= totalVerts
        ? chevronDirs
        : binary.vertexTimestamps && binary.vertexTimestamps.length >= totalVerts
          ? binary.vertexTimestamps
          : synthesizeVertexTimes(binary);

    const attributes: PreparedTile['data']['attributes'] = {
      // PathLayer's positions attribute — keyed by ACCESSOR NAME `getPath`.
      // Float64Array is required so deck.gl's fp64 attribute populates the
      // hi/lo split correctly; a Float32Array buffer leaves the low half
      // zero and renders coordinates with ~m-scale jitter at high zoom.
      getPath: { value: binary.positions, size: dims },
      // Extension-registered attribute — keyed by the EXACT registered
      // attribute name `instanceVertexTime` (see TimeFilterExtension
      // .initializeState). The accessor name `getInstanceVertexTime` does
      // NOT work for the binary interface.
      instanceVertexTime: { value: vertexTimes, size: 1 },
    };

    // Per-vertex gradient color takes precedence over categorical: map each
    // vertex's scalar (currently only `vertexValues`, e.g. SST) through the
    // ramp so the line shades along its length. Built per-vertex for the same
    // reason as the categorical path below — PathLayer needs per-vertex colors.
    const gradientValues = this.gradientValuesFor(binary, totalVerts);
    if (
      gradientValues &&
      gradientValues.length >= totalVerts &&
      this.props.gradientColorRamp &&
      this.props.gradientColorRamp.length > 0
    ) {
      const gradientColorBuffer = expandGradientColors(
        gradientValues,
        this.props.gradientDomain ?? [0, 1],
        this.props.gradientColorRamp,
        totalVerts,
        this.props.colorMappingDefault ?? [120, 120, 120, 255],
      );
      // Seam for a second per-vertex signal packed into alpha (FlowCorridorLayer
      // per-trip lighting). No-op in the base class.
      this.finalizeGradientColorBuffer(gradientColorBuffer, binary, totalVerts);
      attributes.getColor = {
        value: gradientColorBuffer,
        size: 4,
        normalized: true,
      };
    } else if (colorProp) {
      // Property-driven categorical color. PathLayer instances are SEGMENTS,
      // not features, so the GPU per-feature `instanceCategoryIndex` path
      // (correct for the point layer) under-sizes the instanced buffer here and
      // throws "vertex buffer is not big enough". Resolve each feature's color
      // on the CPU and expand it per-vertex instead — PathLayer's tessellator
      // maps a per-vertex `getColor` onto its segment instances natively. The
      // extra 4 bytes/vertex is negligible at trip-dataset scale.
      const cat = binary.categoricalProps[colorProp];
      if (cat) {
        // Explicit colorMapping → stable per-tile palette (resolved against
        // this tile's own category dictionary); else the ordered colorPalette.
        const palette = this.props.colorMapping
          ? paletteFromMapping(
              cat.categories,
              this.props.colorMapping,
              this.props.colorMappingDefault ?? [120, 120, 120, 255],
            )
          : this.props.colorPalette ?? DEFAULT_PALETTE;
        attributes.getColor = {
          value: expandCategoryColors(
            cat.indices,
            palette,
            binary.startIndices,
            binary.featureCount,
            totalVerts,
            this.props.colorMappingDefault ?? [120, 120, 120, 255],
          ),
          size: 4,
          normalized: true,
        };
      }
    }
    // The GPU CategoryColorExtension stays installed (constant extension list
    // keeps shader pipelines cached) but idle for trips: its instanced index
    // can't ride PathLayer's segment tessellation, so we color via getColor.
    const gpuPalette: Color[] | null = null;

    // Property-driven width is already a Float32Array of length featureCount
    // — pass it through with zero copy.
    if (widthProp) {
      const values = binary.numericProps[widthProp];
      if (values) {
        attributes.getWidth = { value: values, size: 1 };
      }
    }
    // Dynamic PER-VERTEX width hook (FlowStrokeLayer: active-bucket volume). Wins
    // over the static `widthProp` when present; recomputed on each sub-step
    // because gradientStyleSuffix folds the playhead into the styleKey above.
    // MUST be per-vertex (length totalVerts), NOT per-feature: PathLayer's
    // `instanceStrokeWidths` is a per-SEGMENT-instanced attribute, so a
    // featureCount-length buffer is too small for the draw ("vertex buffer is not
    // big enough"). Per-vertex mirrors the getColor path exactly (and lets width
    // taper along the line).
    const dynWidths = this.widthsFor(binary, binary.featureCount);
    if (dynWidths && dynWidths.length >= totalVerts) {
      attributes.getWidth = { value: dynWidths, size: 1 };
    }
    // NOTE: the per-vertex chevron direction sign (signedFlow) is carried on the
    // instanceVertexTime attribute above — see the comment there. No separate
    // attribute is added, to stay under WebGL2's 16-attribute ceiling.

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
      layer: 'AnimatedTripsLayer',
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
      : [253, 128, 93, 255]) as Color;
    const constWidth = typeof widthValue === 'number' ? widthValue : 2;
    // `Required<>`-typed: the defaultProps value guarantees a number here.
    const timeWindow = this.props.timeWindow;
    // Per-feature [start,end] for the window-mode filter (null for trail trips).
    const timeBounds = this.timeBoundsForSublayer(prepared.features);

    // Always false for trips — gpuPalette is intentionally hardwired null in
    // prepareTile (CPU per-vertex colors; GPU palette indices can't ride
    // PathLayer's segment tessellation). Plumbing kept for family parity.
    const useGpuCategory = prepared.gpuPalette !== null;

    // Keep the extension list constant across all sublayers of this
    // AnimatedTripsLayer instance — deck.gl caches compiled shader
    // pipelines per extension set, and a varying list produces one cache
    // entry per (set, props) combination, which manifests as 0.3 FPS
    // shader-rebuild storms during tile churn. CategoryColorExtension
    // sits idle when `useCategoryColor` is false (gated in its own
    // shader branch via the uniform). User extensions from the top-level
    // `extensions` prop are appended (composeExtensions) — the contract
    // holds as long as the caller's entries compare equal across renders.
    // Category-color is idle for some subclasses (FlowStrokeLayer colors via the
    // gradient, never categorically) — dropping its `instanceCategoryIndex`
    // attribute there frees a WebGL2 vertex-attribute slot for an extra extension
    // (e.g. PathStyleExtension's offset), which otherwise overflows the 16-slot
    // floor on GPUs that report exactly 16. The list stays CONSTANT per instance
    // (the subclass's choice never changes), so shader-pipeline caching holds.
    const baseExtensions: unknown[] = this.includeCategoryColorExtension()
      ? [this.timeFilterExtension, this.categoryColorExtension]
      : [this.timeFilterExtension];
    const extensions = this.composeExtensions([
      ...baseExtensions,
      ...this.extraTripsExtensions(),
    ]);

    // getSubLayerProps inheritance (opacity/pickable/visible, coordinate
    // system, highlight props, …) + user `_subLayerProps.trips` overrides.
    // Only runs inside this cache-gated build path — never per frame.
    // positionFormat is passed explicitly (sublayerProps beats inheritance):
    // PathLayer's default 'XYZ' would misread 2D tile buffers.
    const props = this.composeSubLayerProps('trips', prepared.tileKey, {
      data: prepared.data,
      // Identity comparator: deck.gl skips prop-diff on `data` when the same
      // object reference comes back. Pairs with preparedTileCache.
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

      // Constants are harmless when the binary attribute is present (binary
      // attributes win); they only kick in for tiles missing the property.
      getColor: constColor,
      getWidth: constWidth,
      // Subclass extras (e.g. FlowStrokeLayer's constant getOffset for the
      // PathStyleExtension twin-ribbon offset). Empty for the base class.
      ...this.extraTripsSubLayerProps(),

      extensions,
      // Dynamic time: extension reads getTime() on every draw, so we never
      // recreate the layer for time-only changes.
      getTime: this.boundGetTime,
      timeOffset: prepared.timeOffset,
      timeWindow,
      // Time-as-height (space-time cube): a pure uniform pair, so the morph
      // slider only re-issues sublayer props — no data/GPU re-upload.
      timeHeightScale: this.props.timeHeightScale,
      timeHeightOrigin: this.props.timeHeightOrigin,
      trailLength: this.props.trailLength,
      // Whether the trail fades head→tail or renders solid. Previously this
      // prop was baked into the sublayer cache key but never reached the
      // TimeFilterExtension, so `fadeTrail: false` was a silent no-op.
      fadeTrail: this.props.fadeTrail,
      // Static-geometry layers (FlowCorridorLayer) feed the corridor's full
      // [start,end] so the window-mode filter never hides it; trail trips leave
      // these unset (instanceVertexTime drives visibility instead).
      ...(timeBounds && {
        getInstanceStartTime: timeBounds.start,
        getInstanceEndTime: timeBounds.end,
      }),

      // TileLayer convention: the source tile rides on the sublayer so the
      // base getPickingInfo can enrich info.tile / decode the picked trip.
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
    // accepted, with a warning. The picked instance index is the trip index
    // within the tile; getPickingInfo decodes its properties from there.
    // A `_subLayerProps: { trips: { type } }` override beats both defaults.
    if (this.props.pickable) {
      warnOnce(
        'AnimatedTripsLayer:pickableAttributeBudget',
        '[AnimatedTripsLayer] pickable:true renders through the stock PathLayer ' +
          'so picking works, but its instancePickingColors attribute can exceed ' +
          "WebGL2's 16-vertex-attribute minimum on some GPUs (link warning).",
      );
      const SubLayerClass = this.getSubLayerClass('trips', PathLayer);
      return new SubLayerClass(props as any);
    }
    // NoPickingPathLayer frees the `instancePickingColors` attribute slot,
    // which keeps the fp64 + TimeFilter + CategoryColor combo under WebGL2's
    // 16-attribute minimum. Sublayers here are non-pickable, so dropping the
    // picking buffer is a no-op behaviourally. See `no-picking-path-layer.ts`
    // for the upstream-fix timeline.
    const SubLayerClass = this.getSubLayerClass('trips', NoPickingPathLayer);
    return new SubLayerClass(props as any);
  }
}

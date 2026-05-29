// @stt/deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/deck.gl contributors

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
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
import { NoPickingPathLayer } from './no-picking-path-layer';
import { TimeFilterExtension } from './time-filter-extension';
import {
  CategoryColorExtension,
  CATEGORY_PALETTE_SIZE,
} from './category-color-extension';
import { emit } from './telemetry';
import { warnOnce } from './log';
import type { Tile, Layer as TileLayer, BinaryFeatures } from '@stt/core';

const DEBUG = false;

export interface AnimatedTripsLayerProps extends SpatioTemporalLayerProps {
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
   * Trip width — constant number, or property name for per-feature width.
   * @default 3
   */
  tripWidth?: number | string;
  /** Color palette for categorical `tripColor`. */
  colorPalette?: Color[];
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
}

const DEFAULT_PALETTE: Color[] = [
  [253, 128, 93, 255],
  [0, 150, 255, 255],
  [44, 160, 44, 255],
  [214, 39, 40, 255],
  [148, 103, 189, 255],
];

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
function synthesizeVertexTimes(binary: BinaryFeatures): Float32Array {
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
 * Narrow Uint16Array → Float32Array for the GPU CategoryColorExtension.
 * Allocated once per (tile, style change) and cached on the PreparedTile.
 */
function indicesToFloat32(indices: Uint16Array, count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = indices[i];
  return out;
}

export class AnimatedTripsLayer extends SpatioTemporalLayer<AnimatedTripsLayerProps> {
  static layerName = 'AnimatedTripsLayer';

  static defaultProps: DefaultProps<AnimatedTripsLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    widthScale: { type: 'number', value: 1, min: 0 },
    widthMinPixels: { type: 'number', value: 2 },
    widthMaxPixels: { type: 'number', value: 10 },
    tripColor: { type: 'color', value: [253, 128, 93, 255] },
    tripWidth: { type: 'number', value: 3 },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE, compare: true },
    trailLength: { type: 'number', value: 180_000, min: 0 },
    fadeTrail: true,
    capRounded: true,
    jointRounded: true,
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
   * Trips always use trail-mode filtering (per-vertex time + trail uniform),
   * so we register ONLY `instanceVertexTime` and skip the
   * `instanceStartTime` / `instanceEndTime` pair. That frees up two
   * vertex-attribute slots — critical because PathLayer's fp64 position
   * split + `instancePickingColors` + CategoryColorExtension already crowd
   * the WebGL2 16-attribute minimum. Without this fix the nyc-taxi-trips
   * and hero-trips sublayers hit
   *   "WebGL Link error: Too many attributes (instancePickingColors)".
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
   * Compute a digest of the layer-level props that affect every sublayer.
   * When this changes we throw away the entire sublayer cache.
   */
  private computeLayerPropsKey(): string {
    return [
      this.props.widthScale,
      this.props.widthMinPixels,
      this.props.widthMaxPixels,
      this.props.capRounded,
      this.props.jointRounded,
      this.props.trailLength,
      this.props.fadeTrail,
      this.props.opacity,
      this.props.visible,
      this.props.pickable,
      this.props.timeWindow,
      // tripColor / tripWidth: only their "constant fallback" branch is
      // baked into the layer. The categorical/property-driven path lives
      // in `prepared` and is keyed via preparedKey.
      Array.isArray(this.props.tripColor)
        ? this.props.tripColor.join(',')
        : '',
      typeof this.props.tripWidth === 'number' ? this.props.tripWidth : 0,
    ].join('|');
  }

  /**
   * Trail rendering needs tiles spanning at least `trailLength` of sim time
   * before the play head. Widen the tileset time window if `timeWindow` is
   * narrower than that.
   */
  protected getEffectiveTimeWindow(): number {
    const baseWindow = this.props.timeWindow || 86400000;
    const trailLength = this.props.trailLength || 180000;
    return Math.max(baseWindow, trailLength * 2);
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
  private prepareTile(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0 || !binary.startIndices) return null;

    const colorProp = typeof this.props.tripColor === 'string' ? this.props.tripColor : '';
    const widthProp = typeof this.props.tripWidth === 'string' ? this.props.tripWidth : '';
    // Palette identity matters only when colorProp is set. Including its
    // length in the key is a cheap way to invalidate when the palette changes.
    const styleKey = `${colorProp}|${widthProp}|${
      colorProp ? (this.props.colorPalette ?? DEFAULT_PALETTE).length : 0
    }`;

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
    const vertexTimes: Float32Array =
      binary.vertexTimestamps && binary.vertexTimestamps.length >= totalVerts
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

    // Property-driven categorical color: GPU path via CategoryColorExtension.
    // The previous CPU expansion allocated a fresh 4n-byte Uint8Array per
    // tile-style change; the GPU path uploads a 4n-byte Float32 attribute
    // (one-time) and indexes a shared 16 KB palette texture in the shader.
    let gpuPalette: Color[] | null = null;
    if (colorProp) {
      const cat = binary.categoricalProps[colorProp];
      if (cat) {
        attributes.instanceCategoryIndex = {
          value: indicesToFloat32(cat.indices, binary.featureCount),
          size: 1,
        };
        gpuPalette = this.props.colorPalette ?? DEFAULT_PALETTE;
      }
    }

    // Property-driven width is already a Float32Array of length featureCount
    // — pass it through with zero copy.
    if (widthProp) {
      const values = binary.numericProps[widthProp];
      if (values) {
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
    const sublayerId = `${this.props.id}-${prepared.tileKey}`;

    const constColor = (Array.isArray(this.props.tripColor)
      ? this.props.tripColor
      : [253, 128, 93, 255]) as Color;
    const constWidth = typeof this.props.tripWidth === 'number' ? this.props.tripWidth : 2;
    const timeWindow = this.props.timeWindow || 86400000;

    const useGpuCategory = prepared.gpuPalette !== null;
    if (
      useGpuCategory &&
      prepared.gpuPalette!.length > CATEGORY_PALETTE_SIZE
    ) {
      warnOnce(
        'AnimatedTripsLayer:paletteOverflow',
        `[AnimatedTripsLayer] colorPalette has ${prepared.gpuPalette!.length} ` +
          `entries; only the first ${CATEGORY_PALETTE_SIZE} will be used by ` +
          'CategoryColorExtension.',
      );
    }

    // Keep the extension list constant across all sublayers of this
    // AnimatedTripsLayer instance — deck.gl caches compiled shader
    // pipelines per extension set, and a varying list produces one cache
    // entry per (set, props) combination, which manifests as 0.3 FPS
    // shader-rebuild storms during tile churn. CategoryColorExtension
    // sits idle when `useCategoryColor` is false (gated in its own
    // shader branch via the uniform).
    const extensions: any[] = [this.timeFilterExtension, this.categoryColorExtension];

    const props: Record<string, any> = {
      id: sublayerId,
      data: prepared.data,
      // Identity comparator: deck.gl skips prop-diff on `data` when the same
      // object reference comes back. Pairs with preparedTileCache.
      dataComparator: (a: any, b: any) => a === b,
      _pathType: 'open',
      // PathLayer defaults positionFormat to 'XYZ'; 2D paths must opt out or
      // every vertex is read with the wrong stride.
      positionFormat: prepared.dims === 3 ? 'XYZ' : 'XY',
      widthUnits: 'pixels',
      widthScale: this.props.widthScale ?? 1,
      widthMinPixels: this.props.widthMinPixels,
      widthMaxPixels: this.props.widthMaxPixels,
      capRounded: this.props.capRounded,
      jointRounded: this.props.jointRounded,
      opacity: this.props.opacity,
      visible: this.props.visible,
      pickable: this.props.pickable ?? false,

      // Constants are harmless when the binary attribute is present (binary
      // attributes win); they only kick in for tiles missing the property.
      getColor: constColor,
      getWidth: constWidth,

      extensions,
      // Dynamic time: extension reads getTime() on every draw, so we never
      // recreate the layer for time-only changes.
      getTime: this.boundGetTime,
      timeOffset: prepared.timeOffset,
      timeWindow,
      trailLength: this.props.trailLength,
      // Whether the trail fades head→tail or renders solid. Previously this
      // prop was baked into the sublayer cache key but never reached the
      // TimeFilterExtension, so `fadeTrail: false` was a silent no-op.
      fadeTrail: this.props.fadeTrail,
    };
    props.useCategoryColor = useGpuCategory;
    if (useGpuCategory) {
      props.categoryPalette = prepared.gpuPalette!;
    }
    // NoPickingPathLayer frees the `instancePickingColors` attribute slot,
    // which keeps the fp64 + TimeFilter + CategoryColor combo under WebGL2's
    // 16-attribute minimum. Sublayers here are always `pickable: false`, so
    // dropping the picking buffer is a no-op behaviourally. See
    // `no-picking-path-layer.ts` for the upstream-fix timeline.
    return new NoPickingPathLayer(props as any);
  }
}

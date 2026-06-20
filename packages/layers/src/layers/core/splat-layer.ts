// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * SplatLayer — render a spatiotemporal point cloud as **oriented anisotropic
 * Gaussian surfels** that evolve over time: a "formal" splat for STT.
 *
 * Where {@link AnimatedPointLayer} `splat: true` draws each return as a soft
 * round billboard (an isotropic point splat — no orientation, no surface), this
 * layer draws each feature as a real oriented elliptical disk lying in its local
 * surface frame, with a soft radial Gaussian profile AND a soft temporal
 * Gaussian weight. Overlapping surfels read as continuous, depth-correct surface
 * — *surface splatting* (Pfister/Zwicker surfels, Zwicker "EWA Surface
 * Splatting"), the right formalism for splats derived from a surface scan.
 *
 * It consumes the columns baked by `scripts/data-generation/waymo_extract.py
 * --surfel` (k-NN covariance per LIDAR sweep):
 *   • geometry `[lng, lat]` + an elevation column (`z`, metres) → the surfel
 *     centre,
 *   • a surface-frame quaternion (`qx,qy,qz,qw`) whose matrix columns are
 *     `[tangent | bitangent | normal]` in the render ENU frame,
 *   • two in-plane half-extents (`s_major, s_minor`, metres),
 *   • per-surfel RGB (`r,g,b`, 0–255 — camera-projected colour) and a
 *     confidence (`surfel_opacity`, 0–1) folded into the disk alpha,
 *   • the per-feature sample time (start time) → the temporal Gaussian centre.
 *
 * ── ARCHITECTURE ─────────────────────────────────────────────────────────────
 * Mirrors {@link AnimatedPointLayer}'s v3 per-tile binary-sublayer design: one
 * {@link SplatPrimitiveLayer} per (tile, layer), reference-stable `data` cached
 * across renders so deck.gl short-circuits GPU re-uploads, time driven by a
 * shared `getTime` callback (no layer recreation per tick). Streaming is
 * additive (a new tile = one sublayer + one upload). Picking rides the base
 * {@link SpatioTemporalLayer.getPickingInfo} (each sublayer carries its `tile` +
 * `sttFeatures`).
 *
 * Sublayer short id for `_subLayerProps` overrides: **`splats`**.
 *
 * MapView only — the disk offset is computed in web-mercator common space;
 * GlobeView's non-linear projection is out of scope (the AV cockpit, the
 * intended consumer, is a tilted MapView).
 */

import type {
  Color,
  DefaultProps,
  Layer,
  LayerContext,
} from '@deck.gl/core';
import {
  SpatioTemporalLayer,
  SpatioTemporalLayerProps,
} from '../spatiotemporal-layer';
import { SplatPrimitiveLayer } from '../internal/splat-primitive-layer';
import { emit } from '../../lib/telemetry';
import { warnOnce } from '../../lib/log';
import {
  inheritedPropsDigest,
  updateTriggersDigest,
} from '../../lib/style-digest';
import type { Tile, Layer as TileLayer } from '@poopdeck.gl/core';

const DEBUG = false;

/** Props added by {@link SplatLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link SplatLayerProps}). */
export interface _SplatLayerProps {
  /**
   * Four NUMERIC column names holding the surfel orientation quaternion
   * `[qx, qy, qz, qw]`. The quaternion's rotation-matrix COLUMNS are the
   * surfel's `[tangent | bitangent | normal]` (the `--surfel` extractor packs
   * them that way). A tile missing any of the four is skipped (warns once).
   * @default ['qx','qy','qz','qw']
   */
  quaternionColumns?: [string, string, string, string];

  /**
   * Two NUMERIC column names holding the in-plane half-extents
   * `[s_major, s_minor]` in metres (the two larger eigen-extents of the local
   * covariance). A tile missing either is skipped (warns once).
   * @default ['s_major','s_minor']
   */
  scaleColumns?: [string, string];

  /**
   * Three NUMERIC column names holding per-surfel RGB (each 0–255). When
   * present, each surfel is painted that colour; otherwise `fallbackColor` is
   * used for all surfels.
   * @default ['r','g','b']
   */
  rgbColumns?: [string, string, string] | null;

  /**
   * NUMERIC column name holding a per-surfel confidence in `[0,1]`, folded into
   * the disk alpha (× `opacity`). Absent ⇒ full confidence.
   * @default 'surfel_opacity'
   */
  opacityColumn?: string | null;

  /**
   * NUMERIC column name holding each surfel's altitude in metres (the cloud's
   * real height). Absent ⇒ z = 0 (a flat carpet — almost never what you want
   * for a 3D scan).
   * @default 'z'
   */
  elevationProperty?: string | null;

  /** Multiplier applied to {@link elevationProperty} before it becomes z. @default 1 */
  elevationScale?: number;

  /** Constant RGBA used when {@link rgbColumns} is unset / absent. @default [200,205,215,255] */
  fallbackColor?: Color;

  /**
   * Soft temporal Gaussian width in milliseconds. Each surfel's opacity is
   * multiplied by `exp(-½·((t-μ_t)/σ)²)` with `μ_t` its sample time and `σ`
   * this value — so the cloud brightens at each sweep's instant and fades
   * smoothly within ±~3σ instead of hard-popping on a window edge. Tune to
   * ~1–2× the sweep interval (Waymo LIDAR ≈ 100 ms). @default 180
   */
  temporalSigma?: number;

  /** Multiplier on every surfel's baked in-plane extents. @default 1 */
  sizeScale?: number;

  /** Radial Gaussian tightness (`alpha *= exp(-falloff·r²)` over the disk). @default 3 */
  gaussianFalloff?: number;

  /**
   * Discard fragments whose final alpha is below this, so faint disk rims never
   * write depth (no halo) while the confident core does. @default 0.04
   */
  alphaCutoff?: number;
}

/** Complete props accepted by {@link SplatLayer}. */
export type SplatLayerProps = _SplatLayerProps & SpatioTemporalLayerProps;

const DEFAULT_FALLBACK_COLOR: Color = [200, 205, 215, 255];

/**
 * Per-tile prepared data — a reference-stable binary `data` object for one
 * {@link SplatPrimitiveLayer}, cached so deck.gl skips GPU re-uploads on
 * unchanged tiles (identity `dataComparator`). Mirrors AnimatedPointLayer's
 * PreparedTile.
 */
interface PreparedSplatTile {
  tileKey: string;
  styleKey: string;
  data: {
    length: number;
    attributes: Record<string, { value: any; size: number; normalized?: boolean }>;
  };
  timeOffset: number;
  tile: Tile;
  layerName: string;
}

function makeTileKey(tile: Tile, layer: TileLayer): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}:${layer.name}`;
}

/**
 * Spatiotemporal oriented-Gaussian-surfel layer. See the file docstring.
 */
export class SplatLayer<ExtraPropsT extends {} = {}> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_SplatLayerProps>
> {
  static layerName = 'SplatLayer';

  static defaultProps: DefaultProps<SplatLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    // Permissive {type:'object'} descriptors — these hold column-name tuples /
    // a Color, which deck's typed validators would reject.
    quaternionColumns: { type: 'object', value: ['qx', 'qy', 'qz', 'qw'], compare: true },
    scaleColumns: { type: 'object', value: ['s_major', 's_minor'], compare: true },
    rgbColumns: { type: 'object', value: ['r', 'g', 'b'], optional: true, compare: true },
    opacityColumn: { type: 'object', value: 'surfel_opacity', optional: true, compare: true },
    elevationProperty: { type: 'object', value: 'z', optional: true, compare: true },
    elevationScale: { type: 'number', value: 1 },
    fallbackColor: { type: 'color', value: DEFAULT_FALLBACK_COLOR },
    temporalSigma: { type: 'number', value: 180, min: 1 },
    sizeScale: { type: 'number', value: 1, min: 0 },
    gaussianFalloff: { type: 'number', value: 3, min: 0 },
    alphaCutoff: { type: 'number', value: 0.04, min: 0 },
  };

  /** Per-tile prepared-data cache. Pruned to the live tile set each render. */
  private preparedTileCache = new Map<string, PreparedSplatTile>();
  /** Per-tile sublayer-instance cache — stable refs let deck skip prop diff. */
  private sublayerCache = new Map<
    string,
    { layer: SplatPrimitiveLayer; preparedKey: PreparedSplatTile; layerPropsKey: string }
  >();
  private lastLayerPropsKey = '';
  private lastTilesRef: Tile[] | null = null;

  /** Stable getTime ref — a fresh arrow each render would defeat deck's cache. */
  private readonly boundGetTime: () => number = () => this.getCurrentTime();

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.preparedTileCache.clear();
    this.sublayerCache.clear();
  }

  /**
   * Digest of props baked into a tile's prepared `attributes` (which columns,
   * elevation, fallback color). A change invalidates the prepared cache.
   */
  private computeStyleKey(): string {
    const q = this.props.quaternionColumns ?? ['qx', 'qy', 'qz', 'qw'];
    const s = this.props.scaleColumns ?? ['s_major', 's_minor'];
    const rgb = this.props.rgbColumns;
    const op = typeof this.props.opacityColumn === 'string' ? this.props.opacityColumn : '';
    const elev = typeof this.props.elevationProperty === 'string' ? this.props.elevationProperty : '';
    const elevScale = elev ? (this.props.elevationScale ?? 1) : 0;
    const fb = this.props.fallbackColor ?? DEFAULT_FALLBACK_COLOR;
    return [
      q.join(','),
      s.join(','),
      rgb ? rgb.join(',') : 'none',
      op,
      `${elev}:${elevScale}`,
      Array.isArray(fb) ? fb.join('.') : '',
      updateTriggersDigest(this.props.updateTriggers),
    ].join('|');
  }

  /** Digest of the layer-level props baked into every sublayer (visual + time). */
  private computeLayerPropsKey(): string {
    return [
      this.props.temporalSigma,
      this.props.sizeScale,
      this.props.gaussianFalloff,
      this.props.alphaCutoff,
      this.props.timeWindow,
      inheritedPropsDigest(this.props),
      updateTriggersDigest(this.props.updateTriggers),
    ].join('|');
  }

  renderLayers(): Layer[] {
    const t0 = performance.now();
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) {
      this.lastTilesRef = null;
      return [];
    }

    // Prune caches only when the tile-array ref changed (same array ⇒ same set).
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
        if (cached && cached.preparedKey === prepared && cached.layerPropsKey === layerPropsKey) {
          sublayers.push(cached.layer);
          continue;
        }
        const layer = this.buildSublayer(prepared);
        this.sublayerCache.set(prepared.tileKey, { layer, preparedKey: prepared, layerPropsKey });
        sublayers.push(layer);
      }
    }

    emit('renderLayers', {
      layer: 'SplatLayer',
      tiles: tiles.length,
      sublayers: sublayers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`SplatLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`);
    }
    return sublayers;
  }

  private prepareTile(tile: Tile, tileLayer: TileLayer): PreparedSplatTile | null {
    if (tileLayer.features.featureCount === 0) return null;
    const styleKey = this.computeStyleKey();
    const tileKey = makeTileKey(tile, tileLayer);
    const cached = this.preparedTileCache.get(tileKey);
    if (cached && cached.styleKey === styleKey) return cached;
    const prepared = this.buildTileData(tile, tileLayer);
    if (prepared) this.preparedTileCache.set(tileKey, prepared);
    return prepared;
  }

  /** Assemble one tile's binary instance attributes from its surfel columns. */
  private buildTileData(tile: Tile, tileLayer: TileLayer): PreparedSplatTile | null {
    const binary = tileLayer.features;
    const count = binary.featureCount;
    if (count === 0) return null;

    const t0 = performance.now();
    const num = binary.numericProps;

    const [qxN, qyN, qzN, qwN] = this.props.quaternionColumns ?? ['qx', 'qy', 'qz', 'qw'];
    const [smajN, sminN] = this.props.scaleColumns ?? ['s_major', 's_minor'];
    const qx = num[qxN];
    const qy = num[qyN];
    const qz = num[qzN];
    const qw = num[qwN];
    const smaj = num[smajN];
    const smin = num[sminN];

    // Surfel orientation + extent are mandatory — without them there is no
    // oriented disk to draw. Skip the tile (and warn once) rather than render a
    // misleading axis-aligned blob.
    if (!qx || !qy || !qz || !qw || !smaj || !smin) {
      warnOnce(
        'SplatLayer:missingSurfelColumns',
        `[SplatLayer] tile is missing surfel orientation/scale columns ` +
          `(${qxN},${qyN},${qzN},${qwN},${smajN},${sminN}); the cloud was not ` +
          `built with \`waymo_extract.py --surfel\`. Nothing rendered for this tile.`,
      );
      return null;
    }

    // Centre positions: [lng, lat, z·elevationScale]. Geometry is 2D; z rides a
    // numeric column. One Float64Array (only allocation in the prepare step).
    const srcDims = binary.positionDimensions ?? 2;
    const src = binary.positions;
    const elevProp = typeof this.props.elevationProperty === 'string' ? this.props.elevationProperty : '';
    const elev = elevProp ? num[elevProp] : undefined;
    const elevScale = this.props.elevationScale ?? 1;
    const positions = new Float64Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = src[i * srcDims];
      positions[i * 3 + 1] = src[i * srcDims + 1];
      positions[i * 3 + 2] = elev ? elev[i] * elevScale : srcDims > 2 ? src[i * srcDims + 2] : 0;
    }

    // Quaternion (size 4) + scale (size 2): interleave into packed Float32Arrays.
    const quats = new Float32Array(count * 4);
    const scales = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      quats[i * 4] = qx[i];
      quats[i * 4 + 1] = qy[i];
      quats[i * 4 + 2] = qz[i];
      quats[i * 4 + 3] = qw[i];
      scales[i * 2] = smaj[i];
      scales[i * 2 + 1] = smin[i];
    }

    // Color RGBA: camera RGB columns (0–255) × baked confidence into alpha.
    const rgbCols = this.props.rgbColumns;
    const rArr = rgbCols ? num[rgbCols[0]] : undefined;
    const gArr = rgbCols ? num[rgbCols[1]] : undefined;
    const bArr = rgbCols ? num[rgbCols[2]] : undefined;
    const opName = typeof this.props.opacityColumn === 'string' ? this.props.opacityColumn : '';
    const opArr = opName ? num[opName] : undefined;
    const fb = (this.props.fallbackColor ?? DEFAULT_FALLBACK_COLOR) as Color;
    const colors = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      if (rArr && gArr && bArr) {
        colors[o] = rArr[i];
        colors[o + 1] = gArr[i];
        colors[o + 2] = bArr[i];
      } else {
        colors[o] = fb[0];
        colors[o + 1] = fb[1];
        colors[o + 2] = fb[2];
      }
      // Baked confidence → alpha (0–255). Absent ⇒ opaque (the layer `opacity`
      // and the temporal Gaussian still modulate it in the shader).
      const conf = opArr ? Math.max(0, Math.min(1, opArr[i])) : 1;
      colors[o + 3] = Math.round(conf * 255);
    }

    const attributes: PreparedSplatTile['data']['attributes'] = {
      instancePositions: { value: positions, size: 3 },
      instanceQuaternions: { value: quats, size: 4 },
      instanceScales: { value: scales, size: 2 },
      instanceColors: { value: colors, size: 4, normalized: true },
      // Zero-copy: the tile's own start times (relative to binary.timeOffset)
      // ride straight to the GPU as the temporal-Gaussian centres μ_t.
      instanceStartTimes: { value: binary.startTimes, size: 1 },
    };

    const prepared: PreparedSplatTile = {
      tileKey: makeTileKey(tile, tileLayer),
      styleKey: this.computeStyleKey(),
      data: { length: count, attributes },
      timeOffset: binary.timeOffset,
      tile,
      layerName: tileLayer.name,
    };
    emit('tilePrepare', {
      layer: 'SplatLayer',
      tileKey: prepared.tileKey,
      cached: false,
      features: count,
      ms: performance.now() - t0,
    });
    return prepared;
  }

  private buildSublayer(prepared: PreparedSplatTile): SplatPrimitiveLayer {
    const extensions = this.composeExtensions([]);
    const props = this.composeSubLayerProps('splats', prepared.tileKey, {
      data: prepared.data as any,
      // Identity comparator: pairs with the prepared-tile cache's stable refs so
      // deck.gl skips the GPU re-upload on unchanged tiles.
      dataComparator: (a: any, b: any) => a === b,
      extensions,

      // Time wiring: shared getTime + this tile's offset (matches how the
      // attribute start times were relativised).
      getTime: this.boundGetTime,
      timeOffset: prepared.timeOffset,
      temporalSigma: this.props.temporalSigma,

      // Splat shaping.
      sizeScale: this.props.sizeScale,
      falloff: this.props.gaussianFalloff,
      alphaCutoff: this.props.alphaCutoff,

      // Picking: the base getPickingInfo decodes from these on a hit.
      tile: prepared.tile,
      sttFeatures: tileLayerFeatures(prepared),
    });
    const SubLayerClass = this.getSubLayerClass('splats', SplatPrimitiveLayer);
    return new SubLayerClass(props as any);
  }
}

/** Re-resolve the (tile, layer) BinaryFeatures for picking enrichment. */
function tileLayerFeatures(prepared: PreparedSplatTile) {
  const tl = prepared.tile.layers.find((l) => l.name === prepared.layerName);
  return tl?.features;
}

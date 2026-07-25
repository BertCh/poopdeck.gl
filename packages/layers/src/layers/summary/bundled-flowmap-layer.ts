// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * BundledFlowmapLayer — {@link FlowmapLayer} with **GPU kernel-density edge
 * bundling** (KDEEB). Instead of one straight tapered arrow per OD pair,
 * geometrically-close flows are bundled into smooth rivers by {@link EdgeBundler}
 * (density splat → gradient advect → resample → Laplacian smooth, all on the GPU
 * in the cosmos.gl ping-pong-texture style), then rendered fully on-GPU by
 * {@link BundledFlowLinesLayer}.
 *
 * GLOBAL bundling: the corridors from ALL currently-visible tiles are merged and
 * bundled in ONE {@link EdgeBundler}, not per-tile. Per-tile bundling would seam
 * at tile boundaries (each tile relaxes independently); bundling the union keeps
 * the rivers continuous the way flowmap.gl (which doesn't tile) does. The bundle
 * is rebuilt only when the visible tile SET changes (pan / zoom) — it's stable
 * during playback, where the flowmap's tiles span the whole time range and never
 * re-fetch. (For this to be correct the OD tiles must be built with `--no-clip`
 * so each corridor keeps its true station endpoints instead of being cut at tile
 * edges.)
 *
 * The bundle is a stable spatial skeleton (computed from the fixed edge set, not
 * the playhead, so the rivers don't writhe as you scrub). Only each ribbon's
 * WIDTH animates — sampled on the GPU from a merged `vertexValueMatrix` texture
 * at the live playhead, so the edges need zero per-frame CPU work. The node
 * circles keep {@link FlowmapLayer}'s cheap CPU aggregation.
 *
 * When the device can't additively blend into a float texture, or the merged
 * edge count exceeds `maxBundledEdges`, it falls back to {@link FlowmapLayer}'s
 * straight arrows (per tile). Picking is disabled on the merged bundle (a river
 * is many corridors); the node overlay carries the dataset's hover affordance.
 *
 * Sublayer short ids for `_subLayerProps`: **`flows`** and **`nodes`**.
 */

import { ScatterplotLayer } from '@deck.gl/layers';
import type { Color, DefaultProps, Layer } from '@deck.gl/core';
import {
  SpatioTemporalLayer,
  SpatioTemporalLayerProps,
} from '../spatiotemporal-layer.js';
import { FlowLinesLayer } from '../internal/flow-lines-layer.js';
import { BundledFlowLinesLayer } from '../internal/bundled-flow-lines-layer.js';
import {
  EdgeBundler,
  StaticBundle,
  isBundlingSupported,
  isStaticBundleSupported,
  subdivide,
} from '../../lib/edge-bundler.js';
import type { Vec2 } from '../../lib/edge-bundler.js';
import { deriveSourceTargetPositions } from '../../lib/od-positions.js';
import { bucketBlendAt, blendMatrixRow } from '../../lib/vertex-value-blend.js';
import { resolveAccessorAlias } from '../../lib/accessor-alias.js';
import { emit } from '../../lib/telemetry.js';
import { warnOnce } from '../../lib/log.js';
import type {
  Tile,
  STTTileLayer as TileLayer,
  BinaryFeatures,
} from '@poopdeck.gl/core';
import type { Texture } from '@luma.gl/core';
import type { _FlowmapLayerProps } from './flowmap-layer.js';

/** Props added by {@link BundledFlowmapLayer} (own KDEEB bundling props only). */
export interface _BundledFlowmapLayerProps {
  /** Control points per edge (P). Higher = smoother rivers, more GPU work. @default 48 */
  subdivisionPoints?: number;
  /**
   * Initial kernel bandwidth as a fraction of the visible extent — the headline
   * knob: larger bundles flows together more aggressively. @default 0.05
   */
  kernelRadius?: number;
  /** Number of KDEEB density-advection iterations (more = tighter). @default 15 */
  bundlingIterations?: number;
  /** Per-iteration Laplacian smoothing strength in `[0,1]`. @default 0.5 */
  smoothingStrength?: number;
  /**
   * Above this many merged edges, skip bundling and render straight arrows
   * (keeps the per-frame density splat bounded). @default 4000
   */
  maxBundledEdges?: number;
  /**
   * The tiles already carry **baked** bundled geometry (multi-vertex rivers
   * produced at build time by `stt-generate bixi --bake-bundling`). Skip the live
   * GPU KDEEB entirely: upload the baked control points once ({@link StaticBundle})
   * and render them. Cheaper, deterministic, stable under pan/zoom, and works on
   * devices without `EXT_float_blend`; `kernelRadius`/`bundlingIterations`/
   * `smoothingStrength`/`maxBundledEdges` are ignored. @default false
   */
  preBundled?: boolean;
}

/** Complete props accepted by {@link BundledFlowmapLayer}. */
export type BundledFlowmapLayerProps = _BundledFlowmapLayerProps &
  _FlowmapLayerProps &
  SpatioTemporalLayerProps;

const DEFAULT_SOURCE_COLOR: Color = [56, 196, 232, 235];
const DEFAULT_TARGET_COLOR: Color = [255, 142, 64, 245];
const DEFAULT_NODE_COLOR: Color = [232, 238, 255, 170];
const DEFAULT_NODE_LINE_COLOR: Color = [255, 255, 255, 220];

/** Cross-fade granularity (fractions of a bucket) for the CPU node path. */
const STEP = 0.1;

function makeTileKey(tile: Tile, layer: TileLayer): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}:${layer.name}`;
}

/** Geometry cached once per tile. */
interface TileGeom {
  tileKey: string;
  source: Float64Array;
  target: Float64Array;
  dims: number;
  srcVertexIndex: Uint32Array;
  binary: BinaryFeatures;
  tile: Tile;
}

/** The single global bundle for the current visible tile set. */
interface GlobalBundle {
  status: 'bundling' | 'ready' | 'fallback';
  bundler?: EdgeBundler | StaticBundle;
  matrixTexture?: Texture;
  /** length `E*(P-1)` driving attributes for BundledFlowLinesLayer. */
  edgeIndexArr?: Float32Array;
  segIndexArr?: Float32Array;
  segments: number;
  numBuckets: number;
  bucket0Abs: number;
  bucketWidth: number;
  edgeCount: number;
}

interface FlowNode {
  position: number[];
  radius: number;
}

/**
 * GPU-edge-bundled animated OD flowmap on the {@link SpatioTemporalLayer} chassis.
 */
export class BundledFlowmapLayer<
  ExtraPropsT extends {} = {},
> extends SpatioTemporalLayer<
  ExtraPropsT &
    Required<_BundledFlowmapLayerProps> &
    Required<_FlowmapLayerProps>
> {
  static layerName = 'BundledFlowmapLayer';

  static defaultProps: DefaultProps<BundledFlowmapLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    // Flowmap props (mirror FlowmapLayer so it's a drop-in superset).
    widthScale: { type: 'number', value: 1.1, min: 0 },
    widthMinPixels: { type: 'number', value: 1, min: 0 },
    widthMaxPixels: { type: 'number', value: 12, min: 0 },
    gap: { type: 'number', value: 0.5, min: 0 },
    nodeRadiusScale: { type: 'number', value: 1.3, min: 0 },
    nodeRadiusUnits: 'pixels',
    nodeRadiusMinPixels: { type: 'number', value: 1.5, min: 0 },
    nodeRadiusMaxPixels: { type: 'number', value: 28, min: 0 },
    minFlow: { type: 'number', value: 0.25, min: 0 },
    sourceColor: { type: 'object', value: DEFAULT_SOURCE_COLOR, compare: true },
    targetColor: { type: 'object', value: DEFAULT_TARGET_COLOR, compare: true },
    nodeColor: { type: 'object', value: DEFAULT_NODE_COLOR, compare: true },
    nodeLineColor: {
      type: 'object',
      value: DEFAULT_NODE_LINE_COLOR,
      compare: true,
    },
    getSourceColor: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    getTargetColor: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    // KDEEB bundling props.
    subdivisionPoints: { type: 'number', value: 48, min: 3 },
    kernelRadius: { type: 'number', value: 0.05, min: 0.005, max: 0.5 },
    bundlingIterations: { type: 'number', value: 15, min: 1 },
    smoothingStrength: { type: 'number', value: 0.5, min: 0, max: 1 },
    maxBundledEdges: { type: 'number', value: 4000, min: 1 },
    preBundled: false,
  };

  private geomCache = new Map<string, TileGeom>();
  /** The single bundle for the current visible set, and the signature it's for. */
  private bundle: GlobalBundle | null = null;
  private bundleSig = '';
  /** Cached bundled sublayer + the propsKey it was built for. */
  private bundledLayer: Layer | null = null;
  private bundledLayerKey = '';
  /** Per-tile straight-arrow sublayers, used only on the fallback path. */
  private fallbackCache = new Map<string, { layer: Layer; key: string }>();
  private lastTilesRef: Tile[] | null = null;
  private lastPropsKey = '';
  private _bundleRafId: number | null = null;

  // Global bucket axis (drives the node STEP gate + the merged matrix texture).
  private _bucket0Abs = 0;
  private _bucketWidth = 0;
  private _numBuckets = 0;
  private _lastStep = -1;

  finalizeState(context: any): void {
    super.finalizeState(context);
    if (this._bundleRafId !== null) {
      if (typeof cancelAnimationFrame === 'function')
        cancelAnimationFrame(this._bundleRafId);
      else
        clearTimeout(
          this._bundleRafId as unknown as ReturnType<typeof setTimeout>,
        );
      this._bundleRafId = null;
    }
    this.disposeBundle();
    this.geomCache.clear();
    this.fallbackCache.clear();
  }

  private disposeBundle(): void {
    this.bundle?.bundler?.destroy();
    this.bundle?.matrixTexture?.destroy();
    this.bundle = null;
    this.bundledLayer = null;
  }

  /** Continuous bucket position in `[0, nb-1]` for an absolute time. */
  private posFromBinary(binary: BinaryFeatures, time: number): number | null {
    const nb = binary.vertexValueBuckets ?? 0;
    if (nb <= 0 || !binary.startTimes || binary.startTimes.length === 0)
      return null;
    const rel0 = binary.startTimes[0];
    const span = binary.endTimes[0] - rel0;
    if (span <= 0) return null;
    const width = span / nb;
    let pos = (time - binary.timeOffset - rel0) / width;
    if (pos < 0) pos = 0;
    const max = nb - 1;
    if (pos > max) pos = max;
    return pos;
  }

  private noteAxis(binary: BinaryFeatures): void {
    if (this._numBuckets > 0) return;
    const nb = binary.vertexValueBuckets ?? 0;
    if (nb <= 0 || !binary.startTimes || binary.startTimes.length === 0) return;
    const rel0 = binary.startTimes[0];
    const span = binary.endTimes[0] - rel0;
    if (span <= 0) return;
    this._numBuckets = nb;
    this._bucketWidth = span / nb;
    this._bucket0Abs = binary.timeOffset + rel0;
  }

  private geomFor(tile: Tile, tileLayer: TileLayer): TileGeom | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0 || !binary.startIndices) return null;
    const tileKey = makeTileKey(tile, tileLayer);
    const cached = this.geomCache.get(tileKey);
    if (cached) return cached;

    const { source, target, dims } = deriveSourceTargetPositions(binary);
    const srcVertexIndex = new Uint32Array(binary.featureCount);
    for (let i = 0; i < binary.featureCount; i++)
      srcVertexIndex[i] = binary.startIndices[i];

    const geom: TileGeom = {
      tileKey,
      source,
      target,
      dims,
      srcVertexIndex,
      binary,
      tile,
    };
    this.geomCache.set(tileKey, geom);
    return geom;
  }

  /**
   * Resample every feature's FULL polyline to `P` control points (edge-major
   * then point-major). A 2-vertex OD pair stays straight; an N-vertex routed
   * trip / trajectory keeps its shape.
   */
  private controlPointsFor(
    geom: TileGeom,
    P: number,
    out: Float64Array,
    edgeOffset: number,
  ): void {
    const binary = geom.binary;
    const dims = geom.dims;
    const positions = binary.positions;
    const startIndices = binary.startIndices!;
    const E = binary.featureCount;
    for (let e = 0; e < E; e++) {
      const v0 = startIndices[e];
      const v1 = startIndices[e + 1];
      const pts: Vec2[] = [];
      for (let v = v0; v < v1; v++)
        pts.push([positions[v * dims], positions[v * dims + 1]]);
      const resampled =
        pts.length >= 2
          ? subdivide(pts, P)
          : Array.from(
              { length: P },
              () => [pts[0]?.[0] ?? 0, pts[0]?.[1] ?? 0] as Vec2,
            );
      for (let i = 0; i < P; i++) {
        const o = ((edgeOffset + e) * P + i) * dims;
        out[o] = resampled[i][0];
        out[o + 1] = resampled[i][1];
      }
    }
  }

  /** Signature of the live tile set + bundle params — the bundle is rebuilt when it changes. */
  private bundleSignature(tiles: Tile[]): string {
    const keys: string[] = [];
    for (const tile of tiles)
      for (const tl of tile.layers) keys.push(makeTileKey(tile, tl));
    keys.sort();
    const params = [
      this.props.subdivisionPoints,
      this.props.kernelRadius,
      this.props.bundlingIterations,
      this.props.smoothingStrength,
      this.props.maxBundledEdges,
      this.props.preBundled ? 'baked' : 'live',
    ].join(',');
    return `${keys.join('|')}#${params}`;
  }

  /**
   * Build ONE bundle for the union of all visible corridors. Falls back when the
   * device can't blend floats or the merged edge count exceeds maxBundledEdges.
   */
  private rebuildBundle(geoms: TileGeom[], sig: string): void {
    this.disposeBundle();

    const device = this.context.device;
    const nb = this._numBuckets;
    let E = 0;
    for (const g of geoms) E += g.binary.featureCount;

    const base: GlobalBundle = {
      status: 'fallback',
      segments: 1,
      numBuckets: Math.max(1, nb),
      bucket0Abs: this._bucket0Abs,
      bucketWidth: this._bucketWidth || 1,
      edgeCount: E,
    };

    const preBundled = this.props.preBundled;
    // Baked geometry only needs to SAMPLE a float texture (no density splat), so
    // it gates on the laxer capability and lights up on devices the live bundler
    // can't (the EXT_float_blend caveat).
    const supported = preBundled
      ? isStaticBundleSupported(device)
      : isBundlingSupported(device);
    if (!device || !supported || nb <= 0 || E < 2) {
      this.bundle = base;
      this.bundleSig = sig;
      return;
    }
    // maxBundledEdges bounds the per-frame density splat; a baked bundle has no
    // per-frame cost, so the cap doesn't apply to it.
    if (!preBundled && E > this.props.maxBundledEdges) {
      warnOnce(
        'BundledFlowmapLayer:edgeCap',
        `[BundledFlowmapLayer] ${E} visible edges > maxBundledEdges ` +
          `(${this.props.maxBundledEdges}); rendering straight arrows. ` +
          'Raise maxBundledEdges to bundle denser views.',
      );
      this.bundle = base;
      this.bundleSig = sig;
      return;
    }

    const P = Math.max(3, Math.floor(this.props.subdivisionPoints));
    const segments = P - 1;
    const dims = geoms[0].dims;

    // Merge control points + per-edge flow matrix + mean latitude across tiles.
    const controlPoints = new Float64Array(E * P * dims);
    const matrixData = new Float32Array(E * nb);
    let eOff = 0;
    let latSum = 0;
    for (const g of geoms) {
      this.controlPointsFor(g, P, controlPoints, eOff);
      const Eg = g.binary.featureCount;
      const gnb = g.binary.vertexValueBuckets ?? 0;
      const m = g.binary.vertexValueMatrix;
      for (let i = 0; i < Eg; i++) {
        if (m && gnb > 0) {
          const srcBase = g.srcVertexIndex[i] * gnb;
          const dstBase = (eOff + i) * nb;
          for (let b = 0; b < nb; b++)
            matrixData[dstBase + b] = b < gnb ? m[srcBase + b] : 0;
        }
        latSum += g.source[i * dims + 1] + g.target[i * dims + 1];
      }
      eOff += Eg;
    }
    const meanLat = latSum / (2 * E);
    const cosLat0 = Math.max(0.1, Math.cos((meanLat * Math.PI) / 180));

    const matrixTexture = device.createTexture({
      width: nb,
      height: E,
      format: 'r32float',
      sampler: {
        minFilter: 'nearest',
        magFilter: 'nearest',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      },
    });
    matrixTexture.copyImageData({ data: matrixData });

    const count = E * segments;
    const edgeIndexArr = new Float32Array(count);
    const segIndexArr = new Float32Array(count);
    for (let e = 0; e < E; e++) {
      for (let s = 0; s < segments; s++) {
        const k = e * segments + s;
        edgeIndexArr[k] = e;
        segIndexArr[k] = s;
      }
    }

    // Baked: upload the build-time control points once and render them as-is.
    // Live: construct the GPU bundler and relax it one iteration per frame.
    const bundler = preBundled
      ? new StaticBundle({
          device,
          controlPoints,
          edgeCount: E,
          pointCount: P,
          dims,
          cosLat0,
        })
      : new EdgeBundler({
          device,
          controlPoints,
          edgeCount: E,
          pointCount: P,
          dims,
          cosLat0,
          iterations: this.props.bundlingIterations,
          kernelRadiusFraction: this.props.kernelRadius,
          smoothingStrength: this.props.smoothingStrength,
        });

    this.bundle = {
      status: preBundled ? 'ready' : 'bundling',
      bundler,
      matrixTexture,
      edgeIndexArr,
      segIndexArr,
      segments,
      numBuckets: nb,
      bucket0Abs: this._bucket0Abs,
      bucketWidth: this._bucketWidth || 1,
      edgeCount: E,
    };
    this.bundleSig = sig;
    // A baked bundle is already final; only the live path needs relaxation frames.
    if (!preBundled) this.scheduleBundleStep();
  }

  /** Amortize relaxation: one KDEEB iteration per frame until the bundle converges. */
  private scheduleBundleStep(): void {
    if (this._bundleRafId !== null) return;
    const schedule =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb: () => void) => setTimeout(cb, 16) as unknown as number;
    this._bundleRafId = schedule(() => {
      this._bundleRafId = null;
      const b = this.bundle;
      if (!b || b.status !== 'bundling' || !(b.bundler instanceof EdgeBundler))
        return;
      b.bundler.stepCycle();
      if (b.bundler.isDone()) b.status = 'ready';
      this.setNeedsRedraw();
      if (b.status === 'bundling') this.scheduleBundleStep();
    }) as unknown as number;
  }

  /** CPU per-edge widths for the current bucket (nodes + straight-arrow fallback). */
  private widthsFor(
    geom: TileGeom,
    stepped: number,
    nodeFlow: Map<string, { position: number[]; flow: number }>,
  ): Float32Array {
    const binary = geom.binary;
    const nb = binary.vertexValueBuckets ?? 0;
    const matrix = binary.vertexValueMatrix;
    const n = binary.featureCount;
    const widths = new Float32Array(n);
    if (nb <= 0 || !matrix) return widths;

    const blend = bucketBlendAt(stepped, nb);
    const widthScale = this.props.widthScale;
    const minFlow = this.props.minFlow;
    const dims = geom.dims;

    for (let i = 0; i < n; i++) {
      const flow = blendMatrixRow(matrix, geom.srcVertexIndex[i] * nb, blend);
      if (flow <= minFlow) {
        widths[i] = 0;
        continue;
      }
      widths[i] = widthScale * Math.sqrt(flow);
      addNode(nodeFlow, geom.source, i * dims, dims, flow);
      addNode(nodeFlow, geom.target, i * dims, dims, flow);
    }
    return widths;
  }

  /**
   * Accessor-alias resolution (audit B1) — mirrors {@link FlowmapLayer}: the
   * upstream-named alias wins when set; a function-valued alias warns once and
   * falls back to the legacy prop. Constant colors only.
   */
  private sourceColorValue(): Color {
    const resolved = resolveAccessorAlias(
      'BundledFlowmapLayer',
      'getSourceColor',
      this.props.getSourceColor,
      this.props.sourceColor,
    );
    return (Array.isArray(resolved) ? resolved : DEFAULT_SOURCE_COLOR) as Color;
  }

  private targetColorValue(): Color {
    const resolved = resolveAccessorAlias(
      'BundledFlowmapLayer',
      'getTargetColor',
      this.props.getTargetColor,
      this.props.targetColor,
    );
    return (Array.isArray(resolved) ? resolved : DEFAULT_TARGET_COLOR) as Color;
  }

  private computePropsKey(): string {
    return [
      this.props.widthMinPixels,
      this.props.widthMaxPixels,
      this.props.widthScale,
      this.props.minFlow,
      this.props.gap,
      this.sourceColorValue().join(','),
      this.targetColorValue().join(','),
      this.props.opacity,
      this.props.visible,
    ].join('|');
  }

  renderLayers(): Layer[] {
    const t0 = performance.now();
    const { tiles } = this.state as { tiles?: Tile[] };
    if (!tiles || tiles.length === 0) {
      this.lastTilesRef = null;
      return [];
    }

    // Prune the geom + fallback caches when the live tile set changes.
    if (this.lastTilesRef !== tiles) {
      const live = new Set<string>();
      for (const tile of tiles) {
        for (const tl of tile.layers) live.add(makeTileKey(tile, tl));
      }
      for (const key of this.geomCache.keys())
        if (!live.has(key)) this.geomCache.delete(key);
      for (const key of this.fallbackCache.keys())
        if (!live.has(key)) this.fallbackCache.delete(key);
      this.lastTilesRef = tiles;
    }

    const propsKey = this.computePropsKey();
    if (propsKey !== this.lastPropsKey) {
      this.lastPropsKey = propsKey;
      this.bundledLayer = null;
      this.fallbackCache.clear();
    }

    const time = this.getCurrentTime();
    let stepKey = 0;
    const nodeFlow = new Map<string, { position: number[]; flow: number }>();

    // Pass 1: per-tile CPU width decode → node aggregation (+ fallback widths).
    const prepared: { geom: TileGeom; widths: Float32Array }[] = [];
    for (const tile of tiles) {
      for (const tileLayer of tile.layers) {
        const geom = this.geomFor(tile, tileLayer);
        if (!geom) continue;
        this.noteAxis(geom.binary);
        const pos = this.posFromBinary(geom.binary, time) ?? 0;
        const stepped = Math.round(pos / STEP) * STEP;
        stepKey = Math.round(pos / STEP);
        prepared.push({
          geom,
          widths: this.widthsFor(geom, stepped, nodeFlow),
        });
      }
    }

    const nodeRadius = this.nodeRadiiFor(nodeFlow);

    // (Re)build the single global bundle when the visible set / params change.
    const sig = this.bundleSignature(tiles);
    if (sig !== this.bundleSig) {
      this.rebuildBundle(
        prepared.map((p) => p.geom),
        sig,
      );
    }

    // Pass 2: one bundled ribbon layer for the union, or per-tile straight arrows.
    const sublayers: Layer[] = [];
    if (this.bundle && this.bundle.status !== 'fallback') {
      const bundled = this.buildBundledSublayer(propsKey);
      if (bundled) sublayers.push(bundled);
    } else {
      for (const { geom, widths } of prepared) {
        sublayers.push(
          this.buildFallbackSublayer(
            geom,
            widths,
            nodeRadius,
            stepKey,
            propsKey,
          ),
        );
      }
    }

    const nodeLayer = this.buildNodeSublayer(nodeFlow, stepKey, propsKey);
    if (nodeLayer) sublayers.push(nodeLayer);

    emit('renderLayers', {
      layer: 'BundledFlowmapLayer',
      tiles: tiles.length,
      sublayers: sublayers.length,
      edges: this.bundle?.edgeCount ?? 0,
      nodes: nodeFlow.size,
      ms: performance.now() - t0,
    });
    return sublayers;
  }

  private buildBundledSublayer(propsKey: string): Layer | null {
    const b = this.bundle;
    if (!b || !b.bundler || !b.matrixTexture || !b.edgeIndexArr) return null;
    if (this.bundledLayer && this.bundledLayerKey === propsKey)
      return this.bundledLayer;

    const data = {
      length: b.edgeIndexArr.length,
      attributes: {
        getEdgeIndex: { value: b.edgeIndexArr, size: 1 },
        getSegmentIndex: { value: b.segIndexArr!, size: 1 },
      },
    };
    const props = this.composeSubLayerProps('flows', 'bundle', {
      data,
      dataComparator: (a: any, c: any) => a === c,
      bundler: b.bundler,
      matrixTexture: b.matrixTexture,
      segments: b.segments,
      numBuckets: b.numBuckets,
      bucket0Abs: b.bucket0Abs,
      bucketWidth: b.bucketWidth,
      getCurrentTime: () => this.getCurrentTime(),
      sourceColor: this.sourceColorValue(),
      targetColor: this.targetColorValue(),
      widthScale: this.props.widthScale,
      minFlow: this.props.minFlow,
      widthMinPixels: this.props.widthMinPixels,
      widthMaxPixels: this.props.widthMaxPixels,
      gap: this.props.gap,
      extensions: this.composeExtensions([]),
      // A merged river is many corridors — per-feature picking isn't meaningful;
      // the node overlay carries hover instead.
      pickable: false,
    });
    const SubLayerClass = this.getSubLayerClass('flows', BundledFlowLinesLayer);
    const layer = new SubLayerClass(props as any);
    this.bundledLayer = layer;
    this.bundledLayerKey = propsKey;
    return layer;
  }

  private buildFallbackSublayer(
    geom: TileGeom,
    widths: Float32Array,
    nodeRadius: Map<string, number>,
    stepKey: number,
    propsKey: string,
  ): Layer {
    const cacheKey = geom.tileKey;
    const key = `${propsKey}|${stepKey}`;
    const cached = this.fallbackCache.get(cacheKey);
    if (cached && cached.key === key) return cached.layer;

    const dims = geom.dims;
    const offsets = new Float32Array(geom.binary.featureCount * 2);
    for (let i = 0; i < geom.binary.featureCount; i++) {
      const b = i * dims;
      offsets[i * 2] =
        nodeRadius.get(nodeKey(geom.source[b], geom.source[b + 1])) ?? 0;
      offsets[i * 2 + 1] =
        nodeRadius.get(nodeKey(geom.target[b], geom.target[b + 1])) ?? 0;
    }
    const data = {
      length: geom.binary.featureCount,
      attributes: {
        getSourcePosition: { value: geom.source, size: dims },
        getTargetPosition: { value: geom.target, size: dims },
        getWidth: { value: widths, size: 1 },
        getEndpointOffsets: { value: offsets, size: 2 },
      },
    };
    const props = this.composeSubLayerProps('flows', geom.tileKey, {
      data,
      dataComparator: (a: any, c: any) => a === c,
      positionFormat: dims === 3 ? 'XYZ' : 'XY',
      sourceColor: this.sourceColorValue(),
      targetColor: this.targetColorValue(),
      gap: this.props.gap,
      widthMinPixels: this.props.widthMinPixels,
      widthMaxPixels: this.props.widthMaxPixels,
      extensions: this.composeExtensions([]),
      tile: geom.tile,
      sttFeatures: geom.binary,
    });
    const SubLayerClass = this.getSubLayerClass('flows', FlowLinesLayer);
    const layer = new SubLayerClass(props as any);
    this.fallbackCache.set(cacheKey, { layer, key });
    return layer;
  }

  private nodeRadiiFor(
    nodeFlow: Map<string, { position: number[]; flow: number }>,
  ): Map<string, number> {
    const scale = this.props.nodeRadiusScale;
    const rmin = this.props.nodeRadiusMinPixels;
    const rmax = this.props.nodeRadiusMaxPixels;
    const out = new Map<string, number>();
    for (const [key, entry] of nodeFlow) {
      out.set(
        key,
        Math.min(rmax, Math.max(rmin, scale * Math.sqrt(entry.flow))),
      );
    }
    return out;
  }

  private buildNodeSublayer(
    nodeFlow: Map<string, { position: number[]; flow: number }>,
    stepKey: number,
    propsKey: string,
  ): ScatterplotLayer | null {
    if (nodeFlow.size === 0) return null;
    const scale = this.props.nodeRadiusScale;
    const nodes: FlowNode[] = [];
    for (const { position, flow } of nodeFlow.values()) {
      nodes.push({ position, radius: scale * Math.sqrt(flow) });
    }
    const props = this.composeSubLayerProps('nodes', `${this.props.id}-nodes`, {
      data: nodes,
      positionFormat: 'XY',
      radiusUnits: this.props.nodeRadiusUnits,
      getPosition: (d: FlowNode) => d.position,
      getRadius: (d: FlowNode) => d.radius,
      radiusMinPixels: this.props.nodeRadiusMinPixels,
      radiusMaxPixels: this.props.nodeRadiusMaxPixels,
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: 1,
      getFillColor: (Array.isArray(this.props.nodeColor)
        ? this.props.nodeColor
        : DEFAULT_NODE_COLOR) as Color,
      getLineColor: (Array.isArray(this.props.nodeLineColor)
        ? this.props.nodeLineColor
        : DEFAULT_NODE_LINE_COLOR) as Color,
      updateTriggers: {
        getPosition: stepKey,
        getRadius: stepKey,
        getFillColor: propsKey,
      },
      pickable: false,
    });
    const SubLayerClass = this.getSubLayerClass('nodes', ScatterplotLayer);
    return new SubLayerClass(props as any);
  }

  protected _handleTimeUpdate(time: number): void {
    super._handleTimeUpdate(time);
    if (this._numBuckets <= 0 || this._bucketWidth <= 0) return;
    let pos = (time - this._bucket0Abs) / this._bucketWidth;
    if (pos < 0) pos = 0;
    const max = this._numBuckets - 1;
    if (pos > max) pos = max;
    const step = Math.round(pos / STEP);
    if (step !== this._lastStep) {
      this._lastStep = step;
      // Re-aggregate the CPU node circles for the new sub-step. Bundled edge
      // WIDTH animates on the GPU every frame via setNeedsRedraw (super call).
      this.setState({ flowStep: step });
    }
  }
}

/** Quantized node key (~1 m) so the same dock collapses across tiles. */
function nodeKey(lon: number, lat: number): string {
  return `${lon.toFixed(5)},${lat.toFixed(5)}`;
}

function addNode(
  nodeFlow: Map<string, { position: number[]; flow: number }>,
  coords: Float64Array,
  base: number,
  dims: number,
  flow: number,
): void {
  const lon = coords[base];
  const lat = coords[base + 1];
  const key = nodeKey(lon, lat);
  const existing = nodeFlow.get(key);
  if (existing) {
    existing.flow += flow;
  } else {
    const position = dims === 3 ? [lon, lat, coords[base + 2]] : [lon, lat];
    nodeFlow.set(key, { position, flow });
  }
}

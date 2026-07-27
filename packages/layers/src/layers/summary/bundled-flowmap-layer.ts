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
 * edges.) The FIRST bundle for a view is built inline; every later set change is
 * DEBOUNCED off the render path ({@link REBUILD_SETTLE_MS}) so a pan that
 * streams tiles one at a time doesn't restart the relaxation on each arrival —
 * the previous, converged bundle keeps drawing until the view settles.
 *
 * The bundle is a stable spatial skeleton (computed from the fixed edge set, not
 * the playhead, so the rivers don't writhe as you scrub). Only each ribbon's
 * WIDTH animates — sampled on the GPU from a merged `vertexValueMatrix` texture
 * at the live playhead, so the edges need zero per-frame CPU work. The node
 * circles keep {@link FlowmapLayer}'s cheap CPU aggregation.
 *
 * When the device can't additively blend into a float texture, or the merged
 * edge count exceeds `maxBundledEdges` or the device's `maxTextureDimension2D`,
 * it falls back to {@link FlowmapLayer}'s straight arrows (per tile) — never a
 * throw, because this all runs inside deck's synchronous render callback.
 * Picking is disabled on the merged bundle (a river is many corridors); the node
 * overlay carries the dataset's hover affordance.
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
  maxBundleEdges,
  resampleInto,
} from '../../lib/edge-bundler.js';
import { deriveSourceTargetPositions } from '../../lib/od-positions.js';
import { bucketBlendAt, blendMatrixRow } from '../../lib/vertex-value-blend.js';
import { resolveAccessorAlias } from '../../lib/accessor-alias.js';
import {
  inheritedPropsDigest,
  updateTriggersDigest,
} from '../../lib/style-digest.js';
import { emit } from '../../lib/telemetry.js';
import { warnOnce } from '../../lib/log.js';
import { tileLayerKey } from '@poopdeck.gl/core';
import type {
  Tile,
  STTTileLayer as TileLayer,
  BinaryFeatures,
} from '@poopdeck.gl/core';
import type { Texture } from '@luma.gl/core';
import {
  FLOW_COLUMN_CANDIDATES,
  applyNodeRadii,
  buildNodeTable,
  compactActiveNodes,
  nodeEndpointOffsets,
  resolveFlowColumn,
} from './flowmap-layer.js';
import type { NodeTable, _FlowmapLayerProps } from './flowmap-layer.js';

/** Props added by {@link BundledFlowmapLayer} (own KDEEB bundling props only). */
export interface _BundledFlowmapLayerProps {
  /** Control points per edge (P). Higher = smoother rivers, more GPU work. @default 48 */
  subdivisionPoints?: number;
  /**
   * Initial kernel bandwidth as a fraction of the visible extent — the headline
   * knob: larger bundles flows together more aggressively.
   *
   * COST MODEL: the density splat rasterizes `edges × subdivisionPoints`
   * additively-blended quads of side `2·kernelRadius`, so its fill is
   * **quadratic** in this value — doubling it QUADRUPLES the fragments per
   * iteration, and `maxBundledEdges` bounds only the instance count, never the
   * per-instance area. The bundler clamps it to an internal fill budget (and
   * warns once) rather than let a dense view stall the frame.
   * @default 0.05
   */
  kernelRadius?: number;
  /** Number of KDEEB density-advection iterations (more = tighter). @default 15 */
  bundlingIterations?: number;
  /** Per-iteration Laplacian smoothing strength in `[0,1]`. @default 0.5 */
  smoothingStrength?: number;
  /**
   * Above this many merged edges, skip bundling and render straight arrows
   * (keeps the per-frame density splat bounded). Independently of this prop the
   * merged edge count is ALSO clamped to the device's `maxTextureDimension2D`
   * (both bundle textures are `edgeCount` rows tall) — including on the
   * `preBundled` path, which has no splat cost but the same texture ceiling.
   * @default 4000
   */
  maxBundledEdges?: number;
  /**
   * The tiles already carry **baked** bundled geometry (multi-vertex rivers
   * produced at build time by `stt-generate bixi --bake-bundling`). Skip the live
   * GPU KDEEB entirely: upload the baked control points once ({@link StaticBundle})
   * and render them. Cheaper, deterministic, stable under pan/zoom, and works on
   * devices without `EXT_float_blend`; `kernelRadius`/`bundlingIterations`/
   * `smoothingStrength` are ignored — but `maxBundledEdges` and the device
   * texture limit still apply: a baked bundle has no per-frame splat cost, yet
   * exactly the same `pointCount × edgeCount` texture ceiling. @default false
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

/**
 * Quiet period (ms) the visible tile set must hold before an EXISTING bundle is
 * rebuilt. Rebuilding is a full re-derivation of the union (resample every
 * edge, re-upload two textures, restart the 15-iteration relaxation), and the
 * signature covers every live tile key — so without this, one tile arriving
 * mid-pan restarted the relaxation and the rivers never converged. During the
 * window the previous (coherent, converged) bundle keeps rendering; the newly
 * arrived corridors join it once the pan settles.
 */
const REBUILD_SETTLE_MS = 150;

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
  /** Sorted membership key of the live tile set (NOT array identity). */
  private tileSetKey = '';
  /** Station identity for {@link tileSetKey}; rebuilt only when the set changes. */
  private nodeTable: NodeTable | null = null;
  /** Debounced-rebuild bookkeeping — see {@link REBUILD_SETTLE_MS}. */
  private pendingSig = '';
  private _rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private _bundleEpoch = 0;

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
    if (this._rebuildTimer !== null) {
      clearTimeout(this._rebuildTimer);
      this._rebuildTimer = null;
    }
    this.disposeBundle();
    this.geomCache.clear();
    this.fallbackCache.clear();
    this.nodeTable = null;
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
    const tileKey = tileLayerKey(tile.id, tileLayer.name);
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
   *
   * Streams straight out of the tile's binary `positions` into `out` via
   * {@link resampleInto} — the boxed-tuple form allocated a `Vec2[]`, a `cum[]`
   * and `P` fresh tuples PER EDGE (~200k short-lived arrays for one E=4000,
   * P=48 rebuild), all inside the render callback.
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
      resampleInto(
        positions,
        dims,
        startIndices[e],
        startIndices[e + 1],
        P,
        out,
        (edgeOffset + e) * P,
      );
    }
  }

  /** Signature of the live tile set + bundle params — the bundle is rebuilt when it changes. */
  private bundleSignature(tiles: Tile[]): string {
    const keys: string[] = [];
    for (const tile of tiles)
      for (const tl of tile.layers) keys.push(tileLayerKey(tile.id, tl.name));
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
   * Build ONE bundle for the union of all visible corridors. Falls back — never
   * throws — when the device can't blend floats, when the merged edge count
   * exceeds `maxBundledEdges` or the device's texture ceiling, or when the GPU
   * refuses the allocation.
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

    const P = Math.max(3, Math.floor(this.props.subdivisionPoints));

    // Two independent ceilings, BOTH checked before anything is allocated (the
    // merged control-point buffer alone is E·P·dims f64 — ~23 MB at E=30k):
    //  • maxBundledEdges bounds the per-frame density splat. It does NOT apply
    //    to a baked bundle (no splat), which is why it is skipped there.
    //  • maxTextureDimension2D is a HARD device limit — both bundle textures
    //    are `edgeCount` rows tall — and applies to EVERY path, baked included.
    //    Exceeding it makes createTexture throw from inside renderLayers, which
    //    takes down the whole layer tree, so it can never be opt-out.
    const deviceCap = maxBundleEdges(device, P, nb);
    const propCap = preBundled ? Infinity : this.props.maxBundledEdges;
    const cap = Math.min(deviceCap, propCap);
    if (E > cap) {
      warnOnce(
        'BundledFlowmapLayer:edgeCap',
        `[BundledFlowmapLayer] ${E} visible edges > the ${cap}-edge bundling cap ` +
          `(maxBundledEdges ${preBundled ? 'n/a — baked' : this.props.maxBundledEdges}, ` +
          `device maxTextureDimension2D ${deviceCap || 'too small for these textures'}); ` +
          'rendering straight arrows. ' +
          (cap === deviceCap
            ? 'This is a hardware ceiling — reduce the visible edge count (zoom in, or ' +
              'build a coarser summary tier) rather than raising maxBundledEdges.'
            : 'Raise maxBundledEdges to bundle denser views.'),
      );
      this.bundle = base;
      this.bundleSig = sig;
      return;
    }

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

    // GPU allocation, FAIL-SOFT. The caps above are the intended guard, but
    // this runs inside deck's synchronous render callback: any driver-side
    // refusal (out of VRAM, an unreported limit, a context loss mid-frame) would
    // otherwise propagate out of renderLayers and blank the entire layer tree,
    // not just the rivers. Degrade to straight arrows instead.
    let matrixTexture: Texture | undefined;
    let bundler: EdgeBundler | StaticBundle | undefined;
    try {
      matrixTexture = device.createTexture({
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

      // Baked: upload the build-time control points once and render them as-is.
      // Live: construct the GPU bundler and relax it one iteration per frame.
      bundler = preBundled
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
    } catch (error) {
      warnOnce(
        'BundledFlowmapLayer:bundleAllocFailed',
        `[BundledFlowmapLayer] could not allocate the GPU bundle for ${E} edges × ` +
          `${P} points; rendering straight arrows. ${String(error)}`,
      );
      matrixTexture?.destroy();
      this.bundle = base;
      this.bundleSig = sig;
      return;
    }

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

  /**
   * (Re)build the global bundle once the visible tile set has been QUIET for
   * {@link REBUILD_SETTLE_MS}. See that constant for why this is debounced and
   * off the synchronous render path; the first bundle for a view is still built
   * inline so the opening frame has rivers.
   *
   * Only a change of SIGNATURE (re)arms the timer — a re-render at the same
   * pending signature must not postpone it, or a playhead tick every ~100 ms
   * would defer the rebuild forever.
   */
  private scheduleRebuild(sig: string): void {
    if (this.pendingSig === sig && this._rebuildTimer !== null) return;
    this.pendingSig = sig;
    if (this._rebuildTimer !== null) clearTimeout(this._rebuildTimer);
    this._rebuildTimer = setTimeout(() => {
      this._rebuildTimer = null;
      const tiles = (this.state as { tiles?: Tile[] }).tiles;
      if (!tiles || tiles.length === 0) return;
      const target = this.bundleSignature(tiles);
      if (target === this.bundleSig) return;
      const geoms: TileGeom[] = [];
      for (const tile of tiles) {
        for (const tl of tile.layers) {
          const geom = this.geomFor(tile, tl);
          if (geom) geoms.push(geom);
        }
      }
      this.rebuildBundle(geoms, target);
      // setState (not setNeedsRedraw) — renderLayers has to run again to hand
      // deck a sublayer bound to the NEW bundler + matrix texture.
      this.setState({ bundleEpoch: ++this._bundleEpoch });
    }, REBUILD_SETTLE_MS);
  }

  /**
   * CPU per-edge widths for the current bucket (node circles + the
   * straight-arrow fallback). Mirrors {@link FlowmapLayer.widthsFor}, including
   * the static `flowProperty` fallback for archives with no bucket matrix.
   */
  private widthsFor(
    geom: TileGeom,
    stepped: number,
    table: NodeTable,
  ): Float32Array {
    const binary = geom.binary;
    const nb = binary.vertexValueBuckets ?? 0;
    const matrix = binary.vertexValueMatrix;
    const n = binary.featureCount;
    const widths = new Float32Array(n);

    const staticFlow =
      nb > 0 && matrix
        ? null
        : resolveFlowColumn(binary, this.props.flowProperty);
    if (!matrix && !staticFlow) {
      warnOnce(
        'BundledFlowmapLayer:noFlowSource',
        '[BundledFlowmapLayer] tiles carry neither a per-bucket vertexValueMatrix nor a ' +
          `per-feature flow column (${FLOW_COLUMN_CANDIDATES.join('/')}); every corridor ` +
          'renders at width 0. Rebuild the archive with an OD value matrix, or point ' +
          '`flowProperty` at the magnitude column.',
      );
      return widths;
    }

    const blend = staticFlow ? null : bucketBlendAt(stepped, nb);
    const widthScale = this.props.widthScale;
    const minFlow = this.props.minFlow;
    const nodeIdx = table.endpoints.get(geom.tileKey);
    const flowAcc = table.flow;

    for (let i = 0; i < n; i++) {
      const flow = staticFlow
        ? staticFlow[i]
        : blendMatrixRow(matrix!, geom.srcVertexIndex[i] * nb, blend!);
      if (!(flow > minFlow)) {
        widths[i] = 0;
        continue;
      }
      widths[i] = widthScale * Math.sqrt(flow);
      if (nodeIdx) {
        flowAcc[nodeIdx[i * 2]] += flow;
        flowAcc[nodeIdx[i * 2 + 1]] += flow;
      }
    }
    return widths;
  }

  /** Memoized {@link buildNodeTable} for the current tile set. */
  private nodeTableFor(geoms: TileGeom[], setKey: string): NodeTable {
    const cached = this.nodeTable;
    if (cached && cached.setKey === setKey) return cached;
    const table = buildNodeTable(geoms, setKey);
    this.nodeTable = table;
    return table;
  }

  /**
   * Deck extensions cannot reach this family's shaders — both
   * {@link FlowLinesLayer} and {@link BundledFlowLinesLayer} are custom-`Model`
   * layers with no `DECKGL_FILTER_*` hooks, so deck merges the module and then
   * drops every injection, silently. Strip and warn once instead of forwarding
   * an inert list.
   */
  private flowExtensions(): unknown[] {
    const user = (this.props as { extensions?: unknown[] }).extensions;
    if (user && user.length > 0) {
      const names = user
        .map(
          (e) =>
            (e as { constructor?: { name?: string } })?.constructor?.name ??
            '?',
        )
        .join(', ');
      warnOnce(
        'BundledFlowmapLayer:extensions',
        `[BundledFlowmapLayer] ignoring extensions (${names}): the OD arrow/ribbon ` +
          'sublayers use custom shaders with no DECKGL_FILTER_* hooks, so extension ' +
          'injections never run.',
      );
    }
    return [];
  }

  /**
   * Accessor-alias resolution — mirrors {@link FlowmapLayer}: the
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

  /**
   * Everything baked into a cached sublayer at construction time — see
   * {@link FlowmapLayer}'s twin. `inheritedPropsDigest` covers every composite
   * prop `getSubLayerProps()` forwards (`pickable`, `autoHighlight`,
   * `coordinateSystem`, `modelMatrix`, `parameters`, `_subLayerProps`,
   * `extensions`, …); without it, toggling any of them on a paused, stable tile
   * set reuses the cached sublayers verbatim and the change never renders.
   */
  private computePropsKey(): string {
    return [
      this.props.widthMinPixels,
      this.props.widthMaxPixels,
      this.props.widthScale,
      this.props.minFlow,
      this.props.flowProperty ?? '',
      this.props.gap,
      this.props.nodeRadiusScale,
      this.props.nodeRadiusMinPixels,
      this.props.nodeRadiusMaxPixels,
      this.sourceColorValue().join(','),
      this.targetColorValue().join(','),
      inheritedPropsDigest(this.props),
      updateTriggersDigest(this.props.updateTriggers),
    ].join('|');
  }

  renderLayers(): Layer[] {
    const t0 = performance.now();
    const { tiles } = this.state as { tiles?: Tile[] };
    if (!tiles || tiles.length === 0) {
      this.lastTilesRef = null;
      return [];
    }

    // Prune the geom + fallback caches when the live tile set changes, and
    // re-derive the SORTED membership key (the `tiles` array is usually a fresh
    // reference, so identity alone can't tell "same tiles" from "set changed").
    if (this.lastTilesRef !== tiles) {
      const live = new Set<string>();
      for (const tile of tiles) {
        for (const tl of tile.layers) live.add(tileLayerKey(tile.id, tl.name));
      }
      for (const key of this.geomCache.keys())
        if (!live.has(key)) this.geomCache.delete(key);
      for (const key of this.fallbackCache.keys())
        if (!live.has(key)) this.fallbackCache.delete(key);
      this.tileSetKey = [...live].sort().join('|');
      this.lastTilesRef = tiles;
    }
    const setKey = this.tileSetKey;

    const propsKey = this.computePropsKey();
    if (propsKey !== this.lastPropsKey) {
      this.lastPropsKey = propsKey;
      this.bundledLayer = null;
      this.fallbackCache.clear();
    }

    const time = this.getCurrentTime();
    let stepKey = 0;

    // Pass 1: per-tile geometry + stepped bucket position.
    const prepared: { geom: TileGeom; stepped: number }[] = [];
    for (const tile of tiles) {
      for (const tileLayer of tile.layers) {
        const geom = this.geomFor(tile, tileLayer);
        if (!geom) continue;
        this.noteAxis(geom.binary);
        const pos = this.posFromBinary(geom.binary, time) ?? 0;
        prepared.push({ geom, stepped: Math.round(pos / STEP) * STEP });
        stepKey = Math.round(pos / STEP);
      }
    }

    // Pass 2: CPU width decode → node aggregation (+ fallback widths). Node
    // IDENTITY is interned once per tile SET; the per-sub-step pass is pure
    // index arithmetic.
    const table = this.nodeTableFor(
      prepared.map((p) => p.geom),
      setKey,
    );
    table.flow.fill(0);
    const withWidths = prepared.map(({ geom, stepped }) => ({
      geom,
      widths: this.widthsFor(geom, stepped, table),
    }));
    const activeNodes = applyNodeRadii(
      table,
      this.props.nodeRadiusScale,
      this.props.nodeRadiusMinPixels,
      this.props.nodeRadiusMaxPixels,
    );

    // (Re)build the single global bundle when the visible set / params change.
    // The FIRST bundle for a view is built inline so the opening frame has
    // rivers; after that a change only ARMS the debounce (see scheduleRebuild)
    // and the existing, converged bundle keeps rendering meanwhile. Playhead
    // ticks never reach here — `bundleSignature` deliberately excludes time.
    const sig = this.bundleSignature(tiles);
    if (sig !== this.bundleSig) {
      if (!this.bundle) {
        this.rebuildBundle(
          withWidths.map((p) => p.geom),
          sig,
        );
      } else {
        this.scheduleRebuild(sig);
      }
    }

    // Pass 3: one bundled ribbon layer for the union, or per-tile straight arrows.
    const sublayers: Layer[] = [];
    if (this.bundle && this.bundle.status !== 'fallback') {
      const bundled = this.buildBundledSublayer(propsKey);
      if (bundled) sublayers.push(bundled);
    } else {
      for (const { geom, widths } of withWidths) {
        sublayers.push(
          this.buildFallbackSublayer(
            geom,
            widths,
            table,
            stepKey,
            propsKey,
            setKey,
          ),
        );
      }
    }

    const nodeLayer = this.buildNodeSublayer(table, stepKey, propsKey);
    if (nodeLayer) sublayers.push(nodeLayer);

    emit('renderLayers', {
      layer: 'BundledFlowmapLayer',
      tiles: tiles.length,
      sublayers: sublayers.length,
      edges: this.bundle?.edgeCount ?? 0,
      nodes: activeNodes,
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
      extensions: this.flowExtensions(),
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

  /**
   * `setKey` is part of the cache key for the same reason as in
   * {@link FlowmapLayer}: the endpoint insets are node radii aggregated across
   * the WHOLE visible set, so a new tile feeding an existing hub invalidates
   * every arrow that touches it, not just the new tile's.
   */
  private buildFallbackSublayer(
    geom: TileGeom,
    widths: Float32Array,
    table: NodeTable,
    stepKey: number,
    propsKey: string,
    setKey: string,
  ): Layer {
    const cacheKey = geom.tileKey;
    const key = `${propsKey}|${stepKey}|${setKey}`;
    const cached = this.fallbackCache.get(cacheKey);
    if (cached && cached.key === key) return cached.layer;

    const dims = geom.dims;
    const offsets = nodeEndpointOffsets(table, geom);
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
      extensions: this.flowExtensions(),
      tile: geom.tile,
      sttFeatures: geom.binary,
    });
    const SubLayerClass = this.getSubLayerClass('flows', FlowLinesLayer);
    const layer = new SubLayerClass(props as any);
    this.fallbackCache.set(cacheKey, { layer, key });
    return layer;
  }

  /**
   * The single node-circle overlay, mirroring {@link FlowmapLayer}: the ACTIVE
   * nodes compacted into binary `getPosition`/`getRadius` attributes (this
   * rebuilds on every sub-step, so it must not allocate per node).
   */
  private buildNodeSublayer(
    table: NodeTable,
    stepKey: number,
    propsKey: string,
  ): ScatterplotLayer | null {
    const nodes = compactActiveNodes(table, this.props.nodeRadiusScale);
    if (!nodes) return null;
    const props = this.composeSubLayerProps('nodes', 'all', {
      data: nodes,
      radiusUnits: this.props.nodeRadiusUnits,
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

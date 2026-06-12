// @stt/deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/deck.gl contributors

/**
 * FlowmapLayer — flowmap.gl-style **animated origin→destination flowmap**.
 *
 * Renders one weighted arc per OD station-pair whose WIDTH tracks trip volume at
 * the playhead, plus node circles sized by each station's total incident flow.
 * As the time slider scrubs, corridors swell and recede with demand and the
 * node circles pulse — the classic flowmap-over-time look.
 *
 * It fuses two existing STT mechanisms (no new format work):
 *  • {@link AnimatedArcLayer}'s per-tile binary `ArcLayer` machinery —
 *    {@link deriveSourceTargetPositions} collapses each 2-vertex OD LineString to
 *    instanced source/target endpoints fed to a stock `ArcLayer`.
 *  • {@link FlowCorridorLayer}'s `vertexValueMatrix` decode — each feature carries
 *    a `[2 × numBuckets]` per-bucket count matrix; the active bucket (linearly
 *    blended across a sub-step) becomes the per-feature flow, mapped to arc width
 *    and summed at endpoints for node radius. Geometry stays resident; only the
 *    width buffer re-expands when the playhead crosses a sub-step (~5 Hz),
 *    quarantined behind a `setState({ flowStep })` gate in `_handleTimeUpdate`
 *    (mirroring FlowCorridorLayer / AnimatedHeatmapLayer).
 *
 * The data tile spans the WHOLE time range (every corridor's `[start, end]` is
 * the full span), so it loads once and never re-fetches. There is no time filter:
 * an arc with ~0 current flow gets width 0 (invisible), which IS the animation.
 *
 * Sublayer short ids for `_subLayerProps` overrides: **`arcs`** (per tile) and
 * **`nodes`** (single overlay).
 */

import { ArcLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { Color, DefaultProps, Layer } from '@deck.gl/core';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from '../spatiotemporal-layer';
import { deriveSourceTargetPositions } from '../../lib/od-positions';
import { emit } from '../../lib/telemetry';
import type { Tile, Layer as TileLayer, BinaryFeatures } from '@stt/core';

/** Props added by {@link FlowmapLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link FlowmapLayerProps}). */
export interface _FlowmapLayerProps {
  /**
   * Arc width in pixels per unit of `sqrt(currentBucketFlow)`. sqrt keeps a wide
   * dynamic range legible (a 100-trip corridor isn't 100× a 1-trip one).
   * @default 1.1
   */
  widthScale?: number;
  /** Clamp arc width to at least this many pixels (applied to ACTIVE arcs only —
   * zero-flow arcs stay at width 0 so they vanish). @default 1 */
  widthMinPixels?: number;
  /** Clamp arc width to at most this many pixels. @default 12 */
  widthMaxPixels?: number;
  /** Source (origin) endpoint color. @default [56, 196, 232, 235] */
  sourceColor?: Color;
  /** Target (destination) endpoint color. @default [255, 142, 64, 245] */
  targetColor?: Color;
  /** Draw each arc along the great-circle path. @default false */
  greatCircle?: boolean;
  /** Arc height multiplier (`0` = flat). @default 0.5 */
  arcHeight?: number;
  /**
   * Node circle radius in pixels per unit of `sqrt(incidentFlow)`, where
   * incident flow is the sum of the station's current-bucket inbound + outbound
   * arc volume. @default 1.3
   */
  nodeRadiusScale?: number;
  /** Clamp node radius (px). @default min 1.5 */
  nodeRadiusMinPixels?: number;
  /** Clamp node radius (px). @default max 28 */
  nodeRadiusMaxPixels?: number;
  /** Node circle fill color. @default [232, 238, 255, 170] */
  nodeColor?: Color;
  /** Node circle stroke color. @default [255, 255, 255, 220] */
  nodeLineColor?: Color;
  /**
   * Hide arcs and nodes whose current flow is below this many trips — squelches
   * sub-bucket blend noise so the map reads cleanly. @default 0.25
   */
  minFlow?: number;
}

/** Complete props accepted by {@link FlowmapLayer}. */
export type FlowmapLayerProps = _FlowmapLayerProps & SpatioTemporalLayerProps;

const DEFAULT_SOURCE_COLOR: Color = [56, 196, 232, 235];
const DEFAULT_TARGET_COLOR: Color = [255, 142, 64, 245];
const DEFAULT_NODE_COLOR: Color = [232, 238, 255, 170];
const DEFAULT_NODE_LINE_COLOR: Color = [255, 255, 255, 220];

/** Cross-fade granularity in fractions of a bucket (10 sub-steps/bucket). See
 * FlowCorridorLayer.STEP — keeps width transitions smooth without per-frame CPU. */
const STEP = 0.1;

function makeTileKey(tile: Tile, layer: TileLayer): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}:${layer.name}`;
}

/** Geometry cached once per tile (positions never change as the playhead moves). */
interface TileGeom {
  tileKey: string;
  source: Float64Array;
  target: Float64Array;
  dims: number;
  /** Global vertex index of each feature's SOURCE vertex (for matrix lookup). */
  srcVertexIndex: Uint32Array;
  timeOffset: number;
  binary: BinaryFeatures;
  tile: Tile;
}

/** A station node accumulated across tiles for the current bucket. */
interface FlowNode {
  position: number[];
  radius: number; // pixels (pre-clamped against scale; deck re-clamps via min/max)
}

/**
 * Animated OD flowmap on the {@link SpatioTemporalLayer} chassis. Inherits tile
 * streaming, prefetch, picking, and theme props at zero cost.
 */
export class FlowmapLayer<ExtraPropsT extends {} = {}> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_FlowmapLayerProps>
> {
  static layerName = 'FlowmapLayer';

  static defaultProps: DefaultProps<FlowmapLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    widthScale: { type: 'number', value: 1.1, min: 0 },
    widthMinPixels: { type: 'number', value: 1, min: 0 },
    widthMaxPixels: { type: 'number', value: 12, min: 0 },
    greatCircle: false,
    arcHeight: { type: 'number', value: 0.5, min: 0 },
    nodeRadiusScale: { type: 'number', value: 1.3, min: 0 },
    nodeRadiusMinPixels: { type: 'number', value: 1.5, min: 0 },
    nodeRadiusMaxPixels: { type: 'number', value: 28, min: 0 },
    minFlow: { type: 'number', value: 0.25, min: 0 },
    // Permissive descriptors — Color arrays validated as plain objects (deck's
    // 'color' validator would reject our defaults' typing in debug mode).
    sourceColor: { type: 'object', value: DEFAULT_SOURCE_COLOR, compare: true },
    targetColor: { type: 'object', value: DEFAULT_TARGET_COLOR, compare: true },
    nodeColor: { type: 'object', value: DEFAULT_NODE_COLOR, compare: true },
    nodeLineColor: { type: 'object', value: DEFAULT_NODE_LINE_COLOR, compare: true },
  };

  /** tileKey → geometry (rebuilt only when a tile appears). */
  private geomCache = new Map<string, TileGeom>();
  /** tileKey → cached ArcLayer + the (flowStep, propsKey) it was built for. */
  private arcCache = new Map<string, { layer: ArcLayer; flowStep: number; propsKey: string }>();
  private lastTilesRef: Tile[] | null = null;
  private lastPropsKey = '';

  // Global bucket axis (shared by every flow tile) — cached from the first
  // matrix tile, drives the time-forced render gate in _handleTimeUpdate.
  private _bucket0Abs = 0;
  private _bucketWidth = 0;
  private _numBuckets = 0;
  private _lastStep = -1;

  finalizeState(context: any): void {
    super.finalizeState(context);
    this.geomCache.clear();
    this.arcCache.clear();
  }

  /** Continuous bucket position in `[0, nb-1]` for an absolute time, from a
   * tile's own axis. `null` when the tile carries no matrix. */
  private posFromBinary(binary: BinaryFeatures, time: number): number | null {
    const nb = binary.vertexValueBuckets ?? 0;
    if (nb <= 0 || !binary.startTimes || binary.startTimes.length === 0) return null;
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

  /** Cache the global bucket axis from the first matrix tile (idempotent). */
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

  /** Build (once) the per-tile geometry: source/target endpoints + each
   * feature's source-vertex global index for matrix lookups. */
  private geomFor(tile: Tile, tileLayer: TileLayer): TileGeom | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0 || !binary.startIndices) return null;
    const tileKey = makeTileKey(tile, tileLayer);
    const cached = this.geomCache.get(tileKey);
    if (cached) return cached;

    const { source, target, dims } = deriveSourceTargetPositions(binary);
    const srcVertexIndex = new Uint32Array(binary.featureCount);
    for (let i = 0; i < binary.featureCount; i++) srcVertexIndex[i] = binary.startIndices[i];

    const geom: TileGeom = {
      tileKey,
      source,
      target,
      dims,
      srcVertexIndex,
      timeOffset: binary.timeOffset,
      binary,
      tile,
    };
    this.geomCache.set(tileKey, geom);
    return geom;
  }

  /** Per-feature flow (blended current bucket) → arc widths for a tile. Also
   * accumulates incident flow into the shared `nodeFlow` map for node circles. */
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

    const b0 = Math.floor(stepped);
    const b1 = Math.min(b0 + 1, nb - 1);
    const f = stepped - b0;
    const g = 1 - f;

    const widthScale = this.props.widthScale;
    const minFlow = this.props.minFlow;
    const dims = geom.dims;

    for (let i = 0; i < n; i++) {
      const base = geom.srcVertexIndex[i] * nb;
      const flow = f <= 0 ? matrix[base + b0] : matrix[base + b0] * g + matrix[base + b1] * f;
      if (flow <= minFlow) {
        widths[i] = 0; // inactive → invisible (this is the animation)
        continue;
      }
      widths[i] = widthScale * Math.sqrt(flow);

      // Incident flow → node circles at both endpoints. (Spanning arcs counted
      // once per tile they appear in; a consistent over-count the radius scale
      // absorbs — node circles are a relative-magnitude cue, not an exact total.)
      addNode(nodeFlow, geom.source, i * dims, dims, flow);
      addNode(nodeFlow, geom.target, i * dims, dims, flow);
    }
    return widths;
  }

  private computePropsKey(): string {
    return [
      this.props.greatCircle,
      this.props.widthMinPixels,
      this.props.widthMaxPixels,
      this.props.arcHeight,
      Array.isArray(this.props.sourceColor) ? this.props.sourceColor.join(',') : '',
      Array.isArray(this.props.targetColor) ? this.props.targetColor.join(',') : '',
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

    // Prune caches when the live tile set changes.
    if (this.lastTilesRef !== tiles) {
      const live = new Set<string>();
      for (const tile of tiles) {
        for (const tl of tile.layers) live.add(makeTileKey(tile, tl));
      }
      for (const key of this.geomCache.keys()) if (!live.has(key)) this.geomCache.delete(key);
      for (const key of this.arcCache.keys()) if (!live.has(key)) this.arcCache.delete(key);
      this.lastTilesRef = tiles;
    }

    const propsKey = this.computePropsKey();
    if (propsKey !== this.lastPropsKey) {
      this.lastPropsKey = propsKey;
      this.arcCache.clear();
    }

    // Quantize the playhead to the cross-fade grid (matches _handleTimeUpdate).
    const time = this.getCurrentTime();
    let stepKey = 0;
    const nodeFlow = new Map<string, { position: number[]; flow: number }>();
    const sublayers: Layer[] = [];

    for (const tile of tiles) {
      for (const tileLayer of tile.layers) {
        const geom = this.geomFor(tile, tileLayer);
        if (!geom) continue;
        this.noteAxis(geom.binary);
        const pos = this.posFromBinary(geom.binary, time) ?? 0;
        const stepped = Math.round(pos / STEP) * STEP;
        stepKey = Math.round(pos / STEP);

        const widths = this.widthsFor(geom, stepped, nodeFlow);

        const cached = this.arcCache.get(geom.tileKey);
        if (cached && cached.flowStep === stepKey && cached.propsKey === propsKey) {
          sublayers.push(cached.layer);
          continue;
        }
        const layer = this.buildArcSublayer(geom, widths);
        this.arcCache.set(geom.tileKey, { layer, flowStep: stepKey, propsKey });
        sublayers.push(layer);
      }
    }

    // One node-circle overlay aggregated across all visible tiles.
    const nodeLayer = this.buildNodeSublayer(nodeFlow, stepKey, propsKey);
    if (nodeLayer) sublayers.push(nodeLayer);

    emit('renderLayers', {
      layer: 'FlowmapLayer',
      tiles: tiles.length,
      sublayers: sublayers.length,
      nodes: nodeFlow.size,
      ms: performance.now() - t0,
    });
    return sublayers;
  }

  private buildArcSublayer(geom: TileGeom, widths: Float32Array): ArcLayer {
    const dims = geom.dims;
    const data = {
      length: geom.binary.featureCount,
      attributes: {
        getSourcePosition: { value: geom.source, size: dims },
        getTargetPosition: { value: geom.target, size: dims },
        getWidth: { value: widths, size: 1 },
      },
    };
    const props = this.composeSubLayerProps('arcs', geom.tileKey, {
      data,
      dataComparator: (a: any, b: any) => a === b,
      positionFormat: dims === 3 ? 'XYZ' : 'XY',
      greatCircle: this.props.greatCircle,
      getSourceColor: (Array.isArray(this.props.sourceColor)
        ? this.props.sourceColor
        : DEFAULT_SOURCE_COLOR) as Color,
      getTargetColor: (Array.isArray(this.props.targetColor)
        ? this.props.targetColor
        : DEFAULT_TARGET_COLOR) as Color,
      getHeight: this.props.arcHeight,
      // Width comes from the per-instance binary buffer (already scaled); deck
      // only clamps to the pixel envelope. widthMinPixels applies to non-zero
      // widths; zero-flow arcs stay at 0 → invisible.
      widthUnits: 'pixels',
      widthScale: 1,
      widthMinPixels: this.props.widthMinPixels,
      widthMaxPixels: this.props.widthMaxPixels,
      extensions: this.composeExtensions([]),
      // Picking enrichment (base getPickingInfo decodes the picked corridor).
      tile: geom.tile,
      sttFeatures: geom.binary,
    });
    const SubLayerClass = this.getSubLayerClass('arcs', ArcLayer);
    return new SubLayerClass(props as any);
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
      radiusUnits: 'pixels',
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
      // Node positions/radii change every sub-step; refresh accessors then.
      updateTriggers: { getPosition: stepKey, getRadius: stepKey, getFillColor: propsKey },
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
      // setState (not setNeedsRedraw) re-runs renderLayers → the width buffer and
      // node aggregation re-expand for the new sub-step. Geometry stays resident.
      this.setState({ flowStep: step });
    }
  }
}

/** Accumulate `flow` into the node at `coords[base..base+dims]`, keyed by a
 * quantized position (~1 m) so the same dock collapses across tiles. */
function addNode(
  nodeFlow: Map<string, { position: number[]; flow: number }>,
  coords: Float64Array,
  base: number,
  dims: number,
  flow: number,
): void {
  const lon = coords[base];
  const lat = coords[base + 1];
  const key = `${lon.toFixed(5)},${lat.toFixed(5)}`;
  const existing = nodeFlow.get(key);
  if (existing) {
    existing.flow += flow;
  } else {
    const position = dims === 3 ? [lon, lat, coords[base + 2]] : [lon, lat];
    nodeFlow.set(key, { position, flow });
  }
}

// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * FlowmapLayer — flowmap.gl-style **animated origin→destination flowmap**.
 *
 * Renders one weighted **tapered arrow** per OD station-pair whose WIDTH tracks
 * trip volume at the playhead, plus node circles sized by each station's total
 * incident flow. As the time slider scrubs, corridors swell and recede with
 * demand and the node circles pulse — the classic flowmap-over-time look.
 *
 * It fuses two STT mechanisms with a flowmap.gl-faithful arrow primitive:
 *  • {@link FlowLinesLayer} — a port of flowmap.gl's `FlowLinesLayer`: each
 *    2-vertex OD LineString (collapsed to instanced source/target endpoints by
 *    {@link deriveSourceTargetPositions}) is drawn as a straight shaft tapering
 *    into a triangular arrowhead at the destination, with the two directions of
 *    a pair offset side-by-side and the ends inset to the node-circle edges.
 *  • {@link FlowCorridorLayer}'s `vertexValueMatrix` decode — each feature carries
 *    a `[2 × numBuckets]` per-bucket count matrix; the active bucket (linearly
 *    blended across a sub-step) becomes the per-feature flow, mapped to arrow
 *    width and summed at endpoints for node radius. Geometry stays resident;
 *    only the width buffer re-expands when the playhead crosses a sub-step
 *    (~5 Hz), quarantined behind a `setState({ flowStep })` gate in
 *    `_handleTimeUpdate` (mirroring FlowCorridorLayer / AnimatedHeatmapLayer).
 *
 * The data tile spans the WHOLE time range (every corridor's `[start, end]` is
 * the full span), so it loads once and never re-fetches. There is no time
 * filter: an arrow with ~0 current flow gets width 0 (invisible), which IS the
 * animation. Coarse zooms show flowmap.gl-style hub-to-hub aggregated corridors
 * when the tiles were built with `stt-generate bixi` clustering (the default);
 * the layer is agnostic to it — it just renders whatever corridors a tile holds.
 * An archive built WITHOUT the matrix falls back to a per-feature magnitude
 * column ({@link _FlowmapLayerProps.flowProperty}) and renders a STATIC flowmap.
 *
 * `renderLayers` runs in three passes: pass 1 resolves per-tile geometry, pass 2
 * decodes widths and accumulates the per-node incident flow across all visible
 * tiles, pass 3 builds the arrow sublayers, feeding each arrow its endpoints'
 * node-circle radii so the arrowheads land on the circle EDGE rather than its
 * center. Station IDENTITY (the coordinate interning) is hoisted out of the
 * per-sub-step path into a {@link NodeTable} rebuilt only when the visible tile
 * SET changes.
 *
 * Sublayer short ids for `_subLayerProps` overrides: **`flows`** (per tile) and
 * **`nodes`** (single overlay).
 */

import { ScatterplotLayer } from '@deck.gl/layers';
import type { Color, DefaultProps, Layer } from '@deck.gl/core';
import {
  SpatioTemporalLayer,
  SpatioTemporalLayerProps,
} from '../spatiotemporal-layer.js';
import { FlowLinesLayer } from '../internal/flow-lines-layer.js';
import { deriveSourceTargetPositions } from '../../lib/od-positions.js';
import { bucketBlendAt, blendMatrixRow } from '../../lib/vertex-value-blend.js';
import { resolveAccessorAlias } from '../../lib/accessor-alias.js';
import type { ColorAccessorValue } from '../../lib/accessor-alias.js';
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

/** Props added by {@link FlowmapLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link FlowmapLayerProps}). */
export interface _FlowmapLayerProps {
  /**
   * Arrow width in pixels per unit of `sqrt(currentBucketFlow)`. sqrt keeps a
   * wide dynamic range legible (a 100-trip corridor isn't 100× a 1-trip one).
   * @default 1.1
   */
  widthScale?: number;
  /** Clamp arrow width to at least this many pixels (applied to ACTIVE arrows
   * only — zero-flow arrows stay at width 0 so they vanish). @default 1 */
  widthMinPixels?: number;
  /** Clamp arrow width to at most this many pixels. @default 12 */
  widthMaxPixels?: number;
  /** Source (origin / tail) color. @default [56, 196, 232, 235] */
  sourceColor?: Color;
  /**
   * Upstream-vocabulary (ArcLayer) alias of {@link sourceColor}. NOTE: unlike
   * upstream deck.gl, this accepts a constant Color only — NOT a function
   * accessor (binary tiles can't run per-feature JS; a function warns once and
   * falls back to `sourceColor`). When set, it wins over `sourceColor`.
   */
  getSourceColor?: ColorAccessorValue | null;
  /** Target (destination / arrowhead) color. @default [255, 142, 64, 245] */
  targetColor?: Color;
  /**
   * Upstream-vocabulary alias of {@link targetColor}. Constant Color only — a
   * function accessor warns once and falls back to `targetColor`. When set, it
   * wins over `targetColor`.
   */
  getTargetColor?: ColorAccessorValue | null;
  /**
   * Perpendicular separation between the two directions of a pair, in units of
   * the arrow width — so A→B and B→A sit side-by-side. @default 0.5
   */
  gap?: number;
  /**
   * Node circle radius in pixels per unit of `sqrt(incidentFlow)`, where
   * incident flow is the sum of the station's current-bucket inbound + outbound
   * flow volume. @default 1.3
   */
  nodeRadiusScale?: number;
  /**
   * Units for the node-circle radius. `'pixels'` keeps a constant on-screen size
   * at every zoom; `'meters'` makes the circles scale with the map, so a dense
   * overview shrinks them instead of blowing out into overlapping blobs (still
   * clamped by `nodeRadiusMin/MaxPixels`). With `'meters'`, `nodeRadiusScale` is
   * a metres-per-√flow factor (so it needs a much larger value than in pixels).
   * @default 'pixels'
   */
  nodeRadiusUnits?: 'meters' | 'pixels';
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
  /**
   * Per-feature numeric column carrying the flow magnitude, used for archives
   * built WITHOUT the per-bucket `vertexValueMatrix` (a STATIC, non-animated
   * flowmap: every corridor keeps one constant width). Ignored when the tile
   * does carry the matrix — that is always the animated source of truth.
   * Unset (the default) auto-detects the first of
   * {@link FLOW_COLUMN_CANDIDATES} present on the tile.
   * @default null
   */
  flowProperty?: string | null;
}

/**
 * Column names probed for a per-feature flow magnitude when a tile carries no
 * per-bucket `vertexValueMatrix`. First match wins; `flowProperty` overrides
 * the probe entirely.
 * @internal
 */
export const FLOW_COLUMN_CANDIDATES = [
  'flow',
  'count',
  'volume',
  'trips',
  'value',
  'weight',
] as const;

/**
 * The per-feature flow column for a tile with no bucket matrix: the caller's
 * `flowProperty` when set, else the first {@link FLOW_COLUMN_CANDIDATES} hit.
 * Returns `null` when the archive carries no usable magnitude at all — the
 * caller warns and renders nothing, which is the only honest outcome.
 * Shared with {@link BundledFlowmapLayer}.
 * @internal
 */
export function resolveFlowColumn(
  binary: BinaryFeatures,
  flowProperty: string | null | undefined,
): ArrayLike<number> | null {
  const numeric = binary.numericProps ?? {};
  if (flowProperty) return numeric[flowProperty] ?? null;
  for (const name of FLOW_COLUMN_CANDIDATES) {
    const col = numeric[name];
    if (col) return col;
  }
  return null;
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

/**
 * The slice of a tile's cached geometry {@link buildNodeTable} needs —
 * structurally satisfied by both this layer's and {@link BundledFlowmapLayer}'s
 * `TileGeom`.
 * @internal
 */
export interface NodeGeom {
  tileKey: string;
  source: Float64Array;
  target: Float64Array;
  dims: number;
  binary: { featureCount: number };
}

/**
 * Station identity for ONE visible tile set, built once when the set changes
 * and reused for every playhead sub-step.
 *
 * The expensive half of node aggregation is IDENTITY — interning each endpoint
 * under a quantized coordinate string. That depends only on the tile set, not
 * on the playhead, so it is hoisted here: the ~5–10 Hz sub-step pass then walks
 * `endpoints` (a plain Int32Array of pre-resolved node indices) and accumulates
 * into `flow`, with zero strings and zero allocations.
 *
 * Shared with {@link BundledFlowmapLayer}.
 * @internal
 */
export interface NodeTable {
  /** The tile-set membership key this table was interned for. */
  setKey: string;
  /** Node count. */
  count: number;
  /** `count × 3` lon/lat/z, ready to hand deck as a binary attribute. */
  positions: Float64Array;
  /** tileKey → `featureCount × 2` `[sourceNode, targetNode]` indices. */
  endpoints: Map<string, Int32Array>;
  /** Scratch, zeroed per sub-step: incident flow per node. */
  flow: Float64Array;
  /** Scratch, per sub-step: rendered (clamped) circle radius in px per node. */
  radius: Float64Array;
}

/**
 * Animated OD flowmap on the {@link SpatioTemporalLayer} chassis. Inherits tile
 * streaming, prefetch, picking, and theme props at zero cost.
 */
/** One cached per-tile FlowLinesLayer plus everything baked into it. */
interface CachedFlowArc {
  layer: FlowLinesLayer;
  flowStep: number;
  propsKey: string;
  setKey: string;
}

/**
 * Everything the render path caches between frames, in ONE bag so it can live
 * on `this.state` and survive deck's `_transferState`. See
 * {@link FlowmapLayer.flowCaches}.
 */
interface FlowmapCaches {
  geom: Map<string, TileGeom>;
  arcs: Map<string, CachedFlowArc>;
  tilesRef: Tile[] | null;
  propsKey: string;
  tileSetKey: string;
  nodeTable: NodeTable | null;
  bucket0Abs: number;
  bucketWidth: number;
  numBuckets: number;
  lastStep: number;
}

const FLOWMAP_CACHE_SLOT = '_sttFlowmapCaches';

function freshFlowmapCaches(): FlowmapCaches {
  return {
    geom: new Map(),
    arcs: new Map(),
    tilesRef: null,
    propsKey: '',
    tileSetKey: '',
    nodeTable: null,
    bucket0Abs: 0,
    bucketWidth: 0,
    numBuckets: 0,
    lastStep: -1,
  };
}

export class FlowmapLayer<
  ExtraPropsT extends {} = {},
> extends SpatioTemporalLayer<ExtraPropsT & Required<_FlowmapLayerProps>> {
  static layerName = 'FlowmapLayer';

  static defaultProps: DefaultProps<FlowmapLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    widthScale: { type: 'number', value: 1.1, min: 0 },
    widthMinPixels: { type: 'number', value: 1, min: 0 },
    widthMaxPixels: { type: 'number', value: 12, min: 0 },
    gap: { type: 'number', value: 0.5, min: 0 },
    nodeRadiusScale: { type: 'number', value: 1.3, min: 0 },
    nodeRadiusUnits: 'pixels',
    nodeRadiusMinPixels: { type: 'number', value: 1.5, min: 0 },
    nodeRadiusMaxPixels: { type: 'number', value: 28, min: 0 },
    minFlow: { type: 'number', value: 0.25, min: 0 },
    flowProperty: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    // Permissive descriptors — Color arrays validated as plain objects (deck's
    // 'color' validator would reject our defaults' typing in debug mode).
    sourceColor: { type: 'object', value: DEFAULT_SOURCE_COLOR, compare: true },
    targetColor: { type: 'object', value: DEFAULT_TARGET_COLOR, compare: true },
    nodeColor: { type: 'object', value: DEFAULT_NODE_COLOR, compare: true },
    nodeLineColor: {
      type: 'object',
      value: DEFAULT_NODE_LINE_COLOR,
      compare: true,
    },
    // Accessor-named aliases (see the prop docs): unset by default so the
    // legacy props win unless the caller opts into the upstream vocabulary.
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
  };

  /**
   * Render caches, held on `this.state` rather than in class FIELDS.
   *
   * deck's `_transferState` moves only `state`/`internalState` onto the
   * instance React hands it each render; class-field initializers re-run on
   * that instance. Held as fields, every unmemoized `new FlowmapLayer({...})`
   * in a React render re-derived every tile's OD endpoints and re-interned the
   * whole node table. `AnimatedTripsLayer` fixed this first.
   */
  private get flowCaches(): FlowmapCaches {
    return this.stateSlot(FLOWMAP_CACHE_SLOT, freshFlowmapCaches);
  }

  // The accessors below keep the historical field NAMES while the storage lives
  // on `state`.

  /** tileKey → geometry (rebuilt only when a tile appears). */
  private get geomCache(): Map<string, TileGeom> {
    return this.flowCaches.geom;
  }
  private set geomCache(value: Map<string, TileGeom>) {
    this.flowCaches.geom = value;
  }
  /**
   * tileKey → cached FlowLinesLayer + everything baked into it. `setKey` is
   * load-bearing: the endpoint insets are the node radii aggregated across ALL
   * visible tiles, so a NEW tile feeding an already-visible hub grows that
   * hub's circle while a cache hit would keep the smaller inset — arrowheads
   * buried under the circle until the sub-step happened to turn over.
   */
  private get arcCache(): Map<string, CachedFlowArc> {
    return this.flowCaches.arcs;
  }
  private set arcCache(value: Map<string, CachedFlowArc>) {
    this.flowCaches.arcs = value;
  }
  private get lastTilesRef(): Tile[] | null {
    return this.flowCaches.tilesRef;
  }
  private set lastTilesRef(value: Tile[] | null) {
    this.flowCaches.tilesRef = value;
  }
  private get lastPropsKey(): string {
    return this.flowCaches.propsKey;
  }
  private set lastPropsKey(value: string) {
    this.flowCaches.propsKey = value;
  }
  /** Sorted membership key of the live tile set (NOT array identity). */
  private get tileSetKey(): string {
    return this.flowCaches.tileSetKey;
  }
  private set tileSetKey(value: string) {
    this.flowCaches.tileSetKey = value;
  }
  /** Station identity for {@link tileSetKey}; rebuilt only when the set changes. */
  private get nodeTable(): NodeTable | null {
    return this.flowCaches.nodeTable;
  }
  private set nodeTable(value: NodeTable | null) {
    this.flowCaches.nodeTable = value;
  }

  // Global bucket axis (shared by every flow tile) — cached from the first
  // matrix tile, drives the time-forced render gate in _handleTimeUpdate.
  private get _bucket0Abs(): number {
    return this.flowCaches.bucket0Abs;
  }
  private set _bucket0Abs(value: number) {
    this.flowCaches.bucket0Abs = value;
  }
  private get _bucketWidth(): number {
    return this.flowCaches.bucketWidth;
  }
  private set _bucketWidth(value: number) {
    this.flowCaches.bucketWidth = value;
  }
  private get _numBuckets(): number {
    return this.flowCaches.numBuckets;
  }
  private set _numBuckets(value: number) {
    this.flowCaches.numBuckets = value;
  }
  private get _lastStep(): number {
    return this.flowCaches.lastStep;
  }
  private set _lastStep(value: number) {
    this.flowCaches.lastStep = value;
  }

  finalizeState(context: any): void {
    super.finalizeState(context);
    this.geomCache.clear();
    this.arcCache.clear();
    this.nodeTable = null;
  }

  /** Continuous bucket position in `[0, nb-1]` for an absolute time, from a
   * tile's own axis. `null` when the tile carries no matrix. */
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
      timeOffset: binary.timeOffset,
      binary,
      tile,
    };
    this.geomCache.set(tileKey, geom);
    return geom;
  }

  /**
   * Per-feature flow (blended current bucket) → arc widths for a tile. Also
   * accumulates incident flow into the shared {@link NodeTable} for the node
   * circles. Runs on every sub-step, so it stays on the binary path: node
   * identity was interned once per tile set, leaving only index arithmetic.
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

    // Animated source of truth: the per-bucket matrix. Archives built without
    // it still carry a plain per-feature magnitude column — fall back to that
    // (a static flowmap) rather than render an all-zero, blank map that looks
    // exactly like a load failure.
    const staticFlow =
      nb > 0 && matrix
        ? null
        : resolveFlowColumn(binary, this.props.flowProperty);
    if (!matrix && !staticFlow) {
      warnOnce(
        'FlowmapLayer:noFlowSource',
        '[FlowmapLayer] tiles carry neither a per-bucket vertexValueMatrix nor a ' +
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
        widths[i] = 0; // inactive → invisible (this is the animation)
        continue;
      }
      widths[i] = widthScale * Math.sqrt(flow);

      // Incident flow → node circles at both endpoints. (Spanning arcs counted
      // once per tile they appear in; a consistent over-count the radius scale
      // absorbs — node circles are a relative-magnitude cue, not an exact total.)
      if (nodeIdx) {
        flowAcc[nodeIdx[i * 2]] += flow;
        flowAcc[nodeIdx[i * 2 + 1]] += flow;
      }
    }
    return widths;
  }

  /** Memoized {@link buildNodeTable} for the current tile set. */
  private nodeTableFor(geoms: NodeGeom[], setKey: string): NodeTable {
    const cached = this.nodeTable;
    if (cached && cached.setKey === setKey) return cached;
    const table = buildNodeTable(geoms, setKey);
    this.nodeTable = table;
    return table;
  }

  /**
   * Accessor-alias resolution: the upstream-named alias wins when
   * set; a function-valued alias warns once and falls back to the legacy prop.
   * Constant colors only (there is no per-feature color column on OD arrows).
   */
  private sourceColorValue(): Color {
    const resolved = resolveAccessorAlias(
      'FlowmapLayer',
      'getSourceColor',
      this.props.getSourceColor,
      this.props.sourceColor,
    );
    return (Array.isArray(resolved) ? resolved : DEFAULT_SOURCE_COLOR) as Color;
  }

  private targetColorValue(): Color {
    const resolved = resolveAccessorAlias(
      'FlowmapLayer',
      'getTargetColor',
      this.props.getTargetColor,
      this.props.targetColor,
    );
    return (Array.isArray(resolved) ? resolved : DEFAULT_TARGET_COLOR) as Color;
  }

  /**
   * Everything baked into a cached arrow sublayer at construction time. A miss
   * here means the change never reaches the layer tree, so it must cover the
   * width/flow inputs (`widthScale`/`minFlow`/`flowProperty` feed `widthsFor`),
   * the node-radius envelope (it feeds the endpoint insets), AND every composite
   * prop `getSubLayerProps()` forwards — `pickable`, `autoHighlight`,
   * `coordinateSystem`, `modelMatrix`, `parameters`, `_subLayerProps`,
   * `extensions`, … — via {@link inheritedPropsDigest}, plus the user's
   * `updateTriggers`.
   */
  private computePropsKey(): string {
    return [
      this.props.widthScale,
      this.props.widthMinPixels,
      this.props.widthMaxPixels,
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

  /**
   * Deck extensions cannot reach this family's shaders. `FlowLinesLayer` is a
   * custom-`Model` layer that declares no `DECKGL_FILTER_*` hooks (see its
   * docstring on why), so deck merges the extension's module, allocates its
   * attributes, and then drops every injection — silently, because
   * `disableWarnings` is inherited. Strip them and say so once instead of
   * forwarding a list that looks live and isn't.
   */
  protected flowExtensions(): unknown[] {
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
        'FlowmapLayer:extensions',
        `[FlowmapLayer] ignoring extensions (${names}): the OD arrow sublayers use ` +
          'custom shaders with no DECKGL_FILTER_* hooks, so extension injections ' +
          'never run.',
      );
    }
    return [];
  }

  renderLayers(): Layer[] {
    const t0 = performance.now();
    const { tiles } = this.state as { tiles?: Tile[] };
    if (!tiles || tiles.length === 0) {
      this.lastTilesRef = null;
      return [];
    }

    // Prune caches when the live tile set changes, and re-derive the SORTED
    // membership key (the `tiles` array is a fresh reference most renders, so
    // identity alone can't distinguish "same tiles" from "set changed").
    if (this.lastTilesRef !== tiles) {
      const live = new Set<string>();
      for (const tile of tiles) {
        for (const tl of tile.layers) live.add(tileLayerKey(tile.id, tl.name));
      }
      for (const key of this.geomCache.keys())
        if (!live.has(key)) this.geomCache.delete(key);
      for (const key of this.arcCache.keys())
        if (!live.has(key)) this.arcCache.delete(key);
      this.tileSetKey = [...live].sort().join('|');
      this.lastTilesRef = tiles;
    }
    const setKey = this.tileSetKey;

    const propsKey = this.computePropsKey();
    if (propsKey !== this.lastPropsKey) {
      this.lastPropsKey = propsKey;
      this.arcCache.clear();
    }

    // Quantize the playhead to the cross-fade grid (matches _handleTimeUpdate).
    const time = this.getCurrentTime();
    let stepKey = 0;

    // Pass 1: resolve each tile's geometry + its stepped bucket position.
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

    // Pass 2: decode widths and accumulate per-node incident flow across ALL
    // visible tiles (so a hub's radius — and the arrow insets that depend on it
    // — see the full picture, not one tile's slice). Node IDENTITY is interned
    // once per tile set; only the numeric accumulation re-runs per sub-step.
    const table = this.nodeTableFor(
      prepared.map((p) => p.geom),
      setKey,
    );
    table.flow.fill(0);
    const withWidths = prepared.map(({ geom, stepped }) => ({
      geom,
      widths: this.widthsFor(geom, stepped, table),
    }));

    // Node circle radii (px, clamped to the rendered envelope) — shared by the
    // node circles AND the arrow endpoint insets so arrowheads meet the edge.
    const activeNodes = this.applyNodeRadii(table);

    // Pass 3: build (cache-gated) one arrow sublayer per tile.
    const sublayers: Layer[] = [];
    for (const { geom, widths } of withWidths) {
      const cached = this.arcCache.get(geom.tileKey);
      if (
        cached &&
        cached.flowStep === stepKey &&
        cached.propsKey === propsKey &&
        cached.setKey === setKey
      ) {
        sublayers.push(cached.layer);
        continue;
      }
      const offsets = nodeEndpointOffsets(table, geom);
      const layer = this.buildFlowSublayer(geom, widths, offsets);
      this.arcCache.set(geom.tileKey, {
        layer,
        flowStep: stepKey,
        propsKey,
        setKey,
      });
      sublayers.push(layer);
    }

    // One node-circle overlay aggregated across all visible tiles.
    const nodeLayer = this.buildNodeSublayer(table, stepKey, propsKey);
    if (nodeLayer) sublayers.push(nodeLayer);

    emit('renderLayers', {
      layer: 'FlowmapLayer',
      tiles: tiles.length,
      sublayers: sublayers.length,
      nodes: activeNodes,
      ms: performance.now() - t0,
    });
    return sublayers;
  }

  private buildFlowSublayer(
    geom: TileGeom,
    widths: Float32Array,
    endpointOffsets: Float32Array,
  ): FlowLinesLayer {
    const dims = geom.dims;
    const data = {
      length: geom.binary.featureCount,
      attributes: {
        getSourcePosition: { value: geom.source, size: dims },
        getTargetPosition: { value: geom.target, size: dims },
        getWidth: { value: widths, size: 1 },
        getEndpointOffsets: { value: endpointOffsets, size: 2 },
      },
    };
    const props = this.composeSubLayerProps('flows', geom.tileKey, {
      data,
      dataComparator: (a: any, b: any) => a === b,
      positionFormat: dims === 3 ? 'XYZ' : 'XY',
      sourceColor: this.sourceColorValue(),
      targetColor: this.targetColorValue(),
      gap: this.props.gap,
      // Width arrives per-instance in pixels (already scaled); clamp to the px
      // envelope. Zero-flow arrows stay at width 0 → invisible (FlowLinesLayer
      // exempts them from widthMinPixels).
      widthMinPixels: this.props.widthMinPixels,
      widthMaxPixels: this.props.widthMaxPixels,
      extensions: this.flowExtensions(),
      // Picking enrichment (base getPickingInfo decodes the picked corridor).
      tile: geom.tile,
      sttFeatures: geom.binary,
    });
    const SubLayerClass = this.getSubLayerClass('flows', FlowLinesLayer);
    return new SubLayerClass(props as any);
  }

  /** {@link applyNodeRadii} with this layer's radius envelope. */
  private applyNodeRadii(table: NodeTable): number {
    return applyNodeRadii(
      table,
      this.props.nodeRadiusScale,
      this.props.nodeRadiusMinPixels,
      this.props.nodeRadiusMaxPixels,
    );
  }

  /**
   * The single node-circle overlay: the ACTIVE nodes compacted into binary
   * `getPosition`/`getRadius` attributes. Binary (not a `{position, radius}[]`
   * fed through JS accessors) because this rebuilds on every sub-step — two
   * typed arrays per sub-step instead of two objects and an array per node.
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
      // Node positions/radii change every sub-step; refresh the buffers then.
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
      // setState (not setNeedsRedraw) re-runs renderLayers → the width buffer and
      // node aggregation re-expand for the new sub-step. Geometry stays resident.
      this.setState({ flowStep: step });
    }
  }
}

/**
 * Quantized node key (~1.1 m at the equator) so the same dock collapses across
 * tiles and the arrow endpoint lookup matches the accumulated node.
 *
 * ⚠ INVARIANT: cross-tile station identity rides on the
 * COORDINATE, not on `featureIds`/`featureIds64` — this family consults neither.
 * That is only sound because `stt:quant` is a per-LAYER, world-anchored affine,
 * so a station dequantizes bit-identically in every tile that carries it; a
 * per-tile quantization origin would split one hub into one node per tile. The
 * flip side: two genuinely distinct stations closer than ~1.1 m silently merge
 * into one circle (and pool their flow). Both are acceptable for OD flowmaps at
 * the zooms where corridors are legible; neither is safe to assume elsewhere.
 * @see nodeTableFor
 */
function nodeKey(lon: number, lat: number): string {
  return `${lon.toFixed(5)},${lat.toFixed(5)}`;
}

/**
 * Intern the node at `coords[base..base+dims]` into `index`/`xyz`, returning
 * its node number. Called once per endpoint per TILE SET (not per sub-step) —
 * see {@link NodeTable}.
 */
function internNode(
  index: Map<string, number>,
  xyz: number[],
  coords: Float64Array,
  base: number,
  dims: number,
): number {
  const lon = coords[base];
  const lat = coords[base + 1];
  const key = nodeKey(lon, lat);
  const existing = index.get(key);
  if (existing !== undefined) return existing;
  const id = xyz.length / 3;
  index.set(key, id);
  xyz.push(lon, lat, dims === 3 ? coords[base + 2] : 0);
  return id;
}

/**
 * Intern every visible endpoint of `geoms` into a {@link NodeTable} for
 * `setKey`. This is where the ~1 m coordinate keys are built — ONCE per tile
 * set instead of twice per active corridor per sub-step.
 * @internal
 */
export function buildNodeTable(geoms: NodeGeom[], setKey: string): NodeTable {
  const index = new Map<string, number>();
  const xyz: number[] = [];
  const endpoints = new Map<string, Int32Array>();
  for (const geom of geoms) {
    const n = geom.binary.featureCount;
    const dims = geom.dims;
    const pairs = new Int32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const b = i * dims;
      pairs[i * 2] = internNode(index, xyz, geom.source, b, dims);
      pairs[i * 2 + 1] = internNode(index, xyz, geom.target, b, dims);
    }
    endpoints.set(geom.tileKey, pairs);
  }
  const count = xyz.length / 3;
  return {
    setKey,
    count,
    positions: Float64Array.from(xyz),
    endpoints,
    flow: new Float64Array(count),
    radius: new Float64Array(count),
  };
}

/**
 * Fill `table.radius` with the CLAMPED (rendered) node-circle radius in px —
 * the same envelope the ScatterplotLayer applies, so circles and arrow insets
 * agree. Returns the number of ACTIVE (non-zero-flow) nodes.
 * @internal
 */
export function applyNodeRadii(
  table: NodeTable,
  scale: number,
  rmin: number,
  rmax: number,
): number {
  const { flow, radius } = table;
  let active = 0;
  for (let i = 0; i < table.count; i++) {
    const f = flow[i];
    if (f <= 0) {
      radius[i] = 0;
      continue;
    }
    active++;
    radius[i] = Math.min(rmax, Math.max(rmin, scale * Math.sqrt(f)));
  }
  return active;
}

/**
 * Per-feature `[sourceInset, targetInset]` (px) = each endpoint's node radius,
 * so the arrow starts/ends on the node-circle EDGE, not its center. Reads the
 * radii aggregated across the WHOLE visible set, which is why the sublayers
 * that bake it must key their cache on the tile set.
 * @internal
 */
export function nodeEndpointOffsets(
  table: NodeTable,
  geom: NodeGeom,
): Float32Array {
  const n = geom.binary.featureCount;
  const out = new Float32Array(n * 2);
  const nodeIdx = table.endpoints.get(geom.tileKey);
  if (!nodeIdx) return out;
  const radius = table.radius;
  for (let i = 0; i < n; i++) {
    out[i * 2] = radius[nodeIdx[i * 2]];
    out[i * 2 + 1] = radius[nodeIdx[i * 2 + 1]];
  }
  return out;
}

/**
 * Compact the ACTIVE nodes into deck binary attributes for the circle overlay:
 * `getPosition` (XYZ f64) + `getRadius` (f32, UNCLAMPED so `'meters'` units
 * still scale with the map — deck re-clamps via `radiusMin/MaxPixels`).
 * Returns `null` when nothing is active. Two typed arrays per sub-step, versus
 * one object + one array per node on the accessor path this replaced.
 * @internal
 */
export function compactActiveNodes(
  table: NodeTable,
  scale: number,
): {
  length: number;
  attributes: Record<
    string,
    { value: Float64Array | Float32Array; size: number }
  >;
} | null {
  const { count, radius, positions, flow } = table;
  let active = 0;
  for (let i = 0; i < count; i++) if (radius[i] > 0) active++;
  if (active === 0) return null;

  const nodePositions = new Float64Array(active * 3);
  const nodeRadii = new Float32Array(active);
  let o = 0;
  for (let i = 0; i < count; i++) {
    if (radius[i] <= 0) continue;
    nodePositions[o * 3] = positions[i * 3];
    nodePositions[o * 3 + 1] = positions[i * 3 + 1];
    nodePositions[o * 3 + 2] = positions[i * 3 + 2];
    nodeRadii[o] = scale * Math.sqrt(flow[i]);
    o++;
  }
  return {
    length: active,
    attributes: {
      getPosition: { value: nodePositions, size: 3 },
      getRadius: { value: nodeRadii, size: 1 },
    },
  };
}

// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * AnimatedTripHeadsLayer — a smooth moving DOT at the head of each active trip.
 *
 * The head position (where the vehicle sits at the current playhead) is
 * interpolated along each trip's path ON THE CPU, once per frame, and rendered
 * through a stock `@deck.gl/layers` ScatterplotLayer. So it gets fp64 positions
 * (no high-zoom jitter), real circular markers, globe support, and categorical
 * color — all on plain deck.gl layers, with zero custom GLSL.
 *
 * Why CPU-per-frame is fine: only trips ACTIVE at the playhead get a dot, and
 * the interpolation is a binary-search + lerp per active trip over the visible
 * tiles — a few thousand at most at showcase scale (well under 1 ms/frame).
 *
 * Smoothness: position is a CONTINUOUS interpolation, so there is none of the
 * per-vertex-alpha pulsing that a short PathLayer trail shows on sparse
 * (bridge/highway) geometry — the dot glides smoothly through the whole trip.
 * That pulsing is a real parity gap against upstream `TripsLayer`, which
 * interpolates time ALONG each segment from a twin `vertexOffset: 1` shader
 * view; STT's single-view `instanceVertexTime` cannot, for attribute-budget
 * reasons documented at the head of `animated-trips-layer.ts`. This layer is
 * the sanctioned workaround until that lands.
 *
 * Like {@link FlowCorridorLayer}, this overrides `_handleTimeUpdate` to force a
 * renderLayers() pass each frame: the base point/trips layers are deliberately
 * redraw-only on time (their motion is a shader uniform), but ours is a
 * CPU-computed position attribute, so renderLayers must re-run to move the dot.
 *
 * Tile-side data dependencies: ZERO archive changes. Reads the existing
 * `BinaryFeatures` columns (`positions`, `startIndices`, `startTimes`,
 * `endTimes`, and `vertexTimestamps` when present; otherwise the per-vertex
 * times are synthesized distance-proportionally, mirroring AnimatedTripsLayer).
 */

import { ScatterplotLayer } from '@deck.gl/layers';
import type { Color, DefaultProps, Layer, LayerContext } from '@deck.gl/core';
import {
  SpatioTemporalLayer,
  SpatioTemporalLayerProps,
} from '../spatiotemporal-layer.js';
import {
  synthesizeVertexTimes,
  expandGradientColors,
} from './animated-trips-layer.js';
import { emit, isProbeEnabled } from '../../lib/telemetry.js';
import { expectGeometry } from '../../lib/geometry-guard.js';
import { GeometryType, tileLayerKey } from '@poopdeck.gl/core';
import type {
  Tile,
  STTTileLayer as TileLayer,
  BinaryFeatures,
} from '@poopdeck.gl/core';

const DEBUG = false;

/** Head dots are interpolated ALONG each trip's vertex run. */
const LINESTRING_ONLY = [GeometryType.LineString] as const;

/** Props added by {@link AnimatedTripHeadsLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link AnimatedTripHeadsLayerProps}). */
export interface _AnimatedTripHeadsLayerProps {
  /**
   * Head dot color (RGBA, 0-255). Used as a CONSTANT fill when no per-vertex
   * gradient is configured, and as the fallback for dots whose interpolated
   * gradient value is `NaN` (e.g. outside the sampled field).
   * @default [253, 128, 93, 255]
   */
  headColor?: Color;

  /* ── Per-vertex gradient coloring ──────────────────────────────────────
   * Colors each moving dot by a per-vertex scalar carried on the trip
   * (`BinaryFeatures.vertexValues`), interpolated to the dot's live position
   * exactly like the position itself, then mapped through a ramp. Mirrors the
   * {@link AnimatedTripsLayer} `gradient*` vocabulary so a dataset's
   * `windGradient` config drives both the streamline and the dot renderer.
   * Used e.g. to shade the HRRR drift-particle field by 500 mb air
   * temperature. Falls back to constant {@link headColor} when unset. */

  /**
   * Names which per-vertex scalar channel to color by — currently only
   * `'vertexValues'`. When set (with a non-empty {@link gradientColorRamp}) and
   * the tile carries that channel, each dot's value is mapped through the ramp
   * over {@link gradientDomain}. @default null (constant {@link headColor})
   */
  gradientProperty?: string | null;
  /** `[min, max]` value range mapped onto {@link gradientColorRamp}. @default [0, 1] */
  gradientDomain?: [number, number];
  /** Low→high color stops for the gradient ramp. Empty → constant color. @default [] */
  gradientColorRamp?: Color[];
  /**
   * Units for the head radius — `ScatterplotLayer.radiusUnits` pass-through.
   * 'pixels' (default) is screen-space; 'meters' makes the dot world-space so
   * it emerges/shrinks with zoom (clamped by the pixel bounds), mirroring the
   * maritime point layer's "render by space" look; 'common' is deck's
   * projection-space unit. Anything other than 'pixels' reads the radius from
   * {@link headRadius} (falling back to {@link headRadiusPixels}).
   * @default 'pixels'
   */
  sizeUnits?: 'pixels' | 'meters' | 'common';
  /** Head radius in pixels (used when `sizeUnits === 'pixels'`). @default 4 */
  headRadiusPixels?: number;
  /**
   * Head radius in meters (used when `sizeUnits === 'meters'`). Falls back to
   * `headRadiusPixels` when unset.
   */
  headRadius?: number;
  /** Minimum on-screen head radius in pixels. @default 0 */
  headRadiusMinPixels?: number;
  /** Maximum on-screen head radius in pixels. @default unbounded */
  headRadiusMaxPixels?: number;
  /**
   * Global multiplier applied to every head radius (before the pixel
   * min/max clamp) — ScatterplotLayer `radiusScale` pass-through. Useful for a
   * one-knob emphasis pulse without touching the per-dot radius.
   * @default 1
   */
  radiusScale?: number;
  /**
   * Render the head dots as camera-facing billboards — ScatterplotLayer
   * `billboard` pass-through. Matters in the globe / pitched / space-time-cube
   * views this layer supports, where a ground-plane disk would foreshorten.
   * @default false
   */
  headBillboard?: boolean;
  /**
   * Smooth-edge antialiasing — ScatterplotLayer `antialiasing` pass-through.
   * Disable to reduce blending artifacts on dense overlapping dots.
   * @default true
   */
  antialiasing?: boolean;

  /* ── 3D elevation (per-feature z) ──────────────────────────────────────
   * Lift each head dot to a per-FEATURE altitude sourced from a tile column,
   * mirroring {@link AnimatedPointLayer} / {@link AnimatedPathLayer}: the tile
   * geometry stays 2D (lon/lat) and each dot's z becomes `column[feature] ×
   * elevationScale` metres, ADDED to any z the geometry already carries. A
   * trip rides ONE level for its whole life (e.g. an HRRR wind particle pinned
   * to a pressure surface), so the height is per-feature, not per-vertex.
   * Unset → dots stay at ground (z = 0, or the archive's own 3D z). */

  /**
   * Numeric (or categorical, via {@link elevationMapping}) tile column that
   * sets each dot's altitude in metres. @default null (ground)
   */
  elevationProperty?: string | null;
  /**
   * Category-string → metres map for a CATEGORICAL {@link elevationProperty}
   * (the height analogue of `gradientColorRamp`). @default null
   */
  elevationMapping?: Record<string, number> | null;
  /**
   * Multiplier applied to every {@link elevationProperty} value before it
   * becomes the dot's z — the scene's shared vertical exaggeration. No effect
   * when {@link elevationProperty} is unset. @default 1
   */
  elevationScale?: number;

  /* ── Outline / contrast-ring subsystem ─────────────────────────────────
   * A stroked ring around each moving dot keeps it legible over busy
   * basemaps. These map onto the ScatterplotLayer outline props; `head*`
   * names mirror the layer's `head*` fill vocabulary. */

  /**
   * Draw an outline ring around each head — ScatterplotLayer `stroked`
   * pass-through (was hardcoded `false`). @default false
   */
  headStroked?: boolean;
  /**
   * Fill the head disk — ScatterplotLayer `filled` pass-through (was
   * hardcoded `true`). Set `false` with `headStroked` for hollow rings.
   * @default true
   */
  headFilled?: boolean;
  /**
   * Outline color (RGBA, 0-255) — forwarded to ScatterplotLayer
   * `getLineColor`. Constant only (the active-only output buffer packs no
   * per-feature stroke column). @default [0, 0, 0, 255]
   */
  headStrokeColor?: Color;
  /**
   * Outline width — forwarded to ScatterplotLayer `getLineWidth`. Constant
   * only; interpreted in {@link lineWidthUnits} and clamped by the pixel
   * bounds below. @default 1
   */
  headStrokeWidth?: number;
  /**
   * Units for {@link headStrokeWidth} — ScatterplotLayer `lineWidthUnits`
   * pass-through. Deck-parity default: world-space meters. @default 'meters'
   */
  lineWidthUnits?: 'pixels' | 'meters' | 'common';
  /**
   * Global multiplier for the outline width — ScatterplotLayer
   * `lineWidthScale` pass-through. @default 1
   */
  lineWidthScale?: number;
  /**
   * Minimum on-screen outline width in pixels — ScatterplotLayer
   * `lineWidthMinPixels` pass-through. @default 0
   */
  lineWidthMinPixels?: number;
  /**
   * Maximum on-screen outline width in pixels — ScatterplotLayer
   * `lineWidthMaxPixels` pass-through. @default unbounded
   */
  lineWidthMaxPixels?: number;
}

/** Complete props accepted by {@link AnimatedTripHeadsLayer}. */
export type AnimatedTripHeadsLayerProps = _AnimatedTripHeadsLayerProps &
  SpatioTemporalLayerProps;

const DEFAULT_HEAD_COLOR: Color = [253, 128, 93, 255];
const DEFAULT_HEAD_STROKE_COLOR: Color = [0, 0, 0, 255];

/** `this.state` key the render caches live under. */
const HEADS_CACHE_SLOT = '_sttTripHeadsCaches';

/** Contents of {@link HEADS_CACHE_SLOT}. */
interface HeadsCaches {
  /** Per-tile prepared data. Pruned to the visible tile set each render. */
  prepared: Map<string, PreparedTile>;
  /** `state.tiles` identity from the previous render (prune-walk skip). */
  tilesRef: Tile[] | null;
}

function freshHeadsCaches(): HeadsCaches {
  return { prepared: new Map(), tilesRef: null };
}

/**
 * Per-tile prepared data. The typed arrays are referenced DIRECTLY from the
 * tile's BinaryFeatures (zero-copy); only the synthesized vertex-time fallback
 * allocates, and it is cached here so it never re-runs per frame.
 */
interface PreparedTile {
  tileKey: string;
  /** Interleaved lon/lat(/alt), Float64 — zero-copy from the Arrow buffer. */
  positions: Float64Array;
  startIndices: Uint32Array;
  /** Per-feature [start,end], RELATIVE to `timeOffset`. */
  startTimes: Float32Array;
  endTimes: Float32Array;
  /** Per-vertex times, RELATIVE to `timeOffset` (real OSRM or synthesized). */
  vertexTimes: Float32Array;
  /** Per-vertex gradient scalar (zero-copy from the tile), or null if absent. */
  vertexValues: Float32Array | null;
  /**
   * Per-FEATURE elevation in metres (RAW column value, or mapped category —
   * NOT yet scaled by `elevationScale`, which is applied per active dot so a
   * scale change needs no cache invalidation), or null when no elevation
   * column is configured / present on this tile.
   */
  featureElevations: Float64Array | null;
  /** 2 or 3 — stride of the source `positions` buffer. */
  dims: number;
  featureCount: number;
  timeOffset: number;
  tile: Tile;
  features: BinaryFeatures;

  /* ── Per-frame scratch, POOLED on the tile ──────────────────────────────
   * `renderLayers` runs at frame rate here (`_handleTimeUpdate` setStates
   * every tick, because the dot position is a CPU-computed attribute rather
   * than a shader uniform). Allocating these per tile per FRAME — a
   * `Float64Array(featureCount * 3)` sized to ALL features plus an optional
   * gradient scalar array and RGBA buffer — put ~19 MB/frame of Float64 on the
   * heap at 40 tiles × 20k features, i.e. a major GC every few seconds. They
   * are per-tile and fully overwritten every frame, so one allocation per
   * tile-load serves every frame; `computeHeads` hands back `subarray`s sized
   * to the ACTIVE dot count so only that much is converted + uploaded. */

  /** Interleaved lon/lat/alt output, capacity `featureCount * 3`. */
  headPositions: Float64Array | null;
  /** Per-active-dot gradient scalar, capacity `featureCount`. */
  headValues: Float32Array | null;
  /** Per-active-dot RGBA, capacity `featureCount * 4` (grown to fit). */
  headColors: Uint8Array | null;
}

/**
 * Cache key for one (tile, layer) pair: core's canonical {@link tileLayerKey}
 * under an archive qualifier.
 *
 * `archiveKey` (the archive URL) is part of the key because a `data` swap keeps
 * the SAME layer instance and z/x/y/t collisions across archives are the common
 * case. This layer is the more dangerous of the two: `prepareTile` has no style
 * key at all, so nothing else could ever dislodge a stale entry. The tile half
 * is never spelled here: it carries the temporal-LOD tier only because core's
 * producer folds it in.
 */
function makeTileKey(tile: Tile, layer: TileLayer, archiveKey: string): string {
  return `${archiveKey}|${tileLayerKey(tile.id, layer.name)}`;
}

/**
 * Resolve a PER-FEATURE elevation (RAW metres, pre-scale) for every feature in
 * a tile from an elevation column, mirroring the path layer's resolver: a
 * CATEGORICAL column maps each feature's category through `mapping` (absent →
 * 0); a NUMERIC column uses the value directly. Returns null when the column
 * is absent (or categorical with no mapping) — the caller leaves the tile flat.
 */
function resolveFeatureElevations(
  binary: BinaryFeatures,
  prop: string,
  mapping: Record<string, number> | null | undefined,
): Float64Array | null {
  const count = binary.featureCount;
  const cat = binary.categoricalProps[prop];
  if (cat && mapping) {
    const out = new Float64Array(count);
    for (let f = 0; f < count; f++) {
      out[f] = mapping[cat.categories[cat.indices[f]]] ?? 0;
    }
    return out;
  }
  const num = binary.numericProps[prop];
  if (num) {
    const out = new Float64Array(count);
    for (let f = 0; f < count; f++) out[f] = num[f];
    return out;
  }
  return null;
}

/**
 * Smooth moving head-dot layer for trip/trajectory archives.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`heads`**.
 */
export class AnimatedTripHeadsLayer<
  ExtraPropsT extends {} = {},
> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_AnimatedTripHeadsLayerProps>
> {
  static layerName = 'AnimatedTripHeadsLayer';

  static defaultProps: DefaultProps<AnimatedTripHeadsLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    headColor: { type: 'color', value: DEFAULT_HEAD_COLOR },
    gradientProperty: { type: 'object', value: null, optional: true },
    gradientDomain: { type: 'array', value: [0, 1], compare: true },
    gradientColorRamp: { type: 'array', value: [], compare: true },
    sizeUnits: 'pixels',
    headRadiusPixels: { type: 'number', value: 4, min: 0 },
    headRadius: { type: 'number', value: 0, min: 0 },
    headRadiusMinPixels: { type: 'number', value: 0, min: 0 },
    headRadiusMaxPixels: { type: 'number', value: 1e9, min: 0 },
    radiusScale: { type: 'number', value: 1, min: 0 },
    headBillboard: false,
    antialiasing: true,
    // Per-feature elevation (unset ⇒ flat, z stays 0 / the archive's own z).
    elevationProperty: { type: 'object', value: null, optional: true },
    elevationMapping: {
      type: 'object',
      value: null,
      optional: true,
      compare: false,
    },
    elevationScale: { type: 'number', value: 1 },
    // Outline subsystem — ScatterplotLayer defaults (stroked off, filled on).
    headStroked: false,
    headFilled: true,
    headStrokeColor: { type: 'color', value: [0, 0, 0, 255] },
    headStrokeWidth: { type: 'number', value: 1, min: 0 },
    lineWidthUnits: 'meters',
    lineWidthScale: { type: 'number', value: 1, min: 0 },
    lineWidthMinPixels: { type: 'number', value: 0, min: 0 },
    lineWidthMaxPixels: {
      type: 'number',
      value: Number.MAX_SAFE_INTEGER,
      min: 0,
    },
  };

  /**
   * Render caches, held on `this.state` rather than in class FIELDS: deck's
   * `_transferState` moves `state`/`internalState` to the new layer instance
   * but re-runs field initializers, so a field-held cache is discarded the
   * moment an app hands deck a freshly-constructed layer (an unmemoized
   * `new AnimatedTripHeadsLayer({...})` inside a React render). That threw away
   * every prepared tile — including the pooled per-frame buffers above.
   *
   * Slots built before deck installed `state` (the `Object.create(...)` unit
   * harnesses never create one) are adopted the moment a state exists — see
   * {@link SpatioTemporalLayer.stateSlot}, the chassis mechanism this rides.
   */
  private get caches(): HeadsCaches {
    return this.stateSlot(HEADS_CACHE_SLOT, freshHeadsCaches);
  }

  /** Per-tile prepared-data cache. Pruned to the visible tile set each render. */
  private get preparedTileCache(): Map<string, PreparedTile> {
    return this.caches.prepared;
  }
  private set preparedTileCache(value: Map<string, PreparedTile>) {
    this.caches.prepared = value;
  }

  /** Tile-array identity from the previous render — skip the prune walk when
   * the parent hands back the same `state.tiles` reference. */
  private get lastTilesRef(): Tile[] | null {
    return this.caches.tilesRef;
  }
  private set lastTilesRef(value: Tile[] | null) {
    this.caches.tilesRef = value;
  }

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.preparedTileCache.clear();
    this.lastTilesRef = null;
  }

  /**
   * Identity of the archive the visible tiles came from — folded into every
   * tile cache key (see {@link makeTileKey}). A `data` swap keeps this layer
   * INSTANCE, so without it the new archive can hit the previous one's cached
   * `Float64Array`s on any repeated `z/x/y/t`.
   */
  private archiveKey(): string {
    const state = this.state as
      | { archive?: { url?: string } | null; initializingUrl?: string | null }
      | undefined
      | null;
    const url = state?.archive?.url ?? state?.initializingUrl;
    if (typeof url === 'string') return url;
    const data = (this.props as { data?: unknown }).data;
    return typeof data === 'string' ? data : '';
  }

  /**
   * Force a renderLayers() pass every frame so the CPU-interpolated head
   * positions advance. The base class is redraw-only on time (its layers
   * animate via a shader uniform); ours animates via a position attribute that
   * only renderLayers() recomputes — so mirror FlowCorridorLayer and bump a
   * state counter. `super()` keeps `_currentTime` live and the tileset throttle
   * intact; the extra setState is a no-op when nothing is visible.
   */
  protected _handleTimeUpdate(time: number): void {
    super._handleTimeUpdate(time);
    const { tiles } = this.state;
    if (tiles && tiles.length > 0) {
      this.setState({ headFrame: ((this.state as any).headFrame || 0) + 1 });
    }
  }

  private prepareTile(
    tile: Tile,
    tileLayer: TileLayer,
    archiveKey: string = this.archiveKey(),
  ): PreparedTile | null {
    const binary = tileLayer.features;
    // An empty tile is normal and silent; a MISMATCHED one should say so.
    if (binary.featureCount === 0) return null;
    // LineString semantics are load-bearing: `startIndices` delimits each
    // trip's vertex RUN, and `computeHeads` binary-searches inside it. A point
    // tile would emit one dot per "trip" pinned to an arbitrary vertex. Checked
    // BEFORE `startIndices` so the diagnostic fires instead of a bare `null`.
    if (
      !expectGeometry(
        binary.geometryType,
        LINESTRING_ONLY,
        this.props.id ??
          (this.constructor as { layerName?: string }).layerName ??
          'AnimatedTripHeadsLayer',
        tileLayer.name,
      )
    ) {
      return null;
    }
    if (!binary.startIndices) return null;

    const tileKey = makeTileKey(tile, tileLayer, archiveKey);
    const cached = this.preparedTileCache.get(tileKey);
    if (cached) return cached;

    const probe = isProbeEnabled();
    const t0 = probe ? performance.now() : 0;
    const dims = binary.positionDimensions ?? 2;
    const totalVerts = binary.startIndices[binary.featureCount];
    // Prefer the tile's own per-vertex times (zero-copy); synthesize otherwise.
    const vertexTimes: Float32Array =
      binary.vertexTimestamps && binary.vertexTimestamps.length >= totalVerts
        ? binary.vertexTimestamps
        : synthesizeVertexTimes(binary);

    const prepared: PreparedTile = {
      tileKey,
      positions: binary.positions,
      startIndices: binary.startIndices,
      startTimes: binary.startTimes,
      endTimes: binary.endTimes,
      vertexTimes,
      // Per-vertex gradient scalar (e.g. 500 mb temperature) — zero-copy; only
      // referenced when a gradient is configured and long enough to cover the tile.
      vertexValues:
        binary.vertexValues && binary.vertexValues.length >= totalVerts
          ? binary.vertexValues
          : null,
      // Per-feature elevation column (e.g. a wind particle's pressure-level
      // height) — resolved once per tile. `elevationProperty` is treated as a
      // build-time constant, like the gradient channel; a runtime change on the
      // same layer instance would not re-resolve cached tiles (not a usage we
      // support). Null (no column configured) short-circuits before the lookup.
      featureElevations:
        typeof this.props.elevationProperty === 'string'
          ? resolveFeatureElevations(
              binary,
              this.props.elevationProperty,
              this.props.elevationMapping,
            )
          : null,
      dims,
      featureCount: binary.featureCount,
      timeOffset: binary.timeOffset,
      tile,
      features: binary,
      // Per-frame scratch, allocated lazily on the first frame that needs it.
      headPositions: null,
      headValues: null,
      headColors: null,
    };
    this.preparedTileCache.set(tileKey, prepared);
    if (probe) {
      emit('tilePrepare', {
        layer: 'AnimatedTripHeadsLayer',
        tileKey,
        cached: false,
        features: binary.featureCount,
        ms: performance.now() - t0,
      });
    }
    return prepared;
  }

  /**
   * Interpolate the head position for every trip active at `relTime` (relative
   * to the tile timeOffset). Inactive trips simply aren't emitted — visibility
   * is implicit: a trip's dot pops in at its start and out at its end (no fade).
   *
   * Output positions are size-3 (lon, lat, alt|0) Float64 — what ScatterplotLayer
   * wants for its fp64 instancePositions split (so no high-zoom jitter).
   *
   * Both output buffers are POOLED on the PreparedTile (this runs every frame,
   * per tile) and returned as `subarray`s trimmed to the ACTIVE dot count, so
   * only the live dots are fp64-split and uploaded. The subarray is a fresh
   * view each frame — which is exactly what deck needs to see, since
   * `Attribute.setExternalBuffer` short-circuits on wrapper identity.
   */
  private computeHeads(
    p: PreparedTile,
    relTime: number,
    wantValues: boolean,
    elevScale: number,
  ): { positions: Float64Array; values: Float32Array | null; count: number } {
    const {
      positions,
      startIndices,
      startTimes,
      endTimes,
      vertexTimes,
      vertexValues,
      featureElevations,
      dims,
      featureCount,
    } = p;
    // Capacity = all trips active; the returned `count` trims the draw.
    let out = p.headPositions;
    if (!out || out.length < featureCount * 3) {
      out = new Float64Array(featureCount * 3);
      p.headPositions = out;
    }
    // Per-dot gradient scalar, in the SAME active-only order as `out` — only
    // allocated when a gradient is configured AND this tile carries the channel.
    const gradient = wantValues && vertexValues ? vertexValues : null;
    let values: Float32Array | null = null;
    if (gradient) {
      values = p.headValues;
      if (!values || values.length < featureCount) {
        values = new Float32Array(featureCount);
        p.headValues = values;
      }
    }
    let n = 0;

    for (let i = 0; i < featureCount; i++) {
      const tStart = startTimes[i];
      const tEnd = endTimes[i];
      if (relTime < tStart || relTime > tEnd) continue; // inactive → no dot

      const v0 = startIndices[i];
      const v1 = startIndices[i + 1];
      const nv = v1 - v0;
      let lon: number;
      let lat: number;
      let alt = 0;
      let val = NaN;

      if (nv <= 1) {
        const b = v0 * dims;
        lon = positions[b] ?? 0;
        lat = positions[b + 1] ?? 0;
        if (dims > 2) alt = positions[b + 2] ?? 0;
        if (gradient) val = gradient[v0];
      } else {
        // Binary-search the segment whose [vt[lo], vt[hi]] brackets relTime
        // (vertexTimes is monotonic non-decreasing within a trip).
        let lo = 0;
        let hi = nv - 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (vertexTimes[v0 + mid] <= relTime) lo = mid;
          else hi = mid;
        }
        const ta = vertexTimes[v0 + lo];
        const tb = vertexTimes[v0 + hi];
        const denom = tb - ta;
        const frac =
          denom > 0 ? Math.min(1, Math.max(0, (relTime - ta) / denom)) : 0;
        const a = (v0 + lo) * dims;
        const b = (v0 + hi) * dims;
        const g = 1 - frac;
        lon = positions[a] * g + positions[b] * frac;
        lat = positions[a + 1] * g + positions[b + 1] * frac;
        if (dims > 2) alt = positions[a + 2] * g + positions[b + 2] * frac;
        if (gradient) {
          // Interpolate the scalar the same way as position; if one endpoint is
          // NaN (e.g. a seed vertex), fall back to the finite neighbor so a dot
          // never flickers to the fallback color mid-segment.
          const va = gradient[v0 + lo];
          const vb = gradient[v0 + hi];
          val = Number.isNaN(va)
            ? vb
            : Number.isNaN(vb)
              ? va
              : va * g + vb * frac;
        }
      }

      // Per-feature elevation (metres × scale) lifts the whole trip's dot to
      // its level — added ON TOP of any z the geometry already carries.
      if (featureElevations) alt += featureElevations[i] * elevScale;

      const o = n * 3;
      out[o] = lon;
      out[o + 1] = lat;
      out[o + 2] = alt;
      if (values) values[n] = val;
      n++;
    }
    // Trim to the active count so the fp64 split + GPU write are sized to the
    // dots actually drawn, not to every feature in the tile.
    return {
      positions: out.subarray(0, n * 3),
      values: values ? values.subarray(0, n) : null,
      count: n,
    };
  }

  renderLayers(): Layer[] {
    // `emit` no-ops when the probe is off; its payload + performance.now() do not.
    const probe = isProbeEnabled();
    const t0 = probe ? performance.now() : 0;
    const tiles = this.state.tiles as Tile[] | undefined;
    const archiveKey = this.archiveKey();

    // Prune the prepared cache against the live tile set BEFORE the empty-set
    // early return. The chassis deliberately setStates `tiles: []` on archive
    // init to signal "the visible set just collapsed"; returning early there
    // meant this block never re-ran and every entry from the PREVIOUS archive
    // survived — and `prepareTile` here has NO style key, so nothing else could
    // ever dislodge one. (The archive is folded into the key too, so a stale
    // hit is impossible either way.) Otherwise skip the walk when the tile
    // array reference is unchanged (a prop/time-only re-render hands back the
    // same ref, so the live set is identical by construction).
    if (this.lastTilesRef !== (tiles ?? null)) {
      const live = new Set<string>();
      if (tiles) {
        for (const tile of tiles) {
          for (const tileLayer of tile.layers)
            live.add(makeTileKey(tile, tileLayer, archiveKey));
        }
      }
      for (const key of this.preparedTileCache.keys()) {
        if (!live.has(key)) this.preparedTileCache.delete(key);
      }
      this.lastTilesRef = tiles ?? null;
    }

    if (!tiles || tiles.length === 0) return [];

    const absTime = this.getCurrentTime();
    // Anything other than 'pixels' is a WORLD-space unit ('meters', or deck's
    // projection-space 'common'), which reads the radius from `headRadius`.
    const sizeUnits = this.props.sizeUnits ?? 'pixels';
    const sizeInMeters = sizeUnits !== 'pixels';
    const color = (
      Array.isArray(this.props.headColor)
        ? this.props.headColor
        : DEFAULT_HEAD_COLOR
    ) as Color;
    const strokeColor = (
      Array.isArray(this.props.headStrokeColor)
        ? this.props.headStrokeColor
        : DEFAULT_HEAD_STROKE_COLOR
    ) as Color;
    // In world-space mode pass the world radius (headRadius); else the pixel
    // value. The `||` chain is deliberate (headRadius defaults to 0 = unset).
    const radius = sizeInMeters
      ? this.props.headRadius || this.props.headRadiusPixels || 4
      : this.props.headRadiusPixels;

    // Per-vertex gradient coloring (e.g. drift dots shaded by 500 mb temp):
    // active only when a channel is named AND a non-empty ramp is supplied.
    // Currently only the `vertexValues` channel is exposed (mirrors the trips
    // layer). NaN dots fall back to `headColor`.
    const ramp = this.props.gradientColorRamp;
    const useGradient =
      this.props.gradientProperty === 'vertexValues' &&
      Array.isArray(ramp) &&
      ramp.length > 0;
    const gradientDomain = (this.props.gradientDomain ?? [0, 1]) as [
      number,
      number,
    ];
    // Vertical exaggeration applied to each dot's per-feature elevation column.
    const elevScale = this.props.elevationScale ?? 1;

    const sublayers: Layer[] = [];
    // Diagnostics for the probe: how much of the resident set is doing work.
    let skippedTiles = 0;
    let dots = 0;
    let maxLagMs = 0;
    let maxLeadMs = 0;
    // Dots split by the ZOOM they came from. A `best-available` tileset also
    // hands back coarse PARENT tiles, whose trips carry simplified geometry —
    // so a split across zooms says whether the frame is drawing one dot per
    // trip or stacking a parent's stand-in on top of its own children.
    const dotsByZoom: Record<number, number> = {};
    for (const tile of tiles) {
      // A tile can only hold a dot if the playhead lies inside the tile's own
      // [timeStart, timeEnd]. That range is a build-time COVERING bound — the
      // bucket edge below, the max feature `end_timestamp` above (stt-build
      // tiler.rs), so it is a sound superset of every feature's span in the
      // tile — which makes this skip exactly lossless, not a heuristic.
      //
      // It matters because the RESIDENT set is sized by the loader's time
      // window while only the playhead's bucket ever draws. On a 1-minute-
      // bucket archive under a 1-hour window that is ~60 dead tiles for every
      // live one, and without this we ran the full `computeHeads` scan over
      // every feature of all of them, every frame (measured 3.2 ms/frame at
      // 854 resident tiles on nyc-flow-and-riders).
      const tr = tile.timeRange;
      if (tr && (absTime < tr.start || absTime > tr.end)) {
        skippedTiles++;
        continue;
      }
      for (const tileLayer of tile.layers) {
        const prepared = this.prepareTile(tile, tileLayer, archiveKey);
        if (!prepared) continue;

        const relTime = absTime - prepared.timeOffset;
        const { positions, values, count } = this.computeHeads(
          prepared,
          relTime,
          useGradient,
          elevScale,
        );
        if (count === 0) continue;
        if (probe) {
          dots += count;
          const z = tile.id.z;
          dotsByZoom[z] = (dotsByZoom[z] ?? 0) + count;
          // Where, relative to the playhead, do the tiles that actually DRAW
          // sit? `lag` is how far the playhead has run past a drawing tile's
          // bucket edge — the empirical lower bound on the loader's trailing
          // window, since a trip is bucketed by its START and may run long.
          // `lead` is the forward equivalent. Together they say how narrow the
          // window can safely go on a given archive.
          if (tr) {
            maxLagMs = Math.max(maxLagMs, absTime - tr.start);
            maxLeadMs = Math.max(maxLeadMs, tr.start - absTime);
          }
        }

        // A per-dot gradient color buffer when this tile carries the channel;
        // otherwise the dots use the constant `headColor` below. Re-expanded
        // each frame like the positions (O(active dots)) but into the tile's
        // POOLED buffer, so the frame allocates nothing. The active count
        // changes as trips start/end, so the pool is capacity-grown and the
        // exact-length view is handed to `expandGradientColors`.
        let gradientColors: Uint8Array | null = null;
        if (useGradient && values) {
          const need = count * 4;
          let pool = prepared.headColors;
          if (!pool || pool.length < need) {
            pool = new Uint8Array(prepared.featureCount * 4);
            prepared.headColors = pool;
          }
          gradientColors = expandGradientColors(
            values,
            gradientDomain,
            ramp as Color[],
            count,
            color,
            pool.length === need ? pool : pool.subarray(0, need),
          );
        }

        // Fresh `data` ref every frame (the positions move) — deck.gl matches
        // the ScatterplotLayer by id and re-uploads just the changed buffers.
        const data = {
          length: count,
          attributes: {
            // size 3 (lon, lat, alt) — Float64 drives the fp64 hi/lo split.
            getPosition: { value: positions, size: 3 },
            ...(gradientColors && {
              getFillColor: {
                value: gradientColors,
                size: 4,
                normalized: true,
              },
            }),
          },
        };

        // getSubLayerProps inheritance (opacity/visible/coordinate system,
        // highlight props…) + user `_subLayerProps.heads` overrides.
        const props = this.composeSubLayerProps('heads', prepared.tileKey, {
          data,
          // Picking is disabled: the active-only buffer reorders indices, so a
          // pick would mis-map to a feature. Aligned picking (emit an
          // instanceFeatureIndex) is a follow-up.
          pickable: false,
          getFillColor: color,
          getRadius: radius,
          radiusScale: this.props.radiusScale,
          radiusUnits: sizeUnits,
          radiusMinPixels: this.props.headRadiusMinPixels,
          radiusMaxPixels: this.props.headRadiusMaxPixels,
          billboard: this.props.headBillboard,
          antialiasing: this.props.antialiasing,
          // Outline / contrast-ring (constants — the active-only buffer packs
          // no per-feature stroke column).
          stroked: this.props.headStroked,
          filled: this.props.headFilled,
          getLineColor: strokeColor,
          getLineWidth: this.props.headStrokeWidth,
          lineWidthUnits: this.props.lineWidthUnits,
          lineWidthScale: this.props.lineWidthScale,
          lineWidthMinPixels: this.props.lineWidthMinPixels,
          lineWidthMaxPixels: this.props.lineWidthMaxPixels,
          // Source tile rides along for family parity (picking context).
          tile: prepared.tile,
          sttFeatures: prepared.features,
        });
        const SubLayerClass = this.getSubLayerClass('heads', ScatterplotLayer);
        sublayers.push(new SubLayerClass(props as any));
      }
    }

    if (probe) {
      emit('renderLayers', {
        layer: 'AnimatedTripHeadsLayer',
        tiles: tiles.length,
        skippedTiles,
        sublayers: sublayers.length,
        dots,
        dotsByZoom,
        maxLagMs,
        maxLeadMs,
        ms: performance.now() - t0,
      });
    }
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `AnimatedTripHeadsLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`,
      );
    }
    return sublayers;
  }
}

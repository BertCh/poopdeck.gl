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
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from '../spatiotemporal-layer.js';
import { synthesizeVertexTimes } from './animated-trips-layer.js';
import { emit } from '../../lib/telemetry.js';
import type { Tile, Layer as TileLayer, BinaryFeatures } from '@poopdeck.gl/core';

const DEBUG = false;

/** Props added by {@link AnimatedTripHeadsLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link AnimatedTripHeadsLayerProps}). */
export interface _AnimatedTripHeadsLayerProps {
  /** Head dot color (RGBA, 0-255). @default [253, 128, 93, 255] */
  headColor?: Color;
  /**
   * Units for the head radius. 'pixels' (default) is screen-space; 'meters'
   * makes the dot world-space so it emerges/shrinks with zoom (clamped by the
   * pixel bounds), mirroring the maritime point layer's "render by space" look.
   * @default 'pixels'
   */
  sizeUnits?: 'pixels' | 'meters';
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
  /** 2 or 3 — stride of the source `positions` buffer. */
  dims: number;
  featureCount: number;
  timeOffset: number;
  tile: Tile;
  features: BinaryFeatures;
}

function makeTileKey(tile: Tile, layer: TileLayer): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}:${layer.name}`;
}

/**
 * Smooth moving head-dot layer for trip/trajectory archives.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`heads`**.
 */
export class AnimatedTripHeadsLayer<ExtraPropsT extends {} = {}> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_AnimatedTripHeadsLayerProps>
> {
  static layerName = 'AnimatedTripHeadsLayer';

  static defaultProps: DefaultProps<AnimatedTripHeadsLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    headColor: { type: 'color', value: DEFAULT_HEAD_COLOR },
    sizeUnits: 'pixels',
    headRadiusPixels: { type: 'number', value: 4, min: 0 },
    headRadius: { type: 'number', value: 0, min: 0 },
    headRadiusMinPixels: { type: 'number', value: 0, min: 0 },
    headRadiusMaxPixels: { type: 'number', value: 1e9, min: 0 },
    radiusScale: { type: 'number', value: 1, min: 0 },
    headBillboard: false,
    antialiasing: true,
    // Outline subsystem — ScatterplotLayer defaults (stroked off, filled on).
    headStroked: false,
    headFilled: true,
    headStrokeColor: { type: 'color', value: [0, 0, 0, 255] },
    headStrokeWidth: { type: 'number', value: 1, min: 0 },
    lineWidthUnits: 'meters',
    lineWidthScale: { type: 'number', value: 1, min: 0 },
    lineWidthMinPixels: { type: 'number', value: 0, min: 0 },
    lineWidthMaxPixels: { type: 'number', value: Number.MAX_SAFE_INTEGER, min: 0 },
  };

  /** Per-tile prepared-data cache. Pruned to the visible tile set each render. */
  private preparedTileCache = new Map<string, PreparedTile>();

  /** Tile-array identity from the previous render — skip the prune walk when
   * the parent hands back the same `state.tiles` reference. */
  private lastTilesRef: Tile[] | null = null;

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.preparedTileCache.clear();
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

  private prepareTile(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0 || !binary.startIndices) return null;

    const tileKey = makeTileKey(tile, tileLayer);
    const cached = this.preparedTileCache.get(tileKey);
    if (cached) return cached;

    const t0 = performance.now();
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
      dims,
      featureCount: binary.featureCount,
      timeOffset: binary.timeOffset,
      tile,
      features: binary,
    };
    this.preparedTileCache.set(tileKey, prepared);
    emit('tilePrepare', {
      layer: 'AnimatedTripHeadsLayer',
      tileKey,
      cached: false,
      features: binary.featureCount,
      ms: performance.now() - t0,
    });
    return prepared;
  }

  /**
   * Interpolate the head position for every trip active at `relTime` (relative
   * to the tile timeOffset). Inactive trips simply aren't emitted — visibility
   * is implicit: a trip's dot pops in at its start and out at its end (no fade).
   *
   * Output positions are size-3 (lon, lat, alt|0) Float64 — what ScatterplotLayer
   * wants for its fp64 instancePositions split (so no high-zoom jitter).
   */
  private computeHeads(p: PreparedTile, relTime: number): { positions: Float64Array; count: number } {
    const { positions, startIndices, startTimes, endTimes, vertexTimes, dims, featureCount } = p;
    // Upper bound = all trips active; the returned `count` trims the draw.
    const out = new Float64Array(featureCount * 3);
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

      if (nv <= 1) {
        const b = v0 * dims;
        lon = positions[b] ?? 0;
        lat = positions[b + 1] ?? 0;
        if (dims > 2) alt = positions[b + 2] ?? 0;
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
        const frac = denom > 0 ? Math.min(1, Math.max(0, (relTime - ta) / denom)) : 0;
        const a = (v0 + lo) * dims;
        const b = (v0 + hi) * dims;
        const g = 1 - frac;
        lon = positions[a] * g + positions[b] * frac;
        lat = positions[a + 1] * g + positions[b + 1] * frac;
        if (dims > 2) alt = positions[a + 2] * g + positions[b + 2] * frac;
      }

      const o = n * 3;
      out[o] = lon;
      out[o + 1] = lat;
      out[o + 2] = alt;
      n++;
    }
    return { positions: out, count: n };
  }

  renderLayers(): Layer[] {
    const t0 = performance.now();
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) {
      this.lastTilesRef = null;
      return [];
    }

    // Prune the prepared cache against the live tile set — only when the tile
    // array reference actually changed (a prop/time-only re-render hands back
    // the same ref, so the live set is identical by construction).
    if (this.lastTilesRef !== tiles) {
      const live = new Set<string>();
      for (const tile of tiles) {
        for (const tileLayer of tile.layers) live.add(makeTileKey(tile, tileLayer));
      }
      for (const key of this.preparedTileCache.keys()) {
        if (!live.has(key)) this.preparedTileCache.delete(key);
      }
      this.lastTilesRef = tiles;
    }

    const absTime = this.getCurrentTime();
    const sizeInMeters = this.props.sizeUnits === 'meters';
    const color = (Array.isArray(this.props.headColor)
      ? this.props.headColor
      : DEFAULT_HEAD_COLOR) as Color;
    const strokeColor = (Array.isArray(this.props.headStrokeColor)
      ? this.props.headStrokeColor
      : DEFAULT_HEAD_STROKE_COLOR) as Color;
    // In meters mode pass the meter radius (headRadius); else the pixel value.
    // The `||` chain is deliberate (headRadius defaults to 0 = unset).
    const radius = sizeInMeters
      ? this.props.headRadius || this.props.headRadiusPixels || 4
      : this.props.headRadiusPixels;

    const sublayers: Layer[] = [];
    for (const tile of tiles) {
      for (const tileLayer of tile.layers) {
        const prepared = this.prepareTile(tile, tileLayer);
        if (!prepared) continue;

        const relTime = absTime - prepared.timeOffset;
        const { positions, count } = this.computeHeads(prepared, relTime);
        if (count === 0) continue;

        // Fresh `data` ref every frame (the positions move) — deck.gl matches
        // the ScatterplotLayer by id and re-uploads just the position buffer.
        const data = {
          length: count,
          attributes: {
            // size 3 (lon, lat, alt) — Float64 drives the fp64 hi/lo split.
            getPosition: { value: positions, size: 3 },
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
          radiusUnits: sizeInMeters ? 'meters' : 'pixels',
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

    emit('renderLayers', {
      layer: 'AnimatedTripHeadsLayer',
      tiles: tiles.length,
      sublayers: sublayers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `AnimatedTripHeadsLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`,
      );
    }
    return sublayers;
  }
}

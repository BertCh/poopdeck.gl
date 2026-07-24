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
import {
  SpatioTemporalLayer,
  SpatioTemporalLayerProps,
} from '../spatiotemporal-layer.js';
import {
  synthesizeVertexTimes,
  expandGradientColors,
} from './animated-trips-layer.js';
import { emit } from '../../lib/telemetry.js';
import type {
  Tile,
  Layer as TileLayer,
  BinaryFeatures,
} from '@poopdeck.gl/core';

const DEBUG = false;

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
}

function makeTileKey(tile: Tile, layer: TileLayer): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}:${layer.name}`;
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
    // Upper bound = all trips active; the returned `count` trims the draw.
    const out = new Float64Array(featureCount * 3);
    // Per-dot gradient scalar, in the SAME active-only order as `out` — only
    // allocated when a gradient is configured AND this tile carries the channel.
    const gradient = wantValues && vertexValues ? vertexValues : null;
    const values = gradient ? new Float32Array(featureCount) : null;
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
    return { positions: out, values, count: n };
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
        for (const tileLayer of tile.layers)
          live.add(makeTileKey(tile, tileLayer));
      }
      for (const key of this.preparedTileCache.keys()) {
        if (!live.has(key)) this.preparedTileCache.delete(key);
      }
      this.lastTilesRef = tiles;
    }

    const absTime = this.getCurrentTime();
    const sizeInMeters = this.props.sizeUnits === 'meters';
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
    // In meters mode pass the meter radius (headRadius); else the pixel value.
    // The `||` chain is deliberate (headRadius defaults to 0 = unset).
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
    for (const tile of tiles) {
      for (const tileLayer of tile.layers) {
        const prepared = this.prepareTile(tile, tileLayer);
        if (!prepared) continue;

        const relTime = absTime - prepared.timeOffset;
        const { positions, values, count } = this.computeHeads(
          prepared,
          relTime,
          useGradient,
          elevScale,
        );
        if (count === 0) continue;

        // A per-dot gradient color buffer when this tile carries the channel;
        // otherwise the dots use the constant `headColor` below. Built each
        // frame like the positions — O(active dots), trivial at showcase scale.
        const gradientColors =
          useGradient && values
            ? expandGradientColors(
                values,
                gradientDomain,
                ramp as Color[],
                count,
                color,
              )
            : null;

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

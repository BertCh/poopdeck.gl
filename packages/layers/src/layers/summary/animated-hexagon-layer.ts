/**
 * AnimatedHexagonLayer — RUNTIME hexbin over the raw point tier, built on the
 * CANONICAL deck.gl {@link DeckHexagonLayer} (`@deck.gl/aggregation-layers`).
 *
 * This is the discrete / pickable / extruded analog of the smooth
 * {@link AnimatedHeatmapLayer}: instead of splatting points into a density
 * texture and mapping THAT through a ramp, the canonical HexagonLayer bins
 * every visible point into hexagonal cells AT RUNTIME (on the GPU by default),
 * then colours + extrudes each cell by its aggregated weight — the iconic
 * deck.gl hexagon look.
 *
 * ### Same consolidation as the heatmap
 * The data feed is identical to {@link AnimatedHeatmapLayer}: every visible
 * tile's points are consolidated into ONE binary buffer set via the SHARED
 * {@link buildConsolidatedChannelData} (imported verbatim from
 * `heatmap-layer.ts`) — `{ length, attributes: { getPosition, getWeight,
 * getFilterValue } }`, cached by the visible-tile-set key so it rebuilds only
 * when that set (or the weight config) changes, never per frame. The single
 * consolidated `getWeight` buffer is aliased to BOTH of HexagonLayer's weight
 * accessors (`getColorWeight` + `getElevationWeight`) — one weight column
 * drives both colour and elevation, matching the spec's one-buffer contract.
 * That helper also owns the geometry-kind guard: point tiles bin one entry per
 * feature, LineString tiles bin one per VERTEX (so a trip archive hexbins track
 * density rather than the head of the first few tracks), and polygon tiles are
 * skipped with a named warning instead of mis-read.
 *
 * ### Weight column (accessor-alias convention)
 * Per the divergence philosophy there are no per-feature JS accessors. The
 * weight is a baked property-column NAME resolved through the accessor-alias
 * convention: `getColorWeight` wins, then `getElevationWeight`, then the legacy
 * `weightProperty`. A function-valued alias warns once and falls back. Unset →
 * every point weighs 1 (a pure COUNT hexbin).
 *
 * ### Time animation — DataFilterExtension + per-window re-bind
 * Each point carries a relativized start time as `getFilterValue`, and the
 * sublayer's `filterRange` (the window around the play head) is recomputed each
 * render. Unlike the LEGACY heatmap aggregator, deck 9.3's HexagonLayer bins via
 * a WebGLAggregator whose `preDraw()` bails unless an aggregation-INPUT attribute
 * is invalidated — a fresh `filterRange` prop alone never re-runs the bin sorter
 * (it is delivered as a shader uniform, not an attribute). So the `data` handed
 * to the sublayer wraps the cached consolidated buffers in FRESH attribute
 * wrappers whenever the window center moves (see {@link _windowData}): the
 * re-bound weight buffers trigger `HexagonLayer.onAttributeChange('colorWeights'
 * /'elevationWeights')` → `aggregator.setNeedsUpdate(0|1)` → the bin sorter
 * re-runs reading the current `filterRange` uniform, so out-of-window points
 * collapse and cells genuinely appear / disappear / re-colour as the window
 * slides. `_handleTimeUpdate` forces a throttled `setState` so `renderLayers()`
 * actually re-runs (and re-wraps) while the play head advances.
 *
 * The DataFilterExtension is a GPU-shader construct, so the time window ONLY
 * works on the GPU aggregation path; `gpuAggregation` is forced true (with a
 * one-time warning) because HexagonLayer's CPU aggregator ignores the filter.
 *
 * f32 time precision: both the per-point filter value AND `filterRange` are
 * relativized against a single `layerTimeOffset` (the first visible tile's
 * offset) so both sides of the shader comparison stay inside f32's mantissa —
 * the same scheme every animated STT layer uses.
 */

import { HexagonLayer as DeckHexagonLayer } from '@deck.gl/aggregation-layers';
import { DataFilterExtension } from '@deck.gl/extensions';
import type {
  Color,
  DefaultProps,
  Layer as DeckLayer,
  LayerContext,
  Material,
  UpdateParameters,
} from '@deck.gl/core';
import {
  SpatioTemporalLayer,
  type SpatioTemporalLayerProps,
} from '../spatiotemporal-layer.js';
import { updateTriggersDigest } from '../../lib/style-digest.js';
import { warnOnce } from '../../lib/log.js';
import { resolveAccessorAlias } from '../../lib/accessor-alias.js';
import type { WeightAccessorValue } from '../../lib/accessor-alias.js';
import { buildConsolidatedChannelData } from './heatmap-layer.js';
import type { Tile } from '@poopdeck.gl/core';

/**
 * deck.gl aggregation operation vocabulary — pass-through of
 * `AggregationOperation` from `@deck.gl/aggregation-layers`.
 */
export type HexagonAggregationType = 'SUM' | 'MEAN' | 'MIN' | 'MAX' | 'COUNT';

/**
 * Default cell colour ramp — colorbrewer 6-class YlOrRd, matching the
 * canonical deck.gl HexagonLayer default (low → high aggregated weight).
 */
const DEFAULT_COLOR_RANGE: Color[] = [
  [255, 255, 178],
  [254, 217, 118],
  [254, 178, 76],
  [253, 141, 60],
  [240, 59, 32],
  [189, 0, 38],
];

/** Re-aggregation cadence cap (Hz). filterRange is pushed at most this often. */
const FILTER_UPDATE_HZ = 30;

/** Props added by {@link AnimatedHexagonLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link AnimatedHexagonLayerProps}). */
export interface _AnimatedHexagonLayerProps {
  /** Radius of a hexagon bin, in meters. @default 1000 */
  radius?: number;
  /** Cell size multiplier, clamped 0–1. @default 1 */
  coverage?: number;
  /**
   * Whether to extrude cells by their aggregated weight.
   *
   * DELIBERATE DEFAULT DRIFT: `true` here vs deck's `HexagonLayer` default of
   * `false`. The extruded 3-D hexbin is this layer's whole reason to exist next
   * to {@link AnimatedHeatmapLayer} (which is the flat-density answer), so the
   * iconic look is the out-of-box one. Pass `extruded: false` for deck parity.
   * @default true
   */
  extruded?: boolean;
  /** Cell elevation multiplier. @default 1 */
  elevationScale?: number;
  /** Elevation scale output range. @default [0, 1000] */
  elevationRange?: [number, number];
  /** Cell colour ramp (low → high aggregated weight). @default 6-class YlOrRd */
  colorRange?: Color[];
  /**
   * Pinned colour scale domain. `null` (default) → the canonical layer auto-
   * ranges against the current window's aggregated weights.
   */
  colorDomain?: [number, number] | null;
  /**
   * Pinned elevation scale input domain. `null` (default) → auto-range against
   * the current window's aggregated weights.
   */
  elevationDomain?: [number, number] | null;
  /** Colour scale function. @default 'quantize' */
  colorScaleType?: 'quantize' | 'linear' | 'quantile' | 'ordinal';
  /** Elevation scale function. @default 'linear' */
  elevationScaleType?: 'linear' | 'quantile';
  /** Hide cells above this colour percentile (0–100). @default 100 */
  upperPercentile?: number;
  /** Hide cells below this colour percentile (0–100). @default 0 */
  lowerPercentile?: number;
  /** Hide cells above this elevation percentile (0–100). @default 100 */
  elevationUpperPercentile?: number;
  /** Hide cells below this elevation percentile (0–100). @default 0 */
  elevationLowerPercentile?: number;
  /** Lighting material (applies when `extruded`). @default true */
  material?: Material | boolean;
  /**
   * Aggregation operation used for BOTH colour and elevation unless a specific
   * {@link colorAggregation} / {@link elevationAggregation} overrides it.
   * @default 'SUM'
   */
  hexagonAggregation?: HexagonAggregationType;
  /**
   * Colour aggregation operation. `null` (default) → inherit
   * {@link hexagonAggregation}.
   */
  colorAggregation?: HexagonAggregationType | null;
  /**
   * Elevation aggregation operation. `null` (default) → inherit
   * {@link hexagonAggregation}.
   */
  elevationAggregation?: HexagonAggregationType | null;
  /** Perform binning on the GPU when possible. @default true */
  gpuAggregation?: boolean;
  /**
   * Upstream-vocabulary alias for the colour weight column. Accepts a
   * property-column NAME (not a function — binary tiles can't run per-feature
   * JS; a function warns once and falls back). Wins over
   * {@link getElevationWeight} and {@link weightProperty}.
   */
  getColorWeight?: WeightAccessorValue | null;
  /**
   * Upstream-vocabulary alias for the elevation weight column (property-column
   * NAME). Used when {@link getColorWeight} is unset.
   */
  getElevationWeight?: WeightAccessorValue | null;
  /**
   * Legacy per-feature weight column name; null (default) weights every point
   * 1.0 (a pure COUNT hexbin). {@link getColorWeight} / {@link getElevationWeight}
   * win over it.
   */
  weightProperty?: string | null;

  /**
   * Fired with the auto-ranged `[min, max]` colour domain every time the
   * aggregator recomputes it — HexagonLayer pass-through. The only way to build
   * a legend for the DEFAULT (`colorDomain: null`) auto-ranging mode, since the
   * domain is derived on the GPU from whatever is inside the current time
   * window and is not otherwise observable.
   */
  onSetColorDomain?: ((domain: [number, number]) => void) | null;

  /**
   * Fired with the auto-ranged `[min, max]` elevation domain — the elevation
   * twin of {@link onSetColorDomain}. HexagonLayer pass-through.
   */
  onSetElevationDomain?: ((domain: [number, number]) => void) | null;

  /* NOT SURFACED (deliberate): upstream's `hexagonAggregator`, `getColorValue`
   * and `getElevationValue` are CPU-aggregation-only hooks — `HexagonLayer`
   * routes them through its CPUAggregator, and this layer forces
   * `gpuAggregation: true` because the DataFilterExtension that carries the time
   * window is a GPU-shader construct the CPU aggregator never reads. Forwarding
   * them would present props that either do nothing or silently disable the
   * animation. Use `getColorWeight`/`getElevationWeight` + `colorAggregation`/
   * `elevationAggregation` instead, which the GPU aggregator does honour. */
}

/** Complete props accepted by {@link AnimatedHexagonLayer}. */
export type AnimatedHexagonLayerProps = _AnimatedHexagonLayerProps &
  SpatioTemporalLayerProps;

/** Binary `data: { length, attributes }` payload fed to the HexagonLayer. */
interface HexagonData {
  length: number;
  attributes: {
    getPosition: { value: Float64Array; size: 3 };
    getColorWeight: { value: Float32Array; size: 1 };
    getElevationWeight: { value: Float32Array; size: 1 };
    getFilterValue: { value: Float32Array; size: 1 };
  };
}

// Upstream idiom: a module-level const typed `DefaultProps<XxxLayerProps>`
// assigned to the static — the named annotation keeps the emitted .d.ts
// portable (no inference into transitive-dep types). Every own prop carries a
// concrete default (no undefined-shadowing — see test/undefined-props.test.ts).
const defaultProps: DefaultProps<AnimatedHexagonLayerProps> = {
  ...SpatioTemporalLayer.defaultProps,
  radius: { type: 'number', value: 1000, min: 1 },
  coverage: { type: 'number', value: 1, min: 0, max: 1 },
  extruded: true,
  elevationScale: { type: 'number', value: 1, min: 0 },
  elevationRange: { type: 'array', value: [0, 1000], compare: true },
  colorRange: { type: 'array', value: DEFAULT_COLOR_RANGE, compare: true },
  colorDomain: { type: 'array', value: null, optional: true, compare: true },
  elevationDomain: {
    type: 'array',
    value: null,
    optional: true,
    compare: true,
  },
  colorScaleType: 'quantize',
  elevationScaleType: 'linear',
  upperPercentile: { type: 'number', value: 100, min: 0, max: 100 },
  lowerPercentile: { type: 'number', value: 0, min: 0, max: 100 },
  elevationUpperPercentile: { type: 'number', value: 100, min: 0, max: 100 },
  elevationLowerPercentile: { type: 'number', value: 0, min: 0, max: 100 },
  // Permissive descriptor, matching every other layer in the package (and
  // SolidPolygonLayer upstream): a bare `true` parses as `{type: 'boolean'}`,
  // whose comparator is `Boolean(a) === Boolean(b)` — so swapping one material
  // SPEC OBJECT for another diffs as unchanged and lighting never updates.
  material: { type: 'object', value: true, compare: true },
  hexagonAggregation: 'SUM',
  colorAggregation: {
    type: 'object',
    value: null,
    optional: true,
    compare: true,
  },
  elevationAggregation: {
    type: 'object',
    value: null,
    optional: true,
    compare: true,
  },
  gpuAggregation: true,
  getColorWeight: {
    type: 'object',
    value: null,
    optional: true,
    compare: true,
  },
  getElevationWeight: {
    type: 'object',
    value: null,
    optional: true,
    compare: true,
  },
  weightProperty: {
    type: 'object',
    value: null,
    optional: true,
    compare: true,
  },
  onSetColorDomain: { type: 'function', value: null, optional: true },
  onSetElevationDomain: { type: 'function', value: null, optional: true },
};

/**
 * Animated runtime hexbin composite over the canonical deck.gl HexagonLayer.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`hexbin`**.
 * `_subLayerProps: { hexbin: { type, ...props } }` swaps the sublayer class /
 * overrides sublayer props (deck's CompositeLayer contract).
 */
export class AnimatedHexagonLayer<
  ExtraPropsT extends {} = {},
> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_AnimatedHexagonLayerProps>
> {
  static layerName = 'AnimatedHexagonLayer';

  static defaultProps = defaultProps;

  /** Shared filter extension across the sublayer. */
  private _dataFilter = new DataFilterExtension({ filterSize: 1 });

  /** Consolidated binary buffers, keyed for cache reuse across renders. */
  private _cache: { key: string; data: HexagonData } | null = null;

  /**
   * Per-WINDOW `data` wrapper (fresh attribute wrappers over the cached
   * consolidated buffers). Keyed by (tile set + window center) so a sliding
   * window hands the aggregator a re-bindable input — see {@link _windowData}.
   */
  private _windowCache: { key: string; data: HexagonData } | null = null;

  /** Wall-clock floor for the filterRange (re-aggregation) cadence. */
  private _lastFilterUpdateWall = 0;

  finalizeState(context: LayerContext): void {
    this._cache = null;
    this._windowCache = null;
    super.finalizeState(context);
  }

  updateState(params: UpdateParameters<this>): void {
    super.updateState(params);
    // A weight-config change invalidates the consolidated buffers.
    const { props, oldProps } = params;
    if (
      props.weightProperty !== oldProps.weightProperty ||
      props.getColorWeight !== oldProps.getColorWeight ||
      props.getElevationWeight !== oldProps.getElevationWeight
    ) {
      this._cache = null;
      // The window wrapper references the consolidated arrays — drop it too so a
      // stale wrapper over the old buffers can't survive a weight-config change.
      this._windowCache = null;
    }
  }

  /**
   * Resolve the single weight column driving both colour and elevation.
   * `getColorWeight` wins, then `getElevationWeight`, then the legacy
   * `weightProperty`. Function-valued aliases warn once and fall back.
   * Column-name semantics only.
   */
  private weightColumn(): string | undefined {
    const legacy = this.props.weightProperty ?? null;
    const color = resolveAccessorAlias(
      'AnimatedHexagonLayer',
      'getColorWeight',
      this.props.getColorWeight as string | undefined,
      legacy,
    );
    const elevation = resolveAccessorAlias(
      'AnimatedHexagonLayer',
      'getElevationWeight',
      this.props.getElevationWeight as string | undefined,
      legacy,
    );
    return color ?? elevation ?? undefined;
  }

  /**
   * Override the base tick handler: the canonical sublayer's time window is a
   * `filterRange` PROP on an aggregation layer, which only re-aggregates when
   * `renderLayers()` re-runs — so we force a throttled `setState` (the base
   * only calls `setNeedsRedraw()` for time-only ticks, which would freeze the
   * window). super() keeps `_currentTime` live and throttles tile loading; we
   * add an independent ~30 Hz cadence for the re-aggregate. (Identical to
   * {@link AnimatedHeatmapLayer}.)
   */
  protected _handleTimeUpdate(time: number): void {
    super._handleTimeUpdate(time);
    const intervalMs = 1000 / FILTER_UPDATE_HZ;
    const nowWall =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (nowWall - this._lastFilterUpdateWall >= intervalMs) {
      this._lastFilterUpdateWall = nowWall;
      // setState (not setNeedsRedraw) is what re-runs renderLayers() and thus
      // pushes a fresh filterRange into the aggregation sublayer.
      this.setState({ frameNumber: (this.state.frameNumber || 0) + 1 });
    }
  }

  renderLayers(): DeckLayer[] {
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) return [];

    const layerTimeOffset = pickLayerTimeOffset(tiles);
    const tileSetKey = tiles.map(tileKey).sort().join('|');

    const consolidated = this._getConsolidatedData(
      tiles,
      tileSetKey,
      layerTimeOffset,
    );
    if (!consolidated || consolidated.length === 0) return [];

    // Time window, relativized against the layer offset so it sits in the same
    // small-number f32 space as the per-point filter values.
    const time = this.getCurrentTime();
    // `Required<>`-typed: the defaultProps value guarantees a number here.
    const halfWindow = this.props.timeWindow / 2;
    const center = time - layerTimeOffset;
    const filterRange: [number, number] = [
      center - halfWindow,
      center + halfWindow,
    ];

    // The `data` fed to the sublayer wraps the cached consolidated buffers in
    // FRESH attribute wrappers whenever the window moves. A fresh `filterRange`
    // prop ALONE does NOT re-run deck 9.3's HexagonLayer aggregator — its
    // WebGLAggregator.preDraw() bails unless an aggregation-input attribute is
    // invalidated, and a stable binary wrapper is short-circuited by
    // Attribute.setBinaryValue. Re-binding the weight buffers each window →
    // HexagonLayer.onAttributeChange('colorWeights'/'elevationWeights') →
    // aggregator.setNeedsUpdate(0|1) → the bin sorter re-runs reading the fresh
    // filterRange uniform, so cells genuinely appear/disappear as the play head
    // sweeps a fixed tile set.
    const data = this._windowData(consolidated, tileSetKey, center);

    // hexagonAggregation is the shared default; a specific color/elevation
    // aggregation overrides it when set.
    const colorAggregation =
      this.props.colorAggregation ?? this.props.hexagonAggregation;
    const elevationAggregation =
      this.props.elevationAggregation ?? this.props.hexagonAggregation;

    // Time animation rides the DataFilterExtension, which is a GPU-shader-only
    // construct: HexagonLayer's CPU aggregator never reads filterValues/
    // filterRange, so on the CPU path the time window is silently ignored (every
    // point is binned at every play head). Force GPU aggregation and warn once
    // when a caller disables it. (A device that lacks float-texture support still
    // falls back to CPU inside HexagonLayer regardless — the warning covers that.)
    let gpuAggregation = this.props.gpuAggregation;
    if (gpuAggregation === false) {
      warnOnce(
        'AnimatedHexagonLayer:cpuAggregation',
        '[AnimatedHexagonLayer] time animation requires GPU aggregation — the ' +
          'DataFilterExtension is GPU-only and the CPU aggregator ignores the ' +
          'time window (it would bin the whole dataset at once). Forcing ' +
          '`gpuAggregation: true`. Devices without float-texture support still ' +
          'fall back to CPU inside HexagonLayer, where the window has no effect.',
      );
      gpuAggregation = true;
    }

    // getSubLayerProps inheritance (opacity/pickable/visible, coordinate system,
    // modelMatrix, …) + user `_subLayerProps.hexbin` overrides. `pickable` is
    // deliberately NOT in sublayerProps: anything passed there beats the
    // inherited value (`Object.assign(newProps, sublayerProps, …)`), so forcing
    // it made `new AnimatedHexagonLayer({pickable: false})` still allocate
    // picking colours, run the picking pass on every hover and fire onHover on
    // a 2M-point tile set. Discrete cells DO have identity to pick — pass
    // `pickable: true` to pick them, exactly as with every sibling STT layer.
    // (The heatmap's mirror-image force to `false` stays: density pixels have no
    // feature identity, so there is nothing to opt into.) Fresh props objects
    // per render are inherent to this layer's prop-driven filterRange animation
    // (renderLayers is wall-clock capped via _handleTimeUpdate).
    const subProps = this.composeSubLayerProps('hexbin', 'cells', {
      data,
      radius: this.props.radius,
      coverage: this.props.coverage,
      extruded: this.props.extruded,
      elevationScale: this.props.elevationScale,
      elevationRange: this.props.elevationRange,
      colorRange: this.props.colorRange as any,
      // null → canonical auto-ranging; pinned → stable domain.
      colorDomain: this.props.colorDomain ?? null,
      elevationDomain: this.props.elevationDomain ?? null,
      colorScaleType: this.props.colorScaleType,
      elevationScaleType: this.props.elevationScaleType,
      upperPercentile: this.props.upperPercentile,
      lowerPercentile: this.props.lowerPercentile,
      elevationUpperPercentile: this.props.elevationUpperPercentile,
      elevationLowerPercentile: this.props.elevationLowerPercentile,
      material: this.props.material,
      colorAggregation,
      elevationAggregation,
      gpuAggregation,
      // Auto-ranged domain callbacks — the only handle on the DEFAULT
      // (`colorDomain: null`) domain, which the aggregator derives per window.
      onSetColorDomain: this.props.onSetColorDomain ?? undefined,
      onSetElevationDomain: this.props.onSetElevationDomain ?? undefined,
      // The DataFilterExtension is what animates the hexbin (filterRange); user
      // extensions from the top-level prop are appended.
      extensions: this.composeExtensions([this._dataFilter]),
      filterEnabled: true,
      filterRange,
      // Belt-and-suspenders with the fresh-wrapper re-bind: key the weight
      // accessors' updateTriggers to the window so a moved window is GUARANTEED
      // to invalidate colorWeights/elevationWeights → onAttributeChange →
      // aggregator.setNeedsUpdate, even if a future deck skips the dataChanged
      // attribute walk. (The fresh wrapper is what stops setBinaryValue from
      // short-circuiting the re-bind.)
      //
      // The user's own triggers are SPREAD IN FIRST: getSubLayerProps replaces
      // everything except `all` with what we pass here, so omitting the spread
      // silently dropped `updateTriggers` the caller set (both summary layers
      // spread it — this was the odd one out).
      updateTriggers: {
        ...this.props.updateTriggers,
        getColorWeight: [center, this.props.updateTriggers?.getColorWeight],
        getElevationWeight: [
          center,
          this.props.updateTriggers?.getElevationWeight,
        ],
      },
    });
    // `_subLayerProps: { hexbin: { type } }` swaps the sublayer class.
    const SubLayerClass = this.getSubLayerClass(
      'hexbin',
      DeckHexagonLayer as any,
    );
    return [new SubLayerClass(subProps as any)];
  }

  /**
   * Wrap the cached consolidated buffers in a per-WINDOW `data` object. The
   * heavy consolidation stays cached (its typed arrays are REUSED verbatim);
   * only the outer object + the weight attribute WRAPPER get a fresh identity
   * when the window center changes. That fresh weight wrapper is what forces the
   * GPU aggregator to re-run (deck short-circuits a re-bind of the same binary
   * wrapper) — see the note in {@link renderLayers}. getPosition / getFilterValue
   * wrappers are reused (bins + per-point times don't move with the window).
   */
  private _windowData(
    consolidated: HexagonData,
    tileSetKey: string,
    center: number,
  ): HexagonData {
    const key = `${tileSetKey}::${center}`;
    if (this._windowCache && this._windowCache.key === key)
      return this._windowCache.data;

    const a = consolidated.attributes;
    // One fresh weight wrapper aliased to both channels (one column drives colour
    // + elevation); fresh identity per window → colorWeights/elevationWeights
    // re-bind → aggregator.setNeedsUpdate(0|1).
    const weight = { value: a.getColorWeight.value, size: 1 as const };
    const data: HexagonData = {
      length: consolidated.length,
      attributes: {
        getPosition: a.getPosition,
        getColorWeight: weight,
        getElevationWeight: weight,
        getFilterValue: a.getFilterValue,
      },
    };
    this._windowCache = { key, data };
    return data;
  }

  /**
   * Fetch (or rebuild) the consolidated binary buffers. Reuses the heatmap's
   * {@link buildConsolidatedChannelData} verbatim, then aliases the single
   * `getWeight` buffer to HexagonLayer's `getColorWeight` + `getElevationWeight`
   * accessors.
   */
  private _getConsolidatedData(
    tiles: Tile[],
    tileSetKey: string,
    layerTimeOffset: number,
  ): HexagonData | null {
    const weightProp = this.weightColumn();
    // updateTriggers ride the key so a user trigger bump re-consolidates.
    const key = `${tileSetKey}::${weightProp ?? ''}::${layerTimeOffset}::${updateTriggersDigest(this.props.updateTriggers)}`;

    if (this._cache && this._cache.key === key) return this._cache.data;

    const consolidated = buildConsolidatedChannelData(
      tiles,
      { intensity: 1 },
      weightProp,
      layerTimeOffset,
      this.props.id,
    );
    if (!consolidated) {
      this._cache = null;
      return null;
    }

    // One weight column drives both colour and elevation — alias the single
    // consolidated buffer to both HexagonLayer weight accessors.
    const data: HexagonData = {
      length: consolidated.length,
      attributes: {
        getPosition: consolidated.attributes.getPosition,
        getColorWeight: consolidated.attributes.getWeight,
        getElevationWeight: consolidated.attributes.getWeight,
        getFilterValue: consolidated.attributes.getFilterValue,
      },
    };
    this._cache = { key, data };
    return data;
  }
}

function tileKey(tile: Tile): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}`;
}

function pickLayerTimeOffset(tiles: Tile[]): number {
  for (const tile of tiles) {
    for (const layer of tile.layers) {
      return layer.features.timeOffset;
    }
  }
  return 0;
}

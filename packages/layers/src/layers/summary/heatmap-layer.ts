/**
 * AnimatedHeatmapLayer — animated density heatmap built on CANONICAL deck.gl.
 * (The `Animated` prefix is load-bearing: a bare `HeatmapLayer` export shadows
 * `@deck.gl/aggregation-layers`' layer of that name, which this one wraps.)
 *
 * This is a thin composite over `@deck.gl/aggregation-layers`'
 * {@link DeckHeatmapLayer}, the standard deck.gl heatmap. That layer does the
 * thing a heatmap is supposed to do: it splats every point into a GPU weight
 * texture with ADDITIVE accumulation, reduces to a per-pixel density, and only
 * THEN maps the accumulated density through a colour ramp. Dense regions get
 * hotter because more splats land on the same pixels — true per-pixel density.
 *
 * ### Why not a hand-rolled splat shader
 * A single-pass splat that samples the palette PER SPLAT (each point coloured
 * by its own weight) and additively blends the resulting *colours* sums
 * COLOURS rather than density: overlapping points blow out to white and the
 * result never reads as a heatmap. The ramp has to be applied per PIXEL, after
 * accumulation — which is precisely what deck's splat+accumulate+ramp pipeline
 * does, so this composite delegates to it rather than reimplementing it.
 *
 * ### Time animation
 * The canonical HeatmapLayer has no notion of time. We animate it with
 * `@deck.gl/extensions`' {@link DataFilterExtension}: each point carries a
 * relativized timestamp as `getFilterValue`, and the layer's `filterRange`
 * (the `[start, end]` window around the play head) is recomputed every frame.
 * Out-of-window points collapse to a degenerate vertex during the weights
 * aggregation pass, so they contribute zero density — and crucially, changing
 * `filterRange` RE-RUNS the aggregation (verified against the installed
 * 9.3.2: `filterRange` is not in the aggregation layer's `ignoreProps`, so a
 * changed value flags `dataChanged` → the weights transform re-runs). The
 * result is a genuinely re-aggregated heatmap that animates, not a cross-fade.
 *
 * ### Data feed — consolidated across visible tiles
 * Points from every visible tile are consolidated into ONE binary buffer set
 * per channel (not per-tile sublayers). The canonical layer normalises against
 * a single global max, so there are no per-tile brightness seams, and gaussian
 * splats that straddle a tile border accumulate correctly. The consolidated
 * buffers are cached by visible-tile-set key and rebuilt only when that set (or
 * the channel config) changes — never per frame.
 *
 * COST OF A WINDOW MOVE (measured against the installed 9.3.2, not assumed):
 * `filterRange` is an extension prop, so it is absent from `HeatmapLayer`'s
 * `_propTypes` and therefore absent from the `ignoreProps` that
 * `isAggregationDirty({compareAll: true})` builds — a changed `filterRange`
 * reads as `changeFlags.dataChanged`. The re-aggregation that follows is cheap
 * (the vertex buffers are already resident), but `_updateHeatmapState` also
 * calls `_createWeightsTransform`, which destroys and re-links the whole
 * `TextureTransform` pipeline, forces `_updateBounds(true)`, and rewrites two
 * buffers. Doing that per tick per channel dominated the layer's cost and left
 * `debounceTimeout` dead during playback. So `filterRange` /
 * `filterSoftRange` are memoized by CONTENT here: a tick that lands inside the
 * same window hands back the SAME array reference and the sublayer sees no
 * change at all. Only a window that actually moved pays for the rebuild — and
 * it has to, since that rebuild is what re-runs the aggregation.
 *
 * ### Geometry kinds
 * Point tiles splat one gaussian per feature. LineString tiles splat one per
 * VERTEX (walked through `startIndices`), which is what makes a "density of AIS
 * tracks / flight paths" heatmap read correctly — indexing `positions` by
 * feature index there would have splatted the first N vertices of the first few
 * paths instead. Polygon tiles are rejected by {@link expectGeometry} with a
 * named warning rather than mis-rendered.
 *
 * f32 time precision: absolute epoch-ms (~1.7e12) cannot live in a Float32
 * attribute. Both the per-point filter value AND `filterRange` are relativized
 * against a single `layerTimeOffset` (the first visible tile's offset), so both
 * sides of the shader comparison are small numbers that fit exactly in f32 —
 * the same scheme the TimeFilterExtension uses for point/path/trips layers.
 *
 * ### Two different "domains" — the units contract
 * `colorDomain` (this layer's prop, and `HeatmapChannelSpec.colorDomain`) is a
 * verbatim pass-through of deck's own prop and carries deck's own units: an
 * ACCUMULATED-per-texel figure that `HeatmapLayer._updateWeightmap` further
 * rescales by `metersPerPixel * weightsScale` for `aggregation: 'SUM'`. It is
 * therefore neither a per-feature weight nor zoom-independent — see the prop
 * doc before pinning one.
 *
 * `metadata.heatmapDomain` (baked by `stt-build`'s `compute_heatmap_domain`) is
 * `[min, p95]` of the RAW per-feature weight COLUMN. Those units are not
 * comparable to `colorDomain`'s, and the archive cannot know the accumulated
 * value a texel will reach (that depends on point density, radius and zoom).
 * The archive domain is consequently NOT forwarded as `colorDomain` — doing so
 * put the ramp top orders of magnitude above any real texel, collapsed the map
 * onto the bottom of the ramp, and (because `threshold` is ignored once
 * `colorDomain` is set) removed the alpha cutoff that would have hidden it. It
 * is instead applied where its units ARE valid: as a per-point weight
 * normaliser (see {@link AnimatedHeatmapLayer.archiveWeightScale}).
 */

import { HeatmapLayer as DeckHeatmapLayer } from '@deck.gl/aggregation-layers';
import { DataFilterExtension } from '@deck.gl/extensions';
import type {
  Color,
  DefaultProps,
  Layer as DeckLayer,
  LayerContext,
  UpdateParameters,
} from '@deck.gl/core';
import {
  SpatioTemporalLayer,
  type SpatioTemporalLayerProps,
} from '../spatiotemporal-layer.js';
import { warnOnce } from '../../lib/log.js';
import { updateTriggersDigest } from '../../lib/style-digest.js';
import { resolveAccessorAlias } from '../../lib/accessor-alias.js';
import type { WeightAccessorValue } from '../../lib/accessor-alias.js';
import {
  DEFAULT_HEATMAP_COLOR_RANGE,
  GeometryType,
  tileKey,
} from '@poopdeck.gl/core';
import type { Tile } from '@poopdeck.gl/core';
import { expectGeometry } from '../../lib/geometry-guard.js';

// Shared with the maplibre adapter (single source of truth in
// @poopdeck.gl/core).
const DEFAULT_COLOR_RANGE: Color[] = DEFAULT_HEATMAP_COLOR_RANGE;

/** Max stacked channels — one canonical HeatmapLayer is drawn per channel. */
const MAX_CHANNELS = 4;

/** Re-aggregation cadence cap (Hz). filterRange is pushed at most this often. */
const FILTER_UPDATE_HZ = 30;

/**
 * Per-class spec for a stacked heatmap. Each channel renders as its own
 * canonical HeatmapLayer (its own ramp + density normalisation), composited in
 * order. When `channels` is omitted the layer renders ONE default class from
 * the top-level colorRange/colorDomain props.
 */
export interface HeatmapChannelSpec {
  /** Human-readable id; matches metadata.heatmapDomain.classes[*].id when set. */
  id: string;
  /**
   * Only features whose `categoricalProps[property]` value is in `values`
   * contribute to this channel. Tiles missing the property are skipped
   * FOR THIS CHANNEL.
   */
  categoryFilter?: { property: string; values: string[] };
  /** Per-class color ramp (low → high density). Defaults to OrRd. */
  colorRange?: Color[];
  /**
   * Pinned `[min, max]` ACCUMULATED-density domain, in deck.gl's own
   * `HeatmapLayer.colorDomain` units — see the top-level
   * {@link _AnimatedHeatmapLayerProps.colorDomain} doc for the full units
   * contract. NOT a per-feature weight range, and NOT the archive's
   * `metadata.heatmapDomain` (which is measured in raw weight-column units and
   * is applied as a weight normaliser instead).
   */
  colorDomain?: [number, number];
  /** Per-class weight multiplier folded into each point's accumulation weight. */
  intensity?: number;
}

/** Props added by {@link AnimatedHeatmapLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link AnimatedHeatmapLayerProps}). */
export interface _AnimatedHeatmapLayerProps {
  /**
   * Splat radius in pixels, 1..100 (deck's own clamp).
   *
   * DELIBERATE DEFAULT DRIFT: `30` here vs deck's `50`. STT tiles are dense
   * (a summary-zoom viewport routinely carries 10⁵–10⁶ points), and deck's 50px
   * kernel merges every feature into one blob at those densities. Pass
   * `radiusPixels: 50` for byte-identical deck behaviour.
   * @default 30
   */
  radiusPixels?: number;
  /** Global intensity multiplier (canonical HeatmapLayer `intensity`). */
  intensity?: number;
  /** Per-feature weight property name; null (default) weights every point 1.0. */
  weightProperty?: string | null;
  /**
   * Upstream-vocabulary alias of {@link weightProperty}. NOTE: unlike
   * upstream deck.gl, this accepts a property-column NAME — NOT a function
   * accessor (binary tiles can't run per-feature JS; a function warns once
   * and falls back to `weightProperty`). When set, it wins over
   * `weightProperty`.
   */
  getWeight?: WeightAccessorValue | null;
  /** Color ramp used when `channels` is unset (single-class mode). */
  colorRange?: Color[];
  /**
   * Pinned `[min, max]` ACCUMULATED-density domain for the default
   * (single-class) mode. `null` (the default) auto-normalises against the
   * current window's peak texel.
   *
   * UNITS — read before pinning. This is a verbatim pass-through of deck's own
   * `HeatmapLayer.colorDomain`, which is NOT a per-feature weight range. It is
   * compared against the value a weights-texture TEXEL accumulates (the sum of
   * every gaussian splat landing on it), and for `aggregation: 'SUM'`
   * `HeatmapLayer._updateWeightmap` further rescales it by
   * `metersPerPixel * weightsScale`, where
   * `metersPerPixel = viewport.distanceScales.metersPerUnit[2] * commonBoundsWidth
   * / weightsTextureSize`. Two consequences: (1) the value is in
   * "accumulated weight per meter", not in weight-column units; (2) it is
   * ZOOM- and LATITUDE-dependent, so a domain pinned at one zoom does not mean
   * the same thing at another. Setting it also disables {@link threshold}
   * (deck's ramp shader takes the `colorDomain` branch and never reads the
   * threshold-derived alpha floor). Tune it against the rendered map rather
   * than deriving it from the data.
   *
   * The archive's `metadata.heatmapDomain` is deliberately NOT used here — it
   * is measured in raw weight-column units, which are not convertible into
   * these without knowing point density. See the module doc.
   */
  colorDomain?: [number, number] | null;
  /**
   * Density fraction below which pixels render transparent (canonical
   * HeatmapLayer `threshold`), 0..1. Only takes effect when `colorDomain` is
   * unset — deck's ramp shader switches to the pinned domain and stops
   * deriving an alpha floor at all.
   * @default 0.05
   */
  threshold?: number;
  /**
   * Stacked categorical channels. When supplied, the layer renders one
   * canonical HeatmapLayer per channel; null (default) renders the single
   * default class from the top-level colorRange/colorDomain props.
   */
  channels?: HeatmapChannelSpec[] | null;
  /**
   * Fade-in duration at the leading edge of the time window (ms). Mapped onto
   * the DataFilterExtension soft range so points fade in rather than pop.
   */
  fadeInDuration?: number;
  /** Fade-out duration at the trailing edge of the time window (ms). */
  fadeOutDuration?: number;
  /**
   * Density accumulation operation — canonical HeatmapLayer pass-through.
   * 'SUM' (default) accumulates count/weight per pixel; 'MEAN' averages
   * weights instead — only meaningful with a `weightProperty`, since a
   * constant-weight MEAN flattens the map to a single colour.
   * @default 'SUM'
   */
  aggregation?: 'SUM' | 'MEAN';
  /**
   * Side length of the density texture — canonical HeatmapLayer pass-through,
   * 128..2048 (deck's own clamp). Larger = finer detail at higher GPU cost.
   * @default 2048
   */
  weightsTextureSize?: number;
  /**
   * Interaction debounce (ms) before re-aggregating during pan/zoom —
   * canonical HeatmapLayer pass-through, 0..1000 (deck's own clamp).
   * @default 500
   */
  debounceTimeout?: number;
}

/** Complete props accepted by {@link AnimatedHeatmapLayer}. */
export type AnimatedHeatmapLayerProps = _AnimatedHeatmapLayerProps &
  SpatioTemporalLayerProps;

interface ResolvedChannel {
  id: string;
  /** Per-channel weight multiplier from {@link HeatmapChannelSpec.intensity}. */
  intensity: number;
  /**
   * Archive-derived per-point weight NORMALISER (see
   * {@link AnimatedHeatmapLayer.archiveWeightScale}), folded into the same
   * per-point multiply as {@link intensity}. `1` when the archive bakes no
   * usable domain.
   */
  weightScale: number;
  colorRange: Color[];
  /**
   * Pinned deck `colorDomain` (accumulated-per-texel units) from the caller's
   * props ONLY; `null` → let the canonical layer auto-normalise. The archive's
   * raw-weight domain is never routed here — see the module doc.
   */
  colorDomain: [number, number] | null;
  categoryFilter?: { property: string; values: string[] };
}

/** Binary `data: { length, attributes }` payload for one channel. */
interface ChannelData {
  length: number;
  attributes: {
    getPosition: { value: Float64Array; size: 3 };
    getWeight: { value: Float32Array; size: 1 };
    getFilterValue: { value: Float32Array; size: 1 };
  };
}

// Upstream idiom: module-level const typed `DefaultProps<XxxLayerProps>` then
// assigned to the static — the named annotation keeps the emitted .d.ts
// portable (the inferred mapped type used to surface transitive-dep types,
// which motivated the previous `static defaultProps: any`).
const defaultProps: DefaultProps<AnimatedHeatmapLayerProps> = {
  ...SpatioTemporalLayer.defaultProps,
  // Upstream's `max` clamps are restored on every prop that has one
  // (radiusPixels 100, threshold 1, weightsTextureSize 2048, debounceTimeout
  // 1000). Dropping them didn't widen the accepted range — the sublayer's
  // validator rejects the same values under `deck.setProps({debug: true})` —
  // it only moved the throw from OUR boundary into deck's internals, where the
  // error names a generated sublayer id instead of the prop the caller set.
  radiusPixels: { type: 'number', value: 30, min: 1, max: 100 },
  intensity: { type: 'number', value: 1, min: 0 },
  threshold: { type: 'number', value: 0.05, min: 0, max: 1 },
  colorRange: { type: 'array', value: DEFAULT_COLOR_RANGE, compare: true },
  colorDomain: { type: 'array', value: null, compare: true, optional: true },
  channels: { type: 'array', value: null, compare: true, optional: true },
  weightProperty: {
    type: 'object',
    value: null,
    optional: true,
    compare: true,
  },
  // Accessor-named alias of weightProperty (column-name semantics).
  getWeight: { type: 'object', value: null, optional: true, compare: true },
  fadeInDuration: { type: 'number', value: 0, min: 0 },
  fadeOutDuration: { type: 'number', value: 0, min: 0 },
  aggregation: 'SUM',
  weightsTextureSize: { type: 'number', value: 2048, min: 128, max: 2048 },
  debounceTimeout: { type: 'number', value: 500, min: 0, max: 1000 },
};

/**
 * Animated heatmap composite over the canonical deck.gl HeatmapLayer.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`heatmap`** — covers
 * every per-channel sublayer. `_subLayerProps: { heatmap: { type, ...props } }`
 * swaps the sublayer class / overrides sublayer props (deck's CompositeLayer
 * contract).
 */
/**
 * Everything the render path caches between frames, in ONE bag so it can live
 * on `this.state` and survive deck's `_transferState`. See
 * {@link AnimatedHeatmapLayer.heatmapCaches}.
 */
interface HeatmapCaches {
  channels: Map<number, { key: string; data: ChannelData }>;
  lastFilterUpdateWall: number;
  filterRange: [number, number] | null;
  filterSoftRange: [number, number] | null;
}

const HEATMAP_CACHE_SLOT = '_sttHeatmapCaches';

function freshHeatmapCaches(): HeatmapCaches {
  return {
    channels: new Map(),
    lastFilterUpdateWall: 0,
    filterRange: null,
    filterSoftRange: null,
  };
}

export class AnimatedHeatmapLayer<
  ExtraPropsT extends {} = {},
> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_AnimatedHeatmapLayerProps>
> {
  static layerName = 'AnimatedHeatmapLayer';

  static defaultProps = defaultProps;

  /** Shared filter extension — one instance across every channel sublayer. */
  private _dataFilter = new DataFilterExtension({ filterSize: 1 });

  /**
   * Render caches, held on `this.state` rather than in class FIELDS.
   *
   * deck's `_transferState` moves only `state`/`internalState` onto the
   * instance React hands it each render; class-field initializers re-run on
   * that instance. Held as fields, every unmemoized
   * `new AnimatedHeatmapLayer({...})` in a React render re-packed every visible
   * tile's consolidated Float64/Float32 buffers from scratch and lost the
   * stable-array-reference optimization below. `AnimatedTripsLayer` fixed this
   * first. (`_dataFilter` stays a field on purpose: it is stateless config, and
   * a fresh instance compares equal under `LayerExtension.equals`.)
   */
  private get heatmapCaches(): HeatmapCaches {
    return this.stateSlot(HEATMAP_CACHE_SLOT, freshHeatmapCaches);
  }

  // The accessors below keep the historical field NAMES while the storage lives
  // on `state`.

  /** Consolidated binary buffers per channel index, keyed for cache reuse. */
  private get _channelCache(): Map<number, { key: string; data: ChannelData }> {
    return this.heatmapCaches.channels;
  }
  private set _channelCache(
    value: Map<number, { key: string; data: ChannelData }>,
  ) {
    this.heatmapCaches.channels = value;
  }

  /** Wall-clock floor for the filterRange (re-aggregation) cadence. */
  private get _lastFilterUpdateWall(): number {
    return this.heatmapCaches.lastFilterUpdateWall;
  }
  private set _lastFilterUpdateWall(value: number) {
    this.heatmapCaches.lastFilterUpdateWall = value;
  }

  /**
   * Last emitted `filterRange` / `filterSoftRange`, kept so an unchanged window
   * hands the sublayers back the SAME array reference. See {@link stableRange}
   * and the "cost of a window move" note in the module doc.
   */
  private get _filterRange(): [number, number] | null {
    return this.heatmapCaches.filterRange;
  }
  private set _filterRange(value: [number, number] | null) {
    this.heatmapCaches.filterRange = value;
  }
  private get _filterSoftRange(): [number, number] | null {
    return this.heatmapCaches.filterSoftRange;
  }
  private set _filterSoftRange(value: [number, number] | null) {
    this.heatmapCaches.filterSoftRange = value;
  }

  finalizeState(context: LayerContext): void {
    this._channelCache.clear();
    this._filterRange = null;
    this._filterSoftRange = null;
    super.finalizeState(context);
  }

  updateState(params: UpdateParameters<this>): void {
    super.updateState(params);
    // Channel/weight config changes invalidate every consolidated buffer.
    const { props, oldProps } = params;
    if (
      props.channels !== oldProps.channels ||
      props.weightProperty !== oldProps.weightProperty ||
      props.getWeight !== oldProps.getWeight
    ) {
      this._channelCache.clear();
    }
  }

  /**
   * Accessor-alias resolution: `getWeight` wins when set; a
   * function-valued alias warns once and falls back to `weightProperty`.
   * Column-name semantics only — there is no constant-weight prop.
   */
  private weightPropertyValue(): string | undefined {
    return (
      resolveAccessorAlias(
        'AnimatedHeatmapLayer',
        'getWeight',
        this.props.getWeight as string | undefined,
        this.props.weightProperty,
      ) ?? undefined
    );
  }

  /**
   * Override the base tick handler: the canonical sublayers' time window is a
   * `filterRange` PROP, so we must force renderLayers() to re-run (the base
   * only calls setNeedsRedraw() for time-only ticks, which would freeze the
   * window). super() keeps `_currentTime` live and throttles tile loading on
   * its own cadence; we add an independent ~30 Hz cadence for the re-aggregate.
   */
  protected _handleTimeUpdate(time: number): void {
    super._handleTimeUpdate(time);
    const intervalMs = 1000 / FILTER_UPDATE_HZ;
    const nowWall =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (nowWall - this._lastFilterUpdateWall >= intervalMs) {
      this._lastFilterUpdateWall = nowWall;
      // setState (not setNeedsRedraw) is what re-runs renderLayers() and thus
      // re-evaluates the window. A tick whose window is unchanged re-emits the
      // SAME filterRange reference, so the sublayers diff clean and skip the
      // TextureTransform rebuild entirely (see the module doc).
      this.setState({ frameNumber: (this.state.frameNumber || 0) + 1 });
    }
  }

  renderLayers(): DeckLayer[] {
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) return [];

    const channels = this.resolveChannels();
    if (channels.length === 0) return [];

    const layerTimeOffset = pickLayerTimeOffset(tiles);
    // Canonical `tileKey` (folds in the temporal-LOD `bucketMs`), not the
    // local `${z}/${x}/${y}/${t}` shadow this file used to define. That
    // shadow made a scrub-preview tile and its base twin share one key, so
    // the consolidated-data cache gate below returned the PREVIOUS tier's
    // points — a payload covering a different span of time.
    const tileSetKey = tiles
      .map((tile) => tileKey(tile.id))
      .sort()
      .join('|');

    // Time window, relativized against the layer offset so it sits in the same
    // small-number f32 space as the per-point filter values. The array is
    // memoized by CONTENT: a MOVED window must hand the sublayer a fresh
    // reference (that is what flags dataChanged and re-runs the aggregation),
    // but a tick that lands inside the SAME window must not — an unconditional
    // fresh literal made every tick destroy and re-link the weights
    // TextureTransform. See the module doc.
    const time = this.getCurrentTime();
    // `Required<>`-typed: the defaultProps value guarantees a number here.
    const halfWindow = this.props.timeWindow / 2;
    const center = time - layerTimeOffset;
    const filterRange = (this._filterRange = stableRange(
      center - halfWindow,
      center + halfWindow,
      this._filterRange,
    ));

    // Optional soft edges from fadeIn/fadeOut, clamped inside the hard range.
    // `Required<>`-typed (defaults guarantee values) — no `??` refetches.
    const fadeIn = Math.max(0, this.props.fadeInDuration);
    const fadeOut = Math.max(0, this.props.fadeOutDuration);
    const softMin = filterRange[0] + fadeIn;
    const softMax = filterRange[1] - fadeOut;
    const filterSoftRange: [number, number] | null =
      (fadeIn > 0 || fadeOut > 0) && softMin < softMax
        ? (this._filterSoftRange = stableRange(
            softMin,
            softMax,
            this._filterSoftRange,
          ))
        : null;

    // Prune cache entries for channels that no longer exist.
    for (const idx of [...this._channelCache.keys()]) {
      if (idx >= channels.length) this._channelCache.delete(idx);
    }

    const layers: DeckLayer[] = [];
    for (let i = 0; i < channels.length; i++) {
      const channel = channels[i];
      const data = this._getChannelData(
        tiles,
        channel,
        i,
        tileSetKey,
        layerTimeOffset,
      );
      if (!data || data.length === 0) continue;

      // getSubLayerProps inheritance (opacity/visible, coordinate system,
      // modelMatrix, …) + user `_subLayerProps.heatmap` overrides. pickable
      // is forced false in sublayerProps (after inheritance, before user
      // overrides): density pixels have no feature identity to pick. Fresh
      // props objects per render are inherent to this layer's prop-driven
      // filterRange animation (renderLayers is already wall-clock capped).
      const subProps = this.composeSubLayerProps(
        'heatmap',
        `ch${i}-${channel.id}`,
        {
          data,
          // Density accumulation (count/weight per pixel). The 'SUM' default is
          // correct for density; 'MEAN' only makes sense with a weightProperty.
          aggregation: this.props.aggregation,
          radiusPixels: this.props.radiusPixels,
          intensity: this.props.intensity,
          colorRange: channel.colorRange as any,
          // null → canonical auto-normalisation (and a live `threshold`);
          // pinned → the caller's deck-units domain. NEVER the archive's
          // raw-weight domain — see the module doc's units contract.
          colorDomain: channel.colorDomain ?? null,
          threshold: this.props.threshold,
          weightsTextureSize: this.props.weightsTextureSize,
          debounceTimeout: this.props.debounceTimeout,
          pickable: false,
          // The DataFilterExtension is what animates the heatmap (filterRange);
          // user extensions from the top-level prop are appended.
          extensions: this.composeExtensions([this._dataFilter]),
          filterEnabled: true,
          filterRange,
          ...(filterSoftRange ? { filterSoftRange } : {}),
        },
      );
      // `_subLayerProps: { heatmap: { type } }` swaps the sublayer class.
      const SubLayerClass = this.getSubLayerClass(
        'heatmap',
        DeckHeatmapLayer as any,
      );
      layers.push(new SubLayerClass(subProps as any));
    }
    return layers;
  }

  /** Fetch (or rebuild) the consolidated binary buffers for one channel. */
  private _getChannelData(
    tiles: Tile[],
    channel: ResolvedChannel,
    channelIndex: number,
    tileSetKey: string,
    layerTimeOffset: number,
  ): ChannelData | null {
    const weightProp = this.weightPropertyValue();
    const filterSig = channel.categoryFilter
      ? `${channel.categoryFilter.property}:${channel.categoryFilter.values.join(',')}`
      : '';
    // The per-channel intensity and the archive-derived weight normaliser are
    // folded into ONE per-point multiply at consolidation time (both are pure
    // scalars on the weight column), so the cache key carries their product.
    const weightMultiplier = channel.intensity * channel.weightScale;
    // updateTriggers ride the key so a user trigger bump (e.g. getWeight)
    // re-consolidates the channel buffers.
    const key = `${tileSetKey}::${weightProp ?? ''}::${layerTimeOffset}::${filterSig}::${weightMultiplier}::${updateTriggersDigest(this.props.updateTriggers)}`;

    const cached = this._channelCache.get(channelIndex);
    if (cached && cached.key === key) return cached.data;

    const data = buildConsolidatedChannelData(
      tiles,
      { categoryFilter: channel.categoryFilter, intensity: weightMultiplier },
      weightProp,
      layerTimeOffset,
      this.props.id,
    );
    if (data) {
      this._channelCache.set(channelIndex, { key, data });
    } else {
      this._channelCache.delete(channelIndex);
    }
    return data;
  }

  private resolveChannels(): ResolvedChannel[] {
    const { channels } = this.props;
    const weightProp = this.weightPropertyValue();
    if (channels && channels.length > 0) {
      if (channels.length > MAX_CHANNELS) {
        warnOnce(
          'AnimatedHeatmapLayer:tooManyChannels',
          `[AnimatedHeatmapLayer] only the first ${MAX_CHANNELS} channels are rendered (got ${channels.length}).`,
        );
      }
      return channels.slice(0, MAX_CHANNELS).map((ch) => ({
        id: ch.id,
        intensity: ch.intensity ?? 1,
        weightScale: this.archiveWeightScale(ch.id, weightProp),
        colorRange: ch.colorRange ?? DEFAULT_COLOR_RANGE,
        colorDomain: ch.colorDomain ?? null,
        categoryFilter: ch.categoryFilter,
      }));
    }
    return [
      {
        id: 'default',
        intensity: 1,
        weightScale: this.archiveWeightScale('default', weightProp),
        colorRange: this.props.colorRange,
        colorDomain: this.props.colorDomain ?? null,
      },
    ];
  }

  /**
   * Pull the per-class weight domain baked at build time from archive metadata
   * (`compute_heatmap_domain` → `[min, p95]` of the raw weight COLUMN). Returns
   * null when the archive predates the field or the class isn't present.
   */
  private archiveHeatmapDomain(channelId: string): {
    min: number;
    max: number;
    property?: string;
  } | null {
    const metadata = this.state.metadata as any;
    const domain = metadata?.heatmapDomain;
    if (!domain || !Array.isArray(domain.classes)) return null;
    const entry = domain.classes.find(
      (c: { id: string }) => c.id === channelId,
    );
    if (
      !entry ||
      typeof entry.min !== 'number' ||
      typeof entry.max !== 'number'
    ) {
      return null;
    }
    return entry;
  }

  /**
   * Per-point weight normaliser derived from the archive's baked
   * `[min, p95]` weight-column domain: `1 / p95`, i.e. each point's weight is
   * re-expressed in units of "one p95-magnitude feature".
   *
   * WHY THIS AND NOT `colorDomain`. The baked domain measures the raw weight
   * COLUMN (earthquake magnitude, AIS speed, …); deck's `colorDomain` measures
   * what a texel ACCUMULATES, further rescaled by a zoom- and
   * latitude-dependent `metersPerPixel`. The two are not inter-convertible at
   * build time — the accumulated value depends on how many points land in a
   * texel, which depends on the viewport. Feeding the raw domain in as
   * `colorDomain` put the ramp top ~10³–10⁴× above any real texel and flattened
   * the map onto the bottom of the ramp. A pure SCALE on the weights is the
   * conversion that IS dimensionally valid: it is exact (`weight / p95` is
   * still a weight), zoom-independent, and it keeps the accumulated values near
   * the 1-per-splat range the 8-bit `rgba8unorm` fallback path
   * (`weightsScale = 1/255`) needs to avoid saturating.
   *
   * Returns `1` (no-op) when there is no weight column in play (every point
   * already weighs exactly 1), when the archive bakes no usable entry, or when
   * `p95 <= 0`. An entry measured from a DIFFERENT column than the one being
   * rendered is ignored with a named warning — silently scaling magnitudes by a
   * speed percentile would be worse than not scaling at all.
   */
  private archiveWeightScale(
    channelId: string,
    weightProp: string | undefined,
  ): number {
    if (!weightProp) return 1;
    const entry = this.archiveHeatmapDomain(channelId);
    if (!entry) return 1;
    if (typeof entry.property === 'string' && entry.property !== weightProp) {
      warnOnce(
        `AnimatedHeatmapLayer:domainPropertyMismatch:${channelId}:${weightProp}`,
        `[AnimatedHeatmapLayer] archive heatmapDomain for channel ` +
          `'${channelId}' was measured from '${entry.property}' but the layer ` +
          `is weighting by '${weightProp}'. Ignoring the baked domain — ` +
          `rebuild with \`stt-build --heatmap-weight ${weightProp}\` to bake a ` +
          'matching one, or drop `weightProperty`/`getWeight`.',
      );
      return 1;
    }
    if (!Number.isFinite(entry.max) || entry.max <= 0) return 1;
    return 1 / entry.max;
  }
}

/**
 * Return `last` when it already holds `[lo, hi]`, otherwise a fresh tuple.
 * Reference stability is the whole point: deck's aggregation layer reads a
 * changed `filterRange` reference as `dataChanged`, which costs a full
 * TextureTransform rebuild — so an unmoved window must reuse the array.
 */
function stableRange(
  lo: number,
  hi: number,
  last: [number, number] | null | undefined,
): [number, number] {
  // Truthiness, not `!== null`: the Object.create test harnesses (and any
  // subclass that skips the field initializers) leave `last` undefined.
  if (last && last[0] === lo && last[1] === hi) return last;
  return [lo, hi];
}

function pickLayerTimeOffset(tiles: Tile[]): number {
  for (const tile of tiles) {
    for (const layer of tile.layers) {
      return layer.features.timeOffset;
    }
  }
  return 0;
}

/** Geometry kinds this consolidator can read. */
const ACCEPTED_GEOMETRY = [
  GeometryType.Point,
  GeometryType.LineString,
] as const;

/**
 * Consolidate every visible tile's splats for one channel into a single binary
 * `data: { length, attributes }` payload. Features that don't pass the
 * channel's category filter are simply omitted from the buffers (the GPU never
 * sees them). Positions are kept in Float64 (matching the canonical layer's
 * float64 `getPosition` accessor); times are relativized against
 * `layerTimeOffset` so they fit in f32.
 *
 * GEOMETRY. Point tiles emit ONE splat per feature at `positions[i * dims]`.
 * LineString tiles emit one splat per VERTEX, walked through `startIndices` —
 * on a trip/track archive (`flights`, `drifters`, `ais-*`) `featureCount` is
 * the PATH count while `positions` holds every vertex, so the old
 * feature-indexed read splatted the first N vertices of the first few paths at
 * those paths' start times: a blob at the head of track #1 rather than a
 * track-density map, with no error. Per-vertex times come from
 * `vertexTimestamps` when the archive baked them, otherwise the whole path
 * takes its feature start time (no haversine synthesis here — the heatmap has
 * no per-vertex identity to preserve and this runs over every visible tile).
 * Polygon tiles are rejected by {@link expectGeometry} with a named warning.
 *
 * `layerId` only names the layer in that warning.
 *
 * Exported for unit testing (no GPU needed).
 */
export function buildConsolidatedChannelData(
  tiles: Tile[],
  channel: {
    categoryFilter?: { property: string; values: string[] };
    intensity: number;
  },
  weightProp: string | undefined,
  layerTimeOffset: number,
  layerId = 'AnimatedHeatmapLayer',
): ChannelData | null {
  // Pass 1: per tile-layer, compute the category mask + emitted splat count.
  interface Part {
    binary: import('@poopdeck.gl/core').BinaryFeatures;
    mask: Uint8Array | null;
    /** Walk vertices via startIndices rather than one position per feature. */
    isPath: boolean;
    /** Number of SPLATS this part emits (vertices for paths, features else). */
    count: number;
  }
  const parts: Part[] = [];
  let total = 0;

  for (const tile of tiles) {
    for (const tileLayer of tile.layers) {
      const binary = tileLayer.features;
      if (binary.featureCount === 0) continue;
      if (
        !expectGeometry(
          binary.geometryType,
          ACCEPTED_GEOMETRY,
          layerId,
          tileLayer.name,
        )
      ) {
        continue;
      }
      // A LineString tile without startIndices can't be walked; treat it as
      // point-shaped (the decoder always emits them, so this is fixtures only).
      const isPath =
        binary.geometryType === GeometryType.LineString &&
        binary.startIndices != null;

      let mask: Uint8Array | null = null;

      if (channel.categoryFilter) {
        const cat = binary.categoricalProps[channel.categoryFilter.property];
        if (!cat) continue; // tile lacks the property → skip for this channel
        const allowed = new Set<number>();
        for (let i = 0; i < cat.categories.length; i++) {
          if (channel.categoryFilter.values.indexOf(cat.categories[i]) !== -1) {
            allowed.add(i);
          }
        }
        if (allowed.size === 0) continue;
        mask = new Uint8Array(binary.featureCount);
        for (let i = 0; i < binary.featureCount; i++) {
          if (allowed.has(cat.indices[i])) mask[i] = 1;
        }
      }

      let count = 0;
      if (isPath) {
        const startIndices = binary.startIndices!;
        for (let i = 0; i < binary.featureCount; i++) {
          if (mask && !mask[i]) continue;
          count += startIndices[i + 1] - startIndices[i];
        }
      } else if (mask) {
        for (let i = 0; i < binary.featureCount; i++) if (mask[i]) count++;
      } else {
        count = binary.featureCount;
      }
      if (count === 0) continue;

      parts.push({ binary, mask, isPath, count });
      total += count;
    }
  }

  if (total === 0) return null;

  // Pass 2: pack the consolidated buffers.
  const positions = new Float64Array(total * 3);
  const weights = new Float32Array(total);
  const filterValues = new Float32Array(total);
  const perChannelIntensity = channel.intensity;

  let dst = 0;
  for (const { binary, mask, isPath } of parts) {
    const dims = binary.positionDimensions ?? 2;
    const weightSrc = weightProp ? binary.numericProps[weightProp] : null;
    const tileToLayerDelta = binary.timeOffset - layerTimeOffset;
    const startIndices = isPath ? binary.startIndices! : null;
    const vertexTimes = isPath ? binary.vertexTimestamps : undefined;
    for (let i = 0; i < binary.featureCount; i++) {
      if (mask && !mask[i]) continue;
      const weight = (weightSrc ? weightSrc[i] : 1) * perChannelIntensity;
      const featureTime = binary.startTimes[i] + tileToLayerDelta;
      if (startIndices) {
        // One splat per vertex; the feature's weight applies to each of them.
        for (let v = startIndices[i]; v < startIndices[i + 1]; v++) {
          const srcIdx = v * dims;
          positions[dst * 3] = binary.positions[srcIdx];
          positions[dst * 3 + 1] = binary.positions[srcIdx + 1];
          positions[dst * 3 + 2] = 0;
          weights[dst] = weight;
          filterValues[dst] = vertexTimes
            ? vertexTimes[v] + tileToLayerDelta
            : featureTime;
          dst++;
        }
        continue;
      }
      const srcIdx = i * dims;
      positions[dst * 3] = binary.positions[srcIdx];
      positions[dst * 3 + 1] = binary.positions[srcIdx + 1];
      positions[dst * 3 + 2] = 0;
      weights[dst] = weight;
      filterValues[dst] = featureTime;
      dst++;
    }
  }

  return {
    length: total,
    attributes: {
      getPosition: { value: positions, size: 3 },
      getWeight: { value: weights, size: 1 },
      getFilterValue: { value: filterValues, size: 1 },
    },
  };
}

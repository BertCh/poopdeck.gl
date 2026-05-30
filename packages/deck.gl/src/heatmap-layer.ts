/**
 * HeatmapLayer — animated density heatmap built on CANONICAL deck.gl.
 *
 * This is a thin composite over `@deck.gl/aggregation-layers`'
 * {@link DeckHeatmapLayer}, the standard deck.gl heatmap. That layer does the
 * thing a heatmap is supposed to do: it splats every point into a GPU weight
 * texture with ADDITIVE accumulation, reduces to a per-pixel density, and only
 * THEN maps the accumulated density through a colour ramp. Dense regions get
 * hotter because more splats land on the same pixels — true per-pixel density.
 *
 * ### Why this replaces the old custom-splat layer
 * The previous implementation hand-rolled a single-pass splat shader that
 * sampled the palette PER SPLAT (each point coloured by its own weight) and
 * additively blended the resulting *colours*. Overlapping points summed colours
 * instead of density, so hot zones blew out to white and the result never read
 * as a heatmap. Its own shader comments admitted the ramp was "sampled
 * per-splat, not per-pixel". This rewrite hands the splat+accumulate+ramp
 * pipeline to deck.gl's tested implementation instead.
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
 * the channel config) changes — never per frame. Per frame, only the small
 * `filterRange` array changes, so deck.gl re-aggregates over the already-
 * uploaded GPU buffers without re-uploading anything.
 *
 * f32 time precision: absolute epoch-ms (~1.7e12) cannot live in a Float32
 * attribute. Both the per-point filter value AND `filterRange` are relativized
 * against a single `layerTimeOffset` (the first visible tile's offset), so both
 * sides of the shader comparison are small numbers that fit exactly in f32 —
 * the same scheme the TimeFilterExtension uses for point/path/trips layers.
 */

import { HeatmapLayer as DeckHeatmapLayer } from '@deck.gl/aggregation-layers';
import { DataFilterExtension } from '@deck.gl/extensions';
import type { Color, Layer as DeckLayer, UpdateParameters } from '@deck.gl/core';
import {
  SpatioTemporalLayer,
  type SpatioTemporalLayerProps,
} from './spatiotemporal-layer';
import { warnOnce } from './log';
import type { Tile } from '@stt/core';

const DEFAULT_COLOR_RANGE: Color[] = [
  [255, 255, 178, 255],
  [254, 217, 118, 255],
  [254, 178, 76, 255],
  [253, 141, 60, 255],
  [252, 78, 42, 255],
  [227, 26, 28, 255],
  [177, 0, 38, 255],
];

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
   * Pinned [min, max] density domain. Setting this skips the canonical layer's
   * per-frame max-normalisation (which otherwise makes colours "breathe" as the
   * window slides). When unset the layer auto-normalises against the current
   * window's max density.
   */
  colorDomain?: [number, number];
  /** Per-class weight multiplier folded into each point's accumulation weight. */
  intensity?: number;
}

export interface HeatmapLayerProps extends SpatioTemporalLayerProps {
  /** Splat radius in pixels. Defaults to 30. */
  radiusPixels?: number;
  /** Global intensity multiplier (canonical HeatmapLayer `intensity`). */
  intensity?: number;
  /** Per-feature weight property name (defaults to constant 1.0). */
  weightProperty?: string;
  /** Color ramp used when `channels` is unset (single-class mode). */
  colorRange?: Color[];
  /**
   * Pinned [min, max] density domain for the default (single-class) mode.
   * When unset the layer auto-normalises (and reads metadata.heatmapDomain when
   * the archive carries one).
   */
  colorDomain?: [number, number];
  /**
   * Density fraction below which pixels render transparent (canonical
   * HeatmapLayer `threshold`). Only takes effect when `colorDomain` is unset.
   * Default 0.05.
   */
  threshold?: number;
  /**
   * Stacked categorical channels. When supplied, the layer renders one
   * canonical HeatmapLayer per channel.
   */
  channels?: HeatmapChannelSpec[];
  /**
   * Deprecated/no-op. The old single-pass splat reserved this for a future
   * TAA blend that never shipped. Accepted for API compatibility and ignored —
   * the canonical aggregation pipeline has no equivalent.
   */
  historyWeight?: number;
  /**
   * Fade-in duration at the leading edge of the time window (ms). Mapped onto
   * the DataFilterExtension soft range so points fade in rather than pop.
   */
  fadeInDuration?: number;
  /** Fade-out duration at the trailing edge of the time window (ms). */
  fadeOutDuration?: number;
}

interface ResolvedChannel {
  id: string;
  intensity: number;
  colorRange: Color[];
  /** null → let the canonical layer auto-normalise (no pinned domain). */
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

export class HeatmapLayer extends SpatioTemporalLayer<HeatmapLayerProps> {
  static layerName = 'HeatmapLayer';

  static defaultProps: any = {
    ...SpatioTemporalLayer.defaultProps,
    radiusPixels: { type: 'number', value: 30, min: 1 },
    intensity: { type: 'number', value: 1, min: 0 },
    threshold: { type: 'number', value: 0.05, min: 0 },
    colorRange: { type: 'array', value: DEFAULT_COLOR_RANGE, compare: true },
    colorDomain: { type: 'array', value: null, compare: true, optional: true },
    channels: { type: 'array', value: null, compare: true, optional: true },
    historyWeight: { type: 'number', value: 0, min: 0, max: 0.95 },
    weightProperty: { type: 'string', value: null, optional: true },
    fadeInDuration: { type: 'number', value: 0, min: 0 },
    fadeOutDuration: { type: 'number', value: 0, min: 0 },
  };

  /** Shared filter extension — one instance across every channel sublayer. */
  private _dataFilter = new DataFilterExtension({ filterSize: 1 });

  /** Consolidated binary buffers per channel index, keyed for cache reuse. */
  private _channelCache = new Map<number, { key: string; data: ChannelData }>();

  /** Wall-clock floor for the filterRange (re-aggregation) cadence. */
  private _lastFilterUpdateWall = 0;

  finalizeState(context: any): void {
    this._channelCache.clear();
    super.finalizeState(context);
  }

  updateState(params: UpdateParameters<this>): void {
    super.updateState(params);
    // Channel/weight config changes invalidate every consolidated buffer.
    const { props, oldProps } = params;
    if (
      props.channels !== oldProps.channels ||
      props.weightProperty !== oldProps.weightProperty
    ) {
      this._channelCache.clear();
    }
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
      // pushes a fresh filterRange into the aggregation sublayers.
      this.setState({ frameNumber: (this.state.frameNumber || 0) + 1 });
    }
  }

  renderLayers(): DeckLayer[] {
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) return [];

    const channels = this.resolveChannels();
    if (channels.length === 0) return [];

    const layerTimeOffset = pickLayerTimeOffset(tiles);
    const tileSetKey = tiles.map(tileKey).sort().join('|');

    // Time window, relativized against the layer offset so it sits in the same
    // small-number f32 space as the per-point filter values. A FRESH array is
    // allocated every render on purpose: the canonical aggregation layer
    // reference-compares filterRange, so reusing the array would freeze the
    // animation (it would never see a "changed" prop and never re-aggregate).
    const time = this.getCurrentTime();
    const halfWindow = (this.props.timeWindow ?? 86_400_000) / 2;
    const center = time - layerTimeOffset;
    const filterRange: [number, number] = [center - halfWindow, center + halfWindow];

    // Optional soft edges from fadeIn/fadeOut, clamped inside the hard range.
    const fadeIn = Math.max(0, this.props.fadeInDuration ?? 0);
    const fadeOut = Math.max(0, this.props.fadeOutDuration ?? 0);
    const softMin = filterRange[0] + fadeIn;
    const softMax = filterRange[1] - fadeOut;
    const filterSoftRange: [number, number] | null =
      (fadeIn > 0 || fadeOut > 0) && softMin < softMax ? [softMin, softMax] : null;

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

      layers.push(
        new DeckHeatmapLayer({
          id: `${this.props.id}-ch${i}-${channel.id}`,
          data,
          // Density accumulation (count/weight per pixel). MEAN would flatten a
          // constant-weight density map to a single colour, so SUM is correct.
          aggregation: 'SUM',
          radiusPixels: this.props.radiusPixels ?? 30,
          intensity: this.props.intensity ?? 1,
          colorRange: channel.colorRange as any,
          // null → canonical auto-normalisation; pinned → stable (no breathing).
          colorDomain: channel.colorDomain ?? null,
          threshold: this.props.threshold ?? 0.05,
          opacity: this.props.opacity ?? 1,
          visible: this.props.visible ?? true,
          pickable: false,
          extensions: [this._dataFilter],
          filterEnabled: true,
          filterRange,
          ...(filterSoftRange ? { filterSoftRange } : {}),
        } as any),
      );
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
    const weightProp = this.props.weightProperty;
    const filterSig = channel.categoryFilter
      ? `${channel.categoryFilter.property}:${channel.categoryFilter.values.join(',')}`
      : '';
    const key = `${tileSetKey}::${weightProp ?? ''}::${layerTimeOffset}::${filterSig}::${channel.intensity}`;

    const cached = this._channelCache.get(channelIndex);
    if (cached && cached.key === key) return cached.data;

    const data = buildConsolidatedChannelData(
      tiles,
      channel,
      weightProp,
      layerTimeOffset,
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
    if (channels && channels.length > 0) {
      if (channels.length > MAX_CHANNELS) {
        warnOnce(
          'HeatmapLayer:tooManyChannels',
          `[HeatmapLayer] only the first ${MAX_CHANNELS} channels are rendered (got ${channels.length}).`,
        );
      }
      return channels.slice(0, MAX_CHANNELS).map((ch) => ({
        id: ch.id,
        intensity: ch.intensity ?? 1,
        colorRange: ch.colorRange ?? DEFAULT_COLOR_RANGE,
        colorDomain: ch.colorDomain ?? this.archiveHeatmapDomain(ch.id),
        categoryFilter: ch.categoryFilter,
      }));
    }
    return [
      {
        id: 'default',
        intensity: 1,
        colorRange: this.props.colorRange ?? DEFAULT_COLOR_RANGE,
        colorDomain:
          this.props.colorDomain ?? this.archiveHeatmapDomain('default'),
      },
    ];
  }

  /**
   * Pull the per-class density domain baked at build time from archive
   * metadata. Returns null when the archive predates the field (or the class
   * isn't present) — in which case the canonical layer auto-normalises.
   */
  private archiveHeatmapDomain(channelId: string): [number, number] | null {
    const metadata = this.state.metadata as any;
    const domain = metadata?.heatmapDomain;
    if (!domain || !Array.isArray(domain.classes)) return null;
    const entry = domain.classes.find((c: { id: string }) => c.id === channelId);
    if (!entry || typeof entry.min !== 'number' || typeof entry.max !== 'number') {
      return null;
    }
    return [entry.min, entry.max];
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

/**
 * Consolidate every visible tile's points for one channel into a single binary
 * `data: { length, attributes }` payload. Features that don't pass the
 * channel's category filter are simply omitted from the buffers (the GPU never
 * sees them). Positions are kept in Float64 (matching the canonical layer's
 * float64 `getPosition` accessor); times are relativized against
 * `layerTimeOffset` so they fit in f32.
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
): ChannelData | null {
  // Pass 1: per tile-layer, compute the category mask + retained count.
  interface Part {
    binary: import('@stt/core').BinaryFeatures;
    mask: Uint8Array | null;
    count: number;
  }
  const parts: Part[] = [];
  let total = 0;

  for (const tile of tiles) {
    for (const tileLayer of tile.layers) {
      const binary = tileLayer.features;
      if (binary.featureCount === 0) continue;

      let mask: Uint8Array | null = null;
      let count = binary.featureCount;

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
        count = 0;
        for (let i = 0; i < binary.featureCount; i++) {
          if (allowed.has(cat.indices[i])) {
            mask[i] = 1;
            count++;
          }
        }
        if (count === 0) continue;
      }

      parts.push({ binary, mask, count });
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
  for (const { binary, mask } of parts) {
    const dims = binary.positionDimensions ?? 2;
    const weightSrc = weightProp ? binary.numericProps[weightProp] : null;
    const tileToLayerDelta = binary.timeOffset - layerTimeOffset;
    for (let i = 0; i < binary.featureCount; i++) {
      if (mask && !mask[i]) continue;
      const srcIdx = i * dims;
      positions[dst * 3] = binary.positions[srcIdx];
      positions[dst * 3 + 1] = binary.positions[srcIdx + 1];
      positions[dst * 3 + 2] = 0;
      weights[dst] = (weightSrc ? weightSrc[i] : 1) * perChannelIntensity;
      filterValues[dst] = binary.startTimes[i] + tileToLayerDelta;
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

/**
 * HeatmapLayer — GPU-splat temporal heatmap, deck.gl edition.
 *
 * Architecture (single-pass):
 *   1. Per-tile-per-channel vertex buffers (instancePosition, instanceTime,
 *      instanceWeight, instanceChannel) are uploaded ONCE on tile arrival.
 *      No per-frame CPU filter.
 *   2. Vertex shader projects via deck.gl's `project32` and evaluates the
 *      time-window alpha — out-of-window points discard on the GPU.
 *   3. Fragment shader draws a gaussian disc, samples a per-channel
 *      palette LUT keyed on the splat intensity. Additive blending into
 *      the canvas sums contributions across overlapping splats.
 *
 * Replaces the old `HeatmapTimeLayer` that wrapped
 * `@deck.gl/aggregation-layers/HeatmapLayer`. The previous design rebuilt
 * the inner HeatmapLayer instance on every refilter, re-uploaded all
 * positions/weights, and triggered the weight-texture rebuild — the
 * dominant cost. The new layer does zero per-frame CPU work and reuses
 * GPU buffers across frames.
 *
 * The two-pass offscreen-FBO architecture used by the maplibre adapter
 * (gather into RGBA16F, then ramp-pass to canvas) is intentionally NOT
 * used here: it interacts poorly with deck.gl 9's RenderPass system and
 * the offscreen output never reached the canvas in testing. The
 * single-pass direct splat keeps us inside the standard deck.gl
 * pipeline. Visual diff vs the FBO design is small in practice; the FBO
 * variant remains a follow-up once deck.gl's offscreen contract is
 * better understood.
 */

import { Layer, project32 } from '@deck.gl/core';
import type {
  Color,
  CompositeLayerProps,
  Layer as DeckLayer,
  LayerContext,
  UpdateParameters,
} from '@deck.gl/core';
import { Model, Geometry } from '@luma.gl/engine';
import type { Buffer as LumaBuffer, Texture } from '@luma.gl/core';
import { HEATMAP_VS, HEATMAP_FS, heatmapUniforms } from './shaders/heatmap.glsl';
import {
  SpatioTemporalLayer,
  type SpatioTemporalLayerProps,
} from './spatiotemporal-layer';
import { warnOnce } from './log';
import type { BinaryFeatures, Tile } from '@stt/core';

const DEFAULT_COLOR_RANGE: Color[] = [
  [255, 255, 178, 255],
  [254, 217, 118, 255],
  [254, 178, 76, 255],
  [253, 141, 60, 255],
  [252, 78, 42, 255],
  [227, 26, 28, 255],
  [177, 0, 38, 255],
];

/**
 * Per-class spec for a stacked heatmap. Up to 4 classes pack into the
 * RGBA accumulator. When `channels` is omitted the layer renders ONE
 * default class from the top-level colorRange/colorDomain props.
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
   * Pinned [min, max] intensity domain. Setting this skips any runtime
   * auto-detect. Defaults to [0, 1].
   */
  colorDomain?: [number, number];
  /** Per-class weight multiplier on top of the global `intensity`. */
  intensity?: number;
}

export interface HeatmapLayerProps extends SpatioTemporalLayerProps {
  /** Splat radius in pixels. Defaults to 30. */
  radiusPixels?: number;
  /** Global intensity multiplier. Per-channel `intensity` stacks on top. */
  intensity?: number;
  /** Per-feature weight property name (defaults to constant 1.0). */
  weightProperty?: string;
  /** Color ramp used when `channels` is unset (single-class mode). */
  colorRange?: Color[];
  /**
   * Pinned [min, max] intensity domain for the default (single-class) mode.
   * Defaults to [0, 1].
   */
  colorDomain?: [number, number];
  /**
   * Threshold below which accumulated intensity renders transparent.
   * 0 = no threshold; 0.05 hides faint regions. Default 0.05.
   */
  threshold?: number;
  /**
   * Stacked categorical channels. When supplied, the layer renders one
   * sub-draw per channel using the same shader + accumulator.
   */
  channels?: HeatmapChannelSpec[];
  /**
   * Reserved for the future FBO-based TAA blend. Currently a no-op — the
   * single-pass design has no offscreen frame to blend into.
   */
  historyWeight?: number;
  /** Fade-in duration at the leading edge of the time window (ms). */
  fadeInDuration?: number;
  /** Fade-out duration at the trailing edge of the time window (ms). */
  fadeOutDuration?: number;
}

/* ────────────────────────────────────────────────────────────────────── */
/* Inner sublayer — owns the GPU pipeline                                 */
/* ────────────────────────────────────────────────────────────────────── */

interface PerTileChannelData {
  /** Pre-projected per-instance attributes. */
  instancePosition: Float32Array;
  instanceTime: Float32Array;
  instanceWeight: Float32Array;
  instanceChannel: Float32Array;
  vertexCount: number;
  channelIndex: number;
  channelId: string;
  /**
   * GPU buffers, uploaded ONCE when the entry is built and reused across
   * frames. Previously the layer created+destroyed four buffers per entry on
   * every `draw()` (i.e. every animation frame) — 4·N·C alloc+upload+free per
   * frame — which defeated the "upload once" design and churned the driver's
   * buffer pool. Destroyed on tile eviction (updateState) and finalizeState.
   */
  gpu?: {
    posBuf: LumaBuffer;
    timeBuf: LumaBuffer;
    weightBuf: LumaBuffer;
    channelBuf: LumaBuffer;
  };
}

function destroyEntryGpu(entry: PerTileChannelData | undefined): void {
  if (!entry?.gpu) return;
  entry.gpu.posBuf.destroy();
  entry.gpu.timeBuf.destroy();
  entry.gpu.weightBuf.destroy();
  entry.gpu.channelBuf.destroy();
  entry.gpu = undefined;
}

interface ResolvedChannel {
  id: string;
  intensity: number;
  colorRange: Color[];
  colorDomain: [number, number];
  categoryFilter?: { property: string; values: string[] };
}

interface HeatmapSplatSublayerProps extends CompositeLayerProps {
  /** Visible tile set from the parent's tileset. */
  tiles: Tile[];
  /** Reference offset (epoch-ms) to relativize all times against. */
  layerTimeOffset: number;
  /** Current sim time getter (epoch-ms). */
  getTime: () => number;
  timeWindow: number;
  radiusPixels: number;
  intensity: number;
  threshold: number;
  channels: ResolvedChannel[];
  fadeInDuration: number;
  fadeOutDuration: number;
  weightProperty?: string;
}

class HeatmapSplatSublayer extends Layer<HeatmapSplatSublayerProps> {
  static layerName = 'HeatmapSplatSublayer';

  static defaultProps: any = {
    tiles: { type: 'array', value: [], compare: false },
    layerTimeOffset: { type: 'number', value: 0, compare: false },
    getTime: { type: 'function', value: () => 0, compare: false },
    timeWindow: { type: 'number', value: 86_400_000, compare: false },
    radiusPixels: { type: 'number', value: 30, compare: true },
    intensity: { type: 'number', value: 1, compare: true },
    threshold: { type: 'number', value: 0.05, compare: true },
    channels: { type: 'array', value: [], compare: true },
    fadeInDuration: { type: 'number', value: 0, compare: false },
    fadeOutDuration: { type: 'number', value: 0, compare: false },
    weightProperty: { type: 'string', value: null, optional: true, compare: true },
  };

  getShaders(): any {
    return super.getShaders({
      vs: HEATMAP_VS,
      fs: HEATMAP_FS,
      modules: [project32, heatmapUniforms],
    });
  }

  initializeState(_context: LayerContext): void {
    const device = this.context.device;
    const shaders = this.getShaders();
    const model = new Model(device, {
      ...shaders,
      id: `${this.props.id}-model`,
      topology: 'point-list',
      isInstanced: false,
      vertexCount: 0,
      bufferLayout: [
        { name: 'instancePosition', format: 'float32x3' },
        { name: 'instanceTime', format: 'float32x2' },
        { name: 'instanceWeight', format: 'float32' },
        { name: 'instanceChannel', format: 'float32' },
      ],
      // Empty geometry — Model needs something declared as the vertex
      // driver. We replace its attribute buffers per tile/channel in draw().
      geometry: new Geometry({
        topology: 'point-list',
        attributes: {
          instancePosition: { size: 3, value: new Float32Array(0) },
        },
        vertexCount: 0,
      }),
      parameters: {
        blend: true,
        // Additive blending — accumulate splat contributions per pixel.
        blendColorSrcFactor: 'one',
        blendColorDstFactor: 'one',
        blendAlphaSrcFactor: 'one',
        blendAlphaDstFactor: 'one',
        depthCompare: 'always',
        depthWriteEnabled: false,
        cullMode: 'none',
      },
    });

    const paletteTextures: Texture[] = [];
    for (let i = 0; i < 4; i++) {
      paletteTextures.push(
        device.createTexture({
          width: 256,
          height: 1,
          format: 'rgba8unorm',
          sampler: {
            minFilter: 'linear',
            magFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
          },
        }),
      );
    }

    this.setState({
      model,
      paletteTextures,
      lastPaletteKey: ['', '', '', ''],
      // Per-tile-per-channel cached CPU-side typed arrays. Built once per
      // (tile, channel) on first sight and reused across frames.
      tileChannelData: new Map<string, PerTileChannelData>(),
    });
  }

  finalizeState(_context: LayerContext): void {
    const s = this.state as any;
    s.model?.destroy();
    if (s.paletteTextures) {
      for (const t of s.paletteTextures) t?.destroy();
    }
    if (s.tileChannelData) {
      for (const entry of (s.tileChannelData as Map<string, PerTileChannelData>).values()) {
        destroyEntryGpu(entry);
      }
      s.tileChannelData.clear();
    }
  }

  updateState(params: UpdateParameters<this>): void {
    super.updateState(params);
    const s = this.state as any;
    // Drop cached buffers whose tile is no longer live or whose channel
    // mapping changed.
    const live = new Set<string>();
    const channelCount = params.props.channels?.length ?? 0;
    for (const tile of params.props.tiles ?? []) {
      const base = tileKey(tile);
      for (let chIdx = 0; chIdx < channelCount; chIdx++) {
        live.add(`${base}::${chIdx}`);
      }
    }
    if (
      params.props.channels !== params.oldProps.channels ||
      params.props.weightProperty !== params.oldProps.weightProperty ||
      params.props.layerTimeOffset !== params.oldProps.layerTimeOffset
    ) {
      // Wholesale wipe — channel mapping or relativization changed. Free the
      // GPU buffers of every cached entry before dropping them.
      for (const entry of (s.tileChannelData as Map<string, PerTileChannelData>)?.values() ?? []) {
        destroyEntryGpu(entry);
      }
      s.tileChannelData?.clear();
    } else {
      for (const key of [...(s.tileChannelData?.keys() ?? [])]) {
        if (!live.has(key)) {
          destroyEntryGpu(s.tileChannelData.get(key));
          s.tileChannelData.delete(key);
        }
      }
    }
  }

  draw(_params: unknown): void {
    const s = this.state as any;
    const model: Model | undefined = s.model;
    if (!model) return;
    if (!this.props.channels || this.props.channels.length === 0) return;

    this.syncPalettes();
    this.ensureTileChannelData();

    const time = this.props.getTime();
    const halfWindow = this.props.timeWindow / 2;
    const windowStart = time - this.props.layerTimeOffset - halfWindow;
    const windowEnd = time - this.props.layerTimeOffset + halfWindow;

    model.setBindings({
      uPalette0: s.paletteTextures[0],
      uPalette1: s.paletteTextures[1],
      uPalette2: s.paletteTextures[2],
      uPalette3: s.paletteTextures[3],
    });

    // One draw call per (tile, channel) pair. GPU buffers are created once in
    // ensureTileChannelData() and reused here every frame; draw() only swaps
    // the (cached) attribute buffers and updates the small uniform block.
    for (const entry of (s.tileChannelData as Map<string, PerTileChannelData>).values()) {
      const channel = this.props.channels[entry.channelIndex];
      if (!channel || !entry.gpu) continue;
      model.setAttributes({
        instancePosition: entry.gpu.posBuf,
        instanceTime: entry.gpu.timeBuf,
        instanceWeight: entry.gpu.weightBuf,
        instanceChannel: entry.gpu.channelBuf,
      });
      model.setVertexCount(entry.vertexCount);
      model.shaderInputs.setProps({
        heatmap: {
          radius: this.props.radiusPixels,
          intensity: this.props.intensity,
          windowStart,
          windowEnd,
          fadeIn: this.props.fadeInDuration,
          fadeOut: this.props.fadeOutDuration,
          threshold: this.props.threshold,
          opacity: this.props.opacity ?? 1,
          domainMin: channel.colorDomain[0],
          domainMax: channel.colorDomain[1],
        },
      });
      model.draw(this.context.renderPass);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────

  private syncPalettes(): void {
    const s = this.state as any;
    for (let i = 0; i < this.props.channels.length; i++) {
      const ch = this.props.channels[i];
      const key = `${ch.colorRange.length}:${ch.colorRange.flat().join(',')}`;
      if (key === s.lastPaletteKey[i]) continue;
      const data = buildPaletteRgba8(ch.colorRange);
      s.paletteTextures[i].copyImageData({ data });
      s.lastPaletteKey[i] = key;
    }
  }

  private ensureTileChannelData(): void {
    const s = this.state as any;
    const channels = this.props.channels;
    const weightProp = this.props.weightProperty;
    for (const tile of this.props.tiles) {
      for (const tileLayer of tile.layers) {
        const binary = tileLayer.features;
        if (binary.featureCount === 0) continue;
        const base = tileKey(tile);
        for (let chIdx = 0; chIdx < channels.length; chIdx++) {
          const key = `${base}::${chIdx}`;
          if (s.tileChannelData.has(key)) continue;
          const built = buildTileChannelData(
            binary,
            channels[chIdx],
            chIdx,
            weightProp,
            this.props.layerTimeOffset,
          );
          if (built) {
            // Upload the GPU buffers ONCE, here on first sight of this
            // (tile, channel), so draw() can reuse them every frame.
            const device = this.context.device;
            built.gpu = {
              posBuf: device.createBuffer({ data: built.instancePosition, usage: 0x0020 }),
              timeBuf: device.createBuffer({ data: built.instanceTime, usage: 0x0020 }),
              weightBuf: device.createBuffer({ data: built.instanceWeight, usage: 0x0020 }),
              channelBuf: device.createBuffer({ data: built.instanceChannel, usage: 0x0020 }),
            };
            s.tileChannelData.set(key, built);
          }
        }
      }
    }
  }
}

function tileKey(tile: Tile): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}`;
}

/**
 * Build the per-(tile, channel) typed arrays. Filters out features that
 * don't pass the channel's category filter — those rows are simply not
 * uploaded, so the GPU does no work culling them.
 */
function buildTileChannelData(
  binary: BinaryFeatures,
  channel: ResolvedChannel,
  channelIndex: number,
  weightProp: string | undefined,
  layerTimeOffset: number,
): PerTileChannelData | null {
  let mask: Uint8Array | null = null;
  let n = binary.featureCount;
  if (channel.categoryFilter) {
    const cat = binary.categoricalProps[channel.categoryFilter.property];
    if (!cat) return null;
    const allowed = new Set<number>();
    for (let i = 0; i < cat.categories.length; i++) {
      if (channel.categoryFilter.values.indexOf(cat.categories[i]) !== -1) {
        allowed.add(i);
      }
    }
    if (allowed.size === 0) return null;
    mask = new Uint8Array(binary.featureCount);
    n = 0;
    for (let i = 0; i < binary.featureCount; i++) {
      if (allowed.has(cat.indices[i])) {
        mask[i] = 1;
        n++;
      }
    }
    if (n === 0) return null;
  }

  const dims = binary.positionDimensions ?? 2;
  const instancePosition = new Float32Array(n * 3);
  const instanceTime = new Float32Array(n * 2);
  const instanceWeight = new Float32Array(n);
  const instanceChannel = new Float32Array(n);
  const weightSrc = weightProp ? binary.numericProps[weightProp] : null;
  const tileToLayerDelta = binary.timeOffset - layerTimeOffset;
  const chFloat = channelIndex;
  const perChannelIntensity = channel.intensity;

  let dst = 0;
  for (let i = 0; i < binary.featureCount; i++) {
    if (mask && !mask[i]) continue;
    const srcIdx = i * dims;
    instancePosition[dst * 3] = binary.positions[srcIdx];
    instancePosition[dst * 3 + 1] = binary.positions[srcIdx + 1];
    instancePosition[dst * 3 + 2] = 0;
    instanceTime[dst * 2] = binary.startTimes[i] + tileToLayerDelta;
    instanceTime[dst * 2 + 1] = binary.endTimes[i] + tileToLayerDelta;
    instanceWeight[dst] = (weightSrc ? weightSrc[i] : 1) * perChannelIntensity;
    instanceChannel[dst] = chFloat;
    dst++;
  }

  return {
    instancePosition,
    instanceTime,
    instanceWeight,
    instanceChannel,
    vertexCount: n,
    channelIndex,
    channelId: channel.id,
  };
}

/** Build a 256-entry RGBA8 palette by linearly interpolating between stops. */
function buildPaletteRgba8(range: Color[]): Uint8Array {
  const data = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (range.length - 1);
    const a = Math.floor(t);
    const b = Math.min(range.length - 1, a + 1);
    const f = t - a;
    const ca = range[a];
    const cb = range[b];
    data[i * 4] = Math.round((ca[0] ?? 0) * (1 - f) + (cb[0] ?? 0) * f);
    data[i * 4 + 1] = Math.round((ca[1] ?? 0) * (1 - f) + (cb[1] ?? 0) * f);
    data[i * 4 + 2] = Math.round((ca[2] ?? 0) * (1 - f) + (cb[2] ?? 0) * f);
    data[i * 4 + 3] = Math.round((ca[3] ?? 255) * (1 - f) + (cb[3] ?? 255) * f);
  }
  return data;
}

/* ────────────────────────────────────────────────────────────────────── */
/* Composite wrapper                                                      */
/* ────────────────────────────────────────────────────────────────────── */

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

  private boundGetTime = () => this.getCurrentTime();

  renderLayers(): DeckLayer[] {
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) return [];

    const channels = this.resolveChannels();
    if (channels.length === 0) return [];

    const layerTimeOffset = pickLayerTimeOffset(tiles);

    return [
      new HeatmapSplatSublayer({
        id: `${this.props.id}-splat`,
        tiles,
        layerTimeOffset,
        getTime: this.boundGetTime,
        timeWindow: this.props.timeWindow ?? 86_400_000,
        radiusPixels: this.props.radiusPixels ?? 30,
        intensity: this.props.intensity ?? 1,
        threshold: this.props.threshold ?? 0.05,
        channels,
        fadeInDuration: this.props.fadeInDuration ?? 0,
        fadeOutDuration: this.props.fadeOutDuration ?? 0,
        weightProperty: this.props.weightProperty,
        opacity: this.props.opacity ?? 1,
        visible: this.props.visible ?? true,
      } as any),
    ];
  }

  private resolveChannels(): ResolvedChannel[] {
    const { channels } = this.props;
    if (channels && channels.length > 0) {
      if (channels.length > 4) {
        warnOnce(
          'HeatmapLayer:tooManyChannels',
          `[HeatmapLayer] only the first 4 channels are rendered (got ${channels.length}).`,
        );
      }
      return channels.slice(0, 4).map((ch) => ({
        id: ch.id,
        intensity: ch.intensity ?? 1,
        colorRange: ch.colorRange ?? DEFAULT_COLOR_RANGE,
        colorDomain: ch.colorDomain ?? this.archiveHeatmapDomain(ch.id) ?? [0, 1],
        categoryFilter: ch.categoryFilter,
      }));
    }
    return [
      {
        id: 'default',
        intensity: 1,
        colorRange: this.props.colorRange ?? DEFAULT_COLOR_RANGE,
        colorDomain:
          this.props.colorDomain ??
          this.archiveHeatmapDomain('default') ??
          [0, 1],
      },
    ];
  }

  /**
   * Pull the per-class intensity domain baked at build time from archive
   * metadata (Phase B). Returns null when the archive predates the field.
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

function pickLayerTimeOffset(tiles: Tile[]): number {
  for (const tile of tiles) {
    for (const layer of tile.layers) {
      return layer.features.timeOffset;
    }
  }
  return 0;
}

/**
 * H3SummaryLayer — render the SERVER-AGGREGATED summary tier as H3 hexagons.
 *
 * The summary tier collapses 100M+ raw features into one row per H3 cell
 * (with `count` + per-column aggregates) at the server side, then ships those
 * rows as Arrow tiles indexed by (zoom, x, y, time-bucket) just like the
 * raw tier. At low zooms this is the ONLY way to render a planet-scale
 * point dataset in real time — the raw tier would push hundreds of millions
 * of points through the GPU every frame.
 *
 * Each summary tile carries:
 * - `id`     — H3 cell index, encoded as a u64 (carried by Arrow's UInt64
 *              `id` column and exposed on `BinaryFeatures.featureIds`).
 * - `count`  — feature count for that cell.
 * - `<agg>_<col>` — one numeric column per aggregated attribute.
 *
 * The layer wraps deck.gl's H3HexagonLayer (from `@deck.gl/geo-layers`),
 * giving us highPrecision-aware polygon rendering, GPU-side picking, and
 * the standard extruded/coverage style props.
 *
 * Coloring: by default we hand `colorRange + colorDomain` to a built-in
 * ramp that quantises `count` (or the configured `weightProperty`) into N
 * color buckets. Callers can also pass a `getFillColor` callback for
 * fully-custom styling.
 */

import { CompositeLayer } from '@deck.gl/core';
import type {
  Color,
  CompositeLayerProps,
  Layer,
  LayerContext,
  UpdateParameters,
} from '@deck.gl/core';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { STTArchive, SpatiotemporalTileset } from '@stt/core';
import type {
  ArchiveMetadata,
  BoundingBox,
  Tile,
  TileId,
} from '@stt/core';
import { splitLongToH3Index } from 'h3-js';
import { TimeController } from './time-controller';

const DEBUG = false;

export interface H3SummaryLayerProps extends CompositeLayerProps {
  /** URL to the STT archive. */
  data: string;

  /** Current display time (Unix ms). */
  currentTime: number;

  /** Time window (ms) centred on `currentTime`. */
  timeWindow?: number;

  /** Optional shared TimeController. */
  timeController?: TimeController;

  /** Maximum concurrent tile requests. */
  maxRequests?: number;

  /** Debounce ms for viewport-driven tile updates. */
  debounceTime?: number;

  /** Maximum number of decoded tiles to keep cached. */
  maxCacheSize?: number;

  /**
   * Numeric property the color ramp + extrusion height are driven by.
   * Defaults to `'count'` (the implicit cell-count column). Any aggregated
   * column from the summary tier is also valid (`'mean_magnitude'`,
   * `'sum_value'`, ...).
   */
  weightProperty?: string;

  /**
   * 6-stop low→high color ramp. Each entry is RGBA (0-255). Used together
   * with `colorDomain` to bucket the weight column.
   */
  colorRange?: Color[];

  /**
   * `[min, max]` for the color ramp. Setting this pins the legend stable
   * across tiles and zoom changes (recommended). When unset, every tile's
   * own min/max drives the ramp — visually unstable.
   */
  colorDomain?: [number, number];

  /** Extrusion enabled? Defaults to false (flat hexagons). */
  extruded?: boolean;

  /** Extrusion scale (meters per weight unit). Only used when `extruded`. */
  elevationScale?: number;

  /**
   * Coverage of each hex in its cell (0..1). Lower values leave a gap
   * between adjacent hexes — useful for a heatmap-style look at low zooms.
   */
  coverage?: number;

  /** Fired when an archive's tiles are first loaded. */
  onMetadataLoad?: (meta: ArchiveMetadata) => void;
}

interface H3SummaryLayerState {
  archive: STTArchive | null;
  tileset: SpatiotemporalTileset | null;
  metadata: ArchiveMetadata | null;
  tiles: Tile[];
  frameNumber: number;
  playStateHandler?: (playing: boolean, speed: number) => void;
  tickHandler?: (time: number) => void;
}

const DEFAULT_COLOR_RANGE: Color[] = [
  [255, 255, 204, 220],
  [199, 233, 180, 230],
  [127, 205, 187, 235],
  [65, 182, 196, 240],
  [44, 127, 184, 245],
  [37, 52, 148, 255],
];

/**
 * Cached per-tile rows array. We keep the source `BinaryFeatures` reference
 * inside the row objects so callers can introspect — but the H3HexagonLayer
 * only needs the `hex` string + the weight number.
 */
interface PreparedHexRow {
  /** H3 cell index as a string (h3-js's canonical form). */
  hex: string;
  /** Raw weight column value. */
  weight: number;
}

interface PreparedTile {
  tileKey: string;
  rows: PreparedHexRow[];
  /** Cached min/max of `weight` across the tile. */
  weightMin: number;
  weightMax: number;
}

function makeTileKey(tile: Tile): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}`;
}

/**
 * Convert the BigUint64 H3 cell index at row `i` into the canonical 15-char
 * hex-string form that h3-js consumes. The Rust builder packs the full
 * cell index into the Arrow `id` UInt64 column; the TS decoder copies it
 * into `binary.featureIds64` so the high 32 bits survive.
 */
function h3IndexFromTile(
  featureIds64: BigUint64Array | undefined,
  i: number,
): string | null {
  if (!featureIds64 || i >= featureIds64.length) return null;
  const v = featureIds64[i];
  const lower = Number(v & 0xffffffffn) >>> 0;
  const upper = Number((v >> 32n) & 0xffffffffn) >>> 0;
  return splitLongToH3Index(lower, upper);
}

/**
 * Render the SERVER-AGGREGATED summary tier of an STT archive as H3
 * hexagons. Companion to {@link SpatioTemporalLayer} for the raw tier.
 */
export class H3SummaryLayer extends CompositeLayer<H3SummaryLayerProps> {
  static layerName = 'H3SummaryLayer';

  static defaultProps = {
    data: { type: 'string', value: '', compare: true },
    currentTime: { type: 'number', value: Date.now(), compare: true },
    timeWindow: { type: 'number', value: 86_400_000, compare: false },
    timeController: { type: 'object', value: null, compare: false },
    maxRequests: { type: 'number', value: 12, compare: false },
    debounceTime: { type: 'number', value: 0, compare: false },
    maxCacheSize: { type: 'number', value: 500, compare: false },
    weightProperty: { type: 'string', value: 'count', compare: true },
    colorRange: { type: 'array', value: DEFAULT_COLOR_RANGE, compare: true },
    colorDomain: { type: 'array', value: null, compare: true, optional: true },
    extruded: { type: 'boolean', value: false, compare: true },
    elevationScale: { type: 'number', value: 1, compare: false },
    coverage: { type: 'number', value: 0.92, min: 0, max: 1, compare: false },
    onMetadataLoad: { type: 'function', value: null, optional: true },
  };

  declare state: H3SummaryLayerState & { [key: string]: unknown };

  /** Per-tile prepared-data cache. Pruned to the live tile set every render. */
  private preparedTileCache = new Map<string, PreparedTile>();

  initializeState(_context: LayerContext): void {
    const playStateHandler = (playing: boolean, speed: number) => {
      const { tileset } = this.state;
      tileset?.setAnimationState(playing, speed);
    };
    const tickHandler = (time: number) => {
      this._handleTimeUpdate(time);
    };

    this.setState({
      archive: null,
      tileset: null,
      metadata: null,
      tiles: [],
      frameNumber: 0,
      playStateHandler,
      tickHandler,
    });

    if (this.props.timeController) {
      this.props.timeController.on('playState', playStateHandler);
      this.props.timeController.on('tick', tickHandler);
    }

    this._initArchiveAndTileset();
  }

  finalizeState(_context: LayerContext): void {
    if (this.props.timeController) {
      if (this.state.playStateHandler) {
        this.props.timeController.off('playState', this.state.playStateHandler);
      }
      if (this.state.tickHandler) {
        this.props.timeController.off('tick', this.state.tickHandler);
      }
    }
    const { tileset, archive } = this.state;
    tileset?.finalize();
    archive?.finalize();
    this.preparedTileCache.clear();
  }

  shouldUpdateState(params: { changeFlags: { somethingChanged: boolean } }): boolean {
    return params.changeFlags.somethingChanged;
  }

  updateState(params: UpdateParameters<this>): void {
    const { oldProps } = params;
    if (oldProps?.data !== this.props.data && oldProps?.data !== undefined) {
      this._initArchiveAndTileset();
      return;
    }
    if (oldProps?.timeController !== this.props.timeController) {
      if (oldProps?.timeController) {
        if (this.state.playStateHandler) {
          oldProps.timeController.off('playState', this.state.playStateHandler);
        }
        if (this.state.tickHandler) {
          oldProps.timeController.off('tick', this.state.tickHandler);
        }
      }
      if (this.props.timeController) {
        if (this.state.playStateHandler) {
          this.props.timeController.on('playState', this.state.playStateHandler);
        }
        if (this.state.tickHandler) {
          this.props.timeController.on('tick', this.state.tickHandler);
        }
      }
    }
    this._updateTileset();
  }

  private _handleTimeUpdate(time: number): void {
    const { tileset } = this.state;
    if (!tileset) return;
    const viewport = this.context.viewport;
    if (!viewport) return;
    const bounds = this._getBounds(viewport);
    const zoom = this._getZoom(viewport);
    tileset.update(
      {
        bounds,
        zoom,
        time,
        timeWindow: this.props.timeWindow ?? 86_400_000,
      },
      true,
    );
    const newTiles = tileset.getVisibleTiles();
    // Only setState when the tile set actually changes — every other tick
    // is a redraw-only.
    if (newTiles.length !== this.state.tiles.length) {
      this.setState({
        tiles: newTiles,
        frameNumber: this.state.frameNumber + 1,
      });
    } else {
      this.setNeedsRedraw();
    }
  }

  private _updateTileset(): void {
    const { tileset } = this.state;
    if (!tileset) return;
    const viewport = this.context.viewport;
    if (!viewport) return;
    const bounds = this._getBounds(viewport);
    const zoom = this._getZoom(viewport);
    const time = this.props.timeController
      ? this.props.timeController.getTime()
      : this.props.currentTime;
    tileset.update({
      bounds,
      zoom,
      time,
      timeWindow: this.props.timeWindow ?? 86_400_000,
    });
    const tiles = tileset.getVisibleTiles();
    this.setState({ tiles });
  }

  private async _initArchiveAndTileset(): Promise<void> {
    const archive = new STTArchive({ url: this.props.data });
    const metadata = await archive.getMetadata();
    if (this.props.onMetadataLoad) this.props.onMetadataLoad(metadata);

    const tier = metadata.summaryTier;
    if (!tier) {
      // Archive has no summary tier — the layer renders nothing. Logging is
      // useful here because the consumer might be using H3SummaryLayer on an
      // archive that was built without `--summary-tier`.
      // eslint-disable-next-line no-console
      console.warn(
        `[H3SummaryLayer] archive ${this.props.data} has no summary tier; ` +
          'rebuild with `stt-build --summary-tier h3` to enable.',
      );
    }

    const tileset = new SpatiotemporalTileset({
      maxRequests: this.props.maxRequests ?? 12,
      debounceTime: this.props.debounceTime ?? 0,
      maxCacheSize: this.props.maxCacheSize ?? 500,
      minZoom: tier ? tier.minZoom : metadata.minZoom,
      maxZoom: tier ? tier.maxZoom : metadata.maxZoom,
      temporalBucketMs: metadata.temporalBucketMs,
      tier: 'summary',
      summaryZoomRange: tier
        ? { minZoom: tier.minZoom, maxZoom: tier.maxZoom }
        : undefined,
      refinementStrategy: 'no-overlap',
      enablePrefetch: true,
      getAvailableTiles: (bounds, zoom, timeRange) =>
        archive.getTileIdsInBounds(bounds, zoom, timeRange),
      getAvailableSummaryTiles: (bounds, zoom, timeRange) =>
        archive.getSummaryTileIdsInBounds(bounds, zoom, timeRange),
      getTileData: (tileId, _signal) => archive.getTile(tileId),
    });

    this.setState({ archive, tileset, metadata });
  }

  private _getBounds(viewport: any): BoundingBox {
    const [minLon, minLat] = viewport.unproject([0, viewport.height]);
    const [maxLon, maxLat] = viewport.unproject([viewport.width, 0]);
    return {
      minLon: Math.max(-180, minLon),
      minLat: Math.max(-90, minLat),
      maxLon: Math.min(180, maxLon),
      maxLat: Math.min(90, maxLat),
    };
  }

  private _getZoom(viewport: any): number {
    const z = Math.floor(viewport.zoom);
    const { metadata } = this.state;
    const tier = metadata?.summaryTier;
    if (tier) {
      return Math.max(tier.minZoom, Math.min(tier.maxZoom, z));
    }
    return z;
  }

  /**
   * Build (or fetch from cache) the per-tile data array consumed by
   * H3HexagonLayer. One entry per cell: { hex, weight }.
   */
  private prepareTile(tile: Tile, weightProp: string): PreparedTile | null {
    const tileKey = `${makeTileKey(tile)}:${weightProp}`;
    const cached = this.preparedTileCache.get(tileKey);
    if (cached) return cached;

    // Find the summary layer in the tile. Defensive: tile-decoder.worker may
    // hand us tiles whose only layer is the raw layer (e.g. on a
    // zoom-out-then-zoom-in race). We just skip those.
    const summaryLayerName =
      this.state.metadata?.summaryTier?.layerName ?? 'summary';
    const layer = tile.layers.find((l) => l.name === summaryLayerName);
    if (!layer) return null;
    const binary = layer.features;
    const n = binary.featureCount;
    if (n === 0) return null;

    // The Arrow `id` column is UInt64 in the writer; the decoder preserves
    // the high 32 bits on `featureIds64`. H3 cells at resolution ≥ 7 need
    // the full u64. The 32-bit `featureIds` is still populated but only
    // carries the low half — we deliberately do NOT use it here.
    const featureIds64 = binary.featureIds64;

    const weights = binary.numericProps[weightProp];
    if (!weights) {
      if (DEBUG) {
        console.warn(`[H3SummaryLayer] tile missing weight property '${weightProp}'`);
      }
      return null;
    }

    const rows: PreparedHexRow[] = [];
    let weightMin = Infinity;
    let weightMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const hex = h3IndexFromTile(featureIds64, i);
      if (!hex) continue;
      const w = weights[i];
      rows.push({ hex, weight: w });
      if (w < weightMin) weightMin = w;
      if (w > weightMax) weightMax = w;
    }
    if (rows.length === 0) return null;

    const prepared: PreparedTile = {
      tileKey,
      rows,
      weightMin: weightMin === Infinity ? 0 : weightMin,
      weightMax: weightMax === -Infinity ? 0 : weightMax,
    };
    this.preparedTileCache.set(tileKey, prepared);
    return prepared;
  }

  /**
   * Quantise `value` into a color from `colorRange`, using the active
   * color domain. Returns the last colour for values above the domain max.
   */
  private rampColor(value: number, domain: [number, number]): Color {
    const range = this.props.colorRange ?? DEFAULT_COLOR_RANGE;
    const [lo, hi] = domain;
    if (!Number.isFinite(value) || hi <= lo) return range[0];
    const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
    const idx = Math.min(range.length - 1, Math.floor(t * range.length));
    return range[idx];
  }

  renderLayers(): Layer[] {
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) return [];

    const weightProp = this.props.weightProperty ?? 'count';

    // Prune the prepared cache to the live tile set.
    const live = new Set<string>();
    for (const tile of tiles) live.add(`${makeTileKey(tile)}:${weightProp}`);
    for (const key of this.preparedTileCache.keys()) {
      if (!live.has(key)) this.preparedTileCache.delete(key);
    }

    const out: Layer[] = [];
    // Resolve the color domain ONCE per render. When the caller pins it via
    // props we use that; otherwise we fall back to the max across visible
    // tiles. The fallback gives a usable display out of the box but is
    // visually unstable when tiles stream in — pinning is recommended.
    let domain: [number, number];
    if (this.props.colorDomain) {
      domain = this.props.colorDomain;
    } else {
      let lo = Infinity;
      let hi = -Infinity;
      for (const tile of tiles) {
        const prepared = this.prepareTile(tile, weightProp);
        if (!prepared) continue;
        if (prepared.weightMin < lo) lo = prepared.weightMin;
        if (prepared.weightMax > hi) hi = prepared.weightMax;
      }
      domain = [
        Number.isFinite(lo) ? lo : 0,
        Number.isFinite(hi) ? hi : 1,
      ];
    }

    for (const tile of tiles) {
      const prepared = this.prepareTile(tile, weightProp);
      if (!prepared) continue;
      const layer = new H3HexagonLayer<PreparedHexRow>({
        id: `${this.props.id}-${prepared.tileKey}`,
        data: prepared.rows,
        // Use the cached prepared rows reference so deck.gl can short-circuit
        // re-upload when only style props changed.
        dataComparator: (a: any, b: any) => a === b,
        getHexagon: (d: PreparedHexRow) => d.hex,
        getFillColor: (d: PreparedHexRow) => this.rampColor(d.weight, domain),
        getElevation: this.props.extruded
          ? (d: PreparedHexRow) => d.weight * (this.props.elevationScale ?? 1)
          : 0,
        extruded: !!this.props.extruded,
        coverage: this.props.coverage ?? 0.92,
        pickable: !!this.props.pickable,
        opacity: this.props.opacity ?? 1,
        // updateTriggers ensures deck.gl rebuilds the fill-color and elevation
        // buffers when the props they read from change.
        updateTriggers: {
          getFillColor: [
            domain[0],
            domain[1],
            this.props.colorRange,
            weightProp,
          ],
          getElevation: [this.props.extruded, this.props.elevationScale],
        },
      });
      out.push(layer);
    }
    return out;
  }
}

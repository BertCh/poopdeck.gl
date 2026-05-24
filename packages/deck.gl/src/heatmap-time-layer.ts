/**
 * HeatmapTimeLayer - Temporal heatmap visualization
 * 
 * Aggregates point data into a density heatmap that animates over time.
 * Uses GPU acceleration for real-time aggregation.
 * 
 * PERFORMANCE OPTIMIZED:
 * - Caches extracted points per tile to avoid re-extraction
 * - Only recomputes visible points when tile set changes
 * - Uses typed arrays for position/weight data
 * - Layer instance cached and reused when point count stable
 */

import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import type { Color, Layer, LayerContext, Position } from '@deck.gl/core';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
import type { BinaryFeatures, Tile } from '@stt/core';

/**
 * Cached point data from a single tile layer (all points, not time-filtered)
 *
 * Times are stored as plain JS-number arrays of ABSOLUTE epoch-ms. They are
 * NOT Float32Array: absolute epoch-ms (~1.7e12) overflows float32's 24-bit
 * mantissa (quantizing to ~131s buckets). Filtering here happens on the CPU
 * in JS doubles, so plain number[] keeps full precision.
 */
interface CachedTilePoints {
  positions: Float64Array;  // Interleaved [lon, lat, lon, lat, ...]
  weights: Float32Array;
  startTimes: Float64Array; // Absolute times (epoch-ms) - Float64 for precision
  endTimes: Float64Array;   // Absolute times (epoch-ms) - Float64 for precision
  count: number;
}

// Cache for extracted points per tile layer (keyed by binary features instance)
const tilePointsCache = new WeakMap<BinaryFeatures, CachedTilePoints>();

/**
 * Per-tile, per-filter cache of the feature indices that pass the filter.
 * The inner Map is keyed by a serialized filter spec — when two stacked
 * heatmaps with different filters (e.g. pickups + dropoffs) share the same
 * tile, both entries coexist.
 *
 * A `null` entry means "this tile is missing the filter property", so callers
 * can early-out without re-checking. The Uint32Array entry is the dense list
 * of feature indices that match; the per-frame loop walks it directly,
 * cutting work proportionally to filter selectivity (~3× for a 3-category
 * column where we keep 1 value).
 */
const filteredIndicesCache = new WeakMap<
  BinaryFeatures,
  Map<string, Uint32Array | null>
>();

function filterCacheKey(filter: { property: string; values: string[] }): string {
  // Deterministic key — sort values so {a,b} and {b,a} share an entry.
  return filter.property + '\0' + [...filter.values].sort().join('\0');
}

export interface HeatmapTimeLayerProps extends SpatioTemporalLayerProps {
  /** Radius of influence in pixels */
  radiusPixels?: number;

  /** Intensity multiplier for each point */
  intensity?: number;

  /** Aggregation method for overlapping points */
  aggregation?: 'SUM' | 'MEAN';

  /** Color range from low to high density */
  colorRange?: Color[];

  /** Property name for weight values (if using a numeric property) */
  weightProperty?: string;

  /**
   * Optional categorical filter. Only features whose `categoricalProps[property]`
   * value is in `values` contribute to the heatmap. Tiles missing the property
   * are skipped. Used for splitting one source into multiple heatmaps (e.g.
   * pickup vs dropoff stacks on the NYC taxi dataset).
   */
  categoryFilter?: { property: string; values: string[] };

  /**
   * Explicit `[min, max]` weight range. Forwarded to the underlying deck.gl
   * `HeatmapLayer.colorDomain`. **Big perf win for animated heatmaps**: when
   * unset, deck.gl runs an auto-detection pass each time the weight map is
   * rebuilt, which during animation translates to constant GPU work + a
   * readPixels-style sync to compute the max. Setting it pins the ramp and
   * lets deck.gl skip that work entirely.
   */
  colorDomain?: [number, number] | null;

  /**
   * Forwarded to deck.gl `HeatmapLayer.debounceTimeout` (ms). Controls how
   * often the weight-map texture is rebuilt during continuous prop/data
   * changes. Default 500 is too eager for time-animated heatmaps where the
   * underlying data changes every frame — push to 1000-2000 to amortize.
   */
  debounceTimeout?: number;
}

/**
 * Temporal heatmap layer
 * 
 * Performance optimizations:
 * - Caches all points per tile (extracted once on tile load)
 * - Only time-filtering loop runs per frame (no object creation)
 * - Uses flat typed arrays for minimal memory churn
 * - Caches layer instance for reuse
 */
export class HeatmapTimeLayer extends SpatioTemporalLayer<HeatmapTimeLayerProps> {
  static layerName = 'HeatmapTimeLayer';

  static defaultProps = {
    ...SpatioTemporalLayer.defaultProps,
    // HeatmapLayer props
    radiusPixels: { type: 'number', value: 30, min: 1 },
    intensity: { type: 'number', value: 1, min: 0 },
    aggregation: 'SUM',
    colorRange: {
      type: 'array',
      value: [
        [255, 255, 178, 255],
        [254, 217, 118, 255],
        [254, 178, 76, 255],
        [253, 141, 60, 255],
        [252, 78, 42, 255],
        [227, 26, 28, 255],
        [177, 0, 38, 255],
      ] as Color[],
      compare: true,
    },
    weightProperty: null,
    categoryFilter: { type: 'object', value: null, compare: true },
    colorDomain: { type: 'array', value: null, optional: true, compare: true },
    debounceTimeout: { type: 'number', value: 1000, min: 0 },
  };
  
  // Reusable arrays to avoid per-frame allocation.
  private visiblePositions: Float64Array = new Float64Array(0);
  private visibleWeights: Float32Array = new Float32Array(0);

  // Cached layer instance + the data object backing it. Both references stay
  // stable between refilters so deck.gl short-circuits attribute uploads.
  private cachedLayer: HeatmapLayer | null = null;
  private cachedData: { length: number; attributes: Record<string, { value: any; size: number }> } | null = null;

  // Throttle state for filterVisiblePoints. During playback we re-filter only
  // when sim time advances by `> timeWindow * FILTER_TIME_FRACTION` since the
  // last pass, or when the tile set changes. Without this, every animation
  // frame (60+ Hz) ran an O(features) filter loop and bumped deck.gl's
  // updateTriggers, forcing per-frame GPU reupload + weight-texture rebuild
  // even with `debounceTimeout` set on HeatmapLayer.
  private lastFilterTime: number = Number.NaN;
  private lastFilterTilesRef: Tile[] | null = null;
  private lastVisibleCount: number = 0;

  /**
   * Re-filter when time advances by at least 2.5% of the time window. Matches
   * the cadence of the parent SpatioTemporalLayer's tileset-update throttle
   * (5%) but tighter, since heatmap motion is the visible animation and we
   * want it smoother than the tile churn. At ~40Hz visual updates the human
   * eye can no longer distinguish individual frame jumps in an aggregated
   * density field.
   */
  private static readonly FILTER_TIME_FRACTION = 0.025;

  /**
   * Monotonic counter bumped only when the filtered output actually changed
   * (tiles change OR throttled time-advance). Used as the `updateTriggers`
   * value so deck.gl invalidates GPU buffers ONLY on real content changes,
   * not every animation tick.
   */
  private contentVersion: number = 0;

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.cachedLayer = null;
    this.cachedData = null;
    this.lastFilterTilesRef = null;
  }

  renderLayers(): Layer[] {
    const { tiles } = this.state;
    const currentTime = this.getCurrentTime();

    if (!tiles || tiles.length === 0) {
      this.cachedLayer = null;
      this.cachedData = null;
      this.lastFilterTilesRef = null;
      this.lastVisibleCount = 0;
      return [];
    }

    const timeWindow = this.props.timeWindow || 86400000;
    const filterThreshold = timeWindow * HeatmapTimeLayer.FILTER_TIME_FRACTION;
    const tilesChanged = this.lastFilterTilesRef !== tiles;
    const timeAdvanced =
      !Number.isFinite(this.lastFilterTime) ||
      Math.abs(currentTime - this.lastFilterTime) > filterThreshold;

    if (tilesChanged || timeAdvanced) {
      const halfWindow = timeWindow / 2;
      const visibleCount = this.filterVisiblePoints(
        tiles,
        currentTime - halfWindow,
        currentTime + halfWindow,
      );
      this.lastFilterTime = currentTime;
      this.lastFilterTilesRef = tiles;
      this.lastVisibleCount = visibleCount;
      this.contentVersion++;
      // Fresh `data` object so deck.gl detects the change via reference
      // inequality (the underlying typed arrays are reused in place; the
      // updateTriggers below are the authoritative invalidation signal).
      this.cachedData = {
        length: visibleCount,
        attributes: {
          getPosition: { value: this.visiblePositions, size: 2 },
          getWeight: { value: this.visibleWeights, size: 1 },
        },
      };
      // Layer instance must be rebuilt so the new `data` ref + updateTriggers
      // value land in deck.gl's prop-diff.
      this.cachedLayer = null;
    }

    if (this.lastVisibleCount === 0 || !this.cachedData) {
      return [];
    }

    // Between refilters: same layer instance. deck.gl short-circuits its
    // entire prop-diff + attribute pipeline when the layer reference is
    // unchanged, so paused playback and intra-throttle ticks cost nothing.
    //
    // On refilter the block above cleared cachedLayer and we build a new
    // HeatmapLayer. NOTE: deck.gl's HeatmapLayer GPU aggregation is the hard
    // floor here — even with .clone() over a persistent shell instance, the
    // weight-texture rebuild on data change costs hundreds of ms for ~100k+
    // points. Tried shell+clone (measured no improvement over fresh new()).
    // The architectural fix is a custom temporal-heatmap layer that uploads
    // ALL points once with per-point timestamps and time-filters in the
    // splat shader; tracked as a follow-up.
    if (this.cachedLayer) {
      return [this.cachedLayer];
    }

    this.cachedLayer = new HeatmapLayer({
      id: `${this.props.id}-heatmap`,
      data: this.cachedData,
      // Accessors are required by HeatmapLayer's prop schema but never fire
      // when the binary attributes interface above provides the same value.
      getPosition: this.boundGetPosition,
      getWeight: this.boundGetWeight,
      radiusPixels: this.props.radiusPixels,
      intensity: this.props.intensity,
      aggregation: this.props.aggregation,
      colorRange: this.props.colorRange,
      // Pin the color domain when caller supplied one — skips per-frame
      // max-weight auto-detection inside deck.gl's HeatmapLayer.
      ...(this.props.colorDomain ? { colorDomain: this.props.colorDomain } : {}),
      debounceTimeout: this.props.debounceTimeout,
      opacity: this.props.opacity,
      visible: this.props.visible,
      // Trigger only on real content change. Previously `[currentTime,
      // tiles.length]` fired every animation tick (60+ Hz) and forced a
      // full attribute pipeline + weight-texture rebuild every frame.
      updateTriggers: {
        getPosition: this.contentVersion,
        getWeight: this.contentVersion,
      },
    });
    return [this.cachedLayer];
  }

  // Stable accessor references so HeatmapLayer's prop-diff sees identical
  // function refs across renders (defense in depth — these almost never fire
  // because the binary attributes path is preferred).
  private readonly boundGetPosition = (_d: any, ctx: { index: number }): Position =>
    [
      this.visiblePositions[ctx.index * 2],
      this.visiblePositions[ctx.index * 2 + 1],
    ] as Position;
  private readonly boundGetWeight = (_d: any, ctx: { index: number }): number =>
    this.visibleWeights[ctx.index];
  
  /**
   * Filter visible points from all tiles based on time window.
   * Uses cached tile point data and reuses output arrays. Returns the number
   * of visible points.
   *
   * Single-pass: we size buffers to the worst-case total feature count of all
   * loaded tiles (cheap; just a sum of tile.count). That's almost always close
   * to the actual visible count anyway and lets us avoid walking every feature
   * twice. The previous two-pass version dominated frame cost for stacked
   * heatmaps.
   */
  private filterVisiblePoints(
    tiles: Tile[],
    timeStart: number,
    timeEnd: number
  ): number {
    const filter = this.props.categoryFilter;
    const filterKey = filter ? filterCacheKey(filter) : null;

    // Worst-case sizing: sum of all cached feature counts. For filtered layers
    // this overshoots, but a Float64Array allocation is cheap and we'll only
    // grow it, never shrink — so the buffer stabilizes after a few frames.
    let worstCase = 0;
    for (const tile of tiles) {
      for (const layer of tile.layers) {
        worstCase += this.getCachedTilePoints(layer.features).count;
      }
    }
    if (worstCase === 0) return 0;

    if (this.visiblePositions.length < worstCase * 2) {
      this.visiblePositions = new Float64Array(worstCase * 2);
    }
    if (this.visibleWeights.length < worstCase) {
      this.visibleWeights = new Float32Array(worstCase);
    }

    const positions = this.visiblePositions;
    const weights = this.visibleWeights;
    let outIdx = 0;

    for (const tile of tiles) {
      for (const layer of tile.layers) {
        const cached = this.getCachedTilePoints(layer.features);

        if (filter) {
          const filtered = this.getFilteredIndices(layer.features, filter, filterKey!);
          if (!filtered) continue; // tile missing the property
          // Loop only over feature indices that already match the filter.
          for (let k = 0; k < filtered.length; k++) {
            const i = filtered[k];
            if (cached.endTimes[i] >= timeStart && cached.startTimes[i] <= timeEnd) {
              positions[outIdx * 2] = cached.positions[i * 2];
              positions[outIdx * 2 + 1] = cached.positions[i * 2 + 1];
              weights[outIdx] = cached.weights[i];
              outIdx++;
            }
          }
        } else {
          for (let i = 0; i < cached.count; i++) {
            if (cached.endTimes[i] >= timeStart && cached.startTimes[i] <= timeEnd) {
              positions[outIdx * 2] = cached.positions[i * 2];
              positions[outIdx * 2 + 1] = cached.positions[i * 2 + 1];
              weights[outIdx] = cached.weights[i];
              outIdx++;
            }
          }
        }
      }
    }

    return outIdx;
  }

  /**
   * Build (and memoize per tile + filter) the dense list of feature indices
   * whose categorical value matches the filter. Returns null when the tile
   * doesn't carry the property at all.
   */
  private getFilteredIndices(
    binary: BinaryFeatures,
    filter: { property: string; values: string[] },
    key: string
  ): Uint32Array | null {
    let perTile = filteredIndicesCache.get(binary);
    if (perTile) {
      const hit = perTile.get(key);
      if (hit !== undefined) return hit;
    } else {
      perTile = new Map();
      filteredIndicesCache.set(binary, perTile);
    }

    const cat = binary.categoricalProps[filter.property];
    if (!cat) {
      perTile.set(key, null);
      return null;
    }

    // Map allowed category strings → integer indices (typically 1-3 entries).
    const allowed: number[] = [];
    for (let i = 0; i < cat.categories.length; i++) {
      if (filter.values.indexOf(cat.categories[i]) !== -1) allowed.push(i);
    }
    if (allowed.length === 0) {
      const empty = new Uint32Array(0);
      perTile.set(key, empty);
      return empty;
    }

    // Two-pass build: count, allocate exact size, then fill. Fast inner loop
    // — branch is `allowed.indexOf(catIdx)` on a tiny array, JIT-friendly.
    const indices = cat.indices;
    const n = indices.length;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (allowed.indexOf(indices[i]) !== -1) count++;
    }
    const out = new Uint32Array(count);
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (allowed.indexOf(indices[i]) !== -1) out[k++] = i;
    }
    perTile.set(key, out);
    return out;
  }
  
  /**
   * Get or create cached point data for a tile layer.
   * Extracts positions, weights, and times once per tile.
   */
  private getCachedTilePoints(binary: BinaryFeatures): CachedTilePoints {
    let cached = tilePointsCache.get(binary);
    if (cached) {
      return cached;
    }
    
    const dims = binary.positionDimensions ?? 2;
    const weightProp = this.props.weightProperty;
    const weightValues = weightProp ? binary.numericProps[weightProp] : null;
    
    const positions = new Float64Array(binary.featureCount * 2);
    const weights = new Float32Array(binary.featureCount);
    // Float64 so absolute epoch-ms keeps full precision (see CachedTilePoints).
    const startTimes = new Float64Array(binary.featureCount);
    const endTimes = new Float64Array(binary.featureCount);
    
    for (let i = 0; i < binary.featureCount; i++) {
      const posIdx = i * dims;
      positions[i * 2] = binary.positions[posIdx];
      positions[i * 2 + 1] = binary.positions[posIdx + 1];
      weights[i] = weightValues ? weightValues[i] : 1;
      startTimes[i] = binary.timeOffset + binary.startTimes[i];
      endTimes[i] = binary.timeOffset + binary.endTimes[i];
    }
    
    cached = { positions, weights, startTimes, endTimes, count: binary.featureCount };
    tilePointsCache.set(binary, cached);
    return cached;
  }
}

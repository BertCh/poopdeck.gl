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
import { SpatioTemporalLayer } from './spatiotemporal-layer';
// Cache for extracted points per tile layer (keyed by binary features instance)
const tilePointsCache = new WeakMap();
/**
 * Temporal heatmap layer
 *
 * Performance optimizations:
 * - Caches all points per tile (extracted once on tile load)
 * - Only time-filtering loop runs per frame (no object creation)
 * - Uses flat typed arrays for minimal memory churn
 * - Caches layer instance for reuse
 */
export class HeatmapTimeLayer extends SpatioTemporalLayer {
    constructor() {
        super(...arguments);
        // Reusable arrays to avoid per-frame allocation
        this.visiblePositions = new Float64Array(0);
        this.visibleWeights = new Float32Array(0);
        // Cached layer instance
        this.cachedLayer = null;
        this.cachedVisibleCount = -1;
    }
    finalizeState(context) {
        super.finalizeState(context);
        this.cachedLayer = null;
        this.cachedVisibleCount = -1;
    }
    renderLayers() {
        const { tiles, currentTime } = this.state;
        if (!tiles || tiles.length === 0) {
            this.cachedLayer = null;
            this.cachedVisibleCount = -1;
            return [];
        }
        const timeWindow = this.props.timeWindow || 86400000;
        const halfWindow = timeWindow / 2;
        const timeStart = currentTime - halfWindow;
        const timeEnd = currentTime + halfWindow;
        // Get cached points from all tiles and filter by time
        const visibleCount = this.filterVisiblePoints(tiles, timeStart, timeEnd);
        if (visibleCount === 0) {
            this.cachedLayer = null;
            this.cachedVisibleCount = -1;
            return [];
        }
        // Create data array for HeatmapLayer using the pre-filtered positions/weights
        const data = {
            length: visibleCount,
            attributes: {
                getPosition: { value: this.visiblePositions, size: 2 },
                getWeight: { value: this.visibleWeights, size: 1 },
            }
        };
        // Reuse cached layer if possible, just update data
        if (this.cachedLayer && this.cachedVisibleCount === visibleCount) {
            return [
                this.cachedLayer.clone({
                    data,
                    opacity: this.props.opacity,
                    visible: this.props.visible,
                    updateTriggers: {
                        getPosition: [currentTime, tiles.length],
                        getWeight: [currentTime, tiles.length],
                    },
                }),
            ];
        }
        // Create new layer
        const layer = new HeatmapLayer({
            id: `${this.props.id}-heatmap`,
            data,
            getPosition: (_d, { index }) => [
                this.visiblePositions[index * 2],
                this.visiblePositions[index * 2 + 1]
            ],
            getWeight: (_d, { index }) => this.visibleWeights[index],
            radiusPixels: this.props.radiusPixels,
            intensity: this.props.intensity,
            aggregation: this.props.aggregation,
            colorRange: this.props.colorRange,
            opacity: this.props.opacity,
            visible: this.props.visible,
            updateTriggers: {
                getPosition: [currentTime, tiles.length],
                getWeight: [currentTime, tiles.length],
            },
        });
        this.cachedLayer = layer;
        this.cachedVisibleCount = visibleCount;
        return [layer];
    }
    /**
     * Filter visible points from all tiles based on time window.
     * Uses cached tile point data and reuses output arrays.
     * Returns the number of visible points.
     */
    filterVisiblePoints(tiles, timeStart, timeEnd) {
        // First pass: count visible points to size arrays
        let totalVisible = 0;
        for (const tile of tiles) {
            for (const layer of tile.layers) {
                const cached = this.getCachedTilePoints(layer.features);
                for (let i = 0; i < cached.count; i++) {
                    if (cached.endTimes[i] >= timeStart && cached.startTimes[i] <= timeEnd) {
                        totalVisible++;
                    }
                }
            }
        }
        if (totalVisible === 0) {
            return 0;
        }
        // Resize arrays if needed
        if (this.visiblePositions.length < totalVisible * 2) {
            this.visiblePositions = new Float64Array(totalVisible * 2);
        }
        if (this.visibleWeights.length < totalVisible) {
            this.visibleWeights = new Float32Array(totalVisible);
        }
        // Second pass: copy visible points
        let outIdx = 0;
        for (const tile of tiles) {
            for (const layer of tile.layers) {
                const cached = this.getCachedTilePoints(layer.features);
                for (let i = 0; i < cached.count; i++) {
                    if (cached.endTimes[i] >= timeStart && cached.startTimes[i] <= timeEnd) {
                        this.visiblePositions[outIdx * 2] = cached.positions[i * 2];
                        this.visiblePositions[outIdx * 2 + 1] = cached.positions[i * 2 + 1];
                        this.visibleWeights[outIdx] = cached.weights[i];
                        outIdx++;
                    }
                }
            }
        }
        return outIdx;
    }
    /**
     * Get or create cached point data for a tile layer.
     * Extracts positions, weights, and times once per tile.
     */
    getCachedTilePoints(binary) {
        let cached = tilePointsCache.get(binary);
        if (cached) {
            return cached;
        }
        const dims = binary.positionDimensions ?? 2;
        const weightProp = this.props.weightProperty;
        const weightValues = weightProp ? binary.numericProps[weightProp] : null;
        const positions = new Float64Array(binary.featureCount * 2);
        const weights = new Float32Array(binary.featureCount);
        const startTimes = new Float32Array(binary.featureCount);
        const endTimes = new Float32Array(binary.featureCount);
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
HeatmapTimeLayer.layerName = 'HeatmapTimeLayer';
HeatmapTimeLayer.defaultProps = {
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
        ],
        compare: true,
    },
    weightProperty: null,
};
//# sourceMappingURL=heatmap-time-layer.js.map
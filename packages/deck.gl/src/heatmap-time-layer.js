/**
 * Layer for temporal heatmap visualization
 */
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import { SpatioTemporalLayer } from './spatiotemporal-layer';
/**
 * Temporal heatmap layer
 *
 * Aggregates point data into a density heatmap that animates over time.
 * Uses GPU acceleration for real-time aggregation.
 */
export class HeatmapTimeLayer extends SpatioTemporalLayer {
    renderLayers() {
        const { tiles, currentTime } = this.state;
        if (!tiles || tiles.length === 0) {
            return [];
        }
        // Extract point features
        const features = [];
        for (const tile of tiles) {
            for (const layer of tile.layers) {
                for (const feature of layer.features) {
                    if (this.isFeatureVisible(feature, currentTime)) {
                        features.push(feature);
                    }
                }
            }
        }
        // Helper to evaluate accessor (function or constant value)
        const evaluateAccessor = (accessor, feature, defaultValue) => {
            if (accessor === undefined || accessor === null) {
                return defaultValue;
            }
            if (typeof accessor === 'function') {
                return accessor(feature);
            }
            return accessor;
        };
        // Convert to heatmap data format
        const data = features.map((feature) => ({
            feature,
            position: evaluateAccessor(this.props.getPosition, feature, [0, 0]),
            weight: evaluateAccessor(this.props.getWeight, feature, 1),
        }));
        return [
            new HeatmapLayer({
                id: `${this.props.id}-heatmap`,
                data,
                getPosition: (d) => d.position,
                getWeight: (d) => d.weight,
                radiusPixels: this.props.radiusPixels,
                intensity: this.props.intensity,
                aggregation: this.props.aggregation,
                colorRange: this.props.colorRange,
                opacity: this.props.opacity,
                visible: this.props.visible,
                updateTriggers: {
                    getPosition: currentTime,
                    getWeight: currentTime,
                },
            }),
        ];
    }
    isFeatureVisible(feature, currentTime) {
        if (!feature.timeRange) {
            return true;
        }
        const timeWindow = this.props.timeWindow || 86400000;
        const windowStart = currentTime - timeWindow / 2;
        const windowEnd = currentTime + timeWindow / 2;
        return (feature.timeRange.start <= windowEnd &&
            feature.timeRange.end >= windowStart);
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
    getWeight: { type: 'accessor', value: 1 },
    getPosition: { type: 'accessor', value: null },
};
//# sourceMappingURL=heatmap-time-layer.js.map
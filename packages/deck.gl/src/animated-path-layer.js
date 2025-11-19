/**
 * Layer for animating path/trajectory data over time
 */
import { PathLayer } from '@deck.gl/layers';
import { SpatioTemporalLayer } from './spatiotemporal-layer';
/**
 * Animated path layer for trajectory data
 *
 * Features:
 * - Smooth path rendering over time
 * - Optional trailing effect (shows path history)
 * - Interpolation between time frames
 * - Efficient rendering with GPU instancing
 */
export class AnimatedPathLayer extends SpatioTemporalLayer {
    renderLayers() {
        const { tiles, currentTime } = this.state;
        if (!tiles || tiles.length === 0) {
            return [];
        }
        // Extract path features
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
        // Convert to PathLayer format
        const data = features.map((feature) => ({
            feature,
            path: this.props.getPath ? this.props.getPath(feature) : [],
            color: this.props.getColor
                ? this.props.getColor(feature)
                : [0, 150, 255, 255],
            width: this.props.getWidth ? this.props.getWidth(feature) : 3,
        }));
        return [
            new PathLayer({
                id: `${this.props.id}-paths`,
                data,
                getPath: (d) => d.path,
                getColor: (d) => d.color,
                getWidth: (d) => d.width,
                widthScale: this.props.widthScale,
                widthUnits: this.props.widthUnits,
                opacity: this.props.opacity,
                visible: this.props.visible,
                pickable: true,
                updateTriggers: {
                    getPath: currentTime,
                    getColor: currentTime,
                    getWidth: currentTime,
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
AnimatedPathLayer.layerName = 'AnimatedPathLayer';
AnimatedPathLayer.defaultProps = {
    ...SpatioTemporalLayer.defaultProps,
    widthScale: { type: 'number', value: 1, compare: false },
    widthUnits: { type: 'string', value: 'pixels', compare: false },
    getColor: { type: 'accessor', value: [0, 150, 255, 255] },
    getWidth: { type: 'accessor', value: 3 },
    getPath: { type: 'accessor', value: (_f) => [] },
    trail: { type: 'boolean', value: true, compare: false },
    trailLength: { type: 'number', value: 5000, compare: false }, // 5 seconds
};
//# sourceMappingURL=animated-path-layer.js.map
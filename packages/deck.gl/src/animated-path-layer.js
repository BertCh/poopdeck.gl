/**
 * Layer for animating path/trajectory data over time
 */
import { PathLayer } from '@deck.gl/layers';
import { SpatioTemporalLayer } from './spatiotemporal-layer';
import { TimeFilterExtension } from './time-filter-extension';
/**
 * Animated path layer for trajectory data
 *
 * Features:
 * - Smooth path rendering over time
 * - Optional trailing effect (shows path history)
 * - GPU-accelerated time filtering via TimeFilterExtension
 * - Efficient rendering with GPU instancing
 */
export class AnimatedPathLayer extends SpatioTemporalLayer {
    renderLayers() {
        const { tiles, currentTime } = this.state;
        if (!tiles || tiles.length === 0) {
            return [];
        }
        const timeWindow = this.props.timeWindow || 86400000;
        // Use start time as offset to maintain floating point precision in shader
        const timeOffset = this.props.timeRange?.start || 0;
        // Render one PathLayer per tile-layer
        return tiles.flatMap((tile) => {
            return tile.layers.map((layer, layerIndex) => {
                const layerId = `${this.props.id}-${tile.id.z}-${tile.id.x}-${tile.id.y}-${tile.id.t}-${layerIndex}`;
                const defaultGetPath = (feature) => feature.positions || [];
                return new PathLayer({
                    id: layerId,
                    data: layer.features,
                    // Path accessor - decode geometry if not provided
                    getPath: this.props.getPath ?? defaultGetPath,
                    // Standard accessors
                    getColor: this.props.getColor,
                    getWidth: this.props.getWidth,
                    // Props
                    widthScale: this.props.widthScale,
                    widthUnits: this.props.widthUnits,
                    opacity: this.props.opacity,
                    visible: this.props.visible,
                    pickable: true,
                    // Time Filtering
                    extensions: [new TimeFilterExtension()],
                    // Adjust current time by offset to maintain precision
                    currentTime: currentTime - timeOffset,
                    timeWindow,
                    fadeInDuration: this.props.fadeInDuration,
                    fadeOutDuration: this.props.fadeOutDuration,
                    // Accessors for TimeFilterExtension
                    // Subtract offset from feature times
                    getInstanceStartTime: (d) => (d.timeRange?.start ?? -Infinity) - timeOffset,
                    getInstanceEndTime: (d) => (d.timeRange?.end ?? Infinity) - timeOffset,
                    // Attributes
                    updateTriggers: {
                        getPath: [tile.id.z, tile.id.x, tile.id.y],
                        getColor: this.props.getColor,
                        getWidth: this.props.getWidth,
                        getInstanceStartTime: timeOffset, // Depend on timeOffset
                        getInstanceEndTime: timeOffset, // Depend on timeOffset
                    }
                });
            });
        });
    }
}
AnimatedPathLayer.layerName = 'AnimatedPathLayer';
AnimatedPathLayer.defaultProps = {
    ...SpatioTemporalLayer.defaultProps,
    // PathLayer props
    widthScale: { type: 'number', value: 1, min: 0 },
    widthUnits: 'pixels',
    getColor: { type: 'accessor', value: [0, 150, 255, 255] },
    getWidth: { type: 'accessor', value: 3 },
    getPath: { type: 'accessor', value: null },
    // Trail props
    trail: true,
    trailLength: { type: 'number', value: 5000, min: 0 }, // 5 seconds
    // Animation props
    fadeInDuration: { type: 'number', value: 300, min: 0 },
    fadeOutDuration: { type: 'number', value: 300, min: 0 },
};
//# sourceMappingURL=animated-path-layer.js.map
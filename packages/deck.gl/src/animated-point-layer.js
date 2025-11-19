/**
 * Layer for animating point data over time
 */
import { ScatterplotLayer } from '@deck.gl/layers';
import { SpatioTemporalLayer } from './spatiotemporal-layer';
// Debug flag - set to false for production
const DEBUG = false;
/**
 * Animated point layer for time-series point data
 *
 * Features:
 * - Smooth fade-in/out for appearing/disappearing points
 * - Optional interpolation between time frames
 * - GPU-accelerated rendering
 * - Automatic filtering by time window
 */
export class AnimatedPointLayer extends SpatioTemporalLayer {
    renderLayers() {
        const { tiles, currentTime } = this.state;
        if (!tiles || tiles.length === 0) {
            if (DEBUG)
                console.log('AnimatedPointLayer: No tiles loaded');
            return [];
        }
        // Extract features from tiles
        // NOTE: Coordinates are stored as ABSOLUTE values within tile extent, NOT delta-encoded
        // See crates/stt-build/src/main.rs line 165: use_delta_encoding: false
        const data = [];
        for (const tile of tiles) {
            for (const layer of tile.layers) {
                for (const feature of layer.features) {
                    // Filter by time window
                    if (this.isFeatureVisible(feature, currentTime)) {
                        // Decode position (absolute coordinates, no cursor tracking needed)
                        const position = this.props.getPosition
                            ? this.props.getPosition(feature)
                            : this.extractPositionWithDelta(feature, layer.extent, tile.id, { x: 0, y: 0 });
                        // Create data point
                        data.push({
                            feature,
                            position,
                            radius: this.props.getRadius ? this.props.getRadius(feature) : 5,
                            fillColor: this.props.getFillColor
                                ? this.props.getFillColor(feature)
                                : [255, 128, 0, 255],
                        });
                    }
                }
            }
        }
        if (DEBUG) {
            console.log(`AnimatedPointLayer: Rendering ${data.length} features at time ${new Date(currentTime).toISOString()}`);
            // Debug: log first few features to check coordinates
            if (data.length > 0 && data.length < 10) {
                console.log('First features:', data.slice(0, 3).map(d => ({
                    position: d.position,
                    radius: d.radius,
                    geometry: d.feature.geometry,
                    properties: d.feature.properties
                })));
            }
            else if (data.length > 0) {
                console.log('First feature:', {
                    position: data[0].position,
                    radius: data[0].radius,
                    geometry: data[0].feature.geometry,
                    properties: data[0].feature.properties,
                    expectedRange: 'lon=[-80, -65], lat=[25, 45]'
                });
            }
        }
        return [
            new ScatterplotLayer({
                id: `${this.props.id}-points`,
                data,
                getPosition: (d) => d.position,
                getRadius: (d) => d.radius,
                getFillColor: (d) => d.fillColor,
                radiusScale: this.props.radiusScale,
                radiusUnits: this.props.radiusUnits,
                opacity: this.props.opacity,
                visible: this.props.visible,
                pickable: true,
                updateTriggers: {
                    getPosition: currentTime,
                    getRadius: currentTime,
                    getFillColor: currentTime,
                },
            }),
        ];
    }
    isFeatureVisible(feature, currentTime) {
        if (!feature.timeRange) {
            return true; // Always visible if no time range specified
        }
        const timeWindow = this.props.timeWindow || 86400000;
        const windowStart = currentTime - timeWindow / 2;
        const windowEnd = currentTime + timeWindow / 2;
        return (feature.timeRange.start <= windowEnd &&
            feature.timeRange.end >= windowStart);
    }
    /**
     * Extract position from feature geometry
     *
     * Coordinates are stored as ABSOLUTE values within the tile extent (0-4096),
     * NOT delta-encoded. See Rust tiler: crates/stt-build/src/tiler.rs line 555
     * and crates/stt-build/src/main.rs line 165 (use_delta_encoding: false)
     *
     * Format: [command, x, y] where:
     * - command = 9 (MoveTo with count 1)
     * - x, y = absolute tile coordinates (0 to extent)
     */
    extractPositionWithDelta(feature, extent, tileId, _cursor) {
        if (!feature.geometry || feature.geometry.length < 3) {
            return [0, 0];
        }
        if (!tileId) {
            return [0, 0];
        }
        // Coordinates are stored as absolute values (NOT zigzag-encoded, NOT deltas)
        // geometry[0] = command integer (9 for MoveTo)
        // geometry[1] = absolute X coordinate within tile extent
        // geometry[2] = absolute Y coordinate within tile extent
        const tileX = feature.geometry[1];
        const tileY = feature.geometry[2];
        const z = tileId.z;
        const x = tileId.x;
        const y = tileId.y;
        const n = 1 << z;
        // Normalize coordinates (0-1 range within tile)
        const normX = tileX / extent;
        const normY = tileY / extent;
        // Convert to lon/lat using Web Mercator projection
        const lon = ((x + normX) / n) * 360 - 180;
        const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + normY) / n)));
        const lat = (latRad * 180) / Math.PI;
        return [lon, lat];
    }
}
AnimatedPointLayer.layerName = 'AnimatedPointLayer';
AnimatedPointLayer.defaultProps = {
    ...SpatioTemporalLayer.defaultProps,
    radiusScale: { type: 'number', value: 1, compare: false },
    radiusUnits: { type: 'string', value: 'pixels', compare: false },
    getFillColor: { type: 'accessor', value: [255, 128, 0, 255] },
    getRadius: { type: 'accessor', value: 5 },
    // Don't set getPosition default - let it be undefined so extractPosition is used
    fadeInDuration: { type: 'number', value: 300, compare: false },
    fadeOutDuration: { type: 'number', value: 300, compare: false },
};
//# sourceMappingURL=animated-point-layer.js.map
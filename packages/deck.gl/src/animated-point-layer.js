/**
 * Layer for animating point data over time
 */
import { ScatterplotLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { SpatioTemporalLayer } from './spatiotemporal-layer';
import { TimeFilterExtension } from './time-filter-extension';
// Debug flag
const DEBUG = false;
/**
 * Animated point layer for time-series point data
 *
 * Features:
 * - Smooth fade-in/out for appearing/disappearing points
 * - Optional interpolation between time frames
 * - GPU-accelerated rendering via TimeFilterExtension
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
        if (DEBUG) {
            const totalFeatures = tiles.reduce((sum, t) => sum + t.layers.reduce((ls, l) => ls + (l.features?.length || 0), 0), 0);
            console.log(`AnimatedPointLayer: ${tiles.length} tiles, ${totalFeatures} total features`);
            if (tiles[0]?.layers?.[0]?.features?.[0]) {
                const f = tiles[0].layers[0].features[0];
                console.log('Sample feature:', {
                    id: f.id,
                    type: f.type,
                    positionsLength: f.positions?.length,
                    firstPosition: f.positions?.[0],
                    properties: f.properties,
                    timeRange: f.timeRange
                });
            }
            // Log first 3 features with actual position values
            const firstFeatures = tiles[0]?.layers?.[0]?.features?.slice(0, 3);
            if (firstFeatures) {
                console.log('First 3 feature positions (expanded):', firstFeatures.map(f => ({
                    lon: f.positions?.[0]?.[0],
                    lat: f.positions?.[0]?.[1]
                })));
            }
            // Count features that have valid positions
            const featuresWithPositions = tiles.flatMap(t => t.layers.flatMap(l => l.features.filter(f => f.positions?.length > 0))).length;
            console.log(`Features with valid positions: ${featuresWithPositions}`);
            // Log first ScatterplotLayer data sample
            console.log('Returning', tiles.flatMap(t => t.layers).length, 'sub-layers');
        }
        const timeWindow = this.props.timeWindow || 86400000;
        // Use start time as offset to maintain floating point precision in shader
        const timeOffset = this.props.timeRange?.start || 0;
        const fallbackPosition = (feature) => {
            if (feature?.positions && feature.positions.length > 0) {
                return feature.positions[0];
            }
            return [0, 0];
        };
        return tiles.flatMap((tile) => {
            return tile.layers.map((layer, layerIndex) => {
                const layerId = `${this.props.id}-${tile.id.z}-${tile.id.x}-${tile.id.y}-${layerIndex}`;
                // Build getPosition accessor - use provided one or fallback to feature.positions
                // Note: Accessor<T> can be a function or constant, we need to handle both
                const propsGetPosition = this.props.getPosition;
                const getPosition = (feature) => {
                    if (typeof propsGetPosition === 'function') {
                        return propsGetPosition(feature, {});
                    }
                    if (Array.isArray(propsGetPosition)) {
                        return propsGetPosition;
                    }
                    return fallbackPosition(feature);
                };
                // Debug: log the first feature's actual position to verify
                if (DEBUG && layerIndex === 0) {
                    const firstFeature = layer.features[0];
                    if (firstFeature) {
                        const pos = fallbackPosition(firstFeature);
                        console.log(`Layer ${layerId} - first feature position:`, pos);
                        console.log(`Layer ${layerId} - radiusUnits:`, this.props.radiusUnits);
                        console.log(`Layer ${layerId} - data count:`, layer.features.length);
                    }
                }
                return new ScatterplotLayer({
                    id: layerId,
                    data: layer.features,
                    coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
                    radiusScale: this.props.radiusScale,
                    radiusUnits: this.props.radiusUnits,
                    opacity: this.props.opacity,
                    visible: this.props.visible,
                    pickable: true,
                    // Time Filtering
                    extensions: [new TimeFilterExtension()],
                    currentTime: currentTime - timeOffset,
                    timeWindow,
                    fadeInDuration: this.props.fadeInDuration,
                    fadeOutDuration: this.props.fadeOutDuration,
                    // Accessors for TimeFilterExtension
                    getInstanceStartTime: (d) => (d.timeRange?.start ?? -Infinity) - timeOffset,
                    getInstanceEndTime: (d) => (d.timeRange?.end ?? Infinity) - timeOffset,
                    updateTriggers: {
                        getPosition: this.props.getPosition ? this.props.getPosition : 0,
                        getFillColor: this.props.getFillColor,
                        getRadius: this.props.getRadius,
                        getInstanceStartTime: timeOffset,
                        getInstanceEndTime: timeOffset,
                    },
                    getPosition,
                    getRadius: this.props.getRadius,
                    getFillColor: this.props.getFillColor,
                });
            });
        });
    }
}
AnimatedPointLayer.layerName = 'AnimatedPointLayer';
AnimatedPointLayer.defaultProps = {
    ...SpatioTemporalLayer.defaultProps,
    // ScatterplotLayer props
    radiusScale: { type: 'number', value: 1, min: 0 },
    radiusUnits: 'pixels',
    getFillColor: { type: 'accessor', value: [255, 128, 0, 255] },
    getRadius: { type: 'accessor', value: 5 },
    getPosition: { type: 'accessor', value: null },
    // Animation props
    fadeInDuration: { type: 'number', value: 300, min: 0 },
    fadeOutDuration: { type: 'number', value: 300, min: 0 },
};
//# sourceMappingURL=animated-point-layer.js.map
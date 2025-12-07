/**
 * Layer for animating point data over time
 */

import { ScatterplotLayer } from '@deck.gl/layers';
import type { Accessor, Color, Layer } from '@deck.gl/core';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
import { TimeFilterExtension } from './time-filter-extension';
import type { Feature } from '@stt/core';

// Debug flag
const DEBUG = false;

export interface AnimatedPointLayerProps extends SpatioTemporalLayerProps {
  /** Radius scale multiplier */
  radiusScale?: number;
  
  /** Radius units ('pixels' | 'meters' | 'common') */
  radiusUnits?: 'pixels' | 'meters' | 'common';
  
  /** Fill color accessor - returns [r, g, b, a] */
  getFillColor?: Accessor<Feature, Color>;
  
  /** Radius accessor */
  getRadius?: Accessor<Feature, number>;
  
  /** Position accessor - returns [lon, lat] */
  getPosition?: Accessor<Feature, [number, number]>;
  
  /** Fade-in duration for appearing points (ms) */
  fadeInDuration?: number;
  
  /** Fade-out duration for disappearing points (ms) */
  fadeOutDuration?: number;
}

/**
 * Animated point layer for time-series point data
 * 
 * Features:
 * - Smooth fade-in/out for appearing/disappearing points
 * - Optional interpolation between time frames
 * - GPU-accelerated rendering via TimeFilterExtension
 * - Automatic filtering by time window
 */
export class AnimatedPointLayer extends SpatioTemporalLayer<AnimatedPointLayerProps> {
  static layerName = 'AnimatedPointLayer';

  static defaultProps = {
    ...SpatioTemporalLayer.defaultProps,
    // ScatterplotLayer props
    radiusScale: { type: 'number', value: 1, min: 0 },
    radiusUnits: 'pixels',
    getFillColor: { type: 'accessor', value: [255, 128, 0, 255] as Color },
    getRadius: { type: 'accessor', value: 5 },
    getPosition: { type: 'accessor', value: null },
    
    // Animation props
    fadeInDuration: { type: 'number', value: 300, min: 0 },
    fadeOutDuration: { type: 'number', value: 300, min: 0 },
  };

  renderLayers(): Layer[] {
    const { tiles, currentTime } = this.state;
    if (!tiles || tiles.length === 0) {
      if (DEBUG) console.log('AnimatedPointLayer: No tiles loaded');
      return [];
    }
    
    if (DEBUG) {
      const totalFeatures = tiles.reduce((sum, t) => 
        sum + t.layers.reduce((ls, l) => ls + (l.features?.length || 0), 0), 0);
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
        console.log('First 3 feature positions (expanded):', 
          firstFeatures.map(f => ({
            lon: f.positions?.[0]?.[0],
            lat: f.positions?.[0]?.[1]
          }))
        );
      }
      // Count features that have valid positions
      const featuresWithPositions = tiles.flatMap(t => 
        t.layers.flatMap(l => l.features.filter(f => f.positions?.length > 0))
      ).length;
      console.log(`Features with valid positions: ${featuresWithPositions}`);
      // Log first ScatterplotLayer data sample
      console.log('Returning', tiles.flatMap(t => t.layers).length, 'sub-layers');
    }

    const timeWindow = this.props.timeWindow || 86400000;
    // Use start time as offset to maintain floating point precision in shader
    const timeOffset = this.props.timeRange?.start || 0;

    const fallbackPosition = (feature: Feature): [number, number] => {
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
        const getPosition = (feature: Feature): [number, number] => {
          if (typeof propsGetPosition === 'function') {
            return propsGetPosition(feature, {} as any);
          }
          if (Array.isArray(propsGetPosition)) {
            return propsGetPosition as [number, number];
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
          getInstanceStartTime: (d: Feature) => (d.timeRange?.start ?? -Infinity) - timeOffset,
          getInstanceEndTime: (d: Feature) => (d.timeRange?.end ?? Infinity) - timeOffset,
          
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

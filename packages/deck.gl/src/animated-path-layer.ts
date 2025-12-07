/**
 * Layer for animating path/trajectory data over time
 */

import { PathLayer } from '@deck.gl/layers';
import type { PathLayerProps } from '@deck.gl/layers';
import type { Accessor, Color, Layer, Position } from '@deck.gl/core';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
import { TimeFilterExtension } from './time-filter-extension';
import type { Feature } from '@stt/core';

export interface AnimatedPathLayerProps extends SpatioTemporalLayerProps {
  /** Width scale multiplier */
  widthScale?: number;
  
  /** Width units ('pixels' | 'meters') */
  widthUnits?: 'pixels' | 'meters';
  
  /** Path color accessor - returns [r, g, b, a] */
  getColor?: Accessor<Feature, Color>;
  
  /** Path width accessor */
  getWidth?: Accessor<Feature, number>;
  
  /** Path coordinates accessor - returns [[lon, lat], ...] */
  getPath?: Accessor<Feature, Position[]>;
  
  /** Enable trailing effect (gradient fade) */
  trail?: boolean;
  
  /** Trail length in milliseconds */
  trailLength?: number;
  
  /** Fade-in duration for appearing paths (ms) */
  fadeInDuration?: number;
  
  /** Fade-out duration for disappearing paths (ms) */
  fadeOutDuration?: number;
}

/**
 * Animated path layer for trajectory data
 * 
 * Features:
 * - Smooth path rendering over time
 * - Optional trailing effect (shows path history)
 * - GPU-accelerated time filtering via TimeFilterExtension
 * - Efficient rendering with GPU instancing
 */
export class AnimatedPathLayer extends SpatioTemporalLayer<AnimatedPathLayerProps> {
  static layerName = 'AnimatedPathLayer';

  static defaultProps = {
    ...SpatioTemporalLayer.defaultProps,
    // PathLayer props
    widthScale: { type: 'number', value: 1, min: 0 },
    widthUnits: 'pixels',
    getColor: { type: 'accessor', value: [0, 150, 255, 255] as Color },
    getWidth: { type: 'accessor', value: 3 },
    getPath: { type: 'accessor', value: null },
    
    // Trail props
    trail: true,
    trailLength: { type: 'number', value: 5000, min: 0 }, // 5 seconds
    
    // Animation props
    fadeInDuration: { type: 'number', value: 300, min: 0 },
    fadeOutDuration: { type: 'number', value: 300, min: 0 },
  };

  renderLayers(): Layer[] {
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

        const defaultGetPath = (feature: Feature) =>
          feature.positions || [];

        return new PathLayer({
          id: layerId,
          data: layer.features,
          
          // Path accessor - decode geometry if not provided
          getPath: (this.props.getPath as PathLayerProps['getPath']) ?? defaultGetPath,
          
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
          getInstanceStartTime: (d: Feature) => (d.timeRange?.start ?? -Infinity) - timeOffset,
          getInstanceEndTime: (d: Feature) => (d.timeRange?.end ?? Infinity) - timeOffset,
          
          // Attributes
          updateTriggers: {
             getPath: [tile.id.z, tile.id.x, tile.id.y],
             getColor: this.props.getColor,
             getWidth: this.props.getWidth,
             getInstanceStartTime: timeOffset, // Depend on timeOffset
             getInstanceEndTime: timeOffset,   // Depend on timeOffset
          }
        });
      });
    });
  }

}

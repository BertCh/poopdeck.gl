/**
 * Layer for animating path/trajectory data over time
 */

import { PathLayer } from '@deck.gl/layers';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
import { TimeFilterExtension } from './time-filter-extension';
import { Feature, decodeGeometry, GeometryType } from '@stt/core';

export interface AnimatedPathLayerProps extends SpatioTemporalLayerProps {
  /** Width of paths in pixels */
  widthScale?: number;
  
  /** Width units ('pixels' | 'meters') */
  widthUnits?: 'pixels' | 'meters';
  
  /** Get path color [r, g, b, a] */
  getColor?: (feature: Feature) => [number, number, number, number];
  
  /** Get path width */
  getWidth?: (feature: Feature) => number;
  
  /** Get path coordinates [[lon, lat], ...] */
  getPath?: (feature: Feature) => number[][];
  
  /** Show trailing effect (gradient fade) */
  trail?: boolean;
  
  /** Trail length in milliseconds */
  trailLength?: number;
  
  /** Fade-in duration for new paths (ms) */
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
 * - Interpolation between time frames
 * - Efficient rendering with GPU instancing
 */
export class AnimatedPathLayer extends SpatioTemporalLayer<AnimatedPathLayerProps> {
  static layerName = 'AnimatedPathLayer';

  static defaultProps = {
    ...SpatioTemporalLayer.defaultProps,
    widthScale: { type: 'number', value: 1, compare: false },
    widthUnits: { type: 'string', value: 'pixels', compare: false },
    getColor: { type: 'accessor', value: [0, 150, 255, 255] },
    getWidth: { type: 'accessor', value: 3 },
    getPath: { type: 'accessor', value: (_f: Feature) => [] },
    trail: { type: 'boolean', value: true, compare: false },
    trailLength: { type: 'number', value: 5000, compare: false }, // 5 seconds
    fadeInDuration: { type: 'number', value: 300, compare: false },
    fadeOutDuration: { type: 'number', value: 300, compare: false },
  };

  renderLayers(): any[] {
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

        return new PathLayer({
          id: layerId,
          data: layer.features,
          
          // Path accessor - decode geometry if not provided
          getPath: (feature: Feature) => {
            if (this.props.getPath && this.props.getPath(feature).length > 0) {
               return this.props.getPath(feature);
            }
            return this.extractPath(feature, layer.extent, tile.id);
          },
          
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

  private isFeatureVisible(feature: Feature, currentTime: number): boolean {
     // Kept for compatibility or debugging, but filtering is done on GPU now
    if (!feature.timeRange) {
      return true;
    }
    const timeWindow = this.props.timeWindow || 86400000;
    const windowStart = currentTime - timeWindow / 2;
    const windowEnd = currentTime + timeWindow / 2;
    return (
      feature.timeRange.start <= windowEnd &&
      feature.timeRange.end >= windowStart
    );
  }
  
  private extractPath(feature: Feature, extent: number, tileId: any): number[][] {
    if (!feature.geometry || feature.geometry.length < 3) return [];
    
    // Decode geometry (handles ZigZag and Delta encoding)
    // Note: We treat all paths as LineStrings for now
    const coords = decodeGeometry(feature.geometry, GeometryType.LineString, extent);
    const path: number[][] = [];
    const n = 1 << tileId.z;
    
    for (const [normX, normY] of coords) {
      // Convert normalized tile coords (0-1) to lon/lat
      // Note: decodeGeometry returns x/extent, y/extent
      const lon = ((tileId.x + normX) / n) * 360 - 180;
      const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tileId.y + normY) / n)));
      const lat = (latRad * 180) / Math.PI;
      
      path.push([lon, lat]);
    }
    
    return path;
  }
}

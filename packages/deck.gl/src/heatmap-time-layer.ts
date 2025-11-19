/**
 * Layer for temporal heatmap visualization
 */

import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
import type { Feature } from '@stt/core';

export interface HeatmapTimeLayerProps extends SpatioTemporalLayerProps {
  /** Radius of influence in pixels */
  radiusPixels?: number;
  
  /** Intensity of each point */
  intensity?: number;
  
  /** Aggregation method ('SUM' | 'MEAN') */
  aggregation?: 'SUM' | 'MEAN';
  
  /** Color range (low to high) */
  colorRange?: [number, number, number, number][];
  
  /** Get weight for each point */
  getWeight?: (feature: Feature) => number;
  
  /** Get position [lon, lat] */
  getPosition?: (feature: Feature) => [number, number];
}

/**
 * Temporal heatmap layer
 * 
 * Aggregates point data into a density heatmap that animates over time.
 * Uses GPU acceleration for real-time aggregation.
 */
export class HeatmapTimeLayer extends SpatioTemporalLayer<HeatmapTimeLayerProps> {
  static layerName = 'HeatmapTimeLayer';

  static defaultProps = {
    ...SpatioTemporalLayer.defaultProps,
    radiusPixels: { type: 'number', value: 30, compare: false },
    intensity: { type: 'number', value: 1, compare: false },
    aggregation: { type: 'string', value: 'SUM', compare: false },
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
      compare: false,
    },
    getWeight: { type: 'accessor', value: 1 },
    getPosition: { type: 'accessor', value: (_f: Feature) => [0, 0] },
  };

  renderLayers(): any[] {
    const { tiles, currentTime } = this.state;
    if (!tiles || tiles.length === 0) {
      return [];
    }

    // Extract point features
    const features: Feature[] = [];
    for (const tile of tiles) {
      for (const layer of tile.layers) {
        for (const feature of layer.features) {
          if (this.isFeatureVisible(feature, currentTime)) {
            features.push(feature);
          }
        }
      }
    }

    // Convert to heatmap data format
    const data = features.map((feature) => ({
      feature,
      position: this.props.getPosition
        ? this.props.getPosition(feature)
        : [0, 0],
      weight: this.props.getWeight ? this.props.getWeight(feature) : 1,
    }));

    return [
      new HeatmapLayer({
        id: `${this.props.id}-heatmap`,
        data,
        getPosition: (d: any) => d.position,
        getWeight: (d: any) => d.weight,
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

  private isFeatureVisible(feature: Feature, currentTime: number): boolean {
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
}


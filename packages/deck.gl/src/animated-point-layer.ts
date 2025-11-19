/**
 * Layer for animating point data over time
 */

import { ScatterplotLayer } from '@deck.gl/layers';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
import { TimeFilterExtension } from './time-filter-extension';
import { TrajectoryLayer } from './trajectory-layer';
import type { Feature } from '@stt/core';
import { COORDINATE_SYSTEM } from '@deck.gl/core';

// Debug flag - set to false for production
const DEBUG = false;

export interface AnimatedPointLayerProps extends SpatioTemporalLayerProps {
  /** Radius of points in pixels */
  radiusScale?: number;
  
  /** Radius units ('pixels' | 'meters' | 'common') */
  radiusUnits?: 'pixels' | 'meters' | 'common';
  
  /** Get fill color [r, g, b, a] */
  getFillColor?: (feature: Feature) => [number, number, number, number];
  
  /** Get radius */
  getRadius?: (feature: Feature) => number;
  
  /** Get position [lon, lat] */
  getPosition?: (feature: Feature) => [number, number];
  
  /** Fade-in duration for new points (ms) */
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
 * - GPU-accelerated rendering
 * - Automatic filtering by time window
 */
export class AnimatedPointLayer extends SpatioTemporalLayer<AnimatedPointLayerProps> {
  static layerName = 'AnimatedPointLayer';

  static defaultProps = {
    ...SpatioTemporalLayer.defaultProps,
    radiusScale: { type: 'number', value: 1, compare: false },
    radiusUnits: { type: 'string', value: 'pixels', compare: false },
    getFillColor: { type: 'accessor', value: [255, 128, 0, 255] },
    getRadius: { type: 'accessor', value: 5 },
    // Don't set getPosition default - let it be undefined so extractPosition is used
    fadeInDuration: { type: 'number', value: 300, compare: false },
    fadeOutDuration: { type: 'number', value: 300, compare: false },
  };

  renderLayers(): any[] {
    const { tiles, currentTime } = this.state;
    if (!tiles || tiles.length === 0) {
      if (DEBUG) console.log('AnimatedPointLayer: No tiles loaded');
      return [];
    }

    const timeWindow = this.props.timeWindow || 86400000;
    // Use start time as offset to maintain floating point precision in shader
    const timeOffset = this.props.timeRange?.start || 0;
    
    // Optimization: Use CARTESIAN coordinate system with modelMatrix 
    // if no custom getPosition is provided. This avoids expensive CPU projection.
    const useCartesian = !this.props.getPosition;
    const worldSize = 512; // WebMercator world size

    // Render one ScatterplotLayer per tile-layer
    // This avoids re-creating the data array on every frame
    return tiles.flatMap((tile) => {
      return tile.layers.map((layer, layerIndex) => {
        const layerId = `${this.props.id}-${tile.id.z}-${tile.id.x}-${tile.id.y}-${tile.id.t}-${layerIndex}`;
        
        // Calculate model matrix for this tile if using CARTESIAN
        let modelMatrix = null;
        let radiusScale = this.props.radiusScale;
        let coordinateSystem = undefined;
        let getPosition = this.props.getPosition;
        let radiusUnits = this.props.radiusUnits;
        
        // Check if we should use TrajectoryLayer
        const trajectories = (layer as any).trajectories;
        if (trajectories && useCartesian) {
            coordinateSystem = COORDINATE_SYSTEM.CARTESIAN;
            const { x, y, z } = tile.id;
            const scale = 1 / (1 << z); // 1 / 2^z
            const tileSize = worldSize * scale;
            const tileX = x * tileSize;
            const tileY = y * tileSize;
            const s = tileSize / layer.extent;
            
            modelMatrix = [
                s, 0, 0, 0,
                0, s, 0, 0,
                0, 0, 1, 0,
                tileX, tileY, 0, 1
            ];
            
            // Handle radius units conversion (same as below)
            if (this.props.radiusUnits === 'meters') {
                radiusUnits = 'common';
                const centerLat = this.getTileCenterLat(tile.id);
                const earthCircumference = 40075000;
                const metersPerUnit = (earthCircumference * Math.cos(centerLat * Math.PI / 180)) / worldSize;
                radiusScale = (this.props.radiusScale || 1) / metersPerUnit;
            }

            return new TrajectoryLayer({
                id: `${layerId}-trajectory`,
                data: {
                    ...trajectories,
                    length: trajectories.count, // deck.gl convention
                },
                
                // Coordinate system
                modelMatrix,
                coordinateSystem,
                
                // Time props (subtract offset from current time to match tile relative time)
                // Note: Trajectory times are delta from tile start? 
                // Decoder converts them to absolute relative to tile start?
                // Decoder implementation: time += tOffsets[j];
                // So times are ms from tile start (which is usually 0 relative to tile.timeStart?)
                // No, protobuf time_offsets are deltas. Tile.timeStart is absolute.
                // The decoder sums deltas. So timestamps are ms from the start of the trajectory?
                // Or from the tile start?
                // "Time deltas (ms) from tile start" per plan.
                // So timestamps are [0...duration].
                // We need to pass (currentTime - tile.timeStart) to the shader.
                currentTime: currentTime - tile.timeRange.start,

                // Visual props
                radiusScale,
                //radiusUnits, // TrajectoryLayer custom shader handles sizeScale
                getFillColor: this.props.getFillColor as any, // Assumed constant for now
                getRadius: typeof this.props.getRadius === 'number' ? this.props.getRadius : 5,
                fadeDuration: this.props.fadeInDuration, // Use fade in duration as general fade
            });
        }

        // Check if we can use binary optimization
        // Requirements:
        // 1. Binary data exists
        // 2. using Cartesian (standard path)
        // 3. No custom accessors (colors, radius) that rely on feature objects
        const binaryLayer = (layer as any).binary;
        const useBinary = binaryLayer && useCartesian && 
          !this.props.getPosition &&
          (Array.isArray(this.props.getFillColor) || this.props.getFillColor.length === 4) && // Constant color
          (typeof this.props.getRadius === 'number' || !isNaN(Number(this.props.getRadius))); // Constant radius

        if (useCartesian) {
          coordinateSystem = COORDINATE_SYSTEM.CARTESIAN;
          
          const { x, y, z } = tile.id;
          const scale = 1 / (1 << z); // 1 / 2^z
          const tileSize = worldSize * scale;
          const tileX = x * tileSize;
          const tileY = y * tileSize;
          
          // Scale: (tileSize / layer.extent)
          const s = tileSize / layer.extent;
          
          // Column-major matrix: [sx, 0, 0, 0,  0, sy, 0, 0,  0, 0, sz, 0,  tx, ty, tz, 1]
          modelMatrix = [
            s, 0, 0, 0,
            0, s, 0, 0,
            0, 0, 1, 0,
            tileX, tileY, 0, 1
          ];

          if (!useBinary) {
              // Use raw tile coordinates [x, y]
              getPosition = (feature: Feature) => {
                // Assuming MVT-style delta encoded geometry where index 1, 2 are x, y
                // This matches the extractPositionWithDelta logic but returns raw integers
                if (!feature.geometry || feature.geometry.length < 3) return [0, 0];
                // Handle potential zigzag encoding if necessary, but relying on 
                // simple access for now as per existing implementation logic
                return [feature.geometry[1], feature.geometry[2]]; 
              };
          }

          // Handle radiusUnits='meters' conversion
          if (this.props.radiusUnits === 'meters') {
            // We must switch to 'common' units and scale manually because
            // CARTESIAN system + meters units might not work as expected with lat-dependent scaling
            radiusUnits = 'common';
            
            // Calculate meters per common unit (world unit) at tile center
            // Meters/Unit = EarthCircumference * cos(lat) / WorldSize
            const centerLat = this.getTileCenterLat(tile.id);
            const earthCircumference = 40075000;
            const metersPerUnit = (earthCircumference * Math.cos(centerLat * Math.PI / 180)) / worldSize;
            
            // Radius in units = Radius in meters / MetersPerUnit
            radiusScale = (this.props.radiusScale || 1) / metersPerUnit;
          }
        } else if (!getPosition && !useBinary) {
           // Fallback to CPU projection if for some reason useCartesian is false (shouldn't happen given check)
           getPosition = (feature: Feature) => {
              return this.extractPositionWithDelta(feature, layer.extent, tile.id, { x: 0, y: 0 });
           };
        }

        const commonProps = {
          id: layerId,
          modelMatrix,
          coordinateSystem,
          radiusScale,
          radiusUnits,
          opacity: this.props.opacity,
          visible: this.props.visible,
          pickable: true,
          extensions: [new TimeFilterExtension()],
          currentTime: currentTime - timeOffset,
          timeWindow,
          fadeInDuration: this.props.fadeInDuration,
          fadeOutDuration: this.props.fadeOutDuration,
          dataTransform: undefined,
          updateTriggers: {
            getPosition: useCartesian ? 0 : [tile.id.z, tile.id.x, tile.id.y], 
            getFillColor: this.props.getFillColor,
            getRadius: this.props.getRadius,
            getInstanceStartTime: timeOffset, 
            getInstanceEndTime: timeOffset,
          },
        };

        if (useBinary) {
            // Prepare binary attributes
            // Cache offsetted times if needed
            // We check if we already cached them on this layer object
            const binaryCache = (layer as any).binaryCache || {};
            if (!binaryCache.startTimes || binaryCache.timeOffset !== timeOffset) {
                const length = binaryLayer.length;
                const startTimes = new Float32Array(length);
                const endTimes = new Float32Array(length);
                const s = binaryLayer.startTimes;
                const e = binaryLayer.endTimes;
                
                // If s/e are Float64Array, iterating is fast
                for(let i=0; i<length; i++) {
                    startTimes[i] = s[i] - timeOffset;
                    endTimes[i] = e[i] - timeOffset;
                }
                binaryCache.startTimes = startTimes;
                binaryCache.endTimes = endTimes;
                binaryCache.timeOffset = timeOffset;
                (layer as any).binaryCache = binaryCache;
            }

            return new ScatterplotLayer({
                ...commonProps,
                data: {
                    length: binaryLayer.length,
                    attributes: {
                        getPosition: { value: binaryLayer.positions, size: 2 },
                        getInstanceStartTime: { value: binaryCache.startTimes, size: 1 },
                        getInstanceEndTime: { value: binaryCache.endTimes, size: 1 },
                    }
                },
                getFillColor: this.props.getFillColor as any, // Assumed constant array
                getRadius: typeof this.props.getRadius === 'number' ? this.props.getRadius : 5,
            });
        }

        return new ScatterplotLayer({
          ...commonProps,
          data: layer.features,
          
          // Position
          getPosition,
          
          // Standard accessors
          getRadius: this.props.getRadius,
          getFillColor: this.props.getFillColor,
          
          // Accessors for TimeFilterExtension
          // Subtract offset from feature times
          getInstanceStartTime: (d: Feature) => (d.timeRange?.start ?? -Infinity) - timeOffset,
          getInstanceEndTime: (d: Feature) => (d.timeRange?.end ?? Infinity) - timeOffset,
        });
      });
    });
  }

  private getTileCenterLat(tileId: { z: number, x: number, y: number }): number {
    const { z, y } = tileId;
    const n = 1 << z;
    // Tile center y is y + 0.5
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n)));
    return (latRad * 180) / Math.PI;
  }

  // ... helper methods ...
  private isFeatureVisible(feature: Feature, currentTime: number): boolean {
    // Used only for CPU debugging/fallback if needed, but main logic is now GPU
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

  private extractPositionWithDelta(
    feature: Feature, 
    extent: number, 
    tileId: any,
    cursor: { x: number; y: number }
  ): [number, number] {
    if (!feature.geometry || feature.geometry.length < 3) {
      return [0, 0];
    }

    if (!tileId) {
      return [0, 0];
    }

    const tileX = feature.geometry[1];
    const tileY = feature.geometry[2];

    const z = tileId.z;
    const x = tileId.x;
    const y = tileId.y;
    const n = 1 << z;

    const normX = tileX / extent;
    const normY = tileY / extent;

    const lon = ((x + normX) / n) * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + normY) / n)));
    const lat = (latRad * 180) / Math.PI;

    return [lon, lat];
  }

  private zigzagDecode(n: number): number {
    return (n >> 1) ^ -(n & 1);
  }
}

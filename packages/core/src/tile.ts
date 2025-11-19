/**
 * Tile decoding utilities
 */

import { stt } from './proto';
import {
  Tile,
  TileId,
  Layer,
  Feature,
  GeometryType,
  PropertyValue,
  ChangeType,
  BinaryLayerData,
  TrajectoryData,
} from './types';

/**
 * Delta tile decoder with feature caching for efficient reconstruction
 * of unchanged features across temporal tiles.
 */
export class DeltaTileDecoder {
  // Cache features across tiles for delta reconstruction
  // Key: feature ID, Value: cached feature
  private featureCache: Map<number, Feature> = new Map();
  
  // Track cache statistics
  private cacheHits = 0;
  private cacheMisses = 0;
  
  /**
   * Decode a tile and reconstruct UNCHANGED features from cache
   */
  decodeTile(data: Uint8Array, id: TileId): Tile {
    const protoTile = stt.Tile.decode(data);

    const layers: Layer[] = (protoTile.layers || []).map((protoLayer) => {
      const features: Feature[] = [];
      
      for (const protoFeature of (protoLayer.features || [])) {
        const changeType = (protoFeature.change ?? 1) as ChangeType; // Default to CREATED
        
        if (changeType === ChangeType.Unchanged) {
          // Reconstruct from cache
          const featureId = Number(protoFeature.id) || 0;
          const cached = this.featureCache.get(featureId);
          
          if (cached) {
            this.cacheHits++;
            // Return cached feature (shallow copy to avoid mutation)
            features.push({ ...cached });
          } else {
            this.cacheMisses++;
            console.warn(
              `[DeltaTileDecoder] Missing cache entry for UNCHANGED feature ${featureId} ` +
              `in tile ${id.z}/${id.x}/${id.y}/${id.t}`
            );
            // Skip this feature - it should have been in cache
          }
        } else if (changeType === ChangeType.Deleted) {
          // Remove from cache
          const featureId = Number(protoFeature.id) || 0;
          this.featureCache.delete(featureId);
          // Don't add to features array
        } else {
          // CREATED or MODIFIED - decode normally
          const feature = this.decodeFeature(protoFeature as stt.Feature, protoLayer);
          
          // Cache for future UNCHANGED references
          this.featureCache.set(feature.id, feature);
          
          features.push(feature);
        }
      }

      // Decode trajectories if present
      let trajectories: TrajectoryData | undefined;
      if (protoLayer.trajectories && protoLayer.trajectories.length > 0) {
        trajectories = this.decodeTrajectories(protoLayer.trajectories, protoLayer.extent || 4096);
      }
      
      return {
        name: protoLayer.name || 'default',
        extent: protoLayer.extent || 4096,
        features,
        trajectories,
        binary: this.createBinaryData(features, protoLayer.extent || 4096),
      };
    });

    // Decode temporal resolution if present
    const temporalResolution = protoTile.temporalResolution ? {
      bucketSizeMs: Number(protoTile.temporalResolution.bucketSizeMs) || 0,
      zoomLevel: protoTile.temporalResolution.zoomLevel || 0,
      featureCount: protoTile.temporalResolution.featureCount || 0,
      suggestedSpeedMultiplier: protoTile.temporalResolution.suggestedSpeedMultiplier || 1.0,
    } : undefined;

    return {
      id,
      timeRange: {
        start: Number(protoTile.timeStart) || 0,
        end: Number(protoTile.timeEnd) || 0,
      },
      layers,
      temporalResolution,
    };
  }

  /**
   * Decode trajectories into SOA format
   */
  private decodeTrajectories(
    protoTrajectories: stt.ITrajectory[], 
    extent: number
  ): TrajectoryData {
    const count = protoTrajectories.length;
    
    // Calculate total points to allocate arrays once
    let totalPoints = 0;
    for (const t of protoTrajectories) {
      totalPoints += (t.timeOffsets?.length || 0);
    }

    const ids = new Float64Array(count);
    const startIndices = new Uint32Array(count);
    const lengths = new Uint32Array(count);
    const timestamps = new Float32Array(totalPoints);
    const positions = new Float32Array(totalPoints * 2);
    const properties: Record<string, PropertyValue>[] = []; // Keeping as objects for now

    let pointIndex = 0;

    for (let i = 0; i < count; i++) {
      const t = protoTrajectories[i];
      const pathLen = t.timeOffsets?.length || 0;
      
      ids[i] = Number(t.id) || 0;
      startIndices[i] = pointIndex;
      lengths[i] = pathLen;
      
      // Decode deltas
      let time = 0;
      let x = 0;
      let y = 0;
      
      const tOffsets = t.timeOffsets || [];
      const coords = t.coordinates || [];
      
      // Coordinate buffer uses zigzag encoding for deltas
      // Logic mirrors decodeGeometry but without MoveTo/LineTo commands
      // It assumes a continuous stream of (dx, dy) pairs
      
      for (let j = 0; j < pathLen; j++) {
        // Time is simple delta
        time += tOffsets[j];
        timestamps[pointIndex + j] = time;
        
        // Position is zigzag delta
        if (j * 2 + 1 < coords.length) {
          const dx = zigzagDecode(coords[j * 2]);
          const dy = zigzagDecode(coords[j * 2 + 1]);
          x += dx;
          y += dy;
          
          // Normalized to extent [0, 1]? 
          // Usually deck.gl expects pixel coords or lat/lon?
          // Existing AnimatedPointLayer handles normalization.
          // We'll store raw tile units here and handle projection in shader/layer.
          // To match binary format:
          positions[(pointIndex + j) * 2] = x;
          positions[(pointIndex + j) * 2 + 1] = y;
        }
      }
      
      pointIndex += pathLen;
    }

    return {
      count,
      ids,
      startIndices,
      lengths,
      timestamps,
      positions,
      properties
    };
  }

  /**
   * Create binary data from features (Structure of Arrays)
   * Optimized for deck.gl consumption
   */
  private createBinaryData(features: Feature[], extent: number): BinaryLayerData | undefined {
    if (features.length === 0) return undefined;
    
    // Check if we have points (only optimizing points for now)
    const isPoint = features[0].type === GeometryType.Point;
    if (!isPoint) return undefined;

    const length = features.length;
    const positions = new Float32Array(length * 2);
    const featureIds = new Float64Array(length);
    const startTimes = new Float64Array(length);
    const endTimes = new Float64Array(length);
    const numericProps: Record<string, Float32Array> = {}; 

    for (let i = 0; i < length; i++) {
      const f = features[i];
      featureIds[i] = f.id;
      
      if (f.timeRange) {
        startTimes[i] = f.timeRange.start;
        endTimes[i] = f.timeRange.end;
      } else {
        startTimes[i] = 0;
        endTimes[i] = 0; 
      }

      // Extract position
      // Assuming MVT-style delta encoded geometry where index 1, 2 are x, y
      // But we know from investigation that backend might send raw u32 without zigzag
      // or we might have decoded zigzag already if we used decodeGeometry (which we didn't here, we accessed raw)
      
      // NOTE: feature.geometry is raw array from proto here (number[])
      if (f.geometry && f.geometry.length >= 3) {
        // Index 0 is command (MoveTo), 1 is x, 2 is y
        // We just copy them. 
        // Note: deck.gl wants cartesian/pixels usually relative to tile top-left?
        // Actually, AnimatedPointLayer handles projection. We just provide raw values.
        // Wait, AnimatedPointLayer checks for zigzag?
        // If we provide RAW values here, AnimatedPointLayer must know.
        
        positions[i * 2] = f.geometry[1];
        positions[i * 2 + 1] = f.geometry[2];
      } else {
         positions[i * 2] = 0;
         positions[i * 2 + 1] = 0;
      }
    }

    return { positions, numericProps, length, featureIds, startTimes, endTimes };
  }
  
  /**
   * Decode a single feature from proto format
   */
  private decodeFeature(
    protoFeature: stt.Feature,
    protoLayer: stt.ILayer
  ): Feature {
    // Decode properties from tags
    const properties: Record<string, PropertyValue> = {};
    const tags = protoFeature.tags || [];
    const keys = protoLayer.keys || [];
    const values = protoLayer.values || [];
    
    for (let i = 0; i < tags.length; i += 2) {
      const keyIdx = tags[i];
      const valIdx = tags[i + 1];
      if (keyIdx < keys.length && valIdx < values.length) {
        const key = keys[keyIdx];
        const value = values[valIdx];
        if (key && value) {
          properties[key] = protoValueToValue(value);
        }
      }
    }

    return {
      id: Number(protoFeature.id) || 0,
      type: protoGeomTypeToType(protoFeature.type || 0),
      geometry: Array.from(protoFeature.geometry || []),
      properties,
      timeRange:
        protoFeature.validFrom && protoFeature.validTo
          ? {
              start: Number(protoFeature.validFrom),
              end: Number(protoFeature.validTo),
            }
          : undefined,
      changeType: protoFeature.change !== undefined ? Number(protoFeature.change) as ChangeType : ChangeType.Created,
    };
  }
  
  /**
   * Clear the cache (e.g., when switching datasets or zoom levels)
   */
  clearCache(): void {
    this.featureCache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }
  
  /**
   * Get cache statistics
   */
  getCacheStats(): { hits: number; misses: number; size: number; hitRate: number } {
    const total = this.cacheHits + this.cacheMisses;
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      size: this.featureCache.size,
      hitRate: total > 0 ? this.cacheHits / total : 0,
    };
  }
}

// Export singleton instance for convenience
export const deltaTileDecoder = new DeltaTileDecoder();

/**
 * Decode a tile from Protocol Buffer bytes (convenience function)
 * Uses the singleton delta decoder for automatic caching
 */
export function decodeTile(data: Uint8Array, id: TileId): Tile {
  return deltaTileDecoder.decodeTile(data, id);
}

function protoValueToValue(protoValue: any): PropertyValue {
  if (!protoValue) return '';

  // Protobufjs represents oneof fields directly on the object
  if (protoValue.stringValue !== undefined) return String(protoValue.stringValue);
  if (protoValue.doubleValue !== undefined) return Number(protoValue.doubleValue);
  if (protoValue.floatValue !== undefined) return Number(protoValue.floatValue);
  if (protoValue.intValue !== undefined) return Number(protoValue.intValue);
  if (protoValue.uintValue !== undefined) return Number(protoValue.uintValue);
  if (protoValue.sintValue !== undefined) return Number(protoValue.sintValue);
  if (protoValue.boolValue !== undefined) return Boolean(protoValue.boolValue);

  return '';
}

function protoGeomTypeToType(protoType: stt.Feature.GeomType): GeometryType {
  switch (protoType) {
    case stt.Feature.GeomType.POINT:
      return GeometryType.Point;
    case stt.Feature.GeomType.LINESTRING:
      return GeometryType.LineString;
    case stt.Feature.GeomType.POLYGON:
      return GeometryType.Polygon;
    default:
      return GeometryType.Point;
  }
}

/**
 * Decode geometry from delta-encoded format
 * Compatible with Mapbox Vector Tiles encoding
 */
export function decodeGeometry(
  geometry: number[],
  _geometryType: GeometryType,
  extent: number = 4096
): number[][] {
  const coordinates: number[][] = [];
  let x = 0;
  let y = 0;
  let cmd = 0;
  let cmdLen = 0;
  let i = 0;

  while (i < geometry.length) {
    if (cmdLen === 0) {
      // Read new command
      const cmdInt = geometry[i++];
      cmd = cmdInt & 0x7;
      cmdLen = cmdInt >> 3;
    }

    cmdLen--;

    if (cmd === 1 || cmd === 2) {
      // MoveTo or LineTo
      x += zigzagDecode(geometry[i++]);
      y += zigzagDecode(geometry[i++]);
      coordinates.push([x / extent, y / extent]);
    } else if (cmd === 7) {
      // ClosePath
      if (coordinates.length > 0) {
        coordinates.push([...coordinates[0]]);
      }
    }
  }

  return coordinates;
}

/**
 * Zigzag decode (Protocol Buffer encoding)
 */
function zigzagDecode(n: number): number {
  return (n >> 1) ^ -(n & 1);
}

/**
 * Convert flat coordinates to GeoJSON-style nested arrays
 */
export function toGeoJSON(
  coordinates: number[][],
  geometryType: GeometryType
): any {
  switch (geometryType) {
    case GeometryType.Point:
      return coordinates[0];
    case GeometryType.LineString:
      return coordinates;
    case GeometryType.Polygon:
      // Group by rings (first is outer, rest are holes)
      const rings: number[][][] = [];
      let currentRing: number[][] = [];
      for (const coord of coordinates) {
        currentRing.push(coord);
        // Detect closed ring (last point equals first)
        if (
          currentRing.length > 2 &&
          currentRing[0][0] === coord[0] &&
          currentRing[0][1] === coord[1]
        ) {
          rings.push(currentRing);
          currentRing = [];
        }
      }
      return rings;
    default:
      return coordinates;
  }
}

/**
 * Binary Columnar Format for GPU-ready spatiotemporal data
 * 
 * This format aligns with @loaders.gl/schema BinaryFeatureCollection patterns
 * and enables zero-copy GPU upload for deck.gl layers.
 */

import type { Feature, GeometryType, Layer, Tile, TileId, TimeRange } from './types';

/**
 * Binary representation of features for GPU-efficient rendering
 * All arrays are typed for direct GPU buffer upload
 */
export interface BinaryFeatures {
  /** Total number of features */
  featureCount: number;
  
  /** Geometry type (0=Point, 1=LineString, 2=Polygon) */
  geometryType: GeometryType;
  
  /** 
   * Interleaved positions as Float64Array [lon0, lat0, lon1, lat1, ...]
   * For points: 2 values per feature
   * For lines/polygons: variable, use positionOffsets to index
   */
  positions: Float64Array;
  
  /**
   * For non-point geometries: offset into positions array for each feature
   * Length = featureCount + 1 (last value is total position count)
   */
  positionOffsets?: Uint32Array;
  
  /** Feature IDs */
  featureIds: Uint32Array;
  
  /** Start time for each feature (milliseconds, relative to timeOffset) */
  startTimes: Float32Array;
  
  /** End time for each feature (milliseconds, relative to timeOffset) */
  endTimes: Float32Array;
  
  /** 
   * Time offset to maintain precision (subtract from absolute times)
   * startTimes/endTimes are relative to this value
   */
  timeOffset: number;
  
  /** 
   * Numeric properties as typed arrays
   * Key is property name, value is Float32Array with one value per feature
   */
  numericProperties: Record<string, Float32Array>;
  
  /**
   * Categorical properties as indices into lookup tables
   * Enables GPU-based coloring by category
   */
  categoricalProperties: Record<string, {
    indices: Uint8Array;
    categories: string[];
  }>;
}

/**
 * Binary representation of a complete tile
 */
export interface BinaryTile {
  id: TileId;
  timeRange: TimeRange;
  layers: BinaryLayer[];
}

/**
 * Binary representation of a layer
 */
export interface BinaryLayer {
  name: string;
  extent: number;
  features: BinaryFeatures;
}

/**
 * Convert standard Tile to BinaryTile for GPU-efficient rendering
 */
export function tileToBinaryTile(tile: Tile): BinaryTile {
  return {
    id: tile.id,
    timeRange: tile.timeRange,
    layers: tile.layers.map(layerToBinaryLayer),
  };
}

/**
 * Convert standard Layer to BinaryLayer
 */
export function layerToBinaryLayer(layer: Layer): BinaryLayer {
  return {
    name: layer.name,
    extent: layer.extent,
    features: featuresToBinaryFeatures(layer.features),
  };
}

/**
 * Convert array of Feature objects to BinaryFeatures
 * This is the main conversion function for GPU-ready data
 */
export function featuresToBinaryFeatures(features: Feature[]): BinaryFeatures {
  const featureCount = features.length;
  
  if (featureCount === 0) {
    return createEmptyBinaryFeatures();
  }
  
  // Determine geometry type from first feature
  const geometryType = features[0].type;
  const isPoint = geometryType === 0; // GeometryType.Point
  
  // Calculate total positions needed
  let totalPositions = 0;
  for (const feature of features) {
    totalPositions += feature.positions.length;
  }
  
  // Allocate typed arrays
  const positions = new Float64Array(totalPositions * 2);
  const positionOffsets = isPoint ? undefined : new Uint32Array(featureCount + 1);
  const featureIds = new Uint32Array(featureCount);
  const startTimes = new Float32Array(featureCount);
  const endTimes = new Float32Array(featureCount);
  
  // Find time offset for precision (use minimum start time)
  let minTime = Infinity;
  for (const feature of features) {
    if (feature.timeRange?.start !== undefined && feature.timeRange.start < minTime) {
      minTime = feature.timeRange.start;
    }
  }
  const timeOffset = isFinite(minTime) ? minTime : 0;
  
  // Collect numeric and categorical properties
  const numericProps: Record<string, number[]> = {};
  const categoricalProps: Record<string, { values: string[]; indexMap: Map<string, number> }> = {};
  
  // First pass: identify property types from first feature
  if (features[0].properties) {
    for (const [key, value] of Object.entries(features[0].properties)) {
      if (typeof value === 'number') {
        numericProps[key] = [];
      } else if (typeof value === 'string') {
        categoricalProps[key] = { values: [], indexMap: new Map() };
      }
    }
  }
  
  // Fill arrays
  let positionIndex = 0;
  for (let i = 0; i < featureCount; i++) {
    const feature = features[i];
    
    // Feature ID
    featureIds[i] = feature.id;
    
    // Times (relative to offset)
    startTimes[i] = feature.timeRange?.start !== undefined 
      ? feature.timeRange.start - timeOffset 
      : -Infinity;
    endTimes[i] = feature.timeRange?.end !== undefined 
      ? feature.timeRange.end - timeOffset 
      : Infinity;
    
    // Position offset for non-point geometries
    if (positionOffsets) {
      positionOffsets[i] = positionIndex / 2;
    }
    
    // Positions
    for (const [lon, lat] of feature.positions) {
      positions[positionIndex++] = lon;
      positions[positionIndex++] = lat;
    }
    
    // Properties
    if (feature.properties) {
      for (const [key, value] of Object.entries(feature.properties)) {
        if (typeof value === 'number' && numericProps[key]) {
          numericProps[key].push(value);
        } else if (typeof value === 'string' && categoricalProps[key]) {
          const cat = categoricalProps[key];
          if (!cat.indexMap.has(value)) {
            cat.indexMap.set(value, cat.values.length);
            cat.values.push(value);
          }
        }
      }
    }
  }
  
  // Final position offset
  if (positionOffsets) {
    positionOffsets[featureCount] = positionIndex / 2;
  }
  
  // Convert numeric properties to typed arrays
  const numericProperties: Record<string, Float32Array> = {};
  for (const [key, values] of Object.entries(numericProps)) {
    numericProperties[key] = new Float32Array(values);
  }
  
  // Convert categorical properties
  const categoricalProperties: Record<string, { indices: Uint8Array; categories: string[] }> = {};
  for (const [key, cat] of Object.entries(categoricalProps)) {
    const indices = new Uint8Array(featureCount);
    for (let i = 0; i < featureCount; i++) {
      const value = features[i].properties?.[key];
      if (typeof value === 'string') {
        indices[i] = cat.indexMap.get(value) ?? 0;
      }
    }
    categoricalProperties[key] = {
      indices,
      categories: cat.values,
    };
  }
  
  return {
    featureCount,
    geometryType,
    positions,
    positionOffsets,
    featureIds,
    startTimes,
    endTimes,
    timeOffset,
    numericProperties,
    categoricalProperties,
  };
}

/**
 * Create empty binary features structure
 */
function createEmptyBinaryFeatures(): BinaryFeatures {
  return {
    featureCount: 0,
    geometryType: 0,
    positions: new Float64Array(0),
    featureIds: new Uint32Array(0),
    startTimes: new Float32Array(0),
    endTimes: new Float32Array(0),
    timeOffset: 0,
    numericProperties: {},
    categoricalProperties: {},
  };
}

/**
 * Get position for a point feature from binary data
 */
export function getBinaryPosition(
  binary: BinaryFeatures, 
  featureIndex: number
): [number, number] {
  const offset = featureIndex * 2;
  return [binary.positions[offset], binary.positions[offset + 1]];
}

/**
 * Get path positions for a line/polygon feature from binary data
 */
export function getBinaryPath(
  binary: BinaryFeatures,
  featureIndex: number
): [number, number][] {
  if (!binary.positionOffsets) {
    // Point geometry - single position
    return [getBinaryPosition(binary, featureIndex)];
  }
  
  const startOffset = binary.positionOffsets[featureIndex] * 2;
  const endOffset = binary.positionOffsets[featureIndex + 1] * 2;
  const path: [number, number][] = [];
  
  for (let i = startOffset; i < endOffset; i += 2) {
    path.push([binary.positions[i], binary.positions[i + 1]]);
  }
  
  return path;
}

/**
 * Calculate memory size of binary features (for cache management)
 */
export function getBinaryFeaturesSize(binary: BinaryFeatures): number {
  let size = binary.positions.byteLength;
  size += binary.featureIds.byteLength;
  size += binary.startTimes.byteLength;
  size += binary.endTimes.byteLength;
  
  if (binary.positionOffsets) {
    size += binary.positionOffsets.byteLength;
  }
  
  for (const arr of Object.values(binary.numericProperties)) {
    size += arr.byteLength;
  }
  
  for (const { indices } of Object.values(binary.categoricalProperties)) {
    size += indices.byteLength;
  }
  
  return size;
}



/**
 * Tile decoding utilities
 * 
 * Decodes directly to BinaryFeatures format for GPU-efficient rendering.
 * No intermediate Feature objects are created - data goes straight to typed arrays.
 */

import { stt } from './proto';
import {
  BinaryFeatures,
  GeometryType,
  Layer,
  Tile,
  TileId,
} from './types';

/**
 * Decode a tile from Protocol Buffer bytes directly to binary format
 */
export function decodeTile(data: Uint8Array, id: TileId): Tile {
  const protoTile = stt.Tile.decode(data);
  const tileTimeStart = Number(protoTile.timeStart) || 0;
  const tileTimeEnd = Number(protoTile.timeEnd) || 0;

  const layers = (protoTile.layers || []).map((layer) => 
    decodeLayerBinary(layer, id, tileTimeStart)
  );

  return {
    id,
    timeRange: {
      start: tileTimeStart,
      end: tileTimeEnd,
    },
    layers,
  };
}

/**
 * Decode a layer directly to binary format
 */
function decodeLayerBinary(
  protoLayer: stt.ILayer, 
  tileId: TileId, 
  tileTimeStart: number
): Layer {
  const extent = protoLayer.extent || 4096;
  
  if (!protoLayer.columnar) {
    throw new Error('Invalid tile: missing columnar data. Only columnar format is supported.');
  }
  
  const columnar = protoLayer.columnar;
  const featureCount = columnar.featureCount || 0;
  const geometryType = protoGeomTypeToType(
    (columnar.geometryType ?? stt.Feature.GeomType.POINT) as stt.Feature.GeomType
  );
  const isPoint = geometryType === GeometryType.Point;
  
  // Handle empty tiles
  if (featureCount === 0) {
    return {
      name: protoLayer.name || 'default',
      extent,
      features: createEmptyBinaryFeatures(geometryType),
    };
  }
  
  // Decode geometry to Float64Array positions
  const { positions, positionOffsets } = decodeGeometry(
    columnar.geometry || [],
    columnar.geometryOffsets || [],
    tileId,
    extent,
    featureCount,
    isPoint
  );
  
  // Decode feature IDs
  const featureIds = new Uint32Array(featureCount);
  const protoFeatureIds = columnar.featureIds || [];
  for (let i = 0; i < featureCount; i++) {
    featureIds[i] = Number(protoFeatureIds[i]) || i;
  }
  
  // Decode times directly to Float32Array (relative to tileTimeStart for precision)
  const startTimes = new Float32Array(featureCount);
  const endTimes = new Float32Array(featureCount);
  const protoStartTimes = columnar.startTimes || [];
  const protoEndTimes = columnar.endTimes || [];
  
  for (let i = 0; i < featureCount; i++) {
    const startDelta = Number(protoStartTimes[i]) || 0;
    const endDelta = Number(protoEndTimes[i]) || 0;
    startTimes[i] = startDelta;
    endTimes[i] = startDelta + endDelta; // endTimes[i] is absolute relative to timeOffset
  }
  
  // Decode properties directly to typed arrays
  const numericProperties = decodeNumericProperties(columnar.numericProperties || []);
  const categoricalProperties = decodeCategoricalProperties(columnar.categoricalProperties || []);
  
  return {
    name: protoLayer.name || 'default',
    extent,
    features: {
      featureCount,
      geometryType,
      positionDimensions: 2,
      positions,
      startIndices: positionOffsets,
      featureIds,
      startTimes,
      endTimes,
      timeOffset: tileTimeStart,
      numericProps: numericProperties,
      categoricalProps: categoricalProperties,
    },
  };
}

/**
 * Decode geometry from delta-encoded quantized format directly to Float64Array
 */
function decodeGeometry(
  geometry: number[],
  geometryOffsets: number[],
  tileId: TileId,
  extent: number,
  featureCount: number,
  isPoint: boolean
): { positions: Float64Array; positionOffsets?: Uint32Array } {
  // Calculate total coordinate count
  let totalCoords: number;
  if (isPoint) {
    totalCoords = featureCount;
  } else {
    // For lines/polygons, last offset tells us total
    totalCoords = geometryOffsets.length > 0 
      ? geometryOffsets[geometryOffsets.length - 1] || (geometry.length / 2)
      : geometry.length / 2;
  }
  
  // Pre-calculate tile projection constants
  const n = Math.pow(2, tileId.z);
  const tileX = tileId.x;
  const tileY = tileId.y;
  
  // Allocate output arrays
  const positions = new Float64Array(totalCoords * 2);
  const positionOffsets = isPoint ? undefined : new Uint32Array(featureCount + 1);
  
  // Delta decode and dequantize in a single pass
  let prevX = 0;
  let prevY = 0;
  let posIdx = 0;
  
  for (let i = 0; i < featureCount; i++) {
    // Determine geometry range for this feature
    let geomStart: number;
    let geomEnd: number;
    
    if (isPoint) {
      geomStart = i * 2;
      geomEnd = geomStart + 2;
    } else {
      geomStart = (geometryOffsets[i] || 0) * 2;
      geomEnd = (geometryOffsets[i + 1] ?? geometry.length / 2) * 2;
      positionOffsets![i] = posIdx / 2;
    }
    
    // Decode coordinates for this feature
    for (let j = geomStart; j < geomEnd; j += 2) {
      // Delta decode
      const dx = geometry[j] || 0;
      const dy = geometry[j + 1] || 0;
      const qx = prevX + dx;
      const qy = prevY + dy;
      prevX = qx;
      prevY = qy;
      
      // Dequantize to WGS84 - inline for performance
      const worldX = tileX + (qx / extent);
      const worldY = tileY + (qy / extent);
      const lon = (worldX / n) * 360 - 180;
      const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * worldY) / n)));
      const lat = latRad * (180 / Math.PI);
      
      positions[posIdx++] = lon;
      positions[posIdx++] = lat;
    }
  }
  
  // Final offset for non-point geometries
  if (positionOffsets) {
    positionOffsets[featureCount] = posIdx / 2;
  }
  
  return { positions, positionOffsets };
}

/**
 * Decode numeric properties directly to Float32Arrays
 */
function decodeNumericProperties(
  protoProperties: stt.INumericColumn[]
): Record<string, Float32Array> {
  const result: Record<string, Float32Array> = {};
  
  for (const col of protoProperties) {
    if (col.name && col.values) {
      result[col.name] = new Float32Array(col.values);
    }
  }
  
  return result;
}

/**
 * Decode categorical properties to indexed arrays
 */
function decodeCategoricalProperties(
  protoProperties: stt.ICategoricalColumn[]
): Record<string, { indices: Uint8Array; categories: string[] }> {
  const result: Record<string, { indices: Uint8Array; categories: string[] }> = {};
  
  for (const col of protoProperties) {
    if (col.name && col.categories && col.indices) {
      result[col.name] = {
        indices: new Uint8Array(col.indices),
        categories: col.categories,
      };
    }
  }
  
  return result;
}

/**
 * Create empty binary features structure
 */
function createEmptyBinaryFeatures(geometryType: GeometryType): BinaryFeatures {
  return {
    featureCount: 0,
    geometryType,
    positionDimensions: 2,
    positions: new Float64Array(0),
    featureIds: new Uint32Array(0),
    startTimes: new Float32Array(0),
    endTimes: new Float32Array(0),
    timeOffset: 0,
    numericProps: {},
    categoricalProps: {},
  };
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

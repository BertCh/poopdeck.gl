/**
 * Tile decoding utilities
 * 
 * Supports both Version 1 (absolute WGS84 coords) and Version 2 (quantized + columnar)
 */

import { stt } from './proto';
import {
  Feature,
  GeometryType,
  Layer,
  PropertyValue,
  Tile,
  TileId,
} from './types';

/**
 * Decode a tile from Protocol Buffer bytes
 */
export function decodeTile(data: Uint8Array, id: TileId): Tile {
  const protoTile = stt.Tile.decode(data);
  const version = protoTile.version || 1;
  const tileTimeStart = Number(protoTile.timeStart) || 0;

  const layers = (protoTile.layers || []).map((layer) => 
    decodeLayer(layer, id, version, tileTimeStart)
  );

  return {
    id,
    timeRange: {
      start: tileTimeStart,
      end: Number(protoTile.timeEnd) || 0,
    },
    layers,
  };
}

function decodeLayer(protoLayer: stt.ILayer, tileId: TileId, version: number, tileTimeStart: number): Layer {
  const extent = protoLayer.extent || 4096;
  
  // Check if this is a Version 2 layer with columnar data
  if (version >= 2 && protoLayer.columnar) {
    return decodeColumnarLayer(protoLayer, tileId, extent, tileTimeStart);
  }
  
  // Version 1: Individual features with absolute coordinates
  const features = (protoLayer.features || []).map((feature) => 
    decodeFeature(feature)
  );

  return {
    name: protoLayer.name || 'default',
    extent,
    features,
  };
}

/**
 * Decode a Version 2 columnar layer
 */
function decodeColumnarLayer(
  protoLayer: stt.ILayer, 
  tileId: TileId, 
  extent: number,
  tileTimeStart: number
): Layer {
  const columnar = protoLayer.columnar!;
  const featureCount = columnar.featureCount || 0;
  const geometryType = protoGeomTypeToType(
    (columnar.geometryType ?? stt.Feature.GeomType.POINT) as stt.Feature.GeomType
  );
  const isPoint = geometryType === GeometryType.Point;
  
// Pre-decode categorical properties into lookup tables
  const categoricalLookup: Map<string, { categories: string[]; indices: Uint8Array }> = new Map();
  for (const col of columnar.categoricalProperties || []) {
    if (col.name && col.categories && col.indices) {
      categoricalLookup.set(col.name, {
        categories: col.categories,
        indices: new Uint8Array(col.indices),
      });
    }
  }
  
  // Pre-decode numeric properties into arrays
  const numericLookup: Map<string, Float32Array> = new Map();
  for (const col of columnar.numericProperties || []) {
    if (col.name && col.values) {
      numericLookup.set(col.name, new Float32Array(col.values));
    }
  }
  
  const features: Feature[] = [];
  const geometry = columnar.geometry || [];
  const geometryOffsets = columnar.geometryOffsets || [];
  const featureIds = columnar.featureIds || [];
  const startTimes = columnar.startTimes || [];
  const endTimes = columnar.endTimes || [];
  
  // Decode each feature
  let prevX = 0;
  let prevY = 0;
  
  for (let i = 0; i < featureCount; i++) {
    // Determine geometry range
    let geomStart: number;
    let geomEnd: number;
    
    if (isPoint) {
      geomStart = i * 2;
      geomEnd = geomStart + 2;
    } else {
      geomStart = (geometryOffsets[i] || 0) * 2;
      geomEnd = (geometryOffsets[i + 1] || geometry.length / 2) * 2;
    }
    
    // Decode positions (delta + quantized -> WGS84)
    const positions: [number, number][] = [];
    for (let j = geomStart; j < geomEnd; j += 2) {
      // Delta decode
      const dx = geometry[j] || 0;
      const dy = geometry[j + 1] || 0;
      const qx = prevX + dx;
      const qy = prevY + dy;
      prevX = qx;
      prevY = qy;
      
      // Dequantize to WGS84
      const [lon, lat] = tileRelativeToWgs84(qx, qy, tileId, extent);
      positions.push([lon, lat]);
    }
    
    // Decode properties
    const properties: Record<string, PropertyValue> = {};
    
    for (const [name, { categories, indices }] of categoricalLookup) {
      const idx = indices[i] || 0;
      properties[name] = categories[idx] || '';
    }
    
    for (const [name, values] of numericLookup) {
      properties[name] = values[i] || 0;
    }
    
    // Decode timestamps (delta relative to tile time_start)
    const startDelta = Number(startTimes[i]) || 0;
    const endDelta = Number(endTimes[i]) || 0;
    const absoluteStart = tileTimeStart + startDelta;
    
    features.push({
      id: Number(featureIds[i]) || i,
      type: geometryType,
      positions,
      properties,
      timeRange: {
        start: absoluteStart,
        end: absoluteStart + endDelta,
      },
    });
  }
  
return {
    name: protoLayer.name || 'default',
    extent,
    features,
  };
}

/**
 * Convert tile-relative quantized coordinates to WGS84
 */
function tileRelativeToWgs84(
  x: number,
  y: number,
  tileId: TileId,
  extent: number
): [number, number] {
  const n = Math.pow(2, tileId.z);
  
  // Convert from tile-relative to world coordinates
  const worldX = tileId.x + (x / extent);
  const worldY = tileId.y + (y / extent);
  
  // Convert to WGS84
  const lon = (worldX / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * worldY) / n)));
  const lat = latRad * (180 / Math.PI);
  
  return [lon, lat];
}

function decodeFeature(protoFeature: stt.IFeature): Feature {
  const positions = (protoFeature.positions || []).map((position) => [
    Number(position?.lon) || 0,
    Number(position?.lat) || 0,
  ]) as [number, number][];

  const properties: Record<string, PropertyValue> = {};
  if (protoFeature.properties) {
    for (const [key, value] of Object.entries(protoFeature.properties)) {
      properties[key] = protoValueToValue(value);
    }
  }

  return {
    id: Number(protoFeature.id) || 0,
    type: protoGeomTypeToType(
      (protoFeature.type ?? stt.Feature.GeomType.POINT) as stt.Feature.GeomType
    ),
    positions,
    properties,
    timeRange:
      protoFeature.validFrom !== undefined && protoFeature.validTo !== undefined
        ? {
            start: Number(protoFeature.validFrom),
            end: Number(protoFeature.validTo),
          }
        : undefined,
  };
}

function protoValueToValue(protoValue: any): PropertyValue {
  if (!protoValue) return '';

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

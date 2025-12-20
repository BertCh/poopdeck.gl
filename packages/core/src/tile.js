/**
 * Tile decoding utilities
 *
 * Decodes directly to BinaryFeatures format for GPU-efficient rendering.
 * No intermediate Feature objects are created - data goes straight to typed arrays.
 */
import { stt } from './proto';
import { GeometryType, } from './types';
/**
 * Decode a tile from Protocol Buffer bytes directly to binary format
 */
export function decodeTile(data, id) {
    const protoTile = stt.Tile.decode(data);
    const tileTimeStart = Number(protoTile.timeStart) || 0;
    const tileTimeEnd = Number(protoTile.timeEnd) || 0;
    const layers = (protoTile.layers || []).map((layer) => decodeLayerBinary(layer, id, tileTimeStart));
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
function decodeLayerBinary(protoLayer, tileId, tileTimeStart) {
    const extent = protoLayer.extent || 4096;
    if (!protoLayer.columnar) {
        throw new Error('Invalid tile: missing columnar data. Only columnar format is supported.');
    }
    const columnar = protoLayer.columnar;
    const featureCount = columnar.featureCount || 0;
    const geometryType = protoGeomTypeToType((columnar.geometryType ?? stt.Feature.GeomType.POINT));
    const isPoint = geometryType === GeometryType.Point;
    // Handle empty tiles
    if (featureCount === 0) {
        return {
            name: protoLayer.name || 'default',
            extent,
            features: createEmptyBinaryFeatures(geometryType),
        };
    }
    // Check if we have altitude data (3D)
    const altitudes = columnar.altitudes || [];
    const has3D = altitudes.length > 0;
    // Decode geometry to Float64Array positions (2D or 3D)
    const { positions, positionOffsets } = decodeGeometry(columnar.geometry || [], columnar.geometryOffsets || [], tileId, extent, featureCount, isPoint, has3D ? altitudes : undefined);
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
    // Decode per-vertex timestamps if present (for accurate path animation)
    const protoVertexTimestamps = columnar.vertexTimestamps || [];
    const dims = has3D ? 3 : 2;
    const expectedVertexCount = positions.length / dims;
    let vertexTimestamps;
    if (protoVertexTimestamps.length > 0) {
        // Validate that we have timestamps for all vertices
        if (protoVertexTimestamps.length === expectedVertexCount) {
            vertexTimestamps = new Float32Array(expectedVertexCount);
            for (let i = 0; i < expectedVertexCount; i++) {
                vertexTimestamps[i] = Number(protoVertexTimestamps[i]) || 0;
            }
        }
        else {
            console.warn(`[STT] vertexTimestamps length mismatch: expected ${expectedVertexCount}, got ${protoVertexTimestamps.length}`);
        }
    }
    return {
        name: protoLayer.name || 'default',
        extent,
        features: {
            featureCount,
            geometryType,
            positionDimensions: has3D ? 3 : 2,
            positions,
            startIndices: positionOffsets,
            featureIds,
            startTimes,
            endTimes,
            timeOffset: tileTimeStart,
            vertexTimestamps,
            numericProps: numericProperties,
            categoricalProps: categoricalProperties,
        },
    };
}
/**
 * Decode geometry from delta-encoded quantized format directly to Float64Array
 * Supports 2D (lon, lat) and 3D (lon, lat, alt) when altitudes are provided
 */
function decodeGeometry(geometry, geometryOffsets, tileId, extent, featureCount, isPoint, altitudes) {
    const dims = altitudes ? 3 : 2;
    // Calculate total coordinate count
    let totalCoords;
    if (isPoint) {
        totalCoords = featureCount;
    }
    else {
        // For lines/polygons, last offset tells us total
        totalCoords = geometryOffsets.length > 0
            ? geometryOffsets[geometryOffsets.length - 1] || (geometry.length / 2)
            : geometry.length / 2;
    }
    // Pre-calculate tile projection constants
    const n = Math.pow(2, tileId.z);
    const tileX = tileId.x;
    const tileY = tileId.y;
    // Allocate output arrays (2 or 3 values per coordinate)
    const positions = new Float64Array(totalCoords * dims);
    const positionOffsets = isPoint ? undefined : new Uint32Array(featureCount + 1);
    // Delta decode and dequantize in a single pass
    let prevX = 0;
    let prevY = 0;
    let posIdx = 0;
    let altIdx = 0;
    for (let i = 0; i < featureCount; i++) {
        // Determine geometry range for this feature
        let geomStart;
        let geomEnd;
        if (isPoint) {
            geomStart = i * 2;
            geomEnd = geomStart + 2;
        }
        else {
            geomStart = (geometryOffsets[i] || 0) * 2;
            geomEnd = (geometryOffsets[i + 1] ?? geometry.length / 2) * 2;
            positionOffsets[i] = posIdx / dims;
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
            // Add altitude if 3D
            if (altitudes) {
                positions[posIdx++] = altitudes[altIdx++] || 0;
            }
        }
    }
    // Final offset for non-point geometries
    if (positionOffsets) {
        positionOffsets[featureCount] = posIdx / dims;
    }
    return { positions, positionOffsets };
}
/**
 * Decode numeric properties directly to Float32Arrays
 */
function decodeNumericProperties(protoProperties) {
    const result = {};
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
function decodeCategoricalProperties(protoProperties) {
    const result = {};
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
function createEmptyBinaryFeatures(geometryType) {
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
function protoGeomTypeToType(protoType) {
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
//# sourceMappingURL=tile.js.map
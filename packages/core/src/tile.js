/**
 * Tile decoding utilities
 */
import { stt } from './proto';
import { GeometryType, } from './types';
/**
 * Decode a tile from Protocol Buffer bytes
 */
export function decodeTile(data, id) {
    const protoTile = stt.Tile.decode(data);
    const layers = (protoTile.layers || []).map((layer) => decodeLayer(layer));
    return {
        id,
        timeRange: {
            start: Number(protoTile.timeStart) || 0,
            end: Number(protoTile.timeEnd) || 0,
        },
        layers,
    };
}
function decodeLayer(protoLayer) {
    const features = (protoLayer.features || []).map((feature) => decodeFeature(feature));
    return {
        name: protoLayer.name || 'default',
        extent: protoLayer.extent || 4096,
        features,
    };
}
function decodeFeature(protoFeature) {
    const positions = (protoFeature.positions || []).map((position) => [
        Number(position?.lon) || 0,
        Number(position?.lat) || 0,
    ]);
    const properties = {};
    if (protoFeature.properties) {
        for (const [key, value] of Object.entries(protoFeature.properties)) {
            properties[key] = protoValueToValue(value);
        }
    }
    return {
        id: Number(protoFeature.id) || 0,
        type: protoGeomTypeToType((protoFeature.type ?? stt.Feature.GeomType.POINT)),
        positions,
        properties,
        timeRange: protoFeature.validFrom !== undefined && protoFeature.validTo !== undefined
            ? {
                start: Number(protoFeature.validFrom),
                end: Number(protoFeature.validTo),
            }
            : undefined,
    };
}
function protoValueToValue(protoValue) {
    if (!protoValue)
        return '';
    if (protoValue.stringValue !== undefined)
        return String(protoValue.stringValue);
    if (protoValue.doubleValue !== undefined)
        return Number(protoValue.doubleValue);
    if (protoValue.floatValue !== undefined)
        return Number(protoValue.floatValue);
    if (protoValue.intValue !== undefined)
        return Number(protoValue.intValue);
    if (protoValue.uintValue !== undefined)
        return Number(protoValue.uintValue);
    if (protoValue.sintValue !== undefined)
        return Number(protoValue.sintValue);
    if (protoValue.boolValue !== undefined)
        return Boolean(protoValue.boolValue);
    return '';
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

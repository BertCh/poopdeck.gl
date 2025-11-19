/**
 * Tile decoding utilities
 */
import { stt } from './proto';
import { GeometryType, ChangeType, } from './types';
/**
 * Delta tile decoder with feature caching for efficient reconstruction
 * of unchanged features across temporal tiles.
 */
export class DeltaTileDecoder {
    constructor() {
        // Cache features across tiles for delta reconstruction
        // Key: feature ID, Value: cached feature
        this.featureCache = new Map();
        // Track cache statistics
        this.cacheHits = 0;
        this.cacheMisses = 0;
    }
    /**
     * Decode a tile and reconstruct UNCHANGED features from cache
     */
    decodeTile(data, id) {
        const protoTile = stt.Tile.decode(data);
        const layers = (protoTile.layers || []).map((protoLayer) => {
            const features = [];
            for (const protoFeature of (protoLayer.features || [])) {
                const changeType = (protoFeature.change ?? 1); // Default to CREATED
                if (changeType === ChangeType.Unchanged) {
                    // Reconstruct from cache
                    const featureId = Number(protoFeature.id) || 0;
                    const cached = this.featureCache.get(featureId);
                    if (cached) {
                        this.cacheHits++;
                        // Return cached feature (shallow copy to avoid mutation)
                        features.push({ ...cached });
                    }
                    else {
                        this.cacheMisses++;
                        console.warn(`[DeltaTileDecoder] Missing cache entry for UNCHANGED feature ${featureId} ` +
                            `in tile ${id.z}/${id.x}/${id.y}/${id.t}`);
                        // Skip this feature - it should have been in cache
                    }
                }
                else if (changeType === ChangeType.Deleted) {
                    // Remove from cache
                    const featureId = Number(protoFeature.id) || 0;
                    this.featureCache.delete(featureId);
                    // Don't add to features array
                }
                else {
                    // CREATED or MODIFIED - decode normally
                    const feature = this.decodeFeature(protoFeature, protoLayer);
                    // Cache for future UNCHANGED references
                    this.featureCache.set(feature.id, feature);
                    features.push(feature);
                }
            }
            return {
                name: protoLayer.name || 'default',
                extent: protoLayer.extent || 4096,
                features,
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
     * Decode a single feature from proto format
     */
    decodeFeature(protoFeature, protoLayer) {
        // Decode properties from tags
        const properties = {};
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
            timeRange: protoFeature.validFrom && protoFeature.validTo
                ? {
                    start: Number(protoFeature.validFrom),
                    end: Number(protoFeature.validTo),
                }
                : undefined,
            changeType: protoFeature.change !== undefined ? Number(protoFeature.change) : ChangeType.Created,
        };
    }
    /**
     * Clear the cache (e.g., when switching datasets or zoom levels)
     */
    clearCache() {
        this.featureCache.clear();
        this.cacheHits = 0;
        this.cacheMisses = 0;
    }
    /**
     * Get cache statistics
     */
    getCacheStats() {
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
export function decodeTile(data, id) {
    return deltaTileDecoder.decodeTile(data, id);
}
function protoValueToValue(protoValue) {
    if (!protoValue)
        return '';
    // Protobufjs represents oneof fields directly on the object
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
/**
 * Decode geometry from delta-encoded format
 * Compatible with Mapbox Vector Tiles encoding
 */
export function decodeGeometry(geometry, _geometryType, extent = 4096) {
    const coordinates = [];
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
        }
        else if (cmd === 7) {
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
function zigzagDecode(n) {
    return (n >> 1) ^ -(n & 1);
}
/**
 * Convert flat coordinates to GeoJSON-style nested arrays
 */
export function toGeoJSON(coordinates, geometryType) {
    switch (geometryType) {
        case GeometryType.Point:
            return coordinates[0];
        case GeometryType.LineString:
            return coordinates;
        case GeometryType.Polygon:
            // Group by rings (first is outer, rest are holes)
            const rings = [];
            let currentRing = [];
            for (const coord of coordinates) {
                currentRing.push(coord);
                // Detect closed ring (last point equals first)
                if (currentRing.length > 2 &&
                    currentRing[0][0] === coord[0] &&
                    currentRing[0][1] === coord[1]) {
                    rings.push(currentRing);
                    currentRing = [];
                }
            }
            return rings;
        default:
            return coordinates;
    }
}
//# sourceMappingURL=tile.js.map
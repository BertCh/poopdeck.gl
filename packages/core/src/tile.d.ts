/**
 * Tile decoding utilities
 */
import { Tile, TileId, GeometryType } from './types';
/**
 * Delta tile decoder with feature caching for efficient reconstruction
 * of unchanged features across temporal tiles.
 */
export declare class DeltaTileDecoder {
    private featureCache;
    private cacheHits;
    private cacheMisses;
    /**
     * Decode a tile and reconstruct UNCHANGED features from cache
     */
    decodeTile(data: Uint8Array, id: TileId): Tile;
    /**
     * Decode a single feature from proto format
     */
    private decodeFeature;
    /**
     * Clear the cache (e.g., when switching datasets or zoom levels)
     */
    clearCache(): void;
    /**
     * Get cache statistics
     */
    getCacheStats(): {
        hits: number;
        misses: number;
        size: number;
        hitRate: number;
    };
}
export declare const deltaTileDecoder: DeltaTileDecoder;
/**
 * Decode a tile from Protocol Buffer bytes (convenience function)
 * Uses the singleton delta decoder for automatic caching
 */
export declare function decodeTile(data: Uint8Array, id: TileId): Tile;
/**
 * Decode geometry from delta-encoded format
 * Compatible with Mapbox Vector Tiles encoding
 */
export declare function decodeGeometry(geometry: number[], _geometryType: GeometryType, extent?: number): number[][];
/**
 * Convert flat coordinates to GeoJSON-style nested arrays
 */
export declare function toGeoJSON(coordinates: number[][], geometryType: GeometryType): any;
//# sourceMappingURL=tile.d.ts.map
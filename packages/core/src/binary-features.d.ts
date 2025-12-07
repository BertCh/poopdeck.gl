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
export declare function tileToBinaryTile(tile: Tile): BinaryTile;
/**
 * Convert standard Layer to BinaryLayer
 */
export declare function layerToBinaryLayer(layer: Layer): BinaryLayer;
/**
 * Convert array of Feature objects to BinaryFeatures
 * This is the main conversion function for GPU-ready data
 */
export declare function featuresToBinaryFeatures(features: Feature[]): BinaryFeatures;
/**
 * Get position for a point feature from binary data
 */
export declare function getBinaryPosition(binary: BinaryFeatures, featureIndex: number): [number, number];
/**
 * Get path positions for a line/polygon feature from binary data
 */
export declare function getBinaryPath(binary: BinaryFeatures, featureIndex: number): [number, number][];
/**
 * Calculate memory size of binary features (for cache management)
 */
export declare function getBinaryFeaturesSize(binary: BinaryFeatures): number;
//# sourceMappingURL=binary-features.d.ts.map
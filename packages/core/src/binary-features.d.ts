/**
 * Binary Features Utilities
 *
 * Helper functions for working with BinaryFeatures data.
 * The main types are defined in types.ts.
 */
import type { BinaryFeatures, GeometryType } from './types';
export type { BinaryFeatures } from './types';
/**
 * Get 2D position for a point feature from binary data
 */
export declare function getBinaryPosition(binary: BinaryFeatures, featureIndex: number): [number, number];
/**
 * Get 3D position for a point feature from binary data
 * Returns [lon, lat, altitude] - altitude is 0 if not available
 */
export declare function getBinaryPosition3D(binary: BinaryFeatures, featureIndex: number): [number, number, number];
/**
 * Get absolute start time for a feature (timeOffset + startTimes[i])
 */
export declare function getAbsoluteStartTime(binary: BinaryFeatures, featureIndex: number): number;
/**
 * Get absolute end time for a feature (timeOffset + endTimes[i])
 */
export declare function getAbsoluteEndTime(binary: BinaryFeatures, featureIndex: number): number;
/**
 * Get a numeric property value for a feature
 */
export declare function getNumericProperty(binary: BinaryFeatures, propertyName: string, featureIndex: number): number | undefined;
/**
 * Get a categorical property value for a feature (resolved string value)
 */
export declare function getCategoricalProperty(binary: BinaryFeatures, propertyName: string, featureIndex: number): string | undefined;
/**
 * Get the category index for a feature (for color mapping)
 */
export declare function getCategoricalIndex(binary: BinaryFeatures, propertyName: string, featureIndex: number): number | undefined;
/**
 * Calculate memory size of binary features (for cache management)
 */
export declare function getBinaryFeaturesSize(binary: BinaryFeatures): number;
/**
 * Create empty binary features structure
 */
export declare function createEmptyBinaryFeatures(geometryType?: GeometryType): BinaryFeatures;
/**
 * Check if a feature is visible at a given time
 */
export declare function isFeatureVisible(binary: BinaryFeatures, featureIndex: number, currentTime: number, timeWindow: number): boolean;
/**
 * Get the number of positions for a specific feature
 * For points, this is always 1
 * For lines/polygons, uses the startIndices array
 */
export declare function getFeaturePositionCount(binary: BinaryFeatures, featureIndex: number): number;
//# sourceMappingURL=binary-features.d.ts.map
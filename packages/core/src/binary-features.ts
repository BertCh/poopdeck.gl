/**
 * Binary Features Utilities
 * 
 * Helper functions for working with BinaryFeatures data.
 * The main types are defined in types.ts.
 */

import type { BinaryFeatures, GeometryType } from './types';

// Re-export for convenience
export type { BinaryFeatures } from './types';

/**
 * Get 2D position for a point feature from binary data
 */
export function getBinaryPosition(
  binary: BinaryFeatures, 
  featureIndex: number
): [number, number] {
  const dims = binary.positionDimensions ?? 2;
  const offset = featureIndex * dims;
  return [binary.positions[offset], binary.positions[offset + 1]];
}

/**
 * Get 3D position for a point feature from binary data
 * Returns [lon, lat, altitude] - altitude is 0 if not available
 */
export function getBinaryPosition3D(
  binary: BinaryFeatures, 
  featureIndex: number
): [number, number, number] {
  const dims = binary.positionDimensions ?? 2;
  const offset = featureIndex * dims;
  return [
    binary.positions[offset], 
    binary.positions[offset + 1],
    dims === 3 ? binary.positions[offset + 2] : 0
  ];
}

/**
 * Get absolute start time for a feature (timeOffset + startTimes[i])
 */
export function getAbsoluteStartTime(binary: BinaryFeatures, featureIndex: number): number {
  return binary.timeOffset + binary.startTimes[featureIndex];
}

/**
 * Get absolute end time for a feature (timeOffset + endTimes[i])
 */
export function getAbsoluteEndTime(binary: BinaryFeatures, featureIndex: number): number {
  return binary.timeOffset + binary.endTimes[featureIndex];
}

/**
 * Get a numeric property value for a feature
 */
export function getNumericProperty(
  binary: BinaryFeatures,
  propertyName: string,
  featureIndex: number
): number | undefined {
  const values = binary.numericProps[propertyName];
  return values ? values[featureIndex] : undefined;
}

/**
 * Get a categorical property value for a feature (resolved string value)
 */
export function getCategoricalProperty(
  binary: BinaryFeatures,
  propertyName: string,
  featureIndex: number
): string | undefined {
  const prop = binary.categoricalProps[propertyName];
  if (!prop) return undefined;
  const idx = prop.indices[featureIndex];
  return prop.categories[idx];
}

/**
 * Get the category index for a feature (for color mapping)
 */
export function getCategoricalIndex(
  binary: BinaryFeatures,
  propertyName: string,
  featureIndex: number
): number | undefined {
  const prop = binary.categoricalProps[propertyName];
  return prop ? prop.indices[featureIndex] : undefined;
}

/**
 * Calculate memory size of binary features (for cache management)
 */
export function getBinaryFeaturesSize(binary: BinaryFeatures): number {
  let size = binary.positions.byteLength;
  size += binary.featureIds.byteLength;
  size += binary.startTimes.byteLength;
  size += binary.endTimes.byteLength;
  
  if (binary.startIndices) {
    size += binary.startIndices.byteLength;
  }
  
  for (const arr of Object.values(binary.numericProps)) {
    size += arr.byteLength;
  }
  
  for (const { indices } of Object.values(binary.categoricalProps)) {
    size += indices.byteLength;
  }
  
  return size;
}

/**
 * Create empty binary features structure
 */
export function createEmptyBinaryFeatures(geometryType: GeometryType = 0): BinaryFeatures {
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

/**
 * Check if a feature is visible at a given time
 */
export function isFeatureVisible(
  binary: BinaryFeatures,
  featureIndex: number,
  currentTime: number,
  timeWindow: number
): boolean {
  const halfWindow = timeWindow / 2;
  const windowStart = currentTime - halfWindow;
  const windowEnd = currentTime + halfWindow;
  
  const featureStart = binary.timeOffset + binary.startTimes[featureIndex];
  const featureEnd = binary.timeOffset + binary.endTimes[featureIndex];
  
  return featureEnd >= windowStart && featureStart <= windowEnd;
}

/**
 * Get the number of positions for a specific feature
 * For points, this is always 1
 * For lines/polygons, uses the startIndices array
 */
export function getFeaturePositionCount(
  binary: BinaryFeatures,
  featureIndex: number
): number {
  if (!binary.startIndices) {
    // Point geometry
    return 1;
  }
  return binary.startIndices[featureIndex + 1] - binary.startIndices[featureIndex];
}

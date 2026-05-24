/**
 * Synthetic Tile / Layer / BinaryFeatures fixtures used by layer tests.
 * Each builder returns a minimal but valid shape; the layers don't care
 * about anything we don't populate (featureIds, props), so we omit them.
 */

import { GeometryType, type Tile, type Layer } from '@stt/core';

export function makePointTile(): Tile {
  const positions = new Float64Array([
    -122.4, 37.7,  // SF
    -73.95, 40.75, // NYC
  ]);
  const features = {
    featureCount: 2,
    geometryType: GeometryType.Point,
    positionDimensions: 2 as const,
    positions,
    featureIds: new Uint32Array([0, 1]),
    startTimes: new Float32Array([0, 5000]),
    endTimes: new Float32Array([3000, 8000]),
    timeOffset: 1_700_000_000_000,
    numericProps: {},
    categoricalProps: {},
  };
  const layer: Layer = {
    name: 'points',
    extent: 4096,
    features,
    geometryExtensionName: 'geoarrow.point',
  };
  return {
    id: { z: 2, x: 1, y: 1, t: 1_700_000_000_000 },
    timeRange: { start: 1_700_000_000_000, end: 1_700_000_003_000 },
    layers: [layer],
  };
}

export function makeLineTile(): Tile {
  // Two paths: one 3-vertex, one 2-vertex (single segment).
  const positions = new Float64Array([
    // Path 0: NYC -> Boston -> Maine
    -73.95, 40.75,
    -71.05, 42.36,
    -69.5, 44.0,
    // Path 1: SF -> LA
    -122.4, 37.7,
    -118.24, 34.05,
  ]);
  const startIndices = new Uint32Array([0, 3, 5]);
  const features = {
    featureCount: 2,
    geometryType: GeometryType.LineString,
    positionDimensions: 2 as const,
    positions,
    startIndices,
    featureIds: new Uint32Array([0, 1]),
    startTimes: new Float32Array([0, 1000]),
    endTimes: new Float32Array([2000, 3000]),
    timeOffset: 1_700_000_000_000,
    numericProps: {},
    categoricalProps: {},
  };
  const layer: Layer = {
    name: 'paths',
    extent: 4096,
    features,
    geometryExtensionName: 'geoarrow.linestring',
  };
  return {
    id: { z: 2, x: 1, y: 1, t: 1_700_000_000_000 },
    timeRange: { start: 1_700_000_000_000, end: 1_700_000_003_000 },
    layers: [layer],
  };
}

/**
 * Two-path tile with per-vertex timestamps and categorical/numeric properties.
 * Used by the trips and per-feature-attribute tests.
 */
export function makeTripsTile(): Tile {
  const positions = new Float64Array([
    // Path 0: 3 vertices
    -73.95, 40.75,
    -71.05, 42.36,
    -69.5, 44.0,
    // Path 1: 2 vertices
    -122.4, 37.7,
    -118.24, 34.05,
  ]);
  const startIndices = new Uint32Array([0, 3, 5]);
  const vertexTimestamps = new Float32Array([0, 1000, 2000, 0, 1500]);
  const features = {
    featureCount: 2,
    geometryType: GeometryType.LineString,
    positionDimensions: 2 as const,
    positions,
    startIndices,
    featureIds: new Uint32Array([0, 1]),
    startTimes: new Float32Array([0, 0]),
    endTimes: new Float32Array([2000, 1500]),
    timeOffset: 1_700_000_000_000,
    vertexTimestamps,
    numericProps: {
      width: new Float32Array([4, 6]),
    },
    categoricalProps: {
      vehicleType: { indices: new Uint16Array([0, 1]), categories: ['truck', 'car'] },
    },
  };
  const layer: Layer = {
    name: 'trips',
    extent: 4096,
    features,
    geometryExtensionName: 'geoarrow.linestring',
  };
  return {
    id: { z: 2, x: 1, y: 1, t: 1_700_000_000_000 },
    timeRange: { start: 1_700_000_000_000, end: 1_700_000_002_000 },
    layers: [layer],
  };
}

/** Point tile with a categorical `species` and numeric `magnitude` property. */
export function makePropertyPointTile(): Tile {
  const positions = new Float64Array([-122.4, 37.7, -73.95, 40.75]);
  const features = {
    featureCount: 2,
    geometryType: GeometryType.Point,
    positionDimensions: 2 as const,
    positions,
    featureIds: new Uint32Array([0, 1]),
    startTimes: new Float32Array([0, 0]),
    endTimes: new Float32Array([5000, 5000]),
    timeOffset: 1_700_000_000_000,
    numericProps: {
      magnitude: new Float32Array([2, 8]),
    },
    categoricalProps: {
      species: { indices: new Uint16Array([0, 1]), categories: ['a', 'b'] },
    },
  };
  const layer: Layer = {
    name: 'props',
    extent: 4096,
    features,
    geometryExtensionName: 'geoarrow.point',
  };
  return {
    id: { z: 2, x: 1, y: 1, t: 1_700_000_000_000 },
    timeRange: { start: 1_700_000_000_000, end: 1_700_000_005_000 },
    layers: [layer],
  };
}

export function makePolygonTile(): Tile {
  // One square polygon covering the equator near (0,0).
  const positions = new Float64Array([
    -10, -10,
    10, -10,
    10, 10,
    -10, 10,
  ]);
  const startIndices = new Uint32Array([0, 4]);
  const features = {
    featureCount: 1,
    geometryType: GeometryType.Polygon,
    positionDimensions: 2 as const,
    positions,
    startIndices,
    featureIds: new Uint32Array([0]),
    startTimes: new Float32Array([0]),
    endTimes: new Float32Array([1000]),
    timeOffset: 1_700_000_000_000,
    numericProps: {},
    categoricalProps: {},
  };
  const layer: Layer = {
    name: 'polys',
    extent: 4096,
    features,
    geometryExtensionName: 'geoarrow.polygon',
  };
  return {
    id: { z: 2, x: 1, y: 1, t: 1_700_000_000_000 },
    timeRange: { start: 1_700_000_000_000, end: 1_700_000_001_000 },
    layers: [layer],
  };
}

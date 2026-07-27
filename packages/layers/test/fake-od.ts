/**
 * Shared OD-flowmap fixtures for the FlowmapLayer / BundledFlowmapLayer suites.
 *
 * Each OD-pair feature is a 2-vertex LineString carrying a `[2 × numBuckets]`
 * per-bucket count matrix (`vertexValueMatrix`). Both files built this fixture
 * byte-for-byte; it lives here once. The two layers are PARALLEL
 * implementations (both extend SpatioTemporalLayer, neither extends the other),
 * so only the fixture is shared — each suite still drives its own layer.
 */

import type { Tile, BinaryFeatures } from '@poopdeck.gl/core';

export interface OdFeature {
  source: [number, number];
  target: [number, number];
  /** per-bucket count array (length = numBuckets) */
  flows: number[];
}

/**
 * Build an OD tile of 2-vertex features, each carrying a per-bucket count.
 * `flows[i]` is feature i's per-bucket count array (length = numBuckets); both
 * its vertices get that array in the global vertex-major matrix.
 */
export function odMatrixTile(
  features: OdFeature[],
  id: { z: number; x: number; y: number; t: number } = {
    z: 12,
    x: 1,
    y: 1,
    t: 0,
  },
): Tile {
  const n = features.length;
  const nb = features[0].flows.length;
  const positions = new Float64Array(n * 2 * 2);
  const startIndices = new Uint32Array(n + 1);
  const matrix = new Float32Array(n * 2 * nb);
  for (let i = 0; i < n; i++) {
    startIndices[i] = i * 2;
    positions[i * 4] = features[i].source[0];
    positions[i * 4 + 1] = features[i].source[1];
    positions[i * 4 + 2] = features[i].target[0];
    positions[i * 4 + 3] = features[i].target[1];
    // Both vertices (global indices 2i, 2i+1) carry the feature's bucket series.
    for (let b = 0; b < nb; b++) {
      matrix[i * 2 * nb + b] = features[i].flows[b];
      matrix[(i * 2 + 1) * nb + b] = features[i].flows[b];
    }
  }
  startIndices[n] = n * 2;

  const binary: BinaryFeatures = {
    featureCount: n,
    geometryType: 1 as any,
    positionDimensions: 2,
    positions,
    startIndices,
    featureIds: new Uint32Array(n),
    startTimes: new Float32Array(n).fill(0),
    endTimes: new Float32Array(n).fill(nb * 1000), // 1000 ms/bucket
    timeOffset: 0,
    vertexValueMatrix: matrix,
    vertexValueBuckets: nb,
    numericProps: {},
    categoricalProps: {},
  };
  return {
    id: id as any,
    timeRange: { start: 0, end: nb * 1000 } as any,
    layers: [
      {
        name: 'layer0',
        extent: 4096,
        features: binary,
        geometryExtensionName: 'geoarrow.linestring',
      } as any,
    ],
  } as any;
}

export const TWO_PAIRS: OdFeature[] = [
  { source: [0, 0], target: [1, 1], flows: [10, 0, 5] },
  { source: [2, 2], target: [3, 3], flows: [0, 8, 0] },
];

/**
 * An OD tile with NO per-bucket `vertexValueMatrix` — the shape an archive
 * built without the OD value matrix has. `column` (default `'count'`) carries
 * one constant magnitude per corridor; pass `column: null` to build a tile with
 * no usable flow source at all (the "renders blank" case).
 */
export function odStaticTile(
  features: { source: [number, number]; target: [number, number] }[],
  magnitudes: number[],
  column: string | null = 'count',
  id: { z: number; x: number; y: number; t: number } = {
    z: 12,
    x: 1,
    y: 1,
    t: 0,
  },
): Tile {
  const n = features.length;
  const positions = new Float64Array(n * 2 * 2);
  const startIndices = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) {
    startIndices[i] = i * 2;
    positions[i * 4] = features[i].source[0];
    positions[i * 4 + 1] = features[i].source[1];
    positions[i * 4 + 2] = features[i].target[0];
    positions[i * 4 + 3] = features[i].target[1];
  }
  startIndices[n] = n * 2;

  const numericProps: Record<string, Float32Array> = {};
  if (column) numericProps[column] = Float32Array.from(magnitudes);

  const binary: BinaryFeatures = {
    featureCount: n,
    geometryType: 1 as any,
    positionDimensions: 2,
    positions,
    startIndices,
    featureIds: new Uint32Array(n),
    startTimes: new Float32Array(n).fill(0),
    endTimes: new Float32Array(n).fill(1000),
    timeOffset: 0,
    numericProps: numericProps as any,
    categoricalProps: {},
  };
  return {
    id: id as any,
    timeRange: { start: 0, end: 1000 } as any,
    layers: [
      {
        name: 'layer0',
        extent: 4096,
        features: binary,
        geometryExtensionName: 'geoarrow.linestring',
      } as any,
    ],
  } as any;
}

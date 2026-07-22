// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { GeometryType } from '../src/types';
import type { BinaryFeatures } from '../src/types';
import {
  deriveSourceTargetPositions,
  tessellateFeature,
} from '../src/render/geometry';

function lineBf(partial: Partial<BinaryFeatures>): BinaryFeatures {
  return {
    featureCount: 0,
    geometryType: GeometryType.LineString,
    positions: new Float64Array(0),
    featureIds: new Uint32Array(0),
    startTimes: new Float32Array(0),
    endTimes: new Float32Array(0),
    timeOffset: 0,
    numericProps: {},
    categoricalProps: {},
    ...partial,
  };
}

describe('deriveSourceTargetPositions', () => {
  it('collapses each LineString feature to its first and last vertex', () => {
    // Feature 0: (0,0)->(1,1); Feature 1: (2,2)->(3,3)->(4,4) — endpoints only.
    const binary = lineBf({
      featureCount: 2,
      positionDimensions: 2,
      positions: new Float64Array([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]),
      startIndices: new Uint32Array([0, 2, 5]),
    });
    const { source, target, dims } = deriveSourceTargetPositions(binary);
    expect(dims).toBe(2);
    expect(Array.from(source)).toEqual([0, 0, 2, 2]);
    expect(Array.from(target)).toEqual([1, 1, 4, 4]);
    expect(source).toBeInstanceOf(Float64Array);
  });

  it('degenerates a single-vertex feature to source === target', () => {
    const binary = lineBf({
      featureCount: 1,
      positionDimensions: 2,
      positions: new Float64Array([7, 8]),
      startIndices: new Uint32Array([0, 1]),
    });
    const { source, target } = deriveSourceTargetPositions(binary);
    expect(Array.from(source)).toEqual([7, 8]);
    expect(Array.from(target)).toEqual([7, 8]);
  });

  it('carries the 3rd dimension when present', () => {
    const binary = lineBf({
      featureCount: 1,
      positionDimensions: 3,
      positions: new Float64Array([0, 0, 10, 1, 1, 20]),
      startIndices: new Uint32Array([0, 2]),
    });
    const { source, target, dims } = deriveSourceTargetPositions(binary);
    expect(dims).toBe(3);
    expect(Array.from(source)).toEqual([0, 0, 10]);
    expect(Array.from(target)).toEqual([1, 1, 20]);
  });
});

function polyBf(partial: Partial<BinaryFeatures>): BinaryFeatures {
  return {
    featureCount: 0,
    geometryType: GeometryType.Polygon,
    positions: new Float64Array(0),
    featureIds: new Uint32Array(0),
    startTimes: new Float32Array(0),
    endTimes: new Float32Array(0),
    timeOffset: 0,
    numericProps: {},
    categoricalProps: {},
    ...partial,
  };
}

describe('tessellateFeature', () => {
  it('returns the pre-baked triangle slice (holes/multipolygon-correct path)', () => {
    const binary = polyBf({
      featureCount: 2,
      triangles: new Uint32Array([0, 1, 2, 0, 2, 3, 10, 11, 12]),
      triangleOffsets: new Uint32Array([0, 6, 9]),
    });
    expect(Array.from(tessellateFeature(binary, 0)!)).toEqual([
      0, 1, 2, 0, 2, 3,
    ]);
    expect(Array.from(tessellateFeature(binary, 1)!)).toEqual([10, 11, 12]);
  });

  it('earcuts a single ring when no pre-baked triangles (maplibre fallback), global-shifted', () => {
    // A unit square as feature 0. earcut yields 2 triangles (6 indices).
    const binary = polyBf({
      featureCount: 1,
      positionDimensions: 2,
      positions: new Float64Array([0, 0, 1, 0, 1, 1, 0, 1]),
      startIndices: new Uint32Array([0, 4]),
    });
    const idx = tessellateFeature(binary, 0)!;
    expect(idx.length).toBe(6);
    for (const i of idx) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(4);
    }
  });

  it('shifts fallback indices by the feature start (second feature)', () => {
    const binary = polyBf({
      featureCount: 2,
      positionDimensions: 2,
      // feature 0: triangle (3 verts); feature 1: square (4 verts) at offset 3.
      positions: new Float64Array([0, 0, 1, 0, 0, 1, 5, 5, 6, 5, 6, 6, 5, 6]),
      startIndices: new Uint32Array([0, 3, 7]),
    });
    const idx = tessellateFeature(binary, 1)!;
    for (const i of idx) {
      expect(i).toBeGreaterThanOrEqual(3);
      expect(i).toBeLessThan(7);
    }
  });

  it('prefers the fallback when preferPrebaked is false', () => {
    const binary = polyBf({
      featureCount: 1,
      positionDimensions: 2,
      positions: new Float64Array([0, 0, 1, 0, 1, 1, 0, 1]),
      startIndices: new Uint32Array([0, 4]),
      triangles: new Uint32Array([0, 1, 2]),
      triangleOffsets: new Uint32Array([0, 3]),
    });
    expect(
      tessellateFeature(binary, 0, { preferPrebaked: false })!.length,
    ).toBe(6); // earcut, not the 3-index prebaked
  });

  it('returns null for degenerate / non-polygon features', () => {
    expect(tessellateFeature(polyBf({ featureCount: 1 }), 0)).toBeNull(); // no startIndices, no triangles
    const twoVert = polyBf({
      featureCount: 1,
      positions: new Float64Array([0, 0, 1, 1]),
      startIndices: new Uint32Array([0, 2]),
    });
    expect(tessellateFeature(twoVert, 0)).toBeNull(); // < 3 verts
  });
});

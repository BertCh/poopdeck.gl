// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { GeometryType } from '../src/types';
import type { BinaryFeatures } from '../src/types';
import {
  computePolygonWallMask,
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

describe('computePolygonWallMask', () => {
  // Zoom 2, tile (1, 1): lon [-90, 0], lat [0, 66.51326044311186].
  const Z = 2;
  const TX = 1;
  const TY = 1;
  const MIN_LON = -90;
  const MAX_LON = 0;
  const MIN_LAT = 0;
  const MAX_LAT = 66.51326044311186;

  it('masks the tile-cut edge of a polygon clipped at a tile boundary', () => {
    // A box that ran on past the tile's eastern edge and was clipped there:
    // (-40,10) → (0,10) → (0,30) → (-40,30) → close. The (0,10)→(0,30) edge is
    // the synthetic cut and must grow no wall; the other three are real.
    const binary = polyBf({
      featureCount: 1,
      positionDimensions: 2,
      positions: new Float64Array([
        -40,
        10,
        MAX_LON,
        10,
        MAX_LON,
        30,
        -40,
        30,
        -40,
        10,
      ]),
      startIndices: new Uint32Array([0, 5]),
      ringIndices: new Uint32Array([0, 5]),
    });
    const mask = computePolygonWallMask(binary, { z: Z, x: TX, y: TY })!;
    //                            v0 v1 v2 v3 v4(ring close)
    expect(Array.from(mask)).toEqual([1, 0, 1, 1, 0]);
  });

  it('masks cuts on every one of the four tile boundaries', () => {
    const cases: Array<[number, number, number, number]> = [
      [MIN_LON, 10, MIN_LON, 30], // western meridian
      [MAX_LON, 10, MAX_LON, 30], // eastern meridian
      [-40, MIN_LAT, -20, MIN_LAT], // southern parallel
      [-40, MAX_LAT, -20, MAX_LAT], // northern parallel
    ];
    for (const [ax, ay, bx, by] of cases) {
      const binary = polyBf({
        featureCount: 1,
        positionDimensions: 2,
        positions: new Float64Array([ax, ay, bx, by, -45, 20, ax, ay]),
        startIndices: new Uint32Array([0, 4]),
        ringIndices: new Uint32Array([0, 4]),
      });
      const mask = computePolygonWallMask(binary, { z: Z, x: TX, y: TY })!;
      expect(mask[0]).toBe(0);
    }
  });

  it('keeps walls on real edges that merely touch a boundary at one end', () => {
    // Only ONE endpoint sits on the seam — a real edge running away from it.
    const binary = polyBf({
      featureCount: 1,
      positionDimensions: 2,
      positions: new Float64Array([MAX_LON, 10, -30, 25, -45, 5, MAX_LON, 10]),
      startIndices: new Uint32Array([0, 4]),
      ringIndices: new Uint32Array([0, 4]),
    });
    const mask = computePolygonWallMask(binary, { z: Z, x: TX, y: TY })!;
    expect(Array.from(mask)).toEqual([1, 1, 1, 0]);
  });

  it('tolerates seam vertices snapped to the coordinate-quantization grid', () => {
    // Quantized archives snap the clipper's exact seam coordinate to the
    // nearest world-anchored grid point — up to half a step off the boundary.
    const step = 0.01;
    const snapped = MAX_LON - step / 2;
    const binary = polyBf({
      featureCount: 1,
      positionDimensions: 2,
      positions: new Float64Array([-40, 10, snapped, 10, snapped, 30, -40, 10]),
      startIndices: new Uint32Array([0, 4]),
      ringIndices: new Uint32Array([0, 4]),
      coordQuantStep: [step, step],
    });
    const mask = computePolygonWallMask(binary, { z: Z, x: TX, y: TY })!;
    expect(mask[1]).toBe(0);
    // Without the declared step the same vertices read as interior geometry.
    const unquantized = polyBf({
      ...binary,
      coordQuantStep: undefined,
    });
    expect(
      computePolygonWallMask(unquantized, { z: Z, x: TX, y: TY })![1],
    ).toBe(1);
  });

  it('breaks the wall run at every ring boundary, not just each feature', () => {
    // One feature, two rings (exterior + hole). Without the ring break deck
    // stitches a wall from the exterior's last vertex to the hole's first.
    const binary = polyBf({
      featureCount: 1,
      positionDimensions: 2,
      positions: new Float64Array([
        // exterior (4 verts, closed)
        -60, 10, -20, 10, -20, 40, -60, 10,
        // hole (4 verts, closed)
        -50, 20, -30, 20, -30, 30, -50, 20,
      ]),
      startIndices: new Uint32Array([0, 8]),
      ringIndices: new Uint32Array([0, 4, 8]),
    });
    const mask = computePolygonWallMask(binary, { z: Z, x: TX, y: TY })!;
    expect(mask[3]).toBe(0); // exterior closes here — no bridge into the hole
    expect(mask[7]).toBe(0); // hole closes here
    expect(Array.from(mask)).toEqual([1, 1, 1, 0, 1, 1, 1, 0]);
  });

  it('falls back to feature-level breaks when ringIndices is absent', () => {
    const binary = polyBf({
      featureCount: 2,
      positionDimensions: 2,
      positions: new Float64Array([
        -60, 10, -50, 10, -50, 20, -60, 10, -40, 10, -30, 10, -30, 20, -40, 10,
      ]),
      startIndices: new Uint32Array([0, 4, 8]),
    });
    const mask = computePolygonWallMask(binary, { z: Z, x: TX, y: TY })!;
    expect(Array.from(mask)).toEqual([1, 1, 1, 0, 1, 1, 1, 0]);
  });

  it('wrapLastEdge: keeps the closing edge of an UNCLOSED ring', () => {
    // Wrapping builders (three's `kn = (k + 1) % ringLen`) read the final slot
    // as the edge back to the ring start. An unclosed triangle's closing edge
    // is real geometry and must still wall.
    const binary = polyBf({
      featureCount: 1,
      positionDimensions: 2,
      positions: new Float64Array([-60, 10, -20, 10, -20, 40]),
      startIndices: new Uint32Array([0, 3]),
      ringIndices: new Uint32Array([0, 3]),
    });
    const at = { z: Z, x: TX, y: TY };
    expect(
      Array.from(computePolygonWallMask(binary, at, { wrapLastEdge: true })!),
    ).toEqual([1, 1, 1]);
    // The linear (deck) convention has no edge leaving the last vertex.
    expect(Array.from(computePolygonWallMask(binary, at)!)).toEqual([1, 1, 0]);
  });

  it('wrapLastEdge: still drops a CLOSED ring’s degenerate closing edge', () => {
    const binary = polyBf({
      featureCount: 1,
      positionDimensions: 2,
      positions: new Float64Array([-60, 10, -20, 10, -20, 40, -60, 10]),
      startIndices: new Uint32Array([0, 4]),
      ringIndices: new Uint32Array([0, 4]),
    });
    const mask = computePolygonWallMask(
      binary,
      { z: Z, x: TX, y: TY },
      { wrapLastEdge: true },
    )!;
    expect(Array.from(mask)).toEqual([1, 1, 1, 0]);
  });

  it('wrapLastEdge: masks a closing edge that is itself a tile cut', () => {
    // Unclosed ring whose LAST → FIRST edge runs along the eastern boundary.
    const binary = polyBf({
      featureCount: 1,
      positionDimensions: 2,
      positions: new Float64Array([MAX_LON, 10, -30, 25, MAX_LON, 30]),
      startIndices: new Uint32Array([0, 3]),
      ringIndices: new Uint32Array([0, 3]),
    });
    const mask = computePolygonWallMask(
      binary,
      { z: Z, x: TX, y: TY },
      { wrapLastEdge: true },
    )!;
    expect(Array.from(mask)).toEqual([1, 1, 0]);
  });

  it('returns null for non-polygon or geometry-less tiles', () => {
    expect(
      computePolygonWallMask(lineBf({ featureCount: 1 }), { z: 0, x: 0, y: 0 }),
    ).toBeNull();
    expect(
      computePolygonWallMask(polyBf({ featureCount: 1 }), { z: 0, x: 0, y: 0 }),
    ).toBeNull(); // no startIndices
  });
});

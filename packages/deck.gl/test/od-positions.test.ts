/**
 * Unit tests for the shared OD source/target endpoint derivation.
 *
 * The OD flow layers (AnimatedArcLayer, AnimatedLineLayer) render deck.gl's
 * instanced ArcLayer / LineLayer, which want one source position and one target
 * position per feature. STT tiles store flows as LineString features (a run of
 * vertices addressed by startIndices), so `deriveSourceTargetPositions` walks
 * those once and collapses each feature to its FIRST (source) and LAST (target)
 * vertex. These tests pin that collapse for the common 2-vertex case, the
 * multi-vertex polyline (endpoints only), 3D positions, and the degenerate
 * single-vertex feature.
 */

import { describe, it, expect } from 'vitest';
import { deriveSourceTargetPositions } from '../src/lib/od-positions';
import { makePathTile } from './fake-tile';

describe('deriveSourceTargetPositions', () => {
  it('collapses 2-vertex features to source = vertex 0, target = vertex 1', () => {
    const tile = makePathTile({
      paths: [
        [
          [0, 0],
          [10, 20],
        ],
        [
          [-5, -5],
          [30, 40],
        ],
      ],
      startTimes: [0, 0],
      endTimes: [1000, 1000],
      timeOffset: 0,
    });
    const binary = tile.layers[0].features;
    const { source, target, dims } = deriveSourceTargetPositions(binary);

    expect(dims).toBe(2);
    expect(source.length).toBe(2 * 2);
    expect(target.length).toBe(2 * 2);

    // Feature 0: source = first vertex, target = last vertex.
    expect(source[0]).toBe(0);
    expect(source[1]).toBe(0);
    expect(target[0]).toBe(10);
    expect(target[1]).toBe(20);
    // Feature 1.
    expect(source[2]).toBe(-5);
    expect(source[3]).toBe(-5);
    expect(target[2]).toBe(30);
    expect(target[3]).toBe(40);
  });

  it('returns dense Float64Arrays (fp64 position split needs the low half)', () => {
    const tile = makePathTile({
      paths: [
        [
          [1, 2],
          [3, 4],
        ],
      ],
      startTimes: [0],
      endTimes: [1],
      timeOffset: 0,
    });
    const { source, target } = deriveSourceTargetPositions(tile.layers[0].features);
    expect(source).toBeInstanceOf(Float64Array);
    expect(target).toBeInstanceOf(Float64Array);
  });

  it('collapses a multi-vertex polyline to its two endpoints (drops the middle)', () => {
    const tile = makePathTile({
      paths: [
        [
          [0, 0],
          [1, 1],
          [2, 2],
          [9, 9],
        ],
      ],
      startTimes: [0],
      endTimes: [1],
      timeOffset: 0,
    });
    const { source, target } = deriveSourceTargetPositions(tile.layers[0].features);
    // Source is the FIRST vertex, target the LAST — the [1,1] and [2,2]
    // intermediate vertices are dropped (an arc/line has only two ends).
    expect([source[0], source[1]]).toEqual([0, 0]);
    expect([target[0], target[1]]).toEqual([9, 9]);
  });

  it('handles features of differing vertex counts via startIndices', () => {
    // Feature 0: 2 vertices; feature 1: 3 vertices. The per-feature source/
    // target offsets must come from startIndices, not a fixed stride.
    const tile = makePathTile({
      paths: [
        [
          [0, 0],
          [1, 1],
        ],
        [
          [10, 10],
          [11, 11],
          [12, 12],
        ],
      ],
      startTimes: [0, 0],
      endTimes: [1, 1],
      timeOffset: 0,
    });
    const { source, target } = deriveSourceTargetPositions(tile.layers[0].features);
    expect([source[0], source[1]]).toEqual([0, 0]);
    expect([target[0], target[1]]).toEqual([1, 1]);
    expect([source[2], source[3]]).toEqual([10, 10]);
    expect([target[2], target[3]]).toEqual([12, 12]);
  });

  it('preserves the altitude channel for 3D positions (dims=3)', () => {
    // makePathTile only builds 2D tiles, so assemble a 3D BinaryFeatures by
    // hand: 1 feature, 2 vertices, [lon, lat, alt] interleaved.
    const positions = new Float64Array([
      0, 0, 100, // source vertex
      5, 6, 200, // target vertex
    ]);
    const binary: any = {
      featureCount: 1,
      geometryType: 1,
      positionDimensions: 3,
      positions,
      startIndices: new Uint32Array([0, 2]),
      featureIds: new Uint32Array(1),
      startTimes: new Float32Array([0]),
      endTimes: new Float32Array([1]),
      timeOffset: 0,
      numericProps: {},
      categoricalProps: {},
    };
    const { source, target, dims } = deriveSourceTargetPositions(binary);
    expect(dims).toBe(3);
    expect([source[0], source[1], source[2]]).toEqual([0, 0, 100]);
    expect([target[0], target[1], target[2]]).toEqual([5, 6, 200]);
  });

  it('degenerates a single-vertex feature to source === target', () => {
    const positions = new Float64Array([7, 8]);
    const binary: any = {
      featureCount: 1,
      geometryType: 1,
      positionDimensions: 2,
      positions,
      startIndices: new Uint32Array([0, 1]),
      featureIds: new Uint32Array(1),
      startTimes: new Float32Array([0]),
      endTimes: new Float32Array([1]),
      timeOffset: 0,
      numericProps: {},
      categoricalProps: {},
    };
    const { source, target } = deriveSourceTargetPositions(binary);
    expect([source[0], source[1]]).toEqual([7, 8]);
    expect([target[0], target[1]]).toEqual([7, 8]);
  });
});

import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import {
  buildOdLineSegmentBuffers,
  deriveSourceTargetPositions,
} from '../src/lib/od-positions';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { MercatorProjection } from '../src/projection/mercator';

const anchor = { longitude: -71.05, latitude: 42.35 };

function odTile(partial: Partial<BinaryFeatures>, timeOffset = 0): Tile {
  const features: BinaryFeatures = {
    featureCount: 1,
    geometryType: GeometryType.LineString,
    positionDimensions: 2,
    positions: new Float64Array(0),
    featureIds: new Uint32Array(1),
    startTimes: new Float32Array(1),
    endTimes: new Float32Array(1),
    startIndices: new Uint32Array([0, 0]),
    timeOffset,
    numericProps: {},
    categoricalProps: {},
    vectorProps: {},
    ...partial,
  };
  return {
    id: { z: 12, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [{ name: 'od', extent: 0, features, geometryExtensionName: 'geoarrow.linestring' }],
  };
}

describe('deriveSourceTargetPositions', () => {
  it('collapses each feature to first (source) / last (target) vertex', () => {
    const tile = odTile({
      featureCount: 2,
      positions: new Float64Array([
        // feature 0: 3 vertices
        0, 0, 1, 1, 2, 2,
        // feature 1: 2 vertices
        10, 10, 20, 20,
      ]),
      startIndices: new Uint32Array([0, 3, 5]),
      startTimes: new Float32Array(2),
      endTimes: new Float32Array(2),
    });
    const { source, target, dims } = deriveSourceTargetPositions(tile.layers[0].features);
    expect(dims).toBe(2);
    // feature 0 source = vertex 0, target = vertex 2.
    expect(Array.from(source.slice(0, 2))).toEqual([0, 0]);
    expect(Array.from(target.slice(0, 2))).toEqual([2, 2]);
    // feature 1 source = (10,10), target = (20,20).
    expect(Array.from(source.slice(2, 4))).toEqual([10, 10]);
    expect(Array.from(target.slice(2, 4))).toEqual([20, 20]);
  });
});

describe('buildOdLineSegmentBuffers', () => {
  const proj = new LocalEnuProjection(anchor);

  it('emits ONE segment per feature (source→target), dropping mid vertices', () => {
    // A 3-vertex polyline OD pair: only endpoints survive.
    const dLon = 0.001;
    const tile = odTile(
      {
        positions: new Float64Array([
          anchor.longitude, anchor.latitude,
          anchor.longitude + dLon, anchor.latitude, // mid vertex (dropped)
          anchor.longitude + 2 * dLon, anchor.latitude,
        ]),
        startIndices: new Uint32Array([0, 3]),
        startTimes: new Float32Array([100]),
        endTimes: new Float32Array([200]),
      },
      500,
    );

    const buf = buildOdLineSegmentBuffers([tile], proj, 200, {
      colorMode: { type: 'constant', color: [255, 0, 0, 255] },
    });

    // One feature → one OD segment (not two, as a per-segment builder would yield).
    expect(buf.count).toBe(1);
    // origin = source vertex projected (≈ anchor → ~0).
    expect(buf.origin[0]).toBeCloseTo(0, 4);
    // Source A at origin (~0); target B is two dLon east (the LAST vertex).
    expect(buf.posA[0]).toBeCloseTo(0, 4);
    expect(buf.posB[0]).toBeGreaterThan(0);
    // Times rebased by (timeOffset 500 − timeOrigin 200) = +300.
    expect(buf.starts[0]).toBe(400);
    expect(buf.ends[0]).toBe(500);
    // Constant colour on both endpoints.
    expect(buf.colorA[0]).toBeCloseTo(1, 6);
    expect(buf.colorB[3]).toBeCloseTo(1, 6);
  });

  it('emits one segment per feature across many OD pairs', () => {
    const tile = odTile({
      featureCount: 3,
      positions: new Float64Array([
        anchor.longitude, anchor.latitude, anchor.longitude + 0.001, anchor.latitude,
        anchor.longitude, anchor.latitude, anchor.longitude, anchor.latitude + 0.001,
        anchor.longitude, anchor.latitude, anchor.longitude + 0.002, anchor.latitude + 0.002,
      ]),
      startIndices: new Uint32Array([0, 2, 4, 6]),
      startTimes: new Float32Array([0, 0, 0]),
      endTimes: new Float32Array([0, 0, 0]),
    });
    const buf = buildOdLineSegmentBuffers([tile], proj, 0, {
      colorMode: { type: 'constant', color: [0, 0, 255, 255] },
    });
    expect(buf.count).toBe(3);
  });

  it('keeps RTC offsets tiny under mercator while origin carries the magnitude', () => {
    const merc = new MercatorProjection();
    const tile = odTile({
      positions: new Float64Array([
        anchor.longitude, anchor.latitude,
        anchor.longitude + 0.001, anchor.latitude + 0.001,
      ]),
      startIndices: new Uint32Array([0, 2]),
    });
    const buf = buildOdLineSegmentBuffers([tile], merc, 0, {
      colorMode: { type: 'constant', color: [10, 20, 30, 255] },
    });
    expect(buf.count).toBe(1);
    expect(Math.abs(buf.origin[0])).toBeGreaterThan(1e6); // huge absolute mercator x
    expect(Math.abs(buf.posA[0])).toBeLessThan(1); // source A is the origin → ~0
    expect(Math.abs(buf.posB[0])).toBeLessThan(500); // target B within a few hundred metres
  });

  it('colors per-feature from a ramp column', () => {
    const tile = odTile({
      featureCount: 2,
      positions: new Float64Array([
        anchor.longitude, anchor.latitude, anchor.longitude + 0.001, anchor.latitude,
        anchor.longitude, anchor.latitude, anchor.longitude + 0.001, anchor.latitude,
      ]),
      startIndices: new Uint32Array([0, 2, 4]),
      startTimes: new Float32Array([0, 0]),
      endTimes: new Float32Array([0, 0]),
      numericProps: { flow: new Float32Array([0, 100]) },
    });
    const buf = buildOdLineSegmentBuffers([tile], proj, 0, {
      colorMode: {
        type: 'ramp',
        property: 'flow',
        domain: [0, 100],
        range: [
          [0, 0, 0, 255],
          [255, 255, 255, 255],
        ],
        fallback: [0, 0, 0, 255],
      },
    });
    expect(buf.count).toBe(2);
    // feature 0 (flow 0) → black; feature 1 (flow 100) → white.
    expect(buf.colorA[0]).toBeCloseTo(0, 5);
    expect(buf.colorA[4]).toBeCloseTo(1, 5);
  });

  it('returns empty for a tile with no line features', () => {
    const tile = odTile({ featureCount: 0, startIndices: new Uint32Array([0]) });
    const buf = buildOdLineSegmentBuffers([tile], proj, 0, {
      colorMode: { type: 'constant', color: [0, 0, 0, 255] },
    });
    expect(buf.count).toBe(0);
    expect(buf.bbox).toBeNull();
  });
});

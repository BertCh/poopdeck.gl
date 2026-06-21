import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { buildPointBuffers } from '../src/layers/point-buffers';
import { LocalEnuProjection } from '../src/projection/local-enu';
import type { RGBA } from '../src/lib/color';

const anchor = { longitude: -71.05, latitude: 42.35 };
const proj = new LocalEnuProjection(anchor);

function pointTile(
  count: number,
  positions: number[],
  partial: Partial<BinaryFeatures>,
  timeOffset = 0,
  geometryType = GeometryType.Point,
): Tile {
  const features: BinaryFeatures = {
    featureCount: count,
    geometryType,
    positionDimensions: 2,
    positions: new Float64Array(positions),
    featureIds: new Uint32Array(count),
    startTimes: new Float32Array(count),
    endTimes: new Float32Array(count),
    timeOffset,
    numericProps: {},
    categoricalProps: {},
    vectorProps: {},
    ...partial,
  };
  return {
    id: { z: 18, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [{ name: 'lidar', extent: 0, features, geometryExtensionName: 'geoarrow.point' }],
  };
}

const SEG: Record<string, RGBA> = {
  road: [80, 90, 120, 255],
  vehicle: [255, 158, 0, 255],
};

describe('buildPointBuffers', () => {
  it('projects centres, expands categorical colour, rebases times', () => {
    const tile = pointTile(
      2,
      [anchor.longitude, anchor.latitude, anchor.longitude, anchor.latitude],
      {
        categoricalProps: {
          seg_class: { indices: new Uint16Array([0, 1]), categories: ['road', 'vehicle'] },
        },
        numericProps: { z: new Float32Array([1, 2]) },
        startTimes: new Float32Array([10, 20]),
        endTimes: new Float32Array([15, 25]),
      },
      3000,
    );
    const buf = buildPointBuffers([tile], proj, 1000, {
      colorMode: { type: 'categorical', property: 'seg_class', mapping: SEG, fallback: [0, 0, 0, 0] },
      elevationProperty: 'z',
      elevationScale: 1,
    });
    expect(buf.count).toBe(2);
    expect(buf.centers[0]).toBeCloseTo(0, 5);
    expect(buf.centers[2]).toBe(1); // z elevation
    expect(buf.colors[0]).toBeCloseTo(80 / 255, 6); // road
    expect(buf.colors[4]).toBeCloseTo(255 / 255, 6); // vehicle r
    expect(buf.starts[0]).toBe(10 + (3000 - 1000)); // rebased +2000
    expect(buf.ends[1]).toBe(25 + 2000);
  });

  it('colours from rgb columns when requested', () => {
    const tile = pointTile(
      1,
      [anchor.longitude, anchor.latitude],
      { numericProps: { r: new Float32Array([255]), g: new Float32Array([0]), b: new Float32Array([0]), z: new Float32Array([0]) } },
    );
    const buf = buildPointBuffers([tile], proj, 0, {
      colorMode: { type: 'rgb', columns: ['r', 'g', 'b'] },
      elevationProperty: 'z',
      elevationScale: 1,
    });
    expect(buf.colors[0]).toBeCloseTo(1, 6);
    expect(buf.colors[1]).toBe(0);
  });

  it('skips non-point geometry layers', () => {
    const tile = pointTile(
      1,
      [anchor.longitude, anchor.latitude],
      {},
      0,
      GeometryType.LineString,
    );
    const buf = buildPointBuffers([tile], proj, 0, {
      colorMode: { type: 'categorical', property: 'x', mapping: {}, fallback: [0, 0, 0, 0] },
      elevationProperty: 'z',
      elevationScale: 1,
    });
    expect(buf.count).toBe(0);
  });
});

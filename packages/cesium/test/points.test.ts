// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import { buildPointEntries, collectPointLayers } from '../src/lib/points';

const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, { datum: 'wgs84' });

function pointFeatures(
  positions: number[],
  startTimes: number[],
  endTimes: number[],
  partial: Partial<BinaryFeatures> = {},
  timeOffset = 0,
): BinaryFeatures {
  const featureCount = startTimes.length;
  return {
    featureCount,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions: new Float64Array(positions),
    featureIds: new Uint32Array(featureCount),
    startTimes: new Float32Array(startTimes),
    endTimes: new Float32Array(endTimes),
    timeOffset,
    numericProps: {},
    categoricalProps: {},
    vectorProps: {},
    ...partial,
  };
}

function pointTile(
  positions: number[],
  startTimes: number[],
  endTimes: number[],
  partial: Partial<BinaryFeatures> = {},
  timeOffset = 0,
): Tile {
  const features = pointFeatures(positions, startTimes, endTimes, partial, timeOffset);
  return {
    id: { z: 5, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [{ name: 'points', extent: 0, features, geometryExtensionName: 'geoarrow.point' }],
  };
}

describe('collectPointLayers', () => {
  it('keeps only non-empty Point layers, in tile/layer order', () => {
    const empty = pointFeatures([], [], []); // featureCount 0 → dropped
    const linePoints = pointFeatures([1, 1], [0], [1], { geometryType: GeometryType.LineString }); // wrong type → dropped
    const a = pointFeatures([0, 0], [0], [1]);
    const b = pointFeatures([1, 1, 2, 2], [0, 0], [1, 1]);
    const tile: Tile = {
      id: { z: 5, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      layers: [
        { name: 'e', extent: 0, features: empty, geometryExtensionName: 'geoarrow.point' },
        { name: 'l', extent: 0, features: linePoints, geometryExtensionName: 'geoarrow.linestring' },
        { name: 'a', extent: 0, features: a, geometryExtensionName: 'geoarrow.point' },
        { name: 'b', extent: 0, features: b, geometryExtensionName: 'geoarrow.point' },
      ],
    };
    const collected = collectPointLayers([tile]);
    expect(collected).toEqual([a, b]);
  });
});

describe('buildPointEntries', () => {
  it('projects each feature to WGS84 ECEF and carries lon/lat + provenance', () => {
    const tile = pointTile([10, 20, 30, 40], [5, 6], [900, 901]);
    const build = buildPointEntries([tile]);
    expect(build.points).toHaveLength(2);

    const p0 = build.points[0];
    const e0 = GLOBE.project(10, 20, 0);
    expect(p0.x).toBeCloseTo(e0[0], 6);
    expect(p0.y).toBeCloseTo(e0[1], 6);
    expect(p0.z).toBeCloseTo(e0[2], 6);
    expect(p0.lon).toBe(10);
    expect(p0.lat).toBe(20);
    expect(p0.start).toBe(5);
    expect(p0.end).toBe(900);
    expect(p0.binary).toBe(tile.layers[0].features);
    expect(p0.featureIndex).toBe(0);

    const p1 = build.points[1];
    const e1 = GLOBE.project(30, 40, 0);
    expect(p1.x).toBeCloseTo(e1[0], 6);
    expect(p1.featureIndex).toBe(1);
    expect(build.timeOrigin).toBe(0);
  });

  it('returns an empty build (timeOrigin 0) when there are no Point features', () => {
    const line = pointTile([0, 0, 1, 1], [0], [1], { geometryType: GeometryType.LineString });
    const build = buildPointEntries([line]);
    expect(build.points).toEqual([]);
    expect(build.timeOrigin).toBe(0);
  });

  it('applies the default grey colour, pre-normalized to 0..1', () => {
    const build = buildPointEntries([pointTile([0, 0], [0], [1])]);
    const p = build.points[0];
    expect(p.r).toBeCloseTo(200 / 255, 6);
    expect(p.g).toBeCloseTo(205 / 255, 6);
    expect(p.b).toBeCloseTo(215 / 255, 6);
    expect(p.a).toBe(1); // 255/255
  });

  it('honours a custom colorMappingDefault including its alpha channel', () => {
    const build = buildPointEntries([pointTile([0, 0], [0], [1])], {
      colorMappingDefault: [10, 20, 30, 40],
    });
    const p = build.points[0];
    expect(p.r).toBeCloseTo(10 / 255, 6);
    expect(p.g).toBeCloseTo(20 / 255, 6);
    expect(p.b).toBeCloseTo(30 / 255, 6);
    expect(p.a).toBeCloseTo(40 / 255, 6);
  });

  it('honours 3-D geometry z (altitude shifts the projection)', () => {
    const tile = pointTile([0, 0, 500], [0], [1], {
      positionDimensions: 3,
      positions: new Float64Array([0, 0, 500]),
    });
    const build = buildPointEntries([tile]);
    const expected = GLOBE.project(0, 0, 500);
    expect(build.points[0].x).toBeCloseTo(expected[0], 6);
    // At (0,0) the +X axis carries the altitude: 500 m above the equatorial radius.
    expect(build.points[0].x).toBeCloseTo(GLOBE.project(0, 0, 0)[0] + 500, 6);
  });

  it('rebases later layers onto the first layer timeOrigin', () => {
    const t0 = pointTile([0, 0], [0], [100], {}, 5000);
    const t1 = pointTile([1, 1], [0], [100], {}, 8000);
    const build = buildPointEntries([t0, t1]);
    expect(build.timeOrigin).toBe(5000);
    expect(build.points[0].start).toBe(0);
    expect(build.points[1].start).toBe(3000); // 0 + (8000 - 5000)
    expect(build.points[1].end).toBe(3100);
  });

  it('resolves categorical colours through the kernel, normalized to 0..1', () => {
    const tile = pointTile([0, 0, 1, 1], [0, 0], [1, 1], {
      categoricalProps: {
        kind: { indices: new Uint16Array([0, 1]), categories: ['a', 'b'] },
      },
    });
    const build = buildPointEntries([tile], {
      colorProperty: 'kind',
      colorMapping: { a: [255, 0, 0, 255], b: [0, 255, 0, 255] },
    });
    const p0 = build.points[0];
    expect(p0.r).toBe(1);
    expect(p0.g).toBe(0);
    expect(p0.b).toBe(0);
    expect(p0.a).toBe(1);
    const p1 = build.points[1];
    expect(p1.r).toBe(0);
    expect(p1.g).toBe(1);
    expect(p1.b).toBe(0);
  });

  it('fills the colorMappingDefault when the categorical property is absent (onMissing fill)', () => {
    const tile = pointTile([0, 0], [0], [1]); // no categoricalProps.kind
    const build = buildPointEntries([tile], {
      colorProperty: 'kind',
      colorMapping: { a: [255, 0, 0, 255] },
      colorMappingDefault: [12, 24, 36, 48],
    });
    const p = build.points[0];
    expect(p.r).toBeCloseTo(12 / 255, 6);
    expect(p.g).toBeCloseTo(24 / 255, 6);
    expect(p.b).toBeCloseTo(36 / 255, 6);
    expect(p.a).toBeCloseTo(48 / 255, 6);
  });
});

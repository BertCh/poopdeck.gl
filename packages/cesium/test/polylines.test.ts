// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import {
  buildPathPolylines,
  buildArcPolylines,
  sampleGreatCircleArc,
} from '../src/lib/polylines';
import { featureColor } from '../src/lib/feature-color';

const WGS84_A = 6_378_137; // semi-major axis, metres
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, { datum: 'wgs84' });

function lineTile(
  positions: number[],
  startIndices: number[],
  startTimes: number[],
  endTimes: number[],
  partial: Partial<BinaryFeatures> = {},
  timeOffset = 0,
): Tile {
  const featureCount = startIndices.length - 1;
  const features: BinaryFeatures = {
    featureCount,
    geometryType: GeometryType.LineString,
    positionDimensions: 2,
    positions: new Float64Array(positions),
    startIndices: new Uint32Array(startIndices),
    featureIds: new Uint32Array(featureCount),
    startTimes: new Float32Array(startTimes),
    endTimes: new Float32Array(endTimes),
    timeOffset,
    numericProps: {},
    categoricalProps: {},
    vectorProps: {},
    ...partial,
  };
  return {
    id: { z: 5, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [{ name: 'lines', extent: 0, features, geometryExtensionName: 'geoarrow.linestring' }],
  };
}

describe('buildPathPolylines', () => {
  it('projects every vertex to WGS84 ECEF and keeps the run intact', () => {
    const build = buildPathPolylines([lineTile([0, 0, 1, 0, 2, 0], [0, 3], [10], [900])]);
    expect(build.polylines).toHaveLength(1);
    const p = build.polylines[0];
    expect(p.positions).toHaveLength(9);
    const expected = GLOBE.project(1, 0, 0);
    expect(p.positions[3]).toBeCloseTo(expected[0], 6);
    expect(p.positions[4]).toBeCloseTo(expected[1], 6);
    expect(p.positions[5]).toBeCloseTo(expected[2], 6);
    expect(p.start).toBe(10);
    expect(p.end).toBe(900);
    expect(p.featureIndex).toBe(0);
  });

  it('skips single-vertex features (a polyline needs two ends)', () => {
    const build = buildPathPolylines([lineTile([0, 0, 1, 0, 2, 0, 3, 0], [0, 1, 4], [1, 2], [3, 4])]);
    expect(build.polylines).toHaveLength(1);
    expect(build.polylines[0].featureIndex).toBe(1);
  });

  it('rebases later tiles onto the first layer timeOrigin', () => {
    const t0 = lineTile([0, 0, 1, 0], [0, 2], [0], [100], {}, 5000);
    const t1 = lineTile([2, 0, 3, 0], [0, 2], [0], [100], {}, 8000);
    const build = buildPathPolylines([t0, t1]);
    expect(build.timeOrigin).toBe(5000);
    expect(build.polylines[1].start).toBe(3000);
    expect(build.polylines[1].end).toBe(3100);
  });

  it('honours 3-D geometry z plus zLift', () => {
    const tile = lineTile([0, 0, 500, 1, 0, 500], [0, 2], [0], [1], {
      positionDimensions: 3,
      positions: new Float64Array([0, 0, 500, 1, 0, 500]),
    });
    const build = buildPathPolylines([tile], { zLift: 100 });
    const expected = GLOBE.project(0, 0, 600);
    expect(build.polylines[0].positions[0]).toBeCloseTo(expected[0], 6);
  });

  it('resolves categorical colours through the kernel', () => {
    const tile = lineTile([0, 0, 1, 0, 2, 0, 3, 0], [0, 2, 4], [0, 0], [1, 1], {
      categoricalProps: {
        kind: { indices: new Uint16Array([0, 1]), categories: ['a', 'b'] },
      },
    });
    const build = buildPathPolylines([tile], {
      color: {
        type: 'categorical',
        property: 'kind',
        colorMapping: { a: [255, 0, 0, 255], b: [0, 255, 0, 255] },
        fallback: [9, 9, 9, 255],
      },
    });
    expect(build.polylines[0].color).toEqual([255, 0, 0, 255]);
    expect(build.polylines[1].color).toEqual([0, 255, 0, 255]);
  });
});

describe('sampleGreatCircleArc', () => {
  const src = GLOBE.project(0, 0, 0);
  const tgt = GLOBE.project(90, 0, 0);

  it('starts and ends exactly at the endpoints', () => {
    const arc = sampleGreatCircleArc(src, tgt, 1, 17);
    expect(arc[0]).toBeCloseTo(src[0], 6);
    expect(arc[1]).toBeCloseTo(src[1], 6);
    expect(arc[2]).toBeCloseTo(src[2], 6);
    expect(arc[48]).toBeCloseTo(tgt[0], 6);
    expect(arc[49]).toBeCloseTo(tgt[1], 6);
    expect(arc[50]).toBeCloseTo(tgt[2], 6);
  });

  it('lifts the midpoint radially by height × chord (parabola apex)', () => {
    const arc = sampleGreatCircleArc(src, tgt, 1, 17);
    const mid = 8 * 3; // t = 0.5
    const midRadius = Math.hypot(arc[mid], arc[mid + 1], arc[mid + 2]);
    const chord = Math.hypot(tgt[0] - src[0], tgt[1] - src[1], tgt[2] - src[2]);
    // radius(0.5) ≈ WGS84 equatorial radius; lift = 1 · chord · 4·0.5·0.5 = chord.
    expect(midRadius).toBeCloseTo(WGS84_A + chord, 0);
  });

  it('height 0 hugs the great circle (equatorial midpoint stays at the radius)', () => {
    const arc = sampleGreatCircleArc(src, tgt, 0, 17);
    const mid = 8 * 3;
    const midRadius = Math.hypot(arc[mid], arc[mid + 1], arc[mid + 2]);
    expect(midRadius).toBeCloseTo(WGS84_A, 0);
  });

  it('midpoint lies on the great circle between the endpoints (slerp, not chord lerp)', () => {
    const arc = sampleGreatCircleArc(src, tgt, 0, 3);
    // Equator 0°→90°E midpoint is at 45°E on the surface.
    const expected = GLOBE.project(45, 0, 0);
    expect(arc[3]).toBeCloseTo(expected[0], 0);
    expect(arc[4]).toBeCloseTo(expected[1], 0);
    expect(arc[5]).toBeCloseTo(expected[2], 0);
  });

  it('degenerate zero-length arcs fall back without NaNs', () => {
    const arc = sampleGreatCircleArc(src, src, 1, 5);
    for (let i = 0; i < arc.length; i++) expect(Number.isFinite(arc[i])).toBe(true);
  });
});

describe('buildArcPolylines', () => {
  it('collapses each feature to its first/last vertex and sweeps the arc', () => {
    // 3-vertex feature: the middle vertex must NOT influence the arc endpoints.
    const build = buildArcPolylines([lineTile([0, 0, 33, 40, 90, 0], [0, 3], [5], [50])], { samples: 9 });
    expect(build.polylines).toHaveLength(1);
    const p = build.polylines[0];
    expect(p.positions).toHaveLength(27);
    const src = GLOBE.project(0, 0, 0);
    const tgt = GLOBE.project(90, 0, 0);
    expect(p.positions[0]).toBeCloseTo(src[0], 6);
    expect(p.positions[24]).toBeCloseTo(tgt[0], 6);
    expect(p.start).toBe(5);
    expect(p.end).toBe(50);
  });

  it('keeps picking provenance on every arc', () => {
    const tile = lineTile([0, 0, 1, 1, 2, 2, 3, 3], [0, 2, 4], [0, 0], [1, 1]);
    const build = buildArcPolylines([tile]);
    expect(build.polylines[0].binary).toBe(tile.layers[0].features);
    expect(build.polylines[1].featureIndex).toBe(1);
  });
});

describe('featureColor', () => {
  const tile = lineTile([0, 0, 1, 0], [0, 2], [0], [1], {
    numericProps: { speed: new Float64Array([5]) },
  });
  const b = tile.layers[0].features;

  it('constant mode returns the constant', () => {
    expect(featureColor(b, 0, { type: 'constant', color: [1, 2, 3, 4] })).toEqual([1, 2, 3, 4]);
  });

  it('ramp mode interpolates through the kernel rampColorAt', () => {
    const c = featureColor(b, 0, {
      type: 'ramp',
      property: 'speed',
      domain: [0, 10],
      range: [
        [0, 0, 0, 255],
        [100, 100, 100, 255],
      ],
      fallback: [9, 9, 9, 255],
    });
    expect(c[0]).toBeCloseTo(50, 5);
  });

  it('ramp mode falls back when the property is absent', () => {
    const c = featureColor(b, 0, {
      type: 'ramp',
      property: 'nope',
      domain: [0, 10],
      range: [[0, 0, 0, 255]],
      fallback: [9, 9, 9, 255],
    });
    expect(c).toEqual([9, 9, 9, 255]);
  });
});

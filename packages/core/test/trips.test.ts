// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { GeometryType } from '../src/types';
import type { BinaryFeatures, Tile } from '../src/types';
import {
  buildTripIndex,
  sampleHead,
  trimTrail,
  synthesizeVertexTimes,
} from '../src/render/trips';
import { LocalEnuProjection, GlobeProjection } from '../src/geo';

// The lift-origin behavior (f32 index, head sampling, vertex-time synthesis)
// stays covered by packages/three/test/trip-heads.test.ts + trips-buffers.test.ts
// through the re-export shims. This file covers what the lift ADDED for the
// Cesium consumer: 'f64' precision and the trail trim.

const anchor = { longitude: -71.05, latitude: 42.35 };
const proj = new LocalEnuProjection(anchor);

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
    id: { z: 14, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: 'trips',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.linestring',
      },
    ],
  };
}

// A two-vertex trip 100 m due east of the anchor, active over t∈[0,1000].
function eastwardTrip(timeOffset = 0): Tile {
  const dLon = 100 / (111_320 * Math.cos((anchor.latitude * Math.PI) / 180));
  return lineTile(
    [
      anchor.longitude,
      anchor.latitude,
      anchor.longitude + dLon,
      anchor.latitude,
    ],
    [0, 2],
    [0],
    [1000],
    {},
    timeOffset,
  );
}

describe('buildTripIndex precision option', () => {
  it('defaults to f32 arrays (the three GPU-buffer contract)', () => {
    const trip = buildTripIndex([eastwardTrip()], proj, 0).trips[0];
    expect(trip.positions).toBeInstanceOf(Float32Array);
    expect(trip.vertexTimes).toBeInstanceOf(Float32Array);
  });

  it("emits f64 arrays under precision:'f64'", () => {
    const trip = buildTripIndex([eastwardTrip()], proj, 0, { precision: 'f64' })
      .trips[0];
    expect(trip.positions).toBeInstanceOf(Float64Array);
    expect(trip.vertexTimes).toBeInstanceOf(Float64Array);
  });

  it('f64 index preserves sub-metre offsets far from the RTC origin (WGS84 ECEF)', () => {
    // Two trips: one at the origin, one ~90° of longitude away — the second's
    // RTC offset is ~9e6 m, where f32 (24-bit mantissa) quantizes to ~0.5 m.
    const globe = new GlobeProjection(
      { longitude: 0, latitude: 0 },
      undefined,
      { datum: 'wgs84' },
    );
    const far = lineTile([90, 0, 90.001, 0], [0, 2], [0], [1000]);
    const near = lineTile([0, 0, 0.001, 0], [0, 2], [0], [1000]);
    const f64 = buildTripIndex([near, far], globe, 0, { precision: 'f64' });
    const f32 = buildTripIndex([near, far], globe, 0);

    const [ox, oy, oz] = f64.origin;
    const exact = globe.project(90, 0, 0);
    const t64 = f64.trips[1];
    // f64 keeps the exact projected value; f32 shows quantization at this magnitude.
    expect(t64.positions[0]).toBeCloseTo(exact[0] - ox, 6);
    expect(t64.positions[1]).toBeCloseTo(exact[1] - oy, 6);
    expect(t64.positions[2]).toBeCloseTo(exact[2] - oz, 6);
    const f32err = Math.abs(f32.trips[1].positions[1] - (exact[1] - oy));
    const f64err = Math.abs(t64.positions[1] - (exact[1] - oy));
    expect(f64err).toBeLessThan(f32err + 1e-9);
  });

  it('records picking provenance (binary + featureIndex) on every trip', () => {
    const tile = lineTile(
      [0, 0, 1, 0, 2, 0, 3, 0],
      [0, 2, 4],
      [0, 100],
      [1000, 1100],
    );
    const index = buildTripIndex([tile], proj, 0);
    expect(index.trips).toHaveLength(2);
    expect(index.trips[0].binary).toBe(tile.layers[0].features);
    expect(index.trips[0].featureIndex).toBe(0);
    expect(index.trips[1].featureIndex).toBe(1);
  });
});

describe('trimTrail', () => {
  // A 3-vertex trip: 0m → 100m → 200m east, vertex times 0 / 500 / 1000
  // (uniform spacing → distance-synthesized times land exactly there).
  function threeVertexTrip(): Tile {
    const dLon = 100 / (111_320 * Math.cos((anchor.latitude * Math.PI) / 180));
    return lineTile(
      [
        anchor.longitude,
        anchor.latitude,
        anchor.longitude + dLon,
        anchor.latitude,
        anchor.longitude + 2 * dLon,
        anchor.latitude,
      ],
      [0, 3],
      [0],
      [1000],
    );
  }

  const out = new Float64Array(30);

  it('returns 0 before the trip starts and after end + trailLength', () => {
    const trip = buildTripIndex([threeVertexTrip()], proj, 0, {
      precision: 'f64',
    }).trips[0];
    expect(trimTrail(trip, -1, 300, out)).toBe(0);
    expect(trimTrail(trip, 1301, 300, out)).toBe(0);
  });

  it('mid-trip trim yields interpolated tail and head around interior vertices', () => {
    const trip = buildTripIndex([threeVertexTrip()], proj, 0, {
      precision: 'f64',
    }).trips[0];
    // t=750, trail=500 → window [250, 750]: tail lerp at 250 (50 m), the 500
    // vertex (100 m), head lerp at 750 (150 m) — 3 vertices, tail→head.
    const n = trimTrail(trip, 750, 500, out);
    expect(n).toBe(3);
    expect(out[0]).toBeCloseTo(50, 0);
    expect(out[3]).toBeCloseTo(100, 0);
    expect(out[6]).toBeCloseTo(150, 0);
  });

  it('clamps the head to the trip end while the tail is still draining', () => {
    const trip = buildTripIndex([threeVertexTrip()], proj, 0, {
      precision: 'f64',
    }).trips[0];
    // t=1200, trail=500 → window [700, 1000]: tail lerp at 700 (140 m), head
    // clamped to end (200 m).
    const n = trimTrail(trip, 1200, 500, out);
    expect(n).toBe(2);
    expect(out[0]).toBeCloseTo(140, 0);
    expect(out[3]).toBeCloseTo(200, 0);
  });

  it('whole trip inside the window emits every vertex plus the two lerped ends', () => {
    const trip = buildTripIndex([threeVertexTrip()], proj, 0, {
      precision: 'f64',
    }).trips[0];
    // t=1000, trail=1000 → window [0, 1000] = the full trip. The tail lerp
    // duplicates vertex 0 and the head lerp duplicates vertex 2 (interior
    // vertices pass the strict `>`/`<` bounds).
    const n = trimTrail(trip, 1000, 1000, out);
    expect(n).toBe(3);
    expect(out[0]).toBeCloseTo(0, 0);
    expect(out[3]).toBeCloseTo(100, 0);
    expect(out[6]).toBeCloseTo(200, 0);
  });

  it('single-vertex trip returns its one position while active', () => {
    const tile = lineTile(
      [anchor.longitude, anchor.latitude],
      [0, 1],
      [0],
      [1000],
    );
    const trip = buildTripIndex([tile], proj, 0, { precision: 'f64' }).trips[0];
    expect(trimTrail(trip, 500, 300, out)).toBe(1);
    expect(out[0]).toBeCloseTo(0, 3);
  });

  it('agrees with sampleHead at the head vertex', () => {
    const trip = buildTripIndex([threeVertexTrip()], proj, 0, {
      precision: 'f64',
    }).trips[0];
    const n = trimTrail(trip, 640, 200, out);
    const head = sampleHead(trip, 640)!;
    expect(out[(n - 1) * 3]).toBeCloseTo(head.x, 9);
    expect(out[(n - 1) * 3 + 1]).toBeCloseTo(head.y, 9);
    expect(out[(n - 1) * 3 + 2]).toBeCloseTo(head.z, 9);
  });
});

describe('synthesizeVertexTimes (kernel home)', () => {
  it('distributes times by cumulative haversine distance', () => {
    // Vertices at 0 / 100 / 300 m east → times 0 / (100/300)·900 / 900.
    const dLon = 100 / (111_320 * Math.cos((anchor.latitude * Math.PI) / 180));
    const tile = lineTile(
      [
        anchor.longitude,
        anchor.latitude,
        anchor.longitude + dLon,
        anchor.latitude,
        anchor.longitude + 3 * dLon,
        anchor.latitude,
      ],
      [0, 3],
      [100],
      [1000],
    );
    const times = synthesizeVertexTimes(tile.layers[0].features);
    expect(times[0]).toBeCloseTo(100, 3);
    expect(times[1]).toBeCloseTo(100 + 300, 0);
    expect(times[2]).toBeCloseTo(1000, 3);
  });
});

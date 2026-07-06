import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import {
  buildTripIndex,
  sampleHead,
  sampleHeads,
} from '../src/lib/trip-heads';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { makeLineTile } from './_support/features';

const anchor = { longitude: -71.05, latitude: 42.35 };
const proj = new LocalEnuProjection(anchor);

/** One LineString tile with `startIndices` carved over the interleaved positions. */
function lineTile(
  positions: number[], // interleaved lon/lat
  startIndices: number[],
  startTimes: number[],
  endTimes: number[],
  partial: Partial<BinaryFeatures> = {},
  timeOffset = 0,
  geometryType = GeometryType.LineString,
): Tile {
  const featureCount = startIndices.length - 1;
  return makeLineTile(
    {
      featureCount,
      positions: new Float64Array(positions),
      startIndices: new Uint32Array(startIndices),
      featureIds: new Uint32Array(featureCount),
      startTimes: new Float32Array(startTimes),
      endTimes: new Float32Array(endTimes),
      ...partial,
    },
    { timeOffset, geometryType, layerName: 'trips' },
  );
}

// A two-vertex trip 100 m due east of the anchor, active over t∈[0,1000].
function eastwardTrip(timeOffset = 0): Tile {
  const dLon = 100 / (111_320 * Math.cos((anchor.latitude * Math.PI) / 180));
  return lineTile(
    [anchor.longitude, anchor.latitude, anchor.longitude + dLon, anchor.latitude],
    [0, 2],
    [0],
    [1000],
    {},
    timeOffset,
  );
}

describe('buildTripIndex', () => {
  it('pools LineString features and projects vertices RTC', () => {
    const index = buildTripIndex([eastwardTrip()], proj, 0);
    expect(index.trips.length).toBe(1);
    const trip = index.trips[0];
    expect(trip.numVerts).toBe(2);
    // Origin is the first vertex (the anchor → ~0,0,0), so v0 is ~(0,0,0).
    expect(trip.positions[0]).toBeCloseTo(0, 4);
    expect(trip.positions[1]).toBeCloseTo(0, 4);
    // v1 is ~100 m east of the origin.
    expect(trip.positions[3]).toBeCloseTo(100, 2);
    expect(trip.positions[4]).toBeCloseTo(0, 4);
  });

  it('skips non-line geometry', () => {
    const tile = eastwardTrip();
    tile.layers[0].features.geometryType = GeometryType.Point;
    const index = buildTripIndex([tile], proj, 0);
    expect(index.trips.length).toBe(0);
  });

  it('rebases feature times to the common timeOrigin', () => {
    const index = buildTripIndex([eastwardTrip(3000)], proj, 1000);
    const trip = index.trips[0];
    // start/end +2000 (3000 offset - 1000 origin).
    expect(trip.start).toBe(2000);
    expect(trip.end).toBe(3000);
  });

  it('synthesizes monotonic distance-proportional vertex times', () => {
    // 3 collinear vertices: 0, 100 m, 300 m east → frac 0, 1/3, 1 over [0,1000].
    const dLon = 1 / (111_320 * Math.cos((anchor.latitude * Math.PI) / 180));
    const tile = lineTile(
      [
        anchor.longitude, anchor.latitude,
        anchor.longitude + 100 * dLon, anchor.latitude,
        anchor.longitude + 300 * dLon, anchor.latitude,
      ],
      [0, 3],
      [0],
      [1000],
    );
    const index = buildTripIndex([tile], proj, 0);
    const vt = index.trips[0].vertexTimes;
    expect(vt[0]).toBeCloseTo(0, 3);
    expect(vt[1]).toBeCloseTo(1000 / 3, 1);
    expect(vt[2]).toBeCloseTo(1000, 3);
  });

  it('prefers the tile vertexTimestamps column when present', () => {
    const tile = eastwardTrip();
    tile.layers[0].features.vertexTimestamps = new Float32Array([0, 800]);
    const index = buildTripIndex([tile], proj, 0);
    expect(Array.from(index.trips[0].vertexTimes)).toEqual([0, 800]);
  });
});

describe('sampleHead', () => {
  it('returns null outside the trip window', () => {
    const trip = buildTripIndex([eastwardTrip()], proj, 0).trips[0];
    expect(sampleHead(trip, -1)).toBeNull();
    expect(sampleHead(trip, 1001)).toBeNull();
  });

  it('lerps the head to the midpoint at the half-time', () => {
    const trip = buildTripIndex([eastwardTrip()], proj, 0).trips[0];
    const h = sampleHead(trip, 500)!;
    expect(h.x).toBeCloseTo(50, 2); // halfway along the 100 m segment
    expect(h.y).toBeCloseTo(0, 4);
  });

  it('binary-searches the correct segment of a multi-vertex trip', () => {
    const dLon = 1 / (111_320 * Math.cos((anchor.latitude * Math.PI) / 180));
    const tile = lineTile(
      [
        anchor.longitude, anchor.latitude,
        anchor.longitude + 100 * dLon, anchor.latitude,
        anchor.longitude + 200 * dLon, anchor.latitude,
      ],
      [0, 3],
      [0],
      [1000],
      { vertexTimestamps: new Float32Array([0, 500, 1000]) },
    );
    const trip = buildTripIndex([tile], proj, 0).trips[0];
    // t=750 is midway through the second segment → 150 m east.
    const h = sampleHead(trip, 750)!;
    expect(h.x).toBeCloseTo(150, 2);
  });

  it('holds a singleton (one-vertex) trip at its only point', () => {
    const tile = lineTile(
      [anchor.longitude, anchor.latitude],
      [0, 1],
      [0],
      [1000],
    );
    const trip = buildTripIndex([tile], proj, 0).trips[0];
    const h = sampleHead(trip, 500)!;
    expect(h.x).toBeCloseTo(0, 4);
    expect(h.y).toBeCloseTo(0, 4);
  });
});

describe('sampleHeads', () => {
  it('emits one centre per active trip and trims the inactive ones', () => {
    const tiles = [eastwardTrip(), eastwardTrip(5000)]; // second is active later
    const index = buildTripIndex(tiles, proj, 0);
    const out = new Float32Array(index.trips.length * 3);
    // At t=500 only the first trip [0,1000] is active.
    const n = sampleHeads(index, 500, out);
    expect(n).toBe(1);
    expect(out[0]).toBeCloseTo(50, 2);
  });
});

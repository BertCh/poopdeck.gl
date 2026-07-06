import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures } from '@poopdeck.gl/core';
import { buildTripsBuffers, synthesizeVertexTimes } from '../src/lib/trips-buffers';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { makeLineTile } from './_support/features';
import { expectEmptyBuffers } from './_support/rtc';

const anchor = { longitude: -71.05, latitude: 42.35 };

const tripTile = (partial: Partial<BinaryFeatures>, timeOffset = 0) =>
  makeLineTile(partial, { timeOffset, layerName: 'trips' });

describe('buildTripsBuffers', () => {
  const proj = new LocalEnuProjection(anchor);
  const dLon = 0.001;

  // 3 colinear vertices going east → 2 segments.
  function eastLine(extra: Partial<BinaryFeatures>): BinaryFeatures['positions'] {
    return new Float64Array([
      anchor.longitude, anchor.latitude,
      anchor.longitude + dLon, anchor.latitude,
      anchor.longitude + 2 * dLon, anchor.latitude,
    ]);
  }

  it('writes per-vertex trail times from vertexTimestamps, rebased', () => {
    // vertexTimestamps are tile-relative; tile timeOffset 500, timeOrigin 200 → rebase +300.
    const tile = tripTile(
      {
        positions: eastLine({}),
        startIndices: new Uint32Array([0, 3]),
        startTimes: new Float32Array([100]),
        endTimes: new Float32Array([300]),
        vertexTimestamps: new Float32Array([100, 200, 300]),
      },
      500,
    );
    const buf = buildTripsBuffers([tile], proj, 200, {
      colorMode: { type: 'constant', color: [255, 0, 0, 255] },
    });

    expect(buf.count).toBe(2);
    // Segment 0 endpoints = vertices 0,1 → times 100,200 +300 rebase = 400,500.
    expect(buf.timeA[0]).toBe(400);
    expect(buf.timeB[0]).toBe(500);
    // Segment 1 endpoints = vertices 1,2 → times 200,300 +300 = 500,600.
    expect(buf.timeA[1]).toBe(500);
    expect(buf.timeB[1]).toBe(600);
    // Feature [start,end] still rebased the same way.
    expect(buf.starts[0]).toBe(400);
    expect(buf.ends[0]).toBe(600);
  });

  it('synthesizes per-vertex times by cumulative distance when column absent', () => {
    // Equal-length east segments → vertex times should distribute evenly:
    // [start, mid, end] = [0, 50, 100] for duration 100.
    const tile = tripTile({
      positions: eastLine({}),
      startIndices: new Uint32Array([0, 3]),
      startTimes: new Float32Array([0]),
      endTimes: new Float32Array([100]),
      // no vertexTimestamps → synthesized
    });
    const buf = buildTripsBuffers([tile], proj, 0, {
      colorMode: { type: 'constant', color: [0, 255, 0, 255] },
    });
    expect(buf.timeA[0]).toBeCloseTo(0, 3);
    expect(buf.timeB[0]).toBeCloseTo(50, 1); // midpoint of equal segments
    expect(buf.timeA[1]).toBeCloseTo(50, 1);
    expect(buf.timeB[1]).toBeCloseTo(100, 3);
  });

  it('emits RTC-local segment positions with origin carrying the magnitude', () => {
    const tile = tripTile({
      positions: eastLine({}),
      startIndices: new Uint32Array([0, 3]),
      startTimes: new Float32Array([0]),
      endTimes: new Float32Array([100]),
      vertexTimestamps: new Float32Array([0, 50, 100]),
    });
    const buf = buildTripsBuffers([tile], proj, 0, {
      colorMode: { type: 'constant', color: [1, 2, 3, 255] },
    });
    // ENU origin ~0; first segment A at origin → ~0, B east of it.
    expect(buf.posA[0]).toBeCloseTo(0, 4);
    expect(buf.posB[0]).toBeGreaterThan(0);
    expect(buf.colorA[0]).toBeCloseTo(1 / 255, 6);
  });

  it('returns empty for a tile with no line features', () => {
    const tile = tripTile({ featureCount: 0, startIndices: new Uint32Array([0]) });
    const buf = buildTripsBuffers([tile], proj, 0, {
      colorMode: { type: 'constant', color: [0, 0, 0, 255] },
    });
    expectEmptyBuffers(buf);
    expect(buf.timeA.length).toBe(0);
  });
});

describe('synthesizeVertexTimes', () => {
  it('distributes feature [start,end] across vertices by cumulative haversine', () => {
    const b: BinaryFeatures = {
      featureCount: 1,
      geometryType: GeometryType.LineString,
      positionDimensions: 2,
      positions: new Float64Array([
        anchor.longitude, anchor.latitude,
        anchor.longitude + 0.001, anchor.latitude,
        anchor.longitude + 0.003, anchor.latitude, // second segment 2× longer
      ]),
      featureIds: new Uint32Array(1),
      startTimes: new Float32Array([1000]),
      endTimes: new Float32Array([1300]),
      startIndices: new Uint32Array([0, 3]),
      timeOffset: 0,
      numericProps: {},
      categoricalProps: {},
      vectorProps: {},
    };
    const t = synthesizeVertexTimes(b);
    expect(t[0]).toBeCloseTo(1000, 2);
    // first seg = 1/3 of total distance → time 1000 + 100 = 1100.
    expect(t[1]).toBeCloseTo(1100, 0);
    expect(t[2]).toBeCloseTo(1300, 2);
  });

  it('assigns featureStart to all vertices when duration is zero', () => {
    const b: BinaryFeatures = {
      featureCount: 1,
      geometryType: GeometryType.LineString,
      positionDimensions: 2,
      positions: new Float64Array([0, 0, 1, 1]),
      featureIds: new Uint32Array(1),
      startTimes: new Float32Array([42]),
      endTimes: new Float32Array([42]),
      startIndices: new Uint32Array([0, 2]),
      timeOffset: 0,
      numericProps: {},
      categoricalProps: {},
      vectorProps: {},
    };
    const t = synthesizeVertexTimes(b);
    expect(t[0]).toBe(42);
    expect(t[1]).toBe(42);
  });
});

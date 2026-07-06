import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures } from '@poopdeck.gl/core';
import { buildPointBuffers } from '../src/layers/point-buffers';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { MercatorProjection } from '../src/projection/mercator';
import type { RGBA } from '../src/lib/color';
import { makePointTile } from './_support/features';
import { expectEmptyBuffers } from './_support/rtc';

const anchor = { longitude: -71.05, latitude: 42.35 };
const proj = new LocalEnuProjection(anchor);

const pointTile = (
  count: number,
  positions: number[],
  partial: Partial<BinaryFeatures>,
  timeOffset = 0,
  geometryType = GeometryType.Point,
) => makePointTile(count, positions, partial, { timeOffset, geometryType, layerName: 'lidar', z: 18 });

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

  it('colours from a continuous ramp when requested', () => {
    const tile = pointTile(
      3,
      [
        anchor.longitude, anchor.latitude,
        anchor.longitude, anchor.latitude,
        anchor.longitude, anchor.latitude,
      ],
      {
        numericProps: { mag: new Float32Array([0, 5, 10]), z: new Float32Array([0, 0, 0]) },
      },
    );
    const RANGE: RGBA[] = [
      [0, 0, 0, 255],
      [200, 100, 50, 255],
    ];
    const buf = buildPointBuffers([tile], proj, 0, {
      colorMode: {
        type: 'ramp',
        property: 'mag',
        domain: [0, 10],
        range: RANGE,
        fallback: [0, 0, 0, 0],
      },
      elevationProperty: 'z',
      elevationScale: 1,
    });
    expect(buf.count).toBe(3);
    // min → first stop (black)
    expect(buf.colors[0]).toBeCloseTo(0, 6);
    // mid (value 5 of [0,10]) → halfway between stops
    expect(buf.colors[4]).toBeCloseTo(100 / 255, 5);
    // max → second stop
    expect(buf.colors[8]).toBeCloseTo(200 / 255, 5);
    expect(buf.colors[9]).toBeCloseTo(100 / 255, 5);
  });

  it('returns an RTC origin (~0 for the ENU frame, centres stay absolute)', () => {
    const tile = pointTile(
      1,
      [anchor.longitude, anchor.latitude],
      { numericProps: { z: new Float32Array([3]) } },
    );
    const buf = buildPointBuffers([tile], proj, 0, {
      colorMode: { type: 'categorical', property: 'seg_class', mapping: SEG, fallback: [0, 0, 0, 0] },
      elevationProperty: 'z',
      elevationScale: 1,
    });
    // ENU anchored at the point → origin ≈ [0,0,0]; centre rides absolute (z=3).
    expect(buf.origin[0]).toBeCloseTo(0, 5);
    expect(buf.origin[1]).toBeCloseTo(0, 5);
    expect(buf.origin[2]).toBeCloseTo(0, 5);
    expect(buf.centers[2]).toBeCloseTo(3, 5);
  });

  it('subtracts the RTC origin so f32 centres stay small under mercator', () => {
    const mproj = new MercatorProjection(anchor);
    // Two points: the first defines the origin; the second is offset slightly.
    const tile = pointTile(
      2,
      [anchor.longitude, anchor.latitude, anchor.longitude + 0.001, anchor.latitude + 0.001],
      { numericProps: { z: new Float32Array([0, 0]) } },
    );
    const buf = buildPointBuffers([tile], mproj, 0, {
      colorMode: { type: 'categorical', property: 'seg_class', mapping: SEG, fallback: [0, 0, 0, 0] },
      elevationProperty: 'z',
      elevationScale: 1,
    });
    // Origin = the absolute mercator projection of the first point (large).
    const abs0 = mproj.project(anchor.longitude, anchor.latitude, 0);
    expect(buf.origin[0]).toBeCloseTo(abs0[0], 3);
    expect(buf.origin[1]).toBeCloseTo(abs0[1], 3);
    // First centre is the origin → relative ~0 (not the huge absolute magnitude).
    expect(buf.centers[0]).toBeCloseTo(0, 3);
    expect(buf.centers[1]).toBeCloseTo(0, 3);
    // Second centre = absolute(second) - origin, a small local offset.
    const abs1 = mproj.project(anchor.longitude + 0.001, anchor.latitude + 0.001, 0);
    expect(buf.centers[3]).toBeCloseTo(abs1[0] - abs0[0], 3);
    expect(buf.centers[4]).toBeCloseTo(abs1[1] - abs0[1], 3);
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
    expectEmptyBuffers(buf);
  });
});

import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures } from '@poopdeck.gl/core';
import { rampColorAt, expandRampColors, type RGBA } from '../src/lib/color';

const RAMP: RGBA[] = [
  [0, 0, 0, 255],
  [100, 100, 100, 255],
  [200, 200, 200, 255],
];

describe('rampColorAt', () => {
  it('maps domain ends to the first/last stop', () => {
    expect(rampColorAt(0, [0, 10], RAMP)).toEqual([0, 0, 0, 255]);
    expect(rampColorAt(10, [0, 10], RAMP)).toEqual([200, 200, 200, 255]);
  });

  it('interpolates linearly between stops', () => {
    // value 2.5 of [0,10] → t=0.25 → quarter of the way across 2 segments → stop interp.
    const c = rampColorAt(2.5, [0, 10], RAMP);
    expect(c[0]).toBeCloseTo(50, 5); // halfway into the first [0..100] segment
  });

  it('clamps out-of-domain values', () => {
    expect(rampColorAt(-5, [0, 10], RAMP)).toEqual([0, 0, 0, 255]);
    expect(rampColorAt(99, [0, 10], RAMP)).toEqual([200, 200, 200, 255]);
  });

  it('handles a degenerate domain and single-stop ramp', () => {
    expect(rampColorAt(5, [3, 3], RAMP)).toEqual([0, 0, 0, 255]); // zero-width → first
    expect(rampColorAt(5, [0, 10], [[9, 9, 9, 255]])).toEqual([9, 9, 9, 255]);
  });
});

function tile(count: number, prop: Record<string, Float32Array>): BinaryFeatures {
  return {
    featureCount: count,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions: new Float64Array(count * 2),
    featureIds: new Uint32Array(count),
    startTimes: new Float32Array(count),
    endTimes: new Float32Array(count),
    timeOffset: 0,
    numericProps: prop,
    categoricalProps: {},
    vectorProps: {},
  };
}

describe('expandRampColors', () => {
  it('expands a numeric column through the ramp (0..1 rgba)', () => {
    const b = tile(3, { mag: new Float32Array([0, 5, 10]) });
    const out = expandRampColors(b, {
      property: 'mag',
      domain: [0, 10],
      range: RAMP,
      fallback: [255, 0, 0, 255],
    });
    expect(out[0]).toBeCloseTo(0, 6); // value 0 → black
    expect(out[8]).toBeCloseTo(200 / 255, 6); // value 10 → light
  });

  it('falls back when the column is absent', () => {
    const b = tile(1, {});
    const out = expandRampColors(b, {
      property: 'missing',
      domain: [0, 1],
      range: RAMP,
      fallback: [255, 128, 0, 255],
    });
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(128 / 255, 6);
  });
});

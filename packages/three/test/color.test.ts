import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures } from '@poopdeck.gl/core';
import {
  resolveCategoryColor,
  expandCategoricalColors,
  expandRgbColumns,
  rampColorAt,
  expandRampColors,
  type RGBA,
} from '../src/lib/color';

function baseFeatures(count: number, partial: Partial<BinaryFeatures>): BinaryFeatures {
  return {
    featureCount: count,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions: new Float64Array(count * 2),
    featureIds: new Uint32Array(count),
    startTimes: new Float32Array(count),
    endTimes: new Float32Array(count),
    timeOffset: 0,
    numericProps: {},
    categoricalProps: {},
    vectorProps: {},
    ...partial,
  };
}

const HEIGHT: Record<string, RGBA> = {
  '0-2': [40, 120, 190, 255],
  '2-4': [38, 168, 168, 255],
};
const FALLBACK: RGBA = [150, 160, 175, 220];

describe('resolveCategoryColor', () => {
  it('maps a known label', () => {
    expect(resolveCategoryColor('0-2', HEIGHT, FALLBACK)).toEqual([40, 120, 190, 255]);
  });
  it('falls back for unknown or undefined labels', () => {
    expect(resolveCategoryColor('nope', HEIGHT, FALLBACK)).toBe(FALLBACK);
    expect(resolveCategoryColor(undefined, HEIGHT, FALLBACK)).toBe(FALLBACK);
  });
});

describe('expandCategoricalColors', () => {
  it('expands per-feature categories to 0..1 RGBA', () => {
    const b = baseFeatures(3, {
      categoricalProps: {
        height_band: {
          indices: new Uint16Array([0, 1, 0xffff]), // last = null
          categories: ['0-2', '2-4'],
        },
      },
    });
    const out = expandCategoricalColors(b, {
      property: 'height_band',
      mapping: HEIGHT,
      fallback: FALLBACK,
    });
    expect(out[0]).toBeCloseTo(40 / 255, 6);
    expect(out[4 + 1]).toBeCloseTo(168 / 255, 6);
    // null index -> fallback
    expect(out[8]).toBeCloseTo(150 / 255, 6);
    expect(out[8 + 3]).toBeCloseTo(220 / 255, 6);
  });

  it('uses fallback for every feature when the property is absent', () => {
    const b = baseFeatures(2, {});
    const out = expandCategoricalColors(b, {
      property: 'missing',
      mapping: HEIGHT,
      fallback: FALLBACK,
    });
    expect(out[0]).toBeCloseTo(150 / 255, 6);
    expect(out[4]).toBeCloseTo(150 / 255, 6);
  });
});

describe('expandRgbColumns', () => {
  it('normalizes RGB columns and applies alpha', () => {
    const b = baseFeatures(2, {
      numericProps: {
        r: new Float32Array([255, 0]),
        g: new Float32Array([128, 64]),
        b: new Float32Array([0, 255]),
      },
    });
    const out = expandRgbColumns(b, ['r', 'g', 'b'], 0.9);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(128 / 255, 6);
    expect(out[3]).toBeCloseTo(0.9, 6);
    expect(out[4 + 2]).toBeCloseTo(1, 6);
  });
});

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

describe('expandRampColors', () => {
  it('expands a numeric column through the ramp (0..1 rgba)', () => {
    const b = baseFeatures(3, { numericProps: { mag: new Float32Array([0, 5, 10]) } });
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
    const b = baseFeatures(1, {});
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

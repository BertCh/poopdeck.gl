// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { GeometryType } from '../src/types';
import type { BinaryFeatures } from '../src/types';
import {
  resolveCategoryColor,
  expandCategoricalColors,
  expandRgbColumns,
  expandRampColors,
  rampColorAt,
  NULL_CATEGORY_INDEX,
  type RGBA255,
} from '../src/render/style';

function bf(partial: Partial<BinaryFeatures>): BinaryFeatures {
  return {
    featureCount: 0,
    geometryType: GeometryType.Point,
    positions: new Float64Array(0),
    featureIds: new Uint32Array(0),
    startTimes: new Float32Array(0),
    endTimes: new Float32Array(0),
    timeOffset: 0,
    numericProps: {},
    categoricalProps: {},
    ...partial,
  };
}

const RED: RGBA255 = [255, 0, 0, 255];
const BLUE: RGBA255 = [0, 0, 255, 255];
const GREY: RGBA255 = [120, 120, 120, 255];

describe('resolveCategoryColor (three + box-tracks parity)', () => {
  const mapping = { car: RED, bus: BLUE };
  it('maps a known label', () => expect(resolveCategoryColor('car', mapping, GREY)).toEqual(RED));
  it('falls back on unmapped', () => expect(resolveCategoryColor('boat', mapping, GREY)).toEqual(GREY));
  it('falls back on undefined', () => expect(resolveCategoryColor(undefined, mapping, GREY)).toEqual(GREY));
  it('falls back on empty string (box-tracks convention)', () =>
    expect(resolveCategoryColor('', mapping, GREY)).toEqual(GREY));
  it('falls back with null mapping', () => expect(resolveCategoryColor('car', null, GREY)).toEqual(GREY));
});

describe('expandCategoricalColors', () => {
  const cat = { indices: new Uint16Array([0, 1, NULL_CATEGORY_INDEX]), categories: ['car', 'bus'] };
  const binary = bf({ featureCount: 3, categoricalProps: { kind: cat } });
  const mapping = { car: RED, bus: BLUE };

  it('u8 keyed output matches deck/maplibre expandMappedColors', () => {
    const out = expandCategoricalColors(
      binary,
      { property: 'kind', colorMapping: mapping, colorMappingDefault: [0, 0, 0, 0] },
      'u8',
    ) as Uint8Array;
    expect(Array.from(out)).toEqual([
      255, 0, 0, 255, // car
      0, 0, 255, 255, // bus
      0, 0, 0, 0, // NULL index → default (transparent)
    ]);
  });

  it('f32 keyed output matches three (÷255), fill fallback on NULL', () => {
    const out = expandCategoricalColors(
      binary,
      { property: 'kind', colorMapping: mapping, colorMappingDefault: GREY },
      'f32',
    ) as Float32Array;
    expect(out[0]).toBeCloseTo(1); // feature 0 (car) R
    expect(out[4]).toBeCloseTo(0); // feature 1 (bus) R
    expect(out[6]).toBeCloseTo(1); // feature 1 (bus) B
    expect(out[8]).toBeCloseTo(120 / 255); // feature 2 (NULL) → grey R
  });

  it("onMissing 'fill' paints every feature with the default when the prop is absent", () => {
    const out = expandCategoricalColors(
      bf({ featureCount: 2 }),
      { property: 'missing', colorMapping: mapping, colorMappingDefault: GREY, onMissing: 'fill' },
      'u8',
    ) as Uint8Array;
    expect(Array.from(out)).toEqual([120, 120, 120, 255, 120, 120, 120, 255]);
  });

  it("onMissing 'null' (default) returns null when the prop is absent", () => {
    expect(
      expandCategoricalColors(bf({ featureCount: 2 }), { property: 'missing', colorMapping: mapping }, 'u8'),
    ).toBeNull();
  });

  it('positional palette (no keyed mapping) indexes by category (maplibre)', () => {
    const out = expandCategoricalColors(
      binary,
      { property: 'kind', palette: [RED, BLUE] },
      'u8',
    ) as Uint8Array;
    expect(Array.from(out.slice(0, 4))).toEqual([255, 0, 0, 255]); // idx 0 → palette[0]
    expect(Array.from(out.slice(4, 8))).toEqual([0, 0, 255, 255]); // idx 1 → palette[1]
  });

  it('requireMappingOrPalette guard returns null with neither mapping nor palette', () => {
    expect(
      expandCategoricalColors(binary, { property: 'kind', requireMappingOrPalette: true }, 'u8'),
    ).toBeNull();
  });

  it('keyed miss falls through to positional palette then transparent', () => {
    const out = expandCategoricalColors(
      binary,
      { property: 'kind', colorMapping: { car: RED }, palette: [BLUE, GREY] },
      'u8',
    ) as Uint8Array;
    expect(Array.from(out.slice(0, 4))).toEqual([255, 0, 0, 255]); // car → mapping
    expect(Array.from(out.slice(4, 8))).toEqual([120, 120, 120, 255]); // bus miss → palette[1]
  });
});

describe('expandRgbColumns', () => {
  const binary = bf({
    featureCount: 2,
    numericProps: {
      r: new Float32Array([255, 0]),
      g: new Float32Array([128, 255]),
      b: new Float32Array([0, 64]),
    },
  });
  it('reads three columns (u8)', () => {
    const out = expandRgbColumns(binary, ['r', 'g', 'b'], 'u8', 200) as Uint8Array;
    expect(Array.from(out)).toEqual([255, 128, 0, 200, 0, 255, 64, 200]);
  });
  it('fills fallback when a column is missing', () => {
    const out = expandRgbColumns(binary, ['r', 'g', 'nope'], 'u8', 255, [1, 2, 3, 255]) as Uint8Array;
    expect(Array.from(out.slice(0, 4))).toEqual([1, 2, 3, 255]);
  });
});

describe('rampColorAt + expandRampColors', () => {
  const range: RGBA255[] = [
    [0, 0, 0, 255],
    [100, 100, 100, 255],
  ];
  it('interpolates the midpoint', () => {
    expect(rampColorAt(5, [0, 10], range)).toEqual([50, 50, 50, 255]);
  });
  it('clamps below/above domain', () => {
    expect(rampColorAt(-1, [0, 10], range)).toEqual([0, 0, 0, 255]);
    expect(rampColorAt(99, [0, 10], range)).toEqual([100, 100, 100, 255]);
  });
  it('expands a numeric column, fallback when absent', () => {
    const binary = bf({ featureCount: 1, numericProps: {} });
    const out = expandRampColors(binary, { property: 'v', domain: [0, 10], range, fallback: [9, 9, 9, 255] }, 'u8') as Uint8Array;
    expect(Array.from(out)).toEqual([9, 9, 9, 255]);
  });
});

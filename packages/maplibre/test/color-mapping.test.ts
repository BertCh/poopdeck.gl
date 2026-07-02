/**
 * Keyed `colorMapping` category coloring (renderer parity, audit Theme 4).
 *
 * The maplibre adapter historically had only the POSITIONAL `colorPalette`
 * (color = `palette[categoryIndex % palette.length]`), which recolors a
 * category whenever its index shifts in a tile's own dictionary. deck + three
 * expose a keyed `colorMapping` (category STRING → color) that is stable across
 * tiles. `STTBaseLayer.expandCategoricalColors` now supports both; these tests
 * pin the keyed path + its fallbacks, and prove the positional default is
 * unchanged.
 *
 * `expandCategoricalColors` is a pure protected helper (reads only its args),
 * so we invoke it straight off the prototype — no GL context / archive needed.
 */

import { describe, it, expect } from 'vitest';
import { STTBaseLayer, type RGBA8 } from '../src/base-layer';
import type { BinaryFeatures } from '@poopdeck.gl/core';

type Expand = (
  binary: BinaryFeatures,
  propertyName: string,
  palette: ReadonlyArray<RGBA8>,
  colorMapping?: Record<string, RGBA8> | null,
  colorMappingDefault?: RGBA8,
) => Uint8Array | null;

const expand = (STTBaseLayer.prototype as unknown as { expandCategoricalColors: Expand })
  .expandCategoricalColors;

/** Minimal BinaryFeatures carrying one categorical column. */
function features(
  categories: string[],
  indices: number[],
): BinaryFeatures {
  return {
    featureCount: indices.length,
    categoricalProps: {
      kind: { indices: Uint16Array.from(indices), categories },
    },
  } as unknown as BinaryFeatures;
}

const PALETTE: RGBA8[] = [
  [10, 10, 10, 255],
  [20, 20, 20, 255],
  [30, 30, 30, 255],
];

const rgbaAt = (buf: Uint8Array, i: number): number[] =>
  Array.from(buf.subarray(i * 4, i * 4 + 4));

describe('expandCategoricalColors — positional palette (default, unchanged)', () => {
  it('colors each feature by palette[index % palette.length]', () => {
    const buf = expand(features(['a', 'b', 'c', 'd'], [0, 1, 2, 3]), 'kind', PALETTE)!;
    expect(rgbaAt(buf, 0)).toEqual([10, 10, 10, 255]);
    expect(rgbaAt(buf, 1)).toEqual([20, 20, 20, 255]);
    expect(rgbaAt(buf, 2)).toEqual([30, 30, 30, 255]);
    expect(rgbaAt(buf, 3)).toEqual([10, 10, 10, 255]); // wraps (3 % 3)
  });

  it('returns null when the property is missing', () => {
    expect(expand(features(['a'], [0]), 'nope', PALETTE)).toBeNull();
  });
});

describe('expandCategoricalColors — keyed colorMapping (deck/three parity)', () => {
  const mapping: Record<string, RGBA8> = {
    car: [255, 0, 0, 255],
    bike: [0, 255, 0, 255],
  };

  it('colors by category STRING, not index', () => {
    const buf = expand(features(['car', 'bike'], [0, 1]), 'kind', PALETTE, mapping)!;
    expect(rgbaAt(buf, 0)).toEqual([255, 0, 0, 255]);
    expect(rgbaAt(buf, 1)).toEqual([0, 255, 0, 255]);
  });

  it('is STABLE across a tile-local dictionary reorder (the positional hazard)', () => {
    // 'car' sits at dictionary index 0 in tile A but index 1 in tile B. Keyed
    // mapping must paint it the same color in both.
    const tileA = expand(features(['car', 'bike'], [0]), 'kind', PALETTE, mapping)!;
    const tileB = expand(features(['bike', 'car'], [1]), 'kind', PALETTE, mapping)!;
    expect(rgbaAt(tileA, 0)).toEqual([255, 0, 0, 255]); // car, idx 0
    expect(rgbaAt(tileB, 0)).toEqual([255, 0, 0, 255]); // car, idx 1 → still red
    // A positional palette would give palette[0] vs palette[1] — DIFFERENT.
  });

  it('falls back to colorMappingDefault for unmapped categories', () => {
    const buf = expand(
      features(['car', 'truck'], [0, 1]),
      'kind',
      PALETTE,
      mapping,
      [7, 7, 7, 255],
    )!;
    expect(rgbaAt(buf, 0)).toEqual([255, 0, 0, 255]); // mapped
    expect(rgbaAt(buf, 1)).toEqual([7, 7, 7, 255]); // default
  });

  it('falls back to the positional palette when unmapped and no default given', () => {
    const buf = expand(features(['car', 'truck'], [0, 2]), 'kind', PALETTE, mapping)!;
    expect(rgbaAt(buf, 0)).toEqual([255, 0, 0, 255]); // mapped
    expect(rgbaAt(buf, 1)).toEqual([30, 30, 30, 255]); // palette[2 % 3]
  });

  it('colors from a keyed mapping even with an empty palette', () => {
    const buf = expand(features(['car'], [0]), 'kind', [], mapping)!;
    expect(rgbaAt(buf, 0)).toEqual([255, 0, 0, 255]);
  });
});

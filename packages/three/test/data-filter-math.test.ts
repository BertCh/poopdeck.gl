// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// CPU reference for the GPU column filter (deck DataFilterExtension port). The
// node-graph build gate lives in `data-filter-materials.test.ts`; here we assert
// the pure range math (in / out / soft-band fade), the deck-prop → uniform
// resolution, and the load-bearing safe-collapse invariant the vertex-stage
// collapse relies on. No GPU.

import { describe, it, expect } from 'vitest';
import {
  resolveDataFilter,
  dataFilterVisible,
  dataFilterAlpha,
} from '../src/tsl/data-filter-math';

describe('resolveDataFilter', () => {
  it('idles (enabled 0) with no range, so everything renders', () => {
    const r = resolveDataFilter({});
    expect(r.enabled).toBe(0);
    expect(r.filterMin).toBe(0);
    expect(r.filterMax).toBe(0);
  });

  it('idles when explicitly disabled even with a range', () => {
    expect(
      resolveDataFilter({ filterEnabled: false, filterRange: [0, 10] }).enabled,
    ).toBe(0);
  });

  it('activates with a finite [min,max]; soft edges collapse onto hard when absent', () => {
    const r = resolveDataFilter({ filterRange: [2, 8] });
    expect(r.enabled).toBe(1);
    expect(r.useSoftMargin).toBe(0);
    expect(r.filterMin).toBe(2);
    expect(r.filterMax).toBe(8);
    // With no soft range the soft edges sit on the hard edges (soft branch no-op).
    expect(r.filterSoftMin).toBe(2);
    expect(r.filterSoftMax).toBe(8);
  });

  it('carries a finite soft range and the transform flags', () => {
    const r = resolveDataFilter({
      filterRange: [0, 100],
      filterSoftRange: [20, 80],
      filterTransformColor: false,
      filterTransformSize: false,
    });
    expect(r.useSoftMargin).toBe(1);
    expect(r.filterSoftMin).toBe(20);
    expect(r.filterSoftMax).toBe(80);
    expect(r.transformColor).toBe(0);
    expect(r.transformSize).toBe(0);
  });

  it('ignores a non-finite / malformed range (idles)', () => {
    expect(resolveDataFilter({ filterRange: [NaN, 10] }).enabled).toBe(0);
    expect(resolveDataFilter({ filterRange: null }).enabled).toBe(0);
  });
});

describe('dataFilterVisible (hard vertex-collapse gate)', () => {
  const p = resolveDataFilter({ filterRange: [0, 100] });

  it('is 1 inside the inclusive hard range, 0 outside', () => {
    expect(dataFilterVisible(50, p)).toBe(1);
    expect(dataFilterVisible(0, p)).toBe(1); // lower edge inclusive
    expect(dataFilterVisible(100, p)).toBe(1); // upper edge inclusive
    expect(dataFilterVisible(-1, p)).toBe(0);
    expect(dataFilterVisible(101, p)).toBe(0);
  });

  it('is always 1 when the filter idles (bind attribute, animate later)', () => {
    const idle = resolveDataFilter({});
    for (const v of [-1e9, 0, 42, 1e9])
      expect(dataFilterVisible(v, idle)).toBe(1);
  });

  it('ignores the soft band — still a hard 0/1 on the hard edges', () => {
    const soft = resolveDataFilter({
      filterRange: [0, 100],
      filterSoftRange: [20, 80],
    });
    // A value in the fade band (10) is inside the hard range → visible = 1.
    expect(dataFilterVisible(10, soft)).toBe(1);
    expect(dataFilterVisible(120, soft)).toBe(0);
  });
});

describe('dataFilterAlpha (soft opacity fade)', () => {
  it('is 1 across a hard range with no soft band', () => {
    const p = resolveDataFilter({ filterRange: [0, 100] });
    expect(dataFilterAlpha(50, p)).toBe(1);
    expect(dataFilterAlpha(0, p)).toBe(1);
    // Outside the hard range the fade is 0 (the primitive is collapsed anyway).
    expect(dataFilterAlpha(150, p)).toBe(0);
  });

  it('fades linearly-ish across the soft margin (smoothstep)', () => {
    const p = resolveDataFilter({
      filterRange: [0, 100],
      filterSoftRange: [20, 80],
    });
    // Fully inside the soft range → full opacity.
    expect(dataFilterAlpha(50, p)).toBeCloseTo(1, 6);
    // Halfway up the left margin (min 0 → softMin 20, value 10) → smoothstep(0.5) = 0.5.
    expect(dataFilterAlpha(10, p)).toBeCloseTo(0.5, 6);
    // Symmetric on the right margin (softMax 80 → max 100, value 90) → 1 - 0.5 = 0.5.
    expect(dataFilterAlpha(90, p)).toBeCloseTo(0.5, 6);
    // Past the hard edge → 0.
    expect(dataFilterAlpha(110, p)).toBe(0);
  });

  it('does not touch opacity when filterTransformColor is off (returns 1 in-band)', () => {
    const p = resolveDataFilter({
      filterRange: [0, 100],
      filterSoftRange: [20, 80],
      filterTransformColor: false,
    });
    // In the fade band the opacity is untouched (1) even though the primitive
    // still collapses outside the hard range via the visible gate.
    expect(dataFilterAlpha(10, p)).toBe(1);
    expect(dataFilterVisible(120, p)).toBe(0);
  });

  it('is 1 everywhere when the filter idles', () => {
    const idle = resolveDataFilter({});
    for (const v of [-5, 0, 7, 1e6]) expect(dataFilterAlpha(v, idle)).toBe(1);
  });
});

// The safe-collapse invariant that lets the vertex stage zero a primitive's size
// without changing the picture: with the default `filterTransformColor`, a
// feature the soft fade would draw (alpha > 0) is never one the hard gate
// collapses (visible === 1). Sweep a grid of ranges / soft ranges / values.
describe('alpha > 0 ⟹ visible === 1 — safe-collapse invariant', () => {
  it('never collapses a feature whose fade opacity is > 0', () => {
    const ranges: Array<[number, number]> = [
      [0, 100],
      [-50, 50],
      [10, 10], // degenerate point range
    ];
    const softs: Array<[number, number] | null> = [
      null,
      [20, 80],
      [-30, 30],
      [40, 40],
    ];
    for (const range of ranges) {
      for (const soft of softs) {
        const p = resolveDataFilter({
          filterRange: range,
          filterSoftRange: soft,
        });
        for (let v = -120; v <= 120; v += 3) {
          const a = dataFilterAlpha(v, p);
          const vis = dataFilterVisible(v, p);
          expect(vis === 0 || vis === 1).toBe(true); // hard 0/1
          expect(a).toBeGreaterThanOrEqual(0);
          expect(a).toBeLessThanOrEqual(1);
          if (a > 0) expect(vis).toBe(1); // fade draws ⟹ never collapsed
          if (Number.isNaN(a)) throw new Error('alpha is NaN');
        }
      }
    }
  });
});

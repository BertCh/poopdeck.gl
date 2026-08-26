// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

/**
 * The KDEEB kernel math every backend's `liveBundling` device path is pinned to.
 * These cases are the CPU oracle: a GLSL/TSL/luma bundling pass that disagrees
 * with them is wrong, which is the same conformance idiom `time-filter.ts` uses
 * for the scalar alpha.
 */

import { describe, it, expect } from 'vitest';
import {
  bundleEdges,
  annealRadius,
  epanechnikovWeight,
  laplacianStep,
  resampleInto,
  subdivide,
  BUNDLING_WORK_SIZE,
  type Vec2,
} from '../src/render/edge-bundling';

describe('epanechnikovWeight', () => {
  it('is 1 at the centre and 0 at/beyond the bandwidth', () => {
    expect(epanechnikovWeight(0, 10)).toBe(1);
    expect(epanechnikovWeight(10, 10)).toBe(0);
    expect(epanechnikovWeight(11, 10)).toBe(0);
  });

  it('falls off as 1 − (d/h)²', () => {
    expect(epanechnikovWeight(5, 10)).toBeCloseTo(0.75, 12);
    expect(epanechnikovWeight(2, 4)).toBeCloseTo(0.75, 12);
  });

  it('yields 0 rather than NaN when the annealing schedule runs h to zero', () => {
    expect(epanechnikovWeight(1, 0)).toBe(0);
    expect(epanechnikovWeight(0, 0)).toBe(0);
    expect(Number.isNaN(epanechnikovWeight(1, 0))).toBe(false);
  });
});

describe('laplacianStep', () => {
  it('leaves an evenly-spaced collinear triple unchanged', () => {
    const out = laplacianStep([0, 0], [1, 0], [2, 0], 0.5);
    expect(out[0]).toBeCloseTo(1, 12);
    expect(out[1]).toBeCloseTo(0, 12);
  });

  it('relaxes a kink toward the neighbour midpoint by exactly f', () => {
    // midpoint of (0,0)-(2,0) is (1,0); cur sits 1 unit off it in +y.
    const half = laplacianStep([0, 0], [1, 1], [2, 0], 0.5);
    expect(half[1]).toBeCloseTo(0.5, 12);
    const full = laplacianStep([0, 0], [1, 1], [2, 0], 1);
    expect(full[1]).toBeCloseTo(0, 12);
    const none = laplacianStep([0, 0], [1, 1], [2, 0], 0);
    expect(none[1]).toBeCloseTo(1, 12);
  });
});

describe('subdivide', () => {
  it('preserves both endpoints and spaces the rest by arc length', () => {
    const pts: Vec2[] = [
      [0, 0],
      [10, 0],
    ];
    const out = subdivide([...pts], 5);
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual([0, 0]);
    expect(out[4][0]).toBeCloseTo(10, 12);
    expect(out[2][0]).toBeCloseTo(5, 12);
  });

  it('spaces by ARC length, not by vertex index, across uneven segments', () => {
    // A long segment then a short one: the midpoint must land in the long one.
    const out = subdivide(
      [
        [0, 0],
        [9, 0],
        [10, 0],
      ],
      3,
    );
    expect(out[1][0]).toBeCloseTo(5, 12);
  });

  it('degenerates safely below two points or two samples', () => {
    expect(subdivide([[1, 2]], 5)).toEqual([[1, 2]]);
    expect(
      subdivide(
        [
          [0, 0],
          [1, 1],
        ],
        1,
      ),
    ).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });
});

describe('resampleInto — the allocation-free twin of subdivide', () => {
  const runBoth = (verts: number[][], count: number): void => {
    const dims = 2;
    const flat = new Float64Array(verts.flat());
    const out = new Float64Array(count * dims);
    resampleInto(flat, dims, 0, verts.length, count, out, 0);
    const oracle = subdivide(
      verts.map((v) => [v[0], v[1]] as Vec2),
      count,
    );
    for (let i = 0; i < count; i++) {
      expect(out[i * dims], `x[${i}]`).toBeCloseTo(oracle[i][0], 9);
      expect(out[i * dims + 1], `y[${i}]`).toBeCloseTo(oracle[i][1], 9);
    }
  };

  it('is numerically identical to subdivide on a straight polyline', () => {
    runBoth(
      [
        [0, 0],
        [10, 0],
      ],
      8,
    );
  });

  it('is numerically identical to subdivide on uneven, non-collinear input', () => {
    runBoth(
      [
        [0, 0],
        [9, 1],
        [10, 7],
        [12, 7.5],
      ],
      11,
    );
  });

  it('writes at the requested point offset and leaves earlier slots alone', () => {
    const flat = new Float64Array([0, 0, 4, 0]);
    const out = new Float64Array(6).fill(-1);
    resampleInto(flat, 2, 0, 2, 2, out, 1);
    expect(out[0]).toBe(-1);
    expect(out[1]).toBe(-1);
    expect(out[2]).toBeCloseTo(0, 12);
    expect(out[4]).toBeCloseTo(4, 12);
  });

  it('degenerates a single vertex to `count` copies and an empty range to zeros', () => {
    const flat = new Float64Array([3, 7]);
    const one = new Float64Array(6);
    resampleInto(flat, 2, 0, 1, 3, one, 0);
    expect(Array.from(one)).toEqual([3, 7, 3, 7, 3, 7]);

    const none = new Float64Array(4).fill(9);
    resampleInto(flat, 2, 0, 0, 2, none, 0);
    expect(Array.from(none)).toEqual([0, 0, 0, 0]);
  });
});

describe('annealRadius', () => {
  it('shrinks the bandwidth by lambda', () => {
    expect(annealRadius(100, 0.8)).toBeCloseTo(80, 12);
  });

  it('clamps lambda into the CUBu-sane [0.5, 0.9]', () => {
    expect(annealRadius(100, 0.1)).toBeCloseTo(50, 12);
    expect(annealRadius(100, 2)).toBeCloseTo(90, 12);
  });

  it('is monotonically decreasing, so an annealing loop terminates', () => {
    let h = BUNDLING_WORK_SIZE;
    for (let i = 0; i < 15; i++) {
      const next = annealRadius(h, 0.9);
      expect(next).toBeLessThan(h);
      h = next;
    }
    expect(h).toBeLessThan(BUNDLING_WORK_SIZE);
  });
});

describe('bundleEdges — the KDEEB iteration itself', () => {
  const W = BUNDLING_WORK_SIZE;

  /** `count` horizontal edges at evenly spaced heights, each with `p` points. */
  function parallelEdges(
    count: number,
    p: number,
    spread: number,
  ): Float64Array {
    const out = new Float64Array(count * p * 2);
    for (let e = 0; e < count; e++) {
      const y = W / 2 + (e - (count - 1) / 2) * spread;
      for (let i = 0; i < p; i++) {
        out[(e * p + i) * 2] = W * 0.1 + (W * 0.8 * i) / (p - 1);
        out[(e * p + i) * 2 + 1] = y;
      }
    }
    return out;
  }

  const midY = (buf: Float64Array, e: number, p: number): number =>
    buf[(e * p + (p >> 1)) * 2 + 1];

  it('ATTRACTS neighbouring edges — the defining behaviour of bundling', () => {
    const p = 33;
    const n = 6;
    const before = parallelEdges(n, p, 12);
    const after = bundleEdges(before, n, p, { iterations: 12 });

    const spreadOf = (buf: Float64Array): number => {
      const ys = Array.from({ length: n }, (_, e) => midY(buf, e, p));
      return Math.max(...ys) - Math.min(...ys);
    };
    // The midpoints must draw together. This is the whole algorithm; if it
    // fails, nothing else about the module matters.
    expect(spreadOf(after)).toBeLessThan(spreadOf(before) * 0.9);
  });

  it('PINS both endpoints of every edge, exactly', () => {
    const p = 21;
    const n = 5;
    const before = parallelEdges(n, p, 15);
    const after = bundleEdges(before, n, p, { iterations: 10 });
    for (let e = 0; e < n; e++) {
      for (const i of [0, p - 1]) {
        const k = (e * p + i) * 2;
        expect(after[k], `edge ${e} point ${i} x`).toBe(before[k]);
        expect(after[k + 1], `edge ${e} point ${i} y`).toBe(before[k + 1]);
      }
    }
  });

  it('never mutates the caller buffer', () => {
    const p = 9;
    const before = parallelEdges(3, p, 20);
    const copy = Float64Array.from(before);
    bundleEdges(before, 3, p, { iterations: 4 });
    expect(Array.from(before)).toEqual(Array.from(copy));
  });

  it('is deterministic — same input, byte-identical output', () => {
    const p = 17;
    const src = parallelEdges(4, p, 18);
    const a = bundleEdges(src, 4, p, { iterations: 8 });
    const b = bundleEdges(src, 4, p, { iterations: 8 });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('leaves a LONE edge essentially where it was — nothing to bundle toward', () => {
    const p = 25;
    const src = parallelEdges(1, p, 0);
    const out = bundleEdges(src, 1, p, { iterations: 10 });
    // A lone edge has only its OWN density to climb, and the ridge of that
    // density is the edge itself — so it must not go anywhere in particular.
    //
    // The residual is not zero, and that is a property of the method rather
    // than a defect: the density field is sampled on a finite grid, the edge
    // does not lie exactly on a cell centre, and a central difference across
    // neighbouring cells therefore reports a small non-zero gradient. The drift
    // is bounded by the quantization, NOT by the bandwidth — which is what
    // distinguishes it from real attraction. Assert that bound (well under 1%
    // of the work box) instead of an exactness the discretization cannot give.
    const drift = Math.max(
      ...Array.from({ length: p }, (_, i) =>
        Math.abs(out[i * 2 + 1] - src[i * 2 + 1]),
      ),
    );
    expect(drift).toBeLessThan(BUNDLING_WORK_SIZE * 0.01);
  });

  it('a lone edge drifts far LESS than neighbouring edges attract', () => {
    // The companion to the case above: it is only meaningful if genuine
    // attraction is an order of magnitude larger than the quantization floor.
    const p = 25;
    const lone = bundleEdges(parallelEdges(1, p, 0), 1, p, { iterations: 10 });
    const loneDrift = Math.abs(lone[(p >> 1) * 2 + 1] - BUNDLING_WORK_SIZE / 2);

    const n = 6;
    const src = parallelEdges(n, p, 12);
    const pulled = bundleEdges(src, n, p, { iterations: 10 });
    const outerPull = Math.abs(midY(pulled, 0, p) - midY(src, 0, p));

    expect(outerPull).toBeGreaterThan(loneDrift * 5);
  });

  it('is identity on degenerate input rather than throwing', () => {
    const two = new Float64Array([0, 0, 10, 10]);
    expect(Array.from(bundleEdges(two, 1, 2))).toEqual([0, 0, 10, 10]);
    expect(Array.from(bundleEdges(new Float64Array(0), 0, 0))).toEqual([]);
  });

  it('zero iterations is a pure copy', () => {
    const p = 11;
    const src = parallelEdges(3, p, 20);
    expect(Array.from(bundleEdges(src, 3, p, { iterations: 0 }))).toEqual(
      Array.from(src),
    );
  });

  it('keeps every control point finite (no NaN from a zero gradient or radius)', () => {
    const p = 15;
    const src = parallelEdges(4, p, 25);
    const out = bundleEdges(src, 4, p, { iterations: 20, lambda: 0.5 });
    expect(Array.from(out).every(Number.isFinite)).toBe(true);
  });

  it('more iterations bundle more tightly', () => {
    const p = 29;
    const n = 5;
    const src = parallelEdges(n, p, 14);
    const spreadOf = (buf: Float64Array): number => {
      const ys = Array.from({ length: n }, (_, e) => midY(buf, e, p));
      return Math.max(...ys) - Math.min(...ys);
    };
    const few = spreadOf(bundleEdges(src, n, p, { iterations: 3 }));
    const many = spreadOf(bundleEdges(src, n, p, { iterations: 14 }));
    expect(many).toBeLessThanOrEqual(few);
  });
});

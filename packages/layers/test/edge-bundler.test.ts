/**
 * EdgeBundler — GPU kernel-density edge bundling (KDEEB).
 *
 * The GPU pipeline needs a device, so these tests cover the pure math the GLSL
 * kernels transliterate: the Epanechnikov density kernel, the Laplacian
 * smoothing step, and polyline arc-length resampling. `@luma.gl/engine` is
 * mocked so importing the module (Model/Geometry at top level) needs no device.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@luma.gl/engine', () => ({
  Model: class {},
  Geometry: class {},
}));

import {
  epanechnikovWeight,
  laplacianStep,
  subdivide,
  type Vec2,
} from '../src/lib/edge-bundler';

describe('EdgeBundler density kernel', () => {
  it('Epanechnikov: 1 at the centre, 0 at/over the bandwidth, decreasing between', () => {
    expect(epanechnikovWeight(0, 10)).toBeCloseTo(1, 9);
    expect(epanechnikovWeight(10, 10)).toBe(0); // at the radius
    expect(epanechnikovWeight(15, 10)).toBe(0); // beyond the radius
    // 1 - (5/10)^2 = 0.75 at half the bandwidth.
    expect(epanechnikovWeight(5, 10)).toBeCloseTo(0.75, 9);
    // Monotonically decreasing with distance.
    expect(epanechnikovWeight(3, 10)).toBeGreaterThan(epanechnikovWeight(7, 10));
  });

  it('Epanechnikov: degenerate bandwidth yields no weight', () => {
    expect(epanechnikovWeight(0, 0)).toBe(0);
  });
});

describe('EdgeBundler Laplacian smoothing', () => {
  it('leaves an evenly-spaced collinear point unchanged', () => {
    expect(laplacianStep([0, 0], [1, 0], [2, 0], 0.5)).toEqual([1, 0]);
  });

  it('pulls a kinked point toward the midpoint of its neighbours', () => {
    // Neighbours midpoint is [1,0]; cur sits below at [1,-1]. f=0.5 moves it
    // halfway to the midpoint → [1,-0.5].
    expect(laplacianStep([0, 0], [1, -1], [2, 0], 0.5)).toEqual([1, -0.5]);
  });

  it('f=0 is a no-op; f=1 snaps to the neighbour midpoint', () => {
    expect(laplacianStep([0, 0], [1, -1], [2, 0], 0)).toEqual([1, -1]);
    expect(laplacianStep([0, 0], [1, -1], [2, 0], 1)).toEqual([1, 0]);
  });

  it('repeated smoothing relaxes a sawtooth toward a straight line', () => {
    // 5 collinear endpoints with two interior kinks; smooth a few times.
    let pts: Vec2[] = [
      [0, 0],
      [1, 1],
      [2, -1],
      [3, 1],
      [4, 0],
    ];
    for (let n = 0; n < 40; n++) {
      const next = pts.map((p, i) =>
        i === 0 || i === pts.length - 1 ? p : laplacianStep(pts[i - 1], p, pts[i + 1], 0.5),
      );
      pts = next;
    }
    // Interior amplitudes should have collapsed toward the 0 baseline.
    for (let i = 1; i < pts.length - 1; i++) expect(Math.abs(pts[i][1])).toBeLessThan(0.2);
  });
});

describe('EdgeBundler subdivide', () => {
  it('doubling a straight line keeps it straight and evenly spaced', () => {
    const out = subdivide(
      [
        [0, 0],
        [4, 0],
      ],
      5,
    );
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual([0, 0]);
    expect(out[4]).toEqual([4, 0]);
    expect(out[2][0]).toBeCloseTo(2, 6);
    for (let i = 1; i < out.length; i++) expect(out[i][0] - out[i - 1][0]).toBeCloseTo(1, 6);
  });

  it('preserves endpoints when resampling an L-shaped (curved) polyline', () => {
    const out = subdivide(
      [
        [0, 0],
        [2, 0],
        [2, 2],
      ],
      9,
    );
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual([2, 2]);
    // A curved input keeps its bend — the midpoint lands at the corner [2,0].
    expect(out[4][0]).toBeCloseTo(2, 6);
    expect(out[4][1]).toBeCloseTo(0, 6);
  });
});

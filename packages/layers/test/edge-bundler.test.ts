/**
 * EdgeBundler — GPU kernel-density edge bundling (KDEEB).
 *
 * The GPU pipeline needs a device, so these tests cover the pure math the GLSL
 * kernels transliterate: the Epanechnikov density kernel, the Laplacian
 * smoothing step, polyline arc-length resampling (boxed and streaming), the
 * device texture-size ceiling, and the density-splat fill budget.
 * `@luma.gl/engine` is mocked so importing the module (Model/Geometry at top
 * level) needs no device.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@luma.gl/engine', () => ({
  Model: class {},
  Geometry: class {},
}));

import {
  advectFs,
  clampKernelRadius,
  epanechnikovWeight,
  laplacianStep,
  maxBundleEdges,
  maxTextureDimension,
  resampleInto,
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
    expect(epanechnikovWeight(3, 10)).toBeGreaterThan(
      epanechnikovWeight(7, 10),
    );
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
        i === 0 || i === pts.length - 1
          ? p
          : laplacianStep(pts[i - 1], p, pts[i + 1], 0.5),
      );
      pts = next;
    }
    // Interior amplitudes should have collapsed toward the 0 baseline.
    for (let i = 1; i < pts.length - 1; i++)
      expect(Math.abs(pts[i][1])).toBeLessThan(0.2);
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
    for (let i = 1; i < out.length; i++)
      expect(out[i][0] - out[i - 1][0]).toBeCloseTo(1, 6);
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

describe('EdgeBundler resampleInto (allocation-free)', () => {
  /** Run the boxed and the streaming resampler over the same polyline. */
  const both = (
    pts: number[][],
    count: number,
  ): { boxed: number[][]; streamed: number[][] } => {
    const dims = 2;
    const flat = new Float64Array(pts.length * dims);
    pts.forEach((p, i) => {
      flat[i * dims] = p[0];
      flat[i * dims + 1] = p[1];
    });
    const out = new Float64Array(count * dims);
    resampleInto(flat, dims, 0, pts.length, count, out, 0);
    return {
      boxed: subdivide(pts as Vec2[], count),
      streamed: Array.from({ length: count }, (_, i) => [
        out[i * dims],
        out[i * dims + 1],
      ]),
    };
  };

  it('matches subdivide on a straight 2-vertex OD pair', () => {
    const { boxed, streamed } = both(
      [
        [0, 0],
        [4, 0],
      ],
      5,
    );
    streamed.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(boxed[i][0], 9);
      expect(p[1]).toBeCloseTo(boxed[i][1], 9);
    });
  });

  it('matches subdivide on a multi-segment routed polyline', () => {
    const { boxed, streamed } = both(
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [5, 2],
      ],
      13,
    );
    streamed.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(boxed[i][0], 9);
      expect(p[1]).toBeCloseTo(boxed[i][1], 9);
    });
  });

  it('degenerates safely: single vertex, empty range, zero-length polyline', () => {
    const dims = 2;
    const single = new Float64Array([7, 8]);
    const out = new Float64Array(3 * dims);
    resampleInto(single, dims, 0, 1, 3, out, 0);
    expect(Array.from(out)).toEqual([7, 8, 7, 8, 7, 8]);

    out.fill(-1);
    resampleInto(single, dims, 0, 0, 3, out, 0);
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 0, 0]);

    // Coincident vertices: total arc length 0 → every sample is the endpoint.
    const flat = new Float64Array([3, 4, 3, 4]);
    resampleInto(flat, dims, 0, 2, 3, out, 0);
    expect(Array.from(out)).toEqual([3, 4, 3, 4, 3, 4]);
  });

  it('writes at the requested POINT offset, leaving neighbours untouched', () => {
    const dims = 2;
    const flat = new Float64Array([0, 0, 1, 0]);
    const out = new Float64Array(6 * dims).fill(-1);
    resampleInto(flat, dims, 0, 2, 2, out, 2); // edge 1 of a P=2 layout
    expect(Array.from(out.subarray(0, 4))).toEqual([-1, -1, -1, -1]);
    expect(Array.from(out.subarray(4, 8))).toEqual([0, 0, 1, 0]);
    expect(Array.from(out.subarray(8, 12))).toEqual([-1, -1, -1, -1]);
  });
});

describe('EdgeBundler device texture limits', () => {
  const device = (maxTextureDimension2D: number) =>
    ({ limits: { maxTextureDimension2D } }) as any;

  it('reads maxTextureDimension2D, with a conservative fallback', () => {
    expect(maxTextureDimension(device(16384))).toBe(16384);
    // A device (or stub) that reports no limits must not read as "unlimited".
    expect(maxTextureDimension({} as any)).toBe(2048);
    expect(maxTextureDimension(null)).toBe(2048);
    expect(maxTextureDimension(device(0))).toBe(2048);
  });

  it('caps the edge count at the texture height limit', () => {
    // Both bundle textures are `edgeCount` rows tall: a 30k-edge corridor tier
    // asked for a 48×30000 texture, over the limit on essentially every GPU.
    expect(maxBundleEdges(device(8192), 48, 24)).toBe(8192);
    expect(maxBundleEdges(device(4096), 48, 24)).toBe(4096);
  });

  it('returns 0 when the texture WIDTHS alone exceed the limit', () => {
    // No edge count can rescue an absurd subdivisionPoints / bucket count.
    expect(maxBundleEdges(device(4096), 5000, 24)).toBe(0);
    expect(maxBundleEdges(device(4096), 48, 9000)).toBe(0);
  });
});

describe('EdgeBundler splat fill budget', () => {
  it('leaves a modest kernel alone', () => {
    // 200 edges × 48 points at the default 0.05 fraction (50 work units).
    expect(clampKernelRadius(50, 200, 48)).toBeCloseTo(50, 9);
  });

  it('shrinks the kernel once sites × area blows the budget', () => {
    // Defaults at the maxBundledEdges ceiling: 4000 × 48 = 192k splat quads of
    // side 2·25.6 px ≈ 5×10⁸ additively-blended fragments in ONE pass.
    const clamped = clampKernelRadius(50, 4000, 48);
    expect(clamped).toBeLessThan(50);
    expect(clamped).toBeGreaterThan(2);
  });

  it('is inversely proportional to sqrt(sites) — the quadratic cost model', () => {
    // Doubling the kernel quadruples fill, so 4× the sites halves the radius.
    const a = clampKernelRadius(1e6, 4000, 48);
    const b = clampKernelRadius(1e6, 16000, 48);
    expect(a / b).toBeCloseTo(2, 3);
  });

  it('never clamps below the 2-work-unit floor', () => {
    // A sub-texel kernel would bundle nothing at all.
    expect(clampKernelRadius(50, 10_000_000, 48)).toBe(2);
  });
});

describe('EdgeBundler advection', () => {
  it('clamps advected control points into the work box', () => {
    // The gradient step was unbounded: a point pushed outside [0, WORK_SIZE]
    // splats off the density NDC (so nothing ever pulls it back) while the
    // renderer still reconstructs a lon/lat for it. Only the density LOOKUP
    // indices were clamped. There is no GLSL runtime here, so assert the
    // emitted kernel.
    const fs = advectFs(48);
    expect(fs).toMatch(
      /p = clamp\(p \+ kdeb\.advectStep \* grad \/ g, vec2\(0\.0\), vec2\(1000\.0\)\)/,
    );
    // Endpoints stay pinned regardless.
    expect(fs).toMatch(/if \(i == 0 \|\| i == 47\)/);
  });
});

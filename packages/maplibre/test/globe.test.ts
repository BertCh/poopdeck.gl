/**
 * Globe kit helpers operate on plain numeric buffers and have no GL or map
 * dependency, so they're testable purely in Node with hand-computed
 * reference expectations.
 */

import { describe, it, expect } from 'vitest';
import {
  granularityForZoom,
  shouldDrawWorldCopy,
  subdivideLineMercator,
  subdivideTrianglesMercator,
} from '../src/lib/globe';

/** Signed area of triangle (i0, i1, i2); positive = CCW. */
function signedArea(
  pos: Float64Array,
  i0: number,
  i1: number,
  i2: number,
): number {
  const ax = pos[i0 * 2];
  const ay = pos[i0 * 2 + 1];
  const bx = pos[i1 * 2];
  const by = pos[i1 * 2 + 1];
  const cx = pos[i2 * 2];
  const cy = pos[i2 * 2 + 1];
  return ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
}

/** Chebyshev (per-axis) span of edge (i0, i1) — the kit's split metric. */
function edgeSpan(pos: Float64Array, i0: number, i1: number): number {
  return Math.max(
    Math.abs(pos[i1 * 2] - pos[i0 * 2]),
    Math.abs(pos[i1 * 2 + 1] - pos[i0 * 2 + 1]),
  );
}

/** Max edge span over every output triangle. */
function maxEdgeSpan(pos: Float64Array, indices: Uint32Array): number {
  let max = 0;
  for (let t = 0; t < indices.length; t += 3) {
    max = Math.max(
      max,
      edgeSpan(pos, indices[t], indices[t + 1]),
      edgeSpan(pos, indices[t + 1], indices[t + 2]),
      edgeSpan(pos, indices[t + 2], indices[t]),
    );
  }
  return max;
}

describe('subdivideLineMercator', () => {
  it('splits a 0.4-span segment into 4 pieces at granularity 10', () => {
    // span 0.4, threshold 1/10 -> ceil(0.4 * 10) = 4 pieces -> 3 inserted
    // vertices at x = 0.2, 0.3, 0.4 (y constant).
    const { positions } = subdivideLineMercator([0.1, 0.5, 0.5, 0.5], 10);
    expect(positions.length).toBe(10);
    expect(positions[0]).toBe(0.1);
    expect(positions[2]).toBeCloseTo(0.2, 12);
    expect(positions[4]).toBeCloseTo(0.3, 12);
    expect(positions[6]).toBeCloseTo(0.4, 12);
    expect(positions[8]).toBe(0.5);
    for (let v = 0; v < 5; v++) expect(positions[v * 2 + 1]).toBe(0.5);
  });

  it('linearly interpolates parallel attribute arrays at inserted vertices', () => {
    const times = new Float32Array([100, 140]); // 1 component
    const colors = new Float32Array([0, 0, 0, 40, 80, 120]); // 3 components
    const { positions, attrs } = subdivideLineMercator(
      [0.1, 0.5, 0.5, 0.5],
      10,
      {
        arrays: [times, colors],
        components: [1, 3],
      },
    );
    expect(positions.length).toBe(10);
    // times at t = 0, 1/4, 2/4, 3/4, 1 -> 100, 110, 120, 130, 140.
    const outTimes = attrs!.arrays[0];
    expect(Array.from(outTimes as Float32Array)).toEqual([
      100, 110, 120, 130, 140,
    ]);
    // colors lerp per component: t=0.25 -> (10,20,30), t=0.5 -> (20,40,60),
    // t=0.75 -> (30,60,90).
    const outColors = attrs!.arrays[1] as Float32Array;
    expect(Array.from(outColors.subarray(3, 6))).toEqual([10, 20, 30]);
    expect(Array.from(outColors.subarray(6, 9))).toEqual([20, 40, 60]);
    expect(Array.from(outColors.subarray(9, 12))).toEqual([30, 60, 90]);
    // Original vertices verbatim.
    expect(Array.from(outColors.subarray(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(outColors.subarray(12, 15))).toEqual([40, 80, 120]);
  });

  it('handles multi-segment polylines with mixed spans', () => {
    // seg0 span 0.25 -> ceil(2.5) = 3 pieces (2 inserted); seg1 span 0.02 ->
    // 1 piece (untouched). 3 originals + 2 inserted = 5 vertices.
    const { positions } = subdivideLineMercator(
      [0, 0.5, 0.25, 0.5, 0.25, 0.52],
      10,
    );
    expect(positions.length).toBe(10);
    expect(positions[2]).toBeCloseTo(0.25 / 3, 12);
    expect(positions[4]).toBeCloseTo(0.5 / 3, 12);
    expect(positions[6]).toBe(0.25);
    expect(positions[7]).toBe(0.5);
    expect(positions[8]).toBe(0.25);
    expect(positions[9]).toBe(0.52);
  });

  it('passes short segments through with original vertices exact', () => {
    // Deliberately non-representable values: verbatim copy, not re-lerped.
    const x0 = 0.1 + 0.2; // 0.30000000000000004
    const input = [x0, 0.4, x0 + 0.01, 0.41];
    const { positions } = subdivideLineMercator(input, 10);
    expect(positions.length).toBe(4);
    expect(positions[0]).toBe(x0);
    expect(positions[2]).toBe(x0 + 0.01);
  });

  it('does not split exact-multiple spans one extra time (epsilon guard)', () => {
    // span 0.2 at granularity 10 is exactly 2 thresholds -> 2 pieces, not 3.
    const { positions } = subdivideLineMercator([0.1, 0.5, 0.3, 0.5], 10);
    expect(positions.length).toBe(6);
    expect(positions[2]).toBeCloseTo(0.2, 12);
  });

  it('passes zero-length (degenerate) segments through unsplit', () => {
    const { positions } = subdivideLineMercator([0.3, 0.3, 0.3, 0.3], 1000);
    expect(positions.length).toBe(4);
    expect(Array.from(positions)).toEqual([0.3, 0.3, 0.3, 0.3]);
  });

  it('treats invalid granularity (0, NaN, Infinity is capped) as no subdivision', () => {
    for (const bad of [0, -5, NaN]) {
      const { positions } = subdivideLineMercator([0, 0, 1, 1], bad);
      expect(positions.length).toBe(4);
    }
  });

  it('caps runaway piece counts from absurd granularity', () => {
    const { positions } = subdivideLineMercator([0, 0, 1, 0], 1e9);
    // 4096-piece safety cap -> 4095 inserted + 2 originals.
    expect(positions.length).toBe(4097 * 2);
  });

  it('handles empty and single-vertex inputs', () => {
    expect(subdivideLineMercator([], 128).positions.length).toBe(0);
    const single = subdivideLineMercator([0.5, 0.5], 128);
    expect(Array.from(single.positions)).toEqual([0.5, 0.5]);
  });

  it('mirrors typed attribute array constructors; plain arrays become Float32Array', () => {
    const { attrs } = subdivideLineMercator([0, 0.5, 0.5, 0.5], 4, {
      arrays: [new Float64Array([1000, 2000]), [7, 9]],
      components: [1, 1],
    });
    expect(attrs!.arrays[0]).toBeInstanceOf(Float64Array);
    expect(attrs!.arrays[1]).toBeInstanceOf(Float32Array);
    // Float64 timestamps keep lerp precision.
    expect(Array.from(attrs!.arrays[0] as Float64Array)).toEqual([
      1000, 1500, 2000,
    ]);
  });

  it('throws on malformed inputs', () => {
    expect(() => subdivideLineMercator([0, 0, 1], 10)).toThrow(/even length/);
    expect(() =>
      subdivideLineMercator([0, 0, 1, 1], 10, {
        arrays: [new Float32Array(2)],
        components: [1, 1],
      }),
    ).toThrow(/lengths differ/);
    expect(() =>
      subdivideLineMercator([0, 0, 1, 1], 10, {
        arrays: [new Float32Array(3)],
        components: [1],
      }),
    ).toThrow(/length 3/);
  });
});

describe('subdivideTrianglesMercator', () => {
  it('performs a single deterministic longest-edge split', () => {
    // Longest edge A-B (span 0.6 > 1/2); midpoint (0.3, 0) appended as
    // vertex 3; children emitted depth-first: (m,B,C) then (A,m,C).
    const { positions, indices } = subdivideTrianglesMercator(
      [0, 0, 0.6, 0, 0.3, 0.1],
      [0, 1, 2],
      2,
    );
    expect(Array.from(positions)).toEqual([0, 0, 0.6, 0, 0.3, 0.1, 0.3, 0]);
    expect(Array.from(indices)).toEqual([3, 1, 2, 0, 3, 2]);
    // Both children keep the input's CCW winding and split the area evenly.
    expect(signedArea(positions, 3, 1, 2)).toBeCloseTo(0.015, 12);
    expect(signedArea(positions, 0, 3, 2)).toBeCloseTo(0.015, 12);
  });

  it('returns a below-threshold mesh unchanged (fresh copies)', () => {
    const input = [0, 0, 0.3, 0, 0, 0.3];
    const { positions, indices } = subdivideTrianglesMercator(
      input,
      [0, 1, 2],
      2,
    );
    expect(Array.from(positions)).toEqual(input);
    expect(Array.from(indices)).toEqual([0, 1, 2]);
  });

  it('subdivides until every edge is under threshold, preserving winding and area', () => {
    // CCW right triangle, area 0.08; granularity 10 -> max edge span 0.1.
    const { positions, indices } = subdivideTrianglesMercator(
      [0, 0, 0.4, 0, 0, 0.4],
      [0, 1, 2],
      10,
    );
    expect(maxEdgeSpan(positions, indices)).toBeLessThanOrEqual(0.1 + 1e-9);
    let total = 0;
    for (let t = 0; t < indices.length; t += 3) {
      const area = signedArea(
        positions,
        indices[t],
        indices[t + 1],
        indices[t + 2],
      );
      expect(area).toBeGreaterThan(0); // CCW preserved on every child
      total += area;
    }
    expect(total).toBeCloseTo(0.08, 12);
  });

  it('preserves CW winding too', () => {
    const { positions, indices } = subdivideTrianglesMercator(
      [0, 0, 0, 0.4, 0.4, 0], // CW: signed area -0.08
      [0, 1, 2],
      10,
    );
    let total = 0;
    for (let t = 0; t < indices.length; t += 3) {
      const area = signedArea(
        positions,
        indices[t],
        indices[t + 1],
        indices[t + 2],
      );
      expect(area).toBeLessThan(0);
      total += area;
    }
    expect(total).toBeCloseTo(-0.08, 12);
  });

  it('dedupes midpoints on shared edges (watertight refinement)', () => {
    // Unit-ish square as two CCW triangles sharing diagonal A-C. Both sides
    // must split the diagonal at the SAME appended vertex (0.2, 0.2).
    const { positions, indices } = subdivideTrianglesMercator(
      [0, 0, 0.4, 0, 0.4, 0.4, 0, 0.4],
      [0, 1, 2, 0, 2, 3],
      5,
    );
    let centerCount = 0;
    for (let v = 0; v < positions.length / 2; v++) {
      if (positions[v * 2] === 0.2 && positions[v * 2 + 1] === 0.2)
        centerCount++;
    }
    expect(centerCount).toBe(1);
    expect(maxEdgeSpan(positions, indices)).toBeLessThanOrEqual(0.2 + 1e-9);
    let total = 0;
    for (let t = 0; t < indices.length; t += 3) {
      total += signedArea(
        positions,
        indices[t],
        indices[t + 1],
        indices[t + 2],
      );
    }
    expect(total).toBeCloseTo(0.16, 12);
  });

  it('caps recursion depth instead of exploding on tiny thresholds', () => {
    // Threshold 1e-5 is unreachable within 16 bisection levels for a
    // unit-scale triangle: every leaf bottoms out at the cap -> exactly
    // 2^16 output triangles, and edges remain over threshold.
    const { positions, indices } = subdivideTrianglesMercator(
      [0, 0, 1, 0, 0, 1],
      [0, 1, 2],
      1e5,
    );
    expect(indices.length / 3).toBe(65536);
    expect(maxEdgeSpan(positions, indices)).toBeGreaterThan(1e-5);
  });

  it('passes through on invalid granularity and empty meshes', () => {
    const passthrough = subdivideTrianglesMercator(
      [0, 0, 1, 0, 0, 1],
      [0, 1, 2],
      0,
    );
    expect(Array.from(passthrough.indices)).toEqual([0, 1, 2]);
    const empty = subdivideTrianglesMercator([], [], 128);
    expect(empty.positions.length).toBe(0);
    expect(empty.indices.length).toBe(0);
  });

  it('throws on malformed inputs', () => {
    expect(() => subdivideTrianglesMercator([0, 0, 1], [0, 1, 2], 10)).toThrow(
      /even length/,
    );
    expect(() => subdivideTrianglesMercator([0, 0, 1, 1], [0, 1], 10)).toThrow(
      /multiple of 3/,
    );
  });
});

describe('shouldDrawWorldCopy', () => {
  it('skips wrapped copies on globe only', () => {
    expect(shouldDrawWorldCopy(0, true)).toBe(true);
    expect(shouldDrawWorldCopy(1, true)).toBe(false);
    expect(shouldDrawWorldCopy(-1, true)).toBe(false);
    expect(shouldDrawWorldCopy(0, false)).toBe(true);
    expect(shouldDrawWorldCopy(1, false)).toBe(true);
    expect(shouldDrawWorldCopy(-2, false)).toBe(true);
  });
});

describe('granularityForZoom', () => {
  it('uses the host tile expression when present', () => {
    const host = {
      tile: {
        getGranularityForZoomLevel: (z: number) =>
          Math.max(32, Math.floor(128 / 2 ** z)),
      },
    };
    expect(granularityForZoom(host, 0)).toBe(128);
    expect(granularityForZoom(host, 2)).toBe(32);
    expect(granularityForZoom(host, 5)).toBe(32);
  });

  it('hands the host an integer zoom (hosts shift by zoom level)', () => {
    let received = -1;
    const host = {
      tile: {
        getGranularityForZoomLevel: (z: number) => {
          received = z;
          return 99;
        },
      },
    };
    expect(granularityForZoom(host, 3.7)).toBe(99);
    expect(received).toBe(3);
  });

  it('accepts a bare expression object without a .tile field', () => {
    expect(granularityForZoom({ getGranularityForZoomLevel: () => 7 }, 0)).toBe(
      7,
    );
  });

  it('floors and caps host results', () => {
    expect(
      granularityForZoom(
        { tile: { getGranularityForZoomLevel: () => 2.9 } },
        0,
      ),
    ).toBe(2);
    expect(
      granularityForZoom(
        { tile: { getGranularityForZoomLevel: () => 1e9 } },
        0,
      ),
    ).toBe(1024);
  });

  it('falls back to the halving curve when the host is absent', () => {
    // base 128 halved per zoom, clamped at 1.
    expect(granularityForZoom(undefined, 0)).toBe(128);
    expect(granularityForZoom(null, 1)).toBe(64);
    expect(granularityForZoom(undefined, 3)).toBe(16);
    expect(granularityForZoom(undefined, 7)).toBe(1);
    expect(granularityForZoom(undefined, 12)).toBe(1);
  });

  it('falls back when the host throws or returns garbage', () => {
    const throwing = {
      tile: {
        getGranularityForZoomLevel: () => {
          throw new Error('boom');
        },
      },
    };
    expect(granularityForZoom(throwing, 2)).toBe(32);
    for (const bad of [NaN, -5, 0, 'x', undefined]) {
      const host = { tile: { getGranularityForZoomLevel: () => bad } };
      expect(granularityForZoom(host, 1)).toBe(64);
    }
  });

  it('clamps non-finite and negative zooms', () => {
    expect(granularityForZoom(undefined, -3)).toBe(128);
    expect(granularityForZoom(undefined, NaN)).toBe(128);
    expect(granularityForZoom(undefined, 1.9)).toBe(64);
  });
});

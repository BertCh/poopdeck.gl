/**
 * Mercator helpers operate on plain Float64/Float32 buffers and have no GL
 * dependency, so they're testable purely in Node.
 */

import { describe, it, expect } from 'vitest';
import { lngLatToMercator, projectPositions } from '../src/projection';

describe('lngLatToMercator', () => {
  it('sends [-180, 0] to [0, 0.5]', () => {
    const [x, y] = lngLatToMercator(-180, 0);
    expect(x).toBeCloseTo(0, 12);
    expect(y).toBeCloseTo(0.5, 12);
  });

  it('sends [180, 0] to [1, 0.5]', () => {
    const [x, y] = lngLatToMercator(180, 0);
    expect(x).toBeCloseTo(1, 12);
    expect(y).toBeCloseTo(0.5, 12);
  });

  it('sends [0, 0] to [0.5, 0.5]', () => {
    const [x, y] = lngLatToMercator(0, 0);
    expect(x).toBeCloseTo(0.5, 12);
    expect(y).toBeCloseTo(0.5, 12);
  });

  it('sends positive latitude toward 0 (north points up in MapLibre)', () => {
    const [, y] = lngLatToMercator(0, 45);
    expect(y).toBeLessThan(0.5);
    expect(y).toBeGreaterThan(0);
  });

  it('clamps latitudes outside the Web Mercator range', () => {
    const [, yMax] = lngLatToMercator(0, 89);
    const [, yMin] = lngLatToMercator(0, -89);
    // Both should be finite (clamped, not Infinity / NaN) and within
    // a tiny tolerance of the mercator edges [0, 1].
    expect(Number.isFinite(yMax)).toBe(true);
    expect(Number.isFinite(yMin)).toBe(true);
    expect(Math.abs(yMax)).toBeLessThan(1e-10);
    expect(Math.abs(yMin - 1)).toBeLessThan(1e-10);
  });
});

describe('projectPositions', () => {
  it('handles 2D input and emits stride-3 output with z=0', () => {
    const input = new Float64Array([0, 0, 180, 0]);
    const out = projectPositions(input, 2);
    expect(out.length).toBe(6);
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
    expect(out[2]).toBe(0);
    expect(out[3]).toBeCloseTo(1, 6);
    expect(out[4]).toBeCloseTo(0.5, 6);
    expect(out[5]).toBe(0);
  });

  it('handles 3D input and preserves altitude in the z channel', () => {
    const input = new Float64Array([0, 0, 1000, 180, 0, 2000]);
    const out = projectPositions(input, 3);
    expect(out.length).toBe(6);
    expect(out[2]).toBe(1000);
    expect(out[5]).toBe(2000);
  });
});

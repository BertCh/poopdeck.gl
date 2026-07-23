/**
 * Mercator helpers operate on plain Float64/Float32 buffers and have no GL
 * dependency, so they're testable purely in Node.
 */

import { describe, it, expect } from 'vitest';
import {
  lngLatToMercator,
  lngLatToMercatorInto,
  projectPositions,
  quantizePositionsToUint16,
} from '../src/lib/projection';
import { decodeMercatorPosJS } from '../src/shaders/position-quantization.glsl';

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

describe('lngLatToMercatorInto', () => {
  it('writes exactly what the tuple form returns, at any offset', () => {
    // The allocation-free form every per-frame emit loop uses (icon glide,
    // trip-heads). Divergence would move CPU-interpolated geometry off the
    // positions everything else projects to, so the two are pinned together
    // across the range — poles and the clamp included.
    const out = new Float32Array(8);
    const samples: Array<[number, number]> = [
      [0, 0],
      [-180, 0],
      [180, 0],
      [12.5, 45.25],
      [-73.6, -33.4],
      [0, 85.05112877980659],
      [0, 89],
      [0, -95],
    ];
    for (const [lon, lat] of samples) {
      const [x, y] = lngLatToMercator(lon, lat);
      lngLatToMercatorInto(lon, lat, out, 4);
      // Float32 storage, so compare at f32 precision.
      expect(out[4]).toBe(Math.fround(x));
      expect(out[5]).toBe(Math.fround(y));
    }
    // …and it writes ONLY its two slots.
    expect(Array.from(out.subarray(0, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(out.subarray(6))).toEqual([0, 0]);
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

describe('quantizePositionsToUint16 (perf research 2026-07)', () => {
  it('round-trips within quantization error for a realistic tile-local bbox', () => {
    // A dense tile-local cluster (city-block-scale mercator span), the exact
    // case this optimization targets — precision should concentrate here,
    // not be wasted covering the whole world unit square.
    const projected = new Float32Array([
      0.500001, 0.400002, 0, 0.500003, 0.400004, 0, 0.500005, 0.400001, 0,
      0.500002, 0.400005, 0,
    ]);
    const { quantized, scale, offset } = quantizePositionsToUint16(projected);
    expect(quantized.length).toBe(projected.length);
    expect(quantized).toBeInstanceOf(Uint16Array);

    for (let i = 0; i < projected.length / 3; i++) {
      // Simulate the GPU's own normalized-UNSIGNED_SHORT decode (q / 65535),
      // then the shader's sttDecodeMercatorPos.
      const normalized: [number, number, number] = [
        quantized[i * 3] / 65535,
        quantized[i * 3 + 1] / 65535,
        quantized[i * 3 + 2] / 65535,
      ];
      const [x, y, z] = decodeMercatorPosJS(normalized, scale, offset);
      expect(x).toBeCloseTo(projected[i * 3], 6);
      expect(y).toBeCloseTo(projected[i * 3 + 1], 6);
      expect(z).toBeCloseTo(projected[i * 3 + 2], 6);
    }
  });

  it('quantizes to the full [0,65535] range at the bbox extremes', () => {
    const projected = new Float32Array([0.1, 0.2, 10, 0.3, 0.6, 20]);
    const { quantized } = quantizePositionsToUint16(projected);
    // First vertex is the min on every axis, second is the max.
    expect(quantized[0]).toBe(0);
    expect(quantized[1]).toBe(0);
    expect(quantized[2]).toBe(0);
    expect(quantized[3]).toBe(65535);
    expect(quantized[4]).toBe(65535);
    expect(quantized[5]).toBe(65535);
  });

  it('handles a degenerate (zero-range) axis without NaN — scale 0 reconstructs the constant exactly', () => {
    // Every vertex shares the same x; only y and z vary.
    const projected = new Float32Array([0.5, 0.1, 0, 0.5, 0.9, 0]);
    const { quantized, scale, offset } = quantizePositionsToUint16(projected);
    expect(scale[0]).toBe(0);
    expect(offset[0]).toBeCloseTo(0.5, 6);
    expect(Number.isNaN(quantized[0])).toBe(false);

    for (let i = 0; i < 2; i++) {
      const normalized: [number, number, number] = [
        quantized[i * 3] / 65535,
        quantized[i * 3 + 1] / 65535,
        quantized[i * 3 + 2] / 65535,
      ];
      const [x] = decodeMercatorPosJS(normalized, scale, offset);
      expect(x).toBeCloseTo(0.5, 6);
    }
  });

  it('handles an empty buffer without throwing', () => {
    const { quantized, scale, offset } = quantizePositionsToUint16(
      new Float32Array(0),
    );
    expect(quantized.length).toBe(0);
    expect(scale).toEqual([0, 0, 0]);
    expect(offset).toEqual([0, 0, 0]);
  });
});

// @poopdeck.gl/three
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import {
  encodeId,
  decodeId,
  buildIdColors,
  MAX_PICK_ID,
} from '../src/lib/gpu-pick';

describe('encodeId / decodeId', () => {
  it('round-trips small ids', () => {
    for (const i of [0, 1, 2, 7, 255, 256, 257, 65535, 65536]) {
      expect(decodeId(encodeId(i))).toBe(i);
    }
  });

  it('encodes byte channels big-endian (r = high byte)', () => {
    expect(encodeId(0)).toEqual([0, 0, 0]);
    expect(encodeId(1)).toEqual([0, 0, 1]);
    expect(encodeId(255)).toEqual([0, 0, 255]);
    expect(encodeId(256)).toEqual([0, 1, 0]);
    expect(encodeId(0x010203)).toEqual([1, 2, 3]);
    expect(encodeId(MAX_PICK_ID)).toEqual([255, 255, 255]);
  });

  it('round-trips across the 24-bit range (strided + boundaries)', () => {
    const samples = new Set<number>();
    for (let i = 0; i <= MAX_PICK_ID; i += 50021) samples.add(i);
    // include every channel boundary and the extremes
    for (const v of [
      0,
      1,
      255,
      256,
      65535,
      65536,
      MAX_PICK_ID - 1,
      MAX_PICK_ID,
    ]) {
      samples.add(v);
    }
    for (const i of samples) {
      const rgb = encodeId(i);
      expect(rgb[0]).toBeGreaterThanOrEqual(0);
      expect(rgb[0]).toBeLessThanOrEqual(255);
      expect(decodeId(rgb)).toBe(i);
    }
  });

  it('decodeId masks channels to bytes', () => {
    expect(
      decodeId([0x101, 0x102, 0x103] as unknown as [number, number, number]),
    ).toBe(0x010203);
  });

  it('throws on out-of-range ids', () => {
    expect(() => encodeId(-1)).toThrow(RangeError);
    expect(() => encodeId(MAX_PICK_ID + 1)).toThrow(RangeError);
    expect(() => encodeId(1.5)).toThrow(RangeError);
  });
});

describe('buildIdColors', () => {
  it('emits one normalised RGB triple per feature, decodable back to the index', () => {
    const n = 300;
    const colors = buildIdColors(n);
    expect(colors.length).toBe(n * 3);
    for (let i = 0; i < n; i++) {
      const r = Math.round(colors[i * 3] * 255);
      const g = Math.round(colors[i * 3 + 1] * 255);
      const b = Math.round(colors[i * 3 + 2] * 255);
      expect(decodeId([r, g, b])).toBe(i);
    }
  });

  it('returns an empty array for zero features', () => {
    expect(buildIdColors(0).length).toBe(0);
  });
});

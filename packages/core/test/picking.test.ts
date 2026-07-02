// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import {
  MAX_PICK_ID,
  encodePickId,
  decodePickId,
  buildIdColors,
  InstanceProvenance,
} from '../src/render/picking';

describe('pick id 24-bit packing', () => {
  it('round-trips representative + boundary indices', () => {
    for (const i of [0, 1, 255, 256, 65535, 65536, 1_000_000, MAX_PICK_ID]) {
      expect(decodePickId(encodePickId(i))).toBe(i);
    }
  });
  it('is big-endian (r = high byte)', () => {
    expect(encodePickId(0x123456)).toEqual([0x12, 0x34, 0x56]);
  });
  it('throws outside the 24-bit range', () => {
    expect(() => encodePickId(-1)).toThrow(RangeError);
    expect(() => encodePickId(MAX_PICK_ID + 1)).toThrow(RangeError);
    expect(() => encodePickId(1.5)).toThrow(RangeError);
  });
  it('buildIdColors produces normalised triples matching encodePickId', () => {
    const c = buildIdColors(3);
    expect(c.length).toBe(9);
    const [r, g, b] = encodePickId(2);
    expect(c[6]).toBeCloseTo(r / 255);
    expect(c[7]).toBeCloseTo(g / 255);
    expect(c[8]).toBeCloseTo(b / 255);
  });
});

describe('InstanceProvenance (merged-buffer pick identity)', () => {
  it('resolves merged instance index → (tile, feature) in push order', () => {
    const p = new InstanceProvenance();
    p.push('12/1/2/0::points', 5);
    p.push('12/1/2/0::points', 6);
    p.push('12/1/3/0::points', 0);
    expect(p.length).toBe(3);
    expect(p.resolve(0)).toEqual({ tileKey: '12/1/2/0::points', featureIndex: 5 });
    expect(p.resolve(2)).toEqual({ tileKey: '12/1/3/0::points', featureIndex: 0 });
    expect(p.resolve(3)).toBeNull();
  });
});

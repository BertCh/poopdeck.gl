/**
 * v4 directory codec (TypeScript): round-trip + bounds validation.
 *
 * The production writer is Rust; `encodeDirectory` exists for tests/tooling.
 * These tests pin the TS encode↔decode round-trip and the bounds checks that
 * stop an out-of-range value silently truncating on the Rust (`as u32`) side.
 */

import { describe, it, expect } from 'vitest';
import { encodeDirectory, decodeDirectory, type DirectoryEncodeEntry } from '../src/directory';

const base: DirectoryEncodeEntry = {
  zoom: 5,
  x: 1,
  y: 2,
  timeStart: 0,
  timeEnd: 0,
  offset: 0,
  length: 0,
  uncompressedSize: 0,
  featureCount: 0,
};

describe('v4 directory codec (TS)', () => {
  it('round-trips entries including the temporal bucket', () => {
    const entries: DirectoryEncodeEntry[] = [
      {
        zoom: 5, x: 1, y: 2, timeStart: 0, timeEnd: 100,
        offset: 64, length: 10, uncompressedSize: 20, featureCount: 3,
        hilbert: 1, crc32c: 7, temporalBucketMs: 3_600_000,
      },
      {
        zoom: 5, x: 1, y: 2, timeStart: 100, timeEnd: 200,
        offset: 74, length: 10, uncompressedSize: 20, featureCount: 4,
        hilbert: 1, crc32c: 8,
      },
    ];
    const back = decodeDirectory(encodeDirectory(entries));
    expect(back.length).toBe(2);
    expect(back[0]).toMatchObject({
      zoom: 5, x: 1, y: 2, timeStart: 0, timeEnd: 100, featureCount: 3,
      temporalBucketMs: 3_600_000,
    });
    expect(back[1].temporalBucketMs).toBeUndefined();
  });

  it('collapses identical-across-time blobs into one run', () => {
    const entries: DirectoryEncodeEntry[] = [0, 1, 2, 3].map((b) => ({
      ...base,
      zoom: 9, x: 3, y: 4, hilbert: 7,
      timeStart: b * 3_600_000, timeEnd: b * 3_600_000 + 1,
      offset: 4096, length: 512, uncompressedSize: 1024, featureCount: 8, crc32c: 0xabcd,
      temporalBucketMs: 3_600_000,
    }));
    const back = decodeDirectory(encodeDirectory(entries));
    expect(back.length).toBe(4);
    // All four share the one deduped blob offset.
    expect(new Set(back.map((e) => e.offset)).size).toBe(1);
    expect(back.map((e) => e.timeStart)).toEqual([0, 3_600_000, 7_200_000, 10_800_000]);
  });

  it('rejects out-of-range coordinates', () => {
    expect(() => encodeDirectory([{ ...base, zoom: 300 }])).toThrow(/zoom/);
    expect(() => encodeDirectory([{ ...base, x: 2 ** 33 }])).toThrow(/x /);
    expect(() => encodeDirectory([{ ...base, y: 2 ** 33 }])).toThrow(/y /);
    expect(() => encodeDirectory([{ ...base, featureCount: 2 ** 33 }])).toThrow(/featureCount/);
  });

  it('rejects a wrong directory version on decode', () => {
    const bytes = encodeDirectory([base]);
    bytes[0] = 9;
    expect(() => decodeDirectory(bytes)).toThrow(/version/);
  });
});

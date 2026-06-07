/**
 * Directory codec (TypeScript): round-trip + bounds validation.
 *
 * The production writer is Rust; `encodeDirectory` exists for tests/tooling.
 * The TS encoder emits v5 (per-run pack_id + pack-relative offsets); the
 * decoder reads both v4 (single-file, one implicit pack) and v5. These tests
 * pin the encode↔decode round-trip, the pack-id column, and the bounds checks
 * that stop an out-of-range value silently truncating on the Rust (`as u32`)
 * side.
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

describe('directory codec (TS)', () => {
  it('defaults packId to 0 and emits a v5 directory', () => {
    const bytes = encodeDirectory([base]);
    expect(bytes[0]).toBe(5); // DIRECTORY_VERSION
    expect(decodeDirectory(bytes)[0].packId).toBe(0);
  });

  it('round-trips entries across multiple packs with pack-relative offsets', () => {
    // Three packs, each with two distinct contiguous blobs starting at offset 0.
    const entries: DirectoryEncodeEntry[] = [];
    for (let p = 0; p < 3; p++) {
      let off = 0;
      for (let i = 0; i < 2; i++) {
        const len = 40 + i;
        entries.push({
          ...base,
          zoom: 9,
          x: p * 10 + i,
          y: 0,
          hilbert: p * 100 + i, // monotone in directory order
          timeStart: i * 1000,
          timeEnd: i * 1000 + 500,
          packId: p,
          offset: off,
          length: len,
          uncompressedSize: len * 2,
          featureCount: i,
          crc32c: 0x2000 + p * 100 + i,
        });
        off += len;
      }
    }
    const back = decodeDirectory(encodeDirectory(entries));
    expect(new Set(back.map((e) => e.packId))).toEqual(new Set([0, 1, 2]));
    // Each pack's first blob sits at offset 0 (pack-relative reset).
    for (const p of [0, 1, 2]) {
      expect(back.some((e) => e.packId === p && e.offset === 0)).toBe(true);
    }
    // Byte-for-byte the packId/offset/length survive.
    for (const e of entries) {
      const got = back.find((b) => b.x === e.x && b.timeStart === e.timeStart)!;
      expect(got.packId).toBe(e.packId);
      expect(got.offset).toBe(e.offset);
      expect(got.length).toBe(e.length);
    }
  });

  it('does NOT RLE-collapse byte-identical blobs in different packs', () => {
    // Same blob fields, different packs → must stay two distinct entries each
    // addressing its own pack (pack_id is part of the run identity).
    const shared = {
      ...base, zoom: 9, y: 0, hilbert: 0,
      timeStart: 0, timeEnd: 1, offset: 0, length: 50, uncompressedSize: 100,
      featureCount: 1, crc32c: 0x1234,
    };
    const back = decodeDirectory(
      encodeDirectory([
        { ...shared, x: 1, packId: 0 },
        { ...shared, x: 2, packId: 1 },
      ]),
    );
    expect(back.map((e) => e.packId).sort()).toEqual([0, 1]);
    expect(back.every((e) => e.offset === 0)).toBe(true);
  });

  it('decodes a legacy v4 directory (no pack_id column) as packId 0', () => {
    // Hand-craft a v4 buffer: version byte 4, then the v4 per-run columns
    // (run_len, offset flag, length, uncompressed, crc) with NO pack_id column.
    const buf: number[] = [];
    const putU = (v: number) => {
      for (;;) {
        const b = v & 0x7f;
        v >>>= 7;
        if (v !== 0) buf.push(b | 0x80);
        else { buf.push(b); break; }
      }
    };
    const putI = (v: number) => putU(v < 0 ? -v * 2 - 1 : v * 2); // zig-zag
    buf.push(4); // DIRECTORY_VERSION = 4
    putU(1); // N
    putU(1); // R
    // one entry's key columns: Δzoom Δhilbert Δx Δy Δtime_start (zig-zag),
    // duration (zig-zag), feature_count (uvarint), bucket-flag (0)
    putI(7); putI(0); putI(3); putI(4); putI(1000);
    putI(500); putU(2); putU(0);
    // v4 per-run columns: run_len, offset flag (0 = contiguous from 0), length,
    // uncompressed, crc (4 LE bytes). NO pack_id column.
    putU(1); putU(0); putU(64); putU(128);
    buf.push(0xef, 0xbe, 0xad, 0xde);
    const back = decodeDirectory(Uint8Array.from(buf));
    expect(back.length).toBe(1);
    expect(back[0]).toMatchObject({ zoom: 7, x: 3, y: 4, timeStart: 1000, timeEnd: 1500, packId: 0, offset: 0, length: 64 });
  });

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

  it('round-trips the optional covering section (coverTMin), incl. a value before the bucket', () => {
    const entries: DirectoryEncodeEntry[] = [0, 1, 2].map((b) => ({
      ...base,
      zoom: 7, x: 2, y: 3, hilbert: b,
      timeStart: b * 1000, timeEnd: b * 1000 + 900,
      offset: 64 + b * 50, length: 50, uncompressedSize: 100, featureCount: b + 1, crc32c: b,
      // entry 0's earliest feature starts 200ms BEFORE its bucket edge.
      coverTMin: b === 0 ? -200 : b * 1000 + 300,
    }));
    const back = decodeDirectory(encodeDirectory(entries));
    expect(back.map((e) => e.coverTMin)).toEqual([-200, 1300, 2300]);
  });

  it('omits the covering section when no entry carries coverTMin (backward compatible)', () => {
    // Without coverTMin the buffer must be byte-identical to the pre-covering
    // codec, and decode leaves coverTMin undefined.
    const withCover = encodeDirectory([{ ...base, coverTMin: 5 }]);
    const without = encodeDirectory([base]);
    expect(without.length).toBeLessThan(withCover.length);
    expect(decodeDirectory(without)[0].coverTMin).toBeUndefined();
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

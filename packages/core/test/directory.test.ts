/**
 * Directory codec (TypeScript): round-trip + bounds validation.
 *
 * The production writer is Rust; `encodeDirectory` exists for tests/tooling.
 * The TS encoder and decoder implement only v6. These tests
 * pin the encode↔decode round-trip, the pack-id column, and the bounds checks
 * that stop an out-of-range value silently truncating on the Rust (`as u32`)
 * side.
 */

import { describe, it, expect } from 'vitest';
import {
  encodeDirectory,
  decodeDirectory,
  decodePagedRoot,
  type DirectoryEncodeEntry,
} from '../src/directory';

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
  it('defaults packId/variantId to raw and emits a v6 directory', () => {
    const bytes = encodeDirectory([base]);
    expect(bytes[0]).toBe(6); // DIRECTORY_VERSION
    expect(decodeDirectory(bytes)[0].packId).toBe(0);
    expect(decodeDirectory(bytes)[0].variantId).toBe(0);
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
      ...base,
      zoom: 9,
      y: 0,
      hilbert: 0,
      timeStart: 0,
      timeEnd: 1,
      offset: 0,
      length: 50,
      uncompressedSize: 100,
      featureCount: 1,
      crc32c: 0x1234,
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

  it('rejects a retired v4 (single-file) directory — the client is packed-only', () => {
    // A v4 buffer starts with version byte 4 (no pack_id column). The client
    // only reads packed v5 directories, so v4 must be rejected up front rather
    // than mis-decoded. The version check is the first thing decodeDirectory
    // does, so the version byte alone is enough to trigger it.
    expect(() => decodeDirectory(Uint8Array.from([4, 0, 0]))).toThrow(
      /unsupported version/i,
    );
  });

  it('round-trips entries including the temporal bucket', () => {
    const entries: DirectoryEncodeEntry[] = [
      {
        zoom: 5,
        x: 1,
        y: 2,
        timeStart: 0,
        timeEnd: 100,
        offset: 64,
        length: 10,
        uncompressedSize: 20,
        featureCount: 3,
        hilbert: 1,
        crc32c: 7,
        temporalBucketMs: 3_600_000,
      },
      {
        zoom: 5,
        x: 1,
        y: 2,
        timeStart: 100,
        timeEnd: 200,
        offset: 74,
        length: 10,
        uncompressedSize: 20,
        featureCount: 4,
        hilbert: 1,
        crc32c: 8,
      },
    ];
    const back = decodeDirectory(encodeDirectory(entries));
    expect(back.length).toBe(2);
    expect(back[0]).toMatchObject({
      zoom: 5,
      x: 1,
      y: 2,
      timeStart: 0,
      timeEnd: 100,
      featureCount: 3,
      temporalBucketMs: 3_600_000,
    });
    expect(back[1].temporalBucketMs).toBeUndefined();
  });

  it('collapses identical-across-time blobs into one run', () => {
    const entries: DirectoryEncodeEntry[] = [0, 1, 2, 3].map((b) => ({
      ...base,
      zoom: 9,
      x: 3,
      y: 4,
      hilbert: 7,
      timeStart: b * 3_600_000,
      timeEnd: b * 3_600_000 + 1,
      offset: 4096,
      length: 512,
      uncompressedSize: 1024,
      featureCount: 8,
      crc32c: 0xabcd,
      temporalBucketMs: 3_600_000,
    }));
    const back = decodeDirectory(encodeDirectory(entries));
    expect(back.length).toBe(4);
    // All four share the one deduped blob offset.
    expect(new Set(back.map((e) => e.offset)).size).toBe(1);
    expect(back.map((e) => e.timeStart)).toEqual([
      0, 3_600_000, 7_200_000, 10_800_000,
    ]);
  });

  it('round-trips the optional covering section (coverTMin), incl. a value before the bucket', () => {
    const entries: DirectoryEncodeEntry[] = [0, 1, 2].map((b) => ({
      ...base,
      zoom: 7,
      x: 2,
      y: 3,
      hilbert: b,
      timeStart: b * 1000,
      timeEnd: b * 1000 + 900,
      offset: 64 + b * 50,
      length: 50,
      uncompressedSize: 100,
      featureCount: b + 1,
      crc32c: b,
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
    expect(() => encodeDirectory([{ ...base, featureCount: 2 ** 33 }])).toThrow(
      /featureCount/,
    );
  });

  it('rejects a wrong directory version on decode', () => {
    const bytes = encodeDirectory([base]);
    bytes[0] = 9;
    expect(() => decodeDirectory(bytes)).toThrow(/version/);
  });
});

describe('decodeDirectory corruption guards', () => {
  it('rejects an empty buffer', () => {
    expect(() => decodeDirectory(new Uint8Array(0))).toThrow(/empty buffer/);
  });

  it('rejects a varint that runs off the end of the buffer', () => {
    // Version byte 6, then a single 0x80 (continuation bit set, no following
    // byte) — the first uvarint read (entry count N) walks past the end.
    expect(() => decodeDirectory(Uint8Array.from([6, 0x80]))).toThrow(
      /truncated varint/,
    );
  });

  it('rejects a run whose run_length exceeds the entry count', () => {
    // n=1, runCount=1, one all-zero entry (6 ivarints + featureCount +
    // bucketPresent + variantId = 9 zero bytes), then a run declaring run_length=2.
    const bytes = Uint8Array.from([
      6, // version
      1, // n = 1
      1, // runCount = 1
      0,
      0,
      0,
      0,
      0,
      0, // Δzoom Δhilbert Δx Δy Δtime duration (all 0)
      0, // featureCount = 0
      0, // bucketPresent = 0
      0, // variantId = raw
      2, // run_length = 2  (> n)
      0, // Δpack_id = 0
      0, // offset flag = 0 (contiguous)
      0, // length = 0
      0, // uncompressed_size = 0
      0,
      0,
      0,
      0, // crc32c u32
    ]);
    expect(() => decodeDirectory(bytes)).toThrow(
      /run length exceeds entry count/,
    );
  });

  it('rejects when the runs cover fewer entries than declared', () => {
    // n=2 but the single run only covers run_length=1 entry → cursor (1) != n.
    const bytes = Uint8Array.from([
      6, // version
      2, // n = 2
      1, // runCount = 1
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0, // entry 0 (9 zero bytes)
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0, // entry 1 (9 zero bytes)
      1, // run_length = 1  (covers only entry 0)
      0, // Δpack_id = 0
      0, // offset flag = 0
      0, // length = 0
      0, // uncompressed_size = 0
      0,
      0,
      0,
      0, // crc32c u32
    ]);
    expect(() => decodeDirectory(bytes)).toThrow(
      /runs covered 1 entries, expected 2/,
    );
  });
});

describe('decodePagedRoot error branches', () => {
  /** A minimal 12-byte root header (version, kind, reserved u16, pageCount, pageEntries). */
  function rootHeader(
    version: number,
    kind: number,
    pageCount: number,
  ): Uint8Array {
    const bytes = new Uint8Array(12);
    const dv = new DataView(bytes.buffer);
    dv.setUint8(0, version);
    dv.setUint8(1, kind);
    dv.setUint32(4, pageCount, true);
    return bytes;
  }

  it('rejects a buffer shorter than the fixed root header', () => {
    expect(() => decodePagedRoot(new Uint8Array(8))).toThrow(
      /truncated header/,
    );
  });

  it('rejects an unsupported root version', () => {
    expect(() => decodePagedRoot(rootHeader(2, 0, 0))).toThrow(
      /unsupported version 2/,
    );
  });

  it('rejects an unsupported descriptor kind', () => {
    expect(() => decodePagedRoot(rootHeader(1, 7, 0))).toThrow(
      /unsupported descriptor kind 7/,
    );
  });

  it('rejects a header that claims more pages than the buffer can hold', () => {
    // pageCount=3 needs 12 + 3*52 = 168 bytes, but only the 12-byte header exists.
    expect(() => decodePagedRoot(rootHeader(1, 0, 3))).toThrow(
      /truncated \(12 B, need 168 for 3 pages\)/,
    );
  });

  it('rejects non-zero reserved root bytes and trailing data', () => {
    const reserved = rootHeader(1, 0, 0);
    new DataView(reserved.buffer).setUint16(2, 1, true);
    expect(() => decodePagedRoot(reserved)).toThrow(
      /reserved header bytes must be zero/,
    );

    const trailing = new Uint8Array(13);
    trailing.set(rootHeader(1, 0, 0));
    expect(() => decodePagedRoot(trailing)).toThrow(/trailing bytes/);
  });

  it('rejects descriptor offsets outside the safe integer range', () => {
    const root = new Uint8Array(12 + 52);
    const dv = new DataView(root.buffer);
    dv.setUint8(0, 1);
    dv.setUint32(4, 1, true);
    dv.setUint32(8, 1, true);
    dv.setBigUint64(12, 1n << 53n, true);
    dv.setUint32(20, 1, true);
    dv.setUint32(24, 1, true);
    expect(() => decodePagedRoot(root)).toThrow(/safe integer range/);
  });

  it('checks root bookkeeping against the manifest', () => {
    expect(() =>
      decodePagedRoot(rootHeader(1, 0, 0), { pageCount: 1 }),
    ).toThrow(/page count 0 disagrees with manifest 1/);
  });
});

// ── H2 (core hot-spot audit 2026-08): varints decode as Numbers below 2^53 ──
//
// The per-leaf decode loop accumulated every varint as a BigInt (~42 ns each
// vs ~6 ns as a Number — a third of a 4,096-entry leaf's ~4.9 ms, on the main
// thread, 4–8 leaves per pan). Every field the reader surfaces is narrowed to
// a safe integer anyway, so a Number fast path is exact wherever the old path
// could succeed; a value at or beyond 2^53 is re-read exactly as a BigInt so
// the rejection message still carries the true value. These pin the edges;
// the oracle comparison + fuzz live in `core-hotspots-audit-2026-08.test.ts`.
describe('H2: varint Number fast path', () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  /** Every LEB128 byte-length boundary, the 2^32 / 2^49 / 2^52 edges, and 2^53−1. */
  const EDGES = [
    0,
    1,
    127,
    128,
    16383,
    16384,
    2 ** 21 - 1,
    2 ** 21,
    2 ** 28 - 1,
    2 ** 28,
    2 ** 32 - 1,
    2 ** 32,
    2 ** 35 - 1,
    2 ** 35,
    2 ** 42 - 1,
    2 ** 42,
    2 ** 49 - 1,
    2 ** 49,
    2 ** 52 - 1,
    2 ** 52,
    MAX,
  ];

  it('round-trips every byte-length boundary and both signs up to ±(2^53−1) exactly', () => {
    const entries: DirectoryEncodeEntry[] = EDGES.map((v, i) => {
      const signed = i % 2 ? -v : v;
      return {
        ...base,
        zoom: 7,
        hilbert: i, // keeps encode order == EDGES order
        x: i,
        timeStart: signed,
        // A short positive duration where it stays safe; +MAX itself cannot grow.
        timeEnd: signed < 0 ? signed + (i % 3) : signed,
        packId: i,
        offset: v,
        // The run's ENDING offset is range-checked too, so nothing may follow MAX.
        length: v === MAX ? 0 : 1 + (i % 5),
        uncompressedSize: v,
        featureCount: v % 2 ** 32,
        temporalBucketMs: v,
        coverTMin: 0, // cover delta = −timeStart: a full-width signed varint
        crc32c: 0,
      };
    });
    const back = decodeDirectory(encodeDirectory(entries));
    expect(back.length).toBe(EDGES.length);
    EDGES.forEach((v, i) => {
      const signed = i % 2 ? -v : v;
      const e = back[i];
      expect(e.timeStart).toBe(signed);
      expect(e.timeEnd).toBe(signed < 0 ? signed + (i % 3) : signed);
      expect(e.offset).toBe(v);
      expect(e.uncompressedSize).toBe(v);
      expect(e.featureCount).toBe(v % 2 ** 32);
      expect(e.temporalBucketMs).toBe(v);
      expect(e.coverTMin).toBe(0);
      expect(e.packId).toBe(i);
    });
    // Consecutive entries at −MAX then +MAX: a Δtime of 2·MAX, whose zig-zag
    // is ~2^55 — beyond the fast path, so the exact fallback must carry it.
    const swing = decodeDirectory(
      encodeDirectory([
        { ...base, hilbert: 0, timeStart: -MAX, timeEnd: MAX, crc32c: 0 },
        { ...base, hilbert: 1, timeStart: MAX, timeEnd: MAX, crc32c: 0 },
      ]),
    );
    expect(swing.map((e) => [e.timeStart, e.timeEnd])).toEqual([
      [-MAX, MAX],
      [MAX, MAX],
    ]);
  });

  /** A one-entry, one-run v6 directory with `offset` given as raw LEB128 bytes. */
  function withOffsetBytes(offset: number[]): Uint8Array {
    return Uint8Array.from([
      6, // version
      1, // n
      1, // runs
      0,
      0,
      0,
      0,
      0,
      0, // Δzoom Δhilbert Δx Δy Δtime duration
      0, // featureCount
      0, // bucketPresent
      0, // variantId
      1, // run length
      0, // Δpack_id
      1, // offset flag: explicit
      ...offset,
      0, // length
      0, // uncompressed_size
      0,
      0,
      0,
      0, // crc32c
    ]);
  }

  it('rejects a surfaced value at exactly 2^53 with the incumbent message carrying the EXACT value', () => {
    // 2^53 = 0x20000000000000 → LEB128: seven 0x80 continuation bytes then 0x10.
    const twoPow53 = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10];
    expect(() => decodeDirectory(withOffsetBytes(twoPow53))).toThrow(
      /run 0 offset 9007199254740992 is outside JavaScript's safe integer range/,
    );
    // …while one less decodes on the fast path.
    const maxSafe = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f];
    expect(decodeDirectory(withOffsetBytes(maxSafe))[0].offset).toBe(MAX);
    // u64::MAX (ten bytes) is still a well-formed varint the reader rejects
    // on range, exactly; an eleventh byte is rejected on width.
    const u64Max = [...new Array(9).fill(0xff), 0x01];
    expect(() => decodeDirectory(withOffsetBytes(u64Max))).toThrow(
      /run 0 offset 18446744073709551615 is outside/,
    );
    expect(() =>
      decodeDirectory(withOffsetBytes([...new Array(10).fill(0xff), 0x01])),
    ).toThrow(/varint exceeds 64 bits/);
  });

  it('consumes a full-width Hilbert delta without surfacing or rejecting it', () => {
    // The Hilbert column is read only to stay aligned (the reader addresses
    // by z/x/y/t), so a 60-bit key — legal at zoom 30 — must pass untouched.
    const bytes = Uint8Array.from([
      6,
      1,
      1,
      0, // Δzoom
      ...new Array(8).fill(0xff),
      0x0f, // Δhilbert = 2^60 − 1 (zig-zag raw)
      0,
      0,
      0,
      0, // Δx Δy Δtime duration
      0,
      0,
      0, // featureCount bucketPresent variantId
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0, // one run, contiguous
    ]);
    const [e] = decodeDirectory(bytes);
    expect(e).toMatchObject({ zoom: 0, x: 0, y: 0, timeStart: 0, offset: 0 });
  });
});

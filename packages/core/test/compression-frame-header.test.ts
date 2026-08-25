/**
 * Audit D1 (tile-loading audit 2026-08): reader-side single-segment header
 * synthesis for zstd frames.
 *
 * Every fleet frame is `Single_Segment=0`, no content size, 8 MiB window, so
 * fzstd allocated and `copyWithin`'d 8 MiB per block regardless of payload.
 * `unzstdSync` now hands fzstd a rewritten header sized to the directory's
 * `expectedSize`. The fleet cases below run on REAL pack frames from the
 * showcase data staging tree and skip when it is absent (it is git-ignored);
 * the header-layout cases are self-contained.
 */

import {
  existsSync,
  openSync,
  readSync,
  readdirSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  MAX_DECOMPRESSED_BYTES,
  synthesizeSingleSegmentFrame,
  unzstdSync,
  zstdHeaderRewriteStats,
} from '../src/compression';

const DATA_ROOT = fileURLToPath(
  new URL('../../../examples/showcase/public/data/', import.meta.url),
);
const ARCHIVES = ['earthquakes', 'gtfs-ch', 'satellites'] as const;
const FRAMES_PER_ARCHIVE = 3;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

interface FleetFrame {
  archive: string;
  frame: Uint8Array;
  /** Decoded via the unmodified (size-less, pass-through) path. */
  expected: Uint8Array;
}

function isMagicAt(buf: Uint8Array, i: number): boolean {
  return (
    buf[i] === ZSTD_MAGIC[0] &&
    buf[i + 1] === ZSTD_MAGIC[1] &&
    buf[i + 2] === ZSTD_MAGIC[2] &&
    buf[i + 3] === ZSTD_MAGIC[3]
  );
}

/**
 * Pull the first N decodable `ss=0 / fcf=0 / df=0` frames out of the head of
 * an archive's first pack. Frames are located by magic scan and cut at the
 * next magic; a slice that is not a lone frame (a `none` blob follows it, or
 * the magic occurred inside compressed bytes) fails the pass-through decode
 * and is skipped.
 */
function loadFleetFrames(archive: string, want: number): FleetFrame[] {
  const dir = join(DATA_ROOT, archive, 'packs');
  if (!existsSync(dir)) return [];
  const pack = readdirSync(dir)
    .filter((f) => f.endsWith('.sttp'))
    .sort()[0];
  if (!pack) return [];
  const fd = openSync(join(dir, pack), 'r');
  const head = new Uint8Array(4 * 1024 * 1024);
  const n = readSync(fd, head, 0, head.length, 0);
  closeSync(fd);
  const buf = head.subarray(0, n);

  const starts: number[] = [];
  for (let i = 0; i + 4 < buf.length; i++) {
    if (isMagicAt(buf, i)) starts.push(i);
  }
  const out: FleetFrame[] = [];
  for (let k = 0; k + 1 < starts.length && out.length < want; k++) {
    const frame = buf.slice(starts[k], starts[k + 1]);
    const fhd = frame[4];
    if ((fhd >> 5) & 1 || fhd >> 6 || fhd & 3) continue;
    try {
      out.push({ archive, frame, expected: unzstdSync(frame) });
    } catch {
      // not a lone frame
    }
  }
  return out;
}

const fleet = ARCHIVES.map((a) => loadFleetFrames(a, FRAMES_PER_ARCHIVE));
const fleetAvailable = fleet.every((f) => f.length === FRAMES_PER_ARCHIVE);

function makeFrame(fhd: number, wd: number, body: number[]): Uint8Array {
  return new Uint8Array([...ZSTD_MAGIC, fhd, wd, ...body]);
}
/** Window_Descriptor for 8 MiB (exponent 13, mantissa 0) — the fleet's. */
const WD_8MIB = 13 << 3;

describe('D1: synthesizeSingleSegmentFrame header layout (RFC 8878 §3.1.1.1)', () => {
  const body = [0x01, 0x00, 0x00, 0xaa, 0xbb];

  it('D1: writes the smallest FCS field for contentSize + 1 (1/2/4 bytes, −256 bias)', () => {
    // contentSize 254 → FCS 255 → 1 byte.
    let out = synthesizeSingleSegmentFrame(
      makeFrame(0x00, WD_8MIB, body),
      254,
    )!;
    expect(Array.from(out.subarray(0, 4))).toEqual(ZSTD_MAGIC);
    expect(out[4]).toBe(0x20);
    expect(out[5]).toBe(255);
    expect(Array.from(out.subarray(6))).toEqual(body);

    // contentSize 255 → FCS 256 → 2 bytes, stored as 256 − 256 = 0.
    out = synthesizeSingleSegmentFrame(makeFrame(0x00, WD_8MIB, body), 255)!;
    expect(out[4]).toBe(0x20 | (1 << 6));
    expect(Array.from(out.subarray(5, 7))).toEqual([0, 0]);
    expect(Array.from(out.subarray(7))).toEqual(body);

    // contentSize 65790 → FCS 65791 → top of the 2-byte range (0xffff).
    out = synthesizeSingleSegmentFrame(makeFrame(0x00, WD_8MIB, body), 65790)!;
    expect(out[4]).toBe(0x20 | (1 << 6));
    expect(Array.from(out.subarray(5, 7))).toEqual([0xff, 0xff]);

    // contentSize 65791 → FCS 65792 → 4 bytes little-endian.
    out = synthesizeSingleSegmentFrame(makeFrame(0x00, WD_8MIB, body), 65791)!;
    expect(out[4]).toBe(0x20 | (2 << 6));
    expect(Array.from(out.subarray(5, 9))).toEqual([0x00, 0x01, 0x01, 0x00]);
    expect(Array.from(out.subarray(9))).toEqual(body);
  });

  it('D1: preserves the Content_Checksum flag and the reserved/unused bits', () => {
    const out = synthesizeSingleSegmentFrame(
      makeFrame(0x04 | 0x10, WD_8MIB, body),
      10,
    )!;
    expect(out[4]).toBe(0x20 | 0x04 | 0x10);
  });

  it('D1: passes through frames it must not touch', () => {
    // Already single-segment (with its 1-byte FCS in place of the WD).
    expect(
      synthesizeSingleSegmentFrame(makeFrame(0x20, 0x0b, body), 10),
    ).toBeNull();
    // Carries a Frame_Content_Size already.
    expect(
      synthesizeSingleSegmentFrame(makeFrame(0x40, WD_8MIB, body), 10),
    ).toBeNull();
    // Dictionary id present — the window must stay as declared.
    expect(
      synthesizeSingleSegmentFrame(makeFrame(0x01, WD_8MIB, body), 10),
    ).toBeNull();
    // Declared window no larger than the one we would synthesize: no win.
    expect(
      synthesizeSingleSegmentFrame(makeFrame(0x00, 0x00, body), 1023),
    ).toBeNull();
    expect(
      synthesizeSingleSegmentFrame(makeFrame(0x00, 0x00, body), 1022),
    ).not.toBeNull();
    // Not a zstd frame / too short for a header.
    expect(
      synthesizeSingleSegmentFrame(new Uint8Array([1, 2, 3, 4, 5, 6]), 10),
    ).toBeNull();
    expect(
      synthesizeSingleSegmentFrame(new Uint8Array(ZSTD_MAGIC), 10),
    ).toBeNull();
  });

  it('D1: unzstdSync only rewrites for an exact positive size within the ceiling', () => {
    // A valid empty frame: one last raw block of size 0.
    const frame = makeFrame(0x00, WD_8MIB, [0x01, 0x00, 0x00]);
    const before = zstdHeaderRewriteStats.rewritten;
    for (const size of [
      undefined,
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      MAX_DECOMPRESSED_BYTES + 1,
    ]) {
      expect(unzstdSync(frame, size).length).toBe(0);
    }
    expect(zstdHeaderRewriteStats.rewritten).toBe(before);
    expect(unzstdSync(frame, 1).length).toBe(0);
    expect(zstdHeaderRewriteStats.rewritten).toBe(before + 1);
  });
});

describe.skipIf(!fleetAvailable)(
  'D1: real fleet frames (earthquakes, gtfs-ch, satellites)',
  () => {
    const frames = fleet.flat();

    it('D1: every fleet frame is ss=0 / fcf=0 / df=0 with an 8 MiB window (the finding)', () => {
      for (const { frame } of frames) {
        expect(frame[4]).toBe(0x00);
        expect(frame[5]).toBe(WD_8MIB);
      }
    });

    it('D1: rewritten decode is byte-identical to the pass-through decode', () => {
      for (const { archive, frame, expected } of frames) {
        const rewritten = zstdHeaderRewriteStats.rewritten;
        const fallbacks = zstdHeaderRewriteStats.fallbacks;
        const out = unzstdSync(frame, expected.length);
        expect([archive, out.length, Buffer.compare(out, expected)]).toEqual([
          archive,
          expected.length,
          0,
        ]);
        expect(zstdHeaderRewriteStats.rewritten).toBe(rewritten + 1);
        expect(zstdHeaderRewriteStats.fallbacks).toBe(fallbacks);
      }
    });

    it('D1: an already-single-segment frame passes through unchanged', () => {
      for (const { frame, expected } of frames) {
        const ss1 = synthesizeSingleSegmentFrame(frame, expected.length)!;
        expect(ss1[4] & 0x20).toBe(0x20);
        expect(synthesizeSingleSegmentFrame(ss1, expected.length)).toBeNull();
        const rewritten = zstdHeaderRewriteStats.rewritten;
        const out = unzstdSync(ss1, expected.length);
        expect(Buffer.compare(out, expected)).toBe(0);
        expect(zstdHeaderRewriteStats.rewritten).toBe(rewritten);
      }
    });

    it('D1: an expectedSize under-declared by 1 still fails the length check', () => {
      // fzstd clamps a block to its window-derived buffer instead of throwing,
      // so with an EXACT FCS this would hand back `size − 1` garbled bytes; the
      // one-byte slack in the synthesized header is what keeps the cap firing.
      for (const { frame, expected } of frames) {
        expect(() => unzstdSync(frame, expected.length - 1)).toThrow(
          /decompression bomb|exceeds/i,
        );
      }
    });

    it('D1: the fallback counter increments when the rewritten decode fails', () => {
      const { frame, expected } = frames[0];
      // Under-declared: the rewritten decode trips the cap → fall back → the
      // original bytes trip it too, and that error is the one surfaced.
      let fallbacks = zstdHeaderRewriteStats.fallbacks;
      expect(() => unzstdSync(frame, expected.length - 1)).toThrow(/exceeds/);
      expect(zstdHeaderRewriteStats.fallbacks).toBe(fallbacks + 1);
      // Over-declared: the rewritten decode returns the true (shorter) length →
      // fall back → the original bytes decode fine and are returned as-is for
      // the caller's own length check to reject.
      fallbacks = zstdHeaderRewriteStats.fallbacks;
      const out = unzstdSync(frame, expected.length + 1);
      expect(Buffer.compare(out, expected)).toBe(0);
      expect(zstdHeaderRewriteStats.fallbacks).toBe(fallbacks + 1);
    });

    it.skipIf(!!process.env.CI)(
      'D1: rewritten decode is ≥ 3× faster than the 8 MiB-window decode',
      () => {
        const ITERS = 200;
        const time = (fn: () => void): number => {
          for (let i = 0; i < 20; i++) fn();
          const t0 = performance.now();
          for (let i = 0; i < ITERS; i++) fn();
          return ((performance.now() - t0) / ITERS) * 1000; // µs per frame
        };
        const report: string[] = [];
        let earthquakesRatio = 0;
        for (const group of fleet) {
          const { archive, frame, expected } = group[0];
          const before = time(() => unzstdSync(frame));
          const after = time(() => unzstdSync(frame, expected.length));
          report.push(
            `${archive}: ${frame.length} B → ${expected.length} B; ` +
              `${before.toFixed(1)} µs → ${after.toFixed(1)} µs (${(before / after).toFixed(1)}×)`,
          );
          if (archive === 'earthquakes') earthquakesRatio = before / after;
        }
        console.log(
          `D1 decode timing (${ITERS} iters):\n  ${report.join('\n  ')}`,
        );
        expect(earthquakesRatio).toBeGreaterThanOrEqual(3);
      },
    );
  },
);

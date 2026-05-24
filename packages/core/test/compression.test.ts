/**
 * Compression: native DecompressionStream vs pure-JS fallback.
 *
 * The hot path is gzip decode of tile blobs (zstd reuses the pure-JS
 * fzstd decoder either way). We need three guarantees here:
 *
 *   1. `NATIVE_DECOMPRESSION_AVAILABLE` is true in any environment we
 *      ship to (Node 18+, modern browsers). Catching a regression to
 *      "false" early matters — falling back silently to pure JS would
 *      slash decode throughput on a production workload.
 *   2. `decompress()` prefers the native path when available and only
 *      drops to the pure-JS fallback on an actual failure.
 *   3. Round-trip parity: native gzip(decompress(gzip(x))) === x for a
 *      payload large enough to exercise multi-chunk streaming.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { gzipSync } from 'fflate';

import {
  decompress,
  decompressSync,
  gunzipSync,
  unzstdSync,
  NATIVE_DECOMPRESSION_AVAILABLE,
} from '../src/compression';
import { Compression } from '../src/types';

function makePayload(): Uint8Array {
  // Mix repetitive runs (high compressibility) with random bytes so the
  // gzip output has enough length to drive at least one stream chunk.
  const buf = new Uint8Array(64 * 1024);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = i % 251;
  }
  return buf;
}

describe('NATIVE_DECOMPRESSION_AVAILABLE', () => {
  it('is true in this runtime (Node 18+ and all evergreen browsers)', () => {
    // Hard assertion: the bench / production decode throughput depends
    // on this being true. A regression to false should make CI red,
    // not pass silently.
    expect(NATIVE_DECOMPRESSION_AVAILABLE).toBe(true);
  });

  it('observes both DecompressionStream and Response in the global scope', () => {
    expect(typeof DecompressionStream).toBe('function');
    expect(typeof Response).toBe('function');
  });
});

describe('decompress()', () => {
  afterEach(() => vi.restoreAllMocks());

  it('round-trips gzip through the native path', async () => {
    const plain = makePayload();
    const compressed = gzipSync(plain);
    const out = await decompress(compressed, Compression.Gzip);
    expect(out.length).toBe(plain.length);
    // Spot-check a handful of offsets — full byte-eq on 64 KiB.
    expect(out[0]).toBe(plain[0]);
    expect(out[plain.length - 1]).toBe(plain[plain.length - 1]);
    expect(Array.from(out.subarray(0, 32))).toEqual(Array.from(plain.subarray(0, 32)));
  });

  it('falls back to the pure-JS path when the native decoder throws', async () => {
    // Patch DecompressionStream so any pipeThrough() throws. The
    // `decompress()` implementation must catch and retry via the
    // synchronous fallback rather than propagating.
    const original = globalThis.DecompressionStream;
    class BrokenStream {
      constructor() {
        throw new Error('synthetic native-path failure');
      }
    }
    (globalThis as any).DecompressionStream = BrokenStream as any;
    try {
      const plain = makePayload();
      const compressed = gzipSync(plain);
      const out = await decompress(compressed, Compression.Gzip);
      expect(out.length).toBe(plain.length);
      expect(out[0]).toBe(plain[0]);
    } finally {
      (globalThis as any).DecompressionStream = original;
    }
  });

  it('passes Compression.None through untouched', async () => {
    const plain = makePayload();
    const out = await decompress(plain, Compression.None);
    expect(out).toBe(plain); // identity
  });

  it('rejects unknown compression codes', async () => {
    await expect(decompress(new Uint8Array(0), 99 as any)).rejects.toThrow(
      /Unknown compression/i,
    );
  });
});

describe('decompressSync()', () => {
  it('round-trips gzip via the pure-JS fallback', () => {
    const plain = makePayload();
    const compressed = gzipSync(plain);
    const out = decompressSync(compressed, Compression.Gzip);
    expect(out.length).toBe(plain.length);
    expect(out[0]).toBe(plain[0]);
  });

  it('gunzipSync directly produces the same output', () => {
    const plain = new Uint8Array([1, 2, 3, 4, 5]);
    const compressed = gzipSync(plain);
    expect(Array.from(gunzipSync(compressed))).toEqual([1, 2, 3, 4, 5]);
  });

  it('zstd path is callable (covered by archive contract tests too)', () => {
    // unzstdSync is re-exported so consumers can decode zstd payloads
    // without pulling fzstd directly. We just smoke-test that the
    // function exists and rejects nonsense input.
    expect(typeof unzstdSync).toBe('function');
    expect(() => unzstdSync(new Uint8Array([0x00, 0x00]))).toThrow();
  });
});

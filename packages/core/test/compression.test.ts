/**
 * Compression: the packed format is zstd-only, plus uncompressed `none`.
 *
 * gzip was retired with the legacy single-file `.stt` format; the reader must
 * reject it (byte 1 stays permanently reserved) rather than silently
 * mis-decoding. Real zstd round-trips are exercised by the archive contract
 * tests against Rust-produced payloads; here we cover the passthrough and
 * rejection contracts plus the zstd decoder entry point.
 */

import { describe, it, expect } from 'vitest';

import { decompress, decompressSync, unzstdSync } from '../src/compression';
import { Compression } from '../src/types';

function makePayload(): Uint8Array {
  const buf = new Uint8Array(64 * 1024);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = i % 251;
  }
  return buf;
}

describe('decompress()', () => {
  it('passes Compression.None through untouched', async () => {
    const plain = makePayload();
    const out = await decompress(plain, Compression.None);
    expect(out).toBe(plain); // identity
  });

  it('rejects unknown compression codes', async () => {
    await expect(decompress(new Uint8Array(0), 99 as any)).rejects.toThrow(
      /Unknown or retired compression/i,
    );
  });

  it('rejects the retired gzip codec (byte 1)', async () => {
    // Byte 1 is permanently reserved for the retired gzip codec.
    await expect(decompress(new Uint8Array(0), 1 as any)).rejects.toThrow(
      /Unknown or retired compression/i,
    );
  });
});

describe('decompressSync()', () => {
  it('passes Compression.None through untouched', () => {
    const plain = makePayload();
    expect(decompressSync(plain, Compression.None)).toBe(plain);
  });

  it('rejects the retired gzip codec (byte 1)', () => {
    expect(() => decompressSync(new Uint8Array(0), 1 as any)).toThrow(
      /Unknown or retired compression/i,
    );
  });

  it('zstd decoder is callable (real payloads covered by archive contract tests)', () => {
    // unzstdSync is re-exported so consumers can decode zstd payloads
    // without pulling fzstd directly. Smoke-test existence + that it
    // rejects nonsense input.
    expect(typeof unzstdSync).toBe('function');
    expect(() => unzstdSync(new Uint8Array([0x00, 0x00]))).toThrow();
  });
});

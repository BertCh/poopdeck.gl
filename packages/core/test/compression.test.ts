/**
 * Compression: the packed format is zstd-only, plus uncompressed `none`.
 *
 * gzip was retired with the legacy single-file `.stt` format; the reader must
 * reject it (byte 1 stays permanently reserved) rather than silently
 * mis-decoding. Real zstd round-trips are exercised by the archive contract
 * tests against Rust-produced payloads; here we cover the passthrough and
 * rejection contracts. Real zstd payloads round-trip through the archive
 * contract tests.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { decompress, decompressSync, unzstdSync } from '../src/compression';
import { Compression } from '../src/types';
import { decodeDirectory } from '../src/directory';
import { packedFromSingleFile } from './helpers/packed-fixture';

const FIXTURE_BYTES = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL('./fixtures/sample.stt', import.meta.url)),
  ),
);

/** A real (Rust-produced) zstd tile blob + its declared decompressed size. */
function firstZstdBlob(): { blob: Uint8Array; uncompressedSize: number } {
  const ds = packedFromSingleFile(FIXTURE_BYTES);
  const manifest = JSON.parse(
    new TextDecoder().decode(ds.objects.get('manifest.json')!),
  );
  const e = decodeDirectory(ds.objects.get(manifest.directory.key)!)[0];
  const pack = ds.objects.get(manifest.packs[e.packId].key)!;
  return {
    blob: pack.subarray(e.offset, e.offset + e.length),
    uncompressedSize: e.uncompressedSize,
  };
}

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
});

describe('unzstdSync output bounding (spec §11 decompression-bomb guard)', () => {
  it('decodes a real zstd blob to exactly its declared uncompressedSize', () => {
    const { blob, uncompressedSize } = firstZstdBlob();
    expect(uncompressedSize).toBeGreaterThan(1);
    // Uncapped and capped-at-the-exact-declared-size both decode valid data.
    expect(unzstdSync(blob).length).toBe(uncompressedSize);
    expect(unzstdSync(blob, uncompressedSize).length).toBe(uncompressedSize);
    // The bound flows through decompressSync/decompress too.
    expect(
      decompressSync(blob, Compression.Zstd, uncompressedSize).length,
    ).toBe(uncompressedSize);
  });

  it('rejects a frame whose output exceeds a lying/undersized uncompressedSize', () => {
    const { blob, uncompressedSize } = firstZstdBlob();
    // A directory that under-declares the size (or a blob whose bytes disagree
    // with the directory) must be stopped before the full output materializes.
    expect(() => unzstdSync(blob, uncompressedSize - 1)).toThrow(
      /decompression bomb|exceeds/i,
    );
    expect(() => decompressSync(blob, Compression.Zstd, 8)).toThrow(
      /decompression bomb|exceeds/i,
    );
  });
});

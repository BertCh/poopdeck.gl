/**
 * Cross-impl tests for the two additive wire changes of 2026-06:
 *
 * 1. **Aligned layer frames.** The Rust writer now sets the top bit of the
 *    frame's leading u16 and pads each Arrow IPC stream to an 8-byte
 *    boundary (relative to the payload start). That alignment is what lets
 *    apache-arrow wrap the stream's buffers zero-copy — a stream at a
 *    misaligned offset silently copies every buffer of every tile. The
 *    parser must read BOTH shapes: the aligned frame and the legacy
 *    unpadded frame every deployed archive carries.
 *
 * 2. **Directory at-rest encoding.** `manifest.directory.encoding: 'zstd'`
 *    declares a zstd-compressed `.sttd` object; absent = raw (every
 *    pre-encoding manifest). The golden fixture is Rust-written with the
 *    compressed shape; the in-memory helper datasets used across the rest
 *    of the suite keep exercising the raw shape.
 *
 * The payload under test comes from the committed Rust-produced golden
 * fixture, so the alignment rule is pinned writer-to-reader, not TS-to-TS.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STTArchive } from '../src/archive';

const FIXTURE_DIR = fileURLToPath(
  new URL('./fixtures/packed-golden/', import.meta.url),
);

describe('directory at-rest encoding', () => {
  /** Serve the golden fixture, optionally rewriting the manifest. */
  function fixtureFetch(mutateManifest?: (m: any) => any): typeof fetch {
    return (async (url: string, init?: RequestInit) => {
      const marker = 'packed-golden/';
      const at = url.indexOf(marker);
      const rel = at >= 0 ? url.slice(at + marker.length) : 'manifest.json';
      let bytes = new Uint8Array(readFileSync(FIXTURE_DIR + rel));
      if (rel === 'manifest.json' && mutateManifest) {
        const m = mutateManifest(JSON.parse(new TextDecoder().decode(bytes)));
        bytes = new TextEncoder().encode(JSON.stringify(m));
      }
      const range = (init?.headers as Record<string, string> | undefined)
        ?.Range;
      const m = /bytes=(\d+)-(\d+)/.exec(range ?? '');
      if (!m) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          arrayBuffer: async () =>
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
        };
      }
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), bytes.length - 1);
      const slice = bytes.slice(start, end + 1);
      return {
        ok: true,
        status: 206,
        statusText: 'Partial Content',
        arrayBuffer: async () => slice.buffer,
      };
    }) as unknown as typeof fetch;
  }

  it('decodes a zstd-encoded directory declared via directory.encoding', async () => {
    const archive = new STTArchive({
      url: 'https://cdn.example/data/packed-golden/manifest.json',
      fetch: fixtureFetch(),
    });
    const index = await archive.getIndex();
    expect(index.tiles.length).toBe(12);
  });

  it('rejects an unknown directory encoding loudly', async () => {
    const archive = new STTArchive({
      url: 'https://cdn.example/data/packed-golden/manifest.json',
      fetch: fixtureFetch((m) => ({
        ...m,
        directory: { ...m.directory, encoding: 'br' },
      })),
    });
    await expect(archive.getIndex()).rejects.toThrow(
      /unknown directory encoding/,
    );
  });

  it('still validates the at-rest (compressed) length against directory.length', async () => {
    // Wave-1 transport hardening: the fetched body is checked against the
    // manifest-declared length BEFORE the encoding unwrap — a truncated
    // compressed directory must surface as a transport error, not a zstd
    // decode mystery. Declaring the wrong length proves the check runs on
    // the at-rest bytes.
    const archive = new STTArchive({
      url: 'https://cdn.example/data/packed-golden/manifest.json',
      fetch: fixtureFetch((m) => ({
        ...m,
        directory: { ...m.directory, length: m.directory.length + 1 },
      })),
      retryDelaysMs: [],
    });
    await expect(archive.getIndex()).rejects.toThrow(/truncated/);
  });
});

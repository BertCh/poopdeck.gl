/**
 * v3 archive format: header parsing and basic compatibility surface.
 *
 * The full end-to-end contract test still lives in `archive.test.ts` and
 * relies on a Rust-built fixture; these tests target what we can verify
 * without spinning up the Rust toolchain — that the TS reader recognises
 * a synthetic v3 header, surfaces the dictionary slot, and rejects bad
 * magic / unknown versions.
 */

import { describe, it, expect } from 'vitest';
import { STTArchive } from '../src/archive';
import { Compression } from '../src/types';

const HEADER_SIZE = 64;

function buildHeader(opts: {
  version: number;
  compression: number;
  indexOffset: number;
  indexLength: number;
  metadataOffset: number;
  metadataLength: number;
  dictionaryOffset?: number;
  dictionaryLength?: number;
}): Uint8Array {
  const buf = new ArrayBuffer(HEADER_SIZE);
  const view = new DataView(buf);
  view.setUint8(0, 0x53);
  view.setUint8(1, 0x54);
  view.setUint8(2, 0x54);
  view.setUint8(3, opts.version);
  view.setUint8(4, opts.version);
  view.setUint8(5, opts.compression);
  view.setBigUint64(6, BigInt(opts.indexOffset), true);
  view.setBigUint64(14, BigInt(opts.indexLength), true);
  view.setBigUint64(22, BigInt(opts.metadataOffset), true);
  view.setBigUint64(30, BigInt(opts.metadataLength), true);
  view.setBigUint64(38, BigInt(opts.dictionaryOffset ?? 0), true);
  view.setBigUint64(46, BigInt(opts.dictionaryLength ?? 0), true);
  return new Uint8Array(buf);
}

/**
 * Build a tiny "archive" containing just a header + JSON metadata, and
 * serve it via a range-fetch shim. The bench/contract tests exercise the
 * full pipeline; here we just confirm the reader parses the header.
 */
function buildMinimalArchive(opts: {
  version: number;
  compression: number;
  dictionaryLength?: number;
}): Uint8Array {
  const metadata = new TextEncoder().encode(
    JSON.stringify({
      name: 'test',
      bounds: { min_lon: -180, min_lat: -85, max_lon: 180, max_lat: 85 },
      time_range: { start: 0, end: 1 },
    }),
  );
  const dictBytes = new Uint8Array(opts.dictionaryLength ?? 0);
  for (let i = 0; i < dictBytes.length; i++) dictBytes[i] = (i + 1) & 0xff;

  // Layout: [header] [dictionary?] [empty index] [metadata]
  const dictionaryOffset = opts.dictionaryLength ? HEADER_SIZE : 0;
  const indexOffset = HEADER_SIZE + dictBytes.length;
  // We never decode the empty index in this test; just give it zero-length.
  const indexLength = 0;
  const metadataOffset = indexOffset + indexLength;
  const metadataLength = metadata.length;

  const header = buildHeader({
    version: opts.version,
    compression: opts.compression,
    indexOffset,
    indexLength,
    metadataOffset,
    metadataLength,
    dictionaryOffset,
    dictionaryLength: opts.dictionaryLength,
  });

  const total = new Uint8Array(metadataOffset + metadataLength);
  total.set(header, 0);
  total.set(dictBytes, dictionaryOffset || HEADER_SIZE);
  total.set(metadata, metadataOffset);
  return total;
}

function rangeFetch(bytes: Uint8Array): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string>)?.Range;
    const m = /bytes=(\d+)-(\d+)/.exec(range ?? '');
    if (!m) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => bytes.buffer.slice(0),
      };
    }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), bytes.length - 1);
    const slice = bytes.subarray(start, end + 1);
    return {
      ok: true,
      status: 206,
      statusText: 'Partial Content',
      arrayBuffer: async () =>
        slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
    };
  }) as unknown as typeof fetch;
}

describe('v3 archive header', () => {
  it('parses a v3 header with zstd compression', async () => {
    const bytes = buildMinimalArchive({ version: 3, compression: 2 });
    const archive = new STTArchive({ url: 'mem://v3.stt', fetch: rangeFetch(bytes) });
    const meta = await archive.getMetadata();
    expect(meta.version).toBe(3);
  });

  it('parses a v2 header (back-compat)', async () => {
    const bytes = buildMinimalArchive({ version: 2, compression: 1 });
    const archive = new STTArchive({ url: 'mem://v2.stt', fetch: rangeFetch(bytes) });
    const meta = await archive.getMetadata();
    expect(meta.version).toBe(2);
  });

  it('rejects an unknown magic', async () => {
    const bytes = buildMinimalArchive({ version: 3, compression: 2 });
    bytes[0] = 0x42; // corrupt the magic
    const archive = new STTArchive({ url: 'mem://bad.stt', fetch: rangeFetch(bytes) });
    await expect(archive.getMetadata()).rejects.toThrow(/magic/i);
  });

  it('rejects an unsupported future version', async () => {
    const bytes = buildMinimalArchive({ version: 7, compression: 0 });
    const archive = new STTArchive({ url: 'mem://future.stt', fetch: rangeFetch(bytes) });
    await expect(archive.getMetadata()).rejects.toThrow(/version/i);
  });

  it('exposes the v3 dictionary slot when present', async () => {
    const bytes = buildMinimalArchive({
      version: 3,
      compression: 2,
      dictionaryLength: 24,
    });
    const archive = new STTArchive({ url: 'mem://dict.stt', fetch: rangeFetch(bytes) });
    const dict = await archive.getDictionary();
    expect(dict).not.toBeNull();
    expect(dict!.length).toBe(24);
    // Sanity-check the bytes are exactly what we wrote.
    for (let i = 0; i < dict!.length; i++) {
      expect(dict![i]).toBe(((i + 1) & 0xff));
    }
  });

  it('returns null when a v3 archive has no dictionary', async () => {
    const bytes = buildMinimalArchive({ version: 3, compression: 2 });
    const archive = new STTArchive({ url: 'mem://nodict.stt', fetch: rangeFetch(bytes) });
    const dict = await archive.getDictionary();
    expect(dict).toBeNull();
  });

  it('returns null when reading a v2 archive', async () => {
    const bytes = buildMinimalArchive({ version: 2, compression: 1 });
    const archive = new STTArchive({ url: 'mem://v2nodict.stt', fetch: rangeFetch(bytes) });
    const dict = await archive.getDictionary();
    expect(dict).toBeNull();
  });

  it('parses a zstd compression code', async () => {
    const bytes = buildMinimalArchive({ version: 3, compression: 2 });
    const archive = new STTArchive({ url: 'mem://v3zstd.stt', fetch: rangeFetch(bytes) });
    // Indirect: the compression byte feeds into entries returned by
    // getIndex(). With an empty index we only confirm the header path
    // accepted code=2 (zstd) — `getMetadata` would otherwise throw.
    await archive.getMetadata();
    // We can also verify via a public Compression export.
    expect(Compression.Zstd).toBe(2);
  });
});

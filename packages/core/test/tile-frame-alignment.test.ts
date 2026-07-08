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
import { decodeTile } from '../src/tile';
import { decodeDirectory } from '../src/directory';
import { unzstdSync } from '../src/compression';
import { STTArchive } from '../src/archive';
import { GeometryType } from '../src/types';

const FIXTURE_DIR = fileURLToPath(
  new URL('./fixtures/packed-golden/', import.meta.url),
);

const ALIGNED_FRAME_FLAG = 0x8000;

/** Read the golden fixture's first blob (tile k=0: packId 0, offset 0). */
function goldenPayload(): Uint8Array {
  const manifest = JSON.parse(
    readFileSync(FIXTURE_DIR + 'manifest.json', 'utf8'),
  );
  let dirBytes = new Uint8Array(
    readFileSync(FIXTURE_DIR + manifest.directory.key),
  );
  if (manifest.directory.encoding === 'zstd') dirBytes = unzstdSync(dirBytes);
  const entries = decodeDirectory(dirBytes);
  const entry = entries.find((e) => e.packId === 0 && e.offset === 0)!;
  expect(entry).toBeDefined();
  const pack = new Uint8Array(
    readFileSync(FIXTURE_DIR + manifest.packs[0].key),
  );
  const blob = pack.subarray(entry.offset, entry.offset + entry.length);
  const payload = unzstdSync(blob);
  // Copy into a fresh buffer at byteOffset 0 so alignment within the
  // payload equals alignment within the ArrayBuffer (the shape the worker
  // decode path delivers).
  return new Uint8Array(payload);
}

/** Walk a frame, honouring the aligned-frame padding rule, and return each
 *  layer's `[name, ipcStart, ipcLen]`. */
function walkFrame(payload: Uint8Array): Array<[string, number, number]> {
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const rawCount = view.getUint16(0, true);
  const aligned = (rawCount & ALIGNED_FRAME_FLAG) !== 0;
  const count = rawCount & ~ALIGNED_FRAME_FLAG;
  let pos = 2;
  const out: Array<[string, number, number]> = [];
  for (let i = 0; i < count; i++) {
    const nameLen = view.getUint16(pos, true);
    pos += 2;
    const name = new TextDecoder().decode(payload.subarray(pos, pos + nameLen));
    pos += nameLen;
    const ipcLen = view.getUint32(pos, true);
    pos += 4;
    if (aligned) pos += (8 - (pos & 7)) & 7;
    out.push([name, pos, ipcLen]);
    pos += ipcLen;
  }
  return out;
}

/** Re-emit a payload's layers as a LEGACY (unpadded, flag-less) frame. */
function toLegacyFrame(payload: Uint8Array): Uint8Array {
  const layers = walkFrame(payload);
  const parts: number[] = [];
  const pushU16 = (v: number) => parts.push(v & 0xff, (v >> 8) & 0xff);
  const pushU32 = (v: number) =>
    parts.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  pushU16(layers.length);
  for (const [name, start, len] of layers) {
    const nameBytes = new TextEncoder().encode(name);
    pushU16(nameBytes.length);
    parts.push(...nameBytes);
    pushU32(len);
    parts.push(...payload.subarray(start, start + len));
  }
  return new Uint8Array(parts);
}

describe('aligned layer frames (wire pin against the Rust writer)', () => {
  it('the Rust writer sets the flag and 8-aligns every IPC stream', () => {
    const payload = goldenPayload();
    const rawCount = payload[0] | (payload[1] << 8);
    expect(rawCount & ALIGNED_FRAME_FLAG).toBe(ALIGNED_FRAME_FLAG);
    const layers = walkFrame(payload);
    expect(layers.length).toBeGreaterThan(0);
    for (const [, start] of layers) {
      expect(start % 8).toBe(0);
    }
  });

  it('an aligned frame decodes zero-copy (typed arrays view the payload buffer)', () => {
    const payload = goldenPayload();
    const tile = decodeTile(payload, { z: 10, x: 0, y: 0, t: 0 });
    const f = tile.layers[0].features;
    expect(f.geometryType).toBe(GeometryType.Point);
    expect(Array.from(f.featureIds)).toEqual([0, 1, 2]);
    // The whole point of the alignment: the geometry coordinates are a
    // subarray VIEW into the decompressed payload's buffer, not a copy.
    expect(f.positions.buffer).toBe(payload.buffer);
  });

  it('legacy unpadded frames (deployed archives) still decode identically', () => {
    const payload = goldenPayload();
    const legacy = toLegacyFrame(payload);
    expect(legacy.length).toBeLessThan(payload.length); // padding stripped

    const fromAligned = decodeTile(payload, { z: 10, x: 0, y: 0, t: 0 });
    const fromLegacy = decodeTile(legacy, { z: 10, x: 0, y: 0, t: 0 });
    expect(fromLegacy.layers.length).toBe(fromAligned.layers.length);
    const a = fromAligned.layers[0].features;
    const l = fromLegacy.layers[0].features;
    expect(l.featureCount).toBe(a.featureCount);
    expect(Array.from(l.featureIds)).toEqual(Array.from(a.featureIds));
    expect(Array.from(l.positions)).toEqual(Array.from(a.positions));
    expect(Array.from(l.startTimes)).toEqual(Array.from(a.startTimes));
    expect(Array.from(l.endTimes)).toEqual(Array.from(a.endTimes));
  });
});

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

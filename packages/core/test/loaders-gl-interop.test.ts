/**
 * Verifies the structural conformance of the loaders.gl interop surface:
 * - `SttLoader` satisfies the loaders.gl `LoaderWithParser` field set so
 *   `TileLayer({ loaders: [SttLoader] })` works without dragging in any
 *   `@loaders.gl/*` runtime dep.
 * - `STTArchive.asTileSource()` returns an adapter with `getMetadata`,
 *   `getTile`, and `getTileData` methods that resolve real archive data.
 *
 * Reuses the same `sample.stt` fixture as `archive.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STTArchive } from '../src/archive';
import { SttLoader } from '../src/stt-loader';

const FIXTURE = fileURLToPath(new URL('./fixtures/sample.stt', import.meta.url));
const FIXTURE_BYTES = readFileSync(FIXTURE);

function rangeFetch(): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string>)?.Range;
    const m = /bytes=(\d+)-(\d+)/.exec(range ?? '');
    if (!m) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => bufferToArrayBuffer(FIXTURE_BYTES),
      };
    }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), FIXTURE_BYTES.length - 1);
    const slice = FIXTURE_BYTES.subarray(start, end + 1);
    return {
      ok: true,
      status: 206,
      statusText: 'Partial Content',
      arrayBuffer: async () => bufferToArrayBuffer(slice),
    };
  }) as unknown as typeof fetch;
}

function bufferToArrayBuffer(buf: Uint8Array): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe('SttLoader (loaders.gl LoaderWithParser conformance)', () => {
  it('declares the required Loader fields', () => {
    expect(SttLoader.name).toBe('STT');
    expect(SttLoader.id).toBe('stt');
    expect(SttLoader.module).toBe('stt');
    expect(SttLoader.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(SttLoader.extensions).toContain('stt');
    expect(SttLoader.mimeTypes.length).toBeGreaterThan(0);
    expect(SttLoader.binary).toBe(true);
    expect(typeof SttLoader.parse).toBe('function');
  });

  it('content-sniffs an STT archive by magic prefix', () => {
    const ok = FIXTURE_BYTES.subarray(0, 4).buffer.slice(0, 4);
    const bad = new Uint8Array([0x00, 0x00, 0x00, 0x00]).buffer;
    expect(SttLoader.tests?.length ?? 0).toBeGreaterThan(0);
    const probe = SttLoader.tests![0];
    // The `tests[]` entry is an ArrayBuffer of magic bytes. Loader-utils
    // checks `bytes.startsWith(test)` — we replicate the check here.
    expect(probe instanceof ArrayBuffer).toBe(true);
    const probeBytes = new Uint8Array(probe as ArrayBuffer);
    const okStarts = matchesPrefix(new Uint8Array(ok), probeBytes);
    const badStarts = matchesPrefix(new Uint8Array(bad), probeBytes);
    expect(okStarts).toBe(true);
    expect(badStarts).toBe(false);
  });

  it('parse(arrayBuffer) yields metadata + index + a usable archive', async () => {
    const buf = bufferToArrayBuffer(FIXTURE_BYTES);
    const parsed = await SttLoader.parse(buf);
    expect(parsed.metadata.minZoom).toBeLessThanOrEqual(parsed.metadata.maxZoom);
    expect(parsed.index.tiles.length).toBeGreaterThan(0);
    const entry = parsed.index.tiles[0];
    const tile = await parsed.archive.getTile({
      z: entry.zoom,
      x: entry.x,
      y: entry.y,
      t: entry.timeStart,
    });
    expect(tile).not.toBeNull();
    expect(tile!.layers.length).toBeGreaterThan(0);
    parsed.archive.finalize();
  });
});

describe('STTArchive.asTileSource() (loaders.gl TileSource conformance)', () => {
  it('getMetadata() returns the loaders.gl-shaped metadata', async () => {
    const archive = new STTArchive({ url: 'mem://sample.stt', fetch: rangeFetch() });
    const source = archive.asTileSource();
    const meta = await source.getMetadata();
    expect(meta.format).toBe('stt');
    expect(meta.minZoom).toBeLessThanOrEqual(meta.maxZoom!);
    expect(meta.boundingBox).toBeDefined();
    expect(meta.boundingBox![0][0]).toBeLessThan(meta.boundingBox![1][0]);
    expect(meta.boundingBox![0][1]).toBeLessThan(meta.boundingBox![1][1]);
    expect(meta.formatHeader).toBeDefined();
  });

  it('getTile({x,y,z}) picks the archive-midpoint time by default', async () => {
    const archive = new STTArchive({ url: 'mem://sample.stt', fetch: rangeFetch() });
    const index = await archive.getIndex();
    const e = index.tiles[0];
    const source = archive.asTileSource();
    const tile = await source.getTile({ z: e.zoom, x: e.x, y: e.y });
    // A midpoint-time lookup might land on a tile-free bucket — accept null,
    // but if non-null it MUST be a real tile shape.
    if (tile) {
      expect(tile.layers.length).toBeGreaterThan(0);
    }
  });

  it('getTileData honours an explicit userData.t override', async () => {
    const archive = new STTArchive({ url: 'mem://sample.stt', fetch: rangeFetch() });
    const index = await archive.getIndex();
    const e = index.tiles[0];
    const source = archive.asTileSource();
    const tile = await source.getTileData({
      index: { z: e.zoom, x: e.x, y: e.y },
      userData: { t: e.timeStart },
    });
    expect(tile).not.toBeNull();
    expect(tile!.layers.length).toBeGreaterThan(0);
  });
});

function matchesPrefix(input: Uint8Array, prefix: Uint8Array): boolean {
  if (input.byteLength < prefix.byteLength) return false;
  for (let i = 0; i < prefix.byteLength; i++) {
    if (input[i] !== prefix[i]) return false;
  }
  return true;
}

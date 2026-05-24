/**
 * Cross-language contract test: read a real archive produced by the Rust
 * `stt-build` CLI (`test/fixtures/sample.stt`) through the TypeScript reader.
 *
 * This is the single most important test in the package — it proves the Rust
 * writer and the TS reader agree on the on-disk format.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STTArchive } from '../src/archive';
import { GeometryType } from '../src/types';

const FIXTURE = fileURLToPath(new URL('./fixtures/sample.stt', import.meta.url));
const FIXTURE_BYTES = readFileSync(FIXTURE);

/**
 * A `fetch` shim that serves the fixture file with HTTP Range semantics —
 * exactly what `STTArchive` relies on against a real CDN.
 */
function rangeFetch(): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string>)?.Range;
    const m = /bytes=(\d+)-(\d+)/.exec(range ?? '');
    if (!m) {
      return { ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => bufferToArrayBuffer(FIXTURE_BYTES) };
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

describe('STTArchive (Arrow format)', () => {
  it('reads metadata from the JSON block', async () => {
    const archive = new STTArchive({ url: 'mem://sample.stt', fetch: rangeFetch() });
    const meta = await archive.getMetadata();
    // Reader supports both v2 and v3 fixtures; let the fixture's actual
    // version drive the expectation so we can regenerate it as the format
    // moves forward.
    expect(meta.version).toBeGreaterThanOrEqual(2);
    expect(meta.version).toBeLessThanOrEqual(3);
    expect(meta.minZoom).toBeLessThanOrEqual(meta.maxZoom);
    expect(meta.bounds.minLon).toBeLessThan(meta.bounds.maxLon);
    expect(meta.timeRange.end).toBeGreaterThan(meta.timeRange.start);
    expect(meta.temporalBucketMs).toBeGreaterThan(0);
  });

  it('reads the Arrow index directory', async () => {
    const archive = new STTArchive({ url: 'mem://sample.stt', fetch: rangeFetch() });
    const index = await archive.getIndex();
    expect(index.tiles.length).toBeGreaterThan(0);
    for (const t of index.tiles) {
      expect(t.length).toBeGreaterThan(0);
      expect(t.timeEnd).toBeGreaterThanOrEqual(t.timeStart);
      expect(t.featureCount).toBeGreaterThan(0);
    }
  });

  it('fetches and decodes a tile into binary features', async () => {
    const archive = new STTArchive({ url: 'mem://sample.stt', fetch: rangeFetch() });
    const index = await archive.getIndex();
    const entry = index.tiles[0];
    const tile = await archive.getTile({
      z: entry.zoom,
      x: entry.x,
      y: entry.y,
      t: entry.timeStart,
    });
    expect(tile).not.toBeNull();
    expect(tile!.layers.length).toBeGreaterThan(0);

    const features = tile!.layers[0].features;
    expect(features.featureCount).toBeGreaterThan(0);
    // Point fixtures: 2 interleaved coords per feature, no startIndices.
    expect(features.geometryType).toBe(GeometryType.Point);
    expect(features.positions.length).toBe(features.featureCount * 2);
    expect(features.featureIds.length).toBe(features.featureCount);
    expect(features.startTimes.length).toBe(features.featureCount);

    // Coordinates are real WGS84 lon/lat near the fixture's San Francisco box.
    for (let i = 0; i < features.positions.length; i += 2) {
      expect(features.positions[i]).toBeGreaterThan(-123);
      expect(features.positions[i]).toBeLessThan(-121);
      expect(features.positions[i + 1]).toBeGreaterThan(37);
      expect(features.positions[i + 1]).toBeLessThan(39);
    }

    // The fixture carries a numeric `speed` and categorical `kind` column.
    expect(features.numericProps.speed).toBeDefined();
    expect(features.numericProps.speed.length).toBe(features.featureCount);
    expect(features.categoricalProps.kind).toBeDefined();
    expect(features.categoricalProps.kind.categories.length).toBeGreaterThan(0);
  });

  it('serves repeated tile reads from the byte cache', async () => {
    const archive = new STTArchive({ url: 'mem://sample.stt', fetch: rangeFetch() });
    const index = await archive.getIndex();
    const e = index.tiles[0];
    const id = { z: e.zoom, x: e.x, y: e.y, t: e.timeStart };
    await archive.getTile(id);
    await archive.getTile(id);
    const stats = archive.getCacheStats();
    expect(stats.hits).toBeGreaterThanOrEqual(1);
  });

  it('returns null for a tile that is not in the directory', async () => {
    const archive = new STTArchive({ url: 'mem://sample.stt', fetch: rangeFetch() });
    const tile = await archive.getTile({ z: 20, x: 1, y: 1, t: 0 });
    expect(tile).toBeNull();
  });

  it('rejects a server that ignores Range requests', async () => {
    const badFetch = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => bufferToArrayBuffer(FIXTURE_BYTES),
    })) as unknown as typeof fetch;
    const archive = new STTArchive({ url: 'mem://sample.stt', fetch: badFetch });
    await expect(archive.getMetadata()).rejects.toThrow(/Range/);
  });
});

/**
 * Cross-language contract test: read a real archive produced by the Rust
 * `stt-build` CLI (`test/fixtures/sample.stt`) through the TypeScript reader.
 *
 * This is the single most important test in the package — it proves the Rust
 * writer and the TS reader agree on the on-disk format. The committed fixture
 * is a single-file v4 archive; the reader now consumes the PACKED format, so
 * the fixture is transcoded to an in-memory packed dataset (manifest + index +
 * packs) via `packedFromSingleFile` and served through `packedFetch`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STTArchive } from '../src/archive';
import { encodeDirectory } from '../src/directory';
import { GeometryType } from '../src/types';
import { configureSharedScheduler } from '../src/shared-scheduler';
import { packedFromSingleFile, packedFetch } from './helpers/packed-fixture';

const FIXTURE = fileURLToPath(new URL('./fixtures/sample.stt', import.meta.url));
const FIXTURE_BYTES = new Uint8Array(readFileSync(FIXTURE));
const DATASET = packedFromSingleFile(FIXTURE_BYTES);
/** Pack object keys in `packId` order (the transcoded fixture's packs). */
const DATASET_PACK_KEYS = [...DATASET.objects.keys()]
  .filter((k) => k.startsWith('packs/'))
  .sort();

/** A fresh packed archive over the transcoded sample fixture. */
function sampleArchive(): STTArchive {
  return new STTArchive({ url: DATASET.manifestUrl, fetch: packedFetch(DATASET) });
}

function bufferToArrayBuffer(buf: Uint8Array): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe('STTArchive (packed format)', () => {
  it('reads metadata folded into the manifest', async () => {
    const archive = sampleArchive();
    const meta = await archive.getMetadata();
    // Packed manifest folds metadata in; `version` is the manifest schema
    // version (formatVersion), not the old single-file format byte.
    expect(meta.version).toBe(1);
    expect(meta.minZoom).toBeLessThanOrEqual(meta.maxZoom);
    expect(meta.bounds.minLon).toBeLessThan(meta.bounds.maxLon);
    expect(meta.timeRange.end).toBeGreaterThan(meta.timeRange.start);
    expect(meta.temporalBucketMs).toBeGreaterThan(0);
  });

  it('reads the v5 directory', async () => {
    const archive = sampleArchive();
    const index = await archive.getIndex();
    expect(index.tiles.length).toBeGreaterThan(0);
    for (const t of index.tiles) {
      expect(t.length).toBeGreaterThan(0);
      expect(t.timeEnd).toBeGreaterThanOrEqual(t.timeStart);
      expect(t.featureCount).toBeGreaterThan(0);
      expect(t.packId).toBeGreaterThanOrEqual(0);
    }
  });

  it('fetches and decodes a tile into binary features', async () => {
    const archive = sampleArchive();
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

    // Regression: the dictionary decoder used to treat Arrow's empty
    // `nullBitmap` (returned for null-free columns) as "all rows null",
    // marking every index with the 0xffff sentinel. Downstream consumers
    // (e.g. HeatmapTimeLayer's categoryFilter) then dropped every feature
    // and the layer rendered nothing. Assert that at least one feature has
    // a real, in-range dictionary index — not the null sentinel.
    const kindIdx = features.categoricalProps.kind.indices;
    const numCats = features.categoricalProps.kind.categories.length;
    let resolved = 0;
    for (let i = 0; i < kindIdx.length; i++) {
      if (kindIdx[i] !== 0xffff) {
        expect(kindIdx[i]).toBeLessThan(numCats);
        resolved++;
      }
    }
    expect(resolved).toBeGreaterThan(0);
  });

  it('serves repeated tile reads from the byte cache', async () => {
    const archive = sampleArchive();
    const index = await archive.getIndex();
    const e = index.tiles[0];
    const id = { z: e.zoom, x: e.x, y: e.y, t: e.timeStart };
    await archive.getTile(id);
    await archive.getTile(id);
    const stats = archive.getCacheStats();
    expect(stats.hits).toBeGreaterThanOrEqual(1);
  });

  it('returns null for a tile that is not in the directory', async () => {
    const archive = sampleArchive();
    const tile = await archive.getTile({ z: 20, x: 1, y: 1, t: 0 });
    expect(tile).toBeNull();
  });

  it('honours coalesceGapBytes and maxConcurrentRequests, coalescing PER PACK', async () => {
    // Synthesize a multi-blob packed dataset by replicating the fixture's real
    // (decodable) blob K times across TWO packs (so coalescing must respect
    // pack boundaries), with PADDING between copies inside a pack — non-adjacent
    // so a zero gap does NOT coalesce them, but an unbounded gap merges all
    // copies WITHIN A PACK into one range each (never bridging the two packs).
    const fixtureIdx = await sampleArchive().getIndex();
    const e = fixtureIdx.tiles[0];
    // The decodable blob comes from the transcoded dataset's pack at the
    // entry's PACK-RELATIVE offset (not the original single-file offset).
    const srcPack = DATASET.objects.get(DATASET_PACK_KEYS[e.packId])!;
    const blob = srcPack.subarray(e.offset, e.offset + e.length);
    // The fixture's metadata, reused verbatim in the synthetic manifest.
    const hv = new DataView(bufferToArrayBuffer(FIXTURE_BYTES));
    const metaOff = Number(hv.getBigUint64(22, true));
    const metaLen = Number(hv.getBigUint64(30, true));
    const metaJson = JSON.parse(
      new TextDecoder().decode(FIXTURE_BYTES.subarray(metaOff, metaOff + metaLen)),
    );

    const PER_PACK = 3; // blobs per pack
    const PACKS = 2;
    const K = PER_PACK * PACKS;
    const PAD = 4096;
    const stride = e.length + PAD;

    // Build the two pack objects (each holds PER_PACK padded blob copies) and a
    // v5 directory referencing them by (packId, pack-relative offset).
    const packObjects: Uint8Array[] = [];
    const entries: Array<{
      zoom: number; x: number; y: number; timeStart: number; timeEnd: number;
      packId: number; offset: number; length: number; uncompressedSize: number;
      featureCount: number; hilbert: number; crc32c: number; temporalBucketMs?: number;
    }> = [];
    for (let p = 0; p < PACKS; p++) {
      const packLen = (PER_PACK - 1) * stride + e.length;
      const buf = new Uint8Array(packLen);
      for (let j = 0; j < PER_PACK; j++) {
        const off = j * stride;
        buf.set(blob, off);
        const i = p * PER_PACK + j;
        entries.push({
          zoom: e.zoom, x: e.x, y: e.y,
          timeStart: i, timeEnd: i,
          packId: p, offset: off,
          length: e.length, uncompressedSize: e.uncompressedSize,
          featureCount: e.featureCount,
          hilbert: i, crc32c: i + 1,
          temporalBucketMs: e.temporalBucketMs,
        });
      }
      packObjects.push(buf);
    }
    const dir = encodeDirectory(entries);

    const objects = new Map<string, Uint8Array>();
    objects.set('index/dir.sttd', dir);
    const packRefs = packObjects.map((b, p) => {
      const key = `packs/p${p}.sttp`;
      objects.set(key, b);
      return { key, length: b.length };
    });
    const manifest = {
      format: 'stt-packed',
      formatVersion: 1,
      compression: 'zstd',
      directory: { key: 'index/dir.sttd', length: dir.length, directoryVersion: 5 },
      packs: packRefs,
      metadata: metaJson,
    };
    objects.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));

    const manifestUrl = 'mem://m/manifest.json';
    const base = 'mem://m/';

    // A counting fetch that records Range-request concurrency. Whole GETs (the
    // manifest + directory) are served but NOT counted against the range budget.
    function countingFetch(state: { calls: number; inFlight: number; peak: number }): typeof fetch {
      return (async (url: string, init?: RequestInit) => {
        const key = url.startsWith(base) ? url.slice(base.length) : url;
        const bytes = objects.get(key)!;
        const range = (init?.headers as Record<string, string> | undefined)?.Range;
        const m = /bytes=(\d+)-(\d+)/.exec(range ?? '');
        if (!m) {
          return { ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => bufferToArrayBuffer(bytes) };
        }
        state.calls++; state.inFlight++; state.peak = Math.max(state.peak, state.inFlight);
        await new Promise((r) => setTimeout(r, 1));
        state.inFlight--;
        const start = Number(m[1]);
        const end = Math.min(Number(m[2]), bytes.length - 1);
        const slice = bytes.subarray(start, end + 1);
        return { ok: true, status: 206, statusText: 'Partial Content', arrayBuffer: async () => bufferToArrayBuffer(slice) };
      }) as unknown as typeof fetch;
    }

    const tileIds = entries.map((en) => ({ z: en.zoom, x: en.x, y: en.y, t: en.timeStart }));

    // Unbounded gap → blobs coalesce within each pack, but a range can NEVER
    // bridge two packs: 2 packs → exactly 2 range requests (not 1).
    const wide = { calls: 0, inFlight: 0, peak: 0 };
    const aWide = new STTArchive({ url: manifestUrl, fetch: countingFetch(wide), coalesceGapBytes: Number.MAX_SAFE_INTEGER });
    await aWide.getIndex();
    const wideBefore = wide.calls;
    const tilesWide = await aWide.getTiles(tileIds);
    expect(tilesWide.every((t) => t !== null)).toBe(true);
    expect(wide.calls - wideBefore).toBe(PACKS);

    // Zero gap → K separate requests, but never more than maxConcurrentRequests
    // in flight at once (the pool spans groups of ALL packs). The per-archive
    // `maxConcurrentRequests` cap is the LEGACY (kill-switch-disabled) path's
    // contract — with the process-shared scheduler ENABLED (the default),
    // concurrency is governed by the GLOBAL budget, not the per-archive number
    // (multi-source coordination, Phase 2). Disable the shared scheduler so this
    // exercises the per-instance cursor runner it is asserting about, then
    // restore the default so other tests see the shared path.
    configureSharedScheduler({ enabled: false });
    try {
      const tight = { calls: 0, inFlight: 0, peak: 0 };
      const aTight = new STTArchive({ url: manifestUrl, fetch: countingFetch(tight), coalesceGapBytes: 0, maxConcurrentRequests: 2 });
      await aTight.getIndex();
      const tightBefore = tight.calls;
      const tilesTight = await aTight.getTiles(tileIds);
      expect(tilesTight.every((t) => t !== null)).toBe(true);
      expect(tight.calls - tightBefore).toBe(K);
      expect(tight.peak).toBeLessThanOrEqual(2);
    } finally {
      configureSharedScheduler({ enabled: true });
    }
  });

  it('rejects a pack server that ignores Range requests', async () => {
    // The manifest + directory are whole-object GETs (200 is correct for them),
    // but a PACK read uses Range — a server that replies 200 there would
    // silently corrupt every offset-based read, so the reader must reject it.
    const dataset = packedFromSingleFile(FIXTURE_BYTES, { manifestUrl: 'mem://m/manifest.json' });
    const badFetch = (async (url: string) => {
      const key = url.startsWith('mem://m/') ? url.slice('mem://m/'.length) : url;
      const bytes = dataset.objects.get(key)!;
      // Always reply 200 with the whole object, ignoring any Range header.
      return { ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => bufferToArrayBuffer(bytes) };
    }) as unknown as typeof fetch;
    const archive = new STTArchive({ url: 'mem://m/manifest.json', fetch: badFetch });
    const index = await archive.getIndex(); // whole-GET, fine
    const e = index.tiles[0];
    await expect(
      archive.getTile({ z: e.zoom, x: e.x, y: e.y, t: e.timeStart }),
    ).rejects.toThrow(/Range/);
  });

  describe('manifest version gates (conformance reader-MUST)', () => {
    /** The fixture dataset with its manifest JSON rewritten through `mutate`. */
    function datasetWithManifest(mutate: (manifest: any) => void): STTArchive {
      const dataset = packedFromSingleFile(FIXTURE_BYTES);
      const manifest = JSON.parse(
        new TextDecoder().decode(dataset.objects.get('manifest.json')!),
      );
      mutate(manifest);
      dataset.objects.set(
        'manifest.json',
        new TextEncoder().encode(JSON.stringify(manifest)),
      );
      return new STTArchive({ url: dataset.manifestUrl, fetch: packedFetch(dataset) });
    }

    it('rejects an unrecognized format', async () => {
      const archive = datasetWithManifest((m) => {
        m.format = 'stt-packed-v2';
      });
      await expect(archive.getMetadata()).rejects.toThrow(/not a packed manifest/);
    });

    it('rejects an unrecognized formatVersion', async () => {
      const archive = datasetWithManifest((m) => {
        m.formatVersion = 2;
      });
      await expect(archive.getMetadata()).rejects.toThrow(/unsupported formatVersion 2/);
    });

    it('rejects a missing formatVersion', async () => {
      const archive = datasetWithManifest((m) => {
        delete m.formatVersion;
      });
      await expect(archive.getMetadata()).rejects.toThrow(/unsupported formatVersion/);
    });

    it('rejects an unrecognized directoryVersion', async () => {
      const archive = datasetWithManifest((m) => {
        m.directory.directoryVersion = 4;
      });
      await expect(archive.getIndex()).rejects.toThrow(/unsupported directoryVersion 4/);
    });

    it('rejects a missing directoryVersion', async () => {
      const archive = datasetWithManifest((m) => {
        delete m.directory.directoryVersion;
      });
      await expect(archive.getIndex()).rejects.toThrow(/unsupported directoryVersion/);
    });

    it('accepts the golden formatVersion=1 / directoryVersion=5 manifest', async () => {
      const archive = datasetWithManifest(() => {});
      const meta = await archive.getMetadata();
      expect(meta.version).toBe(1);
      const index = await archive.getIndex();
      expect(index.tiles.length).toBeGreaterThan(0);
    });
  });
});

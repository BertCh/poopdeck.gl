/**
 * Cross-language contract test: read a real archive produced by the Rust
 * Rust writer (`test/fixtures/packed-golden/`) through the TypeScript reader.
 *
 * This is the single most important test in the package — it proves the Rust
 * writer and the TS reader agree on the on-disk format. The committed fixture
 * is a single-file v4 archive; the reader now consumes the PACKED format, so
 * the fixture is transcoded to an in-memory packed dataset (manifest + index +
 * packs) via `packedFromGolden` and served through `packedFetch`.
 */

import { describe, it, expect } from 'vitest';
import * as nodeFs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  STTArchive,
  EVICT_SCAN_LIMIT,
  byteCacheEvictionScore,
  selectLruVictim,
} from '../src/archive';
import { crc32c } from '../src/crc32c';
import { encodeDirectory } from '../src/directory';
import { GeometryType } from '../src/types';
import {
  directoryKey,
  directoryObject,
  loadPackedDatasetFromDisk,
  packKey,
  packObject,
  packedFromGolden,
  packedFetch,
  type InMemoryPackedDataset,
  type PackedFetchLog,
} from './helpers/packed-fixture';
import { bufferToArrayBuffer } from './helpers/fixtures';

const DATASET = packedFromGolden();
/** Pack object keys in `packId` order (the transcoded fixture's packs). */
const DATASET_PACK_KEYS = [...DATASET.objects.keys()]
  .filter((k) => k.startsWith('packs/'))
  .sort();

/** A fresh packed archive over the transcoded sample fixture. */
function sampleArchive(): STTArchive {
  return new STTArchive({
    url: DATASET.manifestUrl,
    fetch: packedFetch(DATASET),
  });
}

describe('STTArchive (packed format)', () => {
  it('reads metadata folded into the manifest', async () => {
    const archive = sampleArchive();
    const meta = await archive.getMetadata();
    // Packed manifest folds metadata in; `version` is the manifest schema
    // version (formatVersion), not the old single-file format byte.
    expect(meta.version).toBe(3);
    expect(meta.minZoom).toBeLessThanOrEqual(meta.maxZoom);
    expect(meta.bounds.minLon).toBeLessThan(meta.bounds.maxLon);
    expect(meta.timeRange.end).toBeGreaterThan(meta.timeRange.start);
    expect(meta.temporalBucketMs).toBeGreaterThan(0);
  });

  it('reads the v6 directory', async () => {
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

  it('prices a selection in parity with getTileIdsInBounds (real writer output)', async () => {
    // The synthetic-directory units live in cost-oracle.test.ts; this one runs
    // the oracle over REAL Rust writer output, so the entry shape (covering
    // section, run-collapsed blob columns, whatever the encoder actually
    // emitted) is the one being priced.
    const archive = sampleArchive();
    const index = await archive.getIndex();
    const meta = await archive.getMetadata();
    const zoom = index.tiles[0].zoom;

    // A box around the fixture's own tiles — deliberately not the whole world,
    // which at z10 is a million-cell scan.
    const size = 2 ** zoom;
    const toLon = (x: number): number => (x / size) * 360 - 180;
    const toLat = (y: number): number => {
      const n = Math.PI - (2 * Math.PI * y) / size;
      return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    };
    const xs = index.tiles.map((t) => t.x);
    const ys = index.tiles.map((t) => t.y);
    const bounds = {
      minLon: toLon(Math.min(...xs)),
      maxLon: toLon(Math.max(...xs) + 1),
      minLat: toLat(Math.max(...ys) + 1),
      maxLat: toLat(Math.min(...ys)),
    };
    const range = meta.timeRange;

    const ids = await archive.getTileIdsInBounds(bounds, zoom, range);
    expect(ids.length).toBeGreaterThan(0);
    let expected = 0;
    for (const id of ids) expected += archive.getTileByteSize(id)!;

    const cost = archive.estimateSelectionCost(bounds, zoom, range);
    expect(cost.bytes).toBe(expected);
    expect(cost.tiles).toBe(ids.length);
    // Whole-loaded directory: nothing is invisible, so nothing is counted.
    expect(cost.unknownTiles).toBe(0);

    // A half-open window prices the sub-selection it addresses, not the whole.
    const half = {
      start: range.start,
      end: Math.floor((range.start + range.end) / 2),
    };
    const halfIds = await archive.getTileIdsInBounds(bounds, zoom, half);
    let halfExpected = 0;
    for (const id of halfIds) halfExpected += archive.getTileByteSize(id)!;
    const halfCost = archive.estimateSelectionCost(bounds, zoom, half);
    expect(halfCost.bytes).toBe(halfExpected);
    expect(halfCost.bytes).toBeLessThan(cost.bytes);
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

  it('allows the compressed byte cache to be disabled', async () => {
    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      fetch: packedFetch(DATASET),
      maxCacheTiles: 0,
    });
    const index = await archive.getIndex();
    const e = index.tiles[0];
    const id = { z: e.zoom, x: e.x, y: e.y, t: e.timeStart };
    await archive.getTile(id);
    await archive.getTile(id);
    const stats = archive.getCacheStats();
    expect(stats.size).toBe(0);
    expect(stats.bytes).toBe(0);
    expect(stats.hits).toBe(0);
    archive.finalize();
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
    const metaJson = JSON.parse(
      new TextDecoder().decode(DATASET.objects.get('manifest.json')!),
    ).metadata;

    const PER_PACK = 3; // blobs per pack
    const PACKS = 2;
    const K = PER_PACK * PACKS;
    const PAD = 4096;
    const stride = e.length + PAD;

    // Build the two pack objects (each holds PER_PACK padded blob copies) and a
    // v6 directory referencing them by (packId, pack-relative offset).
    const packObjects: Uint8Array[] = [];
    const entries: Array<{
      zoom: number;
      x: number;
      y: number;
      timeStart: number;
      timeEnd: number;
      packId: number;
      offset: number;
      length: number;
      uncompressedSize: number;
      featureCount: number;
      hilbert: number;
      crc32c: number;
      temporalBucketMs?: number;
    }> = [];
    for (let p = 0; p < PACKS; p++) {
      const packLen = (PER_PACK - 1) * stride + e.length;
      const buf = new Uint8Array(packLen);
      for (let j = 0; j < PER_PACK; j++) {
        const off = j * stride;
        buf.set(blob, off);
        const i = p * PER_PACK + j;
        entries.push({
          zoom: e.zoom,
          x: e.x,
          y: e.y,
          timeStart: i,
          timeEnd: i,
          packId: p,
          offset: off,
          length: e.length,
          uncompressedSize: e.uncompressedSize,
          featureCount: e.featureCount,
          // The blob is real and decoded through the verifying reader, so the
          // directory must carry its true CRC-32C.
          hilbert: i,
          crc32c: crc32c(blob),
          temporalBucketMs: e.temporalBucketMs,
        });
      }
      packObjects.push(buf);
    }
    const dir = encodeDirectory(entries);

    const objects = new Map<string, Uint8Array>();
    const dirObject = directoryObject(dir);
    const dKey = directoryKey(dirObject);
    objects.set(dKey, dirObject);
    const packRefs = packObjects.map((b, p) => {
      const unique = new Uint8Array(b.length + 1);
      unique.set(b);
      unique[b.length] = p;
      const key = packKey(unique);
      objects.set(key, unique);
      return { key, length: unique.length };
    });
    const manifest = {
      format: 'stt-packed',
      formatVersion: 3,
      variants: [{ id: 0, kind: 'raw' }],
      compression: 'zstd',
      directory: {
        key: dKey,
        length: dirObject.length,
        directoryVersion: 6,
      },
      packs: packRefs,
      metadata: metaJson,
    };
    objects.set(
      'manifest.json',
      new TextEncoder().encode(JSON.stringify(manifest)),
    );

    const manifestUrl = 'mem://m/manifest.json';
    const base = 'mem://m/';

    // A counting fetch that records Range-request concurrency. Whole GETs (the
    // manifest + directory) are served but NOT counted against the range budget.
    function countingFetch(state: {
      calls: number;
      inFlight: number;
      peak: number;
    }): typeof fetch {
      return (async (url: string, init?: RequestInit) => {
        const key = url.startsWith(base) ? url.slice(base.length) : url;
        const bytes = objects.get(key)!;
        const range = (init?.headers as Record<string, string> | undefined)
          ?.Range;
        const m = /bytes=(\d+)-(\d+)/.exec(range ?? '');
        if (!m) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            arrayBuffer: async () => bufferToArrayBuffer(bytes),
          };
        }
        state.calls++;
        state.inFlight++;
        state.peak = Math.max(state.peak, state.inFlight);
        await new Promise((r) => setTimeout(r, 1));
        state.inFlight--;
        const start = Number(m[1]);
        const end = Math.min(Number(m[2]), bytes.length - 1);
        const slice = bytes.subarray(start, end + 1);
        return {
          ok: true,
          status: 206,
          statusText: 'Partial Content',
          arrayBuffer: async () => bufferToArrayBuffer(slice),
        };
      }) as unknown as typeof fetch;
    }

    const tileIds = entries.map((en) => ({
      z: en.zoom,
      x: en.x,
      y: en.y,
      t: en.timeStart,
    }));

    // Unbounded gap → blobs coalesce within each pack, but a range can NEVER
    // bridge two packs: 2 packs → exactly 2 range requests (not 1).
    const wide = { calls: 0, inFlight: 0, peak: 0 };
    const aWide = new STTArchive({
      url: manifestUrl,
      fetch: countingFetch(wide),
      coalesceGapBytes: Number.MAX_SAFE_INTEGER,
    });
    await aWide.getIndex();
    const wideBefore = wide.calls;
    const tilesWide = await aWide.getTiles(tileIds);
    expect(tilesWide.every((t) => t !== null)).toBe(true);
    expect(wide.calls - wideBefore).toBe(PACKS);

    // Zero gap → K separate requests. Concurrency is governed by the process-
    // shared scheduler's GLOBAL budget, not this archive's number, so only the
    // request COUNT is asserted here (the global-budget contract has its own
    // coverage in shared-scheduler-archive.test.ts).
    const tight = { calls: 0, inFlight: 0, peak: 0 };
    const aTight = new STTArchive({
      url: manifestUrl,
      fetch: countingFetch(tight),
      coalesceGapBytes: 0,
      maxConcurrentRequests: 2,
    });
    await aTight.getIndex();
    const tightBefore = tight.calls;
    const tilesTight = await aTight.getTiles(tileIds);
    expect(tilesTight.every((t) => t !== null)).toBe(true);
    expect(tight.calls - tightBefore).toBe(K);
  });

  it('drops a poisoned cached payload and self-heals on the next read', async () => {
    // The byte cache stores COMPRESSED bytes before any CRC/decode check, so
    // a corrupt blob would otherwise reject every future decode from cache.
    // BH-8 widened `ByteCacheEntry`; the drop/self-heal path must be
    // untouched by that.
    const ds = packedFromGolden({ manifestUrl: 'mem://poison/manifest.json' });
    const idx0 = await new STTArchive({
      url: ds.manifestUrl,
      fetch: packedFetch(ds),
    }).getIndex();
    const e = idx0.tiles[0];
    const id = { z: e.zoom, x: e.x, y: e.y, t: e.timeStart };

    // First response corrupts the tile body; later ones are honest.
    let served = 0;
    const flaky = (async (url: string, init?: RequestInit) => {
      const key = url.startsWith('mem://poison/')
        ? url.slice('mem://poison/'.length)
        : url;
      const bytes = ds.objects.get(key)!;
      const range = (init?.headers as Record<string, string> | undefined)
        ?.Range;
      const m = /bytes=(\d+)-(\d+)/.exec(range ?? '');
      if (!m) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          arrayBuffer: async () => bufferToArrayBuffer(bytes),
        };
      }
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), bytes.length - 1);
      const slice = bytes.slice(start, end + 1);
      if (served++ === 0) slice.fill(0xff, 0, Math.min(8, slice.length));
      return {
        ok: true,
        status: 206,
        statusText: 'Partial Content',
        arrayBuffer: async () => bufferToArrayBuffer(slice),
      };
    }) as unknown as typeof fetch;

    const archive = new STTArchive({ url: ds.manifestUrl, fetch: flaky });
    await archive.getIndex();
    // The bad bytes are cached BEFORE the decode that rejects them, so the
    // first read throws with the poison resident.
    await expect(archive.getTile(id)).rejects.toThrow(/crc32c mismatch/);
    expect(archive.getCacheStats().size).toBe(1);
    // The retry hits the cache, fails to decode, DROPS the entry and falls
    // through to the network once — which is the self-heal.
    const healed = await archive.getTile(id);
    expect(healed).not.toBeNull();
    expect(served).toBe(2);
    expect(archive.getCacheStats().size).toBe(1);
  });

  it('rejects a pack server that ignores Range requests', async () => {
    // The manifest + directory are whole-object GETs (200 is correct for them),
    // but a PACK read uses Range — a server that replies 200 there would
    // silently corrupt every offset-based read, so the reader must reject it.
    const dataset = packedFromGolden({
      manifestUrl: 'mem://m/manifest.json',
    });
    const badFetch = (async (url: string) => {
      const key = url.startsWith('mem://m/')
        ? url.slice('mem://m/'.length)
        : url;
      const bytes = dataset.objects.get(key)!;
      // Always reply 200 with the whole object, ignoring any Range header.
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => bufferToArrayBuffer(bytes),
      };
    }) as unknown as typeof fetch;
    const archive = new STTArchive({
      url: 'mem://m/manifest.json',
      fetch: badFetch,
    });
    const index = await archive.getIndex(); // whole-GET, fine
    const e = index.tiles[0];
    await expect(
      archive.getTile({ z: e.zoom, x: e.x, y: e.y, t: e.timeStart }),
    ).rejects.toThrow(/Range/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// BH-8 — playhead-aware victim choice in the compressed-byte LRU (§7.6).
// ──────────────────────────────────────────────────────────────────────────

/** Spacing between synthetic tiles, and the archive's declared bucket. */
const STEP_MS = 1000;

/**
 * A packed dataset of `count` tiles at ONE spatial cell, one per temporal
 * bucket (`timeStart = i × STEP_MS`), each carrying a real decodable blob
 * copied from the golden fixture. This is the cyclic-scan adversary's data:
 * every tile is the same size, so residency is purely a policy question.
 */
function timelineDataset(count: number, url: string) {
  const src = packedFromGolden();
  const srcManifest = JSON.parse(
    new TextDecoder().decode(src.objects.get('manifest.json')!),
  );
  const packKeys = [...src.objects.keys()]
    .filter((k) => k.startsWith('packs/'))
    .sort();
  // Any real blob will do; take the first directory entry's.
  const meta = srcManifest.metadata;
  return (async () => {
    const probe = new STTArchive({
      url: src.manifestUrl,
      fetch: packedFetch(src),
    });
    const idx = await probe.getIndex();
    const t0 = idx.tiles[0];
    const srcPack = src.objects.get(packKeys[t0.packId])!;
    const blob = srcPack.subarray(t0.offset, t0.offset + t0.length);

    const pack = new Uint8Array(blob.length * count);
    const entries = [];
    for (let i = 0; i < count; i++) {
      pack.set(blob, i * blob.length);
      entries.push({
        zoom: t0.zoom,
        x: t0.x,
        y: t0.y,
        timeStart: i * STEP_MS,
        timeEnd: i * STEP_MS + STEP_MS - 1,
        packId: 0,
        offset: i * blob.length,
        length: blob.length,
        uncompressedSize: t0.uncompressedSize,
        featureCount: t0.featureCount,
        hilbert: i,
        crc32c: crc32c(blob),
      });
    }
    const dirObject = directoryObject(encodeDirectory(entries));
    const dKey = directoryKey(dirObject);
    const pKey = packKey(pack);
    const objects = new Map<string, Uint8Array>();
    objects.set(dKey, dirObject);
    objects.set(pKey, pack);
    objects.set(
      'manifest.json',
      new TextEncoder().encode(
        JSON.stringify({
          format: 'stt-packed',
          formatVersion: 3,
          variants: [{ id: 0, kind: 'raw' }],
          compression: 'zstd',
          directory: {
            key: dKey,
            length: dirObject.length,
            directoryVersion: 6,
          },
          packs: [{ key: pKey, length: pack.length }],
          metadata: {
            ...meta,
            temporal_bucket_ms: STEP_MS,
            time_range: { start: 0, end: count * STEP_MS },
          },
        }),
      ),
    );
    const ids = entries.map((en) => ({
      z: en.zoom,
      x: en.x,
      y: en.y,
      t: en.timeStart,
    }));
    return { objects, manifestUrl: url, ids, blobLength: blob.length };
  })();
}

/** A fetch over an in-memory object map that counts pack RANGE requests. */
function countingRangeFetch(
  objects: Map<string, Uint8Array>,
  base: string,
): { fetch: typeof fetch; stats: { ranges: number; bytes: number } } {
  const stats = { ranges: 0, bytes: 0 };
  const fn = (async (url: string, init?: RequestInit) => {
    const key = url.startsWith(base) ? url.slice(base.length) : url;
    const bytes = objects.get(key)!;
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    const m = /bytes=(\d+)-(\d+)/.exec(range ?? '');
    if (!m) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => bufferToArrayBuffer(bytes),
      };
    }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), bytes.length - 1);
    stats.ranges++;
    stats.bytes += end - start + 1;
    const slice = bytes.subarray(start, end + 1);
    return {
      ok: true,
      status: 206,
      statusText: 'Partial Content',
      arrayBuffer: async () => bufferToArrayBuffer(slice),
    };
  }) as unknown as typeof fetch;
  return { fetch: fn, stats };
}

describe('BH-8 — loop-aware eviction score', () => {
  const fwd = { time: 10_000, direction: 1 } as const;

  it('scores 0 for every entry when no playhead was ever threaded', () => {
    for (const t of [0, 5_000, 10_000, 1e12, Number.NaN]) {
      expect(byteCacheEvictionScore(t, STEP_MS, null, null)).toBe(0);
      expect(
        byteCacheEvictionScore(t, STEP_MS, null, { start: 0, end: 16_000 }),
      ).toBe(0);
    }
  });

  it('without a loop, ranks already-passed data above upcoming data', () => {
    const ahead = byteCacheEvictionScore(12_000, STEP_MS, fwd, null);
    const further = byteCacheEvictionScore(20_000, STEP_MS, fwd, null);
    const behind = byteCacheEvictionScore(9_000, STEP_MS, fwd, null);
    expect(ahead).toBe(2_000);
    expect(further).toBe(10_000);
    // Behind the head is pushed past EVERY upcoming distance.
    expect(behind).toBeGreaterThan(further);
  });

  it('is direction-aware', () => {
    const back = { time: 10_000, direction: -1 } as const;
    // Reverse playback: earlier data is what is coming up.
    expect(byteCacheEvictionScore(8_000, STEP_MS, back, null)).toBe(1_000);
    expect(byteCacheEvictionScore(12_000, STEP_MS, back, null)).toBeGreaterThan(
      byteCacheEvictionScore(8_000, STEP_MS, back, null),
    );
  });

  it('under a loop, protects the wrap-around approach and spends what was just passed', () => {
    const loop = { start: 0, end: 16_000 };
    const head = { time: 15_000, direction: 1 } as const;
    // A tile just past the LOOP START, seen from a head near the loop end, is
    // the most imminent thing in the cache…
    const justPastStart = byteCacheEvictionScore(0, STEP_MS, head, loop);
    // …while one the head has just passed is a full lap away.
    const justPassed = byteCacheEvictionScore(14_000, STEP_MS, head, loop);
    expect(justPastStart).toBe(1_000);
    expect(justPassed).toBe(15_000);
    expect(justPastStart).toBeLessThan(justPassed);
    // Without the loop the ranking is exactly inverted — that inversion IS
    // the cyclic-scan pathology BH-8 repairs.
    expect(byteCacheEvictionScore(0, STEP_MS, head, null)).toBeGreaterThan(
      byteCacheEvictionScore(14_000, STEP_MS, head, null),
    );
  });

  it('ranks a tile outside the declared loop above every in-loop tile', () => {
    const loop = { start: 4_000, end: 12_000 };
    const head = { time: 5_000, direction: 1 } as const;
    const outside = byteCacheEvictionScore(50_000, STEP_MS, head, loop);
    for (let t = 4_000; t <= 11_000; t += STEP_MS) {
      expect(byteCacheEvictionScore(t, STEP_MS, head, loop)).toBeLessThan(
        outside,
      );
    }
  });

  it('generalizes the un-looped metric: an upcoming in-loop tile scores the same either way', () => {
    const loop = { start: 0, end: 100_000 };
    const head = { time: 10_000, direction: 1 } as const;
    for (const t of [10_000, 12_000, 40_000]) {
      expect(byteCacheEvictionScore(t, STEP_MS, head, loop)).toBe(
        byteCacheEvictionScore(t, STEP_MS, head, null),
      );
    }
  });
});

describe('BH-8 — the bounded K-oldest victim scan', () => {
  /** An LRU-ordered map of `n` entries keyed `k0…k(n-1)` (k0 = oldest). */
  const lru = (n: number): Map<string, number> =>
    new Map(Array.from({ length: n }, (_, i) => [`k${i}`, i]));

  it('scanLimit = 1 is exactly the incumbent evict-the-oldest LRU', () => {
    const m = lru(20);
    // Even with a score that screams "evict the newest", K = 1 cannot.
    expect(selectLruVictim(m, (_k, v) => v, 1)![0]).toBe('k0');
  });

  it('ties go to the oldest — so an all-equal score is byte-identical to LRU', () => {
    const m = lru(20);
    expect(selectLruVictim(m, () => 0)![0]).toBe('k0');
    expect(selectLruVictim(m, () => 7)![0]).toBe('k0');
    // Non-finite scores are treated as 0 rather than poisoning the scan.
    expect(selectLruVictim(m, () => Number.NaN)![0]).toBe('k0');
  });

  it('never picks outside the K oldest, however attractive the newer entries', () => {
    const m = lru(50);
    // Score rises monotonically with recency: the most evictable entry by
    // score is the NEWEST, which the scan bound must refuse to consider.
    const victim = selectLruVictim(m, (_k, v) => v)!;
    expect(victim[0]).toBe(`k${EVICT_SCAN_LIMIT - 1}`);
    expect(victim[1]).toBeLessThan(EVICT_SCAN_LIMIT);
  });

  it('returns undefined for an empty cache', () => {
    expect(selectLruVictim(new Map<string, number>(), () => 1)).toBeUndefined();
  });
});

describe('BH-8 — the cyclic-scan adversary, end to end', () => {
  const N = 16; // working set
  const CAP = 8; // cache = 50% of it
  const LAPS = 3;

  /**
   * Play `LAPS` laps of a cyclic scan through an archive, one tile per
   * `getTiles` call. `mode` picks what the player declares:
   *  - `'blind'`  — nothing (today's consumers): pure LRU;
   *  - `'linear'` — a play-head, no loop;
   *  - `'loop'`   — a play-head AND the loop window.
   */
  async function playLaps(mode: 'blind' | 'linear' | 'loop') {
    const ds = await timelineDataset(N, `mem://lru-${mode}/manifest.json`);
    const { fetch: f, stats } = countingRangeFetch(
      ds.objects,
      `mem://lru-${mode}/`,
    );
    const archive = new STTArchive({
      url: ds.manifestUrl,
      fetch: f,
      maxCacheTiles: CAP,
      // Only the count cap may bind, so the trace is a clean slot argument.
      maxCacheBytes: 1 << 30,
      coalesceGapBytes: 0,
    });
    await archive.getIndex();
    if (mode === 'loop') {
      archive.setLoopWindow({ start: 0, end: N * STEP_MS });
    }
    const perLap: number[] = [];
    const bytesPerLap: number[] = [];
    for (let lap = 0; lap < LAPS; lap++) {
      const before = stats.ranges;
      const bytesBefore = stats.bytes;
      for (let i = 0; i < N; i++) {
        const options =
          mode === 'blind'
            ? undefined
            : { playheadTime: i * STEP_MS, playheadDirection: 1 as const };
        const [tile] = await archive.getTiles([ds.ids[i]], options);
        expect(tile).not.toBeNull();
      }
      perLap.push(stats.ranges - before);
      bytesPerLap.push(stats.bytes - bytesBefore);
    }
    return { perLap, bytesPerLap, stats, archive };
  }

  it('LRU refetches its whole working set every lap (the §7.6 pathology)', async () => {
    const { perLap } = await playLaps('blind');
    // Classic cyclic-scan LRU: capacity < working set ⇒ zero hits, forever.
    expect(perLap).toEqual([N, N, N]);
  });

  it('a declared loop turns those refetches into hits', async () => {
    const loop = await playLaps('loop');
    const blind = await playLaps('blind');
    // Lap 1 is cold for both — nothing to retain yet.
    expect(loop.perLap[0]).toBe(N);
    // Every later lap serves a strictly better byte hit rate than plain LRU —
    // and by the item's own acceptance bar, at least 2× fewer refetched bytes
    // from loop 2 onward (measured: 16 → 8 tiles per lap, i.e. exactly the
    // Belady ceiling for a cache holding half the working set).
    for (let lap = 1; lap < LAPS; lap++) {
      expect(loop.perLap[lap] * 2).toBeLessThanOrEqual(blind.perLap[lap]);
    }
    // All tiles are the same size here, so the tile counts above ARE the byte
    // ratio; assert it in bytes too, since bytes are the metric of record.
    expect(loop.bytesPerLap[1] * 2).toBeLessThanOrEqual(blind.bytesPerLap[1]);
    const loopHitRate =
      loop.archive.getCacheStats().hits /
      (loop.archive.getCacheStats().hits + loop.archive.getCacheStats().misses);
    expect(loopHitRate).toBeGreaterThan(0.3);
    expect(blind.archive.getCacheStats().hits).toBe(0);
  });

  it('is deterministic: the same trace evicts the same tiles', async () => {
    const a = await playLaps('loop');
    const b = await playLaps('loop');
    expect(a.perLap).toEqual(b.perLap);
    expect(a.stats.bytes).toBe(b.stats.bytes);
    expect(a.archive.getCacheStats().evictions).toBe(
      b.archive.getCacheStats().evictions,
    );
  });

  it('a play-head WITHOUT a loop is no worse than plain LRU', async () => {
    // The un-looped metric ranks furthest-behind first, which on a monotonic
    // trace is the LRU order — the scan can only reorder within its window,
    // never below the incumbent.
    const linear = await playLaps('linear');
    const blind = await playLaps('blind');
    for (let lap = 0; lap < LAPS; lap++) {
      expect(linear.perLap[lap]).toBeLessThanOrEqual(blind.perLap[lap]);
    }
  });

  it('never evicts a tile the scan bound puts out of reach, whatever the playhead says', async () => {
    // The safety property is per-eviction: the victim is always among the K
    // OLDEST, so an entry sitting deeper than K in the LRU order cannot be
    // chosen — recency still outranks the play-head. (It is NOT permanent
    // immunity: once the older entries ahead of it are spent, a touched entry
    // re-enters the window like anything else.)
    const RESIDENT = EVICT_SCAN_LIMIT + 5; // > K + 1, so the bound bites
    const TILES = 2 * RESIDENT;
    const ds = await timelineDataset(TILES, 'mem://lru-safety/manifest.json');
    const { fetch: f, stats } = countingRangeFetch(
      ds.objects,
      'mem://lru-safety/',
    );
    const archive = new STTArchive({
      url: ds.manifestUrl,
      fetch: f,
      maxCacheTiles: RESIDENT,
      maxCacheBytes: 1 << 30,
      coalesceGapBytes: 0,
    });
    await archive.getIndex();
    archive.setLoopWindow({ start: 0, end: TILES * STEP_MS });
    for (let i = 0; i < RESIDENT; i++) {
      await archive.getTiles([ds.ids[i]], {
        playheadTime: i * STEP_MS,
        playheadDirection: 1,
      });
    }
    // Re-touch tile 0: it becomes the MOST recently used entry while ALSO
    // being the one the loop metric most wants to spend (the head has just
    // passed it, so it is a full lap from being needed again).
    await archive.getTiles([ds.ids[0]], {
      playheadTime: STEP_MS,
      playheadDirection: 1,
    });
    const evictions = archive.getCacheStats().evictions;
    // Force evictions with the head parked right behind tile 0 — but stop
    // while tile 0 is still deeper than K entries from the oldest end.
    const forced = RESIDENT - 1 - EVICT_SCAN_LIMIT;
    expect(forced).toBeGreaterThan(0);
    for (let i = 0; i < forced; i++) {
      await archive.getTiles([ds.ids[RESIDENT + i]], {
        playheadTime: STEP_MS,
        playheadDirection: 1,
      });
    }
    expect(archive.getCacheStats().evictions).toBe(evictions + forced);
    const before = stats.ranges;
    const [tile] = await archive.getTiles([ds.ids[0]], {
      playheadTime: STEP_MS,
      playheadDirection: 1,
    });
    expect(tile).not.toBeNull();
    expect(stats.ranges).toBe(before); // served from cache: never evicted
  });

  /**
   * The eviction policy, replayed as a pure trace over the SAME primitives
   * the archive uses (`selectLruVictim` + `byteCacheEvictionScore`) so a
   * thousand-access experiment doesn't need a thousand fetches. Returns the
   * hit count.
   */
  function replay(
    trace: number[],
    cap: number,
    opts: {
      loop?: { start: number; end: number } | null;
      scanLimit?: number;
      threadPlayhead?: boolean;
    },
  ): number {
    const cache = new Map<number, { timeStart: number }>();
    let playhead: { time: number; direction: 1 | -1 } | null = null;
    let hits = 0;
    for (const t of trace) {
      if (opts.threadPlayhead) playhead = { time: t, direction: 1 };
      const resident = cache.get(t);
      if (resident) {
        hits++;
        cache.delete(t); // touch → MRU, exactly like touchCachedBytes
        cache.set(t, resident);
        continue;
      }
      cache.set(t, { timeStart: t });
      while (cache.size > cap) {
        const victim = selectLruVictim(
          cache,
          (_k, v) =>
            byteCacheEvictionScore(
              v.timeStart,
              STEP_MS,
              playhead,
              opts.loop ?? null,
            ),
          opts.scanLimit,
        );
        if (!victim) break;
        cache.delete(victim[0]);
      }
    }
    return hits;
  }

  it('EVICT_SCAN_LIMIT = 1 replays as the incumbent LRU, playhead or not', () => {
    const trace: number[] = [];
    for (let lap = 0; lap < 4; lap++) {
      for (let i = 0; i < N; i++) trace.push(i * STEP_MS);
    }
    const loop = { start: 0, end: N * STEP_MS };
    const lru = replay(trace, CAP, { scanLimit: 1 });
    expect(lru).toBe(0); // the cyclic-scan pathology, reproduced
    expect(
      replay(trace, CAP, { scanLimit: 1, threadPlayhead: true, loop }),
    ).toBe(lru);
    // …and the same trace under the shipped scan limit is strictly better.
    expect(replay(trace, CAP, { threadPlayhead: true, loop })).toBeGreaterThan(
      lru,
    );
  });

  it('on NON-cyclic random traces it never falls materially below plain LRU', () => {
    // Deterministic LCG — no Math.random, so a red run is reproducible.
    let seed = 0x2545f491;
    const rand = (n: number): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % n;
    };
    const SPAN = 64;
    const loop = { start: 0, end: SPAN * STEP_MS };
    for (let run = 0; run < 8; run++) {
      const trace: number[] = [];
      for (let i = 0; i < 600; i++) trace.push(rand(SPAN) * STEP_MS);
      const lru = replay(trace, 16, { scanLimit: 1 });
      const aware = replay(trace, 16, { threadPlayhead: true, loop });
      // The scan can only reorder WITHIN its window, so the downside is
      // bounded; ε here is 5% of accesses.
      expect(aware).toBeGreaterThanOrEqual(
        lru - Math.ceil(0.05 * trace.length),
      );
    }
  });

  it('shared-LRU: under one budget, a looping archive keeps its imminent tiles', () => {
    // Shape a map exactly like the process-shared LRU: entries from TWO
    // archives, oldest first, each scoring through its OWN live playhead.
    const looping = {
      playhead: { time: 15_000, direction: 1 as const },
      loop: { start: 0, end: 16_000 },
    };
    const linear = {
      playhead: { time: 40_000, direction: 1 as const },
      loop: null,
    };
    const entry = (
      owner: typeof looping | typeof linear,
      timeStart: number,
    ) => ({
      // The production closure captures the tile's own timeStart and reads
      // the OWNER's live fields — never a snapshot of them.
      score: () =>
        byteCacheEvictionScore(timeStart, STEP_MS, owner.playhead, owner.loop),
    });
    const lru = new Map<string, { score: () => number }>([
      // Oldest first. The looping archive's tile sits just past its loop
      // start: LRU-oldest, but the most imminent thing in the process.
      ['loop:0', entry(looping, 0)],
      ['loop:1', entry(looping, 1_000)],
      ['linear:passed', entry(linear, 30_000)],
      ['linear:upcoming', entry(linear, 41_000)],
    ]);
    const victim = selectLruVictim(lru, (_t, e) => e.score());
    // The NON-looping archive's already-passed tile is spent first, even
    // though it is NEWER in the shared LRU than either looping entry: that
    // archive will never ask for it again, while the looping one will.
    expect(victim![0]).toBe('linear:passed');
    lru.delete(victim![0]);

    // Next: within the looping archive, the tile the head has just passed
    // goes before the one it is about to reach — the wrap-aware choice.
    const next = selectLruVictim(lru, (_t, e) => e.score());
    expect(next![0]).toBe('loop:1');

    // LIVE, not captured: rewind the looping archive's head to just before
    // its loop start and the SAME map yields a different victim — `loop:0`
    // is now the tile it has just passed, `loop:1` the one coming up.
    // Nothing was re-registered to make this happen.
    looping.playhead = { time: 500, direction: 1 };
    expect(selectLruVictim(lru, (_t, e) => e.score())![0]).toBe('loop:0');
  });

  it('setLoopWindow rejects a degenerate range (kill switch stays armed)', async () => {
    const ds = await timelineDataset(4, 'mem://lru-degenerate/manifest.json');
    const { fetch: f } = countingRangeFetch(
      ds.objects,
      'mem://lru-degenerate/',
    );
    const archive = new STTArchive({ url: ds.manifestUrl, fetch: f });
    for (const bad of [
      null,
      { start: 5, end: 5 },
      { start: 5, end: 1 },
      { start: Number.NaN, end: 10 },
      { start: 0, end: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => archive.setLoopWindow(bad)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// FS-2 — `getAvailableTilesForCells`, the cell-addressed directory slice
//
// The frustum path selects a MIXED-ZOOM antichain, which no `(bounds, zoom)`
// pair can express, so the reader grew a query that takes cells verbatim. The
// contract that matters is PARITY: for any cell list, the answer must be
// exactly what the box query returns restricted to those cells. If the two ever
// disagree, the frustum path is fetching a different set from the one every
// existing test, oracle and byte estimate is written against — and the
// disagreement would present as missing data on a map, not as a red test
// anywhere else.
// ---------------------------------------------------------------------------

const CELLS_HOUR = 3_600_000;
const CELLS_DAY = 24 * CELLS_HOUR;

interface CellSynthEntry {
  zoom: number;
  x: number;
  y: number;
  timeStart: number;
  timeEnd: number;
  length: number;
  variantId?: number;
  bucketMs?: number;
  coverTMin?: number;
}

let cellSynthSeq = 0;

/** A synthetic packed archive with per-entry control over tier and variant. */
function buildCellArchive(opts: {
  entries: CellSynthEntry[];
  metadata: Record<string, unknown>;
  variants?: Array<{ id: number; kind: 'raw' | 'summary' }>;
}): STTArchive {
  const blobs = opts.entries.map((e) => new Uint8Array(e.length).fill(7));
  const { bytes: pack, offsets } = packObject(blobs);
  const dirObject = directoryObject(
    encodeDirectory(
      opts.entries.map((e, i) => ({
        zoom: e.zoom,
        x: e.x,
        y: e.y,
        timeStart: e.timeStart,
        timeEnd: e.timeEnd,
        variantId: e.variantId ?? 0,
        packId: 0,
        offset: offsets[i],
        length: e.length,
        uncompressedSize: e.length,
        featureCount: 1,
        hilbert: 0,
        crc32c: 0,
        temporalBucketMs: e.bucketMs,
        coverTMin: e.coverTMin,
      })),
    ),
  );
  const objects = new Map<string, Uint8Array>();
  objects.set('packs/p0.sttp', pack);
  objects.set('index/dir.sttd', dirObject);
  objects.set(
    'manifest.json',
    new TextEncoder().encode(
      JSON.stringify({
        format: 'stt-packed',
        formatVersion: 3,
        variants: opts.variants ?? [{ id: 0, kind: 'raw' }],
        compression: 'none',
        directory: {
          key: 'index/dir.sttd',
          length: dirObject.byteLength,
          directoryVersion: 6,
        },
        packs: [{ key: 'packs/p0.sttp', length: pack.byteLength }],
        metadata: opts.metadata,
      }),
    ),
  );
  const ds: InMemoryPackedDataset = {
    objects,
    manifestUrl: `mem://cells-${cellSynthSeq++}/manifest.json`,
  };
  return new STTArchive({ url: ds.manifestUrl, fetch: packedFetch(ds) });
}

const CELLS_META = {
  name: 'cells',
  bounds: { min_lon: -180, min_lat: -85, max_lon: 180, max_lat: 85 },
  time_range: { start: 0, end: CELLS_DAY },
  temporal_bucket_ms: CELLS_HOUR,
  min_zoom: 0,
  max_zoom: 12,
};

const CELLS_WORLD = { minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 };

/** `z/x/y@t` keys, sorted — the order-independent form the parity tests use. */
function idKeys(ids: Array<{ z: number; x: number; y: number; t: number }>) {
  return ids.map((i) => `${i.z}/${i.x}/${i.y}@${i.t}`).sort();
}

describe('STTArchive.getAvailableTilesForCells', () => {
  it('equals the bounds slice RESTRICTED to the named cells', async () => {
    const archive = buildCellArchive({
      metadata: CELLS_META,
      entries: [
        {
          zoom: 5,
          x: 16,
          y: 16,
          timeStart: 0,
          timeEnd: CELLS_HOUR,
          length: 10,
        },
        {
          zoom: 5,
          x: 17,
          y: 16,
          timeStart: 0,
          timeEnd: CELLS_HOUR,
          length: 20,
        },
        {
          zoom: 5,
          x: 18,
          y: 16,
          timeStart: 0,
          timeEnd: CELLS_HOUR,
          length: 30,
        },
        {
          zoom: 5,
          x: 16,
          y: 16,
          timeStart: CELLS_HOUR,
          timeEnd: 2 * CELLS_HOUR,
          length: 40,
        },
      ],
    });
    const range = { start: 0, end: 3 * CELLS_HOUR };
    const all = await archive.getTileIdsInBounds(CELLS_WORLD, 5, range);
    expect(all.length).toBe(4);

    // Two of the three occupied columns: the answer is the box answer with the
    // third column removed — every entry of the two kept cells, nothing else.
    const cells = [
      { z: 5, x: 16, y: 16, t: 0 },
      { z: 5, x: 18, y: 16, t: 0 },
    ];
    const sliced = await archive.getAvailableTilesForCells(cells, range);
    expect(idKeys(sliced)).toEqual(
      idKeys(all.filter((id) => id.x === 16 || id.x === 18)),
    );
    // Both temporal entries of cell (16,16) came through — a cell address is
    // spatial, and the time filter is the range, not the cell's `t`.
    expect(sliced.filter((id) => id.x === 16).length).toBe(2);
  });

  it('is MIXED-ZOOM — one call spans zooms no single box query could', async () => {
    const archive = buildCellArchive({
      metadata: CELLS_META,
      entries: [
        { zoom: 4, x: 8, y: 8, timeStart: 0, timeEnd: CELLS_HOUR, length: 10 },
        {
          zoom: 5,
          x: 16,
          y: 16,
          timeStart: 0,
          timeEnd: CELLS_HOUR,
          length: 20,
        },
        {
          zoom: 7,
          x: 64,
          y: 64,
          timeStart: 0,
          timeEnd: CELLS_HOUR,
          length: 30,
        },
      ],
    });
    const range = { start: 0, end: CELLS_DAY };
    const ids = await archive.getAvailableTilesForCells(
      [
        { z: 4, x: 8, y: 8, t: 0 },
        { z: 5, x: 16, y: 16, t: 0 },
        { z: 7, x: 64, y: 64, t: 0 },
      ],
      range,
    );
    expect(idKeys(ids)).toEqual(['4/8/8@0', '5/16/16@0', '7/64/64@0']);
    // ... and each of those is exactly what its own box query would return.
    for (const z of [4, 5, 7]) {
      const box = await archive.getTileIdsInBounds(CELLS_WORLD, z, range);
      expect(idKeys(ids.filter((i) => i.z === z))).toEqual(idKeys(box));
    }
  });

  it('applies the SAME temporal-overlap filter as the bounds query', async () => {
    const archive = buildCellArchive({
      metadata: CELLS_META,
      entries: [
        {
          zoom: 5,
          x: 16,
          y: 16,
          timeStart: 0,
          timeEnd: CELLS_HOUR,
          length: 10,
        },
        {
          zoom: 5,
          x: 16,
          y: 16,
          timeStart: CELLS_HOUR,
          timeEnd: 2 * CELLS_HOUR,
          length: 20,
        },
        {
          zoom: 5,
          x: 16,
          y: 16,
          timeStart: 2 * CELLS_HOUR,
          timeEnd: 3 * CELLS_HOUR,
          length: 30,
          // A covering bound that pushes this tile's real data past the window.
          coverTMin: 2.5 * CELLS_HOUR,
        },
      ],
    });
    const cells = [{ z: 5, x: 16, y: 16, t: 0 }];
    for (const range of [
      { start: 0, end: CELLS_HOUR - 1 },
      { start: 0, end: 2 * CELLS_HOUR },
      { start: 0, end: 2.4 * CELLS_HOUR },
      { start: 0, end: CELLS_DAY },
      { start: 10 * CELLS_HOUR, end: 11 * CELLS_HOUR },
    ]) {
      expect(
        idKeys(await archive.getAvailableTilesForCells(cells, range)),
      ).toEqual(
        idKeys(await archive.getTileIdsInBounds(CELLS_WORLD, 5, range)),
      );
    }
  });

  it('is WRAP-AWARE: a seam column is addressed by its wrapped x', async () => {
    // `coverFrustumQuadtree` emits `x mod 2^z`, matching the archive scan's
    // wrap-at-emit contract. So the far side of the antimeridian arrives here
    // as column 0 / column 2^z−1, and both must resolve — this is the
    // `ais-all-us` / `drifters` regression class.
    const archive = buildCellArchive({
      metadata: CELLS_META,
      entries: [
        { zoom: 3, x: 0, y: 3, timeStart: 0, timeEnd: CELLS_HOUR, length: 10 },
        { zoom: 3, x: 7, y: 3, timeStart: 0, timeEnd: CELLS_HOUR, length: 20 },
      ],
    });
    const range = { start: 0, end: CELLS_DAY };
    const ids = await archive.getAvailableTilesForCells(
      [
        { z: 3, x: 7, y: 3, t: 0 },
        { z: 3, x: 0, y: 3, t: 0 },
      ],
      range,
    );
    expect(idKeys(ids)).toEqual(['3/0/3@0', '3/7/3@0']);
    // The equivalent seam-crossing box selects the same two columns.
    const box = await archive.getTileIdsInBounds(
      { minLon: 170, minLat: -85, maxLon: -170, maxLat: 85 },
      3,
      range,
    );
    expect(idKeys(box)).toEqual(idKeys(ids));
  });

  it('isolates temporal-LOD tiers in both directions', async () => {
    const archive = buildCellArchive({
      metadata: {
        ...CELLS_META,
        temporal_lod: [{ bucket_ms: CELLS_DAY, max_zoom_level: 8 }],
      },
      entries: [
        {
          zoom: 5,
          x: 16,
          y: 16,
          timeStart: 0,
          timeEnd: CELLS_HOUR,
          length: 10,
          bucketMs: CELLS_HOUR,
        },
        // The coarse tier shares z/x/y/timeStart with the base tile above it.
        {
          zoom: 5,
          x: 16,
          y: 16,
          timeStart: 0,
          timeEnd: CELLS_DAY,
          length: 50,
          bucketMs: CELLS_DAY,
        },
      ],
    });
    const cells = [{ z: 5, x: 16, y: 16, t: 0 }];
    const range = { start: 0, end: CELLS_DAY };

    // Default: the base tier only, exactly as getTileIdsInBounds filters.
    const base = await archive.getAvailableTilesForCells(cells, range);
    expect(base.length).toBe(1);
    expect(base[0].bucketMs).toBeUndefined();
    expect(idKeys(base)).toEqual(
      idKeys(await archive.getTileIdsInBounds(CELLS_WORLD, 5, range)),
    );

    // `{ bucketMs }`: the coarse tier, STAMPED so it cannot alias the base
    // tile it shares an address with.
    const lod = await archive.getAvailableTilesForCells(cells, range, {
      bucketMs: CELLS_DAY,
    });
    expect(lod.length).toBe(1);
    expect(lod[0].bucketMs).toBe(CELLS_DAY);
    expect(idKeys(lod)).toEqual(
      idKeys(
        await archive.getTileIdsInBoundsForTemporalLod(
          CELLS_WORLD,
          5,
          range,
          CELLS_DAY,
        ),
      ),
    );

    // A tier the archive does not carry is empty, never a fallback.
    expect(
      await archive.getAvailableTilesForCells(cells, range, {
        bucketMs: 7 * CELLS_DAY,
      }),
    ).toEqual([]);
  });

  it('dispatches the summary tier, with its zoom gate applied PER CELL', async () => {
    const archive = buildCellArchive({
      metadata: {
        ...CELLS_META,
        summary_tier: {
          variant_id: 1,
          scheme: 'h3',
          min_zoom: 4,
          max_zoom: 6,
          cell_resolution_per_zoom: [0, 0, 0, 0, 3, 4, 5],
          columns: [{ name: 'n', agg: 'count' }],
          layer_name: 'summary',
          sub_buckets: 1,
        },
      },
      variants: [
        { id: 0, kind: 'raw' },
        { id: 1, kind: 'summary' },
      ],
      entries: [
        {
          zoom: 5,
          x: 16,
          y: 16,
          timeStart: 0,
          timeEnd: CELLS_HOUR,
          length: 10,
        },
        {
          zoom: 5,
          x: 16,
          y: 16,
          timeStart: 0,
          timeEnd: CELLS_HOUR,
          length: 20,
          variantId: 1,
        },
        {
          zoom: 8,
          x: 128,
          y: 128,
          timeStart: 0,
          timeEnd: CELLS_HOUR,
          length: 30,
          variantId: 1,
        },
      ],
    });
    const range = { start: 0, end: CELLS_DAY };
    // z5 is inside the declared summary range, z8 is outside it. A MIXED-ZOOM
    // cut can straddle that boundary, so the gate is per cell: the z5 cell
    // yields its summary tile and the z8 cell yields nothing — which is
    // exactly what the two separate box queries return.
    const ids = await archive.getAvailableTilesForCells(
      [
        { z: 5, x: 16, y: 16, t: 0 },
        { z: 8, x: 128, y: 128, t: 0 },
      ],
      range,
      { tier: 'summary' },
    );
    expect(ids.length).toBe(1);
    expect(ids[0]).toMatchObject({ z: 5, x: 16, y: 16, variantId: 1 });
    expect(idKeys(ids)).toEqual(
      idKeys(await archive.getSummaryTileIdsInBounds(CELLS_WORLD, 5, range)),
    );
    expect(
      await archive.getSummaryTileIdsInBounds(CELLS_WORLD, 8, range),
    ).toEqual([]);

    // `tier: 'raw'` over the same cells is the raw variant, unchanged.
    const raw = await archive.getAvailableTilesForCells(
      [{ z: 5, x: 16, y: 16, t: 0 }],
      range,
      { tier: 'raw' },
    );
    expect(raw.length).toBe(1);
    expect(raw[0].variantId).toBe(0);
  });

  it('returns [] for the summary tier on an archive that has none', async () => {
    const archive = buildCellArchive({
      metadata: CELLS_META,
      entries: [
        {
          zoom: 5,
          x: 16,
          y: 16,
          timeStart: 0,
          timeEnd: CELLS_HOUR,
          length: 10,
        },
      ],
    });
    expect(
      await archive.getAvailableTilesForCells(
        [{ z: 5, x: 16, y: 16, t: 0 }],
        { start: 0, end: CELLS_DAY },
        { tier: 'summary' },
      ),
    ).toEqual([]);
  });

  it('drops malformed addresses and collapses duplicates instead of trusting them', async () => {
    const archive = buildCellArchive({
      metadata: CELLS_META,
      entries: [
        {
          zoom: 5,
          x: 16,
          y: 16,
          timeStart: 0,
          timeEnd: CELLS_HOUR,
          length: 10,
        },
      ],
    });
    const range = { start: 0, end: CELLS_DAY };
    const good = { z: 5, x: 16, y: 16, t: 0 };

    // A duplicate cell must not duplicate its tiles: a doubled id is a doubled
    // fetch and, downstream, a double draw.
    expect(
      (await archive.getAvailableTilesForCells([good, { ...good }], range))
        .length,
    ).toBe(1);

    // Non-integer, negative and out-of-world addresses are dropped, not
    // repaired — there is no defensible guess at what they meant.
    for (const bad of [
      { z: 5.5, x: 16, y: 16, t: 0 },
      { z: -1, x: 16, y: 16, t: 0 },
      { z: 5, x: -1, y: 16, t: 0 },
      { z: 5, x: 32, y: 16, t: 0 },
      { z: 5, x: 16, y: 32, t: 0 },
      { z: 5, x: NaN, y: 16, t: 0 },
    ]) {
      expect(await archive.getAvailableTilesForCells([bad], range)).toEqual([]);
      // ... and a bad neighbour never poisons a good cell.
      expect(
        (await archive.getAvailableTilesForCells([bad, good], range)).length,
      ).toBe(1);
    }

    // An empty list is an empty answer, not a whole-world scan.
    expect(await archive.getAvailableTilesForCells([], range)).toEqual([]);
  });

  it('is deterministic and ordered by the caller cell list', async () => {
    const archive = buildCellArchive({
      metadata: CELLS_META,
      entries: [
        {
          zoom: 5,
          x: 16,
          y: 16,
          timeStart: 0,
          timeEnd: CELLS_HOUR,
          length: 10,
        },
        {
          zoom: 5,
          x: 17,
          y: 16,
          timeStart: 0,
          timeEnd: CELLS_HOUR,
          length: 20,
        },
        {
          zoom: 5,
          x: 18,
          y: 16,
          timeStart: 0,
          timeEnd: CELLS_HOUR,
          length: 30,
        },
      ],
    });
    const range = { start: 0, end: CELLS_DAY };
    const cells = [
      { z: 5, x: 18, y: 16, t: 0 },
      { z: 5, x: 16, y: 16, t: 0 },
      { z: 5, x: 17, y: 16, t: 0 },
    ];
    const first = await archive.getAvailableTilesForCells(cells, range);
    expect(first.map((i) => i.x)).toEqual([18, 16, 17]);
    expect(await archive.getAvailableTilesForCells(cells, range)).toEqual(
      first,
    );
  });

  it('prices in parity with the byte oracle over real writer output', async () => {
    // Same parity claim as the bounds query's, run over the Rust fixture: the
    // cells path must address a set whose bytes the existing oracle already
    // knows how to price, or every downstream estimate silently drifts.
    const archive = sampleArchive();
    const index = await archive.getIndex();
    const meta = await archive.getMetadata();
    const zoom = index.tiles[0].zoom;
    const cells = [
      ...new Map(
        index.tiles
          .filter((t) => t.zoom === zoom && t.variantId === 0)
          .map((t) => [`${t.x}/${t.y}`, { z: zoom, x: t.x, y: t.y, t: 0 }]),
      ).values(),
    ];
    expect(cells.length).toBeGreaterThan(0);

    const ids = await archive.getAvailableTilesForCells(cells, meta.timeRange);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids)
      expect(archive.getTileByteSize(id)).toBeGreaterThan(0);

    // The cells cover every occupied cell at this zoom, so the answer is the
    // whole box answer. The box is built from the fixture's own tile
    // coordinates rather than from a `±85` world band: the fixture's row is
    // y = 0, whose top edge IS the mercator limit, and a band that stops a
    // rounding step short of it excludes the row entirely.
    const size = 2 ** zoom;
    const toLon = (x: number): number => (x / size) * 360 - 180;
    const toLat = (y: number): number => {
      const n = Math.PI - (2 * Math.PI * y) / size;
      return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    };
    const xs = cells.map((c) => c.x);
    const ys = cells.map((c) => c.y);
    const box = await archive.getTileIdsInBounds(
      {
        minLon: toLon(Math.min(...xs)),
        maxLon: toLon(Math.max(...xs) + 1),
        minLat: toLat(Math.max(...ys) + 1),
        maxLat: toLat(Math.min(...ys)),
      },
      zoom,
      meta.timeRange,
    );
    expect(idKeys(ids)).toEqual(idKeys(box));
  });
});

// ---------------------------------------------------------------------------
// FS-2 — the PAGED half: `ensurePagesForCells`
//
// On a paged directory the query does not just filter entries, it decides which
// leaf pages to FETCH. The bounds form prunes with one box at one zoom; a cut
// is mixed-zoom, so the cell form prunes per cell with that cell's own box AND
// its own zoom. Get that wrong and the columns the entry walk asks for resolve
// against leaves nobody ever fetched — an empty index, which reads exactly like
// "no data here".
//
// The oracle is the one the paged suite already uses: two Rust-produced
// fixtures holding the SAME dataset, one paged and one whole-load, so the
// whole-load build answers what the paged build must answer.
// ---------------------------------------------------------------------------

describe('STTArchive.getAvailableTilesForCells on a paged directory', () => {
  const pagedDs = loadPackedDatasetFromDisk(
    nodeFs,
    fileURLToPath(new URL('./fixtures/paged-golden', import.meta.url)),
    'mem://cells-paged/manifest.json',
  );
  const singleDs = loadPackedDatasetFromDisk(
    nodeFs,
    fileURLToPath(new URL('./fixtures/paged-golden-single', import.meta.url)),
    'mem://cells-single/manifest.json',
  );
  /** Forced to stream every leaf (threshold 0) — no whole-load fast path. */
  const pagedArchive = (log?: PackedFetchLog): STTArchive =>
    new STTArchive({
      url: pagedDs.manifestUrl,
      fetch: packedFetch(pagedDs, log),
      directoryPageThresholdBytes: 0,
    });
  const singleArchive = (): STTArchive =>
    new STTArchive({ url: singleDs.manifestUrl, fetch: packedFetch(singleDs) });

  const PAGED_RANGE = { start: 0, end: 3 * 3_600_000 };

  /** Every occupied cell at `zoom`, from the whole-load oracle. */
  async function occupiedCells(zoom: number) {
    const index = await singleArchive().getIndex();
    return [
      ...new Map(
        index.tiles
          .filter((t) => t.zoom === zoom && t.variantId === 0)
          .map((t) => [`${t.x}/${t.y}`, { z: zoom, x: t.x, y: t.y, t: 0 }]),
      ).values(),
    ];
  }

  it('agrees with the whole-load oracle, cell for cell', async () => {
    const oracle = singleArchive();
    const archive = pagedArchive();
    const index = await oracle.getIndex();
    const zooms = [...new Set(index.tiles.map((t) => t.zoom))].sort();
    expect(zooms.length).toBeGreaterThan(1); // the fixture spans z10 and z12

    for (const zoom of zooms) {
      const cells = await occupiedCells(zoom);
      expect(cells.length).toBeGreaterThan(0);
      expect(
        idKeys(await archive.getAvailableTilesForCells(cells, PAGED_RANGE)),
      ).toEqual(
        idKeys(await oracle.getAvailableTilesForCells(cells, PAGED_RANGE)),
      );
    }
  });

  it('serves a MIXED-ZOOM cut in one call, faulting in every leaf it needs', async () => {
    // The shape the frustum path actually produces: near-field cells deep,
    // far-field cells shallow, in ONE query. Neither zoom's leaves may be
    // pruned by the other's box.
    const oracle = singleArchive();
    const archive = pagedArchive();
    const index = await oracle.getIndex();
    const zooms = [...new Set(index.tiles.map((t) => t.zoom))].sort();
    const mixed = [
      ...(await occupiedCells(zooms[0])).slice(0, 4),
      ...(await occupiedCells(zooms[zooms.length - 1])).slice(0, 4),
    ];
    const ids = await archive.getAvailableTilesForCells(mixed, PAGED_RANGE);
    expect(new Set(ids.map((i) => i.z)).size).toBe(2);
    expect(idKeys(ids)).toEqual(
      idKeys(await oracle.getAvailableTilesForCells(mixed, PAGED_RANGE)),
    );
  });

  it('fetches FEWER directory bytes than the equivalent box query', async () => {
    // The point of a cell-addressed query on a paged directory: it faults in
    // the leaves the named cells touch, not the leaves a box around them
    // touches. Both must return the same tiles for the cells in question.
    const oracle = singleArchive();
    const index = await oracle.getIndex();
    const zoom = index.tiles[0].zoom;
    const cells = (await occupiedCells(zoom)).slice(0, 2);

    const cellLog: PackedFetchLog = { paths: [], ranges: [] };
    const cellArchive = pagedArchive(cellLog);
    const cellIds = await cellArchive.getAvailableTilesForCells(
      cells,
      PAGED_RANGE,
    );
    expect(cellIds.length).toBeGreaterThan(0);

    const boxLog: PackedFetchLog = { paths: [], ranges: [] };
    const boxArchive = pagedArchive(boxLog);
    const boxIds = await boxArchive.getTileIdsInBounds(
      { minLon: -180, minLat: -85.05, maxLon: 180, maxLat: 85.05 },
      zoom,
      PAGED_RANGE,
    );
    // Same answer for the cells asked about — no tile lost to the narrower
    // paging decision.
    const wanted = new Set(cells.map((c) => `${c.z}/${c.x}/${c.y}`));
    expect(idKeys(cellIds)).toEqual(
      idKeys(boxIds.filter((id) => wanted.has(`${id.z}/${id.x}/${id.y}`))),
    );
    // ... for strictly less directory I/O.
    const bytes = (log: PackedFetchLog): number => {
      let total = 0;
      for (const r of log.ranges) {
        if (!r.path.endsWith('.sttd')) continue;
        const m = /bytes=(\d+)-(\d+)/.exec(r.range)!;
        total += Number(m[2]) - Number(m[1]) + 1;
      }
      return total;
    };
    expect(bytes(cellLog)).toBeLessThan(bytes(boxLog));
  });

  it('returns nothing — and stays sound — for cells the archive does not hold', async () => {
    const archive = pagedArchive();
    expect(
      await archive.getAvailableTilesForCells(
        [
          { z: 10, x: 1, y: 1, t: 0 },
          { z: 3, x: 0, y: 0, t: 0 },
        ],
        PAGED_RANGE,
      ),
    ).toEqual([]);
  });
});

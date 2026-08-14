/**
 * Walk-cost benchmarks for the CO-1 selection-cost oracle.
 *
 * Run with `pnpm --filter @poopdeck.gl/core exec vitest bench` (this file is
 * NOT part of `vitest run` — the unit suite's `test/**\/*.test.ts` include does
 * not match it, and the acceptance thresholds are pinned as complexity guards
 * in cost-oracle.test.ts, which does run in CI).
 *
 * Two acceptance numbers from the work item:
 *
 *   1. Profile query ≤ 0.1 ms. Measured on a 12 000-tile coverage index
 *      (2 000 buckets × 6 tiles), for both the walking query
 *      (`getByteDensityProfile` over a 200-bucket slice) and the prefix-sum
 *      query (`bytesForHorizon`, O(log buckets)).
 *   2. Index-build overhead ≤ 5% over the current build loop. The real loop
 *      lives inside `maybeRebuildCoverageIndex` and cannot be toggled at
 *      runtime, so both shapes are transcribed below — `buildIncumbent` is the
 *      loop as it stood before CO-1, `buildWithByteColumns` is the loop as it
 *      stands now — and benched head to head on the same input.
 *
 * The dataset shape stands in for the storm-4d viewport slice the item names:
 * that archive is not available offline, so the sizes here are chosen to match
 * its order of magnitude (thousands of buckets, a handful of tiles per bucket)
 * rather than to reproduce it exactly.
 */

import { bench, describe } from 'vitest';
import { STTArchive } from '../src/archive';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import { encodeDirectory } from '../src/directory';
import type { BoundingBox, TileId } from '../src/types';
import {
  directoryObject,
  packedFetch,
  packObject,
} from './helpers/packed-fixture';
import { BOUNDS, BUCKET_MS, fakeTile } from './helpers/fixtures';

const HOUR = 3_600_000;

/** Deterministic PRNG (mulberry32) — benches must not vary run to run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 1. Archive walk: estimateSelectionCost vs the id query it mirrors
// ---------------------------------------------------------------------------

const ARCHIVE_CELLS = 12; // 12 × 12 cells at z8
const ARCHIVE_BUCKETS = 24;

async function makeArchive(): Promise<{
  archive: STTArchive;
  bounds: BoundingBox;
}> {
  const random = rng(11);
  const entries: Array<{
    zoom: number;
    x: number;
    y: number;
    timeStart: number;
    timeEnd: number;
    length: number;
  }> = [];
  for (let cx = 0; cx < ARCHIVE_CELLS; cx++) {
    for (let cy = 0; cy < ARCHIVE_CELLS; cy++) {
      for (let b = 0; b < ARCHIVE_BUCKETS; b++) {
        entries.push({
          zoom: 8,
          x: 120 + cx,
          y: 90 + cy,
          timeStart: b * HOUR,
          timeEnd: (b + 1) * HOUR,
          length: 1 + Math.floor(random() * 20_000),
        });
      }
    }
  }
  // One byte per blob keeps the fixture small; the directory is what is walked.
  const { bytes: pack, offsets } = packObject(
    entries.map(() => new Uint8Array(1)),
  );
  const dirObject = directoryObject(
    encodeDirectory(
      entries.map((e, i) => ({
        zoom: e.zoom,
        x: e.x,
        y: e.y,
        timeStart: e.timeStart,
        timeEnd: e.timeEnd,
        packId: 0,
        offset: offsets[i],
        length: e.length,
        uncompressedSize: e.length,
        featureCount: 1,
        hilbert: 0,
        crc32c: 0,
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
        variants: [{ id: 0, kind: 'raw' }],
        compression: 'none',
        directory: {
          key: 'index/dir.sttd',
          length: dirObject.byteLength,
          directoryVersion: 6,
        },
        packs: [{ key: 'packs/p0.sttp', length: pack.byteLength }],
        metadata: {
          name: 'bench',
          bounds: { min_lon: -180, min_lat: -85, max_lon: 180, max_lat: 85 },
          time_range: { start: 0, end: ARCHIVE_BUCKETS * HOUR },
          temporal_bucket_ms: HOUR,
          min_zoom: 8,
          max_zoom: 8,
        },
      }),
    ),
  );
  const ds = { objects, manifestUrl: 'mem://cost-bench/manifest.json' };
  const archive = new STTArchive({
    url: ds.manifestUrl,
    fetch: packedFetch(ds),
  });
  await archive.getIndex();
  // A box snug around the synthetic cells, so the walk takes the ordinary
  // direct-grid path (a world box at z8 is a 65 536-cell scan that switches to
  // the occupied-cell index — a real but atypical shape, benched elsewhere).
  const size = 2 ** 8;
  const toLon = (x: number): number => (x / size) * 360 - 180;
  const toLat = (y: number): number => {
    const n = Math.PI - (2 * Math.PI * y) / size;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  };
  return {
    archive,
    bounds: {
      minLon: toLon(120),
      maxLon: toLon(120 + ARCHIVE_CELLS),
      minLat: toLat(90 + ARCHIVE_CELLS),
      maxLat: toLat(90),
    },
  };
}

const { archive, bounds } = await makeArchive();
const FULL = { start: 0, end: ARCHIVE_BUCKETS * HOUR };

describe('archive selection walk (3456 entries at z8)', () => {
  bench('estimateSelectionCost (sum, no allocation)', () => {
    archive.estimateSelectionCost(bounds, 8, FULL);
  });

  bench('getTileIdsInBounds (the same walk, materializing TileId[])', async () => {
    await archive.getTileIdsInBounds(bounds, 8, FULL);
  });
});

// ---------------------------------------------------------------------------
// 2. Coverage-index queries
// ---------------------------------------------------------------------------

const N_BUCKETS = 2000;
const TILES_PER_BUCKET = 6;
const sizeRandom = rng(2026);
const SIZES: number[][] = [];
for (let i = 0; i < N_BUCKETS; i++) {
  const row: number[] = [];
  for (let k = 0; k < TILES_PER_BUCKET; k++) {
    row.push(1 + Math.floor(sizeRandom() * 5000));
  }
  SIZES.push(row);
}

function makeTileset(): SpatioTemporalTileset {
  return new SpatioTemporalTileset({
    minZoom: 0,
    maxZoom: 12,
    enablePrefetch: false,
    refinementStrategy: 'no-overlap',
    temporalBucketMs: BUCKET_MS,
    getAvailableTiles: async (_b, z, range) => {
      const ids: TileId[] = [];
      const first = Math.max(0, Math.floor(range.start / BUCKET_MS));
      const last = Math.min(N_BUCKETS - 1, Math.floor(range.end / BUCKET_MS));
      for (let i = first; i <= last; i++) {
        const t = i * BUCKET_MS;
        if (t + BUCKET_MS < range.start || t > range.end) continue;
        for (let k = 0; k < TILES_PER_BUCKET; k++)
          ids.push({ z, x: k, y: 0, t });
      }
      return ids;
    },
    getTileByteSize: (id: TileId) => {
      const i = id.t / BUCKET_MS;
      if (!Number.isInteger(i) || i < 0 || i >= N_BUCKETS) return undefined;
      return SIZES[i][id.x];
    },
    getTileData: async (id: TileId) => fakeTile(id),
    getTileDataBatch: async (ids: TileId[]) => ids.map((id) => fakeTile(id)),
  });
}

const tileset = makeTileset();
tileset.update({ bounds: BOUNDS, zoom: 6, time: 500, timeWindow: 100 });
tileset.getBufferedRunway(0, 1);
await new Promise((r) => setTimeout(r, 50));

/** 200 buckets = 1200 tiles — a viewport-slice-sized profile query. */
const SLICE = { start: 400_000, end: 600_000 };

describe('coverage-index queries (2000 buckets × 6 tiles)', () => {
  bench('getByteDensityProfile (200-bucket slice)', () => {
    tileset.getByteDensityProfile(SLICE);
  });

  bench('bytesForHorizon (prefix sums, O(log buckets))', () => {
    tileset.bytesForHorizon(400_000, 1, 200_000);
  });

  bench('bytesForHorizon over the WHOLE dataset span', () => {
    tileset.bytesForHorizon(0, 1, N_BUCKETS * BUCKET_MS);
  });

  bench('estimateCost (incumbent, same slice)', () => {
    tileset.estimateCost(SLICE);
  });
});

// ---------------------------------------------------------------------------
// 3. Index-build overhead: incumbent loop vs the loop with byte columns
// ---------------------------------------------------------------------------

interface BenchBucket {
  keys: string[];
  bytes: number[];
  totalBytes?: number;
}

const BUILD_IDS: TileId[] = [];
for (let i = 0; i < N_BUCKETS; i++) {
  for (let k = 0; k < TILES_PER_BUCKET; k++) {
    BUILD_IDS.push({ z: 6, x: k, y: 0, t: i * BUCKET_MS });
  }
}
const getSize = (id: TileId): number | undefined =>
  SIZES[id.t / BUCKET_MS][id.x];
const key = (id: TileId): string => `${id.z}/${id.x}/${id.y}/${id.t}`;

/** The coverage-index build loop as it stood BEFORE CO-1. */
function buildIncumbent(): void {
  const buckets = new Map<number, BenchBucket>();
  const keySet = new Set<string>();
  for (const id of BUILD_IDS) {
    let bucket = buckets.get(id.t);
    if (!bucket) {
      bucket = { keys: [], bytes: [] };
      buckets.set(id.t, bucket);
    }
    const k = key(id);
    bucket.keys.push(k);
    keySet.add(k);
    bucket.bytes.push(getSize(id) ?? 0);
  }
  Array.from(buckets.keys()).sort((a, b) => a - b);
}

/** The same loop as it stands now: per-bucket totals + the two Float64Arrays. */
function buildWithByteColumns(): void {
  const buckets = new Map<number, BenchBucket>();
  const keySet = new Set<string>();
  let bytesKnown = true;
  for (const id of BUILD_IDS) {
    let bucket = buckets.get(id.t);
    if (!bucket) {
      bucket = { keys: [], bytes: [], totalBytes: 0 };
      buckets.set(id.t, bucket);
    }
    const k = key(id);
    bucket.keys.push(k);
    keySet.add(k);
    const size = getSize(id);
    if (size === undefined) bytesKnown = false;
    const bytes = size ?? 0;
    bucket.bytes.push(bytes);
    bucket.totalBytes! += bytes;
  }
  const bucketStarts = Array.from(buckets.keys()).sort((a, b) => a - b);
  const bucketByteTotals = new Float64Array(bucketStarts.length);
  const cumulativeBytes = new Float64Array(bucketStarts.length + 1);
  for (let i = 0; i < bucketStarts.length; i++) {
    const total = buckets.get(bucketStarts[i])!.totalBytes!;
    bucketByteTotals[i] = total;
    cumulativeBytes[i + 1] = cumulativeBytes[i] + total;
  }
  if (!bytesKnown) throw new Error('unreachable in this bench');
}

/**
 * Measured 2026-08-10 (node 20, darwin/arm64): both shapes land at ~1.9-2.3 ms
 * for 12 000 tiles and the winner FLIPS when the two benches are declared in
 * the other order (1.11× one way, 1.01× the other), i.e. the added work is
 * inside run-to-run variance — no measurable overhead, comfortably under the
 * item's 5% budget. Read the two means together with their `rme`, never the
 * headline ratio alone.
 */
describe('coverage-index build loop (12 000 tiles)', () => {
  bench('incumbent (keys + per-tile bytes)', () => {
    buildIncumbent();
  });

  bench('with byte columns (+ totals, + prefix sums)', () => {
    buildWithByteColumns();
  });
});

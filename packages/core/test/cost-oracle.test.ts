/**
 * The shared selection-cost oracle (CO-1).
 *
 * Two halves, one contract:
 *
 *   - `STTArchive.estimateSelectionCost` prices a whole (cells × window ×
 *     tier) selection from resident directory entries, synchronously. It must
 *     agree TILE FOR TILE with the id queries it mirrors — `getTileIdsInBounds`,
 *     `getTileIdsInBoundsForTemporalLod`, `getSummaryTileIdsInBounds` — because
 *     the only thing that makes an estimate worth acting on is that it prices
 *     the set that will actually be fetched. Every unit below therefore asserts
 *     against Σ `getTileByteSize` over the corresponding id query rather than
 *     against a hand-copied constant: a filter that drifts on one side and not
 *     the other fails here.
 *   - `SpatioTemporalTileset.getByteDensityProfile` / `bytesForHorizon` answer
 *     the same question off the coverage index's per-bucket byte columns, where
 *     the property that matters is that the prefix sums equal the brute-force
 *     window sums for every window.
 *
 * Honesty is tested as hard as arithmetic: the oracle never invents a byte
 * count, so "the directory is not open" reports `Infinity` unknowns rather than
 * a zero that reads as "free". (The paged non-resident-leaf half of that
 * contract lives in paged-directory.test.ts, next to the paged fixtures.)
 */

import { describe, it, expect } from 'vitest';
import { STTArchive } from '../src/archive';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import { encodeDirectory } from '../src/directory';
import type { BoundingBox, TileId, TimeRange } from '../src/types';
import {
  directoryObject,
  packedFetch,
  packObject,
  type InMemoryPackedDataset,
} from './helpers/packed-fixture';
import { BOUNDS, BUCKET_MS, fakeTile, settle } from './helpers/fixtures';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;

/** Whole-world query box; every synthetic cell below sits inside it. */
const WORLD: BoundingBox = BOUNDS;

// ---------------------------------------------------------------------------
// A synthetic packed archive with per-entry control over tier, variant,
// covering bound and blob size (so every sum is identifiable).
// ---------------------------------------------------------------------------

interface SynthEntry {
  zoom: number;
  x: number;
  y: number;
  timeStart: number;
  timeEnd: number;
  /** Blob byte length — the number `estimateSelectionCost` sums. */
  length: number;
  variantId?: number;
  bucketMs?: number;
  coverTMin?: number;
}

let synthSeq = 0;

function buildArchive(opts: {
  entries: SynthEntry[];
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
    manifestUrl: `mem://cost-oracle-${synthSeq++}/manifest.json`,
  };
  return new STTArchive({ url: ds.manifestUrl, fetch: packedFetch(ds) });
}

/** Σ directory bytes over an id list — the oracle the sums are checked against. */
function sumIds(archive: STTArchive, ids: TileId[]): number {
  let total = 0;
  for (const id of ids) total += archive.getTileByteSize(id) ?? 0;
  return total;
}

const BASE_META = {
  name: 'cost-oracle',
  bounds: { min_lon: -180, min_lat: -85, max_lon: 180, max_lat: 85 },
  time_range: { start: 0, end: DAY },
  temporal_bucket_ms: HOUR,
  min_zoom: 0,
  max_zoom: 12,
};

// ---------------------------------------------------------------------------
// Archive-side units
// ---------------------------------------------------------------------------

describe('STTArchive.estimateSelectionCost', () => {
  it('sums Σ entry.length over exactly the tiles getTileIdsInBounds selects', async () => {
    const archive = buildArchive({
      metadata: BASE_META,
      entries: [
        { zoom: 5, x: 16, y: 16, timeStart: 0, timeEnd: HOUR, length: 101 },
        { zoom: 5, x: 17, y: 16, timeStart: 0, timeEnd: HOUR, length: 202 },
        {
          zoom: 5,
          x: 16,
          y: 16,
          timeStart: HOUR,
          timeEnd: 2 * HOUR,
          length: 303,
        },
        // A different zoom: must never leak into a z5 sum.
        { zoom: 6, x: 32, y: 32, timeStart: 0, timeEnd: HOUR, length: 999 },
      ],
    });
    const range: TimeRange = { start: 0, end: 3 * HOUR };
    const ids = await archive.getTileIdsInBounds(WORLD, 5, range);
    expect(ids.length).toBe(3);

    const cost = archive.estimateSelectionCost(WORLD, 5, range);
    expect(cost.bytes).toBe(101 + 202 + 303);
    expect(cost.bytes).toBe(sumIds(archive, ids));
    expect(cost.tiles).toBe(ids.length);
    // A whole-loaded (non-paged) directory has nothing it cannot see.
    expect(cost.unknownTiles).toBe(0);

    // A window that selects one bucket prices one bucket.
    const firstHour = { start: 0, end: HOUR - 1 };
    const firstIds = await archive.getTileIdsInBounds(WORLD, 5, firstHour);
    expect(archive.estimateSelectionCost(WORLD, 5, firstHour)).toEqual({
      bytes: sumIds(archive, firstIds),
      tiles: firstIds.length,
      unknownTiles: 0,
    });

    // The z6 entry is priced only when z6 is asked for.
    expect(archive.estimateSelectionCost(WORLD, 6, range).bytes).toBe(999);
  });

  it('isolates temporal-LOD tiers in both directions', async () => {
    const archive = buildArchive({
      metadata: {
        ...BASE_META,
        temporal_lod: [{ bucket_ms: DAY, max_zoom_level: 8 }],
      },
      entries: [
        {
          zoom: 5,
          x: 16,
          y: 16,
          timeStart: 0,
          timeEnd: HOUR,
          length: 100,
          bucketMs: HOUR,
        },
        {
          zoom: 5,
          x: 16,
          y: 16,
          timeStart: HOUR,
          timeEnd: 2 * HOUR,
          length: 200,
          bucketMs: HOUR,
        },
        // The coarse tier shares z/x/y/timeStart with the base tile above it.
        {
          zoom: 5,
          x: 16,
          y: 16,
          timeStart: 0,
          timeEnd: DAY,
          length: 5000,
          bucketMs: DAY,
        },
      ],
    });
    const range: TimeRange = { start: 0, end: DAY };

    // Base-tier sum: the DAY tile's 5000 bytes must not leak in.
    const baseIds = await archive.getTileIdsInBounds(WORLD, 5, range);
    const base = archive.estimateSelectionCost(WORLD, 5, range);
    expect(base.bytes).toBe(300);
    expect(base.bytes).toBe(sumIds(archive, baseIds));
    expect(base.tiles).toBe(2);

    // Coarse-tier sum: only the DAY tile.
    const lodIds = await archive.getTileIdsInBoundsForTemporalLod(
      WORLD,
      5,
      range,
      DAY,
    );
    const lod = archive.estimateSelectionCost(WORLD, 5, range, {
      bucketMs: DAY,
    });
    expect(lod.bytes).toBe(5000);
    expect(lod.bytes).toBe(sumIds(archive, lodIds));
    expect(lod.tiles).toBe(1);

    // Asking for the base bucket explicitly is the same selection as the
    // default one (the tier the default path filters TO).
    expect(
      archive.estimateSelectionCost(WORLD, 5, range, { bucketMs: HOUR }),
    ).toEqual(base);

    // A tier the archive does not carry prices at zero rather than falling
    // back to some other tier's bytes.
    expect(
      archive.estimateSelectionCost(WORLD, 5, range, { bucketMs: 7 * DAY }),
    ).toEqual({ bytes: 0, tiles: 0, unknownTiles: 0 });
  });

  it('applies the coverTMin filter, in parity with getTileIdsInBounds', async () => {
    const archive = buildArchive({
      metadata: BASE_META,
      entries: [
        // Addressed at the bucket edge t=0, but its earliest feature starts
        // 50 minutes in: a window ending at t=10min must not fetch it...
        {
          zoom: 5,
          x: 16,
          y: 16,
          timeStart: 0,
          timeEnd: HOUR,
          length: 400,
          coverTMin: 50 * MINUTE,
        },
        // ...while its neighbour, whose covering bound is its bucket edge
        // (the encoder emits the section only when EVERY entry carries one),
        // is selected.
        {
          zoom: 5,
          x: 17,
          y: 16,
          timeStart: 0,
          timeEnd: HOUR,
          length: 700,
          coverTMin: 0,
        },
      ],
    });

    const early: TimeRange = { start: 0, end: 10 * MINUTE };
    const earlyIds = await archive.getTileIdsInBounds(WORLD, 5, early);
    expect(earlyIds.length).toBe(1);
    const earlyCost = archive.estimateSelectionCost(WORLD, 5, early);
    expect(earlyCost.bytes).toBe(700);
    expect(earlyCost.bytes).toBe(sumIds(archive, earlyIds));
    expect(earlyCost.tiles).toBe(1);

    // Widen past the covering bound and both tiles are selected and priced.
    const late: TimeRange = { start: 0, end: 55 * MINUTE };
    const lateIds = await archive.getTileIdsInBounds(WORLD, 5, late);
    expect(lateIds.length).toBe(2);
    expect(archive.estimateSelectionCost(WORLD, 5, late).bytes).toBe(
      sumIds(archive, lateIds),
    );

    // The upper bound stays `timeEnd`: a window entirely before the tile.
    const before: TimeRange = { start: -2 * HOUR, end: -HOUR };
    expect(await archive.getTileIdsInBounds(WORLD, 5, before)).toEqual([]);
    expect(archive.estimateSelectionCost(WORLD, 5, before)).toEqual({
      bytes: 0,
      tiles: 0,
      unknownTiles: 0,
    });
  });

  it('filters by summary variant and honours the tier zoom gate', async () => {
    const archive = buildArchive({
      variants: [
        { id: 0, kind: 'raw' },
        { id: 1, kind: 'summary' },
      ],
      metadata: {
        ...BASE_META,
        summary_tier: {
          variant_id: 1,
          scheme: 'h3',
          min_zoom: 0,
          max_zoom: 4,
          cell_resolution_per_zoom: [1, 2, 3, 4, 5],
          columns: [{ name: 'count', agg: 'count' }],
          layer_name: 'summary',
        },
      },
      entries: [
        { zoom: 4, x: 8, y: 8, timeStart: 0, timeEnd: HOUR, length: 100 },
        {
          zoom: 4,
          x: 8,
          y: 8,
          timeStart: 0,
          timeEnd: HOUR,
          length: 700,
          variantId: 1,
        },
        { zoom: 5, x: 16, y: 16, timeStart: 0, timeEnd: HOUR, length: 200 },
        // A summary entry OUTSIDE the declared summary zoom range: not
        // addressable, so it must price at zero.
        {
          zoom: 5,
          x: 16,
          y: 16,
          timeStart: 0,
          timeEnd: HOUR,
          length: 900,
          variantId: 1,
        },
      ],
    });
    const range: TimeRange = { start: 0, end: HOUR };

    // Inside the gate: the summary sum matches getSummaryTileIdsInBounds, and
    // the base sum never sees the summary variant's bytes.
    const summaryIds = await archive.getSummaryTileIdsInBounds(WORLD, 4, range);
    expect(summaryIds.length).toBe(1);
    const summary = archive.estimateSelectionCost(WORLD, 4, range, {
      variantId: 1,
    });
    expect(summary.bytes).toBe(700);
    expect(summary.bytes).toBe(sumIds(archive, summaryIds));
    expect(archive.estimateSelectionCost(WORLD, 4, range).bytes).toBe(100);

    // Outside the gate: the id query returns nothing, so the cost is nothing —
    // even though a variant-1 entry physically exists at that zoom.
    expect(await archive.getSummaryTileIdsInBounds(WORLD, 5, range)).toEqual(
      [],
    );
    expect(
      archive.estimateSelectionCost(WORLD, 5, range, { variantId: 1 }),
    ).toEqual({ bytes: 0, tiles: 0, unknownTiles: 0 });
    // The raw tier at that zoom is unaffected by the gate.
    expect(archive.estimateSelectionCost(WORLD, 5, range).bytes).toBe(200);
  });

  it('reports Infinity unknowns before the directory is open (0 is not "free")', async () => {
    const archive = buildArchive({
      metadata: BASE_META,
      entries: [
        { zoom: 5, x: 16, y: 16, timeStart: 0, timeEnd: HOUR, length: 512 },
      ],
    });
    const range: TimeRange = { start: 0, end: HOUR };

    // Nothing has been awaited: the reader knows neither what it would price
    // nor how much it is missing. It says so.
    const blind = archive.estimateSelectionCost(WORLD, 5, range);
    expect(blind.bytes).toBe(0);
    expect(blind.tiles).toBe(0);
    expect(blind.unknownTiles).toBe(Number.POSITIVE_INFINITY);
    expect(blind.unknownTiles > 0).toBe(true); // the abstention branch fires

    await archive.getIndex();
    expect(archive.estimateSelectionCost(WORLD, 5, range)).toEqual({
      bytes: 512,
      tiles: 1,
      unknownTiles: 0,
    });
  });

  it('is a pure function of resident entries (repeat calls are identical)', async () => {
    const archive = buildArchive({
      metadata: BASE_META,
      entries: [
        { zoom: 5, x: 16, y: 16, timeStart: 0, timeEnd: HOUR, length: 11 },
        {
          zoom: 5,
          x: 17,
          y: 17,
          timeStart: HOUR,
          timeEnd: 2 * HOUR,
          length: 22,
        },
      ],
    });
    await archive.getIndex();
    const range: TimeRange = { start: 0, end: 2 * HOUR };
    const first = archive.estimateSelectionCost(WORLD, 5, range);
    for (let i = 0; i < 5; i++) {
      expect(archive.estimateSelectionCost(WORLD, 5, range)).toEqual(first);
    }
  });
});

// ---------------------------------------------------------------------------
// Tileset-side: byte-density profile + horizon prefix sums
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) — no wall clock, no Math.random. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ProfileHarness {
  tileset: SpatioTemporalTileset;
  /** Byte length of tile `k` of bucket `i` (the harness's directory). */
  bytesAt: (bucket: number, index: number) => number;
  /** Σ bytes of every tile in bucket `i`. */
  bucketTotal: (bucket: number) => number;
  nBuckets: number;
  tilesPerBucket: number;
}

/**
 * A single-cell-per-column synthetic tileset: `tilesPerBucket` tiles at every
 * bucket in `[0, nBuckets)`, each with a deterministic byte length. Mirrors the
 * buffered-runway harness, widened so a bucket can hold several tiles (the
 * shape the per-bucket byte totals actually have in the field).
 */
function makeProfileHarness(opts: {
  nBuckets: number;
  tilesPerBucket?: number;
  seed?: number;
  /** Omit `getTileByteSize` entirely — the bytes-blind archive. */
  blind?: boolean;
}): ProfileHarness {
  const nBuckets = opts.nBuckets;
  const tilesPerBucket = opts.tilesPerBucket ?? 1;
  const random = rng(opts.seed ?? 1);
  const table: number[][] = [];
  for (let i = 0; i < nBuckets; i++) {
    const row: number[] = [];
    for (let k = 0; k < tilesPerBucket; k++) {
      row.push(1 + Math.floor(random() * 5000));
    }
    table.push(row);
  }
  const bytesAt = (bucket: number, index: number): number =>
    table[bucket][index];
  const bucketTotal = (bucket: number): number =>
    table[bucket].reduce((n, b) => n + b, 0);

  const tileset = new SpatioTemporalTileset({
    minZoom: 0,
    maxZoom: 12,
    enablePrefetch: false,
    refinementStrategy: 'no-overlap',
    temporalBucketMs: BUCKET_MS,
    getAvailableTiles: async (_b, z, range) => {
      const ids: TileId[] = [];
      const first = Math.max(0, Math.floor(range.start / BUCKET_MS));
      const last = Math.min(nBuckets - 1, Math.floor(range.end / BUCKET_MS));
      for (let i = first; i <= last; i++) {
        const t = i * BUCKET_MS;
        if (t + BUCKET_MS < range.start || t > range.end) continue;
        for (let k = 0; k < tilesPerBucket; k++) ids.push({ z, x: k, y: 0, t });
      }
      return ids;
    },
    getTileByteSize: opts.blind
      ? undefined
      : (id: TileId) => {
          const i = id.t / BUCKET_MS;
          if (!Number.isInteger(i) || i < 0 || i >= nBuckets) return undefined;
          if (id.x < 0 || id.x >= tilesPerBucket) return undefined;
          return bytesAt(i, id.x);
        },
    getTileData: async (id: TileId) => fakeTile(id),
    getTileDataBatch: async (ids: TileId[]) => ids.map((id) => fakeTile(id)),
  });
  return { tileset, bytesAt, bucketTotal, nBuckets, tilesPerBucket };
}

/** Drive one selection pass and wait for the async coverage-index build. */
async function primeProfile(h: ProfileHarness): Promise<void> {
  h.tileset.update({
    bounds: BOUNDS,
    zoom: 6,
    time: 500,
    timeWindow: 100,
  });
  h.tileset.getBufferedRunway(0, 1); // flips lazy buffer tracking on
  await settle(10);
}

/** Brute-force Σ totals over the buckets a `[start, end]` range intersects. */
function bruteTotal(
  h: ProfileHarness,
  range: { start: number; end: number },
): number {
  let total = 0;
  for (let i = 0; i < h.nBuckets; i++) {
    const b = i * BUCKET_MS;
    if (b + BUCKET_MS < range.start || b > range.end) continue;
    total += h.bucketTotal(i);
  }
  return total;
}

describe('SpatioTemporalTileset.getByteDensityProfile', () => {
  it('reports per-bucket totals aligned with the bucket starts', async () => {
    const h = makeProfileHarness({ nBuckets: 6, tilesPerBucket: 3, seed: 7 });
    await primeProfile(h);

    const profile = h.tileset.getByteDensityProfile({ start: 0, end: 6000 });
    expect(profile).not.toBeNull();
    expect(profile!.bucketStarts).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
    expect(profile!.totalBytes).toEqual([0, 1, 2, 3, 4, 5].map(h.bucketTotal));
    expect(profile!.totalBytes.length).toBe(profile!.bucketStarts.length);
    expect(profile!.missingBytes.length).toBe(profile!.bucketStarts.length);

    h.tileset.finalize();
  });

  it('abstains (null) before the index exists and when bytes are unknown', async () => {
    // Un-built index: no viewport has been seen yet.
    const cold = makeProfileHarness({ nBuckets: 4 });
    expect(cold.tileset.getByteDensityProfile({ start: 0, end: 4000 })).toBe(
      null,
    );
    expect(cold.tileset.bytesForHorizon(0, 1, 4000)).toEqual({
      bytes: 0,
      exact: false,
    });
    cold.tileset.finalize();

    // Wired index, blind byte channel: the per-tile fallback is 0, and a zero
    // that means "unknown" must never be published as a total.
    const blind = makeProfileHarness({ nBuckets: 4, blind: true });
    await primeProfile(blind);
    expect(blind.tileset.getByteDensityProfile({ start: 0, end: 4000 })).toBe(
      null,
    );
    expect(blind.tileset.bytesForHorizon(0, 1, 4000).exact).toBe(false);
    // The incumbent API keeps its documented bytes-0 behaviour, unchanged.
    expect(blind.tileset.estimateCost({ start: 0, end: 4000 }).bytes).toBe(0);
    blind.tileset.finalize();
  });

  it('prefix sums equal brute-force window sums (property, 24 random windows)', async () => {
    const h = makeProfileHarness({ nBuckets: 37, tilesPerBucket: 3, seed: 99 });
    await primeProfile(h);
    const random = rng(4242);

    for (let trial = 0; trial < 24; trial++) {
      const a = Math.floor(random() * (h.nBuckets + 2) * BUCKET_MS);
      const b = a + Math.floor(random() * (h.nBuckets + 2) * BUCKET_MS);
      const range = { start: a, end: b };

      const profile = h.tileset.getByteDensityProfile(range)!;
      const sum = profile.totalBytes.reduce((n, x) => n + x, 0);
      expect(sum, `window ${a}..${b}`).toBe(bruteTotal(h, range));

      // Same window, answered by the prefix sums instead of the walk.
      const horizon = h.tileset.bytesForHorizon(a, 1, b - a);
      expect(horizon.exact).toBe(true);
      expect(horizon.bytes, `horizon ${a}..${b}`).toBe(bruteTotal(h, range));

      // Backward probes cover the mirrored span.
      const back = h.tileset.bytesForHorizon(b, -1, b - a);
      expect(back.bytes, `back ${a}..${b}`).toBe(bruteTotal(h, range));
    }

    h.tileset.finalize();
  });

  it('bytesForHorizon is monotone non-decreasing in the horizon', async () => {
    const h = makeProfileHarness({ nBuckets: 30, tilesPerBucket: 2, seed: 5 });
    await primeProfile(h);

    for (const direction of [1, -1] as const) {
      const from = direction > 0 ? 2500 : 27_500;
      let previous = -1;
      for (let horizon = 0; horizon <= 32_000; horizon += 137) {
        const { bytes } = h.tileset.bytesForHorizon(from, direction, horizon);
        expect(
          bytes,
          `dir ${direction} horizon ${horizon}`,
        ).toBeGreaterThanOrEqual(previous);
        previous = bytes;
      }
      // An unbounded horizon reaches every bucket on that side of `from` (and
      // stops there — a probe does not see behind itself).
      expect(h.tileset.bytesForHorizon(from, direction, 1e9).bytes).toBe(
        bruteTotal(
          h,
          direction > 0
            ? { start: from, end: from + 1e9 }
            : { start: from - 1e9, end: from },
        ),
      );
    }

    // A negative / non-finite horizon is clamped to zero, never inverted.
    expect(h.tileset.bytesForHorizon(2500, 1, -5000).bytes).toBe(
      h.tileset.bytesForHorizon(2500, 1, 0).bytes,
    );
    expect(h.tileset.bytesForHorizon(2500, 1, Number.NaN).bytes).toBe(
      h.tileset.bytesForHorizon(2500, 1, 0).bytes,
    );

    h.tileset.finalize();
  });

  it('two builds from identical inputs produce byte-identical byte columns', async () => {
    const a = makeProfileHarness({ nBuckets: 21, tilesPerBucket: 3, seed: 31 });
    const b = makeProfileHarness({ nBuckets: 21, tilesPerBucket: 3, seed: 31 });
    await primeProfile(a);
    await primeProfile(b);

    type Index = {
      bucketStarts: number[];
      bucketByteTotals: Float64Array;
      cumulativeBytes: Float64Array;
      bytesKnown: boolean;
    };
    const read = (t: SpatioTemporalTileset): Index =>
      (t as unknown as { coverageIndex: Index }).coverageIndex;

    const ia = read(a.tileset);
    const ib = read(b.tileset);
    expect(ia.bucketStarts).toEqual(ib.bucketStarts);
    expect(ia.bytesKnown).toBe(true);
    // Byte-identical, not merely equal-valued: same length, same doubles.
    expect(new Uint8Array(ia.bucketByteTotals.buffer)).toEqual(
      new Uint8Array(ib.bucketByteTotals.buffer),
    );
    expect(new Uint8Array(ia.cumulativeBytes.buffer)).toEqual(
      new Uint8Array(ib.cumulativeBytes.buffer),
    );
    // And the prefix sums really are prefix sums of the totals.
    expect(ia.cumulativeBytes.length).toBe(ia.bucketByteTotals.length + 1);
    expect(ia.cumulativeBytes[0]).toBe(0);
    let running = 0;
    for (let i = 0; i < ia.bucketByteTotals.length; i++) {
      running += ia.bucketByteTotals[i];
      expect(ia.cumulativeBytes[i + 1]).toBe(running);
      expect(ia.bucketByteTotals[i]).toBe(a.bucketTotal(i));
    }

    a.tileset.finalize();
    b.tileset.finalize();
  });

  /**
   * CO-1's acceptance is correctness plus WALK COST — the oracle is called
   * several times per plan by CO-2..CO-6, so a profile query that walked the
   * whole index would be a regression even while returning the right number.
   * The budget is 0.1 ms per query; the thresholds below are deliberately
   * looser than the measured cost (which is ~1-2 orders of magnitude under)
   * so this pins the COMPLEXITY, not the machine. `vitest bench` numbers live
   * in cost-oracle.bench.ts.
   */
  it('answers a profile query in well under the 0.1 ms walk budget', async () => {
    const h = makeProfileHarness({
      nBuckets: 2000,
      tilesPerBucket: 6,
      seed: 2026,
    });
    await primeProfile(h);
    const slice = { start: 400_000, end: 600_000 }; // 200 buckets, 1200 tiles

    // Warm up, then measure a batch (per-call timing is below timer noise).
    for (let i = 0; i < 50; i++) {
      h.tileset.getByteDensityProfile(slice);
      h.tileset.bytesForHorizon(400_000, 1, 200_000);
    }
    const iterations = 200;
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) h.tileset.getByteDensityProfile(slice);
    const profileMs = (performance.now() - t0) / iterations;
    const t1 = performance.now();
    for (let i = 0; i < iterations; i++) {
      h.tileset.bytesForHorizon(400_000, 1, 200_000);
    }
    const horizonMs = (performance.now() - t1) / iterations;

    expect(profileMs).toBeLessThan(1);
    // O(log buckets): unaffected by how much time the horizon spans.
    expect(horizonMs).toBeLessThan(0.05);

    h.tileset.finalize();
  });
});

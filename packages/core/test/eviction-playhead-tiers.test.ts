/**
 * Playhead-relative tiered over-limit eviction.
 *
 * Under memory pressure the old over-limit branch was plain LRU — which
 * reclaims exactly the prefetched runway ahead of the playhead (prefetched =
 * least-recently *touched*), only for the priority path to re-fetch the same
 * bytes seconds later: the multi-dataset "flashing tiles" thrash. The tiered
 * policy trims like a media player instead:
 *
 *   A. non-coverage tiles (stale viewports/zooms) — LRU (today's behavior
 *      restricted to non-runway tiles);
 *   B. coverage tiles far BEHIND the playhead — furthest-behind first;
 *   C. coverage tiles far AHEAD — furthest-ahead first (distant speculation
 *      before imminent future);
 *   D. last resort: the near-playhead protected window — LRU (the hard cap
 *      must still hold).
 *
 * Tier C/D evictions count in `runwayEvictions` and decay
 * `prefetchPressureScale` (degrade the horizon instead of thrashing); with no
 * coverage index the branch falls back to the original LRU, unchanged.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { SpatiotemporalTileset } from '../src/spatiotemporal-tileset';
import type { Tile, TileId, BoundingBox } from '../src/types';
import { BUCKET_MS, fakeTile, makeAvailableTiles } from './helpers/fixtures';
import { advanceClock, installClock } from './helpers/clock';

const WEST: BoundingBox = {
  minLon: -170,
  minLat: -60,
  maxLon: -10,
  maxLat: 60,
};
const EAST: BoundingBox = { minLon: 10, minLat: -60, maxLon: 170, maxLat: 60 };
const N_BUCKETS = 60;

/** West → x=0, east → x=1, so east tiles fall out of the west coverage index. */
const availableTiles = makeAvailableTiles(N_BUCKETS, (b) =>
  b.maxLon <= 0 ? 0 : 1,
);

const settle = (ms = 10): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** "x:bucketIndex" label for a tile id — the assertion currency below. */
const label = (id: TileId): string => `${id.x}:${id.t / BUCKET_MS}`;

function makeTileset(unloads: string[]): SpatiotemporalTileset {
  return new SpatiotemporalTileset({
    minZoom: 0,
    maxZoom: 12,
    enablePrefetch: false,
    refinementStrategy: 'no-overlap',
    temporalBucketMs: BUCKET_MS,
    getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
    getTileData: async (id: TileId) => fakeTile(id),
    getTileDataBatch: async (ids: TileId[]) => ids.map(fakeTile),
    onTileUnload: (tile: Tile) => unloads.push(label(tile.id)),
  });
}

const loadBucket = async (
  tileset: SpatiotemporalTileset,
  bounds: BoundingBox,
  i: number,
  // A 1 ms nudge defeats the identical-params selection fast-path (see the
  // eviction-buffered-timeline suite).
  timeNudge = 0,
): Promise<void> => {
  tileset.update({
    bounds,
    zoom: 6,
    time: i * BUCKET_MS + 500 + timeNudge,
    timeWindow: 100,
  });
  await settle();
};

/** Coverage index build is async — call a buffer API, then let it land. */
const enableBufferTracking = async (
  tileset: SpatiotemporalTileset,
): Promise<void> => {
  tileset.getBufferedRanges();
  await settle();
};

/**
 * The shared fixture: 10 loaded tiles around a playhead at bucket 30 (west
 * viewport, forward direction, timeWindow 100 « BUCKET_MS 1000):
 *   - east 0, east 5 → tier A (not in the west coverage index), LRU e0 < e5;
 *   - west 26, 27   → tier B (behind by > keepBehind=1000), furthest first;
 *   - west 40, 50   → tier C (ahead by > protectedAhead=2000), furthest first;
 *   - west 29,31,32 → tier D (near-playhead protected window), LRU order;
 *   - west 30       → the NEEDED tile (never a candidate).
 * lastUsed strictly increases in load order (the clock advances 1 s per load).
 */
async function buildFixture(
  unloads: string[],
  { coverage = true } = {},
): Promise<SpatiotemporalTileset> {
  const tileset = makeTileset(unloads);
  for (const [bounds, i] of [
    [EAST, 0],
    [EAST, 5],
    [WEST, 26],
    [WEST, 27],
    [WEST, 29],
    [WEST, 31],
    [WEST, 32],
    [WEST, 40],
    [WEST, 50],
    [WEST, 30],
  ] as Array<[BoundingBox, number]>) {
    await loadBucket(tileset, bounds, i);
    if (coverage && bounds === WEST && i === 26) {
      await enableBufferTracking(tileset); // west index: x=0, all buckets
    }
    advanceClock(1000);
  }
  expect(tileset.getCacheStats().tileCount).toBe(10);
  return tileset;
}

/** Tighten the cache limit and run one eviction pass at the bucket-30 playhead. */
async function evictAt(
  tileset: SpatiotemporalTileset,
  unloads: string[],
  maxCacheSize: number,
  nudge: number,
): Promise<void> {
  tileset.options.maxCacheSize = maxCacheSize;
  unloads.length = 0;
  await loadBucket(tileset, WEST, 30, nudge);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SpatiotemporalTileset playhead-relative over-limit eviction', () => {
  it('evicts tier A first (LRU), leaving every coverage tile resident', async () => {
    installClock();
    const unloads: string[] = [];
    const tileset = await buildFixture(unloads);

    await evictAt(tileset, unloads, 9, 1); // over by 1
    expect(unloads).toEqual(['1:0']); // oldest non-coverage tile only
    expect(tileset.getCacheStats().tileCount).toBe(9);
    expect(tileset.getCacheStats().runwayEvictions).toBe(0);
    expect(tileset.getCacheStats().prefetchPressureScale).toBe(1);

    tileset.finalize();
  });

  it('walks A → B → C and the near-playhead window survives when they suffice', async () => {
    installClock();
    const unloads: string[] = [];
    const tileset = await buildFixture(unloads);

    await evictAt(tileset, unloads, 4, 1); // over by 6 = |A| + |B| + |C|
    // A (LRU), then B (furthest behind first), then C (furthest ahead first).
    expect(unloads).toEqual(['1:0', '1:5', '0:26', '0:27', '0:50', '0:40']);
    // Survivors: the protected window (29, 31, 32) + the needed tile (30).
    expect(tileset.getCacheStats().tileCount).toBe(4);
    // Only tier C counts as runway evictions here.
    expect(tileset.getCacheStats().runwayEvictions).toBe(2);
    // A tier-C eviction is the thrash signal: the horizon scale decays.
    expect(tileset.getCacheStats().prefetchPressureScale).toBeCloseTo(0.7, 10);

    tileset.finalize();
  });

  it('tier D still fires as the last resort so the hard cap holds', async () => {
    installClock();
    const unloads: string[] = [];
    const tileset = await buildFixture(unloads);

    await evictAt(tileset, unloads, 2, 1); // over by 8: A+B+C don't suffice
    expect(unloads).toEqual([
      '1:0',
      '1:5',
      '0:26',
      '0:27',
      '0:50',
      '0:40',
      '0:29', // tier D, LRU order
      '0:31',
    ]);
    // Survivors: the most-recently-used near tile + the needed tile.
    expect(tileset.getCacheStats().tileCount).toBe(2);
    // runwayEvictions counts C + D only (2 + 2), never A/B.
    expect(tileset.getCacheStats().runwayEvictions).toBe(4);

    tileset.finalize();
  });

  it('falls back to the original LRU when no coverage index exists', async () => {
    installClock();
    const unloads: string[] = [];
    const tileset = await buildFixture(unloads, { coverage: false });

    await evictAt(tileset, unloads, 4, 1);
    // Pure lastUsed order — near-playhead tiles (29, 31) go before the far
    // speculation (40, 50), exactly the pre-fix behavior.
    expect(unloads).toEqual(['1:0', '1:5', '0:26', '0:27', '0:29', '0:31']);
    expect(tileset.getCacheStats().runwayEvictions).toBe(0);
    expect(tileset.getCacheStats().prefetchPressureScale).toBe(1);

    tileset.finalize();
  });

  it('runs the pressure ladder down to its 0.25 floor under repeated runway evictions', async () => {
    installClock();
    const unloads: string[] = [];
    const tileset = makeTileset(unloads);

    // 16 far-ahead coverage tiles (buckets 40..55) + the needed bucket 30.
    for (let i = 40; i <= 55; i++) {
      await loadBucket(tileset, WEST, i);
      if (i === 40) await enableBufferTracking(tileset);
      advanceClock(1000);
    }
    await loadBucket(tileset, WEST, 30);
    expect(tileset.getCacheStats().tileCount).toBe(17);

    // Each tightening forces another pass into tier C: 0.7^n, clamped at 0.25.
    const expected: Array<[number, number]> = [
      [12, 0.7],
      [8, 0.49],
      [5, 0.343],
      [3, 0.25], // 0.343 × 0.7 = 0.2401 → floor
      [2, 0.25], // floor holds
    ];
    let nudge = 1;
    let evicted = 0;
    for (const [limit, scale] of expected) {
      await evictAt(tileset, unloads, limit, nudge++);
      evicted += unloads.length;
      expect(tileset.getCacheStats().prefetchPressureScale).toBeCloseTo(
        scale,
        10,
      );
    }
    // Every eviction reached into the runway (all candidates were tier C).
    expect(evicted).toBe(15);
    expect(tileset.getCacheStats().runwayEvictions).toBe(15);
    expect(tileset.getCacheStats().tileCount).toBe(2); // bucket 40 + needed 30

    tileset.finalize();
  });
});

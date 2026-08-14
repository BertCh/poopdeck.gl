/**
 * Eviction ↔ in-flight coupling on SpatioTemporalTileset.
 *
 * Grace-period eviction used to delete headers that were still loading. The
 * in-flight batch holds a direct reference to the deleted header, so a late
 * deliverTile() would "resurrect" it OUTSIDE the registry — inflating
 * `currentCacheBytes` / `loadedTileCount` forever (the orphan can never be
 * evicted). Same failure through `clear()`: the registry is emptied and the
 * counters zeroed, then a late delivery re-inflates them.
 *
 * Invariants under test:
 *  - grace-period eviction skips `isLoading` headers;
 *  - a header evicted while in flight (over-limit path / defensive backstop)
 *    has `isCancelled` latched so delivery no-ops;
 *  - after `clear()`, deliveries from still-pending batches never count —
 *    cacheBytes stays 0 (the long-session accounting invariant).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import type { TileId, Tile } from '../src/types';
import {
  BOUNDS,
  BUCKET_MS,
  fakeTile,
  makeAvailableTiles,
} from './helpers/fixtures';
import { advanceClock, installClock } from './helpers/clock';

const N_BUCKETS = 60;
const availableTiles = makeAvailableTiles(N_BUCKETS);

const settle = (ms = 10): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Harness whose batch loads stay PENDING until released — so a tile can be
 * held "in flight" across eviction passes / clear() calls. `Date.now` is
 * offset-shifted (real timers keep running) to step past the 30 s paused
 * grace period without waiting it out.
 */
function makeHarness(unloads?: number[]) {
  const pending: Array<{ ids: TileId[]; resolve: () => void }> = [];
  const tileset = new SpatioTemporalTileset({
    minZoom: 0,
    maxZoom: 12,
    enablePrefetch: false,
    refinementStrategy: 'no-overlap',
    temporalBucketMs: BUCKET_MS,
    getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
    getTileData: async (id: TileId) => fakeTile(id),
    getTileDataBatch: (ids: TileId[]) =>
      new Promise<(Tile | null)[]>((resolve) => {
        pending.push({ ids, resolve: () => resolve(ids.map(fakeTile)) });
      }),
    ...(unloads
      ? { onTileUnload: (t: Tile) => unloads.push(t.id.t / BUCKET_MS) }
      : {}),
  });
  const loadBucket = async (i: number): Promise<void> => {
    tileset.update({
      bounds: BOUNDS,
      zoom: 6,
      time: i * BUCKET_MS + 500,
      timeWindow: 100,
    });
    await settle();
  };
  /** Select with an explicit (time, timeWindow) — for multi-bucket batches. */
  const loadWindow = async (
    time: number,
    timeWindow: number,
  ): Promise<void> => {
    tileset.update({ bounds: BOUNDS, zoom: 6, time, timeWindow });
    await settle();
  };
  const releaseBatches = async (): Promise<void> => {
    for (const p of pending.splice(0)) p.resolve();
    await settle();
  };
  return { tileset, loadBucket, loadWindow, releaseBatches };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SpatioTemporalTileset eviction/in-flight coupling', () => {
  it('grace-period eviction never deletes an in-flight header (no counter leak)', async () => {
    installClock();
    const { tileset, loadBucket, loadWindow, releaseBatches } = makeHarness();

    // ONE batch covering buckets 0 and 1 goes in flight and STAYS pending.
    await loadWindow(BUCKET_MS, BUCKET_MS); // range [500, 1500] → buckets 0+1
    expect(tileset.getCacheStats().activeRequests).toBe(2);

    // Step far past the 30 s paused grace period and narrow the window to
    // bucket 1 only. The batch is NOT superseded (member b1 is still
    // needed), so it stays in flight — and the eviction pass judges bucket
    // 0 unneeded + stale. It is still loading and must be skipped, not
    // deleted (the batch holds a direct reference to its header).
    advanceClock(31_000);
    await loadWindow(BUCKET_MS + 500, 100); // range [1450, 1550] → bucket 1
    expect(tileset.getCacheStats().activeRequests).toBe(2); // batch survived

    // Now the held batch lands; both members are accounted normally.
    await releaseBatches();
    const headerBytes = 1000; // estimateTileSize() of a layer-less fake tile
    expect(tileset.getCacheStats().cacheBytes).toBe(2 * headerBytes);

    // A later eviction pass CAN reclaim both: step past the grace period
    // again and select a fresh bucket. With the pre-fix leak, bucket 0's
    // delivery landed in an orphan header no eviction pass can reach, so
    // cacheBytes would stay permanently inflated by one tile here.
    advanceClock(31_000);
    await loadBucket(46);
    await releaseBatches();
    expect(tileset.getCacheStats().cacheBytes).toBe(headerBytes);

    tileset.finalize();
    expect(tileset.getCacheStats().cacheBytes).toBe(0);
  });

  it('clear() latches in-flight loads so a late delivery cannot re-inflate the counters', async () => {
    installClock();
    const { tileset, loadBucket, releaseBatches } = makeHarness();

    await loadBucket(0);
    expect(tileset.getCacheStats().activeRequests).toBeGreaterThan(0);

    tileset.clear();
    expect(tileset.getCacheStats().cacheBytes).toBe(0);

    // The held batch resolves AFTER the registry was torn down. Without the
    // isCancelled latch this delivery would land in the captured header and
    // push cacheBytes back above zero with zero registered tiles.
    await releaseBatches();
    const stats = tileset.getCacheStats();
    expect(stats.cacheBytes).toBe(0);
    expect(stats.tileCount).toBe(0);

    tileset.finalize();
  });
});

/**
 * BH-7 — the exclusions survive loop rotation.
 *
 * Rotation changes only the ORDER of the over-limit plan, never who is
 * eligible for it: needed, pinned and in-flight headers are excluded before
 * any distance is computed, and that must remain true when the distance is
 * measured modulo a loop span.
 */
describe('SpatioTemporalTileset loop rotation vs the eviction exclusions', () => {
  /** Buckets 26..33 — a 7 000 ms loop with the playhead at its end. */
  const LOOP = { start: 26 * BUCKET_MS, end: 33 * BUCKET_MS };

  it('never evicts an in-flight or needed header, and rotates the rest', async () => {
    installClock();
    const unloads: number[] = [];
    const { tileset, loadBucket, releaseBatches } = makeHarness(unloads);

    // Five settled tiles around the loop.
    for (const i of [26, 27, 28, 29, 31]) {
      await loadBucket(i);
      await releaseBatches();
      advanceClock(1000);
    }
    tileset.getBufferedRanges(); // coverage index on
    await settle();
    expect(tileset.getCacheStats().tileCount).toBe(5);

    // Bucket 30 goes IN FLIGHT and stays pending — under rotation it is the
    // just-passed tile, i.e. exactly the one the plan would evict first.
    await loadBucket(30);
    expect(tileset.getCacheStats().activeRequests).toBeGreaterThan(0);

    tileset.setLoopWindow(LOOP);
    tileset.options.maxCacheSize = 3;
    unloads.length = 0;

    // Playhead at bucket 32 (needed, and not yet resident).
    tileset.update({
      bounds: BOUNDS,
      zoom: 6,
      time: 32 * BUCKET_MS + 501,
      timeWindow: 100,
    });
    await settle();

    // The in-flight bucket 30 survives despite ranking first on the wrapped
    // metric; the rotated order takes the tier-C pair instead.
    expect(unloads).toEqual([29, 28]);
    expect(unloads).not.toContain(30);
    expect(unloads).not.toContain(32);
    // ...and its request was never released out from under the batch.
    expect(tileset.getCacheStats().activeRequests).toBeGreaterThan(0);

    tileset.finalize();
  });

  it('falls back to the incumbent order with no loop declared', async () => {
    installClock();
    const unloads: number[] = [];
    const { tileset, loadBucket, releaseBatches } = makeHarness(unloads);

    for (const i of [26, 27, 28, 29, 31]) {
      await loadBucket(i);
      await releaseBatches();
      advanceClock(1000);
    }
    tileset.getBufferedRanges();
    await settle();
    await loadBucket(30); // in flight, pending

    tileset.options.maxCacheSize = 3;
    unloads.length = 0;
    tileset.update({
      bounds: BOUNDS,
      zoom: 6,
      time: 32 * BUCKET_MS + 501,
      timeWindow: 100,
    });
    await settle();

    // Furthest-behind first — the incumbent plan, unchanged.
    expect(unloads).toEqual([26, 27]);
    expect(unloads).not.toContain(30);

    tileset.finalize();
  });
});

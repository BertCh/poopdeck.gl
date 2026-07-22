/**
 * Governor run-ahead cap + pressure-adaptive prefetch horizon.
 *
 * `setPrefetchRunAheadLimit(simMs)` is the governor's run-ahead fairness hook
 * (the Shaka MAX_RUN_AHEAD analog): in a composited scene, runway buffered
 * beyond the min-gated intersection of all required sources is dead weight,
 * so the governor caps each leader near the neediest source's frontier. The
 * cap carries an internal safety floor (`max(bucketMs, timeWindow,
 * |speed| × PREFETCH_CAP_FLOOR_REAL_MS)`) so it can never starve the
 * tileset's own speed-scaled gates, and lowering it flushes nothing.
 *
 * `prefetchPressureScale` is the shrink-the-goal ladder: tier-C/D (runway)
 * evictions decay it, quiet prefetch plans (no runway eviction for 5 s of
 * wall-clock) recover it by +0.1 toward 1 — degrade speculation under memory
 * pressure instead of fetch-evict-refetch thrashing.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { SpatiotemporalTileset } from '../src/spatiotemporal-tileset';
import type { TileId } from '../src/types';
import {
  BOUNDS,
  BUCKET_MS,
  fakeTile,
  makeAvailableTiles,
} from './helpers/fixtures';
import { advanceClock, installClock } from './helpers/clock';

const N_BUCKETS = 600;
const availableTiles = makeAvailableTiles(N_BUCKETS);

const settle = (ms = 60): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

interface Fixture {
  tileset: SpatiotemporalTileset;
  /** Every distinct prefetched bucket time (t > 0; t = 0 is priority). */
  prefetched: Set<number>;
  unloads: TileId[];
}

function makeFixture(
  opts: Partial<{ maxCacheSize: number; prefetchAhead: number }> = {},
): Fixture {
  const prefetched = new Set<number>();
  const unloads: TileId[] = [];
  const tileset = new SpatiotemporalTileset({
    minZoom: 0,
    maxZoom: 12,
    enablePrefetch: true,
    refinementStrategy: 'no-overlap',
    temporalBucketMs: BUCKET_MS,
    // One-step window lookahead so the horizon math in the assertions stays
    // legible: uncapped effectiveAhead = max(prefetchAhead, speed × 8 s).
    prefetchAhead: opts.prefetchAhead ?? 10 * BUCKET_MS,
    prefetchSteps: 1,
    maxCacheSize: opts.maxCacheSize ?? 2000,
    getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
    getTileData: async (id: TileId) => fakeTile(id),
    getTileDataBatch: async (ids: TileId[]) => {
      for (const id of ids) if (id.t > 0) prefetched.add(id.t);
      return ids.map(fakeTile);
    },
    onTileUnload: (tile) => unloads.push(tile.id),
  });
  return { tileset, prefetched, unloads };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SpatiotemporalTileset.setPrefetchRunAheadLimit', () => {
  it('caps the planned horizon, extends again when cleared, and never flushes on lowering', async () => {
    installClock();
    const { tileset, prefetched, unloads } = makeFixture();

    // Capped to 3 buckets of sim-time (speed 0 → the floor terms are just
    // bucketMs/timeWindow, both 1000 < 3000, so the cap itself governs).
    tileset.setPrefetchRunAheadLimit(3 * BUCKET_MS);
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await settle();
    expect(prefetched.size).toBeGreaterThan(0);
    // Horizon 3000 (+ half-window slack in the directory query) — nowhere
    // near the uncapped 10-bucket prefetchAhead.
    expect(Math.max(...prefetched)).toBeLessThanOrEqual(3 * BUCKET_MS + 500);

    // null clears: the next plan extends to the full uncapped horizon.
    tileset.setPrefetchRunAheadLimit(null);
    advanceClock(300); // beat the 250 ms prefetch debounce
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 1, timeWindow: BUCKET_MS });
    await settle();
    expect(Math.max(...prefetched)).toBeGreaterThanOrEqual(9 * BUCKET_MS);

    // Lowering the cap below the already-planned runway flushes NOTHING:
    // resident tiles stay, the cap only stops further extension.
    const residentBefore = tileset.getCacheStats().tileCount;
    tileset.setPrefetchRunAheadLimit(2 * BUCKET_MS);
    advanceClock(300);
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 2, timeWindow: BUCKET_MS });
    await settle();
    expect(unloads).toEqual([]);
    expect(tileset.getCacheStats().tileCount).toBe(residentBefore);

    tileset.finalize();
  });

  it('enforces the speed-scaled safety floor so a tiny cap cannot starve the gates', async () => {
    const { tileset, prefetched } = makeFixture();

    // speed 10 sim-ms/real-ms → floor = 10 × PREFETCH_CAP_FLOOR_REAL_MS(5 s)
    // = 50 000 sim-ms. A 3-bucket cap must be lifted to that floor (while the
    // 64-bucket ceiling would have allowed 64 000).
    tileset.setAnimationState(true, 10);
    tileset.setPrefetchRunAheadLimit(3 * BUCKET_MS);
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await settle(100);

    const frontier = Math.max(...prefetched);
    expect(frontier).toBeGreaterThanOrEqual(40 * BUCKET_MS); // floor held
    expect(frontier).toBeLessThanOrEqual(50 * BUCKET_MS + 500); // cap ≠ ceiling

    tileset.finalize();
  });

  it('floors the horizon at the resident window even under an absurd cap', async () => {
    const { tileset, prefetched } = makeFixture();

    tileset.setPrefetchRunAheadLimit(1); // 1 sim-ms "cap"
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await settle();

    // max(bucketMs, timeWindow) = 1000: the next bucket still prefetches.
    expect(prefetched.has(BUCKET_MS)).toBe(true);

    tileset.finalize();
  });

  it('forwards setBandwidthWeight to the wired loader callback', () => {
    const weights: number[] = [];
    const tileset = new SpatiotemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: false,
      getAvailableTiles: async () => [],
      getTileData: async (id: TileId) => fakeTile(id),
      setSchedulerWeight: (w) => weights.push(w),
    });
    tileset.setBandwidthWeight(2.5);
    expect(weights).toEqual([2.5]);
    tileset.finalize();
  });
});

describe('SpatiotemporalTileset prefetch pressure ladder', () => {
  it('decays under runway evictions, then recovers after a quiet 5 s', async () => {
    installClock();
    // A cache smaller than the 30-bucket prefetch horizon: the runway itself
    // overflows the limit, forcing tier-C evictions until the shrunken
    // horizon fits — the full self-regulation loop.
    const { tileset } = makeFixture({
      maxCacheSize: 20,
      prefetchAhead: 30 * BUCKET_MS,
    });

    tileset.update({
      bounds: BOUNDS,
      zoom: 6,
      time: 500,
      timeWindow: 100,
    });
    // Coverage tracking on (the tiered eviction needs the index).
    tileset.getBufferedRanges();
    await settle(80);

    // Churn until the ladder stabilizes: horizon × scale below the cache
    // limit means no further runway evictions.
    let previous = { scale: 1, tiles: 0 };
    let stable = 0;
    for (let i = 1; i <= 10 && stable < 2; i++) {
      advanceClock(300);
      tileset.update({
        bounds: BOUNDS,
        zoom: 6,
        time: 500 + i,
        timeWindow: 100,
      });
      await settle(40);
      const stats = tileset.getCacheStats();
      const current = {
        scale: stats.prefetchPressureScale,
        tiles: stats.tileCount,
      };
      stable =
        current.scale === previous.scale && current.tiles === previous.tiles
          ? stable + 1
          : 0;
      previous = current;
    }

    const churned = tileset.getCacheStats();
    expect(churned.runwayEvictions).toBeGreaterThan(0);
    expect(churned.prefetchPressureScale).toBeLessThan(1);
    expect(churned.prefetchPressureScale).toBeGreaterThanOrEqual(0.25);
    expect(churned.tileCount).toBeLessThanOrEqual(20);

    // Quiet recovery: one plan after 5 s without a runway eviction steps the
    // scale up by exactly +0.1 (toward 1).
    advanceClock(5001);
    tileset.update({
      bounds: BOUNDS,
      zoom: 6,
      time: 600,
      timeWindow: 100,
    });
    await settle(40);
    expect(tileset.getCacheStats().prefetchPressureScale).toBeCloseTo(
      Math.min(1, churned.prefetchPressureScale + 0.1),
      10,
    );

    tileset.finalize();
  });
});

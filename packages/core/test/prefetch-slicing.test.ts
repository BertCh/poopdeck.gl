/**
 * Tests for slice-based prefetch dispatch + incremental batch delivery.
 *
 * Before this, the prefetch tier dispatched its whole planned runway as ONE
 * coalesced batch (up to MAX_COALESCE_BATCH = 1024 tiles), and the tileset
 * marked tiles loaded only when the entire batch promise settled. Two failure
 * modes followed, both hitting exactly when playback is most demanding:
 *
 * - HOSTAGE WINDOW: a tile the play head reached while its batch was in
 *   flight was `isLoading`, so the priority path could neither promote nor
 *   re-fetch it — immediate playback waited on the whole giant batch.
 * - ALL-OR-NOTHING DELIVERY: the nearest prefetched bucket only became
 *   renderable when the FARTHEST range request of its batch finished.
 *
 * The fix is the streaming-video segment model (hls.js/Shaka precedent):
 * prefetch dispatches small time-ordered slices sized in bytes to
 * ≈ PREFETCH_SLICE_TARGET_REAL_MS of measured download, one slice in flight
 * at a time; and batches deliver each tile the moment its own coalesced
 * range group decodes (`onTileReady`), not when the batch settles.
 */

import { describe, it, expect, vi } from 'vitest';
import { SpatiotemporalTileset, type TileBatchHooks } from '../src/spatiotemporal-tileset';
import type { TileId, BoundingBox, Tile } from '../src/types';

const BOUNDS: BoundingBox = { minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 };
const BUCKET_MS = 1000;
const N_BUCKETS = 600;

function fakeTile(id: TileId): Tile {
  return { id, timeRange: { start: id.t, end: id.t + BUCKET_MS }, layers: [] } as Tile;
}

/** Synthetic single-cell archive: one tile per bucket at the requested zoom. */
function availableTiles(
  _b: BoundingBox,
  z: number,
  range: { start: number; end: number },
): TileId[] {
  const ids: TileId[] = [];
  const first = Math.max(0, Math.floor(range.start / BUCKET_MS));
  const last = Math.min(N_BUCKETS - 1, Math.floor(range.end / BUCKET_MS));
  for (let i = first; i <= last; i++) {
    const t = i * BUCKET_MS;
    if (t + BUCKET_MS >= range.start && t <= range.end) ids.push({ z, x: 0, y: 0, t });
  }
  return ids;
}

/** Partition spy calls into priority (contains t=0) and prefetch (all t>0). */
function splitCalls(calls: unknown[][]): { priority: TileId[][]; prefetch: TileId[][] } {
  const priority: TileId[][] = [];
  const prefetch: TileId[][] = [];
  for (const call of calls) {
    const ids = call[0] as TileId[];
    if (ids.some((id) => id.t === 0)) priority.push(ids);
    else prefetch.push(ids);
  }
  return { priority, prefetch };
}

describe('SpatiotemporalTileset prefetch slicing', () => {
  it('dispatches prefetch in byte-budgeted nearest-first slices sized from measured throughput', async () => {
    const batchSpy = vi.fn(
      async (batch: TileId[], _s?: AbortSignal, _h?: TileBatchHooks) => batch.map(fakeTile),
    );

    // 2048 B/ms × 1000 ms target = 2 048 000 B budget; 512 000 B per tile
    // ⇒ exactly 4 tiles per slice.
    const tileset = new SpatiotemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      maxCacheSize: 300, // prefetch planning budget = 150 tiles
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: batchSpy,
      getTileByteSize: () => 512_000,
      getThroughput: () => ({ bytesPerMs: 2048, samples: 10 }),
    });

    // Fast playback ⇒ the lookahead span covers all 600 future buckets.
    tileset.setAnimationState(true, 1000);
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await new Promise((r) => setTimeout(r, 80));

    const { prefetch } = splitCalls(batchSpy.mock.calls);
    expect(prefetch.length).toBeGreaterThan(1); // sliced, not one giant batch

    // SLICE BOUND: every prefetch dispatch fits the byte budget (4 tiles).
    for (const ids of prefetch) expect(ids.length).toBeLessThanOrEqual(4);

    // NEAREST-FIRST, IN ORDER: the first slice is exactly the 4 most imminent
    // buckets, the second the next 4 — the queue drains in playback order.
    expect(prefetch[0].map((id) => id.t)).toEqual([1000, 2000, 3000, 4000]);
    expect(prefetch[1].map((id) => id.t)).toEqual([5000, 6000, 7000, 8000]);

    tileset.finalize();
  });

  it('tags prefetch slices fetchPriority=low and priority batches auto', async () => {
    const hooksSeen: { ids: TileId[]; hooks?: TileBatchHooks }[] = [];
    const batchSpy = vi.fn(async (batch: TileId[], _s?: AbortSignal, hooks?: TileBatchHooks) => {
      hooksSeen.push({ ids: batch, hooks });
      return batch.map(fakeTile);
    });

    const tileset = new SpatiotemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      maxCacheSize: 300,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: batchSpy,
    });

    tileset.setAnimationState(true, 1000);
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await new Promise((r) => setTimeout(r, 80));

    const priorityCalls = hooksSeen.filter((c) => c.ids.some((id) => id.t === 0));
    const prefetchCalls = hooksSeen.filter((c) => c.ids.every((id) => id.t > 0));
    expect(priorityCalls.length).toBeGreaterThan(0);
    expect(prefetchCalls.length).toBeGreaterThan(0);
    for (const c of priorityCalls) expect(c.hooks?.fetchPriority).toBe('auto');
    for (const c of prefetchCalls) expect(c.hooks?.fetchPriority).toBe('low');

    tileset.finalize();
  });

  it('falls back to the cold-start byte budget and the per-tile size guess', async () => {
    // No throughput sample and no size lookup: budget = 4 MiB cold ⇒
    // 4 MiB / 64 KiB guess = 64 tiles per slice.
    const batchSpy = vi.fn(async (batch: TileId[]) => batch.map(fakeTile));

    const tileset = new SpatiotemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      maxCacheSize: 300, // planning budget 150 ⇒ slices of 64 / 64 / 22
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: batchSpy,
    });

    tileset.setAnimationState(true, 1000);
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await new Promise((r) => setTimeout(r, 80));

    const { prefetch } = splitCalls(batchSpy.mock.calls);
    expect(Math.max(...prefetch.map((ids) => ids.length))).toBe(64);

    tileset.finalize();
  });

  it('a tile bigger than the whole slice budget still ships, alone in its own slice', async () => {
    const batchSpy = vi.fn(async (batch: TileId[]) => batch.map(fakeTile));

    const tileset = new SpatiotemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      maxCacheSize: 300,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: batchSpy,
      // Every tile dwarfs the 4 MiB cold budget.
      getTileByteSize: () => 10 * 1024 * 1024,
    });

    tileset.setAnimationState(true, 1000);
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await new Promise((r) => setTimeout(r, 80));

    const { prefetch } = splitCalls(batchSpy.mock.calls);
    expect(prefetch.length).toBeGreaterThan(2);
    for (const ids of prefetch) expect(ids.length).toBe(1);
    expect(prefetch[0][0].t).toBe(1000);
    expect(prefetch[1][0].t).toBe(2000);

    tileset.finalize();
  });
});

describe('SpatiotemporalTileset incremental batch delivery', () => {
  it('marks a tile loaded the moment onTileReady delivers it, without double-counting on settle', async () => {
    const loaded: TileId[] = [];
    let releaseBatch!: () => void;
    const gate = new Promise<void>((r) => (releaseBatch = r));

    // Batch fn that delivers its FIRST tile immediately via the hook, then
    // holds the batch promise open (the slow far range group) before
    // resolving the full array — which REPLAYS tile 0.
    const batchSpy = vi.fn((batch: TileId[], _s?: AbortSignal, hooks?: TileBatchHooks) => {
      hooks?.onTileReady?.(0, fakeTile(batch[0]));
      return gate.then(() => batch.map(fakeTile));
    });

    const tileset = new SpatiotemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: batchSpy,
      onTileLoad: (tile) => loaded.push(tile.id),
    });

    // A window spanning 3 buckets ⇒ one priority batch of 3 tiles.
    tileset.update({ bounds: BOUNDS, zoom: 6, time: BUCKET_MS, timeWindow: 2 * BUCKET_MS });
    await new Promise((r) => setTimeout(r, 30));

    // The batch is still in flight, but the hook-delivered tile is already
    // loaded and renderable.
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(loaded.length).toBe(1);

    releaseBatch();
    await new Promise((r) => setTimeout(r, 30));

    // The rest arrived on settle; the early tile was NOT delivered twice.
    const batchSize = (batchSpy.mock.calls[0][0] as TileId[]).length;
    expect(loaded.length).toBe(batchSize);
    const keys = loaded.map((id) => `${id.z}/${id.x}/${id.y}/${id.t}`);
    expect(new Set(keys).size).toBe(keys.length);

    tileset.finalize();
  });
});

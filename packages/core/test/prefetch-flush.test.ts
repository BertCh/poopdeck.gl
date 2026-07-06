/**
 * Tests for prefetch flushing on time jumps (player buffering WS-C3).
 *
 * A seek used to leave the prefetch queue and its in-flight batches pointed
 * at the OLD play-head position, competing with the seek's priority fetches
 * for the request pool (prefetch was never cancelled). `flushPrefetch()`
 * clears the queue, aborts in-flight PREFETCH-tier requests — never
 * priority-tier ones — and resets the runway bookkeeping; the selection path
 * auto-flushes when the requested time jumps by more than one time window.
 */

import { describe, it, expect, vi } from 'vitest';
import { SpatiotemporalTileset } from '../src/spatiotemporal-tileset';
import type { TileId, BoundingBox, Tile } from '../src/types';
import { BOUNDS, BUCKET_MS, fakeTile, makeAvailableTiles, settle } from './helpers/fixtures';

const N_BUCKETS = 100;

/** One tile per bucket at (x=0, y=0) whose interval overlaps the range. */
const availableTiles = makeAvailableTiles(N_BUCKETS);


/** A gated batch request: stays pending until resolved, rejects on abort. */
interface GatedBatch {
  ids: TileId[];
  signal: AbortSignal | undefined;
  resolve: () => void;
}

function gatedBatchFn(batches: GatedBatch[]) {
  return (ids: TileId[], signal?: AbortSignal): Promise<(Tile | null)[]> =>
    new Promise<(Tile | null)[]>((resolve, reject) => {
      batches.push({ ids, signal, resolve: () => resolve(ids.map(fakeTile)) });
      signal?.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      );
    });
}

describe('SpatiotemporalTileset.flushPrefetch', () => {
  it('aborts in-flight PREFETCH batches without touching priority in-flight', async () => {
    const batches: GatedBatch[] = [];
    const loaded: TileId[] = [];
    const tileset = new SpatiotemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: gatedBatchFn(batches),
      onTileLoad: (t) => loaded.push(t.id),
    });

    // Window [-500, 500] → bucket 0 is the priority working set; the default
    // prefetch lookahead (30 s × 4 steps) then enqueues + batch-starts the
    // future buckets while the priority batch is still in flight.
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await settle();

    expect(batches.length).toBeGreaterThanOrEqual(2);
    const priorityBatch = batches[0];
    const prefetchBatches = batches.slice(1);
    expect(priorityBatch.ids.every((id) => id.t === 0)).toBe(true);
    expect(prefetchBatches.every((b) => b.ids.every((id) => id.t > 0))).toBe(true);

    tileset.flushPrefetch();

    // Prefetch-tier in-flight requests are aborted; the priority one is not.
    for (const b of prefetchBatches) expect(b.signal?.aborted).toBe(true);
    expect(priorityBatch.signal?.aborted).toBe(false);
    expect(tileset.getCacheStats().prefetchQueueLength).toBe(0);

    // The untouched priority batch still completes and delivers its tile.
    priorityBatch.resolve();
    await settle();
    expect(loaded.map((id) => id.t)).toContain(0);
    // Nothing from the aborted prefetch batches landed.
    expect(loaded.every((id) => id.t === 0)).toBe(true);

    tileset.finalize();
  });

  it('clears QUEUED prefetch tiles on the per-tile (non-batch) path', async () => {
    const singles: Array<{ id: TileId; signal: AbortSignal | undefined }> = [];
    const tileset = new SpatiotemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      maxRequests: 4, // paused prefetch share → only 1 prefetch single in flight
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: (id: TileId, signal?: AbortSignal) =>
        new Promise<Tile | null>((_resolve, reject) => {
          singles.push({ id, signal });
          signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    });

    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await settle();

    // The slot budget left most of the prefetch lookahead QUEUED.
    expect(tileset.getCacheStats().prefetchQueueLength).toBeGreaterThan(0);
    const prefetchSingles = singles.filter((s) => s.id.t > 0);
    expect(prefetchSingles.length).toBeGreaterThan(0);

    tileset.flushPrefetch();

    expect(tileset.getCacheStats().prefetchQueueLength).toBe(0);
    for (const s of prefetchSingles) expect(s.signal?.aborted).toBe(true);
    // The priority single (bucket 0) is untouched.
    const prioritySingle = singles.find((s) => s.id.t === 0);
    expect(prioritySingle?.signal?.aborted).toBe(false);

    tileset.finalize();
  });

  it('auto-flushes when the selection time jumps more than one window (seek)', async () => {
    // Per-tile path with a tight slot budget, so most of the prefetch
    // lookahead sits in the QUEUE — the flush-specific observable
    // (cancelSupersededRequests would abort in-flight work on any needed-set
    // change, but only a flush empties the queue).
    const singles: Array<{ id: TileId; signal: AbortSignal | undefined }> = [];
    const tileset = new SpatiotemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      maxRequests: 4,
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: (id: TileId, signal?: AbortSignal) =>
        new Promise<Tile | null>((_resolve, reject) => {
          singles.push({ id, signal });
          signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    });

    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await settle();
    expect(tileset.getCacheStats().prefetchQueueLength).toBeGreaterThan(0);
    const prefetchSingles = singles.filter((s) => s.id.t > 0);
    expect(prefetchSingles.length).toBeGreaterThan(0);

    // SEEK: jump 50 buckets — far more than one time window. Even without an
    // explicit flushPrefetch() call, the stale prefetch queue is dropped and
    // its in-flight requests aborted.
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 50_000, timeWindow: BUCKET_MS });
    await settle();
    expect(tileset.getCacheStats().prefetchQueueLength).toBe(0);
    for (const s of prefetchSingles) expect(s.signal?.aborted).toBe(true);

    tileset.finalize();
  });

  it('does NOT flush on ordinary playback steps (≤ one window)', async () => {
    const tileset = new SpatiotemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      maxRequests: 4,
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      // Gated (never resolves) so the queue can't drain via completions.
      getTileData: () => new Promise<Tile | null>(() => {}),
    });

    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await settle();
    const queuedBefore = tileset.getCacheStats().prefetchQueueLength;
    expect(queuedBefore).toBeGreaterThan(0);

    // A normal animation step (half a window) must keep the queued runway
    // intact (modulo tiles promoted into the new priority window).
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 500, timeWindow: BUCKET_MS });
    await settle();
    expect(tileset.getCacheStats().prefetchQueueLength).toBeGreaterThan(queuedBefore - 4);

    tileset.finalize();
  });

  it('lets a flushed-then-still-needed tile reload on the next selection', async () => {
    // Regression guard for the header-shadowing trap: flushPrefetch drops the
    // flushed tiles' headers, so a later selection (or prefetch pass) can
    // re-enqueue them — a lingering unloaded header would block that forever.
    const loaded: TileId[] = [];
    const tileset = new SpatiotemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: async (ids: TileId[]) => ids.map(fakeTile),
      onTileLoad: (t) => loaded.push(t.id),
    });

    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await settle();
    tileset.flushPrefetch();

    // Play head advances into a bucket that was just flushed from prefetch:
    // the next selection re-creates its header and loads it at priority.
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 2000, timeWindow: BUCKET_MS });
    await settle();
    expect(loaded.some((id) => id.t === 2000)).toBe(true);

    tileset.finalize();
  });

  // ── Spatial flush tolerance (motion-stutter fix) ──────────────────────────
  // A controlled camera (AV ego-follow) shifts the bounds a sub-tile sliver
  // every frame. The flush decision keys on bounds quantized to ~1/8 of the
  // viewport, so DRIFT keeps the runway while a real PAN/zoom still flushes it.
  const SMALL: BoundingBox = { minLon: 0, minLat: 0, maxLon: 0.008, maxLat: 0.008 };

  function prefetchingTileset(batches: GatedBatch[]) {
    return new SpatiotemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: gatedBatchFn(batches),
    });
  }

  it('does NOT flush prefetch on sub-viewport camera drift', async () => {
    const batches: GatedBatch[] = [];
    const tileset = prefetchingTileset(batches);

    tileset.update({ bounds: SMALL, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await settle();
    const prefetchBatches = batches.slice(1); // [0] is the priority batch
    expect(prefetchBatches.length).toBeGreaterThan(0);
    expect(prefetchBatches.every((b) => !b.signal?.aborted)).toBe(true);

    // Drift the viewport by < 1/8 of the 0.008° span (0.001°): 0.0002°.
    const drift: BoundingBox = { minLon: 0.0002, minLat: 0.0002, maxLon: 0.0082, maxLat: 0.0082 };
    tileset.update({ bounds: drift, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await settle();

    // Runway preserved — the in-flight prefetch was NOT aborted.
    expect(prefetchBatches.every((b) => !b.signal?.aborted)).toBe(true);

    tileset.finalize();
  });

  it('DOES flush prefetch on a real pan (> ~1/8 of the viewport)', async () => {
    const batches: GatedBatch[] = [];
    const tileset = prefetchingTileset(batches);

    tileset.update({ bounds: SMALL, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await settle();
    const prefetchBatches = batches.slice(1);
    expect(prefetchBatches.length).toBeGreaterThan(0);
    expect(prefetchBatches.every((b) => !b.signal?.aborted)).toBe(true);

    // Pan by > 1/8 of the span (0.001°): 0.003° crosses several grid cells.
    const pan: BoundingBox = { minLon: 0.003, minLat: 0.003, maxLon: 0.011, maxLat: 0.011 };
    tileset.update({ bounds: pan, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await settle();

    // Stale runway flushed — every original in-flight prefetch was aborted.
    expect(prefetchBatches.every((b) => b.signal?.aborted)).toBe(true);

    tileset.finalize();
  });

  it('flushes on a zoom change even when bounds are unchanged', async () => {
    const batches: GatedBatch[] = [];
    const tileset = prefetchingTileset(batches);

    tileset.update({ bounds: SMALL, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await settle();
    const prefetchBatches = batches.slice(1);
    expect(prefetchBatches.length).toBeGreaterThan(0);

    tileset.update({ bounds: SMALL, zoom: 7, time: 0, timeWindow: BUCKET_MS });
    await settle();
    expect(prefetchBatches.every((b) => b.signal?.aborted)).toBe(true);

    tileset.finalize();
  });
});

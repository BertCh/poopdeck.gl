/**
 * Tier-aware supersession + speed-aware seek detection (the fast-playback
 * prefetch fix).
 *
 * The 2026-06 audit found the prefetch runway collapsing during fast
 * playback: `cancelSupersededRequests` treated "not in the current window's
 * needed set" as supersession, but prefetch tiles are intentionally AHEAD of
 * the window — so every selection pass (~100 ms wall at speed) aborted every
 * in-flight prefetch batch before it could complete, and the shared
 * per-batch AbortController let one stale trailing tile kill whole priority
 * batches too. These tests lock in the tier-aware policy:
 *
 * - in-flight PREFETCH work survives ordinary playback steps (only
 *   flushPrefetch — seeks / viewport changes / direction flips — aborts it);
 * - in-flight PRIORITY batches survive partial (trailing-edge) supersession
 *   and die only when EVERY member is superseded (a seek);
 * - seek detection is SPEED-aware (a high-speed step legitimately exceeds
 *   one time window without being a seek);
 * - dispatch accounting is per BATCH, so a large in-flight batch can no
 *   longer block priority dispatch.
 */

import { describe, it, expect } from 'vitest';
import { SpatiotemporalTileset } from '../src/spatiotemporal-tileset';
import type { TileId, BoundingBox, Tile } from '../src/types';
import { BOUNDS, BUCKET_MS, fakeTile, makeAvailableTiles } from './helpers/fixtures';

const SHIFTED_BOUNDS: BoundingBox = { minLon: -90, minLat: -85, maxLon: 90, maxLat: 85 };
const N_BUCKETS = 200;

/** One tile per bucket at (x=0, y=0) whose interval overlaps the range. */
const availableTiles = makeAvailableTiles(N_BUCKETS);

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

function makeTileset(batches: GatedBatch[], loaded: TileId[] = []) {
  return new SpatiotemporalTileset({
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
}

describe('tier-aware supersession (cancelSupersededRequests)', () => {
  it('an ordinary playback step does NOT abort the in-flight prefetch batch', async () => {
    const batches: GatedBatch[] = [];
    const loaded: TileId[] = [];
    const tileset = makeTileset(batches, loaded);

    tileset.setAnimationState(true, 10);
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS }, true);
    await settle();

    // Resolve the priority batch (bucket 0); the prefetch runway dispatches.
    expect(batches.length).toBeGreaterThanOrEqual(1);
    batches[0].resolve();
    await settle(300); // let the debounced prefetch plan + dispatch

    const prefetchBatches = batches.slice(1).filter((b) => b.ids.every((id) => id.t > 0));
    expect(prefetchBatches.length).toBeGreaterThan(0);

    // Ordinary playback step (half a window): the runway ahead is exactly
    // what the play head is about to consume — it must survive.
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 500, timeWindow: BUCKET_MS }, true);
    await settle();
    expect(prefetchBatches.every((b) => !b.signal?.aborted)).toBe(true);

    // …and its tiles actually land once the batch completes.
    for (const b of prefetchBatches) b.resolve();
    await settle();
    expect(loaded.some((id) => id.t > 0)).toBe(true);

    tileset.finalize();
  });

  it('a priority batch with SOME still-needed members survives the trailing edge', async () => {
    const batches: GatedBatch[] = [];
    const tileset = makeTileset(batches);

    // Window [0, 3000] → buckets 0..3 in one priority batch.
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 1500, timeWindow: 3 * BUCKET_MS }, true);
    await settle();
    const priorityBatch = batches[0];
    expect(priorityBatch.ids.length).toBeGreaterThan(1);

    // Window slides to [1000, 4000]: bucket 0 leaves the needed set, but
    // buckets 1–3 are still needed — the shared-controller batch must NOT be
    // killed for its trailing edge.
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 2500, timeWindow: 3 * BUCKET_MS }, true);
    await settle();
    expect(priorityBatch.signal?.aborted).toBe(false);

    tileset.finalize();
  });

  it('a priority batch whose EVERY member is superseded (a seek) is aborted', async () => {
    const batches: GatedBatch[] = [];
    const tileset = makeTileset(batches);

    tileset.update({ bounds: BOUNDS, zoom: 6, time: 1500, timeWindow: 3 * BUCKET_MS }, true);
    await settle();
    const priorityBatch = batches[0];

    // Seek far away: none of the old batch's buckets are needed any more.
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 100_000, timeWindow: 3 * BUCKET_MS }, true);
    await settle();
    expect(priorityBatch.signal?.aborted).toBe(true);

    tileset.finalize();
  });

  it('a spatial viewport change (pan) flushes the in-flight prefetch batch', async () => {
    const batches: GatedBatch[] = [];
    const tileset = makeTileset(batches);

    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS }, true);
    await settle();
    batches[0].resolve();
    await settle(300);

    const prefetchBatches = batches.slice(1).filter((b) => b.ids.every((id) => id.t > 0));
    expect(prefetchBatches.length).toBeGreaterThan(0);
    expect(prefetchBatches.every((b) => !b.signal?.aborted)).toBe(true);

    // Pan: same time, new bounds — the runway was planned for the old
    // viewport and is auto-flushed.
    tileset.update({ bounds: SHIFTED_BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS }, true);
    await settle();
    expect(prefetchBatches.every((b) => b.signal?.aborted)).toBe(true);

    tileset.finalize();
  });
});

describe('speed-aware seek detection', () => {
  it('a high-speed step beyond one window is NOT a seek; a genuine jump is', async () => {
    const batches: GatedBatch[] = [];
    const tileset = makeTileset(batches);

    // Signalled speed 100 sim-ms/real-ms → seek threshold 100 000 sim-ms.
    tileset.setAnimationState(true, 100);
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS }, true);
    await settle();
    batches[0].resolve();
    await settle(300);

    const prefetchBatches = batches.slice(1).filter((b) => b.ids.every((id) => id.t > 0));
    expect(prefetchBatches.length).toBeGreaterThan(0);

    // Five windows in one step — far beyond the old window-only threshold,
    // comfortably inside the speed-aware one. Must NOT flush.
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 5000, timeWindow: BUCKET_MS }, true);
    await settle();
    expect(prefetchBatches.every((b) => !b.signal?.aborted)).toBe(true);

    // A genuine jump (≫ |speed| × 1 s for any plausible measured speed in
    // this test) IS a seek and flushes the runway.
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 5_000_000, timeWindow: BUCKET_MS }, true);
    await settle();
    expect(prefetchBatches.every((b) => b.signal?.aborted)).toBe(true);

    tileset.finalize();
  });
});

describe('per-batch dispatch accounting', () => {
  it('priority work dispatches while a LARGE batch is still in flight', async () => {
    const batches: GatedBatch[] = [];
    // No prefetch: the large in-flight batch is the 51-bucket priority
    // working set itself (51 tiles ≫ the default maxRequests of 24 — the old
    // tile-granular slot math would compute availableSlots ≤ 0 and dispatch
    // NOTHING until it settled).
    const tileset = new SpatiotemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: gatedBatchFn(batches),
    });

    tileset.update({ bounds: BOUNDS, zoom: 6, time: 25_000, timeWindow: 50 * BUCKET_MS }, true);
    await settle();
    expect(batches.length).toBe(1);
    expect(batches[0].ids.length).toBeGreaterThan(24); // exceeds maxRequests

    // The window slides one bucket: the newly-needed bucket must dispatch
    // immediately even though the 51-tile batch is still pending.
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 26_000, timeWindow: 50 * BUCKET_MS }, true);
    await settle();
    const followUp = batches.slice(1);
    expect(followUp.some((b) => b.ids.some((id) => id.t === 51_000))).toBe(true);
    // And the original batch was not killed for its trailing edge.
    expect(batches[0].signal?.aborted).toBe(false);

    tileset.finalize();
  });
});

/**
 * Tests for the cache-bounded, nearest-first prefetch runway.
 *
 * Before this, prefetchFutureTiles enqueued EVERY tile in the lookahead span,
 * and the span is sized in sim-time (speed × LOOKAHEAD). On a fast playback
 * (e.g. drifters: ~43 yr in 60 s) that is years / hundreds-of-buckets ahead —
 * far more than the LRU holds. The runway overflowed the cache, tiles were
 * evicted before the play head arrived, and the priority path then re-fetched
 * each one individually (byte-scattered ⇒ uncoalescable ⇒ a flood of tiny
 * single-tile requests).
 *
 * The fix bounds the per-pass prefetch enqueue to a fraction of the cache and
 * orders candidates by temporal distance from the play head, so a finite budget
 * always buys the most IMMINENT buckets and the runway stays resident.
 */

import { describe, it, expect, vi } from 'vitest';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import type { TileId, BoundingBox } from '../src/types';
import {
  BOUNDS,
  BUCKET_MS,
  fakeTile,
  makeAvailableTiles,
} from './helpers/fixtures';

const N_BUCKETS = 600;

/**
 * Synthetic single-cell archive: one tile per time bucket at the requested
 * zoom, returned when its [t, t+BUCKET] interval overlaps the query range.
 */
const availableTiles = makeAvailableTiles(N_BUCKETS);

describe('SpatioTemporalTileset prefetch runway', () => {
  it('caps the prefetch enqueue to a cache fraction and picks the nearest upcoming buckets', async () => {
    const batchSpy = vi.fn(async (batch: TileId[]) => batch.map(fakeTile));
    const singleSpy = vi.fn(async (id: TileId) => fakeTile(id));

    const maxCacheSize = 300; // => prefetch budget = floor(300 * 0.5) = 150
    const budget = 150;

    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      maxCacheSize,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: singleSpy,
      getTileDataBatch: batchSpy,
    });

    // Fast playback: a large animationSpeed makes the lookahead span ALL 600
    // future buckets, so without the budget the prefetch would enqueue ~599.
    tileset.setAnimationState(true, 1000);
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await new Promise((r) => setTimeout(r, 80));

    // Gather every distinct prefetched bucket. t === 0 is the current/priority
    // tile (served on the single path); everything t > 0 is prefetch.
    const prefetched = new Set<number>();
    for (const call of batchSpy.mock.calls) {
      for (const id of call[0] as TileId[]) if (id.t > 0) prefetched.add(id.t);
    }

    // BOUND: the runway never exceeds the cache-fraction budget, even though
    // ~599 future buckets were in range. Pre-fix this enqueued them all.
    expect(prefetched.size).toBeGreaterThan(0);
    expect(prefetched.size).toBeLessThanOrEqual(budget);

    // NEAREST-FIRST: the budget bought the imminent buckets, not a far slice.
    const maxT = Math.max(...prefetched);
    expect(maxT).toBeLessThanOrEqual(budget * BUCKET_MS);
    // The far end of the span was deliberately NOT prefetched.
    expect(prefetched.has((N_BUCKETS - 1) * BUCKET_MS)).toBe(false);

    tileset.finalize();
  });

  it('prefetches BACKWARD nearest-first when the play head reverses', async () => {
    const batchSpy = vi.fn(async (batch: TileId[]) => batch.map(fakeTile));

    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      maxCacheSize: 300, // budget 150
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: batchSpy,
    });

    // Commit a backward prefetch direction (needs DIRECTION_FLIP_THRESHOLD=3
    // consecutive backward frames), anchored near the end of the timeline.
    const start = (N_BUCKETS - 1) * BUCKET_MS;
    tileset.setAnimationState(true, 1000);
    tileset.update({
      bounds: BOUNDS,
      zoom: 6,
      time: start,
      timeWindow: BUCKET_MS,
    });
    for (let i = 1; i <= 4; i++) {
      tileset.update({
        bounds: BOUNDS,
        zoom: 6,
        time: start - i * BUCKET_MS,
        timeWindow: BUCKET_MS,
      });
    }
    await new Promise((r) => setTimeout(r, 80));

    expect(tileset.getPrefetchDirection()).toBe(-1);

    const prefetched = new Set<number>();
    for (const call of batchSpy.mock.calls) {
      for (const id of call[0] as TileId[]) prefetched.add(id.t);
    }
    // Backward runway: the EARLIEST bucket (t=0) must not be pulled before the
    // buckets just behind the head.
    expect(prefetched.has(0)).toBe(false);
    const minT = Math.min(...prefetched);
    expect(minT).toBeGreaterThanOrEqual(start - 200 * BUCKET_MS);

    tileset.finalize();
  });

  it('commits prefetch direction immediately from a signed speed (no hysteresis)', () => {
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      maxCacheSize: 300,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: async (batch: TileId[]) => batch.map(fakeTile),
    });

    // Default is forward.
    expect(tileset.getPrefetchDirection()).toBe(1);

    // A negative speed (a ping-pong controller reversing at a boundary) is an
    // authoritative signal: one call flips direction, no DIRECTION_FLIP_THRESHOLD
    // frames of observed backward deltas required.
    tileset.setAnimationState(true, -500);
    expect(tileset.getPrefetchDirection()).toBe(-1);

    // ...and back to forward, again in a single call.
    tileset.setAnimationState(true, 500);
    expect(tileset.getPrefetchDirection()).toBe(1);

    // A zero speed (pause) leaves the committed direction untouched.
    tileset.setAnimationState(false, 0);
    expect(tileset.getPrefetchDirection()).toBe(1);

    tileset.finalize();
  });
});

describe('SpatioTemporalTileset byte-aware parent-fallback skip', () => {
  it('skips oversized parent tiles but always loads the primary zoom and cheap parents', async () => {
    // A z14 street view: primary tile (9 KB) + a cheap z13 parent (300 KB) +
    // a GIANT z10 parent (14 MB) — the over-fetch the skip must drop.
    const primary: TileId = { z: 14, x: 100, y: 200, t: 0 };
    const cheapParent: TileId = { z: 13, x: 12, y: 25, t: 0 };
    const giantParent: TileId = { z: 10, x: 6, y: 12, t: 0 };

    const sizes = new Map<string, number>([
      ['14/100/200/0', 9_000],
      ['13/12/25/0', 300_000],
      ['10/6/12/0', 14_000_000],
    ]);
    const getTileByteSize = (id: TileId): number | undefined =>
      sizes.get(`${id.z}/${id.x}/${id.y}/${id.t}`);

    const avail = vi.fn(async (_b: BoundingBox, z: number) => {
      if (z === 14) return [primary];
      if (z === 13) return [cheapParent];
      if (z === 10) return [giantParent];
      return [];
    });

    const requested: TileId[] = [];
    const batchSpy = vi.fn(async (batch: TileId[]) => {
      requested.push(...batch);
      return batch.map(fakeTile);
    });
    const singleSpy = vi.fn(async (id: TileId) => {
      requested.push(id);
      return fakeTile(id);
    });

    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 14,
      enablePrefetch: false,
      maxParentTileBytes: 2_000_000,
      getAvailableTiles: avail,
      getTileByteSize,
      getTileData: singleSpy,
      getTileDataBatch: batchSpy,
    });

    tileset.update({ bounds: BOUNDS, zoom: 14, time: 0, timeWindow: 1000 });
    await new Promise((r) => setTimeout(r, 40));

    const reqKeys = new Set(
      requested.map((id) => `${id.z}/${id.x}/${id.y}/${id.t}`),
    );
    expect(reqKeys.has('14/100/200/0')).toBe(true); // primary always loads
    expect(reqKeys.has('13/12/25/0')).toBe(true); // cheap parent kept as fallback
    expect(reqKeys.has('10/6/12/0')).toBe(false); // giant parent skipped

    tileset.finalize();
  });

  it('loads oversized PRIMARY-zoom tiles (the skip only applies to parents)', async () => {
    // Even a 14 MB tile is loaded when it IS the display zoom — we never refuse
    // to draw what the user is looking at.
    const primary: TileId = { z: 14, x: 1, y: 1, t: 0 };
    const getTileByteSize = (id: TileId): number | undefined =>
      id.z === 14 ? 14_000_000 : undefined;
    const requested: TileId[] = [];

    const tileset = new SpatioTemporalTileset({
      minZoom: 14,
      maxZoom: 14, // no parents exist
      enablePrefetch: false,
      maxParentTileBytes: 2_000_000,
      getAvailableTiles: async (_b, z) => (z === 14 ? [primary] : []),
      getTileByteSize,
      getTileData: async (id: TileId) => {
        requested.push(id);
        return fakeTile(id);
      },
    });

    tileset.update({ bounds: BOUNDS, zoom: 14, time: 0, timeWindow: 1000 });
    await new Promise((r) => setTimeout(r, 30));

    expect(requested.map((id) => `${id.z}/${id.x}/${id.y}/${id.t}`)).toContain(
      '14/1/1/0',
    );
    tileset.finalize();
  });
});

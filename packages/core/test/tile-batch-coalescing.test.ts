/**
 * Tests for the batched (range-coalesced) load path in SpatiotemporalTileset.
 *
 * Before this, the live render path drained the priority/prefetch queues one
 * tile at a time through `getTileData` (= one HTTP Range request per tile),
 * even though the archive's `getTiles()` coalescer existed. These tests lock
 * in that, when a `getTileDataBatch` callback is provided, a multi-tile pass
 * is sent as ONE batched call (so adjacent byte ranges can coalesce), and
 * that the per-tile fallback still works when no batch callback is set.
 */

import { describe, it, expect, vi } from 'vitest';
import { SpatiotemporalTileset } from '../src/spatiotemporal-tileset';
import type { TileId, BoundingBox } from '../src/types';
import { BOUNDS, fakeTile } from './helpers/fixtures';

describe('SpatiotemporalTileset batched (coalesced) loads', () => {
  it('routes a multi-tile pass through getTileDataBatch and loads every tile', async () => {
    const ids: TileId[] = [0, 1, 2, 3, 4].map((x) => ({ z: 6, x, y: 0, t: 0 }));
    const availSpy = vi.fn(async (_b: BoundingBox, z: number) =>
      ids.filter((i) => i.z === z),
    );
    const singleSpy = vi.fn(async (id: TileId) => fakeTile(id));
    const batchSpy = vi.fn(async (batch: TileId[]) => batch.map(fakeTile));
    const loaded: TileId[] = [];

    const tileset = new SpatiotemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      getAvailableTiles: availSpy,
      getTileData: singleSpy,
      getTileDataBatch: batchSpy,
      onTileLoad: (t) => loaded.push(t.id),
    });

    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: 1000 });
    await new Promise((r) => setTimeout(r, 20));

    // The batch path handled the multi-tile pass...
    expect(batchSpy).toHaveBeenCalled();
    // ...with more than one tile in a single call (i.e. it coalesced).
    const maxBatch = Math.max(
      ...batchSpy.mock.calls.map((c) => (c[0] as TileId[]).length),
    );
    expect(maxBatch).toBeGreaterThan(1);
    // The per-tile path was not used for this multi-tile pass.
    expect(singleSpy).not.toHaveBeenCalled();
    // Every requested tile was delivered.
    expect(loaded.length).toBe(ids.length);

    tileset.finalize();
  });

  it('sends the whole priority working set in ONE coalesced batch (no ⌈N/maxRequests⌉ split)', async () => {
    // 30 tiles with a deliberately small slot budget (maxRequests: 12). The old
    // code sliced this into ⌈30/12⌉ = 3 serial batches; the P0 fix sends all 30
    // in one globally-coalesced batch so byte-adjacent tiles collapse to a few
    // range requests in a single round-trip.
    const ids: TileId[] = Array.from({ length: 30 }, (_, x) => ({
      z: 6,
      x,
      y: 0,
      t: 0,
    }));
    const availSpy = vi.fn(async (_b: BoundingBox, z: number) =>
      ids.filter((i) => i.z === z),
    );
    const batchSpy = vi.fn(async (batch: TileId[]) => batch.map(fakeTile));

    const tileset = new SpatiotemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      maxRequests: 12,
      getAvailableTiles: availSpy,
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: batchSpy,
    });

    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: 1000 });
    await new Promise((r) => setTimeout(r, 30));

    // The multi-tile priority pass was a SINGLE batch of all 30 tiles, not
    // three 12-tile batches.
    const multiCalls = batchSpy.mock.calls.filter(
      (c) => (c[0] as TileId[]).length > 1,
    );
    expect(multiCalls.length).toBe(1);
    expect((multiCalls[0][0] as TileId[]).length).toBe(30);
    tileset.finalize();
  });

  it('falls back to per-tile getTileData when no batch callback is set', async () => {
    const ids: TileId[] = [0, 1, 2].map((x) => ({ z: 6, x, y: 0, t: 0 }));
    const availSpy = vi.fn(async (_b: BoundingBox, z: number) =>
      ids.filter((i) => i.z === z),
    );
    const singleSpy = vi.fn(async (id: TileId) => fakeTile(id));

    const tileset = new SpatiotemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      getAvailableTiles: availSpy,
      getTileData: singleSpy,
    });

    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: 1000 });
    await new Promise((r) => setTimeout(r, 20));

    expect(singleSpy.mock.calls.length).toBe(ids.length);
    tileset.finalize();
  });
});

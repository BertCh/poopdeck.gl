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
import type { TileId, BoundingBox, Tile } from '../src/types';

const BOUNDS: BoundingBox = { minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 };

function fakeTile(id: TileId): Tile {
  return { id, timeRange: { start: 0, end: 1000 }, layers: [] } as Tile;
}

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

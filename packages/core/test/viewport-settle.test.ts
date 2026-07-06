/**
 * Tileset selection-settle signal (`isLoaded` + `selectionVersion`) — the
 * core half of the deck.gl layer's `onViewportLoad` contract (audit item 7).
 *
 * Semantics mirror upstream `Tileset2D.isLoaded`:
 * - settled = nothing queued for the needed set and no needed tile in
 *   flight; lookahead prefetch never blocks it;
 * - a tile whose fetch FAILED counts as settled (otherwise one permanent
 *   hole would pin the signal false forever);
 * - `selectionVersion` bumps only when the needed SET changes, never on
 *   tile arrival — the once-per-settle dedupe key.
 */

import { describe, it, expect } from 'vitest';
import { SpatiotemporalTileset } from '../src/spatiotemporal-tileset';
import type { TileId, BoundingBox, Tile } from '../src/types';
import { BOUNDS, BUCKET_MS, fakeTile, makeAvailableTiles } from './helpers/fixtures';

const N_BUCKETS = 50;

/** One tile per bucket at (x=0, y=0) whose interval overlaps the range. */
const availableTiles = makeAvailableTiles(N_BUCKETS);

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface GatedBatch {
  ids: TileId[];
  resolve: () => void;
  /** Resolve every member to null — the "fetch failed after retries" shape. */
  fail: () => void;
}

function makeTileset(batches: GatedBatch[]) {
  return new SpatiotemporalTileset({
    minZoom: 0,
    maxZoom: 12,
    enablePrefetch: false,
    refinementStrategy: 'no-overlap',
    temporalBucketMs: BUCKET_MS,
    getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
    getTileData: async (id: TileId) => fakeTile(id),
    getTileDataBatch: (ids, signal) =>
      new Promise<(Tile | null)[]>((resolve, reject) => {
        batches.push({
          ids,
          resolve: () => resolve(ids.map(fakeTile)),
          fail: () => resolve(ids.map(() => null)),
        });
        signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
    onTileError: () => {},
  });
}

describe('SpatiotemporalTileset selection settle', () => {
  it('starts settled at version 0, goes pending per selection, settles on load', async () => {
    const batches: GatedBatch[] = [];
    const tileset = makeTileset(batches);

    // No selection yet: vacuously settled, version 0.
    expect(tileset.isLoaded).toBe(true);
    expect(tileset.selectionVersion).toBe(0);

    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS }, true);
    await settle();

    expect(tileset.selectionVersion).toBe(1);
    expect(tileset.isLoaded).toBe(false); // batch in flight

    batches[0].resolve();
    await settle();
    expect(tileset.isLoaded).toBe(true);

    // Identical viewport/window: the selection fast-path keeps the version.
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS }, true);
    await settle();
    expect(tileset.selectionVersion).toBe(1);
    expect(tileset.isLoaded).toBe(true);

    // The window slides to new buckets: a new version, pending again.
    tileset.update(
      { bounds: BOUNDS, zoom: 6, time: 3 * BUCKET_MS, timeWindow: BUCKET_MS },
      true,
    );
    await settle();
    expect(tileset.selectionVersion).toBe(2);
    expect(tileset.isLoaded).toBe(false);

    for (const b of batches) b.resolve();
    await settle();
    expect(tileset.isLoaded).toBe(true);
  });

  it('a failed tile counts as settled — a permanent hole cannot pin isLoaded false', async () => {
    const batches: GatedBatch[] = [];
    const tileset = makeTileset(batches);

    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS }, true);
    await settle();
    expect(tileset.isLoaded).toBe(false);

    batches[0].fail();
    await settle();
    expect(tileset.isLoaded).toBe(true);
  });
});

/**
 * F9 — a settling request may only release the in-flight slot it still OWNS
 * (docs/roadmap/tile-loading-3d-2026-07.md §5).
 *
 * `activeRequests` is keyed by TILE, while a request closure holds a captured
 * HEADER, and the two diverge whenever a header is dropped mid-flight —
 * `flushPrefetch()` and `evictTiles()` both do that, and so does `clear()`.
 * The next selection pass then creates a FRESH header for the same key and
 * dispatches it, so when the original request finally settles its
 * unconditional `activeRequests.delete(key)` removes the entry belonging to
 * its REPLACEMENT. In-flight accounting under-counts from then on, and on the
 * per-tile dispatch path the phantom free slot lets `processRequestQueue`
 * over-subscribe the connection.
 */

import { describe, it, expect } from 'vitest';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import type { BoundingBox, Tile, TileId } from '../src/types';
import { BUCKET_MS } from './helpers/fixtures';

const BOUNDS: BoundingBox = {
  minLon: -180,
  minLat: -85,
  maxLon: 180,
  maxLat: 85,
};

const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Per-tile dispatch (no batch callback) with an abort delivery that is
 * ASYNCHRONOUS, as a real transport's is: that is what lets the replacement
 * request start before the superseded one's `finally` runs, which is the
 * ordering the bug needs.
 */
function makeTileset() {
  const tileset = new SpatioTemporalTileset({
    minZoom: 6,
    maxZoom: 6,
    enablePrefetch: false,
    refinementStrategy: 'no-overlap',
    temporalBucketMs: BUCKET_MS,
    getAvailableTiles: async (_b, z) => [{ z, x: 0, y: 0, t: 0 }],
    getTileData: (_id: TileId, signal?: AbortSignal) =>
      new Promise<Tile>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          setTimeout(
            () =>
              reject(
                Object.assign(new Error('aborted'), { name: 'AbortError' }),
              ),
            20,
          );
        });
      }),
    onTileError: () => {},
  });
  return tileset;
}

describe('activeRequests release is ownership-checked', () => {
  it('a superseded request does not free its REPLACEMENT’s slot', async () => {
    const tileset = makeTileset();
    const view = { bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS };

    tileset.update(view, true);
    await wait(5);
    expect(tileset.getCacheStats().activeRequests).toBe(1);

    // Tear the registry down under the in-flight request (clear() aborts and
    // empties `activeRequests`), then let the very same tile be needed again.
    tileset.clear();
    tileset.update(view, true);
    await wait(5);
    expect(tileset.getCacheStats().activeRequests).toBe(1);

    // The original request's abort now lands. It must not take the
    // replacement's slot with it.
    await wait(60);
    expect(tileset.getCacheStats().activeRequests).toBe(1);

    tileset.finalize();
  });

  it('still releases the slot when nothing replaced the request', async () => {
    // The mirror hazard: an ownership check that ONLY matched the exact header
    // would strand the key in `activeRequests` forever whenever a header is
    // dropped with no replacement, permanently consuming a dispatch slot.
    const tileset = makeTileset();
    tileset.update(
      { bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS },
      true,
    );
    await wait(5);
    expect(tileset.getCacheStats().activeRequests).toBe(1);

    tileset.clear();
    await wait(60);
    expect(tileset.getCacheStats().activeRequests).toBe(0);

    tileset.finalize();
  });
});

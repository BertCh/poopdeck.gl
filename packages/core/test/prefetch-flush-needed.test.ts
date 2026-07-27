/**
 * F6 — a SPATIAL prefetch flush spares the slice the playhead has already
 * reached (docs/roadmap/tile-loading-3d-2026-07.md §5).
 *
 * A request's tier is stamped once at dispatch and never promoted. So a slice
 * that was lookahead when it left is still labelled `prefetch` after the
 * playhead has walked into it — even though its tiles are exactly what the
 * viewport is drawing right now. `flushPrefetch()` aborted EVERY in-flight
 * prefetch record with no bounds, needed-set or playhead test, on a pan of as
 * little as 1/8 of the viewport, and the priority path then re-requested the
 * same bytes from scratch while the user was still moving.
 *
 * The distinction is between the two reasons the runway goes stale: after a
 * SEEK or a direction flip the playhead really has left, and the total flush
 * is right. After a PAN it has not moved at all.
 *
 * `prefetch-supersede.test.ts` pins the total-flush cases; this file adds the
 * one that must now survive.
 */

import { describe, it, expect } from 'vitest';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import type { BoundingBox, Tile, TileId } from '../src/types';
import {
  BOUNDS,
  BUCKET_MS,
  fakeTile,
  makeAvailableTiles,
} from './helpers/fixtures';

const SHIFTED: BoundingBox = {
  minLon: -90,
  minLat: -85,
  maxLon: 90,
  maxLat: 85,
};

const availableTiles = makeAvailableTiles(200);
const settle = (ms = 30): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

interface GatedBatch {
  ids: TileId[];
  signal: AbortSignal | undefined;
  resolve: () => void;
}

function makeTileset(batches: GatedBatch[]) {
  return new SpatioTemporalTileset({
    minZoom: 0,
    maxZoom: 12,
    enablePrefetch: true,
    refinementStrategy: 'no-overlap',
    temporalBucketMs: BUCKET_MS,
    getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
    getTileData: async (id: TileId) => fakeTile(id),
    getTileDataBatch: (ids: TileId[], signal?: AbortSignal) =>
      new Promise<(Tile | null)[]>((resolve, reject) => {
        batches.push({
          ids,
          signal,
          resolve: () => resolve(ids.map((id) => fakeTile(id))),
        });
        signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
  });
}

describe('spatial flush vs. a slice the playhead has entered', () => {
  it('spares it on a pan, and still kills it on a seek', async () => {
    const batches: GatedBatch[] = [];
    const tileset = makeTileset(batches);

    // Signalled speed 1 sim-ms/real-ms → the seek threshold is
    // max(timeWindow, 1 × 1000 ms) = one bucket, so the single-bucket step
    // below is playback and the jump at the end is unambiguously a seek.
    tileset.setAnimationState(true, 1);
    tileset.update(
      { bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS },
      true,
    );
    await settle();

    // Resolve the priority batch (bucket 0) so the prefetch runway dispatches.
    expect(batches.length).toBeGreaterThanOrEqual(1);
    batches[0].resolve();
    await settle(300);

    const slice = batches
      .slice(1)
      .find((b) => b.ids.some((id) => id.t === BUCKET_MS));
    expect(slice).toBeDefined();
    expect(slice!.signal?.aborted).toBe(false);

    // The playhead advances one bucket: bucket 1 is now inside the window and
    // in the needed set, but the record carrying it is still tagged prefetch.
    tileset.update(
      { bounds: BOUNDS, zoom: 6, time: BUCKET_MS, timeWindow: BUCKET_MS },
      true,
    );
    await settle();
    expect(slice!.signal?.aborted).toBe(false);

    // Pan. The runway ahead is stale, but this slice is not lookahead any
    // more — aborting it throws away bytes the priority path would have to
    // re-request immediately.
    tileset.update(
      { bounds: SHIFTED, zoom: 6, time: BUCKET_MS, timeWindow: BUCKET_MS },
      true,
    );
    await settle();
    expect(slice!.signal?.aborted).toBe(false);

    // A seek is a different question: the playhead really has left, so
    // nothing in flight is worth keeping.
    tileset.update(
      { bounds: SHIFTED, zoom: 6, time: 5_000_000, timeWindow: BUCKET_MS },
      true,
    );
    await settle();
    expect(slice!.signal?.aborted).toBe(true);

    tileset.finalize();
  });

  it('an explicit flushPrefetch() from the governor stays total', async () => {
    const batches: GatedBatch[] = [];
    const tileset = makeTileset(batches);

    tileset.setAnimationState(true, 1);
    tileset.update(
      { bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS },
      true,
    );
    await settle();
    batches[0].resolve();
    await settle(300);

    tileset.update(
      { bounds: BOUNDS, zoom: 6, time: BUCKET_MS, timeWindow: BUCKET_MS },
      true,
    );
    await settle();

    const slice = batches
      .slice(1)
      .find((b) => b.ids.some((id) => id.t === BUCKET_MS));
    expect(slice).toBeDefined();
    expect(slice!.signal?.aborted).toBe(false);

    // The PlaybackGovernor calls this directly on an explicit scrub commit or
    // story beat — it means "everything you planned is wrong", and the public
    // signature must keep meaning that.
    tileset.flushPrefetch();
    await settle();
    expect(slice!.signal?.aborted).toBe(true);

    tileset.finalize();
  });
});

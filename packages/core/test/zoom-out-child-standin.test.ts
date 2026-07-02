/**
 * getVisibleTiles() zoom-out stand-in (MapLibre-inspired, perf research
 * 2026-07): when a zoom-out leaves the new (coarser) primary tile still in
 * flight, an already-resident FINER descendant tile from before the zoom-out
 * is shown as a temporary stand-in instead of a blank cell — pure reuse of
 * tiles already in `this.tiles`, no new network requests. See
 * `collectLoadedDescendants` / `CHILD_LOOKAHEAD_LEVELS` in
 * spatiotemporal-tileset.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { SpatiotemporalTileset } from '../src/spatiotemporal-tileset';
import type { TileId, BoundingBox, Tile } from '../src/types';

const fakeTile = (id: TileId): Tile =>
  ({ id, timeRange: { start: id.t, end: id.t + 1000 }, layers: [] }) as unknown as Tile;

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** Drain enough macrotasks for a multi-zoom-level 'best-available' fetch to settle. */
const settle = async (ticks = 5): Promise<void> => {
  for (let i = 0; i < ticks; i++) await tick();
};

const BOUNDS: BoundingBox = { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 };

/**
 * z8 tile (100, 200) is exactly the grandchild (depth 2) of z6 tile (25, 50):
 * z7 parent = (50, 100), z6 grandparent = (25, 50). Depth 2 is the configured
 * CHILD_LOOKAHEAD_LEVELS boundary.
 */
const FINE: TileId = { z: 8, x: 100, y: 200, t: 0 };
const COARSE: TileId = { z: 6, x: 25, y: 50, t: 0 };
/**
 * Depth-3 descendant of COARSE — deliberately beyond the lookahead bound.
 * Uses a DIFFERENT branch than FINE (parent at z8 is (101,200), not FINE's
 * (100,200)) so the two tiles' ancestor chains never collide.
 */
const TOO_FINE: TileId = { z: 9, x: 202, y: 400, t: 0 };

/**
 * `immediateTile` is the ONLY tile ever offered at its own zoom level (kept
 * per-instance, not shared across tests) so a parent-fallback query issued
 * for an unrelated update (e.g. TOO_FINE's z9 load also queries z8 as a
 * fallback level) can't accidentally resurrect a different test's tile by
 * zoom-level coincidence. `coarseTile` is withheld until `zoomOut()` is
 * called, so the initial load is a single-tile fetch with nothing else in
 * flight to get stuck behind (getTileDataBatch resolves a whole batch
 * together, so a permanently-pending sibling in the SAME batch would
 * otherwise wedge the immediate tile's load too).
 */
function makeGatedTileset(opts: {
  refinementStrategy: 'best-available' | 'no-overlap';
  immediateTile: TileId;
  coarseTile: TileId;
}) {
  const pendingResolvers = new Map<string, () => void>();
  const key = (id: TileId) => `${id.z}/${id.x}/${id.y}/${id.t}`;
  let coarseAvailable = false;

  const getTileData = (id: TileId): Promise<Tile> => {
    const it = opts.immediateTile;
    if (id.z === it.z && id.x === it.x && id.y === it.y && id.t === it.t) {
      return Promise.resolve(fakeTile(id));
    }
    // The coarse primary (and any parent-fallback levels under it) is
    // gated: resolved explicitly by the test via `resolvePending`.
    return new Promise<Tile>((resolve) => {
      pendingResolvers.set(key(id), () => resolve(fakeTile(id)));
    });
  };
  const getTileDataBatch = (ids: TileId[]): Promise<Tile[]> => Promise.all(ids.map(getTileData));

  const getAvailableTiles = vi.fn(async (_b: BoundingBox, z: number): Promise<TileId[]> => {
    if (z === opts.immediateTile.z) return [opts.immediateTile];
    if (z === opts.coarseTile.z) return coarseAvailable ? [opts.coarseTile] : [];
    return [];
  });

  const tileset = new SpatiotemporalTileset({
    minZoom: 0,
    maxZoom: 12,
    enablePrefetch: false,
    refinementStrategy: opts.refinementStrategy,
    temporalBucketMs: 1000,
    getAvailableTiles,
    getTileData,
    getTileDataBatch,
  });

  return {
    tileset,
    resolvePending: (id: TileId) => pendingResolvers.get(key(id))?.(),
    zoomOut: () => {
      coarseAvailable = true;
    },
  };
}

describe('getVisibleTiles: finer-descendant stand-in on zoom-out', () => {
  it('shows an already-loaded finer descendant while the new coarser tile streams in', async () => {
    const { tileset, resolvePending, zoomOut } = makeGatedTileset({
      refinementStrategy: 'best-available',
      immediateTile: FINE,
      coarseTile: COARSE,
    });

    // Load the fine tile at z8 first (loads immediately in this mock).
    tileset.update({ bounds: BOUNDS, zoom: FINE.z, time: 0, timeWindow: 100 });
    await settle();
    expect(tileset.getVisibleTiles().map((t) => t.id)).toEqual([FINE]);

    // Zoom out to z6. The coarse primary tile's fetch is gated (pending), so
    // without the stand-in this would render nothing.
    zoomOut();
    tileset.update({ bounds: BOUNDS, zoom: COARSE.z, time: 0, timeWindow: 100 });
    await settle();

    const visible = tileset.getVisibleTiles();
    expect(visible.map((t) => t.id)).toContainEqual(FINE);

    // Once the coarse tile finishes loading, the stand-in is dropped — only
    // the primary tile is shown (pass 3 skips already-loaded headers).
    resolvePending(COARSE);
    await settle();
    expect(tileset.getVisibleTiles().map((t) => t.id)).toEqual([COARSE]);

    tileset.finalize();
  });

  it('does not search beyond CHILD_LOOKAHEAD_LEVELS (depth-3 descendants are not a stand-in)', async () => {
    const { tileset, zoomOut } = makeGatedTileset({
      refinementStrategy: 'best-available',
      immediateTile: TOO_FINE,
      coarseTile: COARSE,
    });

    // Load a depth-3 descendant (z9) of COARSE (z6) — one level beyond the
    // configured lookahead bound.
    tileset.update({ bounds: BOUNDS, zoom: TOO_FINE.z, time: 0, timeWindow: 100 });
    await settle();
    expect(tileset.getVisibleTiles().map((t) => t.id)).toEqual([TOO_FINE]);

    // Zoom out to z6; the coarse tile stays pending. The depth-3 tile must
    // NOT be surfaced as a stand-in — bounded search, not unbounded.
    zoomOut();
    tileset.update({ bounds: BOUNDS, zoom: COARSE.z, time: 0, timeWindow: 100 });
    await settle();
    expect(tileset.getVisibleTiles()).toEqual([]);

    tileset.finalize();
  });

  it("does not apply under the 'no-overlap' refinement strategy", async () => {
    const { tileset, zoomOut } = makeGatedTileset({
      refinementStrategy: 'no-overlap',
      immediateTile: FINE,
      coarseTile: COARSE,
    });

    tileset.update({ bounds: BOUNDS, zoom: FINE.z, time: 0, timeWindow: 100 });
    await settle();
    expect(tileset.getVisibleTiles().map((t) => t.id)).toEqual([FINE]);

    zoomOut();
    tileset.update({ bounds: BOUNDS, zoom: COARSE.z, time: 0, timeWindow: 100 });
    await settle();
    // 'no-overlap' shows exactly the requested zoom, nothing else, ever.
    expect(tileset.getVisibleTiles()).toEqual([]);

    tileset.finalize();
  });
});

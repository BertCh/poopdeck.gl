/**
 * Unit tests for `lodMode: 'additive'` in `SpatiotemporalTileset` — the
 * additive-octree zoom-LOD path. Two behaviours distinguish it from the default
 * 'parent-fallback' mode:
 *
 *  1. LOADING: additive loads the FULL union of zoom levels [minZoom..cameraZoom],
 *     not just the clamped zoom + a few parents. (Each point lives at exactly one
 *     home zoom, so every level contributes distinct points.)
 *  2. RENDERING: `getVisibleTiles` returns EVERY loaded tile across all levels —
 *     a coarse parent is NOT dropped once its children cover it (the coarse tile
 *     holds the sparse overview points, which exist nowhere else).
 *
 * No real archive: we spy on `getAvailableTiles` to see which zooms are queried,
 * and return minimal tile objects from `getTileData` so tiles "load".
 */

import { describe, it, expect, vi } from 'vitest';
import { SpatiotemporalTileset } from '../src/spatiotemporal-tileset';
import type { TileId, BoundingBox } from '../src/types';
import { BOUNDS, flush as tick } from './helpers/fixtures';

/** A minimal truthy "tile" — getVisibleTiles only needs header.tile non-null. */
const fakeTile = (id: TileId) =>
  ({ id, featureCount: 0, layers: [] }) as unknown;

describe('SpatiotemporalTileset additive LOD — union loading', () => {
  function zoomsQueried(
    lodMode: 'additive' | 'parent-fallback',
    minZoom: number,
    maxZoom: number,
    cameraZoom: number,
  ) {
    const queried = new Set<number>();
    const tileset = new SpatiotemporalTileset({
      minZoom,
      maxZoom,
      lodMode,
      enablePrefetch: false,
      refinementStrategy: 'best-available',
      getAvailableTiles: async (
        _b: BoundingBox,
        z: number,
      ): Promise<TileId[]> => {
        queried.add(z);
        return [{ z, x: 0, y: 0, t: 0 }];
      },
      getTileData: async (id: TileId) => fakeTile(id),
    });
    tileset.update({
      bounds: BOUNDS,
      zoom: cameraZoom,
      time: 0,
      timeWindow: 1000,
    });
    return { tileset, queried };
  }

  it('additive queries EVERY zoom in [minZoom..cameraZoom]', async () => {
    const { tileset, queried } = zoomsQueried('additive', 10, 20, 20);
    await tick();
    // The full union, including the coarsest overview level.
    for (let z = 10; z <= 20; z++) expect(queried.has(z)).toBe(true);
    expect(queried.size).toBe(11);
    tileset.finalize();
  });

  it('parent-fallback caps at the clamped zoom + 4 parents (coarse levels skipped)', async () => {
    const { tileset, queried } = zoomsQueried('parent-fallback', 10, 20, 20);
    await tick();
    // Only z16..z20 — the deep overview levels (z10..z15) are NOT queried.
    expect([...queried].sort((a, b) => a - b)).toEqual([16, 17, 18, 19, 20]);
    expect(queried.has(10)).toBe(false);
    tileset.finalize();
  });

  it('additive clamps the union to the archive minZoom', async () => {
    const { tileset, queried } = zoomsQueried('additive', 14, 19, 19);
    await tick();
    expect([...queried].sort((a, b) => a - b)).toEqual([
      14, 15, 16, 17, 18, 19,
    ]);
    tileset.finalize();
  });
});

describe('SpatiotemporalTileset additive LOD — getVisibleTiles retains parents', () => {
  // A z14 parent (0,0) fully covered by its four z15 children. In parent-fallback
  // the parent is dropped once the children load; in additive it stays (its
  // overview points exist nowhere else).
  function makeCoveredTileset(lodMode: 'additive' | 'parent-fallback') {
    const tileset = new SpatiotemporalTileset({
      minZoom: 14,
      maxZoom: 15,
      lodMode,
      enablePrefetch: false,
      refinementStrategy: 'best-available',
      getAvailableTiles: async (
        _b: BoundingBox,
        z: number,
      ): Promise<TileId[]> => {
        if (z === 15) {
          return [
            { z: 15, x: 0, y: 0, t: 0 },
            { z: 15, x: 1, y: 0, t: 0 },
            { z: 15, x: 0, y: 1, t: 0 },
            { z: 15, x: 1, y: 1, t: 0 },
          ];
        }
        if (z === 14) return [{ z: 14, x: 0, y: 0, t: 0 }];
        return [];
      },
      getTileData: async (id: TileId) => fakeTile(id),
    });
    return tileset;
  }

  async function visibleZooms(lodMode: 'additive' | 'parent-fallback') {
    const tileset = makeCoveredTileset(lodMode);
    tileset.update({ bounds: BOUNDS, zoom: 15, time: 0, timeWindow: 1000 });
    // Drain a few macrotasks so all five tiles finish loading.
    for (let i = 0; i < 5; i++) await tick();
    const zs = tileset.getVisibleTiles().map((t) => (t.id as TileId).z);
    tileset.finalize();
    return zs;
  }

  it('additive keeps the covered z14 parent visible alongside the z15 children', async () => {
    const zs = await visibleZooms('additive');
    expect(zs).toContain(14); // the coarse overview survives
    expect(zs.filter((z) => z === 15).length).toBe(4);
    expect(zs.length).toBe(5);
  });

  it('parent-fallback drops the fully-covered z14 parent', async () => {
    const zs = await visibleZooms('parent-fallback');
    expect(zs).not.toContain(14); // dropped once children cover it
    expect(zs.filter((z) => z === 15).length).toBe(4);
    expect(zs.length).toBe(4);
  });
});

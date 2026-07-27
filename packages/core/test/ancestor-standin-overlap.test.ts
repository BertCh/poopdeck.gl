/**
 * F4's ancestor stand-in must not double-paint over a DESCENDANT stand-in
 * (docs/roadmap/tile-loading-3d-2026-07.md §5 F4; adversarial review 2026-07).
 *
 * `getVisibleTiles` pass 3 fills a needed-but-unloaded primary cell from
 * whatever is already resident: a finer DESCENDANT after a zoom-out, a coarser
 * ANCESTOR after a zoom-in. The ancestor branch has an overlap guard, because
 * one ancestor covers 4^depth primary cells and drawing it over a cell that
 * already has content renders those features twice. But the guard consulted
 * only `primaryCover` (loaded PRIMARY tiles) and `emitted` (the ancestor's own
 * key) — it had no idea that a SIBLING cell in the same block had just been
 * filled by descendants. So a camera that lands between two zooms — some cells
 * still holding their finer children, others holding nothing — drew the coarse
 * ancestor straight over the finer stand-ins. On an opaque layer that is
 * invisible; on the translucent ones (every storm4d volume/isoline layer, the
 * heatmaps, the flow corridors) it reads as a patch of doubled density that
 * disappears the moment the real primary tile lands.
 */

import { describe, it, expect } from 'vitest';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import type { BoundingBox, Tile, TileId } from '../src/types';
import { fakeTile, flush as tick } from './helpers/fixtures';

const settle = async (ticks = 5): Promise<void> => {
  for (let i = 0; i < ticks; i++) await tick();
};

const BOUNDS: BoundingBox = { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 };

/**
 * One z7 tile is the depth-1 ancestor of BOTH z8 cells (100 >> 1 === 101 >> 1
 * === 50), and the resident z9 tile is a child of the FIRST of them — the
 * exact geometry the guard has to reason about: a block where one quadrant is
 * already covered by finer content and the other is genuinely blank.
 */
const ANCESTOR: TileId = { z: 7, x: 50, y: 100, t: 0 };
const COVERED_PRIMARY: TileId = { z: 8, x: 100, y: 200, t: 0 };
const BLANK_PRIMARY: TileId = { z: 8, x: 101, y: 200, t: 0 };
const DESCENDANT: TileId = { z: 9, x: 200, y: 400, t: 0 };

const idOf = (t: Tile): TileId => t.id;

function makeTileset(opts: { residentDescendant: boolean }) {
  const tileset = new SpatioTemporalTileset({
    minZoom: 0,
    maxZoom: 12,
    enablePrefetch: false,
    // The strategy all ten storm4d tilesets run, and the one where pass 3 is
    // the ONLY thing standing between a zoom crossing and a blank frame.
    refinementStrategy: 'no-overlap',
    temporalBucketMs: 1000,
    getAvailableTiles: async (
      _b: BoundingBox,
      z: number,
    ): Promise<TileId[]> => {
      if (z === ANCESTOR.z) return [ANCESTOR];
      if (z === DESCENDANT.z)
        return opts.residentDescendant ? [DESCENDANT] : [];
      if (z === COVERED_PRIMARY.z) return [COVERED_PRIMARY, BLANK_PRIMARY];
      return [];
    },
    // The two z8 primaries never resolve — that is the whole scenario: the
    // camera has arrived at z8 and neither cell has landed yet.
    getTileData: (id: TileId): Promise<Tile> =>
      id.z === COVERED_PRIMARY.z
        ? new Promise<Tile>(() => {})
        : Promise.resolve(fakeTile(id)),
  });
  return tileset;
}

/** Walk the camera z7 → z9 → z8 so both stand-in tiers are resident at z8. */
async function arriveAtPrimaryZoom(
  tileset: SpatioTemporalTileset,
  visitDescendantZoom: boolean,
): Promise<void> {
  tileset.update({
    bounds: BOUNDS,
    zoom: ANCESTOR.z,
    time: 0,
    timeWindow: 100,
  });
  await settle();
  if (visitDescendantZoom) {
    tileset.update({
      bounds: BOUNDS,
      zoom: DESCENDANT.z,
      time: 0,
      timeWindow: 100,
    });
    await settle();
  }
  tileset.update({
    bounds: BOUNDS,
    zoom: COVERED_PRIMARY.z,
    time: 0,
    timeWindow: 100,
  });
  await settle();
}

describe('getVisibleTiles: ancestor stand-in vs. descendant stand-in', () => {
  it('does not draw the ancestor over a sibling cell already filled by descendants', async () => {
    const tileset = makeTileset({ residentDescendant: true });
    await arriveAtPrimaryZoom(tileset, true);

    // The z9 tile stands in for (100, 200). The z7 ancestor spans BOTH z8
    // cells, so emitting it for the blank (101, 200) lays a coarse copy over
    // the z9 content as well — the same double-paint the `primaryCover` half
    // of the guard already refuses for a loaded primary.
    expect(tileset.getVisibleTiles().map(idOf)).toEqual([DESCENDANT]);

    tileset.finalize();
  });

  it('still draws the ancestor when nothing finer covers any cell in its block', async () => {
    const tileset = makeTileset({ residentDescendant: false });
    await arriveAtPrimaryZoom(tileset, false);

    // The positive control for the guard above: with no descendant anywhere
    // under the ancestor, holding it back would just reinstate the blank frame
    // that F4 exists to prevent.
    expect(tileset.getVisibleTiles().map(idOf)).toEqual([ANCESTOR]);

    tileset.finalize();
  });
});

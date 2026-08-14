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
const idOf = (t: Tile): TileId => t.id;

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

/**
 * CO-6 — the ancestor half of pass 3 becomes a bottom-up DP over the resident
 * loaded set, and loses its depth-2 cap in the process
 * (`COVER_DP_ANCESTOR_LEVELS` = `PARENT_FALLBACK_LEVELS` = 4).
 *
 * The cap was never about correctness: it paid for the `O(4^up)` block scan the
 * per-cell walk ran to prove an ancestor's whole block was blank. The DP
 * propagates "this block already has content" UPWARD from the covered cells
 * instead, so that proof is a set lookup and depth costs a shift — which leaves
 * the cap discarding resident tiles for no remaining reason. The fetch ladder
 * already loads four parent levels; below the DP the render side threw the
 * deepest two of them away.
 *
 * `coverSearch: 'capped'` restores the pre-CO-6 walks for one release.
 */
describe('getVisibleTiles: the de-capped ancestor cover DP', () => {
  /** z11 primary and its ancestors; (1024,1022) >> 3 === (128,127). */
  const P11: TileId = { z: 11, x: 1024, y: 1022, t: 0 };
  const A8: TileId = { z: 8, x: 128, y: 127, t: 0 };
  const VIEW: BoundingBox = {
    minLon: 0.1,
    minLat: 0.1,
    maxLon: 0.3,
    maxLat: 0.3,
  };

  /**
   * Bounds-independent directory (the fixtures in this file all are): under
   * `no-overlap` only the primary zoom is ever selected, so which cells the
   * viewport box contains never reaches pass 3 — the DP reads the resident set
   * and nothing else.
   */
  function makeDepthFixture(coverSearch: 'dp' | 'capped') {
    return new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 14,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: 1000,
      coverSearch,
      getAvailableTiles: async (_b: BoundingBox, z: number) => {
        if (z === A8.z) return [A8];
        if (z === P11.z) return [P11];
        return [];
      },
      // The z11 primary never arrives — the whole point is what covers it.
      getTileData: (id: TileId): Promise<Tile> =>
        id.z === P11.z
          ? new Promise<Tile>(() => {})
          : Promise.resolve(fakeTile(id)),
    });
  }

  /** Camera at z8 (ancestor loads), then three notches in to z11. */
  async function zoomInThreeNotches(
    tileset: SpatioTemporalTileset,
    bounds: BoundingBox = VIEW,
  ): Promise<void> {
    tileset.update({ bounds, zoom: A8.z, time: 0, timeWindow: 100 });
    await settle();
    tileset.update({ bounds, zoom: P11.z, time: 0, timeWindow: 100 });
    await settle();
  }

  it('reuses a resident ancestor THREE levels coarser after a multi-notch zoom', async () => {
    const tileset = makeDepthFixture('dp');
    await zoomInThreeNotches(tileset);

    expect(tileset.getVisibleTiles().map(idOf)).toEqual([A8]);

    tileset.finalize();
  });

  it('is exactly what the capped walk discarded', async () => {
    const tileset = makeDepthFixture('capped');
    await zoomInThreeNotches(tileset);

    // The escape hatch reproduces the pre-CO-6 result: the search stops at z9,
    // the resident z8 tile is never consulted, and the frame goes blank.
    expect(tileset.getVisibleTiles()).toEqual([]);

    tileset.finalize();
  });

  it('fails OPEN: a degenerate viewport does not withhold the stand-in', async () => {
    // A zero-width box parked on the antimeridian — the viewport whose tile
    // span comes back EMPTY and switches pass 2's clamp off. Pass 3 must reach
    // the same verdict it would for any other camera: "I could not work out
    // what you can see" is never a reason to withhold a fallback.
    const SEAM: BoundingBox = {
      minLon: 180,
      minLat: 0.1,
      maxLon: 180,
      maxLat: 0.3,
    };
    const tileset = makeDepthFixture('dp');
    await zoomInThreeNotches(tileset, SEAM);

    expect(tileset.getVisibleTiles().map(idOf)).toEqual([A8]);

    tileset.finalize();
  });
});

/**
 * The DP's other correction: an ancestor stand-in may not be laid over a
 * NEARER ancestor stand-in either.
 *
 * The capped walk resolved one cell at a time and recorded nothing when it
 * emitted, so a cell whose only cover was a grandparent could emit it, and a
 * sibling cell processed afterwards could then emit its own resident parent
 * INSIDE that grandparent's block — two covers over the same area, chosen by
 * `neededTileKeys` iteration order. The level-major DP resolves every nearer
 * ancestor before any coarser one and blocks what it has covered, so the finer
 * cover always wins and the coarser one sees a block that is no longer blank.
 * Same class of order-dependence the descendants-before-ancestors split fixed
 * one layer up.
 */
describe('getVisibleTiles: ancestor stand-in vs. nearer ancestor stand-in', () => {
  const GRANDPARENT: TileId = { z: 8, x: 10, y: 20, t: 0 };
  /** Resident parent of CELL_A only; (40,80) >> 1 === (20,40). */
  const PARENT_A: TileId = { z: 9, x: 20, y: 40, t: 0 };
  const CELL_A: TileId = { z: 10, x: 40, y: 80, t: 0 };
  /** Under GRANDPARENT ((42,82) >> 2 === (10,20)) but NOT under PARENT_A. */
  const CELL_B: TileId = { z: 10, x: 42, y: 82, t: 0 };

  function makeNestedFixture(coverSearch: 'dp' | 'capped') {
    return new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 14,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: 1000,
      coverSearch,
      getAvailableTiles: async (_b: BoundingBox, z: number) => {
        if (z === GRANDPARENT.z) return [GRANDPARENT];
        if (z === PARENT_A.z) return [PARENT_A];
        if (z === CELL_A.z) return [CELL_A, CELL_B];
        return [];
      },
      getTileData: (id: TileId): Promise<Tile> =>
        id.z === CELL_A.z
          ? new Promise<Tile>(() => {})
          : Promise.resolve(fakeTile(id)),
    });
  }

  /** z8 → z9 → z10, so both ancestor tiers are resident at the primary zoom. */
  async function walkIn(tileset: SpatioTemporalTileset): Promise<void> {
    for (const zoom of [GRANDPARENT.z, PARENT_A.z, CELL_A.z]) {
      tileset.update({ bounds: BOUNDS, zoom, time: 0, timeWindow: 100 });
      await settle();
    }
  }

  it('does not lay a grandparent over a cell its own parent already covers', async () => {
    const tileset = makeNestedFixture('dp');
    await walkIn(tileset);

    // CELL_A is covered by PARENT_A. CELL_B has no resident parent, and its
    // only candidate — GRANDPARENT — spans PARENT_A's block too, so drawing it
    // would double-paint. CELL_B stays blank; that is the contract.
    expect(tileset.getVisibleTiles().map(idOf)).toEqual([PARENT_A]);

    tileset.finalize();
  });

  it('the capped walk emitted both — the hole the DP closes', async () => {
    const tileset = makeNestedFixture('capped');
    await walkIn(tileset);

    // Documented, not endorsed: `coverSearch: 'capped'` is a one-release escape
    // hatch and this is the behaviour it escapes to. On a translucent layer the
    // overlap reads as a patch of doubled density.
    const ids = tileset.getVisibleTiles().map(idOf);
    expect(ids).toContainEqual(PARENT_A);
    expect(ids).toContainEqual(GRANDPARENT);

    tileset.finalize();
  });
});

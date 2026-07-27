/**
 * `getVisibleTiles` pass 2 — when a coarse parent may stop earning its keep.
 *
 * The child-cell cover scan is clamped to the viewport's primary-zoom tile
 * range so a parent much larger than the frame cannot claim "some child is
 * uncovered" forever (its off-screen children are never selected, so they can
 * never enter the cover set). That clamp is correct, but it had two edges that
 * turn a missing tile into a visible FLASH — the parent painted the frame a
 * moment ago and is then removed from content already on screen:
 *
 * 1. An EMPTY intersection made the inner loops never run, so `needed` stayed
 *    false and the parent was DROPPED. For a fallback tile, "I cannot work out
 *    what you can see" has to mean KEEP.
 * 2. The render-time box is the CURRENT camera's, while the cover set was
 *    built by a selection pass that can be a frame or two behind it. An
 *    off-by-one at the frame edge declared the shrunken child range covered
 *    and dropped a parent still painting the boundary.
 *
 * See docs/roadmap/tile-loading-3d-2026-07.md §3 (S2) and §4.3.
 */

import { describe, it, expect } from 'vitest';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import type { BoundingBox, Tile, TileId } from '../src/types';
import { fakeTile, flush } from './helpers/fixtures';

const settle = async (ticks = 4): Promise<void> => {
  for (let i = 0; i < ticks; i++) await flush();
};

/**
 * z4 row y=7 (lat 1°..10°), columns 10, 11 and 12 (lon 45°..112.5°), all under
 * the single z2 parent (2, 1) — whose own z4 child block is x 8..11 × y 4..7,
 * i.e. it reaches one column PAST the viewport used below.
 */
const PRIMARY_Z = 4;
const P10: TileId = { z: PRIMARY_Z, x: 10, y: 7, t: 0 };
const P11: TileId = { z: PRIMARY_Z, x: 11, y: 7, t: 0 };
const P12: TileId = { z: PRIMARY_Z, x: 12, y: 7, t: 0 };
const PARENT: TileId = { z: 2, x: 2, y: 1, t: 0 };

/** Exactly one z4 column (x = 11) and one z4 row (y = 7). */
const NARROW: BoundingBox = { minLon: 70, minLat: 1, maxLon: 85, maxLat: 10 };

/**
 * `getAvailableTiles` deliberately IGNORES the bounds, which is how a real
 * selection pass behaves relative to the render frame that follows it: the
 * needed set was computed for the camera as it was, and `getVisibleTiles` then
 * runs against wherever the camera is NOW.
 */
function makeTileset(opts: { deliver: TileId[]; bounds?: BoundingBox }) {
  const wanted = new Set(opts.deliver.map((id) => `${id.z}/${id.x}/${id.y}`));
  const tileset = new SpatioTemporalTileset({
    minZoom: 0,
    maxZoom: 8,
    enablePrefetch: false,
    refinementStrategy: 'best-available',
    temporalBucketMs: 1000,
    getAvailableTiles: async (_b, z) => {
      if (z === PRIMARY_Z) return [P10, P11, P12];
      if (z === PARENT.z) return [PARENT];
      return [];
    },
    // Only the nominated tiles ever resolve; the rest stay needed-but-pending.
    getTileData: (id: TileId) =>
      wanted.has(`${id.z}/${id.x}/${id.y}`)
        ? Promise.resolve(fakeTile(id))
        : new Promise<Tile>(() => {}),
  });
  return tileset;
}

const view = (bounds: BoundingBox) => ({
  bounds,
  zoom: PRIMARY_Z,
  time: 0,
  timeWindow: 100,
});

describe('pass 2: one primary tile of slack at the frame edge', () => {
  it('keeps a parent while a NEEDED primary just outside the clamp is still missing', async () => {
    // x = 11 has arrived, so the viewport's own single column is covered. x = 10
    // is in the needed set and has not arrived — the parent is the only thing
    // painting that boundary, and dropping it now is the flash.
    const tileset = makeTileset({ deliver: [P11, PARENT] });
    tileset.update(view(NARROW), true);
    await settle();

    const ids = tileset.getVisibleTiles().map((t) => t.id);
    expect(ids).toContainEqual(P11);
    expect(ids).toContainEqual(PARENT);

    tileset.finalize();
  });

  it('drops the parent once every needed primary has arrived', async () => {
    // The slack must not become a permanent retention: a ring cell that the
    // viewport never asked for is not a reason to keep a full extra copy of
    // the data on screen for the rest of the session.
    const tileset = makeTileset({ deliver: [P10, P11, P12, PARENT] });
    tileset.update(view(NARROW), true);
    await settle();

    const ids = tileset.getVisibleTiles().map((t) => t.id);
    expect(ids).toContainEqual(P11);
    expect(ids).not.toContainEqual(PARENT);

    tileset.finalize();
  });
});

describe('pass 2: an EMPTY viewport intersection skips the clamp', () => {
  it('keeps the parent instead of dropping it', async () => {
    // A zero-width box parked exactly on the antimeridian: `lonToTileX(180)`
    // is 2^z, one past the last column, so the wrap-aware span comes back
    // EMPTY. It is finite and ordered, so it survives normalizeViewportBounds
    // and reaches the render-side clamp intact — which is the point: this is
    // the second line of defence, behind a producer that has already been
    // repaired.
    const SEAM: BoundingBox = {
      minLon: 180,
      minLat: 1,
      maxLon: 180,
      maxLat: 10,
    };
    const tileset = makeTileset({ deliver: [P10, P11, P12, PARENT] });
    tileset.update(view(SEAM), true);
    await settle();

    const ids = tileset.getVisibleTiles().map((t) => t.id);
    // Falling back to the unclamped child scan finds uncovered cells in the
    // parent's block (it spans x 8..11, and only 10 and 11 ever load), so the
    // parent stays. With the clamp applied to an empty intersection the inner
    // loops never ran and it was discarded outright.
    expect(ids).toContainEqual(PARENT);

    tileset.finalize();
  });
});

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

/**
 * The z10/z11 double-draw regression, re-asserted against the CO-6 cover DP.
 *
 * A parent is never "covered" when fewer than 4^d of its children are in view:
 * its off-screen children are never selected, so they can never enter the cover
 * set, and an unclamped scan therefore finds an uncovered child FOREVER. The
 * parent then ships alongside its own fully-loaded children — on a
 * no-thinning archive that is a complete extra copy of the data per parent
 * level, and it is what the `/drive` draw-cost pathology looked like from the
 * renderer's side.
 *
 * The clamp fixed it in pass 2; CO-6 rewrote pass 3 underneath, so the contract
 * is pinned here against the DP as well — including that the DP does not
 * resurrect a parent the clamp just dropped.
 */
describe('the z10/z11 double-draw contract, under the cover DP', () => {
  // z11 box for VIEW: x ∈ {1024, 1025}, y ∈ {1022, 1023} — 4 cells. Each
  // ancestor below covers 4^d of them and has only these 4 in view: the z9
  // parent spans 16, the z8 parent 64, the z7 parent 256.
  const VIEW: BoundingBox = {
    minLon: 0.1,
    minLat: 0.1,
    maxLon: 0.3,
    maxLat: 0.3,
  };
  const CHILDREN: TileId[] = [
    { z: 11, x: 1024, y: 1022, t: 0 },
    { z: 11, x: 1025, y: 1022, t: 0 },
    { z: 11, x: 1024, y: 1023, t: 0 },
    { z: 11, x: 1025, y: 1023, t: 0 },
  ];
  const ANCESTORS: TileId[] = [
    { z: 10, x: 512, y: 511, t: 0 },
    { z: 9, x: 256, y: 255, t: 0 },
    { z: 8, x: 128, y: 127, t: 0 },
    { z: 7, x: 64, y: 63, t: 0 },
  ];

  const makeTileset = (coverSearch: 'dp' | 'capped') =>
    new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 14,
      enablePrefetch: false,
      // 'best-available' is what puts the four parent levels in the needed set
      // in the first place — the strategy the contract is about.
      refinementStrategy: 'best-available',
      temporalBucketMs: 1000,
      coverSearch,
      getAvailableTiles: async (_b, z) => {
        if (z === 11) return CHILDREN;
        const parent = ANCESTORS.find((a) => a.z === z);
        return parent ? [parent] : [];
      },
      // EVERYTHING lands, parents included: the question is what is delivered
      // once the children are all on screen in their own right.
      getTileData: async (id: TileId) => fakeTile(id),
    });

  for (const coverSearch of ['dp', 'capped'] as const) {
    it(`never delivers a parent alongside its own loaded children (${coverSearch})`, async () => {
      const tileset = makeTileset(coverSearch);
      tileset.update(
        { bounds: VIEW, zoom: 11, time: 0, timeWindow: 100 },
        true,
      );
      await settle(6);

      const ids = tileset.getVisibleTiles().map((t) => t.id);
      const keys = ids.map((id) => `${id.z}/${id.x}/${id.y}/${id.t}`).sort();
      expect(keys).toEqual(
        CHILDREN.map((id) => `${id.z}/${id.x}/${id.y}/${id.t}`).sort(),
      );
      for (const a of ANCESTORS) {
        expect(ids).not.toContainEqual(a);
      }

      tileset.finalize();
    });
  }
});

describe('pass 2: an EMPTY viewport intersection skips the clamp', () => {
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

  it('keeps the parent instead of dropping it', async () => {
    // P10 and P12 are withheld: existing primaries the viewport asked for
    // and has not received.
    const tileset = makeTileset({ deliver: [P11, PARENT] });
    tileset.update(view(SEAM), true);
    await settle();

    const ids = tileset.getVisibleTiles().map((t) => t.id);
    // Falling back to the unclamped child scan finds the PENDING cells in the
    // parent's block (x = 10 and 12 exist and are still missing), so the
    // parent stays. With the clamp applied to an empty intersection the inner
    // loops never ran and it was discarded outright. (This used to deliver
    // all three primaries and lean on the block's EMPTY cells x = 8, 9 to
    // keep the parent; since E3 a cell with no tile at all keeps nothing.)
    expect(ids).toContainEqual(PARENT);

    tileset.finalize();
  });

  it('...and still drops it once every EXISTING child has arrived (E3)', async () => {
    const tileset = makeTileset({ deliver: [P10, P11, P12, PARENT] });
    tileset.update(view(SEAM), true);
    await settle();

    const ids = tileset.getVisibleTiles().map((t) => t.id);
    // The block's empty cells (x = 8, 9) are empty in the parent too: with
    // all three existing children on screen the parent would only draw them
    // a second time. Fail-open covers "I cannot tell what you see", not
    // "draw everything twice to be safe".
    expect(ids).not.toContainEqual(PARENT);

    tileset.finalize();
  });
});

/**
 * The same clamp, judged against a MIXED-ZOOM cut (FS-2/FS-3).
 *
 * Pass 2 asks one question of every needed tile shallower than the deepest
 * needed zoom: "is some child cell of yours, at that deepest zoom, inside the
 * viewport box and still uncovered?". That question has a correct answer for a
 * genuine fallback parent and NO correct answer for a frustum-cut member,
 * because a cut member is not a fallback — it is the intended cover for its own
 * patch of ground, at its own zoom. The far field is covered at z6 and simply
 * has no z8 cells to be "covered by".
 *
 * The three cases below pin what that costs today, minimally and without a
 * camera: one where the clamp happens to give the right answer, and two where
 * it gives the wrong one in each direction. Coordinates are chosen so the
 * arithmetic is checkable by hand — see each case.
 */
describe('pass 2 under a frustum cut: the cut member is not a parent', () => {
  // z8 near-field pair, and one z6 far-field cell that is NOT their ancestor
  // (177 >> 2 = 44, and the far cell is x = 47), so the cut is a real antichain.
  const NEAR_A: TileId = { z: 8, x: 177, y: 124, t: 0 };
  const NEAR_B: TileId = { z: 8, x: 178, y: 124, t: 0 };
  const FAR: TileId = { z: 6, x: 47, y: 31, t: 0 };
  const CUT: TileId[] = [NEAR_A, NEAR_B, FAR];

  /** Wide enough to contain the far cell's block: z8 columns 176…192. */
  const WIDE: BoundingBox = { minLon: 68, minLat: 0, maxLon: 91, maxLat: 6 };
  /** The near field only: z8 columns 176…178. The far cell's block (188…191)
   *  falls outside it, slack ring included. */
  const NARROW_TO_NEAR: BoundingBox = {
    minLon: 68,
    minLat: 0,
    maxLon: 71,
    maxLat: 6,
  };

  function cutTileset(opts: {
    strategy: 'best-available' | 'no-overlap';
    deliver?: TileId[];
  }) {
    const wanted = opts.deliver
      ? new Set(opts.deliver.map((id) => `${id.z}/${id.x}/${id.y}`))
      : null;
    return new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 8,
      enablePrefetch: false,
      refinementStrategy: opts.strategy,
      temporalBucketMs: 1000,
      getAvailableTiles: async () => [],
      // Every addressed cell exists — the no-thinning default.
      getAvailableTilesForCells: async (cells) =>
        cells.map((c) => ({ z: c.z, x: c.x, y: c.y, t: 0 })),
      getTileData: (id: TileId) =>
        !wanted || wanted.has(`${id.z}/${id.x}/${id.y}`)
          ? Promise.resolve(fakeTile(id))
          : new Promise<Tile>(() => {}),
    });
  }

  const cutView = (bounds: BoundingBox) => ({
    bounds,
    zoom: 8,
    time: 0,
    timeWindow: 100,
    tileCells: CUT,
  });

  it('keeps the coarse cut member when its block is inside the box', () => {
    // The far cut member is delivered because it IS the cover for its patch
    // of ground, not because its z8 child block (x 188…191, y 124…127)
    // happens to land inside the box: pass 2 never judges a cut member as a
    // placeholder. (Before E3 it survived by coincidence of geometry — the
    // any-in-box-cell rule found its block's empty z8 cells "uncovered".)
    return (async () => {
      const tileset = cutTileset({ strategy: 'no-overlap' });
      tileset.update(cutView(WIDE), true);
      await settle(8);

      const ids = tileset.getVisibleTiles().map((t) => t.id);
      expect(ids).toContainEqual(NEAR_A);
      expect(ids).toContainEqual(NEAR_B);
      expect(ids).toContainEqual(FAR);

      tileset.finalize();
    })();
  });

  it('delivers a coarse cut member whose block is OUTSIDE the box (FS-3, under-delivery half)', async () => {
    // Narrow the box to the near field and the far cut member's block no
    // longer intersects it — even with the one-tile slack ring (z8 columns
    // 175…179 against the block's 188…191). Under the old cell scan the inner
    // loops never executed, `needed` stayed false, and a cell the CUT says
    // the camera is looking at was discarded while loaded and resident. A
    // cut member is now delivered on its own account, whatever the box says.
    //
    // `no-overlap` so no stand-in band can mask it.
    const tileset = cutTileset({ strategy: 'no-overlap' });
    tileset.update(cutView(NARROW_TO_NEAR), true);
    await settle(8);

    const ids = tileset.getVisibleTiles().map((t) => t.id);
    tileset.finalize();
    expect(ids).toContainEqual(FAR);
  });

  it('a PENDING coarse cut member keeps its OWN ancestor stand-in (per node, not per cell)', async () => {
    // The far member is withheld; its z5 ancestor (47 >> 1, 31 >> 1) is in
    // the `best-available` stand-in band and lands. No z8 cell of that
    // ancestor's block is pending — the cut never asked for z8 there — so the
    // per-CELL test alone would drop it (E3) and blank the far field while
    // the z6 member streams. The per-NODE test keeps it: a stand-in stays
    // while any cut member it covers, at whatever zoom, is still pending.
    const FAR_ANCESTOR: TileId = { z: 5, x: 23, y: 15, t: 0 };
    const tileset = cutTileset({
      strategy: 'best-available',
      deliver: [NEAR_A, NEAR_B, FAR_ANCESTOR],
    });
    tileset.update(cutView(WIDE), true);
    await settle(8);

    const delivered = tileset.getVisibleTiles().map((t) => t.id);
    expect(delivered).toContainEqual(NEAR_A);
    expect(delivered).toContainEqual(NEAR_B);
    expect(delivered).toContainEqual(FAR_ANCESTOR);
    expect(delivered).not.toContainEqual(FAR);

    tileset.finalize();
  });

  it('no stand-in ancestor ships alongside a loaded cut member (FS-3, over-delivery half)', async () => {
    // The z10/z11 double-draw in its mixed-zoom form. `best-available` adds a
    // per-branch ancestor band (`cutAncestors`), and the z7 ancestor of
    // NEAR_A covers z8 cells 176…177 × 124…125, of which only (177, 124) is
    // in the cut. The other three are never asked for — so under the old
    // any-in-box-cell rule the ancestor passed "some child uncovered"
    // forever and drew straight over its own loaded child. Since E3 a cell
    // keeps a parent only while a tile EXISTS there and is pending (and, on
    // the cut path, a stand-in only while a cut member it covers is pending).
    const tileset = cutTileset({ strategy: 'best-available' });
    tileset.update(cutView(WIDE), true);
    await settle(10);

    const ids = tileset.getVisibleTiles().map((t) => t.id);
    tileset.finalize();
    const keys = new Set(ids.map((id) => `${id.z}/${id.x}/${id.y}/${id.t}`));
    const nested = ids.filter((id) => {
      for (let z = id.z - 1; z >= 0; z--) {
        const up = id.z - z;
        if (keys.has(`${z}/${id.x >> up}/${id.y >> up}/${id.t}`)) return true;
      }
      return false;
    });
    expect(nested).toEqual([]);
  });

  it('slack ring: a coarse cut member is kept while a NEEDED deeper cell is pending', async () => {
    // The slack-ring semantics of the existing clamp, re-stated per cut node.
    // NEAR_B is withheld, so it stays in the needed set unloaded and lands in
    // `primaryPending`; the far cut member's block does not contain it, but the
    // near-field ancestors do — and the ring is what stops them being dropped a
    // frame early while the boundary is still streaming.
    const tileset = cutTileset({
      strategy: 'best-available',
      deliver: [NEAR_A, FAR],
    });
    tileset.update(cutView(WIDE), true);
    await settle(8);

    const ids = tileset.getVisibleTiles().map((t) => t.id);
    expect(ids).toContainEqual(NEAR_A);
    expect(ids).toContainEqual(FAR);
    expect(ids).not.toContainEqual(NEAR_B);

    tileset.finalize();
  });
});

/**
 * E3 (tile-loading audit 2026-08, SEL-2): pass 2 counted ANY uncovered in-box
 * cell as a reason to keep a parent — including a cell the archive has no tile
 * for at all. On a replicated (full-duplication) archive an empty primary
 * cell means the parent has nothing there either, so the parent covered
 * nothing and was drawn ON TOP of its loaded siblings' children for as long
 * as the camera stood still: water at the coasts, Alpine cells at night,
 * sparse event sets. The flow-riders campaign worked around the symptom in
 * demo config (`no-overlap` on overlays); this pins the core rule: an in-box
 * cell keeps a parent only while the directory says a tile exists there and
 * it has not arrived. Archives that omit deep-zoom tiles in sparse regions
 * (`stt-build --min-features-per-tile > 1`) declare `sparsePrimary: true` and
 * keep the any-cell rule.
 */
describe('E3: an in-box cell with NO archive tile does not keep a parent', () => {
  // z11 box: x ∈ {1024, 1025}, y ∈ {1022, 1023}. The archive has THREE of the
  // four z11 children (the fourth cell is empty — say, water) and the z10
  // parent above them.
  const VIEW: BoundingBox = {
    minLon: 0.1,
    minLat: 0.1,
    maxLon: 0.3,
    maxLat: 0.3,
  };
  const CHILDREN: TileId[] = [
    { z: 11, x: 1024, y: 1022, t: 0 },
    { z: 11, x: 1025, y: 1022, t: 0 },
    { z: 11, x: 1024, y: 1023, t: 0 },
  ];
  const PARENT: TileId = { z: 10, x: 512, y: 511, t: 0 };
  const key = (id: TileId): string => `${id.z}/${id.x}/${id.y}/${id.t}`;

  function makeTileset(opts: { deliver?: TileId[]; sparsePrimary?: boolean }) {
    const wanted = opts.deliver
      ? new Set(opts.deliver.map((id) => `${id.z}/${id.x}/${id.y}`))
      : null;
    return new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 14,
      enablePrefetch: false,
      refinementStrategy: 'best-available',
      temporalBucketMs: 1000,
      sparsePrimary: opts.sparsePrimary,
      getAvailableTiles: async (_b, z) =>
        z === 11 ? CHILDREN : z === 10 ? [PARENT] : [],
      getTileData: (id: TileId) =>
        !wanted || wanted.has(`${id.z}/${id.x}/${id.y}`)
          ? Promise.resolve(fakeTile(id))
          : new Promise<Tile>(() => {}),
    });
  }

  it('drops the parent once the three children that EXIST are loaded (3-of-4)', async () => {
    const tileset = makeTileset({});
    tileset.update({ bounds: VIEW, zoom: 11, time: 0, timeWindow: 100 }, true);
    await settle(8);

    const keys = tileset
      .getVisibleTiles()
      .map((t) => key(t.id))
      .sort();
    // Exactly the three children — the parent no longer double-draws them.
    expect(keys).toEqual(CHILDREN.map(key).sort());

    tileset.finalize();
  });

  it('keeps the parent while one EXISTING child is still pending', async () => {
    const tileset = makeTileset({
      deliver: [CHILDREN[0], CHILDREN[1], PARENT],
    });
    tileset.update({ bounds: VIEW, zoom: 11, time: 0, timeWindow: 100 }, true);
    await settle(8);

    const keys = tileset.getVisibleTiles().map((t) => key(t.id));
    expect(keys).toContain(key(PARENT));
    expect(keys).toContain(key(CHILDREN[0]));
    expect(keys).not.toContain(key(CHILDREN[2]));

    tileset.finalize();
  });

  it('sparsePrimary: true preserves the any-in-box-cell rule (the parent is the only holder)', async () => {
    const tileset = makeTileset({ sparsePrimary: true });
    tileset.update({ bounds: VIEW, zoom: 11, time: 0, timeWindow: 100 }, true);
    await settle(8);

    const keys = tileset.getVisibleTiles().map((t) => key(t.id));
    expect(keys).toContain(key(PARENT));
    for (const c of CHILDREN) expect(keys).toContain(key(c));

    tileset.finalize();
  });
});

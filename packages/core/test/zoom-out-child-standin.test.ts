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
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import type { TileId, BoundingBox, Tile } from '../src/types';
import { fakeTile, flush as tick } from './helpers/fixtures';

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
  const getTileDataBatch = (ids: TileId[]): Promise<Tile[]> =>
    Promise.all(ids.map(getTileData));

  const getAvailableTiles = vi.fn(
    async (_b: BoundingBox, z: number): Promise<TileId[]> => {
      if (z === opts.immediateTile.z) return [opts.immediateTile];
      if (z === opts.coarseTile.z)
        return coarseAvailable ? [opts.coarseTile] : [];
      return [];
    },
  );

  const tileset = new SpatioTemporalTileset({
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
    tileset.update({
      bounds: BOUNDS,
      zoom: COARSE.z,
      time: 0,
      timeWindow: 100,
    });
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

  // The zoom-OUT half of the CO-6 cover band stays at 2 levels, deliberately:
  // see COVER_DP_DESCENDANT_LEVELS. Reaching one level further UP costs one
  // extra tile in the delivered list, but one level further DOWN multiplies the
  // delivered descendants per blank cell by four (a depth-3 stand-in can hand
  // the renderer 64 tiles for a single cell), so the search-cost argument the DP
  // dissolves is replaced by a delivery-cost argument that it does not. This
  // pin is therefore still live under the DP, not a legacy of the old cap.
  it('does not search beyond CHILD_LOOKAHEAD_LEVELS (depth-3 descendants are not a stand-in)', async () => {
    const { tileset, zoomOut } = makeGatedTileset({
      refinementStrategy: 'best-available',
      immediateTile: TOO_FINE,
      coarseTile: COARSE,
    });

    // Load a depth-3 descendant (z9) of COARSE (z6) — one level beyond the
    // configured lookahead bound.
    tileset.update({
      bounds: BOUNDS,
      zoom: TOO_FINE.z,
      time: 0,
      timeWindow: 100,
    });
    await settle();
    expect(tileset.getVisibleTiles().map((t) => t.id)).toEqual([TOO_FINE]);

    // Zoom out to z6; the coarse tile stays pending. The depth-3 tile must
    // NOT be surfaced as a stand-in — bounded search, not unbounded.
    zoomOut();
    tileset.update({
      bounds: BOUNDS,
      zoom: COARSE.z,
      time: 0,
      timeWindow: 100,
    });
    await settle();
    expect(tileset.getVisibleTiles()).toEqual([]);

    tileset.finalize();
  });

  it("applies under 'no-overlap' too — it cannot overlap anything", async () => {
    // This assertion is INVERTED from what it pinned before 2026-07-26
    // (docs/roadmap/tile-loading-3d-2026-07.md F4). The stand-in was gated off
    // for 'no-overlap' on the reading that the strategy means "show exactly
    // the requested zoom", but what 'no-overlap' exists to prevent is a parent
    // and its children being DRAWN ON TOP OF EACH OTHER — and a descendant of
    // a cell that has no tile of its own overlaps nothing. All ten storm4d
    // tilesets run 'no-overlap', so with the gate in place one scroll notch
    // across an integer zoom blanked every layer at once.
    const { tileset, resolvePending, zoomOut } = makeGatedTileset({
      refinementStrategy: 'no-overlap',
      immediateTile: FINE,
      coarseTile: COARSE,
    });

    tileset.update({ bounds: BOUNDS, zoom: FINE.z, time: 0, timeWindow: 100 });
    await settle();
    expect(tileset.getVisibleTiles().map((t) => t.id)).toEqual([FINE]);

    zoomOut();
    tileset.update({
      bounds: BOUNDS,
      zoom: COARSE.z,
      time: 0,
      timeWindow: 100,
    });
    await settle();
    expect(tileset.getVisibleTiles().map((t) => t.id)).toEqual([FINE]);

    // And it is strictly a stand-in: the moment the requested zoom arrives,
    // 'no-overlap' is back to exactly one tile.
    resolvePending(COARSE);
    await settle();
    expect(tileset.getVisibleTiles().map((t) => t.id)).toEqual([COARSE]);

    tileset.finalize();
  });
});

/**
 * The zoom-IN mirror: a resident ANCESTOR stands in for a needed primary cell
 * that has not arrived. Same "pure reuse of what is already resident" contract
 * as the descendant pass, with one extra rule — an ancestor covers 4^depth
 * primary cells, so it may only draw when NONE of them is already loaded.
 */
describe('getVisibleTiles: resident-ancestor stand-in on zoom-in', () => {
  /**
   * z6 (25, 50) is the depth-2 ancestor of both z8 (100, 200) and z8
   * (101, 200) — two siblings under one coarse tile, which is what the
   * overlap guard needs to be exercised.
   */
  const SIBLING: TileId = { z: 8, x: 101, y: 200, t: 0 };

  function makeZoomInTileset(opts: { fineTiles: TileId[] }) {
    const pending = new Map<string, () => void>();
    const k = (id: TileId) => `${id.z}/${id.x}/${id.y}/${id.t}`;
    let fineAvailable = false;
    const resolveNow = new Set<string>();

    const getTileData = (id: TileId): Promise<Tile> => {
      if (id.z === COARSE.z || resolveNow.has(k(id))) {
        return Promise.resolve(fakeTile(id));
      }
      return new Promise<Tile>((resolve) => {
        pending.set(k(id), () => resolve(fakeTile(id)));
      });
    };

    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: 1000,
      getAvailableTiles: async (_b: BoundingBox, z: number) => {
        if (z === COARSE.z) return [COARSE];
        if (z === 8) return fineAvailable ? opts.fineTiles : [];
        return [];
      },
      // Deliberately NO getTileDataBatch: `Promise.all` over a gated sibling
      // would wedge the tile that is supposed to land, and this fixture's
      // whole point is one z8 cell arriving while the other does not.
      getTileData,
    });

    return {
      tileset,
      zoomIn: () => {
        fineAvailable = true;
      },
      /** Let this fine tile resolve immediately when it is next requested. */
      unblock: (id: TileId) => resolveNow.add(k(id)),
    };
  }

  it('shows the resident coarse tile while the finer primary streams in', async () => {
    const { tileset, zoomIn } = makeZoomInTileset({ fineTiles: [FINE] });

    tileset.update({
      bounds: BOUNDS,
      zoom: COARSE.z,
      time: 0,
      timeWindow: 100,
    });
    await settle();
    expect(tileset.getVisibleTiles().map((t) => t.id)).toEqual([COARSE]);

    // One scroll notch in. The z8 primary is gated, and under 'no-overlap' the
    // needed set holds nothing else — without the ancestor pass the frame goes
    // completely blank.
    zoomIn();
    tileset.update({ bounds: BOUNDS, zoom: FINE.z, time: 0, timeWindow: 100 });
    await settle();
    expect(tileset.getVisibleTiles().map((t) => t.id)).toEqual([COARSE]);

    tileset.finalize();
  });

  it('refuses to draw an ancestor over a primary cell that has already loaded', async () => {
    const { tileset, zoomIn, unblock } = makeZoomInTileset({
      fineTiles: [FINE, SIBLING],
    });
    unblock(SIBLING); // one of the two z8 cells lands, the other does not

    tileset.update({
      bounds: BOUNDS,
      zoom: COARSE.z,
      time: 0,
      timeWindow: 100,
    });
    await settle();

    zoomIn();
    tileset.update({ bounds: BOUNDS, zoom: FINE.z, time: 0, timeWindow: 100 });
    await settle();

    // COARSE covers both z8 cells, and one of them is on screen in its own
    // right — drawing the coarse copy on top would render those features
    // twice, which is exactly what 'no-overlap' is configured to avoid.
    expect(tileset.getVisibleTiles().map((t) => t.id)).toEqual([SIBLING]);

    tileset.finalize();
  });
});

/**
 * CO-6 property + determinism: whatever the resident set, the cover the DP
 * delivers is an ANTICHAIN over the quadtree, and it covers at least as much of
 * the frame as the capped greedy does on the same set.
 *
 * The register pins the fallback cover greedy GIVEN ITS CAPS — i.e. optimality
 * within its family — and the M5 mechanism entry sanctions dropping the caps.
 * What has to survive is therefore the greedy's CONTRACTS, and "at most one
 * cover per visible cell" is the load-bearing one: two covers over the same
 * area is a double-draw, invisible on an opaque layer and a patch of doubled
 * density on every translucent one. These cases assert the contract holds and
 * the coverage is not worse, across pseudo-random resident sets.
 */
describe('getVisibleTiles: cover DP properties over random resident sets', () => {
  const PRIMARY_Z = 10;
  /** The 4×4 block of primary cells the viewport needs; none ever loads. */
  const PRIMARY_CELLS: TileId[] = [];
  for (let y = 512; y < 516; y++) {
    for (let x = 512; x < 516; x++) {
      PRIMARY_CELLS.push({ z: PRIMARY_Z, x, y, t: 0 });
    }
  }

  /** Deterministic PRNG (mulberry32) — no wall clock, no Math.random. */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Two residency regimes, because the de-capping only has room to help in one
   * of them and the contract has to hold in both:
   *
   * - `'zoom-in'` — the multi-notch gesture the cap was costing us. The camera
   *   was parked out at z6/z7, so nothing FINER than the primary exists and the
   *   two levels the old cap could reach are usually absent.
   * - `'mixed'` — a camera sitting between zooms with resident tiles scattered
   *   on both sides. Deep ancestors mostly cannot draw here whatever the cap
   *   says (an ancestor spanning the whole needed block is blocked the moment
   *   any one cell has a descendant cover), which is exactly why the antichain
   *   assertion, not the coverage one, is what earns its keep in this regime.
   */
  type Regime = 'zoom-in' | 'mixed';

  function residentSet(seed: number, regime: Regime): Map<number, TileId[]> {
    const next = rng(seed);
    const byZoom = new Map<number, TileId[]>();
    const keep = (z: number, id: TileId, p: number): void => {
      if (next() >= p) return;
      const list = byZoom.get(z);
      if (list) list.push(id);
      else byZoom.set(z, [id]);
    };
    const seenAncestor = new Set<string>();
    for (const cell of PRIMARY_CELLS) {
      for (let up = 1; up <= 4; up++) {
        const z = PRIMARY_Z - up;
        const id = { z, x: cell.x >> up, y: cell.y >> up, t: 0 };
        const k = `${z}/${id.x}/${id.y}`;
        if (seenAncestor.has(k)) continue;
        seenAncestor.add(k);
        keep(z, id, regime === 'zoom-in' ? (up <= 2 ? 0.15 : 0.7) : 0.5);
      }
      if (regime === 'zoom-in') continue; // camera came from OUT: nothing finer
      for (let down = 1; down <= 2; down++) {
        const z = PRIMARY_Z + down;
        const span = 1 << down;
        for (let dy = 0; dy < span; dy++) {
          for (let dx = 0; dx < span; dx++) {
            keep(
              z,
              { z, x: (cell.x << down) + dx, y: (cell.y << down) + dy, t: 0 },
              down === 1 ? 0.2 : 0.05,
            );
          }
        }
      }
    }
    return byZoom;
  }

  /** Walk the camera through every candidate zoom, then settle at PRIMARY_Z. */
  async function deliver(
    seed: number,
    coverSearch: 'dp' | 'capped',
    regime: Regime = 'mixed',
  ): Promise<TileId[]> {
    const byZoom = residentSet(seed, regime);
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 14,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: 1000,
      coverSearch,
      getAvailableTiles: async (_b: BoundingBox, z: number) =>
        z === PRIMARY_Z ? PRIMARY_CELLS : (byZoom.get(z) ?? []),
      // Only the primary zoom is withheld: everything the camera passed through
      // on the way is resident by the time it arrives.
      getTileData: (id: TileId): Promise<Tile> =>
        id.z === PRIMARY_Z
          ? new Promise<Tile>(() => {})
          : Promise.resolve(fakeTile(id)),
    });
    for (const z of [12, 11, 9, 8, 7, 6]) {
      tileset.update({ bounds: BOUNDS, zoom: z, time: 0, timeWindow: 100 });
      await settle(3);
    }
    tileset.update({
      bounds: BOUNDS,
      zoom: PRIMARY_Z,
      time: 0,
      timeWindow: 100,
    });
    await settle(3);
    const ids = tileset.getVisibleTiles().map((t) => t.id);
    tileset.finalize();
    return ids;
  }

  /** Is `a` the same node as, or an ancestor of, `b`? */
  function nested(a: TileId, b: TileId): boolean {
    if (a.t !== b.t) return false;
    const [hi, lo] = a.z <= b.z ? [a, b] : [b, a];
    const d = lo.z - hi.z;
    return lo.x >> d === hi.x && lo.y >> d === hi.y;
  }

  /** Primary cells covered by the delivered set. */
  function coveredCells(ids: TileId[]): Set<string> {
    const out = new Set<string>();
    for (const id of ids) {
      if (id.z >= PRIMARY_Z) {
        const d = id.z - PRIMARY_Z;
        out.add(`${id.x >> d}/${id.y >> d}`);
        continue;
      }
      const d = PRIMARY_Z - id.z;
      const span = 1 << d;
      for (let dy = 0; dy < span; dy++) {
        for (let dx = 0; dx < span; dx++) {
          out.add(`${(id.x << d) + dx}/${(id.y << d) + dy}`);
        }
      }
    }
    return out;
  }

  const needed = new Set(PRIMARY_CELLS.map((c) => `${c.x}/${c.y}`));

  const coveredNeeded = (ids: TileId[]): number => {
    let n = 0;
    for (const cell of coveredCells(ids)) if (needed.has(cell)) n++;
    return n;
  };

  /** Delivered pairs where one tile is nested inside the other — double-draws. */
  const antichainViolations = (ids: TileId[]): number => {
    let n = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (nested(ids[i], ids[j])) n++;
      }
    }
    return n;
  };

  it('delivers an antichain and covers no less than the capped greedy', async () => {
    for (const regime of ['zoom-in', 'mixed'] as const) {
      for (let seed = 1; seed <= 8; seed++) {
        const dp = await deliver(seed, 'dp', regime);
        const capped = await deliver(seed, 'capped', regime);

        // THE contract: no visible cell reaches the renderer with two covers.
        expect(antichainViolations(dp)).toBe(0);

        // COVERAGE, compared only where the comparison means anything. The
        // capped walk can "cover more" by shipping a grandparent ON TOP OF a
        // nearer parent (see the next case), and a cell counted twice is not a
        // cell covered better — so the raw totals are only commensurable on the
        // sets where the baseline is itself a legal antichain. There, the DP is
        // never worse.
        if (antichainViolations(capped) === 0) {
          expect(coveredNeeded(dp)).toBeGreaterThanOrEqual(
            coveredNeeded(capped),
          );
        }
      }
    }
  });

  it("closes the capped walk's cross-ancestor double-draw", async () => {
    // The capped baseline does NOT always satisfy the contract it is measured
    // against: resolving one cell at a time and recording nothing on emit lets
    // a grandparent and a nearer parent both ship. That is the hole the DP was
    // restructured to close, and this is the sample of random sets that shows
    // it is reachable rather than theoretical.
    let cappedViolations = 0;
    let dpViolations = 0;
    for (const regime of ['zoom-in', 'mixed'] as const) {
      for (let seed = 1; seed <= 8; seed++) {
        cappedViolations += antichainViolations(
          await deliver(seed, 'capped', regime),
        );
        dpViolations += antichainViolations(await deliver(seed, 'dp', regime));
      }
    }
    expect(cappedViolations).toBeGreaterThan(0);
    expect(dpViolations).toBe(0);
  });

  it('covers STRICTLY more after a multi-notch zoom', async () => {
    // The non-vacuity check for the assertion above: in the regime the
    // de-capping exists for, some resident sets must actually gain — and they
    // gain a LOT, because the capped walk's alternative is a blank frame (its
    // reach stops two levels short of the only resident cover there is).
    let gains = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const cappedIds = await deliver(seed, 'capped', 'zoom-in');
      if (antichainViolations(cappedIds) > 0) continue; // not comparable
      const dp = coveredNeeded(await deliver(seed, 'dp', 'zoom-in'));
      if (dp > coveredNeeded(cappedIds)) gains++;
    }
    expect(gains).toBeGreaterThan(0);
  });

  it('delivers the identical list for the identical resident set', async () => {
    for (const seed of [3, 7]) {
      for (const regime of ['zoom-in', 'mixed'] as const) {
        const first = await deliver(seed, 'dp', regime);
        const second = await deliver(seed, 'dp', regime);
        // Same order, not just the same membership: the delivered array is the
        // renderer's draw order, and a reshuffle is a re-upload.
        expect(second).toEqual(first);
      }
    }
  });

  it('is stable across repeated calls on one tileset', async () => {
    const byZoom = residentSet(5, 'mixed');
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 14,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: 1000,
      getAvailableTiles: async (_b: BoundingBox, z: number) =>
        z === PRIMARY_Z ? PRIMARY_CELLS : (byZoom.get(z) ?? []),
      getTileData: (id: TileId): Promise<Tile> =>
        id.z === PRIMARY_Z
          ? new Promise<Tile>(() => {})
          : Promise.resolve(fakeTile(id)),
    });
    for (const z of [12, 11, 9, 8, 7, 6, PRIMARY_Z]) {
      tileset.update({ bounds: BOUNDS, zoom: z, time: 0, timeWindow: 100 });
      await settle(3);
    }

    const first = tileset.getVisibleTiles().map((t) => t.id);
    expect(tileset.getVisibleTiles().map((t) => t.id)).toEqual(first);
    expect(tileset.getVisibleTiles().map((t) => t.id)).toEqual(first);

    tileset.finalize();
  });
});

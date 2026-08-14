/**
 * Selection-path hardening (audit 2026-06):
 *
 * 1. Coverage-index spatial debounce — the buffered-runway coverage index is
 *    rebuilt only when the viewport moves past ~SPATIAL_FLUSH_TOLERANCE of its
 *    own extent (or the zoom changes), NOT on every sub-tile camera drift. The
 *    rebuild is the heaviest directory query in the system (the whole dataset
 *    time range for the viewport), so a smoothly drifting camera must not
 *    re-run it ~10×/s.
 *
 * 2. selectAndLoadTiles generation guard — the pass is async (the directory
 *    slice can be a real network round-trip for paged archives), so a stale
 *    (slower) viewport's result must not clobber a newer pass's needed set
 *    when it resolves out of order.
 *
 * 3. Selection failure surfacing (format review 2026-07) — a rejecting
 *    directory query must not die as an unhandled rejection with the
 *    fast-path key stamped (which blocked all retries for that viewport);
 *    it surfaces via onTileError and the next update() retries.
 *
 * 4. Prefetch stale-plan guard — a prefetch pass superseded by
 *    flushPrefetch() while awaiting its directory slice must drop its plan
 *    instead of enqueuing tiles for the flushed playhead/direction.
 */

import { describe, it, expect, vi } from 'vitest';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import type { TileId, BoundingBox } from '../src/types';
import { BUCKET_MS, fakeTile, settle } from './helpers/fixtures';

/** Coverage-index queries use the FULL_TIME_RANGE sentinel (start ≈ -8.64e15). */
const isCoverageRange = (r: { start: number }): boolean => r.start < -1e15;

describe('coverage-index spatial debounce', () => {
  it('does not rebuild for sub-tile drift, but does for a real pan/zoom', async () => {
    const getAvailableTiles = vi.fn(
      async (_b: BoundingBox, z: number): Promise<TileId[]> => [
        { z, x: 0, y: 0, t: 0 },
      ],
    );
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles,
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: async (ids: TileId[]) => ids.map(fakeTile),
      onBufferChange: () => {}, // wiring this enables coverage tracking
    });

    const coverageCount = (): number =>
      getAvailableTiles.mock.calls.filter((c) =>
        isCoverageRange(c[2] as { start: number }),
      ).length;

    // 1°-wide viewport, so the 1/8 tolerance is ~0.125°.
    const at = (lon: number): BoundingBox => ({
      minLon: lon,
      minLat: 0,
      maxLon: lon + 1,
      maxLat: 1,
    });

    tileset.update({ bounds: at(0), zoom: 6, time: 500, timeWindow: 100 });
    await settle();
    const base = coverageCount();
    expect(base).toBeGreaterThanOrEqual(1);

    // Drift 0.05° (< 1/8 of the 1° span): selection re-runs (exact bounds + time
    // differ) but the quantized coverage signature is unchanged → NO rebuild.
    tileset.update({ bounds: at(0.05), zoom: 6, time: 600, timeWindow: 100 });
    await settle();
    expect(coverageCount()).toBe(base);

    // Pan 0.5° (> 1/8 span) → the coverage signature moves → rebuild.
    tileset.update({ bounds: at(0.5), zoom: 6, time: 700, timeWindow: 100 });
    await settle();
    expect(coverageCount()).toBe(base + 1);

    // Zoom change at the same (drifted-tolerant) bounds → rebuild.
    tileset.update({ bounds: at(0.5), zoom: 7, time: 800, timeWindow: 100 });
    await settle();
    expect(coverageCount()).toBe(base + 2);

    tileset.finalize();
  });
});

describe('selectAndLoadTiles generation guard', () => {
  it('a stale (late-resolving) selection does not clobber a newer one', async () => {
    // Gate getAvailableTiles so we control resolution order. The viewport is
    // identified by minLon (0 = stale pass, 100 = fresh pass).
    const deferreds: Array<{
      marker: number;
      resolve: (ids: TileId[]) => void;
    }> = [];
    const getAvailableTiles = (b: BoundingBox): Promise<TileId[]> =>
      new Promise<TileId[]>((resolve) => {
        deferreds.push({ marker: b.minLon, resolve });
      });

    const loaded: TileId[] = [];
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles,
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: async (ids: TileId[]) => {
        loaded.push(...ids);
        return ids.map(fakeTile);
      },
    });

    // Pass 1 (stale) at lon 0; Pass 2 (fresh) at lon 100 — both dispatched
    // before either directory slice resolves.
    tileset.update({
      bounds: { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 },
      zoom: 6,
      time: 500,
      timeWindow: 100,
    });
    tileset.update({
      bounds: { minLon: 100, minLat: 0, maxLon: 101, maxLat: 1 },
      zoom: 6,
      time: 500,
      timeWindow: 100,
    });

    expect(deferreds.length).toBe(2);
    const stale = deferreds.find((d) => d.marker === 0)!;
    const fresh = deferreds.find((d) => d.marker === 100)!;

    // Resolve FRESH first, then STALE (out of order).
    fresh.resolve([{ z: 6, x: 100, y: 0, t: 0 }]);
    await settle();
    stale.resolve([{ z: 6, x: 0, y: 0, t: 0 }]);
    await settle();

    // Only the fresh viewport's tile was ever enqueued / loaded; the stale pass
    // bailed at its generation check before mutating any shared state.
    expect(tileset.getVisibleTiles().map((t) => t.id.x)).toEqual([100]);
    expect(loaded.map((t) => t.x)).toEqual([100]);

    tileset.finalize();
  });
});

describe('selection failure surfacing', () => {
  it('a rejecting directory query surfaces via onTileError and the next update retries', async () => {
    let failuresLeft = 1;
    const getAvailableTiles = vi.fn(
      async (_b: BoundingBox, z: number): Promise<TileId[]> => {
        if (failuresLeft > 0) {
          failuresLeft--;
          throw new Error('paged leaf fetch blipped');
        }
        return [{ z, x: 0, y: 0, t: 0 }];
      },
    );
    const errors: Array<{ message: string; id: TileId }> = [];
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles,
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: async (ids: TileId[]) => ids.map(fakeTile),
      onTileError: (err, id) => errors.push({ message: err.message, id }),
    });

    const viewport = {
      bounds: { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 },
      zoom: 6,
      time: 500,
      timeWindow: 100,
    };
    tileset.update(viewport);
    await settle();
    // The failure surfaced (sentinel x/y = -1: a selection-pass failure, no
    // single tile implicated) instead of dying as an unhandled rejection.
    expect(errors.length).toBe(1);
    expect(errors[0].message).toMatch(/blipped/);
    expect(errors[0].id.x).toBe(-1);
    expect(tileset.getVisibleTiles()).toEqual([]);

    // The IDENTICAL viewport again: the fast-path key was cleared on failure,
    // so the selection re-runs (it used to short-circuit forever) and loads.
    tileset.update(viewport);
    await settle();
    expect(tileset.getVisibleTiles().map((t) => t.id.x)).toEqual([0]);

    tileset.finalize();
  });
});

describe('prefetch stale-plan guard', () => {
  it('a plan superseded by flushPrefetch() mid-await enqueues nothing', async () => {
    // Selection queries (span = timeWindow) resolve immediately; the prefetch
    // pass's WIDE look-ahead slice is gated so the flush races ahead of it.
    const gated: Array<(ids: TileId[]) => void> = [];
    const getAvailableTiles = async (
      _b: BoundingBox,
      z: number,
      r: { start: number; end: number },
    ): Promise<TileId[]> => {
      if (r.end - r.start > 10_000) {
        return new Promise<TileId[]>((resolve) => {
          gated.push(resolve);
        });
      }
      return [{ z, x: 0, y: 0, t: 0 }];
    };
    const loaded: TileId[] = [];
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles,
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: async (ids: TileId[]) => {
        loaded.push(...ids);
        return ids.map(fakeTile);
      },
    });

    tileset.update({
      bounds: { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 },
      zoom: 6,
      time: 500,
      timeWindow: 100,
    });
    tileset.setAnimationState(true, 1);
    await settle();
    expect(gated.length).toBeGreaterThanOrEqual(1);

    // Supersede the awaited plan, then let its directory slice resolve LATE
    // with a pile of future buckets.
    tileset.flushPrefetch();
    gated[0](
      Array.from({ length: 8 }, (_, i) => ({
        z: 6,
        x: 0,
        y: 0,
        t: (i + 1) * BUCKET_MS,
      })),
    );
    await settle();

    // The stale plan enqueued nothing: only the selection's tile loaded.
    expect(loaded.map((t) => t.t)).toEqual([0]);

    tileset.finalize();
  });
});

// ---------------------------------------------------------------------------
// FS-2 — the `tileCells` selection path
//
// `update({..., tileCells})` swaps the per-zoom box enumeration for a
// cell-addressed slice over a mixed-zoom quadtree cut. Everything the incumbent
// path guarantees has to survive that swap, because the cut changes WHICH cells
// are addressed and nothing else: the stale-generation guard, the failure retry,
// the prefetch-flush tolerance, tier dispatch, the scrub-LOD degrade and the
// additive union are all still in force.
//
// The regression pin that outranks the rest is the FIRST test: with no
// `tileCells` (the shipped default) the selection is byte-for-byte what it was.
// ---------------------------------------------------------------------------

const CUT_VIEWPORT = {
  bounds: { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 },
  zoom: 6,
  time: 500,
  timeWindow: 100,
};

/** A tileset wired with both slices; `calls` records which one ran. */
function cutTileset(
  opts: Partial<{
    lodMode: 'parent-fallback' | 'additive';
    refinementStrategy: 'best-available' | 'no-overlap';
    minZoom: number;
    maxZoom: number;
    tier: 'auto' | 'raw' | 'summary';
    summaryZoomRange: { minZoom: number; maxZoom: number };
    withSummary: boolean;
    withCells: boolean;
    scrubLod: { spatial?: boolean; spatialZoomDrop?: number };
    enablePrefetch: boolean;
  }> = {},
) {
  const boxCalls: Array<{ zoom: number; tier: string }> = [];
  const cellCalls: Array<{
    cells: Array<{ z: number; x: number; y: number }>;
    tier?: string;
    bucketMs?: number;
  }> = [];
  const loaded: TileId[] = [];

  const idsForCells = (cells: readonly TileId[], variantId: number): TileId[] =>
    cells.map((c) => ({ z: c.z, x: c.x, y: c.y, t: 0, variantId }));

  const tileset = new SpatioTemporalTileset({
    minZoom: opts.minZoom ?? 0,
    maxZoom: opts.maxZoom ?? 12,
    enablePrefetch: opts.enablePrefetch ?? false,
    refinementStrategy: opts.refinementStrategy ?? 'no-overlap',
    lodMode: opts.lodMode,
    temporalBucketMs: BUCKET_MS,
    tier: opts.tier,
    summaryZoomRange: opts.summaryZoomRange,
    scrubLod: opts.scrubLod,
    getAvailableTiles: async (
      _b: BoundingBox,
      z: number,
    ): Promise<TileId[]> => {
      boxCalls.push({ zoom: z, tier: 'raw' });
      return [{ z, x: 0, y: 0, t: 0 }];
    },
    getAvailableSummaryTiles: opts.withSummary
      ? async (_b: BoundingBox, z: number): Promise<TileId[]> => {
          boxCalls.push({ zoom: z, tier: 'summary' });
          return [{ z, x: 0, y: 0, t: 0, variantId: 1 }];
        }
      : undefined,
    getAvailableTilesForCells:
      opts.withCells === false
        ? undefined
        : async (
            cells: readonly TileId[],
            _r: { start: number; end: number },
            o?: { tier?: 'raw' | 'summary'; bucketMs?: number },
          ): Promise<TileId[]> => {
            cellCalls.push({
              cells: cells.map((c) => ({ z: c.z, x: c.x, y: c.y })),
              tier: o?.tier,
              bucketMs: o?.bucketMs,
            });
            return idsForCells(cells, o?.tier === 'summary' ? 1 : 0);
          },
    getTileData: async (id: TileId) => fakeTile(id),
    getTileDataBatch: async (ids: TileId[]) => {
      loaded.push(...ids);
      return ids.map(fakeTile);
    },
  });
  return { tileset, boxCalls, cellCalls, loaded };
}

/**
 * The set of tiles selection actually FETCHED, as sorted `z/x/y` keys.
 *
 * Deliberately the fetch set and not `getVisibleTiles()`: FS-2 owns which cells
 * are addressed and loaded, while what a MIXED-ZOOM working set means at the
 * renderer is FS-3's item — `getVisibleTiles` still derives ONE `primaryZoom`
 * from the needed set and composites everything coarser as fallback, so under a
 * real cut it can drop a far-field member that FS-2 correctly selected. Reading
 * the fetch set keeps this file measuring the thing this item changed.
 */
function fetchedCells(loaded: TileId[]): string[] {
  return [...new Set(loaded.map((t) => `${t.z}/${t.x}/${t.y}`))].sort();
}

describe('FS-2 tileCells: the flag-off regression pin', () => {
  it('an update WITHOUT tileCells selects exactly what it selects today', async () => {
    // The item ships default-off, and "default-off" has to mean the incumbent
    // path is untouched — not "a very similar path". Same call log, same tiles,
    // and the cells slice never runs.
    const withCallback = cutTileset();
    withCallback.tileset.update(CUT_VIEWPORT);
    await settle();

    const without = cutTileset({ withCells: false });
    without.tileset.update(CUT_VIEWPORT);
    await settle();

    expect(withCallback.cellCalls).toEqual([]);
    expect(withCallback.boxCalls).toEqual(without.boxCalls);
    expect(fetchedCells(withCallback.loaded)).toEqual(
      fetchedCells(without.loaded),
    );
    expect(withCallback.tileset.getVisibleTiles().map((t) => t.id)).toEqual(
      without.tileset.getVisibleTiles().map((t) => t.id),
    );
    expect(withCallback.tileset.getSelectionCut()).toBeNull();
    withCallback.tileset.finalize();
    without.tileset.finalize();
  });

  it('falls back to the box path when the cells slice is not wired', async () => {
    // Capability detection, not a crash: an older core / a custom tileset with
    // no cell-addressed query still selects, via the enumeration it has.
    const { tileset, boxCalls } = cutTileset({ withCells: false });
    tileset.update({
      ...CUT_VIEWPORT,
      tileCells: [{ z: 8, x: 128, y: 128, t: 0 }],
    });
    await settle();
    expect(boxCalls.map((c) => c.zoom)).toEqual([6]);
    tileset.finalize();
  });

  it('falls back to the box path for a cut it cannot vouch for', async () => {
    // Empty, malformed and out-of-world cuts all resolve to "no cut", which is
    // the incumbent path — never to "select nothing", which is a blank map.
    for (const tileCells of [
      [],
      [{ z: 5.5, x: 1, y: 1, t: 0 }],
      [{ z: 8, x: -1, y: 1, t: 0 }],
      [{ z: 8, x: 1, y: 1 << 20, t: 0 }],
      [{ z: 8, x: NaN, y: 1, t: 0 }],
    ] as TileId[][]) {
      const { tileset, boxCalls, cellCalls } = cutTileset();
      tileset.update({ ...CUT_VIEWPORT, tileCells });
      await settle();
      expect(cellCalls).toEqual([]);
      expect(boxCalls.map((c) => c.zoom)).toEqual([6]);
      tileset.finalize();
    }
  });

  it('falls back when NO cut member is inside the archive zoom range', async () => {
    // The cover primitive clamps its targets to `[minZoom, maxZoom]`, so this
    // only reaches a hand-built cut — but the failure it would cause is the
    // worst one available: the cells path would address nothing at all and the
    // map would go blank, where the box path clamps into range and returns
    // something. Fail open.
    const { tileset, boxCalls, cellCalls, loaded } = cutTileset({
      minZoom: 4,
      maxZoom: 8,
    });
    tileset.update({
      ...CUT_VIEWPORT,
      tileCells: [
        { z: 11, x: 1024, y: 1024, t: 0 },
        { z: 2, x: 1, y: 1, t: 0 },
      ],
    });
    await settle();
    expect(cellCalls).toEqual([]);
    expect(boxCalls.map((c) => c.zoom)).toEqual([6]);
    expect(fetchedCells(loaded).length).toBeGreaterThan(0);
    expect(tileset.getSelectionCut()).toBeNull();
    tileset.finalize();
  });
});

describe('FS-2 tileCells: what the cut addresses', () => {
  it('queries exactly the named cells, grouped per zoom, deepest first', async () => {
    const { tileset, boxCalls, cellCalls, loaded } = cutTileset();
    tileset.update({
      ...CUT_VIEWPORT,
      tileCells: [
        { z: 6, x: 32, y: 32, t: 0 },
        { z: 8, x: 128, y: 128, t: 0 },
        { z: 8, x: 129, y: 128, t: 0 },
      ],
    });
    await settle();

    // No box enumeration at all — the cut replaced it.
    expect(boxCalls).toEqual([]);
    expect(cellCalls.map((c) => c.cells)).toEqual([
      [
        { z: 8, x: 128, y: 128 },
        { z: 8, x: 129, y: 128 },
      ],
      [{ z: 6, x: 32, y: 32 }],
    ]);
    // Every cut member is FETCHED — including the far-field z6 one. (What the
    // renderer then composites from a mixed-zoom set is FS-3's item; see
    // `fetchedCells`.)
    expect(fetchedCells(loaded)).toEqual(['6/32/32', '8/128/128', '8/129/128']);
    expect(tileset.getSelectionCut()!.length).toBe(3);
    tileset.finalize();
  });

  it('de-duplicates a cut and drops cells outside the archive zoom range', async () => {
    const { tileset, cellCalls } = cutTileset({ minZoom: 4, maxZoom: 8 });
    tileset.update({
      ...CUT_VIEWPORT,
      tileCells: [
        { z: 8, x: 128, y: 128, t: 0 },
        { z: 8, x: 128, y: 128, t: 0 }, // duplicate
        { z: 10, x: 512, y: 512, t: 0 }, // past maxZoom
        { z: 2, x: 1, y: 1, t: 0 }, // below minZoom
      ],
    });
    await settle();
    expect(cellCalls.map((c) => c.cells)).toEqual([[{ z: 8, x: 128, y: 128 }]]);
    tileset.finalize();
  });

  it('publishes the cut it addressed for FS-3, and null on the box path', async () => {
    const { tileset } = cutTileset();
    tileset.update(CUT_VIEWPORT);
    await settle();
    expect(tileset.getSelectionCut()).toBeNull();

    tileset.update({
      ...CUT_VIEWPORT,
      time: 600,
      tileCells: [
        { z: 8, x: 128, y: 128, t: 0 },
        { z: 6, x: 32, y: 32, t: 0 },
      ],
    });
    await settle();
    expect(tileset.getSelectionCut()).toEqual([
      { z: 8, x: 128, y: 128, t: 0 },
      { z: 6, x: 32, y: 32, t: 0 },
    ]);
    tileset.finalize();
  });
});

describe('FS-2 tileCells: parent stand-ins and the additive union', () => {
  it("best-available adds each branch's own parent band, never the screen's", async () => {
    const { tileset, cellCalls } = cutTileset({
      refinementStrategy: 'best-available',
      minZoom: 0,
      maxZoom: 12,
    });
    tileset.update({
      ...CUT_VIEWPORT,
      tileCells: [{ z: 8, x: 128, y: 128, t: 0 }],
    });
    await settle();
    // PARENT_FALLBACK_LEVELS = 4: z7..z4 under the one cut cell, each the
    // ancestor of the cell rather than a whole-viewport box at that zoom.
    expect(cellCalls.map((c) => c.cells)).toEqual([
      [{ z: 8, x: 128, y: 128 }],
      [{ z: 7, x: 64, y: 64 }],
      [{ z: 6, x: 32, y: 32 }],
      [{ z: 5, x: 16, y: 16 }],
      [{ z: 4, x: 8, y: 8 }],
    ]);
    tileset.finalize();
  });

  it('no-overlap adds no stand-ins at all, exactly as the box path does not', async () => {
    const { tileset, cellCalls } = cutTileset({
      refinementStrategy: 'no-overlap',
    });
    tileset.update({
      ...CUT_VIEWPORT,
      tileCells: [{ z: 8, x: 128, y: 128, t: 0 }],
    });
    await settle();
    expect(cellCalls.map((c) => c.cells)).toEqual([[{ z: 8, x: 128, y: 128 }]]);
    tileset.finalize();
  });

  it('additive LOD: the ancestor union EQUALS the [minZoom..z] loop on a flat camera', async () => {
    // A flat camera cuts uniformly at one zoom, so the cut's ancestor union has
    // to reproduce the additive loop's enumeration exactly — the property that
    // makes the walk's interior nodes a drop-in for it.
    const box = cutTileset({
      lodMode: 'additive',
      refinementStrategy: 'best-available',
      minZoom: 3,
      maxZoom: 8,
      withCells: false,
    });
    box.tileset.update({ ...CUT_VIEWPORT, zoom: 6 });
    await settle();
    expect(box.boxCalls.map((c) => c.zoom)).toEqual([6, 5, 4, 3]);

    const cut = cutTileset({
      lodMode: 'additive',
      refinementStrategy: 'best-available',
      minZoom: 3,
      maxZoom: 8,
    });
    cut.tileset.update({
      ...CUT_VIEWPORT,
      zoom: 6,
      tileCells: [{ z: 6, x: 32, y: 32, t: 0 }],
    });
    await settle();
    expect(cut.cellCalls.map((c) => c.cells)).toEqual([
      [{ z: 6, x: 32, y: 32 }],
      [{ z: 5, x: 16, y: 16 }],
      [{ z: 4, x: 8, y: 8 }],
      [{ z: 3, x: 4, y: 4 }],
    ]);
    // Same zoom levels, same order — the cut just names the ONE column the
    // camera is over instead of a box at each level.
    expect(cut.cellCalls.map((c) => c.cells[0].z)).toEqual(
      box.boxCalls.map((c) => c.zoom),
    );
    box.tileset.finalize();
    cut.tileset.finalize();
  });

  it('a stand-in never duplicates a cell the cut already holds', async () => {
    const { tileset, cellCalls } = cutTileset({
      refinementStrategy: 'best-available',
      minZoom: 0,
      maxZoom: 12,
    });
    // z6/32/32 IS z8/128/128's grandparent — it must appear once, in the cut.
    tileset.update({
      ...CUT_VIEWPORT,
      tileCells: [
        { z: 8, x: 128, y: 128, t: 0 },
        { z: 6, x: 32, y: 32, t: 0 },
      ],
    });
    await settle();
    const emitted = cellCalls.flatMap((c) =>
      c.cells.map((x) => `${x.z}/${x.x}/${x.y}`),
    );
    expect(emitted.length).toBe(new Set(emitted).size);
    expect(emitted.filter((k) => k === '6/32/32').length).toBe(1);
    tileset.finalize();
  });
});

describe('FS-2 tileCells: tier dispatch over a mixed-zoom cut', () => {
  it('dispatches summary and raw IN THE SAME PASS, per cell zoom', async () => {
    // The thing a box query at one zoom structurally cannot do: the far-field
    // cells fall inside the summary range while the near-field ones do not, and
    // one selection pass serves both.
    const { tileset, cellCalls } = cutTileset({
      withSummary: true,
      tier: 'auto',
      summaryZoomRange: { minZoom: 0, maxZoom: 6 },
    });
    tileset.update({
      ...CUT_VIEWPORT,
      tileCells: [
        { z: 9, x: 256, y: 256, t: 0 },
        { z: 5, x: 16, y: 16, t: 0 },
      ],
    });
    await settle();
    expect(cellCalls.map((c) => ({ z: c.cells[0].z, tier: c.tier }))).toEqual([
      { z: 9, tier: 'raw' },
      { z: 5, tier: 'summary' },
    ]);
    tileset.finalize();
  });

  it('honours an explicit tier setting for every cell', async () => {
    const { tileset, cellCalls } = cutTileset({
      withSummary: true,
      tier: 'raw',
      summaryZoomRange: { minZoom: 0, maxZoom: 6 },
    });
    tileset.update({
      ...CUT_VIEWPORT,
      tileCells: [
        { z: 9, x: 256, y: 256, t: 0 },
        { z: 5, x: 16, y: 16, t: 0 },
      ],
    });
    await settle();
    expect(cellCalls.every((c) => c.tier === 'raw')).toBe(true);
    tileset.finalize();
  });
});

describe('FS-2 tileCells: the scrub-LOD spatial drop', () => {
  it('applies the SAME −k to every branch, floored at minZoom', async () => {
    const { tileset, cellCalls } = cutTileset({
      minZoom: 4,
      maxZoom: 12,
      scrubLod: { spatial: true, spatialZoomDrop: 2 },
    });
    // Two DISJOINT branches (z5/20/20 covers z10 columns 640-671, nowhere near
    // 512), so the drop is measured on its own and not confused with the
    // antichain reduction the next test covers.
    const cells = [
      { z: 10, x: 512, y: 512, t: 0 },
      { z: 5, x: 20, y: 20, t: 0 }, // one level above the floor
    ];
    tileset.update({ ...CUT_VIEWPORT, tileCells: cells });
    await settle();
    expect(cellCalls.map((c) => c.cells[0].z)).toEqual([10, 5]);

    tileset.setInteractive(true);
    tileset.update({ ...CUT_VIEWPORT, time: 600, tileCells: cells });
    await settle();
    // z10 → z8 (a full −2); z5 → z4 (clamped by minZoom, not dropped below it).
    // The last pass's two groups (`setInteractive` itself reselects, so there
    // is an earlier degraded pass with the same shape ahead of this one).
    expect(
      cellCalls.slice(-2).map((c) => ({ z: c.cells[0].z, x: c.cells[0].x })),
    ).toEqual([
      { z: 8, x: 128 },
      { z: 4, x: 10 },
    ]);
    tileset.finalize();
  });

  it('re-reduces to an ANTICHAIN when the drop makes two branches nest', async () => {
    // A cut is an antichain by construction, but coarsening every branch by the
    // same −k can lift a deep branch onto a shallow one's block. Keeping both
    // would be the 2026-07-29 double-draw; keeping the ANCESTOR is the only
    // safe direction (dropping upward would lose area).
    const { tileset, cellCalls } = cutTileset({
      minZoom: 0,
      maxZoom: 12,
      scrubLod: { spatial: true, spatialZoomDrop: 2 },
    });
    tileset.setInteractive(true);
    tileset.update({
      ...CUT_VIEWPORT,
      tileCells: [
        { z: 6, x: 32, y: 32, t: 0 }, // → z4/8/8
        { z: 8, x: 128, y: 128, t: 0 }, // → z6/32/32, which z4/8/8 contains
      ],
    });
    await settle();
    expect(cellCalls.map((c) => c.cells)).toEqual([[{ z: 4, x: 8, y: 8 }]]);
    expect(tileset.getSelectionCut()).toEqual([{ z: 4, x: 8, y: 8, t: 0 }]);
    tileset.finalize();
  });
});

describe('FS-2 tileCells: the guards the box path already had', () => {
  it('a stale (late-resolving) cut selection does not clobber a newer one', async () => {
    const deferreds: Array<{
      marker: number;
      resolve: (ids: TileId[]) => void;
    }> = [];
    const loaded: TileId[] = [];
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles: async (_b: BoundingBox, z: number) => [
        { z, x: 0, y: 0, t: 0 },
      ],
      getAvailableTilesForCells: (cells: readonly TileId[]) =>
        new Promise<TileId[]>((resolve) => {
          deferreds.push({ marker: cells[0].x, resolve });
        }),
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: async (ids: TileId[]) => {
        loaded.push(...ids);
        return ids.map(fakeTile);
      },
    });

    tileset.update({
      ...CUT_VIEWPORT,
      tileCells: [{ z: 8, x: 10, y: 0, t: 0 }],
    });
    tileset.update({
      ...CUT_VIEWPORT,
      bounds: { minLon: 100, minLat: 0, maxLon: 101, maxLat: 1 },
      tileCells: [{ z: 8, x: 200, y: 0, t: 0 }],
    });
    expect(deferreds.length).toBe(2);

    // Resolve FRESH first, then STALE (out of order).
    deferreds
      .find((d) => d.marker === 200)!
      .resolve([{ z: 8, x: 200, y: 0, t: 0 }]);
    await settle();
    deferreds
      .find((d) => d.marker === 10)!
      .resolve([{ z: 8, x: 10, y: 0, t: 0 }]);
    await settle();

    expect(tileset.getVisibleTiles().map((t) => t.id.x)).toEqual([200]);
    expect(loaded.map((t) => t.x)).toEqual([200]);
    tileset.finalize();
  });

  it('a rejecting cell slice surfaces via onTileError and the next update retries', async () => {
    let failuresLeft = 1;
    const errors: Array<{ message: string; id: TileId }> = [];
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles: async (_b: BoundingBox, z: number) => [
        { z, x: 0, y: 0, t: 0 },
      ],
      getAvailableTilesForCells: async (cells: readonly TileId[]) => {
        if (failuresLeft > 0) {
          failuresLeft--;
          throw new Error('paged leaf fetch blipped');
        }
        return cells.map((c) => ({ z: c.z, x: c.x, y: c.y, t: 0 }));
      },
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: async (ids: TileId[]) => ids.map(fakeTile),
      onTileError: (err, id) => errors.push({ message: err.message, id }),
    });

    const viewport = {
      ...CUT_VIEWPORT,
      tileCells: [{ z: 8, x: 128, y: 128, t: 0 }],
    };
    tileset.update(viewport);
    await settle();
    expect(errors.length).toBe(1);
    expect(errors[0].message).toMatch(/blipped/);
    expect(errors[0].id.x).toBe(-1);
    expect(tileset.getVisibleTiles()).toEqual([]);

    // The IDENTICAL viewport again: `lastSelectKey` was cleared on failure, so
    // the pass re-runs rather than short-circuiting forever.
    tileset.update(viewport);
    await settle();
    expect(
      tileset.getVisibleTiles().map((t) => `${t.id.z}/${t.id.x}/${t.id.y}`),
    ).toEqual(['8/128/128']);
    tileset.finalize();
  });

  it('the selection fast path folds the cut in: same box, different cut, reselects', async () => {
    const { tileset, cellCalls } = cutTileset();
    tileset.update({
      ...CUT_VIEWPORT,
      tileCells: [{ z: 8, x: 128, y: 128, t: 0 }],
    });
    await settle();
    expect(cellCalls.length).toBe(1);

    // Identical everything ⇒ the fast path short-circuits.
    tileset.update({
      ...CUT_VIEWPORT,
      tileCells: [{ z: 8, x: 128, y: 128, t: 0 }],
    });
    await settle();
    expect(cellCalls.length).toBe(1);

    // Same box, same zoom, same window — but a DIFFERENT cut. Two cameras can
    // share a box and cut the quadtree differently, so this must reselect.
    tileset.update({
      ...CUT_VIEWPORT,
      tileCells: [{ z: 8, x: 129, y: 128, t: 0 }],
    });
    await settle();
    expect(cellCalls.length).toBe(2);

    // A REORDERED but equal cut is the same working set: no reselect.
    tileset.update({
      ...CUT_VIEWPORT,
      tileCells: [{ z: 8, x: 129, y: 128, t: 0 }],
    });
    await settle();
    expect(cellCalls.length).toBe(2);
    tileset.finalize();
  });
});

describe('FS-2 tileCells: the prefetch flush signature', () => {
  /** Count of prefetch-tier (wide-window) queries the tileset issued. */
  function prefetchProbe() {
    const cellCalls: number[] = [];
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles: async (_b: BoundingBox, z: number) => [
        { z, x: 0, y: 0, t: 0 },
      ],
      getAvailableTilesForCells: async (cells: readonly TileId[]) => {
        cellCalls.push(cells.length);
        return cells.map((c) => ({ z: c.z, x: c.x, y: c.y, t: 0 }));
      },
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: async (ids: TileId[]) => ids.map(fakeTile),
    });
    return { tileset, cellCalls };
  }

  /**
   * Runs one camera step and reports whether the spatial prefetch flush fired.
   *
   * Observed at the decision itself — `flushPrefetch` is public, so the probe
   * wraps it rather than inferring the verdict from a downstream symptom.
   * (Inference is unreliable here: the flush clears `lastSelectKey` and the
   * selection pass then re-stamps it before returning, and the prefetch queue
   * drains on its own.) This is the one line the item changes on this path, so
   * it is the line the test reads.
   */
  async function flushedByStep(step: {
    bounds?: BoundingBox;
    tileCells: TileId[];
  }): Promise<boolean> {
    const { tileset } = prefetchProbe();
    tileset.update({
      ...CUT_VIEWPORT,
      tileCells: [{ z: 8, x: 128, y: 128, t: 0 }],
    });
    tileset.setAnimationState(true, 1);
    await settle();

    let flushed = false;
    const original = tileset.flushPrefetch.bind(tileset);
    tileset.flushPrefetch = (preserveNeeded?: boolean): void => {
      flushed = true;
      original(preserveNeeded);
    };

    tileset.update({
      ...CUT_VIEWPORT,
      bounds: step.bounds ?? CUT_VIEWPORT.bounds,
      time: 600,
      tileCells: step.tileCells,
    });
    await settle();
    tileset.finalize();
    return flushed;
  }

  it('an unchanged cut under sub-tile drift does NOT flush the runway', async () => {
    // The whole point of the signature swap: a follow-cam drifting a sliver per
    // frame keeps its prefetch. Under the box path this term was
    // `zoom !== lastSpatialZoom`; a quadtree cut has no single zoom, so its
    // IDENTITY plays that role — and the centre/span tolerance below it is
    // untouched (SPATIAL_FLUSH_TOLERANCE is register territory: the KEY
    // changes, the constants do not).
    expect(
      await flushedByStep({
        // Drift 0.05° of a 1° span — well inside the 1/8 tolerance.
        bounds: { minLon: 0.05, minLat: 0, maxLon: 1.05, maxLat: 1 },
        tileCells: [{ z: 8, x: 128, y: 128, t: 0 }],
      }),
    ).toBe(false);
  });

  it('a REORDERED but equal cut is not a move either', async () => {
    // The signature is order-independent for exactly this reason: a chassis
    // that rebuilds the same cut in a different order must not read as a camera
    // move and throw the runway away.
    expect(
      await flushedByStep({
        tileCells: [{ z: 8, x: 128, y: 128, t: 0 }],
      }),
    ).toBe(false);
  });

  it('a CHANGED cut at the same box and zoom DOES flush', async () => {
    expect(
      await flushedByStep({
        tileCells: [
          { z: 8, x: 129, y: 128, t: 0 },
          { z: 8, x: 128, y: 128, t: 0 },
        ],
      }),
    ).toBe(true);
  });
});

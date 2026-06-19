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
 */

import { describe, it, expect, vi } from 'vitest';
import { SpatiotemporalTileset } from '../src/spatiotemporal-tileset';
import type { TileId, BoundingBox, Tile } from '../src/types';

const BUCKET_MS = 1000;
const fakeTile = (id: TileId): Tile =>
  ({ id, timeRange: { start: id.t, end: id.t + BUCKET_MS }, layers: [] }) as unknown as Tile;

const settle = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Coverage-index queries use the FULL_TIME_RANGE sentinel (start ≈ -8.64e15). */
const isCoverageRange = (r: { start: number }): boolean => r.start < -1e15;

describe('coverage-index spatial debounce', () => {
  it('does not rebuild for sub-tile drift, but does for a real pan/zoom', async () => {
    const getAvailableTiles = vi.fn(
      async (_b: BoundingBox, z: number): Promise<TileId[]> => [{ z, x: 0, y: 0, t: 0 }],
    );
    const tileset = new SpatiotemporalTileset({
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
      getAvailableTiles.mock.calls.filter((c) => isCoverageRange(c[2] as { start: number })).length;

    // 1°-wide viewport, so the 1/8 tolerance is ~0.125°.
    const at = (lon: number): BoundingBox => ({ minLon: lon, minLat: 0, maxLon: lon + 1, maxLat: 1 });

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
    const deferreds: Array<{ marker: number; resolve: (ids: TileId[]) => void }> = [];
    const getAvailableTiles = (b: BoundingBox): Promise<TileId[]> =>
      new Promise<TileId[]>((resolve) => {
        deferreds.push({ marker: b.minLon, resolve });
      });

    const loaded: TileId[] = [];
    const tileset = new SpatiotemporalTileset({
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
    tileset.update({ bounds: { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 }, zoom: 6, time: 500, timeWindow: 100 });
    tileset.update({ bounds: { minLon: 100, minLat: 0, maxLon: 101, maxLat: 1 }, zoom: 6, time: 500, timeWindow: 100 });

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

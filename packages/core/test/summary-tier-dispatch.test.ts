/**
 * Unit tests for the `tier: 'auto' | 'summary' | 'raw'` dispatch in
 * `SpatioTemporalTileset`. We don't need a real archive here — instead we
 * spy on the `getAvailableTiles` / `getAvailableSummaryTiles` callbacks and
 * make assertions about which one fires at which zoom.
 */

import { describe, it, expect, vi } from 'vitest';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import type { Tile, TileId, BoundingBox } from '../src/types';

const BOUNDS: BoundingBox = {
  minLon: -180,
  minLat: -85,
  maxLon: 180,
  maxLat: 85,
};

function makeTileset(opts: {
  tier?: 'auto' | 'raw' | 'summary';
  summaryRange?: { minZoom: number; maxZoom: number };
  withSummaryCallback?: boolean;
}) {
  const rawSpy = vi.fn(
    async (_b: BoundingBox, z: number): Promise<TileId[]> => [
      { z, x: 0, y: 0, t: 0 },
    ],
  );
  const summarySpy = vi.fn(
    async (_b: BoundingBox, z: number): Promise<TileId[]> => [
      { z, x: 0, y: 0, t: 1 },
    ],
  );
  const dataSpy = vi.fn(async (_id: TileId) => null);

  const tileset = new SpatioTemporalTileset({
    minZoom: 0,
    maxZoom: 12,
    tier: opts.tier ?? 'auto',
    summaryZoomRange: opts.summaryRange,
    enablePrefetch: false, // keep the test deterministic
    refinementStrategy: 'no-overlap',
    getAvailableTiles: rawSpy,
    getAvailableSummaryTiles: opts.withSummaryCallback ? summarySpy : undefined,
    getTileData: dataSpy,
  });
  return { tileset, rawSpy, summarySpy };
}

describe('SpatioTemporalTileset tier dispatch', () => {
  it('auto + summary range routes low zooms to summary, high zooms to raw', async () => {
    const { tileset, rawSpy, summarySpy } = makeTileset({
      tier: 'auto',
      summaryRange: { minZoom: 0, maxZoom: 4 },
      withSummaryCallback: true,
    });

    // Zoom 2 is inside summary range → summary callback only.
    tileset.update({ bounds: BOUNDS, zoom: 2, time: 0, timeWindow: 1000 });
    // Let the queued microtasks drain so getAvailableTiles has been called.
    await new Promise((r) => setTimeout(r, 0));
    expect(summarySpy).toHaveBeenCalledTimes(1);
    expect(rawSpy).not.toHaveBeenCalled();

    // Zoom 10 is OUTSIDE the summary range → raw callback only.
    tileset.update({ bounds: BOUNDS, zoom: 10, time: 0, timeWindow: 1000 });
    await new Promise((r) => setTimeout(r, 0));
    expect(rawSpy).toHaveBeenCalledTimes(1);
    expect(summarySpy).toHaveBeenCalledTimes(1);

    tileset.finalize();
  });

  it('tier: raw never calls the summary callback', async () => {
    const { tileset, rawSpy, summarySpy } = makeTileset({
      tier: 'raw',
      summaryRange: { minZoom: 0, maxZoom: 4 },
      withSummaryCallback: true,
    });
    tileset.update({ bounds: BOUNDS, zoom: 0, time: 0, timeWindow: 1000 });
    tileset.update({ bounds: BOUNDS, zoom: 2, time: 0, timeWindow: 1000 });
    await new Promise((r) => setTimeout(r, 0));
    expect(summarySpy).not.toHaveBeenCalled();
    expect(rawSpy.mock.calls.length).toBeGreaterThan(0);
    tileset.finalize();
  });

  it('tier: summary uses summary callback at every zoom (when provided)', async () => {
    const { tileset, rawSpy, summarySpy } = makeTileset({
      tier: 'summary',
      withSummaryCallback: true,
    });
    tileset.update({ bounds: BOUNDS, zoom: 10, time: 0, timeWindow: 1000 });
    await new Promise((r) => setTimeout(r, 0));
    expect(summarySpy).toHaveBeenCalledTimes(1);
    expect(rawSpy).not.toHaveBeenCalled();
    tileset.finalize();
  });

  it('auto falls back to raw when no summary callback is provided', async () => {
    // Even with a summaryRange set, without a summary callback the tileset
    // must NOT crash and must serve raw tiles.
    const { tileset, rawSpy, summarySpy } = makeTileset({
      tier: 'auto',
      summaryRange: { minZoom: 0, maxZoom: 4 },
      withSummaryCallback: false,
    });
    tileset.update({ bounds: BOUNDS, zoom: 2, time: 0, timeWindow: 1000 });
    await new Promise((r) => setTimeout(r, 0));
    expect(rawSpy).toHaveBeenCalledTimes(1);
    expect(summarySpy).not.toHaveBeenCalled();
    tileset.finalize();
  });
});

/**
 * E4 (tile-loading audit 2026-08, SEL-3): under `tier: 'auto'` the tier is
 * picked PER ZOOM, and `best-available` walks up to four parent levels. At
 * `summary.maxZoom + 1 … + 4` the primary is raw while every parent level lies
 * inside the summary range — so H3/Quadbin centroid cells with `count`
 * columns were handed to the raw layer as parent fallbacks (and, under the
 * old pass-2 rule, kept there). Parent levels now stay on the primary's tier.
 */
describe('E4: parent fallbacks never cross the tier edge', () => {
  function makeAutoTileset() {
    const rawZooms: number[] = [];
    const summaryZooms: number[] = [];
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 10,
      tier: 'auto',
      summaryZoomRange: { minZoom: 0, maxZoom: 4 },
      enablePrefetch: false,
      refinementStrategy: 'best-available',
      temporalBucketMs: 3_600_000,
      getAvailableTiles: async (
        _b: BoundingBox,
        z: number,
      ): Promise<TileId[]> => {
        rawZooms.push(z);
        return [{ z, x: 1, y: 1, t: 0, variantId: 0 }];
      },
      getAvailableSummaryTiles: async (
        _b: BoundingBox,
        z: number,
      ): Promise<TileId[]> => {
        summaryZooms.push(z);
        return [{ z, x: 1, y: 1, t: 0, variantId: 7 }];
      },
      getTileData: async (id: TileId) =>
        ({
          id,
          timeRange: { start: 0, end: 3_600_000 },
          layers: [],
        }) as unknown as Tile,
    });
    return { tileset, rawZooms, summaryZooms };
  }

  const VIEW: BoundingBox = { minLon: 8, minLat: 46, maxLon: 9, maxLat: 47 };
  const settle = async (n = 6): Promise<void> => {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it('at summary.maxZoom + 1 no summary-variant parent is scanned, needed, or delivered', async () => {
    const { tileset, rawZooms, summaryZooms } = makeAutoTileset();
    tileset.update({ bounds: VIEW, zoom: 5, time: 0, timeWindow: 100 }, true);
    await settle();

    // Pre-fix: summary scans [4, 3, 2, 1] and four `#7` keys in the needed
    // set, all delivered to the raw layer as "parents".
    expect(summaryZooms).toEqual([]);
    expect(rawZooms).toEqual([5]);
    const delivered = tileset.getVisibleTiles().map((t) => t.id);
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.every((id) => (id.variantId ?? 0) === 0)).toBe(true);

    tileset.finalize();
  });

  it('inside the summary range the parent band is summary all the way down', async () => {
    const { tileset, rawZooms, summaryZooms } = makeAutoTileset();
    tileset.update({ bounds: VIEW, zoom: 4, time: 0, timeWindow: 100 }, true);
    await settle();

    expect(rawZooms).toEqual([]);
    // The full parent band (PARENT_FALLBACK_LEVELS = 4) — z0 is inside the
    // range too, so it is a legitimate summary parent.
    expect(summaryZooms).toEqual([4, 3, 2, 1, 0]);
    const delivered = tileset.getVisibleTiles().map((t) => t.id);
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.every((id) => id.variantId === 7)).toBe(true);

    tileset.finalize();
  });
});

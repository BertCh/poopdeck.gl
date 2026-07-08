/**
 * Grace-period eviction ↔ buffered-timeline coherence.
 *
 * The under-limits eviction branch reclaims any tile outside the CURRENT
 * window's needed set once its wall-clock grace (30 s paused / 120 s
 * animating) expires — which used to include the prefetched runway and every
 * already-played bucket: exactly the tiles `getBufferedRanges()` reports as
 * buffered and the PlaybackGovernor gates on. The visible symptom was the
 * scrubber's buffered bar dropping ranges just ahead of the playhead and
 * "jumping around" as the priority path re-fetched the same bytes
 * (earthquakes demo: 5 years / 60 s playback ⇒ almost every loaded tile sits
 * outside the 30-day window at any instant, so the whole timeline was on the
 * timer).
 *
 * Invariants under test:
 *  - tiles in the coverage index (current viewport, FULL time range) are
 *    exempt from the grace timer while the cache is under its limits;
 *  - tiles from a PREVIOUS viewport are not in the index and still age out;
 *  - real memory pressure (over-limit LRU) still reclaims index-protected
 *    tiles — the exemption is time-based-eviction-only, not a pin.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { SpatiotemporalTileset } from '../src/spatiotemporal-tileset';
import type { TileId, BoundingBox, Tile } from '../src/types';
import { BUCKET_MS, fakeTile, makeAvailableTiles } from './helpers/fixtures';
import { advanceClock, installClock } from './helpers/clock';

const WEST: BoundingBox = {
  minLon: -170,
  minLat: -60,
  maxLon: -10,
  maxLat: 60,
};
const EAST: BoundingBox = { minLon: 10, minLat: -60, maxLon: 170, maxLat: 60 };
const N_BUCKETS = 60;

/**
 * One tile per bucket whose interval overlaps the range; x is viewport-derived
 * (west → x=0, east → x=1) so a viewport change genuinely changes the
 * needed-tile set AND the coverage index contents.
 */
const availableTiles = makeAvailableTiles(N_BUCKETS, (b) =>
  b.maxLon <= 0 ? 0 : 1,
);

const settle = (ms = 10): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function makeTileset(
  opts: { maxCacheSize?: number } = {},
): SpatiotemporalTileset {
  return new SpatiotemporalTileset({
    minZoom: 0,
    maxZoom: 12,
    enablePrefetch: false,
    refinementStrategy: 'no-overlap',
    temporalBucketMs: BUCKET_MS,
    ...(opts.maxCacheSize !== undefined
      ? { maxCacheSize: opts.maxCacheSize }
      : {}),
    getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
    getTileData: async (id: TileId) => fakeTile(id),
    getTileDataBatch: async (ids: TileId[]) => ids.map(fakeTile),
  });
}

const loadBucket = async (
  tileset: SpatiotemporalTileset,
  bounds: BoundingBox,
  i: number,
  // selectAndLoadTiles fast-paths identical (bounds, zoom, timeRange)
  // signatures — repeat updates would skip the eviction pass entirely. A
  // 1 ms nudge mimics a real playback tick and forces a full pass.
  timeNudge = 0,
): Promise<void> => {
  tileset.update({
    bounds,
    zoom: 6,
    time: i * BUCKET_MS + 500 + timeNudge,
    timeWindow: 100,
  });
  await settle();
};

/** Coverage index build is async — call a buffer API, then let it land. */
const enableBufferTracking = async (
  tileset: SpatiotemporalTileset,
): Promise<void> => {
  tileset.getBufferedRanges();
  await settle();
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SpatiotemporalTileset grace eviction vs buffered timeline', () => {
  it('keeps buffered-timeline tiles past the paused grace period (under limits)', async () => {
    installClock();
    const tileset = makeTileset();

    // Load bucket 0, enable tracking (index = west viewport, all 60 buckets),
    // then move the window to bucket 5 — bucket 0 is no longer "needed".
    await loadBucket(tileset, WEST, 0);
    await enableBufferTracking(tileset);
    await loadBucket(tileset, WEST, 5);
    expect(tileset.getCacheStats().tileCount).toBe(2);

    // Step far past the 30 s paused grace. Pre-fix the eviction pass on the
    // next update reclaimed bucket 0 here — un-buffering a range the bar had
    // just shown as loaded — even though the cache is nowhere near its
    // limits. Post-fix the coverage-index exemption keeps it.
    advanceClock(31_000);
    await loadBucket(tileset, WEST, 5, 1);
    expect(tileset.getCacheStats().tileCount).toBe(2);

    // And the buffered bar still reports bucket 0's range.
    const ranges = tileset.getBufferedRanges();
    expect(ranges.some((r) => r.start <= 0 && r.end >= BUCKET_MS)).toBe(true);

    tileset.finalize();
  });

  it('still ages out tiles from a previous viewport', async () => {
    installClock();
    const tileset = makeTileset();

    await loadBucket(tileset, WEST, 0); // x=0 tile
    await enableBufferTracking(tileset);

    // Pan east. The index rebuilds lazily — on the next buffer-API poll (the
    // governor/bar polls ≥1 Hz in production) — for the new viewport (x=1
    // keys only), so the west tile loses its exemption and ages out on the
    // normal timer.
    await loadBucket(tileset, EAST, 0); // x=1 tile
    await enableBufferTracking(tileset); // poll → east index build lands
    advanceClock(31_000);
    await loadBucket(tileset, EAST, 0, 1); // eviction pass with the east index
    expect(tileset.getCacheStats().tileCount).toBe(1);

    tileset.finalize();
  });

  it('over-limit pressure still reclaims index-protected tiles', async () => {
    installClock();
    const tileset = makeTileset({ maxCacheSize: 2 });

    await loadBucket(tileset, WEST, 0);
    await enableBufferTracking(tileset);
    for (const i of [1, 2, 3]) {
      await loadBucket(tileset, WEST, i);
    }
    // The eviction pass runs at selection time (before that update's own tile
    // lands), so the trim back to the limit shows on the NEXT pass.
    await loadBucket(tileset, WEST, 3, 1);

    // 4 loaded > maxCacheSize 2: the LRU branch must trim back to the limit
    // even though every tile is in the coverage index — the exemption only
    // covers the wall-clock timer, never real memory pressure.
    expect(tileset.getCacheStats().tileCount).toBeLessThanOrEqual(2);

    tileset.finalize();
  });
});

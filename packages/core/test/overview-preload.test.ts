/**
 * Tests for the overview (storyboard) preview tier (player buffering WS-C4):
 * `preloadOverviewTier()` on SpatioTemporalTileset.
 *
 * The overview tier is the data player's analog of a video storyboard: the
 * coarsest tiles (z0..z1) across the FULL dataset time range, loaded once
 * and PINNED so scrubbing always has something to render via the existing
 * parent-zoom fallback. Budget-gated on directory bytes (decided before any
 * fetch); pinned tiles are exempt from eviction, `flushPrefetch()`, and
 * `cancelSupersededRequests()`; and they never count toward the primary-zoom
 * readiness APIs (`getBufferedRunway` / `estimateCost` / `getBufferedRanges`).
 *
 * Harness: a synthetic single-cell archive (one tile per 1 s temporal bucket
 * at the requested zoom, byte length `100 × (bucketIndex + 1)` regardless of
 * zoom), mirroring buffered-runway.test.ts.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  PIN_COUNT_FRACTION,
  SpatioTemporalTileset,
} from '../src/spatiotemporal-tileset';
import type { SpatioTemporalTilesetOptions } from '../src/spatiotemporal-tileset';
import type { TileId, Tile } from '../src/types';
import {
  BOUNDS,
  BUCKET_MS,
  fakeTile,
  makeAvailableTiles,
  settle,
} from './helpers/fixtures';
import { advanceClock, installClock } from './helpers/clock';

const N_BUCKETS = 20;
/** Directory byte length of the tile at bucket index `i` (any zoom). */
const bytesAt = (i: number): number => 100 * (i + 1);
/** Directory byte sum of one zoom level's tiles across all buckets. */
const ZOOM_LEVEL_BYTES = Array.from({ length: N_BUCKETS }, (_, i) =>
  bytesAt(i),
).reduce((a, b) => a + b, 0);
/** The default overview tier is zooms 0..1 → two zoom levels of candidates. */
const OVERVIEW_TILES = 2 * N_BUCKETS;
const OVERVIEW_BYTES = 2 * ZOOM_LEVEL_BYTES;

/** One tile per bucket at (x=0, y=0) whose interval overlaps the range. */
const availableTiles = makeAvailableTiles(N_BUCKETS);

function getTileByteSize(id: TileId): number | undefined {
  const i = id.t / BUCKET_MS;
  if (id.x !== 0 || id.y !== 0) return undefined;
  if (!Number.isInteger(i) || i < 0 || i >= N_BUCKETS) return undefined;
  return bytesAt(i);
}

const key = (id: TileId): string => `${id.z}/${id.x}/${id.y}/${id.t}`;

/** A gated batch request: stays pending until resolved, rejects on abort. */
interface GatedBatch {
  ids: TileId[];
  signal: AbortSignal | undefined;
  resolve: () => void;
}

interface HarnessOptions extends Partial<SpatioTemporalTilesetOptions> {
  /** When set, batch loads stay PENDING until each batch is released. */
  gateBatches?: boolean;
}

function makeHarness(opts: HarnessOptions = {}) {
  const { gateBatches, ...overrides } = opts;
  /** Every batch call's ids, in call order (gated and ungated alike). */
  const batchCalls: TileId[][] = [];
  const gated: GatedBatch[] = [];
  const loaded: TileId[] = [];
  const unloaded: TileId[] = [];
  const tileset = new SpatioTemporalTileset({
    minZoom: 0,
    maxZoom: 12,
    enablePrefetch: false,
    refinementStrategy: 'no-overlap',
    temporalBucketMs: BUCKET_MS,
    getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
    getTileByteSize,
    getTileData: async (id: TileId) => fakeTile(id),
    getTileDataBatch: (ids: TileId[], signal?: AbortSignal) => {
      batchCalls.push(ids);
      if (!gateBatches) return Promise.resolve(ids.map(fakeTile));
      return new Promise<(Tile | null)[]>((resolve, reject) => {
        gated.push({ ids, signal, resolve: () => resolve(ids.map(fakeTile)) });
        signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    },
    onTileLoad: (t) => loaded.push(t.id),
    onTileUnload: (t) => unloaded.push(t.id),
    ...overrides,
  });
  /** Load exactly bucket `i` at the given zoom (tiny window inside the bucket). */
  const loadBucket = async (i: number, zoom = 6): Promise<void> => {
    tileset.update({
      bounds: BOUNDS,
      zoom,
      time: i * BUCKET_MS + 500,
      timeWindow: 100,
    });
    await settle(5);
  };
  return { tileset, batchCalls, gated, loaded, unloaded, loadBucket };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SpatioTemporalTileset.preloadOverviewTier', () => {
  it('rejects an over-budget tier from directory math alone — nothing is fetched', async () => {
    const { tileset, batchCalls } = makeHarness();

    const result = await tileset.preloadOverviewTier({ budgetBytes: 1000 });

    expect(result).toEqual({
      loaded: false,
      reason: 'over-budget',
      bytes: OVERVIEW_BYTES, // reported even when rejected
      tiles: OVERVIEW_TILES,
    });
    expect(batchCalls).toHaveLength(0); // budget gate fires BEFORE any fetch
    expect(tileset.getCacheStats().tileCount).toBe(0); // no headers created

    tileset.finalize();
  });

  it('loads and pins the tier when under budget (default 20 MiB)', async () => {
    const { tileset, batchCalls, loaded } = makeHarness();

    const result = await tileset.preloadOverviewTier();

    expect(result).toEqual({
      loaded: true,
      bytes: OVERVIEW_BYTES,
      tiles: OVERVIEW_TILES,
    });
    // Every z0 + z1 bucket tile arrived through the coalesced batch path.
    expect(loaded).toHaveLength(OVERVIEW_TILES);
    expect(new Set(loaded.map((id) => id.z))).toEqual(new Set([0, 1]));
    expect(batchCalls.flat()).toHaveLength(OVERVIEW_TILES);

    tileset.finalize();
  });

  it('is idempotent: a second call returns the same attempt, no duplicate fetch', async () => {
    const { tileset, batchCalls, gated } = makeHarness({ gateBatches: true });

    const p1 = tileset.preloadOverviewTier();
    await settle(); // enumeration done, overview batch in flight (gated)
    const p2 = tileset.preloadOverviewTier(); // while in-flight

    expect(gated).toHaveLength(1);
    for (const b of gated.splice(0)) b.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({
      loaded: true,
      bytes: OVERVIEW_BYTES,
      tiles: OVERVIEW_TILES,
    });
    expect(r2).toEqual(r1);

    // ...and after it has loaded, too.
    const r3 = await tileset.preloadOverviewTier();
    expect(r3).toEqual(r1);
    expect(batchCalls).toHaveLength(1); // exactly one overview batch, ever

    tileset.finalize();
  });

  /**
   * A1 (tile-loading audit 2026-08, CS-1 / CE-1). This test used to be
   * "pinned tiles survive eviction pressure (over maxCacheSize) and warn
   * once", and it asserted `unloaded.length > 0` — i.e. it PINNED the defect:
   * 40 pins against a 10-tile cap put the tileset permanently over
   * `maxCacheSize`, so every selection pass ran the over-limit branch and
   * evicted every non-pinned, non-needed tile, including the runway. The
   * correct behaviour is the two halves below: a pin that large is refused
   * on COUNT before anything is fetched, and a pin a caller explicitly
   * allows is ADDITIVE to the count budget rather than consuming it.
   */
  it('A1: a pin larger than PIN_COUNT_FRACTION × maxCacheSize is rejected over-count — nothing is fetched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 40 candidates against floor(10 × 0.25) = 2 allowed pins.
    const { tileset, batchCalls } = makeHarness({ maxCacheSize: 10 });
    expect(OVERVIEW_TILES).toBeGreaterThan(Math.floor(10 * PIN_COUNT_FRACTION));

    const result = await tileset.preloadOverviewTier();

    expect(result).toEqual({
      loaded: false,
      reason: 'over-count',
      bytes: OVERVIEW_BYTES, // reported even when rejected
      tiles: OVERVIEW_TILES,
    });
    expect(batchCalls).toHaveLength(0); // count gate fires BEFORE any fetch
    expect(tileset.getCacheStats().tileCount).toBe(0); // no headers created
    expect(tileset.getCacheStats().pinnedCount).toBe(0);
    // Nothing was pinned, so there is nothing to warn about.
    expect(warn).not.toHaveBeenCalled();

    tileset.finalize();
  });

  it('A1: pinned tiles are exempt from the count test — a legal pin never churns the working set', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The caller raises the pin allowance explicitly: 40 pins load against a
    // 10-tile cap. Pinned tiles must not consume that cap.
    const { tileset, unloaded, loadBucket } = makeHarness({ maxCacheSize: 10 });

    const result = await tileset.preloadOverviewTier({ maxTiles: 40 });
    expect(result.loaded).toBe(true);
    // The storyboard alone is larger than the working-set budget the caller
    // configured — that is still worth one warning, since eviction can never
    // reclaim pinned bytes.
    expect(warn).toHaveBeenCalledTimes(1);

    const stats = tileset.getCacheStats();
    expect(stats.pinnedCount).toBe(OVERVIEW_TILES);
    // `fakeTile` carries no buffers: every decoded tile is the 1 000-byte base.
    expect(stats.pinnedBytes).toBe(OVERVIEW_TILES * 1000);
    expect(stats.cacheBytes).toBe(stats.pinnedBytes);

    // Churn 8 primary-zoom buckets through the cache. 8 non-pinned tiles
    // against a 10-tile cap is UNDER the limit once pins are excluded, so no
    // over-limit pass may run and nothing may be evicted.
    for (let i = 0; i < 8; i++) await loadBucket(i, 6);

    expect(unloaded).toEqual([]);
    const after = tileset.getCacheStats();
    expect(after.evictions).toBe(0);
    expect(after.runwayEvictions).toBe(0);
    expect(after.tileCount).toBe(OVERVIEW_TILES + 8);
    expect(after.pinnedCount).toBe(OVERVIEW_TILES);

    tileset.finalize();
  });

  it('A1: the count gate composes with the byte gate (over-budget still wins on bytes)', async () => {
    // A count well under the allowance but a byte sum over the budget keeps
    // the incumbent rejection reason — the two gates are independent.
    const { tileset } = makeHarness({ maxCacheSize: 2000 });
    const result = await tileset.preloadOverviewTier({ budgetBytes: 1000 });
    expect(result.reason).toBe('over-budget');
    tileset.finalize();
  });

  it('flushPrefetch() and superseded-request cancellation leave pinned fetches alone', async () => {
    const { tileset, gated, loadBucket } = makeHarness({ gateBatches: true });

    const preload = tileset.preloadOverviewTier();
    await settle(); // overview batch issued and pending
    expect(gated).toHaveLength(1);
    const overviewBatch = gated[0];

    // A prefetch flush (e.g. a seek) must not abort the pinned-overview batch.
    tileset.flushPrefetch();
    expect(overviewBatch.signal?.aborted).toBe(false);

    // Nor may a viewport/time change cancel it as "superseded" (pinned tiles
    // are never in the viewport's needed set, but they're exempt).
    await loadBucket(3, 6);
    expect(overviewBatch.signal?.aborted).toBe(false);

    for (const b of gated.splice(0)) b.resolve();
    expect(await preload).toEqual({
      loaded: true,
      bytes: OVERVIEW_BYTES,
      tiles: OVERVIEW_TILES,
    });

    tileset.finalize();
  });

  it('getVisibleTiles() serves a pinned overview tile while primary tiles are missing', async () => {
    // best-available so the z5 viewport's parent-fallback chain (z5..z1)
    // reaches the pinned z1 tier; gated batches keep primary tiles pending.
    const { tileset, gated } = makeHarness({
      gateBatches: true,
      refinementStrategy: 'best-available',
    });

    const preload = tileset.preloadOverviewTier();
    await settle();
    for (const b of gated.splice(0)) b.resolve(); // overview tier lands
    expect((await preload).loaded).toBe(true);

    // Scrub to bucket 3 at z5: primary z5 (and z4..z2 parents) stay gated,
    // but the pinned z1 tile for bucket 3 is resident → it must render.
    tileset.update({
      bounds: BOUNDS,
      zoom: 5,
      time: 3 * BUCKET_MS + 500,
      timeWindow: 100,
    });
    await settle(5);
    const visible = tileset.getVisibleTiles();
    expect(visible.map((t) => key(t.id))).toContain('1/0/0/3000');

    tileset.finalize();
  });

  it('an oversized-parent rule only skips FETCHES — loaded overview tiles stay visible', async () => {
    // Every tile is "oversized" relative to a 10-byte parent cap, so the
    // old behaviour would have dropped the loaded z1 tile from the needed
    // set entirely (blanking the storyboard preview). The cap must only
    // prevent fetching parents, never hide resident ones.
    const { tileset, gated } = makeHarness({
      gateBatches: true,
      refinementStrategy: 'best-available',
      maxParentTileBytes: 10,
    });

    const preload = tileset.preloadOverviewTier();
    await settle();
    for (const b of gated.splice(0)) b.resolve();
    expect((await preload).loaded).toBe(true);

    tileset.update({
      bounds: BOUNDS,
      zoom: 5,
      time: 3 * BUCKET_MS + 500,
      timeWindow: 100,
    });
    await settle(5);
    const visible = tileset.getVisibleTiles();
    expect(visible.map((t) => key(t.id))).toContain('1/0/0/3000');

    tileset.finalize();
  });

  it('pinned overview tiles do NOT count toward primary-zoom readiness', async () => {
    const { tileset, loadBucket } = makeHarness();

    await tileset.preloadOverviewTier(); // z0 + z1 fully resident
    await loadBucket(0, 6); // exactly one PRIMARY (z6) bucket loaded

    // Build the coverage index for the z6 viewport.
    tileset.getBufferedRunway(0, 1);
    await settle();

    // Runway stops at bucket 1 — the resident z0/z1 storyboard above those
    // buckets is a preview tier, not primary coverage.
    const runway = tileset.getBufferedRunway(0, 1, 10_000);
    expect(runway.simMs).toBe(BUCKET_MS);
    expect(runway.complete).toBe(false);

    // estimateCost still charges for the missing PRIMARY tiles...
    expect(tileset.estimateCost({ start: 0, end: 2999 })).toEqual({
      bytes: bytesAt(1) + bytesAt(2),
      tiles: 2,
    });
    // ...and the buffered-ranges bar only shows the primary-loaded bucket.
    expect(tileset.getBufferedRanges()).toEqual([{ start: 0, end: BUCKET_MS }]);

    tileset.finalize();
  });
});

/**
 * A1, at the shape of the live defect (`scratchpad/pin-thrash-repro.mjs`,
 * tile-loading audit 2026-08 §2 A1): an hourly-bucket archive over years has
 * THOUSANDS of tiny z0–z1 tiles whose directory bytes fit the 20 MiB overview
 * budget. `earthquakes-v2` pinned 8 927 against a 2 000-tile cap, `hurricanes`
 * 17 899; both then ran permanently over `maxCacheSize` and evicted their
 * whole runway on every selection pass (11 105 runway evictions in 6 s of
 * playback on earthquakes-v2; 0 in the no-pin control).
 *
 * Synthetic mirror: a single-cell archive with more than 2 × maxCacheSize
 * coarse tiles over the time range, a z6 viewport, and 20 playback steps with
 * the prefetch runway on.
 */
describe('A1: the overview pin against a playback runway', () => {
  const MAX_CACHE = 400;
  /** 2 zooms × 450 buckets = 900 overview candidates > 2 × MAX_CACHE. */
  const THRASH_BUCKETS = 450;
  const thrashTiles = makeAvailableTiles(THRASH_BUCKETS);
  /** 1 sim-bucket per 100 real-ms. */
  const SPEED = BUCKET_MS / 100;

  function makeThrashHarness() {
    const unloaded: TileId[] = [];
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      maxCacheSize: MAX_CACHE,
      enablePrefetch: true,
      refinementStrategy: 'best-available',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles: async (b, z, r) => thrashTiles(b, z, r),
      // Tiny tiles: the byte gate passes (900 × 100 B), only COUNT can bind.
      getTileByteSize: () => 100,
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: async (ids: TileId[]) => ids.map(fakeTile),
      onTileUnload: (t) => unloaded.push(t.id),
    });
    return { tileset, unloaded };
  }

  /** 20 steps of 100 ms playback from bucket 0; returns the cache stats. */
  async function play(tileset: SpatioTemporalTileset) {
    tileset.setAnimationState(true, SPEED);
    let time = 500;
    tileset.update(
      { bounds: BOUNDS, zoom: 6, time, timeWindow: BUCKET_MS },
      true,
    );
    // Coverage tracking on: the tiered eviction (and `runwayEvictions`)
    // needs the index — the same call the repro script makes.
    tileset.getBufferedRunway(time, 1);
    await settle(60);
    for (let i = 0; i < 20; i++) {
      advanceClock(100);
      time += SPEED * 100;
      tileset.update(
        { bounds: BOUNDS, zoom: 6, time, timeWindow: BUCKET_MS },
        true,
      );
      await settle(25);
    }
    return tileset.getCacheStats();
  }

  it('rejects the pin over-count when the coarse tier is larger than the cache fraction', async () => {
    installClock();
    const { tileset } = makeThrashHarness();
    const result = await tileset.preloadOverviewTier();
    expect(result).toEqual({
      loaded: false,
      reason: 'over-count',
      bytes: 2 * THRASH_BUCKETS * 100,
      tiles: 2 * THRASH_BUCKETS,
    });
    expect(tileset.getCacheStats().tileCount).toBe(0);
    tileset.finalize();
  });

  it('a loaded pin (allowance raised) causes ZERO runway evictions over 20 playback steps', async () => {
    installClock();
    const { tileset, unloaded } = makeThrashHarness();
    const result = await tileset.preloadOverviewTier({
      maxTiles: 2 * THRASH_BUCKETS,
    });
    expect(result.loaded).toBe(true);
    expect(tileset.getCacheStats().pinnedCount).toBe(2 * THRASH_BUCKETS);

    const stats = await play(tileset);

    // The headline: pinned residency is additive to the cache budget, so the
    // runway (64 buckets × 1 tile ≪ 400) is never evicted underneath the
    // play head. Pre-fix: thousands of tier-C/D evictions and the pressure
    // ladder pinned at its 0.25 floor.
    expect(stats.runwayEvictions).toBe(0);
    expect(stats.evictions).toBe(0);
    expect(stats.prefetchPressureScale).toBe(1);
    expect(unloaded).toEqual([]);
    // ...and the pin itself is intact.
    expect(stats.pinnedCount).toBe(2 * THRASH_BUCKETS);

    tileset.finalize();
  });
});

/**
 * C4 (tile-loading audit 2026-08, CS-2): the byte gate priced DIRECTORY
 * bytes, but the coalescer fetches RANGES — 33× read amplification on
 * `goes-glm-lightning` (22.2 MB fetched to pin 0.64 MiB), dispatched at cold
 * start alongside the first viewport. When the archive can price its own
 * range plan (`estimateFetchBytes`, wired by `makeTilesetCallbacks`), the
 * gate is decided on that; the directory sum stays the fallback and is still
 * reported as `bytes`.
 */
describe('C4: the overview byte gate prices PLANNED range bytes when the archive can', () => {
  it('rejects over-budget on the range plan even though the directory sum fits', async () => {
    const planned = 30 * 1024 * 1024; // what the coalescer would really move
    const estimate = vi.fn((_ids: TileId[]) => planned);
    const { tileset, batchCalls } = makeHarness({
      maxCacheSize: 2000, // count gate inert: 40 ≤ 500
      estimateFetchBytes: estimate,
    });
    expect(OVERVIEW_BYTES).toBeLessThan(20 * 1024 * 1024); // the directory sum fits

    const result = await tileset.preloadOverviewTier();

    expect(result).toEqual({
      loaded: false,
      reason: 'over-budget',
      bytes: OVERVIEW_BYTES, // the directory sum is still reported...
      plannedBytes: planned, // ...next to the number the gate was decided on
      tiles: OVERVIEW_TILES,
    });
    expect(estimate).toHaveBeenCalledTimes(1);
    expect(estimate.mock.calls[0][0]).toHaveLength(OVERVIEW_TILES);
    expect(batchCalls).toHaveLength(0); // decided before a single fetch
    tileset.finalize();
  });

  it('loads on a range plan under budget and reports it alongside the directory sum', async () => {
    const { tileset } = makeHarness({
      maxCacheSize: 2000,
      estimateFetchBytes: () => 1024,
    });
    const result = await tileset.preloadOverviewTier();
    expect(result.loaded).toBe(true);
    expect(result.bytes).toBe(OVERVIEW_BYTES);
    expect(result.plannedBytes).toBe(1024);
    tileset.finalize();
  });

  it('falls back to the directory sum when no estimator is wired', async () => {
    const { tileset } = makeHarness({ maxCacheSize: 2000 });
    const result = await tileset.preloadOverviewTier({
      budgetBytes: OVERVIEW_BYTES - 1,
    });
    expect(result.reason).toBe('over-budget');
    expect(result.plannedBytes).toBeUndefined();
    tileset.finalize();
  });
});

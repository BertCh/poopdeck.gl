/**
 * Tests for the overview (storyboard) preview tier (player buffering WS-C4):
 * `preloadOverviewTier()` on SpatiotemporalTileset.
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
import { SpatiotemporalTileset } from '../src/spatiotemporal-tileset';
import type { SpatiotemporalTilesetOptions } from '../src/spatiotemporal-tileset';
import type { TileId, BoundingBox, Tile } from '../src/types';
import { BOUNDS, BUCKET_MS, fakeTile, makeAvailableTiles, settle } from './helpers/fixtures';

const N_BUCKETS = 20;
/** Directory byte length of the tile at bucket index `i` (any zoom). */
const bytesAt = (i: number): number => 100 * (i + 1);
/** Directory byte sum of one zoom level's tiles across all buckets. */
const ZOOM_LEVEL_BYTES = Array.from({ length: N_BUCKETS }, (_, i) => bytesAt(i)).reduce(
  (a, b) => a + b,
  0,
);
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

interface HarnessOptions extends Partial<SpatiotemporalTilesetOptions> {
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
  const tileset = new SpatiotemporalTileset({
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
    tileset.update({ bounds: BOUNDS, zoom, time: i * BUCKET_MS + 500, timeWindow: 100 });
    await settle(5);
  };
  return { tileset, batchCalls, gated, loaded, unloaded, loadBucket };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SpatiotemporalTileset.preloadOverviewTier', () => {
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

    expect(result).toEqual({ loaded: true, bytes: OVERVIEW_BYTES, tiles: OVERVIEW_TILES });
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
    expect(r1).toEqual({ loaded: true, bytes: OVERVIEW_BYTES, tiles: OVERVIEW_TILES });
    expect(r2).toEqual(r1);

    // ...and after it has loaded, too.
    const r3 = await tileset.preloadOverviewTier();
    expect(r3).toEqual(r1);
    expect(batchCalls).toHaveLength(1); // exactly one overview batch, ever

    tileset.finalize();
  });

  it('pinned tiles survive eviction pressure (over maxCacheSize) and warn once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 40 pinned tiles >> maxCacheSize 10 → every eviction pass runs the
    // over-limit LRU branch; only non-pinned tiles may go.
    const { tileset, unloaded, loadBucket } = makeHarness({ maxCacheSize: 10 });

    await tileset.preloadOverviewTier();
    // Pinned alone exceeds the cache limits → the one-shot warning fired.
    expect(warn).toHaveBeenCalledTimes(1);

    // Churn primary-zoom tiles through the cache to force eviction passes.
    for (let i = 0; i < 8; i++) await loadBucket(i, 6);

    // Some z6 churn was evicted; NO pinned overview tile (z ≤ 1) ever was.
    expect(unloaded.length).toBeGreaterThan(0);
    expect(unloaded.every((id) => id.z >= 6)).toBe(true);

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
    tileset.update({ bounds: BOUNDS, zoom: 5, time: 3 * BUCKET_MS + 500, timeWindow: 100 });
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

    tileset.update({ bounds: BOUNDS, zoom: 5, time: 3 * BUCKET_MS + 500, timeWindow: 100 });
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

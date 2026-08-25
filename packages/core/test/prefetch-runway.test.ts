/**
 * Tests for the cache-bounded, nearest-first prefetch runway.
 *
 * Before this, prefetchFutureTiles enqueued EVERY tile in the lookahead span,
 * and the span is sized in sim-time (speed × LOOKAHEAD). On a fast playback
 * (e.g. drifters: ~43 yr in 60 s) that is years / hundreds-of-buckets ahead —
 * far more than the LRU holds. The runway overflowed the cache, tiles were
 * evicted before the play head arrived, and the priority path then re-fetched
 * each one individually (byte-scattered ⇒ uncoalescable ⇒ a flood of tiny
 * single-tile requests).
 *
 * The fix bounds the per-pass prefetch enqueue to a fraction of the cache and
 * orders candidates by temporal distance from the play head, so a finite budget
 * always buys the most IMMINENT buckets and the runway stays resident.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import { estimateTileSize } from '../src/archive';
import {
  PrefetchPolicy,
  PREFETCH_CACHE_FRACTION,
  PREFETCH_COLD_BYTE_EXPANSION,
  PREFETCH_MIN_BUDGET_BYTES,
  PREFETCH_MIN_BYTE_EXPANSION,
} from '../src/prefetch-policy';
import type { Tile, TileId, BoundingBox } from '../src/types';
import {
  BOUNDS,
  BUCKET_MS,
  fakeTile,
  makeAvailableTiles,
  settle as settleMs,
} from './helpers/fixtures';
import { advanceClock, installClock } from './helpers/clock';

afterEach(() => {
  vi.restoreAllMocks();
});

const N_BUCKETS = 600;

/**
 * Synthetic single-cell archive: one tile per time bucket at the requested
 * zoom, returned when its [t, t+BUCKET] interval overlaps the query range.
 */
const availableTiles = makeAvailableTiles(N_BUCKETS);

describe('SpatioTemporalTileset prefetch runway', () => {
  it('caps the prefetch enqueue to a cache fraction and picks the nearest upcoming buckets', async () => {
    const batchSpy = vi.fn(async (batch: TileId[]) => batch.map(fakeTile));
    const singleSpy = vi.fn(async (id: TileId) => fakeTile(id));

    const maxCacheSize = 300; // => prefetch budget = floor(300 * 0.5) = 150
    const budget = 150;

    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      maxCacheSize,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: singleSpy,
      getTileDataBatch: batchSpy,
    });

    // Fast playback: a large animationSpeed makes the lookahead span ALL 600
    // future buckets, so without the budget the prefetch would enqueue ~599.
    tileset.setAnimationState(true, 1000);
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await new Promise((r) => setTimeout(r, 80));

    // Gather every distinct prefetched bucket. t === 0 is the current/priority
    // tile (served on the single path); everything t > 0 is prefetch.
    const prefetched = new Set<number>();
    for (const call of batchSpy.mock.calls) {
      for (const id of call[0] as TileId[]) if (id.t > 0) prefetched.add(id.t);
    }

    // BOUND: the runway never exceeds the cache-fraction budget, even though
    // ~599 future buckets were in range. Pre-fix this enqueued them all.
    expect(prefetched.size).toBeGreaterThan(0);
    expect(prefetched.size).toBeLessThanOrEqual(budget);

    // NEAREST-FIRST: the budget bought the imminent buckets, not a far slice.
    const maxT = Math.max(...prefetched);
    expect(maxT).toBeLessThanOrEqual(budget * BUCKET_MS);
    // The far end of the span was deliberately NOT prefetched.
    expect(prefetched.has((N_BUCKETS - 1) * BUCKET_MS)).toBe(false);

    tileset.finalize();
  });

  it('prefetches BACKWARD nearest-first when the play head reverses', async () => {
    const batchSpy = vi.fn(async (batch: TileId[]) => batch.map(fakeTile));

    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      maxCacheSize: 300, // budget 150
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: batchSpy,
    });

    // Commit a backward prefetch direction (needs DIRECTION_FLIP_THRESHOLD=3
    // consecutive backward frames), anchored near the end of the timeline.
    const start = (N_BUCKETS - 1) * BUCKET_MS;
    tileset.setAnimationState(true, 1000);
    tileset.update({
      bounds: BOUNDS,
      zoom: 6,
      time: start,
      timeWindow: BUCKET_MS,
    });
    for (let i = 1; i <= 4; i++) {
      tileset.update({
        bounds: BOUNDS,
        zoom: 6,
        time: start - i * BUCKET_MS,
        timeWindow: BUCKET_MS,
      });
    }
    await new Promise((r) => setTimeout(r, 80));

    expect(tileset.getPrefetchDirection()).toBe(-1);

    const prefetched = new Set<number>();
    for (const call of batchSpy.mock.calls) {
      for (const id of call[0] as TileId[]) prefetched.add(id.t);
    }
    // Backward runway: the EARLIEST bucket (t=0) must not be pulled before the
    // buckets just behind the head.
    expect(prefetched.has(0)).toBe(false);
    const minT = Math.min(...prefetched);
    expect(minT).toBeGreaterThanOrEqual(start - 200 * BUCKET_MS);

    tileset.finalize();
  });

  it('commits prefetch direction immediately from a signed speed (no hysteresis)', () => {
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      maxCacheSize: 300,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: async (batch: TileId[]) => batch.map(fakeTile),
    });

    // Default is forward.
    expect(tileset.getPrefetchDirection()).toBe(1);

    // A negative speed (a ping-pong controller reversing at a boundary) is an
    // authoritative signal: one call flips direction, no DIRECTION_FLIP_THRESHOLD
    // frames of observed backward deltas required.
    tileset.setAnimationState(true, -500);
    expect(tileset.getPrefetchDirection()).toBe(-1);

    // ...and back to forward, again in a single call.
    tileset.setAnimationState(true, 500);
    expect(tileset.getPrefetchDirection()).toBe(1);

    // A zero speed (pause) leaves the committed direction untouched.
    tileset.setAnimationState(false, 0);
    expect(tileset.getPrefetchDirection()).toBe(1);

    tileset.finalize();
  });
});

/**
 * BH-2 — the enqueue budget denominated in BYTES.
 *
 * The count budget prices every tile the same. Tiles are not the same: one
 * satellite tile is ~17 MB where one sparse leaf is ~5 KB, and the LRU's
 * binding constraint is `maxCacheByteSize`, not tile count. A runway that fits
 * the count budget can therefore still be several times the byte cache — it is
 * evicted before the play head arrives and re-fetched one uncoalescable tile at
 * a time, which is the exact thrash the budget exists to prevent (D3).
 *
 * The repair is ADDITIVE: both budgets are enforced, the pass stops at
 * whichever binds first, and the count budget survives as the guard for
 * byte-blind directories.
 */
describe('SpatioTemporalTileset byte-denominated enqueue budget', () => {
  const MIB = 1024 * 1024;

  /** Distinct future buckets the batch/single paths were asked to fetch. */
  function prefetchedBuckets(calls: unknown[][]): Set<number> {
    const out = new Set<number>();
    for (const call of calls) {
      for (const id of call[0] as TileId[]) if (id.t > 0) out.add(id.t);
    }
    return out;
  }

  it('stops at the BYTE budget on a heavy-tile stream, well short of the count budget', async () => {
    const batchSpy = vi.fn(async (batch: TileId[]) => batch.map(fakeTile));
    const anchorSpy = vi.spyOn(
      PrefetchPolicy.prototype,
      'anchorTruncatedRunway',
    );

    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      // Count budget = floor(300 × 0.5) = 150 tiles...
      maxCacheSize: 300,
      // ...byte budget = 0.5 × 64 MiB ÷ the cold 8× expansion = 4 MiB = FOUR
      // of these tiles. (Re-blessed from an 8 MiB cap, whose 512 KiB share
      // the old 4 MiB FLOOR lifted to the same four tiles — 32 MiB decoded
      // against 8; since G3-2 the floor yields to the cache, and that cap
      // honestly admits none beyond the head — pinned at the end of this
      // file.)
      maxCacheByteSize: 64 * MIB,
      getTileByteSize: () => 1 * MIB,
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: batchSpy,
    });

    tileset.setAnimationState(true, 1000); // horizon covers hundreds of buckets
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await settleMs(80);

    const prefetched = prefetchedBuckets(batchSpy.mock.calls);
    // FOUR tiles of runway — the byte budget, not the 150-tile count budget.
    // Since A2 the budget is a RESIDENCY bound inside the horizon: the play
    // head's own bucket-0 tile (fetched on the priority path, distance 0) is
    // charged first, so THREE further buckets are admitted. (Re-blessed from
    // four: the old count bounded admissions per pass, not what is held.)
    expect(prefetched.size).toBe(3);
    expect([...prefetched].sort((a, b) => a - b)).toEqual([
      1 * BUCKET_MS,
      2 * BUCKET_MS,
      3 * BUCKET_MS,
    ]);
    // The runway's byte sum — head tile included — respects the cache share
    // in the directory's currency (the cold expansion divides the cap).
    expect((prefetched.size + 1) * MIB).toBeLessThanOrEqual(
      (PREFETCH_CACHE_FRACTION * 64 * MIB) / PREFETCH_COLD_BYTE_EXPANSION,
    );

    // ...and the truncated pass re-anchored on the last COVERED bucket, so
    // the next pass re-plans at the real frontier rather than at a span
    // nobody fetched. (Nearest-first ordering ⇒ that is bucket 3.)
    expect(anchorSpy).toHaveBeenCalledTimes(1);
    expect(anchorSpy.mock.calls[0][1]).toBe(3 * BUCKET_MS);
    expect(anchorSpy.mock.calls[0][2]).toBe(BUCKET_MS);

    tileset.finalize();
  });

  it('still binds on the COUNT budget when the directory is byte-blind', async () => {
    const batchSpy = vi.fn(async (batch: TileId[]) => batch.map(fakeTile));

    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      // Count budget = 100 tiles; the default 2 GiB byte cache gives a 1 GiB
      // byte budget, i.e. ~16 384 tiles at the 64 KiB unknown-size fallback.
      maxCacheSize: 200,
      // NO getTileByteSize: the directory cannot size a tile.
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: batchSpy,
    });

    tileset.setAnimationState(true, 1000);
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await settleMs(80);

    const prefetched = prefetchedBuckets(batchSpy.mock.calls);
    expect(prefetched.size).toBeLessThanOrEqual(100);
    // > 64 is the load-bearing half: 64 × 64 KiB is exactly
    // PREFETCH_MIN_BUDGET_BYTES, so a runway deeper than that proves the
    // unknown-size fallback did NOT become the binding constraint and the
    // count guard is what stopped the pass.
    expect(prefetched.size).toBeGreaterThan(64);

    tileset.finalize();
  });

  /**
   * The simulation the item asks for: a 100×-byte-skewed archive whose
   * count-only runway does not fit the cache. The A/B arm is the documented
   * rollback — `enqueueBudgetBytes` returning Infinity restores count-only
   * behavior exactly — so the two arms differ in nothing else.
   *
   * The horizon here is SPEED-dominated (`effectiveAhead === gateFloor`), which
   * is precisely the case CO-2's feasibility solve declines: an infeasible
   * floor keeps the floor, because a horizon under it can never satisfy the
   * governor's speed-scaled gates. The solve therefore deliberately
   * over-commits and leaves the over-commit to be absorbed downstream — and
   * BH-2 is what bounds the bytes actually committed there.
   */
  it('bounds the runway under 100× byte skew where the count-only budget thrashes', async () => {
    /** 100× skew: even buckets 2 MiB, odd buckets 20 KiB. */
    const tileBytes = (id: TileId): number =>
      (id.t / BUCKET_MS) % 2 === 0 ? 2 * MIB : 20 * 1024;
    /** 40 tiles of cache; the count budget's own FLOOR is 64 (see below). */
    const MAX_TILES = 40;
    const BYTE_CACHE = 40 * MIB;

    interface Arm {
      runwayEvictions: number;
      runwayBytes: number;
      runwayTiles: number;
    }

    async function run(countOnly: boolean): Promise<Arm> {
      if (countOnly) {
        vi.spyOn(
          PrefetchPolicy.prototype,
          'enqueueBudgetBytes',
        ).mockReturnValue(Number.POSITIVE_INFINITY);
      }
      // PREFETCH-TIER dispatches only (fetchPriority 'low'), so the measured
      // runway is the speculative one and not the resident window.
      const runway = new Map<number, number>();
      const tileset = new SpatioTemporalTileset({
        minZoom: 0,
        maxZoom: 12,
        enablePrefetch: true,
        refinementStrategy: 'no-overlap',
        temporalBucketMs: BUCKET_MS,
        maxCacheSize: MAX_TILES,
        maxCacheByteSize: BYTE_CACHE, // byte budget = 20 MiB
        getTileByteSize: tileBytes,
        getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
        getTileData: async (id: TileId) => fakeTile(id),
        getTileDataBatch: async (
          ids: TileId[],
          _signal?: AbortSignal,
          hooks?: { fetchPriority?: string },
        ) => {
          if (hooks?.fetchPriority === 'low') {
            for (const id of ids) runway.set(id.t, tileBytes(id));
          }
          return ids.map(fakeTile);
        },
      });

      // Speed 20 sim-ms/real-ms ⇒ gateFloor = 20 × 5 000 = 100 000 ms and the
      // capped horizon lands exactly on it, so CO-2's solve returns its input
      // untouched and this test measures BH-2 alone. The animation BIT stays
      // off deliberately: `extendPrefetchIfDrained` slides the runway forward
      // with another pass as soon as the first drains, and the budget claim
      // under test is a PER-PASS one.
      tileset.setAnimationState(false, 20);
      tileset.update({ bounds: BOUNDS, zoom: 6, time: 500, timeWindow: 1000 });
      // Coverage tracking on — the tiered eviction (and therefore
      // runwayEvictions) needs the index.
      tileset.getBufferedRanges();
      await settleMs(150);

      // Snapshot ONE pass's runway before anything can slide it forward.
      let runwayBytes = 0;
      for (const bytes of runway.values()) runwayBytes += bytes;
      const runwayTiles = runway.size;

      // One more selection pass, now that the runway is RESIDENT: this is the
      // eviction sweep that decides whether the runway survived.
      tileset.update({ bounds: BOUNDS, zoom: 6, time: 501, timeWindow: 1000 });
      await settleMs(20);

      const stats = tileset.getCacheStats();
      tileset.finalize();
      return {
        runwayEvictions: stats.runwayEvictions,
        runwayBytes,
        runwayTiles,
      };
    }

    const byteBudgeted = await run(false);
    vi.restoreAllMocks();
    const countOnly = await run(true);

    // THE HEADLINE: the enqueued runway fits the cache fraction. `runwayBytes`
    // is COMPRESSED (it sums the same `getTileByteSize` the pass charges), so
    // the bound it is measured against has to be compressed too — the DECODED
    // cache fraction divided by the expansion. Expansion 1 is the kill-switch
    // value and therefore the LOOSEST budget the policy can return; the shipped
    // path divides further, never less.
    expect(byteBudgeted.runwayBytes).toBeLessThanOrEqual(
      (PREFETCH_CACHE_FRACTION * BYTE_CACHE) / PREFETCH_MIN_BYTE_EXPANSION,
    );
    // ...and in the cache's OWN unit: what those tiles will occupy once decoded
    // still fits the fraction. (`fakeTile` carries no buffers, so its decoded
    // footprint is the base overhead — the point here is that the assertion is
    // now made in the unit the LRU enforces, not that this fixture strains it.)
    expect(
      byteBudgeted.runwayTiles *
        estimateTileSize(fakeTile({ z: 6, x: 0, y: 0, t: 0 })),
    ).toBeLessThanOrEqual(PREFETCH_CACHE_FRACTION * BYTE_CACHE);
    // ...and the count-only arm blows straight past it on the same trace: its
    // budget is the 64-tile FLOOR, which here is both more tiles than the
    // cache holds and ~3× its bytes. Tiles are not fungible; counts pretend
    // they are.
    expect(countOnly.runwayBytes).toBeGreaterThan(
      PREFETCH_CACHE_FRACTION * BYTE_CACHE,
    );
    expect(countOnly.runwayTiles).toBeGreaterThan(byteBudgeted.runwayTiles);
    expect(countOnly.runwayTiles).toBeGreaterThan(MAX_TILES);

    // And the measurable the item names: the byte-budgeted runway is one
    // nothing had to evict, where the count-only one evicts its own
    // speculation the moment it lands.
    expect(byteBudgeted.runwayEvictions).toBe(0);
    expect(countOnly.runwayEvictions).toBeGreaterThan(0);
  });

  /**
   * F3 — the budget's numerator and denominator must be the same byte currency.
   *
   * `maxCacheByteSize` is a DECODED cap: the LRU enforces it against
   * `Σ header.byteSize`, and `byteSize = estimateTileSize(tile)` is the tile's
   * in-memory footprint. The only size a planning pass can know BEFORE fetching
   * is `getTileByteSize` — the directory's COMPRESSED `entry.length`. Charging
   * the second against the first over-admits the runway by exactly the
   * compression ratio, so the budget that exists to keep the runway RESIDENT
   * quietly admits several times what the cache can hold.
   *
   * The fixture makes the two currencies impossible to confuse: every tile is
   * 50 kB on the wire and 200 kB in memory, a 4× archive (real zstd-19 Arrow
   * payloads sit in this band). The two arms differ in ONE thing — the second
   * restores the pre-repair budget formula, which is the documented kill
   * switch — and the assertion is made in the unit the cache enforces.
   *
   * The runway is read from `anchorTruncatedRunway`'s honest frontier rather
   * than from dispatched batches, because dispatch is separately sliced: this
   * has to measure what the pass ENQUEUED, which is what the budget bounds.
   */
  it('charges the runway in the same byte currency the cache enforces', async () => {
    /** On the wire, from the directory. */
    const COMPRESSED = 50_000;
    /**
     * In memory, after decode. One SHARED payload buffer: `estimateTileSize`
     * dedupes per tile, not across tiles, so every tile prices at 200 kB while
     * the whole fixture allocates it once.
     */
    const PAYLOAD = new Uint8Array(199_000);
    const heavyTile = (id: TileId): Tile =>
      ({
        id,
        timeRange: { start: id.t, end: id.t + BUCKET_MS },
        layers: [{ arrowIpc: PAYLOAD }],
      }) as unknown as Tile;
    const DECODED = estimateTileSize(heavyTile({ z: 6, x: 0, y: 0, t: 0 }));
    // The fixture's own premise, pinned: a 4× archive.
    expect(DECODED).toBe(200_000);
    expect(DECODED / COMPRESSED).toBe(4);

    /** 40 MB of DECODED cache ⇒ the runway may occupy 20 MB of it. */
    const BYTE_CACHE = 40_000_000;
    const DECODED_BUDGET = PREFETCH_CACHE_FRACTION * BYTE_CACHE;
    /** Count budget = floor(600 × 0.5) = 300 tiles — deliberately generous. */
    const MAX_TILES = 600;

    /** Tiles the pass ENQUEUED: one tile per bucket, nearest-first. */
    async function admittedTiles(mixedCurrency: boolean): Promise<number> {
      const anchorSpy = vi.spyOn(
        PrefetchPolicy.prototype,
        'anchorTruncatedRunway',
      );
      if (mixedCurrency) {
        // The pre-repair formula, verbatim: the DECODED cap handed straight
        // back as a ceiling for COMPRESSED charges.
        vi.spyOn(
          PrefetchPolicy.prototype,
          'enqueueBudgetBytes',
        ).mockImplementation((maxCacheByteSize: number) =>
          Math.max(
            PREFETCH_MIN_BUDGET_BYTES,
            maxCacheByteSize * PREFETCH_CACHE_FRACTION,
          ),
        );
      }

      const tileset = new SpatioTemporalTileset({
        minZoom: 0,
        maxZoom: 12,
        enablePrefetch: true,
        refinementStrategy: 'no-overlap',
        temporalBucketMs: BUCKET_MS,
        maxCacheSize: MAX_TILES,
        maxCacheByteSize: BYTE_CACHE,
        getTileByteSize: () => COMPRESSED,
        getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
        getTileData: async (id: TileId) => heavyTile(id),
        getTileDataBatch: async (ids: TileId[]) => ids.map(heavyTile),
      });

      tileset.setAnimationState(true, 1000); // horizon covers every bucket
      tileset.update({
        bounds: BOUNDS,
        zoom: 6,
        time: 0,
        timeWindow: BUCKET_MS,
      });
      await settleMs(80);

      // Both arms truncate (that is the point), so the anchor always fires;
      // its `coveredAheadMs` is the furthest bucket enqueued, and this fixture
      // has exactly one tile per bucket starting at bucket 1.
      expect(anchorSpy).toHaveBeenCalled();
      const covered = anchorSpy.mock.calls[0][1] as number;
      tileset.finalize();
      return covered / BUCKET_MS;
    }

    const fixed = await admittedTiles(false);
    vi.restoreAllMocks();
    const mixed = await admittedTiles(true);

    // THE HEADLINE, stated in the unit `maxCacheByteSize` is written in: what
    // the pass admitted will fit the cache fraction once it is decoded.
    expect(fixed * DECODED).toBeLessThanOrEqual(DECODED_BUDGET);

    // ...and the mixed-currency arm — the shipped-before-F3 behavior — does
    // NOT. It admits 4× the directory bytes, which is 60 MB of decoded tiles
    // against a 40 MB cache: the runway is evicted before the play head
    // reaches it and re-fetched one uncoalescable tile at a time, which is the
    // exact thrash the budget exists to prevent.
    expect(mixed * DECODED).toBeGreaterThan(DECODED_BUDGET);
    expect(mixed * DECODED).toBeGreaterThan(BYTE_CACHE);
    expect(mixed).toBeGreaterThan(fixed);

    // The compressed side is respected too — the same pass, the same tiles,
    // measured with the instrument that priced them.
    expect(fixed * COMPRESSED).toBeLessThanOrEqual(
      DECODED_BUDGET / PREFETCH_MIN_BYTE_EXPANSION,
    );
    // Neither arm was stopped by the count budget in the fixed case: this is a
    // BYTE bound, not the tile-count guard wearing its clothes.
    expect(fixed).toBeLessThan(Math.floor(MAX_TILES * PREFETCH_CACHE_FRACTION));
  });

  /**
   * F3 — and the exchange rate is MEASURED, not assumed.
   *
   * A constant would be a guess about an archive nobody has seen. Every
   * resident tile has already been priced in BOTH currencies — the directory
   * gave its compressed `entry.length` before the fetch, `estimateTileSize`
   * gave the footprint the LRU charges it after the decode — so the rate is
   * observable. Until enough tiles are resident to observe it the budget uses
   * the conservative cold value, which under-admits rather than over-admits.
   */
  it('measures the decoded/compressed rate from resident tiles once it can', async () => {
    const COMPRESSED = 50_000;
    const PAYLOAD = new Uint8Array(199_000);
    const heavyTile = (id: TileId): Tile =>
      ({
        id,
        timeRange: { start: id.t, end: id.t + BUCKET_MS },
        layers: [{ arrowIpc: PAYLOAD }],
      }) as unknown as Tile;
    const TRUE_EXPANSION =
      estimateTileSize(heavyTile({ z: 6, x: 0, y: 0, t: 0 })) / COMPRESSED;
    expect(TRUE_EXPANSION).toBe(4);

    // BEFORE the tileset: PrefetchPolicy captures `Date.now` as its default
    // clock at construction, so a spy installed afterwards would never reach
    // the debounce this test has to step past.
    installClock();
    const budgetSpy = vi.spyOn(PrefetchPolicy.prototype, 'enqueueBudgetBytes');

    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      maxCacheSize: 600,
      // Roomy enough that nothing is evicted, so the sample the second pass
      // measures is the one the first pass loaded.
      maxCacheByteSize: 400_000_000,
      getTileByteSize: () => COMPRESSED,
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => heavyTile(id),
      getTileDataBatch: async (ids: TileId[]) => ids.map(heavyTile),
    });

    tileset.setAnimationState(true, 1000);
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await settleMs(120);

    // COLD: the very first pass has no tile priced both ways yet, so it uses
    // the documented conservative constant rather than inventing a rate.
    expect(budgetSpy).toHaveBeenCalled();
    expect(budgetSpy.mock.calls[0][1]).toBe(PREFETCH_COLD_BYTE_EXPANSION);

    // A later pass, now that the first one's tiles are resident. The play head
    // has to consume PREFETCH_RELOAD_FRACTION of the claimed runway before the
    // throttle releases another plan, hence the 70-bucket step.
    advanceClock(300); // beat the 250 ms prefetch debounce
    tileset.update({
      bounds: BOUNDS,
      zoom: 6,
      time: 70 * BUCKET_MS,
      timeWindow: BUCKET_MS,
    });
    await settleMs(400);

    // MEASURED: the rate now comes off the cache, and it is the fixture's real
    // 4× — not the cold 8×, and emphatically not the 1× that made the budget
    // over-admit by the compression ratio.
    const rates = budgetSpy.mock.calls.map((c) => c[1]);
    expect(rates.length).toBeGreaterThan(1);
    expect(rates.slice(1)).toEqual(rates.slice(1).map(() => TRUE_EXPANSION));

    tileset.finalize();
  });
});

/**
 * CO-2 — the prefetch horizon as a one-shot feasibility SOLVE rather than a
 * discovery.
 *
 * The AIMD pressure ladder only learns "the runway does not fit" after the
 * over-limit eviction pass has already reached into the protected playhead
 * window, i.e. after the fetch→evict→refetch thrash it exists to stop, and it
 * pays that price once per rung. The directory already knows every candidate
 * tile's compressed length, so the same question is answerable BEFORE a byte
 * moves — which is what `bytesForHorizon` + `byteBudget` let the policy do.
 *
 * The measured trap this suite is written against (measurements §10.2): a cache
 * policy can drive `runwayEvictions` to zero by simply FETCHING MORE, so that
 * counter alone is not evidence of anything. Both arms below therefore also
 * report bytes/requests issued and how many tiles had to be fetched twice.
 */
describe('SpatioTemporalTileset prefetch byte-feasibility solve', () => {
  /** Compressed directory size the archive reports for every tile. */
  const TILE_BYTES = 10_000;

  interface Session {
    runwayEvictions: number;
    /** Distinct tiles requested across the session. */
    distinct: number;
    /** Total tile-requests issued (≥ distinct; the excess is refetch). */
    requests: number;
    /** Tiles requested more than once — the refetch cycles. */
    refetched: number;
    /** Σ directory bytes over every request issued. */
    bytesFetched: number;
    /** Furthest prefetched bucket, i.e. the runway the pass actually claimed. */
    frontier: number;
    tileCount: number;
  }

  /**
   * One scripted playback session against a 600-bucket single-cell archive
   * whose runway (30 buckets) is far larger than the 20-tile cache.
   *
   * `byteCacheBytes` is the ONLY difference between the two arms: a small byte
   * cache gives the policy a budget it can solve against; the default 2 GiB one
   * makes the budget unreachable, so the solve is inert and the ladder is the
   * sole regulator. Everything else — the trace, the directory, the sizes, the
   * tile-count limit — is identical, which is what makes the comparison fair.
   */
  async function runSession(byteCacheBytes: number): Promise<Session> {
    const counts = new Map<string, number>();
    const record = (id: TileId): void => {
      const k = `${id.z}/${id.x}/${id.y}/${id.t}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    };
    const prefetched = new Set<number>();

    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      prefetchAhead: 30 * BUCKET_MS,
      prefetchSteps: 1,
      maxCacheSize: 20,
      maxCacheByteSize: byteCacheBytes,
      getTileByteSize: () => TILE_BYTES,
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => {
        record(id);
        return fakeTile(id);
      },
      getTileDataBatch: async (ids: TileId[]) => {
        for (const id of ids) {
          record(id);
          if (id.t > 0) prefetched.add(id.t);
        }
        return ids.map(fakeTile);
      },
    });

    installClock();
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 500, timeWindow: 100 });
    // Coverage tracking on: the tiered eviction needs the index, and so does
    // the byte oracle (it is only offered once the index is being maintained).
    tileset.getBufferedRanges();
    await settleMs(80);

    for (let i = 1; i <= 12; i++) {
      advanceClock(300); // beat the 250 ms prefetch debounce
      tileset.update({
        bounds: BOUNDS,
        zoom: 6,
        time: 500 + i,
        timeWindow: 100,
      });
      await settleMs(40);
    }

    const stats = tileset.getCacheStats();
    let requests = 0;
    let refetched = 0;
    for (const n of counts.values()) {
      requests += n;
      if (n > 1) refetched++;
    }
    tileset.finalize();
    return {
      runwayEvictions: stats.runwayEvictions,
      distinct: counts.size,
      requests,
      refetched,
      bytesFetched: requests * TILE_BYTES,
      frontier: prefetched.size > 0 ? Math.max(...prefetched) : 0,
      tileCount: stats.tileCount,
    };
  }

  it('holds runwayEvictions at 0 WITHOUT fetching more than the ladder', async () => {
    // Budget = 0.5 × 200 000 = 100 000 compressed bytes = 10 tiles of runway,
    // against an unsolved horizon of 30 buckets.
    const solved = await runSession(200_000);
    // 2 GiB: the budget is unreachable, the solve is inert, the ladder runs.
    const ladder = await runSession(2 * 1024 * 1024 * 1024);

    // The mechanism: the solved runway is bounded by the budget, the ladder's
    // is bounded only by what eviction takes back.
    expect(solved.frontier).toBeLessThan(ladder.frontier);
    expect(solved.tileCount).toBeLessThanOrEqual(20);

    // The headline metric.
    expect(solved.runwayEvictions).toBe(0);
    // The baseline pin: the same trace with the budget withheld DOES thrash.
    expect(ladder.runwayEvictions).toBeGreaterThan(0);

    // ...and the trap guard. A policy that zeroes the counter by fetching more
    // is a regression wearing a win's clothes, so the solve must also be no
    // worse on bytes and strictly better on refetch.
    expect(solved.bytesFetched).toBeLessThanOrEqual(ladder.bytesFetched);
    expect(solved.requests).toBeLessThanOrEqual(ladder.requests);
    expect(solved.refetched).toBe(0);
    expect(ladder.refetched).toBeGreaterThan(0);
  });
});

describe('SpatioTemporalTileset byte-aware parent-fallback skip', () => {
  it('skips oversized parent tiles but always loads the primary zoom and cheap parents', async () => {
    // A z14 street view: primary tile (9 KB) + a cheap z13 parent (300 KB) +
    // a GIANT z10 parent (14 MB) — the over-fetch the skip must drop.
    const primary: TileId = { z: 14, x: 100, y: 200, t: 0 };
    const cheapParent: TileId = { z: 13, x: 12, y: 25, t: 0 };
    const giantParent: TileId = { z: 10, x: 6, y: 12, t: 0 };

    const sizes = new Map<string, number>([
      ['14/100/200/0', 9_000],
      ['13/12/25/0', 300_000],
      ['10/6/12/0', 14_000_000],
    ]);
    const getTileByteSize = (id: TileId): number | undefined =>
      sizes.get(`${id.z}/${id.x}/${id.y}/${id.t}`);

    const avail = vi.fn(async (_b: BoundingBox, z: number) => {
      if (z === 14) return [primary];
      if (z === 13) return [cheapParent];
      if (z === 10) return [giantParent];
      return [];
    });

    const requested: TileId[] = [];
    const batchSpy = vi.fn(async (batch: TileId[]) => {
      requested.push(...batch);
      return batch.map(fakeTile);
    });
    const singleSpy = vi.fn(async (id: TileId) => {
      requested.push(id);
      return fakeTile(id);
    });

    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 14,
      enablePrefetch: false,
      maxParentTileBytes: 2_000_000,
      getAvailableTiles: avail,
      getTileByteSize,
      getTileData: singleSpy,
      getTileDataBatch: batchSpy,
    });

    tileset.update({ bounds: BOUNDS, zoom: 14, time: 0, timeWindow: 1000 });
    await new Promise((r) => setTimeout(r, 40));

    const reqKeys = new Set(
      requested.map((id) => `${id.z}/${id.x}/${id.y}/${id.t}`),
    );
    expect(reqKeys.has('14/100/200/0')).toBe(true); // primary always loads
    expect(reqKeys.has('13/12/25/0')).toBe(true); // cheap parent kept as fallback
    expect(reqKeys.has('10/6/12/0')).toBe(false); // giant parent skipped

    tileset.finalize();
  });

  /**
   * CO-6 — the flat 2 MiB cutoff becomes an expected-value rule.
   *
   * A coarse placeholder is worth fetching iff the time to download it is less
   * than the blank visible-cell-ms it averts:
   * `bytes(u)/θ̂ < λ · A(u) · min(Ê[coverMs], 10 s)`. A constant cutoff cannot
   * express either half of that — it never asks how much of the frame the tile
   * would cover, how long its children are still going to take, or how fast the
   * link is — so it is simultaneously too eager (a cheap parent whose children
   * are about to land) and too shy (a big parent that is the only thing standing
   * between the user and ten seconds of blank frame on a fast link).
   *
   * The estimator-cold path stays on the flat rule bit-for-bit, which is what
   * makes the change reversible in practice: a session that never measures
   * throughput behaves exactly as it did before.
   */
  describe('expected-value placeholder rule', () => {
    /** z12 parent of the z14 primary: 16 primary cells, all in a world view. */
    const PRIMARY: TileId = { z: 14, x: 100, y: 200, t: 0 };
    const PARENT: TileId = { z: 12, x: 25, y: 50, t: 0 };

    /**
     * One selection pass; returns the keys actually requested. `parentBytes` /
     * `childBytes` are what the directory reports, `bytesPerMs` what the
     * throughput estimator reports (`null` = cold).
     */
    async function requestedKeys(opts: {
      parentBytes: number;
      childBytes: number;
      bytesPerMs: number | null;
      placeholderPolicy?: 'expected-value' | 'flat';
    }): Promise<Set<string>> {
      const keys = new Set<string>();
      const tileset = new SpatioTemporalTileset({
        minZoom: 0,
        maxZoom: 14,
        enablePrefetch: false,
        maxParentTileBytes: 2 * 1024 * 1024,
        placeholderPolicy: opts.placeholderPolicy,
        getAvailableTiles: async (_b: BoundingBox, z: number) => {
          if (z === PRIMARY.z) return [PRIMARY];
          if (z === PARENT.z) return [PARENT];
          return [];
        },
        getTileByteSize: (id: TileId) =>
          id.z === PARENT.z
            ? opts.parentBytes
            : id.z === PRIMARY.z
              ? opts.childBytes
              : undefined,
        getThroughput: () => ({
          bytesPerMs: opts.bytesPerMs,
          samples: opts.bytesPerMs === null ? 0 : 5,
        }),
        getTileData: async (id: TileId) => {
          keys.add(`${id.z}/${id.x}/${id.y}/${id.t}`);
          return fakeTile(id);
        },
        getTileDataBatch: async (ids: TileId[]) => {
          for (const id of ids) keys.add(`${id.z}/${id.x}/${id.y}/${id.t}`);
          return ids.map(fakeTile);
        },
      });
      tileset.update({ bounds: BOUNDS, zoom: 14, time: 0, timeWindow: 1000 });
      await settleMs(40);
      tileset.finalize();
      return keys;
    }

    const PARENT_KEY = '12/25/50/0';
    const PRIMARY_KEY = '14/100/200/0';

    it('fetches a big parent on a fast link when the children are slow', async () => {
      // 4 MB parent, θ̂ = 20 KB/ms ⇒ it lands in 200 ms. Its 16 visible cells
      // hold 16 MB of missing detail ⇒ ~800 ms of blankness to avert. λ·A = 1,
      // so 200 < 800: buy it. The flat rule refuses on size alone.
      const keys = await requestedKeys({
        parentBytes: 4_000_000,
        childBytes: 1_000_000,
        bytesPerMs: 20_000,
      });
      expect(keys.has(PRIMARY_KEY)).toBe(true);
      expect(keys.has(PARENT_KEY)).toBe(true);
    });

    it('skips the SAME parent on a slow link', async () => {
      // Identical tile, identical children; θ̂ = 100 B/ms ⇒ 40 s to land. The
      // benefit term saturates at the 10 s value horizon while the cost does
      // not, so the verdict flips — a placeholder nobody will still be waiting
      // for is worth nothing, however blank the frame is.
      const keys = await requestedKeys({
        parentBytes: 4_000_000,
        childBytes: 1_000_000,
        bytesPerMs: 100,
      });
      expect(keys.has(PRIMARY_KEY)).toBe(true);
      expect(keys.has(PARENT_KEY)).toBe(false);
    });

    it('skips a CHEAP parent whose children are already nearly here', async () => {
      // 1 MB parent — comfortably under the flat 2 MiB cutoff, so the old rule
      // buys it — but its 16 cells are 1 KB each, i.e. ~0.8 ms of blankness.
      // Spending 50 ms of link time to avert 0.8 ms is the over-fetch the flat
      // rule cannot see.
      const keys = await requestedKeys({
        parentBytes: 1_000_000,
        childBytes: 1_000,
        bytesPerMs: 20_000,
      });
      expect(keys.has(PRIMARY_KEY)).toBe(true);
      expect(keys.has(PARENT_KEY)).toBe(false);
      // ...and the flat rule, on the very same inputs, does buy it.
      const flat = await requestedKeys({
        parentBytes: 1_000_000,
        childBytes: 1_000,
        bytesPerMs: 20_000,
        placeholderPolicy: 'flat',
      });
      expect(flat.has(PARENT_KEY)).toBe(true);
    });

    /**
     * C5 (tile-loading audit 2026-08, SEL-1). The rule fetches `u` iff
     * `P < A · C_missing / 16`, so for `A > 16` it admits a parent that
     * downloads SLOWER than every child it is placeholding — a placeholder
     * that lands after the detail is dropped unseen by pass 2, having spent
     * link time in the same priority batch as the children. Mirror of the
     * measured Zürich z14 pitched camera (`scratchpad/selproof/selection.test.ts`
     * Q3): a 10 × 10 z14 box, 10 KB primaries, parents 28 / 98 / 272 / 850 KB
     * at z13 / z12 / z11 / z10, a warm 4 MB/s link, children in flight.
     */
    it('C5: never buys a placeholder that would land AFTER the children it stands in for', async () => {
      const Z = 14;
      const X0 = 8574;
      const Y0 = 5748;
      const W = 10;
      const H = 10;
      const n = 1 << Z;
      const tile2lon = (x: number): number => (x / n) * 360 - 180;
      const tile2lat = (y: number): number => {
        const t = Math.PI - (2 * Math.PI * y) / n;
        return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t)));
      };
      const VIEW: BoundingBox = {
        minLon: tile2lon(X0) + 1e-6,
        maxLon: tile2lon(X0 + W) - 1e-6,
        minLat: tile2lat(Y0 + H) + 1e-6,
        maxLat: tile2lat(Y0) - 1e-6,
      };
      const SIZE: Record<number, number> = {
        14: 10_000,
        13: 28_000,
        12: 98_000,
        11: 272_000,
        10: 850_000,
      };
      const BYTES_PER_MS = 4000;
      /** Every tile at zoom `z` covering the 10 × 10 primary box. */
      function cellsIn(z: number): TileId[] {
        const d = Z - z;
        const out: TileId[] = [];
        const seen = new Set<string>();
        for (let x = X0; x < X0 + W; x++) {
          for (let y = Y0; y < Y0 + H; y++) {
            const id = { z, x: x >> d, y: y >> d, t: 0 };
            const k = `${id.z}/${id.x}/${id.y}`;
            if (!seen.has(k)) {
              seen.add(k);
              out.push(id);
            }
          }
        }
        return out;
      }
      /** Primary cells of the box under parent `u`. */
      const cellsUnder = (u: TileId): number => {
        const d = Z - u.z;
        let c = 0;
        for (let x = X0; x < X0 + W; x++)
          for (let y = Y0; y < Y0 + H; y++)
            if (x >> d === u.x && y >> d === u.y) c++;
        return c;
      };

      const batches: TileId[][] = [];
      const tileset = new SpatioTemporalTileset({
        minZoom: 6,
        maxZoom: 14,
        enablePrefetch: false,
        refinementStrategy: 'best-available',
        temporalBucketMs: 3_600_000,
        placeholderPolicy: 'expected-value',
        getAvailableTiles: async (_b: BoundingBox, z: number) => cellsIn(z),
        getTileByteSize: (id: TileId) => SIZE[id.z],
        getThroughput: () => ({ bytesPerMs: BYTES_PER_MS, samples: 10 }),
        // Everything stays in flight: every child counts as missing.
        getTileData: () => new Promise<Tile>(() => {}),
        getTileDataBatch: async (ids: TileId[]) => {
          batches.push(ids);
          return new Promise<Tile[]>(() => {});
        },
      });
      tileset.update({ bounds: VIEW, zoom: Z, time: 0, timeWindow: 20_000 });
      await settleMs(40);
      tileset.finalize();

      const requested = batches.flat();
      const primaries = requested.filter((id) => id.z === Z);
      const parents = requested.filter((id) => id.z < Z);
      expect(primaries).toHaveLength(W * H);
      expect(parents.length).toBeGreaterThan(0);

      // THE RULE: every admitted placeholder lands before its own missing
      // children would — `bytes(u)/θ < C_missing(u)/θ`, uncapped.
      for (const u of parents) {
        const arrivalMs = SIZE[u.z] / BYTES_PER_MS;
        const coverMs = (cellsUnder(u) * SIZE[Z]) / BYTES_PER_MS;
        expect(arrivalMs, `${u.z}/${u.x}/${u.y}`).toBeLessThan(coverMs);
      }
      // The z10 over the 80-cell block: 212 ms to arrive against 200 ms of
      // children — pre-fix the λ·A weighting (80/16 × 200 = 1 000 ms) bought
      // it, and it was the single largest tile in the batch.
      expect(parents.some((id) => id.z === 10)).toBe(false);
      // A z11 over 48 cells: 68 ms to arrive against 120 ms of children —
      // it lands first, so the expected-value rule still buys it. The
      // precondition prunes, it does not replace the weighting.
      expect(parents.some((id) => id.z === 11 && cellsUnder(id) === 48)).toBe(
        true,
      );
    });

    it('reproduces the flat rule bit-for-bit while the estimator is cold', async () => {
      // A scripted sweep across the flat cutoff. With no throughput sample the
      // expected-value rule cannot be priced, so every verdict must come back
      // identical to the flat rule's — including the ones where the two would
      // disagree once a sample lands.
      for (const parentBytes of [
        1_000,
        512 * 1024,
        2 * 1024 * 1024,
        2 * 1024 * 1024 + 1,
        14_000_000,
      ]) {
        for (const childBytes of [1_000, 1_000_000]) {
          const cold = await requestedKeys({
            parentBytes,
            childBytes,
            bytesPerMs: null,
          });
          const flat = await requestedKeys({
            parentBytes,
            childBytes,
            bytesPerMs: null,
            placeholderPolicy: 'flat',
          });
          expect([...cold].sort()).toEqual([...flat].sort());
          // And the flat verdict itself is unchanged: skip iff over the cutoff.
          expect(flat.has(PARENT_KEY)).toBe(parentBytes <= 2 * 1024 * 1024);
        }
      }
    });

    it('never skips the primary zoom, whatever the rule says', async () => {
      const keys = await requestedKeys({
        parentBytes: 4_000_000,
        childBytes: 500_000_000, // absurd primaries
        bytesPerMs: 100,
      });
      expect(keys.has(PRIMARY_KEY)).toBe(true);
    });
  });

  it('loads oversized PRIMARY-zoom tiles (the skip only applies to parents)', async () => {
    // Even a 14 MB tile is loaded when it IS the display zoom — we never refuse
    // to draw what the user is looking at.
    const primary: TileId = { z: 14, x: 1, y: 1, t: 0 };
    const getTileByteSize = (id: TileId): number | undefined =>
      id.z === 14 ? 14_000_000 : undefined;
    const requested: TileId[] = [];

    const tileset = new SpatioTemporalTileset({
      minZoom: 14,
      maxZoom: 14, // no parents exist
      enablePrefetch: false,
      maxParentTileBytes: 2_000_000,
      getAvailableTiles: async (_b, z) => (z === 14 ? [primary] : []),
      getTileByteSize,
      getTileData: async (id: TileId) => {
        requested.push(id);
        return fakeTile(id);
      },
    });

    tileset.update({ bounds: BOUNDS, zoom: 14, time: 0, timeWindow: 1000 });
    await new Promise((r) => setTimeout(r, 30));

    expect(requested.map((id) => `${id.z}/${id.x}/${id.y}/${id.t}`)).toContain(
      '14/1/1/0',
    );
    tileset.finalize();
  });
});

/**
 * CO-7: the prefetch runway warms the PRIMARY zoom only.
 *
 * A coarse parent is a PLACEHOLDER — it covers the screen while the detail
 * tiles for the CURRENT play head are in flight. The runway is by construction
 * about buckets the head has not reached, where nothing is blank and the
 * primary-zoom tiles for that bucket are being warmed by the same pass. So a
 * parent fetched on the prefetch path stands in for a blankness that never
 * happens, while being charged against the same byte budget as the tiles it
 * would have covered.
 *
 * Measured on the live `flights` demo (camera z4, archive z0-10,
 * PARENT_FALLBACK_LEVELS = 4): 35.1 MB of 52.3 MB of prefetch-tier traffic
 * (67%) was z0-z3 ancestors, on a link that was the binding constraint.
 *
 * `shouldSkipParentFetch` cannot catch it: the expected-value rule prices a
 * parent against the ETA of its still-MISSING children, and at a future bucket
 * every child is missing — so the further ahead the runway looks, the more
 * attractive a parent appears.
 */
describe('SpatioTemporalTileset prefetch zoom fan-out', () => {
  /** Every prefetched (t > 0) tile's zoom, for one settled prefetch pass. */
  async function prefetchedZooms(
    lodMode: 'additive' | 'parent-fallback',
  ): Promise<Set<number>> {
    const batchSpy = vi.fn(async (batch: TileId[]) => batch.map(fakeTile));
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      maxCacheSize: 300,
      enablePrefetch: true,
      // The mode that walks parents at all — 'no-overlap' would make the
      // assertion vacuous.
      refinementStrategy: 'best-available',
      lodMode,
      // Echoes back whatever zoom is asked for, so a parent request is visible.
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: batchSpy,
    });

    tileset.setAnimationState(true, 1000);
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await settleMs(80);

    const zooms = new Set<number>();
    for (const call of batchSpy.mock.calls) {
      for (const id of call[0] as TileId[]) if (id.t > 0) zooms.add(id.z);
    }
    tileset.finalize();
    return zooms;
  }

  it('prefetches ONLY the primary zoom under parent-fallback LOD', async () => {
    const zooms = await prefetchedZooms('parent-fallback');

    // The runway ran at all...
    expect(zooms.size).toBeGreaterThan(0);
    // ...and bought nothing but the zoom actually being drawn. Pre-CO-7 this
    // also contained 5, 4, 3 and 2 (PARENT_FALLBACK_LEVELS = 4).
    expect([...zooms].sort((a, b) => a - b)).toEqual([6]);
  });

  it('still prefetches the full coarse union under additive LOD', async () => {
    const zooms = await prefetchedZooms('additive');

    // Additive LOD is EXEMPT: each point lives at exactly one home zoom, so the
    // coarse levels are distinct DATA that is kept resident and drawn — not
    // throwaway placeholders. Warming the union is the point of the mode.
    expect(zooms.has(6)).toBe(true);
    expect([...zooms].some((z) => z < 6)).toBe(true);
  });
});

/**
 * A2 (tile-loading audit 2026-08, PR-1 / CE-2): at fast playback the horizon
 * is the speed-scaled gate floor (`speed × 5 s`), the per-pass budget used to
 * bound ADMISSIONS rather than residency, and the pass re-ran as soon as its
 * slice drained — so residency converged on the whole horizon, the over-limit
 * pass evicted tier C (the far edge just fetched), and the next pass saw
 * `header === undefined` and bought it again. Ported from
 * `scratchpad/proof-runway-a2.mts` (experiment A): 5 tiles per bucket, a
 * 400-tile cache (= 80 buckets), speed 40 sim-ms/real-ms so `speed × 5 s` is
 * 200 buckets > 64 and the horizon addresses 1 000 tiles. Pre-fix: 515 ids
 * fetched twice, 555 runway evictions, pressure pinned at 0.25.
 */
describe('A2: the prefetch budget bounds RESIDENCY within the horizon', () => {
  const TILES_PER_BUCKET = 5;
  const N = 6000;
  const SPEED = 40;
  const MAX_CACHE = 400;

  const available = (
    _b: BoundingBox,
    z: number,
    r: { start: number; end: number },
  ): TileId[] => {
    const ids: TileId[] = [];
    const first = Math.max(0, Math.floor(r.start / BUCKET_MS));
    const last = Math.min(N - 1, Math.floor(r.end / BUCKET_MS));
    for (let i = first; i <= last; i++) {
      const t = i * BUCKET_MS;
      if (t + BUCKET_MS >= r.start && t <= r.end) {
        for (let x = 0; x < TILES_PER_BUCKET; x++) ids.push({ z, x, y: 0, t });
      }
    }
    return ids;
  };

  it('never refetches a tile nor evicts the runway when horizon × tiles/bucket exceeds the cache', async () => {
    installClock();
    // The regime the finding is about, asserted rather than assumed.
    expect(SPEED * 5000).toBeGreaterThan(64 * BUCKET_MS);
    expect((SPEED * 5000 * TILES_PER_BUCKET) / BUCKET_MS).toBeGreaterThan(
      MAX_CACHE,
    );

    const counts = new Map<string, number>();
    const record = (id: TileId): void => {
      const k = `${id.z}/${id.x}/${id.y}/${id.t}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    };
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      temporalBucketMs: BUCKET_MS,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      prefetchAhead: BUCKET_MS,
      prefetchSteps: 4,
      maxCacheSize: MAX_CACHE,
      maxCacheByteSize: 2 * 1024 ** 3,
      getTileByteSize: () => 5000,
      getAvailableTiles: async (b, z, r) => available(b, z, r),
      getTileData: async (id: TileId) => {
        record(id);
        return fakeTile(id);
      },
      getTileDataBatch: async (ids: TileId[]) => {
        for (const id of ids) record(id);
        return ids.map(fakeTile);
      },
    });

    let time = 500;
    tileset.setAnimationState(true, SPEED);
    tileset.update({ bounds: BOUNDS, zoom: 6, time, timeWindow: BUCKET_MS });
    // Coverage tracking on: the tiered eviction, `runwayEvictions` and the
    // CO-2 oracle all read the index — the same call the proof script makes.
    tileset.getBufferedRunway(time, 1);
    await settleMs(60);
    for (let i = 0; i < 80; i++) {
      advanceClock(100);
      time += SPEED * 100;
      tileset.update(
        { bounds: BOUNDS, zoom: 6, time, timeWindow: BUCKET_MS },
        true,
      );
      await settleMs(30);
    }

    let refetched = 0;
    for (const n of counts.values()) if (n > 1) refetched++;
    const st = tileset.getCacheStats();
    // The runway ran: the head consumed 320 buckets and everything it drew
    // came from a fetch that happened exactly once.
    expect(counts.size).toBeGreaterThan(MAX_CACHE);
    expect(refetched).toBe(0);
    expect(st.refetches).toBe(0); // the tileset's own churn counter (G2) agrees
    expect(st.runwayEvictions).toBe(0);
    expect(st.prefetchPressureScale).toBe(1);
    // ...and the cache itself never ran away. `tileCount` counts HEADERS —
    // loaded tiles plus the queued/in-flight runway (≤ the 200-tile budget)
    // plus whatever a coalesced trim has not yet reclaimed — so the honest
    // bound is the cache cap plus one runway budget. Pre-fix this climbed
    // without bound while the far edge was bought back over and over.
    expect(st.tileCount).toBeLessThanOrEqual(MAX_CACHE + MAX_CACHE / 2 + 20);

    tileset.finalize();
  });
});

// ─── Tile-loading audit 2026-08: G3-2 (the byte budget yields to the cache)

describe('G3-2: the byte budget yields to the cache', () => {
  const MIB = 1024 * 1024;

  it('admits NO speculative tile on a cold pass whose head tile already prices at the whole cache share', async () => {
    const batchSpy = vi.fn(async (batch: TileId[]) => batch.map(fakeTile));
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      maxCacheSize: 300,
      // ½ × 8 MiB ÷ the cold 8× expansion = 512 KiB of compressed runway;
      // one 1 MiB tile is 8 MiB decoded at that price — the whole cache. The
      // old 4 MiB floor lifted this to FOUR such tiles (32 MiB decoded
      // against an 8 MiB cap), which were evicted before the head arrived
      // and bought back. Zero is the honest answer until the measured
      // expansion (four resident tiles priced both ways) says otherwise.
      maxCacheByteSize: 8 * MIB,
      getTileByteSize: () => 1 * MIB,
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: batchSpy,
    });
    tileset.setAnimationState(true, 1000);
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await settleMs(80);

    const future = new Set<number>();
    let headFetched = false;
    for (const call of batchSpy.mock.calls) {
      for (const id of call[0] as TileId[]) {
        if (id.t > 0) future.add(id.t);
        else headFetched = true;
      }
    }
    expect(future.size).toBe(0);
    // The play head's own data still loads: the budget bounds speculation,
    // never the resident window.
    expect(headFetched).toBe(true);
    tileset.finalize();
  });
});

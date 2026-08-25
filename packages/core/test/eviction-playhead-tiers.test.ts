/**
 * Playhead-relative tiered over-limit eviction.
 *
 * Under memory pressure the old over-limit branch was plain LRU — which
 * reclaims exactly the prefetched runway ahead of the playhead (prefetched =
 * least-recently *touched*), only for the priority path to re-fetch the same
 * bytes seconds later: the multi-dataset "flashing tiles" thrash. The tiered
 * policy trims like a media player instead:
 *
 *   A. non-coverage tiles (stale viewports/zooms) — LRU (today's behavior
 *      restricted to non-runway tiles);
 *   B. coverage tiles far BEHIND the playhead — furthest-behind first;
 *   C. coverage tiles far AHEAD — furthest-ahead first (distant speculation
 *      before imminent future);
 *   D. last resort: the near-playhead protected window — LRU (the hard cap
 *      must still hold).
 *
 * Tier C/D evictions count in `runwayEvictions` and decay
 * `prefetchPressureScale` (degrade the horizon instead of thrashing); with no
 * coverage index the branch falls back to the original LRU, unchanged.
 *
 * P0-2 adds the per-tier ATTRIBUTION on top (observation only — the plan
 * order and the runway boundary above are untouched): `evictionsByTier` /
 * `bytesEvicted` on the existing cacheStats object, and one `evict` probe
 * sample per evicted tile carrying the tier that freed its bytes.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  SpatioTemporalTileset,
  setEvictionByteDensityBands,
} from '../src/spatiotemporal-tileset';
import type { Tile, TileId, BoundingBox } from '../src/types';
import type { EvictProbeSample } from '../src/telemetry';
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

/** West → x=0, east → x=1, so east tiles fall out of the west coverage index. */
const availableTiles = makeAvailableTiles(N_BUCKETS, (b) =>
  b.maxLon <= 0 ? 0 : 1,
);

const settle = (ms = 10): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** "x:bucketIndex" label for a tile id — the assertion currency below. */
const label = (id: TileId): string => `${id.x}:${id.t / BUCKET_MS}`;

function makeTileset(unloads: string[]): SpatioTemporalTileset {
  return new SpatioTemporalTileset({
    minZoom: 0,
    maxZoom: 12,
    enablePrefetch: false,
    refinementStrategy: 'no-overlap',
    temporalBucketMs: BUCKET_MS,
    getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
    getTileData: async (id: TileId) => fakeTile(id),
    getTileDataBatch: async (ids: TileId[]) => ids.map(fakeTile),
    onTileUnload: (tile: Tile) => unloads.push(label(tile.id)),
  });
}

const loadBucket = async (
  tileset: SpatioTemporalTileset,
  bounds: BoundingBox,
  i: number,
  // A 1 ms nudge defeats the identical-params selection fast-path (see the
  // eviction-buffered-timeline suite).
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
  tileset: SpatioTemporalTileset,
): Promise<void> => {
  tileset.getBufferedRanges();
  await settle();
};

/**
 * The shared fixture: 10 loaded tiles around a playhead at bucket 30 (west
 * viewport, forward direction, timeWindow 100 « BUCKET_MS 1000):
 *   - east 0, east 5 → tier A (not in the west coverage index), LRU e0 < e5;
 *   - west 26, 27   → tier B (behind by > keepBehind=1000), furthest first;
 *   - west 40, 50   → tier C (ahead by > protectedAhead=2000), furthest first;
 *   - west 29,31,32 → tier D (near-playhead protected window), LRU order;
 *   - west 30       → the NEEDED tile (never a candidate).
 * lastUsed strictly increases in load order (the clock advances 1 s per load).
 */
async function buildFixture(
  unloads: string[],
  { coverage = true } = {},
): Promise<SpatioTemporalTileset> {
  const tileset = makeTileset(unloads);
  for (const [bounds, i] of [
    [EAST, 0],
    [EAST, 5],
    [WEST, 26],
    [WEST, 27],
    [WEST, 29],
    [WEST, 31],
    [WEST, 32],
    [WEST, 40],
    [WEST, 50],
    [WEST, 30],
  ] as Array<[BoundingBox, number]>) {
    await loadBucket(tileset, bounds, i);
    if (coverage && bounds === WEST && i === 26) {
      await enableBufferTracking(tileset); // west index: x=0, all buckets
    }
    advanceClock(1000);
  }
  expect(tileset.getCacheStats().tileCount).toBe(10);
  return tileset;
}

/** Tighten the cache limit and run one eviction pass at the bucket-30 playhead. */
async function evictAt(
  tileset: SpatioTemporalTileset,
  unloads: string[],
  maxCacheSize: number,
  nudge: number,
): Promise<void> {
  tileset.options.maxCacheSize = maxCacheSize;
  unloads.length = 0;
  await loadBucket(tileset, WEST, 30, nudge);
}

/** {@link evictAt} with the playhead bucket chosen by the caller. */
async function evictAtBucket(
  tileset: SpatioTemporalTileset,
  unloads: string[],
  maxCacheSize: number,
  bucket: number,
  nudge: number,
): Promise<void> {
  tileset.options.maxCacheSize = maxCacheSize;
  unloads.length = 0;
  await loadBucket(tileset, WEST, bucket, nudge);
}

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The probe bag, installed only for the attribution suite below. `'x:bucket'`
 * labels are recovered from the sample key (`z/x/y/t`) so the assertions read
 * in the same currency as the `unloads` log.
 */
interface ProbeBag {
  enabled?: boolean;
  evict?: EvictProbeSample[];
  [k: string]: unknown;
}
function setBag(bag: ProbeBag | undefined): void {
  if (bag === undefined) {
    delete (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
  } else {
    (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe = bag;
  }
}
function evictSamples(): EvictProbeSample[] {
  return (
    (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe?.evict ?? []
  );
}
/** `z/x/y/t...` → the `x:bucketIndex` label used by the `unloads` assertions. */
function sampleLabel(sample: EvictProbeSample): string {
  const [, x, , t] = sample.key.split('/');
  return `${x}:${Number.parseInt(t, 10) / BUCKET_MS}`;
}

describe('SpatioTemporalTileset playhead-relative over-limit eviction', () => {
  it('evicts tier A first (LRU), leaving every coverage tile resident', async () => {
    installClock();
    const unloads: string[] = [];
    const tileset = await buildFixture(unloads);

    await evictAt(tileset, unloads, 9, 1); // over by 1
    expect(unloads).toEqual(['1:0']); // oldest non-coverage tile only
    expect(tileset.getCacheStats().tileCount).toBe(9);
    expect(tileset.getCacheStats().runwayEvictions).toBe(0);
    expect(tileset.getCacheStats().prefetchPressureScale).toBe(1);

    tileset.finalize();
  });

  it('walks A → B → C and the near-playhead window survives when they suffice', async () => {
    installClock();
    const unloads: string[] = [];
    const tileset = await buildFixture(unloads);

    await evictAt(tileset, unloads, 4, 1); // over by 6 = |A| + |B| + |C|
    // A (LRU), then B (furthest behind first), then C (furthest ahead first).
    expect(unloads).toEqual(['1:0', '1:5', '0:26', '0:27', '0:50', '0:40']);
    // Survivors: the protected window (29, 31, 32) + the needed tile (30).
    expect(tileset.getCacheStats().tileCount).toBe(4);
    // Only tier C counts as runway evictions here.
    expect(tileset.getCacheStats().runwayEvictions).toBe(2);
    // A tier-C eviction is the thrash signal: the horizon scale decays.
    expect(tileset.getCacheStats().prefetchPressureScale).toBeCloseTo(0.7, 10);

    tileset.finalize();
  });

  it('tier D still fires as the last resort so the hard cap holds', async () => {
    installClock();
    const unloads: string[] = [];
    const tileset = await buildFixture(unloads);

    await evictAt(tileset, unloads, 2, 1); // over by 8: A+B+C don't suffice
    expect(unloads).toEqual([
      '1:0',
      '1:5',
      '0:26',
      '0:27',
      '0:50',
      '0:40',
      '0:29', // tier D, LRU order
      '0:31',
    ]);
    // Survivors: the most-recently-used near tile + the needed tile.
    expect(tileset.getCacheStats().tileCount).toBe(2);
    // runwayEvictions counts C + D only (2 + 2), never A/B.
    expect(tileset.getCacheStats().runwayEvictions).toBe(4);

    tileset.finalize();
  });

  it('falls back to the original LRU when no coverage index exists', async () => {
    installClock();
    const unloads: string[] = [];
    const tileset = await buildFixture(unloads, { coverage: false });

    await evictAt(tileset, unloads, 4, 1);
    // Pure lastUsed order — near-playhead tiles (29, 31) go before the far
    // speculation (40, 50), exactly the pre-fix behavior.
    expect(unloads).toEqual(['1:0', '1:5', '0:26', '0:27', '0:29', '0:31']);
    expect(tileset.getCacheStats().runwayEvictions).toBe(0);
    expect(tileset.getCacheStats().prefetchPressureScale).toBe(1);

    tileset.finalize();
  });

  it('runs the pressure ladder down to its 0.25 floor under repeated runway evictions', async () => {
    installClock();
    const unloads: string[] = [];
    const tileset = makeTileset(unloads);

    // 16 far-ahead coverage tiles (buckets 40..55) + the needed bucket 30.
    for (let i = 40; i <= 55; i++) {
      await loadBucket(tileset, WEST, i);
      if (i === 40) await enableBufferTracking(tileset);
      advanceClock(1000);
    }
    await loadBucket(tileset, WEST, 30);
    expect(tileset.getCacheStats().tileCount).toBe(17);

    // Each tightening forces another pass into tier C: 0.7^n, clamped at 0.25.
    const expected: Array<[number, number]> = [
      [12, 0.7],
      [8, 0.49],
      [5, 0.343],
      [3, 0.25], // 0.343 × 0.7 = 0.2401 → floor
      [2, 0.25], // floor holds
    ];
    let nudge = 1;
    let evicted = 0;
    for (const [limit, scale] of expected) {
      await evictAt(tileset, unloads, limit, nudge++);
      evicted += unloads.length;
      expect(tileset.getCacheStats().prefetchPressureScale).toBeCloseTo(
        scale,
        10,
      );
    }
    // Every eviction reached into the runway (all candidates were tier C).
    expect(evicted).toBe(15);
    expect(tileset.getCacheStats().runwayEvictions).toBe(15);
    expect(tileset.getCacheStats().tileCount).toBe(2); // bucket 40 + needed 30

    tileset.finalize();
  });
});

/**
 * BH-7a — loop-aware eviction rotation.
 *
 * Under a declared loop, "behind the playhead" stops meaning "done with". A
 * tile just past the loop START, seen from a head near the loop END, is the
 * most imminent thing in the cache — and the incumbent tiering, which orders
 * tier B furthest-behind-FIRST, evicts exactly that one first. That is the
 * exact inverse of Belady across the wrap, and it re-fetches the loop-start
 * working set on every lap.
 *
 * With a loop declared, distances are measured modulo the loop span:
 *   aheadMod = ((d × (t − playhead)) mod span + span) mod span
 * and the classification runs on that. With NO loop declared the tier
 * classification and the tier metrics are the incumbent one-directional ones,
 * tile for tile — rotation is an addition activated only by a declared loop,
 * never a replacement, which is the compliance argument for the pinned B→C→D
 * register entry. That is what the regression pin below asserts, and it is
 * ALL it asserts: BH-7's other half (the within-tier byte-density band sort)
 * is unconditional by design and is pinned separately, with its own kill
 * switch, in the byte-density suite further down. "No loop ⇒ the whole
 * eviction plan is byte-identical to today" would be false, so it is not
 * claimed anywhere here.
 */
describe('BH-7 loop-aware eviction rotation', () => {
  /**
   * Seven consecutive buckets 26..32 in the west viewport, playhead at 32 —
   * i.e. hard against the end of a loop that starts at 26. Every tile is
   * "behind" the head in one-directional terms; under rotation the ones
   * nearest the loop start are the ones about to be needed.
   *
   * ONE tile per bucket, so every candidate lands in its own distance band
   * and the BH-7b byte tiebreak is structurally inert here. That is deliberate
   * — this suite isolates the ROTATION half. The band sort gets its own
   * multi-tile-per-band fixture in the byte-density suite below; do not read
   * the pins here as statements about it.
   */
  async function buildLoopFixture(
    unloads: string[],
  ): Promise<SpatioTemporalTileset> {
    const tileset = makeTileset(unloads);
    for (const i of [26, 27, 28, 29, 30, 31, 32]) {
      await loadBucket(tileset, WEST, i);
      if (i === 26) await enableBufferTracking(tileset);
      advanceClock(1000);
    }
    expect(tileset.getCacheStats().tileCount).toBe(7);
    return tileset;
  }

  /** The loop the fixture is anchored in: buckets 26..33, span 7 000 ms. */
  const LOOP = { start: 26 * BUCKET_MS, end: 33 * BUCKET_MS };

  it('protects the tiles just past the loop start and evicts the just-passed ones', async () => {
    installClock();
    const unloads: string[] = [];
    const tileset = await buildLoopFixture(unloads);
    tileset.setLoopWindow(LOOP);

    // Over by 3 (7 tiles, 1 needed, cap 4).
    await evictAtBucket(tileset, unloads, 4, 32, 1);

    // Belady on the WRAPPED metric. Playhead 32 501, span 7 000:
    //   30 → aheadMod 4 499 (needed last)   → tier B, evicted first
    //   29 → aheadMod 3 499                 → tier C
    //   28 → aheadMod 2 499                 → tier C
    //   27 → aheadMod 1 499 ≤ protectedAhead → tier D (protected)
    //   26 → aheadMod   499 ≤ protectedAhead → tier D (protected)
    //   31 → behindMod  501 ≤ keepBehind     → tier D (back-buffer)
    expect(unloads).toEqual(['0:30', '0:29', '0:28']);
    // The two tiles the incumbent rule would have thrown away first are the
    // two that survive.
    expect(tileset.getCacheStats().tileCount).toBe(4);

    tileset.finalize();
  });

  it('leaves the tiering un-rotated when NO loop is declared (rotation regression pin)', async () => {
    installClock();
    const unloads: string[] = [];
    const tileset = await buildLoopFixture(unloads);

    await evictAtBucket(tileset, unloads, 4, 32, 1);

    // Incumbent tiering: everything is tier B (behind by > keepBehind),
    // furthest-behind first — the exact inverse of the rotated order above.
    expect(unloads).toEqual(['0:26', '0:27', '0:28']);
    // ...and none of it counts as reaching into the runway.
    expect(tileset.getCacheStats().runwayEvictions).toBe(0);
    expect(tileset.getCacheStats().prefetchPressureScale).toBe(1);

    tileset.finalize();
  });

  it('setLoopWindow(null) — and a degenerate range — restore the un-rotated plan exactly', async () => {
    installClock();
    for (const range of [
      null,
      { start: 33 * BUCKET_MS, end: 26 * BUCKET_MS }, // end <= start
      { start: 26 * BUCKET_MS, end: 26 * BUCKET_MS }, // empty
      { start: Number.NaN, end: 33 * BUCKET_MS }, // non-finite
    ]) {
      const unloads: string[] = [];
      const tileset = await buildLoopFixture(unloads);
      tileset.setLoopWindow(LOOP); // declared…
      tileset.setLoopWindow(range); // …then cleared / rejected
      await evictAtBucket(tileset, unloads, 4, 32, 1);
      expect(unloads).toEqual(['0:26', '0:27', '0:28']);
      tileset.finalize();
    }
  });

  it('does not rotate a loop shorter than the protected window (the clamp)', async () => {
    installClock();
    const unloads: string[] = [];
    const tileset = await buildLoopFixture(unloads);
    // keepBehind = 1 000, protectedAhead = 2 000 ⇒ rotation needs span > 3 000.
    // A 3-bucket loop degenerates (everything wraps inside the protected
    // window and nothing could ever be freed), so it stays on the incumbent
    // plan rather than deadlocking the pass.
    tileset.setLoopWindow({ start: 30 * BUCKET_MS, end: 33 * BUCKET_MS });

    await evictAtBucket(tileset, unloads, 4, 32, 1);
    expect(unloads).toEqual(['0:26', '0:27', '0:28']);

    tileset.finalize();
  });

  it('leaves the tier boundaries themselves untouched', async () => {
    installClock();
    const unloads: string[] = [];
    const tileset = await buildLoopFixture(unloads);
    tileset.setLoopWindow(LOOP);

    // Evict everything evictable: the protected window is whatever is left.
    await evictAtBucket(tileset, unloads, 1, 32, 1);
    // Six candidates, all evicted eventually — but the ORDER shows the
    // boundaries are unchanged: tiers B and C first (30, 29, 28), then the
    // tier-D protected window in LRU order (26, 27 by the wrapped
    // protectedAhead = 2 000; 31 by keepBehind = 1 000).
    expect(unloads).toEqual(['0:30', '0:29', '0:28', '0:26', '0:27', '0:31']);

    tileset.finalize();
  });

  it('never evicts a nearer-in-the-loop tile before a further one, within a tier', async () => {
    // Property: for pseudo-random cache states, the eviction plan under
    // rotation is non-increasing in banded wrapped-ahead distance WITHIN each
    // playhead-relative tier — Belady-order consistency on the wrapped metric.
    const rand = (seed: number): (() => number) => {
      let s = seed >>> 0;
      return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
      };
    };
    const PLAYHEAD_BUCKET = 20;
    const SPAN = 40 * BUCKET_MS;

    for (const seed of [1, 7, 99]) {
      installClock();
      const next = rand(seed);
      const buckets = new Set<number>([PLAYHEAD_BUCKET]);
      while (buckets.size < 11) buckets.add(Math.floor(next() * 40));
      const ordered = [...buckets].sort((a, b) => a - b);

      const unloads: string[] = [];
      const tileset = makeTileset(unloads);
      let first = true;
      for (const i of ordered) {
        await loadBucket(tileset, WEST, i);
        if (first) {
          await enableBufferTracking(tileset);
          first = false;
        }
        advanceClock(1000);
      }
      tileset.setLoopWindow({ start: 0, end: SPAN });
      setBag({ enabled: true });
      await evictAtBucket(tileset, unloads, 4, PLAYHEAD_BUCKET, 1);

      const playhead = PLAYHEAD_BUCKET * BUCKET_MS + 501;
      const lastBand: Record<string, number> = {};
      for (const s of evictSamples()) {
        if (s.tier !== 'b' && s.tier !== 'c') continue; // A and D are LRU
        const t = Number.parseInt(s.key.split('/')[3], 10);
        const aheadMod = (((t - playhead) % SPAN) + SPAN) % SPAN;
        const band = Math.floor(aheadMod / BUCKET_MS);
        if (lastBand[s.tier] !== undefined) {
          expect(band).toBeLessThanOrEqual(lastBand[s.tier]);
        }
        lastBand[s.tier] = band;
      }
      setBag(undefined);
      tileset.finalize();
    }
  });

  /**
   * The §9.4 pathology, measured: three laps of a 24-bucket loop with a
   * 4-bucket resident window, through a cache holding ~58% of the lap's
   * working set. Both arms run the identical trace; the only difference is
   * whether a loop is declared.
   *
   * Honest sizing note. On this synthetic the measured gap is 54 vs 62 tile
   * fetches (~13% fewer, ~22% fewer REFETCHES) — a real repair but not the
   * "≪" the item's Evaluation block hypothesised. The reason is structural: a
   * single-cell forward scan is a contiguous 1-D reference string, and BOTH
   * policies end up retaining a contiguous window, so both land near the
   * unavoidable (workingSet − cache) misses per lap. The pathology the
   * rotation removes is the ORDER within that — the incumbent spends its
   * evictions on the tiles nearest the wrap. A route-level measurement on a
   * real looping demo is the harness this needs and does not exist yet.
   */
  it('refetches measurably less over three laps of a loop (the §9.4 repair)', async () => {
    const LAP_BUCKETS = 24;
    const WINDOW = 4 * BUCKET_MS;

    async function runLaps(withLoop: boolean): Promise<number> {
      installClock();
      let fetches = 0;
      const tileset = new SpatioTemporalTileset({
        minZoom: 0,
        maxZoom: 12,
        enablePrefetch: false,
        refinementStrategy: 'no-overlap',
        temporalBucketMs: BUCKET_MS,
        maxCacheSize: 14, // ~58% of the lap working set
        getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
        getTileData: async (id: TileId) => {
          fetches++;
          return fakeTile(id);
        },
        getTileDataBatch: async (ids: TileId[]) => {
          fetches += ids.length;
          return ids.map(fakeTile);
        },
      });
      if (withLoop) {
        tileset.setLoopWindow({ start: 0, end: LAP_BUCKETS * BUCKET_MS });
      }
      for (let lap = 0; lap < 3; lap++) {
        for (let i = 0; i < LAP_BUCKETS; i++) {
          tileset.update({
            bounds: WEST,
            zoom: 6,
            time: i * BUCKET_MS + 500 + lap, // 1 ms nudge per lap
            timeWindow: WINDOW,
          });
          await settle();
          // The coverage index needs a viewport before it can be built.
          if (lap === 0 && i === 0) await enableBufferTracking(tileset);
          advanceClock(100);
        }
      }
      tileset.finalize();
      return fetches;
    }

    const rotated = await runLaps(true);
    const incumbent = await runLaps(false);

    expect(incumbent).toBeGreaterThan(LAP_BUCKETS); // the trace really refetches
    expect(rotated).toBeLessThan(incumbent);
    expect(rotated).toBeLessThanOrEqual(incumbent * 0.95);
  });
});

/**
 * BH-7b — byte density WITHIN a tier, with NO loop declared.
 *
 * The over-limit loop evicts until the cache is back under its limits, so
 * among candidates a tier already considers equally valuable, freeing the big
 * ones first ends the pass soonest — fewer tiles evicted per over-budget
 * event. "Equally valuable" is quantized to one temporal bucket: distance
 * still dominates ACROSS bands, byte size only decides INSIDE one. Tier A
 * (LRU) and tier D (the last-resort recency order) are untouched.
 *
 * UNCONDITIONAL BY DESIGN — read this together with the rotation suite above,
 * because the two used to read as a contradiction. Not one test in this suite
 * declares a loop, and that is the point: BH-7b answers §9.4's *first* gap
 * (byte-blindness within a tier, whose measurable is refetched bytes per
 * session under memory pressure), which is not a looping phenomenon; loop
 * rotation answers the *second*. So they have two independent kill switches:
 * `setLoopWindow(null)` reverts rotation, `setEvictionByteDensityBands(false)`
 * reverts banding, and only the latter restores the pre-BH-7 eviction plan
 * byte for byte. The regression pin below asserts exactly that, on a fixture
 * where more than one tile shares a band — the only shape in which the byte
 * tiebreak is reachable at all, and therefore the only shape in which such a
 * pin can fail.
 */
describe('BH-7 byte-density ordering inside a distance band', () => {
  /** Two spatial cells per bucket in the west viewport: x=0 and x=1. */
  const twoCellTiles = (
    _b: BoundingBox,
    z: number,
    range: { start: number; end: number },
  ): TileId[] => {
    const ids: TileId[] = [];
    for (let i = 0; i < N_BUCKETS; i++) {
      const t = i * BUCKET_MS;
      if (t + BUCKET_MS >= range.start && t <= range.end) {
        ids.push({ z, x: 0, y: 0, t }, { z, x: 1, y: 0, t });
      }
    }
    return ids;
  };

  /** A tile whose `estimateTileSize` is 1 000 + `bytes` (see archive.ts). */
  const sizedTile = (id: TileId, bytes: number): Tile =>
    ({
      id,
      timeRange: { start: id.t, end: id.t + BUCKET_MS },
      layers: [{ arrowIpc: new Uint8Array(bytes) }],
    }) as unknown as Tile;

  /** x=1 is the 10× heavy cell. */
  const cellBytes = (id: TileId): number => (id.x === 1 ? 100_000 : 10_000);

  const makeSizedTileset = (unloads: string[]): SpatioTemporalTileset =>
    new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles: async (b, z, r) => twoCellTiles(b, z, r),
      getTileData: async (id: TileId) => sizedTile(id, cellBytes(id)),
      getTileDataBatch: async (ids: TileId[]) =>
        ids.map((id) => sizedTile(id, cellBytes(id))),
      onTileUnload: (tile: Tile) => unloads.push(label(tile.id)),
    });

  /**
   * Load `buckets` (two byte-skewed cells each) and enable coverage tracking
   * on the first. With buckets 26 and 27 behind a bucket-30 playhead this is
   * four tier-B candidates in TWO bands of TWO — the shape in which the band
   * tiebreak is reachable. No loop is ever declared.
   */
  async function buildBandFixture(
    unloads: string[],
    buckets: number[],
  ): Promise<SpatioTemporalTileset> {
    const tileset = makeSizedTileset(unloads);
    for (const i of buckets) {
      await loadBucket(tileset, WEST, i);
      if (i === buckets[0]) await enableBufferTracking(tileset);
      advanceClock(1000);
    }
    expect(tileset.getCacheStats().tileCount).toBe(2 * buckets.length);
    return tileset;
  }

  /** One over-limit pass at the bucket-30 playhead; returns the unload order. */
  async function planFor(buckets: number[]): Promise<string[]> {
    const unloads: string[] = [];
    const tileset = await buildBandFixture(unloads, buckets);
    // Cap at the 2 needed tiles ⇒ every other candidate goes.
    await evictAt(tileset, unloads, 2, 1);
    // Snapshot BEFORE finalize — teardown unloads the survivors too, and they
    // are not part of the eviction plan under test.
    const plan = [...unloads];
    tileset.finalize();
    return plan;
  }

  it('evicts the big tile first inside a band, but never across bands', async () => {
    installClock();

    // Bucket 26 is one band further behind than 27, so ALL of 26 goes before
    // ANY of 27 (distance dominates across bands). Inside each band the 10×
    // heavier cell (x=1) frees its bytes first.
    expect(await planFor([26, 27, 30])).toEqual([
      '1:26',
      '0:26',
      '1:27',
      '0:27',
    ]);
  });

  /**
   * THE regression pin for "byte-identical to today", stated so that it can
   * actually fail.
   *
   * The plan's original wording was "loop unset ⇒ the eviction plan is
   * byte-identical to today's". That is false, and this fixture is the
   * counter-example: no loop is declared in either arm, yet the two plans
   * differ, because banding is unconditional. The claim is therefore restated
   * as "byte-identical with `setEvictionByteDensityBands(false)`", which is
   * what the first arm asserts. Both arms run the identical trace; the only
   * variable is the kill switch.
   *
   * Why the shape matters: the rotation suite's fixture loads ONE tile per
   * bucket, so every metric lands in its own band and the byte tiebreak is
   * structurally unreachable — a pin written there could not fail whatever
   * the comparator did. Here two tiles share each band, so if the kill switch
   * ever stopped disengaging the tiebreak (or the band width changed, or the
   * sort crossed a band), the first arm goes red.
   */
  it('is byte-identical to the pre-BH-7 plan with the band switch disengaged (regression pin)', async () => {
    installClock();

    // Disengaged ⇒ identity bands + no byte tiebreak ⇒ literally the pre-BH-7
    // comparator `(a, b) => b.metric - a.metric`, whose ties V8's stable sort
    // left in cache-insertion order (x=0 before x=1, as `twoCellTiles` emits).
    const previous = setEvictionByteDensityBands(false);
    let incumbent: string[];
    try {
      incumbent = await planFor([26, 27, 30]);
    } finally {
      setEvictionByteDensityBands(previous);
    }
    expect(incumbent).toEqual(['0:26', '1:26', '0:27', '1:27']);

    // Engaged (the default), same trace, still no loop: a DIFFERENT plan.
    // This inequality is the honest form of the compliance claim.
    const banded = await planFor([26, 27, 30]);
    expect(banded).toEqual(['1:26', '0:26', '1:27', '0:27']);
    expect(banded).not.toEqual(incumbent);

    // ...and the difference is contained: the switch reorders only WITHIN a
    // band, so the sequence of bands (bucket 26's pair, then 27's) is
    // identical either way. Nothing crossed a band or a tier.
    const bandsOf = (plan: string[]): string[] =>
      plan.map((u) => u.split(':')[1]);
    expect(bandsOf(banded)).toEqual(bandsOf(incumbent));
  });

  it('leaves tier A and tier D on pure recency (byte size never reorders them)', async () => {
    installClock();

    // Buckets 29 and 31 are inside the protected window at a bucket-30
    // playhead ⇒ tier D, ordered by lastUsed. 29 was loaded first, so 29's
    // cells go before 31's even though the heavy cell of 31 is 10× bigger.
    const unloads = await planFor([29, 31, 30]);
    expect(unloads.slice(0, 2).sort()).toEqual(['0:29', '1:29']);
    expect(unloads.slice(2).sort()).toEqual(['0:31', '1:31']);
  });
});

describe('eviction attribution — cacheStats + the `evict` probe channel', () => {
  let original: ProbeBag | undefined;

  beforeEach(() => {
    original = (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe;
    setBag({ enabled: true });
  });

  afterEach(() => {
    setBag(original);
    vi.restoreAllMocks();
  });

  it('starts at zero and never counts a tier for an untouched tileset', async () => {
    installClock();
    const unloads: string[] = [];
    const tileset = await buildFixture(unloads);
    const stats = tileset.getCacheStats();
    expect(stats.evictions).toBe(0);
    expect(stats.bytesEvicted).toBe(0);
    expect(stats.evictionsByTier).toEqual({ b: 0, c: 0, d: 0 });
    tileset.finalize();
  });

  it('attributes each `evict` sample to the tier that freed its bytes', async () => {
    installClock();
    const unloads: string[] = [];
    const tileset = await buildFixture(unloads);
    setBag({ enabled: true }); // drop the fixture's own load-time churn

    // Over by 6 = |A| + |B| + |C| — the same walk the tiering suite pins.
    await evictAt(tileset, unloads, 4, 1);
    expect(unloads).toEqual(['1:0', '1:5', '0:26', '0:27', '0:50', '0:40']);

    const samples = evictSamples();
    // One sample per evicted tile, in eviction order.
    expect(samples.map(sampleLabel)).toEqual(unloads);
    expect(samples.map((s) => s.tier)).toEqual([
      'a', // east 0  — non-coverage LRU
      'a', // east 5
      'b', // west 26 — coverage, far behind the playhead
      'b', // west 27
      'c', // west 50 — coverage, far ahead (furthest first)
      'c', // west 40
    ]);
    // Every sample carries the bytes it released and the playhead it was
    // judged against (bucket 30 + 500 ms + the 1 ms nudge).
    for (const s of samples) {
      expect(s.bytes).toBeGreaterThan(0);
      expect(s.playheadMs).toBe(30 * BUCKET_MS + 501);
    }

    const stats = tileset.getCacheStats();
    // `evictionsByTier` counts only the playhead-relative tiers; tier A is
    // recoverable as evictions - (b + c + d).
    expect(stats.evictionsByTier).toEqual({ b: 2, c: 2, d: 0 });
    expect(stats.evictions).toBe(6);
    expect(
      stats.evictions -
        (stats.evictionsByTier.b +
          stats.evictionsByTier.c +
          stats.evictionsByTier.d),
    ).toBe(2); // the two tier-A evictions
    // The byte total agrees with the samples, and with runwayEvictions'
    // definition (tiers C/D only).
    expect(stats.bytesEvicted).toBe(
      samples.reduce((sum, s) => sum + s.bytes, 0),
    );
    expect(stats.runwayEvictions).toBe(2);

    tileset.finalize();
  });

  it('reaches tier D and counts it separately from C', async () => {
    installClock();
    const unloads: string[] = [];
    const tileset = await buildFixture(unloads);
    setBag({ enabled: true });

    await evictAt(tileset, unloads, 2, 1); // over by 8: A+B+C don't suffice
    expect(evictSamples().map((s) => s.tier)).toEqual([
      'a',
      'a',
      'b',
      'b',
      'c',
      'c',
      'd',
      'd',
    ]);
    const stats = tileset.getCacheStats();
    expect(stats.evictionsByTier).toEqual({ b: 2, c: 2, d: 2 });
    // runwayEvictions is C + D — the same 4 the tiering suite pins.
    expect(stats.runwayEvictions).toBe(4);

    tileset.finalize();
  });

  it('reports the no-coverage LRU fallback as tier A throughout', async () => {
    installClock();
    const unloads: string[] = [];
    const tileset = await buildFixture(unloads, { coverage: false });
    setBag({ enabled: true });

    await evictAt(tileset, unloads, 4, 1);
    const samples = evictSamples();
    expect(samples).toHaveLength(6);
    expect(samples.every((s) => s.tier === 'a')).toBe(true);
    // No playhead-relative decision was made, so no tier counter moves —
    // exactly matching runwayEvictions staying 0 on this path.
    expect(tileset.getCacheStats().evictionsByTier).toEqual({
      b: 0,
      c: 0,
      d: 0,
    });
    expect(tileset.getCacheStats().runwayEvictions).toBe(0);

    tileset.finalize();
  });

  it('reports the under-limit grace sweep as tier A', async () => {
    installClock();
    const unloads: string[] = [];
    const tileset = await buildFixture(unloads);
    setBag({ enabled: true });

    // Stay UNDER both limits and age every non-needed tile past the paused
    // grace period (30 s) — the wall-clock sweep, not the tiered branch.
    advanceClock(120_000);
    await loadBucket(tileset, WEST, 30, 7);
    const samples = evictSamples();
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((s) => s.tier === 'a')).toBe(true);
    expect(tileset.getCacheStats().evictionsByTier).toEqual({
      b: 0,
      c: 0,
      d: 0,
    });

    tileset.finalize();
  });

  it('is a no-op on the eviction path when the probe is off', async () => {
    installClock();
    setBag(undefined);
    const unloads: string[] = [];
    const tileset = await buildFixture(unloads);
    await evictAt(tileset, unloads, 4, 1);
    // The counters still accumulate (they are plain fields), but the probe
    // bag was never created — no payload object was allocated.
    expect(
      (globalThis as unknown as { __sttProbe?: ProbeBag }).__sttProbe,
    ).toBeUndefined();
    expect(tileset.getCacheStats().evictionsByTier).toEqual({
      b: 2,
      c: 2,
      d: 0,
    });
    tileset.finalize();
  });

  it('hands back a COPY of evictionsByTier (callers cannot corrupt the live counter)', async () => {
    installClock();
    const unloads: string[] = [];
    const tileset = await buildFixture(unloads);
    await evictAt(tileset, unloads, 4, 1);
    const snapshot = tileset.getCacheStats();
    snapshot.evictionsByTier.c = 9999;
    expect(tileset.getCacheStats().evictionsByTier.c).toBe(2);
    tileset.finalize();
  });
});

/**
 * A3 (tile-loading audit 2026-08): eviction was reachable only from a
 * selection pass that got past the identical-params fast path (or from
 * `setOptions`). A still camera on a frozen clock — a start gate holding the
 * playhead while the runway fills — therefore let deliveries land with no
 * eviction at all (13 741 headers / 1.67 GB observed against a 1 GiB cap on
 * the flow-and-riders heads overlay). The delivery path now schedules one
 * coalesced over-limit pass of its own.
 */
describe('A3: eviction is reachable from tile delivery, not only from a selection pass', () => {
  it('a prefetch burst past the byte cap is trimmed back under it with no further update()', async () => {
    // `fakeTile` carries no buffers, so every decoded tile is the 1 000-byte
    // base: a 20-tile byte cap against a 64-bucket paused prefetch horizon.
    const CAP_BYTES = 20 * 1000;
    const wide = makeAvailableTiles(200);
    let selections = 0;
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      prefetchAhead: 10 * BUCKET_MS,
      prefetchSteps: 10, // paused horizon = 100 buckets, bucket-capped to 64
      maxCacheSize: 1000, // count budget 500/pass: the tile cap never binds
      maxCacheByteSize: CAP_BYTES,
      // Compressed prices tiny — one byte — so the runway's BYTE budget never
      // truncates the burst either and only the cache cap is in play. (Since
      // G3-2 that budget is the cache SHARE, ½ × 20 000 ÷ the cold 8×
      // expansion = 1 250 compressed bytes; at the previous 100 B per tile
      // it capped the runway at 12 tiles and there was no burst to trim.)
      getTileByteSize: () => 1,
      getAvailableTiles: async (b, z, r) => {
        selections++;
        return wide(b, z, r);
      },
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: async (ids: TileId[]) => ids.map(fakeTile),
    });

    // ONE selection pass; the select key never changes again.
    tileset.update({ bounds: WEST, zoom: 6, time: 0, timeWindow: BUCKET_MS });
    await settle(150);

    const st = tileset.getCacheStats();
    // The burst really landed past the cap (≥ 64 prefetched + the head
    // tile), so the trim below is not vacuous...
    expect(st.evictions).toBeGreaterThan(0);
    // ...and the cache came back under the cap with no `update()` to drive
    // it: pre-fix `cacheBytes` sat at ~65 000 against a 20 000 cap forever.
    expect(st.cacheBytes).toBeLessThanOrEqual(CAP_BYTES);
    expect(st.tileCount).toBeLessThanOrEqual(CAP_BYTES / 1000);
    // The only directory scan was the first pass's (single zoom, no-overlap).
    expect(selections).toBeGreaterThan(0);

    tileset.finalize();
  });
});

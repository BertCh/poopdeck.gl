/**
 * Tests for the player-buffering readiness API (WS-A):
 * `getBufferedRunway` / `getBufferedRanges` / `estimateCost` /
 * `estimateTimeToReadyMs` / `onBufferChange` on SpatioTemporalTileset.
 *
 * Harness: a synthetic single-cell archive (one tile per 1 s temporal bucket
 * at the requested zoom, byte length `100 × (bucketIndex + 1)`), driven with
 * a tiny time window so each update() loads exactly one bucket. The buffer
 * APIs are pure directory + cache math, so every scenario is deterministic.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import type { BufferedRunway } from '../src/spatiotemporal-tileset';
import type { BoundingBox, TileId, Tile } from '../src/types';
import {
  BOUNDS,
  BUCKET_MS,
  fakeTile,
  makeAvailableTiles,
  settle,
} from './helpers/fixtures';
import { advanceClock, installClock } from './helpers/clock';

const N_BUCKETS = 20;
/** Directory byte length of the tile at bucket index `i`. */
const bytesAt = (i: number): number => 100 * (i + 1);

/** One tile per bucket at (x=0, y=0) whose interval overlaps the range. */
const availableTiles = makeAvailableTiles(N_BUCKETS);

function getTileByteSize(id: TileId): number | undefined {
  const i = id.t / BUCKET_MS;
  if (id.x !== 0 || id.y !== 0) return undefined;
  if (!Number.isInteger(i) || i < 0 || i >= N_BUCKETS) return undefined;
  return bytesAt(i);
}

interface HarnessOptions {
  onBufferChange?: (runway: BufferedRunway) => void;
  getThroughput?: () => { bytesPerMs: number | null; samples: number };
  /** When set, batch loads stay PENDING until `releaseBatches()` is called. */
  gateBatches?: boolean;
}

function makeHarness(opts: HarnessOptions = {}) {
  const pending: Array<{ ids: TileId[]; resolve: () => void }> = [];
  const tileset = new SpatioTemporalTileset({
    minZoom: 0,
    maxZoom: 12,
    enablePrefetch: false,
    refinementStrategy: 'no-overlap',
    temporalBucketMs: BUCKET_MS,
    getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
    getTileByteSize,
    getTileData: async (id: TileId) => fakeTile(id),
    getTileDataBatch: opts.gateBatches
      ? (ids: TileId[]) =>
          new Promise<(Tile | null)[]>((resolve) => {
            pending.push({ ids, resolve: () => resolve(ids.map(fakeTile)) });
          })
      : async (ids: TileId[]) => ids.map(fakeTile),
    onBufferChange: opts.onBufferChange,
    getThroughput: opts.getThroughput,
  });
  /**
   * Load exactly bucket `i` (tiny window centred inside the bucket), then
   * yield so the request settles BEFORE the next update — a following
   * update() would otherwise cancel the still-in-flight request as
   * superseded (its tile is no longer in the new needed set).
   */
  const loadBucket = async (i: number): Promise<void> => {
    tileset.update({
      bounds: BOUNDS,
      zoom: 6,
      time: i * BUCKET_MS + 500,
      timeWindow: 100,
    });
    await settle(5);
  };
  const releaseBatches = (): void => {
    for (const p of pending.splice(0)) p.resolve();
  };
  return { tileset, loadBucket, releaseBatches };
}

/** Enable buffer tracking and wait for the async coverage index build. */
async function primeCoverage(tileset: SpatioTemporalTileset): Promise<void> {
  // First call flips the lazy tracking flag and kicks the (async) directory
  // slice; before the index lands the runway is conservatively empty.
  const before = tileset.getBufferedRunway(0, 1);
  expect(before.simMs).toBe(0);
  expect(before.complete).toBe(false);
  await settle();
}

describe('SpatioTemporalTileset.getBufferedRunway', () => {
  it('grows as tiles load and stops at the first missing bucket', async () => {
    const { tileset, loadBucket } = makeHarness();

    await loadBucket(0);
    await primeCoverage(tileset);

    // Bucket 0 loaded, bucket 1 missing → runway from t=0 reaches 1000.
    let runway = tileset.getBufferedRunway(0, 1, 10_000);
    expect(runway.simMs).toBe(1000);
    expect(runway.complete).toBe(false);
    // Pending bytes across the probed horizon [0, 10000]: buckets 1..10.
    let expectedBytes = 0;
    for (let i = 1; i <= 10; i++) expectedBytes += bytesAt(i);
    expect(runway.bytesPending).toBe(expectedBytes);
    expect(runway.horizonSimMs).toBe(10_000);

    // Load buckets 1 and 2 → the runway extends to 3000.
    await loadBucket(1);
    await loadBucket(2);
    runway = tileset.getBufferedRunway(0, 1, 10_000);
    expect(runway.simMs).toBe(3000);
    expect(runway.complete).toBe(false);

    // A loaded island PAST the gap does not extend the runway...
    await loadBucket(5);
    runway = tileset.getBufferedRunway(0, 1, 10_000);
    expect(runway.simMs).toBe(3000); // still blocked by bucket 3
    // ...but it does shrink the pending byte total.
    expect(runway.bytesPending).toBe(
      expectedBytes - bytesAt(1) - bytesAt(2) - bytesAt(5),
    );

    tileset.finalize();
  });

  it('respects the probe horizon (a missing bucket beyond it is invisible)', async () => {
    const { tileset, loadBucket } = makeHarness();
    await loadBucket(0);
    await loadBucket(1);
    await primeCoverage(tileset);

    // Probe only 1.5 buckets ahead: buckets 0–1 are loaded, bucket 2 (missing)
    // lies beyond the horizon → the probe completes at the horizon.
    const runway = tileset.getBufferedRunway(0, 1, 1500);
    expect(runway.complete).toBe(true);
    expect(runway.simMs).toBe(1500);
    expect(runway.bytesPending).toBe(0);

    // The horizon is floored at one temporal bucket.
    expect(tileset.getBufferedRunway(0, 1, 1).horizonSimMs).toBe(BUCKET_MS);

    tileset.finalize();
  });

  it('probes BACKWARD and clamps at the dataset start (complete)', async () => {
    const { tileset, loadBucket } = makeHarness();
    await loadBucket(0);
    await loadBucket(1);
    await loadBucket(2);
    await primeCoverage(tileset);

    // Backward from 2500 over loaded buckets 2,1,0: the probe is clamped at
    // the data start (0) and counts as complete.
    const back = tileset.getBufferedRunway(2500, -1, 10_000);
    expect(back.complete).toBe(true);
    expect(back.simMs).toBe(2500);
    expect(back.bytesPending).toBe(0);

    // Backward from 2500 with bucket 1 missing stops at bucket 1's FAR
    // edge (2000) → runway 500.
    const { tileset: t2, loadBucket: load2 } = makeHarness();
    await load2(0);
    await load2(2);
    await primeCoverage(t2);
    const blocked = t2.getBufferedRunway(2500, -1, 10_000);
    expect(blocked.complete).toBe(false);
    expect(blocked.simMs).toBe(500);

    tileset.finalize();
    t2.finalize();
  });

  it('reaching the dataset end counts as complete', async () => {
    const { tileset, loadBucket } = makeHarness();
    for (let i = 0; i < N_BUCKETS; i++) await loadBucket(i);
    await primeCoverage(tileset);

    const runway = tileset.getBufferedRunway(0, 1, 1_000_000);
    expect(runway.complete).toBe(true);
    // Clamped at the end of the available data, not the (huge) horizon.
    expect(runway.simMs).toBe(N_BUCKETS * BUCKET_MS);
    expect(runway.bytesPending).toBe(0);

    tileset.finalize();
  });
});

describe('SpatioTemporalTileset.estimateCost', () => {
  it('sums directory lengths of NOT-loaded tiles intersecting the range', async () => {
    const { tileset, loadBucket } = makeHarness();
    await loadBucket(0);
    await primeCoverage(tileset);

    // Range covering buckets 0..2: bucket 0 is loaded (excluded), 1–2 missing.
    const cost = tileset.estimateCost({ start: 0, end: 2999 });
    expect(cost.tiles).toBe(2);
    expect(cost.bytes).toBe(bytesAt(1) + bytesAt(2));

    // A fully-loaded range costs nothing.
    expect(tileset.estimateCost({ start: 100, end: 200 })).toEqual({
      bytes: 0,
      tiles: 0,
    });

    tileset.finalize();
  });

  it('treats IN-FLIGHT tiles as not loaded (honesty over optimism)', async () => {
    const { tileset, loadBucket, releaseBatches } = makeHarness({
      gateBatches: true,
    });
    await loadBucket(0); // request stays pending behind the gate
    await primeCoverage(tileset);

    expect(tileset.estimateCost({ start: 0, end: 999 })).toEqual({
      bytes: bytesAt(0),
      tiles: 1,
    });

    releaseBatches();
    await settle();
    expect(tileset.estimateCost({ start: 0, end: 999 })).toEqual({
      bytes: 0,
      tiles: 0,
    });

    tileset.finalize();
  });
});

/**
 * The per-bucket byte columns CO-1 adds beside `estimateCost`. `estimateCost`
 * answers "how many bytes", which is the question a controller reasoning about
 * TIME cannot use — the same total is comfortable spread over a minute and
 * fatal as a wall two seconds out. These two APIs expose the distribution
 * without changing what `estimateCost` counts, and the identity between them
 * is pinned below so the two can never drift into two different truths.
 */
describe('SpatioTemporalTileset byte-density profile', () => {
  it('splits per-bucket totals from what is still missing', async () => {
    const { tileset, loadBucket } = makeHarness();
    await loadBucket(0);
    await loadBucket(1);
    await primeCoverage(tileset);

    const profile = tileset.getByteDensityProfile({ start: 0, end: 4999 });
    expect(profile).not.toBeNull();
    expect(profile!.bucketStarts).toEqual([0, 1000, 2000, 3000, 4000]);
    // Totals are a property of the data and do not move as tiles load...
    expect(profile!.totalBytes).toEqual([0, 1, 2, 3, 4].map(bytesAt));
    // ...while the missing column drains behind the play head.
    expect(profile!.missingBytes).toEqual([
      0,
      0,
      bytesAt(2),
      bytesAt(3),
      bytesAt(4),
    ]);

    tileset.finalize();
  });

  it('sums missing bytes to exactly estimateCost over the same range', async () => {
    const { tileset, loadBucket } = makeHarness();
    for (const i of [0, 1, 4, 5]) await loadBucket(i);
    await primeCoverage(tileset);

    const ranges = [
      { start: 0, end: 999 }, // one bucket, fully loaded
      { start: 0, end: 2999 },
      { start: 1500, end: 6500 }, // straddles bucket edges both ends
      { start: 3000, end: 3000 }, // degenerate point range
      { start: 0, end: 100_000 }, // past the end of the data
      { start: 50_000, end: 60_000 }, // entirely past the data
      { start: -5000, end: -1000 }, // entirely before the data
    ];
    for (const range of ranges) {
      const profile = tileset.getByteDensityProfile(range)!;
      const missing = profile.missingBytes.reduce((n, b) => n + b, 0);
      const cost = tileset.estimateCost(range);
      expect(missing, `range ${range.start}..${range.end}`).toBe(cost.bytes);
      // Same bucket set on both sides: the walk and the columns agree about
      // WHICH buckets a range touches, not just about the total.
      const tiles = profile.missingBytes.filter((b) => b > 0).length;
      expect(tiles, `tiles ${range.start}..${range.end}`).toBe(cost.tiles);
    }

    tileset.finalize();
  });

  it('prices a horizon off the prefix sums (totals, and honest when blind)', async () => {
    const { tileset, loadBucket } = makeHarness();
    await loadBucket(0);
    await primeCoverage(tileset);

    // Residency cost of the next 5 buckets: TOTAL bytes, including the one
    // already loaded — a cache budget is about what must be held, not fetched.
    let expected = 0;
    for (let i = 0; i <= 4; i++) expected += bytesAt(i);
    expect(tileset.bytesForHorizon(0, 1, 4999)).toEqual({
      bytes: expected,
      exact: true,
    });

    // Identical answer through the walking API's bucket rule.
    const profile = tileset.getByteDensityProfile({ start: 0, end: 4999 })!;
    expect(profile.totalBytes.reduce((n, b) => n + b, 0)).toBe(expected);

    // A horizon past the end of the data does not keep growing.
    const all = tileset.bytesForHorizon(0, 1, 1e9).bytes;
    let everything = 0;
    for (let i = 0; i < N_BUCKETS; i++) everything += bytesAt(i);
    expect(all).toBe(everything);
    expect(tileset.bytesForHorizon(0, 1, 1e12).bytes).toBe(all);

    tileset.finalize();
  });

  it('abstains until the coverage index exists', async () => {
    const { tileset } = makeHarness();
    // No viewport yet → no index → no profile, and the horizon says so.
    expect(tileset.getByteDensityProfile({ start: 0, end: 5000 })).toBe(null);
    expect(tileset.bytesForHorizon(0, 1, 5000)).toEqual({
      bytes: 0,
      exact: false,
    });
    tileset.finalize();
  });
});

describe('SpatioTemporalTileset.estimateTimeToReadyMs', () => {
  it('divides pending bytes by measured throughput, null without a signal', async () => {
    let bytesPerMs: number | null = null;
    const { tileset, loadBucket } = makeHarness({
      getThroughput: () => ({
        bytesPerMs,
        samples: bytesPerMs === null ? 0 : 3,
      }),
    });
    await loadBucket(0);
    await primeCoverage(tileset);

    // No throughput signal yet → null (show "…", not a fake number).
    expect(tileset.estimateTimeToReadyMs({ start: 0, end: 2999 })).toBeNull();

    bytesPerMs = 50;
    const expectedBytes = bytesAt(1) + bytesAt(2); // bucket 0 already loaded
    expect(tileset.estimateTimeToReadyMs({ start: 0, end: 2999 })).toBeCloseTo(
      expectedBytes / 50,
      9,
    );

    // No getThroughput option at all → null.
    const { tileset: bare, loadBucket: loadBare } = makeHarness();
    await loadBare(0);
    await primeCoverage(bare);
    expect(bare.estimateTimeToReadyMs({ start: 0, end: 2999 })).toBeNull();

    tileset.finalize();
    bare.finalize();
  });

  it('is null while the coverage index is still being built, even on a warm estimator (estimateCost says unknown)', async () => {
    // The FIRST readiness call flips tracking on and kicks the async index
    // build; until it lands the cost is UNKNOWABLE, not zero. A 0 here priced
    // an ETA of 0, and a warm estimator let the governor's start gate pass
    // onto nothing — three zero-length snap-backs on the small shape
    // (tile-loading audit 2026-08, §9.3.4).
    const { tileset, loadBucket } = makeHarness({
      getThroughput: () => ({ bytesPerMs: 50, samples: 3 }),
    });
    await loadBucket(0);
    const range = { start: 0, end: 2999 };
    expect(tileset.estimateCost(range)).toEqual({
      bytes: 0,
      tiles: 0,
      unknown: true,
    });
    expect(tileset.estimateTimeToReadyMs(range)).toBeNull();

    await settle();
    const built = tileset.estimateCost(range);
    expect(built.unknown).toBeUndefined();
    expect(built.bytes).toBe(bytesAt(1) + bytesAt(2));
    expect(tileset.estimateTimeToReadyMs(range)).toBeCloseTo(
      (bytesAt(1) + bytesAt(2)) / 50,
      9,
    );
    tileset.finalize();
  });
});

describe('SpatioTemporalTileset.getBufferedRanges', () => {
  it('merges contiguous loaded buckets and caps the range count', async () => {
    const { tileset, loadBucket } = makeHarness();
    for (const i of [0, 1, 2, 5, 6, 9]) await loadBucket(i);
    await primeCoverage(tileset);

    expect(tileset.getBufferedRanges()).toEqual([
      { start: 0, end: 3000 },
      { start: 5000, end: 7000 },
      { start: 9000, end: 10_000 },
    ]);

    // maxRanges truncates (the scrubber bar stays cheap on shattered caches).
    expect(tileset.getBufferedRanges({ maxRanges: 2 })).toEqual([
      { start: 0, end: 3000 },
      { start: 5000, end: 7000 },
    ]);

    tileset.finalize();
  });
});

describe('SpatioTemporalTileset onBufferChange', () => {
  it('fires on tile load with a fresh runway, throttled to ≤10 Hz', async () => {
    const reports: BufferedRunway[] = [];
    const spy = vi.fn((r: BufferedRunway) => reports.push(r));
    const { tileset, loadBucket } = makeHarness({ onBufferChange: spy });

    // A rapid burst: 6 bucket loads inside ~30 ms. The trailing-edge 100 ms
    // throttle must coalesce these into a couple of emissions instead of one
    // per tile load / selection change.
    for (let i = 0; i < 6; i++) await loadBucket(i);
    await settle(30);
    const earlyCalls = spy.mock.calls.length;
    expect(earlyCalls).toBeGreaterThanOrEqual(1);
    expect(earlyCalls).toBeLessThanOrEqual(2); // 6 loads ≠ 6 emissions

    await settle(250); // drain the trailing emission(s)
    expect(spy.mock.calls.length).toBeLessThanOrEqual(4);

    // The final report reflects the last play-head position (bucket 5, time
    // 5500): buckets 0–5 loaded, bucket 6 missing → runway reaches 6000,
    // i.e. 500 sim-ms ahead of 5500.
    const last = reports[reports.length - 1];
    expect(last.simMs).toBe(500);
    expect(last.complete).toBe(false);

    tileset.finalize();
  });
});

/**
 * B8 (tile-loading audit 2026-08, NS-9 / G7): a 404 used to be treated as
 * transient — three attempts, then a per-member fan-out, then the 60 s
 * backoff ladder forever — and the runway stayed pinned behind the hole for
 * ~8–17 s before the readiness write-off latched. The archive now raises a
 * typed `PermanentFetchError` (403/404/410) through the batch's `onTileError`
 * hook; the tileset writes the tile off on FIRST sight, disarms the ladder,
 * and reports a runway that ends there as `blockedPermanently` so the
 * governor can fold it as complete instead of waiting on the escape hatch.
 */
describe('B8: a PermanentFetchError is a final write-off', () => {
  const GONE_T = 4 * BUCKET_MS; // the tile the origin will never serve
  const isGone = (id: TileId): boolean => id.t === GONE_T;

  function makeFailingHarness(kind: 'permanent' | 'transient') {
    const requests = new Map<string, number>();
    const errors: Array<{ id: TileId; name: string }> = [];
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileByteSize,
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: async (ids: TileId[], _signal, hooks) => {
        for (const id of ids) {
          const k = `${id.z}/${id.x}/${id.y}/${id.t}`;
          requests.set(k, (requests.get(k) ?? 0) + 1);
        }
        return ids.map((id, i) => {
          if (!isGone(id)) return fakeTile(id);
          const error =
            kind === 'permanent'
              ? Object.assign(new Error('404 Not Found'), {
                  name: 'PermanentFetchError',
                  status: 404,
                })
              : new Error('502 Bad Gateway');
          hooks?.onTileError?.(i, error);
          return null;
        });
      },
      onTileError: (error, id) => errors.push({ id, name: error.name }),
    });
    return { tileset, requests, errors };
  }

  /** Head at 3.5 s with a 1 s window: buckets 3 and 4 (and 2) are needed. */
  const HEAD = 3 * BUCKET_MS + 500;
  const view = () => ({
    bounds: BOUNDS,
    zoom: 6,
    time: HEAD,
    timeWindow: BUCKET_MS,
  });

  it('writes the tile off after ONE settle, never re-fetches it, and the runway reports blockedPermanently', async () => {
    const { tileset, requests, errors } = makeFailingHarness('permanent');
    tileset.update(view(), true);
    tileset.getBufferedRunway(HEAD, 1); // coverage tracking on
    await settle(40);

    // The runway ends at the bucket that can never complete — and says so.
    // (Probe ONE bucket ahead: the default 4-window horizon would also count
    // buckets 5–7, which were never needed, as ordinary pending bytes.)
    const runway = tileset.getBufferedRunway(HEAD, 1, BUCKET_MS);
    expect(runway.complete).toBe(false);
    expect(runway.blockedPermanently).toBe(true);
    expect(runway.simMs).toBe(GONE_T - HEAD); // up to the near edge of bucket 4
    // ...and its bytes are not "pending": nothing is coming.
    expect(runway.bytesPending).toBe(0);
    // Surfaced typed, once.
    expect(errors.filter((e) => e.name === 'PermanentFetchError')).toHaveLength(
      1,
    );

    // No ladder: the first rung would re-issue at 500 ms; the ceiling is 60 s.
    await settle(700);
    expect(requests.get(`6/0/0/${GONE_T}`)).toBe(1);

    tileset.finalize();
  });

  it('a TRANSIENT failure keeps the ladder (the control): retried, and the runway is merely incomplete', async () => {
    const { tileset, requests } = makeFailingHarness('transient');
    tileset.update(view(), true);
    tileset.getBufferedRunway(HEAD, 1);
    await settle(40);

    const runway = tileset.getBufferedRunway(HEAD, 1, BUCKET_MS);
    expect(runway.complete).toBe(false);
    expect(runway.blockedPermanently).toBeUndefined();
    expect(runway.bytesPending).toBe(bytesAt(4)); // still expected to arrive

    // First rung of the backoff ladder (500 ms) re-issues the fetch.
    await settle(700);
    expect(requests.get(`6/0/0/${GONE_T}`)).toBeGreaterThanOrEqual(2);

    tileset.finalize();
  });
});

/**
 * B1 (tile-loading audit 2026-08, PR-2): the coverage index was rebuilt only
 * when the bounds rounded to 1/8 of their span changed, but it was BUILT from
 * the exact bounds. A drift under 1/8 that still crossed a tile boundary left
 * the column the trailing edge had left in the index; nothing addressed it
 * again, a bucket is ready only when every index key is ready, and the runway
 * decayed to 0 with everything on screen resident. Ported from
 * `scratchpad/proof-runway.mts` experiment B onto real z6 slippy columns
 * (5.625° each): bounds [5.5, 85.5] → [6, 86] is a 0.625 % drift that moves
 * column 32 out of the box while the old 1/8-span key stays identical.
 */
describe('B1: the coverage index is keyed on the primary-zoom tile box', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const N = 400;
  const SPEED = 2; // sim-ms per real-ms
  /** z6 slippy columns covered by a box (the same math the archive scans with). */
  const colsOf = (b: BoundingBox): [number, number] => [
    Math.floor(((b.minLon + 180) / 360) * 64),
    Math.floor(((b.maxLon - 1e-9 + 180) / 360) * 64),
  ];
  const available = (
    b: BoundingBox,
    z: number,
    r: { start: number; end: number },
  ): TileId[] => {
    const [x0, x1] = colsOf(b);
    const ids: TileId[] = [];
    const first = Math.max(0, Math.floor(r.start / BUCKET_MS));
    const last = Math.min(N - 1, Math.floor(r.end / BUCKET_MS));
    for (let i = first; i <= last; i++) {
      const t = i * BUCKET_MS;
      if (t + BUCKET_MS < r.start || t > r.end) continue;
      for (let x = x0; x <= x1; x++) ids.push({ z, x, y: 0, t });
    }
    return ids;
  };
  const B0: BoundingBox = { minLon: 5.5, minLat: 0, maxLon: 85.5, maxLat: 10 }; // cols 32..47
  const DRIFT: BoundingBox = { minLon: 6, minLat: 0, maxLon: 86, maxLat: 10 }; // cols 33..47
  const SAME_BOX: BoundingBox = {
    minLon: 6.1,
    minLat: 0,
    maxLon: 86.1,
    maxLat: 10,
  };
  const PAN: BoundingBox = { minLon: 16, minLat: 0, maxLon: 96, maxLat: 10 }; // > 1/8

  it('a sub-tolerance drift across a tile boundary rebuilds the index and keeps the runway', async () => {
    installClock();
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      temporalBucketMs: BUCKET_MS,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      prefetchAhead: 5 * BUCKET_MS,
      prefetchSteps: 2,
      maxCacheSize: 100_000,
      getTileByteSize: () => 5000,
      getAvailableTiles: async (b, z, r) => available(b, z, r),
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: async (ids: TileId[]) => ids.map(fakeTile),
    });
    const step = async (bounds: BoundingBox, time: number): Promise<void> => {
      advanceClock(300);
      tileset.update({ bounds, zoom: 6, time, timeWindow: BUCKET_MS }, true);
      await settle(40);
    };

    let time = 500;
    tileset.setAnimationState(true, SPEED);
    tileset.update({ bounds: B0, zoom: 6, time, timeWindow: BUCKET_MS });
    tileset.getBufferedRunway(time, 1); // coverage tracking on
    await settle(60);
    for (let i = 0; i < 6; i++) {
      time += SPEED * 300;
      await step(B0, time);
    }
    expect(tileset.getBufferedRunway(time, 1).simMs).toBeGreaterThanOrEqual(
      5 * BUCKET_MS,
    );
    const rebuilds = tileset.getCacheStats().coverageRebuilds;
    expect(rebuilds).toBe(1);

    // The drift. Column 32 leaves the box; the old 1/8-span key is unchanged
    // (round(5.5/10) = round(6/10), round(85.5/10) = round(86/10)).
    const runways: number[] = [];
    for (let i = 0; i < 40; i++) {
      time += SPEED * 300;
      await step(DRIFT, time);
      runways.push(tileset.getBufferedRunway(time, 1).simMs);
    }
    // Rebuilt exactly once, on the boundary crossing...
    expect(tileset.getCacheStats().coverageRebuilds).toBe(rebuilds + 1);
    // ...and the runway stayed up: no phantom column 32 to wait on. Pre-fix:
    // 14 300 → 11 300 → … → 0 by step 25 and 0 through step 39.
    expect(Math.min(...runways.slice(2))).toBeGreaterThanOrEqual(4 * BUCKET_MS);

    // Same box, different bounds: no rebuild (the drift-is-free property the
    // old rounding bought is kept).
    for (let i = 0; i < 4; i++) {
      time += SPEED * 300;
      await step(SAME_BOX, time);
    }
    expect(tileset.getCacheStats().coverageRebuilds).toBe(rebuilds + 1);

    // A real pan still rebuilds, and the runway recovers on the new box.
    for (let i = 0; i < 8; i++) {
      time += SPEED * 300;
      await step(PAN, time);
    }
    expect(tileset.getCacheStats().coverageRebuilds).toBe(rebuilds + 2);
    expect(tileset.getBufferedRunway(time, 1).simMs).toBeGreaterThan(0);

    tileset.finalize();
  });
});

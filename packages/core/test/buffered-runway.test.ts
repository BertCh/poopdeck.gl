/**
 * Tests for the player-buffering readiness API (WS-A):
 * `getBufferedRunway` / `getBufferedRanges` / `estimateCost` /
 * `estimateTimeToReadyMs` / `onBufferChange` on SpatiotemporalTileset.
 *
 * Harness: a synthetic single-cell archive (one tile per 1 s temporal bucket
 * at the requested zoom, byte length `100 × (bucketIndex + 1)`), driven with
 * a tiny time window so each update() loads exactly one bucket. The buffer
 * APIs are pure directory + cache math, so every scenario is deterministic.
 */

import { describe, it, expect, vi } from 'vitest';
import { SpatiotemporalTileset } from '../src/spatiotemporal-tileset';
import type { BufferedRunway } from '../src/spatiotemporal-tileset';
import type { TileId, BoundingBox, Tile } from '../src/types';
import {
  BOUNDS,
  BUCKET_MS,
  fakeTile,
  makeAvailableTiles,
  settle,
} from './helpers/fixtures';

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
  const tileset = new SpatiotemporalTileset({
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
async function primeCoverage(tileset: SpatiotemporalTileset): Promise<void> {
  // First call flips the lazy tracking flag and kicks the (async) directory
  // slice; before the index lands the runway is conservatively empty.
  const before = tileset.getBufferedRunway(0, 1);
  expect(before.simMs).toBe(0);
  expect(before.complete).toBe(false);
  await settle();
}

describe('SpatiotemporalTileset.getBufferedRunway', () => {
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

describe('SpatiotemporalTileset.estimateCost', () => {
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

describe('SpatiotemporalTileset.estimateTimeToReadyMs', () => {
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
});

describe('SpatiotemporalTileset.getBufferedRanges', () => {
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

describe('SpatiotemporalTileset onBufferChange', () => {
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

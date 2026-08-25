/**
 * G3 — the loader invariants that had no test (tile-loading audit 2026-08:
 * §2 G3, evidence TO-5 "smallest deterministic test for each").
 *
 * Same harness as the QoE gate (`helpers/recorded-source.ts`): the REAL
 * `SpatioTemporalTileset`, the REAL `PlaybackGovernor` where the invariant
 * is about the clock, a synthetic directory and a modelled link on fake
 * timers. One `it` per invariant, numbered as in the audit; each states the
 * regression it fails against, and where a knob can show the assertion is
 * live (a cap set huge vs tight) the test runs both arms.
 *
 * Not covered here, deliberately: TO-5 #6 "worker transfer is zero-copy" —
 * it lives in `tile-decoder.ts` / `tile-decoder.worker.ts` /
 * `tile-transferables.ts`, which another session is editing; and TO-5 #10
 * (pitch > 0 selection across the layer/tileset seam) belongs to
 * `packages/layers`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import {
  PREFETCH_CACHE_FRACTION,
  PREFETCH_MIN_BUDGET_BYTES,
  PREFETCH_MIN_BYTE_EXPANSION,
} from '../src/prefetch-policy';
import {
  KiB,
  MiB,
  MINUTE_MS,
  RecordedSource,
  SHAPE_FAST_FINE,
  SHAPE_SMALL,
  TICK_PROBE_INTERVAL_MS,
  VIEWPORT,
  installLoaderFakeTimers,
  restoreLoaderFakeTimers,
  runPlaybackSession,
  speedForFloorBuckets,
  tileKeyOf,
  type ArchiveShape,
} from './helpers/recorded-source';

const key = (z: number, x: number, t: number): string =>
  tileKeyOf({ z, x, y: 0, t });

describe('G3: loader invariants (tile-loading audit 2026-08)', () => {
  beforeEach(installLoaderFakeTimers);
  afterEach(restoreLoaderFakeTimers);

  it('G3-1: a tile key is fetched ONCE across the priority and prefetch queues — head lands on an in-flight prefetch slice, then on a still-queued one', async () => {
    // 400 KiB tiles: a cold 4 MiB slice holds ten, so buckets 1–10 go in
    // flight and 11–19 stay queued after the first prefetch pass.
    const shape: ArchiveShape = {
      name: 'dedup',
      bucketMs: 1000,
      nBuckets: 20,
      primaryZoom: 6,
      tilesPerBucket: 1,
      bytesPerTile: 400 * KiB,
      decodedExpansion: 2,
    };
    const source = new RecordedSource(shape);
    const tileset = new SpatioTemporalTileset(
      source.tilesetOptions({ maxCacheSize: 100 }),
    );
    const view = (time: number) => ({
      bounds: VIEWPORT,
      zoom: 6,
      time,
      timeWindow: 100,
    });
    // A high declared speed keeps the bucket-sized head jumps below the
    // speed-aware seek threshold, so nothing is flushed and re-requested.
    tileset.setAnimationState(true, 20);
    tileset.update(view(500), true);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      source.inflight.has(key(6, 0, 2000)),
      'bucket 2 rides the first prefetch slice',
    ).toBe(true);
    expect(
      source.inflight.has(key(6, 0, 11_000)),
      'bucket 11 is queued, not in flight',
    ).toBe(false);

    // The head reaches bucket 2 while its prefetch slice is in flight …
    tileset.update(view(2500), true);
    await vi.advanceTimersByTimeAsync(1);
    // … then bucket 11 while it is still QUEUED behind that slice.
    tileset.update(view(11_500), true);
    await vi.advanceTimersByTimeAsync(1);
    const bucket11 = source.requests.find((r) =>
      r.ids.some((id) => id.t === 11_000),
    );
    expect(
      bucket11,
      'bucket 11 was promoted to a need-now batch',
    ).toBeDefined();
    expect(bucket11!.lookahead).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);
    expect(source.loadCountByKey.get(key(6, 0, 2000))).toBe(1);
    expect(source.loadCountByKey.get(key(6, 0, 11_000))).toBe(1);
    // The invariant: no key was ever requested twice, by either queue.
    expect(
      source.multiplyRequested(),
      `duplicates=${source.duplicateRequests} requests=${source.tileRequests}`,
    ).toEqual([]);
    expect(source.duplicateRequests).toBe(0);
    tileset.finalize();
  });

  // PENDING A2-bytes. The residency bend A2 added to the prefetch floor
  // (`PrefetchPolicy.residencyCapacitySimMs`) is priced in TILE COUNT:
  // `enqueueBudget(maxCacheSize) ÷ keysPerBucket`. When the BYTE cap is the
  // binding limiter — here 8 MiB against 2 MiB tiles, the audit's own TO-5
  // #2 parameters, and the shape a bytes-split composite has — the
  // `speed × 5 s` floor (5 buckets = 10 MiB) still exceeds the cache, the
  // admission floor `PREFETCH_MIN_BUDGET_BYTES` (4 MiB compressed = the
  // whole cache four times over at expansion 8) and the throughput-sized
  // slice both ignore `maxCacheByteSize`, and the fetch → evict → refetch
  // loop the audit fixed for count caps survives for byte caps. Measured
  // 2026-08-24: 32 MiB resident against the 8 MiB cap, 344 runway evictions,
  // 333 refetches, bytesRequested 6.7× useful, 16 zero-length stalls. Owner:
  // `prefetch-policy.ts` / `spatiotemporal-tileset.ts`. Flip to `it` when
  // the bend also takes `PREFETCH_CACHE_FRACTION × maxCacheByteSize ÷
  // (expansion × bytesPerBucket)` into account.
  it('G3-2: cacheBytes ≤ maxCacheByteSize on EVERY frame while the runway is larger than a BYTE-bound cache (tight cap holds, huge cap proves the sampler bites)', async () => {
    const shape: ArchiveShape = {
      name: 'byte-bound',
      bucketMs: 1000,
      nBuckets: 120,
      primaryZoom: 6,
      tilesPerBucket: 1,
      bytesPerTile: 256 * KiB,
      decodedExpansion: 8,
    };
    const run = (maxCacheByteSize: number) =>
      runPlaybackSession({
        shape,
        speed: 1,
        wallMs: 60_000,
        timeWindow: 100,
        tileset: { maxCacheSize: 2000, maxCacheByteSize },
      });
    const tight = await run(8 * MiB);
    expect(tight.maxCacheBytes, `${tight.summary}`).toBeGreaterThan(4 * MiB);
    // The bound, and the two symptoms of a runway the cache cannot hold.
    expect(tight.overCapSamples, `${tight.summary}`).toBe(0);
    expect(tight.stats.runwayEvictions, `${tight.summary}`).toBe(0);
    expect(tight.source.refetches, `${tight.summary}`).toBe(0);
    // A3 reclaims on delivery through a one-frame coalescing timer, so the
    // most a sample may see over the cap is what landed that frame — and a
    // pass sized to the cache lands at most a couple of tiles at once.
    expect(tight.maxOverCapBytes, `${tight.summary}`).toBeLessThanOrEqual(
      4 * MiB,
    );

    const loose = await run(64 * MiB);
    expect(loose.maxCacheBytes, `${loose.summary}`).toBeGreaterThan(8 * MiB);
  }, 30_000); // two 60 s sessions of 3,750 frames: ~4 s real, more under load

  // PENDING B5 (loop-aware runway; `spatiotemporal-tileset.ts`
  // `getBufferedRunway`, another owner). Re-measured 2026-08-24 after the
  // governor's non-flushing wrap landed: the PLAN half holds — part (b)
  // below sees bucket 0 requested from 8.5 s — and the RUNWAY half still
  // does not: `getBufferedRunway(9000, 1, 4000)` reads
  // `{simMs: 1000, complete: true}` with the loop start unloaded, i.e. it
  // clamps at the dataset end instead of wrapping modulo the loop window
  // (part (a)), and the governor's post-wrap gate is priced on that. Flip to
  // `it` when the runway wraps.
  it.fails('G3-3: PENDING B5 — loop-wrap continuity: the runway wraps modulo the loop window and the loop start is fetched before the head arrives', async () => {
    const shape: ArchiveShape = {
      name: 'loop',
      bucketMs: 1000,
      nBuckets: 10,
      primaryZoom: 6,
      tilesPerBucket: 1,
      bytesPerTile: 10 * KiB,
      decodedExpansion: 2,
    };
    // (a) readiness: buckets 8–9 resident, 0–1 not, loop [0, 10 s).
    const a = new RecordedSource(shape);
    const ta = new SpatioTemporalTileset(
      a.tilesetOptions({ enablePrefetch: false }),
    );
    ta.setLoopWindow({ start: 0, end: 10_000 });
    ta.update(
      { bounds: VIEWPORT, zoom: 6, time: 9000, timeWindow: 2000 },
      true,
    );
    ta.getBufferedRunway(9000, 1); // switch coverage tracking on
    await vi.advanceTimersByTimeAsync(500);
    expect(a.loadCountByKey.get(key(6, 0, 8000))).toBe(1);
    expect(a.loadCountByKey.get(key(6, 0, 9000))).toBe(1);
    const runway = ta.getBufferedRunway(9000, 1, 4000);
    expect(runway.complete, `${JSON.stringify(runway)}`).toBe(false);
    expect(runway.bytesPending, `${JSON.stringify(runway)}`).toBeGreaterThan(0);
    ta.finalize();

    // (b) continuity: animating toward the lap boundary prefetches bucket 0.
    const b = new RecordedSource(shape);
    const tb = new SpatioTemporalTileset(
      b.tilesetOptions({ prefetchAhead: 3000, prefetchSteps: 1 }),
    );
    tb.setLoopWindow({ start: 0, end: 10_000 });
    tb.setAnimationState(true, 1);
    tb.update({ bounds: VIEWPORT, zoom: 6, time: 8500, timeWindow: 100 }, true);
    await vi.advanceTimersByTimeAsync(600);
    expect(
      b.requestCountByKey.get(key(6, 0, 0)),
      `requested: ${[...b.requestCountByKey.keys()].join(' ')}`,
    ).toBe(1);
    tb.finalize();
  });

  // PENDING governor (owner: `packages/playback/src/playback-governor.ts`).
  // Red for a real reason, traced frame by frame 2026-08-24: when a link
  // slows mid-slice the throughput EWMA is stale (no transfer has completed
  // at the new rate), so the canplaythrough predictor passes the
  // `buffering` gate with `runway.simMs === 0` — its `PLAYTHROUGH_MIN_WALL_MS`
  // (250 ms) budget at the stale rate "covers" the first missing buckets
  // although NOTHING is resident under the head. `refreshFrontier` then
  // probes from a head already inside the gap, gets `simMs = 0`, and anchors
  // `bufferedUntil` at the head itself, so the next tick's clamp snaps to
  // where the head already was instead of back to the end of resident data.
  // Net: one frame of advance every two ticks into unloaded data, a
  // zero-length gate + snap-back per step — 467 `buffering` entries with
  // `totalStallMs 0`, and the head 825,600 sim-ms (688 wall-ms, ~7 buckets)
  // past resident data, vs the ≤ 200 ms the clamp documents. Two fixes, both
  // governor-side: a gate must not pass on the predictor without current
  // data (`runway.simMs > 0 || complete` — HAVE_ENOUGH_DATA implies
  // HAVE_CURRENT_DATA), and a zero-runway probe must anchor the frontier
  // BEHIND the head (`getBufferedRanges`), not at it. Flip to `it` then.
  it('G3-4: the clock never runs more than one probe interval past resident data — sampled every 16 ms for 60 s on a bursty link that forces real stalls', async () => {
    // F at 1,200× (0.92 MB/s demand) on a link that is 4 MB/s for 3 s of
    // every 6 s and 0.2 MB/s for the rest: each slow phase drains the
    // 33-bucket runway, so the governor must gate, and the property is that
    // every gate closed BEFORE the head left resident data (TO-5 #4:
    // overrun ≤ |speed| × TICK_PROBE_INTERVAL_MS, the clamp's own window).
    //
    // WHY 1,200× and not the A2 2,400×: the resume gate is
    // `2 × 2 s × speed` of runway, the loader's A2 residency capacity is 33
    // buckets, so the gate can only pass on the canplaythrough predictor —
    // `ETA(missing) ≤ runway wall-time`, i.e. `(4 s − R) × demand ≤ R × link`
    // with `R = 33 buckets / speed`. On a 4 MB/s link that holds for
    // speed ≲ 1,870×; at 2,400× every real stall ends in the 8 s escape
    // hatch and degraded creep (measured: creepMs 35,424 of 60 s), which
    // pins the head AT the frontier by design and is not this property.
    // That ceiling is the audit's config-side A2 finding seen from the
    // governor (`targetPlaybackSeconds` on nyc-taxi-paths).
    const speed = speedForFloorBuckets(SHAPE_FAST_FINE, 100);
    const r = await runPlaybackSession({
      shape: SHAPE_FAST_FINE,
      link: {
        bytesPerMs: 4000,
        latencyMs: 40,
        schedule: { periodMs: 6000, slowFromMs: 3000, slowFactor: 0.05 },
      },
      speed,
      wallMs: 60_000,
      frameMs: 16,
      timeWindow: SHAPE_FAST_FINE.bucketMs,
      tileset: { maxCacheSize: 2000, maxCacheByteSize: 10 * MiB },
    });
    expect(r.samples, `${r.summary}`).toBe(3750);
    expect(
      r.overrunViolations,
      `max overrun ${r.maxOverrunSimMs} sim-ms vs allowance ${
        speed * TICK_PROBE_INTERVAL_MS
      } — ${r.summary}`,
    ).toBe(0);
    // Precondition for the strict reading: no escape-hatch creep, which
    // pins the head AT the frontier by design.
    expect(r.qoe.degradedResumeCount, `${r.summary}`).toBe(0);
    // The property was exercised under real pressure.
    expect(r.qoe.stallCount, `${r.summary}`).toBeGreaterThan(0);
    expect(r.qoe.totalStallMs, `${r.summary}`).toBeGreaterThan(0);
    // And the loader never thrashed while it happened.
    expect(r.stats.runwayEvictions, `${r.summary}`).toBe(0);
    expect(r.source.refetches, `${r.summary}`).toBe(0);
  }, 30_000); // 3,750 frames of a gating governor: ~7 s real

  it('G3-5: an evicted tile fires onTileUnload exactly once, while its header (and its bytes) are still registered', async () => {
    const shape: ArchiveShape = {
      name: 'unload',
      bucketMs: 1000,
      nBuckets: 3,
      primaryZoom: 6,
      tilesPerBucket: 1,
      bytesPerTile: 10 * KiB,
      decodedExpansion: 2,
    };
    const source = new RecordedSource(shape);
    const inside: Array<{ tileCount: number; cacheBytes: number }> = [];
    let tileset: SpatioTemporalTileset;
    tileset = new SpatioTemporalTileset(
      source.tilesetOptions({
        enablePrefetch: false,
        maxCacheSize: 2,
        onTileUnload: (tile) => {
          source.onTileUnload(tile);
          const s = tileset.getCacheStats();
          inside.push({ tileCount: s.tileCount, cacheBytes: s.cacheBytes });
        },
      }),
    );
    const load = async (bucket: number): Promise<void> => {
      tileset.update(
        {
          bounds: VIEWPORT,
          zoom: 6,
          time: bucket * 1000 + 500,
          timeWindow: 100,
        },
        true,
      );
      await vi.advanceTimersByTimeAsync(100);
    };
    await load(0);
    await load(1);
    expect(tileset.getCacheStats().tileCount).toBe(2);
    // The third load pushes the cache over its 2-tile cap; A3's delivery
    // eviction (one-frame coalesce) reclaims one.
    await load(2);
    await vi.advanceTimersByTimeAsync(50);
    const after = tileset.getCacheStats();
    expect(inside.length, `${JSON.stringify(inside)}`).toBe(1);
    for (const [k, n] of source.unloadCountByKey) expect(n, `${k}`).toBe(1);
    // Inside the callback the header was still registered and its bytes
    // still counted; both dropped only after it returned.
    expect(inside[0].tileCount).toBe(after.tileCount + 1);
    expect(inside[0].cacheBytes).toBe(after.cacheBytes + 20 * KiB);
    expect(after.tileCount).toBe(2);
    tileset.finalize();
  });

  it('G3-6: a 404 pack costs exactly one request and one onTileError, reports blockedPermanently, and the governor plays through it without holding the clock', async () => {
    const shape: ArchiveShape = {
      name: '404',
      bucketMs: 1000,
      nBuckets: 3,
      primaryZoom: 6,
      tilesPerBucket: 1,
      bytesPerTile: 10 * KiB,
      decodedExpansion: 2,
    };
    let blockedSeen = false;
    const r = await runPlaybackSession({
      shape,
      speed: 1,
      wallMs: 5000,
      timeWindow: 100,
      permanentlyMissing: (id) => id.t === 1000,
      onFrame: (f) => {
        if (f.tileset.getBufferedRunway(0, 1, 3000).blockedPermanently) {
          blockedSeen = true;
        }
      },
    });
    const m = r.summary;
    expect(r.source.requestCountByKey.get(key(6, 0, 1000)), `${m}`).toBe(1);
    expect(
      r.source.errors.map((e) => `${tileKeyOf(e.id)}:${e.error.name}`),
      `${m}`,
    ).toEqual([`${key(6, 0, 1000)}:PermanentFetchError`]);
    expect(blockedSeen, `${m}`).toBe(true);
    expect(r.qoe.blockedPermanentlyCount, `${m}`).toBeGreaterThanOrEqual(1);
    expect(r.qoe.stallCount, `${m}`).toBe(0);
    expect(r.qoe.totalStallMs, `${m}`).toBeLessThanOrEqual(
      TICK_PROBE_INTERVAL_MS,
    );
    expect(r.qoe.degradedResumeCount, `${m}`).toBe(0);
    // Played through the dead bucket into the live one behind it.
    expect(r.endTime, `${m}`).toBeGreaterThan(2000);
    expect(r.source.loadCountByKey.get(key(6, 0, 2000)), `${m}`).toBe(1);
    expect(r.frontierViolations, `${m}`).toBe(0);
  });

  it('G3-7: a single-bucket archive plays 60 s with exactly one gate — the start — and no stall, creep or degraded resume', async () => {
    const r = await runPlaybackSession({
      shape: SHAPE_SMALL,
      speed: 10,
      wallMs: 60_000,
      timeWindow: MINUTE_MS,
    });
    expect(r.qoe.gateEntriesByReason, `${r.summary}`).toEqual({
      starting: 1,
      buffering: 0,
      seeking: 0,
    });
    expect(r.qoe.stallCount, `${r.summary}`).toBe(0);
    expect(r.qoe.totalStallMs, `${r.summary}`).toBe(0);
    expect(r.qoe.degradedResumeCount, `${r.summary}`).toBe(0);
    expect(r.qoe.creepMs, `${r.summary}`).toBe(0);
    expect(r.qoe.frontierSnapBacks, `${r.summary}`).toBe(0);
    expect(r.state, `${r.summary}`).toBe('playing');
    expect(r.samples, `${r.summary}`).toBe(3750);
  });

  it('G3-8: cold start on the small archive — one batch and three directory walks before the first onTileLoad', async () => {
    const r = await runPlaybackSession({
      shape: SHAPE_SMALL,
      speed: 10,
      wallMs: 1000,
      timeWindow: MINUTE_MS,
    });
    const s = r.source;
    const m = `${r.summary} directoryCallsAtFirstLoad=${s.directoryCallsAtFirstLoad} batchCallsAtFirstLoad=${s.batchCallsAtFirstLoad}`;
    expect(s.roundTripsToFirstLoad, `${m}`).not.toBeNull();
    // Exactly one batch carries the four tiles. The directory is walked
    // three times before it lands — selection, the coverage index, and the
    // animation prefetch pass the start gate switches on; on the real
    // reader those are resident-directory reads, not round trips, so the
    // one network round trip to first tile is the batch. Pinned exactly so
    // a regression to per-zoom or per-tile requests moves a number.
    expect(s.batchCallsAtFirstLoad, `${m}`).toBe(1);
    expect(s.directoryCallsAtFirstLoad, `${m}`).toBe(3);
    expect(s.roundTripsToFirstLoad, `${m}`).toBe(4);
    expect(s.tileRequests, `${m}`).toBe(SHAPE_SMALL.tilesPerBucket);
  });

  it('G3-9: bytes committed ahead of the playhead never exceed the prefetch cache fraction (tight cap holds on every frame; huge cap proves the sampler bites)', async () => {
    // Count budget out of the way (½ of 100,000 tiles), so the BYTE budget
    // — `PREFETCH_CACHE_FRACTION × maxCacheByteSize ÷ expansion`, floored at
    // `PREFETCH_MIN_BUDGET_BYTES` — is the only thing bounding the runway
    // against a 200-bucket × 30-tile × 2 KiB (12 MB) horizon.
    const shape: ArchiveShape = {
      name: 'prefetch-bytes',
      bucketMs: MINUTE_MS,
      nBuckets: 3000,
      primaryZoom: 14,
      tilesPerBucket: 30,
      bytesPerTile: 2 * KiB,
      decodedExpansion: 2.5,
    };
    const run = async (maxCacheByteSize: number, wallMs: number) => {
      let maxAhead = 0;
      const r = await runPlaybackSession({
        shape,
        speed: speedForFloorBuckets(shape, 200),
        wallMs,
        frameMs: 32,
        timeWindow: shape.bucketMs,
        tileset: { maxCacheSize: 100_000, maxCacheByteSize },
        onFrame: (f) => {
          const ahead = f.source.committedAheadBytes(f.time);
          if (ahead > maxAhead) maxAhead = ahead;
        },
      });
      return { r, maxAhead };
    };
    const cap = 16 * MiB;
    // The loosest reading of the bound: the measured expansion can never be
    // below PREFETCH_MIN_BYTE_EXPANSION, and the first tile of a pass is
    // admitted unconditionally.
    const bound =
      Math.max(
        PREFETCH_MIN_BUDGET_BYTES,
        (PREFETCH_CACHE_FRACTION * cap) / PREFETCH_MIN_BYTE_EXPANSION,
      ) + shape.bytesPerTile;
    const tight = await run(cap, 30_000);
    expect(
      tight.maxAhead,
      `max committed-ahead ${tight.maxAhead} vs bound ${bound} — ${tight.r.summary}`,
    ).toBeLessThanOrEqual(bound);
    expect(tight.r.stats.runwayEvictions, `${tight.r.summary}`).toBe(0);
    expect(tight.maxAhead, `${tight.r.summary}`).toBeGreaterThan(0);

    // The 1 GiB arm evicts nothing, so its header map (and the per-frame
    // selection pass over it) only grows; 10 s is three times what the
    // horizon needs to fill at 4 MB/s.
    const loose = await run(1024 * MiB, 10_000);
    expect(loose.maxAhead, `${loose.r.summary}`).toBeGreaterThan(bound);
  }, 30_000);
});

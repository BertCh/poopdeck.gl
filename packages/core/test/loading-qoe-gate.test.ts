/**
 * G1 — the loading-QoE gate (tile-loading audit 2026-08: §2 G1, §6 Wave 5,
 * evidence TO-1).
 *
 * Before this file there was no regression gate on any loading or playback
 * metric: the bench replayer re-implements eviction in JS and never imports
 * the tileset or the governor; CI's browser gate asserts "non-blank after
 * 8 s". Every one of A1–A3 / B1–B5 shipped green. This gate runs the REAL
 * objects — `SpatioTemporalTileset` and `PlaybackGovernor` on a
 * `TimeController` driven by `attachExternalClock()` — over three archive
 * shapes on a modelled 4 MB/s link, entirely on fake timers, and asserts the
 * §6 Wave-5 acceptance criteria with the measured numbers in every message:
 *
 *   runwayEvictions = 0 · refetches = 0 · stalls ≤ 1 · no degraded resume ·
 *   clock ≤ frontier on every frame · cacheBytes ≤ cap on every frame ·
 *   bytesRequested ≤ k × bytesUseful
 *
 * The three shapes are the audit's §1 rows in miniature: S is the small
 * archive the loader already handled cleanly (the control); L is the
 * earthquakes / hurricanes shape (hourly buckets over years, 12,000 z0–z1
 * storyboard candidates — A1); F is nyc-taxi-paths (fine buckets at a speed
 * whose `speed × 5 s` prefetch floor is 200 buckets against a 2,000-tile
 * cache — A2). The loop-wrap case rides F and depends on B5.
 *
 * "60 s" is 60 s of the fake WALL clock; the sim clock covers
 * `60 s × speed` of dataset time (1,200 hourly buckets on L, 2,400 minute
 * buckets on F). L steps a 32 ms host frame and F (with the loop case) a
 * 40 ms one so the whole gate stays under 5 s real; S steps 16 ms.
 *
 * Counters computed in the harness (`refetches`, `bytesRequested`,
 * `bytesUseful`, request counts) are the ones G2 is adding to
 * `getCacheStats()`; swap them in when they land (see the report).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PIN_COUNT_FRACTION } from '../src/spatiotemporal-tileset';
import {
  MiB,
  MINUTE_MS,
  SHAPE_FAST_FINE,
  SHAPE_LONG_SPARSE,
  SHAPE_SMALL,
  installLoaderFakeTimers,
  restoreLoaderFakeTimers,
  runPlaybackSession,
  speedForFloorBuckets,
  type ArchiveShape,
  type SessionConfig,
  type SessionResult,
} from './helpers/recorded-source';

/** Fake wall-clock every shape plays for. */
const PLAY_WALL_MS = 60_000;

/**
 * Per-case timeout. Each case is 1–3 s real in isolation, but a 60 s fake
 * session of 1,500–3,750 frames can pass vitest's 5 s default under a full
 * parallel suite — and a timed-out session keeps running on the restored
 * REAL timers and corrupts the next case (seen: L timed out, F ended `idle`).
 */
const GATE_TIMEOUT_MS = 30_000;

/** The default storyboard byte budget (`DEFAULT_OVERVIEW_BUDGET_BYTES`, not exported). */
const OVERVIEW_BUDGET_BYTES = 20 * MiB;

interface GateCase {
  readonly shape: ArchiveShape;
  readonly session: Omit<SessionConfig, 'shape'>;
  /**
   * `bytesRequested ≤ bytesRatioMax × bytesUseful`. 2 is the audit's Wave-1
   * acceptance ("nyc-taxi-paths play bytes ≤ 2× useful"). L carries 3: the
   * storyboard tier is legitimately speculative, and what bounds it is
   * `PIN_COUNT_FRACTION` (¼ of the tile cap, A1) plus the 20 MiB byte
   * budget — both cache-sized quantities against a run that plays ≥ 24
   * cache-fulls, so the extra 1× is generous; the L test below pins each
   * half of it exactly.
   */
  readonly bytesRatioMax: number;
}

const CASES: readonly GateCase[] = [
  {
    shape: SHAPE_SMALL,
    session: {
      speed: 10, // 600 s of sim in 60 s — stays inside the one-hour bucket
      wallMs: PLAY_WALL_MS,
      timeWindow: MINUTE_MS,
      tileset: { maxCacheSize: 2000, maxCacheByteSize: 16 * MiB },
    },
    bytesRatioMax: 2,
  },
  {
    shape: SHAPE_LONG_SPARSE,
    session: {
      // 100 buckets per 5 s floor: 20 buckets/s, 1,200 of the 3,000 hourly
      // buckets in 60 s — the earthquakes sweep.
      speed: speedForFloorBuckets(SHAPE_LONG_SPARSE, 100),
      wallMs: PLAY_WALL_MS,
      frameMs: 32,
      timeWindow: SHAPE_LONG_SPARSE.bucketMs,
      tileset: { maxCacheSize: 2000, maxCacheByteSize: 16 * MiB },
      preloadOverview: true,
    },
    bytesRatioMax: 3,
  },
  {
    shape: SHAPE_FAST_FINE,
    session: {
      // speed × 5 s = 200 buckets (6,000 tiles) against maxCacheSize 2,000:
      // the A2 regime. 10 MiB of decoded cache ≈ 1,700 tiles, so the byte
      // cap binds before the count cap and both eviction limits are live.
      speed: speedForFloorBuckets(SHAPE_FAST_FINE, 200),
      wallMs: PLAY_WALL_MS,
      frameMs: 40,
      timeWindow: SHAPE_FAST_FINE.bucketMs,
      tileset: { maxCacheSize: 2000, maxCacheByteSize: 10 * MiB },
    },
    bytesRatioMax: 2,
  },
];

function assertGate(r: SessionResult, bytesRatioMax: number): void {
  const m = r.summary;
  expect(r.samples, `${m}`).toBeGreaterThan(0);
  expect(r.visitedBuckets, `${m}`).toBeGreaterThan(0);
  expect(r.stats.runwayEvictions, `runwayEvictions — ${m}`).toBe(0);
  expect(r.source.refetches, `refetches — ${m}`).toBe(0);
  expect(r.qoe.stallCount, `stallCount — ${m}`).toBeLessThanOrEqual(1);
  expect(r.qoe.degradedResumeCount, `degradedResumeCount — ${m}`).toBe(0);
  // Strict form: the clock never RAN over a non-resident bucket — not even
  // for the one probe interval the governor's per-tick clamp allows itself.
  expect(
    r.frontierViolations,
    `clock ran past the buffered frontier (first at ${JSON.stringify(
      r.firstFrontierViolation,
    )}) — ${m}`,
  ).toBe(0);
  expect(r.overrunViolations, `overrun > speed × probe interval — ${m}`).toBe(
    0,
  );
  expect(r.overCapSamples, `cacheBytes over maxCacheByteSize — ${m}`).toBe(0);
  expect(r.bytesUseful, `${m}`).toBeGreaterThan(0);
  expect(
    r.bytesRatio,
    `bytesRequested/bytesUseful = ${r.bytesRequested}/${r.bytesUseful} — ${m}`,
  ).toBeLessThanOrEqual(bytesRatioMax);
  // The run must actually have played: the governor ends playing.
  expect(r.state, `${m}`).toBe('playing');
}

describe('G1: loading-QoE gate — real tileset + real governor on a modelled 4 MB/s link', () => {
  beforeEach(installLoaderFakeTimers);
  afterEach(restoreLoaderFakeTimers);

  it(
    'S small: 60 s at 10× — the control: one directory pass + one batch, no gate after start, ratio exactly 1',
    async () => {
      const c = CASES[0];
      const r = await runPlaybackSession({ shape: c.shape, ...c.session });
      assertGate(r, 1);
      expect(r.source.tileRequests, `${r.summary}`).toBe(
        c.shape.tilesPerBucket,
      );
      expect(r.source.batchCalls, `${r.summary}`).toBe(1);
      expect(r.qoe.gateEntriesByReason, `${r.summary}`).toEqual({
        starting: 1,
        buffering: 0,
        seeking: 0,
      });
      expect(r.qoe.frontierSnapBacks, `${r.summary}`).toBe(0);
      expect(r.stats.evictions, `${r.summary}`).toBe(0);
      expect(r.endTime, `${r.summary}`).toBeGreaterThan(
        c.session.speed * PLAY_WALL_MS * 0.9,
      );
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'L long-sparse: 60 s at 72,000× — storyboard refused on COUNT (A1), pins nothing, costs no bytes; play path ≤ 2× useful',
    async () => {
      const c = CASES[1];
      const r = await runPlaybackSession({ shape: c.shape, ...c.session });
      assertGate(r, c.bytesRatioMax);
      expect(r.endTime, `${r.summary}`).toBeGreaterThan(
        c.session.speed * PLAY_WALL_MS * 0.9,
      );
      // 12,000 candidates against ¼ × 2,000 = 500: the count gate (not the
      // 20 MiB byte gate — the tier is 12 MB) must be the one that refuses,
      // and it must refuse BEFORE fetching anything.
      expect(r.overview, `${r.summary}`).not.toBeNull();
      expect(r.overview!.loaded, `${JSON.stringify(r.overview)}`).toBe(false);
      expect(r.overview!.reason, `${JSON.stringify(r.overview)}`).toBe(
        'over-count',
      );
      expect(r.overview!.tiles, `${JSON.stringify(r.overview)}`).toBe(12_000);
      expect(r.stats.pinnedCount, `${r.summary}`).toBeLessThanOrEqual(
        PIN_COUNT_FRACTION * 2000,
      );
      expect(r.stats.pinnedCount, `${r.summary}`).toBe(0);
      const overviewBytes =
        r.source.bytesRequestedAtZoom(0) + r.source.bytesRequestedAtZoom(1);
      expect(overviewBytes, `${r.summary}`).toBeLessThanOrEqual(
        OVERVIEW_BUDGET_BYTES,
      );
      expect(overviewBytes, `${r.summary}`).toBe(0);
      // The play path alone meets the Wave-1 2× bound; the 3× headline only
      // adds room for a (here refused) storyboard.
      const playBytes = r.source.bytesRequestedAtZoom(c.shape.primaryZoom);
      expect(
        playBytes,
        `primary-zoom bytes ${playBytes} vs useful ${r.bytesUseful} — ${r.summary}`,
      ).toBeLessThanOrEqual(2 * r.bytesUseful);
      // The tile cap was genuinely binding (1,200 buckets × 40 tiles played
      // through a 2,000-tile cache), so the zero above is a real result.
      expect(r.stats.evictions, `${r.summary}`).toBeGreaterThan(0);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'F fast-fine: 60 s at 2,400× (speed × 5 s = 200 buckets vs a 2,000-tile / 10 MiB cache, A2) — no runway evictions, no refetches, ≤ 1 stall, bytes ≤ 2× useful',
    async () => {
      const c = CASES[2];
      const r = await runPlaybackSession({ shape: c.shape, ...c.session });
      assertGate(r, c.bytesRatioMax);
      expect(r.endTime, `${r.summary}`).toBeGreaterThan(
        c.session.speed * PLAY_WALL_MS * 0.9,
      );
      // Both caps were binding: the byte cap (10 MiB ≈ 1,700 tiles) is the
      // tighter one, and the run played 2,400 buckets × 30 tiles through it.
      expect(r.stats.evictions, `${r.summary}`).toBeGreaterThan(0);
      expect(r.maxCacheBytes, `${r.summary}`).toBeGreaterThan(
        r.maxCacheByteSize * 0.5,
      );
      // A2's residency bound: the pressure ladder never had to engage.
      expect(r.stats.prefetchPressureScale, `${r.summary}`).toBe(1);
    },
    GATE_TIMEOUT_MS,
  );

  // The loop-wrap case (B5: loop-aware prefetch plan + non-flushing wrap).
  // Green 2026-08-24 once both halves landed: on the wrap frame the loop
  // start is already resident (`runwaySimMs 60000`), the clock never pauses
  // across the wrap, the run stays at zero runway evictions / zero refetches
  // (`wrapHandler` no longer flushes a loop-aware source), and the wrap's
  // `seeking` gate passes synchronously. The honest counters for that last
  // fact: the wrap IS a `seeking` ENTRY (`enterGate` counts every entry, and
  // a wrap enters), but not a HOLD — `gateHoldsByReason` (G3-4c) counts only
  // gates whose first evaluation failed, so `seeking` holds must read 0.
  it(
    'F loop wrap: the buckets after the wrap are resident before the head arrives and the wrap opens no `seeking` gate',
    async () => {
      const c = CASES[2];
      const shape = c.shape;
      const speed = c.session.speed;
      const datasetEnd = shape.nBuckets * shape.bucketMs;
      // Start 10 wall-s (400 buckets) before the lap boundary; play 24 s so the
      // wrap lands mid-run with 14 s of post-wrap playback to observe.
      const startTime = datasetEnd - speed * 10_000;
      let wrapFrame: {
        time: number;
        runwaySimMs: number;
        playing: boolean;
      } | null = null;
      let pausedAfterWrap = 0;
      const r = await runPlaybackSession({
        shape,
        ...c.session,
        wallMs: 24_000,
        startTime,
        loop: true,
        onFrame: (f) => {
          if (wrapFrame === null && f.time < startTime) {
            wrapFrame = {
              time: f.time,
              runwaySimMs: f.runway.simMs,
              playing: f.tc.isPlaying(),
            };
          } else if (wrapFrame !== null && !f.tc.isPlaying()) {
            pausedAfterWrap++;
          }
        },
      });
      expect(r.wraps, `${r.summary}`).toBeGreaterThanOrEqual(1);
      expect(wrapFrame, `${r.summary}`).not.toBeNull();
      // Continuity: on the wrap frame the loop start is already resident.
      expect(
        wrapFrame!.runwaySimMs,
        `runway at the wrap frame ${JSON.stringify(wrapFrame)} — ${r.summary}`,
      ).toBeGreaterThan(0);
      // The clock never paused across the wrap.
      expect(wrapFrame!.playing, `${JSON.stringify(wrapFrame)}`).toBe(true);
      expect(pausedAfterWrap, `${r.summary}`).toBe(0);
      // And the governor HELD no seek-style gate for it: the wrap is counted
      // as an entry (it is one) but passed synchronously, so it never froze
      // the clock.
      expect(r.qoe.gateEntriesByReason.seeking, `${r.summary}`).toBe(1);
      expect(r.qoe.gateHoldsByReason.seeking, `${r.summary}`).toBe(0);
      expect(r.qoe.gateHoldsByReason.buffering, `${r.summary}`).toBe(0);
      assertGate(r, c.bytesRatioMax);
    },
    GATE_TIMEOUT_MS,
  );
});

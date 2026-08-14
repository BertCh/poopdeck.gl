/**
 * Prefetch policy — the decision surface behind speculative tile loading,
 * exercised without any tileset, archive, network or timer.
 *
 * Wall time is injected, so the pressure ladder's recovery (gated on
 * PRESSURE_RECOVERY_QUIET_MS of quiet and paced at one step per
 * PRESSURE_RECOVERY_STEP_INTERVAL_MS) is driven exactly instead of waited out.
 */

import { describe, it, expect } from 'vitest';
import {
  PrefetchPolicy,
  DIRECTION_FLIP_THRESHOLD,
  MAX_PREFETCH_BUCKETS,
  PREFETCH_CAP_FLOOR_REAL_MS,
  PREFETCH_DEBOUNCE_MS,
  PREFETCH_LOOKAHEAD_REAL_MS,
  PREFETCH_CACHE_FRACTION,
  PREFETCH_BYTE_EXPANSION_MIN_SAMPLES,
  PREFETCH_COLD_BYTE_EXPANSION,
  PREFETCH_MAX_BYTE_EXPANSION,
  PREFETCH_MIN_BYTE_EXPANSION,
  PREFETCH_MIN_BUDGET_BYTES,
  PREFETCH_MIN_BUDGET_TILES,
  byteExpansionRatio,
  PREFETCH_RELOAD_FRACTION,
  PREFETCH_SLICE_COLD_BYTES,
  PREFETCH_SLICE_MAX_BYTES,
  PREFETCH_SLICE_MIN_BYTES,
  PREFETCH_SLICE_TARGET_REAL_MS,
  PRESSURE_RECOVERY_QUIET_MS,
  PRESSURE_RECOVERY_STEP_INTERVAL_MS,
  PRESSURE_SCALE_DECAY,
  PRESSURE_SCALE_MIN,
  PRESSURE_SCALE_RECOVERY_STEP,
  type PrefetchPlanRequest,
} from '../src/prefetch-policy';

/** A wall clock the test drives by hand. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: (): number => t,
    advance(ms: number): void {
      t += ms;
    },
  };
}

const PLAYHEAD = 5_000_000;

/**
 * Baseline request: paused (speed 0), so the horizon is the configured
 * `timeWindow × prefetchSteps` = 4000 ms and nothing else binds.
 * The bucket cap, max(64 × 100, 0) = 6400, sits above it and stays inert.
 */
const baseRequest = (
  over: Partial<PrefetchPlanRequest> = {},
): PrefetchPlanRequest => ({
  time: PLAYHEAD,
  timeWindow: 1000,
  bucketMs: 100,
  prefetchAhead: 0,
  prefetchSteps: 4,
  pipelineIdle: true,
  ...over,
});

/** Horizon for one request, bypassing the runway throttle. */
const horizon = (
  policy: PrefetchPolicy,
  over: Partial<PrefetchPlanRequest> = {},
) => policy.plan(baseRequest({ ...over, pipelineIdle: true }))!.effectiveAhead;

/**
 * The gate floor for `baseRequest` at speed 0: `max(bucketMs, timeWindow,
 * speed × PREFETCH_CAP_FLOOR_REAL_MS)` = max(100, 1000, 0). No mechanism —
 * cap, solve or ladder — may return a horizon below this.
 */
const GATE_FLOOR = 1000;
/** `baseRequest`'s horizon before any byte reasoning: timeWindow × 4 steps. */
const UNSOLVED = 4000;
const BYTES_PER_BUCKET = 1000;

/**
 * A MONOTONE byte oracle over `baseRequest`'s 100 ms bucket grid:
 * {@link BYTES_PER_BUCKET} per bucket of horizon, so `bytes(h) = 10 × h`. Every
 * probe is recorded, which is how the tests below assert the solve bisects
 * (a handful of calls) rather than scanning the 31 candidate boundaries.
 */
function byteOracle(opts: { exact?: boolean } = {}) {
  const probes: number[] = [];
  return {
    probes,
    fn: (horizonSimMs: number): { bytes: number; exact: boolean } => {
      probes.push(horizonSimMs);
      return {
        bytes: (horizonSimMs / 100) * BYTES_PER_BUCKET,
        exact: opts.exact ?? true,
      };
    },
  };
}

/** Horizon under a byte budget, with the oracle above. */
const solvedHorizon = (
  policy: PrefetchPolicy,
  byteBudget: number,
  over: Partial<PrefetchPlanRequest> = {},
) => horizon(policy, { byteBudget, bytesForHorizon: byteOracle().fn, ...over });

describe('PrefetchPolicy direction hysteresis', () => {
  it('starts forward', () => {
    expect(new PrefetchPolicy(fakeClock().now).direction).toBe(1);
  });

  it('does not flip on a single reversed frame', () => {
    const policy = new PrefetchPolicy(fakeClock().now);

    expect(policy.observeTimeDelta(-5)).toBe(false);
    expect(policy.direction).toBe(1);
  });

  it('flips only once the reversal persists for the threshold', () => {
    const policy = new PrefetchPolicy(fakeClock().now);

    for (let i = 1; i < DIRECTION_FLIP_THRESHOLD; i++) {
      expect(policy.observeTimeDelta(-5)).toBe(false);
      expect(policy.direction).toBe(1);
    }
    expect(policy.observeTimeDelta(-5)).toBe(true);
    expect(policy.direction).toBe(-1);
  });

  it('a frame in the committed direction re-arms the hysteresis', () => {
    const policy = new PrefetchPolicy(fakeClock().now);

    // One short of a flip, then a forward frame clears the tally.
    for (let i = 1; i < DIRECTION_FLIP_THRESHOLD; i++)
      policy.observeTimeDelta(-5);
    expect(policy.observeTimeDelta(+5)).toBe(false);

    // The reversal must now persist for the full threshold all over again.
    for (let i = 1; i < DIRECTION_FLIP_THRESHOLD; i++) {
      expect(policy.observeTimeDelta(-5)).toBe(false);
    }
    expect(policy.direction).toBe(1);
    expect(policy.observeTimeDelta(-5)).toBe(true);
    expect(policy.direction).toBe(-1);
  });

  it('a frozen clock (zero delta) is not evidence of direction', () => {
    const policy = new PrefetchPolicy(fakeClock().now);

    for (let i = 0; i < DIRECTION_FLIP_THRESHOLD * 3; i++) {
      expect(policy.observeTimeDelta(0)).toBe(false);
    }
    expect(policy.direction).toBe(1);
  });

  it('a signed speed commits the direction immediately, bypassing hysteresis', () => {
    const policy = new PrefetchPolicy(fakeClock().now);

    expect(policy.setAnimationState(true, -2).directionFlipped).toBe(true);
    expect(policy.direction).toBe(-1);
    // Already committed: repeating it is not a fresh flip.
    expect(policy.setAnimationState(true, -4).directionFlipped).toBe(false);
  });

  it('an unsigned (zero) speed leaves the committed direction alone', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    policy.setAnimationState(true, -2);

    expect(policy.setAnimationState(false, 0).directionFlipped).toBe(false);
    expect(policy.direction).toBe(-1);
  });

  it('reports whether the animation was already running', () => {
    const policy = new PrefetchPolicy(fakeClock().now);

    expect(policy.setAnimationState(true, 1).wasAnimating).toBe(false);
    expect(policy.setAnimationState(true, 1).wasAnimating).toBe(true);
    expect(policy.setAnimationState(false, 0).wasAnimating).toBe(true);
    expect(policy.isAnimating).toBe(false);
  });

  it('plans along the committed direction', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    policy.setAnimationState(true, -1);

    const plan = policy.plan(baseRequest())!;
    expect(plan.direction).toBe(-1);
    expect(plan.endTime).toBe(PLAYHEAD - plan.effectiveAhead);
    // The query range still runs low→high, widened by half a window.
    expect(plan.queryRange.start).toBe(plan.endTime - 500);
    expect(plan.queryRange.end).toBe(PLAYHEAD + 500);
  });

  it('ranks candidates by distance ahead, sorting behind-head buckets last', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    const forward = policy.plan(baseRequest())!;

    expect(forward.aheadDistance(PLAYHEAD + 300)).toBe(300);
    expect(forward.aheadDistance(PLAYHEAD)).toBe(0);
    expect(forward.aheadDistance(PLAYHEAD - 300)).toBeGreaterThan(
      forward.aheadDistance(PLAYHEAD + 1e12),
    );

    policy.setAnimationState(true, -1);
    const backward = policy.plan(baseRequest({ pipelineIdle: true }))!;
    expect(backward.aheadDistance(PLAYHEAD - 300)).toBe(300);
    expect(backward.aheadDistance(PLAYHEAD + 300)).toBeGreaterThan(
      backward.aheadDistance(PLAYHEAD - 1e12),
    );
  });
});

describe('PrefetchPolicy horizon bounds', () => {
  it('uses the configured window lookahead when paused', () => {
    const policy = new PrefetchPolicy(fakeClock().now);

    expect(horizon(policy)).toBe(4000); // timeWindow 1000 × 4 steps
    expect(horizon(policy, { prefetchAhead: 250 })).toBe(1000); // 250 × 4 steps
  });

  it('scales the horizon with playback speed', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    policy.setAnimationState(true, 2); // 2 sim-ms per real-ms

    // speed × LOOKAHEAD (16 000) beats the 4000 ms window lookahead, and the
    // bucket cap (max(64 × 100, 2 × 5000) = 10 000) then binds it.
    expect(horizon(policy)).toBe(10_000);
  });

  it('caps a fast playback at MAX_PREFETCH_BUCKETS buckets', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    const bucketMs = 60_000;
    const bucketCap = MAX_PREFETCH_BUCKETS * bucketMs;

    // Fast enough for the raw horizon to overshoot the bucket cap, but not so
    // fast that the speed-scaled floor lifts above it.
    const speed = 600;
    expect(speed * PREFETCH_LOOKAHEAD_REAL_MS).toBeGreaterThan(bucketCap);
    expect(speed * PREFETCH_CAP_FLOOR_REAL_MS).toBeLessThan(bucketCap);
    policy.setAnimationState(true, speed);

    expect(horizon(policy, { bucketMs, timeWindow: bucketMs })).toBe(bucketCap);
  });

  it('lifts the cap to the speed-scaled floor when the gates need more', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    const bucketMs = 60_000;
    const speed = 1000; // speed × FLOOR (5 000 000) exceeds 64 buckets
    policy.setAnimationState(true, speed);

    expect(horizon(policy, { bucketMs, timeWindow: bucketMs })).toBe(
      speed * PREFETCH_CAP_FLOOR_REAL_MS,
    );
  });

  it('skips the bucket cap for an archive with no temporal buckets', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    policy.setAnimationState(true, 600);

    expect(horizon(policy, { bucketMs: 0 })).toBe(
      600 * PREFETCH_LOOKAHEAD_REAL_MS,
    );
  });

  it('sizes the per-pass enqueue budget from the cache budget', () => {
    const policy = new PrefetchPolicy(fakeClock().now);

    expect(policy.enqueueBudget(1000)).toBe(500);
    // Tiny caches still get a workable floor.
    expect(policy.enqueueBudget(10)).toBe(PREFETCH_MIN_BUDGET_TILES);
    expect(policy.enqueueBudget(0)).toBe(PREFETCH_MIN_BUDGET_TILES);
  });

  /**
   * BH-2 — the same ceiling in the unit the LRU is actually denominated in.
   * The count budget prices a 17 MB satellite tile and a 5 KB sparse leaf
   * identically; `maxCacheByteSize` does not.
   *
   * Expansion 1 is the documented kill switch — it reproduces the pre-F3
   * arithmetic exactly — so it is what pins the fraction and the floor. The
   * currency conversion itself is pinned separately below.
   */
  it('sizes the per-pass enqueue BYTE budget from the cache BYTE budget', () => {
    const policy = new PrefetchPolicy(fakeClock().now);

    // The shipped default cache (2 GiB) → half of it.
    expect(policy.enqueueBudgetBytes(2 * 1024 * 1024 * 1024, 1)).toBe(
      1024 * 1024 * 1024,
    );
    expect(policy.enqueueBudgetBytes(64 * 1024 * 1024, 1)).toBe(
      64 * 1024 * 1024 * PREFETCH_CACHE_FRACTION,
    );

    // FLOOR: a tiny (or zero, or negative) cache config still leaves a
    // workable runway rather than collapsing the enqueue to nothing.
    expect(policy.enqueueBudgetBytes(1024, 1)).toBe(PREFETCH_MIN_BUDGET_BYTES);
    expect(policy.enqueueBudgetBytes(0, 1)).toBe(PREFETCH_MIN_BUDGET_BYTES);
    expect(policy.enqueueBudgetBytes(-1, 1)).toBe(PREFETCH_MIN_BUDGET_BYTES);
    // The floor binds exactly at 2 × itself.
    expect(policy.enqueueBudgetBytes(2 * PREFETCH_MIN_BUDGET_BYTES, 1)).toBe(
      PREFETCH_MIN_BUDGET_BYTES,
    );
    expect(policy.enqueueBudgetBytes(4 * PREFETCH_MIN_BUDGET_BYTES, 1)).toBe(
      2 * PREFETCH_MIN_BUDGET_BYTES,
    );

    // A NaN cache budget is a misconfiguration, not a licence to enqueue
    // forever; Infinity IS the documented rollback (count-only behavior).
    expect(policy.enqueueBudgetBytes(Number.NaN, 1)).toBe(
      PREFETCH_MIN_BUDGET_BYTES,
    );
    expect(policy.enqueueBudgetBytes(Number.POSITIVE_INFINITY, 1)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  /**
   * F3 — the budget's two sides must be the same byte currency.
   *
   * `maxCacheByteSize` is a DECODED cap: the LRU enforces it against
   * `Σ estimateTileSize(tile)`. What a planning pass can charge is
   * `getTileByteSize`, the COMPRESSED `entry.length`. Handing the raw cap back
   * as a ceiling for compressed charges admits a runway ~`expansion` times
   * bigger than the cache can hold — which is precisely the residency failure
   * the budget was added to prevent. The cap is therefore converted into the
   * charge's currency before it is returned.
   */
  it('converts the DECODED cache cap into the COMPRESSED currency it is charged in', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    const CAP = 2 * 1024 * 1024 * 1024; // 2 GiB decoded, the shipped default
    const half = CAP * PREFETCH_CACHE_FRACTION;

    // A 4× archive: 1 GiB of decoded cache holds only 256 MiB of directory
    // bytes, and that — not the 1 GiB — is what a compressed charge may spend.
    expect(policy.enqueueBudgetBytes(CAP, 4)).toBe(half / 4);
    expect(policy.enqueueBudgetBytes(CAP, 8)).toBe(half / 8);
    // Monotone in the expansion: a more compressible archive never buys MORE
    // directory bytes of runway.
    let prev = Number.POSITIVE_INFINITY;
    for (const r of [1, 2, 3, 4, 6, 8, 12, 16, 32, 64]) {
      const b = policy.enqueueBudgetBytes(CAP, r);
      expect(b).toBeLessThanOrEqual(prev);
      prev = b;
    }

    // Clamps. Below 1 is physically impossible (a decoded tile is never
    // smaller than its compressed form) and must never INFLATE the budget past
    // what the kill-switch value admits; above the ceiling one odd archive
    // cannot starve the runway further.
    expect(policy.enqueueBudgetBytes(CAP, 0.25)).toBe(
      policy.enqueueBudgetBytes(CAP, PREFETCH_MIN_BYTE_EXPANSION),
    );
    expect(policy.enqueueBudgetBytes(CAP, 1e9)).toBe(
      policy.enqueueBudgetBytes(CAP, PREFETCH_MAX_BYTE_EXPANSION),
    );
    // A degenerate rate falls back to the conservative cold value, never to
    // "no conversion" (which is the defect) and never to a divide-by-zero.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(policy.enqueueBudgetBytes(CAP, bad)).toBe(
        half / PREFETCH_COLD_BYTE_EXPANSION,
      );

    // The floor is already compressed currency (one dispatchable slice of
    // network work), so it is NOT divided — it binds instead.
    expect(policy.enqueueBudgetBytes(4 * PREFETCH_MIN_BUDGET_BYTES, 8)).toBe(
      PREFETCH_MIN_BUDGET_BYTES,
    );
  });

  /**
   * The exchange rate itself: measured from tiles priced in both currencies,
   * conservative until there are enough of them, clamped at both ends, and a
   * pure function of its inputs.
   */
  it('measures the decoded/compressed expansion, or stays conservative', () => {
    // Too few samples ⇒ the documented cold value, not a one-tile guess.
    expect(byteExpansionRatio(1000, 4000, 0)).toBe(
      PREFETCH_COLD_BYTE_EXPANSION,
    );
    expect(
      byteExpansionRatio(1000, 4000, PREFETCH_BYTE_EXPANSION_MIN_SAMPLES - 1),
    ).toBe(PREFETCH_COLD_BYTE_EXPANSION);

    // Enough samples ⇒ the measured ratio OF SUMS.
    const n = PREFETCH_BYTE_EXPANSION_MIN_SAMPLES;
    expect(byteExpansionRatio(1000, 4000, n)).toBe(4);
    expect(byteExpansionRatio(2_000_000, 7_000_000, n)).toBe(3.5);

    // Byte-WEIGHTED, not a mean of per-tile ratios: one 1 MB tile at 2× plus
    // three 1 KB tiles at 20× is a 2.05× archive, because the big tile is what
    // fills the cache. (A mean of ratios would say 15.5×.)
    expect(
      byteExpansionRatio(1_000_000 + 3_000, 2_000_000 + 60_000, 4),
    ).toBeCloseTo(2.0538, 4);

    // Degenerate sums ⇒ cold, never 0 and never Infinity.
    expect(byteExpansionRatio(0, 4000, n)).toBe(PREFETCH_COLD_BYTE_EXPANSION);
    expect(byteExpansionRatio(1000, 0, n)).toBe(PREFETCH_COLD_BYTE_EXPANSION);

    // Clamped at both ends.
    expect(byteExpansionRatio(1000, 100, n)).toBe(PREFETCH_MIN_BYTE_EXPANSION);
    expect(byteExpansionRatio(1, 1e9, n)).toBe(PREFETCH_MAX_BYTE_EXPANSION);

    // Pure: same inputs, same output, no state carried between calls.
    for (let i = 0; i < 3; i++)
      expect(byteExpansionRatio(1000, 4000, n)).toBe(4);
  });

  it('leaves the tile-count budget untouched (both budgets coexist)', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    // The byte budget is an ADDITIONAL bound, not a replacement: the count
    // budget is still the guard for byte-blind directories.
    expect(policy.enqueueBudget(1000)).toBe(500);
    expect(policy.enqueueBudgetBytes(1000, 1)).toBe(PREFETCH_MIN_BUDGET_BYTES);
  });
});

describe('PrefetchPolicy run-ahead cap', () => {
  it('bounds the horizon at the governor limit', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    expect(horizon(policy)).toBe(4000);

    policy.setRunAheadLimit(2000);
    expect(horizon(policy)).toBe(2000);
  });

  it('never lifts a horizon that is already shorter than the limit', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    policy.setRunAheadLimit(999_999);

    expect(horizon(policy)).toBe(4000);
  });

  it('floors a starving cap at the resident window', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    policy.setRunAheadLimit(1); // 1 sim-ms "cap"

    expect(horizon(policy)).toBe(1000); // timeWindow, the safety floor
  });

  it('floors a starving cap at what the speed-scaled gates consume', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    policy.setAnimationState(true, 4);
    policy.setRunAheadLimit(1);

    // max(1, bucketMs 100, timeWindow 1000, 4 × 5000) = 20 000
    expect(horizon(policy)).toBe(4 * PREFETCH_CAP_FLOOR_REAL_MS);
  });

  it('clears the cap for null and for values that cannot bound anything', () => {
    const policy = new PrefetchPolicy(fakeClock().now);

    for (const cleared of [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      policy.setRunAheadLimit(2000);
      expect(policy.runAheadLimitMs).toBe(2000);
      policy.setRunAheadLimit(cleared);
      expect(policy.runAheadLimitMs).toBeNull();
      expect(horizon(policy)).toBe(4000);
    }
  });
});

describe('PrefetchPolicy byte-feasibility solve', () => {
  it('lands on the largest bucket-aligned horizon under budget', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    // 4000 ms of horizon costs 40 000 bytes; the budget buys 25 buckets.
    expect(solvedHorizon(policy, 25 * BYTES_PER_BUCKET)).toBe(2500);
  });

  it('rounds DOWN to a bucket boundary rather than over-committing', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    // 25.9 buckets' worth of budget still only buys 25 whole buckets: the
    // candidate grid is the bucket grid the oracle's prefix sums are keyed on.
    expect(solvedHorizon(policy, 25.9 * BYTES_PER_BUCKET)).toBe(2500);
  });

  it('leaves a feasible horizon untouched, at the cost of ONE probe', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    const oracle = byteOracle();

    expect(
      horizon(policy, {
        byteBudget: 40 * BYTES_PER_BUCKET, // exactly the full horizon's cost
        bytesForHorizon: oracle.fn,
      }),
    ).toBe(UNSOLVED);
    // Feasibility is checked at the top of the range first, so the common case
    // (budget is ample) never enters the bisection at all.
    expect(oracle.probes).toEqual([UNSOLVED]);
  });

  it('bisects rather than scanning the candidate boundaries', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    const oracle = byteOracle();

    horizon(policy, {
      byteBudget: 25 * BYTES_PER_BUCKET,
      bytesForHorizon: oracle.fn,
    });
    // 31 bucket boundaries in [floor, horizon]; log2(31) ≈ 5, plus the initial
    // feasibility probe. A scan would be 31+.
    expect(oracle.probes.length).toBeLessThanOrEqual(8);
    expect(oracle.probes.length).toBeGreaterThan(1);
  });

  it('KEEPS THE FLOOR when even the floor is over budget (the deadlock guard)', () => {
    const policy = new PrefetchPolicy(fakeClock().now);

    // The floor alone costs 10 buckets = 10 000 bytes; the budget is 5 000.
    // Shrinking below the floor would leave the governor's speed-scaled gates
    // permanently unsatisfiable — the source would deadlock at the start-wait
    // instead of degrading — so the floor wins and §9.4 eviction absorbs it.
    expect(solvedHorizon(policy, 5 * BYTES_PER_BUCKET)).toBe(GATE_FLOOR);
    // Same at an absurdly small budget: never below the floor, ever.
    expect(solvedHorizon(policy, 1)).toBe(GATE_FLOOR);
  });

  it('keeps the speed-scaled floor satisfiable at high playback speed', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    const speed = 4;
    policy.setAnimationState(true, speed);
    const bucketMs = 1000;
    // Uncapped horizon = speed × 8 s = 32 000, capped by max(64 × 1000,
    // speed × 5 000 = 20 000) → 64 000, so 32 000 stands. Floor = 20 000.
    const unsolved = horizon(policy, { bucketMs, timeWindow: 1000 });
    expect(unsolved).toBe(32_000);

    const solved = horizon(policy, {
      bucketMs,
      timeWindow: 1000,
      byteBudget: 1,
      bytesForHorizon: (h: number) => ({ bytes: h, exact: true }),
    });
    expect(solved).toBe(speed * PREFETCH_CAP_FLOOR_REAL_MS);
  });

  it('routes a bytes-BLIND oracle to the pressure ladder', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    const blind = byteOracle({ exact: false });

    // An `exact: false` answer is a floor pretending to be a fact; the solve
    // refuses to bisect on it and hands regulation back to the ladder.
    expect(horizon(policy, { byteBudget: 1, bytesForHorizon: blind.fn })).toBe(
      UNSOLVED,
    );

    policy.noteRunwayEviction();
    expect(
      horizon(policy, { byteBudget: 1, bytesForHorizon: blind.fn }),
    ).toBeCloseTo(UNSOLVED * PRESSURE_SCALE_DECAY, 10);
  });

  it('skips the solve for an archive with no bucket grid', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    const oracle = byteOracle();

    expect(
      horizon(policy, {
        bucketMs: 0,
        byteBudget: 1,
        bytesForHorizon: oracle.fn,
      }),
    ).toBe(UNSOLVED);
    expect(oracle.probes).toEqual([]);
  });

  it('ignores a degenerate budget', () => {
    const policy = new PrefetchPolicy(fakeClock().now);

    for (const budget of [null, undefined, 0, -1, Number.NaN, Infinity]) {
      const oracle = byteOracle();
      expect(
        horizon(policy, {
          byteBudget: budget as number | null,
          bytesForHorizon: oracle.fn,
        }),
      ).toBe(UNSOLVED);
      expect(oracle.probes).toEqual([]);
    }
  });

  it('leaves the AIMD ladder as the backstop UNDER the solve', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    const budget = 25 * BYTES_PER_BUCKET;
    expect(solvedHorizon(policy, budget)).toBe(2500);

    // The compressed-byte solve said 2500 fits; residency says otherwise (a
    // decoded tile is much larger than its directory length), so the eviction
    // signal must still be able to cut further. It cuts the SOLVED horizon.
    policy.noteRunwayEviction();
    expect(solvedHorizon(policy, budget)).toBeCloseTo(
      2500 * PRESSURE_SCALE_DECAY,
      10,
    );
  });

  it('never exceeds a cap the solve was handed', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    policy.setRunAheadLimit(2000);

    // Budget ample: the run-ahead cap still binds, and the solve cannot lift it.
    expect(solvedHorizon(policy, 1e9)).toBe(2000);
    // Budget tight: the solve shrinks further, from the CAPPED horizon.
    expect(solvedHorizon(policy, 15 * BYTES_PER_BUCKET)).toBe(1500);
  });

  it('is monotone non-decreasing in the byte budget', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    let previous = 0;
    // From 1: a budget of 0 is the "no budget declared" sentinel (asserted
    // above), not "zero bytes allowed", so it is outside the monotone family.
    for (let buckets = 1; buckets <= 60; buckets++) {
      const h = solvedHorizon(policy, buckets * BYTES_PER_BUCKET);
      expect(h).toBeGreaterThanOrEqual(previous);
      expect(h).toBeGreaterThanOrEqual(GATE_FLOOR);
      expect(h).toBeLessThanOrEqual(UNSOLVED);
      previous = h;
    }
    expect(previous).toBe(UNSOLVED);
  });

  it('is deterministic across re-runs and across policy instances', () => {
    const shape = (p: PrefetchPolicy) => {
      const plan = p.plan(
        baseRequest({
          pipelineIdle: true,
          byteBudget: 25 * BYTES_PER_BUCKET,
          bytesForHorizon: byteOracle().fn,
        }),
      )!;
      return {
        direction: plan.direction,
        time: plan.time,
        effectiveAhead: plan.effectiveAhead,
        endTime: plan.endTime,
        queryRange: plan.queryRange,
        // The one function member, sampled: it closes over direction + time.
        distances: [
          plan.aheadDistance(PLAYHEAD),
          plan.aheadDistance(PLAYHEAD + 700),
          plan.aheadDistance(PLAYHEAD - 700),
        ],
      };
    };

    const a = new PrefetchPolicy(fakeClock().now);
    const first = shape(a);
    expect(shape(a)).toEqual(first);
    expect(shape(new PrefetchPolicy(fakeClock().now))).toEqual(first);
  });

  it('emits a plan byte-identical to the pre-solve one without an oracle', () => {
    const shapes: Array<Partial<PrefetchPlanRequest>> = [
      {},
      { prefetchAhead: 250 },
      { prefetchAhead: 100, prefetchSteps: 1 },
      { bucketMs: 0 },
      { bucketMs: 60_000, timeWindow: 60_000 },
    ];
    const emit = (over: Partial<PrefetchPlanRequest>) => {
      const policy = new PrefetchPolicy(fakeClock().now);
      policy.setAnimationState(true, 3);
      const plan = policy.plan(baseRequest({ ...over, pipelineIdle: true }))!;
      return {
        effectiveAhead: plan.effectiveAhead,
        endTime: plan.endTime,
        queryRange: plan.queryRange,
      };
    };

    for (const over of shapes) {
      // Absent fields, explicit nulls, and a blind oracle must all reduce to
      // exactly the plan the policy emitted before CO-2 existed.
      const legacy = emit(over);
      expect(
        emit({ ...over, byteBudget: null, bytesForHorizon: null }),
      ).toEqual(legacy);
      expect(
        emit({
          ...over,
          byteBudget: 1,
          bytesForHorizon: byteOracle({ exact: false }).fn,
        }),
      ).toEqual(legacy);
      expect(
        emit({ ...over, byteBudget: null, bytesForHorizon: byteOracle().fn }),
      ).toEqual(legacy);
    }
  });
});

describe('PrefetchPolicy pressure ladder', () => {
  it('is a strict no-op at scale 1', () => {
    const policy = new PrefetchPolicy(fakeClock().now);

    expect(policy.pressureScale).toBe(1);
    // A horizon BELOW the pressure floor is left alone: the floor only exists
    // to stop a decay step from starving the resident window.
    expect(horizon(policy, { prefetchAhead: 100, prefetchSteps: 1 })).toBe(100);
    // ...and so is the CO-2 solve, whichever way it is switched off: a horizon
    // at or under the gate floor is returned as-is rather than lifted to it.
    expect(
      horizon(policy, {
        prefetchAhead: 100,
        prefetchSteps: 1,
        byteBudget: 1,
        bytesForHorizon: byteOracle().fn,
      }),
    ).toBe(100);
    expect(
      horizon(policy, { byteBudget: null, bytesForHorizon: byteOracle().fn }),
    ).toBe(UNSOLVED);
  });

  /**
   * THE LADDER'S RUNGS, AS NUMBERS.
   *
   * Asserting `pressureScale === PRESSURE_SCALE_MIN` is a tautology: it holds
   * for every possible value of the constant, so it cannot detect the constant
   * being changed. The ladder is a shipped control law whose rungs the governor
   * gates and the §9.4 eviction tiers are tuned against, and CO-2 keeps it as
   * the null-callback fallback — so the values themselves are the contract and
   * are pinned literally here.
   */
  it('pins the ladder constants to their literal values', () => {
    expect(PRESSURE_SCALE_DECAY).toBe(0.7);
    expect(PRESSURE_SCALE_MIN).toBe(0.25);
    expect(PRESSURE_SCALE_RECOVERY_STEP).toBe(0.1);
    expect(PRESSURE_RECOVERY_QUIET_MS).toBe(5000);
    expect(PRESSURE_RECOVERY_STEP_INTERVAL_MS).toBe(1000);
  });

  it('degrades one rung per runway eviction, down to the floor', () => {
    const policy = new PrefetchPolicy(fakeClock().now);

    policy.noteRunwayEviction();
    expect(policy.pressureScale).toBeCloseTo(0.7, 10);
    policy.noteRunwayEviction();
    expect(policy.pressureScale).toBeCloseTo(0.49, 10);
    policy.noteRunwayEviction();
    expect(policy.pressureScale).toBeCloseTo(0.343, 10);

    // The fourth rung would be 0.2401. The ladder FLOORS at 0.25 — it does not
    // snap to zero, and it does not disable speculation: the floored rung still
    // buys a quarter-horizon runway. Extra evictions hold there forever.
    for (let i = 0; i < 10; i++) policy.noteRunwayEviction();
    expect(policy.pressureScale).toBeCloseTo(0.25, 10);
    expect(policy.pressureScale).toBeGreaterThan(0);
  });

  /**
   * THE FALLBACK PATH, AS NUMBERS — the pin CO-2's own byte-identity claim
   * needs. CO-2 states that "with a null callback the emitted plan is
   * byte-identical to today's"; that claim is only testable if the *pressured*
   * horizons are written down, because the un-pressured (scale-1) case exercises
   * none of the ladder. This sequence is the pre-CO-2 behaviour, verbatim.
   *
   * Setup: `prefetchAhead × prefetchSteps` = 6400 ms, which is exactly the
   * 64-bucket cap, so the caps are inert and the ladder is the only thing
   * moving the number. Gate floor = max(bucketMs, timeWindow, 0) = 1000 ms.
   *
   *   eviction  1     2     3     4     5     6
   *   scale     0.7   0.49  0.343 0.25  0.25  0.25   (floored, never 0)
   *   horizon   4480  3136  2195.2 1600 1600  1600   (gate floor 1000 never binds)
   *
   * A ladder that instead disabled itself below 0.25 would read
   * `…, 2195.2, 1000, 1000, 1000` — the gate floor, 600 ms short — which is the
   * regression this test exists to catch.
   */
  it('emits the pinned horizon sequence over consecutive evictions on the null-callback path', () => {
    const pressured = { prefetchAhead: 1600, prefetchSteps: 4 };
    /** Three spellings of "the oracle is switched off" — all are the fallback. */
    const killSwitches: Partial<PrefetchPlanRequest>[] = [
      {}, // fields absent entirely (pre-CO-2 callers)
      { byteBudget: null, bytesForHorizon: null }, // explicit null callback
      { byteBudget: null, bytesForHorizon: byteOracle().fn }, // budget withheld
    ];

    for (const off of killSwitches) {
      const policy = new PrefetchPolicy(fakeClock().now);
      // Un-pressured, the caps alone leave the full 64-bucket horizon.
      expect(horizon(policy, { ...pressured, ...off })).toBe(6400);

      const sequence: number[] = [];
      for (let i = 0; i < 6; i++) {
        policy.noteRunwayEviction();
        policy.invalidatePlan(); // drop the runway throttle, not the pressure
        sequence.push(horizon(policy, { ...pressured, ...off }));
      }

      expect(sequence).toHaveLength(6);
      expect(sequence[0]).toBeCloseTo(4480, 6);
      expect(sequence[1]).toBeCloseTo(3136, 6);
      expect(sequence[2]).toBeCloseTo(2195.2, 6);
      expect(sequence[3]).toBeCloseTo(1600, 6);
      expect(sequence[4]).toBeCloseTo(1600, 6);
      expect(sequence[5]).toBeCloseTo(1600, 6);
      // ...and explicitly NOT collapsed onto the gate floor.
      expect(sequence[3]).toBeGreaterThan(GATE_FLOOR);
      expect(sequence[5]).toBeGreaterThan(GATE_FLOOR);
    }
  });

  it('shrinks the planned horizon while pressured', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    policy.noteRunwayEviction();

    expect(horizon(policy)).toBeCloseTo(4000 * PRESSURE_SCALE_DECAY, 10);
  });

  it('recovers only after the documented quiet period', () => {
    const clock = fakeClock();
    const policy = new PrefetchPolicy(clock.now);
    policy.noteRunwayEviction();
    const degraded = policy.pressureScale;

    // Plans during the quiet period do not recover, however many there are.
    for (
      let elapsed = 0;
      elapsed < PRESSURE_RECOVERY_QUIET_MS;
      elapsed += 500
    ) {
      policy.plan(baseRequest());
      expect(policy.pressureScale).toBe(degraded);
      clock.advance(500);
    }

    // The instant the quiet period is satisfied, the next plan steps up.
    policy.plan(baseRequest());
    expect(policy.pressureScale).toBeCloseTo(
      degraded + PRESSURE_SCALE_RECOVERY_STEP,
      10,
    );
  });

  it('paces recovery by wall time, not by how often a plan runs', () => {
    const clock = fakeClock();
    const policy = new PrefetchPolicy(clock.now);
    policy.noteRunwayEviction();
    const degraded = policy.pressureScale;

    clock.advance(PRESSURE_RECOVERY_QUIET_MS);
    policy.plan(baseRequest());
    const afterFirstStep = policy.pressureScale;
    expect(afterFirstStep).toBeCloseTo(
      degraded + PRESSURE_SCALE_RECOVERY_STEP,
      10,
    );

    // Twenty plans spanning one step interval buy exactly one more step, and
    // it lands on the interval boundary rather than on any earlier plan.
    for (let i = 1; i <= 20; i++) {
      clock.advance(PRESSURE_RECOVERY_STEP_INTERVAL_MS / 20);
      policy.plan(baseRequest());
      const steps = i === 20 ? 1 : 0;
      expect(policy.pressureScale).toBeCloseTo(
        afterFirstStep + steps * PRESSURE_SCALE_RECOVERY_STEP,
        10,
      );
    }
  });

  it('a fresh eviction restarts the quiet period', () => {
    const clock = fakeClock();
    const policy = new PrefetchPolicy(clock.now);
    policy.noteRunwayEviction();

    clock.advance(PRESSURE_RECOVERY_QUIET_MS - 1);
    policy.noteRunwayEviction();
    const degraded = policy.pressureScale;

    clock.advance(PRESSURE_RECOVERY_QUIET_MS - 1);
    policy.plan(baseRequest());
    expect(policy.pressureScale).toBe(degraded);

    clock.advance(1);
    policy.plan(baseRequest());
    expect(policy.pressureScale).toBeCloseTo(
      degraded + PRESSURE_SCALE_RECOVERY_STEP,
      10,
    );
  });

  it('climbs back to exactly 1 and stops there', () => {
    const clock = fakeClock();
    const policy = new PrefetchPolicy(clock.now);
    for (let i = 0; i < 10; i++) policy.noteRunwayEviction();
    expect(policy.pressureScale).toBeCloseTo(0.25, 10);

    clock.advance(PRESSURE_RECOVERY_QUIET_MS);
    for (let i = 0; i < 100; i++) {
      policy.plan(baseRequest());
      clock.advance(PRESSURE_RECOVERY_STEP_INTERVAL_MS);
    }
    expect(policy.pressureScale).toBe(1);
  });

  it('recovers even on a plan the runway throttle rejects', () => {
    const clock = fakeClock();
    const policy = new PrefetchPolicy(clock.now);
    policy.noteRunwayEviction();
    const degraded = policy.pressureScale;

    // Claim a span, then re-plan with a busy pipeline and an unmoved playhead:
    // the throttle rejects it, but recovery is paced by wall time alone.
    policy.plan(baseRequest());
    clock.advance(PRESSURE_RECOVERY_QUIET_MS);
    expect(policy.plan(baseRequest({ pipelineIdle: false }))).toBeNull();
    expect(policy.pressureScale).toBeCloseTo(
      degraded + PRESSURE_SCALE_RECOVERY_STEP,
      10,
    );
  });

  it('floors the pressured horizon at the resident window', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    for (let i = 0; i < 10; i++) policy.noteRunwayEviction();

    // Unfloored the ladder would cut 2000 ms to 500, below the window the play
    // head is drawing from; the floor holds it at the window instead. The
    // ladder shrinks speculation, never the play head's own data.
    expect(horizon(policy, { prefetchSteps: 2 })).toBe(1000);
  });

  it('floors the pressured horizon at what the speed-scaled gates consume', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    const speed = 4;
    policy.setAnimationState(true, speed);
    const settled = horizon(policy);
    expect(settled).toBe(speed * PREFETCH_CAP_FLOOR_REAL_MS);

    // At this speed the gate floor already equals the whole horizon, so the
    // ladder cannot cut anything: a decay step must not turn a recoverable
    // stall into a permanent one.
    for (let i = 0; i < 10; i++) policy.noteRunwayEviction();
    expect(horizon(policy)).toBe(settled);
  });

  it('a pressured floor can exceed the un-pressured horizon', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    const tiny = { prefetchAhead: 100, prefetchSteps: 1 };
    expect(horizon(policy, tiny)).toBe(100);

    // A configured lookahead shorter than the resident window is below the
    // pressure floor, so the first decay step RAISES the horizon to the
    // window. The floor is unconditional: keeping the play head's own data
    // loading outranks honouring a lookahead the ladder is trying to shrink.
    policy.noteRunwayEviction();
    expect(horizon(policy, tiny)).toBe(1000);
  });
});

describe('PrefetchPolicy runway throttle', () => {
  it('rejects a re-plan while the head still has most of the claimed span', () => {
    const policy = new PrefetchPolicy(fakeClock().now);

    const first = policy.plan(baseRequest({ pipelineIdle: false }))!;
    expect(first.endTime).toBe(PLAYHEAD + 4000);
    expect(policy.plan(baseRequest({ pipelineIdle: false }))).toBeNull();
  });

  it('re-plans once the head has consumed the reload fraction', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    policy.plan(baseRequest({ pipelineIdle: false }));

    const consumed = 4000 * PREFETCH_RELOAD_FRACTION;
    expect(
      policy.plan(
        baseRequest({ time: PLAYHEAD + consumed - 1, pipelineIdle: false }),
      ),
    ).toBeNull();
    expect(
      policy.plan(
        baseRequest({ time: PLAYHEAD + consumed + 1, pipelineIdle: false }),
      ),
    ).not.toBeNull();
  });

  it('re-plans when the horizon grows past the claimed span', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    policy.plan(baseRequest({ pipelineIdle: false }));

    // Playback speeds up: the claimed 4000 ms no longer covers the horizon.
    policy.setAnimationState(true, 2);
    expect(policy.plan(baseRequest({ pipelineIdle: false }))).not.toBeNull();
  });

  it('lets an idle pipeline through regardless of remaining runway', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    policy.plan(baseRequest({ pipelineIdle: false }));

    expect(policy.plan(baseRequest({ pipelineIdle: true }))).not.toBeNull();
  });

  it('re-anchoring a budget-truncated pass unblocks the next plan', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    const plan = policy.plan(baseRequest({ pipelineIdle: false }))!;

    // Only 600 ms of the claimed 4000 ms span was actually enqueued.
    policy.anchorTruncatedRunway(plan, 500, 100);
    expect(policy.plan(baseRequest({ pipelineIdle: false }))).not.toBeNull();
  });

  it('re-anchoring never clobbers a newer claim', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    const stale = policy.plan(baseRequest({ pipelineIdle: false }))!;
    const current = policy.plan(baseRequest({ pipelineIdle: true }))!;
    expect(current.endTime).toBe(stale.endTime);

    // A pass superseded mid-flight re-anchors against an anchor it no longer
    // owns; the live claim must survive.
    policy.invalidatePlan();
    policy.plan(baseRequest({ time: PLAYHEAD + 10_000, pipelineIdle: true }));
    policy.anchorTruncatedRunway(stale, 0, 0);
    expect(
      policy.plan(
        baseRequest({ time: PLAYHEAD + 10_000, pipelineIdle: false }),
      ),
    ).toBeNull();
  });

  it('invalidating the plan lets the next pass re-issue immediately', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    policy.plan(baseRequest({ pipelineIdle: false }));
    expect(policy.plan(baseRequest({ pipelineIdle: false }))).toBeNull();

    policy.invalidatePlan();
    expect(policy.plan(baseRequest({ pipelineIdle: false }))).not.toBeNull();
  });
});

describe('PrefetchPolicy pass supersession', () => {
  it('only the newest pass is current', () => {
    const policy = new PrefetchPolicy(fakeClock().now);

    const first = policy.beginPass();
    expect(policy.isCurrentPass(first)).toBe(true);

    const second = policy.beginPass();
    expect(policy.isCurrentPass(first)).toBe(false);
    expect(policy.isCurrentPass(second)).toBe(true);
  });

  it('invalidating the plan supersedes an open pass', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    const pass = policy.beginPass();

    policy.invalidatePlan();
    expect(policy.isCurrentPass(pass)).toBe(false);
  });
});

describe('PrefetchPolicy pacing', () => {
  it('releases the first pass immediately, then coalesces', () => {
    const clock = fakeClock();
    const policy = new PrefetchPolicy(clock.now);

    expect(policy.msUntilNextRun()).toBe(0);
    policy.markRunStarted();
    expect(policy.msUntilNextRun()).toBe(PREFETCH_DEBOUNCE_MS);

    clock.advance(PREFETCH_DEBOUNCE_MS - 1);
    expect(policy.msUntilNextRun()).toBe(1);
    clock.advance(1);
    expect(policy.msUntilNextRun()).toBe(0);
  });

  it('clearing the debounce releases the next pass at once', () => {
    const clock = fakeClock();
    const policy = new PrefetchPolicy(clock.now);
    policy.markRunStarted();
    expect(policy.msUntilNextRun()).toBe(PREFETCH_DEBOUNCE_MS);

    policy.clearDebounce();
    expect(policy.msUntilNextRun()).toBe(0);
  });
});

describe('PrefetchPolicy slice sizing', () => {
  it('uses the cold-start size until throughput is measured', () => {
    const policy = new PrefetchPolicy(fakeClock().now);

    for (const unmeasured of [null, 0, -1]) {
      expect(policy.sliceBytes(unmeasured)).toBe(PREFETCH_SLICE_COLD_BYTES);
    }
  });

  it('targets a fixed download TIME between the size clamps', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    const inRange = 4000; // bytes per ms → 4 MB per second of download

    expect(policy.sliceBytes(inRange)).toBe(
      inRange * PREFETCH_SLICE_TARGET_REAL_MS,
    );
    expect(policy.sliceBytes(1)).toBe(PREFETCH_SLICE_MIN_BYTES);
    expect(policy.sliceBytes(1e9)).toBe(PREFETCH_SLICE_MAX_BYTES);
  });
});

describe('PrefetchPolicy interactive bit', () => {
  it('reports transitions and swallows repeats', () => {
    const policy = new PrefetchPolicy(fakeClock().now);

    expect(policy.isInteractive).toBe(false);
    expect(policy.setInteractive(true)).toBe(true);
    expect(policy.setInteractive(true)).toBe(false);
    expect(policy.isInteractive).toBe(true);
    expect(policy.setInteractive(false)).toBe(true);
    expect(policy.isInteractive).toBe(false);
  });

  it('does not affect the planned horizon', () => {
    const policy = new PrefetchPolicy(fakeClock().now);
    const settled = horizon(policy);

    policy.setInteractive(true);
    expect(horizon(policy)).toBe(settled);
  });
});

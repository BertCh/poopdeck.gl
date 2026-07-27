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
  PREFETCH_MIN_BUDGET_TILES,
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

describe('PrefetchPolicy pressure ladder', () => {
  it('is a strict no-op at scale 1', () => {
    const policy = new PrefetchPolicy(fakeClock().now);

    expect(policy.pressureScale).toBe(1);
    // A horizon BELOW the pressure floor is left alone: the floor only exists
    // to stop a decay step from starving the resident window.
    expect(horizon(policy, { prefetchAhead: 100, prefetchSteps: 1 })).toBe(100);
  });

  it('degrades one rung per runway eviction, down to the floor', () => {
    const policy = new PrefetchPolicy(fakeClock().now);

    policy.noteRunwayEviction();
    expect(policy.pressureScale).toBeCloseTo(PRESSURE_SCALE_DECAY, 10);
    policy.noteRunwayEviction();
    expect(policy.pressureScale).toBeCloseTo(PRESSURE_SCALE_DECAY ** 2, 10);

    for (let i = 0; i < 10; i++) policy.noteRunwayEviction();
    expect(policy.pressureScale).toBe(PRESSURE_SCALE_MIN);
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
    expect(policy.pressureScale).toBe(PRESSURE_SCALE_MIN);

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

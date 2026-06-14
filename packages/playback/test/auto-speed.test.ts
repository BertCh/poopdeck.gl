/**
 * Asymmetric Auto-speed step decision (player-buffering §2, hls.js-style
 * 0.95-down / 0.7-up): downshifts apply immediately with no deadband (and on
 * the governor 'waiting' phase); upshifts only on the slow cadence and only
 * past the deadband. The showcase consumer (useDemoPlayback) applies this
 * verbatim, so the policy is pinned here once.
 */

import { describe, it, expect } from 'vitest';
import { decideAutoSpeedMultiplier } from '../src/auto-speed';

describe('decideAutoSpeedMultiplier', () => {
  it('applies a downshift immediately, even inside the deadband', () => {
    // 4 → 3 is exactly a 25% move — blocked for upshifts, NOT for downshifts.
    expect(decideAutoSpeedMultiplier(4, 3.1, 'cadence')).toBe(3);
  });

  it('applies downshifts on the waiting phase (gate entry = immediate re-eval)', () => {
    expect(decideAutoSpeedMultiplier(10, 1.1, 'waiting')).toBe(1);
  });

  it('holds an upshift inside the 25% deadband', () => {
    // 4 → 5 is exactly a 25% move (≤ deadband) → hold.
    expect(decideAutoSpeedMultiplier(4, 4.9, 'cadence')).toBeNull();
  });

  it('applies an upshift past the deadband on the cadence phase', () => {
    expect(decideAutoSpeedMultiplier(4, 6.1, 'cadence')).toBe(6);
  });

  it('never upshifts on the waiting phase', () => {
    expect(decideAutoSpeedMultiplier(1, 10, 'waiting')).toBeNull();
  });

  it('clamps to [0.25, 10] before snapping', () => {
    expect(decideAutoSpeedMultiplier(1, 100, 'cadence')).toBe(10);
    expect(decideAutoSpeedMultiplier(1, 0.01, 'cadence')).toBe(0.25);
  });

  it('clamps an Infinity suggestion (nothing left to load) to maxMultiplier', () => {
    // The governor returns Infinity when the horizon has zero pending tiles;
    // the consumer clamp turns "uncapped" into "rise to the top step".
    expect(decideAutoSpeedMultiplier(1, Infinity, 'cadence')).toBe(10);
  });

  it('an Infinity suggestion still obeys the upshift damping rules', () => {
    // Already at the top step → hold.
    expect(decideAutoSpeedMultiplier(10, Infinity, 'cadence')).toBeNull();
    // Upshifts never apply on the waiting phase, even uncapped ones.
    expect(decideAutoSpeedMultiplier(1, Infinity, 'waiting')).toBeNull();
    // 8 → 10 is exactly a 25% move (≤ deadband) → hold.
    expect(decideAutoSpeedMultiplier(8, Infinity, 'cadence')).toBeNull();
  });

  it('holds when the snapped step equals the current multiplier', () => {
    expect(decideAutoSpeedMultiplier(2, 2.1, 'cadence')).toBeNull();
  });

  it('honours custom steps/deadband options', () => {
    expect(
      decideAutoSpeedMultiplier(1, 3.9, 'cadence', {
        steps: [1, 2, 4],
        maxMultiplier: 4,
        upshiftDeadband: 0.5,
      }),
    ).toBe(4);
    expect(
      decideAutoSpeedMultiplier(1, 1.4, 'cadence', {
        steps: [1, 1.5, 2],
        upshiftDeadband: 0.5,
      }),
    ).toBeNull(); // 1 → 1.5 is a 50% move, ≤ the 0.5 deadband
  });
});

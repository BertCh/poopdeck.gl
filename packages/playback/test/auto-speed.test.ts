/**
 * Asymmetric Auto-speed step decision (player-buffering §2, hls.js-style
 * 0.95-down / 0.7-up): downshifts apply immediately with no deadband (and on
 * the governor 'waiting' phase); upshifts only on the slow cadence and only
 * past the deadband. The showcase consumer (useDemoPlayback) applies this
 * verbatim, so the policy is pinned here once.
 */

import { describe, it, expect } from 'vitest';
import {
  decideAutoSpeedMultiplier,
  dispersionScale,
  DISPERSION_SCALE_K,
  DISPERSION_SCALE_MAX,
  SPEED_STEPS,
} from '../src/auto-speed';

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

/**
 * M5/CO-4: the consumer-side half of the dispersion re-fit. Everything above
 * this line is the PINNED incumbent policy and passes unchanged — these cases
 * only exercise the new, opt-in `dispersionCv` input.
 */
describe('dispersionScale (the shared jitter response)', () => {
  it('is exactly 1 for a steady link and for every absent-signal spelling', () => {
    // 1 is the identity of every knob that multiplies by it, so "no signal"
    // and "no jitter" both reproduce the incumbent constant bit-for-bit.
    expect(dispersionScale(0)).toBe(1);
    expect(dispersionScale(undefined)).toBe(1);
    expect(dispersionScale(null)).toBe(1);
    expect(dispersionScale(NaN)).toBe(1);
    // A non-finite cv is garbage, not "infinite jitter": it must not silently
    // triple a threshold, so it reads as no signal like every other bad input.
    expect(dispersionScale(Infinity)).toBe(1);
    expect(dispersionScale(-0.5)).toBe(1); // a negative cv is not "less jitter"
  });

  it('is `1 + k·cv`, monotone, and clamped at the documented ceiling', () => {
    expect(dispersionScale(0.25)).toBeCloseTo(1 + DISPERSION_SCALE_K * 0.25);
    expect(dispersionScale(0.5)).toBeCloseTo(2);
    let prev = 0;
    for (const cv of [0, 0.1, 0.25, 0.5, 0.9, 1, 2, 10]) {
      const s = dispersionScale(cv);
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(s).toBeLessThanOrEqual(DISPERSION_SCALE_MAX);
      prev = s;
    }
    expect(dispersionScale(10)).toBe(DISPERSION_SCALE_MAX);
  });

  it('honours a custom k, and k = 0 pins the incumbent constant', () => {
    expect(dispersionScale(1, 0)).toBe(1);
    expect(dispersionScale(0.5, 1)).toBeCloseTo(1.5);
  });
});

describe('decideAutoSpeedMultiplier — dispersion-widened upshift deadband', () => {
  it('omitting dispersionCv reproduces the incumbent deadband exactly', () => {
    // Same two cases as the pinned block above, restated against an explicit
    // cv of 0 so the "absent ≡ steady" equivalence is asserted, not assumed.
    expect(
      decideAutoSpeedMultiplier(4, 4.9, 'cadence', { dispersionCv: 0 }),
    ).toBe(decideAutoSpeedMultiplier(4, 4.9, 'cadence'));
    expect(
      decideAutoSpeedMultiplier(4, 6.1, 'cadence', { dispersionCv: 0 }),
    ).toBe(decideAutoSpeedMultiplier(4, 6.1, 'cadence'));
  });

  it('widens the deadband on a jittery link (an upshift that would pass now holds)', () => {
    // 4 → 6 is a 50% move: past the incumbent 0.25 deadband, exactly ON the
    // 0.5 one that cv = 0.5 (scale 2) produces — and the band is inclusive.
    expect(decideAutoSpeedMultiplier(4, 6.1, 'cadence')).toBe(6);
    expect(
      decideAutoSpeedMultiplier(4, 6.1, 'cadence', { dispersionCv: 0.5 }),
    ).toBeNull();
    // A big enough rise (4 → 10, a 150% move) still clears the widened band.
    expect(
      decideAutoSpeedMultiplier(4, 9.9, 'cadence', { dispersionCv: 0.5 }),
    ).toBe(10);
  });

  it('never damps a DOWNSHIFT, however jittery the link', () => {
    // The asymmetry is the whole policy: damping a downshift is a stall.
    expect(
      decideAutoSpeedMultiplier(4, 3.1, 'cadence', { dispersionCv: 3 }),
    ).toBe(3);
    expect(
      decideAutoSpeedMultiplier(10, 1.1, 'waiting', { dispersionCv: 3 }),
    ).toBe(1);
  });

  it('composes with a custom deadband rather than replacing it', () => {
    // 1 → 1.5 is a 50% move: clears the configured 0.4 band, held once cv = 0.5
    // widens it to 0.8.
    expect(
      decideAutoSpeedMultiplier(1, 1.6, 'cadence', {
        steps: [1, 1.5, 2],
        upshiftDeadband: 0.4,
      }),
    ).toBe(1.5);
    expect(
      decideAutoSpeedMultiplier(1, 1.6, 'cadence', {
        steps: [1, 1.5, 2],
        upshiftDeadband: 0.4,
        dispersionCv: 0.5,
      }),
    ).toBeNull();
  });

  it('the governor prices the ladder the consumer snaps to', () => {
    // CO-4 enumerates candidates from SPEED_STEPS and consumers snap to the
    // same array; a drift between the two would price steps nobody can select.
    expect([...SPEED_STEPS]).toEqual([
      0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10,
    ]);
    for (const step of SPEED_STEPS) {
      expect(
        decideAutoSpeedMultiplier(1, step, 'cadence', { steps: SPEED_STEPS }),
      ).not.toBe(undefined);
    }
  });
});

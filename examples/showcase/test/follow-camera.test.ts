import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FOLLOW_CONFIG,
  desiredCameraAt,
  expAlpha,
  headingToBearing,
  shortestAngleDelta,
  smoothAngle,
  type FollowCameraConfig,
} from '../src/components/av/followCamera';
import type { EgoPathPoint } from '../src/components/av/egoLayers';

describe('headingToBearing', () => {
  // Ego heading is 0 = east, CCW positive; deck bearing is 0 = north, CW positive.
  it('maps east (0°) to bearing 90', () => {
    expect(headingToBearing(0)).toBeCloseTo(90);
  });
  it('maps north (90°) to bearing 0', () => {
    expect(headingToBearing(90)).toBeCloseTo(0);
  });
  it('maps west (180°) to bearing 270', () => {
    expect(headingToBearing(180)).toBeCloseTo(270);
  });
  it('normalizes negative headings into [0,360)', () => {
    const b = headingToBearing(-90); // south
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(360);
    expect(b).toBeCloseTo(180);
  });
});

describe('shortestAngleDelta', () => {
  it('takes the short way across the 0/360 seam', () => {
    expect(shortestAngleDelta(350, 10)).toBeCloseTo(20); // +20, not -340
    expect(shortestAngleDelta(10, 350)).toBeCloseTo(-20); // -20, not +340
  });
  it('stays within [-180, 180)', () => {
    for (const [a, b] of [
      [0, 179],
      [0, 181],
      [0, 180],
      [270, 5],
    ]) {
      const d = shortestAngleDelta(a, b);
      expect(d).toBeGreaterThanOrEqual(-180);
      expect(d).toBeLessThan(180);
    }
  });
});

describe('smoothAngle', () => {
  it('eases across the seam without spinning the long way', () => {
    // From 350° toward 10° with half-step should land near 0°, not ~180°.
    const v = smoothAngle(350, 10, 0.5);
    const norm = ((v % 360) + 360) % 360;
    expect(norm > 355 || norm < 5).toBe(true);
  });
  it('alpha=1 snaps to the target arc', () => {
    expect(((smoothAngle(350, 10, 1) % 360) + 360) % 360).toBeCloseTo(10);
  });
});

describe('expAlpha', () => {
  it('snaps when tau<=0 and holds when dt<=0', () => {
    expect(expAlpha(0.016, 0)).toBe(1);
    expect(expAlpha(0, 0.5)).toBe(0);
  });
  it('returns a fraction in (0,1) for a normal frame', () => {
    const a = expAlpha(0.016, 0.35);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
  });
  it('advances ~63% of the gap over one time constant', () => {
    // One full tau of elapsed time => 1 - 1/e ≈ 0.632.
    expect(expAlpha(0.35, 0.35)).toBeCloseTo(1 - 1 / Math.E, 4);
  });
  it('is frame-rate independent: two half-steps ≈ one full step', () => {
    const tau = 0.35;
    const gap = 100;
    // One 32ms step.
    const oneStep = gap * expAlpha(0.032, tau);
    // Two 16ms steps applied to the residual.
    let v = 0;
    v += (gap - v) * expAlpha(0.016, tau);
    v += (gap - v) * expAlpha(0.016, tau);
    expect(v).toBeCloseTo(oneStep, 3);
  });
});

describe('desiredCameraAt', () => {
  const path: EgoPathPoint[] = [
    { t: 0, lon: 0, lat: 0 },
    { t: 1000, lon: 0.001, lat: 0 }, // moving due east
  ];

  it('interpolates the ego position at the playhead', () => {
    const c = desiredCameraAt(path, 500, DEFAULT_FOLLOW_CONFIG);
    expect(c).not.toBeNull();
    expect(c!.longitude).toBeCloseTo(0.0005);
    expect(c!.latitude).toBeCloseTo(0);
  });

  it('omits bearing/zoom by default (centre-track only)', () => {
    const c = desiredCameraAt(path, 500, DEFAULT_FOLLOW_CONFIG)!;
    expect(c.bearing).toBeUndefined();
    expect(c.zoom).toBeUndefined();
  });

  it('emits a travel-direction bearing when rotateToHeading is on', () => {
    const cfg: FollowCameraConfig = {
      ...DEFAULT_FOLLOW_CONFIG,
      rotateToHeading: true,
    };
    const c = desiredCameraAt(path, 500, cfg)!;
    // Heading due east (0°) → bearing 90°.
    expect(c.bearing).toBeCloseTo(90);
  });

  it('pins zoom and look-ahead when configured', () => {
    const cfg: FollowCameraConfig = {
      ...DEFAULT_FOLLOW_CONFIG,
      zoom: 17,
      leadMs: 500,
    };
    const c = desiredCameraAt(path, 250, cfg)!;
    expect(c.zoom).toBe(17);
    // Lead pushes the sampled point forward by 500ms (to t=750).
    expect(c.longitude).toBeCloseTo(0.00075);
  });

  it('returns null for an empty path', () => {
    expect(desiredCameraAt([], 0, DEFAULT_FOLLOW_CONFIG)).toBeNull();
    expect(desiredCameraAt(null, 0, DEFAULT_FOLLOW_CONFIG)).toBeNull();
  });
});

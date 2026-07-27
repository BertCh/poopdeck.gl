// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

/**
 * The two things `motion-modes.test.ts` cannot see, because every case in it
 * (and in `motion-antimeridian.test.ts`) pins `fadeOutDuration: 0` and every
 * `maxExtrapolationMs` it uses dwarfs the singleton hold:
 *
 *   1. THE FADE RAMP ACROSS THE PREDICTION BOUNDARY. `alpha` is a
 *      disappear ramp, so it must be a SINGLE monotone descent that reaches 0
 *      exactly when the pose stops being drawn. Measuring the interior against
 *      the terminal keyframe and the predicted tail against the extrapolation
 *      horizon gives two ramps with a step between them: the entity fades out
 *      at its last keyframe, pops back to full opacity, and fades a second
 *      time.
 *
 *   2. THE PREDICTION / HOLD BAND RELATIONSHIP. `singletonHoldMs/2` and
 *      `maxExtrapolationMs` are two independent knobs on the SAME axis ("how
 *      far past `last` may a pose exist"), so the suite has to sweep both
 *      orderings. When the prediction window is the shorter of the two the
 *      pose must FREEZE where the prediction left it, never snap back to the
 *      raw keyframe it flew away from.
 *
 * Both are continuity properties, so most assertions here are sweeps that
 * compare adjacent samples rather than single-point goldens: a step is exactly
 * what is being tested, and a spot check lands on one side of it or the other.
 */

import { describe, it, expect } from 'vitest';
import { sampleTrack } from '../src/render/track-kernel';
import type { Track, TrackSampleConfig } from '../src/render/track-kernel';
import type { MotionConfig } from '../src/render/motion';

const BASE: TrackSampleConfig = {
  defaultLength: 4,
  defaultWidth: 2,
  defaultHeight: 1.6,
  fadeInDuration: 0,
  fadeOutDuration: 0,
};

interface TrackSpec {
  times: number[];
  lon: number[];
  lat: number[];
  heading?: number[];
  speed?: number[];
}

function track(spec: TrackSpec): Track {
  const n = spec.times.length;
  const nan = () => new Array<number>(n).fill(NaN);
  return {
    trackId: 'A',
    times: spec.times,
    lon: spec.lon,
    lat: spec.lat,
    alt: new Array<number>(n).fill(0),
    heading: spec.heading ?? nan(),
    length: nan(),
    width: nan(),
    height: nan(),
    speed: spec.speed ?? nan(),
    color: [1, 2, 3, 4],
    label: '',
    category: '',
    singleton: n < 2,
  };
}

/** Two brackets then a terminal keyframe carrying "12 m/s due east" columns. */
const eastbound = () =>
  track({
    times: [0, 1000, 2000],
    lon: [-100, -99.9, -99.8],
    lat: [40, 40, 40],
    heading: [90, 90, 90], // compass degrees
    speed: [12, 12, 12],
  });

/** A singleton carrying the same columns: predictable, and held. */
const loneEastbound = () =>
  track({
    times: [10_000],
    lon: [-100],
    lat: [40],
    heading: [90],
    speed: [10],
  });

const DEG = {
  courseUnit: 'deg' as const,
  courseConvention: 'compass' as const,
};

/**
 * Walk `now` across `[from, to]` at `step` and hand back every non-null sample.
 * `step` is deliberately fine (sub-millisecond near a boundary) because the
 * defect this file exists to catch is one millisecond wide.
 */
function sweep(
  t: Track,
  cfg: TrackSampleConfig,
  from: number,
  to: number,
  step: number,
): { now: number; alpha: number; lon: number; extrapolated: boolean }[] {
  const out: {
    now: number;
    alpha: number;
    lon: number;
    extrapolated: boolean;
  }[] = [];
  const n = Math.round((to - from) / step);
  for (let k = 0; k <= n; k++) {
    const now = from + k * step;
    const s = sampleTrack(t, now, cfg);
    if (s === null) continue;
    out.push({
      now,
      alpha: s.alpha,
      lon: s.lon,
      extrapolated: s.extrapolated === true,
    });
  }
  return out;
}

/**
 * `alpha` never rises as the playhead advances, and never moves faster than the
 * ramp's own slope (`step / fadeOutDuration`) — which is the statement "there is
 * no step discontinuity" written so that it holds at every sample, not just at
 * the one boundary the author thought of.
 */
function expectMonotoneContinuousAlpha(
  series: { now: number; alpha: number }[],
  step: number,
  fadeOut: number,
  where: string,
): void {
  const slack = step / fadeOut + 1e-9;
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1];
    const b = series[i];
    expect(
      b.alpha <= a.alpha + 1e-12,
      `${where}: alpha rose from ${a.alpha} at now=${a.now} to ${b.alpha} at now=${b.now}`,
    ).toBe(true);
    expect(
      a.alpha - b.alpha <= slack,
      `${where}: alpha stepped ${a.alpha} → ${b.alpha} between now=${a.now} and now=${b.now} (max ${slack})`,
    ).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// 1. The fade ramp across the interior → predicted boundary
// ---------------------------------------------------------------------------

describe('fade-out across the interior → extrapolated boundary', () => {
  it('is one monotone ramp when the horizon outruns the ramp (fade 500, extrap 4000)', () => {
    const t = eastbound();
    const motion: MotionConfig = {
      mode: 'velocity',
      maxExtrapolationMs: 4000,
      ...DEG,
    };
    const cfg: TrackSampleConfig = {
      ...BASE,
      fadeOutDuration: 500,
      motion,
    };

    const step = 0.25;
    const series = sweep(t, cfg, 1000, 6000, step);
    expectMonotoneContinuousAlpha(series, step, 500, 'fade 500 / extrap 4000');

    // The entity does not disappear at its last keyframe — it flies on — so
    // nothing may fade there. The ramp belongs to the HORIZON (6000).
    expect(sampleTrack(t, 1999, cfg)!.alpha).toBe(1);
    expect(sampleTrack(t, 2000, cfg)!.alpha).toBe(1);
    const justPast = sampleTrack(t, 2000.0001, cfg)!;
    expect(justPast.extrapolated).toBe(true);
    expect(justPast.alpha).toBe(1);

    // …and it lands on 0 exactly where the pose culls.
    expect(sampleTrack(t, 5500, cfg)!.alpha).toBeCloseTo(1, 12);
    expect(sampleTrack(t, 5750, cfg)!.alpha).toBeCloseTo(0.5, 12);
    expect(sampleTrack(t, 6000, cfg)!.alpha).toBe(0);
    expect(sampleTrack(t, 6000.0001, cfg)).toBeNull();
  });

  it('is one monotone ramp when the ramp outruns the horizon (fade 3000, extrap 1000)', () => {
    const t = eastbound();
    const motion: MotionConfig = {
      mode: 'velocity',
      maxExtrapolationMs: 1000,
      ...DEG,
    };
    const cfg: TrackSampleConfig = { ...BASE, fadeOutDuration: 3000, motion };

    const step = 0.25;
    const series = sweep(t, cfg, 0, 3000, step);
    expectMonotoneContinuousAlpha(
      series,
      step,
      3000,
      'fade 3000 / extrap 1000',
    );

    // Here the ramp DOES start inside the interior, because the pose really is
    // within 3000 ms of vanishing — but it is the same ramp on both sides.
    expect(sampleTrack(t, 1000, cfg)!.alpha).toBeCloseTo(2 / 3, 12);
    expect(sampleTrack(t, 2000, cfg)!.alpha).toBeCloseTo(1 / 3, 12);
    expect(sampleTrack(t, 2000.0001, cfg)!.alpha).toBeCloseTo(1 / 3, 6);
    expect(sampleTrack(t, 3000, cfg)!.alpha).toBe(0);
    expect(sampleTrack(t, 3000.0001, cfg)).toBeNull();
  });

  it('great-circle mode fades identically (same boundary, same ramp)', () => {
    const t = eastbound();
    const motion: MotionConfig = {
      mode: 'great-circle',
      maxExtrapolationMs: 2000,
      ...DEG,
    };
    const cfg: TrackSampleConfig = { ...BASE, fadeOutDuration: 1000, motion };
    const step = 0.25;
    const series = sweep(t, cfg, 1000, 4000, step);
    expectMonotoneContinuousAlpha(series, step, 1000, 'great-circle');
    expect(sampleTrack(t, 2000, cfg)!.alpha).toBe(1);
    expect(sampleTrack(t, 2000.0001, cfg)!.alpha).toBeCloseTo(1, 6);
    expect(sampleTrack(t, 3500, cfg)!.alpha).toBeCloseTo(0.5, 12);
    expect(sampleTrack(t, 4000, cfg)!.alpha).toBe(0);
  });

  it('keeps ramping to the LAST KEYFRAME when the prediction is unearned', () => {
    // `deriveVelocity: false` with no speed column ⇒ nothing to predict from, so
    // the track culls at `last` exactly as `'linear'` would. The fade must
    // therefore still land on `last`; hanging it on a horizon the pose will
    // never reach would pop the entity out of existence at full opacity.
    const t = track({
      times: [0, 1000, 2000],
      lon: [-100, -99.9, -99.8],
      lat: [40, 40, 40],
    });
    const motion: MotionConfig = {
      mode: 'velocity',
      maxExtrapolationMs: 4000,
      deriveVelocity: false,
      ...DEG,
    };
    const cfg: TrackSampleConfig = { ...BASE, fadeOutDuration: 500, motion };

    expect(sampleTrack(t, 1750, cfg)!.alpha).toBeCloseTo(0.5, 12);
    expect(sampleTrack(t, 2000, cfg)!.alpha).toBe(0);
    expect(sampleTrack(t, 2000.0001, cfg)).toBeNull();

    const step = 0.25;
    expectMonotoneContinuousAlpha(
      sweep(t, cfg, 1000, 2000, step),
      step,
      500,
      'unearned prediction',
    );
  });

  it("leaves 'linear' byte-identical to no motion config through the fade tail", () => {
    // `motion-linear-parity.test.ts` is the real gate; this is a local tripwire
    // so that a change to the fade block fails HERE, next to its own reasoning.
    const t = eastbound();
    const fades: TrackSampleConfig = {
      ...BASE,
      fadeInDuration: 800,
      fadeOutDuration: 3000,
    };
    const linear: TrackSampleConfig = { ...fades, motion: { mode: 'linear' } };
    for (let now = -400; now <= 2400; now += 25) {
      const a = sampleTrack(t, now, fades);
      const b = sampleTrack(t, now, linear);
      expect(a === null, `null-ness at now=${now}`).toBe(b === null);
      if (a === null || b === null) continue;
      expect(Object.is(a.alpha, b.alpha), `alpha at now=${now}`).toBe(true);
      expect(Object.is(a.lon, b.lon), `lon at now=${now}`).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(b, 'extrapolated')).toBe(
        false,
      );
    }
  });

  it('holds a singleton with no columns exactly as it always did', () => {
    // The hold band's own ramp is SHIPPED behaviour (the default sampler
    // measures against `last` too, so the far half of the hold is drawn at
    // alpha 0) and `'linear'` parity pins it. Nothing here may change it.
    const bare = track({ times: [10_000], lon: [-100], lat: [40] });
    const motion: MotionConfig = {
      mode: 'velocity',
      maxExtrapolationMs: 4000,
      ...DEG,
    };
    const withMotion: TrackSampleConfig = {
      ...BASE,
      fadeOutDuration: 200,
      singletonHoldMs: 600,
      motion,
    };
    const noMotion: TrackSampleConfig = {
      ...BASE,
      fadeOutDuration: 200,
      singletonHoldMs: 600,
    };
    for (let now = 9700; now <= 10_300; now += 5) {
      const a = sampleTrack(bare, now, noMotion);
      const b = sampleTrack(bare, now, withMotion);
      expect(a === null, `null-ness at now=${now}`).toBe(b === null);
      if (a === null || b === null) continue;
      expect(Object.is(a.alpha, b.alpha), `alpha at now=${now}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Prediction window vs singleton hold — both orderings
// ---------------------------------------------------------------------------

describe('singleton: prediction window against the hold band', () => {
  const HOLD = 600; // ⇒ pad 300
  const LAST = 10_000;
  const LON0 = -100;

  /**
   * The whole point, swept across the relationship the code branches on:
   * `maxExtrapolationMs` shorter than, equal to, and longer than
   * `singletonHoldMs / 2`. The predicted pose may stop advancing when the
   * window closes, but it may NEVER travel backwards — least of all all the way
   * back to the keyframe it flew away from.
   */
  for (const extrapMs of [50, 100, 299, 300, 301, 1000, 4000]) {
    it(`never reverses: maxExtrapolationMs ${extrapMs} vs hold/2 ${HOLD / 2}`, () => {
      const t = loneEastbound();
      const motion: MotionConfig = {
        mode: 'velocity',
        maxExtrapolationMs: extrapMs,
        ...DEG,
      };
      const cfg: TrackSampleConfig = {
        ...BASE,
        singletonHoldMs: HOLD,
        motion,
      };
      const cull = LAST + Math.max(HOLD / 2, extrapMs);

      const series = sweep(t, cfg, LAST, cull, 0.5);
      expect(series.length).toBeGreaterThan(2);
      for (let i = 1; i < series.length; i++) {
        expect(
          series[i].lon >= series[i - 1].lon,
          `lon went backwards: ${series[i - 1].lon} at now=${series[i - 1].now} → ${series[i].lon} at now=${series[i].now}`,
        ).toBe(true);
      }
      // Eastbound at 10 m/s: every predicted pose is strictly east of the
      // keyframe, including the ones past the horizon.
      for (const s of series) {
        if (s.now === LAST) continue;
        expect(s.lon, `lon at now=${s.now}`).toBeGreaterThan(LON0);
        expect(s.extrapolated, `extrapolated at now=${s.now}`).toBe(true);
      }

      // Past the horizon the prediction FREEZES — the pose is exactly the one
      // the horizon produced, and it reports that age.
      const atHorizon = sampleTrack(t, LAST + extrapMs, cfg)!;
      for (let now = LAST + extrapMs; now <= cull; now += 1) {
        const s = sampleTrack(t, now, cfg)!;
        expect(s, `held sample at now=${now}`).not.toBeNull();
        expect(
          Object.is(s.lon, atHorizon.lon),
          `frozen lon at now=${now}`,
        ).toBe(true);
        expect(s.extrapolationAgeMs, `age at now=${now}`).toBe(
          Math.min(now - LAST, extrapMs),
        );
      }

      // The cull bound itself is unchanged: max(hold band, prediction window).
      expect(sampleTrack(t, cull, cfg)).not.toBeNull();
      expect(sampleTrack(t, cull + 0.0001, cfg)).toBeNull();
    });
  }

  it('fades the frozen tail on one ramp that ends at the cull bound', () => {
    const t = loneEastbound();
    const motion: MotionConfig = {
      mode: 'velocity',
      maxExtrapolationMs: 100,
      ...DEG,
    };
    const cfg: TrackSampleConfig = {
      ...BASE,
      fadeOutDuration: 200,
      singletonHoldMs: HOLD,
      motion,
    };
    const step = 0.25;
    const series = sweep(t, cfg, LAST, LAST + 300, step);
    expectMonotoneContinuousAlpha(series, step, 200, 'frozen singleton tail');
    expect(sampleTrack(t, LAST + 100, cfg)!.alpha).toBe(1);
    expect(sampleTrack(t, LAST + 200, cfg)!.alpha).toBeCloseTo(0.5, 12);
    expect(sampleTrack(t, LAST + 300, cfg)!.alpha).toBe(0);
  });

  it('does not change the shorter-hold case a two-keyframe track sees', () => {
    // Non-singletons have pad 0, so `max(hold, extrapolation)` is the window and
    // the freeze branch is unreachable for them: they still cull AT the horizon.
    const t = eastbound();
    const motion: MotionConfig = {
      mode: 'velocity',
      maxExtrapolationMs: 500,
      ...DEG,
    };
    const cfg: TrackSampleConfig = {
      ...BASE,
      singletonHoldMs: 60_000,
      motion,
    };
    expect(sampleTrack(t, 2500, cfg)).not.toBeNull();
    expect(sampleTrack(t, 2500, cfg)!.extrapolationAgeMs).toBe(500);
    expect(sampleTrack(t, 2500.0001, cfg)).toBeNull();
  });
});

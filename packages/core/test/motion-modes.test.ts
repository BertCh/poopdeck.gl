// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

/**
 * The motion modes themselves — what `'velocity'` and `'great-circle'` DO, once
 * `motion-linear-parity.test.ts` has established that switching the feature on
 * changes nothing for everyone who did not ask for it.
 *
 * The two modes exist for two named archive shapes this project ships:
 *   • AIS (`ais-all-us`, ~19M features) reports a vessel every few minutes but
 *     carries `sog` (KNOTS) and `cog` (compass degrees) columns that say exactly
 *     where it is going — so a pose can be predicted forward instead of frozen.
 *   • `flights` / `adsb-paths` cross oceans, where a lon/lat lerp draws a rhumb
 *     line hundreds of kilometres off the great circle actually flown.
 *
 * Two structural invariants are pinned alongside the behaviour, because both
 * are silent when broken: the sampler must NEVER write to a `Track`'s parallel
 * arrays (they can be `Float64Array.subarray` views, and the NaN columns can be
 * ONE array aliased by every track in a tile), and it must be deterministic
 * (the extrapolated path uses module-level scratch objects, so a leaked
 * reference would make sample N depend on sample N−1).
 */

import { describe, it, expect } from 'vitest';
import { sampleTrack, deriveMotionState } from '../src/render/track-kernel';
import type { Track, TrackSampleConfig } from '../src/render/track-kernel';
import {
  resolveMotionConfig,
  toCompassDeg,
  type MotionConfig,
  type MotionState,
} from '../src/render/motion';
import {
  destinationPoint,
  initialBearingDeg,
  greatCircleCourseDeg,
  interpolateGreatCircle,
  haversineMeters,
  type LonLat,
} from '../src/geo/spherical';
import { LAX_JFK } from './helpers/geodesy-goldens';

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
  /** Per-keyframe heading in whatever unit/convention the config declares. */
  heading?: number[];
  /** Per-keyframe speed in whatever unit the config declares. */
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

const OUT: LonLat = { lon: 0, lat: 0 };

// ---------------------------------------------------------------------------
// velocity — interior
// ---------------------------------------------------------------------------

describe("motion mode 'velocity': interior", () => {
  it('interpolates the bracket exactly as linear does (away from the seam)', () => {
    const t = track({
      times: [0, 10_000],
      lon: [-100, -99],
      lat: [40, 41],
      heading: [0.1, 0.2],
      speed: [10, 12],
    });
    for (let now = 0; now <= 10_000; now += 250) {
      const lin = sampleTrack(t, now, { ...BASE, motion: { mode: 'linear' } })!;
      const vel = sampleTrack(t, now, {
        ...BASE,
        motion: { mode: 'velocity' },
      })!;
      // `velocity` differs from `linear` inside a bracket only by the wrapped
      // longitude lerp, which is a no-op away from the antimeridian.
      expect(vel.lon).toBeCloseTo(lin.lon, 9);
      expect(vel.lat).toBe(lin.lat);
      expect(vel.heading).toBe(lin.heading);
      expect(vel.alpha).toBe(lin.alpha);
      expect(vel.extrapolated).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// velocity — exterior (the point of the mode)
// ---------------------------------------------------------------------------

describe("motion mode 'velocity': extrapolation past the terminal keyframe", () => {
  const cfg = (motion: MotionConfig): TrackSampleConfig => ({
    ...BASE,
    motion,
  });

  /**
   * Two keyframes, then columns saying "12 m/s due east" at the terminal one.
   * The heading column is MATH-convention radians (0 = east, CCW) — the
   * spelling `animated-bounding-box-layer.ts` feeds its velocity arrow — so due
   * east is 0, not π/2. Getting this backwards is exactly the confusion
   * `courseConvention` exists to make impossible to have silently.
   */
  const eastbound = () =>
    track({
      times: [0, 10_000],
      lon: [-100, -99.9],
      lat: [40, 40],
      heading: [0, 0],
      speed: [12, 12],
    });

  it('lands exactly on destinationPoint(terminal, course, speed·dt) 10 s past the end', () => {
    const t = eastbound();
    const motion: MotionConfig = {
      mode: 'velocity',
      maxExtrapolationMs: 60_000,
      courseConvention: 'math',
    };
    const s = sampleTrack(t, 20_000, cfg(motion))!;
    const want = destinationPoint(-99.9, 40, 90, 12 * 10, { lon: 0, lat: 0 });
    expect(Object.is(s.lon, want.lon)).toBe(true);
    expect(Object.is(s.lat, want.lat)).toBe(true);
    expect(s.extrapolated).toBe(true);
    expect(s.extrapolationAgeMs).toBe(10_000);
    // A real heading column is echoed back untouched — the pose is predicted,
    // the orientation is measured.
    expect(s.heading).toBe(0);
  });

  it('is non-null AT the horizon and null one millisecond past it', () => {
    const t = eastbound();
    const motion: MotionConfig = {
      mode: 'velocity',
      maxExtrapolationMs: 30_000,
      courseConvention: 'math',
    };
    expect(sampleTrack(t, 10_000 + 30_000, cfg(motion))).not.toBeNull();
    expect(sampleTrack(t, 10_000 + 30_001, cfg(motion))).toBeNull();
  });

  it('derives the velocity from the LAST bracket when the columns are absent', () => {
    // No speed / heading columns at all: the finite difference must recover
    // both, and the predicted point must stay on the great circle the entity
    // was already travelling.
    const t = track({
      times: [0, 10_000, 20_000],
      lon: [-100, -99.5, -99],
      lat: [40, 40.2, 40.4],
    });
    const s = sampleTrack(t, 30_000, {
      ...BASE,
      motion: { mode: 'velocity', maxExtrapolationMs: 60_000 },
    })!;
    expect(s.extrapolated).toBe(true);
    const bracketBearing = initialBearingDeg(-99.5, 40.2, -99, 40.4);
    const predictedBearing = initialBearingDeg(-99.5, 40.2, s.lon, s.lat);
    expect(predictedBearing).toBeCloseTo(bracketBearing, 6);
    // Speed too: the sample is 10 s past a 10 s bracket, so the predicted point
    // is one whole bracket-length beyond the terminal keyframe, to ±1 mm.
    const bracketDist = haversineMeters(-99.5, 40.2, -99, 40.4);
    expect(haversineMeters(-99, 40.4, s.lon, s.lat)).toBeCloseTo(
      bracketDist,
      3,
    );
  });

  it('deriveVelocity:false culls at the last keyframe when there are no columns', () => {
    const t = track({
      times: [0, 10_000],
      lon: [-100, -99.5],
      lat: [40, 40],
    });
    const motion: MotionConfig = {
      mode: 'velocity',
      maxExtrapolationMs: 60_000,
      deriveVelocity: false,
    };
    expect(sampleTrack(t, 10_000, cfg(motion))).not.toBeNull();
    expect(sampleTrack(t, 10_001, cfg(motion))).toBeNull();
  });

  it('extrapolates a SINGLETON that carries columns, and holds one that does not', () => {
    const withCols = track({
      times: [10_000],
      lon: [-100],
      lat: [40],
      heading: [0], // math convention, radians ⇒ due east
      speed: [12],
    });
    const bare = track({ times: [10_000], lon: [-100], lat: [40] });
    const motion: MotionConfig = {
      mode: 'velocity',
      maxExtrapolationMs: 30_000,
      courseConvention: 'math',
    };

    // With columns: flies on, well past the 300 ms hold band.
    const flown = sampleTrack(withCols, 20_000, cfg(motion))!;
    expect(flown).not.toBeNull();
    expect(flown.extrapolated).toBe(true);
    expect(flown.lon).toBeGreaterThan(-100);

    // Without: no velocity to derive (one keyframe = no pair), so it falls back
    // to the ±singletonHoldMs/2 hold and then culls.
    expect(sampleTrack(bare, 10_000 + 300, cfg(motion))).not.toBeNull();
    const held = sampleTrack(bare, 10_000 + 200, cfg(motion))!;
    expect(held.extrapolated).toBeUndefined();
    expect(held.lon).toBe(-100);
    expect(sampleTrack(bare, 10_000 + 300.0001, cfg(motion))).toBeNull();

    // …and the hold band honours singletonHoldMs: 400 ms ⇒ ±200 ms, so 150 is
    // inside and 250 — which the default 600 ms would have admitted — is not.
    const hold400 = { ...BASE, motion, singletonHoldMs: 400 };
    expect(sampleTrack(bare, 10_000 + 150, hold400)).not.toBeNull();
    expect(sampleTrack(bare, 10_000 + 150, hold400)!.lon).toBe(-100);
    expect(sampleTrack(bare, 10_000 + 250, hold400)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Units and conventions
// ---------------------------------------------------------------------------

describe('motion: speed units and course conventions', () => {
  it("speedUnit 'kn' scales the extrapolated distance by exactly 1852/3600", () => {
    const t = track({
      times: [0, 10_000],
      lon: [0, 0.01],
      lat: [0, 0],
      heading: [90, 90],
      speed: [20, 20], // 20 knots
    });
    const common = {
      maxExtrapolationMs: 60_000,
      courseUnit: 'deg' as const,
      courseConvention: 'compass' as const,
    };
    const knots = sampleTrack(t, 20_000, {
      ...BASE,
      motion: { mode: 'velocity', speedUnit: 'kn', ...common },
    })!;
    const mps = sampleTrack(t, 20_000, {
      ...BASE,
      motion: { mode: 'velocity', speedUnit: 'mps', ...common },
    })!;
    const dKnots = haversineMeters(0.01, 0, knots.lon, knots.lat);
    const dMps = haversineMeters(0.01, 0, mps.lon, mps.lat);
    // 9 digits, not 15: `wrapLonDeg` folds through ±180, which costs ~3e-14° of
    // ABSOLUTE longitude precision (≈ 3 nanometres of ground). That is inherent
    // to the fold and is pinned bitwise-identical to `archive.ts`'s `wrapLon` by
    // `spherical.test.ts`, so it is not a defect to tighten away here.
    expect(dKnots / dMps).toBeCloseTo(1852 / 3600, 9);
    // …and the absolute distance is the arithmetic, not a fudge factor.
    expect(dKnots).toBeCloseTo(20 * (1852 / 3600) * 10, 6);
  });

  it("'math' and 'compass' headings displace mirrored about the 45° line", () => {
    // At the equator, one degree of longitude and one of latitude are the same
    // ground distance, so a mirrored bearing shows up as swapped Δlon/Δlat.
    const t = track({
      times: [0, 10_000],
      lon: [0, 0],
      lat: [0, 0],
      heading: [30, 30],
      speed: [100, 100],
    });
    const common = {
      mode: 'velocity' as const,
      maxExtrapolationMs: 60_000,
      courseUnit: 'deg' as const,
    };
    const compass = sampleTrack(t, 20_000, {
      ...BASE,
      motion: { ...common, courseConvention: 'compass' },
    })!;
    const math = sampleTrack(t, 20_000, {
      ...BASE,
      motion: { ...common, courseConvention: 'math' },
    })!;
    expect(compass.lon).toBeCloseTo(math.lat, 6);
    expect(compass.lat).toBeCloseTo(math.lon, 6);
    // Compass 30° is mostly north; math 30° is mostly east.
    expect(compass.lat).toBeGreaterThan(compass.lon);
    expect(math.lon).toBeGreaterThan(math.lat);
  });

  it('a DERIVED heading is written back in the caller’s own unit + convention', () => {
    // Due east, no heading column ⇒ the course is derived as compass 90°.
    const eastbound = track({
      times: [0, 10_000, 20_000],
      lon: [0, 0.1, 0.2],
      lat: [0, 0, 0],
    });
    const cases: {
      courseUnit: 'deg' | 'rad';
      courseConvention: 'compass' | 'math';
      expect: number;
    }[] = [
      { courseUnit: 'deg', courseConvention: 'compass', expect: 90 },
      { courseUnit: 'deg', courseConvention: 'math', expect: 0 },
      { courseUnit: 'rad', courseConvention: 'compass', expect: Math.PI / 2 },
      { courseUnit: 'rad', courseConvention: 'math', expect: 0 },
    ];
    for (const c of cases) {
      const s = sampleTrack(eastbound, 25_000, {
        ...BASE,
        motion: {
          mode: 'velocity',
          maxExtrapolationMs: 60_000,
          courseUnit: c.courseUnit,
          courseConvention: c.courseConvention,
        },
      })!;
      expect(s.extrapolated).toBe(true);
      expect(s.heading, `${c.courseUnit}/${c.courseConvention}`).toBeCloseTo(
        c.expect,
        6,
      );
      // Round-tripping it back through toCompassDeg recovers the course.
      expect(
        toCompassDeg(s.heading, c.courseUnit, c.courseConvention),
      ).toBeCloseTo(90, 6);
    }
  });
});

// ---------------------------------------------------------------------------
// great-circle
// ---------------------------------------------------------------------------

describe("motion mode 'great-circle'", () => {
  const laxJfk = (heading?: number[]) =>
    track({
      times: [0, 10_000],
      lon: [LAX_JFK.from[0], LAX_JFK.to[0]],
      lat: [LAX_JFK.from[1], LAX_JFK.to[1]],
      heading,
    });

  it('bulges north of the lat-lerp midpoint by the golden amount', () => {
    const t = laxJfk();
    const gc = sampleTrack(t, 5000, {
      ...BASE,
      motion: { mode: 'great-circle' },
    })!;
    const lin = sampleTrack(t, 5000, { ...BASE, motion: { mode: 'linear' } })!;
    const want = interpolateGreatCircle(
      LAX_JFK.from[0],
      LAX_JFK.from[1],
      LAX_JFK.to[0],
      LAX_JFK.to[1],
      0.5,
      OUT,
    );
    expect(gc.lon).toBeCloseTo(want.lon, 12);
    expect(gc.lat).toBeCloseTo(want.lat, 12);
    // The whole reason the mode exists, in one number: ~2.17° ≈ 240 km north.
    expect(gc.lat - lin.lat).toBeCloseTo(2.1653, 3);
  });

  it('reads the heading off the arc when there is no heading column', () => {
    const t = laxJfk();
    for (const f of [0.25, 0.5, 0.75]) {
      const s = sampleTrack(t, f * 10_000, {
        ...BASE,
        motion: { mode: 'great-circle', courseUnit: 'deg' },
      })!;
      expect(s.heading).toBeCloseTo(
        greatCircleCourseDeg(
          LAX_JFK.from[0],
          LAX_JFK.from[1],
          LAX_JFK.to[0],
          LAX_JFK.to[1],
          f,
        ),
        9,
      );
    }
  });

  it('a heading column still wins over the derived arc course', () => {
    const t = laxJfk([10, 20]);
    const s = sampleTrack(t, 5000, {
      ...BASE,
      motion: { mode: 'great-circle', courseUnit: 'deg' },
      angleUnit: 'deg',
    })!;
    expect(s.heading).toBeCloseTo(15, 9); // the column's own shortest-arc lerp
  });
});

// ---------------------------------------------------------------------------
// deriveMotionState directly
// ---------------------------------------------------------------------------

describe('deriveMotionState', () => {
  const resolved = (m: MotionConfig) => resolveMotionConfig(m, 'rad');
  const out: MotionState = { speedMps: NaN, courseDeg: NaN, atIndex: -1 };

  it('prefers the columns, converting units and conventions', () => {
    const t = track({
      times: [0, 1000],
      lon: [0, 1],
      lat: [0, 0],
      heading: [0, 0],
      speed: [10, 10],
    });
    const st = deriveMotionState(
      t,
      1,
      resolved({ mode: 'velocity', speedUnit: 'kn', courseUnit: 'deg' }),
      out,
    );
    expect(st).toBe(out); // out-param honoured
    expect(st.speedMps).toBeCloseTo(10 * (1852 / 3600), 12);
    expect(st.courseDeg).toBe(0);
    expect(st.atIndex).toBe(1);
  });

  it('returns NaN speed for a singleton with no speed column', () => {
    const solo = track({ times: [0], lon: [0], lat: [0] });
    const st = deriveMotionState(solo, 0, resolved({ mode: 'velocity' }), out);
    expect(Number.isNaN(st.speedMps)).toBe(true);
  });

  it('differences the pair ENDING at the terminal keyframe (forward-only)', () => {
    // Three keyframes with a deliberate direction change: the derived course at
    // the LAST index must follow the last leg (north), not the first (east).
    const t = track({
      times: [0, 1000, 2000],
      lon: [0, 1, 1],
      lat: [0, 0, 1],
    });
    const st = deriveMotionState(t, 2, resolved({ mode: 'velocity' }), out);
    expect(st.courseDeg).toBeCloseTo(initialBearingDeg(1, 0, 1, 1), 9);
    expect(st.speedMps).toBeCloseTo(haversineMeters(1, 0, 1, 1) / 1, 6);
  });
});

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------

describe('motion: structural invariants', () => {
  const MOTION: MotionConfig = {
    mode: 'velocity',
    maxExtrapolationMs: 20_000,
    courseConvention: 'math',
  };

  it('is deterministic — 1000 repeats of one draw agree exactly', () => {
    const t = track({
      times: [0, 10_000, 20_000],
      lon: [-100, -99.5, -99],
      lat: [40, 40.2, 40.4],
      speed: [12, 12, 12],
    });
    const cfg: TrackSampleConfig = { ...BASE, motion: MOTION };
    const ref = sampleTrack(t, 25_000, cfg)!;
    for (let i = 0; i < 1000; i++) {
      const s = sampleTrack(t, 25_000, cfg)!;
      expect(Object.is(s.lon, ref.lon)).toBe(true);
      expect(Object.is(s.lat, ref.lat)).toBe(true);
      expect(Object.is(s.heading, ref.heading)).toBe(true);
      // The scratch objects must not leak: every call gets a fresh Sample.
      expect(s).not.toBe(ref);
    }
  });

  it('never writes to a Track parallel array (1000 samples, all modes)', () => {
    const t = track({
      times: [0, 10_000, 20_000],
      lon: [179.5, 179.9, -179.7],
      lat: [40, 40.2, 40.4],
      heading: [0.1, 0.2, 0.3],
      speed: [12, 13, 14],
    });
    const before = {
      times: [...t.times],
      lon: [...t.lon],
      lat: [...t.lat],
      alt: [...t.alt],
      heading: [...t.heading],
      length: [...t.length],
      width: [...t.width],
      height: [...t.height],
      speed: [...t.speed],
    };
    for (const mode of ['linear', 'velocity', 'great-circle'] as const) {
      for (let i = 0; i < 1000; i++) {
        sampleTrack(t, (i * 25) % 26_000, {
          ...BASE,
          motion: { mode, maxExtrapolationMs: 5000 },
        });
      }
    }
    for (const k of Object.keys(before) as (keyof typeof before)[]) {
      expect(t[k], `Track.${k} mutated`).toEqual(before[k]);
    }
    expect(t.times.length).toBe(3);
  });

  it('resolveMotionConfig is memoized per (config identity, angle unit)', () => {
    const m: MotionConfig = { mode: 'velocity' };
    expect(resolveMotionConfig(m, 'rad')).toBe(resolveMotionConfig(m, 'rad'));
    expect(resolveMotionConfig(m, undefined)).toBe(
      resolveMotionConfig(m, 'rad'),
    );
    // A different inherited angle unit is a different resolution (courseUnit
    // defaults to it), so it must NOT collide in the cache.
    expect(resolveMotionConfig(m, 'deg')).not.toBe(
      resolveMotionConfig(m, 'rad'),
    );
    expect(resolveMotionConfig(m, 'deg').courseUnit).toBe('deg');
    expect(resolveMotionConfig(m, 'rad').courseUnit).toBe('rad');
  });

  it('resolves the per-mode wrapLongitude defaults', () => {
    expect(resolveMotionConfig({ mode: 'linear' }, 'rad').wrapLongitude).toBe(
      false,
    );
    expect(resolveMotionConfig({ mode: 'velocity' }, 'rad').wrapLongitude).toBe(
      true,
    );
    expect(
      resolveMotionConfig({ mode: 'great-circle' }, 'rad').wrapLongitude,
    ).toBe(true);
    // …and an explicit value always wins.
    expect(
      resolveMotionConfig({ mode: 'velocity', wrapLongitude: false }, 'rad')
        .wrapLongitude,
    ).toBe(false);
  });
});

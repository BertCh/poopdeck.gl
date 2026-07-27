/**
 * Track-kernel re-export smoke test (deck side).
 *
 * The kernel itself was hoisted to framework-free `@poopdeck.gl/core`
 * (`src/render/track-kernel.ts`, campaign D7) and its full unit suite lives
 * there (`packages/core/test/track-kernel.test.ts` +
 * `motion-glide-incremental.test.ts`). `packages/layers/src/lib/track-kernel.ts`
 * remains as the deck-side import path every `AnimatedPoint/Icon/BoundingBox/
 * Mesh` layer imports from, so this test pins THAT path:
 *   1. every symbol the deck layers import still resolves through it, and
 *   2. the engine reached through it is the real one — a build + sample +
 *      incremental-sync round trip, so a broken/partial re-export (or a stale
 *      `@poopdeck.gl/core` dist) fails here instead of silently in a demo.
 *
 * The TYPE half of the contract (deck's `Record<string, Color>` colorMapping
 * flowing into the hoisted `TrackFieldConfig` uncast) is enforced by the package
 * `tsc --noEmit`, which compiles the four deck layers that do exactly that.
 */

import { describe, it, expect } from 'vitest';
import { makePointTile } from './fake-tile';
import {
  buildTrackIndex,
  sampleTrack,
  lerp,
  lerpAngle,
  lerpAngleDeg,
  lerpDim,
  readCategorical,
  resolveColor,
  makePickRow,
  TrackIndexMaintainer,
  RAD_TO_DEG,
  METERS_PER_DEG_LAT,
  SINGLETON_HOLD_MS,
  DEFAULT_TRACK_COLOR,
  MOTION_MODES,
  resolveMotionConfig,
  deriveMotionState,
  toMps,
  toCompassDeg,
  fromCompassDeg,
  SPHERE_RADIUS_M,
  wrapLonDeg,
  shortestLonDeltaDeg,
  haversineMeters,
  initialBearingDeg,
  destinationPoint,
  interpolateGreatCircle,
  greatCircleCourseDeg,
} from '../src/lib/track-kernel';
import type {
  Track,
  Sample,
  TrackColor,
  TrackPickRow,
  TrackFieldConfig,
  TrackSampleConfig,
  TrackIndexResult,
  MotionMode,
  MotionConfig,
  ResolvedMotionConfig,
  MotionState,
  CourseConvention,
  SpeedUnit,
  LonLat,
} from '../src/lib/track-kernel';
import type { Tile } from '@poopdeck.gl/core';

function categorical(values: string[]): {
  indices: Uint16Array;
  categories: string[];
} {
  const categories: string[] = [];
  const map = new Map<string, number>();
  const indices = new Uint16Array(values.length);
  values.forEach((v, i) => {
    let idx = map.get(v);
    if (idx === undefined) {
      idx = categories.length;
      categories.push(v);
      map.set(v, idx);
    }
    indices[i] = idx;
  });
  return { indices, categories };
}

const CFG: TrackFieldConfig = {
  trackIdProperty: 'track_id',
  colorProperty: 'category',
  labelProperty: 'category',
  headingProperty: 'heading',
  lengthProperty: 'length',
  widthProperty: 'width',
  heightProperty: 'height',
  speedProperty: 'speed',
  colorMapping: { car: [12, 34, 56, 200] },
  colorMappingDefault: [160, 160, 160, 255],
};

const SAMPLE: TrackSampleConfig = {
  defaultLength: 4,
  defaultWidth: 2,
  defaultHeight: 1.6,
  fadeInDuration: 0,
  fadeOutDuration: 0,
};

/** Track 'A': two keyframes 1000 ms apart, lon 0 → 10, heading 0 → π/2. */
function trackTile(tileT: number, lons: [number, number]): Tile {
  const tile = makePointTile({
    positions: [
      [lons[0], 0],
      [lons[1], 0],
    ],
    startTimes: [0, 1000],
    endTimes: [0, 1000],
    timeOffset: tileT,
    tileId: { z: 6, x: 1, y: 2, t: tileT },
  });
  const f = tile.layers[0].features;
  f.categoricalProps['track_id'] = categorical(['A', 'A']);
  f.categoricalProps['category'] = categorical(['car', 'car']);
  f.numericProps['heading'] = new Float32Array([0, Math.PI / 2]);
  f.numericProps['speed'] = new Float32Array([10, 20]);
  return tile;
}

describe('track-kernel re-export (deck import path → @poopdeck.gl/core)', () => {
  it('resolves every runtime symbol the deck layers import', () => {
    for (const fn of [
      buildTrackIndex,
      sampleTrack,
      lerp,
      lerpAngle,
      lerpAngleDeg,
      lerpDim,
      readCategorical,
      resolveColor,
      makePickRow,
    ]) {
      expect(typeof fn).toBe('function');
    }
    expect(typeof TrackIndexMaintainer).toBe('function');
    expect(RAD_TO_DEG).toBeCloseTo(180 / Math.PI, 12);
    expect(METERS_PER_DEG_LAT).toBe(111_320);
    expect(SINGLETON_HOLD_MS).toBe(600);
    expect(Array.from(DEFAULT_TRACK_COLOR as number[])).toEqual([
      160, 160, 160, 255,
    ]);
  });

  it('pools + interpolates through the re-export (real engine, not a stub)', () => {
    const result: TrackIndexResult = buildTrackIndex([trackTile(0, [0, 10])], {
      ...CFG,
    });
    expect(result.totalSnapshots).toBe(2);
    expect(result.trackIdMissing).toBe(false);
    expect(result.hasSpeedColumn).toBe(true);

    const track: Track = result.tracks.get('A')!;
    expect(track.singleton).toBe(false);
    // colorMapping baked from the category column.
    expect(track.color).toEqual([12, 34, 56, 200]);

    const s: Sample = sampleTrack(track, 500, SAMPLE)!;
    expect(s.lon).toBeCloseTo(5, 9);
    // 6 digits: heading/speed ride Float32 columns (the tile encoding).
    expect(s.heading).toBeCloseTo(Math.PI / 4, 6);
    expect(s.speed).toBeCloseTo(15, 6);
    expect(s.alpha).toBe(1);
    // Outside the keyframe span → culled.
    expect(sampleTrack(track, 9999, SAMPLE)).toBeNull();

    const row: TrackPickRow = makePickRow(s);
    expect(row.track_id).toBe('A');
    expect(row.category).toBe('car');

    // Scalar helpers reachable and behaving.
    expect(lerp(0, 10, 0.25)).toBeCloseTo(2.5, 12);
    expect(lerpDim(NaN, NaN, 0.5, 7)).toBe(7);
    expect(lerpAngleDeg(350, 10, 0.5)).toBeCloseTo(360, 9);
    const fallback: TrackColor = [1, 2, 3];
    expect(resolveColor('nope', null, fallback)).toEqual([1, 2, 3, 255]);
  });

  it('resolves every motion-mode + spherical symbol through the shim', () => {
    for (const fn of [
      resolveMotionConfig,
      deriveMotionState,
      toMps,
      toCompassDeg,
      fromCompassDeg,
      wrapLonDeg,
      shortestLonDeltaDeg,
      haversineMeters,
      initialBearingDeg,
      destinationPoint,
      interpolateGreatCircle,
      greatCircleCourseDeg,
    ]) {
      expect(typeof fn).toBe('function');
    }
    expect([...MOTION_MODES]).toEqual(['linear', 'velocity', 'great-circle']);
    // The sphere the motion path measures on is the trips-kernel mean radius,
    // NOT the WGS84 semi-major axis the projection kernel uses.
    expect(SPHERE_RADIUS_M).toBe(6_371_000);
    // Type-only imports are erased at runtime; naming them in a value position
    // is what makes the package `tsc --noEmit` prove they re-export.
    const typeWitness: {
      mode: MotionMode;
      cfg: MotionConfig;
      resolved: ResolvedMotionConfig;
      state: MotionState;
      convention: CourseConvention;
      unit: SpeedUnit;
      point: LonLat;
    } = {
      mode: 'velocity',
      cfg: { mode: 'velocity' },
      resolved: resolveMotionConfig({ mode: 'velocity' }, 'rad'),
      state: { speedMps: 1, courseDeg: 2, atIndex: 0 },
      convention: 'compass',
      unit: 'kn',
      point: { lon: 0, lat: 0 },
    };
    expect(typeWitness.resolved.mode).toBe('velocity');
    expect(typeWitness.resolved.wrapLongitude).toBe(true);
  });

  it("runs a real {mode:'velocity', maxExtrapolationMs} sample end to end", () => {
    // Two keyframes 1000 ms apart, plus a `speed` column (10 → 20 m/s). Past the
    // terminal keyframe the pose must be PREDICTED rather than culled — which is
    // the whole point of the mode, and is also the assertion that fails loudly
    // if `@poopdeck.gl/core`'s dist is stale.
    const track: Track = buildTrackIndex(
      [trackTile(0, [0, 10])],
      CFG,
    ).tracks.get('A')!;
    // The fixture's heading column is RADIANS (π/2 at the terminal keyframe),
    // compass convention ⇒ due east, which is the direction the track was
    // already travelling.
    const motion: MotionConfig = {
      mode: 'velocity',
      maxExtrapolationMs: 5000,
      courseConvention: 'compass',
    };
    // Without motion the track culls the instant it passes its last keyframe.
    expect(sampleTrack(track, 3000, SAMPLE)).toBeNull();

    const s = sampleTrack(track, 3000, { ...SAMPLE, motion })!;
    expect(s).not.toBeNull();
    expect(s.extrapolated).toBe(true);
    expect(s.extrapolationAgeMs).toBe(2000);
    // It kept heading east, past the terminal keyframe at lon 10.
    expect(s.lon).toBeGreaterThan(10);
    // The pick row now carries the prediction flag; a default-path row does not.
    expect(makePickRow(s).extrapolated).toBe(true);
    expect(
      Object.prototype.hasOwnProperty.call(
        makePickRow(sampleTrack(track, 500, SAMPLE)!),
        'extrapolated',
      ),
    ).toBe(false);
    // Past the horizon it culls again.
    expect(sampleTrack(track, 6001, { ...SAMPLE, motion })).toBeNull();
  });

  it('runs the incremental TrackIndexMaintainer through the re-export', () => {
    const a = trackTile(0, [0, 10]);
    const b = trackTile(2000, [20, 30]);
    const m = new TrackIndexMaintainer();
    m.sync([a, b], CFG);
    const incremental = m.sync([b], CFG); // evict A
    const fresh = buildTrackIndex([b], CFG);

    expect(new Set(incremental.tracks.keys())).toEqual(
      new Set(fresh.tracks.keys()),
    );
    expect(incremental.tracks.get('A')!.times).toEqual(
      fresh.tracks.get('A')!.times,
    );
    expect(incremental.totalSnapshots).toBe(fresh.totalSnapshots);
    // Only the track the churn touched was re-sorted.
    expect(m.resortedTrackIds).toEqual(['A']);
  });
});

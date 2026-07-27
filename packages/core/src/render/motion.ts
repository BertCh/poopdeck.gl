// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * Motion modes — the vocabulary the track kernel uses to decide HOW an entity
 * moves between (and just past) its keyframes.
 *
 * The shipped kernel has exactly one answer: lerp the two bracketing keyframes
 * in lon/lat. That is correct for dense AV object archives (10 Hz keyframes,
 * metres apart) and wrong in two named ways for the sparse archives this project
 * also ships: AIS reports a vessel every few minutes but carries `sog`/`cog`
 * columns that say precisely where it is going, and an ocean-crossing flight
 * lerped in lon/lat draws a rhumb line that leaves the great circle it actually
 * flew by hundreds of kilometres. This module names those two alternatives —
 * and nothing else.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────────
 * `'step'` is not a mode: it is exactly `TrackSampleConfig.maxGapMs: 0`, which
 * already holds `[lo]` for every bracket. A per-sample confidence that decays
 * with extrapolation age is not here either: the kernel already applies CPU
 * appear/disappear fade ramps to `Sample.alpha`, and a second multiplier on the
 * same channel double-fades. Teleport thresholds duplicate `maxGapMs` on a
 * second axis, and BACKWARD extrapolation has no consumer — AIS, ADS-B and AV
 * archives all predict forward. See docs/roadmap/renderer-architecture.md §2.15.
 *
 * ── UNITS ────────────────────────────────────────────────────────────────────
 * Nothing about a unit survives the trip into a tile: a `speed` column is just
 * f32, and AIS `sog` is KNOTS while AV `speed` is m/s. Likewise a column named
 * `heading` may be compass degrees (AIS `cog`) or math-convention radians (what
 * `animated-bounding-box-layer.ts` feeds its velocity arrow). Both are declared
 * per-config and normalized ONCE, at {@link resolveMotionConfig}, into this
 * module's internal currency: metres per second and COMPASS degrees. Everything
 * written back onto a `Sample` is converted back into the caller's own unit and
 * convention by {@link fromCompassDeg}, so `getAngle` / `getOrientation` / the
 * velocity arrow see exactly the numbers they saw before.
 *
 * Imports only `../geo/spherical.js` — never the track kernel — so the
 * dependency edge stays one-way (`track-kernel → motion`) and this module can be
 * unit-tested without building a `Track`.
 */

import type { LonLat } from '../geo/spherical.js';
import { wrapLonDeg } from '../geo/spherical.js';

/**
 * How a pose moves between keyframes, and whether it may move past the last one.
 *
 * - `'linear'` — today's shipped behaviour, byte for byte: lerp lon/lat, never
 *   extrapolate. The default when no `motion` config is supplied at all.
 * - `'velocity'` — lerp inside a bracket exactly as `'linear'` does, but past
 *   the terminal keyframe continue on the entity's own speed + course
 *   (`destinationPoint`) for up to `maxExtrapolationMs`.
 * - `'great-circle'` — interpolate along the great circle rather than in
 *   lon/lat, and extrapolate the same way `'velocity'` does. The mode for
 *   trans-oceanic flights and long AIS legs.
 */
export type MotionMode = 'linear' | 'velocity' | 'great-circle';

/** Every valid {@link MotionMode}, for validation and for exhaustiveness tests. */
export const MOTION_MODES: readonly MotionMode[] = [
  'linear',
  'velocity',
  'great-circle',
] as const;

/**
 * Which way an angle column is measured.
 *
 * - `'compass'` — 0 = north, increasing CLOCKWISE. AIS `cog`, aircraft
 *   `heading`, and this module's internal currency.
 * - `'math'` — 0 = east, increasing COUNTER-CLOCKWISE. What
 *   `animated-bounding-box-layer.ts` assumes when it builds
 *   `vx = speed·cos(heading)` (east) / `vy = speed·sin(heading)` (north).
 *
 * BOTH spellings exist in this repo under the name `heading`, which is precisely
 * why the convention has to be declared rather than guessed.
 */
export type CourseConvention = 'compass' | 'math';

/** Unit of a speed column. No unit travels with the archive, so it is declared. */
export type SpeedUnit = 'mps' | 'kn' | 'kmh' | 'mph';

/** Knots → m/s. The AIS `sog` conversion, exact by construction. */
const KN_TO_MPS = 1852 / 3600;
/** km/h → m/s. */
const KMH_TO_MPS = 1000 / 3600;
/** mph → m/s (international mile, 1609.344 m exactly). */
const MPH_TO_MPS = 1609.344 / 3600;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/**
 * Opt-in motion configuration. Passing ANY config (even `{mode: 'linear'}`)
 * routes the sampler down the extended path; passing none leaves the historical
 * path untouched, which is the invariant `motion-linear-parity.test.ts` pins.
 */
export interface MotionConfig {
  /** @see MotionMode */
  mode: MotionMode;
  /**
   * How far past the terminal keyframe a pose may be predicted, as a DURATION in
   * ms. Never an absolute time: three's GPU glide texture stores `t0`/`invDt`/
   * `frameMax` as f32 RELATIVE to the scene `timeOrigin`, and an absolute epoch
   * millisecond does not survive f32 (52 bits into 24).
   *
   * Keep it `<= timeWindow / 2`. The loader keeps tiles within ±`timeWindow`/2
   * of the playhead, so a prediction reaching further than that outlives the data
   * that justified it — the entity keeps flying after its own tile is evicted.
   * Same arithmetic as the gap/window coupling in
   * docs/roadmap/renderer-architecture.md §2.15.
   *
   * Ignored by `'linear'`, which is pinned to the shipped no-extrapolation
   * behaviour.
   *
   * @default 0
   */
  maxExtrapolationMs?: number;
  /**
   * When the speed / course columns are absent or NaN at the keyframe being
   * extrapolated from, finite-difference the adjacent keyframe PAIR to recover
   * them. Turning this off makes extrapolation strictly column-driven: a track
   * with no `speed` column then culls at its last keyframe exactly as
   * `'linear'` does.
   * @default true
   */
  deriveVelocity?: boolean;
  /**
   * Unit of `Track.speed` (the column named by `TrackFieldConfig.speedProperty`).
   * @default 'mps'
   */
  speedUnit?: SpeedUnit;
  /**
   * Name of the archive column that fed `Track.speed`, for provenance only —
   * `buildTrackIndex` has already funnelled `TrackFieldConfig.speedProperty`
   * into the parallel array, so the sampler reads the array, not this. Declared
   * so a telemetry line or a doctor report can say WHICH column a derived
   * velocity disagreed with.
   * @default '' — meaning "whatever TrackFieldConfig.speedProperty named"
   */
  speedProperty?: string;
  /**
   * Name of the archive column that fed `Track.heading`. Provenance only, for
   * the same reason as {@link speedProperty}.
   * @default '' — meaning "whatever TrackFieldConfig.headingProperty named"
   */
  courseProperty?: string;
  /** @default 'compass' @see CourseConvention */
  courseConvention?: CourseConvention;
  /**
   * Angular unit of `Track.heading`.
   * @default inherited from `TrackSampleConfig.angleUnit` (itself `'rad'`)
   */
  courseUnit?: 'deg' | 'rad';
  /**
   * Take the SHORT way round the antimeridian when interpolating longitude.
   *
   * Defaults are per-mode and not uniform, on purpose:
   * - `'linear'` → **false**, preserving the shipped seam behaviour byte for
   *   byte. A pair straddling the antimeridian (179.9 → −179.9) currently sweeps
   *   the entity 359.8° the wrong way round the planet. That is a real bug, but
   *   it is a SHIPPED one, and flipping it silently under every existing deck
   *   layer is not something a motion-mode change gets to do.
   * - `'velocity'` → **true**. The mode is new, so it starts correct.
   * - `'great-circle'` → **true**, though the flag is moot: slerping direction
   *   vectors is seam-correct by construction.
   */
  wrapLongitude?: boolean;
}

/**
 * A {@link MotionConfig} with every field resolved: no `undefined`, speeds
 * interpreted in m/s, angles interpreted in compass degrees. Produced only by
 * {@link resolveMotionConfig}.
 */
export interface ResolvedMotionConfig {
  readonly mode: MotionMode;
  readonly maxExtrapolationMs: number;
  readonly deriveVelocity: boolean;
  readonly speedUnit: SpeedUnit;
  readonly speedProperty: string;
  readonly courseProperty: string;
  readonly courseConvention: CourseConvention;
  readonly courseUnit: 'deg' | 'rad';
  readonly wrapLongitude: boolean;
}

/** Per-config resolution cache, keyed first by config identity then by unit. */
const RESOLVED = new WeakMap<
  MotionConfig,
  Partial<Record<'rad' | 'deg', ResolvedMotionConfig>>
>();

/**
 * Fill in every default, once per (config object identity, inherited angle
 * unit) pair. MEMOIZED through a module-level `WeakMap`, because the sampler
 * calls this per ENTITY per FRAME: a fresh resolved object per call would be
 * thousands of short-lived allocations a second on an `ais-all-us`-scale scene,
 * and the GC pause is exactly the stutter the motion path exists to remove. The
 * `WeakMap` also means a layer that rebuilds its props object each render pays
 * one resolve per render, not one per entity, and a discarded config is
 * collected with no eviction bookkeeping.
 *
 * Layers therefore MUST hold their `motion` prop reference-stable (the same
 * discipline every other cache-keyed prop in this repo needs); a fresh literal
 * per render still works, it just re-resolves once.
 */
export function resolveMotionConfig(
  m: MotionConfig,
  angleUnit: 'rad' | 'deg' | undefined,
): ResolvedMotionConfig {
  const unit: 'rad' | 'deg' = angleUnit === 'deg' ? 'deg' : 'rad';
  let byUnit = RESOLVED.get(m);
  if (byUnit) {
    const hit = byUnit[unit];
    if (hit) return hit;
  } else {
    byUnit = {};
    RESOLVED.set(m, byUnit);
  }

  const mode: MotionMode = m.mode;
  const resolved: ResolvedMotionConfig = {
    mode,
    maxExtrapolationMs: m.maxExtrapolationMs ?? 0,
    deriveVelocity: m.deriveVelocity ?? true,
    speedUnit: m.speedUnit ?? 'mps',
    speedProperty: m.speedProperty ?? '',
    courseProperty: m.courseProperty ?? '',
    courseConvention: m.courseConvention ?? 'compass',
    courseUnit: m.courseUnit ?? unit,
    // Per-mode default — see MotionConfig.wrapLongitude for why it is not uniform.
    wrapLongitude: m.wrapLongitude ?? mode !== 'linear',
  };
  byUnit[unit] = resolved;
  return resolved;
}

/**
 * One entity's instantaneous motion at a keyframe, in this module's internal
 * currency. `speedMps` is NaN when neither the column nor a finite difference
 * produced a value — the caller must then NOT extrapolate.
 */
export interface MotionState {
  speedMps: number;
  courseDeg: number;
  /** Keyframe index the state was read at (echoed back for the caller's logs). */
  atIndex: number;
}

/** Convert a speed in `u` to metres per second. */
export function toMps(v: number, u: SpeedUnit): number {
  switch (u) {
    case 'kn':
      return v * KN_TO_MPS;
    case 'kmh':
      return v * KMH_TO_MPS;
    case 'mph':
      return v * MPH_TO_MPS;
    default:
      return v;
  }
}

/**
 * Convert an angle in the caller's unit + convention into COMPASS degrees in
 * [0, 360). NaN in ⇒ NaN out (an absent heading column must stay absent, not
 * become "due north").
 */
export function toCompassDeg(
  v: number,
  u: 'deg' | 'rad',
  c: CourseConvention,
): number {
  if (!Number.isFinite(v)) return NaN;
  const deg = u === 'rad' ? v * RAD2DEG : v;
  // math (0 = east, CCW) → compass (0 = north, CW) is a reflection, not a shift.
  const compass = c === 'math' ? 90 - deg : deg;
  return ((compass % 360) + 360) % 360;
}

/**
 * Inverse of {@link toCompassDeg}: COMPASS degrees back into the caller's unit
 * and convention, so a heading the motion path DERIVED lands on `Sample.heading`
 * indistinguishable from one the archive supplied. `getAngle`,
 * `getOrientation` and the velocity arrow are untouched by the motion work
 * precisely because everything funnels through here.
 *
 * The result is normalized to [0, 360) before the unit conversion, so it is
 * angularly — not bitwise — equal to whatever went in.
 */
export function fromCompassDeg(
  deg: number,
  u: 'deg' | 'rad',
  c: CourseConvention,
): number {
  if (!Number.isFinite(deg)) return NaN;
  const native = c === 'math' ? 90 - deg : deg;
  const wrapped = ((native % 360) + 360) % 360;
  return u === 'rad' ? wrapped * DEG2RAD : wrapped;
}

/**
 * Longitude lerp that takes the SHORT way across the antimeridian, folded back
 * into [-180, 180). Used only when {@link MotionConfig.wrapLongitude} resolves
 * true — `'linear'` keeps the plain lerp so its output stays byte-identical to
 * the shipped kernel.
 */
export function lerpLonWrapped(a: number, b: number, f: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  return wrapLonDeg(a + d * f);
}

/** Clamp a latitude into the only range a sphere has. */
export function clampLat(lat: number): number {
  return lat < -90 ? -90 : lat > 90 ? 90 : lat;
}

/** Re-exported so consumers of the motion vocabulary need one import, not two. */
export type { LonLat };

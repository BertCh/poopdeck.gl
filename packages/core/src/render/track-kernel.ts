// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * Track kernel — the shared CPU pool-by-track + per-frame interpolation engine
 * behind the "one smooth-moving instance per tracked object" layers
 * (AnimatedBoundingBoxLayer's oriented cuboids and AnimatedMeshLayer's 3D
 * models). It exists so that machinery lives in EXACTLY ONE place: this codebase
 * has a documented CPU-logic-drift problem where hand-copied per-frame math
 * silently diverges between renderers, and this pooling/interpolation code is a
 * prime candidate (originally lifted from AnimatedTripHeadsLayer).
 *
 * It lives in framework-free `@poopdeck.gl/core` rather than in
 * `@poopdeck.gl/layers` so EVERY renderer backend — deck, maplibre/mapbox,
 * three, Cesium — runs the same motion-glide math instead of hand-copying it.
 * `@poopdeck.gl/layers/src/lib/track-kernel.ts` is a thin re-export of this
 * module, so deck call sites can keep importing it from there.
 *
 * ── THE MODEL ────────────────────────────────────────────────────────────────
 * The AV `objects/` archive carries one POINT feature per tracked object PER
 * KEYFRAME (a snapshot: `track_id`, `category`, `heading`, `length`/`width`/
 * `height`, `speed`, timestamped). A GPU time-WINDOW filter would show N
 * instances per object whenever the window spans N keyframes — the "train of
 * boxes" bug. Instead:
 *   1. {@link buildTrackIndex} pools the snapshots of ALL loaded tiles, groups
 *      them by `track_id`, rebases each keyframe to ABSOLUTE epoch-ms
 *      (`startTime + tile.timeOffset`) so cross-tile keyframes sort into one
 *      timeline, and sorts+de-dups each track. Runs only when the tile SET (or
 *      a feeding style prop) changes.
 *   2. {@link sampleTrack} interpolates ONE pose per ACTIVE track at the
 *      playhead (binary-search + lerp, angle-lerp for heading, plus a CPU
 *      appear/disappear fade). Runs every frame; inactive tracks return null.
 *
 * The renderers own only their instance-buffer bake + sublayer construction;
 * the pooling and interpolation are here.
 */

import type {
  Tile,
  TileId,
  BinaryFeatures,
  STTTileLayer as TileLayer,
} from '../types.js';
import { tileKey } from '../tile-key.js';
import type { RGBA255 } from './style.js';
import type { LonLat } from '../geo/spherical.js';
import {
  destinationPoint,
  greatCircleCourseDeg,
  haversineMeters,
  initialBearingDeg,
  interpolateGreatCircle,
} from '../geo/spherical.js';
import type {
  MotionConfig,
  MotionState,
  ResolvedMotionConfig,
} from './motion.js';
import {
  clampLat,
  fromCompassDeg,
  lerpLonWrapped,
  resolveMotionConfig,
  toCompassDeg,
  toMps,
} from './motion.js';

/**
 * A color as the track kernel accepts it — RGB or RGBA in the 0–255 range, as a
 * (readonly) tuple or a byte array. This is the framework-free, structurally
 * IDENTICAL stand-in for deck's `Color` the kernel used to import: deck's
 * `Record<string, Color>` colorMapping props stay assignable to
 * {@link TrackFieldConfig} with no cast, while core keeps its
 * no-rendering-library invariant. The 4-tuple arm reuses core's own
 * {@link RGBA255} rather than redeclaring it.
 */
export type TrackColor =
  | RGBA255
  | Readonly<[number, number, number]>
  | Readonly<Uint8Array>
  | Readonly<Uint8ClampedArray>;

/** Radians → degrees, for the heading → getOrientation z-rotation. */
export const RAD_TO_DEG = 180 / Math.PI;

/** Meters per degree of latitude (equirectangular small-offset conversion). */
export const METERS_PER_DEG_LAT = 111_320;

/**
 * Hold window (ms) granted to a DEGENERATE track that has only ONE loaded
 * keyframe (which can't be interpolated). Real AV object archives always carry a
 * `track_id` column with multiple keyframes per track, so this only guards
 * malformed/track-less input: such an instance is shown for ±half this around
 * its lone keyframe instead of vanishing at the measure-zero instant it exists.
 */
export const SINGLETON_HOLD_MS = 600;

/** Shared fallback color when a track's category is unmapped / absent. */
export const DEFAULT_TRACK_COLOR: TrackColor = [160, 160, 160, 255];

/**
 * One tracked object's pooled keyframes, in ABSOLUTE epoch-ms and sorted
 * ascending by time. Parallel arrays (one entry per keyframe) keep the pooling
 * allocation-light; per-track constants (color/label) are baked once.
 */
export interface Track {
  trackId: string;
  /** Absolute keyframe times (ms), strictly ascending after de-dup. */
  times: number[];
  lon: number[];
  lat: number[];
  /** Altitude (0 for 2D point archives). */
  alt: number[];
  /** Heading per keyframe (radians); NaN where the column is absent. */
  heading: number[];
  /** Box/model dims per keyframe (meters); NaN where the column is absent. */
  length: number[];
  width: number[];
  height: number[];
  /** Speed per keyframe (m/s); NaN where the column is absent. */
  speed: number[];
  /** Baked RGBA from this track's `category` via colorMapping (alpha pre-fade). */
  color: [number, number, number, number];
  /** The `labelProperty` value (stringified), for the optional TextLayer. */
  label: string;
  /** The `category` (colorProperty) value, for picking + per-category dispatch. */
  category: string;
  /** True when the track has a single loaded keyframe (held, not interpolated). */
  singleton: boolean;
}

/** One interpolated instance at the playhead (the per-frame render unit). */
export interface Sample {
  lon: number;
  lat: number;
  alt: number;
  /** Heading in radians; NaN ⇒ axis-aligned. */
  heading: number;
  length: number;
  width: number;
  height: number;
  speed: number;
  /** Appear/disappear fade factor in [0,1] (folded into the instance alpha). */
  alpha: number;
  track: Track;
  /**
   * True when this pose was PREDICTED past the track's terminal keyframe rather
   * than interpolated between two of them (see {@link MotionConfig}).
   *
   * OPTIONAL, and set only on the motion path — deliberately. The default
   * sampler's returned object literal keeps exactly its historical own-property
   * set, so anything downstream that enumerates a `Sample` (a pick row, a
   * structured-clone into a worker, a snapshot test) sees no new key unless a
   * `motion` config asked for one.
   */
  extrapolated?: boolean;
  /**
   * How far past the terminal keyframe (ms) this pose was predicted — CLAMPED
   * to `maxExtrapolationMs`. It is the age of the POSE, not of the playhead: a
   * singleton whose hold band outlives its prediction window keeps being drawn
   * at the pose the horizon produced, and reports that horizon's age for the
   * whole freeze. So `position === destinationPoint(terminal, course,
   * speed × extrapolationAgeMs/1000)` holds for every predicted sample, which is
   * what a consumer reading this field is actually asking.
   */
  extrapolationAgeMs?: number;
}

/** Flat decoded props attached to `info.object` on a pick (AV inspector shape). */
export interface TrackPickRow {
  track_id: string;
  category: string;
  heading: number;
  length: number;
  width: number;
  height: number;
  speed: number;
  /**
   * Present ONLY when the sampled pose carried {@link Sample.extrapolated} — an
   * inspector reading a predicted position should be able to see that it is a
   * prediction. Absent on every default-path row, which therefore keeps exactly
   * its seven historical keys.
   */
  extrapolated?: boolean;
}

/** Which tile columns to read when pooling snapshots into tracks. */
export interface TrackFieldConfig {
  /** Categorical column grouping snapshots into one track ('' ⇒ each snapshot is its own held instance). */
  trackIdProperty: string;
  /** Categorical column driving per-instance color ('' ⇒ constant colorMappingDefault). */
  colorProperty: string;
  /** Column (categorical or numeric) whose value becomes the optional label. */
  labelProperty: string;
  headingProperty: string;
  lengthProperty: string;
  widthProperty: string;
  heightProperty: string;
  speedProperty: string;
  colorMapping: Record<string, TrackColor> | null | undefined;
  colorMappingDefault: TrackColor;
}

/** Geometric fallbacks + fade ramps applied at interpolation time. */
export interface TrackSampleConfig {
  defaultLength: number;
  defaultWidth: number;
  defaultHeight: number;
  fadeInDuration: number;
  fadeOutDuration: number;
  /**
   * Angular unit of the `heading` column, selecting which shortest-arc lerp the
   * pose heading uses: `'rad'` (default) → {@link lerpAngle}; `'deg'` →
   * {@link lerpAngleDeg}. The box/mesh layers store heading in radians and keep
   * the default; the icon layer stores DEGREES (`IconLayer.getAngle`) and passes
   * `'deg'`.
   * @default 'rad'
   */
  angleUnit?: 'rad' | 'deg';
  /**
   * Largest bracket gap (ms) across which a pose is interpolated. When the two
   * keyframes bracketing the playhead are farther apart than this, the track
   * HOLDS its last sample (`[lo]`) instead of fabricating straight-line motion
   * through a data hole — an integrity guard (a silent entity holds its last
   * position, it does not glide a path it never travelled). `Infinity` (the
   * default) never holds, so the box/mesh behaviour is unchanged.
   * @default Infinity
   */
  maxGapMs?: number;
  /**
   * Opt-in motion model. UNSET is not the same as `{mode: 'linear'}` at the
   * dispatch level (it takes a different code path) but IS the same at the
   * result level: `motion-linear-parity.test.ts` pins the two byte-identical,
   * down to which own properties the returned `Sample` has. Setting any config
   * routes through {@link sampleTrackExtended}.
   * @default undefined — the historical lerp-only sampler
   */
  motion?: MotionConfig;
  /**
   * Hold window (ms) for a single-keyframe track, overriding
   * {@link SINGLETON_HOLD_MS}. Exists because `@poopdeck.gl/three`'s box-tracks
   * fork shipped 400 ms while the kernel shipped 600: de-forking without this
   * knob would silently change how long a lone AV box lingers.
   * @default SINGLETON_HOLD_MS (600)
   */
  singletonHoldMs?: number;
}

/** Outcome of {@link buildTrackIndex}; the caller emits its own telemetry/warns. */
export interface TrackIndexResult {
  /** track-id-keyed pool (synthetic keys for track-less snapshots). */
  tracks: Map<string, Track>;
  /** True when at least one loaded tile carried the speed column. */
  hasSpeedColumn: boolean;
  /** True when at least one loaded tile LACKED the track-id column. */
  trackIdMissing: boolean;
  /** Total snapshots pooled (for telemetry). */
  totalSnapshots: number;
}

/** Linear interpolation. */
export function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

/**
 * Shortest-arc angular interpolation (radians). Interpolating headings as plain
 * numbers would spin the instance the long way around the ±π seam (e.g.
 * 179°→-179°); normalizing the delta into (-π, π] takes the short way. NaN
 * endpoints (absent heading column) degrade to whichever side is finite.
 */
export function lerpAngle(a: number, b: number, f: number): number {
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  const twoPi = Math.PI * 2;
  let d = (b - a) % twoPi;
  if (d > Math.PI) d -= twoPi;
  else if (d < -Math.PI) d += twoPi;
  return a + d * f;
}

/**
 * Shortest-arc angular interpolation in DEGREES — the degrees analogue of
 * {@link lerpAngle}. `IconLayer.getAngle` is measured in DEGREES, so an icon
 * heading column (AIS `cog`, aircraft `heading`) must be interpolated in
 * degrees: interpolating it as a plain number spins the marker the long way
 * around the 360/0 seam (e.g. 350°→10°). Normalizing the delta into (-180, 180]
 * takes the short way. NaN endpoints (absent heading column) degrade to
 * whichever side is finite.
 */
export function lerpAngleDeg(a: number, b: number, f: number): number {
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  return a + d * f;
}

/** Lerp a dimension that may be NaN (absent column) — fall back to a default. */
export function lerpDim(
  a: number,
  b: number,
  f: number,
  fallback: number,
): number {
  const af = Number.isFinite(a);
  const bf = Number.isFinite(b);
  if (af && bf) return lerp(a, b, f);
  if (af) return a;
  if (bf) return b;
  return fallback;
}

/** Resolve one feature's categorical (string) column value, or '' if absent. */
export function readCategorical(
  binary: BinaryFeatures,
  prop: string,
  i: number,
): string {
  const cat = binary.categoricalProps[prop];
  if (cat) {
    const idx = cat.indices[i];
    return idx === 0xffff ? '' : (cat.categories[idx] ?? '');
  }
  const num = binary.numericProps[prop];
  if (num) {
    const v = num[i];
    return Number.isFinite(v) ? String(v) : '';
  }
  return '';
}

/** Category STRING → RGBA via colorMapping (fallback when absent/unmapped). */
export function resolveColor(
  category: string,
  mapping: Record<string, TrackColor> | null | undefined,
  fallback: TrackColor,
): [number, number, number, number] {
  const c = (category && mapping && mapping[category]) || fallback;
  return [c[0], c[1], c[2], c[3] ?? 255];
}

/**
 * Build the flat AV-inspector pick row for one interpolated sample.
 *
 * The seven-key literal is the historical shape and stays the historical shape:
 * `extrapolated` is grafted on afterwards and ONLY when the sample actually
 * carries it, so a row built from a default-path sample is own-property-equal to
 * what this returned before motion modes existed. Assigning `undefined`
 * unconditionally would not do — `{a: undefined}` still has the key `a`, and
 * `Object.keys` (and a `toEqual` against a literal) can tell.
 */
export function makePickRow(s: Sample): TrackPickRow {
  const row: TrackPickRow = {
    track_id: s.track.trackId,
    category: s.track.category,
    heading: s.heading,
    length: s.length,
    width: s.width,
    height: s.height,
    speed: s.speed,
  };
  if (s.extrapolated !== undefined) row.extrapolated = s.extrapolated;
  return row;
}

/**
 * Pool every loaded tile's object snapshots into a `track_id`-keyed map, each
 * track's keyframes rebased to absolute epoch-ms and sorted+de-duped. O(total
 * snapshots); the caller runs it only when the tile set or a feeding prop
 * changes. Emits no telemetry / warnings — it returns the counts + the
 * `trackIdMissing` flag so each renderer can warn with its own layer name.
 */
export function buildTrackIndex(
  tiles: Tile[],
  cfg: TrackFieldConfig,
): TrackIndexResult {
  const trackIdProp = cfg.trackIdProperty || 'track_id';
  const colorProp = cfg.colorProperty;
  const labelProp = cfg.labelProperty || 'category';
  const headingProp = cfg.headingProperty || 'heading';
  const lengthProp = cfg.lengthProperty || 'length';
  const widthProp = cfg.widthProperty || 'width';
  const heightProp = cfg.heightProperty || 'height';
  const speedProp = cfg.speedProperty || 'speed';
  const fallbackColor = cfg.colorMappingDefault ?? DEFAULT_TRACK_COLOR;

  const tracks = new Map<string, Track>();
  let hasSpeed = false;
  let trackIdMissing = false;
  let synthetic = 0;
  let total = 0;

  for (const tile of tiles) {
    for (const tileLayer of tile.layers) {
      const binary = tileLayer.features;
      const count = binary.featureCount;
      if (count === 0) continue;

      const dims = binary.positionDimensions ?? 2;
      const positions = binary.positions;
      const starts = binary.startTimes;
      const offset = binary.timeOffset;
      const trackCol = binary.categoricalProps[trackIdProp];
      const heading = binary.numericProps[headingProp] ?? null;
      const length = binary.numericProps[lengthProp] ?? null;
      const width = binary.numericProps[widthProp] ?? null;
      const height = binary.numericProps[heightProp] ?? null;
      const speed = binary.numericProps[speedProp] ?? null;
      if (speed) hasSpeed = true;
      if (!trackCol) trackIdMissing = true;

      for (let i = 0; i < count; i++) {
        total++;
        // Group key: the track id, or a unique synthetic key (degenerate,
        // un-interpolated) when the column is absent.
        let key: string;
        if (trackCol) {
          const idx = trackCol.indices[i];
          key =
            idx === 0xffff
              ? `∅${synthetic++}`
              : (trackCol.categories[idx] ?? `∅${synthetic++}`);
        } else {
          key = `∅${synthetic++}`;
        }

        let track = tracks.get(key);
        if (!track) {
          const category = colorProp
            ? readCategorical(binary, colorProp, i)
            : '';
          track = {
            trackId: trackCol ? key : '',
            times: [],
            lon: [],
            lat: [],
            alt: [],
            heading: [],
            length: [],
            width: [],
            height: [],
            speed: [],
            color: resolveColor(category, cfg.colorMapping, fallbackColor),
            label: readCategorical(binary, labelProp, i),
            category,
            singleton: false,
          };
          tracks.set(key, track);
        }

        const b = i * dims;
        track.times.push(starts[i] + offset); // → absolute epoch-ms
        track.lon.push(positions[b]);
        track.lat.push(positions[b + 1]);
        track.alt.push(dims > 2 ? positions[b + 2] : 0);
        track.heading.push(heading ? heading[i] : NaN);
        track.length.push(length ? length[i] : NaN);
        track.width.push(width ? width[i] : NaN);
        track.height.push(height ? height[i] : NaN);
        track.speed.push(speed ? speed[i] : NaN);
      }
    }
  }

  // Sort each track's keyframes by absolute time (cross-tile pooling leaves them
  // tile-ordered) and drop exact-duplicate timestamps, folded into a SINGLE
  // permutation applied by one reorder pass per track. Stable sort ⇒ equal
  // timestamps keep insertion order.
  const order: number[] = [];
  for (const track of tracks.values()) {
    const times = track.times;
    const n = times.length;
    if (n > 1) {
      order.length = n;
      for (let k = 0; k < n; k++) order[k] = k;
      order.sort((a, b) => times[a] - times[b]);
      let write = 0;
      for (let k = 0; k < n; k++) {
        const idx = order[k];
        if (k === 0 || times[idx] !== times[order[write - 1]]) {
          order[write++] = idx;
        }
      }
      if (write !== n) order.length = write;
      reorder(track, order);
    }
    track.singleton = track.times.length < 2;
  }

  return {
    tracks,
    hasSpeedColumn: hasSpeed,
    trackIdMissing,
    totalSnapshots: total,
  };
}

/**
 * Interpolate one track's pose at absolute `now`, or null when the track is
 * inactive (the playhead is outside its keyframe span). Singletons are held for
 * ±{@link SINGLETON_HOLD_MS}/2 around their lone keyframe.
 */
export function sampleTrack(
  track: Track,
  now: number,
  cfg: TrackSampleConfig,
): Sample | null {
  // A motion config routes to the extended sampler; EVERYTHING below this line
  // is the historical body, unchanged except that the singleton hold is now
  // configurable. The dispatch is the first statement rather than a branch
  // woven through the body precisely so that "no motion config" cannot pick up
  // a behaviour change by accident.
  if (cfg.motion !== undefined)
    return sampleTrackExtended(track, now, cfg, cfg.motion);

  const { times } = track;
  const n = times.length;
  if (n === 0) return null;

  const first = times[0];
  const last = times[n - 1];
  const pad = track.singleton
    ? (cfg.singletonHoldMs ?? SINGLETON_HOLD_MS) / 2
    : 0;
  if (now < first - pad || now > last + pad) return null;

  const maxGapMs = cfg.maxGapMs ?? Infinity;

  let lo: number;
  let hi: number;
  let frac: number;
  if (n === 1) {
    lo = hi = 0;
    frac = 0;
  } else {
    const c = now < first ? first : now > last ? last : now;
    // Largest lo with times[lo] <= c (times strictly ascending).
    lo = 0;
    hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= c) lo = mid;
      else hi = mid;
    }
    const denom = times[hi] - times[lo];
    frac = denom > 0 ? (c - times[lo]) / denom : 0;
    // Integrity guard: a bracket wider than maxGapMs is a data hole. HOLD the
    // last sample (frac 0 ⇒ every field below pins to [lo]) rather than glide a
    // straight line the object never travelled.
    if (denom > maxGapMs) frac = 0;
  }

  const length = lerpDim(
    track.length[lo],
    track.length[hi],
    frac,
    cfg.defaultLength,
  );
  const width = lerpDim(
    track.width[lo],
    track.width[hi],
    frac,
    cfg.defaultWidth,
  );
  const height = lerpDim(
    track.height[lo],
    track.height[hi],
    frac,
    cfg.defaultHeight,
  );
  const speedLo = track.speed[lo];
  const speedHi = track.speed[hi];
  const speed =
    Number.isFinite(speedLo) || Number.isFinite(speedHi)
      ? lerpDim(speedLo, speedHi, frac, 0)
      : NaN;

  // CPU appear/disappear fade (playhead-time ramp), folded into the instance alpha.
  let alpha = 1;
  const fadeIn = cfg.fadeInDuration;
  const fadeOut = cfg.fadeOutDuration;
  if (fadeIn > 0) {
    const age = now - first;
    if (age < fadeIn) alpha *= Math.max(0, Math.min(1, age / fadeIn));
  }
  if (fadeOut > 0) {
    const remaining = last - now;
    if (remaining < fadeOut)
      alpha *= Math.max(0, Math.min(1, remaining / fadeOut));
  }

  // Heading uses the shortest-arc lerp in the column's own angular unit
  // (radians for box/mesh, degrees for the icon layer via `angleUnit: 'deg'`).
  const headingLerp = cfg.angleUnit === 'deg' ? lerpAngleDeg : lerpAngle;

  return {
    lon: lerp(track.lon[lo], track.lon[hi], frac),
    lat: lerp(track.lat[lo], track.lat[hi], frac),
    alt: lerp(track.alt[lo], track.alt[hi], frac),
    heading: headingLerp(track.heading[lo], track.heading[hi], frac),
    length,
    width,
    height,
    speed,
    alpha,
    track,
  };
}

/* ── Motion modes (the extended sampler) ─────────────────────────────────────
 * Everything below implements `TrackSampleConfig.motion`. It is a SEPARATE
 * function rather than branches inside `sampleTrack` for one reason: the
 * default path must stay provably untouched. `motion-linear-parity.test.ts`
 * asserts that `sampleTrack(t, n, cfg)` and
 * `sampleTrack(t, n, {...cfg, motion: {mode: 'linear'}})` agree on every numeric
 * field under `Object.is`, on null-ness, and on the returned object's own
 * property set — so the two implementations are kept honest by differential
 * test rather than by careful reading.
 *
 * ⚠ TRACK ARRAYS ARE READ-ONLY VIEWS. A `Track`'s parallel arrays may be
 * `Float64Array.subarray` views cast through `as unknown as number[]`, and
 * `heading`/`length`/`width`/`height`/`speed` may be ONE shared all-NaN array
 * ALIASED BY EVERY TRACK IN A TILE (see
 * `packages/maplibre/src/layers/trip-heads-layer.ts`). Code here may only INDEX
 * them. Never push, never assign, and never read `.length` from anything but
 * `times` — a `subarray` view reports the length of its window, and the shared
 * NaN array reports whatever the widest tile needed.
 */

/** Scratch motion state — reused every sample; the motion path allocates nothing. */
const MOTION_STATE: MotionState = {
  speedMps: NaN,
  courseDeg: NaN,
  atIndex: -1,
};
/** Scratch point for `destinationPoint` / `interpolateGreatCircle`. */
const MOTION_POINT: LonLat = { lon: 0, lat: 0 };

/**
 * Read one keyframe's instantaneous motion — speed in m/s, course in compass
 * degrees — preferring the archive's own columns and falling back (when
 * {@link MotionConfig.deriveVelocity} allows) to a finite difference of the
 * ADJACENT keyframe pair.
 *
 * FORWARD ONLY. The pair is `(index, index+1)` when a next keyframe exists and
 * otherwise `(index-1, index)` — so at the terminal keyframe, which is the only
 * place extrapolation happens, the derived velocity is collinear with the last
 * bracket the entity actually travelled. There is no backward-extrapolation
 * direction parameter because there is no consumer for one: AIS, ADS-B and AV
 * archives all predict forward.
 *
 * Returns `speedMps: NaN` when neither route yields a value (no column and no
 * second keyframe — i.e. a singleton with no `speed`). The caller MUST test for
 * that and fall back to the singleton hold: `NaN * dt` is NaN, and a NaN
 * position renders as nothing at all, with no error anywhere.
 *
 * Writes into and returns `out`; allocates nothing.
 */
export function deriveMotionState(
  track: Track,
  index: number,
  cfg: ResolvedMotionConfig,
  out: MotionState,
): MotionState {
  const n = track.times.length;
  out.atIndex = index;
  out.speedMps = NaN;
  out.courseDeg = NaN;
  if (index < 0 || index >= n) return out;

  const rawSpeed = track.speed[index];
  if (Number.isFinite(rawSpeed)) out.speedMps = toMps(rawSpeed, cfg.speedUnit);
  out.courseDeg = toCompassDeg(
    track.heading[index],
    cfg.courseUnit,
    cfg.courseConvention,
  );
  if (!cfg.deriveVelocity) return out;
  if (Number.isFinite(out.speedMps) && Number.isFinite(out.courseDeg))
    return out;

  const forward = index + 1 < n;
  const a = forward ? index : index - 1;
  const b = a + 1;
  if (a < 0 || b >= n) return out; // a singleton has no pair to difference
  const dtMs = track.times[b] - track.times[a];
  if (!(dtMs > 0)) return out; // de-dup guarantees this, but NaN must not divide

  if (!Number.isFinite(out.speedMps)) {
    out.speedMps =
      haversineMeters(track.lon[a], track.lat[a], track.lon[b], track.lat[b]) /
      (dtMs / 1000);
  }
  if (!Number.isFinite(out.courseDeg)) {
    // The wanted course is the one AT `index`, and a great circle's course
    // TURNS along the arc — the bearing leaving `a` is not the bearing arriving
    // at `b`. When the pair ends at `index` (the extrapolation case) that means
    // the arc's FINAL bearing, i.e. the reverse arc's initial bearing turned
    // 180°. Using the initial bearing there instead sends the prediction off
    // the great circle the entity was actually travelling — by 0.16° over a
    // 40 km leg at mid-latitude, growing with leg length.
    out.courseDeg = forward
      ? initialBearingDeg(
          track.lon[a],
          track.lat[a],
          track.lon[b],
          track.lat[b],
        )
      : (initialBearingDeg(
          track.lon[b],
          track.lat[b],
          track.lon[a],
          track.lat[a],
        ) +
          180) %
        360;
  }
  return out;
}

/**
 * {@link sampleTrack} with a {@link MotionConfig} in play.
 *
 * Structurally a copy of the default sampler — same cull test, same bracket
 * search, same dimension/speed/fade arithmetic — with two dispatch points
 * grafted on:
 *
 *   INTERIOR  `'great-circle'` slerps the bracket instead of lerping lon/lat,
 *             and (only when the heading column is absent) reads the course off
 *             the arc. `'velocity'` interpolates exactly as `'linear'` does,
 *             differing only in that its `wrapLongitude` default is true.
 *   EXTERIOR  past the terminal keyframe, `'velocity'` and `'great-circle'`
 *             continue on the entity's own speed + course via
 *             `destinationPoint` for up to `maxExtrapolationMs`. `'linear'`
 *             never does, whatever the config says — it is defined as the
 *             shipped behaviour.
 *
 * The singleton hold and the extrapolation window are the SAME axis (both are
 * "how far past `last` may a pose exist"), so the high cull bound is their max:
 * a singleton that carries speed + course columns flies on, and one that does
 * not still gets its ±`singletonHoldMs`/2 of visibility. When the hold is the
 * longer of the two, the pose flies to the horizon and then FREEZES there for
 * the remainder of the hold — it never reverts to the raw keyframe.
 *
 * `alpha`'s fade-out ramp is measured against whichever of those two bounds the
 * pose will actually cull at, so it is one monotone descent across the
 * interior → predicted boundary rather than one ramp per side. See the fade
 * block at the bottom of this function for the full argument.
 */
function sampleTrackExtended(
  track: Track,
  now: number,
  cfg: TrackSampleConfig,
  motion: MotionConfig,
): Sample | null {
  const m = resolveMotionConfig(motion, cfg.angleUnit);
  const { times } = track;
  const n = times.length;
  if (n === 0) return null;

  const first = times[0];
  const last = times[n - 1];
  const pad = track.singleton
    ? (cfg.singletonHoldMs ?? SINGLETON_HOLD_MS) / 2
    : 0;
  const extrapMs =
    m.mode === 'linear' || !(m.maxExtrapolationMs > 0)
      ? 0
      : m.maxExtrapolationMs;
  const highPad = pad > extrapMs ? pad : extrapMs;
  if (now < first - pad || now > last + highPad) return null;

  const maxGapMs = cfg.maxGapMs ?? Infinity;

  let lo: number;
  let hi: number;
  let frac: number;
  if (n === 1) {
    lo = hi = 0;
    frac = 0;
  } else {
    const c = now < first ? first : now > last ? last : now;
    lo = 0;
    hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= c) lo = mid;
      else hi = mid;
    }
    const denom = times[hi] - times[lo];
    frac = denom > 0 ? (c - times[lo]) / denom : 0;
    if (denom > maxGapMs) frac = 0;
  }

  const length = lerpDim(
    track.length[lo],
    track.length[hi],
    frac,
    cfg.defaultLength,
  );
  const width = lerpDim(
    track.width[lo],
    track.width[hi],
    frac,
    cfg.defaultWidth,
  );
  const height = lerpDim(
    track.height[lo],
    track.height[hi],
    frac,
    cfg.defaultHeight,
  );
  const speedLo = track.speed[lo];
  const speedHi = track.speed[hi];
  const speed =
    Number.isFinite(speedLo) || Number.isFinite(speedHi)
      ? lerpDim(speedLo, speedHi, frac, 0)
      : NaN;

  const headingLerp = cfg.angleUnit === 'deg' ? lerpAngleDeg : lerpAngle;

  let lon = NaN;
  let lat = NaN;
  let alt = NaN;
  let heading = NaN;
  let extrapolated = false;
  let ageMs = 0;

  // ── EXTERIOR: predict past the terminal keyframe ──────────────────────────
  // Entered for the WHOLE admitted band past `last` (`highPad`), not only for
  // its first `extrapMs`. The prediction itself still stops at the horizon —
  // `ageMs` is clamped — so once the window closes the pose FREEZES where the
  // prediction left it for whatever is left of the singleton hold.
  //
  // WHY the clamp instead of the narrower gate it replaces: `pad` and `extrapMs`
  // are independent knobs, so `extrapMs < pad` is a perfectly ordinary config
  // (a 60 s hold with a 10 s prediction window). Under the narrow gate the band
  // `(last + extrapMs, last + pad]` fell through to the INTERIOR branch, where a
  // singleton has `lo === hi === 0` and `frac === 0` — i.e. the entity flew
  // forward for `extrapMs` and then teleported BACKWARDS to the keyframe it had
  // just left, and sat there for the rest of the hold. Culling early instead
  // would be worse still: carrying speed columns would then SHORTEN a
  // singleton's visibility relative to one that carries none, inverting the
  // docblock's promise above.
  //
  // Non-singletons are unaffected: `pad` is 0 for them, so `highPad === extrapMs`
  // and the cull at :774 has already returned null wherever the clamp would bite.
  if (now > last && extrapMs > 0) {
    const i = n - 1;
    const st = deriveMotionState(track, i, m, MOTION_STATE);
    if (Number.isFinite(st.speedMps) && Number.isFinite(st.courseDeg)) {
      const dt = now - last;
      ageMs = dt > extrapMs ? extrapMs : dt;
      const p = destinationPoint(
        track.lon[i],
        track.lat[i],
        st.courseDeg,
        st.speedMps * (ageMs / 1000),
        MOTION_POINT,
      );
      lon = p.lon;
      lat = clampLat(p.lat);
      alt = track.alt[i];
      // A real heading column wins: writing the derived course back would
      // renormalize a perfectly good archive value into [0, 360).
      const rawHeading = track.heading[i];
      heading = Number.isFinite(rawHeading)
        ? rawHeading
        : fromCompassDeg(st.courseDeg, m.courseUnit, m.courseConvention);
      extrapolated = true;
    }
  }

  // The cull test above admits the WHOLE `max(hold, extrapolation)` band,
  // because whether a prediction is possible is only known after the columns
  // have been read. If it turned out not to be — no speed column and no pair to
  // difference, or `deriveVelocity: false` — the extrapolation band was never
  // earned, and the track culls at its hold band exactly as `'linear'` would.
  // Without this the entity would freeze at its last keyframe for the full
  // `maxExtrapolationMs` instead of disappearing.
  if (!extrapolated && now > last + pad) return null;

  // ── INTERIOR (and the singleton hold) ─────────────────────────────────────
  if (!extrapolated) {
    alt = lerp(track.alt[lo], track.alt[hi], frac);
    if (m.mode === 'great-circle') {
      const p = interpolateGreatCircle(
        track.lon[lo],
        track.lat[lo],
        track.lon[hi],
        track.lat[hi],
        frac,
        MOTION_POINT,
      );
      lon = p.lon;
      lat = clampLat(p.lat);
      const h = headingLerp(track.heading[lo], track.heading[hi], frac);
      heading =
        Number.isFinite(h) || lo === hi
          ? h
          : fromCompassDeg(
              greatCircleCourseDeg(
                track.lon[lo],
                track.lat[lo],
                track.lon[hi],
                track.lat[hi],
                frac,
              ),
              m.courseUnit,
              m.courseConvention,
            );
    } else {
      lon = m.wrapLongitude
        ? lerpLonWrapped(track.lon[lo], track.lon[hi], frac)
        : lerp(track.lon[lo], track.lon[hi], frac);
      lat = lerp(track.lat[lo], track.lat[hi], frac);
      heading = headingLerp(track.heading[lo], track.heading[hi], frac);
    }
  }

  // CPU appear/disappear fade (playhead-time ramp), folded into the instance alpha.
  let alpha = 1;
  const fadeIn = cfg.fadeInDuration;
  const fadeOut = cfg.fadeOutDuration;
  if (fadeIn > 0) {
    const age = now - first;
    if (age < fadeIn) alpha *= Math.max(0, Math.min(1, age / fadeIn));
  }
  if (fadeOut > 0) {
    // The fade-out ramp is measured against the instant this pose STOPS BEING
    // DRAWN — one reference for the whole tail, interior and predicted alike.
    //
    // The two obvious per-side references are both wrong, and it is worth
    // writing down why, because each looks right from one side of the boundary:
    //
    //   • `last` everywhere. `remaining` is negative for every predicted pose,
    //     so alpha is 0 and the entire extrapolation window is invisible on any
    //     layer that fades out (every one of them does: 200–500 ms defaults).
    //     The failure reads as "extrapolation does nothing".
    //   • `last` inside, `last + extrapMs` outside. That is DISCONTINUOUS at
    //     `now === last`: the interior ramp has already driven alpha to 0 there,
    //     and the first predicted millisecond jumps back up to
    //     min(1, extrapMs/fadeOut). The entity fades out, pops back to full
    //     opacity and fades a second time — a ramp is not a ramp if it restarts.
    //
    // So the horizon is chosen ONCE, from where the pose will actually cull, and
    // alpha becomes a single monotone descent that reaches 0 exactly there.
    // `highPad` (not `extrapMs`) is the bound because a frozen singleton stays
    // on screen for the rest of its hold — see the exterior branch above.
    //
    // EARNED-NESS is part of "will actually cull". The prediction window is only
    // real if the terminal keyframe yields a finite speed AND course; when it
    // does not (`deriveVelocity: false`, or a singleton with no speed column)
    // the guard at :884 culls the track at `last + pad` exactly as `'linear'`
    // would, and a ramp aimed at a horizon the pose never reaches would pop it
    // out of existence at full opacity. Interior samples therefore have to ask
    // the same question the exterior branch asked — but only inside the ramp's
    // own window, so the extra `deriveMotionState` never runs on the bulk of a
    // track (and allocates nothing when it does).
    //
    // `'linear'` forces `extrapMs` to 0 (:769), so `flyOn` is false, the horizon
    // is `last`, and the expression is byte-identical to the shipped
    // `last - now`. The singleton hold's own ramp is likewise untouched: it has
    // always been measured against `last`, drawing the far half of the hold at
    // alpha 0, and `motion-linear-parity.test.ts` pins that.
    let flyOn = extrapolated;
    if (!flyOn && extrapMs > 0 && now > last - fadeOut) {
      const st = deriveMotionState(track, n - 1, m, MOTION_STATE);
      flyOn = Number.isFinite(st.speedMps) && Number.isFinite(st.courseDeg);
    }
    const remaining = (flyOn ? last + highPad : last) - now;
    if (remaining < fadeOut)
      alpha *= Math.max(0, Math.min(1, remaining / fadeOut));
  }

  // Same key order as the default sampler's literal — `Object.keys` equality is
  // half of the parity contract, and key order is observable.
  const sample: Sample = {
    lon,
    lat,
    alt,
    heading,
    length,
    width,
    height,
    speed,
    alpha,
    track,
  };
  if (extrapolated) {
    sample.extrapolated = true;
    sample.extrapolationAgeMs = ageMs;
  }
  return sample;
}

/* ── Motion vocabulary re-exports ────────────────────────────────────────────
 * The motion types are re-exported from the kernel so a call site that already
 * imports `sampleTrack` does not need a second import path to spell the config
 * it passes. `render/motion.ts` remains the definition site.
 */
export {
  MOTION_MODES,
  resolveMotionConfig,
  toMps,
  toCompassDeg,
  fromCompassDeg,
} from './motion.js';
export type {
  MotionMode,
  MotionConfig,
  ResolvedMotionConfig,
  MotionState,
  CourseConvention,
  SpeedUnit,
} from './motion.js';

/**
 * Permute every parallel array of a track by `order` (index-sort). The output
 * is allocated at `order.length`, NOT `src.length`: when de-dup dropped
 * exact-duplicate timestamps `order.length < src.length`, and sizing the output
 * to `src.length` would leave trailing `undefined` HOLES — which then poison
 * {@link sampleTrack} (`times[n-1]` becomes `undefined` ⇒ the high-side cull
 * `now > NaN` never fires so the track never culls, and the final bracket lerps
 * against `undefined` ⇒ NaN poses). Sizing to `order.length` keeps every array
 * dense and its last entry the real last kept keyframe.
 */
function reorder(track: Track, order: number[]): void {
  const keys: (keyof Track)[] = [
    'times',
    'lon',
    'lat',
    'alt',
    'heading',
    'length',
    'width',
    'height',
    'speed',
  ];
  for (const k of keys) {
    const src = track[k] as number[];
    const out = new Array(order.length);
    for (let i = 0; i < order.length; i++) out[i] = src[order[i]];
    (track as any)[k] = out;
  }
}

/* ── Incremental track-index maintenance ────────────────────────────────────
 * {@link buildTrackIndex} is O(all resident snapshots): it re-pools EVERY loaded
 * tile's features, then sorts + reorders EVERY track, on any tile-set change.
 * During playback the loader window slides — tiles load/evict — so the tile
 * ARRAY identity changes constantly, and a glide layer that keys its rebuild on
 * that identity pays the full O(all snapshots) cost in one synchronous render
 * frame each time the window churns: the frame-time spike.
 *
 * {@link TrackIndexMaintainer} replaces that with an INCREMENTAL rebuild keyed
 * by the stable per-(tile, layer) key (mirroring the consolidated-slab absorb
 * pattern in animated-point-layer.ts): it remembers each absorbed tile's pooled
 * contribution grouped by track, and on sync only ADDED tiles are pooled +
 * appended and only REMOVED tiles are dropped — then just the AFFECTED tracks
 * are re-sorted. The result is byte-for-byte identical to a fresh
 * {@link buildTrackIndex} over the same tile set (same track ids, same
 * sorted+deduped parallel arrays, same singleton flags, same baked color/label/
 * category), because a dirty track is reassembled in the SAME tile-array order
 * as a full rebuild and run through the SAME sort/dedup/{@link reorder} pass.
 *
 * The ONE intentional divergence is the synthetic key handed to a track-less /
 * NULL-id snapshot: {@link buildTrackIndex} uses a build-global counter (`∅0`,
 * `∅1`, …) whose value depends on how many such snapshots preceded it across the
 * whole tile set; the maintainer uses a tile-stable `∅<tile-layer key>#n` so a
 * tile can be added/removed without renumbering its neighbours. Each such key is
 * a unique held singleton either way (one keyframe, `singleton: true`, rendered
 * at its lone position), so the emitted geometry is unaffected — only the opaque
 * map key string differs. For the glide path (which requires a resolvable
 * idProperty) this affects only genuinely NULL-id rows.
 */

/** Column config resolved to concrete names (the defaulting buildTrackIndex applies). */
interface ResolvedTrackFields {
  trackIdProp: string;
  colorProp: string;
  labelProp: string;
  headingProp: string;
  lengthProp: string;
  widthProp: string;
  heightProp: string;
  speedProp: string;
  colorMapping: Record<string, TrackColor> | null | undefined;
  fallbackColor: TrackColor;
}

function resolveTrackFields(cfg: TrackFieldConfig): ResolvedTrackFields {
  return {
    trackIdProp: cfg.trackIdProperty || 'track_id',
    colorProp: cfg.colorProperty,
    labelProp: cfg.labelProperty || 'category',
    headingProp: cfg.headingProperty || 'heading',
    lengthProp: cfg.lengthProperty || 'length',
    widthProp: cfg.widthProperty || 'width',
    heightProp: cfg.heightProperty || 'height',
    speedProp: cfg.speedProperty || 'speed',
    colorMapping: cfg.colorMapping,
    fallbackColor: cfg.colorMappingDefault ?? DEFAULT_TRACK_COLOR,
  };
}

/**
 * The registry key of one (tile, layer): the tile's canonical {@link tileKey}
 * then `:` then the layer name.
 *
 * ONE PRODUCER, ONE SPELLING. Every per-tile registry a renderer keeps — this
 * maintainer's absorb/evict set, each deck layer's prepared-tile and sublayer
 * caches — keys on this string, and absorb, lookup and prune run from different
 * call sites. They align only while all of them spell the key byte-identically,
 * so a key is produced here or nowhere: a second definition drifts, and a prune
 * walk whose live set is spelled differently from the entries it walks evicts
 * every one of them, every frame.
 *
 * The tile half folds in the temporal-LOD tier, because {@link tileKey} does.
 * Spelling it `z/x/y/t` instead gives a scrub-preview tile and the base tile it
 * shares that address with ONE slot: whichever lands second wins, and the other
 * is served a payload covering a different span of time.
 *
 * In-memory only. {@link tileKey}'s spelling is a persistence contract with the
 * OPFS tile cache; this composite reaches no cache that outlives the page.
 */
export function tileLayerKey(id: TileId, layerName: string): string {
  return `${tileKey(id)}:${layerName}`;
}

/**
 * One track's keyframes pooled from ONE (tile, layer), in feature order. The
 * entity-level fields (color/label/category/trackId) are baked from the track's
 * FIRST feature in this tile — exactly what buildTrackIndex bakes when it first
 * creates the track from that same feature.
 */
interface TileTrackGroup {
  times: number[];
  lon: number[];
  lat: number[];
  alt: number[];
  heading: number[];
  length: number[];
  width: number[];
  height: number[];
  speed: number[];
  color: [number, number, number, number];
  label: string;
  category: string;
  trackId: string;
}

/** Pooled contribution of one whole (tile, layer): per-track groups + flags. */
interface TilePool {
  groups: Map<string, TileTrackGroup>;
  hasSpeed: boolean;
  trackIdMissing: boolean;
  total: number;
}

/** One maintained track: its per-source-tile groups + whether it needs rebuild. */
interface MaintainedTrack {
  /** Keyframe groups keyed by source tile key — a tile can be dropped in O(1). */
  byTile: Map<string, TileTrackGroup>;
  /** Set when a group was added/removed since the last assemble. */
  dirty: boolean;
}

/**
 * Pool ONE (tile, layer)'s snapshots into per-track groups — the inner loop of
 * {@link buildTrackIndex}, scoped to a single tile and returning the keyframes
 * GROUPED by track (feature order preserved) rather than appended to a global
 * pool. Track-less / NULL-id snapshots get a tile-stable synthetic key (see the
 * section header).
 */
function poolTileLayer(
  tileLayer: TileLayer,
  sourceKey: string,
  R: ResolvedTrackFields,
): TilePool {
  const binary = tileLayer.features;
  const count = binary.featureCount;
  const groups = new Map<string, TileTrackGroup>();
  const dims = binary.positionDimensions ?? 2;
  const positions = binary.positions;
  const starts = binary.startTimes;
  const offset = binary.timeOffset;
  const trackCol = binary.categoricalProps[R.trackIdProp];
  const heading = binary.numericProps[R.headingProp] ?? null;
  const length = binary.numericProps[R.lengthProp] ?? null;
  const width = binary.numericProps[R.widthProp] ?? null;
  const height = binary.numericProps[R.heightProp] ?? null;
  const speed = binary.numericProps[R.speedProp] ?? null;

  let synthetic = 0;
  for (let i = 0; i < count; i++) {
    // Group key: the track id, or a tile-stable synthetic key (degenerate,
    // un-interpolated) when the column is absent / the value is NULL.
    let key: string;
    if (trackCol) {
      const idx = trackCol.indices[i];
      key =
        idx === 0xffff
          ? `∅${sourceKey}#${synthetic++}`
          : (trackCol.categories[idx] ?? `∅${sourceKey}#${synthetic++}`);
    } else {
      key = `∅${sourceKey}#${synthetic++}`;
    }

    let g = groups.get(key);
    if (!g) {
      const category = R.colorProp
        ? readCategorical(binary, R.colorProp, i)
        : '';
      g = {
        times: [],
        lon: [],
        lat: [],
        alt: [],
        heading: [],
        length: [],
        width: [],
        height: [],
        speed: [],
        color: resolveColor(category, R.colorMapping, R.fallbackColor),
        label: readCategorical(binary, R.labelProp, i),
        category,
        trackId: trackCol ? key : '',
      };
      groups.set(key, g);
    }

    const b = i * dims;
    g.times.push(starts[i] + offset); // → absolute epoch-ms
    g.lon.push(positions[b]);
    g.lat.push(positions[b + 1]);
    g.alt.push(dims > 2 ? positions[b + 2] : 0);
    g.heading.push(heading ? heading[i] : NaN);
    g.length.push(length ? length[i] : NaN);
    g.width.push(width ? width[i] : NaN);
    g.height.push(height ? height[i] : NaN);
    g.speed.push(speed ? speed[i] : NaN);
  }

  return {
    groups,
    hasSpeed: !!speed,
    trackIdMissing: !trackCol,
    total: count,
  };
}

/** Append every element of `src` onto `dst` (avoids spread stack limits). */
function appendAll(dst: number[], src: number[]): void {
  for (let i = 0; i < src.length; i++) dst.push(src[i]);
}

/**
 * Assemble a track's per-tile groups (already in tile-array order) into one
 * {@link Track}, then run buildTrackIndex's exact sort + de-dup + {@link reorder}
 * pass. Entity-level fields come from the FIRST group (first tile in array
 * order) — mirroring buildTrackIndex baking them from the track's first-seen
 * feature. Returns whether a sort actually ran (n > 1), for instrumentation.
 */
function assembleTrack(groups: TileTrackGroup[]): {
  track: Track;
  sorted: boolean;
} {
  const head = groups[0];
  const track: Track = {
    trackId: head.trackId,
    times: [],
    lon: [],
    lat: [],
    alt: [],
    heading: [],
    length: [],
    width: [],
    height: [],
    speed: [],
    color: head.color,
    label: head.label,
    category: head.category,
    singleton: false,
  };
  for (const g of groups) {
    appendAll(track.times, g.times);
    appendAll(track.lon, g.lon);
    appendAll(track.lat, g.lat);
    appendAll(track.alt, g.alt);
    appendAll(track.heading, g.heading);
    appendAll(track.length, g.length);
    appendAll(track.width, g.width);
    appendAll(track.height, g.height);
    appendAll(track.speed, g.speed);
  }

  let sorted = false;
  const times = track.times;
  const n = times.length;
  if (n > 1) {
    const order: number[] = new Array(n);
    for (let k = 0; k < n; k++) order[k] = k;
    order.sort((a, b) => times[a] - times[b]);
    let write = 0;
    for (let k = 0; k < n; k++) {
      const idx = order[k];
      if (k === 0 || times[idx] !== times[order[write - 1]]) {
        order[write++] = idx;
      }
    }
    if (write !== n) order.length = write;
    reorder(track, order);
    sorted = true;
  }
  track.singleton = track.times.length < 2;
  return { track, sorted };
}

/**
 * A dirty track's per-tile groups in current tile-ARRAY order — the sequence a
 * walk of the whole resident key list would produce, obtained instead by
 * sorting the track's OWN groups (one per tile-layer holding it: typically one
 * or two, rarely dozens) by each key's rank in that list. A group whose key
 * has no rank is not resident this sync and is dropped, as the walk dropped it.
 *
 * Insertion sort, on purpose: groups arrive in absorb order, which IS array
 * order on a cold sync and nearly so afterwards, so the common case is one
 * pass with no shifts and no comparator closure allocated per track.
 *
 * Exported for the hot-spot audit benchmark; not part of the public surface.
 * @internal
 */
export function orderGroups<G>(
  byTile: ReadonlyMap<string, G>,
  rank: ReadonlyMap<string, number>,
): G[] {
  const groups: G[] = [];
  const ranks: number[] = [];
  for (const [key, g] of byTile) {
    const r = rank.get(key);
    if (r === undefined) continue;
    let i = groups.length;
    while (i > 0 && ranks[i - 1] > r) {
      groups[i] = groups[i - 1];
      ranks[i] = ranks[i - 1];
      i--;
    }
    groups[i] = g;
    ranks[i] = r;
  }
  return groups;
}

/**
 * Incremental analogue of {@link buildTrackIndex}: a per-layer-instance object
 * that maintains the id-keyed track index across tile churn, re-pooling only
 * ADDED tiles and re-sorting only AFFECTED tracks. See the section header for
 * the byte-for-byte-equivalence contract. Used by the point + icon glide render
 * paths, and by the box + mesh layers. {@link buildTrackIndex} remains the
 * one-shot form — correct, but O(all resident snapshots) per call, so it is
 * for cold builds and tests rather than a render path that sees tile churn.
 */
export class TrackIndexMaintainer {
  /** Live tracks keyed by track id / synthetic key. */
  private tracks = new Map<string, MaintainedTrack>();
  /** Absorbed (tile, layer) pools keyed by tile key — the eviction source. */
  private absorbed = new Map<string, TilePool>();
  /** Reference-stable id→Track map returned each sync (the render index). */
  private builtMap = new Map<string, Track>();

  /**
   * Track ids re-sorted during the most recent {@link sync} (a track was
   * rebuilt AND had > 1 keyframe). Instrumentation for the incrementality test;
   * reset at the start of every sync.
   */
  readonly resortedTrackIds: string[] = [];

  /**
   * (dirty track, tile-layer) slots examined while ordering groups in the
   * most recent {@link sync}: Σ over rebuilt tracks of the tile-layers holding
   * each. Instrumentation for the complexity test — the resident-key walk this
   * replaced examined dirty × resident instead. Reset at the start of every
   * sync.
   */
  private lookups = 0;
  get orderingLookups(): number {
    return this.lookups;
  }

  /** Drop all state — call when a feeding style prop changed (full rebuild). */
  reset(): void {
    this.tracks.clear();
    this.absorbed.clear();
    this.builtMap.clear();
    this.resortedTrackIds.length = 0;
    this.lookups = 0;
  }

  /**
   * Diff `tiles` against the absorbed set: pool + append ADDED (tile, layer)s,
   * drop REMOVED ones, then re-sort only the tracks those touched. Returns the
   * same {@link TrackIndexResult} shape as {@link buildTrackIndex}, byte-for-byte
   * equal to a fresh full build over the same tiles (modulo synthetic key
   * strings — see the header).
   */
  sync(tiles: Tile[], cfg: TrackFieldConfig): TrackIndexResult {
    const R = resolveTrackFields(cfg);
    this.resortedTrackIds.length = 0;
    this.lookups = 0;

    // 1. Walk the current tile set in ARRAY ORDER: rank every resident
    //    (tile, layer) key by its position and absorb any not seen before.
    //    Empty layers contribute nothing (buildTrackIndex `continue`s on
    //    count === 0), so skip them.
    const rank = new Map<string, number>();
    for (const tile of tiles) {
      for (const tileLayer of tile.layers) {
        if (tileLayer.features.featureCount === 0) continue;
        const key = tileLayerKey(tile.id, tileLayer.name);
        if (rank.has(key)) continue; // guard a duplicated key in one array
        rank.set(key, rank.size);
        if (this.absorbed.has(key)) continue;

        const pool = poolTileLayer(tileLayer, key, R);
        this.absorbed.set(key, pool);
        for (const [trackKey, group] of pool.groups) {
          let mt = this.tracks.get(trackKey);
          if (!mt) {
            mt = { byTile: new Map(), dirty: true };
            this.tracks.set(trackKey, mt);
          }
          mt.byTile.set(key, group);
          mt.dirty = true;
        }
      }
    }

    // 2. Evict absorbed (tile, layer)s no longer present: drop their group from
    //    every track they fed and mark those tracks dirty.
    for (const [key, pool] of this.absorbed) {
      if (rank.has(key)) continue;
      for (const trackKey of pool.groups.keys()) {
        const mt = this.tracks.get(trackKey);
        if (mt) {
          mt.byTile.delete(key);
          mt.dirty = true;
        }
      }
      this.absorbed.delete(key);
    }

    // 3. Rebuild dirty tracks (dropping any left empty). Reassemble in current
    //    tile-array order → identical pre-sort ordering to a full build. Each
    //    dirty track orders its OWN groups by rank ({@link orderGroups}) rather
    //    than probing `byTile` for every resident key: that walk was O(dirty ×
    //    resident tile-layers) — 313 ms of a 1.1 s cold sync at 854 tile-layers
    //    × 30k tracks — for tracks that live in one or two of them.
    for (const [trackKey, mt] of this.tracks) {
      if (mt.byTile.size === 0) {
        this.tracks.delete(trackKey);
        this.builtMap.delete(trackKey);
        continue;
      }
      if (!mt.dirty) continue;
      this.lookups += mt.byTile.size;
      const { track, sorted } = assembleTrack(orderGroups(mt.byTile, rank));
      this.builtMap.set(trackKey, track);
      mt.dirty = false;
      if (sorted) this.resortedTrackIds.push(trackKey);
    }

    // 4. Aggregate the flags/counts over the CURRENTLY absorbed pools (cheap —
    //    O(tiles), not O(snapshots)).
    let hasSpeedColumn = false;
    let trackIdMissing = false;
    let totalSnapshots = 0;
    for (const pool of this.absorbed.values()) {
      if (pool.hasSpeed) hasSpeedColumn = true;
      if (pool.trackIdMissing) trackIdMissing = true;
      totalSnapshots += pool.total;
    }

    return {
      tracks: this.builtMap,
      hasSpeedColumn,
      trackIdMissing,
      totalSnapshots,
    };
  }
}

// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free) keyframe-texture assembly for GPU motion-glide. The Three
 * analogue of deck's CPU glide path — but where deck re-interpolates one pose
 * per active entity every frame on the CPU
 * (`AnimatedPointLayer.renderInterpolated`), this module bakes each entity's
 * motion ONCE into a keyframe texture so the GPU does the per-frame
 * interpolation from a single `currentTime` uniform, with zero per-frame CPU
 * attribute writes.
 *
 * ── THE MODEL ────────────────────────────────────────────────────────────────
 * A point/icon archive carries one row per entity PER SAMPLE. Grouping by an
 * `idProperty` yields one {@link Track} per entity (the shared framework-free
 * {@link import('@poopdeck.gl/core').TrackIndexMaintainer} does this pooling
 * incrementally across tile churn — the SAME engine behind the deck glide and
 * the AV box/mesh layers). This module takes those pooled tracks and, per track:
 *
 *   1. FIXED-RATE RESAMPLES the piecewise-linear motion onto a uniform time grid
 *      (`resampleTrack`) so the shader lookup is O(1): frame = (t − t0)·invDt,
 *      no per-vertex binary search. `maxInterpolationGap` is honoured — a bracket
 *      wider than the cap HOLDS the last sample instead of gliding a straight line
 *      the entity never travelled (integrity, mirroring the kernel's `sampleTrack`).
 *   2. Writes each track's resampled positions into one ROW of an RGBA-float
 *      DATA TEXTURE (RGB = RTC-local world position, A = heading in radians for
 *      the icon path). The vertex stage samples two bracketing columns and
 *      `mix()`es by the fractional frame (see `../tsl/motion-glide.ts`).
 *
 * Per instance we also emit the small scalar attributes the shader needs to
 * locate its row and map time→column (`t0`, `invDt`, `frameMax`, `rowV`), plus
 * the entity-constant colour and its active `[start,end]` span (feeding the
 * shared time-filter visibility gate). ONE instance per entity — never one per
 * sample — so a moving entity GLIDES instead of popping between its samples.
 *
 * The whole module is Three-free and unit-tested (the repo's PURE-core
 * convention); {@link glideSampleCpu} is the scalar mirror of the shader fetch,
 * so the GPU math is validated on the CPU with no GPU reliance.
 */

import {
  lerp,
  lerpAngle,
  lerpAngleDeg,
  SINGLETON_HOLD_MS,
} from '@poopdeck.gl/core';
import type { Track } from '@poopdeck.gl/core';
import type { Projection } from '../projection/local-enu.js';

const DEG2RAD = Math.PI / 180;

/** Options controlling the fixed-rate resample + texture packing. */
export interface KeyframeAssemblyOptions {
  /**
   * Target grid spacing (ms) for the fixed-rate resample. Smaller = more
   * faithful to the source samples (and, for a piecewise-linear track,
   * over-sampling is LOSSLESS — it just re-linearises the same curve at more
   * points) at the cost of wider texture rows. @default 1000
   */
  resampleIntervalMs?: number;
  /**
   * Hard cap on a track's resampled frame count (= texture columns). A track
   * whose span would exceed this is coarsened (its own `dt` widens to fit), so
   * the texture width stays bounded regardless of playback span. @default 512
   */
  maxFrames?: number;
  /**
   * Largest bracket gap (ms) glide interpolates across; a wider gap HOLDS the
   * last sample (mirrors the kernel's `TrackSampleConfig.maxGapMs`).
   * @default Infinity
   */
  maxGapMs?: number;
  /**
   * Resample the track's `heading` into the texture's ALPHA channel (the icon
   * directional-marker path). The angular unit of the source column selects the
   * shortest-arc lerp; the stored value is always RADIANS. @default false
   */
  withHeading?: boolean;
  /**
   * Angular unit of `Track.heading` when {@link withHeading} is on: `'deg'`
   * (deck `STTIconLayer.getAngle`, AIS `cog`, aircraft `heading`) or `'rad'`.
   * @default 'rad'
   */
  angleUnit?: 'rad' | 'deg';
}

/**
 * The baked keyframe field — per-instance scalar attributes + the shared
 * position/heading data texture. All times are RELATIVE to the scene
 * `timeOrigin` (f32-exact), matching the material's `currentTime` uniform.
 */
export interface KeyframeField {
  /** Instance (track) count = texture height. */
  count: number;
  /** RTC origin (absolute projected world). Texture positions are relative to it. */
  origin: [number, number, number];

  // ── per-instance attributes (length `count`) ─────────────────────────────
  /** Entity colour, vec4 0..1 (baked once from the track's `colorMapping`). */
  colors: Float32Array;
  /** Active-span start (relative ms) — feeds the time-filter visibility gate. */
  starts: Float32Array;
  /** Active-span end (relative ms). */
  ends: Float32Array;
  /** Grid origin (relative ms) — the REAL first-sample time (no singleton pad). */
  t0: Float32Array;
  /** 1 / dt (ms⁻¹); 0 for a held singleton. */
  invDt: Float32Array;
  /** frameCount − 1 (the clamp upper bound in frame units). */
  frameMax: Float32Array;
  /** Texture v of this instance's row centre = (row + 0.5) / height. */
  rowV: Float32Array;

  // ── shared keyframe texture ──────────────────────────────────────────────
  /** Texture width (columns) = max resampled frame count across tracks. */
  texWidth: number;
  /** Texture height (rows) = `count`. */
  texHeight: number;
  /** RGBA-float texel data, row-major: RGB = RTC position, A = heading (rad). */
  texData: Float32Array;

  /** Per-instance entity id (for glide picking). */
  trackIds: string[];
  /** RTC-local bbox of every keyframe (frustum/bounds), or null when empty. */
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
}

/** One track resampled onto its own uniform time grid (geographic space). */
export interface ResampledTrack {
  /** Number of grid frames (≥ 1). */
  frameCount: number;
  /** Grid spacing (ms); 0 for a single-keyframe (held) track. */
  dt: number;
  lon: number[];
  lat: number[];
  alt: number[];
  /** Heading per frame in RADIANS (NaN → 0), only meaningful with `withHeading`. */
  heading: number[];
}

/**
 * Fixed-rate resample of ONE track. The grid spans `[first, last]` at a uniform
 * `dt`; each grid time is sampled from the piecewise-linear track (binary-search
 * bracket + `maxGapMs` hold), so linearly interpolating between adjacent grid
 * frames on the GPU reproduces the source motion (exactly, when the grid is at
 * least as dense as the samples). Times are read ABSOLUTE from the track; the
 * caller rebases the emitted `t0` to the scene origin.
 */
export function resampleTrack(
  track: Track,
  opts: KeyframeAssemblyOptions,
): ResampledTrack {
  const times = track.times;
  const n = times.length;
  const interval = Math.max(1, opts.resampleIntervalMs ?? 1000);
  const maxFrames = Math.max(1, Math.floor(opts.maxFrames ?? 512));
  const maxGapMs = opts.maxGapMs ?? Infinity;
  const withHeading = opts.withHeading ?? false;
  // Interpolate heading in the SOURCE angular unit (shortest-arc), THEN convert
  // the result to radians — never mix the two, or the seam handling breaks.
  const angleLerp = opts.angleUnit === 'deg' ? lerpAngleDeg : lerpAngle;
  const headScale = opts.angleUnit === 'deg' ? DEG2RAD : 1;

  /** Raw heading (in the source unit), or NaN when the column is absent. */
  const headRaw = (i: number): number => {
    const h = track.heading[i];
    return Number.isFinite(h) ? h : NaN;
  };
  /** Store a finite (source-unit) heading as radians; NaN → 0. */
  const toRad = (h: number): number => (Number.isFinite(h) ? h * headScale : 0);

  if (n <= 1) {
    // Degenerate / held: a single grid frame at the lone keyframe.
    const h = withHeading && n === 1 ? headRaw(0) : NaN;
    return {
      frameCount: 1,
      dt: 0,
      lon: [n === 1 ? track.lon[0] : 0],
      lat: [n === 1 ? track.lat[0] : 0],
      alt: [n === 1 ? track.alt[0] : 0],
      heading: [toRad(h)],
    };
  }

  const first = times[0];
  const last = times[n - 1];
  const span = last - first;
  if (span <= 0) {
    const h = withHeading ? headRaw(0) : NaN;
    return {
      frameCount: 1,
      dt: 0,
      lon: [track.lon[0]],
      lat: [track.lat[0]],
      alt: [track.alt[0]],
      heading: [toRad(h)],
    };
  }

  // At least `n` frames (never undersample a dense short track below its real
  // sample count), at least the interval-derived count, capped at `maxFrames`.
  const desired = Math.floor(span / interval) + 1;
  const frameCount = Math.min(Math.max(desired, n, 2), maxFrames);
  const dt = span / (frameCount - 1);

  const lon = new Array<number>(frameCount);
  const lat = new Array<number>(frameCount);
  const alt = new Array<number>(frameCount);
  const heading = new Array<number>(frameCount);

  let lo = 0; // monotone cursor: grid times ascend, so bracket only advances
  for (let k = 0; k < frameCount; k++) {
    const gt = k === frameCount - 1 ? last : first + k * dt;
    while (lo < n - 2 && times[lo + 1] <= gt) lo++;
    const hi = lo + 1;
    const denom = times[hi] - times[lo];
    let frac = denom > 0 ? (gt - times[lo]) / denom : 0;
    if (frac < 0) frac = 0;
    else if (frac > 1) frac = 1;
    // Integrity guard: a bracket wider than the cap is a data hole — HOLD the
    // last sample rather than fabricate straight-line motion through it.
    if (denom > maxGapMs) frac = 0;
    lon[k] = lerp(track.lon[lo], track.lon[hi], frac);
    lat[k] = lerp(track.lat[lo], track.lat[hi], frac);
    alt[k] = lerp(track.alt[lo], track.alt[hi], frac);
    if (withHeading) {
      heading[k] = toRad(angleLerp(headRaw(lo), headRaw(hi), frac));
    } else {
      heading[k] = 0;
    }
  }

  return { frameCount, dt, lon, lat, alt, heading };
}

/**
 * Assemble a keyframe field from pooled tracks. Resamples each track, projects
 * its positions to RTC-local world coords, and packs them row-by-row into one
 * RGBA-float data texture — the sole GPU upload the glide path needs. Times are
 * rebased to `timeOrigin` (f32-exact). Pure + deterministic: the same tracks in
 * the same iteration order always yield byte-identical output.
 *
 * @param tracks Pooled entity tracks (e.g. `TrackIndexMaintainer.sync().tracks`
 *   values), keyframes in ABSOLUTE epoch-ms, sorted ascending — the kernel's
 *   contract. Empty tracks are skipped.
 */
export function assembleKeyframes(
  tracks: Iterable<Track>,
  projection: Projection,
  timeOrigin: number,
  opts: KeyframeAssemblyOptions = {},
): KeyframeField {
  const list: Track[] = [];
  for (const t of tracks) if (t.times.length > 0) list.push(t);
  const count = list.length;

  const empty = (): KeyframeField => ({
    count: 0,
    origin: [0, 0, 0],
    colors: new Float32Array(0),
    starts: new Float32Array(0),
    ends: new Float32Array(0),
    t0: new Float32Array(0),
    invDt: new Float32Array(0),
    frameMax: new Float32Array(0),
    rowV: new Float32Array(0),
    texWidth: 1,
    texHeight: 0,
    texData: new Float32Array(0),
    trackIds: [],
    bbox: null,
  });
  if (count === 0) return empty();

  // Resample every track first so the texture width = the widest resampled row.
  const resampled = list.map((t) => resampleTrack(t, opts));
  let texWidth = 1;
  for (const r of resampled)
    if (r.frameCount > texWidth) texWidth = r.frameCount;
  const texHeight = count;

  // RTC origin = first track's first keyframe (absolute projected world), so the
  // large mercator/globe magnitude stays in the f64 CPU transform, not the f32
  // texture. For the ENU/AV frame origin ≈ [0,0,0] → no-op.
  const origin = projection.project(
    resampled[0].lon[0],
    resampled[0].lat[0],
    resampled[0].alt[0],
  );
  const [ox, oy, oz] = origin;

  const colors = new Float32Array(count * 4);
  const starts = new Float32Array(count);
  const ends = new Float32Array(count);
  const t0 = new Float32Array(count);
  const invDt = new Float32Array(count);
  const frameMax = new Float32Array(count);
  const rowV = new Float32Array(count);
  const texData = new Float32Array(texWidth * texHeight * 4);
  const trackIds: string[] = new Array(count);

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let r = 0; r < count; r++) {
    const track = list[r];
    const rs = resampled[r];
    const n = track.times.length;
    const first = track.times[0];
    const last = track.times[n - 1];
    const singleton = rs.frameCount < 2;
    // Singleton hold pad so a lone-keyframe entity is visible for a real window
    // instead of a measure-zero instant (mirrors the kernel's SINGLETON_HOLD_MS).
    const pad = singleton ? SINGLETON_HOLD_MS / 2 : 0;

    starts[r] = first - pad - timeOrigin;
    ends[r] = last + pad - timeOrigin;
    t0[r] = first - timeOrigin;
    invDt[r] = rs.dt > 0 ? 1 / rs.dt : 0;
    frameMax[r] = rs.frameCount - 1;
    rowV[r] = (r + 0.5) / texHeight;
    trackIds[r] = track.trackId;

    const c = track.color;
    colors[r * 4] = c[0] / 255;
    colors[r * 4 + 1] = c[1] / 255;
    colors[r * 4 + 2] = c[2] / 255;
    colors[r * 4 + 3] = (c[3] ?? 255) / 255;

    // Write this track's resampled positions into row `r`; pad the trailing
    // columns with the last real keyframe so the shader's clamped +1 fetch never
    // reads an uninitialised (0,0,0) texel at the row's right edge.
    let px = 0;
    let py = 0;
    let pz = 0;
    let ph = 0;
    for (let cx = 0; cx < texWidth; cx++) {
      if (cx < rs.frameCount) {
        const p = projection.project(rs.lon[cx], rs.lat[cx], rs.alt[cx]);
        px = p[0] - ox;
        py = p[1] - oy;
        pz = p[2] - oz;
        ph = rs.heading[cx];
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (pz < minZ) minZ = pz;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
        if (pz > maxZ) maxZ = pz;
      }
      // else keep the last (px,py,pz,ph) — trailing pad.
      const o = (r * texWidth + cx) * 4;
      texData[o] = px;
      texData[o + 1] = py;
      texData[o + 2] = pz;
      texData[o + 3] = ph;
    }
  }

  return {
    count,
    origin,
    colors,
    starts,
    ends,
    t0,
    invDt,
    frameMax,
    rowV,
    texWidth,
    texHeight,
    texData,
    trackIds,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
}

/**
 * CPU scalar mirror of the vertex-stage glide fetch (`glideSampleNode`): given a
 * baked {@link KeyframeField}, an instance index and a RELATIVE playhead time,
 * reproduce the interpolated `[x, y, z, headingRad]` the GPU would compute —
 * `clamp` the frame position, floor to the bracketing columns, fetch both and
 * `mix()` by the fraction. The test-only truth check that keeps the GPU math
 * honest with no GPU reliance (the repo's CPU-mirror convention).
 */
export function glideSampleCpu(
  field: KeyframeField,
  instance: number,
  relativeTime: number,
): [number, number, number, number] {
  const fMax = field.frameMax[instance];
  let framePos = (relativeTime - field.t0[instance]) * field.invDt[instance];
  if (!Number.isFinite(framePos)) framePos = 0;
  if (framePos < 0) framePos = 0;
  else if (framePos > fMax) framePos = fMax;
  const f = Math.floor(framePos);
  const frac = framePos - f;
  const colA = f;
  const colB = Math.min(f + 1, fMax);
  const row = instance * field.texWidth;
  const a = (row + colA) * 4;
  const b = (row + colB) * 4;
  const d = field.texData;
  return [
    d[a] + (d[b] - d[a]) * frac,
    d[a + 1] + (d[b + 1] - d[a + 1]) * frac,
    d[a + 2] + (d[b + 2] - d[a + 2]) * frac,
    d[a + 3] + (d[b + 3] - d[a + 3]) * frac,
  ];
}

// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Pure (Cesium-free) pose maths behind `STTEgoLayer` — the AV cockpit's
 * ego-vehicle marker.
 *
 * WHAT THIS IS. An ego archive is not a feature collection, it is a single
 * TRACK sampled at a fixed cadence: one Point feature per timestamp carrying
 * the vehicle's own pose (`lon,lat,alt`, a heading column, and — where the
 * producer wrote them — the vehicle's own L×W×H). {@link buildEgoTrack} pools
 * every Point feature across every tile into ONE time-sorted keyframe array,
 * and {@link sampleEgoPose} answers "where is the car right now" with a binary
 * search plus a lerp. That is the entire per-frame cost: O(log N) + a handful
 * of multiplies, independent of how many keyframes the archive holds.
 *
 * WHY IT IS PURE. `lib/points.ts` and `lib/polylines.ts` import only
 * `@poopdeck.gl/core` sub-paths and never `cesium`; that is what makes them
 * unit-testable in plain Node, and this module keeps the rule. Nothing here
 * builds a Matrix4, touches `Transforms`, or knows a `Scene` exists — the
 * layer does that, and only that.
 *
 * THE TWO THINGS THAT ARE EASY TO GET WRONG:
 *
 *  1. HEADING IS AN ANGLE, NOT A NUMBER. Interpolating 350° → 10° linearly
 *     spins the car 340° backwards through south. {@link lerpAngle} takes the
 *     SHORTEST ARC across the ±π seam. Every heading in this module is
 *     normalized ONCE at build time into radians CCW-from-east (the ENU
 *     convention: 0 = due east, +π/2 = due north), which is exactly what
 *     `atan2(north, east)` returns and exactly what `packages/three`'s ego
 *     layer and the AV object inspector already use. Compass headings
 *     (CW-from-north) and degrees are accepted and converted on the way in.
 *
 *  2. A MISSING HEADING COLUMN IS NORMAL. Some producers ship pose without
 *     yaw. The fallback is the direction of travel between the two bracketing
 *     keyframes, computed in a local flat approximation
 *     (`atan2(Δlat, Δlon·cos lat)`) — degrees cancel, so no projection is
 *     needed and the result is already in the ENU convention.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. No trail: the ego is drawn as one marker
 * at the playhead, never as a polyline history (deck's `TripsLayer` fade and
 * three's static trail line are both out of scope here — see the layer header).
 * No projection either: `sampleEgoPose` returns geodetic lon/lat/alt plus a
 * heading, and the LAYER projects, because the ECEF position and the local
 * east-north-up frame have to be built together from the same coordinate or the
 * marker's orientation and its position disagree.
 */

import {
  GeometryType,
  type BinaryFeatures,
  type Tile,
} from '@poopdeck.gl/core';

const TAU = Math.PI * 2;
const DEG2RAD = Math.PI / 180;

/** How the archive's heading column is encoded. */
export type HeadingUnits = 'radians' | 'degrees';

/**
 * Which way the heading column measures.
 * - `'enu'` — CCW from east, i.e. `atan2(north, east)`. The convention used by
 *   `@poopdeck.gl/three`'s ego layer and by the showcase object inspector.
 * - `'compass'` — CW from north (true bearing), the convention of most
 *   navigation feeds. Converted as `enu = π/2 − compass`.
 */
export type HeadingReference = 'enu' | 'compass';

/** One ego pose sample, straight off the archive. */
export interface EgoKeyframe {
  /** Sample time in ms, REBASED to the build's `timeOrigin`. */
  t: number;
  /** Geodetic position. `alt` is 0 when the tile is 2-D. */
  lon: number;
  lat: number;
  alt: number;
  /**
   * Heading in radians CCW-from-east, wrapped to (−π, π].
   * `NaN` when the archive carries no heading column — the sampler then falls
   * back to the direction of travel.
   */
  heading: number;
  /** Picking provenance for this sample. */
  binary: BinaryFeatures;
  featureIndex: number;
}

/** The whole ego track: one time-sorted keyframe array plus the vehicle's box. */
export interface EgoTrack {
  keyframes: EgoKeyframe[];
  /** Absolute time origin (ms) every `keyframe.t` is relative to. */
  timeOrigin: number;
  /** Vehicle dimensions in metres, `[length (fwd), width (lateral), height (up)]`. */
  dimensions: [number, number, number];
}

/** The interpolated pose at one instant. Geodetic — the layer projects it. */
export interface EgoPose {
  lon: number;
  lat: number;
  alt: number;
  /** Radians CCW-from-east, wrapped to (−π, π]. Always finite. */
  heading: number;
  /** The rebased sample time actually used (CLAMPED to the track's span). */
  t: number;
  /** Provenance of the keyframe at or before `t` — what `pick()` reports. */
  binary: BinaryFeatures;
  featureIndex: number;
}

export interface EgoBuildOptions {
  /** Numeric property holding the heading. @default 'heading' */
  headingProperty?: string;
  /** Encoding of that column. @default 'radians' */
  headingUnits?: HeadingUnits;
  /** Zero-direction of that column. @default 'enu' (CCW from east) */
  headingReference?: HeadingReference;
  /** Numeric property holding the vehicle length (metres, forward). @default 'length' */
  lengthProperty?: string;
  /** Numeric property holding the vehicle width (metres, lateral). @default 'width' */
  widthProperty?: string;
  /** Numeric property holding the vehicle height (metres, up). @default 'height' */
  heightProperty?: string;
  /**
   * Fallback box used when the archive carries no dimension columns.
   * @default [4.5, 2, 1.5] — a mid-size sedan, byte-identical to the default in
   * `@poopdeck.gl/three`'s ego layer so a backend toggle shows the same car.
   */
  boxSize?: [number, number, number];
}

/** Sedan-ish. Matches `packages/three/src/layers/ego-layer.ts`. */
export const DEFAULT_EGO_BOX: [number, number, number] = [4.5, 2, 1.5];

/** Wrap an angle in radians to (−π, π]. */
export function wrapAngle(a: number): number {
  if (!Number.isFinite(a)) return a;
  let x = a % TAU;
  if (x > Math.PI) x -= TAU;
  else if (x <= -Math.PI) x += TAU;
  return x;
}

/**
 * SHORTEST-ARC angular interpolation, radians, result wrapped to (−π, π].
 *
 * This is the whole reason ego heading gets its own function: a plain
 * `a + (b − a) · f` on 350° → 10° travels 340° the wrong way and the marker
 * visibly spins. Taking the delta modulo 2π and folding it into (−π, π] first
 * makes the seam invisible. An exact ±π delta (a U-turn) resolves to +π —
 * arbitrary but deterministic, which is what a unit test can hold.
 */
export function lerpAngle(a: number, b: number, f: number): number {
  const d = wrapAngle(b - a);
  return wrapAngle(a + d * f);
}

/** Convert one raw column value into radians CCW-from-east, or `NaN`. */
export function normalizeHeading(
  raw: number,
  units: HeadingUnits = 'radians',
  reference: HeadingReference = 'enu',
): number {
  if (!Number.isFinite(raw)) return NaN;
  const rad = units === 'degrees' ? raw * DEG2RAD : raw;
  return wrapAngle(reference === 'compass' ? Math.PI / 2 - rad : rad);
}

/**
 * Pool every Point feature across `tiles` into one time-sorted ego track.
 *
 * Times are rebased to the FIRST Point layer's `timeOffset` — the same
 * scene-wide origin convention every layer in this package uses. Exact
 * duplicate timestamps (the same pose repeated across a tile seam) are dropped,
 * keeping the first, so the bracket search never sees a zero-length interval
 * it has to special-case.
 *
 * Returns an empty track (`timeOrigin: 0`) when there are no Point features;
 * the layer checks `keyframes.length` BEFORE adopting `timeOrigin`, so an empty
 * rebuild leaves the previous origin untouched.
 */
export function buildEgoTrack(
  tiles: Tile[],
  opts: EgoBuildOptions = {},
): EgoTrack {
  const headingProperty = opts.headingProperty ?? 'heading';
  const units = opts.headingUnits ?? 'radians';
  const reference = opts.headingReference ?? 'enu';
  const box = opts.boxSize ?? DEFAULT_EGO_BOX;

  const layers: BinaryFeatures[] = [];
  for (const tile of tiles) {
    for (const layer of tile.layers) {
      const b = layer.features;
      if (b.geometryType === GeometryType.Point && b.featureCount > 0) {
        layers.push(b);
      }
    }
  }
  if (layers.length === 0) {
    return { keyframes: [], timeOrigin: 0, dimensions: [...box] };
  }

  const timeOrigin = layers[0].timeOffset;
  const raw: EgoKeyframe[] = [];
  let dims: [number, number, number] | null = null;

  for (const b of layers) {
    const stride = b.positionDimensions ?? 2;
    const rebase = b.timeOffset - timeOrigin;
    const headingCol = b.numericProps[headingProperty] ?? null;
    const lengthCol = b.numericProps[opts.lengthProperty ?? 'length'] ?? null;
    const widthCol = b.numericProps[opts.widthProperty ?? 'width'] ?? null;
    const heightCol = b.numericProps[opts.heightProperty ?? 'height'] ?? null;

    for (let i = 0; i < b.featureCount; i++) {
      raw.push({
        t: b.startTimes[i] + rebase,
        lon: b.positions[i * stride],
        lat: b.positions[i * stride + 1],
        alt: stride > 2 ? b.positions[i * stride + 2] : 0,
        heading: headingCol
          ? normalizeHeading(headingCol[i], units, reference)
          : NaN,
        binary: b,
        featureIndex: i,
      });
      // The vehicle's own box is a constant of the archive, so the first
      // sample that carries all three columns settles it for the whole track —
      // a per-frame dimension lookup would rebuild the box geometry every
      // frame for no gain.
      if (dims === null && lengthCol && widthCol && heightCol) {
        const l = lengthCol[i];
        const w = widthCol[i];
        const h = heightCol[i];
        if (l > 0 && w > 0 && h > 0) dims = [l, w, h];
      }
    }
  }

  raw.sort((p, q) => p.t - q.t);

  const keyframes: EgoKeyframe[] = [];
  for (const k of raw) {
    if (keyframes.length > 0 && keyframes[keyframes.length - 1].t === k.t) {
      continue; // duplicate seam sample
    }
    keyframes.push(k);
  }

  return { keyframes, timeOrigin, dimensions: dims ?? [...box] };
}

/**
 * Index of the last keyframe at or before `t`, by binary search.
 * `t` is assumed already clamped into `[times[0], times[n-1]]`; the returned
 * index is always in `[0, n-2]` when `n > 1` so `lo`/`lo+1` is a valid bracket.
 */
export function bracketIndex(keyframes: EgoKeyframe[], t: number): number {
  const n = keyframes.length;
  if (n < 2) return 0;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keyframes[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * The interpolated ego pose at rebased time `tRel`, or `null` on an empty track.
 *
 * `tRel` is CLAMPED to the track span: before the first sample the car sits at
 * the start pose, after the last it sits at the end pose. That is deliberate —
 * the AV cockpit's follow camera targets this pose, and letting it vanish at
 * the seams would throw the camera to the globe origin. A caller that wants the
 * marker hidden outside the span compares `pose.t` against the span itself
 * (`STTEgoLayer`'s `outsideRange: 'hide'` does exactly that).
 */
export function sampleEgoPose(track: EgoTrack, tRel: number): EgoPose | null {
  const k = track.keyframes;
  const n = k.length;
  if (n === 0) return null;

  const first = k[0].t;
  const last = k[n - 1].t;
  const t = tRel < first ? first : tRel > last ? last : tRel;

  if (n === 1) {
    const only = k[0];
    return {
      lon: only.lon,
      lat: only.lat,
      alt: only.alt,
      // A single sample has no direction of travel; 0 (due east) is the
      // documented, deterministic stand-in.
      heading: Number.isFinite(only.heading) ? only.heading : 0,
      t,
      binary: only.binary,
      featureIndex: only.featureIndex,
    };
  }

  const i = bracketIndex(k, t);
  const a = k[i];
  const b = k[i + 1];
  const span = b.t - a.t;
  const f = span > 0 ? (t - a.t) / span : 0;

  const lon = a.lon + (b.lon - a.lon) * f;
  const lat = a.lat + (b.lat - a.lat) * f;
  const alt = a.alt + (b.alt - a.alt) * f;

  let heading: number;
  if (Number.isFinite(a.heading) && Number.isFinite(b.heading)) {
    heading = lerpAngle(a.heading, b.heading, f);
  } else if (Number.isFinite(a.heading)) {
    heading = a.heading;
  } else if (Number.isFinite(b.heading)) {
    heading = b.heading;
  } else {
    heading = travelHeading(a, b);
  }

  return {
    lon,
    lat,
    alt,
    heading,
    t,
    binary: a.binary,
    featureIndex: a.featureIndex,
  };
}

/**
 * Direction of travel between two keyframes, radians CCW-from-east.
 *
 * A local flat approximation is exact enough here: the two samples are metres
 * apart at AV cadence, and the `cos(lat)` term is all that keeps a longitude
 * delta comparable to a latitude one. A stationary pair has no direction — 0
 * (due east) is returned rather than `atan2(0, 0)`'s 0-by-accident, so the
 * intent is explicit.
 */
function travelHeading(a: EgoKeyframe, b: EgoKeyframe): number {
  const dLat = b.lat - a.lat;
  const dLon = b.lon - a.lon;
  if (dLat === 0 && dLon === 0) return 0;
  const cosLat = Math.cos(((a.lat + b.lat) / 2) * DEG2RAD);
  return wrapAngle(Math.atan2(dLat, dLon * cosLat));
}

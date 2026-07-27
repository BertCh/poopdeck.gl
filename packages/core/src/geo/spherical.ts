// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * Spherical-earth geodesy — the small, allocation-free trig kernel the CPU
 * motion path needs: distance, initial bearing, forward geodesic, and
 * great-circle interpolation, all on ONE sphere of radius
 * {@link SPHERE_RADIUS_M}.
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT DUPLICATES A LITTLE ─────────────────────
 * `render/motion.ts` has to turn a speed + a course into a position ahead of the
 * last keyframe, and turn two keyframes back into a speed + a course. Those two
 * directions are only each other's inverse when EVERY function involved assumes
 * the same earth model. Scattering the radius (or mixing a haversine on 6371 km
 * with a destination formula on 6378 km) makes derived velocity irreversible by
 * ~0.1%, which shows up as a track that drifts off its own keyframes — a bug
 * with no error message. So the radius is declared once here and every function
 * below reads it, and `spherical.test.ts` pins the round trip.
 *
 * {@link SPHERE_RADIUS_M} is deliberately 6 371 000 m — the value
 * `render/trips.ts` already uses for its private `haversineMeters`, NOT the
 * WGS84 semi-major `EARTH_RADIUS` (6 378 137) that `geo/local-enu.ts` exports
 * for projection. Mean-radius sphere is the right model for a distance along the
 * ground; the semi-major axis is the right model for placing a point in ECEF.
 * They are different jobs and the two constants must not be merged.
 *
 * {@link wrapLonDeg} is a DELIBERATE second copy of `archive.ts`'s `wrapLon`.
 * The render kernel must not import the archive (a tile-fetching module with a
 * scheduler and a cache) to fold a longitude, and `spherical.test.ts` pins the
 * two byte-equal over a swept range so the copy cannot drift silently.
 *
 * Every function that produces a point writes into a caller-supplied `out` and
 * returns it. Nothing here allocates: this runs once per extrapolated entity per
 * frame, and a per-entity `{lon, lat}` literal at 60 Hz is exactly the kind of
 * garbage that turns a smooth glide into a sawtooth.
 */

/**
 * Sphere radius (metres) shared by EVERY function in this module. Equal to
 * `render/trips.ts`'s `EARTH_RADIUS_M`, so a distance measured by the trips
 * kernel and a distance measured here are the same number.
 */
export const SPHERE_RADIUS_M = 6_371_000;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** A geographic point in degrees. The out-param shape of this module. */
export interface LonLat {
  lon: number;
  lat: number;
}

/**
 * Fold a longitude into [-180, 180). DELIBERATE second copy of `archive.ts`'s
 * `wrapLon` (see the module header); pinned byte-equal by `spherical.test.ts`.
 */
export function wrapLonDeg(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Signed shortest longitude delta `from → to`, normalized into (-180, 180] —
 * the degrees analogue of the shortest-arc normalization in
 * `track-kernel.lerpAngleDeg`. This is what makes a longitude lerp take the
 * 0.4° route across the antimeridian instead of the 359.6° route the long way
 * round the planet.
 */
export function shortestLonDeltaDeg(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  return d;
}

/**
 * Great-circle distance in metres. Inputs in degrees.
 *
 * Byte-identical transcription of `render/trips.ts`'s private
 * `haversineMeters` — same operation order, same constant — so the two agree to
 * the last bit. `spherical.test.ts` pins that against its own inline copy of
 * the trips version.
 */
export function haversineMeters(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const lat1Rad = (lat1 * Math.PI) / 180;
  const lat2Rad = (lat2 * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const a =
    sinDLat * sinDLat +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * sinDLon * sinDLon;
  return 2 * SPHERE_RADIUS_M * Math.asin(Math.sqrt(a));
}

/**
 * Initial bearing along the great circle from point 1 to point 2, in COMPASS
 * degrees normalized to [0, 360): 0 = due north, increasing clockwise.
 *
 * Compass is this module's ONE convention. The repo contains both spellings
 * under the name "heading" — AIS `cog` and aircraft `heading` are compass, while
 * `animated-bounding-box-layer.ts` builds its velocity arrow as
 * `vx = speed·cos(heading)` (east) / `vy = speed·sin(heading)` (north), which is
 * the MATH convention (0 = east, counter-clockwise). Callers convert at the
 * boundary via `render/motion.ts`'s `toCompassDeg` / `fromCompassDeg`; nothing
 * inside this module ever sees a math-convention angle.
 *
 * Identical points return 0 (`atan2(0, 0)`), which is the harmless answer: a
 * zero-length step has no direction.
 */
export function initialBearingDeg(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
): number {
  const phi1 = lat1 * DEG2RAD;
  const phi2 = lat2 * DEG2RAD;
  const dLambda = (lon2 - lon1) * DEG2RAD;
  const sinDL = Math.sin(dLambda);
  const cosDL = Math.cos(dLambda);
  const cosPhi1 = Math.cos(phi1);
  const cosPhi2 = Math.cos(phi2);
  const sinPhi1 = Math.sin(phi1);
  const sinPhi2 = Math.sin(phi2);
  const y = sinDL * cosPhi2;
  const x = cosPhi1 * sinPhi2 - sinPhi1 * cosPhi2 * cosDL;
  const deg = Math.atan2(y, x) * RAD2DEG;
  return (deg + 360) % 360;
}

/**
 * Forward geodesic: the point `distanceMeters` from (`lon`, `lat`) along the
 * great circle leaving on COMPASS bearing `bearingDeg`. Writes into and returns
 * `out`; allocates nothing.
 *
 * Exact inverse of {@link initialBearingDeg} + {@link haversineMeters} on the
 * same sphere — that reversibility is what lets the motion kernel derive a
 * velocity from two keyframes and then reproduce the second keyframe from the
 * first. The returned latitude is in [-90, 90] by construction (`asin`), and
 * the longitude is folded into [-180, 180), so extrapolating east across the
 * antimeridian emits −179.9 rather than 180.1.
 */
export function destinationPoint(
  lon: number,
  lat: number,
  bearingDeg: number,
  distanceMeters: number,
  out: LonLat,
): LonLat {
  const delta = distanceMeters / SPHERE_RADIUS_M; // angular distance (rad)
  const theta = bearingDeg * DEG2RAD;
  const phi1 = lat * DEG2RAD;
  const lambda1 = lon * DEG2RAD;
  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const sinDelta = Math.sin(delta);
  const cosDelta = Math.cos(delta);
  const sinPhi2 = sinPhi1 * cosDelta + cosPhi1 * sinDelta * Math.cos(theta);
  const phi2 = Math.asin(sinPhi2 < -1 ? -1 : sinPhi2 > 1 ? 1 : sinPhi2);
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * sinDelta * cosPhi1,
      cosDelta - sinPhi1 * Math.sin(phi2),
    );
  out.lon = wrapLonDeg(lambda2 * RAD2DEG);
  out.lat = phi2 * RAD2DEG;
  return out;
}

/**
 * Point at fraction `f` along the great circle from 1 to 2 — unit-sphere slerp.
 * Writes into and returns `out`; allocates nothing.
 *
 * `f === 0` and `f === 1` return the endpoints EXACTLY (not "to within a
 * rounding"), because the sampler's bracket ends are also the points a
 * neighbouring bracket starts from: a slerp that returned lat 12.999999999998
 * at `f === 1` would put a visible one-frame kink at every keyframe.
 *
 * `sinTheta < 1e-6` (coincident or antipodal endpoints — slerp is undefined at
 * antipodes, every great circle through them is equally short) falls back to
 * linear interpolation of the direction vectors, matching the small-angle branch
 * of `packages/cesium/src/lib/polylines.ts`'s `sampleGreatCircleArc` and three's
 * `greatCirclePos` shader. One fallback rule, three implementations.
 *
 * The seam is handled by construction: 179°E → 179°W interpolates THROUGH 180,
 * because the two direction vectors are neighbours in 3D no matter what their
 * longitudes read.
 */
export function interpolateGreatCircle(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
  f: number,
  out: LonLat,
): LonLat {
  if (f === 0) {
    out.lon = lon1;
    out.lat = lat1;
    return out;
  }
  if (f === 1) {
    out.lon = lon2;
    out.lat = lat2;
    return out;
  }

  const phi1 = lat1 * DEG2RAD;
  const phi2 = lat2 * DEG2RAD;
  const lam1 = lon1 * DEG2RAD;
  const lam2 = lon2 * DEG2RAD;
  const cosPhi1 = Math.cos(phi1);
  const cosPhi2 = Math.cos(phi2);
  const ax = cosPhi1 * Math.cos(lam1);
  const ay = cosPhi1 * Math.sin(lam1);
  const az = Math.sin(phi1);
  const bx = cosPhi2 * Math.cos(lam2);
  const by = cosPhi2 * Math.sin(lam2);
  const bz = Math.sin(phi2);

  const dot = ax * bx + ay * by + az * bz;
  const cos = dot < -1 ? -1 : dot > 1 ? 1 : dot;
  const theta = Math.acos(cos);
  const sinTheta = Math.sin(theta);

  let x: number;
  let y: number;
  let z: number;
  if (sinTheta > 1e-6) {
    const wa = Math.sin((1 - f) * theta) / sinTheta;
    const wb = Math.sin(f * theta) / sinTheta;
    x = ax * wa + bx * wb;
    y = ay * wa + by * wb;
    z = az * wa + bz * wb;
  } else {
    x = ax + (bx - ax) * f;
    y = ay + (by - ay) * f;
    z = az + (bz - az) * f;
  }

  const len = Math.hypot(x, y, z);
  if (len > 1e-9) {
    x /= len;
    y /= len;
    z /= len;
  }
  out.lon = Math.atan2(y, x) * RAD2DEG;
  out.lat = Math.asin(z < -1 ? -1 : z > 1 ? 1 : z) * RAD2DEG;
  return out;
}

/** Scratch point for {@link greatCircleCourseDeg}'s internal interpolation. */
const COURSE_SCRATCH: LonLat = { lon: 0, lat: 0 };

/**
 * COMPASS course (heading of travel) at fraction `f` along the great circle
 * from 1 to 2. Unlike a rhumb line, a great circle's course changes continuously
 * along the arc — a flight leaving London for Los Angeles departs on ~320° and
 * arrives on ~250° — so a track rendered along a great circle must re-read its
 * heading at the playhead rather than lerping the two endpoint bearings.
 *
 * At `f >= 1` the arc has no remaining forward segment, so the FINAL bearing is
 * used: the reverse arc's initial bearing turned through 180°.
 */
export function greatCircleCourseDeg(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
  f: number,
): number {
  if (f >= 1) {
    return (initialBearingDeg(lon2, lat2, lon1, lat1) + 180) % 360;
  }
  const p = interpolateGreatCircle(lon1, lat1, lon2, lat2, f, COURSE_SCRATCH);
  return initialBearingDeg(p.lon, p.lat, lon2, lat2);
}

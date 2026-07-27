// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

/**
 * `geo/spherical.ts` — the trig kernel under the motion modes.
 *
 * Three things are pinned here, and each of them is a bug this repo has already
 * had once in some form:
 *
 *  1. THE COPIES ARE COPIES. `haversineMeters` is a deliberate duplicate of the
 *     private one in `render/trips.ts`, and `wrapLonDeg` a deliberate duplicate
 *     of `archive.ts`'s `wrapLon`. Both duplications are defensible (the render
 *     kernel must not import the archive; trips predates this module) and both
 *     are exactly the "hand-copied CPU math silently diverges" failure this
 *     codebase documents. So the copies are pinned: haversine against an INLINE
 *     transcription of the trips version (importing the thing you are pinning
 *     proves nothing — it is private anyway), and wrapLon against the real
 *     archive export.
 *
 *  2. THE ROUND TRIP CLOSES. `destinationPoint(a, initialBearingDeg(a,b),
 *     haversineMeters(a,b))` must land back on `b`. That is what makes a
 *     velocity DERIVED from two keyframes reproduce the second keyframe, and it
 *     holds only because all three functions share `SPHERE_RADIUS_M`. Mixing in
 *     a WGS84 radius anywhere breaks it by ~0.1% — a track that drifts off its
 *     own data, with no error message.
 *
 *  3. THE SLERP AGREES WITH THE PROJECTION KERNEL. `interpolateGreatCircle` is
 *     checked against an independent oracle built from `GlobeProjection`
 *     (project → normalised vector slerp → unproject), so the lon/lat form and
 *     the ECEF form of the same arc cannot drift.
 */

import { describe, it, expect } from 'vitest';
import {
  SPHERE_RADIUS_M,
  wrapLonDeg,
  shortestLonDeltaDeg,
  haversineMeters,
  initialBearingDeg,
  destinationPoint,
  interpolateGreatCircle,
  greatCircleCourseDeg,
  type LonLat,
} from '../src/geo/spherical';
import { wrapLon } from '../src/archive';
import { GlobeProjection } from '../src/geo/globe';
import {
  GEODESY_GOLDENS,
  CARDINAL_DESTINATIONS,
  ONE_DEGREE_M,
  OVER_THE_POLE,
  LAX_JFK,
} from './helpers/geodesy-goldens';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * VERBATIM transcription of the private `haversineMeters` in
 * `packages/core/src/render/trips.ts`, with its `EARTH_RADIUS_M` inlined. Kept
 * as source text here on purpose: this test's whole job is to notice if the two
 * ever stop agreeing, which it cannot do by importing either of them.
 */
function tripsHaversineMeters(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
): number {
  const EARTH_RADIUS_M = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const lat1Rad = (lat1 * Math.PI) / 180;
  const lat2Rad = (lat2 * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const a =
    sinDLat * sinDLat +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

const OUT: LonLat = { lon: 0, lat: 0 };

describe('spherical: the duplicated implementations are pinned equal', () => {
  it('SPHERE_RADIUS_M is the trips kernel radius, NOT the WGS84 semi-major axis', () => {
    expect(SPHERE_RADIUS_M).toBe(6_371_000);
    expect(SPHERE_RADIUS_M).not.toBe(6_378_137);
  });

  it('haversineMeters is BITWISE equal to the trips kernel copy (1000 pairs)', () => {
    const r = rng(1234);
    for (let i = 0; i < 1000; i++) {
      const lon1 = (r() - 0.5) * 360;
      const lat1 = (r() - 0.5) * 180;
      const lon2 = (r() - 0.5) * 360;
      const lat2 = (r() - 0.5) * 180;
      expect(
        Object.is(
          haversineMeters(lon1, lat1, lon2, lat2),
          tripsHaversineMeters(lon1, lat1, lon2, lat2),
        ),
        `pair ${i}: ${lon1},${lat1} → ${lon2},${lat2}`,
      ).toBe(true);
    }
  });

  it("wrapLonDeg is bitwise equal to archive.ts's wrapLon over a swept range", () => {
    for (let lon = -1080; lon <= 1080; lon += 0.25) {
      expect(Object.is(wrapLonDeg(lon), wrapLon(lon)), `lon=${lon}`).toBe(true);
    }
    // …including the exact seam values the tile-selection code cares about.
    for (const lon of [-180, -180.0001, 179.9999, 180, 180.0001, 360, -360]) {
      expect(Object.is(wrapLonDeg(lon), wrapLon(lon)), `lon=${lon}`).toBe(true);
    }
  });

  it('shortestLonDeltaDeg takes the short way across the seam', () => {
    expect(shortestLonDeltaDeg(179.9, -179.9)).toBeCloseTo(0.2, 9);
    expect(shortestLonDeltaDeg(-179.9, 179.9)).toBeCloseTo(-0.2, 9);
    expect(shortestLonDeltaDeg(0, 90)).toBe(90);
    expect(shortestLonDeltaDeg(0, -90)).toBe(-90);
    // The boundary is (-180, 180]: an exact half-turn resolves eastward.
    expect(shortestLonDeltaDeg(0, 180)).toBe(180);
  });
});

describe('spherical: distance / bearing goldens', () => {
  // One case per golden rather than one loop: the arc that failed names itself
  // in the test title, which a loop can only do by passing a message `expect`
  // does not take.
  it.each(GEODESY_GOLDENS)(
    'matches the hand-computed sphere golden: $name',
    (g) => {
      const [lon1, lat1] = g.from;
      const [lon2, lat2] = g.to;
      // 1 cm on a 3974 km arc.
      expect(haversineMeters(lon1, lat1, lon2, lat2)).toBeCloseTo(
        g.distanceM,
        1,
      );
      expect(initialBearingDeg(lon1, lat1, lon2, lat2)).toBeCloseTo(
        g.initialBearingDeg,
        5,
      );
      const mid = interpolateGreatCircle(lon1, lat1, lon2, lat2, 0.5, OUT);
      // Longitude compared through the seam, so 180 and −180 are the same point.
      expect(
        Math.abs(shortestLonDeltaDeg(mid.lon, g.midpoint[0])),
      ).toBeLessThan(1e-6);
      expect(mid.lat).toBeCloseTo(g.midpoint[1], 6);
    },
  );

  it('the LAX→JFK great-circle midpoint bulges NORTH of the latitude midpoint', () => {
    const [lon1, lat1] = LAX_JFK.from;
    const [lon2, lat2] = LAX_JFK.to;
    const mid = interpolateGreatCircle(lon1, lat1, lon2, lat2, 0.5, OUT);
    const latLerpMid = (lat1 + lat2) / 2;
    // This IS the reason the great-circle mode exists: a lon/lat lerp puts the
    // aircraft ~140 km south of where it actually is at the halfway point.
    expect(mid.lat).toBeGreaterThan(latLerpMid);
    expect(mid.lat - latLerpMid).toBeCloseTo(2.1653, 3);
  });

  it('walks one degree of arc onto each cardinal point', () => {
    for (const c of CARDINAL_DESTINATIONS) {
      const p = destinationPoint(0, 0, c.bearingDeg, ONE_DEGREE_M, OUT);
      expect(p.lon, `bearing ${c.bearingDeg}`).toBeCloseTo(c.expect[0], 9);
      expect(p.lat, `bearing ${c.bearingDeg}`).toBeCloseTo(c.expect[1], 9);
    }
  });

  it('travels OVER the pole rather than clamping at it', () => {
    const p = destinationPoint(
      OVER_THE_POLE.from[0],
      OVER_THE_POLE.from[1],
      OVER_THE_POLE.bearingDeg,
      OVER_THE_POLE.distanceM,
      OUT,
    );
    expect(p.lat).toBeCloseTo(OVER_THE_POLE.expect[1], 9);
    expect(p.lon).toBeCloseTo(OVER_THE_POLE.expect[0], 9);
    // Latitude never leaves the range a sphere has.
    expect(p.lat).toBeLessThanOrEqual(90);
    expect(p.lat).toBeGreaterThanOrEqual(-90);
  });
});

describe('spherical: the derive → extrapolate round trip closes', () => {
  it('destinationPoint(a, bearing(a,b), distance(a,b)) lands back on b (1000 pairs)', () => {
    const r = rng(99);
    let worstLat = 0;
    let worstLon = 0;
    for (let i = 0; i < 1000; i++) {
      const lon1 = (r() - 0.5) * 360;
      const lat1 = (r() - 0.5) * 170; // ±85 — the poles are their own goldens
      const lon2 = (r() - 0.5) * 360;
      const lat2 = (r() - 0.5) * 170;
      const b = initialBearingDeg(lon1, lat1, lon2, lat2);
      const d = haversineMeters(lon1, lat1, lon2, lat2);
      const p = destinationPoint(lon1, lat1, b, d, OUT);
      const dLat = Math.abs(p.lat - lat2);
      const dLon = Math.abs(shortestLonDeltaDeg(p.lon, lon2));
      if (dLat > worstLat) worstLat = dLat;
      if (dLon > worstLon) worstLon = dLon;
    }
    expect(worstLat, `worst latitude error ${worstLat}`).toBeLessThan(1e-9);
    expect(worstLon, `worst longitude error ${worstLon}`).toBeLessThan(1e-9);
  });
});

describe('spherical: great-circle interpolation', () => {
  it('returns the endpoints EXACTLY at f=0 and f=1', () => {
    const r = rng(7);
    for (let i = 0; i < 200; i++) {
      const lon1 = (r() - 0.5) * 360;
      const lat1 = (r() - 0.5) * 180;
      const lon2 = (r() - 0.5) * 360;
      const lat2 = (r() - 0.5) * 180;
      const a = interpolateGreatCircle(lon1, lat1, lon2, lat2, 0, OUT);
      expect(Object.is(a.lon, lon1) && Object.is(a.lat, lat1)).toBe(true);
      const b = interpolateGreatCircle(lon1, lat1, lon2, lat2, 1, OUT);
      expect(Object.is(b.lon, lon2) && Object.is(b.lat, lat2)).toBe(true);
    }
  });

  it('falls back to linear on antipodal endpoints instead of returning NaN', () => {
    // Antipodes: slerp is undefined (every great circle through them is equally
    // short), sinTheta ≈ 0, and dividing by it would produce NaN everywhere.
    const p = interpolateGreatCircle(0, 0, 180, 0, 0.5, OUT);
    expect(Number.isFinite(p.lon)).toBe(true);
    expect(Number.isFinite(p.lat)).toBe(true);
    // Coincident endpoints take the same branch and must not move.
    const q = interpolateGreatCircle(12, 34, 12, 34, 0.5, OUT);
    expect(q.lon).toBeCloseTo(12, 9);
    expect(q.lat).toBeCloseTo(34, 9);
  });

  it('interpolates 179E → 179W THROUGH 180, not back through Greenwich', () => {
    const mid = interpolateGreatCircle(179, 0, -179, 0, 0.5, OUT);
    expect(Math.abs(Math.abs(mid.lon) - 180)).toBeLessThan(1e-9);
    // Sampled densely, no step may jump the long way round.
    let prev = 179;
    for (let f = 0; f <= 1.0001; f += 0.01) {
      const p = interpolateGreatCircle(179, 0, -179, 0, Math.min(f, 1), OUT);
      expect(Math.abs(shortestLonDeltaDeg(prev, p.lon))).toBeLessThan(0.5);
      prev = p.lon;
    }
  });

  it('agrees to 1e-9 with a GlobeProjection project → slerp → unproject oracle', () => {
    // Independent oracle: the ECEF form of the same arc, built from the
    // projection kernel the three/Cesium backends actually render with.
    const globe = new GlobeProjection({ longitude: 0, latitude: 0 }, 1);
    const oracle = (
      lon1: number,
      lat1: number,
      lon2: number,
      lat2: number,
      f: number,
    ): [number, number] => {
      const a = globe.project(lon1, lat1, 0);
      const b = globe.project(lon2, lat2, 0);
      const dot = Math.min(
        1,
        Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]),
      );
      const theta = Math.acos(dot);
      const sinTheta = Math.sin(theta);
      const wa = Math.sin((1 - f) * theta) / sinTheta;
      const wb = Math.sin(f * theta) / sinTheta;
      let x = a[0] * wa + b[0] * wb;
      let y = a[1] * wa + b[1] * wb;
      let z = a[2] * wa + b[2] * wb;
      const len = Math.hypot(x, y, z);
      x /= len;
      y /= len;
      z /= len;
      const [lon, lat] = globe.unproject(x, y, z);
      return [lon, lat];
    };

    const r = rng(4242);
    for (let i = 0; i < 500; i++) {
      const lon1 = (r() - 0.5) * 360;
      const lat1 = (r() - 0.5) * 170;
      const lon2 = (r() - 0.5) * 360;
      const lat2 = (r() - 0.5) * 170;
      const f = 0.05 + r() * 0.9;
      const [oLon, oLat] = oracle(lon1, lat1, lon2, lat2, f);
      if (!Number.isFinite(oLon) || !Number.isFinite(oLat)) continue; // antipodal
      const p = interpolateGreatCircle(lon1, lat1, lon2, lat2, f, OUT);
      expect(
        Math.abs(shortestLonDeltaDeg(p.lon, oLon)),
        `pair ${i}`,
      ).toBeLessThan(1e-9);
      expect(Math.abs(p.lat - oLat), `pair ${i}`).toBeLessThan(1e-9);
    }
  });

  it('greatCircleCourseDeg turns along the arc and ends on the final bearing', () => {
    const [lon1, lat1] = LAX_JFK.from;
    const [lon2, lat2] = LAX_JFK.to;
    const start = greatCircleCourseDeg(lon1, lat1, lon2, lat2, 0);
    const end = greatCircleCourseDeg(lon1, lat1, lon2, lat2, 1);
    expect(start).toBeCloseTo(initialBearingDeg(lon1, lat1, lon2, lat2), 9);
    // A great circle's course changes along the arc — that is exactly why the
    // heading has to be re-read at the playhead rather than lerped.
    expect(end).toBeGreaterThan(start + 10);
    // The final bearing is the reverse arc's initial bearing, turned 180°.
    expect(end).toBeCloseTo(
      (initialBearingDeg(lon2, lat2, lon1, lat1) + 180) % 360,
      9,
    );
    // Monotonic along this (northern, eastbound) arc.
    let prev = start;
    for (let f = 0.05; f <= 1; f += 0.05) {
      const c = greatCircleCourseDeg(lon1, lat1, lon2, lat2, f);
      expect(c).toBeGreaterThan(prev);
      prev = c;
    }
  });
});

describe('spherical: out-params are honoured (no hidden allocation)', () => {
  it('every producer returns the identical object it was handed', () => {
    const out: LonLat = { lon: 0, lat: 0 };
    expect(destinationPoint(1, 2, 30, 1000, out)).toBe(out);
    expect(interpolateGreatCircle(1, 2, 3, 4, 0, out)).toBe(out);
    expect(interpolateGreatCircle(1, 2, 3, 4, 1, out)).toBe(out);
    expect(interpolateGreatCircle(1, 2, 3, 4, 0.5, out)).toBe(out);
  });

  it('greatCircleCourseDeg does not clobber the caller-supplied out object', () => {
    const out: LonLat = { lon: 0, lat: 0 };
    destinationPoint(1, 2, 30, 1000, out);
    const snapshot = { ...out };
    greatCircleCourseDeg(10, 20, 30, 40, 0.5);
    expect(out).toEqual(snapshot);
  });
});

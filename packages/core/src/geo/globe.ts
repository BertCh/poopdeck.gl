// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * ECEF globe projection — lon/lat/alt placed on a real 3D globe (Earth-Centred,
 * Earth-Fixed), so a standard MVP renders the planet with no special globe vertex
 * shader and real depth/occlusion. Moved from `@poopdeck.gl/three` into the
 * framework-free kernel and EXTENDED with a WGS84-ellipsoid datum + a
 * parameterizable radius so real globe hosts can reuse it (see
 * docs/roadmap/renderer-abstraction-2026-06.md §5.2 — a sphere mis-registers
 * geometry against Cesium's WGS84 frame by up to ~20 km at mid-latitudes).
 *
 * ── Axes (standard ECEF) ─────────────────────────────────────────────────────
 *   +X → (lon 0°, lat 0°)   +Y → (lon 90°E, lat 0°)   +Z → north pole
 *
 * `radius` sets the world-unit length of the semi-major axis (default
 * `EARTH_RADIUS` metres; pass e.g. 100 for globe.gl's unit-sphere world).
 * `datum` selects `'sphere'` (v1 default, byte-identical to the original three
 * projection) or `'wgs84'` (the ellipsoid Cesium / a real globe host expects).
 * Coords are large (~radius) → feed through {@link projectPositions} (RTC).
 */

import { EARTH_RADIUS, type GeoAnchor, type LocalFrame, type Projection } from './local-enu';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** WGS84 flattening and derived first-eccentricity-squared. */
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export type GlobeDatum = 'sphere' | 'wgs84';

export interface GlobeProjectionOptions {
  /** `'sphere'` (default, byte-identical to v1) or `'wgs84'` ellipsoid. */
  datum?: GlobeDatum;
}

export class GlobeProjection implements Projection {
  readonly kind = 'globe';
  readonly anchor: GeoAnchor;
  /** Semi-major-axis length in world units (metres by default). */
  readonly radius: number;
  readonly datum: GlobeDatum;
  /** world-units-per-metre (radius / EARTH_RADIUS). */
  private readonly scale: number;

  constructor(
    anchor: GeoAnchor = { longitude: 0, latitude: 0 },
    radius = EARTH_RADIUS,
    opts: GlobeProjectionOptions = {},
  ) {
    this.anchor = anchor;
    this.radius = radius;
    this.datum = opts.datum ?? 'sphere';
    this.scale = radius / EARTH_RADIUS;
  }

  project(longitude: number, latitude: number, altitude = 0): [number, number, number] {
    const lon = longitude * DEG2RAD;
    const lat = latitude * DEG2RAD;
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    const cosLon = Math.cos(lon);
    const sinLon = Math.sin(lon);
    if (this.datum === 'wgs84') {
      // Geodetic lon/lat/h (m) → ECEF (m), then to world units via `scale`.
      const n = EARTH_RADIUS / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
      const xm = (n + altitude) * cosLat * cosLon;
      const ym = (n + altitude) * cosLat * sinLon;
      const zm = (n * (1 - WGS84_E2) + altitude) * sinLat;
      return [xm * this.scale, ym * this.scale, zm * this.scale];
    }
    // Sphere (v1): byte-identical to the original three projection when
    // radius === EARTH_RADIUS (scale === 1).
    const r = this.radius + altitude * this.scale;
    return [r * cosLat * cosLon, r * cosLat * sinLon, r * sinLat];
  }

  unproject(x: number, y: number, z = 0): [number, number, number] {
    if (this.datum === 'wgs84') {
      // World units → ECEF metres, then Bowring's closed-form inverse.
      const xm = x / this.scale;
      const ym = y / this.scale;
      const zm = z / this.scale;
      const a = EARTH_RADIUS;
      const b = a * (1 - WGS84_F);
      const ep2 = (a * a - b * b) / (b * b);
      const p = Math.hypot(xm, ym);
      const longitude = Math.atan2(ym, xm) * RAD2DEG;
      if (p === 0) {
        const latitude = zm >= 0 ? 90 : -90;
        return [longitude, latitude, Math.abs(zm) - b];
      }
      const th = Math.atan2(a * zm, b * p);
      const sinTh = Math.sin(th);
      const cosTh = Math.cos(th);
      const lat = Math.atan2(zm + ep2 * b * sinTh * sinTh * sinTh, p - WGS84_E2 * a * cosTh * cosTh * cosTh);
      const sinLat = Math.sin(lat);
      const n = a / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
      const h = p / Math.cos(lat) - n;
      return [longitude, lat * RAD2DEG, h];
    }
    const r = Math.hypot(x, y, z);
    if (r === 0) return [this.anchor.longitude, this.anchor.latitude, -this.radius];
    const latitude = Math.asin(clamp(z / r, -1, 1)) * RAD2DEG;
    const longitude = Math.atan2(y, x) * RAD2DEG;
    // r is in world units; convert the height back to metres via `scale`.
    return [longitude, latitude, (r - this.radius) / this.scale];
  }

  /** True ground metres per world unit (EARTH_RADIUS/radius; = 1 at default radius). */
  metersPerWorldUnit(): number {
    return EARTH_RADIUS / this.radius;
  }

  /** Per-position ENU tangent basis in ECEF world space (radial up, east/north
   *  tangents) — the standard geodetic ENU rotation columns (valid for both datums). */
  localFrame(longitude: number, latitude: number): LocalFrame {
    const lon = longitude * DEG2RAD;
    const lat = latitude * DEG2RAD;
    const sinLon = Math.sin(lon);
    const cosLon = Math.cos(lon);
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    return {
      east: [-sinLon, cosLon, 0],
      north: [-sinLat * cosLon, -sinLat * sinLon, cosLat],
      up: [cosLat * cosLon, cosLat * sinLon, sinLat],
    };
  }
}

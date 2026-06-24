// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * ECEF globe projection — lon/lat/alt placed on a real 3D sphere (Earth-Centred,
 * Earth-Fixed metres), so Three's standard MVP renders the planet with no special
 * globe vertex shader and real depth/occlusion. This is the natural fit for a 3D
 * engine and the deliberate departure from deck.gl's `GlobeView`, which warps a
 * mercator-ish space *in the vertex shader*.
 *
 * ── Axes (standard ECEF) ─────────────────────────────────────────────────────
 *   +X → (lon 0°, lat 0°)      +Y → (lon 90°E, lat 0°)      +Z → north pole
 * World units are metres (`metersPerWorldUnit = 1`), so coords are ~6.4e6 and MUST
 * be fed through {@link projectPositions} (RTC) — absolute ECEF f32 shears city
 * geometry by ~half a metre. There is no global "up": each location's up is radial,
 * so the camera is a {@link positionGlobeCamera} rig (not `frameBox`/`MapControls`)
 * and oriented geometry builds its frame from {@link localFrame}.
 *
 * Sphere (not ellipsoid) is intentional for v1 — the flattening is ~0.3%, below
 * what the demos need; swap in WGS84 ellipsoid math here later if required.
 */

import {
  EARTH_RADIUS,
  type GeoAnchor,
  type LocalFrame,
  type Projection,
} from './local-enu';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class GlobeProjection implements Projection {
  readonly kind = 'globe';
  readonly anchor: GeoAnchor;
  /** Sphere radius in world units (metres). */
  readonly radius: number;

  constructor(anchor: GeoAnchor = { longitude: 0, latitude: 0 }, radius = EARTH_RADIUS) {
    this.anchor = anchor;
    this.radius = radius;
  }

  project(longitude: number, latitude: number, altitude = 0): [number, number, number] {
    const lon = longitude * DEG2RAD;
    const lat = latitude * DEG2RAD;
    const r = this.radius + altitude;
    const cosLat = Math.cos(lat);
    return [r * cosLat * Math.cos(lon), r * cosLat * Math.sin(lon), r * Math.sin(lat)];
  }

  unproject(x: number, y: number, z = 0): [number, number, number] {
    const r = Math.hypot(x, y, z);
    if (r === 0) return [this.anchor.longitude, this.anchor.latitude, -this.radius];
    const latitude = Math.asin(clamp(z / r, -1, 1)) * RAD2DEG;
    const longitude = Math.atan2(y, x) * RAD2DEG;
    return [longitude, latitude, r - this.radius];
  }

  /** ECEF is in metres. */
  metersPerWorldUnit(): number {
    return 1;
  }

  /** Per-position ENU tangent basis in ECEF world space (radial up, east/north
   *  tangents) — the standard geodetic ENU rotation columns. */
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

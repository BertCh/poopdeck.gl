// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Web-Mercator projection (EPSG:3857) — the flat-map frame.
 *
 * World units are **mercator metres**: the same space deck.gl's `WebMercatorViewport`
 * works in, scaled so the whole world is `2π·R` units wide. The plane is **Z-up**
 * (ground in XY, altitude in +Z) exactly like {@link LocalEnuProjection}, so the
 * existing `frameBox` camera + `MapControls` (pan in XY, orbit) carry straight over
 * — only the camera *distance* spans a wider range (whole-globe to street).
 *
 * ── Scale (the one subtlety) ─────────────────────────────────────────────────
 * Mercator stretches by `1/cos(lat)` away from the equator, so 1 world unit is
 * NOT 1 ground metre except at the equator: `metersPerWorldUnit = cos(lat)`.
 * Altitude is divided by that factor on the way in (`z = alt / cos(lat)`) so the
 * vertical scale matches the local horizontal scale — a 10 m pole reads as 10 m
 * tall at its latitude. Materials size metric features by `1/metersPerWorldUnit`.
 *
 * ── Precision ────────────────────────────────────────────────────────────────
 * Absolute mercator coords are ~±2e7 and overflow f32 by metres, so this
 * projection does NOT recenter about the anchor (deck doesn't either) — callers
 * feed batches through {@link projectPositions} (RTC) to keep the GPU-side f32
 * offsets tile-small. The stored `anchor` is informational (initial view centre).
 */

import {
  EARTH_RADIUS,
  type GeoAnchor,
  type LocalFrame,
  type Projection,
} from './local-enu';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** Latitude beyond which Web-Mercator's `y` diverges; the standard clamp. */
export const MAX_MERCATOR_LAT = 85.051_128_779_806_59;

function clampLat(lat: number): number {
  return lat < -MAX_MERCATOR_LAT ? -MAX_MERCATOR_LAT : lat > MAX_MERCATOR_LAT ? MAX_MERCATOR_LAT : lat;
}

export class MercatorProjection implements Projection {
  readonly kind = 'mercator';
  readonly anchor: GeoAnchor;

  constructor(anchor: GeoAnchor = { longitude: 0, latitude: 0 }) {
    this.anchor = anchor;
  }

  project(longitude: number, latitude: number, altitude = 0): [number, number, number] {
    const lat = clampLat(latitude);
    const x = EARTH_RADIUS * longitude * DEG2RAD;
    const y = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (lat * DEG2RAD) / 2));
    // Scale altitude to local mercator units so vertical == horizontal scale.
    const z = altitude / this.metersPerWorldUnit(longitude, lat);
    return [x, y, z];
  }

  unproject(x: number, y: number, z = 0): [number, number, number] {
    const longitude = (x / EARTH_RADIUS) * RAD2DEG;
    const latitude = (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * RAD2DEG;
    const altitude = z * this.metersPerWorldUnit(longitude, latitude);
    return [longitude, latitude, altitude];
  }

  metersPerWorldUnit(_longitude: number, latitude: number): number {
    return Math.cos(clampLat(latitude) * DEG2RAD);
  }

  /** Planar Z-up basis — same as ENU (mercator north is +Y, east is +X). */
  localFrame(): LocalFrame {
    return { east: [1, 0, 0], north: [0, 1, 0], up: [0, 0, 1] };
  }
}

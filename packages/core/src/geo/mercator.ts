// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * Web-Mercator projection (EPSG:3857) — the flat-map frame. Moved verbatim from
 * `@poopdeck.gl/three` into the framework-free kernel. World units are mercator
 * metres (the space deck's `WebMercatorViewport` works in), Z-up. Mercator
 * stretches by `1/cos(lat)`, so `metersPerWorldUnit = cos(lat)`; altitude is
 * divided by that factor so vertical == horizontal scale. Absolute coords are
 * ~±2e7 → feed batches through {@link projectPositions} (RTC).
 */

import { EARTH_RADIUS, type GeoAnchor, type LocalFrame, type Projection } from './local-enu';

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

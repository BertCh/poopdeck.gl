// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Local ENU (East-North-Up) metric projection.
 *
 * STT AV tiles store geometry as **lon/lat (+ optional z metres)**, georeferenced
 * at build time by `av_common.local_to_lonlat`, which is an equirectangular
 * (flat-earth) map about a documented scene origin:
 *
 *     lat = origin_lat + y_m / 111320
 *     lon = origin_lon + x_m / (111320 · cos(origin_lat))
 *
 * This projection is the **exact inverse**: it recenters lon/lat back to metres
 * about a chosen anchor, giving a metric ENU frame where 1 world unit = 1 metre.
 * That is precisely the frame the surfel orientation quaternions are baked in
 * (their rotation-matrix columns are `[tangent | bitangent | normal]` in render
 * ENU metres), so in this world the disk-offset math is a 1:1 port of the deck
 * splat shader with NO mercator `project_size` step — metres ARE world units.
 *
 * ── WORLD AXES (Z-up) ────────────────────────────────────────────────────────
 *   world X = East   (+lon)
 *   world Y = North  (+lat)
 *   world Z = Up     (+altitude, metres)
 * We deliberately choose Z-up (not Three's default Y-up "ground in XZ plane")
 * so an ENU vector `(E, N, U)` maps to world `(X, Y, Z)` with no axis permutation
 * — the surfel quaternion basis drops straight in. Cameras must set
 * `camera.up = (0, 0, 1)`; the renderer/controls do this.
 */

/** Metres per degree of latitude — the WGS84-ish constant used by `av_common`. */
export const METERS_PER_DEG_LAT = 111_320;

const DEG2RAD = Math.PI / 180;

/** A lon/lat (degrees) anchor that maps to the world origin `(0, 0)`. */
export interface GeoAnchor {
  longitude: number;
  latitude: number;
}

/**
 * A pluggable lon/lat(+alt) → world projection. `LocalEnuProjection` is the AV
 * implementation; mercator-plane and ECEF-globe variants can implement the same
 * surface later for the flat-map / globe scenes.
 */
export interface Projection {
  readonly kind: string;
  /** Anchor lon/lat that maps to world `(0, 0, *)`. */
  readonly anchor: GeoAnchor;
  /** lon/lat (deg) + altitude (m) → world `[x, y, z]`. */
  project(longitude: number, latitude: number, altitude?: number): [number, number, number];
  /** world `[x, y, z]` → lon/lat (deg) + altitude (m). */
  unproject(x: number, y: number, z?: number): [number, number, number];
}

/**
 * Equirectangular ENU projection anchored at a fixed lon/lat. The east scale is
 * frozen at the anchor latitude (`cos(lat0)`), exactly matching the build-time
 * `local_to_lonlat`, so `project ∘ local_to_lonlat = identity` to f64 precision.
 */
export class LocalEnuProjection implements Projection {
  readonly kind = 'local-enu';
  readonly anchor: GeoAnchor;
  private readonly metersPerLon: number;

  constructor(anchor: GeoAnchor) {
    this.anchor = anchor;
    this.metersPerLon = METERS_PER_DEG_LAT * Math.cos(anchor.latitude * DEG2RAD);
  }

  project(longitude: number, latitude: number, altitude = 0): [number, number, number] {
    return [
      (longitude - this.anchor.longitude) * this.metersPerLon,
      (latitude - this.anchor.latitude) * METERS_PER_DEG_LAT,
      altitude,
    ];
  }

  unproject(x: number, y: number, z = 0): [number, number, number] {
    return [
      this.anchor.longitude + x / this.metersPerLon,
      this.anchor.latitude + y / METERS_PER_DEG_LAT,
      z,
    ];
  }
}

/**
 * Batch-project an interleaved lon/lat(+z) position buffer into a flat
 * `Float32Array` of world `[x, y, z]` triples (one per feature) — the form a
 * Three `InstancedBufferAttribute` / `BufferGeometry` wants.
 *
 * @param positions   interleaved source coords (`Float64Array`), `dims` per point
 * @param count       number of points
 * @param dims        source position dimensions (2 → `[lon,lat]`, 3 → `[lon,lat,z]`)
 * @param elevation   optional per-point altitude column (metres), overrides src z
 * @param elevScale   multiplier applied to `elevation` (default 1)
 */
export function projectPositionsToEnu(
  proj: Projection,
  positions: Float64Array,
  count: number,
  dims: 2 | 3,
  elevation?: Float32Array,
  elevScale = 1,
): Float32Array {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const lon = positions[i * dims];
    const lat = positions[i * dims + 1];
    const alt = elevation
      ? elevation[i] * elevScale
      : dims > 2
        ? positions[i * dims + 2]
        : 0;
    const [x, y, z] = proj.project(lon, lat, alt);
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
  return out;
}

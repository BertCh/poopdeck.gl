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

/** WGS84 semi-major axis (m) — the sphere radius Web-Mercator and the ECEF globe
 *  are both built on. Shared by {@link MercatorProjection} and {@link GlobeProjection}. */
export const EARTH_RADIUS = 6_378_137;

const DEG2RAD = Math.PI / 180;

/** A lon/lat (degrees) anchor that maps to the world origin `(0, 0)`. */
export interface GeoAnchor {
  longitude: number;
  latitude: number;
}

/**
 * A per-location East/North/Up basis expressed in **world** space (unit vectors).
 * For a planar projection (ENU, mercator) this is constant — `(X, Y, Z)`; for the
 * ECEF globe it rotates per position (radial up, tangent east/north). Layers that
 * orient geometry to the ground (oriented boxes, extruded columns, billboards that
 * must lie flat) build their local frame from this instead of assuming Z-up.
 */
export interface LocalFrame {
  /** unit world vector toward local east (+longitude). */
  east: [number, number, number];
  /** unit world vector toward local north (+latitude). */
  north: [number, number, number];
  /** unit world vector toward local up (+altitude). */
  up: [number, number, number];
}

/**
 * A pluggable lon/lat(+alt) → world projection. `LocalEnuProjection` is the AV
 * implementation; {@link MercatorProjection} (flat Z-up plane) and
 * {@link GlobeProjection} (ECEF sphere) implement the same surface for the
 * flat-map / globe scenes.
 *
 * Two methods beyond `project`/`unproject` carry the information a *general*
 * renderer needs but the AV cockpit could hardcode:
 *   • {@link metersPerWorldUnit} — the sizing scale (1 world unit = how many true
 *     ground metres here). ENU = 1; mercator = `cos(lat)`; globe = 1. Materials
 *     multiply metric sizes (point radius, column height, surfel extent) by its
 *     reciprocal so a 2 m object is 2 m everywhere.
 *   • {@link localFrame} — the per-location E/N/U world basis (constant for planar
 *     projections, per-position on the globe).
 */
export interface Projection {
  readonly kind: string;
  /** Anchor lon/lat that maps to world `(0, 0, *)` (planar projections) or is the
   *  view centre (globe). */
  readonly anchor: GeoAnchor;
  /** lon/lat (deg) + altitude (m) → world `[x, y, z]`. */
  project(longitude: number, latitude: number, altitude?: number): [number, number, number];
  /** world `[x, y, z]` → lon/lat (deg) + altitude (m). */
  unproject(x: number, y: number, z?: number): [number, number, number];
  /** True ground metres represented by one world unit at this location. */
  metersPerWorldUnit(longitude: number, latitude: number): number;
  /** Per-location E/N/U unit basis in world space. */
  localFrame(longitude: number, latitude: number): LocalFrame;
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

  /** ENU world units ARE metres (the frame the surfel quaternions are baked in). */
  metersPerWorldUnit(): number {
    return 1;
  }

  /** Constant Z-up basis — ENU axes map straight to world `(X, Y, Z)`. */
  localFrame(): LocalFrame {
    return { east: [1, 0, 0], north: [0, 1, 0], up: [0, 0, 1] };
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

/**
 * RTC ("Relative-To-Center") batch projection — the precision-safe generalization
 * of {@link projectPositionsToEnu} for mercator/globe frames where absolute world
 * coordinates (~5e7 mercator-metres, ~6.4e6 ECEF-metres) overflow f32's ~7
 * significant digits and shear geometry by metres.
 *
 * Instead of writing absolute world coords, it picks a high-precision `origin`
 * (f64) and writes each vertex as an f32 OFFSET from it. The caller parents the
 * resulting `BufferGeometry` under an `Object3D` whose `.position` is that origin:
 * Three composes the model matrix in f64 on the CPU, so the large translation
 * stays exact while the GPU only ever sees small (tile-sized) f32 offsets. This is
 * the spatial analogue of the renderer's per-tile `timeOffset` time rebasing.
 *
 * For the ENU/AV path the coords are already tiny near the anchor, so passing
 * `origin: [0,0,0]` reproduces {@link projectPositionsToEnu} exactly.
 *
 * @param origin  explicit world origin; defaults to the first feature's projected
 *                position (a cheap per-tile-group reference that keeps offsets small).
 */
export interface ProjectedPositions {
  /** vec3 world coordinates, f32, RELATIVE to {@link origin}. */
  positions: Float32Array;
  /** f64 world-space origin the positions are relative to (add back for absolute). */
  origin: [number, number, number];
}

export function projectPositions(
  proj: Projection,
  positions: Float64Array,
  count: number,
  dims: 2 | 3,
  opts: {
    elevation?: Float32Array;
    elevScale?: number;
    origin?: [number, number, number];
  } = {},
): ProjectedPositions {
  const out = new Float32Array(count * 3);
  if (count === 0) return { positions: out, origin: opts.origin ?? [0, 0, 0] };
  const elevScale = opts.elevScale ?? 1;
  const project = (i: number): [number, number, number] => {
    const lon = positions[i * dims];
    const lat = positions[i * dims + 1];
    const alt = opts.elevation
      ? opts.elevation[i] * elevScale
      : dims > 2
        ? positions[i * dims + 2]
        : 0;
    return proj.project(lon, lat, alt);
  };
  const origin = opts.origin ?? project(0);
  const [ox, oy, oz] = origin;
  for (let i = 0; i < count; i++) {
    const [x, y, z] = project(i);
    out[i * 3] = x - ox;
    out[i * 3 + 1] = y - oy;
    out[i * 3 + 2] = z - oz;
  }
  return { positions: out, origin };
}

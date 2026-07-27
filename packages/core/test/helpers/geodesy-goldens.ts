// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

/**
 * Hand-computed spherical-geodesy constants for `spherical.test.ts`.
 *
 * PURE DATA. This file must NEVER import `src/geo/spherical.ts` — the whole
 * point is that the expected values were produced OUTSIDE the module under
 * test (standard closed-form spherical formulae on a sphere of radius
 * 6 371 000 m, the same radius `render/trips.ts` uses). A golden file that
 * calls the implementation to compute its goldens pins nothing: the
 * implementation could be wrong in both places and the test would still pass.
 *
 * Every distance is metres on the 6371 km sphere; every bearing is COMPASS
 * degrees (0 = north, clockwise). Tolerances live in the test, not here.
 */

export interface GeodesyGolden {
  readonly name: string;
  readonly from: readonly [number, number]; // [lon, lat]
  readonly to: readonly [number, number];
  /** Great-circle distance, metres. */
  readonly distanceM: number;
  /** Initial bearing from → to, compass degrees. */
  readonly initialBearingDeg: number;
  /** Midpoint of the great-circle arc, [lon, lat]. */
  readonly midpoint: readonly [number, number];
}

/**
 * LAX → JFK, the canonical worked example in every geodesy reference. On a
 * 6371 km sphere the arc is ~3974 km; the initial bearing is ~66° (well north
 * of the ~90° a rhumb line would suggest), and the midpoint sits ~1.7° NORTH of
 * the latitude midpoint — which is exactly the "great circles bulge poleward"
 * effect the great-circle motion mode exists to reproduce.
 */
export const LAX_JFK: GeodesyGolden = {
  name: 'LAX → JFK',
  from: [-118.408, 33.9425],
  to: [-73.7789, 40.6397],
  distanceM: 3_974_197.77,
  initialBearingDeg: 65.870691,
  midpoint: [-97.141167, 39.456404],
};

/** Equator, due east, one quarter of the way round the planet. */
export const EQUATOR_QUARTER: GeodesyGolden = {
  name: 'equator 0° → 90°E',
  from: [0, 0],
  to: [90, 0],
  // A quarter of the great circle: π/2 · R.
  distanceM: (Math.PI / 2) * 6_371_000,
  initialBearingDeg: 90,
  midpoint: [45, 0],
};

/**
 * Antimeridian crossing, eastbound: 179°E → 179°W is 2° of longitude, and the
 * short arc runs THROUGH 180, not back through Greenwich.
 */
export const SEAM_EASTBOUND: GeodesyGolden = {
  name: 'seam 179E → 179W',
  from: [179, 0],
  to: [-179, 0],
  // 2° of equator: 2 · π/180 · R.
  distanceM: (2 * Math.PI * 6_371_000) / 180,
  initialBearingDeg: 90,
  midpoint: [180, 0],
};

/** Prime meridian, due north — the degenerate case for longitude. */
export const MERIDIAN_NORTH: GeodesyGolden = {
  name: 'meridian 0/0 → 0/45N',
  from: [0, 0],
  to: [0, 45],
  distanceM: (45 * Math.PI * 6_371_000) / 180,
  initialBearingDeg: 0,
  midpoint: [0, 22.5],
};

export const GEODESY_GOLDENS: readonly GeodesyGolden[] = [
  LAX_JFK,
  EQUATOR_QUARTER,
  SEAM_EASTBOUND,
  MERIDIAN_NORTH,
];

/**
 * Cardinal forward-geodesic goldens: start at the equator/prime meridian and
 * travel 1° of arc (π/180 · R metres) on each of the four cardinal bearings.
 * On a sphere these land on exact degree values, which is why this start point
 * was chosen — the expected side is arithmetic, not a lookup.
 */
export const ONE_DEGREE_M = (Math.PI * 6_371_000) / 180;

export const CARDINAL_DESTINATIONS: readonly {
  readonly bearingDeg: number;
  readonly expect: readonly [number, number];
}[] = [
  { bearingDeg: 0, expect: [0, 1] },
  { bearingDeg: 90, expect: [1, 0] },
  { bearingDeg: 180, expect: [0, -1] },
  { bearingDeg: 270, expect: [-1, 0] },
];

/**
 * Pole case: from 0°E 89°N, travelling 2° of arc due north passes OVER the pole
 * and comes down the ANTIMERIDIAN at 89°N. A formula that clamps instead of
 * projecting through the pole lands at 90°N and stops, so this is the case that
 * separates a real forward geodesic from a latitude accumulator.
 *
 * The expected longitude is −180, not +180: the module folds into [-180, 180).
 */
export const OVER_THE_POLE = {
  from: [0, 89] as const,
  bearingDeg: 0,
  distanceM: 2 * ONE_DEGREE_M,
  expect: [-180, 89] as const,
};

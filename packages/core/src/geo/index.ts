// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * `@poopdeck.gl/core/geo` — framework-free geographic projection kernel shared by
 * every CPU-projecting renderer backend (three today; Cesium / WebGL-three next).
 * deck projects on the GPU against a host viewport and does NOT consume this.
 *
 * One exception, deliberately: {@link normalizeViewportBounds} IS consumed by
 * deck. Making a camera-derived box safe for tile selection is a rule about
 * geography, not about any renderer, and all four backends can emit a
 * degenerate box — so it lives here once rather than four times.
 */

export {
  METERS_PER_DEG_LAT,
  EARTH_RADIUS,
  LocalEnuProjection,
  projectPositionsToEnu,
  projectPositions,
  type GeoAnchor,
  type LocalFrame,
  type Projection,
  type ProjectedPositions,
} from './local-enu.js';
export { MercatorProjection, MAX_MERCATOR_LAT } from './mercator.js';
export {
  GlobeProjection,
  type GlobeDatum,
  type GlobeProjectionOptions,
} from './globe.js';
export {
  TILE_SIZE,
  WORLD_CIRCUMFERENCE,
  worldUnitsPerPixel,
  zoomForWorldUnitsPerPixel,
  type ViewState,
} from './view-state.js';
export {
  normalizeViewportBounds,
  boundsFromCorners,
  MAX_SEAM_SPAN_DEG,
  type NormalizedViewportBounds,
  type ViewportBoundsIssue,
} from './viewport-bounds.js';

// ─── Spherical geodesy (distance / bearing / forward geodesic / slerp) ───────
// One sphere radius shared by every function, so a derived velocity is the
// exact inverse of the forward geodesic that consumes it. Consumed by the
// track kernel's motion modes (`render/motion.ts`).
export {
  SPHERE_RADIUS_M,
  wrapLonDeg,
  shortestLonDeltaDeg,
  haversineMeters,
  initialBearingDeg,
  destinationPoint,
  interpolateGreatCircle,
  greatCircleCourseDeg,
  type LonLat,
} from './spherical.js';

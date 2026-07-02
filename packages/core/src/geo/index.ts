// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * `@poopdeck.gl/core/geo` — framework-free geographic projection kernel shared by
 * every CPU-projecting renderer backend (three today; Cesium / WebGL-three next).
 * deck projects on the GPU against a host viewport and does NOT consume this.
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

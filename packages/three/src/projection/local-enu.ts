// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * The ENU projection + the pluggable {@link Projection} contract moved to the
 * framework-free kernel `@poopdeck.gl/core/geo` (see
 * docs/roadmap/renderer-architecture.md). This module stays as a
 * re-export shim so every three importer of `../projection/local-enu` keeps
 * resolving unchanged while the math lives in exactly one place.
 */

export {
  METERS_PER_DEG_LAT,
  EARTH_RADIUS,
  LocalEnuProjection,
  projectPositionsToEnu,
  projectPositions,
} from '@poopdeck.gl/core/geo';
export type {
  GeoAnchor,
  LocalFrame,
  Projection,
  ProjectedPositions,
} from '@poopdeck.gl/core/geo';

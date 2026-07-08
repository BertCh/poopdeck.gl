// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * The pure trip index + head interpolation moved to the framework-free kernel
 * `@poopdeck.gl/core/trips` when the Cesium backend became its third consumer
 * (see docs/roadmap/renderer-abstraction-2026-06.md — CPU logic lives in
 * exactly one place). This module stays as a re-export shim so every three
 * importer of `../lib/trip-heads` keeps resolving unchanged. The default
 * `'f32'` precision keeps the built index byte-identical to the pre-lift
 * three build.
 */

export {
  buildTripIndex,
  sampleHead,
  sampleHeads,
} from '@poopdeck.gl/core/trips';
export type { Trip, TripIndex, Head } from '@poopdeck.gl/core/trips';

// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * Track kernel — RE-EXPORT ONLY.
 *
 * The CPU pool-by-track + per-frame interpolation engine (motion glide, trip
 * heads, AV boxes/meshes) lives in framework-free `@poopdeck.gl/core`
 * (`src/render/track-kernel.ts`), so the maplibre/mapbox, three and Cesium
 * backends run the SAME motion math as deck instead of hand-copying it — this
 * repo's documented CPU-logic-drift failure mode.
 *
 * This module is the deck-side import path: `../../lib/track-kernel.js` and
 * `@poopdeck.gl/core` name the same engine, and only the kernel's color type is
 * spelled differently — core's structural {@link TrackColor} rather than deck's
 * `Color`. The two are structurally identical (RGB/RGBA tuple or byte array),
 * so `Record<string, Color>` props flow into `TrackFieldConfig` uncast.
 *
 * New code should import from `@poopdeck.gl/core` directly.
 */

export {
  buildTrackIndex,
  sampleTrack,
  lerp,
  lerpAngle,
  lerpAngleDeg,
  lerpDim,
  readCategorical,
  resolveColor,
  makePickRow,
  tileLayerKey,
  TrackIndexMaintainer,
  RAD_TO_DEG,
  METERS_PER_DEG_LAT,
  SINGLETON_HOLD_MS,
  DEFAULT_TRACK_COLOR,
} from '@poopdeck.gl/core';

export type {
  Track,
  Sample,
  TrackColor,
  TrackPickRow,
  TrackFieldConfig,
  TrackSampleConfig,
  TrackIndexResult,
} from '@poopdeck.gl/core';

// Motion modes (`TrackSampleConfig.motion`) + the spherical geodesy they rest
// on. Enumerated here for the same reason as everything above: this file's
// contract is that it names EVERY symbol a deck call site reaches the kernel
// through, so a missing re-export fails at the shim rather than in a demo.
export {
  MOTION_MODES,
  resolveMotionConfig,
  deriveMotionState,
  toMps,
  toCompassDeg,
  fromCompassDeg,
  SPHERE_RADIUS_M,
  wrapLonDeg,
  shortestLonDeltaDeg,
  haversineMeters,
  initialBearingDeg,
  destinationPoint,
  interpolateGreatCircle,
  greatCircleCourseDeg,
} from '@poopdeck.gl/core';

export type {
  MotionMode,
  MotionConfig,
  ResolvedMotionConfig,
  MotionState,
  CourseConvention,
  SpeedUnit,
  LonLat,
} from '@poopdeck.gl/core';

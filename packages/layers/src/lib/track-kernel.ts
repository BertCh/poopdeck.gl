// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * Track kernel — RE-EXPORT ONLY.
 *
 * The CPU pool-by-track + per-frame interpolation engine (motion glide, trip
 * heads, AV boxes/meshes) now lives in framework-free `@poopdeck.gl/core`
 * (`src/render/track-kernel.ts`), hoisted there by the maplibre-parity campaign
 * (D7) so the maplibre/mapbox, three and Cesium backends run the SAME motion
 * math as deck instead of hand-copying it — this repo's documented
 * CPU-logic-drift failure mode.
 *
 * This module stays as the deck-side import path so every existing
 * `../../lib/track-kernel.js` import site keeps resolving unchanged. The public
 * surface is byte-identical to the pre-hoist module, with ONE type rename: the
 * kernel's color type is core's structural {@link TrackColor} instead of deck's
 * `Color`. They are structurally identical (RGB/RGBA tuple or byte array), so
 * `Record<string, Color>` props still flow into `TrackFieldConfig` uncast.
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

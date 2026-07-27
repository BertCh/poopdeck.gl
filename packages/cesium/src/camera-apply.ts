// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * The Cesium-runtime half of the camera bridge — isolated from the pure math in
 * `./camera` so node tests can exercise the math without importing Cesium (which
 * expects browser globals). Browser-verify only.
 */

import { Cartesian3, HeadingPitchRange, Matrix4, type Camera } from 'cesium';
import { viewStateToCesiumView, type CesiumViewOptions } from './camera.js';
import type { ViewState } from '@poopdeck.gl/core/geo';

/** Drive a real Cesium `Camera` from a {@link ViewState} (the cross-backend view vocabulary). */
export function applyViewStateToCamera(
  camera: Camera,
  v: ViewState,
  opts: CesiumViewOptions = {},
): void {
  const view = viewStateToCesiumView(v, opts);
  // `lookAt`, not `setView({destination})`. In Cesium `destination` IS the
  // camera position, so passing the view centre there parks the camera on top of
  // the target and aims it at whatever lies `height × tan(pitch)` metres beyond —
  // half a screen to two screens of empty ground on every pitched demo, with the
  // data itself off the bottom edge.
  camera.lookAt(
    Cartesian3.fromDegrees(view.longitude, view.latitude, 0),
    new HeadingPitchRange(view.headingRad, view.pitchRad, view.range),
  );
  // `lookAt` leaves the camera LOCKED to the target's east-north-up frame:
  // `ScreenSpaceCameraController` would then orbit that fixed point instead of
  // flying the globe, and it stays locked until the transform is reset. Resetting
  // to identity keeps the world-space position and orientation `lookAt` just
  // computed and hands the camera back to the normal globe controls.
  camera.lookAtTransform(Matrix4.IDENTITY);
  if (view.rollRad !== 0) {
    // `HeadingPitchRange` has no roll DOF. Re-assert the pose `lookAt` produced
    // (setView with no `destination` keeps the current position) with the roll
    // added, so the 3-DOF camera still honours `ViewState.roll` (§5.5).
    camera.setView({
      orientation: {
        heading: camera.heading,
        pitch: camera.pitch,
        roll: view.rollRad,
      },
    });
  }
}

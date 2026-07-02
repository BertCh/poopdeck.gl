// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * The Cesium-runtime half of the camera bridge — isolated from the pure math in
 * `./camera` so node tests can exercise the math without importing Cesium (which
 * expects browser globals). Browser-verify only.
 */

import { Cartesian3, HeadingPitchRoll, type Camera } from 'cesium';
import { viewStateToCesiumView, type CesiumViewOptions } from './camera';
import type { ViewState } from '@poopdeck.gl/core/geo';

/** Drive a real Cesium `Camera` from a {@link ViewState} (the cross-backend view vocabulary). */
export function applyViewStateToCamera(camera: Camera, v: ViewState, opts: CesiumViewOptions = {}): void {
  const view = viewStateToCesiumView(v, opts);
  camera.setView({
    destination: Cartesian3.fromDegrees(view.longitude, view.latitude, view.height),
    orientation: new HeadingPitchRoll(view.headingRad, view.pitchRad, view.rollRad),
  });
}

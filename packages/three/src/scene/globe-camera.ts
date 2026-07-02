// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Globe camera helpers — the ECEF analogue of `frameBox`.
 *
 * On the globe there is no single world-up: the camera orbits a sphere with a
 * per-position radial up. {@link frameGlobe} parks a whole-earth overview above a
 * lon/lat anchor (the entry view for the globe demos); fine-grained view-state
 * placement lives in `projection/view-state.ts` (`viewStateToCamera` handles the
 * `'globe'` kind). {@link setGlobeClip} sets planet-scale near/far.
 */

import { PerspectiveCamera, Vector3 } from 'three';
import { EARTH_RADIUS } from '../projection/local-enu.js';
import { GlobeProjection } from '../projection/globe.js';

export interface FrameGlobeOptions {
  /** Camera distance from the globe centre, in sphere radii. @default 3 */
  radii?: number;
  /** lon/lat the camera sits above (defaults to the projection anchor). */
  longitude?: number;
  latitude?: number;
}

/**
 * Position a camera for a whole-earth overview looking at the globe centre from
 * above a lon/lat anchor, with that location's north as screen-up. Returns the
 * look target (the globe centre — the orbit target for controls).
 */
export function frameGlobe(
  camera: PerspectiveCamera,
  globe: GlobeProjection,
  opts: FrameGlobeOptions = {},
): Vector3 {
  const longitude = opts.longitude ?? globe.anchor.longitude;
  const latitude = opts.latitude ?? globe.anchor.latitude;
  const radii = opts.radii ?? 3;

  const frame = globe.localFrame(longitude, latitude);
  const up = new Vector3(frame.up[0], frame.up[1], frame.up[2]);
  const north = new Vector3(frame.north[0], frame.north[1], frame.north[2]);

  const target = new Vector3(0, 0, 0); // globe centre
  const distance = globe.radius * radii;
  camera.position.copy(up).multiplyScalar(distance);
  camera.up.copy(north);
  camera.lookAt(target);
  setGlobeClip(camera, distance - globe.radius);
  return target;
}

/** Planet-scale near/far: bracket from just above the near surface to the far limb. */
export function setGlobeClip(
  camera: PerspectiveCamera,
  distanceFromSurface: number,
  radius = EARTH_RADIUS,
): void {
  camera.near = Math.max(1, distanceFromSurface * 0.05);
  camera.far = distanceFromSurface + radius * 2.5;
  camera.updateProjectionMatrix();
}

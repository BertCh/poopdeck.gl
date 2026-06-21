// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

import { Box3, PerspectiveCamera, Vector3, MathUtils } from 'three';

export interface FrameOptions {
  /** Angle above the horizon, degrees. 0 = horizontal, 90 = top-down. @default 55 */
  pitchDeg?: number;
  /** Azimuth around +X(east), degrees, CCW toward +Y(north). @default 20 */
  headingDeg?: number;
  /** Distance multiplier. 1 = tight fit, >1 zooms out. @default 1.4 */
  margin?: number;
  /**
   * Clamp the camera distance (metres). A big AV drive spans hundreds of metres,
   * but fitting the whole thing pushes the camera so far that the centimetre-scale
   * surfels go sub-pixel. Capping keeps a street-level view INTO the cloud.
   */
  minDistance?: number;
  maxDistance?: number;
}

/**
 * Position a Z-up perspective camera to frame a world-space box at a given
 * pitch/heading. Sets `up = (0,0,1)`, distance from the box radius + FOV, and
 * sensible near/far. Returns the box centre (the orbit target for controls).
 */
export function frameBox(
  camera: PerspectiveCamera,
  box: Box3,
  opts: FrameOptions = {},
): Vector3 {
  const center = new Vector3();
  if (box.isEmpty()) {
    camera.up.set(0, 0, 1);
    return center;
  }
  box.getCenter(center);
  const size = box.getSize(new Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 50;
  const margin = opts.margin ?? 1.4;

  const fov = MathUtils.degToRad(camera.fov);
  let dist = (radius / Math.sin(fov / 2)) * margin;
  if (opts.maxDistance !== undefined) dist = Math.min(dist, opts.maxDistance);
  if (opts.minDistance !== undefined) dist = Math.max(dist, opts.minDistance);

  const pitch = MathUtils.degToRad(opts.pitchDeg ?? 55);
  const heading = MathUtils.degToRad(opts.headingDeg ?? 20);
  const horiz = Math.cos(pitch);
  const dir = new Vector3(
    Math.cos(heading) * horiz,
    Math.sin(heading) * horiz,
    Math.sin(pitch),
  );

  camera.up.set(0, 0, 1);
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.lookAt(center);
  camera.near = Math.max(0.1, dist / 1000);
  camera.far = dist * 10 + radius * 4;
  camera.updateProjectionMatrix();
  return center;
}

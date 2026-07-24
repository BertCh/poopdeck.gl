// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Geographic **view state** ⇄ Three `PerspectiveCamera`.
 *
 * The `ViewState` vocabulary + the pure zoom↔ground-resolution helpers now live
 * in the framework-free kernel `@poopdeck.gl/core/geo` (so a future Cesium /
 * WebGL-three camera bridge shares them). The two functions here are the
 * three-specific binding — they touch a Three `PerspectiveCamera` / `Vector3` and
 * therefore stay in this package. See docs/roadmap/renderer-architecture.md.
 *
 * The implementation is projection-agnostic: target placement, the E/N/U basis,
 * and the metric scale all come from the {@link Projection}. Supported kinds:
 * `'mercator'` and `'globe'`.
 */

import { MathUtils, PerspectiveCamera, Vector3 } from 'three';
import {
  EARTH_RADIUS,
  worldUnitsPerPixel,
  zoomForWorldUnitsPerPixel,
  type Projection,
  type ViewState,
} from '@poopdeck.gl/core/geo';

// Re-export the shared view-state vocabulary so `../projection/view-state`
// importers keep a single surface.
export type { ViewState };

export interface ViewStateCameraOptions {
  /** Viewport height in CSS pixels — sets the zoom→distance scale. @default 800 */
  viewportHeight?: number;
}

/** The fully-resolved 2.5D view state `cameraToViewState` reports (no roll/altitude —
 *  a Three MapControls camera has no roll DOF). */
export type ResolvedViewState = Required<
  Pick<ViewState, 'longitude' | 'latitude' | 'zoom' | 'pitch' | 'bearing'>
>;

const RAD2DEG = 180 / Math.PI;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function v3(t: [number, number, number]): Vector3 {
  return new Vector3(t[0], t[1], t[2]);
}

/** Distance from the target so `viewportHeight` px subtend `wupp·viewportHeight`
 *  world units at the target depth, for the camera's vertical FOV. */
function distanceForScale(
  camera: PerspectiveCamera,
  wupp: number,
  viewportHeight: number,
): number {
  const halfFov = MathUtils.degToRad(camera.fov) / 2;
  return (viewportHeight * wupp) / (2 * Math.tan(halfFov));
}

/** Place `camera` at `distance` from `target`, tilted by deck `pitch`/`bearing`
 *  within the local E/N/U frame. Camera "up" is the screen-up tangent
 *  (`fwdH·cos + up·sin`), matching maplibre/deck. */
function orientCamera(
  camera: PerspectiveCamera,
  target: Vector3,
  east: Vector3,
  north: Vector3,
  up: Vector3,
  distance: number,
  pitchDeg: number,
  bearingDeg: number,
): void {
  const pitch = MathUtils.degToRad(pitchDeg);
  const bearing = MathUtils.degToRad(bearingDeg);
  const fwdH = new Vector3()
    .addScaledVector(east, Math.sin(bearing))
    .addScaledVector(north, Math.cos(bearing));
  const offset = new Vector3()
    .addScaledVector(up, Math.cos(pitch))
    .addScaledVector(fwdH, -Math.sin(pitch));
  camera.position.copy(target).addScaledVector(offset, distance);
  camera.up
    .set(0, 0, 0)
    .addScaledVector(fwdH, Math.cos(pitch))
    .addScaledVector(up, Math.sin(pitch));
  camera.lookAt(target);
}

/** Set near/far to bracket the content at this scale (planet-aware on the globe). */
function setClip(
  proj: Projection,
  camera: PerspectiveCamera,
  distance: number,
): void {
  if (proj.kind === 'globe') {
    camera.near = Math.max(1, distance * 0.05);
    camera.far = distance + EARTH_RADIUS * 2.5;
  } else {
    camera.near = Math.max(0.1, distance / 1000);
    camera.far = distance * 6;
  }
  camera.updateProjectionMatrix();
}

/**
 * Drive `camera` from a geographic view state. Returns the world-space look
 * target (the orbit target for controls).
 */
export function viewStateToCamera(
  proj: Projection,
  viewState: ViewState,
  camera: PerspectiveCamera,
  opts: ViewStateCameraOptions = {},
): Vector3 {
  const { longitude, latitude, zoom } = viewState;
  const pitch = viewState.pitch ?? 0;
  const bearing = viewState.bearing ?? 0;
  const viewportHeight = opts.viewportHeight ?? 800;

  const target = v3(proj.project(longitude, latitude, 0));
  const frame = proj.localFrame(longitude, latitude);
  const wupp = worldUnitsPerPixel(proj, zoom, latitude);
  const distance = distanceForScale(camera, wupp, viewportHeight);

  orientCamera(
    camera,
    target,
    v3(frame.east),
    v3(frame.north),
    v3(frame.up),
    distance,
    pitch,
    bearing,
  );
  setClip(proj, camera, distance);
  return target;
}

/** Intersect the camera's forward ray with the ground plane (mercator) or sphere
 *  (globe); fall back to the sub-camera point when the ray misses. */
function recoverTarget(proj: Projection, camera: PerspectiveCamera): Vector3 {
  const forward = new Vector3(0, 0, -1)
    .applyQuaternion(camera.quaternion)
    .normalize();
  const p = camera.position;
  if (proj.kind === 'globe') {
    const b = 2 * p.dot(forward);
    const c = p.lengthSq() - EARTH_RADIUS * EARTH_RADIUS;
    const disc = b * b - 4 * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t1 = (-b - sq) / 2;
      const t2 = (-b + sq) / 2;
      const t = t1 >= 0 ? t1 : t2;
      if (t >= 0) return p.clone().addScaledVector(forward, t);
    }
    return p.clone().setLength(EARTH_RADIUS);
  }
  if (Math.abs(forward.z) < 1e-9) return new Vector3(p.x, p.y, 0);
  const t = -p.z / forward.z;
  return p.clone().addScaledVector(forward, t);
}

/**
 * Recover a geographic view state from `camera` (the inverse of
 * {@link viewStateToCamera}; round-trips to f32 for the same `viewportHeight`).
 */
export function cameraToViewState(
  proj: Projection,
  camera: PerspectiveCamera,
  opts: ViewStateCameraOptions = {},
): ResolvedViewState {
  const viewportHeight = opts.viewportHeight ?? 800;
  const target = recoverTarget(proj, camera);
  const [longitude, latitude] = proj.unproject(target.x, target.y, target.z);
  const distance = camera.position.distanceTo(target);

  const frame = proj.localFrame(longitude, latitude);
  const east = v3(frame.east);
  const north = v3(frame.north);
  const up = v3(frame.up);

  const offsetDir = camera.position.clone().sub(target).normalize();
  const pitch = Math.acos(clamp(offsetDir.dot(up), -1, 1)) * RAD2DEG;

  const camUp = camera.up;
  const horizUp = camUp.clone().addScaledVector(up, -camUp.dot(up));
  let bearing = 0;
  if (horizUp.lengthSq() > 1e-12) {
    const fwdH = horizUp.normalize();
    bearing = Math.atan2(fwdH.dot(east), fwdH.dot(north)) * RAD2DEG;
    if (bearing < 0) bearing += 360;
  }

  const halfFov = MathUtils.degToRad(camera.fov) / 2;
  const wupp = (distance * 2 * Math.tan(halfFov)) / viewportHeight;
  const zoom = zoomForWorldUnitsPerPixel(proj, wupp, latitude);

  return { longitude, latitude, zoom, pitch, bearing };
}

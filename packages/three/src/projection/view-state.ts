// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Shared geographic **view state** ⇄ Three camera.
 *
 * The deck↔three showcase toggle drives both renderers from one
 * `{longitude, latitude, zoom, pitch, bearing}` — the same vocabulary deck's
 * `WebMercatorViewport` / `GlobeViewport` use. These two functions translate that
 * to/from a Three `PerspectiveCamera` so switching renderers keeps the same view,
 * and orbiting the Three camera reports a view state deck can adopt.
 *
 * The implementation is **projection-agnostic**: target placement, the E/N/U
 * basis, and the metric scale all come from the {@link Projection}, so the only
 * per-kind branches are (a) the zoom→ground-resolution formula and (b) recovering
 * the look target (intersect the camera ray with the ground *plane* for mercator,
 * with the *sphere* for the globe). It mirrors deck's mapping: at integer zoom `z`
 * the world is `512·2^z` pixels around, and the camera distance is whatever makes
 * `viewportHeight` px subtend that ground resolution at the target.
 *
 * ENU/AV scenes don't use this — they frame with `frameBox`. Supported kinds:
 * `'mercator'` and `'globe'`.
 */

import { MathUtils, PerspectiveCamera, Vector3 } from 'three';
import { EARTH_RADIUS, type Projection } from './local-enu';

/** deck-compatible geographic view state. */
export interface ViewState {
  longitude: number;
  latitude: number;
  /** Web-Mercator zoom (world is `512·2^zoom` px around). */
  zoom: number;
  /** Tilt from straight-down, degrees. 0 = top-down, →horizon as it grows. @default 0 */
  pitch?: number;
  /** Compass rotation, degrees (0 = north up). @default 0 */
  bearing?: number;
}

export interface ViewStateCameraOptions {
  /** Viewport height in CSS pixels — sets the zoom→distance scale. @default 800 */
  viewportHeight?: number;
}

const TILE_SIZE = 512;
const WORLD_CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * World units spanned by one screen pixel at the view-centre, for a given zoom.
 * Mercator world units are mercator-metres (constant per zoom); globe world units
 * are true metres, so the ground resolution shrinks with `cos(lat)`.
 */
function worldUnitsPerPixel(proj: Projection, zoom: number, latitude: number): number {
  const base =
    proj.kind === 'globe'
      ? WORLD_CIRCUMFERENCE * Math.cos(clamp(latitude, -89, 89) * DEG2RAD)
      : WORLD_CIRCUMFERENCE;
  return base / (TILE_SIZE * Math.pow(2, zoom));
}

function zoomForWorldUnitsPerPixel(proj: Projection, wupp: number, latitude: number): number {
  const base =
    proj.kind === 'globe'
      ? WORLD_CIRCUMFERENCE * Math.cos(clamp(latitude, -89, 89) * DEG2RAD)
      : WORLD_CIRCUMFERENCE;
  return Math.log2(base / (TILE_SIZE * wupp));
}

function v3(t: [number, number, number]): Vector3 {
  return new Vector3(t[0], t[1], t[2]);
}

/** Distance from the target so `viewportHeight` px subtend `wupp·viewportHeight`
 *  world units at the target depth, for the camera's vertical FOV. */
function distanceForScale(camera: PerspectiveCamera, wupp: number, viewportHeight: number): number {
  const halfFov = MathUtils.degToRad(camera.fov) / 2;
  return (viewportHeight * wupp) / (2 * Math.tan(halfFov));
}

/** Place `camera` at `distance` from `target`, tilted by deck `pitch`/`bearing`
 *  within the local E/N/U frame. The camera "up" is the **screen-up tangent**
 *  (`fwdH·cos + up·sin`), NOT the radial — radial-up is parallel to the view
 *  direction at top-down (`pitch=0`) and makes `lookAt` degenerate. This matches
 *  maplibre/deck, where `bearing` rotates which compass direction is up on screen. */
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
  const pitch = MathUtils.degToRad(pitchDeg); // 0 = top-down (look straight down)
  const bearing = MathUtils.degToRad(bearingDeg);
  // Compass look direction in the tangent plane (bearing 0 → north, 90 → east).
  const fwdH = new Vector3()
    .addScaledVector(east, Math.sin(bearing))
    .addScaledVector(north, Math.cos(bearing));
  // target → camera offset = up·cos(pitch) − fwdH·sin(pitch).
  const offset = new Vector3()
    .addScaledVector(up, Math.cos(pitch))
    .addScaledVector(fwdH, -Math.sin(pitch));
  camera.position.copy(target).addScaledVector(offset, distance);
  // Screen-up = fwdH·cos(pitch) + up·sin(pitch): ⟂ to the view dir at every pitch
  // (→ fwdH at top-down so bearing controls roll; → up at the horizon).
  camera.up
    .set(0, 0, 0)
    .addScaledVector(fwdH, Math.cos(pitch))
    .addScaledVector(up, Math.sin(pitch));
  camera.lookAt(target);
}

/** Set near/far to bracket the content at this scale (planet-aware on the globe). */
function setClip(proj: Projection, camera: PerspectiveCamera, distance: number): void {
  if (proj.kind === 'globe') {
    // Camera is `distance` above the surface; bracket from just above it to the
    // far limb of the sphere.
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

  orientCamera(camera, target, v3(frame.east), v3(frame.north), v3(frame.up), distance, pitch, bearing);
  setClip(proj, camera, distance);
  return target;
}

/** Intersect the camera's forward ray with the ground plane (mercator) or sphere
 *  (globe); fall back to the sub-camera point when the ray misses. */
function recoverTarget(proj: Projection, camera: PerspectiveCamera): Vector3 {
  const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  const p = camera.position;
  if (proj.kind === 'globe') {
    // |p + t·f|² = R² → quadratic in t.
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
    return p.clone().setLength(EARTH_RADIUS); // ray misses → nearest surface point
  }
  // Ground plane z = 0.
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
): Required<ViewState> {
  const viewportHeight = opts.viewportHeight ?? 800;
  const target = recoverTarget(proj, camera);
  const [longitude, latitude] = proj.unproject(target.x, target.y, target.z);
  const distance = camera.position.distanceTo(target);

  const frame = proj.localFrame(longitude, latitude);
  const east = v3(frame.east);
  const north = v3(frame.north);
  const up = v3(frame.up);

  // Pitch from the target→camera offset: offset·up = cos(pitch).
  const offsetDir = camera.position.clone().sub(target).normalize();
  const pitch = Math.acos(clamp(offsetDir.dot(up), -1, 1)) * RAD2DEG;

  // Bearing from the screen-up (camera.up): its tangent component is fwdH·cos(pitch),
  // i.e. the compass look direction — robust at top-down (where the offset has no
  // horizontal component but camera.up still encodes bearing). Valid for pitch < 90°.
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

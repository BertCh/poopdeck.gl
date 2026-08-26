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
  distanceForGroundResolution,
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

/**
 * The fully-resolved view state `cameraToViewState` reports.
 *
 * `roll` is included because a Three `PerspectiveCamera` genuinely has the DOF —
 * it is `camera.up` rotated about the view axis. (The 0.5.x note here said "a
 * Three MapControls camera has no roll DOF", which conflated the CONTROLS with
 * the camera: orbit controls never produce roll, but nothing stops a caller
 * driving one, and the shared `ViewState.roll` a Cesium host round-trips through
 * was being silently dropped on the way back.) `altitude` stays out: it is an
 * alternative encoding of `zoom`, not an extra DOF.
 *
 * DEGENERACY: at `pitch === 0` the camera looks straight down, and a rotation
 * about the view axis is indistinguishable from a bearing change. The recovery
 * attributes all of it to `bearing` and reports `roll: 0` — the same choice
 * maplibre and deck make.
 */
export type ResolvedViewState = Required<
  Pick<
    ViewState,
    'longitude' | 'latitude' | 'zoom' | 'pitch' | 'bearing' | 'roll'
  >
>;

const RAD2DEG = 180 / Math.PI;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function v3(t: [number, number, number]): Vector3 {
  return new Vector3(t[0], t[1], t[2]);
}

/** Distance from the target so `viewportHeight` px subtend `wupp·viewportHeight`
 *  world units at the target depth, for the camera's vertical FOV. Thin binding
 *  over the shared kernel conversion the rig's distance clamps also use. */
function distanceForScale(
  camera: PerspectiveCamera,
  wupp: number,
  viewportHeight: number,
): number {
  return distanceForGroundResolution(wupp, viewportHeight, camera.fov);
}

/** Place `camera` at `distance` from `target`, tilted by deck `pitch`/`bearing`
 *  within the local E/N/U frame, then rolled by `rollDeg` about the view axis.
 *  Camera "up" is the screen-up tangent (`fwdH·cos + up·sin`) before the roll,
 *  matching maplibre/deck.
 *
 *  The roll is applied to `camera.up` BEFORE `lookAt`, because `lookAt` builds
 *  the camera basis from `camera.up` — rolling afterwards would be overwritten
 *  on the next `lookAt` and silently lost. */
function orientCamera(
  camera: PerspectiveCamera,
  target: Vector3,
  east: Vector3,
  north: Vector3,
  up: Vector3,
  distance: number,
  pitchDeg: number,
  bearingDeg: number,
  rollDeg: number,
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
  if (rollDeg !== 0) {
    // View axis, target-ward. `offset` points target -> camera, so the forward
    // direction is its negation; rolling about it keeps the camera pointing at
    // the same target and only spins the horizon.
    const viewDir = offset.clone().negate().normalize();
    camera.up.applyAxisAngle(viewDir, MathUtils.degToRad(rollDeg));
  }
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
  const roll = viewState.roll ?? 0;
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
    roll,
  );
  setClip(proj, camera, distance);
  return target;
}

/**
 * World-unit radius of a globe frame's reference surface. `GlobeProjection`
 * carries a settable `radius` (a globe.gl-style unit sphere is radius 100, not
 * 6.37e6), so hard-coding {@link EARTH_RADIUS} would ray-solve against a sphere
 * millions of units away from the one the geometry sits on.
 */
export function surfaceRadius(proj: Projection): number {
  const r = (proj as { radius?: number }).radius;
  return typeof r === 'number' && r > 0 ? r : EARTH_RADIUS;
}

/**
 * Nearest FORWARD (`t > 0`) intersection of the ray `origin + t·dir` with the
 * projection's reference surface — the ground plane `z = 0` on a planar frame
 * (ENU / mercator), the planet sphere on a globe frame — or `null` when the ray
 * never reaches it (aimed above the horizon, parallel to the plane, or past the
 * limb).
 *
 * `dir` MUST be unit length: the globe branch relies on `a = dir·dir = 1` to
 * drop the quadratic's leading coefficient.
 *
 * This is the ONE surface solve in the package. `cameraToViewport` used to carry
 * a second, plane-only copy, which is what made every globe camera report
 * `minLat === maxLat === 0`: on a globe frame the world-space `z = 0` plane is
 * the ECEF equatorial plane THROUGH THE EARTH'S CENTRE, so `unproject` saw
 * `asin(0)` for every corner. See docs/roadmap/tile-loading-3d-2026-07.md RC5.
 */
export function intersectSurface(
  proj: Projection,
  origin: Vector3,
  dir: Vector3,
): Vector3 | null {
  if (proj.kind === 'globe') {
    const radius = surfaceRadius(proj);
    const b = 2 * origin.dot(dir);
    const c = origin.lengthSq() - radius * radius;
    const disc = b * b - 4 * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const t1 = (-b - sq) / 2;
    const t2 = (-b + sq) / 2;
    const t = t1 >= 0 ? t1 : t2;
    if (!(t >= 0)) return null;
    return origin.clone().addScaledVector(dir, t);
  }
  if (Math.abs(dir.z) < 1e-9) return null;
  const t = -origin.z / dir.z;
  // `t <= 0` is the above-horizon case: the plane solve still has an answer, but
  // it lies BEHIND the camera. Returning it is worse than returning nothing —
  // the caller can clip at the horizon, but it cannot detect a plausible-looking
  // point that is actually 180° away.
  if (!Number.isFinite(t) || t <= 0) return null;
  return origin.clone().addScaledVector(dir, t);
}

/**
 * Re-bracket `camera.near`/`far` around its CURRENT distance to the reference
 * surface — the dolly-time counterpart of the one-shot {@link viewStateToCamera}
 * framing, and required for the same reason the clamps in `groundControlLimits`
 * are: controls own the camera after the first frame, and nothing else touches
 * the clip planes. Without this a scene framed at zoom z keeps the far plane it
 * was born with (`6·distance`), so wheeling out ~2.6 levels pushes the ground —
 * data and all — behind `far` and the viewport empties out while the basemap
 * underneath carries on. Cheap: one ray-surface solve per frame.
 *
 * No-op when the camera distance is degenerate (a camera sitting exactly on the
 * surface), so a bad frame cannot write a zero/NaN projection matrix.
 */
export function updateCameraClip(
  proj: Projection,
  camera: PerspectiveCamera,
): void {
  const target = recoverTarget(proj, camera);
  const distance = camera.position.distanceTo(target);
  if (!Number.isFinite(distance) || distance <= 0) return;
  setClip(proj, camera, distance);
}

/** Intersect the camera's forward ray with the ground plane (mercator) or sphere
 *  (globe); fall back to the sub-camera point when the ray misses. */
function recoverTarget(proj: Projection, camera: PerspectiveCamera): Vector3 {
  const forward = new Vector3(0, 0, -1)
    .applyQuaternion(camera.quaternion)
    .normalize();
  const p = camera.position;
  const hit = intersectSurface(proj, p, forward);
  if (hit) return hit;
  return proj.kind === 'globe'
    ? p.clone().setLength(surfaceRadius(proj))
    : new Vector3(p.x, p.y, 0);
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

  // Bearing comes from the camera's POSITION, not from `camera.up`, because the
  // position is roll-independent: `offset = up·cos(pitch) − fwdH·sin(pitch)`, so
  // the horizontal part of `offsetDir` is `−sin(pitch)·fwdH` whatever the roll.
  // Reading it off `camera.up` (as this did before roll existed) folds the roll
  // into the bearing and loses both. With `roll === 0` the two agree exactly, so
  // this is not a behaviour change for an unrolled camera.
  const horizOffset = offsetDir.clone().addScaledVector(up, -offsetDir.dot(up));
  const camUp = camera.up;
  const horizUp = camUp.clone().addScaledVector(up, -camUp.dot(up));

  let bearing = 0;
  let fwdH: Vector3 | null = null;
  if (horizOffset.lengthSq() > 1e-12) {
    fwdH = horizOffset.normalize().negate();
  } else if (horizUp.lengthSq() > 1e-12) {
    // pitch ≈ 0: the camera looks straight down and its position carries no
    // horizontal information. A spin about the view axis is then indivisibly a
    // bearing change and a roll; attribute all of it to bearing (roll stays 0),
    // matching maplibre and deck.
    fwdH = horizUp.clone().normalize();
  }
  if (fwdH) {
    bearing = Math.atan2(fwdH.dot(east), fwdH.dot(north)) * RAD2DEG;
    if (bearing < 0) bearing += 360;
  }

  // Roll = the signed angle from the unrolled screen-up tangent to the camera's
  // actual up, measured about the view axis. Only meaningful once the pitch has
  // given us a roll-independent bearing.
  let roll = 0;
  if (horizOffset.lengthSq() > 1e-12 && fwdH) {
    const pitchRad = MathUtils.degToRad(pitch);
    const refUp = new Vector3()
      .addScaledVector(fwdH, Math.cos(pitchRad))
      .addScaledVector(up, Math.sin(pitchRad));
    const viewDir = offsetDir.clone().negate();
    // Normalize ONCE: atan2's two arguments must be scaled identically, and a
    // caller-supplied `camera.up` is not guaranteed to be unit length.
    const camUpN = camUp.clone().normalize();
    const cross = new Vector3().crossVectors(refUp, camUpN);
    roll = Math.atan2(cross.dot(viewDir), refUp.dot(camUpN)) * RAD2DEG;
    if (Math.abs(roll) < 1e-9) roll = 0;
  }

  const halfFov = MathUtils.degToRad(camera.fov) / 2;
  const wupp = (distance * 2 * Math.tan(halfFov)) / viewportHeight;
  const zoom = zoomForWorldUnitsPerPixel(proj, wupp, latitude);

  return { longitude, latitude, zoom, pitch, bearing, roll };
}

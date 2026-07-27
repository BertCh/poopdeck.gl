// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * ViewState ⇄ Cesium camera bridge — the same `{longitude, latitude, zoom, pitch,
 * bearing, roll}` vocabulary every backend shares, so a deck↔three↔cesium toggle
 * keeps one view. The zoom↔camera-distance math REUSES the framework-free
 * `core/geo` WGS84 globe + `worldUnitsPerPixel` helper (no Cesium dependency), so
 * it is pure + unit-tested here; only {@link applyViewStateToCamera} touches a
 * real Cesium `Camera`. Cesium is a 3-DOF camera, so this is the first consumer
 * of `ViewState.roll` (§5.5).
 *
 * Convention bridge: STT `pitch` is 0 = top-down; Cesium `pitch` is -90 = straight
 * down, 0 = horizon → `cesiumPitch = viewPitch - 90`. `heading = bearing`.
 *
 * `longitude`/`latitude` name the LOOK-AT TARGET — the ground point under the
 * screen centre — exactly as they do for deck and three. That distinction is the
 * whole reason {@link CesiumView} carries a `range` rather than a `destination`:
 * Cesium's `Camera.setView({destination})` places the CAMERA at the coordinate it
 * is given, so feeding it the view centre framed ground half a screen to two
 * screens away from the data on every pitched demo. `HeadingPitchRange` +
 * `Camera.lookAt` is the API whose anchor is the target (see
 * `docs/roadmap/tile-loading-3d-2026-07.md` RC6).
 *
 * DISTANCE CONVENTION — the slant range, not the altitude. deck's view matrix
 * puts the camera a constant `altitude × viewportHeight` pixels from the view
 * centre *along the view axis* for every pitch (`getViewMatrix` translates by
 * `-altitude` and only then rotates by pitch), so its zoom pins the ground scale
 * AT THE CENTRE and the camera's height above the ground falls out as
 * `range × cos(pitch)`. Matching that here is what keeps a deck↔cesium toggle on
 * the same tile zoom; reading a live camera's ALTITUDE as if it were the range is
 * the mirror error, and it under-states the distance to the centre point by
 * `1 / cos(pitch)` — a whole zoom level at pitch 60.
 */

import {
  GlobeProjection,
  worldUnitsPerPixel,
  zoomForWorldUnitsPerPixel,
  type ViewState,
} from '@poopdeck.gl/core/geo';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const DEFAULT_VIEWPORT_HEIGHT = 800;
const DEFAULT_FOV_RAD = 60 * DEG2RAD;

/**
 * Steepest tilt from nadir the range↔altitude conversion will honour, degrees.
 *
 * The conversion is `range = altitude / cos(tilt)`, which diverges as the centre
 * ray approaches the horizon: at tilt 90° the ray never meets the ground and the
 * "distance to the point under the screen centre" is not a number. Clamping at
 * 85° caps the correction at ~11.5× (≈3.5 zoom levels) instead of letting a
 * near-horizontal camera drive the derived zoom to -Infinity, which reaches tile
 * selection as `NaN` after the caller's min/max clamp.
 */
const MAX_TILT_FROM_NADIR_DEG = 85;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * `cos(tilt)` — the factor between the slant range to the screen-centre ground
 * point and the camera's altitude above it — clamped away from zero.
 */
function nadirCos(tiltDeg: number): number {
  return Math.cos(clamp(tiltDeg, 0, MAX_TILT_FROM_NADIR_DEG) * DEG2RAD);
}

// The WGS84 globe drives the zoom↔ground-resolution math (matches Cesium's frame).
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

export interface CesiumViewOptions {
  /** Viewport height in CSS px — sets the zoom↔camera-distance scale. @default 800 */
  viewportHeight?: number;
  /**
   * VERTICAL field-of-view in radians. @default 60°
   *
   * Cesium's `PerspectiveFrustum.fov` is the HORIZONTAL angle on a landscape
   * canvas; pass `frustum.fovy` (or `verticalFovRadians`), never `fov`.
   */
  fovRadians?: number;
}

/**
 * A live Cesium camera, sampled — the input side of {@link cesiumViewToViewState}.
 *
 * Exactly one of `range`/`height` is required. A camera the renderer reads back
 * reports `positionCartographic.height` (an ALTITUDE) and nothing else, so
 * `height` is the ordinary case and the tilt correction happens here rather than
 * at every call site.
 */
export interface CesiumCameraSample {
  /** Degrees. The look-at target for {@link CesiumView}; whatever the caller sampled otherwise. */
  longitude: number;
  latitude: number;
  /**
   * Distance from the camera to the ground point under the screen centre,
   * metres. Preferred over `height` when present: it needs no tilt correction.
   */
  range?: number;
  /**
   * Camera altitude above the reference surface, metres — what a live Cesium
   * camera reports (`positionCartographic.height`). Converted to the slant range
   * with the tilt implied by `pitchRad` before the zoom solve.
   */
  height?: number;
  headingRad: number;
  pitchRad: number;
  rollRad?: number;
}

/**
 * Cesium camera placement derived from a {@link ViewState} (angles in radians).
 *
 * `longitude`/`latitude` are the LOOK-AT TARGET, and `range` the distance to it —
 * i.e. the argument list of `Camera.lookAt(target, HeadingPitchRange)`. They are
 * NOT a `setView({destination})` position; see the module comment.
 */
export interface CesiumView extends CesiumCameraSample {
  /** Distance from the camera to the target, metres (`HeadingPitchRange.range`). */
  range: number;
  /** Camera altitude above the target's tangent plane, metres — `range × cos(pitch)`. */
  height: number;
  rollRad: number;
}

/** Fully-resolved view state (every field present), the inverse's return shape. */
export type ResolvedViewState = Required<
  Pick<
    ViewState,
    'longitude' | 'latitude' | 'zoom' | 'pitch' | 'bearing' | 'roll'
  >
>;

/** ViewState → Cesium camera placement. Pure (no Cesium runtime). */
export function viewStateToCesiumView(
  v: ViewState,
  opts: CesiumViewOptions = {},
): CesiumView {
  const viewportHeight = opts.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT;
  const fov = opts.fovRadians ?? DEFAULT_FOV_RAD;
  const tilt = v.pitch ?? 0;
  const wupp = worldUnitsPerPixel(GLOBE, v.zoom, v.latitude);
  // Distance at which one CSS pixel at the screen centre covers `wupp` metres.
  // Measured along the view axis (the slant range), which is what makes it
  // independent of pitch — see the DISTANCE CONVENTION note above.
  //
  // WHICH WAY THE TILT CORRECTION MOVES THE PICTURE — read this before the
  // browser check, because the review that landed it reported the sign
  // BACKWARDS and a visual verifier expecting the opposite would sign off on a
  // regression.
  //
  // `range = altitude / cos(tilt)` is always LONGER than the altitude, so the
  // ground under the screen centre is FURTHER away than the ground under the
  // camera, so one pixel there covers MORE metres, so the zoom that pins that
  // ground scale is LOWER. Selection zoom moves by `log2(cos tilt)`:
  //
  //     pitch 30 → −0.21   pitch 45 → −0.50   pitch 55 → −0.80
  //     pitch 60 → −1.00   pitch 62 → −1.09   pitch 75 → −1.95
  //
  // At the storm-4d camera (pitch 55) the derived zoom drops by 0.80 levels, so
  // after the floor the tileset asks for z8 where it used to ask for z9 about
  // four frames in five. EXPECT LESS DETAIL, NOT MORE: coarser tiles, larger
  // features, fewer of them — and correctly so, because the previous behaviour
  // read the camera's ALTITUDE as if it were the distance to the screen centre
  // and bought detail the camera had not earned.
  //
  // Caveat for whoever holds the stopwatch: that is the tilt term ALONE, and it
  // is the only one of the four that lives in this file. The same wave changed
  // the call site (`examples/showcase/.../CesiumRenderer.tsx`, which used to
  // accept every default here) in three more ways, and they do NOT all point the
  // same way:
  //
  //   tilt correction      −0.80  (this line, at pitch 55)
  //   fovy instead of fov  +0.83 on 16:9, +0.59 on 3:2, +1.00 on 2:1
  //                        (`log2(tan(fov/2) / tan(fovy/2))`)
  //   real canvas height   +log2(H / 800) — +0.17 at 900 px, +0.43 at 1080 px
  //   round → floor        a discretisation, not a shift: 0 or −1 per frame
  //
  // On an ordinary 1600×900 browser viewport at pitch 55 the real-valued zoom
  // therefore nets about −0.80 + 0.83 + 0.17 = +0.20 — i.e. very nearly nothing,
  // and after the floor usually the SAME integer level as before. So on a wide
  // monitor "the tiles look the same as they did" is a PASS, not a null result.
  // The unambiguous fail is the framing, not the resolution: if the data is
  // still pushed toward one edge of a pitched view, RC6 is back.
  const range =
    v.altitude !== undefined
      ? v.altitude / nadirCos(tilt)
      : (wupp * viewportHeight) / (2 * Math.tan(fov / 2));
  return {
    longitude: v.longitude,
    latitude: v.latitude,
    range,
    height: range * nadirCos(tilt),
    headingRad: (v.bearing ?? 0) * DEG2RAD,
    pitchRad: (tilt - 90) * DEG2RAD, // 0 top-down → -90 straight-down
    rollRad: (v.roll ?? 0) * DEG2RAD,
  };
}

/**
 * Cesium camera → ViewState. Pure inverse of {@link viewStateToCesiumView} when
 * handed that function's output (which carries `range`).
 *
 * `longitude`/`latitude` pass through untouched: only `latitude` participates in
 * the zoom solve, and only as the `cos(lat)` ground-resolution factor, so a
 * caller sampling a pitched camera's own position instead of its look-at target
 * shifts the answer by far less than the flooring the caller applies next.
 */
export function cesiumViewToViewState(
  view: CesiumCameraSample,
  opts: CesiumViewOptions = {},
): ResolvedViewState {
  const viewportHeight = opts.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT;
  const fov = opts.fovRadians ?? DEFAULT_FOV_RAD;
  const pitch = view.pitchRad * RAD2DEG + 90;
  // THIS is the line that sets the selection zoom for a live Cesium camera —
  // `resolveCesiumStreamView` floors what comes back. The correction lengthens
  // the distance, which LOWERS the zoom; the exact per-pitch table and the
  // browser-verification note live at the matching site in
  // {@link viewStateToCesiumView}.
  const range =
    view.range !== undefined && Number.isFinite(view.range)
      ? view.range
      : (view.height ?? 0) / nadirCos(pitch);
  const wupp = (range * 2 * Math.tan(fov / 2)) / viewportHeight;
  return {
    longitude: view.longitude,
    latitude: view.latitude,
    zoom: zoomForWorldUnitsPerPixel(GLOBE, wupp, view.latitude),
    pitch,
    bearing: view.headingRad * RAD2DEG,
    roll: (view.rollRad ?? 0) * RAD2DEG,
  };
}

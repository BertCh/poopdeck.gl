// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * The framework-neutral geographic **view state** — the lingua franca for
 * cross-renderer camera sync (deck's `WebMercatorViewport`/`GlobeViewport`
 * vocabulary) — plus the pure zoom↔ground-resolution helpers a camera bridge
 * needs. The three-specific `viewStateToCamera`/`cameraToViewState` (which touch
 * a Three `PerspectiveCamera`) stay in `@poopdeck.gl/three`; they consume this
 * type + these helpers. See docs/roadmap/renderer-architecture.md
 */

import { EARTH_RADIUS, type Projection } from './local-enu.js';

/** deck-compatible geographic view state. */
export interface ViewState {
  longitude: number;
  latitude: number;
  /** Web-Mercator zoom (world is `512·2^zoom` px around). */
  zoom: number;
  /** Tilt from straight-down, degrees. 0 = top-down. @default 0 */
  pitch?: number;
  /** Compass rotation, degrees (0 = north up). @default 0 */
  bearing?: number;
  /**
   * Camera roll about the view axis, degrees. @default 0. Most 2.5D map hosts
   * (deck, maplibre v4) have no roll; a 3D-globe host (Cesium) does. A backend
   * whose camera lacks a roll DOF ignores it — a lossy round-trip to be
   * documented, not silently dropped.
   */
  roll?: number;
  /**
   * Optional camera height/altitude above the reference surface, metres. An
   * alternative to `zoom` for hosts (Cesium) whose camera is height-driven; when
   * both are present the host decides precedence. @default derived from `zoom`.
   */
  altitude?: number;
}

export const TILE_SIZE = 512;
export const WORLD_CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS;
const DEG2RAD = Math.PI / 180;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * World units spanned by one screen pixel at the view-centre, for a given zoom.
 * Mercator world units are mercator-metres (constant per zoom); globe world units
 * are true metres, so the ground resolution shrinks with `cos(lat)`.
 */
export function worldUnitsPerPixel(
  proj: Projection,
  zoom: number,
  latitude: number,
): number {
  const base =
    proj.kind === 'globe'
      ? WORLD_CIRCUMFERENCE * Math.cos(clamp(latitude, -89, 89) * DEG2RAD)
      : WORLD_CIRCUMFERENCE;
  return base / (TILE_SIZE * Math.pow(2, zoom));
}

/** Inverse of {@link worldUnitsPerPixel}: the zoom that yields a given ground resolution. */
export function zoomForWorldUnitsPerPixel(
  proj: Projection,
  wupp: number,
  latitude: number,
): number {
  const base =
    proj.kind === 'globe'
      ? WORLD_CIRCUMFERENCE * Math.cos(clamp(latitude, -89, 89) * DEG2RAD)
      : WORLD_CIRCUMFERENCE;
  return Math.log2(base / (TILE_SIZE * wupp));
}

/**
 * Distance from the view target at which `viewportHeight` px subtend
 * `wupp · viewportHeight` world units, for a camera of vertical field-of-view
 * `fovDeg`. The ONE zoom↔camera-distance conversion in the stack: the three
 * camera bridge places/recovers cameras with it, and the flat rig's control
 * clamps derive their `min`/`maxDistance` from it, so a distance clamp and the
 * zoom the basemap is driven with can never disagree about what a zoom means.
 */
export function distanceForGroundResolution(
  wupp: number,
  viewportHeight: number,
  fovDeg: number,
): number {
  return (viewportHeight * wupp) / (2 * Math.tan((fovDeg * DEG2RAD) / 2));
}

/** {@link distanceForGroundResolution} keyed by zoom — the inverse of the zoom
 *  `cameraToViewState` recovers from a camera at this distance. */
export function cameraDistanceForZoom(
  proj: Projection,
  zoom: number,
  latitude: number,
  viewportHeight: number,
  fovDeg: number,
): number {
  return distanceForGroundResolution(
    worldUnitsPerPixel(proj, zoom, latitude),
    viewportHeight,
    fovDeg,
  );
}

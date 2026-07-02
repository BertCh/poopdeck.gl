// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * ViewState ⇄ Cesium camera bridge — the same `{longitude, latitude, zoom, pitch,
 * bearing, roll}` vocabulary every backend shares, so a deck↔three↔cesium toggle
 * keeps one view. The zoom↔camera-height math REUSES the framework-free
 * `core/geo` WGS84 globe + `worldUnitsPerPixel` helper (no Cesium dependency), so
 * it is pure + unit-tested here; only {@link applyViewStateToCamera} touches a
 * real Cesium `Camera`. Cesium is a 3-DOF camera, so this is the first consumer
 * of `ViewState.roll` (§5.5).
 *
 * Convention bridge: STT `pitch` is 0 = top-down; Cesium `pitch` is -90 = straight
 * down, 0 = horizon → `cesiumPitch = viewPitch - 90`. `heading = bearing`.
 */

import { GlobeProjection, worldUnitsPerPixel, zoomForWorldUnitsPerPixel, type ViewState } from '@poopdeck.gl/core/geo';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const DEFAULT_VIEWPORT_HEIGHT = 800;
const DEFAULT_FOV_RAD = 60 * DEG2RAD;

// The WGS84 globe drives the zoom↔ground-resolution math (matches Cesium's frame).
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, { datum: 'wgs84' });

export interface CesiumViewOptions {
  /** Viewport height in CSS px — sets the zoom→height scale. @default 800 */
  viewportHeight?: number;
  /** Vertical field-of-view in radians. @default 60° */
  fovRadians?: number;
}

/** Cesium `Camera.setView` inputs derived from a {@link ViewState} (angles in radians). */
export interface CesiumView {
  longitude: number;
  latitude: number;
  /** Camera altitude above the surface, metres. */
  height: number;
  headingRad: number;
  pitchRad: number;
  rollRad: number;
}

/** Fully-resolved view state (every field present), the inverse's return shape. */
export type ResolvedViewState = Required<Pick<ViewState, 'longitude' | 'latitude' | 'zoom' | 'pitch' | 'bearing' | 'roll'>>;

/** ViewState → Cesium camera params. Pure (no Cesium runtime). */
export function viewStateToCesiumView(v: ViewState, opts: CesiumViewOptions = {}): CesiumView {
  const viewportHeight = opts.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT;
  const fov = opts.fovRadians ?? DEFAULT_FOV_RAD;
  const wupp = worldUnitsPerPixel(GLOBE, v.zoom, v.latitude);
  const distance = (wupp * viewportHeight) / (2 * Math.tan(fov / 2));
  return {
    longitude: v.longitude,
    latitude: v.latitude,
    height: v.altitude ?? distance,
    headingRad: (v.bearing ?? 0) * DEG2RAD,
    pitchRad: ((v.pitch ?? 0) - 90) * DEG2RAD, // 0 top-down → -90 straight-down
    rollRad: (v.roll ?? 0) * DEG2RAD,
  };
}

/** Cesium camera params → ViewState. Pure inverse of {@link viewStateToCesiumView}. */
export function cesiumViewToViewState(view: CesiumView, opts: CesiumViewOptions = {}): ResolvedViewState {
  const viewportHeight = opts.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT;
  const fov = opts.fovRadians ?? DEFAULT_FOV_RAD;
  const wupp = (view.height * 2 * Math.tan(fov / 2)) / viewportHeight;
  return {
    longitude: view.longitude,
    latitude: view.latitude,
    zoom: zoomForWorldUnitsPerPixel(GLOBE, wupp, view.latitude),
    pitch: view.pitchRad * RAD2DEG + 90,
    bearing: view.headingRad * RAD2DEG,
    roll: view.rollRad * RAD2DEG,
  };
}

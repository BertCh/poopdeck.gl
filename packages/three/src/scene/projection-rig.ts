// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Projection-aware camera-rig decisions — the pure branch logic the r3f
 * `<STTCanvas>` `CameraRig` + its controls consume, factored out of the (react-
 * three-fiber) binding so the projection→rig mapping is unit-testable in node
 * without mounting a Canvas. The Three-touching framing itself stays in
 * `camera.ts` (`frameBox`) / `globe-camera.ts` (`frameGlobe`, `setGlobeClip`).
 *
 * Two rigs:
 *   • **flat** — every planar projection (`LocalEnuProjection`, `MercatorProjection`):
 *     Z-up (`camera.up = (0,0,1)`), `frameBox` to the layer AABB union, `MapControls`.
 *   • **globe** — `GlobeProjection`: `frameGlobe` + `setGlobeClip` (planet-scale
 *     near/far), `OrbitControls` about the earth centre.
 */

import { cameraDistanceForZoom } from '@poopdeck.gl/core/geo';
import {
  LocalEnuProjection,
  type GeoAnchor,
  type Projection,
} from '../projection/local-enu.js';
import { GlobeProjection } from '../projection/globe.js';

/** The camera-rig a projection selects (see the module doc for what each entails). */
export type RigMode = 'flat' | 'globe';

/**
 * Narrow a projection to a {@link GlobeProjection} (the globe-rig branch). Mirrors
 * the `instanceof` check `STTGlobeBasemap` and the atmosphere/3D-tiles frame use, so
 * every globe-vs-flat decision in the package agrees.
 */
export function isGlobeProjection(
  projection: Projection,
): projection is GlobeProjection {
  return projection instanceof GlobeProjection;
}

/** The rig mode for a projection: the globe orbits the earth; every planar
 *  projection (ENU, mercator) uses the flat Z-up ground rig. */
export function rigModeFor(projection: Projection): RigMode {
  return isGlobeProjection(projection) ? 'globe' : 'flat';
}

/**
 * Resolve the `<STTCanvas>` `projection` prop: an explicit `projection` instance
 * wins; otherwise default EXACTLY to `new LocalEnuProjection(anchor)` — the
 * backward-compatible ENU behavior every existing demo relies on. Pure, so the
 * resolution is unit-testable independent of the Canvas.
 */
export function resolveCanvasProjection(
  projection: Projection | undefined,
  anchor: GeoAnchor,
): Projection {
  return projection ?? new LocalEnuProjection(anchor);
}

/**
 * `OrbitControls` distance clamp for a globe scene, in the globe's world units:
 * from just above the surface (no clipping through the planet) out to a
 * comfortable whole-earth zoom-out. Scales with `globe.radius`, so a metric earth
 * and a globe.gl-style unit sphere both clamp sensibly.
 */
export function globeControlLimits(globe: GlobeProjection): {
  minDistance: number;
  maxDistance: number;
} {
  return { minDistance: globe.radius * 1.02, maxDistance: globe.radius * 8 };
}

/**
 * Steepest tilt the flat ground rig allows, in degrees from straight-down —
 * deck/maplibre `pitch`, and `OrbitControls`' polar angle measured from
 * `camera.up` (which the flat rig pins to `+Z`).
 *
 * `MapControls` defaults `maxPolarAngle` to `π`, so a right-drag can swing the
 * camera THROUGH the ground plane and out the other side. Past 90° every
 * camera→ground ray points at sky: the surface solve has no forward hit, the
 * horizon clip has no ground to clip to, and `cameraToViewport` can only report
 * "no usable viewport" — the scene freezes on its last tile selection while the
 * user is still dragging. 85° keeps the last five degrees of tilt legal and
 * costs nothing a map camera wants.
 */
export const MAX_GROUND_PITCH_DEG = 85;

/**
 * Furthest-OUT web-mercator zoom the flat rig allows. `0` is not a taste call —
 * it is where every basemap host stops: maplibre/mapbox `minZoom` defaults to 0
 * and deck's `MapState` clamps there too, so a camera that dollies past it keeps
 * shrinking the DATA while the basemap underneath is frozen at its own floor,
 * and the two silently drift apart (the `BasemapOverlay.sync` `jumpTo` is
 * clamped host-side, without complaint). Clamping the camera at the same floor
 * keeps the two canvases locked at every scale.
 */
export const MIN_MERCATOR_ZOOM = 0;

/**
 * Closest-IN web-mercator zoom the flat rig allows — deck's `MapState` ceiling,
 * and comfortably inside maplibre's own 22, so the basemap never clamps first on
 * the zoom-in side either.
 */
export const MAX_MERCATOR_ZOOM = 20;

/** Inputs the flat rig's distance clamps derive from (all four are needed —
 *  without a projection/viewport/FOV there is no zoom↔distance mapping). */
export interface GroundControlLimitOptions {
  /** The scene projection. Distance clamps apply to `'mercator'` scenes ONLY —
   *  a metric ENU/AV scene has no slippy-map zoom to clamp against. */
  projection?: Projection;
  /** Viewport height in CSS px (the zoom→distance scale). */
  viewportHeight?: number;
  /** Camera vertical field-of-view, degrees. */
  fovDeg?: number;
  /** Override the zoom-out floor. @default {@link MIN_MERCATOR_ZOOM} */
  minZoom?: number;
  /** Override the zoom-in ceiling. @default {@link MAX_MERCATOR_ZOOM} */
  maxZoom?: number;
}

/**
 * `MapControls` limits for the flat ground rig (the `globeControlLimits` twin):
 * the polar (tilt) clamp always, plus — on a mercator scene — the dolly clamps
 * that hold the camera inside `[minZoom, maxZoom]`. Distances come from the
 * shared `cameraDistanceForZoom`, the exact inverse of the zoom
 * `cameraToViewState` recovers, so "zoom 0" means the same thing to the clamp
 * and to the basemap being driven from that zoom. Higher zoom = nearer camera,
 * hence the crossed assignment.
 */
export function groundControlLimits(opts: GroundControlLimitOptions = {}): {
  maxPolarAngle: number;
  minDistance?: number;
  maxDistance?: number;
} {
  const maxPolarAngle = (MAX_GROUND_PITCH_DEG * Math.PI) / 180;
  const { projection, viewportHeight, fovDeg } = opts;
  if (
    projection?.kind !== 'mercator' ||
    !(viewportHeight !== undefined && viewportHeight > 0) ||
    !(fovDeg !== undefined && fovDeg > 0 && fovDeg < 180)
  ) {
    return { maxPolarAngle };
  }
  const a = opts.minZoom ?? MIN_MERCATOR_ZOOM;
  const b = opts.maxZoom ?? MAX_MERCATOR_ZOOM;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  // Mercator ground resolution is latitude-independent (world units are
  // mercator-metres), so the clamp holds anywhere on the map — pass latitude 0.
  const distance = (zoom: number): number =>
    cameraDistanceForZoom(projection, zoom, 0, viewportHeight, fovDeg);
  return {
    maxPolarAngle,
    minDistance: distance(hi),
    maxDistance: distance(lo),
  };
}

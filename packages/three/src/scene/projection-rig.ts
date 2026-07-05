// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Projection-aware camera-rig decisions — the pure branch logic the r3f
 * `<SttCanvas>` `CameraRig` + its controls consume, factored out of the (react-
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

import { LocalEnuProjection, type GeoAnchor, type Projection } from '../projection/local-enu.js';
import { GlobeProjection } from '../projection/globe.js';

/** The camera-rig a projection selects (see the module doc for what each entails). */
export type RigMode = 'flat' | 'globe';

/**
 * Narrow a projection to a {@link GlobeProjection} (the globe-rig branch). Mirrors
 * the `instanceof` check `SttGlobeBasemap` and the atmosphere/3D-tiles frame use, so
 * every globe-vs-flat decision in the package agrees.
 */
export function isGlobeProjection(projection: Projection): projection is GlobeProjection {
  return projection instanceof GlobeProjection;
}

/** The rig mode for a projection: the globe orbits the earth; every planar
 *  projection (ENU, mercator) uses the flat Z-up ground rig. */
export function rigModeFor(projection: Projection): RigMode {
  return isGlobeProjection(projection) ? 'globe' : 'flat';
}

/**
 * Resolve the `<SttCanvas>` `projection` prop: an explicit `projection` instance
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

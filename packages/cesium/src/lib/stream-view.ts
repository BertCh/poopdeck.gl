// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Live Cesium camera → the `{bounds, zoom}` a `SpatioTemporalTileset` selects
 * against. Pure and Cesium-free (it takes the numbers a `Rectangle` and a
 * `PerspectiveFrustum` hold, not the objects), because everything that has ever
 * gone wrong on this path is arithmetic:
 *
 * - `Camera.computeViewRectangle` returns `Rectangle.MAX_VALUE` when fewer than
 *   two frustum corners hit the ellipsoid, and MAX_VALUE satisfies every
 *   ordering check you would write — it is a well-formed whole-world rectangle,
 *   just not a measurement.
 * - It reports a seam-crossing footprint as `west > east`, which an `east >= west`
 *   guard reads as "unusable" and falls back to the archive's full extent. For a
 *   globally-extensive archive (`ais-all-us` spans -171.58…144.99) that fallback
 *   is millions of candidate cells per level, from a camera looking at one port.
 * - `PerspectiveFrustum.fov` is the HORIZONTAL angle whenever the canvas is wider
 *   than tall, so reading it as the vertical one over-states the half-angle by the
 *   aspect ratio — ~0.8 zoom levels too coarse on 16:9.
 *
 * The final box always goes through `normalizeViewportBounds`
 * (`docs/roadmap/tile-loading-3d-2026-07.md` §4.1) — the one place the seam
 * encoding, latitude ordering and non-finite rejection are decided for every
 * backend.
 */

import { normalizeViewportBounds, type BoundingBox } from '@poopdeck.gl/core';
import {
  cesiumViewToViewState,
  type CesiumCameraSample,
  type CesiumViewOptions,
} from '../camera.js';

const RAD2DEG = 180 / Math.PI;
const HALF_PI = Math.PI / 2;

/**
 * Slack when testing a rectangle against `Rectangle.MAX_VALUE`. Cesium returns a
 * clone of the constant, so exact equality would do; the tolerance also catches a
 * footprint that has grown to the whole world by any other route, which deserves
 * the same treatment.
 */
const WHOLE_WORLD_EPS = 1e-9;

/** The four edges of a Cesium `Rectangle`, radians. */
export interface CameraRectangleRadians {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Does this rectangle cover the entire ellipsoid — i.e. is it `Rectangle.MAX_VALUE`?
 *
 * MAX_VALUE is `computeViewRectangle`'s "I could not measure this" return, not a
 * footprint: it is what comes back when the camera is far enough above the horizon
 * that fewer than two frustum corners intersect the ellipsoid. Treating it as a
 * measurement selects every tile in the world at the view zoom.
 */
export function isWholeWorldRectangle(rect: CameraRectangleRadians): boolean {
  return (
    rect.west <= -Math.PI + WHOLE_WORLD_EPS &&
    rect.east >= Math.PI - WHOLE_WORLD_EPS &&
    rect.south <= -HALF_PI + WHOLE_WORLD_EPS &&
    rect.north >= HALF_PI - WHOLE_WORLD_EPS
  );
}

/**
 * A camera footprint in degrees, or `null` when the rectangle carries no usable
 * measurement (absent, non-finite, or whole-world).
 *
 * `west > east` is passed straight through as `minLon > maxLon`: that IS the
 * antimeridian crossing encoding the core tile scan wants, and
 * `normalizeViewportBounds` is what decides whether a given one is a real
 * crossing or an inversion artefact. Re-ordering it here would either drop the
 * far side of the seam or send the scan the long way around the world.
 */
export function viewRectangleToBounds(
  rect: CameraRectangleRadians | null | undefined,
): BoundingBox | null {
  if (!rect) return null;
  if (
    !Number.isFinite(rect.west) ||
    !Number.isFinite(rect.south) ||
    !Number.isFinite(rect.east) ||
    !Number.isFinite(rect.north)
  ) {
    return null;
  }
  if (isWholeWorldRectangle(rect)) return null;
  return {
    minLon: rect.west * RAD2DEG,
    minLat: rect.south * RAD2DEG,
    maxLon: rect.east * RAD2DEG,
    maxLat: rect.north * RAD2DEG,
  };
}

/**
 * Is this a field-of-view angle a perspective camera could actually have?
 *
 * The open interval `(0, π)` — Cesium's own `PerspectiveFrustum` throws outside
 * it — with 0 explicitly excluded rather than merely "finite". A ZERO fov is the
 * one degenerate value that arrives looking legitimate, and it is fatal:
 * `wupp = range · 2·tan(0) / H` is 0, `zoomForWorldUnitsPerPixel` returns
 * `log2(base / 0)` = Infinity, and {@link resolveCesiumStreamView} converts that
 * to `null` — "keep the previous viewport" (§4.1 rule 1). On the first frame
 * there is no previous viewport, so the tileset is handed nothing, ever: a blank
 * globe with no error, no warning and no way back from inside this module.
 */
function isUsableAngle(a: number | undefined): a is number {
  return typeof a === 'number' && Number.isFinite(a) && a > 0 && a < Math.PI;
}

/**
 * The VERTICAL field of view of a Cesium perspective frustum, radians.
 *
 * Cesium derives `fovy` from `fov` as `aspectRatio <= 1 ? fov : 2·atan(tan(fov/2)/aspectRatio)`
 * — i.e. `fov` is the horizontal angle on a landscape canvas. This mirrors that
 * derivation so a frustum that has not been rendered yet (no `aspectRatio`, hence
 * no `fovy`) still yields the value the first frame will report, rather than
 * silently falling back to a 60° VERTICAL default the renderer never has.
 *
 * Returns `undefined` when neither the frustum nor the canvas can supply a
 * USABLE one — the caller then keeps its own default. Three ways that happens:
 *
 * - an orthographic frustum (2D / Columbus view) has no `fov` at all;
 * - the canvas has not been measured, so there is no aspect ratio;
 * - **the container had zero height when the camera was built.** `Camera`'s
 *   constructor sets `frustum.aspectRatio = drawingBufferWidth / drawingBufferHeight`
 *   straight from the scene, and a flex/grid child measured before layout, a
 *   `display:none` panel or a tab restored in the background is `W × 0`. That
 *   makes `aspectRatio` `Infinity`, and `PerspectiveFrustum.fovy` — a getter that
 *   computes and caches on read — then evaluates `2·atan(tan(fov/2) / Infinity)`
 *   and hands back exactly **0**. Verified against `@cesium/engine` 26. A finite
 *   0 passed the old `Number.isFinite` gate and was returned as a measurement;
 *   see {@link isUsableAngle} for why that blanked the map permanently.
 *
 * A slightly-wrong zoom from the caller's default is a recoverable frame; no
 * selection at all is not.
 */
export function verticalFovRadians(
  frustum:
    | { fovy?: number; fov?: number; aspectRatio?: number }
    | null
    | undefined,
  canvasAspectRatio?: number,
): number | undefined {
  if (isUsableAngle(frustum?.fovy)) return frustum!.fovy;
  const fov = frustum?.fov;
  if (!isUsableAngle(fov)) return undefined;
  const aspect = Number.isFinite(frustum?.aspectRatio)
    ? (frustum as { aspectRatio: number }).aspectRatio
    : canvasAspectRatio;
  // Strictly positive, not merely finite: aspect 0 is the mirror container
  // (`0 × H`), and it makes the `<= 1` branch return the HORIZONTAL fov as if it
  // were vertical — the exact ~0.8-zoom-level error this helper exists to
  // remove, reintroduced under a different degenerate container.
  if (typeof aspect !== 'number' || !Number.isFinite(aspect) || aspect <= 0) {
    return undefined;
  }
  const fovy = aspect <= 1 ? fov : 2 * Math.atan(Math.tan(fov / 2) / aspect);
  return isUsableAngle(fovy) ? fovy : undefined;
}

export interface CesiumStreamViewInput {
  /** `Camera.computeViewRectangle(...)`, radians — `null`/`undefined` when it returned nothing. */
  rect: CameraRectangleRadians | null | undefined;
  /** The live camera, for the zoom solve. */
  camera: CesiumCameraSample;
  /** The archive's declared extent — the fallback when the footprint is unusable. */
  archiveBounds: BoundingBox;
  minZoom: number;
  maxZoom: number;
  /** Globally-extensive datasets opt out of viewport clipping (same as deck's `useGlobalBounds`). */
  useGlobalBounds?: boolean;
  /** Pinned selection zoom; bypasses the camera solve entirely. */
  zoomOverride?: number;
  /** Real canvas height + vertical fov. Defaults (800 px / 60°) are a last resort. */
  view?: CesiumViewOptions;
}

/**
 * Resolve what the tileset should select against, or `null` when the camera
 * produced nothing trustworthy.
 *
 * `null` means KEEP THE PREVIOUS VIEWPORT (§4.1 rule 1). It is not an invitation
 * to substitute a default: selecting against a garbage box is strictly worse than
 * selecting against a slightly stale one.
 *
 * The zoom is FLOORED, matching deck/three/maplibre and the fact that the archive
 * directory is keyed by integer zoom — rounding hands half of every level to the
 * level above, which on a 3-D camera reads as a whole tier of missing detail.
 */
export function resolveCesiumStreamView(
  input: CesiumStreamViewInput,
): { bounds: BoundingBox; zoom: number } | null {
  const measured = input.useGlobalBounds
    ? null
    : viewRectangleToBounds(input.rect);
  const normalized = normalizeViewportBounds(measured ?? input.archiveBounds);
  if (!normalized) return null;

  if (input.zoomOverride !== undefined) {
    return { bounds: normalized.bounds, zoom: input.zoomOverride };
  }
  const { zoom } = cesiumViewToViewState(input.camera, input.view ?? {});
  if (!Number.isFinite(zoom)) return null;
  return {
    bounds: normalized.bounds,
    zoom: Math.min(input.maxZoom, Math.max(input.minZoom, Math.floor(zoom))),
  };
}

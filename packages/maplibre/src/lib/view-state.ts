// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/maplibre contributors

/**
 * `ViewState` ⇄ host-map camera bridge — the maplibre side of the shared
 * cross-renderer camera vocabulary (`@poopdeck.gl/core/geo`'s {@link ViewState}).
 *
 * The maplibre backend does not OWN a camera the way three and cesium do: the
 * host map owns it, and every layer projects through the matrix (or the v5+
 * projection prelude) that camera hands down. So this module is deliberately
 * small — it reads and writes the host's camera in the shared vocabulary so an
 * app driving several backends from one `ViewState` can include this one, and
 * so `ViewState.roll` is honoured rather than silently dropped.
 *
 * ── WHY ROLL NEEDS A BRIDGE AT ALL ───────────────────────────────────────────
 * Roll reaches the SHADERS for free: it is part of the view matrix, and on a
 * v5+ host it is inside the injected projection prelude. Nothing in any layer
 * has to know about it. What was missing is the seam — there was no way to hand
 * this backend a `ViewState` carrying `roll` and have it land on the map, and no
 * way to read one back. `capabilities.cameraRoll` is a claim about that seam.
 *
 * ── THE PEER-RANGE PROBLEM, AND WHY THIS IS DUCK-TYPED ───────────────────────
 * `maplibre-gl` is a peer at `^3 || ^4 || ^5 || ^6` and the package must run
 * against all four majors FROM ONE BUILD. `Map.getRoll()`/`setRoll()` arrived in
 * v5. Naming a v5-only surface in a type import would break the v3/v4 builds, so
 * roll support is detected STRUCTURALLY (`typeof map.getRoll === 'function'`),
 * exactly the way `lib/host-adapter.ts` detects the v5 render-argument shape.
 *
 * A host that cannot roll degrades HONESTLY: {@link applyViewState} reports what
 * it could not apply instead of pretending, and {@link readViewState} omits
 * `roll` rather than reporting a fabricated 0. The shared `ViewState.roll` doc
 * asks for exactly that — "a lossy round-trip to be documented, not silently
 * dropped".
 */

import type { ViewState } from '@poopdeck.gl/core/geo';

/**
 * The slice of a maplibre/mapbox `Map` this bridge touches, structurally typed
 * so no v5-only surface is named in a type position. `getRoll`/`setRoll` are
 * optional because v3/v4 hosts do not have them.
 */
export interface ViewStateHost {
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  getBearing(): number;
  getPitch(): number;
  getRoll?: () => number;
  jumpTo(options: Record<string, unknown>): unknown;
  setRoll?: (roll: number) => unknown;
}

/** Does this host expose maplibre v5+'s camera roll? */
export function supportsRoll(map: ViewStateHost): boolean {
  return typeof map.getRoll === 'function' && typeof map.setRoll === 'function';
}

/**
 * Read the host camera as a {@link ViewState}.
 *
 * `roll` is present only when the host actually has the DOF — an absent key says
 * "this host has no roll", which is different from `roll: 0` ("this host is
 * level"). A caller mirroring one backend's camera onto another must be able to
 * tell those apart.
 */
export function readViewState(map: ViewStateHost): ViewState {
  const c = map.getCenter();
  const view: ViewState = {
    longitude: c.lng,
    latitude: c.lat,
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
  };
  if (supportsRoll(map)) view.roll = map.getRoll!();
  return view;
}

/** What {@link applyViewState} could not deliver to this host. */
export interface ViewStateApplyResult {
  /**
   * Fields the caller asked for that this host cannot represent. Today the only
   * possible member is `'roll'` (a ≤v4 host); it is a list rather than a boolean
   * so a future degradation does not need a new return shape.
   */
  dropped: readonly 'roll'[];
}

/**
 * Drive the host camera from a {@link ViewState}, and report what was dropped.
 *
 * Uses `jumpTo` (not `easeTo`/`flyTo`): this is a state APPLY, and an animated
 * transition would make the map disagree with the caller's `ViewState` for the
 * duration of the ease — which is precisely the drift a shared camera
 * vocabulary exists to prevent. A caller who wants an animation should drive the
 * host's own animation API directly.
 *
 * Roll rides `jumpTo` when the host supports it (v5+ accepts it in the camera
 * options), with a `setRoll` fallback for a host that exposes the accessor but
 * ignores the option. Asking a ≤v4 host for a non-zero roll is not an error —
 * it is reported in `dropped` so the caller can decide whether it matters.
 */
export function applyViewState(
  map: ViewStateHost,
  view: ViewState,
): ViewStateApplyResult {
  const opts: Record<string, unknown> = {
    center: [view.longitude, view.latitude],
    zoom: view.zoom,
    pitch: view.pitch ?? 0,
    bearing: view.bearing ?? 0,
  };
  const roll = view.roll ?? 0;
  const canRoll = supportsRoll(map);
  if (canRoll) opts.roll = roll;

  map.jumpTo(opts);

  if (canRoll && map.getRoll!() !== roll) {
    // The host has the accessor but did not honour the camera option (some v5
    // minors only accept roll through the setter). Assert it directly rather
    // than leaving the camera in a state that disagrees with what we returned.
    map.setRoll!(roll);
  }

  // Only a roll the caller actually ASKED for counts as dropped. Reporting a
  // requested 0 on a ≤v4 host would cry wolf on every ordinary 2.5D apply.
  const dropped: 'roll'[] = !canRoll && roll !== 0 ? ['roll'] : [];
  return { dropped };
}

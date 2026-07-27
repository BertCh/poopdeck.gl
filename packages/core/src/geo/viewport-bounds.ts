// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl contributors

/**
 * The ONE place a camera-derived `{minLon, minLat, maxLon, maxLat}` box is made
 * safe to hand to tile selection.
 *
 * Every backend (deck, three, maplibre, cesium) derives its viewport box from a
 * camera by some projection-specific route, and every one of those routes can
 * emit a DEGENERATE box — inverted, non-finite, or wider than the world — for
 * cameras that are perfectly ordinary to a user:
 *
 * - **Rotation.** A box built from two opposite screen corners inverts in
 *   latitude past `bearing > atan2(height, width)` (≈32° on 1440×900). This was
 *   the deck chassis's behaviour until 2026-07-26; see
 *   `docs/roadmap/tile-loading-3d-2026-07.md` §1.
 * - **Pitch.** Once `pitch + fovy/2 > 90` (71.57° at deck's default
 *   `altitude: 1.5`) an unclamped ray/plane solve returns a point BEHIND the
 *   camera, so the box inverts in longitude.
 * - **Globe / ellipsoid.** Cesium's `computeViewRectangle` returns
 *   `Rectangle.MAX_VALUE` when fewer than two corners hit the ellipsoid.
 *
 * The consequences downstream are not graceful degradation — they are silent
 * and total:
 *
 * - An inverted LATITUDE box makes `boundsToTiles`' `for (y = minY; y <= maxY)`
 *   loop body never execute: **zero tiles**, while `getBufferedRunway` reports
 *   `complete: true` and `isLoaded` reports settled. The map is blank and every
 *   readiness signal says it is fine.
 * - An inverted LONGITUDE box is indistinguishable from the deliberate
 *   antimeridian CROSSING encoding, so `tileXSpanForLonRange` walks the long way
 *   around the world: 510 of 512 columns at z9.
 *
 * So the repair happens once, here, rather than four times in four backends
 * that would drift. Producers call {@link normalizeViewportBounds} and honour
 * `null` by KEEPING THEIR PREVIOUS VIEWPORT — selecting against garbage is
 * strictly worse than selecting against a slightly stale box.
 */

import type { BoundingBox } from '../types.js';
import { MAX_MERCATOR_LAT } from './mercator.js';

/**
 * Widest implied span, in degrees, that a `minLon > maxLon` box may claim before
 * we stop believing it is an antimeridian crossing.
 *
 * `minLon > maxLon` is a legitimate, load-bearing encoding in this codebase: it
 * means "the span runs east through +180". But it is also EXACTLY what a
 * pitch-inverted box looks like, and the two are not distinguishable from the
 * pair alone — only from the implied width. A real seam-crossing viewport is a
 * viewport: it spans a few degrees, maybe a few tens. A box that claims to cross
 * the seam AND wrap 350°+ of the planet is an artefact of an above-horizon
 * unproject, not a camera.
 *
 * 350° leaves genuine near-global crossing views (a fully zoomed-out globe that
 * happens to straddle the seam) on the believed side, while catching the
 * inversion cases, which in practice imply 355°–359.9°.
 */
export const MAX_SEAM_SPAN_DEG = 350;

/** A repair {@link normalizeViewportBounds} applied, for diagnostics and tests. */
export type ViewportBoundsIssue =
  | 'inverted-lat'
  | 'inverted-lon'
  | 'clamped-lat'
  | 'full-world';

export interface NormalizedViewportBounds {
  bounds: BoundingBox;
  /** Empty when the box arrived already well-formed. */
  issues: ViewportBoundsIssue[];
}

/**
 * Make a camera-derived box safe for tile selection, or reject it.
 *
 * Returns `null` when the box carries no usable information (any component
 * non-finite) — the caller must keep its previous viewport rather than select
 * against garbage.
 *
 * The rules, in order:
 *
 * 1. **Non-finite** anywhere ⇒ `null`.
 * 2. **Latitude** — swap if inverted, then clamp to ±{@link MAX_MERCATOR_LAT}
 *    (the Web Mercator edge, NOT ±90 — see the clamp's own comment). Latitude is
 *    never a wrapping axis, so an inverted latitude box is ALWAYS an artefact.
 * 3. **Longitude** — `minLon > maxLon` is kept as the antimeridian crossing
 *    encoding only while the implied span is under {@link MAX_SEAM_SPAN_DEG};
 *    a wider claim is an inversion and gets swapped.
 * 4. **Full world** — a span of 360° or more normalises to exactly
 *    `[-180, 180]`.
 *
 * Longitude is otherwise passed through UNWRAPPED and UNCLAMPED, deliberately.
 * `WebMercatorViewport.unproject` reports e.g. `maxLon ≈ 184` for a camera
 * centred at lon 179, and the core tile scan is wrap-aware: it walks unwrapped
 * column space and wraps at emit (`tileXSpanForLonRange`), capping the span at
 * one world width. Re-clamping into `[-180, 180]` here silently DISCARDS the
 * far side of the seam — the right half of the screen for `ais-all-us` and
 * `drifters`. Do not add a clamp.
 */
export function normalizeViewportBounds(
  bounds: BoundingBox,
): NormalizedViewportBounds | null {
  const { minLon, minLat, maxLon, maxLat } = bounds;

  // 1. Non-finite — NaN/Infinity reach here from a degenerate unprojection
  // matrix or a ray/plane solve that divided by a near-zero z component. There
  // is no sane repair: reject and let the caller hold its last good viewport.
  if (
    !Number.isFinite(minLon) ||
    !Number.isFinite(minLat) ||
    !Number.isFinite(maxLon) ||
    !Number.isFinite(maxLat)
  ) {
    return null;
  }

  const issues: ViewportBoundsIssue[] = [];

  // 2. Latitude: order, then clamp. Note the ORDER of these two steps — a box
  // that is both inverted and out of range must be swapped BEFORE clamping, or
  // the clamp bakes the inversion in.
  let lo = minLat;
  let hi = maxLat;
  if (lo > hi) {
    [lo, hi] = [hi, lo];
    issues.push('inverted-lat');
  }
  // Clamp BOTH ends to the representable range. Clamping only the near side of
  // each (`max(lo)` / `min(hi)`) re-inverts a box whose ends are both off the
  // same edge — `{lo: -95, hi: -95}` would become `{lo: -LIMIT, hi: -95}`,
  // handing `boundsToTiles` the exact `minY > maxY` shape this function exists
  // to prevent.
  //
  // The limit is the Web Mercator edge ({@link MAX_MERCATOR_LAT}), NOT ±90.
  // `latToTileY` evaluates `log(tan(rad) + 1 / cos(rad))`, and `tan` and
  // `1 / cos` diverge with OPPOSITE signs as `|lat| → 90`: in the sliver just
  // inside a pole their sum is the difference of two enormous floats,
  // cancellation drives it NEGATIVE, and `Math.log` returns `NaN`. A `NaN` row
  // bound makes `boundsToTiles` enumerate ZERO tiles — a blank map from a camera
  // showing the whole world. Measured at z2, `minLat = -89.99999999998705`
  // yields `yBottom = NaN`; the same box clamped here yields rows 0..3.
  //
  // Perversely, EXACTLY ±90 is safe (the sum overflows cleanly to `Infinity`,
  // which clamps), so the failure window is a hair INSIDE the pole — which is
  // why clamping to ±90 looked correct. Nothing is lost: no tile row exists
  // above this latitude, so a box claiming to reach past it is claiming rows
  // that do not exist.
  const clampedLo = Math.min(MAX_MERCATOR_LAT, Math.max(-MAX_MERCATOR_LAT, lo));
  const clampedHi = Math.min(MAX_MERCATOR_LAT, Math.max(-MAX_MERCATOR_LAT, hi));
  if (clampedLo !== lo || clampedHi !== hi) issues.push('clamped-lat');

  // 3–4. Longitude: distinguish a genuine seam crossing from an inversion, then
  // collapse anything covering the whole world to a single canonical span.
  let west = minLon;
  let east = maxLon;
  if (west > east) {
    // Either the crossing encoding (span runs east through +180) or an
    // inversion. The implied width is what tells them apart.
    const impliedSpan = east - west + 360;
    if (impliedSpan >= MAX_SEAM_SPAN_DEG) {
      [west, east] = [east, west];
      issues.push('inverted-lon');
    }
  }
  if (east - west >= 360) {
    // The camera already sees the whole world; normalise rather than relying on
    // the core-side one-world cap, so the span is exactly one world.
    west = -180;
    east = 180;
    issues.push('full-world');
  }

  return {
    bounds: {
      minLon: west,
      minLat: clampedLo,
      maxLon: east,
      maxLat: clampedHi,
    },
    issues,
  };
}

/**
 * Axis-aligned lon/lat box around N unprojected corner samples.
 *
 * Two corners are NOT enough: the endpoints of one screen diagonal only bound
 * the ground quad when `bearing === 0`. Pass all four (or more, for a curved
 * projection where corners alone under-bound the edges).
 *
 * Longitude is min/maxed in whatever space the caller's unprojection returned —
 * unwrapped inputs give an unwrapped box, which is the contract the core tile
 * scan wants.
 *
 * Non-finite components are skipped PER AXIS, not per corner: a corner with a
 * usable longitude but a diverged latitude still contributes its longitude.
 * That yields the conservative SUPERSET, and over-covering costs a few extra
 * tile fetches where under-covering costs a blank region — the asymmetry this
 * whole module exists to respect. Returns `null` unless BOTH axes got at least
 * one finite sample: a box needs two axes, and a half-finite one would hand
 * `±Infinity` to the tile scan.
 */
export function boundsFromCorners(
  corners: ReadonlyArray<readonly [number, number]>,
): BoundingBox | null {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  let lons = 0;
  let lats = 0;
  for (const [lon, lat] of corners) {
    if (Number.isFinite(lon)) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      lons++;
    }
    if (Number.isFinite(lat)) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      lats++;
    }
  }
  if (lons === 0 || lats === 0) return null;
  return { minLon, minLat, maxLon, maxLat };
}

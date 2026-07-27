// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * How many tile cells a camera-derived viewport box is allowed to enumerate,
 * and the integer-zoom step-down that keeps it under that cap.
 *
 * WHY THIS EXISTS. `docs/roadmap/tile-loading-3d-2026-07.md` §4.4 rules that
 * tile counts RISE once the viewport box is derived from four corners instead
 * of one diagonal, and that the rise must not be "fixed" back — the old
 * footprint was a 36%-coverage under-selection, so the extra tiles are tiles
 * that were always on screen and simply never loaded. That ruling holds, and
 * nothing here weakens it. But it holds at the pitches the audit measured. An
 * axis-aligned box around a strongly pitched frustum is a bad approximation of
 * a trapezoid, and the error is not linear: past roughly pitch 65 the box
 * inflates faster than the frame it is bounding, and at pitch 85 / z8 the
 * measured selection is 832 cells against the ~12 a flat camera at the same
 * zoom selects. Almost all of those are behind the horizon band at the top of
 * the frame, where the ground occupies a handful of screen rows.
 *
 * The right long-term answer is the frustum-quadtree primitive (roadmap Wave 3
 * / A1: `getFrustumPlanes()` + a CullingVolume walk with per-node
 * distance-based zoom), which selects 47 tiles across z5–z8 where the ground
 * AABB selects 754 at z8. Until that lands, an over-wide box is spent as a
 * COARSER ZOOM rather than as hundreds of fetches: dropping one integer zoom
 * quarters the cell count while still covering the whole frame, and on this
 * project's archives every zoom carries every feature (the no-thinning
 * default), so the coarser tile holds the same data at a coarser geometry
 * simplification rather than holding less of it.
 *
 * DELIBERATELY NOT a cap on the returned tile LIST. Truncating an enumeration
 * leaves on-screen tiles unfetched — the blank-region symptom this whole
 * roadmap exists to remove, only now behind a `console.warn` a user never
 * sees. Core's own scan makes the same call (`MAX_QUERY_SCAN_CELLS` warns and
 * still returns every cell). Stepping zoom down keeps the selection COMPLETE;
 * it only makes it cheaper.
 *
 * Framework-free and pure: the caller owns the camera, the previous decision
 * and the archive's zoom range.
 */

import type { BoundingBox } from './types.js';
import { tileXSpanForLonRange, latToTileY } from './archive.js';

/**
 * Cells a viewport may enumerate before the zoom steps down.
 *
 * 256 is ~7× the ~35 cells a flat 1600×900 camera selects at any zoom (tile
 * counts on screen are zoom-invariant — the world doubles with the tile grid),
 * so it is inert for every unpitched or lightly pitched camera and for the
 * `zRange` altitude slab, which widens the box by well under 1%. It engages
 * where the audit measured the blow-up: the four `maxPitch: 85` volumetric
 * demos.
 */
export const DEFAULT_VIEWPORT_CELL_BUDGET = 256;

/**
 * Fraction of the budget the count must fall BELOW before a clamped zoom is
 * released back up. See {@link CellBudgetOptions.hysteresis}.
 */
export const DEFAULT_CELL_BUDGET_HYSTERESIS = 0.25;

export interface CellBudgetOptions {
  /**
   * Never step below this zoom, whatever the count. Pass the archive's
   * `metadata.minZoom`: below it there are no tiles at all, so a step past it
   * trades an expensive frame for a blank one.
   * @default 0
   */
  minZoom?: number;
  /**
   * The cap itself. `Infinity` (or any non-finite / non-positive value)
   * disables the budget and returns the requested zoom untouched.
   * @default {@link DEFAULT_VIEWPORT_CELL_BUDGET}
   */
  maxCells?: number;
  /**
   * Width of the release band, as a fraction of `maxCells`, in `[0, 0.9]`.
   *
   * A pure threshold flaps: a camera parked where the count oscillates around
   * the cap alternates between two zooms every frame, and each flip trips the
   * tileset's `zoom !== lastSpatialZoom` check, which flushes the prefetch
   * runway and re-selects from scratch — so the flapping costs far more than
   * the tiles it was saving. With hysteresis the budget ENGAGES at `maxCells`
   * but only RELEASES once the count at the higher zoom has fallen to
   * `maxCells × (1 - hysteresis)`, which a camera has to actually move to
   * achieve.
   *
   * This is stateless: the caller supplies the previous decision as
   * {@link previousZoom}. Without it the band cannot apply and the function
   * degenerates to the plain threshold.
   * @default {@link DEFAULT_CELL_BUDGET_HYSTERESIS}
   */
  hysteresis?: number;
  /**
   * What this function returned for the previous frame, or `null`/`undefined`
   * on the first. Read for two things and two only: whether the budget clamped
   * last frame (`previousZoom < zoom`), and — when it did — which zoom the
   * release is being measured AGAINST. It is a floor on the release, never a
   * floor on the descent: it can never make the result exceed `zoom`, and it
   * can never hold a zoom that is over the plain cap, so a stale or wrong
   * value costs a coarser zoom for a frame, never a wrong selection.
   */
  previousZoom?: number | null;
}

/**
 * Cells `boundsToTiles` would enumerate for `bounds` at `zoom`.
 *
 * Deliberately built on the SAME two primitives the archive's scan uses —
 * `tileXSpanForLonRange` for the wrap-aware column span and `latToTileY` for
 * the row span, ordered then world-clamped exactly as `boundsToTiles` orders
 * and clamps them. If this predicted a different number from the one the scan
 * goes on to enumerate, the budget would clamp zoom for a cost that is not
 * being paid, or fail to clamp for one that is. The duplication is a handful
 * of lines and it is the point: there is one arithmetic, imported, not two.
 *
 * Non-finite bounds yield `NaN` rather than throwing — the caller
 * ({@link fitZoomToCellBudget}) treats that as "no usable measurement".
 */
export function viewportCellCount(bounds: BoundingBox, zoom: number): number {
  const z = Math.max(0, Math.floor(zoom));
  const n = 1 << z;
  const { count } = tileXSpanForLonRange(bounds.minLon, bounds.maxLon, z);
  // Order before clamping, for the reason `boundsToTiles` does: an inverted
  // latitude box otherwise measures as zero cells and the budget would report
  // a degenerate camera as free.
  const yA = latToTileY(bounds.maxLat, z);
  const yB = latToTileY(bounds.minLat, z);
  const minY = Math.max(0, Math.min(yA, yB));
  const maxY = Math.min(Math.max(yA, yB), n - 1);
  const rows = maxY - minY + 1;
  if (!Number.isFinite(count) || !Number.isFinite(rows)) return NaN;
  return count * Math.max(0, rows);
}

/**
 * Step the integer zoom down until the wrap-aware cell count fits the budget.
 *
 * Never returns above `zoom` and never below `opts.minZoom`; a box that cannot
 * fit even at `minZoom` returns `minZoom` and is selected in full, because the
 * alternative — returning a zoom with no tiles — is a blank map.
 */
export function fitZoomToCellBudget(
  bounds: BoundingBox,
  zoom: number,
  opts: CellBudgetOptions = {},
): number {
  const requested = Math.floor(zoom);
  if (!Number.isFinite(requested)) return zoom;

  const maxCells = opts.maxCells ?? DEFAULT_VIEWPORT_CELL_BUDGET;
  // `Infinity` is the documented kill switch; a zero or negative cap would
  // otherwise mean "always step to minZoom", which is never what a caller
  // means by a budget.
  if (!Number.isFinite(maxCells) || maxCells <= 0) return requested;

  const minZoom = Math.max(0, Math.floor(opts.minZoom ?? 0));
  if (requested <= minZoom) return requested;

  const hysteresis = Math.min(
    0.9,
    Math.max(0, opts.hysteresis ?? DEFAULT_CELL_BUDGET_HYSTERESIS),
  );
  const previous = opts.previousZoom;
  // Engaged = the budget clamped last frame. Only then is a step back UP held
  // to the tighter release threshold; a camera arriving from above is judged
  // on the plain cap so the budget never fires on a count it would tolerate.
  const engaged =
    typeof previous === 'number' &&
    Number.isFinite(previous) &&
    previous < requested;
  // The zoom the release is measured against, floored and clamped the way the
  // descent's rungs are, so `held` is always comparable to `z` as an integer.
  const held = engaged
    ? Math.max(minZoom, Math.floor(previous as number))
    : minZoom;

  // Measured lazily and memoised: the descent and the release scan walk the
  // same rungs, and `viewportCellCount` is the only non-trivial work here.
  const counts = new Map<number, number>();
  const countAt = (level: number): number => {
    const cached = counts.get(level);
    if (cached !== undefined) return cached;
    const cells = viewportCellCount(bounds, level);
    counts.set(level, cells);
    return cells;
  };

  // THE DESCENT IS ALWAYS JUDGED ON THE PLAIN CAP. The band gates the RELEASE
  // of a zoom that is already clamped — it must not deepen the clamp. Applying
  // it to every rung instead ratchets a STATIONARY camera an extra integer
  // zoom down on the frame after the first clamp and never lets it back: at
  // pitch 85 / z8 (counts 832 / 208 / 63) frame 1 correctly answers 7, and
  // then every later frame re-judges those same 208 cells against 0.75 ×
  // budget and answers 6 — a 4× under-use of a budget that was never
  // exceeded, plus the `zoom !== lastSpatialZoom` prefetch-runway flush one
  // frame after the camera settled, which is the exact cost the band exists
  // to avoid.
  let z = requested;
  while (z > minZoom) {
    const cells = countAt(z);
    // A non-finite measurement means the box is garbage. Clamping on it would
    // turn one bad camera frame into a coarse-zoom refetch of the whole
    // screen; the chassis already keeps the previous box in that case.
    if (!Number.isFinite(cells)) return requested;
    if (cells <= maxCells) break;
    z -= 1;
  }

  // Not engaged, or the camera got WORSE (the plain cap wants a zoom at or
  // below the one we were already holding): tightening is immediate and
  // unconditional, exactly as the doc says — the budget engages at `maxCells`.
  if (!engaged || z <= held) return z;

  // RELEASE. `z > held`, so the plain cap would hand resolution back. Give it
  // back only as far as a rung whose count has fallen clear of the band; a
  // count still inside it is the flapping camera, and it stays where it is.
  const release = maxCells * (1 - hysteresis);
  let up = z;
  while (up > held) {
    const cells = countAt(up);
    if (!Number.isFinite(cells)) return requested;
    if (cells <= release) return up;
    up -= 1;
  }
  // Nothing cleared the band. Hold. This is never over budget: `held < z` and
  // the count at `z` already fits the cap, so the count at `held` does too.
  return held;
}

// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl contributors

/**
 * The frustum → quadtree-cut cover primitive: the piece that turns tile
 * selection out of one-integer-zoom-for-the-whole-screen and into a real
 * **per-branch** zoom cut.
 *
 * ## Why this exists
 *
 * Every backend today reduces a 3-D camera to ONE axis-aligned lon/lat box and
 * enumerates it at ONE zoom. That box is a bound on the *horizon*, not on the
 * frame: at pitch 85 / z8 it enumerates **832 cells against the ~12 a flat
 * camera selects at the same zoom** (`docs/roadmap/tile-loading-3d-2026-07.md`
 * §4.4), and the recorded Wave 3/A1 measurement is **47 tiles across z5–z8
 * where the ground AABB returns 754 at z8**. The excess is not detail — it is
 * hundreds of near-horizon tiles that occupy a few screen rows each and would
 * be perfectly served by their grandparents.
 *
 * The fix is the one every 3-D tile engine converges on: walk the tile quadtree
 * from the root, cull each node against the real frustum planes, and stop
 * refining a branch once its tiles are small enough *for their own distance*.
 * The result is a mixed-zoom **antichain** — near-field nodes deep, far-field
 * nodes shallow, every visible cell covered exactly once.
 *
 * ## The contract that outranks the prize
 *
 * **COVERAGE SOUNDNESS.** A selection that misses a tile does not look like an
 * error, it looks like "no data here" — the worst bug class in this codebase.
 * The precedent is direct: the 2026-07-26 bounds audit found tile selection was
 * correct ONLY at `pitch === 0 && bearing === 0`, and shipped 3-D demos were
 * missing **20–44 %** of their data
 * (`docs/roadmap/tile-loading-3d-2026-07.md` §1). So every predicate here
 * resolves toward INCLUSION:
 *
 * - a boundary-ambiguous plane test is INTERSECT, never OUT (see
 *   {@link PLANE_EPSILON});
 * - an AABB test is used, which over-accepts (a box can pass all six halfspaces
 *   without meeting the frustum) and never under-accepts;
 * - the altitude slab is dilated with the node's own **worst-case** Mercator
 *   stretch, and always contains `z = 0`;
 * - anything this function cannot vouch for returns `null`.
 *
 * **`null` is the fail-open signal, not an empty answer.** This function
 * returns either a NON-EMPTY cover or `null`; it never returns `[]` and never
 * throws. `null` means "I cannot produce a cover I can stand behind — use the
 * incumbent path", exactly the discipline {@link normalizeViewportBounds}
 * established for degenerate camera boxes (`viewport-bounds.ts`), and the
 * incumbent path (four-corner AABB → `normalizeViewportBounds` → cell budget)
 * is a strict superset by construction. An empty array, by contrast, would be
 * indistinguishable from a truthful "nothing is on screen", and that is
 * precisely the blank-map symptom — so it is never produced.
 *
 * ## Cover space
 *
 * Core owns ONE space and every chassis converts into it (FS-2). Normalising in
 * the adapter rather than here is deliberate: a convention bug (outward instead
 * of inward normals, deck common space instead of this one) presents as
 * *systematic under-cover*, and the 432-camera oracle that catches it lives
 * next to this file, not inside four renderers.
 *
 * ```text
 *   x  0 at lon −180 → 1 at lon +180, increasing EAST, UNWRAPPED
 *   y  0 at lat +85.0511° → 1 at lat −85.0511°, increasing SOUTH  (tile-row order)
 *   z  up, same scale as x/y: one unit is one world width at the equator
 * ```
 *
 * A tile `(z, x, y)` is exactly `[x/2^z, (x+1)/2^z] × [y/2^z, (y+1)/2^z]`, which
 * is the entire reason for the choice — no projection runs inside the walk, so
 * the near-pole `log(tan + 1/cos)` cancellation that collapsed whole tile rows
 * to zero (`test/polar-tile-row-collapse.test.ts`) is structurally unreachable
 * here: the tree simply stops at ±85.0511°.
 *
 * Longitude is periodic and `x` is not, so the walk runs the root in several
 * world copies and emits `x mod 2^z` — the same wrap-at-emit contract
 * `tileXSpanForLonRange` uses (`archive.ts`).
 *
 * ## What this deliberately is NOT
 *
 * The per-branch zoom is the plan's simple `log2(distance)` SSE approximation,
 * not an exact per-tile screen-space-error solve; the exact form is the
 * follow-on refinement. And this module is INERT until FS-2 consumes it: it is
 * byte-neutral, pure, deterministic, and output-sensitive.
 */

import type { TileId } from '../types.js';
import { MAX_MERCATOR_LAT } from './mercator.js';
import { WORLD_CIRCUMFERENCE } from './view-state.js';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/**
 * One half-space of a view frustum, in {@link coverFrustumQuadtree}'s cover
 * space, with an **INWARD** normal:
 *
 * ```text
 *   p is inside  ⟺  dot(normal, p) + distance >= 0
 * ```
 *
 * The normal need not be unit length — it is normalised on entry, which is also
 * how a zero-length (i.e. meaningless) plane is detected. `normal` is read as
 * `[nx, ny, nz]` from anything indexable, so a tuple, a `number[]` and math.gl's
 * `Vector3` all work without a copy at the call site.
 */
export interface FrustumPlane {
  normal: ArrayLike<number>;
  distance: number;
}

export interface FrustumCoverOptions {
  /** Shallowest zoom the archive serves; no cell coarser than this is emitted. */
  minZoom: number;
  /** Deepest zoom the archive serves; refinement stops here. */
  maxZoom: number;
  /**
   * The camera's zoom, FRACTIONAL. Defined as the zoom whose tiles are
   * correctly sized at {@link FrustumCoverOptions.referenceDistance}; nearer
   * branches resolve finer and farther branches coarser.
   */
  cameraZoom: number;
  /** Camera position in cover space (the same space as the planes). */
  cameraPosition: readonly [number, number, number];
  /**
   * The content's vertical extent in METRES (`zRange` / the A3 altitude slab).
   * Node boxes are dilated to this slab so a tall column whose base is off
   * screen but whose top is on screen still selects its tile. Reversed pairs
   * are ordered; a non-finite pair is ignored (the ground-plane behaviour),
   * matching the `zRange` handling the deck chassis already ships. The slab
   * always contains 0 — base geometry sits on the ground whatever the range says.
   */
  elevationBounds?: readonly [number, number];
  /**
   * Distance from the camera at which {@link FrustumCoverOptions.cameraZoom} is
   * the correct tile zoom — i.e. the camera→focal-plane distance, in cover
   * units. Only the chassis knows the focal length, so only the chassis can
   * supply this exactly; omitted, the camera's height above the ground plane is
   * used, which is exact for a top-down camera. A non-positive or non-finite
   * value degrades to a single uniform zoom rather than to a wrong cut.
   */
  referenceDistance?: number;
  /**
   * Hard ceiling on emitted cells. This is a TRUST GUARD, not a budget: a walk
   * that blows through it is reporting that the plane set does not describe a
   * camera, and the answer is `null` (→ incumbent path), never a truncated cut.
   * Truncating an enumerated cell list is the blank-region symptom class this
   * module exists to remove. @default {@link DEFAULT_MAX_COVER_CELLS}
   */
  maxCells?: number;
}

/**
 * Deepest zoom the walk will address. Well past any real archive (the spec caps
 * tile zoom at 22) and comfortably inside exact float integers for `2^z`.
 */
export const MAX_COVER_ZOOM = 26;

/**
 * Default {@link FrustumCoverOptions.maxCells}. A healthy cut is hundreds of
 * cells — the recorded Wave 3/A1 figure is 47 — so this is ~50× headroom over
 * anything a camera produces, and only a broken plane set can reach it.
 */
export const DEFAULT_MAX_COVER_CELLS = 4096;

/**
 * World copies walked on each side of the camera's own copy.
 *
 * ±1 is what an ordinary antimeridian-straddling camera needs. The extra
 * margin covers wide low-zoom frusta. A frustum that reaches PAST this range
 * wraps the planet several times over; enumerating it copy by copy is both
 * unbounded and pointless, and the incumbent path already has the right answer
 * for it (`normalizeViewportBounds` collapses a ≥360° span to the whole world
 * and the cell budget picks a zoom for it), so this function returns `null`
 * there rather than guess.
 */
export const MAX_WORLD_COPIES = 3;

/**
 * Slack, in cover units, on the "box is entirely outside this plane" test.
 *
 * One cover unit is the equatorial circumference, so this is ≈ 4 mm of ground —
 * eight orders of magnitude above the ~1e-16 rounding error of the dot product,
 * and eight orders of magnitude below the smallest tile the spec allows. Its
 * only job is to make ties resolve as INTERSECT: a node that grazes a plane is
 * kept, because keeping a tile that turns out to be off screen costs one fetch
 * and dropping one that is on screen costs a blank region.
 */
const PLANE_EPSILON = 1e-7;

/** Cover-space x for a longitude. UNWRAPPED: lon 184 → 1.0111, deliberately. */
function lonToCoverX(lon: number): number {
  return (lon + 180) / 360;
}

/** Cover-space y for a latitude, clamped to the Mercator-representable band. */
function latToCoverY(lat: number): number {
  const clamped =
    lat < -MAX_MERCATOR_LAT
      ? -MAX_MERCATOR_LAT
      : lat > MAX_MERCATOR_LAT
        ? MAX_MERCATOR_LAT
        : lat;
  const s = Math.sin(clamped * DEG2RAD);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  // The band edge does not land on 0/1 exactly in floating point — it lands a
  // few ULP outside (−7.8e-16 at +MAX_MERCATOR_LAT), and a y a hair below zero
  // is the shape that produced a NEGATIVE tile row in the incident this module
  // is designed around. The walk itself derives y from integers and is immune,
  // but this helper is public, so it hands back only the closed unit interval.
  return y < 0 ? 0 : y > 1 ? 1 : y;
}

/**
 * Cover-space point for a geographic position, altitude in metres.
 *
 * Exported because the chassis adapter (FS-2) needs exactly this to place the
 * camera in cover space, and because a test that builds its own camera needs
 * the identical mapping — two consumers is the whole reason it is not inlined.
 */
export function lonLatToCoverPoint(
  lon: number,
  lat: number,
  altitudeMeters = 0,
): [number, number, number] {
  const y = latToCoverY(lat);
  return [lonToCoverX(lon), y, altitudeMeters * coverUnitsPerMeterAtY(y)];
}

/** Inverse of {@link lonLatToCoverPoint}'s horizontal half. */
export function coverPointToLonLat(x: number, y: number): [number, number] {
  const u = Math.PI * (1 - 2 * y);
  return [x * 360 - 180, Math.atan(Math.sinh(u)) * RAD2DEG];
}

/**
 * Cover units per ground metre at a cover-space row.
 *
 * Mercator stretches horizontally by `1 / cos(lat)`, and the vertical axis is
 * scaled to match so that vertical and horizontal are locally isotropic (the
 * same convention `MercatorProjection.metersPerWorldUnit` uses). Written as
 * `cosh` rather than `1/cos(atan(sinh(·)))` because `y ↦ cosh(π(1 − 2y))` IS
 * that quantity exactly, with no trig, no inverse trig, and — the part that
 * matters — no divergence: `y` is confined to `[0, 1]`, so the factor is
 * confined to `[1, cosh π]`. There is no pole to divide by zero at.
 */
function coverUnitsPerMeterAtY(y: number): number {
  return Math.cosh(Math.PI * (1 - 2 * y)) / WORLD_CIRCUMFERENCE;
}

/** `true` when the box lies in the positive half-space of EVERY plane. */
function boxPassesPlanes(
  planes: Float64Array,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): boolean {
  for (let i = 0; i < planes.length; i += 4) {
    const nx = planes[i];
    const ny = planes[i + 1];
    const nz = planes[i + 2];
    // The "positive vertex": the box corner farthest along the inward normal.
    // If even that corner is behind the plane the whole box is, and only then.
    const px = nx >= 0 ? x1 : x0;
    const py = ny >= 0 ? y1 : y0;
    const pz = nz >= 0 ? z1 : z0;
    if (nx * px + ny * py + nz * pz + planes[i + 3] < -PLANE_EPSILON) {
      return false;
    }
  }
  return true;
}

/** Euclidean distance from a point to an axis-aligned box; 0 when inside. */
function boxDistance(
  cx: number,
  cy: number,
  cz: number,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): number {
  const dx = cx < x0 ? x0 - cx : cx > x1 ? cx - x1 : 0;
  const dy = cy < y0 ? y0 - cy : cy > y1 ? cy - y1 : 0;
  const dz = cz < z0 ? z0 - cz : cz > z1 ? cz - z1 : 0;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * A quadtree CUT of `(z, x, y)` cells covering everything the frustum can see,
 * or `null`.
 *
 * The walk, per node: dilate to the altitude slab, cull against the plane set
 * (OUT prunes the whole branch, anything else descends), compute the branch's
 * target zoom from its distance to the camera, and emit at the cut —
 * `z >= targetZoom` or `z === maxZoom`.
 *
 * ```text
 *   targetZoom(node) = clamp(round(cameraZoom − log2(dist(node) / refDist)),
 *                            minZoom, maxZoom)
 * ```
 *
 * The rounding is to NEAREST, not `floor`. `floor` on a continuous quantity
 * biases every branch up to a full level too coarse — visibly blurrier tiles —
 * and, concretely, it breaks the degeneracy that makes this primitive safe to
 * adopt: a flat unrotated camera must reduce to exactly the box enumeration at
 * exactly `cameraZoom`, and its own screen corners sit ~1.1× farther than its
 * centre (0.14 of a zoom level), which `floor` would spend as a whole level.
 * Nearest keeps the flat camera exact and still coarsens honestly with
 * distance. Note this is a RESOLUTION choice, not a coverage one: coverage is
 * decided entirely by the plane test, so no rounding rule can drop a cell.
 *
 * Returns:
 * - a NON-EMPTY, deterministic, duplicate-free antichain of cells (`t` is always
 *   `0` — a cover cell is a SPATIAL address; the temporal coordinate belongs to
 *   the consumer), in quadtree pre-order, world copies west to east;
 * - `null` when the inputs are not trustworthy (non-finite planes/camera/zooms,
 *   a degenerate plane, fewer than four half-spaces, a frustum wrapping more
 *   than {@link MAX_WORLD_COPIES} worlds, a walk that blows the cell guard) or
 *   when the cover would be empty.
 *
 * Never throws. Never returns `[]`.
 */
export function coverFrustumQuadtree(
  planes: readonly FrustumPlane[],
  opts: FrustumCoverOptions,
): TileId[] | null {
  // ── 1. The plane set ──────────────────────────────────────────────────────
  // Fewer than four half-spaces cannot bound a view volume in x/y at all, and
  // an unbounded volume sees the whole world at every zoom. Exactly four (the
  // sides, with no near/far) IS accepted: it over-covers — the mirror wedge
  // behind the eye comes along — which is the safe direction, and the cell
  // guard bounds the cost.
  if (!planes || planes.length < 4) return null;
  const P = new Float64Array(planes.length * 4);
  for (let i = 0; i < planes.length; i++) {
    const plane = planes[i];
    const n = plane?.normal;
    if (!n || n.length < 3) return null;
    const nx = n[0];
    const ny = n[1];
    const nz = n[2];
    const d = plane.distance;
    if (
      !Number.isFinite(nx) ||
      !Number.isFinite(ny) ||
      !Number.isFinite(nz) ||
      !Number.isFinite(d)
    ) {
      return null;
    }
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    // A zero-length normal is not a half-space; a non-finite one is not a
    // number. Either way there is nothing to cull against, and guessing is how
    // a convention bug becomes a blank map.
    if (!(len > 0) || !Number.isFinite(len)) return null;
    const o = i * 4;
    P[o] = nx / len;
    P[o + 1] = ny / len;
    P[o + 2] = nz / len;
    P[o + 3] = d / len;
  }

  // ── 2. The camera and the zoom range ──────────────────────────────────────
  const cam = opts.cameraPosition;
  if (!cam || cam.length < 3) return null;
  const cx = cam[0];
  const cy = cam[1];
  const cz = cam[2];
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) {
    return null;
  }
  const cameraZoom = opts.cameraZoom;
  if (
    !Number.isFinite(cameraZoom) ||
    !Number.isFinite(opts.minZoom) ||
    !Number.isFinite(opts.maxZoom)
  ) {
    return null;
  }
  let minZoom = clampZoom(Math.floor(opts.minZoom));
  let maxZoom = clampZoom(Math.floor(opts.maxZoom));
  if (minZoom > maxZoom) [minZoom, maxZoom] = [maxZoom, minZoom];

  // ── 3. The altitude slab ──────────────────────────────────────────────────
  // Ordered, and always straddling 0: `elevationBounds: [1000, 2000]` still has
  // to cover the ground the columns stand on.
  let elevLoM = 0;
  let elevHiM = 0;
  const eb = opts.elevationBounds;
  if (eb && Number.isFinite(eb[0]) && Number.isFinite(eb[1])) {
    elevLoM = Math.min(0, eb[0], eb[1]);
    elevHiM = Math.max(0, eb[0], eb[1]);
  }
  const hasSlab = elevLoM !== 0 || elevHiM !== 0;

  // ── 4. The distance→zoom reference ────────────────────────────────────────
  const refRaw = opts.referenceDistance ?? Math.abs(cz);
  const refDist = Number.isFinite(refRaw) && refRaw > 0 ? refRaw : 0;
  const uniformZoom = clampInt(Math.round(cameraZoom), minZoom, maxZoom);

  const maxCells =
    Number.isFinite(opts.maxCells as number) && (opts.maxCells as number) > 0
      ? Math.floor(opts.maxCells as number)
      : DEFAULT_MAX_COVER_CELLS;
  // Every visited node either prunes in O(1) or is on the path to an emitted
  // cell, so visits stay within a small constant of `maxCells`. The margin is
  // defensive only — tripping it means the same thing as tripping `maxCells`.
  const maxVisits = maxCells * 16 + 4096;

  /** The branch zoom for a node at distance `d`. */
  function targetZoom(d: number): number {
    if (refDist === 0) return uniformZoom;
    // Distance 0 means the camera is inside the node — refine as far as the
    // archive goes; a node containing the eye is never the right cut.
    if (d <= 0) return maxZoom;
    const z = cameraZoom - Math.log2(d / refDist);
    if (!Number.isFinite(z)) return uniformZoom;
    return clampInt(Math.round(z), minZoom, maxZoom);
  }

  /** Whether the world copy `k` of the root can be seen at all. */
  function rootVisible(k: number): boolean {
    const lo = hasSlab ? elevLoM * coverUnitsPerMeterAtY(0) : 0;
    const hi = hasSlab ? elevHiM * coverUnitsPerMeterAtY(0) : 0;
    return boxPassesPlanes(P, k, 0, lo, k + 1, 1, hi);
  }

  // ── 5. World copies ───────────────────────────────────────────────────────
  // The set of copies a convex frustum meets is a contiguous interval, so it is
  // enough to probe one past the cap on each side: if either probe is visible
  // the frustum is wider than this primitive is willing to enumerate.
  const k0 = Math.floor(cx);
  if (
    rootVisible(k0 - MAX_WORLD_COPIES - 1) ||
    rootVisible(k0 + MAX_WORLD_COPIES + 1)
  ) {
    return null;
  }

  // ── 6. The walk ───────────────────────────────────────────────────────────
  const cells: TileId[] = [];
  const seen = new Set<string>();
  let visits = 0;
  let copiesEmitting = 0;
  // Flat DFS stack of (z, x, y) triples. Children are pushed in reverse so they
  // pop row-major, which is what makes the emitted order canonical.
  const stack: number[] = [];

  for (let k = k0 - MAX_WORLD_COPIES; k <= k0 + MAX_WORLD_COPIES; k++) {
    stack.length = 0;
    stack.push(0, k, 0);
    const before = cells.length;
    while (stack.length > 0) {
      const ny = stack.pop() as number;
      const nx = stack.pop() as number;
      const nz = stack.pop() as number;
      if (++visits > maxVisits) return null;

      const size = 1 / 2 ** nz;
      const x0 = nx * size;
      const x1 = x0 + size;
      const y0 = ny * size;
      const y1 = y0 + size;
      let zLo = 0;
      let zHi = 0;
      if (hasSlab) {
        // The node's WORST-CASE stretch: `cosh` grows away from y = 0.5, so the
        // edge farther from the equator bounds the whole node. Over-dilating is
        // the safe direction — it can only add tiles.
        const u =
          Math.PI * Math.max(Math.abs(1 - 2 * y0), Math.abs(1 - 2 * y1));
        const perMeter = Math.cosh(u) / WORLD_CIRCUMFERENCE;
        zLo = elevLoM * perMeter;
        zHi = elevHiM * perMeter;
      }

      if (!boxPassesPlanes(P, x0, y0, zLo, x1, y1, zHi)) continue;

      const d = boxDistance(cx, cy, cz, x0, y0, zLo, x1, y1, zHi);
      if (nz >= targetZoom(d) || nz >= maxZoom) {
        const world = 2 ** nz;
        const wrapped = ((nx % world) + world) % world;
        const key = `${nz}/${wrapped}/${ny}`;
        if (!seen.has(key)) {
          if (cells.length >= maxCells) return null;
          seen.add(key);
          cells.push({ z: nz, x: wrapped, y: ny, t: 0 });
        }
        continue;
      }

      const cxi = nx * 2;
      const cyi = ny * 2;
      const cz2 = nz + 1;
      stack.push(cz2, cxi + 1, cyi + 1);
      stack.push(cz2, cxi, cyi + 1);
      stack.push(cz2, cxi + 1, cyi);
      stack.push(cz2, cxi, cyi);
    }
    if (cells.length > before) copiesEmitting++;
  }

  if (cells.length === 0) return null;
  // One copy emitted ⇒ the cells are the leaves of ONE cut and cannot nest.
  if (copiesEmitting < 2) return cells;

  // ── 7. Antichain reduction ────────────────────────────────────────────────
  // Within one world copy the emitted nodes are leaves of a single cut and can
  // never nest. ACROSS copies they can: the same wrapped column reached at two
  // very different distances gets two different branch zooms. FS-3's delivery
  // contract is "at most one cover per visible cell", and the 2026-07-29
  // double-draw incident is what a violated antichain looks like on screen.
  //
  // The ancestor is kept and the descendant dropped, never the other way round:
  // an ancestor covers everything its descendants do, so dropping downward can
  // only lose resolution, while dropping upward would lose AREA — the blank
  // region again.
  const kept: TileId[] = [];
  for (const cell of cells) {
    let nested = false;
    for (let az = minZoom; az < cell.z; az++) {
      const shift = 2 ** (cell.z - az);
      const ax = Math.floor(cell.x / shift);
      const ay = Math.floor(cell.y / shift);
      if (seen.has(`${az}/${ax}/${ay}`)) {
        nested = true;
        break;
      }
    }
    if (!nested) kept.push(cell);
  }
  return kept;
}

function clampZoom(z: number): number {
  return z < 0 ? 0 : z > MAX_COVER_ZOOM ? MAX_COVER_ZOOM : z;
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return v > 0 ? hi : lo;
  return v < lo ? lo : v > hi ? hi : v;
}

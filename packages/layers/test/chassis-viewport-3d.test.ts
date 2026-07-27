/**
 * `SpatioTemporalLayer` viewport selection ABOVE pitch 0 — the review the
 * four-corner fix never got.
 *
 * The fix (`getViewportBounds` → `_deriveViewportBox` → `viewport.getBounds()`
 * over four corners, then `normalizeViewportBounds`) landed without an
 * independent oracle. `chassis-viewport-bounds.test.ts` covers the pitch ×
 * bearing matrix for INVARIANTS — ordered box, contains the corners, never
 * loses a drawn tile the old box had — and those are the right invariants, but
 * every one of them is a property the implementation could satisfy while still
 * selecting the wrong rectangle. Its ground-truth sampler is also a 21 × 21
 * grid filtered in CLIP space, which is a different oracle from the one the
 * bug lives in.
 *
 * So this file adds the four things that file cannot give:
 *
 *  1. EXACT MEMBERSHIP as a regression pin. The selection at each camera is a
 *     rectangle in tile space (x span × y span — `boundsToTiles` emits a
 *     product), so the whole set is captured by four integers and can be
 *     pinned literally rather than by count or by hash. Regenerated from the
 *     live code, deliberately: these numbers are a PIN, not a proof. Group 2
 *     is the proof.
 *  2. TWO-SIDED agreement with an EXACT ground truth. The visible ground set is
 *     `frustum ∩ z = 0`, and that is a SOLVABLE convex-polygon problem, not a
 *     sampling problem — see {@link visibleGroundTiles}. Both bounds are
 *     asserted: the selection must contain every genuinely drawn tile (a
 *     shrunken selector is a blank band on screen) AND must not exceed the
 *     truth by more than a pinned ratio (an inflated selector is a fetch
 *     storm). A one-sided superset test is passed trivially by "select the
 *     world"; a one-sided count test is passed trivially by "select nothing".
 *
 *     THIS ORACLE REPLACED A SCREEN-GRID SAMPLER, and the replacement was not
 *     cosmetic. The retired 128 × 128 inverse-projection grid resolves only 108
 *     of the 455 tiles the camera actually draws at pitch 85 (24%), because
 *     near the horizon a whole tile row compresses into a few pixel rows. A
 *     selector identical to the shipped one except with `maxLat` pulled down to
 *     that sampler's northernmost row scored ZERO misses against it while
 *     dropping 175 genuinely drawn tiles. That mutant is now a test
 *     (`§2 mutation guard`) and it FAILS, as it must.
 *  3. FIDELITY TO THE RETIRED DERIVATION at pitch 0 — including its CLAMP.
 *     The flat map is every non-3D demo in the fleet, so what changed there has
 *     to be stated exactly rather than asserted away. The comparand here is the
 *     real retired body (`HEAD~:spatiotemporal-layer.ts`, two opposite screen
 *     corners then `Math.max(-180, …)` / `Math.min(180, …)` on all four
 *     components). Transcribing it WITHOUT the clamp — as an earlier revision
 *     of this file did — makes the comparison a tautology: at pitch 0 math.gl's
 *     four-corner `getBounds()` has those two corners as its extrema, so
 *     unclamped equality holds by construction and 108 of the 360 cameras that
 *     genuinely changed report identical. They are enumerated and classified
 *     below.
 *  4. THE ANTIMERIDIAN UNDER PITCH. Unwrapped longitude past ±180 is a
 *     load-bearing contract (`tileXSpanForLonRange` walks unwrapped column
 *     space and wraps at emit); a 3-D camera on the seam is where a stray
 *     clamp or an inversion would first show up as a blank half-screen on
 *     `ais-all-us` / `drifters`.
 *
 * Everything here drives a REAL `WebMercatorViewport`. A hand-rolled unproject
 * stub cannot reproduce the horizon blow-up at all: the far-plane substitution
 * that bounds the box past `halfFov > angleToGround - 0.01` lives inside
 * `@math.gl/web-mercator`'s `getBounds`, and it is what makes pitch 85 cheaper
 * than pitch 70 (see the goldens).
 *
 * VERDICT OF THE STRENGTHENED ORACLE. The shipped selector is a true superset
 * of the exact visible set at every camera here, at pitch 0 it is EXACT (the
 * visible set and nothing else, at all 360 flat cameras), and over a
 * 23,328-camera sweep it PARTIALLY under-selects at exactly zero of them. It
 * over-selects by 1.0×–2.9× under pitch, which is the AABB tax, not a defect.
 *
 * The sweep originally found 24 cameras that select NOTHING, and §6 isolates
 * them: a box whose `minLat` landed in the ULP band just above −90 made the
 * production `latToTileY` return NaN, and `boundsToTiles`' row loop then never
 * ran. That was a pre-existing defect in `packages/core`, not a defect in this
 * fix. It has since been REPAIRED at both ends — `normalizeViewportBounds` and
 * `latToTileY` each clamp to ±`MAX_MERCATOR_LAT` instead of ±90 — and §6 was
 * inverted from pinning the defect to pinning the repair, which is what the
 * block asked its next reader to do. The sweep is now clean at all 23,328
 * cameras.
 *
 * See docs/roadmap/tile-loading-3d-2026-07.md §4.2 and §4.4.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebMercatorViewport } from '@deck.gl/core';
import { SpatioTemporalLayer } from '../src/layers/spatiotemporal-layer';
import { _resetWarnOnce } from '../src/lib/log';
// Deep source import, deliberately: §6 makes a claim about the PRODUCTION
// row-index function, and `latToTileY` is exported from `archive.ts` but not
// re-exported from `@poopdeck.gl/core`'s index. Asserting it through this
// file's local transcription would prove only that the transcription is
// faithful, which is not the claim.
import { latToTileY as coreLatToTileY } from '../../core/src/archive';
import { MAX_MERCATOR_LAT } from '@poopdeck.gl/core/geo';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeLayer(props: Record<string, unknown> = {}, state: any = {}) {
  const layer: any = Object.create((SpatioTemporalLayer as any).prototype);
  layer.props = {
    id: 'stl',
    useGlobalBounds: false,
    zoomOverride: null,
    ...props,
  };
  layer.state = state;
  return layer;
}

/** The demo camera the audit measured: 1600 × 900 over the continental US. */
const WIDTH = 1600;
const HEIGHT = 900;
const LON = -98;
const LAT = 39;
const Z = 8;

function camera(pitch: number, bearing: number, overrides: any = {}) {
  return new WebMercatorViewport({
    id: `c-${pitch}-${bearing}-${overrides.zoom ?? Z}-${overrides.longitude ?? LON}`,
    width: WIDTH,
    height: HEIGHT,
    longitude: LON,
    latitude: LAT,
    zoom: Z,
    pitch,
    bearing,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tile math — a local transcription of `archive.ts`'s PRIVATE `boundsToTiles`
// (and of `tileXSpanForLonRange`'s wrap), so this file measures the selection
// without importing the thing it is measuring. Kept literal, including the
// order-then-clamp on the row span.
// ---------------------------------------------------------------------------

interface Box {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/** Normalized mercator u ∈ [0, 1] west→east; unwrapped outside for lon past ±180. */
function lonToU(lon: number): number {
  return (lon + 180) / 360;
}

/** Normalized mercator v ∈ [0, 1] north→south — the tile-row axis. */
function latToV(lat: number): number {
  const rad = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
}

/** Inverse of {@link latToV}. */
function vToLat(v: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * v))) * 180) / Math.PI;
}

function lonToTileX(lon: number, zoom: number): number {
  return Math.floor(lonToU(lon) * 2 ** zoom);
}

function latToTileY(lat: number, zoom: number): number {
  return Math.floor(latToV(lat) * 2 ** zoom);
}

/** The selection rectangle in tile space: `x…x+w-1` (wrapped) × `y0…y1`. */
function selectionRect(b: Box, zoom: number) {
  const n = 2 ** zoom;
  const west = b.minLon;
  const east = b.maxLon;
  let x: number;
  let w: number;
  if (west <= east && west >= -180 && east <= 180) {
    x = Math.max(0, lonToTileX(west, zoom));
    w = Math.max(0, Math.min(lonToTileX(east, zoom), n - 1) - x + 1);
  } else {
    const first = lonToTileX(west, zoom);
    const last = lonToTileX(east, zoom) + (west > east ? n : 0);
    w = Math.min(n, Math.max(0, last - first + 1));
    x = ((first % n) + n) % n;
  }
  const yA = latToTileY(b.maxLat, zoom);
  const yB = latToTileY(b.minLat, zoom);
  const y0 = Math.max(0, Math.min(yA, yB));
  const y1 = Math.min(Math.max(yA, yB), n - 1);
  return { x, w, y0, y1 };
}

/** The emitted ARRAY, x-major / y-inner — the order `boundsToTiles` returns. */
function selectionArray(b: Box, zoom: number): Array<[number, number]> {
  const n = 2 ** zoom;
  const { x, w, y0, y1 } = selectionRect(b, zoom);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < w; i++) {
    const col = (((x + i) % n) + n) % n;
    for (let y = y0; y <= y1; y++) out.push([col, y]);
  }
  return out;
}

function selectionSet(b: Box, zoom: number): Set<string> {
  return new Set(selectionArray(b, zoom).map(([x, y]) => `${x}/${y}`));
}

function cellCount(b: Box, zoom: number): number {
  const { w, y0, y1 } = selectionRect(b, zoom);
  return w * Math.max(0, y1 - y0 + 1);
}

// ---------------------------------------------------------------------------
// Ground truth — SOLVED, not sampled
// ---------------------------------------------------------------------------

type Pt = [number, number];

/**
 * The affine map between normalized mercator (u, v) and deck's COMMON space.
 *
 * Measured rather than assumed. Deck currently uses a 512-unit world with Y
 * running north-up (so `C` comes back negative against the south-down tile
 * axis), but that is an internal convention and the oracle must not depend on
 * it: three `projectPosition` calls pin the two scales and two offsets, and
 * {@link visibleGroundTiles}'s self-check re-derives `viewport.project` from
 * them, so a convention change surfaces as a failed self-check rather than as
 * silently wrong "truth".
 */
function commonSpaceFit(v: any) {
  const west = v.projectPosition([-180, 0, 0]);
  const origin = v.projectPosition([0, 0, 0]);
  const north = v.projectPosition([0, 60, 0]);
  const A = (origin[0] - west[0]) / (lonToU(0) - lonToU(-180));
  const B = west[0] - A * lonToU(-180);
  const C = (north[1] - origin[1]) / (latToV(60) - latToV(0));
  const D = origin[1] - C * latToV(0);
  return { A, B, C, D };
}

/** Sutherland–Hodgman clip of a convex polygon against `f(p) ≥ 0`. */
function clipHalfPlane(poly: Pt[], f: (p: Pt) => number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % poly.length];
    const fc = f(cur);
    const fn = f(nxt);
    if (fc >= 0) out.push(cur);
    if (fc >= 0 !== fn >= 0) {
      const t = fc / (fc - fn);
      out.push([
        cur[0] + t * (nxt[0] - cur[0]),
        cur[1] + t * (nxt[1] - cur[1]),
      ]);
    }
  }
  return out;
}

/**
 * The EXACT ground quad the camera shows, as a convex polygon in normalized
 * mercator (u, v) — unwrapped in u, so a seam camera yields u past 1.
 *
 * Why this is exact and a screen grid is not. `pixelProjectionMatrix` maps
 * common space to `[px, py, ndcZ]`, and the ground plane is common `z = 0`, so
 * for a ground point `(x, y)` every component is AFFINE in `(x, y)`:
 *
 *     a = m0·x + m4·y + m12      px = a / w
 *     b = m1·x + m5·y + m13      py = b / w
 *     c = m2·x + m6·y + m14   ndcZ = c / w
 *     w = m3·x + m7·y + m15
 *
 * A pixel is drawn iff `0 ≤ px ≤ width`, `0 ≤ py ≤ height` and
 * `-1 ≤ ndcZ ≤ 1`. Multiplying through by `w` turns each of those six clip
 * tests into a LINEAR half-plane in `(x, y)` — and the six of them together
 * force `w > 0` (with `w < 0` the pair `-w ≤ a ≤ w` is unsatisfiable), so the
 * behind-the-camera phantom that the naive `unproject` grid has to filter out
 * cannot even be expressed here. The visible ground set is therefore the
 * intersection of six half-planes: a convex polygon, obtained by clipping and
 * NOT by sampling, which is why it resolves the near-horizon band a screen grid
 * cannot reach at any affordable density.
 *
 * The seed rectangle spans ±600 worlds in u and the full mercator band in v.
 * That is not paranoia: at z2 / pitch 85 the far plane genuinely sits several
 * world-widths away in tile units, and a ±6 seed BOUNDS the answer there —
 * which would quietly turn "exact truth" into "the seed box". {@link
 * visibleGroundTiles} asserts the seed never binds, and that assertion is what
 * caught the ±6 version.
 */
function visibleGroundPolygon(v: any): Pt[] {
  const m = v.pixelProjectionMatrix;
  const { A, B, C, D } = commonSpaceFit(v);
  const row = (i: number) => (p: Pt) =>
    m[i] * p[0] + m[i + 4] * p[1] + m[i + 12];
  const a = row(0);
  const b = row(1);
  const c = row(2);
  const w = row(3);
  // Seed corners at u = −600 / u = +601 and at the two ends of the mercator
  // band (v = 0, v = 1), pushed through the fit. Sorted because `C` is negative
  // under deck's north-up common space.
  const xs = [A * -600 + B, A * 601 + B].sort((p, q) => p - q);
  const ys = [D, C + D].sort((p, q) => p - q);
  let poly: Pt[] = [
    [xs[0], ys[0]],
    [xs[1], ys[0]],
    [xs[1], ys[1]],
    [xs[0], ys[1]],
  ];
  for (const f of [
    (p: Pt) => a(p),
    (p: Pt) => v.width * w(p) - a(p),
    (p: Pt) => b(p),
    (p: Pt) => v.height * w(p) - b(p),
    (p: Pt) => c(p) + w(p),
    (p: Pt) => w(p) - c(p),
  ]) {
    poly = clipHalfPlane(poly, f);
    if (poly.length === 0) return [];
  }
  return poly.map(([x, y]) => [(x - B) / A, (y - D) / C]);
}

/**
 * Every tile the camera genuinely draws at `zoom`: the cells the exact ground
 * polygon overlaps, by scanline over the tile rows.
 *
 * Convex, so the u-extent within one row band is the min/max over the vertices
 * inside the band plus the edge crossings of the band's two horizontal lines.
 */
function visibleGroundTiles(v: any, zoom: number): Set<string> {
  const poly = visibleGroundPolygon(v);
  const out = new Set<string>();
  if (poly.length < 3) return out;
  // The seed rectangle must never be the thing bounding the answer, or the
  // "exact" polygon is just a big box and the ratio pins mean nothing.
  const us = poly.map((p) => p[0]);
  expect(Math.min(...us)).toBeGreaterThan(-599);
  expect(Math.max(...us)).toBeLessThan(600);

  const n = 2 ** zoom;
  const vs = poly.map((p) => p[1]);
  const r0 = Math.max(0, Math.floor(Math.max(0, Math.min(...vs)) * n));
  const r1 = Math.min(
    n - 1,
    Math.floor(Math.min(1, Math.max(...vs)) * n - 1e-12),
  );
  for (let r = r0; r <= r1; r++) {
    const vTop = r / n;
    const vBot = (r + 1) / n;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      if (p[1] >= vTop && p[1] <= vBot) {
        lo = Math.min(lo, p[0]);
        hi = Math.max(hi, p[0]);
      }
      for (const band of [vTop, vBot]) {
        if ((p[1] - band) * (q[1] - band) < 0) {
          const t = (band - p[1]) / (q[1] - p[1]);
          const u = p[0] + t * (q[0] - p[0]);
          lo = Math.min(lo, u);
          hi = Math.max(hi, u);
        }
      }
    }
    if (!Number.isFinite(lo)) continue;
    const c0 = Math.floor(lo * n);
    const c1 = Math.floor(hi * n - 1e-12);
    for (let c = c0; c <= c1; c++) out.add(`${((c % n) + n) % n}/${r}`);
  }
  return out;
}

/**
 * The RETIRED ground-truth sampler, kept only so its blindness can be pinned.
 *
 * For each screen sample, transform the near (`d = 0`) and far (`d = 1`) points
 * through `pixelUnprojectionMatrix` and keep the crossing only while the
 * parameter `t` lands in `[0, 1]`. The clip is genuinely necessary — without it
 * an above-horizon pixel's ray meets the ground BEHIND the camera and
 * `unproject` still returns a finite, plausible-looking lon/lat (§2's phantom
 * test pins that) — but it is not sufficient, because the SAMPLING is what
 * loses the frame: under strong pitch a whole tile row compresses into a couple
 * of pixel rows, so a uniform grid resolves a quarter of what is drawn.
 */
function rayGridTiles(v: any, zoom: number, samples = 128): Set<string> {
  const m = v.pixelUnprojectionMatrix;
  const n = 2 ** zoom;
  const out = new Set<string>();
  for (let i = 0; i < samples; i++) {
    for (let j = 0; j < samples; j++) {
      const px = (v.width * i) / (samples - 1);
      const py = (v.height * j) / (samples - 1);
      // Homogeneous transform + perspective divide, near and far.
      const zNear =
        (m[2] * px + m[6] * py + m[14]) / (m[3] * px + m[7] * py + m[15]);
      const zFar =
        (m[2] * px + m[6] * py + m[10] + m[14]) /
        (m[3] * px + m[7] * py + m[11] + m[15]);
      const t = (0 - zNear) / (zFar - zNear);
      if (!Number.isFinite(t) || t < 0 || t > 1) continue;
      // `unproject` performs this identical lerp; the only thing added above
      // is the clip it omits.
      const p = v.unproject([px, py]);
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      if (Math.abs(p[1]) > 85.05) continue;
      const x = ((lonToTileX(p[0], zoom) % n) + n) % n;
      const y = Math.min(n - 1, Math.max(0, latToTileY(p[1], zoom)));
      out.add(`${x}/${y}`);
    }
  }
  return out;
}

/**
 * The derivation this fix RETIRED, transcribed faithfully from
 * `HEAD~:packages/layers/src/layers/spatiotemporal-layer.ts`: two opposite
 * screen corners, then a clamp on every component.
 *
 * The clamp is the whole point of keeping it. Drop it and the comparison
 * against the four-corner box becomes a tautology at pitch 0 (math.gl's
 * `getBounds` min/maxes four corners whose extrema ARE these two), which is
 * exactly how 108 changed cameras got certified as unchanged.
 */
function retiredBounds(v: any): Box {
  const [minLon, minLat] = v.unproject([0, v.height]);
  const [maxLon, maxLat] = v.unproject([v.width, 0]);
  return {
    minLon: Math.max(-180, minLon),
    minLat: Math.max(-90, minLat),
    maxLon: Math.min(180, maxLon),
    maxLat: Math.min(90, maxLat),
  };
}

/** The same two corners UNCLAMPED — the retired body's input, pre-clamp. */
function rawCornerBounds(v: any): Box {
  const [minLon, minLat] = v.unproject([0, v.height]);
  const [maxLon, maxLat] = v.unproject([v.width, 0]);
  return { minLon, minLat, maxLon, maxLat };
}

const PITCHES = [0, 30, 55, 70, 85];
const BEARINGS = [0, 45, 135, 270];

beforeEach(() => {
  _resetWarnOnce();
});

// ---------------------------------------------------------------------------
// 1. Exact membership — the regression pin
// ---------------------------------------------------------------------------

/**
 * `pitch/bearing` → the exact selection rectangle at z8, 1600 × 900, lon −98 /
 * lat 39. Generated from the live `getViewportBounds`; a diff here means the
 * derivation moved and someone must say why.
 *
 * Read the shape, not just the numbers. Up to pitch 55 the growth is gentle
 * (12 → 49 cells) and is the under-selection repair §4.4 rules must not be
 * tuned back. Then it breaks: pitch 70 costs 1254 cells — HIGHER than pitch
 * 85's 832, because past `halfFov > angleToGround - 0.01` math.gl substitutes
 * far-plane samples for the top corners and the far plane BOUNDS the box that
 * the just-above-horizon top plane does not. That non-monotonicity is why a
 * `maxPitch` cap alone was never going to be the answer, and why the cell
 * budget is measured rather than derived from pitch.
 */
const GOLDEN_RECTS: Record<
  string,
  { x: number; w: number; y0: number; y1: number }
> = {
  '0/0': { x: 56, w: 4, y0: 96, y1: 98 }, //     12 cells
  '0/45': { x: 56, w: 5, y0: 96, y1: 99 }, //    20
  '0/135': { x: 56, w: 5, y0: 96, y1: 99 }, //   20
  '0/270': { x: 57, w: 3, y0: 96, y1: 99 }, //   12
  '30/0': { x: 56, w: 5, y0: 96, y1: 98 }, //    15
  '30/45': { x: 56, w: 5, y0: 95, y1: 99 }, //   25
  '30/135': { x: 56, w: 5, y0: 96, y1: 100 }, // 25
  '30/270': { x: 57, w: 3, y0: 95, y1: 99 }, //  15
  '55/0': { x: 55, w: 7, y0: 94, y1: 98 }, //    35
  '55/45': { x: 56, w: 7, y0: 93, y1: 99 }, //   49
  '55/135': { x: 56, w: 7, y0: 96, y1: 102 }, // 49
  '55/270': { x: 55, w: 5, y0: 94, y1: 100 }, // 35
  '70/0': { x: 39, w: 38, y0: 67, y1: 99 }, //   1254
  '70/45': { x: 56, w: 38, y0: 63, y1: 99 }, //  1406
  '70/135': { x: 56, w: 38, y0: 96, y1: 132 }, // 1406
  '70/270': { x: 27, w: 33, y0: 79, y1: 116 }, // 1254
  '85/0': { x: 42, w: 32, y0: 74, y1: 99 }, //   832
  '85/45': { x: 56, w: 31, y0: 69, y1: 99 }, //  961
  '85/135': { x: 56, w: 31, y0: 96, y1: 125 }, // 930
  '85/270': { x: 34, w: 27, y0: 82, y1: 113 }, // 864
};

describe('exact tile selection at pitch (the regression pin)', () => {
  it('selects exactly the pinned rectangle at all 20 cameras', () => {
    const actual: Record<string, unknown> = {};
    for (const pitch of PITCHES)
      for (const bearing of BEARINGS) {
        const b = makeLayer().getViewportBounds(camera(pitch, bearing));
        actual[`${pitch}/${bearing}`] = selectionRect(b, Z);
      }
    expect(actual).toEqual(GOLDEN_RECTS);
  });

  it('reproduces the two magnitudes the audit reported', () => {
    // 12 flat, 832 at pitch 85 / z8 — the numbers §1 and §4.4 are written
    // around. If these move, the roadmap prose moves with them.
    expect(cellCount(makeLayer().getViewportBounds(camera(0, 0)), Z)).toBe(12);
    expect(cellCount(makeLayer().getViewportBounds(camera(85, 0)), Z)).toBe(
      832,
    );
  });

  it('costs MORE at pitch 70 than at pitch 85', () => {
    // Counter-intuitive and load-bearing: the far-plane substitution bounds
    // the box at 85 while the barely-above-horizon top plane at 70 does not.
    // A budget keyed on pitch instead of on the measured count would get this
    // exactly backwards.
    const at70 = cellCount(makeLayer().getViewportBounds(camera(70, 0)), Z);
    const at85 = cellCount(makeLayer().getViewportBounds(camera(85, 0)), Z);
    expect(at70).toBeGreaterThan(at85);
  });
});

// ---------------------------------------------------------------------------
// 2. Two-sided agreement with the exact visible-ground set — the proof
// ---------------------------------------------------------------------------

/**
 * `pitch/bearing` → `[tiles the camera actually draws, tiles selected]` at z8.
 *
 * The left column is SOLVED (frustum ∩ ground, `visibleGroundTiles`), so it is
 * a property of the camera alone and moves only if deck's projection changes.
 * The right column is the selection. The gap between them is the AABB tax: the
 * frustum's ground footprint is a trapezoid and the selector loads its
 * bounding box, so rotation costs the most (a 45° trapezoid has the worst
 * box-to-area ratio) and pitch 70 the most of all, because math.gl's top-plane
 * branch is not bounded by the far plane the way the pitch-85 branch is.
 */
const GOLDEN_TRUTH: Record<string, [truth: number, selected: number]> = {
  '0/0': [12, 12],
  '0/45': [13, 20],
  '0/135': [14, 20],
  '0/270': [12, 12],
  '30/0': [14, 15],
  '30/45': [16, 25],
  '30/135': [15, 25],
  '30/270': [13, 15],
  '55/0': [29, 35],
  '55/45': [28, 49],
  '55/135': [31, 49],
  '55/270': [27, 35],
  '70/0': [500, 1254],
  '70/45': [509, 1406],
  '70/135': [490, 1406],
  '70/270': [483, 1254],
  '85/0': [455, 832],
  '85/45': [482, 961],
  '85/135': [466, 930],
  '85/270': [470, 864],
};

/** The worst AABB tax any camera in this file is allowed to pay. */
const MAX_OVER_SELECTION = 3;

describe('selection agrees with the exact visible-ground set', () => {
  it('the oracle reproduces viewport.project from its own matrix model', () => {
    // Guards the assumption the whole oracle rests on: that
    // `pixelProjectionMatrix` maps COMMON space to [px, py, ndcZ] and that
    // `commonSpaceFit` recovers the (u, v) ↔ common map. If deck changes
    // either convention this fails here rather than quietly producing a
    // "truth" set that is wrong in the same direction as the code.
    for (const [pitch, bearing] of [
      [0, 0],
      [70, 45],
      [85, 270],
    ] as Array<[number, number]>) {
      const v = camera(pitch, bearing);
      const m = v.pixelProjectionMatrix;
      const { A, B, C, D } = commonSpaceFit(v);
      for (const [lon, lat] of [
        [-98, 39],
        [-100, 42],
        [-90, 35],
      ]) {
        // Round-trip lon/lat → (u, v) → common through the FIT, then project
        // by hand, and compare with deck's own projection.
        const x = A * lonToU(lon) + B;
        const y = C * latToV(lat) + D;
        const w = m[3] * x + m[7] * y + m[15];
        const px = (m[0] * x + m[4] * y + m[12]) / w;
        const py = (m[1] * x + m[5] * y + m[13]) / w;
        const [ex, ey] = v.project([lon, lat]);
        expect(px).toBeCloseTo(ex, 6);
        expect(py).toBeCloseTo(ey, 6);
      }
    }
  });

  it('misses nothing at 20 cameras (LOWER bound)', () => {
    const misses: string[] = [];
    for (const pitch of PITCHES)
      for (const bearing of BEARINGS) {
        const v = camera(pitch, bearing);
        const selected = selectionSet(makeLayer().getViewportBounds(v), Z);
        const truth = visibleGroundTiles(v, Z);
        const missing = [...truth].filter((t) => !selected.has(t));
        if (missing.length > 0) {
          misses.push(
            `p${pitch}/b${bearing}: ${missing.length} of ${truth.size} missing ` +
              `(e.g. ${missing.slice(0, 4).join(', ')})`,
          );
        }
      }
    expect(misses).toEqual([]);
  });

  it('pins the drawn count and the over-selection ratio (UPPER bound)', () => {
    // Without this half, "select the whole world" scores a perfect superset.
    const actual: Record<string, [number, number]> = {};
    const overBudget: string[] = [];
    for (const pitch of PITCHES)
      for (const bearing of BEARINGS) {
        const v = camera(pitch, bearing);
        const truth = visibleGroundTiles(v, Z);
        const selected = selectionSet(makeLayer().getViewportBounds(v), Z);
        actual[`${pitch}/${bearing}`] = [truth.size, selected.size];
        const ratio = selected.size / truth.size;
        if (ratio > MAX_OVER_SELECTION)
          overBudget.push(`p${pitch}/b${bearing}: ${ratio.toFixed(2)}x`);
      }
    expect(actual).toEqual(GOLDEN_TRUTH);
    expect(overBudget).toEqual([]);
  });

  it('the whole-world selector passes the lower bound and FAILS the upper', () => {
    // The control that makes the ratio cap mean something. A selector that
    // simply returns the planet misses nothing at every camera — and is a
    // 65536-tile fetch storm at z8.
    const world: Box = { minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 };
    const worldSet = selectionSet(world, Z);
    for (const pitch of PITCHES) {
      const v = camera(pitch, 0);
      const truth = visibleGroundTiles(v, Z);
      expect([...truth].filter((t) => !worldSet.has(t))).toEqual([]);
      expect(worldSet.size / truth.size).toBeGreaterThan(MAX_OVER_SELECTION);
    }
  });

  it('MUTATION GUARD: a maxLat shrunk to the ray grid’s top row is caught', () => {
    // THE reason this file no longer certifies itself with a screen grid.
    // Pull `maxLat` down to the northern edge of the topmost row the retired
    // 128 × 128 sampler resolved — a mutant that is invisible to that sampler
    // (`missesVsRayGrid` is 0 by construction) and drops a wide band of
    // genuinely drawn tiles off the top of the frame. The exact oracle sees it.
    const report: Record<string, unknown> = {};
    for (const pitch of [70, 85]) {
      const v = camera(pitch, 0);
      const truth = visibleGroundTiles(v, Z);
      const ray = rayGridTiles(v, Z);
      const topRow = Math.min(...[...ray].map((t) => Number(t.split('/')[1])));
      const b: any = makeLayer().getViewportBounds(v);
      const mutant: Box = {
        ...b,
        maxLat: Math.min(b.maxLat, vToLat(topRow / 2 ** Z)),
      };
      const mutantSet = selectionSet(mutant, Z);
      report[`p${pitch}`] = {
        missesVsRayGrid: [...ray].filter((t) => !mutantSet.has(t)).length,
        missesVsExactTruth: [...truth].filter((t) => !mutantSet.has(t)).length,
        cells: mutantSet.size,
      };
    }
    // The old oracle scores the mutant PERFECT; the exact one drops 175 and 95
    // drawn tiles. Both halves are asserted: if `missesVsRayGrid` ever stopped
    // being 0 the mutant would no longer demonstrate the blindness, and the
    // guard would be pinning nothing.
    expect(report).toEqual({
      p70: { missesVsRayGrid: 0, missesVsExactTruth: 95, cells: 950 },
      p85: { missesVsRayGrid: 0, missesVsExactTruth: 175, cells: 640 },
    });
  });

  it('the retired 128-grid sampler resolves only a fraction of the frame', () => {
    // Quantifies the previous test's premise, and pins the direction of the
    // error: the grid is a strict SUBSET of the truth at every camera (it
    // never invents a tile), it just cannot reach the near-horizon band. The
    // convergence ladder shows it is a sampling limit, not a clipping bug —
    // 4× the samples buys ~1.5× the tiles and it is still short at 1024.
    const v = camera(85, 0);
    const truth = visibleGroundTiles(v, Z);
    const ladder = [128, 512, 1024].map((s) => rayGridTiles(v, Z, s).size);
    expect(ladder).toEqual([108, 261, 388]);
    expect(truth.size).toBe(455);

    for (const pitch of PITCHES)
      for (const bearing of BEARINGS) {
        const cam = camera(pitch, bearing);
        const exact = visibleGroundTiles(cam, Z);
        const grid = rayGridTiles(cam, Z);
        expect([...grid].filter((t) => !exact.has(t))).toEqual([]);
      }

    // Coverage at the two cameras the audit quotes.
    expect(rayGridTiles(v, Z).size / truth.size).toBeLessThan(0.25);
    const at70 = camera(70, 0);
    expect(
      rayGridTiles(at70, Z).size / visibleGroundTiles(at70, Z).size,
    ).toBeLessThan(0.56);
  });

  it('the OLD two-corner box fails the lower bound above pitch 0', () => {
    // The negative control. Without it, a selector that simply returned the
    // whole world would pass the superset assertion and prove nothing. Run
    // against the FAITHFUL retired body (clamp included).
    const failures: string[] = [];
    for (const [pitch, bearing] of [
      [0, 45],
      [55, 0],
      [70, 0],
      [85, 0],
    ] as Array<[number, number]>) {
      const v = camera(pitch, bearing);
      const old = selectionSet(retiredBounds(v), Z);
      const truth = visibleGroundTiles(v, Z);
      if ([...truth].every((t) => old.has(t)))
        failures.push(`p${pitch}/b${bearing} unexpectedly covered`);
    }
    expect(failures).toEqual([]);
  });

  it('never PARTIALLY under-selects across a 23,328-camera sweep', () => {
    // 20 hand-picked cameras is a spot check; this is the sweep. Pitch 0–85 in
    // 5° steps × 24 bearings × 6 latitudes × z2/z7/z13 × 3 longitudes, each
    // measured against its exact visible set.
    //
    // The result is the strongest statement this file can make about the fix:
    // the four-corner box NEVER drops a visible tile while the tile math stays
    // finite — `partialMiss` is 0 over 23k cameras. The 24 total failures are
    // all the SAME failure, and it is not this fix's: see §6.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let cameras = 0;
    let clean = 0;
    let emptySelection = 0;
    let partialMiss = 0;
    const zooms = new Set<number>();
    for (let pitch = 0; pitch <= 85; pitch += 5)
      for (let bearing = 0; bearing < 360; bearing += 15)
        for (const latitude of [-70, -35, 0, 22, 51, 74])
          for (const zoom of [2, 7, 13])
            for (const longitude of [-98, 0, 179.7]) {
              const v = new WebMercatorViewport({
                id: `sweep-${pitch}-${bearing}-${latitude}-${zoom}-${longitude}`,
                width: 1600,
                height: 900,
                longitude,
                latitude,
                zoom,
                pitch,
                bearing,
              });
              const truth = visibleGroundTiles(v, zoom);
              if (truth.size === 0) continue;
              cameras++;
              const selected = selectionSet(
                makeLayer().getViewportBounds(v),
                zoom,
              );
              if ([...truth].every((t) => selected.has(t))) {
                clean++;
              } else if (selected.size === 0) {
                emptySelection++;
                zooms.add(zoom);
              } else {
                partialMiss++;
              }
            }
    warn.mockRestore();
    // Was `clean: 23304, emptySelection: 24` — the 24 being z2 cameras whose
    // box reached the ULP band above -90, where `latToTileY` returned NaN and
    // the row loop never ran. Both clamps (see the REPAIRED block below) close
    // that route, so the sweep is now clean across every camera.
    expect({ cameras, clean, emptySelection, partialMiss }).toEqual({
      cameras: 23328,
      clean: 23328,
      emptySelection: 0,
      partialMiss: 0,
    });
    expect([...zooms]).toEqual([]);
  });

  it('unclipped unprojection invents tiles the camera cannot see', () => {
    // Pin the trap the plan calls out: above the horizon, `unproject` returns
    // finite, plausible lon/lats for rays that meet the ground BEHIND the
    // camera. Those phantoms are not merely extra samples — they lie OUTSIDE
    // the exact visible set, so a truth built from raw `unproject` would demand
    // the selector cover the mirror image of the sky and would reject a
    // correct selector.
    const v = camera(85, 0);
    const truth = visibleGroundTiles(v, Z);
    const unclipped = new Set<string>();
    const n = 2 ** Z;
    for (let i = 0; i < 128; i++)
      for (let j = 0; j < 128; j++) {
        const p = v.unproject([(v.width * i) / 127, (v.height * j) / 127]);
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
        if (Math.abs(p[1]) > 85.05) continue;
        unclipped.add(
          `${((lonToTileX(p[0], Z) % n) + n) % n}/${Math.min(n - 1, Math.max(0, latToTileY(p[1], Z)))}`,
        );
      }
    const phantoms = [...unclipped].filter((t) => !truth.has(t));
    expect(phantoms.length).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------
// 3. What the flat map inherited from the retired derivation
// ---------------------------------------------------------------------------

const FLAT_LONS = [-98, 0, 45, 120, 179, 184];
const FLAT_LATS = [-45, 0, 39, 62];
const FLAT_ZOOMS = [2, 5, 8, 11, 14];
const FLAT_SIZES: Array<[number, number]> = [
  [1600, 900],
  [800, 800],
  [375, 812],
];

function flatCameras(): WebMercatorViewport[] {
  const out: WebMercatorViewport[] = [];
  for (const longitude of FLAT_LONS)
    for (const latitude of FLAT_LATS)
      for (const zoom of FLAT_ZOOMS)
        for (const [width, height] of FLAT_SIZES)
          out.push(
            new WebMercatorViewport({
              id: `flat-${longitude}-${latitude}-${zoom}-${width}`,
              width,
              height,
              longitude,
              latitude,
              zoom,
              pitch: 0,
              bearing: 0,
            }),
          );
  return out;
}

/** Did the retired body's clamp actually bite at this camera? */
function clampBinds(v: any): boolean {
  const raw = rawCornerBounds(v);
  return (
    raw.minLon < -180 || raw.maxLon > 180 || raw.minLat < -90 || raw.maxLat > 90
  );
}

describe('pitch 0 / bearing 0 against the retired derivation', () => {
  it('is Object.is-identical wherever the retired clamp did not bite', () => {
    // The real non-regression claim, and the only one the evidence supports:
    // where the retired code returned its corners untouched, the four-corner
    // box returns the SAME DOUBLES. A drift of one ULP is fine in the abstract
    // and catastrophic in practice — `lonToTileX` FLOORS, so one ULP on the
    // wrong side of a tile boundary changes the selected column.
    const diffs: string[] = [];
    let checked = 0;
    let identical = 0;
    for (const v of flatCameras()) {
      checked++;
      const now: any = makeLayer().getViewportBounds(v);
      const before: any = retiredBounds(v);
      const keys = ['minLon', 'minLat', 'maxLon', 'maxLat'];
      if (keys.every((k) => Object.is(now[k], before[k]))) identical++;
      if (clampBinds(v)) continue;
      for (const key of keys) {
        if (!Object.is(now[key], before[key])) {
          diffs.push(`${v.id} ${key}: ${before[key]} -> ${now[key]}`);
        }
      }
    }
    expect(checked).toBe(360);
    expect(diffs).toEqual([]);
    // 252 unchanged, 108 changed — and every one of the 108 is a camera whose
    // view genuinely ran off the edge of the clamp. The next test says what
    // happened at those.
    expect(identical).toBe(252);
  });

  it('changes exactly the 108 cameras the clamp used to distort, all for the better', () => {
    // The claim this file exists to make honestly. Each changed camera is
    // classified by comparing BOTH selections against the exact visible set:
    //
    //   retired-under — the clamp cut the box short of the frame, so the
    //     retired code left genuinely visible tiles unloaded (a blank strip on
    //     the far side of the antimeridian at lon 179, and a missing column at
    //     z2 where the map is narrower than the screen).
    //   retired-over  — the clamp INVERTED the box (`minLon` past +180 survives
    //     `Math.max(-180, …)` while `maxLon` is pulled back to 180), which
    //     `boundsToTiles` then reads as an antimeridian crossing and walks
    //     almost the whole world.
    //   same-selection — the clamp moved a component but not across a tile
    //     boundary that mattered.
    //
    // There is no fourth class: no camera where the retired box was closer to
    // the truth than the new one.
    let retiredUnder = 0;
    let retiredOver = 0;
    let sameSelection = 0;
    let unchanged = 0;
    const newMisses: string[] = [];
    let worstRetiredOver = 0;
    for (const v of flatCameras()) {
      const zoom = Math.round((v as any).zoom);
      const now = selectionSet(makeLayer().getViewportBounds(v), zoom);
      const old = selectionSet(retiredBounds(v), zoom);
      const truth = visibleGroundTiles(v, zoom);
      if ([...truth].some((t) => !now.has(t))) newMisses.push(String(v.id));
      const same = now.size === old.size && [...now].every((t) => old.has(t));
      const oldMissed = [...truth].some((t) => !old.has(t));
      if (!clampBinds(v)) {
        unchanged++;
        expect(same).toBe(true);
      } else if (same) {
        sameSelection++;
      } else if (oldMissed) {
        retiredUnder++;
        // Under-selection is the failure that shows: the missing tiles are on
        // screen and nothing draws there.
        expect(old.size).toBeLessThan(now.size);
      } else {
        retiredOver++;
        // Over-selection is the failure that stalls: same frame, 40× the
        // fetches.
        expect(old.size).toBeGreaterThan(now.size * 10);
        worstRetiredOver = Math.max(worstRetiredOver, old.size);
      }
    }
    expect({
      unchanged,
      sameSelection,
      retiredUnder,
      retiredOver,
    }).toEqual({
      unchanged: 252,
      sameSelection: 4,
      retiredUnder: 68,
      retiredOver: 36,
    });
    // The new derivation never drops a visible tile at ANY of the 360.
    expect(newMisses).toEqual([]);
    // Worst case of the inversion: lon 184 at z14 asked for 48,615 tiles to
    // draw a frame that needs 12.
    expect(worstRetiredOver).toBe(48615);
  });

  it('is EXACT on the flat map — the visible set and nothing else', () => {
    // Stronger than the superset bound §2 asks for above pitch 0, and it is
    // what makes the flat-map change safe to ship: at pitch 0 / bearing 0 the
    // ground quad IS an axis-aligned rectangle, so the AABB tax is zero and
    // the selection equals the truth at every one of the 360 cameras.
    const wrong: string[] = [];
    for (const v of flatCameras()) {
      const zoom = Math.round((v as any).zoom);
      const now = selectionSet(makeLayer().getViewportBounds(v), zoom);
      const truth = visibleGroundTiles(v, zoom);
      if (
        now.size !== truth.size ||
        [...truth].some((t) => !now.has(t)) ||
        [...now].some((t) => !truth.has(t))
      ) {
        wrong.push(`${v.id}: selected ${now.size}, drawn ${truth.size}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('emits an identical tile ARRAY, order included, where the clamp did not bite', () => {
    // Membership equality would hide an emission-order change, and order is a
    // contract: the tileset prioritises by arrival, and x-major / y-inner is
    // what makes a horizontal pan extend the runway instead of reshuffling it.
    let compared = 0;
    for (const longitude of FLAT_LONS)
      for (const zoom of [5, 8, 11]) {
        const v = new WebMercatorViewport({
          id: `arr-${longitude}-${zoom}`,
          width: 1600,
          height: 900,
          longitude,
          latitude: 39,
          zoom,
          pitch: 0,
          bearing: 0,
        });
        const now = selectionArray(makeLayer().getViewportBounds(v), zoom);
        expect(now.length).toBeGreaterThan(0);
        // Order is x-major / y-inner regardless of the clamp.
        const cols = now.map(([x]) => x);
        expect(new Set(cols).size).toBe(
          cols.filter((x, i) => i === 0 || x !== cols[i - 1]).length,
        );
        if (clampBinds(v)) continue;
        compared++;
        expect(now).toEqual(selectionArray(retiredBounds(v), zoom));
      }
    // Not vacuous: most of the grid still compares against the retired array.
    expect(compared).toBe(13);
  });
});

// ---------------------------------------------------------------------------
// 4. The antimeridian, under pitch
// ---------------------------------------------------------------------------

describe('antimeridian under 3D cameras', () => {
  const SEAM_Z = 6;
  const seamCamera = (pitch: number) =>
    new WebMercatorViewport({
      id: `seam-${pitch}`,
      width: WIDTH,
      height: HEIGHT,
      longitude: 179.5,
      latitude: 20,
      zoom: SEAM_Z,
      pitch,
      bearing: 0,
    });

  it('keeps the box unwrapped, ordered and unclamped at every pitch', () => {
    for (const pitch of [0, 55, 70, 85]) {
      const b: any = makeLayer().getViewportBounds(seamCamera(pitch));
      // Unwrapped: the east edge of the screen really is past +180, and
      // clamping it to 180 is what blanked the far side of the seam on
      // `ais-all-us` / `drifters`.
      expect(b.maxLon).toBeGreaterThan(180);
      // Ordered: never the `minLon > maxLon` shape a pitch inversion produces,
      // which `orderLonRange` would then have to disambiguate from a genuine
      // crossing.
      expect(b.minLon).toBeLessThan(b.maxLon);
      expect(b.minLon).toBeLessThan(180);
      expect(b.minLat).toBeLessThan(b.maxLat);
      // Not collapsed to the global band either — that was the interim
      // mitigation, and at z6 it is a 64× fetch amplification.
      expect(b.maxLon - b.minLon).toBeLessThan(360);
    }
  });

  it('selects columns on BOTH edges of the world at every pitch', () => {
    const n = 2 ** SEAM_Z;
    for (const pitch of [0, 55, 70, 85]) {
      const b = makeLayer().getViewportBounds(seamCamera(pitch));
      const cols = new Set(selectionArray(b, SEAM_Z).map(([x]) => x));
      // The wrap is real: the east half of the screen lives at low column
      // indices and the west half at high ones.
      expect(cols.has(n - 1)).toBe(true);
      expect(cols.has(0)).toBe(true);
      // ... and it is a span, not the whole world.
      expect(cols.size).toBeLessThan(n);
    }
  });

  it('covers the exact visible set across the seam, within the ratio cap', () => {
    // Same two-sided test as §2, on the wrap. The truth polygon is computed in
    // UNWRAPPED u and only the tile index is wrapped, so a selector that
    // dropped the far side of the seam registers as misses rather than
    // silently matching a truth set that was wrapped the same wrong way.
    const actual: Record<string, [number, number]> = {};
    for (const pitch of [0, 55, 70, 85]) {
      const v = seamCamera(pitch);
      const selected = selectionSet(makeLayer().getViewportBounds(v), SEAM_Z);
      const truth = visibleGroundTiles(v, SEAM_Z);
      expect([...truth].filter((t) => !selected.has(t))).toEqual([]);
      expect(selected.size / truth.size).toBeLessThanOrEqual(
        MAX_OVER_SELECTION,
      );
      actual[`p${pitch}`] = [truth.size, selected.size];
    }
    expect(actual).toEqual({
      p0: [12, 12],
      p55: [27, 35],
      p70: [483, 1140],
      p85: [474, 864],
    });
  });
});

// ---------------------------------------------------------------------------
// 5. The cell budget, through the chassis
// ---------------------------------------------------------------------------

describe('viewportCellBudget through getZoomLevel', () => {
  const metadata = { minZoom: 0, maxZoom: 14 };
  const withArchive = () => ({ archive: {}, metadata });

  it('is inert up to pitch 55 and engages past it', () => {
    // The contract §4.4 requires: counts rise under pitch and the budget does
    // NOT walk that back at the pitches the audit measured. It only fires
    // where the AABB stops approximating the frame at all.
    for (const pitch of [0, 30, 55])
      for (const bearing of BEARINGS) {
        const layer = makeLayer({}, withArchive());
        expect(layer.getZoomLevel(camera(pitch, bearing))).toBe(Z);
      }
    for (const bearing of BEARINGS) {
      expect(
        makeLayer({}, withArchive()).getZoomLevel(camera(70, bearing)),
      ).toBe(6);
      expect(
        makeLayer({}, withArchive()).getZoomLevel(camera(85, bearing)),
      ).toBe(7);
    }
  });

  it('steps down only as far as the budget needs', () => {
    const layer = makeLayer({}, withArchive());
    const v = camera(85, 0);
    const fitted = layer.getZoomLevel(v);
    const b = layer.getViewportBounds(v);
    expect(cellCount(b, fitted)).toBeLessThanOrEqual(256);
    expect(cellCount(b, fitted + 1)).toBeGreaterThan(256);
  });

  it('is disabled by Infinity and honours a custom budget', () => {
    expect(
      makeLayer({ viewportCellBudget: Infinity }, withArchive()).getZoomLevel(
        camera(85, 0),
      ),
    ).toBe(Z);
    // A tighter budget steps further; a looser one steps less.
    expect(
      makeLayer({ viewportCellBudget: 16 }, withArchive()).getZoomLevel(
        camera(85, 0),
      ),
    ).toBeLessThan(
      makeLayer({ viewportCellBudget: 1024 }, withArchive()).getZoomLevel(
        camera(85, 0),
      ),
    );
  });

  it('never steps below the archive minZoom', () => {
    const layer = makeLayer(
      { viewportCellBudget: 1 },
      { archive: {}, metadata: { minZoom: 7, maxZoom: 14 } },
    );
    expect(layer.getZoomLevel(camera(85, 0))).toBe(7);
  });

  it('is bypassed by zoomOverride and by useGlobalBounds', () => {
    // Both are an app saying what to load. `useGlobalBounds` especially: its
    // box is the whole planet by request, so measuring it against a viewport
    // budget would clamp every GlobeView demo to a handful of zooms.
    expect(
      makeLayer({ zoomOverride: 12 }, withArchive()).getZoomLevel(
        camera(85, 0),
      ),
    ).toBe(12);
    expect(
      makeLayer({ useGlobalBounds: true }, withArchive()).getZoomLevel(
        camera(85, 0),
      ),
    ).toBe(Z);
  });

  it('holds a clamped zoom steady while the camera hovers on the threshold', () => {
    // Flapping is not a cosmetic problem: every zoom flip trips the tileset's
    // `zoom !== lastSpatialZoom` check, which flushes the prefetch runway and
    // reselects from scratch — costing far more than the tiles it saves.
    const layer = makeLayer({}, withArchive());
    const seen: number[] = [];
    for (let frame = 0; frame < 12; frame++) {
      // Oscillate either side of the pitch where the budget engages.
      seen.push(layer.getZoomLevel(camera(frame % 2 === 0 ? 70 : 69.5, 0)));
    }
    expect(new Set(seen.slice(1)).size).toBe(1);
  });

  it('still clamps to the archive zoom range before the budget applies', () => {
    const layer = makeLayer(
      {},
      { archive: {}, metadata: { minZoom: 0, maxZoom: 5 } },
    );
    expect(layer.getZoomLevel(camera(0, 0))).toBe(5);
  });

  it('does not warn — the budget is a cost decision, not a defect', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    makeLayer({}, withArchive()).getZoomLevel(camera(85, 0));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 6. KNOWN DEFECT, found by the exact oracle and NOT caused by this fix:
//    a latitude in the ULP band just above −90 makes `latToTileY` return NaN,
//    and `boundsToTiles` then selects ZERO tiles.
// ---------------------------------------------------------------------------

/**
 * The one failure the 23,328-camera sweep found, isolated.
 *
 * `latToTileY` (packages/core/src/archive.ts:3500) is the standard slippy-map
 * row index:
 *
 *     log(tan(φ) + 1 / cos(φ))
 *
 * As `φ → −90°`, `tan φ` and `sec φ` are both ≈ −1/ε and +1/ε and their sum is
 * pure cancellation. In double precision the sum lands on ZERO for most of the
 * band (→ `log 0 = −∞` → `y = +Infinity`, which `boundsToTiles` survives: the
 * row span degrades to the whole column) but on a SMALL NEGATIVE number for
 * about a quarter of the representable values in it (→ `log` of a negative →
 * NaN). NaN is the one it does not survive:
 *
 *     minY = Math.max(0, Math.min(yTop, NaN))            // NaN
 *     maxY = Math.min(Math.max(yTop, NaN), n - 1)        // NaN
 *     for (let y = minY; y <= maxY; y++) { … }           // never runs
 *
 * — zero tiles, from a box that is finite, ordered, and passes every
 * `normalizeViewportBounds` rule. This is precisely the "blank map while every
 * readiness signal says settled" failure `packages/core/src/geo/viewport-bounds.ts`
 * was written to eliminate, reached by a route it does not cover: its rule 2
 * clamps latitude to `[-90, 90]`, i.e. INTO the danger band, where clamping to
 * the mercator limit (±85.0511°) would be both harmless and safe.
 *
 * This was NOT a defect in the four-corner viewport fix. That fix is what makes
 * the camera report a box reaching the pole in the first place, but the retired
 * two-corner derivation reached ±90 as well (its own clamp was `Math.max(-90,
 * minLat)`), and the sweep showed zero PARTIAL misses — the four-corner box is
 * correct wherever the row math is finite.
 *
 * REPAIRED. Both ends of the route are now closed, and these tests were
 * inverted from pinning the defect to pinning the repair, exactly as the
 * original version of this block instructed:
 *
 * - `normalizeViewportBounds` rule 2 clamps latitude to ±`MAX_MERCATOR_LAT`
 *   (85.0511°) rather than ±90, so a camera box never reaches the band.
 * - `latToTileY` clamps its own input to the same constant, closing the hole
 *   for any caller that does not go through `normalizeViewportBounds`.
 *
 * Neither clamp changes which tiles are selected — there is no tile row above
 * the Mercator edge, so 90 and 85.0511 both map to row 0. See
 * `packages/core/test/polar-tile-row-collapse.test.ts` for the arithmetic.
 */
describe('REPAIRED: the NaN latitude band just above -90', () => {
  /** The lowest-zoom, highest-pitch camera the sweep flagged. */
  const polarCamera = () =>
    new WebMercatorViewport({
      id: 'polar-nan',
      width: 1600,
      height: 900,
      longitude: 0,
      latitude: -35,
      zoom: 2,
      pitch: 70,
      bearing: 90,
    });

  it('the production latToTileY is finite everywhere in the old NaN band', () => {
    // The exact latitudes that used to return NaN, plus the neighbours that
    // showed it was a cancellation window rather than a single point. All are
    // now clamped to the Mercator edge before the log, so all resolve to the
    // southernmost row.
    expect(coreLatToTileY(-89.99999999998705, 2)).toBe(3);
    expect(coreLatToTileY(-89.99999999998705, 14)).toBe((1 << 14) - 1);
    expect(coreLatToTileY(-90, 2)).toBe(3);
    expect(coreLatToTileY(-89.9999999, 2)).toBe(3);
    // Unchanged where it always worked.
    expect(coreLatToTileY(-85, 2)).toBe(3);
  });

  it('the chassis box is well-formed AND clear of the danger band', () => {
    const b: any = makeLayer().getViewportBounds(polarCamera());
    for (const k of ['minLon', 'minLat', 'maxLon', 'maxLat'])
      expect(Number.isFinite(b[k])).toBe(true);
    expect(b.minLat).toBeLessThan(b.maxLat);
    // The repair: the south edge is held at the Mercator limit instead of
    // being allowed into the ULP band above -90.
    expect(b.minLat).toBeGreaterThanOrEqual(-MAX_MERCATOR_LAT);
    expect(Number.isFinite(coreLatToTileY(b.minLat, 2))).toBe(true);
  });

  it('REPAIRED: the selection now covers all 16 on-screen tiles', () => {
    const v = polarCamera();
    const truth = visibleGroundTiles(v, 2);
    const selected = selectionSet(makeLayer().getViewportBounds(v), 2);
    // The camera shows the entire world at z2 — every one of the 16 cells.
    expect(truth.size).toBe(16);
    // Previously 0 — a blank map that reported settled. Now the full set.
    expect(selected.size).toBe(16);
    expect([...truth].filter((t) => !selected.has(t))).toEqual([]);
  });

  it('one degree of pitch either side of the trigger is fine', () => {
    // Bounds the blast radius: this is a razor-thin numerical window, not a
    // whole camera regime. The same camera at pitch 69 or 71 selects normally.
    for (const pitch of [69, 71]) {
      const v = new WebMercatorViewport({
        id: `polar-${pitch}`,
        width: 1600,
        height: 900,
        longitude: 0,
        latitude: -35,
        zoom: 2,
        pitch,
        bearing: 90,
      });
      const truth = visibleGroundTiles(v, 2);
      const selected = selectionSet(makeLayer().getViewportBounds(v), 2);
      expect([...truth].filter((t) => !selected.has(t))).toEqual([]);
      expect(selected.size).toBeGreaterThan(0);
    }
  });
});

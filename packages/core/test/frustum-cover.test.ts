// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

/**
 * `coverFrustumQuadtree` — the frustum → quadtree-cut cover primitive.
 *
 * ## The oracle, and why it is built here rather than imported
 *
 * The regression this file guards against is the 2026-07-26 incident: tile
 * selection was correct ONLY at `pitch === 0 && bearing === 0`, and the shipped
 * 3-D demos were missing **20–44 %** of their data — silently, because a missed
 * tile renders as "no data here" rather than as an error. The oracle that caught
 * it is the 24 × 18 pitch × bearing matrix in
 * `packages/layers/test/chassis-viewport-bounds.test.ts`, and every assertion
 * below is the same shape: **one-sided**. "Every drawn sample is covered", never
 * "the cover equals X".
 *
 * That matrix drives a real deck `WebMercatorViewport`. `@poopdeck.gl/core` is
 * framework-free by contract (`kernel-framework-free.test.ts`) and carries no
 * deck dependency, so the 432 cameras are rebuilt here from first principles —
 * deck's own conventions (512-px tiles, `focalDistance`/`altitude` 1.5, math.gl's
 * pitch-dependent far plane), but 60 lines of arithmetic rather than an import.
 *
 * The re-derivation is a FEATURE, not a workaround. The cover primitive consumes
 * PLANES and the oracle below consumes RAYS: the two travel from the same camera
 * parameters to the same answer by disjoint code paths (six half-space tests
 * against a box vs. a ray/ground-plane solve per pixel), so agreement between
 * them is evidence rather than tautology. A shared matrix helper would have made
 * a sign convention agree with itself.
 *
 * ## What is asserted
 *
 * 1. **Zero coverage misses at all 432 cameras** — the gate, not a target.
 * 2. A flat unrotated camera degenerates to exactly the box enumeration at
 *    exactly `cameraZoom` (the property that makes this safe to adopt).
 * 3. The cut is an antichain, duplicate-free, in range, and deterministic.
 * 4. Every uncertainty resolves to `null` — never `[]`, never a throw, never a
 *    truncated cut.
 */

import { describe, it, expect } from 'vitest';
import {
  coverFrustumQuadtree,
  lonLatToCoverPoint,
  coverPointToLonLat,
  DEFAULT_MAX_COVER_CELLS,
  MAX_WORLD_COPIES,
  type FrustumPlane,
  type FrustumCoverOptions,
} from '../src/geo/frustum-cover';
import type { TileId } from '../src/types';

// ---------------------------------------------------------------------------
// A deck-shaped camera, in cover space, with no deck
// ---------------------------------------------------------------------------

const DEG2RAD = Math.PI / 180;
const TILE_PX = 512;
/** deck's `focalDistance` / `altitude`: the camera sits 1.5 screen-heights out. */
const ALTITUDE = 1.5;
const HALF_FOV = Math.atan(0.5 / ALTITUDE); // 18.435°
const NEAR_Z_MULTIPLIER = 0.1; // deck's default
const FAR_Z_MULTIPLIER = 1.01; // deck's default

type Vec3 = [number, number, number];

interface Camera {
  position: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  tanH: number;
  tanV: number;
  near: number;
  far: number;
  referenceDistance: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

interface CameraSpec {
  lon: number;
  lat: number;
  zoom: number;
  pitch?: number;
  bearing?: number;
  width?: number;
  height?: number;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * A camera at `(lon, lat, zoom, pitch, bearing)` expressed in cover space.
 *
 * Cover space is Mercator-normalised, so it is locally isotropic and a camera
 * placed in it by plain trigonometry is the same camera deck places by matrix.
 * `x` is east, `y` is SOUTH (tile-row order), `z` is up.
 */
function makeCamera({
  lon,
  lat,
  zoom,
  pitch = 0,
  bearing = 0,
  width = 1000,
  height = 1000,
}: CameraSpec): Camera {
  const pxPerCover = TILE_PX * 2 ** zoom;
  const altUnit = height / pxPerCover; // one "altitude unit" in cover units
  const referenceDistance = ALTITUDE * altUnit;
  const p = pitch * DEG2RAD;
  const b = bearing * DEG2RAD;

  const target = lonLatToCoverPoint(lon, lat, 0);
  // The camera sits `referenceDistance` behind and above the target: back along
  // the view bearing by sin(pitch), up by cos(pitch). North is −y.
  const position: Vec3 = [
    target[0] - referenceDistance * Math.sin(p) * Math.sin(b),
    target[1] + referenceDistance * Math.sin(p) * Math.cos(b),
    referenceDistance * Math.cos(p),
  ];
  const forward: Vec3 = [
    Math.sin(p) * Math.sin(b),
    -Math.sin(p) * Math.cos(b),
    -Math.cos(p),
  ];
  const right: Vec3 = [Math.cos(b), Math.sin(b), 0];
  const up = cross(forward, right);

  // math.gl's pitch-dependent far plane: the horizon recedes as the camera
  // tilts, and the `0.01` floor is what stops it running to infinity past the
  // horizon. Reproduced because it is what keeps a pitched frustum finite —
  // without it the "cut vs AABB" comparison below would be measuring a
  // camera no renderer ever builds.
  const denom = Math.min(
    Math.max(Math.PI / 2 - p - HALF_FOV, 0.01),
    Math.PI - 0.01,
  );
  const topHalfSurfaceDistance =
    (Math.sin(HALF_FOV) * ALTITUDE) / Math.sin(denom);
  const farAlt = Math.sin(p) * topHalfSurfaceDistance + ALTITUDE;

  return {
    position,
    forward,
    right,
    up,
    tanV: 0.5 / ALTITUDE,
    tanH: (0.5 / ALTITUDE) * (width / height),
    near: NEAR_Z_MULTIPLIER * altUnit,
    far: farAlt * FAR_Z_MULTIPLIER * altUnit,
    referenceDistance,
    zoom,
    pitch,
    bearing,
  };
}

/**
 * The six INWARD half-spaces of `cam`.
 *
 * A point `v` (relative to the eye) is inside the horizontal wedge iff
 * `|v·right| <= tanH · (v·forward)`, which is two half-spaces with normals
 * `tanH·forward ∓ right`; likewise vertically. Near and far are `±forward`.
 */
function frustumPlanes(cam: Camera): FrustumPlane[] {
  const { position: e, forward: f, right: r, up: u, tanH, tanV } = cam;
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const wedge = (t: number, axis: Vec3, sign: number): FrustumPlane => {
    const n: Vec3 = [
      t * f[0] - sign * axis[0],
      t * f[1] - sign * axis[1],
      t * f[2] - sign * axis[2],
    ];
    return { normal: n, distance: -dot(n, e) };
  };
  return [
    { normal: [f[0], f[1], f[2]], distance: -(dot(f, e) + cam.near) },
    { normal: [-f[0], -f[1], -f[2]], distance: dot(f, e) + cam.far },
    wedge(tanH, r, 1),
    wedge(tanH, r, -1),
    wedge(tanV, u, 1),
    wedge(tanV, u, -1),
  ];
}

/**
 * Ground samples the camera actually draws, on a uniform pixel grid.
 *
 * The keep test is the clip test — in front of the eye, and between the near
 * and far planes in AXIAL depth — which is what "on screen" means to a
 * renderer. `altitudeMeters` samples the top of an extruded slab instead of the
 * ground, which is the A3 case: content 15 km up appears where the ray meets
 * `z = 15 km`, not where it meets `z = 0`.
 */
function drawnPoints(
  cam: Camera,
  samples = 33,
  altitudeMeters = 0,
): Array<[number, number]> {
  const { position: e, forward: f, right: r, up: u, tanH, tanV } = cam;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < samples; i++) {
    const s = (2 * i) / (samples - 1) - 1;
    for (let j = 0; j < samples; j++) {
      const t = 1 - (2 * j) / (samples - 1);
      const dx = f[0] + s * tanH * r[0] + t * tanV * u[0];
      const dy = f[1] + s * tanH * r[1] + t * tanV * u[1];
      const dz = f[2] + s * tanH * r[2] + t * tanV * u[2];
      if (dz === 0) continue;
      // `right`/`up` are orthogonal to `forward`, so the axial depth of the hit
      // is exactly the ray parameter.
      const tau = (altitudeSlabZ(altitudeMeters) - e[2]) / dz;
      if (!(tau > 0) || tau < cam.near || tau > cam.far) continue;
      const x = e[0] + tau * dx;
      const y = e[1] + tau * dy;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      // Outside the Mercator band there are no tile rows to select.
      if (y < 0 || y > 1) continue;
      out.push([x, y]);
    }
  }
  return out;
}

/**
 * Cover-space height of an altitude slab, taken at the EQUATOR.
 *
 * Mercator's vertical scale grows with `1 / cos(lat)`, and the cover dilates
 * each node by its own worst-case (largest) stretch. Sampling at the equator's
 * stretch — the global minimum — therefore guarantees the oracle probes a plane
 * no HIGHER than the slab the cover actually built, anywhere on the planet. The
 * comparison stays one-sided: a miss here is a real miss, never an artefact of
 * the two sides disagreeing about how tall 15 km is at 40.7° N.
 */
function altitudeSlabZ(meters: number): number {
  return meters === 0 ? 0 : lonLatToCoverPoint(0, 0, meters)[2];
}

function cutKeys(cut: readonly TileId[]): Set<string> {
  return new Set(cut.map((c) => `${c.z}/${c.x}/${c.y}`));
}

/** Does the cut contain this cell, or any ancestor of it? */
function coversCell(
  keys: Set<string>,
  minZoom: number,
  zoom: number,
  x: number,
  y: number,
): boolean {
  for (let az = zoom; az >= minZoom; az--) {
    const shift = 2 ** (zoom - az);
    if (keys.has(`${az}/${Math.floor(x / shift)}/${Math.floor(y / shift)}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Cells the cut fails to cover, given the drawn samples. One-sided by
 * construction: extra cells in the cut are never a finding here.
 */
function coverageMisses(
  cut: readonly TileId[],
  points: ReadonlyArray<readonly [number, number]>,
  probeZoom: number,
  minZoom: number,
): string[] {
  const keys = cutKeys(cut);
  const misses = new Set<string>();
  const n = 2 ** probeZoom;
  for (const [x, y] of points) {
    const cx = ((Math.floor(x * n) % n) + n) % n;
    const cy = Math.min(n - 1, Math.max(0, Math.floor(y * n)));
    if (!coversCell(keys, minZoom, probeZoom, cx, cy)) {
      misses.add(`${probeZoom}/${cx}/${cy}`);
    }
  }
  return [...misses];
}

/**
 * The incumbent enumeration: the axis-aligned box around everything on screen,
 * walked at one zoom. Derived from the SAME samples, so it is if anything
 * tighter than the chassis's four-corner box — which makes "the cut is smaller"
 * a conservative claim.
 */
function aabbCellCount(
  points: ReadonlyArray<readonly [number, number]>,
  zoom: number,
): number {
  if (points.length === 0) return 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const n = 2 ** zoom;
  const cols = Math.min(n, Math.floor(maxX * n) - Math.floor(minX * n) + 1);
  const top = Math.min(n - 1, Math.max(0, Math.floor(minY * n)));
  const bottom = Math.min(n - 1, Math.max(0, Math.floor(maxY * n)));
  return cols * (bottom - top + 1);
}

/** Standard options for a camera; `maxZoom` doubles as the oracle probe zoom. */
function coverOpts(
  cam: Camera,
  over: Partial<FrustumCoverOptions> = {},
): FrustumCoverOptions {
  return {
    minZoom: 0,
    maxZoom: 12,
    cameraZoom: cam.zoom,
    cameraPosition: cam.position,
    referenceDistance: cam.referenceDistance,
    ...over,
  };
}

function cover(cam: Camera, over: Partial<FrustumCoverOptions> = {}) {
  return coverFrustumQuadtree(frustumPlanes(cam), coverOpts(cam, over));
}

// The matrix the 2026-07-26 audit was written against: 24 bearings × 18 pitches.
const BEARINGS = Array.from({ length: 24 }, (_, i) => i * 15); // 0…345
const PITCHES = Array.from({ length: 18 }, (_, i) => i * 5); // 0…85
const MATRIX: Array<[number, number]> = [];
for (const bearing of BEARINGS) {
  for (const pitch of PITCHES) MATRIX.push([pitch, bearing]);
}

const MATRIX_LON = -74;
const MATRIX_LAT = 40.7;
const MATRIX_ZOOM = 9;

function matrixCamera(pitch: number, bearing: number): Camera {
  return makeCamera({
    lon: MATRIX_LON,
    lat: MATRIX_LAT,
    zoom: MATRIX_ZOOM,
    pitch,
    bearing,
  });
}

/** Deck's own above-horizon test: the top of the frustum is at or past level. */
function isAboveHorizon(pitch: number): boolean {
  return HALF_FOV > (90 - pitch) * DEG2RAD - 0.01;
}

// ---------------------------------------------------------------------------
// Cover space
// ---------------------------------------------------------------------------

describe('cover space', () => {
  it('places the world in the unit square with y running SOUTH', () => {
    expect(lonLatToCoverPoint(-180, 0)[0]).toBeCloseTo(0, 12);
    expect(lonLatToCoverPoint(180, 0)[0]).toBeCloseTo(1, 12);
    expect(lonLatToCoverPoint(0, 0)[1]).toBeCloseTo(0.5, 12);
    // Tile-row order: north is row 0.
    expect(lonLatToCoverPoint(0, 60)[1]).toBeLessThan(0.5);
    expect(lonLatToCoverPoint(0, -60)[1]).toBeGreaterThan(0.5);
    expect(lonLatToCoverPoint(0, 85.051_128_779_806_59)[1]).toBeCloseTo(0, 9);
    expect(lonLatToCoverPoint(0, -85.051_128_779_806_59)[1]).toBeCloseTo(1, 9);
  });

  it('keeps longitude UNWRAPPED — the seam contract', () => {
    // `tileXSpanForLonRange` walks unwrapped column space and wraps at emit;
    // clamping here would drop the far side of the seam for `ais-all-us` and
    // `drifters`. The cover walk relies on the same convention.
    expect(lonLatToCoverPoint(184, 0)[0]).toBeCloseTo(1 + 4 / 360, 12);
    expect(lonLatToCoverPoint(-184, 0)[0]).toBeCloseTo(-4 / 360, 12);
  });

  it('round-trips through coverPointToLonLat', () => {
    for (const lon of [-179.9, -74, 0, 12.5, 179.9]) {
      for (const lat of [-85, -40, 0, 40.7, 85]) {
        const [x, y] = lonLatToCoverPoint(lon, lat);
        const [rLon, rLat] = coverPointToLonLat(x, y);
        expect(rLon).toBeCloseTo(lon, 9);
        expect(rLat).toBeCloseTo(lat, 8);
      }
    }
  });

  it('clamps latitude to the Mercator band rather than diverging', () => {
    // The tree simply stops at ±85.0511°, which is why the near-pole
    // `log(tan + 1/cos)` cancellation (polar-tile-row-collapse.test.ts) is
    // unreachable from this module.
    for (const lat of [90, -90, 89.999_999_999_987, 1e3, -1e3]) {
      const y = lonLatToCoverPoint(0, lat)[1];
      expect(Number.isFinite(y)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
  });

  it('scales altitude by the local Mercator stretch, bounded at the band edge', () => {
    const atEquator = lonLatToCoverPoint(0, 0, 15_000)[2];
    const atPole = lonLatToCoverPoint(0, 85, 15_000)[2];
    expect(atEquator).toBeGreaterThan(0);
    // 1/cos(85.05°) = cosh(π) ≈ 11.59 — large, and finite.
    expect(atPole / atEquator).toBeGreaterThan(9);
    expect(atPole / atEquator).toBeLessThan(Math.cosh(Math.PI) + 1e-9);
  });
});

// ---------------------------------------------------------------------------
// The degeneracy that makes this safe to adopt
// ---------------------------------------------------------------------------

describe('a flat unrotated camera', () => {
  const cam = matrixCamera(0, 0);

  it('emits exactly the box enumeration at exactly cameraZoom', () => {
    const cut = cover(cam)!;
    expect(cut).not.toBeNull();
    for (const cell of cut) expect(cell.z).toBe(MATRIX_ZOOM);

    // The box the incumbent path walks, from the same samples.
    const points = drawnPoints(cam);
    const boxKeys = new Set<string>();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of points) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const n = 2 ** MATRIX_ZOOM;
    for (let x = Math.floor(minX * n); x <= Math.floor(maxX * n); x++) {
      for (let y = Math.floor(minY * n); y <= Math.floor(maxY * n); y++) {
        boxKeys.add(`${MATRIX_ZOOM}/${((x % n) + n) % n}/${y}`);
      }
    }
    expect([...cutKeys(cut)].sort()).toEqual([...boxKeys].sort());
  });

  it('is the only camera whose cut is single-zoom — pitch splits it', () => {
    const flat = new Set(cover(matrixCamera(0, 0))!.map((c) => c.z));
    expect(flat.size).toBe(1);
    const pitched = new Set(cover(matrixCamera(60, 20))!.map((c) => c.z));
    expect(pitched.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// The gate: zero coverage misses across 432 real cameras
// ---------------------------------------------------------------------------

describe('the pitch × bearing matrix (24 × 18 = 432 cameras)', () => {
  it('covers every drawn ground sample at all 432 cameras', () => {
    const misses: string[] = [];
    for (const [pitch, bearing] of MATRIX) {
      const cam = matrixCamera(pitch, bearing);
      const cut = cover(cam);
      if (!cut) {
        misses.push(`p${pitch}/b${bearing} returned null`);
        continue;
      }
      const bad = coverageMisses(cut, drawnPoints(cam), 12, 0);
      if (bad.length > 0) {
        misses.push(`p${pitch}/b${bearing} missed ${bad.length}: ${bad[0]}`);
      }
    }
    expect(misses).toEqual([]);
  });

  it('covers the four screen corners at all 432 cameras', () => {
    // Corner samples are the ones the pre-2026-07-26 two-corner derivation got
    // wrong; they are on the grid above, but pinned separately so a change to
    // the grid density cannot quietly stop testing them.
    const misses: string[] = [];
    for (const [pitch, bearing] of MATRIX) {
      const cam = matrixCamera(pitch, bearing);
      const cut = cover(cam);
      if (!cut) {
        misses.push(`p${pitch}/b${bearing} returned null`);
        continue;
      }
      const corners = drawnPoints(cam, 2);
      const bad = coverageMisses(cut, corners, 12, 0);
      if (bad.length > 0) misses.push(`p${pitch}/b${bearing} corner ${bad[0]}`);
    }
    expect(misses).toEqual([]);
  });

  it('covers the shipped volumetric-demo cameras', () => {
    // storm-4d-isolines p62/b20 and earthquake-columns p55/b15 — the two the
    // chassis matrix pins by name.
    for (const [pitch, bearing] of [
      [62, 20],
      [55, 15],
    ]) {
      const cam = matrixCamera(pitch, bearing);
      const cut = cover(cam)!;
      expect(cut).not.toBeNull();
      expect(coverageMisses(cut, drawnPoints(cam, 41), 12, 0)).toEqual([]);
    }
  });

  it('never emits a cell outside the tile world, and never an empty list', () => {
    for (const [pitch, bearing] of MATRIX) {
      const cut = cover(matrixCamera(pitch, bearing));
      expect(cut, `p${pitch}/b${bearing}`).not.toBeNull();
      expect(cut!.length).toBeGreaterThan(0);
      for (const c of cut!) {
        const n = 2 ** c.z;
        expect(c.z).toBeGreaterThanOrEqual(0);
        expect(c.z).toBeLessThanOrEqual(12);
        expect(c.x).toBeGreaterThanOrEqual(0);
        expect(c.x).toBeLessThan(n);
        expect(c.y).toBeGreaterThanOrEqual(0);
        expect(c.y).toBeLessThan(n);
        expect(c.t).toBe(0);
      }
    }
  });

  it('emits an antichain with no duplicates at all 432 cameras', () => {
    // §8.3's delivery contract: each visible cell reaches the renderer with AT
    // MOST ONE cover. The 2026-07-29 fix removed a parent that double-drew
    // every dot because "covered" was mis-defined; a nested cut is that bug.
    const bad: string[] = [];
    for (const [pitch, bearing] of MATRIX) {
      const cut = cover(matrixCamera(pitch, bearing))!;
      const keys = cutKeys(cut);
      expect(keys.size).toBe(cut.length);
      for (const c of cut) {
        for (let az = 0; az < c.z; az++) {
          const shift = 2 ** (c.z - az);
          const k = `${az}/${Math.floor(c.x / shift)}/${Math.floor(c.y / shift)}`;
          if (keys.has(k))
            bad.push(`p${pitch}/b${bearing}: ${k} ⊃ ${c.z}/${c.x}/${c.y}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('never pays more than the conservative-superset tax over the box', () => {
    // A tile's AABB can pass all six half-spaces without meeting the frustum —
    // that false positive is DESIGNED IN (under-cover is the blank-region bug
    // class), and it is what the handful of extra boundary cells below are.
    // The baseline here is the tightest possible box, drawn around the samples
    // themselves rather than around the chassis's four screen corners, so the
    // real-world margin is wider than this. Measured maximum overshoot across
    // the 432 cameras: 3 cells.
    const worse: string[] = [];
    for (const [pitch, bearing] of MATRIX) {
      const cam = matrixCamera(pitch, bearing);
      const cut = cover(cam)!;
      const aabb = aabbCellCount(drawnPoints(cam), MATRIX_ZOOM);
      if (cut.length > aabb + 4) {
        worse.push(`p${pitch}/b${bearing}: cut ${cut.length} vs aabb ${aabb}`);
      }
    }
    expect(worse).toEqual([]);
  });

  it('is strictly cheaper than the box wherever the box is non-trivial', () => {
    // Below ~32 cells the two are within a tile or two of each other and the
    // comparison is noise. The claim that matters starts here and grows.
    const worse: string[] = [];
    for (const [pitch, bearing] of MATRIX) {
      const cam = matrixCamera(pitch, bearing);
      const aabb = aabbCellCount(drawnPoints(cam), MATRIX_ZOOM);
      if (aabb < 32) continue;
      const cut = cover(cam)!;
      if (cut.length >= aabb) {
        worse.push(`p${pitch}/b${bearing}: cut ${cut.length} vs aabb ${aabb}`);
      }
    }
    expect(worse.length).toBe(0);
  });

  it('is 10× or better once the box stops bounding the frame (pitch ≥ 70)', () => {
    // The recorded Wave 3/A1 baseline is 47 cells across z5–z8 against 754 at
    // z8, i.e. ~16×. The reduction is NOT uniform across the matrix and is not
    // claimed to be: §4.4's erratum records that the axis-aligned box is a fair
    // bound to roughly pitch 65 and only becomes a bound on the HORIZON rather
    // than on the frame past that. Below 70 there is simply nothing to win —
    // measured 1.3–3.1× at pitch 60–65 — and the ratio takes off exactly where
    // the erratum says it should.
    const ratios: Array<[number, number, number]> = [];
    for (const [pitch, bearing] of MATRIX) {
      if (pitch < 70) continue;
      const cam = matrixCamera(pitch, bearing);
      const cut = cover(cam)!;
      const aabb = aabbCellCount(drawnPoints(cam), MATRIX_ZOOM);
      ratios.push([pitch, bearing, aabb / cut.length]);
    }
    expect(ratios.length).toBe(4 * BEARINGS.length);
    for (const [pitch, bearing, ratio] of ratios) {
      expect(
        ratio,
        `p${pitch}/b${bearing} ratio ${ratio.toFixed(1)}`,
      ).toBeGreaterThan(10);
    }
    // ... and past the horizon it clears the recorded 16× outright.
    for (const [pitch, bearing, ratio] of ratios) {
      if (!isAboveHorizon(pitch)) continue;
      expect(ratio, `p${pitch}/b${bearing}`).toBeGreaterThan(16);
    }
  });

  it('keeps pitched cuts BOUNDED, not growing with the far plane', () => {
    // The failure mode this rules out: a frustum that runs to the horizon
    // enumerating a cell list that grows with the far plane rather than with
    // the screen. Measured maximum over the whole matrix: 92 cells.
    for (const [pitch, bearing] of MATRIX) {
      const cut = cover(matrixCamera(pitch, bearing))!;
      expect(cut.length, `p${pitch}/b${bearing}`).toBeLessThan(256);
      expect(cut.length).toBeLessThan(DEFAULT_MAX_COVER_CELLS);
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('returns an identical list, in identical order, for an identical camera', () => {
    for (const [pitch, bearing] of [
      [0, 0],
      [45, 30],
      [62, 20],
      [85, 195],
    ]) {
      const a = cover(matrixCamera(pitch, bearing))!;
      const b = cover(matrixCamera(pitch, bearing))!;
      expect(b).toEqual(a);
      // Fresh option objects, same numbers — no identity or arrival-order
      // dependence anywhere in the walk.
      const c = coverFrustumQuadtree(
        frustumPlanes(matrixCamera(pitch, bearing)),
        coverOpts(matrixCamera(pitch, bearing)),
      )!;
      expect(c).toEqual(a);
    }
  });

  it('does not depend on plane ORDER', () => {
    const cam = matrixCamera(55, 15);
    const planes = frustumPlanes(cam);
    const a = coverFrustumQuadtree(planes, coverOpts(cam))!;
    const b = coverFrustumQuadtree([...planes].reverse(), coverOpts(cam))!;
    expect(new Set(b.map((c) => `${c.z}/${c.x}/${c.y}`))).toEqual(
      new Set(a.map((c) => `${c.z}/${c.x}/${c.y}`)),
    );
  });

  it('is unaffected by a uniform positive rescale of the plane normals', () => {
    // Normals arrive un-normalised from some hosts; the module normalises on
    // entry, so a scaled plane set is the same plane set.
    const cam = matrixCamera(40, 120);
    const planes = frustumPlanes(cam);
    const scaled = planes.map((p, i) => {
      const k = 1 + i;
      return {
        normal: [p.normal[0] * k, p.normal[1] * k, p.normal[2] * k] as Vec3,
        distance: p.distance * k,
      };
    });
    expect(coverFrustumQuadtree(scaled, coverOpts(cam))).toEqual(
      coverFrustumQuadtree(planes, coverOpts(cam)),
    );
  });
});

// ---------------------------------------------------------------------------
// Antimeridian
// ---------------------------------------------------------------------------

describe('the antimeridian', () => {
  it('emits columns from BOTH edges of the world for a seam camera', () => {
    const cam = makeCamera({ lon: 179.98, lat: 10, zoom: 9 });
    const cut = cover(cam)!;
    expect(cut).not.toBeNull();
    const columns = new Set(cut.filter((c) => c.z === 9).map((c) => c.x));
    // The camera straddles x = 1, so the cut must contain the last column and
    // the first — the wrap-at-emit contract, not a 510-of-512 span.
    expect(columns.has(511)).toBe(true);
    expect(columns.has(0)).toBe(true);
    expect(columns.size).toBeLessThan(8);
  });

  it('covers every drawn sample on both sides of the seam', () => {
    for (const lon of [179.98, -179.98, 180, -180]) {
      const cam = makeCamera({ lon, lat: 10, zoom: 9, pitch: 50, bearing: 30 });
      const cut = cover(cam)!;
      expect(cut, `lon ${lon}`).not.toBeNull();
      expect(coverageMisses(cut, drawnPoints(cam, 41), 12, 0)).toEqual([]);
    }
  });

  it('emits wrapped columns only — never a negative or out-of-world x', () => {
    for (const lon of [179.99, -179.99]) {
      for (const pitch of [0, 45, 70]) {
        const cut = cover(makeCamera({ lon, lat: 0, zoom: 10, pitch }))!;
        for (const c of cut) {
          expect(c.x).toBeGreaterThanOrEqual(0);
          expect(c.x).toBeLessThan(2 ** c.z);
        }
      }
    }
  });

  it('declines rather than guessing when the volume wraps the planet', () => {
    // A volume reaching past ±MAX_WORLD_COPIES worlds cannot be enumerated copy
    // by copy in bounded time. The incumbent path already has the right answer
    // for that shape (`normalizeViewportBounds` collapses a ≥360° span; the cell
    // budget picks a zoom), and a truncated cut would be the blank-region
    // symptom class — so the answer is `null`, never a partial list.
    expect(MAX_WORLD_COPIES).toBeGreaterThanOrEqual(1);
    const wide = MAX_WORLD_COPIES + 2;
    const slab: FrustumPlane[] = [
      { normal: [1, 0, 0], distance: wide }, // x >= -wide
      { normal: [-1, 0, 0], distance: wide + 1 }, // x <= wide + 1
      { normal: [0, 1, 0], distance: 1 },
      { normal: [0, -1, 0], distance: 2 },
      { normal: [0, 0, 1], distance: 1 },
      { normal: [0, 0, -1], distance: 1 },
    ];
    expect(
      coverFrustumQuadtree(slab, {
        minZoom: 0,
        maxZoom: 8,
        cameraZoom: 4,
        cameraPosition: [0.5, 0.5, 0.01],
        referenceDistance: 0.01,
      }),
    ).toBeNull();
  });

  it('does NOT decline for an ordinary wide low-zoom camera', () => {
    // The cap is a guard against unbounded enumeration, not a zoom floor: a
    // whole-planet camera is exactly the case the cut handles most cheaply.
    for (const pitch of [0, 30, 60]) {
      const cut = cover(makeCamera({ lon: 0, lat: 0, zoom: 0, pitch }));
      expect(cut, `pitch ${pitch}`).not.toBeNull();
      expect(cut!.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Poles
// ---------------------------------------------------------------------------

describe('the poles', () => {
  it('stays bounded and finite looking at the top of the world', () => {
    for (const lat of [84, 85, 85.05, -84, -85.05]) {
      for (const pitch of [0, 45, 70]) {
        const cam = makeCamera({ lon: 12, lat, zoom: 6, pitch });
        const cut = cover(cam);
        expect(cut, `lat ${lat} pitch ${pitch}`).not.toBeNull();
        expect(cut!.length).toBeGreaterThan(0);
        for (const c of cut!) {
          expect(Number.isInteger(c.z)).toBe(true);
          expect(c.y).toBeGreaterThanOrEqual(0);
          expect(c.y).toBeLessThan(2 ** c.z);
        }
      }
    }
  });

  it('covers every drawn sample inside the Mercator band at the pole', () => {
    for (const lat of [84.5, -84.5]) {
      const cam = makeCamera({
        lon: 12,
        lat,
        zoom: 6,
        pitch: 55,
        bearing: 200,
      });
      const cut = cover(cam)!;
      expect(coverageMisses(cut, drawnPoints(cam, 41), 10, 0)).toEqual([]);
    }
  });

  it('does not collapse a polar tile row (the NaN-row incident)', () => {
    // `latToTileY`'s near-pole cancellation returned NaN and made the row loop
    // enumerate ZERO tiles. This walk never evaluates that expression, so the
    // invariant to pin is simply that a camera parked on the band edge still
    // selects rows.
    const cam = makeCamera({ lon: 0, lat: 85.051_128_779_806_59, zoom: 4 });
    const cut = cover(cam)!;
    expect(cut.length).toBeGreaterThan(0);
    expect(cut.some((c) => c.y === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The altitude slab (A3 parity)
// ---------------------------------------------------------------------------

describe('elevationBounds', () => {
  const cam = makeCamera({
    lon: -74,
    lat: 40.7,
    zoom: 8,
    pitch: 60,
    bearing: 20,
  });

  it('is a superset of the ground cut, and strictly wider', () => {
    const ground = cover(cam)!;
    const slab = cover(cam, { elevationBounds: [0, 15_000] })!;
    const slabKeys = cutKeys(slab);
    for (const c of ground) {
      expect(
        coversCell(slabKeys, 0, c.z, c.x, c.y) ||
          slab.some(
            (s) =>
              s.z > c.z &&
              Math.floor(s.x / 2 ** (s.z - c.z)) === c.x &&
              Math.floor(s.y / 2 ** (s.z - c.z)) === c.y,
          ),
      ).toBe(true);
    }
    expect(slab.length).toBeGreaterThan(ground.length);
  });

  it('covers content drawn at the top of the slab', () => {
    // The A3 case: a 15 km column whose base is off screen but whose top is on
    // screen still has to select its own tile.
    const slab = cover(cam, { elevationBounds: [0, 15_000] })!;
    const tops = drawnPoints(cam, 33, 15_000);
    expect(tops.length).toBeGreaterThan(0);
    expect(coverageMisses(slab, tops, 12, 0)).toEqual([]);
  });

  it('orders a reversed range and ignores a non-finite one', () => {
    const a = cover(cam, { elevationBounds: [0, 15_000] })!;
    const b = cover(cam, { elevationBounds: [15_000, 0] })!;
    expect(b).toEqual(a);
    // Matches the deck chassis's `zRange` handling: a broken range falls back
    // to the ground plane rather than throwing or widening to infinity.
    expect(cover(cam, { elevationBounds: [NaN, 15_000] })).toEqual(cover(cam));
    expect(cover(cam, { elevationBounds: [0, Infinity] })).toEqual(cover(cam));
  });

  it('always contains the ground even when the range does not', () => {
    // Base geometry sits at z = 0 whatever the authored range says.
    const above = cover(cam, { elevationBounds: [5_000, 15_000] })!;
    const groundKeys = cutKeys(cover(cam)!);
    const aboveKeys = cutKeys(above);
    for (const key of groundKeys) {
      const [z, x, y] = key.split('/').map(Number);
      expect(
        coversCell(aboveKeys, 0, z, x, y) ||
          above.some(
            (s) =>
              s.z > z &&
              Math.floor(s.x / 2 ** (s.z - z)) === x &&
              Math.floor(s.y / 2 ** (s.z - z)) === y,
          ),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Zoom range
// ---------------------------------------------------------------------------

describe('the zoom range', () => {
  const cam = matrixCamera(65, 40);

  it('never emits outside [minZoom, maxZoom]', () => {
    for (const [minZoom, maxZoom] of [
      [0, 12],
      [4, 9],
      [7, 7],
      [9, 9],
      [0, 0],
    ]) {
      const cut = cover(cam, { minZoom, maxZoom })!;
      expect(cut, `${minZoom}..${maxZoom}`).not.toBeNull();
      for (const c of cut) {
        expect(c.z).toBeGreaterThanOrEqual(minZoom);
        expect(c.z).toBeLessThanOrEqual(maxZoom);
      }
    }
  });

  it('still covers everything when the range is clamped hard', () => {
    for (const [minZoom, maxZoom] of [
      [4, 6],
      [7, 7],
      [0, 5],
    ]) {
      const cut = cover(cam, { minZoom, maxZoom })!;
      expect(
        coverageMisses(cut, drawnPoints(cam), maxZoom, minZoom),
        `${minZoom}..${maxZoom}`,
      ).toEqual([]);
    }
  });

  it('orders a reversed zoom range instead of emitting nothing', () => {
    expect(cover(cam, { minZoom: 9, maxZoom: 4 })).toEqual(
      cover(cam, { minZoom: 4, maxZoom: 9 }),
    );
  });

  it('degrades to one uniform zoom when the reference distance is unusable', () => {
    // Not a wrong cut, a coarser one: without a focal reference there is no
    // per-branch scale, so every branch takes the camera's own zoom.
    for (const referenceDistance of [0, -1, NaN, Infinity]) {
      const cut = cover(cam, { referenceDistance })!;
      expect(cut, `refDist ${referenceDistance}`).not.toBeNull();
      expect(coverageMisses(cut, drawnPoints(cam), 12, 0)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-open: null, never [], never a throw, never a truncated cut
// ---------------------------------------------------------------------------

describe('degenerate inputs fail open', () => {
  const cam = matrixCamera(45, 30);
  const good = frustumPlanes(cam);

  it('rejects a plane set that is not a bounded volume', () => {
    expect(coverFrustumQuadtree([], coverOpts(cam))).toBeNull();
    expect(coverFrustumQuadtree(good.slice(0, 3), coverOpts(cam))).toBeNull();
    expect(
      coverFrustumQuadtree(null as unknown as FrustumPlane[], coverOpts(cam)),
    ).toBeNull();
  });

  it('rejects non-finite and degenerate planes', () => {
    for (const bad of [
      { normal: [NaN, 0, 1] as Vec3, distance: 0 },
      { normal: [0, Infinity, 1] as Vec3, distance: 0 },
      { normal: [0, 0, 1] as Vec3, distance: NaN },
      { normal: [0, 0, 0] as Vec3, distance: 1 }, // zero-length: not a half-space
      { normal: [1, 2] as unknown as Vec3, distance: 1 }, // too short
      { normal: undefined as unknown as Vec3, distance: 1 },
    ]) {
      const planes = [...good];
      planes[2] = bad as FrustumPlane;
      expect(
        coverFrustumQuadtree(planes, coverOpts(cam)),
        `normal ${JSON.stringify(bad.normal)}`,
      ).toBeNull();
    }
  });

  it('rejects a non-finite camera or zoom rather than selecting garbage', () => {
    const cases: Array<Partial<FrustumCoverOptions>> = [
      { cameraPosition: [NaN, 0, 1] },
      { cameraPosition: [0, Infinity, 1] },
      { cameraPosition: [0, 0, NaN] },
      { cameraPosition: [0, 0] as unknown as Vec3 },
      { cameraPosition: undefined as unknown as Vec3 },
      { cameraZoom: NaN },
      { cameraZoom: Infinity },
      { minZoom: NaN },
      { maxZoom: NaN },
    ];
    for (const over of cases) {
      expect(
        coverFrustumQuadtree(good, coverOpts(cam, over)),
        `options ${JSON.stringify(over)}`,
      ).toBeNull();
    }
  });

  it('returns null — never a truncated cut — when the cell guard trips', () => {
    // The rejected design this pins: dropping enumerated cells to fit a cap.
    // A cut that stops early is indistinguishable on screen from a blank region.
    const full = cover(cam)!;
    expect(full.length).toBeGreaterThan(2);
    const capped = cover(cam, { maxCells: 2 });
    expect(capped).toBeNull();
    // ... and a cap above the real size changes nothing.
    expect(cover(cam, { maxCells: DEFAULT_MAX_COVER_CELLS })).toEqual(full);
  });

  it('returns null, not [], when nothing is visible', () => {
    // A camera below the world looking away: the walk legitimately finds
    // nothing. `null` means "keep your previous selection / use the incumbent
    // path"; `[]` would be read as "nothing is on screen" and blank the map.
    const cam2 = makeCamera({ lon: 0, lat: 0, zoom: 6 });
    const away = frustumPlanes(cam2).map((p) => ({
      normal: [p.normal[0], p.normal[1], p.normal[2]] as Vec3,
      distance: p.distance - 10,
    }));
    const out = coverFrustumQuadtree(away, coverOpts(cam2));
    expect(out === null || out.length > 0).toBe(true);
    // The reachable form of "empty": a far plane in front of the ground.
    const clipped = frustumPlanes(cam2);
    clipped[1] = { normal: clipped[1].normal, distance: -1e6 };
    expect(coverFrustumQuadtree(clipped, coverOpts(cam2))).toBeNull();
  });

  it('never throws, whatever it is handed', () => {
    const hostile: Array<[readonly FrustumPlane[], FrustumCoverOptions]> = [
      [good, coverOpts(cam, { minZoom: -5, maxZoom: 999 })],
      [good, coverOpts(cam, { minZoom: 3.7, maxZoom: 8.2 })],
      [good, coverOpts(cam, { maxCells: 0 })],
      [good, coverOpts(cam, { maxCells: -1 })],
      [good, coverOpts(cam, { maxCells: NaN })],
      [good, coverOpts(cam, { cameraPosition: [1e300, 1e300, 1e300] })],
      [good, coverOpts(cam, { cameraZoom: -50 })],
      [good, coverOpts(cam, { cameraZoom: 1e6 })],
      [good, coverOpts(cam, { referenceDistance: 1e-300 })],
      [good, coverOpts(cam, { elevationBounds: [-1e12, 1e12] })],
      [
        good.map((p) => ({ normal: p.normal, distance: p.distance * 1e12 })),
        coverOpts(cam),
      ],
      [
        good.map(() => ({
          normal: [1e-300, 1e-300, 1e-300] as Vec3,
          distance: 0,
        })),
        coverOpts(cam),
      ],
    ];
    for (const [planes, opts] of hostile) {
      let out: TileId[] | null | undefined;
      expect(() => {
        out = coverFrustumQuadtree(planes, opts);
      }).not.toThrow();
      // The invariant that matters: never an empty list.
      expect(out === null || (out as TileId[]).length > 0).toBe(true);
    }
  });

  it('clamps a silly zoom range instead of failing', () => {
    const cut = cover(cam, { minZoom: -5, maxZoom: 999 });
    expect(cut).not.toBeNull();
    for (const c of cut!) {
      expect(c.z).toBeGreaterThanOrEqual(0);
      expect(c.z).toBeLessThanOrEqual(26);
    }
  });
});

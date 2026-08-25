// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

/**
 * FS-3 — what a MIXED-ZOOM working set means at the renderer, and the
 * acceptance gate for flipping `selectionMode` to `'frustum'`.
 *
 * ## The two halves of §8.3's delivery contract
 *
 * FS-2 changed what gets FETCHED: a frustum-quadtree cut addresses a mixed-zoom
 * antichain of cells instead of enumerating one box per zoom. This file is
 * about what the tileset then DELIVERS, and the contract has exactly two
 * clauses, which fail in opposite directions:
 *
 * 1. **No blank cell that residency could fill.** Under-delivery is the
 *    2026-07-26 class: a map that says "no data here" rather than raising an
 *    error. Asserted two ways — one-sidedly against a ray-traced ground oracle
 *    at every camera (clause 1), and structurally, that a cut member which
 *    loaded is a cut member which is drawn (clause 1b).
 * 2. **At most ONE cover per visible cell** (the antichain). Over-delivery is
 *    the 2026-07-29 class: the z10/z11 regression where a parent shipped
 *    alongside its own loaded children and every dot drew twice. On a
 *    no-thinning archive each redundant parent level is a complete extra copy
 *    of the data.
 *
 * Both are hard for the same reason. `getVisibleTiles` derives ONE `primaryZoom`
 * (the deepest needed zoom) and classifies everything coarser as a fallback
 * PARENT, judged by the oversized-parent clamp: "is some child cell of yours, at
 * the deepest zoom, inside the viewport box and still uncovered?". Under a cut
 * that question is malformed, because a cut member is not a fallback — it is the
 * intended cover for its own patch of ground, at its own zoom. Ask it anyway and
 * it answers wrongly in both directions: YES forever for a near-field ancestor
 * (nothing will ever cover z10 cells the cut never asked for → over-delivery),
 * and NO for a far-field member whose block sits at the box edge (zero cells to
 * scan → the tile is discarded → under-delivery).
 *
 * ## Standing finding (read this before trusting a green run)
 *
 * Measured over all 432 cameras on 2026-08-11:
 *
 * - **Clause 1 passes** under both refinement strategies — but see below.
 * - **Clause 1b fails**: 142 of 432 cameras drop at least one LOADED, resident
 *   cut member from delivery, up to 14 cells at once.
 * - **Clause 2 fails** under the default `'best-available'`: 367 of 432 cameras
 *   deliver an ancestor on top of its own descendant, worst case 985 such pairs
 *   and 2.0× overdraw. It holds under `'no-overlap'`, which requests no
 *   stand-ins at all — so the machinery upstream of the parent pass is sound.
 * - **The two defects mask each other.** Clause 1 passes only because
 *   `best-available`'s redundant stand-in band happens to blanket the cells
 *   clause 1b drops. Fix the over-delivery without fixing the cut-zoom keying
 *   and the over-delivery bug becomes an UNDER-delivery bug — the strictly worse
 *   one. `is why clause 1 currently passes only by ACCIDENT` states this in
 *   executable form; treat it as a warning to whoever lands the repair.
 *
 * The repair is FS-3's `getVisibleTiles` generalization (cover keys become
 * cell-at-cut-zoom instead of the global-`primaryZoom` `"x/y/t"` strings), which
 * lives in `spatiotemporal-tileset.ts` — a file outside this item's ownership
 * slice, so it is reported as a cross-item dependency rather than written here.
 * The three failing clauses are therefore marked `it.fails`: they pass today by
 * failing, and the moment the generalization lands they go RED and must be
 * converted to plain `it`. That is deliberate. A gate that silently starts
 * passing is a gate nobody notices, and this one decides whether a default gets
 * flipped.
 *
 * ## Why the camera harness is rebuilt here
 *
 * `@poopdeck.gl/core` is framework-free by contract
 * (`kernel-framework-free.test.ts`) and carries no deck dependency, so the
 * 24 × 18 pitch × bearing matrix — the oracle that caught the 2026-07-26
 * incident, `packages/layers/test/chassis-viewport-bounds.test.ts` — is rebuilt
 * from deck's conventions in arithmetic. It is duplicated from
 * `frustum-cover.test.ts` on purpose: the cover primitive consumes PLANES and
 * the oracle consumes RAYS, so agreement between them is evidence rather than
 * tautology, and a shared helper would only have made one sign convention agree
 * with itself.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  coverFrustumQuadtree,
  lonLatToCoverPoint,
  coverPointToLonLat,
  type FrustumPlane,
} from '../src/geo/frustum-cover';
import {
  DEFAULT_CELL_BUDGET_HYSTERESIS,
  DEFAULT_VIEWPORT_CELL_BUDGET,
  fitZoomToCellBudget,
  isCellBudgetInert,
  viewportCellCount,
} from '../src/tile-budget';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import type { BoundingBox, TileId } from '../src/types';
import { fakeTile, flush } from './helpers/fixtures';

// ---------------------------------------------------------------------------
// A deck-shaped camera, in cover space, with no deck
// ---------------------------------------------------------------------------

const DEG2RAD = Math.PI / 180;
const TILE_PX = 512;
/** deck's `focalDistance` / `altitude`: the camera sits 1.5 screen-heights out. */
const ALTITUDE = 1.5;
const HALF_FOV = Math.atan(0.5 / ALTITUDE); // 18.435°
const NEAR_Z_MULTIPLIER = 0.1;
const FAR_Z_MULTIPLIER = 1.01;

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
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function makeCamera({
  lon,
  lat,
  zoom,
  pitch = 0,
  bearing = 0,
  width = 1000,
  height = 1000,
}: {
  lon: number;
  lat: number;
  zoom: number;
  pitch?: number;
  bearing?: number;
  width?: number;
  height?: number;
}): Camera {
  const pxPerCover = TILE_PX * 2 ** zoom;
  const altUnit = height / pxPerCover;
  const referenceDistance = ALTITUDE * altUnit;
  const p = pitch * DEG2RAD;
  const b = bearing * DEG2RAD;
  const target = lonLatToCoverPoint(lon, lat, 0);
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
  // math.gl's pitch-dependent far plane; the `0.01` floor is what keeps a
  // past-the-horizon frustum finite.
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
  };
}

/** The six INWARD half-spaces of `cam`. */
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
 * Ground samples the camera actually draws, on a uniform pixel grid — the
 * clause-1 oracle. The keep test is the clip test: in front of the eye and
 * between the near and far planes in axial depth.
 *
 * 49 × 49 rays, and the SAME set feeds {@link boundsOf}. That pairing is
 * load-bearing: the incumbent box is an AABB of what is on screen, so deriving
 * it from a COARSER grid than the one used to probe manufactures a mismatch —
 * a probe point outside the box lands in ground the box never asked for, and
 * `getVisibleTiles`' oversized-parent clamp (judged against the box) then reads
 * as a coverage bug that is really a sampling bug. Measured both ways: at a
 * 25-ray box with a 121-ray probe, 24 pitch-75 cameras "miss"; self-consistent,
 * none do. The real hazard that mismatch was pointing at is caught directly by
 * `every loaded cut member is delivered` below, which needs no sampling at all.
 */
function drawnPoints(cam: Camera, samples = 49): Array<[number, number]> {
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
      const tau = (0 - e[2]) / dz;
      if (!(tau > 0) || tau < cam.near || tau > cam.far) continue;
      const x = e[0] + tau * dx;
      const y = e[1] + tau * dy;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (y < 0 || y > 1) continue;
      out.push([x, y]);
    }
  }
  return out;
}

/** The lon/lat AABB around everything on screen — the incumbent box path's input. */
function boundsOf(
  points: ReadonlyArray<readonly [number, number]>,
): BoundingBox {
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
  const [minLon, maxLat] = coverPointToLonLat(minX, minY);
  const [maxLon, minLat] = coverPointToLonLat(maxX, maxY);
  return { minLon, minLat, maxLon, maxLat };
}

// ---------------------------------------------------------------------------
// The archive under test, and the delivery oracles
// ---------------------------------------------------------------------------

const MIN_Z = 0;
const MAX_Z = 12;
/** The camera zoom the matrix is flown at, matching `frustum-cover.test.ts`. */
const MATRIX_ZOOM = 9;
const MATRIX_LON = -74;
const MATRIX_LAT = 40.7;
/** One bucket, so `t` never confounds a cover comparison. */
const T0 = 0;

function cutFor(cam: Camera): TileId[] {
  const cut = coverFrustumQuadtree(frustumPlanes(cam), {
    minZoom: MIN_Z,
    maxZoom: MAX_Z,
    cameraZoom: cam.zoom,
    cameraPosition: cam.position,
    referenceDistance: cam.referenceDistance,
  });
  // Every matrix camera produces a cut (pinned in `frustum-cover.test.ts`); a
  // `null` here would silently route to the box path and measure nothing.
  if (!cut)
    throw new Error('cover primitive returned null for a matrix camera');
  return cut;
}

function latToTileRow(lat: number, z: number): number {
  const n = 2 ** z;
  const s = Math.sin(Math.min(85.05, Math.max(-85.05, lat)) * DEG2RAD);
  const y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
  return Math.min(n - 1, Math.max(0, y));
}

/** `boundsToTiles`' row/column loop, for the box-path A/B. */
function boxCells(b: BoundingBox, z: number): TileId[] {
  const n = 2 ** z;
  const out: TileId[] = [];
  const x0 = Math.floor(((b.minLon + 180) / 360) * n);
  const x1 = Math.floor(((b.maxLon + 180) / 360) * n);
  for (let y = latToTileRow(b.maxLat, z); y <= latToTileRow(b.minLat, z); y++) {
    for (let x = x0; x <= x1; x++) {
      out.push({ z, x: ((x % n) + n) % n, y, t: T0 });
    }
  }
  return out;
}

/**
 * A dense synthetic archive: every addressed cell exists at every zoom and
 * resolves immediately. That is the no-thinning default this project ships, and
 * it is the worst case for clause 2 — every redundant parent really is a full
 * extra copy.
 */
function makeTileset(opts: {
  strategy?: 'best-available' | 'no-overlap';
  requested?: TileId[];
  boxEnumerate?: boolean;
}) {
  return new SpatioTemporalTileset({
    minZoom: MIN_Z,
    maxZoom: MAX_Z,
    enablePrefetch: false,
    refinementStrategy: opts.strategy ?? 'best-available',
    temporalBucketMs: 1000,
    getAvailableTiles: async (bounds, z) => {
      if (!opts.boxEnumerate) return [];
      const out = boxCells(bounds, z);
      opts.requested?.push(...out);
      return out;
    },
    getAvailableTilesForCells: async (cells) => {
      const out = cells.map((c) => ({ z: c.z, x: c.x, y: c.y, t: T0 }));
      opts.requested?.push(...out);
      return out;
    },
    getTileData: async (id: TileId) => fakeTile(id),
  });
}

/** Cells the incumbent box path would need: its primary zoom plus its parents. */
function boxNeededCount(
  bounds: BoundingBox,
  zoom: number,
  parents = 4,
): number {
  let total = 0;
  for (let z = zoom; z >= Math.max(MIN_Z, zoom - parents); z--) {
    total += viewportCellCount(bounds, z);
  }
  return total;
}

const cellKey = (id: TileId): string => `${id.z}/${id.x}/${id.y}/${id.t}`;

/**
 * Delivered pairs that violate the single-cover clause: a tile shipped
 * alongside an ANCESTOR of itself in the same time bucket. Each pair is one
 * region drawn twice.
 */
function coverViolations(delivered: readonly TileId[]): string[] {
  const keys = new Set(delivered.map(cellKey));
  const out: string[] = [];
  for (const id of delivered) {
    for (let z = id.z - 1; z >= MIN_Z; z--) {
      const shift = 2 ** (id.z - z);
      const anc = `${z}/${Math.floor(id.x / shift)}/${Math.floor(id.y / shift)}/${id.t}`;
      if (keys.has(anc)) out.push(`${cellKey(id)} under ${anc}`);
    }
  }
  return out;
}

/** Is the cell under this cover-space point covered by a delivered tile? */
function deliveredCovers(
  keys: Set<string>,
  x: number,
  y: number,
  probeZoom: number,
): boolean {
  const n = 2 ** probeZoom;
  const cx = ((Math.floor(x * n) % n) + n) % n;
  const cy = Math.min(n - 1, Math.max(0, Math.floor(y * n)));
  for (let z = probeZoom; z >= MIN_Z; z--) {
    const shift = 2 ** (probeZoom - z);
    const k = `${z}/${Math.floor(cx / shift)}/${Math.floor(cy / shift)}/${T0}`;
    if (keys.has(k)) return true;
  }
  return false;
}

/**
 * Let the tileset settle. `isLoaded` is the tileset's own "nothing queued, no
 * needed tile in flight" predicate, so this waits on the real signal rather
 * than on a tick count that would silently under-settle a big cut.
 */
async function settle(
  ts: SpatioTemporalTileset,
  maxTicks = 200,
): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    await flush();
    if (ts.isLoaded && ts.getVisibleTiles().length > 0) return;
  }
}

// ---------------------------------------------------------------------------
// The matrix, swept ONCE
// ---------------------------------------------------------------------------

const BEARINGS = Array.from({ length: 24 }, (_, i) => i * 15); // 0…345
const PITCHES = Array.from({ length: 18 }, (_, i) => i * 5); // 0…85
const MATRIX: Array<[number, number]> = [];
for (const bearing of BEARINGS) {
  for (const pitch of PITCHES) MATRIX.push([pitch, bearing]);
}

/** Deck's own above-horizon test: the top of the frustum is at or past level. */
function isAboveHorizon(pitch: number): boolean {
  return HALF_FOV > (90 - pitch) * DEG2RAD - 0.01;
}

function matrixCamera(pitch: number, bearing: number): Camera {
  return makeCamera({
    lon: MATRIX_LON,
    lat: MATRIX_LAT,
    zoom: MATRIX_ZOOM,
    pitch,
    bearing,
  });
}

interface CameraFact {
  pitch: number;
  bearing: number;
  /** Cells in the frustum cut itself. */
  cut: number;
  /** Cells the tileset actually asked the directory for (cut + stand-ins). */
  requested: number;
  /** Tiles `getVisibleTiles` handed the renderer. */
  delivered: number;
  /** Drawn ground samples no delivered tile covers — clause 1. */
  blanks: number;
  /** Delivered ancestor/descendant pairs — clause 2. */
  doubleCovers: number;
  /** Cells the un-budgeted box path would need (the pre-budget baseline). */
  boxCells: number;
  /** Cells the SHIPPED, budget-clamped box path would need. */
  budgetedBoxCells: number;
  /** Cells in the box at the camera's own zoom, for the budget assertion. */
  boxCellsAtCameraZoom: number;
  /** The zoom `fitZoomToCellBudget` hands the fallback path. */
  budgetedZoom: number;
  /** Deepest zoom the cut addresses. */
  cutMaxZoom: number;
  /** Cut members that LOADED but never reached the renderer — clause 1b. */
  droppedCutCells: number;
}

/**
 * The two shipped pitched demo cameras, pinned in
 * `chassis-viewport-bounds.test.ts`. Neither lands on the matrix grid (pitch 62
 * and bearing 20 / 15 are off its 5° × 15° lattice), so they are swept
 * separately rather than looked up in it.
 */
const SHIPPED_CAMERAS: Array<[string, number, number]> = [
  ['storm-4d-isolines', 62, 20],
  ['earthquake-columns', 55, 15],
];

async function sweep(
  strategy: 'best-available' | 'no-overlap',
  cameras: ReadonlyArray<readonly [number, number]> = MATRIX,
): Promise<CameraFact[]> {
  const facts: CameraFact[] = [];
  for (const [pitch, bearing] of cameras) {
    const cam = matrixCamera(pitch, bearing);
    const cut = cutFor(cam);
    const points = drawnPoints(cam);
    const bounds = boundsOf(points);
    const requested: TileId[] = [];
    const ts = makeTileset({ strategy, requested });
    ts.update(
      { bounds, zoom: MATRIX_ZOOM, time: T0, timeWindow: 100, tileCells: cut },
      true,
    );
    await settle(ts);
    const delivered = ts.getVisibleTiles().map((t) => t.id);
    const keys = new Set(delivered.map(cellKey));
    let blanks = 0;
    for (const [x, y] of points) {
      if (!deliveredCovers(keys, x, y, MAX_Z)) blanks++;
    }
    const budgetedZoom = fitZoomToCellBudget(bounds, MATRIX_ZOOM, {
      minZoom: MIN_Z,
      maxCells: DEFAULT_VIEWPORT_CELL_BUDGET,
    });
    facts.push({
      pitch,
      bearing,
      cut: cut.length,
      droppedCutCells: cut.filter(
        (c) => !keys.has(`${c.z}/${c.x}/${c.y}/${T0}`),
      ).length,
      requested: requested.length,
      delivered: delivered.length,
      blanks,
      doubleCovers: coverViolations(delivered).length,
      boxCells: boxNeededCount(bounds, MATRIX_ZOOM),
      budgetedBoxCells: boxNeededCount(bounds, budgetedZoom),
      boxCellsAtCameraZoom: viewportCellCount(bounds, MATRIX_ZOOM),
      budgetedZoom,
      cutMaxZoom: Math.max(...cut.map((c) => c.z)),
    });
    ts.finalize();
  }
  return facts;
}

let BEST_AVAILABLE: CameraFact[] = [];
let NO_OVERLAP: CameraFact[] = [];
let SHIPPED: CameraFact[] = [];

beforeAll(async () => {
  BEST_AVAILABLE = await sweep('best-available');
  NO_OVERLAP = await sweep('no-overlap');
  SHIPPED = await sweep(
    'best-available',
    SHIPPED_CAMERAS.map(([, pitch, bearing]) => [pitch, bearing] as const),
  );
}, 300_000);

const label = (f: CameraFact) => `p${f.pitch}/b${f.bearing}`;

// ---------------------------------------------------------------------------
// Clause 1 — no blank cell that residency could fill
// ---------------------------------------------------------------------------

describe('clause 1: the delivered set covers everything the camera draws', () => {
  it('has ZERO blank samples at all 432 cameras (best-available)', () => {
    // The gate, in the same one-sided shape as the 2026-07-26 oracle: extra
    // delivered tiles are never a finding HERE (clause 2 owns those), a missing
    // one always is.
    expect(
      BEST_AVAILABLE.filter((f) => f.blanks > 0).map(
        (f) => `${label(f)} blanks=${f.blanks}`,
      ),
    ).toEqual([]);
  });

  it('has ZERO blank samples at all 432 cameras (no-overlap)', () => {
    // `no-overlap` requests NO coarse stand-ins at all, so the cut is the only
    // thing that can cover the frame. All ten storm4d tilesets run this
    // strategy, so it is not a corner case — it is the shipped 3-D config.
    expect(
      NO_OVERLAP.filter((f) => f.blanks > 0).map(
        (f) => `${label(f)} blanks=${f.blanks}`,
      ),
    ).toEqual([]);
  });

  it('delivers something at every camera — never an empty frame', () => {
    expect(BEST_AVAILABLE.filter((f) => f.delivered === 0).map(label)).toEqual(
      [],
    );
    expect(NO_OVERLAP.filter((f) => f.delivered === 0).map(label)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Clause 1b — the cut is the intended cover, so delivery must not drop it
// ---------------------------------------------------------------------------

describe('clause 1b: every LOADED cut member reaches the renderer', () => {
  // Stronger than the sample oracle and independent of it. A cut member is, by
  // construction, a cell the camera can see; if it is resident and decoded and
  // still does not get delivered, its ground is being painted by luck (a
  // neighbouring stand-in) or not at all. This is the assertion that survives
  // any argument about how densely to sample.
  //
  // WHY IT USED TO FAIL. `getVisibleTiles` classified every needed tile
  // shallower than the deepest needed zoom as a fallback PARENT, and pass 2
  // judged it by the oversized-parent clamp: "is some child cell, at the
  // deepest zoom, inside the viewport box and uncovered?". A far-field cut
  // member whose block sat at or past the box edge intersected that clamp in
  // ZERO cells, the inner loops never ran, `needed` stayed false — and the
  // cell the camera was looking at was discarded. Repaired with E3
  // (tile-loading audit 2026-08): pass 2 now tells a cut member from a
  // placeholder (`selectionCutKeys`) and delivers it on its own account.

  it('no loaded cut member is dropped (no-overlap) — FS-3 clause 1b', () => {
    expect(
      NO_OVERLAP.filter((f) => f.droppedCutCells > 0).map(
        (f) => `${label(f)} dropped=${f.droppedCutCells}/${f.cut}`,
      ),
    ).toEqual([]);
  });

  it('records that the drop is gone at every camera, under both strategies', () => {
    // Measured 2026-08-11 (pre-repair): 142 of 432 cameras dropped at least
    // one loaded cut member, worst case 14 cells at once. Live assertions on
    // the repaired figure, so a regression is caught with its scale.
    expect(
      NO_OVERLAP.filter((f) => f.droppedCutCells > 0).map(
        (f) => `${label(f)} dropped=${f.droppedCutCells}/${f.cut}`,
      ),
    ).toEqual([]);
    expect(
      BEST_AVAILABLE.filter((f) => f.droppedCutCells > 0).map(
        (f) => `${label(f)} dropped=${f.droppedCutCells}/${f.cut}`,
      ),
    ).toEqual([]);
  });

  it('clause 1 no longer depends on the overdraw masking the drop', () => {
    // Pre-repair the two defects masked each other: `best-available`'s
    // redundant stand-in band (clause 2's overdraw) blanketed the cut members
    // pass 2 dropped, so the drawn samples stayed covered by accident. Both
    // halves were repaired together (E3 + the cut-member rule) — the only
    // order that never turns over-delivery into under-delivery — and this
    // pins that coverage now holds with NEITHER defect in play.
    expect(BEST_AVAILABLE.every((f) => f.droppedCutCells === 0)).toBe(true);
    expect(BEST_AVAILABLE.every((f) => f.blanks === 0)).toBe(true);
    expect(NO_OVERLAP.every((f) => f.doubleCovers === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Clause 2 — at most one cover per visible cell
// ---------------------------------------------------------------------------

describe('clause 2: the single-cover contract', () => {
  it('holds under no-overlap: the delivered set IS an antichain', () => {
    // Proof that the cut, the cell-addressed slice and the needed-set machinery
    // are all sound: with no stand-ins in the working set, nothing nests.
    // Whatever is wrong under `best-available` is wrong in the PARENT pass, not
    // upstream of it.
    expect(
      NO_OVERLAP.filter((f) => f.doubleCovers > 0).map(
        (f) => `${label(f)} pairs=${f.doubleCovers}`,
      ),
    ).toEqual([]);
  });

  // ── The clauses below are the FS-3 repair's acceptance ──
  //
  // They carried `it.fails` until E3 (tile-loading audit 2026-08) repaired
  // the pass-2 rule: a cell keeps a parent only while a tile EXISTS there and
  // is pending, and on the cut path a stand-in only while a cut member it
  // covers is pending. The expectations are unchanged — they ARE the contract.

  it('no ancestor is delivered alongside its own descendant — FS-3 clause 2', () => {
    expect(
      BEST_AVAILABLE.filter((f) => f.doubleCovers > 0).map(
        (f) => `${label(f)} pairs=${f.doubleCovers}`,
      ),
    ).toEqual([]);
  });

  it('delivery never exceeds the cut it was selected for — FS-3 clause 2', () => {
    // The renderer-facing statement of the same defect. A cut is the intended
    // cover; anything beyond it that is not covering a genuinely pending cell
    // is a second copy of ground already painted.
    expect(
      BEST_AVAILABLE.filter((f) => f.delivered > f.cut).map(
        (f) => `${label(f)} cut=${f.cut} delivered=${f.delivered}`,
      ),
    ).toEqual([]);
  });

  it('records the repaired figures, so a regression is caught with its scale', () => {
    // Measured 2026-08-11 (pre-repair): worst 985 ancestor/descendant pairs
    // at one camera, worst overdraw 2.0× (24 tiles delivered for a 12-cell
    // cut). Post-repair: zero pairs anywhere and delivery never above the cut
    // — including the FLAT-with-bearing cameras that made this a
    // delivery-KEYING bug rather than a pitched-frustum edge case. (At bearing
    // 0 the frustum is axis-aligned and the cut degenerates to the box, which
    // is why bearing 0 alone never caught it, the 2026-07-26 lesson.)
    const worst = Math.max(...BEST_AVAILABLE.map((f) => f.doubleCovers));
    const maxOverdraw = Math.max(
      ...BEST_AVAILABLE.map((f) => f.delivered / f.cut),
    );
    expect(worst).toBe(0);
    expect(maxOverdraw).toBeLessThanOrEqual(1);
    const flat = BEST_AVAILABLE.filter((f) => f.pitch === 0);
    expect(flat.filter((f) => f.doubleCovers > 0).map(label)).toEqual([]);
  });

  it('the box path and the cut path both deliver an antichain (the A/B that localized the defect)', async () => {
    // Same camera, same archive, same strategy — the only difference is
    // whether `tileCells` is supplied. The box path always delivered a clean
    // antichain because every cell at its primary zoom IS selected, so pass
    // 2's cover set could become complete; the cut path now does too.
    const cam = matrixCamera(0, 30);
    const bounds = boundsOf(drawnPoints(cam));

    const box = makeTileset({ strategy: 'best-available', boxEnumerate: true });
    box.update({ bounds, zoom: MATRIX_ZOOM, time: T0, timeWindow: 100 }, true);
    await settle(box);
    const boxDelivered = box.getVisibleTiles().map((t) => t.id);
    box.finalize();

    expect(boxDelivered.length).toBeGreaterThan(0);
    expect(coverViolations(boxDelivered)).toEqual([]);
    expect(
      BEST_AVAILABLE.find((f) => f.pitch === 0 && f.bearing === 30)!
        .doubleCovers,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The cut transition — where a gap would hide
// ---------------------------------------------------------------------------

describe('a pitch sweep on ONE tileset', () => {
  async function sweepCoverage(pitches: number[]): Promise<string[]> {
    const ts = makeTileset({ strategy: 'best-available' });
    const gaps: string[] = [];
    for (const pitch of pitches) {
      const cam = matrixCamera(pitch, 30);
      const points = drawnPoints(cam);
      ts.update(
        {
          bounds: boundsOf(points),
          zoom: MATRIX_ZOOM,
          time: T0,
          timeWindow: 100,
          tileCells: cutFor(cam),
        },
        true,
      );
      await settle(ts);
      const keys = new Set(ts.getVisibleTiles().map((t) => cellKey(t.id)));
      let blanks = 0;
      for (const [x, y] of points) {
        if (!deliveredCovers(keys, x, y, MAX_Z)) blanks++;
      }
      if (blanks > 0) gaps.push(`p${pitch} blanks=${blanks}/${points.length}`);
    }
    ts.finalize();
    return gaps;
  }

  it('never blanks on the way UP (0 → 85) while the cut re-shapes', async () => {
    // The transition frames are the dangerous ones: the working set is being
    // replaced cell by cell, `neededTileKeys` churns, and a keying bug shows up
    // as one frame of missing ground rather than as a steady-state miss. Driven
    // on a SINGLE tileset so residency carries across frames exactly as it does
    // during a real camera move.
    expect(
      await sweepCoverage(Array.from({ length: 18 }, (_, i) => i * 5)),
    ).toEqual([]);
  }, 120_000);

  it('never blanks on the way back DOWN (85 → 0), reusing residency', async () => {
    // The other direction is the one the stand-in passes exist for: the cut
    // coarsens, and the cells it now names may not be resident while the finer
    // ones it just left are. Coverage must not dip in that window.
    expect(
      await sweepCoverage(Array.from({ length: 18 }, (_, i) => 85 - i * 5)),
    ).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The cell budget goes inert — §8.2, subsumed rather than tuned
// ---------------------------------------------------------------------------

describe('fitZoomToCellBudget under frustum selection', () => {
  it('is INERT for the cut at all 432 cameras', () => {
    // FS-3's stated precondition: the §8.2 stopgap can no longer reach the
    // frustum path's selection. Asserted through the module's own predicate so
    // the criterion and the mechanism cannot drift apart.
    expect(
      BEST_AVAILABLE.filter((f) => !isCellBudgetInert(f.cut)).map(
        (f) => `${label(f)} cut=${f.cut}`,
      ),
    ).toEqual([]);
    // ... with room to spare, not by a hair. Measured max cut is 92 cells
    // against a 256 budget.
    expect(Math.max(...BEST_AVAILABLE.map((f) => f.cut))).toBeLessThanOrEqual(
      DEFAULT_VIEWPORT_CELL_BUDGET / 2,
    );
  });

  it('is inert for the cut PLUS its stand-ins, which is what gets fetched', () => {
    // The cut alone understates the working set: `cutAncestors` adds a
    // per-branch parent band. The budget has to be inert for the thing actually
    // requested, or "inert" is a word about the wrong number.
    expect(
      BEST_AVAILABLE.filter((f) => !isCellBudgetInert(f.requested)).map(
        (f) => `${label(f)} requested=${f.requested}`,
      ),
    ).toEqual([]);
  });

  it('is emphatically NOT inert on the fallback path — so it stays', () => {
    // The other half of the instruction: keep the backstop. Above the horizon
    // the ground box blows past the budget, and the box path is still what
    // serves `selectionMode: 'aabb'`, foreign viewports, and any camera the
    // cover primitive refuses.
    const overBudget = BEST_AVAILABLE.filter(
      (f) => !isCellBudgetInert(f.boxCellsAtCameraZoom),
    );
    expect(overBudget.length).toBeGreaterThan(0);
    expect(overBudget.every((f) => f.pitch >= 60)).toBe(true);
  });

  it('leaves the §8.2 constants exactly where they were', () => {
    // Register territory: no tuning before, during or after this work without
    // new evidence. Pinned so a drive-by "optimization" has to argue with a test.
    expect(DEFAULT_VIEWPORT_CELL_BUDGET).toBe(256);
    expect(DEFAULT_CELL_BUDGET_HYSTERESIS).toBe(0.25);
  });

  it('reports inert for the kill switch and refuses to guess on a bad count', () => {
    expect(isCellBudgetInert(1e9, { maxCells: Infinity })).toBe(true);
    expect(isCellBudgetInert(1, { maxCells: 0 })).toBe(true);
    expect(isCellBudgetInert(NaN)).toBe(false);
    expect(isCellBudgetInert(-1)).toBe(false);
    expect(isCellBudgetInert(DEFAULT_VIEWPORT_CELL_BUDGET)).toBe(true);
    expect(isCellBudgetInert(DEFAULT_VIEWPORT_CELL_BUDGET + 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The prize, measured — O5's acceptance row
// ---------------------------------------------------------------------------

describe('O5: fetch reduction at high pitch, at verified coverage', () => {
  /**
   * Two baselines, because they answer different questions and only one of them
   * is what the fleet runs today:
   *
   * - PRE-BUDGET: the raw box at the camera's own zoom plus its parent band.
   *   This is the regime the recorded 754-vs-47 figure was measured in, before
   *   `tile-budget.ts` existed.
   * - SHIPPED: the same box after `fitZoomToCellBudget`. The budget already
   *   spends the above-horizon blow-up as a coarser zoom, so it has ALREADY
   *   collected most of the count win — at the cost of degrading the whole
   *   screen's detail, which is exactly what the cut does not do.
   *
   * Both are counted against `requested` — the cells the tileset actually asked
   * the directory for, cut PLUS stand-ins — not against the cut alone. Counting
   * the cut alone would flatter the frustum path by a factor of ~1.7.
   */
  const ratioPre = (f: CameraFact) => f.boxCells / Math.max(1, f.requested);
  const ratioShipped = (f: CameraFact) =>
    f.budgetedBoxCells / Math.max(1, f.requested);

  it('≥ 10× fewer requested tiles vs the PRE-BUDGET box at pitch ≥ 70', () => {
    // Where the recorded prize actually lives, and it reproduces: measured
    // 13.3×–33.9× across these 96 cameras, so 10 is a floor with headroom
    // rather than a fitted number. Coverage at these very cameras is verified
    // by clause 1 — a reduction at equal coverage, not a truncation.
    expect(
      BEST_AVAILABLE.filter((f) => f.pitch >= 70)
        .filter((f) => ratioPre(f) < 10)
        .map((f) => `${label(f)} ratio=${ratioPre(f).toFixed(2)}`),
    ).toEqual([]);
  });

  it('does NOT reach 10× at pitch 60–65 — the criterion is horizon-shaped', () => {
    // Recorded as a finding, not asserted away. O5's row says "pitch ≥ 60", but
    // the blow-up the cut removes is the HORIZON BAND, and at pitch 60–65 the
    // ground box is still a decent approximation of the frame: measured
    // ~1.1×–2.8×. The 754-vs-47 baseline was an above-horizon camera. Both
    // shipped pitched demo cameras (storm-4d-isolines p62, earthquake-columns
    // p55) sit in this band, so the flip's user-visible win THERE is detail
    // placement, not fetch count.
    const band = BEST_AVAILABLE.filter((f) => f.pitch >= 60 && f.pitch <= 65);
    expect(band.length).toBe(2 * BEARINGS.length);
    expect(Math.max(...band.map(ratioPre))).toBeLessThan(10);
    // It is still a reduction at every camera in the band, which is the part
    // that makes the criterion's spirit hold even where its number does not.
    expect(band.filter((f) => ratioPre(f) < 1).map(label)).toEqual([]);
  });

  it('never requests MORE than the pre-budget box above the horizon', () => {
    expect(
      BEST_AVAILABLE.filter(
        (f) => isAboveHorizon(f.pitch) && ratioPre(f) < 1,
      ).map(label),
    ).toEqual([]);
  });

  it('is never a blow-up below the horizon — bounded, sometimes slightly more', () => {
    // Honest accounting, mirroring the chassis file: below the horizon the cut
    // spends some of its budget REFINING the near field, so its cell count can
    // exceed the box's. Those cells are one zoom deeper and correspondingly
    // smaller, but it must not be free to grow. Measured worst is ~1.4× the box.
    expect(
      BEST_AVAILABLE.filter((f) => ratioPre(f) < 0.5).map(
        (f) => `${label(f)} ratio=${ratioPre(f).toFixed(2)}`,
      ),
    ).toEqual([]);
  });

  it('against the SHIPPED budget-clamped box the win is single-digit, not 10×', () => {
    // The comparison that decides a flip, and the one that deflates the
    // headline. `fitZoomToCellBudget` already converts the above-horizon
    // blow-up into a coarser zoom, so most of the count win was collected in
    // 2026-07. Pinned as a BAND rather than a target: never worse than ~1.4×
    // the shipped box anywhere, and a genuine reduction above the horizon.
    const worst = Math.min(...BEST_AVAILABLE.map(ratioShipped));
    expect(worst).toBeGreaterThan(0.6);
    const above = BEST_AVAILABLE.filter((f) => isAboveHorizon(f.pitch));
    expect(above.filter((f) => ratioShipped(f) < 1).map(label)).toEqual([]);
    expect(Math.max(...above.map(ratioShipped))).toBeLessThan(10);
  });

  it('wins on DETAIL where it stops winning on count', () => {
    // What the cut actually buys above the horizon, as a property rather than
    // as prose: the budget-clamped box has to drop the WHOLE screen's zoom,
    // while the cut still addresses cells at (or past) the camera's own zoom in
    // the near field. Same ground, same coverage, finer foreground.
    const above = BEST_AVAILABLE.filter((f) => isAboveHorizon(f.pitch));
    expect(above.length).toBeGreaterThan(0);
    expect(
      above.filter((f) => f.budgetedZoom >= MATRIX_ZOOM).map(label),
    ).toEqual([]);
    expect(above.filter((f) => f.cutMaxZoom < MATRIX_ZOOM).map(label)).toEqual(
      [],
    );
  });

  it.each(SHIPPED_CAMERAS)(
    '%s (p%i/b%i) — the shipped pitched camera, coverage verified',
    (_name, pitch, bearing) => {
      // Both sit below the horizon. Recorded so FS-3's acceptance starts from
      // the truth rather than from the above-horizon headline: a low
      // single-digit win on count, zero coverage loss — and, since E3, no
      // clause-2 double cover on the very routes the cut was designed for.
      const f = SHIPPED.find((c) => c.pitch === pitch && c.bearing === bearing);
      expect(f).toBeDefined();
      expect(f!.blanks).toBe(0);
      expect(ratioPre(f!)).toBeGreaterThanOrEqual(1);
      expect(ratioPre(f!)).toBeLessThan(10);
      expect(f!.doubleCovers).toBe(0);
    },
  );
});

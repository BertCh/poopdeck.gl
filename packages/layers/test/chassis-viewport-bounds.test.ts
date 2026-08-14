/**
 * `SpatioTemporalLayer.getViewportBounds` — the camera → tile-selection box.
 *
 * This file used to pin `pitch: 0, bearing: 0` AND stub `unproject` to return a
 * pre-ordered rect, which made the shipped bug structurally unreachable: the
 * chassis derived the box from TWO opposite screen corners (the endpoints of
 * ONE diagonal of the ground quad), so under rotation the box shrank and then
 * INVERTED, and past the horizon (`pitch + fovy/2 > 90`) the above-horizon
 * unproject returned a point behind the camera and longitude inverted too.
 * Downstream an inverted latitude box makes `boundsToTiles`' row loop never
 * execute — zero tiles, while every readiness signal reports settled — and an
 * inverted longitude box is indistinguishable from the deliberate antimeridian
 * CROSSING encoding (510 of 512 columns at z9). See
 * `docs/roadmap/tile-loading-3d-2026-07.md` §1.
 *
 * So the matrix below drives a REAL `WebMercatorViewport` over
 * bearing 0…345 × pitch 0…85 and asserts, at every camera:
 *
 *   (i)   the box is ordered — `minLat <= maxLat`, and longitude either ordered
 *         or a legal (sub-350°) seam crossing;
 *   (ii)  every ground sample deck's own frustum would DRAW is inside the box
 *         (the four screen corners among them, when they are in front of the
 *         camera at all);
 *   (iii) coverage never regresses against the old two-corner box, and rises
 *         sharply at the cameras the audit measured.
 *
 * The antimeridian cases are kept verbatim: unwrapped longitude is a
 * load-bearing contract (`tileXSpanForLonRange` walks unwrapped column space
 * and wraps at emit), and there is a matrix case proving `getBounds()` itself
 * does not wrap — `worldToLngLat` is a pure linear map.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebMercatorViewport } from '@deck.gl/core';
import { SpatioTemporalLayer } from '../src/layers/spatiotemporal-layer';
import { _resetWarnOnce } from '../src/lib/log';
import { MAX_MERCATOR_LAT } from '@poopdeck.gl/core/geo';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * A viewport-shaped plain object with NO `getBounds`, exercising the
 * `unproject` fallback path. `zoom` drives the world width the wrap budget is
 * measured against.
 */
function makeViewport(minLon: number, maxLon: number, zoom: number, key = 'v') {
  return {
    id: key,
    width: 800,
    height: 600,
    zoom,
    longitude: (minLon + maxLon) / 2,
    latitude: 0,
    pitch: 0,
    bearing: 0,
    unproject: ([px]: [number, number]) =>
      px === 0 ? [minLon, -20] : [maxLon, 20],
  };
}

function makeLayer(props: Record<string, unknown> = {}) {
  const layer: any = Object.create((SpatioTemporalLayer as any).prototype);
  layer.props = {
    id: 'stl',
    useGlobalBounds: false,
    zoomOverride: null,
    ...props,
  };
  // No archive/metadata → `getZoomLevel` falls back to `floor(viewport.zoom)`.
  layer.state = {};
  return layer;
}

// ---------------------------------------------------------------------------
// Reference tile math — the same row/column loop `boundsToTiles` runs, kept
// local so this file measures COVERAGE without importing (and pinning) core's
// internals. `tileXSpanForLonRange`'s wrap is modelled too: it is what turns an
// inverted-longitude box into a near-whole-world column span.
// ---------------------------------------------------------------------------

const Z = 9;

function lonToTileX(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** zoom);
}

function latToTileY(lat: number, zoom: number): number {
  const n = 2 ** zoom;
  const clamped = Math.min(85.051129, Math.max(-85.051129, lat));
  const rad = (clamped * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
  );
  return Math.min(n - 1, Math.max(0, y));
}

function tileKeyAt(lon: number, lat: number, zoom: number): string {
  const n = 2 ** zoom;
  return `${((lonToTileX(lon, zoom) % n) + n) % n}/${latToTileY(lat, zoom)}`;
}

function tilesFor(
  b: { minLon: number; minLat: number; maxLon: number; maxLat: number },
  zoom: number,
): Set<string> {
  const n = 2 ** zoom;
  const out = new Set<string>();
  // The zero-tile failure itself: `for (y = minY; y <= maxY)` with an inverted
  // latitude box never runs its body.
  if (b.minLat > b.maxLat) return out;
  let start: number;
  let count: number;
  if (b.minLon <= b.maxLon) {
    start = Math.max(0, lonToTileX(b.minLon, zoom));
    count = Math.max(
      0,
      Math.min(lonToTileX(b.maxLon, zoom), n - 1) - start + 1,
    );
  } else {
    // `minLon > maxLon` is the seam-crossing encoding: walk unwrapped and wrap
    // at emit.
    const first = lonToTileX(b.minLon, zoom);
    start = ((first % n) + n) % n;
    count = Math.min(n, lonToTileX(b.maxLon, zoom) + n - first + 1);
  }
  for (let y = latToTileY(b.maxLat, zoom); y <= latToTileY(b.minLat, zoom); y++)
    for (let i = 0; i < count; i++) out.add(`${(start + i) % n}/${y}`);
  return out;
}

/** The box the chassis used to derive: two opposite screen corners. */
function twoCornerBounds(v: any) {
  const [minLon, minLat] = v.unproject([0, v.height]);
  const [maxLon, maxLat] = v.unproject([v.width, 0]);
  return { minLon, minLat, maxLon, maxLat };
}

/**
 * Ground samples deck's own frustum would DRAW, on a pixel grid.
 *
 * The filter is the clip-space test, not a `project(unproject(px))` round trip:
 * a ground point behind the camera flips the sign of both the numerator and the
 * `w` divide, so it round-trips back to the very pixel it was unprojected from
 * (that is exactly why the two-corner derivation could not notice it was
 * reading sky). `w > 0` rejects those; `-w <= z <= w` additionally drops
 * samples past the far plane, which deck does not draw either — so this is
 * "what is on screen" in the only sense a tile selector can be held to.
 *
 * The POINT form is the primitive because the frustum path (FS-2) selects a
 * MIXED-ZOOM cut: "which z9 tiles are drawn" cannot say whether a cut that
 * refines to z11 in the near field covers a z9 cell, and rounding the oracle up
 * to z9 first would answer that question by throwing the evidence away.
 */
function drawnSamples(v: any, samples = 21): Array<[number, number]> {
  const m = v.viewProjectionMatrix;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < samples; i++) {
    for (let j = 0; j < samples; j++) {
      const px = [
        (v.width * i) / (samples - 1),
        (v.height * j) / (samples - 1),
      ];
      const p = v.unproject(px);
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      if (Math.abs(p[1]) > 85.05) continue;
      const c = v.projectPosition([p[0], p[1], 0]);
      const z = m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14];
      const w = m[3] * c[0] + m[7] * c[1] + m[11] * c[2] + m[15];
      if (!(w > 0) || z < -w || z > w) continue;
      out.push([p[0], p[1]]);
    }
  }
  return out;
}

/** The same samples, rounded to tile cells at one zoom — the AABB oracle. */
function drawnTiles(v: any, zoom: number, samples = 21): Set<string> {
  const out = new Set<string>();
  for (const [lon, lat] of drawnSamples(v, samples)) {
    out.add(tileKeyAt(lon, lat, zoom));
  }
  return out;
}

const BEARINGS = Array.from({ length: 24 }, (_, i) => i * 15); // 0…345
const PITCHES = Array.from({ length: 18 }, (_, i) => i * 5); // 0…85

function matrixViewport(pitch: number, bearing: number) {
  return new WebMercatorViewport({
    id: `m-${pitch}-${bearing}`,
    width: 1000,
    height: 1000,
    longitude: -74,
    latitude: 40.7,
    zoom: Z,
    pitch,
    bearing,
  });
}

/**
 * True when the top frustum plane is at or above the horizon, i.e. when
 * `@math.gl/web-mercator`'s `getBounds` swaps the two top corners for
 * far-plane samples. Mirrors its test exactly (`halfFov > angleToGround - 0.01`
 * radians) so the assertions below can distinguish "the top corners are real
 * ground points" from "the top corners are sky".
 */
function isAboveHorizon(v: any): boolean {
  const halfFov = v.fovy
    ? (0.5 * v.fovy * Math.PI) / 180
    : Math.atan(0.5 / v.altitude);
  return halfFov > ((90 - v.pitch) * Math.PI) / 180 - 0.01;
}

beforeEach(() => {
  _resetWarnOnce();
});

// ---------------------------------------------------------------------------
// The pitch × bearing matrix — 24 × 18 real cameras
// ---------------------------------------------------------------------------

describe('getViewportBounds over the pitch × bearing matrix', () => {
  const cases: Array<[number, number]> = [];
  for (const bearing of BEARINGS)
    for (const pitch of PITCHES) cases.push([pitch, bearing]);

  it('never returns an inverted box (the zero-tile invariant)', () => {
    const layer = makeLayer();
    const inverted: string[] = [];
    for (const [pitch, bearing] of cases) {
      const b = layer.getViewportBounds(matrixViewport(pitch, bearing));
      if (b.minLat > b.maxLat) inverted.push(`lat p${pitch}/b${bearing}`);
      // Longitude may legally run east through +180, but only as a crossing —
      // an implied span at or past 350° is the inversion artefact.
      if (b.minLon > b.maxLon && b.maxLon - b.minLon + 360 >= 350)
        inverted.push(`lon p${pitch}/b${bearing}`);
    }
    expect(inverted).toEqual([]);
  });

  it('contains every ground sample deck would draw, at all 432 cameras', () => {
    const layer = makeLayer();
    const misses: string[] = [];
    for (const [pitch, bearing] of cases) {
      const v = matrixViewport(pitch, bearing);
      const box = layer.getViewportBounds(v);
      const selected = tilesFor(box, Z);
      for (const tile of drawnTiles(v, Z)) {
        if (!selected.has(tile)) {
          misses.push(`p${pitch}/b${bearing} missed ${tile}`);
          break;
        }
      }
    }
    expect(misses).toEqual([]);
  });

  it('contains all four screen corners whenever they are real ground points', () => {
    const layer = makeLayer();
    const outside: string[] = [];
    for (const [pitch, bearing] of cases) {
      const v = matrixViewport(pitch, bearing);
      // Above the horizon two of the four "corners" are sky: `unproject`
      // solves the ray against the ground plane behind the camera and returns
      // a mirrored point. Those are not corners of anything, and deck's
      // `getBounds` replaces them with far-plane samples.
      if (isAboveHorizon(v)) continue;
      const box = layer.getViewportBounds(v);
      for (const px of [
        [0, 0],
        [v.width, 0],
        [0, v.height],
        [v.width, v.height],
      ] as Array<[number, number]>) {
        const [lon, lat] = v.unproject(px);
        if (
          lon < box.minLon - 1e-9 ||
          lon > box.maxLon + 1e-9 ||
          lat < box.minLat - 1e-9 ||
          lat > box.maxLat + 1e-9
        ) {
          outside.push(`p${pitch}/b${bearing} corner ${px} -> ${lon},${lat}`);
        }
      }
    }
    expect(outside).toEqual([]);
  });

  it('never loses a tile the old two-corner box selected AND deck draws', () => {
    // The raw two-corner set is NOT a subset in general, and asserting that it
    // were would forbid the fix: an inverted-longitude box reads as a seam
    // crossing, so the old derivation "selected" 510 of 512 columns at z9 —
    // noise, not coverage. What must never regress is the part of the old
    // selection that was genuinely on screen.
    const layer = makeLayer();
    const lost: string[] = [];
    for (const [pitch, bearing] of cases) {
      const v = matrixViewport(pitch, bearing);
      const selected = tilesFor(layer.getViewportBounds(v), Z);
      const old = tilesFor(twoCornerBounds(v), Z);
      for (const tile of drawnTiles(v, Z)) {
        if (old.has(tile) && !selected.has(tile))
          lost.push(`p${pitch}/b${bearing} lost ${tile}`);
      }
    }
    expect(lost).toEqual([]);
  });

  it('strictly contains the old box wherever the old box was well formed', () => {
    // Below the horizon the old box is the hull of two of the same four ground
    // corners, so containment is exact — no camera can lose a column or a row.
    const layer = makeLayer();
    const escaped: string[] = [];
    for (const [pitch, bearing] of cases) {
      const v = matrixViewport(pitch, bearing);
      if (isAboveHorizon(v)) continue;
      const old = twoCornerBounds(v);
      if (old.minLat > old.maxLat || old.minLon > old.maxLon) continue;
      const box = layer.getViewportBounds(v);
      if (
        old.minLon < box.minLon ||
        old.maxLon > box.maxLon ||
        old.minLat < box.minLat ||
        old.maxLat > box.maxLat
      )
        escaped.push(`p${pitch}/b${bearing}`);
    }
    expect(escaped).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The measured regressions, camera by camera
// ---------------------------------------------------------------------------

describe('the cameras the audit measured', () => {
  /** Selected vs drawn tile counts at one camera, old derivation and new. */
  function counts(pitch: number, bearing: number) {
    const layer = makeLayer();
    const v = matrixViewport(pitch, bearing);
    const drawn = drawnTiles(v, Z);
    const selected = tilesFor(layer.getViewportBounds(v), Z);
    const old = tilesFor(twoCornerBounds(v), Z);
    let oldDrawnHits = 0;
    let newDrawnHits = 0;
    for (const t of drawn) {
      if (old.has(t)) oldDrawnHits++;
      if (selected.has(t)) newDrawnHits++;
    }
    return {
      drawn: drawn.size,
      old: old.size,
      selected: selected.size,
      oldDrawnHits,
      newDrawnHits,
    };
  }

  it.each([
    ['flat, unrotated — the only camera that was already correct', 0, 0],
    ['bearing 45 — the old box shrank to one diagonal', 0, 45],
    ['bearing 60 — the old box INVERTED in latitude (zero tiles)', 0, 60],
    ['pitch 60 — the old box missed a third of the frame', 60, 0],
    ['pitch 75 — above the horizon, both axes inverted', 75, 0],
    ['storm-4d-isolines: pitch 62 / bearing 20', 62, 20],
    ['earthquake-columns: pitch 55 / bearing 15', 55, 15],
  ])('%s', (_name, pitch, bearing) => {
    const c = counts(pitch, bearing);
    // Every tile deck draws is selected — the whole point.
    expect(c.newDrawnHits).toBe(c.drawn);
    // ... and the old derivation only managed that at pitch 0 / bearing 0.
    if (pitch !== 0 || bearing !== 0)
      expect(c.oldDrawnHits).toBeLessThan(c.drawn);
    else expect(c.oldDrawnHits).toBe(c.drawn);
  });

  it('selects zero tiles under the OLD derivation at bearing 60 and pitch 75', () => {
    // The failure mode the plan names: an inverted latitude box makes the row
    // loop never execute. Both of these drew a full screen of content.
    for (const [pitch, bearing] of [
      [0, 60],
      [75, 0],
    ]) {
      const v = matrixViewport(pitch, bearing);
      expect(tilesFor(twoCornerBounds(v), Z).size).toBe(0);
      expect(drawnTiles(v, Z).size).toBeGreaterThanOrEqual(9);
    }
  });

  it('fetches MORE under pitch and rotation — that is the fix, not a regression', () => {
    const layer = makeLayer();
    const flat = tilesFor(
      layer.getViewportBounds(matrixViewport(0, 0)),
      Z,
    ).size;
    for (const [pitch, bearing] of [
      [0, 45],
      [0, 60],
      [60, 0],
      [75, 0],
      [62, 20],
    ]) {
      const n = tilesFor(
        makeLayer().getViewportBounds(matrixViewport(pitch, bearing)),
        Z,
      ).size;
      expect(n).toBeGreaterThan(flat);
    }
  });
});

// ---------------------------------------------------------------------------
// Antimeridian — a load-bearing contract, unchanged by the four-corner switch
// ---------------------------------------------------------------------------

describe('getViewportBounds antimeridian handling', () => {
  it('passes an ordinary viewport through unchanged', () => {
    const layer = makeLayer();
    const bounds = layer.getViewportBounds(makeViewport(-74.2, -73.7, 11));
    expect(bounds.minLon).toBeCloseTo(-74.2);
    expect(bounds.maxLon).toBeCloseTo(-73.7);
  });

  it('passes a seam-crossing viewport through UNWRAPPED (east side)', () => {
    const layer = makeLayer();
    // Camera at lon 179: unproject reports [176, 184]. The old code clamped to
    // [176, 180] and dropped the wrapped columns; the interim mitigation
    // widened to the full band. Core's tile scan is now wrap-aware, so the
    // honest span goes down untouched and only the columns actually on screen
    // are selected.
    const bounds = layer.getViewportBounds(makeViewport(176, 184, 4));
    expect(bounds.minLon).toBeCloseTo(176);
    expect(bounds.maxLon).toBeCloseTo(184);
  });

  it('passes a seam-crossing viewport through UNWRAPPED (west side)', () => {
    const layer = makeLayer();
    const bounds = layer.getViewportBounds(makeViewport(-184, -176, 3));
    expect(bounds.minLon).toBeCloseTo(-184);
    expect(bounds.maxLon).toBeCloseTo(-176);
  });

  it('collapses a whole-world viewport to the global band', () => {
    const layer = makeLayer();
    const bounds = layer.getViewportBounds(makeViewport(-400, 400, 1));
    expect(bounds.minLon).toBe(-180);
    expect(bounds.maxLon).toBe(180);
  });

  it('crosses the seam at high zoom with NO amplification and NO warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = makeLayer();

    // z10 ⇒ 1024 columns. The interim mitigation refused to widen here (a
    // ~200× fetch amplification) and clipped the seam with a warning; the
    // wrap-aware scan selects only the handful of columns actually on screen,
    // so the honest span is both correct AND cheap.
    const bounds = layer.getViewportBounds(makeViewport(179.5, 180.4, 10));
    expect(bounds.minLon).toBeCloseTo(179.5);
    expect(bounds.maxLon).toBeCloseTo(180.4);

    layer.getViewportBounds(makeViewport(179.6, 180.5, 10, 'v2'));
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it('does NOT wrap longitude on a real seam-crossing camera', () => {
    // The four-corner switch would silently regress `ais-all-us` / `drifters`
    // if `getBounds()` wrapped: `worldToLngLat` is a pure linear map with no
    // modulo, so a camera at lon 179 must still report a maxLon past +180 and
    // the box must stay ordered rather than becoming a fake crossing.
    const layer = makeLayer();
    const v = new WebMercatorViewport({
      id: 'seam',
      width: 1000,
      height: 800,
      longitude: 179,
      latitude: 10,
      zoom: 4,
      pitch: 50,
      bearing: 30,
    });
    const bounds = layer.getViewportBounds(v);
    expect(bounds.maxLon).toBeGreaterThan(180);
    expect(bounds.minLon).toBeLessThan(bounds.maxLon);
    expect(bounds.minLon).toBeLessThan(180);
    // ... and the west side of the seam behaves symmetrically.
    const west = makeLayer().getViewportBounds(
      new WebMercatorViewport({
        id: 'seam-w',
        width: 1000,
        height: 800,
        longitude: -179,
        latitude: 10,
        zoom: 4,
        pitch: 50,
        bearing: -30,
      }),
    );
    expect(west.minLon).toBeLessThan(-180);
  });

  it('still clamps latitude to the mercator-safe band', () => {
    // The band is ±MAX_MERCATOR_LAT (85.0511°), not ±90 — which is what this
    // test's name always claimed and what it now actually asserts. Clamping to
    // ±90 put the box INSIDE the ULP window where `latToTileY` returns NaN and
    // selection collapses to zero tiles; see
    // packages/core/test/polar-tile-row-collapse.test.ts.
    const layer = makeLayer();
    const viewport = makeViewport(-10, 10, 5);
    viewport.unproject = ([px]: [number, number]) =>
      px === 0 ? [-10, -95] : [10, 95];
    const bounds = layer.getViewportBounds(viewport);
    expect(bounds.minLat).toBe(-MAX_MERCATOR_LAT);
    expect(bounds.maxLat).toBe(MAX_MERCATOR_LAT);
  });

  it('honours useGlobalBounds without touching unproject', () => {
    const layer = makeLayer({ useGlobalBounds: true });
    const viewport = makeViewport(176, 184, 12);
    viewport.unproject = () => {
      throw new Error('unproject must not be called for global bounds');
    };
    expect(layer.getViewportBounds(viewport)).toEqual({
      minLon: -180,
      minLat: -90,
      maxLon: 180,
      maxLat: 90,
    });
  });
});

// ---------------------------------------------------------------------------
// Degenerate producers — the §4.1 rules, and the cache contract
// ---------------------------------------------------------------------------

describe('getViewportBounds repairs and rejections', () => {
  /** A viewport-shaped object with no `getBounds`, returning fixed corners. */
  function stubViewport(corners: Array<[number, number]>, key = 'd') {
    return {
      id: key,
      width: 800,
      height: 600,
      zoom: 6,
      longitude: -74,
      latitude: 40,
      pitch: 0,
      bearing: 0,
      unproject: ([px, py]: [number, number]) => {
        if (px === 0 && py === 0) return corners[0];
        if (px !== 0 && py === 0) return corners[1];
        if (px === 0) return corners[2];
        return corners[3];
      },
    };
  }

  it('four-corner derivations cannot invert — both paths min/max', () => {
    // Worth pinning: this is WHY the fix works. Feed the fallback four corners
    // in the worst possible order and the box still comes out ordered, so the
    // inversion the audit found is not reachable from either derivation.
    const layer = makeLayer();
    const bounds = layer.getViewportBounds(
      stubViewport([
        [-73, 40],
        [-74, 41],
        [-73.5, 39],
        [-74.5, 41.5],
      ]),
    );
    expect(bounds).toEqual({
      minLon: -74.5,
      minLat: 39,
      maxLon: -73,
      maxLat: 41.5,
    });
  });

  it('orders an inverted box from a foreign getBounds and warns once', () => {
    // A viewport that reports its own bounds — Cesium's `west > east`
    // rectangle, a hand-rolled two-corner shim — is the only producer that can
    // still hand this layer an inverted box, and it is passed through
    // verbatim. The repair keeps selection correct; the warning is how the
    // host finds out.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = makeLayer();
    const v: any = {
      id: 'foreign',
      width: 800,
      height: 600,
      zoom: 6,
      longitude: -73.5,
      latitude: 40.5,
      pitch: 55,
      bearing: 200,
      getBounds: () => [-73, 41, -74, 40], // minLon > maxLon, minLat > maxLat
    };
    const bounds = layer.getViewportBounds(v);

    expect(bounds.minLat).toBeLessThanOrEqual(bounds.maxLat);
    expect(bounds.minLon).toBeLessThanOrEqual(bounds.maxLon);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/inverted-lat/);
    expect(warn.mock.calls[0][0]).toMatch(/pitch 55/);
    expect(warn.mock.calls[0][0]).toMatch(/bearing 200/);

    // Once. A per-frame warning on a camera that is merely being dragged is
    // console spam, and the repair is silent-by-design after the first.
    v.id = 'foreign2';
    layer.getViewportBounds(v);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('does not warn for an ordinary zoomed-out world view', () => {
    // `full-world` and `clamped-lat` are normalisations, not defects: a z0 map
    // legitimately reports a ±421° span. Warning here would fire on every
    // global demo and train developers to ignore the warning that matters.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = makeLayer();
    const bounds = layer.getViewportBounds(
      new WebMercatorViewport({
        id: 'world',
        width: 1200,
        height: 900,
        longitude: 0,
        latitude: 0,
        zoom: 0,
        pitch: 0,
        bearing: 0,
      }),
    );
    expect(bounds).toEqual({
      minLon: -180,
      minLat: expect.any(Number),
      maxLon: 180,
      maxLat: expect.any(Number),
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('KEEPS the previous box when a camera goes non-finite', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = makeLayer();
    const good = layer.getViewportBounds(makeViewport(-74.2, -73.7, 11));
    const goodSnapshot = { ...good };

    const broken: any = makeViewport(-74.2, -73.7, 11, 'broken');
    broken.unproject = () => [NaN, NaN];
    const kept = layer.getViewportBounds(broken);

    // Same OBJECT, not merely an equal one: selecting against garbage — a NaN
    // box enumerates nothing, or the world — is strictly worse than selecting
    // against a one-frame-stale box.
    expect(kept).toBe(good);
    expect(kept).toEqual(goodSnapshot);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/non-finite/);
    warn.mockRestore();
  });

  it('falls back to the camera point when the FIRST box is unusable', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = makeLayer();
    const broken: any = makeViewport(0, 0, 8, 'first-broken');
    broken.longitude = -74;
    broken.latitude = 40.7;
    broken.unproject = () => [Infinity, Infinity];

    // There is no previous viewport to keep and no "select nothing" value in
    // this API, so the single tile under the camera is the least-wrong answer:
    // it is certainly on screen, and the global band would be a 4^zoom storm.
    const bounds = layer.getViewportBounds(broken);
    expect(bounds).toEqual({
      minLon: -74,
      minLat: 40.7,
      maxLon: -74,
      maxLat: 40.7,
    });
  });

  it('returns the SAME reference while the camera is unchanged', () => {
    const layer = makeLayer();
    const v = matrixViewport(45, 30);
    const first = layer.getViewportBounds(v);
    expect(layer.getViewportBounds(v)).toBe(first);

    // A moved camera re-derives; the global path is likewise reference-stable.
    expect(layer.getViewportBounds(matrixViewport(45, 45))).not.toBe(first);

    const global = makeLayer({ useGlobalBounds: true });
    const g1 = global.getViewportBounds(matrixViewport(0, 0));
    expect(global.getViewportBounds(matrixViewport(60, 20))).toBe(g1);
  });
});

// ---------------------------------------------------------------------------
// A3 — the altitude slab
// ---------------------------------------------------------------------------

describe('zRange (the altitude slab)', () => {
  const CAMERA = new WebMercatorViewport({
    id: 'elev',
    width: 1000,
    height: 1000,
    longitude: -74,
    latitude: 40.7,
    zoom: 8,
    pitch: 60,
    bearing: 20,
  });

  it('unions the ground-plane box with the box at the top of the content', () => {
    const ground = makeLayer().getViewportBounds(CAMERA);
    const slab = makeLayer({ zRange: [0, 15000] }).getViewportBounds(CAMERA);

    const top = CAMERA.getBounds({ z: 15000 });
    // Deck's own `Tileset2D.getBoundingBox` does exactly this union for
    // `zRange`; the result must contain BOTH planes' footprints.
    expect(slab.minLon).toBeLessThanOrEqual(Math.min(ground.minLon, top[0]));
    expect(slab.minLat).toBeLessThanOrEqual(Math.min(ground.minLat, top[1]));
    expect(slab.maxLon).toBeGreaterThanOrEqual(Math.max(ground.maxLon, top[2]));
    expect(slab.maxLat).toBeGreaterThanOrEqual(Math.max(ground.maxLat, top[3]));
    // It is a genuine widening, not a no-op: content 15 km up sits outside the
    // ground box near the bottom edge of a pitched frame.
    expect(
      slab.maxLon - slab.minLon + (slab.maxLat - slab.minLat),
    ).toBeGreaterThan(
      ground.maxLon - ground.minLon + (ground.maxLat - ground.minLat),
    );
  });

  it('is off by default and tolerates a reversed or non-finite range', () => {
    const ground = makeLayer().getViewportBounds(CAMERA);
    expect(makeLayer({ zRange: null }).getViewportBounds(CAMERA)).toEqual(
      ground,
    );
    expect(
      makeLayer({ zRange: [NaN, 15000] }).getViewportBounds(CAMERA),
    ).toEqual(ground);
    // Reversed is ordered before use, not silently dropped.
    expect(makeLayer({ zRange: [15000, 0] }).getViewportBounds(CAMERA)).toEqual(
      makeLayer({ zRange: [0, 15000] }).getViewportBounds(CAMERA),
    );
  });

  it('invalidates the per-frame cache when the range changes', () => {
    // The key is camera-derived, so a prop that changes the derivation must be
    // part of it or the layer would keep serving the ground-plane box.
    const layer = makeLayer({ zRange: [0, 0] });
    const flat = { ...layer.getViewportBounds(CAMERA) };
    layer.props = { ...layer.props, zRange: [0, 15000] };
    expect(layer.getViewportBounds(CAMERA)).not.toEqual(flat);
  });

  it('is ignored on a viewport with no getBounds instead of throwing', () => {
    // A hand-rolled viewport's `unproject` need not implement `targetZ`, so
    // the slab is simply not applied there.
    const layer = makeLayer({ zRange: [0, 15000] });
    const bounds = layer.getViewportBounds(makeViewport(-74.2, -73.7, 11));
    expect(bounds.minLon).toBeCloseTo(-74.2);
    expect(bounds.maxLon).toBeCloseTo(-73.7);
  });
});

// ---------------------------------------------------------------------------
// FS-2 — `selectionMode: 'frustum'`, the quadtree cut
//
// Everything below runs against the SAME 432 real cameras as the matrix above,
// because the risk is the same risk. A tile selector does not fail loudly: it
// fails as a map that says "no data here". The 2026-07-26 audit found selection
// correct only at `pitch === 0 && bearing === 0` and shipped 3-D demos missing
// 20–44 % of their data, and this file is what caught it. So the frustum path
// is admitted only on the identical one-sided terms: EVERY drawn ground sample
// is covered by the cut, at every camera. Extra cells are never a finding.
//
// The oracle probes at the archive's MAX zoom rather than at Z. A cut is
// mixed-zoom by construction — near-field branches refine past the camera zoom —
// so "is this z9 tile in the cut" is the wrong question; "is the cell under this
// drawn point covered by the cut or one of its ancestors" is the right one.
// ---------------------------------------------------------------------------

const CUT_MIN_ZOOM = 0;
const CUT_MAX_ZOOM = 12;

/** A layer with an archive attached — `getViewportTileCells` needs its zooms. */
function makeFrustumLayer(props: Record<string, unknown> = {}) {
  const layer: any = Object.create((SpatioTemporalLayer as any).prototype);
  layer.props = {
    id: 'stl',
    useGlobalBounds: false,
    zoomOverride: null,
    selectionMode: 'frustum',
    ...props,
  };
  layer.state = {
    metadata: { minZoom: CUT_MIN_ZOOM, maxZoom: CUT_MAX_ZOOM },
  };
  return layer;
}

function cutKeys(cut: Array<{ z: number; x: number; y: number }>): Set<string> {
  return new Set(cut.map((c) => `${c.z}/${c.x}/${c.y}`));
}

/** Is the cell under `(lon, lat)` at `probeZoom` covered by the cut? */
function cutCoversPoint(
  keys: Set<string>,
  lon: number,
  lat: number,
  probeZoom: number,
): boolean {
  const n = 2 ** probeZoom;
  const x = ((lonToTileX(lon, probeZoom) % n) + n) % n;
  const y = latToTileY(lat, probeZoom);
  for (let z = probeZoom; z >= CUT_MIN_ZOOM; z--) {
    const shift = 2 ** (probeZoom - z);
    if (keys.has(`${z}/${Math.floor(x / shift)}/${Math.floor(y / shift)}`))
      return true;
  }
  return false;
}

describe('selectionMode: frustum — coverage soundness over the 432-camera matrix', () => {
  const cases: Array<[number, number]> = [];
  for (const bearing of BEARINGS)
    for (const pitch of PITCHES) cases.push([pitch, bearing]);

  it('produces a cut at every one of the 432 cameras', () => {
    // A `null` here is not a bug — it routes to the box path, which is a strict
    // superset — but it WOULD mean the measured win never materialises on an
    // ordinary camera. Pin that the adapter actually engages.
    const missing: string[] = [];
    for (const [pitch, bearing] of cases) {
      const cut = makeFrustumLayer().getViewportTileCells(
        matrixViewport(pitch, bearing),
      );
      if (!cut || cut.length === 0) missing.push(`p${pitch}/b${bearing}`);
    }
    expect(missing).toEqual([]);
  });

  it('covers EVERY drawn ground sample, at all 432 cameras — the gate', () => {
    const misses: string[] = [];
    for (const [pitch, bearing] of cases) {
      const v = matrixViewport(pitch, bearing);
      const cut = makeFrustumLayer().getViewportTileCells(v);
      expect(cut).not.toBeNull();
      const keys = cutKeys(cut!);
      for (const [lon, lat] of drawnSamples(v)) {
        if (!cutCoversPoint(keys, lon, lat, CUT_MAX_ZOOM)) {
          misses.push(`p${pitch}/b${bearing} missed ${lon},${lat}`);
          break;
        }
      }
    }
    expect(misses).toEqual([]);
  });

  it('never misses a z9 cell the incumbent AABB path found AND deck draws', () => {
    // The direct anti-regression statement: whatever the box selects and the
    // camera actually draws must still be covered. (The converse is the point
    // of the item — the cut drops the box's near-horizon padding.)
    const lost: string[] = [];
    for (const [pitch, bearing] of cases) {
      const v = matrixViewport(pitch, bearing);
      const box = tilesFor(makeLayer().getViewportBounds(v), Z);
      const keys = cutKeys(makeFrustumLayer().getViewportTileCells(v)!);
      for (const [lon, lat] of drawnSamples(v)) {
        if (!box.has(tileKeyAt(lon, lat, Z))) continue;
        if (!cutCoversPoint(keys, lon, lat, CUT_MAX_ZOOM))
          lost.push(`p${pitch}/b${bearing} lost ${lon},${lat}`);
      }
    }
    expect(lost).toEqual([]);
  });

  it('emits an ANTICHAIN — no cell is an ancestor of another', () => {
    // §8.3's delivery contract: each visible cell reaches the renderer under at
    // most one cover. A violated antichain is the 2026-07-29 double-draw.
    const nested: string[] = [];
    for (const [pitch, bearing] of cases) {
      const cut = makeFrustumLayer().getViewportTileCells(
        matrixViewport(pitch, bearing),
      )!;
      const keys = cutKeys(cut);
      for (const c of cut) {
        for (let z = c.z - 1; z >= CUT_MIN_ZOOM; z--) {
          const shift = 2 ** (c.z - z);
          if (
            keys.has(
              `${z}/${Math.floor(c.x / shift)}/${Math.floor(c.y / shift)}`,
            )
          ) {
            nested.push(`p${pitch}/b${bearing} ${c.z}/${c.x}/${c.y}`);
          }
        }
      }
    }
    expect(nested).toEqual([]);
  });

  it('stays inside the archive zoom range and emits in-world addresses', () => {
    const bad: string[] = [];
    for (const [pitch, bearing] of cases) {
      for (const c of makeFrustumLayer().getViewportTileCells(
        matrixViewport(pitch, bearing),
      )!) {
        const world = 2 ** c.z;
        if (
          c.z < CUT_MIN_ZOOM ||
          c.z > CUT_MAX_ZOOM ||
          c.x < 0 ||
          c.x >= world ||
          c.y < 0 ||
          c.y >= world
        ) {
          bad.push(`p${pitch}/b${bearing} ${c.z}/${c.x}/${c.y}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('is deterministic — the same camera yields the same cut', () => {
    for (const [pitch, bearing] of [
      [0, 0],
      [62, 20],
      [85, 195],
    ]) {
      const a = makeFrustumLayer().getViewportTileCells(
        matrixViewport(pitch, bearing),
      );
      const b = makeFrustumLayer().getViewportTileCells(
        matrixViewport(pitch, bearing),
      );
      expect(a).toEqual(b);
    }
  });
});

describe('selectionMode: frustum — the prize, measured', () => {
  /** Cells the cut emits vs cells the incumbent box enumerates, one camera. */
  function counts(pitch: number, bearing: number) {
    const v = matrixViewport(pitch, bearing);
    return {
      cut: makeFrustumLayer().getViewportTileCells(v)!.length,
      aabb: tilesFor(makeLayer().getViewportBounds(v), Z).size,
    };
  }

  it('degenerates to EXACTLY the box enumeration on a flat unrotated camera', () => {
    // The property that makes the cut safe to adopt at all: with no pitch and
    // no bearing there is nothing for a frustum walk to be cleverer about, and
    // the two derivations must agree cell for cell at the camera's own zoom.
    // Any disagreement here would be a convention bug, not an optimisation.
    const v = matrixViewport(0, 0);
    const cut = makeFrustumLayer().getViewportTileCells(v)!;
    expect(new Set(cut.map((c) => `${c.z}/${c.x}/${c.y}`))).toEqual(
      new Set(
        [...tilesFor(makeLayer().getViewportBounds(v), Z)].map(
          (k) => `${Z}/${k}`,
        ),
      ),
    );
  });

  it('collapses the horizon band: ≥8× fewer cells above the horizon', () => {
    // This is where the recorded prize lives. Past `pitch + fovy/2 > 90°` the
    // ground box stops bounding the frame and starts bounding the HORIZON:
    // 832 cells at pitch 85/z8 against ~12 for a flat camera, and 754 at z8
    // where the cut needs 47 across z5–z8 (tile-loading-3d-2026-07 §4.4, Wave
    // 3/A1). Measured here at z9: the ratio runs 9.25× (p85/b15, 620 → 67) to
    // 23.1× (p70), so 8× is a floor with headroom rather than a fitted number.
    const short: string[] = [];
    for (const bearing of BEARINGS) {
      for (const pitch of PITCHES) {
        if (pitch < 70) continue;
        const c = counts(pitch, bearing);
        if (c.cut * 8 > c.aabb)
          short.push(`p${pitch}/b${bearing} cut=${c.cut} aabb=${c.aabb}`);
      }
    }
    expect(short).toEqual([]);
  });

  it('stays BOUNDED below the horizon — never a blow-up, sometimes a little more', () => {
    // Honest accounting, and deliberately not asserted as "always fewer": below
    // the horizon the box is already tight, and the cut spends some of its
    // budget REFINING the near field (a pitched frame's foreground deserves a
    // deeper zoom than its background). Worst case across all 432 cameras is
    // 1.33× the box's cell count, at a shallow rotated camera (p15/b330,
    // 9 → 12). Cell count is not the metric that matters there — those extra
    // cells are one zoom deeper and correspondingly smaller — but it must not
    // be free to grow, so it is pinned at 2×.
    const blowUp: string[] = [];
    for (const bearing of BEARINGS) {
      for (const pitch of PITCHES) {
        const c = counts(pitch, bearing);
        if (c.cut > c.aabb * 2)
          blowUp.push(`p${pitch}/b${bearing} cut=${c.cut} aabb=${c.aabb}`);
      }
    }
    expect(blowUp).toEqual([]);
  });

  it.each([
    ['storm-4d-isolines: pitch 62 / bearing 20', 62, 20],
    ['earthquake-columns: pitch 55 / bearing 15', 55, 15],
  ])('%s — the shipped pitched cameras', (_name, pitch, bearing) => {
    // Both shipped cameras sit BELOW the horizon, where the recorded 10–16×
    // figure does not apply: measured at z9 the cut is 30 vs 56 cells
    // (storm-4d-isolines) and 25 vs 30 (earthquake-columns). Recorded here so
    // FS-3's acceptance run starts from the truth rather than from the
    // above-horizon headline.
    const c = counts(pitch, bearing);
    expect(c.cut).toBeLessThanOrEqual(c.aabb);
    // ... and the reduction is real coverage, not a truncation: every drawn
    // sample is still covered.
    const v = matrixViewport(pitch, bearing);
    const keys = cutKeys(makeFrustumLayer().getViewportTileCells(v)!);
    const misses = drawnSamples(v).filter(
      ([lon, lat]) => !cutCoversPoint(keys, lon, lat, CUT_MAX_ZOOM),
    );
    expect(misses).toEqual([]);
  });
});

describe('selectionMode: the default-off pin and the fallbacks', () => {
  it('DEFAULT is aabb: no cut is produced unless the app asks', () => {
    // The regression pin the item names: flag off must behave exactly as today.
    // `getViewportTileCells` returning null is what makes the tileset take the
    // incumbent path verbatim.
    const layer: any = Object.create((SpatioTemporalLayer as any).prototype);
    layer.props = { id: 'stl', useGlobalBounds: false, zoomOverride: null };
    layer.state = { metadata: { minZoom: 0, maxZoom: 12 } };
    expect(SpatioTemporalLayer.defaultProps.selectionMode).toBe('aabb');
    expect(layer.getViewportTileCells(matrixViewport(62, 20))).toBeNull();
    // ... and the box it derives is untouched by the new code path.
    expect(layer.getViewportBounds(matrixViewport(62, 20))).toEqual(
      makeLayer().getViewportBounds(matrixViewport(62, 20)),
    );
  });

  it('falls back (null) before the archive metadata is known', () => {
    const layer = makeFrustumLayer();
    layer.state = {};
    expect(layer.getViewportTileCells(matrixViewport(45, 30))).toBeNull();
  });

  it('falls back (null) for useGlobalBounds and for a viewport with no planes', () => {
    expect(
      makeFrustumLayer({ useGlobalBounds: true }).getViewportTileCells(
        matrixViewport(45, 30),
      ),
    ).toBeNull();
    // A hand-rolled host viewport: no `getFrustumPlanes`, so no cut.
    expect(
      makeFrustumLayer().getViewportTileCells(makeViewport(-74.2, -73.7, 11)),
    ).toBeNull();
  });

  it('REFUSES a viewport whose common space is not web-mercator', () => {
    // The cover-space probe is the guard that keeps a convention mismatch from
    // presenting as systematic under-cover. A globe / orthographic / custom
    // viewport projects into a different space entirely, and a cut built from
    // its planes would be quietly wrong rather than obviously broken.
    const real = matrixViewport(45, 30);
    const cartesian: any = {
      id: 'globe-ish',
      width: 1000,
      height: 1000,
      zoom: 9,
      longitude: -74,
      latitude: 40.7,
      pitch: 45,
      bearing: 30,
      isGeospatial: true,
      cameraPosition: real.cameraPosition,
      center: real.center,
      getFrustumPlanes: () => real.getFrustumPlanes(),
      // Cartesian metres-from-earth-centre, deck's GlobeViewport convention.
      projectPosition: ([lon, lat]: number[]) => [
        6378137 * Math.cos((lat * Math.PI) / 180),
        6378137 * Math.sin((lon * Math.PI) / 180),
        0,
      ],
    };
    expect(makeFrustumLayer().getViewportTileCells(cartesian)).toBeNull();

    // Same viewport with the mercator convention restored: the cut comes back,
    // so the probe is rejecting the SPACE and not the object shape.
    cartesian.id = 'mercator-ish';
    cartesian.projectPosition = (p: number[]) => real.projectPosition(p);
    expect(makeFrustumLayer().getViewportTileCells(cartesian)).not.toBeNull();
  });

  it('REFUSES a plane set with a non-finite half-space', () => {
    const real = matrixViewport(45, 30);
    const broken: any = {
      ...real,
      id: 'broken-planes',
      getFrustumPlanes: () => {
        const planes = real.getFrustumPlanes();
        return {
          ...planes,
          far: { distance: NaN, normal: planes.far.normal },
        };
      },
      projectPosition: (p: number[]) => real.projectPosition(p),
      cameraPosition: real.cameraPosition,
      center: real.center,
    };
    expect(makeFrustumLayer().getViewportTileCells(broken)).toBeNull();
  });

  it('memoises per camera and re-derives when the camera or zRange moves', () => {
    const layer = makeFrustumLayer();
    const v = matrixViewport(45, 30);
    const first = layer.getViewportTileCells(v);
    expect(layer.getViewportTileCells(v)).toBe(first); // same reference
    expect(layer.getViewportTileCells(matrixViewport(45, 45))).not.toBe(first);

    // `zRange` widens the cut (the A3 slab) and is a prop, so it must be part
    // of the memo key or a volumetric layer would keep serving the flat cut.
    layer.props = { ...layer.props, zRange: [0, 15000] };
    expect(layer.getViewportTileCells(v)).not.toBe(first);
  });
});

describe('selectionMode: frustum — zRange (the A3 altitude slab)', () => {
  const CAMERA_3D = new WebMercatorViewport({
    id: 'slab',
    width: 1000,
    height: 1000,
    longitude: -74,
    latitude: 40.7,
    zoom: 8,
    pitch: 60,
    bearing: 20,
  });

  /**
   * Samples on the plane `altitude` metres up that the camera actually draws.
   * `unproject({targetZ})` solves the pixel ray against THAT plane; the clip
   * test then runs at the same altitude, so this is "what an extruded column's
   * roof shows on screen", which is the A3 case the slab exists for.
   */
  function drawnSamplesAt(
    v: any,
    altitude: number,
    samples = 15,
  ): Array<[number, number]> {
    const m = v.viewProjectionMatrix;
    const out: Array<[number, number]> = [];
    for (let i = 0; i < samples; i++) {
      for (let j = 0; j < samples; j++) {
        const p = v.unproject(
          [(v.width * i) / (samples - 1), (v.height * j) / (samples - 1)],
          { targetZ: altitude },
        );
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
        if (Math.abs(p[1]) > 85.05) continue;
        const c = v.projectPosition([p[0], p[1], altitude]);
        const z = m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14];
        const w = m[3] * c[0] + m[7] * c[1] + m[11] * c[2] + m[15];
        if (!(w > 0) || z < -w || z > w) continue;
        out.push([p[0], p[1]]);
      }
    }
    return out;
  }

  it('covers samples on the TOP of the slab, not just on the ground', () => {
    // A column 15 km tall whose base is off the bottom of a pitched frame can
    // still have its roof on screen; the cut has to own the tile that column
    // stands in. Without the slab those tiles are simply not selected — the
    // near edge of a pitched frame loses about half a tile row of anvil.
    const slabKeys = cutKeys(
      makeFrustumLayer({ zRange: [0, 15000] }).getViewportTileCells(CAMERA_3D)!,
    );
    const misses = drawnSamplesAt(CAMERA_3D, 15000).filter(
      ([lon, lat]) => !cutCoversPoint(slabKeys, lon, lat, CUT_MAX_ZOOM),
    );
    expect(misses).toEqual([]);
  });

  it('still covers the ground, and widens rather than shifts', () => {
    const groundOnly = makeFrustumLayer();
    const withSlab = makeFrustumLayer({ zRange: [0, 15000] });
    const slabKeys = cutKeys(withSlab.getViewportTileCells(CAMERA_3D)!);
    const misses = drawnSamples(CAMERA_3D).filter(
      ([lon, lat]) => !cutCoversPoint(slabKeys, lon, lat, CUT_MAX_ZOOM),
    );
    expect(misses).toEqual([]);
    expect(withSlab.getViewportTileCells(CAMERA_3D)!.length).toBeGreaterThan(
      groundOnly.getViewportTileCells(CAMERA_3D)!.length,
    );
  });

  it('tolerates a reversed or non-finite range exactly as the box path does', () => {
    const ground = makeFrustumLayer().getViewportTileCells(CAMERA_3D);
    expect(
      makeFrustumLayer({ zRange: null }).getViewportTileCells(CAMERA_3D),
    ).toEqual(ground);
    expect(
      makeFrustumLayer({ zRange: [NaN, 15000] }).getViewportTileCells(
        CAMERA_3D,
      ),
    ).toEqual(ground);
    expect(
      makeFrustumLayer({ zRange: [15000, 0] }).getViewportTileCells(CAMERA_3D),
    ).toEqual(
      makeFrustumLayer({ zRange: [0, 15000] }).getViewportTileCells(CAMERA_3D),
    );
  });
});

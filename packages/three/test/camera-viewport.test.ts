// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// `cameraToViewport` — the three backend's camera → tile-selection viewport.
// This function shipped with ZERO coverage and a doc comment claiming it was
// "verified visually"; the 2026-07 tile-loading audit then found four defects in
// it (docs/roadmap/tile-loading-3d-2026-07.md RC5 + A4). Every describe block
// below is one of them, and every assertion in them FAILS against the pre-fix
// implementation — the measured pre-fix numbers are quoted inline so a future
// reader can tell a regression from a re-tune.

import { describe, it, expect } from 'vitest';
import { PerspectiveCamera } from 'three';
import { cameraToViewport } from '../src/scene/streaming-tile-source';
import {
  viewStateToCamera,
  cameraToViewState,
  type ViewState,
} from '../src/projection/view-state';
import { MercatorProjection } from '../src/projection/mercator';
import { GlobeProjection } from '../src/projection/globe';
import {
  LocalEnuProjection,
  type Projection,
} from '../src/projection/local-enu';
import { MAX_SEAM_SPAN_DEG, MAX_MERCATOR_LAT } from '@poopdeck.gl/core/geo';

const LANDSCAPE = { width: 1440, height: 900 };
const PORTRAIT = { width: 900, height: 1440 };

function cameraFor(
  proj: Projection,
  viewState: ViewState,
  px = LANDSCAPE,
): PerspectiveCamera {
  const cam = new PerspectiveCamera(50, px.width / px.height, 0.1, 1e9);
  viewStateToCamera(proj, viewState, cam, { viewportHeight: px.height });
  return cam;
}

/** `cameraToViewport` or a failure — every test here expects a real box. */
function viewportFor(
  proj: Projection,
  viewState: ViewState,
  px = LANDSCAPE,
  opts: { minZoom?: number; maxZoom?: number } = {},
) {
  const vp = cameraToViewport(proj, cameraFor(proj, viewState, px), px, opts);
  if (!vp) {
    throw new Error(`expected a viewport for ${JSON.stringify(viewState)}`);
  }
  return vp;
}

const latSpan = (b: { minLat: number; maxLat: number }) => b.maxLat - b.minLat;
const lonSpan = (b: { minLon: number; maxLon: number }) =>
  b.minLon <= b.maxLon ? b.maxLon - b.minLon : b.maxLon - b.minLon + 360;

// ── Defect 1: the globe path solved the wrong plane ─────────────────────────

describe('cameraToViewport — globe frames', () => {
  const proj = new GlobeProjection();
  const CENTRE = { longitude: -97, latitude: 41 };

  it('reports the latitude the camera is actually looking at, not 0', () => {
    // Pre-fix this returned {minLon: -143.39, minLat: 0, maxLon: 129.39,
    // maxLat: 0}: `intersectGround` solved world-space z = 0, which on an ECEF
    // frame is the EQUATORIAL PLANE THROUGH THE EARTH'S CENTRE, and
    // `unproject(x, y, 0)` then read asin(0) for every hit.
    const { bounds } = viewportFor(proj, { ...CENTRE, zoom: 5 });
    expect(bounds.minLat).toBeLessThan(CENTRE.latitude);
    expect(bounds.maxLat).toBeGreaterThan(CENTRE.latitude);
    expect(bounds.minLon).toBeLessThan(CENTRE.longitude);
    expect(bounds.maxLon).toBeGreaterThan(CENTRE.longitude);
    // A z5 frame is tens of degrees across, not the 272.8° the pre-fix
    // equatorial-plane solve reported.
    expect(lonSpan(bounds)).toBeLessThan(90);
    expect(latSpan(bounds)).toBeLessThan(45);
  });

  it('agrees with the equivalent mercator viewport where the two frames coincide', () => {
    // At a high zoom the visible patch is small enough that the sphere and the
    // mercator plane describe the same ground, so the two backends' boxes must
    // agree to within a fraction of a percent. This is the sharpest available
    // oracle for the globe path — it pins the ray/sphere solve against an
    // independently-derived answer rather than against itself.
    const flat = new MercatorProjection();
    const vs = { ...CENTRE, zoom: 9 };
    const g = viewportFor(proj, vs).bounds;
    const m = viewportFor(flat, vs).bounds;
    expect(lonSpan(g) / lonSpan(m)).toBeCloseTo(1, 1);
    expect(latSpan(g) / latSpan(m)).toBeCloseTo(1, 1);
    expect(g.minLat).toBeCloseTo(m.minLat, 1);
    expect(g.maxLat).toBeCloseTo(m.maxLat, 1);
    expect(g.minLon).toBeCloseTo(m.minLon, 1);
    expect(g.maxLon).toBeCloseTo(m.maxLon, 1);
  });

  it('contains the view centre at every bearing, tilted', () => {
    const missed: unknown[] = [];
    for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const { bounds } = viewportFor(proj, {
        ...CENTRE,
        zoom: 5,
        pitch: 40,
        bearing,
      });
      const contains =
        bounds.minLat <= CENTRE.latitude &&
        CENTRE.latitude <= bounds.maxLat &&
        bounds.minLon <= CENTRE.longitude &&
        CENTRE.longitude <= bounds.maxLon;
      if (!contains) missed.push({ bearing, bounds });
    }
    expect(missed).toEqual([]);
  });

  it('holds one zoom as the camera orbits (it used to roll 3/1/1/2)', () => {
    const zooms = [0, 45, 90, 135, 180, 225, 270, 315].map(
      (bearing) =>
        viewportFor(proj, { ...CENTRE, zoom: 5, pitch: 40, bearing }).zoom,
    );
    expect(new Set(zooms).size).toBe(1);
    expect(zooms[0]).toBe(5);
  });

  it('keeps a seam-straddling view unwrapped rather than claiming the planet', () => {
    // `GlobeProjection.unproject` ends in atan2, so the raw samples straddle
    // ±180 and their naive AABB is [-179.x, +179.x] — 359° of the world the
    // long way round. The box must stay narrow and stay on one unwrapped turn.
    const { bounds } = viewportFor(proj, {
      longitude: 179.5,
      latitude: 10,
      zoom: 6,
    });
    expect(lonSpan(bounds)).toBeLessThan(MAX_SEAM_SPAN_DEG);
    expect(lonSpan(bounds)).toBeLessThan(20);
    // 179.5 lies inside the box in unwrapped space (either as-is, or after the
    // legal `minLon > maxLon` crossing encoding is unrolled).
    const inside =
      (bounds.minLon <= 179.5 && 179.5 <= bounds.maxLon) ||
      (bounds.minLon <= 179.5 - 360 && 179.5 - 360 <= bounds.maxLon) ||
      (bounds.minLon <= 179.5 + 360 && 179.5 + 360 <= bounds.maxLon) ||
      (bounds.minLon > bounds.maxLon && 179.5 >= bounds.minLon);
    expect(inside).toBe(true);
  });

  it('bounds a whole-planet view without inverting', () => {
    const { bounds } = viewportFor(proj, {
      longitude: 0,
      latitude: 0,
      zoom: 0,
    });
    expect(bounds.minLat).toBeLessThan(bounds.maxLat);
    expect(bounds.minLat).toBeGreaterThanOrEqual(-90);
    expect(bounds.maxLat).toBeLessThanOrEqual(90);
    expect(Number.isFinite(bounds.minLon)).toBe(true);
    expect(Number.isFinite(bounds.maxLon)).toBe(true);
  });

  it('covers the whole longitude circle when a pole is on screen', () => {
    // A lon/lat AABB of ray hits is the WRONG shape once the frame contains a
    // pole: the visible patch is a CAP, every meridian runs through it, and
    // latitude turns back DOWN past the pole rather than continuing up. Pre-fix,
    // a camera centred at lat 89 / z2 — the pole 0.72 of the way up the screen,
    // unmistakably in frame — reported
    //   {minLat: 86.699, maxLat: 89.691, minLon: -109.456, maxLon: 180}
    // The pole it is staring at fell outside its own viewport box, and the
    // longitudes it did report are an artefact of where the 5×5 grid happened to
    // land rather than a bound on anything. Sampling harder cannot fix it: the
    // northernmost row lands short of 90 either way, and an AABB has no way to
    // know it stepped OVER the pole instead of up to it.
    for (const { latitude, sign } of [
      { latitude: 89, sign: 1 },
      { latitude: -89, sign: -1 },
    ] as const) {
      const { bounds } = viewportFor(proj, { longitude: 0, latitude, zoom: 2 });
      expect(lonSpan(bounds)).toBeCloseTo(360, 6);
      // The widening writes the pole's own ±90, then `normalizeViewportBounds`
      // clamps to the Web Mercator edge on the way out. Tile SELECTION is
      // identical either way — `latToTileY` maps 90 and 85.0511 to the same
      // row 0, there being no tile row above the edge — but the clamp is what
      // keeps the box out of the near-pole band where `latToTileY` returns NaN
      // and selects zero tiles (see core's polar-tile-row-collapse.test.ts).
      if (sign > 0) expect(bounds.maxLat).toBeCloseTo(MAX_MERCATOR_LAT, 6);
      else expect(bounds.minLat).toBeCloseTo(-MAX_MERCATOR_LAT, 6);
      // The far side stays the samples' own — widening must ADD the coverage the
      // AABB cannot express, not surrender the box to the whole world.
      const far = sign > 0 ? bounds.minLat : bounds.maxLat;
      expect(Math.abs(far)).toBeGreaterThan(80);
    }
  });

  it('does not widen when the pole is off screen', () => {
    // The guard is a frustum test, not a latitude threshold, and the difference
    // is not academic: at this same centre one zoom in, the pole sits at NDC
    // y = 1.44 — just off the top edge — and the sampled box is then genuinely
    // right (its widest longitude IS a corner sample). A latitude threshold
    // would widen here and scan every column on the planet for a 150°-wide
    // frame. Two zooms in the pole is at y = 2.86 and the frame is 80° wide.
    for (const zoom of [3, 4]) {
      const { bounds } = viewportFor(proj, {
        longitude: 0,
        latitude: 89,
        zoom,
      });
      expect(lonSpan(bounds)).toBeLessThan(180);
      expect(bounds.maxLat).toBeLessThan(90);
    }
  });

  it('honours a non-earth globe radius (globe.gl-style unit sphere)', () => {
    // The ray/sphere solve must use the projection's radius, not EARTH_RADIUS,
    // or every ray misses the sphere it is supposed to hit.
    const unit = new GlobeProjection({ longitude: 0, latitude: 0 }, 100);
    const { bounds } = viewportFor(unit, { ...CENTRE, zoom: 5 });
    expect(bounds.minLat).toBeLessThan(CENTRE.latitude);
    expect(bounds.maxLat).toBeGreaterThan(CENTRE.latitude);
  });
});

// ── Defect 2: the pitch ≥ 90 − fov/2 collapse ───────────────────────────────

describe('cameraToViewport — the horizon band', () => {
  const proj = new MercatorProjection();
  const CENTRE = { longitude: -97, latitude: 41, zoom: 9 };

  it('does not collapse to a zero-height line at pitch 65 (fov 50)', () => {
    // Pre-fix: pitch 64 gave a 45° longitude span reaching lat 60.8, pitch 65
    // gave minLat === maxLat === 40.4459 — both top corners dropped, exactly
    // two symmetric bottom corners surviving, so `hits.length < 2` never fired.
    const { bounds } = viewportFor(proj, { ...CENTRE, pitch: 65 });
    expect(bounds.maxLat).toBeGreaterThan(bounds.minLat);
    expect(latSpan(bounds)).toBeGreaterThan(1);
  });

  it('grows with pitch while all four corners still reach the ground', () => {
    const spans = [0, 20, 40, 55, 60, 62, 63].map((pitch) =>
      latSpan(viewportFor(proj, { ...CENTRE, pitch }).bounds),
    );
    const sorted = [...spans].sort((a, b) => a - b);
    expect(spans).toEqual(sorted);
    expect(new Set(spans).size).toBe(spans.length);
  });

  // THE regression test for the reported flash — and the reason the defect
  // survived Wave 2. The first version of this test walked pitch 55→85 in
  // INTEGER steps and allowed each step a ×0.75–×2 change. At that granularity
  // the spike is INVISIBLE: the measured integer steps around the collapse are
  // 63→64 ×1.422, 64→65 ×1.458, 65→66 ×0.976, all comfortably inside the band,
  // while the box in between reached the ENTIRE PLANET. A one-degree sample
  // simply never landed on the peak.
  //
  // The spike is narrow because it is a 1/tan(depression) pole. A ray one
  // hundredth of a degree above the grazing angle still SOLVES against the
  // ground plane — `intersectSurface` returns a point, just one ~5,700 camera
  // heights away — so any horizon guard reached by "the solve returned null"
  // never fires for it. The measured pre-fix numbers at z9/1440×900:
  //
  //   pitch 64.90  lat span 49.36  lon span 360.00 (the whole world)
  //   pitch 64.95  lat span 49.55  lon span 360.00
  //   pitch 65.00  lat span 29.69  lon span  62.74   ← ×0.599 lat, ×0.174 lon
  //
  // and a SECOND, larger spike where the next NDC row (ny = 0.5, horizontal at
  // pitch 76.88) crosses:
  //
  //   pitch 76.85  lat [40.31, 90.00]  lon [-180, 180]
  //   pitch 76.90  lat [40.31, 59.15]  lon [-114.7, -79.3]  ← ×0.379, ×0.098
  //
  // Every NDC row has its own crossing pitch, so a sweep must be fine enough to
  // land inside each pole, and the assertion must be tight enough that a box
  // that momentarily claims the planet cannot pass. 0.05° steps and a ×0.9–×1.12
  // per-step band do both: the widest legitimate step is the approach to the
  // clamp itself (depression 0.623° → 0.573° is a 8.7 % change in reach).
  const PITCH_STEP = 0.05;
  const STEP_RATIO_MIN = 0.9;
  const STEP_RATIO_MAX = 1.12;

  interface Spike {
    pitch: number;
    axis: 'lat' | 'lon';
    ratio: number;
    span: number;
  }

  /** Walk pitch in sub-degree steps, reporting every discontinuous step. */
  function sweepPitch(view: ViewState): {
    spikes: Spike[];
    degenerate: number[];
    maxLatSpan: number;
    maxLonSpan: number;
  } {
    const spikes: Spike[] = [];
    const degenerate: number[] = [];
    let prevLat = 0;
    let prevLon = 0;
    let maxLatSpan = 0;
    let maxLonSpan = 0;
    for (let p = 55; p <= 85 + 1e-9; p += PITCH_STEP) {
      const pitch = Math.round(p * 1e4) / 1e4;
      const b = viewportFor(proj, { ...view, pitch }).bounds;
      const la = latSpan(b);
      const lo = lonSpan(b);
      if (!(la > 0) || !(lo > 0)) degenerate.push(pitch);
      maxLatSpan = Math.max(maxLatSpan, la);
      maxLonSpan = Math.max(maxLonSpan, lo);
      for (const [axis, span, prev] of [
        ['lat', la, prevLat],
        ['lon', lo, prevLon],
      ] as const) {
        if (!prev) continue;
        const ratio = span / prev;
        if (!(ratio > STEP_RATIO_MIN && ratio < STEP_RATIO_MAX)) {
          spikes.push({
            pitch,
            axis,
            ratio: Math.round(ratio * 1e4) / 1e4,
            span: Math.round(span * 1e3) / 1e3,
          });
        }
      }
      prevLat = la;
      prevLon = lo;
    }
    return { spikes, degenerate, maxLatSpan, maxLonSpan };
  }

  it('crosses the horizon continuously — no explode-then-collapse', () => {
    const { spikes, degenerate } = sweepPitch(CENTRE);
    expect(degenerate).toEqual([]);
    expect(spikes).toEqual([]);
  });

  it('crosses the horizon continuously at a deeper zoom and off north', () => {
    // The pole sits at the same PITCH regardless of zoom or bearing — it is a
    // property of the NDC row's elevation — but its height scales with the
    // camera altitude, so a deep zoom explodes by a larger factor from a smaller
    // base (pre-fix z13: ×2.45 lat, ×2.93 lon at pitch 76.85). Bearing 45 also
    // rotates the spike out of the latitude axis and into both.
    expect(sweepPitch({ ...CENTRE, zoom: 13 }).spikes).toEqual([]);
    expect(sweepPitch({ ...CENTRE, bearing: 45 }).spikes).toEqual([]);
  });

  it('never lets a city-scale camera claim the whole planet', () => {
    // The blunt, threshold-free statement of the same defect: a z9 camera 111 km
    // above the ground cannot see the poles or the far side of the world at ANY
    // tilt. Pre-fix it claimed exactly that at pitch 64.85–64.95 and 76.75–76.85
    // (lon span 360.000, maxLat 90.000) — a full-world tile scan, twice, inside
    // a single smooth camera move.
    for (const view of [CENTRE, { ...CENTRE, zoom: 13 }]) {
      const { maxLatSpan, maxLonSpan } = sweepPitch(view);
      expect(maxLonSpan).toBeLessThan(180);
      expect(maxLatSpan).toBeLessThan(45);
    }
  });

  it('keeps the view centre inside the box through the whole pitch sweep', () => {
    const missed: number[] = [];
    for (const pitch of [0, 30, 55, 64, 65, 70, 80, 85]) {
      const { bounds } = viewportFor(proj, { ...CENTRE, pitch });
      if (!(bounds.minLat <= 41 && 41 <= bounds.maxLat)) missed.push(pitch);
    }
    expect(missed).toEqual([]);
  });

  it('extends the box FORWARD of the camera under tilt, not symmetrically', () => {
    // Bearing 0 looks north, so a pitched frame must reach much further north
    // of the centre than south of it. A symmetric box means the far half of the
    // frame was dropped.
    const { bounds } = viewportFor(proj, {
      ...CENTRE,
      pitch: 70,
      bearing: 0,
    });
    const north = bounds.maxLat - 41;
    const south = 41 - bounds.minLat;
    expect(north).toBeGreaterThan(south * 5);
  });

  it('never emits an inverted box across a pitch × bearing matrix', () => {
    const bad: Array<{ pitch: number; bearing: number; bounds: unknown }> = [];
    for (const pitch of [0, 20, 45, 60, 64, 65, 71, 75, 80, 85]) {
      for (const bearing of [0, 30, 45, 90, 135, 200, 270, 350]) {
        const { bounds } = viewportFor(proj, { ...CENTRE, pitch, bearing });
        const latOk =
          bounds.minLat <= bounds.maxLat &&
          bounds.minLat >= -90 &&
          bounds.maxLat <= 90;
        // Longitude may legally be `min > max` (the antimeridian crossing
        // encoding) but never with an implied span past the seam cap — that is
        // the inversion signature.
        const lonOk =
          lonSpan(bounds) <= 360 &&
          (bounds.minLon <= bounds.maxLon ||
            lonSpan(bounds) < MAX_SEAM_SPAN_DEG);
        if (!latOk || !lonOk) bad.push({ pitch, bearing, bounds });
      }
    }
    expect(bad).toEqual([]);
  });
});

// ── Defect 3: four independent zoom errors ─────────────────────────────────

describe('cameraToViewport — zoom', () => {
  const proj = new MercatorProjection();
  const CENTRE = { longitude: -97, latitude: 41 };

  it('matches the authored zoom at pitch 0 (the float-flip case)', () => {
    // Pre-fix this returned 8 for an authored z9: the continuous zoom landed a
    // few ULP under 9 and `Math.floor` took a whole level off a flat, north-up,
    // landscape camera — the most common camera there is.
    const authored = [2, 5, 9, 12, 14];
    expect(
      authored.map((zoom) => viewportFor(proj, { ...CENTRE, zoom }).zoom),
    ).toEqual(authored);
  });

  it('is invariant to pitch (it used to read 2–5 levels too coarse)', () => {
    // Pre-fix at authored z9: pitch 0 → 8, 55 → 7, 60 → 6, 64 → 4, 65 → 10.
    const pitches = [0, 30, 55, 60, 64, 65, 70, 80, 85];
    expect(
      pitches.map(
        (pitch) => viewportFor(proj, { ...CENTRE, zoom: 9, pitch }).zoom,
      ),
    ).toEqual(pitches.map(() => 9));
  });

  it('is invariant to bearing (it used to jump a level at 90°)', () => {
    // Pre-fix at authored z9: bearing 0/30/45/60 → 8 but bearing 90 → 9.
    const bearings = [0, 30, 45, 60, 90, 135, 180, 270];
    expect(
      bearings.map(
        (bearing) => viewportFor(proj, { ...CENTRE, zoom: 9, bearing }).zoom,
      ),
    ).toEqual(bearings.map(() => 9));
  });

  it('is invariant to canvas aspect (it used to bias portrait coarse)', () => {
    // Pre-fix: landscape 8, portrait 8, both for an authored z9 — the ground
    // span was measured on whichever axis was LARGER and divided by the
    // viewport WIDTH regardless.
    expect(viewportFor(proj, { ...CENTRE, zoom: 9 }, LANDSCAPE).zoom).toBe(9);
    expect(viewportFor(proj, { ...CENTRE, zoom: 9 }, PORTRAIT).zoom).toBe(9);
  });

  it('agrees with the recovered view state, floored', () => {
    for (const pitch of [0, 45, 70]) {
      const vs: ViewState = { ...CENTRE, zoom: 11.6, pitch, bearing: 25 };
      const cam = cameraFor(proj, vs);
      const continuous = cameraToViewState(proj, cam, {
        viewportHeight: LANDSCAPE.height,
      }).zoom;
      const vp = cameraToViewport(proj, cam, LANDSCAPE);
      expect(vp?.zoom).toBe(Math.floor(continuous));
    }
  });

  it('clamps into the archive zoom range', () => {
    expect(
      viewportFor(proj, { ...CENTRE, zoom: 14 }, LANDSCAPE, {
        minZoom: 0,
        maxZoom: 8,
      }).zoom,
    ).toBe(8);
    expect(
      viewportFor(proj, { ...CENTRE, zoom: 2 }, LANDSCAPE, {
        minZoom: 6,
        maxZoom: 12,
      }).zoom,
    ).toBe(6);
  });
});

// ── The §4.1 contract: reject rather than select against garbage ────────────

describe('cameraToViewport — unusable cameras', () => {
  const proj = new MercatorProjection();

  it('returns null for a NaN camera position instead of a NaN box', () => {
    const cam = cameraFor(proj, { longitude: -97, latitude: 41, zoom: 9 });
    cam.position.set(Number.NaN, Number.NaN, Number.NaN);
    expect(cameraToViewport(proj, cam, LANDSCAPE)).toBeNull();
  });

  it('returns null for a zero-sized canvas (the first frames after mount)', () => {
    const cam = new PerspectiveCamera(50, 0, 0.1, 1e9);
    cam.position.set(0, 0, 1e6);
    cam.up.set(0, 0, 1);
    cam.lookAt(0, 0, 0);
    expect(cameraToViewport(proj, cam, { width: 0, height: 0 })).toBeNull();
  });
});

// ── Planar (local-ENU) frames keep working ─────────────────────────────────

describe('cameraToViewport — local-ENU frames', () => {
  const proj = new LocalEnuProjection({ longitude: 4.9, latitude: 52.37 });

  it('brackets the anchor for a top-down camera', () => {
    const { bounds } = viewportFor(proj, {
      longitude: 4.9,
      latitude: 52.37,
      zoom: 13,
    });
    expect(bounds.minLon).toBeLessThan(4.9);
    expect(bounds.maxLon).toBeGreaterThan(4.9);
    expect(bounds.minLat).toBeLessThan(52.37);
    expect(bounds.maxLat).toBeGreaterThan(52.37);
  });

  it('widens rather than inverts as the camera rotates', () => {
    const flat = viewportFor(proj, {
      longitude: 4.9,
      latitude: 52.37,
      zoom: 13,
      bearing: 0,
    }).bounds;
    const turned = viewportFor(proj, {
      longitude: 4.9,
      latitude: 52.37,
      zoom: 13,
      bearing: 45,
    }).bounds;
    // The AABB of a rotated quad is strictly larger on the short axis — the
    // pre-2026-07 two-corner box shrank here and eventually inverted.
    expect(latSpan(turned)).toBeGreaterThan(latSpan(flat));
  });
});

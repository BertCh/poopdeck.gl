// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import {
  resolveCesiumStreamView,
  viewRectangleToBounds,
  verticalFovRadians,
  isWholeWorldRectangle,
  type CameraRectangleRadians,
} from '../src/lib/stream-view';
import type { BoundingBox } from '@poopdeck.gl/core';

const DEG2RAD = Math.PI / 180;
const rect = (
  westDeg: number,
  southDeg: number,
  eastDeg: number,
  northDeg: number,
): CameraRectangleRadians => ({
  west: westDeg * DEG2RAD,
  south: southDeg * DEG2RAD,
  east: eastDeg * DEG2RAD,
  north: northDeg * DEG2RAD,
});

// Cesium's Rectangle.MAX_VALUE.
const MAX_VALUE: CameraRectangleRadians = {
  west: -Math.PI,
  south: -Math.PI / 2,
  east: Math.PI,
  north: Math.PI / 2,
};

// `ais-all-us` — the archive the full-extent fallback is most expensive for
// (it spans the antimeridian, so its own extent is nearly the whole world).
const AIS_BOUNDS: BoundingBox = {
  minLon: -171.58,
  minLat: 3.65,
  maxLon: 144.99,
  maxLat: 73.27,
};

// A nadir camera 20 km up, looking straight down — the zoom-solve baseline.
const NADIR = {
  longitude: 0,
  latitude: 0,
  height: 20_000,
  headingRad: 0,
  pitchRad: -Math.PI / 2,
  rollRad: 0,
};

describe('viewRectangleToBounds', () => {
  it('keeps a seam-crossing footprint as the crossing encoding', () => {
    // Camera over the Aleutians: west 175, east -175. `east >= west` reads that
    // as unusable, and the old fallback handed selection the ARCHIVE extent —
    // for ais-all-us a ~316° span, millions of candidate cells per level, from a
    // camera looking at 10° of ocean. minLon > maxLon is the encoding core wants.
    const bounds = viewRectangleToBounds(rect(175, 50, -175, 56));
    expect(bounds).not.toBeNull();
    expect(bounds!.minLon).toBeCloseTo(175, 9);
    expect(bounds!.maxLon).toBeCloseTo(-175, 9);
  });

  it('rejects Rectangle.MAX_VALUE — it is a "cannot measure", not a footprint', () => {
    expect(isWholeWorldRectangle(MAX_VALUE)).toBe(true);
    expect(viewRectangleToBounds(MAX_VALUE)).toBeNull();
  });

  it('rejects an absent or non-finite rectangle', () => {
    expect(viewRectangleToBounds(null)).toBeNull();
    expect(viewRectangleToBounds(undefined)).toBeNull();
    expect(
      viewRectangleToBounds({ ...rect(1, 2, 3, 4), north: NaN }),
    ).toBeNull();
  });

  it('converts an ordinary footprint to degrees', () => {
    expect(viewRectangleToBounds(rect(-80, 43, -79, 44))).toEqual({
      minLon: -80,
      minLat: 43,
      maxLon: -79,
      maxLat: 44,
    });
  });
});

describe('resolveCesiumStreamView — bounds', () => {
  const base = {
    camera: NADIR,
    archiveBounds: AIS_BOUNDS,
    minZoom: 0,
    maxZoom: 14,
  };

  it('does NOT fall back to the archive extent at the antimeridian', () => {
    const out = resolveCesiumStreamView({
      ...base,
      rect: rect(175, 50, -175, 56),
    });
    expect(out).not.toBeNull();
    expect(out!.bounds.minLon).toBeCloseTo(175, 9);
    expect(out!.bounds.maxLon).toBeCloseTo(-175, 9);
    expect(out!.bounds).not.toEqual(AIS_BOUNDS);
  });

  it('falls back to the archive extent when the rectangle is MAX_VALUE', () => {
    const out = resolveCesiumStreamView({ ...base, rect: MAX_VALUE });
    // Not [-180, -90, 180, 90] dressed up as a measurement: the archive's own
    // extent is the narrowest honest answer available.
    expect(out!.bounds).toEqual(AIS_BOUNDS);
  });

  it('honours useGlobalBounds by ignoring the footprint entirely', () => {
    const out = resolveCesiumStreamView({
      ...base,
      rect: rect(-80, 43, -79, 44),
      useGlobalBounds: true,
    });
    expect(out!.bounds).toEqual(AIS_BOUNDS);
  });

  it('repairs an inverted latitude box rather than selecting zero tiles', () => {
    // minLat > maxLat makes boundsToTiles' row loop never execute — no tiles at
    // all, while every readiness signal reports settled. §4.1 rule 2 swaps it.
    const out = resolveCesiumStreamView({
      ...base,
      rect: {
        ...rect(-80, 0, -79, 0),
        south: 44 * DEG2RAD,
        north: 43 * DEG2RAD,
      },
    });
    expect(out!.bounds.minLat).toBeCloseTo(43, 9);
    expect(out!.bounds.maxLat).toBeCloseTo(44, 9);
  });

  it('returns null (keep the previous viewport) when nothing is finite', () => {
    expect(
      resolveCesiumStreamView({
        ...base,
        rect: null,
        archiveBounds: { minLon: NaN, minLat: 0, maxLon: 1, maxLat: 1 },
      }),
    ).toBeNull();
    expect(
      resolveCesiumStreamView({
        ...base,
        rect: rect(-80, 43, -79, 44),
        camera: { ...NADIR, height: NaN },
      }),
    ).toBeNull();
  });
});

describe('resolveCesiumStreamView — zoom', () => {
  const base = {
    rect: rect(-80, 43, -79, 44),
    archiveBounds: AIS_BOUNDS,
    minZoom: 0,
    maxZoom: 14,
  };

  it('FLOORS the zoom, as deck/three/maplibre do', () => {
    // The archive directory is keyed by integer zoom, so a rounded zoom claims a
    // level of detail the camera has not earned: everything from x.5 up is served
    // one level too fine on the way in and one level too COARSE relative to the
    // floor convention every other backend uses.
    const heights: number[] = [];
    for (let i = 0; i < 64; i++) heights.push(1000 * Math.pow(1.2, i));
    for (const height of heights) {
      const camera = { ...NADIR, height };
      const out = resolveCesiumStreamView({ ...base, camera })!;
      const exact = exactZoom(height);
      if (exact >= 0 && exact <= 14) {
        expect(out.zoom).toBe(Math.floor(exact));
      }
    }
  });

  it('clamps into the archive zoom range', () => {
    expect(
      resolveCesiumStreamView({ ...base, camera: { ...NADIR, height: 1 } })!
        .zoom,
    ).toBe(14);
    expect(
      resolveCesiumStreamView({
        ...base,
        camera: { ...NADIR, height: 4e7 },
      })!.zoom,
    ).toBe(0);
  });

  it('reads the REAL canvas height, not a hard-coded 800 px', () => {
    const camera = { ...NADIR, height: 60_000 };
    const short = resolveCesiumStreamView({
      ...base,
      camera,
      view: { viewportHeight: 800, fovRadians: (60 * Math.PI) / 180 },
    })!;
    const tall = resolveCesiumStreamView({
      ...base,
      camera,
      view: { viewportHeight: 1600, fovRadians: (60 * Math.PI) / 180 },
    })!;
    // Twice the canvas height at one altitude is one zoom level finer.
    expect(tall.zoom - short.zoom).toBe(1);
  });

  it('a zoomOverride bypasses the camera solve', () => {
    const out = resolveCesiumStreamView({
      ...base,
      camera: NADIR,
      zoomOverride: 3,
    })!;
    expect(out.zoom).toBe(3);
  });
});

describe('verticalFovRadians', () => {
  it('prefers the frustum fovy once the frustum has one', () => {
    expect(verticalFovRadians({ fovy: 0.5, fov: 1.0, aspectRatio: 2 })).toBe(
      0.5,
    );
  });

  it('derives fovy from a landscape fov — Cesium fov is HORIZONTAL there', () => {
    // Reading the 60° default as vertical over-states the half-angle by the
    // aspect ratio: ~0.83 zoom levels too coarse on 16:9.
    const fov = (60 * Math.PI) / 180;
    const aspect = 16 / 9;
    expect(verticalFovRadians({ fov, aspectRatio: aspect })).toBeCloseTo(
      2 * Math.atan(Math.tan(fov / 2) / aspect),
      12,
    );
    expect(verticalFovRadians({ fov }, aspect)).toBeCloseTo(
      2 * Math.atan(Math.tan(fov / 2) / aspect),
      12,
    );
  });

  it('leaves a portrait fov alone (Cesium treats it as vertical there)', () => {
    expect(verticalFovRadians({ fov: 1, aspectRatio: 0.75 })).toBe(1);
  });

  it('rejects the zero-height container fovy of EXACTLY 0', () => {
    // Verified against real @cesium/engine 26 (see test/camera-apply.test.ts for
    // the Node harness): `Camera`'s constructor sets
    // `frustum.aspectRatio = drawingBufferWidth / drawingBufferHeight`, so a
    // container that is 1200 × 0 at construction — a flex/grid child measured
    // before layout, a `display:none` panel, a tab restored in the background —
    // gives aspectRatio `Infinity`, and `PerspectiveFrustum.fovy` then evaluates
    // `2·atan(tan(fov/2) / Infinity)` = 0. That 0 is finite, so it passed the
    // `Number.isFinite` gate and was returned as a measurement.
    //
    // Downstream it is fatal rather than merely wrong: `wupp = range · 2·tan(0) / H`
    // is 0, `zoomForWorldUnitsPerPixel` returns `log2(base / 0)` = Infinity, and
    // `resolveCesiumStreamView`'s finiteness check turns that into `null` — "keep
    // the previous viewport". On the FIRST frame there is no previous viewport,
    // so the tileset is never given one and the map stays blank with no error,
    // no warning and no self-healing path inside this module.
    expect(
      verticalFovRadians({
        fovy: 0,
        fov: 1.0471975511965976,
        aspectRatio: Infinity,
      }),
    ).toBeUndefined();
    // …and the same frustum WITHOUT a cached fovy must not re-derive the 0.
    expect(
      verticalFovRadians({ fov: 1.0471975511965976, aspectRatio: Infinity }),
    ).toBeUndefined();
    expect(
      verticalFovRadians({ fov: 1.0471975511965976 }, 1200 / 0),
    ).toBeUndefined();
  });

  it('rejects a negative or non-finite fovy', () => {
    expect(verticalFovRadians({ fovy: -0.5 })).toBeUndefined();
    expect(verticalFovRadians({ fovy: NaN, fov: 1, aspectRatio: 1 })).toBe(1);
  });

  it('rejects a degenerate fov or aspect ratio instead of deriving from it', () => {
    // aspectRatio 0 is the mirror container (0 × 800) and yields fovy === fov,
    // which is not a measurement either; a negative one is nonsense Cesium's own
    // frustum throws on; fov outside (0, π) is not a perspective angle.
    expect(verticalFovRadians({ fov: 1, aspectRatio: 0 })).toBeUndefined();
    expect(verticalFovRadians({ fov: 1, aspectRatio: -2 })).toBeUndefined();
    expect(verticalFovRadians({ fov: 0, aspectRatio: 1.5 })).toBeUndefined();
    expect(
      verticalFovRadians({ fov: Math.PI, aspectRatio: 1.5 }),
    ).toBeUndefined();
  });

  it('a degenerate frustum still yields a usable stream view, not nothing', () => {
    // The end-to-end statement of the same defect: the caller's
    // `fovRadians: verticalFovRadians(frustum)` must degrade to the 60° default,
    // producing a slightly-wrong zoom, rather than to a zoom of Infinity and a
    // null (= "no selection ever") stream view. The frustum is shaped as a LIVE
    // one: `PerspectiveFrustum.fovy` is a getter that computes and caches, so by
    // the time the render loop hands the frustum over it always carries a
    // `fovy` — here the 0 that Infinity aspect produces.
    const degenerate = {
      fovy: 0,
      fov: (60 * Math.PI) / 180,
      aspectRatio: Infinity,
    };
    const out = resolveCesiumStreamView({
      rect: rect(-80, 43, -79, 44),
      camera: { ...NADIR, height: 20_000 },
      archiveBounds: AIS_BOUNDS,
      minZoom: 0,
      maxZoom: 14,
      view: {
        viewportHeight: 800,
        fovRadians: verticalFovRadians(degenerate),
      },
    });
    expect(out).not.toBeNull();
    expect(Number.isFinite(out!.zoom)).toBe(true);
    expect(out!.zoom).toBe(Math.floor(exactZoom(20_000)));
  });

  it('returns undefined for an orthographic frustum or an unmeasured canvas', () => {
    expect(verticalFovRadians({ width: 100 } as never)).toBeUndefined();
    expect(verticalFovRadians(null)).toBeUndefined();
    expect(verticalFovRadians({ fov: 1 })).toBeUndefined();
  });
});

/** Zoom a nadir camera at `height` implies under the 800 px / 60° defaults. */
function exactZoom(height: number): number {
  const WORLD_CIRCUMFERENCE = 2 * Math.PI * 6378137;
  const wupp = (height * 2 * Math.tan((60 * Math.PI) / 180 / 2)) / 800;
  return Math.log2(WORLD_CIRCUMFERENCE / (512 * wupp));
}

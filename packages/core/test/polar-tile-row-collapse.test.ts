// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl contributors

/**
 * The polar zero-tile collapse — a cross-module invariant between
 * `normalizeViewportBounds` (which decides how far toward the pole a viewport
 * box may reach) and `latToTileY` (which turns that latitude into a tile row).
 *
 * `latToTileY` evaluates `log(tan(rad) + 1 / cos(rad))`. `tan` and `1 / cos`
 * diverge with OPPOSITE signs as `|lat| → 90`, so in the sliver just inside a
 * pole their sum is the difference of two enormous floats. Cancellation drives
 * it slightly NEGATIVE and `Math.log` returns `NaN`. A `NaN` row bound makes
 * `boundsToTiles`' `for (y = minY; y <= maxY; y++)` never execute: ZERO tiles,
 * while every readiness signal reports settled. A blank map from a camera that
 * is showing the whole world.
 *
 * The trap that hid this: EXACTLY ±90 is safe. The sum overflows cleanly to
 * `Infinity`, which clamps to a valid row. So clamping latitude to ±90 — which
 * is what the code did, and which reads as obviously correct — lands *inside*
 * the only band where the arithmetic breaks.
 *
 * Found by an adversarial sweep over 23,328 cameras: 24 of them selected zero
 * tiles. The repro below is one of them, and is deterministic.
 */

import { describe, it, expect } from 'vitest';
import { normalizeViewportBounds } from '../src/geo/viewport-bounds';
import { MAX_MERCATOR_LAT } from '../src/geo/mercator';
import { latToTileY } from '../src/archive';

/** The bounds a real camera produced: 1600x900, lon 0, lat -35, z2, pitch 70, bearing 90. */
const REPRO = {
  minLon: -180,
  minLat: -89.99999999998705,
  maxLon: 180,
  maxLat: 89.99999999995221,
};

describe('latToTileY — the near-pole cancellation', () => {
  it('is finite a hair inside the poles, where the naive expression is NaN', () => {
    // The exact latitudes the repro camera produced. Before the clamp these
    // returned NaN (minLat) and a large negative row (maxLat).
    for (const zoom of [0, 2, 8, 14]) {
      expect(latToTileY(REPRO.minLat, zoom)).toBeTypeOf('number');
      expect(Number.isFinite(latToTileY(REPRO.minLat, zoom))).toBe(true);
      expect(Number.isFinite(latToTileY(REPRO.maxLat, zoom))).toBe(true);
    }
  });

  it('is finite across a dense sweep through the danger band and past ±90', () => {
    // Walk the last degree into each pole at decreasing magnitudes, i.e. the
    // whole cancellation window, plus values beyond the pole entirely.
    const lats: number[] = [90, -90, 91, -91, 1e3, -1e3];
    for (let e = 1; e <= 14; e++) {
      const d = 10 ** -e;
      lats.push(90 - d, -90 + d);
    }
    for (const lat of lats) {
      for (const zoom of [0, 2, 8, 14]) {
        const y = latToTileY(lat, zoom);
        expect(Number.isFinite(y), `latToTileY(${lat}, ${zoom}) = ${y}`).toBe(
          true,
        );
      }
    }
  });

  it('still round-trips ordinary latitudes to the expected rows', () => {
    // Guard that the clamp did not disturb the normal range.
    expect(latToTileY(0, 1)).toBe(1);
    expect(latToTileY(0, 2)).toBe(2);
    expect(latToTileY(85.0511287798066, 2)).toBe(0);
    expect(latToTileY(-85.0511287798066, 2)).toBe(3);
    // Monotone non-increasing in latitude (north is row 0).
    for (const zoom of [4, 8]) {
      let prev = latToTileY(-85, zoom);
      for (let lat = -84; lat <= 85; lat += 1) {
        const y = latToTileY(lat, zoom);
        expect(y).toBeLessThanOrEqual(prev);
        prev = y;
      }
    }
  });
});

describe('normalizeViewportBounds — clamps to the Mercator edge, not the pole', () => {
  it('clamps a past-the-pole box to ±MAX_MERCATOR_LAT', () => {
    const out = normalizeViewportBounds({
      minLon: -10,
      minLat: -95,
      maxLon: 10,
      maxLat: 95,
    })!;
    expect(out.bounds.minLat).toBe(-MAX_MERCATOR_LAT);
    expect(out.bounds.maxLat).toBe(MAX_MERCATOR_LAT);
    expect(out.issues).toContain('clamped-lat');
  });

  it('clamps the repro box into the representable band', () => {
    const out = normalizeViewportBounds(REPRO)!;
    expect(out.bounds.minLat).toBe(-MAX_MERCATOR_LAT);
    expect(out.bounds.maxLat).toBe(MAX_MERCATOR_LAT);
  });

  it('leaves latitudes inside the band exactly alone', () => {
    const bounds = { minLon: -98, minLat: -35, maxLon: -96, maxLat: 40 };
    const out = normalizeViewportBounds(bounds)!;
    expect(out.bounds).toEqual(bounds);
    expect(out.issues).toEqual([]);
  });
});

describe('the invariant that actually matters: a normalized box selects rows', () => {
  /** What `boundsToTiles` does with the latitude pair, in isolation. */
  function rowSpan(minLat: number, maxLat: number, zoom: number) {
    const n = 1 << zoom;
    const yTop = latToTileY(maxLat, zoom);
    const yBottom = latToTileY(minLat, zoom);
    const top = Math.max(0, Math.min(n - 1, yTop));
    const bottom = Math.max(0, Math.min(n - 1, yBottom));
    return { top, bottom, rows: bottom - top + 1 };
  }

  it('the repro camera selects the full column instead of zero tiles', () => {
    const out = normalizeViewportBounds(REPRO)!;
    const { top, bottom, rows } = rowSpan(
      out.bounds.minLat,
      out.bounds.maxLat,
      2,
    );
    // A whole-world view at z2 must cover all four rows. Before the fix this
    // was 0 rows, because yBottom was NaN.
    expect(Number.isNaN(top)).toBe(false);
    expect(Number.isNaN(bottom)).toBe(false);
    expect(rows).toBe(4);
  });

  it('never collapses to zero rows over a hostile latitude sweep', () => {
    const nasty = [
      -1e3, -95, -90, -89.99999999998705, -89.999999, -89.9, -85.1, -85, -40, 0,
      40, 85, 85.1, 89.9, 89.999999, 89.99999999995221, 90, 95, 1e3,
    ];
    for (const a of nasty) {
      for (const b of nasty) {
        const out = normalizeViewportBounds({
          minLon: -180,
          minLat: a,
          maxLon: 180,
          maxLat: b,
        });
        expect(out).not.toBeNull();
        for (const zoom of [0, 2, 6, 10]) {
          const { rows } = rowSpan(
            out!.bounds.minLat,
            out!.bounds.maxLat,
            zoom,
          );
          expect(rows, `minLat=${a} maxLat=${b} zoom=${zoom}`).toBeGreaterThan(
            0,
          );
        }
      }
    }
  });
});

/**
 * Metres↔mercator scale (campaign D10 elevation reconciliation + metricSizing).
 *
 * Known-value assertions are pinned against MapLibre's own arithmetic
 * (`mercatorZfromAltitude`, `transform._pixelPerMeter`) because "correct" here
 * means "agrees with the host that owns the camera", not "agrees with a
 * textbook ellipsoid". The last block pins the OLD 1e-7 behavior so the ~4×
 * height reduction is documented as intentional.
 */

import { describe, it, expect } from 'vitest';
import {
  EARTH_CIRCUMFERENCE_M,
  EARTH_RADIUS_M,
  latFromMercatorY,
  lngLatToMercator,
  mercatorZFromAltitude,
  metersPerMercatorUnit,
  metersToMercatorUnits,
  metersToPixelsAtLatitude,
  tileCenterLatitude,
} from '../src/lib/projection';

// The pre-D10 flat altitude→mercator-z factor, kept as a local literal purely
// as the regression anchor for the correction (it is no longer exported —
// nothing reads it). `HISTORICAL_FLAT_SCALE / mercatorZFromAltitude(1, 0)` =
// 4.003, the "~4x too tall" the ecosystem audit measured.
const HISTORICAL_FLAT_SCALE = 1e-7;

// maplibre's earthCircumference, spelled out so a constant change here has to
// be a deliberate edit to this literal too.
const MAPLIBRE_EARTH_CIRCUMFERENCE = 40030228.88407185;

describe('earth constants (host-matched)', () => {
  it('uses maplibre/mapbox mean radius, not the WGS84 semi-major axis', () => {
    expect(EARTH_RADIUS_M).toBe(6371008.8);
    expect(EARTH_CIRCUMFERENCE_M).toBeCloseTo(MAPLIBRE_EARTH_CIRCUMFERENCE, 6);
    // The core geo kernel's WORLD_CIRCUMFERENCE (2π·6378137) is 0.11% larger —
    // this backend deliberately does not use it.
    expect(EARTH_CIRCUMFERENCE_M).toBeLessThan(2 * Math.PI * 6378137);
  });

  it('reproduces the retired MERCATOR_Z_TO_METERS_MIDLAT stopgap at 45°', () => {
    // The polygon layer's mid-latitude conversion constant is gone (Wave M2
    // resolves the factor per tile at its own latitude). Pinned numerically —
    // never by import — so this stays the record of what it was worth.
    expect(metersPerMercatorUnit(45)).toBeCloseTo(
      MAPLIBRE_EARTH_CIRCUMFERENCE * Math.SQRT1_2,
      6,
    );
  });
});

describe('mercatorZFromAltitude / metersPerMercatorUnit', () => {
  it('1 m at the equator is 1/circumference mercator units', () => {
    expect(mercatorZFromAltitude(1, 0)).toBeCloseTo(
      1 / MAPLIBRE_EARTH_CIRCUMFERENCE,
      18,
    );
    // ~2.498e-8 — the value maplibre's own mercatorZfromAltitude(1, 0) returns.
    expect(mercatorZFromAltitude(1, 0)).toBeCloseTo(2.4981e-8, 12);
    expect(metersPerMercatorUnit(0)).toBeCloseTo(
      MAPLIBRE_EARTH_CIRCUMFERENCE,
      6,
    );
  });

  it('at 60°N cos halves the scale: same altitude is twice the mercator-z', () => {
    const equator = mercatorZFromAltitude(1, 0);
    const sixty = mercatorZFromAltitude(1, 60);
    expect(sixty / equator).toBeCloseTo(2, 12);
    expect(metersPerMercatorUnit(60) / metersPerMercatorUnit(0)).toBeCloseTo(
      0.5,
      12,
    );
  });

  it('is symmetric in latitude sign and linear in metres', () => {
    expect(mercatorZFromAltitude(100, -37.8)).toBeCloseTo(
      mercatorZFromAltitude(100, 37.8),
      18,
    );
    expect(mercatorZFromAltitude(250, 45)).toBeCloseTo(
      2.5 * mercatorZFromAltitude(100, 45),
      18,
    );
    expect(mercatorZFromAltitude(0, 45)).toBe(0);
  });

  it('round-trips through metersPerMercatorUnit at every latitude band', () => {
    for (const lat of [0, 15, 37.8, 45, 60, 75, 85.05112877980659, -60]) {
      for (const meters of [1, 100, 8848, 400000]) {
        const z = mercatorZFromAltitude(meters, lat);
        expect(z * metersPerMercatorUnit(lat)).toBeCloseTo(meters, 6);
      }
    }
  });

  it('clamps past the Web Mercator cutoff instead of dividing by cos(90°)', () => {
    const cutoff = mercatorZFromAltitude(1, 85.05112877980659);
    expect(mercatorZFromAltitude(1, 90)).toBe(cutoff);
    expect(mercatorZFromAltitude(1, -90)).toBe(cutoff);
    expect(Number.isFinite(mercatorZFromAltitude(1, 90))).toBe(true);
    // Same clamp lngLatToMercator applies, so a vertex and its elevation are
    // scaled at one latitude.
    expect(Number.isFinite(lngLatToMercator(0, 90)[1])).toBe(true);
  });

  it('metersToMercatorUnits is the horizontal twin of the same factor', () => {
    for (const lat of [0, 45, 70]) {
      expect(metersToMercatorUnits(500, lat)).toBe(
        mercatorZFromAltitude(500, lat),
      );
    }
  });
});

describe('tile-centre latitude (the uniform granularity for D10)', () => {
  it('inverts lngLatToMercator', () => {
    for (const lat of [0, 12.5, 45, -33.9, 70]) {
      const [, y] = lngLatToMercator(0, lat);
      expect(latFromMercatorY(y)).toBeCloseTo(lat, 9);
    }
  });

  it('splits the world at z0 and gives the north tile at z1', () => {
    expect(tileCenterLatitude(0, 0)).toBeCloseTo(0, 9);
    expect(tileCenterLatitude(1, 0)).toBeGreaterThan(0);
    expect(tileCenterLatitude(1, 1)).toBeCloseTo(-tileCenterLatitude(1, 0), 9);
  });

  it('within-tile scale error follows the documented π·sin(lat)/2^z bound', () => {
    // The bound quoted in mercatorZFromAltitude's docs. Measured against the
    // real tile edges, not the linearization, so it is a genuine check.
    for (const [z, y] of [
      [4, 6],
      [8, 100],
      [10, 400],
    ] as const) {
      const centerLat = tileCenterLatitude(z, y);
      const span = 1 / Math.pow(2, z);
      const north = latFromMercatorY(y * span);
      const south = latFromMercatorY((y + 1) * span);
      const center = metersPerMercatorUnit(centerLat);
      const worst = Math.max(
        Math.abs(metersPerMercatorUnit(north) / center - 1),
        Math.abs(metersPerMercatorUnit(south) / center - 1),
      );
      const bound =
        (Math.PI * Math.abs(Math.sin((centerLat * Math.PI) / 180))) /
        Math.pow(2, z);
      // Bound is first-order; allow 25% headroom for the curvature it drops.
      expect(worst).toBeLessThanOrEqual(bound * 1.25);
    }
    // And the headline numbers the doc comment quotes: coarse zooms are NOT
    // negligible, z8+ is.
    expect((Math.PI * Math.sin(Math.PI / 4)) / 2 ** 4).toBeGreaterThan(0.1);
    expect((Math.PI * Math.sin(Math.PI / 4)) / 2 ** 8).toBeLessThan(0.01);
  });

  it('the π·sin(lat)/2^z bound COLLAPSES for an equator-straddling tile', () => {
    // The linearization is proportional to sin(centreLat), so the single z0
    // tile — centre latitude 0, spanning ±85.0511° — reports a 0% bound while
    // the true spread across it is cos(85.0511°) of the centre value. Archives
    // tiled from z0 (drifters, earthquakes, …) hit exactly this. The exact
    // form `max(|cos(latEdge)/cos(latCentre) − 1|)` is what holds.
    const centerLat = tileCenterLatitude(0, 0);
    expect(centerLat).toBeCloseTo(0, 9);
    const linearBound = (Math.PI * Math.abs(Math.sin(centerLat))) / 1;
    expect(linearBound).toBeCloseTo(0, 12); // the bound says "no error"

    const center = metersPerMercatorUnit(centerLat);
    const edge = metersPerMercatorUnit(latFromMercatorY(0)); // north edge
    const exact = Math.abs(edge / center - 1);
    expect(exact).toBeGreaterThan(0.9); // ...the truth is 91%
    expect(edge / center).toBeCloseTo(
      Math.cos((85.05112877980659 * Math.PI) / 180),
      6,
    );
  });
});

describe('metersToPixelsAtLatitude (metric sizing)', () => {
  it('reproduces the z0/512px ground resolution at the equator', () => {
    const pxPerMeter = metersToPixelsAtLatitude(1, 0, 0);
    expect(1 / pxPerMeter).toBeCloseTo(MAPLIBRE_EARTH_CIRCUMFERENCE / 512, 3);
    expect(1 / pxPerMeter).toBeCloseTo(78184.04, 2);
  });

  it('doubles per zoom level', () => {
    const z4 = metersToPixelsAtLatitude(100, 40, 4);
    expect(metersToPixelsAtLatitude(100, 40, 5)).toBeCloseTo(z4 * 2, 9);
    expect(metersToPixelsAtLatitude(100, 40, 6)).toBeCloseTo(z4 * 4, 9);
  });

  it('is maplibre _pixelPerMeter: mercatorZFromAltitude(1, lat) * worldSize', () => {
    for (const [lat, zoom] of [
      [0, 3],
      [45, 11],
      [60, 16],
    ] as const) {
      const worldSize = 512 * Math.pow(2, zoom);
      expect(metersToPixelsAtLatitude(1, lat, zoom)).toBeCloseTo(
        mercatorZFromAltitude(1, lat) * worldSize,
        12,
      );
    }
  });

  it('stretches with latitude — 1 m covers twice the pixels at 60°N', () => {
    expect(
      metersToPixelsAtLatitude(1, 60, 12) / metersToPixelsAtLatitude(1, 0, 12),
    ).toBeCloseTo(2, 12);
  });

  it('gives usable pixel sizes at high zoom', () => {
    // z20, equator: 512·2^20 / circumference ≈ 13.41 px per metre, so a 10 m
    // radius is ~134 px — the regime metric sizing exists for.
    expect(metersToPixelsAtLatitude(1, 0, 20)).toBeCloseTo(13.4116, 3);
    expect(metersToPixelsAtLatitude(10, 0, 20)).toBeCloseTo(134.116, 2);
  });

  it('tileSize is the pixel-space knob: ×dpr yields device pixels', () => {
    // Layer shaders offset in device pixels (uViewport = drawingBuffer size,
    // gl_PointSize is device px), so a metric layer passes 512 * dpr.
    const css = metersToPixelsAtLatitude(50, 51.5, 14);
    expect(metersToPixelsAtLatitude(50, 51.5, 14, 512 * 2)).toBeCloseTo(
      css * 2,
      9,
    );
  });
});

describe('D10 regression pin: the OLD 1e-7 altitudeScale was ~4× too tall', () => {
  it('HISTORICAL_FLAT_SCALE overstates equatorial height by 4.003×', () => {
    expect(HISTORICAL_FLAT_SCALE).toBe(1e-7);
    const ratio = HISTORICAL_FLAT_SCALE / mercatorZFromAltitude(1, 0);
    expect(ratio).toBeCloseTo(4.003, 3);
    expect(ratio).toBeGreaterThan(3.9);
    expect(ratio).toBeLessThan(4.1);
  });

  it('a 100 m building drawn with the fix is ~4× SHORTER — intentional', () => {
    const old = 100 * HISTORICAL_FLAT_SCALE;
    const fixed = mercatorZFromAltitude(100, 0);
    expect(fixed).toBeLessThan(old);
    expect(old / fixed).toBeCloseTo(4.003, 3);
  });

  it('the old flat factor was also latitude-blind: error shrinks poleward', () => {
    // 1e-7 happens to be closest to correct near 75.5°N (cos = 1/4.003) and is
    // never right anywhere else — that latitude-blindness is the second half of
    // the D10 defect.
    const ratioAt = (lat: number): number =>
      HISTORICAL_FLAT_SCALE / mercatorZFromAltitude(1, lat);
    expect(ratioAt(0)).toBeCloseTo(4.003, 3);
    expect(ratioAt(45)).toBeCloseTo(2.831, 3);
    expect(ratioAt(75.5)).toBeCloseTo(1, 2);
  });
});

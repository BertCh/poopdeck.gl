// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import {
  LocalEnuProjection,
  MercatorProjection,
  GlobeProjection,
  EARTH_RADIUS,
  projectPositions,
  worldUnitsPerPixel,
  zoomForWorldUnitsPerPixel,
} from '../src/geo';

const near = (a: number, b: number, eps = 1e-6) =>
  expect(Math.abs(a - b)).toBeLessThan(eps);

describe('LocalEnuProjection', () => {
  it('round-trips lon/lat/alt and is identity-ish at the anchor', () => {
    const p = new LocalEnuProjection({ longitude: -79.5, latitude: 43.6 });
    const [x, y, z] = p.project(-79.49, 43.61, 12);
    const [lon, lat, alt] = p.unproject(x, y, z);
    near(lon, -79.49);
    near(lat, 43.61);
    near(alt, 12);
    expect(p.metersPerWorldUnit()).toBe(1);
  });
});

describe('MercatorProjection', () => {
  it('round-trips and reports cos(lat) scale', () => {
    const p = new MercatorProjection();
    const [x, y, z] = p.project(10, 45, 100);
    const [lon, lat, alt] = p.unproject(x, y, z);
    near(lon, 10);
    near(lat, 45, 1e-4);
    near(alt, 100, 1e-3);
    near(p.metersPerWorldUnit(0, 45), Math.cos((45 * Math.PI) / 180));
  });
});

describe('GlobeProjection — sphere datum (v1 byte-identity)', () => {
  it('places (0,0) on +X at EARTH_RADIUS and reports metersPerWorldUnit 1', () => {
    const g = new GlobeProjection();
    const [x, y, z] = g.project(0, 0, 0);
    near(x, EARTH_RADIUS, 1e-3);
    near(y, 0);
    near(z, 0);
    expect(g.metersPerWorldUnit()).toBe(1);
  });
  it('reproduces the exact original sphere formula', () => {
    const g = new GlobeProjection({ longitude: 0, latitude: 0 });
    const lon = 12,
      lat = 40,
      alt = 500;
    const DEG2RAD = Math.PI / 180;
    const r = EARTH_RADIUS + alt;
    const cosLat = Math.cos(lat * DEG2RAD);
    const expected = [
      r * cosLat * Math.cos(lon * DEG2RAD),
      r * cosLat * Math.sin(lon * DEG2RAD),
      r * Math.sin(lat * DEG2RAD),
    ];
    const got = g.project(lon, lat, alt);
    near(got[0], expected[0], 1e-3);
    near(got[1], expected[1], 1e-3);
    near(got[2], expected[2], 1e-3);
  });
  it('round-trips lon/lat/alt', () => {
    const g = new GlobeProjection();
    const [x, y, z] = g.project(-122.4, 37.8, 250);
    const [lon, lat, alt] = g.unproject(x, y, z);
    near(lon, -122.4, 1e-6);
    near(lat, 37.8, 1e-6);
    near(alt, 250, 1e-3);
  });
});

describe('GlobeProjection — WGS84 ellipsoid datum', () => {
  it('round-trips lon/lat/alt via Bowring', () => {
    const g = new GlobeProjection({ longitude: 0, latitude: 0 }, EARTH_RADIUS, {
      datum: 'wgs84',
    });
    for (const [lon, lat, alt] of [
      [0, 0, 0],
      [-122.4, 37.8, 250],
      [10, 60, 1000],
      [140, -35, 0],
    ] as const) {
      const [x, y, z] = g.project(lon, lat, alt);
      const [rlon, rlat, ralt] = g.unproject(x, y, z);
      near(rlon, lon, 1e-6);
      near(rlat, lat, 1e-6);
      near(ralt, alt, 1e-3);
    }
  });
  it('differs from the sphere at mid-latitude (the ~20km registration point)', () => {
    const sphere = new GlobeProjection();
    const wgs84 = new GlobeProjection(
      { longitude: 0, latitude: 0 },
      EARTH_RADIUS,
      { datum: 'wgs84' },
    );
    const s = sphere.project(0, 45, 0);
    const w = wgs84.project(0, 45, 0);
    const d = Math.hypot(s[0] - w[0], s[1] - w[1], s[2] - w[2]);
    // WGS84 vs sphere at 45°N differ by ~10-20 km.
    expect(d).toBeGreaterThan(5_000);
  });
});

describe('GlobeProjection — parameterizable radius (globe.gl unit world)', () => {
  it('scales the world and reports metres-per-world-unit', () => {
    const g = new GlobeProjection({ longitude: 0, latitude: 0 }, 100);
    const [x] = g.project(0, 0, 0);
    near(x, 100, 1e-9);
    near(g.metersPerWorldUnit(), EARTH_RADIUS / 100);
    // altitude scales with the world too.
    const [x2] = g.project(0, 0, EARTH_RADIUS); // +1 earth-radius of altitude
    near(x2, 200, 1e-6);
  });
});

describe('projectPositions (RTC)', () => {
  it('writes f32 offsets relative to the chosen origin', () => {
    const p = new MercatorProjection();
    const positions = new Float64Array([10, 45, 10.01, 45.01]);
    const { positions: out, origin } = projectPositions(p, positions, 2, 2);
    // First point sits at the origin → offset ~0.
    near(out[0], 0);
    near(out[1], 0);
    expect(origin[0]).not.toBe(0);
  });
});

describe('view-state zoom helpers', () => {
  it('worldUnitsPerPixel round-trips through zoomForWorldUnitsPerPixel (mercator)', () => {
    const p = new MercatorProjection();
    const wupp = worldUnitsPerPixel(p, 12, 40);
    near(zoomForWorldUnitsPerPixel(p, wupp, 40), 12, 1e-9);
  });
  it('globe resolution shrinks with cos(lat)', () => {
    const g = new GlobeProjection();
    const eq = worldUnitsPerPixel(g, 10, 0);
    const hi = worldUnitsPerPixel(g, 10, 60);
    near(hi, eq * Math.cos((60 * Math.PI) / 180), 1);
  });
});

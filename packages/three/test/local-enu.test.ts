import { describe, it, expect } from 'vitest';
import {
  LocalEnuProjection,
  METERS_PER_DEG_LAT,
  projectPositionsToEnu,
} from '../src/projection/local-enu';

const DEG2RAD = Math.PI / 180;

/** The build-side projection from `av_common.local_to_lonlat` (Python), ported
 * verbatim so the test pins our inverse to the producer's forward map. */
function localToLonLat(
  xMeters: number,
  yMeters: number,
  originLon: number,
  originLat: number,
): [number, number] {
  const lat = originLat + yMeters / METERS_PER_DEG_LAT;
  const lon = originLon + xMeters / (METERS_PER_DEG_LAT * Math.cos(originLat * DEG2RAD));
  return [lon, lat];
}

describe('LocalEnuProjection', () => {
  const anchor = { longitude: -79.9333411419541, latitude: 40.45610620281625 };
  const proj = new LocalEnuProjection(anchor);

  it('maps the anchor to the world origin', () => {
    const [x, y, z] = proj.project(anchor.longitude, anchor.latitude, 0);
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBeCloseTo(0, 9);
    expect(z).toBe(0);
  });

  it('inverts av_common.local_to_lonlat exactly (metres -> lonlat -> metres)', () => {
    // Sweep a few metric offsets a scene might contain (±150 m around ego).
    for (const xm of [-150, -10, 0, 37.5, 150]) {
      for (const ym of [-150, -3.3, 0, 88, 150]) {
        const [lon, lat] = localToLonLat(xm, ym, anchor.longitude, anchor.latitude);
        const [x, y] = proj.project(lon, lat, 0);
        // Round-trips to sub-millimetre — the east scale is frozen at lat0 on
        // both sides, so the only error is f64 rounding.
        expect(x).toBeCloseTo(xm, 6);
        expect(y).toBeCloseTo(ym, 6);
      }
    }
  });

  it('round-trips project ∘ unproject', () => {
    const samples: Array<[number, number, number]> = [
      [-79.93, 40.456, 1.5],
      [-79.934, 40.4575, -2.0],
      [-79.9333411419541, 40.45610620281625, 12.25],
    ];
    for (const [lon, lat, alt] of samples) {
      const [x, y, z] = proj.project(lon, lat, alt);
      const [lon2, lat2, alt2] = proj.unproject(x, y, z);
      expect(lon2).toBeCloseTo(lon, 10);
      expect(lat2).toBeCloseTo(lat, 10);
      expect(alt2).toBeCloseTo(alt, 10);
    }
  });

  it('carries altitude straight through to world Z (metres)', () => {
    const [, , z] = proj.project(anchor.longitude, anchor.latitude, 7.5);
    expect(z).toBe(7.5);
  });

  it('keeps a Z-up frame: +lat -> +Y, +lon -> +X, +alt -> +Z', () => {
    const north = proj.project(anchor.longitude, anchor.latitude + 0.001, 0);
    const east = proj.project(anchor.longitude + 0.001, anchor.latitude, 0);
    expect(north[1]).toBeGreaterThan(0); // north -> +Y
    expect(Math.abs(north[0])).toBeLessThan(1e-6);
    expect(east[0]).toBeGreaterThan(0); // east -> +X
    expect(Math.abs(east[1])).toBeLessThan(1e-6);
  });
});

describe('projectPositionsToEnu', () => {
  const proj = new LocalEnuProjection({ longitude: -122.4, latitude: 37.77 });

  it('projects an interleaved 2D buffer with a separate elevation column', () => {
    // Two points: the anchor, and ~111.32 m north.
    const positions = new Float64Array([-122.4, 37.77, -122.4, 37.771]);
    const elevation = new Float32Array([3, 9]);
    const out = projectPositionsToEnu(proj, positions, 2, 2, elevation, 1);
    expect(out.length).toBe(6);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(0, 6);
    expect(out[2]).toBe(3); // z from elevation column
    expect(out[4]).toBeCloseTo(METERS_PER_DEG_LAT * 0.001, 3); // ~111.32 m north
    expect(out[5]).toBe(9);
  });

  it('reads z from a 3D interleaved buffer when no elevation column is given', () => {
    const positions = new Float64Array([-122.4, 37.77, 5.5]);
    const out = projectPositionsToEnu(proj, positions, 1, 3);
    expect(out[2]).toBe(5.5);
  });

  it('applies elevScale', () => {
    const positions = new Float64Array([-122.4, 37.77]);
    const elevation = new Float32Array([2]);
    const out = projectPositionsToEnu(proj, positions, 1, 2, elevation, 2.5);
    expect(out[2]).toBe(5);
  });
});

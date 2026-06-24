import { describe, it, expect } from 'vitest';
import { MercatorProjection, MAX_MERCATOR_LAT } from '../src/projection/mercator';
import { EARTH_RADIUS } from '../src/projection/local-enu';

const DEG2RAD = Math.PI / 180;

describe('MercatorProjection', () => {
  const proj = new MercatorProjection({ longitude: -73.9, latitude: 40.7 });

  it('maps the equator/prime-meridian origin to world (0,0,0)', () => {
    const [x, y, z] = proj.project(0, 0, 0);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(0, 6);
    expect(z).toBe(0);
  });

  it('scales longitude linearly by the earth radius', () => {
    const [x] = proj.project(1, 0, 0);
    expect(x).toBeCloseTo(EARTH_RADIUS * DEG2RAD, 3);
  });

  it('keeps a Z-up frame: +lat -> +Y, +lon -> +X', () => {
    const north = proj.project(0, 1, 0);
    const east = proj.project(1, 0, 0);
    expect(north[1]).toBeGreaterThan(0);
    expect(north[0]).toBeCloseTo(0, 6);
    expect(east[0]).toBeGreaterThan(0);
    expect(east[1]).toBeCloseTo(0, 6);
  });

  it('round-trips project ∘ unproject across latitudes and altitudes', () => {
    const samples: Array<[number, number, number]> = [
      [0, 0, 0],
      [-73.9857, 40.7484, 381], // Empire State
      [2.2945, 48.8584, 300], // Eiffel
      [151.2153, -33.8568, 0], // Sydney (south)
      [-122.4194, 37.7749, 52],
      [179.9, 84.0, 1000], // near the mercator clamp
    ];
    for (const [lon, lat, alt] of samples) {
      const [x, y, z] = proj.project(lon, lat, alt);
      const [lon2, lat2, alt2] = proj.unproject(x, y, z);
      expect(lon2).toBeCloseTo(lon, 6);
      expect(lat2).toBeCloseTo(lat, 6);
      expect(alt2).toBeCloseTo(alt, 3);
    }
  });

  it('reports metersPerWorldUnit = cos(lat)', () => {
    expect(proj.metersPerWorldUnit(0, 0)).toBeCloseTo(1, 9);
    expect(proj.metersPerWorldUnit(0, 60)).toBeCloseTo(0.5, 6);
  });

  it('scales altitude into local mercator units so vertical matches horizontal', () => {
    // At 60°N, 1 ground metre is 1/cos(60)=2 world units tall.
    const [, , z] = proj.project(0, 60, 10);
    expect(z).toBeCloseTo(20, 4);
  });

  it('clamps latitude at the mercator singularity instead of returning Infinity', () => {
    const [, y] = proj.project(0, 89.9999, 0);
    expect(Number.isFinite(y)).toBe(true);
    const [, yClamp] = proj.project(0, MAX_MERCATOR_LAT, 0);
    expect(y).toBeCloseTo(yClamp, 6);
  });

  it('exposes a constant planar Z-up local frame', () => {
    const f = proj.localFrame();
    expect(f.east).toEqual([1, 0, 0]);
    expect(f.north).toEqual([0, 1, 0]);
    expect(f.up).toEqual([0, 0, 1]);
  });
});

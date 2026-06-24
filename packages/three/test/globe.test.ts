import { describe, it, expect } from 'vitest';
import { GlobeProjection } from '../src/projection/globe';
import { EARTH_RADIUS } from '../src/projection/local-enu';

function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function len(a: [number, number, number]): number {
  return Math.hypot(a[0], a[1], a[2]);
}

describe('GlobeProjection', () => {
  const proj = new GlobeProjection({ longitude: 0, latitude: 0 });

  it('places the standard ECEF axis points', () => {
    const origin = proj.project(0, 0, 0);
    expect(origin[0]).toBeCloseTo(EARTH_RADIUS, 3);
    expect(origin[1]).toBeCloseTo(0, 6);
    expect(origin[2]).toBeCloseTo(0, 6);
    const east = proj.project(90, 0, 0);
    expect(east[0]).toBeCloseTo(0, 3);
    expect(east[1]).toBeCloseTo(EARTH_RADIUS, 3);
    const pole = proj.project(0, 90, 0);
    expect(pole[2]).toBeCloseTo(EARTH_RADIUS, 3);
  });

  it('adds altitude along the radial', () => {
    const p = proj.project(12, 34, 1000);
    expect(len(p)).toBeCloseTo(EARTH_RADIUS + 1000, 3);
  });

  it('round-trips project ∘ unproject', () => {
    const samples: Array<[number, number, number]> = [
      [0, 0, 0],
      [-73.98, 40.75, 381],
      [151.21, -33.86, 0],
      [2.29, 48.86, 300],
      [-122.42, 37.77, 52],
      [179.0, 66.5, 5000],
    ];
    for (const [lon, lat, alt] of samples) {
      const [x, y, z] = proj.project(lon, lat, alt);
      const [lon2, lat2, alt2] = proj.unproject(x, y, z);
      expect(lon2).toBeCloseTo(lon, 6);
      expect(lat2).toBeCloseTo(lat, 6);
      expect(alt2).toBeCloseTo(alt, 3);
    }
  });

  it('reports metersPerWorldUnit = 1 (ECEF metres)', () => {
    expect(proj.metersPerWorldUnit()).toBe(1);
  });

  it('builds an orthonormal ENU tangent frame with radial up', () => {
    for (const [lon, lat] of [
      [0, 0],
      [45, 30],
      [-120, -60],
      [170, 80],
    ] as Array<[number, number]>) {
      const { east, north, up } = proj.localFrame(lon, lat);
      // Unit length.
      expect(len(east)).toBeCloseTo(1, 9);
      expect(len(north)).toBeCloseTo(1, 9);
      expect(len(up)).toBeCloseTo(1, 9);
      // Orthogonal.
      expect(dot(east, north)).toBeCloseTo(0, 9);
      expect(dot(east, up)).toBeCloseTo(0, 9);
      expect(dot(north, up)).toBeCloseTo(0, 9);
      // Up is the surface radial (normalized projected position).
      const p = proj.project(lon, lat, 0);
      const r = len(p as [number, number, number]);
      expect(up[0]).toBeCloseTo(p[0] / r, 9);
      expect(up[1]).toBeCloseTo(p[1] / r, 9);
      expect(up[2]).toBeCloseTo(p[2] / r, 9);
      // Right-handed: east × north = up.
      const cross: [number, number, number] = [
        east[1] * north[2] - east[2] * north[1],
        east[2] * north[0] - east[0] * north[2],
        east[0] * north[1] - east[1] * north[0],
      ];
      expect(cross[0]).toBeCloseTo(up[0], 9);
      expect(cross[1]).toBeCloseTo(up[1], 9);
      expect(cross[2]).toBeCloseTo(up[2], 9);
    }
  });
});

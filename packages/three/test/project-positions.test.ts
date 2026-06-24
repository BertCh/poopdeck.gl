import { describe, it, expect } from 'vitest';
import {
  LocalEnuProjection,
  projectPositions,
  projectPositionsToEnu,
} from '../src/projection/local-enu';
import { MercatorProjection } from '../src/projection/mercator';

describe('projectPositions (RTC)', () => {
  it('with origin [0,0,0] reproduces projectPositionsToEnu exactly', () => {
    const proj = new LocalEnuProjection({ longitude: -122.4, latitude: 37.77 });
    const positions = new Float64Array([-122.4, 37.77, -122.399, 37.771, -122.401, 37.769]);
    const elevation = new Float32Array([3, 9, 1]);
    const absolute = projectPositionsToEnu(proj, positions, 3, 2, elevation, 1);
    const rtc = projectPositions(proj, positions, 3, 2, {
      elevation,
      origin: [0, 0, 0],
    });
    expect(rtc.origin).toEqual([0, 0, 0]);
    expect(Array.from(rtc.positions)).toEqual(Array.from(absolute));
  });

  it('defaults the origin to the first feature and stays reconstructable', () => {
    const proj = new MercatorProjection();
    // ~1 km of points near a high-magnitude mercator location (NYC).
    const lonlat: number[] = [];
    for (let i = 0; i < 8; i++) lonlat.push(-73.98 + i * 0.001, 40.75 + i * 0.0005);
    const positions = new Float64Array(lonlat);
    const { positions: rel, origin } = projectPositions(proj, positions, 8, 2);

    // Origin = first projected point.
    const first = proj.project(positions[0], positions[1], 0);
    expect(origin[0]).toBeCloseTo(first[0], 6);
    expect(origin[1]).toBeCloseTo(first[1], 6);

    // Offsets are tile-small (well within f32's exact integer range) even though
    // the absolute mercator coords are ~8e6.
    let maxAbs = 0;
    for (const v of rel) maxAbs = Math.max(maxAbs, Math.abs(v));
    expect(maxAbs).toBeLessThan(2000); // < ~1 km of offsets
    expect(Math.abs(origin[0])).toBeGreaterThan(1e6);

    // origin (f64) + offset (f32) reconstructs absolute to sub-millimetre.
    for (let i = 0; i < 8; i++) {
      const abs = proj.project(positions[i * 2], positions[i * 2 + 1], 0);
      expect(origin[0] + rel[i * 3]).toBeCloseTo(abs[0], 2);
      expect(origin[1] + rel[i * 3 + 1]).toBeCloseTo(abs[1], 2);
    }
  });

  it('handles an empty buffer', () => {
    const proj = new MercatorProjection();
    const { positions, origin } = projectPositions(proj, new Float64Array(0), 0, 2);
    expect(positions.length).toBe(0);
    expect(origin).toEqual([0, 0, 0]);
  });
});

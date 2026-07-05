import { describe, it, expect } from 'vitest';
import { Vector3, Matrix4 } from 'three';
import {
  geodeticToEcef,
  enuBasisEcef,
  computeWorldToEcef,
  resolveSunDate,
  resolveAtmosphereOptions,
} from '../src/scene/atmosphere';
import { EARTH_RADIUS } from '../src/projection/local-enu';
import { GlobeProjection } from '../src/projection/globe';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { MercatorProjection } from '../src/projection/mercator';

/**
 * Pure-logic tests for the atmosphere helper (the ECEF frame-alignment math, sun
 * date derivation, and option resolution). The live TSL/WebGPU pipeline — sky,
 * `AtmosphereLight`, environment IBL, and the `pass → aerialPerspective` post
 * composition — needs a GPU and is verified in-browser per vitest.config.ts.
 */

/** WGS84 semi-minor axis (b) — the ECEF Z of the north pole. */
const WGS84_B = EARTH_RADIUS * (1 - 1 / 298.257223563);

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

describe('geodeticToEcef — STT/takram ECEF axis convention', () => {
  it('places (lon 0°, lat 0°) on +X at the semi-major radius', () => {
    const p = geodeticToEcef(0, 0, 0);
    expect(near(p.x, EARTH_RADIUS, 1e-3)).toBe(true);
    expect(near(p.y, 0)).toBe(true);
    expect(near(p.z, 0)).toBe(true);
  });

  it('places (lon 90°E, lat 0°) on +Y', () => {
    const p = geodeticToEcef(90, 0, 0);
    expect(near(p.x, 0, 1e-3)).toBe(true);
    expect(near(p.y, EARTH_RADIUS, 1e-3)).toBe(true);
    expect(near(p.z, 0, 1e-3)).toBe(true);
  });

  it('places the north pole (lat 90°) on +Z at the semi-minor radius (WGS84)', () => {
    const p = geodeticToEcef(0, 90, 0);
    expect(near(p.x, 0, 1e-3)).toBe(true);
    expect(near(p.y, 0, 1e-3)).toBe(true);
    // WGS84 flattening → z is the polar radius b (< a), not EARTH_RADIUS.
    expect(near(p.z, WGS84_B, 1)).toBe(true);
  });

  it('adds height along the geodetic normal (lon/lat 0 → +X)', () => {
    const p = geodeticToEcef(0, 0, 1000);
    expect(near(p.x, EARTH_RADIUS + 1000, 1e-3)).toBe(true);
  });
});

describe('enuBasisEcef — geodetic East/North/Up unit basis in ECEF', () => {
  it('is right-handed, orthonormal, and matches the closed form at (0,0)', () => {
    const { east, north, up } = enuBasisEcef(0, 0);
    // At (lon 0°, lat 0°): east=+Y, north=+Z, up=+X.
    expect(east.distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-9);
    expect(north.distanceTo(new Vector3(0, 0, 1))).toBeLessThan(1e-9);
    expect(up.distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-9);
  });

  it('produces an orthonormal right-handed frame at an arbitrary anchor', () => {
    const { east, north, up } = enuBasisEcef(-73.9857, 40.7484); // NYC-ish
    // Unit length.
    for (const v of [east, north, up]) expect(near(v.length(), 1, 1e-9)).toBe(true);
    // Mutually orthogonal.
    expect(Math.abs(east.dot(north))).toBeLessThan(1e-9);
    expect(Math.abs(north.dot(up))).toBeLessThan(1e-9);
    expect(Math.abs(up.dot(east))).toBeLessThan(1e-9);
    // Right-handed: east × north == up.
    expect(east.clone().cross(north).distanceTo(up)).toBeLessThan(1e-9);
  });
});

describe('computeWorldToEcef — globe scene (world IS ECEF up to a uniform scale)', () => {
  it('is the identity at the default radius (no rotation, no scale, no offset)', () => {
    const m = computeWorldToEcef(new GlobeProjection({ longitude: 10, latitude: 20 }));
    expect(m.equals(new Matrix4())).toBe(true); // identity
  });

  it('is a pure uniform scale of metersPerWorldUnit() at a custom radius', () => {
    const proj = new GlobeProjection({ longitude: 0, latitude: 0 }, 100);
    const mpwu = proj.metersPerWorldUnit(0, 0);
    expect(near(mpwu, EARTH_RADIUS / 100, 1e-6)).toBe(true);
    const e = computeWorldToEcef(proj).elements;
    expect(near(e[0], mpwu)).toBe(true);
    expect(near(e[5], mpwu)).toBe(true);
    expect(near(e[10], mpwu)).toBe(true);
    expect(near(e[15], 1)).toBe(true);
    // No rotation/offset (off-diagonal + translation zero).
    expect(near(e[12], 0)).toBe(true);
    expect(near(e[13], 0)).toBe(true);
    expect(near(e[14], 0)).toBe(true);
    // world unit * mpwu = ECEF metres (round-trips the projection scale).
    const worldUnit = 100 / EARTH_RADIUS; // 1 ECEF metre expressed in world units
    expect(near(worldUnit * mpwu, 1, 1e-9)).toBe(true);
  });
});

describe('computeWorldToEcef — local ENU / mercator (ENU tangent frame at the anchor)', () => {
  const anchor = { longitude: -73.9857, latitude: 40.7484 };

  it('translates the world origin to the anchor ECEF and uses the E/N/U basis columns', () => {
    const m = computeWorldToEcef(new LocalEnuProjection(anchor));
    const originEcef = geodeticToEcef(anchor.longitude, anchor.latitude, 0);
    const { east, north, up } = enuBasisEcef(anchor.longitude, anchor.latitude);
    const e = m.elements;
    // Columns 0/1/2 are East/North/Up (STT world X=East, Y=North, Z=Up).
    expect(new Vector3(e[0], e[1], e[2]).distanceTo(east)).toBeLessThan(1e-9);
    expect(new Vector3(e[4], e[5], e[6]).distanceTo(north)).toBeLessThan(1e-9);
    expect(new Vector3(e[8], e[9], e[10]).distanceTo(up)).toBeLessThan(1e-9);
    // Column 3 is the anchor's ECEF position.
    expect(new Vector3(e[12], e[13], e[14]).distanceTo(originEcef)).toBeLessThan(1e-3);
  });

  it('maps the world origin exactly onto the anchor ECEF, and local +Z onto geodetic up', () => {
    const m = computeWorldToEcef(new LocalEnuProjection(anchor));
    const originEcef = geodeticToEcef(anchor.longitude, anchor.latitude, 0);
    // Origin.
    const o = new Vector3(0, 0, 0).applyMatrix4(m);
    expect(o.distanceTo(originEcef)).toBeLessThan(1e-3);
    // 1 m "up" in world → 1 m along the geodetic normal in ECEF.
    const up1 = new Vector3(0, 0, 1).applyMatrix4(m);
    const { up } = enuBasisEcef(anchor.longitude, anchor.latitude);
    expect(up1.sub(originEcef).distanceTo(up)).toBeLessThan(1e-6);
  });

  it('has an orthonormal rotation block (so transpose stays a valid inverse-rotation)', () => {
    const m = computeWorldToEcef(new LocalEnuProjection(anchor));
    // The upper-left 3×3 determinant is +1 for a right-handed orthonormal frame.
    expect(near(m.determinant(), 1, 1e-6)).toBe(true);
  });

  it('mercator uses the same ENU tangent frame as local ENU for the same anchor', () => {
    const merc = computeWorldToEcef(new MercatorProjection(anchor));
    const enu = computeWorldToEcef(new LocalEnuProjection(anchor));
    expect(merc.equals(enu)).toBe(true);
  });
});

describe('resolveSunDate — playhead → Date derivation', () => {
  it('returns a Date argument verbatim', () => {
    const d = new Date('2026-07-04T12:00:00Z');
    expect(resolveSunDate(d)).toBe(d);
  });

  it('maps a finite number through getDate when provided', () => {
    const getDate = (t: number): Date => new Date(t + 1000);
    const out = resolveSunDate(5000, getDate);
    expect(out.getTime()).toBe(6000);
  });

  it('treats a finite number as epoch-ms when no getDate is given', () => {
    const out = resolveSunDate(1_700_000_000_000);
    expect(out.getTime()).toBe(1_700_000_000_000);
  });

  it('falls back to "now" for undefined or non-finite input', () => {
    const before = Date.now();
    const a = resolveSunDate(undefined).getTime();
    const b = resolveSunDate(Number.NaN).getTime();
    const after = Date.now();
    expect(a).toBeGreaterThanOrEqual(before);
    expect(a).toBeLessThanOrEqual(after + 1);
    expect(b).toBeGreaterThanOrEqual(before);
  });
});

describe('resolveAtmosphereOptions — opt-in normalization', () => {
  it('disables on false / undefined', () => {
    expect(resolveAtmosphereOptions(false)).toBeNull();
    expect(resolveAtmosphereOptions(undefined)).toBeNull();
  });

  it('true → every sub-feature on, samples 0', () => {
    expect(resolveAtmosphereOptions(true)).toEqual({
      sky: true,
      environment: true,
      light: true,
      aerialPerspective: true,
      samples: 0,
      anchor: undefined,
      getDate: undefined,
    });
  });

  it('object overrides only the named fields and passes anchor/getDate through', () => {
    const getDate = (t: number): Date => new Date(t);
    const anchor = { longitude: 1, latitude: 2 };
    const r = resolveAtmosphereOptions({ sky: false, samples: 4, anchor, getDate });
    expect(r).not.toBeNull();
    expect(r!.sky).toBe(false);
    expect(r!.environment).toBe(true); // still defaulted on
    expect(r!.light).toBe(true);
    expect(r!.aerialPerspective).toBe(true);
    expect(r!.samples).toBe(4);
    expect(r!.anchor).toBe(anchor);
    expect(r!.getDate).toBe(getDate);
  });
});

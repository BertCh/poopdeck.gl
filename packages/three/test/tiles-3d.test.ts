import { describe, it, expect } from 'vitest';
import { Group, Matrix4, Vector3 } from 'three';
import {
  resolveTilesSource,
  resolveStt3DTilesOptions,
  ecefToWorldMatrix,
  alignTilesGroup,
} from '../src/scene/tiles-3d';
import { geodeticToEcef } from '../src/scene/atmosphere';
import { EARTH_RADIUS } from '../src/projection/local-enu';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { GlobeProjection } from '../src/projection/globe';

/**
 * Pure-logic tests for the 3D-tiles helper: source → plugin resolution, option
 * defaults, and — the make-or-break — the ECEF→world alignment that co-registers
 * WGS84-ellipsoid tile meshes with STT's globe world. Live tile fetching +
 * rendering needs network + a GPU + API tokens, so it is browser-verified.
 */

describe('resolveTilesSource — source → plugin/URL wiring', () => {
  it('passes a plain { url } through', () => {
    expect(resolveTilesSource({ url: 'https://x/tileset.json' })).toEqual({
      kind: 'url',
      url: 'https://x/tileset.json',
    });
  });

  it('resolves a { google } source (autoRefreshToken defaults on)', () => {
    expect(resolveTilesSource({ google: { apiToken: 'g' } })).toEqual({
      kind: 'google',
      apiToken: 'g',
      autoRefreshToken: true,
    });
    expect(resolveTilesSource({ google: { apiToken: 'g', autoRefreshToken: false } })).toEqual({
      kind: 'google',
      apiToken: 'g',
      autoRefreshToken: false,
    });
  });

  it('resolves an { ion } source (assetId kept as given, autoRefreshToken defaults on)', () => {
    expect(resolveTilesSource({ ion: { apiToken: 'i', assetId: 1 } })).toEqual({
      kind: 'ion',
      apiToken: 'i',
      assetId: 1,
      autoRefreshToken: true,
    });
    expect(resolveTilesSource({ ion: { apiToken: 'i', assetId: '96188' } })).toMatchObject({
      kind: 'ion',
      assetId: '96188',
    });
  });

  it('throws on missing tokens / assetId / empty source', () => {
    expect(() => resolveTilesSource({ google: { apiToken: '' } })).toThrow(/apiToken/);
    expect(() => resolveTilesSource({ ion: { apiToken: '', assetId: 1 } })).toThrow(/apiToken/);
    expect(() => resolveTilesSource({ ion: { apiToken: 'i', assetId: '' } })).toThrow(/assetId/);
    expect(() => resolveTilesSource({ url: '' })).toThrow(/url.*google.*ion|source/i);
  });
});

describe('resolveStt3DTilesOptions — defaults', () => {
  const src = { url: 'x' } as const;

  it('fills fade + compression on and errorTarget 16 (matches the library default)', () => {
    expect(resolveStt3DTilesOptions({ source: src })).toEqual({
      fade: true,
      compression: true,
      errorTarget: 16,
      maxDepth: undefined,
      anchor: undefined,
      dracoDecoderPath: undefined,
    });
  });

  it('honours explicit overrides (including turning features off)', () => {
    const anchor = { longitude: 1, latitude: 2 };
    expect(
      resolveStt3DTilesOptions({
        source: src,
        fade: false,
        compression: false,
        errorTarget: 4,
        maxDepth: 12,
        anchor,
        dracoDecoderPath: '/draco/',
      }),
    ).toEqual({
      fade: false,
      compression: false,
      errorTarget: 4,
      maxDepth: 12,
      anchor,
      dracoDecoderPath: '/draco/',
    });
  });
});

describe('ecefToWorldMatrix — globe scenes (uniform scale, INVERSE of world→ECEF)', () => {
  it('is the identity for a default-radius wgs84 globe (tiles already in STT world)', () => {
    const m = ecefToWorldMatrix(
      new GlobeProjection({ longitude: 10, latitude: 20 }, EARTH_RADIUS, { datum: 'wgs84' }),
    );
    expect(m.equals(new Matrix4())).toBe(true);
  });

  it('is a pure uniform scale radius/EARTH_RADIUS at a custom radius', () => {
    const R = 100;
    const m = ecefToWorldMatrix(new GlobeProjection({ longitude: 0, latitude: 0 }, R));
    const e = m.elements;
    expect(e[0]).toBeCloseTo(R / EARTH_RADIUS, 15);
    expect(e[5]).toBeCloseTo(R / EARTH_RADIUS, 15);
    expect(e[10]).toBeCloseTo(R / EARTH_RADIUS, 15);
    // No rotation / no translation.
    expect(e[1]).toBe(0);
    expect(e[12]).toBe(0);
    expect(e[13]).toBe(0);
    expect(e[14]).toBe(0);
  });
});

describe('alignTilesGroup — co-registers ECEF-metre tiles with STT globe world', () => {
  it('leaves the group untransformed for a default-radius globe', () => {
    const group = new Group();
    alignTilesGroup(group, new GlobeProjection({ longitude: 0, latitude: 0 }, EARTH_RADIUS, { datum: 'wgs84' }));
    expect(group.position.length()).toBe(0);
    expect(group.scale.x).toBeCloseTo(1, 15);
    expect(group.quaternion.equals(group.quaternion.clone().identity())).toBe(true);
  });

  it('maps a WGS84-ECEF tile vertex onto the exact GlobeProjection world position', () => {
    // A tile vertex is authored in WGS84 ECEF metres; after the group transform it
    // must land where GlobeProjection('wgs84') puts that lon/lat/height.
    const globe = new GlobeProjection({ longitude: 0, latitude: 0 }, EARTH_RADIUS, { datum: 'wgs84' });
    const group = new Group();
    alignTilesGroup(group, globe);
    const lon = -73.9857;
    const lat = 40.7484;
    const h = 123.4;
    const ecef = geodeticToEcef(lon, lat, h); // tile space
    const world = ecef.clone().applyMatrix4(group.matrixWorld);
    const [wx, wy, wz] = globe.project(lon, lat, h); // STT globe world
    expect(world.distanceTo(new Vector3(wx, wy, wz))).toBeLessThan(1e-6);
  });

  it('scales ECEF tiles onto a non-default globe radius', () => {
    const R = 100;
    const globe = new GlobeProjection({ longitude: 0, latitude: 0 }, R, { datum: 'wgs84' });
    const group = new Group();
    alignTilesGroup(group, globe);
    expect(group.scale.x).toBeCloseTo(R / EARTH_RADIUS, 15);
    const ecef = geodeticToEcef(10, 20, 0);
    const world = ecef.clone().applyMatrix4(group.matrixWorld);
    const [wx, wy, wz] = globe.project(10, 20, 0);
    expect(world.distanceTo(new Vector3(wx, wy, wz))).toBeLessThan(1e-3);
  });

  it('places ECEF tiles into a local-ENU world (anchor → origin, geodetic up → +Z)', () => {
    const anchor = { longitude: -73.9857, latitude: 40.7484 };
    const group = new Group();
    alignTilesGroup(group, new LocalEnuProjection(anchor));
    // The anchor's ECEF lands at the local world origin.
    const anchorEcef = geodeticToEcef(anchor.longitude, anchor.latitude, 0);
    expect(anchorEcef.clone().applyMatrix4(group.matrixWorld).length()).toBeLessThan(1e-3);
    // 100 m up the geodetic normal in ECEF → local +Z (0, 0, 100).
    const up = geodeticToEcef(anchor.longitude, anchor.latitude, 100);
    expect(up.clone().applyMatrix4(group.matrixWorld).distanceTo(new Vector3(0, 0, 100))).toBeLessThan(1e-3);
  });
});

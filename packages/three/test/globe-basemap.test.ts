import { describe, it, expect } from 'vitest';
import { Vector3, type Mesh } from 'three';
import { makeGlobeBasemap, GLOBE_BASEMAP_INSET } from '../src/scene/globe-basemap';
import { GlobeProjection } from '../src/projection/globe';
import { EARTH_RADIUS } from '../src/projection/local-enu';

const globe = new GlobeProjection();

describe('makeGlobeBasemap', () => {
  it('builds a sphere of the globe radius, inset under the surface', () => {
    const mesh = makeGlobeBasemap(globe) as Mesh;
    mesh.geometry.computeBoundingSphere();
    const r = mesh.geometry.boundingSphere!.radius;
    // Inset so surface data (at exactly EARTH_RADIUS) doesn't z-fight.
    expect(r).toBeCloseTo(EARTH_RADIUS * GLOBE_BASEMAP_INSET, 0);
    expect(r).toBeLessThan(EARTH_RADIUS);
  });

  it('honours a custom inset', () => {
    const mesh = makeGlobeBasemap(globe, { inset: 0.5 }) as Mesh;
    mesh.geometry.computeBoundingSphere();
    expect(mesh.geometry.boundingSphere!.radius).toBeCloseTo(EARTH_RADIUS * 0.5, 0);
  });

  it('orients texture poles to the ECEF +Z axis (lat 90 → +Z)', () => {
    const mesh = makeGlobeBasemap(globe) as Mesh;
    mesh.updateMatrixWorld(true);
    // SphereGeometry's north texture pole is the topmost +Y vertex. After the
    // mesh rotation it must land on +Z (the ECEF north pole), matching where
    // GlobeProjection.project places lat 90.
    const geomPole = topVertex(mesh);
    const worldPole = geomPole.clone().applyMatrix4(mesh.matrixWorld);
    const inset = EARTH_RADIUS * GLOBE_BASEMAP_INSET;
    expect(worldPole.z).toBeCloseTo(inset, 0);
    expect(Math.abs(worldPole.x)).toBeLessThan(inset * 1e-3);
    expect(Math.abs(worldPole.y)).toBeLessThan(inset * 1e-3);

    // And it agrees with the projection's north pole direction (+Z).
    const projPole = globe.project(0, 90, 0);
    expect(projPole[2]).toBeGreaterThan(0);
    expect(worldPole.z).toBeGreaterThan(0);
  });

  it('is a named, frustum-uncullable mesh', () => {
    const mesh = makeGlobeBasemap(globe) as Mesh;
    expect(mesh.name).toBe('stt-globe-basemap');
    expect(mesh.frustumCulled).toBe(false);
  });
});

/** Local-space vertex with the greatest +Y (the sphere's north texture pole). */
function topVertex(mesh: Mesh): Vector3 {
  const pos = mesh.geometry.getAttribute('position');
  let best = -Infinity;
  const out = new Vector3();
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    if (v.y > best) {
      best = v.y;
      out.copy(v);
    }
  }
  return out;
}

import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import {
  viewStateToCamera,
  cameraToViewState,
  type ViewState,
} from '../src/projection/view-state';
import { MercatorProjection } from '../src/projection/mercator';
import { GlobeProjection } from '../src/projection/globe';

function makeCamera(): PerspectiveCamera {
  // fov + aspect fixed so the scale math is deterministic.
  return new PerspectiveCamera(50, 1.6, 0.1, 1e9);
}

const VH = 800;

const CASES: ViewState[] = [
  { longitude: -73.98, latitude: 40.75, zoom: 12, pitch: 0, bearing: 0 },
  { longitude: 2.29, latitude: 48.86, zoom: 9, pitch: 45, bearing: 30 },
  { longitude: 139.69, latitude: 35.69, zoom: 14, pitch: 60, bearing: 200 },
  { longitude: -122.42, latitude: 37.77, zoom: 4, pitch: 30, bearing: 315 },
  { longitude: 0, latitude: 0, zoom: 2, pitch: 20, bearing: 90 },
];

describe('view-state ⇄ camera (mercator)', () => {
  const proj = new MercatorProjection();

  it('round-trips view state through the camera', () => {
    for (const vs of CASES) {
      const cam = makeCamera();
      viewStateToCamera(proj, vs, cam, { viewportHeight: VH });
      const back = cameraToViewState(proj, cam, { viewportHeight: VH });
      expect(back.longitude).toBeCloseTo(vs.longitude, 5);
      expect(back.latitude).toBeCloseTo(vs.latitude, 5);
      expect(back.zoom).toBeCloseTo(vs.zoom, 4);
      expect(back.pitch).toBeCloseTo(vs.pitch ?? 0, 4);
      expect(back.bearing).toBeCloseTo(vs.bearing ?? 0, 4);
    }
  });

  it('returns the look target at the projected view centre on the ground plane', () => {
    const cam = makeCamera();
    const target = viewStateToCamera(
      proj,
      { longitude: 10, latitude: 20, zoom: 8 },
      cam,
      { viewportHeight: VH },
    );
    const [tx, ty] = proj.project(10, 20, 0);
    expect(target.x).toBeCloseTo(tx, 3);
    expect(target.y).toBeCloseTo(ty, 3);
    expect(target.z).toBeCloseTo(0, 3);
    // Camera is up-and-back from the target (top-down here → straight above).
    expect(cam.position.z).toBeGreaterThan(0);
  });

  it('higher zoom puts the camera closer to the ground', () => {
    const near = makeCamera();
    const far = makeCamera();
    viewStateToCamera(proj, { longitude: 0, latitude: 0, zoom: 14 }, near, { viewportHeight: VH });
    viewStateToCamera(proj, { longitude: 0, latitude: 0, zoom: 4 }, far, { viewportHeight: VH });
    expect(near.position.z).toBeLessThan(far.position.z);
  });
});

describe('view-state ⇄ camera (globe)', () => {
  const proj = new GlobeProjection();

  it('round-trips view state through the camera', () => {
    for (const vs of CASES) {
      const cam = makeCamera();
      viewStateToCamera(proj, vs, cam, { viewportHeight: VH });
      const back = cameraToViewState(proj, cam, { viewportHeight: VH });
      expect(back.longitude).toBeCloseTo(vs.longitude, 4);
      expect(back.latitude).toBeCloseTo(vs.latitude, 4);
      expect(back.zoom).toBeCloseTo(vs.zoom, 3);
      expect(back.pitch).toBeCloseTo(vs.pitch ?? 0, 3);
      expect(back.bearing).toBeCloseTo(vs.bearing ?? 0, 3);
    }
  });

  it('sets a radial camera up (no global Z-up on the globe)', () => {
    const cam = makeCamera();
    viewStateToCamera(proj, { longitude: 45, latitude: 45, zoom: 6 }, cam, { viewportHeight: VH });
    const radial = new Vector3(...proj.project(45, 45, 0)).normalize();
    // up should be perpendicular to the radial (a tangent vector), not equal to Z.
    expect(Math.abs(cam.up.dot(radial))).toBeLessThan(1e-6);
  });

  it('places the camera above the surface point looking at it', () => {
    const cam = makeCamera();
    const target = viewStateToCamera(
      proj,
      { longitude: -30, latitude: 10, zoom: 5 },
      cam,
      { viewportHeight: VH },
    );
    // target sits on the sphere; camera sits outside it.
    expect(target.length()).toBeCloseTo(6378137, 0);
    expect(cam.position.length()).toBeGreaterThan(target.length());
  });
});

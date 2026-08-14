import { describe, it, expect } from 'vitest';
import { PerspectiveCamera } from 'three';
import {
  isGlobeProjection,
  rigModeFor,
  resolveCanvasProjection,
  globeControlLimits,
  groundControlLimits,
  MAX_GROUND_PITCH_DEG,
  MIN_MERCATOR_ZOOM,
  MAX_MERCATOR_ZOOM,
} from '../src/scene/projection-rig';
import { cameraToViewState } from '../src/projection/view-state';
import { LocalEnuProjection, EARTH_RADIUS } from '../src/projection/local-enu';
import { MercatorProjection } from '../src/projection/mercator';
import { GlobeProjection } from '../src/projection/globe';

const ANCHOR = { longitude: -73.98, latitude: 40.75 };

describe('resolveCanvasProjection (STTCanvas projection prop)', () => {
  it('defaults to a LocalEnuProjection anchored at `anchor` when omitted', () => {
    const proj = resolveCanvasProjection(undefined, ANCHOR);
    expect(proj).toBeInstanceOf(LocalEnuProjection);
    expect(proj.kind).toBe('local-enu');
    // The anchor maps to the world origin (the backward-compatible ENU frame).
    expect(proj.project(ANCHOR.longitude, ANCHOR.latitude, 0)).toEqual([
      0, 0, 0,
    ]);
    expect(proj.anchor).toEqual(ANCHOR);
  });

  it('returns the caller-supplied projection instance unchanged (identity)', () => {
    const merc = new MercatorProjection(ANCHOR);
    expect(resolveCanvasProjection(merc, ANCHOR)).toBe(merc);
    const globe = new GlobeProjection(ANCHOR);
    expect(resolveCanvasProjection(globe, ANCHOR)).toBe(globe);
    // A caller ENU with a DIFFERENT anchor than the framing hint still wins.
    const enu = new LocalEnuProjection({ longitude: 0, latitude: 0 });
    expect(resolveCanvasProjection(enu, ANCHOR)).toBe(enu);
  });
});

describe('isGlobeProjection', () => {
  it('is true only for a GlobeProjection', () => {
    expect(isGlobeProjection(new GlobeProjection(ANCHOR))).toBe(true);
    expect(isGlobeProjection(new MercatorProjection(ANCHOR))).toBe(false);
    expect(isGlobeProjection(new LocalEnuProjection(ANCHOR))).toBe(false);
  });
});

describe('rigModeFor (CameraRig / controls branch selection)', () => {
  it('selects the globe rig for GlobeProjection and the flat rig for planar ones', () => {
    expect(rigModeFor(new GlobeProjection(ANCHOR))).toBe('globe');
    expect(rigModeFor(new MercatorProjection(ANCHOR))).toBe('flat');
    expect(rigModeFor(new LocalEnuProjection(ANCHOR))).toBe('flat');
  });
});

describe('globeControlLimits (OrbitControls distance clamp)', () => {
  it('brackets the surface for the default (metric) earth radius', () => {
    const { minDistance, maxDistance } = globeControlLimits(
      new GlobeProjection(ANCHOR),
    );
    // Just above the surface out to a comfortable whole-earth zoom-out.
    expect(minDistance).toBeGreaterThan(EARTH_RADIUS);
    expect(minDistance).toBeLessThan(maxDistance);
    expect(maxDistance).toBeGreaterThan(EARTH_RADIUS * 2);
  });

  it('scales with a custom globe radius (e.g. a unit-sphere world)', () => {
    const { minDistance, maxDistance } = globeControlLimits(
      new GlobeProjection(ANCHOR, 100),
    );
    expect(minDistance).toBeCloseTo(102, 6);
    expect(maxDistance).toBeCloseTo(800, 6);
  });
});

describe('groundControlLimits (flat-rig polar clamp)', () => {
  it('stops the camera 5° short of the ground plane', () => {
    // `MapControls` defaults `maxPolarAngle` to π — a right-drag can swing the
    // camera THROUGH the ground and out the other side, where every ray points
    // at sky and tile selection has no surface to select against.
    const { maxPolarAngle } = groundControlLimits();
    expect(maxPolarAngle).toBeCloseTo((85 * Math.PI) / 180, 12);
    expect(maxPolarAngle).toBeLessThan(Math.PI / 2);
    expect(MAX_GROUND_PITCH_DEG).toBe(85);
  });
});

describe('groundControlLimits (flat-rig dolly clamp)', () => {
  const merc = new MercatorProjection(ANCHOR);
  const VIEWPORT_H = 800;
  const FOV = 50;
  const limits = (
    extra: { minZoom?: number; maxZoom?: number } = {},
  ): ReturnType<typeof groundControlLimits> =>
    groundControlLimits({
      projection: merc,
      viewportHeight: VIEWPORT_H,
      fovDeg: FOV,
      ...extra,
    });

  it('clamps the dolly to the mercator zoom range, near ↔ high zoom', () => {
    const { minDistance, maxDistance } = limits();
    expect(minDistance).toBeGreaterThan(0);
    // Zooming IN moves the camera closer, so the zoom CEILING is the distance FLOOR.
    expect(minDistance!).toBeLessThan(maxDistance!);
    expect(MIN_MERCATOR_ZOOM).toBe(0);
    expect(MAX_MERCATOR_ZOOM).toBe(20);
  });

  it('is the exact inverse of the zoom the basemap is driven with', () => {
    // The whole point of the clamp: a camera parked at `maxDistance` must read
    // back as EXACTLY `minZoom` through `cameraToViewState` — the same function
    // `BasemapOverlay.sync` pushes to the host map's `jumpTo`. If these two ever
    // disagreed, the camera could sit at a zoom the basemap refuses to follow.
    const { minDistance, maxDistance } = limits();
    const cam = new PerspectiveCamera(FOV, 1.6, 0.1, 1e9);
    for (const [distance, zoom] of [
      [maxDistance!, MIN_MERCATOR_ZOOM],
      [minDistance!, MAX_MERCATOR_ZOOM],
    ] as const) {
      // Top-down at the anchor, `distance` above the ground plane.
      const [tx, ty] = merc.project(ANCHOR.longitude, ANCHOR.latitude, 0);
      cam.up.set(0, 1, 0);
      cam.position.set(tx, ty, distance);
      cam.lookAt(tx, ty, 0);
      cam.updateMatrixWorld();
      const view = cameraToViewState(merc, cam, { viewportHeight: VIEWPORT_H });
      expect(view.zoom).toBeCloseTo(zoom, 9);
    }
  });

  it('honours an explicit zoom range (and tolerates an inverted one)', () => {
    const tight = limits({ minZoom: 8, maxZoom: 14 });
    const wide = limits();
    // A tighter range sits strictly inside the default clamp on both ends.
    expect(tight.maxDistance!).toBeLessThan(wide.maxDistance!);
    expect(tight.minDistance!).toBeGreaterThan(wide.minDistance!);
    // Swapped bounds describe the same range — never an inverted clamp, which
    // `OrbitControls` would resolve by pinning the camera at one distance.
    const swapped = limits({ minZoom: 14, maxZoom: 8 });
    expect(swapped.minDistance).toBeCloseTo(tight.minDistance!, 9);
    expect(swapped.maxDistance).toBeCloseTo(tight.maxDistance!, 9);
  });

  it('leaves non-mercator scenes and incomplete inputs unclamped', () => {
    // A metric ENU/AV scene has no slippy-map zoom to clamp against — it is framed
    // by `frameBox` inside its own distance clamp — and a globe scene uses
    // `globeControlLimits`. Nor can a clamp be derived without a viewport/FOV.
    for (const opts of [
      {
        projection: new LocalEnuProjection(ANCHOR),
        viewportHeight: VIEWPORT_H,
        fovDeg: FOV,
      },
      {
        projection: new GlobeProjection(ANCHOR),
        viewportHeight: VIEWPORT_H,
        fovDeg: FOV,
      },
      { projection: merc, viewportHeight: 0, fovDeg: FOV },
      { projection: merc, viewportHeight: VIEWPORT_H, fovDeg: 0 },
      // A canvas that has not been laid out / a camera with no FOV yet.
      { projection: merc, viewportHeight: VIEWPORT_H },
      {},
    ]) {
      const l = groundControlLimits(opts);
      expect(l.minDistance).toBeUndefined();
      expect(l.maxDistance).toBeUndefined();
      expect(l.maxPolarAngle).toBeCloseTo((85 * Math.PI) / 180, 12);
    }
  });
});

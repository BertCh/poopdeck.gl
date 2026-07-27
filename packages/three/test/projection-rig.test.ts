import { describe, it, expect } from 'vitest';
import {
  isGlobeProjection,
  rigModeFor,
  resolveCanvasProjection,
  globeControlLimits,
  groundControlLimits,
  MAX_GROUND_PITCH_DEG,
} from '../src/scene/projection-rig';
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

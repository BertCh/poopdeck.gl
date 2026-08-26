// @poopdeck.gl/three
// SPDX-License-Identifier: MIT

/**
 * `cameraRoll` conformance for the three backend.
 *
 * `ViewState.roll` has always existed in `@poopdeck.gl/core/geo` — its doc says a
 * backend whose camera lacks the DOF "ignores it — a lossy round-trip to be
 * documented, not silently dropped". A Three `PerspectiveCamera` DOES have the
 * DOF (it is `camera.up` spun about the view axis), so this backend now carries
 * roll through instead of dropping it, and these cases are what
 * `capabilities.cameraRoll: true` is claiming.
 */

import { describe, it, expect } from 'vitest';
import { PerspectiveCamera } from 'three';
import { MercatorProjection } from '../src/projection/mercator';
import { GlobeProjection } from '../src/projection/globe';
import {
  viewStateToCamera,
  cameraToViewState,
} from '../src/projection/view-state';
import type { ViewState } from '@poopdeck.gl/core/geo';

const VIEWPORT = { viewportHeight: 800 };

function cam(): PerspectiveCamera {
  return new PerspectiveCamera(50, 1200 / 800, 0.1, 1e9);
}

const MERCATOR = new MercatorProjection();

describe('roll round-trips through the camera bridge', () => {
  const base: ViewState = {
    longitude: -73.57,
    latitude: 45.5,
    zoom: 12,
    pitch: 45,
    bearing: 30,
  };

  for (const roll of [-75, -30, -1, 1, 15, 45, 89]) {
    it(`recovers roll ${roll}° unchanged`, () => {
      const c = cam();
      viewStateToCamera(MERCATOR, { ...base, roll }, c, VIEWPORT);
      const out = cameraToViewState(MERCATOR, c, VIEWPORT);
      expect(out.roll).toBeCloseTo(roll, 6);
    });
  }

  it('leaves longitude/latitude/zoom/pitch/bearing untouched by a roll', () => {
    const c0 = cam();
    viewStateToCamera(MERCATOR, base, c0, VIEWPORT);
    const unrolled = cameraToViewState(MERCATOR, c0, VIEWPORT);

    const c1 = cam();
    viewStateToCamera(MERCATOR, { ...base, roll: 37 }, c1, VIEWPORT);
    const rolled = cameraToViewState(MERCATOR, c1, VIEWPORT);

    expect(rolled.longitude).toBeCloseTo(unrolled.longitude, 9);
    expect(rolled.latitude).toBeCloseTo(unrolled.latitude, 9);
    expect(rolled.zoom).toBeCloseTo(unrolled.zoom, 9);
    expect(rolled.pitch).toBeCloseTo(unrolled.pitch, 9);
    expect(rolled.bearing).toBeCloseTo(unrolled.bearing, 9);
  });

  it('keeps the camera pointing at the same target — a roll spins the horizon only', () => {
    const c0 = cam();
    const t0 = viewStateToCamera(MERCATOR, base, c0, VIEWPORT);
    const p0 = c0.position.clone();

    const c1 = cam();
    const t1 = viewStateToCamera(MERCATOR, { ...base, roll: 60 }, c1, VIEWPORT);

    expect(t1.distanceTo(t0)).toBeLessThan(1e-6);
    expect(c1.position.distanceTo(p0)).toBeLessThan(1e-6);
    // ...but the up vector genuinely moved.
    expect(c1.up.angleTo(c0.up)).toBeGreaterThan(0.5);
  });

  it('an absent roll is exactly the pre-campaign unrolled camera', () => {
    const withOut = cam();
    viewStateToCamera(MERCATOR, base, withOut, VIEWPORT);
    const withZero = cam();
    viewStateToCamera(MERCATOR, { ...base, roll: 0 }, withZero, VIEWPORT);

    expect(withZero.position.distanceTo(withOut.position)).toBe(0);
    expect(withZero.up.distanceTo(withOut.up)).toBe(0);
    expect(cameraToViewState(MERCATOR, withOut, VIEWPORT).roll).toBe(0);
  });

  it('round-trips on the globe frame too', () => {
    const globe = new GlobeProjection({ longitude: 0, latitude: 0 });
    const vs: ViewState = {
      longitude: 12.4,
      latitude: 41.9,
      zoom: 5,
      pitch: 55,
      bearing: 200,
      roll: -22,
    };
    const c = cam();
    viewStateToCamera(globe, vs, c, VIEWPORT);
    const out = cameraToViewState(globe, c, VIEWPORT);
    expect(out.roll).toBeCloseTo(-22, 5);
    expect(out.bearing).toBeCloseTo(200, 4);
    expect(out.pitch).toBeCloseTo(55, 4);
  });
});

describe('the pitch=0 degeneracy is resolved toward bearing', () => {
  it('reports roll 0 and folds the spin into bearing when looking straight down', () => {
    const c = cam();
    viewStateToCamera(
      MERCATOR,
      { longitude: 0, latitude: 0, zoom: 10, pitch: 0, bearing: 0, roll: 40 },
      c,
      VIEWPORT,
    );
    const out = cameraToViewState(MERCATOR, c, VIEWPORT);
    expect(out.roll).toBe(0);
    expect(out.pitch).toBeCloseTo(0, 6);
    // The 40° spin is indistinguishable from a bearing change at pitch 0, and is
    // reported as one rather than being silently discarded.
    expect(out.bearing).toBeCloseTo(40, 4);
  });
});

// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { viewStateToCesiumView, cesiumViewToViewState } from '../src/camera';
import type { ViewState } from '@poopdeck.gl/core/geo';

const near = (a: number, b: number, eps = 1e-6) =>
  expect(Math.abs(a - b)).toBeLessThan(eps);

/**
 * WHERE THE PLACEMENT ORACLE LIVES: `test/camera-apply.test.ts`, against a real
 * `@cesium/engine` `Camera`.
 *
 * This file is deliberately Cesium-free pure maths, and it must NOT try to prove
 * the "lon/lat is the look-at TARGET, not the camera position" contract on its
 * own. Two attempts to do that here were both self-referential and both could
 * not fail:
 *
 * - The `ViewState → Cesium → ViewState` round trip below converts with
 *   `viewStateToCesiumView` and back with `cesiumViewToViewState`. Both
 *   directions pass lon/lat through untouched, so both shared the RC6 mistake
 *   and the trip closed to 1e-6 while the shipped camera was being parked ON the
 *   data. It is kept because it IS the right test for zoom/pitch/bearing/roll —
 *   just not for the framing.
 * - A pair of local `lookAtCameraEnu`/`groundHitEnu` helpers, removed here.
 *   `lookAtCameraEnu` returned `-range · dir` for precisely the `dir`
 *   `groundHitEnu` rebuilt from the same heading/pitch, so the ground solve was
 *   `-range·dir + range·dir` — identically zero for every input. Handed a range
 *   1000× too small, or a positive pitch (a camera under the ground), it still
 *   reported the target dead centre to 1e-12 m.
 *
 * What CAN be pinned here without a second copy of the implementation is the
 * arithmetic, against literals worked out by hand — see `HAND_DERIVED` below.
 */

/**
 * Camera geometry for three fixed views, computed BY HAND from first principles
 * and written down, not re-derived at test time.
 *
 * Ground resolution at the view centre on the WGS84 globe:
 *
 *     wupp = 2π·R·cos(lat) / (512 · 2^zoom),   R = 6 378 137 m
 *
 * and the distance at which one CSS pixel subtends that much ground, for a
 * viewport `H` px tall with vertical field of view `fovy`:
 *
 *     range = wupp · H / (2 · tan(fovy/2))
 *
 * `range` is the SLANT distance along the view axis, so it does not depend on
 * pitch; the altitude above the target is `height = range · cos(pitch)`.
 *
 * Worked for `lat 43.6, zoom 12, H = 800, fovy = 60°` (`tan 30° = 0.5773502692`):
 *
 *     2π·6378137                    = 40 075 016.685578488
 *     cos 43.6°                     =        0.72396952...
 *     512 · 2^12                    =    2 097 152
 *     wupp = 40075016.6856 · 0.72396952 / 2097152
 *                                   =       13.838386264006109 m/px
 *     range = 13.838386264 · 800 / (2 · 0.5773502692)
 *                                   =     9587.5152416087367 m
 *     height(pitch 55°) = 9587.51524 · cos 55° (0.5735764364)
 *                                   =     5499.1728257432778 m
 *     height(pitch 30°) = 9587.51524 · cos 30° (0.8660254038)
 *                                   =     8303.0317584036675 m
 *
 * and for `lat 0, zoom 4` (cos 0 = 1, 512 · 16 = 8192):
 *
 *     wupp  = 40075016.6856 / 8192  =     4891.9698102512803 m/px
 *     range = 4891.96981 · 800 / (2 · 0.5773502692)
 *                                   =  3 389 256.1041793195 m
 */
const HAND_DERIVED = {
  torontoZ12: {
    range: 9587.5152416087367,
    heightAtPitch55: 5499.1728257432778,
    heightAtPitch30: 8303.0317584036675,
  },
  equatorZ4: { range: 3389256.1041793195 },
} as const;

describe('ViewState ⇄ Cesium camera bridge (pure math)', () => {
  it('round-trips longitude/latitude/zoom/pitch/bearing/roll', () => {
    const v: ViewState = {
      longitude: -79.5,
      latitude: 43.6,
      zoom: 12,
      pitch: 30,
      bearing: 45,
      roll: 10,
    };
    const back = cesiumViewToViewState(viewStateToCesiumView(v));
    near(back.longitude, v.longitude);
    near(back.latitude, v.latitude);
    near(back.zoom, v.zoom, 1e-4);
    near(back.pitch, v.pitch, 1e-4);
    near(back.bearing, v.bearing, 1e-4);
    near(back.roll, v.roll, 1e-4);
  });

  it('maps STT top-down (pitch 0) to Cesium straight-down (-90°)', () => {
    const view = viewStateToCesiumView({
      longitude: 0,
      latitude: 0,
      zoom: 4,
      pitch: 0,
    });
    near(view.pitchRad, (-90 * Math.PI) / 180);
  });

  it('carries roll through (Cesium 3-DOF camera)', () => {
    const view = viewStateToCesiumView({
      longitude: 0,
      latitude: 0,
      zoom: 4,
      roll: 25,
    });
    near(view.rollRad, (25 * Math.PI) / 180);
  });

  it('higher zoom → lower camera height', () => {
    const lo = viewStateToCesiumView({
      longitude: 0,
      latitude: 0,
      zoom: 3,
    }).height;
    const hi = viewStateToCesiumView({
      longitude: 0,
      latitude: 0,
      zoom: 13,
    }).height;
    expect(hi).toBeLessThan(lo);
  });

  it('honors an explicit altitude override', () => {
    const view = viewStateToCesiumView({
      longitude: 0,
      latitude: 0,
      zoom: 5,
      altitude: 12345,
    });
    expect(view.height).toBe(12345);
  });
});

describe('camera distances match hand-computed literals', () => {
  // Pinned to the constants in HAND_DERIVED, not to a second evaluation of the
  // formula: a sign flip, a dropped cos(lat), a 256-vs-512 tile size or a
  // half-angle mistake changes these numbers and nothing in the test moves with
  // it. Tolerance is 1e-6 m on distances of 9.6 km and 3389 km — pure float
  // noise, because the assertion is arithmetic, not physics.
  it('slant range at Toronto z12, 800 px, 60° fovy', () => {
    const view = viewStateToCesiumView({
      longitude: -79.5,
      latitude: 43.6,
      zoom: 12,
    });
    near(view.range, HAND_DERIVED.torontoZ12.range, 1e-6);
  });

  it('slant range is pitch-independent, altitude is range · cos(pitch)', () => {
    const at = (pitch: number) =>
      viewStateToCesiumView({
        longitude: -79.5,
        latitude: 43.6,
        zoom: 12,
        pitch,
      });
    near(at(55).range, HAND_DERIVED.torontoZ12.range, 1e-6);
    near(at(30).range, HAND_DERIVED.torontoZ12.range, 1e-6);
    near(at(55).height, HAND_DERIVED.torontoZ12.heightAtPitch55, 1e-6);
    near(at(30).height, HAND_DERIVED.torontoZ12.heightAtPitch30, 1e-6);
  });

  it('the cos(lat) ground-resolution factor is really applied', () => {
    // Same zoom, equator — the range must be LARGER by 1/cos(43.6°) ≈ 1.3813.
    // Dropping cos(lat) (the mercator convention) would make these equal.
    const equator = viewStateToCesiumView({
      longitude: 0,
      latitude: 0,
      zoom: 4,
    });
    near(equator.range, HAND_DERIVED.equatorZ4.range, 1e-6);
  });

  it('the read-back inverts the literals (zoom, not just a matching formula)', () => {
    // Feed the hand-computed range straight back in: the recovered zoom must be
    // the 12 it was derived from. This is the pair of directions that RC6 broke
    // in lockstep, so anchoring ONE end to a literal is what makes the round
    // trip below meaningful at all.
    const back = cesiumViewToViewState({
      longitude: -79.5,
      latitude: 43.6,
      range: HAND_DERIVED.torontoZ12.range,
      headingRad: 0,
      pitchRad: -Math.PI / 2,
    });
    near(back.zoom, 12, 1e-9);
  });
});

describe('range vs height (the 1/cos(pitch) the bridge used to drop)', () => {
  const at = (pitch: number) =>
    viewStateToCesiumView({
      longitude: -79.5,
      latitude: 43.6,
      zoom: 12,
      pitch,
    });

  it('range is the slant distance — the same for every pitch at one zoom', () => {
    // deck's view matrix translates by -altitude and only THEN rotates by pitch,
    // so the distance from the camera to the view centre is pitch-independent.
    // Matching that is what keeps a deck↔cesium toggle on one tile zoom.
    near(at(60).range, at(0).range, 1e-6);
  });

  it('height is the true altitude above the target, not the slant distance', () => {
    const flat = at(0);
    near(flat.height, flat.range, 1e-6);
    near(at(60).height, flat.range * Math.cos((60 * Math.PI) / 180), 1e-6);
    near(at(45).height, flat.range * Math.cos((45 * Math.PI) / 180), 1e-6);
  });
});

describe('reading a live camera back (altitude → zoom)', () => {
  const sample = (pitchDeg: number) =>
    cesiumViewToViewState({
      longitude: -79.5,
      latitude: 43.6,
      height: 20_000, // positionCartographic.height — an ALTITUDE
      headingRad: 0,
      pitchRad: ((pitchDeg - 90) * Math.PI) / 180,
      rollRad: 0,
    });

  it('treats the sampled height as an altitude, so tilt costs zoom levels', () => {
    // At tilt 60 the ground under the screen centre is 2× as far as the ground
    // under the camera, which is exactly one zoom level coarser. Reading the
    // altitude as if it were the slant range reports the nadir zoom at every
    // tilt — the mirror of the forward bug, and worth ~1 level at the demo pitches.
    near(sample(0).zoom - sample(60).zoom, 1, 1e-9);
    near(sample(0).zoom - sample(45).zoom, Math.log2(Math.SQRT2), 1e-9);
  });

  it('moves the selection zoom DOWN with tilt, by log2(cos tilt)', () => {
    // The SIGN, pinned, because the review that landed the correction stated it
    // backwards and a browser verifier told to expect more detail would sign off
    // on the regression. Tilting must always select COARSER, never finer. The
    // literals are the table quoted in `camera.ts`; if that table is ever edited
    // to say something else, this goes red.
    for (const [tilt, delta] of [
      [30, -0.20752],
      [45, -0.5],
      [55, -0.80194],
      [60, -1.0],
      [62, -1.09089],
      [75, -1.94998],
    ] as const) {
      const shift = sample(tilt).zoom - sample(0).zoom;
      expect(shift).toBeLessThan(0);
      near(shift, delta, 1e-4);
    }
  });

  it('clamps the tilt correction near the horizon instead of diverging', () => {
    // cos(tilt) → 0 as the centre ray approaches the horizon; unclamped, the
    // derived zoom runs to -Infinity and reaches selection as NaN.
    expect(Number.isFinite(sample(90).zoom)).toBe(true);
    near(sample(90).zoom, sample(85).zoom, 1e-9);
  });

  it('prefers an explicit range over the altitude when both are present', () => {
    const withRange = cesiumViewToViewState({
      longitude: 0,
      latitude: 0,
      range: 40_000,
      height: 20_000,
      headingRad: 0,
      pitchRad: -Math.PI / 3,
    });
    const rangeOnly = cesiumViewToViewState({
      longitude: 0,
      latitude: 0,
      range: 40_000,
      headingRad: 0,
      pitchRad: -Math.PI / 3,
    });
    near(withRange.zoom, rangeOnly.zoom, 1e-12);
  });
});

describe('viewport height and fov feed the zoom scale', () => {
  it('a taller canvas frames the same zoom from further away', () => {
    const short = viewStateToCesiumView(
      { longitude: 0, latitude: 0, zoom: 10 },
      { viewportHeight: 800 },
    );
    const tall = viewStateToCesiumView(
      { longitude: 0, latitude: 0, zoom: 10 },
      { viewportHeight: 1200 },
    );
    near(tall.range / short.range, 1.5, 1e-9);
  });

  it('a narrower vertical fov reads the same altitude as a finer zoom', () => {
    const wide = cesiumViewToViewState(
      {
        longitude: 0,
        latitude: 0,
        range: 20_000,
        headingRad: 0,
        pitchRad: -Math.PI / 2,
      },
      { fovRadians: (60 * Math.PI) / 180 },
    );
    const narrow = cesiumViewToViewState(
      {
        longitude: 0,
        latitude: 0,
        range: 20_000,
        headingRad: 0,
        pitchRad: -Math.PI / 2,
      },
      { fovRadians: (36 * Math.PI) / 180 },
    );
    expect(narrow.zoom).toBeGreaterThan(wide.zoom);
  });
});

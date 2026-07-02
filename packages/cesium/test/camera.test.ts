// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { viewStateToCesiumView, cesiumViewToViewState } from '../src/camera';
import type { ViewState } from '@poopdeck.gl/core/geo';

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('ViewState ⇄ Cesium camera bridge (pure math)', () => {
  it('round-trips longitude/latitude/zoom/pitch/bearing/roll', () => {
    const v: ViewState = { longitude: -79.5, latitude: 43.6, zoom: 12, pitch: 30, bearing: 45, roll: 10 };
    const back = cesiumViewToViewState(viewStateToCesiumView(v));
    near(back.longitude, v.longitude);
    near(back.latitude, v.latitude);
    near(back.zoom, v.zoom, 1e-4);
    near(back.pitch, v.pitch, 1e-4);
    near(back.bearing, v.bearing, 1e-4);
    near(back.roll, v.roll, 1e-4);
  });

  it('maps STT top-down (pitch 0) to Cesium straight-down (-90°)', () => {
    const view = viewStateToCesiumView({ longitude: 0, latitude: 0, zoom: 4, pitch: 0 });
    near(view.pitchRad, (-90 * Math.PI) / 180);
  });

  it('carries roll through (Cesium 3-DOF camera)', () => {
    const view = viewStateToCesiumView({ longitude: 0, latitude: 0, zoom: 4, roll: 25 });
    near(view.rollRad, (25 * Math.PI) / 180);
  });

  it('higher zoom → lower camera height', () => {
    const lo = viewStateToCesiumView({ longitude: 0, latitude: 0, zoom: 3 }).height;
    const hi = viewStateToCesiumView({ longitude: 0, latitude: 0, zoom: 13 }).height;
    expect(hi).toBeLessThan(lo);
  });

  it('honors an explicit altitude override', () => {
    const view = viewStateToCesiumView({ longitude: 0, latitude: 0, zoom: 5, altitude: 12345 });
    expect(view.height).toBe(12345);
  });
});

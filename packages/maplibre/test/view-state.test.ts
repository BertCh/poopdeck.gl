// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * `cameraRoll` conformance for the maplibre backend, plus the ViewState seam it
 * rides on. The point of these cases is the DEGRADATION: this package must run
 * against maplibre-gl v3 through v6 from one build, and only v5+ has roll, so
 * "honest about what it dropped" is the actual contract — not "roll always
 * works".
 */

import { describe, it, expect, vi } from 'vitest';
import {
  applyViewState,
  readViewState,
  supportsRoll,
  type ViewStateHost,
} from '../src/lib/view-state';

interface FakeHostOptions {
  /** Model a ≤v4 host: no getRoll/setRoll at all. */
  roll?: false | { initial?: number; honoursJumpToOption?: boolean };
}

function fakeHost(opts: FakeHostOptions = {}) {
  const state = {
    lng: -73.57,
    lat: 45.5,
    zoom: 12,
    pitch: 40,
    bearing: 25,
    roll: typeof opts.roll === 'object' ? (opts.roll.initial ?? 0) : 0,
  };
  const jumpTo = vi.fn((o: Record<string, unknown>) => {
    if (Array.isArray(o.center)) {
      state.lng = (o.center as number[])[0];
      state.lat = (o.center as number[])[1];
    }
    if (typeof o.zoom === 'number') state.zoom = o.zoom;
    if (typeof o.pitch === 'number') state.pitch = o.pitch;
    if (typeof o.bearing === 'number') state.bearing = o.bearing;
    const honours =
      typeof opts.roll === 'object'
        ? opts.roll.honoursJumpToOption !== false
        : false;
    if (honours && typeof o.roll === 'number') state.roll = o.roll;
  });
  const setRoll = vi.fn((r: number) => {
    state.roll = r;
  });

  const host: ViewStateHost = {
    getCenter: () => ({ lng: state.lng, lat: state.lat }),
    getZoom: () => state.zoom,
    getPitch: () => state.pitch,
    getBearing: () => state.bearing,
    jumpTo,
    ...(opts.roll === false ? {} : { getRoll: () => state.roll, setRoll }),
  };
  return { host, state, jumpTo, setRoll };
}

describe('supportsRoll detects the host structurally', () => {
  it('is true when both accessors exist (v5+)', () => {
    expect(supportsRoll(fakeHost().host)).toBe(true);
  });

  it('is false on a host with neither (v3/v4)', () => {
    expect(supportsRoll(fakeHost({ roll: false }).host)).toBe(false);
  });

  it('is false on a host with only the getter — a half-implemented surface is not support', () => {
    const { host } = fakeHost();
    const partial = { ...host, setRoll: undefined } as unknown as ViewStateHost;
    expect(supportsRoll(partial)).toBe(false);
  });
});

describe('readViewState', () => {
  it('reports roll when the host has the DOF', () => {
    const { host } = fakeHost({ roll: { initial: 17 } });
    expect(readViewState(host).roll).toBe(17);
  });

  it('OMITS roll on a host without it, rather than reporting a fabricated 0', () => {
    const { host } = fakeHost({ roll: false });
    const v = readViewState(host);
    expect('roll' in v).toBe(false);
    // The distinction that matters: "no roll DOF" is not "level".
    expect(v.roll).toBeUndefined();
  });

  it('reads the rest of the camera in the shared vocabulary', () => {
    const v = readViewState(fakeHost().host);
    expect(v).toMatchObject({
      longitude: -73.57,
      latitude: 45.5,
      zoom: 12,
      pitch: 40,
      bearing: 25,
    });
  });
});

describe('applyViewState', () => {
  const view = {
    longitude: 2.35,
    latitude: 48.86,
    zoom: 14,
    pitch: 55,
    bearing: 120,
    roll: 30,
  };

  it('round-trips a rolled camera on a v5+ host', () => {
    const { host } = fakeHost({ roll: { initial: 0 } });
    const res = applyViewState(host, view);
    expect(res.dropped).toEqual([]);
    expect(readViewState(host)).toMatchObject(view);
  });

  it('falls back to setRoll when the host ignores the jumpTo option', () => {
    const { host, setRoll } = fakeHost({
      roll: { initial: 0, honoursJumpToOption: false },
    });
    const res = applyViewState(host, view);
    expect(setRoll).toHaveBeenCalledWith(30);
    expect(host.getRoll!()).toBe(30);
    expect(res.dropped).toEqual([]);
  });

  it('does not call setRoll when jumpTo already honoured the roll', () => {
    const { host, setRoll } = fakeHost({ roll: { initial: 0 } });
    applyViewState(host, view);
    expect(setRoll).not.toHaveBeenCalled();
  });

  it('reports a dropped roll on a <=v4 host instead of pretending', () => {
    const { host } = fakeHost({ roll: false });
    const res = applyViewState(host, view);
    expect(res.dropped).toEqual(['roll']);
    // Everything it COULD apply still landed.
    expect(readViewState(host)).toMatchObject({
      longitude: 2.35,
      latitude: 48.86,
      zoom: 14,
      pitch: 55,
      bearing: 120,
    });
  });

  it('does not cry wolf: a requested roll of 0 on a <=v4 host drops nothing', () => {
    const { host } = fakeHost({ roll: false });
    expect(applyViewState(host, { ...view, roll: 0 }).dropped).toEqual([]);
    expect(applyViewState(host, { ...view, roll: undefined }).dropped).toEqual(
      [],
    );
  });

  it('uses jumpTo, never an animated ease — an apply must not disagree with the ViewState mid-flight', () => {
    const { host, jumpTo } = fakeHost();
    const eased = host as unknown as Record<string, unknown>;
    eased.easeTo = vi.fn();
    eased.flyTo = vi.fn();
    applyViewState(host, view);
    expect(jumpTo).toHaveBeenCalledTimes(1);
    expect(eased.easeTo).not.toHaveBeenCalled();
    expect(eased.flyTo).not.toHaveBeenCalled();
  });

  it('defaults an absent pitch/bearing to 0 rather than leaving the host where it was', () => {
    const { host } = fakeHost();
    applyViewState(host, { longitude: 0, latitude: 0, zoom: 3 });
    expect(readViewState(host)).toMatchObject({ pitch: 0, bearing: 0 });
  });
});

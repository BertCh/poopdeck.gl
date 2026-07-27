// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

/**
 * Motion modes at the antimeridian — the seam where a longitude lerp is not
 * just imprecise but qualitatively wrong.
 *
 * A track whose two bracketing keyframes straddle 180° (179.9 → −179.9, two
 * tenths of a degree apart on the ground) lerps through 179.8, 179.7, … 0 …
 * −179.8: the entity sweeps 359.8° THE WRONG WAY around the planet inside one
 * bracket. At 60 Hz that is a ~6°-per-frame streak across the whole map.
 *
 * That behaviour is SHIPPED. `'linear'` therefore keeps it — flipping the seam
 * handling silently under every existing deck layer is not something a
 * motion-mode change gets to do — and this suite pins it EXPLICITLY, so the day
 * someone decides to change the default they have to edit an assertion that
 * says, in words, that it is broken. The two new modes start correct.
 *
 * Latitude is checked on every path too: a sphere has no latitude outside
 * [-90, 90], and a pose that leaves it renders somewhere that does not exist.
 */

import { describe, it, expect } from 'vitest';
import { sampleTrack } from '../src/render/track-kernel';
import type { Track, TrackSampleConfig } from '../src/render/track-kernel';
import type { MotionConfig, MotionMode } from '../src/render/motion';
import { MOTION_MODES } from '../src/render/motion';
import { haversineMeters, shortestLonDeltaDeg } from '../src/geo/spherical';

const BASE: TrackSampleConfig = {
  defaultLength: 4,
  defaultWidth: 2,
  defaultHeight: 1.6,
  fadeInDuration: 0,
  fadeOutDuration: 0,
};

/** Two keyframes 1 s apart at a constant latitude, straddling the seam. */
function seamTrack(lonA: number, lonB: number, lat = 35): Track {
  return {
    trackId: 'S',
    times: [0, 1000],
    lon: [lonA, lonB],
    lat: [lat, lat],
    alt: [0, 0],
    heading: [NaN, NaN],
    length: [NaN, NaN],
    width: [NaN, NaN],
    height: [NaN, NaN],
    speed: [NaN, NaN],
    color: [1, 2, 3, 4],
    label: '',
    category: '',
    singleton: false,
  };
}

/** Sample the whole bracket at 60 Hz and return the successive positions. */
function sweep(t: Track, motion: MotionConfig): { lon: number; lat: number }[] {
  const out: { lon: number; lat: number }[] = [];
  for (let now = 0; now <= 1000; now += 1000 / 60) {
    const s = sampleTrack(t, Math.min(now, 1000), { ...BASE, motion })!;
    expect(s, `sample at ${now}`).not.toBeNull();
    out.push({ lon: s.lon, lat: s.lat });
  }
  return out;
}

describe('motion at the antimeridian', () => {
  const CASES: { name: string; a: number; b: number }[] = [
    { name: 'eastbound 179.9 → −179.9', a: 179.9, b: -179.9 },
    { name: 'westbound −179.9 → 179.9', a: -179.9, b: 179.9 },
  ];

  for (const mode of ['velocity', 'great-circle'] as const) {
    for (const c of CASES) {
      it(`'${mode}' crosses the seam the SHORT way (${c.name})`, () => {
        const t = seamTrack(c.a, c.b);
        const path = sweep(t, { mode });
        const total = haversineMeters(c.a, 35, c.b, 35);
        // ~0.2° of longitude at 35°N — a small number, and the point is that
        // the shipped lerp covers 1800× more than this.
        expect(total).toBeLessThan(20_000);

        const budget = (total / (path.length - 1)) * 1.05;
        for (let i = 1; i < path.length; i++) {
          const step = haversineMeters(
            path[i - 1].lon,
            path[i - 1].lat,
            path[i].lon,
            path[i].lat,
          );
          expect(
            step,
            `${mode} ${c.name}: step ${i} moved ${step} m (budget ${budget})`,
          ).toBeLessThanOrEqual(budget);
        }
        // Endpoints are still the endpoints.
        expect(Math.abs(shortestLonDeltaDeg(path[0].lon, c.a))).toBeLessThan(
          1e-9,
        );
        expect(
          Math.abs(shortestLonDeltaDeg(path[path.length - 1].lon, c.b)),
        ).toBeLessThan(1e-9);
      });
    }
  }

  it("KNOWN BROKEN, DELIBERATELY PINNED: 'linear' sweeps 359.8° the wrong way", () => {
    // This is the shipped behaviour of every deck/three/maplibre/Cesium layer
    // that samples a seam-crossing bracket today. It is wrong. It is also what
    // is on the screen, so `'linear'` reproduces it byte for byte and this
    // assertion is the tripwire: changing the default MUST require editing it.
    const t = seamTrack(179.9, -179.9);
    const path = sweep(t, { mode: 'linear' });
    const mid = path[Math.floor(path.length / 2)];
    // Halfway through a two-tenths-of-a-degree hop, the entity is on the far
    // side of the planet, near the prime meridian.
    expect(Math.abs(mid.lon)).toBeLessThan(10);

    let travelled = 0;
    for (let i = 1; i < path.length; i++) {
      travelled += haversineMeters(
        path[i - 1].lon,
        path[i - 1].lat,
        path[i].lon,
        path[i].lat,
      );
    }
    const trueDistance = haversineMeters(179.9, 35, -179.9, 35);
    expect(travelled / trueDistance).toBeGreaterThan(1000);

    // Opting in fixes it without touching the default.
    const fixed = sweep(t, { mode: 'linear', wrapLongitude: true });
    const fixedMid = fixed[Math.floor(fixed.length / 2)];
    expect(Math.abs(Math.abs(fixedMid.lon) - 180)).toBeLessThan(0.01);
  });

  it("'velocity' extrapolation crosses the seam without unwrapping", () => {
    const t: Track = {
      ...seamTrack(179.8, 179.95),
      speed: [200, 200],
      heading: [90, 90], // compass degrees: due east
    };
    const s = sampleTrack(t, 46_000, {
      ...BASE,
      motion: {
        mode: 'velocity',
        maxExtrapolationMs: 60_000,
        courseUnit: 'deg',
        courseConvention: 'compass',
      },
    })!;
    // 45 s at 200 m/s ≈ 9 km east of 179.95 — at 35°N that is ~0.10° of
    // longitude, so the prediction lands over the seam and out the other side,
    // expressed in-world as a negative longitude, never as 180.05.
    expect(s.lon).toBeLessThan(0);
    expect(s.lon).toBeGreaterThan(-180);
    expect(Math.abs(shortestLonDeltaDeg(179.95, s.lon))).toBeGreaterThan(0);
    expect(Math.abs(shortestLonDeltaDeg(179.95, s.lon))).toBeLessThan(1);
  });

  it('keeps latitude inside [-90, 90] on every mode and every path', () => {
    // Near-polar keyframes plus a prediction that walks straight at the pole:
    // the forward geodesic must come down the far side rather than run past 90.
    const polar: Track = {
      trackId: 'P',
      times: [0, 10_000],
      lon: [0, 0],
      lat: [88, 89],
      alt: [0, 0],
      heading: [0, 0],
      length: [NaN, NaN],
      width: [NaN, NaN],
      height: [NaN, NaN],
      speed: [400, 400],
      color: [1, 2, 3, 4],
      label: '',
      category: '',
      singleton: false,
    };
    for (const mode of MOTION_MODES as readonly MotionMode[]) {
      for (let now = 0; now <= 20_000; now += 250) {
        const s = sampleTrack(polar, now, {
          ...BASE,
          motion: {
            mode,
            maxExtrapolationMs: 10_000,
            courseUnit: 'deg',
            courseConvention: 'compass',
          },
        });
        if (!s) continue;
        expect(s.lat, `${mode} @ ${now}`).toBeGreaterThanOrEqual(-90);
        expect(s.lat, `${mode} @ ${now}`).toBeLessThanOrEqual(90);
        expect(Number.isFinite(s.lat), `${mode} @ ${now}`).toBe(true);
        expect(Number.isFinite(s.lon), `${mode} @ ${now}`).toBe(true);
      }
    }
  });
});

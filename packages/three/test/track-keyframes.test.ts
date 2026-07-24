// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// Pure (Three-free) tests for the motion-glide keyframe assembly: fixed-rate
// resample, the `maxInterpolationGap` hold, per-instance locator attributes, and
// the CPU mirror of the shader's two-column fetch + mix (`glideSampleCpu`). No
// GPU reliance — this is the truth check that keeps the vertex-stage glide math
// honest (the repo's PURE-core + CPU-scalar-mirror convention).

import { describe, it, expect } from 'vitest';
import type { Track } from '@poopdeck.gl/core';
import { SINGLETON_HOLD_MS } from '@poopdeck.gl/core';
import {
  assembleKeyframes,
  resampleTrack,
  glideSampleCpu,
} from '../src/lib/track-keyframes';
import { LocalEnuProjection } from '../src/projection/local-enu';

// Anchor at (0,0): project(lon,lat) = [lon·111320·cos(0), lat·111320, 0] and the
// assembled origin is the first track's first keyframe, so with a track that
// STARTS at (0,0) the RTC-local positions equal the projected metres.
const proj = new LocalEnuProjection({ longitude: 0, latitude: 0 });
const M = 111320; // metres per degree at the equator

/** Build a Track with sensible NaN defaults for the unused kernel columns. */
function makeTrack(p: {
  trackId?: string;
  times: number[];
  lon: number[];
  lat?: number[];
  alt?: number[];
  heading?: number[];
  color?: [number, number, number, number];
}): Track {
  const n = p.times.length;
  const nan = () => new Array(n).fill(NaN);
  return {
    trackId: p.trackId ?? 't',
    times: p.times,
    lon: p.lon,
    lat: p.lat ?? new Array(n).fill(0),
    alt: p.alt ?? new Array(n).fill(0),
    heading: p.heading ?? nan(),
    length: nan(),
    width: nan(),
    height: nan(),
    speed: nan(),
    color: p.color ?? [255, 128, 0, 255],
    label: '',
    category: '',
    singleton: n < 2,
  };
}

describe('resampleTrack — fixed-rate grid', () => {
  it('resamples a straight 2-keyframe track onto a uniform grid (lossless)', () => {
    const t = makeTrack({ times: [0, 1000], lon: [0, 0.001] });
    const rs = resampleTrack(t, { resampleIntervalMs: 250 });
    expect(rs.frameCount).toBe(5); // floor(1000/250)+1
    expect(rs.dt).toBe(250);
    // Linear along one segment → exact reproduction at each grid point.
    expect(rs.lon[0]).toBeCloseTo(0, 12);
    expect(rs.lon[2]).toBeCloseTo(0.0005, 12);
    expect(rs.lon[4]).toBeCloseTo(0.001, 12);
  });

  it('never undersamples a dense short track below its real sample count', () => {
    // span (1000) < interval (5000) would give 2 frames, but n=4 samples force ≥4.
    const t = makeTrack({
      times: [0, 300, 600, 1000],
      lon: [0, 0.001, 0.002, 0.003],
    });
    const rs = resampleTrack(t, { resampleIntervalMs: 5000 });
    expect(rs.frameCount).toBe(4);
  });

  it('caps frame count at maxFrames (coarsens dt to fit)', () => {
    const t = makeTrack({ times: [0, 100000], lon: [0, 0.1] });
    const rs = resampleTrack(t, { resampleIntervalMs: 1, maxFrames: 64 });
    expect(rs.frameCount).toBe(64);
    expect(rs.dt).toBeCloseTo(100000 / 63, 6);
  });

  it('HOLDS across a gap wider than maxInterpolationGap, interpolates elsewhere', () => {
    // Bracket [0,5000] is a 5000ms gap (> 2000 cap) → held at A; bracket
    // [5000,6000] is normal → interpolates.
    const t = makeTrack({
      times: [0, 5000, 6000],
      lon: [0, 0.005, 0.006],
    });
    const rs = resampleTrack(t, { resampleIntervalMs: 1000, maxGapMs: 2000 });
    // grid: 0,1000,...,6000. Frames 1..4 fall inside the wide bracket → held at A.
    expect(rs.lon[1]).toBeCloseTo(0, 12);
    expect(rs.lon[4]).toBeCloseTo(0, 12);
    // Frame 5 (t=5000) is B; frame 6 (t=6000) is C — the normal bracket.
    expect(rs.lon[5]).toBeCloseTo(0.005, 12);
    expect(rs.lon[6]).toBeCloseTo(0.006, 12);
  });

  it('resamples heading shortest-arc across the 360/0 seam (icon path)', () => {
    // 350° → 10° must go the SHORT way (through 360°), never the naive 180°.
    const t = makeTrack({
      times: [0, 1000],
      lon: [0, 0.001],
      heading: [350, 10],
    });
    const rs = resampleTrack(t, {
      resampleIntervalMs: 250,
      withHeading: true,
      angleUnit: 'deg',
    });
    const midRad = rs.heading[2]; // t=500 → shortest-arc midpoint = 360° = 2π
    // cos(360°)=1 (shortest arc) vs cos(180°)=-1 (the naive-lerp bug).
    expect(Math.cos(midRad)).toBeCloseTo(1, 5);
  });

  it('holds a single-keyframe (singleton) track at its lone position', () => {
    const t = makeTrack({ times: [500], lon: [0.002] });
    const rs = resampleTrack(t, {});
    expect(rs.frameCount).toBe(1);
    expect(rs.dt).toBe(0);
    expect(rs.lon[0]).toBeCloseTo(0.002, 12);
  });
});

describe('assembleKeyframes — texture + per-instance attributes', () => {
  it('packs one row per track and emits the row locators', () => {
    const a = makeTrack({ trackId: 'A', times: [0, 1000], lon: [0, 0.001] });
    const b = makeTrack({
      trackId: 'B',
      times: [0, 500, 1000],
      lon: [0.002, 0.002, 0.002],
      lat: [0, 0.0005, 0.001],
      color: [10, 20, 30, 255],
    });
    const field = assembleKeyframes([a, b], proj, 0, {
      resampleIntervalMs: 500,
    });

    expect(field.count).toBe(2);
    expect(field.texHeight).toBe(2);
    // texWidth = widest resampled row (both span 1000ms at 500ms → 3 frames).
    expect(field.texWidth).toBe(3);
    expect(field.origin).toEqual([0, 0, 0]); // first track starts at anchor

    // Row v centres.
    expect(field.rowV[0]).toBeCloseTo(0.25, 6);
    expect(field.rowV[1]).toBeCloseTo(0.75, 6);
    // t0 / span for a normal 2-frame+ track (no singleton pad).
    expect(field.t0[0]).toBe(0);
    expect(field.starts[0]).toBe(0);
    expect(field.ends[0]).toBe(1000);
    expect(field.invDt[0]).toBeCloseTo(1 / 500, 9);
    expect(field.frameMax[0]).toBe(field.texWidth - 1);
    // Baked colour (0..1) from track B.
    expect(field.colors[4]).toBeCloseTo(10 / 255, 6);
    expect(field.colors[5]).toBeCloseTo(20 / 255, 6);
    expect(field.colors[7]).toBeCloseTo(1, 6);

    // bbox spans both tracks' RTC-local extents.
    expect(field.bbox!.max[0]).toBeCloseTo(0.002 * M, 3);
  });

  it('pads singleton start/end by SINGLETON_HOLD_MS/2 for visibility', () => {
    const s = makeTrack({ trackId: 'S', times: [1000], lon: [0] });
    const field = assembleKeyframes([s], proj, 0, {});
    expect(field.count).toBe(1);
    expect(field.starts[0]).toBeCloseTo(1000 - SINGLETON_HOLD_MS / 2, 6);
    expect(field.ends[0]).toBeCloseTo(1000 + SINGLETON_HOLD_MS / 2, 6);
    expect(field.invDt[0]).toBe(0); // held → framePos pins to column 0
  });

  it('returns an empty field for no tracks', () => {
    const field = assembleKeyframes([], proj, 0, {});
    expect(field.count).toBe(0);
    expect(field.texData.length).toBe(0);
    expect(field.bbox).toBeNull();
  });

  it('rebases keyframe times to timeOrigin (f32-relative)', () => {
    const a = makeTrack({
      trackId: 'A',
      times: [10_000, 11_000],
      lon: [0, 0.001],
    });
    const field = assembleKeyframes([a], proj, 10_000, {});
    expect(field.t0[0]).toBe(0); // 10_000 − 10_000
    expect(field.ends[0]).toBe(1000); // 11_000 − 10_000
  });
});

describe('glideSampleCpu — mirror of the vertex-stage fetch', () => {
  const a = makeTrack({ trackId: 'A', times: [0, 1000], lon: [0, 0.001] });
  const field = assembleKeyframes([a], proj, 0, { resampleIntervalMs: 250 });

  it('interpolates to the midpoint at t = span/2', () => {
    const [x] = glideSampleCpu(field, 0, 500);
    expect(x).toBeCloseTo(0.0005 * M, 3); // 55.66 m
  });

  it('clamps before the first frame (holds the start)', () => {
    const [x] = glideSampleCpu(field, 0, -9999);
    expect(x).toBeCloseTo(0, 6);
  });

  it('clamps past the last frame (holds the end)', () => {
    const [x] = glideSampleCpu(field, 0, 9_999_999);
    expect(x).toBeCloseTo(0.001 * M, 3);
  });

  it('holds a gap-bracketed sample at its last known position', () => {
    const g = makeTrack({
      trackId: 'G',
      times: [0, 5000, 6000],
      lon: [0, 0.005, 0.006],
    });
    const gf = assembleKeyframes([g], proj, 0, {
      resampleIntervalMs: 1000,
      maxGapMs: 2000,
    });
    // Mid-gap (t=2500): the entity holds A (0), it never travelled the hole.
    const [x] = glideSampleCpu(gf, 0, 2500);
    expect(x).toBeCloseTo(0, 4);
    // Post-gap normal bracket (t=5500): interpolates B→C.
    const [x2] = glideSampleCpu(gf, 0, 5500);
    expect(x2).toBeCloseTo(0.0055 * M, 3);
  });
});

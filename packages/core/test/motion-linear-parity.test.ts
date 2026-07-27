// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

/**
 * THE GATE for the motion-modes work.
 *
 * `TrackSampleConfig.motion` adds a second sampler to the track kernel. Every
 * shipped layer — AV boxes, meshes, motion-glide points, icons, trip heads, in
 * four renderer backends — calls `sampleTrack` with NO motion config, and must
 * keep getting exactly what it got before. Not "visually the same", not "equal
 * to nine decimals": the same doubles, the same NaNs, the same null-ness, and
 * the same set of own properties on the returned object, because downstream
 * code enumerates a `Sample` (pick rows, worker transfers) and can see a key
 * that was not there yesterday.
 *
 * So this suite is differential, not example-based. It fuzzes tracks and
 * playhead times across the whole config matrix and asserts that
 *
 *     sampleTrack(t, now, cfg)  ≡  sampleTrack(t, now, {...cfg, motion: {mode: 'linear'}})
 *
 * bit for bit. That equivalence is the definition of the `'linear'` mode, and it
 * is what lets the extended sampler be a separate function that duplicates the
 * default one's arithmetic: the duplication is kept honest here rather than by
 * careful reading.
 *
 * If you are here because this test failed after you touched
 * `sampleTrackExtended`: the two bodies have diverged. Do not relax the
 * comparison.
 */

import { describe, it, expect } from 'vitest';
import {
  sampleTrack,
  makePickRow,
  SINGLETON_HOLD_MS,
} from '../src/render/track-kernel';
import type {
  Sample,
  Track,
  TrackSampleConfig,
} from '../src/render/track-kernel';
import type { MotionConfig } from '../src/render/motion';

// ---------------------------------------------------------------------------
// Deterministic fuzz harness
// ---------------------------------------------------------------------------

/** mulberry32 — small, seeded, and identical run to run (CI must not flake). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A random track: 1–6 strictly-ascending keyframes, positions in range, and
 * columns that are individually NaN about a third of the time — the NaN-riddled
 * shape a real archive with a partially-populated `speed`/`heading` column has,
 * and the shape where `lerpDim`'s one-sided fallbacks actually differ.
 */
function randomTrack(r: () => number, id: number): Track {
  const n = 1 + Math.floor(r() * 6);
  const times: number[] = [];
  let t = Math.floor(r() * 100_000);
  for (let i = 0; i < n; i++) {
    times.push(t);
    t += 1 + Math.floor(r() * 5000);
  }
  const col = () => (r() < 0.33 ? NaN : (r() - 0.5) * 20);
  const track: Track = {
    trackId: `T${id}`,
    times,
    // Latitudes stay inside [-90, 90] and longitudes inside [-180, 180]: those
    // are the only values a decoded tile can carry, and the parity contract is
    // about real inputs.
    lon: times.map(() => (r() - 0.5) * 360),
    lat: times.map(() => (r() - 0.5) * 180),
    alt: times.map(() => r() * 500),
    heading: times.map(col),
    length: times.map(col),
    width: times.map(col),
    height: times.map(col),
    speed: times.map(col),
    color: [1, 2, 3, 4],
    label: 'l',
    category: 'c',
    singleton: n < 2,
  };
  return track;
}

/** Every numeric field of a `Sample`, compared under `Object.is` (NaN-aware). */
const NUMERIC_FIELDS = [
  'lon',
  'lat',
  'alt',
  'heading',
  'length',
  'width',
  'height',
  'speed',
  'alpha',
] as const;

/** The config matrix: angle unit × gap policy × fade ramps × singleton hold. */
const CONFIGS: TrackSampleConfig[] = [];
for (const angleUnit of [undefined, 'rad', 'deg'] as const) {
  for (const maxGapMs of [undefined, Infinity, 1500, 0]) {
    for (const fades of [
      { fadeInDuration: 0, fadeOutDuration: 0 },
      { fadeInDuration: 2000, fadeOutDuration: 3000 },
    ]) {
      CONFIGS.push({
        defaultLength: 4,
        defaultWidth: 2,
        defaultHeight: 1.6,
        ...fades,
        angleUnit,
        maxGapMs,
      });
    }
  }
}

function assertSamplesIdentical(
  a: Sample | null,
  b: Sample | null,
  where: string,
): void {
  // Both-null or both-non-null: a mode that culls one millisecond differently
  // makes entities blink, and a `toBeCloseTo` sweep would never see it.
  expect(a === null, `${where}: null-ness (default null=${a === null})`).toBe(
    b === null,
  );
  if (a === null || b === null) return;
  for (const f of NUMERIC_FIELDS) {
    expect(
      Object.is(a[f], b[f]),
      `${where}: field ${f} default=${a[f]} motion=${b[f]}`,
    ).toBe(true);
  }
  expect(b.track, `${where}: track identity`).toBe(a.track);
  // Own-property SET and order — `Object.keys` is observable downstream.
  expect(Object.keys(b), `${where}: own keys`).toEqual(Object.keys(a));
  // And specifically: the motion-path fields must not appear on either.
  expect(
    Object.prototype.hasOwnProperty.call(a, 'extrapolated'),
    `${where}: default sample has no 'extrapolated'`,
  ).toBe(false);
  expect(
    Object.prototype.hasOwnProperty.call(a, 'extrapolationAgeMs'),
    `${where}: default sample has no 'extrapolationAgeMs'`,
  ).toBe(false);
  expect(
    Object.prototype.hasOwnProperty.call(b, 'extrapolated'),
    `${where}: linear-mode sample has no 'extrapolated'`,
  ).toBe(false);
}

describe("motion mode 'linear' is byte-identical to no motion config", () => {
  it('agrees on 5000 randomized (track, now) draws across the config matrix', () => {
    const r = rng(0xc0ffee);
    let compared = 0;
    let nonNull = 0;
    for (let i = 0; i < 5000; i++) {
      const track = randomTrack(r, i);
      const first = track.times[0];
      const last = track.times[track.times.length - 1];
      // Draw `now` from a span that overhangs both ends by a full singleton
      // hold, so the cull boundaries and the hold band are exercised, not just
      // the interior.
      const span = last - first;
      const now =
        first - SINGLETON_HOLD_MS + r() * (span + 2 * SINGLETON_HOLD_MS + 2000);
      const cfg = CONFIGS[i % CONFIGS.length];
      const motion: MotionConfig = { mode: 'linear' };

      const base = sampleTrack(track, now, cfg);
      const withMotion = sampleTrack(track, now, { ...cfg, motion });
      assertSamplesIdentical(
        base,
        withMotion,
        `draw ${i} (cfg ${i % CONFIGS.length})`,
      );
      compared++;
      if (base !== null) nonNull++;
    }
    expect(compared).toBe(5000);
    // Guard against a harness that only ever draws culled playheads: a suite of
    // 5000 mutual `null`s would pass while proving nothing.
    expect(nonNull).toBeGreaterThan(2000);
  });

  it('agrees on the exact cull boundaries of a multi-keyframe track', () => {
    const track = makeTrack([1000, 2000, 5000]);
    const cfg: TrackSampleConfig = {
      defaultLength: 4,
      defaultWidth: 2,
      defaultHeight: 1.6,
      fadeInDuration: 0,
      fadeOutDuration: 0,
    };
    for (const now of [999, 1000, 1000.0001, 4999, 5000, 5000.0001, 5001]) {
      assertSamplesIdentical(
        sampleTrack(track, now, cfg),
        sampleTrack(track, now, { ...cfg, motion: { mode: 'linear' } }),
        `boundary now=${now}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The rest of the parity contract
// ---------------------------------------------------------------------------

/** A track with the given keyframe times, positions marching east 1° per frame. */
function makeTrack(times: number[]): Track {
  return {
    trackId: 'A',
    times,
    lon: times.map((_, i) => i),
    lat: times.map(() => 10),
    alt: times.map(() => 0),
    heading: times.map(() => 0.5),
    length: times.map(() => 4),
    width: times.map(() => 2),
    height: times.map(() => 1.5),
    speed: times.map(() => 12),
    color: [1, 2, 3, 4],
    label: '',
    category: '',
    singleton: times.length < 2,
  };
}

const BASE_CFG: TrackSampleConfig = {
  defaultLength: 4,
  defaultWidth: 2,
  defaultHeight: 1.6,
  fadeInDuration: 0,
  fadeOutDuration: 0,
};

describe('motion parity: pick rows, extrapolation opt-in, config immutability', () => {
  it('makePickRow on a default-path sample has exactly its 7 historical keys', () => {
    const s = sampleTrack(makeTrack([0, 1000]), 500, BASE_CFG)!;
    expect(Object.keys(makePickRow(s))).toEqual([
      'track_id',
      'category',
      'heading',
      'length',
      'width',
      'height',
      'speed',
    ]);
  });

  it("'linear' ignores maxExtrapolationMs — it still culls 1 ms past the last keyframe", () => {
    const track = makeTrack([0, 1000, 2000]);
    const cfg: TrackSampleConfig = {
      ...BASE_CFG,
      motion: { mode: 'linear', maxExtrapolationMs: 60_000 },
    };
    expect(sampleTrack(track, 2000, cfg)).not.toBeNull();
    expect(sampleTrack(track, 2001, cfg)).toBeNull();
    // …and the mode that DOES extrapolate proves the window was real.
    expect(
      sampleTrack(track, 2001, {
        ...BASE_CFG,
        motion: { mode: 'velocity', maxExtrapolationMs: 60_000 },
      }),
    ).not.toBeNull();
  });

  it('never mutates the config or the motion config it is handed', () => {
    const motion = Object.freeze<MotionConfig>({
      mode: 'velocity',
      maxExtrapolationMs: 5000,
      speedUnit: 'kn',
    });
    const cfg = Object.freeze<TrackSampleConfig>({ ...BASE_CFG, motion });
    const cfgBefore = JSON.stringify(cfg);
    const motionBefore = JSON.stringify(motion);
    const track = makeTrack([0, 1000, 2000]);
    for (let now = -100; now <= 8000; now += 137) sampleTrack(track, now, cfg);
    expect(JSON.stringify(cfg)).toBe(cfgBefore);
    expect(JSON.stringify(motion)).toBe(motionBefore);
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('an unset singletonHoldMs reproduces the historical 600 ms hold exactly', () => {
    expect(SINGLETON_HOLD_MS).toBe(600);
    const solo = makeTrack([10_000]);
    expect(solo.singleton).toBe(true);
    // ±300 ms around the lone keyframe, on BOTH samplers.
    for (const cfg of [
      BASE_CFG,
      { ...BASE_CFG, motion: { mode: 'linear' as const } },
    ]) {
      expect(sampleTrack(solo, 10_000 - 300, cfg)).not.toBeNull();
      expect(sampleTrack(solo, 10_000 + 300, cfg)).not.toBeNull();
      expect(sampleTrack(solo, 10_000 - 300.0001, cfg)).toBeNull();
      expect(sampleTrack(solo, 10_000 + 300.0001, cfg)).toBeNull();
    }
  });

  it('an explicit singletonHoldMs moves the hold band on both samplers', () => {
    const solo = makeTrack([10_000]);
    for (const motion of [undefined, { mode: 'linear' as const }]) {
      const cfg: TrackSampleConfig = {
        ...BASE_CFG,
        motion,
        singletonHoldMs: 400,
      };
      expect(sampleTrack(solo, 10_000 + 200, cfg)).not.toBeNull();
      expect(sampleTrack(solo, 10_000 + 200.0001, cfg)).toBeNull();
    }
  });
});

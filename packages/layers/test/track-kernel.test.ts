/**
 * Track-kernel unit tests.
 *
 * The kernel pools object-snapshot tiles into one track_id-keyed index (rebased
 * to absolute epoch-ms, sorted + de-duped) and interpolates one pose per active
 * track at the play head. These tests pin the de-dup path, which previously left
 * TRAILING undefined HOLES in the parallel arrays whenever a track carried
 * exact-duplicate timestamps — poisoning both the cull test and the pose lerp.
 */

import { describe, it, expect } from 'vitest';
import type { Color } from '@deck.gl/core';
import { makePointTile } from './fake-tile';
import {
  buildTrackIndex,
  sampleTrack,
  lerpAngle,
  resolveColor,
} from '../src/lib/track-kernel';
import type {
  TrackFieldConfig,
  TrackSampleConfig,
} from '../src/lib/track-kernel';

function categorical(values: string[]): {
  indices: Uint16Array;
  categories: string[];
} {
  const categories: string[] = [];
  const map = new Map<string, number>();
  const indices = new Uint16Array(values.length);
  values.forEach((v, i) => {
    let idx = map.get(v);
    if (idx === undefined) {
      idx = categories.length;
      categories.push(v);
      map.set(v, idx);
    }
    indices[i] = idx;
  });
  return { indices, categories };
}

/** One track 'A' whose keyframes carry an EXACT-duplicate timestamp (t=1000). */
function dupTimestampTile() {
  const times = [0, 1000, 1000, 2000];
  const tile = makePointTile({
    positions: [
      [0, 0],
      [10, 0],
      [10, 0],
      [20, 0],
    ],
    startTimes: times,
    endTimes: times,
    timeOffset: 0,
  });
  tile.layers[0].features.categoricalProps['track_id'] = categorical([
    'A',
    'A',
    'A',
    'A',
  ]);
  return tile;
}

const CFG: TrackFieldConfig = {
  trackIdProperty: 'track_id',
  colorProperty: '',
  labelProperty: 'category',
  headingProperty: 'heading',
  lengthProperty: 'length',
  widthProperty: 'width',
  heightProperty: 'height',
  speedProperty: 'speed',
  colorMapping: null,
  colorMappingDefault: [160, 160, 160, 255],
};

const SAMPLE: TrackSampleConfig = {
  defaultLength: 4,
  defaultWidth: 2,
  defaultHeight: 1.6,
  fadeInDuration: 0,
  fadeOutDuration: 0,
};

/** Degrees → radians (headings are stored/interpolated in radians). */
const deg = (d: number) => (d * Math.PI) / 180;

/** Build a single-tile track 'A' with two positioned keyframes. */
function twoKeyframeTrackA(lonA: number, lonB: number) {
  const tile = makePointTile({
    positions: [
      [lonA, 0],
      [lonB, 0],
    ],
    startTimes: [0, 1000],
    endTimes: [0, 1000],
    timeOffset: 0,
  });
  tile.layers[0].features.categoricalProps['track_id'] = categorical([
    'A',
    'A',
  ]);
  return tile;
}

describe('track-kernel de-dup (no trailing undefined holes)', () => {
  it('compacts duplicate timestamps to a DENSE array (length == kept count)', () => {
    const track = buildTrackIndex([dupTimestampTile()], CFG).tracks.get('A')!;
    // 4 snapshots, one exact-duplicate t=1000 dropped → 3 kept, no holes.
    expect(track.times.length).toBe(3);
    expect(Array.from(track.times)).toEqual([0, 1000, 2000]);
    // Every parallel array is the SAME dense length — no trailing undefined.
    for (const arr of [track.lon, track.lat, track.alt]) {
      expect(arr.length).toBe(3);
      expect(arr.every((v) => v !== undefined)).toBe(true);
    }
    // The last kept keyframe is real (was `undefined` with the hole bug).
    expect(track.times[track.times.length - 1]).toBe(2000);
    expect(track.lon[track.lon.length - 1]).toBe(20);
  });

  it('culls the track AFTER its last kept keyframe (high-side cull works)', () => {
    const track = buildTrackIndex([dupTimestampTile()], CFG).tracks.get('A')!;
    // Past the last real keyframe (2000) → inactive. With the hole bug,
    // last=times[n-1]=undefined made `now > NaN` false and the track never culled.
    expect(sampleTrack(track, 5000, SAMPLE)).toBeNull();
  });

  it('interpolates a finite pose AT the last kept keyframe (no NaN from a hole)', () => {
    const track = buildTrackIndex([dupTimestampTile()], CFG).tracks.get('A')!;
    const s = sampleTrack(track, 2000, SAMPLE)!;
    expect(s).not.toBeNull();
    // With the hole bug the final bracket lerped against undefined → NaN pose.
    expect(Number.isFinite(s.lon)).toBe(true);
    expect(Number.isFinite(s.lat)).toBe(true);
    expect(s.lon).toBeCloseTo(20, 6);
  });

  it('still interpolates correctly BETWEEN kept keyframes', () => {
    const track = buildTrackIndex([dupTimestampTile()], CFG).tracks.get('A')!;
    // Halfway between t=1000 (lon 10) and t=2000 (lon 20).
    const s = sampleTrack(track, 1500, SAMPLE)!;
    expect(s.lon).toBeCloseTo(15, 6);
  });
});

describe('track-kernel lerpAngle (shortest-arc wraparound)', () => {
  it('returns the a-endpoint at f=0 and an angle-equivalent of b at f=1', () => {
    expect(lerpAngle(deg(30), deg(90), 0)).toBeCloseTo(deg(30), 9);
    // At f=1 the result is a+delta — the same DIRECTION as b (cos/sin match)
    // though not necessarily b's exact numeric representative.
    const r = lerpAngle(deg(30), deg(90), 1);
    expect(Math.cos(r)).toBeCloseTo(Math.cos(deg(90)), 9);
    expect(Math.sin(r)).toBeCloseTo(Math.sin(deg(90)), 9);
  });

  it('crosses the 360/0 seam the SHORT way (350°→10° passes through 360°, not 180°)', () => {
    const mid = lerpAngle(deg(350), deg(10), 0.5);
    // Short arc is +20°, so the midpoint is 350°+10° = 360° (= 2π).
    expect(mid).toBeCloseTo(Math.PI * 2, 9);
    // The long way would pass through 180° (π); assert we did NOT.
    expect(Math.abs(mid - Math.PI)).toBeGreaterThan(1);
  });

  it('crosses the ±π seam the SHORT way (179°→-179° passes through 180°, not 0°)', () => {
    const mid = lerpAngle(deg(179), deg(-179), 0.5);
    // Short arc is +2°, midpoint = 180° (= π). Naive numeric lerp gives 0°.
    expect(mid).toBeCloseTo(Math.PI, 9);
  });

  it('is direction-symmetric (10°→350° goes the short way BACKWARD through 0°)', () => {
    const mid = lerpAngle(deg(10), deg(350), 0.5);
    // Short arc is -20°, midpoint = 10° - 10° = 0°.
    expect(mid).toBeCloseTo(0, 9);
  });

  it('does not wrap when the delta already lies within (-π, π]', () => {
    expect(lerpAngle(0, deg(90), 0.5)).toBeCloseTo(deg(45), 9);
    expect(lerpAngle(deg(-45), deg(45), 0.5)).toBeCloseTo(0, 9);
  });

  it('degrades to whichever endpoint is finite when the other is NaN', () => {
    expect(lerpAngle(NaN, deg(42), 0.5)).toBe(deg(42));
    expect(lerpAngle(deg(42), NaN, 0.5)).toBe(deg(42));
    expect(Number.isNaN(lerpAngle(NaN, NaN, 0.5))).toBe(true);
  });
});

describe('track-kernel sampleTrack heading (applies shortest-arc across keyframes)', () => {
  it('interpolates heading the short way across the 360/0 seam', () => {
    const tile = twoKeyframeTrackA(0, 1);
    tile.layers[0].features.numericProps['heading'] = new Float32Array([
      deg(350),
      deg(10),
    ]);
    const track = buildTrackIndex([tile], CFG).tracks.get('A')!;
    const h = sampleTrack(track, 500, SAMPLE)!.heading;
    // Short arc → ~360° (2π); the long-way naive result would be 180° (π).
    expect(h).toBeCloseTo(Math.PI * 2, 4);
    expect(Math.abs(h - Math.PI)).toBeGreaterThan(1);
  });
});

describe('track-kernel fade-in / fade-out alpha', () => {
  const FADE: TrackSampleConfig = {
    ...SAMPLE,
    fadeInDuration: 200,
    fadeOutDuration: 200,
  };

  it('ramps alpha 0→1 across the fade-in window measured from the first keyframe', () => {
    const track = buildTrackIndex([twoKeyframeTrackA(0, 1)], CFG).tracks.get(
      'A',
    )!;
    expect(sampleTrack(track, 0, FADE)!.alpha).toBeCloseTo(0, 9); // age 0 → 0/200
    expect(sampleTrack(track, 50, FADE)!.alpha).toBeCloseTo(0.25, 9); // 50/200
    expect(sampleTrack(track, 100, FADE)!.alpha).toBeCloseTo(0.5, 9); // 100/200
    expect(sampleTrack(track, 200, FADE)!.alpha).toBe(1); // fully faded in
  });

  it('holds alpha=1 through the steady middle', () => {
    const track = buildTrackIndex([twoKeyframeTrackA(0, 1)], CFG).tracks.get(
      'A',
    )!;
    expect(sampleTrack(track, 500, FADE)!.alpha).toBe(1);
  });

  it('ramps alpha 1→0 across the fade-out window measured to the last keyframe', () => {
    const track = buildTrackIndex([twoKeyframeTrackA(0, 1)], CFG).tracks.get(
      'A',
    )!;
    expect(sampleTrack(track, 800, FADE)!.alpha).toBe(1); // remaining 200, not < 200
    expect(sampleTrack(track, 900, FADE)!.alpha).toBeCloseTo(0.5, 9); // remaining 100/200
    expect(sampleTrack(track, 1000, FADE)!.alpha).toBeCloseTo(0, 9); // remaining 0
  });

  it('leaves alpha at 1 when both fade durations are 0', () => {
    const track = buildTrackIndex([twoKeyframeTrackA(0, 1)], CFG).tracks.get(
      'A',
    )!;
    expect(sampleTrack(track, 0, SAMPLE)!.alpha).toBe(1);
    expect(sampleTrack(track, 500, SAMPLE)!.alpha).toBe(1);
    expect(sampleTrack(track, 1000, SAMPLE)!.alpha).toBe(1);
  });

  it('folds fade-in and fade-out ramps toward the geometric pose independently', () => {
    // Sanity: the faded sample still carries the interpolated position; only
    // alpha changes with the ramp.
    const track = buildTrackIndex([twoKeyframeTrackA(0, 10)], CFG).tracks.get(
      'A',
    )!;
    const s = sampleTrack(track, 100, FADE)!;
    expect(s.alpha).toBeCloseTo(0.5, 9);
    expect(s.lon).toBeCloseTo(1, 9); // 100/1000 of the way from lon 0 → 10
  });
});

describe('track-kernel multi-track pooling', () => {
  it('groups interleaved snapshots into one index entry per track_id', () => {
    // Tracks A and B interleaved across the same two timestamps.
    const tile = makePointTile({
      positions: [
        [0, 0],
        [100, 0],
        [10, 0],
        [110, 0],
      ],
      startTimes: [0, 0, 1000, 1000],
      endTimes: [0, 0, 1000, 1000],
      timeOffset: 0,
    });
    tile.layers[0].features.categoricalProps['track_id'] = categorical([
      'A',
      'B',
      'A',
      'B',
    ]);
    const result = buildTrackIndex([tile], CFG);

    expect(result.totalSnapshots).toBe(4);
    expect(result.tracks.size).toBe(2);
    expect(result.trackIdMissing).toBe(false);

    const a = result.tracks.get('A')!;
    const b = result.tracks.get('B')!;
    expect(Array.from(a.times)).toEqual([0, 1000]);
    expect(Array.from(a.lon)).toEqual([0, 10]);
    expect(Array.from(b.times)).toEqual([0, 1000]);
    expect(Array.from(b.lon)).toEqual([100, 110]);

    // Each track interpolates independently at the same playhead.
    expect(sampleTrack(a, 500, SAMPLE)!.lon).toBeCloseTo(5, 9);
    expect(sampleTrack(b, 500, SAMPLE)!.lon).toBeCloseTo(105, 9);
  });

  it('flags a missing track-id column and synthesises one held instance per snapshot', () => {
    // No track_id column → each snapshot becomes its own singleton track.
    const tile = makePointTile({
      positions: [
        [0, 0],
        [5, 5],
      ],
      startTimes: [0, 1000],
      endTimes: [0, 1000],
      timeOffset: 0,
    });
    const result = buildTrackIndex([tile], CFG);
    expect(result.trackIdMissing).toBe(true);
    expect(result.tracks.size).toBe(2); // one synthetic key each
    for (const t of result.tracks.values()) {
      expect(t.singleton).toBe(true);
      expect(t.trackId).toBe(''); // synthetic tracks carry no id
    }
  });
});

describe('track-kernel cross-tile epoch rebasing', () => {
  it('rebases each tile to absolute epoch-ms and merges a track into one sorted timeline', () => {
    // Same track 'A' split across two tiles. The array lists the LATER-offset
    // tile first; rebasing (start + timeOffset) plus the sort must interleave
    // them by absolute time, not tile order.
    const later = makePointTile({
      positions: [
        [0, 0],
        [1, 0],
      ],
      startTimes: [0, 100],
      endTimes: [0, 100],
      timeOffset: 5000, // → absolute 5000, 5100
    });
    later.layers[0].features.categoricalProps['track_id'] = categorical([
      'A',
      'A',
    ]);
    const earlier = makePointTile({
      positions: [
        [10, 0],
        [11, 0],
      ],
      startTimes: [0, 100],
      endTimes: [0, 100],
      timeOffset: 1000, // → absolute 1000, 1100
    });
    earlier.layers[0].features.categoricalProps['track_id'] = categorical([
      'A',
      'A',
    ]);

    const track = buildTrackIndex([later, earlier], CFG).tracks.get('A')!;
    // One pooled timeline, sorted ascending by ABSOLUTE time (not tile order).
    expect(Array.from(track.times)).toEqual([1000, 1100, 5000, 5100]);
    // lon reordered to match: earlier tile's [10, 11] then later tile's [0, 1].
    expect(Array.from(track.lon)).toEqual([10, 11, 0, 1]);
    expect(track.singleton).toBe(false);

    // Interpolates within the earlier tile's bracket...
    expect(sampleTrack(track, 1050, SAMPLE)!.lon).toBeCloseTo(10.5, 9);
    // ...and within the later tile's bracket.
    expect(sampleTrack(track, 5050, SAMPLE)!.lon).toBeCloseTo(0.5, 9);
    // Active across the inter-tile gap (bridged, not culled).
    expect(sampleTrack(track, 3000, SAMPLE)).not.toBeNull();
    // Outside the merged span on either side → inactive.
    expect(sampleTrack(track, 500, SAMPLE)).toBeNull();
    expect(sampleTrack(track, 6000, SAMPLE)).toBeNull();
  });
});

describe('track-kernel resolveColor', () => {
  const fallback: Color = [160, 160, 160, 255];

  it('returns the mapped RGBA for a known category', () => {
    expect(resolveColor('car', { car: [255, 0, 0, 200] }, fallback)).toEqual([
      255, 0, 0, 200,
    ]);
  });

  it('falls back for an unmapped category', () => {
    expect(resolveColor('bus', { car: [255, 0, 0, 200] }, fallback)).toEqual([
      160, 160, 160, 255,
    ]);
  });

  it('falls back for an empty category or a null/undefined mapping', () => {
    expect(resolveColor('', { car: [255, 0, 0, 200] }, fallback)).toEqual([
      160, 160, 160, 255,
    ]);
    expect(resolveColor('car', null, fallback)).toEqual([160, 160, 160, 255]);
    expect(resolveColor('car', undefined, fallback)).toEqual([
      160, 160, 160, 255,
    ]);
  });

  it('defaults alpha to 255 when the resolved color omits it (RGB triple)', () => {
    expect(resolveColor('car', { car: [10, 20, 30] }, fallback)).toEqual([
      10, 20, 30, 255,
    ]);
    expect(resolveColor('x', {}, [7, 8, 9])).toEqual([7, 8, 9, 255]);
  });

  it('bakes a track color from its category through colorMapping (buildTrackIndex wiring)', () => {
    const tile = twoKeyframeTrackA(0, 1);
    tile.layers[0].features.categoricalProps['category'] = categorical([
      'car',
      'car',
    ]);
    const cfg: TrackFieldConfig = {
      ...CFG,
      colorProperty: 'category',
      colorMapping: { car: [12, 34, 56, 200] },
    };
    const track = buildTrackIndex([tile], cfg).tracks.get('A')!;
    expect(track.category).toBe('car');
    expect(track.color).toEqual([12, 34, 56, 200]);
  });
});

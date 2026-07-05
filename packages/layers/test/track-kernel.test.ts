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
import { makePointTile } from './fake-tile';
import { buildTrackIndex, sampleTrack } from '../src/lib/track-kernel';
import type { TrackFieldConfig, TrackSampleConfig } from '../src/lib/track-kernel';

function categorical(values: string[]): { indices: Uint16Array; categories: string[] } {
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
    positions: [[0, 0], [10, 0], [10, 0], [20, 0]],
    startTimes: times,
    endTimes: times,
    timeOffset: 0,
  });
  tile.layers[0].features.categoricalProps['track_id'] = categorical(['A', 'A', 'A', 'A']);
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

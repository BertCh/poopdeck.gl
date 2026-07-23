/**
 * Incremental track-index maintenance (motion-glide perf fix) tests.
 *
 * The glide render path (AnimatedPointLayer / AnimatedIconLayer) used to rebuild
 * the ENTIRE id-keyed track index — O(all resident snapshots): pool every
 * feature, sort + reorder every track — whenever the loader's tile array changed
 * identity. During playback the window slides (tiles load/evict) so that full
 * rebuild ran in one synchronous render frame each churn: a frame-time spike.
 *
 * {@link TrackIndexMaintainer} replaces it with an incremental rebuild keyed by
 * the stable per-(tile, layer) key: only ADDED tiles are pooled + appended and
 * only REMOVED tiles dropped, then only AFFECTED tracks are re-sorted. These
 * tests pin BOTH properties the fix rests on:
 *   (a) CORRECTNESS — after building over [A, B, C] then syncing to [B, C, D],
 *       the maintained index is byte-for-byte equal to a fresh full
 *       {@link buildTrackIndex} over [B, C, D] (same track ids, same
 *       sorted+deduped per-track arrays, same singleton flags).
 *   (b) INCREMENTALITY — syncing [A, B, C] → [B, C, D] re-sorts ONLY tracks that
 *       were in the removed tile A or the added tile D; tracks confined to the
 *       unchanged tiles B/C are left untouched.
 *
 * Mirrors the fake-tile harness used by the deck motion-point-interpolation
 * suite. Moved here with the kernel when it was hoisted out of
 * `@poopdeck.gl/layers` into framework-free core (campaign D7).
 */

import { describe, it, expect } from 'vitest';
import {
  buildTrackIndex,
  TrackIndexMaintainer,
} from '../src/render/track-kernel';
import type { Track, TrackFieldConfig } from '../src/render/track-kernel';
import { makePointTile, categorical } from './helpers/track-tiles';
import type { Tile } from '../src/types';

// ---------------------------------------------------------------------------
// Fake-tile harness
// ---------------------------------------------------------------------------

interface IdRow {
  id: string;
  /** Time RELATIVE to the tile timeOffset (== absolute here; offset is 0). */
  t: number;
  lon: number;
  lat?: number;
}

/** Build a point tile whose entity id lives in an `icao24` categorical column. */
function makeIdTile(rows: IdRow[], tileId: number): Tile {
  const tile = makePointTile({
    positions: rows.map((r) => [r.lon, r.lat ?? 0]),
    startTimes: rows.map((r) => r.t),
    endTimes: rows.map((r) => r.t),
    timeOffset: 0,
    tileId: { z: 6, x: 1, y: 2, t: tileId },
  });
  tile.layers[0].features.categoricalProps['icao24'] = categorical(
    rows.map((r) => r.id),
  );
  return tile;
}

const CFG: TrackFieldConfig = {
  trackIdProperty: 'icao24',
  colorProperty: '',
  labelProperty: '',
  headingProperty: '',
  lengthProperty: '',
  widthProperty: '',
  heightProperty: '',
  speedProperty: '',
  colorMapping: null,
  colorMappingDefault: [0, 0, 0, 0],
};

// A: spanAB (2), onlyA (1). B: spanAB (2, out of order), spanBC (1), onlyB (2,
// out of order). C: spanBC (1), onlyC (2), soloC (1 — a singleton). D: onlyD
// (2, out of order). lon == t so a sorted `times` implies a sorted `lon`.
const TILE_A = makeIdTile(
  [
    { id: 'spanAB', t: 100, lon: 100 },
    { id: 'spanAB', t: 300, lon: 300 },
    { id: 'onlyA', t: 50, lon: 50 },
  ],
  0,
);
const TILE_B = makeIdTile(
  [
    { id: 'spanAB', t: 500, lon: 500 },
    { id: 'spanAB', t: 200, lon: 200 },
    { id: 'spanBC', t: 2000, lon: 2000 },
    { id: 'onlyB', t: 20, lon: 20 },
    { id: 'onlyB', t: 10, lon: 10 },
  ],
  1,
);
const TILE_C = makeIdTile(
  [
    { id: 'spanBC', t: 1000, lon: 1000 },
    { id: 'onlyC', t: 40, lon: 40 },
    { id: 'onlyC', t: 30, lon: 30 },
    { id: 'soloC', t: 7000, lon: 7000 },
  ],
  2,
);
const TILE_D = makeIdTile(
  [
    { id: 'onlyD', t: 5000, lon: 5000 },
    { id: 'onlyD', t: 4000, lon: 4000 },
  ],
  3,
);

/** Parallel-array fields compared for byte-for-byte track equality. */
const NUM_FIELDS: (keyof Track)[] = [
  'times',
  'lon',
  'lat',
  'alt',
  'heading',
  'length',
  'width',
  'height',
  'speed',
];

/** Assert two id→Track maps are byte-for-byte equal (order-independent). */
function expectTrackMapsEqual(
  got: Map<string, Track>,
  want: Map<string, Track>,
): void {
  expect(new Set(got.keys())).toEqual(new Set(want.keys()));
  for (const [id, w] of want) {
    const g = got.get(id);
    expect(g, `track ${id} present`).toBeDefined();
    expect(g!.trackId).toBe(w.trackId);
    expect(g!.singleton).toBe(w.singleton);
    expect(g!.category).toBe(w.category);
    expect(g!.label).toBe(w.label);
    expect(g!.color).toEqual(w.color);
    for (const f of NUM_FIELDS) {
      // NaN-aware compare (heading/dims/speed are NaN when the column is absent).
      expect(g![f], `track ${id} field ${String(f)}`).toEqual(w[f]);
    }
  }
}

describe('TrackIndexMaintainer (motion-glide incremental index)', () => {
  // ── (a) CORRECTNESS ───────────────────────────────────────────────────────

  it('matches a fresh full build after [A,B,C] → [B,C,D] (added D, removed A)', () => {
    const m = new TrackIndexMaintainer();
    m.sync([TILE_A, TILE_B, TILE_C], CFG); // build over [A,B,C]
    const incremental = m.sync([TILE_B, TILE_C, TILE_D], CFG); // slide the window

    const fresh = buildTrackIndex([TILE_B, TILE_C, TILE_D], CFG);

    // The removed-only entity is gone; the added entity is present.
    expect(incremental.tracks.has('onlyA')).toBe(false);
    expect(incremental.tracks.has('onlyD')).toBe(true);
    // spanAB survives on B alone (A's two keyframes dropped).
    expect(incremental.tracks.get('spanAB')!.times).toEqual([200, 500]);
    // spanBC pooled cross-tile from B(2000)+C(1000), sorted ascending.
    expect(incremental.tracks.get('spanBC')!.times).toEqual([1000, 2000]);
    // soloC stays a held singleton.
    expect(incremental.tracks.get('soloC')!.singleton).toBe(true);

    expectTrackMapsEqual(incremental.tracks, fresh.tracks);
    // Aggregate flags/counts match the full build too.
    expect(incremental.trackIdMissing).toBe(fresh.trackIdMissing);
    expect(incremental.hasSpeedColumn).toBe(fresh.hasSpeedColumn);
    expect(incremental.totalSnapshots).toBe(fresh.totalSnapshots);
  });

  it('the initial full sync equals a fresh build over the same tiles', () => {
    const m = new TrackIndexMaintainer();
    const res = m.sync([TILE_A, TILE_B, TILE_C], CFG);
    expectTrackMapsEqual(
      res.tracks,
      buildTrackIndex([TILE_A, TILE_B, TILE_C], CFG).tracks,
    );
  });

  // ── (b) INCREMENTALITY ─────────────────────────────────────────────────────

  it('re-sorts ONLY tracks in the removed or added tile, never the untouched B/C tracks', () => {
    const m = new TrackIndexMaintainer();
    m.sync([TILE_A, TILE_B, TILE_C], CFG);

    m.sync([TILE_B, TILE_C, TILE_D], CFG);
    const resorted = new Set(m.resortedTrackIds);

    // Affected = a track fed by the removed tile A (spanAB, rebuilt from B) or
    // the added tile D (onlyD). Nothing else may be re-sorted.
    expect(resorted).toEqual(new Set(['spanAB', 'onlyD']));

    // Tracks confined to the UNCHANGED tiles B/C were not re-sorted.
    for (const untouched of ['spanBC', 'onlyB', 'onlyC', 'soloC']) {
      expect(resorted.has(untouched)).toBe(false);
    }
    // onlyA lived only in the removed tile → dropped, not re-sorted.
    expect(resorted.has('onlyA')).toBe(false);
  });

  it('re-syncing the identical tile set re-sorts nothing (pure no-op)', () => {
    const m = new TrackIndexMaintainer();
    const tiles = [TILE_A, TILE_B, TILE_C];
    m.sync(tiles, CFG);
    m.sync(tiles, CFG); // same set again
    expect(m.resortedTrackIds).toEqual([]);
  });

  it('a full-window turnover re-sorts only the newly-arrived multi-sample tracks', () => {
    // [A,B] → [C,D]: everything from A/B is dropped, everything in C/D arrives.
    const m = new TrackIndexMaintainer();
    m.sync([TILE_A, TILE_B], CFG);
    const after = m.sync([TILE_C, TILE_D], CFG);
    // Only the multi-sample newcomers sort (soloC is a singleton → no sort).
    expect(new Set(m.resortedTrackIds)).toEqual(new Set(['onlyC', 'onlyD']));
    // spanBC now has only C's single keyframe → held singleton, present.
    expect(after.tracks.get('spanBC')!.singleton).toBe(true);
    expectTrackMapsEqual(
      after.tracks,
      buildTrackIndex([TILE_C, TILE_D], CFG).tracks,
    );
  });
});

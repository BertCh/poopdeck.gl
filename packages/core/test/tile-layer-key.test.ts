// @poopdeck.gl/core
// SPDX-License-Identifier: MIT

/**
 * A temporal-LOD tile and the base tile it shares `z/x/y/t` with must occupy
 * SEPARATE slots in every per-(tile, layer) registry.
 *
 * The two tiers are the same address at different bucket widths, so a key
 * spelled `z/x/y/t:<layer>` gives them one slot. The damage is silent: the
 * absorb path treats the second tier as "already resident" and never pools it,
 * and the evict path drops the survivor's entry when only the other tier goes
 * out of view. `tileLayerKey` folds the tier in because {@link tileKey} does —
 * these tests pin that, and pin the base-tier spelling that layers, backends
 * and their caches all share.
 */

import { describe, it, expect } from 'vitest';
import { tileKey } from '../src/tile-key';
import { tileLayerKey, TrackIndexMaintainer } from '../src/render/track-kernel';
import type { TrackFieldConfig } from '../src/render/track-kernel';
import { makePointTile, categorical } from './helpers/track-tiles';
import type { Tile, TileId } from '../src/types';

const BASE_ID: TileId = { z: 6, x: 17, y: 24, t: 1_700_000_000_000 };
/** Same address, coarser tier: one hour of time where the base holds one bucket. */
const LOD_ID: TileId = { ...BASE_ID, bucketMs: 3_600_000 };

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

/** One-track, one-keyframe tile at `id`, so each tier's payload is identifiable. */
function makeTrackTile(id: TileId, time: number): Tile {
  const tile = makePointTile({
    positions: [[time, 0]],
    startTimes: [time],
    endTimes: [time],
    timeOffset: 0,
    tileId: id as { z: number; x: number; y: number; t: number },
  });
  tile.id = id;
  tile.layers[0].features.categoricalProps['icao24'] = categorical(['ac1']);
  return tile;
}

describe('tileLayerKey', () => {
  it('composes the canonical tile key with the layer name', () => {
    expect(tileLayerKey(BASE_ID, 'trips')).toBe(`${tileKey(BASE_ID)}:trips`);
    expect(tileLayerKey(BASE_ID, 'trips')).toBe(
      '6/17/24/1700000000000#0:trips',
    );
  });

  it('separates a temporal-LOD tile from its base twin', () => {
    expect(tileLayerKey(LOD_ID, 'trips')).toBe(
      '6/17/24/1700000000000#0@3600000:trips',
    );
    expect(tileLayerKey(LOD_ID, 'trips')).not.toBe(
      tileLayerKey(BASE_ID, 'trips'),
    );
  });

  it('distinguishes bucket widths from each other', () => {
    expect(tileLayerKey({ ...BASE_ID, bucketMs: 60_000 }, 'trips')).not.toBe(
      tileLayerKey({ ...BASE_ID, bucketMs: 600_000 }, 'trips'),
    );
  });
});

describe('TrackIndexMaintainer with both tiers resident', () => {
  const base = makeTrackTile(BASE_ID, 100);
  const lod = makeTrackTile(LOD_ID, 200);

  it('absorbs both tiers instead of mistaking one for the other', () => {
    const m = new TrackIndexMaintainer();
    const result = m.sync([base, lod], CFG);

    // Aliased keys make the second tier look already-absorbed: one snapshot,
    // one keyframe, and the LOD tile's payload silently dropped on the floor.
    expect(result.totalSnapshots).toBe(2);
    expect([...result.tracks.get('ac1')!.times]).toEqual([100, 200]);
  });

  it('evicts only the tier that left the view', () => {
    const m = new TrackIndexMaintainer();
    m.sync([base, lod], CFG);
    const result = m.sync([base], CFG);

    expect(result.totalSnapshots).toBe(1);
    expect([...result.tracks.get('ac1')!.times]).toEqual([100]);
  });

  it('pools the base tile that arrives at an address the LOD tier held', () => {
    const m = new TrackIndexMaintainer();
    m.sync([lod], CFG);
    const result = m.sync([base], CFG);

    // Aliased keys make the base tile look already-absorbed, so the index keeps
    // serving the departed LOD tile's coarser keyframe under the base's name.
    expect([...result.tracks.get('ac1')!.times]).toEqual([100]);
  });
});

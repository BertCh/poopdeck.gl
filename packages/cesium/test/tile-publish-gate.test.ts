// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { TilePublishGate } from '../src/lib/tile-publish-gate';
import type { Tile, TileId } from '@poopdeck.gl/core';

const tile = (
  id: Partial<TileId> & Pick<TileId, 'z' | 'x' | 'y' | 't'>,
): Tile =>
  ({
    id: id as TileId,
    timeRange: { start: id.t, end: id.t + 1000 },
    layers: [],
  }) as Tile;

const A = tile({ z: 9, x: 1, y: 2, t: 0 });
const B = tile({ z: 9, x: 2, y: 2, t: 0 });
const C = tile({ z: 9, x: 3, y: 2, t: 0 });

describe('TilePublishGate', () => {
  it('publishes the first non-empty set', () => {
    const gate = new TilePublishGate();
    expect(gate.offer([A, B])).toEqual({
      publish: true,
      reason: 'changed',
      added: 2,
      removed: 0,
    });
  });

  it('refuses an identical set — the O(N·M) rebuild that buys nothing', () => {
    // The playhead hook and onTileUnload both re-offer the resident set
    // constantly; each acceptance is a full removeAll() + per-feature rebuild.
    const gate = new TilePublishGate();
    gate.offer([A, B]);
    expect(gate.offer([A, B]).publish).toBe(false);
    expect(gate.offer([B, A]).reason).toBe('unchanged'); // order is not identity
  });

  it('publishes on an add, a removal, and a swap', () => {
    const gate = new TilePublishGate();
    gate.offer([A, B]);
    expect(gate.offer([A, B, C])).toEqual({
      publish: true,
      reason: 'changed',
      added: 1,
      removed: 0,
    });
    expect(gate.offer([A])).toEqual({
      publish: true,
      reason: 'changed',
      added: 0,
      removed: 2,
    });
    expect(gate.offer([B])).toEqual({
      publish: true,
      reason: 'changed',
      added: 1,
      removed: 1,
    });
  });

  it('refuses an EMPTY set, and does not forget what is on screen', () => {
    // getVisibleTiles() is empty for the frames between a selection change and
    // the first decoded tile of the new set. Publishing that tears the layer
    // down and back up — the "tiles genuinely in view flash out" symptom.
    const gate = new TilePublishGate({ now: () => 0 });
    gate.offer([A, B]);
    expect(gate.offer([])).toEqual({
      publish: false,
      reason: 'empty',
      added: 0,
      removed: 0,
    });
    // …and the held set is still the published one, so the tiles coming back
    // unchanged after the gap do not trigger a pointless rebuild either.
    expect(gate.offer([A, B]).publish).toBe(false);
  });

  it('CLEARS once the emptiness stops being a transient', () => {
    // The refusal above is a bet that the emptiness is the gap between a
    // selection change and the first decode. It is not always: pan a land-only
    // archive out over open ocean, or scrub the playhead past the end of the
    // data, and `getVisibleTiles()` is empty FOREVER. An unbounded refusal then
    // leaves the last good tiles on the globe permanently — the map showing data
    // that is not there, which is worse than a blank one because nothing about
    // it looks broken. Bound the bet to the transient it was meant to cover.
    let t = 0;
    const gate = new TilePublishGate({ emptyHoldMs: 1500, now: () => t });
    gate.offer([A, B]);

    t = 100;
    expect(gate.offer([])).toEqual({
      publish: false,
      reason: 'empty',
      added: 0,
      removed: 0,
    });
    t = 1599; // 1499 ms into the hold
    expect(gate.offer([]).publish).toBe(false);

    t = 1600; // 1500 ms — the hold is spent
    expect(gate.offer([])).toEqual({
      publish: true,
      reason: 'cleared',
      added: 0,
      removed: 2,
    });
    // Having cleared, it must not keep re-publishing the same empty set: that
    // is the O(N·M) rebuild storm the gate exists to prevent, at frame rate.
    t = 5000;
    expect(gate.offer([]).publish).toBe(false);
    expect(gate.offer([]).reason).toBe('empty');
  });

  it('restarts the hold whenever tiles come back', () => {
    // The clock is per-GAP, not cumulative: a dataset that flickers empty for
    // 200 ms on every scrub must never accumulate its way to a clear.
    let t = 0;
    const gate = new TilePublishGate({ emptyHoldMs: 1000, now: () => t });
    gate.offer([A, B]);
    for (let i = 0; i < 20; i++) {
      t += 900;
      expect(gate.offer([]).publish).toBe(false);
      t += 10;
      gate.offer([A, B, C]); // tiles return, hold resets
      gate.offer([A, B]);
    }
    // 20 × 900 ms of accumulated emptiness has bought nothing. Only an
    // UNINTERRUPTED 1000 ms clears.
    t += 900;
    expect(gate.offer([]).publish).toBe(false); // arms the hold at this instant
    t += 999;
    expect(gate.offer([]).reason).toBe('empty');
    t += 1;
    expect(gate.offer([]).reason).toBe('cleared');
  });

  it('does not arm a hold when nothing is published yet', () => {
    // Empty in, empty out: there is nothing on screen to protect and nothing to
    // clear, so the first real set must still publish as an ordinary change.
    let t = 0;
    const gate = new TilePublishGate({ emptyHoldMs: 1000, now: () => t });
    expect(gate.offer([]).reason).toBe('empty');
    t = 99_999;
    expect(gate.offer([]).reason).toBe('empty');
    expect(gate.offer([A]).publish).toBe(true);
  });

  it('separates the temporal-LOD tier from its base twin', () => {
    // A LOD tile shares z/x/y/t with the base tile at the same instant but holds
    // different bytes; keying without bucketMs would call the swap "unchanged"
    // and leave the coarse preview on screen.
    const gate = new TilePublishGate();
    gate.offer([tile({ z: 9, x: 1, y: 2, t: 0 })]);
    expect(
      gate.offer([tile({ z: 9, x: 1, y: 2, t: 0, bucketMs: 60_000 })]).publish,
    ).toBe(true);
  });

  it('does not report a phantom removal for a duplicated id', () => {
    const gate = new TilePublishGate();
    gate.offer([A, B]);
    expect(gate.offer([A, A, B]).publish).toBe(false);
  });

  it('reset() forgets the published set AND any hold in progress', () => {
    let t = 0;
    const gate = new TilePublishGate({ emptyHoldMs: 1000, now: () => t });
    gate.offer([A]);
    t = 500;
    gate.offer([]); // hold armed at 500
    gate.reset();
    // A layer swap must not leave a primed clear behind: the next empty offer
    // belongs to the NEW layer's first-decode transient, not the old one's gap.
    t = 1600;
    expect(gate.offer([]).reason).toBe('empty');
    expect(gate.offer([A]).publish).toBe(true);
  });
});

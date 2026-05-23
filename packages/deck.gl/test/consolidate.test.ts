/**
 * Consolidated-data tests.
 *
 * Verifies that the pure consolidation helpers (used by AnimatedPointLayer /
 * AnimatedPathLayer) produce correct array lengths, offsets and the
 * relative-time scheme for a 2-tile input.
 */

import { describe, it, expect } from 'vitest';
import { consolidatePoints, consolidatePaths } from '../src/consolidate';
import { makePointTile, makePathTile } from './fake-tile';

describe('consolidatePoints', () => {
  it('merges two point tiles into single arrays with correct length', () => {
    const offset = 1_716_206_000_000;
    const tileA = makePointTile({
      positions: [[0, 0], [1, 1]],
      startTimes: [100, 200],
      endTimes: [150, 250],
      timeOffset: offset,
    });
    const tileB = makePointTile({
      positions: [[2, 2]],
      startTimes: [300],
      endTimes: [350],
      timeOffset: offset,
    });

    const out = consolidatePoints([tileA, tileB])!;
    expect(out).not.toBeNull();
    expect(out.length).toBe(3);
    // dims is always 3 because deck.gl's ScatterplotLayer registers
    // instancePositions at size 3; z is zero-padded for 2D tiles.
    expect(out.dims).toBe(3);
    expect(out.positions.length).toBe(3 * 3);
    expect(out.startTimes.length).toBe(3);
    expect(out.endTimes.length).toBe(3);
  });

  it('preserves positions in tile order', () => {
    const tileA = makePointTile({
      positions: [[10, 20]],
      startTimes: [0],
      endTimes: [1],
      timeOffset: 0,
    });
    const tileB = makePointTile({
      positions: [[30, 40]],
      startTimes: [0],
      endTimes: [1],
      timeOffset: 0,
    });
    const out = consolidatePoints([tileA, tileB])!;
    // z component is zero-padded for 2D tiles.
    expect(Array.from(out.positions)).toEqual([10, 20, 0, 30, 40, 0]);
  });

  it('keeps times relative and rebases tiles onto the first tile offset', () => {
    // tileB has a DIFFERENT offset; its times must be rebased so all output
    // times are relative to the same (first tile's) offset.
    const tileA = makePointTile({
      positions: [[0, 0]],
      startTimes: [500],
      endTimes: [600],
      timeOffset: 1_000_000,
    });
    const tileB = makePointTile({
      positions: [[1, 1]],
      startTimes: [500],
      endTimes: [600],
      timeOffset: 1_002_000, // 2000ms later
    });

    const out = consolidatePoints([tileA, tileB])!;
    expect(out.timeOffset).toBe(1_000_000); // first tile's offset

    // tileA: unchanged (delta 0)
    expect(out.startTimes[0]).toBe(500);
    // tileB: rebased by (1_002_000 - 1_000_000) = +2000
    expect(out.startTimes[1]).toBe(2500);
    expect(out.endTimes[1]).toBe(2600);

    // All output times stay small (relative) - safe for Float32.
    for (const t of out.startTimes) {
      expect(Math.abs(t)).toBeLessThan(16_777_216);
    }
  });

  it('returns null for empty tile set', () => {
    expect(consolidatePoints([])).toBeNull();
  });
});

describe('consolidatePaths', () => {
  it('merges two path tiles with correct startIndices offsets', () => {
    // tileA: 2 paths (3 + 2 vertices). tileB: 1 path (4 vertices).
    const tileA = makePathTile({
      paths: [
        [[0, 0], [1, 1], [2, 2]],
        [[3, 3], [4, 4]],
      ],
      startTimes: [10, 20],
      endTimes: [15, 25],
      timeOffset: 0,
    });
    const tileB = makePathTile({
      paths: [[[5, 5], [6, 6], [7, 7], [8, 8]]],
      startTimes: [30],
      endTimes: [35],
      timeOffset: 0,
    });

    const out = consolidatePaths([tileA, tileB])!;
    expect(out.length).toBe(3); // 3 paths total
    // startIndices length = featureCount + 1
    expect(out.startIndices.length).toBe(4);
    // Vertex offsets: 0, 3, 5, 9 (total)
    expect(Array.from(out.startIndices)).toEqual([0, 3, 5, 9]);
    // 9 total vertices * 2 dims
    expect(out.positions.length).toBe(9 * 2);
  });

  it('concatenates path vertices contiguously across tiles', () => {
    const tileA = makePathTile({
      paths: [[[0, 0], [1, 1]]],
      startTimes: [0],
      endTimes: [1],
      timeOffset: 0,
    });
    const tileB = makePathTile({
      paths: [[[9, 9], [8, 8]]],
      startTimes: [0],
      endTimes: [1],
      timeOffset: 0,
    });
    const out = consolidatePaths([tileA, tileB])!;
    expect(Array.from(out.positions)).toEqual([0, 0, 1, 1, 9, 9, 8, 8]);
  });

  it('keeps per-feature times relative and rebased', () => {
    const tileA = makePathTile({
      paths: [[[0, 0], [1, 1]]],
      startTimes: [100],
      endTimes: [200],
      timeOffset: 5_000_000,
    });
    const tileB = makePathTile({
      paths: [[[2, 2], [3, 3]]],
      startTimes: [100],
      endTimes: [200],
      timeOffset: 5_001_000,
    });
    const out = consolidatePaths([tileA, tileB])!;
    expect(out.timeOffset).toBe(5_000_000);
    expect(out.startTimes[0]).toBe(100);
    expect(out.startTimes[1]).toBe(1100); // +1000 rebase
  });

  it('returns null for empty tile set', () => {
    expect(consolidatePaths([])).toBeNull();
  });
});

describe('consolidation cache key stability (time-independent)', () => {
  it('consolidation output does not depend on current time', () => {
    // The consolidated buffers are purely geometric/temporal-attribute data;
    // they must be identical regardless of the animation clock. This is what
    // lets the cache key omit time (item 5: trips layer cache fix).
    const tile = makePointTile({
      positions: [[0, 0], [1, 1]],
      startTimes: [10, 20],
      endTimes: [15, 25],
      timeOffset: 0,
    });
    const a = consolidatePoints([tile])!;
    const b = consolidatePoints([tile])!;
    expect(Array.from(a.startTimes)).toEqual(Array.from(b.startTimes));
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
  });
});

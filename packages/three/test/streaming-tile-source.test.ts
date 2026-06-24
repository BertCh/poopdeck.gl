import { describe, it, expect, vi } from 'vitest';
import type { BoundingBox, Tile, TileId } from '@poopdeck.gl/core';
import type { BufferedRunway as CoreBufferedRunway } from '@poopdeck.gl/core';
import {
  StreamingTileSource,
  TilesetBufferSource,
  residentSetEqual,
  tileKey,
  type DrivableTileset,
  type RunwayTileset,
} from '../src/scene/streaming-tile-source';

function tile(id: TileId): Tile {
  return {
    id,
    timeRange: { start: id.t, end: id.t + 1000 },
    layers: [],
  } as Tile;
}

const VIEWPORT = {
  bounds: { minLon: -1, minLat: -1, maxLon: 1, maxLat: 1 } as BoundingBox,
  zoom: 14,
  time: 5000,
};

/** A mock tileset whose visible set is controllable per-test. */
function mockTileset(initial: Tile[] = []): DrivableTileset & {
  updates: Array<{ bounds: BoundingBox; zoom: number; time: number; timeWindow: number }>;
  setVisible(t: Tile[]): void;
  clearCalls: number;
} {
  let visible = initial;
  const updates: Array<{
    bounds: BoundingBox;
    zoom: number;
    time: number;
    timeWindow: number;
  }> = [];
  let clearCalls = 0;
  return {
    updates,
    get clearCalls() {
      return clearCalls;
    },
    setVisible(t: Tile[]) {
      visible = t;
    },
    update(v) {
      updates.push(v);
      return 0;
    },
    getVisibleTiles() {
      return visible;
    },
    setAnimationState: vi.fn(),
    clear() {
      clearCalls++;
    },
  };
}

describe('tileKey / residentSetEqual', () => {
  it('keys by tile address (z/x/y/t)', () => {
    expect(tileKey(tile({ z: 14, x: 1, y: 2, t: 3 }))).toBe('14/1/2/3');
  });

  it('treats reordered same-address sets as equal', () => {
    const a = [tile({ z: 14, x: 0, y: 0, t: 0 }), tile({ z: 14, x: 1, y: 0, t: 0 })];
    const b = [a[1], a[0]];
    expect(residentSetEqual(a, b)).toBe(true);
  });

  it('detects added / removed tiles', () => {
    const a = [tile({ z: 14, x: 0, y: 0, t: 0 })];
    const b = [tile({ z: 14, x: 0, y: 0, t: 0 }), tile({ z: 14, x: 1, y: 0, t: 0 })];
    expect(residentSetEqual(a, b)).toBe(false);
    expect(residentSetEqual(b, a)).toBe(false);
  });

  it('distinguishes same length but different addresses', () => {
    const a = [tile({ z: 14, x: 0, y: 0, t: 0 })];
    const b = [tile({ z: 14, x: 9, y: 9, t: 9 })];
    expect(residentSetEqual(a, b)).toBe(false);
  });
});

describe('StreamingTileSource.update', () => {
  it('drives tileset.update with the viewport + a default time window', () => {
    const ts = mockTileset();
    const src = new StreamingTileSource({ url: 'x', timeWindowMs: 2000 });
    src.attachTileset(ts);

    src.update(VIEWPORT);

    expect(ts.updates).toHaveLength(1);
    expect(ts.updates[0]).toMatchObject({
      bounds: VIEWPORT.bounds,
      zoom: 14,
      time: 5000,
      timeWindow: 2000,
    });
  });

  it('honours an explicit per-viewport timeWindow over the default', () => {
    const ts = mockTileset();
    const src = new StreamingTileSource({ url: 'x', timeWindowMs: 2000 });
    src.attachTileset(ts);
    src.update({ ...VIEWPORT, timeWindow: 750 });
    expect(ts.updates[0].timeWindow).toBe(750);
  });

  it('is a no-op before a tileset is attached/loaded', () => {
    const src = new StreamingTileSource({ url: 'x' });
    expect(() => src.update(VIEWPORT)).not.toThrow();
    expect(src.getVisibleTiles()).toEqual([]);
  });

  it('fires onTilesChanged only when the resident set changes', () => {
    const t0 = [tile({ z: 14, x: 0, y: 0, t: 0 })];
    const ts = mockTileset(t0);
    const onTilesChanged = vi.fn();
    const src = new StreamingTileSource({ url: 'x', onTilesChanged });
    src.attachTileset(ts);

    // First update publishes the initial set.
    src.update(VIEWPORT);
    expect(onTilesChanged).toHaveBeenCalledTimes(1);
    expect(onTilesChanged).toHaveBeenLastCalledWith(t0);

    // Same resident set on the next update → no re-publish (replace-all is
    // suppressed when nothing changed).
    src.update({ ...VIEWPORT, time: 6000 });
    expect(onTilesChanged).toHaveBeenCalledTimes(1);

    // A new tile becomes resident → one more publish with the new set.
    const t1 = [...t0, tile({ z: 14, x: 1, y: 0, t: 0 })];
    ts.setVisible(t1);
    src.update({ ...VIEWPORT, time: 7000 });
    expect(onTilesChanged).toHaveBeenCalledTimes(2);
    expect(onTilesChanged).toHaveBeenLastCalledWith(t1);
  });

  it('forwards animation state and clears on dispose', () => {
    const ts = mockTileset();
    const src = new StreamingTileSource({ url: 'x' });
    src.attachTileset(ts);

    src.setAnimationState(true, 12.5);
    expect(ts.setAnimationState).toHaveBeenCalledWith(true, 12.5);

    src.dispose();
    expect(ts.clearCalls).toBe(1);
    // Post-dispose update is inert.
    src.update(VIEWPORT);
    expect(ts.updates).toHaveLength(0);
  });
});

describe('TilesetBufferSource', () => {
  it('delegates the full BufferSource surface to the tileset runway math', () => {
    const runway: CoreBufferedRunway = {
      simMs: 4200,
      bytesPending: 1024,
      horizonSimMs: 8000,
      complete: false,
    };
    const ranges = [{ start: 0, end: 1000 }];
    const cost = { bytes: 2048, tiles: 3 };

    const mock: RunwayTileset = {
      getBufferedRunway: vi.fn(() => runway),
      getBufferedRanges: vi.fn(() => ranges),
      estimateCost: vi.fn(() => cost),
      estimateTimeToReadyMs: vi.fn(() => 1500),
      flushPrefetch: vi.fn(),
      setAnimationState: vi.fn(),
    };
    const bs = new TilesetBufferSource(mock);

    expect(bs.getBufferedRunway(5000, 1, 8000)).toEqual(runway);
    expect(mock.getBufferedRunway).toHaveBeenCalledWith(5000, 1, 8000);

    expect(bs.getBufferedRanges({ maxRanges: 16 })).toEqual(ranges);
    expect(mock.getBufferedRanges).toHaveBeenCalledWith({ maxRanges: 16 });

    const range = { start: 0, end: 9000 };
    expect(bs.estimateCost(range)).toEqual(cost);
    expect(mock.estimateCost).toHaveBeenCalledWith(range);

    expect(bs.estimateTimeToReadyMs(range)).toBe(1500);
    expect(mock.estimateTimeToReadyMs).toHaveBeenCalledWith(range);

    bs.flushPrefetch();
    expect(mock.flushPrefetch).toHaveBeenCalledTimes(1);

    bs.setAnimationState(true, 3);
    expect(mock.setAnimationState).toHaveBeenCalledWith(true, 3);
  });

  it('reports a draining runway honestly (not the faked complete source)', () => {
    const mock: RunwayTileset = {
      getBufferedRunway: () => ({
        simMs: 200,
        bytesPending: 9999,
        horizonSimMs: 8000,
        complete: false,
      }),
      getBufferedRanges: () => [],
      estimateCost: () => ({ bytes: 9999, tiles: 5 }),
      estimateTimeToReadyMs: () => null,
      flushPrefetch: () => {},
    };
    const bs = new TilesetBufferSource(mock);
    const r = bs.getBufferedRunway(0, 1);
    expect(r.complete).toBe(false);
    expect(r.simMs).toBe(200);
    // The faked source would have reported Infinity / complete:true here.
    expect(r.simMs).not.toBe(Infinity);
  });
});

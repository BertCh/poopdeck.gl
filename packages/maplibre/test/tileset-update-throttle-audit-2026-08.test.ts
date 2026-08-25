/**
 * Tile-loading audit 2026-08, finding E2 (SEL-4 / LC-2): the maplibre backend
 * drove `tileset.update()` from EVERY `render()`, and the tileset's
 * identical-params fast path keys on the raw `timeRange`, so during playback
 * every drawn frame was a full selection pass (directory scans for the primary
 * + four parent levels, needed-set rebuild, supersession, eviction sweep).
 * deck was protected only by its own chassis throttle
 * (`spatiotemporal-layer.ts` `_handleTimeUpdate`: `timeWindow/20` of sim
 * travel AND a 100 ms wall floor). This pins the same rule on the maplibre
 * path, plus the two guarantees the throttle must not cost:
 *
 *  - a SPATIAL change (zoom / bounds / selection window) always drives at
 *    once — a throttle that delayed a pan would be a visible hole;
 *  - a blocked frame arms ONE trailing update, so the last tick of a paused
 *    clock (or a seek inside the window) is never lost.
 *
 * `performance.now()` and `setTimeout` are both faked so the wall clock is
 * deterministic; each "frame" advances it by one 60 Hz tick.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { Tile, TileId } from '@poopdeck.gl/core';
import { STTPointLayer } from '../src/layers/point-layer';
import { makeMockGl, makeMockMap } from './mock-gl';
import { makePointTile } from './fixtures';

const TIME = 1_700_000_001_000;
const FRAME_MS = 1000 / 60;

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: TIME,
  // Selection threshold = timeWindow / 20 = 250 ms of sim travel.
  timeWindow: 5000,
};

/** The archive surface `initTileset` consumes; selects nothing on its own. */
function makeStubArchive() {
  return {
    getMetadata: vi.fn(async () => ({
      minZoom: 0,
      maxZoom: 14,
      temporalBucketMs: 3_600_000,
    })),
    getTileIdsInBounds: vi.fn(() => [] as TileId[]),
    getTile: vi.fn(async () => null),
    getTiles: vi.fn(async (ids: TileId[]) => ids.map(() => null)),
    getTileByteSize: vi.fn(() => 4096),
    getThroughputEstimate: vi.fn(() => ({ bytesPerMs: 5, samples: 3 })),
    finalize: vi.fn(),
  };
}

/**
 * A point layer on a REAL tileset (stub archive) whose `update` is replaced
 * by a counting stub returning a fresh frame number per call — the real
 * selection pass (and its debounce timers) would otherwise run under the
 * fake clock, and its cost is exactly what this file is about, not its
 * output.
 */
async function mountLayer() {
  const gl = makeMockGl();
  const layer = new STTPointLayer({ ...baseOpts, id: 'p' } as never) as any;
  layer.gl = gl;
  layer.supports32BitIndices = true;
  layer.onContextReady(gl);
  layer.map = makeMockMap();
  layer.archive = makeStubArchive();
  await layer.initTileset();
  let frame = 0;
  const update = vi.fn(() => ++frame);
  layer.tileset.update = update;
  return { layer, gl, update };
}

function tileAt(id: Partial<TileId>): Tile {
  const tile = makePointTile();
  tile.id = { ...tile.id, ...id } as TileId;
  return tile;
}

/** One drawn frame: push the playhead, render, advance the wall clock a tick. */
function frame(layer: any, gl: any, t: number): void {
  layer.setCurrentTime(t);
  layer.render(gl, new Float32Array(16));
  vi.advanceTimersByTime(FRAME_MS);
}

let cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
  });
});
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
  vi.useRealTimers();
});

describe('E2 — tileset.update is throttled on the maplibre render path', () => {
  it('E2: 60 render() calls in one second with an advancing clock drive tileset.update at most 11 times', async () => {
    const { layer, gl, update } = await mountLayer();
    cleanup.push(() => layer.tileset.finalize());

    // Every frame advances the playhead by 1 s of sim time — well past the
    // 250 ms sim threshold — so ONLY the wall floor can hold the rate down.
    for (let i = 0; i < 60; i++) frame(layer, gl, TIME + i * 1000);

    // ≤ 1 per 100 ms wall plus the first frame; and not starved either — the
    // tileset must still track the playhead at ~10 Hz.
    expect(update.mock.calls.length).toBeLessThanOrEqual(11);
    expect(update.mock.calls.length).toBeGreaterThanOrEqual(9);
    // Every pass that did run carried the playhead of ITS frame, never a
    // quantized or stale one.
    const times = update.mock.calls.map((c: any[]) => c[0].time);
    for (const t of times) expect((t - TIME) % 1000).toBe(0);
  });

  it('E2: a spatial change inside the throttle window drives immediately', async () => {
    const { layer, gl, update } = await mountLayer();
    cleanup.push(() => layer.tileset.finalize());

    frame(layer, gl, TIME);
    expect(update).toHaveBeenCalledTimes(1);

    // 16 ms later, a tiny sim step: blocked on both axes…
    frame(layer, gl, TIME + 50);
    expect(update).toHaveBeenCalledTimes(1);

    // …but a zoom change is a new selection and must not wait.
    layer.map.getZoom = vi.fn(() => 3);
    frame(layer, gl, TIME + 60);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][0].zoom).toBe(3);

    // Likewise a camera pan with an unchanged zoom.
    layer.map = {
      ...layer.map,
      getBounds: vi.fn(() => ({
        getWest: () => -10,
        getSouth: () => -10,
        getEast: () => 10,
        getNorth: () => 10,
      })),
    };
    frame(layer, gl, TIME + 70);
    expect(update).toHaveBeenCalledTimes(3);
    expect(update.mock.calls[2][0].bounds).toEqual({
      minLon: -10,
      minLat: -10,
      maxLon: 10,
      maxLat: 10,
    });
  });

  it('E2: a paused-clock setTime inside the window gets exactly one trailing update', async () => {
    const { layer, gl, update } = await mountLayer();
    cleanup.push(() => layer.tileset.finalize());

    frame(layer, gl, TIME);
    expect(update).toHaveBeenCalledTimes(1);

    // A seek of 100 ms sim (under the 250 ms threshold) 16 ms of wall later,
    // then the clock stops: no further frames arrive on their own.
    layer.setCurrentTime(TIME + 100);
    layer.render(gl, new Float32Array(16));
    expect(update).toHaveBeenCalledTimes(1);

    // The trailing pass lands once the wall floor has elapsed, with the
    // playhead the clock actually stopped at…
    vi.advanceTimersByTime(200);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][0].time).toBe(TIME + 100);
    // …and it is the ONLY one: nothing keeps re-arming on a still clock.
    vi.advanceTimersByTime(2000);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('E2: a throttled frame still draws the resident set', async () => {
    const { layer, gl, update } = await mountLayer();
    cleanup.push(() => layer.tileset.finalize());

    const fine = tileAt({ z: 12, x: 655, y: 1583 });
    layer.tileset.getVisibleTiles = () => [fine];
    layer.refreshVisibleTiles();
    const drawTile = vi.spyOn(layer, 'drawTile').mockImplementation(() => {});

    frame(layer, gl, TIME);
    expect(update).toHaveBeenCalledTimes(1);
    expect(drawTile).toHaveBeenCalledTimes(1);

    // Blocked frame: no selection pass, but the draw still happens from
    // `loadedTiles`.
    frame(layer, gl, TIME + 50);
    expect(update).toHaveBeenCalledTimes(1);
    expect(drawTile).toHaveBeenCalledTimes(2);
    expect(drawTile.mock.calls[1][1]).toBe(fine);
  });

  it('E2: removing the layer cancels an armed trailing update', async () => {
    const { layer, gl, update } = await mountLayer();
    // onRemove finalizes and drops the tileset itself.
    cleanup.push(() => layer.tileset?.finalize());

    frame(layer, gl, TIME);
    layer.setCurrentTime(TIME + 100);
    layer.render(gl, new Float32Array(16));
    expect(update).toHaveBeenCalledTimes(1);

    layer.onRemove();
    vi.advanceTimersByTime(500);
    expect(update).toHaveBeenCalledTimes(1);
  });
});

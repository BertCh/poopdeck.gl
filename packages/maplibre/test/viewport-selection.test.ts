/**
 * Wave-2 A6 — what the maplibre adapter selects tiles WITH, and which of the
 * selected tiles it actually draws.
 *
 * Four defects, one per describe block
 * (docs/roadmap/tile-loading-3d-2026-07.md §5 Wave 2, A6):
 *
 *  1. `render()` walked the RESIDENT tile map. A tileset cache legitimately
 *     holds several zoom levels — `refinementStrategy: 'best-available'`
 *     fetches parents as fallbacks and eviction is lazy — so up to five levels
 *     of the same features were composited every frame, and `pick()` could
 *     answer with the coarse feature underneath the fine one on screen.
 *  2. There was no `tileLoadTimeWindow`, so the selection window could not be
 *     decoupled from the render window at all.
 *  3. The selection window ignored the time MODE. wake / trail / cumulative all
 *     draw into the PAST of the play head, and a window sized for the render
 *     pass evicts the tail while the shader is still asking for it.
 *  4. The camera box reached tile selection unnormalised. maplibre is the
 *     least-broken backend here (its `LngLatBounds` is ordered by construction)
 *     but the contract is that every backend routes through the one shared
 *     primitive and honours its `null`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  tileKey as coreTileKey,
  type Tile,
  type TileId,
} from '@poopdeck.gl/core';
import { STTPointLayer } from '../src/layers/point-layer';
import { STTTripsLayer } from '../src/layers/trips-layer';
import { STTHeatmapLayer } from '../src/layers/heatmap-layer';
import { widenLoadWindowForTimeMode } from '../src/base-layer';
import { SharedTilesetSource } from '../src/lib/streaming-source';
import { makeMockGl, makeMockMap } from './mock-gl';
import { makePointTile, seedResidentTiles } from './fixtures';

const TIME = 1_700_000_001_000;

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: TIME,
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

/** A point layer on a REAL tileset (stub archive), ready to render. */
async function mountLayer(extraOpts: Record<string, unknown> = {}) {
  const gl = makeMockGl();
  const layer = new STTPointLayer({
    ...baseOpts,
    id: 'p',
    ...extraOpts,
  } as never) as any;
  layer.gl = gl;
  layer.supports32BitIndices = true;
  layer.onContextReady(gl);
  layer.map = makeMockMap();
  layer.archive = makeStubArchive();
  await layer.initTileset();
  return { layer, gl };
}

/** `makePointTile` re-addressed, so two fixtures are two distinct tiles. */
function tileAt(id: Partial<TileId>): Tile {
  const tile = makePointTile();
  tile.id = { ...tile.id, ...id } as TileId;
  return tile;
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe('A6.1 — the drawn set is the VISIBLE set, not the resident cache', () => {
  it('a resident-but-not-visible tile is neither drawn nor picked', async () => {
    const { layer, gl } = await mountLayer();
    cleanup.push(() => layer.tileset.finalize());

    const coarse = tileAt({ z: 3, x: 1, y: 1 });
    const fine = tileAt({ z: 12, x: 655, y: 1583 });
    // The tileset has resolved the pile down to the fine tile: the coarse
    // parent is still resident (it was the fallback a moment ago) but is no
    // longer earning its keep.
    layer.tileset.getVisibleTiles = () => [fine];

    const options = layer.tileset.options;
    options.onTileLoad(coarse);
    options.onTileLoad(fine);
    // One coalesced re-derive at the end of the task, not one per arrival
    // (A6.1b) — a batch of tiles costs a single getVisibleTiles() walk.
    await Promise.resolve();

    expect([...layer.loadedTiles.values()]).toEqual([fine]);

    const drawTile = vi.spyOn(layer, 'drawTile').mockImplementation(() => {});
    layer.render(gl, new Float32Array(16));
    expect(drawTile).toHaveBeenCalledTimes(1);
    expect(drawTile.mock.calls[0][1]).toBe(fine);

    // …and the same set backs picking, so a click cannot resolve to the coarse
    // feature sitting underneath the one on screen.
    const provenance = layer.buildPickProvenance(gl);
    expect(provenance).toHaveLength(1);
    expect(provenance[0].tile).toBe(fine);
  });

  it('an eviction that promotes a parent back is picked up on the unload edge', async () => {
    const { layer } = await mountLayer();
    cleanup.push(() => layer.tileset.finalize());

    const coarse = tileAt({ z: 3, x: 1, y: 1 });
    const fine = tileAt({ z: 12, x: 655, y: 1583 });
    layer.tileset.getVisibleTiles = () => [fine];
    const options = layer.tileset.options;
    options.onTileLoad(coarse);
    options.onTileLoad(fine);
    await Promise.resolve();
    expect([...layer.loadedTiles.values()]).toEqual([fine]);

    // The fine tile is evicted; the parent is covering again. Neither edge is
    // expressible as a delete of the tile that moved — the set is re-derived
    // (once the task ends, so it reads the registry core actually left behind
    // rather than the one it is mid-way through mutating — see A6.1b).
    layer.tileset.getVisibleTiles = () => [coarse];
    options.onTileUnload(fine);
    await Promise.resolve();
    expect([...layer.loadedTiles.values()]).toEqual([coarse]);
  });

  it('re-derives only when the tileset frame number moves', async () => {
    const { layer, gl } = await mountLayer();
    cleanup.push(() => layer.tileset.finalize());
    const visible = vi.fn(() => [] as Tile[]);
    layer.tileset.getVisibleTiles = visible;
    // Pin the frame number: an unchanged one is the tileset's guarantee that
    // the visible set cannot have moved, which is what keeps the walk off the
    // render hot path.
    layer.tileset.update = vi.fn(() => 7);

    layer.render(gl, new Float32Array(16));
    layer.render(gl, new Float32Array(16));
    layer.render(gl, new Float32Array(16));
    expect(visible).toHaveBeenCalledTimes(1);

    layer.tileset.update = vi.fn(() => 8);
    layer.render(gl, new Float32Array(16));
    expect(visible).toHaveBeenCalledTimes(2);
  });
});

describe('A6.1b — the async edges re-derive AFTER core mutates its registry', () => {
  /**
   * The A6 unload handler re-derived the drawn set from `getVisibleTiles()`
   * INSIDE the callback. Core fires that callback with the header still in
   * `this.tiles` and only deletes it afterwards
   * (`spatiotemporal-tileset.ts` `evictTiles`), so the re-derive saw the
   * evicted tile as resident, re-published it, and the layer kept drawing a
   * tile whose GPU buffers the very same handler had just swept.
   */
  it('an evicted tile leaves the drawn set (core deletes the header AFTER the callback)', async () => {
    const { layer } = await mountLayer();
    cleanup.push(() => layer.tileset.finalize());

    const doomed = tileAt({ z: 12, x: 655, y: 1583 });
    const survivor = tileAt({ z: 12, x: 656, y: 1583 });
    seedResidentTiles(layer.tileset, doomed, survivor);
    layer.refreshVisibleTiles();
    expect(layer.loadedTiles.size).toBe(2);

    // Core's real eviction path — callback first, `tiles.delete` second.
    layer.tileset.evictTiles([coreTileKey(doomed.id)]);
    await Promise.resolve();

    expect([...layer.loadedTiles.values()]).toEqual([survivor]);
  });

  /**
   * `clear()` fires `onTileUnload` for EVERY header before `tiles.clear()` and
   * before `neededTileKeys.clear()`, so a re-derive from inside the callback
   * returns the full set every time. The handler swept every GPU cache entry
   * and then left `loadedTiles` fully populated — every subsequent frame
   * re-uploaded buffers for tiles the tileset no longer holds.
   */
  it('tileset.clear() empties the drawn set instead of leaving it fully populated', async () => {
    const { layer } = await mountLayer();
    cleanup.push(() => layer.tileset.finalize());

    seedResidentTiles(
      layer.tileset,
      tileAt({ z: 12, x: 655, y: 1583 }),
      tileAt({ z: 12, x: 656, y: 1583 }),
    );
    layer.refreshVisibleTiles();
    expect(layer.loadedTiles.size).toBe(2);

    layer.tileset.clear();
    await Promise.resolve();

    expect(layer.loadedTiles.size).toBe(0);
    expect(layer.tileGpuCache.size).toBe(0);
  });

  /**
   * Tiles arrive in BATCHES (the range coalescer delivers a whole coalesced
   * group), and the per-arrival re-derive walked `neededTileKeys` three times
   * plus a descendant recursion and allocated a fresh Map — once per tile.
   */
  it('a batch of arrivals costs ONE visible-set walk, not one per tile', async () => {
    const { layer } = await mountLayer();
    cleanup.push(() => layer.tileset.finalize());

    const visible = vi.fn(() => [] as Tile[]);
    layer.tileset.getVisibleTiles = visible;
    const options = layer.tileset.options;
    for (let i = 0; i < 8; i++) options.onTileLoad(tileAt({ x: 100 + i }));

    expect(visible).not.toHaveBeenCalled(); // coalesced, not eager
    await Promise.resolve();
    expect(visible).toHaveBeenCalledTimes(1);
  });

  /**
   * Deferring must never let a frame paint the stale set: `render()` flushes
   * any pending re-derive before it walks `loadedTiles`.
   */
  it('a frame drawn before the microtask still draws the corrected set', async () => {
    const { layer, gl } = await mountLayer();
    cleanup.push(() => layer.tileset.finalize());

    // Pin the frame number so the render-path frame gate is ALREADY satisfied:
    // this is the steady state (a settled camera), where the only thing that
    // can correct the drawn set is the unload edge itself. Pinning also keeps
    // the real selection pass (and its debounce) from clobbering the seed.
    layer.tileset.update = vi.fn(() => 5);
    layer.render(gl, new Float32Array(16));

    const doomed = tileAt({ z: 12, x: 655, y: 1583 });
    const survivor = tileAt({ z: 12, x: 656, y: 1583 });
    seedResidentTiles(layer.tileset, doomed, survivor);
    layer.refreshVisibleTiles();

    layer.tileset.evictTiles([coreTileKey(doomed.id)]);
    // No microtask checkpoint — this is the synchronous same-task frame.
    const drawTile = vi.spyOn(layer, 'drawTile').mockImplementation(() => {});
    layer.render(gl, new Float32Array(16));

    expect(drawTile).toHaveBeenCalledTimes(1);
    expect(drawTile.mock.calls[0][1]).toBe(survivor);
  });

  /**
   * The other way into `loadedTiles` outside the render pass: a pick issued
   * from a `mousemove` handler, which can be the first thing to run after an
   * eviction and would otherwise resolve to a tile no longer on screen.
   */
  it('a pick issued before the microtask does not resolve to the evicted tile', async () => {
    const { layer, gl } = await mountLayer();
    cleanup.push(() => layer.tileset.finalize());
    layer.tileset.update = vi.fn(() => 5);
    layer.render(gl, new Float32Array(16));

    const doomed = tileAt({ z: 12, x: 655, y: 1583 });
    const survivor = tileAt({ z: 12, x: 656, y: 1583 });
    seedResidentTiles(layer.tileset, doomed, survivor);
    layer.refreshVisibleTiles();

    layer.tileset.evictTiles([coreTileKey(doomed.id)]);
    layer.pick(10, 10);

    expect([...layer.loadedTiles.values()]).toEqual([survivor]);
  });

  /**
   * The unload edge never asked for a frame before — survivable only because
   * the eager re-derive left the doomed tile drawn. Now that it really leaves,
   * an idle (non-animating) host has to be woken. Guarded on a REAL change so
   * evictions of tiles that were not on screen cannot keep that host awake.
   */
  it('asks for a frame on the unload edge only when the drawn set moved', async () => {
    const { layer } = await mountLayer();
    cleanup.push(() => layer.tileset.finalize());

    const doomed = tileAt({ z: 12, x: 655, y: 1583 });
    const survivor = tileAt({ z: 12, x: 656, y: 1583 });
    seedResidentTiles(layer.tileset, doomed, survivor);
    layer.refreshVisibleTiles();
    layer.map.triggerRepaint.mockClear();

    layer.tileset.evictTiles([coreTileKey(doomed.id)]);
    await Promise.resolve();
    expect(layer.map.triggerRepaint).toHaveBeenCalledTimes(1);

    // An eviction the visible set does not notice (a resident tile that was
    // not earning its keep) must not.
    layer.map.triggerRepaint.mockClear();
    layer.tileset.getVisibleTiles = () => [survivor];
    layer.tileset.options.onTileUnload(tileAt({ z: 3, x: 1, y: 1 }));
    await Promise.resolve();
    expect(layer.map.triggerRepaint).not.toHaveBeenCalled();
  });
});

describe('A6.2/3 — the SELECTION window (tileLoadTimeWindow + time modes)', () => {
  it('follows timeWindow when nothing widens it', async () => {
    const { layer, gl } = await mountLayer();
    cleanup.push(() => layer.tileset.finalize());
    const update = vi.spyOn(layer.tileset, 'update');
    layer.render(gl, new Float32Array(16));
    expect(layer.getEffectiveTimeWindow()).toBe(5000);
    expect(update.mock.calls[0][0].timeWindow).toBe(5000);
  });

  it('tileLoadTimeWindow widens SELECTION only — the render window is untouched', async () => {
    const { layer, gl } = await mountLayer({ tileLoadTimeWindow: 60_000 });
    cleanup.push(() => layer.tileset.finalize());
    const update = vi.spyOn(layer.tileset, 'update');
    const drawTile = vi.spyOn(layer, 'drawTile').mockImplementation(() => {});
    layer.tileset.getVisibleTiles = () => [makePointTile()];

    layer.render(gl, new Float32Array(16));

    expect(update.mock.calls[0][0].timeWindow).toBe(60_000);
    const ctx = drawTile.mock.calls[0][4] as {
      windowStart: number;
      windowEnd: number;
    };
    // Still ±timeWindow/2 about the play head, in tile-relative time.
    expect(ctx.windowEnd - ctx.windowStart).toBe(5000);
  });

  it('is a Math.max floor, never a `??` — a smaller or zero value cannot win', async () => {
    const { layer } = await mountLayer({ tileLoadTimeWindow: 1000 });
    cleanup.push(() => layer.tileset.finalize());
    expect(layer.getEffectiveTimeWindow()).toBe(5000);

    layer.setTileLoadTimeWindow(0);
    expect(layer.getEffectiveTimeWindow()).toBe(5000);

    layer.setTileLoadTimeWindow(9000);
    expect(layer.getEffectiveTimeWindow()).toBe(9000);
  });

  it('wake mode selects 2× the wake, so the tail is never evicted mid-draw', async () => {
    const { layer } = await mountLayer({
      timeFilterMode: 'wake',
      wakeLength: 30_000,
    });
    cleanup.push(() => layer.tileset.finalize());
    // The loader window is SYMMETRIC, so covering 30 s of past wake needs 60 s.
    expect(layer.getEffectiveTimeWindow()).toBe(60_000);
  });

  it('a degraded mode (wakeLength 0) widens nothing', async () => {
    const { layer } = await mountLayer({
      timeFilterMode: 'wake',
      wakeLength: 0,
      trailLength: 40_000,
    });
    cleanup.push(() => layer.tileset.finalize());
    // The shader fell back to plain window mode, so the trail knob is inert
    // and must not buy resident tiles nothing is drawing.
    expect(layer.getEffectiveTimeWindow()).toBe(5000);
  });

  it('trail mode selects 2× the trail', async () => {
    const { layer } = await mountLayer({
      timeFilterMode: 'trail',
      trailLength: 40_000,
    });
    cleanup.push(() => layer.tileset.finalize());
    expect(layer.getEffectiveTimeWindow()).toBe(80_000);
  });

  it('cumulative mode spans the whole timeRange from any play-head position', async () => {
    const { layer } = await mountLayer({
      timeFilterMode: 'cumulative',
      timeRange: { start: TIME, end: TIME + 600_000 },
    });
    cleanup.push(() => layer.tileset.finalize());
    expect(layer.getEffectiveTimeWindow()).toBe(1_200_000);
  });

  it('cumulative without a timeRange honours the caller window as-is', async () => {
    const { layer } = await mountLayer({ timeFilterMode: 'cumulative' });
    cleanup.push(() => layer.tileset.finalize());
    // The span is unknowable here; the documented caller obligation stands.
    expect(layer.getEffectiveTimeWindow()).toBe(5000);
  });

  it('trips sizes against its DEFAULTED 180 s trail, not the absent raw option', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' } as never) as any;
    expect(layer.opts.trailLength).toBeUndefined();
    expect(layer.getEffectiveTimeWindow()).toBe(360_000);

    // wake wins over trail (deck's precedence) and re-sizes the window.
    const wake = new STTTripsLayer({
      ...baseOpts,
      id: 't',
      wakeLength: 300_000,
    } as never) as any;
    expect(wake.getEffectiveTimeWindow()).toBe(600_000);
  });

  it('heatmap sizes against the RESOLVED mode, not its defaulted trailLength', () => {
    // `trailLength` defaults to the whole timeWindow here, but window mode does
    // not draw a trail — widening for it would buy tiles nothing reads.
    const windowed = new STTHeatmapLayer({
      ...baseOpts,
      id: 'h',
      timeWindow: 20_000,
    } as never) as any;
    expect(windowed.heatOpts.trailLength).toBe(20_000);
    expect(windowed.getEffectiveTimeWindow()).toBe(20_000);

    const trailing = new STTHeatmapLayer({
      ...baseOpts,
      id: 'h',
      timeWindow: 20_000,
      timeFilterMode: 'trail',
    } as never) as any;
    expect(trailing.getEffectiveTimeWindow()).toBe(40_000);
  });

  it('the kernel composes floors in any order', () => {
    expect(
      widenLoadWindowForTimeMode(1000, { mode: 'wake', wakeLength: 10_000 }),
    ).toBe(20_000);
    // A base already wider than the mode requires is kept.
    expect(
      widenLoadWindowForTimeMode(90_000, { mode: 'wake', wakeLength: 10_000 }),
    ).toBe(90_000);
    // No explicit mode ⇒ inferred in deck's precedence (wake before trail).
    expect(
      widenLoadWindowForTimeMode(0, { wakeLength: 5000, trailLength: 90_000 }),
    ).toBe(10_000);
  });
});

describe('A6.3 — the shared source composes windows with Math.max', () => {
  function makeSource(timeWindowMs?: number) {
    const update = vi.fn(() => 1);
    const source = new SharedTilesetSource('mem://shared.stt', {
      timeWindowMs,
    });
    source.attachTileset(
      { update, getVisibleTiles: () => [] } as never,
      {
        minZoom: 0,
        maxZoom: 14,
        temporalBucketMs: 3_600_000,
      } as never,
    );
    return { source, update };
  }

  const viewport = {
    bounds: { minLon: -10, minLat: -10, maxLon: 10, maxLat: 10 },
    zoom: 3,
    time: TIME,
  };

  it('a caller-supplied 0 cannot collapse the shared selection window', () => {
    const { source, update } = makeSource(5000);
    source.update({ ...viewport, timeWindow: 0 });
    // `??` treated 0 as "supplied" and passed it straight through, selecting a
    // single instant for EVERY layer on the shared source.
    expect(update.mock.calls[0][0].timeWindow).toBe(5000);
  });

  it('a wider caller window still wins', () => {
    const { source, update } = makeSource(5000);
    source.update({ ...viewport, timeWindow: 60_000 });
    expect(update.mock.calls[0][0].timeWindow).toBe(60_000);
  });

  it('an omitted window falls back to the configured value, then the bucket', () => {
    const configured = makeSource(5000);
    configured.source.update(viewport);
    expect(configured.update.mock.calls[0][0].timeWindow).toBe(5000);

    const unconfigured = makeSource();
    unconfigured.source.update(viewport);
    expect(unconfigured.update.mock.calls[0][0].timeWindow).toBe(3_600_000);
  });

  /** A source with NOTHING configured: no `timeWindowMs`, no metadata bucket. */
  function makeBareSource() {
    const update = vi.fn(() => 1);
    const source = new SharedTilesetSource('mem://bare.stt');
    source.attachTileset({ update, getVisibleTiles: () => [] } as never);
    return { source, update };
  }

  it('the last-resort hour is a DEFAULT, never a floor on an explicit request', () => {
    const { source, update } = makeBareSource();
    source.update({ ...viewport, timeWindow: 5000 });
    // The `??` chain fed the 1-hour literal into the same `Math.max` as the
    // two CONFIGURED values, so an unconfigured source silently selected
    // 720× the window the caller asked for — an hour of buckets per frame on
    // a demo whose whole point is a 5 s slice.
    expect(update.mock.calls[0][0].timeWindow).toBe(5000);
  });

  it('…and still supplies the hour when the caller omits the window entirely', () => {
    const { source, update } = makeBareSource();
    source.update(viewport);
    expect(update.mock.calls[0][0].timeWindow).toBe(3_600_000);
  });
});

describe('A6.4 — the camera box goes through normalizeViewportBounds', () => {
  /** A map whose `getBounds()` reports exactly what the test asks for. */
  function mapReporting(b: {
    west: number;
    south: number;
    east: number;
    north: number;
  }) {
    return {
      triggerRepaint: vi.fn(),
      getZoom: vi.fn(() => 4),
      getBounds: vi.fn(() => ({
        getWest: () => b.west,
        getSouth: () => b.south,
        getEast: () => b.east,
        getNorth: () => b.north,
      })),
    };
  }

  it('orders an inverted latitude box instead of selecting zero tiles', async () => {
    const { layer, gl } = await mountLayer();
    cleanup.push(() => layer.tileset.finalize());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const update = vi.spyOn(layer.tileset, 'update');
    layer.map = mapReporting({ west: -10, south: 40, east: 10, north: 10 });

    layer.render(gl, new Float32Array(16));

    // Unrepaired, `boundsToTiles`' row loop never executes — zero tiles, while
    // every readiness signal reports settled and fully buffered.
    expect(update.mock.calls[0][0].bounds).toEqual({
      minLon: -10,
      minLat: 10,
      maxLon: 10,
      maxLat: 40,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('inverted-lat');
    warn.mockRestore();
  });

  it('keeps the PREVIOUS viewport when the camera reports a non-finite box', async () => {
    const { layer, gl } = await mountLayer();
    cleanup.push(() => layer.tileset.finalize());
    const update = vi.spyOn(layer.tileset, 'update');

    layer.map = mapReporting({ west: -30, south: -20, east: -10, north: 20 });
    layer.render(gl, new Float32Array(16));
    const good = update.mock.calls[0][0].bounds;

    layer.map = mapReporting({
      west: Number.NaN,
      south: -20,
      east: -10,
      north: 20,
    });
    layer.render(gl, new Float32Array(16));

    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][0].bounds).toEqual(good);
  });

  it('leaves an antimeridian CROSSING box encoded as minLon > maxLon', async () => {
    const { layer, gl } = await mountLayer();
    cleanup.push(() => layer.tileset.finalize());
    const update = vi.spyOn(layer.tileset, 'update');
    layer.map = mapReporting({ west: 170, south: -10, east: -170, north: 10 });

    layer.render(gl, new Float32Array(16));

    // Re-clamping into [-180, 180] here is the exact regression `ais-all-us`
    // and `drifters` were fixed for: the core scan walks unwrapped column
    // space and wraps at emit.
    expect(update.mock.calls[0][0].bounds.minLon).toBe(170);
    expect(update.mock.calls[0][0].bounds.maxLon).toBe(-170);
  });

  it('says nothing about a plain whole-world camera', async () => {
    const { layer, gl } = await mountLayer();
    cleanup.push(() => layer.tileset.finalize());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // west −180 / east +180 is a 360° span, which the primitive reports as a
    // `full-world` normalisation. It is not a defect and must not warn, or the
    // channel trains the reader to ignore it.
    layer.map = makeMockMap();
    layer.render(gl, new Float32Array(16));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

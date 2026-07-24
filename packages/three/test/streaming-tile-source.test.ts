import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BufferedRunway as CoreBufferedRunway } from '@poopdeck.gl/core';
import {
  StreamingTileSource,
  TilesetBufferSource,
  residentSetEqual,
  tileKey,
  type RunwayTileset,
} from '../src/scene/streaming-tile-source';
import { mockTileset, tile, VIEWPORT } from './_support/streaming';

// Shared capture across the hoisted `@poopdeck.gl/core` mock and the assertions:
// the `.load()` path builds a real `SpatiotemporalTileset` from an archive URL,
// so to prove the knob forwarding reaches the constructor we stub the archive +
// tileset and record every constructor option object. The REAL core adapter
// (`@poopdeck.gl/core/tileset-adapter`, a different specifier) is left unmocked,
// so summary-tier dispatch is exercised end-to-end.
const h = vi.hoisted(() => ({
  /** One entry per `new SpatiotemporalTileset(opts)` — the captured options. */
  ctorOpts: [] as Array<Record<string, unknown>>,
  /** One entry per `preloadOverviewTier(opts)` call. */
  preloadCalls: [] as Array<unknown>,
  /** Metadata the fake archive returns from `getMetadata()` (per test). */
  metadata: { current: null as unknown },
}));

vi.mock('@poopdeck.gl/core', () => {
  class FakeArchive {
    constructor(_opts: unknown) {}
    getMetadata(): Promise<unknown> {
      return Promise.resolve(h.metadata.current);
    }
    finalize(): void {}
    // Referenced (never called) by the real tileset-adapter closures.
    getTileIdsInBounds(): Promise<unknown[]> {
      return Promise.resolve([]);
    }
    getTile(): Promise<unknown> {
      return Promise.resolve(null);
    }
    getTiles(): Promise<unknown[]> {
      return Promise.resolve([]);
    }
    getTileByteSize(): number | undefined {
      return undefined;
    }
    getThroughputEstimate(): { bytesPerMs: number | null; samples: number } {
      return { bytesPerMs: null, samples: 0 };
    }
    setSchedulerWeight(): void {}
    getSummaryTileIdsInBounds(): Promise<unknown[]> {
      return Promise.resolve([]);
    }
  }
  class FakeTileset {
    constructor(opts: Record<string, unknown>) {
      h.ctorOpts.push(opts);
    }
    getVisibleTiles(): unknown[] {
      return [];
    }
    preloadOverviewTier(opts?: unknown): Promise<unknown> {
      h.preloadCalls.push(opts ?? null);
      return Promise.resolve({ loaded: true, bytes: 0, tiles: 0 });
    }
    setInteractive(): void {}
    setAnimationState(): void {}
    clear(): void {}
  }
  return { STTArchive: FakeArchive, SpatiotemporalTileset: FakeTileset };
});

describe('tileKey / residentSetEqual', () => {
  it('keys by tile address (z/x/y/t)', () => {
    expect(tileKey(tile({ z: 14, x: 1, y: 2, t: 3 }))).toBe('14/1/2/3');
  });

  it('treats reordered same-address sets as equal', () => {
    const a = [
      tile({ z: 14, x: 0, y: 0, t: 0 }),
      tile({ z: 14, x: 1, y: 0, t: 0 }),
    ];
    const b = [a[1], a[0]];
    expect(residentSetEqual(a, b)).toBe(true);
  });

  it('detects added / removed tiles', () => {
    const a = [tile({ z: 14, x: 0, y: 0, t: 0 })];
    const b = [
      tile({ z: 14, x: 0, y: 0, t: 0 }),
      tile({ z: 14, x: 1, y: 0, t: 0 }),
    ];
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

  it('forwards the interactive/scrub bit to the tileset (scrub-LOD P0)', () => {
    const ts = mockTileset();
    const src = new StreamingTileSource({ url: 'x' });
    src.attachTileset(ts);

    src.setInteractive(true);
    expect(ts.setInteractive).toHaveBeenCalledWith(true);
    src.setInteractive(false);
    expect(ts.setInteractive).toHaveBeenLastCalledWith(false);
  });

  it('passes a per-viewport timeWindow straight through (render-window coupling)', () => {
    // The r3f pump derives this from the layer's render window; the source must
    // hand it to the tileset verbatim (it is the SELECTION window), overriding
    // the archive/temporal-bucket default.
    const ts = mockTileset();
    const src = new StreamingTileSource({ url: 'x', timeWindowMs: 2000 });
    src.attachTileset(ts);
    src.update({ ...VIEWPORT, timeWindow: 86_400_000 });
    expect(ts.updates[0].timeWindow).toBe(86_400_000);
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

  it('forwards setInteractive to the tileset (governor scrub bracket)', () => {
    const setInteractive = vi.fn();
    const mock: RunwayTileset = {
      getBufferedRunway: () => ({
        simMs: 0,
        bytesPending: 0,
        horizonSimMs: 0,
        complete: true,
      }),
      getBufferedRanges: () => [],
      estimateCost: () => ({ bytes: 0, tiles: 0 }),
      estimateTimeToReadyMs: () => null,
      flushPrefetch: () => {},
      setInteractive,
    };
    const bs = new TilesetBufferSource(mock);
    bs.setInteractive(true);
    expect(setInteractive).toHaveBeenCalledWith(true);
    bs.setInteractive(false);
    expect(setInteractive).toHaveBeenLastCalledWith(false);
  });
});

describe('StreamingTileSource.load (knob forwarding + summary dispatch)', () => {
  beforeEach(() => {
    h.ctorOpts.length = 0;
    h.preloadCalls.length = 0;
    h.metadata.current = null;
  });

  const summaryTierMeta = {
    minZoom: 0,
    maxZoom: 10,
    temporalBucketMs: 1000,
    summaryTier: {
      scheme: 'h3',
      minZoom: 0,
      maxZoom: 5,
      cellResolutionPerZoom: [],
      columns: [],
      layerName: 'summary',
    },
  };

  it('forwards the full knob set into the tileset constructor', async () => {
    h.metadata.current = { minZoom: 0, maxZoom: 10, temporalBucketMs: 1000 };
    const src = new StreamingTileSource({
      url: 'x',
      debounceTime: 42,
      prefetchAhead: 12_345,
      prefetchSteps: 7,
      tier: 'auto',
      maxRequests: 9,
      maxCacheSize: 111,
      maxCacheByteSize: 222,
      enablePrefetch: false,
      scrubLod: { spatial: true, spatialZoomDrop: 3 },
    });
    await src.load();

    expect(h.ctorOpts).toHaveLength(1);
    expect(h.ctorOpts[0]).toMatchObject({
      debounceTime: 42,
      prefetchAhead: 12_345,
      prefetchSteps: 7,
      tier: 'auto',
      maxRequests: 9,
      maxCacheSize: 111,
      maxCacheByteSize: 222,
      enablePrefetch: false,
      scrubLod: { spatial: true, spatialZoomDrop: 3 },
    });
  });

  it('derives summaryZoomRange + wires getAvailableSummaryTiles from the tier', async () => {
    h.metadata.current = summaryTierMeta;
    const src = new StreamingTileSource({ url: 'x' });
    await src.load();

    const o = h.ctorOpts[0];
    expect(o.summaryZoomRange).toEqual({ minZoom: 0, maxZoom: 5 });
    expect(typeof o.getAvailableSummaryTiles).toBe('function');
  });

  it('omits summary dispatch for a raw-only archive (additive no-op)', async () => {
    h.metadata.current = { minZoom: 0, maxZoom: 10, temporalBucketMs: 1000 };
    const src = new StreamingTileSource({ url: 'x' });
    await src.load();

    const o = h.ctorOpts[0];
    expect(o.summaryZoomRange).toBeUndefined();
    expect(o.getAvailableSummaryTiles).toBeUndefined();
  });

  it('honours an explicit summaryZoomRange override', async () => {
    h.metadata.current = summaryTierMeta;
    const src = new StreamingTileSource({
      url: 'x',
      summaryZoomRange: { minZoom: 1, maxZoom: 3 },
    });
    await src.load();

    expect(h.ctorOpts[0].summaryZoomRange).toEqual({ minZoom: 1, maxZoom: 3 });
  });

  it('kicks preloadOverviewTier only when overviewPreload is set', async () => {
    h.metadata.current = { minZoom: 0, maxZoom: 10 };
    const a = new StreamingTileSource({ url: 'x' });
    await a.load();
    expect(h.preloadCalls).toHaveLength(0);

    const b = new StreamingTileSource({
      url: 'y',
      overviewPreload: { budgetBytes: 123, maxZoom: 2 },
    });
    await b.load();
    expect(h.preloadCalls).toEqual([{ budgetBytes: 123, maxZoom: 2 }]);
  });
});

/**
 * `SpatioTemporalTileset.setOptions()` — post-construction option changes.
 *
 * Upstream `TileLayer.updateState` calls `tileset.setOptions(...)` on every
 * `propsChanged` pass; the STT chassis could not, so twelve props were frozen
 * at build time and a post-mount change silently did nothing (the layer warned
 * instead). These tests pin the OBSERVABLE effect of each one — never "the
 * field was written", always "the tileset now behaves differently":
 *
 *   tier / lodMode / refinementStrategy → which tiles selection asks for
 *   maxCacheSize / maxCacheByteSize     → tiles evicted immediately
 *   maxRequests                         → more requests dispatch at once, and
 *                                         the loader's own cap is re-set
 *   debounceTime                        → a PENDING debounce re-arms
 *   enablePrefetch / prefetchAhead / prefetchSteps → the planned runway
 *   scrubLod                            → the degraded motion tier
 *
 * The twelfth prop, `loadOptions`, is an ARCHIVE option that no tileset
 * option maps to (it builds the archive's fetch transport), so it cannot ride
 * `setOptions` at all — `STTArchive.setLoadOptions` is its live setter and is
 * covered at the bottom of this file.
 */

import { describe, it, expect, vi } from 'vitest';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import { STTArchive } from '../src/archive';
import type { BoundingBox, TileId } from '../src/types';
import { BOUNDS, BUCKET_MS, fakeTile, settle } from './helpers/fixtures';
import { packedFromGolden, packedFetch } from './helpers/packed-fixture';

/** Enough buckets that a wide time window selects a dozen tiles. */
const N_BUCKETS = 40;

interface Recorded {
  zoom: number;
  range: { start: number; end: number };
}

interface HarnessOptions {
  tier?: 'raw' | 'summary' | 'auto';
  lodMode?: 'parent-fallback' | 'additive';
  refinementStrategy?: 'best-available' | 'no-overlap';
  enablePrefetch?: boolean;
  prefetchAhead?: number;
  prefetchSteps?: number;
  maxRequests?: number;
  debounceTime?: number;
  /** Omit the batch callback to exercise the per-tile (slot-counted) path. */
  perTile?: boolean;
  /** Never-resolving tile fetches, so in-flight counts stay observable. */
  hangingLoads?: boolean;
  withSummaryTier?: boolean;
  setMaxConcurrentRequests?: (n: number) => void;
}

/**
 * One tile per bucket at (x=0, y=0) for the queried zoom, filtered to the
 * requested range — the single-cell synthetic archive the tileset suites use.
 */
function tilesForRange(
  zoom: number,
  range: { start: number; end: number },
): TileId[] {
  const ids: TileId[] = [];
  for (let i = 0; i < N_BUCKETS; i++) {
    const t = i * BUCKET_MS;
    if (t + BUCKET_MS >= range.start && t <= range.end)
      ids.push({ z: zoom, x: 0, y: 0, t });
  }
  return ids;
}

function makeHarness(opts: HarnessOptions = {}) {
  const rawCalls: Recorded[] = [];
  const summaryCalls: Recorded[] = [];
  const tileLoads: TileId[] = [];

  const tileset = new SpatioTemporalTileset({
    minZoom: 0,
    maxZoom: 12,
    temporalBucketMs: BUCKET_MS,
    enablePrefetch: opts.enablePrefetch ?? false,
    prefetchAhead: opts.prefetchAhead,
    prefetchSteps: opts.prefetchSteps,
    maxRequests: opts.maxRequests,
    debounceTime: opts.debounceTime,
    tier: opts.tier,
    lodMode: opts.lodMode,
    refinementStrategy: opts.refinementStrategy ?? 'no-overlap',
    summaryZoomRange: opts.withSummaryTier
      ? { minZoom: 0, maxZoom: 5 }
      : undefined,
    getAvailableTiles: async (_b: BoundingBox, zoom, range) => {
      rawCalls.push({ zoom, range: { ...range } });
      return tilesForRange(zoom, range);
    },
    getAvailableSummaryTiles: opts.withSummaryTier
      ? async (_b: BoundingBox, zoom, range) => {
          summaryCalls.push({ zoom, range: { ...range } });
          return tilesForRange(zoom, range);
        }
      : undefined,
    getTileData: async (id: TileId) => {
      tileLoads.push(id);
      if (opts.hangingLoads) return new Promise<never>(() => {});
      return fakeTile(id);
    },
    getTileDataBatch: opts.perTile
      ? undefined
      : async (ids: TileId[]) => ids.map((id) => fakeTile(id)),
    setMaxConcurrentRequests: opts.setMaxConcurrentRequests,
  });

  return { tileset, rawCalls, summaryCalls, tileLoads };
}

/** Distinct zooms a selection pass queried since `from`. */
const zoomsSince = (calls: Recorded[], from: number): number[] =>
  [...new Set(calls.slice(from).map((c) => c.zoom))].sort((a, b) => a - b);

// ---------------------------------------------------------------------------
// Selection policy: tier / lodMode / refinementStrategy
// ---------------------------------------------------------------------------

describe('setOptions: selection policy', () => {
  it('tier re-dispatches selection to the summary callback', async () => {
    const h = makeHarness({ tier: 'raw', withSummaryTier: true });
    h.tileset.update({
      bounds: BOUNDS,
      zoom: 3,
      time: 500,
      timeWindow: 100,
    });
    await settle();
    expect(h.rawCalls.length).toBeGreaterThan(0);
    expect(h.summaryCalls).toHaveLength(0);

    // No update() — setOptions alone must re-run selection.
    h.tileset.setOptions({ tier: 'summary' });
    await settle();
    expect(h.summaryCalls.length).toBeGreaterThan(0);
    expect(h.summaryCalls[0].zoom).toBe(3);
  });

  it('tier reuses resident tiles (documented: selection policy, not payload)', async () => {
    const h = makeHarness({ tier: 'raw', withSummaryTier: true });
    h.tileset.update({ bounds: BOUNDS, zoom: 3, time: 500, timeWindow: 100 });
    await settle();
    const before = h.tileset.getCacheStats().tileCount;
    expect(before).toBeGreaterThan(0);

    h.tileset.setOptions({ tier: 'summary' });
    await settle();
    // Same (z, x, y, t) addresses → the cache survives; nothing re-fetched.
    expect(h.tileset.getCacheStats().tileCount).toBe(before);
    expect(h.tileLoads).toHaveLength(0); // batch path served them
  });

  it('lodMode: additive widens selection to the full zoom union', async () => {
    const h = makeHarness({
      lodMode: 'parent-fallback',
      refinementStrategy: 'best-available',
    });
    h.tileset.update({ bounds: BOUNDS, zoom: 8, time: 500, timeWindow: 100 });
    await settle();
    // parent-fallback: primary + PARENT_FALLBACK_LEVELS (4) parents.
    expect(zoomsSince(h.rawCalls, 0)).toEqual([4, 5, 6, 7, 8]);

    const mark = h.rawCalls.length;
    h.tileset.setOptions({ lodMode: 'additive' });
    await settle();
    // additive: the WHOLE union [minZoom..zoom] is now selected.
    expect(zoomsSince(h.rawCalls, mark)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('refinementStrategy: no-overlap drops the parent fallbacks', async () => {
    const h = makeHarness({ refinementStrategy: 'best-available' });
    h.tileset.update({ bounds: BOUNDS, zoom: 8, time: 500, timeWindow: 100 });
    await settle();
    expect(zoomsSince(h.rawCalls, 0)).toEqual([4, 5, 6, 7, 8]);

    const mark = h.rawCalls.length;
    h.tileset.setOptions({ refinementStrategy: 'no-overlap' });
    await settle();
    expect(zoomsSince(h.rawCalls, mark)).toEqual([8]);
  });

  it('scrubLod: enabling the spatial axis degrades the live selection', async () => {
    const h = makeHarness();
    h.tileset.update({ bounds: BOUNDS, zoom: 6, time: 500, timeWindow: 100 });
    await settle();
    // Kill switch: the motion bit alone changes nothing.
    h.tileset.setInteractive(true);
    await settle();
    expect(zoomsSince(h.rawCalls, 0)).toEqual([6]);

    const mark = h.rawCalls.length;
    h.tileset.setOptions({ scrubLod: { spatial: true, spatialZoomDrop: 2 } });
    await settle();
    expect(zoomsSince(h.rawCalls, mark)).toEqual([4]);

    // ...and `undefined` resets it to the constructor default (axes off).
    const mark2 = h.rawCalls.length;
    h.tileset.setOptions({ scrubLod: undefined });
    await settle();
    expect(zoomsSince(h.rawCalls, mark2)).toEqual([6]);
  });

  it('an equal-but-fresh scrubLod literal is a no-op (no reselection)', async () => {
    const h = makeHarness();
    h.tileset.update({ bounds: BOUNDS, zoom: 6, time: 500, timeWindow: 100 });
    await settle();
    h.tileset.setInteractive(true);
    h.tileset.setOptions({ scrubLod: { spatial: true } });
    await settle();

    const mark = h.rawCalls.length;
    h.tileset.setOptions({ scrubLod: { spatial: true } }); // structurally equal
    await settle();
    expect(h.rawCalls.length).toBe(mark);
  });
});

// ---------------------------------------------------------------------------
// Cache limits
// ---------------------------------------------------------------------------

describe('setOptions: cache limits', () => {
  /** Fill the cache with `~12` resident tiles, only one of which is needed. */
  async function fillCache() {
    const h = makeHarness();
    // Wide window: buckets 0..10 all load.
    h.tileset.update({
      bounds: BOUNDS,
      zoom: 4,
      time: 5000,
      timeWindow: 10000,
    });
    await settle();
    // Move far away in time so the earlier tiles are resident-but-unneeded.
    h.tileset.update({ bounds: BOUNDS, zoom: 4, time: 25000, timeWindow: 100 });
    await settle();
    return h;
  }

  it('lowering maxCacheSize evicts down to the new bound immediately', async () => {
    const h = await fillCache();
    const before = h.tileset.getCacheStats().tileCount;
    expect(before).toBeGreaterThan(4);

    h.tileset.setOptions({ maxCacheSize: 4 });
    // Synchronous: no update(), no await — the cut is honored on the spot.
    const after = h.tileset.getCacheStats();
    expect(after.tileCount).toBe(4);
    expect(after.evictions).toBe(before - 4);
  });

  it('lowering maxCacheByteSize evicts down to the new byte bound', async () => {
    const h = await fillCache();
    const before = h.tileset.getCacheStats();
    expect(before.cacheBytes).toBeGreaterThan(5000);

    // Each synthetic tile estimates at 1000 B (base overhead, no buffers).
    h.tileset.setOptions({ maxCacheByteSize: 3000 });
    expect(h.tileset.getCacheStats().cacheBytes).toBeLessThanOrEqual(3000);
  });

  it('raising a limit evicts nothing', async () => {
    const h = await fillCache();
    const before = h.tileset.getCacheStats();
    h.tileset.setOptions({ maxCacheSize: 99999 });
    expect(h.tileset.getCacheStats().tileCount).toBe(before.tileCount);
    expect(h.tileset.getCacheStats().evictions).toBe(before.evictions);
  });
});

// ---------------------------------------------------------------------------
// Concurrency + debounce
// ---------------------------------------------------------------------------

describe('setOptions: maxRequests', () => {
  it('raising it dispatches more requests at once, and re-caps the loader', async () => {
    const setMaxConcurrentRequests = vi.fn();
    const h = makeHarness({
      perTile: true,
      hangingLoads: true,
      maxRequests: 1,
      setMaxConcurrentRequests,
    });
    h.tileset.update({
      bounds: BOUNDS,
      zoom: 4,
      time: 5000,
      timeWindow: 10000,
    });
    await settle();
    expect(h.tileLoads).toHaveLength(1); // one slot, one in-flight fetch

    h.tileset.setOptions({ maxRequests: 5 });
    await settle();
    // The four freed slots dispatch immediately — no update() needed.
    expect(h.tileLoads).toHaveLength(5);
    // ...and the knob reached the archive's range coalescer.
    expect(setMaxConcurrentRequests).toHaveBeenCalledWith(5);
  });

  it('does not touch the loader cap when maxRequests is unchanged', async () => {
    const setMaxConcurrentRequests = vi.fn();
    const h = makeHarness({ maxRequests: 4, setMaxConcurrentRequests });
    h.tileset.setOptions({ maxRequests: 4, debounceTime: 7 });
    expect(setMaxConcurrentRequests).not.toHaveBeenCalled();
  });
});

describe('setOptions: debounceTime', () => {
  it('re-arms an already-pending debounce at the new delay', async () => {
    const h = makeHarness({ debounceTime: 5000 });
    h.tileset.update({ bounds: BOUNDS, zoom: 4, time: 500, timeWindow: 100 });
    await settle();
    expect(h.rawCalls).toHaveLength(0); // still waiting out the 5 s debounce

    h.tileset.setOptions({ debounceTime: 0 });
    await settle();
    // The pending selection fires at the NEW delay instead of the old one.
    expect(h.rawCalls.length).toBeGreaterThan(0);
  });

  it('a later update() uses the new delay', async () => {
    const h = makeHarness({ debounceTime: 0 });
    h.tileset.setOptions({ debounceTime: 5000 });
    h.tileset.update({ bounds: BOUNDS, zoom: 4, time: 500, timeWindow: 100 });
    await settle();
    expect(h.rawCalls).toHaveLength(0);
    h.tileset.finalize(); // drop the pending 5 s timer
  });
});

// ---------------------------------------------------------------------------
// Prefetch policy
// ---------------------------------------------------------------------------

describe('setOptions: prefetch policy', () => {
  /** Selection queries a window-sized range; prefetch queries a much wider one. */
  const widest = (calls: Recorded[], from = 0): number =>
    Math.max(...calls.slice(from).map((c) => c.range.end));

  async function primed(opts: HarnessOptions) {
    const h = makeHarness({ enablePrefetch: true, ...opts });
    h.tileset.update({ bounds: BOUNDS, zoom: 4, time: 5000, timeWindow: 100 });
    await settle();
    return h;
  }

  it('prefetchAhead widens the planned runway', async () => {
    const h = await primed({ prefetchAhead: 1000, prefetchSteps: 1 });
    // time 5000 + 1000 ahead + half a window.
    expect(widest(h.rawCalls)).toBeCloseTo(6050, 5);

    const mark = h.rawCalls.length;
    h.tileset.setOptions({ prefetchAhead: 20000 });
    await settle();
    expect(widest(h.rawCalls, mark)).toBeCloseTo(25050, 5);
  });

  it('prefetchSteps multiplies the planned runway', async () => {
    const h = await primed({ prefetchAhead: 1000, prefetchSteps: 1 });
    expect(widest(h.rawCalls)).toBeCloseTo(6050, 5);

    const mark = h.rawCalls.length;
    h.tileset.setOptions({ prefetchSteps: 4 });
    await settle();
    expect(widest(h.rawCalls, mark)).toBeCloseTo(9050, 5);
  });

  it('enablePrefetch: false stops planning a runway; true resumes it', async () => {
    const h = await primed({ prefetchAhead: 20000, prefetchSteps: 1 });
    expect(widest(h.rawCalls)).toBeCloseTo(25050, 5);

    h.tileset.setOptions({ enablePrefetch: false });
    await settle();
    expect(h.tileset.getCacheStats().prefetchQueueLength).toBe(0);

    // A later viewport tick now queries the SELECTION window only — no
    // lookahead range at all.
    let mark = h.rawCalls.length;
    h.tileset.update({ bounds: BOUNDS, zoom: 4, time: 6000, timeWindow: 100 });
    await settle();
    expect(h.rawCalls.length).toBeGreaterThan(mark);
    expect(widest(h.rawCalls, mark)).toBeCloseTo(6050, 5);

    // Switching it back on re-plans immediately — without another update().
    mark = h.rawCalls.length;
    h.tileset.setOptions({ enablePrefetch: true });
    await settle();
    expect(widest(h.rawCalls, mark)).toBeCloseTo(26050, 5);
  });
});

// ---------------------------------------------------------------------------
// Partial semantics
// ---------------------------------------------------------------------------

describe('setOptions: partial semantics', () => {
  it('leaves options that were not passed untouched', () => {
    const h = makeHarness({ maxRequests: 7, prefetchSteps: 3 });
    h.tileset.setOptions({ maxCacheSize: 11 });
    expect(h.tileset.options.maxRequests).toBe(7);
    expect(h.tileset.options.prefetchSteps).toBe(3);
    expect(h.tileset.options.maxCacheSize).toBe(11);
  });

  it('a key present with `undefined` resets it to the constructor default', () => {
    const h = makeHarness({ maxRequests: 7 });
    h.tileset.setOptions({ maxRequests: undefined });
    expect(h.tileset.options.maxRequests).toBe(24);
  });

  it('mutates the options object in place (captured references stay live)', () => {
    const h = makeHarness();
    const captured = h.tileset.options;
    h.tileset.setOptions({ maxCacheSize: 42 });
    expect(captured.maxCacheSize).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// The archive-side halves: loadOptions + the coalescer's own concurrency cap
// ---------------------------------------------------------------------------

describe('STTArchive.setLoadOptions (the `loadOptions` prop)', () => {
  const DATASET = packedFromGolden();

  interface Logged {
    url: string;
    init?: RequestInit;
  }
  const headersOf = (r: Logged): Record<string, string> =>
    (r.init?.headers as Record<string, string>) ?? {};

  function recordingFetch(log: Logged[]): typeof fetch {
    const inner = packedFetch(DATASET);
    return (async (url: string, init?: RequestInit) => {
      log.push({ url, init });
      return inner(url, init);
    }) as unknown as typeof fetch;
  }

  it('rotates the RequestInit applied to subsequent requests', async () => {
    const log: Logged[] = [];
    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      fetch: recordingFetch(log),
      loadOptions: { fetch: { headers: { 'X-Stt-Auth': 'token-1' } } },
    });
    await archive.getMetadata();
    expect(log.length).toBeGreaterThan(0);
    expect(headersOf(log[0])['X-Stt-Auth']).toBe('token-1');

    // Rotate the token — e.g. the consuming layer's `loadOptions` prop changed.
    archive.setLoadOptions({ fetch: { headers: { 'X-Stt-Auth': 'token-2' } } });
    const mark = log.length;
    const index = await archive.getIndex();
    const e = index.tiles[0];
    await archive.getTile({ z: e.zoom, x: e.x, y: e.y, t: e.timeStart });

    const after = log.slice(mark);
    expect(after.length).toBeGreaterThan(0);
    for (const req of after) {
      // Re-derived from the BASE transport, so the stale header is gone
      // rather than stacked underneath the new one.
      expect(headersOf(req)['X-Stt-Auth']).toBe('token-2');
    }
  });

  it('clears the RequestInit when passed undefined', async () => {
    const log: Logged[] = [];
    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      fetch: recordingFetch(log),
      loadOptions: { fetch: { headers: { 'X-Stt-Auth': 'token-1' } } },
    });
    await archive.getMetadata();
    archive.setLoadOptions(undefined);
    const mark = log.length;
    await archive.getIndex();
    for (const req of log.slice(mark)) {
      expect(headersOf(req)['X-Stt-Auth']).toBeUndefined();
    }
  });

  it('never lets a later loadOptions.fetch function displace an explicit transport', async () => {
    const log: Logged[] = [];
    const explicit = recordingFetch(log);
    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      fetch: explicit,
    });
    const usurper = vi.fn();
    archive.setLoadOptions({ fetch: usurper as unknown as typeof fetch });
    await archive.getMetadata();
    expect(usurper).not.toHaveBeenCalled();
    expect(log.length).toBeGreaterThan(0);
  });
});

describe('STTArchive.setMaxConcurrentRequests (the `maxRequests` prop)', () => {
  const DATASET = packedFromGolden();

  it('re-caps the range coalescer after construction', async () => {
    const archive = new STTArchive({
      url: DATASET.manifestUrl,
      fetch: packedFetch(DATASET),
      maxConcurrentRequests: 3,
    });
    expect(archive.getMaxConcurrentRequests()).toBe(3);
    archive.setMaxConcurrentRequests(9);
    expect(archive.getMaxConcurrentRequests()).toBe(9);
    // A deadlocking cap is ignored rather than applied.
    archive.setMaxConcurrentRequests(0);
    expect(archive.getMaxConcurrentRequests()).toBe(9);
  });
});

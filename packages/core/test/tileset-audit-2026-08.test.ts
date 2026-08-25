/**
 * Tile-loading audit 2026-08 — the tileset findings that had no home in an
 * existing suite: B5 (loop-aware prefetch + non-flushing wrap), F1 (resident
 * short-circuit + pinned-free grace sweep), A4 (the process-wide decoded-byte
 * budget) and G2 (always-on counters). B1 lives in buffered-runway.test.ts
 * next to the runway it protects; C4 in overview-preload.test.ts; B8 in
 * buffered-runway.test.ts. Every test here failed against the pre-fix
 * tileset (see the audit's "How to verify" per finding).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import type { SpatioTemporalTileHeader } from '../src/spatiotemporal-tileset';
import { decodedMemoryBudget } from '../src/memory-budget';
import type { BoundingBox, Tile, TileId } from '../src/types';
import {
  BOUNDS,
  BUCKET_MS,
  fakeTile,
  makeAvailableTiles,
  settle,
} from './helpers/fixtures';
import { advanceClock, installClock } from './helpers/clock';

const MIB = 1024 * 1024;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A tile whose decoded size is `bytes` (+ the estimator's 1000 B base). Every
 * tile shares ONE backing buffer — `estimateTileSize` de-dupes buffers per
 * tile, not across tiles — so a 32 MiB tile costs the test one allocation.
 */
function heavyTiles(bytes: number): (id: TileId) => Tile {
  const buffer = new ArrayBuffer(bytes);
  return (id: TileId): Tile =>
    ({
      id,
      timeRange: { start: id.t, end: id.t + BUCKET_MS },
      layers: [{ arrowIpc: new Uint8Array(buffer) }],
    }) as unknown as Tile;
}

// ─── B5 ─────────────────────────────────────────────────────────────────────

describe('B5: the prefetch horizon wraps at the loop edge, and the wrap is a continuation', () => {
  const N = 10;
  const LOOP = { start: 0, end: N * BUCKET_MS };
  const availableTiles = makeAvailableTiles(N);

  function makeLoopTileset(
    record: (id: TileId) => void,
  ): SpatioTemporalTileset {
    return new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      temporalBucketMs: BUCKET_MS,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      // Five buckets of horizon at |speed| 0.5: the 5 s window lookahead
      // beats speed × 8 s = 4 s.
      prefetchAhead: BUCKET_MS,
      prefetchSteps: 5,
      maxCacheSize: 1000,
      getTileByteSize: () => 1000,
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => {
        record(id);
        return fakeTile(id);
      },
      getTileDataBatch: async (ids: TileId[]) => {
        ids.forEach(record);
        return ids.map(fakeTile);
      },
    });
  }

  const at = (tileset: SpatioTemporalTileset, time: number): void => {
    tileset.update({ bounds: BOUNDS, zoom: 6, time, timeWindow: 100 }, true);
  };

  it('forward: buckets 0–3 are resident before the head wraps, and the wrap flushes nothing', async () => {
    installClock();
    const requests: Array<{ t: number; head: number }> = [];
    // The head starts on the FAR half, so nothing below bucket 4 was ever
    // visited on this lap: residency at the wrap can only come from the
    // loop-aware plan, never from the previous lap's leftovers.
    let head = 6500;
    const tileset = makeLoopTileset((id) => requests.push({ t: id.t, head }));
    tileset.setLoopWindow(LOOP);
    tileset.setAnimationState(true, 0.5);
    const flushSpy = vi.spyOn(tileset, 'flushPrefetch');

    tileset.update({ bounds: BOUNDS, zoom: 6, time: head, timeWindow: 100 });
    await settle(60);
    while (head < LOOP.end - 100) {
      advanceClock(400);
      head += 200;
      at(tileset, head);
      await settle(30);
    }
    expect(head).toBe(9900);

    // Warm BEFORE the wrap: the pass at 9 000 planned to 14 000, i.e. 4 s past
    // the loop edge, which wraps onto buckets 0–3 (and 4).
    const beforeWrap = requests.length;
    const warmed = new Set(
      requests.filter((r) => r.t < 4 * BUCKET_MS).map((r) => r.t),
    );
    expect(
      [0, 1, 2, 3].map((i) => i * BUCKET_MS).filter((t) => warmed.has(t)),
    ).toEqual([0, 1000, 2000, 3000]);

    // The wrap itself: a continuation, not a seek.
    flushSpy.mockClear();
    advanceClock(400);
    head = 100;
    at(tileset, head);
    await settle(30);
    expect(flushSpy).not.toHaveBeenCalled();
    // ...and nothing the wrap landed on was fetched again at priority.
    expect(
      requests.slice(beforeWrap).filter((r) => r.t < 4 * BUCKET_MS),
    ).toEqual([]);
    const counts = new Map<number, number>();
    for (const r of requests) counts.set(r.t, (counts.get(r.t) ?? 0) + 1);
    for (const [, n] of counts) expect(n).toBe(1);
    expect(tileset.getCacheStats().refetches).toBe(0);

    tileset.finalize();
  });

  it('backward: buckets 9–6 are resident before the head wraps to the loop end', async () => {
    installClock();
    const requests: Array<{ t: number; head: number }> = [];
    let head = 3500; // the near half: buckets ≥ 6 were never visited
    const tileset = makeLoopTileset((id) => requests.push({ t: id.t, head }));
    tileset.setLoopWindow(LOOP);
    tileset.setAnimationState(true, -0.5); // signed: commits the direction
    const flushSpy = vi.spyOn(tileset, 'flushPrefetch');

    tileset.update({ bounds: BOUNDS, zoom: 6, time: head, timeWindow: 100 });
    await settle(60);
    while (head > 100) {
      advanceClock(400);
      head -= 200;
      at(tileset, head);
      await settle(30);
    }
    expect(head).toBe(100);

    const beforeWrap = requests.length;
    const warmed = new Set(
      requests.filter((r) => r.t >= 6 * BUCKET_MS).map((r) => r.t),
    );
    expect(
      [6, 7, 8, 9].map((i) => i * BUCKET_MS).filter((t) => warmed.has(t)),
    ).toEqual([6000, 7000, 8000, 9000]);

    flushSpy.mockClear();
    advanceClock(400);
    head = 9900;
    at(tileset, head);
    await settle(30);
    expect(flushSpy).not.toHaveBeenCalled();
    expect(
      requests.slice(beforeWrap).filter((r) => r.t >= 6 * BUCKET_MS),
    ).toEqual([]);

    tileset.finalize();
  });
});

// ─── F1 ─────────────────────────────────────────────────────────────────────

describe('F1: a fully resident horizon stops re-planning, and the grace sweep skips pinned headers', () => {
  it('a 4-tile resident archive issues no further prefetch directory queries while playing', async () => {
    installClock();
    const availableTiles = makeAvailableTiles(4);
    /** Widths of the WIDE (prefetch-horizon) directory queries, in order. */
    const wide: number[] = [];
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      temporalBucketMs: BUCKET_MS,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      getAvailableTiles: async (b, z, r) => {
        // Selection asks for one window; the prefetch planner asks for the
        // whole horizon (64 buckets here). Count only the latter.
        if (r.end - r.start > 10 * BUCKET_MS) wide.push(r.end - r.start);
        return availableTiles(b, z, r);
      },
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: async (ids: TileId[]) => ids.map(fakeTile),
    });
    tileset.setAnimationState(true, 1);
    let time = 500;
    tileset.update({ bounds: BOUNDS, zoom: 6, time, timeWindow: BUCKET_MS });
    await settle(60);
    // Let the drained-queue re-plan land and find everything resident.
    advanceClock(300);
    await settle(300);
    expect(tileset.getCacheStats().tileCount).toBe(4);
    const afterWarm = wide.length;
    expect(afterWarm).toBeGreaterThan(0);

    // 5 s of playback ticks against a 64 s horizon: the head never consumes
    // the reload fraction, so a resident archive has nothing to re-plan.
    for (let i = 0; i < 50; i++) {
      advanceClock(100);
      time += 100;
      tileset.update(
        { bounds: BOUNDS, zoom: 6, time, timeWindow: BUCKET_MS },
        true,
      );
      await settle(20);
    }
    // Pre-fix: the idle-pipeline bypass re-ran the slice every debounce (≈ 20).
    expect(wide.length - afterWarm).toBe(0);

    tileset.finalize();
  });

  it('the under-limit grace sweep never touches a pinned header', async () => {
    const N = 20;
    const availableTiles = makeAvailableTiles(N);
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      temporalBucketMs: BUCKET_MS,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      getTileByteSize: () => 100,
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: async (ids: TileId[]) => ids.map(fakeTile),
    });
    const result = await tileset.preloadOverviewTier();
    expect(result.loaded).toBe(true);
    expect(result.tiles).toBe(2 * N);

    // Instrument every pinned header: a read of `lastUsed` is the sweep's
    // recency test, the first thing it does to a header it visits.
    const tiles = (
      tileset as unknown as { tiles: Map<string, SpatioTemporalTileHeader> }
    ).tiles;
    let pinnedReads = 0;
    let pinned = 0;
    for (const header of tiles.values()) {
      if (!header.isPinned) continue;
      pinned++;
      let value = header.lastUsed;
      Object.defineProperty(header, 'lastUsed', {
        configurable: true,
        get() {
          pinnedReads++;
          return value;
        },
        set(v: number) {
          value = v;
        },
      });
    }
    expect(pinned).toBe(2 * N);

    // Ten under-limit selection passes (the time nudge defeats the
    // identical-params fast path); each one runs the grace sweep.
    for (let i = 0; i < 10; i++) {
      tileset.update({
        bounds: BOUNDS,
        zoom: 6,
        time: 500 + i,
        timeWindow: 100,
      });
      await settle(5);
    }
    expect(tileset.getCacheStats().selectionPasses).toBe(10);
    // Pre-fix: 40 pinned headers × 10 passes = 400 reads.
    expect(pinnedReads).toBe(0);

    tileset.finalize();
  });
});

// ─── A4 ─────────────────────────────────────────────────────────────────────

describe('A4: one process-wide decoded-byte budget bounds every live tileset', () => {
  beforeEach(() => {
    decodedMemoryBudget.reset();
  });
  afterEach(() => {
    decodedMemoryBudget.reset();
  });

  it('two tilesets each capped at 2 GiB stay under a 256 MiB budget together, and unregister frees the share', async () => {
    decodedMemoryBudget.configure({ maxBytes: 256 * MIB });
    const tile = heavyTiles(32 * MIB);
    const availableTiles = makeAvailableTiles(40);
    const make = (): SpatioTemporalTileset =>
      new SpatioTemporalTileset({
        minZoom: 0,
        maxZoom: 12,
        temporalBucketMs: BUCKET_MS,
        enablePrefetch: true,
        refinementStrategy: 'no-overlap',
        prefetchAhead: BUCKET_MS,
        prefetchSteps: 8, // eight 32 MiB buckets of runway each, if allowed
        maxCacheByteSize: 2 * 1024 * MIB,
        getTileByteSize: () => 4 * MIB, // 8× expansion, measured from the tiles
        getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
        getTileData: async (id: TileId) => tile(id),
        getTileDataBatch: async (ids: TileId[]) => ids.map(tile),
      });
    const a = make();
    const b = make();
    expect(decodedMemoryBudget.ownerCount()).toBe(2);
    expect(decodedMemoryBudget.share()).toBe(128 * MIB);

    for (const t of [a, b]) {
      t.setAnimationState(true, 0);
      t.update({ bounds: BOUNDS, zoom: 6, time: 500, timeWindow: 100 });
      t.getBufferedRunway(500, 1); // coverage tracking: tiered plan + CO-2 solve
    }
    await settle(300);
    await settle(300);

    const total = (): number =>
      a.getCacheStats().cacheBytes + b.getCacheStats().cacheBytes;
    // Pre-fix: each held its head + 8 buckets = 288 MiB → 576 MiB together.
    expect(total()).toBeGreaterThan(0);
    expect(total()).toBeLessThanOrEqual(256 * MIB);
    expect(decodedMemoryBudget.total()).toBe(total());

    a.finalize();
    expect(decodedMemoryBudget.ownerCount()).toBe(1);
    expect(decodedMemoryBudget.share()).toBe(256 * MIB);
    b.finalize();
    expect(decodedMemoryBudget.ownerCount()).toBe(0);
  });

  it('5,000 resident 3 KB tiles are bounded by bytes, not by a 2,000-tile count cap', async () => {
    const PER_BUCKET = 1000;
    const N = 5;
    const tile = heavyTiles(2048); // + the 1000 B base ≈ 3 KB decoded
    const available = (
      _b: BoundingBox,
      z: number,
      r: { start: number; end: number },
    ): TileId[] => {
      const ids: TileId[] = [];
      for (let i = 0; i < N; i++) {
        const t = i * BUCKET_MS;
        if (t + BUCKET_MS < r.start || t > r.end) continue;
        for (let x = 0; x < PER_BUCKET; x++) ids.push({ z, x, y: 0, t });
      }
      return ids;
    };
    const tileset = new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      temporalBucketMs: BUCKET_MS,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      getAvailableTiles: async (b, z, r) => available(b, z, r),
      getTileData: async (id: TileId) => tile(id),
      getTileDataBatch: async (ids: TileId[]) => ids.map(tile),
    });
    // The count cap is a sanity ceiling now (was 2,000).
    expect(tileset.options.maxCacheSize).toBe(20_000);

    // Visit five buckets in turn: after the last, 4,000 of the 5,000 resident
    // tiles are outside the window and were eviction candidates under the
    // old count cap.
    for (let i = 0; i < N; i++) {
      tileset.update({
        bounds: BOUNDS,
        zoom: 6,
        time: i * BUCKET_MS + 500,
        timeWindow: 100,
      });
      await settle(40);
    }
    await settle(50);
    const st = tileset.getCacheStats();
    expect(st.tileCount).toBe(N * PER_BUCKET);
    expect(st.evictions).toBe(0);
    expect(st.cacheBytes).toBeLessThan(20 * MIB);

    tileset.finalize();
  });
});

// ─── G2 ─────────────────────────────────────────────────────────────────────

describe('G2: always-on network and churn counters', () => {
  const N = 4;
  const availableTiles = makeAvailableTiles(N);

  function makeTileset(
    over: Partial<ConstructorParameters<typeof SpatioTemporalTileset>[0]> = {},
  ): SpatioTemporalTileset {
    return new SpatioTemporalTileset({
      minZoom: 0,
      maxZoom: 12,
      temporalBucketMs: BUCKET_MS,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      getTileByteSize: () => 100,
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: async (ids: TileId[]) => ids.map(fakeTile),
      ...over,
    });
  }
  const loadBucket = async (
    tileset: SpatioTemporalTileset,
    i: number,
  ): Promise<void> => {
    tileset.update({
      bounds: BOUNDS,
      zoom: 6,
      time: i * BUCKET_MS + 500,
      timeWindow: 100,
    });
    await settle(10);
  };

  it('requests / bytesRequested / bytesUseful price a dispatch by the range plan when the archive offers one', async () => {
    const planned = makeTileset({
      // The coalescer would put 2.5× the directory bytes on the wire.
      estimateFetchBytes: (ids: TileId[]) => ids.length * 250,
    });
    await loadBucket(planned, 0);
    let st = planned.getCacheStats();
    expect(st.requests).toBe(1);
    expect(st.bytesRequested).toBe(250);
    expect(st.bytesUseful).toBe(100);
    await loadBucket(planned, 1);
    st = planned.getCacheStats();
    expect(st.requests).toBe(2);
    expect(st.bytesRequested).toBe(500);
    expect(st.bytesUseful).toBe(200);
    planned.finalize();

    // Unwired: the directory sum stands in, and amplification reads 1.
    const blind = makeTileset();
    await loadBucket(blind, 0);
    st = blind.getCacheStats();
    expect(st.requests).toBe(1);
    expect(st.bytesRequested).toBe(100);
    expect(st.bytesUseful).toBe(100);
    blind.finalize();
  });

  it('refetches counts a key delivered again after eviction; overLimitEvictionsScheduled the passes armed', async () => {
    const tileset = makeTileset({ maxCacheSize: 1 });
    await loadBucket(tileset, 0);
    let st = tileset.getCacheStats();
    expect(st.overLimitEvictionsScheduled).toBe(0);
    expect(st.refetches).toBe(0);

    await loadBucket(tileset, 1); // a second loaded tile: over the cap at delivery
    await settle(40); // the coalesced over-limit pass fires
    st = tileset.getCacheStats();
    expect(st.overLimitEvictionsScheduled).toBe(1);
    expect(st.evictions).toBe(1);
    expect(st.refetches).toBe(0);

    await loadBucket(tileset, 0); // bucket 0 again: a refetch
    st = tileset.getCacheStats();
    expect(st.refetches).toBe(1);
    expect(st.requests).toBe(3);

    // clear() resets the churn oracle: the next load of bucket 0 is fresh.
    tileset.clear();
    await loadBucket(tileset, 0);
    expect(tileset.getCacheStats().refetches).toBe(1);

    tileset.finalize();
  });

  it('selectionPasses counts only passes past the identical-params fast path', async () => {
    const tileset = makeTileset();
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 500, timeWindow: 100 });
    await settle(10);
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 500, timeWindow: 100 });
    await settle(10);
    tileset.update({ bounds: BOUNDS, zoom: 6, time: 600, timeWindow: 100 });
    await settle(10);
    expect(tileset.getCacheStats().selectionPasses).toBe(2);
    tileset.finalize();
  });
});

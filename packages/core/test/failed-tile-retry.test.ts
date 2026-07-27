/**
 * RC7 — no retry after a failed settle
 * (docs/roadmap/tile-loading-3d-2026-07.md §2, F5).
 *
 * The ONLY site that queues a needed tile is `selectAndLoadTiles`'s candidate
 * loop, and a stationary camera never reaches it: the exact-bounds `selectKey`
 * fast path short-circuits every identical `update()`. So a tile whose batch
 * resolved `null` was left `{isLoaded: false, isLoading: false,
 * isCancelled: false}` — still in `neededTileKeys`, in NO queue, and invisible
 * to every dispatcher. Measured on the shipped build: zero re-requests across
 * 30 identical updates; only a 1 ms playhead nudge healed it. It also pinned
 * the buffered runway at zero, because the coverage index counted it as
 * missing forever and the playback governor gates the clock on that.
 *
 * Three constraints have to hold at once, and the first shipped fix satisfied
 * only two of them:
 *
 *  1. a transient failure heals with NO user action,
 *  2. a permanently-absent tile never pins the buffered runway at zero,
 *  3. and neither turns into a fetch storm against an origin that has already
 *     said no.
 *
 * The first attempt bought (2) and (3) with a one-way `isFailed` latch and a
 * three-attempt cap, which cost (1) outright: all three attempts land inside
 * ~1.5 s and a NEEDED tile's header is never replaced, so a blip that outlasted
 * them blanked the region for the rest of the session. The policy under test
 * splits the two jobs — an exponential backoff ladder decides when to ask
 * again, `isFailed` decides only when readiness stops waiting.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SpatioTemporalTileset } from '../src/spatiotemporal-tileset';
import type { BoundingBox, Tile, TileId } from '../src/types';
import { BUCKET_MS, fakeTile, makeAvailableTiles } from './helpers/fixtures';

const BOUNDS: BoundingBox = {
  minLon: -180,
  minLat: -85,
  maxLon: 180,
  maxLat: 85,
};

afterEach(() => {
  vi.useRealTimers();
});

describe('a NEEDED tile whose fetch settles without data', () => {
  it('is re-requested on a decaying backoff, and written off for readiness after three failures', async () => {
    vi.useFakeTimers();
    const requested: TileId[] = [];
    const tileset = new SpatioTemporalTileset({
      minZoom: 6,
      maxZoom: 6,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles: async (_b, z) => [{ z, x: 0, y: 0, t: 0 }],
      getTileData: async () => null,
      getTileDataBatch: async (ids: TileId[]) => {
        requested.push(...ids);
        return ids.map(() => null);
      },
    });

    const view = { bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS };
    tileset.update(view, true);
    await vi.advanceTimersByTimeAsync(1);
    expect(requested.length).toBe(1);

    // The original defect, still true INSIDE the cooldown window: nothing the
    // camera does re-queues the tile.
    for (let i = 0; i < 30; i++) tileset.update(view, true);
    await vi.advanceTimersByTimeAsync(1);
    expect(requested.length).toBe(1);

    // The settle-time re-check heals it once the backoff has elapsed, and
    // every further failure DOUBLES the wait: 500 → 1000 → 2000 → …
    await vi.advanceTimersByTimeAsync(600); // t ≈ 601, rung 1 fired at 500
    expect(requested.length).toBe(2);
    await vi.advanceTimersByTimeAsync(900); // t ≈ 1501, rung 2 fired at 1500
    expect(requested.length).toBe(3);
    await vi.advanceTimersByTimeAsync(900); // t ≈ 2401 — inside rung 3
    expect(requested.length).toBe(3);
    await vi.advanceTimersByTimeAsync(1200); // t ≈ 3601, rung 3 fired at 3500
    expect(requested.length).toBe(4);

    // Four requests is PAST the three-failure budget, and that is the fix. The
    // budget is a READINESS verdict, not a fetch verdict: the tile is written
    // off for the runway (next test) while the ladder keeps asking, so a blip
    // that outlasted three attempts still heals with no user action. Before
    // this, `isFailed` was one-way for the header's lifetime and a NEEDED
    // tile's header is never replaced, so 1.5 s of bad network blanked that
    // region until the page was reloaded.
    //
    // The selection signal stays settled throughout — a probe that is neither
    // queued nor in flight at the moment of the check cannot pin it false.
    expect(tileset.isLoaded).toBe(true);

    tileset.finalize();
  });

  it('stops pinning the buffered runway once it is written off', async () => {
    vi.useFakeTimers();
    const availableTiles = makeAvailableTiles(2);
    const tileset = new SpatioTemporalTileset({
      minZoom: 6,
      maxZoom: 6,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async () => null,
      // Bucket 0 never delivers; bucket 1 does.
      getTileDataBatch: async (ids: TileId[]) =>
        ids.map((id) => (id.t === 0 ? null : fakeTile(id))),
    });

    tileset.update(
      { bounds: BOUNDS, zoom: 6, time: 0, timeWindow: 3 * BUCKET_MS },
      true,
    );
    // Build the coverage index (lazy — the first readiness call turns it on).
    tileset.getBufferedRunway(0, 1);
    await vi.advanceTimersByTimeAsync(50);

    // Bucket 0 is missing, so the runway cannot leave the playhead: the
    // governor would hold the clock here forever.
    expect(tileset.getBufferedRunway(0, 1).simMs).toBe(0);

    // Exhaust the attempt budget (3 settles, 500 ms apart).
    await vi.advanceTimersByTimeAsync(3_000);
    expect(tileset.getBufferedRunway(0, 1).simMs).toBeGreaterThan(0);
    // And it costs nothing to "finish" — no fetch will ever be issued for it
    // again, so billing its bytes would inflate every ETA built on this.
    expect(tileset.estimateCost({ start: 0, end: BUCKET_MS }).tiles).toBe(0);

    tileset.finalize();
  });
});

describe('the prefetch tier shares the same backoff ladder', () => {
  it('stops hammering a dead header, without stopping dead', async () => {
    vi.useFakeTimers();
    const requested: TileId[] = [];
    const availableTiles = makeAvailableTiles(20);
    const tileset = new SpatioTemporalTileset({
      minZoom: 6,
      maxZoom: 6,
      enablePrefetch: true,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async () => null,
      getTileDataBatch: async (ids: TileId[]) => {
        requested.push(...ids);
        return ids.map(() => null);
      },
    });

    // Animating: `extendPrefetchIfDrained` re-plans the moment the queue and
    // the in-flight set empty, which is every time one of these batches
    // resolves null. The dead-header revival then re-proposes exactly the
    // tiles that just failed — the loop the cap has to break.
    tileset.setAnimationState(true, 1);
    tileset.update(
      { bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS },
      true,
    );

    const worstSoFar = (): number => {
      const perTile = new Map<string, number>();
      for (const id of requested) {
        const k = `${id.z}/${id.x}/${id.y}/${id.t}`;
        perTile.set(k, (perTile.get(k) ?? 0) + 1);
      }
      return Math.max(...perTile.values());
    };

    // Five wall-seconds of a re-planning loop against an origin that answers
    // `null` to everything. Uncapped this was one request per planning pass;
    // on the ladder it is the first few rungs and no more.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(worstSoFar()).toBeLessThanOrEqual(5);

    // Two more minutes. The ladder must keep DECAYING rather than settling
    // into any fixed rate: the rungs are 0.5/1/2/4/8/16/32/60 s, so 125 s of
    // a dead origin costs the worst tile nine probes — against ~250 for the
    // uncapped revival this replaced, or ~4 for a flat 30 s cooldown that
    // would be far too slow to cover a blip.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(worstSoFar()).toBeLessThanOrEqual(10);

    tileset.finalize();
  });
});

describe('the revival does not fire for work that healed on its own', () => {
  it('leaves a tile alone once the viewport has moved off it', async () => {
    vi.useFakeTimers();
    const requested: TileId[] = [];
    const availableTiles = makeAvailableTiles(20);
    const tileset = new SpatioTemporalTileset({
      minZoom: 6,
      maxZoom: 6,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async () => null,
      getTileDataBatch: async (ids: TileId[]) => {
        requested.push(...ids);
        // Only bucket 0 fails; everything else is fine.
        return ids.map((id) => (id.t === 0 ? null : fakeTile(id)));
      },
    });

    tileset.update(
      { bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS },
      true,
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(requested.filter((id) => id.t === 0).length).toBe(1);

    // Seek well past bucket 0 before the cooldown expires: it is not in the
    // needed set any more, so refetching it would be pure waste.
    tileset.update(
      { bounds: BOUNDS, zoom: 6, time: 15_000, timeWindow: BUCKET_MS },
      true,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(requested.filter((id) => id.t === 0).length).toBe(1);

    tileset.finalize();
  });
});

/**
 * The adversarial review's finding on F5: the write-off was PERMANENT and the
 * header IMMORTAL. All three attempts land inside ~1.5 s (3 × the 500 ms
 * cooldown); after that `isFailed` was never cleared, and a NEEDED tile's
 * header is never replaced because eviction hard-excludes `neededTileKeys`
 * (verified-correct, §7). So a 1.5-second network blip blanked that region for
 * the REST OF THE SESSION and no amount of panning, seeking or waiting healed
 * it — strictly worse than the RC7 hole F5 set out to fix, which at least
 * healed on a 1 ms playhead nudge.
 */
describe('a transient failure heals with no user action', () => {
  it('re-fetches a network-rejected tile once the backoff expires, and loads it', async () => {
    vi.useFakeTimers();
    const requested: TileId[] = [];
    let down = true;
    const tileset = new SpatioTemporalTileset({
      minZoom: 6,
      maxZoom: 6,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles: async (_b, z) => [{ z, x: 0, y: 0, t: 0 }],
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: async (ids: TileId[]) => {
        requested.push(...ids);
        // A network-style rejection, NOT an AbortError: the transport really
        // failed, so it must be charged against the attempt budget.
        if (down) throw new Error('NetworkError: connection reset');
        return ids.map((id) => fakeTile(id));
      },
      onTileError: () => {},
    });

    const view = { bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS };
    tileset.update(view, true);
    await vi.advanceTimersByTimeAsync(1);
    expect(requested.length).toBe(1);

    // Burn the whole attempt budget inside the blip.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(requested.length).toBeGreaterThanOrEqual(3);
    expect(tileset.getVisibleTiles()).toEqual([]);

    // The blip passes. NOTHING touches the camera, the playhead or the tileset
    // — this is the "user stares at a hole and it fixes itself" contract.
    down = false;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(tileset.getVisibleTiles().length).toBe(1);
    expect(tileset.estimateCost({ start: 0, end: BUCKET_MS }).tiles).toBe(0);

    tileset.finalize();
  });

  it('keeps probing a permanently-absent tile, but at a decaying rate', async () => {
    vi.useFakeTimers();
    const requested: TileId[] = [];
    const availableTiles = makeAvailableTiles(2);
    const tileset = new SpatioTemporalTileset({
      minZoom: 6,
      maxZoom: 6,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async () => null,
      getTileDataBatch: async (ids: TileId[]) => {
        requested.push(...ids.filter((id) => id.t === 0));
        return ids.map((id) => (id.t === 0 ? null : fakeTile(id)));
      },
    });

    tileset.update(
      { bounds: BOUNDS, zoom: 6, time: 0, timeWindow: 3 * BUCKET_MS },
      true,
    );
    tileset.getBufferedRunway(0, 1);
    await vi.advanceTimersByTimeAsync(50);

    // Five minutes of a stationary camera on a tile the origin will never
    // serve. It must keep asking — otherwise the hole is permanent — but the
    // spacing has to decay, or one dead tile is a 2 Hz request loop for the
    // life of the session.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(requested.length).toBeGreaterThan(3);
    expect(requested.length).toBeLessThanOrEqual(12);

    // …and the constraints F5 was written for still hold: one absent tile
    // never pins the runway at zero, and never bills its bytes into an ETA.
    expect(tileset.getBufferedRunway(0, 1).simMs).toBeGreaterThan(0);
    expect(tileset.estimateCost({ start: 0, end: BUCKET_MS }).tiles).toBe(0);

    tileset.finalize();
  });
});

/**
 * A tile whose in-flight fetch is ABORTED is not a failure — supersession is
 * the normal way a viewport change ends a request, and selection re-arms the
 * `isCancelled` latch and re-queues it on its own. Charging aborts against the
 * attempt budget would write off perfectly good tiles after three pans.
 */
describe('aborts are not charged against the attempt budget', () => {
  it('keeps re-fetching a tile that is repeatedly superseded', async () => {
    const requested: TileId[] = [];
    const availableTiles = makeAvailableTiles(40);
    const gated: Array<{ resolve: () => void }> = [];
    const tileset = new SpatioTemporalTileset({
      minZoom: 6,
      maxZoom: 6,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles: async (b, z, r) => availableTiles(b, z, r),
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: (ids: TileId[], signal?: AbortSignal) =>
        new Promise<(Tile | null)[]>((resolve, reject) => {
          requested.push(...ids);
          gated.push({ resolve: () => resolve(ids.map(fakeTile)) });
          signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    });

    // Four seeks away and back: each seek aborts the in-flight batch for
    // bucket 0 (every member superseded), and each return re-queues it.
    for (let i = 0; i < 4; i++) {
      tileset.update(
        { bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS },
        true,
      );
      await new Promise((r) => setTimeout(r, 5));
      tileset.update(
        { bounds: BOUNDS, zoom: 6, time: 30_000, timeWindow: BUCKET_MS },
        true,
      );
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(requested.filter((id) => id.t === 0).length).toBeGreaterThan(3);

    tileset.finalize();
  });

  /**
   * The abort exemption used to be inferred from `header.isCancelled`, which
   * only the tileset's OWN teardown paths set (`cancelSupersededRequests`,
   * `flushPrefetch`, `evictTiles`, `clear`). An abort raised INSIDE the
   * transport — a per-request timeout, a `fetch` killed by the connection
   * pool — reaches the settle handler with `isCancelled` still false and was
   * charged like a real failure, so three flaky seconds wrote the tile off
   * permanently even though the origin had never once said no.
   */
  it('does not charge a transport-raised abort (no isCancelled latch)', async () => {
    vi.useFakeTimers();
    const requested: TileId[] = [];
    let timingOut = true;
    const tileset = new SpatioTemporalTileset({
      minZoom: 6,
      maxZoom: 6,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles: async (_b, z) => [{ z, x: 0, y: 0, t: 0 }],
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: async (ids: TileId[]) => {
        requested.push(...ids);
        // The tileset never aborted anything here: the tile stays in the
        // needed set for the whole test, exactly as a request timeout looks.
        if (timingOut) {
          throw Object.assign(new Error('timed out'), { name: 'AbortError' });
        }
        return ids.map((id) => fakeTile(id));
      },
      onTileError: () => {},
    });

    const view = { bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS };
    tileset.update(view, true);
    tileset.getBufferedRunway(0, 1);
    await vi.advanceTimersByTimeAsync(20_000);

    // Several aborted round-trips have settled, and the budget is untouched:
    // readiness has NOT written the tile off, so it is still billed as
    // outstanding work rather than declared permanently absent.
    expect(requested.length).toBeGreaterThan(3);
    expect(tileset.estimateCost({ start: 0, end: BUCKET_MS }).tiles).toBe(1);

    timingOut = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tileset.getVisibleTiles().length).toBe(1);

    tileset.finalize();
  });

  it('still stops pinning the runway when EVERY request aborts, forever', async () => {
    // The abort exemption above must be BOUNDED. A transport that aborts every
    // request — a dead origin behind a proxy that stalls rather than refuses, a
    // request timeout that always fires — never advances `attempts`, so without
    // a settle-count backstop it would never latch `isFailed` and would pin the
    // buffered runway at zero for the whole session. That is the exact failure
    // the attempt cap exists to prevent, reached through the abort door.
    vi.useFakeTimers();
    const requested: TileId[] = [];
    const tileset = new SpatioTemporalTileset({
      minZoom: 6,
      maxZoom: 6,
      enablePrefetch: false,
      refinementStrategy: 'no-overlap',
      temporalBucketMs: BUCKET_MS,
      getAvailableTiles: async (_b, z) => [{ z, x: 0, y: 0, t: 0 }],
      getTileData: async (id: TileId) => fakeTile(id),
      getTileDataBatch: async (ids: TileId[]) => {
        requested.push(...ids);
        throw Object.assign(new Error('timed out'), { name: 'AbortError' });
      },
      onTileError: () => {},
    });

    const view = { bounds: BOUNDS, zoom: 6, time: 0, timeWindow: BUCKET_MS };
    tileset.update(view, true);
    tileset.getBufferedRunway(0, 1);

    // Early on the tile is still billed as outstanding — the exemption is doing
    // its job and a blip has not written anything off.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(tileset.estimateCost({ start: 0, end: BUCKET_MS }).tiles).toBe(1);

    // Past the ladder's ceiling the session has enough evidence: readiness lets
    // go, so whatever was gated behind this tile can advance.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(tileset.estimateCost({ start: 0, end: BUCKET_MS }).tiles).toBe(0);

    // ...but the tile is NOT abandoned: probing continues at the ceiling rate,
    // bounded (~1/min), so it still heals if the origin comes back.
    const beforeProbes = requested.length;
    await vi.advanceTimersByTimeAsync(300_000);
    const added = requested.length - beforeProbes;
    expect(added).toBeGreaterThan(0);
    expect(added).toBeLessThanOrEqual(10);

    tileset.finalize();
  });
});

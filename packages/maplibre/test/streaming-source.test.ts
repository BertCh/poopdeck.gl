/**
 * SharedTilesetSource tests — the D6a shared-tileset refactor seam:
 *
 *   - multi-consumer replace-all fan-out with address-diff suppression +
 *     synchronous late-registrant seeding
 *   - frame-token dedupe (beginFrame / external frameId / unarmed passthrough)
 *   - unregister is leak-free (stale unregister cannot evict a replacement)
 *   - BufferSource delegation to the tileset's runway surface
 *   - load() builds a real SpatioTemporalTileset with base-layer-parity
 *     options over a stubbed archive (same pattern as tileset-wiring.test.ts)
 *   - dispose() teardown incl. the dispose-during-metadata-await race and
 *     ownsArchive: false
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SpatioTemporalTileset,
  tileKey as coreTileKey,
  type ArchiveMetadata,
  type BufferedRunway,
  type STTArchive,
  type Tile,
  type TileId,
} from '@poopdeck.gl/core';
import {
  SharedTilesetSource,
  SharedTilesetBufferSource,
  residentSetEqual,
  tileKey,
  type DrivableTileset,
  type RunwayTileset,
} from '../src/lib/streaming-source';
import { makePointTile, seedResidentTiles } from './fixtures';

const META = {
  minZoom: 0,
  maxZoom: 5,
  temporalBucketMs: 3_600_000,
} as unknown as ArchiveMetadata;

const VIEWPORT = {
  bounds: { minLon: -120, minLat: 20, maxLon: -60, maxLat: 50 },
  zoom: 3,
  time: 1_700_000_001_000,
  timeWindow: 5000,
};

/** A point tile re-addressed to a distinct z/x/y (fixtures share one id). */
function tileAt(z: number, x: number, y: number): Tile {
  const tile = makePointTile();
  tile.id = { ...tile.id, z, x, y };
  return tile;
}

/**
 * Mock DrivableTileset whose resident set the test scripts via setTiles().
 * setTiles bumps the frame number update() returns — the source gates its
 * resident-set diff on it (real-tileset contract: the number changes iff the
 * visible set may have changed).
 */
function makeMockTileset() {
  let tiles: Tile[] = [];
  let frame = 0;
  return {
    update: vi.fn(() => frame),
    getVisibleTiles: vi.fn(() => tiles),
    finalize: vi.fn(),
    setTiles(next: Tile[]) {
      tiles = next;
      frame++;
    },
  };
}

/** Attach-mode source over a mock tileset (no archive / network). */
function makeAttachedSource() {
  const tileset = makeMockTileset();
  const source = new SharedTilesetSource('mem://unused.stt');
  source.attachTileset(tileset as unknown as DrivableTileset, META);
  return { source, tileset };
}

/** Stub the archive surface load() consumes (tileset-wiring.test.ts pattern). */
function makeStubArchive() {
  return {
    getMetadata: vi.fn(async () => META),
    getTileIdsInBounds: vi.fn(() => []),
    getTile: vi.fn(async () => null),
    getTiles: vi.fn(async (ids: TileId[]) => ids.map(() => null)),
    getTileByteSize: vi.fn(() => 4096),
    getThroughputEstimate: vi.fn(() => ({ bytesPerMs: 5, samples: 3 })),
    setSchedulerWeight: vi.fn(),
    finalize: vi.fn(),
  };
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe('tileKey / residentSetEqual', () => {
  it('compares by tile address, ignoring order and object identity', () => {
    const a1 = tileAt(2, 0, 0);
    const a2 = tileAt(2, 0, 0);
    const b = tileAt(2, 1, 0);
    expect(tileKey(a1)).toBe(tileKey(a2));
    expect(residentSetEqual([a1, b], [b, a2])).toBe(true);
    expect(residentSetEqual([a1], [b])).toBe(false);
    expect(residentSetEqual([a1], [a1, b])).toBe(false);
  });
});

describe('SharedTilesetSource fan-out', () => {
  it('delivers the resident set replace-all to every registered consumer', () => {
    const { source, tileset } = makeAttachedSource();
    const a = vi.fn();
    const b = vi.fn();
    source.registerConsumer({ id: 'a', onTilesChanged: a });
    source.registerConsumer({ id: 'b', onTilesChanged: b });

    const set1 = [tileAt(2, 0, 0)];
    tileset.setTiles(set1);
    source.update(VIEWPORT);
    expect(a).toHaveBeenCalledWith(set1);
    expect(b).toHaveBeenCalledWith(set1);

    const set2 = [tileAt(2, 0, 0), tileAt(2, 1, 0)];
    tileset.setTiles(set2);
    source.update(VIEWPORT);
    expect(a).toHaveBeenLastCalledWith(set2);
    expect(b).toHaveBeenLastCalledWith(set2);
    expect(a).toHaveBeenCalledTimes(2);
  });

  it('suppresses publishes when the set is address-equal (new array, same tiles)', () => {
    const { source, tileset } = makeAttachedSource();
    const cb = vi.fn();
    source.registerConsumer({ id: 'a', onTilesChanged: cb });

    tileset.setTiles([tileAt(2, 0, 0)]);
    source.update(VIEWPORT);
    // Fresh array + fresh Tile objects, same z/x/y/t address.
    tileset.setTiles([tileAt(2, 0, 0)]);
    source.update(VIEWPORT);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('seeds late registrants synchronously with the current resident set', () => {
    const { source, tileset } = makeAttachedSource();
    const set1 = [tileAt(2, 0, 0)];
    tileset.setTiles(set1);
    source.update(VIEWPORT);

    const late = vi.fn();
    source.registerConsumer({ id: 'late', onTilesChanged: late });
    expect(late).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledWith(set1);
  });

  it('publishes async tile arrivals without a new update() (onTileLoad path)', () => {
    const { source, tileset } = makeAttachedSource();
    const cb = vi.fn();
    source.registerConsumer({ id: 'a', onTilesChanged: cb });
    source.update(VIEWPORT); // resident stays [] — no publish
    expect(cb).not.toHaveBeenCalled();

    // A tile finishing its stream re-publishes via the onTileLoad hook, which
    // routes through publishIfChanged — simulate that entry point directly.
    const set1 = [tileAt(2, 0, 0)];
    tileset.setTiles(set1);
    (source as unknown as { publishIfChanged(): void }).publishIfChanged();
    expect(cb).toHaveBeenCalledWith(set1);
  });

  it('update() discharges a queued publish inside the frame that drove it', () => {
    const { source, tileset } = makeAttachedSource();
    const cb = vi.fn();
    source.registerConsumer({ id: 'a', onTilesChanged: cb });

    // An async edge armed a republish (deferred — see schedulePublish) and a
    // frame arrives before the microtask drains. An eviction does NOT bump the
    // tileset's frame number, so the frame gate cannot deliver this on its own:
    // `update()` has to flush the pending flag or the correction waits for an
    // unrelated change.
    tileset.setTiles([tileAt(2, 0, 0)]);
    (source as unknown as { schedulePublish(): void }).schedulePublish();
    source.update(VIEWPORT);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('gates the resident-set walk on the tileset frame number (unarmed hot path)', () => {
    const { source, tileset } = makeAttachedSource();
    source.registerConsumer({ id: 'a', onTilesChanged: vi.fn() });
    source.update(VIEWPORT);
    source.update(VIEWPORT);
    source.update(VIEWPORT);
    // Unarmed dedupe: the tileset is driven every call…
    expect(tileset.update).toHaveBeenCalledTimes(3);
    // …but the getVisibleTiles + resident-diff walk ran once — the frame
    // number never changed, so the set cannot have (no per-frame Set/string
    // churn from N sibling layers).
    expect(tileset.getVisibleTiles).toHaveBeenCalledTimes(1);

    tileset.setTiles([tileAt(2, 0, 0)]); // bumps the mock frame number
    source.update(VIEWPORT);
    expect(tileset.getVisibleTiles).toHaveBeenCalledTimes(2);
  });

  it('unregister stops delivery and is leak-free against re-registration', () => {
    const { source, tileset } = makeAttachedSource();
    const a = vi.fn();
    const b = vi.fn();
    const unregisterA = source.registerConsumer({ id: 'a', onTilesChanged: a });
    source.registerConsumer({ id: 'b', onTilesChanged: b });

    unregisterA();
    unregisterA(); // double-unregister is safe
    tileset.setTiles([tileAt(2, 0, 0)]);
    source.update(VIEWPORT);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);

    // Replace-by-id: a stale unregister from the OLD registration must not
    // evict the replacement.
    const b2 = vi.fn();
    const unregisterB1 = source.registerConsumer({
      id: 'b',
      onTilesChanged: b2,
    });
    void unregisterB1;
    const staleUnregister = unregisterA; // already-dead handle, exercise no-op
    staleUnregister();
    const b3 = vi.fn();
    const unregisterB2Old = source.registerConsumer({
      id: 'b',
      onTilesChanged: b3,
    });
    void unregisterB2Old;
    tileset.setTiles([tileAt(2, 1, 1)]);
    source.update(VIEWPORT);
    expect(b).toHaveBeenCalledTimes(1); // replaced entry received nothing new
    expect(b3).toHaveBeenCalledTimes(2); // seeded at register + the change
  });

  it('a stale unregister cannot evict a same-id replacement', () => {
    const { source, tileset } = makeAttachedSource();
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = source.registerConsumer({
      id: 'x',
      onTilesChanged: first,
    });
    source.registerConsumer({ id: 'x', onTilesChanged: second });
    unregisterFirst(); // must be a no-op: 'x' now belongs to the replacement

    tileset.setTiles([tileAt(2, 0, 0)]);
    source.update(VIEWPORT);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('frame-token dedupe', () => {
  it('beginFrame(): N same-frame updates drive the tileset once', () => {
    const { source, tileset } = makeAttachedSource();
    source.beginFrame();
    source.update(VIEWPORT);
    source.update(VIEWPORT);
    source.update(VIEWPORT);
    expect(tileset.update).toHaveBeenCalledTimes(1);

    source.beginFrame();
    source.update(VIEWPORT);
    expect(tileset.update).toHaveBeenCalledTimes(2);
  });

  it('external frameId dedupes within a frame and re-arms across frames', () => {
    const { source, tileset } = makeAttachedSource();
    source.update(VIEWPORT, 7);
    source.update(VIEWPORT, 7);
    expect(tileset.update).toHaveBeenCalledTimes(1);
    source.update(VIEWPORT, 8);
    expect(tileset.update).toHaveBeenCalledTimes(2);
  });

  it('without beginFrame/frameId every update drives (dedupe unarmed)', () => {
    const { source, tileset } = makeAttachedSource();
    source.update(VIEWPORT);
    source.update(VIEWPORT);
    expect(tileset.update).toHaveBeenCalledTimes(2);
  });

  it('defaults timeWindow to the archive temporalBucketMs and passes a fresh viewport object', () => {
    const { source, tileset } = makeAttachedSource();
    const { timeWindow: _omit, ...noWindow } = VIEWPORT;
    source.update(noWindow);
    expect(tileset.update).toHaveBeenCalledWith(
      expect.objectContaining({ timeWindow: 3_600_000 }),
    );
    // tileset.update retains its viewport argument for seek detection — each
    // drive must hand it a distinct object.
    source.update(noWindow);
    const [first] = tileset.update.mock.calls[0];
    const [second] = tileset.update.mock.calls[1];
    expect(first).not.toBe(second);
  });

  it('update before load/attach is a no-op', () => {
    const source = new SharedTilesetSource('mem://unused.stt');
    expect(() => source.update(VIEWPORT)).not.toThrow();
    expect(source.getVisibleTiles()).toEqual([]);
  });
});

describe('attachTileset re-attach', () => {
  /** Drivable mock with the runway surface so getBufferSource() resolves. */
  function makeRunwayDrivable() {
    let tiles: Tile[] = [];
    let frame = 0;
    return {
      update: vi.fn(() => frame),
      getVisibleTiles: vi.fn(() => tiles),
      finalize: vi.fn(),
      flushPrefetch: vi.fn(),
      getBufferedRunway: vi.fn(() => ({
        simMs: 1,
        bytesPending: 0,
        horizonSimMs: 1,
        complete: true,
      })),
      getBufferedRanges: vi.fn(() => []),
      estimateCost: vi.fn(() => ({ bytes: 0, tiles: 0 })),
      estimateTimeToReadyMs: vi.fn(() => null),
      setTiles(next: Tile[]) {
        tiles = next;
        frame++;
      },
    };
  }

  it('swaps the BufferSource delegate and re-seeds consumers with the new tileset', () => {
    const a = makeRunwayDrivable();
    const b = makeRunwayDrivable();
    const source = new SharedTilesetSource('mem://unused.stt');
    source.attachTileset(a as unknown as DrivableTileset, META);

    const consumer = vi.fn();
    source.registerConsumer({ id: 'c', onTilesChanged: consumer });
    a.setTiles([tileAt(2, 0, 0)]);
    source.update(VIEWPORT);
    expect(consumer).toHaveBeenCalledTimes(1);
    const bsA = source.getBufferSource()!;
    bsA.flushPrefetch();
    expect(a.flushPrefetch).toHaveBeenCalledTimes(1);

    // Replacement holds an address-equal set of DIFFERENT Tile objects — the
    // ordinary diff would suppress it, so re-attach re-seeds unconditionally.
    b.setTiles([tileAt(2, 0, 0)]);
    source.attachTileset(b as unknown as DrivableTileset);
    expect(consumer).toHaveBeenCalledTimes(2);
    expect(consumer).toHaveBeenLastCalledWith(b.getVisibleTiles());

    // A fresh BufferSource delegates to the replacement, not the orphan.
    const bsB = source.getBufferSource()!;
    expect(bsB).not.toBe(bsA);
    bsB.flushPrefetch();
    expect(b.flushPrefetch).toHaveBeenCalledTimes(1);
    expect(a.flushPrefetch).toHaveBeenCalledTimes(1);
    // Attached predecessors belong to their caller — never finalized here.
    expect(a.finalize).not.toHaveBeenCalled();
  });

  it('finalizes a load()-built predecessor (its timers would otherwise leak)', async () => {
    const archive = makeStubArchive();
    const source = new SharedTilesetSource(archive as unknown as STTArchive);
    cleanup.push(() => source.dispose());
    await source.load();
    const built = source.getTileset() as SpatioTemporalTileset;
    const finalizeSpy = vi.spyOn(built, 'finalize');

    const replacement = makeMockTileset();
    source.attachTileset(replacement as unknown as DrivableTileset, META);
    expect(finalizeSpy).toHaveBeenCalledTimes(1);
    expect(source.getTileset()).toBe(replacement);
  });

  it('re-attaching the same tileset instance is a metadata-only no-op', () => {
    const { source, tileset } = makeAttachedSource();
    const consumer = vi.fn();
    source.registerConsumer({ id: 'c', onTilesChanged: consumer });
    source.attachTileset(tileset as unknown as DrivableTileset, META);
    expect(consumer).not.toHaveBeenCalled();
    expect(tileset.finalize).not.toHaveBeenCalled();
  });
});

describe('BufferSource delegation', () => {
  function makeRunwayTileset() {
    const runway: BufferedRunway = {
      simMs: 1234,
      bytesPending: 42,
      horizonSimMs: 30_000,
      complete: false,
    };
    return {
      runway,
      tileset: {
        getBufferedRunway: vi.fn(() => runway),
        getBufferedRanges: vi.fn(() => [{ start: 0, end: 1000 }]),
        estimateCost: vi.fn(() => ({ bytes: 2048, tiles: 3 })),
        estimateTimeToReadyMs: vi.fn(() => 250),
        flushPrefetch: vi.fn(),
        setAnimationState: vi.fn(),
        setInteractive: vi.fn(),
        setPrefetchRunAheadLimit: vi.fn(),
        setBandwidthWeight: vi.fn(),
      } satisfies RunwayTileset,
    };
  }

  it('delegates every BufferSource method to the tileset', () => {
    const { runway, tileset } = makeRunwayTileset();
    const src = new SharedTilesetBufferSource(tileset);

    expect(src.getBufferedRunway(1000, 1, 30_000)).toEqual(runway);
    expect(tileset.getBufferedRunway).toHaveBeenCalledWith(1000, 1, 30_000);

    expect(src.getBufferedRanges({ maxRanges: 4 })).toEqual([
      { start: 0, end: 1000 },
    ]);
    expect(tileset.getBufferedRanges).toHaveBeenCalledWith({ maxRanges: 4 });

    const range = { start: 0, end: 500 };
    expect(src.estimateCost(range)).toEqual({ bytes: 2048, tiles: 3 });
    expect(tileset.estimateCost).toHaveBeenCalledWith(range);
    expect(src.estimateTimeToReadyMs(range)).toBe(250);
    expect(tileset.estimateTimeToReadyMs).toHaveBeenCalledWith(range);

    src.flushPrefetch();
    expect(tileset.flushPrefetch).toHaveBeenCalledTimes(1);
    src.setAnimationState(true, 2);
    expect(tileset.setAnimationState).toHaveBeenCalledWith(true, 2);
    src.setInteractive(true);
    expect(tileset.setInteractive).toHaveBeenCalledWith(true);
    src.setPrefetchRunAheadLimit(60_000);
    expect(tileset.setPrefetchRunAheadLimit).toHaveBeenCalledWith(60_000);
    src.setBandwidthWeight(0.5);
    expect(tileset.setBandwidthWeight).toHaveBeenCalledWith(0.5);
  });

  it('tolerates a tileset without the optional hooks', () => {
    const tileset = {
      getBufferedRunway: vi.fn(() => ({
        simMs: 0,
        bytesPending: 0,
        horizonSimMs: 0,
        complete: true,
      })),
      getBufferedRanges: vi.fn(() => []),
      estimateCost: vi.fn(() => ({ bytes: 0, tiles: 0 })),
      estimateTimeToReadyMs: vi.fn(() => null),
      flushPrefetch: vi.fn(),
    };
    const src = new SharedTilesetBufferSource(tileset as RunwayTileset);
    expect(() => {
      src.setAnimationState(true);
      src.setInteractive(false);
      src.setPrefetchRunAheadLimit(null);
      src.setBandwidthWeight(1);
    }).not.toThrow();
  });

  it('getBufferSource(): null without a runway-capable tileset, cached once resolved', () => {
    const bare = new SharedTilesetSource('mem://unused.stt');
    expect(bare.getBufferSource()).toBeNull();

    // A mock without runway methods stays null (structural narrowing).
    const { source: mockSource } = makeAttachedSource();
    expect(mockSource.getBufferSource()).toBeNull();

    const { tileset } = makeRunwayTileset();
    const source = new SharedTilesetSource('mem://unused.stt');
    source.attachTileset(tileset as unknown as DrivableTileset, META);
    const bs = source.getBufferSource();
    expect(bs).toBeInstanceOf(SharedTilesetBufferSource);
    expect(source.getBufferSource()).toBe(bs);
  });
});

describe('load path (stub archive → real SpatioTemporalTileset)', () => {
  it('builds a tileset with base-layer-parity options and adapter callbacks', async () => {
    const archive = makeStubArchive();
    const source = new SharedTilesetSource(archive as unknown as STTArchive);
    cleanup.push(() => source.dispose());
    await source.load();

    const tileset = source.getTileset();
    expect(tileset).toBeInstanceOf(SpatioTemporalTileset);
    expect(source.getMetadata()).toBe(META);
    expect(source.getArchive()).toBe(archive);

    const options = (tileset as unknown as { options: Record<string, unknown> })
      .options;
    expect(options.refinementStrategy).toBe('best-available');
    expect(options.getTileDataBatch).toBeTypeOf('function');
    expect(options.getTileByteSize).toBeTypeOf('function');
    expect(options.onTileLoad).toBeTypeOf('function');
    expect(options.onTileUnload).toBeTypeOf('function');
    expect(options.minZoom).toBe(0);
    expect(options.maxZoom).toBe(5);
    expect(options.temporalBucketMs).toBe(3_600_000);

    expect(source.getBufferSource()).toBeInstanceOf(SharedTilesetBufferSource);
  });

  /**
   * The unload hook re-derived the resident set from INSIDE the callback, and
   * core fires it while the header is still in `this.tiles`
   * (`spatiotemporal-tileset.ts` `evictTiles`: callback, then `tiles.delete`).
   * The re-derived set therefore still contained the evicted tile, so
   * `residentSetEqual` reported "unchanged" and the correction never went out
   * at all — every consumer kept drawing a tile whose data was gone.
   */
  it('an evicted tile leaves the published set (core deletes the header AFTER the callback)', async () => {
    const archive = makeStubArchive();
    const source = new SharedTilesetSource(archive as unknown as STTArchive);
    cleanup.push(() => source.dispose());
    await source.load();
    const tileset = source.getTileset() as any;

    const doomed = tileAt(4, 3, 5);
    const survivor = tileAt(4, 4, 5);
    seedResidentTiles(tileset, doomed, survivor);

    const cb = vi.fn();
    source.registerConsumer({ id: 'a', onTilesChanged: cb });
    (source as unknown as { publishIfChanged(): void }).publishIfChanged();
    expect(cb).toHaveBeenCalledTimes(1);

    tileset.evictTiles([coreTileKey(doomed.id)]);
    await Promise.resolve();

    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1][0]).toEqual([survivor]);
  });

  it('coalesces a batch of arrivals into ONE resident-set walk', async () => {
    const archive = makeStubArchive();
    const source = new SharedTilesetSource(archive as unknown as STTArchive);
    cleanup.push(() => source.dispose());
    await source.load();
    const tileset = source.getTileset() as any;

    // The range coalescer delivers a whole coalesced group, so `onTileLoad`
    // fires in bursts; publishing inline cost a getVisibleTiles() + address
    // diff per tile.
    const visible = vi.spyOn(tileset, 'getVisibleTiles');
    for (let i = 0; i < 8; i++) tileset.options.onTileLoad(tileAt(4, i, 5));
    expect(visible).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(visible).toHaveBeenCalledTimes(1);
  });

  it('load() is idempotent (one metadata read, one tileset)', async () => {
    const archive = makeStubArchive();
    const source = new SharedTilesetSource(archive as unknown as STTArchive);
    cleanup.push(() => source.dispose());
    await Promise.all([source.load(), source.load()]);
    await source.load();
    expect(archive.getMetadata).toHaveBeenCalledTimes(1);
  });

  it('fans onBufferChange out to the source option and every consumer', async () => {
    const archive = makeStubArchive();
    const sourceLevel = vi.fn();
    const source = new SharedTilesetSource(archive as unknown as STTArchive, {
      onBufferChange: sourceLevel,
    });
    cleanup.push(() => source.dispose());
    await source.load();

    const consumerLevel = vi.fn();
    source.registerConsumer({
      id: 'a',
      onTilesChanged: () => undefined,
      onBufferChange: consumerLevel,
    });

    const runway = {
      simMs: 500,
      bytesPending: 0,
      horizonSimMs: 30_000,
      complete: false,
    };
    const options = (
      source.getTileset() as unknown as {
        options: { onBufferChange: (r: unknown) => void };
      }
    ).options;
    options.onBufferChange(runway);
    expect(sourceLevel).toHaveBeenCalledWith(runway);
    expect(consumerLevel).toHaveBeenCalledWith(runway);
  });

  it('dispose() finalizes tileset + owned archive and silences consumers', async () => {
    const archive = makeStubArchive();
    const source = new SharedTilesetSource(archive as unknown as STTArchive);
    await source.load();
    const tileset = source.getTileset() as SpatioTemporalTileset;
    const finalizeSpy = vi.spyOn(tileset, 'finalize');

    const cb = vi.fn();
    source.registerConsumer({ id: 'a', onTilesChanged: cb });
    source.dispose();
    source.dispose(); // idempotent

    expect(finalizeSpy).toHaveBeenCalledTimes(1);
    expect(archive.finalize).toHaveBeenCalledTimes(1);
    expect(source.getTileset()).toBeNull();
    expect(source.getBufferSource()).toBeNull();

    // Post-dispose registration is inert and update() is a no-op.
    const late = vi.fn();
    const unregister = source.registerConsumer({
      id: 'late',
      onTilesChanged: late,
    });
    unregister();
    expect(() => source.update(VIEWPORT)).not.toThrow();
    expect(cb).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
  });

  it('dispose during the metadata await aborts init without leaking a tileset', async () => {
    const archive = makeStubArchive();
    let resolveMeta!: (m: unknown) => void;
    archive.getMetadata = vi.fn(
      () =>
        new Promise((res) => {
          resolveMeta = res;
        }) as Promise<ArchiveMetadata>,
    );
    const source = new SharedTilesetSource(archive as unknown as STTArchive);

    const loading = source.load();
    source.dispose();
    resolveMeta(META);
    await loading;

    expect(source.getTileset()).toBeNull();
    // Finalized exactly once despite dispose() and the _load guard both racing.
    expect(archive.finalize).toHaveBeenCalledTimes(1);
  });

  it('ownsArchive: false leaves a caller-shared archive alive on dispose', async () => {
    const archive = makeStubArchive();
    const source = new SharedTilesetSource(archive as unknown as STTArchive, {
      ownsArchive: false,
    });
    await source.load();
    source.dispose();
    expect(archive.finalize).not.toHaveBeenCalled();
  });
});

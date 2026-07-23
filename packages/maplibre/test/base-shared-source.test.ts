/**
 * Shared-source wiring tests (D6a integration): `STTBaseLayer` constructed
 * with `{ source: SharedTilesetSource }` instead of `{ url }`:
 *
 *   - constructor validation (exactly one of url/source)
 *   - onAdd registers a consumer; the source's tileset is adopted and
 *     onTilesetReady fires with the SHARED tileset
 *   - late-add seeding: a source with resident tiles populates the layer
 *     synchronously at onAdd
 *   - replace-all fan-out drives loadedTiles and sweeps GPU caches for
 *     evicted tiles
 *   - beginFrame routes the viewport through source.update (unarmed dedupe)
 *   - onBufferChange fan-out reaches the layer option
 *   - onRemove unregisters WITHOUT finalizing the shared tileset/archive;
 *     a removal during the source's metadata await adopts nothing
 */

import { describe, it, expect, vi } from 'vitest';
import {
  GeometryType,
  type ArchiveMetadata,
  type STTArchive,
  type Tile,
} from '@poopdeck.gl/core';
import { STTBaseLayer, type DrawContext } from '../src/base-layer';
import {
  SharedTilesetSource,
  type DrivableTileset,
} from '../src/lib/streaming-source';
import { makeMockGl } from './mock-gl';
import { MockMap } from './mock-map';
import { makePointTile } from './fixtures';

const META = {
  minZoom: 0,
  maxZoom: 5,
  temporalBucketMs: 3_600_000,
} as unknown as ArchiveMetadata;

const baseOpts = {
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

/** Minimal concrete subclass (mirrors base-lifecycle's TestLayer). */
class TestLayer extends STTBaseLayer {
  lastCtx?: DrawContext;

  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.Point;
  }

  protected onContextReady(): void {}

  protected onContextLost(): void {}

  protected drawTile(
    _gl: WebGLRenderingContext | WebGL2RenderingContext,
    _tile: Tile,
    _layer: unknown,
    _cache: unknown,
    ctx: DrawContext,
  ): void {
    this.lastCtx = ctx;
  }
}

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

const VIEWPORT = {
  bounds: { minLon: -120, minLat: 20, maxLon: -60, maxLat: 50 },
  zoom: 3,
  time: 1_700_000_001_000,
  timeWindow: 5000,
};

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('constructor validation', () => {
  it('rejects url + source together, and neither', () => {
    const { source } = makeAttachedSource();
    expect(
      () => new TestLayer({ ...baseOpts, id: 'x', url: 'mem://t.stt', source }),
    ).toThrow(/not both/);
    expect(() => new TestLayer({ ...baseOpts, id: 'x' })).toThrow(
      /url or source/,
    );
  });

  it('source-only construction builds NO private archive', () => {
    const { source } = makeAttachedSource();
    const layer = new TestLayer({ ...baseOpts, id: 'x', source }) as any;
    expect(layer.archive).toBeUndefined();
    expect(layer.source).toBe(source);
  });
});

describe('shared-source lifecycle', () => {
  async function addedLayer(id = 'shared-a') {
    const { source, tileset } = makeAttachedSource();
    const gl = makeMockGl();
    const map = new MockMap(gl);
    const onTilesetReady = vi.fn();
    const onBufferChange = vi.fn();
    const layer = new TestLayer({
      ...baseOpts,
      id,
      source,
      onTilesetReady,
      onBufferChange,
    }) as any;
    map.addLayer(layer);
    await tick(); // let initSharedSource resolve
    return { source, tileset, gl, map, layer, onTilesetReady, onBufferChange };
  }

  it('adopts the shared tileset and fires onTilesetReady with it', async () => {
    const { tileset, layer, onTilesetReady } = await addedLayer();
    expect(layer.getTileset()).toBe(tileset);
    expect(onTilesetReady).toHaveBeenCalledTimes(1);
    expect(onTilesetReady).toHaveBeenCalledWith(tileset);
    expect(layer.metadata).toBe(META);
  });

  it('N layers over one source adopt the SAME tileset instance', async () => {
    const { source, tileset, map } = await addedLayer('shared-a');
    const ready = vi.fn();
    const layerB = new TestLayer({
      ...baseOpts,
      id: 'shared-b',
      source,
      onTilesetReady: ready,
    });
    map.addLayer(layerB);
    await tick();
    expect(ready).toHaveBeenCalledWith(tileset);
    expect(layerB.getTileset()).toBe(tileset as any);
  });

  it('replace-all fan-out drives loadedTiles; a late-added layer is seeded synchronously', async () => {
    const { source, tileset, map, layer } = await addedLayer();
    const set1 = [tileAt(2, 0, 0), tileAt(2, 1, 0)];
    tileset.setTiles(set1);
    source.update(VIEWPORT);
    expect([...layer.loadedTiles.keys()].sort()).toEqual([
      '2/0/0/1700000000000',
      '2/1/0/1700000000000',
    ]);

    // Second layer added AFTER tiles are resident: seeded during onAdd,
    // before any update() of its own.
    const layerB = new TestLayer({
      ...baseOpts,
      id: 'shared-late',
      source,
    }) as any;
    map.addLayer(layerB);
    expect(layerB.loadedTiles.size).toBe(2);
  });

  it('eviction sweeps the evicted tile GPU caches (variant-suffixed keys too)', async () => {
    const { source, tileset, gl, layer } = await addedLayer();
    tileset.setTiles([tileAt(2, 0, 0), tileAt(2, 1, 0)]);
    source.update(VIEWPORT);

    const mkCache = () => ({
      positionBuffer: {},
      timeBuffer: {},
      vertexCount: 1,
      indexCount: 0,
      timeOffset: 0,
    });
    layer.tileGpuCache.set('2/0/0/1700000000000::points::0', mkCache());
    // Line-layer-style globe variant key under the same tile prefix.
    layer.tileGpuCache.set(
      '2/0/0/1700000000000::points::0::globe:512',
      mkCache(),
    );
    layer.tileGpuCache.set('2/1/0/1700000000000::points::0', mkCache());

    gl.deleteBuffer.mockClear();
    tileset.setTiles([tileAt(2, 1, 0)]); // 2/0/0 leaves the resident set
    source.update({ ...VIEWPORT, time: VIEWPORT.time + 1 });

    expect(layer.loadedTiles.size).toBe(1);
    expect([...layer.tileGpuCache.keys()]).toEqual([
      '2/1/0/1700000000000::points::0',
    ]);
    expect(gl.deleteBuffer).toHaveBeenCalled();
  });

  it('beginFrame routes the viewport through source.update (tileset driven once, unarmed)', async () => {
    const { source, tileset, gl, layer } = await addedLayer();
    const updateSpy = vi.spyOn(source, 'update');
    layer.render(
      gl,
      Array.from({ length: 16 }, () => 1),
    );
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const viewport = updateSpy.mock.calls[0][0];
    expect(viewport.time).toBe(baseOpts.currentTime);
    expect(viewport.timeWindow).toBe(baseOpts.timeWindow);
    // The source drove the underlying tileset with the same viewport.
    expect(tileset.update).toHaveBeenCalledWith(
      expect.objectContaining({ time: baseOpts.currentTime }),
    );
  });

  it('onBufferChange fan-out reaches the layer option', async () => {
    const { source, onBufferChange } = await addedLayer();
    const runway = { simMs: 1234, bytesPending: 0, horizonSimMs: 30_000 };
    (source as any).handleBufferChange(runway);
    expect(onBufferChange).toHaveBeenCalledWith(runway);
  });

  it('onRemove unregisters but does NOT finalize the shared tileset', async () => {
    const { source, tileset, map, layer } = await addedLayer();
    tileset.setTiles([tileAt(2, 0, 0)]);
    source.update(VIEWPORT);
    expect(layer.loadedTiles.size).toBe(1);

    map.removeLayer('shared-a');
    expect(tileset.finalize).not.toHaveBeenCalled();
    expect(layer.getTileset()).toBeUndefined();
    expect(layer.loadedTiles.size).toBe(0);

    // Unregistered: later publishes must not resurrect the removed layer.
    tileset.setTiles([tileAt(2, 0, 0), tileAt(2, 1, 0)]);
    source.update({ ...VIEWPORT, time: VIEWPORT.time + 2 });
    expect(layer.loadedTiles.size).toBe(0);
  });

  it('a removal during the source metadata await adopts nothing', async () => {
    let resolveMeta!: (m: unknown) => void;
    const archiveStub = {
      getMetadata: vi.fn(
        () =>
          new Promise((res) => {
            resolveMeta = res;
          }),
      ),
      finalize: vi.fn(),
    };
    const source = new SharedTilesetSource(
      archiveStub as unknown as STTArchive,
      { ownsArchive: false },
    );
    const gl = makeMockGl();
    const map = new MockMap(gl);
    const onTilesetReady = vi.fn();
    const layer = new TestLayer({
      ...baseOpts,
      id: 'race',
      source,
      onTilesetReady,
    }) as any;
    map.addLayer(layer);
    map.removeLayer('race'); // while getMetadata is still pending
    resolveMeta(META);
    await tick();

    expect(onTilesetReady).not.toHaveBeenCalled();
    expect(layer.getTileset()).toBeUndefined();
    // The shared archive is never the layer's to finalize.
    expect(archiveStub.finalize).not.toHaveBeenCalled();
    source.dispose();
  });

  it('ready() resolves the shared metadata', async () => {
    const { layer } = await addedLayer();
    await expect(layer.ready()).resolves.toBe(META);
  });

  it('remove + re-add during the shared load fires onTilesetReady once (init generation)', async () => {
    let resolveMeta!: (m: unknown) => void;
    const archiveStub = {
      getMetadata: vi.fn(
        () =>
          new Promise((res) => {
            resolveMeta = res;
          }),
      ),
      finalize: vi.fn(),
    };
    const source = new SharedTilesetSource(
      archiveStub as unknown as STTArchive,
      { ownsArchive: false },
    );
    const gl = makeMockGl();
    const map = new MockMap(gl);
    const onTilesetReady = vi.fn();
    const layer = new TestLayer({
      ...baseOpts,
      id: 'readd',
      source,
      onTilesetReady,
    }) as any;
    map.addLayer(layer); // init #1 parks on source.load()
    map.removeLayer('readd'); // generation bump — init #1 is now stale
    map.addLayer(layer); // init #2 shares the same in-flight load
    resolveMeta(META);
    await tick();

    // Only init #2 publishes — the documented "called once per init"
    // contract. Pre-fix, init #1's continuation saw the re-add's restored
    // `map` and published a second time.
    expect(onTilesetReady).toHaveBeenCalledTimes(1);
    expect(layer.getTileset()).toBe(source.getTileset());
    map.removeLayer('readd');
    source.dispose();
  });
});

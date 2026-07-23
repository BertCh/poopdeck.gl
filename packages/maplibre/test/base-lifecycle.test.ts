/**
 * Base-layer lifecycle tests (D12):
 *
 *   - attach()/detach(): styledata guard re-adds the layer after a style
 *     diff-fallback rebuild destroys it, idempotently (no re-add storms),
 *     and detach disarms the guard so nothing resurrects the layer.
 *   - Context loss/restore: on loss every GPU reference is dropped WITHOUT
 *     GL delete calls; on restore programs rebuild and tile caches rebuild
 *     lazily.
 *   - render() signature dispatch through the base class: legacy matrix,
 *     v4.6 options arg, v5 args object all flow into the scratch HostFrame
 *     handed to drawTile, and camera params are stashed for pick math.
 */

import { describe, it, expect, vi } from 'vitest';
import { GeometryType, type Tile } from '@poopdeck.gl/core';
import {
  STTBaseLayer,
  type DrawContext,
  type STTBaseLayerOptions,
} from '../src/base-layer';
import { makeMockGl } from './mock-gl';
import { MockMap } from './mock-map';
import { makePointTile } from './fixtures';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

/** Minimal concrete subclass exposing hook-call counters and the last ctx. */
class TestLayer extends STTBaseLayer {
  contextReadyCount = 0;
  contextLostCount = 0;
  lastCtx?: DrawContext;

  constructor(opts: STTBaseLayerOptions) {
    super(opts);
  }

  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.Point;
  }

  protected onContextReady(): void {
    this.contextReadyCount++;
  }

  protected onContextLost(): void {
    this.contextLostCount++;
  }

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

/** Stub the archive surface initTileset consumes (same as tileset-wiring). */
function makeStubArchive() {
  return {
    getMetadata: vi.fn(async () => ({
      minZoom: 0,
      maxZoom: 5,
      temporalBucketMs: 3_600_000,
    })),
    getTileIdsInBounds: vi.fn(() => []),
    getTile: vi.fn(async () => null),
    getTiles: vi.fn(async (ids: unknown[]) => ids.map(() => null)),
    getTileByteSize: vi.fn(() => 4096),
    getThroughputEstimate: vi.fn(() => ({ bytesPerMs: 5, samples: 3 })),
    finalize: vi.fn(),
  };
}

function makeLayer(id = 'stt-test', extra: Partial<STTBaseLayerOptions> = {}) {
  const layer = new TestLayer({ ...baseOpts, id, ...extra }) as any;
  layer.archive = makeStubArchive();
  return layer;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('attach / detach + styledata guard', () => {
  it('attach adds the layer once; further styledata events do not re-add', async () => {
    const map = new MockMap(makeMockGl());
    const layer = makeLayer();
    layer.attach(map as any);
    expect(map.getLayer('stt-test')).toBeDefined();
    expect(map.addLayerSpy).toHaveBeenCalledTimes(1);

    map.fire('styledata');
    map.fire('styledata');
    expect(map.addLayerSpy).toHaveBeenCalledTimes(1); // idempotent — no storm
    await tick();
    layer.detach();
  });

  it('attach honours beforeId', () => {
    const map = new MockMap(makeMockGl());
    map.addLayer({ id: 'water' });
    map.addLayer({ id: 'labels' });
    const layer = makeLayer();
    layer.attach(map as any, { beforeId: 'labels' });
    expect(map.getLayerOrder()).toEqual(['water', 'stt-test', 'labels']);
    layer.detach();
  });

  it('a style diff-fallback rebuild drops the layer; the guard re-adds it', async () => {
    const map = new MockMap(makeMockGl());
    const layer = makeLayer();
    layer.attach(map as any);
    await tick();
    expect(layer.contextReadyCount).toBe(1);

    map.simulateStyleRebuild();
    expect(map.getLayer('stt-test')).toBeDefined();
    expect(map.addLayerSpy).toHaveBeenCalledTimes(2);
    // onAdd re-ran on the re-added layer, so GL resources were rebuilt.
    expect(layer.contextReadyCount).toBe(2);
    await tick();
    // The re-added layer re-initialized its tileset (onRemove finalized the
    // previous one).
    expect(layer.getTileset()).toBeDefined();
    layer.detach();
  });

  it('attach on a still-loading style defers the add until styledata', () => {
    const map = new MockMap(makeMockGl());
    map.style._loaded = false;
    const layer = makeLayer();
    layer.attach(map as any);
    expect(map.getLayer('stt-test')).toBeUndefined();

    map.style._loaded = true;
    map.fire('styledata');
    expect(map.getLayer('stt-test')).toBeDefined();
    layer.detach();
  });

  it('detach removes the layer and nothing resurrects it', () => {
    const map = new MockMap(makeMockGl());
    const layer = makeLayer();
    layer.attach(map as any);
    layer.detach();
    expect(map.getLayer('stt-test')).toBeUndefined();

    map.fire('styledata');
    map.simulateStyleRebuild();
    expect(map.getLayer('stt-test')).toBeUndefined();
    expect(map.addLayerSpy).toHaveBeenCalledTimes(1); // only the original add
    // Repeated detach is safe.
    layer.detach();
  });

  it('plain map.addLayer without attach gets NO auto re-add', () => {
    const map = new MockMap(makeMockGl());
    const layer = makeLayer();
    map.addLayer(layer);
    map.simulateStyleRebuild();
    expect(map.getLayer('stt-test')).toBeUndefined();
  });

  it('attach on a style-less map defers instead of throwing; setStyle completes it', () => {
    const map = new MockMap(makeMockGl());
    map.style = undefined; // Map constructed without the optional `style`
    const layer = makeLayer();
    expect(() => layer.attach(map as any)).not.toThrow();
    expect(map.addLayerSpy).not.toHaveBeenCalled();

    map.style = { _loaded: true }; // the app's eventual setStyle finished
    map.fire('styledata');
    expect(map.getLayer('stt-test')).toBeDefined();
    layer.detach();
  });

  it('re-attach with a new beforeId repositions the already-present layer', () => {
    const map = new MockMap(makeMockGl());
    map.addLayer({ id: 'water' });
    map.addLayer({ id: 'labels' });
    const layer = makeLayer();
    layer.attach(map as any);
    expect(map.getLayerOrder()).toEqual(['water', 'labels', 'stt-test']);
    map.addLayerSpy.mockClear();

    layer.attach(map as any, { beforeId: 'labels' });
    expect(map.getLayerOrder()).toEqual(['water', 'stt-test', 'labels']);
    expect(map.addLayerSpy).not.toHaveBeenCalled(); // moved, not re-added

    // Dropping the anchor moves back to top (addLayer-parity semantics).
    layer.attach(map as any);
    expect(map.getLayerOrder()).toEqual(['water', 'labels', 'stt-test']);
    layer.detach();
  });
});

describe('double-init hardening (init generation)', () => {
  it('a v4.7-style rebuild (no onRemove) re-adds without re-initializing', async () => {
    const map = new MockMap(makeMockGl());
    const onTilesetReady = vi.fn();
    const layer = makeLayer('stt-test', { onTilesetReady });
    layer.attach(map as any);
    await tick();
    expect(layer.contextReadyCount).toBe(1);
    expect(onTilesetReady).toHaveBeenCalledTimes(1);
    const tileset = layer.getTileset();
    expect(tileset).toBeDefined();

    // Real v4.7 diff-fallback: Style._remove never calls custom-layer
    // onRemove, then the styledata guard re-adds the still-initialized layer.
    map.simulateStyleRebuild({ fireOnRemove: false });
    expect(map.getLayer('stt-test')).toBeDefined();
    await tick();
    // Same live context ⇒ onAdd short-circuits: no second onContextReady
    // (would leak subclass GPU handles), no orphaned second tileset, no
    // duplicate onTilesetReady into the governor.
    expect(layer.contextReadyCount).toBe(1);
    expect(layer.getTileset()).toBe(tileset);
    expect(onTilesetReady).toHaveBeenCalledTimes(1);
    expect(layer.archive.getMetadata).toHaveBeenCalledTimes(1);
    layer.detach();
  });

  it('remove + re-add during the metadata await builds one tileset, fires onTilesetReady once', async () => {
    const map = new MockMap(makeMockGl());
    const onTilesetReady = vi.fn();
    const layer = makeLayer('race2', { onTilesetReady });
    const pending: Array<(m: unknown) => void> = [];
    layer.archive.getMetadata = vi.fn(
      () =>
        new Promise((res) => {
          pending.push(res);
        }),
    );
    map.addLayer(layer); // init #1 parks on getMetadata
    map.removeLayer('race2'); // generation bump — init #1 is now stale
    map.addLayer(layer); // init #2 starts its own metadata read
    for (const res of pending) {
      res({ minZoom: 0, maxZoom: 5, temporalBucketMs: 3_600_000 });
    }
    await tick();

    // init #1 aborted at its generation check (pre-fix it resumed because the
    // re-add restored `map`, publishing a never-finalized orphan tileset and
    // firing onTilesetReady twice).
    expect(onTilesetReady).toHaveBeenCalledTimes(1);
    expect(layer.getTileset()).toBeDefined();
    expect(onTilesetReady).toHaveBeenCalledWith(layer.getTileset());
    map.removeLayer('race2');
  });

  it('map.remove() (which never calls onRemove) still tears the layer down', async () => {
    const gl = makeMockGl();
    const map = new MockMap(gl);
    const layer = makeLayer('stt-rm');
    layer.attach(map as any);
    await tick();
    const tileset = layer.getTileset();
    expect(tileset).toBeDefined();
    const finalizeSpy = vi.spyOn(tileset, 'finalize');

    map.remove();
    // Full teardown ran off the terminal 'remove' event: tileset + archive
    // finalized, resident state dropped, canvas listeners detached.
    expect(finalizeSpy).toHaveBeenCalledTimes(1);
    expect(layer.archive.finalize).toHaveBeenCalledTimes(1);
    expect(layer.getTileset()).toBeUndefined();
    expect(layer.loadedTiles.size).toBe(0);
    const removed = map
      .getCanvas()
      .removeEventListener.mock.calls.map((c: unknown[]) => c[0]);
    expect(removed).toContain('webglcontextlost');
    expect(removed).toContain('webglcontextrestored');
    // detach() after map.remove() (style-less map) must not throw.
    expect(() => layer.detach()).not.toThrow();
    // Nothing resurrects the layer on a later styledata.
    map.style = { _loaded: true };
    map.fire('styledata');
    expect(map.addLayerSpy).toHaveBeenCalledTimes(1);
  });
});

describe('context loss / restore', () => {
  it('loss drops every GPU reference without GL deletes; restore rebuilds programs', async () => {
    const gl = makeMockGl();
    const map = new MockMap(gl);
    const layer = makeLayer();
    map.addLayer(layer);
    await tick();

    // Seed base-owned GPU state: a tile cache, a cached program, the pick FBO
    // fields and the unit quad.
    layer.tileGpuCache.set('k', {
      positionBuffer: {},
      timeBuffer: {},
      vertexCount: 1,
      indexCount: 0,
      timeOffset: 0,
    });
    layer.getOrCreateProgram(gl, 'main', layer.hostFrame, () => ({
      program: { id: 1 },
    }));
    layer.getUnitQuad(gl);
    expect(layer.programCache.size).toBe(1);

    gl.deleteBuffer.mockClear();
    gl.deleteProgram.mockClear();
    gl.deleteFramebuffer.mockClear();
    map.getCanvas().dispatch('webglcontextlost');

    expect(layer.contextLost).toBe(true);
    expect(layer.tileGpuCache.size).toBe(0);
    expect(layer.programCache.size).toBe(0);
    expect(layer.unitQuadBuffer).toBeUndefined();
    expect(layer.contextLostCount).toBe(1); // subclass handles nulled too
    // No GL frees on a dead context.
    expect(gl.deleteBuffer).not.toHaveBeenCalled();
    expect(gl.deleteProgram).not.toHaveBeenCalled();
    expect(gl.deleteFramebuffer).not.toHaveBeenCalled();

    // render() bails while the context is lost — no frame is stashed.
    layer.render(gl, new Float32Array(16));
    expect(layer.lastMatrix).toBeUndefined();

    map.triggerRepaint.mockClear();
    map.getCanvas().dispatch('webglcontextrestored');
    expect(layer.contextLost).toBe(false);
    expect(layer.contextReadyCount).toBe(2); // programs rebuilt
    expect(map.triggerRepaint).toHaveBeenCalled();
    layer.detach?.();
    map.removeLayer('stt-test');
  });

  it('onRemove skips GL frees when the context is lost', async () => {
    const gl = makeMockGl();
    const map = new MockMap(gl);
    const layer = makeLayer();
    map.addLayer(layer);
    await tick();
    layer.contextLost = true;
    layer.tileGpuCache.set('k', {
      positionBuffer: {},
      timeBuffer: {},
      vertexCount: 1,
      indexCount: 0,
      timeOffset: 0,
    });
    gl.deleteBuffer.mockClear();
    map.removeLayer('stt-test');
    expect(gl.deleteBuffer).not.toHaveBeenCalled();
    expect(layer.tileGpuCache.size).toBe(0);
  });

  it('onRemove detaches the canvas context-loss listeners', async () => {
    const gl = makeMockGl();
    const map = new MockMap(gl);
    const layer = makeLayer();
    map.addLayer(layer);
    await tick();
    map.removeLayer('stt-test');
    const removed = map
      .getCanvas()
      .removeEventListener.mock.calls.map((c: unknown[]) => c[0]);
    expect(removed).toContain('webglcontextlost');
    expect(removed).toContain('webglcontextrestored');
    // A loss event after removal must not touch the removed layer.
    layer.contextLostCount = 0;
    map.getCanvas().dispatch('webglcontextlost');
    expect(layer.contextLostCount).toBe(0);
  });
});

describe('render() signature dispatch', () => {
  async function renderableLayer() {
    const gl = makeMockGl();
    const map = new MockMap(gl);
    const layer = makeLayer();
    map.addLayer(layer);
    await tick(); // let initTileset resolve
    const tile = makePointTile();
    layer.loadedTiles.set('2/1/1/0', tile);
    return { gl, map, layer };
  }

  it('legacy matrix: drawTile receives a legacy-mode frame aliasing ctx.matrix', async () => {
    const { gl, layer } = await renderableLayer();
    const m = Array.from({ length: 16 }, (_, i) => i * 2);
    layer.render(gl, m);
    const ctx = layer.lastCtx!;
    expect(ctx.frame?.mode).toBe('legacy');
    expect(ctx.matrix).toBe(ctx.frame!.matrix);
    expect(Array.from(ctx.matrix)).toEqual(m);
    expect(layer.lastMatrix).toBe(ctx.matrix);
    expect(layer.lastFov).toBeUndefined();
    // Default fov fallback for pick math.
    expect(layer.getCameraParams().fovRadians).toBeCloseTo(0.6435, 3);
  });

  it('v4.6 options arg: camera params are stashed', async () => {
    const { gl, layer } = await renderableLayer();
    layer.render(
      gl,
      Array.from({ length: 16 }, () => 1),
      {
        fov: 0.7,
        nearZ: 2,
        farZ: 9000,
      },
    );
    expect(layer.lastFov).toBe(0.7);
    expect(layer.getCameraParams()).toEqual({
      fovRadians: 0.7,
      nearZ: 2,
      farZ: 9000,
    });
  });

  it('v5 args object: drawTile receives a v5 frame with projectionData + shader variant', async () => {
    const { gl, layer } = await renderableLayer();
    layer.render(gl, {
      farZ: 4096,
      nearZ: 0.5,
      fov: 0.6,
      shaderData: {
        variantName: 'globe',
        vertexShaderPrelude: 'uniform mat4 u_projection_matrix;',
        define: '#define GLOBE',
      },
      defaultProjectionData: {
        mainMatrix: Array.from({ length: 16 }, (_, i) => i),
        tileMercatorCoords: [0, 0, 1, 1],
        clippingPlane: [0, 0, 0, 0],
        projectionTransition: 1,
        fallbackMatrix: Array.from({ length: 16 }, () => 0),
      },
    });
    const frame = layer.lastCtx!.frame!;
    expect(frame.mode).toBe('v5');
    expect(frame.isGlobe).toBe(true);
    expect(frame.shader.variantName).toBe('globe');
    expect(Array.from(layer.lastMatrix!)).toEqual(
      Array.from({ length: 16 }, (_, i) => i),
    );
    expect(layer.lastFov).toBe(0.6);
    // The SAME scratch frame flips back to legacy on the next legacy call.
    layer.render(
      gl,
      Array.from({ length: 16 }, () => 3),
    );
    expect(layer.lastCtx!.frame).toBe(frame);
    expect(frame.mode).toBe('legacy');
    expect(frame.projectionData).toBeUndefined();
  });
});

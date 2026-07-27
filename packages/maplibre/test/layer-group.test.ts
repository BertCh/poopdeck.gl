/**
 * STTLayerGroup (campaign D6b) — one MapLibre custom layer hosting an ordered
 * list of STT layers, driving them in a single render pass.
 *
 * These exercise the group's OWN contract against the mock map/gl lifecycle:
 *
 *   - CustomLayerInterface shape (type/id/renderingMode/slot) + conditional
 *     prerender install.
 *   - onAdd initializes every child WITHOUT registering it as a map layer
 *     (children render through the group), and onRemove tears them all down.
 *   - render/prerender forward the SAME host args to each child in draw order.
 *   - Repaint coalescing: children route their repaints through the group's
 *     single hook, and a group-level time advance fires ONE real repaint.
 *   - attach()/detach() styledata guard (beforeId ordering, rebuild survival).
 *   - pick() dispatch (topmost-first, skip non-pickable) — the GL round-trip is
 *     the child's own browser-verify concern, so only the dispatch is unit-checked.
 */

import { describe, it, expect, vi } from 'vitest';
import { GeometryType, type Tile } from '@poopdeck.gl/core';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import {
  STTBaseLayer,
  type DrawContext,
  type STTBaseLayerOptions,
} from '../src/base-layer';
import { STTLayerGroup } from '../src/layer-group';
import { makeMockGl, publishVisibleTiles } from './mock-gl';
import { MockMap } from './mock-map';
import { makePointTile } from './fixtures';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

/** Stub the archive surface initTileset consumes (same as base-lifecycle). */
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

/** Minimal concrete point child with a stub archive and a draw counter. */
class TestChild extends STTBaseLayer {
  drawCount = 0;
  constructor(opts: STTBaseLayerOptions) {
    super(opts);
    (this as unknown as { archive: unknown }).archive = makeStubArchive();
  }
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
    _ctx: DrawContext,
  ): void {
    this.drawCount++;
  }
}

/** A 3d child, to prove the group's renderingMode lifts to '3d'. */
class ThreeDChild extends TestChild {
  readonly renderingMode = '3d' as const;
}

/** A child that exposes an offscreen pass hook. */
class PrerenderChild extends TestChild {
  prerender = vi.fn();
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const opts = (id: string) => ({ ...baseOpts, id });
const anyOf = (l: STTBaseLayer) =>
  l as unknown as { map?: unknown; gl?: unknown; opts: STTBaseLayerOptions };

describe('STTLayerGroup — CustomLayerInterface shape', () => {
  it('is a custom layer with the given id and 2d renderingMode by default', () => {
    const group = new STTLayerGroup({
      id: 'grp',
      layers: [new TestChild(opts('a')), new TestChild(opts('b'))],
    });
    expect(group.type).toBe('custom');
    expect(group.id).toBe('grp');
    expect(group.renderingMode).toBe('2d');
    expect(group.layers).toHaveLength(2);
  });

  it('renderingMode lifts to 3d when any child is 3d', () => {
    const group = new STTLayerGroup({
      id: 'grp',
      layers: [new TestChild(opts('a')), new ThreeDChild(opts('c'))],
    });
    expect(group.renderingMode).toBe('3d');
  });

  it('exposes the mapbox slot structurally and copies the layer list', () => {
    const layers = [new TestChild(opts('a'))];
    const group = new STTLayerGroup({ id: 'grp', layers, slot: 'top' });
    expect(group.slot).toBe('top');
    // Defensive copy: mutating the passed array does not change the group.
    layers.push(new TestChild(opts('b')));
    expect(group.layers).toHaveLength(1);
  });

  it('installs no prerender when no child has an offscreen pass', () => {
    const group = new STTLayerGroup({
      id: 'grp',
      layers: [new TestChild(opts('a'))],
    });
    expect(group.prerender).toBeUndefined();
  });

  it('installs prerender and forwards only to capable children', () => {
    const gl = makeMockGl();
    const plain = new TestChild(opts('plain'));
    const pre = new PrerenderChild(opts('pre'));
    const group = new STTLayerGroup({ id: 'grp', layers: [plain, pre] });
    expect(typeof group.prerender).toBe('function');
    const matrix = new Float32Array(16);
    group.prerender!(gl, matrix, undefined);
    expect(pre.prerender).toHaveBeenCalledTimes(1);
    expect(pre.prerender).toHaveBeenCalledWith(gl, matrix, undefined);
  });
});

describe('STTLayerGroup — hosting (onAdd/onRemove)', () => {
  it('onAdd initializes each child WITHOUT registering them as map layers', async () => {
    const gl = makeMockGl();
    const map = new MockMap(gl);
    const a = new TestChild(opts('a'));
    const b = new TestChild(opts('b'));
    const group = new STTLayerGroup({ id: 'grp', layers: [a, b] });

    map.addLayer(group);
    // ONLY the group is a registered map layer — children render through it.
    expect(map.getLayerOrder()).toEqual(['grp']);
    expect(map.getLayer('a')).toBeUndefined();
    expect(map.getLayer('b')).toBeUndefined();
    // Yet both children were initialized against the shared context.
    expect(anyOf(a).map).toBeDefined();
    expect(anyOf(a).gl).toBe(gl);
    expect(anyOf(b).map).toBeDefined();
    expect(anyOf(b).gl).toBe(gl);

    await tick();
    expect(a.getTileset()).toBeDefined();
    expect(b.getTileset()).toBeDefined();
    map.removeLayer('grp');
  });

  it('onRemove (via removeLayer) tears down every hosted child once', async () => {
    const gl = makeMockGl();
    const map = new MockMap(gl);
    const a = new TestChild(opts('a'));
    const b = new TestChild(opts('b'));
    const group = new STTLayerGroup({ id: 'grp', layers: [a, b] });
    map.addLayer(group);
    await tick();
    const finA = vi.spyOn(a.getTileset()!, 'finalize');
    const finB = vi.spyOn(b.getTileset()!, 'finalize');

    map.removeLayer('grp');

    expect(finA).toHaveBeenCalledTimes(1);
    expect(finB).toHaveBeenCalledTimes(1);
    expect(a.getTileset()).toBeUndefined();
    expect(b.getTileset()).toBeUndefined();
    expect(anyOf(a).map).toBeUndefined();
    expect(anyOf(b).map).toBeUndefined();
    expect(map.getLayer('grp')).toBeUndefined();
  });

  it('map.remove() tears children down exactly once and cleans group state', async () => {
    const gl = makeMockGl();
    const map = new MockMap(gl);
    const a = new TestChild(opts('a'));
    const group = new STTLayerGroup({ id: 'grp', layers: [a] });
    group.attach(map as never);
    await tick();
    const fin = vi.spyOn(a.getTileset()!, 'finalize');

    map.remove();

    // Children self-tear-down via their own remove hooks; the group's hook only
    // cleans its state — so finalize fires exactly once (no double teardown).
    expect(fin).toHaveBeenCalledTimes(1);
    expect(a.getTileset()).toBeUndefined();
    // Guard disarmed: a later styledata does not resurrect the group.
    map.style = { _loaded: true };
    map.fire('styledata');
    expect(map.addLayerSpy).toHaveBeenCalledTimes(1); // only the original add
  });

  it('an empty group adds and removes without error', () => {
    const map = new MockMap(makeMockGl());
    const group = new STTLayerGroup({ id: 'grp', layers: [] });
    expect(() => map.addLayer(group)).not.toThrow();
    expect(() =>
      group.render(makeMockGl(), new Float32Array(16)),
    ).not.toThrow();
    expect(() => map.removeLayer('grp')).not.toThrow();
  });
});

describe('STTLayerGroup — render forwarding', () => {
  it('forwards the SAME host args to each child in draw order', () => {
    const gl = makeMockGl();
    const map = new MockMap(gl);
    const a = new TestChild(opts('a'));
    const b = new TestChild(opts('b'));
    const group = new STTLayerGroup({ id: 'grp', layers: [a, b] });
    map.addLayer(group);

    const order: Array<{ id: string; args: unknown[] }> = [];
    vi.spyOn(a, 'render').mockImplementation((...args) =>
      order.push({ id: 'a', args }),
    );
    vi.spyOn(b, 'render').mockImplementation((...args) =>
      order.push({ id: 'b', args }),
    );

    const matrix = new Float32Array(16);
    const options = { fov: 0.7 };
    group.render(gl, matrix, options);

    expect(order.map((o) => o.id)).toEqual(['a', 'b']);
    expect(order[0].args).toEqual([gl, matrix, options]);
    expect(order[1].args).toEqual([gl, matrix, options]);
    map.removeLayer('grp');
  });

  it('drives each child to draw its resident tiles in one pass', async () => {
    const gl = makeMockGl();
    const map = new MockMap(gl);
    const a = new TestChild(opts('a'));
    const b = new TestChild(opts('b'));
    const group = new STTLayerGroup({ id: 'grp', layers: [a, b] });
    map.addLayer(group);
    await tick();
    // Each child derives its drawn set from its own tileset's visible set.
    publishVisibleTiles(a, makePointTile());
    publishVisibleTiles(b, makePointTile());

    group.render(gl, new Float32Array(16));

    expect(a.drawCount).toBe(1);
    expect(b.drawCount).toBe(1);
    map.removeLayer('grp');
  });
});

describe('STTLayerGroup — repaint coalescing', () => {
  it('a child repaint routes through the group hook (one real repaint)', async () => {
    const gl = makeMockGl();
    const map = new MockMap(gl);
    const a = new TestChild(opts('a'));
    const b = new TestChild(opts('b'));
    const group = new STTLayerGroup({ id: 'grp', layers: [a, b] });
    map.addLayer(group);
    await tick();
    map.triggerRepaint.mockClear();

    a.setCurrentTime(7);

    expect(map.triggerRepaint).toHaveBeenCalledTimes(1);
    expect(anyOf(a).opts.currentTime).toBe(7);
    map.removeLayer('grp');
  });

  it('a group time advance fires ONE repaint however many children', async () => {
    const gl = makeMockGl();
    const map = new MockMap(gl);
    const children = [
      new TestChild(opts('a')),
      new TestChild(opts('b')),
      new TestChild(opts('c')),
    ];
    const group = new STTLayerGroup({ id: 'grp', layers: children });
    map.addLayer(group);
    await tick();
    map.triggerRepaint.mockClear();

    group.setCurrentTime(42);

    expect(map.triggerRepaint).toHaveBeenCalledTimes(1);
    for (const child of children) {
      expect(anyOf(child).opts.currentTime).toBe(42);
    }
    map.removeLayer('grp');
  });

  it('setTimeWindow coalesces the same way', async () => {
    const gl = makeMockGl();
    const map = new MockMap(gl);
    const children = [new TestChild(opts('a')), new TestChild(opts('b'))];
    const group = new STTLayerGroup({ id: 'grp', layers: children });
    map.addLayer(group);
    await tick();
    map.triggerRepaint.mockClear();

    group.setTimeWindow(1234);

    expect(map.triggerRepaint).toHaveBeenCalledTimes(1);
    for (const child of children) {
      expect(anyOf(child).opts.timeWindow).toBe(1234);
    }
    map.removeLayer('grp');
  });
});

describe('STTLayerGroup — attach guard', () => {
  it('attach honours beforeId', () => {
    const map = new MockMap(makeMockGl());
    map.addLayer({ id: 'water' });
    map.addLayer({ id: 'labels' });
    const group = new STTLayerGroup({
      id: 'grp',
      layers: [new TestChild(opts('a'))],
      beforeId: 'labels',
    });
    group.attach(map as never);
    expect(map.getLayerOrder()).toEqual(['water', 'grp', 'labels']);
    group.detach();
  });

  it('a style rebuild drops the group; the guard re-adds it and re-inits children', async () => {
    const gl = makeMockGl();
    const map = new MockMap(gl);
    const a = new TestChild(opts('a'));
    const group = new STTLayerGroup({ id: 'grp', layers: [a] });
    group.attach(map as never);
    await tick();
    expect(a.getTileset()).toBeDefined();

    map.simulateStyleRebuild(); // fireOnRemove:true → group.onRemove tears down a

    expect(map.getLayer('grp')).toBeDefined();
    expect(map.addLayerSpy).toHaveBeenCalledTimes(2);
    await tick();
    expect(a.getTileset()).toBeDefined(); // re-initialized through the re-add
    group.detach();
  });

  it('re-attach with a new beforeId repositions the group (moved, not re-added)', () => {
    const map = new MockMap(makeMockGl());
    map.addLayer({ id: 'water' });
    map.addLayer({ id: 'labels' });
    const group = new STTLayerGroup({
      id: 'grp',
      layers: [new TestChild(opts('a'))],
    });
    group.attach(map as never);
    expect(map.getLayerOrder()).toEqual(['water', 'labels', 'grp']);
    map.addLayerSpy.mockClear();

    group.attach(map as never, { beforeId: 'labels' });
    expect(map.getLayerOrder()).toEqual(['water', 'grp', 'labels']);
    expect(map.addLayerSpy).not.toHaveBeenCalled();
    group.detach();
  });

  it('detach removes the group (tearing down children) and disarms the guard', async () => {
    const map = new MockMap(makeMockGl());
    const a = new TestChild(opts('a'));
    const group = new STTLayerGroup({ id: 'grp', layers: [a] });
    group.attach(map as never);
    await tick();

    group.detach();
    expect(map.getLayer('grp')).toBeUndefined();
    expect(a.getTileset()).toBeUndefined();

    map.simulateStyleRebuild();
    expect(map.getLayer('grp')).toBeUndefined(); // nothing resurrects it
  });
});

describe('STTLayerGroup — pick dispatch', () => {
  const hit = (layerId: string): SttPickResult => ({
    object: {},
    index: 0,
    tileId: { z: 2, x: 1, y: 1, t: 0 },
    layerId,
  });

  it('queries children topmost-first and returns the first hit', () => {
    const a = new TestChild(opts('a'));
    const b = new TestChild(opts('b')); // topmost (last in draw order)
    const group = new STTLayerGroup({ id: 'grp', layers: [a, b] });
    vi.spyOn(a, 'supportsPicking').mockReturnValue(true);
    vi.spyOn(b, 'supportsPicking').mockReturnValue(true);
    const pickA = vi.spyOn(a, 'pick').mockReturnValue(hit('a'));
    const pickB = vi.spyOn(b, 'pick').mockReturnValue(hit('b'));

    const result = group.pick(10, 20);
    expect(result?.layerId).toBe('b');
    expect(pickB).toHaveBeenCalledWith(10, 20);
    expect(pickA).not.toHaveBeenCalled(); // topmost hit short-circuits
  });

  it('skips non-pickable children and falls through to a lower hit', () => {
    const a = new TestChild(opts('a'));
    const b = new TestChild(opts('b'));
    const group = new STTLayerGroup({ id: 'grp', layers: [a, b] });
    vi.spyOn(a, 'supportsPicking').mockReturnValue(true);
    vi.spyOn(b, 'supportsPicking').mockReturnValue(false); // topmost not pickable
    const pickA = vi.spyOn(a, 'pick').mockReturnValue(hit('a'));
    const pickB = vi.spyOn(b, 'pick');

    expect(group.pick(1, 2)?.layerId).toBe('a');
    expect(pickB).not.toHaveBeenCalled();
    expect(pickA).toHaveBeenCalled();
  });

  it('returns null when nothing is under the cursor', () => {
    const a = new TestChild(opts('a'));
    const group = new STTLayerGroup({ id: 'grp', layers: [a] });
    vi.spyOn(a, 'supportsPicking').mockReturnValue(true);
    vi.spyOn(a, 'pick').mockReturnValue(null);
    expect(group.pick(0, 0)).toBeNull();
  });
});

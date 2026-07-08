import { describe, it, expect, vi } from 'vitest';
import { Group } from 'three';
import type { Tile } from '@poopdeck.gl/core';
import { SttScene } from '../src/scene/stt-three-scene';
import type { SttLayer, SttLayerContext } from '../src/layers/layer';
import { mockTileset, tile, VIEWPORT } from './_support/streaming';

/**
 * The new opt-in streaming DRIVE path through {@link SttScene}: opting a layer
 * into streaming wires `StreamingTileSource.onTilesChanged → layer.setTiles`, and
 * `scene.updateStreaming(viewport)` pumps the viewport so a residency change
 * rebuilds the layer. Eager (load-everything) stays the default and is a no-op
 * under `updateStreaming`. Uses the source's `attachTileset` seam with a mock
 * tileset (no archive / network), mirroring `streaming-tile-source.test.ts`.
 */

const ANCHOR = { longitude: 0, latitude: 0 };

/** A minimal SttLayer with spy hooks and a real Object3D (root.add needs one). */
class FakeLayer implements SttLayer {
  readonly object = new Group();
  setTiles = vi.fn<[Tile[], SttLayerContext], void>();
  setTime = vi.fn<[number], void>();
  dispose = vi.fn<[], void>();
  constructor(readonly id: string) {}
}

describe('SttScene streaming drive path', () => {
  it('opts a layer into streaming and drives setTiles via updateStreaming', () => {
    const layer = new FakeLayer('objects');
    const scene = new SttScene({
      anchor: ANCHOR,
      timeOrigin: 0,
      ground: false,
    });
    scene.addLayer(layer, 'archive.stt', { streaming: true });

    expect(scene.hasStreamingLayers()).toBe(true);
    const [source] = scene.getStreamingSources();
    expect(source).toBeDefined();

    const t0 = [tile({ z: 14, x: 0, y: 0, t: 0 })];
    const ts = mockTileset(t0);
    source.attachTileset(ts);

    // Viewport pump → tileset.update + publish → layer.setTiles(residentSet, ctx).
    scene.updateStreaming(VIEWPORT);
    expect(ts.updateCount).toBe(1);
    expect(layer.setTiles).toHaveBeenCalledTimes(1);
    expect(layer.setTiles).toHaveBeenLastCalledWith(t0, {
      projection: scene.projection,
      timeOrigin: 0,
    });

    // Same resident set on the next pump → no re-publish (replace-all suppressed).
    scene.updateStreaming({ ...VIEWPORT, time: 6000 });
    expect(ts.updateCount).toBe(2);
    expect(layer.setTiles).toHaveBeenCalledTimes(1);

    // A residency change → exactly one more setTiles with the new set.
    const t1 = [...t0, tile({ z: 14, x: 1, y: 0, t: 0 })];
    ts.setVisible(t1);
    scene.updateStreaming({ ...VIEWPORT, time: 7000 });
    expect(layer.setTiles).toHaveBeenCalledTimes(2);
    expect(layer.setTiles).toHaveBeenLastCalledWith(t1, {
      projection: scene.projection,
      timeOrigin: 0,
    });
  });

  it('leaves eager (default) layers untouched by updateStreaming', () => {
    const layer = new FakeLayer('eager');
    const scene = new SttScene({
      anchor: ANCHOR,
      timeOrigin: 0,
      ground: false,
    });
    scene.addLayer(layer, 'archive.stt'); // no opts → eager default

    expect(scene.hasStreamingLayers()).toBe(false);
    expect(scene.getStreamingSources()).toHaveLength(0);
    // updateStreaming is a no-op for a purely-eager scene.
    scene.updateStreaming(VIEWPORT);
    expect(layer.setTiles).not.toHaveBeenCalled();
  });

  it('applies the scene-level streaming default, and a per-layer false overrides it', () => {
    const streamed = new FakeLayer('streamed');
    const forcedEager = new FakeLayer('forced-eager');
    const scene = new SttScene({
      anchor: ANCHOR,
      timeOrigin: 0,
      ground: false,
      streaming: true, // scene default
    });
    scene.addLayer(streamed, 'a.stt'); // inherits streaming default
    scene.addLayer(forcedEager, 'b.stt', { streaming: false }); // explicit override

    expect(scene.getStreamingSources()).toHaveLength(1);
    scene
      .getStreamingSources()[0]
      .attachTileset(mockTileset([tile({ z: 1, x: 0, y: 0, t: 0 })]));
    scene.updateStreaming(VIEWPORT);
    expect(streamed.setTiles).toHaveBeenCalledTimes(1);
    expect(forcedEager.setTiles).not.toHaveBeenCalled();
  });

  it('forwards setAnimationState to every streaming source', () => {
    const scene = new SttScene({
      anchor: ANCHOR,
      timeOrigin: 0,
      ground: false,
    });
    scene.addLayer(new FakeLayer('objects'), 'a.stt', { streaming: true });
    const ts = mockTileset();
    scene.getStreamingSources()[0].attachTileset(ts);

    scene.setAnimationState(true, 8);
    expect(ts.setAnimationState).toHaveBeenCalledWith(true, 8);
  });

  it('disposes both eager and streaming sources', () => {
    const scene = new SttScene({
      anchor: ANCHOR,
      timeOrigin: 0,
      ground: false,
    });
    scene.addLayer(new FakeLayer('stream'), 'a.stt', { streaming: true });
    scene.addLayer(new FakeLayer('eager'), 'b.stt');
    const ts = mockTileset();
    scene.getStreamingSources()[0].attachTileset(ts);

    expect(() => scene.dispose()).not.toThrow();
    expect(ts.clear).toHaveBeenCalledTimes(1);
  });
});

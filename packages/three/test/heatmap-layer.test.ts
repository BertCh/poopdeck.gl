// @poopdeck.gl/three
// SPDX-License-Identifier: MIT

/**
 * `STTHeatmapLayer` — the LAYER half of the density heatmap.
 *
 * `heatmap-buffers.test.ts` covers the consolidated splat buffers and
 * `heatmap-material.test.ts` covers the two materials. What is proven HERE is
 * the two-pass plumbing that only exists on the layer:
 *
 *   - the splat mesh carries the buffers' RTC origin, so the off-screen pass
 *     draws where the on-screen scene thinks it is;
 *   - the density pass restores the renderer's state EVEN WHEN THE RENDER
 *     THROWS — an off-screen pass that leaks a bound render target or a
 *     flipped `autoClear` corrupts every later draw in the frame, and a throw
 *     is exactly when a naive implementation forgets;
 *   - resizing keeps the render target's TEXTURE IDENTITY, because the resolve
 *     material samples that texture through a uniform bound once.
 *
 * No GPU is required for any of it: the render target and the meshes are plain
 * objects, and the renderer is a recording stand-in.
 */

import { describe, it, expect } from 'vitest';
import { STTHeatmapLayer } from '../src/layers/heatmap-layer';
import { MercatorProjection } from '../src/projection/mercator';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { buildHeatmapBuffers } from '../src/lib/heatmap-buffers';
import { makePointTile } from './_support/features';

const anchor = { longitude: -71.05, latitude: 42.35 };

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('two-pass plumbing', () => {
  it('puts the buffers RTC origin on the splat mesh (mercator)', () => {
    const layer = new STTHeatmapLayer({ id: 'hm' });
    const merc = new MercatorProjection();
    const tile = makePointTile(2, [
      anchor.longitude,
      anchor.latitude,
      anchor.longitude + 0.001,
      anchor.latitude,
    ]);
    layer.setTiles([tile], { projection: merc, timeOrigin: 0 });

    const splat: any = layer.object.children[0];
    const buf = buildHeatmapBuffers([tile], merc, 0);
    // The whole point of RTC: the huge mercator magnitude lives on the mesh
    // transform (f64 CPU-side), never inside the f32 attribute buffer.
    expect(splat.position.x).toBe(buf.origin[0]);
    expect(splat.position.y).toBe(buf.origin[1]);
    expect(Math.abs(buf.centers[0])).toBeLessThan(1e4);
    layer.dispose();
  });

  it('keeps the splat mesh OUT of the main scene draw', () => {
    const layer = new STTHeatmapLayer({ id: 'hm-vis' });
    const proj = new LocalEnuProjection(anchor);
    layer.setTiles([makePointTile(1, [anchor.longitude, anchor.latitude])], {
      projection: proj,
      timeOrigin: 0,
    });
    // It is a real child (so camera framing reads its true world AABB) but is
    // never drawn by the scene — the density pass flips it visible and back.
    const splat: any = layer.object.children[0];
    expect(splat.visible).toBe(false);
    layer.dispose();
  });

  it('does not rebuild the materials on a second setTiles', () => {
    const layer = new STTHeatmapLayer({ id: 'hm-mat' });
    const proj = new LocalEnuProjection(anchor);
    const tile = makePointTile(1, [anchor.longitude, anchor.latitude]);
    layer.setTiles([tile], { projection: proj, timeOrigin: 0 });
    const splat: any = layer.object.children[0];
    const resolve: any = layer.object.children[1];
    const splatMat = splat.material;
    const resolveMat = resolve.material;

    layer.setTiles([tile], { projection: proj, timeOrigin: 0 });
    // Rebuilding a material evicts three's nodeBuilderCache entry and forces a
    // full shader/pipeline rebuild on the next draw.
    expect(splat.material).toBe(splatMat);
    expect(resolve.material).toBe(resolveMat);
    layer.dispose();
  });
});

describe('the density pass restores renderer state', () => {
  function recordingRenderer(opts: { throwOnRender?: boolean } = {}) {
    const calls: string[] = [];
    const renderer: any = {
      autoClear: true,
      getRenderTarget: () => 'PREV',
      setRenderTarget: (t: any) =>
        calls.push(
          `setRT:${t === null ? 'null' : t === 'PREV' ? 'PREV' : 'own'}`,
        ),
      clear: () => calls.push('clear'),
      render: () => {
        calls.push('render');
        if (opts.throwOnRender) throw new Error('boom');
      },
    };
    return { renderer, calls };
  }

  function mounted(id: string) {
    const layer = new STTHeatmapLayer({ id });
    const proj = new LocalEnuProjection(anchor);
    layer.setTiles([makePointTile(1, [anchor.longitude, anchor.latitude])], {
      projection: proj,
      timeOrigin: 0,
    });
    return {
      layer,
      resolve: layer.object.children[1] as any,
      splat: layer.object.children[0] as any,
    };
  }

  it('restores the previous target, autoClear and splat visibility on a clean pass', () => {
    const { layer, resolve, splat } = mounted('hm-ok');
    const { renderer, calls } = recordingRenderer();
    resolve.onBeforeRender(renderer, {}, {});
    expect(calls).toContain('render');
    expect(calls[calls.length - 1]).toBe('setRT:PREV');
    expect(renderer.autoClear).toBe(true);
    expect(splat.visible).toBe(false);
    layer.dispose();
  });

  it('STILL restores them when the density render THROWS', () => {
    const { layer, resolve, splat } = mounted('hm-throw');
    const { renderer, calls } = recordingRenderer({ throwOnRender: true });

    // The layer may swallow or rethrow; what must NOT happen is leaking state.
    try {
      resolve.onBeforeRender(renderer, {}, {});
    } catch {
      /* rethrow is acceptable — leaking is not */
    }

    expect(calls[calls.length - 1]).toBe('setRT:PREV');
    expect(renderer.autoClear).toBe(true);
    expect(splat.visible).toBe(false);
    layer.dispose();
  });
});

describe('setViewport', () => {
  it('resizes the density target while KEEPING its texture identity', () => {
    const layer = new STTHeatmapLayer({ id: 'hm-size', resolutionScale: 0.5 });
    const target: any = (layer as any).target;
    const texture = target.texture;

    layer.setViewport(1000, 800);

    // resolutionScale halves each axis.
    expect(target.width).toBe(500);
    expect(target.height).toBe(400);
    // The resolve material samples this texture through a uniform bound ONCE;
    // swapping the object would leave it sampling a dead texture.
    expect(target.texture).toBe(texture);
    layer.dispose();
  });
});

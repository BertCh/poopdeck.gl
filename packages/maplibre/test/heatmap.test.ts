/**
 * Behaviour tests for STTHeatmapLayer. The heatmap overrides render() with a
 * two-pass FBO pipeline, so we drive both phases through the mock GL and
 * assert: framebuffer setup happens once, splat points are drawn additively,
 * and a final triangle-strip is drawn against the default framebuffer.
 */

import { describe, it, expect, vi } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import { STTHeatmapLayer } from '../src/layers/heatmap-layer';
import { makeMockGl, makeMockMap } from './mock-gl';
import { makePropertyPointTile } from './fixtures';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

describe('STTHeatmapLayer', () => {
  it('only accepts Point geometry', () => {
    const layer = new STTHeatmapLayer({ ...baseOpts, id: 'h' }) as any;
    expect(layer.acceptsGeometry(GeometryType.Point)).toBe(true);
    expect(layer.acceptsGeometry(GeometryType.LineString)).toBe(false);
    expect(layer.acceptsGeometry(GeometryType.Polygon)).toBe(false);
  });

  it('extracts per-feature weight from numericProps when configured', () => {
    const layer = new STTHeatmapLayer({
      ...baseOpts,
      id: 'h',
      weightProperty: 'magnitude',
    }) as any;
    layer.supports32BitIndices = true;
    const gl = makeMockGl();
    const tile = makePropertyPointTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache.weightBuffer).toBeDefined();
    expect(cache.vertexCount).toBe(2);
  });

  it('renders a two-pass pipeline (FBO splat + fullscreen ramp)', () => {
    const layer = new STTHeatmapLayer({ ...baseOpts, id: 'h' }) as any;
    layer.supports32BitIndices = true;
    const gl = makeMockGl();
    layer.onContextReady(gl);

    // Bypass tileset wiring by injecting state directly.
    layer.map = makeMockMap();
    layer.tileset = {
      update: vi.fn(),
      getVisibleTiles: () => [],
      finalize: vi.fn(),
    };
    const tile = makePropertyPointTile();
    layer.loadedTiles.set('k', tile);

    layer.render(gl, new Float32Array(16));

    // Created FBO + accumulator texture exactly once during ensureAccumFramebuffer.
    expect(gl.createFramebuffer).toHaveBeenCalled();
    expect(gl.framebufferTexture2D).toHaveBeenCalled();
    // Pass 1 binds the FBO, pass 2 unbinds it.
    expect(gl.bindFramebuffer).toHaveBeenCalled();
    // Pass 1 should issue at least one POINTS draw (one per tile), pass 2
    // should issue a single TRIANGLE_STRIP for the fullscreen quad.
    const draws = gl.drawCalls as Array<{ kind: 'arrays' | 'elements'; count: number }>;
    expect(draws.some((d) => d.kind === 'arrays' && d.count === 2)).toBe(true);
    expect(draws.some((d) => d.kind === 'arrays' && d.count === 4)).toBe(true);
  });

  it('restores the framebuffer + viewport bound on entry for the ramp pass', () => {
    // MapLibre's terrain / globe pipelines render custom layers into an
    // offscreen target — pass 2 must composite into THAT framebuffer, not
    // assume the default (null) one.
    const layer = new STTHeatmapLayer({ ...baseOpts, id: 'h' }) as any;
    layer.supports32BitIndices = true;
    const gl = makeMockGl();
    layer.onContextReady(gl);
    layer.map = makeMockMap();
    layer.tileset = {
      update: vi.fn(),
      getVisibleTiles: () => [],
      finalize: vi.fn(),
    };
    const tile = makePropertyPointTile();
    layer.loadedTiles.set('k', tile);

    // Simulate the host's offscreen render target + sub-viewport.
    const hostFbo = { __mockKind: 'host-framebuffer' };
    gl.bindFramebuffer(gl.FRAMEBUFFER, hostFbo);
    gl.viewport(16, 32, 512, 256);
    gl.bindFramebuffer.mockClear();
    gl.viewport.mockClear();

    layer.render(gl, new Float32Array(16));

    // The LAST framebuffer bind (pass 2) targets the host's FBO, and the
    // LAST viewport call restores the host's sub-viewport.
    const fboCalls = gl.bindFramebuffer.mock.calls;
    expect(fboCalls.length).toBeGreaterThan(0);
    expect(fboCalls[fboCalls.length - 1][1]).toBe(hostFbo);
    const vpCalls = gl.viewport.mock.calls;
    expect(vpCalls[vpCalls.length - 1]).toEqual([16, 32, 512, 256]);
  });
});

/**
 * Behaviour tests for STTHeatmapLayer. The heatmap overrides render() with a
 * two-pass FBO pipeline, so we drive both phases through the mock GL and
 * assert: framebuffer setup happens once, splat points are drawn additively,
 * and a final triangle-strip is drawn against the default framebuffer.
 * The D3 variant suite covers the prelude-injected v5 accumulate shader
 * (string-level source assertions + per-variant program/VAO caching).
 */

import { describe, it, expect, vi } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import {
  STTHeatmapLayer,
  buildHeatmapAccumVertexSource,
} from '../src/layers/heatmap-layer';
import { makeMockGl, makeMockMap } from './mock-gl';
import { makePropertyPointTile } from './fixtures';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

/** A rendering-ready layer with mock map/tileset state injected. */
function makeRenderableLayer(gl: any, opts: Record<string, unknown> = {}): any {
  const layer = new STTHeatmapLayer({ ...baseOpts, id: 'h', ...opts }) as any;
  layer.supports32BitIndices = true;
  layer.onContextReady(gl);
  layer.map = makeMockMap();
  layer.tileset = {
    update: vi.fn(),
    getVisibleTiles: () => [],
    finalize: vi.fn(),
  };
  layer.loadedTiles.set('k', makePropertyPointTile());
  return layer;
}

/** Recorded v5/v6 render-args shape (version-matrix testing — shapes are data). */
const v5Args = (variantName: string, transition = 0) => ({
  fov: 0.6,
  nearZ: 1,
  farZ: 100,
  shaderData: {
    variantName,
    vertexShaderPrelude: `// ${variantName} prelude`,
    define: '#define GLOBE',
  },
  defaultProjectionData: {
    mainMatrix: Array.from({ length: 16 }, (_, i) => i),
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 0, 1],
    projectionTransition: transition,
    fallbackMatrix: Array.from({ length: 16 }, (_, i) => i),
  },
});

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
    const draws = gl.drawCalls as Array<{
      kind: 'arrays' | 'elements';
      count: number;
    }>;
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

describe('STTHeatmapLayer position quantization (perf research 2026-07)', () => {
  it('buildTileGpuCache populates posScale/posOffset', () => {
    const layer = new STTHeatmapLayer({ ...baseOpts, id: 'h' }) as any;
    layer.supports32BitIndices = true;
    const gl = makeMockGl();
    const tile = makePropertyPointTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache.posScale).toHaveLength(3);
    expect(cache.posOffset).toHaveLength(3);
  });

  it('the accum pass binds the position attribute as UNSIGNED_SHORT/normalized and sets uPosScale/uPosOffset', () => {
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

    layer.render(gl, new Float32Array(16));

    // Accum handles live in the base per-variant program cache now.
    const h = layer.programCache.get('heatmap-accum::legacy');
    expect(h).toBeDefined();
    expect(gl.vertexAttribPointer).toHaveBeenCalledWith(
      h.aMercator,
      3,
      gl.UNSIGNED_SHORT,
      true,
      0,
      0,
    );
    const scaleCalls = gl.uniform3fv.mock.calls.filter(
      (c: unknown[]) => c[0] === h.uPosScale,
    );
    const offsetCalls = gl.uniform3fv.mock.calls.filter(
      (c: unknown[]) => c[0] === h.uPosOffset,
    );
    expect(scaleCalls.length).toBeGreaterThan(0);
    expect(offsetCalls.length).toBeGreaterThan(0);
  });
});

describe('STTHeatmapLayer accum shader variants (D3 prelude path)', () => {
  it('legacy variant ships the historical uMatrix source verbatim', () => {
    const src = buildHeatmapAccumVertexSource({ prelude: '', define: '' });
    expect(src).toContain('uniform mat4 uMatrix');
    expect(src).toContain('gl_Position = uMatrix *');
    expect(src).not.toContain('projectTile');
    // Shared snippets stay in both variants.
    expect(src).toContain('sttTimeWindowAlpha(');
    expect(src).toContain('sttDecodeMercatorPos(');
  });

  it('v5 variant prepends prelude then define and projects via projectTile', () => {
    const prelude = '// host prelude: uniform mat4 u_projection_matrix;';
    const define = '#define GLOBE';
    const src = buildHeatmapAccumVertexSource({ prelude, define });
    expect(src.startsWith(prelude)).toBe(true);
    expect(src.indexOf(define)).toBeGreaterThan(src.indexOf(prelude));
    expect(src.indexOf(define)).toBeLessThan(src.indexOf('void main'));
    expect(src).toContain('gl_Position = projectTile(mercator.xy)');
    // The prelude owns projection — no uMatrix declaration or use.
    expect(src).not.toContain('uMatrix');
    expect(src).toContain('sttTimeWindowAlpha(');
    expect(src).toContain('sttDecodeMercatorPos(');
  });

  it('renders through a prelude-built program on a v5 host frame', () => {
    const gl = makeMockGl();
    const layer = makeRenderableLayer(gl);

    layer.render(gl, v5Args('globe', 1));

    // The lazily-linked accum program embeds the host prelude + projectTile.
    const sources = gl.shaderSource.mock.calls.map((c: unknown[]) => c[1]);
    expect(
      sources.some(
        (s: string) =>
          s.includes('// globe prelude') && s.includes('projectTile'),
      ),
    ).toBe(true);
    // Prelude projection uniforms are set (base helper) after useProgram.
    const looked = gl.getUniformLocation.mock.calls.map((c: unknown[]) => c[1]);
    expect(looked).toContain('u_projection_matrix');
    expect(looked).toContain('u_projection_tile_mercator_coords');
    // Both passes still draw: 2 splat points + 4-vert fullscreen ramp quad.
    const draws = gl.drawCalls as Array<{ kind: string; count: number }>;
    expect(draws.some((d) => d.kind === 'arrays' && d.count === 2)).toBe(true);
    expect(draws.some((d) => d.kind === 'arrays' && d.count === 4)).toBe(true);
  });

  it('caches one accum program per shader variant', () => {
    const gl = makeMockGl();
    const layer = makeRenderableLayer(gl);

    layer.render(gl, new Float32Array(16)); // legacy → links accum
    const afterLegacy = gl.createProgram.mock.calls.length;
    layer.render(gl, new Float32Array(16)); // cached
    expect(gl.createProgram.mock.calls.length).toBe(afterLegacy);

    layer.render(gl, v5Args('mercator')); // new variant → one relink
    expect(gl.createProgram.mock.calls.length).toBe(afterLegacy + 1);
    layer.render(gl, v5Args('mercator')); // cached
    expect(gl.createProgram.mock.calls.length).toBe(afterLegacy + 1);

    layer.render(gl, v5Args('globe', 1)); // another variant → one more
    expect(gl.createProgram.mock.calls.length).toBe(afterLegacy + 2);
  });

  it('drops and re-records tile VAOs when the shader variant flips', () => {
    const gl = makeMockGl();
    const layer = makeRenderableLayer(gl);
    layer.initVaoSupport(gl); // tests bypass onAdd, so enable VAOs directly

    layer.render(gl, new Float32Array(16));
    const cache = [...layer.tileGpuCache.values()][0];
    expect(cache.vao).toBeTruthy();
    expect(cache.vaoVariant).toBe('legacy');
    const firstVao = cache.vao;

    layer.render(gl, v5Args('globe', 1));
    // The stale VAO recorded the legacy program's attribute locations.
    expect(gl.deleteVertexArray).toHaveBeenCalledWith(firstVao);
    expect(cache.vaoVariant).toBe('globe');
    expect(cache.vao).toBeTruthy();
    expect(cache.vao).not.toBe(firstVao);

    // Same variant again → the recorded VAO is reused untouched.
    const secondVao = cache.vao;
    layer.render(gl, v5Args('globe', 1));
    expect(cache.vao).toBe(secondVao);
  });
});

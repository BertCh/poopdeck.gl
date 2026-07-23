/**
 * Point-layer shader variants (D3): the legacy source must stay the verbatim
 * `uMatrix` shader, the v5+ source must prepend the host prelude + define and
 * project via the injected `projectTile`, and both the visual and id-pick
 * passes must resolve programs through the base per-variant cache — setting
 * the prelude projection uniforms on v5 frames, rebuilding tile VAOs on a
 * variant flip, and never relinking for a variant already cached. String /
 * mock-GL level only; real prelude compilation is browser-verified.
 */

import { describe, it, expect } from 'vitest';
import { normalizeRenderArgs } from '../src/lib/host-adapter';
import {
  STTPointLayer,
  buildPointVertexSource,
  buildPointIdVertexSource,
} from '../src/layers/point-layer';
import { makeMockGl } from './mock-gl';
import { makePointTile } from './fixtures';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

const PRELUDE_MARKER = '// __HOST_PRELUDE__';
const PRELUDE = `${PRELUDE_MARKER}\nvec4 projectTile(vec2 p) { return vec4(p, 0.0, 1.0); }`;

const mat16 = () => Array.from({ length: 16 }, (_, i) => i + 1);

/** v5 render-args shape (recorded, not imported — the dev dep stays ^4). */
const v5Args = (variantName: string, transition = 0) => ({
  fov: 0.6,
  nearZ: 1,
  farZ: 100,
  shaderData: {
    variantName,
    vertexShaderPrelude: PRELUDE,
    define: '#define GLOBE',
  },
  defaultProjectionData: {
    mainMatrix: mat16(),
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 0, 1],
    projectionTransition: transition,
    fallbackMatrix: mat16(),
  },
});

const drawCtx = (frame?: ReturnType<typeof normalizeRenderArgs>) => ({
  matrix: frame ? frame.matrix : new Float32Array(16),
  frame,
  windowStart: 0,
  windowEnd: 10_000,
  currentTime: baseOpts.currentTime,
  zoom: 2,
});

/** All vertex-shader sources handed to the mock GL so far. */
const vertexSources = (gl: any): string[] =>
  gl.shaderSource.mock.calls.map((c: unknown[]) => c[1] as string);

function makeLayerWithCache() {
  const layer = new STTPointLayer({ ...baseOpts, id: 'p' }) as any;
  layer.supports32BitIndices = true;
  const gl = makeMockGl();
  // The real `initVaoSupport` runs in onAdd, which these direct-hook tests
  // bypass — wire the mock's VAO entry points so VAO reuse/rebuild is real.
  layer.vaoSupport = {
    enabled: true,
    create: () => gl.createVertexArray(),
    bind: (vao: unknown) => gl.bindVertexArray(vao),
    delete: (vao: unknown) => gl.deleteVertexArray(vao),
  };
  const tile = makePointTile();
  const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
  return { layer, gl, tile, cache };
}

describe('point vertex-source builder', () => {
  it('legacy variant (empty prelude) is the verbatim uMatrix shader', () => {
    const src = buildPointVertexSource({ prelude: '', define: '' });
    expect(src).toContain('uniform mat4 uMatrix;');
    expect(src).toContain('uMatrix * vec4(');
    expect(src).not.toContain('projectTile(');
    // Dequantization + time filter identical to the historical shader.
    expect(src).toContain(
      'sttDecodeMercatorPos(aMercator, uPosScale, uPosOffset)',
    );
    expect(src).toContain('sttTimeWindowAlpha(aTime,');
    expect(src).toContain('gl_PointSize = radiusPx * 2.0;');
  });

  it('v5 variant prepends prelude then define and projects via projectTile', () => {
    const src = buildPointVertexSource({
      prelude: PRELUDE,
      define: '#define GLOBE',
    });
    expect(src.startsWith(PRELUDE)).toBe(true);
    const defineAt = src.indexOf('#define GLOBE');
    expect(defineAt).toBeGreaterThan(PRELUDE_MARKER.length);
    expect(defineAt).toBeLessThan(src.indexOf('attribute vec3 aMercator'));
    expect(src).toContain('gl_Position = projectTile(mercator.xy);');
    // The prelude owns projection — no legacy matrix path left in the source.
    expect(src).not.toContain('uniform mat4 uMatrix;');
    expect(src).not.toContain('uAltitudeScale');
    // gl_PointSize + dequant + time-window math unchanged from legacy.
    expect(src).toContain(
      'sttDecodeMercatorPos(aMercator, uPosScale, uPosOffset)',
    );
    expect(src).toContain('sttTimeWindowAlpha(aTime,');
    expect(src).toContain('gl_PointSize = radiusPx * 2.0;');
  });

  it('id-pick builder mirrors both variants (flat id colour, same projection)', () => {
    const legacy = buildPointIdVertexSource({ prelude: '', define: '' });
    expect(legacy).toContain('uniform mat4 uMatrix;');
    expect(legacy).toContain('attribute vec3 aIdColor;');
    expect(legacy).not.toContain('projectTile(');

    const v5 = buildPointIdVertexSource({
      prelude: PRELUDE,
      define: '#define GLOBE',
    });
    expect(v5.startsWith(PRELUDE)).toBe(true);
    expect(v5).toContain('attribute vec3 aIdColor;');
    expect(v5).toContain('gl_Position = projectTile(mercator.xy);');
    expect(v5).not.toContain('uniform mat4 uMatrix;');
  });
});

describe('drawTile variant dispatch', () => {
  it('v5 frame: compiles the prelude source, sets u_projection_* and skips uMatrix', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const frame = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));

    // The linked vertex shader was built from the injected prelude.
    expect(
      vertexSources(gl).some(
        (s) =>
          s.includes(PRELUDE_MARKER) && s.includes('projectTile(mercator.xy)'),
      ),
    ).toBe(true);

    // Prelude projection uniforms resolved + fed from the frame's scratch.
    const looked = gl.getUniformLocation.mock.calls.map((c: unknown[]) => c[1]);
    expect(looked).toEqual(
      expect.arrayContaining([
        'u_projection_matrix',
        'u_projection_tile_mercator_coords',
        'u_projection_clipping_plane',
        'u_projection_transition',
        'u_projection_fallback_matrix',
      ]),
    );
    const matrices = gl.uniformMatrix4fv.mock.calls.map((c: unknown[]) => c[2]);
    expect(matrices).toContain(frame.projectionData!.mainMatrix);
    // The legacy uMatrix set is skipped — nothing uploads the mirror matrix.
    expect(matrices).not.toContain(frame.matrix);

    expect(gl.drawArrays).toHaveBeenCalledWith(gl.POINTS, 0, 2);
  });

  it('legacy frame: uMatrix path, no prelude uniform lookups', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const frame = normalizeRenderArgs(new Float32Array(16).fill(2));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));

    const matrices = gl.uniformMatrix4fv.mock.calls.map((c: unknown[]) => c[2]);
    expect(matrices).toContain(frame.matrix);
    const looked = gl.getUniformLocation.mock.calls.map((c: unknown[]) => c[1]);
    expect(looked).not.toContain('u_projection_matrix');
    expect(
      vertexSources(gl).some((s) => s.includes('uniform mat4 uMatrix;')),
    ).toBe(true);
  });

  it('caches per variant: same frame reuses the program AND the tile VAO', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const frame = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));
    const programs = gl.createProgram.mock.calls.length;
    const vaos = gl.createVertexArray.mock.calls.length;

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));
    expect(gl.createProgram.mock.calls.length).toBe(programs);
    expect(gl.createVertexArray.mock.calls.length).toBe(vaos);
  });

  it('a variant flip relinks once and rebuilds the tile VAO against the new program', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const legacy = normalizeRenderArgs(new Float32Array(16));
    const globe = normalizeRenderArgs(v5Args('globe', 1));

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacy));
    expect(gl.createProgram.mock.calls.length).toBe(1);
    expect(gl.createVertexArray.mock.calls.length).toBe(1);

    // Flip to globe: second program, VAO re-recorded (locations are per-program).
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(globe));
    expect(gl.createProgram.mock.calls.length).toBe(2);
    expect(gl.deleteVertexArray).toHaveBeenCalledTimes(1);
    expect(gl.createVertexArray.mock.calls.length).toBe(2);

    // Flip back: both programs already cached — only the VAO is rebuilt.
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacy));
    expect(gl.createProgram.mock.calls.length).toBe(2);
    expect(gl.deleteVertexArray).toHaveBeenCalledTimes(2);
    expect(gl.createVertexArray.mock.calls.length).toBe(3);
  });

  it('onContextReady pre-links the legacy variants so a legacy first frame never relinks', () => {
    const layer = new STTPointLayer({ ...baseOpts, id: 'p' }) as any;
    layer.supports32BitIndices = true;
    const gl = makeMockGl();
    layer.onContextReady(gl);
    // Visual + id programs, eagerly linked (first pick() must not stall).
    expect(gl.createProgram.mock.calls.length).toBe(2);

    const tile = makePointTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    const frame = normalizeRenderArgs(new Float32Array(16));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));
    expect(gl.createProgram.mock.calls.length).toBe(2);
  });
});

describe('drawPickTile variant dispatch', () => {
  it('v5 frame: id program compiled from the prelude source with u_projection_* set', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const frame = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawPickTile(gl, tile, tile.layers[0], cache, drawCtx(frame), 1);

    expect(
      vertexSources(gl).some(
        (s) =>
          s.includes(PRELUDE_MARKER) && s.includes('attribute vec3 aIdColor;'),
      ),
    ).toBe(true);
    const looked = gl.getUniformLocation.mock.calls.map((c: unknown[]) => c[1]);
    expect(looked).toContain('u_projection_matrix');
    const matrices = gl.uniformMatrix4fv.mock.calls.map((c: unknown[]) => c[2]);
    expect(matrices).toContain(frame.projectionData!.mainMatrix);
    expect(matrices).not.toContain(frame.matrix);
    // 2 features drawn, one-shot id buffer freed.
    expect(gl.drawArrays).toHaveBeenCalledWith(gl.POINTS, 0, 2);
    expect(gl.deleteBuffer).toHaveBeenCalled();
  });

  it('legacy frame: id program keeps the uMatrix path', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const frame = normalizeRenderArgs(new Float32Array(16).fill(3));
    layer.drawPickTile(gl, tile, tile.layers[0], cache, drawCtx(frame), 1);

    const matrices = gl.uniformMatrix4fv.mock.calls.map((c: unknown[]) => c[2]);
    expect(matrices).toContain(frame.matrix);
    const looked = gl.getUniformLocation.mock.calls.map((c: unknown[]) => c[1]);
    expect(looked).not.toContain('u_projection_matrix');
  });
});

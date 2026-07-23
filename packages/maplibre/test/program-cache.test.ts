/**
 * Per-variant program cache tests (D3): programs are cached per
 * `cacheKey::variantName` (a v5 host recompiles shaders per projection
 * variant; legacy hosts only ever see 'legacy'), the factory receives the
 * host's {prelude, define}, invalidation drops the whole cache, and
 * `setPreludeProjectionUniforms` maps the frame's defaultProjectionData onto
 * the prelude's `u_projection_*` uniforms with per-program location caching.
 */

import { describe, it, expect, vi } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import { STTBaseLayer } from '../src/base-layer';
import { normalizeRenderArgs } from '../src/lib/host-adapter';
import { makeMockGl } from './mock-gl';

class BareLayer extends STTBaseLayer {
  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.Point;
  }
  protected onContextReady(): void {}
  protected onContextLost(): void {}
  protected drawTile(): void {}
}

const baseOpts = {
  id: 'pc',
  url: 'mem://test.stt',
  currentTime: 0,
  timeWindow: 1000,
};

const mat16 = () => Array.from({ length: 16 }, (_, i) => i);

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
    mainMatrix: mat16(),
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 0, 1],
    projectionTransition: transition,
    fallbackMatrix: mat16(),
  },
});

describe('getOrCreateProgram', () => {
  it('caches per cacheKey::variantName and hands the factory the host prelude', () => {
    const layer = new BareLayer(baseOpts) as any;
    const gl = makeMockGl();
    let nextId = 0;
    const factory = vi.fn(
      (_gl: unknown, shader: { prelude: string; define: string }) => ({
        program: { id: nextId++ } as unknown as WebGLProgram,
        prelude: shader.prelude,
        define: shader.define,
      }),
    );

    const legacy = normalizeRenderArgs(new Float32Array(16));
    const a = layer.getOrCreateProgram(gl, 'main', legacy, factory);
    const a2 = layer.getOrCreateProgram(gl, 'main', legacy, factory);
    expect(a2).toBe(a);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(a.prelude).toBe('');
    expect(a.define).toBe('');

    // Same cacheKey, different variant → separate program.
    const globe = normalizeRenderArgs(v5Args('globe', 1));
    const b = layer.getOrCreateProgram(gl, 'main', globe, factory);
    expect(b).not.toBe(a);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(b.prelude).toBe('// globe prelude');
    expect(b.define).toBe('#define GLOBE');

    // Different cacheKey, same variant → separate program.
    const c = layer.getOrCreateProgram(gl, 'pick', globe, factory);
    expect(c).not.toBe(b);
    expect(factory).toHaveBeenCalledTimes(3);

    // Back to a cached variant → no relink.
    layer.getOrCreateProgram(
      gl,
      'main',
      normalizeRenderArgs(v5Args('globe')),
      factory,
    );
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it('invalidateProgramCache(gl) deletes programs; without gl it only drops refs', () => {
    const layer = new BareLayer(baseOpts) as any;
    const gl = makeMockGl();
    const factory = () => ({ program: { id: 'p' } as unknown as WebGLProgram });
    const legacy = normalizeRenderArgs(new Float32Array(16));
    const v5 = normalizeRenderArgs(v5Args('mercator'));
    layer.getOrCreateProgram(gl, 'main', legacy, factory);
    layer.getOrCreateProgram(gl, 'main', v5, factory);
    expect(layer.programCache.size).toBe(2);

    layer.invalidateProgramCache(gl);
    expect(gl.deleteProgram).toHaveBeenCalledTimes(2);
    expect(layer.programCache.size).toBe(0);

    layer.getOrCreateProgram(gl, 'main', legacy, factory);
    gl.deleteProgram.mockClear();
    layer.invalidateProgramCache(); // context-loss path: no GL calls
    expect(gl.deleteProgram).not.toHaveBeenCalled();
    expect(layer.programCache.size).toBe(0);
  });
});

describe('setPreludeProjectionUniforms', () => {
  it('sets the five u_projection_* uniforms from the frame, caching locations per program', () => {
    const layer = new BareLayer(baseOpts) as any;
    const gl = makeMockGl();
    const program = { id: 'prog' } as unknown as WebGLProgram;
    const frame = normalizeRenderArgs(v5Args('globe', 0.5));

    layer.setPreludeProjectionUniforms(gl, program, frame);
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
    // mainMatrix + fallbackMatrix as mat4, coords + clipping plane as vec4,
    // transition as float — all straight from the frame's scratch storage.
    expect(gl.uniformMatrix4fv).toHaveBeenCalledTimes(2);
    expect(gl.uniformMatrix4fv).toHaveBeenCalledWith(
      expect.anything(),
      false,
      frame.projectionData!.mainMatrix,
    );
    expect(gl.uniform4fv).toHaveBeenCalledTimes(2);
    expect(gl.uniform1f).toHaveBeenCalledWith(expect.anything(), 0.5);

    // Second call: locations come from the per-program cache.
    const lookupCount = gl.getUniformLocation.mock.calls.length;
    layer.setPreludeProjectionUniforms(gl, program, frame);
    expect(gl.getUniformLocation.mock.calls.length).toBe(lookupCount);
    expect(gl.uniformMatrix4fv).toHaveBeenCalledTimes(4);
  });

  it('is a no-op on legacy frames (uMatrix path owns projection there)', () => {
    const layer = new BareLayer(baseOpts) as any;
    const gl = makeMockGl();
    const program = { id: 'prog' } as unknown as WebGLProgram;
    layer.setPreludeProjectionUniforms(
      gl,
      program,
      normalizeRenderArgs(new Float32Array(16)),
    );
    expect(gl.getUniformLocation).not.toHaveBeenCalled();
    expect(gl.uniformMatrix4fv).not.toHaveBeenCalled();
  });
});

/**
 * Polygon-layer projection variants (maplibre parity campaign D3/D4/D10).
 *
 * String-level: the fill/stroke vertex-source builders emit the legacy
 * `uMatrix` shaders verbatim for an empty prelude, and prelude-injected
 * sources for v5+ hosts — flat fills through `projectTile` (2d, the host owns
 * z), extruded prisms through `projectTileFor3D` (elevation in meters).
 * Behaviour-level (mock-gl): drawTile links one program per shader variant
 * through the base cache, sets the prelude projection uniforms on v5 frames
 * (and uMatrix only on legacy ones), re-records both fill and stroke VAOs on
 * a variant flip, converts `altitudeScale` mercator-z → meters on the prelude
 * path, and prelude hosts bake globe subdivision into the tile caches at
 * build time. Real prelude compilation is browser-verified.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  STTPolygonLayer,
  buildFillVertexSource,
  buildStrokeVertexSource,
  MERCATOR_Z_TO_METERS_MIDLAT,
} from '../src/layers/polygon-layer';
import { normalizeRenderArgs } from '../src/lib/host-adapter';
import { lngLatToMercator } from '../src/lib/projection';
import { makeMockGl, makeMockMap } from './mock-gl';
import { makePolygonTile } from './fixtures';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

const PRELUDE_MARKER = '// __HOST_PRELUDE__';
const PRELUDE = `${PRELUDE_MARKER}
uniform mat4 u_projection_matrix;
vec4 projectTile(vec2 p) { return u_projection_matrix * vec4(p, 0.0, 1.0); }
vec4 projectTileFor3D(vec2 p, float elev) { return u_projection_matrix * vec4(p, elev, 1.0); }`;

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

function makeLayer(opts: Record<string, unknown> = {}): any {
  const layer = new STTPolygonLayer({ ...baseOpts, id: 'g', ...opts }) as any;
  layer.supports32BitIndices = true;
  layer.instSupport = {
    enabled: true,
    drawArraysInstanced: vi.fn(),
    drawElementsInstanced: vi.fn(),
    vertexAttribDivisor: vi.fn(),
  };
  return layer;
}

function makeLayerWithCache(opts: Record<string, unknown> = {}) {
  const layer = makeLayer(opts);
  const gl = makeMockGl();
  // The real `initVaoSupport` runs in onAdd, which these direct-hook tests
  // bypass — wire the mock's VAO entry points so VAO reuse/rebuild is real.
  layer.vaoSupport = {
    enabled: true,
    create: () => gl.createVertexArray(),
    bind: (vao: unknown) => gl.bindVertexArray(vao),
    delete: (vao: unknown) => gl.deleteVertexArray(vao),
  };
  const tile = makePolygonTile();
  const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
  return { layer, gl, tile, cache };
}

describe('polygon fill vertex-source builder', () => {
  it('legacy variant (empty prelude) is the verbatim uMatrix shader', () => {
    const src = buildFillVertexSource({ prelude: '', define: '' });
    expect(src).toContain('uniform mat4 uMatrix;');
    expect(src).toContain(
      'uMatrix * vec4(aMercator.x, aMercator.y, aMercator.z * uAltitudeScale, 1.0)',
    );
    expect(src).not.toContain('projectTile');
    expect(src).not.toContain('uExtruded');
    expect(src).toContain('sttTimeWindowAlpha(aTime,');
  });

  it('v5 variant prepends prelude then define and projects via projectTile / projectTileFor3D', () => {
    const src = buildFillVertexSource({
      prelude: PRELUDE,
      define: '#define GLOBE',
    });
    expect(src.startsWith(`\n${PRELUDE}`)).toBe(true);
    const defineAt = src.indexOf('#define GLOBE');
    expect(defineAt).toBeGreaterThan(src.indexOf(PRELUDE_MARKER));
    expect(defineAt).toBeLessThan(src.indexOf('attribute vec3 aMercator'));
    // Flat fills are 2d (prelude owns z for horizon clipping); extruded
    // prisms are real 3D with elevation in meters (uniform-wide branch).
    expect(src).toContain(
      'projectTileFor3D(aMercator.xy, aMercator.z * uAltitudeScale)',
    );
    expect(src).toContain('projectTile(aMercator.xy)');
    expect(src).toContain('uniform float uExtruded;');
    // The prelude owns projection — no legacy matrix path left in the source.
    expect(src).not.toContain('uniform mat4 uMatrix;');
    // Time-window math unchanged from legacy.
    expect(src).toContain('sttTimeWindowAlpha(aTime,');
  });
});

describe('polygon stroke vertex-source builder', () => {
  it('legacy variant is the verbatim uMatrix shader', () => {
    const src = buildStrokeVertexSource({ prelude: '', define: '' });
    expect(src).toContain('uniform mat4 uMatrix;');
    expect(src).toContain('uMatrix * vec4(posM, 0.0, 1.0)');
    expect(src).not.toContain('projectTile');
  });

  it('v5 variant projects both edge endpoints via projectTile with identical expansion math', () => {
    const legacy = buildStrokeVertexSource({ prelude: '', define: '' });
    const v5 = buildStrokeVertexSource({
      prelude: PRELUDE,
      define: '#define GLOBE',
    });
    expect(v5.startsWith(`\n${PRELUDE}`)).toBe(true);
    expect(v5).toContain('projectTile(posM)');
    expect(v5).toContain('projectTile(neighborM)');
    expect(v5).not.toContain('uniform mat4 uMatrix;');
    // The screen-space quad expansion is post-projection and must stay
    // byte-identical across variants (same width/side math as STTLineLayer).
    for (const line of [
      'vec2 dirPx = (thereNdc - hereNdc) * 0.5 * uViewport;',
      'vec2 offsetPx = perp * aCorner.x * uWidth * 0.5;',
      'outClip.xy += offsetNdc * here.w;',
    ]) {
      expect(legacy).toContain(line);
      expect(v5).toContain(line);
    }
  });
});

describe('polygon drawTile variant dispatch', () => {
  it('v5 frame: compiles the prelude fill source, sets u_projection_* and skips uMatrix', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const frame = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));

    expect(
      vertexSources(gl).some(
        (s) => s.includes(PRELUDE_MARKER) && s.includes('projectTileFor3D('),
      ),
    ).toBe(true);
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
    expect(gl.drawElements).toHaveBeenCalledWith(
      gl.TRIANGLES,
      6,
      gl.UNSIGNED_SHORT,
      0,
    );
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

  it('a variant flip relinks once and re-records the fill VAO', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const legacy = normalizeRenderArgs(new Float32Array(16));
    const globe = normalizeRenderArgs(v5Args('globe', 1));

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacy));
    expect(gl.createProgram.mock.calls.length).toBe(1);
    expect(gl.createVertexArray.mock.calls.length).toBe(1);

    // Flip to globe: second program, VAO re-recorded (locations per-program).
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

  it('D10 stopgap: uAltitudeScale is mercator-z on legacy, meters on the prelude path', () => {
    const altitudeScale = 1e-7;
    const { layer, gl, tile, cache } = makeLayerWithCache({
      extruded: true,
      elevation: 1000,
      altitudeScale,
    });
    const legacy = normalizeRenderArgs(new Float32Array(16));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacy));
    let values = gl.uniform1f.mock.calls.map((c: unknown[]) => c[1]);
    expect(values).toContain(altitudeScale);
    expect(values).not.toContain(altitudeScale * MERCATOR_Z_TO_METERS_MIDLAT);

    gl.uniform1f.mockClear();
    const globe = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(globe));
    values = gl.uniform1f.mock.calls.map((c: unknown[]) => c[1]);
    expect(values).toContain(altitudeScale * MERCATOR_Z_TO_METERS_MIDLAT);
    expect(values).not.toContain(altitudeScale);
  });

  it('stroke pass: v5 frame compiles the prelude stroke source and skips uMatrix', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({ stroked: true });
    const frame = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));

    expect(
      vertexSources(gl).some(
        (s) => s.includes(PRELUDE_MARKER) && s.includes('projectTile(posM)'),
      ),
    ).toBe(true);
    const matrices = gl.uniformMatrix4fv.mock.calls.map((c: unknown[]) => c[2]);
    expect(matrices).not.toContain(frame.matrix);
    // Fill (drawElements) + instanced stroke quads over the ring edges.
    expect(layer.instSupport.drawArraysInstanced).toHaveBeenCalledWith(
      0x0005,
      0,
      4,
      cache.stroke.instanceCount,
    );
  });
});

describe('polygon globe subdivision (D4)', () => {
  it('legacy hosts bake no subdivision — geometry identical to the historical path', () => {
    const { cache } = makeLayerWithCache();
    expect(cache.subdivisionGranularity).toBe(0);
    expect(cache.vertexCount).toBe(4);
    expect(cache.indexCount).toBe(6);
  });

  it('prelude hosts refine fill triangles to the host granularity, keeping original verts', () => {
    const layer = makeLayer();
    layer.preludeProjected = true;
    const gl = makeMockGl();
    const tile = makePolygonTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    // No host map ⇒ MapLibre's default curve: z2 → 32 per tile, ×2² = 128
    // across the full mercator square (globe-kit convention).
    expect(cache.subdivisionGranularity).toBe(128);
    // The fixture square spans ~0.056 mercator per edge ≫ 1/128 — the fill
    // mesh must gain vertices.
    expect(cache.vertexCount).toBeGreaterThan(4);
    expect(cache.indexCount).toBeGreaterThan(6);
    // Original ring vertices are retained bit-exact at the head of the buffer
    // (subdivideTrianglesMercator keeps input verts at their own indices).
    const positions = gl.bufferData.mock.calls
      .map((c: unknown[]) => c[1])
      .find(
        (b: unknown): b is Float32Array =>
          b instanceof Float32Array && b.length === cache.vertexCount * 3,
      )!;
    const [mx, my] = lngLatToMercator(-10, -10);
    expect(positions[0]).toBeCloseTo(mx, 6);
    expect(positions[1]).toBeCloseTo(my, 6);
  });

  it('prelude hosts refine stroke edges — a 4-edge square becomes 32 instances at granularity 128', () => {
    const layer = makeLayer({ stroked: true });
    layer.preludeProjected = true;
    const gl = makeMockGl();
    const tile = makePolygonTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    // Each ~0.056-mercator edge splits into ceil(0.056 × 128) = 8 pieces.
    expect(cache.stroke.instanceCount).toBe(32);
  });

  it('extruded prelude walls band over the refined ring outline', () => {
    const layer = makeLayer({ extruded: true, elevation: 1000 });
    layer.preludeProjected = true;
    const gl = makeMockGl();
    const tile = makePolygonTile();
    const flat = makeLayer();
    flat.preludeProjected = true;
    const flatCache = flat.buildTileGpuCache(
      makeMockGl(),
      tile,
      tile.layers[0],
    );
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    // Walls duplicate the refined ring twice (top + bottom) on top of the
    // subdivided fill, and add 6 indices per refined edge.
    expect(cache.vertexCount).toBe(flatCache.vertexCount + 2 * 32);
    expect(cache.indexCount).toBe(flatCache.indexCount + 6 * 32);
  });
});

describe('polygon granularity-keyed caches (runtime projection switch)', () => {
  /** Host-style subdivision settings whose granularity tests can swap live. */
  function granularityHost(layer: any, initial: number) {
    const state = { g: initial };
    layer.map = {
      ...makeMockMap(),
      style: {
        projection: {
          subdivisionGranularity: {
            tile: { getGranularityForZoomLevel: () => state.g },
          },
        },
      },
    };
    return state;
  }

  it('a granularity change (mercator → globe setProjection) rebuilds under a new key', () => {
    const layer = makeLayer();
    layer.preludeProjected = true;
    // v5 mercator: per-tile granularity 1 ⇒ effectively no in-tile splits.
    const host = granularityHost(layer, 1);
    const gl = makeMockGl();
    const tile = makePolygonTile();

    const mercator = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    expect(mercator.subdivisionGranularity).toBe(4); // 1 × 2² at z2
    expect(mercator.vertexCount).toBe(4); // fixture edges < 1/4 mercator

    // Runtime switch to globe: the host projection object now reports the
    // real subdivision curve. preludeProjected does NOT flip, so only the
    // granularity-keyed cache catches this — chords must gain vertices or
    // they horizon-clip on globe.
    host.g = 32;
    const globe = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    expect(globe).not.toBe(mercator);
    expect(globe.subdivisionGranularity).toBe(128);
    expect(globe.vertexCount).toBeGreaterThan(4);
    expect(layer.tileGpuCache.size).toBe(2);

    // Switching back reuses the mercator-side entry — no rebuild.
    host.g = 1;
    expect(layer.ensureTileGpuCache(gl, tile, tile.layers[0])).toBe(mercator);
    expect(layer.tileGpuCache.size).toBe(2);
  });

  it('legacy hosts keep the plain base cache key (no granularity suffix)', () => {
    const layer = makeLayer();
    const gl = makeMockGl();
    const tile = makePolygonTile();
    const cache = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    expect(layer.ensureTileGpuCache(gl, tile, tile.layers[0])).toBe(cache);
    const keys = [...layer.tileGpuCache.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain('gran:');
  });
});

describe('polygon beginFrame projection-family tracking', () => {
  function makeRenderableLayer() {
    const { layer, gl, tile } = makeLayerWithCache();
    layer.gl = gl;
    layer.map = makeMockMap();
    layer.tileset = { update: vi.fn() };
    // Seed a cache through the base path so the rebuild sweep has a victim.
    layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    expect(layer.tileGpuCache.size).toBe(1);
    return { layer, gl, tile };
  }

  it('first prelude frame flips preludeProjected and rebuilds baked caches', () => {
    const { layer } = makeRenderableLayer();
    const frame = layer.beginFrame(v5Args('globe', 1));
    expect(frame).not.toBeNull();
    expect(layer.preludeProjected).toBe(true);
    expect(layer.tileGpuCache.size).toBe(0);
    expect(layer.map.triggerRepaint).toHaveBeenCalled();
  });

  it('legacy frames leave the baked caches alone', () => {
    const { layer } = makeRenderableLayer();
    const frame = layer.beginFrame(new Float32Array(16));
    expect(frame).not.toBeNull();
    expect(layer.preludeProjected).toBe(false);
    expect(layer.tileGpuCache.size).toBe(1);
  });
});

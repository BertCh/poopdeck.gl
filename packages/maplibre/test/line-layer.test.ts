/**
 * Line-layer projection variants (maplibre parity campaign D3/D4).
 *
 * String-level: the vertex-source builder emits the legacy uMatrix shader for
 * an empty prelude and a prelude-injected `projectTile` shader for v5+ hosts.
 * Behaviour-level (mock-gl): drawTile links one program per shader variant
 * through the base cache, sets the prelude projection uniforms on v5 frames,
 * re-records VAOs across variant flips, and globe frames build subdivided
 * tile caches keyed separately from the flat mercator entries.
 */

import { describe, it, expect, vi } from 'vitest';
import { GeometryType, type Tile } from '@poopdeck.gl/core';
import { STTLineLayer, buildLineVertexSource } from '../src/layers/line-layer';
import { normalizeRenderArgs } from '../src/lib/host-adapter';
import { makeMockGl, makeMockMap } from './mock-gl';
import { makeLineTile } from './fixtures';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

const PRELUDE =
  'uniform mat4 u_projection_matrix;\n' +
  'vec4 projectTile(vec2 p) { return u_projection_matrix * vec4(p, 0.0, 1.0); }';

const mat16 = () => Array.from({ length: 16 }, (_, i) => i);

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

function makeLayer(): any {
  const layer = new STTLineLayer({ ...baseOpts, id: 'l' }) as any;
  layer.supports32BitIndices = true;
  layer.instSupport = {
    enabled: true,
    drawArraysInstanced: vi.fn(),
    drawElementsInstanced: vi.fn(),
    vertexAttribDivisor: vi.fn(),
  };
  return layer;
}

const drawCtx = (frame: any) => ({
  matrix: frame.matrix,
  frame,
  windowStart: 0,
  windowEnd: 10_000,
  currentTime: baseOpts.currentTime,
  zoom: 2,
});

/** Single 2-vertex feature spanning 90° of longitude (0.25 mercator x). */
function makeLongSegmentTile(): Tile {
  const features = {
    featureCount: 1,
    geometryType: GeometryType.LineString,
    positionDimensions: 2 as const,
    positions: new Float64Array([-45, 0, 45, 0]),
    startIndices: new Uint32Array([0, 2]),
    featureIds: new Uint32Array([0]),
    startTimes: new Float32Array([0]),
    endTimes: new Float32Array([2000]),
    timeOffset: 1_700_000_000_000,
    numericProps: {},
    categoricalProps: {},
  };
  return {
    id: { z: 2, x: 1, y: 1, t: 1_700_000_000_000 },
    timeRange: { start: 1_700_000_000_000, end: 1_700_000_002_000 },
    layers: [
      {
        name: 'paths',
        extent: 4096,
        features,
        geometryExtensionName: 'geoarrow.linestring',
      },
    ],
  } as unknown as Tile;
}

describe('buildLineVertexSource', () => {
  it('legacy variant keeps the uMatrix path with nothing injected', () => {
    const src = buildLineVertexSource({ prelude: '', define: '' });
    expect(src).toContain('uniform mat4 uMatrix;');
    expect(src).toContain('uMatrix * vec4(posM, 0.0, 1.0)');
    expect(src).toContain('uMatrix * vec4(neighborM, 0.0, 1.0)');
    expect(src).not.toContain('projectTile');
    // Shared time-window include stays in both variants.
    expect(src).toContain('sttTimeWindowAlpha');
  });

  it('v5 variant prepends prelude + define and projects BOTH endpoints via projectTile', () => {
    const src = buildLineVertexSource({
      prelude: PRELUDE,
      define: '#define GLOBE',
    });
    expect(src.startsWith(PRELUDE)).toBe(true);
    // Injection order per maplibre's documented pattern: prelude, define, body.
    const defineAt = src.indexOf('#define GLOBE');
    expect(defineAt).toBeGreaterThan(src.indexOf('vec4 projectTile'));
    expect(defineAt).toBeLessThan(src.indexOf('void main'));
    // Both segment endpoints ride the prelude projection; uMatrix is gone.
    expect(src).toContain('projectTile(posM)');
    expect(src).toContain('projectTile(neighborM)');
    expect(src).not.toContain('uMatrix');
    expect(src).toContain('sttTimeWindowAlpha');
  });
});

describe('STTLineLayer per-variant programs', () => {
  it('drawTile links one program per shader variant and reuses cached ones', () => {
    const layer = makeLayer();
    const gl = makeMockGl();
    const tile = makeLineTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);

    const legacy = normalizeRenderArgs(new Float32Array(16));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacy));
    expect(gl.createProgram).toHaveBeenCalledTimes(1);
    const legacyVs = gl.shaderSource.mock.calls[0][1] as string;
    expect(legacyVs).toContain('uniform mat4 uMatrix;');
    expect(legacyVs).not.toContain('projectTile');

    // Same variant again → cached, no relink.
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacy));
    expect(gl.createProgram).toHaveBeenCalledTimes(1);

    // Variant flip → second program built from the host's injected prelude.
    const globe = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(globe));
    expect(gl.createProgram).toHaveBeenCalledTimes(2);
    const globeVs = gl.shaderSource.mock.calls
      .map((c: unknown[]) => c[1] as string)
      .find((s) => s.includes('projectTile(posM)'));
    expect(globeVs).toBeDefined();
    expect(globeVs!.startsWith(PRELUDE)).toBe(true);

    // Prelude projection uniforms were resolved + set on the v5 program.
    const looked = gl.getUniformLocation.mock.calls.map((c: unknown[]) => c[1]);
    expect(looked).toContain('u_projection_matrix');
    expect(gl.uniformMatrix4fv).toHaveBeenCalledWith(
      expect.anything(),
      false,
      globe.projectionData!.mainMatrix,
    );
  });

  it('re-records the VAO on a variant flip (attribute locations may move)', () => {
    const layer = makeLayer();
    const gl = makeMockGl();
    let vaoId = 0;
    const deleted: unknown[] = [];
    layer.vaoSupport = {
      enabled: true,
      create: vi.fn(() => ({ vao: vaoId++ })),
      bind: vi.fn(),
      delete: vi.fn((v: unknown) => deleted.push(v)),
    };
    const tile = makeLineTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);

    const legacy = normalizeRenderArgs(new Float32Array(16));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacy));
    const firstVao = cache.vao;
    expect(firstVao).toBeTruthy();
    expect(cache.vaoVariant).toBe('legacy');

    // Same variant → same VAO, no delete.
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacy));
    expect(cache.vao).toBe(firstVao);
    expect(deleted).toHaveLength(0);

    const globe = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(globe));
    expect(deleted).toContain(firstVao);
    expect(cache.vao).not.toBe(firstVao);
    expect(cache.vaoVariant).toBe('globe');
  });
});

describe('STTLineLayer globe subdivision', () => {
  it('subdivides long segments on globe frames and keys caches separately', () => {
    const layer = makeLayer();
    layer.map = makeMockMap(); // no style.projection → default granularity curve
    const gl = makeMockGl();
    const tile = makeLongSegmentTile();
    const tileLayer = tile.layers[0];

    const flat = layer.ensureTileGpuCache(gl, tile, tileLayer);
    expect(flat.instanceCount).toBe(1);

    // Default per-tile granularity at z2 is floor(128/4) = 32 → ×2² = 128
    // across the mercator square; a 0.25-span segment splits into 32 pieces.
    layer.frameIsGlobe = true;
    const globe = layer.ensureTileGpuCache(gl, tile, tileLayer);
    expect(globe).not.toBe(flat);
    expect(globe.instanceCount).toBe(32);

    // posA/posB/times are the three stride-2 uploads (32 segments × 2).
    const uploads = gl.bufferData.mock.calls
      .map((c: unknown[]) => c[1])
      .filter((a: unknown) => a instanceof Float32Array && a.length === 64);
    expect(uploads).toHaveLength(3);
    const [posA, posB, times] = uploads as Float32Array[];
    // Original endpoints survive; pieces are even; consecutive segments chain.
    expect(posA[0]).toBeCloseTo(0.375, 6);
    expect(posB[63 - 1]).toBeCloseTo(0.625, 6);
    expect(posB[0]).toBeCloseTo(posA[2], 6);
    expect(posB[0] - posA[0]).toBeCloseTo(0.25 / 32, 6);
    // Per-feature times broadcast to every subdivided segment.
    expect(times[0]).toBe(0);
    expect(times[1]).toBe(2000);
    expect(times[62]).toBe(0);
    expect(times[63]).toBe(2000);

    // Both entries coexist: flipping projection reuses either side unrebuilt.
    layer.frameIsGlobe = false;
    expect(layer.ensureTileGpuCache(gl, tile, tileLayer)).toBe(flat);
    layer.frameIsGlobe = true;
    expect(layer.ensureTileGpuCache(gl, tile, tileLayer)).toBe(globe);
    expect(layer.tileGpuCache.size).toBe(2);
  });

  it('honors a host-supplied subdivisionGranularity object', () => {
    const layer = makeLayer();
    layer.map = makeMockMap();
    layer.map.style = {
      projection: {
        subdivisionGranularity: {
          tile: { getGranularityForZoomLevel: () => 4 },
        },
      },
    };
    layer.frameIsGlobe = true;
    const gl = makeMockGl();
    const tile = makeLongSegmentTile();
    // Host per-tile granularity 4 → ×2² = 16 total → 0.25 span = 4 pieces.
    const cache = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache.instanceCount).toBe(4);
  });

  it('beginFrame stashes the frame globe flag for cache building', () => {
    const layer = makeLayer();
    layer.map = makeMockMap();
    layer.tileset = { update: vi.fn() };

    const frame = layer.beginFrame(v5Args('globe', 1), undefined);
    expect(frame.isGlobe).toBe(true);
    expect(layer.frameIsGlobe).toBe(true);

    layer.beginFrame(new Float32Array(16), undefined);
    expect(layer.frameIsGlobe).toBe(false);
  });
});

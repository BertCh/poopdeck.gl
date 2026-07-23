/**
 * Behaviour tests for STTTripsLayer. Same approach as layers.test.ts: drive the
 * `protected` hooks directly with a mock GL context and assert on cache shape
 * + the uniform values pushed by drawTile.
 *
 * The variant suite additionally asserts the D3 shader contract at the string
 * level: the 'legacy' variant keeps the historical uMatrix source, the v5
 * variant prepends the host prelude + define and projects via projectTile —
 * both compiled through the base per-variant program cache.
 */

import { describe, it, expect, vi } from 'vitest';
import { GeometryType, type Tile, type Layer } from '@poopdeck.gl/core';
import { STTTripsLayer } from '../src/layers/trips-layer';
import { normalizeRenderArgs } from '../src/lib/host-adapter';
import { trailAlphaJS } from '../src/shaders/time-window.glsl';
import { makeMockGl, makeMockMap } from './mock-gl';
import { makeTripsTile } from './fixtures';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_500,
  timeWindow: 5000,
};

const stubInstancing = (layer: any): void => {
  layer.supports32BitIndices = true;
  layer.instSupport = {
    enabled: true,
    drawArraysInstanced: vi.fn(),
    drawElementsInstanced: vi.fn(),
    vertexAttribDivisor: vi.fn(),
  };
};

const legacyCtx = () => ({
  matrix: new Float32Array(16),
  windowStart: 0,
  windowEnd: 0,
  currentTime: baseOpts.currentTime,
  zoom: 2,
});

const ctxFor = (frame: ReturnType<typeof normalizeRenderArgs>) => ({
  ...legacyCtx(),
  matrix: frame.matrix,
  frame,
});

const mat16 = () => Array.from({ length: 16 }, (_, i) => i + 1);
const V5_PRELUDE = 'vec4 projectTile(vec2 p) { return vec4(p, 0.0, 1.0); }';
const V5_DEFINE = '#define TEST_VARIANT';
const v5Args = (variantName: string, transition = 0) => ({
  fov: 0.6,
  nearZ: 1,
  farZ: 100,
  shaderData: {
    variantName,
    vertexShaderPrelude: V5_PRELUDE,
    define: V5_DEFINE,
  },
  defaultProjectionData: {
    mainMatrix: mat16(),
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 0, 1],
    projectionTransition: transition,
    fallbackMatrix: mat16(),
  },
});

/** The vertex source handed to the recorder (identified by its attributes). */
const vertexSourceOf = (gl: any): string => {
  const call = gl.shaderSource.mock.calls.find((c: unknown[]) =>
    String(c[1]).includes('aCorner'),
  );
  return call ? String(call[1]) : '';
};

/**
 * Single trip spanning most of the world at z2: mercator x span 340/360 ≈
 * 0.944. With the default granularity curve (per-tile 32 at z2 → full-square
 * 128) that subdivides into ceil(0.944 × 128) = 121 segments on globe.
 */
function makeLongTripTile(): Tile {
  const features = {
    featureCount: 1,
    geometryType: GeometryType.LineString,
    positionDimensions: 2 as const,
    positions: new Float64Array([-170, 0, 170, 0]),
    startIndices: new Uint32Array([0, 2]),
    featureIds: new Uint32Array([0]),
    startTimes: new Float32Array([0]),
    endTimes: new Float32Array([121]),
    timeOffset: 1_700_000_000_000,
    vertexTimestamps: new Float32Array([0, 121]),
    numericProps: {},
    categoricalProps: {},
  };
  const layer: Layer = {
    name: 'trips',
    extent: 4096,
    features,
    geometryExtensionName: 'geoarrow.linestring',
  };
  return {
    id: { z: 2, x: 1, y: 1, t: 1_700_000_000_000 },
    timeRange: { start: 1_700_000_000_000, end: 1_700_000_000_121 },
    layers: [layer],
  };
}

describe('STTTripsLayer', () => {
  it('only accepts LineString geometry', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    expect(layer.acceptsGeometry(GeometryType.Point)).toBe(false);
    expect(layer.acceptsGeometry(GeometryType.LineString)).toBe(true);
    expect(layer.acceptsGeometry(GeometryType.Polygon)).toBe(false);
  });

  it('emits one instance per segment with per-endpoint vertex times', () => {
    const layer = new STTTripsLayer({
      ...baseOpts,
      id: 't',
      trailLength: 1500,
    }) as any;
    stubInstancing(layer);
    const gl = makeMockGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache).not.toBeNull();
    // Path 0 has 3 verts → 2 segments, Path 1 has 2 verts → 1 segment → 3.
    expect(cache.instanceCount).toBe(3);
    expect(cache.indexCount).toBe(0);
    expect(cache.vertexTimeABBuffer).toBeDefined();
  });

  it('packs per-feature width and colour attributes when properties are set', () => {
    const layer = new STTTripsLayer({
      ...baseOpts,
      id: 't',
      widthProperty: 'width',
      colorProperty: 'vehicleType',
    }) as any;
    stubInstancing(layer);
    const gl = makeMockGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache).not.toBeNull();
    expect(cache.widthBuffer).toBeDefined();
    expect(cache.colorBuffer).toBeDefined();
  });

  it('uploads currentTime relative to tile timeOffset in drawTile', () => {
    const layer = new STTTripsLayer({
      ...baseOpts,
      id: 't',
      currentTime: 1_700_000_001_500,
      trailLength: 2000,
    }) as any;
    stubInstancing(layer);
    layer.onContextReady(makeMockGl());
    const gl = makeMockGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
    // currentTime - timeOffset = 1500
    const uniform1fCalls = gl.uniform1f.mock.calls as Array<[unknown, number]>;
    const values = uniform1fCalls.map((c) => c[1]);
    expect(values).toContain(1500);
    expect(values).toContain(2000); // trail length
    // The instanced draw is routed through `instSupport.drawArraysInstanced`,
    // which the test stub above records; just verify the layer did not fall
    // back to the legacy drawElements path.
    expect(layer.instSupport.drawArraysInstanced).toHaveBeenCalledTimes(1);
    expect(gl.drawElements).not.toHaveBeenCalled();
  });
});

describe('STTTripsLayer shader variants (D3)', () => {
  it('builds the legacy uMatrix source on legacy frames', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    stubInstancing(layer);
    const gl = makeMockGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());

    const vs = vertexSourceOf(gl);
    expect(vs).toContain('uniform mat4 uMatrix;');
    expect(vs).toContain('uMatrix * vec4(posM, 0.0, 1.0)');
    expect(vs).toContain('uMatrix * vec4(neighborM, 0.0, 1.0)');
    expect(vs).not.toContain('projectTile(');
    // Legacy MVP goes through uMatrix.
    expect(gl.uniformMatrix4fv).toHaveBeenCalledTimes(1);
  });

  it('prepends prelude + define and projects via projectTile on v5 frames', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    stubInstancing(layer);
    const gl = makeMockGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    const frame = normalizeRenderArgs(v5Args('mercator'));
    const ctx = ctxFor(frame);
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);

    const vs = vertexSourceOf(gl);
    expect(vs).toContain(V5_PRELUDE);
    expect(vs).toContain(V5_DEFINE);
    expect(vs).toContain('projectTile(posM)');
    expect(vs).toContain('projectTile(neighborM)');
    expect(vs).not.toContain('uniform mat4 uMatrix');
    // Prelude before define, both before main (declaration order matters).
    expect(vs.indexOf(V5_PRELUDE)).toBeGreaterThanOrEqual(0);
    expect(vs.indexOf(V5_PRELUDE)).toBeLessThan(vs.indexOf(V5_DEFINE));
    expect(vs.indexOf(V5_DEFINE)).toBeLessThan(vs.indexOf('void main'));

    // Projection rides the prelude's u_projection_* uniforms — the legacy
    // MVP must never be pushed to a projectTile program.
    const mat4Targets = gl.uniformMatrix4fv.mock.calls.map(
      (c: unknown[]) => c[2],
    );
    expect(mat4Targets).toContain(frame.projectionData!.mainMatrix);
    expect(mat4Targets).toContain(frame.projectionData!.fallbackMatrix);
    expect(mat4Targets).not.toContain(ctx.matrix);
  });

  it('caches one program per variant across frames', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    stubInstancing(layer);
    const gl = makeMockGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);

    layer.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
    layer.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
    expect(gl.createProgram).toHaveBeenCalledTimes(1);

    const v5 = normalizeRenderArgs(v5Args('mercator'));
    layer.drawTile(gl, tile, tile.layers[0], cache, ctxFor(v5));
    expect(gl.createProgram).toHaveBeenCalledTimes(2);
    layer.drawTile(gl, tile, tile.layers[0], cache, ctxFor(v5));
    expect(gl.createProgram).toHaveBeenCalledTimes(2);
  });

  it('rebuilds the VAO when the shader variant flips (locations relink)', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    stubInstancing(layer);
    layer.vaoSupport = {
      enabled: true,
      create: vi.fn(() => ({ __vao: true })),
      bind: vi.fn(),
      delete: vi.fn(),
    };
    const gl = makeMockGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);

    layer.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
    expect(cache.vao).toBeTruthy();
    expect(cache.vaoVariant).toBe('legacy');
    expect(layer.vaoSupport.create).toHaveBeenCalledTimes(1);

    const v5 = normalizeRenderArgs(v5Args('mercator'));
    layer.drawTile(gl, tile, tile.layers[0], cache, ctxFor(v5));
    expect(layer.vaoSupport.delete).toHaveBeenCalledTimes(1);
    expect(cache.vaoVariant).toBe('mercator');
    expect(layer.vaoSupport.create).toHaveBeenCalledTimes(2);

    // Same variant again → recorded VAO reused, no churn.
    layer.drawTile(gl, tile, tile.layers[0], cache, ctxFor(v5));
    expect(layer.vaoSupport.create).toHaveBeenCalledTimes(2);
    expect(layer.vaoSupport.delete).toHaveBeenCalledTimes(1);
  });
});

describe('STTTripsLayer globe geometry (D4)', () => {
  it('does not subdivide off-globe', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    stubInstancing(layer);
    const gl = makeMockGl();
    const tile = makeLongTripTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache.instanceCount).toBe(1);
  });

  it('caches flat and globe geometry under separate keys — a transition crossing swaps, not rebuilds', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    stubInstancing(layer);
    layer.map = makeMockMap();
    const gl = makeMockGl();
    const tile = makeLongTripTile();

    const flat = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    expect(flat.instanceCount).toBe(1); // unsubdivided mercator geometry

    // Crossing into globe (projectionTransition > 0): a globe-keyed cache is
    // built with subdivided chords; the flat entry is retained.
    layer.frameIsGlobe = true;
    const globe = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    expect(globe).not.toBe(flat);
    expect(globe.instanceCount).toBe(121);
    expect(layer.tileGpuCache.size).toBe(2);

    // Crossing back and forth reuses whichever side exists — the automatic
    // globe⇄mercator transition boundary (~z11) swaps buffers instead of
    // re-tessellating every resident tile in one frame.
    layer.frameIsGlobe = false;
    expect(layer.ensureTileGpuCache(gl, tile, tile.layers[0])).toBe(flat);
    layer.frameIsGlobe = true;
    expect(layer.ensureTileGpuCache(gl, tile, tile.layers[0])).toBe(globe);
    expect(layer.tileGpuCache.size).toBe(2);
  });

  it('beginFrame stashes the frame globe flag; globe-built caches draw on globe frames', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    stubInstancing(layer);
    layer.map = makeMockMap();
    layer.tileset = { update: vi.fn() };
    const gl = makeMockGl();
    const tile = makeTripsTile();

    expect(layer.beginFrame(v5Args('globe', 1))).not.toBeNull();
    expect(layer.frameIsGlobe).toBe(true);

    const globeFrame = normalizeRenderArgs(v5Args('globe', 1));
    const cache = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(gl, tile, tile.layers[0], cache, ctxFor(globeFrame));
    expect(layer.instSupport.drawArraysInstanced).toHaveBeenCalledTimes(1);

    expect(layer.beginFrame(new Float32Array(16))).not.toBeNull();
    expect(layer.frameIsGlobe).toBe(false);
  });

  it('subdivides globe segments and interpolates vertex times in lock-step', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    stubInstancing(layer);
    layer.frameIsGlobe = true;
    const gl = makeMockGl();
    const tile = makeLongTripTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache.instanceCount).toBe(121);

    // Upload order: posA, posB, vTimeAB, dummy timeBuffer.
    const uploads = gl.bufferData.mock.calls.map((c: unknown[]) => c[1]);
    const posA = uploads[0] as Float32Array;
    const posB = uploads[1] as Float32Array;
    const vTimeAB = uploads[2] as Float32Array;
    expect(posA.length).toBe(242);
    expect(vTimeAB.length).toBe(242);

    // Original endpoints verbatim: mercator x of ±170°.
    expect(posA[0]).toBeCloseTo(-170 / 360 + 0.5, 6);
    expect(posB[240]).toBeCloseTo(170 / 360 + 0.5, 6);
    expect(vTimeAB[0]).toBe(0);
    expect(vTimeAB[241]).toBe(121);
    // Even spacing → time at inserted vertex k is exactly k here.
    expect(vTimeAB[1]).toBeCloseTo(1, 4);

    // Watertight chain: segment k's B endpoint is segment k+1's A endpoint,
    // in both position and time — no cracks, monotonic time along the trip.
    for (let k = 0; k < 120; k++) {
      expect(posB[k * 2]).toBe(posA[(k + 1) * 2]);
      expect(posB[k * 2 + 1]).toBe(posA[(k + 1) * 2 + 1]);
      expect(vTimeAB[k * 2 + 1]).toBe(vTimeAB[(k + 1) * 2]);
      expect(vTimeAB[k * 2 + 1]).toBeGreaterThan(vTimeAB[k * 2]);
    }

    // Interpolated times feed the SAME shared trail snippet: alpha at an
    // inserted vertex equals the linear-mapping reference.
    const trailLength = 121;
    const currentTime = 121;
    const midTime = vTimeAB[121]; // some inserted vertex's time
    expect(trailAlphaJS(midTime, currentTime, trailLength, 1)).toBeCloseTo(
      1 - (currentTime - midTime) / trailLength,
      6,
    );
  });
});

/**
 * Flow corridor family (Wave M4): a static network whose per-reach MAGNITUDE is
 * a time series driving WIDTH and COLOUR.
 *
 * The suite pins the family's one load-bearing promise — geometry is tessellated
 * ONCE per tile and NEVER rebuilt for a time change — alongside the usual four
 * layers of coverage:
 *
 *  - **prop defaults** — the compiled mode precedence, the width/offset defaults,
 *    the corridor↔stroke default split, ramp-compiles-only-with-≥2-stops;
 *  - **JS references** — `corridorHalfWidthMercator`, `sampleFlowRampJS` and
 *    `resolveCorridorWidthScale`, the CPU twins of shader expressions;
 *  - **shader strings** — BOTH host variants (legacy `uMatrix` / v5 prelude) for
 *    every mode, both magnitude sources, with and without filter and ramp, in
 *    both passes; the CPU source carries NO texture sampler;
 *  - **mock-gl draws** — the ribbon tessellation, the value-matrix texture
 *    upload, the per-frame `uFlowBucket`-only update (GEOMETRY CACHE STABILITY,
 *    a first-class test here), the CPU sub-step gate, and the pick pass
 *    reproducing every visibility gate (invisible ⇒ unpickable).
 *
 * Real prelude compilation and the pick FBO round-trip stay browser-verified.
 */

import { describe, it, expect, vi } from 'vitest';
import { GeometryType, type Layer, type Tile } from '@poopdeck.gl/core';
import { normalizeRenderArgs } from '../src/lib/host-adapter';
import {
  STTFlowCorridorLayer,
  STTFlowStrokeLayer,
  FLOW_RAMP_STOPS,
  buildFlowCorridorVertexSource,
  buildFlowCorridorIdVertexSource,
  corridorHalfWidthMercator,
  flowCorridorProgramKey,
  resolveCorridorWidthScale,
  resolveFlowCorridorTimeFilterMode,
  sampleFlowRampJS,
  type FlowCorridorShaderConfig,
} from '../src/layers/flow-corridor-layer';
import { flowWidthJS, flowSamplerCacheKey } from '../src/shaders/flow.glsl';
import {
  bucketPositionAt,
  deriveFlowAxis,
  mercatorPerPixel,
  sampleFlowMatrixJS,
} from '../src/lib/flow-kernel';
import { metersToMercatorUnits } from '../src/lib/projection';
import { makeMockGl } from './mock-gl';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_004_000,
  timeWindow: 8000,
};

const PRELUDE_MARKER = '// __HOST_PRELUDE__';
const PRELUDE = `${PRELUDE_MARKER}
uniform mat4 u_projection_matrix;
vec4 projectTile(vec2 p) { return u_projection_matrix * vec4(p, 0.0, 1.0); }`;
const LEGACY_SHADER = { prelude: '', define: '' };
const V5_SHADER = { prelude: PRELUDE, define: '' };

const cfg = (
  over: Partial<FlowCorridorShaderConfig> = {},
): FlowCorridorShaderConfig => ({
  mode: 'window',
  magnitude: 'texture',
  format: 'float32',
  filter: false,
  ramp: false,
  ...over,
});

const bothVariants = (c: FlowCorridorShaderConfig): [string, string] => [
  buildFlowCorridorVertexSource(LEGACY_SHADER, c),
  buildFlowCorridorVertexSource(V5_SHADER, c),
];

const mat16 = () => Array.from({ length: 16 }, (_, i) => i + 1);

/** v5 render-args shape (recorded, not imported — the dev dep stays ^4). */
const v5Args = (variantName: string, transition = 0) => ({
  fov: 0.6,
  nearZ: 1,
  farZ: 100,
  shaderData: { variantName, vertexShaderPrelude: PRELUDE, define: '' },
  defaultProjectionData: {
    mainMatrix: mat16(),
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 0, 1],
    projectionTransition: transition,
    fallbackMatrix: mat16(),
  },
});

const drawCtx = (
  frame?: ReturnType<typeof normalizeRenderArgs>,
  currentTime = baseOpts.currentTime,
) => ({
  matrix: frame ? frame.matrix : new Float32Array(16),
  frame,
  windowStart: 0,
  windowEnd: 8000,
  currentTime,
  zoom: 2,
});

const legacyFrame = () => normalizeRenderArgs(new Float32Array(16));

/**
 * A flow tile: two reaches, each spanning the whole 8 s range, carrying a
 * vertex-major value matrix (5 vertices × 4 timesteps). Entry (v, b) is a
 * distinctive number so the sampler / packing can be traced.
 */
function makeFlowTile(over: Partial<any> = {}): Tile {
  const positions = new Float64Array([
    // Reach 0: 3 vertices (global 0,1,2)
    -73.95, 40.75, -71.05, 42.36, -69.5, 44.0,
    // Reach 1: 2 vertices (global 3,4)
    -122.4, 37.7, -118.24, 34.05,
  ]);
  const startIndices = new Uint32Array([0, 3, 5]);
  const buckets = 4;
  const matrix = new Float32Array(5 * buckets);
  for (let v = 0; v < 5; v++) {
    for (let b = 0; b < buckets; b++)
      matrix[v * buckets + b] = (v + 1) * 10 + b;
  }
  const features = {
    featureCount: 2,
    geometryType: GeometryType.LineString,
    positionDimensions: 2 as const,
    positions,
    startIndices,
    featureIds: new Uint32Array([0, 1]),
    // A flow reach spans the whole tile range: [0, 8000] relative.
    startTimes: new Float32Array([0, 0]),
    endTimes: new Float32Array([8000, 8000]),
    timeOffset: 1_700_000_000_000,
    vertexValueMatrix: matrix,
    vertexValueBuckets: buckets,
    numericProps: {},
    categoricalProps: {},
    ...over,
  };
  const layer: Layer = {
    name: 'corridors',
    extent: 4096,
    features: features as any,
    geometryExtensionName: 'geoarrow.linestring',
  };
  return {
    id: { z: 2, x: 1, y: 1, t: 1_700_000_000_000 },
    timeRange: { start: 1_700_000_000_000, end: 1_700_000_008_000 },
    layers: [layer],
  };
}

/**
 * Build a mock GL that ADVERTISES vertex-texture fetch, so the layer takes the
 * texture magnitude path (the design). The default recorder reports zero vertex
 * texture units, which is the WebGL1 fallback the CPU tests want.
 */
function makeTextureGl(): any {
  const gl = makeMockGl();
  const MAX_VERTEX_TEXTURE_IMAGE_UNITS = 0x8b4c;
  const MAX_TEXTURE_SIZE = 0x0d33;
  gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS = MAX_VERTEX_TEXTURE_IMAGE_UNITS;
  gl.MAX_TEXTURE_SIZE = MAX_TEXTURE_SIZE;
  const inner = gl.getParameter;
  gl.getParameter = vi.fn((pname: number) => {
    if (pname === MAX_VERTEX_TEXTURE_IMAGE_UNITS) return 16;
    if (pname === MAX_TEXTURE_SIZE) return 4096;
    return inner(pname);
  });
  // uploadMatrixTexture probes these before using them; absent ⇒ skipped.
  gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0x9241;
  gl.UNPACK_FLIP_Y_WEBGL = 0x9240;
  gl.UNPACK_ALIGNMENT = 0x0cf5;
  gl.pixelStorei = vi.fn();
  return gl;
}

/**
 * A layer wired for direct buildTileGpuCache/drawTile hooks (the column-suite
 * convention): each attribute NAME gets its own slot so a per-slot assertion is
 * not vacuous, and VAO support routes through the recorder so caching is
 * observable.
 */
function makeLayer(
  extra: Record<string, unknown> = {},
  gl?: any,
  Ctor: typeof STTFlowCorridorLayer = STTFlowCorridorLayer,
) {
  const layer = new Ctor({ ...baseOpts, id: 'flow', ...extra } as any) as any;
  layer.supports32BitIndices = true;
  if (gl) {
    const slots = new Map<string, number>();
    gl.getAttribLocation = vi.fn((_p: unknown, name: string) => {
      if (!slots.has(name)) slots.set(name, slots.size);
      return slots.get(name)!;
    });
    layer.vaoSupport = {
      enabled: true,
      create: () => gl.createVertexArray(),
      bind: (vao: unknown) => gl.bindVertexArray(vao),
      delete: (vao: unknown) => gl.deleteVertexArray(vao),
      current: () => null,
    };
  }
  return layer;
}

/** Uniform uploads keyed by NAME (the column-suite join). */
function uniformsByName(gl: any): Map<string, unknown[][]> {
  const nameByLoc = new Map<unknown, string>();
  gl.getUniformLocation.mock.calls.forEach((call: unknown[], i: number) => {
    nameByLoc.set(gl.getUniformLocation.mock.results[i].value, call[1]);
  });
  const out = new Map<string, unknown[][]>();
  for (const fn of [
    gl.uniform1f,
    gl.uniform1i,
    gl.uniform2f,
    gl.uniform2fv,
    gl.uniform3fv,
    gl.uniform4fv,
  ]) {
    for (const call of fn.mock.calls) {
      const name = nameByLoc.get(call[0]);
      if (!name) continue;
      const list = out.get(name) ?? [];
      list.push(call.slice(1));
      out.set(name, list);
    }
  }
  return out;
}

const lastScalar = (u: Map<string, unknown[][]>, name: string): unknown =>
  u.get(name)?.at(-1)?.[0];

// ── prop defaults / back-compat ─────────────────────────────────────────────

describe('compiled time-filter mode', () => {
  it('follows deck precedence when the mode is unset', () => {
    expect(resolveFlowCorridorTimeFilterMode(undefined, 0, 0)).toBe('window');
    expect(resolveFlowCorridorTimeFilterMode(undefined, 100, 0)).toBe('wake');
    expect(resolveFlowCorridorTimeFilterMode(undefined, 0, 100)).toBe('trail');
    // cumulative > wake > trail is expressed by the caller passing the mode.
  });

  it('degrades a zero-length wake/trail to window', () => {
    expect(resolveFlowCorridorTimeFilterMode('wake', 0, 0)).toBe('window');
    expect(resolveFlowCorridorTimeFilterMode('trail', 0, 0)).toBe('window');
    expect(resolveFlowCorridorTimeFilterMode('wake', 100, 0)).toBe('wake');
    expect(resolveFlowCorridorTimeFilterMode('cumulative', 0, 0)).toBe(
      'cumulative',
    );
  });
});

describe('prop defaults', () => {
  it('corridor centres the ribbon; stroke separates the twin ribbons', () => {
    const corridor = makeLayer();
    expect(corridor.flowOpts.offsetWidths).toBe(0);
    const stroke = makeLayer({}, undefined, STTFlowStrokeLayer);
    expect(stroke.flowOpts.offsetWidths).toBeCloseTo(0.6, 12);
    // An explicit 0 turns a stroke back into a plain corridor.
    const flat = makeLayer({ offsetWidths: 0 }, undefined, STTFlowStrokeLayer);
    expect(flat.flowOpts.offsetWidths).toBe(0);
  });

  it('carries the deck flow-width defaults', () => {
    const layer = makeLayer();
    expect(layer.flowOpts.widthExponent).toBeCloseTo(0.5, 12);
    expect(layer.flowOpts.widthScale).toBe(1);
    expect(layer.flowOpts.minFlow).toBe(0);
    expect(layer.flowOpts.widthUnits).toBe('pixels');
  });

  it('compiles a ramp only when at least two stops are supplied', () => {
    expect(makeLayer().shaderConfig.ramp).toBe(false);
    expect(makeLayer({ colorRamp: [[0, 0, 0, 255]] }).shaderConfig.ramp).toBe(
      false,
    );
    expect(
      makeLayer({
        colorRamp: [
          [0, 0, 0, 255],
          [255, 255, 255, 255],
        ],
      }).shaderConfig.ramp,
    ).toBe(true);
  });

  it('a named filterProperty compiles the filter branch', () => {
    expect(makeLayer().shaderConfig.filter).toBe(false);
    expect(makeLayer({ filterProperty: 'order' }).shaderConfig.filter).toBe(
      true,
    );
  });

  it('the program key carries the sampler variant', () => {
    expect(
      flowCorridorProgramKey('main', cfg({ format: 'unorm16' })),
    ).toContain(flowSamplerCacheKey('unorm16'));
    expect(
      flowCorridorProgramKey('main', cfg({ magnitude: 'attribute' })),
    ).toContain('flow-cpu');
    // pick and main never collide on one program.
    expect(flowCorridorProgramKey('pick', cfg())).not.toBe(
      flowCorridorProgramKey('main', cfg()),
    );
  });
});

// ── JS references ───────────────────────────────────────────────────────────

describe('CPU references the shaders mirror', () => {
  it('corridorHalfWidthMercator = sttFlowWidth * 0.5 * widthToMercator', () => {
    const clamp = [0, 1e6];
    const p = {
      minFlow: 0,
      widthScale: 2,
      widthExponent: 0.5,
      widthClamp: clamp,
      widthToMercator: 3e-6,
    };
    const w = flowWidthJS(4, 0, 2, 0.5, clamp); // 2 * sqrt(4) = 4
    expect(corridorHalfWidthMercator(4, p)).toBeCloseTo(4 * 0.5 * 3e-6, 15);
    expect(corridorHalfWidthMercator(4, p)).toBeCloseTo(w * 0.5 * 3e-6, 15);
  });

  it('a below-threshold magnitude collapses the half-width to 0 (invisible)', () => {
    const p = {
      minFlow: 5,
      widthScale: 2,
      widthExponent: 0.5,
      widthClamp: [1, 100],
      widthToMercator: 1e-6,
    };
    // 3 <= minFlow ⇒ 0, and the ACTIVE-only clamp never resurrects it.
    expect(corridorHalfWidthMercator(3, p)).toBe(0);
    expect(corridorHalfWidthMercator(9, p)).toBeGreaterThan(0);
  });

  it('sampleFlowRampJS linearly interpolates flat RGBA stops', () => {
    const stops = [0, 0, 0, 1, 1, 1, 1, 1];
    const out: [number, number, number, number] = [0, 0, 0, 0];
    expect(sampleFlowRampJS(out, stops, 2, 0)).toEqual([0, 0, 0, 1]);
    expect(sampleFlowRampJS(out, stops, 2, 0.5)).toEqual([0.5, 0.5, 0.5, 1]);
    // Clamped at both ends; the top stop is not wrapped back to stop 0.
    expect(sampleFlowRampJS(out, stops, 2, 1)).toEqual([1, 1, 1, 1]);
    expect(sampleFlowRampJS(out, stops, 2, 2)).toEqual([1, 1, 1, 1]);
  });

  it('resolveCorridorWidthScale: pixels hold on-screen, meters hold ground', () => {
    const px = resolveCorridorWidthScale('pixels', 45, 3, 2);
    expect(px).toBeCloseTo(mercatorPerPixel(3, 512 * 2), 15);
    const m = resolveCorridorWidthScale('meters', 45, 3, 2);
    expect(m).toBeCloseTo(metersToMercatorUnits(1, 45), 15);
    // Pixel scale is latitude-free; metric scale is not.
    expect(resolveCorridorWidthScale('pixels', 0, 3, 2)).toBeCloseTo(px, 15);
    expect(resolveCorridorWidthScale('meters', 0, 3, 2)).not.toBeCloseTo(m, 12);
  });
});

// ── shader strings ──────────────────────────────────────────────────────────

describe('shader assembly', () => {
  it('both host variants build for every mode / source / feature combination', () => {
    const modes = ['window', 'wake', 'cumulative', 'trail'] as const;
    for (const mode of modes) {
      for (const magnitude of ['texture', 'attribute'] as const) {
        for (const filter of [false, true]) {
          for (const ramp of [false, true]) {
            for (const src of bothVariants(
              cfg({ mode, magnitude, filter, ramp }),
            )) {
              expect(src).toContain('void main()');
              expect(src).toContain('sttFlowWidth(');
              // The width-collapse guard is compiled unconditionally.
              expect(src).toContain('if (!(width > 0.0)) vAlpha = 0.0;');
            }
          }
        }
      }
    }
  });

  it('legacy projects through uMatrix; v5 through the injected projectTile', () => {
    const [legacy, v5] = bothVariants(cfg());
    expect(legacy).toContain('uniform mat4 uMatrix;');
    expect(legacy).toContain('uMatrix * vec4(posM, 0.0, 1.0)');
    expect(legacy).not.toContain('projectTile(posM)');
    expect(v5).toContain(PRELUDE_MARKER);
    expect(v5).toContain('projectTile(posM)');
    expect(v5).not.toContain('uniform mat4 uMatrix;');
  });

  it('the texture source samples the value matrix; the CPU source never does', () => {
    const [tex] = bothVariants(cfg({ magnitude: 'texture' }));
    expect(tex).toContain('sampler2D uFlowMatrix');
    expect(tex).toContain('sttFlowMagnitude(aFlowRow, uFlowBucket)');
    expect(tex).toContain('texture2D(uFlowMatrix');

    const [cpu] = bothVariants(cfg({ magnitude: 'attribute' }));
    expect(cpu).toContain('attribute float aFlowMagnitude');
    expect(cpu).not.toContain('sampler2D uFlowMatrix');
    expect(cpu).not.toContain('texture2D');
  });

  it('the ramp / filter branches appear only when compiled', () => {
    const [plain] = bothVariants(cfg());
    expect(plain).not.toContain('sttFlowRampColor(');
    expect(plain).not.toContain('sttDataFilterAlpha(');

    const [ramp] = bothVariants(cfg({ ramp: true }));
    expect(ramp).toContain('sttFlowRampColor(');
    expect(ramp).toContain(`uniform vec4 uFlowRamp[${FLOW_RAMP_STOPS}]`);

    const [filter] = bothVariants(cfg({ filter: true }));
    expect(filter).toContain('sttDataFilterAlpha(');
    expect(filter).toContain('aFilterValue');
  });

  it('the id pass folds the colour alpha into the visibility gate', () => {
    const id = buildFlowCorridorIdVertexSource(V5_SHADER, cfg());
    expect(id).toContain('vIdColor = aIdColor;');
    expect(id).toContain('vAlpha *= flowColor.a;');
    // The visual pass never emits an id varying.
    expect(buildFlowCorridorVertexSource(V5_SHADER, cfg())).not.toContain(
      'vIdColor',
    );
  });

  it('only the compiled mode declares its uniforms', () => {
    const [wake] = bothVariants(cfg({ mode: 'wake' }));
    expect(wake).toContain('uniform float uWakeLength;');
    expect(wake).not.toContain('uniform float uWindowStart;');
    const [win] = bothVariants(cfg());
    expect(win).toContain('uniform float uWindowStart;');
    expect(win).not.toContain('uniform float uWakeLength;');
  });
});

// ── mock-gl draws ───────────────────────────────────────────────────────────

describe('tile tessellation + draw (texture path)', () => {
  it('builds one merged ribbon and uploads the value matrix as a texture', () => {
    const gl = makeTextureGl();
    const layer = makeLayer({}, gl);
    const tile = makeFlowTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache).not.toBeNull();
    // Ribbon vertices = 2 per path vertex: reach0 3→6, reach1 2→4.
    expect(cache.vertexCount).toBe(10);
    expect(Array.from(cache.ribbonCounts)).toEqual([6, 4]);
    // Triangle indices: reach0 2 quads→12, reach1 1 quad→6.
    expect(cache.indexCount).toBe(18);
    expect(cache.matrixTexture).toBeDefined();
    // Exactly one texImage2D — the matrix upload, at build time.
    expect(gl.texImage2D).toHaveBeenCalledTimes(1);
    // The layer flipped to the texture magnitude source on cap probe.
    expect(layer.shaderConfig.magnitude).toBe('texture');
  });

  it('draws the whole tile in one indexed call and binds the matrix texture', () => {
    const gl = makeTextureGl();
    const layer = makeLayer({}, gl);
    const tile = makeFlowTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    const frame = normalizeRenderArgs(v5Args('mercator'));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));

    const elements = gl.drawCalls.filter((c: any) => c.kind === 'elements');
    expect(elements).toHaveLength(1);
    expect(elements[0].count).toBe(18);
    expect(gl.bindTexture).toHaveBeenCalledWith(
      gl.TEXTURE_2D,
      cache.matrixTexture,
    );

    const u = uniformsByName(gl);
    // The one per-frame scalar: the continuous timestep position.
    const axis = deriveFlowAxis(tile.layers[0].features)!;
    expect(lastScalar(u, 'uFlowBucket')).toBeCloseTo(
      bucketPositionAt(axis, baseOpts.currentTime),
      6,
    );
    expect(lastScalar(u, 'uFlowHasValues')).toBe(1);
  });

  it('GEOMETRY CACHE STABILITY: a time change touches only uFlowBucket', () => {
    const gl = makeTextureGl();
    const layer = makeLayer({}, gl);
    const tile = makeFlowTile();
    const buildSpy = vi.spyOn(layer, 'buildTileGpuCache');

    // Frame 1.
    const c1 = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      c1,
      drawCtx(normalizeRenderArgs(v5Args('mercator')), baseOpts.currentTime),
    );
    const pos = c1.positionBuffer;
    const extr = c1.extrusionBuffer;
    const tex = c1.matrixTexture;
    const buildsAfter1 = buildSpy.mock.calls.length;
    const texImageAfter1 = gl.texImage2D.mock.calls.length;
    const bufferDataAfter1 = gl.bufferData.mock.calls.length;

    // Frame 2 — a DIFFERENT playhead (different bucket).
    layer.opts.currentTime = baseOpts.currentTime + 2000;
    const c2 = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      c2,
      drawCtx(
        normalizeRenderArgs(v5Args('mercator')),
        baseOpts.currentTime + 2000,
      ),
    );

    // Same cache object, same GPU handles — nothing re-tessellated or re-uploaded.
    expect(c2).toBe(c1);
    expect(c2.positionBuffer).toBe(pos);
    expect(c2.extrusionBuffer).toBe(extr);
    expect(c2.matrixTexture).toBe(tex);
    // No second build, no second texture upload, no new vertex buffers.
    expect(buildSpy.mock.calls.length).toBe(buildsAfter1);
    expect(gl.texImage2D.mock.calls.length).toBe(texImageAfter1);
    expect(gl.bufferData.mock.calls.length).toBe(bufferDataAfter1);

    // The bucket really did move.
    const axis = deriveFlowAxis(tile.layers[0].features)!;
    const u = uniformsByName(gl);
    const buckets = (u.get('uFlowBucket') ?? []).map((c) => c[0]);
    expect(buckets.at(-1)).toBeCloseTo(
      bucketPositionAt(axis, baseOpts.currentTime + 2000),
      6,
    );
    expect(buckets.at(-1)).not.toBeCloseTo(
      bucketPositionAt(axis, baseOpts.currentTime),
      6,
    );
  });

  it('the flow tile cache key never carries the playhead', () => {
    const gl = makeTextureGl();
    const layer = makeLayer({}, gl);
    const tile = makeFlowTile();
    layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    for (const key of layer.tileGpuCache.keys()) {
      expect(key).toContain('corridors');
      expect(key).not.toMatch(/fp|bucket|step/);
    }
  });
});

describe('tile draw (CPU attribute fallback)', () => {
  it('a host without vertex texture fetch expands magnitudes into a dynamic buffer', () => {
    const gl = makeMockGl(); // default recorder ⇒ zero vertex texture units
    const layer = makeLayer({}, gl);
    const tile = makeFlowTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(layer.shaderConfig.magnitude).toBe('attribute');
    expect(cache.matrixTexture).toBeUndefined();
    expect(cache.magnitudeBuffer).toBeDefined();
    // No texture was uploaded on this path.
    expect(gl.texImage2D).not.toHaveBeenCalled();

    const frame = legacyFrame();
    // First draw fills the magnitude buffer once (cpuStep NaN → differs).
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));
    expect(gl.bufferSubData).toHaveBeenCalledTimes(1);
    // Same sub-step ⇒ no re-expansion.
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));
    expect(gl.bufferSubData).toHaveBeenCalledTimes(1);
    // A big jump crosses a sub-step ⇒ one more expansion, still no geometry work.
    const bufferDataBefore = gl.bufferData.mock.calls.length;
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(frame, baseOpts.currentTime + 4000),
    );
    expect(gl.bufferSubData).toHaveBeenCalledTimes(2);
    expect(gl.bufferData.mock.calls.length).toBe(bufferDataBefore);
  });

  it('the CPU magnitudes match sampleFlowMatrixJS at the sub-step', () => {
    const gl = makeMockGl();
    const layer = makeLayer({}, gl);
    const tile = makeFlowTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    // Vertex 0 of the merged ribbon addresses row 0 (reach 0's first vertex).
    const row0 = cache.vertexRows[0];
    const step = cache.cpuStep;
    expect(cache.cpuMagnitudes[0]).toBeCloseTo(
      sampleFlowMatrixJS(cache.matrix, row0, step),
      5,
    );
  });
});

describe('missing / static value channels', () => {
  it('a tile with no matrix draws at a constant magnitude, not blank', () => {
    const gl = makeTextureGl();
    const layer = makeLayer({}, gl);
    const tile = makeFlowTile({
      vertexValueMatrix: undefined,
      vertexValueBuckets: 0,
    });
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache).not.toBeNull();
    expect(cache.matrix).toBeNull();
    expect(cache.matrixTexture).toBeUndefined();
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(v5Args('mercator'))),
    );
    // uFlowHasValues 0 ⇒ the shader reads uFlowConstant, so the network draws.
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uFlowHasValues')).toBe(0);
    expect(gl.drawCalls.filter((c: any) => c.kind === 'elements')).toHaveLength(
      1,
    );
  });

  it('falls back to the static vertexValues channel as a one-column matrix', () => {
    const gl = makeTextureGl();
    const layer = makeLayer({}, gl);
    const tile = makeFlowTile({
      vertexValueMatrix: undefined,
      vertexValueBuckets: 0,
      vertexValues: new Float32Array([1, 2, 3, 4, 5]),
    });
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache.matrix).not.toBeNull();
    expect(cache.matrix.cols).toBe(1);
    expect(cache.matrixTexture).toBeDefined();
  });
});

// ── pick gating ─────────────────────────────────────────────────────────────

describe('pick pass', () => {
  it('is offered (the layer declares a drawPickTile hook)', () => {
    expect(makeLayer().supportsPicking()).toBe(true);
  });

  it('draws the tile into the id buffer and frees the per-pass id colours', () => {
    const gl = makeTextureGl();
    const layer = makeLayer({}, gl);
    const tile = makeFlowTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    const frame = normalizeRenderArgs(v5Args('mercator'));
    const before = gl.drawCalls.length;
    layer.drawPickTile(gl, tile, tile.layers[0], cache, drawCtx(frame), 1);
    const elements = gl.drawCalls
      .slice(before)
      .filter((c: any) => c.kind === 'elements');
    expect(elements).toHaveLength(1);
    expect(elements[0].count).toBe(18);
    // The temporary id-colour buffer is deleted after the pass.
    expect(gl.deleteBuffer).toHaveBeenCalled();
  });

  it('applies the SAME magnitude + time state as the visual pass', () => {
    const gl = makeTextureGl();
    const layer = makeLayer(
      {
        colorRamp: [
          [0, 0, 0, 255],
          [255, 0, 0, 255],
        ],
      },
      gl,
    );
    const tile = makeFlowTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    const frame = normalizeRenderArgs(v5Args('mercator'));
    layer.drawPickTile(gl, tile, tile.layers[0], cache, drawCtx(frame), 1);
    const u = uniformsByName(gl);
    const axis = deriveFlowAxis(tile.layers[0].features)!;
    // The pick pass sampled the matrix at the live playhead, exactly like draw.
    expect(lastScalar(u, 'uFlowBucket')).toBeCloseTo(
      bucketPositionAt(axis, baseOpts.currentTime),
      6,
    );
  });

  it('the id fragment shader discards invisible corridors', () => {
    const id = buildFlowCorridorIdVertexSource(LEGACY_SHADER, cfg());
    // A dead corridor collapses vAlpha, which the id FS discards on — so the
    // gate is shared with the visual pass at the source level.
    expect(id).toContain('if (!(width > 0.0)) vAlpha = 0.0;');
    expect(id).toContain('if (vAlpha <= 0.0) gl_Position = vec4(0.0);');
  });
});

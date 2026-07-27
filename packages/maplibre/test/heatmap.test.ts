/**
 * Behaviour tests for STTHeatmapLayer. The heatmap overrides render() with a
 * two-pass FBO pipeline, so we drive both phases through the mock GL and
 * assert: framebuffer setup happens once, splat points are drawn additively,
 * and a final triangle-strip is drawn against the default framebuffer.
 * The D3 variant suite covers the prelude-injected v5 accumulate shader
 * (string-level source assertions + per-variant program/VAO caching); the M2
 * suites cover the four time-filter modes and the column range filter, both
 * of which gate the ACCUMULATE pass and are selected at compile time.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import {
  DEFAULT_WAKE_TAIL_SCALE,
  wakeAlpha as coreWakeAlpha,
} from '@poopdeck.gl/core/time-filter';
import {
  STTHeatmapLayer,
  buildHeatmapAccumVertexSource,
  type STTHeatmapTimeFilterMode,
} from '../src/layers/heatmap-layer';
import {
  DATA_FILTER_CALL_GLSL,
  dataFilterAlphaJS,
} from '../src/shaders/data-filter.glsl';
import {
  wakeAlphaJS,
  wakeSizeScaleJS,
  cumulativeAlphaJS,
} from '../src/shaders/time-window.glsl';
import { makeMockGl, makeMockMap, publishVisibleTiles } from './mock-gl';
import { makePointTile, makePropertyPointTile } from './fixtures';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

/** Tile-relative playhead for the fixtures (all share one timeOffset). */
const REL_NOW =
  baseOpts.currentTime - makePropertyPointTile().layers[0].features.timeOffset;

/** The shared recorder (which now carries the filter's `uniform2fv`). */
function makeGl(opts: Record<string, boolean> = {}): any {
  return makeMockGl(opts);
}

/** A rendering-ready layer with mock map/tileset state injected. */
function makeRenderableLayer(gl: any, opts: Record<string, unknown> = {}): any {
  const layer = new STTHeatmapLayer({ ...baseOpts, id: 'h', ...opts } as any);
  const l = layer as any;
  l.supports32BitIndices = true;
  l.onContextReady(gl);
  l.gl = gl;
  l.map = makeMockMap();
  l.tileset = {
    update: vi.fn(),
    getVisibleTiles: () => [],
    finalize: vi.fn(),
  };
  publishVisibleTiles(l, makePropertyPointTile());
  return l;
}

/** Accum handles for a (mode, filter) shape under the legacy host variant. */
function accumHandles(layer: any, key = 'heatmap-accum:window::legacy'): any {
  const h = layer.programCache.get(key);
  expect(h, `no program cached under ${key}`).toBeDefined();
  return h;
}

/** All `gl.uniform1f` values pushed to one uniform location. */
const uniform1fValues = (gl: any, loc: unknown): number[] =>
  gl.uniform1f.mock.calls
    .filter((c: unknown[]) => c[0] === loc)
    .map((c: unknown[]) => c[1] as number);

/**
 * All `gl.uniform2fv` payloads pushed to one uniform location, read from the
 * recorder's SNAPSHOT log — the filter payload is one array resolved in place
 * per draw, so `mock.calls` would show every entry holding the latest values.
 */
const uniform2fvValues = (gl: any, loc: unknown): number[][] =>
  gl.vec2Uploads
    .filter((u: { location: unknown }) => u.location === loc)
    .map((u: { value: number[] }) => u.value);

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
    const gl = makeGl();
    const tile = makePropertyPointTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache.weightBuffer).toBeDefined();
    expect(cache.vertexCount).toBe(2);
  });

  it('renders a two-pass pipeline (FBO splat + fullscreen ramp)', () => {
    const gl = makeGl();
    const layer = makeRenderableLayer(gl);

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
    const gl = makeGl();
    const layer = makeRenderableLayer(gl);

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
    const gl = makeGl();
    const tile = makePropertyPointTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache.posScale).toHaveLength(3);
    expect(cache.posOffset).toHaveLength(3);
  });

  it('the accum pass binds the position attribute as UNSIGNED_SHORT/normalized and sets uPosScale/uPosOffset', () => {
    const gl = makeGl();
    const layer = makeRenderableLayer(gl);

    layer.render(gl, new Float32Array(16));

    // Accum handles live in the base per-variant program cache now.
    const h = accumHandles(layer);
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
    const gl = makeGl();
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
    const gl = makeGl();
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
    const gl = makeGl();
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

describe('STTHeatmapLayer time-filter modes (D8)', () => {
  // (kernel call, extra uniforms) each mode must compile in, per
  // shaders/time-window.glsl.ts.
  const MODES: Array<{
    mode: STTHeatmapTimeFilterMode;
    call: string;
    decls: string[];
    absent: string[];
  }> = [
    {
      mode: 'window',
      call: 'sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut)',
      decls: ['uniform float uWindowStart;', 'uniform float uWindowEnd;'],
      absent: ['sttWakeAlpha', 'sttCumulativeAlpha', 'sttTrailAlpha'],
    },
    {
      mode: 'wake',
      call: 'sttWakeAlpha(aTime, uCurrentTime, uWakeLength)',
      decls: ['uniform float uCurrentTime;', 'uniform float uWakeTailScale;'],
      absent: ['sttTimeWindowAlpha', 'sttCumulativeAlpha', 'sttTrailAlpha'],
    },
    {
      mode: 'cumulative',
      call: 'sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn)',
      decls: ['uniform float uCurrentTime;', 'uniform float uFadeIn;'],
      absent: ['sttTimeWindowAlpha', 'sttWakeAlpha', 'sttTrailAlpha'],
    },
    {
      mode: 'trail',
      // One splat per feature ⇒ the per-vertex time is the feature start time.
      call: 'sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail)',
      decls: ['uniform float uTrailLength;', 'uniform float uFadeTrail;'],
      absent: ['sttTimeWindowAlpha', 'sttWakeAlpha', 'sttCumulativeAlpha'],
    },
  ];

  it.each(MODES)(
    'compiles the $mode kernel into BOTH shader variants',
    ({ mode, call, decls, absent }) => {
      const legacy = buildHeatmapAccumVertexSource(
        { prelude: '', define: '' },
        { timeFilterMode: mode },
      );
      const v5 = buildHeatmapAccumVertexSource(
        { prelude: '// host prelude', define: '#define GLOBE' },
        { timeFilterMode: mode },
      );
      for (const src of [legacy, v5]) {
        expect(src).toContain(`float alpha = ${call};`);
        expect(src).toContain('vWeight = aWeight * alpha;');
        for (const d of decls) expect(src).toContain(d);
        // No mode uniform / dispatch: exactly one kernel is compiled in.
        for (const a of absent) expect(src).not.toContain(a);
      }
      // Projection stays variant-owned regardless of the mode.
      expect(legacy).toContain('gl_Position = uMatrix *');
      expect(v5).toContain('gl_Position = projectTile(mercator.xy)');
      expect(v5.startsWith('// host prelude')).toBe(true);
    },
  );

  it('defaults to window mode — an upgrading app sees the historical shader', () => {
    const layer = new STTHeatmapLayer({ ...baseOpts, id: 'h' }) as any;
    expect(layer.heatOpts.timeFilterMode).toBe('window');
    expect(layer.accumKey).toBe('heatmap-accum:window');
    expect(buildHeatmapAccumVertexSource({ prelude: '', define: '' })).toBe(
      buildHeatmapAccumVertexSource(
        { prelude: '', define: '' },
        { timeFilterMode: 'window' },
      ),
    );
  });

  it('shrinks the splat toward wakeTailScale only in wake mode', () => {
    const wake = buildHeatmapAccumVertexSource(
      { prelude: '', define: '' },
      { timeFilterMode: 'wake' },
    );
    expect(wake).toContain(
      'gl_PointSize = uRadius * 2.0 * sttWakeSizeScale(alpha, uWakeTailScale);',
    );
    for (const mode of ['window', 'cumulative', 'trail'] as const) {
      const src = buildHeatmapAccumVertexSource(
        { prelude: '', define: '' },
        { timeFilterMode: mode },
      );
      expect(src).toContain('gl_PointSize = uRadius * 2.0;');
    }
  });

  it('keys the program cache by mode so two modes cannot collide', () => {
    const gl = makeGl();
    const windowed = makeRenderableLayer(gl);
    const waked = makeRenderableLayer(gl, {
      id: 'h-wake',
      timeFilterMode: 'wake',
      wakeLength: 2000,
    });

    windowed.render(gl, new Float32Array(16));
    waked.render(gl, new Float32Array(16));

    expect(windowed.programCache.has('heatmap-accum:window::legacy')).toBe(
      true,
    );
    expect(waked.programCache.has('heatmap-accum:wake::legacy')).toBe(true);
    const wakeSource = gl.shaderSource.mock.calls
      .map((c: unknown[]) => c[1] as string)
      .find((s: string) => s.includes('sttWakeAlpha'));
    expect(wakeSource).toBeDefined();
  });

  it('uploads tile-relative uCurrentTime plus the wake knobs', () => {
    const gl = makeGl();
    const layer = makeRenderableLayer(gl, {
      timeFilterMode: 'wake',
      wakeLength: 2000,
    });

    layer.render(gl, new Float32Array(16));

    const h = accumHandles(layer, 'heatmap-accum:wake::legacy');
    // `uCurrentTime` follows the trips-layer convention: ctx time minus the
    // tile's own offset, never a second time origin.
    expect(uniform1fValues(gl, h.uCurrentTime)).toEqual([REL_NOW]);
    expect(uniform1fValues(gl, h.uWakeLength)).toEqual([2000]);
    // Tail scale is core's single source of truth, not a local literal.
    expect(uniform1fValues(gl, h.uWakeTailScale)).toEqual([
      DEFAULT_WAKE_TAIL_SCALE,
    ]);
  });

  it('defaults trailLength to the layer timeWindow and maps fadeTrail to 0/1', () => {
    const gl = makeGl();
    const layer = makeRenderableLayer(gl, {
      timeFilterMode: 'trail',
      fadeTrail: false,
    });

    layer.render(gl, new Float32Array(16));

    const h = accumHandles(layer, 'heatmap-accum:trail::legacy');
    expect(uniform1fValues(gl, h.uTrailLength)).toEqual([baseOpts.timeWindow]);
    expect(uniform1fValues(gl, h.uFadeTrail)).toEqual([0]);
    expect(uniform1fValues(gl, h.uCurrentTime)).toEqual([REL_NOW]);
  });

  it('cumulative mode reuses uFadeIn as the appear ramp', () => {
    const gl = makeGl();
    const layer = makeRenderableLayer(gl, {
      timeFilterMode: 'cumulative',
      fadeInDuration: 750,
    });

    layer.render(gl, new Float32Array(16));

    const h = accumHandles(layer, 'heatmap-accum:cumulative::legacy');
    expect(uniform1fValues(gl, h.uFadeIn)).toEqual([750]);
    // Reveal is monotone in the tile-relative playhead: a feature at rel-time
    // 0 is 750 ms into its ramp at REL_NOW = 1000.
    expect(cumulativeAlphaJS(0, REL_NOW, 750)).toBe(1);
    expect(cumulativeAlphaJS(REL_NOW + 1, REL_NOW, 750)).toBe(0);
  });

  it('wake gating matches the JS reference (and core) at head and tail', () => {
    const wakeLength = 2000;
    // Head (age 0) splats at full weight and full radius; the tail vanishes
    // and shrinks to wakeTailScale — the semantics the GLSL mirrors.
    const head = wakeAlphaJS(REL_NOW, REL_NOW, wakeLength);
    const tail = wakeAlphaJS(REL_NOW - wakeLength, REL_NOW, wakeLength);
    expect(head).toBe(1);
    expect(tail).toBe(0);
    expect(wakeSizeScaleJS(head, DEFAULT_WAKE_TAIL_SCALE)).toBe(1);
    expect(wakeSizeScaleJS(tail, DEFAULT_WAKE_TAIL_SCALE)).toBe(
      DEFAULT_WAKE_TAIL_SCALE,
    );
    // Same numbers as the renderer-agnostic oracle (argument order differs).
    expect(head).toBe(coreWakeAlpha(REL_NOW, REL_NOW, wakeLength));
    expect(wakeAlphaJS(REL_NOW - 500, REL_NOW, wakeLength)).toBeCloseTo(
      coreWakeAlpha(REL_NOW, REL_NOW - 500, wakeLength),
      12,
    );
  });

  it('setTimeFilterMode relinks under a new key and re-records stale VAOs', () => {
    const gl = makeGl();
    const layer = makeRenderableLayer(gl);
    layer.initVaoSupport(gl);

    layer.render(gl, new Float32Array(16));
    const cache = [...layer.tileGpuCache.values()][0];
    const firstVao = cache.vao;
    expect(cache.vaoProgramKey).toBe('heatmap-accum:window');

    layer.setTimeFilterMode('cumulative');
    expect(layer.map.triggerRepaint).toHaveBeenCalled();
    layer.render(gl, new Float32Array(16));

    expect(layer.programCache.has('heatmap-accum:cumulative::legacy')).toBe(
      true,
    );
    // The VAO recorded the old program's attribute locations.
    expect(gl.deleteVertexArray).toHaveBeenCalledWith(firstVao);
    expect(cache.vaoProgramKey).toBe('heatmap-accum:cumulative');
    expect(cache.vao).not.toBe(firstVao);
  });
});

describe('STTHeatmapLayer DataFilter (column range filter)', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  afterEach(() => warn.mockClear());

  it('compiles no filter branch without a filterProperty (back-compat)', () => {
    const src = buildHeatmapAccumVertexSource({ prelude: '', define: '' });
    expect(src).not.toContain('aFilterValue');
    expect(src).not.toContain('uFilterRange');
    expect(src).not.toContain('sttDataFilterAlpha');

    const gl = makeGl();
    const layer = makeRenderableLayer(gl);
    layer.render(gl, new Float32Array(16));
    expect(layer.filterCompiled).toBe(false);
    expect(layer.accumKey).toBe('heatmap-accum:window');
    expect(gl.uniform2fv).not.toHaveBeenCalled();
  });

  it('compiles the canonical kernel call + deck collapse into both variants', () => {
    for (const shader of [
      { prelude: '', define: '' },
      { prelude: '// host prelude', define: '#define GLOBE' },
    ]) {
      const src = buildHeatmapAccumVertexSource(shader, { dataFilter: true });
      expect(src).toContain('attribute float aFilterValue;');
      expect(src).toContain('uniform vec2 uFilterRange;');
      expect(src).toContain('uniform vec2 uFilterSoftRange;');
      // Verbatim canonical call — five layers must not drift on the argument
      // order or the `> 0.5` bool convention.
      expect(src).toContain(`float filterAlpha = ${DATA_FILTER_CALL_GLSL};`);
      // Upstream's vs:#main-end collapse + fs discard (hidden regardless of
      // the transform flags), then the size / colour transforms.
      expect(src).toContain('if (filterAlpha <= 0.0) {');
      expect(src).toContain('gl_Position = vec4(0.0);');
      expect(src).toContain('filterColor = 0.0;');
      expect(src).toContain(
        'float filterSize = mix(1.0, filterAlpha, step(0.5, uFilterTransformSize));',
      );
      expect(src).toContain('gl_PointSize = uRadius * 2.0 * filterSize;');
      expect(src).toContain('vWeight = aWeight * alpha * filterColor;');
    }
  });

  it('composes with a time mode: both factors multiply into the splat weight', () => {
    const src = buildHeatmapAccumVertexSource(
      { prelude: '', define: '' },
      { timeFilterMode: 'wake', dataFilter: true },
    );
    expect(src).toContain('float alpha = sttWakeAlpha(');
    expect(src).toContain(
      'gl_PointSize = uRadius * 2.0 * sttWakeSizeScale(alpha, uWakeTailScale) * filterSize;',
    );
    expect(src).toContain('vWeight = aWeight * alpha * filterColor;');
  });

  it('uploads the column, binds the attribute and enables the filter', () => {
    const gl = makeGl();
    const layer = makeRenderableLayer(gl, {
      filterProperty: 'magnitude',
      filterRange: [3, 9],
    });

    layer.render(gl, new Float32Array(16));

    const cache = [...layer.tileGpuCache.values()][0];
    expect(cache.hasFilterColumn).toBe(true);
    expect(cache.filterBuffer).toBeDefined();
    // Deleted with the tile: the base sweeps extraBuffers.
    expect(cache.extraBuffers).toContain(cache.filterBuffer);

    const h = accumHandles(layer, 'heatmap-accum:window:filter::legacy');
    expect(gl.vertexAttribPointer).toHaveBeenCalledWith(
      h.aFilterValue,
      1,
      gl.FLOAT,
      false,
      0,
      0,
    );
    expect(uniform2fvValues(gl, h.uFilterRange)).toEqual([[3, 9]]);
    // No soft range ⇒ the soft edges collapse onto the hard ones (hard step).
    expect(uniform2fvValues(gl, h.uFilterSoftRange)).toEqual([[3, 9]]);
    expect(uniform1fValues(gl, h.uFilterEnabled)).toEqual([1]);
    // deck defaults: both transforms on unless explicitly false.
    expect(uniform1fValues(gl, h.uFilterTransformSize)).toEqual([1]);
    expect(uniform1fValues(gl, h.uFilterTransformColor)).toEqual([1]);
    // The fixture's `magnitude` column decides which splats survive.
    expect(dataFilterAlphaJS(2, [3, 9], [3, 9], true)).toBe(0);
    expect(dataFilterAlphaJS(8, [3, 9], [3, 9], true)).toBe(1);
  });

  it('renders a tile that lacks the column UNFILTERED, never blank', () => {
    const gl = makeGl();
    const layer = makeRenderableLayer(gl, {
      filterProperty: 'magnitude',
      filterRange: [3, 9],
    });
    // makePointTile has no numericProps at all. Distinctly addressed so it is
    // a second entry in the (tile-id-keyed) GPU cache rather than an alias.
    const noCol = makePointTile();
    noCol.id = { ...noCol.id, x: noCol.id.x + 1 };
    publishVisibleTiles(layer, makePropertyPointTile(), noCol);

    layer.render(gl, new Float32Array(16));

    const caches = [...layer.tileGpuCache.values()];
    expect(caches.some((c: any) => c.hasFilterColumn === false)).toBe(true);
    const h = accumHandles(layer, 'heatmap-accum:window:filter::legacy');
    // One tile filtered (1), one idle (0) — an absent column never hides.
    expect(uniform1fValues(gl, h.uFilterEnabled).sort()).toEqual([0, 1]);
  });

  it('idles (enabled 0) until a finite filterRange arrives, then follows the slider', () => {
    const gl = makeGl();
    const layer = makeRenderableLayer(gl, { filterProperty: 'magnitude' });

    layer.render(gl, new Float32Array(16));
    const h = accumHandles(layer, 'heatmap-accum:window:filter::legacy');
    expect(uniform1fValues(gl, h.uFilterEnabled)).toEqual([0]);

    layer.setFilterRange([1, 4]);
    expect(layer.map.triggerRepaint).toHaveBeenCalled();
    layer.render(gl, new Float32Array(16));
    expect(uniform1fValues(gl, h.uFilterEnabled)).toEqual([0, 1]);
    expect(uniform2fvValues(gl, h.uFilterRange).at(-1)).toEqual([1, 4]);

    layer.setFilterRange(null);
    layer.render(gl, new Float32Array(16));
    expect(uniform1fValues(gl, h.uFilterEnabled)).toEqual([0, 1, 0]);
  });

  it('honours filterEnabled:false and the transform opt-outs', () => {
    const gl = makeGl();
    const layer = makeRenderableLayer(gl, {
      filterProperty: 'magnitude',
      filterRange: [3, 9],
      filterEnabled: false,
      filterTransformSize: false,
      filterTransformColor: false,
    });

    layer.render(gl, new Float32Array(16));

    const h = accumHandles(layer, 'heatmap-accum:window:filter::legacy');
    expect(uniform1fValues(gl, h.uFilterEnabled)).toEqual([0]);
    expect(uniform1fValues(gl, h.uFilterTransformSize)).toEqual([0]);
    expect(uniform1fValues(gl, h.uFilterTransformColor)).toEqual([0]);
  });

  it('warns once for a categorical filterProperty and renders unfiltered', () => {
    const gl = makeGl();
    const layer = makeRenderableLayer(gl, {
      filterProperty: 'species', // categorical in the fixture
      filterRange: [0, 1],
    });
    // A second, distinctly-addressed tile: the GPU cache is keyed by tile id,
    // so this really does run the column extraction twice.
    const second = makePropertyPointTile();
    second.id = { ...second.id, x: second.id.x + 1 };
    publishVisibleTiles(layer, makePropertyPointTile(), second);

    layer.render(gl, new Float32Array(16));

    const caches = [...layer.tileGpuCache.values()];
    expect(caches.length).toBe(2);
    expect(caches.every((c: any) => c.hasFilterColumn === false)).toBe(true);
    expect(caches.every((c: any) => c.filterBuffer === undefined)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('categorical');
    const h = accumHandles(layer, 'heatmap-accum:window:filter::legacy');
    expect(uniform1fValues(gl, h.uFilterEnabled)).toEqual([0, 0]);
  });
});

describe('STTHeatmapLayer picking', () => {
  it('is deliberately not pickable — a density pixel has no feature identity', () => {
    const gl = makeGl();
    const layer = makeRenderableLayer(gl);
    layer.render(gl, new Float32Array(16));

    expect(layer.drawPickTile).toBeUndefined();
    expect(layer.supportsPicking()).toBe(false);
    expect(layer.pick(10, 10)).toBeNull();
    // No id-FBO was ever allocated for this layer.
    expect(gl.readPixels).not.toHaveBeenCalled();
  });
});

describe('STTHeatmapLayer prop defaults (back-compat)', () => {
  it('keeps every pre-M2 default and adds the new knobs OFF-shaped', () => {
    const layer = new STTHeatmapLayer({ ...baseOpts, id: 'h' }) as any;
    expect(layer.heatOpts).toMatchObject({
      radiusPixels: 30,
      intensity: 1,
      threshold: 0.05,
      timeFilterMode: 'window',
      wakeLength: 0,
      wakeTailScale: DEFAULT_WAKE_TAIL_SCALE,
      trailLength: baseOpts.timeWindow,
      // Resolved through the package-wide `resolveTrailFade` (boolean in,
      // continuous 0..1 weight out).
      fadeTrail: 1,
    });
    expect(layer.heatOpts.weightProperty).toBeUndefined();
    expect(layer.heatOpts.colorDomain).toBeUndefined();
    expect(layer.heatOpts.filterProperty).toBeUndefined();
    expect(layer.heatOpts.filterRange).toBeUndefined();
    expect(layer.filterCompiled).toBe(false);
  });
});

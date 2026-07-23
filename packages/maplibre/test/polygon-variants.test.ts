/**
 * Polygon-layer projection variants + Wave M2 feature parity (D3/D4/D8/D10/D11).
 *
 * String-level: the fill/stroke vertex-source builders emit the legacy
 * `uMatrix` shaders BYTE-IDENTICALLY for the default configuration (frozen
 * fixtures below), prelude-injected sources for v5+ hosts — flat fills through
 * `projectTile` (2d, the host owns z), extruded prisms through
 * `projectTileFor3D` (elevation in metres) — and one time-filter kernel /
 * optional DataFilter branch per compile-time configuration.
 *
 * Behaviour-level (mock-gl): drawTile links one program per (pass, mode,
 * filter, host variant), sets the prelude projection uniforms on v5 frames
 * (and uMatrix only on legacy ones), re-records both fill and stroke VAOs on a
 * variant flip, converts `altitudeScale` metres → mercator-z at the tile's own
 * latitude on the legacy path, and prelude hosts bake globe subdivision into
 * the tile caches at build time. `drawPickTile` reproduces both passes under
 * the same gates with per-feature id colours. Real prelude compilation and the
 * pick FBO round-trip are browser-verified.
 */

import { describe, it, expect, vi } from 'vitest';
import { GeometryType, type Layer, type Tile } from '@poopdeck.gl/core';
import { decodePickId } from '@poopdeck.gl/core/picking';
import {
  STTPolygonLayer,
  buildFillVertexSource,
  buildStrokeVertexSource,
  expandPickIdColors,
} from '../src/layers/polygon-layer';
import { normalizeRenderArgs } from '../src/lib/host-adapter';
import {
  lngLatToMercator,
  mercatorZFromAltitude,
  tileCenterLatitude,
  DEPRECATED_ALTITUDE_SCALE,
} from '../src/lib/projection';
import { TIME_WINDOW_GLSL } from '../src/shaders/time-window.glsl';
import { expandFilterValues } from '../src/shaders/data-filter.glsl';
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

/** Scalar values passed to `gl.uniform1f`, in call order. */
const uniform1fValues = (gl: any): number[] =>
  gl.uniform1f.mock.calls.map((c: unknown[]) => c[1] as number);

/**
 * Every vec2 payload uploaded, in call order, from the recorder's SNAPSHOT log.
 * The DataFilter payload is one array resolved in place per draw, so the raw
 * call log would show each entry holding the latest values.
 */
const vec2Uploads = (gl: any): number[][] =>
  gl.vec2Uploads.map((u: { value: number[] }) => u.value);

/** The shared recorder (which now carries the filter's `uniform2fv`). */
function makeGl(): any {
  return makeMockGl();
}

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

function makeLayerWithCache(
  opts: Record<string, unknown> = {},
  tile: Tile = makePolygonTile(),
) {
  const layer = makeLayer(opts);
  const gl = makeGl();
  // The real `initVaoSupport` runs in onAdd, which these direct-hook tests
  // bypass — wire the mock's VAO entry points so VAO reuse/rebuild is real.
  layer.vaoSupport = {
    enabled: true,
    create: () => gl.createVertexArray(),
    bind: (vao: unknown) => gl.bindVertexArray(vao),
    delete: (vao: unknown) => gl.deleteVertexArray(vao),
  };
  const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
  return { layer, gl, tile, cache };
}

/**
 * Two disjoint squares carrying a numeric `mag` column and a categorical
 * `kind` one. Two features are the minimum that can catch a per-feature →
 * per-vertex expansion bug (filter values, pick ids).
 */
function makeTwoPolygonTile(): Tile {
  const positions = new Float64Array([
    -10, -10, 10, -10, 10, 10, -10, 10, 20, 20, 30, 20, 30, 30, 20, 30,
  ]);
  const features = {
    featureCount: 2,
    geometryType: GeometryType.Polygon,
    positionDimensions: 2 as const,
    positions,
    startIndices: new Uint32Array([0, 4, 8]),
    featureIds: new Uint32Array([0, 1]),
    startTimes: new Float32Array([0, 500]),
    endTimes: new Float32Array([1000, 1500]),
    timeOffset: 1_700_000_000_000,
    numericProps: { mag: new Float32Array([2, 8]) },
    categoricalProps: {
      kind: { indices: new Uint16Array([0, 1]), categories: ['a', 'b'] },
    },
  };
  const layer: Layer = {
    name: 'polys',
    extent: 4096,
    features,
    geometryExtensionName: 'geoarrow.polygon',
  };
  return {
    id: { z: 2, x: 1, y: 1, t: 1_700_000_000_000 },
    timeRange: { start: 1_700_000_000_000, end: 1_700_000_001_500 },
    layers: [layer],
  };
}

// ── frozen historical sources (byte-identity guard) ─────────────────────────
// Verbatim copies of the pre-Wave-M2 shaders. The default configuration
// (window mode, no DataFilter, visual pass) MUST still emit these character
// for character — that is the "legacy hosts see no change" contract, and the
// generator is what could silently break it.

const HISTORICAL_FILL_VS = `
  precision highp float;
  attribute vec3 aMercator;
  attribute vec2 aTime;
  attribute vec4 aColor;
  uniform mat4 uMatrix;
  uniform float uAltitudeScale;
  uniform float uUseFeatureColor;
  uniform vec4 uColor;
  uniform float uWindowStart;
  uniform float uWindowEnd;
  uniform float uFadeIn;
  uniform float uFadeOut;
  varying float vAlpha;
  varying vec4 vColor;
${TIME_WINDOW_GLSL}
  void main() {
    gl_Position = uMatrix * vec4(aMercator.x, aMercator.y, aMercator.z * uAltitudeScale, 1.0);
    vAlpha = sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut);
    vColor = (uUseFeatureColor > 0.5) ? aColor : uColor;
  }
`;

const HISTORICAL_STROKE_VS = `
  precision highp float;
  attribute vec2 aCorner;       // (side, along) per-vertex
  attribute vec2 aPosA;         // edge start, per-instance
  attribute vec2 aPosB;         // edge end, per-instance
  attribute vec2 aTime;         // [startTime, endTime], per-instance
  uniform mat4 uMatrix;
  uniform vec2 uViewport;
  uniform float uWidth;
  uniform float uWindowStart;
  uniform float uWindowEnd;
  uniform float uFadeIn;
  uniform float uFadeOut;
  varying float vAlpha;
${TIME_WINDOW_GLSL}
  void main() {
    vec2 posM = mix(aPosA, aPosB, aCorner.y);
    vec2 neighborM = mix(aPosB, aPosA, aCorner.y);
    vec4 here = uMatrix * vec4(posM, 0.0, 1.0);
    vec4 there = uMatrix * vec4(neighborM, 0.0, 1.0);
    vec2 hereNdc = here.xy / here.w;
    vec2 thereNdc = there.xy / there.w;
    vec2 dirPx = (thereNdc - hereNdc) * 0.5 * uViewport;
    float lenPx = max(length(dirPx), 1e-4);
    vec2 dirN = dirPx / lenPx;
    float sideSign = (aCorner.y > 0.5) ? -1.0 : 1.0;
    vec2 perp = vec2(-dirN.y, dirN.x) * sideSign;
    vec2 offsetPx = perp * aCorner.x * uWidth * 0.5;
    vec2 offsetNdc = offsetPx / (0.5 * uViewport);
    vec4 outClip = here;
    outClip.xy += offsetNdc * here.w;
    gl_Position = outClip;
    vAlpha = sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut);
  }
`;

describe('polygon fill vertex-source builder', () => {
  it('legacy default is the historical uMatrix shader, byte for byte', () => {
    expect(buildFillVertexSource({ prelude: '', define: '' })).toBe(
      HISTORICAL_FILL_VS,
    );
  });

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
    // Flat fills are 2d (prelude owns z for horizon clipping); extruded prisms
    // take the 3D branch, whose elevation UNIT is variant-dependent — hence the
    // `#ifdef GLOBE` split and the second uniform.
    expect(src).toContain('float elev = aMercator.z * uAltitudeScale;');
    expect(src).toContain('projectTileFor3D(aMercator.xy, elev)');
    expect(src).toContain('projectTile(aMercator.xy)');
    expect(src).toContain('uniform float uExtruded;');
    expect(src).toContain('uniform float uMercatorZPerMeter;');
    // GLOBE re-derives the horizon-clip z projectTileFor3D drops, and feeds
    // the transition's fallback term mercator-z instead of metres.
    expect(src).toContain('#ifdef GLOBE');
    expect(src).toContain('globeComputeClippingZ(elevated)');
    expect(src).toContain('u_projection_fallback_matrix *');
    expect(src).toContain('elev * uMercatorZPerMeter');
    // The prelude owns projection — no legacy matrix path left in the source.
    expect(src).not.toContain('uniform mat4 uMatrix;');
    // Time-window math unchanged from legacy.
    expect(src).toContain('sttTimeWindowAlpha(aTime,');
  });
});

describe('polygon stroke vertex-source builder', () => {
  it('legacy default is the historical uMatrix shader, byte for byte', () => {
    expect(buildStrokeVertexSource({ prelude: '', define: '' })).toBe(
      HISTORICAL_STROKE_VS,
    );
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

describe('polygon time-filter modes (D8)', () => {
  const MODE_EXPECTATIONS = [
    {
      mode: 'window' as const,
      kernel: 'float sttTimeWindowAlpha(',
      call: 'sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut)',
      uniforms: ['uniform float uWindowStart;', 'uniform float uWindowEnd;'],
      absent: ['uCurrentTime'],
    },
    {
      mode: 'wake' as const,
      kernel: 'float sttWakeAlpha(',
      call: 'sttWakeAlpha(aTime, uCurrentTime, uWakeLength)',
      uniforms: ['uniform float uCurrentTime;', 'uniform float uWakeLength;'],
      absent: ['uWindowStart', 'sttTimeWindowAlpha'],
    },
    {
      mode: 'cumulative' as const,
      kernel: 'float sttCumulativeAlpha(',
      call: 'sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn)',
      uniforms: ['uniform float uCurrentTime;', 'uniform float uFadeIn;'],
      absent: ['uWindowStart', 'uFadeOut'],
    },
    {
      mode: 'trail' as const,
      kernel: 'float sttTrailAlpha(',
      call: 'sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail)',
      uniforms: ['uniform float uTrailLength;', 'uniform float uFadeTrail;'],
      absent: ['uWindowStart', 'uWakeLength'],
    },
  ];

  for (const spec of MODE_EXPECTATIONS) {
    it(`${spec.mode}: compiles exactly one kernel, identically on both host variants`, () => {
      for (const shader of [
        { prelude: '', define: '' },
        { prelude: PRELUDE, define: '#define GLOBE' },
      ]) {
        for (const build of [buildFillVertexSource, buildStrokeVertexSource]) {
          const src = build({ ...shader, mode: spec.mode });
          expect(src).toContain(spec.kernel);
          expect(src).toContain(spec.call);
          for (const u of spec.uniforms) expect(src).toContain(u);
          for (const gone of spec.absent) expect(src).not.toContain(gone);
        }
      }
    });
  }

  it('the program-cache key carries the mode and the filter branch', () => {
    // getOrCreateProgram only appends the HOST variant, so two modes sharing a
    // base key would silently reuse each other's program.
    expect(makeLayer().programKeys.fill).toBe('fill:window');
    expect(makeLayer({ timeFilterMode: 'cumulative' }).programKeys.fill).toBe(
      'fill:cumulative',
    );
    expect(
      makeLayer({
        timeFilterMode: 'trail',
        trailLength: 1000,
        filterProperty: 'mag',
      }).programKeys['pick-stroke'],
    ).toBe('pick-stroke:trail:filter');
  });

  it('wake with a non-positive wakeLength degrades to the window kernel', () => {
    // deck selects wake only when wakeLength > 0; a degenerate wake would
    // light nothing at all.
    expect(makeLayer({ timeFilterMode: 'wake' }).timeMode).toBe('window');
    expect(
      makeLayer({ timeFilterMode: 'wake', wakeLength: 5000 }).timeMode,
    ).toBe('wake');
  });

  it('wake mode uploads tile-relative uCurrentTime + uWakeLength', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      timeFilterMode: 'wake',
      wakeLength: 4000,
    });
    const ctx = drawCtx(normalizeRenderArgs(new Float32Array(16)));
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    const values = uniform1fValues(gl);
    expect(values).toContain(ctx.currentTime - cache.timeOffset);
    expect(values).toContain(4000);
    // Window uniforms are not part of this program at all.
    expect(values).not.toContain(ctx.windowEnd);
  });

  it('cumulative mode reuses uFadeIn as the reveal ramp', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      timeFilterMode: 'cumulative',
      fadeInDuration: 250,
    });
    const ctx = drawCtx(normalizeRenderArgs(new Float32Array(16)));
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    const values = uniform1fValues(gl);
    expect(values).toContain(ctx.currentTime - cache.timeOffset);
    expect(values).toContain(250);
  });

  it('trail mode uploads trailLength + the fadeTrail flag', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      timeFilterMode: 'trail',
      trailLength: 3000,
      fadeTrail: false,
    });
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))),
    );
    const values = uniform1fValues(gl);
    expect(values).toContain(3000);
    expect(values).toContain(0); // snake mode
  });
});

describe('polygon DataFilter', () => {
  it('no filterProperty ⇒ no filter branch, no attribute, no uniforms (default back-compat)', () => {
    for (const shader of [
      { prelude: '', define: '' },
      { prelude: PRELUDE, define: '#define GLOBE' },
    ]) {
      for (const build of [buildFillVertexSource, buildStrokeVertexSource]) {
        const src = build(shader);
        expect(src).not.toContain('aFilterValue');
        expect(src).not.toContain('uFilterRange');
        expect(src).not.toContain('sttDataFilterAlpha');
      }
    }
    const { layer, gl, tile, cache } = makeLayerWithCache();
    expect(cache.filterBuffer).toBeUndefined();
    expect(cache.hasFilterColumn).toBe(false);
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))),
    );
    expect(gl.uniform2fv).not.toHaveBeenCalled();
  });

  it('filterProperty splices the kernel, the call and the vertex collapse into both variants', () => {
    for (const shader of [
      { prelude: '', define: '' },
      { prelude: PRELUDE, define: '#define GLOBE' },
    ]) {
      for (const build of [buildFillVertexSource, buildStrokeVertexSource]) {
        const src = build({ ...shader, filter: true });
        expect(src).toContain('attribute float aFilterValue;');
        expect(src).toContain('uniform vec2 uFilterRange;');
        expect(src).toContain('uniform vec2 uFilterSoftRange;');
        expect(src).toContain('float sttDataFilterAlpha(');
        expect(src).toContain(
          'sttDataFilterAlpha(aFilterValue, uFilterRange, uFilterSoftRange, uFilterEnabled > 0.5)',
        );
        // deck parity: opt-out fade, always-on cull, vertex collapse.
        expect(src).toContain(
          'vAlpha *= (uFilterTransformColor > 0.5) ? filterAlpha : (filterAlpha > 0.0 ? 1.0 : 0.0);',
        );
        expect(src).toContain('if (vAlpha <= 0.0) gl_Position = vec4(0.0);');
      }
    }
  });

  it('expands the per-feature column across fill vertices and stroke edges', () => {
    const tile = makeTwoPolygonTile();
    const { gl, cache } = makeLayerWithCache(
      { filterProperty: 'mag', stroked: true },
      tile,
    );
    expect(cache.hasFilterColumn).toBe(true);
    expect([...cache.fillVertexCounts]).toEqual([4, 4]);
    expect([...cache.stroke.instanceCounts]).toEqual([4, 4]);

    const uploads = gl.bufferData.mock.calls.map((c: unknown[]) => c[1]);
    const column = tile.layers[0].features.numericProps.mag;
    const expectedFill = expandFilterValues(
      column,
      cache.fillVertexCounts,
      cache.vertexCount,
    );
    const expectedStroke = expandFilterValues(
      column,
      cache.stroke.instanceCounts,
      cache.stroke.instanceCount,
    );
    expect(expectedFill).toEqual(new Float32Array([2, 2, 2, 2, 8, 8, 8, 8]));
    const matches = (want: Float32Array) =>
      uploads.some(
        (u: unknown) =>
          u instanceof Float32Array &&
          u.length === want.length &&
          want.every((v, i) => u[i] === v),
      );
    expect(matches(expectedFill)).toBe(true);
    expect(matches(expectedStroke)).toBe(true);
  });

  it('uploads the resolved range/softRange/enabled uniforms per draw', () => {
    const tile = makeTwoPolygonTile();
    const { layer, gl, cache } = makeLayerWithCache(
      { filterProperty: 'mag', filterRange: [3, 9], filterSoftRange: [4, 8] },
      tile,
    );
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))),
    );
    const vec2s = vec2Uploads(gl);
    expect(vec2s).toContainEqual([3, 9]);
    expect(vec2s).toContainEqual([4, 8]);
    expect(uniform1fValues(gl)).toContain(1); // uFilterEnabled

    // setFilterRange is uniform-only: no relink, no cache rebuild.
    const programs = gl.createProgram.mock.calls.length;
    gl.vec2Uploads.length = 0;
    layer.setFilterRange([5, 6], null);
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))),
    );
    expect(gl.createProgram.mock.calls.length).toBe(programs);
    const after = vec2Uploads(gl);
    // No soft range ⇒ the soft edges collapse onto the hard ones (hard step).
    expect(after).toEqual([
      [5, 6],
      [5, 6],
    ]);
  });

  it('a tile missing the column renders UNFILTERED, never blank', () => {
    // Same layer config, a tile with no `mag` column: enabled resolves to 0
    // even though a range is set, so every feature still renders.
    const { layer, gl, tile, cache } = makeLayerWithCache({
      filterProperty: 'mag',
      filterRange: [3, 9],
    });
    expect(cache.hasFilterColumn).toBe(false);
    expect(cache.filterBuffer).toBeUndefined();
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))),
    );
    expect(vec2Uploads(gl)).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(uniform1fValues(gl)).toContain(0); // uFilterEnabled = 0 ⇒ alpha 1
    expect(gl.drawElements).toHaveBeenCalled();
  });

  it('a categorical filter column warns once and renders unfiltered', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tile = makeTwoPolygonTile();
    const { layer, gl, cache } = makeLayerWithCache(
      { filterProperty: 'kind' },
      tile,
    );
    expect(cache.hasFilterColumn).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
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

describe('polygon elevation reconciliation (D10)', () => {
  it('altitudeScale now defaults to 1 — a dimensionless exaggeration', () => {
    expect(makeLayer().polyOpts.altitudeScale).toBe(1);
    expect(makeLayer({ altitudeScale: 3 }).polyOpts.altitudeScale).toBe(3);
  });

  it('bakes metres → mercator-z at the TILE centre latitude', () => {
    const { cache, tile } = makeLayerWithCache({
      extruded: true,
      elevation: 1000,
    });
    expect(cache.mercatorZScale).toBe(
      mercatorZFromAltitude(1, tileCenterLatitude(tile.id.z, tile.id.y)),
    );
  });

  it('v5 MERCATOR takes mercator-z, exactly like legacy — NOT metres', () => {
    // maplibre's getProjectionDataForCustomLayer scales custom-layer z by
    // `worldSize / pixelsPerMeter` on top of a view-projection whose z is
    // already `pixelsPerMeter`, i.e. net `worldSize` — the same units v4's
    // customLayerMatrix uses. Only the GLOBE prelude's projectTileFor3D wants
    // metres. Feeding metres here over-scales by metersPerMercatorUnit(lat)
    // (~4e7), which frustum-clips every prism.
    const { layer, gl, tile, cache } = makeLayerWithCache({
      extruded: true,
      elevation: 1000,
      altitudeScale: 2,
    });
    const mercatorZ =
      2 * mercatorZFromAltitude(1, tileCenterLatitude(tile.id.z, tile.id.y));

    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(v5Args('mercator', 0))),
    );
    const values = uniform1fValues(gl);
    expect(values).toContain(mercatorZ);
    expect(values).not.toContain(2);
  });

  it('uAltitudeScale is latitude-correct mercator-z on legacy, metres on the GLOBE path', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      extruded: true,
      elevation: 1000,
      altitudeScale: 2,
    });
    const legacyExpected =
      2 * mercatorZFromAltitude(1, tileCenterLatitude(tile.id.z, tile.id.y));

    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))),
    );
    expect(uniform1fValues(gl)).toContain(legacyExpected);

    gl.uniform1f.mockClear();
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(v5Args('globe', 1))),
    );
    // The globe prelude's projectTileFor3D wants METRES above the sphere —
    // exaggeration only; the mercator-z factor rides uMercatorZPerMeter for
    // the transition's fallback term instead.
    const values = uniform1fValues(gl);
    expect(values).toContain(2);
    expect(values).not.toContain(legacyExpected);
  });

  it('the correction shrinks the historical 1e-7 extrusion ~4× (intended, not a regression)', () => {
    const { cache, tile } = makeLayerWithCache({
      extruded: true,
      elevation: 1000,
    });
    const equatorial = DEPRECATED_ALTITUDE_SCALE / mercatorZFromAltitude(1, 0);
    expect(equatorial).toBeCloseTo(4.003, 3);
    // Away from the equator the mercator stretch scales the correction by
    // cos(lat) — this fixture tile (z2/y1) is centred near 41°N.
    const lat = tileCenterLatitude(tile.id.z, tile.id.y);
    expect(DEPRECATED_ALTITUDE_SCALE / cache.mercatorZScale).toBeCloseTo(
      equatorial * Math.cos((lat * Math.PI) / 180),
      6,
    );
  });
});

describe('polygon picking (D11)', () => {
  it('declares itself pickable', () => {
    expect(makeLayer().supportsPicking()).toBe(true);
  });

  it('expandPickIdColors repeats each feature id across its draw units', () => {
    const layer = makeLayer();
    // idBase 1 ⇒ features get global ids 1, 2, 3.
    const perFeature = layer.buildPickIdColors(3, 1);
    const counts = new Uint32Array([2, 0, 3]);
    const out = expandPickIdColors(perFeature, counts, 5);
    expect(out).toHaveLength(15);
    const idAt = (i: number) =>
      decodePickId([out[i * 3], out[i * 3 + 1], out[i * 3 + 2]]);
    // Feature 1 contributed nothing, so its id never appears.
    expect([0, 1, 2, 3, 4].map(idAt)).toEqual([1, 1, 3, 3, 3]);
  });

  it('never writes past `total` when the counts overshoot', () => {
    const layer = makeLayer();
    const out = expandPickIdColors(
      layer.buildPickIdColors(2, 1),
      new Uint32Array([10, 10]),
      3,
    );
    expect(out).toHaveLength(9);
    expect(decodePickId([out[6], out[7], out[8]])).toBe(1);
  });

  it('paints fill triangles with per-feature ids under the visual gates', () => {
    const tile = makeTwoPolygonTile();
    const { layer, gl, cache } = makeLayerWithCache({}, tile);
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))),
      1,
    );
    // The id program, not the visual one.
    expect(
      vertexSources(gl).some(
        (s) => s.includes('attribute vec3 aIdColor;') && s.includes('vIdColor'),
      ),
    ).toBe(true);
    expect(gl.drawElements).toHaveBeenCalledWith(
      gl.TRIANGLES,
      cache.indexCount,
      gl.UNSIGNED_SHORT,
      0,
    );
    // Per-VERTEX id colours: 8 vertices, first square = id 1, second = id 2.
    const ids = gl.bufferData.mock.calls
      .map((c: unknown[]) => c[1])
      .find(
        (b: unknown): b is Uint8Array =>
          b instanceof Uint8Array && b.length === cache.vertexCount * 3,
      )!;
    expect(decodePickId([ids[0], ids[1], ids[2]])).toBe(1);
    expect(decodePickId([ids[12], ids[13], ids[14]])).toBe(2);
    // One-shot buffer, freed with the pass.
    expect(gl.deleteBuffer).toHaveBeenCalled();
  });

  it('applies the same time + filter gates in the pick program', () => {
    const tile = makeTwoPolygonTile();
    const { layer, gl, cache } = makeLayerWithCache(
      {
        timeFilterMode: 'cumulative',
        fadeInDuration: 400,
        filterProperty: 'mag',
        filterRange: [3, 9],
      },
      tile,
    );
    const ctx = drawCtx(normalizeRenderArgs(new Float32Array(16)));
    layer.drawPickTile(gl, tile, tile.layers[0], cache, ctx, 1);

    const pickSource = vertexSources(gl).find((s) =>
      s.includes('attribute vec3 aIdColor;'),
    )!;
    expect(pickSource).toContain('sttCumulativeAlpha(aTime, uCurrentTime,');
    expect(pickSource).toContain('sttDataFilterAlpha(aFilterValue,');
    const values = uniform1fValues(gl);
    expect(values).toContain(ctx.currentTime - cache.timeOffset);
    expect(values).toContain(400);
    expect(vec2Uploads(gl)).toContainEqual([3, 9]);
  });

  it('honours filled / stroked exactly like the visual pass', () => {
    const tile = makeTwoPolygonTile();
    const { layer, gl, cache } = makeLayerWithCache(
      { filled: false, stroked: true },
      tile,
    );
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))),
      1,
    );
    // No fill pass at all…
    expect(gl.drawElements).not.toHaveBeenCalled();
    // …and the outline is picked as instanced quads, one per ring edge.
    expect(layer.instSupport.drawArraysInstanced).toHaveBeenCalledWith(
      0x0005,
      0,
      4,
      cache.stroke.instanceCount,
    );
    const strokeIds = gl.bufferData.mock.calls
      .map((c: unknown[]) => c[1])
      .find(
        (b: unknown): b is Uint8Array =>
          b instanceof Uint8Array &&
          b.length === cache.stroke.instanceCount * 3,
      )!;
    expect(decodePickId([strokeIds[0], strokeIds[1], strokeIds[2]])).toBe(1);
    expect(decodePickId([strokeIds[12], strokeIds[13], strokeIds[14]])).toBe(2);
  });

  it('pick programs are cached separately from the visual ones', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const ctx = drawCtx(normalizeRenderArgs(new Float32Array(16)));
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    expect(gl.createProgram.mock.calls.length).toBe(1);
    layer.drawPickTile(gl, tile, tile.layers[0], cache, ctx, 1);
    expect(gl.createProgram.mock.calls.length).toBe(2);
    layer.drawPickTile(gl, tile, tile.layers[0], cache, ctx, 1);
    expect(gl.createProgram.mock.calls.length).toBe(2);
  });
});

describe('polygon globe subdivision (D4)', () => {
  it('mercator hosts bake no subdivision — legacy AND v5-mercator keep the historical geometry', () => {
    // `projectTile` is affine in mercator exactly like `uMatrix`, so chords are
    // already exact off-globe; subdividing there would inflate every per-vertex
    // buffer (filter values, pick ids) for nothing. The line/trips layers gate
    // on globe-ness the same way.
    const { cache } = makeLayerWithCache();
    expect(cache.subdivisionGranularity).toBe(0);
    expect(cache.vertexCount).toBe(4);
    expect(cache.indexCount).toBe(6);

    const v5Mercator = makeLayer();
    v5Mercator.frameIsGlobe = false;
    const mercCache = v5Mercator.buildTileGpuCache(
      makeGl(),
      makePolygonTile(),
      makePolygonTile().layers[0],
    );
    expect(mercCache.subdivisionGranularity).toBe(0);
    expect(mercCache.vertexCount).toBe(4);
  });

  it('globe frames refine fill triangles to the host granularity, keeping original verts', () => {
    const layer = makeLayer();
    layer.frameIsGlobe = true;
    const gl = makeGl();
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

  it('globe frames refine stroke edges — a 4-edge square becomes 32 instances at granularity 128', () => {
    const layer = makeLayer({ stroked: true });
    layer.frameIsGlobe = true;
    const gl = makeGl();
    const tile = makePolygonTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    // Each ~0.056-mercator edge splits into ceil(0.056 × 128) = 8 pieces.
    expect(cache.stroke.instanceCount).toBe(32);
  });

  it('extruded globe walls band over the refined ring outline', () => {
    const layer = makeLayer({ extruded: true, elevation: 1000 });
    layer.frameIsGlobe = true;
    const gl = makeGl();
    const tile = makePolygonTile();
    const flat = makeLayer();
    flat.frameIsGlobe = true;
    const flatCache = flat.buildTileGpuCache(makeGl(), tile, tile.layers[0]);
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

  it('a granularity change (globe subdivision curve moving) rebuilds under a new key', () => {
    const layer = makeLayer();
    layer.frameIsGlobe = true;
    // A host reporting granularity 1 ⇒ effectively no in-tile splits.
    const host = granularityHost(layer, 1);
    const gl = makeGl();
    const tile = makePolygonTile();

    const mercator = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    expect(mercator.subdivisionGranularity).toBe(4); // 1 × 2² at z2
    expect(mercator.vertexCount).toBe(4); // fixture edges < 1/4 mercator

    // The host projection object now reports the real subdivision curve while
    // the layer stays on globe, so only the granularity-keyed cache catches
    // this — chords must gain vertices or they horizon-clip.
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

  it('mercator hosts keep the plain base cache key (no globe suffix)', () => {
    const layer = makeLayer();
    const gl = makeGl();
    const tile = makePolygonTile();
    const cache = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    expect(layer.ensureTileGpuCache(gl, tile, tile.layers[0])).toBe(cache);
    const keys = [...layer.tileGpuCache.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain('globe:');
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

  it('a globe frame flips frameIsGlobe and keys the next cache separately', () => {
    const { layer, gl, tile } = makeRenderableLayer();
    const frame = layer.beginFrame(v5Args('globe', 1));
    expect(frame).not.toBeNull();
    expect(layer.frameIsGlobe).toBe(true);
    // The flat mercator entry survives — no wholesale rebuild; the globe
    // geometry lands under its own key alongside it.
    expect(layer.tileGpuCache.size).toBe(1);
    layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    expect(layer.tileGpuCache.size).toBe(2);
    expect(
      [...layer.tileGpuCache.keys()].some((k: string) => k.includes('globe:')),
    ).toBe(true);
  });

  it('v5 MERCATOR frames are not globe — the flat cache is reused as-is', () => {
    const { layer, gl, tile } = makeRenderableLayer();
    const frame = layer.beginFrame(v5Args('mercator', 0));
    expect(frame).not.toBeNull();
    expect(layer.frameIsGlobe).toBe(false);
    expect(layer.ensureTileGpuCache(gl, tile, tile.layers[0])).toBeDefined();
    expect(layer.tileGpuCache.size).toBe(1);
  });

  it('legacy frames leave the baked caches alone', () => {
    const { layer } = makeRenderableLayer();
    const frame = layer.beginFrame(new Float32Array(16));
    expect(frame).not.toBeNull();
    expect(layer.frameIsGlobe).toBe(false);
    expect(layer.tileGpuCache.size).toBe(1);
  });
});

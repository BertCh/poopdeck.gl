/**
 * Point-layer shader variants (D3) + Wave M2 feature wiring.
 *
 * D3: the legacy source must keep the `uMatrix` path, the v5+ source must
 * prepend the host prelude + define and project via the injected `projectTile`,
 * and both the visual and id-pick passes must resolve programs through the base
 * per-variant cache — setting the prelude projection uniforms on v5 frames,
 * rebuilding tile VAOs on a variant flip, and never relinking for a variant
 * already cached.
 *
 * M2: `timeFilterMode` (window/wake/cumulative/trail), DataFilter and metric
 * `radiusUnits` are each compiled/uniform-wired identically into BOTH shader
 * variants and into the id-pick program, so an invisible feature is also
 * unpickable. String / mock-GL level only; real prelude compilation and the
 * FBO round-trip are browser-verified.
 */

import { describe, it, expect, vi } from 'vitest';
import { normalizeRenderArgs } from '../src/lib/host-adapter';
import {
  STTPointLayer,
  buildPointVertexSource,
  buildPointIdVertexSource,
  pointProgramKey,
  resolvePointTimeFilterMode,
  type PointShaderConfig,
} from '../src/layers/point-layer';
import {
  DATA_FILTER_CALL_GLSL,
  dataFilterAlphaJS,
} from '../src/shaders/data-filter.glsl';
import {
  wakeAlphaJS,
  wakeSizeScaleJS,
  cumulativeAlphaJS,
} from '../src/shaders/time-window.glsl';
import {
  metersToPixelsAtLatitude,
  tileCenterLatitude,
} from '../src/lib/projection';
import { makeMockGl } from './mock-gl';
import { makePointTile, makePropertyPointTile } from './fixtures';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

const PRELUDE_MARKER = '// __HOST_PRELUDE__';
const PRELUDE = `${PRELUDE_MARKER}\nvec4 projectTile(vec2 p) { return vec4(p, 0.0, 1.0); }`;
const LEGACY_SHADER = { prelude: '', define: '' };
const V5_SHADER = { prelude: PRELUDE, define: '#define GLOBE' };

const cfg = (over: Partial<PointShaderConfig> = {}): PointShaderConfig => ({
  mode: 'window',
  filter: false,
  ...over,
});

/** Both host variants of one configuration, for "identical in both" assertions. */
const bothVariants = (
  build: (s: typeof LEGACY_SHADER, c: PointShaderConfig) => string,
  c: PointShaderConfig,
): [string, string] => [build(LEGACY_SHADER, c), build(V5_SHADER, c)];

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

/**
 * Uniform uploads keyed by NAME. The mock hands out a fresh opaque handle per
 * `getUniformLocation`, so we join the handle a `uniform*` call was given back
 * to the name it was resolved from.
 */
function uniformsByName(gl: any): Map<string, unknown[][]> {
  const nameByLoc = new Map<unknown, string>();
  gl.getUniformLocation.mock.calls.forEach((call: unknown[], i: number) => {
    nameByLoc.set(gl.getUniformLocation.mock.results[i].value, call[1]);
  });
  const out = new Map<string, unknown[][]>();
  for (const fn of [
    gl.uniform1f,
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

/** Scalar value of the last upload to `name`, or undefined if never set. */
const lastScalar = (u: Map<string, unknown[][]>, name: string): unknown =>
  u.get(name)?.at(-1)?.[0];

function makeLayerWithCache(
  extra: Record<string, unknown> = {},
  tile = makePointTile(),
) {
  const layer = new STTPointLayer({ ...baseOpts, id: 'p', ...extra }) as any;
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
  const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
  return { layer, gl, tile, cache };
}

describe('point vertex-source builder', () => {
  it('legacy variant (empty prelude) is the verbatim uMatrix shader', () => {
    const src = buildPointVertexSource(LEGACY_SHADER);
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
    const src = buildPointVertexSource(V5_SHADER);
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
    const legacy = buildPointIdVertexSource(LEGACY_SHADER);
    expect(legacy).toContain('uniform mat4 uMatrix;');
    expect(legacy).toContain('attribute vec3 aIdColor;');
    expect(legacy).not.toContain('projectTile(');

    const v5 = buildPointIdVertexSource(V5_SHADER);
    expect(v5.startsWith(PRELUDE)).toBe(true);
    expect(v5).toContain('attribute vec3 aIdColor;');
    expect(v5).toContain('gl_Position = projectTile(mercator.xy);');
    expect(v5).not.toContain('uniform mat4 uMatrix;');
  });

  it('default config compiles NONE of the M2 surface (back-compat)', () => {
    for (const src of [
      ...bothVariants(buildPointVertexSource, cfg()),
      ...bothVariants(buildPointIdVertexSource, cfg()),
    ]) {
      expect(src).toContain('sttTimeWindowAlpha(aTime,');
      expect(src).not.toContain('uCurrentTime');
      expect(src).not.toContain('uWakeLength');
      expect(src).not.toContain('uTrailLength');
      expect(src).not.toContain('aFilterValue');
      expect(src).not.toContain('uFilterRange');
    }
  });
});

describe('time-filter mode compilation', () => {
  it('wake compiles the wake kernel and shrinks the radius BEFORE gl_PointSize', () => {
    for (const src of [
      ...bothVariants(buildPointVertexSource, cfg({ mode: 'wake' })),
      ...bothVariants(buildPointIdVertexSource, cfg({ mode: 'wake' })),
    ]) {
      expect(src).toContain('float sttWakeAlpha(');
      expect(src).toContain(
        'vAlpha = sttWakeAlpha(aTime, uCurrentTime, uWakeLength);',
      );
      expect(src).toContain(
        'radiusPx *= sttWakeSizeScale(vAlpha, uWakeTailScale);',
      );
      // The size scale reads the alpha, so both must precede gl_PointSize.
      expect(src.indexOf('vAlpha = sttWakeAlpha')).toBeLessThan(
        src.indexOf('radiusPx *= sttWakeSizeScale'),
      );
      expect(src.indexOf('radiusPx *= sttWakeSizeScale')).toBeLessThan(
        src.indexOf('gl_PointSize = radiusPx * 2.0;'),
      );
      // Window uniforms are gone — an unused uniform can't be mis-set.
      expect(src).toContain('uniform float uWakeTailScale;');
      expect(src).not.toContain('uWindowStart');
      expect(src).not.toContain('sttTimeWindowAlpha');
    }
  });

  it('cumulative compiles the cumulative kernel and reuses uFadeIn', () => {
    for (const src of bothVariants(
      buildPointVertexSource,
      cfg({ mode: 'cumulative' }),
    )) {
      expect(src).toContain('float sttCumulativeAlpha(');
      expect(src).toContain(
        'vAlpha = sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn);',
      );
      expect(src).toContain('uniform float uFadeIn;');
      expect(src).not.toContain('uFadeOut');
      expect(src).not.toContain('sttWakeSizeScale');
    }
  });

  it('trail reads aTime.x (a point IS its own single vertex)', () => {
    for (const src of bothVariants(
      buildPointVertexSource,
      cfg({ mode: 'trail' }),
    )) {
      expect(src).toContain('float sttTrailAlpha(');
      expect(src).toContain(
        'vAlpha = sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail);',
      );
      expect(src).toContain('uniform float uFadeTrail;');
    }
  });

  it('every mode keeps the projection of its host variant', () => {
    for (const mode of ['window', 'wake', 'cumulative', 'trail'] as const) {
      const [legacy, v5] = bothVariants(buildPointVertexSource, cfg({ mode }));
      expect(legacy).toContain('uMatrix * vec4(');
      expect(legacy).not.toContain('projectTile(');
      expect(v5).toContain('gl_Position = projectTile(mercator.xy);');
      expect(v5).not.toContain('uniform mat4 uMatrix;');
    }
  });
});

describe('DataFilter compilation', () => {
  const filtered = cfg({ filter: true });

  it('splices the attribute, uniforms and kernel into both variants and both passes', () => {
    for (const src of [
      ...bothVariants(buildPointVertexSource, filtered),
      ...bothVariants(buildPointIdVertexSource, filtered),
    ]) {
      expect(src).toContain('attribute float aFilterValue;');
      expect(src).toContain('uniform vec2 uFilterRange;');
      expect(src).toContain('uniform vec2 uFilterSoftRange;');
      expect(src).toContain('uniform float uFilterEnabled;');
      expect(src).toContain('float sttDataFilterAlpha(');
      // The canonical call verbatim, so the five layers cannot drift.
      expect(src).toContain(`float filterAlpha = ${DATA_FILTER_CALL_GLSL};`);
    }
  });

  it('hides hard-filtered features regardless of the transform flags', () => {
    const src = buildPointVertexSource(LEGACY_SHADER, filtered);
    // deck parity: 0 always hides; a soft-margin value only fades/shrinks
    // when its transform flag is on.
    expect(src).toContain('if (filterAlpha <= 0.0) {\n      vAlpha = 0.0;');
    expect(src).toContain('} else if (uFilterTransformColor > 0.5) {');
    expect(src).toContain('if (uFilterTransformSize > 0.5) {');
    // Both transforms land before the size is committed.
    expect(src.indexOf('radiusPx *= filterAlpha;')).toBeLessThan(
      src.indexOf('gl_PointSize = radiusPx * 2.0;'),
    );
  });

  it('composes multiplicatively with the time filter, never replacing it', () => {
    const src = buildPointVertexSource(LEGACY_SHADER, {
      mode: 'wake',
      filter: true,
    });
    expect(src).toContain('vAlpha = sttWakeAlpha(');
    expect(src).toContain('vAlpha *= filterAlpha;');
    expect(src.indexOf('vAlpha = sttWakeAlpha')).toBeLessThan(
      src.indexOf('vAlpha *= filterAlpha;'),
    );
  });

  it('a POINT primitive is gated by the FS discard, not a w=0 gl_Position collapse', () => {
    // The kernel suggests `gl_Position = vec4(0.0)` for vertex-expanded
    // geometry; for GL_POINTS w==0 leaves the NDC position undefined, so the
    // (pre-existing, proven) `if (vAlpha <= 0.0) discard;` stays the gate.
    const src = buildPointVertexSource(LEGACY_SHADER, filtered);
    expect(src).not.toContain('gl_Position = vec4(0.0)');
  });
});

describe('mode/config resolution', () => {
  it('defaults to window and infers from the knobs when unset (deck precedence)', () => {
    expect(resolvePointTimeFilterMode(undefined, 0, 0)).toBe('window');
    expect(resolvePointTimeFilterMode(undefined, 1000, 0)).toBe('wake');
    expect(resolvePointTimeFilterMode(undefined, 0, 1000)).toBe('trail');
    // wake outranks trail, exactly as TimeFilterExtension's branch order does.
    expect(resolvePointTimeFilterMode(undefined, 1000, 1000)).toBe('wake');
  });

  it('an explicit mode wins, but a degenerate length degrades to window', () => {
    expect(resolvePointTimeFilterMode('window', 1000, 1000)).toBe('window');
    expect(resolvePointTimeFilterMode('cumulative', 0, 0)).toBe('cumulative');
    expect(resolvePointTimeFilterMode('wake', 0, 0)).toBe('window');
    expect(resolvePointTimeFilterMode('trail', 0, 0)).toBe('window');
  });

  it('program keys separate every compiled configuration', () => {
    const keys = new Set([
      pointProgramKey('main', cfg()),
      pointProgramKey('main', cfg({ mode: 'wake' })),
      pointProgramKey('main', cfg({ mode: 'cumulative' })),
      pointProgramKey('main', cfg({ mode: 'trail' })),
      pointProgramKey('main', cfg({ filter: true })),
      pointProgramKey('pick', cfg()),
    ]);
    expect(keys.size).toBe(6);
    expect(pointProgramKey('main', cfg())).toBe('main:window');
    expect(pointProgramKey('pick', cfg({ mode: 'wake', filter: true }))).toBe(
      'pick:wake:filter',
    );
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

describe('time-mode uniform wiring', () => {
  const legacyFrame = () => normalizeRenderArgs(new Float32Array(16));

  it('default layer sets ONLY the window uniforms (byte-for-byte back-compat)', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const ctx = drawCtx(legacyFrame());
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uWindowStart')).toBe(ctx.windowStart);
    expect(lastScalar(u, 'uWindowEnd')).toBe(ctx.windowEnd);
    expect(lastScalar(u, 'uFadeIn')).toBe(0);
    expect(lastScalar(u, 'uFadeOut')).toBe(0);
    expect(u.has('uCurrentTime')).toBe(false);
    expect(u.has('uWakeLength')).toBe(false);
    expect(u.has('uFilterEnabled')).toBe(false);
    // Pixel sizing is the default: the scale stays the plain multiplier.
    expect(lastScalar(u, 'uRadiusScale')).toBe(1);
  });

  it('wake mode sets tile-relative uCurrentTime + the wake knobs', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      timeFilterMode: 'wake',
      wakeLength: 30_000,
    });
    const ctx = drawCtx(legacyFrame());
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    const u = uniformsByName(gl);
    // trips-layer convention: absolute time minus THIS tile's timeOffset.
    expect(lastScalar(u, 'uCurrentTime')).toBe(
      ctx.currentTime - cache.timeOffset,
    );
    expect(lastScalar(u, 'uWakeLength')).toBe(30_000);
    expect(lastScalar(u, 'uWakeTailScale')).toBe(0.15); // core DEFAULT_WAKE_TAIL_SCALE
    expect(u.has('uWindowStart')).toBe(false);
  });

  it('cumulative mode reuses uFadeIn from resolveFadeDurations', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      timeFilterMode: 'cumulative',
      fadeInDuration: 2000,
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uFadeIn')).toBe(2000);
    expect(u.has('uFadeOut')).toBe(false);
    expect(u.has('uWakeLength')).toBe(false);
  });

  it('trail mode sets the trail knobs (fadeTrail defaults on, like the trips layer)', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      timeFilterMode: 'trail',
      trailLength: 60_000,
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uTrailLength')).toBe(60_000);
    expect(lastScalar(u, 'uFadeTrail')).toBe(1);
  });

  it('setWakeLength flips the compiled mode: one relink, VAO re-recorded', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.createProgram.mock.calls.length).toBe(1);

    layer.setWakeLength(10_000);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    // Same host variant, different compiled mode ⇒ a second program and a
    // rebuilt VAO (attribute slots are per-program).
    expect(gl.createProgram.mock.calls.length).toBe(2);
    expect(gl.deleteVertexArray).toHaveBeenCalledTimes(1);
    expect(vertexSources(gl).some((s) => s.includes('sttWakeSizeScale'))).toBe(
      true,
    );
  });

  it('a mode setter that resolves to the SAME mode does not relink', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    layer.setTimeFilterMode('wake'); // wakeLength is 0 ⇒ still window
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.createProgram.mock.calls.length).toBe(1);
  });
});

describe('DataFilter wiring', () => {
  const legacyFrame = () => normalizeRenderArgs(new Float32Array(16));

  it('uploads the per-feature column and enables the filter for that tile', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache(
      { filterProperty: 'magnitude', filterRange: [1, 5] as const },
      makePropertyPointTile(),
    );
    expect(cache.filterBuffer).toBeDefined();
    expect(cache.hasFilterColumn).toBe(true);

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uFilterEnabled')).toBe(1);
    expect(
      Array.from(u.get('uFilterRange')!.at(-1)![0] as Float32Array),
    ).toEqual([1, 5]);
    // No soft range ⇒ the soft edges collapse onto the hard ones (hard step).
    expect(
      Array.from(u.get('uFilterSoftRange')!.at(-1)![0] as Float32Array),
    ).toEqual([1, 5]);
    expect(lastScalar(u, 'uFilterTransformSize')).toBe(1);
    expect(lastScalar(u, 'uFilterTransformColor')).toBe(1);
  });

  it('a tile MISSING the column renders unfiltered, never blank', () => {
    // makePointTile bakes no numericProps at all.
    const { layer, gl, tile, cache } = makeLayerWithCache({
      filterProperty: 'magnitude',
      filterRange: [1, 5] as const,
    });
    expect(cache.filterBuffer).toBeUndefined();
    expect(cache.hasFilterColumn).toBe(false);

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(lastScalar(uniformsByName(gl), 'uFilterEnabled')).toBe(0);
  });

  it('a CATEGORICAL column warns once and renders unfiltered', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { layer, gl, cache } = makeLayerWithCache(
        { filterProperty: 'species', filterRange: [0, 1] as const },
        makePropertyPointTile(),
      );
      expect(cache.hasFilterColumn).toBe(false);
      // A second tile must not re-warn.
      const t2 = makePropertyPointTile();
      layer.buildTileGpuCache(gl, t2, t2.layers[0]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('setFilterRange is uniform-only — no relink, no tile rebuild', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache(
      { filterProperty: 'magnitude', filterRange: [1, 5] as const },
      makePropertyPointTile(),
    );
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const programs = gl.createProgram.mock.calls.length;

    layer.setFilterRange([2, 9]);
    layer.setFilterSoftRange([3, 8]);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.createProgram.mock.calls.length).toBe(programs);
    const u = uniformsByName(gl);
    expect(
      Array.from(u.get('uFilterRange')!.at(-1)![0] as Float32Array),
    ).toEqual([2, 9]);
    expect(
      Array.from(u.get('uFilterSoftRange')!.at(-1)![0] as Float32Array),
    ).toEqual([3, 8]);

    layer.setFilterEnabled(false);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(lastScalar(uniformsByName(gl), 'uFilterEnabled')).toBe(0);
  });

  it('the shader composition matches the JS reference (hard 0 hides, soft fades)', () => {
    // Mirrors the compiled FILTER_BODY: hard-zero always hides; a soft-margin
    // value only fades when uFilterTransformColor is on.
    const compose = (
      timeAlpha: number,
      value: number,
      range: number[],
      soft: number[],
      transformColor: boolean,
    ): number => {
      const f = dataFilterAlphaJS(value, range, soft, true);
      if (f <= 0) return 0;
      return transformColor ? timeAlpha * f : timeAlpha;
    };
    // Outside the hard range: hidden with the colour transform OFF too.
    expect(compose(1, 99, [0, 10], [0, 10], false)).toBe(0);
    expect(compose(1, 99, [0, 10], [0, 10], true)).toBe(0);
    // Inside the soft margin: fades only when the flag is on.
    const soft = dataFilterAlphaJS(9, [0, 10], [0, 8], true);
    expect(soft).toBeGreaterThan(0);
    expect(soft).toBeLessThan(1);
    expect(compose(1, 9, [0, 10], [0, 8], true)).toBeCloseTo(soft, 12);
    expect(compose(1, 9, [0, 10], [0, 8], false)).toBe(1);
    // The time alpha still multiplies through.
    expect(compose(0.5, 5, [0, 10], [0, 10], true)).toBeCloseTo(0.5, 12);
  });
});

describe('metric sizing (radiusUnits)', () => {
  const legacyFrame = () => normalizeRenderArgs(new Float32Array(16));

  it("'meters' folds the per-tile metres→device-pixels factor into uRadiusScale", () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      radiusUnits: 'meters',
      radius: 250,
      radiusScale: 2,
    });
    // Fractional zoom from the map, NOT the floored ctx.zoom, so the size
    // changes continuously instead of stepping at integer zooms.
    layer.map = { getZoom: () => 2.5, triggerRepaint: vi.fn() };
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));

    const dpr =
      (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1;
    const expected =
      2 *
      metersToPixelsAtLatitude(
        1,
        tileCenterLatitude(tile.id.z, tile.id.y),
        2.5,
        512 * dpr,
      );
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uRadiusScale')).toBeCloseTo(expected, 6);
    // The radius itself is still uploaded raw — the unit lives in the scale.
    expect(lastScalar(u, 'uRadius')).toBe(250);
  });

  it("'pixels' (default) is unchanged and needs no map", () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({ radiusScale: 3 });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(lastScalar(uniformsByName(gl), 'uRadiusScale')).toBe(3);
  });

  it('metric sizing adds no shader variant (uniform-only change)', () => {
    const pixels = buildPointVertexSource(LEGACY_SHADER, cfg());
    expect(pixels).toContain('* uRadiusScale;');
    // Nothing metres-specific reaches the shader.
    expect(pixels).not.toContain('uMetersPerPixel');
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

describe('pick gating parity (invisible ⇒ unpickable)', () => {
  const legacyFrame = () => normalizeRenderArgs(new Float32Array(16));

  it('the id program compiles the SAME time-filter mode, size shrink and discard', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      timeFilterMode: 'wake',
      wakeLength: 30_000,
    });
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    const idSrc = vertexSources(gl).find((s) =>
      s.includes('attribute vec3 aIdColor;'),
    )!;
    expect(idSrc).toContain(
      'vAlpha = sttWakeAlpha(aTime, uCurrentTime, uWakeLength);',
    );
    expect(idSrc).toContain(
      'radiusPx *= sttWakeSizeScale(vAlpha, uWakeTailScale);',
    );

    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uCurrentTime')).toBe(
      drawCtx().currentTime - cache.timeOffset,
    );
    expect(lastScalar(u, 'uWakeLength')).toBe(30_000);
    // The fragment shader discards a zero-alpha (time-gated) fragment before
    // it can paint an id.
    const idFs = gl.shaderSource.mock.calls
      .map((c: unknown[]) => c[1] as string)
      .find((s: string) => s.includes('vIdColor'))!;
    expect(idFs).toBeTruthy();
  });

  it('the id pass applies the SAME DataFilter range as the visual pass', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache(
      { filterProperty: 'magnitude', filterRange: [1, 5] as const },
      makePropertyPointTile(),
    );
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    const idSrc = vertexSources(gl).find((s) =>
      s.includes('attribute vec3 aIdColor;'),
    )!;
    expect(idSrc).toContain(`float filterAlpha = ${DATA_FILTER_CALL_GLSL};`);

    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uFilterEnabled')).toBe(1);
    expect(
      Array.from(u.get('uFilterRange')!.at(-1)![0] as Float32Array),
    ).toEqual([1, 5]);
    // The filter attribute is bound (and released) in the pick pass too.
    expect(gl.enableVertexAttribArray).toHaveBeenCalled();
    expect(gl.disableVertexAttribArray).toHaveBeenCalled();
  });

  it('the id pass sizes in the SAME units as the visual pass', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      radiusUnits: 'meters',
      radius: 250,
    });
    layer.map = { getZoom: () => 4, triggerRepaint: vi.fn() };
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const visual = lastScalar(uniformsByName(gl), 'uRadiusScale');

    const gl2 = makeMockGl();
    layer.drawPickTile(
      gl2,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    expect(lastScalar(uniformsByName(gl2), 'uRadiusScale')).toBe(visual);
  });
});

describe('JS references used by the compiled point shaders', () => {
  it('wake alpha + tail scale compose exactly as the vertex source does', () => {
    const tail = 0.15;
    // Head of the wake: full alpha, full size.
    expect(wakeAlphaJS(0, 0, 1000)).toBe(1);
    expect(wakeSizeScaleJS(wakeAlphaJS(0, 0, 1000), tail)).toBe(1);
    // Tail: zero alpha, and the size floor is the tail scale.
    expect(wakeAlphaJS(0, 1000, 1000)).toBe(0);
    expect(wakeSizeScaleJS(wakeAlphaJS(0, 1000, 1000), tail)).toBeCloseTo(
      tail,
      12,
    );
    // Outside the wake entirely (future or expired) — nothing to draw.
    expect(wakeAlphaJS(0, -1, 1000)).toBe(0);
    expect(wakeAlphaJS(0, 1001, 1000)).toBe(0);
  });

  it('cumulative alpha persists once revealed', () => {
    expect(cumulativeAlphaJS(100, 50, 0)).toBe(0);
    expect(cumulativeAlphaJS(100, 100, 0)).toBe(1);
    expect(cumulativeAlphaJS(100, 1e9, 0)).toBe(1);
    expect(cumulativeAlphaJS(100, 150, 100)).toBeCloseTo(0.5, 12);
  });
});

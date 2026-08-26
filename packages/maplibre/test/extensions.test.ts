/**
 * User shader extensions (`src/shaders/extensions.glsl.ts`) — the maplibre
 * backend's `LayerExtension` analogue, and the four constraints that make a
 * GLSL text-injection hook safe to ship.
 *
 * The suite is organised as those four constraints, in the order they can
 * break a shipped map:
 *
 *  1. BACK-COMPAT. An empty (or absent) extension list must compile the shader
 *     this package already shipped, BYTE FOR BYTE, and key the identical
 *     program. Proven by string comparison against goldens below.
 *  2. THE PROGRAM-CACHE KEY. An extension changes the compiled source, so its
 *     identity has to reach the cache key or two configurations silently share
 *     one linked program — the single worst failure available here, because it
 *     is invisible (it draws, just with the wrong shader).
 *  3. PICK PARITY. The id program compiles the same VERTEX seams, so geometry
 *     an extension moves is picked where it is drawn — and no user text
 *     reaches the id FRAGMENT stage, whose colour must decode to an exact id.
 *  4. NO WIDENING. The shipped time-filter / DataFilter gates compose AFTER the
 *     user's alpha, and the extension's factor is clamped, so a composed alpha
 *     is always ≤ the shipped one.
 *
 * ── About the goldens ───────────────────────────────────────────────────────
 * The golden sources below embed the ASSEMBLY verbatim and INTERPOLATE the
 * shared kernels (`TIME_WINDOW_GLSL`, `POSITION_DEQUANT_GLSL`, the DataFilter
 * blocks) from their own modules. That is deliberate: the assembly is what the
 * extension splice touches and what this gate exists to freeze, while a kernel
 * edit is that kernel's own suite's business and must not fail here for a
 * reason that has nothing to do with extensions. The goldens themselves were
 * captured from the builder BEFORE the hook existed.
 *
 * No GL and no map: shader assembly is string work, and the draw-path
 * assertions ride `test/mock-gl.ts` like every other layer suite.
 */

import { describe, it, expect, vi } from 'vitest';
import { STTLineLayer } from '../src/layers/line-layer';
import {
  STTPointLayer,
  buildPointVertexSource,
  buildPointIdVertexSource,
  buildPointFragmentSource,
  pointProgramKey,
  type PointShaderConfig,
} from '../src/layers/point-layer';
import {
  composeExtensionChunks,
  extensionAlphaJS,
  extensionSourceDigest,
  parseDeclaredNames,
  spliceExtensionAlpha,
  spliceExtensionColor,
  spliceExtensionPosition,
  spliceExtensionSize,
  EMPTY_EXTENSION_CHUNKS,
  EXTENSION_SEAM_VARS,
  type ExtensionDrawContext,
  type ExtensionUniformWriter,
  type STTShaderExtension,
} from '../src/shaders/extensions.glsl';
import {
  TIME_WINDOW_GLSL,
  TIME_MODE_UNIFORM_DECLS_WITH_WAKE_TAIL_SCALE,
} from '../src/shaders/time-window.glsl';
import { POSITION_DEQUANT_GLSL } from '../src/shaders/position-quantization.glsl';
import {
  DATA_FILTER_ATTRIBUTE_GLSL,
  DATA_FILTER_CALL_GLSL,
  DATA_FILTER_GLSL,
  DATA_FILTER_UNIFORMS_GLSL,
} from '../src/shaders/data-filter.glsl';
import {
  buildBillboardIdFragmentSource,
  discMaskGLSL,
  DISC_EDGE_EXPR,
} from '../src/shaders/billboard.glsl';
import { makeMockGl } from './mock-gl';
import { makePointTile } from './fixtures';

const LEGACY_SHADER = { prelude: '', define: '' };
const PRELUDE_SHADER = { prelude: '// prelude', define: '#define GLOBE' };

// The kernels the goldens interpolate, under the names the builder uses.
const MODE_UNIFORMS = TIME_MODE_UNIFORM_DECLS_WITH_WAKE_TAIL_SCALE;
const FILTER_ATTRIBUTE = DATA_FILTER_ATTRIBUTE_GLSL.replace(/^\n/, '');
const FILTER_UNIFORMS = DATA_FILTER_UNIFORMS_GLSL.replace(/^\n/, '');

/* ── goldens: the pre-extension sources, captured before the hook existed ── */

const GOLDEN_LEGACY_MAIN = `
  precision highp float;
  attribute vec3 aMercator;    // per-tile-local UNSIGNED_SHORT, normalized [0,1] — see sttDecodeMercatorPos
  attribute vec2 aTime;
  attribute vec4 aColor;       // per-feature RGBA in 0..1 (constant fallback when uUseFeatureColor=0)
  attribute float aRadius;     // per-feature radius in radiusUnits (when uUseFeatureRadius=1)
  uniform mat4 uMatrix;
  uniform float uAltitudeScale;
  uniform vec3 uPosScale;
  uniform vec3 uPosOffset;
  uniform float uRadius;
  uniform float uRadiusScale;
  uniform float uUseFeatureRadius;
  uniform float uUseFeatureColor;
  uniform vec4 uColor;
${MODE_UNIFORMS.window}  varying float vAlpha;
  varying vec4 vColor;
${TIME_WINDOW_GLSL}${POSITION_DEQUANT_GLSL}
  void main() {
    vec3 mercator = sttDecodeMercatorPos(aMercator, uPosScale, uPosOffset);
    vec4 pos = uMatrix * vec4(mercator.x, mercator.y, mercator.z * uAltitudeScale, 1.0);
    gl_Position = pos;
    vAlpha = sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut);
    float radiusPx = (uUseFeatureRadius > 0.5 ? aRadius : uRadius) * uRadiusScale;
    gl_PointSize = radiusPx * 2.0;
    vColor = (uUseFeatureColor > 0.5) ? aColor : uColor;
  }
`;

const GOLDEN_LEGACY_MAIN_FILTER = `
  precision highp float;
  attribute vec3 aMercator;    // per-tile-local UNSIGNED_SHORT, normalized [0,1] — see sttDecodeMercatorPos
  attribute vec2 aTime;
  attribute vec4 aColor;       // per-feature RGBA in 0..1 (constant fallback when uUseFeatureColor=0)
  attribute float aRadius;     // per-feature radius in radiusUnits (when uUseFeatureRadius=1)
${FILTER_ATTRIBUTE}  uniform mat4 uMatrix;
  uniform float uAltitudeScale;
  uniform vec3 uPosScale;
  uniform vec3 uPosOffset;
  uniform float uRadius;
  uniform float uRadiusScale;
  uniform float uUseFeatureRadius;
  uniform float uUseFeatureColor;
  uniform vec4 uColor;
${MODE_UNIFORMS.window}${FILTER_UNIFORMS}  varying float vAlpha;
  varying vec4 vColor;
${TIME_WINDOW_GLSL}${POSITION_DEQUANT_GLSL}${DATA_FILTER_GLSL}
  void main() {
    vec3 mercator = sttDecodeMercatorPos(aMercator, uPosScale, uPosOffset);
    vec4 pos = uMatrix * vec4(mercator.x, mercator.y, mercator.z * uAltitudeScale, 1.0);
    gl_Position = pos;
    vAlpha = sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut);
    float radiusPx = (uUseFeatureRadius > 0.5 ? aRadius : uRadius) * uRadiusScale;
    float filterAlpha = ${DATA_FILTER_CALL_GLSL};
    if (filterAlpha <= 0.0) {
      vAlpha = 0.0;               // hard-filtered: the FS discard hides it
    } else if (uFilterTransformColor > 0.5) {
      vAlpha *= filterAlpha;
    }
    if (uFilterTransformSize > 0.5) {
      radiusPx *= filterAlpha;
    }
    gl_PointSize = radiusPx * 2.0;
    vColor = (uUseFeatureColor > 0.5) ? aColor : uColor;
  }
`;

const GOLDEN_PRELUDE_MAIN = `// prelude
#define GLOBE

  precision highp float;
  attribute vec3 aMercator;    // per-tile-local UNSIGNED_SHORT, normalized [0,1] — see sttDecodeMercatorPos
  attribute vec2 aTime;
  attribute vec4 aColor;       // per-feature RGBA in 0..1 (constant fallback when uUseFeatureColor=0)
  attribute float aRadius;     // per-feature radius in radiusUnits (when uUseFeatureRadius=1)
  uniform vec3 uPosScale;
  uniform vec3 uPosOffset;
  uniform float uRadius;
  uniform float uRadiusScale;
  uniform float uUseFeatureRadius;
  uniform float uUseFeatureColor;
  uniform vec4 uColor;
${MODE_UNIFORMS.window}  varying float vAlpha;
  varying vec4 vColor;
${TIME_WINDOW_GLSL}${POSITION_DEQUANT_GLSL}
  void main() {
    vec3 mercator = sttDecodeMercatorPos(aMercator, uPosScale, uPosOffset);
    gl_Position = projectTile(mercator.xy);
    vAlpha = sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut);
    float radiusPx = (uUseFeatureRadius > 0.5 ? aRadius : uRadius) * uRadiusScale;
    gl_PointSize = radiusPx * 2.0;
    vColor = (uUseFeatureColor > 0.5) ? aColor : uColor;
  }
`;

const GOLDEN_LEGACY_ID = `
  precision highp float;
  attribute vec3 aMercator;    // per-tile-local UNSIGNED_SHORT, normalized [0,1] — see sttDecodeMercatorPos
  attribute vec2 aTime;
  attribute vec3 aIdColor;     // per-feature encoded id (UNSIGNED_BYTE normalized)
  attribute float aRadius;     // per-feature radius in radiusUnits (when uUseFeatureRadius=1)
  uniform mat4 uMatrix;
  uniform float uAltitudeScale;
  uniform vec3 uPosScale;
  uniform vec3 uPosOffset;
  uniform float uRadius;
  uniform float uRadiusScale;
  uniform float uUseFeatureRadius;
${MODE_UNIFORMS.window}  varying float vAlpha;
  varying vec3 vIdColor;
${TIME_WINDOW_GLSL}${POSITION_DEQUANT_GLSL}
  void main() {
    vec3 mercator = sttDecodeMercatorPos(aMercator, uPosScale, uPosOffset);
    gl_Position = uMatrix * vec4(mercator.x, mercator.y, mercator.z * uAltitudeScale, 1.0);
    vAlpha = sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut);
    float radiusPx = (uUseFeatureRadius > 0.5 ? aRadius : uRadius) * uRadiusScale;
    gl_PointSize = radiusPx * 2.0;
    vIdColor = aIdColor;
  }
`;

const GOLDEN_FRAGMENT = `
  precision highp float;
  varying float vAlpha;
  varying vec4 vColor;
  void main() {
    if (vAlpha <= 0.0) discard;
${discMaskGLSL()}    // Antialiased disc: soften the last ~10% of the radius.
    float edge = ${DISC_EDGE_EXPR};
    gl_FragColor = vec4(vColor.rgb, vColor.a * vAlpha * edge);
  }
`;

/* ── extensions used across the suite ──────────────────────────────────── */

/** Moves geometry: the seam every pick-parity claim rests on. */
const DRIFT: STTShaderExtension = {
  name: 'drift',
  uniforms: 'uniform vec2 uDrift;',
  vertex: {
    position: `    ${EXTENSION_SEAM_VARS.position}.xy += uDrift;`,
  },
  onBeforeDraw: (u, ctx) => u.setVec2('uDrift', [ctx.zoom * 0.001, 0]),
};

/** Dims and shrinks — the two factor seams. */
const PULSE: STTShaderExtension = {
  name: 'pulse',
  uniforms: 'uniform float uPulse;',
  vertex: {
    alpha: `    ${EXTENSION_SEAM_VARS.alpha} *= uPulse;`,
    size: `    ${EXTENSION_SEAM_VARS.size} *= 1.0 + uPulse;`,
  },
  onBeforeDraw: (u) => u.setFloat('uPulse', 0.25),
};

/** Recolours in the fragment stage, off a varying its vertex seam wrote. */
const TINT: STTShaderExtension = {
  name: 'tint',
  uniforms: 'uniform vec3 uTint;',
  varyings: 'varying float vTintMix;',
  fragmentDeclarations: `vec3 sttTintMix(vec3 c, vec3 t, float m) {
  return mix(c, t, m);
}`,
  vertex: { alpha: '    vTintMix = 0.5;' },
  fragment: {
    color: `    ${EXTENSION_SEAM_VARS.color}.rgb = sttTintMix(${EXTENSION_SEAM_VARS.color}.rgb, uTint, vTintMix);`,
  },
  onBeforeDraw: (u) => u.setVec3('uTint', [1, 0, 0]),
};

const cfg = (over: Partial<PointShaderConfig> = {}): PointShaderConfig => ({
  mode: 'window',
  filter: false,
  ...over,
});

const chunksOf = (...exts: STTShaderExtension[]) =>
  composeExtensionChunks(exts);

/* ── mock-GL harness (the point-variants.test.ts helpers, verbatim) ─────── */

/** All vertex/fragment sources handed to the mock GL so far. */
const shaderSources = (gl: any): string[] =>
  gl.shaderSource.mock.calls.map((c: unknown[]) => c[1] as string);

const vertexSources = (gl: any): string[] =>
  shaderSources(gl).filter(
    (s) => s.includes('void main()') && s.includes('aMercator'),
  );

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
    gl.uniform1i,
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

const drawCtx = () => ({
  matrix: new Float32Array(16),
  windowStart: -2500,
  windowEnd: 2500,
  currentTime: 1_700_000_001_000,
  zoom: 2,
});

function makeLayerWithCache(extra: Record<string, unknown> = {}) {
  const tile = makePointTile();
  const layer = new STTPointLayer({
    id: 'x',
    url: 'mem://test.stt',
    currentTime: 1_700_000_001_000,
    timeWindow: 5000,
    ...extra,
  }) as any;
  layer.supports32BitIndices = true;
  const gl = makeMockGl();
  layer.vaoSupport = {
    enabled: true,
    create: () => gl.createVertexArray(),
    bind: (vao: unknown) => gl.bindVertexArray(vao),
    delete: (vao: unknown) => gl.deleteVertexArray(vao),
  };
  const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
  const draw = () => layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
  const pick = (idBase = 1) =>
    layer.drawPickTile(gl, tile, tile.layers[0], cache, drawCtx(), idBase);
  return { layer, gl, tile, cache, draw, pick };
}

/* ──────────────────────────────────────────────────────────────────────────
 * (1) BACK-COMPAT — an empty list is not "equivalent", it is IDENTICAL.
 * ────────────────────────────────────────────────────────────────────────── */
describe('no extensions compiles the pre-extension source byte for byte', () => {
  it.each([
    [
      'legacy visual, window',
      () => buildPointVertexSource(LEGACY_SHADER, cfg()),
      () => GOLDEN_LEGACY_MAIN,
    ],
    [
      'legacy visual, window + DataFilter',
      () => buildPointVertexSource(LEGACY_SHADER, cfg({ filter: true })),
      () => GOLDEN_LEGACY_MAIN_FILTER,
    ],
    [
      'v5 prelude visual, window',
      () => buildPointVertexSource(PRELUDE_SHADER, cfg()),
      () => GOLDEN_PRELUDE_MAIN,
    ],
    [
      'legacy id-pick, window',
      () => buildPointIdVertexSource(LEGACY_SHADER, cfg()),
      () => GOLDEN_LEGACY_ID,
    ],
    [
      'visual fragment stage',
      () => buildPointFragmentSource(),
      () => GOLDEN_FRAGMENT,
    ],
  ])('%s', (_name, build, golden) => {
    expect(build()).toBe(golden());
  });

  it('an explicitly EMPTY list is the same source, not merely a similar one', () => {
    const empty = chunksOf();
    expect(empty).toBe(EMPTY_EXTENSION_CHUNKS);
    expect(
      buildPointVertexSource(LEGACY_SHADER, cfg({ extensions: empty })),
    ).toBe(GOLDEN_LEGACY_MAIN);
    expect(
      buildPointIdVertexSource(LEGACY_SHADER, cfg({ extensions: empty })),
    ).toBe(GOLDEN_LEGACY_ID);
    expect(buildPointFragmentSource(empty)).toBe(GOLDEN_FRAGMENT);
  });

  it('and the same program-cache keys (an empty list contributes nothing)', () => {
    expect(pointProgramKey('main', cfg())).toBe('point:main:window');
    expect(pointProgramKey('pick', cfg({ filter: true }))).toBe(
      'point:pick:window:filter',
    );
    expect(pointProgramKey('main', cfg({ extensions: chunksOf() }))).toBe(
      'point:main:window',
    );
  });

  it('defaults are the pre-campaign behaviour: no option ⇒ no extensions', () => {
    const { layer } = makeLayerWithCache();
    expect(layer.extensions).toEqual([]);
    expect(layer.extensionChunks).toBe(EMPTY_EXTENSION_CHUNKS);
    expect(layer.shaderConfig.extensions).toBe(EMPTY_EXTENSION_CHUNKS);
    expect(layer.mainKey).toBe('point:main:window');
  });

  it('the layer holds the list it was handed (what the descriptor probe reads)', () => {
    const list = [PULSE];
    const { layer } = makeLayerWithCache({ extensions: list });
    // BY REFERENCE, both the list and its members — a conformance probe joins
    // on identity, and so does anyone diffing props across a React render.
    expect(layer.extensions).toBe(list);
    expect(layer.extensions[0]).toBe(PULSE);
    expect(layer.extensionChunks.key).not.toBe('');
  });

  it('a kind that does NOT splice the seams says so, once, instead of silently ignoring them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The line layer stores the option (the base owns it) but compiles nothing.
    const line = new STTLineLayer({
      id: 'l',
      url: 'mem://test.stt',
      currentTime: 0,
      timeWindow: 1000,
      extensions: [PULSE],
    }) as any;
    expect(line.extensions[0]).toBe(PULSE);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('ignored');
    line.setExtensionList([PULSE, TINT]);
    expect(warn).toHaveBeenCalledTimes(1); // once per layer, not per call
    // …and the layer that DOES splice them stays quiet.
    warn.mockClear();
    makeLayerWithCache({ extensions: [PULSE] });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a non-array value composes to nothing instead of a per-character list', () => {
    const { layer } = makeLayerWithCache({
      extensions: 'not an extension list' as unknown as STTShaderExtension[],
    });
    expect(layer.extensions).toEqual([]);
    expect(layer.extensionChunks).toBe(EMPTY_EXTENSION_CHUNKS);
  });

  it('every splice helper is a no-op on the empty composition', () => {
    const e = EMPTY_EXTENSION_CHUNKS;
    expect(spliceExtensionPosition(e, 'mercator')).toBe('');
    expect(spliceExtensionSize(e, 'radiusPx')).toBe('');
    expect(spliceExtensionAlpha(e, 'vAlpha', 'shipped(x)')).toBe(
      '    vAlpha = shipped(x);\n',
    );
    expect(spliceExtensionColor(e, 'vColor', 'vAlpha * edge')).toBe(
      '    gl_FragColor = vec4(vColor.rgb, vColor.a * vAlpha * edge);\n',
    );
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * (2) THE PROGRAM-CACHE KEY — the one that fails silently.
 * ────────────────────────────────────────────────────────────────────────── */
describe('extension identity reaches the program-cache key', () => {
  it('two extensions that differ ONLY in GLSL still key two programs', () => {
    // Same name on purpose: a name-only key would collide here, compile one
    // program and draw both layers with whichever source linked first.
    const a: STTShaderExtension = {
      name: 'same',
      vertex: { size: '    sttExtSize *= 2.0;' },
    };
    const b: STTShaderExtension = {
      name: 'same',
      vertex: { size: '    sttExtSize *= 3.0;' },
    };
    expect(extensionSourceDigest(a)).not.toBe(extensionSourceDigest(b));
    expect(chunksOf(a).key).not.toBe(chunksOf(b).key);
    expect(pointProgramKey('main', cfg({ extensions: chunksOf(a) }))).not.toBe(
      pointProgramKey('main', cfg({ extensions: chunksOf(b) })),
    );
    // …and the pick pass separates on the same axis.
    expect(pointProgramKey('pick', cfg({ extensions: chunksOf(a) }))).not.toBe(
      pointProgramKey('pick', cfg({ extensions: chunksOf(b) })),
    );
    // The differential: WITHOUT the extension segment the two keys are equal —
    // i.e. the segment is what is doing the work, not some other difference.
    expect(pointProgramKey('main', cfg())).toBe(pointProgramKey('main', cfg()));
  });

  it('is content-addressed: an equal extension rebuilt per frame keys the same program', () => {
    const build = (): STTShaderExtension => ({
      name: 'pulse',
      uniforms: 'uniform float uPulse;',
      vertex: { alpha: '    sttExtAlpha *= uPulse;' },
      onBeforeDraw: (u) => u.setFloat('uPulse', 1),
    });
    expect(chunksOf(build()).key).toBe(chunksOf(build()).key);
    // A callback is not part of the source, so it cannot split the cache.
    const noCallback = { ...build(), onBeforeDraw: undefined };
    expect(chunksOf(noCallback).key).toBe(chunksOf(build()).key);
  });

  it('splice ORDER is part of the key (two orders are two programs)', () => {
    expect(chunksOf(PULSE, TINT).key).not.toBe(chunksOf(TINT, PULSE).key);
  });

  it('over-separating is fine, under-separating is not: a source-less extension still keys its own program', () => {
    const inert: STTShaderExtension = { name: 'inert' };
    const chunks = chunksOf(inert);
    // It splices nothing…
    expect(
      buildPointVertexSource(LEGACY_SHADER, cfg({ extensions: chunks })),
    ).toBe(GOLDEN_LEGACY_MAIN);
    // …but it still gets its own key. A conservative key costs one extra link;
    // a permissive one draws with the wrong shader.
    expect(pointProgramKey('main', cfg({ extensions: chunks }))).not.toBe(
      pointProgramKey('main', cfg()),
    );
  });

  it('END TO END: two layers with different extensions link two distinct programs', () => {
    const gl = makeMockGl();
    const tile = makePointTile();
    const mount = (ext: STTShaderExtension) => {
      const layer = new STTPointLayer({
        id: ext.name,
        url: 'mem://test.stt',
        currentTime: 1_700_000_001_000,
        timeWindow: 5000,
        extensions: [ext],
      }) as any;
      layer.supports32BitIndices = true;
      const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
      layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
      return layer;
    };
    const first = mount(DRIFT);
    const second = mount(PULSE);

    expect(first.handles.program).not.toBe(second.handles.program);
    const sources = vertexSources(gl);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toContain('[stt-ext] drift');
    expect(sources[0]).not.toContain('[stt-ext] pulse');
    expect(sources[1]).toContain('[stt-ext] pulse');
    expect(sources[1]).not.toContain('[stt-ext] drift');
  });

  it('END TO END: flipping extensions relinks once, and flipping back is a cache HIT', () => {
    const { layer, gl, draw } = makeLayerWithCache({ extensions: [DRIFT] });
    draw();
    const withDrift = layer.handles.program;
    expect(gl.createProgram).toHaveBeenCalledTimes(1);

    layer.setExtensions([PULSE]);
    draw();
    const withPulse = layer.handles.program;
    expect(withPulse).not.toBe(withDrift);
    expect(gl.createProgram).toHaveBeenCalledTimes(2);
    expect(vertexSources(gl)[1]).toContain('[stt-ext] pulse');

    // Flip back with an EQUAL-BY-CONTENT (not identical) extension: the
    // content-addressed key resolves to the program already linked.
    layer.setExtensions([{ ...DRIFT }]);
    draw();
    expect(layer.handles.program).toBe(withDrift);
    expect(gl.createProgram).toHaveBeenCalledTimes(2);
  });

  it('a flip re-records the tile VAO (attribute slots are per-program)', () => {
    const { layer, gl, cache, draw } = makeLayerWithCache({
      extensions: [DRIFT],
    });
    draw();
    expect(gl.createVertexArray).toHaveBeenCalledTimes(1);
    const firstVao = cache.vao;
    draw();
    expect(gl.createVertexArray).toHaveBeenCalledTimes(1); // steady state reuses

    layer.setExtensions([PULSE]);
    draw();
    expect(gl.deleteVertexArray).toHaveBeenCalledWith(firstVao);
    expect(gl.createVertexArray).toHaveBeenCalledTimes(2);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * (3) PICK PARITY.
 * ────────────────────────────────────────────────────────────────────────── */
describe('the id-pick program gets the same VERTEX seams', () => {
  it('a geometry-moving seam is spliced into both programs, before projection', () => {
    const chunks = chunksOf(DRIFT);
    const main = buildPointVertexSource(
      LEGACY_SHADER,
      cfg({ extensions: chunks }),
    );
    const id = buildPointIdVertexSource(
      LEGACY_SHADER,
      cfg({ extensions: chunks }),
    );
    const seam = spliceExtensionPosition(chunks, 'mercator');
    expect(seam).not.toBe('');
    for (const src of [main, id]) {
      expect(src).toContain(seam);
      expect(src).toContain('uniform vec2 uDrift;');
      // The seam must land BEFORE the projection, or only the drawn shape moves.
      expect(src.indexOf('sttExtPosition')).toBeLessThan(
        src.indexOf('gl_Position ='),
      );
    }
    // Identical seam text in both, not a second hand-written copy.
    expect(main.slice(main.indexOf('void main()'))).toContain(seam);
    expect(id.slice(id.indexOf('void main()'))).toContain(seam);
  });

  it('the id FRAGMENT stage takes no user text (an id must decode exactly)', () => {
    const { gl, pick } = makeLayerWithCache({ extensions: [TINT] });
    pick();
    // The id fragment stage is the one source that writes `vIdColor` without
    // reading geometry — `buildBillboardIdFragmentSource`, untouched by the
    // hook. Located by that signature rather than by index so the assertion
    // cannot pass by finding nothing.
    const idFragment = shaderSources(gl).filter((s) =>
      s.includes('gl_FragColor = vec4(vIdColor, 1.0)'),
    );
    expect(idFragment).toHaveLength(1);
    expect(idFragment[0]).toBe(buildBillboardIdFragmentSource('points'));
    expect(idFragment[0]).not.toContain('[stt-ext] tint');
    expect(idFragment[0]).not.toContain('sttExtColor');
    // …while the id VERTEX stage did take the extension's vertex-side pieces.
    const idVertex = shaderSources(gl).filter((s) => s.includes('aIdColor'));
    expect(idVertex).toHaveLength(1);
    expect(idVertex[0]).toContain('[stt-ext] tint');
  });

  it('the pick pass runs the SAME uniform hook (or the hit box drifts off the dot)', () => {
    const seen: Array<ExtensionDrawContext['pass']> = [];
    const spy: STTShaderExtension = {
      ...DRIFT,
      onBeforeDraw: (u, ctx) => {
        seen.push(ctx.pass);
        u.setVec2('uDrift', [7, 8]);
      },
    };
    const { gl, draw, pick } = makeLayerWithCache({ extensions: [spy] });
    draw();
    pick();
    expect(seen).toEqual(['draw', 'pick']);
    expect(uniformsByName(gl).get('uDrift')).toHaveLength(2);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * (4) NO WIDENING.
 * ────────────────────────────────────────────────────────────────────────── */
describe('an extension cannot widen visibility', () => {
  it('the shipped time gate multiplies the CLAMPED extension factor, last', () => {
    const chunks = chunksOf(PULSE);
    const src = buildPointVertexSource(
      LEGACY_SHADER,
      cfg({ extensions: chunks }),
    );
    expect(src).toContain(
      'vAlpha = (sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut)) * clamp(sttExtAlpha, 0.0, 1.0);',
    );
    // The snippet runs BEFORE that line — no user text after a gate.
    expect(src.indexOf('sttExtAlpha *= uPulse;')).toBeLessThan(
      src.indexOf('* clamp(sttExtAlpha, 0.0, 1.0);'),
    );
  });

  it('the DataFilter body still runs after the composed alpha, unchanged', () => {
    const chunks = chunksOf(PULSE);
    const src = buildPointVertexSource(
      LEGACY_SHADER,
      cfg({ filter: true, extensions: chunks }),
    );
    expect(src).toContain(`float filterAlpha = ${DATA_FILTER_CALL_GLSL};`);
    expect(src.indexOf('clamp(sttExtAlpha, 0.0, 1.0);')).toBeLessThan(
      src.indexOf('float filterAlpha ='),
    );
    // …and the filter's size transform still lands after the extension's, so a
    // hard-filtered point cannot be re-inflated by an extension.
    expect(src.indexOf('radiusPx *= sttExtSize;')).toBeLessThan(
      src.indexOf('radiusPx *= filterAlpha;'),
    );
  });

  it('numerically: the composed alpha never exceeds the shipped alpha', () => {
    for (const shipped of [0, 0.001, 0.5, 1]) {
      for (const ext of [-1e9, -1, 0, 0.5, 1, 2, 1e9]) {
        const composed = extensionAlphaJS(ext, shipped);
        expect(composed).toBeLessThanOrEqual(shipped);
        expect(composed).toBeGreaterThanOrEqual(0);
      }
    }
    // A fully time-filtered feature stays fully filtered whatever the snippet says.
    expect(extensionAlphaJS(1e9, 0)).toBe(0);
  });

  it('the fragment gate multiplies after the colour seam, and the discard precedes it', () => {
    const chunks = chunksOf(TINT);
    const fs = buildPointFragmentSource(chunks);
    expect(fs).toContain(
      'gl_FragColor = vec4(sttExtColor.rgb, sttExtColor.a * vAlpha * edge);',
    );
    // The seam BODY (not the declaration marker, which sits above main()).
    const seamAt = fs.indexOf('sttExtColor.rgb = sttTintMix(');
    expect(seamAt).toBeGreaterThan(-1);
    expect(fs.indexOf('if (vAlpha <= 0.0) discard;')).toBeLessThan(seamAt);
    expect(seamAt).toBeLessThan(fs.indexOf('gl_FragColor ='));
    // The fragment stage sees the extension's own declarations.
    expect(fs).toContain('uniform vec3 uTint;');
    expect(fs).toContain('varying float vTintMix;');
    expect(fs).toContain('vec3 sttTintMix(');
  });

  it('the uniform writer refuses names the extension did not declare', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const greedy: STTShaderExtension = {
      name: 'greedy',
      uniforms: 'uniform float uMine;',
      vertex: { alpha: '    sttExtAlpha *= uMine;' },
      onBeforeDraw: (u) => {
        u.setFloat('uMine', 0.5);
        // The layer's own gates — the whole point of the narrow writer.
        u.setFloat('uWindowStart', -1e9);
        u.setFloat('uWindowEnd', 1e9);
        u.setFloat('uFilterEnabled', 0);
      },
    };
    const { gl, draw } = makeLayerWithCache({ extensions: [greedy] });
    draw();
    draw();
    const u = uniformsByName(gl);
    expect(u.get('uMine')).toHaveLength(2);
    // uWindowStart was written twice — by the LAYER, with the real window.
    expect(u.get('uWindowStart')!.every(([v]) => v === -2500)).toBe(true);
    expect(u.get('uWindowEnd')!.every(([v]) => v === 2500)).toBe(true);
    // The refusal warns ONCE per (extension, name), not once per frame.
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0]![0]).toContain('greedy');
    warn.mockRestore();
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * The hook actually does something — composition, uniforms, attributes.
 * ────────────────────────────────────────────────────────────────────────── */
describe('the hook changes what is drawn', () => {
  it('every declaration block reaches the vertex stage in its own section', () => {
    const ext: STTShaderExtension = {
      name: 'full',
      attributes: '  attribute float aHeat;',
      uniforms: '  uniform float uHeat;',
      varyings: '  varying float vHeat;',
      vertexDeclarations: 'float sttHeat(float h) { return h * 2.0; }',
      vertex: { alpha: '    vHeat = sttHeat(aHeat * uHeat);' },
    };
    const src = buildPointVertexSource(
      LEGACY_SHADER,
      cfg({ extensions: chunksOf(ext) }),
    );
    expect(src).toContain('attribute float aHeat;');
    expect(src).toContain('uniform float uHeat;');
    expect(src).toContain('varying float vHeat;');
    expect(src).toContain('float sttHeat(float h)');
    // Declarations above main(), body inside it.
    expect(src.indexOf('float sttHeat(float h)')).toBeLessThan(
      src.indexOf('void main()'),
    );
    expect(src.indexOf('vHeat = sttHeat(')).toBeGreaterThan(
      src.indexOf('void main()'),
    );
    // An attribute goes to the vertex stage only.
    expect(buildPointFragmentSource(chunksOf(ext))).not.toContain('aHeat');
  });

  it('several extensions compose at one seam, in list order', () => {
    const first: STTShaderExtension = {
      name: 'first',
      vertex: { size: '    sttExtSize *= 2.0;' },
    };
    const second: STTShaderExtension = {
      name: 'second',
      vertex: { size: '    sttExtSize *= 3.0;' },
    };
    const seam = spliceExtensionSize(chunksOf(first, second), 'radiusPx');
    expect(seam.indexOf('*= 2.0;')).toBeLessThan(seam.indexOf('*= 3.0;'));
    expect(seam.startsWith('    float sttExtSize = 1.0;\n')).toBe(true);
    expect(seam.endsWith('    radiusPx *= sttExtSize;\n')).toBe(true);
  });

  it('uploads the extension uniform once per tile per pass, with the draw context', () => {
    const seen: ExtensionDrawContext[] = [];
    const ext: STTShaderExtension = {
      name: 'ctx',
      uniforms: 'uniform float uT;',
      vertex: { alpha: '    sttExtAlpha *= uT;' },
      onBeforeDraw: (u, ctx) => {
        // The context is a reused scratch — copy what you keep.
        seen.push({ ...ctx });
        u.setFloat('uT', ctx.currentTime - ctx.timeOffset);
      },
    };
    const { gl, tile, cache, draw } = makeLayerWithCache({ extensions: [ext] });
    draw();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.pass).toBe('draw');
    expect(seen[0]!.tileId).toEqual(tile.id);
    expect(seen[0]!.zoom).toBe(2);
    expect(seen[0]!.timeOffset).toBe(cache.timeOffset);
    expect(seen[0]!.vertexCount).toBe(cache.vertexCount);
    // Tile-relative, exactly like the layer's own time uniforms.
    expect(uniformsByName(gl).get('uT')![0]![0]).toBe(
      drawCtx().currentTime - cache.timeOffset,
    );
  });

  it('binds an extension-owned attribute buffer, and unbinds it after a PICK pass', () => {
    const gl = makeMockGl();
    // Distinct slots per attribute name so the cleanup assertion is meaningful
    // (the recorder hands out 0 for everything by default).
    const slots: Record<string, number> = {
      aMercator: 0,
      aTime: 1,
      aColor: 2,
      aRadius: 3,
      aIdColor: 4,
      aHeat: 5,
    };
    gl.getAttribLocation = vi.fn(
      (_p: unknown, name: string) => slots[name] ?? -1,
    );
    const buffer = {} as WebGLBuffer;
    const ext: STTShaderExtension = {
      name: 'heat',
      attributes: '  attribute float aHeat;',
      vertex: { alpha: '    sttExtAlpha *= aHeat;' },
      onBeforeDraw: (u) => u.setAttributeBuffer('aHeat', buffer, { size: 1 }),
    };
    const tile = makePointTile();
    const layer = new STTPointLayer({
      id: 'heat',
      url: 'mem://test.stt',
      currentTime: 1_700_000_001_000,
      timeWindow: 5000,
      extensions: [ext],
    }) as any;
    layer.supports32BitIndices = true;
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);

    layer.drawPickTile(gl, tile, tile.layers[0], cache, drawCtx(), 1);
    expect(gl.vertexAttribPointer).toHaveBeenCalledWith(
      5,
      1,
      gl.FLOAT,
      false,
      0,
      0,
    );
    // The pick path binds on the DEFAULT vertex array, so it must leave it clean.
    expect(gl.disableVertexAttribArray).toHaveBeenCalledWith(5);
  });

  it('refuses an attribute the extension did not declare', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ext: STTShaderExtension = {
      name: 'sneaky',
      vertex: { alpha: '    sttExtAlpha *= 1.0;' },
      onBeforeDraw: (u) =>
        u.setAttributeBuffer('aMercator', {} as WebGLBuffer, { size: 3 }),
    };
    const { gl, draw } = makeLayerWithCache({ extensions: [ext] });
    const before = gl.vertexAttribPointer.mock.calls.length;
    draw();
    // Only the layer's own binds happened; none of them came from the hook.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('aMercator');
    expect(gl.vertexAttribPointer.mock.calls.length).toBeGreaterThan(before);
    warn.mockRestore();
  });

  it('a stashed writer cannot write into a later frame', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let stashed: ExtensionUniformWriter | undefined;
    const ext: STTShaderExtension = {
      name: 'stash',
      uniforms: 'uniform float uLate;',
      vertex: { alpha: '    sttExtAlpha *= uLate;' },
      onBeforeDraw: (u) => {
        stashed = u;
        u.setFloat('uLate', 1);
      },
    };
    const { gl, draw } = makeLayerWithCache({ extensions: [ext] });
    draw();
    const before = uniformsByName(gl).get('uLate')!.length;
    stashed!.setFloat('uLate', 999);
    expect(uniformsByName(gl).get('uLate')!.length).toBe(before);
    warn.mockRestore();
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Declaration parsing — what the writer's allow-list is built from.
 * ────────────────────────────────────────────────────────────────────────── */
describe('parseDeclaredNames', () => {
  it('reads the plain forms: qualifiers, comma lists, arrays', () => {
    const names = parseDeclaredNames(
      `uniform float uA;
       uniform highp vec3 uB, uC;
       uniform vec2 uD[4];
       uniform sampler2D uTex;`,
      'uniform',
    );
    expect([...names].sort()).toEqual(['uA', 'uB', 'uC', 'uD', 'uTex']);
  });

  it('does not count a commented-out declaration', () => {
    const names = parseDeclaredNames(
      `// uniform float uGhost;
       /* uniform float uAlsoGhost; */
       uniform float uReal;`,
      'uniform',
    );
    expect([...names]).toEqual(['uReal']);
  });

  it('reads attributes under their own keyword only', () => {
    const glsl = 'attribute float aHeat;\nuniform float uHeat;';
    expect([...parseDeclaredNames(glsl, 'attribute')]).toEqual(['aHeat']);
    expect([...parseDeclaredNames(glsl, 'uniform')]).toEqual(['uHeat']);
    expect([...parseDeclaredNames(undefined, 'uniform')]).toEqual([]);
  });
});

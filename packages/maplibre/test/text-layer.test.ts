/**
 * STTTextLayer — time-filtered map labels: one instanced quad per character
 * over a caller-supplied font atlas.
 *
 * Coverage mirrors the sibling layer suites (`icon-layer.test.ts` is the
 * template): the CPU stages that have EXACT answers — code-point packing, glyph
 * layout, the per-glyph fan-out — are pinned against hand-computed constants,
 * shader sources are asserted at the STRING level on BOTH host variants (a gate
 * that lands on only one of them is a globe-only bug), and the draw paths run
 * through the mock-GL recorder. Real GLSL compilation, the atlas texture upload
 * and the FBO readback stay browser-verify-only.
 *
 * The load-bearing invariant this file exists to protect: instances are per
 * CHARACTER but provenance is per FEATURE, so a pick anywhere on a label
 * resolves to that label's row.
 */

import { describe, it, expect, vi } from 'vitest';
import { GeometryType, type Tile, type Layer } from '@poopdeck.gl/core';
import { decodePickId } from '@poopdeck.gl/core/picking';
import { normalizeRenderArgs } from '../src/lib/host-adapter';
import {
  STTTextLayer,
  buildTextVertexSource,
  buildTextIdVertexSource,
  buildTileCodePoints,
  expandBytesPerGlyph,
  layoutTileGlyphs,
  packCodePoints,
  resolveTextTimeFilterMode,
  textProgramKey,
  type GlyphMappingEntry,
  type TextShaderConfig,
} from '../src/layers/text-layer';
import {
  buildGlyphFragmentSource,
  glyphCoverageRef,
} from '../src/shaders/text-glyph.glsl';
import { DATA_FILTER_CALL_GLSL } from '../src/shaders/data-filter.glsl';
import { wakeSizeScaleJS } from '../src/shaders/time-window.glsl';
import { makeMockGl, makeMockMap, publishVisibleTiles } from './mock-gl';

const TIME_OFFSET = 1_700_000_000_000;

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: TIME_OFFSET + 1000,
  timeWindow: 5000,
};

/**
 * A 64×64 atlas holding three glyphs. `C` deliberately omits `advance` so the
 * "advance falls back to width" rule has a witness; `B` carries a bearing so
 * `xOffset`/`yOffset` are exercised separately from the pen.
 */
const ATLAS = { width: 64, height: 64 };
const MAPPING: Record<string, GlyphMappingEntry> = {
  A: { x: 0, y: 0, width: 10, height: 20, advance: 12 },
  B: { x: 10, y: 0, width: 8, height: 20, advance: 10, xOffset: 1, yOffset: 2 },
  C: { x: 18, y: 0, width: 12, height: 20 },
};

const atlasOpts = { fontAtlas: ATLAS, fontMapping: MAPPING };

/** Default layout knobs, matching the layer's own option defaults. */
const layoutOpts = {
  mapping: MAPPING,
  fontSize: 64,
  lineHeight: 1.2,
  anchorX: 'middle' as const,
  anchorY: 'center' as const,
};

/** `fontSize * lineHeight` — the vertical advance every golden below uses. */
const LINE_STEP = 64 * 1.2;

const PRELUDE_MARKER = '// __HOST_PRELUDE__';
const PRELUDE = `${PRELUDE_MARKER}\nvec4 projectTile(vec2 p) { return vec4(p, 0.0, 1.0); }`;
const LEGACY_SHADER = { prelude: '', define: '' };
const V5_SHADER = { prelude: PRELUDE, define: '#define GLOBE' };

const cfg = (over: Partial<TextShaderConfig> = {}): TextShaderConfig => ({
  mode: 'window',
  filter: false,
  sdf: true,
  ...over,
});

/** Both host variants of one configuration, for "identical in both" checks. */
const bothVariants = (
  build: (s: typeof LEGACY_SHADER, c: TextShaderConfig) => string,
  c: TextShaderConfig,
): [string, string] => [build(LEGACY_SHADER, c), build(V5_SHADER, c)];

const legacyFrame = () => normalizeRenderArgs(new Float32Array(16));

const drawCtx = (frame?: ReturnType<typeof normalizeRenderArgs>) => ({
  matrix: frame ? frame.matrix : new Float32Array(16),
  frame,
  windowStart: 0,
  windowEnd: 10_000,
  currentTime: baseOpts.currentTime,
  zoom: 2,
});

/**
 * Two labelled points: row 0 says `AB` (two glyphs), row 1 says `C` (one), so
 * every fan-out assertion has an UNEVEN split to fail on.
 */
function makeLabelTile(x = 1): Tile {
  const positions = new Float64Array([-122.4, 37.7, -73.95, 40.75]);
  const features = {
    featureCount: 2,
    geometryType: GeometryType.Point,
    positionDimensions: 2 as const,
    positions,
    featureIds: new Uint32Array([0, 1]),
    startTimes: new Float32Array([0, 1000]),
    endTimes: new Float32Array([5000, 6000]),
    timeOffset: TIME_OFFSET,
    numericProps: {
      magnitude: new Float32Array([2, 8]),
      heading: new Float32Array([30, 90]),
    },
    categoricalProps: {
      label: { indices: new Uint16Array([0, 1]), categories: ['AB', 'C'] },
      kind: { indices: new Uint16Array([0, 1]), categories: ['x', 'y'] },
    },
  };
  const layer: Layer = {
    name: 'labels',
    extent: 4096,
    features,
    geometryExtensionName: 'geoarrow.point',
  };
  return {
    id: { z: 2, x, y: 1, t: TIME_OFFSET },
    timeRange: { start: TIME_OFFSET, end: TIME_OFFSET + 6000 },
    layers: [layer],
  };
}

// Unpack pixel-store parameters, as literals (the recorder declares only the
// constants the layers use). `getParameter` returns a BOOLEAN for both.
const UNPACK_FLIP_Y_WEBGL = 0x9240;
const UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0x9241;

/**
 * Teach a recorder about unpack pixel-store state — the one piece of GL state
 * the atlas upload shares with the host and must hand back. The recorder does
 * not model it, so the state lives here and `getParameter` falls through to the
 * recorder for everything else (the capability probes still answer normally).
 */
function withUnpackState(gl: any): Map<number, boolean> {
  const state = new Map<number, boolean>([
    [UNPACK_FLIP_Y_WEBGL, false],
    [UNPACK_PREMULTIPLY_ALPHA_WEBGL, true],
  ]);
  gl.pixelStorei = vi.fn((param: number, value: boolean) => {
    state.set(param, value);
  });
  const inner = gl.getParameter;
  gl.getParameter = vi.fn((param: number) =>
    state.has(param) ? state.get(param) : inner?.(param),
  );
  return state;
}

/** Wire the GL capability stubs the direct-hook tests bypass (onAdd does it). */
function stubCaps(layer: any, gl: any): void {
  withUnpackState(gl);
  layer.supports32BitIndices = true;
  layer.vaoSupport = {
    enabled: true,
    create: () => gl.createVertexArray(),
    bind: (vao: unknown) => gl.bindVertexArray(vao),
    delete: (vao: unknown) => gl.deleteVertexArray(vao),
    current: () => null,
  };
  layer.instSupport = {
    enabled: true,
    drawArraysInstanced: vi.fn(
      (mode: number, first: number, count: number, prim: number) =>
        gl.drawArraysInstanced(mode, first, count, prim),
    ),
    drawElementsInstanced: vi.fn(),
    vertexAttribDivisor: vi.fn(),
  };
}

function makeLayerWithCache(
  extra: Record<string, unknown> = {},
  tile = makeLabelTile(),
) {
  const layer = new STTTextLayer({
    ...baseOpts,
    ...atlasOpts,
    id: 'labels',
    textProperty: 'label',
    ...extra,
  }) as any;
  const gl = makeMockGl();
  stubCaps(layer, gl);
  const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
  return { layer, gl, tile, cache };
}

/** A layer wired for a full `render()` pass over a hand-placed resident set. */
function makeRenderableLayer(extra: Record<string, unknown>, tiles: Tile[]) {
  const layer = new STTTextLayer({
    ...baseOpts,
    ...atlasOpts,
    id: 'labels',
    textProperty: 'label',
    ...extra,
  }) as any;
  const gl = makeMockGl();
  stubCaps(layer, gl);
  layer.map = makeMockMap();
  publishVisibleTiles(layer, ...tiles);
  return { layer, gl };
}

const vertexSources = (gl: any): string[] =>
  gl.shaderSource.mock.calls.map((c: unknown[]) => c[1] as string);

/** Uniform uploads keyed by NAME (the mock hands out one handle per lookup). */
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

/** Every array handed to `bufferData`, in call order. */
const uploads = (gl: any): unknown[] =>
  gl.bufferData.mock.calls.map((c: unknown[]) => c[1]);

// ── code-point packing ──────────────────────────────────────────────────────

describe('packCodePoints', () => {
  it('packs a flat UTF-32 buffer plus per-row offsets', () => {
    const { codePoints, offsets } = packCodePoints(['AB', '', 'C']);
    expect(Array.from(codePoints)).toEqual([0x41, 0x42, 0x43]);
    expect(Array.from(offsets)).toEqual([0, 2, 2, 3]);
  });

  it('decodes surrogate pairs to ONE code point, not two halves', () => {
    // U+1F600 is a surrogate pair in UTF-16; a UTF-16-unit walk would emit two
    // entries and look up two glyphs that do not exist.
    const { codePoints, offsets } = packCodePoints(['a\u{1F600}b']);
    expect(Array.from(codePoints)).toEqual([0x61, 0x1f600, 0x62]);
    expect(Array.from(offsets)).toEqual([0, 3]);
  });

  it('offsets are cumulative and end at the total length', () => {
    const { codePoints, offsets } = packCodePoints(['xx', 'yyy', 'z']);
    expect(offsets[offsets.length - 1]).toBe(codePoints.length);
  });
});

describe('buildTileCodePoints', () => {
  const catFeatures = {
    categoricalProps: {
      label: { indices: new Uint16Array([0, 1, 0]), categories: ['AB', 'C'] },
    },
  } as any;

  it('expands a dictionary column into per-ROW spans', () => {
    const p = buildTileCodePoints(catFeatures, 3, 'label', '');
    expect(Array.from(p.offsets)).toEqual([0, 2, 3, 5]);
    expect(Array.from(p.codePoints)).toEqual([0x41, 0x42, 0x43, 0x41, 0x42]);
  });

  it('falls back to the constant text for NULL category entries', () => {
    const withNull = {
      categoricalProps: {
        label: {
          indices: new Uint16Array([0, 0xffff]),
          categories: ['AB'],
        },
      },
    } as any;
    const p = buildTileCodePoints(withNull, 2, 'label', 'C');
    expect(Array.from(p.offsets)).toEqual([0, 2, 3]);
    expect(p.codePoints[2]).toBe(0x43);
  });

  it('uses the constant text for every row when no column is named', () => {
    const p = buildTileCodePoints(catFeatures, 2, undefined, 'AB');
    expect(Array.from(p.offsets)).toEqual([0, 2, 4]);
    expect(Array.from(p.codePoints)).toEqual([0x41, 0x42, 0x41, 0x42]);
  });

  it('a missing column degrades to the constant text, never throws', () => {
    const p = buildTileCodePoints(catFeatures, 2, 'nope', 'A');
    expect(Array.from(p.offsets)).toEqual([0, 1, 2]);
    expect(Array.from(p.codePoints)).toEqual([0x41, 0x41]);
  });
});

// ── glyph layout ────────────────────────────────────────────────────────────

describe('layoutTileGlyphs', () => {
  const layoutOf = (labels: string[], over: Partial<typeof layoutOpts> = {}) =>
    layoutTileGlyphs(packCodePoints(labels), labels.length, {
      ...layoutOpts,
      ...over,
    });

  it('anchors the ROW and advances glyphs within it (middle/center golden)', () => {
    const { glyphs, counts, total } = layoutOf(['AB', 'C']);
    expect(Array.from(counts)).toEqual([2, 1]);
    expect(total).toBe(3);

    // Row 0 line width = advance(A)=12 + advance(B)=10 = 22 ⇒ pen starts -11.
    // Vertical: one line, center ⇒ blockTop = -0.5 * 1 * 76.8 = -38.4.
    expect(glyphs[4]).toBeCloseTo(-11, 6); // A offsetX
    expect(glyphs[5]).toBeCloseTo(-LINE_STEP / 2, 4); // A offsetY (f32)
    // B carries a bearing: pen (-11 + 12) plus xOffset 1, and yOffset 2.
    expect(glyphs[10]).toBeCloseTo(1 + 1, 6);
    expect(glyphs[11]).toBeCloseTo(-LINE_STEP / 2 + 2, 4);
    // Row 1: 'C' has no advance ⇒ falls back to width 12 ⇒ pen starts -6.
    expect(glyphs[16]).toBeCloseTo(-6, 6);
  });

  it('carries the atlas rect through verbatim', () => {
    const { glyphs } = layoutOf(['AB']);
    expect(Array.from(glyphs.slice(0, 4))).toEqual([0, 0, 10, 20]);
    expect(Array.from(glyphs.slice(6, 10))).toEqual([10, 0, 8, 20]);
  });

  it('start/top anchoring puts the run at the anchor exactly', () => {
    const { glyphs } = layoutOf(['AB'], { anchorX: 'start', anchorY: 'top' });
    expect(glyphs[4]).toBeCloseTo(0, 6);
    expect(glyphs[5]).toBeCloseTo(0, 6);
  });

  it('end/bottom anchoring puts the run entirely before the anchor', () => {
    const { glyphs } = layoutOf(['AB'], { anchorX: 'end', anchorY: 'bottom' });
    expect(glyphs[4]).toBeCloseTo(-22, 6);
    expect(glyphs[5]).toBeCloseTo(-LINE_STEP, 4);
  });

  it('breaks lines on \\n and re-anchors each line independently', () => {
    const { glyphs, counts } = layoutOf(['A\nB']);
    expect(Array.from(counts)).toEqual([2]);
    // Two lines ⇒ blockTop = -76.8; line 0 at -76.8, line 1 at 0.
    expect(glyphs[5]).toBeCloseTo(-LINE_STEP, 4);
    expect(glyphs[11]).toBeCloseTo(0 + 2, 4);
    // Each line centres on ITS own width: 12 and 10.
    expect(glyphs[4]).toBeCloseTo(-6, 6);
    expect(glyphs[10]).toBeCloseTo(-5 + 1, 6);
  });

  it('swallows CR so CRLF data lays out like LF data', () => {
    expect(layoutOf(['A\r\nB']).glyphs).toEqual(layoutOf(['A\nB']).glyphs);
  });

  it('skips characters the mapping lacks — no instance AND no advance', () => {
    const { glyphs, counts, total } = layoutOf(['AZ']);
    expect(Array.from(counts)).toEqual([1]);
    expect(total).toBe(1);
    // Line width is A's advance alone, so A still centres at -6.
    expect(glyphs[4]).toBeCloseTo(-6, 6);
  });

  it('an empty label contributes no glyphs but still holds its counts slot', () => {
    const { counts, total } = layoutOf(['', 'A']);
    expect(Array.from(counts)).toEqual([0, 1]);
    expect(total).toBe(1);
  });
});

describe('expandBytesPerGlyph', () => {
  it("repeats each feature colour across exactly that feature's glyphs", () => {
    const perFeature = new Uint8Array([1, 2, 3, 4, 9, 9, 9, 9]);
    const out = expandBytesPerGlyph(perFeature, 4, new Uint32Array([2, 1]), 3);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 1, 2, 3, 4, 9, 9, 9, 9]);
  });
});

// ── time-mode degradation ───────────────────────────────────────────────────

describe('resolveTextTimeFilterMode', () => {
  it('honours an explicit mode, degrading a zero-length wake/trail', () => {
    expect(resolveTextTimeFilterMode('cumulative', 0, 0)).toBe('cumulative');
    expect(resolveTextTimeFilterMode('window', 500, 500)).toBe('window');
    expect(resolveTextTimeFilterMode('wake', 500, 0)).toBe('wake');
    expect(resolveTextTimeFilterMode('wake', 0, 0)).toBe('window');
    expect(resolveTextTimeFilterMode('trail', 0, 500)).toBe('trail');
    expect(resolveTextTimeFilterMode('trail', 0, 0)).toBe('window');
  });

  it("unset applies deck's wake-over-trail precedence", () => {
    expect(resolveTextTimeFilterMode(undefined, 500, 500)).toBe('wake');
    expect(resolveTextTimeFilterMode(undefined, 0, 500)).toBe('trail');
    expect(resolveTextTimeFilterMode(undefined, 0, 0)).toBe('window');
  });
});

// ── shader sources ──────────────────────────────────────────────────────────

describe('text vertex-source builder', () => {
  it('legacy variant projects the anchor through uMatrix', () => {
    const src = buildTextVertexSource(LEGACY_SHADER, cfg());
    expect(src).toContain('uniform mat4 uMatrix;');
    expect(src).toContain('uMatrix * vec4(mercator.x, mercator.y, 0.0, 1.0)');
    expect(src).not.toContain('projectTile');
    expect(src).not.toContain(PRELUDE_MARKER);
  });

  it('v5 variant prepends prelude then define and projects through projectTile', () => {
    const src = buildTextVertexSource(V5_SHADER, cfg());
    expect(src.indexOf(PRELUDE_MARKER)).toBeLessThan(
      src.indexOf('#define GLOBE'),
    );
    expect(src).toContain('projectTile(mercator.xy)');
    expect(src).not.toContain('uniform mat4 uMatrix;');
  });

  it('every variant dequantizes positions through the shared chunk', () => {
    for (const src of bothVariants(buildTextVertexSource, cfg())) {
      expect(src).toContain(
        'sttDecodeMercatorPos(aMercator, uPosScale, uPosOffset)',
      );
    }
  });

  it('rotates the glyph OFFSET, so a row stays rigid under an angle', () => {
    for (const src of bothVariants(buildTextVertexSource, cfg())) {
      expect(src).toContain(
        'vec2 layoutPx = (aGlyphOffset + glyphPx) * scale;',
      );
      expect(src).toContain(
        'vec2 offsetPx = vec2(ca * layoutPx.x + sa * layoutPx.y, sa * layoutPx.x - ca * layoutPx.y);',
      );
    }
  });

  it('compiles exactly one time kernel, chosen by mode', () => {
    const window = buildTextVertexSource(LEGACY_SHADER, cfg());
    expect(window).toContain('sttTimeWindowAlpha(aTime, uWindowStart');
    expect(window).not.toContain('sttWakeAlpha');

    const wake = buildTextVertexSource(LEGACY_SHADER, cfg({ mode: 'wake' }));
    expect(wake).toContain('sttWakeAlpha(aTime, uCurrentTime, uWakeLength)');
    expect(wake).not.toContain('sttTimeWindowAlpha');

    const cumulative = buildTextVertexSource(
      LEGACY_SHADER,
      cfg({ mode: 'cumulative' }),
    );
    expect(cumulative).toContain(
      'sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn)',
    );

    const trail = buildTextVertexSource(LEGACY_SHADER, cfg({ mode: 'trail' }));
    expect(trail).toContain(
      'sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail)',
    );
  });

  it('only wake mode tapers the size, and it reuses the kernel alpha', () => {
    const wake = buildTextVertexSource(LEGACY_SHADER, cfg({ mode: 'wake' }));
    expect(wake).toContain(
      'sizePx *= sttWakeSizeScale(vAlpha, uWakeTailScale);',
    );
    for (const mode of ['window', 'cumulative', 'trail'] as const) {
      expect(buildTextVertexSource(LEGACY_SHADER, cfg({ mode }))).not.toContain(
        'sttWakeSizeScale',
      );
    }
  });

  it('clamps the BASE size before the taper, so sizeMinPixels cannot cancel it', () => {
    const src = buildTextVertexSource(LEGACY_SHADER, cfg({ mode: 'wake' }));
    expect(
      src.indexOf('clamp(sizePx, uSizeMinPixels, uSizeMaxPixels)'),
      // The kernel DECLARES sttWakeSizeScale above main(); the ordering that
      // matters is the clamp vs the CALL site.
    ).toBeLessThan(src.indexOf('sizePx *= sttWakeSizeScale'));
  });

  it('splices the DataFilter kernel only when the filter is compiled', () => {
    const off = buildTextVertexSource(LEGACY_SHADER, cfg());
    expect(off).not.toContain(DATA_FILTER_CALL_GLSL);
    expect(off).not.toContain('attribute float aFilterValue;');

    for (const src of bothVariants(
      buildTextVertexSource,
      cfg({ filter: true }),
    )) {
      expect(src).toContain(DATA_FILTER_CALL_GLSL);
      expect(src).toContain('uFilterTransformSize');
      expect(src).toContain('if (filterAlpha <= 0.0) gl_Position = vec4(0.0);');
    }
  });

  it('declares the SDF gamma varying only in the SDF variant', () => {
    expect(buildTextVertexSource(LEGACY_SHADER, cfg())).toContain(
      'varying float vGamma;',
    );
    expect(
      buildTextVertexSource(LEGACY_SHADER, cfg({ sdf: false })),
    ).not.toContain('vGamma');
  });

  it('the id variant adds the id attribute/varying and nothing else', () => {
    const main = buildTextVertexSource(LEGACY_SHADER, cfg());
    const id = buildTextIdVertexSource(LEGACY_SHADER, cfg());
    expect(id).toContain('attribute vec3 aIdColor;');
    expect(id).toContain('varying vec3 vIdColor;');
    expect(id).toContain('vIdColor = aIdColor;');
    expect(main).not.toContain('aIdColor');
    // The geometry and the gates are byte-identical: strip the id lines and the
    // two sources must agree.
    const strip = (s: string) =>
      s
        .split('\n')
        .filter((l) => !l.includes('IdColor'))
        .join('\n');
    expect(strip(id)).toBe(strip(main));
  });
});

describe('glyph fragment stage', () => {
  it('the visual and id stages gate on the SAME composed alpha', () => {
    for (const sdf of [true, false]) {
      const main = buildGlyphFragmentSource('main', sdf);
      const id = buildGlyphFragmentSource('id', sdf);
      for (const src of [main, id]) {
        expect(src).toContain('if (vAlpha <= 0.0) discard;');
        expect(src).toContain('float a = cover * vColor.a * vAlpha;');
        expect(src).toContain('if (a < uAlphaCutoff) discard;');
      }
      expect(id).toContain('gl_FragColor = vec4(vIdColor, 1.0);');
      expect(id).not.toContain('uOutlineColor.rgb, vColor.rgb');
    }
  });

  it('only the SDF variant thresholds the field', () => {
    expect(buildGlyphFragmentSource('main', true)).toContain(
      'sttGlyphCoverage(dist, uSdfBuffer, vGamma)',
    );
    const bitmap = buildGlyphFragmentSource('main', false);
    expect(bitmap).not.toContain('sttGlyphCoverage');
    expect(bitmap).toContain('float cover = texture2D(uAtlas, vUv).a;');
  });
});

describe('glyphCoverageRef', () => {
  it('is GLSL smoothstep: clamped, 0/1 outside the band, 0.5 at centre', () => {
    expect(glyphCoverageRef(0.5, 0.75, 0.1)).toBe(0);
    expect(glyphCoverageRef(1, 0.75, 0.1)).toBe(1);
    expect(glyphCoverageRef(0.75, 0.75, 0.1)).toBeCloseTo(0.5, 12);
    // Hand-computed: t = 0.75 ⇒ t²(3-2t) = 0.5625 * 1.5 = 0.84375.
    expect(glyphCoverageRef(0.8, 0.75, 0.1)).toBeCloseTo(0.84375, 12);
  });

  it('a zero gamma is a hard step, not a divide by zero', () => {
    expect(glyphCoverageRef(0.74, 0.75, 0)).toBe(0);
    expect(glyphCoverageRef(0.75, 0.75, 0)).toBe(1);
  });
});

describe('textProgramKey', () => {
  it('carries every compiled axis, so no two configurations collide', () => {
    const keys = new Set<string>();
    for (const pass of ['main', 'pick'] as const) {
      for (const mode of ['window', 'wake', 'cumulative', 'trail'] as const) {
        for (const filter of [false, true]) {
          for (const sdf of [false, true]) {
            keys.add(textProgramKey(pass, { mode, filter, sdf }));
          }
        }
      }
    }
    expect(keys.size).toBe(2 * 4 * 2 * 2);
  });
});

// ── tile upload ─────────────────────────────────────────────────────────────

describe('tile upload', () => {
  it('vertexCount is the FEATURE count and glyphCount the INSTANCE count', () => {
    const { cache } = makeLayerWithCache();
    // 'AB' + 'C' ⇒ 3 glyphs over 2 features.
    expect(cache.vertexCount).toBe(2);
    expect(cache.glyphCount).toBe(3);
    expect(Array.from(cache.glyphCounts)).toEqual([2, 1]);
  });

  it('fans per-feature times out to per-glyph instances', () => {
    const { gl, cache } = makeLayerWithCache();
    const times = uploads(gl).find(
      (d): d is Float32Array =>
        d instanceof Float32Array && d.length === cache.glyphCount * 2,
    )!;
    // Row 0 (start 0, end 5000) twice, then row 1 (1000, 6000) once.
    expect(Array.from(times)).toEqual([0, 5000, 0, 5000, 1000, 6000]);
  });

  it('uploads the interleaved stride-6 glyph buffer', () => {
    const { gl, cache } = makeLayerWithCache();
    const glyphs = uploads(gl).find(
      (d): d is Float32Array =>
        d instanceof Float32Array && d.length === cache.glyphCount * 6,
    )!;
    expect(glyphs.slice(0, 4)).toEqual(new Float32Array([0, 0, 10, 20]));
  });

  it('fans a per-feature colour column out per glyph', () => {
    const { gl, cache } = makeLayerWithCache({ colorProperty: 'kind' });
    expect(cache.colorBuffer).toBeDefined();
    const colors = uploads(gl).find(
      (d): d is Uint8Array =>
        d instanceof Uint8Array && d.length === cache.glyphCount * 4,
    )!;
    // Row 0's two glyphs share one colour; row 1's differs.
    expect(Array.from(colors.slice(0, 4))).toEqual(
      Array.from(colors.slice(4, 8)),
    );
    expect(Array.from(colors.slice(8, 12))).not.toEqual(
      Array.from(colors.slice(0, 4)),
    );
  });

  it('fans size and angle columns out per glyph', () => {
    const { gl, cache } = makeLayerWithCache({
      sizeProperty: 'magnitude',
      angleProperty: 'heading',
    });
    expect(cache.sizeBuffer).toBeDefined();
    expect(cache.angleBuffer).toBeDefined();
    const singles = uploads(gl).filter(
      (d): d is Float32Array =>
        d instanceof Float32Array && d.length === cache.glyphCount,
    );
    expect(singles.some((a) => Array.from(a).join() === '2,2,8')).toBe(true);
    expect(singles.some((a) => Array.from(a).join() === '30,30,90')).toBe(true);
  });

  it('fans the DataFilter column out per glyph and records hasColumn', () => {
    const { gl, cache } = makeLayerWithCache({
      filterProperty: 'magnitude',
      filterRange: [0, 10] as [number, number],
    });
    expect(cache.hasFilterColumn).toBe(true);
    const filt = uploads(gl).filter(
      (d): d is Float32Array =>
        d instanceof Float32Array && d.length === cache.glyphCount,
    );
    expect(filt.some((a) => Array.from(a).join() === '2,2,8')).toBe(true);
  });

  it('every extra buffer is registered so the base can free it', () => {
    const { cache } = makeLayerWithCache({
      colorProperty: 'kind',
      sizeProperty: 'magnitude',
      angleProperty: 'heading',
    });
    for (const b of [
      cache.glyphBuffer,
      cache.colorBuffer,
      cache.sizeBuffer,
      cache.angleBuffer,
    ]) {
      expect(cache.extraBuffers).toContain(b);
    }
  });

  it('a tile whose labels resolve to no glyphs caches as a permanent no-op', () => {
    const tile = makeLabelTile();
    (tile.layers[0].features as any).categoricalProps.label = {
      indices: new Uint16Array([0, 0]),
      categories: ['???'],
    };
    const { cache } = makeLayerWithCache({}, tile);
    expect(cache).toBeNull();
  });

  it('no fontMapping means no geometry at all', () => {
    const { cache } = makeLayerWithCache({ fontMapping: null });
    expect(cache).toBeNull();
  });
});

// ── draw ────────────────────────────────────────────────────────────────────

describe('drawTile', () => {
  it('draws ONE instanced quad per character', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.drawCalls).toEqual([
      { kind: 'arrays-instanced', count: 12, vertices: 4, instances: 3 },
    ]);
  });

  it('uploads window uniforms tile-relative and the atlas size', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uWindowStart')).toBe(0);
    expect(lastScalar(u, 'uWindowEnd')).toBe(10_000);
    expect(u.get('uAtlasSize')?.at(-1)).toEqual([64, 64]);
    expect(lastScalar(u, 'uFontSize')).toBe(64);
  });

  it('uploads uCurrentTime relative to the tile, never absolute', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      timeFilterMode: 'wake',
      wakeLength: 2000,
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uCurrentTime')).toBe(
      baseOpts.currentTime - cache.timeOffset,
    );
    expect(lastScalar(u, 'uWakeLength')).toBe(2000);
    expect(lastScalar(u, 'uWakeTailScale')).toBeTypeOf('number');
    // The taper the shader applies is the shared JS reference's.
    expect(wakeSizeScaleJS(1, 0.15)).toBeCloseTo(1, 12);
  });

  it('outlineWidth 0 makes the outline threshold equal the fill threshold', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uOutlineBuffer')).toBe(lastScalar(u, 'uSdfBuffer'));
  });

  it('an outline dilates the glyph (a LOWER threshold on the same field)', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      outlineWidth: 0.5,
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uOutlineBuffer')).toBeLessThan(
      lastScalar(u, 'uSdfBuffer') as number,
    );
  });

  it('re-records the VAO when the compiled mode moves, and only then', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.createVertexArray).toHaveBeenCalledTimes(1);
    expect(gl.deleteVertexArray).not.toHaveBeenCalled();

    layer.setTimeFilterMode('cumulative');
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.deleteVertexArray).toHaveBeenCalledTimes(1);
    expect(gl.createVertexArray).toHaveBeenCalledTimes(2);
  });

  it('compiles one program per (mode, host variant) and caches it', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const windowVs = vertexSources(gl).filter((s) =>
      s.includes('sttTimeWindowAlpha'),
    );
    expect(windowVs).toHaveLength(1);
  });

  it('renders every resident tile through the base loop', () => {
    const tiles = [makeLabelTile(1), makeLabelTile(2)];
    const { layer, gl } = makeRenderableLayer({}, tiles);
    layer.render(gl, new Float32Array(16));
    expect(gl.drawCalls).toHaveLength(2);
    expect(gl.drawCalls[0].instances).toBe(3);
  });

  it('metric sizing folds a per-tile factor into uSizeScale', () => {
    const pixels = makeLayerWithCache();
    pixels.layer.drawTile(
      pixels.gl,
      pixels.tile,
      pixels.tile.layers[0],
      pixels.cache,
      drawCtx(legacyFrame()),
    );
    const meters = makeLayerWithCache({ sizeUnits: 'meters' });
    meters.layer.drawTile(
      meters.gl,
      meters.tile,
      meters.tile.layers[0],
      meters.cache,
      drawCtx(legacyFrame()),
    );
    expect(lastScalar(uniformsByName(pixels.gl), 'uSizeScale')).toBe(1);
    const metric = lastScalar(
      uniformsByName(meters.gl),
      'uSizeScale',
    ) as number;
    expect(metric).toBeGreaterThan(0);
    expect(metric).not.toBe(1);
  });
});

describe('missing atlas', () => {
  it('draws NOTHING and warns exactly once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { layer, gl, tile, cache } = makeLayerWithCache({ fontAtlas: null });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.drawCalls).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('fontAtlas');
    warn.mockRestore();
  });
});

// ── picking ─────────────────────────────────────────────────────────────────

describe('drawPickTile', () => {
  /** The id-colour buffer the pick pass uploads: 3 bytes per GLYPH. */
  const idColors = (gl: any, glyphs: number): Uint8Array =>
    uploads(gl)
      .filter(
        (d): d is Uint8Array =>
          d instanceof Uint8Array && d.length === glyphs * 3,
      )
      .at(-1)!;

  it('paints every glyph of a row the SAME id — provenance is per feature', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    const ids = idColors(gl, 3);
    expect(decodePickId([ids[0], ids[1], ids[2]])).toBe(1);
    expect(decodePickId([ids[3], ids[4], ids[5]])).toBe(1);
    expect(decodePickId([ids[6], ids[7], ids[8]])).toBe(2);
  });

  it('honours idBase, so a second tile continues the 1-based range', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      7,
    );
    const ids = idColors(gl, 3);
    expect(decodePickId([ids[0], ids[1], ids[2]])).toBe(7);
    expect(decodePickId([ids[6], ids[7], ids[8]])).toBe(8);
  });

  it('draws the same instance count as the visual pass', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const visual = gl.drawCalls.at(-1);
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    expect(gl.drawCalls.at(-1)).toEqual(visual);
  });

  it('sets the SAME gating uniforms as the visual pass', () => {
    const visual = makeLayerWithCache({
      timeFilterMode: 'trail',
      trailLength: 3000,
    });
    visual.layer.drawTile(
      visual.gl,
      visual.tile,
      visual.tile.layers[0],
      visual.cache,
      drawCtx(legacyFrame()),
    );
    const pick = makeLayerWithCache({
      timeFilterMode: 'trail',
      trailLength: 3000,
    });
    pick.layer.drawPickTile(
      pick.gl,
      pick.tile,
      pick.tile.layers[0],
      pick.cache,
      drawCtx(legacyFrame()),
      1,
    );
    const uv = uniformsByName(visual.gl);
    const up = uniformsByName(pick.gl);
    for (const name of [
      'uCurrentTime',
      'uTrailLength',
      'uFadeTrail',
      'uAlphaCutoff',
      'uSizeScale',
      'uSizeMinPixels',
      'uSizeMaxPixels',
      'uFontSize',
      'uSdfBuffer',
    ]) {
      expect([name, lastScalar(up, name)]).toEqual([
        name,
        lastScalar(uv, name),
      ]);
    }
  });

  it('releases the id buffer and resets every divisor it touched', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(1);
    const divisors = layer.instSupport.vertexAttribDivisor.mock.calls;
    expect(divisors.some((c: unknown[]) => c[1] === 0)).toBe(true);
  });
});

// ── defaults ────────────────────────────────────────────────────────────────

describe('defaults are the pre-campaign behaviour', () => {
  it('window mode, SDF sampling, no filter, no outline', () => {
    const layer = new STTTextLayer({
      ...baseOpts,
      ...atlasOpts,
      id: 'labels',
    }) as any;
    expect(layer.shaderConfig).toEqual({
      mode: 'window',
      filter: false,
      sdf: true,
    });
    expect(layer.textOpts.outlineWidth).toBe(0);
    expect(layer.textOpts.anchorX).toBe('middle');
    expect(layer.textOpts.anchorY).toBe('center');
    expect(layer.textOpts.fontSize).toBe(64);
    expect(layer.textOpts.size).toBe(16);
    expect(layer.textOpts.sizeUnits).toBe('pixels');
  });

  it('an explicitly undefined option still lands on the default', () => {
    const layer = new STTTextLayer({
      ...baseOpts,
      ...atlasOpts,
      id: 'labels',
      size: undefined,
      lineHeight: undefined,
      anchorX: undefined,
    }) as any;
    expect(layer.textOpts.size).toBe(16);
    expect(layer.textOpts.lineHeight).toBe(1.2);
    expect(layer.textOpts.anchorX).toBe('middle');
  });

  it('0 and false are honoured, never replaced by the default', () => {
    const layer = new STTTextLayer({
      ...baseOpts,
      ...atlasOpts,
      id: 'labels',
      size: 0,
      lineHeight: 0,
      sdf: false,
      opacity: 0,
    }) as any;
    expect(layer.textOpts.size).toBe(0);
    expect(layer.textOpts.lineHeight).toBe(0);
    expect(layer.textOpts.sdf).toBe(false);
    expect(layer.shaderConfig.sdf).toBe(false);
  });
});

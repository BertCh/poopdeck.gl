/**
 * `STTIsoLayer` — the `isoLines` kind.
 *
 * Three things this suite is really guarding:
 *
 *  1. **The `iso` flag is additive.** `buildLineVertexSource` with the flag
 *     absent or false must emit the source it emitted before the flag existed,
 *     byte for byte, in every (mode × filter × pass × host-variant) cell. The
 *     line and path kinds ride that builder, so a leaked token is a regression
 *     in two other kinds.
 *  2. **The level DOMAIN is a uniform, not a bake.** Uploading a second tile
 *     that widens the domain must restyle the FIRST tile in the same frame,
 *     with no cache rebuilt and no buffer re-uploaded. This is the design
 *     argument in `shaders/iso-ramp.glsl.ts`'s header, and it is the one thing
 *     a "just use colorProperty" implementation cannot do.
 *  3. **The pick pass gates exactly like the visual pass** — including the iso
 *     gates, so a contour dimmed away by `minorOpacity` or `opacity` is
 *     unpickable rather than an invisible hit box.
 */

import { describe, it, expect, vi } from 'vitest';
import { GeometryType, type Tile } from '@poopdeck.gl/core';
import { encodePickId } from '@poopdeck.gl/core/picking';
import {
  STTIsoLayer,
  buildIsoVertexSource,
  resolveIsoTimeFilterMode,
  DEFAULT_ISO_WIDTH,
  DEFAULT_MAJOR_WIDTH_SCALE,
  DEFAULT_MINOR_OPACITY,
} from '../src/layers/iso-layer';
import { buildLineVertexSource } from '../src/layers/line-layer';
import { normalizeRenderArgs } from '../src/lib/host-adapter';
import { makeMockGl } from './mock-gl';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

const PRELUDE =
  'uniform mat4 u_projection_matrix;\n' +
  'vec4 projectTile(vec2 p) { return u_projection_matrix * vec4(p, 0.0, 1.0); }';

const LEGACY_SHADER = { prelude: '', define: '' };
const V5_SHADER = { prelude: PRELUDE, define: '#define GLOBE' };

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

function makeLayer(extra: Record<string, unknown> = {}): any {
  const layer = new STTIsoLayer({
    ...baseOpts,
    id: 'iso',
    ...extra,
  } as any) as any;
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

const legacyCtx = () => drawCtx(normalizeRenderArgs(new Float32Array(16)));

/**
 * Two contour features — one 3-vertex (2 segments) and one 2-vertex (1
 * segment) — so the per-FEATURE level column has to expand across an UNEVEN
 * segment map exactly the way pick ids and DataFilter values do. `levels`
 * omitted builds a tile with no level column at all.
 *
 * `test/fixtures.ts`'s `makeLineTile` has no numericProps, so this kind needs
 * its own; everything else about the shape is that fixture's.
 */
function makeIsoTile(levels?: number[], id = { z: 2, x: 1, y: 1 }): Tile {
  const features: Record<string, unknown> = {
    featureCount: 2,
    geometryType: GeometryType.LineString,
    positionDimensions: 2 as const,
    positions: new Float64Array([
      -73.95, 40.75, -71.05, 42.36, -69.5, 44.0, -122.4, 37.7, -118.24, 34.05,
    ]),
    startIndices: new Uint32Array([0, 3, 5]),
    featureIds: new Uint32Array([0, 1]),
    startTimes: new Float32Array([0, 1000]),
    endTimes: new Float32Array([2000, 3000]),
    timeOffset: 1_700_000_000_000,
    numericProps: levels ? { level: new Float32Array(levels) } : {},
    categoricalProps: {},
  };
  return {
    id: { ...id, t: 1_700_000_000_000 },
    timeRange: { start: 1_700_000_000_000, end: 1_700_000_003_000 },
    layers: [
      {
        name: 'contours',
        extent: 4096,
        features,
        geometryExtensionName: 'geoarrow.linestring',
      },
    ],
  } as unknown as Tile;
}

/** Every argument list `gl[fn]` was called with for the uniform NAMED `name`. */
function uniformArgs(gl: any, fn: string, name: string): unknown[][] {
  const handles = new Set(
    gl.getUniformLocation.mock.calls
      .map((c: unknown[], i: number) =>
        c[1] === name ? gl.getUniformLocation.mock.results[i].value : undefined,
      )
      .filter(Boolean),
  );
  return gl[fn].mock.calls
    .filter((c: unknown[]) => handles.has(c[0]))
    .map((c: unknown[]) => c.slice(1));
}

/** Map buffer handle → the typed array uploaded into it. */
function uploadsByBuffer(gl: any): Map<unknown, ArrayBufferView> {
  const binds = gl.bindBuffer.mock.calls.map((c: unknown[], i: number) => ({
    order: gl.bindBuffer.mock.invocationCallOrder[i],
    buf: c[1],
  }));
  const out = new Map<unknown, ArrayBufferView>();
  gl.bufferData.mock.calls.forEach((c: unknown[], i: number) => {
    const order = gl.bufferData.mock.invocationCallOrder[i];
    let last: unknown;
    for (const b of binds) {
      if (b.order > order) break;
      last = b.buf;
    }
    out.set(last, c[1] as ArrayBufferView);
  });
  return out;
}

/** Vertex sources the recorder compiled, in link order. */
const vertexSources = (gl: any): string[] =>
  gl.shaderSource.mock.calls
    .map((c: unknown[]) => c[1] as string)
    .filter((s: string) => s.includes('void main') && s.includes('aCorner'));

const MODES = ['window', 'wake', 'cumulative', 'trail', 'reveal'] as const;
const ISO_TOKENS = [
  'aLevel',
  'uIsoRamp',
  'uLevelDomain',
  'uUseLevel',
  'uMajorInterval',
  'uMajorWidthScale',
  'uMinorOpacity',
  'uWidthByLevel',
  'uWidthRange',
  'uOpacity',
  'sttIso',
  'isoWidthPx',
  'isoMinorFade',
];

// ───────────────── 1. the flag is additive (the OFF path) ─────────────────

describe('LineVertexVariant.iso — absent or false changes nothing', () => {
  for (const shader of [LEGACY_SHADER, V5_SHADER]) {
    const host = shader.prelude ? 'v5' : 'legacy';
    for (const mode of MODES) {
      for (const filter of [false, true]) {
        for (const pick of [false, true]) {
          it(`${host}/${mode}/filter=${filter}/pick=${pick} is byte-identical`, () => {
            const bare = buildLineVertexSource(shader, { mode, filter, pick });
            const off = buildLineVertexSource(shader, {
              mode,
              filter,
              pick,
              iso: false,
            });
            expect(off).toBe(bare);
            for (const token of ISO_TOKENS) {
              expect(bare).not.toContain(token);
            }
          });
        }
      }
    }
  }

  it('the ON path is a strict SUPERSET — every off-path line survives', () => {
    const off = buildLineVertexSource(LEGACY_SHADER, {}).split('\n');
    const on = buildIsoVertexSource(LEGACY_SHADER, {}).split('\n');
    // Only the width statement is rewritten (its base expression changes); the
    // rest of the off-path source appears verbatim in the on-path source.
    const missing = off.filter(
      (line) =>
        line.trim() &&
        !on.includes(line) &&
        // The two statements the flag rewrites: the width base expression and
        // the colour source. Everything else is carried through untouched.
        !line.includes('widthPx =') &&
        !line.includes('vColor ='),
    );
    expect(missing).toEqual([]);
  });
});

// ───────────────────── 2. what the iso variant compiles ─────────────────────

describe('buildIsoVertexSource', () => {
  it('declares the level attribute and the whole uniform block', () => {
    const src = buildIsoVertexSource(LEGACY_SHADER, {});
    expect(src).toContain('attribute float aLevel;');
    for (const u of [
      'uniform vec4 uIsoRamp[16];',
      'uniform float uIsoRampCount;',
      'uniform vec2 uLevelDomain;',
      'uniform float uUseLevel;',
      'uniform float uMajorInterval;',
      'uniform float uMajorWidthScale;',
      'uniform float uMinorOpacity;',
      'uniform float uWidthByLevel;',
      'uniform vec2 uWidthRange;',
      'uniform float uOpacity;',
    ]) {
      expect(src).toContain(u);
    }
    // …and the kernel, called by its canonical shared-chunk names.
    expect(src).toContain('float sttIsoLevelT(');
    expect(src).toContain('vec4 sttIsoRampColor(');
    expect(src).toContain('float sttIsoMajor(');
    expect(src).toContain('float sttIsoWidth(');
    expect(src).toContain('sttIsoLevelT(aLevel, uLevelDomain)');
  });

  it('colours from the ramp, falling back to the flat colour without the column', () => {
    const src = buildIsoVertexSource(LEGACY_SHADER, {});
    expect(src).toContain(
      'vColor = mix((uUseFeatureColor > 0.5) ? aColor : uColor, isoColor, uUseLevel);',
    );
  });

  it('width is the level-ramped base, still scaled by uWidthScale', () => {
    const src = buildIsoVertexSource(LEGACY_SHADER, {});
    expect(src).toContain('float widthPx = isoWidthPx * uWidthScale;');
    expect(src).toContain('uWidthByLevel * uUseLevel');
    // Major emphasis multiplies the width; the minor fade multiplies alpha.
    expect(src).toContain('mix(1.0, uMajorWidthScale, isoMajor)');
    expect(src).toContain('vAlpha *= uOpacity * isoMinorFade;');
  });

  it('a wake tail still narrows the level-ramped width', () => {
    const src = buildIsoVertexSource(LEGACY_SHADER, { mode: 'wake' });
    expect(src).toContain(
      'float widthPx = isoWidthPx * uWidthScale * sttWakeSizeScale(timeAlpha, uWakeTailScale);',
    );
  });

  it('emphasis is inert when majorInterval is 0 — the guard is in the shader', () => {
    const src = buildIsoVertexSource(LEGACY_SHADER, {});
    // Without this gate, `mix(uMinorOpacity, 1.0, isoMajor)` would dim EVERY
    // contour the moment emphasis was switched off (sttIsoMajor returns 0).
    expect(src).toContain(
      'float isoEmphasized = (uMajorInterval > 0.0) ? uUseLevel : 0.0;',
    );
    expect(src).toContain(
      'float isoMinorFade = mix(1.0, mix(uMinorOpacity, 1.0, isoMajor), isoEmphasized);',
    );
  });

  it('keeps both projection variants and every time kernel intact', () => {
    const legacy = buildIsoVertexSource(LEGACY_SHADER, {});
    expect(legacy).toContain('uniform mat4 uMatrix;');
    expect(legacy).not.toContain('projectTile');
    const v5 = buildIsoVertexSource(V5_SHADER, {});
    expect(v5.startsWith(PRELUDE)).toBe(true);
    expect(v5).toContain('projectTile(posM)');
    expect(v5).toContain('projectTile(neighborM)');
    expect(v5).not.toContain('uniform mat4 uMatrix;');

    const kernels: Record<string, string> = {
      window: 'sttTimeWindowAlpha(aTime',
      wake: 'sttWakeAlpha(aTime',
      cumulative: 'sttCumulativeAlpha(aTime',
      trail: 'sttTrailAlpha(mix(aVertexTimeAB',
      reveal: 'sttRevealSpan(aVertexTimeAB',
    };
    for (const [mode, call] of Object.entries(kernels)) {
      expect(
        buildIsoVertexSource(LEGACY_SHADER, { mode: mode as any }),
      ).toContain(call);
    }
  });

  it('composes the DataFilter branch with the level alpha', () => {
    const src = buildIsoVertexSource(LEGACY_SHADER, { filter: true });
    expect(src).toContain('sttDataFilterAlpha');
    expect(src).toContain('vAlpha = timeAlpha * filterMask;');
    // The iso multiplier lands AFTER the filter composition, so a filtered-out
    // contour stays at zero rather than being revived by opacity.
    expect(src.indexOf('vAlpha *= uOpacity')).toBeGreaterThan(
      src.indexOf('vAlpha = timeAlpha * filterMask;'),
    );
  });

  it('the PICK pass carries the identical alpha gates', () => {
    const visual = buildIsoVertexSource(LEGACY_SHADER, { filter: true });
    const pick = buildIsoVertexSource(LEGACY_SHADER, {
      filter: true,
      pick: true,
    });
    expect(pick).toContain('attribute vec3 aIdColor;');
    expect(pick).toContain('vIdColor = aIdColor;');
    expect(pick).not.toContain('varying vec4 vColor;');
    // Same time gate, same filter gate, same iso gate, same width math — a
    // pick pass that were any more permissive would leave invisible hit boxes.
    for (const gate of [
      'float timeAlpha =',
      'float filterAlpha =',
      'vAlpha = timeAlpha * filterMask;',
      'vAlpha *= uOpacity * isoMinorFade;',
      'float widthPx = isoWidthPx * uWidthScale;',
      'float isoT = sttIsoLevelT(aLevel, uLevelDomain);',
    ]) {
      expect(visual).toContain(gate);
      expect(pick).toContain(gate);
    }
  });
});

// ───────────────────────────── 3. option surface ─────────────────────────────

describe('STTIsoLayer defaults', () => {
  it('defaults the contour grammar off and the width to a hairline', () => {
    const l = makeLayer();
    expect(l.lineOpts.width).toBe(DEFAULT_ISO_WIDTH);
    expect(l.isoOpts.levelProperty).toBeUndefined();
    expect(l.isoOpts.majorInterval).toBe(0);
    expect(l.isoOpts.majorWidthScale).toBe(DEFAULT_MAJOR_WIDTH_SCALE);
    expect(l.isoOpts.minorOpacity).toBe(DEFAULT_MINOR_OPACITY);
    expect(l.isoOpts.widthByLevel).toBe(false);
    expect(l.isoOpts.widthRange).toEqual([1, 3]);
    expect(l.isoOpts.opacity).toBe(1);
    // Inherited: an unset mode is window, never inferred into wake/trail.
    expect(l.lineOpts.timeFilterMode).toBe('window');
  });

  it('an explicit undefined still reaches the default (?? , not a spread)', () => {
    const l = makeLayer({
      width: undefined,
      majorInterval: undefined,
      opacity: undefined,
      minorOpacity: undefined,
    });
    expect(l.lineOpts.width).toBe(DEFAULT_ISO_WIDTH);
    expect(l.isoOpts.majorInterval).toBe(0);
    expect(l.isoOpts.opacity).toBe(1);
    expect(l.isoOpts.minorOpacity).toBe(DEFAULT_MINOR_OPACITY);
  });

  it('accepts 0 and false as real caller values', () => {
    const l = makeLayer({ width: 0, opacity: 0, widthByLevel: false });
    expect(l.lineOpts.width).toBe(0);
    expect(l.isoOpts.opacity).toBe(0);
    expect(l.isoOpts.widthByLevel).toBe(false);
  });

  it('resolveIsoTimeFilterMode degrades a length-less wake/trail to window', () => {
    expect(resolveIsoTimeFilterMode('wake', 0, 0)).toBe('window');
    expect(resolveIsoTimeFilterMode('wake', 100, 0)).toBe('wake');
    expect(resolveIsoTimeFilterMode('trail', 0, 0)).toBe('window');
    expect(resolveIsoTimeFilterMode('trail', 0, 100)).toBe('trail');
    expect(resolveIsoTimeFilterMode('cumulative', 0, 0)).toBe('cumulative');
    // Unset stays window even with positive knobs — this kind's lengths are
    // window-DERIVED, so inferring would put every layer into wake mode.
    expect(resolveIsoTimeFilterMode(undefined, 100, 100)).toBe('window');
  });

  it('reports the RESOLVED time knobs to the tile-load window', () => {
    const l = makeLayer({ timeFilterMode: 'wake' });
    expect(l.timeModeLoadKnobs()).toEqual({
      mode: 'wake',
      wakeLength: 2500, // timeWindow / 2, the line renderer's default
      trailLength: 2500,
    });
  });
});

// ─────────────────── 4. the level column reaches the GPU ───────────────────

describe('level column upload', () => {
  it('expands the per-FEATURE level across each feature’s own segments', () => {
    const l = makeLayer({ levelProperty: 'level' });
    const gl = makeMockGl();
    const tile = makeIsoTile([500, 520]);
    const cache = l.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache.hasLevelColumn).toBe(true);
    expect(cache.instanceCount).toBe(3); // 2 segments + 1 segment
    const uploaded = uploadsByBuffer(gl).get(cache.levelBuffer);
    // Feature 0 contributed 2 segments, feature 1 contributed 1.
    expect(Array.from(uploaded as Float32Array)).toEqual([500, 500, 520]);
    // …and the buffer is registered for the base's unload sweep.
    expect(cache.extraBuffers).toContain(cache.levelBuffer);
  });

  it('a tile without the column renders as a plain line, never blank', () => {
    const l = makeLayer({ levelProperty: 'level' });
    const gl = makeMockGl();
    const tile = makeIsoTile(); // no numericProps at all
    const cache = l.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache).not.toBeNull();
    expect(cache.hasLevelColumn).toBe(false);
    expect(cache.levelBuffer).toBeUndefined();
    l.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
    expect(uniformArgs(gl, 'uniform1f', 'uUseLevel')).toEqual([[0]]);
    // The geometry still drew.
    expect(l.instSupport.drawArraysInstanced).toHaveBeenCalledTimes(1);
  });

  it('a column SHORTER than the feature count is refused, not read past', () => {
    const l = makeLayer({ levelProperty: 'level' });
    const gl = makeMockGl();
    const tile = makeIsoTile([500]); // 2 features, 1 level
    const cache = l.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache.hasLevelColumn).toBe(false);
    expect(l.getLevelDomain()).toEqual([0, 1]); // and it did not poison the domain
  });

  it('no levelProperty means no level buffer at all', () => {
    const l = makeLayer();
    const gl = makeMockGl();
    const tile = makeIsoTile([500, 520]);
    const cache = l.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache.hasLevelColumn).toBe(false);
    expect(cache.levelBuffer).toBeUndefined();
  });
});

// ──────── 5. THE design point: the domain widens without a rebuild ────────

describe('the level domain is a uniform that widens with the tile stream', () => {
  it('a later tile RESTYLES an already-resident one with no cache rebuild', () => {
    const l = makeLayer({ levelProperty: 'level' });
    const gl = makeMockGl();
    const tileA = makeIsoTile([500, 520], { z: 2, x: 1, y: 1 });
    const tileB = makeIsoTile([480, 560], { z: 2, x: 2, y: 1 });

    const buildSpy = vi.spyOn(l, 'buildTileGpuCache');
    const cacheA = l.buildTileGpuCache(gl, tileA, tileA.layers[0]);
    expect(l.getLevelDomain()).toEqual([500, 520]);
    l.drawTile(gl, tileA, tileA.layers[0], cacheA, legacyCtx());
    expect(uniformArgs(gl, 'uniform2f', 'uLevelDomain')).toEqual([[500, 520]]);

    // Tile B lands and WIDENS the layer-wide domain.
    const levelBufferBefore = cacheA.levelBuffer;
    const buffersBefore = gl.createBuffer.mock.calls.length;
    l.buildTileGpuCache(gl, tileB, tileB.layers[0]);
    expect(l.getLevelDomain()).toEqual([480, 560]);

    // Re-draw the SAME cache object for tile A: the uniform moved, and nothing
    // about A was rebuilt — no second buildTileGpuCache for A, no new buffer,
    // the same level buffer handle. A baked per-feature colour could not do
    // this: A would have kept the colours of the narrow domain.
    const buildCallsBefore = buildSpy.mock.calls.length;
    const bufferCountAfterB = gl.createBuffer.mock.calls.length;
    l.drawTile(gl, tileA, tileA.layers[0], cacheA, legacyCtx());
    expect(uniformArgs(gl, 'uniform2f', 'uLevelDomain')).toEqual([
      [500, 520],
      [480, 560],
    ]);
    expect(buildSpy.mock.calls.length).toBe(buildCallsBefore);
    expect(gl.createBuffer.mock.calls.length).toBe(bufferCountAfterB);
    expect(cacheA.levelBuffer).toBe(levelBufferBefore);
    expect(buffersBefore).toBeLessThanOrEqual(bufferCountAfterB);
  });

  it('widening repaints once, and a tile inside the known range is free', () => {
    const l = makeLayer({ levelProperty: 'level' });
    l.map = { triggerRepaint: vi.fn() };
    const gl = makeMockGl();
    l.buildTileGpuCache(
      gl,
      makeIsoTile([500, 520]),
      makeIsoTile([500, 520]).layers[0],
    );
    expect(l.map.triggerRepaint).toHaveBeenCalledTimes(1);
    // Entirely inside [500, 520] — the domain does not move, so no repaint.
    const inner = makeIsoTile([505, 510], { z: 3, x: 1, y: 1 });
    l.buildTileGpuCache(gl, inner, inner.layers[0]);
    expect(l.getLevelDomain()).toEqual([500, 520]);
    expect(l.map.triggerRepaint).toHaveBeenCalledTimes(1);
  });

  it('a PINNED levelDomain is never widened by the tile stream', () => {
    const l = makeLayer({ levelProperty: 'level', levelDomain: [0, 100] });
    const gl = makeMockGl();
    const tile = makeIsoTile([500, 520]);
    l.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(l.getLevelDomain()).toEqual([0, 100]);
  });

  it('NaN levels are skipped rather than poisoning the domain', () => {
    const l = makeLayer({ levelProperty: 'level' });
    const gl = makeMockGl();
    const tile = makeIsoTile([NaN, 520]);
    l.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(l.getLevelDomain()).toEqual([520, 520]);
  });

  it('setLevelDomain pins explicitly and repaints', () => {
    const l = makeLayer({ levelProperty: 'level' });
    l.map = { triggerRepaint: vi.fn() };
    l.setLevelDomain(400, 600);
    expect(l.getLevelDomain()).toEqual([400, 600]);
    expect(l.map.triggerRepaint).toHaveBeenCalled();
  });
});

// ───────────────────────────── 6. the draw pass ─────────────────────────────

describe('drawTile', () => {
  it('uploads the whole level grammar and draws one instance per segment', () => {
    const l = makeLayer({
      levelProperty: 'level',
      majorInterval: 20,
      majorWidthScale: 3,
      minorOpacity: 0.25,
      widthByLevel: true,
      widthRange: [1, 4],
      opacity: 0.8,
    });
    const gl = makeMockGl();
    const tile = makeIsoTile([500, 520]);
    const cache = l.buildTileGpuCache(gl, tile, tile.layers[0]);
    l.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());

    expect(uniformArgs(gl, 'uniform1f', 'uUseLevel')).toEqual([[1]]);
    expect(uniformArgs(gl, 'uniform1f', 'uMajorInterval')).toEqual([[20]]);
    expect(uniformArgs(gl, 'uniform1f', 'uMajorWidthScale')).toEqual([[3]]);
    expect(uniformArgs(gl, 'uniform1f', 'uMinorOpacity')).toEqual([[0.25]]);
    expect(uniformArgs(gl, 'uniform1f', 'uWidthByLevel')).toEqual([[1]]);
    expect(uniformArgs(gl, 'uniform2f', 'uWidthRange')).toEqual([[1, 4]]);
    expect(uniformArgs(gl, 'uniform1f', 'uOpacity')).toEqual([[0.8]]);
    expect(uniformArgs(gl, 'uniform1f', 'uIsoRampCount')).toEqual([[5]]);

    // The ramp goes up as ONE vec4 array upload from element 0.
    const ramp = uniformArgs(
      gl,
      'uniform4fv',
      'uIsoRamp',
    )[0][0] as Float32Array;
    expect(ramp).toHaveLength(5 * 4);
    expect(ramp[0]).toBeCloseTo(68 / 255, 6); // viridis stop 0, 0–255 detected
    expect(ramp[3]).toBe(1);

    expect(l.instSupport.drawArraysInstanced).toHaveBeenCalledWith(
      0x0005,
      0,
      4,
      3,
    );
  });

  it('a caller ramp longer than 16 stops is resampled, not truncated', () => {
    const long = Array.from({ length: 40 }, (_, i) => [i * 6, 0, 0, 255]);
    const l = makeLayer({ colorRange: long });
    const gl = makeMockGl();
    const tile = makeIsoTile([500, 520]);
    const cache = l.buildTileGpuCache(gl, tile, tile.layers[0]);
    l.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
    expect(uniformArgs(gl, 'uniform1f', 'uIsoRampCount')).toEqual([[16]]);
    const ramp = uniformArgs(
      gl,
      'uniform4fv',
      'uIsoRamp',
    )[0][0] as Float32Array;
    expect(ramp).toHaveLength(64);
    // The LAST caller stop survives — truncation would have dropped it.
    expect(ramp[60]).toBeCloseTo((39 * 6) / 255, 5);
  });

  it('metric widths fold metres→device-px into uWidthScale', () => {
    const px = makeLayer({ levelProperty: 'level', widthScale: 2 });
    const m = makeLayer({
      levelProperty: 'level',
      widthScale: 2,
      widthUnits: 'meters',
    });
    const run = (l: any) => {
      const gl = makeMockGl();
      const tile = makeIsoTile([500, 520]);
      const cache = l.buildTileGpuCache(gl, tile, tile.layers[0]);
      l.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
      return uniformArgs(gl, 'uniform1f', 'uWidthScale')[0][0] as number;
    };
    expect(run(px)).toBe(2);
    const metric = run(m);
    expect(metric).not.toBe(2);
    expect(metric).toBeGreaterThan(0);
  });

  it('time uniforms are TILE-RELATIVE in every mode', () => {
    for (const mode of ['wake', 'cumulative', 'trail'] as const) {
      const l = makeLayer({
        levelProperty: 'level',
        timeFilterMode: mode,
        wakeLength: 1000,
        trailLength: 1000,
      });
      const gl = makeMockGl();
      const tile = makeIsoTile([500, 520]);
      const cache = l.buildTileGpuCache(gl, tile, tile.layers[0]);
      l.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
      expect(uniformArgs(gl, 'uniform1f', 'uCurrentTime')).toEqual([
        [baseOpts.currentTime - cache.timeOffset],
      ]);
      expect(vertexSources(gl)[0]).toContain('sttIso');
    }
  });

  it('keys programs under iso: so they cannot collide with the line kind', () => {
    const l = makeLayer({ levelProperty: 'level' });
    const gl = makeMockGl();
    const tile = makeIsoTile([500, 520]);
    const cache = l.buildTileGpuCache(gl, tile, tile.layers[0]);
    l.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
    l.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
    // One program for (visual, window, legacy), reused on the second draw.
    expect(vertexSources(gl)).toHaveLength(1);
    expect(
      [...l.programCache.keys()].every((k: string) => k.startsWith('iso:')),
    ).toBe(true);
    // A second HOST variant is a second program, not a cache collision.
    l.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(v5Args('globe', 1))),
    );
    expect(vertexSources(gl)).toHaveLength(2);
  });

  it('a mode flip re-keys the program and re-records the VAO', () => {
    const l = makeLayer({ levelProperty: 'level' });
    const gl = makeMockGl();
    const tile = makeIsoTile([500, 520]);
    const cache = l.buildTileGpuCache(gl, tile, tile.layers[0]);
    l.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
    const keysBefore = [...l.programCache.keys()];
    l.setTimeFilterMode('cumulative');
    const cache2 = l.buildTileGpuCache(gl, tile, tile.layers[0]);
    l.drawTile(gl, tile, tile.layers[0], cache2, legacyCtx());
    const keysAfter = [...l.programCache.keys()];
    expect(keysAfter.length).toBe(keysBefore.length + 1);
    expect(keysAfter.some((k) => k.includes('cumulative'))).toBe(true);
    expect(vertexSources(gl)).toHaveLength(2);
  });

  it('the DataFilter branch compiles in only when a column is named', () => {
    const off = makeLayer({ levelProperty: 'level' });
    const on = makeLayer({ levelProperty: 'level', filterProperty: 'level' });
    for (const [l, want] of [
      [off, false],
      [on, true],
    ] as const) {
      const gl = makeMockGl();
      const tile = makeIsoTile([500, 520]);
      const cache = l.buildTileGpuCache(gl, tile, tile.layers[0]);
      l.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
      expect(vertexSources(gl)[0].includes('sttDataFilterAlpha')).toBe(want);
      // …and the iso branch is there either way.
      expect(vertexSources(gl)[0]).toContain('sttIsoRampColor');
    }
  });
});

// ───────────────────────────── 7. id-FBO picking ─────────────────────────────

describe('drawPickTile', () => {
  it('expands ids per FEATURE across segments and draws instanced', () => {
    const l = makeLayer({ levelProperty: 'level' });
    const gl = makeMockGl();
    const tile = makeIsoTile([500, 520]);
    const cache = l.buildTileGpuCache(gl, tile, tile.layers[0]);
    l.drawPickTile(gl, tile, tile.layers[0], cache, legacyCtx(), 1);

    // The id buffer is the pass's only UNSIGNED_BYTE upload (no colorProperty
    // here); the unit quad is created after it, so "the last buffer" is wrong.
    const [, ids] = [...uploadsByBuffer(gl)].find(
      ([, v]) => v instanceof Uint8Array,
    )! as [unknown, Uint8Array];
    const [r0, g0, b0] = encodePickId(1);
    const [r1, g1, b1] = encodePickId(2);
    // Feature 0 → its 2 segments, feature 1 → its 1 segment.
    expect(Array.from(ids)).toEqual([r0, g0, b0, r0, g0, b0, r1, g1, b1]);
    expect(l.instSupport.drawArraysInstanced).toHaveBeenCalledWith(
      0x0005,
      0,
      4,
      3,
    );
  });

  it('gates identically to the visual pass, uniform for uniform', () => {
    const opts = {
      levelProperty: 'level',
      majorInterval: 20,
      minorOpacity: 0.25,
      opacity: 0.5,
      widthByLevel: true,
      widthRange: [1, 4],
    };
    const visual = makeLayer(opts);
    const pick = makeLayer(opts);
    const glV = makeMockGl();
    const glP = makeMockGl();
    const tile = makeIsoTile([500, 520]);
    const cV = visual.buildTileGpuCache(glV, tile, tile.layers[0]);
    const cP = pick.buildTileGpuCache(glP, tile, tile.layers[0]);
    visual.drawTile(glV, tile, tile.layers[0], cV, legacyCtx());
    pick.drawPickTile(glP, tile, tile.layers[0], cP, legacyCtx(), 1);
    for (const u of [
      'uUseLevel',
      'uMajorInterval',
      'uMinorOpacity',
      'uOpacity',
      'uWidthByLevel',
      'uWidth',
      'uWidthScale',
      'uWindowStart',
      'uWindowEnd',
    ]) {
      expect(uniformArgs(glP, 'uniform1f', u)).toEqual(
        uniformArgs(glV, 'uniform1f', u),
      );
    }
    expect(uniformArgs(glP, 'uniform2f', 'uLevelDomain')).toEqual(
      uniformArgs(glV, 'uniform2f', 'uLevelDomain'),
    );
  });

  it('leaves the attribute slate clean and frees the one-shot id buffer', () => {
    const l = makeLayer({ levelProperty: 'level' });
    const gl = makeMockGl();
    const tile = makeIsoTile([500, 520]);
    const cache = l.buildTileGpuCache(gl, tile, tile.layers[0]);
    l.drawPickTile(gl, tile, tile.layers[0], cache, legacyCtx(), 1);
    const [idBuf] = [...uploadsByBuffer(gl)].find(
      ([, v]) => v instanceof Uint8Array,
    )!;
    expect(gl.deleteBuffer).toHaveBeenCalledWith(idBuf);
    // Every divisor this pass raised is back at 0…
    const raised = l.instSupport.vertexAttribDivisor.mock.calls
      .filter((c: number[]) => c[1] === 1)
      .map((c: number[]) => c[0]);
    const cleared = l.instSupport.vertexAttribDivisor.mock.calls
      .filter((c: number[]) => c[1] === 0)
      .map((c: number[]) => c[0]);
    for (const loc of new Set(raised)) expect(cleared).toContain(loc);
    // …and disabled.
    for (const loc of new Set(raised)) {
      expect(gl.disableVertexAttribArray).toHaveBeenCalledWith(loc);
    }
  });

  it('drawPickTile exists — the pickability declaration for this kind', () => {
    expect(typeof (STTIsoLayer.prototype as any).drawPickTile).toBe('function');
  });
});

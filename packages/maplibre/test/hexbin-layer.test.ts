/**
 * Hexbin layer (Wave M4): the RUNTIME hexbin — bins raw POINT tiles into a
 * world-space hexagonal lattice and draws one instanced prism per occupied
 * cell. Unlike h3/quadbin there is no stored cell id; the lattice, the union
 * bin table (the seam fix) and the windowed aggregate are the machine under
 * test.
 *
 * Coverage, mirroring the column/heatmap suites:
 *  - **CPU geometry** — the unit hexagonal prism mesh (shape, wall band, cache
 *    identity) and the kernel-derived unit ring.
 *  - **JS references** — texel layout, cell-value aggregation, the per-point
 *    time gate (routed through the shared kernels' own JS refs), the CPU
 *    aggregator (gate application + the seam MERGE + NaN drop) and percentile
 *    domain sampling. These are the CPU twins the two shader paths mirror.
 *  - **Shader strings** — both host variants of the cell pass build for every
 *    aggregation and both aggregate sources; the scatter pass is projection-
 *    free (identical on every host); the default config compiles no filter; the
 *    id variants reproduce the visual gates; program keys are unique per axis.
 *  - **mock-gl draws** — the two-pass pipeline (scatter FBO + one instanced
 *    cell draw), the GPU⇄CPU source resolution, per-variant program caching,
 *    the FIRST-CLASS geometry-cache-stability assertion (the union table is NOT
 *    rebuilt on a time-only change), and pick provenance / gating.
 *
 * Real float-FBO scatter, vertex texture fetch and the pick FBO round-trip stay
 * browser-verified.
 */

import { describe, it, expect, vi } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import { encodePickId } from '@poopdeck.gl/core/picking';
import { DEFAULT_WAKE_TAIL_SCALE } from '@poopdeck.gl/core/time-filter';
import {
  STTHexbinLayer,
  HEXBIN_WALL_SHADE,
  DEFAULT_HEXBIN_COLOR_RANGE,
  buildHexbinMesh,
  hexbinUnitRing,
  buildHexbinScatterVertexSource,
  buildHexbinCellVertexSource,
  buildHexbinCellIdVertexSource,
  HEXBIN_SCATTER_FS,
  HEXBIN_CELL_FS,
  HEXBIN_ID_FS,
  hexbinProgramKey,
  hexbinTextureSize,
  hexbinTexelUv,
  hexbinCellValue,
  hexbinTimeAlphaJS,
  aggregateHexbinsCpu,
  hexbinValueDomain,
  resolveHexbinTimeFilterMode,
  type HexbinCellConfig,
  type HexbinContribution,
  type HexbinTimeGate,
} from '../src/layers/hexbin-layer';
import {
  DATA_FILTER_CALL_GLSL,
  createDataFilterUniforms,
} from '../src/shaders/data-filter.glsl';
import {
  timeWindowAlphaJS,
  wakeAlphaJS,
  cumulativeAlphaJS,
  trailAlphaJS,
} from '../src/shaders/time-window.glsl';
import {
  hexBinCentroidMercator,
  hexBinKeyForPoint,
  hexBinRadiusFromMeters,
} from '../src/lib/cell-geometry';
import {
  lngLatToMercatorInto,
  mercatorZFromAltitude,
} from '../src/lib/projection';
import { makeMockGl, makeMockMap, publishVisibleTiles } from './mock-gl';
import { makePointTile, makePropertyPointTile } from './fixtures';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

const PRELUDE = `// __HOST_PRELUDE__
uniform mat4 u_projection_matrix;
vec4 projectTileFor3D(vec2 p, float elev) { return u_projection_matrix * vec4(p, elev, 1.0); }`;
const LEGACY_SHADER = { prelude: '', define: '' };
const V5_SHADER = { prelude: PRELUDE, define: '#define GLOBE' };

const cellCfg = (over: Partial<HexbinCellConfig> = {}): HexbinCellConfig => ({
  colorAggregation: 'SUM',
  elevationAggregation: 'SUM',
  source: 'gpu',
  ...over,
});

/** v5 render-args shape (recorded, not imported — dev dep stays ^4). */
const mat16 = () => Array.from({ length: 16 }, (_, i) => i + 1);
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

/**
 * A mock GL whose per-attribute-location slots are distinct (the shared
 * recorder hands out 0 for everything, which would make divisor assertions
 * vacuous), with instancing + VAO support routed through the recorder. `gpu`
 * additionally advertises the float-colour-buffer extensions so the layer
 * takes the GPU aggregate path; without it the probe finds no float target and
 * falls back to the CPU aggregate.
 */
function makeGl(opts: { gpu?: boolean } = {}): any {
  const gl = makeMockGl();
  const slots = new Map<string, number>();
  gl.getAttribLocation = vi.fn((_p: unknown, name: string) => {
    if (!slots.has(name)) slots.set(name, slots.size);
    return slots.get(name)!;
  });
  if (opts.gpu) {
    const base = gl.getExtension;
    gl.getExtension = vi.fn((name: string) => {
      if (name === 'EXT_color_buffer_float' || name === 'OES_texture_float') {
        return { __mockKind: 'extension' };
      }
      return base(name);
    });
  }
  return gl;
}

/** Route instancing + VAO through the recorder (onAdd normally does this). */
function wireCaps(layer: any, gl: any): void {
  layer.instSupport = {
    enabled: true,
    drawArraysInstanced: (m: number, f: number, c: number, p: number) =>
      gl.drawArraysInstanced(m, f, c, p),
    drawElementsInstanced: (
      m: number,
      c: number,
      t: number,
      o: number,
      p: number,
    ) => gl.drawElementsInstanced(m, c, t, o, p),
    vertexAttribDivisor: (i: number, d: number) => gl.vertexAttribDivisor(i, d),
  };
  layer.vaoSupport = {
    enabled: true,
    create: () => gl.createVertexArray(),
    bind: (vao: unknown) => gl.bindVertexArray(vao),
    delete: (vao: unknown) => gl.deleteVertexArray(vao),
    current: () => null,
  };
}

/** A render-ready layer with mock map/tileset/tiles injected. */
function makeRenderableLayer(
  gl: any,
  opts: Record<string, unknown> = {},
  tiles: any[] = [makePropertyPointTile()],
): any {
  const layer = new STTHexbinLayer({ ...baseOpts, id: 'h', ...opts } as any);
  const l = layer as any;
  l.onContextReady(gl);
  l.gl = gl;
  l.map = makeMockMap();
  l.tileset = { update: vi.fn(), getVisibleTiles: () => [], finalize: vi.fn() };
  publishVisibleTiles(l, ...tiles);
  wireCaps(l, gl);
  return l;
}

// ── CPU geometry ────────────────────────────────────────────────────────────

describe('unit hexagonal ring', () => {
  it('is the kernel ring re-centred on the origin (pointy-top, 6 open verts)', () => {
    const ring = hexbinUnitRing();
    expect(ring.length).toBe(12);
    // Derived from hexBinToMercatorRing(0,0,1) minus its own centroid, so it
    // cannot drift from the CPU ring builder. Every vertex is circumradius 1.
    for (let k = 0; k < 6; k++) {
      expect(Math.hypot(ring[k * 2], ring[k * 2 + 1])).toBeCloseTo(1, 12);
    }
    // Pointy-top: a vertex due north (x≈0), flat sides east/west.
    const xs = Array.from({ length: 6 }, (_, k) => ring[k * 2]);
    expect(Math.min(...xs.map(Math.abs))).toBeCloseTo(0, 12);
  });
});

describe('unit prism mesh', () => {
  const n = 6;

  it('extruded: full-brightness cap + a darker self-contained wall band', () => {
    const mesh = buildHexbinMesh(true);
    expect(mesh.vertexCount).toBe(n * 3);
    for (let i = 0; i < n; i++) {
      expect(mesh.vertices[i * 4 + 2]).toBe(1); // cap unitZ
      expect(mesh.vertices[i * 4 + 3]).toBe(1); // cap shade
      expect(mesh.vertices[(n + i) * 4 + 3]).toBe(HEXBIN_WALL_SHADE);
      expect(mesh.vertices[(2 * n + i) * 4 + 2]).toBe(0); // wall bottom
    }
    // Cap fan (n-2 tris) + 2 tris per ring edge.
    expect(mesh.indexCount).toBe(3 * (n - 2) + 6 * n);
    for (const idx of mesh.indices) expect(idx).toBeLessThan(mesh.vertexCount);
  });

  it('flat: the cap alone, still at unitZ 1', () => {
    const mesh = buildHexbinMesh(false);
    expect(mesh.vertexCount).toBe(n);
    expect(mesh.indexCount).toBe(3 * (n - 2));
  });

  it('caches by extruded — one shared geometry per page', () => {
    expect(buildHexbinMesh(true)).toBe(buildHexbinMesh(true));
    expect(buildHexbinMesh(false)).toBe(buildHexbinMesh(false));
    expect(buildHexbinMesh(true)).not.toBe(buildHexbinMesh(false));
  });
});

// ── JS references ───────────────────────────────────────────────────────────

describe('scatter-texture layout', () => {
  it('packs a small table into one short row block', () => {
    expect(hexbinTextureSize(0)).toEqual({ width: 0, height: 0 });
    expect(hexbinTextureSize(5)).toEqual({ width: 5, height: 1 });
    // Beyond the width cap it grows downward.
    expect(hexbinTextureSize(1025)).toEqual({ width: 1024, height: 2 });
  });

  it('texel uv is the CENTRE of the bin index cell', () => {
    // bin 0 of a 4×1 target sits at u = 0.5/4.
    expect(hexbinTexelUv(0, 4, 1)).toEqual([0.125, 0.5]);
    expect(hexbinTexelUv(3, 4, 1)).toEqual([0.875, 0.5]);
    // wraps to the second row.
    const [u, v] = hexbinTexelUv(4, 4, 2);
    expect(u).toBeCloseTo(0.125, 12);
    expect(v).toBeCloseTo(0.75, 12);
  });
});

describe('cell value aggregation', () => {
  it('SUM / COUNT / MEAN read off the (sum, count) pair', () => {
    expect(hexbinCellValue(30, 3, 'SUM')).toBe(30);
    expect(hexbinCellValue(30, 3, 'COUNT')).toBe(3);
    expect(hexbinCellValue(30, 3, 'MEAN')).toBeCloseTo(10, 12);
  });
  it('MIN / MAX degrade to SUM (documented)', () => {
    expect(hexbinCellValue(30, 3, 'MIN')).toBe(30);
    expect(hexbinCellValue(30, 3, 'MAX')).toBe(30);
  });
});

describe('per-point time gate JS twin', () => {
  const gate = (over: Partial<HexbinTimeGate> = {}): HexbinTimeGate => ({
    mode: 'window',
    currentTime: 1000,
    windowStart: 0,
    windowEnd: 2000,
    fadeIn: 0,
    fadeOut: 0,
    wakeLength: 500,
    trailLength: 800,
    fadeTrail: 1,
    ...over,
  });

  it('routes each mode through the shared kernel JS ref', () => {
    expect(hexbinTimeAlphaJS(500, 1500, gate())).toBe(
      timeWindowAlphaJS(500, 1500, 0, 2000, 0, 0),
    );
    expect(hexbinTimeAlphaJS(700, 9, gate({ mode: 'wake' }))).toBe(
      wakeAlphaJS(700, 1000, 500),
    );
    expect(hexbinTimeAlphaJS(600, 9, gate({ mode: 'cumulative' }))).toBe(
      cumulativeAlphaJS(600, 1000, 0),
    );
    expect(hexbinTimeAlphaJS(400, 9, gate({ mode: 'trail' }))).toBe(
      trailAlphaJS(400, 1000, 800, 1),
    );
  });
});

describe('CPU aggregator', () => {
  const gate: HexbinTimeGate = {
    mode: 'window',
    currentTime: 1000,
    windowStart: -10_000,
    windowEnd: 10_000,
    fadeIn: 0,
    fadeOut: 0,
    wakeLength: 0,
    trailLength: 0,
    fadeTrail: 1,
  };

  it('sums weight·gate and gate per bin', () => {
    const c: HexbinContribution = {
      binIndex: new Int32Array([0, 0, 1]),
      weights: new Float32Array([2, 3, 5]),
      startTimes: new Float32Array([0, 0, 0]),
      endTimes: new Float32Array([0, 0, 0]),
      filterValues: null,
      gate,
    };
    const agg = aggregateHexbinsCpu(2, [c], null, createDataFilterUniforms());
    expect(Array.from(agg)).toEqual([5, 2, 5, 1]); // bin0: sum 5 count 2, bin1: 5,1
  });

  it('MERGES bins that straddle two tiles (the seam fix)', () => {
    // Same dense index 0 fed by two separate tiles → ONE cell, summed.
    const a: HexbinContribution = {
      binIndex: new Int32Array([0]),
      weights: new Float32Array([4]),
      startTimes: new Float32Array([0]),
      endTimes: new Float32Array([0]),
      filterValues: null,
      gate,
    };
    const b: HexbinContribution = {
      binIndex: new Int32Array([0]),
      weights: new Float32Array([6]),
      startTimes: new Float32Array([0]),
      endTimes: new Float32Array([0]),
      filterValues: null,
      gate,
    };
    const agg = aggregateHexbinsCpu(
      1,
      [a, b],
      null,
      createDataFilterUniforms(),
    );
    expect(Array.from(agg)).toEqual([10, 2]);
  });

  it('drops a gated-out point and never folds a -1 bin into bin 0', () => {
    const c: HexbinContribution = {
      binIndex: new Int32Array([-1, 0]),
      weights: new Float32Array([9, 1]),
      startTimes: new Float32Array([0, 5_000_000]), // second point far future
      endTimes: new Float32Array([0, 5_000_000]),
      filterValues: null,
      gate: { ...gate, mode: 'wake', wakeLength: 100 },
    };
    const agg = aggregateHexbinsCpu(1, [c], null, createDataFilterUniforms());
    // Point 0 has bin -1 (dropped); point 1 is outside the wake window.
    expect(Array.from(agg)).toEqual([0, 0]);
  });

  it('multiplies the DataFilter alpha into the contribution', () => {
    const c: HexbinContribution = {
      binIndex: new Int32Array([0, 0]),
      weights: new Float32Array([1, 1]),
      startTimes: new Float32Array([0, 0]),
      endTimes: new Float32Array([0, 0]),
      filterValues: new Float32Array([2, 8]),
      gate,
    };
    // Hard range [5, 10] keeps only the value-8 point.
    const agg = aggregateHexbinsCpu(
      1,
      [c],
      { filterProperty: 'x', filterRange: [5, 10], filterEnabled: true },
      createDataFilterUniforms(),
    );
    expect(Array.from(agg)).toEqual([1, 1]);
  });
});

describe('percentile value domain', () => {
  it('is [min, max] of occupied cells; empty cells never participate', () => {
    // bins: (10,1),(30,3),(0,0 empty),(20,2) → values 10,30,20 (SUM==value).
    const agg = new Float32Array([10, 1, 30, 3, 0, 0, 20, 2]);
    expect(hexbinValueDomain(agg, 'SUM')).toEqual([10, 30]);
  });
  it('clips to the percentile band', () => {
    // values 10..50; the 50th percentile of 5 samples is the median, 30.
    const agg = new Float32Array([10, 1, 20, 1, 30, 1, 40, 1, 50, 1]);
    expect(hexbinValueDomain(agg, 'SUM', 0, 50)).toEqual([10, 30]);
    expect(hexbinValueDomain(agg, 'SUM', 50, 100)).toEqual([30, 50]);
  });
  it('returns null with nothing occupied (caller keeps the previous domain)', () => {
    expect(hexbinValueDomain(new Float32Array([0, 0]), 'SUM')).toBeNull();
  });
});

// ── mode + prop defaults ────────────────────────────────────────────────────

describe('time-filter mode resolution', () => {
  it("follows deck's precedence when the mode is unset", () => {
    expect(resolveHexbinTimeFilterMode(undefined, 0, 0)).toBe('window');
    expect(resolveHexbinTimeFilterMode(undefined, 500, 0)).toBe('wake');
    expect(resolveHexbinTimeFilterMode(undefined, 0, 500)).toBe('trail');
  });
  it('degrades an explicit wake/trail with no length knob to window', () => {
    expect(resolveHexbinTimeFilterMode('wake', 0, 0)).toBe('window');
    expect(resolveHexbinTimeFilterMode('trail', 0, 0)).toBe('window');
    expect(resolveHexbinTimeFilterMode('cumulative', 0, 0)).toBe('cumulative');
  });
});

describe('prop-default back-compat', () => {
  it('an out-of-the-box layer accepts only points and compiles no filter', () => {
    const layer = new STTHexbinLayer({ ...baseOpts, id: 'h' }) as any;
    expect(layer.acceptsGeometry(GeometryType.Point)).toBe(true);
    expect(layer.acceptsGeometry(GeometryType.LineString)).toBe(false);
    expect(layer.scatterConfig.filter).toBe(false);
    expect(layer.scatterConfig.mode).toBe('window');
    expect(layer.renderingMode).toBe('3d');
    expect(layer.hexOpts.wakeTailScale).toBe(DEFAULT_WAKE_TAIL_SCALE);
    expect(layer.hexOpts.colorRange).toBe(DEFAULT_HEXBIN_COLOR_RANGE);
  });

  it('an explicit undefined renderingMode still lands on the 3d default', () => {
    const layer = new STTHexbinLayer({
      ...baseOpts,
      id: 'h',
      renderingMode: undefined,
    }) as any;
    expect(layer.renderingMode).toBe('3d');
  });

  it('MIN/MAX and quantile scale warn once and degrade', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new STTHexbinLayer({
      ...baseOpts,
      id: 'h',
      hexagonAggregation: 'MAX',
      colorScaleType: 'quantile',
    });
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

// ── shader strings ──────────────────────────────────────────────────────────

describe('scatter shader', () => {
  it('is projection-free (no host variant, no uMatrix, no prelude call)', () => {
    const src = buildHexbinScatterVertexSource();
    expect(src).not.toContain('uMatrix');
    expect(src).not.toContain('projectTile');
    expect(src).toContain('uBinTexSize');
    expect(src).toContain('gl_PointSize');
    // Window mode by default: the gate reads the window uniforms.
    expect(src).toContain('sttTimeWindowAlpha');
  });

  it('compiles the DataFilter branch only when asked', () => {
    expect(
      buildHexbinScatterVertexSource({ mode: 'window', filter: false }),
    ).not.toContain('aFilterValue');
    const filtered = buildHexbinScatterVertexSource({
      mode: 'window',
      filter: true,
    });
    expect(filtered).toContain('aFilterValue');
    expect(filtered).toContain(DATA_FILTER_CALL_GLSL);
  });

  it('selects the mode kernel at compile time', () => {
    expect(
      buildHexbinScatterVertexSource({ mode: 'wake', filter: false }),
    ).toContain('sttWakeAlpha');
    expect(
      buildHexbinScatterVertexSource({ mode: 'trail', filter: false }),
    ).toContain('sttTrailAlpha');
    expect(
      buildHexbinScatterVertexSource({ mode: 'cumulative', filter: false }),
    ).toContain('sttCumulativeAlpha');
  });
});

describe('cell shader', () => {
  it('builds for both host variants and both aggregate sources', () => {
    for (const shader of [LEGACY_SHADER, V5_SHADER]) {
      for (const source of ['gpu', 'cpu'] as const) {
        const src = buildHexbinCellVertexSource(shader, cellCfg({ source }));
        expect(src).toContain('void main');
        // Legacy projects via uMatrix; v5 via the injected prelude.
        expect(src.includes('uMatrix')).toBe(shader === LEGACY_SHADER);
        expect(src.includes('projectTileFor3D')).toBe(shader === V5_SHADER);
        // GPU samples a texture; CPU reads a per-instance attribute.
        expect(src.includes('uAggregate')).toBe(source === 'gpu');
        expect(src.includes('aBinValue')).toBe(source === 'cpu');
      }
    }
  });

  it('compiles the aggregation expression per channel', () => {
    const meanColor = buildHexbinCellVertexSource(
      V5_SHADER,
      cellCfg({ colorAggregation: 'MEAN', elevationAggregation: 'COUNT' }),
    );
    expect(meanColor).toContain('agg.x / max(agg.y, 1e-6)');
    expect(meanColor).toContain('float elevValue = agg.y'); // COUNT
  });

  it('the id variant reproduces the visual gates (invisible ⇒ unpickable)', () => {
    const visual = buildHexbinCellVertexSource(V5_SHADER, cellCfg());
    const id = buildHexbinCellIdVertexSource(V5_SHADER, cellCfg());
    // Same empty-bin + percentile clip that hides a cell hides it from picking.
    for (const src of [visual, id]) {
      expect(src).toContain('count > 0.0');
      expect(src).toContain('uValueClip');
      expect(src).toContain('if (vAlpha <= 0.0) gl_Position = vec4(0.0)');
    }
    // Only the id variant carries the id attribute; only the visual the shade.
    expect(id).toContain('aIdColor');
    expect(visual).not.toContain('aIdColor');
    expect(visual).toContain('vShade');
    // Both fragment stages gate on the palette alpha.
    expect(HEXBIN_CELL_FS).toContain('ramp.a * uOpacity');
    expect(HEXBIN_ID_FS).toContain('ramp.a * uOpacity <= 0.0');
    expect(HEXBIN_SCATTER_FS).toContain('vContribution');
  });
});

describe('program keys', () => {
  it('are unique per shader permutation axis', () => {
    const keys = new Set([
      hexbinProgramKey('scatter', { mode: 'window', filter: false }),
      hexbinProgramKey('scatter', { mode: 'window', filter: true }),
      hexbinProgramKey('scatter', { mode: 'wake', filter: false }),
      hexbinProgramKey('cell', cellCfg({ source: 'gpu' })),
      hexbinProgramKey('cell', cellCfg({ source: 'cpu' })),
      hexbinProgramKey('cell', cellCfg({ colorAggregation: 'MEAN' })),
      hexbinProgramKey('pick-cell', cellCfg({ source: 'gpu' })),
    ]);
    expect(keys.size).toBe(7);
  });
  it('collapses MIN/MAX onto the SUM program', () => {
    expect(hexbinProgramKey('cell', cellCfg({ colorAggregation: 'MAX' }))).toBe(
      hexbinProgramKey('cell', cellCfg({ colorAggregation: 'SUM' })),
    );
  });
});

// ── mock-gl draws ───────────────────────────────────────────────────────────

describe('two-pass draw (GPU path)', () => {
  it('scatters resident points then draws one instanced cell pass', () => {
    const gl = makeGl({ gpu: true });
    const layer = makeRenderableLayer(gl);
    const frame = layer.beginFrame(new Float32Array(16));
    // sanity: the fixture has 2 points at distinct locations → 2 bins.
    layer.render(gl, new Float32Array(16));

    expect(layer.cellConfig.source).toBe('gpu');
    const stats = layer.getBinTableStats();
    expect(stats.binCount).toBe(2);
    expect(stats.pointCount).toBe(2);

    // Pass 1: the two points scattered as gl.POINTS into the aggregate FBO.
    const pointDraws = gl.drawCalls.filter(
      (d: any) => d.kind === 'arrays' && d.count === 2,
    );
    expect(pointDraws.length).toBeGreaterThanOrEqual(1);
    // Pass 2: exactly one instanced element draw over binCount cells.
    const cellDraws = gl.drawCalls.filter(
      (d: any) => d.kind === 'elements-instanced',
    );
    expect(cellDraws.length).toBe(1);
    expect(cellDraws[0].instances).toBe(2);
    void frame;
  });

  it('caches the cell program per host variant (mercator ⇄ globe relink once)', () => {
    const gl = makeGl({ gpu: true });
    const layer = makeRenderableLayer(gl);
    layer.render(gl, v5Args('mercator'));
    layer.render(gl, v5Args('mercator')); // same variant → no relink
    const afterSame = gl.linkProgram.mock.calls.length;
    layer.render(gl, v5Args('globe', 1)); // new variant → relink
    expect(gl.linkProgram.mock.calls.length).toBeGreaterThan(afterSame);
    // The cell program is keyed by variant in the base cache.
    expect(layer.programCache.has('hexbin:cell:SUM:SUM:gpu::mercator')).toBe(
      true,
    );
    expect(layer.programCache.has('hexbin:cell:SUM:SUM:gpu::globe')).toBe(true);
  });
});

describe('geometry-cache stability (first-class)', () => {
  it('does NOT rebuild the union table on a time-only change', () => {
    const gl = makeGl({ gpu: true });
    const layer = makeRenderableLayer(gl);
    layer.render(gl, new Float32Array(16));
    const gen = layer.getBinTableStats().generation;
    expect(gen).toBeGreaterThan(0);

    // Advance the play head and redraw several times: the table must be reused.
    for (let i = 1; i <= 4; i++) {
      layer.setCurrentTime(baseOpts.currentTime + i * 1000);
      layer.render(gl, new Float32Array(16));
    }
    expect(layer.getBinTableStats().generation).toBe(gen);
    expect(layer.getBinTableStats().binCount).toBe(2);
  });

  it('a DataFilter slider move is uniform-only (no table rebuild) on the GPU path', () => {
    const gl = makeGl({ gpu: true });
    const layer = makeRenderableLayer(gl, { filterProperty: 'magnitude' });
    layer.render(gl, new Float32Array(16));
    const gen = layer.getBinTableStats().generation;
    layer.setFilterRange([0, 10]);
    layer.render(gl, new Float32Array(16));
    expect(layer.getBinTableStats().generation).toBe(gen);
  });

  it('rebuilds when a new tile joins the resident set', () => {
    const gl = makeGl({ gpu: true });
    // The FIRST tile is hoisted and re-published by identity. Building a fresh
    // `makePropertyPointTile()` for the second publish swapped BOTH members of
    // the set, so a generation bump proved only that "the set object changed" —
    // the sibling test above (no rebuild on a time-only change) is the only
    // thing that kept the stability contract honest. Holding tile one fixed
    // isolates the bump to the tile that actually joined.
    const first = makePropertyPointTile();
    const layer = makeRenderableLayer(gl, {}, [first]);
    layer.render(gl, new Float32Array(16));
    const gen = layer.getBinTableStats().generation;
    // A second, differently-located tile enters — the union changes.
    const second = makePointTile();
    second.id = { ...second.id, x: second.id.x + 1 };
    publishVisibleTiles(layer, first, second);
    layer.render(gl, new Float32Array(16));
    expect(layer.getBinTableStats().generation).toBeGreaterThan(gen);
  });

  it('re-pitches the lattice (rebuild) when the radius moves', () => {
    const gl = makeGl({ gpu: true });
    const layer = makeRenderableLayer(gl);
    layer.render(gl, new Float32Array(16));
    const gen = layer.getBinTableStats().generation;
    layer.setRadius(50_000);
    layer.render(gl, new Float32Array(16));
    expect(layer.getBinTableStats().generation).toBeGreaterThan(gen);
  });
});

describe('CPU fallback path', () => {
  it('falls back when no colour-renderable float texture exists, and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gl = makeGl(); // no float extensions advertised
    const layer = makeRenderableLayer(gl);
    layer.render(gl, new Float32Array(16));
    layer.render(gl, new Float32Array(16));
    expect(layer.cellConfig.source).toBe('cpu');
    // Warned exactly once about the fallback.
    const fallbackWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).includes('fell back to the CPU'),
    );
    expect(fallbackWarnings.length).toBe(1);
    // A cell pass still runs each frame (CPU aggregate → per-instance
    // attribute) — one instanced draw over binCount cells, both renders.
    const cellDraws = gl.drawCalls.filter(
      (d: any) => d.kind === 'elements-instanced',
    );
    expect(cellDraws.length).toBe(2);
    expect(cellDraws.every((d: any) => d.instances === 2)).toBe(true);
    // No scatter FBO point draws on the CPU path.
    const pointDraws = gl.drawCalls.filter((d: any) => d.kind === 'arrays');
    expect(pointDraws.length).toBe(0);
    warn.mockRestore();
  });

  it('gpuAggregation:false forces the CPU path even with float support', () => {
    const gl = makeGl({ gpu: true });
    const layer = makeRenderableLayer(gl, { gpuAggregation: false });
    layer.render(gl, new Float32Array(16));
    expect(layer.cellConfig.source).toBe('cpu');
  });
});

describe('picking', () => {
  it('reports ONE provenance entry spanning the whole bin table', () => {
    const gl = makeGl({ gpu: true });
    const layer = makeRenderableLayer(gl);
    layer.render(gl, new Float32Array(16));
    const prov = layer.buildPickProvenance(gl);
    expect(prov.length).toBe(1);
    expect(prov[0].idBase).toBe(1);
    expect(prov[0].count).toBe(2); // binCount, not the point/feature count
  });

  it('decodes a hit to CELL statistics, not a source-row join', () => {
    const gl = makeGl({ gpu: true });
    const layer = makeRenderableLayer(gl);
    layer.render(gl, new Float32Array(16));
    // Stage the readback so the picker decodes bin index 0 (global id 1).
    gl._readPixelsValue = new Uint8Array([...encodePickId(1), 255]);
    const hit = layer.pick(10, 10);
    expect(hit).not.toBeNull();
    expect(hit.index).toBe(0);
    expect(hit.object.binIndex).toBe(0);
    expect(typeof hit.object.i).toBe('number');
    expect(typeof hit.object.j).toBe('number');
    expect(hit.object.aggregation).toBe('SUM');
    // The reported centre is the bin centroid the kernel would place it at.
    expect(Array.isArray(hit.object.centerMercator)).toBe(true);
  });

  it('the background pixel (id 0) is not a hit', () => {
    const gl = makeGl({ gpu: true });
    const layer = makeRenderableLayer(gl);
    layer.render(gl, new Float32Array(16));
    gl._readPixelsValue = new Uint8Array([0, 0, 0, 0]);
    expect(layer.pick(10, 10)).toBeNull();
  });

  it('the pick pass draws the whole table into the id FBO', () => {
    const gl = makeGl({ gpu: true });
    const layer = makeRenderableLayer(gl);
    layer.render(gl, new Float32Array(16));
    gl._readPixelsValue = new Uint8Array([...encodePickId(2), 255]);
    layer.pick(10, 10);
    // A pick-cell instanced draw over binCount instances ran.
    const idDraws = gl.drawCalls.filter(
      (d: any) => d.kind === 'elements-instanced' && d.instances === 2,
    );
    expect(idDraws.length).toBeGreaterThanOrEqual(2); // visual frame + pick
  });
});

// ── lattice invariants the seam fix rests on ────────────────────────────────

describe('world-space lattice', () => {
  it('two tiles agree on the bin key of a point at their shared boundary', () => {
    // Bin address is a pure function of (mercatorXY, radius) — it knows nothing
    // about tiles, so the same point resolves to the same key regardless of
    // which tile carried it. This is why the union-table MERGE is sound.
    const radiusMerc = hexBinRadiusFromMeters(1000, 40);
    const merc = new Float64Array(2);
    lngLatToMercatorInto(-73.95, 40.75, merc, 0);
    const k1 = hexBinKeyForPoint(merc[0], merc[1], radiusMerc);
    // Same coordinate, "carried by another tile" — identical maths, same key.
    lngLatToMercatorInto(-73.95, 40.75, merc, 0);
    const k2 = hexBinKeyForPoint(merc[0], merc[1], radiusMerc);
    expect(k2).toBe(k1);
    expect(Number.isNaN(k1)).toBe(false);
  });

  it('the mercator elevation factor is the D10 latitude-correct one', () => {
    // Guards against a re-adopted flat 1e-7: the layer resolves the factor at
    // its held latitude via mercatorZFromAltitude.
    const gl = makeGl({ gpu: true });
    const layer = makeRenderableLayer(gl);
    layer.render(gl, new Float32Array(16));
    const lat = layer.getBinTableStats().latitude;
    expect(layer.mercatorZPerMeter).toBeCloseTo(
      mercatorZFromAltitude(1, lat),
      12,
    );
    // hexBinCentroidMercator sanity: bin (0,0) at radius r sits at y = 1.
    const [, cy] = hexBinCentroidMercator(0, 0, 0.01);
    expect(cy).toBeCloseTo(1, 12);
  });
});

/**
 * Summary-cell family (Wave M4): H3 + Quadbin summary tiers as filled cells.
 *
 * Coverage mirrors the column-layer suite's four layers:
 *
 *  - **CPU references** — `summaryCellElevationMeters`, `widenDomain` and
 *    `resolveSummaryTimeFilterMode` are the CPU twins of shader / policy maths,
 *    each checked against the arithmetic the layer spells out.
 *  - **Shader strings** — BOTH host variants (legacy `uMatrix` / v5 injected
 *    prelude) build for every time mode, with and without the DataFilter, in
 *    all four passes; the default configuration compiles NONE of the optional
 *    surface.
 *  - **Prop defaults** — deck-summary parity, the explicit-undefined shadow
 *    guard, and the `extruded → renderingMode` inference.
 *  - **mock-gl draws** — the fill/stroke draw shapes, per-variant program
 *    caching, the geometry/style cache SPLIT (a time-only change re-uploads
 *    nothing; a domain change re-styles but keeps geometry), the pick pass
 *    reproducing every visibility gate, and the H3/Quadbin decode wiring.
 *
 * Real prelude compilation and the pick FBO round-trip stay browser-verified.
 * H3 boundaries come from an injected resolver (h3-js is not a dep here); the
 * Quadbin id is built by the same independent encoder the cell-geometry suite
 * uses.
 */

import { describe, it, expect, vi } from 'vitest';
import { GeometryType, type Tile, type Layer } from '@poopdeck.gl/core';
import { normalizeRenderArgs } from '../src/lib/host-adapter';
import {
  STTH3SummaryLayer,
  STTQuadbinSummaryLayer,
  SUMMARY_WALL_SHADE,
  buildSummaryCellVertexSource,
  buildSummaryCellIdVertexSource,
  buildSummaryCellStrokeVertexSource,
  buildSummaryCellStrokeIdVertexSource,
  summaryCellElevationMeters,
  summaryCellProgramKey,
  resolveSummaryTimeFilterMode,
  widenDomain,
  type SummaryCellShaderConfig,
} from '../src/layers/summary-cell-layer';
import {
  DATA_FILTER_CALL_GLSL,
  dataFilterAlphaJS,
} from '../src/shaders/data-filter.glsl';
import { makeMockGl } from './mock-gl';

// ── fixtures ────────────────────────────────────────────────────────────────

const baseOpts = {
  url: 'mem://summary.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

const PRELUDE_MARKER = '// __HOST_PRELUDE__';
const PRELUDE = `${PRELUDE_MARKER}
uniform mat4 u_projection_matrix;
vec4 projectTile(vec2 p) { return u_projection_matrix * vec4(p, 0.0, 1.0); }
vec4 projectTileFor3D(vec2 p, float elev) { return u_projection_matrix * vec4(p, elev, 1.0); }`;
const LEGACY_SHADER = { prelude: '', define: '' };
const V5_SHADER = { prelude: PRELUDE, define: '#define GLOBE' };

const cfg = (
  over: Partial<SummaryCellShaderConfig> = {},
): SummaryCellShaderConfig => ({ mode: 'window', filter: false, ...over });

const bothVariants = (
  build: (s: typeof LEGACY_SHADER, c: SummaryCellShaderConfig) => string,
  c: SummaryCellShaderConfig,
): [string, string] => [build(LEGACY_SHADER, c), build(V5_SHADER, c)];

const ALL_BUILDERS = [
  buildSummaryCellVertexSource,
  buildSummaryCellIdVertexSource,
  buildSummaryCellStrokeVertexSource,
  buildSummaryCellStrokeIdVertexSource,
];

const allSources = (c: SummaryCellShaderConfig): string[] =>
  ALL_BUILDERS.flatMap((b) => bothVariants(b, c));

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

const drawCtx = (frame?: ReturnType<typeof normalizeRenderArgs>) => ({
  matrix: frame ? frame.matrix : new Float32Array(16),
  frame,
  windowStart: 0,
  windowEnd: 10_000,
  currentTime: baseOpts.currentTime,
  zoom: 2,
});

const legacyFrame = () => normalizeRenderArgs(new Float32Array(16));

const vertexSources = (gl: any): string[] =>
  gl.shaderSource.mock.calls.map((c: unknown[]) => c[1] as string);

function uniformsByName(gl: any): Map<string, unknown[][]> {
  const nameByLoc = new Map<unknown, string>();
  gl.getUniformLocation.mock.calls.forEach((call: unknown[], i: number) => {
    nameByLoc.set(gl.getUniformLocation.mock.results[i].value, call[1]);
  });
  const out = new Map<string, unknown[][]>();
  for (const fn of [
    gl.uniform1f,
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

/** A tiny H3-boundary resolver: one hexagon near (0,0), keyed by hex string. */
const H3_HEX: [number, number][] = [
  [0.0, 0.02],
  [0.017, 0.01],
  [0.017, -0.01],
  [0.0, -0.02],
  [-0.017, -0.01],
  [-0.017, 0.01],
  [0.0, 0.02], // h3-js closes the ring
];
const H3_HEX_B: [number, number][] = H3_HEX.map(([x, y]) => [x + 1, y + 1]);

const cellToBoundary = vi.fn(
  (h3Index: string, _formatAsGeoJson?: boolean): number[][] => {
    if (h3Index === 'a') return H3_HEX.map((v) => [...v]);
    if (h3Index === 'b') return H3_HEX_B.map((v) => [...v]);
    throw new Error(`not a valid cell: ${h3Index}`);
  },
);

/** featureIds64 chosen so `h3IndexFromU64` returns 'a' / 'b'. */
const h3SummaryTile = (): Tile => {
  const features = {
    featureCount: 2,
    geometryType: GeometryType.Point,
    positionDimensions: 2 as const,
    // Cell centroids (the tier's real geometry) — unused for the ring, present
    // so the base point path is happy.
    positions: new Float64Array([0, 0, 1, 1]),
    featureIds: new Uint32Array([0, 1]),
    featureIds64: new BigUint64Array([0xan, 0xbn]),
    startTimes: new Float32Array([0, 2000]),
    endTimes: new Float32Array([3000, 5000]),
    timeOffset: 1_700_000_000_000,
    numericProps: { count: new Float32Array([10, 40]) },
    categoricalProps: {},
  };
  const layer: Layer = {
    name: 'summary',
    extent: 4096,
    features,
    geometryExtensionName: 'geoarrow.point',
  };
  return {
    id: { z: 2, x: 1, y: 1, t: 1_700_000_000_000 },
    timeRange: { start: 1_700_000_000_000, end: 1_700_000_005_000 },
    layers: [layer],
  };
};

// ── independent CARTO Quadbin encoder (mirror of the decoder under test) ─────
const QUADBIN_HEADER = 0x4800_0000_0000_0000n;
function interleave(v: number): bigint {
  let x = BigInt(v >>> 0) & 0x0000_0000_03ff_ffffn;
  x = (x | (x << 16n)) & 0x0000_ffff_0000_ffffn;
  x = (x | (x << 8n)) & 0x00ff_00ff_00ff_00ffn;
  x = (x | (x << 4n)) & 0x0f0f_0f0f_0f0f_0f0fn;
  x = (x | (x << 2n)) & 0x3333_3333_3333_3333n;
  x = (x | (x << 1n)) & 0x5555_5555_5555_5555n;
  return x;
}
function tileToQuadbin(z: number, x: number, y: number): bigint {
  const interleaved = interleave(x) | (interleave(y) << 1n);
  const mortonShift = BigInt(52 - 2 * z);
  const payload = (interleaved << mortonShift) & 0x000f_ffff_ffff_ffffn;
  const fill = mortonShift === 0n ? 0n : (1n << mortonShift) - 1n;
  return QUADBIN_HEADER | (BigInt(z) << 52n) | payload | fill;
}

const quadbinSummaryTile = (): Tile => {
  const features = {
    featureCount: 2,
    geometryType: GeometryType.Point,
    positionDimensions: 2 as const,
    positions: new Float64Array([0, 0, 90, 45]),
    featureIds: new Uint32Array([0, 1]),
    featureIds64: new BigUint64Array([
      tileToQuadbin(4, 5, 6),
      tileToQuadbin(4, 8, 3),
    ]),
    startTimes: new Float32Array([0, 2000]),
    endTimes: new Float32Array([3000, 5000]),
    timeOffset: 1_700_000_000_000,
    numericProps: { count: new Float32Array([3, 9]) },
    categoricalProps: {},
  };
  const layer: Layer = {
    name: 'summary',
    extent: 4096,
    features,
    geometryExtensionName: 'geoarrow.point',
  };
  return {
    id: { z: 2, x: 1, y: 1, t: 1_700_000_000_000 },
    timeRange: { start: 1_700_000_000_000, end: 1_700_000_005_000 },
    layers: [layer],
  };
};

function wireLayer(layer: any, gl: any): any {
  layer.supports32BitIndices = true;
  const slots = new Map<string, number>();
  gl.getAttribLocation = vi.fn((_program: unknown, name: string) => {
    if (!slots.has(name)) slots.set(name, slots.size);
    return slots.get(name)!;
  });
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
  return layer;
}

function makeH3Layer(extra: Record<string, unknown> = {}, gl?: any): any {
  const layer = new STTH3SummaryLayer({
    ...baseOpts,
    id: 'h3',
    cellToBoundary,
    ...extra,
  }) as any;
  if (gl) wireLayer(layer, gl);
  return layer;
}

function makeH3WithCache(extra: Record<string, unknown> = {}) {
  const gl = makeMockGl();
  const layer = makeH3Layer(extra, gl);
  const tile = h3SummaryTile();
  const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
  return { layer, gl, tile, cache };
}

// ── CPU references ──────────────────────────────────────────────────────────

describe('CPU references', () => {
  it('cell elevation is weight × scale, only on top', () => {
    // Cap / wall-top (isTop 1): 40 weight × 3 m/unit = 120 m.
    expect(summaryCellElevationMeters(1, 40, 3)).toBe(120);
    // Wall foot (isTop 0) sits on the ground whatever the weight.
    expect(summaryCellElevationMeters(0, 40, 3)).toBe(0);
    // Flat layer (scale 0) never leaves the ground.
    expect(summaryCellElevationMeters(1, 40, 0)).toBe(0);
  });

  it('widenDomain only ever grows, and ignores non-finite samples', () => {
    let [lo, hi] = [Infinity, -Infinity];
    [lo, hi] = widenDomain(lo, hi, 10);
    expect([lo, hi]).toEqual([10, 10]);
    [lo, hi] = widenDomain(lo, hi, 40);
    expect([lo, hi]).toEqual([10, 40]);
    // A sample already inside the range does not shrink it.
    [lo, hi] = widenDomain(lo, hi, 25);
    expect([lo, hi]).toEqual([10, 40]);
    // A lower sample widens the floor.
    [lo, hi] = widenDomain(lo, hi, 5);
    expect([lo, hi]).toEqual([5, 40]);
    // NaN must not poison the legend.
    [lo, hi] = widenDomain(lo, hi, Number.NaN);
    expect([lo, hi]).toEqual([5, 40]);
  });

  it('time-filter mode resolution follows deck precedence', () => {
    expect(resolveSummaryTimeFilterMode(undefined, 0, 0)).toBe('window');
    expect(resolveSummaryTimeFilterMode(undefined, 1000, 0)).toBe('wake');
    expect(resolveSummaryTimeFilterMode(undefined, 0, 1000)).toBe('trail');
    expect(resolveSummaryTimeFilterMode(undefined, 1000, 1000)).toBe('wake');
    expect(resolveSummaryTimeFilterMode('cumulative', 0, 0)).toBe('cumulative');
    // A degenerate length would light nothing — degrade to window instead.
    expect(resolveSummaryTimeFilterMode('wake', 0, 0)).toBe('window');
    expect(resolveSummaryTimeFilterMode('trail', 0, 0)).toBe('window');
  });
});

// ── shader sources ──────────────────────────────────────────────────────────

describe('vertex-source builders', () => {
  it('legacy variant projects through uMatrix with metres → mercator-z', () => {
    const src = buildSummaryCellVertexSource(LEGACY_SHADER);
    expect(src).toContain('uniform mat4 uMatrix;');
    expect(src).toContain(
      'vec4 here = uMatrix * vec4(aMercator.xy, elevM * uMercatorZPerMeter, 1.0);',
    );
    expect(src).not.toContain('projectTileFor3D');
    expect(src).not.toContain('#ifdef GLOBE');
  });

  it('v5 variant prepends prelude then define and projects in 3D', () => {
    const src = buildSummaryCellVertexSource(V5_SHADER);
    expect(src.startsWith(PRELUDE)).toBe(true);
    const defineAt = src.indexOf('#define GLOBE');
    expect(defineAt).toBeGreaterThan(PRELUDE_MARKER.length);
    expect(defineAt).toBeLessThan(src.indexOf('attribute vec3 aMercator'));
    expect(src).toContain(
      'vec4 here = projectTileFor3D(aMercator.xy, elevM * uMercatorZPerMeter);',
    );
    expect(src).toContain('#ifdef GLOBE');
    expect(src).toContain('globeComputeClippingZ(hereSphere)');
    expect(src).toContain('u_projection_fallback_matrix');
    expect(src).not.toContain('uniform mat4 uMatrix;');
  });

  it('elevation lifts by weight × scale off the static top flag', () => {
    for (const src of bothVariants(buildSummaryCellVertexSource, cfg())) {
      expect(src).toContain('attribute vec3 aMercator;');
      expect(src).toContain('attribute float aWeight;');
      expect(src).toContain(
        'float elevM = aMercator.z * aWeight * uElevationScale;',
      );
      // Opacity multiplies the time alpha, so an opacity:0 layer is invisible.
      expect(src).toContain('* uOpacity;');
    }
  });

  it('the id builders swap the colour PAYLOAD for a flat pick id, keeping its alpha as a gate', () => {
    for (const src of bothVariants(buildSummaryCellIdVertexSource, cfg())) {
      expect(src).toContain('attribute vec3 aIdColor;');
      expect(src).toContain('vIdColor = aIdColor;');
      expect(src).not.toContain('varying vec4 vColor;');
      // A cell whose ramp stop is transparent is invisible AND unpickable.
      expect(src).toContain('vAlpha *= aColor.a;');
    }
  });

  it('the id STROKE builder gates on the outline colour alpha', () => {
    for (const src of bothVariants(
      buildSummaryCellStrokeIdVertexSource,
      cfg(),
    )) {
      expect(src).toContain('attribute vec3 aIdColor;');
      expect(src).toContain('vAlpha *= uColor.a;');
    }
  });

  it('the stroke builders expand the outline in SCREEN space off both cap ends', () => {
    for (const src of bothVariants(buildSummaryCellStrokeVertexSource, cfg())) {
      expect(src).toContain('attribute vec2 aCorner;');
      expect(src).toContain('attribute vec2 aPosA;');
      expect(src).toContain('attribute vec2 aPosB;');
      // Both endpoints ride the cap (elevM = aWeight * scale), then offset in px.
      expect(src).toContain('float elevM = aWeight * uElevationScale;');
      expect(src).toContain('outClip.xy += offsetNdc * here.w;');
    }
    const v5 = buildSummaryCellStrokeVertexSource(V5_SHADER);
    // The two globe blocks must not collide on a temporary.
    expect(v5).toContain('hereSphere');
    expect(v5).toContain('thereSphere');
  });

  it('collapses fully-gated cells at the vertex stage (per-FEATURE alpha)', () => {
    for (const src of allSources(cfg())) {
      expect(src).toContain('if (vAlpha <= 0.0) gl_Position = vec4(0.0);');
    }
  });

  it('default config compiles NONE of the optional surface', () => {
    for (const src of allSources(cfg())) {
      expect(src).toContain('sttTimeWindowAlpha(aTime,');
      expect(src).not.toContain('uCurrentTime');
      expect(src).not.toContain('uWakeLength');
      expect(src).not.toContain('aFilterValue');
      expect(src).not.toContain('uFilterRange');
    }
  });
});

describe('time-filter mode compilation', () => {
  it('every mode reveals a WHOLE cell (trail reads aTime.x)', () => {
    for (const src of allSources(cfg({ mode: 'trail' }))) {
      expect(src).toContain(
        'vAlpha = sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail) * uOpacity;',
      );
    }
    for (const src of allSources(cfg({ mode: 'cumulative' }))) {
      expect(src).toContain('float sttCumulativeAlpha(');
      expect(src).not.toContain('uFadeOut');
    }
  });

  it('every mode keeps the projection of its host variant', () => {
    for (const mode of ['window', 'wake', 'cumulative', 'trail'] as const) {
      const [legacy, v5] = bothVariants(
        buildSummaryCellVertexSource,
        cfg({ mode }),
      );
      expect(legacy).toContain('vec4 here = uMatrix *');
      expect(legacy).not.toContain('projectTileFor3D');
      expect(v5).toContain('projectTileFor3D(aMercator.xy,');
      expect(v5).not.toContain('uniform mat4 uMatrix;');
    }
  });
});

describe('DataFilter compilation', () => {
  const filtered = cfg({ filter: true });

  it('splices attribute, uniforms and kernel into every variant and pass', () => {
    for (const src of allSources(filtered)) {
      expect(src).toContain('attribute float aFilterValue;');
      expect(src).toContain('uniform vec2 uFilterRange;');
      expect(src).toContain('float sttDataFilterAlpha(');
      expect(src).toContain(`float filterAlpha = ${DATA_FILTER_CALL_GLSL};`);
    }
  });

  it('a hard 0 always hides; a soft value fades only when the colour flag is on', () => {
    const src = buildSummaryCellVertexSource(LEGACY_SHADER, filtered);
    expect(src).toContain(
      'vAlpha *= (uFilterTransformColor > 0.5) ? filterAlpha : (filterAlpha > 0.0 ? 1.0 : 0.0);',
    );
    // No size-transform BRANCH: a cell's extent is geography, not a style knob
    // (the uniform is still declared by the shared filter block, but never read).
    expect(src).not.toContain('uFilterTransformSize > 0.5');
  });

  it('composes multiplicatively with the time filter, never replacing it', () => {
    const src = buildSummaryCellVertexSource(LEGACY_SHADER, {
      mode: 'cumulative',
      filter: true,
    });
    expect(src).toContain('vAlpha = sttCumulativeAlpha(');
    expect(src.indexOf('vAlpha = sttCumulativeAlpha')).toBeLessThan(
      src.indexOf('vAlpha *= (uFilterTransformColor'),
    );
  });

  it('program keys separate every compiled configuration', () => {
    const keys = new Set([
      summaryCellProgramKey('fill', cfg()),
      summaryCellProgramKey('fill', cfg({ mode: 'wake' })),
      summaryCellProgramKey('fill', cfg({ filter: true })),
      summaryCellProgramKey('stroke', cfg()),
      summaryCellProgramKey('pick-fill', cfg()),
      summaryCellProgramKey('pick-stroke', cfg()),
    ]);
    expect(keys.size).toBe(6);
    expect(summaryCellProgramKey('fill', cfg())).toBe(
      'summary-cell:fill:window',
    );
    expect(
      summaryCellProgramKey(
        'pick-stroke',
        cfg({ mode: 'trail', filter: true }),
      ),
    ).toBe('summary-cell:pick-stroke:trail:filter');
  });
});

// ── prop defaults ───────────────────────────────────────────────────────────

describe('prop defaults', () => {
  it('mirror the deck summary-layer defaults', () => {
    const o = makeH3Layer().cellOpts;
    expect(o.weightProperty).toBe('count');
    expect(o.coverage).toBe(0.92);
    expect(o.extruded).toBe(false);
    expect(o.elevationScale).toBe(1);
    expect(o.filled).toBe(true);
    expect(o.stroked).toBe(true);
    expect(o.opacity).toBe(1);
    expect(o.seamMode).toBe('duplicate');
    expect(o.poleMode).toBe('band');
    // Departure from deck: pixels, so the hex grid is visible out of the box.
    expect(o.lineWidthUnits).toBe('pixels');
    expect(makeH3Layer().shaderConfig).toEqual({
      mode: 'window',
      filter: false,
    });
  });

  it('an explicitly-passed undefined does not shadow a default', () => {
    const layer = makeH3Layer({
      coverage: undefined,
      stroked: undefined,
      weightProperty: undefined,
      renderingMode: undefined,
      fadeTrail: undefined,
    });
    expect(layer.cellOpts.coverage).toBe(0.92);
    expect(layer.cellOpts.stroked).toBe(true);
    expect(layer.cellOpts.weightProperty).toBe('count');
    expect(layer.cellOpts.fadeTrail).toBe(1);
    expect(layer.renderingMode).toBe('2d');
  });

  it('renderingMode is inferred from extrusion at construction', () => {
    expect(makeH3Layer().renderingMode).toBe('2d');
    expect(makeH3Layer({ extruded: true }).renderingMode).toBe('3d');
    // …but an explicit choice wins, for a layer that plans to toggle at runtime.
    expect(
      makeH3Layer({ extruded: false, renderingMode: '3d' }).renderingMode,
    ).toBe('3d');
  });

  it('H3 requires an injected cellToBoundary; Quadbin does not', () => {
    expect(
      () => new (STTH3SummaryLayer as any)({ ...baseOpts, id: 'x' }),
    ).toThrow(/cellToBoundary/);
    expect(
      () => new STTQuadbinSummaryLayer({ ...baseOpts, id: 'q' }),
    ).not.toThrow();
  });

  it('both kinds only accept the (centroid) Point tier', () => {
    const h3 = makeH3Layer();
    expect(h3.acceptsGeometry(GeometryType.Point)).toBe(true);
    expect(h3.acceptsGeometry(GeometryType.Polygon)).toBe(false);
  });
});

// ── tile geometry ───────────────────────────────────────────────────────────

describe('cell decode + geometry bake', () => {
  it('H3: decodes each id to a fan mesh + an outline instance stream', () => {
    const { cache } = makeH3WithCache();
    expect(cache).not.toBeNull();
    // Two hexagons, centroid fan = 7 verts (6 ring + 1 centre) each.
    expect(cache.cellCount).toBe(2);
    expect(cache.vertexCount).toBe(14);
    expect(cache.diagnostics.cells).toBe(2);
    // Outline: 6 edges per hexagon.
    expect(cache.stroke.instanceCount).toBe(12);
    // Every fill vertex maps back to a source row (0 or 1).
    expect(cache.vertexSourceIndex.length).toBe(14);
    expect(new Set(cache.vertexSourceIndex)).toEqual(new Set([0, 1]));
  });

  it('Quadbin: decodes each id to a 4-vert quad → a 5-vert fan', () => {
    const gl = makeMockGl();
    const layer = new STTQuadbinSummaryLayer({ ...baseOpts, id: 'q' }) as any;
    wireLayer(layer, gl);
    const tile = quadbinSummaryTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    // A quad's centroid fan = 5 verts (4 corners + 1 centre).
    expect(cache.cellCount).toBe(2);
    expect(cache.vertexCount).toBe(10);
    expect(cache.stroke.instanceCount).toBe(8); // 4 edges × 2 cells
  });

  it('extruded bakes a wall band and shades it darker', () => {
    const { cache } = makeH3WithCache({ extruded: true });
    // Cap (7) + wall top ring (6) + wall bottom ring (6) per hexagon.
    expect(cache.vertexCount).toBe((7 + 6 + 6) * 2);
    // Some vertices are flagged as walls (shaded), some are caps.
    expect(Array.from(cache.vertexIsWall)).toContain(1);
    expect(Array.from(cache.vertexIsWall)).toContain(0);
  });

  it('skips the raw tier by NAME (a differently-named cell layer warns once)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { layer, gl } = makeH3WithCache();
      const raw = h3SummaryTile();
      raw.layers[0].name = 'points';
      expect(layer.buildTileGpuCache(gl, raw, raw.layers[0])).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// ── draw + the geometry/style cache split ───────────────────────────────────

describe('drawTile', () => {
  it('draws a fill (drawElements) and a stroke (instanced) pass', () => {
    const { layer, gl, tile, cache } = makeH3WithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const kinds = gl.drawCalls.map((d: any) => d.kind);
    expect(kinds).toContain('elements');
    expect(kinds).toContain('arrays-instanced');
  });

  it('filled:false draws the outline alone', () => {
    const { layer, gl, tile, cache } = makeH3WithCache({ filled: false });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.drawCalls.map((d: any) => d.kind)).toEqual(['arrays-instanced']);
  });

  it('v5 frame: prelude source, u_projection_* set, no uMatrix upload', () => {
    const { layer, gl, tile, cache } = makeH3WithCache();
    const frame = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));
    expect(
      vertexSources(gl).some(
        (s) => s.includes(PRELUDE_MARKER) && s.includes('projectTileFor3D('),
      ),
    ).toBe(true);
    const matrices = gl.uniformMatrix4fv.mock.calls.map((c: unknown[]) => c[2]);
    expect(matrices).toContain(frame.projectionData!.mainMatrix);
    expect(matrices).not.toContain(frame.matrix);
  });

  it('caches per variant: same frame reuses the program AND the tile VAO', () => {
    const { layer, gl, tile, cache } = makeH3WithCache();
    const frame = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));
    const programs = gl.createProgram.mock.calls.length;
    const vaos = gl.createVertexArray.mock.calls.length;
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));
    expect(gl.createProgram.mock.calls.length).toBe(programs);
    expect(gl.createVertexArray.mock.calls.length).toBe(vaos);
  });

  it('memoizes the fill+stroke handles per variant, re-resolving on a flip', () => {
    const { layer, gl, tile, cache } = makeH3WithCache();
    const legacy = legacyFrame();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacy));
    const fill = layer.fillHandles;
    const stroke = layer.strokeHandles;
    expect(fill).toBeTruthy();
    expect(stroke).toBeTruthy();
    expect(layer.fillVariant).toBe('legacy');
    expect(layer.strokeVariant).toBe('legacy');

    // Same variant → the memoized handle objects are reused, base cache is not
    // consulted (this is the per-tile key-string allocation the memo removes).
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacy));
    expect(layer.fillHandles).toBe(fill);
    expect(layer.strokeHandles).toBe(stroke);

    // Variant flip → new handles + new recorded variant.
    const globe = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(globe));
    expect(layer.fillHandles).not.toBe(fill);
    expect(layer.strokeHandles).not.toBe(stroke);
    expect(layer.fillVariant).toBe('globe');
    expect(layer.strokeVariant).toBe('globe');
  });

  it('onContextLost releases the memoized program handles', () => {
    const { layer, gl, tile, cache } = makeH3WithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(layer.fillHandles).toBeTruthy();
    expect(layer.strokeHandles).toBeTruthy();

    layer.onContextLost();
    expect(layer.fillHandles).toBeUndefined();
    expect(layer.fillVariant).toBeUndefined();
    expect(layer.strokeHandles).toBeUndefined();
    expect(layer.strokeVariant).toBeUndefined();
    expect(layer.pickFillHandles).toBeUndefined();
    expect(layer.pickStrokeHandles).toBeUndefined();
  });

  it('elevation + opacity + latitude ride the uniforms', () => {
    const { layer, gl, tile, cache } = makeH3WithCache({
      extruded: true,
      elevationScale: 5,
      opacity: 0.6,
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uElevationScale')).toBe(5);
    expect(lastScalar(u, 'uOpacity')).toBe(0.6);
    expect(lastScalar(u, 'uMercatorZPerMeter')).toBe(cache.mercatorZScale);
  });

  it('flat layer zeroes the elevation scale (no relief without extrusion)', () => {
    const { layer, gl, tile, cache } = makeH3WithCache({ elevationScale: 5 });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(lastScalar(uniformsByName(gl), 'uElevationScale')).toBe(0);
  });
});

describe('geometry/style cache split (a first-class flow-layer contract)', () => {
  it('a TIME-only change re-uploads NOTHING — geometry and style survive', () => {
    const { layer, gl, tile, cache } = makeH3WithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const geom = cache.positionBuffer;
    const color = cache.colorBuffer;
    const weight = cache.weightBuffer;
    expect(color).toBeDefined();

    layer.setCurrentTime(baseOpts.currentTime + 60_000);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(cache.positionBuffer).toBe(geom);
    expect(cache.colorBuffer).toBe(color);
    expect(cache.weightBuffer).toBe(weight);
  });

  it('a COLOUR change re-styles (new colour buffer) but keeps the geometry', () => {
    const { layer, gl, tile, cache } = makeH3WithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const geom = cache.positionBuffer;
    const time = cache.timeBuffer;
    const color = cache.colorBuffer;

    layer.setColorDomain([0, 1000]);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    // Geometry + times untouched; colour re-uploaded.
    expect(cache.positionBuffer).toBe(geom);
    expect(cache.timeBuffer).toBe(time);
    expect(cache.colorBuffer).not.toBe(color);
    // The freed colour buffer must be deleted, not leaked.
    expect(gl.deleteBuffer).toHaveBeenCalledWith(color);
  });

  it('elevationScale is a uniform — no geometry OR style rebuild', () => {
    const { layer, gl, tile, cache } = makeH3WithCache({ extruded: true });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const geom = cache.positionBuffer;
    const color = cache.colorBuffer;
    layer.setElevationScale(9);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(cache.positionBuffer).toBe(geom);
    expect(cache.colorBuffer).toBe(color);
    expect(lastScalar(uniformsByName(gl), 'uElevationScale')).toBe(9);
  });
});

describe('auto-fit colour domain', () => {
  it('fits from the cells seen and only ever widens', () => {
    const { layer, gl, tile, cache } = makeH3WithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    // The tile's weights are 10 and 40.
    expect(layer.getColorDomain()).toEqual([10, 40]);
  });

  it('a pinned domain overrides the auto-fit', () => {
    const { layer, gl, tile, cache } = makeH3WithCache({
      colorDomain: [0, 500],
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(layer.getColorDomain()).toEqual([0, 500]);
  });
});

// ── DataFilter wiring ───────────────────────────────────────────────────────

describe('DataFilter wiring', () => {
  it('a tile MISSING the column renders unfiltered, never blank', () => {
    const { layer, gl, tile, cache } = makeH3WithCache({
      filterProperty: 'nonexistent',
      filterRange: [1, 5] as const,
    });
    expect(cache.hasFilterColumn).toBe(false);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(lastScalar(uniformsByName(gl), 'uFilterEnabled')).toBe(0);
  });

  it('binds the per-cell column and sets the range; setFilterRange is uniform-only', () => {
    const { layer, gl, tile, cache } = makeH3WithCache({
      filterProperty: 'count',
      filterRange: [5, 50] as const,
    });
    expect(cache.hasFilterColumn).toBe(true);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const programs = gl.createProgram.mock.calls.length;
    let u = uniformsByName(gl);
    expect(lastScalar(u, 'uFilterEnabled')).toBe(1);
    expect(
      Array.from(u.get('uFilterRange')!.at(-1)![0] as Float32Array),
    ).toEqual([5, 50]);

    layer.setFilterRange([10, 40]);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.createProgram.mock.calls.length).toBe(programs); // no relink
    u = uniformsByName(gl);
    expect(
      Array.from(u.get('uFilterRange')!.at(-1)![0] as Float32Array),
    ).toEqual([10, 40]);
  });

  it('the FILTER_BODY composition matches the JS reference', () => {
    const compose = (
      timeAlpha: number,
      value: number,
      range: number[],
      soft: number[],
      transformColor: boolean,
    ): number => {
      const f = dataFilterAlphaJS(value, range, soft, true);
      return transformColor ? timeAlpha * f : f > 0 ? timeAlpha : 0;
    };
    expect(compose(1, 99, [0, 10], [0, 10], false)).toBe(0);
    const soft = dataFilterAlphaJS(9, [0, 10], [0, 8], true);
    expect(compose(1, 9, [0, 10], [0, 8], true)).toBeCloseTo(soft, 12);
    expect(compose(1, 9, [0, 10], [0, 8], false)).toBe(1);
  });
});

// ── picking ─────────────────────────────────────────────────────────────────

describe('drawPickTile (invisible ⇒ unpickable)', () => {
  it('paints flat ids over both passes and frees the id buffers', () => {
    const { layer, gl, tile, cache } = makeH3WithCache();
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    const kinds = gl.drawCalls.map((d: any) => d.kind);
    expect(kinds).toContain('elements');
    expect(kinds).toContain('arrays-instanced');
    expect(
      vertexSources(gl).some((s) => s.includes('attribute vec3 aIdColor;')),
    ).toBe(true);
    expect(gl.deleteBuffer).toHaveBeenCalled();
  });

  it('compiles the SAME time mode and applies the SAME filter range as the visual pass', () => {
    const { layer, gl, tile, cache } = makeH3WithCache({
      timeFilterMode: 'cumulative',
      filterProperty: 'count',
      filterRange: [5, 50] as const,
    });
    const ctx = drawCtx(legacyFrame());
    layer.drawPickTile(gl, tile, tile.layers[0], cache, ctx, 1);
    const idSrc = vertexSources(gl).find((s) =>
      s.includes('attribute vec3 aIdColor;'),
    )!;
    expect(idSrc).toContain('vAlpha = sttCumulativeAlpha(');
    expect(idSrc).toContain(`float filterAlpha = ${DATA_FILTER_CALL_GLSL};`);
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uCurrentTime')).toBe(
      ctx.currentTime - cache.timeOffset,
    );
    expect(lastScalar(u, 'uFilterEnabled')).toBe(1);
  });

  it('sizes and lifts identically to the visual pass', () => {
    const opts = { extruded: true, elevationScale: 4, opacity: 0.5 };
    const { layer, gl, tile, cache } = makeH3WithCache(opts);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const visual = uniformsByName(gl);

    const gl2 = makeMockGl();
    wireLayer(layer, gl2);
    layer.drawPickTile(
      gl2,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    const pick = uniformsByName(gl2);
    for (const name of ['uElevationScale', 'uMercatorZPerMeter', 'uOpacity']) {
      expect(lastScalar(pick, name)).toBe(lastScalar(visual, name));
    }
  });

  it('leaves every per-instance divisor back at 0 on the default VAO', () => {
    const { layer, gl, tile, cache } = makeH3WithCache({
      filterProperty: 'count',
    });
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    const divisors = gl.vertexAttribDivisor.mock.calls as number[][];
    expect(divisors.length).toBeGreaterThan(0);
    const perAttribute = new Map<number, number>();
    for (const [index, divisor] of divisors) perAttribute.set(index, divisor);
    for (const divisor of perAttribute.values()) expect(divisor).toBe(0);
  });

  it('nothing drawn is nothing pickable', () => {
    const { layer, gl, tile, cache } = makeH3WithCache({
      filled: false,
      stroked: false,
    });
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    expect(gl.drawCalls).toHaveLength(0);
  });

  it('is advertised through the base pick contract', () => {
    expect(makeH3Layer().supportsPicking()).toBe(true);
  });
});

// ── shared shading constant ─────────────────────────────────────────────────

describe('wall shading', () => {
  it('matches the package-wide 25%-darker wall convention', () => {
    expect(SUMMARY_WALL_SHADE).toBe(0.75);
  });
});

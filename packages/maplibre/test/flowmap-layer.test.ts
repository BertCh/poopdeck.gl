/**
 * Flowmap layer (maplibre parity campaign Wave M4, P2 tier) — animated OD flow
 * ARROWS whose width tracks the pair's trip volume at the playhead.
 *
 * Coverage, mirroring the arc/column suites:
 *
 *  - **CPU references** — the antimeridian unwrap, the baked-bundle control
 *    point, the arrow template, and the head/param/profile/magnitude-range
 *    helpers all have JS twins beside the GLSL, checked against closed forms.
 *  - **Shader strings** — BOTH host variants (legacy `uMatrix` / v5 injected
 *    prelude) build for every time mode, colour mode, magnitude source and the
 *    DataFilter/bundle axes, in the visual AND the id-pick pass (which shares
 *    the builder so the hit arrow cannot drift from the drawn one). The default
 *    configuration compiles the minimal surface.
 *  - **mock-gl draws** — the instanced draw shape, per-variant program caching
 *    and VAO invalidation, the magnitude texture wiring, the CPU fallback's
 *    sub-step-gated re-expansion, GEOMETRY CACHE STABILITY across a time-only
 *    change (the first-class flow-layer test), globe segment refinement, and the
 *    pick pass leaving no divisor dirty.
 *
 * Real prelude compilation and the pick FBO round-trip stay browser-verified.
 */

import { describe, it, expect, vi } from 'vitest';
import { GeometryType, type Tile, type Layer } from '@poopdeck.gl/core';
import {
  STTFlowmapLayer,
  buildFlowmapVertexSource,
  flowmapProgramKey,
  buildFlowArrowTemplate,
  flowArrowVertexCount,
  flowHeadFractionJS,
  flowArrowParamJS,
  flowArrowProfileJS,
  flowMagnitudeRange,
  bundleControlPoint,
  unwrapFlowMercatorX,
  resolveFlowmapTimeFilterMode,
  MAX_FLOWMAP_SEGMENTS,
  type FlowmapShaderConfig,
} from '../src/layers/flowmap-layer';
import { normalizeRenderArgs } from '../src/lib/host-adapter';
import { bucketPositionAt, deriveFlowAxis } from '../src/lib/flow-kernel';
import { makeMockGl, makeMockMap } from './mock-gl';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

const TIME_OFFSET = 1_700_000_000_000;

const PRELUDE_MARKER = '// __HOST_PRELUDE__';
const PRELUDE =
  `${PRELUDE_MARKER}\n` +
  'uniform mat4 u_projection_matrix;\n' +
  'vec4 projectTile(vec2 p) { return u_projection_matrix * vec4(p, 0.0, 1.0); }';
const LEGACY_SHADER = { prelude: '', define: '' };
const V5_SHADER = { prelude: PRELUDE, define: '#define GLOBE' };

const cfg = (over: Partial<FlowmapShaderConfig> = {}): FlowmapShaderConfig => ({
  mode: 'window',
  filter: false,
  colorMode: 'direction',
  bundle: true,
  magnitude: 'texture',
  format: 'float32',
  pick: false,
  ...over,
});

/** Both host variants of one configuration, for "identical in both" assertions. */
const bothVariants = (c: FlowmapShaderConfig): [string, string] => [
  buildFlowmapVertexSource(LEGACY_SHADER, c),
  buildFlowmapVertexSource(V5_SHADER, c),
];

/** Both variants of the visual AND the id pass. */
const allFour = (c: FlowmapShaderConfig): string[] => [
  ...bothVariants(c),
  ...bothVariants({ ...c, pick: true }),
];

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

const drawCtx = (
  frame?: ReturnType<typeof normalizeRenderArgs>,
  currentTime = baseOpts.currentTime,
) => ({
  matrix: frame ? frame.matrix : new Float32Array(16),
  frame,
  windowStart: 0,
  windowEnd: 10_000,
  currentTime,
  zoom: 2,
});

const legacyFrame = () => normalizeRenderArgs(new Float32Array(16).fill(2));

/**
 * Two OD flows, each stored as a LineString. f0 SF → NYC is a plain 2-vertex
 * pair; f1 Tokyo → LA crosses the antimeridian AND carries an interior vertex
 * (a baked bundle apex the layer bends the arrow through). Each pair carries a
 * per-timestep value matrix (vertex-major, 3 buckets) whose SOURCE-vertex row is
 * the pair's own volume series.
 */
function makeFlowTile(): Tile {
  const positions = new Float64Array([
    // f0: SF → NYC (2 vertices)
    -122.4, 37.7, -73.95, 40.75,
    // f1: Tokyo → (bundle apex) → LA (3 vertices)
    139.7, 35.7, -179.0, 40.0, -118.24, 34.05,
  ]);
  const startIndices = new Uint32Array([0, 2, 5]);
  // 5 global vertices × 3 buckets, vertex-major. Only the SOURCE rows (0, 2)
  // are read for OD magnitude; the rest are filler.
  const vertexValueMatrix = new Float32Array([
    10,
    20,
    30, // v0 (f0 source)
    0,
    0,
    0, // v1
    40,
    50,
    60, // v2 (f1 source)
    0,
    0,
    0, // v3
    0,
    0,
    0, // v4
  ]);
  const features = {
    featureCount: 2,
    geometryType: GeometryType.LineString,
    positionDimensions: 2 as const,
    positions,
    startIndices,
    featureIds: new Uint32Array([0, 1]),
    startTimes: new Float32Array([0, 0]),
    endTimes: new Float32Array([3000, 3000]),
    timeOffset: TIME_OFFSET,
    vertexValueMatrix,
    vertexValueBuckets: 3,
    numericProps: {
      strength: new Float32Array([5, 40]),
    },
    categoricalProps: {
      mode: { indices: new Uint16Array([0, 1]), categories: ['bike', 'car'] },
    },
  };
  const layer: Layer = {
    name: 'flows',
    extent: 4096,
    features,
    geometryExtensionName: 'geoarrow.linestring',
  };
  return {
    id: { z: 2, x: 1, y: 1, t: TIME_OFFSET },
    timeRange: { start: TIME_OFFSET, end: TIME_OFFSET + 3000 },
    layers: [layer],
  };
}

/** A flow tile with a STATIC `vertexValues` column and no matrix. */
function makeStaticFlowTile(): Tile {
  const tile = makeFlowTile();
  const f = tile.layers[0].features as any;
  delete f.vertexValueMatrix;
  f.vertexValueBuckets = 0;
  f.vertexValues = new Float32Array([7, 0, 12, 0, 0]);
  return tile;
}

/** A flow tile with NO range-filterable columns. */
function makeBareFlowTile(): Tile {
  const tile = makeFlowTile();
  tile.layers[0].features.numericProps = {};
  return tile;
}

function wireMock(layer: any, gl: any): void {
  layer.supports32BitIndices = true;
  // The shared recorder hands every attribute location 0, which would make a
  // per-slot assertion (divisors!) vacuous — give each NAME its own slot.
  const slots = new Map<string, number>();
  gl.getAttribLocation = vi.fn((_program: unknown, name: string) => {
    if (!slots.has(name)) slots.set(name, slots.size + 1);
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
}

function makeLayer(extra: Record<string, unknown> = {}, tile = makeFlowTile()) {
  const layer = new STTFlowmapLayer({
    ...baseOpts,
    id: 'f',
    ...extra,
  } as any) as any;
  const gl = makeMockGl();
  wireMock(layer, gl);
  const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
  return { layer, gl, tile, cache };
}

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
    gl.uniform1i,
    gl.uniform2f,
    gl.uniform2fv,
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

// ── CPU references ──────────────────────────────────────────────────────────

describe('antimeridian unwrap', () => {
  it('takes the short way round', () => {
    // 0.98 → 0.02 across the seam should unwrap to 1.02 (0.04 away), not 0.96.
    expect(unwrapFlowMercatorX(0.98, 0.02)).toBeCloseTo(1.02, 12);
    expect(unwrapFlowMercatorX(0.02, 0.98)).toBeCloseTo(-0.02, 12);
    // Already close: unchanged.
    expect(unwrapFlowMercatorX(0.4, 0.45)).toBeCloseTo(0.45, 12);
  });
});

describe('bundle control point', () => {
  it('is the chord midpoint for a plain 2-vertex pair (⇒ a straight arrow)', () => {
    const [cx, cy] = bundleControlPoint(0, 0, 1, 1);
    expect(cx).toBeCloseTo(0.5, 12);
    expect(cy).toBeCloseTo(0.5, 12);
    // Midpoint control makes the quadratic Bézier reduce to the straight lerp:
    // B(t) = (1-t)^2 P0 + 2(1-t)t C + t^2 P2 = mix(P0, P2, t) when C = mid.
    // Here P0 = (0,0), P2 = (1,1), so B(t).x should equal t.
    for (const t of [0.25, 0.5, 0.75]) {
      const mt = 1 - t;
      const bx = 2 * mt * t * cx + t * t;
      expect(bx).toBeCloseTo(t, 12);
    }
  });

  it('passes the curve THROUGH the furthest interior vertex at t = 0.5', () => {
    // Apex at (0.5, 0.4), well off the chord (0,0)→(1,0). P0 = (0,0), P2 = (1,0),
    // so B(0.5) = 0.5·C + 0.25·P2 in x, and 0.5·C in y.
    const [cx, cy] = bundleControlPoint(0, 0, 1, 0, [0.5, 0.4]);
    const midX = 0.5 * cx + 0.25;
    const midY = 0.5 * cy;
    expect(midX).toBeCloseTo(0.5, 12);
    expect(midY).toBeCloseTo(0.4, 12);
  });

  it('picks the interior vertex furthest from the chord', () => {
    const [, cy] = bundleControlPoint(0, 0, 2, 0, [0.5, 0.1, 1.5, 0.6]);
    // The (1.5, 0.6) vertex is furthest; C.y = 2*0.6 - 0 = 1.2.
    expect(cy).toBeCloseTo(1.2, 12);
  });

  it('degrades non-finite input to the midpoint', () => {
    const [cx, cy] = bundleControlPoint(0, 0, 1, 1, [Number.NaN, 5]);
    expect(cx).toBeCloseTo(0.5, 12);
    expect(cy).toBeCloseTo(0.5, 12);
  });
});

describe('arrow template', () => {
  it('emits 2·(S+1) + 2·(H+1) vertices carrying (regionT, side, region)', () => {
    const t = buildFlowArrowTemplate(8, 1);
    expect(t.length).toBe(flowArrowVertexCount(8, 1) * 3);
    expect(flowArrowVertexCount(8, 1)).toBe(2 * 9 + 2 * 2); // 22
    // First shaft pair: regionT 0, sides -1/+1, region 0.
    expect(Array.from(t.subarray(0, 6))).toEqual([0, -1, 0, 0, 1, 0]);
    // Last shaft pair: regionT 1, region 0.
    const lastShaft = 2 * 9 - 2;
    expect(t[lastShaft * 3]).toBe(1);
    expect(t[lastShaft * 3 + 2]).toBe(0);
    // First head pair: region 1.
    const firstHead = 2 * 9;
    expect(t[firstHead * 3 + 2]).toBe(1);
  });

  it('clamps degenerate segment counts to ≥ 1', () => {
    expect(flowArrowVertexCount(0, 0)).toBe(2 * 2 + 2 * 2);
    expect(flowArrowVertexCount(Number.NaN, Number.NaN)).toBe(2 * 2 + 2 * 2);
  });
});

describe('arrow head / param / profile references', () => {
  it('caps the head at a fraction of the corridor length', () => {
    // 3 widths of 10 px over a 100 px corridor = 0.3, under the 0.4 cap.
    expect(flowHeadFractionJS(10, 3, 100, 0.4)).toBeCloseTo(0.3, 12);
    // A fat arrow on a short corridor saturates at the cap.
    expect(flowHeadFractionJS(40, 3, 100, 0.4)).toBeCloseTo(0.4, 12);
  });

  it('splits the path parameter between shaft and head', () => {
    const headFrac = 0.25;
    // Shaft spans [0, 0.75].
    expect(flowArrowParamJS(0, 0, headFrac)).toBeCloseTo(0, 12);
    expect(flowArrowParamJS(1, 0, headFrac)).toBeCloseTo(0.75, 12);
    // Head spans [0.75, 1].
    expect(flowArrowParamJS(0, 1, headFrac)).toBeCloseTo(0.75, 12);
    expect(flowArrowParamJS(1, 1, headFrac)).toBeCloseTo(1, 12);
  });

  it('ramps the shaft and flares-then-closes the head', () => {
    // Shaft: tailScale → 1.
    expect(flowArrowProfileJS(0, 0, 0.4, 2)).toBeCloseTo(0.4, 12);
    expect(flowArrowProfileJS(1, 0, 0.4, 2)).toBeCloseTo(1, 12);
    // Head: headWidth at the base, 0 at the tip.
    expect(flowArrowProfileJS(0, 1, 0.4, 2)).toBeCloseTo(2, 12);
    expect(flowArrowProfileJS(1, 1, 0.4, 2)).toBeCloseTo(0, 12);
  });
});

describe('magnitude range', () => {
  it('spans the finite values, honouring the absolute decode', () => {
    expect(flowMagnitudeRange([3, 1, 8, Number.NaN], 4, false)).toEqual([1, 8]);
    expect(flowMagnitudeRange([-3, 1, -8], 3, true)).toEqual([1, 8]);
  });
  it('is [0, 0] for empty / all-NaN input', () => {
    expect(flowMagnitudeRange([Number.NaN], 1, false)).toEqual([0, 0]);
    expect(flowMagnitudeRange([], 0, false)).toEqual([0, 0]);
  });
});

describe('compiled time mode resolution', () => {
  it('degrades wake/trail with a non-positive length to window (deck rule)', () => {
    expect(resolveFlowmapTimeFilterMode('wake', 0, 100)).toBe('window');
    expect(resolveFlowmapTimeFilterMode('wake', 100, 0)).toBe('wake');
    expect(resolveFlowmapTimeFilterMode('trail', 100, 0)).toBe('window');
    expect(resolveFlowmapTimeFilterMode('trail', 0, 100)).toBe('trail');
    expect(resolveFlowmapTimeFilterMode('cumulative', 0, 0)).toBe('cumulative');
  });
});

// ── shader assembly ─────────────────────────────────────────────────────────

describe('flowmap vertex-source builder', () => {
  it('legacy variant (empty prelude) keeps the uMatrix path', () => {
    const src = buildFlowmapVertexSource(LEGACY_SHADER);
    expect(src).toContain('uniform mat4 uMatrix;');
    expect(src).toContain('uMatrix * vec4(aSource, 0.0, 1.0)');
    expect(src).not.toContain('projectTile(');
  });

  it('v5 variant prepends prelude then define and projects via projectTile', () => {
    const src = buildFlowmapVertexSource(V5_SHADER);
    expect(src.startsWith(PRELUDE)).toBe(true);
    const defineAt = src.indexOf('#define GLOBE');
    expect(defineAt).toBeGreaterThan(PRELUDE_MARKER.length);
    expect(defineAt).toBeLessThan(src.indexOf('attribute vec3 aVertex'));
    // A flowmap arrow is a GROUND overlay: the 2D entry point (which overwrites
    // z for horizon clipping), never the 3D one.
    expect(src).toContain('projectTile(aSource)');
    expect(src).not.toContain('projectTileFor3D');
    expect(src).not.toContain('uniform mat4 uMatrix;');
  });

  it('width comes from the shared sttFlowWidth kernel, gated by minFlow', () => {
    for (const src of allFour(cfg())) {
      expect(src).toContain('float sttFlowWidth(');
      expect(src).toContain(
        'magnitude, uMinFlow, uWidthScale, uWidthExponent, uWidthClamp',
      );
    }
  });

  it('compiles EXACTLY ONE time kernel per program', () => {
    const kernels = {
      window: 'float sttTimeWindowAlpha(',
      wake: 'float sttWakeAlpha(',
      cumulative: 'float sttCumulativeAlpha(',
      trail: 'float sttTrailAlpha(',
    } as const;
    for (const mode of Object.keys(kernels) as (keyof typeof kernels)[]) {
      for (const src of allFour(cfg({ mode }))) {
        for (const [k, decl] of Object.entries(kernels)) {
          if (k === mode) expect(src).toContain(decl);
          else expect(src).not.toContain(decl);
        }
      }
    }
  });

  it('trail is per-VERTEX: the frontier walks the arrow parameter t', () => {
    for (const src of allFour(cfg({ mode: 'trail' }))) {
      expect(src).toContain(
        'sttTrailAlpha(mix(aTime.x, aTime.y, t), uCurrentTime, uTrailLength, uFadeTrail)',
      );
    }
  });

  it('wake narrows the arrow with the same alpha it fades by', () => {
    const src = buildFlowmapVertexSource(LEGACY_SHADER, cfg({ mode: 'wake' }));
    expect(src).toContain(
      'widthPx *= sttWakeSizeScale(timeAlpha, uWakeTailScale);',
    );
  });

  it('compiles the DataFilter branch only when asked, in every pass', () => {
    for (const src of allFour(cfg())) {
      expect(src).not.toContain('sttDataFilterAlpha(');
      expect(src).not.toContain('attribute float aFilterValue;');
    }
    for (const src of allFour(cfg({ filter: true }))) {
      expect(src).toContain('float sttDataFilterAlpha(');
      expect(src).toContain('attribute float aFilterValue;');
      // The per-FEATURE collapse (deck's vs:#main-end), never on the time alpha.
      expect(src).toContain('if (filterAlpha <= 0.0) gl_Position = vec4(0.0);');
    }
  });

  it('compiles the baked-bundle control point only when asked', () => {
    for (const src of allFour(cfg({ bundle: true }))) {
      expect(src).toContain('attribute vec2 aControl;');
      expect(src).toContain('2.0 * mt * t * aControl');
    }
    for (const src of allFour(cfg({ bundle: false }))) {
      expect(src).not.toContain('aControl');
      expect(src).toContain('return mix(aSource, aTarget, t);');
    }
  });

  it('emits the requested colour surface, and only that one', () => {
    const dir = buildFlowmapVertexSource(LEGACY_SHADER, cfg());
    expect(dir).toContain('mix(uSourceColor, uTargetColor, t)');
    expect(dir).not.toContain('uMagnitudeLowColor');
    expect(dir).not.toContain('attribute vec4 aColor;');

    const mag = buildFlowmapVertexSource(
      LEGACY_SHADER,
      cfg({ colorMode: 'magnitude' }),
    );
    expect(mag).toContain('uniform vec4 uMagnitudeLowColor;');
    expect(mag).toContain('sttFlowRampT(magnitude, uColorDomain, uColorGamma)');
    expect(mag).not.toContain('uSourceColor');

    const cat = buildFlowmapVertexSource(
      LEGACY_SHADER,
      cfg({ colorMode: 'category' }),
    );
    expect(cat).toContain('attribute vec4 aColor;');
    expect(cat).toContain('uniform float uUseFeatureColor;');
    // Category falls back to the direction gradient for an unmapped feature.
    expect(cat).toContain('mix(uSourceColor, uTargetColor, t)');
  });

  it('samples the value matrix on the texture path and an attribute otherwise', () => {
    const tex = buildFlowmapVertexSource(LEGACY_SHADER, cfg());
    expect(tex).toContain('float sttFlowMagnitude(float row, float bucketPos)');
    expect(tex).toContain(`attribute float ${'aFlowRow'};`);
    expect(tex).toContain(
      'float magnitude = sttFlowMagnitude(aFlowRow, uFlowBucket);',
    );
    expect(tex).not.toContain('attribute float aFlowMagnitude;');

    const attr = buildFlowmapVertexSource(
      LEGACY_SHADER,
      cfg({ magnitude: 'attribute' }),
    );
    expect(attr).toContain('attribute float aFlowMagnitude;');
    expect(attr).toContain('float magnitude = aFlowMagnitude;');
    expect(attr).not.toContain('sttFlowMagnitude');
    expect(attr).not.toContain('uFlowMatrix');
  });

  it('the unorm16 sampler decodes through the value scale', () => {
    const src = buildFlowmapVertexSource(
      LEGACY_SHADER,
      cfg({ format: 'unorm16' }),
    );
    expect(src).toContain(
      'uFlowValueScale.x + (q / 65535.0) * uFlowValueScale.y',
    );
  });

  it('the id pass reads the id colour and gates on the visual alpha', () => {
    const id = buildFlowmapVertexSource(V5_SHADER, cfg({ pick: true }));
    expect(id).toContain('attribute vec3 aIdColor;');
    expect(id).toContain('varying vec3 vIdColor;');
    expect(id).toContain('vIdColor = aIdColor;');
    // An invisible arrow (a gradient endpoint at alpha 0) is not a hit target.
    expect(id).toContain('vAlpha *= (mix(uSourceColor, uTargetColor, t)).a;');
    expect(id).not.toContain('varying vec4 vColor;');
  });

  it('an arrow with no flow is collapsed AND unpickable', () => {
    for (const src of allFour(cfg())) {
      expect(src).toContain('float activeMask = (widthPx > 0.0) ? 1.0 : 0.0;');
      expect(src).toContain('if (activeMask <= 0.0) gl_Position = vec4(0.0);');
      expect(src).toContain('activeMask');
    }
  });

  it('the default configuration compiles NONE of the optional surface', () => {
    const src = buildFlowmapVertexSource(LEGACY_SHADER);
    expect(src).not.toContain('sttDataFilterAlpha(');
    expect(src).not.toContain('uMagnitudeLowColor');
    expect(src).not.toContain('attribute vec4 aColor;');
    expect(src).not.toContain('aFlowMagnitude');
    expect(src).not.toContain('vIdColor');
    // …but bundle geometry and the texture sampler ARE on by default.
    expect(src).toContain('attribute vec2 aControl;');
    expect(src).toContain('sttFlowMagnitude');
  });
});

describe('program-cache key', () => {
  it('is distinct across every compiled axis', () => {
    const configs: FlowmapShaderConfig[] = [
      cfg(),
      cfg({ pick: true }),
      cfg({ mode: 'wake' }),
      cfg({ mode: 'trail' }),
      cfg({ filter: true }),
      cfg({ colorMode: 'magnitude' }),
      cfg({ colorMode: 'category' }),
      cfg({ bundle: false }),
      cfg({ magnitude: 'attribute' }),
      cfg({ format: 'unorm16' }),
    ];
    const keys = configs.map(flowmapProgramKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('folds the matrix format into the texture path key only', () => {
    expect(flowmapProgramKey(cfg({ format: 'unorm16' }))).toContain(
      'flow-unorm16',
    );
    expect(flowmapProgramKey(cfg({ magnitude: 'attribute' }))).toContain(
      'flow-attr',
    );
    // Format is inert on the attribute path — same key regardless.
    expect(
      flowmapProgramKey(cfg({ magnitude: 'attribute', format: 'unorm16' })),
    ).toBe(
      flowmapProgramKey(cfg({ magnitude: 'attribute', format: 'float32' })),
    );
  });
});

// ── prop defaults / back-compat ─────────────────────────────────────────────

describe('prop defaults', () => {
  it('constructs with no extra options and a texture/direction/window config', () => {
    const layer = new STTFlowmapLayer({ ...baseOpts, id: 'f' }) as any;
    expect(layer.shaderConfig.mode).toBe('window');
    expect(layer.shaderConfig.colorMode).toBe('direction');
    expect(layer.shaderConfig.bundle).toBe(true);
    expect(layer.shaderConfig.filter).toBe(false);
    expect(layer.shaderConfig.magnitude).toBe('texture');
    expect(layer.flowOpts.minFlow).toBe(0.25);
    expect(layer.flowOpts.widthScale).toBe(1.1);
    expect(layer.flowOpts.widthExponent).toBe(0.5);
    expect(layer.flowOpts.gap).toBe(0.5); // 'half' default
  });

  it('defaults the colour mode to category when a colorProperty is set', () => {
    const layer = new STTFlowmapLayer({
      ...baseOpts,
      id: 'f',
      colorProperty: 'mode',
    }) as any;
    expect(layer.shaderConfig.colorMode).toBe('category');
  });

  it('a full ribbon defaults gap to 0', () => {
    const layer = new STTFlowmapLayer({
      ...baseOpts,
      id: 'f',
      arrowShape: 'full',
    }) as any;
    expect(layer.flowOpts.gap).toBe(0);
  });

  it('compiles the filter branch from the property NAME alone', () => {
    const layer = new STTFlowmapLayer({
      ...baseOpts,
      id: 'f',
      filterProperty: 'strength',
    }) as any;
    expect(layer.shaderConfig.filter).toBe(true);
  });
});

// ── mock-gl draws ───────────────────────────────────────────────────────────

describe('drawTile', () => {
  it('draws one instanced arrow strip per OD pair', () => {
    const { layer, gl, tile, cache } = makeLayer();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const call = gl.drawCalls.at(-1);
    expect(call.kind).toBe('arrays-instanced');
    expect(call.instances).toBe(2); // two OD pairs
    expect(call.vertices).toBe(flowArrowVertexCount(8, 1));
  });

  it('links one program per host variant and sets the prelude uniforms on v5', () => {
    const { layer, gl, tile, cache } = makeLayer();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const v5 = normalizeRenderArgs(v5Args('globe'));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(v5));
    const sources = vertexSources(gl);
    expect(sources.some((s) => s.includes('uniform mat4 uMatrix;'))).toBe(true);
    expect(sources.some((s) => s.includes('projectTile(aSource)'))).toBe(true);
    // Two distinct programs (one per variant).
    expect(
      new Set(gl.useProgram.mock.calls.map((c: unknown[]) => c[0])).size,
    ).toBe(2);
    // Prelude projection uniform set on the v5 pass.
    const setProjMatrix = gl.getUniformLocation.mock.calls.some(
      (c: unknown[]) => c[1] === 'u_projection_matrix',
    );
    expect(setProjMatrix).toBe(true);
  });

  it('binds the matrix texture and its sampler unit', () => {
    const { layer, gl, tile, cache } = makeLayer();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.bindTexture).toHaveBeenCalledWith(
      gl.TEXTURE_2D,
      cache.matrixTexture,
    );
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uFlowMatrix')).toBe(0);
  });

  it('writes uFlowBucket from the tile axis and the playhead', () => {
    const { layer, gl, tile, cache } = makeLayer();
    const axis = deriveFlowAxis(tile.layers[0].features)!;
    const t = TIME_OFFSET + 1500; // pos = 1.5
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame(), t));
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uFlowBucket')).toBeCloseTo(
      bucketPositionAt(axis, t),
      6,
    );
    expect(bucketPositionAt(axis, t)).toBeCloseTo(1.5, 6);
  });

  it('GEOMETRY CACHE STABILITY: a time-only change rebuilds no geometry', () => {
    const { layer, gl, tile, cache } = makeLayer();
    // First draw warms the shared template buffer + the VAO.
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame(), TIME_OFFSET + 500),
    );
    const buffersAfterFirst = gl.createBuffer.mock.calls.length;
    const texturesAfterFirst = gl.createTexture.mock.calls.length;
    const vaosAfterFirst = gl.createVertexArray.mock.calls.length;
    const bucket1 = lastScalar(uniformsByName(gl), 'uFlowBucket');

    // Second draw at a DIFFERENT playhead: only the per-frame uniform moves.
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame(), TIME_OFFSET + 2500),
    );
    expect(gl.createBuffer.mock.calls.length).toBe(buffersAfterFirst);
    expect(gl.createTexture.mock.calls.length).toBe(texturesAfterFirst);
    expect(gl.createVertexArray.mock.calls.length).toBe(vaosAfterFirst);
    // No matrix re-upload on a time change (the texture is resident).
    expect(gl.texImage2D.mock.calls.length).toBe(1);
    const bucket2 = lastScalar(uniformsByName(gl), 'uFlowBucket');
    expect(bucket2).not.toBe(bucket1);
  });

  it('re-records the VAO when the host variant moves', () => {
    const { layer, gl, tile, cache } = makeLayer();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.deleteVertexArray).not.toHaveBeenCalled();
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(v5Args('globe'))),
    );
    expect(gl.deleteVertexArray).toHaveBeenCalled();
  });

  it('raises the segment count on globe until pieces fit the granularity', () => {
    const { layer, gl, tile, cache } = makeLayer({ numSegments: 4 });
    layer.map = { style: { projection: { subdivisionGranularity: 2048 } } };
    const globe = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(globe));
    const call = gl.drawCalls.at(-1);
    // maxSpan of the Tokyo→LA pair is large, so the shaft count is bumped past 4
    // (to a power of two) but never past the ceiling.
    const bumped = call.vertices;
    expect(bumped).toBeGreaterThan(flowArrowVertexCount(4, 1));
    expect(bumped).toBeLessThanOrEqual(
      flowArrowVertexCount(MAX_FLOWMAP_SEGMENTS, 1),
    );
  });

  it('meters width folds the metric scale in; pixels passes the scale through', () => {
    const px = makeLayer({ widthUnits: 'pixels', widthScale: 3 });
    px.layer.drawTile(
      px.gl,
      px.tile,
      px.tile.layers[0],
      px.cache,
      drawCtx(legacyFrame()),
    );
    expect(lastScalar(uniformsByName(px.gl), 'uWidthScale')).toBeCloseTo(3, 12);

    const m = makeLayer({ widthUnits: 'meters', widthScale: 3 });
    m.layer.drawTile(
      m.gl,
      m.tile,
      m.tile.layers[0],
      m.cache,
      drawCtx(legacyFrame()),
    );
    // The metric factor at z2 is tiny, so the effective scale is far below 3.
    expect(lastScalar(uniformsByName(m.gl), 'uWidthScale')).toBeLessThan(3);
  });
});

describe('static-column fallback', () => {
  it('packs the vertexValues channel as a one-column matrix', () => {
    const tile = makeStaticFlowTile();
    const { cache } = makeLayer({}, tile);
    expect(cache).not.toBeNull();
    // One column ⇒ the clamped sampler reads it at every playhead position.
    expect(cache.packed.cols).toBe(1);
    expect(cache.packed.rows).toBe(2); // one row per OD pair
    // No time axis to blend along.
    expect(cache.axis).toBeNull();
  });
});

describe('CPU fallback (no vertex texture fetch)', () => {
  function makeFallbackLayer() {
    const layer = new STTFlowmapLayer({ ...baseOpts, id: 'f' }) as any;
    layer.shaderConfig.magnitude = 'attribute';
    layer.rebuildProgramKeys();
    const gl = makeMockGl();
    wireMock(layer, gl);
    const tile = makeFlowTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    return { layer, gl, tile, cache };
  }

  it('binds no texture and re-expands only when the playhead crosses a sub-step', () => {
    const { layer, gl, tile, cache } = makeFallbackLayer();
    expect(cache.matrixTexture).toBeUndefined();
    expect(cache.magnitudeBuffer).toBeDefined();

    // First draw at pos 0.5 expands once.
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame(), TIME_OFFSET + 500),
    );
    expect(gl.bufferSubData.mock.calls.length).toBe(1);

    // Same sub-step (pos 0.6 → step 0.5): no re-upload.
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame(), TIME_OFFSET + 600),
    );
    expect(gl.bufferSubData.mock.calls.length).toBe(1);

    // Crossing into the next sub-step (pos 0.8 → step 1.0): one re-upload.
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame(), TIME_OFFSET + 800),
    );
    expect(gl.bufferSubData.mock.calls.length).toBe(2);
  });
});

describe('drawPickTile', () => {
  it('draws the id strip and leaves every divisor back at 0', () => {
    const { layer, gl, tile, cache } = makeLayer({ colorProperty: 'mode' });
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    const call = gl.drawCalls.at(-1);
    expect(call.kind).toBe('arrays-instanced');
    expect(call.instances).toBe(2);
    // Every attribute that was given a divisor of 1 is reset to 0 afterwards.
    const divisorCalls = gl.vertexAttribDivisor.mock.calls;
    const lastByLoc = new Map<number, number>();
    for (const [loc, div] of divisorCalls) lastByLoc.set(loc, div);
    for (const div of lastByLoc.values()) expect(div).toBe(0);
    // The one-shot id buffer is freed.
    expect(gl.deleteBuffer).toHaveBeenCalled();
  });

  it('is offered as a pick hook (id-FBO picking)', () => {
    const { layer } = makeLayer();
    expect(layer.supportsPicking()).toBe(true);
  });
});

describe('render()', () => {
  function mountLayer(extra: Record<string, unknown> = {}) {
    const layer = new STTFlowmapLayer({
      ...baseOpts,
      id: 'f',
      ...extra,
    }) as any;
    const gl = makeMockGl();
    wireMock(layer, gl);
    const map = makeMockMap();
    layer.map = map;
    layer.tileset = { update: vi.fn() };
    const tile = makeFlowTile();
    layer.loadedTiles = new Map([['2/1/1/' + TIME_OFFSET, tile]]);
    return { layer, gl, map, tile };
  }

  it('builds each tile geometry ONCE across repeated frames (time-only change)', () => {
    const { layer, gl } = mountLayer();
    const spy = vi.spyOn(layer, 'buildTileGpuCache');
    layer.render(gl, new Float32Array(16).fill(2));
    layer.setCurrentTime(TIME_OFFSET + 2000);
    layer.render(gl, new Float32Array(16).fill(2));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reaps a matrix texture only once its tile leaves the resident set', () => {
    const { layer, gl } = mountLayer();
    layer.render(gl, new Float32Array(16).fill(2));
    const cache = [...layer.liveCaches][0];
    expect(cache.matrixTexture).toBeDefined();
    const deletedBefore = gl.deleteTexture.mock.calls.length;

    // Still resident → redrawn → NOT reaped.
    layer.render(gl, new Float32Array(16).fill(2));
    expect(gl.deleteTexture.mock.calls.length).toBe(deletedBefore);

    // Tile leaves the set (a DIFFERENT tile id takes its place) → the old cache
    // is no longer drawn → reaped.
    const other = makeFlowTile();
    other.id = { z: 2, x: 5, y: 5, t: TIME_OFFSET };
    layer.loadedTiles = new Map([['2/5/5/' + TIME_OFFSET, other]]);
    layer.render(gl, new Float32Array(16).fill(2));
    expect(gl.deleteTexture.mock.calls.length).toBeGreaterThan(deletedBefore);
    expect(layer.liveCaches.has(cache)).toBe(false);
  });
});

describe('OD tile acceptance', () => {
  it('accepts LineString geometry only', () => {
    const layer = new STTFlowmapLayer({ ...baseOpts, id: 'f' }) as any;
    expect(layer.acceptsGeometry(GeometryType.LineString)).toBe(true);
    expect(layer.acceptsGeometry(GeometryType.Point)).toBe(false);
    expect(layer.acceptsGeometry(GeometryType.Polygon)).toBe(false);
  });

  it('declines a tile with no range-filter column by rendering unfiltered', () => {
    const tile = makeBareFlowTile();
    const { cache } = makeLayer({ filterProperty: 'strength' }, tile);
    expect(cache.hasFilterColumn).toBe(false);
  });
});

/**
 * Live KDEEB edge bundling for `@poopdeck.gl/maplibre` — the `liveBundling`
 * capability.
 *
 * The thing this suite exists to prove, above everything else:
 *
 *   **This backend does not own a KDEEB implementation. It calls the shared
 *   one.** `lib/edge-bundler.ts` resamples, maps into the shared
 *   `BUNDLING_WORK_SIZE` box, calls `bundleEdges()` from
 *   `@poopdeck.gl/core/edge-bundling` exactly once, and maps the answer back.
 *   The pin is not a spy on a call — it re-runs `bundleEdges` here, in the
 *   test, with the work-box inputs, and demands the packed texels match. A
 *   second copy of the kernel that happened to behave similarly would fail;
 *   only literally using core's output passes.
 *
 * Everything else follows from that: the work-box mapping and its inverse, the
 * endpoint pin the arrowhead depends on, the decline paths (one edge, over the
 * cap, over the texture ceiling, degenerate extent) that must allocate nothing,
 * the GLSL sampler against its JS twin, and the layer wiring — including the
 * pre-campaign default, which is OFF.
 *
 * As everywhere in this package there is no GPU: `mock-gl` records, it does not
 * rasterize, so the GLSL is checked as a string against a JS reference and the
 * device path is checked as a call log.
 */

import { describe, it, expect, vi } from 'vitest';
import { GeometryType, type Tile, type Layer } from '@poopdeck.gl/core';
import {
  BUNDLING_WORK_SIZE,
  bundleEdges,
} from '@poopdeck.gl/core/edge-bundling';
import {
  DEFAULT_BUNDLE_CAP,
  DEFAULT_BUNDLE_DENSITY_RES,
  DEFAULT_BUNDLE_KERNEL_RADIUS,
  DEFAULT_BUNDLE_POINTS,
  MAX_BUNDLE_POINTS,
  buildFlowBundle,
  clampBundlePoints,
  isBundlingSupported,
  maxBundleEdges,
  resampleFlowEdges,
  toWorkBox,
  type FlowBundleInput,
} from '../src/lib/edge-bundler';
import {
  BUNDLE_NAMES,
  BUNDLE_PATH_CALL_GLSL,
  BUNDLE_PATH_GLSL,
  BUNDLE_PATH_STEPS,
  BUNDLE_TEXTURE_RECIPE,
  bundlePathAtJS,
  bundleTexelJS,
} from '../src/shaders/bundle.glsl';
import {
  STTFlowmapLayer,
  buildFlowmapVertexSource,
  flowmapProgramKey,
  type FlowmapShaderConfig,
} from '../src/layers/flowmap-layer';
import { normalizeRenderArgs } from '../src/lib/host-adapter';
import { makeMockGl, makeMockMap } from './mock-gl';

// ── fixtures ────────────────────────────────────────────────────────────────

/** The canonical antimeridian unwrap, injected exactly as the layer injects it. */
const unwrapX = (ref: number, x: number): number =>
  x - Math.floor(x - ref + 0.5);

/**
 * `E` OD pairs straight from mercator endpoints — no feature vertex list, so
 * every edge resamples to an evenly spaced chord and the ONLY thing that can
 * bend it is the bundler.
 */
function odInput(
  pairs: ReadonlyArray<readonly [number, number, number, number]>,
): FlowBundleInput {
  const E = pairs.length;
  const sourceM = new Float32Array(E * 2);
  const targetM = new Float32Array(E * 2);
  pairs.forEach(([sx, sy, tx, ty], i) => {
    sourceM[i * 2] = sx;
    sourceM[i * 2 + 1] = sy;
    targetM[i * 2] = tx;
    targetM[i * 2 + 1] = ty;
  });
  return { dims: 2, sourceM, targetM, edgeCount: E, unwrapX };
}

/** Three near-parallel west→east corridors, 0.02 mercator apart. */
const PARALLEL = odInput([
  [0.3, 0.4, 0.7, 0.4],
  [0.3, 0.42, 0.7, 0.42],
  [0.3, 0.44, 0.7, 0.44],
]);

/** `x` at parameter index `i` of edge `e` in a packed RGBA texel array. */
const tx = (texels: ArrayLike<number>, P: number, e: number, i: number) =>
  texels[(e * P + i) * 4];
const ty = (texels: ArrayLike<number>, P: number, e: number, i: number) =>
  texels[(e * P + i) * 4 + 1];

// ── 1. the pin: core's bundleEdges is what runs ─────────────────────────────

describe('the shared KDEEB implementation is the one that runs', () => {
  it('packs core bundleEdges output verbatim, from work-box coordinates', () => {
    const P = 10;
    const E = 3;
    const opts = { subdivisionPoints: P, bundlingIterations: 5 };
    const bundle = buildFlowBundle(PARALLEL, opts);
    expect(bundle).not.toBeNull();

    // Re-derive the answer HERE, from core, with no reference to the module
    // under test beyond its two pure stages. If `lib/edge-bundler.ts` grew its
    // own iteration — even a faithful one — this comparison fails.
    const raw = resampleFlowEdges(PARALLEL, P);
    const box = toWorkBox(raw, E * P);
    expect(box).not.toBeNull();
    const work = bundleEdges(raw, E, P, {
      iterations: 5,
      kernelRadius: DEFAULT_BUNDLE_KERNEL_RADIUS * BUNDLING_WORK_SIZE,
      lambda: 0.85,
      smoothing: 0.5,
      densityResolution: DEFAULT_BUNDLE_DENSITY_RES,
    });

    const inv = 1 / box!.scale;
    for (let i = 0; i < E * P; i++) {
      expect(bundle!.texels[i * 4]).toBeCloseTo(
        work[i * 2] * inv + box!.originX,
        6,
      );
      expect(bundle!.texels[i * 4 + 1]).toBeCloseTo(
        work[i * 2 + 1] * inv + box!.originY,
        6,
      );
    }
  });

  it('hands the bundler coordinates inside the SHARED work box', () => {
    // The kernel/step constants in core are scale-relative and calibrated to
    // this box; feeding it mercator (extent ~0.4) would make the default
    // bandwidth 125× the whole dataset.
    const raw = resampleFlowEdges(PARALLEL, 10);
    const box = toWorkBox(raw, 30)!;
    let maxSeen = 0;
    for (let i = 0; i < 60; i++) {
      expect(raw[i]).toBeGreaterThanOrEqual(0);
      expect(raw[i]).toBeLessThanOrEqual(BUNDLING_WORK_SIZE);
      if (raw[i] > maxSeen) maxSeen = raw[i];
    }
    // The LONGEST axis fills the box less a 5% margin on each side — see
    // BUNDLE_WORK_MARGIN: a corridor sitting exactly on the border cannot
    // advect at all, because core has no centred gradient stencil there.
    expect(maxSeen).toBeCloseTo(BUNDLING_WORK_SIZE * 0.95, 6);
    // (Loose: the endpoints are Float32, so the extent is 0.4 only to f32.)
    expect(box.scale).toBeCloseTo((BUNDLING_WORK_SIZE * 0.9) / 0.4, 3);
  });

  it('bundles the OUTERMOST corridor too, not just the interior ones', () => {
    // The regression the work-box margin exists for: with the data mapped flush
    // to the box edges, the first corridor did not move a single float while
    // its neighbours converged onto it.
    const P = 12;
    const bundle = buildFlowBundle(PARALLEL, { subdivisionPoints: P })!;
    const mid = P >> 1;
    expect(Math.abs(ty(bundle.texels, P, 0, mid) - 0.4)).toBeGreaterThan(1e-3);
  });

  it('actually bundles: neighbouring corridors converge, in mercator', () => {
    const P = 12;
    const before = Math.abs(0.44 - 0.4);
    const bundle = buildFlowBundle(PARALLEL, { subdivisionPoints: P })!;
    const mid = P >> 1;
    const mids = [0, 1, 2].map((e) => ty(bundle.texels, P, e, mid));
    const after = Math.max(...mids) - Math.min(...mids);
    // All three collapse into one river, far tighter than they started.
    expect(after).toBeLessThan(before / 4);
    // …and they converged TOWARD each other rather than all sliding off
    // together: the river runs near where the corridors already were.
    const centre = (mids[0] + mids[1] + mids[2]) / 3;
    expect(Math.abs(centre - 0.42)).toBeLessThan(0.02);
  });

  it('pins both endpoints to the pair attributes EXACTLY', () => {
    // Load-bearing: the shader measures the arrow's on-screen length and head
    // fraction off aSource/aTarget while drawing the path from the texture. A
    // drifted end detaches the arrow from its own arrowhead.
    const P = 12;
    const bundle = buildFlowBundle(PARALLEL, { subdivisionPoints: P })!;
    for (let e = 0; e < 3; e++) {
      expect(tx(bundle.texels, P, e, 0)).toBe(PARALLEL.sourceM[e * 2]);
      expect(ty(bundle.texels, P, e, 0)).toBe(PARALLEL.sourceM[e * 2 + 1]);
      expect(tx(bundle.texels, P, e, P - 1)).toBe(PARALLEL.targetM[e * 2]);
      expect(ty(bundle.texels, P, e, P - 1)).toBe(PARALLEL.targetM[e * 2 + 1]);
    }
  });

  it('leaves its input untouched (the bundle is re-derivable)', () => {
    const snapshot = Float32Array.from(PARALLEL.sourceM as Float32Array);
    buildFlowBundle(PARALLEL, { subdivisionPoints: 8, bundlingIterations: 3 });
    expect(Array.from(PARALLEL.sourceM as Float32Array)).toEqual(
      Array.from(snapshot),
    );
  });
});

// ── 2. the work box ─────────────────────────────────────────────────────────

describe('work-box mapping', () => {
  it('uses ONE scale for both axes (mercator is conformal — no cosLat term)', () => {
    // Anisotropic scaling would make "one bandwidth away" mean different
    // distances north-south and east-west, and bundle a vertical corridor
    // differently from a horizontal one.
    const pts = new Float64Array([0.2, 0.5, 0.6, 0.51]);
    const box = toWorkBox(pts, 2)!;
    expect(box.scale).toBeCloseTo((BUNDLING_WORK_SIZE * 0.9) / 0.4, 9);
    // y spanned 0.01 of a 0.4 extent, so it occupies 2.5% of the usable span —
    // NOT the whole of it.
    expect(pts[3] - pts[1]).toBeCloseTo(BUNDLING_WORK_SIZE * 0.9 * 0.025, 6);
  });

  it('round-trips through its own inverse', () => {
    const pts = new Float64Array([0.2, 0.5, 0.6, 0.51, 0.35, 0.505]);
    const before = Array.from(pts);
    const box = toWorkBox(pts, 3)!;
    for (let i = 0; i < 3; i++) {
      expect(pts[i * 2] / box.scale + box.originX).toBeCloseTo(
        before[i * 2],
        12,
      );
      expect(pts[i * 2 + 1] / box.scale + box.originY).toBeCloseTo(
        before[i * 2 + 1],
        12,
      );
    }
  });

  it('insets the data so nothing starts on the un-differentiable border', () => {
    const pts = new Float64Array([0.2, 0.5, 0.6, 0.5]);
    toWorkBox(pts, 2);
    expect(pts[0]).toBeCloseTo(BUNDLING_WORK_SIZE * 0.05, 6);
    expect(pts[2]).toBeCloseTo(BUNDLING_WORK_SIZE * 0.95, 6);
  });

  it('refuses a degenerate extent instead of multiplying float noise by 1e9', () => {
    const pts = new Float64Array([0.5, 0.5, 0.5, 0.5]);
    expect(toWorkBox(pts, 2)).toBeNull();
    // …and left the input alone, so the caller can still use it.
    expect(Array.from(pts)).toEqual([0.5, 0.5, 0.5, 0.5]);
  });
});

// ── 3. resampling ───────────────────────────────────────────────────────────

describe('resampleFlowEdges', () => {
  it('spaces a plain OD pair evenly along its chord', () => {
    const P = 5;
    const out = resampleFlowEdges(odInput([[0.2, 0.6, 0.6, 0.6]]), P);
    for (let i = 0; i < P; i++) {
      expect(out[i * 2]).toBeCloseTo(0.2 + (0.4 * i) / (P - 1), 6);
      expect(out[i * 2 + 1]).toBeCloseTo(0.6, 6);
    }
  });

  it("starts from the archive's OWN baked geometry when it has any", () => {
    // A pre-bundled archive already knows where its rivers run; throwing that
    // away and re-deriving a chord would discard real information.
    const input: FlowBundleInput = {
      ...odInput([[0.5, 0.5, 0.5, 0.5]]),
      dims: 2,
      // lon/lat: 0° → 45° → 0° longitude at the equator, i.e. a big detour east.
      positions: new Float64Array([0, 0, 45, 0, 0, 0]),
      startIndices: new Uint32Array([0, 3]),
    };
    const out = resampleFlowEdges(input, 3);
    // Endpoints are the pair attributes; the middle sample is the detour, so it
    // is NOT the chord midpoint (which would be 0.5).
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[4]).toBeCloseTo(0.5, 6);
    expect(out[2]).toBeGreaterThan(0.55);
  });

  it('keeps an interior vertex on the origin side of the antimeridian', () => {
    const input: FlowBundleInput = {
      ...odInput([[0.888, 0.4, 1.172, 0.4]]),
      positions: new Float64Array([139.7, 35.7, -179, 40, -118.24, 34.05]),
      startIndices: new Uint32Array([0, 3]),
    };
    const out = resampleFlowEdges(input, 3);
    // lon -179 is mercator x ≈ 0.00278; unwrapped against a 0.888 origin it
    // must read ≈ 1.00278, not sweep back across the whole map.
    expect(out[2]).toBeGreaterThan(0.9);
  });

  it('drops a non-finite interior rather than poisoning the arc-length walk', () => {
    const input: FlowBundleInput = {
      ...odInput([[0.2, 0.6, 0.6, 0.6]]),
      positions: new Float64Array([0, 0, Number.NaN, 10, 0, 0]),
      startIndices: new Uint32Array([0, 3]),
    };
    const out = resampleFlowEdges(input, 3);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
    expect(out[2]).toBeCloseTo(0.4, 6);
  });
});

// ── 4. the decline paths ────────────────────────────────────────────────────

describe('tiles that are NOT bundled', () => {
  it('declines a lone edge — there is nothing to bundle toward', () => {
    expect(buildFlowBundle(odInput([[0.2, 0.6, 0.6, 0.6]]))).toBeNull();
  });

  it('declines past maxBundledEdges without doing the work', () => {
    expect(buildFlowBundle(PARALLEL, { maxBundledEdges: 2 })).toBeNull();
    expect(buildFlowBundle(PARALLEL, { maxBundledEdges: 3 })).not.toBeNull();
  });

  it("declines past the host's texture ceiling", () => {
    // A 3-edge bundle needs a 3-texel-TALL texture; a ceiling of 2 cannot hold
    // it, and texImage2D past the limit is an incomplete texture, not a throw.
    expect(buildFlowBundle(PARALLEL, { subdivisionPoints: 8 }, 2)).toBeNull();
    expect(
      buildFlowBundle(PARALLEL, { subdivisionPoints: 8 }, 8),
    ).not.toBeNull();
    // Even one edge cannot fit when the POINT count alone is over the ceiling.
    expect(maxBundleEdges(4, 8)).toBe(0);
    expect(maxBundleEdges(4096, 24)).toBe(DEFAULT_BUNDLE_CAP);
    expect(maxBundleEdges(256, 24)).toBe(256);
  });

  it('declines a spatially degenerate tile', () => {
    expect(
      buildFlowBundle(
        odInput([
          [0.5, 0.5, 0.5, 0.5],
          [0.5, 0.5, 0.5, 0.5],
        ]),
      ),
    ).toBeNull();
  });
});

describe('clampBundlePoints', () => {
  it('defaults, floors at 3 and ceilings at MAX_BUNDLE_POINTS', () => {
    expect(clampBundlePoints(undefined)).toBe(DEFAULT_BUNDLE_POINTS);
    expect(clampBundlePoints(Number.NaN)).toBe(DEFAULT_BUNDLE_POINTS);
    expect(clampBundlePoints(1)).toBe(3);
    expect(clampBundlePoints(10_000)).toBe(MAX_BUNDLE_POINTS);
    expect(clampBundlePoints(12.7)).toBe(12);
  });
});

// ── 5. the device gate ──────────────────────────────────────────────────────

describe('isBundlingSupported', () => {
  const ok = {
    vertexTextureFetch: true,
    floatTextures: true,
    maxTextureSize: 4096,
  };

  it('needs vertex texture fetch AND sampleable float textures', () => {
    expect(isBundlingSupported(ok)).toBe(true);
    expect(isBundlingSupported({ ...ok, vertexTextureFetch: false })).toBe(
      false,
    );
    expect(isBundlingSupported({ ...ok, floatTextures: false })).toBe(false);
    expect(isBundlingSupported({ ...ok, maxTextureSize: 0 })).toBe(false);
  });

  it('does NOT require float blending — the splat runs on the CPU here', () => {
    // deck's gate additionally demands `EXT_float_blend` + a float-RENDERABLE
    // attachment because it splats the density field on the GPU. Copying that
    // gate would switch this backend off on hardware that runs it perfectly,
    // so the probe has no such field to set at all.
    expect(Object.keys(ok).sort()).toEqual([
      'floatTextures',
      'maxTextureSize',
      'vertexTextureFetch',
    ]);
  });
});

// ── 6. the GLSL sampler and its JS twin ─────────────────────────────────────

describe('bundle sampler GLSL', () => {
  it('keeps its load-bearing steps', () => {
    for (const step of BUNDLE_PATH_STEPS) {
      expect(BUNDLE_PATH_GLSL).toContain(step);
    }
    expect(BUNDLE_PATH_GLSL).toContain(
      'vec2 sttBundlePathAt(float t, float row)',
    );
    expect(BUNDLE_PATH_GLSL).toContain(
      'vec2 sttBundleTexel(float i, float row)',
    );
  });

  it('samples texel CENTRES, so NEAREST is an exact fetch', () => {
    expect(BUNDLE_PATH_GLSL).toContain(
      '(vec2(i, row) + 0.5) * uBundleShape.yz',
    );
  });

  it('contains no KDEEB kernel — the bundling is not on the GPU here', () => {
    for (const forbidden of ['epanechnikov', 'gradient', 'density', 'anneal']) {
      expect(BUNDLE_PATH_GLSL.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('names one upload recipe per host', () => {
    expect(BUNDLE_TEXTURE_RECIPE.webgl2.internalFormat).toBe('RGBA32F');
    expect(BUNDLE_TEXTURE_RECIPE.webgl1.internalFormat).toBe('RGBA');
    expect(BUNDLE_TEXTURE_RECIPE.webgl1.type).toBe('FLOAT');
  });
});

describe('bundlePathAtJS (the GLSL reference)', () => {
  // Two edges × three control points, RGBA.
  const P = 3;
  const E = 2;
  const texels = new Float32Array([
    0,
    0,
    0,
    0,
    1,
    2,
    0,
    0,
    2,
    0,
    0,
    0, // edge 0: (0,0) (1,2) (2,0)
    10,
    0,
    0,
    0,
    11,
    0,
    0,
    0,
    12,
    0,
    0,
    0, // edge 1: straight
  ]);

  it('walks the polyline linearly and hits every control point', () => {
    expect(bundlePathAtJS(texels, P, E, 0, 0)).toEqual([0, 0]);
    expect(bundlePathAtJS(texels, P, E, 0.5, 0)).toEqual([1, 2]);
    expect(bundlePathAtJS(texels, P, E, 1, 0)).toEqual([2, 0]);
    const [x, y] = bundlePathAtJS(texels, P, E, 0.25, 0);
    expect(x).toBeCloseTo(0.5, 9);
    expect(y).toBeCloseTo(1, 9);
  });

  it('clamps t rather than wrapping onto the next ROW', () => {
    // The alternative is an arrow whose over-shot tip jumps to another OD pair.
    expect(bundlePathAtJS(texels, P, E, 1.4, 0)).toEqual([2, 0]);
    expect(bundlePathAtJS(texels, P, E, -0.4, 0)).toEqual([0, 0]);
    expect(bundlePathAtJS(texels, P, E, 0.5, 1)).toEqual([11, 0]);
  });

  it('indexes rows the way the texture is packed', () => {
    expect(bundleTexelJS(texels, P, E, 2, 1)).toEqual([12, 0]);
    // Fractional/out-of-range indices floor and clamp, like a NEAREST fetch.
    expect(bundleTexelJS(texels, P, E, 1.9, 0)).toEqual([1, 2]);
    expect(bundleTexelJS(texels, P, E, 99, 99)).toEqual([12, 0]);
  });
});

// ── 7. layer wiring ─────────────────────────────────────────────────────────

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};
const TIME_OFFSET = 1_700_000_000_000;
const PRELUDE =
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

/** Both host variants of both passes. */
const allFour = (c: FlowmapShaderConfig): string[] => [
  buildFlowmapVertexSource(LEGACY_SHADER, c),
  buildFlowmapVertexSource(V5_SHADER, c),
  buildFlowmapVertexSource(LEGACY_SHADER, { ...c, pick: true }),
  buildFlowmapVertexSource(V5_SHADER, { ...c, pick: true }),
];

/** Two OD flows far enough apart to be a real bundle, both plain 2-vertex. */
function makeFlowTile(): Tile {
  const features = {
    featureCount: 2,
    geometryType: GeometryType.LineString,
    positionDimensions: 2 as const,
    positions: new Float64Array([
      -122.4, 37.7, -73.95, 40.75, -122.4, 34.05, -73.95, 42.0,
    ]),
    startIndices: new Uint32Array([0, 2, 4]),
    featureIds: new Uint32Array([0, 1]),
    startTimes: new Float32Array([0, 0]),
    endTimes: new Float32Array([3000, 3000]),
    timeOffset: TIME_OFFSET,
    vertexValueMatrix: new Float32Array([
      10, 20, 30, 0, 0, 0, 40, 50, 60, 0, 0, 0,
    ]),
    vertexValueBuckets: 3,
    numericProps: {},
    categoricalProps: {},
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

function wireMock(layer: any, gl: any): void {
  layer.supports32BitIndices = true;
  const slots = new Map<string, number>();
  gl.getAttribLocation = vi.fn((_p: unknown, name: string) => {
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

function makeLayer(extra: Record<string, unknown> = {}) {
  const layer = new STTFlowmapLayer({
    ...baseOpts,
    id: 'f',
    ...extra,
  } as any) as any;
  const gl = makeMockGl();
  wireMock(layer, gl);
  layer.map = makeMockMap();
  const tile = makeFlowTile();
  const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
  return { layer, gl, tile, cache };
}

const drawCtx = () => ({
  matrix: new Float32Array(16),
  frame: normalizeRenderArgs(new Float32Array(16).fill(2)),
  windowStart: 0,
  windowEnd: 10_000,
  currentTime: baseOpts.currentTime,
  zoom: 2,
});

/** Uniform uploads keyed by NAME (locations are opaque handles). */
function uniformsByName(gl: any): Map<string, unknown[][]> {
  const nameByLoc = new Map<unknown, string>();
  gl.getUniformLocation.mock.calls.forEach((call: unknown[], i: number) => {
    nameByLoc.set(gl.getUniformLocation.mock.results[i].value, call[1]);
  });
  const out = new Map<string, unknown[][]>();
  for (const fn of [gl.uniform1f, gl.uniform1i, gl.uniform3fv]) {
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

describe('STTFlowmapLayer shader wiring', () => {
  it('compiles the sampler into BOTH host variants and BOTH passes', () => {
    for (const src of allFour(cfg({ bundlePath: true }))) {
      expect(src).toContain('uniform sampler2D uBundlePositions;');
      expect(src).toContain('attribute float aBundleRow;');
      expect(src).toContain(BUNDLE_PATH_CALL_GLSL);
      // The pick pass must bend identically or the hit shape drifts off the
      // drawn arrow — which an id-buffer picker cannot detect from the CPU.
      expect(src).toContain('vec2 sttBundlePathAt(float t, float row)');
    }
  });

  it('branches per TILE on uUseBundle, keeping the fallback in the SAME program', () => {
    const src = buildFlowmapVertexSource(
      LEGACY_SHADER,
      cfg({ bundlePath: true }),
    );
    expect(src).toContain(
      `if (uUseBundle > 0.5) return ${BUNDLE_PATH_CALL_GLSL};`,
    );
    // …and the baked-Bézier fallback is still right there underneath it.
    expect(src).toContain('2.0 * mt * t * aControl');
  });

  it('finite-differences its tangent when the path can curve', () => {
    // A bundled arrowhead must aim along the RIVER, not along the chord.
    const bundled = buildFlowmapVertexSource(
      LEGACY_SHADER,
      cfg({ bundle: false, bundlePath: true }),
    );
    expect(bundled).toContain('STT_TANGENT_DT');
    expect(bundled).not.toContain('vec2 dirPx = chordPx;');
    const straight = buildFlowmapVertexSource(
      LEGACY_SHADER,
      cfg({ bundle: false, bundlePath: false }),
    );
    expect(straight).toContain('vec2 dirPx = chordPx;');
  });

  it('carries the axis in the program-cache key', () => {
    expect(flowmapProgramKey(cfg({ bundlePath: true }))).toContain(':kdeeb');
    expect(flowmapProgramKey(cfg({ bundlePath: true }))).not.toBe(
      flowmapProgramKey(cfg({ bundlePath: false })),
    );
  });
});

describe('STTFlowmapLayer device path', () => {
  it('builds one control-point texture and one row buffer per tile', () => {
    const { gl, cache } = makeLayer({ bundling: { subdivisionPoints: 8 } });
    expect(cache.bundleTexture).toBeDefined();
    expect(cache.bundleRowBuffer).toBeDefined();
    expect(cache.bundlePoints).toBe(8);
    // 8 control points wide × 2 OD pairs tall, uploaded as floats. The bundle
    // is uploaded BEFORE the value matrix, which is the other texImage2D here.
    const upload = gl.texImage2D.mock.calls[0];
    expect(upload[3]).toBe(8);
    expect(upload[4]).toBe(2);
    expect(upload[8]).toBeInstanceOf(Float32Array);
    expect(upload[8].length).toBe(8 * 2 * 4);
    // The row buffer is the instance index, so it is freed with the cache.
    expect(cache.extraBuffers).toContain(cache.bundleRowBuffer);
  });

  it('uploads the shape + switch and leaves TEXTURE0 active', () => {
    const { layer, gl, tile, cache } = makeLayer({
      bundling: { subdivisionPoints: 8 },
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    const u = uniformsByName(gl);
    expect(u.get(BUNDLE_NAMES.enabled)?.at(-1)?.[0]).toBe(1);
    const shape = u.get(BUNDLE_NAMES.shape)?.at(-1)?.[0] as Float32Array;
    expect(Array.from(shape)).toEqual([8, 1 / 8, 1 / 2]);
    // Bound on unit 1 — unit 0 belongs to the value matrix.
    expect(u.get(BUNDLE_NAMES.positions)?.at(-1)?.[0]).toBe(1);
    expect(gl.activeTexture.mock.calls.at(-1)?.[0]).toBe(gl.TEXTURE0);
  });

  it('raises the shaft tessellation to the bundle resolution', () => {
    // 8 control points need 7 segments to be visited exactly; drawing the
    // default 8-segment shaft would be a coincidence, so ask for 24 points.
    const { layer, gl, tile, cache } = makeLayer({
      bundling: { subdivisionPoints: 24 },
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    // vertices = 2·(S+1) + 2·(H+1), S = 23, H = 1.
    expect(gl.drawCalls.at(-1).vertices).toBe(2 * 24 + 2 * 2);
  });

  it('frees the bundle texture when the tile is evicted', () => {
    const { layer, gl, tile, cache } = makeLayer({
      bundling: { subdivisionPoints: 8 },
    });
    const texture = cache.bundleTexture;
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    layer.frameStamp += 1;
    layer.drewThisFrame = true;
    layer.reapEvictedTextures(gl);
    expect(gl.deleteTexture).toHaveBeenCalledWith(texture);
    expect(cache.bundleTexture).toBeUndefined();
    expect(cache.bundlePoints).toBe(0);
  });

  it('stays ON when the host reports vertex texture units and float textures', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layer = new STTFlowmapLayer({
        ...baseOpts,
        id: 'f',
        bundling: true,
      } as any) as any;
      const gl = makeMockGl();
      wireMock(layer, gl);
      const getParameter = gl.getParameter;
      // MAX_VERTEX_TEXTURE_IMAGE_UNITS / MAX_TEXTURE_SIZE, which the bare
      // recorder answers with null (WebGL1's legal "no vertex texture units").
      gl.getParameter = vi.fn((p: number) =>
        p === 0x8b4c ? 16 : p === 0x0d33 ? 4096 : getParameter(p),
      );
      const getExtension = gl.getExtension;
      gl.getExtension = vi.fn((n: string) =>
        n === 'OES_texture_float' ? {} : getExtension(n),
      );
      layer.onContextReady(gl);
      expect(layer.shaderConfig.magnitude).toBe('texture');
      expect(layer.shaderConfig.bundlePath).toBe(true);
      expect(
        warn.mock.calls.filter((c) => String(c[0]).includes('KDEEB')).length,
      ).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('falls back to straight arrows on a host that cannot sample the bundle', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layer = new STTFlowmapLayer({
        ...baseOpts,
        id: 'f',
        bundling: true,
      } as any) as any;
      const gl = makeMockGl();
      wireMock(layer, gl);
      // The recorder reports no vertex texture units and no OES_texture_float.
      layer.onContextReady(gl);
      expect(layer.shaderConfig.bundlePath).toBe(false);
      const bundleWarnings = warn.mock.calls.filter((c) =>
        String(c[0]).includes('KDEEB'),
      );
      expect(bundleWarnings.length).toBe(1);
      // Warned ONCE, not once per context probe.
      layer.onContextReady(gl);
      expect(
        warn.mock.calls.filter((c) => String(c[0]).includes('KDEEB')).length,
      ).toBe(1);
      // …and the tile still builds, with no bundle attached.
      const tile = makeFlowTile();
      const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
      expect(cache.bundleTexture).toBeUndefined();
      expect(cache.bundlePoints).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('draws a declined tile from its own geometry, not from a null sampler', () => {
    // maxBundledEdges below the pair count: the bundler returns nothing, so no
    // texture is allocated and uUseBundle reports 0.
    const { layer, gl, tile, cache } = makeLayer({
      bundling: { maxBundledEdges: 1 },
    });
    expect(cache.bundleTexture).toBeUndefined();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(uniformsByName(gl).get(BUNDLE_NAMES.enabled)?.at(-1)?.[0]).toBe(0);
    expect(gl.drawCalls.at(-1).instances).toBe(2);
  });

  it('keeps the pick pass from leaving the row divisor dirty', () => {
    const { layer, gl, tile, cache } = makeLayer({
      bundling: { subdivisionPoints: 8 },
    });
    layer.drawPickTile(gl, tile, tile.layers[0], cache, drawCtx(), 1);
    const lastByLoc = new Map<number, number>();
    for (const [loc, div] of gl.vertexAttribDivisor.mock.calls) {
      lastByLoc.set(loc, div);
    }
    for (const div of lastByLoc.values()) expect(div).toBe(0);
  });
});

describe('defaults are the pre-campaign behaviour', () => {
  it('bundling is OFF unless asked for', () => {
    const { layer, cache } = makeLayer();
    expect(layer.shaderConfig.bundlePath).toBe(false);
    expect(cache.bundleTexture).toBeUndefined();
    expect(cache.bundleRowBuffer).toBeUndefined();
    expect(cache.bundlePoints).toBe(0);
  });

  it('bundling: false is the same as unset', () => {
    const { layer } = makeLayer({ bundling: false });
    expect(layer.shaderConfig.bundlePath).toBe(false);
  });

  it('emits no bundle GLSL and does not move the program key when off', () => {
    const src = buildFlowmapVertexSource(LEGACY_SHADER, cfg());
    expect(src).not.toContain('uBundle');
    expect(src).not.toContain('aBundleRow');
    expect(src).toContain('vec2 dirPx');
    expect(flowmapProgramKey(cfg())).not.toContain('kdeeb');
    // A config literal written before this campaign still typechecks and keys
    // identically — the axis is optional for exactly that reason.
    expect(flowmapProgramKey(cfg())).toBe(
      flowmapProgramKey(cfg({ bundlePath: false })),
    );
  });
});

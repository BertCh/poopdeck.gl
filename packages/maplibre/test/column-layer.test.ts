/**
 * Column layer (Wave M3): instanced extruded prisms + the space-time cube.
 *
 * Four layers of coverage, mirroring the conventions the point/polygon variant
 * suites established:
 *
 *  - **CPU geometry** — the unit prism / ring meshes are pure functions with a
 *    module-level cache, so their vertex layout, index topology, shading and
 *    cache identity are asserted directly (no GL involved).
 *  - **JS references** — `timeHeightLiftMeters`, `columnVertexElevationMeters`
 *    and `resolveColumnRadiusScale` are the CPU twins of shader expressions;
 *    each is checked against the maths the vertex source spells out.
 *  - **Shader strings** — BOTH host variants (legacy `uMatrix` / v5 injected
 *    prelude) build for every time mode, with and without the DataFilter, in
 *    all four passes; the default configuration compiles NONE of the optional
 *    surface.
 *  - **mock-gl draws** — instanced draw shapes, per-variant program caching and
 *    VAO invalidation, the elevation/sizing/time/filter uniform wiring, and the
 *    pick pass reproducing every visibility gate (invisible ⇒ unpickable) and
 *    leaving no divisor dirty.
 *
 * Real prelude compilation and the pick FBO round-trip stay browser-verified.
 */

import { describe, it, expect, vi } from 'vitest';
import { normalizeRenderArgs } from '../src/lib/host-adapter';
import {
  STTColumnLayer,
  WALL_SHADE,
  buildColumnMesh,
  buildColumnStrokeMesh,
  buildColumnVertexSource,
  buildColumnIdVertexSource,
  buildColumnStrokeVertexSource,
  buildColumnStrokeIdVertexSource,
  columnProgramKey,
  columnUnitRing,
  columnVertexElevationMeters,
  resolveColumnRadiusScale,
  resolveColumnTimeFilterMode,
  timeHeightLiftMeters,
  type ColumnShaderConfig,
} from '../src/layers/column-layer';
import {
  DATA_FILTER_CALL_GLSL,
  dataFilterAlphaJS,
} from '../src/shaders/data-filter.glsl';
import { wakeAlphaJS, wakeSizeScaleJS } from '../src/shaders/time-window.glsl';
import {
  mercatorZFromAltitude,
  metersToMercatorUnits,
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
const PRELUDE = `${PRELUDE_MARKER}
uniform mat4 u_projection_matrix;
vec4 projectTile(vec2 p) { return u_projection_matrix * vec4(p, 0.0, 1.0); }
vec4 projectTileFor3D(vec2 p, float elev) { return u_projection_matrix * vec4(p, elev, 1.0); }`;
const LEGACY_SHADER = { prelude: '', define: '' };
const V5_SHADER = { prelude: PRELUDE, define: '#define GLOBE' };

const cfg = (over: Partial<ColumnShaderConfig> = {}): ColumnShaderConfig => ({
  mode: 'window',
  filter: false,
  ...over,
});

/** Both host variants of one configuration, for "identical in both" assertions. */
const bothVariants = (
  build: (s: typeof LEGACY_SHADER, c: ColumnShaderConfig) => string,
  c: ColumnShaderConfig,
): [string, string] => [build(LEGACY_SHADER, c), build(V5_SHADER, c)];

/** Every source builder, so a config assertion can sweep all four passes. */
const ALL_BUILDERS = [
  buildColumnVertexSource,
  buildColumnIdVertexSource,
  buildColumnStrokeVertexSource,
  buildColumnStrokeIdVertexSource,
];

const allSources = (c: ColumnShaderConfig): string[] =>
  ALL_BUILDERS.flatMap((b) => bothVariants(b, c));

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

const legacyFrame = () => normalizeRenderArgs(new Float32Array(16));

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

/** Scalar value of the last upload to `name`, or undefined if never set. */
const lastScalar = (u: Map<string, unknown[][]>, name: string): unknown =>
  u.get(name)?.at(-1)?.[0];

function makeLayer(extra: Record<string, unknown> = {}, gl?: any) {
  const layer = new STTColumnLayer({ ...baseOpts, id: 'c', ...extra }) as any;
  layer.supports32BitIndices = true;
  if (gl) {
    // The shared recorder hands every attribute location 0, which would make a
    // per-slot assertion (divisors!) vacuous — give each NAME its own slot, the
    // way a real linker does.
    const slots = new Map<string, number>();
    gl.getAttribLocation = vi.fn((_program: unknown, name: string) => {
      if (!slots.has(name)) slots.set(name, slots.size);
      return slots.get(name)!;
    });
    // The real `initInstanceSupport` / `initVaoSupport` run in onAdd, which
    // these direct-hook tests bypass — route both through the recorder so
    // instanced draws and VAO reuse/rebuild are observable.
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
      vertexAttribDivisor: (i: number, d: number) =>
        gl.vertexAttribDivisor(i, d),
    };
    layer.vaoSupport = {
      enabled: true,
      create: () => gl.createVertexArray(),
      bind: (vao: unknown) => gl.bindVertexArray(vao),
      delete: (vao: unknown) => gl.deleteVertexArray(vao),
      current: () => null,
    };
  }
  return layer;
}

function makeLayerWithCache(
  extra: Record<string, unknown> = {},
  tile = makePointTile(),
) {
  const gl = makeMockGl();
  const layer = makeLayer(extra, gl);
  const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
  return { layer, gl, tile, cache };
}

// ── CPU geometry ────────────────────────────────────────────────────────────

describe('unit ring', () => {
  it('inscribes a regular polygon in the unit circle', () => {
    const ring = columnUnitRing(4);
    expect(ring.length).toBe(8);
    expect(ring[0]).toBeCloseTo(1, 12);
    expect(ring[1]).toBeCloseTo(0, 12);
    expect(ring[2]).toBeCloseTo(0, 12);
    expect(ring[3]).toBeCloseTo(1, 12);
    expect(ring[4]).toBeCloseTo(-1, 12);
    for (let i = 0; i < 4; i++) {
      expect(Math.hypot(ring[i * 2], ring[i * 2 + 1])).toBeCloseTo(1, 12);
    }
  });

  it('clamps a degenerate diskResolution to a renderable polygon', () => {
    expect(columnUnitRing(2).length).toBe(6); // 3 points
    expect(columnUnitRing(Number.NaN).length).toBe(40); // the 20-side default
  });

  it('custom vertices replace the polygon verbatim', () => {
    const ring = columnUnitRing(20, [
      [0, 0],
      [2, 0],
      [0, 3],
    ]);
    expect(Array.from(ring)).toEqual([0, 0, 2, 0, 0, 3]);
  });
});

describe('unit prism mesh', () => {
  const n = 6;

  it('extruded: top cap at full brightness + a darker wall band', () => {
    const mesh = buildColumnMesh(n, true);
    expect(mesh.vertexCount).toBe(n * 3);
    expect(mesh.vertices.length).toBe(n * 3 * 4);
    // Cap: unitZ 1, shade 1.
    for (let i = 0; i < n; i++) {
      expect(mesh.vertices[i * 4 + 2]).toBe(1);
      expect(mesh.vertices[i * 4 + 3]).toBe(1);
    }
    // Wall top ring: unitZ 1, darker; wall bottom ring: unitZ 0, darker.
    for (let i = 0; i < n; i++) {
      expect(mesh.vertices[(n + i) * 4 + 2]).toBe(1);
      expect(mesh.vertices[(n + i) * 4 + 3]).toBe(WALL_SHADE);
      expect(mesh.vertices[(2 * n + i) * 4 + 2]).toBe(0);
      expect(mesh.vertices[(2 * n + i) * 4 + 3]).toBe(WALL_SHADE);
    }
    // Wall vertices sit directly under/over their cap vertex (same xy).
    for (let i = 0; i < n; i++) {
      expect(mesh.vertices[(n + i) * 4]).toBe(mesh.vertices[i * 4]);
      expect(mesh.vertices[(2 * n + i) * 4 + 1]).toBe(mesh.vertices[i * 4 + 1]);
    }
    // Cap fan (n-2 triangles) + 2 triangles per ring edge.
    expect(mesh.indexCount).toBe(3 * (n - 2) + 6 * n);
    expect(mesh.indices.length).toBe(mesh.indexCount);
    for (const idx of mesh.indices) expect(idx).toBeLessThan(mesh.vertexCount);
  });

  it('flat: the cap alone, still at unitZ 1 (uElevationScale flattens it)', () => {
    const mesh = buildColumnMesh(n, false);
    expect(mesh.vertexCount).toBe(n);
    expect(mesh.indexCount).toBe(3 * (n - 2));
    for (let i = 0; i < n; i++) expect(mesh.vertices[i * 4 + 2]).toBe(1);
  });

  it('every wall edge is covered exactly once, closing edge included', () => {
    const mesh = buildColumnMesh(n, true);
    const wallIndices = mesh.indices.subarray(3 * (n - 2));
    const edges = new Set<string>();
    for (let t = 0; t < wallIndices.length; t += 6) {
      // Each quad is (tA, bA, tB, tB, bA, bB) — recover (A, B) from the ring.
      const a = wallIndices[t] - n;
      const b = wallIndices[t + 2] - n;
      edges.add(`${a}-${b}`);
    }
    expect(edges.size).toBe(n);
    expect(edges.has(`${n - 1}-0`)).toBe(true); // the wrap-around edge
  });

  it('is cached per (diskResolution, extruded); custom vertices are not', () => {
    expect(buildColumnMesh(9, true)).toBe(buildColumnMesh(9, true));
    expect(buildColumnMesh(9, false)).not.toBe(buildColumnMesh(9, true));
    const verts: Array<[number, number]> = [
      [1, 0],
      [0, 1],
      [-1, 0],
    ];
    expect(buildColumnMesh(9, true, verts)).not.toBe(
      buildColumnMesh(9, true, verts),
    );
    expect(buildColumnMesh(9, true, verts).vertexCount).toBe(9); // 3 ring pts × 3
  });
});

describe('ring-outline mesh', () => {
  it('emits two triangles per ring edge carrying BOTH endpoints', () => {
    const n = 5;
    const mesh = buildColumnStrokeMesh(n);
    expect(mesh.vertexCount).toBe(n * 6);
    expect(mesh.vertices.length).toBe(n * 6 * 6);
    const ring = columnUnitRing(n);
    for (let e = 0; e < n; e++) {
      const next = (e + 1) % n;
      for (let v = 0; v < 6; v++) {
        const base = (e * 6 + v) * 6;
        expect(Math.abs(mesh.vertices[base])).toBe(1); // side ∈ {-1, +1}
        expect([0, 1]).toContain(mesh.vertices[base + 1]); // along ∈ {0, 1}
        expect(mesh.vertices[base + 2]).toBeCloseTo(ring[e * 2], 6);
        expect(mesh.vertices[base + 3]).toBeCloseTo(ring[e * 2 + 1], 6);
        expect(mesh.vertices[base + 4]).toBeCloseTo(ring[next * 2], 6);
        expect(mesh.vertices[base + 5]).toBeCloseTo(ring[next * 2 + 1], 6);
      }
    }
  });

  it('is cached per diskResolution', () => {
    expect(buildColumnStrokeMesh(7)).toBe(buildColumnStrokeMesh(7));
  });
});

// ── JS references the shaders mirror ────────────────────────────────────────

describe('CPU references', () => {
  it('the space-time lift is metres per sim-ms from the origin', () => {
    // 40 m per playback minute, 5 minutes past the origin ⇒ 200 m.
    const scale = 40 / 60_000;
    expect(timeHeightLiftMeters(5 * 60_000, 0, scale)).toBeCloseTo(200, 9);
    // Before the origin the lift goes negative (deck does not clamp either).
    expect(timeHeightLiftMeters(0, 60_000, scale)).toBeCloseTo(-40, 9);
    // Scale 0 is the flat map, whatever the times are.
    expect(timeHeightLiftMeters(1e12, 0, 0)).toBe(0);
  });

  it('vertex elevation stacks base + lift + scaled height at the top only', () => {
    const base = 12;
    const lift = 200;
    // unitZ 0 (prism base) never picks up the height…
    expect(columnVertexElevationMeters(base, lift, 500, 3, 0)).toBe(212);
    // …and unitZ 1 picks up height × elevationScale, but NOT lift × scale.
    expect(columnVertexElevationMeters(base, lift, 500, 3, 1)).toBe(1712);
  });

  it('radius scale: metric is latitude-correct, pixels track the zoom world', () => {
    const lat = 45;
    expect(resolveColumnRadiusScale('meters', 1, lat, 4)).toBeCloseTo(
      metersToMercatorUnits(1, lat),
      15,
    );
    // coverage folds straight in.
    expect(resolveColumnRadiusScale('meters', 0.5, lat, 4)).toBeCloseTo(
      0.5 * metersToMercatorUnits(1, lat),
      15,
    );
    // 512 CSS px per tile ⇒ one CSS pixel is 1/(512·2^zoom) mercator units at
    // dpr 1, and the factor is latitude-INDEPENDENT (pixels are pixels).
    expect(resolveColumnRadiusScale('pixels', 1, lat, 4)).toBeCloseTo(
      1 / (512 * 16),
      15,
    );
    expect(resolveColumnRadiusScale('pixels', 1, 0, 4)).toBe(
      resolveColumnRadiusScale('pixels', 1, 80, 4),
    );
    // …and the unit is DEVICE pixels, so a Retina frame halves the mercator
    // size of one radius unit. Without this the disk would grow with dpr while
    // its own `lineWidth` outline (device px, expanded against uViewport) and
    // every sibling kind's pixel size stayed put.
    expect(resolveColumnRadiusScale('pixels', 1, lat, 4, 2)).toBeCloseTo(
      1 / (512 * 2 * 16),
      15,
    );
    // The metres branch is dpr-INDEPENDENT: a ground metre is a ground metre.
    expect(resolveColumnRadiusScale('meters', 1, lat, 4, 2)).toBe(
      resolveColumnRadiusScale('meters', 1, lat, 4, 1),
    );
  });

  it('time-filter mode resolution follows deck precedence', () => {
    expect(resolveColumnTimeFilterMode(undefined, 0, 0)).toBe('window');
    expect(resolveColumnTimeFilterMode(undefined, 1000, 0)).toBe('wake');
    expect(resolveColumnTimeFilterMode(undefined, 0, 1000)).toBe('trail');
    expect(resolveColumnTimeFilterMode(undefined, 1000, 1000)).toBe('wake');
    expect(resolveColumnTimeFilterMode('cumulative', 0, 0)).toBe('cumulative');
    // A degenerate length would light nothing — degrade to window instead.
    expect(resolveColumnTimeFilterMode('wake', 0, 0)).toBe('window');
    expect(resolveColumnTimeFilterMode('trail', 0, 0)).toBe('window');
  });
});

// ── shader sources ──────────────────────────────────────────────────────────

describe('column vertex-source builders', () => {
  it('legacy variant projects through uMatrix with metres → mercator-z', () => {
    const src = buildColumnVertexSource(LEGACY_SHADER);
    expect(src).toContain('uniform mat4 uMatrix;');
    expect(src).toContain(
      'vec4 here = uMatrix * vec4(posM, elevM * uMercatorZPerMeter, 1.0);',
    );
    expect(src).not.toContain('projectTileFor3D');
    expect(src).not.toContain('#ifdef GLOBE');
    expect(src).toContain(
      'sttDecodeMercatorPos(aMercator, uPosScale, uPosOffset)',
    );
  });

  it('v5 variant prepends prelude then define and projects in 3D', () => {
    const src = buildColumnVertexSource(V5_SHADER);
    expect(src.startsWith(PRELUDE)).toBe(true);
    const defineAt = src.indexOf('#define GLOBE');
    expect(defineAt).toBeGreaterThan(PRELUDE_MARKER.length);
    expect(defineAt).toBeLessThan(src.indexOf('attribute vec4 aUnit'));
    expect(src).toContain(
      'vec4 here = projectTileFor3D(posM, elevM * uMercatorZPerMeter);',
    );
    // The globe branch re-derives horizon clipping (projectTileFor3D preserves
    // z there) and feeds the transition fallback mercator-z.
    expect(src).toContain('#ifdef GLOBE');
    expect(src).toContain('globeComputeClippingZ(hereSphere)');
    expect(src).toContain('u_projection_fallback_matrix');
    expect(src).not.toContain('uniform mat4 uMatrix;');
  });

  it('scales the unit prism per instance and lifts by feature time', () => {
    for (const src of bothVariants(buildColumnVertexSource, cfg())) {
      expect(src).toContain(
        'vec2 unitXY = sttRotateDisk(aUnit.xy, uDiskRotation);',
      );
      expect(src).toContain(
        'vec2 posM = center.xy + (unitXY + uDiskOffset) * radius;',
      );
      expect(src).toContain('float radius = uRadius * uRadiusScale * visible;');
      // The space-time cube: metres per sim-ms off the feature's START time,
      // added to the base altitude and NOT multiplied by uElevationScale.
      expect(src).toContain(
        'float liftM = (aTime.x - uTimeHeightOrigin) * uTimeHeightScale;',
      );
      expect(src).toContain(
        'float elevM = center.z + liftM + aUnit.z * heightM;',
      );
      expect(src).toContain('float heightM = heightRaw * uElevationScale;');
      // deck's `shouldRender`: a negative height collapses the footprint.
      expect(src).toContain('float visible = (heightRaw >= 0.0) ? 1.0 : 0.0;');
    }
  });

  it('the id builders swap the colour PAYLOAD for a flat pick id, keeping its alpha as a gate', () => {
    for (const src of bothVariants(buildColumnIdVertexSource, cfg())) {
      expect(src).toContain('attribute vec3 aIdColor;');
      expect(src).toContain('vIdColor = aIdColor;');
      // No colour is painted…
      expect(src).not.toContain('varying vec4 vColor;');
      // …but the colour ALPHA still gates the pass, so a `color: [r,g,b,0]`
      // prism (or a colorMapping entry with alpha 0) is invisible AND
      // unpickable, the way deck's picking_filterPickingColor discards.
      expect(src).toContain(
        'vAlpha *= ((uUseFeatureColor > 0.5) ? aColor.a : uColor.a);',
      );
      // The gate lands AFTER the size terms, so a tint can never shrink the
      // footprint (only the wake taper and the DataFilter may).
      expect(src.indexOf('float radius = uRadius')).toBeLessThan(
        src.indexOf('vAlpha *= (('),
      );
    }
  });

  it('the id STROKE builder gates on the outline colour alpha', () => {
    for (const src of bothVariants(buildColumnStrokeIdVertexSource, cfg())) {
      expect(src).toContain('attribute vec3 aIdColor;');
      // lineColor is a uniform, so the ring's gate is the uniform's alpha.
      expect(src).toContain('vAlpha *= uColor.a;');
    }
  });

  it('the stroke builders expand the ring in SCREEN space off both 3D ends', () => {
    for (const src of bothVariants(buildColumnStrokeVertexSource, cfg())) {
      expect(src).toContain('attribute vec2 aCorner;');
      expect(src).toContain('attribute vec4 aUnitAB;');
      // Both endpoints are projected at the TOP cap elevation, then offset in
      // pixels — so the outline rides the prism rather than the ground.
      expect(src).toContain('float elevM = center.z + liftM + heightM;');
      expect(src).toContain('vec2 hereNdc = here.xy / here.w;');
      expect(src).toContain('vec2 thereNdc = there.xy / there.w;');
      expect(src).toContain('outClip.xy += offsetNdc * here.w;');
      expect(src).toContain('uniform vec2 uViewport;');
    }
    const legacy = buildColumnStrokeVertexSource(LEGACY_SHADER);
    expect(legacy).toContain('vec4 here = uMatrix *');
    expect(legacy).toContain('vec4 there = uMatrix *');
    const v5 = buildColumnStrokeVertexSource(V5_SHADER);
    expect(v5).toContain('vec4 here = projectTileFor3D(posM,');
    expect(v5).toContain('vec4 there = projectTileFor3D(neighborM,');
    // The two globe blocks must not collide on a temporary.
    expect(v5).toContain('hereSphere');
    expect(v5).toContain('thereSphere');
  });

  it('collapses fully-gated instances at the vertex stage (per-FEATURE alpha)', () => {
    for (const src of allSources(cfg())) {
      expect(src).toContain('if (vAlpha <= 0.0) gl_Position = vec4(0.0);');
    }
  });

  it('default config compiles NONE of the optional surface', () => {
    for (const src of allSources(cfg())) {
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
  it('wake thins the FOOTPRINT (deck routes DECKGL_FILTER_SIZE through the offset)', () => {
    for (const src of allSources(cfg({ mode: 'wake' }))) {
      expect(src).toContain('float sttWakeAlpha(');
      expect(src).toContain(
        'vAlpha = sttWakeAlpha(aTime, uCurrentTime, uWakeLength);',
      );
      expect(src).toContain(
        'radius *= sttWakeSizeScale(vAlpha, uWakeTailScale);',
      );
      // The shrink reads the alpha and must precede the footprint's use.
      expect(src.indexOf('vAlpha = sttWakeAlpha')).toBeLessThan(
        src.indexOf('radius *= sttWakeSizeScale'),
      );
      // Height is untouched — a wake tail thins, it does not sink.
      expect(src).not.toContain('heightM *= sttWakeSizeScale');
      expect(src).not.toContain('uWindowStart');
    }
  });

  it('cumulative reuses uFadeIn as the reveal ramp', () => {
    for (const src of allSources(cfg({ mode: 'cumulative' }))) {
      expect(src).toContain('float sttCumulativeAlpha(');
      expect(src).toContain(
        'vAlpha = sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn);',
      );
      expect(src).not.toContain('uFadeOut');
    }
  });

  it('trail reads aTime.x — a column reveals whole, never half-drawn', () => {
    for (const src of allSources(cfg({ mode: 'trail' }))) {
      expect(src).toContain(
        'vAlpha = sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail);',
      );
    }
  });

  it('every mode keeps the projection of its host variant', () => {
    for (const mode of ['window', 'wake', 'cumulative', 'trail'] as const) {
      const [legacy, v5] = bothVariants(buildColumnVertexSource, cfg({ mode }));
      expect(legacy).toContain('vec4 here = uMatrix *');
      expect(legacy).not.toContain('projectTileFor3D');
      expect(v5).toContain('projectTileFor3D(posM,');
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
      expect(src).toContain('uniform vec2 uFilterSoftRange;');
      expect(src).toContain('float sttDataFilterAlpha(');
      // The canonical call verbatim, so the layers cannot drift.
      expect(src).toContain(`float filterAlpha = ${DATA_FILTER_CALL_GLSL};`);
    }
  });

  it('hard-filters regardless of the flags; the size transform thins the footprint', () => {
    const src = buildColumnVertexSource(LEGACY_SHADER, filtered);
    expect(src).toContain('if (filterAlpha <= 0.0) {\n      vAlpha = 0.0;');
    expect(src).toContain('} else if (uFilterTransformColor > 0.5) {');
    expect(src).toContain(
      'if (uFilterTransformSize > 0.5) {\n      radius *= filterAlpha;',
    );
    // Both transforms land before the footprint is consumed.
    expect(src.indexOf('radius *= filterAlpha;')).toBeLessThan(
      src.indexOf('vec2 posM ='),
    );
  });

  it('composes multiplicatively with the time filter, never replacing it', () => {
    const src = buildColumnVertexSource(LEGACY_SHADER, {
      mode: 'cumulative',
      filter: true,
    });
    expect(src).toContain('vAlpha = sttCumulativeAlpha(');
    expect(src).toContain('vAlpha *= filterAlpha;');
    expect(src.indexOf('vAlpha = sttCumulativeAlpha')).toBeLessThan(
      src.indexOf('vAlpha *= filterAlpha;'),
    );
  });

  it('program keys separate every compiled configuration', () => {
    const keys = new Set([
      columnProgramKey('fill', cfg()),
      columnProgramKey('fill', cfg({ mode: 'wake' })),
      columnProgramKey('fill', cfg({ filter: true })),
      columnProgramKey('stroke', cfg()),
      columnProgramKey('pick-fill', cfg()),
      columnProgramKey('pick-stroke', cfg()),
    ]);
    expect(keys.size).toBe(6);
    expect(columnProgramKey('fill', cfg())).toBe('column:fill:window');
    expect(
      columnProgramKey('pick-stroke', cfg({ mode: 'trail', filter: true })),
    ).toBe('column:pick-stroke:trail:filter');
  });
});

// ── prop defaults ───────────────────────────────────────────────────────────

describe('prop defaults', () => {
  it('mirrors the deck ColumnLayer defaults', () => {
    const layer = makeLayer() as any;
    const o = layer.columnOpts;
    expect(o.diskResolution).toBe(20);
    expect(o.radius).toBe(100);
    expect(o.radiusUnits).toBe('meters');
    expect(o.elevation).toBe(1000);
    expect(o.elevationScale).toBe(1);
    expect(o.coverage).toBe(1);
    expect(o.angle).toBe(0);
    expect(o.extruded).toBe(true);
    expect(o.filled).toBe(true);
    expect(o.stroked).toBe(false);
    // Space-time cube OFF by default: a fresh layer renders a flat bar chart.
    expect(o.timeHeightScale).toBe(0);
    expect(o.timeHeightOrigin).toBe(0);
    expect(o.reducedMotion).toBe(false);
    expect(layer.shaderConfig).toEqual({ mode: 'window', filter: false });
  });

  it('an explicitly-passed undefined does not shadow a default', () => {
    // The React prop-forwarding shape `{...base, radius: props.radius}` carries
    // undefined as an OWN key — `??` must still fall through to the default.
    const layer = makeLayer({
      radius: undefined,
      extruded: undefined,
      diskResolution: undefined,
      renderingMode: undefined,
      elevation: undefined,
      fadeTrail: undefined,
    }) as any;
    expect(layer.columnOpts.radius).toBe(100);
    expect(layer.columnOpts.extruded).toBe(true);
    expect(layer.columnOpts.diskResolution).toBe(20);
    expect(layer.columnOpts.elevation).toBe(1000);
    expect(layer.columnOpts.fadeTrail).toBe(1);
    expect(layer.renderingMode).toBe('3d');
  });

  it('reducedMotion forces the space-time lift to zero', () => {
    const on = makeLayer({ timeHeightScale: 0.01, reducedMotion: true }) as any;
    expect(on.effectiveTimeHeightScale()).toBe(0);
    const off = makeLayer({ timeHeightScale: 0.01 }) as any;
    expect(off.effectiveTimeHeightScale()).toBe(0.01);
    off.setReducedMotion(true);
    expect(off.effectiveTimeHeightScale()).toBe(0);
  });

  it('a property-driven elevation falls back to the deck constant, not 0', () => {
    const layer = makeLayer({ elevation: 'rides' }) as any;
    // A 0-height prism is invisible — that reads as a broken tile, not a style.
    expect(layer.constantElevation()).toBe(1000);
  });
});

describe('renderingMode / depth participation', () => {
  it("defaults to '3d' so prisms share the host's depth buffer", () => {
    const gl = makeMockGl();
    const layer = makeLayer({}, gl) as any;
    expect(layer.renderingMode).toBe('3d');
    layer.applySharedGlState(gl);
    expect(gl.enable).toHaveBeenCalledWith(gl.BLEND);
    // The host already installed its LEQUAL read-write depth mode — touching
    // DEPTH_TEST here is exactly what would break prism occlusion.
    expect(gl.disable).not.toHaveBeenCalledWith(gl.DEPTH_TEST);
  });

  it("'2d' restores the package's always-on-top behaviour", () => {
    const gl = makeMockGl();
    const layer = makeLayer({ renderingMode: '2d' }, gl) as any;
    expect(layer.renderingMode).toBe('2d');
    layer.applySharedGlState(gl);
    expect(gl.disable).toHaveBeenCalledWith(gl.DEPTH_TEST);
  });
});

// ── draw ────────────────────────────────────────────────────────────────────

describe('drawTile', () => {
  it('draws ONE instanced call: the shared mesh × the tile features', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const mesh = buildColumnMesh(20, true);
    expect(gl.drawCalls).toEqual([
      {
        kind: 'elements-instanced',
        count: mesh.indexCount * 2,
        vertices: mesh.indexCount,
        instances: 2,
      },
    ]);
    // One mesh upload for the layer, not one per tile.
    expect(cache.instanceCount).toBe(2);
  });

  it('v5 frame: prelude source, u_projection_* set, no uMatrix upload', () => {
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
        'u_projection_transition',
        'u_projection_fallback_matrix',
      ]),
    );
    const matrices = gl.uniformMatrix4fv.mock.calls.map((c: unknown[]) => c[2]);
    expect(matrices).toContain(frame.projectionData!.mainMatrix);
    expect(matrices).not.toContain(frame.matrix);
  });

  it('legacy frame: uMatrix path, no prelude uniform lookups', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const frame = normalizeRenderArgs(new Float32Array(16).fill(2));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));
    const matrices = gl.uniformMatrix4fv.mock.calls.map((c: unknown[]) => c[2]);
    expect(matrices).toContain(frame.matrix);
    const looked = gl.getUniformLocation.mock.calls.map((c: unknown[]) => c[1]);
    expect(looked).not.toContain('u_projection_matrix');
  });

  it('caches per variant: same frame reuses the program AND the tile VAO', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const frame = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));
    const programs = gl.createProgram.mock.calls.length;
    const vaos = gl.createVertexArray.mock.calls.length;
    const buffers = gl.createBuffer.mock.calls.length;

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));
    expect(gl.createProgram.mock.calls.length).toBe(programs);
    expect(gl.createVertexArray.mock.calls.length).toBe(vaos);
    // The unit mesh is uploaded once per context, never per frame.
    expect(gl.createBuffer.mock.calls.length).toBe(buffers);
  });

  it('a variant flip relinks once and re-records the tile VAO', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const legacy = legacyFrame();
    const globe = normalizeRenderArgs(v5Args('globe', 1));

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacy));
    expect(gl.createProgram.mock.calls.length).toBe(1);
    expect(gl.createVertexArray.mock.calls.length).toBe(1);

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(globe));
    expect(gl.createProgram.mock.calls.length).toBe(2);
    expect(gl.deleteVertexArray).toHaveBeenCalledTimes(1);
    expect(gl.createVertexArray.mock.calls.length).toBe(2);

    // Flip back: the program is cached, only the VAO is re-recorded.
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacy));
    expect(gl.createProgram.mock.calls.length).toBe(2);
    expect(gl.createVertexArray.mock.calls.length).toBe(3);
  });

  it('stroked adds a second instanced pass over the ring mesh', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({ stroked: true });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const stroke = buildColumnStrokeMesh(20);
    expect(gl.drawCalls).toHaveLength(2);
    expect(gl.drawCalls[1]).toEqual({
      kind: 'arrays-instanced',
      count: stroke.vertexCount * 2,
      vertices: stroke.vertexCount,
      instances: 2,
    });
    // Fill and stroke record independent VAO slots.
    expect(cache.vao).toBeTruthy();
    expect(cache.strokeVao).toBeTruthy();
    expect(cache.vao).not.toBe(cache.strokeVao);
  });

  it('filled: false draws the outline alone', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      filled: false,
      stroked: true,
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.drawCalls.map((d: any) => d.kind)).toEqual(['arrays-instanced']);
  });

  it('a runtime without instancing warns once and draws nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { layer, gl, tile, cache } = makeLayerWithCache();
      layer.instSupport = {
        enabled: false,
        drawArraysInstanced: vi.fn(),
        drawElementsInstanced: vi.fn(),
        vertexAttribDivisor: vi.fn(),
      };
      layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
      layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
      expect(gl.drawCalls).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('elevation + sizing uniforms', () => {
  it('converts METRES at the tile latitude and relativizes the height origin', () => {
    const origin = 1_700_000_000_500;
    const { layer, gl, tile, cache } = makeLayerWithCache({
      timeHeightScale: 0.002,
      timeHeightOrigin: origin,
      elevationScale: 3,
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uMercatorZPerMeter')).toBeCloseTo(
      mercatorZFromAltitude(1, tileCenterLatitude(tile.id.z, tile.id.y)),
      15,
    );
    // Absolute epoch ms in, tile-relative out — the f32-exact convention.
    expect(lastScalar(u, 'uTimeHeightOrigin')).toBe(origin - cache.timeOffset);
    expect(lastScalar(u, 'uTimeHeightScale')).toBe(0.002);
    expect(lastScalar(u, 'uElevationScale')).toBe(3);
    expect(lastScalar(u, 'uElevation')).toBe(1000);
  });

  it('extruded: false flattens by zeroing the height scale', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      extruded: false,
      elevationScale: 5,
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(lastScalar(uniformsByName(gl), 'uElevationScale')).toBe(0);
    // …and the mesh loses its wall band entirely.
    expect(buildColumnMesh(20, false).vertexCount).toBe(20);
  });

  it('a per-feature height column drives uUseFeatureElevation', () => {
    const withCol = makeLayerWithCache(
      { elevation: 'magnitude' },
      makePropertyPointTile(),
    );
    expect(withCol.cache.elevationBuffer).toBeDefined();
    withCol.layer.drawTile(
      withCol.gl,
      withCol.tile,
      withCol.tile.layers[0],
      withCol.cache,
      drawCtx(legacyFrame()),
    );
    expect(lastScalar(uniformsByName(withCol.gl), 'uUseFeatureElevation')).toBe(
      1,
    );

    // A tile MISSING the column renders at the constant height, not at 0.
    const without = makeLayerWithCache({ elevation: 'magnitude' });
    expect(without.cache.elevationBuffer).toBeUndefined();
    without.layer.drawTile(
      without.gl,
      without.tile,
      without.tile.layers[0],
      without.cache,
      drawCtx(legacyFrame()),
    );
    const u = uniformsByName(without.gl);
    expect(lastScalar(u, 'uUseFeatureElevation')).toBe(0);
    expect(lastScalar(u, 'uElevation')).toBe(1000);
  });

  it('metric radius folds coverage + latitude + FRACTIONAL zoom into one scale', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      radius: 250,
      coverage: 0.8,
    });
    layer.map = { getZoom: () => 2.5, triggerRepaint: vi.fn() };
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uRadiusScale')).toBeCloseTo(
      resolveColumnRadiusScale(
        'meters',
        0.8,
        tileCenterLatitude(tile.id.z, tile.id.y),
        2.5,
      ),
      18,
    );
    // The radius itself uploads raw — the unit lives in the scale.
    expect(lastScalar(u, 'uRadius')).toBe(250);
  });

  it("'pixels' sizing tracks the zoom world and needs no latitude", () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      radiusUnits: 'pixels',
      radius: 8,
    });
    layer.map = { getZoom: () => 3, triggerRepaint: vi.fn() };
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(lastScalar(uniformsByName(gl), 'uRadiusScale')).toBeCloseTo(
      1 / (512 * 8),
      18,
    );
  });

  it('angle reaches the shader as (cos, sin) — no transcendentals per vertex', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({ angle: 90 });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const rot = uniformsByName(gl).get('uDiskRotation')!.at(-1)!;
    expect(rot[0] as number).toBeCloseTo(0, 12);
    expect(rot[1] as number).toBeCloseTo(1, 12);
    layer.setAngle(180);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const rot2 = uniformsByName(gl).get('uDiskRotation')!.at(-1)!;
    expect(rot2[0] as number).toBeCloseTo(-1, 12);
  });
});

describe('time-mode uniform wiring', () => {
  it('default layer sets ONLY the window uniforms', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const ctx = drawCtx(legacyFrame());
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uWindowStart')).toBe(ctx.windowStart);
    expect(lastScalar(u, 'uWindowEnd')).toBe(ctx.windowEnd);
    expect(lastScalar(u, 'uFadeIn')).toBe(0);
    expect(lastScalar(u, 'uFadeOut')).toBe(0);
    expect(u.has('uCurrentTime')).toBe(false);
    expect(u.has('uFilterEnabled')).toBe(false);
  });

  it('wake sets tile-relative uCurrentTime + the wake knobs', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      timeFilterMode: 'wake',
      wakeLength: 30_000,
    });
    const ctx = drawCtx(legacyFrame());
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uCurrentTime')).toBe(
      ctx.currentTime - cache.timeOffset,
    );
    expect(lastScalar(u, 'uWakeLength')).toBe(30_000);
    expect(lastScalar(u, 'uWakeTailScale')).toBe(0.15);
    expect(u.has('uWindowStart')).toBe(false);
  });

  it('cumulative reuses uFadeIn; trail sets the trail knobs', () => {
    const cum = makeLayerWithCache({
      timeFilterMode: 'cumulative',
      fadeInDuration: 2000,
    });
    cum.layer.drawTile(
      cum.gl,
      cum.tile,
      cum.tile.layers[0],
      cum.cache,
      drawCtx(legacyFrame()),
    );
    expect(lastScalar(uniformsByName(cum.gl), 'uFadeIn')).toBe(2000);

    const trail = makeLayerWithCache({
      timeFilterMode: 'trail',
      trailLength: 60_000,
      fadeTrail: false,
    });
    trail.layer.drawTile(
      trail.gl,
      trail.tile,
      trail.tile.layers[0],
      trail.cache,
      drawCtx(legacyFrame()),
    );
    const u = uniformsByName(trail.gl);
    expect(lastScalar(u, 'uTrailLength')).toBe(60_000);
    expect(lastScalar(u, 'uFadeTrail')).toBe(0);
  });

  it('the wake JS reference composes exactly as the vertex source does', () => {
    const tail = 0.15;
    expect(wakeSizeScaleJS(wakeAlphaJS(0, 0, 1000), tail)).toBe(1);
    expect(wakeSizeScaleJS(wakeAlphaJS(0, 1000, 1000), tail)).toBeCloseTo(
      tail,
      12,
    );
  });
});

describe('DataFilter wiring', () => {
  it('binds the per-feature column directly (one column == one instance)', () => {
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
    expect(
      Array.from(u.get('uFilterSoftRange')!.at(-1)![0] as Float32Array),
    ).toEqual([1, 5]);
    expect(lastScalar(u, 'uFilterTransformSize')).toBe(1);
    expect(lastScalar(u, 'uFilterTransformColor')).toBe(1);
  });

  it('a tile MISSING the column renders unfiltered, never blank', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      filterProperty: 'magnitude',
      filterRange: [1, 5] as const,
    });
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

    layer.setFilterEnabled(false);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(lastScalar(uniformsByName(gl), 'uFilterEnabled')).toBe(0);
  });

  it('the compiled composition matches the JS reference', () => {
    // Mirrors FILTER_BODY: a hard 0 always hides; a soft-margin value fades
    // only when the colour transform is on.
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
    expect(compose(1, 99, [0, 10], [0, 10], false)).toBe(0);
    const soft = dataFilterAlphaJS(9, [0, 10], [0, 8], true);
    expect(compose(1, 9, [0, 10], [0, 8], true)).toBeCloseTo(soft, 12);
    expect(compose(1, 9, [0, 10], [0, 8], false)).toBe(1);
  });
});

describe('drawPickTile (invisible ⇒ unpickable)', () => {
  it('paints one flat id per instance and frees the id buffer', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    const mesh = buildColumnMesh(20, true);
    expect(gl.drawCalls).toEqual([
      {
        kind: 'elements-instanced',
        count: mesh.indexCount * 2,
        vertices: mesh.indexCount,
        instances: 2,
      },
    ]);
    expect(
      vertexSources(gl).some((s) => s.includes('attribute vec3 aIdColor;')),
    ).toBe(true);
    expect(gl.deleteBuffer).toHaveBeenCalled();
  });

  it('compiles the SAME time mode and applies the SAME filter range', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache(
      {
        timeFilterMode: 'wake',
        wakeLength: 30_000,
        filterProperty: 'magnitude',
        filterRange: [1, 5] as const,
      },
      makePropertyPointTile(),
    );
    const ctx = drawCtx(legacyFrame());
    layer.drawPickTile(gl, tile, tile.layers[0], cache, ctx, 1);

    const idSrc = vertexSources(gl).find((s) =>
      s.includes('attribute vec3 aIdColor;'),
    )!;
    expect(idSrc).toContain(
      'vAlpha = sttWakeAlpha(aTime, uCurrentTime, uWakeLength);',
    );
    expect(idSrc).toContain(
      'radius *= sttWakeSizeScale(vAlpha, uWakeTailScale);',
    );
    expect(idSrc).toContain(`float filterAlpha = ${DATA_FILTER_CALL_GLSL};`);

    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uCurrentTime')).toBe(
      ctx.currentTime - cache.timeOffset,
    );
    expect(lastScalar(u, 'uFilterEnabled')).toBe(1);
  });

  it('sizes and lifts identically to the visual pass', () => {
    const layerOpts = {
      radius: 250,
      coverage: 0.5,
      timeHeightScale: 0.01,
      timeHeightOrigin: 1_700_000_000_500,
      elevationScale: 2,
    };
    const { layer, gl, tile, cache } = makeLayerWithCache(layerOpts);
    layer.map = { getZoom: () => 4, triggerRepaint: vi.fn() };
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const visual = uniformsByName(gl);

    const gl2 = makeMockGl();
    layer.drawPickTile(
      gl2,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    const pick = uniformsByName(gl2);
    for (const name of [
      'uRadius',
      'uRadiusScale',
      'uElevation',
      'uElevationScale',
      'uMercatorZPerMeter',
      'uTimeHeightScale',
      'uTimeHeightOrigin',
    ]) {
      expect(lastScalar(pick, name)).toBe(lastScalar(visual, name));
    }
  });

  it('leaves every per-instance divisor back at 0 on the default VAO', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache(
      { stroked: true, filterProperty: 'magnitude', elevation: 'magnitude' },
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
    const divisors = gl.vertexAttribDivisor.mock.calls as number[][];
    expect(divisors.length).toBeGreaterThan(0);
    // A pick runs OUTSIDE the host's render pass, so anything left at divisor
    // 1 poisons the next non-instanced draw that lands on the same slot.
    const perAttribute = new Map<number, number>();
    for (const [index, divisor] of divisors) perAttribute.set(index, divisor);
    for (const divisor of perAttribute.values()) expect(divisor).toBe(0);
    expect(gl.disableVertexAttribArray).toHaveBeenCalled();
  });

  it('respects filled/stroked: nothing drawn is nothing pickable', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
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
    expect(makeLayer().supportsPicking()).toBe(true);
  });
});

describe('pick() depth (the 3d kind resolves ids the way it resolves pixels)', () => {
  /** Stand a column layer up far enough to run the base `pick()` end to end. */
  const standUp = () => {
    const gl = makeMockGl();
    const layer = makeLayer({}, gl) as any;
    layer.gl = gl;
    layer.map = {
      getZoom: () => 4,
      getBounds: () => null,
      triggerRepaint: vi.fn(),
    };
    layer.tileset = {}; // truthy — pick() only needs it non-null
    layer.lastMatrix = new Float32Array(16);
    layer.loadedTiles.set('a', makePointTile());
    return { layer, gl };
  };

  it('allocates a DEPTH attachment on the id FBO and depth-tests the pass', () => {
    // renderingMode defaults to '3d' here, and `applySharedGlState` leaves the
    // host's LEQUAL read-write depth mode installed so prisms occlude each
    // other. An id pass with no depth would resolve two overlapping columns by
    // DRAW ORDER instead, so hovering the front prism could return the one
    // hidden behind it.
    const { layer, gl } = standUp();
    expect(layer.renderingMode).toBe('3d');
    layer.pick(100, 100);

    expect(gl.createRenderbuffer).toHaveBeenCalled();
    expect(gl.renderbufferStorage).toHaveBeenCalledWith(
      gl.RENDERBUFFER,
      gl.DEPTH_COMPONENT16,
      gl.drawingBufferWidth,
      gl.drawingBufferHeight,
    );
    expect(gl.framebufferRenderbuffer).toHaveBeenCalledWith(
      gl.FRAMEBUFFER,
      gl.DEPTH_ATTACHMENT,
      gl.RENDERBUFFER,
      expect.anything(),
    );
    expect(gl.enable).toHaveBeenCalledWith(gl.DEPTH_TEST);
    expect(gl.depthFunc).toHaveBeenCalledWith(gl.LEQUAL);
    expect(gl.depthMask).toHaveBeenCalledWith(true);
    // …and the depth buffer is actually cleared, or the second pick would
    // hit-test against the first one's depths.
    expect(gl.clear).toHaveBeenCalledWith(
      gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT,
    );
  });

  it('hands the host its depth mode back (maplibre caches it and will not repair it)', () => {
    const { layer, gl } = standUp();
    // Host state on entry: depth off, LESS, writes disabled, clear at 0.5.
    gl.disable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(false);
    gl.clearDepth(0.5);

    layer.pick(100, 100);

    expect(gl.isEnabled(gl.DEPTH_TEST)).toBe(false);
    expect(gl.getParameter(gl.DEPTH_FUNC)).toBe(gl.LESS);
    expect(gl.getParameter(gl.DEPTH_WRITEMASK)).toBe(false);
    expect(gl.getParameter(gl.DEPTH_CLEAR_VALUE)).toBe(0.5);
  });

  it('picks over the FULL depth range, then restores the host slab', () => {
    // A pick fires outside the render pass, so the installed range is whatever
    // the last basemap layer used — for a 2d sublayer, a razor-thin slab that
    // would squeeze every prism into a few of the id buffer's 16 depth bits.
    const { layer, gl } = standUp();
    gl.depthRange(0.4, 0.4001);

    layer.pick(100, 100);

    expect(gl.depthRange).toHaveBeenCalledWith(0, 1);
    const restored = Array.from(
      gl.getParameter(gl.DEPTH_RANGE) as Float32Array,
    );
    expect(restored[0]).toBeCloseTo(0.4, 6);
    expect(restored[1]).toBeCloseTo(0.4001, 6);
  });

  it('a 2d column keeps the depth-less pass (its frame paints in draw order)', () => {
    const gl = makeMockGl();
    const layer = makeLayer({ renderingMode: '2d' }, gl) as any;
    layer.gl = gl;
    layer.map = {
      getZoom: () => 4,
      getBounds: () => null,
      triggerRepaint: vi.fn(),
    };
    layer.tileset = {};
    layer.lastMatrix = new Float32Array(16);
    layer.loadedTiles.set('a', makePointTile());

    layer.pick(100, 100);

    expect(gl.createRenderbuffer).not.toHaveBeenCalled();
    expect(gl.disable).toHaveBeenCalledWith(gl.DEPTH_TEST);
    expect(gl.clear).toHaveBeenCalledWith(gl.COLOR_BUFFER_BIT);
  });
});

describe('mesh lifecycle', () => {
  it('setExtruded swaps the shared mesh and drops the recorded VAOs', () => {
    const gl = makeMockGl();
    const layer = makeLayer({}, gl) as any;
    layer.gl = gl;
    const tile = makePointTile();
    // Route through the base's keyed cache so the invalidation below is real.
    const cache = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(layer.mesh.vertexCount).toBe(60); // 20 sides × (cap + 2 wall rings)
    expect(layer.tileGpuCache.size).toBe(1);

    layer.setExtruded(false);
    expect(layer.mesh).toBeUndefined();
    expect(layer.meshVertexBuffer).toBeUndefined();
    // The tile caches were dropped too, so the next frame rebuilds against the
    // new mesh instead of replaying a VAO that captured the old buffers.
    expect(layer.tileGpuCache.size).toBe(0);

    const fresh = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(gl, tile, tile.layers[0], fresh, drawCtx(legacyFrame()));
    expect(layer.mesh.vertexCount).toBe(20);
    expect(gl.drawCalls.at(-1)!.vertices).toBe(
      buildColumnMesh(20, false).indexCount,
    );
  });

  it('onContextLost releases the mesh buffers and the memoized handles', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(layer.meshVertexBuffer).toBeTruthy();
    expect(layer.fillHandles).toBeTruthy();

    layer.onContextLost(gl);
    expect(layer.meshVertexBuffer).toBeUndefined();
    expect(layer.meshIndexBuffer).toBeUndefined();
    expect(layer.fillHandles).toBeUndefined();
    expect(layer.fillVariant).toBeUndefined();
    // The CPU geometry survives — only GPU handles are context-bound.
    expect(layer.mesh).toBeTruthy();
  });
});

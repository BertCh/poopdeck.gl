/**
 * `STTPointCloudLayer` — lit, elevated 3D points.
 *
 * The kind exists because `pointCloud` degrading to `point` loses the per-point
 * ELEVATION, so the assertions here are organised around the three things that
 * loss costs and one thing the design forbids:
 *
 *  1. ELEVATION goes through `buildElevatedProjection`, in metres, with the
 *     mercator-z conversion folded into `uMercatorZPerMeter` at the TILE's own
 *     latitude — and the source resolution order (property → geometry z →
 *     constant) is CPU-side, so the shader has no source branch.
 *  2. LIGHTING is a directional + ambient term in the fragment stage, with a
 *     per-point normal when the tile bakes one and a sphere-imposter view-space
 *     normal when it does not.
 *  3. COLOUR resolves through four sources in priority order into ONE RGBA8
 *     slot, and the fragment stage MULTIPLIES the lighting into it. The
 *     categorical path must not be able to bypass shading — the structural
 *     guarantee is "there is only one colour path", and that is asserted.
 *  4. Every alpha gate lands in the id-pick program from the same builder.
 *
 * String / mock-GL level only, like every sibling: this repo ships no
 * rasterizer, so real GLSL compilation and the FBO round-trip are
 * browser-verified.
 */

import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { Layer, Tile } from '@poopdeck.gl/core';
import {
  buildPointCloudFragmentSource,
  buildPointCloudIdVertexSource,
  buildPointCloudVertexSource,
  DEFAULT_AMBIENT,
  DEFAULT_DIFFUSE,
  DEFAULT_LIGHT_DIRECTION,
  pointCloudImposterNormalJS,
  pointCloudLightingJS,
  pointCloudProgramKey,
  resolvePointCloudTimeFilterMode,
  STTPointCloudLayer,
  type PointCloudShaderConfig,
} from '../src/layers/point-cloud-layer';
import { GLOBE_ELEVATION_STEPS } from '../src/shaders/globe-elevation.glsl';
import { DATA_FILTER_CALL_GLSL } from '../src/shaders/data-filter.glsl';
import {
  mercatorZFromAltitude,
  metersToPixelsAtLatitude,
  tileCenterLatitude,
} from '../src/lib/projection';
import { makeMockGl } from './mock-gl';

const baseOpts = {
  url: 'mem://cloud.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

const PRELUDE_MARKER = '// __HOST_PRELUDE__';
const PRELUDE = `${PRELUDE_MARKER}\nvec4 projectTileFor3D(vec2 p, float z) { return vec4(p, z, 1.0); }`;
const LEGACY_SHADER = { prelude: '', define: '' };
const V5_SHADER = { prelude: PRELUDE, define: '#define GLOBE' };

const cfg = (
  over: Partial<PointCloudShaderConfig> = {},
): PointCloudShaderConfig => ({
  mode: 'window',
  filter: false,
  normals: false,
  ...over,
});

/** Both host variants of one configuration, for "identical in both" assertions. */
const bothVariants = (
  build: (s: typeof LEGACY_SHADER, c: PointCloudShaderConfig) => string,
  c: PointCloudShaderConfig,
): [string, string] => [build(LEGACY_SHADER, c), build(V5_SHADER, c)];

// ── local fixtures ──────────────────────────────────────────────────────────
// `test/fixtures.ts` has no 3D point tile and no interleaved vector columns,
// and it is not this agent's file to extend — so the cloud fixtures live here.

const TILE_ID = { z: 2, x: 1, y: 1, t: 1_700_000_000_000 };

interface CloudFixtureOptions {
  /** Bake a third position dimension (the altitude source). */
  dims?: 2 | 3;
  numericProps?: Record<string, Float32Array>;
  categoricalProps?: Record<
    string,
    { indices: Uint16Array; categories: string[] }
  >;
  vectorProps?: Record<
    string,
    { value: Float32Array | Uint8Array; size: number }
  >;
}

/**
 * Three points with distinct altitudes (0 m, 120 m, 1500 m) — enough that a
 * layer collapsing them onto the ground plane is visible in the elevation
 * buffer, which is exactly the regression this kind guards.
 */
function makeCloudTile(o: CloudFixtureOptions = {}): Tile {
  const dims = o.dims ?? 3;
  const lngLat: Array<[number, number]> = [
    [-122.4, 37.7],
    [-73.95, 40.75],
    [2.35, 48.85],
  ];
  const alts = [0, 120, 1500];
  const positions = new Float64Array(lngLat.length * dims);
  lngLat.forEach(([lng, lat], i) => {
    positions[i * dims] = lng;
    positions[i * dims + 1] = lat;
    if (dims === 3) positions[i * dims + 2] = alts[i]!;
  });
  const features = {
    featureCount: lngLat.length,
    geometryType: GeometryType.Point,
    positionDimensions: dims,
    positions,
    featureIds: new Uint32Array([0, 1, 2]),
    startTimes: new Float32Array([0, 1000, 2000]),
    endTimes: new Float32Array([3000, 4000, 5000]),
    timeOffset: 1_700_000_000_000,
    numericProps: o.numericProps ?? {},
    categoricalProps: o.categoricalProps ?? {},
    ...(o.vectorProps ? { vectorProps: o.vectorProps } : {}),
  };
  const layer: Layer = {
    name: 'cloud',
    extent: 4096,
    features: features as Layer['features'],
    geometryExtensionName: 'geoarrow.point',
  };
  return {
    id: TILE_ID,
    timeRange: { start: 1_700_000_000_000, end: 1_700_000_005_000 },
    layers: [layer],
  };
}

const drawCtx = () => ({
  matrix: new Float32Array(16),
  frame: undefined,
  windowStart: 0,
  windowEnd: 10_000,
  currentTime: baseOpts.currentTime,
  zoom: 4,
});

function makeLayerWithCache(
  extra: Record<string, unknown> = {},
  tile = makeCloudTile(),
) {
  const layer = new STTPointCloudLayer({
    ...baseOpts,
    id: 'pc',
    ...extra,
  }) as any;
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

/** Uniform uploads keyed by NAME (locations are opaque handles). */
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
    gl.uniformMatrix4fv,
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

/** Pair each `bufferData` with the buffer bound before it, by call order. */
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

// ── 1. elevation ────────────────────────────────────────────────────────────

describe('elevation — the reason this kind is not `point`', () => {
  it('projects through the shared elevated-projection emitter, not a hand-rolled multiply', () => {
    const legacy = buildPointCloudVertexSource(LEGACY_SHADER, cfg());
    // Legacy hosts want mercator-z through uMatrix.
    expect(legacy).toContain('uniform mat4 uMatrix;');
    expect(legacy).toContain(
      'vec4 here = uMatrix * vec4(mercator.xy, elevM * uMercatorZPerMeter, 1.0);',
    );
    expect(legacy).toContain('gl_Position = here;');

    // v5 hosts get the full globe/mercator split, every load-bearing step.
    const v5 = buildPointCloudVertexSource(V5_SHADER, cfg());
    expect(v5.startsWith(PRELUDE)).toBe(true);
    expect(v5).not.toContain('uniform mat4 uMatrix;');
    expect(v5).toContain('#ifdef GLOBE');
    for (const step of GLOBE_ELEVATION_STEPS) expect(v5).toContain(step);
    // The mercator branch keeps projectTileFor3D (z preserved deliberately);
    // a 2D `projectTile` would overwrite the elevation with the horizon clip.
    expect(v5).toContain(
      'vec4 here = projectTileFor3D(mercator.xy, elevM * uMercatorZPerMeter);',
    );
    expect(v5).not.toContain('gl_Position = projectTile(');
  });

  it('feeds the globe sphere term METRES and the flat fallback mercator-z', () => {
    const v5 = buildPointCloudVertexSource(V5_SHADER, cfg());
    // Sphere: raw metres over GLOBE_RADIUS. Fallback matrix: converted z.
    expect(v5).toContain(
      'projectToSphere(mercator.xy) * (1.0 + elevM / GLOBE_RADIUS)',
    );
    expect(v5).toContain(
      'u_projection_fallback_matrix *\n        vec4(mercator.xy, elevM * uMercatorZPerMeter, 1.0);',
    );
  });

  it('resolves the elevation column on the CPU: property beats geometry z', () => {
    const tile = makeCloudTile({
      dims: 3,
      numericProps: { agl: new Float32Array([7, 8, 9]) },
    });
    const { gl, cache } = makeLayerWithCache(
      { elevationProperty: 'agl' },
      tile,
    );
    const uploads = uploadsByBuffer(gl);
    expect(
      Array.from(uploads.get(cache.elevationBuffer) as Float32Array),
    ).toEqual([7, 8, 9]);
  });

  it('falls back to the geometry third dimension — the altitude `stt-build` bakes', () => {
    const { gl, cache } = makeLayerWithCache();
    expect(cache.elevationBuffer).toBeTruthy();
    const uploads = uploadsByBuffer(gl);
    expect(
      Array.from(uploads.get(cache.elevationBuffer) as Float32Array),
    ).toEqual([0, 120, 1500]);
  });

  it('a 2D tile bakes NO elevation buffer and the shader reads the constant', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache(
      { elevation: 250 },
      makeCloudTile({ dims: 2 }),
    );
    expect(cache.elevationBuffer).toBeUndefined();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uUseFeatureElevation')).toBe(0);
    expect(lastScalar(u, 'uElevation')).toBe(250);
  });

  it('`useGeometryElevation: false` opts a 3D tile out of the geometry source', () => {
    const { cache } = makeLayerWithCache({ useGeometryElevation: false });
    expect(cache.elevationBuffer).toBeUndefined();
  });

  it('uMercatorZPerMeter is resolved at THIS tile latitude, not the map centre', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    const want = mercatorZFromAltitude(
      1,
      tileCenterLatitude(TILE_ID.z, TILE_ID.y),
    );
    expect(cache.mercatorZScale).toBeCloseTo(want, 12);
    expect(lastScalar(uniformsByName(gl), 'uMercatorZPerMeter')).toBeCloseTo(
      want,
      12,
    );
  });

  it('elevationScale multiplies in metres, before any unit conversion', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      elevationScale: 3,
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(lastScalar(uniformsByName(gl), 'uElevationScale')).toBe(3);
    const src = buildPointCloudVertexSource(LEGACY_SHADER, cfg());
    expect(src).toContain(
      '(uUseFeatureElevation > 0.5 ? aElevation : uElevation) * uElevationScale',
    );
  });
});

// ── 2. lighting ─────────────────────────────────────────────────────────────

describe('lighting — directional + ambient, in the fragment stage', () => {
  it('the fragment stage owns the term and reads a layer-level light uniform', () => {
    const fs = buildPointCloudFragmentSource(cfg());
    expect(fs).toContain('uniform vec3 uLightDirection;');
    expect(fs).toContain('uniform float uAmbient;');
    expect(fs).toContain('uniform float uDiffuse;');
    expect(fs).toContain('float lambert = max(dot(n, -uLightDirection), 0.0);');
    expect(fs).toContain('float light = uAmbient + uDiffuse * lambert;');
  });

  it('uses the per-point normal when the layer declares one', () => {
    const vs = buildPointCloudVertexSource(
      LEGACY_SHADER,
      cfg({ normals: true }),
    );
    expect(vs).toContain('attribute vec3 aNormal;');
    expect(vs).toContain('varying vec3 vNormal;');
    expect(vs).toContain('vNormal = aNormal;');
    const fs = buildPointCloudFragmentSource(cfg({ normals: true }));
    expect(fs).toContain('varying vec3 vNormal;');
    expect(fs).toContain('vec3 n = normalize(vNormal);');
    // The disc mask still reads gl_PointCoord — the IMPOSTER does not run.
    expect(fs).not.toContain('d.x * 2.0, -d.y * 2.0');
  });

  it('falls back to a view-space sphere imposter when no normal column exists', () => {
    const vs = buildPointCloudVertexSource(LEGACY_SHADER, cfg());
    expect(vs).not.toContain('aNormal');
    expect(vs).not.toContain('vNormal');
    const fs = buildPointCloudFragmentSource(cfg());
    // The disc mask leaves `d` and `r2` in scope; the imposter is built from
    // them, with y NEGATED because gl_PointCoord.y grows downward.
    expect(fs).toContain('vec2 d = gl_PointCoord - vec2(0.5);');
    expect(fs).toContain('d.x * 2.0, -d.y * 2.0');
    expect(fs).toContain('sqrt(max(0.0, 1.0 - 4.0 * r2))');
  });

  it('the id pass carries NO lighting — a shaded id is a wrong id', () => {
    for (const src of [
      ...bothVariants(buildPointCloudIdVertexSource, cfg({ normals: true })),
    ]) {
      expect(src).not.toContain('aNormal');
      expect(src).not.toContain('uLightDirection');
    }
  });

  it('defaults match deck PointCloudLayer: ambient 0.35, diffuse 0.6, [-1,-3,-1]', () => {
    expect(DEFAULT_AMBIENT).toBe(0.35);
    expect(DEFAULT_DIFFUSE).toBe(0.6);
    const len = Math.hypot(...DEFAULT_LIGHT_DIRECTION);
    expect(len).toBeCloseTo(1, 12);
    // Direction preserved, only the magnitude normalized away.
    expect(DEFAULT_LIGHT_DIRECTION[1] / DEFAULT_LIGHT_DIRECTION[0]).toBeCloseTo(
      3,
      12,
    );

    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uAmbient')).toBe(0.35);
    expect(lastScalar(u, 'uDiffuse')).toBe(0.6);
    expect(u.get('uLightDirection')?.at(-1)?.[0]).toEqual(
      Array.from(DEFAULT_LIGHT_DIRECTION),
    );
  });

  it('`lit: false` is a UNIFORM flip (ambient 1, diffuse 0), not a program variant', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({ lit: false });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uAmbient')).toBe(1);
    expect(lastScalar(u, 'uDiffuse')).toBe(0);
    // Same compiled key as a lit layer — no second program.
    expect(layer.mainKey).toBe(pointCloudProgramKey('main', cfg()));
  });

  it('setLightDirection normalizes and repaints', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.setLightDirection([0, 0, -4]);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(uniformsByName(gl).get('uLightDirection')?.at(-1)?.[0]).toEqual([
      0, 0, -1,
    ]);
  });

  it('the JS reference matches the GLSL statement order', () => {
    // Light travelling straight down (-z) onto an up-facing normal is full-on.
    expect(pointCloudLightingJS([0, 0, 1], [0, 0, -1], 0.35, 0.6)).toBeCloseTo(
      0.95,
      12,
    );
    // Back-facing clamps to ambient, never negative.
    expect(pointCloudLightingJS([0, 0, -1], [0, 0, -1], 0.35, 0.6)).toBeCloseTo(
      0.35,
      12,
    );
    // Grazing.
    expect(pointCloudLightingJS([1, 0, 0], [0, 0, -1], 0.35, 0.6)).toBeCloseTo(
      0.35,
      12,
    );
  });

  it('the imposter normal is a unit hemisphere and is null outside the disc', () => {
    const centre = pointCloudImposterNormalJS([0.5, 0.5])!;
    // Component-wise: the sprite centre faces straight at the viewer. (`-0`
    // is a legitimate float here, so compare numerically, not structurally.)
    expect(centre[0]).toBeCloseTo(0, 12);
    expect(centre[1]).toBeCloseTo(0, 12);
    expect(centre[2]).toBeCloseTo(1, 12);
    const rim = pointCloudImposterNormalJS([1, 0.5])!;
    expect(Math.hypot(...rim)).toBeCloseTo(1, 12);
    expect(rim[2]).toBeCloseTo(0, 12);
    // Below the sprite centre → normal points DOWN in view space (y negated).
    expect(pointCloudImposterNormalJS([0.5, 0.9])![1]).toBeLessThan(0);
    expect(pointCloudImposterNormalJS([0, 0])).toBeNull();
  });
});

// ── 3. colour ───────────────────────────────────────────────────────────────

describe('colour — four sources, one slot, always multiplied by the light', () => {
  it('the fragment stage multiplies the light into the resolved colour', () => {
    for (const c of [cfg(), cfg({ normals: true })]) {
      const fs = buildPointCloudFragmentSource(c);
      expect(fs).toContain(
        'gl_FragColor = vec4(vColor.rgb * light, vColor.a * vAlpha * edge);',
      );
      // Structural guarantee: exactly one write to gl_FragColor, and the
      // lighting term is computed BEFORE it. There is no post-lighting
      // categorical override to drift into.
      expect(fs.match(/gl_FragColor/g)).toHaveLength(1);
      expect(fs.indexOf('float light =')).toBeLessThan(
        fs.indexOf('gl_FragColor'),
      );
    }
  });

  it('there is exactly ONE colour attribute — categorical cannot bypass shading', () => {
    const vs = buildPointCloudVertexSource(LEGACY_SHADER, cfg());
    expect(vs.match(/attribute vec4 aColor;/g)).toHaveLength(1);
    expect(vs).toContain(
      'vColor = (uUseFeatureColor > 0.5) ? aColor : uColor;',
    );
    expect(vs.match(/vColor =/g)).toHaveLength(1);
  });

  it('(1) an interleaved RGBA vector column wins over everything else', () => {
    const tile = makeCloudTile({
      vectorProps: {
        rgba: {
          value: new Uint8Array([
            10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120,
          ]),
          size: 4,
        },
      },
      numericProps: {
        r: new Float32Array([1, 1, 1]),
        g: new Float32Array([2, 2, 2]),
        b: new Float32Array([3, 3, 3]),
      },
      categoricalProps: {
        rgba: { indices: new Uint16Array([0, 1, 0]), categories: ['a', 'b'] },
      },
    });
    const { gl, cache } = makeLayerWithCache(
      { colorProperty: 'rgba', colorProperties: ['r', 'g', 'b'] as const },
      tile,
    );
    const bytes = uploadsByBuffer(gl).get(cache.colorBuffer) as Uint8Array;
    expect(Array.from(bytes)).toEqual([
      10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120,
    ]);
  });

  it('an RGB (size 3) vector column gets an opaque alpha', () => {
    const tile = makeCloudTile({
      vectorProps: {
        rgb: { value: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), size: 3 },
      },
    });
    const { gl, cache } = makeLayerWithCache({ colorProperty: 'rgb' }, tile);
    const bytes = uploadsByBuffer(gl).get(cache.colorBuffer) as Uint8Array;
    expect(Array.from(bytes)).toEqual([
      1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255,
    ]);
  });

  it('a float32 vector colour leaf is read as 0..1 and scaled to bytes', () => {
    const tile = makeCloudTile({
      vectorProps: {
        rgba: {
          value: new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]),
          size: 4,
        },
      },
    });
    const { gl, cache } = makeLayerWithCache({ colorProperty: 'rgba' }, tile);
    const bytes = uploadsByBuffer(gl).get(cache.colorBuffer) as Uint8Array;
    expect(Array.from(bytes.slice(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(bytes.slice(4, 8))).toEqual([0, 255, 0, 255]);
  });

  it('(2) three numeric 0–255 columns are next, and are ALL-or-nothing', () => {
    const tile = makeCloudTile({
      numericProps: {
        r: new Float32Array([255, 0, 0]),
        g: new Float32Array([0, 255, 0]),
        b: new Float32Array([0, 0, 255]),
      },
    });
    const { gl, cache } = makeLayerWithCache(
      { colorProperties: ['r', 'g', 'b'] as const },
      tile,
    );
    const bytes = uploadsByBuffer(gl).get(cache.colorBuffer) as Uint8Array;
    expect(Array.from(bytes)).toEqual([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
    ]);

    // One missing channel → the source is skipped entirely rather than
    // rendering a silently green-less cloud.
    const partial = makeLayerWithCache(
      { colorProperties: ['r', 'missing', 'b'] as const },
      makeCloudTile({
        numericProps: {
          r: new Float32Array([255, 0, 0]),
          b: new Float32Array([0, 0, 255]),
        },
      }),
    );
    expect(partial.cache.colorBuffer).toBeUndefined();
  });

  it('(3) categorical resolves into the SAME buffer — so it is lit like the rest', () => {
    const tile = makeCloudTile({
      categoricalProps: {
        cls: {
          indices: new Uint16Array([0, 1, 0]),
          categories: ['ground', 'veg'],
        },
      },
    });
    const {
      layer,
      gl,
      tile: t,
      cache,
    } = makeLayerWithCache(
      {
        colorProperty: 'cls',
        colorMapping: { ground: [11, 22, 33, 255], veg: [44, 55, 66, 255] },
      },
      tile,
    );
    const bytes = uploadsByBuffer(gl).get(cache.colorBuffer) as Uint8Array;
    expect(Array.from(bytes.slice(0, 4))).toEqual([11, 22, 33, 255]);
    expect(Array.from(bytes.slice(4, 8))).toEqual([44, 55, 66, 255]);
    // Same attribute, same gate uniform — nothing special about this path.
    layer.drawTile(gl, t, t.layers[0], cache, drawCtx());
    expect(lastScalar(uniformsByName(gl), 'uUseFeatureColor')).toBe(1);
  });

  it('(4) no resolvable source → the constant, and the gate reads 0', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      colorProperty: 'absent',
      color: [255, 128, 0, 255],
    });
    expect(cache.colorBuffer).toBeUndefined();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uUseFeatureColor')).toBe(0);
    const rgba = u.get('uColor')?.at(-1)?.[0] as number[];
    expect(rgba[0]).toBeCloseTo(1, 12);
    expect(rgba[1]).toBeCloseTo(128 / 255, 12);
  });
});

// ── 4. time filtering ───────────────────────────────────────────────────────

describe('time-filter modes', () => {
  it('window is the default and compiles none of the other surface', () => {
    for (const src of [
      ...bothVariants(buildPointCloudVertexSource, cfg()),
      ...bothVariants(buildPointCloudIdVertexSource, cfg()),
    ]) {
      expect(src).toContain(
        'vAlpha = sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut);',
      );
      expect(src).not.toContain('uCurrentTime');
      expect(src).not.toContain('uWakeLength');
      expect(src).not.toContain('uTrailLength');
      expect(src).not.toContain('aFilterValue');
    }
  });

  it('wake tapers the SIZE and does it before gl_PointSize', () => {
    for (const src of [
      ...bothVariants(buildPointCloudVertexSource, cfg({ mode: 'wake' })),
      ...bothVariants(buildPointCloudIdVertexSource, cfg({ mode: 'wake' })),
    ]) {
      expect(src).toContain(
        'vAlpha = sttWakeAlpha(aTime, uCurrentTime, uWakeLength);',
      );
      expect(src).toContain(
        'sizePx *= sttWakeSizeScale(vAlpha, uWakeTailScale);',
      );
      expect(src.indexOf('vAlpha = sttWakeAlpha')).toBeLessThan(
        src.indexOf('sizePx *= sttWakeSizeScale'),
      );
      expect(src.indexOf('sizePx *= sttWakeSizeScale')).toBeLessThan(
        src.indexOf('gl_PointSize = sizePx * 2.0;'),
      );
    }
  });

  it('cumulative and trail compile their own kernels', () => {
    const cum = buildPointCloudVertexSource(
      LEGACY_SHADER,
      cfg({ mode: 'cumulative' }),
    );
    expect(cum).toContain('float sttCumulativeAlpha(');
    expect(cum).toContain(
      'vAlpha = sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn);',
    );
    const trail = buildPointCloudVertexSource(
      LEGACY_SHADER,
      cfg({ mode: 'trail' }),
    );
    expect(trail).toContain('float sttTrailAlpha(');
    // One point is one vertex — its "vertex time" is its own start time.
    expect(trail).toContain(
      'vAlpha = sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail);',
    );
  });

  it('degradation table matches the package rule verbatim', () => {
    expect(resolvePointCloudTimeFilterMode('cumulative', 0, 0)).toBe(
      'cumulative',
    );
    expect(resolvePointCloudTimeFilterMode('wake', 0, 0)).toBe('window');
    expect(resolvePointCloudTimeFilterMode('wake', 5, 0)).toBe('wake');
    expect(resolvePointCloudTimeFilterMode('trail', 0, 0)).toBe('window');
    expect(resolvePointCloudTimeFilterMode('trail', 0, 5)).toBe('trail');
    expect(resolvePointCloudTimeFilterMode('window', 5, 5)).toBe('window');
    expect(resolvePointCloudTimeFilterMode(undefined, 5, 5)).toBe('wake');
    expect(resolvePointCloudTimeFilterMode(undefined, 0, 5)).toBe('trail');
    expect(resolvePointCloudTimeFilterMode(undefined, 0, 0)).toBe('window');
  });

  it('uploads TILE-RELATIVE times for the compiled mode only', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      timeFilterMode: 'wake',
      wakeLength: 2000,
    });
    const ctx = drawCtx();
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uCurrentTime')).toBe(
      ctx.currentTime - cache.timeOffset,
    );
    expect(lastScalar(u, 'uWakeLength')).toBe(2000);
    expect(u.has('uWindowStart')).toBe(false);
  });

  it('flipping the mode relinks under a new key and invalidates tile VAOs', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    const created = gl.createVertexArray.mock.calls.length;
    const deleted = gl.deleteVertexArray.mock.calls.length;

    layer.setTimeFilterMode('cumulative');
    expect(layer.mainKey).toBe(
      pointCloudProgramKey('main', cfg({ mode: 'cumulative' })),
    );
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(gl.deleteVertexArray.mock.calls.length).toBe(deleted + 1);
    expect(gl.createVertexArray.mock.calls.length).toBe(created + 1);

    // A second draw in the same mode reuses the VAO.
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(gl.createVertexArray.mock.calls.length).toBe(created + 1);
  });
});

// ── 5. DataFilter ───────────────────────────────────────────────────────────

describe('DataFilter', () => {
  it('compiles only when filterProperty is set, into BOTH passes', () => {
    for (const src of [
      ...bothVariants(buildPointCloudVertexSource, cfg({ filter: true })),
      ...bothVariants(buildPointCloudIdVertexSource, cfg({ filter: true })),
    ]) {
      expect(src).toContain(DATA_FILTER_CALL_GLSL);
      expect(src).toContain('uFilterRange');
      // Hard filter kills the alpha; the size transform shrinks the sprite.
      expect(src).toContain('vAlpha = 0.0;');
      expect(src).toContain('sizePx *= filterAlpha;');
    }
  });

  it('a tile without the column renders UNFILTERED, never blank', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      filterProperty: 'absent',
      filterRange: [0, 1] as [number, number],
    });
    expect(cache.hasFilterColumn).toBe(false);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(lastScalar(uniformsByName(gl), 'uFilterEnabled')).toBe(0);
    expect(gl.drawCalls.at(-1)).toEqual({ kind: 'arrays', count: 3 });
  });

  it('a tile WITH the column enables the gate and uploads the column', () => {
    const tile = makeCloudTile({
      numericProps: { intensity: new Float32Array([1, 2, 3]) },
    });
    const { layer, gl, cache } = makeLayerWithCache(
      { filterProperty: 'intensity', filterRange: [1, 2] as [number, number] },
      tile,
    );
    expect(cache.hasFilterColumn).toBe(true);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(lastScalar(uniformsByName(gl), 'uFilterEnabled')).toBe(1);
  });
});

// ── 6. sizing ───────────────────────────────────────────────────────────────

describe('metric sizing', () => {
  it("'pixels' (default) folds in only the plain multiplier", () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({ sizeScale: 2 });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(lastScalar(uniformsByName(gl), 'uSizeScale')).toBe(2);
  });

  it("'meters' resolves at the TILE centre latitude and the frame zoom", () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      pointSizeUnits: 'meters',
      sizeScale: 2,
    });
    const ctx = drawCtx();
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    const want =
      2 *
      metersToPixelsAtLatitude(
        1,
        tileCenterLatitude(TILE_ID.z, TILE_ID.y),
        ctx.zoom,
        512 * (layer.resolveDevicePixelRatio?.(gl) ?? 1),
      );
    expect(lastScalar(uniformsByName(gl), 'uSizeScale') as number).toBeCloseTo(
      want,
      9,
    );
  });

  it('a numeric size column drives per-point size and flips the gate', () => {
    const tile = makeCloudTile({
      numericProps: { diameter: new Float32Array([1, 2, 3]) },
    });
    const { layer, gl, cache } = makeLayerWithCache(
      { sizeProperty: 'diameter' },
      tile,
    );
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(lastScalar(uniformsByName(gl), 'uUseFeatureSize')).toBe(1);
  });
});

// ── 7. picking + rendering mode ─────────────────────────────────────────────

describe('id-FBO picking', () => {
  it('the id pass reproduces EXACTLY the visual pass alpha gates', () => {
    const c = cfg({ mode: 'wake', filter: true });
    const visual = buildPointCloudVertexSource(V5_SHADER, c);
    const id = buildPointCloudIdVertexSource(V5_SHADER, c);
    for (const gate of [
      'vAlpha = sttWakeAlpha(aTime, uCurrentTime, uWakeLength);',
      'sizePx *= sttWakeSizeScale(vAlpha, uWakeTailScale);',
      DATA_FILTER_CALL_GLSL,
      'sizePx *= filterAlpha;',
      'gl_PointSize = sizePx * 2.0;',
    ]) {
      expect(visual).toContain(gate);
      expect(id).toContain(gate);
    }
    // …and the identical elevated projection, from the same emitter.
    for (const step of GLOBE_ELEVATION_STEPS) {
      expect(visual).toContain(step);
      expect(id).toContain(step);
    }
  });

  it('drawPickTile draws every point, then frees the id buffer and unbinds', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      filterProperty: 'absent',
    });
    layer.drawPickTile(gl, tile, tile.layers[0], cache, drawCtx(), 1);
    expect(gl.drawCalls.at(-1)).toEqual({ kind: 'arrays', count: 3 });
    expect(gl.deleteBuffer).toHaveBeenCalled();
    // The default-VAO slate is left clean for the next visual frame.
    expect(
      gl.disableVertexAttribArray.mock.calls.length,
    ).toBeGreaterThanOrEqual(3);
    // Picking uses raw binds, never a cached VAO.
    expect(cache.vao == null || cache.vaoVariant === undefined).toBe(true);
  });

  it('the pick pass sets the same elevation uniforms as the visual pass', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawPickTile(gl, tile, tile.layers[0], cache, drawCtx(), 1);
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uUseFeatureElevation')).toBe(1);
    expect(lastScalar(u, 'uMercatorZPerMeter')).toBeCloseTo(
      cache.mercatorZScale,
      12,
    );
  });
});

describe('rendering mode', () => {
  it("is '3d' by default so the cloud depth-resolves", () => {
    const layer = new STTPointCloudLayer({ ...baseOpts, id: 'pc' });
    expect(layer.renderingMode).toBe('3d');
  });

  it('an explicit undefined still lands on the default (`??`, not a spread)', () => {
    const layer = new STTPointCloudLayer({
      ...baseOpts,
      id: 'pc',
      renderingMode: undefined,
    });
    expect(layer.renderingMode).toBe('3d');
  });

  it("'3d' leaves the host's depth mode alone; '2d' disables DEPTH_TEST", () => {
    const gl = makeMockGl();
    const solid = new STTPointCloudLayer({ ...baseOpts, id: 'a' }) as any;
    solid.applySharedGlState(gl);
    expect(gl.disable).not.toHaveBeenCalledWith(gl.DEPTH_TEST);
    expect(gl.enable).toHaveBeenCalledWith(gl.BLEND);

    const gl2 = makeMockGl();
    const flat = new STTPointCloudLayer({
      ...baseOpts,
      id: 'b',
      renderingMode: '2d',
    }) as any;
    flat.applySharedGlState(gl2);
    expect(gl2.disable).toHaveBeenCalledWith(gl2.DEPTH_TEST);
  });

  it('is pickable — drawPickTile exists (the pickability declaration)', () => {
    const layer = new STTPointCloudLayer({ ...baseOpts, id: 'pc' }) as any;
    expect(typeof layer.drawPickTile).toBe('function');
  });

  it('accepts POINT geometry only', () => {
    const layer = new STTPointCloudLayer({ ...baseOpts, id: 'pc' }) as any;
    expect(layer.acceptsGeometry(GeometryType.Point)).toBe(true);
    expect(layer.acceptsGeometry(GeometryType.LineString)).toBe(false);
    expect(layer.acceptsGeometry(GeometryType.Polygon)).toBe(false);
  });
});

// ── 8. program cache ────────────────────────────────────────────────────────

describe('program-cache key carries every structural axis', () => {
  it('pass, mode, filter and normals all move the key', () => {
    const seen = new Set<string>();
    for (const pass of ['main', 'pick'] as const) {
      for (const mode of ['window', 'wake', 'cumulative', 'trail'] as const) {
        for (const filter of [false, true]) {
          for (const normals of [false, true]) {
            seen.add(pointCloudProgramKey(pass, { mode, filter, normals }));
          }
        }
      }
    }
    expect(seen.size).toBe(2 * 4 * 2 * 2);
  });

  it('the constructor derives filter/normals from the property names alone', () => {
    const plain = new STTPointCloudLayer({ ...baseOpts, id: 'a' }) as any;
    expect(plain.shaderConfig).toEqual(cfg());
    const rich = new STTPointCloudLayer({
      ...baseOpts,
      id: 'b',
      filterProperty: 'intensity',
      normalProperty: 'n',
    }) as any;
    expect(rich.shaderConfig).toEqual(cfg({ filter: true, normals: true }));
    expect(rich.mainKey).toBe(
      pointCloudProgramKey('main', cfg({ filter: true, normals: true })),
    );
  });
});

// ── 9. defaults are the documented shape ────────────────────────────────────

describe('defaults', () => {
  it('every option defaults via `??`, so 0 / false survive', () => {
    const layer = new STTPointCloudLayer({
      ...baseOpts,
      id: 'pc',
      pointSize: 0,
      elevationScale: 0,
      sizeScale: 0,
      ambientIntensity: 0,
      lit: false,
      fadeTrail: false,
    }) as any;
    expect(layer.cloudOpts.pointSize).toBe(0);
    expect(layer.cloudOpts.elevationScale).toBe(0);
    expect(layer.cloudOpts.sizeScale).toBe(0);
    expect(layer.cloudOpts.ambientIntensity).toBe(0);
    expect(layer.cloudOpts.lit).toBe(false);
    expect(layer.cloudOpts.fadeTrail).toBe(0);
  });

  it('unset options land on the documented deck-parity values', () => {
    const layer = new STTPointCloudLayer({ ...baseOpts, id: 'pc' }) as any;
    expect(layer.cloudOpts.pointSize).toBe(10);
    expect(layer.cloudOpts.pointSizeUnits).toBe('pixels');
    expect(layer.cloudOpts.elevation).toBe(0);
    expect(layer.cloudOpts.elevationScale).toBe(1);
    expect(layer.cloudOpts.useGeometryElevation).toBe(true);
    expect(layer.cloudOpts.lit).toBe(true);
    expect(layer.cloudOpts.wakeLength).toBe(0);
    expect(layer.cloudOpts.trailLength).toBe(0);
    expect(layer.cloudOpts.fadeTrail).toBe(1);
  });

  it('a normal column is only bound when the layer compiled for it', () => {
    const tile = makeCloudTile({
      vectorProps: {
        n: {
          value: new Float32Array([0, 0, 1, 0, 1, 0, 1, 0, 0]),
          size: 3,
        },
      },
    });
    const without = makeLayerWithCache({}, tile);
    expect(without.cache.normalBuffer).toBeUndefined();

    const withNormals = makeLayerWithCache({ normalProperty: 'n' }, tile);
    expect(withNormals.cache.normalBuffer).toBeTruthy();
    const bytes = uploadsByBuffer(withNormals.gl).get(
      withNormals.cache.normalBuffer,
    ) as Float32Array;
    expect(Array.from(bytes)).toEqual([0, 0, 1, 0, 1, 0, 1, 0, 0]);
  });

  it('every extra buffer is registered for deletion (no leak)', () => {
    const tile = makeCloudTile({
      numericProps: {
        intensity: new Float32Array([1, 2, 3]),
        diameter: new Float32Array([1, 2, 3]),
      },
      vectorProps: {
        n: { value: new Float32Array(9), size: 3 },
        rgba: { value: new Uint8Array(12), size: 4 },
      },
    });
    const { cache } = makeLayerWithCache(
      {
        colorProperty: 'rgba',
        normalProperty: 'n',
        sizeProperty: 'diameter',
        filterProperty: 'intensity',
      },
      tile,
    );
    for (const buf of [
      cache.colorBuffer,
      cache.elevationBuffer,
      cache.normalBuffer,
      cache.sizeBuffer,
      cache.filterBuffer,
    ]) {
      expect(buf).toBeTruthy();
      expect(cache.extraBuffers).toContain(buf);
    }
  });
});

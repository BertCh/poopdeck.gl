/**
 * Arc layer (maplibre parity campaign Wave M3) — real 3D OD arcs replacing the
 * descriptor's `arc → line` fallback.
 *
 * String-level: the vertex-source builder emits the legacy `uMatrix` shader for
 * an empty prelude and a prelude-injected `projectTileFor3D` shader (with the
 * metres-vs-mercator-z globe split) for v5+ hosts; exactly ONE time kernel per
 * program; the DataFilter and great-circle branches compile only when asked —
 * in BOTH projection variants and in the id-pick pass, which shares the builder
 * so the hit ribbon cannot drift from the drawn one.
 *
 * CPU-level: the tessellation, height, tilt, great-circle and antimeridian math
 * all have JS references beside the GLSL, tested here against closed forms.
 *
 * Behaviour-level (mock-gl): drawTile links one program per host variant, sets
 * the prelude projection uniforms on v5 frames, re-records VAOs when the
 * program OR the segment count moves, raises the segment count on globe frames
 * so arc pieces stay inside the host's subdivision granularity, and the pick
 * pass applies the identical time/filter gates.
 */

import { describe, it, expect, vi } from 'vitest';
import { GeometryType, type Tile, type Layer } from '@poopdeck.gl/core';
import {
  STTArcLayer,
  buildArcVertexSource,
  arcProgramKey,
  arcHeightMeters,
  arcVertexTime,
  arcStripVertexCount,
  buildArcStripVertices,
  greatCircleMeters,
  resolveArcTimeFilterMode,
  sampleArcMercator,
  unwrapMercatorX,
  MAX_ARC_SEGMENTS,
  MAX_MERCATOR_SIN,
  type ArcShaderConfig,
} from '../src/layers/arc-layer';
import { normalizeRenderArgs } from '../src/lib/host-adapter';
import { granularityForZoom } from '../src/lib/globe';
import {
  EARTH_RADIUS_M,
  lngLatToMercator,
  mercatorZFromAltitude,
  metersToPixelsAtLatitude,
  tileCenterLatitude,
} from '../src/lib/projection';
import { DATA_FILTER_CALL_GLSL } from '../src/shaders/data-filter.glsl';
import { makeMockGl } from './mock-gl';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

const PRELUDE_MARKER = '// __HOST_PRELUDE__';
const PRELUDE =
  `${PRELUDE_MARKER}\n` +
  'uniform mat4 u_projection_matrix;\n' +
  'vec4 projectTile(vec2 p) { return u_projection_matrix * vec4(p, 0.0, 1.0); }\n' +
  'vec4 projectTileFor3D(vec2 p, float e) { return u_projection_matrix * vec4(p, e, 1.0); }';
const LEGACY_SHADER = { prelude: '', define: '' };
const V5_SHADER = { prelude: PRELUDE, define: '#define GLOBE' };

const cfg = (over: Partial<ArcShaderConfig> = {}): ArcShaderConfig => ({
  mode: 'window',
  filter: false,
  greatCircle: false,
  pick: false,
  ...over,
});

/** Both host variants of one configuration, for "identical in both" assertions. */
const bothVariants = (c: ArcShaderConfig): [string, string] => [
  buildArcVertexSource(LEGACY_SHADER, c),
  buildArcVertexSource(V5_SHADER, c),
];

/** Both variants of the visual AND the id pass. */
const allFour = (c: ArcShaderConfig): string[] => [
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

const drawCtx = (frame?: ReturnType<typeof normalizeRenderArgs>) => ({
  matrix: frame ? frame.matrix : new Float32Array(16),
  frame,
  windowStart: 0,
  windowEnd: 10_000,
  currentTime: baseOpts.currentTime,
  zoom: 2,
});

const legacyFrame = () => normalizeRenderArgs(new Float32Array(16).fill(2));

/**
 * Three OD flows as LineString features — the shape STT bakes OD data in:
 *   f0 SF → NYC (plain), f1 Tokyo → LA (crosses the antimeridian),
 *   f2 Paris → Zurich → Berlin (3 vertices: the middle one must be DROPPED by
 *   the source/target endpoint reduction).
 */
function makeArcTile(): Tile {
  const positions = new Float64Array([
    -122.4, 37.7, -73.95, 40.75, 139.7, 35.7, -118.24, 34.05, 2.35, 48.85, 8.54,
    47.37, 13.4, 52.5,
  ]);
  const startIndices = new Uint32Array([0, 2, 4, 7]);
  const features = {
    featureCount: 3,
    geometryType: GeometryType.LineString,
    positionDimensions: 2 as const,
    positions,
    startIndices,
    featureIds: new Uint32Array([0, 1, 2]),
    startTimes: new Float32Array([0, 1000, 2000]),
    endTimes: new Float32Array([3000, 4000, 5000]),
    timeOffset: 1_700_000_000_000,
    numericProps: {
      volume: new Float32Array([10, 40, 25]),
      strokeWidth: new Float32Array([1, 2, 3]),
    },
    categoricalProps: {
      mode: {
        indices: new Uint16Array([0, 1, 0]),
        categories: ['air', 'sea'],
      },
    },
  };
  const layer: Layer = {
    name: 'flows',
    extent: 4096,
    features,
    geometryExtensionName: 'geoarrow.linestring',
  };
  return {
    id: { z: 2, x: 1, y: 1, t: 1_700_000_000_000 },
    timeRange: { start: 1_700_000_000_000, end: 1_700_000_005_000 },
    layers: [layer],
  };
}

/** OD tile with NO range-filterable columns at all. */
function makeBareArcTile(): Tile {
  const tile = makeArcTile();
  tile.layers[0].features.numericProps = {};
  return tile;
}

function makeLayer(extra: Record<string, unknown> = {}, tile = makeArcTile()) {
  const layer = new STTArcLayer({
    ...baseOpts,
    id: 'a',
    ...extra,
  } as any) as any;
  layer.supports32BitIndices = true;
  const gl = makeMockGl();
  // onAdd (which probes these) is bypassed by these direct-hook tests, so wire
  // the mock's entry points: instancing and VAO reuse are then really exercised.
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
  const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
  return { layer, gl, tile, cache };
}

/** All vertex-shader sources handed to the mock GL so far. */
const vertexSources = (gl: any): string[] =>
  gl.shaderSource.mock.calls.map((c: unknown[]) => c[1] as string);

const idVertexSource = (gl: any): string =>
  vertexSources(gl).find((s) => s.includes('attribute vec3 aIdColor;'))!;

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

const lastScalar = (u: Map<string, unknown[][]>, name: string): unknown =>
  u.get(name)?.at(-1)?.[0];

/** The vec2 payloads uploaded to `name`, as plain number pairs. */
function vec2Args(gl: any, name: string): number[][] {
  const handles = new Set(
    gl.getUniformLocation.mock.calls
      .map((c: unknown[], i: number) =>
        c[1] === name ? gl.getUniformLocation.mock.results[i].value : undefined,
      )
      .filter(Boolean),
  );
  return gl.vec2Uploads
    .filter((up: { location: unknown }) => handles.has(up.location))
    .map((up: { value: number[] }) => up.value);
}

// ── shader assembly ─────────────────────────────────────────────────────────

describe('arc vertex-source builder', () => {
  it('legacy variant (empty prelude) keeps the uMatrix path', () => {
    const src = buildArcVertexSource(LEGACY_SHADER);
    expect(src).toContain('uniform mat4 uMatrix;');
    // The shared elevated-projection kernel declares the clip position and
    // the arc's projection function returns it.
    expect(src).toContain(
      'vec4 result = uMatrix * vec4(posM, elevM * uMercatorZPerMeter, 1.0);',
    );
    expect(src).toContain('return result;');
    expect(src).not.toContain('projectTile(');
    expect(src).not.toContain('projectTileFor3D(');
    expect(src).not.toContain('#ifdef GLOBE');
  });

  it('v5 variant prepends prelude then define and projects in 3D', () => {
    const src = buildArcVertexSource(V5_SHADER);
    expect(src.startsWith(PRELUDE)).toBe(true);
    const defineAt = src.indexOf('#define GLOBE');
    expect(defineAt).toBeGreaterThan(PRELUDE_MARKER.length);
    expect(defineAt).toBeLessThan(src.indexOf('attribute vec2 aVertex'));
    // An arc leaves the ground, so the 3D entry point — never the flat one.
    expect(src).toContain(
      'vec4 result = projectTileFor3D(posM, elevM * uMercatorZPerMeter);',
    );
    expect(src).toContain('return result;');
    expect(src).not.toContain('uniform mat4 uMatrix;');
  });

  it('the GLOBE branch feeds METRES to the sphere and mercator-z to the fallback', () => {
    const src = buildArcVertexSource(V5_SHADER);
    // The one place in the M2 projection kernel where the unit changes: the
    // globe prelude scales the sphere radius by elevation/GLOBE_RADIUS (metres),
    // while its transition fallback matrix still wants mercator-z.
    expect(src).toContain(
      'vec3 elevated = projectToSphere(posM) * (1.0 + elevM / GLOBE_RADIUS);',
    );
    expect(src).toContain('vec4(posM, elevM * uMercatorZPerMeter, 1.0);');
    // Horizon clipping must be re-derived: projectTileFor3D preserves z on globe.
    expect(src).toContain('globeComputeClippingZ(elevated)');
    // The plain 3D call is the `#else` arm, i.e. AFTER the globe block.
    expect(src.indexOf('#ifdef GLOBE')).toBeLessThan(
      src.indexOf('vec4 result = projectTileFor3D(posM,'),
    );
    expect(src.indexOf('#else')).toBeLessThan(
      src.indexOf('vec4 result = projectTileFor3D(posM,'),
    );
  });

  it('the arc height is deck’s paraboloid over the great-circle distance', () => {
    for (const src of allFour(cfg())) {
      expect(src).toContain(
        'return sqrt(max(t * (1.0 - t), 0.0)) * aDistance * uArcHeight;',
      );
      // Distance is a per-instance attribute — no trigonometry per vertex.
      expect(src).toContain('attribute float aDistance;');
    }
  });

  it('tilt splits the height and offsets along the right-hand ground normal', () => {
    const src = buildArcVertexSource(LEGACY_SHADER);
    expect(src).toContain('float elevM = h * uTiltCos;');
    expect(src).toContain(
      'vec2(-axis.y, axis.x) * (h * uTiltSin * uMercatorZPerMeter / axisLen)',
    );
    // Zero-length OD pairs must not produce a NaN normal.
    expect(src).toContain('float axisLen = max(length(axis), 1e-12);');
  });

  it('extrudes in screen space and flips the side sign at the last sample', () => {
    const src = buildArcVertexSource(LEGACY_SHADER);
    expect(src).toContain('float atEnd = step(lastIndex - 0.5, i);');
    expect(src).toContain('float sideSign = mix(1.0, -1.0, atEnd);');
    expect(src).toContain('vec2 perp = vec2(-dirN.y, dirN.x) * sideSign;');
    expect(src).toContain('vec2 offsetPx = perp * aVertex.y * widthPx * 0.5;');
  });

  it('interpolates the constant gradient along the arc; id pass carries ids', () => {
    const visual = buildArcVertexSource(LEGACY_SHADER);
    expect(visual).toContain(
      'vColor = (uUseFeatureColor > 0.5) ? aColor : mix(uSourceColor, uTargetColor, t);',
    );
    const id = buildArcVertexSource(LEGACY_SHADER, cfg({ pick: true }));
    expect(id).toContain('attribute vec3 aIdColor;');
    expect(id).toContain('vIdColor = aIdColor;');
    // The id pass paints no colour…
    expect(id).not.toContain('varying vec4 vColor;');
    // …but carries the SAME colour expression to gate on its ALPHA, so the
    // transparent half of a `sourceColor: [.., 0]` gradient — invisible on
    // screen — is not a hit target (deck's picking_filterPickingColor rule).
    expect(id).toContain('attribute vec4 aColor;');
    expect(id).toContain(
      'vAlpha *= ((uUseFeatureColor > 0.5) ? aColor : mix(uSourceColor, uTargetColor, t)).a;',
    );
  });

  it('the default config compiles NONE of the optional surface', () => {
    for (const src of allFour(cfg())) {
      expect(src).toContain('sttTimeWindowAlpha(aTime,');
      expect(src).not.toContain('uCurrentTime');
      expect(src).not.toContain('uWakeLength');
      expect(src).not.toContain('uTrailLength');
      expect(src).not.toContain('aFilterValue');
      expect(src).not.toContain('uFilterRange');
      expect(src).not.toContain('aLngLat');
      expect(src).not.toContain('sttSlerp');
      // Plain mercator chord.
      expect(src).toContain('vec2 ground = mix(aSource, aTarget, t);');
    }
  });
});

describe('time-filter mode compilation', () => {
  it('wake compiles the wake kernel and narrows AFTER the pixel clamp', () => {
    for (const src of allFour(cfg({ mode: 'wake' }))) {
      expect(src).toContain('float sttWakeAlpha(');
      expect(src).toContain(
        'float timeAlpha = sttWakeAlpha(aTime, uCurrentTime, uWakeLength);',
      );
      expect(src).toContain(
        'widthPx *= sttWakeSizeScale(timeAlpha, uWakeTailScale);',
      );
      // deck order: getWidth → clamp to min/max pixels → DECKGL_FILTER_SIZE.
      expect(src.indexOf('widthPx = clamp(widthPx,')).toBeLessThan(
        src.indexOf('widthPx *= sttWakeSizeScale'),
      );
      expect(src.indexOf('widthPx *= sttWakeSizeScale')).toBeLessThan(
        src.indexOf('vec2 offsetPx ='),
      );
      expect(src).not.toContain('uWindowStart');
      expect(src).not.toContain('sttTimeWindowAlpha');
    }
  });

  it('cumulative compiles the cumulative kernel and reuses uFadeIn', () => {
    for (const src of bothVariants(cfg({ mode: 'cumulative' }))) {
      expect(src).toContain('float sttCumulativeAlpha(');
      expect(src).toContain(
        'float timeAlpha = sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn);',
      );
      expect(src).toContain('uniform float uFadeIn;');
      expect(src).not.toContain('uFadeOut');
      expect(src).not.toContain('sttWakeSizeScale');
    }
  });

  it('trail reveals PER VERTEX: the frontier walks source → target', () => {
    for (const src of allFour(cfg({ mode: 'trail' }))) {
      expect(src).toContain('float sttTrailAlpha(');
      // The per-vertex frontier time is the feature's [start,end] at this t —
      // an arc draws itself along its length instead of blinking on whole.
      expect(src).toContain(
        'float timeAlpha = sttTrailAlpha(mix(aTime.x, aTime.y, t), uCurrentTime, uTrailLength, uFadeTrail);',
      );
      // `t` must be established before the alpha reads it.
      expect(src.indexOf('float t = i * invSegments;')).toBeLessThan(
        src.indexOf('float timeAlpha = sttTrailAlpha'),
      );
    }
  });

  it('every mode keeps the projection of its host variant', () => {
    for (const mode of ['window', 'wake', 'cumulative', 'trail'] as const) {
      const [legacy, v5] = bothVariants(cfg({ mode }));
      expect(legacy).toContain('uMatrix * vec4(posM,');
      expect(legacy).not.toContain('projectTileFor3D(');
      expect(v5).toContain('projectTileFor3D(posM,');
      expect(v5).not.toContain('uniform mat4 uMatrix;');
    }
  });
});

describe('great-circle compilation', () => {
  const gc = cfg({ greatCircle: true });

  it('splices the spherical path into both variants and both passes', () => {
    for (const src of allFour(gc)) {
      expect(src).toContain('attribute vec4 aLngLat;');
      expect(src).toContain('vec3 sttSlerp(vec3 a, vec3 b, float t)');
      expect(src).toContain('vec2 sttUnitToMercator(vec3 v)');
      expect(src).toContain(
        'vec3 p = sttSlerp(sttLngLatToUnit(aLngLat.xy), sttLngLatToUnit(aLngLat.zw), t);',
      );
      // Antimeridian: keep the path within half a world of the source.
      expect(src).toContain('ground.x -= floor(ground.x - aSource.x + 0.5);');
      expect(src).not.toContain('vec2 ground = mix(aSource, aTarget, t);');
    }
  });

  it('pins the mercator cutoff constant to the CPU one', () => {
    const src = buildArcVertexSource(LEGACY_SHADER, gc);
    expect(src).toContain(
      `const float STT_MAX_MERCATOR_SIN = ${MAX_MERCATOR_SIN};`,
    );
  });

  it('the tilt axis still uses the CHORD endpoints, not the swept path', () => {
    // The lateral direction must be constant along the arc, or the ribbon
    // would corkscrew; it is the source→target chord normal in both modes.
    const src = buildArcVertexSource(LEGACY_SHADER, gc);
    expect(src).toContain('vec2 axis = aTarget - aSource;');
  });
});

describe('DataFilter compilation', () => {
  const filtered = cfg({ filter: true });

  it('splices the attribute, uniforms and kernel into both variants and passes', () => {
    for (const src of allFour(filtered)) {
      expect(src).toContain('attribute float aFilterValue;');
      expect(src).toContain('uniform vec2 uFilterRange;');
      expect(src).toContain('uniform vec2 uFilterSoftRange;');
      expect(src).toContain('uniform float uFilterEnabled;');
      expect(src).toContain('float sttDataFilterAlpha(');
      // The canonical call verbatim, so the layers cannot drift.
      expect(src).toContain(`float filterAlpha = ${DATA_FILTER_CALL_GLSL};`);
    }
  });

  it('collapses on the FILTER factor only (trail’s per-vertex alpha must not)', () => {
    const src = buildArcVertexSource(LEGACY_SHADER, {
      ...filtered,
      mode: 'trail',
    });
    expect(src).toContain('if (filterAlpha <= 0.0) gl_Position = vec4(0.0);');
    // A per-vertex time alpha collapsing vertices would strand the revealed end
    // of the ribbon at the origin — only the per-FEATURE filter may collapse.
    expect(src).not.toContain('if (timeAlpha <= 0.0) gl_Position');
    expect(src).toContain('vAlpha = timeAlpha * filterMask;');
  });

  it('honours filterTransformSize on the width and composes multiplicatively', () => {
    const src = buildArcVertexSource(LEGACY_SHADER, filtered);
    expect(src).toContain(
      'if (uFilterTransformSize > 0.5) widthPx *= filterAlpha;',
    );
    expect(src).toContain('float filterMask = (uFilterTransformColor > 0.5)');
    expect(src.indexOf('float filterAlpha =')).toBeLessThan(
      src.indexOf('widthPx *= filterAlpha'),
    );
  });
});

describe('program keys', () => {
  it('separate every compiled configuration', () => {
    const keys = new Set([
      arcProgramKey(cfg()),
      arcProgramKey(cfg({ mode: 'wake' })),
      arcProgramKey(cfg({ mode: 'cumulative' })),
      arcProgramKey(cfg({ mode: 'trail' })),
      arcProgramKey(cfg({ filter: true })),
      arcProgramKey(cfg({ greatCircle: true })),
      arcProgramKey(cfg({ pick: true })),
    ]);
    expect(keys.size).toBe(7);
    expect(arcProgramKey(cfg())).toBe('arc:window');
    expect(
      arcProgramKey(
        cfg({ mode: 'wake', filter: true, greatCircle: true, pick: true }),
      ),
    ).toBe('arc:pick:wake:filter:gc');
  });
});

// ── CPU arc math (the JS references the GLSL mirrors) ───────────────────────

describe('great-circle distance', () => {
  it('is zero for coincident points and symmetric', () => {
    expect(greatCircleMeters(10, 20, 10, 20)).toBe(0);
    expect(greatCircleMeters(-122.4, 37.7, -73.95, 40.75)).toBeCloseTo(
      greatCircleMeters(-73.95, 40.75, -122.4, 37.7),
      6,
    );
  });

  it('matches the closed form on the equator and on a meridian', () => {
    // A quarter of the way round the equator.
    expect(greatCircleMeters(0, 0, 90, 0)).toBeCloseTo(
      (Math.PI / 2) * EARTH_RADIUS_M,
      3,
    );
    // 1° of latitude.
    expect(greatCircleMeters(0, 0, 0, 1)).toBeCloseTo(
      (Math.PI / 180) * EARTH_RADIUS_M,
      3,
    );
  });

  it('survives antipodal endpoints (the sqrt must not exceed 1)', () => {
    expect(greatCircleMeters(0, 0, 180, 0)).toBeCloseTo(
      Math.PI * EARTH_RADIUS_M,
      3,
    );
    expect(Number.isNaN(greatCircleMeters(0, 90, 0, -90))).toBe(false);
  });

  it('is a REAL ground distance, not a mercator one (latitude-invariant)', () => {
    // Same 10° of longitude at 60°N covers half the ground distance it does at
    // the equator — a mercator delta would report them identical.
    const equator = greatCircleMeters(0, 0, 10, 0);
    const sixty = greatCircleMeters(0, 60, 10, 60);
    expect(sixty / equator).toBeCloseTo(Math.cos((60 * Math.PI) / 180), 3);
  });
});

describe('antimeridian unwrap', () => {
  it('takes the short way round', () => {
    // Tokyo (x≈0.888) → Los Angeles (x≈0.172): the unwrapped target is 1.172,
    // so the arc runs 0.28 of a world east, not 0.72 of a world west.
    const [sx] = lngLatToMercator(139.7, 35.7);
    const [tx] = lngLatToMercator(-118.24, 34.05);
    const unwrapped = unwrapMercatorX(sx, tx);
    expect(unwrapped).toBeCloseTo(tx + 1, 12);
    expect(Math.abs(unwrapped - sx)).toBeLessThan(0.5);
  });

  it('is the identity when the pair is already close', () => {
    expect(unwrapMercatorX(0.3, 0.4)).toBeCloseTo(0.4, 12);
    expect(unwrapMercatorX(0.4, 0.3)).toBeCloseTo(0.3, 12);
  });

  it('always lands within half a world of the reference', () => {
    for (const ref of [0, 0.25, 0.5, 0.99]) {
      for (const x of [0, 0.1, 0.5, 0.9, 1]) {
        expect(Math.abs(unwrapMercatorX(ref, x) - ref)).toBeLessThanOrEqual(
          0.5,
        );
      }
    }
  });
});

describe('arc height', () => {
  it('is zero at both endpoints and peaks at the midpoint', () => {
    expect(arcHeightMeters(0, 1000, 1)).toBe(0);
    expect(arcHeightMeters(1, 1000, 1)).toBe(0);
    // deck's paraboloid: apex = arcHeight * distance / 2.
    expect(arcHeightMeters(0.5, 1000, 1)).toBeCloseTo(500, 9);
    expect(arcHeightMeters(0.5, 1000, 0.6)).toBeCloseTo(300, 9);
  });

  it('is symmetric about the midpoint and monotone on each half', () => {
    for (const t of [0.1, 0.25, 0.4]) {
      expect(arcHeightMeters(t, 1000, 1)).toBeCloseTo(
        arcHeightMeters(1 - t, 1000, 1),
        9,
      );
    }
    let prev = -1;
    for (let i = 0; i <= 50; i++) {
      const h = arcHeightMeters(i / 100, 1000, 1);
      expect(h).toBeGreaterThanOrEqual(prev);
      prev = h;
    }
  });

  it('flattens at arcHeight 0 and never returns NaN outside [0,1]', () => {
    expect(arcHeightMeters(0.5, 1000, 0)).toBe(0);
    expect(arcHeightMeters(-0.2, 1000, 1)).toBe(0);
    expect(arcHeightMeters(1.2, 1000, 1)).toBe(0);
  });
});

describe('trail reveal frontier', () => {
  it('walks the feature’s [start, end] across the arc parameter', () => {
    expect(arcVertexTime(1000, 5000, 0)).toBe(1000);
    expect(arcVertexTime(1000, 5000, 1)).toBe(5000);
    expect(arcVertexTime(1000, 5000, 0.25)).toBe(2000);
  });
});

describe('strip tessellation', () => {
  it('emits 2 * (segments + 1) vertices with alternating sides', () => {
    const strip = buildArcStripVertices(3);
    expect(strip.length).toBe(2 * (3 + 1) * 2);
    expect(arcStripVertexCount(3)).toBe(8);
    expect(Array.from(strip)).toEqual([
      0, -1, 0, 1, 1, -1, 1, 1, 2, -1, 2, 1, 3, -1, 3, 1,
    ]);
  });

  it('indices run 0..segments once per side, in order', () => {
    const n = 12;
    const strip = buildArcStripVertices(n);
    for (let i = 0; i <= n; i++) {
      expect(strip[i * 4]).toBe(i);
      expect(strip[i * 4 + 1]).toBe(-1);
      expect(strip[i * 4 + 2]).toBe(i);
      expect(strip[i * 4 + 3]).toBe(1);
    }
  });

  it('degenerate segment counts still produce a drawable strip', () => {
    expect(arcStripVertexCount(0)).toBe(4);
    expect(buildArcStripVertices(0).length).toBe(8);
  });
});

describe('arc sampling (JS reference for the compiled tessellation)', () => {
  const mzpm = mercatorZFromAltitude(1, 0);
  const src: [number, number] = [0.4, 0.5];
  const tgt: [number, number] = [0.6, 0.5];
  const flat = { arcHeight: 1, tiltDegrees: 0, mercatorZPerMeter: mzpm };

  it('hits the endpoints exactly and interpolates the chord in between', () => {
    const a = sampleArcMercator(src, tgt, 1000, 0, flat);
    expect(a.x).toBeCloseTo(0.4, 12);
    expect(a.y).toBeCloseTo(0.5, 12);
    expect(a.elevationMeters).toBe(0);
    const b = sampleArcMercator(src, tgt, 1000, 1, flat);
    expect(b.x).toBeCloseTo(0.6, 12);
    expect(b.elevationMeters).toBe(0);
    const m = sampleArcMercator(src, tgt, 1000, 0.5, flat);
    expect(m.x).toBeCloseTo(0.5, 12);
    expect(m.elevationMeters).toBeCloseTo(500, 9);
  });

  it('tilt moves height into a lateral offset without changing the total', () => {
    const h = arcHeightMeters(0.5, 1000, 1);
    const upright = sampleArcMercator(src, tgt, 1000, 0.5, flat);
    const tilted = sampleArcMercator(src, tgt, 1000, 0.5, {
      ...flat,
      tiltDegrees: 45,
    });
    expect(tilted.elevationMeters).toBeCloseTo(h * Math.SQRT1_2, 9);
    // Lateral offset in METRES, recovered through the same conformal factor.
    const lateralMeters =
      Math.hypot(tilted.x - upright.x, tilted.y - upright.y) / mzpm;
    expect(lateralMeters).toBeCloseTo(h * Math.SQRT1_2, 6);
  });

  it('tilts to the RIGHT of the direction of travel seen north-up', () => {
    // Travelling east: the right-hand side is south, and mercator y grows
    // southward, so a positive tilt increases y.
    const flatArc = sampleArcMercator(src, tgt, 1000, 0.5, {
      ...flat,
      tiltDegrees: 90,
    });
    expect(flatArc.elevationMeters).toBeCloseTo(0, 9);
    expect(flatArc.y).toBeGreaterThan(0.5);
    expect(flatArc.x).toBeCloseTo(0.5, 12);
    const other = sampleArcMercator(src, tgt, 1000, 0.5, {
      ...flat,
      tiltDegrees: -90,
    });
    expect(other.y).toBeLessThan(0.5);
  });

  it('a zero-length OD pair degenerates without NaN', () => {
    const s = sampleArcMercator(src, src, 0, 0.5, {
      ...flat,
      tiltDegrees: 30,
    });
    expect(Number.isNaN(s.x)).toBe(false);
    expect(Number.isNaN(s.y)).toBe(false);
    expect(s.elevationMeters).toBe(0);
  });

  it('great-circle mode follows the sphere, not the mercator chord', () => {
    const a: [number, number] = [0, 60];
    const b: [number, number] = [120, 60];
    const [ax, ay] = lngLatToMercator(a[0], a[1]);
    const [bx, by] = lngLatToMercator(b[0], b[1]);
    const opts = {
      arcHeight: 0,
      tiltDegrees: 0,
      mercatorZPerMeter: mzpm,
      greatCircle: true,
      sourceLngLat: a,
      targetLngLat: b,
    };
    const gcMid = sampleArcMercator([ax, ay], [bx, by], 0, 0.5, opts);
    // Halfway in longitude, but POLEWARD of the chord: the great circle between
    // two mid-latitude points bows toward the pole (smaller mercator y).
    expect(gcMid.x).toBeCloseTo((ax + bx) / 2, 6);
    expect(gcMid.y).toBeLessThan((ay + by) / 2);
    // …and the endpoints still land on the CPU-projected ones.
    const start = sampleArcMercator([ax, ay], [bx, by], 0, 0, opts);
    expect(start.x).toBeCloseTo(ax, 9);
    expect(start.y).toBeCloseTo(ay, 9);
  });

  it('great-circle equator arcs stay on the equator', () => {
    const a: [number, number] = [0, 0];
    const b: [number, number] = [90, 0];
    const [ax, ay] = lngLatToMercator(a[0], a[1]);
    const [bx, by] = lngLatToMercator(b[0], b[1]);
    const mid = sampleArcMercator([ax, ay], [bx, by], 0, 0.5, {
      arcHeight: 0,
      tiltDegrees: 0,
      mercatorZPerMeter: mzpm,
      greatCircle: true,
      sourceLngLat: a,
      targetLngLat: b,
    });
    expect(mid.x).toBeCloseTo(lngLatToMercator(45, 0)[0], 9);
    expect(mid.y).toBeCloseTo(0.5, 9);
  });

  it('great-circle paths stay continuous across the antimeridian', () => {
    const a: [number, number] = [170, 0];
    const b: [number, number] = [-170, 0];
    const [ax, ay] = lngLatToMercator(a[0], a[1]);
    const [bxRaw, by] = lngLatToMercator(b[0], b[1]);
    const bx = unwrapMercatorX(ax, bxRaw);
    const opts = {
      arcHeight: 0,
      tiltDegrees: 0,
      mercatorZPerMeter: mzpm,
      greatCircle: true,
      sourceLngLat: a,
      targetLngLat: b,
    };
    let prev = ax;
    for (let i = 1; i <= 20; i++) {
      const s = sampleArcMercator([ax, ay], [bx, by], 0, i / 20, opts);
      // No 1-world jump anywhere along the path.
      expect(Math.abs(s.x - prev)).toBeLessThan(0.1);
      prev = s.x;
    }
    expect(prev).toBeCloseTo(bx, 6);
    expect(bx).toBeGreaterThan(1);
  });
});

describe('time-mode resolution', () => {
  it('degrades a mode whose length knob is non-positive (deck’s rule)', () => {
    expect(resolveArcTimeFilterMode('window', 0, 0)).toBe('window');
    expect(resolveArcTimeFilterMode('cumulative', 0, 0)).toBe('cumulative');
    expect(resolveArcTimeFilterMode('wake', 0, 1000)).toBe('window');
    expect(resolveArcTimeFilterMode('trail', 1000, 0)).toBe('window');
    expect(resolveArcTimeFilterMode('wake', 1000, 0)).toBe('wake');
    expect(resolveArcTimeFilterMode('trail', 0, 1000)).toBe('trail');
  });
});

// ── behaviour (mock GL) ─────────────────────────────────────────────────────

describe('tile cache', () => {
  it('reduces each LineString to its endpoints, one instance per feature', () => {
    const { cache } = makeLayer();
    expect(cache.instanceCount).toBe(3);
    expect(cache.vertexCount).toBe(3);
    expect(cache.hasFilterColumn).toBe(false);
    // Paris → Zurich → Berlin collapses to Paris → Berlin (middle dropped).
    expect(cache.maxSpan).toBeGreaterThan(0);
  });

  it('bakes the metres → mercator-z factor at the TILE’s latitude (D10)', () => {
    const { cache, tile } = makeLayer();
    expect(cache.mercatorZPerMeter).toBeCloseTo(
      mercatorZFromAltitude(1, tileCenterLatitude(tile.id.z, tile.id.y)),
      15,
    );
  });

  it('bakes lon/lat only when greatCircle is on', () => {
    expect(makeLayer().cache.lngLatBuffer).toBeUndefined();
    expect(makeLayer({ greatCircle: true }).cache.lngLatBuffer).toBeDefined();
  });

  it('drops the tile (with a warning) when instancing is unavailable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layer = new STTArcLayer({ ...baseOpts, id: 'a' }) as any;
      const gl = makeMockGl();
      const tile = makeArcTile();
      expect(layer.buildTileGpuCache(gl, tile, tile.layers[0])).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('drawTile variant dispatch', () => {
  it('legacy frame: uMatrix path, instanced strip draw, no prelude lookups', () => {
    const { layer, gl, tile, cache } = makeLayer();
    const frame = legacyFrame();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));

    const matrices = gl.uniformMatrix4fv.mock.calls.map((c: unknown[]) => c[2]);
    expect(matrices).toContain(frame.matrix);
    const looked = gl.getUniformLocation.mock.calls.map((c: unknown[]) => c[1]);
    expect(looked).not.toContain('u_projection_matrix');
    // 50 segments ⇒ 102 strip vertices × 3 instances.
    expect(gl.drawArraysInstanced).toHaveBeenCalledWith(
      gl.TRIANGLE_STRIP,
      0,
      arcStripVertexCount(50),
      3,
    );
  });

  it('v5 frame: compiles the prelude source, sets u_projection_* and skips uMatrix', () => {
    const { layer, gl, tile, cache } = makeLayer();
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
        'u_projection_tile_mercator_coords',
        'u_projection_clipping_plane',
        'u_projection_transition',
        'u_projection_fallback_matrix',
      ]),
    );
    const matrices = gl.uniformMatrix4fv.mock.calls.map((c: unknown[]) => c[2]);
    expect(matrices).toContain(frame.projectionData!.mainMatrix);
    expect(matrices).not.toContain(frame.matrix);
  });

  it('caches per variant: same frame reuses the program AND the tile VAO', () => {
    const { layer, gl, tile, cache } = makeLayer();
    const frame = normalizeRenderArgs(v5Args('mercator'));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));
    const programs = gl.createProgram.mock.calls.length;
    const vaos = gl.createVertexArray.mock.calls.length;

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));
    expect(gl.createProgram.mock.calls.length).toBe(programs);
    expect(gl.createVertexArray.mock.calls.length).toBe(vaos);
  });

  it('records the VAO axes as FIELDS, so drawTile allocates no key string', () => {
    // `drawTile` runs per resident tile per frame; concatenating
    // `${key}::${variant}::${segments}` there would allocate a short-lived
    // string per tile per frame purely to prove nothing changed. The two axes
    // are compared in place instead (the sibling kinds hoist their key into the
    // variant-flip branch for the same reason).
    const { layer, gl, tile, cache } = makeLayer();
    const frame = normalizeRenderArgs(v5Args('mercator'));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));
    expect(cache.vaoKey).toBeUndefined();
    expect(cache.vaoVariant).toBe('mercator');
    expect(typeof cache.vaoSegments).toBe('number');

    // …and the segment axis still invalidates: a globe frame re-tessellates.
    const vaos = gl.createVertexArray.mock.calls.length;
    cache.vaoSegments = (cache.vaoSegments as number) + 1;
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));
    expect(gl.createVertexArray.mock.calls.length).toBe(vaos + 1);
  });

  it('a variant flip relinks once and re-records the tile VAO', () => {
    const { layer, gl, tile, cache } = makeLayer();
    const legacy = legacyFrame();
    const mercatorV5 = normalizeRenderArgs(v5Args('mercator'));

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacy));
    expect(gl.createProgram.mock.calls.length).toBe(1);
    expect(gl.createVertexArray.mock.calls.length).toBe(1);

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(mercatorV5));
    expect(gl.createProgram.mock.calls.length).toBe(2);
    expect(gl.deleteVertexArray).toHaveBeenCalledTimes(1);
    expect(gl.createVertexArray.mock.calls.length).toBe(2);

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacy));
    expect(gl.createProgram.mock.calls.length).toBe(2);
    expect(gl.createVertexArray.mock.calls.length).toBe(3);
  });

  it('a mode flip relinks but never rebuilds the tile cache', () => {
    const { layer, gl, tile, cache } = makeLayer();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.createProgram.mock.calls.length).toBe(1);
    const buffers = gl.createBuffer.mock.calls.length;

    // wakeLength defaults to half the timeWindow, so the mode really engages.
    layer.setTimeFilterMode('wake');
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.createProgram.mock.calls.length).toBe(2);
    expect(vertexSources(gl).some((s) => s.includes('sttWakeSizeScale'))).toBe(
      true,
    );
    // No new tile buffers: the arc bakes no per-vertex times (unlike the line
    // layer's trail mode) — only the shared strip could be re-uploaded.
    expect(gl.createBuffer.mock.calls.length).toBe(buffers);
  });
});

describe('tessellation uniforms and the globe refinement', () => {
  it('uploads the configured segment count off globe', () => {
    const { layer, gl, tile, cache } = makeLayer({ numSegments: 8 });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(lastScalar(uniformsByName(gl), 'uNumSegments')).toBe(8);
    expect(gl.drawArraysInstanced).toHaveBeenCalledWith(
      gl.TRIANGLE_STRIP,
      0,
      arcStripVertexCount(8),
      3,
    );
  });

  it('raises (never lowers) the count on globe so pieces fit the granularity', () => {
    const { layer, gl, tile, cache } = makeLayer({ numSegments: 8 });
    const globe = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(globe));

    // The layer's own rule: ceil(maxSpan × per-tile granularity × 2^z), rounded
    // UP to a power of two so the shared strip cache stays small.
    const needed = Math.ceil(
      cache.maxSpan * granularityForZoom(undefined, tile.id.z) * 2 ** tile.id.z,
    );
    const expected = 2 ** Math.ceil(Math.log2(needed));
    expect(needed).toBeGreaterThan(8);
    expect(expected).toBeGreaterThanOrEqual(needed);
    expect(lastScalar(uniformsByName(gl), 'uNumSegments')).toBe(expected);
    expect(gl.drawArraysInstanced).toHaveBeenLastCalledWith(
      gl.TRIANGLE_STRIP,
      0,
      arcStripVertexCount(expected),
      3,
    );
  });

  it('the globe refinement never exceeds MAX_ARC_SEGMENTS', () => {
    const { layer, gl, tile, cache } = makeLayer({ numSegments: 4 });
    // A pathological host granularity: the cap is what keeps a hostile
    // subdivision setting from demanding unbounded vertex work.
    layer.map = {
      getZoom: () => 2,
      triggerRepaint: vi.fn(),
      style: {
        projection: {
          subdivisionGranularity: {
            tile: { getGranularityForZoomLevel: () => 1_000_000 },
          },
        },
      },
    };
    const globe = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(globe));
    expect(lastScalar(uniformsByName(gl), 'uNumSegments')).toBe(
      MAX_ARC_SEGMENTS,
    );
  });

  it('a globe frame that needs FEWER pieces keeps the configured count', () => {
    const { layer, gl, tile, cache } = makeLayer({ numSegments: 256 });
    const globe = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(globe));
    expect(lastScalar(uniformsByName(gl), 'uNumSegments')).toBe(256);
  });

  it('a segment-count change re-records the VAO (the strip buffer moved)', () => {
    const { layer, gl, tile, cache } = makeLayer({ numSegments: 8 });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.createVertexArray.mock.calls.length).toBe(1);

    layer.setNumSegments(16);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    // Same program (segments are a uniform), but the recorded strip buffer is
    // a different object, so the VAO must be rebuilt.
    expect(gl.createProgram.mock.calls.length).toBe(1);
    expect(gl.deleteVertexArray).toHaveBeenCalledTimes(1);
    expect(gl.createVertexArray.mock.calls.length).toBe(2);
  });

  it('clamps numSegments into [1, MAX_ARC_SEGMENTS]', () => {
    const { layer, gl, tile, cache } = makeLayer({ numSegments: 100_000 });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(lastScalar(uniformsByName(gl), 'uNumSegments')).toBe(
      MAX_ARC_SEGMENTS,
    );
    layer.setNumSegments(0);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(lastScalar(uniformsByName(gl), 'uNumSegments')).toBe(1);
  });
});

describe('prop defaults (back-compat surface)', () => {
  it('an options bag with no knobs draws deck’s default arc', () => {
    const { layer, gl, tile, cache } = makeLayer();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uNumSegments')).toBe(50);
    expect(lastScalar(u, 'uArcHeight')).toBe(1);
    expect(lastScalar(u, 'uTiltCos')).toBe(1);
    expect(lastScalar(u, 'uTiltSin')).toBe(0);
    expect(lastScalar(u, 'uWidth')).toBe(2);
    expect(lastScalar(u, 'uWidthScale')).toBe(1);
    expect(lastScalar(u, 'uWidthMinPixels')).toBe(0);
    expect(lastScalar(u, 'uUseFeatureColor')).toBe(0);
    expect(lastScalar(u, 'uUseFeatureWidth')).toBe(0);
    // Window mode, hard edges — no wake / trail / cumulative uniform exists.
    expect(lastScalar(u, 'uWindowStart')).toBe(0);
    expect(lastScalar(u, 'uFadeIn')).toBe(0);
    expect(u.has('uCurrentTime')).toBe(false);
    expect(u.has('uFilterEnabled')).toBe(false);
    // deck's ArcLayer source/target colours, normalized to 0..1.
    const colors = gl.uniform4fv.mock.calls.map((c: unknown[]) => c[1]);
    expect(colors).toContainEqual([0, 150 / 255, 1, 1]);
    expect(colors).toContainEqual([1, 127 / 255, 14 / 255, 1]);
  });

  it('an EXPLICIT undefined does not shadow a default', () => {
    // The React prop-forwarding shape `{ ...base, arcHeight: props.arcHeight }`
    // carries an own key whose value is undefined.
    const { layer, gl, tile, cache } = makeLayer({
      arcHeight: undefined,
      numSegments: undefined,
      width: undefined,
      widthUnits: undefined,
      greatCircle: undefined,
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uArcHeight')).toBe(1);
    expect(lastScalar(u, 'uNumSegments')).toBe(50);
    expect(lastScalar(u, 'uWidth')).toBe(2);
    expect(lastScalar(u, 'uWidthScale')).toBe(1);
    expect(vertexSources(gl)[0]).not.toContain('aLngLat');
  });

  it('height / tilt / colours are uniform-only (no relink, no rebuild)', () => {
    const { layer, gl, tile, cache } = makeLayer();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const programs = gl.createProgram.mock.calls.length;
    const buffers = gl.createBuffer.mock.calls.length;

    layer.setArcHeight(0.25);
    layer.setArcTilt(30);
    layer.setSourceColor([255, 0, 0, 255]);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.createProgram.mock.calls.length).toBe(programs);
    expect(gl.createBuffer.mock.calls.length).toBe(buffers);
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uArcHeight')).toBe(0.25);
    expect(lastScalar(u, 'uTiltCos')).toBeCloseTo(
      Math.cos((30 * Math.PI) / 180),
      12,
    );
    expect(lastScalar(u, 'uTiltSin')).toBeCloseTo(
      Math.sin((30 * Math.PI) / 180),
      12,
    );
  });
});

describe('time-mode uniform wiring', () => {
  it('wake sets tile-relative uCurrentTime + the wake knobs', () => {
    const { layer, gl, tile, cache } = makeLayer({
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

  it('an unset wake/trail length defaults to half the window and TRACKS it', () => {
    const { layer, gl, tile, cache } = makeLayer({ timeFilterMode: 'trail' });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(lastScalar(uniformsByName(gl), 'uTrailLength')).toBe(2500);

    layer.setTimeWindow(20_000);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(lastScalar(uniformsByName(gl), 'uTrailLength')).toBe(10_000);
  });

  it('an EXPLICIT trail length is never re-derived by setTimeWindow', () => {
    const { layer, gl, tile, cache } = makeLayer({
      timeFilterMode: 'trail',
      trailLength: 777,
    });
    layer.setTimeWindow(20_000);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(lastScalar(uniformsByName(gl), 'uTrailLength')).toBe(777);
  });

  it('a zero-length wake degrades to window rather than drawing nothing', () => {
    const { layer, gl, tile, cache } = makeLayer({
      timeFilterMode: 'wake',
      wakeLength: 0,
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const u = uniformsByName(gl);
    expect(u.has('uWakeLength')).toBe(false);
    expect(lastScalar(u, 'uWindowEnd')).toBe(10_000);
  });
});

describe('metric sizing (widthUnits)', () => {
  it("'meters' folds the per-tile metres→device-pixels factor into uWidthScale", () => {
    const { layer, gl, tile, cache } = makeLayer({
      widthUnits: 'meters',
      width: 500,
      widthScale: 2,
    });
    layer.map = { getZoom: () => 3.5, triggerRepaint: vi.fn() };
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));

    const dpr =
      (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1;
    const expected =
      2 *
      metersToPixelsAtLatitude(
        1,
        tileCenterLatitude(tile.id.z, tile.id.y),
        3.5,
        512 * dpr,
      );
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uWidthScale')).toBeCloseTo(expected, 9);
    // The width itself rides raw — the unit lives entirely in the scale.
    expect(lastScalar(u, 'uWidth')).toBe(500);
  });

  it('metric sizing adds no shader variant, and the clamps ride as uniforms', () => {
    const { layer, gl, tile, cache } = makeLayer({
      widthUnits: 'meters',
      widthMinPixels: 1,
      widthMaxPixels: 40,
    });
    layer.map = { getZoom: () => 3, triggerRepaint: vi.fn() };
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uWidthMinPixels')).toBe(1);
    expect(lastScalar(u, 'uWidthMaxPixels')).toBe(40);
    expect(vertexSources(gl)[0]).not.toContain('uMetersPerPixel');
  });
});

describe('per-feature colour and width columns', () => {
  it('a categorical colour column colours the WHOLE arc (deck constraint)', () => {
    const { layer, gl, tile, cache } = makeLayer({
      colorProperty: 'mode',
      colorMapping: { air: [1, 2, 3, 4], sea: [5, 6, 7, 8] },
    });
    expect(cache.colorBuffer).toBeDefined();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    // The gradient is bypassed wholesale, exactly like deck's single unified
    // category colour — both endpoints take the feature's colour.
    expect(lastScalar(uniformsByName(gl), 'uUseFeatureColor')).toBe(1);
    const uploaded = gl.bufferData.mock.calls
      .map((c: unknown[]) => c[1])
      .filter((v: unknown) => v instanceof Uint8Array);
    expect(Array.from(uploaded.at(-1) as Uint8Array).slice(0, 8)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it('a width column binds per instance and flips uUseFeatureWidth', () => {
    const { layer, gl, tile, cache } = makeLayer({
      widthProperty: 'strokeWidth',
    });
    expect(cache.widthBuffer).toBeDefined();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(lastScalar(uniformsByName(gl), 'uUseFeatureWidth')).toBe(1);
  });

  it('a missing column silently falls back to the constants', () => {
    const { layer, gl, tile, cache } = makeLayer({
      colorProperty: 'nope',
      widthProperty: 'alsoNope',
    });
    expect(cache.colorBuffer).toBeUndefined();
    expect(cache.widthBuffer).toBeUndefined();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uUseFeatureColor')).toBe(0);
    expect(lastScalar(u, 'uUseFeatureWidth')).toBe(0);
  });
});

describe('DataFilter wiring', () => {
  it('binds the per-FEATURE column directly and enables the filter', () => {
    const { layer, gl, tile, cache } = makeLayer({
      filterProperty: 'volume',
      filterRange: [5, 30] as const,
    });
    expect(cache.filterBuffer).toBeDefined();
    expect(cache.hasFilterColumn).toBe(true);

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uFilterEnabled')).toBe(1);
    expect(vec2Args(gl, 'uFilterRange').at(-1)).toEqual([5, 30]);
    // No soft range ⇒ the soft edges collapse onto the hard ones (hard step).
    expect(vec2Args(gl, 'uFilterSoftRange').at(-1)).toEqual([5, 30]);
  });

  it('a tile MISSING the column renders unfiltered, never blank', () => {
    const { layer, gl, tile, cache } = makeLayer(
      { filterProperty: 'volume', filterRange: [5, 30] as const },
      makeBareArcTile(),
    );
    expect(cache.filterBuffer).toBeUndefined();
    expect(cache.hasFilterColumn).toBe(false);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(lastScalar(uniformsByName(gl), 'uFilterEnabled')).toBe(0);
  });

  it('a CATEGORICAL column warns ONCE and renders unfiltered', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { layer, gl, cache } = makeLayer({
        filterProperty: 'mode',
        filterRange: [0, 1] as const,
      });
      expect(cache.hasFilterColumn).toBe(false);
      const t2 = makeArcTile();
      layer.buildTileGpuCache(gl, t2, t2.layers[0]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('setFilterRange is uniform-only — no relink, no tile rebuild', () => {
    const { layer, gl, tile, cache } = makeLayer({
      filterProperty: 'volume',
      filterRange: [5, 30] as const,
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const programs = gl.createProgram.mock.calls.length;
    const buffers = gl.createBuffer.mock.calls.length;

    layer.setFilterRange([10, 20]);
    layer.setFilterSoftRange([12, 18]);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.createProgram.mock.calls.length).toBe(programs);
    expect(gl.createBuffer.mock.calls.length).toBe(buffers);
    expect(vec2Args(gl, 'uFilterRange').at(-1)).toEqual([10, 20]);
    expect(vec2Args(gl, 'uFilterSoftRange').at(-1)).toEqual([12, 18]);

    layer.setFilterEnabled(false);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(lastScalar(uniformsByName(gl), 'uFilterEnabled')).toBe(0);
  });
});

describe('drawPickTile', () => {
  it('draws one id per FEATURE and frees the one-shot buffer', () => {
    const { layer, gl, tile, cache } = makeLayer();
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    expect(idVertexSource(gl)).toContain('vIdColor = aIdColor;');
    expect(gl.drawArraysInstanced).toHaveBeenLastCalledWith(
      gl.TRIANGLE_STRIP,
      0,
      arcStripVertexCount(50),
      3,
    );
    expect(gl.deleteBuffer).toHaveBeenCalled();
  });

  it('v5 frame: the id program is built from the SAME prelude source', () => {
    const { layer, gl, tile, cache } = makeLayer();
    const frame = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawPickTile(gl, tile, tile.layers[0], cache, drawCtx(frame), 1);
    const idSrc = idVertexSource(gl);
    expect(idSrc.includes(PRELUDE_MARKER)).toBe(true);
    expect(idSrc).toContain('projectTileFor3D(');
    const matrices = gl.uniformMatrix4fv.mock.calls.map((c: unknown[]) => c[2]);
    expect(matrices).toContain(frame.projectionData!.mainMatrix);
    expect(matrices).not.toContain(frame.matrix);
  });

  it('leaves no divisor or attribute enabled behind', () => {
    const { layer, gl, tile, cache } = makeLayer({
      greatCircle: true,
      widthProperty: 'strokeWidth',
      filterProperty: 'volume',
      filterRange: [0, 100] as const,
    });
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    // Every divisor this pass raised is put back to 0 …
    const divisors = gl.vertexAttribDivisor.mock.calls;
    expect(divisors.length).toBeGreaterThan(0);
    expect(divisors.at(-1)).toEqual([0, 0]);
    const raised = divisors.filter((c: number[]) => c[1] === 1).length;
    const cleared = divisors.filter((c: number[]) => c[1] === 0).length;
    expect(cleared).toBeGreaterThanOrEqual(raised);
    // … and every attribute it enabled is disabled again.
    expect(gl.disableVertexAttribArray).toHaveBeenCalled();
  });
});

describe('pick gating parity (invisible ⇒ unpickable)', () => {
  it('the id program compiles the SAME time mode, size shrink and discard', () => {
    const { layer, gl, tile, cache } = makeLayer({
      timeFilterMode: 'wake',
      wakeLength: 30_000,
    });
    const ctx = drawCtx(legacyFrame());
    layer.drawPickTile(gl, tile, tile.layers[0], cache, ctx, 1);
    const idSrc = idVertexSource(gl);
    expect(idSrc).toContain(
      'float timeAlpha = sttWakeAlpha(aTime, uCurrentTime, uWakeLength);',
    );
    expect(idSrc).toContain(
      'widthPx *= sttWakeSizeScale(timeAlpha, uWakeTailScale);',
    );
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uCurrentTime')).toBe(
      ctx.currentTime - cache.timeOffset,
    );
    expect(lastScalar(u, 'uWakeLength')).toBe(30_000);
    // The id fragment stage discards a zero-alpha fragment before it can paint.
    const idFs = vertexSources(gl).find(
      (s) => s.includes('vIdColor') && s.includes('gl_FragColor'),
    )!;
    expect(idFs).toContain('if (vAlpha <= 0.0) discard;');
  });

  it('the id pass applies the SAME DataFilter range as the visual pass', () => {
    const { layer, gl, tile, cache } = makeLayer({
      filterProperty: 'volume',
      filterRange: [5, 30] as const,
    });
    const ctx = drawCtx(legacyFrame());
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    const visualRange = vec2Args(gl, 'uFilterRange').at(-1);

    layer.drawPickTile(gl, tile, tile.layers[0], cache, ctx, 1);
    expect(idVertexSource(gl)).toContain(
      `float filterAlpha = ${DATA_FILTER_CALL_GLSL};`,
    );
    expect(vec2Args(gl, 'uFilterRange').at(-1)).toEqual(visualRange);
    expect(lastScalar(uniformsByName(gl), 'uFilterEnabled')).toBe(1);
  });

  it('the id pass tessellates and sizes exactly like the visual pass', () => {
    const { layer, gl, tile, cache } = makeLayer({
      numSegments: 12,
      widthUnits: 'meters',
      width: 300,
    });
    layer.map = { getZoom: () => 4, triggerRepaint: vi.fn() };
    const ctx = drawCtx(legacyFrame());
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    const visual = uniformsByName(gl);
    const visualScale = lastScalar(visual, 'uWidthScale');
    const visualSegments = lastScalar(visual, 'uNumSegments');

    const gl2 = makeMockGl();
    layer.drawPickTile(gl2, tile, tile.layers[0], cache, ctx, 1);
    const picked = uniformsByName(gl2);
    expect(lastScalar(picked, 'uWidthScale')).toBe(visualScale);
    expect(lastScalar(picked, 'uNumSegments')).toBe(visualSegments);
    expect(lastScalar(picked, 'uArcHeight')).toBe(1);
  });
});

describe('context lifecycle', () => {
  it('releases the shared strip buffers on context loss', () => {
    const { layer, gl, tile, cache } = makeLayer({ numSegments: 8 });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    layer.setNumSegments(16);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const deletedBefore = gl.deleteBuffer.mock.calls.length;

    layer.onContextLost(gl);
    // Both cached strips (8 and 16 segments) are released.
    expect(gl.deleteBuffer.mock.calls.length).toBe(deletedBefore + 2);
    // …and a later draw rebuilds one lazily rather than reusing a dead handle.
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.deleteBuffer.mock.calls.length).toBe(deletedBefore + 2);
  });
});

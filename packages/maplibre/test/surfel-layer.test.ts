/**
 * Surfel layer — oriented anisotropic Gaussian splats.
 *
 * String-level: the vertex-source builder emits the legacy `uMatrix` shader for
 * an empty prelude and the prelude-injected elevated-projection block for v5+
 * hosts, compiles in exactly ONE time kernel per program, adds the DataFilter
 * branch only when a `filterProperty` names a column, and adds the temporal
 * Gaussian only when `temporalSigma > 0` — in the id-pick pass too, which
 * shares the builder AND the fragment gate so the pickable ellipse cannot drift
 * from the drawn one.
 * Numeric: the quaternion→basis expansion, the two Gaussian weights and the
 * smallest-three unpack are pinned against hand-computed constants, not against
 * the code under test (this repo ships no pixel goldens — `mock-gl` is a
 * recorder, not a rasterizer).
 * Behaviour-level (mock-gl): one instanced draw of 4 quad vertices × N surfels,
 * divisor 1 on every per-surfel attribute and 0 on the corner, tile-relative
 * times, metres→mercator factors resolved at the TILE's centre latitude, VAO
 * re-record across a compiled-mode flip, and a pick pass that binds, draws and
 * then fully un-binds (divisors included).
 */

import { describe, it, expect, vi } from 'vitest';
import { GeometryType, type Tile } from '@poopdeck.gl/core';
import {
  STTSurfelLayer,
  buildSurfelVertexSource,
  buildSurfelIdVertexSource,
  surfelProgramKey,
  resolveSurfelTimeFilterMode,
  unpackSmallestThreeQuat,
  SURFEL_DEFAULT_EXTENT_COLUMNS,
  type SurfelShaderConfig,
} from '../src/layers/surfel-layer';
import {
  surfelBasisRef,
  surfelDiskWeightRef,
  surfelTemporalWeightRef,
  SURFEL_BASIS_STEPS,
} from '../src/shaders/surfel-disk.glsl';
import { GLOBE_ELEVATION_STEPS } from '../src/shaders/globe-elevation.glsl';
import {
  metersToMercatorUnits,
  mercatorZFromAltitude,
  tileCenterLatitude,
} from '../src/lib/projection';
import { makeMockGl, makeMockMap } from './mock-gl';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

const PRELUDE =
  'uniform mat4 u_projection_matrix;\n' +
  'vec4 projectTile(vec2 p) { return u_projection_matrix * vec4(p, 0.0, 1.0); }\n' +
  'vec4 projectTileFor3D(vec2 p, float z) { return vec4(p, z, 1.0); }';

const mat16 = () => new Float32Array(Array.from({ length: 16 }, (_, i) => i));

const legacyFrame = () => ({
  matrix: mat16(),
  shader: { variantName: 'legacy', prelude: '', define: '' },
});

const v5Frame = (variantName = 'globe') => ({
  matrix: mat16(),
  shader: { variantName, prelude: PRELUDE, define: '#define GLOBE' },
  projection: {
    mainMatrix: mat16(),
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 0, 1],
    projectionTransition: 0,
    fallbackMatrix: mat16(),
  },
});

const drawCtx = (frame: any, extra: Record<string, unknown> = {}) => ({
  matrix: frame.matrix,
  frame,
  windowStart: 0,
  windowEnd: 10_000,
  currentTime: baseOpts.currentTime,
  zoom: 2,
  ...extra,
});

/**
 * Three surfels with the FULL surfel column contract: a full quaternion, two
 * DISTINCT half-extents in metres, an elevation column, per-surfel RGB and a
 * confidence. `test/fixtures.ts` has no surfel builder, so this is local.
 */
function makeSurfelTile(
  props: Record<string, Float32Array> = {},
  overrides: Record<string, unknown> = {},
): Tile {
  const features = {
    featureCount: 3,
    geometryType: GeometryType.Point,
    positionDimensions: 2 as const,
    positions: new Float64Array([-122.4, 37.7, -122.41, 37.71, -122.42, 37.72]),
    featureIds: new Uint32Array([0, 1, 2]),
    startTimes: new Float32Array([0, 1000, 2000]),
    endTimes: new Float32Array([500, 1500, 2500]),
    timeOffset: 1_700_000_000_000,
    numericProps: {
      // 90° about +Z: tangent → +y, bitangent → −x, normal stays +z.
      qx: new Float32Array([0, 0, 0]),
      qy: new Float32Array([0, 0, 0]),
      qz: new Float32Array([Math.SQRT1_2, 0, 0]),
      qw: new Float32Array([Math.SQRT1_2, 1, 1]),
      s_major: new Float32Array([2, 4, 6]),
      s_minor: new Float32Array([0.5, 1, 1.5]),
      z: new Float32Array([10, 20, 30]),
      r: new Float32Array([255, 0, 0]),
      g: new Float32Array([0, 255, 0]),
      b: new Float32Array([0, 0, 255]),
      surfel_opacity: new Float32Array([1, 0.5, 0.25]),
      ...props,
    },
    categoricalProps: {},
  };
  return {
    id: { z: 2, x: 1, y: 1, t: 1_700_000_000_000 },
    timeRange: { start: 1_700_000_000_000, end: 1_700_000_003_000 },
    layers: [
      {
        name: 'surfels',
        extent: 4096,
        features,
        geometryExtensionName: 'geoarrow.point',
        ...overrides,
      },
    ],
  } as unknown as Tile;
}

/** A layer wired for headless draws: real instancing, delegated to the recorder. */
function makeLayer(gl: any, extra: Record<string, unknown> = {}): any {
  const layer = new STTSurfelLayer({
    ...baseOpts,
    id: 's',
    ...extra,
  } as any) as any;
  layer.map = makeMockMap();
  layer.instSupport = {
    enabled: true,
    drawArraysInstanced: (m: number, f: number, c: number, p: number) =>
      gl.drawArraysInstanced(m, f, c, p),
    drawElementsInstanced: (...a: unknown[]) =>
      (gl.drawElementsInstanced as any)(...a),
    vertexAttribDivisor: (i: number, d: number) => gl.vertexAttribDivisor(i, d),
  };
  return layer;
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

/**
 * Divisors in call order. The recorder hands out location `0` for EVERY
 * attribute (`getAttribLocation: () => 0`), so a divisor can only be joined to
 * an attribute positionally — by the order `bindSharedAttributes` binds them.
 */
const divisorSequence = (gl: any): number[] =>
  gl.vertexAttribDivisor.mock.calls.map((c: unknown[]) => c[1] as number);

const cfg = (over: Partial<SurfelShaderConfig> = {}): SurfelShaderConfig => ({
  mode: 'window',
  filter: false,
  temporal: false,
  ...over,
});

// ── shader assembly ─────────────────────────────────────────────────────────

describe('buildSurfelVertexSource', () => {
  it('legacy variant keeps the uMatrix path with nothing injected', () => {
    const src = buildSurfelVertexSource({ prelude: '', define: '' });
    expect(src).toContain('uniform mat4 uMatrix;');
    expect(src).toContain('uMatrix * vec4(posM, elevM * uMercatorZPerMeter');
    expect(src).not.toContain('projectTile');
    expect(src).toContain('sttTimeWindowAlpha');
  });

  it('v5 variant prepends prelude + define and routes through the elevated block', () => {
    const src = buildSurfelVertexSource({
      prelude: PRELUDE,
      define: '#define GLOBE',
    });
    expect(src.startsWith(PRELUDE)).toBe(true);
    const defineAt = src.indexOf('#define GLOBE');
    expect(defineAt).toBeGreaterThan(src.indexOf('vec4 projectTile'));
    expect(defineAt).toBeLessThan(src.indexOf('void main'));
    expect(src).not.toContain('uniform mat4 uMatrix;');
    // The one elevated-projection implementation, not a transcription.
    for (const step of GLOBE_ELEVATION_STEPS) expect(src).toContain(step);
    expect(src).toContain('projectTileFor3D(posM, elevM * uMercatorZPerMeter)');
  });

  it('builds the offset in the surfel FRAME from two DISTINCT half-extents', () => {
    const src = buildSurfelVertexSource({ prelude: '', define: '' });
    for (const step of SURFEL_BASIS_STEPS) expect(src).toContain(step);
    // tangent × major, bitangent × minor — the anisotropy IS the layer.
    expect(src).toContain('frame[0] * (corner.x * halfExtent.x)');
    expect(src).toContain('frame[1] * (corner.y * halfExtent.y)');
    // ENU north is +y, mercator y grows southward.
    expect(src).toContain('vec2(offENU.x, -offENU.y) * uMercatorPerMeter');
    // Out-of-plane component rides the elevation, in METRES.
    expect(src).toContain('+ offENU.z');
    // Not a billboard: nothing here touches gl_PointSize.
    expect(src).not.toContain('gl_PointSize');
  });

  it('remaps the shared unit quad into the [-1,1]² the fragment Gaussian wants', () => {
    const src = buildSurfelVertexSource({ prelude: '', define: '' });
    expect(src).toContain('attribute vec2 aCorner;');
    expect(src).toContain(
      'vec2 corner = vec2(aCorner.x, aCorner.y * 2.0 - 1.0)',
    );
    expect(src).toContain('vDisk = corner;');
  });

  it('compiles exactly one time kernel per mode', () => {
    const kernels = {
      window: 'sttTimeWindowAlpha',
      wake: 'sttWakeAlpha',
      cumulative: 'sttCumulativeAlpha',
      trail: 'sttTrailAlpha',
    } as const;
    for (const [mode, fn] of Object.entries(kernels)) {
      const src = buildSurfelVertexSource(
        { prelude: '', define: '' },
        cfg({ mode: mode as any }),
      );
      expect(src).toContain(`vAlpha = ${fn}(`);
      for (const [other, otherFn] of Object.entries(kernels)) {
        if (other === mode) continue;
        expect(src).not.toContain(`vAlpha = ${otherFn}(`);
      }
    }
  });

  it('never taper-scales the extent in wake mode — a surfel is a measurement', () => {
    const src = buildSurfelVertexSource(
      { prelude: '', define: '' },
      cfg({ mode: 'wake' }),
    );
    expect(src).toContain('vAlpha = sttWakeAlpha(');
    // The shared kernel DECLARES sttWakeSizeScale; this layer never calls it,
    // and never declares the uniform that would feed it.
    expect(src).not.toContain('sttWakeSizeScale(vAlpha');
    expect(src).not.toContain('uniform float uWakeTailScale;');
  });

  it('adds the DataFilter branch only when the config asks, and never a size transform', () => {
    const off = buildSurfelVertexSource({ prelude: '', define: '' });
    expect(off).not.toContain('sttDataFilterAlpha');
    const on = buildSurfelVertexSource(
      { prelude: '', define: '' },
      cfg({ filter: true }),
    );
    expect(on).toContain('sttDataFilterAlpha');
    expect(on).toContain('uFilterTransformColor > 0.5');
    // Declared by the shared chunk, deliberately never READ (deck's
    // SolidPolygonLayer split): the extent is a measurement, not a style.
    expect(on).not.toContain('uFilterTransformSize > 0.5');
  });

  it('adds the temporal Gaussian only when the config asks', () => {
    const off = buildSurfelVertexSource({ prelude: '', define: '' });
    expect(off).not.toContain('sttSurfelTemporalWeight(uSurfelNow');
    expect(off).not.toContain('uniform float uTemporalInvSigma;');
    const on = buildSurfelVertexSource(
      { prelude: '', define: '' },
      cfg({ temporal: true }),
    );
    // Centred on the surfel's OWN sample time.
    expect(on).toContain(
      'sttSurfelTemporalWeight(uSurfelNow, aTime.x, uTemporalInvSigma)',
    );
  });

  it('folds confidence and base alpha into vAlpha in the VERTEX stage', () => {
    const src = buildSurfelVertexSource({ prelude: '', define: '' });
    expect(src).toContain('aConfidence');
    expect(src).toContain('vAlpha *= uBaseAlpha;');
  });
});

describe('surfel id pass', () => {
  it('differs from the visual source ONLY in what it carries as payload', () => {
    const shader = { prelude: '', define: '' };
    const main = buildSurfelVertexSource(shader);
    const id = buildSurfelIdVertexSource(shader);
    expect(id).toContain('attribute vec3 aIdColor;');
    expect(id).toContain('varying vec3 vIdColor;');
    expect(id).not.toContain('attribute vec3 aColor;');
    // Same projection, same frame, same sizing, same gates.
    for (const shared of [
      'sttSurfelBasis(',
      'frame[0] * (corner.x * halfExtent.x)',
      'frame[1] * (corner.y * halfExtent.y)',
      'vec2(offENU.x, -offENU.y) * uMercatorPerMeter',
      'halfExtent = max(halfExtent, vec2(uMinExtentMeters));',
      'vAlpha *= uBaseAlpha;',
      'uMatrix * vec4(posM, elevM * uMercatorZPerMeter',
    ]) {
      expect(main).toContain(shared);
      expect(id).toContain(shared);
    }
  });

  it('carries every alpha gate the visual pass compiles', () => {
    const shader = { prelude: '', define: '' };
    for (const c of [
      cfg({ mode: 'trail' }),
      cfg({ filter: true }),
      cfg({ temporal: true }),
      cfg({ mode: 'wake', filter: true, temporal: true }),
    ]) {
      const main = buildSurfelVertexSource(shader, c);
      const id = buildSurfelIdVertexSource(shader, c);
      for (const gate of [
        'sttTrailAlpha(',
        'sttWakeAlpha(',
        'sttDataFilterAlpha',
        'sttSurfelTemporalWeight(',
      ]) {
        expect(id.includes(gate)).toBe(main.includes(gate));
      }
    }
  });
});

describe('surfelProgramKey', () => {
  it('carries every structural axis it compiles', () => {
    const keys = new Set<string>();
    for (const pass of ['main', 'pick'] as const) {
      for (const mode of ['window', 'wake', 'cumulative', 'trail'] as const) {
        for (const filter of [false, true]) {
          for (const temporal of [false, true]) {
            keys.add(surfelProgramKey(pass, cfg({ mode, filter, temporal })));
          }
        }
      }
    }
    // 2 passes × 4 modes × 2 filter × 2 temporal — no collisions.
    expect(keys.size).toBe(32);
    expect(surfelProgramKey('main', cfg())).toBe('surfel:main:window');
    expect(
      surfelProgramKey(
        'pick',
        cfg({ mode: 'trail', filter: true, temporal: true }),
      ),
    ).toBe('surfel:pick:trail:filter:temporal');
  });
});

describe('resolveSurfelTimeFilterMode', () => {
  it('applies the package-wide degradation table', () => {
    expect(resolveSurfelTimeFilterMode('cumulative', 0, 0)).toBe('cumulative');
    expect(resolveSurfelTimeFilterMode('wake', 0, 0)).toBe('window');
    expect(resolveSurfelTimeFilterMode('wake', 100, 0)).toBe('wake');
    expect(resolveSurfelTimeFilterMode('trail', 0, 0)).toBe('window');
    expect(resolveSurfelTimeFilterMode('trail', 0, 100)).toBe('trail');
    expect(resolveSurfelTimeFilterMode('window', 100, 100)).toBe('window');
    // Unset: deck's TimeFilterExtension precedence.
    expect(resolveSurfelTimeFilterMode(undefined, 100, 100)).toBe('wake');
    expect(resolveSurfelTimeFilterMode(undefined, 0, 100)).toBe('trail');
    expect(resolveSurfelTimeFilterMode(undefined, 0, 0)).toBe('window');
  });
});

// ── numeric kernels (JS twins of the GLSL) ──────────────────────────────────

describe('surfel kernels', () => {
  it('identity quaternion is the identity basis', () => {
    expect(Array.from(surfelBasisRef(0, 0, 0, 1))).toEqual([
      1, 0, 0, 0, 1, 0, 0, 0, 1,
    ]);
  });

  it('90° about +Z sends tangent→+y and bitangent→−x, column-major', () => {
    const m = surfelBasisRef(0, 0, Math.SQRT1_2, Math.SQRT1_2);
    // column 0 = tangent
    expect(m[0]).toBeCloseTo(0, 12);
    expect(m[1]).toBeCloseTo(1, 12);
    expect(m[2]).toBeCloseTo(0, 12);
    // column 1 = bitangent
    expect(m[3]).toBeCloseTo(-1, 12);
    expect(m[4]).toBeCloseTo(0, 12);
    expect(m[5]).toBeCloseTo(0, 12);
    // column 2 = normal, untouched by a spin about itself
    expect(m[6]).toBeCloseTo(0, 12);
    expect(m[7]).toBeCloseTo(0, 12);
    expect(m[8]).toBeCloseTo(1, 12);
  });

  it('normalizes a non-unit quaternion instead of scaling the disk by |q|²', () => {
    const scaled = surfelBasisRef(0, 0, 5 * Math.SQRT1_2, 5 * Math.SQRT1_2);
    const unit = surfelBasisRef(0, 0, Math.SQRT1_2, Math.SQRT1_2);
    for (let i = 0; i < 9; i++) expect(scaled[i]).toBeCloseTo(unit[i]!, 12);
  });

  it('a degenerate quaternion falls back to identity, never to NaN', () => {
    const m = surfelBasisRef(0, 0, 0, 0);
    expect(Array.from(m)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('the basis stays orthonormal', () => {
    const m = surfelBasisRef(0.3, -0.2, 0.5, 0.78);
    const col = (i: number) => [m[i * 3]!, m[i * 3 + 1]!, m[i * 3 + 2]!];
    const dot = (a: number[], b: number[]) =>
      a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    for (let i = 0; i < 3; i++) expect(dot(col(i), col(i))).toBeCloseTo(1, 10);
    expect(dot(col(0), col(1))).toBeCloseTo(0, 10);
    expect(dot(col(0), col(2))).toBeCloseTo(0, 10);
    expect(dot(col(1), col(2))).toBeCloseTo(0, 10);
  });

  it('the radial Gaussian peaks at the centre and clips hard outside the disk', () => {
    const k = 9; // falloffSigmas = 3
    expect(surfelDiskWeightRef(0, 0, k)).toBe(1);
    // r = 1 sits `falloffSigmas` σ out.
    expect(surfelDiskWeightRef(1, 0, k)).toBeCloseTo(Math.exp(-4.5), 12);
    expect(surfelDiskWeightRef(0, 1, k)).toBeCloseTo(Math.exp(-4.5), 12);
    // The corners of the quad are OUTSIDE the ellipse — this is what makes the
    // footprint (and therefore the pick target) a disk and not a square.
    expect(surfelDiskWeightRef(1, 1, k)).toBe(0);
    expect(surfelDiskWeightRef(-1, -1, k)).toBe(0);
    // Isotropic in quad space: the vertex stage already applied the anisotropy.
    expect(surfelDiskWeightRef(0.6, 0, k)).toBeCloseTo(
      surfelDiskWeightRef(0, 0.6, k),
      12,
    );
  });

  it('the temporal Gaussian is centred on the sample time and symmetric', () => {
    const invSigma = 1 / 400;
    expect(surfelTemporalWeightRef(1000, 1000, invSigma)).toBe(1);
    expect(surfelTemporalWeightRef(1400, 1000, invSigma)).toBeCloseTo(
      Math.exp(-0.5),
      12,
    );
    expect(surfelTemporalWeightRef(600, 1000, invSigma)).toBeCloseTo(
      Math.exp(-0.5),
      12,
    );
    expect(surfelTemporalWeightRef(2200, 1000, invSigma)).toBeCloseTo(
      Math.exp(-4.5),
      12,
    );
  });

  it('unpacks a smallest-three quaternion back to the original rotation', () => {
    // (0, 0, √½, √½) with the LAST component dropped (imax = 3).
    const q = unpackSmallestThreeQuat(0, 0, Math.SQRT1_2, 3);
    expect(q[0]).toBeCloseTo(0, 12);
    expect(q[1]).toBeCloseTo(0, 12);
    expect(q[2]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(q[3]).toBeCloseTo(Math.SQRT1_2, 12);
    // The dropped component lands in the slot `imax` names.
    expect(unpackSmallestThreeQuat(0.1, 0.2, 0.3, 0)[0]).toBeCloseTo(
      Math.sqrt(1 - 0.01 - 0.04 - 0.09),
      12,
    );
    expect(unpackSmallestThreeQuat(0.1, 0.2, 0.3, 1)[1]).toBeCloseTo(
      Math.sqrt(1 - 0.01 - 0.04 - 0.09),
      12,
    );
    expect(unpackSmallestThreeQuat(0.1, 0.2, 0.3, 2)[2]).toBeCloseTo(
      Math.sqrt(1 - 0.01 - 0.04 - 0.09),
      12,
    );
    // Numerically-impossible input clamps rather than producing NaN.
    expect(unpackSmallestThreeQuat(1, 1, 1, 3)[3]).toBe(0);
  });
});

// ── options ─────────────────────────────────────────────────────────────────

describe('option defaults', () => {
  it('are the OFF shape: metres, window mode, no temporal term, no floor', () => {
    const layer = new STTSurfelLayer({ ...baseOpts, id: 's' } as any) as any;
    const o = layer.surfelOpts;
    expect(o.sizeUnits).toBe('meters');
    expect(o.sizeScale).toBe(1);
    expect(o.minSizePixels).toBe(0);
    expect(o.temporalSigma).toBe(0);
    expect(o.falloffSigmas).toBe(3);
    expect(o.alphaCutoff).toBe(0.01);
    expect(o.opacity).toBe(1);
    expect(o.elevationProperty).toBe('z');
    expect(o.opacityProperty).toBe('surfel_opacity');
    expect(o.extentColumns).toEqual([...SURFEL_DEFAULT_EXTENT_COLUMNS]);
    expect(layer.shaderConfig).toEqual({
      mode: 'window',
      filter: false,
      temporal: false,
    });
  });

  it('honours 0 / false through `??` rather than `||`', () => {
    const layer = new STTSurfelLayer({
      ...baseOpts,
      id: 's',
      opacity: 0,
      sizeScale: 0,
      elevationScale: 0,
      alphaCutoff: 0,
      fadeTrail: false,
      // An explicit undefined from a React prop-forwarding pattern must still
      // hit the default.
      falloffSigmas: undefined,
    } as any) as any;
    expect(layer.surfelOpts.opacity).toBe(0);
    expect(layer.surfelOpts.sizeScale).toBe(0);
    expect(layer.surfelOpts.elevationScale).toBe(0);
    expect(layer.surfelOpts.alphaCutoff).toBe(0);
    expect(layer.surfelOpts.fadeTrail).toBe(0);
    expect(layer.surfelOpts.falloffSigmas).toBe(3);
  });

  it('is a 3d layer so overlapping disks resolve by depth', () => {
    const layer = new STTSurfelLayer({ ...baseOpts, id: 's' } as any);
    expect(layer.renderingMode).toBe('3d');
  });

  it('declares pickability by implementing drawPickTile', () => {
    const layer = new STTSurfelLayer({ ...baseOpts, id: 's' } as any) as any;
    expect(typeof layer.drawPickTile).toBe('function');
  });

  it('temporalSigma is structural — crossing 0 moves the program key', () => {
    const layer = new STTSurfelLayer({ ...baseOpts, id: 's' } as any) as any;
    expect(layer.mainKey).toBe('surfel:main:window');
    layer.setTemporalSigma(250);
    expect(layer.shaderConfig.temporal).toBe(true);
    expect(layer.mainKey).toBe('surfel:main:window:temporal');
    expect(layer.pickKey).toBe('surfel:pick:window:temporal');
    layer.setTemporalSigma(0);
    expect(layer.mainKey).toBe('surfel:main:window');
  });
});

// ── tile upload ─────────────────────────────────────────────────────────────

describe('buildTileGpuCache', () => {
  it('interleaves the quaternion and the two half-extents, one row per surfel', () => {
    const gl = makeMockGl();
    const layer = makeLayer(gl);
    const tile = makeSurfelTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);

    expect(cache.instanceCount).toBe(3);
    const uploads = gl.bufferData.mock.calls.map((c: unknown[]) => c[1]);
    const quat = uploads.find(
      (u: any) => u instanceof Float32Array && u.length === 12,
    );
    expect(Array.from(quat as Float32Array).slice(0, 4)).toEqual([
      0,
      0,
      Math.fround(Math.SQRT1_2),
      Math.fround(Math.SQRT1_2),
    ]);
    const extents = uploads.find(
      (u: any) => u instanceof Float32Array && u.length === 6 && u[0] === 2,
    );
    // major/minor stay DISTINCT — the whole point of the kind.
    expect(Array.from(extents as Float32Array)).toEqual([2, 0.5, 4, 1, 6, 1.5]);
    expect(cache.quatBuffer).toBeDefined();
    expect(cache.extentBuffer).toBeDefined();
    expect(cache.elevationBuffer).toBeDefined();
    expect(cache.confidenceBuffer).toBeDefined();
    expect(cache.colorBuffer).toBeDefined();
  });

  it('resolves both metres→mercator factors at the TILE centre latitude', () => {
    const gl = makeMockGl();
    const layer = makeLayer(gl);
    const tile = makeSurfelTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    const lat = tileCenterLatitude(tile.id.z, tile.id.y);
    expect(cache.mercatorPerMeter).toBe(metersToMercatorUnits(1, lat));
    expect(cache.mercatorZPerMeter).toBe(mercatorZFromAltitude(1, lat));
    // Sanity: ~1 / (earth circumference × cos lat), i.e. tens of nano-units.
    expect(cache.mercatorPerMeter).toBeGreaterThan(1e-8);
    expect(cache.mercatorPerMeter).toBeLessThan(1e-7);
  });

  it('registers every extra buffer so the base can free them', () => {
    const gl = makeMockGl();
    const layer = makeLayer(gl, { filterProperty: 'z' });
    const tile = makeSurfelTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    for (const b of [
      cache.quatBuffer,
      cache.extentBuffer,
      cache.elevationBuffer,
      cache.confidenceBuffer,
      cache.colorBuffer,
      cache.filterBuffer,
    ]) {
      expect(cache.extraBuffers).toContain(b);
    }
  });

  it('falls back to the smallest-three PACKED quaternion columns', () => {
    const gl = makeMockGl();
    const layer = makeLayer(gl);
    const tile = makeSurfelTile();
    const props = tile.layers[0]!.features.numericProps as any;
    delete props.qx;
    delete props.qy;
    delete props.qz;
    delete props.qw;
    props.q_a = new Float32Array([0, 0, 0]);
    props.q_b = new Float32Array([0, 0, 0]);
    props.q_c = new Float32Array([Math.SQRT1_2, 0, 0]);
    props.q_imax = new Float32Array([3, 3, 3]);
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache.quatBuffer).toBeDefined();
    const quat = gl.bufferData.mock.calls
      .map((c: unknown[]) => c[1])
      .find((u: any) => u instanceof Float32Array && u.length === 12);
    // The dropped w is reconstructed as √(1 − a² − b² − c²).
    expect((quat as Float32Array)[3]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('renders un-oriented rather than blank when NO orientation was baked', () => {
    const gl = makeMockGl();
    const layer = makeLayer(gl);
    const tile = makeSurfelTile();
    tile.layers[0]!.features.numericProps = {} as any;
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache).not.toBeNull();
    expect(cache.quatBuffer).toBeUndefined();
    expect(cache.extentBuffer).toBeUndefined();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    // The identity-quaternion / constant-size path still draws every surfel.
    expect(gl.drawCalls.at(-1)).toMatchObject({
      kind: 'arrays-instanced',
      vertices: 4,
      instances: 3,
    });
    expect(uniformArgs(gl, 'uniform1f', 'uUseFeatureQuat').at(-1)).toEqual([0]);
    expect(uniformArgs(gl, 'uniform1f', 'uUseFeatureExtent').at(-1)).toEqual([
      0,
    ]);
  });
});

// ── draw ────────────────────────────────────────────────────────────────────

describe('drawTile', () => {
  it('draws ONE instanced quad per surfel', () => {
    const gl = makeMockGl();
    const layer = makeLayer(gl);
    const tile = makeSurfelTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.drawCalls).toEqual([
      { kind: 'arrays-instanced', count: 12, vertices: 4, instances: 3 },
    ]);
  });

  it('puts divisor 1 on every per-surfel attribute and 0 on the corner', () => {
    const gl = makeMockGl();
    const layer = makeLayer(gl);
    const tile = makeSurfelTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    // aCorner first (the only per-VERTEX input), then one divisor-1 call per
    // per-surfel attribute: mercator, time, quat, extent, elevation,
    // confidence, colour.
    expect(divisorSequence(gl)).toEqual([0, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('uploads TILE-RELATIVE times, never absolute ones', () => {
    const gl = makeMockGl();
    const layer = makeLayer(gl, { temporalSigma: 400 });
    const tile = makeSurfelTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    const ctx = drawCtx(legacyFrame());
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    const rel = ctx.currentTime - cache.timeOffset;
    expect(rel).toBe(1000);
    expect(uniformArgs(gl, 'uniform1f', 'uSurfelNow').at(-1)).toEqual([rel]);
    expect(uniformArgs(gl, 'uniform1f', 'uTemporalInvSigma').at(-1)).toEqual([
      1 / 400,
    ]);
  });

  it('feeds the shader METRES in both size units', () => {
    const metric = makeMockGl();
    const layerM = makeLayer(metric, { size: [3, 1] });
    const tile = makeSurfelTile();
    const cacheM = layerM.buildTileGpuCache(metric, tile, tile.layers[0]);
    layerM.drawTile(
      metric,
      tile,
      tile.layers[0],
      cacheM,
      drawCtx(legacyFrame()),
    );
    expect(uniformArgs(metric, 'uniform2f', 'uSize').at(-1)).toEqual([3, 1]);
    // 'meters' is a pure pass-through — no per-frame pixel resolve at all.
    expect(uniformArgs(metric, 'uniform1f', 'uSizeScale').at(-1)).toEqual([1]);
    expect(uniformArgs(metric, 'uniform1f', 'uMinExtentMeters').at(-1)).toEqual(
      [0],
    );

    const px = makeMockGl();
    const layerP = makeLayer(px, { sizeUnits: 'pixels', minSizePixels: 2 });
    const cacheP = layerP.buildTileGpuCache(px, tile, tile.layers[0]);
    layerP.drawTile(px, tile, tile.layers[0], cacheP, drawCtx(legacyFrame()));
    const mPerPx = layerP.metersPerPixel(px, tile, drawCtx(legacyFrame()));
    expect(mPerPx).toBeGreaterThan(0);
    expect(uniformArgs(px, 'uniform1f', 'uSizeScale').at(-1)).toEqual([mPerPx]);
    expect(uniformArgs(px, 'uniform1f', 'uMinExtentMeters').at(-1)).toEqual([
      2 * mPerPx,
    ]);
  });

  it('folds the constant colour alpha into the layer opacity, once', () => {
    const gl = makeMockGl();
    const layer = makeLayer(gl, { color: [255, 0, 0, 128], opacity: 0.5 });
    const tile = makeSurfelTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const [base] = uniformArgs(gl, 'uniform1f', 'uBaseAlpha').at(
      -1,
    ) as number[];
    expect(base).toBeCloseTo((128 / 255) * 0.5, 12);
    // 0–255 ints auto-detected, exactly as every other layer's colour prop.
    const c = uniformArgs(gl, 'uniform4fv', 'uColor').at(-1)![0] as number[];
    expect(c.slice(0, 3)).toEqual([1, 0, 0]);
  });

  it('uploads falloffSigmas SQUARED and the shared alpha cutoff', () => {
    const gl = makeMockGl();
    const layer = makeLayer(gl, { falloffSigmas: 2, alphaCutoff: 0.02 });
    const tile = makeSurfelTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(uniformArgs(gl, 'uniform1f', 'uFalloffK').at(-1)).toEqual([4]);
    expect(uniformArgs(gl, 'uniform1f', 'uAlphaCutoff').at(-1)).toEqual([0.02]);
  });

  it('links one program per host variant and re-records the VAO across the flip', () => {
    const gl = makeMockGl();
    const layer = makeLayer(gl);
    const vaos: unknown[] = [];
    layer.vaoSupport = {
      enabled: true,
      create: () => {
        const v = { id: vaos.length };
        vaos.push(v);
        return v;
      },
      bind: vi.fn(),
      delete: vi.fn(),
      current: () => null,
    };
    const tile = makeSurfelTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(vaos).toHaveLength(1);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(vaos).toHaveLength(1); // reused, not rebuilt per frame
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(v5Frame()));
    expect(layer.vaoSupport.delete).toHaveBeenCalledTimes(1);
    expect(vaos).toHaveLength(2);
  });

  it('drops the tile (once, loudly) on a runtime with no instancing', () => {
    const gl = makeMockGl();
    const layer = makeLayer(gl);
    layer.instSupport = {
      enabled: false,
      drawArraysInstanced: vi.fn(),
      drawElementsInstanced: vi.fn(),
      vertexAttribDivisor: vi.fn(),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tile = makeSurfelTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.drawCalls).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

// ── picking ─────────────────────────────────────────────────────────────────

describe('drawPickTile', () => {
  it('paints one id instance per surfel and draws the same quad', () => {
    const gl = makeMockGl();
    const layer = makeLayer(gl);
    const tile = makeSurfelTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    expect(gl.drawCalls).toEqual([
      { kind: 'arrays-instanced', count: 12, vertices: 4, instances: 3 },
    ]);
    const idColors = gl.bufferData.mock.calls
      .map((c: unknown[]) => c[1])
      .find((u: any) => u instanceof Uint8Array && u.length === 9);
    expect(idColors).toBeDefined();
    // Corner per-vertex, then 6 per-surfel attributes + the id colour.
    expect(divisorSequence(gl).slice(0, 8)).toEqual([0, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('sets the SAME sizing / gating uniforms as the visual pass', () => {
    const tile = makeSurfelTile();
    const opts = {
      falloffSigmas: 2.5,
      alphaCutoff: 0.03,
      temporalSigma: 250,
      size: [7, 2] as [number, number],
    };
    const names = [
      'uFalloffK',
      'uAlphaCutoff',
      'uBaseAlpha',
      'uSurfelNow',
      'uTemporalInvSigma',
      'uSizeScale',
      'uMinExtentMeters',
      'uMercatorPerMeter',
      'uMercatorZPerMeter',
      'uElevationScale',
      'uWindowStart',
      'uWindowEnd',
    ];

    const visualGl = makeMockGl();
    const visual = makeLayer(visualGl, opts);
    const visualCache = visual.buildTileGpuCache(
      visualGl,
      tile,
      tile.layers[0],
    );
    visual.drawTile(
      visualGl,
      tile,
      tile.layers[0],
      visualCache,
      drawCtx(legacyFrame()),
    );

    const pickGl = makeMockGl();
    const pick = makeLayer(pickGl, opts);
    const pickCache = pick.buildTileGpuCache(pickGl, tile, tile.layers[0]);
    pick.drawPickTile(
      pickGl,
      tile,
      tile.layers[0],
      pickCache,
      drawCtx(legacyFrame()),
      1,
    );

    for (const n of names) {
      expect(uniformArgs(pickGl, 'uniform1f', n).at(-1)).toEqual(
        uniformArgs(visualGl, 'uniform1f', n).at(-1),
      );
    }
    expect(uniformArgs(pickGl, 'uniform2f', 'uSize').at(-1)).toEqual([7, 2]);
  });

  it('leaves the default-VAO slate clean, divisors included', () => {
    const gl = makeMockGl();
    const layer = makeLayer(gl);
    const tile = makeSurfelTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    // Eight slots were bound: corner, mercator, time, quat, extent, elevation,
    // confidence, id colour — and all eight are disabled again.
    expect(gl.disableVertexAttribArray).toHaveBeenCalledTimes(8);
    // A divisor left at 1 on a slot the next layer uses per-vertex is invisible
    // until something else draws, so every one is reset too: 8 binds (1 corner
    // + 7 instanced) followed by 8 resets to 0.
    expect(divisorSequence(gl)).toEqual([
      0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(gl.deleteBuffer).toHaveBeenCalled();
  });
});

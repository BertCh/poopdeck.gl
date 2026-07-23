/**
 * Host render-signature dispatch tests. The recorded arg shapes are plain
 * data (no need to install four maplibre versions): maplibre v3/v4 pass a
 * positional 16-element matrix, v4.6+ append a camera-options object, v5
 * passes a single CustomRenderMethodInput-style args object, v6 adds
 * `getProjectionData`, and mapbox v3 passes the matrix plus extra positional
 * globe params (a projection-spec object first).
 */

import { describe, it, expect } from 'vitest';
import {
  createHostFrame,
  normalizeRenderArgs,
  DEFAULT_FOV_RADIANS,
} from '../src/lib/host-adapter';

// Float32 storage introduces rounding on non-representable values; compare
// element-wise with tolerance.
expect.extend({
  toBeDeepCloseTo(received: number[], expected: number[]) {
    const pass =
      received.length === expected.length &&
      received.every((v, i) => Math.abs(v - expected[i]) < 1e-6);
    return {
      pass,
      message: () =>
        `expected [${received}] to be element-wise close to [${expected}]`,
    };
  },
});

declare module 'vitest' {
  interface Assertion<T> {
    toBeDeepCloseTo(expected: number[]): T;
  }
}

const mat16 = (seed = 0): number[] =>
  Array.from({ length: 16 }, (_, i) => i + seed);

/** Recorded maplibre v5 args-object shape (CustomRenderMethodInput). */
const makeV5Args = (projectionTransition = 0, variantName = 'mercator') => ({
  farZ: 4096,
  nearZ: 0.5,
  fov: 0.6,
  modelViewProjectionMatrix: mat16(100),
  projectionMatrix: mat16(200),
  shaderData: {
    variantName,
    vertexShaderPrelude:
      'uniform mat4 u_projection_matrix;\nvec4 projectTile(vec2 p) { return u_projection_matrix * vec4(p, 0.0, 1.0); }',
    define: '#define GLOBE',
  },
  defaultProjectionData: {
    mainMatrix: mat16(1),
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0.1, 0.2, 0.3, 0.4],
    projectionTransition,
    fallbackMatrix: mat16(2),
  },
});

describe('normalizeRenderArgs — legacy hosts', () => {
  it('maplibre v3/v4: a plain 16-number array rides the legacy path', () => {
    const frame = normalizeRenderArgs(mat16(5));
    expect(frame.mode).toBe('legacy');
    expect(frame.matrix).toBeInstanceOf(Float32Array);
    expect(Array.from(frame.matrix)).toEqual(mat16(5));
    expect(frame.projectionData).toBeUndefined();
    expect(frame.shader).toEqual({
      variantName: 'legacy',
      prelude: '',
      define: '',
    });
    expect(frame.fov).toBeUndefined();
    expect(frame.nearZ).toBeUndefined();
    expect(frame.farZ).toBeUndefined();
    expect(frame.getProjectionData).toBeUndefined();
    expect(frame.isGlobe).toBe(false);
  });

  it('maplibre v4: Float32Array and Float64Array matrices both dispatch legacy', () => {
    for (const m of [new Float32Array(mat16(7)), new Float64Array(mat16(9))]) {
      const frame = normalizeRenderArgs(m);
      expect(frame.mode).toBe('legacy');
      expect(Array.from(frame.matrix)).toEqual(Array.from(m));
    }
  });

  it('maplibre v4.6/4.7: the third options arg contributes fov/nearZ/farZ (radians)', () => {
    const frame = normalizeRenderArgs(mat16(), {
      farZ: 3000,
      nearZ: 0.1,
      fov: 0.62,
      modelViewProjectionMatrix: mat16(1),
      projectionMatrix: mat16(2),
    });
    expect(frame.mode).toBe('legacy');
    expect(frame.fov).toBe(0.62);
    expect(frame.nearZ).toBe(0.1);
    expect(frame.farZ).toBe(3000);
    // Still no v5 shader machinery on a legacy host.
    expect(frame.shader.variantName).toBe('legacy');
    expect(frame.projectionData).toBeUndefined();
  });

  it("mapbox v3: matrix + positional globe params — arg3's projection spec is NOT camera options", () => {
    // mapbox calls render(gl, matrix, projection, projectionToMercatorMatrix,
    // transition, centerInMercator, pixelsPerMeterRatio); only arg2/arg3 reach
    // the adapter and the projection-spec object must not be misread as fov.
    const frame = normalizeRenderArgs(mat16(3), { name: 'mercator' });
    expect(frame.mode).toBe('legacy');
    expect(Array.from(frame.matrix)).toEqual(mat16(3));
    expect(frame.fov).toBeUndefined();
    expect(frame.nearZ).toBeUndefined();
    expect(frame.farZ).toBeUndefined();
    expect(frame.isGlobe).toBe(false);
  });
});

describe('normalizeRenderArgs — v5/v6 hosts', () => {
  it('v5: args object populates projectionData, shader and camera params', () => {
    const args = makeV5Args(0);
    const frame = normalizeRenderArgs(args);
    expect(frame.mode).toBe('v5');
    expect(frame.shader.variantName).toBe('mercator');
    expect(frame.shader.prelude).toBe(args.shaderData.vertexShaderPrelude);
    expect(frame.shader.define).toBe('#define GLOBE');
    expect(frame.fov).toBe(0.6);
    expect(frame.nearZ).toBe(0.5);
    expect(frame.farZ).toBe(4096);
    const pd = frame.projectionData!;
    expect(Array.from(pd.mainMatrix)).toEqual(mat16(1));
    expect(Array.from(pd.fallbackMatrix)).toEqual(mat16(2));
    expect(Array.from(pd.tileMercatorCoords)).toEqual([0, 0, 1, 1]);
    expect(Array.from(pd.clippingPlane)).toBeDeepCloseTo([0.1, 0.2, 0.3, 0.4]);
    expect(pd.projectionTransition).toBe(0);
    // matrix mirrors mainMatrix so legacy-matrix consumers keep working.
    expect(Array.from(frame.matrix)).toEqual(mat16(1));
    expect(frame.isGlobe).toBe(false);
    expect(frame.getProjectionData).toBeUndefined();
  });

  it('v5 globe: projectionTransition > 0 flips isGlobe', () => {
    expect(normalizeRenderArgs(makeV5Args(0.7, 'globe')).isGlobe).toBe(true);
    expect(normalizeRenderArgs(makeV5Args(1, 'globe')).isGlobe).toBe(true);
    expect(normalizeRenderArgs(makeV5Args(0)).isGlobe).toBe(false);
  });

  it('v6: getProjectionData is exposed and keeps the host args object as `this`', () => {
    const seen: unknown[] = [];
    const args = {
      ...makeV5Args(0),
      getProjectionData(params: Record<string, unknown>) {
        seen.push(this, params);
        return { ok: true };
      },
    };
    const frame = normalizeRenderArgs(args);
    expect(frame.getProjectionData).toBeTypeOf('function');
    const result = frame.getProjectionData!({ tileID: 'x' });
    expect(result).toEqual({ ok: true });
    expect(seen[0]).toBe(args);
    expect(seen[1]).toEqual({ tileID: 'x' });
  });

  it('v5 without shaderData degrades to the legacy variant (mainMatrix is the mercator MVP)', () => {
    const args = makeV5Args(0) as Record<string, unknown>;
    delete args.shaderData;
    const frame = normalizeRenderArgs(args);
    expect(frame.mode).toBe('v5');
    expect(frame.shader).toEqual({
      variantName: 'legacy',
      prelude: '',
      define: '',
    });
  });
});

describe('normalizeRenderArgs — scratch reuse', () => {
  it('reuses one frame object and its matrix storage across calls (no per-frame allocation)', () => {
    const scratch = createHostFrame();
    const matrixRef = scratch.matrix;
    const shaderRef = scratch.shader;

    const a = normalizeRenderArgs(makeV5Args(0.5, 'globe'), undefined, scratch);
    expect(a).toBe(scratch);
    expect(a.matrix).toBe(matrixRef);
    expect(a.shader).toBe(shaderRef);
    const projRef = a.projectionData!;

    const b = normalizeRenderArgs(mat16(4), undefined, scratch);
    expect(b).toBe(scratch);
    expect(b.matrix).toBe(matrixRef);
    // A legacy frame fully clears the v5 residue.
    expect(b.mode).toBe('legacy');
    expect(b.projectionData).toBeUndefined();
    expect(b.getProjectionData).toBeUndefined();
    expect(b.fov).toBeUndefined();
    expect(b.isGlobe).toBe(false);
    expect(b.shader.variantName).toBe('legacy');
    expect(b.shader.prelude).toBe('');

    // And the v5 projection struct itself is reused, not reallocated.
    const c = normalizeRenderArgs(makeV5Args(0), undefined, scratch);
    expect(c.projectionData).toBe(projRef);
  });
});

describe('DEFAULT_FOV_RADIANS', () => {
  it("matches maplibre's default 36.87° vertical fov", () => {
    expect((DEFAULT_FOV_RADIANS * 180) / Math.PI).toBeCloseTo(36.87, 2);
  });
});

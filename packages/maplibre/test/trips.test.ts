/**
 * Behaviour tests for STTTripsLayer. Same approach as layers.test.ts: drive the
 * `protected` hooks directly with a mock GL context and assert on cache shape
 * + the uniform values pushed by drawTile.
 *
 * The variant suite additionally asserts the D3 shader contract at the string
 * level: the 'legacy' variant keeps the historical uMatrix source, the v5
 * variant prepends the host prelude + define and projects via projectTile —
 * both compiled through the base per-variant program cache.
 *
 * Wave M2 adds: numeric `fadeTrail` + the `trailLength <= 0` divergence fix
 * (both parity-tested against the core oracle), wake mode, the column filter,
 * metric widths and the id-pick pass — each asserted on BOTH shader variants,
 * because a gate that only lands on one of them is a globe-only bug.
 */

import { describe, it, expect, vi } from 'vitest';
import { GeometryType, type Tile, type Layer } from '@poopdeck.gl/core';
import { encodePickId } from '@poopdeck.gl/core/picking';
import {
  trailAlpha,
  wakeAlpha,
  wakeSizeScale,
  DEFAULT_WAKE_TAIL_SCALE,
} from '@poopdeck.gl/core/time-filter';
import { STTTripsLayer } from '../src/layers/trips-layer';
import { normalizeRenderArgs } from '../src/lib/host-adapter';
import {
  trailAlphaJS,
  wakeAlphaJS,
  wakeSizeScaleJS,
} from '../src/shaders/time-window.glsl';
import { DATA_FILTER_CALL_GLSL } from '../src/shaders/data-filter.glsl';
import {
  metersToPixelsAtLatitude,
  tileCenterLatitude,
} from '../src/lib/projection';
import { makeMockGl, makeMockMap } from './mock-gl';
import { makeTripsTile } from './fixtures';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_500,
  timeWindow: 5000,
};

/** The shared recorder (which now carries the filter's `uniform2fv`). */
const makeGl = (): any => makeMockGl();

const stubInstancing = (layer: any): void => {
  layer.supports32BitIndices = true;
  layer.instSupport = {
    enabled: true,
    drawArraysInstanced: vi.fn(),
    drawElementsInstanced: vi.fn(),
    vertexAttribDivisor: vi.fn(),
  };
};

const legacyCtx = () => ({
  matrix: new Float32Array(16),
  windowStart: 0,
  windowEnd: 0,
  currentTime: baseOpts.currentTime,
  zoom: 2,
});

const ctxFor = (frame: ReturnType<typeof normalizeRenderArgs>) => ({
  ...legacyCtx(),
  matrix: frame.matrix,
  frame,
});

const mat16 = () => Array.from({ length: 16 }, (_, i) => i + 1);
const V5_PRELUDE = 'vec4 projectTile(vec2 p) { return vec4(p, 0.0, 1.0); }';
const V5_DEFINE = '#define TEST_VARIANT';
const v5Args = (variantName: string, transition = 0) => ({
  fov: 0.6,
  nearZ: 1,
  farZ: 100,
  shaderData: {
    variantName,
    vertexShaderPrelude: V5_PRELUDE,
    define: V5_DEFINE,
  },
  defaultProjectionData: {
    mainMatrix: mat16(),
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 0, 1],
    projectionTransition: transition,
    fallbackMatrix: mat16(),
  },
});

/** Most recent VISUAL vertex source handed to the recorder. */
const vertexSourceOf = (gl: any): string => {
  const calls = gl.shaderSource.mock.calls as unknown[][];
  for (let i = calls.length - 1; i >= 0; i--) {
    const src = String(calls[i][1]);
    if (src.includes('aCorner') && !src.includes('aIdColor')) return src;
  }
  return '';
};

/** Most recent ID-PASS vertex source handed to the recorder. */
const pickVertexSourceOf = (gl: any): string => {
  const calls = gl.shaderSource.mock.calls as unknown[][];
  for (let i = calls.length - 1; i >= 0; i--) {
    const src = String(calls[i][1]);
    if (src.includes('aIdColor') && src.includes('aCorner')) return src;
  }
  return '';
};

/**
 * Resolve the opaque handle the recorder minted for `name` (optionally on one
 * program), so uniform assertions name a uniform instead of pattern-matching a
 * value that several uniforms could share.
 */
const uniformHandle = (gl: any, name: string, program?: unknown): unknown => {
  const calls = gl.getUniformLocation.mock.calls as unknown[][];
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i][1] !== name) continue;
    if (program !== undefined && calls[i][0] !== program) continue;
    return gl.getUniformLocation.mock.results[i].value;
  }
  return undefined;
};

const lastArgsFor = (spy: any, handle: unknown): unknown[] | undefined => {
  const calls = spy.mock.calls as unknown[][];
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i][0] === handle) return calls[i];
  }
  return undefined;
};

const uniform1fValue = (
  gl: any,
  name: string,
  program?: unknown,
): number | undefined =>
  lastArgsFor(gl.uniform1f, uniformHandle(gl, name, program))?.[1] as
    | number
    | undefined;

const uniform2fValues = (
  gl: any,
  name: string,
  program?: unknown,
): [number, number] | undefined => {
  const args = lastArgsFor(gl.uniform2f, uniformHandle(gl, name, program));
  return args ? [args[1] as number, args[2] as number] : undefined;
};

/**
 * Last vec2 payload uploaded to `name`, from the recorder's SNAPSHOT log (the
 * filter payload is resolved in place per draw, so the raw call log aliases).
 */
const uniform2fvValue = (
  gl: any,
  name: string,
  program?: unknown,
): number[] | undefined => {
  const loc = uniformHandle(gl, name, program);
  return gl.vec2Uploads
    .filter((u: { location: unknown }) => u.location === loc)
    .at(-1)?.value;
};

/**
 * Single trip spanning most of the world at z2: mercator x span 340/360 ≈
 * 0.944. With the default granularity curve (per-tile 32 at z2 → full-square
 * 128) that subdivides into ceil(0.944 × 128) = 121 segments on globe.
 */
function makeLongTripTile(): Tile {
  const features = {
    featureCount: 1,
    geometryType: GeometryType.LineString,
    positionDimensions: 2 as const,
    positions: new Float64Array([-170, 0, 170, 0]),
    startIndices: new Uint32Array([0, 2]),
    featureIds: new Uint32Array([0]),
    startTimes: new Float32Array([0]),
    endTimes: new Float32Array([121]),
    timeOffset: 1_700_000_000_000,
    vertexTimestamps: new Float32Array([0, 121]),
    numericProps: {},
    categoricalProps: {},
  };
  const layer: Layer = {
    name: 'trips',
    extent: 4096,
    features,
    geometryExtensionName: 'geoarrow.linestring',
  };
  return {
    id: { z: 2, x: 1, y: 1, t: 1_700_000_000_000 },
    timeRange: { start: 1_700_000_000_000, end: 1_700_000_000_121 },
    layers: [layer],
  };
}

/** Trips fixture whose filter column is CATEGORICAL (not range-filterable). */
function makeCategoricalFilterTile(): Tile {
  const tile = makeTripsTile();
  tile.layers[0].features.categoricalProps.fleet = {
    indices: new Uint16Array([0, 1]),
    categories: ['a', 'b'],
  };
  return tile;
}

describe('STTTripsLayer', () => {
  it('only accepts LineString geometry', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    expect(layer.acceptsGeometry(GeometryType.Point)).toBe(false);
    expect(layer.acceptsGeometry(GeometryType.LineString)).toBe(true);
    expect(layer.acceptsGeometry(GeometryType.Polygon)).toBe(false);
  });

  it('emits one instance per segment with per-endpoint vertex times', () => {
    const layer = new STTTripsLayer({
      ...baseOpts,
      id: 't',
      trailLength: 1500,
    }) as any;
    stubInstancing(layer);
    const gl = makeGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache).not.toBeNull();
    // Path 0 has 3 verts → 2 segments, Path 1 has 2 verts → 1 segment → 3.
    expect(cache.instanceCount).toBe(3);
    expect(cache.indexCount).toBe(0);
    expect(cache.vertexTimeABBuffer).toBeDefined();
    // Per-feature instance counts drive both filter and pick-id expansion.
    expect(Array.from(cache.segmentCounts)).toEqual([2, 1]);
  });

  it('packs per-feature width and colour attributes when properties are set', () => {
    const layer = new STTTripsLayer({
      ...baseOpts,
      id: 't',
      widthProperty: 'width',
      colorProperty: 'vehicleType',
    }) as any;
    stubInstancing(layer);
    const gl = makeGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache).not.toBeNull();
    expect(cache.widthBuffer).toBeDefined();
    expect(cache.colorBuffer).toBeDefined();
  });

  it('colours categories through a keyed colorMapping', () => {
    const layer = new STTTripsLayer({
      ...baseOpts,
      id: 't',
      colorProperty: 'vehicleType',
      colorMapping: { truck: [10, 20, 30, 255], car: [40, 50, 60, 255] },
    }) as any;
    stubInstancing(layer);
    const gl = makeGl();
    const tile = makeTripsTile();
    layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    // Uploads: posA, posB, vTimeAB, dummy time, colour.
    const colours = gl.bufferData.mock.calls
      .map((c: unknown[]) => c[1])
      .find((v: unknown) => v instanceof Uint8Array) as Uint8Array;
    // Feature 0 = 'truck' (2 segments), feature 1 = 'car' (1 segment).
    expect(Array.from(colours.subarray(0, 4))).toEqual([10, 20, 30, 255]);
    expect(Array.from(colours.subarray(8, 12))).toEqual([40, 50, 60, 255]);
  });

  it('uploads currentTime relative to tile timeOffset in drawTile', () => {
    const layer = new STTTripsLayer({
      ...baseOpts,
      id: 't',
      currentTime: 1_700_000_001_500,
      trailLength: 2000,
    }) as any;
    stubInstancing(layer);
    layer.onContextReady(makeGl());
    const gl = makeGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
    // currentTime - timeOffset = 1500
    expect(uniform1fValue(gl, 'uCurrentTime')).toBe(1500);
    expect(uniform1fValue(gl, 'uTrailLength')).toBe(2000);
    // The instanced draw is routed through `instSupport.drawArraysInstanced`,
    // which the test stub above records; just verify the layer did not fall
    // back to the legacy drawElements path.
    expect(layer.instSupport.drawArraysInstanced).toHaveBeenCalledTimes(1);
    expect(gl.drawElements).not.toHaveBeenCalled();
  });
});

describe('STTTripsLayer shader variants (D3)', () => {
  it('builds the legacy uMatrix source on legacy frames', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    stubInstancing(layer);
    const gl = makeGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());

    const vs = vertexSourceOf(gl);
    expect(vs).toContain('uniform mat4 uMatrix;');
    expect(vs).toContain('uMatrix * vec4(posM, 0.0, 1.0)');
    expect(vs).toContain('uMatrix * vec4(neighborM, 0.0, 1.0)');
    expect(vs).not.toContain('projectTile(');
    // Legacy MVP goes through uMatrix.
    expect(gl.uniformMatrix4fv).toHaveBeenCalledTimes(1);
  });

  it('prepends prelude + define and projects via projectTile on v5 frames', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    stubInstancing(layer);
    const gl = makeGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    const frame = normalizeRenderArgs(v5Args('mercator'));
    const ctx = ctxFor(frame);
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);

    const vs = vertexSourceOf(gl);
    expect(vs).toContain(V5_PRELUDE);
    expect(vs).toContain(V5_DEFINE);
    expect(vs).toContain('projectTile(posM)');
    expect(vs).toContain('projectTile(neighborM)');
    expect(vs).not.toContain('uniform mat4 uMatrix');
    // Prelude before define, both before main (declaration order matters).
    expect(vs.indexOf(V5_PRELUDE)).toBeGreaterThanOrEqual(0);
    expect(vs.indexOf(V5_PRELUDE)).toBeLessThan(vs.indexOf(V5_DEFINE));
    expect(vs.indexOf(V5_DEFINE)).toBeLessThan(vs.indexOf('void main'));

    // Projection rides the prelude's u_projection_* uniforms — the legacy
    // MVP must never be pushed to a projectTile program.
    const mat4Targets = gl.uniformMatrix4fv.mock.calls.map(
      (c: unknown[]) => c[2],
    );
    expect(mat4Targets).toContain(frame.projectionData!.mainMatrix);
    expect(mat4Targets).toContain(frame.projectionData!.fallbackMatrix);
    expect(mat4Targets).not.toContain(ctx.matrix);
  });

  it('caches one program per variant across frames', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    stubInstancing(layer);
    const gl = makeGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);

    layer.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
    layer.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
    expect(gl.createProgram).toHaveBeenCalledTimes(1);

    const v5 = normalizeRenderArgs(v5Args('mercator'));
    layer.drawTile(gl, tile, tile.layers[0], cache, ctxFor(v5));
    expect(gl.createProgram).toHaveBeenCalledTimes(2);
    layer.drawTile(gl, tile, tile.layers[0], cache, ctxFor(v5));
    expect(gl.createProgram).toHaveBeenCalledTimes(2);
  });

  it('rebuilds the VAO when the program changes (variant OR time mode)', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    stubInstancing(layer);
    layer.vaoSupport = {
      enabled: true,
      create: vi.fn(() => ({ __vao: true })),
      bind: vi.fn(),
      delete: vi.fn(),
    };
    const gl = makeGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);

    layer.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
    expect(cache.vao).toBeTruthy();
    const legacyProgram = cache.vaoProgram;
    expect(legacyProgram).toBeTruthy();
    expect(layer.vaoSupport.create).toHaveBeenCalledTimes(1);

    const v5 = normalizeRenderArgs(v5Args('mercator'));
    layer.drawTile(gl, tile, tile.layers[0], cache, ctxFor(v5));
    expect(layer.vaoSupport.delete).toHaveBeenCalledTimes(1);
    expect(cache.vaoProgram).not.toBe(legacyProgram);
    expect(layer.vaoSupport.create).toHaveBeenCalledTimes(2);

    // Same variant again → recorded VAO reused, no churn.
    layer.drawTile(gl, tile, tile.layers[0], cache, ctxFor(v5));
    expect(layer.vaoSupport.create).toHaveBeenCalledTimes(2);
    expect(layer.vaoSupport.delete).toHaveBeenCalledTimes(1);

    // A time-mode flip relinks too (different program, possibly different
    // attribute slots) — the VAO must not survive it.
    layer.setWakeLength(5000);
    layer.drawTile(gl, tile, tile.layers[0], cache, ctxFor(v5));
    expect(layer.vaoSupport.delete).toHaveBeenCalledTimes(2);
    expect(layer.vaoSupport.create).toHaveBeenCalledTimes(3);
  });
});

describe('STTTripsLayer trail semantics (M2 divergence fixes)', () => {
  const drawOnce = (opts: Record<string, unknown>, ctx = legacyCtx()) => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't', ...opts }) as any;
    stubInstancing(layer);
    const gl = makeGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    return { layer, gl, tile, cache };
  };

  it('defaults fadeTrail to the classic head→tail comet (1.0)', () => {
    const { gl } = drawOnce({});
    expect(uniform1fValue(gl, 'uFadeTrail')).toBe(1);
  });

  it('accepts booleans for back-compat and numbers for deck/three parity', () => {
    expect(uniform1fValue(drawOnce({ fadeTrail: true }).gl, 'uFadeTrail')).toBe(
      1,
    );
    expect(
      uniform1fValue(drawOnce({ fadeTrail: false }).gl, 'uFadeTrail'),
    ).toBe(0);
    expect(uniform1fValue(drawOnce({ fadeTrail: 0.35 }).gl, 'uFadeTrail')).toBe(
      0.35,
    );
    // Out-of-contract values clamp rather than producing alpha > 1 / < 0.
    expect(uniform1fValue(drawOnce({ fadeTrail: 2 }).gl, 'uFadeTrail')).toBe(1);
    expect(uniform1fValue(drawOnce({ fadeTrail: -1 }).gl, 'uFadeTrail')).toBe(
      0,
    );
  });

  it('blends the trail numerically in BOTH shader variants', () => {
    const { gl } = drawOnce({});
    const v5 = normalizeRenderArgs(v5Args('globe', 1));
    const { gl: gl5 } = drawOnce({}, ctxFor(v5) as any);
    for (const vs of [vertexSourceOf(gl), vertexSourceOf(gl5)]) {
      // ONE call to the shared snippet, handed the user's CONTINUOUS fade —
      // the kernel blends internally, so no call site can re-introduce a
      // `> 0.5` threshold on it.
      expect(vs).toContain(
        'sttTrailAlpha(vertexTime, uCurrentTime, uTrailLength, uFadeTrail)',
      );
      expect(vs).not.toContain('uTrailLength, 0.0)');
      expect(vs).not.toContain('uTrailLength, 1.0)');
    }
  });

  it('matches core trailAlpha for every fade value (oracle parity)', () => {
    // The shader's expression, in JS: one kernel call with the numeric fade.
    const shaderTrailAlpha = trailAlphaJS;
    const currentTime = 1000;
    for (const trailLength of [1, 250, 1000, 5000]) {
      for (const vertexTime of [-500, 0, 250, 500, 750, 1000, 1500]) {
        for (const fade of [0, 0.25, 0.5, 0.75, 1]) {
          expect(
            shaderTrailAlpha(vertexTime, currentTime, trailLength, fade),
          ).toBeCloseTo(
            trailAlpha(currentTime, vertexTime, trailLength, fade),
            6,
          );
        }
      }
    }
  });

  it('trailLength <= 0 draws nothing (deck/core parity, not "whole past visible")', () => {
    for (const trailLength of [0, -1]) {
      const { layer } = drawOnce({ trailLength });
      expect(layer.instSupport.drawArraysInstanced).not.toHaveBeenCalled();
    }
    // Sanity: the same fixture DOES draw with a positive trail.
    const { layer } = drawOnce({ trailLength: 1000 });
    expect(layer.instSupport.drawArraysInstanced).toHaveBeenCalledTimes(1);
  });

  it('trailLength <= 0 is also unpickable (nothing visible, nothing hit)', () => {
    const layer = new STTTripsLayer({
      ...baseOpts,
      id: 't',
      trailLength: 0,
    }) as any;
    stubInstancing(layer);
    const gl = makeGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawPickTile(gl, tile, tile.layers[0], cache, legacyCtx(), 1);
    expect(layer.instSupport.drawArraysInstanced).not.toHaveBeenCalled();
    // The layer still declares picking support — the window is empty, not the
    // capability.
    expect(layer.supportsPicking()).toBe(true);
  });
});

describe('STTTripsLayer wake mode (D8)', () => {
  const drawWake = (opts: Record<string, unknown> = {}, ctx = legacyCtx()) => {
    const layer = new STTTripsLayer({
      ...baseOpts,
      id: 't',
      wakeLength: 4000,
      ...opts,
    }) as any;
    stubInstancing(layer);
    const gl = makeGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    return { layer, gl, tile, cache };
  };

  it('selects the wake snippet over trail in BOTH shader variants', () => {
    const v5 = normalizeRenderArgs(v5Args('globe', 1));
    for (const gl of [drawWake().gl, drawWake({}, ctxFor(v5) as any).gl]) {
      const vs = vertexSourceOf(gl);
      expect(vs).toContain('sttWakeAlpha(vec2(vertexTime, vertexTime)');
      expect(vs).toContain('sttWakeSizeScale(timeAlpha, uWakeTailScale)');
      expect(vs).not.toContain('sttTrailAlpha(');
    }
  });

  it('uploads the wake uniforms with the core default tail scale', () => {
    const { gl } = drawWake();
    expect(uniform1fValue(gl, 'uWakeLength')).toBe(4000);
    expect(uniform1fValue(gl, 'uWakeTailScale')).toBe(DEFAULT_WAKE_TAIL_SCALE);
    expect(
      uniform1fValue(drawWake({ wakeTailScale: 0.4 }).gl, 'uWakeTailScale'),
    ).toBe(0.4);
  });

  it('keeps a program per (variant × mode) — modes must not share a cache key', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    stubInstancing(layer);
    const gl = makeGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);

    layer.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
    expect(gl.createProgram).toHaveBeenCalledTimes(1); // legacy × trail
    layer.setWakeLength(3000);
    layer.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
    expect(gl.createProgram).toHaveBeenCalledTimes(2); // legacy × wake
    layer.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
    expect(gl.createProgram).toHaveBeenCalledTimes(2); // cached
    layer.setWakeLength(0);
    layer.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
    expect(gl.createProgram).toHaveBeenCalledTimes(2); // back to the trail program
  });

  it('matches core wakeAlpha / wakeSizeScale (oracle parity)', () => {
    const currentTime = 1000;
    for (const wakeLength of [1, 500, 4000]) {
      for (const vertexTime of [-100, 0, 500, 1000, 1200]) {
        const alpha = wakeAlphaJS(vertexTime, currentTime, wakeLength);
        expect(alpha).toBeCloseTo(
          wakeAlpha(currentTime, vertexTime, wakeLength),
          6,
        );
        expect(wakeSizeScaleJS(alpha, DEFAULT_WAKE_TAIL_SCALE)).toBeCloseTo(
          wakeSizeScale(alpha, DEFAULT_WAKE_TAIL_SCALE),
          6,
        );
      }
    }
  });
});

describe('STTTripsLayer column filter (DataFilter)', () => {
  it('splats the per-feature column across that feature’s segments', () => {
    const layer = new STTTripsLayer({
      ...baseOpts,
      id: 't',
      filterProperty: 'width',
      filterRange: [0, 10],
    }) as any;
    stubInstancing(layer);
    const gl = makeGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache.hasFilterColumn).toBe(true);
    expect(cache.filterBuffer).toBeDefined();
    // width column is [4, 6]; feature 0 makes 2 segments, feature 1 makes 1.
    const uploads = gl.bufferData.mock.calls.map((c: unknown[]) => c[1]);
    const filterAttr = uploads[uploads.length - 1] as Float32Array;
    expect(Array.from(filterAttr)).toEqual([4, 4, 6]);
  });

  it('enables the filter only with a column AND a finite range', () => {
    const withOpts = (opts: Record<string, unknown>) => {
      const layer = new STTTripsLayer({ ...baseOpts, id: 't', ...opts }) as any;
      stubInstancing(layer);
      const gl = makeGl();
      const tile = makeTripsTile();
      const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
      layer.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
      return { gl, cache };
    };
    expect(
      uniform1fValue(
        withOpts({ filterProperty: 'width', filterRange: [1, 5] }).gl,
        'uFilterEnabled',
      ),
    ).toBe(1);
    // Column bound but no range yet (slider not moved) ⇒ idle.
    expect(
      uniform1fValue(
        withOpts({ filterProperty: 'width' }).gl,
        'uFilterEnabled',
      ),
    ).toBe(0);
    // Explicitly disabled ⇒ idle, attribute still bound.
    expect(
      uniform1fValue(
        withOpts({
          filterProperty: 'width',
          filterRange: [1, 5],
          filterEnabled: false,
        }).gl,
        'uFilterEnabled',
      ),
    ).toBe(0);
  });

  it('renders UNFILTERED (never blank) when the tile lacks the column', () => {
    const layer = new STTTripsLayer({
      ...baseOpts,
      id: 't',
      filterProperty: 'nope',
      filterRange: [1, 5],
    }) as any;
    stubInstancing(layer);
    const gl = makeGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache.hasFilterColumn).toBe(false);
    expect(cache.filterBuffer).toBeUndefined();
    layer.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
    expect(uniform1fValue(gl, 'uFilterEnabled')).toBe(0);
    expect(layer.instSupport.drawArraysInstanced).toHaveBeenCalledTimes(1);
  });

  it('warns once for a categorical filter column and renders unfiltered', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = new STTTripsLayer({
      ...baseOpts,
      id: 't',
      filterProperty: 'fleet',
      filterRange: [0, 1],
    }) as any;
    stubInstancing(layer);
    const gl = makeGl();
    const tile = makeCategoricalFilterTile();
    const first = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(first.hasFilterColumn).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('categorical');
    warn.mockRestore();
  });

  it('collapses hard-filtered features and gates the fade on transformColor', () => {
    const layer = new STTTripsLayer({
      ...baseOpts,
      id: 't',
      filterProperty: 'width',
      filterRange: [1, 5],
      filterSoftRange: [2, 4],
      filterTransformColor: false,
      filterTransformSize: false,
    }) as any;
    stubInstancing(layer);
    const gl = makeGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    const v5 = normalizeRenderArgs(v5Args('mercator'));
    layer.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
    const legacyVs = vertexSourceOf(gl);
    layer.drawTile(gl, tile, tile.layers[0], cache, ctxFor(v5));
    const v5Vs = vertexSourceOf(gl);

    for (const vs of [legacyVs, v5Vs]) {
      // The canonical call, verbatim — five layers must not drift.
      expect(vs).toContain(DATA_FILTER_CALL_GLSL);
      // deck 'vs:#main-end' collapse, gated on the per-FEATURE filter value
      // only (never on the per-vertex trail alpha, which would tear the quad).
      expect(vs).toContain('if (filterAlpha <= 0.0) gl_Position = vec4(0.0);');
      expect(vs).toContain('uFilterTransformColor > 0.5');
      expect(vs).toContain('if (uFilterTransformSize > 0.5) widthPx *=');
    }
    expect(uniform1fValue(gl, 'uFilterTransformColor')).toBe(0);
    expect(uniform1fValue(gl, 'uFilterTransformSize')).toBe(0);
    // Soft bounds ride their own uniform; both default to the hard bounds.
    expect(Array.from(uniform2fvValue(gl, 'uFilterSoftRange')!)).toEqual([
      2, 4,
    ]);
    expect(Array.from(uniform2fvValue(gl, 'uFilterRange')!)).toEqual([1, 5]);
  });

  it('animates the range by uniform, but a column swap rebuilds tiles', () => {
    const layer = new STTTripsLayer({
      ...baseOpts,
      id: 't',
      filterProperty: 'width',
      filterRange: [1, 5],
    }) as any;
    stubInstancing(layer);
    layer.gl = makeGl();
    const gl = makeGl();
    const tile = makeTripsTile();
    layer.tileGpuCache.set(
      'k',
      layer.buildTileGpuCache(gl, tile, tile.layers[0]),
    );

    layer.setFilterRange([2, 3]);
    expect(layer.tileGpuCache.size).toBe(1); // uniform-only
    layer.setFilterEnabled(false);
    expect(layer.tileGpuCache.size).toBe(1);

    layer.setFilterProperty('other');
    expect(layer.tileGpuCache.size).toBe(0); // attribute changed ⇒ rebuild
  });
});

describe('STTTripsLayer metric sizing (D10 scale)', () => {
  const drawWith = (opts: Record<string, unknown>) => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't', ...opts }) as any;
    stubInstancing(layer);
    layer.map = makeMockMap(); // getZoom() → 2
    const gl = makeGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
    return gl;
  };

  it('defaults to pixel widths — uWidthScale is the raw multiplier', () => {
    const gl = drawWith({ width: 3, widthScale: 2 });
    expect(uniform1fValue(gl, 'uWidth')).toBe(3);
    expect(uniform1fValue(gl, 'uWidthScale')).toBe(2);
    // Unbounded by default (deck's 2/10 defaults would change existing looks).
    expect(uniform2fValues(gl, 'uWidthPixelRange')).toEqual([0, 1e6]);
  });

  it('folds metres→device pixels at the tile centre latitude into uWidthScale', () => {
    const gl = drawWith({ width: 50, widthScale: 1, widthUnits: 'meters' });
    const dpr =
      (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1;
    const expected = metersToPixelsAtLatitude(
      1,
      tileCenterLatitude(2, 1),
      2,
      512 * dpr,
    );
    expect(uniform1fValue(gl, 'uWidthScale')).toBeCloseTo(expected, 12);
    // The constant width stays in metres — the scale carries the conversion,
    // so a per-feature width column gets it too.
    expect(uniform1fValue(gl, 'uWidth')).toBe(50);
  });

  it('honours the pixel clamp', () => {
    const gl = drawWith({
      widthUnits: 'meters',
      width: 100,
      widthMinPixels: 1.5,
      widthMaxPixels: 12,
    });
    expect(uniform2fValues(gl, 'uWidthPixelRange')).toEqual([1.5, 12]);
  });
});

describe('STTTripsLayer picking (D11)', () => {
  const pickOnce = (opts: Record<string, unknown> = {}, idBase = 1) => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't', ...opts }) as any;
    stubInstancing(layer);
    const gl = makeGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    const before = gl.bufferData.mock.calls.length;
    layer.drawPickTile(gl, tile, tile.layers[0], cache, legacyCtx(), idBase);
    return { layer, gl, cache, before };
  };

  it('reports itself pickable', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' });
    expect(layer.supportsPicking()).toBe(true);
  });

  it('paints every segment of a feature with that FEATURE’s id colour', () => {
    const { gl, before, layer } = pickOnce({}, 7);
    const idAttr = gl.bufferData.mock.calls[before][1] as Uint8Array;
    const f0 = encodePickId(7);
    const f1 = encodePickId(8);
    // Feature 0 → 2 segments, feature 1 → 1 segment.
    expect(Array.from(idAttr)).toEqual([...f0, ...f0, ...f1]);
    expect(layer.instSupport.drawArraysInstanced).toHaveBeenCalledTimes(1);
    // One-shot buffer: freed before returning.
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(1);
  });

  it('never paints ids past the range the base reserved for this layer', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    stubInstancing(layer);
    const gl = makeGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    // Provenance reserved ids for ONE feature; the second feature's segments
    // must stay background (0) rather than aliasing the next layer's range.
    const narrowLayer = {
      ...tile.layers[0],
      features: { ...tile.layers[0].features, featureCount: 1 },
    };
    const before = gl.bufferData.mock.calls.length;
    layer.drawPickTile(gl, tile, narrowLayer, cache, legacyCtx(), 1);
    const idAttr = gl.bufferData.mock.calls[before][1] as Uint8Array;
    const f0 = encodePickId(1);
    expect(Array.from(idAttr)).toEqual([...f0, ...f0, 0, 0, 0]);
  });

  it('carries the same time + filter gates as the visual pass', () => {
    const { gl } = pickOnce({
      filterProperty: 'width',
      filterRange: [1, 5],
    });
    const vs = pickVertexSourceOf(gl);
    expect(vs).toContain('sttTrailAlpha(');
    expect(vs).toContain(DATA_FILTER_CALL_GLSL);
    expect(vs).toContain('if (filterAlpha <= 0.0) gl_Position = vec4(0.0);');
    // No colour plumbing in the id pass — just the exact id bytes.
    expect(vs).toContain('vIdColor = aIdColor;');
    expect(vs).not.toContain('uUseFeatureColor');
    const fs = gl.shaderSource.mock.calls
      .map((c: unknown[]) => String(c[1]))
      .find(
        (s: string) => s.includes('vIdColor') && s.includes('gl_FragColor'),
      );
    expect(fs).toContain('if (vAlpha <= 0.0) discard;');
  });

  it('picks through the wake program when wake mode is active', () => {
    const { gl } = pickOnce({ wakeLength: 4000 });
    const vs = pickVertexSourceOf(gl);
    expect(vs).toContain('sttWakeAlpha(');
    expect(vs).not.toContain('sttTrailAlpha(');
  });

  it('resets every per-instance divisor to 0 before returning (default-VAO hygiene)', () => {
    // Divisors are per-VAO state and survive disableVertexAttribArray. This
    // pass runs on the DEFAULT vertex array, so a leaked divisor 1 makes the
    // NEXT non-instanced draw that lands on the same attribute location read
    // element 0 for every vertex — a sibling polygon layer's fill collapses to
    // a degenerate triangle on a WebGL1 host without OES_vertex_array_object.
    // line/polygon already restore; trips was the odd one out.
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    stubInstancing(layer);
    const gl = makeGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawPickTile(gl, tile, tile.layers[0], cache, legacyCtx(), 1);

    const calls = layer.instSupport.vertexAttribDivisor.mock.calls as Array<
      [number, number]
    >;
    // Last write wins per location — every slot must end at 0.
    const final = new Map<number, number>();
    for (const [loc, divisor] of calls) final.set(loc, divisor);
    expect(final.size).toBeGreaterThan(0);
    for (const [loc, divisor] of final) {
      expect(
        divisor,
        `attribute location ${loc} left with divisor ${divisor}`,
      ).toBe(0);
    }
  });

  it('keeps the id program under its own cache key', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    stubInstancing(layer);
    const gl = makeGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(gl, tile, tile.layers[0], cache, legacyCtx());
    expect(gl.createProgram).toHaveBeenCalledTimes(1);
    layer.drawPickTile(gl, tile, tile.layers[0], cache, legacyCtx(), 1);
    expect(gl.createProgram).toHaveBeenCalledTimes(2);
    layer.drawPickTile(gl, tile, tile.layers[0], cache, legacyCtx(), 1);
    expect(gl.createProgram).toHaveBeenCalledTimes(2);
  });
});

describe('STTTripsLayer globe geometry (D4)', () => {
  it('does not subdivide off-globe', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    stubInstancing(layer);
    const gl = makeGl();
    const tile = makeLongTripTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache.instanceCount).toBe(1);
  });

  it('caches flat and globe geometry under separate keys — a transition crossing swaps, not rebuilds', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    stubInstancing(layer);
    layer.map = makeMockMap();
    const gl = makeGl();
    const tile = makeLongTripTile();

    const flat = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    expect(flat.instanceCount).toBe(1); // unsubdivided mercator geometry

    // Crossing into globe (projectionTransition > 0): a globe-keyed cache is
    // built with subdivided chords; the flat entry is retained.
    layer.frameIsGlobe = true;
    const globe = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    expect(globe).not.toBe(flat);
    expect(globe.instanceCount).toBe(121);
    expect(layer.tileGpuCache.size).toBe(2);

    // Crossing back and forth reuses whichever side exists — the automatic
    // globe⇄mercator transition boundary (~z11) swaps buffers instead of
    // re-tessellating every resident tile in one frame.
    layer.frameIsGlobe = false;
    expect(layer.ensureTileGpuCache(gl, tile, tile.layers[0])).toBe(flat);
    layer.frameIsGlobe = true;
    expect(layer.ensureTileGpuCache(gl, tile, tile.layers[0])).toBe(globe);
    expect(layer.tileGpuCache.size).toBe(2);
  });

  it('beginFrame stashes the frame globe flag; globe-built caches draw on globe frames', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    stubInstancing(layer);
    layer.map = makeMockMap();
    layer.tileset = { update: vi.fn() };
    const gl = makeGl();
    const tile = makeTripsTile();

    expect(layer.beginFrame(v5Args('globe', 1))).not.toBeNull();
    expect(layer.frameIsGlobe).toBe(true);

    const globeFrame = normalizeRenderArgs(v5Args('globe', 1));
    const cache = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(gl, tile, tile.layers[0], cache, ctxFor(globeFrame));
    expect(layer.instSupport.drawArraysInstanced).toHaveBeenCalledTimes(1);

    expect(layer.beginFrame(new Float32Array(16))).not.toBeNull();
    expect(layer.frameIsGlobe).toBe(false);
  });

  it('subdivides globe segments and interpolates vertex times in lock-step', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    stubInstancing(layer);
    layer.frameIsGlobe = true;
    const gl = makeGl();
    const tile = makeLongTripTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache.instanceCount).toBe(121);

    // Upload order: posA, posB, vTimeAB, dummy timeBuffer.
    const uploads = gl.bufferData.mock.calls.map((c: unknown[]) => c[1]);
    const posA = uploads[0] as Float32Array;
    const posB = uploads[1] as Float32Array;
    const vTimeAB = uploads[2] as Float32Array;
    expect(posA.length).toBe(242);
    expect(vTimeAB.length).toBe(242);

    // Original endpoints verbatim: mercator x of ±170°.
    expect(posA[0]).toBeCloseTo(-170 / 360 + 0.5, 6);
    expect(posB[240]).toBeCloseTo(170 / 360 + 0.5, 6);
    expect(vTimeAB[0]).toBe(0);
    expect(vTimeAB[241]).toBe(121);
    // Even spacing → time at inserted vertex k is exactly k here.
    expect(vTimeAB[1]).toBeCloseTo(1, 4);

    // Watertight chain: segment k's B endpoint is segment k+1's A endpoint,
    // in both position and time — no cracks, monotonic time along the trip.
    for (let k = 0; k < 120; k++) {
      expect(posB[k * 2]).toBe(posA[(k + 1) * 2]);
      expect(posB[k * 2 + 1]).toBe(posA[(k + 1) * 2 + 1]);
      expect(vTimeAB[k * 2 + 1]).toBe(vTimeAB[(k + 1) * 2]);
      expect(vTimeAB[k * 2 + 1]).toBeGreaterThan(vTimeAB[k * 2]);
    }

    // Interpolated times feed the SAME shared trail snippet: alpha at an
    // inserted vertex equals the linear-mapping reference.
    const trailLength = 121;
    const currentTime = 121;
    const midTime = vTimeAB[121]; // some inserted vertex's time
    expect(trailAlphaJS(midTime, currentTime, trailLength, 1)).toBeCloseTo(
      1 - (currentTime - midTime) / trailLength,
      6,
    );
  });
});

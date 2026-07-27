/**
 * Line-layer projection variants (maplibre parity campaign D3/D4), the Wave M2
 * feature axes (D8 time modes, DataFilter, metric sizing, D11 picking) and the
 * Wave M3 PATH REVEAL axis (`revealTrail`/`revealDuration`/`fadeTrail`).
 *
 * String-level: the vertex-source builder emits the legacy uMatrix shader for
 * an empty prelude and a prelude-injected `projectTile` shader for v5+ hosts,
 * compiles in exactly ONE time kernel per program, and adds the DataFilter
 * branch only when a `filterProperty` names a column — in BOTH projection
 * variants and in the id-pick pass, which shares the builder so its hit area
 * cannot drift from the drawn quad.
 * Behaviour-level (mock-gl): drawTile links one program per shader variant
 * through the base cache, sets the prelude projection uniforms on v5 frames,
 * re-records VAOs across variant flips, and globe frames build subdivided
 * tile caches keyed separately from the flat mercator entries.
 * Back-compat: an options bag with none of the new knobs must produce the
 * pre-campaign window-mode, pixel-width, filter-free draw.
 */

import { describe, it, expect, vi } from 'vitest';
import { GeometryType, type Tile } from '@poopdeck.gl/core';
import { encodePickId } from '@poopdeck.gl/core/picking';
import { synthesizeVertexTimes } from '@poopdeck.gl/core/trips';
import { DEFAULT_WAKE_TAIL_SCALE } from '@poopdeck.gl/core/time-filter';
import {
  STTLineLayer,
  buildLineVertexSource,
  revealSpanJS,
  revealVertexJS,
  resolveRevealTrailLength,
  REVEAL_PERSIST_TRAIL_MS,
  LINE_REVEAL_GLSL,
} from '../src/layers/line-layer';
import { trailAlphaJS } from '../src/shaders/time-window.glsl';
import { normalizeRenderArgs } from '../src/lib/host-adapter';
import { makeMockGl, makeMockMap, publishVisibleTiles } from './mock-gl';
import { makeLineTile, makeTripsTile } from './fixtures';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

const PRELUDE =
  'uniform mat4 u_projection_matrix;\n' +
  'vec4 projectTile(vec2 p) { return u_projection_matrix * vec4(p, 0.0, 1.0); }';

const mat16 = () => Array.from({ length: 16 }, (_, i) => i);

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

function makeLayer(extra: Record<string, unknown> = {}): any {
  const layer = new STTLineLayer({
    ...baseOpts,
    id: 'l',
    ...extra,
  } as any) as any;
  layer.supports32BitIndices = true;
  layer.instSupport = {
    enabled: true,
    drawArraysInstanced: vi.fn(),
    drawElementsInstanced: vi.fn(),
    vertexAttribDivisor: vi.fn(),
  };
  return layer;
}

const drawCtx = (frame: any) => ({
  matrix: frame.matrix,
  frame,
  windowStart: 0,
  windowEnd: 10_000,
  currentTime: baseOpts.currentTime,
  zoom: 2,
});

/**
 * Every argument list `gl[fn]` was called with for the uniform NAMED `name`.
 * The recorder hands out a distinct handle per `getUniformLocation`, so the
 * name→handle join has to go through the recorded calls/results pair.
 */
function uniformArgs(
  gl: any,
  fn: 'uniform1f' | 'uniform2f' | 'uniform2fv',
  name: string,
): unknown[][] {
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
 * The vec2 payloads uploaded to `name`, as plain number pairs. The DataFilter
 * kernel uploads its range/soft-range through `uniform2fv`, so the recorded
 * argument is one `Float32Array` rather than two scalars.
 */
function vec2Args(gl: any, name: string): number[][] {
  const handles = new Set(
    gl.getUniformLocation.mock.calls
      .map((c: unknown[], i: number) =>
        c[1] === name ? gl.getUniformLocation.mock.results[i].value : undefined,
      )
      .filter(Boolean),
  );
  return gl.vec2Uploads
    .filter((u: { location: unknown }) => handles.has(u.location))
    .map((u: { value: number[] }) => u.value);
}

/**
 * Map buffer handle → the typed array uploaded into it. `uploadArrayBuffer`
 * always binds immediately before `bufferData`, so pairing each bufferData
 * with the closest preceding bind recovers the association the cache only
 * stores handles for.
 */
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

/** Vertex sources the recorder compiled, in link order. */
const vertexSources = (gl: any): string[] =>
  gl.shaderSource.mock.calls
    .map((c: unknown[]) => c[1] as string)
    .filter((s: string) => s.includes('void main') && s.includes('aCorner'));

/** Single 2-vertex feature spanning 90° of longitude (0.25 mercator x). */
function makeLongSegmentTile(): Tile {
  const features = {
    featureCount: 1,
    geometryType: GeometryType.LineString,
    positionDimensions: 2 as const,
    positions: new Float64Array([-45, 0, 45, 0]),
    startIndices: new Uint32Array([0, 2]),
    featureIds: new Uint32Array([0]),
    startTimes: new Float32Array([0]),
    endTimes: new Float32Array([2000]),
    timeOffset: 1_700_000_000_000,
    numericProps: {},
    categoricalProps: {},
  };
  return {
    id: { z: 2, x: 1, y: 1, t: 1_700_000_000_000 },
    timeRange: { start: 1_700_000_000_000, end: 1_700_000_002_000 },
    layers: [
      {
        name: 'paths',
        extent: 4096,
        features,
        geometryExtensionName: 'geoarrow.linestring',
      },
    ],
  } as unknown as Tile;
}

describe('buildLineVertexSource', () => {
  it('legacy variant keeps the uMatrix path with nothing injected', () => {
    const src = buildLineVertexSource({ prelude: '', define: '' });
    expect(src).toContain('uniform mat4 uMatrix;');
    expect(src).toContain('uMatrix * vec4(posM, 0.0, 1.0)');
    expect(src).toContain('uMatrix * vec4(neighborM, 0.0, 1.0)');
    expect(src).not.toContain('projectTile');
    // Shared time-window include stays in both variants.
    expect(src).toContain('sttTimeWindowAlpha');
  });

  it('v5 variant prepends prelude + define and projects BOTH endpoints via projectTile', () => {
    const src = buildLineVertexSource({
      prelude: PRELUDE,
      define: '#define GLOBE',
    });
    expect(src.startsWith(PRELUDE)).toBe(true);
    // Injection order per maplibre's documented pattern: prelude, define, body.
    const defineAt = src.indexOf('#define GLOBE');
    expect(defineAt).toBeGreaterThan(src.indexOf('vec4 projectTile'));
    expect(defineAt).toBeLessThan(src.indexOf('void main'));
    // Both segment endpoints ride the prelude projection; uMatrix is gone.
    expect(src).toContain('projectTile(posM)');
    expect(src).toContain('projectTile(neighborM)');
    expect(src).not.toContain('uMatrix');
    expect(src).toContain('sttTimeWindowAlpha');
  });
});

describe('STTLineLayer per-variant programs', () => {
  it('drawTile links one program per shader variant and reuses cached ones', () => {
    const layer = makeLayer();
    const gl = makeMockGl();
    const tile = makeLineTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);

    const legacy = normalizeRenderArgs(new Float32Array(16));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacy));
    expect(gl.createProgram).toHaveBeenCalledTimes(1);
    const legacyVs = gl.shaderSource.mock.calls[0][1] as string;
    expect(legacyVs).toContain('uniform mat4 uMatrix;');
    expect(legacyVs).not.toContain('projectTile');

    // Same variant again → cached, no relink.
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacy));
    expect(gl.createProgram).toHaveBeenCalledTimes(1);

    // Variant flip → second program built from the host's injected prelude.
    const globe = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(globe));
    expect(gl.createProgram).toHaveBeenCalledTimes(2);
    const globeVs = gl.shaderSource.mock.calls
      .map((c: unknown[]) => c[1] as string)
      .find((s) => s.includes('projectTile(posM)'));
    expect(globeVs).toBeDefined();
    expect(globeVs!.startsWith(PRELUDE)).toBe(true);

    // Prelude projection uniforms were resolved + set on the v5 program.
    const looked = gl.getUniformLocation.mock.calls.map((c: unknown[]) => c[1]);
    expect(looked).toContain('u_projection_matrix');
    expect(gl.uniformMatrix4fv).toHaveBeenCalledWith(
      expect.anything(),
      false,
      globe.projectionData!.mainMatrix,
    );
  });

  it('re-records the VAO on a variant flip (attribute locations may move)', () => {
    const layer = makeLayer();
    const gl = makeMockGl();
    let vaoId = 0;
    const deleted: unknown[] = [];
    layer.vaoSupport = {
      enabled: true,
      create: vi.fn(() => ({ vao: vaoId++ })),
      bind: vi.fn(),
      delete: vi.fn((v: unknown) => deleted.push(v)),
    };
    const tile = makeLineTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);

    const legacy = normalizeRenderArgs(new Float32Array(16));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacy));
    const firstVao = cache.vao;
    expect(firstVao).toBeTruthy();
    expect(cache.vaoVariant).toBe('legacy');

    // Same variant → same VAO, no delete.
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacy));
    expect(cache.vao).toBe(firstVao);
    expect(deleted).toHaveLength(0);

    const globe = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(globe));
    expect(deleted).toContain(firstVao);
    expect(cache.vao).not.toBe(firstVao);
    expect(cache.vaoVariant).toBe('globe');
  });
});

describe('STTLineLayer globe subdivision', () => {
  it('subdivides long segments on globe frames and keys caches separately', () => {
    const layer = makeLayer();
    layer.map = makeMockMap(); // no style.projection → default granularity curve
    const gl = makeMockGl();
    const tile = makeLongSegmentTile();
    const tileLayer = tile.layers[0];

    const flat = layer.ensureTileGpuCache(gl, tile, tileLayer);
    expect(flat.instanceCount).toBe(1);

    // Default per-tile granularity at z2 is floor(128/4) = 32 → ×2² = 128
    // across the mercator square; a 0.25-span segment splits into 32 pieces.
    layer.frameIsGlobe = true;
    const globe = layer.ensureTileGpuCache(gl, tile, tileLayer);
    expect(globe).not.toBe(flat);
    expect(globe.instanceCount).toBe(32);

    // posA/posB/times are the three stride-2 uploads (32 segments × 2).
    const uploads = gl.bufferData.mock.calls
      .map((c: unknown[]) => c[1])
      .filter((a: unknown) => a instanceof Float32Array && a.length === 64);
    expect(uploads).toHaveLength(3);
    const [posA, posB, times] = uploads as Float32Array[];
    // Original endpoints survive; pieces are even; consecutive segments chain.
    expect(posA[0]).toBeCloseTo(0.375, 6);
    expect(posB[63 - 1]).toBeCloseTo(0.625, 6);
    expect(posB[0]).toBeCloseTo(posA[2], 6);
    expect(posB[0] - posA[0]).toBeCloseTo(0.25 / 32, 6);
    // Per-feature times broadcast to every subdivided segment.
    expect(times[0]).toBe(0);
    expect(times[1]).toBe(2000);
    expect(times[62]).toBe(0);
    expect(times[63]).toBe(2000);

    // Both entries coexist: flipping projection reuses either side unrebuilt.
    layer.frameIsGlobe = false;
    expect(layer.ensureTileGpuCache(gl, tile, tileLayer)).toBe(flat);
    layer.frameIsGlobe = true;
    expect(layer.ensureTileGpuCache(gl, tile, tileLayer)).toBe(globe);
    expect(layer.tileGpuCache.size).toBe(2);
  });

  it('honors a host-supplied subdivisionGranularity object', () => {
    const layer = makeLayer();
    layer.map = makeMockMap();
    layer.map.style = {
      projection: {
        subdivisionGranularity: {
          tile: { getGranularityForZoomLevel: () => 4 },
        },
      },
    };
    layer.frameIsGlobe = true;
    const gl = makeMockGl();
    const tile = makeLongSegmentTile();
    // Host per-tile granularity 4 → ×2² = 16 total → 0.25 span = 4 pieces.
    const cache = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache.instanceCount).toBe(4);
  });

  it('beginFrame stashes the frame globe flag for cache building', () => {
    const layer = makeLayer();
    layer.map = makeMockMap();
    // No tiles: this exercises beginFrame's frame plumbing, and beginFrame now
    // derives the drawn set from the tileset, so the stub must answer for it.
    publishVisibleTiles(layer);

    const frame = layer.beginFrame(v5Args('globe', 1), undefined);
    expect(frame.isGlobe).toBe(true);
    expect(layer.frameIsGlobe).toBe(true);

    layer.beginFrame(new Float32Array(16), undefined);
    expect(layer.frameIsGlobe).toBe(false);
  });
});

// ── Wave M2: time modes (D8) ────────────────────────────────────────────────

describe('buildLineVertexSource time modes', () => {
  const kernels = {
    window: 'sttTimeWindowAlpha',
    wake: 'sttWakeAlpha',
    cumulative: 'sttCumulativeAlpha',
    trail: 'sttTrailAlpha',
  } as const;

  for (const [mode, fn] of Object.entries(kernels)) {
    it(`${mode} compiles in its kernel and no other`, () => {
      const src = buildLineVertexSource(
        { prelude: '', define: '' },
        { mode: mode as any },
      );
      expect(src).toContain(fn);
      for (const [other, otherFn] of Object.entries(kernels)) {
        if (other === mode) continue;
        expect(src).not.toContain(otherFn);
      }
    });
  }

  it('window mode is the default and keeps the pre-campaign uniforms', () => {
    const explicit = buildLineVertexSource(
      { prelude: '', define: '' },
      { mode: 'window' },
    );
    expect(buildLineVertexSource({ prelude: '', define: '' })).toBe(explicit);
    expect(explicit).toContain('uniform float uWindowStart;');
    expect(explicit).toContain('uniform float uWindowEnd;');
    expect(explicit).toContain(
      'sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut)',
    );
    // No mode uniform: the mode is a compile-time choice.
    expect(explicit).not.toContain('uCurrentTime');
  });

  it('wake drives both the alpha and the tail width from one alpha', () => {
    const src = buildLineVertexSource(
      { prelude: '', define: '' },
      { mode: 'wake' },
    );
    expect(src).toContain(
      'float timeAlpha = sttWakeAlpha(aTime, uCurrentTime, uWakeLength);',
    );
    expect(src).toContain('* sttWakeSizeScale(timeAlpha, uWakeTailScale)');
    expect(src).toContain('uniform float uWakeTailScale;');
  });

  it('cumulative reuses uFadeIn as the appear ramp', () => {
    const src = buildLineVertexSource(
      { prelude: '', define: '' },
      { mode: 'cumulative' },
    );
    expect(src).toContain('sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn)');
    expect(src).toContain('uniform float uFadeIn;');
    expect(src).not.toContain('uFadeOut');
  });

  it('trail swaps the per-feature time attribute for per-vertex endpoints', () => {
    const src = buildLineVertexSource(
      { prelude: '', define: '' },
      { mode: 'trail' },
    );
    expect(src).toContain('attribute vec2 aVertexTimeAB;');
    expect(src).not.toContain('attribute vec2 aTime;');
    expect(src).toContain(
      'sttTrailAlpha(mix(aVertexTimeAB.x, aVertexTimeAB.y, aCorner.y), uCurrentTime, uTrailLength, uFadeTrail)',
    );
  });

  it('carries the mode identically into the v5 prelude variant', () => {
    for (const mode of Object.keys(kernels)) {
      const legacy = buildLineVertexSource(
        { prelude: '', define: '' },
        { mode: mode as any },
      );
      const v5 = buildLineVertexSource(
        { prelude: PRELUDE, define: '#define GLOBE' },
        { mode: mode as any },
      );
      expect(v5.startsWith(PRELUDE)).toBe(true);
      expect(v5).toContain('projectTile(posM)');
      expect(v5).not.toContain('uniform mat4 uMatrix;');
      // Everything below the projection swap is byte-identical.
      const body = (s: string) => s.slice(s.indexOf('float timeAlpha'));
      expect(body(v5)).toBe(body(legacy));
    }
  });
});

describe('STTLineLayer time-mode wiring', () => {
  const tileRelative = (tile: Tile) =>
    baseOpts.currentTime - tile.layers[0].features.timeOffset;

  it('defaults to window mode and sets only the window uniforms', () => {
    const layer = makeLayer();
    const gl = makeMockGl();
    const tile = makeLineTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))),
    );
    expect(layer.lineOpts.timeFilterMode).toBe('window');
    expect(uniformArgs(gl, 'uniform1f', 'uWindowStart')).toEqual([[0]]);
    expect(uniformArgs(gl, 'uniform1f', 'uWindowEnd')).toEqual([[10_000]]);
    expect(uniformArgs(gl, 'uniform1f', 'uCurrentTime')).toEqual([]);
  });

  it('wake sets tile-relative time, length and the core tail scale', () => {
    const layer = makeLayer({ timeFilterMode: 'wake' });
    const gl = makeMockGl();
    const tile = makeLineTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))),
    );
    expect(uniformArgs(gl, 'uniform1f', 'uCurrentTime')).toEqual([
      [tileRelative(tile)],
    ]);
    // Default wake length is the trailing half of the loading window.
    expect(uniformArgs(gl, 'uniform1f', 'uWakeLength')).toEqual([
      [baseOpts.timeWindow / 2],
    ]);
    expect(uniformArgs(gl, 'uniform1f', 'uWakeTailScale')).toEqual([
      [DEFAULT_WAKE_TAIL_SCALE],
    ]);
    expect(uniformArgs(gl, 'uniform1f', 'uWindowStart')).toEqual([]);
  });

  it('cumulative sets the fade-in ramp resolved by the shared policy', () => {
    const layer = makeLayer({
      timeFilterMode: 'cumulative',
      fadeInDuration: 750,
    });
    const gl = makeMockGl();
    const tile = makeLineTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))),
    );
    expect(uniformArgs(gl, 'uniform1f', 'uCurrentTime')).toEqual([
      [tileRelative(tile)],
    ]);
    expect(uniformArgs(gl, 'uniform1f', 'uFadeIn')).toEqual([[750]]);
  });

  it('trail sets length + fade flag and binds the per-vertex time buffer', () => {
    const layer = makeLayer({ timeFilterMode: 'trail', fadeTrail: false });
    const gl = makeMockGl();
    const tile = makeLineTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))),
    );
    expect(uniformArgs(gl, 'uniform1f', 'uTrailLength')).toEqual([
      [baseOpts.timeWindow / 2],
    ]);
    expect(uniformArgs(gl, 'uniform1f', 'uFadeTrail')).toEqual([[0]]);
    expect(cache.vertexTimeBuffer).toBeTruthy();
    const bound = gl.bindBuffer.mock.calls.map((c: unknown[]) => c[1]);
    expect(bound).toContain(cache.vertexTimeBuffer);
  });

  it('bakes per-vertex times only in trail mode, from the tile when present', () => {
    const windowLayer = makeLayer();
    const glW = makeMockGl();
    const lineTile = makeLineTile();
    const windowCache = windowLayer.buildTileGpuCache(
      glW,
      lineTile,
      lineTile.layers[0],
    );
    expect(windowCache.vertexTimeBuffer).toBeUndefined();

    // No vertexTimestamps → the SHARED synthesizeVertexTimes kernel, which
    // spreads [startTime, endTime] by cumulative haversine DISTANCE (not by
    // vertex index — a long leg must not advance at a short leg's rate). Path 0
    // is NYC→Boston→Maine over [0, 2000]: Boston sits ~57.6% of the way along,
    // so its time is ~1151 ms, NOT the index ramp's 1000.
    const trailLayer = makeLayer({ timeFilterMode: 'trail' });
    const glT = makeMockGl();
    const trailCache = trailLayer.buildTileGpuCache(
      glT,
      lineTile,
      lineTile.layers[0],
    );
    const synthesized = Array.from(
      uploadsByBuffer(glT).get(trailCache.vertexTimeBuffer) as Float32Array,
    );
    // Per-SEGMENT [tA, tB] pairs: seg(v0,v1), seg(v1,v2) of path 0, then path 1.
    expect(synthesized[0]).toBe(0);
    expect(synthesized[1]).toBeCloseTo(1151.31, 1);
    expect(synthesized[2]).toBeCloseTo(1151.31, 1);
    expect(synthesized[3]).toBe(2000);
    expect(synthesized.slice(4)).toEqual([1000, 3000]);

    // Baked vertexTimestamps win over the ramp.
    const glB = makeMockGl();
    const tripsTile = makeTripsTile();
    const bakedCache = trailLayer.buildTileGpuCache(
      glB,
      tripsTile,
      tripsTile.layers[0],
    );
    expect(
      Array.from(
        uploadsByBuffer(glB).get(bakedCache.vertexTimeBuffer) as Float32Array,
      ),
    ).toEqual([0, 1000, 1000, 2000, 0, 1500]);
  });

  it('setTimeFilterMode rebuilds tile caches only when trail-ness flips', () => {
    const layer = makeLayer();
    const gl = makeMockGl();
    layer.gl = gl;
    layer.map = makeMockMap();
    const tile = makeLineTile();
    layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    expect(layer.tileGpuCache.size).toBe(1);

    layer.setTimeFilterMode('wake'); // uniform+program change only
    expect(layer.tileGpuCache.size).toBe(1);

    layer.setTimeFilterMode('trail'); // needs per-vertex times
    expect(layer.tileGpuCache.size).toBe(0);
  });

  it('re-records the VAO when the mode flips (a different program)', () => {
    const layer = makeLayer();
    const gl = makeMockGl();
    let vaoId = 0;
    const deleted: unknown[] = [];
    layer.vaoSupport = {
      enabled: true,
      create: vi.fn(() => ({ vao: vaoId++ })),
      bind: vi.fn(),
      delete: vi.fn((v: unknown) => deleted.push(v)),
    };
    const tile = makeLineTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    const ctx = drawCtx(normalizeRenderArgs(new Float32Array(16)));
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    const firstVao = cache.vao;
    expect(cache.vaoMode).toBe('window');

    layer.lineOpts.timeFilterMode = 'wake';
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    expect(deleted).toContain(firstVao);
    expect(cache.vaoMode).toBe('wake');
  });
});

// ── Wave M2: DataFilter ─────────────────────────────────────────────────────

describe('buildLineVertexSource DataFilter branch', () => {
  it('compiles nothing filter-related without a filterProperty', () => {
    const src = buildLineVertexSource({ prelude: '', define: '' });
    expect(src).not.toContain('aFilterValue');
    expect(src).not.toContain('uFilterRange');
    expect(src).not.toContain('sttDataFilterAlpha');
    expect(src).toContain('vAlpha = timeAlpha;');
  });

  it('splices the kernel, its declarations and the canonical call', () => {
    const src = buildLineVertexSource(
      { prelude: '', define: '' },
      { filter: true },
    );
    expect(src).toContain('attribute float aFilterValue;');
    expect(src).toContain('uniform vec2 uFilterRange;');
    expect(src).toContain('uniform vec2 uFilterSoftRange;');
    expect(src).toContain('float sttDataFilterAlpha(');
    expect(src).toContain(
      'sttDataFilterAlpha(aFilterValue, uFilterRange, uFilterSoftRange, uFilterEnabled > 0.5)',
    );
    // Width shrink is gated; alpha fade is gated; a zero factor hides the
    // feature under EITHER flag (deck parity) and collapses its geometry.
    expect(src).toContain(
      'if (uFilterTransformSize > 0.5) widthPx *= filterAlpha;',
    );
    expect(src).toContain('if (filterAlpha <= 0.0) gl_Position = vec4(0.0);');
    expect(src).toContain('vAlpha = timeAlpha * filterMask;');
    expect(src).toContain('(filterAlpha > 0.0 ? 1.0 : 0.0)');
  });

  it('collapses on the per-feature factor, never on the per-vertex trail alpha', () => {
    const src = buildLineVertexSource(
      { prelude: '', define: '' },
      { filter: true, mode: 'trail' },
    );
    expect(src).toContain('if (filterAlpha <= 0.0) gl_Position = vec4(0.0);');
    expect(src).not.toContain('if (timeAlpha <= 0.0) gl_Position');
    expect(src).not.toContain('if (vAlpha <= 0.0) gl_Position');
  });

  it('is present in the v5 prelude variant too', () => {
    const src = buildLineVertexSource(
      { prelude: PRELUDE, define: '#define GLOBE' },
      { filter: true },
    );
    expect(src).toContain('sttDataFilterAlpha(aFilterValue');
    expect(src).toContain('projectTile(posM)');
  });
});

describe('STTLineLayer DataFilter wiring', () => {
  it('expands the per-feature column across each feature’s segments', () => {
    const layer = makeLayer({ filterProperty: 'width' });
    const gl = makeMockGl();
    const tile = makeTripsTile(); // 2 features → 2 + 1 segments, width [4, 6]
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache.instanceCount).toBe(3);
    expect(cache.hasFilterColumn).toBe(true);
    expect(Array.from(cache.featureSegmentCounts)).toEqual([2, 1]);
    expect(
      Array.from(uploadsByBuffer(gl).get(cache.filterBuffer) as Float32Array),
    ).toEqual([4, 4, 6]);
  });

  it('renders UNFILTERED when the tile lacks the column', () => {
    const layer = makeLayer({ filterProperty: 'nope', filterRange: [0, 1] });
    const gl = makeMockGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache.hasFilterColumn).toBe(false);
    expect(cache.filterBuffer).toBeUndefined();
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))),
    );
    expect(uniformArgs(gl, 'uniform1f', 'uFilterEnabled')).toEqual([[0]]);
  });

  it('warns once for a categorical column and keeps rendering', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layer = makeLayer({ filterProperty: 'vehicleType' });
      const gl = makeMockGl();
      const tile = makeTripsTile();
      const first = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
      layer.buildTileGpuCache(gl, tile, tile.layers[0]);
      expect(first.hasFilterColumn).toBe(false);
      expect(first.instanceCount).toBe(3);
      expect(
        warn.mock.calls.filter((c) => String(c[0]).includes('categorical')),
      ).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('uploads the resolved range/soft-range/flags per draw', () => {
    const layer = makeLayer({
      filterProperty: 'width',
      filterRange: [3, 7],
      filterSoftRange: [4, 6],
      filterTransformSize: false,
    });
    const gl = makeMockGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))),
    );
    expect(vec2Args(gl, 'uFilterRange')).toEqual([[3, 7]]);
    expect(vec2Args(gl, 'uFilterSoftRange')).toEqual([[4, 6]]);
    expect(uniformArgs(gl, 'uniform1f', 'uFilterEnabled')).toEqual([[1]]);
    expect(uniformArgs(gl, 'uniform1f', 'uFilterTransformSize')).toEqual([[0]]);
    expect(uniformArgs(gl, 'uniform1f', 'uFilterTransformColor')).toEqual([
      [1],
    ]);
  });

  it('setFilterRange is uniform-only (no relink, no cache rebuild)', () => {
    const layer = makeLayer({ filterProperty: 'width', filterRange: [0, 10] });
    const gl = makeMockGl();
    layer.gl = gl;
    layer.map = makeMockMap();
    const tile = makeTripsTile();
    const cache = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    const ctx = drawCtx(normalizeRenderArgs(new Float32Array(16)));
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    const programs = gl.createProgram.mock.calls.length;

    layer.setFilterRange([5, 6]);
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    expect(gl.createProgram.mock.calls.length).toBe(programs);
    expect(layer.tileGpuCache.size).toBe(1);
    expect(vec2Args(gl, 'uFilterRange')).toEqual([
      [0, 10],
      [5, 6],
    ]);

    layer.setFilterEnabled(false);
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    expect(uniformArgs(gl, 'uniform1f', 'uFilterEnabled')).toEqual([
      [1],
      [1],
      [0],
    ]);
  });
});

// ── Wave M2: metric sizing ──────────────────────────────────────────────────

describe('STTLineLayer widthUnits', () => {
  const drawAndReadWidthScale = (layer: any, tile: Tile): number => {
    const gl = makeMockGl();
    layer.map = makeMockMap(); // getZoom() === 2, no canvas → dpr 1
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))),
    );
    return uniformArgs(gl, 'uniform1f', 'uWidthScale')[0][0] as number;
  };

  it('defaults to pixels and passes widthScale through untouched', () => {
    const layer = makeLayer({ widthScale: 3 });
    expect(layer.lineOpts.widthUnits).toBe('pixels');
    expect(drawAndReadWidthScale(layer, makeLineTile())).toBe(3);
  });

  it('meters folds metres→device-px at the tile centre latitude and map zoom', () => {
    const layer = makeLayer({ widthUnits: 'meters', widthScale: 2 });
    const tile = makeLineTile(); // z2 / y1
    // Independent re-derivation of maplibre's own metres→pixels:
    //   lat  = inverse mercator of the tile-row centre
    //   px/m = 1 / (earthCircumference · cos lat) · worldSize
    const mercY = (tile.id.y + 0.5) / 2 ** tile.id.z;
    const lat =
      (2 * Math.atan(Math.exp((0.5 - mercY) * 2 * Math.PI)) - Math.PI / 2) *
      (180 / Math.PI);
    const circumference = 2 * Math.PI * 6371008.8;
    const worldSize = 512 * 2 ** 2; // zoom 2, dpr 1
    const expected =
      (worldSize / (circumference * Math.cos((lat * Math.PI) / 180))) * 2;
    expect(drawAndReadWidthScale(layer, tile)).toBeCloseTo(expected, 12);
  });

  it('scales metric widths with the device pixel ratio', () => {
    const layer = makeLayer({ widthUnits: 'meters' });
    const gl = makeMockGl();
    layer.map = makeMockMap();
    // drawingBufferWidth 1024 over a 512 CSS-px canvas ⇒ dpr 2.
    layer.map.getCanvas = () => ({ clientWidth: 512 });
    const tile = makeLineTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))),
    );
    const dpr2 = uniformArgs(gl, 'uniform1f', 'uWidthScale')[0][0] as number;
    const dpr1 = drawAndReadWidthScale(
      makeLayer({ widthUnits: 'meters' }),
      makeLineTile(),
    );
    expect(dpr2 / dpr1).toBeCloseTo(2, 10);
  });

  it('uses the FRACTIONAL map zoom, not the floored ctx zoom', () => {
    const layer = makeLayer({ widthUnits: 'meters' });
    const gl = makeMockGl();
    layer.map = makeMockMap();
    layer.map.getZoom = () => 2.5;
    const tile = makeLineTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))), // ctx.zoom === 2
    );
    const half = uniformArgs(gl, 'uniform1f', 'uWidthScale')[0][0] as number;
    const flat = drawAndReadWidthScale(
      makeLayer({ widthUnits: 'meters' }),
      makeLineTile(),
    );
    expect(half / flat).toBeCloseTo(Math.SQRT2, 10);
  });
});

// ── Wave M2: picking (D11) ──────────────────────────────────────────────────

describe('STTLineLayer picking', () => {
  it('advertises picking through the base hook', () => {
    expect(makeLayer().supportsPicking()).toBe(true);
  });

  it('id pass shares the visual extrusion math, swapping colour for id', () => {
    const visual = buildLineVertexSource({ prelude: '', define: '' });
    const pick = buildLineVertexSource(
      { prelude: '', define: '' },
      { pick: true },
    );
    expect(pick).toContain('attribute vec3 aIdColor;');
    expect(pick).toContain('vIdColor = aIdColor;');
    expect(pick).not.toContain('aColor');
    expect(pick).not.toContain('uUseFeatureColor');
    // Everything from the quad expansion through the alpha gate is identical,
    // so an invisible feature is unpickable and the hit area is the drawn area.
    const geometry = (s: string) =>
      s.slice(s.indexOf('void main'), s.indexOf('vAlpha = timeAlpha'));
    expect(geometry(pick)).toBe(geometry(visual));
    expect(pick).toContain('float timeAlpha = sttTimeWindowAlpha(');
  });

  it('links its own program and expands ids across each feature’s segments', () => {
    const layer = makeLayer();
    const gl = makeMockGl();
    const tile = makeTripsTile(); // features → 2 + 1 segments
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    const ctx = drawCtx(normalizeRenderArgs(new Float32Array(16)));
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    expect(gl.createProgram).toHaveBeenCalledTimes(1);

    layer.drawPickTile(gl, tile, tile.layers[0], cache, ctx, 1);
    // The pick pass is a second program (different key), not a reuse.
    expect(gl.createProgram).toHaveBeenCalledTimes(2);
    const idSource = vertexSources(gl).find((s) => s.includes('aIdColor'));
    expect(idSource).toBeDefined();

    const idBytes = [...encodePickId(1), ...encodePickId(2)];
    const uploaded = [...uploadsByBuffer(gl).values()].find(
      (a) => a instanceof Uint8Array && a.length === 9,
    ) as Uint8Array;
    expect(Array.from(uploaded)).toEqual([
      idBytes[0],
      idBytes[1],
      idBytes[2], // feature 0, segment 0
      idBytes[0],
      idBytes[1],
      idBytes[2], // feature 0, segment 1
      idBytes[3],
      idBytes[4],
      idBytes[5], // feature 1
    ]);
    // One instance per segment, same instancing as the visual pass.
    expect(layer.instSupport.drawArraysInstanced).toHaveBeenLastCalledWith(
      0x0005,
      0,
      4,
      3,
    );
  });

  it('applies the same time and filter gates in the id pass', () => {
    const layer = makeLayer({
      timeFilterMode: 'wake',
      filterProperty: 'width',
      filterRange: [5, 7],
    });
    const gl = makeMockGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))),
      1,
    );
    expect(uniformArgs(gl, 'uniform1f', 'uWakeLength')).toEqual([
      [baseOpts.timeWindow / 2],
    ]);
    expect(vec2Args(gl, 'uFilterRange')).toEqual([[5, 7]]);
    expect(uniformArgs(gl, 'uniform1f', 'uFilterEnabled')).toEqual([[1]]);
    const idSource = vertexSources(gl).find((s) => s.includes('aIdColor'))!;
    expect(idSource).toContain(
      'sttWakeAlpha(aTime, uCurrentTime, uWakeLength)',
    );
    expect(idSource).toContain('sttDataFilterAlpha(aFilterValue');
  });

  it('projects the id pass through the v5 prelude like the visual pass', () => {
    const layer = makeLayer();
    const gl = makeMockGl();
    const tile = makeLineTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    const globe = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawPickTile(gl, tile, tile.layers[0], cache, drawCtx(globe), 1);
    const idSource = vertexSources(gl).find((s) => s.includes('aIdColor'))!;
    expect(idSource.startsWith(PRELUDE)).toBe(true);
    expect(idSource).toContain('projectTile(posM)');
    expect(gl.uniformMatrix4fv).toHaveBeenCalledWith(
      expect.anything(),
      false,
      globe.projectionData!.mainMatrix,
    );
  });
});

// ── Wave M2: back-compat ────────────────────────────────────────────────────

describe('STTLineLayer defaults are the pre-campaign behaviour', () => {
  it('keeps every new knob off unless asked for', () => {
    const layer = makeLayer();
    expect(layer.lineOpts).toMatchObject({
      timeFilterMode: 'window',
      widthUnits: 'pixels',
      widthScale: 1,
      width: 2,
      // Resolved through the package-wide `resolveTrailFade` (boolean in,
      // continuous 0..1 weight out).
      fadeTrail: 1,
      wakeTailScale: DEFAULT_WAKE_TAIL_SCALE,
    });
    expect(layer.lineOpts.filterProperty).toBeUndefined();
    expect(layer.lineOpts.filterRange).toBeUndefined();
  });

  it('draws the historical program: window mode, no filter, pixel widths', () => {
    const layer = makeLayer();
    const gl = makeMockGl();
    const tile = makeLineTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))),
    );
    const vs = vertexSources(gl)[0];
    expect(vs).toContain('uniform mat4 uMatrix;');
    expect(vs).toContain('sttTimeWindowAlpha(aTime');
    expect(vs).not.toContain('aFilterValue');
    expect(vs).not.toContain('sttWakeSizeScale');
    expect(uniformArgs(gl, 'uniform1f', 'uWidthScale')).toEqual([[1]]);
    expect(vec2Args(gl, 'uFilterRange')).toEqual([]);
    expect(cache.filterBuffer).toBeUndefined();
    expect(cache.vertexTimeBuffer).toBeUndefined();
  });
});

// ── Wave M3: path reveal (revealTrail / revealDuration / fadeTrail) ─────────

/** Per-instance [timeA, timeB] the cache baked, as a plain array. */
function vertexTimePairs(gl: any, cache: any): number[] {
  return Array.from(
    uploadsByBuffer(gl).get(cache.vertexTimeBuffer) as Float32Array,
  );
}

describe('buildLineVertexSource path reveal', () => {
  const revealSrc = (shader = { prelude: '', define: '' }, extra = {}) =>
    buildLineVertexSource(shader, { mode: 'reveal', ...extra } as any);

  it('is absent from every other mode — the default source is untouched', () => {
    for (const mode of [undefined, 'window', 'wake', 'cumulative', 'trail']) {
      const src = buildLineVertexSource(
        { prelude: '', define: '' },
        mode === undefined ? {} : ({ mode } as any),
      );
      expect(src).not.toContain('sttRevealSpan');
      expect(src).not.toContain('revealAlong');
      expect(src).not.toContain('revealVisible');
      // The historical endpoint pick survives verbatim.
      expect(src).toContain('vec2 posM = mix(aPosA, aPosB, aCorner.y);');
    }
  });

  it('builds in BOTH host variants, clipping the drawn endpoint', () => {
    const legacy = revealSrc();
    expect(legacy).toContain('uniform mat4 uMatrix;');
    expect(legacy).toContain('uMatrix * vec4(posM, 0.0, 1.0)');
    expect(legacy).not.toContain('projectTile');

    const v5 = revealSrc({ prelude: PRELUDE, define: '#define GLOBE' });
    expect(v5.startsWith(PRELUDE)).toBe(true);
    expect(v5).toContain('projectTile(posM)');
    expect(v5).toContain('projectTile(neighborM)');
    expect(v5).not.toContain('uniform mat4 uMatrix;');

    for (const src of [legacy, v5]) {
      // The frontier: the drawn point is INTERPOLATED along the segment, not
      // snapped to A or B.
      expect(src).toContain('vec2 posM = mix(aPosA, aPosB, revealAlong);');
      expect(src).toContain(
        'float revealAlong = mix(revealSpan.x, revealSpan.y, aCorner.y);',
      );
      expect(src).toContain(
        'vec2 revealSpan = sttRevealSpan(aVertexTimeAB, uCurrentTime, uTrailLength);',
      );
      expect(src).toContain(LINE_REVEAL_GLSL.trim());
    }
    // Everything below the projection swap is byte-identical across variants.
    const body = (s: string) => s.slice(s.indexOf('float timeAlpha'));
    expect(body(v5)).toBe(body(legacy));
  });

  it('keeps the NEIGHBOUR unclipped (the direction must stay conditioned)', () => {
    // The neighbour only feeds the segment direction; clipping both ends would
    // make the perpendicular unstable exactly at the frontier.
    expect(revealSrc()).toContain(
      'vec2 neighborM = mix(aPosB, aPosA, aCorner.y);',
    );
  });

  it('collapses a segment outside the window on a PER-INSTANCE factor', () => {
    const src = revealSrc();
    expect(src).toContain('if (revealVisible <= 0.0) gl_Position = vec4(0.0);');
    // Never on the per-VERTEX time alpha, which would strand one end of the
    // quad at the origin (the same rule the DataFilter collapse follows).
    expect(src).not.toContain('if (timeAlpha <= 0.0) gl_Position');
    expect(src).not.toContain('if (vAlpha <= 0.0) gl_Position');
  });

  it('reads the per-VERTEX time attribute and the trail uniform trio', () => {
    const src = revealSrc();
    expect(src).toContain('attribute vec2 aVertexTimeAB;');
    expect(src).not.toContain('attribute vec2 aTime;');
    expect(src).toContain('uniform float uCurrentTime;');
    expect(src).toContain('uniform float uTrailLength;');
    expect(src).toContain('uniform float uFadeTrail;');
    // Window-mode uniforms are gone: the mode is compiled, never branched.
    expect(src).not.toContain('uWindowStart');
    expect(src).not.toContain('uWakeLength');
  });

  it('samples the alpha at the CLIPPED time, clamped into the reveal window', () => {
    const src = revealSrc();
    // Reuses the shared trail kernel — one fade formula package-wide.
    expect(src).toContain('float sttTrailAlpha(');
    expect(src).toContain(
      'float timeAlpha = sttTrailAlpha(revealTime, uCurrentTime, uTrailLength, uFadeTrail) * revealVisible;',
    );
    // The clamp is what keeps an f32 ulp at either edge from tripping
    // sttTrailAlpha's hard rejections and flickering the frontier to zero.
    expect(src).toContain('float revealTime = clamp(');
    expect(src).toContain('uCurrentTime - uTrailLength,');
  });

  it('composes with the DataFilter branch and with the id pass', () => {
    const filtered = revealSrc({ prelude: '', define: '' }, { filter: true });
    expect(filtered).toContain('sttDataFilterAlpha(aFilterValue');
    expect(filtered).toContain('sttRevealSpan(');
    expect(filtered).toContain('vAlpha = timeAlpha * filterMask;');
    // Both collapses coexist — one per-feature (filter), one per-instance.
    expect(filtered).toContain(
      'if (filterAlpha <= 0.0) gl_Position = vec4(0.0);',
    );
    expect(filtered).toContain(
      'if (revealVisible <= 0.0) gl_Position = vec4(0.0);',
    );

    const visual = revealSrc();
    const pick = revealSrc({ prelude: '', define: '' }, { pick: true });
    expect(pick).toContain('attribute vec3 aIdColor;');
    expect(pick).not.toContain('aColor');
    // Identical geometry + gates ⇒ unrevealed geometry is UNPICKABLE, and the
    // hit area is exactly the revealed area.
    const geometry = (s: string) =>
      s.slice(s.indexOf('void main'), s.indexOf('vAlpha = timeAlpha'));
    expect(geometry(pick)).toBe(geometry(visual));
  });
});

describe('reveal frontier math (JS reference for LINE_REVEAL_GLSL)', () => {
  const PERSIST = REVEAL_PERSIST_TRAIL_MS;

  it('resolves the trail length deck-style: 0 / unset / negative ⇒ persist', () => {
    expect(resolveRevealTrailLength(undefined)).toBe(PERSIST);
    expect(resolveRevealTrailLength(0)).toBe(PERSIST);
    expect(resolveRevealTrailLength(-5)).toBe(PERSIST);
    expect(resolveRevealTrailLength(2500)).toBe(2500);
    // Deck's own constant, so both backends persist over the same bound.
    expect(PERSIST).toBe(250 * 365 * 24 * 60 * 60 * 1000);
  });

  it('head fraction is LINEAR in time across the segment and clamped outside', () => {
    // Segment spanning [1000, 3000] ms.
    for (const [now, expected] of [
      [500, 0],
      [1000, 0],
      [1500, 0.25],
      [2000, 0.5],
      [3000, 1],
      [9999, 1],
    ] as const) {
      const [tail, head] = revealSpanJS(1000, 3000, now, PERSIST);
      expect(head).toBeCloseTo(expected, 12);
      expect(tail).toBe(0); // persist never erases
    }
  });

  it('a finite revealDuration erases behind the head', () => {
    // 400 ms comet over a [0, 1000] segment, play head at 600.
    const [tail, head] = revealSpanJS(0, 1000, 600, 400);
    expect(head).toBeCloseTo(0.6, 12);
    expect(tail).toBeCloseTo(0.2, 12);
    // Once the tail passes the whole segment nothing is drawn.
    const spent = revealSpanJS(0, 1000, 1500, 400);
    expect(spent[0]).toBe(1);
    expect(spent[1]).toBe(1);
    expect(revealVertexJS(0, 1000, 0, 1500, 400, 1).along).toBeNull();
  });

  it('a zero-length (or non-monotone) span flips WHOLE, never divides', () => {
    expect(revealSpanJS(500, 500, 499, PERSIST)).toEqual([0, 0]);
    expect(revealSpanJS(500, 500, 500, PERSIST)).toEqual([0, 1]);
    // Non-monotone endpoints degrade the same way instead of emitting NaN.
    const [tail, head] = revealSpanJS(900, 100, 500, PERSIST);
    expect(Number.isNaN(tail) || Number.isNaN(head)).toBe(false);
    expect(head).toBe(1);
  });

  it('draws the FRONTIER segment partially — not in whole-segment steps', () => {
    // Sweep the play head across a [0, 1000] segment: the drawn endpoint moves
    // continuously and strictly, which is the whole point of the feature (an
    // index/step implementation would return only 0 and 1 here).
    // At the segment's own start time nothing of it is drawn yet (head == tail
    // == 0), which is the collapse, not a zero-length sliver.
    expect(revealVertexJS(0, 1000, 1, 0, PERSIST, 1).along).toBeNull();
    const alongs: number[] = [];
    for (let now = 50; now <= 1000; now += 50) {
      alongs.push(revealVertexJS(0, 1000, 1, now, PERSIST, 1).along!);
    }
    for (let i = 1; i < alongs.length; i++) {
      expect(alongs[i]).toBeGreaterThan(alongs[i - 1]);
      expect(alongs[i] - alongs[i - 1]).toBeCloseTo(0.05, 12);
    }
    expect(alongs[0]).toBeCloseTo(0.05, 12);
    expect(alongs[alongs.length - 1]).toBe(1);
    // The A end of the same segment stays pinned while the head advances.
    expect(revealVertexJS(0, 1000, 0, 400, PERSIST, 1).along).toBe(0);
  });

  it('the head vertex is FULLY lit and the fade runs backwards from it', () => {
    // 400 ms comet, play head mid-segment.
    const head = revealVertexJS(0, 1000, 1, 600, 400, 1);
    const tail = revealVertexJS(0, 1000, 0, 600, 400, 1);
    expect(head.alpha).toBeCloseTo(1, 12); // age 0 at the frontier
    expect(tail.alpha).toBeCloseTo(0, 12); // age == trailLength at the tail
    // `fadeTrail: 0` is the solid snake — both ends fully lit, no gradient.
    expect(revealVertexJS(0, 1000, 1, 600, 400, 0).alpha).toBe(1);
    expect(revealVertexJS(0, 1000, 0, 600, 400, 0).alpha).toBe(1);
    // …and the alpha is exactly the shared trail kernel evaluated at the
    // clipped time, never a second formula.
    expect(revealVertexJS(0, 1000, 0.5, 600, 400, 1).alpha).toBeCloseTo(
      trailAlphaJS(400, 600, 400, 1),
      12,
    );
  });

  it('persist keeps an old vertex lit (the fade spreads over 250 years)', () => {
    const old = revealVertexJS(0, 1000, 0, 900_000, PERSIST, 1);
    expect(old.along).toBe(0);
    expect(old.alpha).toBeGreaterThan(0.999);
  });
});

describe('STTLineLayer reveal defaults + prop resolution', () => {
  it('is OFF by default — the compiled mode and caches are pre-M3', () => {
    const layer = makeLayer();
    expect(layer.lineOpts).toMatchObject({
      revealTrail: false,
      revealDuration: 0,
      reducedMotion: false,
      timeFilterMode: 'window',
    });
    expect(layer.mainProgramKey).toBe('line:window');
    const gl = makeMockGl();
    const tile = makeLineTile();
    expect(
      layer.buildTileGpuCache(gl, tile, tile.layers[0]).vertexTimeBuffer,
    ).toBeUndefined();
  });

  it('an explicitly-passed `undefined` does not shadow a default', () => {
    // The React `{...base, revealTrail: props.revealTrail}` prop-forwarding
    // shape carries the key with an undefined value.
    const layer = makeLayer({
      revealTrail: undefined,
      revealDuration: undefined,
      reducedMotion: undefined,
      fadeTrail: undefined,
    });
    expect(layer.lineOpts).toMatchObject({
      revealTrail: false,
      revealDuration: 0,
      reducedMotion: false,
      fadeTrail: 1,
      timeFilterMode: 'window',
    });
  });

  it('revealTrail compiles the reveal mode into both program keys', () => {
    const layer = makeLayer({ revealTrail: true });
    expect(layer.lineOpts.timeFilterMode).toBe('reveal');
    expect(layer.mainProgramKey).toBe('line:reveal');
    expect(layer.pickProgramKey).toBe('line:pick:reveal');
    expect(
      makeLayer({ revealTrail: true, filterProperty: 'w' }).mainProgramKey,
    ).toBe('line:reveal:filter');
  });

  it('reducedMotion suppresses the animation back to the time mode', () => {
    const layer = makeLayer({
      revealTrail: true,
      reducedMotion: true,
      timeFilterMode: 'wake',
    });
    expect(layer.lineOpts.timeFilterMode).toBe('wake');
    expect(layer.mainProgramKey).toBe('line:wake');
  });

  it('reveal SUPERSEDES timeFilterMode, and restores it verbatim when off', () => {
    const layer = makeLayer({
      timeFilterMode: 'cumulative',
      revealTrail: true,
    });
    expect(layer.lineOpts.timeFilterMode).toBe('reveal');
    layer.setRevealTrail(false);
    expect(layer.lineOpts.timeFilterMode).toBe('cumulative');
    expect(layer.mainProgramKey).toBe('line:cumulative');
  });

  it('a mode switch made DURING reveal lands the moment reveal ends', () => {
    const layer = makeLayer({ revealTrail: true });
    layer.map = makeMockMap();
    layer.setTimeFilterMode('wake');
    expect(layer.lineOpts.timeFilterMode).toBe('reveal'); // reveal still wins
    layer.setReducedMotion(true);
    expect(layer.lineOpts.timeFilterMode).toBe('wake');
    layer.setReducedMotion(false);
    expect(layer.lineOpts.timeFilterMode).toBe('reveal');
  });
});

describe('STTLineLayer reveal wiring', () => {
  const tileRelative = (tile: Tile) =>
    baseOpts.currentTime - tile.layers[0].features.timeOffset;

  it('bakes per-vertex times by cumulative DISTANCE when the tile has none', () => {
    const layer = makeLayer({ revealTrail: true });
    const gl = makeMockGl();
    const tile = makeLineTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache.vertexTimeBuffer).toBeTruthy();

    // Identical to the SHARED core kernel — reveal must never re-derive times
    // from vertex INDEX (a long leg would then ink at a short stub's rate).
    const shared = Array.from(synthesizeVertexTimes(tile.layers[0].features));
    const pairs = vertexTimePairs(gl, cache);
    expect(pairs).toEqual([
      shared[0],
      shared[1], // path 0, segment 0
      shared[1],
      shared[2], // path 0, segment 1
      shared[3],
      shared[4], // path 1
    ]);
    // …and that really is distance-weighted: NYC→Boston is ~57.6% of the way
    // to Maine, so the middle vertex is NOT the index ramp's 1000 ms.
    expect(pairs[1]).toBeCloseTo(1151.31, 1);
  });

  it('prefers the tile’s baked vertexTimestamps, ignoring a SHORT column', () => {
    const layer = makeLayer({ revealTrail: true });
    const glBaked = makeMockGl();
    const baked = makeTripsTile();
    expect(
      vertexTimePairs(
        glBaked,
        layer.buildTileGpuCache(glBaked, baked, baked.layers[0]),
      ),
    ).toEqual([0, 1000, 1000, 2000, 0, 1500]);

    // A column shorter than the vertex count would read past its end and bake
    // NaN times — a permanently blank path. Fall through to synthesis.
    const short = makeTripsTile();
    short.layers[0].features.vertexTimestamps = new Float32Array([0, 1000]);
    const glShort = makeMockGl();
    const pairs = vertexTimePairs(
      glShort,
      layer.buildTileGpuCache(glShort, short, short.layers[0]),
    );
    expect(pairs.some(Number.isNaN)).toBe(false);
    const shared = Array.from(synthesizeVertexTimes(short.layers[0].features));
    expect(pairs[1]).toBeCloseTo(shared[1], 5);
  });

  it('draws with the persist trail length and the tile-relative play head', () => {
    const layer = makeLayer({ revealTrail: true });
    const gl = makeMockGl();
    const tile = makeLineTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))),
    );
    expect(uniformArgs(gl, 'uniform1f', 'uCurrentTime')).toEqual([
      [tileRelative(tile)],
    ]);
    expect(uniformArgs(gl, 'uniform1f', 'uTrailLength')).toEqual([
      [REVEAL_PERSIST_TRAIL_MS],
    ]);
    expect(uniformArgs(gl, 'uniform1f', 'uFadeTrail')).toEqual([[1]]);
    // Window/wake uniforms don't exist in this program.
    expect(uniformArgs(gl, 'uniform1f', 'uWindowStart')).toEqual([]);
    expect(uniformArgs(gl, 'uniform1f', 'uWakeLength')).toEqual([]);
    // The per-vertex time buffer is what the reveal reads.
    expect(gl.bindBuffer.mock.calls.map((c: unknown[]) => c[1])).toContain(
      cache.vertexTimeBuffer,
    );
    expect(vertexSources(gl)[0]).toContain('sttRevealSpan(');
    // One instance per segment, exactly as every other mode.
    expect(layer.instSupport.drawArraysInstanced).toHaveBeenLastCalledWith(
      0x0005,
      0,
      4,
      cache.instanceCount,
    );
  });

  it('a finite revealDuration replaces the persist sentinel; fadeTrail rides along', () => {
    const layer = makeLayer({
      revealTrail: true,
      revealDuration: 2500,
      fadeTrail: false,
    });
    const gl = makeMockGl();
    const tile = makeLineTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))),
    );
    expect(uniformArgs(gl, 'uniform1f', 'uTrailLength')).toEqual([[2500]]);
    expect(uniformArgs(gl, 'uniform1f', 'uFadeTrail')).toEqual([[0]]);
  });

  it('reveal ignores the window-derived trailLength (its knob is its own)', () => {
    // `trailLength` still tracks setTimeWindow for trail mode, but a reveal
    // draw must read `revealDuration` — conflating them made a persist reveal
    // erase itself after half a window.
    const layer = makeLayer({ revealTrail: true, trailLength: 750 });
    const gl = makeMockGl();
    const tile = makeLineTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))),
    );
    expect(layer.lineOpts.trailLength).toBe(750);
    expect(uniformArgs(gl, 'uniform1f', 'uTrailLength')).toEqual([
      [REVEAL_PERSIST_TRAIL_MS],
    ]);
  });

  it('the frontier lands INSIDE the segment the play head is crossing', () => {
    // End-to-end over the real baked buffer: at t+1000 ms the first segment of
    // path 0 (times [0, 1151.31]) is 86.9% drawn and the rest is collapsed.
    const layer = makeLayer({ revealTrail: true });
    const gl = makeMockGl();
    const tile = makeLineTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    const pairs = vertexTimePairs(gl, cache);
    const now = tileRelative(tile); // 1000 ms into the tile

    const frontier = revealVertexJS(
      pairs[0],
      pairs[1],
      1,
      now,
      REVEAL_PERSIST_TRAIL_MS,
      1,
    );
    expect(frontier.along).toBeGreaterThan(0);
    expect(frontier.along).toBeLessThan(1);
    expect(frontier.along).toBeCloseTo(now / pairs[1], 10);
    expect(frontier.alpha).toBeCloseTo(1, 6);

    // Segment 1 of the same path has not started: nothing of it is drawn.
    expect(
      revealVertexJS(pairs[2], pairs[3], 1, now, REVEAL_PERSIST_TRAIL_MS, 1)
        .along,
    ).toBeNull();
  });

  it('gates PICKING through the same clip: the id pass is the reveal program', () => {
    const layer = makeLayer({ revealTrail: true, revealDuration: 2500 });
    const gl = makeMockGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    const ctx = drawCtx(normalizeRenderArgs(new Float32Array(16)));
    layer.drawPickTile(gl, tile, tile.layers[0], cache, ctx, 1);

    const idSource = vertexSources(gl).find((s) => s.includes('aIdColor'))!;
    expect(idSource).toBeDefined();
    expect(idSource).toContain('sttRevealSpan(');
    expect(idSource).toContain('vec2 posM = mix(aPosA, aPosB, revealAlong);');
    expect(idSource).toContain(
      'if (revealVisible <= 0.0) gl_Position = vec4(0.0);',
    );
    // Same uniforms as the visual pass ⇒ the hit area is the revealed area.
    expect(uniformArgs(gl, 'uniform1f', 'uTrailLength')).toEqual([[2500]]);
    expect(uniformArgs(gl, 'uniform1f', 'uCurrentTime')).toEqual([
      [tileRelative(tile)],
    ]);
    // Per-vertex times are bound in the id pass too (it reads aVertexTimeAB).
    expect(gl.bindBuffer.mock.calls.map((c: unknown[]) => c[1])).toContain(
      cache.vertexTimeBuffer,
    );
    // Teardown: every divisor back to 0 and every attribute disabled, so the
    // next visual frame's VAO recording starts from a clean slate.
    const divisors = layer.instSupport.vertexAttribDivisor.mock.calls;
    expect(divisors.slice(-8).every((c: number[]) => c[1] === 0)).toBe(true);
    expect(gl.disableVertexAttribArray).toHaveBeenCalled();
  });

  it('projects the reveal through the v5 prelude and re-records the VAO', () => {
    const layer = makeLayer({ revealTrail: true });
    const gl = makeMockGl();
    let vaoId = 0;
    const deleted: unknown[] = [];
    layer.vaoSupport = {
      enabled: true,
      create: vi.fn(() => ({ vao: vaoId++ })),
      bind: vi.fn(),
      delete: vi.fn((v: unknown) => deleted.push(v)),
    };
    const tile = makeLineTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(normalizeRenderArgs(new Float32Array(16))),
    );
    expect(cache.vaoMode).toBe('reveal');
    const first = cache.vao;

    const globe = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(globe));
    expect(gl.createProgram).toHaveBeenCalledTimes(2);
    expect(deleted).toContain(first);
    const globeVs = vertexSources(gl).find((s) =>
      s.includes('projectTile(posM)'),
    )!;
    expect(globeVs).toContain('sttRevealSpan(');
    expect(globeVs.startsWith(PRELUDE)).toBe(true);
  });
});

describe('STTLineLayer reveal runtime toggles', () => {
  const seeded = (extra: Record<string, unknown> = {}) => {
    const layer = makeLayer(extra);
    const gl = makeMockGl();
    layer.gl = gl;
    layer.map = makeMockMap();
    const tile = makeLineTile();
    layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    return { layer, gl, tile };
  };

  it('setRevealTrail rebuilds tile caches when the per-vertex need flips', () => {
    const { layer } = seeded();
    expect(layer.tileGpuCache.size).toBe(1);

    layer.setRevealTrail(true); // window → reveal: per-vertex times now needed
    expect(layer.tileGpuCache.size).toBe(0);
    expect(layer.mainProgramKey).toBe('line:reveal');

    layer.setRevealTrail(true); // idempotent
    expect(layer.mainProgramKey).toBe('line:reveal');
  });

  it('flipping between trail and reveal keeps the caches (same attribute)', () => {
    const { layer } = seeded({ timeFilterMode: 'trail' });
    expect(layer.tileGpuCache.size).toBe(1);
    layer.setRevealTrail(true);
    expect(layer.lineOpts.timeFilterMode).toBe('reveal');
    expect(layer.mainProgramKey).toBe('line:reveal');
    // Both modes bake `aVertexTimeAB` — no upload churn on the flip.
    expect(layer.tileGpuCache.size).toBe(1);
  });

  it('setRevealDuration / setFadeTrail are uniform-only', () => {
    const { layer, gl, tile } = seeded({ revealTrail: true });
    const cache = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    const ctx = drawCtx(normalizeRenderArgs(new Float32Array(16)));
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    const programs = gl.createProgram.mock.calls.length;

    layer.setRevealDuration(1200);
    layer.setFadeTrail(0.25);
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);

    expect(gl.createProgram.mock.calls.length).toBe(programs);
    expect(layer.tileGpuCache.size).toBe(1);
    expect(uniformArgs(gl, 'uniform1f', 'uTrailLength')).toEqual([
      [REVEAL_PERSIST_TRAIL_MS],
      [1200],
    ]);
    expect(uniformArgs(gl, 'uniform1f', 'uFadeTrail')).toEqual([[1], [0.25]]);
  });

  it('setReducedMotion suppresses and restores without losing the caches', () => {
    const { layer } = seeded({ revealTrail: true, timeFilterMode: 'trail' });
    expect(layer.lineOpts.timeFilterMode).toBe('reveal');
    expect(layer.tileGpuCache.size).toBe(1);
    layer.setReducedMotion(true); // reveal → trail: both per-vertex
    expect(layer.lineOpts.timeFilterMode).toBe('trail');
    expect(layer.tileGpuCache.size).toBe(1);
    layer.setReducedMotion(false);
    expect(layer.lineOpts.timeFilterMode).toBe('reveal');
  });

  it('setTimeWindow leaves an active reveal (and its duration) alone', () => {
    const { layer } = seeded({ revealTrail: true });
    layer.setTimeWindow(10_000);
    expect(layer.lineOpts.timeFilterMode).toBe('reveal');
    expect(layer.mainProgramKey).toBe('line:reveal');
    // The window-derived tails still track, for when reveal is switched off.
    expect(layer.lineOpts.trailLength).toBe(5_000);
  });
});

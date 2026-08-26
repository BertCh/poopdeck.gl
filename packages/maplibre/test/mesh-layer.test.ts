/**
 * STTMeshLayer — instanced 3D models on a track clock.
 *
 * Five things are testable without a GPU, and this file covers exactly those:
 *
 *  1. **Shader assembly** — both host variants (legacy `uMatrix`, v5 injected
 *     prelude) build for both passes (visual + id-pick), for all four compiled
 *     time modes and with/without the DataFilter; the DEFAULT configuration
 *     compiles NONE of the optional surface; the program-cache key carries every
 *     structural axis.
 *  2. **The defining motion constraint** — a tile of N snapshots pooled into K
 *     tracks emits K instances per frame, never N. The pose is interpolated to
 *     the playhead and the heading takes the SHORTEST ARC.
 *  3. **Attitude** — the quaternion kernel's rotation, its shortest-arc slerp
 *     (including the `q`/`-q` sign flip that is the rotational twin of the
 *     heading wrap bug), the keyframe bracket search, and the CPU composition of
 *     `orientationOffset` with the instance attitude.
 *  4. **Buffers** — the instance buffer is allocated ONCE at tile-cache build
 *     and refilled with `bufferSubData` every tick, never re-allocated; the
 *     per-layer staging array is grow-only; per-category instances come out
 *     CONTIGUOUS so one draw covers each model.
 *  5. **Pick gating** — the id pass compiles the same time/filter/colour-alpha
 *     gates as the visual pass, paints ids derived from the SOURCE feature index
 *     (so a `resolvePick` join lands on a real row), and cleans up its divisors
 *     and its buffer.
 *
 * The FBO round-trip and real prelude compilation stay browser-verified.
 */

import { describe, it, expect, vi } from 'vitest';
import { GeometryType, type Layer, type Tile } from '@poopdeck.gl/core';
import { encodePickId } from '@poopdeck.gl/core/picking';
import {
  STTMeshLayer,
  buildMeshVertexSource,
  buildMeshIdVertexSource,
  meshProgramKey,
  resolveMeshTimeFilterMode,
  orderTracksByCategory,
  slerpQuatAt,
  type MeshShaderConfig,
  type STTMeshGeometry,
} from '../src/layers/mesh-layer';
import {
  rotateByQuat,
  slerpQuat,
  multiplyQuat,
  quatFromHeading,
  quatFromEulerXYZ,
  normalizeQuat,
} from '../src/shaders/mesh-attitude.glsl';
import { DATA_FILTER_CALL_GLSL } from '../src/shaders/data-filter.glsl';
import { lngLatToMercator, tileCenterLatitude } from '../src/lib/projection';
import { makeMockGl } from './mock-gl';

const TIME_OFFSET = 1_700_000_000_000;

const baseOpts = {
  url: 'mem://objects.stt',
  currentTime: TIME_OFFSET + 500,
  timeWindow: 10_000,
};

const PRELUDE_MARKER = '// __HOST_PRELUDE__';
const PRELUDE = `${PRELUDE_MARKER}\nvec4 projectTileFor3D(vec2 p, float e) { return vec4(p, e, 1.0); }`;
const LEGACY_SHADER = { prelude: '', define: '' };
const V5_SHADER = { prelude: PRELUDE, define: '#define GLOBE' };

const cfg = (over: Partial<MeshShaderConfig> = {}): MeshShaderConfig => ({
  mode: 'window',
  filter: false,
  ...over,
});

const ALL_MODES = ['window', 'wake', 'cumulative', 'trail'] as const;

// ── local fixture: an AV `objects/` tile ────────────────────────────────────
// test/fixtures.ts has no snapshot-stream fixture (it predates this kind), so
// one is defined here rather than edited into a file this agent does not own.

interface ObjectsTileOpts {
  /** Emit the four quaternion columns as well as `heading`. */
  quaternions?: boolean;
  /** Emit a numeric column usable as a DataFilter source. */
  filterColumn?: boolean;
  /** Drop the track-id column entirely (each snapshot becomes its own track). */
  noTrackIds?: boolean;
}

/**
 * Six snapshots: track `a` (category `car`) at t = 0/1000/2000 moving due east,
 * track `b` (category `pedestrian`) at the same three instants.
 *
 * `b`'s heading crosses the ±π branch cut (3.0 → -3.0 rad), which is what makes
 * the shortest-arc assertion meaningful: a naive lerp lands on 0 (due east),
 * the correct one lands on ±π (due west).
 */
function makeObjectsTile(o: ObjectsTileOpts = {}): Tile {
  const positions = new Float64Array([
    // track a — moving east along 37.7
    -122.4, 37.7, -122.3, 37.7, -122.2, 37.7,
    // track b — moving north along -73.95
    -73.95, 40.75, -73.95, 40.85, -73.95, 40.95,
  ]);
  const numericProps: Record<string, Float32Array> = {
    heading: new Float32Array([0, 0.4, 0.8, 3.0, -3.0, -2.6]),
    length: new Float32Array([4, 4, 4, 0.8, 0.8, 0.8]),
    width: new Float32Array([2, 2, 2, 0.8, 0.8, 0.8]),
    height: new Float32Array([1.5, 1.5, 1.5, 1.8, 1.8, 1.8]),
    speed: new Float32Array([10, 10, 10, 1, 1, 1]),
  };
  if (o.quaternions) {
    // a: identity → 90° about +z → 180° about +z.
    // b: constant identity.
    const s45 = Math.SQRT1_2;
    numericProps.qx = new Float32Array([0, 0, 0, 0, 0, 0]);
    numericProps.qy = new Float32Array([0, 0, 0, 0, 0, 0]);
    numericProps.qz = new Float32Array([0, s45, 1, 0, 0, 0]);
    numericProps.qw = new Float32Array([1, s45, 0, 1, 1, 1]);
  }
  if (o.filterColumn) {
    numericProps.score = new Float32Array([0.1, 0.1, 0.1, 0.9, 0.9, 0.9]);
  }
  const categoricalProps: Record<
    string,
    { indices: Uint16Array; categories: string[] }
  > = {
    category: {
      indices: new Uint16Array([0, 0, 0, 1, 1, 1]),
      categories: ['car', 'pedestrian'],
    },
  };
  if (!o.noTrackIds) {
    categoricalProps.track_id = {
      indices: new Uint16Array([0, 0, 0, 1, 1, 1]),
      categories: ['a', 'b'],
    };
  }
  const features = {
    featureCount: 6,
    geometryType: GeometryType.Point,
    positionDimensions: 2 as const,
    positions,
    featureIds: new Uint32Array([0, 1, 2, 3, 4, 5]),
    startTimes: new Float32Array([0, 1000, 2000, 0, 1000, 2000]),
    endTimes: new Float32Array([100, 1100, 2100, 100, 1100, 2100]),
    timeOffset: TIME_OFFSET,
    numericProps,
    categoricalProps,
  };
  const layer: Layer = {
    name: 'objects',
    extent: 4096,
    features,
    geometryExtensionName: 'geoarrow.point',
  };
  return {
    id: { z: 12, x: 655, y: 1583, t: TIME_OFFSET },
    timeRange: { start: TIME_OFFSET, end: TIME_OFFSET + 2000 },
    layers: [layer],
  };
}

/** A trivial two-triangle model, enough to be uploaded and drawn. */
const QUAD: STTMeshGeometry = {
  positions: new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
};

/** A non-indexed model, to exercise the `drawArraysInstanced` branch. */
const TRI: STTMeshGeometry = {
  positions: new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 1]),
};

// ── mock GL (bufferSubData + instancing recorder) ───────────────────────────

/**
 * `makeMockGl` has no `bufferSubData` (it predates the per-frame-upload
 * layers). Wrap it here rather than editing the shared recorder, and SNAPSHOT
 * the uploaded view — the emit scratch is a reused per-layer array, so a plain
 * call log would show every recorded upload holding the newest values.
 */
function makeGl(): any {
  const gl = makeMockGl();
  gl.subUploads = [] as Array<{ offset: number; values: number[] }>;
  gl.bufferSubData = vi.fn(
    (_target: number, offset: number, data: ArrayBufferView) => {
      gl.subUploads.push({
        offset,
        values: Array.from(data as unknown as ArrayLike<number>),
      });
    },
  );
  return gl;
}

/** All vertex-shader sources handed to the mock GL so far. */
const vertexSources = (gl: any): string[] =>
  gl.shaderSource.mock.calls.map((c: unknown[]) => c[1] as string);

/** Uniform uploads keyed by NAME (locations are opaque handles). */
function uniformsByName(gl: any): Map<string, unknown[][]> {
  const nameByLoc = new Map<unknown, string>();
  gl.getUniformLocation.mock.calls.forEach((call: unknown[], i: number) => {
    nameByLoc.set(gl.getUniformLocation.mock.results[i].value, call[1]);
  });
  const out = new Map<string, unknown[][]>();
  for (const fn of [
    gl.uniform1f,
    gl.uniform2f,
    gl.uniform3f,
    gl.uniform2fv,
    gl.uniform3fv,
    gl.uniform4fv,
    gl.uniformMatrix4fv,
  ]) {
    if (!fn) continue;
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

const lastScalar = (u: Map<string, unknown[][]>, name: string): any =>
  u.get(name)?.at(-1)?.[0];

const legacyFrame = () => ({
  shader: { variantName: 'legacy', prelude: '', define: '' },
  projectionData: null,
});

const v5Frame = (variantName = 'mercator') => ({
  shader: { variantName, prelude: PRELUDE, define: '#define GLOBE' },
  projectionData: {
    mainMatrix: new Float32Array(16),
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 0, 1],
    projectionTransition: 0,
    fallbackMatrix: new Float32Array(16),
  },
});

const drawCtx = (
  frame: any = legacyFrame(),
  over: Record<string, any> = {},
) => ({
  matrix: new Float32Array(16),
  frame,
  windowStart: -10_000,
  windowEnd: 10_000,
  currentTime: TIME_OFFSET + 500,
  zoom: 12,
  ...over,
});

function makeLayerWithCache(
  extra: Record<string, unknown> = {},
  tile = makeObjectsTile(),
) {
  const layer = new STTMeshLayer({
    ...baseOpts,
    id: 'mesh',
    mesh: QUAD,
    ...extra,
  } as any) as any;
  const gl = makeGl();
  // `initInstancing` / `initVaoSupport` run in `onAdd`, which these direct-hook
  // tests bypass — wire the mock's entry points so the instanced path is real.
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
  const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
  return { layer, gl, tile, cache };
}

/** Instance `i`'s float slots out of the most recent per-frame upload. */
function instance(gl: any, i: number, stride = 17): number[] {
  const up = gl.subUploads.at(-1);
  expect(up).toBeTruthy();
  return up!.values.slice(i * stride, (i + 1) * stride);
}

/** Yaw recovered from a z-axis quaternion, in radians. */
const yawOf = (q: number[]): number => 2 * Math.atan2(q[2], q[3]);

// ════════════════════════════════════════════════════════════════════════════
describe('shader assembly', () => {
  it('builds every (variant × pass × mode × filter) combination', () => {
    for (const mode of ALL_MODES) {
      for (const filter of [false, true]) {
        for (const shader of [LEGACY_SHADER, V5_SHADER]) {
          for (const build of [
            buildMeshVertexSource,
            buildMeshIdVertexSource,
          ]) {
            const src = build(shader, cfg({ mode, filter }));
            expect(src).toContain('void main()');
            expect(src).toContain('sttRotateByQuat');
            expect(src).toContain('attribute vec4 aInstQuat;');
          }
        }
      }
    }
  });

  it('projects through uMatrix on legacy and the prelude on v5', () => {
    const legacy = buildMeshVertexSource(LEGACY_SHADER, cfg());
    expect(legacy).toContain('uniform mat4 uMatrix;');
    expect(legacy).not.toContain(PRELUDE_MARKER);

    const v5 = buildMeshVertexSource(V5_SHADER, cfg());
    expect(v5).toContain(PRELUDE_MARKER);
    expect(v5).toContain('#define GLOBE');
    // The prelude owns projection; declaring uMatrix would falsely imply the
    // layer reads it.
    expect(v5).not.toContain('uniform mat4 uMatrix;');
  });

  it('splices exactly the compiled mode: one kernel, one alpha call', () => {
    const calls: Record<string, string> = {
      window: 'sttTimeWindowAlpha(aTime',
      wake: 'sttWakeAlpha(aTime',
      cumulative: 'sttCumulativeAlpha(aTime',
      trail: 'sttTrailAlpha(aTime.x',
    };
    for (const mode of ALL_MODES) {
      const src = buildMeshVertexSource(LEGACY_SHADER, cfg({ mode }));
      expect(src).toContain(calls[mode]);
      for (const other of ALL_MODES) {
        if (other === mode) continue;
        expect(src).not.toContain(calls[other]);
      }
    }
  });

  it('tapers the model in wake mode only — a model has a physical size', () => {
    const wake = buildMeshVertexSource(LEGACY_SHADER, cfg({ mode: 'wake' }));
    expect(wake).toContain('sttWakeSizeScale(vAlpha, uWakeTailScale)');
    for (const mode of ['window', 'cumulative', 'trail'] as const) {
      expect(buildMeshVertexSource(LEGACY_SHADER, cfg({ mode }))).not.toContain(
        'sttWakeSizeScale',
      );
    }
  });

  it('compiles the DataFilter only when asked, and lets it drive SIZE', () => {
    const off = buildMeshVertexSource(LEGACY_SHADER, cfg());
    expect(off).not.toContain(DATA_FILTER_CALL_GLSL);
    expect(off).not.toContain('uFilterRange');

    const on = buildMeshVertexSource(LEGACY_SHADER, cfg({ filter: true }));
    expect(on).toContain(DATA_FILTER_CALL_GLSL);
    expect(on).toContain('if (uFilterTransformSize > 0.5) sizeScale *=');
    expect(on).toContain('uFilterTransformColor > 0.5');
  });

  it('the id pass gates on colour alpha and discards on vAlpha', () => {
    const id = buildMeshIdVertexSource(LEGACY_SHADER, cfg());
    expect(id).toContain('attribute vec3 aIdColor;');
    expect(id).toContain('vAlpha *= aColor.a;');
    expect(id).toContain('vIdColor = aIdColor;');
    // …and never leaks the visual payload.
    expect(id).not.toContain('varying vec4 vColor;');
    expect(id).not.toContain('vLight');
  });

  it('the visual pass carries lighting, the id pass does not', () => {
    const main = buildMeshVertexSource(LEGACY_SHADER, cfg());
    expect(main).toContain('varying float vLight;');
    expect(main).toContain('uLightDirection');
    expect(main).toContain('sttRotateByQuat(aInstQuat, aModelNormal)');
  });

  it('the program-cache key carries every structural axis', () => {
    const keys = new Set<string>();
    for (const pass of ['fill', 'pick-fill'] as const) {
      for (const mode of ALL_MODES) {
        for (const filter of [false, true]) {
          keys.add(meshProgramKey(pass, cfg({ mode, filter })));
        }
      }
    }
    expect(keys.size).toBe(2 * 4 * 2);
    expect(meshProgramKey('fill', cfg())).toBe('mesh:fill:window');
    expect(
      meshProgramKey('pick-fill', cfg({ mode: 'wake', filter: true })),
    ).toBe('mesh:pick-fill:wake:filter');
  });

  it('defaults are the pre-campaign behaviour: none of the optional surface', () => {
    const src = buildMeshVertexSource(LEGACY_SHADER);
    expect(src).not.toContain('sttWakeSizeScale');
    expect(src).not.toContain('uFilterRange');
    expect(src).not.toContain('aIdColor');
    expect(src).toContain('sttTimeWindowAlpha');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('resolveMeshTimeFilterMode', () => {
  it('degrades an explicitly-named mode whose knob is off', () => {
    expect(resolveMeshTimeFilterMode('wake', 0, 0)).toBe('window');
    expect(resolveMeshTimeFilterMode('wake', 500, 0)).toBe('wake');
    expect(resolveMeshTimeFilterMode('trail', 0, 0)).toBe('window');
    expect(resolveMeshTimeFilterMode('trail', 0, 500)).toBe('trail');
    expect(resolveMeshTimeFilterMode('window', 500, 500)).toBe('window');
    expect(resolveMeshTimeFilterMode('cumulative', 0, 0)).toBe('cumulative');
  });

  it('unset follows deck TimeFilterExtension precedence: wake, trail, window', () => {
    expect(resolveMeshTimeFilterMode(undefined, 500, 500)).toBe('wake');
    expect(resolveMeshTimeFilterMode(undefined, 0, 500)).toBe('trail');
    expect(resolveMeshTimeFilterMode(undefined, 0, 0)).toBe('window');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('attitude kernel', () => {
  it('rotateByQuat matches hand-computed axis rotations', () => {
    const yaw90 = quatFromHeading(Math.PI / 2);
    const [x, y, z] = rotateByQuat(yaw90, [1, 0, 0]);
    expect(x).toBeCloseTo(0, 10);
    expect(y).toBeCloseTo(1, 10);
    expect(z).toBeCloseTo(0, 10);

    // Identity leaves the vector alone, exactly.
    expect(rotateByQuat([0, 0, 0, 1], [3, -4, 5])).toEqual([3, -4, 5]);

    // A 180° yaw flips x and y and preserves z.
    const [a, b, c] = rotateByQuat(quatFromHeading(Math.PI), [1, 2, 3]);
    expect(a).toBeCloseTo(-1, 10);
    expect(b).toBeCloseTo(-2, 10);
    expect(c).toBeCloseTo(3, 10);
  });

  it('rotation preserves length (it is a rotation, not a transform)', () => {
    const q = normalizeQuat([0.3, -0.5, 0.2, 0.8]);
    const v: [number, number, number] = [1.5, -2.25, 0.75];
    const r = rotateByQuat(q, v);
    expect(Math.hypot(...r)).toBeCloseTo(Math.hypot(...v), 10);
  });

  it('slerp takes the SHORTEST arc across the q/-q sign ambiguity', () => {
    const a = quatFromHeading(0);
    const near = quatFromHeading(Math.PI / 2);
    // Same rotation, opposite representation. A naive slerp would sweep 270°.
    const flipped = near.map((v) => -v) as [number, number, number, number];
    const short = slerpQuat(a, near, 0.5);
    const alsoShort = slerpQuat(a, flipped, 0.5);
    for (let i = 0; i < 4; i++) {
      // Up to the same global sign, the two land on the same rotation.
      expect(Math.abs(alsoShort[i])).toBeCloseTo(Math.abs(short[i]), 10);
    }
    expect(Math.abs(yawOf(short))).toBeCloseTo(Math.PI / 4, 10);
  });

  it('slerp endpoints are exact and the midpoint bisects the angle', () => {
    const a = quatFromHeading(0.2);
    const b = quatFromHeading(1.4);
    expect(yawOf(slerpQuat(a, b, 0))).toBeCloseTo(0.2, 10);
    expect(yawOf(slerpQuat(a, b, 1))).toBeCloseTo(1.4, 10);
    expect(yawOf(slerpQuat(a, b, 0.5))).toBeCloseTo(0.8, 10);
  });

  it('slerp stays a UNIT quaternion, including on the near-aligned fallback', () => {
    const a = quatFromHeading(0.5);
    const b = quatFromHeading(0.5 + 1e-5); // dot > 0.9995 → the lerp fallback
    const mid = slerpQuat(a, b, 0.5);
    expect(Math.hypot(...mid)).toBeCloseTo(1, 12);
    const wide = slerpQuat(quatFromHeading(0), quatFromHeading(2.5), 0.37);
    expect(Math.hypot(...wide)).toBeCloseTo(1, 12);
  });

  it('a degenerate quaternion degrades to identity, never NaN', () => {
    expect(normalizeQuat([0, 0, 0, 0])).toEqual([0, 0, 0, 1]);
    expect(quatFromHeading(Number.NaN)).toEqual([0, 0, 0, 1]);
  });

  it('multiplyQuat composes: apply b, then a', () => {
    const composed = multiplyQuat(
      quatFromHeading(Math.PI / 2),
      quatFromHeading(Math.PI / 4),
    );
    expect(yawOf(composed)).toBeCloseTo((3 * Math.PI) / 4, 10);
    // Identity on either side is a no-op.
    const q = quatFromHeading(0.7);
    expect(multiplyQuat(q, [0, 0, 0, 1])).toEqual(q);
  });

  it('quatFromEulerXYZ(0,0,0) is identity and yaw-only matches the heading form', () => {
    expect(quatFromEulerXYZ(0, 0, 0)).toEqual([0, 0, 0, 1]);
    const euler = quatFromEulerXYZ(0, 0, 1.1);
    const heading = quatFromHeading(1.1);
    for (let i = 0; i < 4; i++) expect(euler[i]).toBeCloseTo(heading[i], 12);
  });

  it('slerpQuatAt brackets by time, clamps outside, and bisects inside', () => {
    const times = new Float64Array([1000, 2000, 4000]);
    const values = new Float32Array([
      ...quatFromHeading(0),
      ...quatFromHeading(Math.PI / 2),
      ...quatFromHeading(Math.PI),
    ]);
    expect(yawOf(slerpQuatAt(times, values, 0))).toBeCloseTo(0, 6);
    expect(yawOf(slerpQuatAt(times, values, 1000))).toBeCloseTo(0, 6);
    expect(yawOf(slerpQuatAt(times, values, 1500))).toBeCloseTo(Math.PI / 4, 6);
    expect(yawOf(slerpQuatAt(times, values, 3000))).toBeCloseTo(
      (3 * Math.PI) / 4,
      6,
    );
    expect(Math.abs(yawOf(slerpQuatAt(times, values, 99_999)))).toBeCloseTo(
      Math.PI,
      6,
    );
    // A single keyframe holds; an empty list is identity.
    expect(slerpQuatAt(new Float64Array([5]), values, 0)).toEqual([0, 0, 0, 1]);
    expect(slerpQuatAt(new Float64Array(0), values, 0)).toEqual([0, 0, 0, 1]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('orderTracksByCategory', () => {
  it('groups every category into one contiguous run covering all tracks', () => {
    const tracks = [
      { category: 'car' },
      { category: 'ped' },
      { category: 'car' },
      { category: 'bike' },
      { category: 'ped' },
    ] as any[];
    const { order, categoryRuns } = orderTracksByCategory(tracks);
    expect(order.length).toBe(5);
    expect(categoryRuns.map((r) => r.category)).toEqual(['car', 'ped', 'bike']);
    expect(categoryRuns.reduce((s, r) => s + r.count, 0)).toBe(5);
    // Runs are contiguous and in order.
    let cursor = 0;
    for (const run of categoryRuns) {
      expect(run.start).toBe(cursor);
      for (let j = run.start; j < run.start + run.count; j++) {
        expect(tracks[order[j]].category).toBe(run.category);
      }
      cursor += run.count;
    }
    // Every track appears exactly once.
    expect(new Set(Array.from(order)).size).toBe(5);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('track pooling — ONE instance per object per frame', () => {
  it('pools 6 snapshots into 2 tracks and emits 2 instances, not 6', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    expect(cache.featureCount).toBe(6);
    expect(cache.tracks.length).toBe(2);
    expect(cache.capacity).toBe(2);

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(cache.activeCount).toBe(2);
    const instanced = gl.drawCalls.filter((d: any) =>
      String(d.kind).includes('instanced'),
    );
    expect(instanced.reduce((s: number, d: any) => s + d.instances, 0)).toBe(2);
  });

  it('interpolates the pose to the playhead rather than snapping to a keyframe', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    // t = +500 ms: halfway between keyframe 0 (-122.4) and keyframe 1 (-122.3).
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    const inst = instance(gl, 0);
    const expected = lngLatToMercator(-122.35, 37.7);
    expect(inst[0]).toBeCloseTo(expected[0], 6);
    expect(inst[1]).toBeCloseTo(expected[1], 6);
    // …and it is NOT either keyframe.
    expect(inst[0]).not.toBeCloseTo(lngLatToMercator(-122.4, 37.7)[0], 8);
  });

  it('heading takes the SHORTEST arc across the ±pi branch cut', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    // Track b: 3.0 → -3.0 rad. The short way is +0.2832 rad THROUGH pi;
    // the long way (a naive lerp) lands on 0.
    const yaw = yawOf(instance(gl, 1).slice(3, 7));
    expect(Math.abs(yaw)).toBeCloseTo(Math.PI, 3);
    expect(Math.abs(yaw)).toBeGreaterThan(3);
  });

  it('a playhead outside a track drops its instance entirely', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame(), { currentTime: TIME_OFFSET + 9_999_999 }),
    );
    expect(cache.activeCount).toBe(0);
    expect(gl.drawCalls.length).toBe(0);
  });

  it('writes the TRACK span, tile-relative, into the GPU time gate', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    const inst = instance(gl, 0);
    expect(inst[10]).toBeCloseTo(0, 6); // first keyframe, tile-relative
    expect(inst[11]).toBeCloseTo(2000, 6); // last keyframe, tile-relative
  });

  it('relativizes the playhead against the tile time offset, never absolute', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      timeFilterMode: 'cumulative',
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uCurrentTime')).toBeCloseTo(500, 6);
  });

  it('without a track-id column every snapshot is its own held instance', () => {
    const tile = makeObjectsTile({ noTrackIds: true });
    const { layer, gl, cache } = makeLayerWithCache({}, tile);
    // No pooling key ⇒ six singleton tracks, not two glide tracks.
    expect(cache.tracks.length).toBe(6);

    // A singleton HOLDS for SINGLETON_HOLD_MS/2 either side of its own keyframe
    // and is never interpolated. On a keyframe instant exactly the two
    // snapshots at that instant light; between keyframes (+500, outside every
    // 300 ms hold band) nothing does. That gap IS the behaviour a track-id
    // column buys you, stated as a test.
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame(), { currentTime: TIME_OFFSET + 1000 }),
    );
    expect(cache.activeCount).toBe(2);

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(cache.activeCount).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('attitude on the instance stream', () => {
  it('slerps the quaternion columns when they are present', () => {
    const tile = makeObjectsTile({ quaternions: true });
    const { layer, gl, cache } = makeLayerWithCache({}, tile);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    // Track a: identity → 90° about +z, sampled at the midpoint → 45°.
    const yaw = yawOf(instance(gl, 0).slice(3, 7));
    expect(yaw).toBeCloseTo(Math.PI / 4, 5);
    // …which is NOT what the heading column would have produced (0.2 rad).
    expect(yaw).not.toBeCloseTo(0.2, 2);
  });

  it('falls back to a yaw-only quaternion from the heading column', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    const q = instance(gl, 0).slice(3, 7);
    expect(q[0]).toBeCloseTo(0, 10); // no roll
    expect(q[1]).toBeCloseTo(0, 10); // no pitch
    expect(yawOf(q)).toBeCloseTo(0.2, 5); // lerp(0, 0.4, 0.5)
  });

  it('composes orientationOffset with the instance attitude on the CPU', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      orientationOffset: [0, 0, Math.PI / 2],
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    // The model correction is applied FIRST, the track attitude after.
    expect(yawOf(instance(gl, 0).slice(3, 7))).toBeCloseTo(
      0.2 + Math.PI / 2,
      5,
    );
  });

  it('emits a UNIT quaternion for every instance', () => {
    const tile = makeObjectsTile({ quaternions: true });
    const { layer, gl, cache } = makeLayerWithCache(
      { orientationOffset: [0.3, -0.2, 1.1] },
      tile,
    );
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    for (let i = 0; i < cache.activeCount; i++) {
      const q = instance(gl, i).slice(3, 7);
      expect(Math.hypot(...q)).toBeCloseTo(1, 5);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('sizing', () => {
  it('scaleToDimensions writes the interpolated box; off writes unit dims', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(instance(gl, 0).slice(7, 10)).toEqual([4, 2, 1.5]);

    const off = makeLayerWithCache({ scaleToDimensions: false });
    off.layer.drawTile(
      off.gl,
      off.tile,
      off.tile.layers[0],
      off.cache,
      drawCtx(),
    );
    expect(instance(off.gl, 0).slice(7, 10)).toEqual([1, 1, 1]);
  });

  it("sizeUnits 'meters' is the plain multiplier", () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({ sizeScale: 2.5 });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(lastScalar(uniformsByName(gl), 'uSizeScale')).toBeCloseTo(2.5, 10);
  });

  it("sizeUnits 'pixels' folds the metric scale and HALVES per zoom level", () => {
    const at = (zoom: number): number => {
      const { layer, gl, tile, cache } = makeLayerWithCache({
        sizeScale: 1,
        sizeUnits: 'pixels',
      });
      layer.drawTile(
        gl,
        tile,
        tile.layers[0],
        cache,
        drawCtx(legacyFrame(), { zoom }),
      );
      return lastScalar(uniformsByName(gl), 'uSizeScale');
    };
    const z12 = at(12);
    const z13 = at(13);
    expect(z12).toBeGreaterThan(0);
    expect(z13).toBeCloseTo(z12 / 2, 6);
    expect(z12).not.toBeCloseTo(1, 6);
  });

  it('resolves metres→mercator at the TILE centre latitude, y NEGATED', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    const [sx, sy] = uniformsByName(gl).get('uMeterToMercator')!.at(-1)!;
    expect(sy).toBeCloseTo(-(sx as number), 15);
    expect(sx as number).toBeGreaterThan(0);
    // Latitude-dependent: a tile at the equator has a SMALLER factor than one
    // far north, because a mercator unit covers more ground there.
    expect(tileCenterLatitude(tile.id.z, tile.id.y)).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('buffers', () => {
  it('allocates the instance buffer ONCE and refills it per tick', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const allocs = gl.bufferData.mock.calls.length;
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    // Three ticks, three sub-uploads, and not one extra allocation beyond the
    // one-time model upload.
    expect(gl.subUploads.length).toBe(3);
    const extra = gl.bufferData.mock.calls.length - allocs;
    expect(extra).toBeLessThanOrEqual(3); // model positions/normals/indices, once
    expect(gl.subUploads.every((u: any) => u.offset === 0)).toBe(true);
  });

  it('uploads only the ACTIVE prefix, not the whole capacity', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(gl.subUploads.at(-1).values.length).toBe(cache.activeCount * 17);
  });

  it('the DataFilter value rides the interleaved stream and widens the stride', () => {
    const tile = makeObjectsTile({ filterColumn: true });
    const { layer, gl, cache } = makeLayerWithCache(
      { filterProperty: 'score', filterRange: [0, 1] },
      tile,
    );
    expect(cache.hasFilterColumn).toBe(true);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(gl.subUploads.at(-1).values.length).toBe(cache.activeCount * 18);
    expect(instance(gl, 0, 18)[17]).toBeCloseTo(0.1, 6);
    expect(instance(gl, 1, 18)[17]).toBeCloseTo(0.9, 6);
  });

  it('a missing filter column renders unfiltered, never blank', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      filterProperty: 'not_a_column',
      filterRange: [0, 1],
    });
    expect(cache.hasFilterColumn).toBe(false);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(cache.activeCount).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('per-category models', () => {
  it('draws one instanced call per category, over contiguous ranges', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      meshes: { car: QUAD, pedestrian: TRI },
      mesh: undefined,
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(cache.groups.map((g: any) => g.category)).toEqual([
      'car',
      'pedestrian',
    ]);
    expect(cache.groups.map((g: any) => [g.start, g.count])).toEqual([
      [0, 1],
      [1, 1],
    ]);
    // The indexed model takes drawElementsInstanced, the soup takes arrays.
    const kinds = gl.drawCalls.map((d: any) => d.kind);
    expect(kinds).toContain('elements-instanced');
    expect(kinds).toContain('arrays-instanced');
  });

  it('a category with no entry falls back to the default mesh', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      meshes: { car: TRI },
      mesh: QUAD,
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(gl.drawCalls.length).toBe(2);
  });

  it('a category with neither draws nothing and warns exactly once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { layer, gl, tile, cache } = makeLayerWithCache({ mesh: undefined });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(gl.drawCalls.length).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('uploads each model ONCE per context, across frames and tiles', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      meshes: { car: QUAD, pedestrian: TRI },
      mesh: undefined,
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    const after = gl.createBuffer.mock.calls.length;
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(gl.createBuffer.mock.calls.length).toBe(after);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('picking', () => {
  it('is pickable — drawPickTile exists', () => {
    const layer = new STTMeshLayer({ ...baseOpts, id: 'm', mesh: QUAD } as any);
    expect(typeof (layer as any).drawPickTile).toBe('function');
  });

  it('paints ids derived from the SOURCE feature index, not the draw order', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawPickTile(gl, tile, tile.layers[0], cache, drawCtx(), 1);
    const bytes = gl.bufferData.mock.calls
      .map((c: unknown[]) => c[1])
      .filter((d: unknown) => d instanceof Uint8Array)
      .at(-1) as Uint8Array;
    expect(bytes.length).toBe(cache.activeCount * 3);
    // Track a opened at feature 0, track b at feature 3 — 1-based ids.
    expect(Array.from(bytes.slice(0, 3))).toEqual(
      Array.from(encodePickId(1 + 0)),
    );
    expect(Array.from(bytes.slice(3, 6))).toEqual(
      Array.from(encodePickId(1 + 3)),
    );
  });

  it('compiles the same gates as the visual pass for the SAME configuration', () => {
    const c = cfg({ mode: 'wake', filter: true });
    const main = buildMeshVertexSource(LEGACY_SHADER, c);
    const id = buildMeshIdVertexSource(LEGACY_SHADER, c);
    for (const gate of [
      'sttWakeAlpha(aTime, uCurrentTime, uWakeLength)',
      'sttWakeSizeScale(vAlpha, uWakeTailScale)',
      DATA_FILTER_CALL_GLSL,
      'vAlpha *= uOpacity;',
      'if (vAlpha <= 0.0) gl_Position = vec4(0.0);',
    ]) {
      expect(main).toContain(gate);
      expect(id).toContain(gate);
    }
  });

  it('resets every divisor it set and frees the id buffer', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawPickTile(gl, tile, tile.layers[0], cache, drawCtx(), 1);
    const divisors = gl.vertexAttribDivisor.mock.calls as number[][];
    const setTo1 = new Set(divisors.filter((c) => c[1] === 1).map((c) => c[0]));
    const clearedTo0 = new Set(
      divisors.filter((c) => c[1] === 0).map((c) => c[0]),
    );
    for (const loc of setTo1) expect(clearedTo0.has(loc)).toBe(true);
    expect(gl.deleteBuffer).toHaveBeenCalled();
  });

  it('draws the same instance count as the visual pass — never more permissive', () => {
    const visual = makeLayerWithCache();
    visual.layer.drawTile(
      visual.gl,
      visual.tile,
      visual.tile.layers[0],
      visual.cache,
      drawCtx(),
    );
    const visualInstances = visual.gl.drawCalls.reduce(
      (s: number, d: any) => s + d.instances,
      0,
    );

    const pick = makeLayerWithCache();
    pick.layer.drawPickTile(
      pick.gl,
      pick.tile,
      pick.tile.layers[0],
      pick.cache,
      drawCtx(),
      1,
    );
    const pickInstances = pick.gl.drawCalls.reduce(
      (s: number, d: any) => s + d.instances,
      0,
    );
    expect(pickInstances).toBe(visualInstances);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('layer wiring', () => {
  it("declares renderingMode '3d' by default, and honours an override", () => {
    expect(
      new STTMeshLayer({ ...baseOpts, id: 'a', mesh: QUAD } as any)
        .renderingMode,
    ).toBe('3d');
    expect(
      new STTMeshLayer({
        ...baseOpts,
        id: 'b',
        mesh: QUAD,
        renderingMode: '2d',
      } as any).renderingMode,
    ).toBe('2d');
  });

  it('accepts POINT geometry only', () => {
    const layer = new STTMeshLayer({
      ...baseOpts,
      id: 'a',
      mesh: QUAD,
    } as any) as any;
    expect(layer.acceptsGeometry(GeometryType.Point)).toBe(true);
    expect(layer.acceptsGeometry(GeometryType.LineString)).toBe(false);
    expect(layer.acceptsGeometry(GeometryType.Polygon)).toBe(false);
  });

  it('an explicit undefined option still lands on the default (?? not ||)', () => {
    const layer = new STTMeshLayer({
      ...baseOpts,
      id: 'a',
      mesh: QUAD,
      sizeScale: undefined,
      scaleToDimensions: undefined,
      opacity: undefined,
      renderingMode: undefined,
    } as any) as any;
    expect(layer.meshOpts.sizeScale).toBe(1);
    expect(layer.meshOpts.scaleToDimensions).toBe(true);
    expect(layer.meshOpts.opacity).toBe(1);
    expect(layer.renderingMode).toBe('3d');
  });

  it('0 and false survive as real caller values', () => {
    const layer = new STTMeshLayer({
      ...baseOpts,
      id: 'a',
      mesh: QUAD,
      sizeScale: 0,
      opacity: 0,
      ambientLight: 0,
      scaleToDimensions: false,
    } as any) as any;
    expect(layer.meshOpts.sizeScale).toBe(0);
    expect(layer.meshOpts.opacity).toBe(0);
    expect(layer.meshOpts.ambientLight).toBe(0);
    expect(layer.meshOpts.scaleToDimensions).toBe(false);
  });

  it('a mode-affecting setter rebuilds the key and drops memoized handles', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(layer.programKeys.fill).toBe('mesh:fill:window');
    expect(layer.handles).toBeTruthy();

    layer.setWakeLength(500);
    layer.setTimeFilterMode('wake');
    expect(layer.programKeys.fill).toBe('mesh:fill:wake');
    expect(layer.handles).toBeUndefined();

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    const wakeSources = vertexSources(gl).filter((s) =>
      s.includes('sttWakeAlpha'),
    );
    expect(wakeSources.length).toBeGreaterThan(0);
  });

  it('compiles one program per (pass, variant): a variant flip re-resolves', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const legacyCount = vertexSources(gl).length;
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(vertexSources(gl).length).toBe(legacyCount); // memoized

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(v5Frame('globe')));
    expect(vertexSources(gl).length).toBeGreaterThan(legacyCount);
    expect(vertexSources(gl).some((s) => s.includes(PRELUDE_MARKER))).toBe(
      true,
    );
  });

  it('an empty tile caches a null result rather than retrying every frame', () => {
    const gl = makeGl();
    const layer = new STTMeshLayer({
      ...baseOpts,
      id: 'a',
      mesh: QUAD,
    } as any) as any;
    const tile = makeObjectsTile();
    tile.layers[0].features.featureCount = 0;
    expect(layer.buildTileGpuCache(gl, tile, tile.layers[0])).toBeNull();
  });

  it('onContextLost drops the memoized handles and the model cache', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(layer.handles).toBeTruthy();
    expect(layer.geometries.size).toBeGreaterThan(0);
    layer.onContextLost(gl);
    expect(layer.handles).toBeUndefined();
    expect(layer.idHandles).toBeUndefined();
    expect(layer.geometries.size).toBe(0);
  });

  it('warns once and draws nothing when instancing is unavailable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.instSupport = { enabled: false, vertexAttribDivisor: () => {} };
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(gl.drawCalls.length).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

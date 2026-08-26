/**
 * Bounding-box layer: one oriented cuboid per ACTIVE TRACK at the play-head.
 *
 * The suite is organised around the defect this kind exists to kill — the
 * "train" of ghost boxes a time-WINDOW filter draws behind every car, one per
 * keyframe inside the window — and then covers the usual per-kind surface:
 *
 *  - **The motion contract (CPU, no GL)** — pooling by `track_id` across tiles
 *    with DIFFERENT `timeOffset`s, one instance per active track whatever the
 *    window is, implicit activity from the keyframe span, and shortest-arc
 *    heading.
 *  - **JS references** — `boxRotation` (the CPU half of `sttRotateBox`, with
 *    the mercator-y flip), `boundingBoxFilterValue`, the unit-cube constants
 *    and the time-mode degradation table.
 *  - **Shader strings** — both host variants (legacy `uMatrix` / v5 injected
 *    prelude) × all four time modes × filter on/off × both passes; the default
 *    configuration compiles NONE of the optional surface, and the id pass's
 *    alpha gates match the visual pass's exactly.
 *  - **mock-gl draws** — the instanced draw shape, the once-per-FRAME layer
 *    draw (not once per tile), absolute time uniforms, wireframe topology, and
 *    a pick pass that paints the same instances and leaves no divisor dirty.
 *
 * Real prelude compilation and the pick FBO round-trip stay browser-verified.
 */

import { describe, it, expect, vi } from 'vitest';
import { GeometryType, type Layer, type Tile } from '@poopdeck.gl/core';
import { normalizeRenderArgs } from '../src/lib/host-adapter';
import {
  BOUNDING_BOX_FILTERABLE_COLUMNS,
  BOX_FILL_INDICES,
  BOX_UNIT_VERTICES,
  BOX_WIRE_INDICES,
  STTBoundingBoxLayer,
  boundingBoxFilterValue,
  boundingBoxProgramKey,
  boxRotation,
  buildBoundingBoxIdVertexSource,
  buildBoundingBoxVertexSource,
  resolveBoundingBoxTimeFilterMode,
  type BoundingBoxShaderConfig,
} from '../src/layers/bounding-box-layer';
import { DATA_FILTER_CALL_GLSL } from '../src/shaders/data-filter.glsl';
import {
  mercatorZFromAltitude,
  metersToMercatorUnits,
} from '../src/lib/projection';
import { makeMockGl } from './mock-gl';

const T0 = 1_700_000_000_000;

const baseOpts = {
  url: 'mem://av-objects.stt',
  currentTime: T0 + 1000,
  timeWindow: 5000,
};

const PRELUDE_MARKER = '// __HOST_PRELUDE__';
const PRELUDE = `${PRELUDE_MARKER}
uniform mat4 u_projection_matrix;
vec4 projectTile(vec2 p) { return u_projection_matrix * vec4(p, 0.0, 1.0); }
vec4 projectTileFor3D(vec2 p, float elev) { return u_projection_matrix * vec4(p, elev, 1.0); }`;
const LEGACY_SHADER = { prelude: '', define: '' };
const V5_SHADER = { prelude: PRELUDE, define: '#define GLOBE' };

const cfg = (
  over: Partial<BoundingBoxShaderConfig> = {},
): BoundingBoxShaderConfig => ({ mode: 'window', filter: false, ...over });

const ALL_MODES = ['window', 'wake', 'cumulative', 'trail'] as const;

// ── fixtures ────────────────────────────────────────────────────────────────

interface Snapshot {
  track: string;
  category?: string;
  t: number;
  lon: number;
  lat: number;
  heading?: number;
  length?: number;
  width?: number;
  height?: number;
  speed?: number;
}

/**
 * An AV `objects/` POINT tile: one feature per tracked object PER KEYFRAME.
 * `test/fixtures.ts` has no such builder (its point tiles are one-row-per-
 * feature), so it is defined locally — deliberately, since the whole contract
 * under test is "many rows, one box".
 */
function makeObjectsTile(
  snapshots: Snapshot[],
  {
    timeOffset = T0,
    id = { z: 14, x: 2620, y: 6333, t: T0 },
    name = 'objects',
  }: { timeOffset?: number; id?: Tile['id']; name?: string } = {},
): Tile {
  const n = snapshots.length;
  const positions = new Float64Array(n * 2);
  const startTimes = new Float32Array(n);
  const endTimes = new Float32Array(n);
  const heading = new Float32Array(n);
  const length = new Float32Array(n);
  const width = new Float32Array(n);
  const height = new Float32Array(n);
  const speed = new Float32Array(n);

  const trackCats: string[] = [];
  const trackIdx = new Uint16Array(n);
  const catCats: string[] = [];
  const catIdx = new Uint16Array(n);

  snapshots.forEach((s, i) => {
    positions[i * 2] = s.lon;
    positions[i * 2 + 1] = s.lat;
    startTimes[i] = s.t;
    endTimes[i] = s.t;
    heading[i] = s.heading ?? 0;
    length[i] = s.length ?? 4;
    width[i] = s.width ?? 2;
    height[i] = s.height ?? 1.5;
    speed[i] = s.speed ?? 10;
    let ti = trackCats.indexOf(s.track);
    if (ti < 0) ti = trackCats.push(s.track) - 1;
    trackIdx[i] = ti;
    const category = s.category ?? 'car';
    let ci = catCats.indexOf(category);
    if (ci < 0) ci = catCats.push(category) - 1;
    catIdx[i] = ci;
  });

  const layer: Layer = {
    name,
    extent: 4096,
    features: {
      featureCount: n,
      geometryType: GeometryType.Point,
      positionDimensions: 2 as const,
      positions,
      featureIds: new Uint32Array(n).map((_, i) => i),
      startTimes,
      endTimes,
      timeOffset,
      numericProps: { heading, length, width, height, speed },
      categoricalProps: {
        track_id: { indices: trackIdx, categories: trackCats },
        category: { indices: catIdx, categories: catCats },
      },
    },
    geometryExtensionName: 'geoarrow.point',
  } as unknown as Layer;

  return {
    id,
    timeRange: { start: timeOffset, end: timeOffset + 10_000 },
    layers: [layer],
  } as Tile;
}

/** One car with `count` keyframes, 1 s apart, driving east. */
function drivingTrack(track: string, count: number, from = 0): Snapshot[] {
  return Array.from({ length: count }, (_, i) => ({
    track,
    t: (from + i) * 1000,
    lon: -122.4 + (from + i) * 0.0001,
    lat: 37.79,
    heading: 0,
    speed: 10 + i,
  }));
}

function makeLayer(extra: Record<string, unknown> = {}, gl?: any) {
  const layer = new STTBoundingBoxLayer({
    ...baseOpts,
    id: 'bb',
    ...extra,
  } as any) as any;
  layer.supports32BitIndices = true;
  if (gl) {
    // The shared recorder hands every attribute location 0, which would make a
    // per-slot assertion (divisors!) vacuous — give each NAME its own slot, the
    // way a real linker does.
    const slots = new Map<string, number>();
    gl.getAttribLocation = vi.fn((_p: unknown, name: string) => {
      if (!slots.has(name)) slots.set(name, slots.size);
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

/** Attach `tiles` as the layer's resident set (no tileset needed for these). */
function residentTiles(layer: any, ...tiles: Tile[]): void {
  layer.loadedTiles = new Map(
    tiles.map((t) => [`${t.id.z}/${t.id.x}/${t.id.y}/${t.id.t}`, t]),
  );
}

const mat16 = () => new Float32Array(16);
const legacyFrame = () => normalizeRenderArgs(mat16());

const drawCtx = (over: Record<string, unknown> = {}) => ({
  matrix: mat16(),
  frame: legacyFrame(),
  windowStart: -2500,
  windowEnd: 2500,
  currentTime: baseOpts.currentTime,
  zoom: 14,
  ...over,
});

const vertexSources = (gl: any): string[] =>
  gl.shaderSource.mock.calls.map((c: unknown[]) => c[1] as string);

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

// ── INVARIANT 1: no train ───────────────────────────────────────────────────

describe('one instance per active track (the anti-train contract)', () => {
  it('emits ONE box for a track with many keyframes inside the window', () => {
    const layer = makeLayer({ timeWindow: 60_000 });
    residentTiles(layer, makeObjectsTile(drivingTrack('car-1', 10)));
    const out = layer.sampleInstancesAt(T0 + 5000);
    expect(out.count).toBe(1);
  });

  it('scales with OBJECTS, not with keyframes or window width', () => {
    const snaps = [
      ...drivingTrack('car-1', 12),
      ...drivingTrack('car-2', 12),
      ...drivingTrack('car-3', 12),
    ];
    for (const timeWindow of [1, 1000, 600_000]) {
      const layer = makeLayer({ timeWindow });
      residentTiles(layer, makeObjectsTile(snaps));
      expect(layer.sampleInstancesAt(T0 + 5000).count).toBe(3);
    }
  });

  it('activity is implicit in the keyframe span — no window uniform decides it', () => {
    const layer = makeLayer({ timeWindow: 600_000 });
    residentTiles(layer, makeObjectsTile(drivingTrack('car-1', 5))); // 0..4000
    expect(layer.sampleInstancesAt(T0 - 1).count).toBe(0);
    expect(layer.sampleInstancesAt(T0).count).toBe(1);
    expect(layer.sampleInstancesAt(T0 + 4000).count).toBe(1);
    expect(layer.sampleInstancesAt(T0 + 4001).count).toBe(0);
  });

  it('pools across tiles with DIFFERENT timeOffsets onto one timeline', () => {
    // Same car, second half of its life in a tile based 4 s later. A pooler
    // that forgot to rebase would see two tracks (or a wildly wrong span).
    const early = makeObjectsTile(drivingTrack('car-1', 4), {
      timeOffset: T0,
      id: { z: 14, x: 2620, y: 6333, t: T0 },
    });
    const late = makeObjectsTile(drivingTrack('car-1', 4, 0), {
      timeOffset: T0 + 4000,
      id: { z: 14, x: 2620, y: 6333, t: T0 + 4000 },
    });
    const layer = makeLayer({ timeWindow: 600_000 });
    residentTiles(layer, early, late);

    // One box, and the span reaches from the first tile's t=0 to the second's
    // t=3000 → 7 s of absolute lifespan.
    const out = layer.sampleInstancesAt(T0 + 5000);
    expect(out.count).toBe(1);
    // Times are LAYER-relative (a float32 attribute cannot hold epoch-ms):
    // the base is the smallest resident tile offset, here the early tile's.
    expect(out.timeBase).toBe(T0);
    expect(out.times[0]).toBeCloseTo(0, 3);
    expect(out.times[1]).toBeCloseTo(7000, 3);
    // …and it is still live at a play-head only the LATE tile covers.
    expect(layer.sampleInstancesAt(T0 + 6500).count).toBe(1);
  });

  it('holds a single-keyframe track for its hold window, then drops it', () => {
    const layer = makeLayer({ singletonHoldMs: 600 });
    residentTiles(layer, makeObjectsTile(drivingTrack('lone', 1)));
    expect(layer.sampleInstancesAt(T0).count).toBe(1);
    expect(layer.sampleInstancesAt(T0 + 299).count).toBe(1);
    expect(layer.sampleInstancesAt(T0 + 301).count).toBe(0);
  });
});

// ── INVARIANT 2: shortest-arc heading ───────────────────────────────────────

describe('heading interpolation', () => {
  it('crosses 0 rather than unwinding through 180 (degrees)', () => {
    const layer = makeLayer({ headingUnits: 'degrees' });
    residentTiles(
      layer,
      makeObjectsTile([
        { track: 'car-1', t: 0, lon: -122.4, lat: 37.79, heading: 350 },
        { track: 'car-1', t: 1000, lon: -122.4, lat: 37.79, heading: 10 },
      ]),
    );
    const out = layer.sampleInstancesAt(T0 + 500);
    // Shortest arc: 350 → 10 passes through 0. The long way would land on 180,
    // whose rotation is (-1, 0).
    expect(out.rots[0]).toBeCloseTo(1, 6);
    expect(out.rots[1]).toBeCloseTo(0, 6);
    // 360 and 0 are the same bearing; what must NOT happen is 180.
    const wrapped = ((out.samples[0].heading % 360) + 360) % 360;
    expect(Math.min(wrapped, 360 - wrapped)).toBeCloseTo(0, 6);
  });

  it('crosses 0 rather than unwinding through PI (radians)', () => {
    const layer = makeLayer({});
    const nearTwoPi = 2 * Math.PI - 0.2;
    residentTiles(
      layer,
      makeObjectsTile([
        { track: 'c', t: 0, lon: -122.4, lat: 37.79, heading: nearTwoPi },
        { track: 'c', t: 1000, lon: -122.4, lat: 37.79, heading: 0.2 },
      ]),
    );
    const out = layer.sampleInstancesAt(T0 + 500);
    expect(out.rots[0]).toBeCloseTo(Math.cos(0), 5);
    expect(out.rots[1]).toBeCloseTo(-Math.sin(0), 5);
  });

  it('boxRotation bakes the mercator-y flip and degrades on NaN', () => {
    expect(boxRotation(0)).toEqual([1, -0]);
    const [c, s] = boxRotation(Math.PI / 2);
    expect(c).toBeCloseTo(0, 12);
    expect(s).toBeCloseTo(-1, 12);
    // NaN heading ⇒ identity ⇒ an axis-aligned box: the honest rendering of
    // "orientation unknown".
    expect(boxRotation(Number.NaN)).toEqual([1, 0]);
    expect(boxRotation(Infinity)).toEqual([1, 0]);
  });
});

// ── INVARIANT 3: metric sizing + elevation units ────────────────────────────

describe('metric sizing', () => {
  it("bakes half-extents into mercator units at the BOX's own latitude", () => {
    const layer = makeLayer({});
    residentTiles(
      layer,
      makeObjectsTile([
        {
          track: 'c',
          t: 0,
          lon: 0,
          lat: 60,
          length: 5,
          width: 2,
          height: 1.8,
        },
        {
          track: 'c',
          t: 1000,
          lon: 0,
          lat: 60,
          length: 5,
          width: 2,
          height: 1.8,
        },
      ]),
    );
    const out = layer.sampleInstancesAt(T0 + 500);
    const perMeter = metersToMercatorUnits(1, 60);
    expect(out.dims[0]).toBeCloseTo(2.5 * perMeter, 12);
    expect(out.dims[1]).toBeCloseTo(1.0 * perMeter, 12);
    // Height stays in METRES; its own metres→mercator-z factor rides alongside,
    // because elevation units are host-variant dependent.
    expect(out.dims[2]).toBeCloseTo(1.8, 6);
    expect(out.dims[3]).toBeCloseTo(mercatorZFromAltitude(1, 60), 12);
  });

  it('sizeScale multiplies all three extents; elevationScale only the height', () => {
    const snaps = [
      { track: 'c', t: 0, lon: 0, lat: 0, length: 4, width: 2, height: 2 },
      { track: 'c', t: 1000, lon: 0, lat: 0, length: 4, width: 2, height: 2 },
    ];
    const plain = makeLayer({});
    residentTiles(plain, makeObjectsTile(snaps));
    const a = plain.sampleInstancesAt(T0 + 500);

    const scaled = makeLayer({ sizeScale: 2, elevationScale: 3 });
    residentTiles(scaled, makeObjectsTile(snaps));
    const b = scaled.sampleInstancesAt(T0 + 500);

    expect(b.dims[0]).toBeCloseTo(a.dims[0] * 2, 12);
    expect(b.dims[1]).toBeCloseTo(a.dims[1] * 2, 12);
    expect(b.dims[2]).toBeCloseTo(a.dims[2] * 6, 6);
  });
});

// ── INVARIANT 4: the unit cube ──────────────────────────────────────────────

describe('unit cube', () => {
  it('has 8 corners spanning [-0.5,0.5]² × [0,1]', () => {
    expect(BOX_UNIT_VERTICES.length).toBe(24);
    for (let i = 0; i < 8; i++) {
      expect(Math.abs(BOX_UNIT_VERTICES[i * 3])).toBeCloseTo(0.5, 12);
      expect(Math.abs(BOX_UNIT_VERTICES[i * 3 + 1])).toBeCloseTo(0.5, 12);
      expect([0, 1]).toContain(BOX_UNIT_VERTICES[i * 3 + 2]);
    }
    // Four on the base, four on the top — the pose sits on the base by default.
    const tops = [...BOX_UNIT_VERTICES].filter((_, i) => i % 3 === 2 && true);
    expect(tops.filter((z) => z === 1).length).toBe(4);
  });

  it('closes 12 triangles and 12 edges over those corners', () => {
    expect(BOX_FILL_INDICES.length).toBe(36);
    expect(BOX_WIRE_INDICES.length).toBe(24);
    for (const idx of [...BOX_FILL_INDICES, ...BOX_WIRE_INDICES]) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(8);
    }
    // Every corner participates in both topologies.
    expect(new Set(BOX_FILL_INDICES).size).toBe(8);
    expect(new Set(BOX_WIRE_INDICES).size).toBe(8);
  });
});

// ── INVARIANT 5: time-mode degradation ──────────────────────────────────────

describe('resolveBoundingBoxTimeFilterMode', () => {
  it('honours an explicit mode, degrading a mode with no length to window', () => {
    expect(resolveBoundingBoxTimeFilterMode('cumulative', 0, 0)).toBe(
      'cumulative',
    );
    expect(resolveBoundingBoxTimeFilterMode('wake', 0, 0)).toBe('window');
    expect(resolveBoundingBoxTimeFilterMode('wake', 500, 0)).toBe('wake');
    expect(resolveBoundingBoxTimeFilterMode('trail', 0, 0)).toBe('window');
    expect(resolveBoundingBoxTimeFilterMode('trail', 0, 500)).toBe('trail');
    expect(resolveBoundingBoxTimeFilterMode('window', 500, 500)).toBe('window');
  });

  it('applies deck precedence when unset', () => {
    expect(resolveBoundingBoxTimeFilterMode(undefined, 0, 0)).toBe('window');
    expect(resolveBoundingBoxTimeFilterMode(undefined, 500, 500)).toBe('wake');
    expect(resolveBoundingBoxTimeFilterMode(undefined, 0, 500)).toBe('trail');
  });
});

// ── INVARIANT 6: DataFilter column resolution ───────────────────────────────

describe('DataFilter', () => {
  it('reads the pooled numeric off the INTERPOLATED pose', () => {
    const layer = makeLayer({ filterProperty: 'speed', filterRange: [0, 100] });
    residentTiles(layer, makeObjectsTile(drivingTrack('c', 3))); // speed 10,11,12
    const out = layer.sampleInstancesAt(T0 + 500);
    expect(out.count).toBe(1);
    expect(out.filterValues[0]).toBeCloseTo(10.5, 5);
    expect(layer.hasFilterColumn).toBe(true);
  });

  it('degrades to UNFILTERED (never blank) on a column the pool does not carry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = makeLayer({
      filterProperty: 'magnitude',
      filterRange: [0, 1],
    });
    residentTiles(layer, makeObjectsTile(drivingTrack('c', 3)));
    const out = layer.sampleInstancesAt(T0 + 500);
    expect(out.count).toBe(1); // still drawn
    expect(layer.hasFilterColumn).toBe(false);
    layer.sampleInstancesAt(T0 + 600);
    expect(warn).toHaveBeenCalledTimes(1); // warned ONCE
    warn.mockRestore();
  });

  it('boundingBoxFilterValue covers exactly the pooled columns', () => {
    const sample = {
      lon: 0,
      lat: 0,
      alt: 7,
      heading: 1,
      length: 4,
      width: 2,
      height: 1.5,
      speed: 11,
      alpha: 1,
      track: {} as never,
    };
    for (const col of BOUNDING_BOX_FILTERABLE_COLUMNS) {
      expect(
        Number.isFinite(boundingBoxFilterValue(sample as never, col)),
      ).toBe(true);
    }
    expect(boundingBoxFilterValue(sample as never, 'magnitude')).toBeNaN();
  });
});

// ── shader assembly ─────────────────────────────────────────────────────────

describe('vertex source', () => {
  it('the default configuration compiles NONE of the optional surface', () => {
    const src = buildBoundingBoxVertexSource(LEGACY_SHADER, cfg());
    expect(src).toContain('uniform mat4 uMatrix;');
    expect(src).not.toContain('projectTile');
    expect(src).not.toContain(DATA_FILTER_CALL_GLSL);
    expect(src).not.toContain('aFilterValue');
    expect(src).not.toContain('aIdColor');
    expect(src).toContain('sttTimeWindowAlpha');
    expect(src).not.toContain('sttWakeAlpha');
    expect(src).not.toContain('sttTrailAlpha');
    expect(src).not.toContain('sttCumulativeAlpha');
  });

  it('never gates EXISTENCE on a window — the window only modulates alpha', () => {
    // The one and only use of the window uniforms is inside the alpha
    // expression; nothing else in main() reads them.
    const src = buildBoundingBoxVertexSource(LEGACY_SHADER, cfg());
    const main = src.slice(src.indexOf('void main()'));
    const windowUses = main.match(/uWindowStart/g) ?? [];
    expect(windowUses.length).toBe(1);
    expect(main).toContain(
      'vAlpha = sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut) * uOpacity;',
    );
  });

  it('splices exactly one time kernel per mode, and never the wake taper', () => {
    for (const mode of ALL_MODES) {
      const src = buildBoundingBoxVertexSource(LEGACY_SHADER, cfg({ mode }));
      const kernels = [
        'sttTimeWindowAlpha',
        'sttWakeAlpha',
        'sttCumulativeAlpha',
        'sttTrailAlpha',
      ].filter((k) => src.includes(k));
      expect(kernels.length).toBe(1);
      // A cuboid's extents are physical facts — the wake tail must not shrink
      // them (the summary-cell rule). The shared kernel DECLARES the taper
      // helper; what matters is that main() never calls it and that the
      // plain (non-tail-scale) uniform block was spliced.
      const main = src.slice(src.indexOf('void main()'));
      expect(main).not.toContain('sttWakeSizeScale');
      expect(src).not.toContain('uWakeTailScale');
    }
  });

  it('declares uFilterTransformSize but never reads it', () => {
    const src = buildBoundingBoxVertexSource(
      LEGACY_SHADER,
      cfg({ filter: true }),
    );
    expect(src).toContain('uFilterTransformSize');
    const main = src.slice(src.indexOf('void main()'));
    expect(main).not.toContain('uFilterTransformSize');
    expect(main).toContain('uFilterTransformColor');
  });

  it('projects through the prelude on a v5 host and keeps its uniform names', () => {
    const src = buildBoundingBoxVertexSource(V5_SHADER, cfg());
    expect(src).toContain(PRELUDE_MARKER);
    expect(src.indexOf(PRELUDE_MARKER)).toBe(0);
    expect(src).toContain('#define GLOBE');
    expect(src).not.toContain('uniform mat4 uMatrix;');
    expect(src).toContain('projectTileFor3D');
    expect(src).toContain('u_projection_matrix');
  });

  it('carries the per-instance metres→mercator-z factor into the projection', () => {
    // The elevation unit split (globe wants metres, mercator/legacy want
    // mercator-z) is fed from aDims.w — a UNIFORM would be wrong here, since
    // one draw spans instances at many latitudes.
    for (const shader of [LEGACY_SHADER, V5_SHADER]) {
      const src = buildBoundingBoxVertexSource(shader, cfg());
      expect(src).toContain('aDims.w');
    }
  });

  it("the id pass reproduces the visual pass's geometry and gates exactly", () => {
    for (const mode of ALL_MODES) {
      for (const filter of [false, true]) {
        for (const shader of [LEGACY_SHADER, V5_SHADER]) {
          const c = cfg({ mode, filter });
          const vis = buildBoundingBoxVertexSource(shader, c);
          const id = buildBoundingBoxIdVertexSource(shader, c);
          // Same geometry, same projection: assert the load-bearing lines are
          // byte-identical rather than eyeballing two copies.
          for (const line of [
            '    vec2 local = vec2(aUnit.x * aDims.x, aUnit.y * aDims.y);',
            '    vec2 posM = aCenter.xy + sttRotateBox(local, aRot);',
            '    float elevM = aCenter.z + (aUnit.z - uZAnchor) * aDims.z;',
            '    gl_Position = here;',
            '    if (vAlpha <= 0.0) gl_Position = vec4(0.0);',
          ]) {
            expect(vis).toContain(line);
            expect(id).toContain(line);
          }
          // Same alpha gate…
          expect(id).toContain(
            `vAlpha = ${vis.slice(
              vis.indexOf('vAlpha = ') + 9,
              vis.indexOf(';\n', vis.indexOf('vAlpha = ')),
            )};`,
          );
          // …plus the colour-alpha gate the visual pass applies in its FS, so
          // a category mapped to alpha 0 is invisible AND unpickable.
          expect(id).toContain('vAlpha *= aColor.a;');
          expect(id).toContain('attribute vec3 aIdColor;');
          expect(vis).not.toContain('aIdColor');
          if (filter) {
            expect(vis).toContain(DATA_FILTER_CALL_GLSL);
            expect(id).toContain(DATA_FILTER_CALL_GLSL);
          }
        }
      }
    }
  });
});

describe('program cache key', () => {
  it('carries every structural axis this layer compiles', () => {
    const keys = new Set<string>();
    for (const pass of ['fill', 'pick'] as const) {
      for (const mode of ALL_MODES) {
        for (const filter of [false, true]) {
          keys.add(boundingBoxProgramKey(pass, cfg({ mode, filter })));
        }
      }
    }
    expect(keys.size).toBe(2 * 4 * 2);
    expect(boundingBoxProgramKey('fill', cfg())).toBe(
      'boundingBox:fill:window',
    );
    expect(
      boundingBoxProgramKey('pick', cfg({ mode: 'wake', filter: true })),
    ).toBe('boundingBox:pick:wake:filter');
  });
});

// ── draw ────────────────────────────────────────────────────────────────────

describe('drawTile', () => {
  function mounted(extra: Record<string, unknown> = {}, snaps?: Snapshot[]) {
    const gl = makeMockGl();
    const layer = makeLayer(extra, gl);
    const tile = makeObjectsTile(
      snaps ?? [...drivingTrack('a', 4), ...drivingTrack('b', 4)],
    );
    residentTiles(layer, tile);
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    return { gl, layer, tile, cache };
  }

  it('draws ONE instanced elements call, one instance per active track', () => {
    const { gl, layer, tile, cache } = mounted();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(gl.drawCalls).toHaveLength(1);
    expect(gl.drawCalls[0]).toMatchObject({
      kind: 'elements-instanced',
      instances: 2,
    });
  });

  it('draws once per FRAME, not once per resident tile', () => {
    const gl = makeMockGl();
    const layer = makeLayer({}, gl);
    const a = makeObjectsTile(drivingTrack('a', 4), {
      id: { z: 14, x: 2620, y: 6333, t: T0 },
    });
    const b = makeObjectsTile(drivingTrack('b', 4), {
      id: { z: 14, x: 2621, y: 6333, t: T0 },
    });
    residentTiles(layer, a, b);
    const cacheA = layer.buildTileGpuCache(gl, a, a.layers[0]);
    const cacheB = layer.buildTileGpuCache(gl, b, b.layers[0]);

    // The base arms the layer draw once per render(), immediately before its
    // tile loop; both tiles then call drawTile.
    layer.applySharedGlState(gl);
    layer.drawTile(gl, a, a.layers[0], cacheA, drawCtx());
    layer.drawTile(gl, b, b.layers[0], cacheB, drawCtx());
    expect(gl.drawCalls).toHaveLength(1);
    // …and both tracks are in that one draw.
    expect(gl.drawCalls[0].instances).toBe(2);

    // Next frame re-arms.
    layer.applySharedGlState(gl);
    layer.drawTile(gl, a, a.layers[0], cacheA, drawCtx());
    expect(gl.drawCalls).toHaveLength(2);
  });

  it('draws nothing when no track is active at the play-head', () => {
    const { gl, layer, tile, cache } = mounted();
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx({ currentTime: T0 + 900_000 }),
    );
    expect(gl.drawCalls).toHaveLength(0);
  });

  it('wireframe swaps the index topology, not the program', () => {
    const solid = mounted();
    solid.layer.drawTile(
      solid.gl,
      solid.tile,
      solid.tile.layers[0],
      solid.cache,
      drawCtx(),
    );
    const wire = mounted({ wireframe: true });
    wire.layer.drawTile(
      wire.gl,
      wire.tile,
      wire.tile.layers[0],
      wire.cache,
      drawCtx(),
    );
    // The mock records `vertices` = the index count handed to the draw; the
    // primitive mode only reaches the spy's args.
    expect(solid.gl.drawCalls[0].vertices).toBe(36);
    expect(solid.gl.drawElementsInstanced.mock.calls[0][0]).toBe(
      solid.gl.TRIANGLES,
    );
    expect(wire.gl.drawCalls[0].vertices).toBe(24);
    expect(wire.gl.drawElementsInstanced.mock.calls[0][0]).toBe(wire.gl.LINES);
    expect(wire.gl.shaderSource.mock.calls.length).toBe(
      solid.gl.shaderSource.mock.calls.length,
    );
    // A cage reads as one flat colour: the vertical shade ramp is switched off.
    expect(lastScalar(uniformsByName(wire.gl), 'uWallShade')).toBe(1);
  });

  it('time uniforms are LAYER-relative, in the same frame as aTime', () => {
    const { gl, layer, tile, cache } = mounted();
    const ctx = drawCtx();
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    const u = uniformsByName(gl);
    const base = layer.timeBase;
    expect(base).toBe(T0);
    // The base re-absolutizes off the cache (windowStart was derived with that
    // same offset), then rebases onto the layer's own origin.
    expect(lastScalar(u, 'uWindowStart')).toBeCloseTo(
      ctx.windowStart + cache.timeOffset - base,
      3,
    );
    expect(lastScalar(u, 'uWindowEnd')).toBeCloseTo(
      ctx.windowEnd + cache.timeOffset - base,
      3,
    );
    // A float32 attribute could not have carried the absolute value at all.
    expect(Math.abs(lastScalar(u, 'uWindowStart') as number)).toBeLessThan(1e7);
  });

  it('wake/trail/cumulative upload the rebased play-head', () => {
    for (const [extra, mode] of [
      [{ timeFilterMode: 'wake', wakeLength: 2000 }, 'wake'],
      [{ timeFilterMode: 'trail', trailLength: 2000 }, 'trail'],
      [{ timeFilterMode: 'cumulative' }, 'cumulative'],
    ] as const) {
      const { gl, layer, tile, cache } = mounted(extra as never);
      expect(layer.compiledShaderConfig.mode).toBe(mode);
      const ctx = drawCtx();
      layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
      const u = uniformsByName(gl);
      expect(lastScalar(u, 'uCurrentTime')).toBe(
        ctx.currentTime - layer.timeBase,
      );
      expect(u.has('uWindowStart')).toBe(false);
    }
  });

  it('zAnchor moves the pose between the base and the centroid', () => {
    const base = mounted();
    base.layer.drawTile(
      base.gl,
      base.tile,
      base.tile.layers[0],
      base.cache,
      drawCtx(),
    );
    expect(lastScalar(uniformsByName(base.gl), 'uZAnchor')).toBe(0);

    const mid = mounted({ zAnchor: 'center' });
    mid.layer.drawTile(
      mid.gl,
      mid.tile,
      mid.tile.layers[0],
      mid.cache,
      drawCtx(),
    );
    expect(lastScalar(uniformsByName(mid.gl), 'uZAnchor')).toBe(0.5);
  });

  it('compiles one program per host variant and reuses it', () => {
    const { gl, layer, tile, cache } = mounted();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    const after1 = vertexSources(gl).length;
    layer.applySharedGlState(gl);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(vertexSources(gl).length).toBe(after1);
  });

  it('setTimeFilterMode relinks against a NEW cache key', () => {
    const { gl, layer, tile, cache } = mounted();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    const before = vertexSources(gl).length;
    layer.wakeLength = 2000;
    layer.boxOpts.wakeLength = 2000;
    layer.setTimeFilterMode('wake');
    expect(layer.compiledShaderConfig.mode).toBe('wake');
    layer.applySharedGlState(gl);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx());
    expect(vertexSources(gl).length).toBeGreaterThan(before);
    expect(vertexSources(gl).at(-2)).toContain('sttWakeAlpha');
  });
});

// ── picking ─────────────────────────────────────────────────────────────────

describe('picking', () => {
  function mounted(extra: Record<string, unknown> = {}) {
    const gl = makeMockGl();
    const layer = makeLayer(extra, gl);
    const tile = makeObjectsTile([
      ...drivingTrack('a', 4),
      ...drivingTrack('b', 4),
    ]);
    residentTiles(layer, tile);
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.tileGpuCache.set(
      `${tile.id.z}/${tile.id.x}/${tile.id.y}/${tile.id.t}::objects::${tile.layers[0].features.geometryType}`,
      cache,
    );
    return { gl, layer, tile, cache };
  }

  it('is pickable at all (drawPickTile exists)', () => {
    const { layer } = mounted();
    expect(typeof layer.drawPickTile).toBe('function');
    expect(layer.renderingMode).toBe('3d');
  });

  it('allocates ONE contiguous 1-based range for the whole layer', () => {
    const { gl, layer } = mounted();
    const prov = layer.buildPickProvenance(gl);
    expect(prov).toHaveLength(1);
    expect(prov[0].idBase).toBe(1);
    expect(prov[0].count).toBe(2); // active TRACKS, not the 8 snapshots
  });

  it('returns no provenance when nothing is active', () => {
    const { gl, layer } = mounted({ currentTime: T0 + 900_000 });
    expect(layer.buildPickProvenance(gl)).toHaveLength(0);
  });

  it('paints the same instances as the visual pass and leaves divisors clean', () => {
    const { gl, layer, tile, cache } = mounted();
    layer.drawPickTile(gl, tile, tile.layers[0], cache, drawCtx(), 1);
    expect(gl.drawCalls).toHaveLength(1);
    expect(gl.drawCalls[0]).toMatchObject({
      kind: 'elements-instanced',
      instances: 2,
      vertices: 36,
    });
    // Every per-instance slot the pass enabled goes back to divisor 0 — a pick
    // runs outside the host's render pass, so nothing is self-healing.
    const enabled = new Set(
      gl.enableVertexAttribArray.mock.calls.map((c: unknown[]) => c[0]),
    );
    const disabled = new Set(
      gl.disableVertexAttribArray.mock.calls.map((c: unknown[]) => c[0]),
    );
    for (const slot of enabled) expect(disabled.has(slot)).toBe(true);
    const reset = gl.vertexAttribDivisor.mock.calls
      .filter((c: unknown[]) => c[1] === 0)
      .map((c: unknown[]) => c[0]);
    for (const slot of enabled) {
      if (slot === 0) continue; // aUnit is already divisor 0
      expect(reset).toContain(slot);
    }
    // The temp id buffer is freed immediately.
    expect(gl.deleteBuffer).toHaveBeenCalled();
  });

  it('resolves an id to the TRACK row, not to a tile feature row', () => {
    const { gl, layer } = mounted();
    const prov = layer.buildPickProvenance(gl);
    // id 1 → index 0 → the first active track ('a').
    const hit = layer.resolvePick([0, 0, 1], prov);
    expect(hit).not.toBeNull();
    expect(hit.index).toBe(0);
    expect(hit.object.track_id).toBe('a');
    expect(hit.object.category).toBe('car');
    expect(typeof hit.object.speed).toBe('number');
    expect(hit.layerId).toBe('objects');
    // Background and out-of-range stay null.
    expect(layer.resolvePick([0, 0, 0], prov)).toBeNull();
    expect(layer.resolvePick([0, 0, 200], prov)).toBeNull();
  });
});

// ── defaults ────────────────────────────────────────────────────────────────

describe('defaults are the pre-campaign behaviour', () => {
  it('renders solid, base-anchored, opaque cuboids in window mode at 3d', () => {
    const layer = makeLayer({});
    expect(layer.renderingMode).toBe('3d');
    expect(layer.compiledShaderConfig).toEqual({
      mode: 'window',
      filter: false,
    });
    expect(layer.boxOpts).toMatchObject({
      trackIdProperty: 'track_id',
      colorProperty: 'category',
      headingProperty: 'heading',
      headingUnits: 'radians',
      zAnchor: 'base',
      wireframe: false,
      opacity: 1,
      sizeScale: 1,
      elevationScale: 1,
      maxInterpolationGap: Infinity,
    });
  });

  it('honours 0 / false / explicit undefined through `??`', () => {
    const zeroed = makeLayer({
      opacity: 0,
      sizeScale: 0,
      wireframe: false,
      wallShade: 0,
    });
    expect(zeroed.boxOpts.opacity).toBe(0);
    expect(zeroed.boxOpts.sizeScale).toBe(0);
    expect(zeroed.boxOpts.wallShade).toBe(0);
    const forwarded = makeLayer({ opacity: undefined, zAnchor: undefined });
    expect(forwarded.boxOpts.opacity).toBe(1);
    expect(forwarded.boxOpts.zAnchor).toBe('base');
  });

  it('accepts 2d for a deliberately flat overlay', () => {
    expect(makeLayer({ renderingMode: '2d' }).renderingMode).toBe('2d');
  });
});

// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * `STTEgoLayer` — the `ego` kind.
 *
 * The claim this suite has to defend is unusual for a tile renderer: the ego
 * archive is BULK data (one POINT per pose sample, thousands per scene) and the
 * render is a SINGLETON (one interpolated marker). So the cases below are
 * pointed at the three things that can only go wrong here:
 *
 *   1. **Exactly one marker.** One draw call, 36 indices, no instancing —
 *      whether 4 keyframes are resident or 5,000, and whether they sit in one
 *      tile or several.
 *   2. **The interpolation.** A lerp between the bracketing keyframes, a
 *      SHORTEST-ARC heading lerp (the branch cut at ±π is the whole reason this
 *      is not `a + (b-a)*t`), and a clamp outside the log that lets the time
 *      filter — not a teleport to the origin — hide the marker.
 *   3. **Parity with the package.** The four shared time kernels spliced
 *      byte-identically, DataFilter, metric sizing, and an id pass whose alpha
 *      gates match the visual pass exactly.
 *
 * Shader assertions are string-level (this package ships no rasterizer); numeric
 * assertions go through the shared JS reference kernels so a change to the GLSL
 * side cannot drift past them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeometryType, type Tile, type Layer } from '@poopdeck.gl/core';
import {
  STTEgoLayer,
  buildEgoVertexSource,
  buildEgoIdVertexSource,
  buildEgoCuboidMesh,
  egoProgramKey,
  lerpHeadingShortestArc,
  resolveEgoTimeFilterMode,
  DEFAULT_EGO_LENGTH_M,
  DEFAULT_EGO_WIDTH_M,
  DEFAULT_EGO_HEIGHT_M,
} from '../src/layers/ego-layer';
import { DATA_FILTER_CALL_GLSL } from '../src/shaders/data-filter.glsl';
import { timeWindowAlphaJS } from '../src/shaders/time-window.glsl';
import {
  lngLatToMercator,
  metersToMercatorUnits,
  tileCenterLatitude,
} from '../src/lib/projection';
import { makeMockGl, makeMockMap, publishVisibleTiles } from './mock-gl';

const TIME_OFFSET = 1_700_000_000_000;
const baseOpts = {
  url: 'mem://ego.stt',
  currentTime: TIME_OFFSET + 500,
  timeWindow: 2_000,
};

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * A single-track ego pose tile: `count` POINT features stepping east at a fixed
 * cadence, optionally carrying heading / dimension / filter columns.
 *
 * `test/fixtures.ts` has no ego builder (the kind is new), so it lives here.
 * Times are TILE-RELATIVE, as every fixture in this package is — the epoch
 * lives in `timeOffset`.
 */
function makeEgoTile(
  o: {
    count?: number;
    step?: number;
    lon0?: number;
    lat0?: number;
    dLon?: number;
    dims?: 2 | 3;
    /** endTime − startTime per sample. Defaults to one cadence step. */
    dwell?: number;
    heading?: number[];
    numericProps?: Record<string, Float32Array>;
    tileId?: { z: number; x: number; y: number; t: number };
    /** Shuffle the feature order — the layer must sort on upload. */
    shuffle?: boolean;
  } = {},
): Tile {
  const count = o.count ?? 4;
  const step = o.step ?? 1_000;
  const lon0 = o.lon0 ?? -122.4;
  const lat0 = o.lat0 ?? 37.7;
  const dLon = o.dLon ?? 0.001;
  const dims = o.dims ?? 2;

  const order = Array.from({ length: count }, (_, i) => i);
  if (o.shuffle) order.reverse();

  const positions = new Float64Array(count * dims);
  const startTimes = new Float32Array(count);
  const endTimes = new Float32Array(count);
  const heading = o.heading ? new Float32Array(count) : null;
  for (let slot = 0; slot < count; slot++) {
    const i = order[slot];
    positions[slot * dims] = lon0 + i * dLon;
    positions[slot * dims + 1] = lat0;
    if (dims === 3) positions[slot * dims + 2] = 10 + i;
    startTimes[slot] = i * step;
    endTimes[slot] = i * step + (o.dwell ?? step);
    if (heading && o.heading) heading[slot] = o.heading[i];
  }

  const numericProps: Record<string, Float32Array> = { ...o.numericProps };
  if (heading) numericProps.heading = heading;

  const features = {
    featureCount: count,
    geometryType: GeometryType.Point,
    positionDimensions: dims,
    positions,
    featureIds: new Uint32Array(order),
    startTimes,
    endTimes,
    timeOffset: TIME_OFFSET,
    numericProps,
    categoricalProps: {},
  };
  const layer: Layer = {
    name: 'ego',
    extent: 4096,
    features,
    geometryExtensionName: 'geoarrow.point',
  } as unknown as Layer;
  return {
    id: o.tileId ?? { z: 14, x: 2620, y: 6333, t: TIME_OFFSET },
    timeRange: { start: TIME_OFFSET, end: TIME_OFFSET + count * step },
    layers: [layer],
  } as unknown as Tile;
}

function mount(
  extra: Record<string, unknown> = {},
  ...tiles: Tile[]
): { layer: any; gl: any; tiles: Tile[] } {
  const layer = new STTEgoLayer({
    ...baseOpts,
    id: 'ego',
    ...extra,
  } as any) as any;
  const gl = makeMockGl();
  // The shared recorder hands every attribute location 0; a unique slot per
  // NAME keeps enable/disable assertions from being vacuous.
  const slots = new Map<string, number>();
  gl.getAttribLocation = vi.fn((_p: unknown, name: string) => {
    if (!slots.has(name)) slots.set(name, slots.size + 1);
    return slots.get(name)!;
  });
  layer.map = makeMockMap();
  const drawn = tiles.length > 0 ? tiles : [makeEgoTile()];
  publishVisibleTiles(layer, ...drawn);
  return { layer, gl, tiles: drawn };
}

const MATRIX = new Float32Array(16).fill(2);

/** Uniform payloads uploaded to `name`, joined by location handle. */
function uniformArgs(gl: any, fn: string, name: string): number[][] {
  const handles = new Set(
    gl.getUniformLocation.mock.calls
      .map((c: unknown[], i: number) =>
        c[1] === name ? gl.getUniformLocation.mock.results[i].value : undefined,
      )
      .filter(Boolean),
  );
  return gl[fn].mock.calls
    .filter((c: unknown[]) => handles.has(c[0]))
    .map((c: unknown[]) => c.slice(1) as number[]);
}

/**
 * vec3 payloads uploaded to `name`. `uniform3fv` carries a REUSED scratch
 * array, so each entry is snapshotted by value at read time — only `.at(-1)`
 * is meaningful, which is all these cases ask for.
 */
function vec3Args(gl: any, name: string): number[][] {
  return uniformArgs(gl, 'uniform3fv', name).map((a: any) =>
    Array.from(a[0] as Float32Array),
  );
}

/** A hand-built DrawContext for the direct-hook cases. */
function drawCtx(currentTime: number, zoom = 14): any {
  return {
    matrix: MATRIX,
    currentTime,
    zoom,
    windowStart: currentTime - TIME_OFFSET - 1_000,
    windowEnd: currentTime - TIME_OFFSET + 1_000,
  };
}

let warn: any;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// ── 1. the singleton claim ──────────────────────────────────────────────────

describe('exactly ONE marker, whatever is resident', () => {
  it('draws one 36-index cuboid for a 4-keyframe track', () => {
    const { layer, gl } = mount();
    layer.render(gl, MATRIX);
    expect(gl.drawCalls).toEqual([{ kind: 'elements', count: 36 }]);
  });

  it('draws exactly the SAME one draw call for a 5,000-keyframe track', () => {
    // The headline invariant: per-frame cost is a binary search plus a lerp, so
    // the GPU work is independent of how much of the pose stream is resident.
    // A per-keyframe implementation would scale this number.
    const { layer, gl } = mount({}, makeEgoTile({ count: 5_000, step: 20 }));
    layer.render(gl, MATRIX);
    expect(gl.drawCalls).toEqual([{ kind: 'elements', count: 36 }]);
  });

  it('never instances — one instance would only add a divisor to reset', () => {
    const { layer, gl } = mount({}, makeEgoTile({ count: 5_000, step: 20 }));
    layer.render(gl, MATRIX);
    expect(gl.drawElementsInstanced).not.toHaveBeenCalled();
    expect(gl.drawArraysInstanced).not.toHaveBeenCalled();
    expect(gl.vertexAttribDivisor).not.toHaveBeenCalled();
  });

  it('still draws once when the track spans several resident tiles', () => {
    // The vehicle crossed a seam (and `best-available` fallback can hold a
    // parent beside its child): every tile but the play-head's owner must
    // draw nothing, or the cockpit would show a convoy.
    const early = makeEgoTile({
      count: 4,
      step: 1_000,
      tileId: { z: 14, x: 2620, y: 6333, t: TIME_OFFSET },
    });
    const late = makeEgoTile({
      count: 4,
      step: 1_000,
      lon0: -122.3,
      tileId: { z: 14, x: 2621, y: 6333, t: TIME_OFFSET },
    });
    const { layer, gl } = mount({}, early, late);
    layer.render(gl, MATRIX);
    expect(gl.drawCalls).toEqual([{ kind: 'elements', count: 36 }]);
  });

  it('uploads the unit cuboid once and reuses it across frames', () => {
    const { layer, gl } = mount();
    layer.render(gl, MATRIX);
    const buffersAfterFirst = gl.createBuffer.mock.calls.length;
    layer.setCurrentTime?.(TIME_OFFSET + 1_500);
    layer.render(gl, MATRIX);
    expect(gl.createBuffer.mock.calls.length).toBe(buffersAfterFirst);
  });

  it('the mesh is 24 vertices / 36 indices, six independently shaded faces', () => {
    const mesh = buildEgoCuboidMesh();
    expect(mesh.vertexCount).toBe(24);
    expect(mesh.indexCount).toBe(36);
    expect(mesh.vertices.length).toBe(24 * 4);
    // Six distinct faces, and the nose is brighter than the tail — that shading
    // difference IS the heading cue on an otherwise symmetric box.
    const shades = new Set(
      Array.from(mesh.vertices).filter((_, i) => i % 4 === 3),
    );
    expect(shades.size).toBeGreaterThanOrEqual(4);
    expect(buildEgoCuboidMesh()).toBe(mesh); // module-level, shared
  });
});

// ── 2. the interpolation ────────────────────────────────────────────────────

describe('shortest-arc heading', () => {
  it('takes the SHORT way across the ±π branch cut', () => {
    // 3.10 → -3.10 rad is a 2.5° turn through due west. A naive lerp reports
    // the midpoint as 0 — due EAST, a 180° error and a full pirouette.
    const mid = lerpHeadingShortestArc(3.1, -3.1, 0.5);
    expect(Math.cos(mid)).toBeCloseTo(-1, 6);
    const naive = 3.1 + (-3.1 - 3.1) * 0.5;
    expect(Math.cos(naive)).toBeCloseTo(1, 6);
  });

  it('is a plain lerp when no wrap is involved', () => {
    expect(lerpHeadingShortestArc(0, Math.PI / 2, 0.5)).toBeCloseTo(
      Math.PI / 4,
      12,
    );
  });

  it('is exact at both endpoints', () => {
    expect(lerpHeadingShortestArc(1.2, -2.9, 0)).toBeCloseTo(1.2, 12);
    expect(Math.cos(lerpHeadingShortestArc(1.2, -2.9, 1))).toBeCloseTo(
      Math.cos(-2.9),
      12,
    );
  });

  it('turns the same way regardless of which side of the cut it starts on', () => {
    const a = lerpHeadingShortestArc(3.1, -3.1, 0.25);
    const b = lerpHeadingShortestArc(-3.1, 3.1, 0.75);
    expect(Math.cos(a)).toBeCloseTo(Math.cos(b), 6);
    expect(Math.sin(a)).toBeCloseTo(Math.sin(b), 6);
  });
});

describe('pose sampling', () => {
  it('lerps position exactly halfway between the bracketing keyframes', () => {
    const tile = makeEgoTile({ count: 2, step: 1_000, dLon: 0.001 });
    const { layer, gl } = mount({ currentTime: TIME_OFFSET + 500 }, tile);
    layer.render(gl, MATRIX);
    const [ax] = lngLatToMercator(-122.4, 37.7);
    const [bx] = lngLatToMercator(-122.399, 37.7);
    // Read from the float64 pose, not the float32 uniform: the point of the
    // double-precision track is that the MIDPOINT is exact before the GPU
    // boundary rounds it.
    expect(layer.getCurrentPose().x).toBeCloseTo((ax + bx) / 2, 15);
  });

  it('hands that same pose to the shader as uCenter', () => {
    const tile = makeEgoTile({ count: 2, step: 1_000, dLon: 0.001 });
    const { layer, gl } = mount({ currentTime: TIME_OFFSET + 500 }, tile);
    layer.render(gl, MATRIX);
    const pose = layer.getCurrentPose();
    expect(vec3Args(gl, 'uCenter').at(-1)).toEqual([
      Math.fround(pose.x),
      Math.fround(pose.y),
      Math.fround(pose.z),
    ]);
  });

  it('sorts an out-of-order tile on upload, so the search is on real time order', () => {
    const shuffled = makeEgoTile({ count: 4, step: 1_000, shuffle: true });
    const { layer, gl } = mount({ currentTime: TIME_OFFSET + 500 }, shuffled);
    layer.render(gl, MATRIX);
    const [ax] = lngLatToMercator(-122.4, 37.7);
    const [bx] = lngLatToMercator(-122.399, 37.7);
    // Without the sort, `keyTimes[0]` would be the LAST sample and the binary
    // search would return garbage.
    expect(layer.getCurrentPose().x).toBeCloseTo((ax + bx) / 2, 15);
  });

  it('clamps past the end of the log instead of teleporting', () => {
    const tile = makeEgoTile({ count: 4, step: 1_000 });
    const { layer, gl } = mount({ currentTime: TIME_OFFSET + 999_000 }, tile);
    layer.render(gl, MATRIX);
    const [lastX] = lngLatToMercator(-122.4 + 3 * 0.001, 37.7);
    const pose = layer.getCurrentPose();
    expect(pose.x).toBeCloseTo(lastX, 15);
    expect(pose.clamped).toBe(true);
    expect(pose.x).not.toBe(0);
  });

  it('hands the clamped pose a time span the window kernel rejects', () => {
    // This is what makes the marker VANISH off the end of the log rather than
    // parking a ghost vehicle there forever — asserted against the shared JS
    // reference, not against a re-implementation.
    const tile = makeEgoTile({ count: 4, step: 1_000 });
    const { layer, gl } = mount({ currentTime: TIME_OFFSET + 999_000 }, tile);
    layer.render(gl, MATRIX);
    const [start, end] = uniformArgs(gl, 'uniform2f', 'uTime').at(-1)!;
    const [wStart] = uniformArgs(gl, 'uniform1f', 'uWindowStart').at(-1)!;
    const [wEnd] = uniformArgs(gl, 'uniform1f', 'uWindowEnd').at(-1)!;
    expect(timeWindowAlphaJS(start, end, wStart, wEnd, 0, 0)).toBe(0);
  });

  it('lights the marker while the play-head is inside the log', () => {
    const tile = makeEgoTile({ count: 4, step: 1_000 });
    const { layer, gl } = mount({ currentTime: TIME_OFFSET + 1_500 }, tile);
    layer.render(gl, MATRIX);
    const [start, end] = uniformArgs(gl, 'uniform2f', 'uTime').at(-1)!;
    const [wStart] = uniformArgs(gl, 'uniform1f', 'uWindowStart').at(-1)!;
    const [wEnd] = uniformArgs(gl, 'uniform1f', 'uWindowEnd').at(-1)!;
    expect(timeWindowAlphaJS(start, end, wStart, wEnd, 0, 0)).toBe(1);
  });

  it('reads the baked heading column, shortest-arc lerped', () => {
    // A quarter turn, not a half: an exactly-opposite pair is genuinely
    // ambiguous (both ways round are the same arc length) and its resolution
    // flips on a 1-ulp difference — a property of the geometry, not a bug to
    // pin down in a fixture.
    const tile = makeEgoTile({
      count: 2,
      step: 1_000,
      heading: [0, Math.PI / 2],
    });
    const { layer, gl } = mount({ currentTime: TIME_OFFSET + 500 }, tile);
    layer.render(gl, MATRIX);
    expect(layer.getCurrentPose().heading).toBeCloseTo(Math.PI / 4, 5);
    const rot = uniformArgs(gl, 'uniform2f', 'uHeadingRot').at(-1)!;
    expect(rot[0]).toBeCloseTo(Math.cos(Math.PI / 4), 5);
    expect(rot[1]).toBeCloseTo(Math.sin(Math.PI / 4), 5);
  });

  it('converts a degrees column and applies headingOffset', () => {
    const tile = makeEgoTile({ count: 2, step: 1_000, heading: [90, 90] });
    const { layer, gl } = mount(
      { currentTime: TIME_OFFSET + 500, headingUnits: 'degrees' },
      tile,
    );
    layer.render(gl, MATRIX);
    const rot = uniformArgs(gl, 'uniform2f', 'uHeadingRot').at(-1)!;
    expect(rot[0]).toBeCloseTo(0, 6);
    expect(rot[1]).toBeCloseTo(1, 6);
  });

  it('falls back to the direction of travel when no heading column exists', () => {
    // Moving due EAST at constant latitude ⇒ heading 0 ⇒ (cos, sin) = (1, 0).
    // Mercator y grows southward, so a sign slip here would point the nose north.
    const { layer, gl } = mount(
      { currentTime: TIME_OFFSET + 500 },
      makeEgoTile({ count: 4, step: 1_000, dLon: 0.001 }),
    );
    layer.render(gl, MATRIX);
    const rot = uniformArgs(gl, 'uniform2f', 'uHeadingRot').at(-1)!;
    expect(rot[0]).toBeCloseTo(1, 6);
    expect(rot[1]).toBeCloseTo(0, 6);
  });

  it('interpolates across a gap by default', () => {
    // 10 s between samples is still a glide unless the caller says otherwise —
    // the default must not silently stutter a slow log.
    const tile = makeEgoTile({ count: 2, step: 10_000 });
    const { layer, gl } = mount({ currentTime: TIME_OFFSET + 5_000 }, tile);
    layer.render(gl, MATRIX);
    const pose = layer.getCurrentPose();
    expect(pose.held).toBe(false);
    const [ax] = lngLatToMercator(-122.4, 37.7);
    const [bx] = lngLatToMercator(-122.399, 37.7);
    expect(pose.x).toBeCloseTo((ax + bx) / 2, 15);
  });

  it('HOLDS the last real sample across a gap wider than maxInterpolationGap', () => {
    // The dropout guard `STTIconLayer`/`STTTripHeadsLayer` carry: a 10 s hole
    // is missing data, not slow motion, so the pose must not glide through it.
    const tile = makeEgoTile({ count: 2, step: 10_000 });
    const { layer, gl } = mount(
      { currentTime: TIME_OFFSET + 5_000, maxInterpolationGap: 2_000 },
      tile,
    );
    layer.render(gl, MATRIX);
    const pose = layer.getCurrentPose();
    expect(pose.held).toBe(true);
    const [ax] = lngLatToMercator(-122.4, 37.7);
    expect(pose.x).toBeCloseTo(ax, 15);
  });

  it('the held pose keeps the last sample’s own span, which the filter can age out', () => {
    // Instantaneous samples (`dwell: 0`) — the ego norm. The held pose reports
    // the span the ARCHIVE claims, so once the play-head runs past it the
    // shared window kernel fades the marker and the dropout reads as a
    // dropout. (A sample that claims validity for the whole hole stays lit,
    // and that is the archive's statement, not this layer's.)
    const tile = makeEgoTile({ count: 2, step: 10_000, dwell: 0 });
    const { layer, gl } = mount(
      { currentTime: TIME_OFFSET + 9_500, maxInterpolationGap: 2_000 },
      tile,
    );
    layer.render(gl, MATRIX);
    const [start, end] = uniformArgs(gl, 'uniform2f', 'uTime').at(-1)!;
    const [wStart] = uniformArgs(gl, 'uniform1f', 'uWindowStart').at(-1)!;
    const [wEnd] = uniformArgs(gl, 'uniform1f', 'uWindowEnd').at(-1)!;
    expect(timeWindowAlphaJS(start, end, wStart, wEnd, 0, 0)).toBe(0);
  });

  it('reads the vehicle extent from its columns, not from the defaults', () => {
    const tile = makeEgoTile({
      count: 2,
      step: 1_000,
      numericProps: {
        length: new Float32Array([5.5, 5.5]),
        width: new Float32Array([2.1, 2.1]),
        height: new Float32Array([1.9, 1.9]),
      },
    });
    const { layer, gl } = mount({ currentTime: TIME_OFFSET + 500 }, tile);
    layer.render(gl, MATRIX);
    // uSizeM is (width, length, height) — the cuboid's own axis order.
    const size = vec3Args(gl, 'uSizeM').at(-1)!;
    expect(size[0]).toBeCloseTo(2.1, 5);
    expect(size[1]).toBeCloseTo(5.5, 5);
    expect(size[2]).toBeCloseTo(1.9, 5);
  });

  it('falls back to the nuScenes ego dimensions when no columns exist', () => {
    const { layer, gl } = mount();
    layer.render(gl, MATRIX);
    expect(vec3Args(gl, 'uSizeM').at(-1)).toEqual([
      Math.fround(DEFAULT_EGO_WIDTH_M),
      Math.fround(DEFAULT_EGO_LENGTH_M),
      Math.fround(DEFAULT_EGO_HEIGHT_M),
    ]);
  });
});

// ── 3. metric sizing ────────────────────────────────────────────────────────

describe('metric sizing', () => {
  it("converts metres at the TILE's centre latitude, not the map centre", () => {
    const tile = makeEgoTile();
    const { layer, gl } = mount({}, tile);
    layer.render(gl, MATRIX);
    const [scale] = uniformArgs(gl, 'uniform1f', 'uMetersToUnits').at(-1)!;
    const lat = tileCenterLatitude(tile.id.z, tile.id.y);
    expect(scale).toBeCloseTo(metersToMercatorUnits(1, lat), 15);
    // A flat 1e-7 constant — the tempting shortcut — is ~4x wrong.
    expect(scale).not.toBeCloseTo(1e-7, 9);
  });

  it("sizeUnits:'pixels' pins the box to maplibre's 512·2^zoom world instead", () => {
    const { layer, gl } = mount({ sizeUnits: 'pixels' });
    layer.render(gl, MATRIX);
    const zoom = Math.floor(layer.map.getZoom());
    const [scale] = uniformArgs(gl, 'uniform1f', 'uMetersToUnits').at(-1)!;
    expect(scale).toBeCloseTo(1 / (512 * Math.pow(2, zoom)), 15);
    // Zoom-dependent, unlike the metric branch — that IS the difference.
    expect(scale).not.toBeCloseTo(
      metersToMercatorUnits(1, tileCenterLatitude(14, 6333)),
      12,
    );
  });

  it('sizeScale and elevationScale reach the shader as separate knobs', () => {
    const { layer, gl } = mount({ sizeScale: 3, elevationScale: 0.5 });
    layer.render(gl, MATRIX);
    expect(uniformArgs(gl, 'uniform1f', 'uSizeScale').at(-1)).toEqual([3]);
    expect(uniformArgs(gl, 'uniform1f', 'uElevationScale').at(-1)).toEqual([
      0.5,
    ]);
  });
});

// ── 4. time-filter modes ────────────────────────────────────────────────────

const shader = { prelude: '', define: '' };

describe('the four time-filter modes', () => {
  it.each([
    [
      'window',
      'sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut)',
    ],
    ['wake', 'sttWakeAlpha(aTime, uCurrentTime, uWakeLength)'],
    ['cumulative', 'sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn)'],
    ['trail', 'sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail)'],
  ])('%s splices the shared alpha call verbatim', (mode, call) => {
    const src = buildEgoVertexSource(shader, {
      mode: mode as any,
      filter: false,
    });
    expect(src).toContain(call);
    // The marker's span is a UNIFORM (it is a singleton), aliased so the shared
    // spelling above needs no per-kind fork.
    expect(src).toContain('uniform vec2 uTime;');
    expect(src).toContain('vec2 aTime = uTime;');
  });

  it('declares ONLY the compiled mode’s uniforms', () => {
    const wake = buildEgoVertexSource(shader, { mode: 'wake', filter: false });
    expect(wake).toContain('uniform float uWakeLength;');
    expect(wake).not.toContain('uniform float uWindowStart;');
    expect(wake).not.toContain('uniform float uTrailLength;');
  });

  it('does NOT declare uWakeTailScale — the footprint is the real vehicle', () => {
    // A tapering ego box is a smaller CAR, i.e. a lie about the data; same rule
    // that keeps a summary cell's footprint (geography) from tapering.
    const wake = buildEgoVertexSource(shader, { mode: 'wake', filter: false });
    expect(wake).not.toContain('uWakeTailScale');
    // The shared wake kernel DEFINES sttWakeSizeScale; this layer never calls
    // it, so the name appears exactly once (the definition) and never in main().
    expect(wake.match(/sttWakeSizeScale/g)).toHaveLength(1);
    expect(wake).not.toContain('*= sttWakeSizeScale');
  });

  it('uploads only the compiled mode’s uniforms, tile-RELATIVE', () => {
    const { layer, gl } = mount({
      timeFilterMode: 'trail',
      trailLength: 4_000,
      currentTime: TIME_OFFSET + 1_500,
    });
    layer.render(gl, MATRIX);
    expect(uniformArgs(gl, 'uniform1f', 'uCurrentTime').at(-1)).toEqual([
      1_500,
    ]);
    expect(uniformArgs(gl, 'uniform1f', 'uTrailLength').at(-1)).toEqual([
      4_000,
    ]);
    expect(uniformArgs(gl, 'uniform1f', 'uWindowStart')).toHaveLength(0);
  });

  it('re-derives the window against the OWNING tile, not the iterated one', () => {
    // The base builds ctx.windowStart/End against whichever tile it is walking;
    // the marker may live on another. A stale window would fade a visible ego.
    const { layer, gl } = mount({ currentTime: TIME_OFFSET + 1_500 });
    layer.render(gl, MATRIX);
    expect(uniformArgs(gl, 'uniform1f', 'uWindowStart').at(-1)).toEqual([500]);
    expect(uniformArgs(gl, 'uniform1f', 'uWindowEnd').at(-1)).toEqual([2_500]);
  });

  it('degrades exactly like every other kind', () => {
    expect(resolveEgoTimeFilterMode('cumulative', 0, 0)).toBe('cumulative');
    expect(resolveEgoTimeFilterMode('wake', 0, 0)).toBe('window');
    expect(resolveEgoTimeFilterMode('wake', 100, 0)).toBe('wake');
    expect(resolveEgoTimeFilterMode('trail', 0, 0)).toBe('window');
    expect(resolveEgoTimeFilterMode('trail', 0, 100)).toBe('trail');
    expect(resolveEgoTimeFilterMode('window', 100, 100)).toBe('window');
    expect(resolveEgoTimeFilterMode(undefined, 100, 100)).toBe('wake');
    expect(resolveEgoTimeFilterMode(undefined, 0, 100)).toBe('trail');
    expect(resolveEgoTimeFilterMode(undefined, 0, 0)).toBe('window');
  });
});

// ── 5. DataFilter ───────────────────────────────────────────────────────────

describe('DataFilter', () => {
  it('compiles no filter branch without filterProperty', () => {
    const src = buildEgoVertexSource(shader);
    expect(src).not.toContain(DATA_FILTER_CALL_GLSL);
    expect(src).not.toContain('uniform float uFilterValue;');
  });

  it('splices the shared kernel and call when filterProperty is set', () => {
    const src = buildEgoVertexSource(shader, { mode: 'window', filter: true });
    expect(src).toContain(DATA_FILTER_CALL_GLSL);
    expect(src).toContain('uniform float uFilterValue;');
    expect(src).toContain('float aFilterValue = uFilterValue;');
  });

  it('declares uFilterTransformSize but never READS it', () => {
    // Matching deck's SolidPolygonLayer: shrinking a real metric extent would
    // misreport the vehicle. The declaration keeps the shared uniform block —
    // and `uploadDataFilterUniforms` — identical across kinds.
    const src = buildEgoVertexSource(shader, { mode: 'window', filter: true });
    expect(src).toContain('uniform float uFilterTransformSize;');
    expect(src.match(/uFilterTransformSize/g)).toHaveLength(1);
    expect(src).toContain('uFilterTransformColor > 0.5');
  });

  it('renders UNFILTERED (never blank) when the tile lacks the column', () => {
    const { layer, gl } = mount({ filterProperty: 'speed' });
    layer.render(gl, MATRIX);
    expect(gl.drawCalls).toHaveLength(1);
    expect(uniformArgs(gl, 'uniform1f', 'uFilterEnabled').at(-1)).toEqual([0]);
  });

  it('uploads the lower bracketing keyframe’s column value', () => {
    const tile = makeEgoTile({
      count: 2,
      step: 1_000,
      numericProps: { speed: new Float32Array([12, 34]) },
    });
    const { layer, gl } = mount(
      {
        filterProperty: 'speed',
        filterRange: [0, 100],
        currentTime: TIME_OFFSET + 500,
      },
      tile,
    );
    layer.render(gl, MATRIX);
    expect(uniformArgs(gl, 'uniform1f', 'uFilterValue').at(-1)).toEqual([12]);
    expect(uniformArgs(gl, 'uniform1f', 'uFilterEnabled').at(-1)).toEqual([1]);
  });
});

// ── 6. picking ──────────────────────────────────────────────────────────────

describe('id-FBO picking', () => {
  it('is offered as a pick hook', () => {
    const { layer } = mount();
    expect(layer.supportsPicking()).toBe(true);
  });

  it('the id pass reproduces the visual pass’s geometry and gates exactly', () => {
    const cfg = { mode: 'trail' as const, filter: true };
    const main = buildEgoVertexSource(shader, cfg);
    const id = buildEgoIdVertexSource(shader, cfg);
    for (const shared of [
      'sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail)',
      DATA_FILTER_CALL_GLSL,
      'vec2 offsetM = sttEgoOffsetMeters(aUnit.xy, sizeM.xy, uHeadingRot);',
      'vec2 posM = uCenter.xy + offsetM * uMetersToUnits;',
      'float elevM = uCenter.z + aUnit.z * sizeM.z * uElevationScale;',
      'if (vAlpha <= 0.0) gl_Position = vec4(0.0);',
    ]) {
      expect(main).toContain(shared);
      expect(id).toContain(shared);
    }
    // The id pass is STRICTER, never more permissive: it also folds the colour
    // alpha in, so a fully transparent marker is not a hit target.
    expect(id).toContain('vAlpha *= uColor.a;');
    expect(main).not.toContain('vAlpha *= uColor.a;');
    expect(id).toContain('uniform vec3 uIdColor;');
    expect(id).not.toContain('varying vec4 vColor;');
  });

  it('paints one flat id — the LOWER bracketing keyframe — from the owning tile only', () => {
    const tile = makeEgoTile({ count: 4, step: 1_000 });
    const { layer, gl } = mount({ currentTime: TIME_OFFSET + 2_500 }, tile);
    layer.render(gl, MATRIX); // warm the caches the pick pass reads
    gl.drawCalls.length = 0;
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      layer.ensureTileGpuCache(gl, tile, tile.layers[0]),
      drawCtx(TIME_OFFSET + 2_500),
      1,
    );
    expect(gl.drawCalls).toEqual([{ kind: 'elements', count: 36 }]);
    // t=2500 brackets keyframes 2 and 3, so the id is idBase + 2.
    const rgb = layer.buildPickIdColors(1, 1 + 2);
    const uploaded = vec3Args(gl, 'uIdColor').at(-1)!;
    expect(uploaded.map((v) => Math.round(v * 255))).toEqual(Array.from(rgb));
  });

  it('draws nothing for a tile that does not own the play-head', () => {
    const early = makeEgoTile({
      count: 4,
      step: 1_000,
      tileId: { z: 14, x: 2620, y: 6333, t: TIME_OFFSET },
    });
    const late = makeEgoTile({
      count: 4,
      step: 1_000,
      lon0: -122.3,
      tileId: { z: 14, x: 2621, y: 6333, t: TIME_OFFSET },
    });
    const { layer, gl } = mount(
      { currentTime: TIME_OFFSET + 500 },
      early,
      late,
    );
    layer.render(gl, MATRIX);
    gl.drawCalls.length = 0;
    layer.drawPickTile(
      gl,
      late,
      late.layers[0],
      layer.ensureTileGpuCache(gl, late, late.layers[0]),
      drawCtx(TIME_OFFSET + 500),
      100,
    );
    expect(gl.drawCalls).toHaveLength(0);
  });

  it('the id fragment stage discards on the same alpha the visual one does', () => {
    const { layer, gl } = mount({ filterProperty: 'speed' });
    layer.render(gl, MATRIX);
    const sources = gl.shaderSource.mock.calls.map((c: unknown[]) =>
      String(c[1]),
    );
    const idFs = sources.filter(
      (s: string) => s.includes('vIdColor') && s.includes('gl_FragColor'),
    );
    for (const s of idFs) expect(s).toContain('if (vAlpha <= 0.0) discard;');
  });
});

// ── 7. host variants, program cache, GL state ───────────────────────────────

describe('host variants and the program cache', () => {
  it('legacy hosts keep uMatrix; prelude hosts project through the prelude', () => {
    const legacy = buildEgoVertexSource(shader);
    expect(legacy).toContain('uniform mat4 uMatrix;');
    expect(legacy).not.toContain('projectTileFor3D');

    const v5 = buildEgoVertexSource(
      { prelude: '#define PRELUDE', define: '#define GLOBE' },
      { mode: 'window', filter: false },
    );
    expect(v5.startsWith('#define PRELUDE\n#define GLOBE\n')).toBe(true);
    expect(v5).not.toContain('uniform mat4 uMatrix;');
    expect(v5).toContain('projectTileFor3D');
  });

  it('carries every compiled axis in the program-cache key', () => {
    const keys = new Set<string>();
    for (const pass of ['body', 'pick'] as const) {
      for (const mode of ['window', 'wake', 'cumulative', 'trail'] as const) {
        for (const filter of [false, true]) {
          keys.add(egoProgramKey(pass, { mode, filter }));
        }
      }
    }
    // 2 passes x 4 modes x 2 filter states = 16 structurally distinct programs.
    expect(keys.size).toBe(16);
    expect(egoProgramKey('body', { mode: 'wake', filter: true })).toBe(
      'ego:body:wake:filter',
    );
  });

  it('compiles ONE visual program and reuses it across frames', () => {
    const { layer, gl } = mount();
    layer.render(gl, MATRIX);
    const linked = gl.linkProgram.mock.calls.length;
    layer.render(gl, MATRIX);
    expect(gl.linkProgram.mock.calls.length).toBe(linked);
  });

  it("is a '3d' layer and leaves the host's depth mode alone", () => {
    const { layer, gl } = mount();
    expect(layer.renderingMode).toBe('3d');
    layer.render(gl, MATRIX);
    expect(gl.disable).not.toHaveBeenCalledWith(gl.DEPTH_TEST);
  });

  it("'2d' restores the package's always-on-top behaviour", () => {
    const { layer, gl } = mount({ renderingMode: '2d' });
    expect(layer.renderingMode).toBe('2d');
    layer.render(gl, MATRIX);
    expect(gl.disable).toHaveBeenCalledWith(gl.DEPTH_TEST);
  });

  it('accepts POINT geometry only', () => {
    const { layer } = mount();
    expect(layer.acceptsGeometry(GeometryType.Point)).toBe(true);
    expect(layer.acceptsGeometry(GeometryType.LineString)).toBe(false);
    expect(layer.acceptsGeometry(GeometryType.Polygon)).toBe(false);
  });

  it('releases its own mesh buffers and handles on context loss', () => {
    const { layer, gl } = mount();
    layer.render(gl, MATRIX);
    const deleted = gl.deleteBuffer.mock.calls.length;
    layer.onContextLost(gl);
    expect(gl.deleteBuffer.mock.calls.length).toBeGreaterThan(deleted);
    expect(layer.getCurrentPose()).toBeNull();
  });
});

// ── 8. defaults ─────────────────────────────────────────────────────────────

describe('defaults are the pre-campaign behaviour', () => {
  it('defaults every option through `??`, so an explicit undefined still lands', () => {
    const { layer } = mount({
      sizeScale: undefined,
      sizeUnits: undefined,
      elevationScale: undefined,
      renderingMode: undefined,
      headingUnits: undefined,
      length: undefined,
      width: undefined,
      height: undefined,
    });
    const o = layer.egoOpts;
    expect(o.sizeScale).toBe(1);
    expect(o.sizeUnits).toBe('meters');
    expect(o.elevationScale).toBe(1);
    expect(o.headingUnits).toBe('radians');
    expect(o.length).toBe(DEFAULT_EGO_LENGTH_M);
    expect(o.width).toBe(DEFAULT_EGO_WIDTH_M);
    expect(o.height).toBe(DEFAULT_EGO_HEIGHT_M);
    expect(layer.renderingMode).toBe('3d');
  });

  it('defaults the pose columns to the names an ego archive bakes', () => {
    const o = mount().layer.egoOpts;
    expect(o.headingProperty).toBe('heading');
    expect(o.lengthProperty).toBe('length');
    expect(o.widthProperty).toBe('width');
    expect(o.heightProperty).toBe('height');
    expect(o.headingOffset).toBe(0);
    expect(o.maxInterpolationGap).toBe(Number.POSITIVE_INFINITY);
  });

  it('compiles window mode with no filter out of the box', () => {
    const { layer } = mount();
    expect(layer.shaderConfig).toEqual({ mode: 'window', filter: false });
  });

  it('exposes the drawn pose as a COPY a caller cannot mutate', () => {
    const { layer, gl } = mount();
    layer.render(gl, MATRIX);
    const a = layer.getCurrentPose();
    expect(a).not.toBeNull();
    a!.x = 999;
    expect(layer.getCurrentPose()!.x).not.toBe(999);
  });

  it('never warns on the happy path', () => {
    const { layer, gl } = mount();
    layer.render(gl, MATRIX);
    expect(warn).not.toHaveBeenCalled();
  });
});

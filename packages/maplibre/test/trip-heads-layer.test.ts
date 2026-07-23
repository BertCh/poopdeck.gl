/**
 * STTTripHeadsLayer — Wave M3 (new kind: trip heads).
 *
 * Four things are worth testing without a GPU, and this file covers exactly
 * those:
 *
 *  1. **Shader assembly** — both host variants (legacy `uMatrix`, v5 injected
 *     prelude) build for both passes (visual + id-pick) and for both compiled
 *     time modes, and the default configuration compiles NONE of the optional
 *     surface.
 *  2. **CPU head interpolation** — the hoisted `@poopdeck.gl/core` track kernel
 *     (`buildTripTracks` → `sampleTrack`) is parity-checked against an
 *     INDEPENDENT re-implementation of deck's `AnimatedTripHeadsLayer.computeHeads`
 *     written here, over vertex-timestamped tiles, synthesized-time tiles,
 *     inactive trips and 1-vertex trips. `writeMercator` is pinned to the
 *     shared `lngLatToMercator`.
 *  3. **Per-frame emit** — the persistent instance buffer is allocated once and
 *     rewritten with `bufferSubData` (never re-allocated), the emitted heads are
 *     COMPACTED to the active set, and every per-feature column is splatted into
 *     that compacted order.
 *  4. **Pick gating** — the id pass compiles the same mode/filter gates, sizes
 *     identically, and paints ids derived from the SOURCE feature index (not the
 *     draw order), so a `resolvePick` join lands on the right row; nothing
 *     invisible is pickable.
 *
 * The FBO round-trip and real prelude compilation stay browser-verified.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  GeometryType,
  getFeatureProperties,
  type BinaryFeatures,
  type Layer,
  type Tile,
} from '@poopdeck.gl/core';
import { encodePickId } from '@poopdeck.gl/core/picking';
import { synthesizeVertexTimes } from '@poopdeck.gl/core/trips';
import { normalizeRenderArgs } from '../src/lib/host-adapter';
import {
  STTTripHeadsLayer,
  buildTripHeadsVertexSource,
  buildTripHeadsIdVertexSource,
  buildTripTracks,
  tripHeadsProgramKey,
  resolveTripHeadsTimeFilterMode,
  writeMercator,
  type TripHeadsShaderConfig,
} from '../src/layers/trip-heads-layer';
import {
  DATA_FILTER_CALL_GLSL,
  dataFilterAlphaJS,
} from '../src/shaders/data-filter.glsl';
import { wakeAlphaJS, wakeSizeScaleJS } from '../src/shaders/time-window.glsl';
import {
  lngLatToMercator,
  metersToPixelsAtLatitude,
  tileCenterLatitude,
} from '../src/lib/projection';
import { makeMockGl } from './mock-gl';
import { makeTripsTile } from './fixtures';

const TIME_OFFSET = 1_700_000_000_000;

const baseOpts = {
  url: 'mem://heads.stt',
  currentTime: TIME_OFFSET + 1000,
  timeWindow: 10_000,
};

const PRELUDE_MARKER = '// __HOST_PRELUDE__';
const PRELUDE = `${PRELUDE_MARKER}\nvec4 projectTile(vec2 p) { return vec4(p, 0.0, 1.0); }`;
const LEGACY_SHADER = { prelude: '', define: '' };
const V5_SHADER = { prelude: PRELUDE, define: '#define GLOBE' };

const cfg = (
  over: Partial<TripHeadsShaderConfig> = {},
): TripHeadsShaderConfig => ({
  mode: 'window',
  filter: false,
  ...over,
});

/** Both host variants of one configuration, for "identical in both" assertions. */
const bothVariants = (
  build: (s: typeof LEGACY_SHADER, c: TripHeadsShaderConfig) => string,
  c: TripHeadsShaderConfig,
): [string, string] => [build(LEGACY_SHADER, c), build(V5_SHADER, c)];

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

const drawCtx = (
  frame?: ReturnType<typeof normalizeRenderArgs>,
  currentTime = baseOpts.currentTime,
) => ({
  matrix: frame ? frame.matrix : new Float32Array(16),
  frame,
  windowStart: currentTime - TIME_OFFSET - baseOpts.timeWindow / 2,
  windowEnd: currentTime - TIME_OFFSET + baseOpts.timeWindow / 2,
  currentTime,
  zoom: 2,
});

const legacyFrame = () => normalizeRenderArgs(new Float32Array(16));

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * Three trips chosen so the ACTIVE set is neither empty nor the whole tile at
 * the layer's default playhead (`TIME_OFFSET + 1000`):
 *   - f0: vertex times 4000→6000 — NOT yet started (compaction skips it).
 *   - f1: vertex times 0→2000 — mid-trip.
 *   - f2: a single vertex held across `[0, 3000]` (the degenerate case).
 * So the emitted heads are `[f1, f2]` and `activeFeatureIndex === [1, 2]` —
 * the reorder that makes deck's equivalent layer give up on picking.
 */
function makeHeadsTile(): Tile {
  const positions = new Float64Array([
    // f0
    -10, 0, -9, 0, -8, 0,
    // f1
    0, 0, 1, 0, 2, 0,
    // f2 (single vertex)
    10, 5,
  ]);
  const features: BinaryFeatures = {
    featureCount: 3,
    geometryType: GeometryType.LineString,
    positionDimensions: 2,
    positions,
    startIndices: new Uint32Array([0, 3, 6, 7]),
    featureIds: new Uint32Array([0, 1, 2]),
    startTimes: new Float32Array([4000, 0, 0]),
    endTimes: new Float32Array([6000, 2000, 3000]),
    timeOffset: TIME_OFFSET,
    vertexTimestamps: new Float32Array([4000, 5000, 6000, 0, 1000, 2000, 0]),
    numericProps: {
      magnitude: new Float32Array([1, 5, 9]),
      size: new Float32Array([2, 6, 10]),
    },
    categoricalProps: {
      vehicleType: {
        indices: new Uint16Array([0, 1, 0]),
        categories: ['truck', 'car'],
      },
    },
  } as unknown as BinaryFeatures;
  const layer: Layer = {
    name: 'trips',
    extent: 4096,
    features,
    geometryExtensionName: 'geoarrow.linestring',
  };
  return {
    id: { z: 2, x: 1, y: 1, t: TIME_OFFSET },
    timeRange: { start: TIME_OFFSET, end: TIME_OFFSET + 6000 },
    layers: [layer],
  };
}

// ── mock GL (bufferSubData recorder) ────────────────────────────────────────

/**
 * `makeMockGl` predates any per-frame-upload layer, so it has no
 * `bufferSubData`. Wrap it here rather than editing the shared recorder (file
 * ownership) — and SNAPSHOT the uploaded view, because the emit scratch is a
 * reused per-layer buffer and a plain call log would show every recorded
 * upload holding the newest values.
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

function makeLayerWithCache(
  extra: Record<string, unknown> = {},
  tile = makeHeadsTile(),
) {
  const layer = new STTTripHeadsLayer({
    ...baseOpts,
    id: 'heads',
    ...extra,
  }) as any;
  const gl = makeGl();
  // The real `initVaoSupport` runs in onAdd, which these direct-hook tests
  // bypass — wire the mock's VAO entry points so VAO reuse/rebuild is real.
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

// ── independent reference: deck's AnimatedTripHeadsLayer.computeHeads ────────

interface RefHead {
  index: number;
  lon: number;
  lat: number;
}

/**
 * Re-implementation of deck's `computeHeads` from the published algorithm
 * (feature-window activity test, binary-search bracket, `a*g + b*frac` lerp),
 * written independently of the layer under test so the parity assertion is a
 * real cross-check rather than a tautology.
 */
function referenceHeads(f: BinaryFeatures, relTime: number): RefHead[] {
  const dims = f.positionDimensions ?? 2;
  const si = f.startIndices!;
  const totalVerts = si[f.featureCount];
  const vt =
    f.vertexTimestamps && f.vertexTimestamps.length >= totalVerts
      ? f.vertexTimestamps
      : synthesizeVertexTimes(f);
  const out: RefHead[] = [];
  for (let i = 0; i < f.featureCount; i++) {
    if (relTime < f.startTimes[i] || relTime > f.endTimes[i]) continue;
    const v0 = si[i];
    const nv = si[i + 1] - v0;
    if (nv <= 0) continue;
    if (nv === 1) {
      out.push({
        index: i,
        lon: f.positions[v0 * dims],
        lat: f.positions[v0 * dims + 1],
      });
      continue;
    }
    let lo = 0;
    let hi = nv - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (vt[v0 + mid] <= relTime) lo = mid;
      else hi = mid;
    }
    const ta = vt[v0 + lo];
    const tb = vt[v0 + hi];
    const denom = tb - ta;
    const frac =
      denom > 0 ? Math.min(1, Math.max(0, (relTime - ta) / denom)) : 0;
    const g = 1 - frac;
    const a = (v0 + lo) * dims;
    const b = (v0 + hi) * dims;
    out.push({
      index: i,
      lon: f.positions[a] * g + f.positions[b] * frac,
      lat: f.positions[a + 1] * g + f.positions[b + 1] * frac,
    });
  }
  return out;
}

/** The layer's own answer: build tracks, sample every one at the playhead. */
async function kernelHeads(
  f: BinaryFeatures,
  relTime: number,
): Promise<RefHead[]> {
  const { sampleTrack } = await import('@poopdeck.gl/core');
  const set = buildTripTracks(f)!;
  const sampleCfg = {
    defaultLength: 0,
    defaultWidth: 0,
    defaultHeight: 0,
    fadeInDuration: 0,
    fadeOutDuration: 0,
    maxGapMs: Number.POSITIVE_INFINITY,
  };
  const out: RefHead[] = [];
  set.tracks.forEach((track, k) => {
    const s = sampleTrack(track, relTime + f.timeOffset, sampleCfg);
    if (!s) return;
    out.push({ index: set.featureIndex[k], lon: s.lon, lat: s.lat });
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('trip-heads vertex-source builder', () => {
  it('legacy variant (empty prelude) keeps the uMatrix path', () => {
    const src = buildTripHeadsVertexSource(LEGACY_SHADER);
    expect(src).toContain('uniform mat4 uMatrix;');
    expect(src).toContain('gl_Position = uMatrix * vec4(aMercator, 0.0, 1.0);');
    expect(src).not.toContain('projectTile(');
    expect(src).toContain('gl_PointSize = radiusPx * 2.0;');
  });

  it('v5 variant prepends prelude then define and projects via projectTile', () => {
    const src = buildTripHeadsVertexSource(V5_SHADER);
    expect(src.startsWith(PRELUDE)).toBe(true);
    const defineAt = src.indexOf('#define GLOBE');
    expect(defineAt).toBeGreaterThan(PRELUDE_MARKER.length);
    expect(defineAt).toBeLessThan(src.indexOf('attribute vec2 aMercator'));
    expect(src).toContain('gl_Position = projectTile(aMercator);');
    expect(src).not.toContain('uniform mat4 uMatrix;');
    expect(src).toContain('gl_PointSize = radiusPx * 2.0;');
  });

  it('id-pick builder mirrors both variants (flat id colour, same projection)', () => {
    const legacy = buildTripHeadsIdVertexSource(LEGACY_SHADER);
    expect(legacy).toContain('uniform mat4 uMatrix;');
    expect(legacy).toContain('attribute vec3 aIdColor;');
    expect(legacy).not.toContain('projectTile(');
    // The id pass paints no colour (no vColor varying) and needs no stroke
    // radius — but it DOES carry the colour surface, purely so it can gate on
    // the alpha: an invisible head must not be pickable.
    expect(legacy).not.toContain('varying vec4 vColor;');
    expect(legacy).not.toContain('vRadiusPx');
    expect(legacy).toContain('attribute vec4 aColor;');
    expect(legacy).toContain(
      'vAlpha *= ((uUseFeatureColor > 0.5) ? aColor.a : uColor.a);',
    );

    const v5 = buildTripHeadsIdVertexSource(V5_SHADER);
    expect(v5.startsWith(PRELUDE)).toBe(true);
    expect(v5).toContain('attribute vec3 aIdColor;');
    expect(v5).toContain('gl_Position = projectTile(aMercator);');
    expect(v5).not.toContain('uniform mat4 uMatrix;');
  });

  it('BOTH passes fold the CPU fade attribute into vAlpha (window mode)', () => {
    // aFade is sampleTrack's appear/disappear ramp. Folding it into vAlpha (not
    // into the colour) is what makes a fading-out head equally unpickable.
    for (const src of [
      ...bothVariants(buildTripHeadsVertexSource, cfg()),
      ...bothVariants(buildTripHeadsIdVertexSource, cfg()),
    ]) {
      expect(src).toContain('attribute float aFade;');
      expect(src).toContain(') * aFade;');
      // The fade is NOT folded into the colour — the id pass has no colour.
      expect(src).not.toContain('vColor.a * aFade');
    }
  });

  it('WAKE mode keeps the CPU fade OUT of vAlpha (one ramp, applied once)', () => {
    // sttWakeAlpha already ramps from the trip's own start — the same instant
    // sampleTrack's fade-in measures from — so folding aFade in would apply one
    // ramp twice AND, because vAlpha drives sttWakeSizeScale, invert the tail
    // taper (a just-departed head would be the most shrunken). deck's
    // AnimatedTripHeadsLayer applies no fade in wake mode either.
    for (const src of [
      ...bothVariants(buildTripHeadsVertexSource, cfg({ mode: 'wake' })),
      ...bothVariants(buildTripHeadsIdVertexSource, cfg({ mode: 'wake' })),
    ]) {
      expect(src).toContain(
        'vAlpha = sttWakeAlpha(aTime, uCurrentTime, uWakeLength);',
      );
      expect(src).not.toContain(') * aFade;');
    }
  });

  it('BOTH fragment stages discard a zero-alpha head before it paints', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const ctx = drawCtx(legacyFrame());
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    layer.drawPickTile(gl, tile, tile.layers[0], cache, ctx, 1);
    const fragments = gl.shaderSource.mock.calls
      .map((c: unknown[]) => c[1] as string)
      .filter((s: string) => s.includes('gl_FragColor'));
    expect(fragments.length).toBe(2);
    for (const fs of fragments)
      expect(fs).toContain('if (vAlpha <= 0.0) discard;');
    // Only the visual stage antialiases; an id texel must stay an exact triple.
    expect(
      fragments.filter((s: string) => s.includes('smoothstep')).length,
    ).toBe(1);
  });

  it('default config compiles NONE of the optional surface (wake / filter)', () => {
    for (const src of [
      ...bothVariants(buildTripHeadsVertexSource, cfg()),
      ...bothVariants(buildTripHeadsIdVertexSource, cfg()),
    ]) {
      expect(src).toContain('sttTimeWindowAlpha(aTime,');
      expect(src).not.toContain('uCurrentTime');
      expect(src).not.toContain('uWakeLength');
      expect(src).not.toContain('sttWakeSizeScale');
      expect(src).not.toContain('aFilterValue');
      expect(src).not.toContain('uFilterRange');
    }
  });

  it('wake compiles the wake kernel and shrinks the radius BEFORE gl_PointSize', () => {
    for (const src of [
      ...bothVariants(buildTripHeadsVertexSource, cfg({ mode: 'wake' })),
      ...bothVariants(buildTripHeadsIdVertexSource, cfg({ mode: 'wake' })),
    ]) {
      expect(src).toContain('float sttWakeAlpha(');
      expect(src).toContain(
        'vAlpha = sttWakeAlpha(aTime, uCurrentTime, uWakeLength);',
      );
      expect(src).toContain(
        'radiusPx *= sttWakeSizeScale(vAlpha, uWakeTailScale);',
      );
      expect(src.indexOf('vAlpha = sttWakeAlpha')).toBeLessThan(
        src.indexOf('radiusPx *= sttWakeSizeScale'),
      );
      expect(src.indexOf('radiusPx *= sttWakeSizeScale')).toBeLessThan(
        src.indexOf('gl_PointSize = radiusPx * 2.0;'),
      );
      // An unused mode's uniforms are not declared, so they cannot be mis-set.
      expect(src).not.toContain('uWindowStart');
      expect(src).not.toContain('sttTimeWindowAlpha');
    }
  });

  it('the DataFilter kernel splices into both variants and both passes', () => {
    const filtered = cfg({ filter: true });
    for (const src of [
      ...bothVariants(buildTripHeadsVertexSource, filtered),
      ...bothVariants(buildTripHeadsIdVertexSource, filtered),
    ]) {
      expect(src).toContain('attribute float aFilterValue;');
      expect(src).toContain('uniform vec2 uFilterRange;');
      expect(src).toContain('float sttDataFilterAlpha(');
      // The canonical call verbatim, so the layers cannot drift.
      expect(src).toContain(`float filterAlpha = ${DATA_FILTER_CALL_GLSL};`);
      expect(src).toContain('if (filterAlpha <= 0.0) {\n      vAlpha = 0.0;');
      expect(src).toContain('if (uFilterTransformSize > 0.5) {');
    }
  });

  it('a POINT primitive is gated by the FS discard, not a w=0 collapse', () => {
    const src = buildTripHeadsVertexSource(
      LEGACY_SHADER,
      cfg({ filter: true }),
    );
    expect(src).not.toContain('gl_Position = vec4(0.0)');
  });

  it('program keys separate every compiled configuration', () => {
    const keys = new Set([
      tripHeadsProgramKey('main', cfg()),
      tripHeadsProgramKey('main', cfg({ mode: 'wake' })),
      tripHeadsProgramKey('main', cfg({ filter: true })),
      tripHeadsProgramKey('pick', cfg()),
      tripHeadsProgramKey('pick', cfg({ mode: 'wake', filter: true })),
    ]);
    expect(keys.size).toBe(5);
    expect(tripHeadsProgramKey('main', cfg())).toBe('tripHeads:main:window');
    expect(
      tripHeadsProgramKey('pick', cfg({ mode: 'wake', filter: true })),
    ).toBe('tripHeads:pick:wake:filter');
  });
});

describe('time-mode resolution', () => {
  it('defaults to window and infers wake from a positive wakeLength', () => {
    expect(resolveTripHeadsTimeFilterMode(undefined, 0)).toEqual({
      mode: 'window',
      degraded: false,
    });
    expect(resolveTripHeadsTimeFilterMode(undefined, 1000)).toEqual({
      mode: 'wake',
      degraded: false,
    });
  });

  it('a degenerate wake length degrades to window without a warning', () => {
    expect(resolveTripHeadsTimeFilterMode('wake', 0)).toEqual({
      mode: 'window',
      degraded: false,
    });
  });

  it('cumulative and trail describe a HISTORY — degraded, and flagged', () => {
    for (const mode of ['cumulative', 'trail'] as const) {
      expect(resolveTripHeadsTimeFilterMode(mode, 5000)).toEqual({
        mode: 'window',
        degraded: true,
      });
    }
  });

  it('the layer warns exactly once for an unsupported mode', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layer = new STTTripHeadsLayer({
        ...baseOpts,
        id: 'h',
        timeFilterMode: 'trail',
      }) as any;
      layer.setTimeFilterMode('cumulative');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('STTTripsLayer');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('prop defaults (back-compat surface)', () => {
  it('matches the deck AnimatedTripHeadsLayer defaults it mirrors', () => {
    const layer = new STTTripHeadsLayer({ ...baseOpts, id: 'h' }) as any;
    expect(layer.headOpts.color).toEqual([253, 128, 93, 255]); // deck headColor
    expect(layer.headOpts.radius).toBe(4); // deck headRadiusPixels
    expect(layer.headOpts.radiusUnits).toBe('pixels');
    expect(layer.headOpts.radiusScale).toBe(1);
    expect(layer.headOpts.radiusMinPixels).toBe(0);
    expect(layer.headOpts.stroked).toBe(false); // deck headStroked
    expect(layer.headOpts.strokeWidth).toBe(1);
    expect(layer.headOpts.wakeLength).toBe(0);
    expect(layer.headOpts.wakeTailScale).toBe(0.15); // core DEFAULT_WAKE_TAIL_SCALE
    expect(layer.headOpts.maxInterpolationGap).toBe(Number.POSITIVE_INFINITY);
    expect(layer.shaderConfig).toEqual({ mode: 'window', filter: false });
    // No filter column ⇒ the instance stride carries no filter lane.
    expect(layer.stride).toBe(6);
  });

  it('an explicitly-passed undefined does not shadow a default', () => {
    const layer = new STTTripHeadsLayer({
      ...baseOpts,
      id: 'h',
      radius: undefined,
      stroked: undefined,
      colorPalette: undefined,
      maxInterpolationGap: undefined,
    }) as any;
    expect(layer.headOpts.radius).toBe(4);
    expect(layer.headOpts.stroked).toBe(false);
    expect(layer.headOpts.colorPalette.length).toBeGreaterThan(0);
    expect(layer.headOpts.maxInterpolationGap).toBe(Number.POSITIVE_INFINITY);
  });

  it('naming a filterProperty widens the instance stride by exactly one lane', () => {
    const layer = new STTTripHeadsLayer({
      ...baseOpts,
      id: 'h',
      filterProperty: 'magnitude',
    }) as any;
    expect(layer.shaderConfig.filter).toBe(true);
    expect(layer.stride).toBe(7);
  });
});

describe('CPU head interpolation (core track kernel)', () => {
  it('writeMercator is byte-identical to the shared lngLatToMercator', () => {
    const out = new Float32Array(2);
    for (const [lon, lat] of [
      [0, 0],
      [-122.4, 37.7],
      [179.9999, 85.05112877980659],
      [-180, -85.05112877980659],
      [12.5, 89.9], // beyond the mercator cutoff ⇒ must clamp identically
      [12.5, -89.9],
      [1, 0],
      [10, 5],
    ] as const) {
      const [mx, my] = lngLatToMercator(lon, lat);
      writeMercator(lon, lat, out, 0);
      expect(out[0]).toBe(Math.fround(mx));
      expect(out[1]).toBe(Math.fround(my));
    }
  });

  it('matches the deck reference on a vertex-timestamped tile, over the whole span', async () => {
    const f = makeHeadsTile().layers[0].features;
    for (const relTime of [0, 500, 1000, 1500, 2000, 2999, 4000, 5500, 6000]) {
      const ours = await kernelHeads(f, relTime);
      const ref = referenceHeads(f, relTime);
      expect(ours.map((h) => h.index)).toEqual(ref.map((h) => h.index));
      ours.forEach((h, i) => {
        expect(h.lon).toBeCloseTo(ref[i].lon, 12);
        expect(h.lat).toBeCloseTo(ref[i].lat, 12);
      });
    }
  });

  it('matches the deck reference when vertex times are SYNTHESIZED', async () => {
    // makeTripsTile has vertexTimestamps; strip them so both paths fall through
    // to the shared distance-proportional synthesis kernel.
    const tile = makeTripsTile();
    const f = tile.layers[0].features as any;
    delete f.vertexTimestamps;
    for (const relTime of [0, 250, 900, 1400, 1999]) {
      const ours = await kernelHeads(f, relTime);
      const ref = referenceHeads(f, relTime);
      expect(ours.map((h) => h.index)).toEqual(ref.map((h) => h.index));
      ours.forEach((h, i) => {
        expect(h.lon).toBeCloseTo(ref[i].lon, 12);
        expect(h.lat).toBeCloseTo(ref[i].lat, 12);
      });
    }
  });

  it('emits nothing for a playhead outside every trip', async () => {
    const f = makeHeadsTile().layers[0].features;
    expect(await kernelHeads(f, -1)).toEqual([]);
    expect(await kernelHeads(f, 6001)).toEqual([]);
    expect(referenceHeads(f, 6001)).toEqual([]);
  });

  it('holds a 1-vertex trip across its whole feature window', async () => {
    const f = makeHeadsTile().layers[0].features;
    // f2 is the single-vertex trip at (10, 5), active over [0, 3000].
    for (const relTime of [0, 1500, 3000]) {
      const held = (await kernelHeads(f, relTime)).find((h) => h.index === 2);
      expect(held).toBeDefined();
      expect(held!.lon).toBe(10);
      expect(held!.lat).toBe(5);
    }
    expect(
      (await kernelHeads(f, 3200)).find((h) => h.index === 2),
    ).toBeUndefined();
  });

  it('builds three view-backed keyframe arrays per trip, sharing the NaN columns', () => {
    const f = makeHeadsTile().layers[0].features;
    const set = buildTripTracks(f)!;
    expect(set.featureIndex).toEqual(Uint32Array.from([0, 1, 2]));
    // The kernel columns a trip has no per-vertex answer for are ONE shared
    // array across every track — the allocation contract in the doc comment.
    const [a, b] = set.tracks;
    expect(a.heading).toBe(b.heading);
    expect(a.width).toBe(b.width);
    expect(a.alt).toBe(b.alt);
    // ...and the per-trip keyframes are distinct views, sorted ascending.
    expect(a.times).not.toBe(b.times);
    expect(Array.from(a.times as unknown as Float64Array)).toEqual([
      TIME_OFFSET + 4000,
      TIME_OFFSET + 5000,
      TIME_OFFSET + 6000,
    ]);
    expect(a.singleton).toBe(false);
    // The single-vertex trip is expanded to two keyframes spanning [0, 3000].
    expect(set.tracks[2].singleton).toBe(false);
    expect(set.tracks[2].times.length).toBe(2);
  });

  it('returns null for a tile with no usable trip geometry', () => {
    const f = makeHeadsTile().layers[0].features;
    expect(
      buildTripTracks({ ...f, startIndices: undefined } as any),
    ).toBeNull();
    expect(buildTripTracks({ ...f, featureCount: 0 } as any)).toBeNull();
  });

  it('maxInterpolationGap HOLDS the last vertex instead of gliding through a data hole', async () => {
    const { sampleTrack } = await import('@poopdeck.gl/core');
    const f = makeHeadsTile().layers[0].features;
    const track = buildTripTracks(f)!.tracks[1]; // f1: 0 → 1000 → 2000
    const at = TIME_OFFSET + 1500;
    const glide = sampleTrack(track, at, {
      defaultLength: 0,
      defaultWidth: 0,
      defaultHeight: 0,
      fadeInDuration: 0,
      fadeOutDuration: 0,
      maxGapMs: Number.POSITIVE_INFINITY,
    })!;
    const held = sampleTrack(track, at, {
      defaultLength: 0,
      defaultWidth: 0,
      defaultHeight: 0,
      fadeInDuration: 0,
      fadeOutDuration: 0,
      maxGapMs: 500, // the 1000 ms bracket is now "a hole"
    })!;
    expect(glide.lon).toBeCloseTo(1.5, 12);
    expect(held.lon).toBe(1); // pinned to the bracket's low vertex
  });
});

describe('tile upload', () => {
  it('allocates the persistent instance buffer ONCE, sized to the trip count', () => {
    const { gl, cache } = makeLayerWithCache();
    expect(cache.capacity).toBe(3);
    expect(cache.trackSet.tracks.length).toBe(3);
    expect(cache.activeFeatureIndex.length).toBe(3);
    // stride 6 floats × 4 bytes × 3 trips, allocated without an upload.
    const sizes = gl.bufferData.mock.calls.map((c: unknown[]) => c[1]);
    expect(sizes).toContain(3 * 6 * 4);
    // No colour column configured ⇒ no per-head colour buffer.
    expect(cache.colorBuffer).toBeUndefined();
  });

  it('adds a per-head colour buffer only when a colour column resolves', () => {
    const withColumn = makeLayerWithCache({ colorProperty: 'vehicleType' });
    expect(withColumn.cache.colorBuffer).toBeDefined();
    expect(withColumn.cache.featureColors).not.toBeNull();
    // A column the tile does not carry falls back to the constant colour.
    const missing = makeLayerWithCache({ colorProperty: 'nope' });
    expect(missing.cache.colorBuffer).toBeUndefined();
    expect(missing.cache.featureColors).toBeNull();
  });

  it('extracts the DataFilter column at UPLOAD time', () => {
    const { cache } = makeLayerWithCache({
      filterProperty: 'magnitude',
      filterRange: [1, 5] as const,
    });
    expect(cache.hasFilterColumn).toBe(true);
    expect(Array.from(cache.filterValues)).toEqual([1, 5, 9]);
  });

  it('a CATEGORICAL filter column warns once and renders unfiltered', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { layer, gl } = makeLayerWithCache({
        filterProperty: 'vehicleType',
        filterRange: [0, 1] as const,
      });
      const t2 = makeHeadsTile();
      const c2 = layer.buildTileGpuCache(gl, t2, t2.layers[0]);
      expect(c2.hasFilterColumn).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('per-frame emit', () => {
  it('compacts to the ACTIVE heads and records their SOURCE feature indices', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));

    expect(cache.activeCount).toBe(2);
    expect(Array.from(cache.activeFeatureIndex.subarray(0, 2))).toEqual([1, 2]);
    expect(gl.drawArrays).toHaveBeenCalledWith(gl.POINTS, 0, 2);
  });

  it('writes the interleaved lane layout the attributes are bound to', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({ radius: 7 });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));

    const upload = gl.subUploads.at(-1)!;
    expect(upload.offset).toBe(0);
    expect(upload.values.length).toBe(2 * 6);

    // Head 0 is feature 1, mid-trip at lon 1 / lat 0.
    const [mx, my] = lngLatToMercator(1, 0);
    expect(upload.values[0]).toBeCloseTo(mx, 6);
    expect(upload.values[1]).toBeCloseTo(my, 6);
    expect(upload.values[2]).toBe(0); // aTime.x — feature startTime, tile-relative
    expect(upload.values[3]).toBe(2000); // aTime.y — feature endTime
    expect(upload.values[4]).toBe(7); // aRadius — the constant radius
    expect(upload.values[5]).toBe(1); // aFade — no ramp configured

    // Head 1 is feature 2, the held single-vertex trip at (10, 5).
    const [hx, hy] = lngLatToMercator(10, 5);
    expect(upload.values[6]).toBeCloseTo(hx, 6);
    expect(upload.values[7]).toBeCloseTo(hy, 6);
    expect(upload.values[9]).toBe(3000);
  });

  it('splats per-feature columns into the COMPACTED order', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      radiusProperty: 'size',
      filterProperty: 'magnitude',
      filterRange: [0, 100] as const,
      colorProperty: 'vehicleType',
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));

    // Two uploads per frame with a colour column: instance lanes, then colours.
    const colours = gl.subUploads.at(-1)!;
    const lanes = gl.subUploads.at(-2)!;
    expect(lanes.values.length).toBe(2 * 7);
    // features 1 and 2 ⇒ size 6 / 10, magnitude 5 / 9 — NOT 2 / 6 and 1 / 5.
    expect(lanes.values[4]).toBe(6);
    expect(lanes.values[6]).toBe(5);
    expect(lanes.values[11]).toBe(10);
    expect(lanes.values[13]).toBe(9);
    expect(colours.values.length).toBe(2 * 4);
  });

  it('re-uploads into the SAME buffer every frame — never re-allocates', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const buffers = gl.createBuffer.mock.calls.length;
    const allocs = gl.bufferData.mock.calls.length;
    for (const t of [500, 1000, 1500]) {
      layer.drawTile(
        gl,
        tile,
        tile.layers[0],
        cache,
        drawCtx(legacyFrame(), TIME_OFFSET + t),
      );
    }
    expect(gl.createBuffer.mock.calls.length).toBe(buffers);
    expect(gl.bufferData.mock.calls.length).toBe(allocs);
    expect(gl.bufferSubData).toHaveBeenCalledTimes(3);
    // The head MOVED between frames — the point of the whole layer.
    expect(gl.subUploads[0].values[0]).not.toBe(gl.subUploads[2].values[0]);
  });

  it('draws nothing when no trip is active at the playhead', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame(), TIME_OFFSET + 100_000),
    );
    expect(cache.activeCount).toBe(0);
    expect(gl.drawArrays).not.toHaveBeenCalled();
    expect(gl.bufferSubData).not.toHaveBeenCalled();
  });

  it('the CPU fade ramps aFade against the TRIP span, not the layer window', () => {
    // softTimeWindow: true ⇒ fades default to 10% of timeWindow = 1000 ms.
    const { layer, gl, tile, cache } = makeLayerWithCache({
      softTimeWindow: true,
    });
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      // 300 ms into f1's 0→2000 trip: 300/1000 of the fade-in ramp.
      drawCtx(legacyFrame(), TIME_OFFSET + 300),
    );
    const lanes = gl.subUploads.at(-1)!;
    expect(lanes.values[5]).toBeCloseTo(0.3, 5);
    // ...and the shader's own window fades stay HARD so the ramp is not squared.
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uFadeIn')).toBe(0);
    expect(lastScalar(u, 'uFadeOut')).toBe(0);
  });

  it('WAKE mode emits NO CPU fade — the wake ramp is the only ramp', () => {
    // Same soft window, but wake mode: sttWakeAlpha already ramps from the
    // trip's own start, so a CPU fade-in measured from that same instant would
    // apply one ramp twice — and (because vAlpha drives sttWakeSizeScale) would
    // make a just-departed head the most SHRUNKEN one instead of full size.
    const { layer, gl, tile, cache } = makeLayerWithCache({
      softTimeWindow: true,
      timeFilterMode: 'wake',
      wakeLength: 5000,
    });
    layer.drawTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame(), TIME_OFFSET + 300),
    );
    // aFade rides lane 5 — 1.0 (no ramp), where window mode showed 0.3.
    expect(gl.subUploads.at(-1)!.values[5]).toBe(1);
  });
});

describe('drawTile variant dispatch', () => {
  it('v5 frame: compiles the prelude source, sets u_projection_* and skips uMatrix', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const frame = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));

    expect(
      vertexSources(gl).some(
        (s) =>
          s.includes(PRELUDE_MARKER) && s.includes('projectTile(aMercator)'),
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
    // uMatrix is never even LOOKED UP on a prelude variant.
    expect(looked).not.toContain('uMatrix');
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

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));
    expect(gl.createProgram.mock.calls.length).toBe(programs);
    expect(gl.createVertexArray.mock.calls.length).toBe(vaos);
  });

  it('a variant flip relinks once and rebuilds the tile VAO against it', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const legacy = normalizeRenderArgs(new Float32Array(16));
    const globe = normalizeRenderArgs(v5Args('globe', 1));

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacy));
    expect(gl.createProgram.mock.calls.length).toBe(1);
    expect(gl.createVertexArray.mock.calls.length).toBe(1);

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(globe));
    expect(gl.createProgram.mock.calls.length).toBe(2);
    expect(gl.deleteVertexArray).toHaveBeenCalledTimes(1);
    expect(gl.createVertexArray.mock.calls.length).toBe(2);

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacy));
    expect(gl.createProgram.mock.calls.length).toBe(2);
    expect(gl.createVertexArray.mock.calls.length).toBe(3);
  });

  it('setWakeLength flips the compiled mode: one relink, VAO re-recorded', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.createProgram.mock.calls.length).toBe(1);

    layer.setWakeLength(3000);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.createProgram.mock.calls.length).toBe(2);
    expect(gl.deleteVertexArray).toHaveBeenCalledTimes(1);
    expect(vertexSources(gl).some((s) => s.includes('sttWakeSizeScale'))).toBe(
      true,
    );
  });

  it('a mode setter resolving to the SAME mode does not relink', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    layer.setTimeFilterMode('wake'); // wakeLength is 0 ⇒ still window
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.createProgram.mock.calls.length).toBe(1);
  });
});

describe('uniform wiring', () => {
  it('window mode sets the window bounds and hard fades', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const ctx = drawCtx(legacyFrame());
    layer.drawTile(gl, tile, tile.layers[0], cache, ctx);
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uWindowStart')).toBe(ctx.windowStart);
    expect(lastScalar(u, 'uWindowEnd')).toBe(ctx.windowEnd);
    expect(u.has('uCurrentTime')).toBe(false);
    expect(u.has('uWakeLength')).toBe(false);
    expect(u.has('uFilterEnabled')).toBe(false);
    expect(lastScalar(u, 'uRadiusScale')).toBe(1);
    expect(u.get('uRadiusPixelRange')!.at(-1)).toEqual([0, 1e6]);
  });

  it('wake mode sets tile-relative uCurrentTime + the wake knobs', () => {
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

  it('the contrast ring is uniform-only — no extra program variant', () => {
    const plain = makeLayerWithCache();
    plain.layer.drawTile(
      plain.gl,
      plain.tile,
      plain.tile.layers[0],
      plain.cache,
      drawCtx(legacyFrame()),
    );
    expect(lastScalar(uniformsByName(plain.gl), 'uStrokeWidth')).toBe(0);

    const ringed = makeLayerWithCache({
      stroked: true,
      strokeWidth: 2,
      strokeColor: [255, 255, 255, 255] as [number, number, number, number],
    });
    ringed.layer.drawTile(
      ringed.gl,
      ringed.tile,
      ringed.tile.layers[0],
      ringed.cache,
      drawCtx(legacyFrame()),
    );
    expect(lastScalar(uniformsByName(ringed.gl), 'uStrokeWidth')).toBe(2);
    // Same source both ways: the ring is a coherent uniform branch in the FS.
    expect(buildTripHeadsVertexSource(LEGACY_SHADER)).toBe(
      buildTripHeadsVertexSource(LEGACY_SHADER),
    );
    expect(ringed.gl.createProgram.mock.calls.length).toBe(1);
  });

  it("radiusUnits 'meters' folds the per-tile metres→device-px factor in", () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      radiusUnits: 'meters',
      radius: 250,
      radiusScale: 2,
    });
    layer.map = { getZoom: () => 2.5, triggerRepaint: vi.fn() };
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));

    const dpr =
      (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1;
    const expected =
      2 *
      metersToPixelsAtLatitude(
        1,
        tileCenterLatitude(tile.id.z, tile.id.y),
        2.5,
        512 * dpr,
      );
    expect(lastScalar(uniformsByName(gl), 'uRadiusScale')).toBeCloseTo(
      expected,
      6,
    );
    // The radius itself still rides the instance lane raw — the unit is in the scale.
    expect(gl.subUploads.at(-1)!.values[4]).toBe(250);
  });

  it('DataFilter uniforms follow the tile, and a missing column idles them', () => {
    const present = makeLayerWithCache({
      filterProperty: 'magnitude',
      filterRange: [1, 5] as const,
    });
    present.layer.drawTile(
      present.gl,
      present.tile,
      present.tile.layers[0],
      present.cache,
      drawCtx(legacyFrame()),
    );
    const u = uniformsByName(present.gl);
    expect(lastScalar(u, 'uFilterEnabled')).toBe(1);
    expect(
      Array.from(u.get('uFilterRange')!.at(-1)![0] as Float32Array),
    ).toEqual([1, 5]);
    expect(
      Array.from(u.get('uFilterSoftRange')!.at(-1)![0] as Float32Array),
    ).toEqual([1, 5]);

    const absent = makeLayerWithCache({
      filterProperty: 'not-a-column',
      filterRange: [1, 5] as const,
    });
    absent.layer.drawTile(
      absent.gl,
      absent.tile,
      absent.tile.layers[0],
      absent.cache,
      drawCtx(legacyFrame()),
    );
    expect(lastScalar(uniformsByName(absent.gl), 'uFilterEnabled')).toBe(0);
  });

  it('setFilterRange is uniform-only — no relink, no re-allocation', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      filterProperty: 'magnitude',
      filterRange: [1, 5] as const,
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const programs = gl.createProgram.mock.calls.length;
    const allocs = gl.bufferData.mock.calls.length;

    layer.setFilterRange([2, 9]);
    layer.setFilterSoftRange([3, 8]);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.createProgram.mock.calls.length).toBe(programs);
    expect(gl.bufferData.mock.calls.length).toBe(allocs);
    const u = uniformsByName(gl);
    expect(
      Array.from(u.get('uFilterRange')!.at(-1)![0] as Float32Array),
    ).toEqual([2, 9]);
    expect(
      Array.from(u.get('uFilterSoftRange')!.at(-1)![0] as Float32Array),
    ).toEqual([3, 8]);
  });
});

describe('picking (invisible ⇒ unpickable, compacted ⇒ still correct)', () => {
  it('paints ids from the SOURCE feature index, not the draw order', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    expect(gl.drawArrays).toHaveBeenCalledWith(gl.POINTS, 0, 2);

    // The two emitted heads are features 1 and 2, so with idBase 1 their ids
    // must be 2 and 3 — NOT 1 and 2 (which is what a draw-order id would give).
    const ids = layer.buildActiveIdColors(cache, 1, 2, 3);
    expect(Array.from(ids.subarray(0, 3))).toEqual(Array.from(encodePickId(2)));
    expect(Array.from(ids.subarray(3, 6))).toEqual(Array.from(encodePickId(3)));
  });

  it('round-trips a decoded id back to the right feature row', () => {
    const { layer, tile, cache } = makeLayerWithCache();
    const provenance = [
      { tile, layer: tile.layers[0], cache, idBase: 1, count: 3 },
    ];
    // Head 1 on screen (draw index 1) is feature 2 ⇒ global id 3.
    const hit = layer.resolvePick(encodePickId(3), provenance);
    expect(hit).not.toBeNull();
    expect(hit.index).toBe(2);
    expect(hit.layerId).toBe('trips');
    expect(hit.object).toEqual(
      getFeatureProperties(tile.layers[0].features, 2),
    );
  });

  it('rejects a non-1-based idBase (the reserved background id)', () => {
    const { layer, cache } = makeLayerWithCache();
    expect(() => layer.buildActiveIdColors(cache, 0, 2, 3)).toThrow(RangeError);
  });

  it('never borrows ids past the range the base reserved', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    // Pretend the base reserved only 2 ids: feature 2 must fall back to the
    // cleared background rather than aliasing the next entry's first feature.
    const ids = layer.buildActiveIdColors(cache, 1, 2, 2);
    expect(Array.from(ids.subarray(3, 6))).toEqual([0, 0, 0]);
  });

  it('emits nothing — and therefore nothing pickable — outside every trip', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame(), TIME_OFFSET + 100_000),
      1,
    );
    expect(gl.drawArrays).not.toHaveBeenCalled();
    expect(gl.deleteBuffer).not.toHaveBeenCalled();
  });

  it('the id pass compiles the SAME time mode and filter gates', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      timeFilterMode: 'wake',
      wakeLength: 30_000,
      filterProperty: 'magnitude',
      filterRange: [1, 5] as const,
    });
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    const idSrc = vertexSources(gl).find((s) =>
      s.includes('attribute vec3 aIdColor;'),
    )!;
    expect(idSrc).toContain(
      'vAlpha = sttWakeAlpha(aTime, uCurrentTime, uWakeLength);',
    );
    expect(idSrc).toContain(
      'radiusPx *= sttWakeSizeScale(vAlpha, uWakeTailScale);',
    );
    expect(idSrc).toContain(`float filterAlpha = ${DATA_FILTER_CALL_GLSL};`);

    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uWakeLength')).toBe(30_000);
    expect(lastScalar(u, 'uFilterEnabled')).toBe(1);
  });

  it('the id pass sizes in the SAME units as the visual pass', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      radiusUnits: 'meters',
      radius: 250,
    });
    layer.map = { getZoom: () => 4, triggerRepaint: vi.fn() };
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const visual = lastScalar(uniformsByName(gl), 'uRadiusScale');

    const gl2 = makeGl();
    layer.drawPickTile(
      gl2,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    expect(lastScalar(uniformsByName(gl2), 'uRadiusScale')).toBe(visual);
  });

  it('leaves no attribute slot enabled behind (nothing is instanced here)', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      filterProperty: 'magnitude',
      filterRange: [1, 5] as const,
    });
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    // Every slot the pass enabled is disabled again, and the one-shot id buffer
    // is freed. No divisors are ever set, so none can be left dirty.
    expect(gl.disableVertexAttribArray.mock.calls.length).toBe(
      gl.enableVertexAttribArray.mock.calls.length,
    );
    expect(gl.vertexAttribDivisor).not.toHaveBeenCalled();
    expect(gl.deleteBuffer).toHaveBeenCalled();
  });
});

describe('JS references used by the compiled trip-heads shaders', () => {
  it('wake alpha + tail scale compose exactly as the vertex source does', () => {
    const tail = 0.15;
    expect(wakeAlphaJS(0, 0, 1000)).toBe(1);
    expect(wakeSizeScaleJS(wakeAlphaJS(0, 0, 1000), tail)).toBe(1);
    expect(wakeAlphaJS(0, 1000, 1000)).toBe(0);
    expect(wakeSizeScaleJS(wakeAlphaJS(0, 1000, 1000), tail)).toBeCloseTo(
      tail,
      12,
    );
  });

  it('the CPU fade multiplies the shader alpha rather than replacing it', () => {
    // Mirrors WINDOW mode's `vAlpha = sttTimeWindowAlpha(...) * aFade`, then
    // the filter composition. (Wake mode carries no `aFade` — see MODE_ALPHA.)
    const compose = (
      modeAlpha: number,
      fade: number,
      value: number,
      range: number[],
      soft: number[],
      transformColor: boolean,
    ): number => {
      let vAlpha = modeAlpha * fade;
      const f = dataFilterAlphaJS(value, range, soft, true);
      if (f <= 0) return 0;
      if (transformColor) vAlpha *= f;
      return vAlpha;
    };
    expect(compose(1, 0.5, 5, [0, 10], [0, 10], true)).toBeCloseTo(0.5, 12);
    // A fully faded-out head is invisible whatever the filter says.
    expect(compose(1, 0, 5, [0, 10], [0, 10], true)).toBe(0);
    // A hard-filtered head is hidden even at full fade.
    expect(compose(1, 1, 99, [0, 10], [0, 10], false)).toBe(0);
  });
});

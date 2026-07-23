/**
 * STTIconLayer (Wave M3) — rotated atlas billboards, all four time modes, the
 * column filter, metric sizing, id picking and the CPU motion-glide path.
 *
 * Coverage mirrors the M2 layer suites (`point-variants.test.ts` is the
 * template): shader sources are asserted at the STRING level on BOTH host
 * variants (a gate that lands on only one of them is a globe-only bug), CPU
 * math is checked against JS references, and the draw paths are driven through
 * the mock-GL recorder. Real prelude compilation, the atlas upload and the FBO
 * round-trip stay browser-verify-only.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  GeometryType,
  TrackIndexMaintainer,
  type Tile,
  type Layer,
} from '@poopdeck.gl/core';
import { encodePickId, decodePickId } from '@poopdeck.gl/core/picking';
import { normalizeRenderArgs } from '../src/lib/host-adapter';
import {
  STTIconLayer,
  buildIconVertexSource,
  buildIconIdVertexSource,
  iconProgramKey,
  resolveIconTimeFilterMode,
  writeIconFrame,
  bearingFromMotionDeg,
  type IconShaderConfig,
} from '../src/layers/icon-layer';
import { DATA_FILTER_CALL_GLSL } from '../src/shaders/data-filter.glsl';
import { wakeAlphaJS, wakeSizeScaleJS } from '../src/shaders/time-window.glsl';
import {
  lngLatToMercator,
  metersToPixelsAtLatitude,
  tileCenterLatitude,
} from '../src/lib/projection';
import { makeMockGl, makeMockMap } from './mock-gl';

const TIME_OFFSET = 1_700_000_000_000;

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: TIME_OFFSET + 1000,
  timeWindow: 5000,
};

/** A 64×64 atlas with one 32×32 sprite — enough for every draw path. */
const ATLAS = { width: 64, height: 64 };
const MAPPING = {
  marker: { x: 0, y: 0, width: 32, height: 32 },
  tanker: { x: 32, y: 0, width: 32, height: 16, mask: true },
};

const atlasOpts = { iconAtlas: ATLAS, iconMapping: MAPPING };

const PRELUDE_MARKER = '// __HOST_PRELUDE__';
const PRELUDE = `${PRELUDE_MARKER}\nvec4 projectTile(vec2 p) { return vec4(p, 0.0, 1.0); }`;
const LEGACY_SHADER = { prelude: '', define: '' };
const V5_SHADER = { prelude: PRELUDE, define: '#define GLOBE' };

const cfg = (over: Partial<IconShaderConfig> = {}): IconShaderConfig => ({
  mode: 'window',
  filter: false,
  glide: false,
  ...over,
});

/** Both host variants of one configuration, for "identical in both" assertions. */
const bothVariants = (
  build: (s: typeof LEGACY_SHADER, c: IconShaderConfig) => string,
  c: IconShaderConfig,
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

const legacyFrame = () => normalizeRenderArgs(new Float32Array(16));

const drawCtx = (frame?: ReturnType<typeof normalizeRenderArgs>) => ({
  matrix: frame ? frame.matrix : new Float32Array(16),
  frame,
  windowStart: 0,
  windowEnd: 10_000,
  currentTime: baseOpts.currentTime,
  zoom: 2,
});

/** All vertex-shader sources handed to the mock GL so far. */
const vertexSources = (gl: any): string[] =>
  gl.shaderSource.mock.calls.map((c: unknown[]) => c[1] as string);

/** Uniform uploads keyed by NAME (the mock hands out one handle per lookup). */
function uniformsByName(gl: any): Map<string, unknown[][]> {
  const nameByLoc = new Map<unknown, string>();
  gl.getUniformLocation.mock.calls.forEach((call: unknown[], i: number) => {
    nameByLoc.set(gl.getUniformLocation.mock.results[i].value, call[1]);
  });
  const out = new Map<string, unknown[][]>();
  for (const fn of [
    gl.uniform1f,
    gl.uniform1i,
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

/**
 * The most recently uploaded per-instance id-colour buffer, for `instances`
 * instances (3 bytes each). Sized exactly so the glide path's own RGBA colour
 * buffer can never be mistaken for it.
 */
const lastIdColors = (gl: any, instances = 1): Uint8Array =>
  gl.bufferData.mock.calls
    .map((c: unknown[]) => c[1])
    .filter(
      (d: unknown) => d instanceof Uint8Array && d.length === instances * 3,
    )
    .at(-1)!;

const lastIdTriple = (gl: any): [number, number, number] => {
  const c = lastIdColors(gl);
  return [c[0], c[1], c[2]];
};

// Unpack pixel-store parameters, as literals (the recorder declares only the
// constants the layers use). `getParameter` returns a BOOLEAN for both.
const UNPACK_FLIP_Y_WEBGL = 0x9240;
const UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0x9241;

/**
 * Teach a recorder about unpack pixel-store state — the one piece of GL state
 * the atlas upload shares with the host and must hand back. Records the flags
 * as they stood AT the `texImage2D` call, which is the only moment that decides
 * how the sprite's alpha is encoded.
 */
function withUnpackState(
  gl: any,
  initial: { premultiply?: boolean; flipY?: boolean } = {},
) {
  const state = new Map<number, boolean>([
    [UNPACK_PREMULTIPLY_ALPHA_WEBGL, initial.premultiply ?? false],
    [UNPACK_FLIP_Y_WEBGL, initial.flipY ?? false],
  ]);
  const atUpload: { premultiply?: boolean; flipY?: boolean } = {};
  const inner = gl.getParameter;
  gl.getParameter = vi.fn((pname: number) =>
    state.has(pname) ? state.get(pname) : inner(pname),
  );
  gl.pixelStorei = vi.fn((pname: number, value: boolean) => {
    state.set(pname, value);
  });
  gl.texImage2D = vi.fn(() => {
    atUpload.premultiply = state.get(UNPACK_PREMULTIPLY_ALPHA_WEBGL);
    atUpload.flipY = state.get(UNPACK_FLIP_Y_WEBGL);
  });
  return { state, atUpload };
}

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * Two vessels with a heading column (degrees), a categorical class column, a
 * numeric size column and a numeric filter column.
 */
function makeIconTile(): Tile {
  const features = {
    featureCount: 2,
    geometryType: GeometryType.Point,
    positionDimensions: 2 as const,
    positions: new Float64Array([-122.4, 37.7, -73.95, 40.75]),
    featureIds: new Uint32Array([0, 1]),
    startTimes: new Float32Array([0, 5000]),
    endTimes: new Float32Array([3000, 8000]),
    timeOffset: TIME_OFFSET,
    numericProps: {
      cog: new Float32Array([90, 180]),
      length_m: new Float32Array([100, 250]),
      magnitude: new Float32Array([2, 8]),
    },
    categoricalProps: {
      vessel_class: {
        indices: new Uint16Array([0, 1]),
        categories: ['cargo', 'tanker'],
      },
    },
  };
  const layer: Layer = {
    name: 'vessels',
    extent: 4096,
    features,
    geometryExtensionName: 'geoarrow.point',
  };
  return {
    id: { z: 2, x: 1, y: 1, t: TIME_OFFSET },
    timeRange: { start: TIME_OFFSET, end: TIME_OFFSET + 8000 },
    layers: [layer],
  };
}

/** One snapshot of one tracked entity — the glide-path building block. */
function makeTrackTile(opts: {
  t: number;
  lon: number;
  lat: number;
  startTime: number;
  id: string;
  heading?: number;
}): Tile {
  const features = {
    featureCount: 1,
    geometryType: GeometryType.Point,
    positionDimensions: 2 as const,
    positions: new Float64Array([opts.lon, opts.lat]),
    featureIds: new Uint32Array([0]),
    startTimes: new Float32Array([opts.startTime]),
    endTimes: new Float32Array([opts.startTime]),
    timeOffset: TIME_OFFSET,
    numericProps:
      opts.heading === undefined
        ? {}
        : { cog: new Float32Array([opts.heading]) },
    categoricalProps: {
      mmsi: { indices: new Uint16Array([0]), categories: [opts.id] },
    },
  };
  const layer: Layer = {
    name: 'vessels',
    extent: 4096,
    features,
    geometryExtensionName: 'geoarrow.point',
  };
  return {
    id: { z: 2, x: 1, y: 1, t: opts.t },
    timeRange: { start: TIME_OFFSET, end: TIME_OFFSET + 60_000 },
    layers: [layer],
  };
}

const tileKey = (t: Tile) => `${t.id.z}/${t.id.x}/${t.id.y}/${t.id.t}`;

/** Wire the GL capability stubs the direct-hook tests bypass (onAdd does it). */
function stubCaps(layer: any, gl: any): void {
  layer.supports32BitIndices = true;
  layer.vaoSupport = {
    enabled: true,
    create: () => gl.createVertexArray(),
    bind: (vao: unknown) => gl.bindVertexArray(vao),
    delete: (vao: unknown) => gl.deleteVertexArray(vao),
    current: () => null,
  };
  layer.instSupport = {
    enabled: true,
    drawArraysInstanced: vi.fn(
      (mode: number, first: number, count: number, prim: number) =>
        gl.drawArraysInstanced(mode, first, count, prim),
    ),
    drawElementsInstanced: vi.fn(),
    vertexAttribDivisor: vi.fn(),
  };
}

function makeLayerWithCache(
  extra: Record<string, unknown> = {},
  tile = makeIconTile(),
) {
  const layer = new STTIconLayer({
    ...baseOpts,
    ...atlasOpts,
    id: 'icons',
    ...extra,
  }) as any;
  const gl = makeMockGl();
  stubCaps(layer, gl);
  const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
  return { layer, gl, tile, cache };
}

/** A layer wired for a full `render()` pass over a hand-placed resident set. */
function makeRenderableLayer(extra: Record<string, unknown>, tiles: Tile[]) {
  const layer = new STTIconLayer({
    ...baseOpts,
    ...atlasOpts,
    id: 'icons',
    ...extra,
  }) as any;
  const gl = makeMockGl();
  stubCaps(layer, gl);
  layer.map = makeMockMap();
  layer.tileset = { update: vi.fn() };
  layer.loadedTiles = new Map(tiles.map((t) => [tileKey(t), t]));
  return { layer, gl };
}

// ── shader sources ──────────────────────────────────────────────────────────

describe('icon vertex-source builder', () => {
  it('legacy variant (empty prelude) projects the anchor through uMatrix', () => {
    const src = buildIconVertexSource(LEGACY_SHADER);
    expect(src).toContain('uniform mat4 uMatrix;');
    expect(src).toContain('vec4 anchor = uMatrix * vec4(');
    expect(src).not.toContain('projectTile(');
    expect(src).toContain(
      'sttDecodeMercatorPos(aMercator, uPosScale, uPosOffset)',
    );
    expect(src).toContain('sttTimeWindowAlpha(aTime,');
  });

  it('v5 variant prepends prelude then define and projects via projectTile', () => {
    const src = buildIconVertexSource(V5_SHADER);
    expect(src.startsWith(PRELUDE)).toBe(true);
    const defineAt = src.indexOf('#define GLOBE');
    expect(defineAt).toBeGreaterThan(PRELUDE_MARKER.length);
    expect(defineAt).toBeLessThan(src.indexOf('attribute vec2 aCorner'));
    expect(src).toContain('vec4 anchor = projectTile(mercator.xy);');
    expect(src).not.toContain('uniform mat4 uMatrix;');
  });

  it('both variants build the same instanced billboard geometry', () => {
    for (const src of bothVariants(buildIconVertexSource, cfg())) {
      // Per-vertex quad corner + per-instance anchor/sprite/style attributes.
      expect(src).toContain('attribute vec2 aCorner;');
      expect(src).toContain('attribute vec4 aIconRect;');
      expect(src).toContain('attribute vec4 aIconMeta;');
      expect(src).toContain('uniform vec4 uIconRect;');
      expect(src).toContain('uniform float uUseFeatureIcon;');
      // Sprite-pixel → device-pixel scale keyed on the size basis, guarded
      // against a zero-size (missing) mapping entry.
      expect(src).toContain(
        'float basis = (uSizeBasisWidth > 0.5) ? rect.z : rect.w;',
      );
      expect(src).toContain(
        'float scale = (basis > 0.0) ? sizePx / basis : 0.0;',
      );
      // deck IconLayer's rotate-then-flip-y, so the angle is CCW on screen.
      expect(src).toContain(
        'vec2 offsetPx = vec2(ca * iconPx.x + sa * iconPx.y, sa * iconPx.x - ca * iconPx.y);',
      );
      // Screen-space offset added in NDC — the quad is always camera-facing.
      expect(src).toContain(
        'gl_Position.xy += (offsetPx / (0.5 * uViewport)) * anchor.w;',
      );
      expect(src).toContain('vUv = (rect.xy + spritePx) / uAtlasSize;');
      // Size clamps land AFTER the unit conversion (deck ordering).
      expect(src.indexOf('sizePx = clamp(')).toBeLessThan(
        src.indexOf('float basis ='),
      );
    }
  });

  it('id-pick builder mirrors both variants (flat id colour, same projection)', () => {
    const legacy = buildIconIdVertexSource(LEGACY_SHADER);
    expect(legacy).toContain('attribute vec3 aIdColor;');
    expect(legacy).toContain('vec4 anchor = uMatrix * vec4(');
    expect(legacy).not.toContain('projectTile(');

    const v5 = buildIconIdVertexSource(V5_SHADER);
    expect(v5.startsWith(PRELUDE)).toBe(true);
    expect(v5).toContain('attribute vec3 aIdColor;');
    expect(v5).toContain('vec4 anchor = projectTile(mercator.xy);');
    expect(v5).not.toContain('uniform mat4 uMatrix;');
    // The id pass still carries the tint alpha so a transparent icon is not a
    // hidden hit box — and it does NOT carry the mask colour mode.
    expect(v5).toContain(
      'vColor = (uUseFeatureColor > 0.5) ? aColor : uColor;',
    );
    expect(v5).not.toContain('vColorMode');
  });

  it('default config compiles NONE of the optional surface (back-compat)', () => {
    for (const src of [
      ...bothVariants(buildIconVertexSource, cfg()),
      ...bothVariants(buildIconIdVertexSource, cfg()),
    ]) {
      expect(src).toContain('sttTimeWindowAlpha(aTime,');
      expect(src).not.toContain('uCurrentTime');
      expect(src).not.toContain('uWakeLength');
      expect(src).not.toContain('uTrailLength');
      expect(src).not.toContain('aFilterValue');
      expect(src).not.toContain('uFilterRange');
    }
  });
});

describe('time-filter mode compilation', () => {
  it('wake compiles the wake kernel and tapers the sprite AFTER the clamp', () => {
    for (const src of [
      ...bothVariants(buildIconVertexSource, cfg({ mode: 'wake' })),
      ...bothVariants(buildIconIdVertexSource, cfg({ mode: 'wake' })),
    ]) {
      expect(src).toContain('float sttWakeAlpha(');
      expect(src).toContain(
        'vAlpha = sttWakeAlpha(aTime, uCurrentTime, uWakeLength);',
      );
      expect(src).toContain(
        'sizePx *= sttWakeSizeScale(vAlpha, uWakeTailScale);',
      );
      // The size scale reads the alpha, so the alpha comes first…
      expect(src.indexOf('vAlpha = sttWakeAlpha')).toBeLessThan(
        src.indexOf('sizePx *= sttWakeSizeScale'),
      );
      // …and the min/max CLAMP applies to the base size, before the taper —
      // deck's icon-layer-vertex.glsl clamps inside `instanceScale` and only
      // then runs DECKGL_FILTER_SIZE. Clamping last would let `sizeMinPixels`
      // undo the taper entirely (a 24 px sprite tapering to 3.6 px would be
      // pushed back to a 12 px floor, i.e. no taper at all).
      expect(src.indexOf('sizePx = clamp(')).toBeLessThan(
        src.indexOf('sizePx *= sttWakeSizeScale'),
      );
      // Window uniforms are gone — an unused uniform can't be mis-set.
      expect(src).not.toContain('uWindowStart');
      expect(src).not.toContain('sttTimeWindowAlpha');
    }
  });

  it('cumulative compiles the cumulative kernel and reuses uFadeIn', () => {
    for (const src of bothVariants(
      buildIconVertexSource,
      cfg({ mode: 'cumulative' }),
    )) {
      expect(src).toContain('float sttCumulativeAlpha(');
      expect(src).toContain(
        'vAlpha = sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn);',
      );
      expect(src).not.toContain('uFadeOut');
      expect(src).not.toContain('sttWakeSizeScale');
    }
  });

  it('trail reads aTime.x (an icon IS its own single anchor)', () => {
    for (const src of bothVariants(
      buildIconVertexSource,
      cfg({ mode: 'trail' }),
    )) {
      expect(src).toContain('float sttTrailAlpha(');
      expect(src).toContain(
        'vAlpha = sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail);',
      );
      expect(src).toContain('uniform float uFadeTrail;');
    }
  });

  it('every mode keeps the projection of its host variant', () => {
    for (const mode of ['window', 'wake', 'cumulative', 'trail'] as const) {
      const [legacy, v5] = bothVariants(buildIconVertexSource, cfg({ mode }));
      expect(legacy).toContain('vec4 anchor = uMatrix * vec4(');
      expect(legacy).not.toContain('projectTile(');
      expect(v5).toContain('vec4 anchor = projectTile(mercator.xy);');
      expect(v5).not.toContain('uniform mat4 uMatrix;');
    }
  });
});

describe('DataFilter compilation', () => {
  const filtered = cfg({ filter: true });

  it('splices the attribute, uniforms and kernel into both variants and passes', () => {
    for (const src of [
      ...bothVariants(buildIconVertexSource, filtered),
      ...bothVariants(buildIconIdVertexSource, filtered),
    ]) {
      expect(src).toContain('attribute float aFilterValue;');
      expect(src).toContain('uniform vec2 uFilterRange;');
      expect(src).toContain('float sttDataFilterAlpha(');
      // The canonical call verbatim, so the kinds cannot drift.
      expect(src).toContain(`float filterAlpha = ${DATA_FILTER_CALL_GLSL};`);
    }
  });

  it('hides hard-filtered features regardless of the transform flags', () => {
    const src = buildIconVertexSource(LEGACY_SHADER, filtered);
    expect(src).toContain('if (filterAlpha <= 0.0) {\n      vAlpha = 0.0;');
    expect(src).toContain('} else if (uFilterTransformColor > 0.5) {');
    expect(src).toContain('sizePx *= filterAlpha;');
    // A vertex-expanded quad also collapses (deck's vs:#main-end), which the
    // point layer cannot do — a GL_POINTS w=0 has no defined NDC position.
    expect(src).toContain('if (filterAlpha <= 0.0) gl_Position = vec4(0.0);');
    expect(src.indexOf('gl_Position.xy +=')).toBeLessThan(
      src.indexOf('if (filterAlpha <= 0.0) gl_Position = vec4(0.0);'),
    );
  });

  it('composes multiplicatively with the time filter, never replacing it', () => {
    const src = buildIconVertexSource(LEGACY_SHADER, {
      mode: 'wake',
      filter: true,
      glide: false,
    });
    expect(src).toContain('vAlpha = sttWakeAlpha(');
    expect(src).toContain('vAlpha *= filterAlpha;');
    expect(src.indexOf('vAlpha = sttWakeAlpha')).toBeLessThan(
      src.indexOf('vAlpha *= filterAlpha;'),
    );
  });
});

describe('glide variant compilation', () => {
  it('drops the time attribute, the kernel and the filter (CPU owns visibility)', () => {
    for (const src of [
      ...bothVariants(
        buildIconVertexSource,
        cfg({ glide: true, filter: true }),
      ),
      ...bothVariants(
        buildIconIdVertexSource,
        cfg({ glide: true, filter: true }),
      ),
    ]) {
      expect(src).toContain('vAlpha = 1.0;');
      expect(src).not.toContain('attribute vec2 aTime;');
      expect(src).not.toContain('sttTimeWindowAlpha');
      expect(src).not.toContain('uWindowStart');
      // deck parity: the glide path filters by activity, so no column filter.
      expect(src).not.toContain('aFilterValue');
      expect(src).not.toContain('uFilterRange');
      // Everything else — sprite, rotation, tint — is the same shader.
      expect(src).toContain('attribute float aAngle;');
      expect(src).toContain('vUv = (rect.xy + spritePx) / uAtlasSize;');
    }
  });

  it('keeps the projection of its host variant', () => {
    const [legacy, v5] = bothVariants(
      buildIconVertexSource,
      cfg({ glide: true }),
    );
    expect(legacy).toContain('vec4 anchor = uMatrix * vec4(');
    expect(v5).toContain('vec4 anchor = projectTile(mercator.xy);');
  });
});

describe('mode/config resolution + program keys', () => {
  it('defaults to window and infers from the knobs when unset (deck precedence)', () => {
    expect(resolveIconTimeFilterMode(undefined, 0, 0)).toBe('window');
    expect(resolveIconTimeFilterMode(undefined, 1000, 0)).toBe('wake');
    expect(resolveIconTimeFilterMode(undefined, 0, 1000)).toBe('trail');
    expect(resolveIconTimeFilterMode(undefined, 1000, 1000)).toBe('wake');
  });

  it('an explicit mode wins, but a degenerate length degrades to window', () => {
    expect(resolveIconTimeFilterMode('window', 1000, 1000)).toBe('window');
    expect(resolveIconTimeFilterMode('cumulative', 0, 0)).toBe('cumulative');
    expect(resolveIconTimeFilterMode('wake', 0, 0)).toBe('window');
    expect(resolveIconTimeFilterMode('trail', 0, 0)).toBe('window');
  });

  it('separates every compiled configuration', () => {
    const keys = new Set([
      iconProgramKey('main', cfg()),
      iconProgramKey('main', cfg({ mode: 'wake' })),
      iconProgramKey('main', cfg({ mode: 'cumulative' })),
      iconProgramKey('main', cfg({ mode: 'trail' })),
      iconProgramKey('main', cfg({ filter: true })),
      iconProgramKey('main', cfg({ glide: true })),
      iconProgramKey('pick', cfg()),
    ]);
    expect(keys.size).toBe(7);
    expect(iconProgramKey('main', cfg())).toBe('icon:main:window');
    expect(iconProgramKey('pick', cfg({ mode: 'wake', filter: true }))).toBe(
      'icon:pick:wake:filter',
    );
    // Glide compiles no mode and no filter, so one key serves them all.
    expect(iconProgramKey('main', cfg({ glide: true, filter: true }))).toBe(
      'icon:main:glide',
    );
  });
});

// ── CPU references ──────────────────────────────────────────────────────────

describe('writeIconFrame', () => {
  it('lays out [x, y, w, h, anchorX, anchorY, mask, 0] with deck anchor defaults', () => {
    const out = new Float32Array(8);
    writeIconFrame(out, 0, { x: 4, y: 8, width: 32, height: 16 });
    // Anchor defaults to the sprite CENTRE, matching deck's IconLayer.
    expect(Array.from(out)).toEqual([4, 8, 32, 16, 16, 8, 0, 0]);
  });

  it('honours explicit anchors and the mask flag', () => {
    const out = new Float32Array(8);
    writeIconFrame(out, 0, {
      x: 0,
      y: 0,
      width: 20,
      height: 40,
      anchorX: 10,
      anchorY: 40,
      mask: true,
    });
    expect(Array.from(out)).toEqual([0, 0, 20, 40, 10, 40, 1, 0]);
  });

  it('writes zeros for a missing entry (the shader collapses the quad)', () => {
    const out = new Float32Array(16).fill(7);
    writeIconFrame(out, 8, undefined);
    expect(Array.from(out.subarray(8))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    // Only the addressed slot is touched.
    expect(out[0]).toBe(7);
  });
});

describe('bearingFromMotionDeg', () => {
  it('reads deck getAngle degrees: 0 = north, +90 = west (CCW)', () => {
    expect(bearingFromMotionDeg(0, 0, 0, 1)).toBeCloseTo(0, 9); // north
    expect(bearingFromMotionDeg(0, 0, 1, 0)).toBeCloseTo(-90, 9); // east
    // Due south sits on the atan2 seam: -0 east gives -180°, the same heading.
    expect(Math.abs(bearingFromMotionDeg(0, 0, 0, -1)!)).toBeCloseTo(180, 9);
    expect(bearingFromMotionDeg(0, 0, -1, 0)).toBeCloseTo(90, 9); // west
  });

  it('cosine-corrects longitude at the source latitude', () => {
    // At 60°N a 1° longitude step covers half the ground a 1° latitude step
    // does, so an equal-degree NE step points further north than 45°.
    const b = bearingFromMotionDeg(0, 60, 1, 61)!;
    expect(b).toBeGreaterThan(-45);
    expect(b).toBeLessThan(0);
    expect(b).toBeCloseTo(
      -Math.atan2(Math.cos(Math.PI / 3), 1) * (180 / Math.PI),
      9,
    );
  });

  it('returns null when the marker is not moving (held sample)', () => {
    expect(bearingFromMotionDeg(10, 20, 10, 20)).toBeNull();
  });
});

// ── prop defaults ───────────────────────────────────────────────────────────

describe('prop defaults', () => {
  const opts = (extra: Record<string, unknown> = {}) =>
    new STTIconLayer({ ...baseOpts, id: 'i', ...extra }) as any;

  it('matches the deck IconLayer defaults', () => {
    const o = opts().iconOpts;
    expect(o.icon).toBe('marker');
    expect(o.size).toBe(12);
    expect(o.sizeUnits).toBe('pixels');
    expect(o.sizeScale).toBe(1);
    expect(o.sizeMinPixels).toBe(0);
    expect(o.sizeMaxPixels).toBe(Number.MAX_SAFE_INTEGER);
    expect(o.sizeBasis).toBe('height');
    expect(o.angle).toBe(0);
    expect(o.color).toEqual([255, 255, 255, 255]);
    expect(o.alphaCutoff).toBe(0.05);
    expect(o.wakeLength).toBe(0);
    expect(o.wakeTailScale).toBe(0.15);
    expect(o.trailLength).toBe(0);
    expect(o.fadeTrail).toBe(1);
    expect(o.interpolate).toBe(false);
    expect(o.maxInterpolationGap).toBe(Infinity);
    expect(o.reducedMotion).toBe(false);
  });

  it('an EXPLICIT undefined does not shadow a default', () => {
    const o = opts({
      size: undefined,
      angle: undefined,
      alphaCutoff: undefined,
      sizeBasis: undefined,
      interpolate: undefined,
      reducedMotion: undefined,
      maxInterpolationGap: undefined,
    }).iconOpts;
    expect(o.size).toBe(12);
    expect(o.angle).toBe(0);
    expect(o.alphaCutoff).toBe(0.05);
    expect(o.sizeBasis).toBe('height');
    expect(o.interpolate).toBe(false);
    expect(o.reducedMotion).toBe(false);
    expect(o.maxInterpolationGap).toBe(Infinity);
  });

  it('compiles window mode with no filter and no glide by default', () => {
    const layer = opts();
    expect(layer.shaderConfig).toEqual({
      mode: 'window',
      filter: false,
      glide: false,
    });
  });

  it('glide needs interpolate AND an id column AND no wake AND no reduced motion', () => {
    expect(opts({ interpolate: true }).glideActive()).toBe(false);
    expect(opts({ idProperty: 'mmsi' }).glideActive()).toBe(false);
    expect(opts({ interpolate: true, idProperty: 'mmsi' }).glideActive()).toBe(
      true,
    );
    expect(
      opts({
        interpolate: true,
        idProperty: 'mmsi',
        wakeLength: 1000,
      }).glideActive(),
    ).toBe(false);
    expect(
      opts({
        interpolate: true,
        idProperty: 'mmsi',
        reducedMotion: true,
      }).glideActive(),
    ).toBe(false);
  });
});

// ── atlas lifecycle ─────────────────────────────────────────────────────────

describe('atlas loading', () => {
  it('skips the draw (never throws) until BOTH atlas and mapping resolve', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tile = makeIconTile();
      const layer = new STTIconLayer({
        ...baseOpts,
        id: 'icons',
        iconAtlas: ATLAS,
        // no iconMapping
      }) as any;
      const gl = makeMockGl();
      stubCaps(layer, gl);
      const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
      expect(() =>
        layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame())),
      ).not.toThrow();
      expect(layer.instSupport.drawArraysInstanced).not.toHaveBeenCalled();
      expect(gl.createTexture).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      // Warn-once: a second frame stays quiet.
      layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('a missing iconAtlas warns once and draws nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { layer, gl, tile, cache } = makeLayerWithCache({
        iconAtlas: null,
      });
      layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
      expect(layer.instSupport.drawArraysInstanced).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('a URL atlas in a runtime without Image warns once instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { layer, gl, tile, cache } = makeLayerWithCache({
        iconAtlas: 'https://example.test/atlas.png',
      });
      expect(() =>
        layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame())),
      ).not.toThrow();
      expect(layer.instSupport.drawArraysInstanced).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('uploads a decoded source once and reports its pixel size to the shader', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.createTexture).toHaveBeenCalledTimes(1);
    expect(gl.texImage2D).toHaveBeenCalledTimes(1);
    const u = uniformsByName(gl);
    expect(u.get('uAtlasSize')!.at(-1)).toEqual([64, 64]);
    expect(lastScalar(u, 'uAtlas')).toBe(0); // texture unit 0

    // Second frame reuses the texture.
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.createTexture).toHaveBeenCalledTimes(1);
  });

  it("uploads with straight alpha and restores the host's unpack state", () => {
    // What a real maplibre host leaves behind: its own Texture.update sets
    // UNPACK_PREMULTIPLY_ALPHA for every RGBA texture it uploads.
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const unpack = withUnpackState(gl, { premultiply: true, flipY: true });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));

    // Straight alpha at the moment of upload: premultiplying would
    // double-multiply against the layer's SRC_ALPHA blend and halo every
    // translucent sprite edge.
    expect(unpack.atUpload).toEqual({ premultiply: false, flipY: false });
    // …and the host's values are back, because maplibre caches them and would
    // NOT re-apply them before its next glyph/sprite upload.
    expect(unpack.state.get(UNPACK_PREMULTIPLY_ALPHA_WEBGL)).toBe(true);
    expect(unpack.state.get(UNPACK_FLIP_Y_WEBGL)).toBe(true);
  });

  it('touches no unpack state when the host already had it off', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    withUnpackState(gl);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.pixelStorei).not.toHaveBeenCalled();
  });

  it('a source the runtime refuses warns once and never retries', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { layer, gl, tile, cache } = makeLayerWithCache();
      gl.texImage2D = vi.fn(() => {
        throw new TypeError('not a TexImageSource');
      });
      expect(() =>
        layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame())),
      ).not.toThrow();
      expect(layer.instSupport.drawArraysInstanced).not.toHaveBeenCalled();
      expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);

      // 'failed' is terminal: no texture churn and no second warning per frame.
      layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
      expect(gl.createTexture).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('setIconAtlas drops the texture and re-resolves the new source', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.createTexture).toHaveBeenCalledTimes(1);
    layer.gl = gl;
    layer.setIconAtlas({ width: 128, height: 128 });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
    expect(gl.createTexture).toHaveBeenCalledTimes(2);
    expect(uniformsByName(gl).get('uAtlasSize')!.at(-1)).toEqual([128, 128]);
  });
});

// ── tile upload ─────────────────────────────────────────────────────────────

describe('tile cache', () => {
  it('binds one instance per feature and no optional buffers by default', () => {
    const { cache } = makeLayerWithCache();
    expect(cache.vertexCount).toBe(2);
    expect(cache.colorBuffer).toBeUndefined();
    expect(cache.sizeBuffer).toBeUndefined();
    expect(cache.angleBuffer).toBeUndefined();
    expect(cache.iconBuffer).toBeUndefined();
    expect(cache.filterBuffer).toBeUndefined();
  });

  it('bakes the per-feature sprite frames named by iconProperty', () => {
    const { gl, cache } = makeLayerWithCache({ iconProperty: 'vessel_class' });
    expect(cache.iconBuffer).toBeDefined();
    const frames = gl.bufferData.mock.calls
      .map((c: unknown[]) => c[1])
      .find((d: unknown) => d instanceof Float32Array && d.length === 16)!;
    // Feature 0 = 'cargo' (unmapped ⇒ the constant 'marker' sprite), feature 1
    // = 'tanker' (mapped, masked, 32×16 with the centred anchor default).
    expect(Array.from(frames.subarray(0, 8))).toEqual([
      0, 0, 32, 32, 16, 16, 0, 0,
    ]);
    expect(Array.from(frames.subarray(8))).toEqual([
      32, 0, 32, 16, 16, 8, 1, 0,
    ]);
  });

  it('bakes colour / size / angle columns when they are named and present', () => {
    const { cache } = makeLayerWithCache({
      colorProperty: 'vessel_class',
      colorMapping: { cargo: [1, 2, 3, 4] as [number, number, number, number] },
      sizeProperty: 'length_m',
      angleProperty: 'cog',
    });
    expect(cache.colorBuffer).toBeDefined();
    expect(cache.sizeBuffer).toBeDefined();
    expect(cache.angleBuffer).toBeDefined();
  });

  it('a missing icon column falls back to the constant sprite (warn once)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { layer, gl, cache } = makeLayerWithCache({ iconProperty: 'nope' });
      expect(cache.iconBuffer).toBeUndefined();
      const t2 = makeIconTile();
      layer.buildTileGpuCache(gl, t2, t2.layers[0]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('binds the DataFilter column and enables the filter for that tile', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      filterProperty: 'magnitude',
      filterRange: [1, 5] as const,
    });
    expect(cache.filterBuffer).toBeDefined();
    expect(cache.hasFilterColumn).toBe(true);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uFilterEnabled')).toBe(1);
    expect(
      Array.from(u.get('uFilterRange')!.at(-1)![0] as Float32Array),
    ).toEqual([1, 5]);
  });

  it('a tile MISSING the filter column renders unfiltered, never blank', () => {
    const tile = makeIconTile();
    delete (tile.layers[0].features.numericProps as Record<string, unknown>)
      .magnitude;
    const { layer, gl, cache } = makeLayerWithCache(
      { filterProperty: 'magnitude', filterRange: [1, 5] as const },
      tile,
    );
    expect(cache.hasFilterColumn).toBe(false);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(lastScalar(uniformsByName(gl), 'uFilterEnabled')).toBe(0);
  });

  it('a CATEGORICAL filter column warns once and renders unfiltered', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { layer, gl, cache } = makeLayerWithCache({
        filterProperty: 'vessel_class',
        filterRange: [0, 1] as const,
      });
      expect(cache.hasFilterColumn).toBe(false);
      const t2 = makeIconTile();
      layer.buildTileGpuCache(gl, t2, t2.layers[0]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

// ── draw ────────────────────────────────────────────────────────────────────

describe('drawTile', () => {
  it('draws a 4-vertex quad per feature through the instanced path', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(layer.instSupport.drawArraysInstanced).toHaveBeenCalledWith(
      0x0005,
      0,
      4,
      2,
    );
    expect(gl.drawCalls.at(-1)).toMatchObject({ vertices: 4, instances: 2 });
  });

  it('v5 frame: compiles the prelude source and sets u_projection_*', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const frame = normalizeRenderArgs(v5Args('globe', 1));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(frame));
    expect(
      vertexSources(gl).some(
        (s) =>
          s.includes(PRELUDE_MARKER) && s.includes('projectTile(mercator.xy)'),
      ),
    ).toBe(true);
    const looked = gl.getUniformLocation.mock.calls.map((c: unknown[]) => c[1]);
    expect(looked).toEqual(
      expect.arrayContaining([
        'u_projection_matrix',
        'u_projection_clipping_plane',
      ]),
    );
    const matrices = gl.uniformMatrix4fv.mock.calls.map((c: unknown[]) => c[2]);
    expect(matrices).toContain(frame.projectionData!.mainMatrix);
    expect(matrices).not.toContain(frame.matrix);
  });

  it('a variant flip relinks once and rebuilds the tile VAO', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    const legacy = legacyFrame();
    const globe = normalizeRenderArgs(v5Args('globe', 1));

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacy));
    expect(gl.createProgram.mock.calls.length).toBe(1);
    expect(gl.createVertexArray.mock.calls.length).toBe(1);

    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(globe));
    expect(gl.createProgram.mock.calls.length).toBe(2);
    expect(gl.deleteVertexArray).toHaveBeenCalledTimes(1);
    expect(gl.createVertexArray.mock.calls.length).toBe(2);

    // Same variant again: program AND VAO reused.
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(globe));
    expect(gl.createProgram.mock.calls.length).toBe(2);
    expect(gl.createVertexArray.mock.calls.length).toBe(2);
  });

  it('uploads the constant sprite + style uniforms', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      size: 24,
      angle: 45,
      sizeMinPixels: 4,
      sizeMaxPixels: 64,
      sizeBasis: 'width',
      alphaCutoff: 0.2,
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uSize')).toBe(24);
    expect(lastScalar(u, 'uAngle')).toBe(45);
    expect(lastScalar(u, 'uSizeMinPixels')).toBe(4);
    expect(lastScalar(u, 'uSizeMaxPixels')).toBe(64);
    expect(lastScalar(u, 'uSizeBasisWidth')).toBe(1);
    expect(lastScalar(u, 'uAlphaCutoff')).toBe(0.2);
    expect(lastScalar(u, 'uUseFeatureIcon')).toBe(0);
    expect(lastScalar(u, 'uUseFeatureAngle')).toBe(0);
    expect(lastScalar(u, 'uUseFeatureColor')).toBe(0);
    expect(Array.from(u.get('uIconRect')!.at(-1)![0] as Float32Array)).toEqual([
      0, 0, 32, 32,
    ]);
    expect(Array.from(u.get('uIconMeta')!.at(-1)![0] as Float32Array)).toEqual([
      16, 16, 0, 0,
    ]);
    // 0–255 tint is auto-detected and normalized (toRgba01).
    expect(Array.from(u.get('uColor')!.at(-1)![0] as number[])).toEqual([
      1, 1, 1, 1,
    ]);
  });

  it('re-uses ONE tint payload across frames and setColor updates it in place', () => {
    // `toRgba01` allocates, and this runs per tile per frame — the resolved
    // value is hoisted, so the uniform payload must be one stable buffer.
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const uploads = uniformsByName(gl).get('uColor')!;
    expect(uploads.length).toBe(2);
    expect(uploads[0][0]).toBe(uploads[1][0]);

    layer.setColor([255, 0, 0, 255]);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const after = uniformsByName(gl).get('uColor')!.at(-1)![0] as Float32Array;
    expect(Array.from(after)).toEqual([1, 0, 0, 1]);
  });

  it('setIcon rebuilds the tile caches only when iconProperty bakes frames', () => {
    // The per-feature frames bake the CONSTANT icon as the fallback for values
    // the mapping doesn't name, so moving it must invalidate them.
    const keyed = makeLayerWithCache({ iconProperty: 'vessel_class' });
    keyed.layer.gl = keyed.gl;
    keyed.layer.tileGpuCache.set('k', keyed.cache);
    keyed.layer.setIcon('tanker');
    expect(keyed.layer.tileGpuCache.size).toBe(0);

    // Constant-icon layers only move a uniform — no GPU churn.
    const constant = makeLayerWithCache();
    constant.layer.gl = constant.gl;
    constant.layer.tileGpuCache.set('k', constant.cache);
    constant.layer.setIcon('tanker');
    expect(constant.layer.tileGpuCache.size).toBe(1);
    expect(Array.from(constant.layer.constIconRect as Float32Array)).toEqual([
      32, 0, 32, 16,
    ]);
  });

  it('flags the per-feature columns that this tile actually baked', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      angleProperty: 'cog',
      sizeProperty: 'length_m',
      iconProperty: 'vessel_class',
      colorProperty: 'vessel_class',
    });
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uUseFeatureAngle')).toBe(1);
    expect(lastScalar(u, 'uUseFeatureSize')).toBe(1);
    expect(lastScalar(u, 'uUseFeatureIcon')).toBe(1);
    expect(lastScalar(u, 'uUseFeatureColor')).toBe(1);
  });

  it('window mode sets ONLY the window uniforms; wake sets the wake knobs', () => {
    const plain = makeLayerWithCache();
    const ctx = drawCtx(legacyFrame());
    plain.layer.drawTile(
      plain.gl,
      plain.tile,
      plain.tile.layers[0],
      plain.cache,
      ctx,
    );
    const u = uniformsByName(plain.gl);
    expect(lastScalar(u, 'uWindowStart')).toBe(ctx.windowStart);
    expect(lastScalar(u, 'uWindowEnd')).toBe(ctx.windowEnd);
    expect(u.has('uCurrentTime')).toBe(false);

    const waked = makeLayerWithCache({
      timeFilterMode: 'wake',
      wakeLength: 30_000,
    });
    waked.layer.drawTile(
      waked.gl,
      waked.tile,
      waked.tile.layers[0],
      waked.cache,
      ctx,
    );
    const w = uniformsByName(waked.gl);
    // Tile-RELATIVE current time — the package-wide convention.
    expect(lastScalar(w, 'uCurrentTime')).toBe(
      ctx.currentTime - waked.cache.timeOffset,
    );
    expect(lastScalar(w, 'uWakeLength')).toBe(30_000);
    expect(lastScalar(w, 'uWakeTailScale')).toBe(0.15);
    expect(w.has('uWindowStart')).toBe(false);
  });

  it("sizeUnits: 'meters' folds the per-tile metres→device-px factor into uSizeScale", () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      sizeUnits: 'meters',
      size: 250,
      sizeScale: 2,
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
    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uSizeScale')).toBeCloseTo(expected, 6);
    // The size itself still goes up raw — the unit lives in the scale.
    expect(lastScalar(u, 'uSize')).toBe(250);
  });

  it('setWakeLength flips the compiled mode: one relink, VAO re-recorded', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.createProgram.mock.calls.length).toBe(1);
    layer.setWakeLength(10_000);
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    expect(gl.createProgram.mock.calls.length).toBe(2);
    expect(gl.deleteVertexArray).toHaveBeenCalledTimes(1);
    expect(vertexSources(gl).some((s) => s.includes('sttWakeSizeScale'))).toBe(
      true,
    );
  });
});

// ── picking ─────────────────────────────────────────────────────────────────

describe('drawPickTile', () => {
  it('draws the same instanced quads with per-feature id colours', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache();
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    expect(layer.instSupport.drawArraysInstanced).toHaveBeenCalledWith(
      0x0005,
      0,
      4,
      2,
    );
    const ids = gl.bufferData.mock.calls
      .map((c: unknown[]) => c[1])
      .find((d: unknown) => d instanceof Uint8Array && d.length === 6)!;
    expect(decodePickId([ids[0], ids[1], ids[2]])).toBe(1);
    expect(decodePickId([ids[3], ids[4], ids[5]])).toBe(2);
    // The one-shot id buffer is freed with the pass.
    expect(gl.deleteBuffer).toHaveBeenCalled();
  });

  it('leaves no attribute enabled and no divisor dirty', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      angleProperty: 'cog',
      filterProperty: 'magnitude',
      filterRange: [0, 10] as const,
    });
    layer.drawPickTile(
      gl,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    expect(gl.disableVertexAttribArray).toHaveBeenCalled();
    const divisors = layer.instSupport.vertexAttribDivisor.mock.calls;
    // Every location the pass touched is handed back at divisor 0.
    expect(divisors.at(-1)![1]).toBe(0);
    const enabled = new Set(
      gl.enableVertexAttribArray.mock.calls.map((c: unknown[]) => c[0]),
    );
    const disabled = new Set(
      gl.disableVertexAttribArray.mock.calls.map((c: unknown[]) => c[0]),
    );
    for (const loc of enabled) expect(disabled.has(loc)).toBe(true);
  });

  it('invisible ⇒ unpickable: the id program compiles the same gates', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      timeFilterMode: 'wake',
      wakeLength: 30_000,
      filterProperty: 'magnitude',
      filterRange: [1, 5] as const,
    });
    const ctx = drawCtx(legacyFrame());
    layer.drawPickTile(gl, tile, tile.layers[0], cache, ctx, 1);
    const idSrc = vertexSources(gl).find((s) =>
      s.includes('attribute vec3 aIdColor;'),
    )!;
    expect(idSrc).toContain(
      'vAlpha = sttWakeAlpha(aTime, uCurrentTime, uWakeLength);',
    );
    expect(idSrc).toContain(
      'sizePx *= sttWakeSizeScale(vAlpha, uWakeTailScale);',
    );
    expect(idSrc).toContain(`float filterAlpha = ${DATA_FILTER_CALL_GLSL};`);

    const idFs = vertexSources(gl).find((s) =>
      s.includes('vIdColor;\n  void main'),
    )!;
    expect(idFs).toContain('if (vAlpha <= 0.0) discard;');
    // A transparent sprite texel is not a hit box either.
    expect(idFs).toContain('if (a < uAlphaCutoff) discard;');

    const u = uniformsByName(gl);
    expect(lastScalar(u, 'uCurrentTime')).toBe(
      ctx.currentTime - cache.timeOffset,
    );
    expect(lastScalar(u, 'uFilterEnabled')).toBe(1);
  });

  it('sizes the hit quad exactly like the visual pass', () => {
    const { layer, gl, tile, cache } = makeLayerWithCache({
      sizeUnits: 'meters',
      size: 250,
    });
    layer.map = { getZoom: () => 4, triggerRepaint: vi.fn() };
    layer.drawTile(gl, tile, tile.layers[0], cache, drawCtx(legacyFrame()));
    const visual = lastScalar(uniformsByName(gl), 'uSizeScale');

    const gl2 = makeMockGl();
    layer.drawPickTile(
      gl2,
      tile,
      tile.layers[0],
      cache,
      drawCtx(legacyFrame()),
      1,
    );
    expect(lastScalar(uniformsByName(gl2), 'uSizeScale')).toBe(visual);
  });
});

// ── motion glide ────────────────────────────────────────────────────────────

const glideOpts = {
  interpolate: true,
  idProperty: 'mmsi',
  angleProperty: 'cog',
};

/** Two snapshots of vessel 'A' 10 s apart, at ±10° longitude on the equator. */
const glideTiles = () => [
  makeTrackTile({
    t: TIME_OFFSET,
    lon: -10,
    lat: 0,
    startTime: 0,
    id: 'A',
    heading: 0,
  }),
  makeTrackTile({
    t: TIME_OFFSET + 10_000,
    lon: 10,
    lat: 0,
    startTime: 10_000,
    id: 'A',
    heading: 90,
  }),
];

describe('motion glide', () => {
  it('emits ONE instance per active entity, interpolated at the playhead', () => {
    const { layer, gl } = makeRenderableLayer(
      { ...glideOpts, currentTime: TIME_OFFSET + 5000 },
      glideTiles(),
    );
    layer.render(gl, new Float32Array(16));

    expect(layer.glideCount).toBe(1);
    expect(layer.instSupport.drawArraysInstanced).toHaveBeenCalledWith(
      0x0005,
      0,
      4,
      1,
    );
    // Halfway between the two snapshots: lon 0, lat 0 in mercator units.
    const [mx, my] = lngLatToMercator(0, 0);
    expect(layer.glidePositions[0]).toBeCloseTo(mx, 6);
    expect(layer.glidePositions[1]).toBeCloseTo(my, 6);
    // Heading interpolates along the shortest DEGREE arc (0° → 90°).
    expect(layer.glideAngles[0]).toBeCloseTo(45, 6);
    // The sampled poses are what actually reached the GPU — as a PREFIX write
    // into a pre-sized store (`bufferData(target, byteLength)` once per
    // capacity growth, `bufferSubData` per frame), never the capacity-sized
    // array: capacity is grow-only, so uploading it whole would push the dead
    // tail across the bus on every frame of a zoomed-in view.
    expect(
      gl.bufferSubData.mock.calls.map((c: unknown[]) =>
        Array.from(c[2] as ArrayLike<number>),
      ),
    ).toContainEqual([
      layer.glidePositions[0],
      layer.glidePositions[1],
      layer.glidePositions[2],
    ]);
    // The sizing call carries a byte LENGTH, not the array itself.
    expect(
      gl.bufferData.mock.calls.some(
        (c: unknown[]) => c[1] === layer.glidePositions.byteLength,
      ),
    ).toBe(true);
    // The glide program compiles no time kernel.
    expect(
      vertexSources(gl).some(
        (s) => s.includes('vAlpha = 1.0;') && !s.includes('aTime'),
      ),
    ).toBe(true);
  });

  it('folds the appear/disappear fade into the instance alpha', () => {
    const { layer, gl } = makeRenderableLayer(
      {
        ...glideOpts,
        currentTime: TIME_OFFSET + 5000,
        fadeInDuration: 4000,
        fadeOutDuration: 4000,
        color: [255, 128, 0, 200] as [number, number, number, number],
      },
      glideTiles(),
    );
    layer.render(gl, new Float32Array(16));
    expect(Array.from(layer.glideColors.subarray(0, 3))).toEqual([255, 128, 0]);
    // Mid-track ⇒ no fade, so the constant alpha rides through untouched.
    expect(layer.glideColors[3]).toBe(200);
  });

  it('maxInterpolationGap HOLDS the last pose instead of fabricating motion', () => {
    const held = makeRenderableLayer(
      {
        ...glideOpts,
        currentTime: TIME_OFFSET + 5000,
        maxInterpolationGap: 1000, // the 10 s bracket is a data hole
      },
      glideTiles(),
    );
    held.layer.render(held.gl, new Float32Array(16));
    const [mxHold] = lngLatToMercator(-10, 0);
    expect(held.layer.glidePositions[0]).toBeCloseTo(mxHold, 6);

    // Without the guard the same playhead interpolates to the midpoint.
    const glided = makeRenderableLayer(
      { ...glideOpts, currentTime: TIME_OFFSET + 5000 },
      glideTiles(),
    );
    glided.layer.render(glided.gl, new Float32Array(16));
    const [mxMid] = lngLatToMercator(0, 0);
    expect(glided.layer.glidePositions[0]).toBeCloseTo(mxMid, 6);
  });

  it('falls back to a bearing from motion when no heading column exists', () => {
    const tiles = [
      makeTrackTile({
        t: TIME_OFFSET,
        lon: -10,
        lat: 0,
        startTime: 0,
        id: 'A',
      }),
      makeTrackTile({
        t: TIME_OFFSET + 10_000,
        lon: 10,
        lat: 0,
        startTime: 10_000,
        id: 'A',
      }),
    ];
    const { layer, gl } = makeRenderableLayer(
      {
        interpolate: true,
        idProperty: 'mmsi',
        currentTime: TIME_OFFSET + 5000,
      },
      tiles,
    );
    layer.render(gl, new Float32Array(16));
    // Travelling due EAST ⇒ -90° in deck's CCW getAngle degrees.
    expect(layer.glideAngles[0]).toBeCloseTo(-90, 4);
  });

  it('rebuilds the pooled index only when the tile SET changes', () => {
    const sync = vi.spyOn(TrackIndexMaintainer.prototype, 'sync');
    try {
      const tiles = glideTiles();
      const { layer, gl } = makeRenderableLayer(
        { ...glideOpts, currentTime: TIME_OFFSET + 5000 },
        tiles,
      );
      layer.render(gl, new Float32Array(16));
      expect(sync).toHaveBeenCalledTimes(1);

      // Same resident set, later playhead: re-sampled, NOT re-pooled.
      layer.setCurrentTime(TIME_OFFSET + 6000);
      layer.render(gl, new Float32Array(16));
      expect(sync).toHaveBeenCalledTimes(1);

      // A tile arrives ⇒ exactly one incremental sync.
      const extra = makeTrackTile({
        t: TIME_OFFSET + 20_000,
        lon: 20,
        lat: 0,
        startTime: 20_000,
        id: 'B',
      });
      layer.loadedTiles.set(tileKey(extra), extra);
      layer.render(gl, new Float32Array(16));
      expect(sync).toHaveBeenCalledTimes(2);
    } finally {
      sync.mockRestore();
    }
  });

  it('warns once when interpolate is on but the id column is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tile = makeTrackTile({
        t: TIME_OFFSET,
        lon: 0,
        lat: 0,
        startTime: 0,
        id: 'A',
      });
      delete (
        tile.layers[0].features.categoricalProps as Record<string, unknown>
      ).mmsi;
      const { layer, gl } = makeRenderableLayer(
        { ...glideOpts, currentTime: TIME_OFFSET },
        [tile],
      );
      layer.render(gl, new Float32Array(16));
      layer.render(gl, new Float32Array(16));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('idProperty');
    } finally {
      warn.mockRestore();
    }
  });

  it('reduced motion degrades to the discrete per-tile path', () => {
    const { layer, gl } = makeRenderableLayer(
      { ...glideOpts, reducedMotion: true, currentTime: TIME_OFFSET + 5000 },
      glideTiles(),
    );
    layer.render(gl, new Float32Array(16));
    // Two tiles, one feature each ⇒ two discrete draws, no merged glide draw.
    expect(layer.glideCount).toBe(0);
    expect(layer.instSupport.drawArraysInstanced).toHaveBeenCalledTimes(2);
    expect(
      vertexSources(gl).some((s) => s.includes('sttTimeWindowAlpha(aTime,')),
    ).toBe(true);
  });

  it('picks a glided entity through a snapshot row of the entry being drawn', () => {
    const tiles = glideTiles();
    const { layer, gl } = makeRenderableLayer(
      { ...glideOpts, currentTime: TIME_OFFSET + 5000 },
      tiles,
    );
    layer.render(gl, new Float32Array(16));

    // Entry for the first tile: vessel 'A' is its row 0, so it paints idBase+0.
    layer.drawPickTile(
      gl,
      tiles[0],
      tiles[0].layers[0],
      {} as never,
      drawCtx(legacyFrame()),
      1,
    );
    expect(Array.from(lastIdColors(gl))).toEqual(Array.from(encodePickId(1)));
    expect(decodePickId(lastIdTriple(gl))).toBe(1);

    // The SECOND tile holds another snapshot of the same entity, so it paints
    // too — with ITS OWN id range. Both decode to a real row of vessel 'A', and
    // the last entry drawn wins the pixel (no blending, no depth).
    layer.drawPickTile(
      gl,
      tiles[1],
      tiles[1].layers[0],
      {} as never,
      drawCtx(legacyFrame()),
      2,
    );
    expect(decodePickId(lastIdTriple(gl))).toBe(2);
  });

  it('stays pickable after the tile it was first seen in is evicted', () => {
    // The failure this guards: a first-seen (tile, layer) owner table leaves a
    // still-gliding marker unpickable the moment that tile leaves the window —
    // which, during playback, is every marker within a few seconds.
    const tiles = glideTiles();
    // At the LAST keyframe, so the survivor stays active as a held singleton
    // once the earlier snapshot's tile is gone.
    const now = TIME_OFFSET + 10_000;
    const { layer, gl } = makeRenderableLayer(
      { ...glideOpts, currentTime: now },
      tiles,
    );
    layer.render(gl, new Float32Array(16));

    layer.loadedTiles.delete(tileKey(tiles[0]));
    layer.render(gl, new Float32Array(16));
    expect(layer.glideCount).toBe(1); // still on screen

    layer.drawPickTile(
      gl,
      tiles[1],
      tiles[1].layers[0],
      {} as never,
      { ...drawCtx(legacyFrame()), currentTime: now },
      7,
    );
    expect(decodePickId(lastIdTriple(gl))).toBe(7);
  });

  it('an entry holding no ACTIVE entity does not paint (never erases ids)', () => {
    const tiles = glideTiles();
    // Vessel 'Z' has a single snapshot 60 s before the playhead — pooled as a
    // track, but far outside the singleton hold, so it is never drawn.
    const idle = makeTrackTile({
      t: TIME_OFFSET - 60_000,
      lon: 40,
      lat: 10,
      startTime: -60_000,
      id: 'Z',
      heading: 0,
    });
    const { layer, gl } = makeRenderableLayer(
      { ...glideOpts, currentTime: TIME_OFFSET + 5000 },
      [...tiles, idle],
    );
    layer.render(gl, new Float32Array(16));
    expect(layer.glideCount).toBe(1); // only 'A'

    const drawsBefore = layer.instSupport.drawArraysInstanced.mock.calls.length;
    layer.drawPickTile(
      gl,
      idle,
      idle.layers[0],
      {} as never,
      drawCtx(legacyFrame()),
      9,
    );
    expect(layer.instSupport.drawArraysInstanced.mock.calls.length).toBe(
      drawsBefore,
    );
  });

  it('warns once that the DataFilter is INERT on the glide path', () => {
    // The glide program compiles no filter kernel and the CPU track pool
    // carries no filter column, so `filterProperty`/`filterRange` do nothing
    // here. deck degrades the same way — but a silent no-op would leave a UI
    // slider that changes nothing, so the drop is disclosed (and recorded in
    // the backend descriptor's dataFilter summary).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { layer, gl } = makeRenderableLayer(
      {
        ...glideOpts,
        currentTime: TIME_OFFSET + 5000,
        filterProperty: 'altitude',
        filterRange: [0, 1000] as [number, number],
      },
      glideTiles(),
    );
    layer.render(gl, new Float32Array(16));
    layer.render(gl, new Float32Array(16));
    const filterWarnings = warn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('DataFilter'),
    );
    expect(filterWarnings).toHaveLength(1);
    warn.mockRestore();
  });

  it('the pick provenance walk builds NO per-tile attribute buffers while gliding', () => {
    // `render()` short-circuits the base per-tile loop on this path, so the
    // only caller of ensureTileGpuCache left is buildPickProvenance — and the
    // glide pick draws from the merged instance buffers, never from a tile
    // cache. Uploading the full per-tile attribute set on the first hover would
    // be tens of MB of buffers nothing binds.
    const { layer, gl } = makeRenderableLayer(
      {
        ...glideOpts,
        currentTime: TIME_OFFSET + 5000,
        colorProperty: 'mmsi',
        colorMapping: { A: [1, 2, 3, 4] as [number, number, number, number] },
      },
      glideTiles(),
    );
    const prov = layer.buildPickProvenance(gl);
    expect(prov.length).toBeGreaterThan(0);
    for (const e of prov) {
      // The placeholder carries the tile's timeOffset (pick() reads it) and
      // nothing else — no colour / size / angle / sprite / filter buffers.
      expect(e.cache.timeOffset).toBe(e.layer.features.timeOffset);
      expect(e.cache.vertexCount).toBe(0);
      expect(e.cache.colorBuffer).toBeUndefined();
      expect(e.cache.iconBuffer).toBeUndefined();
      expect(e.cache.extraBuffers).toBeUndefined();
    }
  });

  it('flipping the glide gate rebuilds the tile caches (the shapes differ)', () => {
    const { layer, gl } = makeRenderableLayer(
      { ...glideOpts, currentTime: TIME_OFFSET + 5000 },
      glideTiles(),
    );
    layer.buildPickProvenance(gl); // populates the cache with placeholders
    expect(layer.tileGpuCache.size).toBeGreaterThan(0);

    layer.gl = gl;
    layer.setInterpolate(false);
    // Leaving glide must drop the placeholders — otherwise the discrete path
    // would draw `vertexCount: 0` caches for every already-resident tile.
    expect(layer.tileGpuCache.size).toBe(0);
    const cache = layer.ensureTileGpuCache(
      gl,
      glideTiles()[0],
      glideTiles()[0].layers[0],
    );
    expect(cache.vertexCount).toBeGreaterThan(0);
  });

  it('re-bakes the instances when a BAKED style prop moves on a paused map', () => {
    // Tint / fallback angle / sprite ride per-instance buffers on this path, so
    // a setter that only triggered a repaint would show the OLD value until the
    // playhead moved — which on a paused map is never.
    const { layer, gl } = makeRenderableLayer(
      {
        ...glideOpts,
        currentTime: TIME_OFFSET + 5000,
        color: [10, 20, 30, 255] as [number, number, number, number],
      },
      glideTiles(),
    );
    layer.render(gl, new Float32Array(16));
    expect(Array.from(layer.glideColors.subarray(0, 4))).toEqual([
      10, 20, 30, 255,
    ]);

    layer.setColor([200, 100, 50, 128]);
    layer.render(gl, new Float32Array(16)); // same currentTime — paused
    expect(Array.from(layer.glideColors.subarray(0, 4))).toEqual([
      200, 100, 50, 128,
    ]);
    // …and the re-baked bytes actually reached the GPU (prefix upload).
    expect(
      gl.bufferSubData.mock.calls.map((c: unknown[]) =>
        Array.from(c[2] as ArrayLike<number>),
      ),
    ).toContainEqual([200, 100, 50, 128]);
  });
});

// ── JS references the compiled shaders mirror ───────────────────────────────

describe('JS references used by the compiled icon shaders', () => {
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

  it('the sprite quad maps corner → uv → anchor offset the way the shader does', () => {
    // JS mirror of the vertex source's sprite math, for the 32×16 'tanker'
    // sprite at size 32 with the default centred anchor.
    const frame = new Float32Array(8);
    writeIconFrame(frame, 0, MAPPING.tanker);
    const [x, y, w, h, ax, ay] = frame;
    const sizePx = 32;
    const scale = sizePx / h; // 'height' basis (the default)
    const corners: [number, number][] = [
      [-1, 0],
      [1, 0],
      [-1, 1],
      [1, 1],
    ];
    const offsets = corners.map(([side, along]) => {
      const u = side * 0.5 + 0.5;
      return [(u * w - ax) * scale, (along * h - ay) * scale];
    });
    // Centred anchor ⇒ the quad straddles it symmetrically, and the rendered
    // HEIGHT is exactly `size` while the width follows the aspect ratio.
    expect(offsets[0]).toEqual([-32, -16]);
    expect(offsets[3]).toEqual([32, 16]);
    expect(offsets[3][1] - offsets[0][1]).toBe(sizePx);
    expect(offsets[3][0] - offsets[0][0]).toBe(sizePx * (w / h));
    // uv of the far corner lands on the sprite's bottom-right in the atlas.
    expect((x + 1 * w) / ATLAS.width).toBeCloseTo(1, 12);
    expect((y + 1 * h) / ATLAS.height).toBeCloseTo(0.25, 12);
  });
});

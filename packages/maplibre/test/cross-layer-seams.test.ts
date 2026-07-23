// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * Cross-layer seam gate (Wave M2 integration, widened to all NINE kinds in
 * Wave M3).
 *
 * Every layer assembles its vertex shader by SPLICING shared snippets — the
 * time-filter kernel (one of four modes), the DataFilter kernel, the position
 * dequantizer, and on v5+ hosts the map's own projection prelude — into its own
 * declarations. Nothing in the unit suites compiles GLSL, so a collision
 * (two `uniform float uFadeIn;`, a mode whose kernel was not spliced, a helper
 * defined twice) would only surface as a black layer in a browser.
 *
 * This suite is the cheap stand-in for a compiler: it enumerates EVERY source
 * the layers can emit — mode × filter × host variant × visual/pick pass (× the
 * per-kind structural knobs: icon glide, arc great-circle, column stroke) — and
 * asserts the invariants a GLSL ES 1.00 compiler would enforce, plus the
 * package conventions that keep the kinds from drifting apart.
 *
 * Coverage is SELF-MAINTAINING: every emitted source is tagged with the layer
 * FILE it came from, and one test asserts that tag set equals the contents of
 * `src/layers`. A tenth layer therefore fails here until it is enumerated,
 * which is what a hard-coded file count used to (badly) approximate.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPointVertexSource,
  buildPointIdVertexSource,
  type PointTimeFilterMode,
} from '../src/layers/point-layer';
import { buildLineVertexSource } from '../src/layers/line-layer';
import {
  buildFillVertexSource,
  buildStrokeVertexSource,
} from '../src/layers/polygon-layer';
import {
  buildTripsVertexSource,
  buildTripsIdVertexSource,
} from '../src/layers/trips-layer';
import { buildHeatmapAccumVertexSource } from '../src/layers/heatmap-layer';
import {
  buildIconVertexSource,
  buildIconIdVertexSource,
  iconProgramKey,
} from '../src/layers/icon-layer';
import {
  buildColumnVertexSource,
  buildColumnIdVertexSource,
  buildColumnStrokeVertexSource,
  buildColumnStrokeIdVertexSource,
  columnProgramKey,
} from '../src/layers/column-layer';
import { buildArcVertexSource, arcProgramKey } from '../src/layers/arc-layer';
import {
  buildTripHeadsVertexSource,
  buildTripHeadsIdVertexSource,
  tripHeadsProgramKey,
} from '../src/layers/trip-heads-layer';
import { pointProgramKey, STTPointLayer } from '../src/layers/point-layer';
import { STTLineLayer } from '../src/layers/line-layer';
import { STTPolygonLayer } from '../src/layers/polygon-layer';
import { STTTripsLayer } from '../src/layers/trips-layer';
import { STTHeatmapLayer } from '../src/layers/heatmap-layer';
import { STTIconLayer } from '../src/layers/icon-layer';
import { STTColumnLayer } from '../src/layers/column-layer';
import { STTArcLayer } from '../src/layers/arc-layer';
import { STTTripHeadsLayer } from '../src/layers/trip-heads-layer';
import {
  TIME_WINDOW_GLSL,
  TIME_TRAIL_GLSL,
  TIME_WAKE_GLSL,
  TIME_CUMULATIVE_GLSL,
} from '../src/shaders/time-window.glsl';
import {
  DATA_FILTER_GLSL,
  DATA_FILTER_ATTRIBUTE_GLSL,
  DATA_FILTER_UNIFORMS_GLSL,
} from '../src/shaders/data-filter.glsl';
import { POSITION_DEQUANT_GLSL } from '../src/shaders/position-quantization.glsl';
import {
  buildElevatedProjection,
  GLOBE_ELEVATION_STEPS,
} from '../src/shaders/globe-elevation.glsl';
import {
  buildBillboardIdFragmentSource,
  discMaskGLSL,
  DISC_EDGE_EXPR,
} from '../src/shaders/billboard.glsl';

const MODES: readonly PointTimeFilterMode[] = [
  'window',
  'wake',
  'cumulative',
  'trail',
];

/** Legacy (≤v4 / mapbox) and a v5+ host's injected prelude. */
const HOSTS = [
  { name: 'legacy', prelude: '', define: '' },
  {
    name: 'v5-globe',
    prelude: 'vec4 projectTile(vec2 p) { return vec4(p, 0.0, 1.0); }',
    define: '#define GLOBE',
  },
] as const;

/**
 * One emitted vertex source, tagged with enough context to name a failure and
 * with the `src/layers` FILE it came from (so coverage is checkable).
 */
interface Emitted {
  id: string;
  layerFile: string;
  source: string;
}

/** Every vertex source the nine layers can emit, across every knob. */
function allSources(): Emitted[] {
  const out: Emitted[] = [];
  const push = (layerFile: string, id: string, source: string) =>
    out.push({ layerFile, id, source });

  for (const host of HOSTS) {
    const shader = { prelude: host.prelude, define: host.define };
    for (const filter of [false, true]) {
      for (const mode of MODES) {
        const tag = `${host.name}/${mode}${filter ? '/filter' : ''}`;
        push(
          'point-layer.ts',
          `point:${tag}`,
          buildPointVertexSource(shader, { mode, filter }),
        );
        push(
          'point-layer.ts',
          `point-id:${tag}`,
          buildPointIdVertexSource(shader, { mode, filter }),
        );
        push(
          'line-layer.ts',
          `line:${tag}`,
          buildLineVertexSource(shader, { mode, filter }),
        );
        push(
          'line-layer.ts',
          `line-id:${tag}`,
          buildLineVertexSource(shader, { mode, filter, pick: true }),
        );
        push(
          'polygon-layer.ts',
          `polygon-fill:${tag}`,
          buildFillVertexSource({ ...shader, mode, filter }),
        );
        push(
          'polygon-layer.ts',
          `polygon-fill-id:${tag}`,
          buildFillVertexSource({ ...shader, mode, filter, pick: true }),
        );
        push(
          'polygon-layer.ts',
          `polygon-stroke:${tag}`,
          buildStrokeVertexSource({ ...shader, mode, filter }),
        );
        push(
          'polygon-layer.ts',
          `polygon-stroke-id:${tag}`,
          buildStrokeVertexSource({ ...shader, mode, filter, pick: true }),
        );
        push(
          'heatmap-layer.ts',
          `heatmap:${tag}`,
          buildHeatmapAccumVertexSource(shader, {
            timeFilterMode: mode,
            dataFilter: filter,
          }),
        );
        // Wave M3. Icon's discrete path takes the same (mode, filter) grid;
        // its glide path is a separate structural knob, emitted below.
        push(
          'icon-layer.ts',
          `icon:${tag}`,
          buildIconVertexSource(shader, { mode, filter, glide: false }),
        );
        push(
          'icon-layer.ts',
          `icon-id:${tag}`,
          buildIconIdVertexSource(shader, { mode, filter, glide: false }),
        );
        // Column emits four passes: prism body and top-ring outline, each
        // visual and id.
        push(
          'column-layer.ts',
          `column-fill:${tag}`,
          buildColumnVertexSource(shader, { mode, filter }),
        );
        push(
          'column-layer.ts',
          `column-fill-id:${tag}`,
          buildColumnIdVertexSource(shader, { mode, filter }),
        );
        push(
          'column-layer.ts',
          `column-stroke:${tag}`,
          buildColumnStrokeVertexSource(shader, { mode, filter }),
        );
        push(
          'column-layer.ts',
          `column-stroke-id:${tag}`,
          buildColumnStrokeIdVertexSource(shader, { mode, filter }),
        );
        // Arc adds `greatCircle` (a whole spherical-interpolation kernel) as a
        // third structural axis, and shares one builder across both passes.
        for (const greatCircle of [false, true]) {
          const gcTag = greatCircle ? `${tag}/gc` : tag;
          push(
            'arc-layer.ts',
            `arc:${gcTag}`,
            buildArcVertexSource(shader, {
              mode,
              filter,
              greatCircle,
              pick: false,
            }),
          );
          push(
            'arc-layer.ts',
            `arc-id:${gcTag}`,
            buildArcVertexSource(shader, {
              mode,
              filter,
              greatCircle,
              pick: true,
            }),
          );
        }
      }
      // Trip heads carry ONE moving position, so `cumulative`/`trail` (which
      // describe a history) degrade to `window` in the layer and never reach a
      // builder — window + wake is the whole compiled surface.
      for (const mode of ['window', 'wake'] as const) {
        const tag = `${host.name}/${mode}${filter ? '/filter' : ''}`;
        push(
          'trip-heads-layer.ts',
          `heads:${tag}`,
          buildTripHeadsVertexSource(shader, { mode, filter }),
        );
        push(
          'trip-heads-layer.ts',
          `heads-id:${tag}`,
          buildTripHeadsIdVertexSource(shader, { mode, filter }),
        );
      }
    }
    // Trips compiles only the two per-vertex modes, and `filter` is NOT one of
    // its builder's arguments (it rides the layer's own option), so its sources
    // sit outside the filter loop — emitting them inside it would just add a
    // duplicate of every cell.
    for (const mode of ['trail', 'wake'] as const) {
      push(
        'trips-layer.ts',
        `trips:${host.name}/${mode}`,
        buildTripsVertexSource(shader, mode),
      );
      push(
        'trips-layer.ts',
        `trips-id:${host.name}/${mode}`,
        buildTripsIdVertexSource(shader, mode),
      );
    }
    // The icon glide program compiles NO time kernel and NO filter (visibility
    // is decided on the CPU there), so it is its own axis rather than a cell of
    // the grid — and it is exactly the configuration a mode-shaped enumeration
    // would miss.
    push(
      'icon-layer.ts',
      `icon-glide:${host.name}`,
      buildIconVertexSource(shader, {
        mode: 'window',
        filter: false,
        glide: true,
      }),
    );
    push(
      'icon-layer.ts',
      `icon-glide-id:${host.name}`,
      buildIconIdVertexSource(shader, {
        mode: 'window',
        filter: false,
        glide: true,
      }),
    );
  }
  return out;
}

const SOURCES = allSources();

/** Absolute path of `src/layers`, resolved from this test file. */
async function layersDir(): Promise<string> {
  const url = await import('node:url');
  return url.fileURLToPath(new URL('../src/layers', import.meta.url));
}

/** Every `*.ts` file in `src/layers` — one file per layer class, by convention. */
async function layerFiles(): Promise<string[]> {
  const fs = await import('node:fs/promises');
  return (await fs.readdir(await layersDir()))
    .filter((f) => f.endsWith('.ts'))
    .sort();
}

/** Declared storage-qualified names (`uniform vec2 uFoo;` → `uFoo`), in order. */
function declaredNames(source: string): string[] {
  const names: string[] = [];
  const re =
    /^\s*(?:uniform|attribute|varying)\s+\w+\s+(\w+)\s*(?:\[[^\]]*\])?\s*;/gm;
  for (const m of source.matchAll(re)) names.push(m[1]!);
  return names;
}

/** Function DEFINITIONS (`float sttFoo(` at a statement start). */
function definedFunctions(source: string): string[] {
  const names: string[] = [];
  const re = /^\s*(?:float|vec2|vec3|vec4|void)\s+(\w+)\s*\(/gm;
  for (const m of source.matchAll(re)) names.push(m[1]!);
  return names;
}

/** `stt*` functions the source CALLS (the package's own helper namespace). */
function calledSttFunctions(source: string): Set<string> {
  const called = new Set<string>();
  for (const m of source.matchAll(/\b(stt[A-Za-z0-9_]*)\s*\(/g)) {
    called.add(m[1]!);
  }
  return called;
}

const duplicates = (names: readonly string[]): string[] => {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) dupes.add(n);
    seen.add(n);
  }
  return [...dupes];
};

describe('spliced GLSL has no collisions (the compiler we do not run in CI)', () => {
  it('covers EVERY layer file in src/layers (the enumeration cannot fall behind)', async () => {
    // This replaces the old `expect(files.length).toBe(5)` tripwire, which
    // failed the moment Wave M3 landed four layers and told nobody WHICH file
    // was unenumerated. Now a new layer file fails with its own name until its
    // sources are added above.
    const covered = new Set(SOURCES.map((s) => s.layerFile));
    expect([...covered].sort()).toEqual(await layerFiles());
  });

  it('emits a distinct source id per configuration (no silently-shadowed cell)', () => {
    // Two configurations sharing an id would mean one of them is never checked
    // by the collision assertions below.
    expect(new Set(SOURCES.map((s) => s.id)).size).toBe(SOURCES.length);
    // Sanity floor: nine layers × two hosts × two filter states × the mode grid.
    expect(SOURCES.length).toBeGreaterThan(200);
  });

  it('declares each uniform/attribute/varying exactly once, in every source', () => {
    const offenders = SOURCES.flatMap(({ id, source }) => {
      const dupes = duplicates(declaredNames(source));
      return dupes.length > 0 ? [`${id}: ${dupes.join(', ')}`] : [];
    });
    expect(offenders).toEqual([]);
  });

  it('defines each function exactly once, in every source', () => {
    const offenders = SOURCES.flatMap(({ id, source }) => {
      const dupes = duplicates(definedFunctions(source));
      return dupes.length > 0 ? [`${id}: ${dupes.join(', ')}`] : [];
    });
    expect(offenders).toEqual([]);
  });

  it('defines every stt* helper it calls (no unspliced kernel)', () => {
    const offenders = SOURCES.flatMap(({ id, source }) => {
      const defined = new Set(definedFunctions(source));
      const missing = [...calledSttFunctions(source)].filter(
        (fn) => !defined.has(fn),
      );
      return missing.length > 0 ? [`${id}: ${missing.join(', ')}`] : [];
    });
    expect(offenders).toEqual([]);
  });

  it("injects the host prelude + define in maplibre's documented order", () => {
    const offenders = SOURCES.flatMap(({ id, source }) => {
      const preludeAt = source.indexOf('vec4 projectTile(');
      const defineAt = source.indexOf('#define GLOBE');
      const mainAt = source.indexOf('void main()');
      if (!id.includes('v5-globe')) {
        // Legacy hosts get no injection and must keep the positional MVP.
        const ok = defineAt < 0 && source.includes('uniform mat4 uMatrix;');
        return ok ? [] : [`${id}: legacy variant is not the uMatrix shader`];
      }
      // Prelude, then define, then our declarations and main().
      const ok = preludeAt >= 0 && defineAt > preludeAt && mainAt > defineAt;
      return ok ? [] : [`${id}: prelude/define/main out of order`];
    });
    expect(offenders).toEqual([]);
  });
});

describe('shared kernels stay call-site-agnostic', () => {
  const KERNELS = {
    TIME_WINDOW_GLSL,
    TIME_TRAIL_GLSL,
    TIME_WAKE_GLSL,
    TIME_CUMULATIVE_GLSL,
    DATA_FILTER_GLSL,
    POSITION_DEQUANT_GLSL,
  };

  it.each(Object.entries(KERNELS))(
    '%s declares no uniform/attribute/varying of its own',
    (_name, glsl) => {
      // A kernel that declared storage would collide the moment a layer
      // spliced it next to its own declarations — which is exactly the
      // scenario the per-source duplicate check above cannot pre-empt.
      expect(glsl).not.toMatch(/\b(uniform|attribute|varying|precision)\b/);
    },
  );

  it('the DataFilter declaration snippets are the ONLY place its names appear', () => {
    // The attribute/uniform blocks are separate exports precisely so a layer
    // splices them once; the kernel itself must take everything by argument.
    expect(DATA_FILTER_ATTRIBUTE_GLSL).toContain('aFilterValue');
    expect(DATA_FILTER_UNIFORMS_GLSL).toContain('uFilterRange');
    expect(DATA_FILTER_GLSL).not.toContain('uFilterRange');
    expect(DATA_FILTER_GLSL).not.toContain('aFilterValue');
  });
});

describe('cross-layer runtime control surface', () => {
  const BASE = {
    url: 'mem://seams.stt',
    currentTime: 1_700_000_000_000,
    timeWindow: 5_000,
  };

  const LAYER_CLASSES = {
    point: STTPointLayer,
    line: STTLineLayer,
    polygon: STTPolygonLayer,
    trips: STTTripsLayer,
    heatmap: STTHeatmapLayer,
    icon: STTIconLayer,
    column: STTColumnLayer,
    arc: STTArcLayer,
    tripHeads: STTTripHeadsLayer,
  } as const;

  it('one class per layer file — nothing ships unclassed', async () => {
    const fs = await import('node:fs/promises');
    const dir = await layersDir();
    const names = new Set(
      Object.values(LAYER_CLASSES).map((c) => (c as { name: string }).name),
    );
    for (const file of await layerFiles()) {
      const src = await fs.readFile(`${dir}/${file}`, 'utf8');
      const cls = src.match(
        /^export class (STT\w+) extends STTBaseLayer/m,
      )?.[1];
      expect(cls, `${file} exports no STTBaseLayer subclass`).toBeTruthy();
      expect(names.has(cls!), `${cls} is missing from LAYER_CLASSES`).toBe(
        true,
      );
    }
  });

  it.each(Object.entries(LAYER_CLASSES))(
    'the %s layer exposes the same three uniform-only DataFilter setters',
    (kind, Cls) => {
      // Every options interface extends `STTDataFilterOptions`, so a caller
      // that can CONFIGURE a filter must also be able to DRIVE it — the slider
      // path. A layer missing one of these forces the caller to reconstruct.
      const layer = new (Cls as new (o: unknown) => unknown)({
        ...BASE,
        id: `seam-${kind}`,
      }) as Record<string, unknown>;
      for (const setter of [
        'setFilterRange',
        'setFilterSoftRange',
        'setFilterEnabled',
      ]) {
        expect(typeof layer[setter], `${kind}.${setter}`).toBe('function');
      }
    },
  );

  it.each(
    Object.keys(LAYER_CLASSES).filter((k) => k !== 'heatmap') as Array<
      keyof typeof LAYER_CLASSES
    >,
  )('the %s layer is pickable and the heatmap is not', (kind) => {
    const layer = new (LAYER_CLASSES[kind] as new (o: unknown) => unknown)({
      ...BASE,
      id: `seam-pick-${kind}`,
    }) as { supportsPicking(): boolean };
    expect(layer.supportsPicking()).toBe(true);
    const heat = new STTHeatmapLayer({
      ...BASE,
      id: 'seam-pick-heatmap',
    }) as unknown as { supportsPicking(): boolean };
    expect(heat.supportsPicking()).toBe(false);
  });
});

describe('shared kernels are USED, not re-transcribed (Wave M3 seam pass)', () => {
  it('every 3D layer routes elevation through shaders/globe-elevation.glsl.ts', () => {
    // Polygon (extruded fills), column (prisms) and arc all need the same
    // twelve lines: metres into the globe sphere term, mercator-z into every
    // flat matrix, and a re-derived horizon-clip z because projectTileFor3D
    // preserves z on globe. Each carried its own transcription until this
    // module; nothing in CI compiles GLSL, so a fix applied to one copy and
    // not the others would only have shown up as a back-hemisphere bleed on
    // one kind, in a browser.
    // The passes that actually LEAVE the ground. `polygon-stroke` is excluded
    // on purpose: the ring outline is drawn flat on the ground plane, so it
    // projects through `projectTile`, not the elevated kernel.
    const ELEVATED = [
      'polygon-fill:',
      'polygon-fill-id:',
      'column-fill:',
      'column-fill-id:',
      'column-stroke:',
      'column-stroke-id:',
      'arc:',
      'arc-id:',
    ];
    const globeSources = SOURCES.filter(
      (s) =>
        s.id.includes('v5-globe') && ELEVATED.some((p) => s.id.startsWith(p)),
    );
    expect(globeSources.length).toBeGreaterThan(0);
    for (const { id, source } of globeSources) {
      for (const step of GLOBE_ELEVATION_STEPS) {
        expect(source.includes(step), `${id} is missing "${step}"`).toBe(true);
      }
    }
  });

  it('the emitted block IS the shared builder’s output, verbatim', () => {
    // Substring identity, so a layer that copied the kernel back inline (or
    // drifted a constant — `0.2` is maplibre's z_globeness_threshold) fails.
    const arcBlock = buildElevatedProjection({
      usesPrelude: true,
      xy: 'posM',
      elevMeters: 'elevM',
      elevMercatorZ: 'elevM * uMercatorZPerMeter',
      names: {
        out: 'result',
        sphere: 'elevated',
        globe: 'globePos',
        flat: 'flatPos',
      },
    });
    const arc = buildArcVertexSource(
      { prelude: HOSTS[1].prelude, define: HOSTS[1].define },
      { mode: 'window', filter: false, greatCircle: false, pick: false },
    );
    expect(arc).toContain(arcBlock);

    const columnBlock = buildElevatedProjection({
      usesPrelude: true,
      xy: 'posM',
      elevMeters: 'elevM',
      elevMercatorZ: 'elevM * uMercatorZPerMeter',
      names: {
        out: 'here',
        sphere: 'hereSphere',
        globe: 'hereGlobe',
        flat: 'hereFlat',
      },
    });
    const column = buildColumnVertexSource(
      { prelude: HOSTS[1].prelude, define: HOSTS[1].define },
      { mode: 'window', filter: false },
    );
    expect(column).toContain(columnBlock);
  });

  it('the polygon layer keeps its per-variant uniform folding (documented divergence)', () => {
    // The one caller whose `elevMercatorZ` differs between the two prelude
    // arms: it folds the metres→mercator-z factor into `uAltitudeScale`, whose
    // VALUE differs per host variant, so `elev` is ALREADY mercator-z on the
    // mercator arm while the globe arm's flat fallback must convert.
    const src = buildFillVertexSource({
      prelude: HOSTS[1].prelude,
      define: HOSTS[1].define,
      mode: 'window',
    });
    expect(src).toContain('vec4(aMercator.xy, elev * uMercatorZPerMeter, 1.0)');
    expect(src).toContain('projectTileFor3D(aMercator.xy, elev)');
    // …and the sphere term takes the metres side of the same value.
    expect(src).toContain('(1.0 + elev / GLOBE_RADIUS)');
  });

  it('the billboard disc is ONE shape, shared by the visual and pick stages', async () => {
    // The pick stage must hit-test the circle the user SEES. Two layers draw
    // `gl.POINTS` billboards, each with a visual AND an id fragment stage, so
    // the disc was written out four times — and only a rasterizing test would
    // notice the day one drifted (a ring that is pickable but not drawn, or an
    // edge drawn but not pickable). Both now splice
    // `shaders/billboard.glsl.ts`, so no layer spells the disc itself.
    const fs = await import('node:fs/promises');
    const dir = await layersDir();
    for (const file of ['point-layer.ts', 'trip-heads-layer.ts']) {
      const src = await fs.readFile(`${dir}/${file}`, 'utf8');
      expect(src, `${file} does not use the shared billboard kernel`).toContain(
        "from '../shaders/billboard.glsl.js'",
      );
      expect(src).toContain('discMaskGLSL()');
      expect(src).toContain('buildBillboardIdFragmentSource(');
      // The heatmap's splat legitimately has its OWN gl_PointCoord kernel (a
      // Gaussian falloff, not a disc); these two must have none of their own.
      expect(
        src.includes('gl_PointCoord'),
        `${file} still spells the disc inline`,
      ).toBe(false);
    }
    // The kernel's own invariant: the id stage carries the SAME mask as the
    // visual one but must NOT antialias — a partially covered edge texel has
    // to decode to the exact id byte triple.
    const idFs = buildBillboardIdFragmentSource('points');
    expect(idFs).toContain(discMaskGLSL());
    expect(idFs).not.toContain('smoothstep');
    expect(idFs).toContain('if (vAlpha <= 0.0) discard;');
    expect(DISC_EDGE_EXPR).toContain('smoothstep');
  });

  it('the draw path allocates no colour tuple per tile per frame', async () => {
    // Campaign constraint: no per-frame allocations in drawTile/drawPickTile.
    // `gl.uniform4fv(h.uColor, toRgba01(...))` builds a fresh 4-tuple on every
    // tile of every frame; `STTBaseLayer.rgba01Uniform` refills a per-slot
    // cache instead. Eight layers were on the allocating spelling.
    const fs = await import('node:fs/promises');
    const dir = await layersDir();
    for (const file of await layerFiles()) {
      const src = await fs.readFile(`${dir}/${file}`, 'utf8');
      for (const line of src.split('\n')) {
        if (!line.includes('gl.uniform4fv')) continue;
        expect(
          line.includes('toRgba01('),
          `${file}: ${line.trim()} allocates per draw — use rgba01Uniform`,
        ).toBe(false);
      }
    }
  });

  it('no layer re-derives metric sizing — the base helper is the only path', async () => {
    // `metersToPixelsAtLatitude` needs three things right every time
    // (FRACTIONAL zoom, the device-pixel ratio, the tile-centre latitude), and
    // seven layers were each spelling them out. `STTBaseLayer.metricPixelScale`
    // is now the single implementation; a layer importing the raw projection
    // helper again is how that would silently un-unify.
    const fs = await import('node:fs/promises');
    const dir = await layersDir();
    for (const file of await layerFiles()) {
      const src = await fs.readFile(`${dir}/${file}`, 'utf8');
      const imports = src.match(/^import[\s\S]*?from '[^']+';$/gm) ?? [];
      const reimported = imports.some(
        (block) =>
          block.includes('lib/projection.js') &&
          block.includes('metersToPixelsAtLatitude'),
      );
      expect(
        reimported,
        `${file} re-imports metersToPixelsAtLatitude instead of using metricPixelScale`,
      ).toBe(false);
    }
  });
});

describe('program-cache keys are namespaced per layer', () => {
  /**
   * `STTBaseLayer.getOrCreateProgram` appends only `::${variantName}` to the
   * key it is handed, and the cache is per LAYER INSTANCE — so a collision is
   * not reachable today. It becomes reachable the moment the D6b
   * `STTLayerGroup` hosts several kinds behind one custom layer (Wave M5), and
   * an unprefixed key is unreadable in a GL trace regardless. Before Wave M3
   * point and icon both emitted `main:window`, and polygon and column both
   * emitted `fill:window`.
   */
  const KEYS: ReadonlyArray<readonly [string, string]> = [
    ['point', pointProgramKey('main', { mode: 'window', filter: false })],
    ['point', pointProgramKey('pick', { mode: 'trail', filter: true })],
    [
      'icon',
      iconProgramKey('main', { mode: 'window', filter: false, glide: false }),
    ],
    [
      'icon',
      iconProgramKey('main', { mode: 'window', filter: false, glide: true }),
    ],
    ['column', columnProgramKey('fill', { mode: 'window', filter: false })],
    [
      'column',
      columnProgramKey('pick-stroke', { mode: 'trail', filter: true }),
    ],
    [
      'arc',
      arcProgramKey({
        mode: 'window',
        filter: false,
        greatCircle: false,
        pick: false,
      }),
    ],
    [
      'tripHeads',
      tripHeadsProgramKey('main', { mode: 'window', filter: false }),
    ],
    ['tripHeads', tripHeadsProgramKey('pick', { mode: 'wake', filter: true })],
  ];

  it.each(KEYS)(
    'the %s key (%s) is namespaced with its own layer prefix',
    (prefix, key) => {
      expect(key.slice(0, prefix.length + 1)).toBe(`${prefix}:`);
    },
  );

  it('no two layers can produce the same key', () => {
    // Polygon and line build their keys as instance state rather than a pure
    // function, so they join through the constructed layer.
    const polygon = new STTPolygonLayer({
      url: 'mem://seams.stt',
      id: 'k-g',
      currentTime: 1,
      timeWindow: 1,
    }) as unknown as { programKeys: Record<string, string> };
    const line = new STTLineLayer({
      url: 'mem://seams.stt',
      id: 'k-l',
      currentTime: 1,
      timeWindow: 1,
    }) as unknown as { mainProgramKey: string; pickProgramKey: string };
    const all = [
      ...KEYS.map(([, k]) => k),
      ...Object.values(polygon.programKeys),
      line.mainProgramKey,
      line.pickProgramKey,
      'trips:trail',
      'heatmap-accum:window',
    ];
    expect(new Set(all).size).toBe(all.length);
    // Every key's first segment names exactly one layer.
    const owners = new Map<string, Set<string>>();
    for (const key of all) {
      const head = key.split(':')[0]!;
      if (!owners.has(head)) owners.set(head, new Set());
      owners.get(head)!.add(key);
    }
    expect([...owners.keys()].sort()).toEqual([
      'arc',
      'column',
      'heatmap-accum',
      'icon',
      'line',
      'point',
      'polygon',
      'tripHeads',
      'trips',
    ]);
  });
});

describe('cross-layer prop conventions', () => {
  /** The body of `export interface STT<Kind>LayerOptions … {` … `^}`. */
  function layerOptionsBody(src: string): string | null {
    const open = src.match(/^export interface STT\w+LayerOptions[\s\S]*?\{$/m);
    if (!open?.index) return null;
    const from = open.index + open[0].length;
    const end = src.indexOf('\n}', from);
    return end < 0 ? src.slice(from) : src.slice(from, end);
  }

  /**
   * `*Mode` props that are NOT the time-filter selector and are allowed to keep
   * their own spelling. `renderingMode` is maplibre's own
   * `CustomLayerInterface` vocabulary (`'2d' | '3d'`), surfaced by the one
   * genuinely 3D layer so an embedder can opt back out of the shared
   * depth slab — renaming it would fork the HOST's API, not ours.
   */
  const NON_TIME_MODE_PROPS = new Set(['renderingMode']);

  it('every layer spells the time-mode prop `timeFilterMode` (or omits it entirely)', async () => {
    // Trips is the deliberate omission: it infers trail vs wake from
    // `wakeLength`, having no window/cumulative spelling to select between.
    // Any OTHER spelling (`timeMode`, `mode`, …) would fork the API. Only the
    // OPTIONS interface is scanned — the internal shader-config interfaces
    // legitimately call their field `mode`.
    const fs = await import('node:fs/promises');
    const dir = await layersDir();
    const files = await layerFiles();
    // Coverage floor: every layer file must expose an options interface for
    // this scan to mean anything (the file list itself is checked above).
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const file of files) {
      const body = layerOptionsBody(
        await fs.readFile(`${dir}/${file}`, 'utf8'),
      );
      expect(body, `${file} has no STT*LayerOptions interface`).toBeTruthy();
      const modeProps = [...body!.matchAll(/^\s{2}(\w*[Mm]ode)\?:/gm)]
        .map((m) => m[1]!)
        .filter((p) => !NON_TIME_MODE_PROPS.has(p));
      for (const prop of modeProps) {
        expect(prop, `${file} exposes a non-standard mode prop`).toBe(
          'timeFilterMode',
        );
      }
    }
  });

  it('every layer spells the trail-fade prop `fadeTrail: boolean | number`', async () => {
    // Widened package-wide in Wave M2: the shared kernel takes a CONTINUOUS
    // 0..1 weight (core `trailAlpha`'s `trailFade`), so a layer still typing
    // it `boolean` would silently drop the intermediate values.
    const fs = await import('node:fs/promises');
    const dir = await layersDir();
    for (const file of await layerFiles()) {
      const body = layerOptionsBody(
        await fs.readFile(`${dir}/${file}`, 'utf8'),
      );
      const decl = body?.match(/^\s{2}fadeTrail\?:(.*)$/m)?.[1]?.trim();
      if (!decl) continue; // a layer without a trail mode need not declare it
      expect(decl, `${file} fadeTrail`).toBe('boolean | number;');
    }
  });

  it('the interpolation-gap guard is spelled `maxInterpolationGap` everywhere', async () => {
    // Both layers that drive the core track kernel expose its `maxGapMs`
    // guard. Icon named it after deck (`maxInterpolationGap`) and tripHeads
    // after the kernel (`maxGapMs`) — the same knob under two names on two
    // layers of one package. deck's spelling wins; `maxGapMs` must not
    // reappear as an OPTION (it stays the core `TrackSampleConfig` field name).
    const fs = await import('node:fs/promises');
    const dir = await layersDir();
    let declared = 0;
    for (const file of await layerFiles()) {
      const body = layerOptionsBody(
        await fs.readFile(`${dir}/${file}`, 'utf8'),
      );
      if (!body) continue;
      expect(body, `${file} still exposes maxGapMs as an option`).not.toMatch(
        /^\s{2}maxGapMs\?:/m,
      );
      if (/^\s{2}maxInterpolationGap\?:/m.test(body)) declared += 1;
    }
    expect(declared).toBe(2); // icon + tripHeads
  });

  it('the reduced-motion escape hatch is spelled `reducedMotion` everywhere', async () => {
    // Project rule: every animated surface honours prefers-reduced-motion.
    // Three layers animate beyond the shared time filter — icon (glide), line
    // (path reveal) and column (space-time lift) — and all three must take the
    // preference under one name so a host can forward `useReducedMotion()`
    // without a per-layer lookup table.
    const fs = await import('node:fs/promises');
    const dir = await layersDir();
    const withIt: string[] = [];
    for (const file of await layerFiles()) {
      const body = layerOptionsBody(
        await fs.readFile(`${dir}/${file}`, 'utf8'),
      );
      if (body && /^\s{2}reducedMotion\?: boolean;/m.test(body)) {
        withIt.push(file);
      }
    }
    expect(withIt.sort()).toEqual([
      'column-layer.ts',
      'icon-layer.ts',
      'line-layer.ts',
    ]);
  });
});

describe('degenerate trail (`trailLength <= 0`) resolves ONE way package-wide', () => {
  const opts = {
    url: 'mem://seams.stt',
    currentTime: 1_700_000_000_000,
    timeWindow: 60_000,
  };

  /**
   * The rule, in full: the shared `sttTrailAlpha` kernel returns 0 for a
   * non-positive `trailLength` (core `trailAlpha`'s value), so a layer must
   * never ship that state. Every layer that owns a window kernel degrades to
   * `window` — deck's own fallthrough, `else if (trailLength > 0.0) … else
   * { window }`. The one layer without a window kernel (trips) resolves to
   * `off` and draws nothing, which is the same 0 expressed as a skip.
   *
   * Before this was unified, the same prop meant three different things:
   * trips blanked, point windowed, and line/polygon/heatmap flooded the
   * viewport with the entire past at full alpha.
   */
  it('point / line / polygon / heatmap all degrade an explicit trail:0 to window', () => {
    const point = new STTPointLayer({
      ...opts,
      id: 'p',
      timeFilterMode: 'trail',
      trailLength: 0,
    }) as unknown as { shaderConfig: { mode: string } };
    expect(point.shaderConfig.mode).toBe('window');

    const line = new STTLineLayer({
      ...opts,
      id: 'l',
      timeFilterMode: 'trail',
      trailLength: 0,
    }) as unknown as { lineOpts: { timeFilterMode: string } };
    expect(line.lineOpts.timeFilterMode).toBe('window');

    const polygon = new STTPolygonLayer({
      ...opts,
      id: 'g',
      timeFilterMode: 'trail',
    }) as unknown as { timeMode: string };
    // Polygon's trailLength DEFAULTS to 0, so selecting the mode alone is the
    // degenerate case — the shape an app hits without passing a length at all.
    expect(polygon.timeMode).toBe('window');

    const heatmap = new STTHeatmapLayer({
      ...opts,
      id: 'h',
      timeFilterMode: 'trail',
      trailLength: 0,
    }) as unknown as { heatOpts: { timeFilterMode: string } };
    expect(heatmap.heatOpts.timeFilterMode).toBe('window');
  });

  it('trips (no window kernel) resolves to `off` — the same 0, expressed as a skip', () => {
    const trips = new STTTripsLayer({
      ...opts,
      id: 't',
      trailLength: 0,
    }) as unknown as { resolveTimeMode(): string };
    expect(trips.resolveTimeMode()).toBe('off');
  });

  it('a POSITIVE trailLength still compiles the trail kernel on all five', () => {
    const point = new STTPointLayer({
      ...opts,
      id: 'p',
      timeFilterMode: 'trail',
      trailLength: 1000,
    }) as unknown as { shaderConfig: { mode: string } };
    expect(point.shaderConfig.mode).toBe('trail');
    const polygon = new STTPolygonLayer({
      ...opts,
      id: 'g',
      timeFilterMode: 'trail',
      trailLength: 1000,
    }) as unknown as { timeMode: string };
    expect(polygon.timeMode).toBe('trail');
    const trips = new STTTripsLayer({
      ...opts,
      id: 't',
      trailLength: 1000,
    }) as unknown as { resolveTimeMode(): string };
    expect(trips.resolveTimeMode()).toBe('trail');
  });

  it('line / heatmap tail lengths track setTimeWindow instead of snapshotting it', () => {
    // They default off `timeWindow` precisely so the tail never outruns the
    // data the loader keeps resident; a stale snapshot broke that in both
    // directions with no setter to correct it.
    const line = new STTLineLayer({
      ...opts,
      id: 'l',
      timeFilterMode: 'wake',
    }) as unknown as {
      lineOpts: { wakeLength: number; trailLength: number };
      setTimeWindow(ms: number): void;
    };
    expect(line.lineOpts.wakeLength).toBe(30_000);
    line.setTimeWindow(10_000);
    expect(line.lineOpts.wakeLength).toBe(5_000);
    expect(line.lineOpts.trailLength).toBe(5_000);

    const heat = new STTHeatmapLayer({ ...opts, id: 'h' }) as unknown as {
      heatOpts: { trailLength: number };
      setTimeWindow(ms: number): void;
    };
    expect(heat.heatOpts.trailLength).toBe(60_000);
    heat.setTimeWindow(10_000);
    expect(heat.heatOpts.trailLength).toBe(10_000);
  });

  it('an EXPLICIT tail length is the caller’s and survives setTimeWindow', () => {
    const line = new STTLineLayer({
      ...opts,
      id: 'l',
      timeFilterMode: 'wake',
      wakeLength: 1234,
    }) as unknown as {
      lineOpts: { wakeLength: number };
      setTimeWindow(ms: number): void;
    };
    line.setTimeWindow(10_000);
    expect(line.lineOpts.wakeLength).toBe(1234);
  });
});

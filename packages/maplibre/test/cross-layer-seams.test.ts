// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * Cross-layer seam gate (Wave M2 integration).
 *
 * Every layer assembles its vertex shader by SPLICING shared snippets — the
 * time-filter kernel (one of four modes), the DataFilter kernel, the position
 * dequantizer, and on v5+ hosts the map's own projection prelude — into its own
 * declarations. Nothing in the unit suites compiles GLSL, so a collision
 * (two `uniform float uFadeIn;`, a mode whose kernel was not spliced, a helper
 * defined twice) would only surface as a black layer in a browser.
 *
 * This suite is the cheap stand-in for a compiler: it enumerates EVERY source
 * the five layers can emit — mode × filter × host variant × visual/pick pass —
 * and asserts the invariants a GLSL ES 1.00 compiler would enforce, plus the
 * package conventions that keep the five kinds from drifting apart.
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
import { STTPointLayer } from '../src/layers/point-layer';
import { STTLineLayer } from '../src/layers/line-layer';
import { STTPolygonLayer } from '../src/layers/polygon-layer';
import { STTTripsLayer } from '../src/layers/trips-layer';
import { STTHeatmapLayer } from '../src/layers/heatmap-layer';
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

/** One emitted vertex source, tagged with enough context to name a failure. */
interface Emitted {
  id: string;
  source: string;
}

/** Every vertex source the five layers can emit, across every knob. */
function allSources(): Emitted[] {
  const out: Emitted[] = [];
  for (const host of HOSTS) {
    const shader = { prelude: host.prelude, define: host.define };
    for (const filter of [false, true]) {
      for (const mode of MODES) {
        const tag = `${host.name}/${mode}${filter ? '/filter' : ''}`;
        out.push({
          id: `point:${tag}`,
          source: buildPointVertexSource(shader, { mode, filter }),
        });
        out.push({
          id: `point-id:${tag}`,
          source: buildPointIdVertexSource(shader, { mode, filter }),
        });
        out.push({
          id: `line:${tag}`,
          source: buildLineVertexSource(shader, { mode, filter }),
        });
        out.push({
          id: `line-id:${tag}`,
          source: buildLineVertexSource(shader, { mode, filter, pick: true }),
        });
        out.push({
          id: `polygon-fill:${tag}`,
          source: buildFillVertexSource({ ...shader, mode, filter }),
        });
        out.push({
          id: `polygon-fill-id:${tag}`,
          source: buildFillVertexSource({
            ...shader,
            mode,
            filter,
            pick: true,
          }),
        });
        out.push({
          id: `polygon-stroke:${tag}`,
          source: buildStrokeVertexSource({ ...shader, mode, filter }),
        });
        out.push({
          id: `polygon-stroke-id:${tag}`,
          source: buildStrokeVertexSource({
            ...shader,
            mode,
            filter,
            pick: true,
          }),
        });
        out.push({
          id: `heatmap:${tag}`,
          source: buildHeatmapAccumVertexSource(shader, {
            timeFilterMode: mode,
            dataFilter: filter,
          }),
        });
      }
      // Trips compiles only the two per-vertex modes; `filter` is its only
      // other structural knob and rides the layer's own option, not this
      // builder, so the source is emitted per (mode, pass).
      for (const mode of ['trail', 'wake'] as const) {
        out.push({
          id: `trips:${host.name}/${mode}`,
          source: buildTripsVertexSource(shader, mode),
        });
        out.push({
          id: `trips-id:${host.name}/${mode}`,
          source: buildTripsIdVertexSource(shader, mode),
        });
      }
    }
  }
  return out;
}

const SOURCES = allSources();

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
  it('emits a source for every layer × mode × filter × host × pass', () => {
    // 2 hosts × 2 filter × 4 modes × 9 (point/line/polygon×2, heatmap, ×pick)
    // + 2 hosts × 2 filter × 2 trips modes × 2 passes.
    expect(SOURCES.length).toBe(2 * 2 * (4 * 9 + 2 * 2));
    expect(new Set(SOURCES.map((s) => s.id)).size).toBeLessThanOrEqual(
      SOURCES.length,
    );
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
  } as const;

  it.each(Object.entries(LAYER_CLASSES))(
    'the %s layer exposes the same three uniform-only DataFilter setters',
    (kind, Cls) => {
      // All five options interfaces extend `STTDataFilterOptions`, so a caller
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

  it.each(['point', 'line', 'polygon', 'trips'] as const)(
    'the %s layer is pickable and the heatmap is not',
    (kind) => {
      const layer = new (LAYER_CLASSES[kind] as new (o: unknown) => unknown)({
        ...BASE,
        id: `seam-pick-${kind}`,
      }) as { supportsPicking(): boolean };
      expect(layer.supportsPicking()).toBe(true);
    },
  );
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

  it('every layer spells the mode prop `timeFilterMode` (or omits it entirely)', async () => {
    // Trips is the deliberate omission: it infers trail vs wake from
    // `wakeLength`, having no window/cumulative spelling to select between.
    // Any OTHER spelling (`timeMode`, `mode`, …) would fork the API. Only the
    // OPTIONS interface is scanned — the internal shader-config interfaces
    // legitimately call their field `mode`.
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const dir = url.fileURLToPath(new URL('../src/layers', import.meta.url));
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBe(5);
    for (const file of files) {
      const body = layerOptionsBody(
        await fs.readFile(`${dir}/${file}`, 'utf8'),
      );
      expect(body, `${file} has no STT*LayerOptions interface`).toBeTruthy();
      const modeProps = [...body!.matchAll(/^\s{2}(\w*[Mm]ode)\?:/gm)].map(
        (m) => m[1]!,
      );
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
    const url = await import('node:url');
    const dir = url.fileURLToPath(new URL('../src/layers', import.meta.url));
    for (const file of (await fs.readdir(dir)).filter((f) =>
      f.endsWith('.ts'),
    )) {
      const body = layerOptionsBody(
        await fs.readFile(`${dir}/${file}`, 'utf8'),
      );
      const decl = body?.match(/^\s{2}fadeTrail\?:(.*)$/m)?.[1]?.trim();
      if (!decl) continue; // a layer without a trail mode need not declare it
      expect(decl, `${file} fadeTrail`).toBe('boolean | number;');
    }
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

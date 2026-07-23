// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * Structural conformance gate for the maplibre backend descriptor
 * (docs/roadmap/renderer-abstraction-2026-06.md Phase 5, + D9 of the
 * maplibre-parity campaign).
 *
 * This does NOT re-test rendering behaviour (the other suites do). It proves the
 * DECLARATION cannot drift or lie:
 *   (a) every kind claimed `supported` maps to a class that is a real export;
 *   (b) `assertDescriptorConsistent(maplibreBackend, evidence)` == [] where all
 *       three evidence axes — kinds, capabilities and modes — are built from
 *       the REAL exports, REAL constructed layers and REAL compiled shader
 *       sources, never copied from the descriptor's own claims, so an
 *       over-claim has nowhere to hide;
 *   (c) the record is exhaustive over `LAYER_KINDS` and every unsupported kind
 *       carries a reason;
 *   (d) every `maplibreLayerFeatures` claim is proven against the real exported
 *       layer classes, and every non-claim records how it degrades.
 *
 * Why (d) probes CONSTRUCTION rather than deck's `defaultProps` walk: a maplibre
 * layer is a plain `CustomLayerInterface` class with no `defaultProps` — its
 * prop surface is a constructor options interface, erased at runtime. A key
 * listed in some static table would prove only that someone wrote the key down.
 * Constructing the real class with the prop set to a unique probe and finding
 * that probe in the instance's resolved options proves the constructor actually
 * READS it — and the differential (the probe must be ABSENT when the prop is not
 * passed) rules out a coincidental match.
 */

import { describe, it, expect } from 'vitest';
import {
  LAYER_KINDS,
  CAPABILITIES,
  assertDescriptorConsistent,
  type LayerKind,
  type Capability,
  type ConformanceEvidence,
} from '@poopdeck.gl/core/capabilities';
import type { TimeFilterMode } from '@poopdeck.gl/core/time-filter';
import {
  maplibreBackend,
  maplibreLayerFeatures,
  LAYER_FEATURES,
  type LayerFeature,
} from '../src/backend-descriptor';
import * as maplibre from '../src/index';
import { buildPointVertexSource } from '../src/layers/point-layer';
import { buildLineVertexSource } from '../src/layers/line-layer';
import { buildFillVertexSource } from '../src/layers/polygon-layer';
import { buildTripsVertexSource } from '../src/layers/trips-layer';
import { buildHeatmapAccumVertexSource } from '../src/layers/heatmap-layer';

/** The exported layer class that renders each maplibre-supported kind. */
const CLASS_FOR_KIND: Partial<Record<LayerKind, string>> = {
  point: 'STTPointLayer',
  line: 'STTLineLayer',
  polygon: 'STTPolygonLayer',
  trips: 'STTTripsLayer',
  heatmap: 'STTHeatmapLayer',
};

const exports = maplibre as unknown as Record<string, unknown>;
const isExportedClass = (name: string | undefined): boolean =>
  name !== undefined && typeof exports[name] === 'function';

/** Minimum options every layer constructor needs. */
const BASE_OPTS = {
  url: 'mem://conformance.stt',
  currentTime: 1_700_000_000_000,
  timeWindow: 5_000,
};

/** Construct the exported class for `kind` with `extra` merged into the options. */
function construct(kind: LayerKind, extra: Record<string, unknown>): unknown {
  const name = CLASS_FOR_KIND[kind];
  if (!name) throw new Error(`no class mapping for kind ${kind}`);
  const Cls = exports[name] as new (o: unknown) => unknown;
  return new Cls({ ...BASE_OPTS, id: `conformance-${kind}`, ...extra });
}

/**
 * `STTBaseLayer` keeps the caller's options verbatim (`this.opts = {
 * autoRepaint: true, ...opts }`), so that field absorbs EVERY key whether the
 * layer reads it or not — including keys no layer has ever heard of. It is
 * therefore excluded from the walk: the evidence has to come from a layer's own
 * RESOLVED options.
 */
const RAW_OPTIONS_FIELD = 'opts';

/**
 * Does `value` appear anywhere in the layer's own RESOLVED state?
 *
 * Layers park their defaulted options in one own field (`pointOpts`,
 * `lineOpts`, `polyOpts`, `tripsOpts`, `heatOpts`, `filterOpts`), so a depth-2
 * walk over own enumerable properties reaches every one of them without the
 * gate having to know which field a given layer chose. Matching is by
 * `Object.is`, so an object probe matches only its own reference.
 */
function absorbs(
  instance: unknown,
  value: unknown,
  depth = 2,
  isLayerRoot = true,
): boolean {
  if (Object.is(instance, value)) return true;
  if (depth === 0 || instance === null || typeof instance !== 'object') {
    return false;
  }
  if (ArrayBuffer.isView(instance)) return false;
  for (const [key, v] of Object.entries(instance as Record<string, unknown>)) {
    if (isLayerRoot && key === RAW_OPTIONS_FIELD) continue;
    if (absorbs(v, value, depth - 1, false)) return true;
  }
  return false;
}

/**
 * The differential probe behind gate (d): a layer PROVES a prop when setting it
 * to a unique value puts that value in the instance's resolved state AND the
 * same value is absent when the prop is not passed. Both halves matter — the
 * second is what stops a default (or an unrelated field) from faking a claim.
 */
function provesProp(kind: LayerKind, prop: string, probe: unknown): boolean {
  const withProp = construct(kind, { [prop]: probe });
  const without = construct(kind, {});
  return absorbs(withProp, probe) && !absorbs(without, probe);
}

/**
 * Probe value per feature prop. The default is a unique string, which is what a
 * property-NAME prop takes; `colorMapping` overrides it with a fresh object so
 * the match is by REFERENCE. A prop with no override still gets probed — an
 * unregistered prop must fail because the layer does not read it, never because
 * the gate had nothing to hand it.
 */
const FEATURE_PROBE_OVERRIDE: Readonly<Record<string, () => unknown>> = {
  colorMapping: () => ({ __sttConformanceCategory: [1, 2, 3, 4] }),
};

const featureProbe = (prop: string): unknown =>
  (FEATURE_PROBE_OVERRIDE[prop] ?? (() => `__stt_conformance_${prop}__`))();

/** Kernel function each time-filter mode must compile into a vertex shader. */
const MODE_KERNEL_FN: Readonly<Record<string, string>> = {
  window: 'sttTimeWindowAlpha(',
  wake: 'sttWakeAlpha(',
  cumulative: 'sttCumulativeAlpha(',
  trail: 'sttTrailAlpha(',
};

const LEGACY_SHADER = { prelude: '', define: '' };

/**
 * Every (layer, mode) source builder that is reachable today. Modes are
 * compiled in, so the emitted source IS the evidence a mode exists — and the
 * exclusivity check below proves the layer spliced the mode it was asked for
 * rather than shipping all four and branching at runtime.
 */
const MODE_SOURCES: ReadonlyArray<{
  layer: string;
  modes: readonly TimeFilterMode[];
  build: (mode: string) => string;
}> = [
  {
    layer: 'point',
    modes: ['window', 'wake', 'cumulative', 'trail'],
    build: (mode) =>
      buildPointVertexSource(LEGACY_SHADER, {
        mode: mode as never,
        filter: false,
      }),
  },
  {
    layer: 'line',
    modes: ['window', 'wake', 'cumulative', 'trail'],
    build: (mode) =>
      buildLineVertexSource(LEGACY_SHADER, { mode: mode as never }),
  },
  {
    layer: 'polygon',
    modes: ['window', 'wake', 'cumulative', 'trail'],
    build: (mode) =>
      buildFillVertexSource({ ...LEGACY_SHADER, mode: mode as never }),
  },
  {
    layer: 'heatmap',
    modes: ['window', 'wake', 'cumulative', 'trail'],
    build: (mode) =>
      buildHeatmapAccumVertexSource(LEGACY_SHADER, {
        timeFilterMode: mode as never,
      }),
  },
  {
    // Trips is a per-VERTEX swept path: window/cumulative have no meaning for
    // it (deck's AnimatedTripsLayer makes the same cut), so it contributes
    // evidence for trail + wake only.
    layer: 'trips',
    modes: ['trail', 'wake'],
    build: (mode) => buildTripsVertexSource(LEGACY_SHADER, mode as never),
  },
];

/** Modes with at least one layer that actually compiles the kernel. */
function provenTimeFilterModes(): Set<TimeFilterMode> {
  const proven = new Set<TimeFilterMode>();
  for (const entry of MODE_SOURCES) {
    for (const mode of entry.modes) {
      const fn = MODE_KERNEL_FN[mode];
      if (fn && entry.build(mode).includes(fn)) proven.add(mode);
    }
  }
  return proven;
}

/** Kinds whose class ships a `drawPickTile` hook (what `pick()` requires). */
function pickableKinds(): LayerKind[] {
  return (Object.keys(CLASS_FOR_KIND) as LayerKind[]).filter((kind) => {
    const layer = construct(kind, {}) as { supportsPicking(): boolean };
    return layer.supportsPicking();
  });
}

/** A v5-shaped shader injection, so the source builders emit the prelude variant. */
const PRELUDE_SHADER = {
  prelude:
    'uniform mat4 u_projection_matrix;\nvec4 projectTile(vec2 p) { return u_projection_matrix * vec4(p, 0.0, 1.0); }\nvec4 projectTileFor3D(vec2 p, float e) { return u_projection_matrix * vec4(p, e, 1.0); }',
  define: '#define GLOBE',
};

/**
 * Behavioural evidence for the capability axis — the half `assertDescriptorConsistent`
 * cannot police on its own, because it compares the descriptor's claim against a
 * set the caller supplies. Each predicate is derived from the SHIPPED code, so
 * deleting the behaviour un-proves the claim here instead of in a browser.
 */
const CAPABILITY_EVIDENCE: Readonly<
  Partial<Record<Capability, () => boolean>>
> = {
  // Every layer must compile the host's injected prelude and project through
  // it — that is what makes globe render natively rather than as a flat
  // mercator sheet pasted on a sphere.
  globe: () =>
    [
      buildPointVertexSource(PRELUDE_SHADER, { mode: 'window', filter: false }),
      buildLineVertexSource(PRELUDE_SHADER, { mode: 'window' }),
      buildFillVertexSource({ ...PRELUDE_SHADER, mode: 'window' }),
      buildTripsVertexSource(PRELUDE_SHADER, 'trail'),
      buildHeatmapAccumVertexSource(PRELUDE_SHADER, {
        timeFilterMode: 'window',
      }),
    ].every((src) => src.includes('projectTile(')),
  // Extrusion lives on the polygon layer: it must absorb `extruded`/`elevation`
  // AND emit the 3D projection branch.
  extrude3d: () =>
    provesProp('polygon', 'elevation', 4242.5) &&
    buildFillVertexSource({ ...PRELUDE_SHADER, mode: 'window' }).includes(
      'projectTileFor3D(',
    ) &&
    buildFillVertexSource({ ...LEGACY_SHADER, mode: 'window' }).includes(
      'uAltitudeScale',
    ),
  // GPU heatmap = a real accumulate pass with its own splat shader, not a
  // CPU-binned point layer.
  gpuHeatmap: () =>
    isExportedClass('STTHeatmapLayer') &&
    buildHeatmapAccumVertexSource(LEGACY_SHADER, {
      timeFilterMode: 'window',
    }).includes('gl_PointSize'),
  // Interleaved = every layer is a maplibre CustomLayerInterface drawing into
  // the host's own GL context (type 'custom'), not an overlaid canvas.
  interleavedBasemap: () =>
    (Object.keys(CLASS_FOR_KIND) as LayerKind[]).every(
      (kind) => (construct(kind, {}) as { type: string }).type === 'custom',
    ),
  picking: () => pickableKinds().length > 0,
  metricSizing: () =>
    provesProp('point', 'radiusUnits', 'meters') &&
    provesProp('line', 'widthUnits', 'meters') &&
    provesProp('trips', 'widthUnits', 'meters'),
};

describe('maplibreBackend descriptor', () => {
  it('is the maplibre backend and re-exports through the package barrel', () => {
    expect(maplibreBackend.id).toBe('maplibre');
    expect((maplibre as { maplibreBackend?: unknown }).maplibreBackend).toBe(
      maplibreBackend,
    );
  });

  it('(c) declares every LayerKind exactly once (exhaustive over the frozen vocabulary)', () => {
    expect(Object.keys(maplibreBackend.layerKinds).sort()).toEqual(
      [...LAYER_KINDS].sort(),
    );
    for (const kind of LAYER_KINDS) {
      expect(
        maplibreBackend.layerKinds[kind],
        `missing kind ${kind}`,
      ).toBeDefined();
    }
  });

  it('(c) every unsupported kind carries a reason', () => {
    for (const kind of LAYER_KINDS) {
      const support = maplibreBackend.layerKinds[kind];
      if (!support.supported) {
        expect(
          support.reason,
          `unsupported kind ${kind} needs a reason`,
        ).toBeTruthy();
      }
    }
  });

  it('supports exactly point/line/polygon/trips/heatmap and nothing else', () => {
    const supported = LAYER_KINDS.filter(
      (k) => maplibreBackend.layerKinds[k].supported,
    ).sort();
    expect(supported).toEqual(['heatmap', 'line', 'point', 'polygon', 'trips']);
  });

  it('degrades arc to a line fallback (natural for a backend without arc geometry)', () => {
    const arc = maplibreBackend.layerKinds.arc;
    expect(arc.supported).toBe(false);
    if (!arc.supported) {
      expect(arc.fallbackKind).toBe('line');
      expect(arc.reason).toBeTruthy();
    }
  });

  it('(c) every declared fallbackKind is itself a kind this backend renders', () => {
    // `degradeRequest` returns {action:'fallback', toKind} whenever a
    // fallbackKind is present, so naming an unsupported target hands the caller
    // a second unrenderable answer instead of the honest skip its `reason`
    // intends. three's suite ships the identical gate.
    for (const kind of LAYER_KINDS) {
      const support = maplibreBackend.layerKinds[kind];
      if (support.supported || !support.fallbackKind) continue;
      expect(
        maplibreBackend.layerKinds[support.fallbackKind as LayerKind]
          ?.supported,
        `fallback of "${kind}" (${support.fallbackKind}) must itself be supported`,
      ).toBe(true);
    }
  });

  it('(c) a kind with no in-backend approximation SKIPS rather than naming a dead fallback', () => {
    // The regression this guards: text/mesh/hexbin were copied from the three
    // descriptor with icon/boundingBox/h3Summary fallbacks that three supports
    // and this backend does not.
    for (const kind of ['text', 'mesh', 'hexbin'] as const) {
      const support = maplibreBackend.layerKinds[kind];
      expect(support.supported).toBe(false);
      if (!support.supported) expect(support.fallbackKind).toBeUndefined();
    }
  });

  it('(a) every supported kind maps to a class that is a real export', () => {
    for (const kind of LAYER_KINDS) {
      if (maplibreBackend.layerKinds[kind].supported) {
        const name = CLASS_FOR_KIND[kind];
        expect(
          name,
          `no class mapping for supported kind ${kind}`,
        ).toBeDefined();
        expect(isExportedClass(name), `${name} is not an exported class`).toBe(
          true,
        );
      }
    }
  });

  it('(b) is consistent: no capability/kind/mode is claimed without evidence', () => {
    // Evidence is derived from ground truth — real exports, real constructed
    // layers, real compiled shader sources — NOT copied from the descriptor.
    // Drop a `drawPickTile`, or a mode kernel, and the claim loses its backing
    // here rather than in a browser.
    const provenKinds = new Set<LayerKind>(
      (Object.keys(CLASS_FOR_KIND) as LayerKind[]).filter((k) =>
        isExportedClass(CLASS_FOR_KIND[k]),
      ),
    );
    // Every capability the descriptor claims TRUE must have a behavioural
    // predicate in CAPABILITY_EVIDENCE and that predicate must pass. A claim
    // with no predicate is itself a failure (the missing-predicate assertion
    // below), so a future capability flip cannot ride the declaration.
    const provenCaps = new Set<Capability>(
      CAPABILITIES.filter((c) => CAPABILITY_EVIDENCE[c]?.() === true),
    );
    for (const cap of CAPABILITIES) {
      if (!maplibreBackend.capabilities[cap]) continue;
      expect(
        CAPABILITY_EVIDENCE[cap],
        `capability "${cap}" is claimed but has no behavioural predicate`,
      ).toBeDefined();
    }

    const evidence: ConformanceEvidence = {
      capabilities: provenCaps,
      layerKinds: provenKinds,
      timeFilterModes: provenTimeFilterModes(),
    };
    expect(assertDescriptorConsistent(maplibreBackend, evidence)).toEqual([]);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Wave M2 capability flips (D8/D10/D11) — each backed by the behaviour that
 * earns it, per the campaign's descriptor-honesty rule.
 * ────────────────────────────────────────────────────────────────────────── */
describe('maplibreBackend — Wave M2 flips are earned, not declared', () => {
  it('declares all four time-filter modes, and every one compiles a kernel', () => {
    expect([...maplibreBackend.timeFilterModes].sort()).toEqual([
      'cumulative',
      'trail',
      'wake',
      'window',
    ]);
    for (const mode of maplibreBackend.timeFilterModes) {
      expect(
        provenTimeFilterModes().has(mode),
        `mode "${mode}" is declared but no layer compiles its kernel`,
      ).toBe(true);
    }
  });

  it.each(MODE_SOURCES)(
    'the $layer layer splices EXACTLY the mode it was asked for',
    ({ modes, build }) => {
      for (const mode of modes) {
        const src = build(mode);
        expect(src).toContain(MODE_KERNEL_FN[mode]!);
        for (const [other, fn] of Object.entries(MODE_KERNEL_FN)) {
          if (other === mode) continue;
          expect(
            src.includes(fn),
            `mode "${mode}" also compiled "${other}"'s kernel`,
          ).toBe(false);
        }
      }
    },
  );

  it('claims picking via an id FBO, backed by drawPickTile on every kind with feature identity', () => {
    expect(maplibreBackend.capabilities.picking).toBe(true);
    expect(maplibreBackend.pickMechanism).toBe('id-fbo');
    expect(pickableKinds().sort()).toEqual([
      'line',
      'point',
      'polygon',
      'trips',
    ]);
  });

  it('claims metricSizing, backed by the meters unit prop on every sizing layer', () => {
    expect(maplibreBackend.capabilities.metricSizing).toBe(true);
    expect(provesProp('point', 'radiusUnits', 'meters')).toBe(true);
    expect(provesProp('line', 'widthUnits', 'meters')).toBe(true);
    expect(provesProp('trips', 'widthUnits', 'meters')).toBe(true);
  });

  it('keeps globe, and the deliberate non-claims, unchanged', () => {
    // Wave M1: every layer compiles the host prelude and projects via
    // projectTile*, keyed by shaderData.variantName. Asserted through the
    // behavioural predicate, not the declaration — deleting the prelude branch
    // from any one layer fails here.
    expect(maplibreBackend.capabilities.globe).toBe(true);
    expect(CAPABILITY_EVIDENCE.globe!()).toBe(true);
    expect(CAPABILITY_EVIDENCE.extrude3d!()).toBe(true);
    expect(CAPABILITY_EVIDENCE.gpuHeatmap!()).toBe(true);
    expect(CAPABILITY_EVIDENCE.interleavedBasemap!()).toBe(true);
    expect(maplibreBackend.capabilities.timeAsHeight).toBe(false);
    expect(maplibreBackend.capabilities.liveBundling).toBe(false);
    expect(maplibreBackend.capabilities.userExtensions).toBe(false);
    // Default ownership stays per-layer; SharedTilesetSource is opt-in.
    expect(maplibreBackend.tilesetOwnership).toBe('per-layer');
    expect(maplibreBackend.basemapProjection).toBe('mercator');
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * (d) Layer-feature matrix gate — the deck-side block, adapted to a backend
 * whose prop surface is a constructor options interface rather than
 * `defaultProps` (see the file header for why construction is the probe).
 * ────────────────────────────────────────────────────────────────────────── */
describe('maplibreBackend — layer-feature matrix proven vs. real layer classes (d)', () => {
  it('maplibreLayerFeatures declares every LAYER_FEATURE exactly once, no strays', () => {
    for (const feature of LAYER_FEATURES) {
      expect(
        maplibreLayerFeatures[feature],
        `maplibreLayerFeatures.${feature}`,
      ).toBeDefined();
    }
    expect(Object.keys(maplibreLayerFeatures).sort()).toEqual(
      [...LAYER_FEATURES].sort(),
    );
  });

  it.each(LAYER_FEATURES)(
    'feature "%s" covers only supported kinds and proves its prop (or degrades)',
    (feature: LayerFeature) => {
      const support = maplibreLayerFeatures[feature];
      expect(support.kinds.length, `${feature}.kinds`).toBeGreaterThan(0);
      // Every kind a claim OR a fallback names must be a real LayerKind, so a
      // typo can never quietly widen/narrow the matrix.
      for (const kind of support.kinds) {
        expect(
          maplibreBackend.layerKinds[kind],
          `feature "${feature}" names unknown kind "${kind}"`,
        ).toBeDefined();
      }
      if (!support.supported) {
        expect(support.fallback, `${feature}.fallback`).toBeTruthy();
        expect(support.reason, `${feature}.reason`).toBeTruthy();
        return;
      }
      for (const kind of support.kinds) {
        // A feature may only cover a kind the backend actually renders.
        expect(
          maplibreBackend.layerKinds[kind].supported,
          `feature "${feature}" covers unsupported kind "${kind}"`,
        ).toBe(true);
        expect(
          isExportedClass(CLASS_FOR_KIND[kind]),
          `${CLASS_FOR_KIND[kind]} is not an exported class (kind=${kind})`,
        ).toBe(true);
        expect(
          provesProp(kind, support.prop, featureProbe(support.prop)),
          `feature "${feature}": ${CLASS_FOR_KIND[kind]} does not read option "${support.prop}"`,
        ).toBe(true);
      }
    },
  );

  it('dataFilter covers EVERY supported kind (the campaign DoD for the existing five)', () => {
    const support = maplibreLayerFeatures.dataFilter;
    expect(support.supported).toBe(true);
    const supported = LAYER_KINDS.filter(
      (k) => maplibreBackend.layerKinds[k].supported,
    ).sort();
    expect([...support.kinds].sort()).toEqual(supported);
  });

  it('stableColorMapping excludes heatmap, which has no categorical colour', () => {
    const support = maplibreLayerFeatures.stableColorMapping;
    expect(support.supported).toBe(true);
    expect(support.kinds).not.toContain('heatmap');
    // …and the exclusion is real, not editorial: the heatmap class ignores it.
    expect(provesProp('heatmap', 'colorMapping', { probe: true })).toBe(false);
  });

  it('timeHeightScale stays consistent with capabilities.timeAsHeight', () => {
    // The space-time-cube lift IS a rendering of time-as-height; the two claims
    // must never disagree.
    expect(maplibreLayerFeatures.timeHeightScale.supported).toBe(
      maplibreBackend.capabilities.timeAsHeight,
    );
  });

  it('unsupported features name a degrade path, and none of them silently no-ops', () => {
    for (const feature of LAYER_FEATURES) {
      const support = maplibreLayerFeatures[feature];
      if (support.supported) continue;
      expect(support.fallback.length, `${feature}.fallback`).toBeGreaterThan(
        10,
      );
      expect(support.reason.length, `${feature}.reason`).toBeGreaterThan(10);
    }
  });
});

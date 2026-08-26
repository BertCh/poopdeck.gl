// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * Structural conformance gate for the maplibre backend descriptor
 * (docs/roadmap/renderer-architecture.md Phase 5, + D9 of the
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
  bundleEdges,
  BUNDLING_WORK_SIZE,
} from '@poopdeck.gl/core/edge-bundling';
import { composeExtensionChunks } from '../src/shaders/extensions.glsl';
import {
  pointProgramKey,
  buildPointIdVertexSource,
} from '../src/layers/point-layer';
import {
  buildFlowBundle,
  resampleFlowEdges,
  toWorkBox,
  DEFAULT_BUNDLE_KERNEL_RADIUS,
  DEFAULT_BUNDLE_DENSITY_RES,
} from '../src/lib/edge-bundler';
import {
  applyViewState,
  readViewState,
  supportsRoll,
  type ViewStateHost,
} from '../src/lib/view-state';
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
import { buildIsoVertexSource } from '../src/layers/iso-layer';
import { buildPointCloudVertexSource } from '../src/layers/point-cloud-layer';
import { buildTextVertexSource } from '../src/layers/text-layer';
import { buildBoundingBoxVertexSource } from '../src/layers/bounding-box-layer';
import { buildMeshVertexSource } from '../src/layers/mesh-layer';
import { buildEgoVertexSource } from '../src/layers/ego-layer';
import { buildSurfelVertexSource } from '../src/layers/surfel-layer';
import { buildFillVertexSource } from '../src/layers/polygon-layer';
import { buildTripsVertexSource } from '../src/layers/trips-layer';
import { buildHeatmapAccumVertexSource } from '../src/layers/heatmap-layer';
import { buildIconVertexSource } from '../src/layers/icon-layer';
import {
  buildColumnVertexSource,
  resolveColumnRadiusScale,
  timeHeightLiftMeters,
} from '../src/layers/column-layer';
import { metersToMercatorUnits } from '../src/lib/projection';
import { buildArcVertexSource } from '../src/layers/arc-layer';
import { buildTripHeadsVertexSource } from '../src/layers/trip-heads-layer';
// Wave M4 — summary + flow families. Each ships a projecting vertex-source
// builder (the summary/hexbin cell passes project via `projectTileFor3D`
// through the shared elevated kernel; the flow passes via `projectTile`).
import { buildSummaryCellVertexSource } from '../src/layers/summary-cell-layer';
import { buildHexbinCellVertexSource } from '../src/layers/hexbin-layer';
import { buildFlowCorridorVertexSource } from '../src/layers/flow-corridor-layer';
import { buildFlowmapVertexSource } from '../src/layers/flowmap-layer';

/**
 * A no-op H3 boundary resolver. `STTH3SummaryLayer` REQUIRES an injected
 * `cellToBoundary` (h3-js is not a dependency of this package) and THROWS
 * without one, so every construction of the h3Summary kind in this gate must
 * supply it. It is never called during construction — a stub triangle suffices.
 */
const STUB_H3_BOUNDARY = (): number[][] => [
  [0, 0],
  [0, 1],
  [1, 1],
];

/**
 * Kind-specific options a constructor demands beyond {@link BASE_OPTS}. Only
 * the h3Summary kind has one (its injected boundary resolver); every other kind
 * constructs from the base options alone.
 */
const REQUIRED_EXTRA: Partial<Record<LayerKind, Record<string, unknown>>> = {
  h3Summary: { cellToBoundary: STUB_H3_BOUNDARY },
};

/**
 * The exported layer class that renders each maplibre-supported kind.
 *
 * This map is the gate's ONLY bridge from the descriptor's vocabulary to real
 * code: gate (a) fails a supported kind with no entry, and `construct` throws
 * for one, so adding a kind to `SUPPORTED_KINDS` without shipping (and
 * exporting) a class cannot pass.
 */
const CLASS_FOR_KIND: Partial<Record<LayerKind, string>> = {
  point: 'STTPointLayer',
  line: 'STTLineLayer',
  path: 'STTPathLayer',
  isoLines: 'STTIsoLayer',
  pointCloud: 'STTPointCloudLayer',
  text: 'STTTextLayer',
  boundingBox: 'STTBoundingBoxLayer',
  mesh: 'STTMeshLayer',
  ego: 'STTEgoLayer',
  surfel: 'STTSurfelLayer',
  polygon: 'STTPolygonLayer',
  trips: 'STTTripsLayer',
  heatmap: 'STTHeatmapLayer',
  // Wave M3.
  icon: 'STTIconLayer',
  column: 'STTColumnLayer',
  arc: 'STTArcLayer',
  tripHeads: 'STTTripHeadsLayer',
  // Wave M4 — summary + flow families. flowStroke is a genuinely distinct kind
  // backed by its own exported subclass (`STTFlowStrokeLayer extends
  // STTFlowCorridorLayer`), so the gate constructs and proves it independently.
  h3Summary: 'STTH3SummaryLayer',
  quadbinSummary: 'STTQuadbinSummaryLayer',
  hexbin: 'STTHexbinLayer',
  flowCorridor: 'STTFlowCorridorLayer',
  flowStroke: 'STTFlowStrokeLayer',
  flowmap: 'STTFlowmapLayer',
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
  // Kind-required options (e.g. h3Summary's injected cellToBoundary) go in
  // FIRST so a caller-supplied `extra` can still override them, and so the
  // differential probe's "without" construction stays valid too.
  return new Cls({
    ...BASE_OPTS,
    ...REQUIRED_EXTRA[kind],
    id: `conformance-${kind}`,
    ...extra,
  });
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
 * A CLASS INSTANCE parked on the layer root — an archive, a tileset, a shared
 * source, the map itself, a track-index maintainer. `STTBaseLayer`'s
 * constructor FORWARDS options into these (`new STTArchive({ url: opts.url,
 * maxConcurrentRequests: opts.maxRequests })`, and `STTArchive` keeps `url` as
 * an own property), so descending into them would let a base-forwarded option
 * "prove" itself for every kind with no per-kind implementation behind it —
 * `provesProp(anyKind, 'url', probe)` would come back true. Resolved option
 * bags are plain objects and arrays, which is the distinction drawn here.
 */
const isCollaborator = (v: unknown): boolean =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) !== Object.prototype &&
  Object.getPrototypeOf(v) !== null;

/**
 * Does `value` appear anywhere in the layer's own RESOLVED state?
 *
 * Layers park their defaulted options in one own field (`pointOpts`,
 * `lineOpts`, `polyOpts`, `tripsOpts`, `heatOpts`, `filterOpts`), so a depth-2
 * walk over own enumerable properties reaches every one of them without the
 * gate having to know which field a given layer chose. Matching is by
 * `Object.is`, so an object probe matches only its own reference.
 *
 * Two things the walk refuses to count as evidence at the layer ROOT: the raw
 * `opts` bag (it absorbs every key whether the layer reads it or not) and any
 * {@link isCollaborator} instance (storage inside a base-built collaborator is
 * the BASE reading the option, not this kind).
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
    if (isLayerRoot && (key === RAW_OPTIONS_FIELD || isCollaborator(v))) {
      continue;
    }
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
  {
    layer: 'icon',
    modes: ['window', 'wake', 'cumulative', 'trail'],
    build: (mode) =>
      buildIconVertexSource(LEGACY_SHADER, {
        mode: mode as never,
        filter: false,
        glide: false,
      }),
  },
  {
    layer: 'column',
    modes: ['window', 'wake', 'cumulative', 'trail'],
    build: (mode) =>
      buildColumnVertexSource(LEGACY_SHADER, {
        mode: mode as never,
        filter: false,
      }),
  },
  {
    layer: 'arc',
    modes: ['window', 'wake', 'cumulative', 'trail'],
    build: (mode) =>
      buildArcVertexSource(LEGACY_SHADER, {
        mode: mode as never,
        filter: false,
        greatCircle: false,
        pick: false,
      }),
  },
  {
    // A head is ONE moving position: `cumulative` and `trail` describe a
    // history, which is what STTTripsLayer draws, so this layer contributes
    // evidence for window + wake only (and degrades the other two with a warn).
    layer: 'tripHeads',
    modes: ['window', 'wake'],
    build: (mode) =>
      buildTripHeadsVertexSource(LEGACY_SHADER, {
        mode: mode as never,
        filter: false,
      }),
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
/**
 * Every prelude source in the package, one per layer class — the globe
 * predicate's input. A new kind that forgot the prelude branch (or that only
 * ever emits the legacy `uMatrix` shader) un-proves `globe` here.
 */
const PRELUDE_SOURCES = (): string[] => [
  buildPointVertexSource(PRELUDE_SHADER, { mode: 'window', filter: false }),
  buildLineVertexSource(PRELUDE_SHADER, { mode: 'window' }),
  // The `path` kind compiles through the SAME builder — that sharing is the
  // point of STTPathLayer being a subclass rather than a fork — but it is a
  // distinct supported kind, so it owes this gate its own entry (the assertion
  // below counts sources against the supported-kind count). `reveal` is the
  // mode that is path-specific, so that is the one to prove reaches the prelude.
  buildLineVertexSource(PRELUDE_SHADER, { mode: 'reveal' }),
  // The 2026-08-26 completion pass — one entry per newly-native kind, so the
  // count assertion below stays a real completeness check.
  buildIsoVertexSource(PRELUDE_SHADER, { mode: 'window' }),
  buildPointCloudVertexSource(PRELUDE_SHADER, {
    mode: 'window',
    filter: false,
  }),
  buildTextVertexSource(PRELUDE_SHADER, { mode: 'window', filter: false }),
  buildBoundingBoxVertexSource(PRELUDE_SHADER, {
    mode: 'window',
    filter: false,
  }),
  buildMeshVertexSource(PRELUDE_SHADER, { mode: 'window', filter: false }),
  buildEgoVertexSource(PRELUDE_SHADER, { mode: 'window', filter: false }),
  buildSurfelVertexSource(PRELUDE_SHADER, { mode: 'window', filter: false }),
  buildFillVertexSource({ ...PRELUDE_SHADER, mode: 'window' }),
  buildTripsVertexSource(PRELUDE_SHADER, 'trail'),
  buildHeatmapAccumVertexSource(PRELUDE_SHADER, { timeFilterMode: 'window' }),
  buildIconVertexSource(PRELUDE_SHADER, {
    mode: 'window',
    filter: false,
    glide: false,
  }),
  buildColumnVertexSource(PRELUDE_SHADER, { mode: 'window', filter: false }),
  buildArcVertexSource(PRELUDE_SHADER, {
    mode: 'window',
    filter: false,
    greatCircle: false,
    pick: false,
  }),
  buildTripHeadsVertexSource(PRELUDE_SHADER, { mode: 'window', filter: false }),
  // Wave M4. One entry per supported KIND so the count equals the supported set
  // exactly (the test below asserts that): h3Summary and quadbinSummary compile
  // a byte-identical cell shader, and flowStroke reuses flowCorridor's builder
  // (it is an STTFlowCorridorLayer subclass), so those pairs each call one
  // builder twice — every kind still demonstrably projects through the prelude.
  buildSummaryCellVertexSource(PRELUDE_SHADER, {
    mode: 'window',
    filter: false,
  }),
  buildSummaryCellVertexSource(PRELUDE_SHADER, {
    mode: 'window',
    filter: false,
  }),
  buildHexbinCellVertexSource(PRELUDE_SHADER, {
    colorAggregation: 'SUM',
    elevationAggregation: 'SUM',
    source: 'gpu',
  }),
  buildFlowCorridorVertexSource(PRELUDE_SHADER, {
    mode: 'window',
    magnitude: 'texture',
    format: 'float32',
    filter: false,
    ramp: false,
  }),
  buildFlowCorridorVertexSource(PRELUDE_SHADER, {
    mode: 'window',
    magnitude: 'texture',
    format: 'float32',
    filter: false,
    ramp: false,
  }),
  buildFlowmapVertexSource(PRELUDE_SHADER, {
    mode: 'window',
    filter: false,
    colorMode: 'direction',
    bundle: true,
    magnitude: 'texture',
    format: 'float32',
    pick: false,
  }),
];

/**
 * Strip the map-injected block ({@link PRELUDE_SHADER}) from a compiled source,
 * leaving only the layer's own generated body.
 *
 * The prelude DEFINES `vec4 projectTile(vec2 p) {…}` and `vec4
 * projectTileFor3D(vec2 p, float e) {…}`, so both call-site tokens are present
 * in EVERY prelude source whether or not the layer body ever calls them —
 * every builder prepends the prelude verbatim (`${shader.prelude}\n…`). Searching
 * the whole source for those tokens is therefore tautological: it would keep the
 * `globe`/`extrude3d` claims "proven" even if a body were reverted to a flat
 * `uMatrix` projection with the prelude head still attached. Removing the
 * injected block first makes the search see only the layer's code, so such a
 * revert un-proves the claim here rather than in a browser.
 */
const stripInjectedPrelude = (src: string): string =>
  src
    .split(PRELUDE_SHADER.prelude)
    .join('')
    .split(PRELUDE_SHADER.define)
    .join('');

/**
 * A source projects through the host prelude when its BODY calls EITHER entry
 * point. The flat kinds call `projectTile`; the genuinely 3D ones (column, arc,
 * and polygon when extruded) call `projectTileFor3D`, which is a different token
 * — matching only `projectTile(` would silently un-prove them. The prelude's own
 * function DEFINITIONS are stripped first ({@link stripInjectedPrelude}) so they
 * cannot satisfy the check on the layer's behalf.
 */
const projectsViaPrelude = (src: string): boolean => {
  const body = stripInjectedPrelude(src);
  return body.includes('projectTile(') || body.includes('projectTileFor3D(');
};

const CAPABILITY_EVIDENCE: Readonly<
  Partial<Record<Capability, () => boolean>>
> = {
  // Every layer must compile the host's injected prelude and project through
  // it — that is what makes globe render natively rather than as a flat
  // mercator sheet pasted on a sphere.
  globe: () => PRELUDE_SOURCES().every(projectsViaPrelude),
  // Extrusion lives on the polygon layer: it must absorb `extruded`/`elevation`
  // AND its own BODY must emit the 3D projection branch. The prelude is stripped
  // before the `projectTileFor3D(` search (see stripInjectedPrelude) so the
  // prelude's function DEFINITION cannot stand in for the extruded fill actually
  // calling it — reverting the extrusion branch to a flat projection un-proves
  // this half here.
  extrude3d: () =>
    provesProp('polygon', 'elevation', 4242.5) &&
    stripInjectedPrelude(
      buildFillVertexSource({ ...PRELUDE_SHADER, mode: 'window' }),
    ).includes('projectTileFor3D(') &&
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
    provesProp('trips', 'widthUnits', 'meters') &&
    // Wave M3 kinds size in metres too, each through the same per-tile
    // `lib/projection.ts` factor at the tile's centre latitude.
    provesProp('icon', 'sizeUnits', 'meters') &&
    provesProp('arc', 'widthUnits', 'meters') &&
    provesProp('tripHeads', 'radiusUnits', 'meters') &&
    // Column is the one layer a value probe cannot settle: `'meters'` is
    // already its default (deck ColumnLayer parity) and `'pixels'` is the
    // default of its OWN `lineWidthUnits`, so both probe values are present
    // either way. Prove the maths instead — the metres branch of the exported
    // CPU reference must BE the latitude-correct factor, and the pixels branch
    // must not be.
    resolveColumnRadiusScale('meters', 1, 45, 6) ===
      metersToMercatorUnits(1, 45) &&
    resolveColumnRadiusScale('pixels', 1, 45, 6) !==
      resolveColumnRadiusScale('meters', 1, 45, 6),
  // Wave M3: the space-time-cube lift IS a rendering of time as height. Proven
  // by the column layer reading the scale AND its CPU twin — the exact function
  // the shader mirrors — returning the lift the declaration promises.
  timeAsHeight: () =>
    provesProp('column', 'timeHeightScale', 1234.5) &&
    provesProp('column', 'timeHeightOrigin', 1_700_000_111_000) &&
    timeHeightLiftMeters(5_000, 1_000, 2) === 8_000,
  // Camera roll is a claim about the SEAM, not about the shaders: roll is
  // already inside the view matrix (and inside the v5+ projection prelude), so
  // no layer had to change. What the flag claims is that `ViewState.roll`
  // survives a round trip through the host camera instead of being dropped —
  // and, because the peer range spans a major that has no roll at all, that a
  // host without it degrades HONESTLY rather than silently.
  //
  // Both halves are asserted, so flipping either behaviour un-proves the claim:
  // a v5+ host must round-trip the value, and a <=v4 host must both REPORT the
  // drop and omit the key (reporting a fabricated `roll: 0` would make "no roll
  // DOF" indistinguishable from "level", which is the whole failure this
  // degradation exists to avoid).
  // Live bundling is a claim that the KDEEB schedule really RUNS and really
  // bends the drawn edges — not that a bundler module exists. So the predicate
  // builds a real bundle from parallel OD pairs and demands two things: the
  // control points moved off the straight chord at all, and they moved to
  // exactly where core's shared `bundleEdges` puts them. The second half is
  // what stops a hand-rolled lookalike from passing: this backend, three and
  // cesium all run the SAME core function, and disagreeing with it is the
  // drift this whole conformance idiom exists to prevent.
  liveBundling: () => {
    // A claim that the KDEEB schedule really RUNS and really bends the drawn
    // edges — not that a bundler module exists. Two halves:
    //   (a) interior control points left the straight chord at all, and
    //   (b) they landed exactly where core's shared `bundleEdges` puts them.
    // (b) is what stops a hand-rolled lookalike from passing: this backend,
    // three and cesium all run the SAME core function, and disagreeing with it
    // is precisely the drift this conformance idiom exists to prevent. The
    // re-derivation goes through the module's OWN `resampleFlowEdges` +
    // `toWorkBox`, so it compares the BUNDLING, not the parametrization.
    const E = 6;
    const sourceM: number[] = [];
    const targetM: number[] = [];
    for (let e = 0; e < E; e++) {
      const y = 0.5 + (e - (E - 1) / 2) * 0.0008;
      sourceM.push(0.4, y);
      targetM.push(0.6, y);
    }
    const input = {
      dims: 2,
      sourceM,
      targetM,
      edgeCount: E,
      unwrapX: (_ref: number, x: number) => x,
    };
    const bundle = buildFlowBundle(input, { bundlingIterations: 10 });
    if (!bundle) return false;
    const { texels, pointsPerEdge: P, edgeCount } = bundle;
    if (edgeCount !== E || P < 3) return false;

    let moved = false;
    for (let e = 0; e < E && !moved; e++) {
      const y0 = texels[e * P * 4 + 1];
      for (let i = 1; i < P - 1; i++) {
        if (Math.abs(texels[(e * P + i) * 4 + 1] - y0) > 1e-12) {
          moved = true;
          break;
        }
      }
    }
    if (!moved) return false;

    const raw = resampleFlowEdges(input, P);
    const box = toWorkBox(raw, E * P);
    if (!box) return false;
    const ref = bundleEdges(raw, E, P, {
      iterations: 10,
      kernelRadius: DEFAULT_BUNDLE_KERNEL_RADIUS * BUNDLING_WORK_SIZE,
      lambda: 0.85,
      smoothing: 0.5,
      densityResolution: DEFAULT_BUNDLE_DENSITY_RES,
    });
    const inv = 1 / box.scale;
    for (let e = 0; e < E; e++) {
      // Endpoints are restored verbatim from the inputs by the bundler, so
      // compare only the interior — the endpoint pin has its own test.
      for (let i = 1; i < P - 1; i++) {
        const p = e * P + i;
        const wantX = ref[p * 2] * inv + box.originX;
        const wantY = ref[p * 2 + 1] * inv + box.originY;
        if (Math.abs(texels[p * 4] - wantX) > 1e-6) return false;
        if (Math.abs(texels[p * 4 + 1] - wantY) > 1e-6) return false;
      }
    }
    return true;
  },
  // A claim that a USER's plain object really reaches the compiled shader and
  // really changes what is drawn — not that an extensions module exists. Three
  // halves, matching the three ways this could be decorative:
  //   (a) the snippet lands in the compiled VERTEX source;
  //   (b) it lands in the ID/pick source too, or a geometry-moving extension
  //       would desync the hit box from the drawn shape;
  //   (c) its identity enters the PROGRAM-CACHE KEY, or two layers with
  //       different extensions silently share one linked program — the single
  //       most dangerous failure mode for a chunk-injection surface.
  // And the empty case must be byte-identical, or every existing layer changed.
  userExtensions: () => {
    // A claim that a USER's plain object really reaches the compiled shader and
    // really changes what is drawn — not that an extensions module exists.
    // Three halves, matching the three ways this could be decorative:
    //   (a) the snippet lands in the compiled VERTEX source;
    //   (b) it lands in the ID/pick source too, or a geometry-moving extension
    //       would desync the hit box from the drawn shape;
    //   (c) its identity enters the PROGRAM-CACHE KEY, or two layers with
    //       different extensions silently share one linked program — the single
    //       most dangerous failure mode for a chunk-injection surface.
    // And the empty case must be byte-identical, or every existing layer moved.
    const marker = 'sttExtProbeMarker';
    const chunks = composeExtensionChunks([
      {
        name: 'conformance-probe',
        uniforms: `uniform float ${marker};`,
        vertex: { size: `radiusPx *= max(${marker}, 1.0);` },
      },
    ]);
    const base = { mode: 'window' as const, filter: false };

    const vs = buildPointVertexSource(PRELUDE_SHADER, {
      ...base,
      extensions: chunks,
    });
    const ids = buildPointIdVertexSource(PRELUDE_SHADER, {
      ...base,
      extensions: chunks,
    });
    if (!vs.includes(marker) || !ids.includes(marker)) return false;

    // (c) the digest reaches BOTH cache keys.
    const keyed = pointProgramKey('main', { ...base, extensions: chunks });
    const bareKey = pointProgramKey('main', base);
    const keyedPick = pointProgramKey('pick', { ...base, extensions: chunks });
    const barePick = pointProgramKey('pick', base);
    if (keyed === bareKey || keyedPick === barePick) return false;

    // Empty ⇒ byte-identical source AND an unchanged cache key.
    const empty = composeExtensionChunks([]);
    if (
      buildPointVertexSource(PRELUDE_SHADER, { ...base, extensions: empty }) !==
      buildPointVertexSource(PRELUDE_SHADER, base)
    ) {
      return false;
    }
    return pointProgramKey('main', { ...base, extensions: empty }) === bareKey;
  },
  cameraRoll: () => {
    const state = { roll: 0 };
    const base = {
      getCenter: () => ({ lng: 1, lat: 2 }),
      getZoom: () => 3,
      getPitch: () => 4,
      getBearing: () => 5,
      jumpTo: (o: Record<string, unknown>) => {
        if (typeof o.roll === 'number') state.roll = o.roll;
      },
    };
    const v5: ViewStateHost = {
      ...base,
      getRoll: () => state.roll,
      setRoll: (r: number) => {
        state.roll = r;
      },
    };
    const v4: ViewStateHost = { ...base };

    const want = 33;
    const applied = applyViewState(v5, {
      longitude: 1,
      latitude: 2,
      zoom: 3,
      roll: want,
    });
    const rolls =
      supportsRoll(v5) &&
      !supportsRoll(v4) &&
      applied.dropped.length === 0 &&
      readViewState(v5).roll === want;

    const degrades =
      applyViewState(v4, {
        longitude: 1,
        latitude: 2,
        zoom: 3,
        roll: want,
      }).dropped.includes('roll') && readViewState(v4).roll === undefined;

    return rolls && degrades;
  },
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

  it('supports every frozen LayerKind — the parity claim, stated once', () => {
    // This case used to enumerate the fifteen (then sixteen) shipped kinds by
    // name. The 2026-08-26 completion pass made every kind native, so the
    // enumeration became a list of all 23 that says nothing a completeness
    // check does not say better — and that would go stale the moment core adds
    // a kind, which is precisely when this gate should FAIL rather than be
    // edited.
    const unsupported = LAYER_KINDS.filter(
      (k) => !maplibreBackend.layerKinds[k].supported,
    );
    expect(unsupported).toEqual([]);
    expect(LAYER_KINDS.length).toBe(23);
  });

  it('renders arc NATIVELY — the arc→line fallback is retired, not re-pointed', () => {
    // Wave M3 replaced the approximation (a chord on the ground) with a real
    // tessellated 3D arc, so the kind must be supported AND carry no fallback
    // (a supported kind with a fallbackKind would make `degradeRequest`
    // ambiguous about which answer wins).
    const arc = maplibreBackend.layerKinds.arc;
    expect(arc.supported).toBe(true);
    expect((arc as { fallbackKind?: string }).fallbackKind).toBeUndefined();
    expect(isExportedClass('STTArcLayer')).toBe(true);
  });

  it('declares NO fallbacks at all, because no kind needs one', () => {
    // Two cases used to live here: "text now degrades to a REAL icon layer
    // instead of dangling" and the gate-(c) skip rule. Both described a backend
    // with unsupported kinds — text degraded to icon, and kinds with no
    // in-backend approximation had to skip rather than name a dead fallback.
    // Every kind is native now, so FALLBACK_KINDS is empty and the whole class
    // of bug (a fallback naming a kind this backend does not render, handing the
    // caller a second unrenderable answer) is structurally impossible. Asserting
    // emptiness is the stronger statement, and it fails loudly the moment
    // someone reintroduces a degradation without thinking it through.
    for (const kind of LAYER_KINDS) {
      const support = maplibreBackend.layerKinds[kind];
      expect(support.supported, `${kind} must be native`).toBe(true);
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

  it('(c) every kind is native, so degradeRequest never hands back a second unrenderable kind', () => {
    // The regression this guarded: a fallback pointing at a kind the backend
    // does not itself render. With nothing unsupported there is no fallback to
    // get wrong — but keep the shape of the check so a future unsupported kind
    // re-arms it rather than slipping through.
    for (const kind of LAYER_KINDS) {
      const support = maplibreBackend.layerKinds[kind];
      if (support.supported) continue;
      expect(support.fallbackKind).toBeUndefined();
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
    // Every supported kind EXCEPT heatmap, whose pixels are a sum of unbounded
    // splats with no single feature behind them. The M4 summary/hexbin/flow
    // kinds each ship a `drawPickTile` (a cell / a corridor / an OD arrow is the
    // pick unit), so they join the set.
    expect(pickableKinds().sort()).toEqual(
      // Every kind EXCEPT heatmap, whose pixels are a sum of unbounded splats
      // with no single feature behind them. Derived rather than enumerated so
      // this cannot drift from LAYER_KINDS again.
      LAYER_KINDS.filter((k) => k !== 'heatmap').sort(),
    );
    expect(
      (
        construct('heatmap', {}) as { supportsPicking(): boolean }
      ).supportsPicking(),
    ).toBe(false);
  });

  it('claims metricSizing, backed by the meters unit prop on every sizing layer', () => {
    expect(maplibreBackend.capabilities.metricSizing).toBe(true);
    expect(provesProp('point', 'radiusUnits', 'meters')).toBe(true);
    expect(provesProp('line', 'widthUnits', 'meters')).toBe(true);
    expect(provesProp('trips', 'widthUnits', 'meters')).toBe(true);
    expect(CAPABILITY_EVIDENCE.metricSizing!()).toBe(true);
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
    // liveBundling was a deliberate non-claim until the 2026-08-26 pass gave
    // this backend a real KDEEB path; it is now asserted through its own
    // behavioural predicate above, like globe and gpuHeatmap.
    expect(CAPABILITY_EVIDENCE.liveBundling!()).toBe(true);
    // userExtensions was a deliberate non-claim until the 2026-08-26 pass gave
    // this backend a real GLSL chunk-injection surface; it is now asserted
    // through its own behavioural predicate above.
    expect(CAPABILITY_EVIDENCE.userExtensions!()).toBe(true);
    // Default ownership stays per-layer; SharedTilesetSource is opt-in.
    expect(maplibreBackend.tilesetOwnership).toBe('per-layer');
    expect(maplibreBackend.basemapProjection).toBe('mercator');
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Wave M3 flips (four new kinds + the four remaining feature bits). Same rule
 * as M2: the behaviour earns the declaration, never the other way round.
 * ────────────────────────────────────────────────────────────────────────── */
describe('maplibreBackend — Wave M3 flips are earned, not declared', () => {
  it.each(['icon', 'column', 'arc', 'tripHeads'] as const)(
    'the %s kind is native: supported, exported, constructible and pickable',
    (kind) => {
      expect(maplibreBackend.layerKinds[kind].supported).toBe(true);
      expect(isExportedClass(CLASS_FOR_KIND[kind])).toBe(true);
      const layer = construct(kind, {}) as {
        type: string;
        supportsPicking(): boolean;
      };
      expect(layer.type).toBe('custom');
      expect(layer.supportsPicking()).toBe(true);
    },
  );

  it('every supported kind compiles the host prelude (globe reaches all of them)', () => {
    expect(PRELUDE_SOURCES()).toHaveLength(
      LAYER_KINDS.filter((k) => maplibreBackend.layerKinds[k].supported).length,
    );
    expect(PRELUDE_SOURCES().every(projectsViaPrelude)).toBe(true);
  });

  it('the globe gate can FAIL a false claim: a prelude head over a uMatrix body does not prove globe', () => {
    // Regression guard for the tautology that once protected `globe`/`extrude3d`:
    // because the injected prelude DEFINES projectTile*, a whole-source substring
    // search passed even for a body that never projected through it. A synthetic
    // source with the real prelude head but a flat uMatrix body must therefore
    // read as NOT projecting — proving `projectsViaPrelude` inspects the layer's
    // own code, not the map's injected functions.
    const preludeHeadOverUMatrixBody =
      `${PRELUDE_SHADER.prelude}\n${PRELUDE_SHADER.define}\n` +
      'void main() { gl_Position = uMatrix * vec4(0.0, 0.0, 0.0, 1.0); }';
    expect(preludeHeadOverUMatrixBody).toContain('projectTile('); // the naive check would pass…
    expect(projectsViaPrelude(preludeHeadOverUMatrixBody)).toBe(false); // …the body-only check does not.
    // And a real prelude source (its body DOES call projectTile) still proves it.
    expect(
      projectsViaPrelude(
        buildPointVertexSource(PRELUDE_SHADER, {
          mode: 'window',
          filter: false,
        }),
      ),
    ).toBe(true);
  });

  it('claims timeAsHeight, backed by the column layer’s lift (not a proxy)', () => {
    expect(maplibreBackend.capabilities.timeAsHeight).toBe(true);
    expect(CAPABILITY_EVIDENCE.timeAsHeight!()).toBe(true);
    // The CPU twin the shader mirrors: a feature 5 s past the origin at
    // 2 m/ms sits 10 km up, and the origin itself never moves.
    expect(timeHeightLiftMeters(5_000, 0, 2)).toBe(10_000);
    expect(timeHeightLiftMeters(1_000, 1_000, 99)).toBe(0);
  });

  it('motionInterpolation names the prop BOTH interpolating layers really read', () => {
    const support = maplibreLayerFeatures.motionInterpolation;
    expect(support.supported).toBe(true);
    if (!support.supported) return;
    expect([...support.kinds].sort()).toEqual(['icon', 'tripHeads']);
    for (const kind of support.kinds) {
      expect(provesProp(kind, support.prop, 987_654)).toBe(true);
    }
    // …and the point layer is honestly EXCLUDED: it has no glide surface.
    expect(support.kinds).not.toContain('point');
    expect(provesProp('point', 'maxInterpolationGap', 987_654)).toBe(false);
  });

  it('the icon layer really reads the whole glide surface, not just the gate prop', () => {
    // `interpolate` is a boolean and so cannot be value-probed differentially
    // (the layer stores `opts.interpolate === true`, and `true` occurs in other
    // own fields) — assert it behaviourally instead: the glide program key only
    // appears when the full deck gate is satisfied.
    const glide = construct('icon', {
      interpolate: true,
      idProperty: 'icao24',
    }) as { mainKey: string };
    expect(glide.mainKey).toContain('glide');
    const discrete = construct('icon', { idProperty: 'icao24' }) as {
      mainKey: string;
    };
    expect(discrete.mainKey).not.toContain('glide');
    // reducedMotion is the accessibility escape hatch and must win.
    const reduced = construct('icon', {
      interpolate: true,
      idProperty: 'icao24',
      reducedMotion: true,
    }) as { mainKey: string };
    expect(reduced.mainKey).not.toContain('glide');
    expect(provesProp('icon', 'idProperty', '__stt_id__')).toBe(true);
  });

  it('pathReveal names BOTH the line and path kinds, now that path is real', () => {
    // This case used to read "names `line`, never the UNSUPPORTED `path` kind"
    // and asserted `path.supported === false`. That was the honest statement
    // while the reveal surface had no class of its own to sit on — the
    // descriptor was simultaneously claiming pathReveal and denying the path
    // kind. STTPathLayer resolves the contradiction from the other side, so the
    // feature now names both kinds and the denial is gone.
    const support = maplibreLayerFeatures.pathReveal;
    expect(support.supported).toBe(true);
    if (!support.supported) return;
    expect([...support.kinds].sort()).toEqual(['line', 'path']);
    expect(maplibreBackend.layerKinds.path.supported).toBe(true);
    // The path kind really compiles the reveal mode too, not just the line kind.
    const revealed = construct('path', { revealTrail: true }) as {
      mainProgramKey: string;
    };
    expect(revealed.mainProgramKey).toContain('reveal');
    // Reveal is OFF by default and supersedes the time mode only when asked.
    const off = construct('line', {}) as { mainProgramKey: string };
    expect(off.mainProgramKey).not.toContain('reveal');
    const on = construct('line', { revealTrail: true }) as {
      mainProgramKey: string;
    };
    expect(on.mainProgramKey).toContain('reveal');
  });

  it('iconWake is the icon layer’s own wake, not the generic one re-labelled', () => {
    const support = maplibreLayerFeatures.iconWake;
    expect(support.supported).toBe(true);
    if (!support.supported) return;
    expect(support.kinds).toEqual(['icon']);
    // A positive wakeLength must compile the wake kernel AND its size taper —
    // the alpha alone would be the point layer's wake, not an icon wake.
    const src = buildIconVertexSource(LEGACY_SHADER, {
      mode: 'wake',
      filter: false,
      glide: false,
    });
    expect(src).toContain('sttWakeAlpha(');
    expect(src).toContain('sttWakeSizeScale(');
  });

  it('every feature bit is now supported — the matrix carries no open fallbacks', () => {
    for (const feature of LAYER_FEATURES) {
      expect(
        maplibreLayerFeatures[feature].supported,
        `${feature} is still declared unsupported`,
      ).toBe(true);
    }
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

  it('(d) the probe proves the KIND reads a prop, not that a base collaborator stored it', () => {
    // `url`/`maxRequests` are base options: STTBaseLayer forwards them into the
    // STTArchive it constructs, which keeps `url` as an own property. If the
    // walk descended into that collaborator, EVERY kind would "prove" `url` —
    // and a future feature entry naming a base-forwarded prop would pass gate
    // (d) with nothing implemented behind it.
    for (const kind of [
      'point',
      'icon',
      'column',
      'arc',
      'tripHeads',
    ] as const) {
      expect(
        provesProp(kind, 'url', 'mem://__stt_probe__.stt'),
        `${kind} must not "prove" the base-forwarded url option`,
      ).toBe(false);
    }
    // The control: a prop a kind really does resolve still proves.
    expect(provesProp('icon', 'idProperty', '__stt_id__')).toBe(true);
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

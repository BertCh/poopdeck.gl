// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * Capability descriptor for the MapLibre GL backend — Phase 5 of
 * docs/roadmap/renderer-architecture.md.
 *
 * This is what the maplibre adapter DECLARES about itself against the shared
 * vocabulary in `@poopdeck.gl/core/capabilities`. It is machine-checked against
 * the package's real exports + a conformance evidence set (see
 * test/backend-descriptor.test.ts and `assertDescriptorConsistent`), so it
 * cannot over-claim: every `supported: true` kind, every `true` capability and
 * every declared time-filter mode must have a passing case behind it.
 *
 * The adapter ships FIFTEEN layer classes (point/line/polygon/trips/tripHeads/
 * heatmap/icon/column/arc, plus the Wave M4 summary + flow families:
 * h3Summary/quadbinSummary/hexbin/flowCorridor/flowStroke/flowmap). Every other
 * layer kind degrades to deck.gl (`@poopdeck.gl/layers`) except the ones that
 * have an honest in-backend approximation (see `FALLBACK_KINDS`). The adapter
 * interleaves into the
 * basemap's own GL context and projects lon/lat → world on the CPU. Host
 * dispatch (Wave M1) covers maplibre v3–v6 + mapbox v3: on v5+ hosts the layers
 * render via the injected projection prelude — including globe — while
 * ≤v4/mapbox hosts ride the legacy mercator matrix path. Tileset ownership
 * defaults to one archive per layer; an opt-in `SharedTilesetSource` serves N
 * layers from one archive.
 *
 * Wave M2 (D8–D11) landed the feature parity this file used to disclaim:
 * all four time-filter modes (`window`/`wake`/`cumulative`/`trail`, from the
 * shared kernel in `shaders/time-window.glsl.ts`), the GPU DataFilter, metric
 * (`'meters'`) point radii and line/trip widths, and id-FBO picking on every
 * kind that has feature identity. Heatmap is deliberately NOT pickable — a
 * density pixel is a sum of unbounded splats with no single feature behind it.
 *
 * Wave M3 added four native kinds — `icon` (atlas billboards + wake + CPU
 * motion glide), `column` (instanced prisms + the space-time-cube lift),
 * `arc` (a real 3D, optionally great-circle strip, retiring the arc→line
 * fallback) and `tripHeads` (the moving head dot, interpolated through the
 * hoisted core track kernel, D7) — plus progressive path reveal on the line
 * layer. That flips four of the six layer features and `timeAsHeight`.
 *
 * Wave M4 (P2) added the summary + flow families as SIX more native kinds:
 * `h3Summary`/`quadbinSummary` (summary-tier cell decode → ramp-coloured,
 * optionally extruded prisms; H3 boundaries come from an injected h3-js
 * `cellToBoundary`, since h3-js is not a dependency of this thin backend),
 * `hexbin` (a REAL runtime hexbin — CPU binning at tile upload plus a GPU
 * scatter/gather aggregate, NOT a fallback to h3Summary; the old
 * `hexbin -> h3Summary` referral is gone), and the flow family
 * `flowCorridor`/`flowStroke`/`flowmap` (ref-stable value-matrix ribbons and OD
 * arrows whose width breathes off a single per-frame scalar). `liveBundling`
 * (GPU KDEEB) STAYS a declared fallback — the flowmap layer carries no bundling
 * path (campaign P2). All six read the DataFilter; only the flow family carries
 * categorical colour, so `stableColorMapping` extends to it and not to the
 * value-/aggregate-coloured summary and hexbin kinds.
 */

import {
  LAYER_KINDS,
  type BackendDescriptor,
  type Capability,
  type LayerKind,
  type LayerKindSupport,
} from '@poopdeck.gl/core/capabilities';

/** The kinds the maplibre adapter actually renders (each backed by an exported class). */
const SUPPORTED_KINDS: readonly LayerKind[] = [
  'point',
  'line',
  'polygon',
  'trips',
  'heatmap',
  // Wave M3.
  'icon',
  'column',
  'arc',
  'tripHeads',
  // Wave M4 — summary + flow families.
  'h3Summary',
  'quadbinSummary',
  'hexbin',
  'flowCorridor',
  'flowStroke',
  'flowmap',
];

/** Why an unsupported kind degrades — a single, honest referral to the deck backend. */
const DECK_REFERRAL =
  'not implemented in the maplibre adapter; use @poopdeck.gl/layers (deck)';

/**
 * Kinds this backend cannot render but can honestly APPROXIMATE with one it
 * can: `degradeRequest` returns `{action:'fallback', toKind}` for these, so
 * every target MUST itself be in {@link SUPPORTED_KINDS} — a fallback naming
 * another unsupported kind hands the caller a second unrenderable answer
 * instead of the honest "skip, go to deck" its `reason` intends. Pinned by the
 * conformance gate. `mesh → boundingBox` was copied from the three descriptor,
 * where that target IS supported; here boundingBox is not, so mesh skips. The
 * `hexbin → h3Summary` referral three carries is GONE: Wave M4 shipped a real
 * runtime `hexbin` kind (it is in {@link SUPPORTED_KINDS}, not this table), so
 * there is nothing to degrade.
 *
 * Wave M3 moved `arc` OUT of this table (it is now a real kind) and moved
 * `text` IN: the fallback three declares (`text → icon`) was dangling here
 * while there was no icon layer, and now resolves to `STTIconLayer` — a
 * labelled feature degrades to its marker with no glyphs, which is a real
 * approximation rather than a second dead end.
 */
const FALLBACK_KINDS: Readonly<
  Partial<Record<LayerKind, { kind: LayerKind; lost: string }>>
> = {
  pointCloud: {
    kind: 'point',
    lost: 'per-point elevation — the cloud renders as flat billboards on the ground plane',
  },
  text: {
    kind: 'icon',
    // Same target the three backend names. The atlas caveat is part of the
    // `lost` string on purpose: STTIconLayer draws NOTHING without a caller-
    // supplied `iconAtlas` + `iconMapping` (it warns and bails), so promising
    // "the positions render" unconditionally would understate what the caller
    // has to bring — deck's IconLayer and @poopdeck.gl/three's icon layer carry
    // the same requirement.
    lost: 'the GLYPHS — a label renders as its marker sprite, and ONLY if the caller supplies iconAtlas + iconMapping (STTIconLayer draws nothing without them)',
  },
};

/**
 * Build the exhaustive `LayerKind → support` record from the frozen `LAYER_KINDS`
 * vocabulary, so a new kind added to core forces a decision here rather than
 * silently defaulting. Supported kinds are `{ supported: true }`; the
 * {@link FALLBACK_KINDS} entries degrade; everything else is an unsupported
 * deck referral with no fallback.
 */
const layerKinds = Object.fromEntries(
  LAYER_KINDS.map((kind): [LayerKind, LayerKindSupport] => {
    if (SUPPORTED_KINDS.includes(kind)) return [kind, { supported: true }];
    const fallback = FALLBACK_KINDS[kind];
    if (fallback) {
      // A degrading kind's `reason` names what the caller LOSES by taking the
      // approximation — the generic deck referral would tell them nothing about
      // whether the substitute is good enough for their map.
      return [
        kind,
        {
          supported: false,
          fallbackKind: fallback.kind,
          reason: `renders as ${fallback.kind}; lost: ${fallback.lost}. For the real kind use @poopdeck.gl/layers (deck)`,
        },
      ];
    }
    return [kind, { supported: false, reason: DECK_REFERRAL }];
  }),
) as Record<LayerKind, LayerKindSupport>;

export const maplibreBackend: BackendDescriptor = {
  id: 'maplibre',
  capabilities: {
    // Requires a v5+ maplibre host: the layers compile the host's injected
    // projection prelude (projectTile*/variantName program cache) so globe
    // and the globe↔mercator transition render natively. Legacy hosts
    // (maplibre ≤v4, mapbox v3) still render mercator via the uMatrix path.
    globe: true,
    // D11: every kind with feature identity implements `drawPickTile`, so
    // `STTBaseLayer.pick()` resolves a feature through the id FBO — the M4
    // summary/hexbin/flow kinds included (a cell / a corridor / an OD arrow is
    // the pick unit). Heatmap has no hook by design and reports
    // `supportsPicking() === false`.
    picking: true,
    extrude3d: true,
    // D10 + metric sizing: point `radiusUnits: 'meters'`, line/trips
    // `widthUnits: 'meters'`, and polygon `elevation` in metres — all resolved
    // per tile at its centre latitude (`lib/projection.ts`). Screen-space
    // approximation under pitch, documented on `metersToPixelsAtLatitude`.
    metricSizing: true,
    gpuHeatmap: true,
    // Wave M4 P2: PERMANENT declared fallback. `STTFlowmapLayer` renders
    // pre-baked bundles (a quadratic control point per OD pair) but carries no
    // GPU KDEEB path — porting the bundler off luma transform-feedback is
    // counted out (campaign §4). Never flip this without a real bundling pass.
    liveBundling: false,
    // Wave M3: `STTColumnLayer.timeHeightScale` lifts every vertex of a feature
    // by `(startTime - timeHeightOrigin) * scale` METRES through the same D10
    // elevation path the prisms use — a real space-time cube, not a proxy.
    // Kept in lockstep with `maplibreLayerFeatures.timeHeightScale` by the
    // conformance gate: the two claims are the same claim.
    timeAsHeight: true,
    interleavedBasemap: true,
    userExtensions: false,
    cameraRoll: false,
  } satisfies Record<Capability, boolean>,
  // D8: all four modes ship as independent kernel snippets, selected at
  // program-build time. point/line/polygon/heatmap/icon/column/arc and the M4
  // summary (h3Summary/quadbinSummary), hexbin and flow (flowCorridor/
  // flowStroke/flowmap) kinds compile any of the four; trips compiles trail +
  // wake (window/cumulative are meaningless for a per-vertex swept path, the
  // same cut deck's AnimatedTripsLayer makes) and tripHeads compiles window +
  // wake (cumulative/trail describe a HISTORY, which is what the trips ribbon
  // already draws).
  timeFilterModes: ['window', 'wake', 'cumulative', 'trail'],
  layerKinds,
  projectsOnCpu: true,
  // DEFAULT ownership. An opt-in shared source (D6a `SharedTilesetSource`,
  // layer option `source`) serves N layers from one archive; this field
  // flips only if/when shared becomes the default path.
  tilesetOwnership: 'per-layer',
  // Synchronous on-demand readback of a 1×1 texel from an offscreen id buffer
  // (`STTBaseLayer.pick`), not deck's persistent GPU id pass.
  pickMechanism: 'id-fbo',
  interleavedBasemap: true,
  // What a ≤v4 host drives; v5+ hosts may present globe (see capabilities.globe).
  basemapProjection: 'mercator',
};

/* ──────────────────────────────────────────────────────────────────────────
 * Layer-feature matrix (D9) — mirrors `deckLayerFeatures` in
 * `@poopdeck.gl/layers` and `threeLayerFeatures` in `@poopdeck.gl/three`.
 *
 * The LayerKind / Capability axes above prove a whole layer class exists. The
 * kind-parity campaign added finer per-layer PROP FAMILIES that don't map onto
 * a single cross-cutting Capability, so they get this frozen vocabulary. A
 * backend either implements a feature or must record how it degrades; the
 * paired conformance gate (test/backend-descriptor.test.ts block (d)) proves
 * every `supported: true` claim by CONSTRUCTING the real exported layer class
 * with the named prop and checking the class absorbed it — so a prop that was
 * renamed, dropped, or never read fails the gate.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The per-layer prop families a backend either implements or degrades. Frozen
 * `as const`, and byte-identical to the deck/three vocabulary — but redeclared
 * LOCALLY, exactly as `@poopdeck.gl/three` does, because this package
 * deliberately does not depend on `@poopdeck.gl/layers`. Nothing imports across
 * packages, so renaming a token here is NOT a cross-backend `tsc` break: the
 * per-package conformance gate only asserts exhaustiveness against this list.
 * Keeping the three lists identical is a review obligation, not a type one.
 */
export const LAYER_FEATURES = [
  'motionInterpolation',
  'iconWake',
  'dataFilter',
  'timeHeightScale',
  'stableColorMapping',
  'pathReveal',
] as const;
export type LayerFeature = (typeof LAYER_FEATURES)[number];

/** See `@poopdeck.gl/layers` `LayerFeatureSupport`; kept structurally identical. */
export type LayerFeatureSupport =
  | {
      supported: true;
      /** Layer kinds this feature covers; each must itself be a supported kind. */
      kinds: readonly LayerKind[];
      /** Canonical layer-option key present on every covered layer class. */
      prop: string;
      summary: string;
    }
  | {
      supported: false;
      kinds: readonly LayerKind[];
      /** How the backend degrades (what the caller sees instead). */
      fallback: string;
      reason: string;
    };

/**
 * What the maplibre adapter implements after Wave M3. All six are now real; the
 * gate in test/backend-descriptor.test.ts block (d) proves each `prop` against
 * the REAL exported class for every kind the claim names, so a claim can never
 * outrun the code.
 *
 * `kinds` is deliberately the set the feature ACTUALLY covers here, not deck's
 * set: deck glides points too and reveals a dedicated `path` kind, and this
 * backend does neither — declaring those would be an over-claim the gate would
 * (correctly) reject.
 */
export const maplibreLayerFeatures: Readonly<
  Record<LayerFeature, LayerFeatureSupport>
> = {
  motionInterpolation: {
    supported: true,
    // `point` is deck's third kind here and is deliberately absent:
    // STTPointLayer draws the discrete window, with no id-pooled glide path.
    kinds: ['icon', 'tripHeads'],
    // The one option BOTH interpolating layers share. Icon's glide is opt-in
    // (`interpolate` + `idProperty`, deck's gate); tripHeads interpolates
    // unconditionally because a head with no interpolation is just a vertex.
    // `maxInterpolationGap` is the knob common to both, so it is the key the
    // (d) gate can prove on every covered class — and a boolean `interpolate`
    // is unprovable by a differential value probe anyway.
    prop: 'maxInterpolationGap',
    summary:
      'CPU per-entity glide through the hoisted core track kernel (@poopdeck.gl/core `TrackIndexMaintainer`/`sampleTrack`, D7): icon pools resident tiles by idProperty and draws ONE interpolated pose per entity (interpolate/idProperty/maxInterpolationGap/reducedMotion), tripHeads interpolates each trip polyline to the playhead; maxInterpolationGap HOLDS the last sample instead of fabricating motion across a data hole',
  },
  iconWake: {
    supported: true,
    kinds: ['icon'],
    prop: 'wakeLength',
    summary:
      'trailing alpha wake behind moving icons (wakeLength/wakeTailScale) from the shared shaders/time-window.glsl.ts kernel, with the tail shrinking via sttWakeSizeScale',
  },
  dataFilter: {
    supported: true,
    // Every supported kind reads `filterProperty` (the Wave M4 summary + flow
    // families each compile the same shared DataFilter kernel). On the summary
    // and hexbin kinds `filterTransformSize` is inert — a cell's extent is
    // geography — but the range gate is honoured (a hexbin filters the raw
    // points that reach the aggregate).
    kinds: [
      'point',
      'line',
      'polygon',
      'trips',
      'heatmap',
      'icon',
      'column',
      'arc',
      'tripHeads',
      'h3Summary',
      'quadbinSummary',
      'hexbin',
      'flowCorridor',
      'flowStroke',
      'flowmap',
    ],
    prop: 'filterProperty',
    summary:
      'GPU range filter over a numeric column, deck DataFilterExtension parity (filterProperty/filterRange/filterSoftRange/filterEnabled/filterTransformSize/filterTransformColor); the branch compiles in only when filterProperty is set, and a tile missing the column renders UNFILTERED. DEGRADE: on `icon` the filter covers the DISCRETE path only — with motionInterpolation active (`interpolate` + `idProperty`) the glide program compiles no filter kernel and the CPU track pool carries no filter column, so every entity renders regardless of filterRange (deck AnimatedIconLayer degrades identically; STTIconLayer warns once). On `h3Summary`/`quadbinSummary`/`hexbin` filterTransformSize is inert (a cell has geographic extent, not a data-driven size)',
  },
  timeHeightScale: {
    supported: true,
    // deck also lifts polygons; STTPolygonLayer extrudes but has no time lift,
    // so the claim stops at the column kind.
    kinds: ['column'],
    prop: 'timeHeightScale',
    summary:
      'space-time-cube vertical lift by feature time — every vertex rises (startTime - timeHeightOrigin) * timeHeightScale METRES through the D10 latitude-correct elevation path; timeHeightOrigin anchors altitude 0 and reducedMotion forces the lift to 0',
  },
  stableColorMapping: {
    supported: true,
    // Every kind with a categorical colour. The deliberate exclusions all lack
    // a category: heatmap (a density pixel), and the Wave M4 summary + hexbin
    // kinds (coloured by a VALUE ramp / aggregate, not a category). The flow
    // family DOES carry a per-feature category (`colorProperty` +
    // `colorMapping`), so it is included.
    kinds: [
      'point',
      'line',
      'polygon',
      'trips',
      'icon',
      'column',
      'arc',
      'tripHeads',
      'flowCorridor',
      'flowStroke',
      'flowmap',
    ],
    prop: 'colorMapping',
    summary:
      'category-STRING → RGBA map applied CPU-side per tile (colorMapping/colorMappingDefault), so a category keeps one colour across tiles regardless of per-tile dictionary order. The flow family (flowCorridor/flowStroke via colorProperty, flowmap via colorMode: category) resolves it the same way; the summary and hexbin kinds are excluded — they colour by a value ramp / aggregate, which has no category',
  },
  pathReveal: {
    supported: true,
    // deck spells this on its `path` kind; this backend has no separate path
    // kind, so the reveal lives on the LINE layer and the claim names `line`.
    // A feature may only cover kinds the backend renders — naming 'path' here
    // would fail gate (d).
    kinds: ['line'],
    prop: 'revealTrail',
    summary:
      "progressive path reveal with a partially-drawn frontier segment (revealTrail/revealDuration/fadeTrail/reducedMotion): per-VERTEX times come from the tile's vertexTimestamps or the shared cumulative-distance kernel, the frontier endpoint is INTERPOLATED rather than popped, and unrevealed geometry is unpickable",
  },
};

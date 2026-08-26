// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * Capability descriptor for the MapLibre GL backend — see
 * docs/roadmap/renderer-architecture.md.
 *
 * This is what the maplibre adapter DECLARES about itself against the shared
 * vocabulary in `@poopdeck.gl/core/capabilities`. It is machine-checked against
 * the package's real exports + a conformance evidence set (see
 * test/backend-descriptor.test.ts and `assertDescriptorConsistent`), so it
 * cannot over-claim: every `supported: true` kind, every `true` capability and
 * every declared time-filter mode must have a passing case behind it.
 *
 * The adapter ships FIFTEEN layer classes: point/line/polygon/trips/tripHeads/
 * heatmap/icon/column/arc, plus the summary + flow families
 * (h3Summary/quadbinSummary/hexbin/flowCorridor/flowStroke/flowmap). Every
 * other layer kind degrades to deck.gl (`@poopdeck.gl/layers`) except the ones
 * that have an honest in-backend approximation (see `FALLBACK_KINDS`). The
 * adapter interleaves into the basemap's own GL context and projects
 * lon/lat → world on the CPU. Host dispatch covers maplibre v3–v6 + mapbox v3:
 * on v5+ hosts the layers render via the injected projection prelude —
 * including globe — while ≤v4/mapbox hosts ride the legacy mercator matrix
 * path. Tileset ownership defaults to one archive per layer; an opt-in
 * `SharedTilesetSource` serves N layers from one archive.
 *
 * Feature coverage is uniform across those kinds: all four time-filter modes
 * (`window`/`wake`/`cumulative`/`trail`, from the shared kernel in
 * `shaders/time-window.glsl.ts`), the GPU DataFilter, metric (`'meters'`) point
 * radii and line/trip widths, and id-FBO picking on every kind that has feature
 * identity. Heatmap is deliberately NOT pickable — a density pixel is a sum of
 * unbounded splats with no single feature behind it.
 *
 * `icon` draws atlas billboards + wake + CPU motion glide; `column` instanced
 * prisms plus the space-time-cube lift; `arc` a real 3D, optionally
 * great-circle strip; `tripHeads` the moving head dot, interpolated through the
 * core track kernel. Progressive path reveal lives on the line layer.
 *
 * `h3Summary`/`quadbinSummary` decode summary-tier cells into ramp-coloured,
 * optionally extruded prisms; H3 boundaries come from an injected h3-js
 * `cellToBoundary`, since h3-js is not a dependency of this thin backend.
 * `hexbin` is a REAL runtime hexbin — CPU binning at tile upload plus a GPU
 * scatter/gather aggregate, not a referral to h3Summary. The flow family
 * `flowCorridor`/`flowStroke`/`flowmap` draws ref-stable value-matrix ribbons
 * and OD arrows whose width breathes off a single per-frame scalar;
 * `liveBundling` (GPU KDEEB) is a declared fallback, since the flowmap layer
 * carries no bundling path. All six read the DataFilter; only the flow family
 * carries categorical colour, so `stableColorMapping` extends to it and not to
 * the value-/aggregate-coloured summary and hexbin kinds.
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
  // `path` was never a capability gap here, only a NAMING one: STTLineLayer
  // already walked startIndices per feature, emitted one quad per vertex PAIR
  // and carried deck AnimatedPathLayer's whole reveal surface — the descriptor
  // simultaneously said `path: unsupported` and claimed `pathReveal` on `line`.
  // STTPathLayer gives the kind its name and its deck-parity defaults, and
  // closes the one real gap (sizing tile SELECTION against the reveal history,
  // not against timeWindow alone).
  'path',
  'polygon',
  'trips',
  'heatmap',
  'icon',
  'column',
  'arc',
  'tripHeads',
  // Summary + flow families.
  'h3Summary',
  'quadbinSummary',
  'hexbin',
  'flowCorridor',
  'flowStroke',
  'flowmap',
  // The 2026-08-26 completion pass — maplibre now renders every frozen kind.
  'isoLines',
  'pointCloud',
  'text',
  'boundingBox',
  'mesh',
  'ego',
  'surfel',
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
 * conformance gate.
 *
 * This table deliberately diverges from the three backend's. `mesh →
 * boundingBox` is absent because boundingBox is NOT supported here, so mesh
 * skips to deck. `hexbin → h3Summary` is absent because `hexbin` is a real kind
 * here (it lives in {@link SUPPORTED_KINDS}), so there is nothing to degrade.
 * `text → icon` resolves to `STTIconLayer`: a labelled feature degrades to its
 * marker with no glyphs, which is a real approximation rather than a second
 * dead end.
 */
const FALLBACK_KINDS: Readonly<
  Partial<Record<LayerKind, { kind: LayerKind; lost: string }>>
> = {};

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
    // Every kind with feature identity implements `drawPickTile`, so
    // `STTBaseLayer.pick()` resolves a feature through the id FBO — summary,
    // hexbin and flow kinds included (a cell / a corridor / an OD arrow is the
    // pick unit). Heatmap has no hook by design and reports
    // `supportsPicking() === false`.
    picking: true,
    extrude3d: true,
    // Point `radiusUnits: 'meters'`, line/trips `widthUnits: 'meters'`, and
    // polygon `elevation` in metres — all resolved per tile at its centre
    // latitude (`lib/projection.ts`). Screen-space approximation under pitch,
    // documented on `metersToPixelsAtLatitude`.
    metricSizing: true,
    gpuHeatmap: true,
    // PERMANENT declared fallback. `STTFlowmapLayer` renders pre-baked bundles
    // (a quadratic control point per OD pair) but carries no GPU KDEEB path;
    // the bundler cannot be ported off luma transform-feedback without a real
    // compute pass here. Never flip this without one.
    // KDEEB edge bundling, real and at runtime, through core's shared
    // `bundleEdges` — the same function three and cesium run, so the three
    // backends cannot drift. ZERO luma: the packing and the ribbon draw are raw
    // WebGL2 like every other layer here. Device-gated with a per-tile fallback
    // to straight arrows.
    liveBundling: true,
    // `STTColumnLayer.timeHeightScale` lifts every vertex of a feature by
    // `(startTime - timeHeightOrigin) * scale` METRES through the same
    // latitude-correct elevation path the prisms use — a real space-time cube,
    // not a proxy. Kept in lockstep with
    // `maplibreLayerFeatures.timeHeightScale` by the conformance gate: the two
    // claims are the same claim.
    timeAsHeight: true,
    interleavedBasemap: true,
    // A real GLSL chunk-injection surface (`shaders/extensions.glsl.ts`): user
    // snippets spliced at named vertex/fragment seams, per-draw uniforms and an
    // extension-owned attribute buffer, carried by `STTPointLayer`. Three things
    // make the claim safe rather than decorative, and all three are pinned by
    // mutation-verified tests: the extension's CONTENT-ADDRESSED digest is in the
    // program-cache key (so two layers with different extensions cannot silently
    // share one linked program), the id/pick program gets the SAME vertex seams
    // (so a geometry-moving extension cannot desync the hit box from the drawn
    // shape), and the shipped time/DataFilter gates compose AFTER the user's
    // alpha (so an extension can only narrow visibility, never widen it). An
    // empty list produces byte-identical source.
    userExtensions: true,
    // `lib/view-state.ts` round-trips the shared `ViewState.roll` through the
    // HOST camera rather than dropping it. Roll reaches the shaders for free (it
    // is inside the view matrix, and inside the injected projection prelude on a
    // v5+ host), so no layer had to change — what was missing was the SEAM, and
    // that is what this flag claims. `maplibre-gl` gained roll in v5 and the
    // peer range is `^3 || ^4 || ^5 || ^6`, so support is detected
    // STRUCTURALLY (`typeof map.getRoll === 'function'`), never by naming a
    // v5-only surface in a type position; a ≤v4 host degrades honestly —
    // `applyViewState` REPORTS the dropped roll and `readViewState` omits the
    // key rather than reporting a fabricated 0.
    cameraRoll: true,
  } satisfies Record<Capability, boolean>,
  // All four modes ship as independent kernel snippets, selected at
  // program-build time. point/line/polygon/heatmap/icon/column/arc and the
  // summary (h3Summary/quadbinSummary), hexbin and flow (flowCorridor/
  // flowStroke/flowmap) kinds compile any of the four; trips compiles trail +
  // wake (window/cumulative are meaningless for a per-vertex swept path, the
  // same cut deck's AnimatedTripsLayer makes) and tripHeads compiles window +
  // wake (cumulative/trail describe a HISTORY, which is what the trips ribbon
  // already draws).
  timeFilterModes: ['window', 'wake', 'cumulative', 'trail'],
  layerKinds,
  projectsOnCpu: true,
  // DEFAULT ownership. An opt-in shared source (`SharedTilesetSource`, layer
  // option `source`) serves N layers from one archive; this field flips only
  // if/when shared becomes the default path.
  tilesetOwnership: 'per-layer',
  // Synchronous on-demand readback of a 1×1 texel from an offscreen id buffer
  // (`STTBaseLayer.pick`), not deck's persistent GPU id pass.
  pickMechanism: 'id-fbo',
  interleavedBasemap: true,
  // What a ≤v4 host drives; v5+ hosts may present globe (see capabilities.globe).
  basemapProjection: 'mercator',
};

/* ──────────────────────────────────────────────────────────────────────────
 * Layer-feature matrix — mirrors `deckLayerFeatures` in
 * `@poopdeck.gl/layers` and `threeLayerFeatures` in `@poopdeck.gl/three`.
 *
 * The LayerKind / Capability axes above prove a whole layer class exists. This
 * axis is finer: per-layer PROP FAMILIES that don't map onto a single
 * cross-cutting Capability, so they get their own frozen vocabulary. A
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
 * What the maplibre adapter implements. All six features are real; the gate in
 * test/backend-descriptor.test.ts block (d) proves each `prop` against the REAL
 * exported class for every kind the claim names, so a claim can never outrun
 * the code.
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
    // Every supported kind reads `filterProperty` (the summary + flow families
    // each compile the same shared DataFilter kernel). On the summary
    // and hexbin kinds `filterTransformSize` is inert — a cell's extent is
    // geography — but the range gate is honoured (a hexbin filters the raw
    // points that reach the aggregate).
    kinds: [
      'point',
      'line',
      'path',
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
      'isoLines',
      'pointCloud',
      'text',
      'boundingBox',
      'mesh',
      'ego',
      'surfel',
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
    // a category: heatmap (a density pixel), and the summary + hexbin kinds
    // (coloured by a VALUE ramp / aggregate, not a category). The flow
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
    // deck spells this on its `path` kind. This backend now has one too
    // (STTPathLayer), and because that class is a subclass of the line renderer
    // rather than a fork, the reveal really is available on BOTH kinds — so the
    // claim names both. (The 0.5.x note here read "this backend has no separate
    // path kind, so the reveal lives on the LINE layer"; that was the honest
    // description of a descriptor that claimed pathReveal while denying the
    // path kind, and the parity campaign resolved it by adding the kind.)
    kinds: ['line', 'path'],
    prop: 'revealTrail',
    summary:
      "progressive path reveal with a partially-drawn frontier segment (revealTrail/revealDuration/fadeTrail/reducedMotion): per-VERTEX times come from the tile's vertexTimestamps or the shared cumulative-distance kernel, the frontier endpoint is INTERPOLATED rather than popped, and unrevealed geometry is unpickable",
  },
};

// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * Capability descriptor for the MapLibre GL backend — Phase 5 of
 * docs/roadmap/renderer-abstraction-2026-06.md.
 *
 * This is what the maplibre adapter DECLARES about itself against the shared
 * vocabulary in `@poopdeck.gl/core/capabilities`. It is machine-checked against
 * the package's real exports + a conformance evidence set (see
 * test/backend-descriptor.test.ts and `assertDescriptorConsistent`), so it
 * cannot over-claim: every `supported: true` kind, every `true` capability and
 * every declared time-filter mode must have a passing case behind it.
 *
 * The adapter ships five layer classes (point/line/polygon/trips/heatmap). Every
 * other layer kind degrades to deck.gl (`@poopdeck.gl/layers`) except the two
 * that have an honest in-backend approximation (see `FALLBACK_KINDS`). The
 * adapter interleaves into the basemap's own GL context and
 * projects lon/lat → world on the CPU. Host dispatch (Wave M1) covers maplibre
 * v3–v6 + mapbox v3: on v5+ hosts the layers render via the injected
 * projection prelude — including globe — while ≤v4/mapbox hosts ride the
 * legacy mercator matrix path. Tileset ownership defaults to one archive per
 * layer; an opt-in `SharedTilesetSource` serves N layers from one archive.
 *
 * Wave M2 (D8–D11) landed the feature parity this file used to disclaim:
 * all four time-filter modes (`window`/`wake`/`cumulative`/`trail`, from the
 * shared kernel in `shaders/time-window.glsl.ts`), the GPU DataFilter, metric
 * (`'meters'`) point radii and line/trip widths, and id-FBO picking on every
 * kind that has feature identity. Heatmap is deliberately NOT pickable — a
 * density pixel is a sum of unbounded splats with no single feature behind it.
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
 * conformance gate. `text → icon`, `mesh → boundingBox` and `hexbin →
 * h3Summary` were copied from the three descriptor, where those targets ARE
 * supported; here they are not, so those kinds skip.
 */
const FALLBACK_KINDS: Readonly<Partial<Record<LayerKind, LayerKind>>> = {
  // An arc is naturally a line in a backend without arc geometry.
  arc: 'line',
  // A point cloud degrades to flat points (no per-point z here).
  pointCloud: 'point',
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
    const fallbackKind = FALLBACK_KINDS[kind];
    if (fallbackKind) {
      return [kind, { supported: false, fallbackKind, reason: DECK_REFERRAL }];
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
    // D11: point/line/polygon/trips each implement `drawPickTile`, so
    // `STTBaseLayer.pick()` resolves a feature through the id FBO. Heatmap has
    // no hook by design and reports `supportsPicking() === false`.
    picking: true,
    extrude3d: true,
    // D10 + metric sizing: point `radiusUnits: 'meters'`, line/trips
    // `widthUnits: 'meters'`, and polygon `elevation` in metres — all resolved
    // per tile at its centre latitude (`lib/projection.ts`). Screen-space
    // approximation under pitch, documented on `metersToPixelsAtLatitude`.
    metricSizing: true,
    gpuHeatmap: true,
    liveBundling: false,
    timeAsHeight: false,
    interleavedBasemap: true,
    userExtensions: false,
    cameraRoll: false,
  } satisfies Record<Capability, boolean>,
  // D8: all four modes ship as independent kernel snippets, selected at
  // program-build time. point/line/polygon/heatmap compile any of the four;
  // trips compiles trail + wake (window/cumulative are meaningless for a
  // per-vertex swept path, the same cut deck's AnimatedTripsLayer makes).
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
 * What the maplibre adapter implements after Wave M2. Two of the six are real
 * (`dataFilter`, `stableColorMapping`); the other four need layer kinds this
 * backend does not render yet (icon, column, path) or a CPU kernel that has not
 * been hoisted out of the deck package (D7) — each records its degrade path
 * rather than silently no-op'ing.
 */
export const maplibreLayerFeatures: Readonly<
  Record<LayerFeature, LayerFeatureSupport>
> = {
  motionInterpolation: {
    supported: false,
    kinds: ['point', 'icon'],
    fallback:
      'per-tile window sampling — markers jump between tiles instead of gliding',
    reason:
      'needs the CPU glide kernel (packages/layers/src/lib/track-kernel.ts), which is hoisted to core in Wave M3 (D7)',
  },
  iconWake: {
    supported: false,
    kinds: ['icon'],
    fallback: 'no icon layer at all — falls back to the deck backend',
    reason:
      'the icon kind itself is unimplemented here (Wave M3); the generic wake alpha exists in shaders/time-window.glsl.ts and is already wired on point/line/polygon/trips/heatmap',
  },
  dataFilter: {
    supported: true,
    kinds: ['point', 'line', 'polygon', 'trips', 'heatmap'],
    prop: 'filterProperty',
    summary:
      'GPU range filter over a numeric column, deck DataFilterExtension parity (filterProperty/filterRange/filterSoftRange/filterEnabled/filterTransformSize/filterTransformColor); the branch compiles in only when filterProperty is set, and a tile missing the column renders UNFILTERED',
  },
  timeHeightScale: {
    supported: false,
    kinds: ['column', 'polygon'],
    fallback: 'flat geometry (no space-time-cube lift)',
    reason:
      'time-as-height is unimplemented — see capabilities.timeAsHeight=false; the D10 elevation fix is the prerequisite and landed in Wave M2',
  },
  stableColorMapping: {
    supported: true,
    kinds: ['point', 'line', 'polygon', 'trips'],
    prop: 'colorMapping',
    summary:
      'category-STRING → RGBA map applied CPU-side per tile (colorMapping/colorMappingDefault), so a category keeps one colour across tiles regardless of per-tile dictionary order',
  },
  pathReveal: {
    supported: false,
    kinds: ['path'],
    fallback:
      "STTLineLayer's trail mode reveals per-VERTEX along a path, but without the revealTrail/revealDuration prop surface",
    reason:
      'the dedicated path kind (joins, dashes, revealTrail/revealDuration) is Wave M3',
  },
};

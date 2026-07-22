// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * The deck.gl backend's capability descriptor — what this renderer DECLARES
 * about itself against the shared contract in `@poopdeck.gl/core/capabilities`
 * (see docs/roadmap/renderer-abstraction-2026-06.md §4.3 tier 5, Phase 5).
 *
 * This is the retro-documentation of reality: deck is the reference backend —
 * full catalog coverage, GPU id-buffer picking, all four linear time-filter
 * modes, and interleaving directly into the basemap's GL context. The paired
 * structural conformance gate (`test/backend-descriptor.test.ts`) refuses to let
 * this descriptor claim a layer kind whose class is not actually exported from
 * the package index, so `assertDescriptorConsistent` cannot silently drift.
 */

import {
  LAYER_KINDS,
  type BackendDescriptor,
  type LayerKind,
  type LayerKindSupport,
} from '@poopdeck.gl/core/capabilities';

/**
 * Every {@link LayerKind}, enumerated once. `satisfies Record<LayerKind, …>`
 * turns a MISSING kind into a `tsc` error, so this table cannot silently fall
 * out of date with the frozen vocabulary. Each `supported: true` entry is
 * proven by a real export in `./index` (checked by the conformance test).
 */
const layerKinds = {
  point: { supported: true }, // AnimatedPointLayer
  path: { supported: true }, // AnimatedPathLayer
  polygon: { supported: true }, // AnimatedPolygonLayer
  arc: { supported: true }, // AnimatedArcLayer
  line: { supported: true }, // AnimatedLineLayer
  icon: { supported: true }, // AnimatedIconLayer
  column: { supported: true }, // AnimatedColumnLayer
  trips: { supported: true }, // AnimatedTripsLayer
  tripHeads: { supported: true }, // AnimatedTripHeadsLayer
  boundingBox: { supported: true }, // AnimatedBoundingBoxLayer
  surfel: { supported: true }, // SplatLayer
  heatmap: { supported: true }, // AnimatedHeatmapLayer
  h3Summary: { supported: true }, // H3SummaryLayer
  quadbinSummary: { supported: true }, // QuadbinSummaryLayer
  flowmap: { supported: true }, // FlowmapLayer
  flowCorridor: { supported: true }, // FlowCorridorLayer
  flowStroke: { supported: true }, // FlowStrokeLayer
  isoLines: {
    supported: false,
    fallbackKind: 'path',
    reason:
      'rendered via AnimatedPathLayer density mode; no dedicated iso layer',
  },
  ego: {
    supported: false,
    reason: 'no dedicated ego layer; AV cockpit composes point/icon layers',
  },
  text: { supported: true }, // AnimatedTextLayer
  mesh: { supported: true }, // AnimatedMeshLayer
  pointCloud: { supported: true }, // AnimatedPointCloudLayer
  hexbin: { supported: true }, // AnimatedHexagonLayer
} satisfies Record<LayerKind, LayerKindSupport>;

// Belt-and-suspenders honesty: iterate the runtime vocabulary so that even an
// `as`-cast that loosened the type above cannot smuggle in a gap. Runs once at
// module load and is provably a no-op given the `satisfies` check above.
for (const kind of LAYER_KINDS) {
  if (!(kind in layerKinds)) {
    throw new Error(
      `deckBackend.layerKinds is missing an entry for LayerKind "${kind}"`,
    );
  }
}

/**
 * The deck.gl backend descriptor. Typed as {@link BackendDescriptor}, so every
 * {@link Capability} and {@link LayerKind} key is `tsc`-enforced to be present.
 */
export const deckBackend: BackendDescriptor = {
  id: 'deck',
  capabilities: {
    globe: true,
    picking: true,
    extrude3d: true,
    metricSizing: true,
    gpuHeatmap: true,
    liveBundling: true,
    timeAsHeight: true,
    interleavedBasemap: true,
    userExtensions: true,
    cameraRoll: false,
  },
  timeFilterModes: ['window', 'wake', 'cumulative', 'trail'],
  layerKinds,
  projectsOnCpu: false,
  tilesetOwnership: 'shared',
  pickMechanism: 'gpu-id',
  interleavedBasemap: true,
  basemapProjection: 'mercator',
};

/* ──────────────────────────────────────────────────────────────────────────
 * Layer-feature matrix (2026-07 kind-parity campaign)
 *
 * Beyond the coarse LayerKind / Capability axes, the campaign added per-layer
 * PROP FAMILIES (glide interpolation, icon wake, GPU DataFilter, space-time
 * height, stable categorical colour, progressive path reveal). Those are finer
 * than a whole layer kind and don't map onto a single cross-cutting Capability,
 * so they get their own frozen vocabulary here — declared alongside the
 * descriptor (not inside the core `BackendDescriptor` shape, which is owned by
 * `@poopdeck.gl/core`). A backend either implements a feature or must degrade;
 * the paired conformance gate proves every deck claim against the real
 * `static defaultProps` of the backing layer class, so this table cannot drift.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The per-layer prop families a backend either implements or degrades. Frozen
 * `as const` (same idiom as {@link LAYER_KINDS}): renaming a token is a `tsc`
 * break everywhere the feature is declared.
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

/**
 * Whether a backend implements a {@link LayerFeature}, over which layer kinds,
 * and — when it does — the single canonical `defaultProps` key that proves it
 * (the conformance gate asserts `prop in LayerClass.defaultProps`). When a
 * backend does NOT implement it, a deliberate typed `fallback` + `reason`
 * records how it degrades instead of silently no-op'ing.
 */
export type LayerFeatureSupport =
  | {
      supported: true;
      /** Layer kinds this feature covers; each must itself be a supported kind. */
      kinds: readonly LayerKind[];
      /** Canonical `defaultProps` key present on every covered layer class. */
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
 * deck is the reference backend: it implements every campaign feature. Each
 * entry names the exact `defaultProps` key the conformance test proves against
 * the real exported layer class, so a dropped/renamed prop fails the gate.
 */
export const deckLayerFeatures: Readonly<
  Record<LayerFeature, LayerFeatureSupport>
> = {
  motionInterpolation: {
    supported: true,
    kinds: ['point', 'icon'],
    prop: 'interpolate',
    summary:
      'CPU per-entity glide across tile seams (interpolate/idProperty/maxInterpolationGap)',
  },
  iconWake: {
    supported: true,
    kinds: ['icon'],
    prop: 'wakeLength',
    summary:
      'trailing alpha wake behind moving icons (wakeLength/wakeTailScale)',
  },
  dataFilter: {
    supported: true,
    kinds: ['arc', 'line', 'trips', 'column', 'polygon', 'icon'],
    prop: 'filterProperty',
    summary:
      'GPU DataFilterExtension range filter (filterProperty/filterRange/filterSoftRange/filterEnabled)',
  },
  timeHeightScale: {
    supported: true,
    kinds: ['column', 'polygon'],
    prop: 'timeHeightScale',
    summary: 'space-time-cube vertical lift by feature time',
  },
  stableColorMapping: {
    supported: true,
    kinds: ['arc', 'line', 'column', 'icon'],
    prop: 'colorMapping',
    summary:
      'stable per-category colour map across tiles (colorMapping/colorMappingDefault)',
  },
  pathReveal: {
    supported: true,
    kinds: ['path'],
    prop: 'revealTrail',
    summary:
      'progressive draw-on reveal along a path (revealTrail/revealDuration/fadeTrail)',
  },
};

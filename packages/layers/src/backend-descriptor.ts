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
    reason: 'rendered via AnimatedPathLayer density mode; no dedicated iso layer',
  },
  ego: {
    supported: false,
    reason: 'no dedicated ego layer; AV cockpit composes point/icon layers',
  },
} satisfies Record<LayerKind, LayerKindSupport>;

// Belt-and-suspenders honesty: iterate the runtime vocabulary so that even an
// `as`-cast that loosened the type above cannot smuggle in a gap. Runs once at
// module load and is provably a no-op given the `satisfies` check above.
for (const kind of LAYER_KINDS) {
  if (!(kind in layerKinds)) {
    throw new Error(`deckBackend.layerKinds is missing an entry for LayerKind "${kind}"`);
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

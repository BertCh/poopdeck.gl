// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * The `@poopdeck.gl/three` backend's self-declaration against the shared
 * `@poopdeck.gl/core/capabilities` contract — Phase 5 of
 * docs/roadmap/renderer-abstraction-2026-06.md. This is a *retro-documenting*
 * descriptor: it records what the three backend (Three.js + TSL on WebGPU,
 * WebGL2 fallback) actually ships today, and the structural conformance gate in
 * `test/backend-descriptor.test.ts` proves every claim against the real
 * `src/index.ts` exports via `assertDescriptorConsistent`.
 *
 * Divergences from the deck backend, all deliberate (see §1.2 of the roadmap):
 *  - CPU projection (LocalEnu / Mercator / Globe), so `projectsOnCpu: true`.
 *  - TSL compiles only on `WebGPURenderer`, so the basemap is a camera-synced
 *    overlay canvas (`interleavedBasemap: false`), NOT interleaved into a shared
 *    GL context.
 *  - Picking is CPU ray-OBB today (`GpuPicker` exists but is not the wired
 *    mechanism), so `pickMechanism: 'cpu-ray'`.
 *  - GPU heatmap + live edge-bundling are deferred; user `LayerExtension`-style
 *    hooks, time-as-height, and camera roll are not implemented → those caps are
 *    `false` and the two affected layer kinds declare typed fallbacks.
 */

import {
  LAYER_KINDS,
  type BackendDescriptor,
  type LayerKind,
  type LayerKindSupport,
} from '@poopdeck.gl/core/capabilities';

/**
 * The layer kinds three does NOT render natively, each with the concrete kind a
 * caller should fall back to. Every other kind in `LAYER_KINDS` is supported and
 * backed by a real `src/index.ts` export (verified by the conformance test).
 */
const UNSUPPORTED_KINDS: Partial<Record<LayerKind, LayerKindSupport>> = {
  heatmap: {
    supported: false,
    fallbackKind: 'point',
    reason: 'GPU heatmap deferred in three; use point density',
  },
  flowStroke: {
    supported: false,
    fallbackKind: 'flowCorridor',
    reason: 'no FlowStrokeLayer in three; use FlowCorridorLayer',
  },
};

/**
 * Build the exhaustive `Record<LayerKind, LayerKindSupport>` from the frozen
 * `LAYER_KINDS` vocabulary so a newly-added kind is a compile break here (missing
 * key) rather than a silently-absent declaration.
 */
const layerKinds = Object.fromEntries(
  LAYER_KINDS.map((kind) => [kind, UNSUPPORTED_KINDS[kind] ?? { supported: true }]),
) as Record<LayerKind, LayerKindSupport>;

export const threeBackend: BackendDescriptor = {
  id: 'three',
  capabilities: {
    globe: true,
    picking: true,
    extrude3d: true,
    metricSizing: true,
    gpuHeatmap: false,
    liveBundling: false,
    timeAsHeight: false,
    interleavedBasemap: false,
    userExtensions: false,
    cameraRoll: false,
  },
  timeFilterModes: ['window', 'wake', 'cumulative', 'trail'],
  layerKinds,
  projectsOnCpu: true,
  tilesetOwnership: 'shared',
  pickMechanism: 'cpu-ray',
  interleavedBasemap: false,
  basemapProjection: 'mercator',
};

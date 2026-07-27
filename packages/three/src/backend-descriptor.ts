// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * The `@poopdeck.gl/three` backend's self-declaration against the shared
 * `@poopdeck.gl/core/capabilities` contract (docs/roadmap/renderer-architecture.md).
 * It records what the three backend (Three.js + TSL on WebGPU, WebGL2 fallback)
 * actually ships, and the structural conformance gate in
 * `test/backend-descriptor.test.ts` proves every claim against the real
 * `src/index.ts` exports via `assertDescriptorConsistent`.
 *
 * Divergences from the deck backend, all deliberate:
 *  - CPU projection (LocalEnu / Mercator / Globe), so `projectsOnCpu: true`.
 *  - TSL compiles only on `WebGPURenderer`, so the basemap is a camera-synced
 *    overlay canvas (`interleavedBasemap: false`), NOT interleaved into a shared
 *    GL context.
 *  - Picking is HYBRID: instanced clouds are picked by a wired GPU id-buffer
 *    pass (`GpuPicker` → provenance resolve), while the tens of object/ego boxes
 *    stay on the CPU ray-OBB test. The descriptor has one `pickMechanism` slot
 *    and no `'hybrid'` member, so it declares `'gpu-id'` (the id-buffer readback,
 *    matching the deck backend for the identical technique); the box path is the
 *    CPU-side complement noted here.
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
    reason: 'no FlowStrokeLayer in three; use STTFlowCorridorLayer',
  },
  text: {
    supported: false,
    fallbackKind: 'icon',
    reason: 'text layer not yet ported to the three backend',
  },
  mesh: {
    supported: false,
    fallbackKind: 'boundingBox',
    reason: 'mesh layer not yet ported to the three backend',
  },
  pointCloud: {
    supported: false,
    fallbackKind: 'point',
    reason: 'point-cloud layer not yet ported to the three backend',
  },
  hexbin: {
    supported: false,
    fallbackKind: 'h3Summary',
    reason: 'hexbin layer not yet ported to the three backend',
  },
};

/**
 * Build the exhaustive `Record<LayerKind, LayerKindSupport>` from the frozen
 * `LAYER_KINDS` vocabulary so a newly-added kind is a compile break here (missing
 * key) rather than a silently-absent declaration.
 */
const layerKinds = Object.fromEntries(
  LAYER_KINDS.map((kind) => [
    kind,
    UNSUPPORTED_KINDS[kind] ?? { supported: true },
  ]),
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
    timeAsHeight: true,
    interleavedBasemap: false,
    userExtensions: false,
    cameraRoll: false,
  },
  timeFilterModes: ['window', 'wake', 'cumulative', 'trail'],
  layerKinds,
  projectsOnCpu: true,
  tilesetOwnership: 'shared',
  pickMechanism: 'gpu-id',
  interleavedBasemap: false,
  basemapProjection: 'mercator',
};

/* ──────────────────────────────────────────────────────────────────────────
 * Layer-feature matrix
 *
 * The per-layer prop families the deck reference backend exposes (glide
 * interpolation, icon wake, GPU DataFilter, space-time height, stable
 * categorical colour, progressive path reveal). Each entry is the honest,
 * machine-checkable complement to deck's declaration. The vocabulary is
 * redeclared locally because `@poopdeck.gl/three` deliberately does not depend
 * on `@poopdeck.gl/layers`; the conformance gate asserts exhaustiveness.
 * ────────────────────────────────────────────────────────────────────────── */

/** The per-layer prop families a backend either implements or degrades. */
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
      kinds: readonly LayerKind[];
      prop: string;
      summary: string;
    }
  | {
      supported: false;
      kinds: readonly LayerKind[];
      fallback: string;
      reason: string;
    };

/**
 * Per-feature support for this backend. An entry may only be `supported: false`
 * as a deliberate typed fallback, never a silent gap, and each entry must stay
 * consistent with the coarse `capabilities` flags above — `timeHeightScale`
 * with `capabilities.timeAsHeight` in particular. Every family is supported
 * here, each on the kinds listed.
 */
export const threeLayerFeatures: Readonly<
  Record<LayerFeature, LayerFeatureSupport>
> = {
  motionInterpolation: {
    supported: true,
    kinds: ['point', 'icon'],
    prop: 'interpolate (+idProperty/maxInterpolationGap)',
    summary:
      'GPU keyframe glide — markers interpolate smoothly between tile time-samples from a single time uniform (data-texture keyframes, reducedMotion-gated); icon also glides heading',
  },
  iconWake: {
    supported: true,
    kinds: ['icon'],
    prop: 'wakeLength (+wakeTailScale)',
    summary:
      'trailing comet wake on animated icons — per-instance wakeAlphaNode fades opacity and wakeSizeScaleNode tapers the quad toward the tail; reducedMotion-gated to a static marker',
  },
  dataFilter: {
    supported: true,
    // Wired end-to-end (layer props → buffer builder → `sttFilterValue`
    // attribute → filter-enabled material → per-frame uniforms) on the full deck
    // set. icon's static path is covered; icon+glide filtering is a documented
    // no-op, because glide keyframes carry no per-sample filter column.
    kinds: ['arc', 'line', 'trips', 'column', 'polygon', 'icon'],
    prop: 'filterProperty (+filterRange/filterSoftRange/filterEnabled)',
    summary:
      'per-feature range filter (deck DataFilterExtension analogue): the hard range cut collapses out-of-range primitives in the vertex stage, filterSoftRange fades the band',
  },
  timeHeightScale: {
    supported: true,
    kinds: ['column', 'polygon'],
    prop: 'timeHeightScale (+timeHeightOrigin)',
    summary:
      'space-time-cube lift — each feature is raised in +Z by (start − timeHeightOrigin) × timeHeightScale (deck window-mode parity); the flat⇄cube morph is a pure uniform change; see capabilities.timeAsHeight=true',
  },
  stableColorMapping: {
    supported: true,
    kinds: ['arc', 'line', 'column', 'icon'],
    prop: 'stableColorMapping (+colorMapping/colorPalette/categoryOrder)',
    summary:
      'categorical colours stay stable across tiles — a deterministic label→slot assignment (explicit mapping / global categoryOrder / FNV-1a hash, all load-order-independent) feeds a GPU palette texture, replacing the per-tile first-seen palette that flickered as tiles churned',
  },
  pathReveal: {
    supported: true,
    kinds: ['path'],
    prop: 'revealTrail (+revealDuration/fadeTrail/reducedMotion)',
    summary:
      'progressive path draw — the path inks itself in up to the playhead via the per-vertex trail gate fed synthesized arc-length reveal times; revealDuration sets persist vs comet, fadeTrail the head→tail fade; reducedMotion-gated to a static whole path',
  },
};

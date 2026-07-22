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
    reason: 'no FlowStrokeLayer in three; use FlowCorridorLayer',
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
    timeAsHeight: false,
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
 * Layer-feature matrix (2026-07 kind-parity campaign)
 *
 * The deck reference backend gained per-layer prop families (glide
 * interpolation, icon wake, GPU DataFilter, space-time height, stable
 * categorical colour, progressive path reveal). The three backend does NOT
 * implement any of them today: TSL/WebGPU has no DataFilterExtension analogue,
 * no CPU glide/wake kernel port, and no time-as-height (`timeAsHeight` is
 * already `false` above). Rather than silently no-op, each feature declares a
 * DELIBERATE typed fallback + reason here — the honest, machine-checkable
 * complement to deck's `supported: true`. The vocabulary is redeclared locally
 * because `@poopdeck.gl/three` deliberately does not depend on
 * `@poopdeck.gl/layers`; the conformance gate asserts exhaustiveness.
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
 * three implements NONE of the campaign features yet — every entry is a
 * deliberate typed fallback, not a silent gap. `timeHeightScale` in particular
 * is consistent with `capabilities.timeAsHeight === false` above.
 */
export const threeLayerFeatures: Readonly<
  Record<LayerFeature, LayerFeatureSupport>
> = {
  motionInterpolation: {
    supported: false,
    kinds: ['point', 'icon'],
    fallback: 'per-tile window sampling (markers pop between tiles, no glide)',
    reason:
      'CPU glide kernel (idProperty pooling + per-frame pose lerp) not ported to three',
  },
  iconWake: {
    supported: false,
    kinds: ['icon'],
    fallback: 'static icons (no trailing wake)',
    reason: 'no per-instance wake-alpha shader hook in the three icon path',
  },
  dataFilter: {
    supported: false,
    kinds: ['arc', 'line', 'trips', 'column', 'polygon'],
    fallback: 'unfiltered — every feature is drawn',
    reason: 'no DataFilterExtension analogue in the three (TSL/WebGPU) backend',
  },
  timeHeightScale: {
    supported: false,
    kinds: ['column', 'polygon'],
    fallback: 'flat geometry (no space-time-cube lift)',
    reason:
      'time-as-height is unimplemented — see capabilities.timeAsHeight=false',
  },
  stableColorMapping: {
    supported: false,
    kinds: ['arc', 'line', 'column', 'icon'],
    fallback: 'per-tile first-seen palette (colours may differ across tiles)',
    reason:
      'no CategoryColorExtension palette / CPU colour-expand path ported to three',
  },
  pathReveal: {
    supported: false,
    kinds: ['path'],
    fallback: 'whole path drawn (no progressive reveal)',
    reason: 'progressive vertex-time reveal not ported to the three path layer',
  },
};

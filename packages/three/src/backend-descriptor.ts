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
 *  - Live edge-bundling (KDEEB) and user `LayerExtension`-style hooks are still
 *    deferred → those two caps are `false`. Everything else the 0.5.x note here
 *    listed as missing has since landed: `gpuHeatmap` (STTHeatmapLayer's
 *    additive-splat → ramp-resolve pass), `timeAsHeight`, and `cameraRoll`
 *    (`projection/view-state.ts` carries a real roll DOF rather than dropping
 *    the shared `ViewState.roll`).
 *  - `interleavedBasemap` stays `false` and is NOT a gap to close: TSL compiles
 *    only on `WebGPURenderer`, every basemap-interleave path in the ecosystem
 *    mechanically requires `new WebGLRenderer({context: gl})`, and WebGL and
 *    WebGPU are non-interoperable browser contexts. Interleaving would delete
 *    this backend's reason to exist (renderer-architecture.md §2.1).
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
  // Empty, and deliberately kept rather than deleted: the non-deck parity
  // campaign closed the last six gaps (heatmap, flowStroke, text, mesh,
  // pointCloud, hexbin), so three now renders all 23 frozen `LayerKind`s
  // natively. This table is the seam a future kind lands in — a new member of
  // `LAYER_KINDS` defaults to `{ supported: true }` below, so a kind three does
  // NOT render must be declared here or the conformance gate will catch the
  // over-claim.
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
    gpuHeatmap: true,
    // KDEEB edge bundling, real and at runtime: `lib/edge-bundler.ts` maps each
    // OD flow into core's shared BUNDLING_WORK_SIZE box, runs the full
    // splat/advect/resample/smooth/anneal schedule via
    // `@poopdeck.gl/core/edge-bundling`'s `bundleEdges` (one shared
    // implementation, not a lookalike — the maplibre and cesium backends run the
    // SAME function), and draws the result as ribbon geometry. A bundle is
    // static geometry, so it is recomputed when the edge set changes and never
    // per frame.
    liveBundling: true,
    timeAsHeight: true,
    interleavedBasemap: false,
    // A real TSL extension surface (`tsl/extensions.ts`): typed node hooks at a
    // declared seam matrix, per-extension attributes/uniforms, and
    // `assertVaryingSafe` guarding the `select()`-in-`varying()` WGSL trap. The
    // shipped time/data gates multiply in AFTER the user hook, so an extension
    // can only ever make a feature LESS visible — it cannot widen visibility or
    // desync the id pass from what is drawn.
    userExtensions: true,
    cameraRoll: true,
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

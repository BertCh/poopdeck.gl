// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * What the CesiumJS backend declares against the shared
 * `@poopdeck.gl/core/capabilities` contract. Cesium is the first GREEN-FIELD
 * consumer of the render kernel (docs/roadmap/renderer-architecture.md
 * §6) — it validates the extension surface is thin: this package implements a
 * tiny `SttRenderNode` + this descriptor and reuses `core/geo` (WGS84 globe),
 * `core/style` (color), `core/tileset-adapter` (streaming), and
 * `core/time-filter` (time-filter alpha — computed per feature on the CPU;
 * this backend ships no time-filter shader, see `shaders.ts`).
 *
 * CATALOG: the movement family is implemented — `point` (`STTPointLayer`),
 * `path`+`line` (`STTPathLayer`; an OD line is a 2-vertex LineString),
 * `arc` (`STTArcLayer`), `trips` (`STTTripsLayer`, geometric CPU trail
 * trim), `tripHeads` (`STTTripHeadsLayer`). Colour is one value per feature
 * (batch-table animation has no per-vertex colour), so OD endpoint gradients
 * collapse to the source colour and the trips tail fade is arc-length-based —
 * both documented deviations, not silent ones. Remaining kinds are declared
 * unsupported with a reason so the registry degrades them explicitly rather
 * than silently. Cesium natively has a WGS84 globe, GPU picking
 * (`scene.pick`), 3D extrusion, metric sizing, and a 3-DOF camera (roll), so
 * the capability flags are honest about the ENGINE even where the layer
 * catalog isn't built yet.
 */

import type {
  BackendDescriptor,
  LayerKind,
  LayerKindSupport,
} from '@poopdeck.gl/core/capabilities';
import { LAYER_KINDS } from '@poopdeck.gl/core/capabilities';

const UNBUILT = 'not yet implemented in the Cesium backend';
const SUPPORTED: ReadonlySet<LayerKind> = new Set([
  'point',
  'path',
  'line',
  'arc',
  'trips',
  'tripHeads',
  // Added by the non-deck parity campaign (2026-08-25).
  'boundingBox',
  'column',
  'pointCloud',
  'surfel',
  'text',
  'ego',
  'h3Summary',
  // The 2026-08-26 completion pass — cesium now renders every frozen LayerKind.
  'polygon',
  'icon',
  'mesh',
  'isoLines',
  'quadbinSummary',
  'hexbin',
  'heatmap',
  'flowCorridor',
  'flowStroke',
  'flowmap',
]);

function layerKinds(): Record<LayerKind, LayerKindSupport> {
  const out = {} as Record<LayerKind, LayerKindSupport>;
  for (const kind of LAYER_KINDS) {
    if (SUPPORTED.has(kind)) out[kind] = { supported: true };
    else if (
      kind === 'flowmap' ||
      kind === 'flowCorridor' ||
      kind === 'flowStroke'
    )
      out[kind] = { supported: false, fallbackKind: 'line', reason: UNBUILT };
    else if (kind === 'isoLines')
      out[kind] = { supported: false, fallbackKind: 'path', reason: UNBUILT };
    // `mesh` and `hexbin` deliberately name NO fallback (`text` did too until
    // the parity campaign made it native — see SUPPORTED above). They were
    // copied from the three descriptor as `text → icon`, `mesh → boundingBox`
    // and `hexbin → h3Summary`, which are honest THERE because three renders
    // all three targets — this backend renders none of them, so naming them
    // made `degradeRequest` hand the caller a second unrenderable kind instead
    // of the "skip, go to deck" its `reason` intends. Gate (c) in the suite
    // keeps the copy from coming back.
    else out[kind] = { supported: false, reason: UNBUILT };
  }
  return out;
}

export const cesiumBackend: BackendDescriptor = {
  id: 'cesium',
  capabilities: {
    globe: true, // Cesium's native frame IS a WGS84 globe
    picking: true, // scene.pick
    extrude3d: true,
    metricSizing: true, // ECEF metres
    gpuHeatmap: false,
    // KDEEB edge bundling, real and at runtime, through core's shared
    // `bundleEdges`. This backend has no compute path of its own, so the
    // schedule runs on the CPU — which is legitimate precisely BECAUSE a bundle
    // is static geometry: it is recomputed when the edge set changes, never per
    // frame. Same function as three and maplibre, so the three cannot drift.
    liveBundling: true,
    // The column layer ships the space-time-cube lift: each prism's base is
    // raised along LOCAL UP by `(start − timeHeightOrigin) × timeHeightScale`
    // metres, as an altitude add through the WGS84 GlobeProjection (there is no
    // Z axis to offset — positions here are absolute ECEF). `lib/columns.ts`
    // exports `timeHeightLiftMeters`, the exact function the layer calls, so the
    // claim is pinned to a unit-tested definition rather than to a prop name.
    timeAsHeight: true,
    interleavedBasemap: true, // STT primitives share Cesium's scene + depth
    // A real extension surface (`lib/extensions.ts`): per-frame value hooks that
    // transform the RESOLVED alpha and colour, which is the shape that follows
    // from this backend animating on the CPU rather than in a shader. The hook's
    // argument IS `base × timeFilterAlpha(...)` — applied to the oracle's OUTPUT,
    // never in place of it — so the package's "the oracle is the only alpha
    // definition" gate still holds with extensions installed.
    userExtensions: true,
    cameraRoll: true, // Cesium camera has heading/pitch/ROLL
  },
  timeFilterModes: ['window', 'wake', 'cumulative', 'trail'],
  layerKinds: layerKinds(),
  projectsOnCpu: true, // we CPU-project via core/geo GlobeProjection(wgs84) → Cartesian3
  tilesetOwnership: 'shared',
  pickMechanism: 'host', // Cesium scene.pick
  interleavedBasemap: true,
  basemapProjection: 'globe',
};

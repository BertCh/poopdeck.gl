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
 * `core/shader-codegen`/`core/time-filter` (time-filter alpha).
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
]);

function layerKinds(): Record<LayerKind, LayerKindSupport> {
  const out = {} as Record<LayerKind, LayerKindSupport>;
  for (const kind of LAYER_KINDS) {
    if (SUPPORTED.has(kind)) out[kind] = { supported: true };
    else if (kind === 'surfel')
      out[kind] = { supported: false, fallbackKind: 'point', reason: UNBUILT };
    else if (
      kind === 'flowmap' ||
      kind === 'flowCorridor' ||
      kind === 'flowStroke'
    )
      out[kind] = { supported: false, fallbackKind: 'line', reason: UNBUILT };
    else if (kind === 'isoLines')
      out[kind] = { supported: false, fallbackKind: 'path', reason: UNBUILT };
    else if (kind === 'text')
      out[kind] = { supported: false, fallbackKind: 'icon', reason: UNBUILT };
    else if (kind === 'mesh')
      out[kind] = {
        supported: false,
        fallbackKind: 'boundingBox',
        reason: UNBUILT,
      };
    else if (kind === 'pointCloud')
      out[kind] = { supported: false, fallbackKind: 'point', reason: UNBUILT };
    else if (kind === 'hexbin')
      out[kind] = {
        supported: false,
        fallbackKind: 'h3Summary',
        reason: UNBUILT,
      };
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
    liveBundling: false,
    timeAsHeight: false,
    interleavedBasemap: true, // STT primitives share Cesium's scene + depth
    userExtensions: false,
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

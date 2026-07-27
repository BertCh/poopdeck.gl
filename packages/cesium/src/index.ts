// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * @poopdeck.gl/cesium — a CesiumJS backend for SpatioTemporal Tiles, the first
 * green-field consumer of the render kernel (docs/roadmap/renderer-architecture.md
 * §6). It renders STT on a real WGS84 globe and is built almost entirely from
 * `@poopdeck.gl/core` sub-paths (geo / style / time-filter / shader-codegen /
 * tileset-adapter / picking / capabilities) — the proof that adding a backend is
 * thin: a `SttRenderNode` + a `BackendDescriptor` + a camera bridge.
 *
 * Streaming: wire a `SpatioTemporalTileset(makeTilesetCallbacks(archive))` from
 * `@poopdeck.gl/core` and feed its `onTileLoad` tiles to `STTPointLayer.setTiles`.
 *
 * CesiumJS is Apache-2.0 (free); rendering STT needs no Cesium ion token.
 */

// Backend capability descriptor (declare-and-prove).
export { cesiumBackend } from './backend-descriptor.js';

// The STT layers (browser — need a live Cesium Scene). Each is an
// `SttRenderNode` built from the render kernel; the pure geometry/colour/
// interpolation they consume is unit-tested (core + this package's lib/).
export {
  STTPointLayer,
  type STTPointLayerOptions,
} from './cesium-point-layer.js';
export { STTPathLayer, type STTPathLayerOptions } from './cesium-path-layer.js';
export { STTArcLayer, type STTArcLayerOptions } from './cesium-arc-layer.js';
export {
  STTTripsLayer,
  type STTTripsLayerOptions,
} from './cesium-trips-layer.js';
export {
  STTTripHeadsLayer,
  type STTTripHeadsLayerOptions,
} from './cesium-trip-heads-layer.js';
export {
  STTBatchedPolylineLayer,
  type STTBatchedPolylineOptions,
} from './batched-polyline-layer.js';

// Pure builders (Cesium-free, unit-tested) behind the polyline layers.
export {
  buildPathPolylines,
  buildArcPolylines,
  sampleGreatCircleArc,
  lineStringTimeOrigin,
  type FeaturePolyline,
  type PolylineBuild,
  type PathBuildOptions,
  type ArcBuildOptions,
} from './lib/polylines.js';
export { featureColor, type FeatureColorMode } from './lib/feature-color.js';
export {
  buildPointEntries,
  collectPointLayers,
  type FeaturePoint,
  type PointBuild,
  type PointBuildOptions,
} from './lib/points.js';

// ViewState ⇄ Cesium camera bridge: pure math (camera) + the runtime applier.
export {
  viewStateToCesiumView,
  cesiumViewToViewState,
  type CesiumCameraSample,
  type CesiumView,
  type CesiumViewOptions,
  type ResolvedViewState,
} from './camera.js';
export { applyViewStateToCamera } from './camera-apply.js';

// Camera → tile-selection inputs, and the gate that keeps a replace-all
// `setTiles` off the per-tile-load path. Both pure (Cesium-free) + unit-tested.
export {
  resolveCesiumStreamView,
  viewRectangleToBounds,
  verticalFovRadians,
  isWholeWorldRectangle,
  type CameraRectangleRadians,
  type CesiumStreamViewInput,
} from './lib/stream-view.js';
export {
  TilePublishGate,
  type TilePublishDecision,
  type TilePublishGateOptions,
  type TilePublishReason,
} from './lib/tile-publish-gate.js';

// Render-loop clock bridge: drive the STT playhead from Cesium's render loop
// (scene.preRender) instead of per-frame React state, and pump requestRender so
// requestRenderMode idles when paused. READ-only — never advances the controller.
export {
  attachCesiumClock,
  type PlayheadClock,
  type AttachCesiumClockOptions,
} from './cesium-clock.js';

// Generated GLSL time-filter alpha for a future Cesium GPU-appearance path.
export { timeFilterAlphaGlsl } from './shaders.js';

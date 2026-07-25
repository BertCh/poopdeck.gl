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
 * Streaming: wire a `SpatiotemporalTileset(makeTilesetCallbacks(archive))` from
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
  type CesiumView,
  type CesiumViewOptions,
  type ResolvedViewState,
} from './camera.js';
export { applyViewStateToCamera } from './camera-apply.js';

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

// ════════════════════════════════════════════════════════════════════════════
//  DEPRECATED ALIASES (0.6.0) — removal target: 0.8.0
//
//  The layer classes were `Cesium*Layer` through 0.5.x. They now carry the same
//  `STT` prefix as `@poopdeck.gl/maplibre` and `@poopdeck.gl/three`, so one
//  layer kind has ONE spelling across every backend and the import path (not a
//  redundant word inside the symbol) is what says which renderer you are on.
//  Nothing here ever collided with deck.gl — this is the consistency half of
//  the 0.6.0 naming pass. The camera/clock bridges (`CesiumView`,
//  `attachCesiumClock`, …) keep their names: they are named after CesiumJS's
//  own concepts, not after an STT layer kind.
//
//  The JSDoc must sit on the export SPECIFIER: TypeScript ignores a
//  `@deprecated` block placed above an `export … from` statement.
// ════════════════════════════════════════════════════════════════════════════
export {
  /** @deprecated Renamed to {@link STTPointLayer} in 0.6.0 (removed in 0.8.0). */
  STTPointLayer as CesiumPointLayer,
  /** @deprecated Renamed to {@link STTPointLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTPointLayerOptions as CesiumPointLayerOptions,
} from './cesium-point-layer.js';
export {
  /** @deprecated Renamed to {@link STTPathLayer} in 0.6.0 (removed in 0.8.0). */
  STTPathLayer as CesiumPathLayer,
  /** @deprecated Renamed to {@link STTPathLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTPathLayerOptions as CesiumPathLayerOptions,
} from './cesium-path-layer.js';
export {
  /** @deprecated Renamed to {@link STTArcLayer} in 0.6.0 (removed in 0.8.0). */
  STTArcLayer as CesiumArcLayer,
  /** @deprecated Renamed to {@link STTArcLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTArcLayerOptions as CesiumArcLayerOptions,
} from './cesium-arc-layer.js';
export {
  /** @deprecated Renamed to {@link STTTripsLayer} in 0.6.0 (removed in 0.8.0). */
  STTTripsLayer as CesiumTripsLayer,
  /** @deprecated Renamed to {@link STTTripsLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTTripsLayerOptions as CesiumTripsLayerOptions,
} from './cesium-trips-layer.js';
export {
  /** @deprecated Renamed to {@link STTTripHeadsLayer} in 0.6.0 (removed in 0.8.0). */
  STTTripHeadsLayer as CesiumTripHeadsLayer,
  /** @deprecated Renamed to {@link STTTripHeadsLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTTripHeadsLayerOptions as CesiumTripHeadsLayerOptions,
} from './cesium-trip-heads-layer.js';
export {
  /** @deprecated Renamed to {@link STTBatchedPolylineLayer} in 0.6.0 (removed in 0.8.0). */
  STTBatchedPolylineLayer as BatchedPolylineLayer,
  /** @deprecated Renamed to {@link STTBatchedPolylineOptions} in 0.6.0 (removed in 0.8.0). */
  type STTBatchedPolylineOptions as BatchedPolylineOptions,
} from './batched-polyline-layer.js';

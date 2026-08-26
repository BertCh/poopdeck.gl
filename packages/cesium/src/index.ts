// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * @poopdeck.gl/cesium — a CesiumJS backend for SpatioTemporal Tiles, the first
 * green-field consumer of the render kernel (docs/roadmap/renderer-architecture.md
 * §6). It renders STT on a real WGS84 globe and is built almost entirely from
 * `@poopdeck.gl/core` sub-paths (geo / style / time-filter / tileset-adapter /
 * picking / capabilities) — the proof that adding a backend is thin: a
 * `SttRenderNode` + a `BackendDescriptor` + a camera bridge.
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
  STTBoundingBoxLayer,
  type STTBoundingBoxLayerOptions,
} from './cesium-bounding-box-layer.js';
export {
  STTColumnLayer,
  type STTColumnLayerOptions,
} from './cesium-column-layer.js';
export {
  STTPointCloudLayer,
  type STTPointCloudLayerOptions,
} from './cesium-point-cloud-layer.js';
export {
  STTSurfelLayer,
  type STTSurfelLayerOptions,
} from './cesium-surfel-layer.js';
export { STTTextLayer, type STTTextLayerOptions } from './cesium-text-layer.js';
export { STTEgoLayer, type STTEgoLayerOptions } from './cesium-ego-layer.js';
export {
  STTPolygonLayer,
  type STTPolygonLayerOptions,
} from './cesium-polygon-layer.js';
export { STTIconLayer, type STTIconLayerOptions } from './cesium-icon-layer.js';
export { STTMeshLayer, type STTMeshLayerOptions } from './cesium-mesh-layer.js';
export { STTIsoLayer, type STTIsoLayerOptions } from './cesium-iso-layer.js';
export {
  STTH3SummaryLayer,
  type STTH3SummaryLayerOptions,
} from './cesium-h3-summary-layer.js';
export {
  STTQuadbinSummaryLayer,
  type STTQuadbinSummaryLayerOptions,
} from './cesium-quadbin-summary-layer.js';
export {
  STTHexbinLayer,
  type STTHexbinLayerOptions,
} from './cesium-hexbin-layer.js';
export {
  STTHeatmapLayer,
  type STTHeatmapLayerOptions,
} from './cesium-heatmap-layer.js';
export {
  STTFlowCorridorLayer,
  type STTFlowCorridorLayerOptions,
} from './cesium-flow-corridor-layer.js';
export {
  STTFlowStrokeLayer,
  type STTFlowStrokeLayerOptions,
} from './cesium-flow-stroke-layer.js';
export {
  STTFlowmapLayer,
  type STTFlowmapLayerOptions,
} from './cesium-flowmap-layer.js';
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
export {
  buildTrackedBoxes,
  trackedBoxSampleConfig,
  enuBasis,
  writeBoxModelMatrix,
  type TrackedBoxColumns,
  type TrackedBoxBuildOptions,
  type TrackedBoxSampleOptions,
  type TrackedBox,
  type TrackedBoxBuild,
  type BoxPose,
} from './lib/tracked-boxes.js';
export {
  buildColumnEntries,
  timeHeightLiftMeters,
  columnAxisOffsetMeters,
  prismSlices,
  type FeatureColumn,
  type ColumnBuild,
  type ColumnBuildOptions,
} from './lib/columns.js';
export {
  buildPointCloudEntries,
  lambertShade,
  type PointCloudLighting,
  type PointCloudBuildOptions,
  type CloudPoint,
  type PointCloudBuild,
} from './lib/point-clouds.js';
export {
  buildEgoTrack,
  sampleEgoPose,
  bracketIndex,
  lerpAngle,
  wrapAngle,
  normalizeHeading,
  type HeadingUnits,
  type HeadingReference,
  type EgoKeyframe,
  type EgoTrack,
  type EgoPose,
  type EgoBuildOptions,
} from './lib/ego-pose.js';
export {
  buildSummaryCells,
  collectSummaryLayers,
  h3IndexFromU64,
  h3BoundaryResolver,
  unwrapRing,
  ringCentroid,
  ringToEcef,
  type H3CellToBoundary,
  type CellBoundaryResolver,
  type SummaryCell,
  type SummaryCellDiagnostics,
  type SummaryCellBuild,
  type SummaryCellBuildOptions,
} from './lib/summary-cells.js';
export {
  buildLabelEntries,
  formatNumericLabel,
  shortestFloat32String,
  type LabelAnchor,
  type LabelBaseline,
  type FeatureLabel,
  type LabelBuild,
  type LabelBuildOptions,
} from './lib/labels.js';
export {
  buildSurfelEntries,
  detectSurfelLayout,
  collectSurfelLayouts,
  unpackSmallestThree,
  quaternionToBasis,
  enuToEcefBasis,
  surfelFrame,
  surfelModelMatrix,
  unitDiskRim,
  diskIndices,
  type FeatureSurfel,
  type SurfelBuild,
  type SurfelBuildOptions,
  type SurfelLayout,
} from './lib/surfels.js';

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
// Rate limiter over `tileset.update()` for the per-frame playhead hook: the
// tileset's fast path cannot short-circuit a moving clock, so an unthrottled
// preRender hook is a full selection pass per drawn frame (audit E2).
export {
  createThrottledTilesetUpdate,
  type ThrottledTileset,
  type ThrottledTilesetUpdate,
  type ThrottledTilesetUpdateOptions,
  type TilesetViewport,
} from './lib/tileset-update-throttle.js';

// Render-loop clock bridge: drive the STT playhead from Cesium's render loop
// (scene.preRender) instead of per-frame React state, and pump requestRender so
// requestRenderMode idles when paused. READ-only — never advances the controller.
export {
  attachCesiumClock,
  type PlayheadClock,
  type AttachCesiumClockOptions,
} from './cesium-clock.js';

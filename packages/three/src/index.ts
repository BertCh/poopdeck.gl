// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * @poopdeck.gl/three — a Three.js + TSL (WebGPU) renderer for SpatioTemporal
 * Tiles, independent of and parallel to the deck.gl renderer. It consumes the
 * exact same decoded tiles from `@poopdeck.gl/core` and the same playback clock
 * from `@poopdeck.gl/playback`.
 *
 * The engine here is framework-agnostic (owns the renderer, scene, camera, loop,
 * TSL materials, and tile→geometry layer adapters). React / react-three-fiber
 * bindings live in the `@poopdeck.gl/three/r3f` subpath.
 */

// ─── Projection ───────────────────────────────────────────────────────────────
export {
  LocalEnuProjection,
  METERS_PER_DEG_LAT,
  EARTH_RADIUS,
  projectPositionsToEnu,
  projectPositions,
  type Projection,
  type GeoAnchor,
  type LocalFrame,
  type ProjectedPositions,
} from './projection/local-enu.js';
export { MercatorProjection, MAX_MERCATOR_LAT } from './projection/mercator.js';
export { GlobeProjection } from './projection/globe.js';
export {
  viewStateToCamera,
  cameraToViewState,
  type ViewState,
  type ViewStateCameraOptions,
} from './projection/view-state.js';
export {
  frameGlobe,
  setGlobeClip,
  type FrameGlobeOptions,
} from './scene/globe-camera.js';

// ─── Renderer bootstrap ───────────────────────────────────────────────────────
export {
  createSttRenderer,
  createHighLimitDevice,
  isWebGPUAvailable,
  resolveBackend,
  type CreateRendererOptions,
  type CreatedRenderer,
  type RendererBackend,
} from './renderer/webgpu-renderer.js';

// ─── Time filter (CPU reference math + TSL nodes) ─────────────────────────────
export {
  windowAlpha,
  wakeAlpha,
  cumulativeAlpha,
  trailAlpha,
  wakeSizeScale,
  timeFilterAlpha,
  type TimeFilterMode,
  type TimeFilterParams,
} from './tsl/time-filter-math.js';
// Time-window vocabulary bridge: lets every three layer ALSO accept deck's /
// maplibre's full-width `timeWindow` + `fadeIn/OutDuration`, converting to the
// internal half-width `windowHalf`/`fadeIn`/`fadeOut` (which stay as aliases).
export {
  resolveTimeWindow,
  type ThreeTimeWindowOptions,
  type ResolvedTimeWindow,
} from './lib/time-window.js';
export {
  TimeFilterUniforms,
  timeFilterAlphaNode,
  windowAlphaNode,
  wakeAlphaNode,
  wakeSizeScaleNode,
  cumulativeAlphaNode,
  trailAlphaNode,
  updateTimeFilterUniforms,
  type TSLNode,
  type UniformNode,
} from './tsl/time-filter.js';

// ─── Engine core ──────────────────────────────────────────────────────────────
export {
  SttScene,
  type SttSceneOptions,
  type AddLayerOptions,
} from './scene/stt-three-scene.js';
export {
  StandaloneViewer,
  type StandaloneViewerOptions,
} from './viewer/standalone-viewer.js';
// ─── Atmosphere (opt-in, WebGPU-only physically-based sky / sun / day-night) ────
export {
  createSttAtmosphere,
  computeWorldToEcef,
  geodeticToEcef,
  enuBasisEcef,
  resolveSunDate,
  resolveAtmosphereOptions,
  type SttAtmosphere,
  type AtmosphereOptions,
  type ResolvedAtmosphereOptions,
  type CreateSttAtmosphereOptions,
} from './scene/atmosphere.js';
// ─── OGC 3D Tiles (opt-in: real terrain / Google Photorealistic / Cesium Ion) ───
export {
  createStt3DTiles,
  resolveTilesSource,
  resolveStt3DTilesOptions,
  ecefToWorldMatrix,
  alignTilesGroup,
  type Stt3DTilesSource,
  type ResolvedTilesSource,
  type Stt3DTilesOptions,
  type ResolvedStt3DTilesOptions,
  type CreateStt3DTilesOptions,
  type Stt3DTiles,
} from './scene/tiles-3d.js';
export {
  createSttGlobeControls,
  type CreateSttGlobeControlsOptions,
  type SttGlobeControls,
} from './scene/globe-controls.js';
export {
  SttTileSource,
  type SttTileSourceOptions,
  type LoadedSource,
} from './scene/tile-source.js';
export { makeGround, type GroundOptions } from './scene/ground.js';
export { frameBox, type FrameOptions } from './scene/camera.js';
export {
  isGlobeProjection,
  rigModeFor,
  resolveCanvasProjection,
  globeControlLimits,
  type RigMode,
} from './scene/projection-rig.js';
export {
  BaseSttLayer,
  type SttLayer,
  type SttLayerContext,
} from './layers/layer.js';

// ─── Surfels (hero) ───────────────────────────────────────────────────────────
export { makeHexDiskGeometry, HEX_CIRCUMRADIUS } from './geometry/hex-disk.js';
export {
  createSurfelMaterial,
  updateSurfelUniforms,
  SurfelUniforms,
  type SurfelMaterialOptions,
  type SurfelMaterialBundle,
  type SurfelUniformValues,
} from './tsl/surfel-material.js';
export { SurfelLayer, type SurfelLayerOptions } from './layers/surfel-layer.js';
export {
  buildSurfelBuffers,
  type SurfelBuffers,
  type SurfelBufferOptions,
} from './layers/surfel-buffers.js';

// ─── Points (raw / splat / scan / worldbuild) ─────────────────────────────────
export { makeBillboardQuadGeometry } from './geometry/billboard-quad.js';
export {
  createPointMaterial,
  createPointIdMaterial,
  updatePointUniforms,
  PointUniforms,
  type PointMaterialOptions,
  type PointMaterialBundle,
  type PointUniformValues,
} from './tsl/point-material.js';
export {
  PointCloudLayer,
  type PointCloudLayerOptions,
  type SttPointPickable,
} from './layers/point-cloud-layer.js';
export {
  buildPointBuffers,
  pointTileKey,
  type PointBuffers,
  type PointBufferOptions,
  type PointColorMode,
} from './layers/point-buffers.js';
export {
  resolveCategoryColor,
  expandCategoricalColors,
  expandRgbColumns,
  rampColorAt,
  expandRampColors,
  type RGBA,
  type CategoricalColorSpec,
  type RampColorSpec,
} from './lib/color.js';

// ─── Objects (bounding boxes) + maps + ego ────────────────────────────────────
export {
  BoundingBoxLayer,
  type BoundingBoxLayerOptions,
} from './layers/bounding-box-layer.js';
export {
  buildTrackIndex,
  sampleTrack,
  sampleTracks,
  lerp,
  lerpAngle,
  lerpDim,
  SINGLETON_HOLD_MS,
  type Track,
  type BoxSample,
  type BoxTrackOptions,
  type BoxDefaults,
} from './layers/box-tracks.js';
export {
  writeBoxEdges,
  BOX_CORNERS,
  BOX_EDGES,
  FLOATS_PER_BOX,
} from './geometry/box-edges.js';
export {
  StaticPathLayer,
  type StaticPathLayerOptions,
} from './layers/path-layer.js';
export {
  StaticPolygonLayer,
  type StaticPolygonLayerOptions,
} from './layers/polygon-layer.js';
export {
  EgoLayer,
  type EgoLayerOptions,
  type EgoPose,
} from './layers/ego-layer.js';

// ─── Density iso-lines (animated contours) ────────────────────────────────────
export {
  createIsoLineMaterial,
  updateIsoLineUniforms,
  type IsoLineMaterialOptions,
  type IsoLineMaterialBundle,
  type IsoLineUniforms,
  type IsoLineUniformValues,
} from './tsl/iso-line-material.js';
export { IsoLayer, type IsoLayerOptions } from './layers/iso-layer.js';

// ════════════════════════════════════════════════════════════════════════════
//  GEOGRAPHIC LAYERS (deck parity) — render the non-AV showcase demos in Three
//  under MercatorProjection / GlobeProjection. See docs/roadmap/three-renderer-parity.md
// ════════════════════════════════════════════════════════════════════════════

// Point geo-parity: continuous ramp colour + pixel-radius sizing.
export type { PointSizeUnits } from './tsl/point-material.js';

// ─── Wide lines (screen-pixel ribbons: Path / OD-Line / Trips / Corridor) ──────
export {
  createWideLineMaterial,
  updateWideLineUniforms,
  WideLineUniforms,
  type WideLineMode,
  type WideLineMaterialOptions,
  type WideLineMaterialBundle,
  type WideLineUniformValues,
} from './tsl/wide-line-material.js';
export { makeSegmentQuadGeometry } from './geometry/segment-quad.js';
export {
  buildLineSegmentBuffers,
  type LineColorMode,
  type LineSegmentBufferOptions,
  type LineSegmentBuffers,
} from './lib/geo-line-buffers.js';
export {
  WideLineLayer,
  type WideLineLayerOptions,
} from './layers/wide-line-layer.js';
export {
  PathGeoLayer,
  type PathGeoLayerOptions,
} from './layers/path-geo-layer.js';
export {
  OdLineLayer,
  type OdLineLayerOptions,
} from './layers/od-line-layer.js';
export {
  deriveSourceTargetPositions,
  buildOdLineSegmentBuffers,
  type SourceTargetPositions,
} from './lib/od-positions.js';

// ─── Trips (animated trail-mode trajectories) ──────────────────────────────────
export { TripsLayer, type TripsLayerOptions } from './layers/trips-layer.js';
export {
  buildTripsBuffers,
  synthesizeVertexTimes,
  type TripsColorMode,
  type TripsBufferOptions,
  type TripsBuffers,
} from './lib/trips-buffers.js';
export {
  buildTripIndex,
  sampleHead,
  sampleHeads,
  type Trip,
  type TripIndex,
  type Head,
} from './lib/trip-heads.js';
export {
  TripHeadsLayer,
  type TripHeadsLayerOptions,
} from './layers/trip-heads-layer.js';

// ─── Arcs (curved/great-circle OD) ─────────────────────────────────────────────
export {
  createArcMaterial,
  updateArcUniforms,
  makeArcStripGeometry,
  ArcUniforms,
  type ArcShape,
  type ArcMaterialOptions,
  type ArcMaterialBundle,
  type ArcUniformValues,
} from './tsl/arc-material.js';
export { ArcLayer, type ArcLayerOptions } from './layers/arc-layer.js';
export {
  buildArcBuffers,
  type ArcColorMode,
  type ArcBufferOptions,
  type ArcBuffers,
} from './lib/arc-buffers.js';

// ─── Icons (directional billboard markers) ─────────────────────────────────────
export {
  createIconMaterial,
  updateIconUniforms,
  IconUniforms,
  type IconMode,
  type IconMaterialOptions,
  type IconMaterialBundle,
  type IconUniformValues,
} from './tsl/icon-material.js';
export { IconLayer, type IconLayerOptions } from './layers/icon-layer.js';
export {
  buildIconBuffers,
  type IconMappingEntry,
  type IconColorMode,
  type IconBufferOptions,
  type IconBuffers,
} from './lib/icon-buffers.js';

// ─── Columns (extruded 3D bars) ────────────────────────────────────────────────
export {
  createColumnMaterial,
  updateColumnUniforms,
  ColumnUniforms,
  type ColumnMaterialOptions,
  type ColumnMaterialBundle,
  type ColumnUniformValues,
} from './tsl/column-material.js';
export {
  makeColumnPrismGeometry,
  circumradiusForIncircle,
} from './geometry/column-prism.js';
export { ColumnLayer, type ColumnLayerOptions } from './layers/column-layer.js';
export {
  buildColumnBuffers,
  type ColumnColorMode,
  type ColumnBufferOptions,
  type ColumnBuffers,
} from './lib/column-buffers.js';

// ─── Polygons (animated fill + extrude; StaticPolygonLayer extends this) ────────
export {
  createPolygonMaterial,
  updatePolygonUniforms,
  type PolygonTimeMode,
  type PolygonMaterialOptions,
  type PolygonUniforms,
  type PolygonMaterialBundle,
  type PolygonUniformValues,
} from './tsl/polygon-material.js';
export {
  PolygonLayer,
  type PolygonLayerOptions,
} from './layers/polygon-layer.js';
export {
  buildPolygonBuffers,
  type PolygonColorMode,
  type PolygonBufferOptions,
  type PolygonBuffers,
} from './layers/polygon-buffers.js';

// ─── Summary tier: Quadbin cells ───────────────────────────────────────────────
export {
  quadbinToTile,
  tileToBounds,
  cellBoundsFromTile,
  type QuadbinTile,
  type CellBounds,
} from './lib/quadbin-cell.js';
export {
  buildQuadbinBuffers,
  rampBucketColor,
  DEFAULT_QUADBIN_COLOR_RANGE,
  type QuadbinBufferOptions,
  type QuadbinBuffers,
} from './lib/quadbin-buffers.js';
export {
  QuadbinSummaryLayer,
  type QuadbinSummaryLayerOptions,
} from './layers/quadbin-summary-layer.js';

// ─── Summary tier: H3 hexagons ─────────────────────────────────────────────────
export {
  h3IndexFromTile,
  cellBoundaryFromTile,
  type H3Boundary,
} from './lib/h3-cell.js';
export {
  buildH3Buffers,
  DEFAULT_H3_COLOR_RANGE,
  type H3BufferOptions,
  type H3Buffers,
} from './lib/h3-buffers.js';
export {
  H3SummaryLayer,
  type H3SummaryLayerOptions,
} from './layers/h3-summary-layer.js';

// ─── Flowmap family (tapered OD arrows + value-over-time corridors) ─────────────
export {
  createFlowArrowMaterial,
  updateFlowArrowUniforms,
  FlowArrowUniforms,
  type FlowArrowMaterialOptions,
  type FlowArrowMaterialBundle,
  type FlowArrowUniformValues,
} from './tsl/flow-arrow-material.js';
export {
  makeArrowTemplateGeometry,
  ARROW_TEMPLATE_POSITIONS,
} from './geometry/arrow-template.js';
export {
  FlowmapLayer,
  type FlowmapLayerOptions,
} from './layers/flowmap-layer.js';
export {
  buildFlowmapBuffers,
  type FlowmapBufferOptions,
  type FlowmapBuffers,
} from './lib/flowmap-buffers.js';
export {
  createFlowCorridorMaterial,
  updateFlowCorridorUniforms,
  FlowCorridorUniforms,
  type FlowCorridorMaterialOptions,
  type FlowCorridorMaterialBundle,
  type FlowCorridorUniformValues,
} from './tsl/flow-corridor-material.js';
export {
  FlowCorridorLayer,
  type FlowCorridorLayerOptions,
} from './layers/flow-corridor-layer.js';
export {
  buildFlowCorridorBuffers,
  bucketPosFromTime,
  type BucketAxis,
  type FlowCorridorBufferOptions,
  type FlowCorridorBuffers,
} from './lib/flow-corridor-buffers.js';

// ─── Streaming tile source + real governor BufferSource ────────────────────────
export {
  StreamingTileSource,
  cameraToViewport,
  zoomFromCamera,
  tileKey,
  residentSetEqual,
  TilesetBufferSource,
  createTilesetBufferSource,
  type StreamingViewport,
  type StreamingTileSourceOptions,
  type StreamingLayerOptions,
  type DrivableTileset,
  type RunwayTileset,
} from './scene/streaming-tile-source.js';

// ─── Basemap (host-owned maplibre overlay sync + globe earth sphere) ───────────
export {
  BasemapOverlay,
  type BasemapLike,
  type BasemapOverlayOptions,
} from './scene/basemap-overlay.js';
export {
  makeGlobeBasemap,
  GLOBE_BASEMAP_INSET,
  type GlobeBasemapOptions,
} from './scene/globe-basemap.js';

// ─── GPU id-colour picking (geographic layers) ─────────────────────────────────
export {
  encodeId,
  decodeId,
  buildIdColors,
  MAX_PICK_ID,
  GpuPicker,
  type PickRenderer,
  type RenderTargetCtor,
  type GpuPickerOptions,
} from './lib/gpu-pick.js';

// ─── Picking (click-to-inspect) ───────────────────────────────────────────────
export {
  rayObbHit,
  pickBoxes,
  type Vec3,
  type SttPickInfo,
  type SttPickInfoBase,
  type SttBoxPickInfo,
  type SttPointPickInfo,
  type PickBox,
  type SttPickable,
} from './lib/box-pick.js';
// Merged-buffer point picking (§5.3): pure index → SttPickResult resolution, and
// the adapter that maps that result into the pick controller's SttPointPickInfo.
export {
  resolvePointPick,
  parsePointTileKey,
  pointPickToInfo,
  type ResolvePointPickParams,
} from './lib/point-pick.js';

// ─── Playback governor registration ────────────────────────────────────────────
export {
  createCompleteBufferSource,
  type SttSourceRegistry,
} from './lib/source-registry.js';

// ─── Backend capability descriptor (renderer-abstraction Phase 5) ───────────────
export { threeBackend } from './backend-descriptor.js';

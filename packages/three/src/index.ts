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
 *
 * This barrel is the STABLE surface: everything needed to construct and drive
 * the shipped layers and materials. The node-graph builders, uniform holders and
 * instanced-geometry templates you only touch when authoring a NEW layer or
 * material live in `@poopdeck.gl/three/internal`, which is explicitly unstable —
 * see that module's header for why the split exists.
 *
 * NAMING: every layer class is `STT<Kind>Layer` — the same prefix
 * `@poopdeck.gl/maplibre` and `@poopdeck.gl/cesium` use, so one layer kind has
 * one spelling across every backend and nothing here shadows a deck.gl export
 * in an app that imports both. The unprefixed 0.5.x spellings survive as
 * removed.
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
  updateCameraClip,
  intersectSurface,
  surfaceRadius,
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
  createSTTRenderer,
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
  // Hard 0/1 visibility (vertex-stage collapse) — CPU mirror of the TSL nodes.
  windowVisible,
  wakeVisible,
  cumulativeVisible,
  trailVisible,
  timeFilterVisible,
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
// The uniform holder + the per-frame push, plus the two wake nodes the icon
// materials compose directly. The rest of the alpha / visibility node builders
// (including the hard 0/1 vertex-stage twins) are authoring-only — the whole
// family is re-exported from `@poopdeck.gl/three/internal`.
export {
  TimeFilterUniforms,
  wakeAlphaNode,
  wakeSizeScaleNode,
  updateTimeFilterUniforms,
} from './tsl/time-filter.js';

// ─── Data filter (deck DataFilterExtension analogue: range cut + soft band) ────
export {
  resolveDataFilter,
  dataFilterVisible,
  dataFilterAlpha,
  type DataFilterRange,
  type DataFilterOptions,
  type ResolvedDataFilter,
} from './tsl/data-filter-math.js';
export {
  DataFilterUniforms,
  updateDataFilterUniforms,
} from './tsl/data-filter.js';

// ─── Motion glide (GPU keyframe interpolation for point/icon markers) ─────────
export {
  resampleTrack,
  assembleKeyframes,
  glideSampleCpu,
  type KeyframeAssemblyOptions,
  type KeyframeField,
  type ResampledTrack,
} from './lib/track-keyframes.js';
export { GlideUniforms } from './tsl/motion-glide.js';

// ─── Stable categorical colour (deck CategoryColorExtension analogue) ─────────
export {
  buildStablePalette,
  stableCategoryHash,
  featureCategorySlot,
  assignCategoryIndices,
  paletteTextureData,
  DEFAULT_CATEGORY_PALETTE,
  NULL_CATEGORY_INDEX,
  type StablePaletteOptions,
  type StablePalette,
} from './lib/palette.js';
export { PaletteUniforms } from './tsl/palette.js';

// ─── Engine core ──────────────────────────────────────────────────────────────
export {
  STTScene,
  type STTSceneOptions,
  type AddLayerOptions,
} from './scene/stt-three-scene.js';
// ─── Atmosphere (opt-in, WebGPU-only physically-based sky / sun / day-night) ────
export {
  createSTTAtmosphere,
  computeWorldToEcef,
  geodeticToEcef,
  enuBasisEcef,
  resolveSunDate,
  resolveAtmosphereOptions,
  type STTAtmosphere,
  type AtmosphereOptions,
  type ResolvedAtmosphereOptions,
  type CreateSTTAtmosphereOptions,
} from './scene/atmosphere.js';
// ─── OGC 3D Tiles (opt-in: real terrain / Google Photorealistic / Cesium Ion) ───
export {
  createSTT3DTiles,
  resolveTilesSource,
  resolveSTT3DTilesOptions,
  ecefToWorldMatrix,
  alignTilesGroup,
  type STT3DTilesSource,
  type ResolvedTilesSource,
  type STT3DTilesOptions,
  type ResolvedSTT3DTilesOptions,
  type CreateSTT3DTilesOptions,
  type STT3DTiles,
} from './scene/tiles-3d.js';
export {
  createSTTGlobeControls,
  type CreateSTTGlobeControlsOptions,
  type STTGlobeControls,
} from './scene/globe-controls.js';
export {
  STTTileSource,
  type STTTileSourceOptions,
  type LoadedSource,
} from './scene/tile-source.js';
// `STTScene` builds the ground for you from its `ground` option; the `makeGround`
// factory itself is authoring-only (`@poopdeck.gl/three/internal`).
export { type GroundOptions } from './scene/ground.js';
export {
  isGlobeProjection,
  rigModeFor,
  resolveCanvasProjection,
  globeControlLimits,
  groundControlLimits,
  MAX_GROUND_PITCH_DEG,
  MIN_MERCATOR_ZOOM,
  MAX_MERCATOR_ZOOM,
  type GroundControlLimitOptions,
  type RigMode,
} from './scene/projection-rig.js';
// The layer CONTRACT. `BaseSTTLayer`, the class you extend to implement it, is
// authoring-only (`@poopdeck.gl/three/internal`).
export { type STTLayer, type STTLayerContext } from './layers/layer.js';

// ─── Surfels (hero) ───────────────────────────────────────────────────────────
export {
  createSurfelMaterial,
  updateSurfelUniforms,
  type SurfelMaterialOptions,
  type SurfelMaterialBundle,
  type SurfelUniformValues,
} from './tsl/surfel-material.js';
export {
  STTSurfelLayer,
  type STTSurfelLayerOptions,
} from './layers/surfel-layer.js';
export {
  buildSurfelBuffers,
  type SurfelBuffers,
  type SurfelBufferOptions,
} from './layers/surfel-buffers.js';

// ─── Points (raw / splat / scan / worldbuild) ─────────────────────────────────
export {
  createPointMaterial,
  createPointIdMaterial,
  updatePointUniforms,
  type PointMaterialOptions,
  type PointMaterialBundle,
  type PointUniformValues,
} from './tsl/point-material.js';
export {
  STTPointLayer,
  type STTPointLayerOptions,
} from './layers/point-layer.js';
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
  srgbToLinear,
  type RGBA,
  type CategoricalColorSpec,
  type RampColorSpec,
} from './lib/color.js';
/** sRGB→working colour-space node — every layer material's colour goes through
 *  it so Three's sRGB output pass round-trips the authored byte (deck parity). */
export { srgbToWorking } from './tsl/color-space.js';

// ─── Objects (bounding boxes) + maps + ego ────────────────────────────────────
export {
  STTBoundingBoxLayer,
  type STTBoundingBoxLayerOptions,
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
  BOX_EDGES,
  FLOATS_PER_BOX,
} from './geometry/box-edges.js';
export {
  STTStaticPathLayer,
  type STTStaticPathLayerOptions,
} from './layers/path-layer.js';
export {
  STTStaticPolygonLayer,
  type STTStaticPolygonLayerOptions,
} from './layers/polygon-layer.js';
export {
  STTEgoLayer,
  type STTEgoLayerOptions,
  type EgoPose,
} from './layers/ego-layer.js';

// ─── Density iso-lines (animated contours) ────────────────────────────────────
export {
  createIsoLineMaterial,
  createIsoLineIdMaterial,
  updateIsoLineUniforms,
  type IsoLineMaterialOptions,
  type IsoLineMaterialBundle,
  type IsoLineUniforms,
  type IsoLineUniformValues,
} from './tsl/iso-line-material.js';
export { STTIsoLayer, type STTIsoLayerOptions } from './layers/iso-layer.js';

// ════════════════════════════════════════════════════════════════════════════
//  GEOGRAPHIC LAYERS (deck parity) — render the non-AV showcase demos in Three
//  under MercatorProjection / GlobeProjection. See docs/roadmap/renderer-architecture.md
// ════════════════════════════════════════════════════════════════════════════

// Point geo-parity: continuous ramp colour + pixel-radius sizing.
export type { PointSizeUnits } from './tsl/point-material.js';

// ─── Wide lines (screen-pixel ribbons: Path / OD-Line / Trips / Corridor) ──────
export {
  createWideLineMaterial,
  createWideLineIdMaterial,
  updateWideLineUniforms,
  WideLineUniforms,
  type WideLineMode,
  type WideLineMaterialOptions,
  type WideLineMaterialBundle,
  type WideLineUniformValues,
} from './tsl/wide-line-material.js';
export {
  buildLineSegmentBuffers,
  type LineColorMode,
  type LineSegmentBufferOptions,
  type LineSegmentBuffers,
} from './lib/geo-line-buffers.js';
export {
  STTWideLineLayer,
  type STTWideLineLayerOptions,
} from './layers/wide-line-layer.js';
export {
  STTPathGeoLayer,
  type STTPathGeoLayerOptions,
} from './layers/path-geo-layer.js';
export {
  STTOdLineLayer,
  type STTOdLineLayerOptions,
} from './layers/od-line-layer.js';
export {
  deriveSourceTargetPositions,
  buildOdLineSegmentBuffers,
  type SourceTargetPositions,
} from './lib/od-positions.js';

// ─── Trips (animated trail-mode trajectories) ──────────────────────────────────
export {
  STTTripsLayer,
  type STTTripsLayerOptions,
} from './layers/trips-layer.js';
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
  STTTripHeadsLayer,
  type STTTripHeadsLayerOptions,
} from './layers/trip-heads-layer.js';

// ─── Arcs (curved/great-circle OD) ─────────────────────────────────────────────
export {
  createArcMaterial,
  createArcIdMaterial,
  updateArcUniforms,
  type ArcShape,
  type ArcMaterialOptions,
  type ArcMaterialBundle,
  type ArcUniformValues,
} from './tsl/arc-material.js';
export { STTArcLayer, type STTArcLayerOptions } from './layers/arc-layer.js';
export {
  buildArcBuffers,
  type ArcColorMode,
  type ArcBufferOptions,
  type ArcBuffers,
} from './lib/arc-buffers.js';

// ─── Icons (directional billboard markers) ─────────────────────────────────────
export {
  createIconMaterial,
  createIconIdMaterial,
  updateIconUniforms,
  IconUniforms,
  type IconMode,
  type IconMaterialOptions,
  type IconMaterialBundle,
  type IconUniformValues,
  type IconIdMaterialOptions,
} from './tsl/icon-material.js';
export { STTIconLayer, type STTIconLayerOptions } from './layers/icon-layer.js';
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
  createColumnIdMaterial,
  updateColumnUniforms,
  ColumnUniforms,
  type ColumnMaterialOptions,
  type ColumnMaterialBundle,
  type ColumnUniformValues,
} from './tsl/column-material.js';
export {
  STTColumnLayer,
  type STTColumnLayerOptions,
} from './layers/column-layer.js';
export {
  buildColumnBuffers,
  type ColumnColorMode,
  type ColumnBufferOptions,
  type ColumnBuffers,
} from './lib/column-buffers.js';

// ─── Polygons (animated fill + extrude; STTStaticPolygonLayer extends this) ────────
export {
  createPolygonMaterial,
  createPolygonIdMaterial,
  updatePolygonUniforms,
  type PolygonTimeMode,
  type PolygonMaterialOptions,
  type PolygonUniforms,
  type PolygonMaterialBundle,
  type PolygonUniformValues,
} from './tsl/polygon-material.js';
export {
  STTPolygonLayer,
  type STTPolygonLayerOptions,
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
  STTQuadbinSummaryLayer,
  type STTQuadbinSummaryLayerOptions,
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
  STTH3SummaryLayer,
  type STTH3SummaryLayerOptions,
} from './layers/h3-summary-layer.js';

// ─── Flowmap family (tapered OD arrows + value-over-time corridors) ─────────────
export {
  createFlowArrowMaterial,
  updateFlowArrowUniforms,
  type FlowArrowMaterialOptions,
  type FlowArrowMaterialBundle,
  type FlowArrowUniformValues,
} from './tsl/flow-arrow-material.js';
export { ARROW_TEMPLATE_POSITIONS } from './geometry/arrow-template.js';
export {
  STTFlowmapLayer,
  type STTFlowmapLayerOptions,
} from './layers/flowmap-layer.js';
export {
  buildFlowmapBuffers,
  type FlowmapBufferOptions,
  type FlowmapBuffers,
} from './lib/flowmap-buffers.js';
export {
  createFlowCorridorMaterial,
  updateFlowCorridorUniforms,
  type FlowCorridorMaterialOptions,
  type FlowCorridorMaterialBundle,
  type FlowCorridorUniformValues,
} from './tsl/flow-corridor-material.js';
export {
  STTFlowCorridorLayer,
  type STTFlowCorridorLayerOptions,
} from './layers/flow-corridor-layer.js';
export {
  buildFlowCorridorBuffers,
  bucketPosFromTime,
  type BucketAxis,
  type FlowCorridorBufferOptions,
  type FlowCorridorBuffers,
} from './lib/flow-corridor-buffers.js';

export {
  STTFlowStrokeLayer,
  type STTFlowStrokeLayerOptions,
} from './layers/flow-stroke-layer.js';
export {
  buildFlowStrokePaths,
  bucketBlendAt,
  pathPeakAt,
  strokeWidthFromPeak,
  computePathWidths,
  expandPathWidths,
  flowStrokeSubStep,
  steppedBucketPos,
  FLOW_STROKE_SUB_STEP,
  DEFAULT_WIDTH_EXPONENT,
  type BucketBlend,
  type FlowStrokePaths,
  type FlowStrokeWidthOptions,
} from './lib/flow-stroke-widths.js';

// ─── Heatmap (per-pixel density: additive splat → ramp resolve) ─────────────────
export {
  createHeatmapMaterial,
  createHeatmapSplatMaterial,
  createHeatmapRampMaterial,
  updateHeatmapUniforms,
  updateHeatmapSplatUniforms,
  updateHeatmapRampUniforms,
  HeatmapSplatUniforms,
  HeatmapRampUniforms,
  HEATMAP_ATTR,
  DEFAULT_SPLAT_FALLOFF,
  type HeatmapKernel,
  type HeatmapMaterialOptions,
  type HeatmapSplatMaterialOptions,
  type HeatmapRampMaterialOptions,
  type HeatmapMaterialBundle,
  type HeatmapSplatBundle,
  type HeatmapRampBundle,
  type HeatmapUniformValues,
} from './tsl/heatmap-material.js';
export {
  STTHeatmapLayer,
  type STTHeatmapLayerOptions,
} from './layers/heatmap-layer.js';
export {
  buildHeatmapBuffers,
  type HeatmapBufferOptions,
  type HeatmapBuffers,
} from './lib/heatmap-buffers.js';

// ─── Hexbin (RUNTIME binning of the raw point tier) ─────────────────────────────
export {
  createHexbinMaterial,
  createHexbinIdMaterial,
  updateHexbinUniforms,
  HexbinUniforms,
  type HexbinMaterialOptions,
  type HexbinMaterialBundle,
  type HexbinUniformValues,
} from './tsl/hexbin-material.js';
export {
  STTHexbinLayer,
  type STTHexbinLayerOptions,
  type STTHexbinPickInfo,
  type HexbinStats,
} from './layers/hexbin-layer.js';
export {
  buildHexbinBuffers,
  aggregateHexbins,
  hexbinValueDomain,
  hexbinCellValue,
  hexbinWindowBucket,
  hexbinBucketTime,
  hexbinRadiusFromMeters,
  pointToHexbinAxial,
  hexbinKey,
  hexbinKeyI,
  hexbinKeyJ,
  hexbinKeyForPoint,
  hexbinCentroidMercator,
  resolveHexbinWeightProperty,
  resolveHexbinLatitude,
  DEFAULT_HEXBIN_RADIUS_METERS,
  DEFAULT_HEXBIN_ELEVATION_RANGE,
  DEFAULT_HEXBIN_COLOR_RANGE,
  type HexbinAggregation,
  type HexbinScaleType,
  type HexbinWeightAccessor,
  type HexbinWeightOptions,
  type HexbinBufferOptions,
  type HexbinBuffers,
  type HexbinAggregateParams,
  type HexbinAggregate,
} from './lib/hexbin-buffers.js';

// ─── Text (time-filtered map labels over an SDF/bitmap glyph atlas) ─────────────
export {
  createTextMaterial,
  createTextIdMaterial,
  updateTextUniforms,
  TextUniforms,
  type TextMode,
  type TextMaterialOptions,
  type TextMaterialBundle,
  type TextUniformValues,
  type TextIdMaterialOptions,
} from './tsl/text-material.js';
export { STTTextLayer, type STTTextLayerOptions } from './layers/text-layer.js';
export {
  buildTextBuffers,
  type TextGlyphMappingEntry,
  type TextColorMode,
  type TextAnchor,
  type TextAlignmentBaseline,
  type TextBufferOptions,
  type TextBuffers,
} from './lib/text-buffers.js';

// ─── Mesh (instanced 3D models on the shared track kernel) ──────────────────────
export {
  createMeshMaterial,
  createMeshIdMaterial,
  updateMeshUniforms,
  MeshUniforms,
  type MeshMaterialOptions,
  type MeshMaterialBundle,
  type MeshUniformValues,
} from './tsl/mesh-material.js';
export { STTMeshLayer, type STTMeshLayerOptions } from './layers/mesh-layer.js';
export {
  buildMeshTrackIndex,
  sampleMeshFrame,
  bakeMeshGroup,
  sampleMeshAttitude,
  quatToMeshEuler,
  slerpQuat,
  makeMeshPoseBuffers,
  ensureMeshPoseCapacity,
  meshPointTiles,
  meshRtcOrigin,
  meshTrackBbox,
  findMeshSample,
  MESH_SINGLE_GROUP,
  MESH_SINGLETON_HOLD_MS,
  type MeshTrackOptions,
  type MeshAttitudeTrack,
  type MeshTrackIndex,
  type MeshPoseBuffers,
  type MeshGroup,
  type MeshPoseOptions,
} from './lib/mesh-instances.js';

// ─── Point cloud (phong-LIT 3D points; distinct from the billboard `point`) ─────
export {
  createPointCloudMaterial,
  createPointCloudIdMaterial,
  updatePointCloudUniforms,
  PointCloudUniforms,
  POINT_CLOUD_LIGHT_DIRECTION,
  POINT_CLOUD_AMBIENT,
  POINT_CLOUD_DIFFUSE,
  POINT_CLOUD_SIZE,
  type PointCloudSizeUnits,
  type PointCloudMaterialOptions,
  type PointCloudMaterialBundle,
  type PointCloudUniformValues,
} from './tsl/point-cloud-material.js';
export {
  STTPointCloudLayer,
  type STTPointCloudLayerOptions,
} from './layers/point-cloud-layer.js';
export {
  buildPointCloudBuffers,
  type PointCloudColorMode,
  type PointCloudBufferOptions,
  type PointCloudBuffers,
} from './lib/point-cloud-buffers.js';

// ─── Streaming tile source + real governor BufferSource ────────────────────────
export {
  StreamingTileSource,
  cameraToViewport,
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
  type STTPickInfo,
  type STTPickInfoBase,
  type STTBoxPickInfo,
  type PickBox,
  type STTPickable,
} from './lib/box-pick.js';
// GPU id-buffer picking catalog: the kind-agnostic contract every instanced
// layer implements to become pickable (STTIdPickable + STTIdPickInfo), the pure
// merged-index → STTIdPickInfo resolution seam (resolveIdPick), the provenance
// tile-key helpers, and the auto-registration test (isIdPickable).
export {
  resolveIdPick,
  isIdPickable,
  featureTileKey,
  parseIdTileKey,
  type STTIdPickInfo,
  type STTIdPickable,
  type STTIdPickKind,
  type ResolveIdPickParams,
} from './lib/id-pick.js';
// Lower-level point index → SttPickResult resolution. `resolveIdPick` above is
// the general path every kind uses; this one is point-only.
export {
  resolvePointPick,
  parsePointTileKey,
  type ResolvePointPickParams,
} from './lib/point-pick.js';

// ─── Playback governor registration ────────────────────────────────────────────
export {
  createCompleteBufferSource,
  type STTSourceRegistry,
} from './lib/source-registry.js';

// ─── Backend capability descriptor ─────────────────────────────────────────────
export { threeBackend } from './backend-descriptor.js';

// ─── Deprecated spelling aliases (`Stt*` → `STT*`) ─────────────────────────────
// `STT` is the canonical spelling of the acronym across this package and the
// sibling `@poopdeck.gl/maplibre` / `@poopdeck.gl/cesium` backends, matching the
// product name "SpatioTemporal Tiles". The `Stt*` spellings below are aliases
// kept exported so published consumers keep compiling; they will be removed in a
// future major.
export {
  /** @deprecated Use {@link createSTTRenderer}. */
  createSTTRenderer as createSttRenderer,
} from './renderer/webgpu-renderer.js';
export {
  /** @deprecated Use {@link STTScene}. */
  STTScene as SttScene,
  /** @deprecated Use {@link STTSceneOptions}. */
  type STTSceneOptions as SttSceneOptions,
} from './scene/stt-three-scene.js';
export {
  /** @deprecated Use {@link createSTTAtmosphere}. */
  createSTTAtmosphere as createSttAtmosphere,
  /** @deprecated Use {@link STTAtmosphere}. */
  type STTAtmosphere as SttAtmosphere,
  /** @deprecated Use {@link CreateSTTAtmosphereOptions}. */
  type CreateSTTAtmosphereOptions as CreateSttAtmosphereOptions,
} from './scene/atmosphere.js';
export {
  /** @deprecated Use {@link createSTT3DTiles}. */
  createSTT3DTiles as createStt3DTiles,
  /** @deprecated Use {@link resolveSTT3DTilesOptions}. */
  resolveSTT3DTilesOptions as resolveStt3DTilesOptions,
  /** @deprecated Use {@link STT3DTiles}. */
  type STT3DTiles as Stt3DTiles,
  /** @deprecated Use {@link STT3DTilesSource}. */
  type STT3DTilesSource as Stt3DTilesSource,
  /** @deprecated Use {@link STT3DTilesOptions}. */
  type STT3DTilesOptions as Stt3DTilesOptions,
  /** @deprecated Use {@link ResolvedSTT3DTilesOptions}. */
  type ResolvedSTT3DTilesOptions as ResolvedStt3DTilesOptions,
  /** @deprecated Use {@link CreateSTT3DTilesOptions}. */
  type CreateSTT3DTilesOptions as CreateStt3DTilesOptions,
} from './scene/tiles-3d.js';
export {
  /** @deprecated Use {@link createSTTGlobeControls}. */
  createSTTGlobeControls as createSttGlobeControls,
  /** @deprecated Use {@link STTGlobeControls}. */
  type STTGlobeControls as SttGlobeControls,
  /** @deprecated Use {@link CreateSTTGlobeControlsOptions}. */
  type CreateSTTGlobeControlsOptions as CreateSttGlobeControlsOptions,
} from './scene/globe-controls.js';
export {
  /** @deprecated Use {@link STTTileSource}. */
  STTTileSource as SttTileSource,
  /** @deprecated Use {@link STTTileSourceOptions}. */
  type STTTileSourceOptions as SttTileSourceOptions,
} from './scene/tile-source.js';
export {
  /** @deprecated Use {@link STTLayer}. */
  type STTLayer as SttLayer,
  /** @deprecated Use {@link STTLayerContext}. */
  type STTLayerContext as SttLayerContext,
} from './layers/layer.js';
export {
  /** @deprecated Use {@link STTPickInfo}. */
  type STTPickInfo as SttPickInfo,
  /** @deprecated Use {@link STTPickInfoBase}. */
  type STTPickInfoBase as SttPickInfoBase,
  /** @deprecated Use {@link STTBoxPickInfo}. */
  type STTBoxPickInfo as SttBoxPickInfo,
  /** @deprecated Use {@link STTPickable}. */
  type STTPickable as SttPickable,
} from './lib/box-pick.js';
export {
  /** @deprecated Use {@link STTIdPickInfo}. */
  type STTIdPickInfo as SttIdPickInfo,
  /** @deprecated Use {@link STTIdPickable}. */
  type STTIdPickable as SttIdPickable,
  /** @deprecated Use {@link STTIdPickKind}. */
  type STTIdPickKind as SttIdPickKind,
} from './lib/id-pick.js';
export {
  /** @deprecated Use {@link STTSourceRegistry}. */
  type STTSourceRegistry as SttSourceRegistry,
} from './lib/source-registry.js';

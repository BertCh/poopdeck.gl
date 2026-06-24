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
} from './projection/local-enu';
export { MercatorProjection, MAX_MERCATOR_LAT } from './projection/mercator';
export { GlobeProjection } from './projection/globe';
export {
  viewStateToCamera,
  cameraToViewState,
  type ViewState,
  type ViewStateCameraOptions,
} from './projection/view-state';
export {
  frameGlobe,
  setGlobeClip,
  type FrameGlobeOptions,
} from './scene/globe-camera';

// ─── Renderer bootstrap ───────────────────────────────────────────────────────
export {
  createSttRenderer,
  createHighLimitDevice,
  isWebGPUAvailable,
  resolveBackend,
  type CreateRendererOptions,
  type CreatedRenderer,
  type RendererBackend,
} from './renderer/webgpu-renderer';

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
} from './tsl/time-filter-math';
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
} from './tsl/time-filter';

// ─── Engine core ──────────────────────────────────────────────────────────────
export { SttScene, type SttSceneOptions } from './scene/stt-three-scene';
export {
  StandaloneViewer,
  type StandaloneViewerOptions,
} from './viewer/standalone-viewer';
export { SttTileSource, type SttTileSourceOptions, type LoadedSource } from './scene/tile-source';
export { makeGround, type GroundOptions } from './scene/ground';
export { frameBox, type FrameOptions } from './scene/camera';
export {
  BaseSttLayer,
  type SttLayer,
  type SttLayerContext,
} from './layers/layer';

// ─── Surfels (hero) ───────────────────────────────────────────────────────────
export { makeHexDiskGeometry, HEX_CIRCUMRADIUS } from './geometry/hex-disk';
export {
  createSurfelMaterial,
  updateSurfelUniforms,
  SurfelUniforms,
  type SurfelMaterialOptions,
  type SurfelMaterialBundle,
  type SurfelUniformValues,
} from './tsl/surfel-material';
export { SurfelLayer, type SurfelLayerOptions } from './layers/surfel-layer';
export {
  buildSurfelBuffers,
  type SurfelBuffers,
  type SurfelBufferOptions,
} from './layers/surfel-buffers';

// ─── Points (raw / splat / scan / worldbuild) ─────────────────────────────────
export { makeBillboardQuadGeometry } from './geometry/billboard-quad';
export {
  createPointMaterial,
  updatePointUniforms,
  PointUniforms,
  type PointMaterialOptions,
  type PointMaterialBundle,
  type PointUniformValues,
} from './tsl/point-material';
export { PointCloudLayer, type PointCloudLayerOptions } from './layers/point-cloud-layer';
export {
  buildPointBuffers,
  type PointBuffers,
  type PointBufferOptions,
  type PointColorMode,
} from './layers/point-buffers';
export {
  resolveCategoryColor,
  expandCategoricalColors,
  expandRgbColumns,
  rampColorAt,
  expandRampColors,
  type RGBA,
  type CategoricalColorSpec,
  type RampColorSpec,
} from './lib/color';

// ─── Objects (bounding boxes) + maps + ego ────────────────────────────────────
export { BoundingBoxLayer, type BoundingBoxLayerOptions } from './layers/bounding-box-layer';
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
} from './layers/box-tracks';
export {
  writeBoxEdges,
  BOX_CORNERS,
  BOX_EDGES,
  FLOATS_PER_BOX,
} from './geometry/box-edges';
export { StaticPathLayer, type StaticPathLayerOptions } from './layers/path-layer';
export { StaticPolygonLayer, type StaticPolygonLayerOptions } from './layers/polygon-layer';
export { EgoLayer, type EgoLayerOptions, type EgoPose } from './layers/ego-layer';

// ─── Density iso-lines (animated contours) ────────────────────────────────────
export {
  createIsoLineMaterial,
  updateIsoLineUniforms,
  type IsoLineMaterialOptions,
  type IsoLineMaterialBundle,
  type IsoLineUniforms,
  type IsoLineUniformValues,
} from './tsl/iso-line-material';
export { IsoLayer, type IsoLayerOptions } from './layers/iso-layer';

// ════════════════════════════════════════════════════════════════════════════
//  GEOGRAPHIC LAYERS (deck parity) — render the non-AV showcase demos in Three
//  under MercatorProjection / GlobeProjection. See docs/roadmap/three-renderer-parity.md
// ════════════════════════════════════════════════════════════════════════════

// Point geo-parity: continuous ramp colour + pixel-radius sizing.
export type { PointSizeUnits } from './tsl/point-material';

// ─── Wide lines (screen-pixel ribbons: Path / OD-Line / Trips / Corridor) ──────
export {
  createWideLineMaterial,
  updateWideLineUniforms,
  WideLineUniforms,
  type WideLineMode,
  type WideLineMaterialOptions,
  type WideLineMaterialBundle,
  type WideLineUniformValues,
} from './tsl/wide-line-material';
export { makeSegmentQuadGeometry } from './geometry/segment-quad';
export {
  buildLineSegmentBuffers,
  type LineColorMode,
  type LineSegmentBufferOptions,
  type LineSegmentBuffers,
} from './lib/geo-line-buffers';
export { WideLineLayer, type WideLineLayerOptions } from './layers/wide-line-layer';
export { PathGeoLayer, type PathGeoLayerOptions } from './layers/path-geo-layer';
export { OdLineLayer, type OdLineLayerOptions } from './layers/od-line-layer';
export {
  deriveSourceTargetPositions,
  buildOdLineSegmentBuffers,
  type SourceTargetPositions,
} from './lib/od-positions';

// ─── Trips (animated trail-mode trajectories) ──────────────────────────────────
export { TripsLayer, type TripsLayerOptions } from './layers/trips-layer';
export {
  buildTripsBuffers,
  synthesizeVertexTimes,
  type TripsColorMode,
  type TripsBufferOptions,
  type TripsBuffers,
} from './lib/trips-buffers';
export {
  buildTripIndex,
  sampleHead,
  sampleHeads,
  type Trip,
  type TripIndex,
  type Head,
} from './lib/trip-heads';
export { TripHeadsLayer, type TripHeadsLayerOptions } from './layers/trip-heads-layer';

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
} from './tsl/arc-material';
export { ArcLayer, type ArcLayerOptions } from './layers/arc-layer';
export {
  buildArcBuffers,
  type ArcColorMode,
  type ArcBufferOptions,
  type ArcBuffers,
} from './lib/arc-buffers';

// ─── Icons (directional billboard markers) ─────────────────────────────────────
export {
  createIconMaterial,
  updateIconUniforms,
  IconUniforms,
  type IconMode,
  type IconMaterialOptions,
  type IconMaterialBundle,
  type IconUniformValues,
} from './tsl/icon-material';
export { IconLayer, type IconLayerOptions } from './layers/icon-layer';
export {
  buildIconBuffers,
  type IconMappingEntry,
  type IconColorMode,
  type IconBufferOptions,
  type IconBuffers,
} from './lib/icon-buffers';

// ─── Columns (extruded 3D bars) ────────────────────────────────────────────────
export {
  createColumnMaterial,
  updateColumnUniforms,
  ColumnUniforms,
  type ColumnMaterialOptions,
  type ColumnMaterialBundle,
  type ColumnUniformValues,
} from './tsl/column-material';
export {
  makeColumnPrismGeometry,
  circumradiusForIncircle,
} from './geometry/column-prism';
export { ColumnLayer, type ColumnLayerOptions } from './layers/column-layer';
export {
  buildColumnBuffers,
  type ColumnColorMode,
  type ColumnBufferOptions,
  type ColumnBuffers,
} from './lib/column-buffers';

// ─── Polygons (animated fill + extrude; StaticPolygonLayer extends this) ────────
export {
  createPolygonMaterial,
  updatePolygonUniforms,
  type PolygonTimeMode,
  type PolygonMaterialOptions,
  type PolygonUniforms,
  type PolygonMaterialBundle,
  type PolygonUniformValues,
} from './tsl/polygon-material';
export { PolygonLayer, type PolygonLayerOptions } from './layers/polygon-layer';
export {
  buildPolygonBuffers,
  type PolygonColorMode,
  type PolygonBufferOptions,
  type PolygonBuffers,
} from './layers/polygon-buffers';

// ─── Summary tier: Quadbin cells ───────────────────────────────────────────────
export {
  quadbinToTile,
  tileToBounds,
  cellBoundsFromTile,
  type QuadbinTile,
  type CellBounds,
} from './lib/quadbin-cell';
export {
  buildQuadbinBuffers,
  rampBucketColor,
  DEFAULT_QUADBIN_COLOR_RANGE,
  type QuadbinBufferOptions,
  type QuadbinBuffers,
} from './lib/quadbin-buffers';
export {
  QuadbinSummaryLayer,
  type QuadbinSummaryLayerOptions,
} from './layers/quadbin-summary-layer';

// ─── Summary tier: H3 hexagons ─────────────────────────────────────────────────
export {
  h3IndexFromTile,
  cellBoundaryFromTile,
  type H3Boundary,
} from './lib/h3-cell';
export {
  buildH3Buffers,
  DEFAULT_H3_COLOR_RANGE,
  type H3BufferOptions,
  type H3Buffers,
} from './lib/h3-buffers';
export {
  H3SummaryLayer,
  type H3SummaryLayerOptions,
} from './layers/h3-summary-layer';

// ─── Flowmap family (tapered OD arrows + value-over-time corridors) ─────────────
export {
  createFlowArrowMaterial,
  updateFlowArrowUniforms,
  FlowArrowUniforms,
  type FlowArrowMaterialOptions,
  type FlowArrowMaterialBundle,
  type FlowArrowUniformValues,
} from './tsl/flow-arrow-material';
export {
  makeArrowTemplateGeometry,
  ARROW_TEMPLATE_POSITIONS,
} from './geometry/arrow-template';
export { FlowmapLayer, type FlowmapLayerOptions } from './layers/flowmap-layer';
export {
  buildFlowmapBuffers,
  type FlowmapBufferOptions,
  type FlowmapBuffers,
} from './lib/flowmap-buffers';
export {
  createFlowCorridorMaterial,
  updateFlowCorridorUniforms,
  FlowCorridorUniforms,
  type FlowCorridorMaterialOptions,
  type FlowCorridorMaterialBundle,
  type FlowCorridorUniformValues,
} from './tsl/flow-corridor-material';
export {
  FlowCorridorLayer,
  type FlowCorridorLayerOptions,
} from './layers/flow-corridor-layer';
export {
  buildFlowCorridorBuffers,
  bucketPosFromTime,
  type BucketAxis,
  type FlowCorridorBufferOptions,
  type FlowCorridorBuffers,
} from './lib/flow-corridor-buffers';

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
  type DrivableTileset,
  type RunwayTileset,
} from './scene/streaming-tile-source';

// ─── Basemap (host-owned maplibre overlay sync + globe earth sphere) ───────────
export {
  BasemapOverlay,
  type BasemapLike,
  type BasemapOverlayOptions,
} from './scene/basemap-overlay';
export {
  makeGlobeBasemap,
  GLOBE_BASEMAP_INSET,
  type GlobeBasemapOptions,
} from './scene/globe-basemap';

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
} from './lib/gpu-pick';

// ─── Picking (click-to-inspect) ───────────────────────────────────────────────
export {
  rayObbHit,
  pickBoxes,
  type Vec3,
  type SttPickInfo,
  type PickBox,
  type SttPickable,
} from './lib/box-pick';

// ─── Playback governor registration ────────────────────────────────────────────
export {
  createCompleteBufferSource,
  type SttSourceRegistry,
} from './lib/source-registry';

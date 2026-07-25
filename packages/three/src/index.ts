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
 * deprecated aliases at the bottom of this file until 0.8.0.
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
  SttScene,
  type SttSceneOptions,
  type AddLayerOptions,
} from './scene/stt-three-scene.js';
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
// `SttScene` builds the ground for you from its `ground` option; the `makeGround`
// factory itself is authoring-only (`@poopdeck.gl/three/internal`).
export { type GroundOptions } from './scene/ground.js';
export {
  isGlobeProjection,
  rigModeFor,
  resolveCanvasProjection,
  globeControlLimits,
  type RigMode,
} from './scene/projection-rig.js';
// The layer CONTRACT. `BaseSttLayer`, the class you extend to implement it, is
// authoring-only (`@poopdeck.gl/three/internal`).
export { type SttLayer, type SttLayerContext } from './layers/layer.js';

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
  STTPointCloudLayer,
  type STTPointCloudLayerOptions,
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
  type SttPickInfo,
  type SttPickInfoBase,
  type SttBoxPickInfo,
  type SttPointPickInfo,
  type PickBox,
  type SttPickable,
} from './lib/box-pick.js';
// GPU id-buffer picking catalog: the kind-agnostic contract every instanced
// layer implements to become pickable (SttIdPickable + SttIdPickInfo), the pure
// merged-index → SttIdPickInfo resolution seam (resolveIdPick), the provenance
// tile-key helpers, and the auto-registration test (isIdPickable).
export {
  resolveIdPick,
  isIdPickable,
  featureTileKey,
  parseIdTileKey,
  type SttIdPickInfo,
  type SttIdPickable,
  type SttIdPickKind,
  type ResolveIdPickParams,
} from './lib/id-pick.js';
// Lower-level point index → SttPickResult resolution (predates the catalog;
// resolveIdPick is the general path new kinds use).
export {
  resolvePointPick,
  parsePointTileKey,
  type ResolvePointPickParams,
} from './lib/point-pick.js';

// ─── Playback governor registration ────────────────────────────────────────────
export {
  createCompleteBufferSource,
  type SttSourceRegistry,
} from './lib/source-registry.js';

// ─── Backend capability descriptor (renderer-abstraction Phase 5) ───────────────
export { threeBackend } from './backend-descriptor.js';

// ════════════════════════════════════════════════════════════════════════════
//  DEPRECATED LAYER-CLASS ALIASES (0.6.0) — removal target: 0.8.0
//
//  Until 0.6.0 the layer classes here were UNPREFIXED, so six of them shadowed
//  deck.gl's own exports of the same name (`ArcLayer`, `IconLayer`,
//  `ColumnLayer`, `PolygonLayer`, `PointCloudLayer` from `@deck.gl/layers`;
//  `TripsLayer` from `@deck.gl/geo-layers`) and four more shadowed
//  `@poopdeck.gl/layers` (`FlowmapLayer`, `FlowCorridorLayer`, `H3SummaryLayer`,
//  `QuadbinSummaryLayer`). Importing this package alongside deck — the normal
//  case, since deck is the primary backend — meant whichever import came last
//  silently won.
//
//  Every layer class now carries the `STT` prefix, the same convention
//  `@poopdeck.gl/maplibre` and `@poopdeck.gl/cesium` use, so a layer kind has
//  ONE spelling across all backends. The old names keep working (they are the
//  identical class / type, not a copy) but are deprecated; the JSDoc below is
//  attached to each export SPECIFIER, which is the form TypeScript actually
//  honours — a `@deprecated` block above an `export … from` statement is
//  silently ignored, so consumers get a real IDE strikethrough here.
// ════════════════════════════════════════════════════════════════════════════

export {
  /** @deprecated Renamed to {@link STTSurfelLayer} in 0.6.0 (unprefixed layer names are removed in 0.8.0). */
  STTSurfelLayer as SurfelLayer,
  /** @deprecated Renamed to {@link STTSurfelLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTSurfelLayerOptions as SurfelLayerOptions,
} from './layers/surfel-layer.js';
export {
  /** @deprecated Renamed to {@link STTPointCloudLayer} in 0.6.0 — the old name shadowed `PointCloudLayer` from `@deck.gl/layers` (removed in 0.8.0). */
  STTPointCloudLayer as PointCloudLayer,
  /** @deprecated Renamed to {@link STTPointCloudLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTPointCloudLayerOptions as PointCloudLayerOptions,
} from './layers/point-cloud-layer.js';
export {
  /** @deprecated Renamed to {@link STTBoundingBoxLayer} in 0.6.0 (removed in 0.8.0). */
  STTBoundingBoxLayer as BoundingBoxLayer,
  /** @deprecated Renamed to {@link STTBoundingBoxLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTBoundingBoxLayerOptions as BoundingBoxLayerOptions,
} from './layers/bounding-box-layer.js';
export {
  /** @deprecated Renamed to {@link STTStaticPathLayer} in 0.6.0 (removed in 0.8.0). */
  STTStaticPathLayer as StaticPathLayer,
  /** @deprecated Renamed to {@link STTStaticPathLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTStaticPathLayerOptions as StaticPathLayerOptions,
} from './layers/path-layer.js';
export {
  /** @deprecated Renamed to {@link STTStaticPolygonLayer} in 0.6.0 (removed in 0.8.0). */
  STTStaticPolygonLayer as StaticPolygonLayer,
  /** @deprecated Renamed to {@link STTStaticPolygonLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTStaticPolygonLayerOptions as StaticPolygonLayerOptions,
  /** @deprecated Renamed to {@link STTPolygonLayer} in 0.6.0 — the old name shadowed `PolygonLayer` from `@deck.gl/layers` (removed in 0.8.0). */
  STTPolygonLayer as PolygonLayer,
  /** @deprecated Renamed to {@link STTPolygonLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTPolygonLayerOptions as PolygonLayerOptions,
} from './layers/polygon-layer.js';
export {
  /** @deprecated Renamed to {@link STTEgoLayer} in 0.6.0 (removed in 0.8.0). */
  STTEgoLayer as EgoLayer,
  /** @deprecated Renamed to {@link STTEgoLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTEgoLayerOptions as EgoLayerOptions,
} from './layers/ego-layer.js';
export {
  /** @deprecated Renamed to {@link STTIsoLayer} in 0.6.0 (removed in 0.8.0). */
  STTIsoLayer as IsoLayer,
  /** @deprecated Renamed to {@link STTIsoLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTIsoLayerOptions as IsoLayerOptions,
} from './layers/iso-layer.js';
export {
  /** @deprecated Renamed to {@link STTWideLineLayer} in 0.6.0 (removed in 0.8.0). */
  STTWideLineLayer as WideLineLayer,
  /** @deprecated Renamed to {@link STTWideLineLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTWideLineLayerOptions as WideLineLayerOptions,
} from './layers/wide-line-layer.js';
export {
  /** @deprecated Renamed to {@link STTPathGeoLayer} in 0.6.0 (removed in 0.8.0). */
  STTPathGeoLayer as PathGeoLayer,
  /** @deprecated Renamed to {@link STTPathGeoLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTPathGeoLayerOptions as PathGeoLayerOptions,
} from './layers/path-geo-layer.js';
export {
  /** @deprecated Renamed to {@link STTOdLineLayer} in 0.6.0 (removed in 0.8.0). */
  STTOdLineLayer as OdLineLayer,
  /** @deprecated Renamed to {@link STTOdLineLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTOdLineLayerOptions as OdLineLayerOptions,
} from './layers/od-line-layer.js';
export {
  /** @deprecated Renamed to {@link STTTripsLayer} in 0.6.0 — the old name shadowed `TripsLayer` from `@deck.gl/geo-layers` (removed in 0.8.0). */
  STTTripsLayer as TripsLayer,
  /** @deprecated Renamed to {@link STTTripsLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTTripsLayerOptions as TripsLayerOptions,
} from './layers/trips-layer.js';
export {
  /** @deprecated Renamed to {@link STTTripHeadsLayer} in 0.6.0 (removed in 0.8.0). */
  STTTripHeadsLayer as TripHeadsLayer,
  /** @deprecated Renamed to {@link STTTripHeadsLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTTripHeadsLayerOptions as TripHeadsLayerOptions,
} from './layers/trip-heads-layer.js';
export {
  /** @deprecated Renamed to {@link STTArcLayer} in 0.6.0 — the old name shadowed `ArcLayer` from `@deck.gl/layers` (removed in 0.8.0). */
  STTArcLayer as ArcLayer,
  /** @deprecated Renamed to {@link STTArcLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTArcLayerOptions as ArcLayerOptions,
} from './layers/arc-layer.js';
export {
  /** @deprecated Renamed to {@link STTIconLayer} in 0.6.0 — the old name shadowed `IconLayer` from `@deck.gl/layers` (removed in 0.8.0). */
  STTIconLayer as IconLayer,
  /** @deprecated Renamed to {@link STTIconLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTIconLayerOptions as IconLayerOptions,
} from './layers/icon-layer.js';
export {
  /** @deprecated Renamed to {@link STTColumnLayer} in 0.6.0 — the old name shadowed `ColumnLayer` from `@deck.gl/layers` (removed in 0.8.0). */
  STTColumnLayer as ColumnLayer,
  /** @deprecated Renamed to {@link STTColumnLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTColumnLayerOptions as ColumnLayerOptions,
} from './layers/column-layer.js';
export {
  /** @deprecated Renamed to {@link STTQuadbinSummaryLayer} in 0.6.0 — the old name shadowed `@poopdeck.gl/layers` (removed in 0.8.0). */
  STTQuadbinSummaryLayer as QuadbinSummaryLayer,
  /** @deprecated Renamed to {@link STTQuadbinSummaryLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTQuadbinSummaryLayerOptions as QuadbinSummaryLayerOptions,
} from './layers/quadbin-summary-layer.js';
export {
  /** @deprecated Renamed to {@link STTH3SummaryLayer} in 0.6.0 — the old name shadowed `@poopdeck.gl/layers` (removed in 0.8.0). */
  STTH3SummaryLayer as H3SummaryLayer,
  /** @deprecated Renamed to {@link STTH3SummaryLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTH3SummaryLayerOptions as H3SummaryLayerOptions,
} from './layers/h3-summary-layer.js';
export {
  /** @deprecated Renamed to {@link STTFlowmapLayer} in 0.6.0 — the old name shadowed `@poopdeck.gl/layers` (removed in 0.8.0). */
  STTFlowmapLayer as FlowmapLayer,
  /** @deprecated Renamed to {@link STTFlowmapLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTFlowmapLayerOptions as FlowmapLayerOptions,
} from './layers/flowmap-layer.js';
export {
  /** @deprecated Renamed to {@link STTFlowCorridorLayer} in 0.6.0 — the old name shadowed `@poopdeck.gl/layers` (removed in 0.8.0). */
  STTFlowCorridorLayer as FlowCorridorLayer,
  /** @deprecated Renamed to {@link STTFlowCorridorLayerOptions} in 0.6.0 (removed in 0.8.0). */
  type STTFlowCorridorLayerOptions as FlowCorridorLayerOptions,
} from './layers/flow-corridor-layer.js';

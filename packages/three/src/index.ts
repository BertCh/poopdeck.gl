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
  projectPositionsToEnu,
  type Projection,
  type GeoAnchor,
} from './projection/local-enu';

// ─── Renderer bootstrap ───────────────────────────────────────────────────────
export {
  createSttRenderer,
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
  type RGBA,
  type CategoricalColorSpec,
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

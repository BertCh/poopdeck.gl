// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * @poopdeck.gl/core — read SpatioTemporal Tiles archives in the browser.
 */

// ─── Types ──────────────────────────────────────────────────────────────────
export type {
  ArchiveIndex,
  ArchiveMetadata,
  ArchiveOptions,
  BinaryFeatures,
  BoundingBox,
  STTTileLayer,
  LayerInfo,
  STTPosition,
  STTPosition2D,
  STTPosition3D,
  PropertyInfo,
  SelectionCost,
  SpatialIndex,
  SttLoadOptions,
  SummaryColumn,
  SummaryTier,
  SummaryAggregation,
  SummaryScheme,
  TemporalIndex,
  TemporalLodLevel,
  Tile,
  TileEntry,
  TileId,
  TileMetaJson,
  TileRequestOptions,
  TimeRange,
} from './types.js';
export { Compression, GeometryType } from './types.js';

// ─── Tile identity ──────────────────────────────────────────────────────────
// The only producers of a tile's string identity. Every key folds the
// temporal-LOD tier in, so a LOD tile cannot alias the base tile it shares
// `z/x/y/t` with. `tileKey`'s output reaches the OPFS cache, making its
// format a persistence contract. `tileLayerKey` composes it with a layer name
// for the in-memory per-(tile, layer) registries every renderer keeps, and is
// exported so no backend re-derives that spelling and drifts from the rest.
export {
  tileKey,
  tileEntryKey,
  tileCellKey,
  parseTileKey,
} from './tile-key.js';
// Camera-derived viewport boxes are made safe in exactly ONE place, shared by
// all four backends — see `docs/roadmap/tile-loading-3d-2026-07.md` §4.1.
export {
  normalizeViewportBounds,
  boundsFromCorners,
  MAX_SEAM_SPAN_DEG,
  type NormalizedViewportBounds,
  type ViewportBoundsIssue,
} from './geo/viewport-bounds.js';
// The frustum → quadtree-cut cover primitive (Wave 3/A1). Turns "one integer
// zoom for the whole screen" into a per-branch cut; INERT until a chassis
// consumes it. Returns `null` — never an empty list — whenever it cannot vouch
// for the cover, which is the same fail-open discipline `normalizeViewportBounds`
// established: the incumbent AABB path is a strict superset.
export {
  coverFrustumQuadtree,
  lonLatToCoverPoint,
  coverPointToLonLat,
  DEFAULT_MAX_COVER_CELLS,
  MAX_COVER_ZOOM,
  MAX_WORLD_COPIES,
  type FrustumPlane,
  type FrustumCoverOptions,
} from './geo/frustum-cover.js';
export type { TileKey, TileEntryKey, TileCellKey } from './tile-key.js';
export { tileLayerKey } from './render/track-kernel.js';

// ─── Default color palettes (pure data, shared by every renderer) ────────────
// The single source of truth for the categorical / heatmap defaults; imported
// by both @poopdeck.gl/layers (deck) and @poopdeck.gl/maplibre so the two
// backends paint identical default colors without hand-copied literals.
export {
  DEFAULT_CATEGORICAL_PALETTE,
  DEFAULT_LINE_PALETTE,
  DEFAULT_POLYGON_PALETTE,
  DEFAULT_TRIPS_PALETTE,
  DEFAULT_HEATMAP_COLOR_RANGE,
  DEFAULT_ARC_SOURCE_COLOR,
  DEFAULT_ARC_TARGET_COLOR,
  DEFAULT_SUMMARY_COLOR_RANGE,
  type PaletteRGBA,
} from './palettes.js';

// ─── Track kernel (CPU motion-glide engine, framework-free) ─────────────────
// Pool-by-id + per-frame interpolation for "one smooth-moving instance per
// tracked object" rendering (motion glide, trip heads, AV boxes/meshes).
// Lives here, not in @poopdeck.gl/layers, so deck, maplibre/mapbox, three and
// Cesium share ONE implementation; the deck package re-exports this module
// from `src/lib/track-kernel.ts` for source compatibility.
export {
  buildTrackIndex,
  sampleTrack,
  lerp,
  lerpAngle,
  lerpAngleDeg,
  lerpDim,
  readCategorical,
  resolveColor,
  makePickRow,
  TrackIndexMaintainer,
  RAD_TO_DEG,
  METERS_PER_DEG_LAT,
  SINGLETON_HOLD_MS,
  DEFAULT_TRACK_COLOR,
} from './render/track-kernel.js';
export type {
  Track,
  Sample,
  TrackColor,
  TrackPickRow,
  TrackFieldConfig,
  TrackSampleConfig,
  TrackIndexResult,
} from './render/track-kernel.js';

// ─── Motion modes (opt-in interpolation/extrapolation vocabulary) ────────────
// `TrackSampleConfig.motion` selects HOW a pose moves between keyframes and
// whether it may be predicted past the last one: 'linear' (the shipped
// lerp, byte for byte), 'velocity' (continue on the entity's own speed +
// course), 'great-circle' (slerp the bracket). Speed and angle units are
// declared per config because none of them travel with the archive. The
// spherical geodesy the modes rest on is exported from `@poopdeck.gl/core/geo`.
// See docs/roadmap/renderer-architecture.md §2.15.
export {
  MOTION_MODES,
  resolveMotionConfig,
  deriveMotionState,
  toMps,
  toCompassDeg,
  fromCompassDeg,
} from './render/track-kernel.js';
export type {
  MotionMode,
  MotionConfig,
  ResolvedMotionConfig,
  MotionState,
  CourseConvention,
  SpeedUnit,
} from './render/track-kernel.js';
export {
  SPHERE_RADIUS_M,
  wrapLonDeg,
  shortestLonDeltaDeg,
  haversineMeters,
  initialBearingDeg,
  destinationPoint,
  interpolateGreatCircle,
  greatCircleCourseDeg,
  type LonLat,
} from './geo/spherical.js';

// ─── Viewport cell budget (3D tile-selection cost cap) ──────────────────────
// A four-corner viewport box around a strongly pitched frustum inflates faster
// than the frame it bounds (832 cells at pitch 85 / z8 against ~12 flat). This
// spends the excess as ONE COARSER ZOOM rather than as hundreds of fetches,
// keeping the selection complete — see docs/roadmap/tile-loading-3d-2026-07.md
// §4.4. Deliberately NOT under `./geo`: it is built on `archive.ts`'s own tile
// arithmetic, and `./geo` is the framework-free projection kernel three and
// Cesium import — it must not pull the archive reader in behind it.
export {
  DEFAULT_VIEWPORT_CELL_BUDGET,
  DEFAULT_CELL_BUDGET_HYSTERESIS,
  viewportCellCount,
  fitZoomToCellBudget,
  type CellBudgetOptions,
} from './tile-budget.js';

// ─── Archive / tileset / tile decoding ──────────────────────────────────────
export {
  STTArchive,
  estimateTileSize,
  KNOWN_MANIFEST_CAPABILITIES,
} from './archive.js';
// Packed-format manifest contract (mirrors Rust `pack::Manifest`; schema at
// docs/spec/manifest.schema.json). `ManifestSchemaTemplate` is the
// formatVersion-3 `schemas` table entry (spec §3.2).
export type {
  PackedManifest,
  ManifestDirectoryRef,
  ManifestPackRef,
  ManifestSchemaTemplate,
} from './archive.js';
export { SpatioTemporalTileset } from './spatiotemporal-tileset.js';
export type {
  BufferedRunway,
  OverviewPreloadResult,
  SpatioTemporalTileHeader,
  SpatioTemporalTilesetOptions,
  TileBatchHooks,
  TileTier,
  TilesetCacheStats,
} from './spatiotemporal-tileset.js';

// ─── Deprecated spelling aliases (`Spatiotemporal*` → `SpatioTemporal*`) ─────
// The project noun was published two ways: `SpatioTemporal` (capital T) in
// `@poopdeck.gl/layers` and `Spatiotemporal` (lowercase t) here. `SpatioTemporal`
// won: it matches the product name "SpatioTemporal Tiles" used throughout the
// docs and at the top of this file, and it matches the more-referenced public
// class (the docs name `SpatioTemporalLayer` 64 times vs `SpatiotemporalTileset`
// 33). The old spellings stay exported so published consumers keep compiling.
/**
 * @deprecated Use {@link SpatioTemporalTileset}. The `Spatiotemporal` spelling
 * is kept only for backward compatibility and will be removed in a future major.
 */
export { SpatioTemporalTileset as SpatiotemporalTileset } from './spatiotemporal-tileset.js';
export type {
  /**
   * @deprecated Use {@link SpatioTemporalTilesetOptions}.
   */
  SpatioTemporalTilesetOptions as SpatiotemporalTilesetOptions,
  /**
   * @deprecated Use {@link SpatioTemporalTileHeader}.
   */
  SpatioTemporalTileHeader as SpatiotemporalTileHeader,
} from './spatiotemporal-tileset.js';

export { decodeTile, getFeatureProperties, toGeoArrowTable } from './tile.js';
// Packed formatVersion-3 decode plumbing: the schema-template registry built
// from `manifest.schemas` at open (spec §3.2) and the decodeTile options that
// carry it + the declared formatVersion (spec §5.2 authority rule).
export type { TemplateRegistry, DecodeTileOptions } from './tile.js';

// ─── Throughput estimation (player buffering) ───────────────────────────────
export {
  ThroughputEstimator,
  type ThroughputEstimate,
  type ThroughputEstimatorOptions,
} from './throughput.js';

// ─── Shared request scheduler (multi-source coordination, Phase 2) ──────────
// Process-shareable global concurrency budget allocated across N sources by
// dynamic priority (lower value = higher priority; <0 cancels) + Deficit-Round-
// Robin weighted-fair share. Wired into the archive's range-fetch hot path
// via the singleton in `shared-scheduler`.
export {
  SharedRequestScheduler,
  createCancellationError,
  isCancellationError,
  type ScheduleOptions,
  type ScheduledRequest,
  type SchedulerStats,
  type SharedRequestSchedulerOptions,
} from './request-scheduler.js';

// ─── Process-shared scheduler singleton ─────────────────────────────────────
// `getSharedScheduler()` is the one instance every STTArchive draws from;
// `configureSharedScheduler({maxRequests})` re-tunes the global budget.
export {
  getSharedScheduler,
  configureSharedScheduler,
  getSharedSchedulerMaxRequests,
  setSharedSchedulerSourceWeight,
  resetSharedScheduler,
  type ConfigureSharedSchedulerOptions,
} from './shared-scheduler.js';

// ─── Compression ────────────────────────────────────────────────────────────
export { decompress, decompressSync } from './compression.js';

// ─── Integrity (CRC-32C, the directory's per-blob checksum) ──────────────────
export { crc32c, verifyCrc32c } from './crc32c.js';

// ─── Content addressing (blake3-128, the packed format's object/template hash)
export { blake3, blake3Hex128 } from './blake3.js';

// ─── Tile decoder pipeline ──────────────────────────────────────────────────
export {
  InlineTileDecoder,
  WorkerTileDecoder,
  createDefaultTileDecoder,
  type TileDecoder,
  type DecodeArgs,
} from './tile-decoder.js';

// ─── OPFS persistent cache ──────────────────────────────────────────────────
export {
  OpfsTileCache,
  isOpfsAvailable,
  type OpfsIndexEntry,
  type OpfsTileCacheOptions,
} from './opfs-cache.js';

// ─── Probe telemetry (P0-2) ─────────────────────────────────────────────────
// The `__sttProbe` shim and its channel/payload shapes. Exported so a harness
// (the policy trace replayer, the scrub-cost driver) can type the samples it
// reads instead of re-declaring them. Production paths never touch these: with
// no probe bag installed every call is a single property read.
export {
  emit as emitProbeSample,
  snapshot as publishProbeSnapshot,
  isProbeEnabled,
  probeNow,
  recordDecodeWait,
  type CoreProbeChannel,
  type DecodeQueueSnapshot,
  type EvictProbeSample,
  type EvictionTier,
  type RequestProbeSample,
} from './telemetry.js';

// ─── loaders.gl-conformant surfaces ─────────────────────────────────────────
// Structural-only — `@poopdeck.gl/core` has no `@loaders.gl/*` runtime dep.
// `STTArchive.asTileSource()` returns a value matching the v4.x `TileSource`
// interface. (The old `SttLoader` object is gone: its `parse(arrayBuffer)`
// could only reject — the packed multi-object format has no single-buffer
// representation — and its magic sniff matched only the retired single-file
// format. Construct `new STTArchive(manifestUrl)` instead.)
export {
  createSttTileSource,
  type SttGetTileDataParameters,
  type SttGetTileParameters,
  type SttTileSource,
  type SttTileSourceMetadata,
} from './tile-source.js';

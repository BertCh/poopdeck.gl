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
  Layer,
  LayerInfo,
  Position,
  Position2D,
  Position3D,
  PropertyInfo,
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

// ─── Archive / tileset / tile decoding ──────────────────────────────────────
export {
  STTArchive,
  estimateTileSize,
  KNOWN_MANIFEST_CAPABILITIES,
} from './archive.js';
// Packed-format manifest contract (mirrors Rust `pack::Manifest`; schema at
// docs/spec/manifest.schema.json). `ManifestSchemaTemplate` is the
// formatVersion-2 `schemas` table entry (spec §3.2).
export type {
  PackedManifest,
  ManifestDirectoryRef,
  ManifestPackRef,
  ManifestSchemaTemplate,
} from './archive.js';
export { SpatiotemporalTileset } from './spatiotemporal-tileset.js';
export type {
  BufferedRunway,
  OverviewPreloadResult,
  SpatiotemporalTileHeader,
  SpatiotemporalTilesetOptions,
  TileBatchHooks,
  TileTier,
} from './spatiotemporal-tileset.js';
export { decodeTile, getFeatureProperties, toGeoArrowTable } from './tile.js';
// Packed formatVersion-2 decode plumbing: the schema-template registry built
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
// behind the kill-switch in `shared-scheduler`.
export {
  SharedRequestScheduler,
  createCancellationError,
  isCancellationError,
  type ScheduleOptions,
  type ScheduledRequest,
  type SchedulerStats,
  type SharedRequestSchedulerOptions,
} from './request-scheduler.js';

// ─── Process-shared scheduler singleton + kill-switch ───────────────────────
// `getSharedScheduler()` is the one instance every STTArchive draws from;
// `configureSharedScheduler({enabled})` is THE ROLLBACK (default enabled).
export {
  getSharedScheduler,
  configureSharedScheduler,
  isSharedSchedulingEnabled,
  getSharedSchedulerMaxRequests,
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
  type OpfsTileCacheOptions,
} from './opfs-cache.js';

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

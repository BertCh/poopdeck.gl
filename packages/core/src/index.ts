// @stt/core
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/core contributors

/**
 * @stt/core — read SpatioTemporal Tiles archives in the browser.
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
  SummaryColumn,
  SummaryTier,
  SummaryAggregation,
  SummaryScheme,
  TemporalIndex,
  TemporalLodLevel,
  Tile,
  TileEntry,
  TileId,
  TileRequestOptions,
  TimeRange,
} from './types';
export { Compression, GeometryType } from './types';

// ─── Archive / tileset / tile decoding ──────────────────────────────────────
export { STTArchive, estimateTileSize } from './archive';
export { SpatiotemporalTileset } from './spatiotemporal-tileset';
export type {
  SpatiotemporalTileHeader,
  SpatiotemporalTilesetOptions,
  TileTier,
} from './spatiotemporal-tileset';
export { decodeTile, toGeoArrowTable } from './tile';

// ─── Compression ────────────────────────────────────────────────────────────
export { decompress, decompressSync } from './compression';

// ─── Tile decoder pipeline ──────────────────────────────────────────────────
export {
  InlineTileDecoder,
  WorkerTileDecoder,
  createDefaultTileDecoder,
  type TileDecoder,
  type DecodeArgs,
} from './tile-decoder';

// ─── OPFS persistent cache ──────────────────────────────────────────────────
export {
  OpfsTileCache,
  isOpfsAvailable,
  type OpfsTileCacheOptions,
} from './opfs-cache';

// ─── loaders.gl-conformant surfaces ─────────────────────────────────────────
// Structural-only — `@stt/core` has no `@loaders.gl/*` runtime dep. Apps that
// already use loaders.gl can pass `SttLoader` straight to deck.gl's `loaders`
// prop, and `STTArchive.asTileSource()` returns a value matching the v4.x
// `TileSource` interface.
export { SttLoader, type ParsedSTT, type SttLoaderShape } from './stt-loader';
export {
  createSttTileSource,
  type SttGetTileDataParameters,
  type SttGetTileParameters,
  type SttTileSource,
  type SttTileSourceMetadata,
} from './tile-source';

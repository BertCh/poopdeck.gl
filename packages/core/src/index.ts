/**
 * @stt/core — read SpatioTemporal Tiles archives in the browser.
 */

export * from './types';
export * from './archive';
export * from './tile';
// `toGeoArrowTable` is part of `./tile`, but spell it out so a grep for the
// public GeoArrow-interop surface lands somewhere.
export { toGeoArrowTable } from './tile';
export * from './spatiotemporal-tileset';
export { decompress, decompressSync } from './compression';
export {
  InlineTileDecoder,
  WorkerTileDecoder,
  createDefaultTileDecoder,
  type TileDecoder,
  type DecodeArgs,
} from './tile-decoder';
export {
  OpfsTileCache,
  isOpfsAvailable,
  type OpfsTileCacheOptions,
} from './opfs-cache';

// loaders.gl-conformant surfaces. Structural-only — `@stt/core` has no
// `@loaders.gl/*` runtime dep. Apps that already use loaders.gl can pass
// `SttLoader` straight to deck.gl's `loaders` prop, and `STTArchive.asTileSource()`
// returns a value matching the v4.x `TileSource` interface.
export { SttLoader, type ParsedSTT, type SttLoaderShape } from './stt-loader';
export {
  createSttTileSource,
  type SttTileSource,
  type SttTileSourceMetadata,
  type SttGetTileParameters,
  type SttGetTileDataParameters,
} from './tile-source';

// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * Tileset callback glue — the single adapter that wires an {@link STTArchive} onto
 * the {@link SpatiotemporalTilesetOptions} fetch callbacks. deck's
 * `SpatioTemporalLayer` and three's `StreamingTileSource` each re-wrote this exact
 * `getAvailableTiles` / `getTileData` / `getTileDataBatch` / `getTileByteSize` /
 * `getThroughput` bundle by hand (see docs/roadmap/renderer-abstraction-2026-06.md
 * §1.4 #6); this collapses both to one call. maplibre can use it too. Callers spread
 * the result into their `SpatiotemporalTileset` options and add the layout/lifecycle
 * fields (min/maxZoom, refinementStrategy, onTileLoad/Unload, onBufferChange, …).
 */

import type { STTArchive } from '../archive';
import type { SpatiotemporalTilesetOptions } from '../spatiotemporal-tileset';

/** The fetch-callback subset of {@link SpatiotemporalTilesetOptions} that maps 1:1 to the archive. */
export type TilesetFetchCallbacks = Pick<
  SpatiotemporalTilesetOptions,
  'getAvailableTiles' | 'getTileData' | 'getTileDataBatch' | 'getTileByteSize' | 'getThroughput'
>;

/**
 * Build the archive-backed tileset fetch callbacks. Routes the bulk viewport /
 * prefetch fill through the range coalescer (`getTiles`) and forwards the batch
 * hooks (incremental delivery, fetch-priority, and the cross-source EDF playhead
 * time/direction) so the shared scheduler ranks range-groups comparably across
 * archives.
 */
export function makeTilesetCallbacks(archive: STTArchive): TilesetFetchCallbacks {
  return {
    getAvailableTiles: (bounds, zoom, timeRange) =>
      archive.getTileIdsInBounds(bounds, zoom, timeRange),
    getTileData: (tileId, signal) => archive.getTile(tileId, { signal }),
    getTileDataBatch: (tileIds, signal, hooks) =>
      archive.getTiles(tileIds, {
        signal,
        onTileReady: hooks?.onTileReady,
        fetchPriority: hooks?.fetchPriority,
        playheadTime: hooks?.playheadTime,
        playheadDirection: hooks?.playheadDirection,
        viewportCenter: hooks?.viewportCenter,
      }),
    getTileByteSize: (tileId) => archive.getTileByteSize(tileId),
    getThroughput: () => archive.getThroughputEstimate(),
  };
}

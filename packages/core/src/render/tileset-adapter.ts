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

import type { STTArchive } from '../archive.js';
import type { ArchiveMetadata } from '../types.js';
import type { SpatiotemporalTilesetOptions } from '../spatiotemporal-tileset.js';

/** The fetch-callback subset of {@link SpatiotemporalTilesetOptions} that maps 1:1 to the archive. */
export type TilesetFetchCallbacks = Pick<
  SpatiotemporalTilesetOptions,
  | 'getAvailableTiles'
  | 'getAvailableSummaryTiles'
  | 'getTileData'
  | 'getTileDataBatch'
  | 'getTileByteSize'
  | 'getThroughput'
  | 'setSchedulerWeight'
>;

/**
 * Build the archive-backed tileset fetch callbacks. Routes the bulk viewport /
 * prefetch fill through the range coalescer (`getTiles`) and forwards the batch
 * hooks (incremental delivery, fetch-priority, and the cross-source EDF playhead
 * time/direction) so the shared scheduler ranks range-groups comparably across
 * archives.
 *
 * When `metadata` is supplied AND the archive carries a server-aggregated
 * summary tier (`metadata.summaryTier`), the summary-tile enumerate callback
 * (`getAvailableSummaryTiles`) is wired too, so the tileset's `'auto'` tier
 * dispatch can fall back to a few thousand aggregated cells at low zoom instead
 * of millions of raw features. This is ADDITIVE and capability-gated: callers
 * that omit `metadata` (e.g. deck, which wires its own summary callback from the
 * metadata it already holds) get byte-identical behaviour, and archives without
 * a summary tier never get the callback so `pickTierForZoom` stays `'raw'`.
 */
export function makeTilesetCallbacks(
  archive: STTArchive,
  metadata?: ArchiveMetadata,
): TilesetFetchCallbacks {
  const callbacks: TilesetFetchCallbacks = {
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
    // Governor bandwidth re-balancing (tileset.setBandwidthWeight) reaches the
    // process-shared scheduler through this — without it the hook no-ops.
    setSchedulerWeight: (weight) => archive.setSchedulerWeight(weight),
  };
  // Summary-tier dispatch (capability-gated). Only wire the enumerate callback
  // when the archive actually has a summary tier; the tileset returns 'raw' for
  // every zoom otherwise (getAvailableSummaryTiles absent), so this never
  // changes behaviour for a raw-only archive.
  if (metadata?.summaryTier) {
    callbacks.getAvailableSummaryTiles = (bounds, zoom, timeRange) =>
      archive.getSummaryTileIdsInBounds(bounds, zoom, timeRange);
  }
  return callbacks;
}

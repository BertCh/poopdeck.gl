// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `STTTileSource` — a thin STTArchive-backed loader for one archive.
 *
 * The AV cockpit scenes are small and local (≈20 s spans, a handful of MB per
 * stream), so this renderer takes the simplest correct strategy: **eagerly load
 * every tile in the archive once**, hand the full set to the layer, and let the
 * GPU material cull by time per frame (the surfel temporal Gaussian / the
 * time-filter alpha). No viewport-driven reselection, no per-frame rebuild — the
 * data is fully resident and playback is a pure uniform update.
 *
 * (The deck renderer streams via `SpatioTemporalTileset`; that machinery can be
 * wired here for the heavy multi-km clouds, but it is overkill for scenes this
 * small.)
 */

import { STTArchive, tileKey } from '@poopdeck.gl/core';
import type { ArchiveMetadata, Tile, TileId } from '@poopdeck.gl/core';

export interface STTTileSourceOptions {
  /** Resolved archive manifest URL. */
  url: string;
  /** Custom fetch (e.g. to add auth headers / rewrite the base). */
  fetch?: typeof fetch;
  /**
   * LOD strategy. `'parent-fallback'` (default) loads the single deepest
   * (native) zoom — correct for archives where `maxZoom` is self-sufficient.
   * `'additive'` loads the UNION of every zoom `[minZoom..maxZoom]`: an
   * additive-octree `-lod` bundle materializes each return at exactly ONE home
   * zoom, so a coarse level holds sparse overview points that exist in no other
   * level — loading only `maxZoom` would drop most of the cloud. Mirrors
   * `SpatioTemporalTileset`'s additive union.
   */
  lodMode?: 'parent-fallback' | 'additive';
}

export interface LoadedSource {
  metadata: ArchiveMetadata;
  tiles: Tile[];
}

export class STTTileSource {
  readonly url: string;
  private readonly archive: STTArchive;
  private readonly lodMode: 'parent-fallback' | 'additive';
  private loaded: LoadedSource | null = null;
  private inflight: Promise<LoadedSource> | null = null;

  constructor(opts: STTTileSourceOptions) {
    this.url = opts.url;
    this.lodMode = opts.lodMode ?? 'parent-fallback';
    this.archive = new STTArchive({ url: opts.url, fetch: opts.fetch });
  }

  /** Every decoded tile in the archive's bounds across its full time range. */
  async load(signal?: AbortSignal): Promise<LoadedSource> {
    if (this.loaded) return this.loaded;
    if (this.inflight) return this.inflight;
    this.inflight = this._load(signal);
    try {
      this.loaded = await this.inflight;
      return this.loaded;
    } finally {
      this.inflight = null;
    }
  }

  private async _load(signal?: AbortSignal): Promise<LoadedSource> {
    const metadata = await this.archive.getMetadata();
    if (this.lodMode === 'additive') {
      // Additive octree: each return lives at exactly ONE home zoom, so the
      // resident cloud is the UNION of [minZoom..maxZoom] — load every level and
      // dedupe (mirrors SpatioTemporalTileset's additive union). Loading only
      // maxZoom would drop every coarse-level point.
      const seen = new Set<string>();
      const ids: TileId[] = [];
      for (let z = metadata.minZoom; z <= metadata.maxZoom; z++) {
        const levelIds = await this.archive.getTileIdsInBounds(
          metadata.bounds,
          z,
          metadata.timeRange,
        );
        for (const id of levelIds) {
          // Canonical key — folds in the temporal-LOD tier, so a preview id
          // does not dedupe away its base twin.
          const key = tileKey(id);
          if (seen.has(key)) continue;
          seen.add(key);
          ids.push(id);
        }
      }
      const tiles = (await this.archive.getTiles(ids, { signal })).filter(
        (t): t is Tile => t !== null,
      );
      return { metadata, tiles };
    }
    // Pull every tile at the deepest (native) zoom across the whole span.
    const tiles = await this.archive.getTilesInBounds(
      metadata.bounds,
      metadata.maxZoom,
      metadata.timeRange,
      { signal },
    );
    return { metadata, tiles };
  }

  /** Already-loaded result, if any (sync access for buffer-state reporting). */
  get current(): LoadedSource | null {
    return this.loaded;
  }

  dispose(): void {
    this.loaded = null;
    this.inflight = null;
  }
}

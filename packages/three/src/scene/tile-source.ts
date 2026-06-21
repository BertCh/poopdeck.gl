// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `SttTileSource` — a thin STTArchive-backed loader for one archive.
 *
 * The AV cockpit scenes are small and local (≈20 s spans, a handful of MB per
 * stream), so this renderer takes the simplest correct strategy: **eagerly load
 * every tile in the archive once**, hand the full set to the layer, and let the
 * GPU material cull by time per frame (the surfel temporal Gaussian / the
 * time-filter alpha). No viewport-driven reselection, no per-frame rebuild — the
 * data is fully resident and playback is a pure uniform update.
 *
 * (The deck renderer streams via `SpatiotemporalTileset`; that machinery can be
 * wired here later for the heavy multi-km clouds, but it is overkill for the
 * cockpit milestone.)
 */

import { STTArchive } from '@poopdeck.gl/core';
import type { ArchiveMetadata, Tile } from '@poopdeck.gl/core';

export interface SttTileSourceOptions {
  /** Resolved archive manifest URL. */
  url: string;
  /** Custom fetch (e.g. to add auth headers / rewrite the base). */
  fetch?: typeof fetch;
}

export interface LoadedSource {
  metadata: ArchiveMetadata;
  tiles: Tile[];
}

export class SttTileSource {
  readonly url: string;
  private readonly archive: STTArchive;
  private loaded: LoadedSource | null = null;
  private inflight: Promise<LoadedSource> | null = null;

  constructor(opts: SttTileSourceOptions) {
    this.url = opts.url;
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

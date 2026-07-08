// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * loaders.gl `TileSource`-compatible adapter over `STTArchive`.
 *
 * loaders.gl `TileSource` is 3D (x, y, z); STT tiles are 4D (z, x, y, t).
 * The adapter bridges by picking a time per request:
 *
 *   - `userData.t` (number, ms since epoch) — explicit override, preferred.
 *   - otherwise the midpoint of `metadata.timeRange` — i.e. "the whole
 *     archive's representative tile at (x,y,z)". Good for browse / preview
 *     UIs; not appropriate for animation (use `STTArchive` directly).
 *
 * The shape matches `TileSource` from `@loaders.gl/loader-utils` (v4.x)
 * structurally without forcing a hard dep on any `@loaders.gl/*` package.
 */

import { STTArchive } from './archive.js';
import type { ArchiveMetadata, Tile, TileRequestOptions } from './types.js';

/** `TileSourceMetadata` shape (subset we populate) from loaders.gl v4.x. */
export interface SttTileSourceMetadata {
  format: 'stt';
  formatHeader: ArchiveMetadata;
  name?: string;
  attributions?: string[];
  minZoom?: number;
  maxZoom?: number;
  boundingBox?: [min: [x: number, y: number], max: [x: number, y: number]];
  layer?: {
    name: string;
    layers: { name: string; title?: string }[];
  };
}

/** `GetTileParameters` shape from loaders.gl v4.x. */
export interface SttGetTileParameters {
  z: number;
  x: number;
  y: number;
  layers?: string | string[];
}

/** `GetTileDataParameters` shape from loaders.gl v4.x — deck.gl interop. */
export interface SttGetTileDataParameters {
  index: { x: number; y: number; z: number };
  id?: string;
  bbox?: unknown;
  zoom?: number;
  url?: string | null;
  signal?: AbortSignal;
  /**
   * STT-specific overrides plumbed through deck.gl's `TileLayer` userData.
   * Set `t` to override the archive-midpoint default.
   */
  userData?: { t?: number };
}

/** loaders.gl `TileSource` shape. */
export interface SttTileSource {
  getMetadata(): Promise<SttTileSourceMetadata>;
  getTile(parameters: SttGetTileParameters): Promise<Tile | null>;
  getTileData(parameters: SttGetTileDataParameters): Promise<Tile | null>;
}

/**
 * Wrap an `STTArchive` in a loaders.gl `TileSource`. The adapter is cheap —
 * methods delegate straight to the archive — so callers can construct it
 * per request if they want.
 */
export function createSttTileSource(archive: STTArchive): SttTileSource {
  /** Cached archive time-midpoint, used when no explicit `t` is supplied. */
  let midpointPromise: Promise<number> | undefined;
  const getMidpoint = () => {
    if (!midpointPromise) {
      midpointPromise = archive.getMetadata().then((m) => {
        const { start, end } = m.timeRange;
        return Math.round((start + end) / 2);
      });
    }
    return midpointPromise;
  };

  return {
    async getMetadata(): Promise<SttTileSourceMetadata> {
      const m = await archive.getMetadata();
      const bb = m.bounds;
      return {
        format: 'stt',
        formatHeader: m,
        name: m.name,
        attributions: m.attribution ? [m.attribution] : undefined,
        minZoom: m.minZoom,
        maxZoom: m.maxZoom,
        boundingBox: [
          [bb.minLon, bb.minLat],
          [bb.maxLon, bb.maxLat],
        ],
        layer: m.layers.length
          ? { name: 'stt', layers: m.layers.map((l) => ({ name: l.name })) }
          : undefined,
      };
    },

    async getTile({ x, y, z }: SttGetTileParameters): Promise<Tile | null> {
      const t = await getMidpoint();
      return archive.getTile({ z, x, y, t });
    },

    async getTileData(params: SttGetTileDataParameters): Promise<Tile | null> {
      const { index, signal, userData } = params;
      const t = userData?.t ?? (await getMidpoint());
      const opts: TileRequestOptions | undefined = signal
        ? { signal }
        : undefined;
      return archive.getTile({ z: index.z, x: index.x, y: index.y, t }, opts);
    },
  };
}

/**
 * STT Archive reader using HTTP Range Requests
 */

import { stt } from './proto';
import {
  ArchiveMetadata,
  ArchiveIndex,
  ArchiveOptions,
  Tile,
  TileId,
  TileEntry,
  BoundingBox,
  TimeRange,
  TileRequestOptions,
  Compression,
} from './types';
import { parse } from '@loaders.gl/core';
import { STTLoader } from './stt-loader';

const MAGIC = new Uint8Array([0x53, 0x54, 0x54, 0x01]); // "STT\x01"
const VERSION = 1;
const HEADER_SIZE = 53; // 4 (magic) + 1 (version) + 32 (four u64s) + 16 (reserved)

/** Archive header */
interface ArchiveHeader {
  version: number;
  indexOffset: number;
  indexLength: number;
  metadataOffset: number;
  metadataLength: number;
}

/** STT Archive reader */
export class STTArchive {
  public url: string;
  private fetchFn: typeof fetch;
  private headerCache?: ArchiveHeader;
  private metadataCache?: ArchiveMetadata;
  private indexCache?: ArchiveIndex;
  private tileCache: Map<string, Tile> = new Map();
  private loadOptions?: any;

  constructor(options: ArchiveOptions | string) {
    if (typeof options === 'string') {
      this.url = options;
      this.fetchFn = fetch.bind(globalThis);
    } else {
      this.url = options.url;
      this.fetchFn = options.fetch || fetch.bind(globalThis);
      this.loadOptions = options.loadOptions;
    }
  }

  /** Get archive metadata */
  async getMetadata(): Promise<ArchiveMetadata> {
    if (this.metadataCache) {
      return this.metadataCache;
    }

    const header = await this.getHeader();

    // Fetch metadata using HTTP Range Request
    const response = await this.fetchFn(this.url, {
      headers: {
        Range: `bytes=${header.metadataOffset}-${
          header.metadataOffset + header.metadataLength - 1
        }`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch metadata: ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    
    // Decode Protocol Buffer metadata
    const protoMetadata = stt.Metadata.decode(new Uint8Array(buffer));
    
    this.metadataCache = {
      version: protoMetadata.version || VERSION,
      bounds: protoMetadata.bounds
        ? {
            minLon: protoMetadata.bounds.minLon || -180,
            minLat: protoMetadata.bounds.minLat || -90,
            maxLon: protoMetadata.bounds.maxLon || 180,
            maxLat: protoMetadata.bounds.maxLat || 90,
          }
        : { minLon: -180, minLat: -90, maxLon: 180, maxLat: 90 },
      timeRange: protoMetadata.timeRange
        ? {
            start: Number(protoMetadata.timeRange.start) || 0,
            end: Number(protoMetadata.timeRange.end) || Date.now(),
          }
        : { start: 0, end: Date.now() },
      minZoom: protoMetadata.minZoom || 0,
      maxZoom: protoMetadata.maxZoom || 14,
      layers: (protoMetadata.layers || []).map((l) => ({
        name: l.name || 'default',
        description: l.description || '',
        properties: [],
        geometryTypes: [],
      })),
    };

    console.log('Archive metadata:', {
      minZoom: this.metadataCache.minZoom,
      maxZoom: this.metadataCache.maxZoom,
      timeRange: {
        start: new Date(this.metadataCache.timeRange.start).toISOString(),
        end: new Date(this.metadataCache.timeRange.end).toISOString(),
      },
      bounds: this.metadataCache.bounds,
    });

    return this.metadataCache!
  }

  /** Get archive index */
  async getIndex(): Promise<ArchiveIndex> {
    if (this.indexCache) {
      return this.indexCache;
    }

    const header = await this.getHeader();

    // Fetch index using HTTP Range Request
    const response = await this.fetchFn(this.url, {
      headers: {
        Range: `bytes=${header.indexOffset}-${
          header.indexOffset + header.indexLength - 1
        }`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch index: ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    
    // Decode Protocol Buffer index
    const protoIndex = stt.Index.decode(new Uint8Array(buffer));
    
    this.indexCache = {
      tiles: (protoIndex.tiles || []).map((t): TileEntry => ({
        zoom: t.zoom || 0,
        x: t.x || 0,
        y: t.y || 0,
        timeStart: Number(t.timeStart) || 0,
        timeEnd: Number(t.timeEnd) || 0,
        offset: Number(t.offset) || 0,
        length: t.length || 0,
        featureCount: t.featureCount || 0,
        compression: (t.compression || 0) as Compression,
        uncompressedSize: t.uncompressedSize || 0,
      })),
    };

    return this.indexCache;
  }

  /** Get a specific tile */
  async getTile(
    id: TileId,
    options?: TileRequestOptions
  ): Promise<Tile | null> {
    const cacheKey = this.tileIdToKey(id);

    // Check cache
    if (this.tileCache.has(cacheKey)) {
      return this.tileCache.get(cacheKey)!;
    }

    // Find tile entry in index
    const index = await this.getIndex();
    const entry = index.tiles.find(
      (e) =>
        e.zoom === id.z &&
        e.x === id.x &&
        e.y === id.y &&
        e.timeStart <= id.t &&
        e.timeEnd >= id.t
    );

    if (!entry) {
      return null;
    }

    // Fetch tile data using HTTP Range Request
    const response = await this.fetchFn(this.url, {
      headers: {
        Range: `bytes=${entry.offset}-${entry.offset + entry.length - 1}`,
      },
      signal: options?.signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch tile: ${response.statusText}`);
    }

    const compressed = await response.arrayBuffer();

    // Use loaders.gl parse
    const tile = await parse(compressed, STTLoader, { 
      ...this.loadOptions,
      stt: { 
        tileId: id, 
        compression: entry.compression 
      } 
    });

    // Cache tile
    this.tileCache.set(cacheKey, tile);

    // TODO: Implement cache eviction based on maxCacheSize

    return tile;
  }

  /** Get an iterator for tiles in a bounding box and time range */
  async *getTilesIterator(
    bounds: BoundingBox,
    zoom: number,
    timeRange: TimeRange,
    options?: TileRequestOptions
  ): AsyncIterable<Tile> {
    const tileIds = await this.getTileIdsInBounds(bounds, zoom, timeRange);
    
    for (const id of tileIds) {
      const tile = await this.getTile(id, options);
      if (tile) {
        yield tile;
      }
    }
  }

  /** Get all tiles in a bounding box and time range */
  async getTilesInBounds(
    bounds: BoundingBox,
    zoom: number,
    timeRange: TimeRange,
    options?: TileRequestOptions
  ): Promise<Tile[]> {
    const tileIds = await this.getTileIdsInBounds(bounds, zoom, timeRange);
    
    const tiles: Tile[] = [];
    const promises = tileIds.map(async (id) => {
      const tile = await this.getTile(id, options);
      if (tile) {
        tiles.push(tile);
      }
    });
    
    await Promise.all(promises);
    return tiles;
  }
  
  /** Get available tile IDs in a bounding box and time range (without fetching tile data) */
  async getTileIdsInBounds(
    bounds: BoundingBox,
    zoom: number,
    timeRange: TimeRange
  ): Promise<TileId[]> {
    const index = await this.getIndex();
    const tileCoords = boundsToTiles(bounds, zoom);
    const tileIds: TileId[] = [];
    
    // For each spatial tile coordinate, find ALL temporal tiles that overlap the time range
    for (const [x, y] of tileCoords) {
      // Find all entries that match the spatial coords and overlap with time range
      const matchingEntries = index.tiles.filter(
        (e) =>
          e.zoom === zoom &&
          e.x === x &&
          e.y === y &&
          // Temporal overlap check: tile overlaps if its end is after query start AND its start is before query end
          e.timeEnd >= timeRange.start &&
          e.timeStart <= timeRange.end
      );
      
      // Create TileId from each matching entry
      for (const entry of matchingEntries) {
        tileIds.push({
          z: entry.zoom,
          x: entry.x,
          y: entry.y,
          t: entry.timeStart, // Use tile's actual start time
        });
      }
    }
    
    return tileIds;
  }

  /** Prefetch tiles for smooth animation */
  async prefetch(
    bounds: BoundingBox,
    zoom: number,
    times: number[],
    options?: TileRequestOptions
  ): Promise<void> {
    const tileCoords = boundsToTiles(bounds, zoom);

    // Create prefetch requests for all time + spatial combinations
    const promises: Promise<Tile | null>[] = [];

    for (const [x, y] of tileCoords) {
      for (const t of times) {
        const id: TileId = { z: zoom, x, y, t };
        promises.push(this.getTile(id, options));
      }
    }

    // Fetch all in parallel (browsers will limit concurrency)
    await Promise.all(promises);
  }

  /** Clear tile cache */
  clearCache(): void {
    this.tileCache.clear();
  }

  /** Get header */
  private async getHeader(): Promise<ArchiveHeader> {
    if (this.headerCache) {
      return this.headerCache;
    }

    // Fetch first 56 bytes (header)
    const response = await this.fetchFn(this.url, {
      headers: {
        Range: `bytes=0-${HEADER_SIZE - 1}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch header: ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    const view = new DataView(buffer);

    // Verify magic number
    const magic = new Uint8Array(buffer, 0, 4);
    if (!arraysEqual(magic, MAGIC)) {
      throw new Error('Invalid STT archive: bad magic number');
    }

    // Read version
    const version = view.getUint8(4);
    if (version !== VERSION) {
      throw new Error(`Unsupported STT version: ${version}`);
    }

    // Read offsets and lengths (little-endian)
    const header: ArchiveHeader = {
      version,
      indexOffset: Number(view.getBigUint64(5, true)),
      indexLength: Number(view.getBigUint64(13, true)),
      metadataOffset: Number(view.getBigUint64(21, true)),
      metadataLength: Number(view.getBigUint64(29, true)),
    };

    this.headerCache = header;
    return header;
  }

  private tileIdToKey(id: TileId): string {
    return `${id.z}/${id.x}/${id.y}/${id.t}`;
  }
}

/** Convert bounding box to tile coordinates */
function boundsToTiles(bounds: BoundingBox, zoom: number): [number, number][] {
  const n = 1 << zoom;

  const minX = lonToTileX(bounds.minLon, zoom);
  const maxX = lonToTileX(bounds.maxLon, zoom);
  const minY = latToTileY(bounds.maxLat, zoom); // Y is flipped
  const maxY = latToTileY(bounds.minLat, zoom);

  const tiles: [number, number][] = [];
  for (let x = minX; x <= Math.min(maxX, n - 1); x++) {
    for (let y = minY; y <= Math.min(maxY, n - 1); y++) {
      tiles.push([x, y]);
    }
  }
  return tiles;
}

function lonToTileX(lon: number, zoom: number): number {
  const n = 1 << zoom;
  return Math.floor(((lon + 180) / 360) * n);
}

function latToTileY(lat: number, zoom: number): number {
  const n = 1 << zoom;
  const latRad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}


/**
 * STT archive reader over HTTP Range Requests.
 *
 * Layout (see the Rust `stt-core::archive` module):
 *
 * ```text
 * [ 64-byte header ][ gzip Arrow-IPC tile blobs ][ Arrow-IPC index ][ JSON metadata ]
 * ```
 *
 * The reader fetches the header, then the index table and metadata, then each
 * tile blob with a single Range request. Only compressed bytes are cached
 * here; decoded tiles are owned by the tileset.
 */

import { tableFromIPC } from 'apache-arrow';
import {
  type ArchiveMetadata,
  type ArchiveIndex,
  type ArchiveOptions,
  type Tile,
  type TileId,
  type TileEntry,
  type BoundingBox,
  type TemporalLodLevel,
  type TimeRange,
  type TileRequestOptions,
  type SummaryTier,
  type SummaryColumn,
  Compression,
} from './types';
import { createDefaultTileDecoder, type TileDecoder } from './tile-decoder';
import { OpfsTileCache } from './opfs-cache';
import { decompress } from './compression';
import { createSttTileSource, type SttTileSource } from './tile-source';

/** Magic prefix shared by all STT archives ("STT" + version byte). */
const MAGIC_PREFIX = [0x53, 0x54, 0x54];
/** Highest archive format version this reader understands. */
const FORMAT_VERSION = 3;
const HEADER_SIZE = 64;

const DEFAULT_MAX_CACHE_TILES = 500;
const MOBILE_MAX_CACHE_TILES = 100;
/** Max gap (bytes) between two tile ranges still worth coalescing. */
const RANGE_COALESCE_GAP = 32 * 1024;

function getDeviceAwareCacheSize(): number {
  if (typeof navigator !== 'undefined' && 'deviceMemory' in navigator) {
    const gb = (navigator as any).deviceMemory as number;
    if (gb <= 2) return MOBILE_MAX_CACHE_TILES;
    if (gb <= 4) return Math.floor(DEFAULT_MAX_CACHE_TILES / 2);
  }
  if (
    typeof navigator !== 'undefined' &&
    /mobile|android|iphone|ipad/i.test(navigator.userAgent)
  ) {
    return MOBILE_MAX_CACHE_TILES;
  }
  return DEFAULT_MAX_CACHE_TILES;
}

interface ByteCacheEntry {
  bytes: ArrayBuffer;
  lastAccess: number;
  byteSize: number;
}

/** Parsed archive header. */
interface ArchiveHeader {
  version: number;
  compression: Compression;
  indexOffset: number;
  indexLength: number;
  metadataOffset: number;
  metadataLength: number;
  /**
   * Byte offset of the optional zstd training dictionary (v3 only).
   * Zero for v2 archives and v3 archives written without a dictionary.
   */
  dictionaryOffset: number;
  /** Length of the optional zstd training dictionary in bytes. */
  dictionaryLength: number;
}

/**
 * Estimate a decoded tile's in-memory size (bytes). Exported so the tileset
 * uses one consistent accounting implementation.
 */
export function estimateTileSize(tile: Tile): number {
  let size = 1000; // base overhead
  if (!tile?.layers) return size;
  for (const layer of tile.layers) {
    const f = layer?.features;
    if (!f) continue;
    size += f.positions.byteLength;
    size += f.featureIds.byteLength;
    size += f.startTimes.byteLength;
    size += f.endTimes.byteLength;
    if (f.startIndices) size += f.startIndices.byteLength;
    if (f.vertexTimestamps) size += f.vertexTimestamps.byteLength;
    if (f.globalFeatureIds) size += f.globalFeatureIds.byteLength;
    for (const arr of Object.values(f.numericProps)) size += arr.byteLength;
    for (const { indices, categories } of Object.values(f.categoricalProps)) {
      size += indices.byteLength;
      for (const c of categories) size += c.length * 2 + 16;
    }
  }
  return size;
}

/** STT archive reader. */
export class STTArchive {
  public url: string;
  private fetchFn: typeof fetch;
  private headerCache?: ArchiveHeader;
  private metadataCache?: ArchiveMetadata;
  private indexCache?: ArchiveIndex;

  private byteCache = new Map<string, ByteCacheEntry>();
  private maxCacheTiles: number;
  private currentCacheBytes = 0;
  private maxCacheBytes: number;

  /** "z/x/y" -> temporal entries at that spatial cell. */
  private tileEntryIndex = new Map<string, TileEntry[]>();
  /** "z/x/y/t" -> exact entry. */
  private tileEntryByKey = new Map<string, TileEntry>();

  /** Cached zstd dictionary bytes for v3 archives that ship one. */
  private dictionaryCache?: Uint8Array | null;

  private cacheStats = { hits: 0, misses: 0, evictions: 0 };
  /**
   * OPFS hit/miss counters. Tracked separately from the in-memory byte
   * cache so the HUD can show the two layers independently — a low OPFS
   * hit rate on a returning visitor usually means the archive ETag changed.
   */
  private opfsStats = { hits: 0, misses: 0 };

  // The decoder runs decompress + Arrow IPC parse + binary-feature extraction
  // off the main thread (worker pool) in browsers, inline elsewhere. Lazily
  // constructed so node tests that never call getTile() don't spin a pool.
  private decoder?: TileDecoder;
  private decoderOption?: TileDecoder;

  /**
   * Persistent OPFS cache for decompressed tile payloads. `undefined` when
   * the caller opted out or OPFS isn't reachable; null after construction
   * means "explicitly disabled, do not auto-enable later".
   */
  private opfsCache?: OpfsTileCache;
  /**
   * Stable archive fingerprint captured from the first response (ETag /
   * Last-Modified / Content-Length). Lazily filled by `fetchRange` so an
   * archive that's hot-swapped on the server (different ETag) invalidates
   * the OPFS entry without us hashing the full file.
   */
  private archiveFingerprint?: string;

  constructor(options: ArchiveOptions | string) {
    if (typeof options === 'string') {
      this.url = options;
      this.fetchFn = fetch.bind(globalThis);
    } else {
      this.url = options.url;
      this.fetchFn = options.fetch || fetch.bind(globalThis);
      this.decoderOption = options.decoder;
      // OPFS defaults to OFF. The cache's warm-reload win only materializes
      // when the archive fits in `opfsCacheMaxBytes` AND users revisit the
      // same viewport across reloads. On the cold path it costs a duplicate
      // main-thread zstd decompress per tile (see `writeOpfsAsync`), which
      // hurts initial pan/zoom — the dominant experience for showcase users
      // and for any archive bigger than the cache budget (e.g. the 6.7 GB
      // nyc-taxi-paths.stt vs the 512 MB default). Apps that genuinely
      // benefit opt in explicitly.
      const opfsRequested = options.opfsCache === true;
      if (options.opfsCacheImpl) {
        this.opfsCache = options.opfsCacheImpl;
      } else if (opfsRequested) {
        this.opfsCache = new OpfsTileCache({
          directory: options.opfsCacheDirectory,
          maxBytes: options.opfsCacheMaxBytes,
        });
      }
    }
    this.maxCacheTiles = getDeviceAwareCacheSize();
    this.maxCacheBytes =
      this.maxCacheTiles <= MOBILE_MAX_CACHE_TILES
        ? 256 * 1024 * 1024
        : 512 * 1024 * 1024;
  }


  private getDecoder(): TileDecoder {
    if (this.decoder) return this.decoder;
    this.decoder = this.decoderOption ?? createDefaultTileDecoder();
    return this.decoder;
  }

  /** Release worker resources, if any. */
  finalize(): void {
    this.decoder?.finalize();
    this.decoder = undefined;
  }

  /** Fetch a byte range, validating that the server honoured it. */
  private async fetchRange(
    start: number,
    end: number,
    signal?: AbortSignal
  ): Promise<ArrayBuffer> {
    const response = await this.fetchFn(this.url, {
      headers: { Range: `bytes=${start}-${end}` },
      signal,
    });
    if (!response.ok) {
      throw new Error(`STT archive fetch failed: ${response.status} ${response.statusText}`);
    }
    // A server that ignores Range replies 200 with the whole file — that
    // would silently corrupt every offset-based read.
    if (response.status !== 206) {
      throw new Error(
        `STT archive server ignored Range request (status ${response.status}); ` +
          'HTTP range requests are required.'
      );
    }
    // Snapshot a stable identifier the first time the server tells us one.
    // Prefer ETag (server-chosen, opaque), fall back to Last-Modified, then
    // Content-Range total. This is good enough to bust the OPFS cache when
    // the archive is republished without us hashing the file ourselves.
    if (!this.archiveFingerprint && response.headers) {
      const headers = response.headers as Headers | Record<string, string>;
      const get = (name: string): string | null => {
        if (typeof (headers as Headers).get === 'function') {
          return (headers as Headers).get(name);
        }
        const rec = headers as Record<string, string>;
        return rec[name] ?? rec[name.toLowerCase()] ?? null;
      };
      const etag = get('ETag') || get('etag');
      const lastMod = get('Last-Modified') || get('last-modified');
      const contentRange = get('Content-Range') || get('content-range');
      let total: string | null = null;
      if (contentRange) {
        const m = /\/(\d+)$/.exec(contentRange);
        if (m) total = m[1];
      }
      const fp = etag || lastMod || total;
      if (fp) this.archiveFingerprint = fp;
    }
    return response.arrayBuffer();
  }

  /** Read and validate the 64-byte header. Accepts v2 and v3 archives. */
  private async getHeader(): Promise<ArchiveHeader> {
    if (this.headerCache) return this.headerCache;
    const buffer = await this.fetchRange(0, HEADER_SIZE - 1);
    const view = new DataView(buffer);
    const magic = new Uint8Array(buffer, 0, 4);
    for (let i = 0; i < 3; i++) {
      if (magic[i] !== MAGIC_PREFIX[i]) {
        throw new Error('Invalid STT archive: bad magic number');
      }
    }
    const version = view.getUint8(4);
    // The 4th magic byte must also match the version byte — this catches
    // archives whose two version fields drifted out of sync.
    if (magic[3] !== version) {
      throw new Error(
        `Invalid STT archive: magic version byte (${magic[3]}) != header version (${version})`,
      );
    }
    if (version < 2 || version > FORMAT_VERSION) {
      throw new Error(`Unsupported STT format version: ${version}`);
    }
    const compressionByte = view.getUint8(5);
    let compression: Compression;
    switch (compressionByte) {
      case 0:
        compression = Compression.None;
        break;
      case 1:
        compression = Compression.Gzip;
        break;
      case 2:
        compression = Compression.Zstd;
        break;
      default:
        throw new Error(`Unknown STT compression code: ${compressionByte}`);
    }
    // Fields 6..38 are identical across v2 and v3. Fields 38..54 are the
    // dictionary slot in v3 and reserved zero in v2 — reading them either
    // way is correct (v2 will see zeros and produce a dictionary-less
    // header).
    const header: ArchiveHeader = {
      version,
      compression,
      indexOffset: Number(view.getBigUint64(6, true)),
      indexLength: Number(view.getBigUint64(14, true)),
      metadataOffset: Number(view.getBigUint64(22, true)),
      metadataLength: Number(view.getBigUint64(30, true)),
      dictionaryOffset: Number(view.getBigUint64(38, true)),
      dictionaryLength: Number(view.getBigUint64(46, true)),
    };
    this.headerCache = header;
    return header;
  }

  /**
   * Fetch the optional zstd training dictionary embedded in a v3 archive.
   * Returns `null` for v2 archives and v3 archives written without one.
   *
   * The dictionary is cached after the first call — every decode pulls it
   * straight from memory.
   */
  async getDictionary(): Promise<Uint8Array | null> {
    if (this.dictionaryCache !== undefined) return this.dictionaryCache;
    const header = await this.getHeader();
    if (header.version < 3 || header.dictionaryLength === 0) {
      this.dictionaryCache = null;
      return null;
    }
    const buffer = await this.fetchRange(
      header.dictionaryOffset,
      header.dictionaryOffset + header.dictionaryLength - 1,
    );
    this.dictionaryCache = new Uint8Array(buffer);
    return this.dictionaryCache;
  }

  /** Archive metadata (JSON). */
  async getMetadata(): Promise<ArchiveMetadata> {
    if (this.metadataCache) return this.metadataCache;
    const header = await this.getHeader();
    const buffer = await this.fetchRange(
      header.metadataOffset,
      header.metadataOffset + header.metadataLength - 1
    );
    const json = JSON.parse(new TextDecoder().decode(buffer));
    this.metadataCache = {
      version: header.version,
      name: json.name,
      description: json.description,
      attribution: json.attribution,
      bounds: json.bounds
        ? {
            minLon: json.bounds.min_lon,
            minLat: json.bounds.min_lat,
            maxLon: json.bounds.max_lon,
            maxLat: json.bounds.max_lat,
          }
        : { minLon: -180, minLat: -90, maxLon: 180, maxLat: 90 },
      timeRange: json.time_range
        ? { start: json.time_range.start, end: json.time_range.end }
        : { start: 0, end: Date.now() },
      minZoom: json.min_zoom ?? 0,
      maxZoom: json.max_zoom ?? 14,
      layers: (json.layers ?? []).map((name: string) => ({
        name,
        properties: [],
        geometryTypes: [],
      })),
      temporalBucketMs: json.temporal_bucket_ms ?? 3600 * 1000,
      summaryTier: parseSummaryTier(json.summary_tier),
      // The serialized `temporal_lod` field is omitted when unset; readers
      // that don't know about LOD can still parse the metadata blob.
      temporalLod: Array.isArray(json.temporal_lod)
        ? json.temporal_lod.map((l: any) => ({
            bucketMs: Number(l.bucket_ms),
            maxZoomLevel: Number(l.max_zoom_level),
          }))
        : undefined,
    };
    return this.metadataCache;
  }

  /** Archive directory (the tile index, an Arrow table). */
  async getIndex(): Promise<ArchiveIndex> {
    if (this.indexCache) return this.indexCache;
    const header = await this.getHeader();
    const buffer = await this.fetchRange(
      header.indexOffset,
      header.indexOffset + header.indexLength - 1
    );
    const table = tableFromIPC(new Uint8Array(buffer));

    const zoom = table.getChild('zoom')!.toArray() as Uint8Array;
    const x = table.getChild('x')!.toArray() as Uint32Array;
    const y = table.getChild('y')!.toArray() as Uint32Array;
    const timeStart = table.getChild('time_start')!.toArray() as BigInt64Array;
    const timeEnd = table.getChild('time_end')!.toArray() as BigInt64Array;
    const offset = table.getChild('offset')!.toArray() as BigUint64Array;
    const length = table.getChild('length')!.toArray() as Uint32Array;
    const uncompressed = table.getChild('uncompressed_size')!.toArray() as Uint32Array;
    const featureCount = table.getChild('feature_count')!.toArray() as Uint32Array;
    // v3 archives use `crc32c` (UInt32); v2 archives use `content_hash`
    // (UInt64). The TS reader doesn't currently verify the integrity tag
    // client-side (decode failures throw a clear error instead), so we just
    // tolerate either column being absent.
    // (Kept for forward compatibility / debugging tools.)
    void table.getChild('crc32c');
    void table.getChild('content_hash');

    // Optional per-tile temporal bucket size — present only in archives
    // that ship a temporal LOD pyramid. Use the per-element accessor (which
    // returns null for null cells) rather than `.toArray()` so the all-null
    // case stays distinguishable from "bucket = 0".
    const bucketVec = table.getChild('temporal_bucket_ms');

    const tiles: TileEntry[] = [];
    for (let i = 0; i < table.numRows; i++) {
      let temporalBucketMs: number | undefined;
      if (bucketVec) {
        const raw = bucketVec.get(i);
        if (raw != null) temporalBucketMs = Number(raw);
      }
      tiles.push({
        zoom: zoom[i],
        x: x[i],
        y: y[i],
        timeStart: Number(timeStart[i]),
        timeEnd: Number(timeEnd[i]),
        offset: Number(offset[i]),
        length: length[i],
        featureCount: featureCount[i],
        compression: header.compression,
        uncompressedSize: uncompressed[i],
        temporalBucketMs,
      });
    }
    this.indexCache = { tiles };

    this.tileEntryIndex.clear();
    this.tileEntryByKey.clear();
    for (const entry of tiles) {
      const spatialKey = `${entry.zoom}/${entry.x}/${entry.y}`;
      let list = this.tileEntryIndex.get(spatialKey);
      if (!list) {
        list = [];
        this.tileEntryIndex.set(spatialKey, list);
      }
      list.push(entry);
      this.tileEntryByKey.set(
        `${entry.zoom}/${entry.x}/${entry.y}/${entry.timeStart}`,
        entry
      );
    }
    return this.indexCache;
  }

  /** Resolve a TileId to its directory entry. */
  private findTileEntry(id: TileId): TileEntry | undefined {
    const exact = this.tileEntryByKey.get(`${id.z}/${id.x}/${id.y}/${id.t}`);
    if (exact) return exact;
    const entries = this.tileEntryIndex.get(`${id.z}/${id.x}/${id.y}`);
    return entries?.find((e) => e.timeStart <= id.t && e.timeEnd >= id.t);
  }

  private tileIdToKey(id: TileId): string {
    return `${id.z}/${id.x}/${id.y}/${id.t}`;
  }

  /**
   * Build the OPFS cache key for a tile. Includes the archive URL and a
   * stable fingerprint so a redeployed archive (different ETag) doesn't
   * silently serve stale tiles. Returns `null` when the fingerprint isn't
   * known yet — in that case we just skip OPFS for this call; the next one
   * (post-header) will have a fingerprint and start hitting.
   */
  private opfsKey(id: TileId): string | null {
    if (!this.archiveFingerprint) return null;
    return `${this.url}::${id.z}/${id.x}/${id.y}/${id.t}::${this.archiveFingerprint}`;
  }

  /**
   * Persist decompressed bytes to OPFS in the background. Decompressing the
   * payload again on the main thread is wasted CPU on the cold path, but it
   * runs AFTER the tile has been delivered to the caller — so it doesn't
   * block any user-visible work. On every subsequent reload that same key
   * skips both the HTTP fetch and the zstd decompress.
   */
  private async writeOpfsAsync(
    id: TileId,
    entry: TileEntry,
    compressed: ArrayBuffer,
  ): Promise<void> {
    const cache = this.opfsCache;
    if (!cache) return;
    const key = this.opfsKey(id);
    if (!key) return;
    try {
      const decompressed = await decompress(
        new Uint8Array(compressed),
        entry.compression,
      );
      await cache.set(key, decompressed);
    } catch {
      // Best-effort: an OPFS error must never break the data path.
    }
  }

  /** Decode compressed tile bytes into a Tile via the configured decoder. */
  private async decodeBytes(
    id: TileId,
    entry: TileEntry,
    compressed: ArrayBuffer,
  ): Promise<Tile> {
    return this.getDecoder().decode({
      id,
      timeRange: { start: entry.timeStart, end: entry.timeEnd },
      compressed,
      compression: entry.compression,
    });
  }

  /**
   * Decode an already-decompressed payload. Reused for OPFS warm hits — the
   * decoder still has to run the Arrow IPC parse + binary extraction, but
   * it skips the (often zstd) decompression step entirely.
   */
  private async decodeDecompressed(
    id: TileId,
    entry: TileEntry,
    decompressed: Uint8Array,
  ): Promise<Tile> {
    // Copy into a fresh ArrayBuffer — the worker decoder transfers ownership
    // of the buffer, and we may have other consumers (or the OPFS view)
    // still holding the original. The explicit `new ArrayBuffer(...)` is
    // belt-and-braces against a SharedArrayBuffer-backed input slipping in
    // (the decoder protocol requires a transferable buffer).
    const buf = new ArrayBuffer(decompressed.byteLength);
    new Uint8Array(buf).set(decompressed);
    return this.getDecoder().decode({
      id,
      timeRange: { start: entry.timeStart, end: entry.timeEnd },
      compressed: buf,
      compression: Compression.None,
    });
  }

  /** Fetch and decode a single tile. */
  async getTile(id: TileId, options?: TileRequestOptions): Promise<Tile | null> {
    await this.getIndex();
    const entry = this.findTileEntry(id);
    if (!entry) return null;

    const key = this.tileIdToKey(id);
    const cached = this.byteCache.get(key);
    if (cached) {
      cached.lastAccess = Date.now();
      this.cacheStats.hits++;
      return this.decodeBytes(id, entry, cached.bytes);
    }

    // OPFS lookup BEFORE the network. A hit returns decompressed bytes that
    // we can feed straight into the decoder, skipping zstd entirely. Note
    // we also skip storing the bytes back into the in-memory byteCache —
    // they're decompressed, while the in-memory cache holds compressed
    // payloads. Re-fetches inside the same tab will hit OPFS again, which
    // is still very fast.
    const opfsK = this.opfsCache ? this.opfsKey(id) : null;
    if (this.opfsCache && opfsK) {
      const fromOpfs = await this.opfsCache.get(opfsK);
      if (fromOpfs) {
        this.opfsStats.hits++;
        return this.decodeDecompressed(id, entry, fromOpfs);
      }
      this.opfsStats.misses++;
    }

    this.cacheStats.misses++;
    const compressed = await this.fetchRange(
      entry.offset,
      entry.offset + entry.length - 1,
      options?.signal
    );
    this.storeBytes(key, compressed);
    const tile = await this.decodeBytes(id, entry, compressed);
    // Fire-and-forget OPFS write. Slicing the buffer so any later mutation
    // of `compressed` is independent.
    if (this.opfsCache) {
      void this.writeOpfsAsync(id, entry, compressed.slice(0));
    }
    return tile;
  }

  /**
   * Fetch many tiles, coalescing contiguous byte ranges into single requests.
   * Returns tiles in the same order as `ids`; missing tiles are `null`.
   */
  async getTiles(
    ids: TileId[],
    options?: TileRequestOptions
  ): Promise<(Tile | null)[]> {
    await this.getIndex();
    const results: (Tile | null)[] = new Array(ids.length).fill(null);

    interface Pending {
      index: number;
      id: TileId;
      entry: TileEntry;
    }
    let pending: Pending[] = [];
    const jobs: Promise<void>[] = [];

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const entry = this.findTileEntry(id);
      if (!entry) continue;
      const key = this.tileIdToKey(id);
      const cached = this.byteCache.get(key);
      if (cached) {
        cached.lastAccess = Date.now();
        this.cacheStats.hits++;
        const idx = i;
        jobs.push(
          this.decodeBytes(id, entry, cached.bytes).then((t) => {
            results[idx] = t;
          })
        );
      } else {
        this.cacheStats.misses++;
        pending.push({ index: i, id, entry });
      }
    }

    // OPFS lookup phase: every miss against the in-memory cache gets one
    // chance to come from OPFS first. The lookups run concurrently so the
    // batch isn't serialized behind OPFS I/O. A hit on OPFS removes the
    // tile from `pending` so it doesn't get scheduled into a coalesced
    // HTTP range group.
    if (this.opfsCache && pending.length > 0 && this.archiveFingerprint) {
      const opfsResults = await Promise.all(
        pending.map(async (p) => {
          const k = this.opfsKey(p.id);
          if (!k) return null;
          const bytes = await this.opfsCache!.get(k);
          return bytes;
        }),
      );
      const stillPending: Pending[] = [];
      for (let i = 0; i < pending.length; i++) {
        const bytes = opfsResults[i];
        const p = pending[i];
        if (bytes) {
          this.opfsStats.hits++;
          jobs.push(
            this.decodeDecompressed(p.id, p.entry, bytes).then((t) => {
              results[p.index] = t;
            }),
          );
        } else {
          this.opfsStats.misses++;
          stillPending.push(p);
        }
      }
      pending = stillPending;
    }

    if (pending.length > 0) {
      pending.sort((a, b) => a.entry.offset - b.entry.offset);
      interface Group {
        start: number;
        end: number;
        members: Pending[];
      }
      const groups: Group[] = [];
      for (const p of pending) {
        const pStart = p.entry.offset;
        const pEnd = p.entry.offset + p.entry.length - 1;
        const last = groups[groups.length - 1];
        if (last && pStart - (last.end + 1) <= RANGE_COALESCE_GAP) {
          last.end = Math.max(last.end, pEnd);
          last.members.push(p);
        } else {
          groups.push({ start: pStart, end: pEnd, members: [p] });
        }
      }
      for (const group of groups) {
        // Decode all members of a group concurrently. A previous serial
        // `for...of...await` decoded each member in sequence inside the
        // group, which fully serialized large coalesced batches and made
        // `getTiles()` slower than per-tile `getTile()` calls.
        jobs.push(
          this.fetchRange(group.start, group.end, options?.signal).then(
            (buffer) =>
              Promise.all(
                group.members.map(async (m) => {
                  const rel = m.entry.offset - group.start;
                  const slice = buffer.slice(rel, rel + m.entry.length);
                  this.storeBytes(this.tileIdToKey(m.id), slice);
                  results[m.index] = await this.decodeBytes(m.id, m.entry, slice);
                  if (this.opfsCache) {
                    void this.writeOpfsAsync(m.id, m.entry, slice.slice(0));
                  }
                })
              ).then(() => undefined)
          )
        );
      }
    }

    await Promise.all(jobs);
    return results;
  }

  private storeBytes(key: string, bytes: ArrayBuffer): void {
    const existing = this.byteCache.get(key);
    if (existing) this.currentCacheBytes -= existing.byteSize;
    this.byteCache.set(key, {
      bytes,
      lastAccess: Date.now(),
      byteSize: bytes.byteLength,
    });
    this.currentCacheBytes += bytes.byteLength;
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    if (
      this.byteCache.size <= this.maxCacheTiles &&
      this.currentCacheBytes <= this.maxCacheBytes
    ) {
      return;
    }
    const entries = Array.from(this.byteCache.entries());
    entries.sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    for (const [key, entry] of entries) {
      if (
        this.byteCache.size <= this.maxCacheTiles &&
        this.currentCacheBytes <= this.maxCacheBytes
      ) {
        break;
      }
      this.byteCache.delete(key);
      this.currentCacheBytes -= entry.byteSize;
      this.cacheStats.evictions++;
    }
  }

  /**
   * Tile IDs whose interval overlaps `timeRange` within `bounds` at `zoom`.
   *
   * For archives that ship a temporal LOD pyramid, this returns ONLY the
   * base-bucket tiles — i.e. tiles whose `temporalBucketMs` matches the
   * archive's base bucket (or is unset, for legacy archives). Use
   * {@link getTileIdsInBoundsForTemporalLod} to request a coarser LOD
   * level's tiles.
   */
  async getTileIdsInBounds(
    bounds: BoundingBox,
    zoom: number,
    timeRange: TimeRange
  ): Promise<TileId[]> {
    await this.getIndex();
    const meta = await this.getMetadata();
    const baseBucket = meta.temporalBucketMs;
    const filterToBase = meta.temporalLod !== undefined && meta.temporalLod.length > 0;
    const ids: TileId[] = [];
    for (const [x, y] of boundsToTiles(bounds, zoom)) {
      const entries = this.tileEntryIndex.get(`${zoom}/${x}/${y}`);
      if (!entries) continue;
      for (const e of entries) {
        if (filterToBase) {
          // The archive carries LOD tiers; exclude anything that isn't a
          // base-bucket tile so the existing renderer behaviour is
          // preserved (only base tiles flow into the default path).
          const tagged = e.temporalBucketMs;
          if (tagged !== undefined && tagged !== baseBucket) continue;
        }
        if (e.timeEnd >= timeRange.start && e.timeStart <= timeRange.end) {
          ids.push({ z: e.zoom, x: e.x, y: e.y, t: e.timeStart });
        }
      }
    }
    return ids;
  }

  /**
   * Tile IDs for a specific temporal LOD level.
   *
   * `bucketMs` selects which tier of the temporal pyramid to read; pass the
   * value from {@link ArchiveMetadata.temporalLod} (or its
   * `bucketMs` field) — or the archive's base `temporalBucketMs` to get the
   * base tier explicitly.
   *
   * Returns an empty array if the archive has no tiles tagged with that
   * bucket size (i.e. the level was not built into this archive).
   */
  async getTileIdsInBoundsForTemporalLod(
    bounds: BoundingBox,
    zoom: number,
    timeRange: TimeRange,
    bucketMs: number
  ): Promise<TileId[]> {
    await this.getIndex();
    const meta = await this.getMetadata();
    const baseBucket = meta.temporalBucketMs;
    const ids: TileId[] = [];
    for (const [x, y] of boundsToTiles(bounds, zoom)) {
      const entries = this.tileEntryIndex.get(`${zoom}/${x}/${y}`);
      if (!entries) continue;
      for (const e of entries) {
        // The tile matches iff its tagged bucket equals the requested one.
        // Legacy tiles (column absent) are treated as base-bucket tiles —
        // they only match a request for `bucketMs === baseBucket`.
        const tagged = e.temporalBucketMs ?? baseBucket;
        if (tagged !== bucketMs) continue;
        if (e.timeEnd >= timeRange.start && e.timeStart <= timeRange.end) {
          ids.push({ z: e.zoom, x: e.x, y: e.y, t: e.timeStart });
        }
      }
    }
    return ids;
  }

  /** All tiles within a bounding box and time range. */
  async getTilesInBounds(
    bounds: BoundingBox,
    zoom: number,
    timeRange: TimeRange,
    options?: TileRequestOptions
  ): Promise<Tile[]> {
    const ids = await this.getTileIdsInBounds(bounds, zoom, timeRange);
    const tiles = await this.getTiles(ids, options);
    return tiles.filter((t): t is Tile => t !== null);
  }

  /**
   * Tile IDs whose interval overlaps `timeRange` within `bounds` at `zoom`,
   * filtered to the SUMMARY tier when the archive carries one and the
   * requested zoom is inside the summary range.
   *
   * The directory keys are identical to the raw tier (a summary tile shares
   * its (zoom, x, y, t) coordinates with the raw tile that covers the same
   * area at the same zoom). The TS reader distinguishes them only by the
   * layer name carried in the decoded tile payload — so this helper is
   * essentially a convenience wrapper that:
   *
   *   1. Returns an empty list if the archive has no summary tier.
   *   2. Returns an empty list if `zoom` is outside the summary range.
   *   3. Otherwise delegates to `getTileIdsInBounds`.
   *
   * Callers fetch the tiles with the standard `getTiles()` and then keep
   * only the `summary`-named layer (see `isSummaryTile`).
   */
  async getSummaryTileIdsInBounds(
    bounds: BoundingBox,
    zoom: number,
    timeRange: TimeRange,
  ): Promise<TileId[]> {
    const metadata = await this.getMetadata();
    const tier = metadata.summaryTier;
    if (!tier) return [];
    if (zoom < tier.minZoom || zoom > tier.maxZoom) return [];
    return this.getTileIdsInBounds(bounds, zoom, timeRange);
  }

  /**
   * All summary-tier tiles within a bounding box and time range. Returns
   * `[]` if the archive has no summary tier or the zoom is outside the
   * summary range.
   */
  async getSummaryTilesInBounds(
    bounds: BoundingBox,
    zoom: number,
    timeRange: TimeRange,
    options?: TileRequestOptions
  ): Promise<Tile[]> {
    const ids = await this.getSummaryTileIdsInBounds(bounds, zoom, timeRange);
    if (ids.length === 0) return [];
    const tiles = await this.getTiles(ids, options);
    const metadata = await this.getMetadata();
    const layerName = metadata.summaryTier?.layerName ?? 'summary';
    // Drop tiles that don't actually carry a summary layer. The raw and
    // summary tiers share spatial coordinates but raw tiles are NOT
    // expected at the summary zooms when the build wrote both tiers —
    // however we still defend against tiles that mix layers.
    const out: Tile[] = [];
    for (const t of tiles) {
      if (!t) continue;
      const summaryLayers = t.layers.filter((l) => l.name === layerName);
      if (summaryLayers.length === 0) continue;
      out.push({ ...t, layers: summaryLayers });
    }
    return out;
  }

  /**
   * Fetch tiles from a specific temporal LOD level.
   *
   * Convenience wrapper over {@link getTileIdsInBoundsForTemporalLod}.
   */
  async getTilesInBoundsForTemporalLod(
    bounds: BoundingBox,
    zoom: number,
    timeRange: TimeRange,
    bucketMs: number,
    options?: TileRequestOptions
  ): Promise<Tile[]> {
    const ids = await this.getTileIdsInBoundsForTemporalLod(
      bounds,
      zoom,
      timeRange,
      bucketMs,
    );
    const tiles = await this.getTiles(ids, options);
    return tiles.filter((t): t is Tile => t !== null);
  }

  /**
   * Pick the LOD level (`bucketMs`) the reader should request at `zoom`.
   *
   * Returns the coarsest level whose `maxZoomLevel >= zoom`. If no level
   * applies, returns `undefined` — the caller should fall back to base
   * tiles via {@link getTileIdsInBounds}.
   */
  async pickTemporalLodForZoom(zoom: number): Promise<TemporalLodLevel | undefined> {
    const meta = await this.getMetadata();
    const levels = meta.temporalLod;
    if (!levels || levels.length === 0) return undefined;
    let pick: TemporalLodLevel | undefined;
    for (const l of levels) {
      if (zoom <= l.maxZoomLevel) {
        if (!pick || l.bucketMs > pick.bucketMs) pick = l;
      }
    }
    return pick;
  }

  /** Prefetch tiles for a set of bucket times (warms the byte cache). */
  async prefetch(
    bounds: BoundingBox,
    zoom: number,
    times: number[],
    options?: TileRequestOptions
  ): Promise<void> {
    const ids: TileId[] = [];
    for (const [x, y] of boundsToTiles(bounds, zoom)) {
      for (const t of times) ids.push({ z: zoom, x, y, t });
    }
    await this.getTiles(ids, options);
  }

  /** Clear the in-memory compressed-byte cache (does NOT touch OPFS). */
  clearCache(): void {
    this.byteCache.clear();
    this.currentCacheBytes = 0;
  }

  /**
   * Clear the persistent OPFS cache. Use this when the user wants to
   * reclaim disk, or as part of a forced refresh. The in-memory byte cache
   * is left alone — clear that separately with {@link clearCache}.
   */
  async clearOpfsCache(): Promise<void> {
    await this.opfsCache?.clear();
    this.opfsStats = { hits: 0, misses: 0 };
  }

  /** Cache statistics. */
  getCacheStats() {
    const total = this.cacheStats.hits + this.cacheStats.misses;
    const opfsTotal = this.opfsStats.hits + this.opfsStats.misses;
    const opfs = this.opfsCache?.getStats();
    return {
      size: this.byteCache.size,
      maxSize: this.maxCacheTiles,
      bytes: this.currentCacheBytes,
      maxBytes: this.maxCacheBytes,
      hits: this.cacheStats.hits,
      misses: this.cacheStats.misses,
      evictions: this.cacheStats.evictions,
      hitRate: total > 0 ? this.cacheStats.hits / total : 0,
      // OPFS layer stats. Fields are zero / undefined when OPFS isn't
      // enabled, so HUD code can read them unconditionally.
      opfs: opfs
        ? {
            available: opfs.available,
            bytes: opfs.bytes,
            entries: opfs.entries,
            maxBytes: opfs.maxBytes,
            hits: this.opfsStats.hits,
            misses: this.opfsStats.misses,
            hitRate: opfsTotal > 0 ? this.opfsStats.hits / opfsTotal : 0,
          }
        : undefined,
    };
  }

  /**
   * Direct handle to the OPFS cache. Returns `undefined` when OPFS is
   * disabled. Useful for `clear()` from a "wipe cache" UI button.
   */
  getOpfsCache(): OpfsTileCache | undefined {
    return this.opfsCache;
  }

  /**
   * View this archive through the loaders.gl `TileSource` interface so it
   * can be passed to deck.gl `TileLayer` / `MVTLayer`-style consumers. STT
   * is 4D (z, x, y, t); the adapter picks the archive-midpoint time by
   * default — pass `userData.t` in `getTileData()` for explicit control.
   * See {@link createSttTileSource} for details.
   */
  asTileSource(): SttTileSource {
    return createSttTileSource(this);
  }
}

/** Web-Mercator tile coordinates covering a bounding box at a zoom. */
function boundsToTiles(bounds: BoundingBox, zoom: number): [number, number][] {
  const n = 1 << zoom;
  const minX = lonToTileX(bounds.minLon, zoom);
  const maxX = lonToTileX(bounds.maxLon, zoom);
  const minY = latToTileY(bounds.maxLat, zoom); // y is flipped
  const maxY = latToTileY(bounds.minLat, zoom);
  const tiles: [number, number][] = [];
  for (let x = Math.max(0, minX); x <= Math.min(maxX, n - 1); x++) {
    for (let y = Math.max(0, minY); y <= Math.min(maxY, n - 1); y++) {
      tiles.push([x, y]);
    }
  }
  return tiles;
}

function lonToTileX(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * (1 << zoom));
}

function latToTileY(lat: number, zoom: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * (1 << zoom)
  );
}

/**
 * Parse the `summary_tier` block from an archive's JSON metadata into the
 * camelCase TS shape. Returns `undefined` for archives that don't carry one
 * (v2/v3 archives pre-dating the feature).
 */
function parseSummaryTier(raw: unknown): SummaryTier | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const scheme = r.scheme as string | undefined;
  if (scheme !== 'h3' && scheme !== 'quadbin') return undefined;
  const minZoom = Number(r.min_zoom ?? 0);
  const maxZoom = Number(r.max_zoom ?? minZoom);
  const cellResolutionPerZoom = Array.isArray(r.cell_resolution_per_zoom)
    ? (r.cell_resolution_per_zoom as unknown[]).map((v) => Number(v))
    : [];
  const layerName = typeof r.layer_name === 'string' ? r.layer_name : 'summary';
  const cols: SummaryColumn[] = Array.isArray(r.columns)
    ? (r.columns as unknown[])
        .map((c) => {
          if (!c || typeof c !== 'object') return null;
          const cc = c as Record<string, unknown>;
          const name = String(cc.name ?? '');
          const agg = String(cc.agg ?? '');
          if (
            agg !== 'count' &&
            agg !== 'sum' &&
            agg !== 'mean' &&
            agg !== 'min' &&
            agg !== 'max'
          ) {
            return null;
          }
          return { name, agg } as SummaryColumn;
        })
        .filter((c): c is SummaryColumn => c !== null)
    : [];
  return {
    scheme,
    minZoom,
    maxZoom,
    cellResolutionPerZoom,
    columns: cols,
    layerName,
  };
}

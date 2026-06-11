// @stt/core
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/core contributors

/**
 * STT packed-format reader over HTTP Range Requests.
 *
 * Layout (see the Rust `stt-core::pack` module and
 * `docs/spec/stt-packed-format.md`):
 *
 * ```text
 * data/<dataset>/
 *   manifest.json            metadata + directory pointer + pack table (mutable)
 *   index/<blake3>.sttd       v5 directory blob          (immutable)
 *   packs/<blake3>.sttp       per-blob zstd tile data    (immutable)
 *   packs/<blake3>.sttp
 * ```
 *
 * The reader's `url` points at the `manifest.json`. A cold load is one
 * manifest GET + one directory GET + N pack range requests. The directory
 * decodes to entries each carrying `(packId, offset, length)`; a tile read
 * selects `manifest.packs[packId]` and issues a Range request against it.
 * Coalescing is per-pack — a range can never bridge two pack objects.
 *
 * Only compressed bytes are cached here; decoded tiles are owned by the
 * tileset. There is NO shared zstd dictionary (each blob is independently
 * zstd-compressed), so the fzstd browser path can decode every tile.
 */

import { decodeDirectory } from './directory';
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
  type HeatmapDomain,
  type HeatmapClassDomain,
  Compression,
} from './types';
import { createDefaultTileDecoder, type TileDecoder } from './tile-decoder';
import { OpfsTileCache } from './opfs-cache';
import { decompress, unzstdSync } from './compression';
import { createSttTileSource, type SttTileSource } from './tile-source';
import { ThroughputEstimator, type ThroughputEstimate } from './throughput';

/** `format` discriminator written into every packed manifest. */
const PACKED_FORMAT = 'stt-packed';

const DEFAULT_MAX_CACHE_TILES = 500;
const MOBILE_MAX_CACHE_TILES = 100;
/**
 * Default max gap (bytes) between two tile ranges still worth coalescing into
 * one HTTP range request. On free-egress object storage one saved ~60 ms RTT
 * is worth multiple MB of over-fetch, so the old 32 KB was far too tight.
 *
 * Raised 512 KB → 2 MB: on a free-egress store (R2) the over-fetched gap bytes
 * cost nothing, while each saved request is both a billed GET and a round-trip.
 * A wider gap bridges across the byte-space between different cells' time-runs,
 * which is what collapses a globe view's many small per-cell requests into far
 * fewer ones. The downside (larger single requests) is bounded separately by
 * the per-fetch size cap; the gap only controls how aggressively neighbours
 * fuse. Overridable per-archive via `ArchiveOptions.coalesceGapBytes`.
 */
const DEFAULT_RANGE_COALESCE_GAP = 2 * 1024 * 1024;
/** Default ceiling on concurrent range requests per coalesced batch. */
const DEFAULT_MAX_CONCURRENT_REQUESTS = 24;
/**
 * Base backoff delays for transient range-request failures (WS-E loader
 * hardening): 2 retries before a request is considered failed. Each delay is
 * jittered ±50% (full jitter) so a fleet of throttled clients doesn't
 * re-stampede the host in lockstep. Aborts are NEVER retried.
 */
const DEFAULT_RANGE_RETRY_DELAYS_MS = [250, 1000];
/**
 * Default per-transfer stall timeout. hls.js ships 20 s (`fragLoadingTimeOut`)
 * and Shaka ~30 s; without one, a TCP-stalled response hangs its tile forever
 * — the batch member stays in flight and is never re-requested. A timeout is
 * a TRANSIENT failure (retried), unlike a caller abort (propagated).
 * Overridable per-archive via `ArchiveOptions.transferTimeoutMs`; `0` disables.
 */
const DEFAULT_TRANSFER_TIMEOUT_MS = 20_000;

/** Whether an error is a fetch cancellation (must propagate, never retry). */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Compose the caller's abort signal with a stall timeout. The returned signal
 * aborts with a `TimeoutError` reason when `timeoutMs` elapses, or mirrors the
 * caller's abort (reason and all) — so retry logic can tell the two apart
 * (timeout → retryable transient, caller abort → propagate). `cleanup` MUST
 * run when the transfer settles: it clears the timer and detaches the
 * caller-signal listener so neither outlives the request.
 */
function withTransferTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (!(timeoutMs > 0)) return { signal, cleanup: () => {} };
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort(
      signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'),
    );
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException(`STT transfer stalled for ${timeoutMs} ms`, 'TimeoutError'),
    );
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Race a transport promise against an abort signal. Spec-conformant `fetch`
 * rejects on its own when its signal aborts, but custom transports
 * (`ArchiveOptions.fetch`, `loadOptions.fetch`) may ignore the signal
 * entirely — the race guarantees the stall timeout still fires through them.
 * Rejects with the signal's abort reason (`TimeoutError` / `AbortError`).
 */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  const reasonOf = (): unknown =>
    signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  if (signal.aborted) return Promise.reject(reasonOf());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(reasonOf());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Validate a 206's `Content-Range` against the requested offsets. A proxy or
 * truncating origin that rewrites the range would silently corrupt every
 * member sliced out of a coalesced buffer, so a mismatch is an error (and a
 * retryable one — the byte-length check downstream backstops transports that
 * don't surface headers at all, e.g. test shims).
 */
function validateContentRange(response: Response, start: number, end: number): void {
  const header =
    typeof response.headers?.get === 'function'
      ? response.headers.get('content-range')
      : null;
  if (!header) return;
  const m = /^bytes (\d+)-(\d+)\//.exec(header);
  if (!m || Number(m[1]) !== start || Number(m[2]) !== end) {
    throw new Error(
      `STT pack server returned mismatched Content-Range ${JSON.stringify(header)} ` +
        `for bytes=${start}-${end}`,
    );
  }
}

/**
 * Resolve after `ms`, rejecting immediately with an `AbortError` if `signal`
 * fires first — so a retry backoff never outlives its request's cancellation.
 */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Monotonic-ish wall clock for throughput samples. */
function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

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

/**
 * Pointer to the encoded directory object in a packed manifest.
 *
 * Part of the published cross-language wire contract — see
 * `docs/spec/manifest.schema.json` and the Rust `pack::DirectoryRef`.
 */
export interface ManifestDirectoryRef {
  /** Object key relative to the dataset root (e.g. `index/<hash>.sttd`). */
  key: string;
  /**
   * Directory object length in bytes — the at-rest object, i.e. the
   * compressed length when `encoding` is set. The fetched body is
   * validated against it before any decode.
   */
  length: number;
  /** Directory codec version (5 for the packed format). */
  directoryVersion: number;
  /**
   * At-rest encoding of the directory object. `'zstd'` = the object is one
   * zstd frame wrapping the codec bytes; absent (every manifest written
   * before the field existed) = raw codec bytes.
   */
  encoding?: string;
}

/**
 * Pointer to one pack object. Its position in `packs` IS the `packId`.
 *
 * Part of the published cross-language wire contract — see
 * `docs/spec/manifest.schema.json` and the Rust `pack::PackRef`.
 */
export interface ManifestPackRef {
  /** Object key relative to the dataset root (e.g. `packs/<hash>.sttp`). */
  key: string;
  /** Pack object length in bytes. */
  length: number;
}

/**
 * The packed-format `manifest.json` — metadata + directory pointer + pack
 * table folded into one tiny object. Mirrors the Rust `pack::Manifest`.
 *
 * This is the canonical cross-language wire contract. The authoritative schema
 * is `docs/spec/manifest.schema.json` (validated against this type and the
 * golden fixture in `test/manifest-schema.test.ts`); the prose spec is
 * `docs/spec/stt-packed-format.md`.
 */
export interface PackedManifest {
  /** Format discriminator. Always {@link PACKED_FORMAT} (`"stt-packed"`). */
  format: string;
  /** Manifest schema version (currently 1). */
  formatVersion: number;
  /** Per-blob compression codec (`"zstd" | "gzip" | "none"`). */
  compression: string;
  /** Pointer to the immutable, content-addressed directory object. */
  directory: ManifestDirectoryRef;
  /** Ordered pack table; a pack's array index IS its `packId`. */
  packs: ManifestPackRef[];
  /** The verbatim stt-core Metadata JSON (snake_case keys). */
  metadata: any;
}

/** Normalize any HeadersInit into a plain record, preserving plain-object key casing. */
function headersToRecord(h: HeadersInit | undefined): Record<string, string> {
  if (!h) return {};
  if (typeof Headers !== 'undefined' && h instanceof Headers) {
    const out: Record<string, string> = {};
    h.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(h)) return Object.fromEntries(h);
  return { ...(h as Record<string, string>) };
}

/**
 * Merge a caller-level `RequestInit` (from `loadOptions.fetch`, object form)
 * UNDER a per-request one. Per-request fields win — they carry the `Range`
 * header, abort signal and fetch-priority hint the reader's offset math and
 * cancellation depend on, so the caller's init can never clobber them.
 * Plain-object header keys are kept verbatim (no `Headers` round-trip, which
 * would lowercase them).
 */
function mergeRequestInit(base: RequestInit, override?: RequestInit): RequestInit {
  if (!override) {
    return base.headers ? { ...base, headers: headersToRecord(base.headers) } : { ...base };
  }
  const merged: RequestInit = { ...base, ...override };
  if (base.headers) {
    merged.headers = {
      ...headersToRecord(base.headers),
      ...headersToRecord(override.headers),
    };
  }
  return merged;
}

/**
 * Estimate a decoded tile's in-memory size (bytes). Exported so the tileset
 * uses one consistent accounting implementation.
 */
export function estimateTileSize(tile: Tile): number {
  let size = 1000; // base overhead
  if (!tile?.layers) return size;
  for (const layer of tile.layers) {
    // The retained raw IPC bytes (GeoArrow hand-off; see Layer.arrowIpc)
    // keep the decoded payload buffer alive for the tile's lifetime, so
    // they count toward the byte budget like any other buffer.
    if (layer?.arrowIpc) size += layer.arrowIpc.byteLength;
    const f = layer?.features;
    if (!f) continue;
    size += f.positions.byteLength;
    size += f.featureIds.byteLength;
    size += f.startTimes.byteLength;
    size += f.endTimes.byteLength;
    if (f.startIndices) size += f.startIndices.byteLength;
    if (f.vertexTimestamps) size += f.vertexTimestamps.byteLength;
    if (f.vertexValues) size += f.vertexValues.byteLength;
    if (f.globalFeatureIds) size += f.globalFeatureIds.byteLength;
    // Pre-tessellated meshes and 64-bit feature ids are often the largest
    // buffers in a tile; counting them keeps the byte-budget eviction honest
    // (and matches collectTransferables, which transfers these zero-copy).
    if (f.triangles) size += f.triangles.byteLength;
    if (f.triangleOffsets) size += f.triangleOffsets.byteLength;
    if (f.featureIds64) size += f.featureIds64.byteLength;
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
  /** Parsed manifest.json (one whole-object GET, cached). */
  private manifestCache?: PackedManifest;
  /** Promise guard so concurrent callers share one manifest fetch. */
  private manifestPromise?: Promise<PackedManifest>;
  /**
   * Base URL with the manifest's final path segment removed. `directory.key`
   * and each `pack.key` are resolved relative to this.
   */
  private baseUrl?: string;
  /** Pack compression codec parsed from the manifest (per-blob, no dict). */
  private packCompression = Compression.Zstd;
  private metadataCache?: ArchiveMetadata;
  private indexCache?: ArchiveIndex;
  /** Promise guard so concurrent callers share one directory fetch+decode. */
  private indexPromise?: Promise<ArchiveIndex>;

  private byteCache = new Map<string, ByteCacheEntry>();
  private maxCacheTiles: number;
  private currentCacheBytes = 0;
  private maxCacheBytes: number;

  /** Max byte gap bridged when coalescing adjacent tile ranges (see options). */
  private coalesceGapBytes: number = DEFAULT_RANGE_COALESCE_GAP;
  /** Ceiling on concurrent range requests per coalesced batch (see options). */
  private maxConcurrentRequests: number = DEFAULT_MAX_CONCURRENT_REQUESTS;
  /** Backoff schedule for transient range failures (see options). */
  private retryDelaysMs: number[] = DEFAULT_RANGE_RETRY_DELAYS_MS;
  /** Per-transfer stall timeout; `0` disables (see options). */
  private transferTimeoutMs: number = DEFAULT_TRANSFER_TIMEOUT_MS;

  /**
   * Dual-EWMA throughput estimator fed by completed coalesced range
   * responses in {@link getTiles}. See {@link getThroughputEstimate}.
   */
  private throughput = new ThroughputEstimator();
  /**
   * Aggregate-window sampling state (Chromium NQE style). Per-request samples
   * under the {@link maxConcurrentRequests}-way pool each see ~link/N and
   * systematically underestimate the link by the concurrency factor — so
   * bytes are accumulated across ALL in-flight range requests and ONE sample
   * is recorded per busy window (first transfer starts → last one settles).
   */
  private activeTransferCount = 0;
  private transferWindowBytes = 0;
  private transferWindowStart = 0;

  /** "z/x/y" -> temporal entries at that spatial cell. */
  private tileEntryIndex = new Map<string, TileEntry[]>();
  /** "z/x/y/t" -> exact entry. */
  private tileEntryByKey = new Map<string, TileEntry>();

  private cacheStats = { hits: 0, misses: 0, evictions: 0 };
  /**
   * OPFS hit/miss counters. Tracked separately from the in-memory byte
   * cache so the HUD can show the two layers independently — a low OPFS
   * hit rate on a returning visitor usually means the dataset was redeployed
   * (the content-addressed directory hash, i.e. the OPFS fingerprint, changed).
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
   * Stable archive fingerprint, derived from the manifest's content-addressed
   * directory hash (the `index/<hash>.sttd` key). The directory hash changes
   * iff the dataset's tiles change, so it's the natural cache-busting key —
   * and it's stable across the dataset's many immutable packs (unlike a
   * per-pack ETag). Filled by `fetchManifest`.
   */
  private archiveFingerprint?: string;

  constructor(options: ArchiveOptions | string) {
    if (typeof options === 'string') {
      this.url = options;
      this.fetchFn = fetch.bind(globalThis);
    } else {
      this.url = options.url;
      this.fetchFn = options.fetch || fetch.bind(globalThis);
      // loaders.gl-convention `loadOptions.fetch` (see SttLoadOptions):
      // the FUNCTION form is a drop-in transport (the explicitly-typed
      // `options.fetch` wins when both are set); the OBJECT form is a
      // RequestInit merged into EVERY request this archive makes — manifest,
      // directory, pack ranges — so auth headers / credentials reach the
      // wire without a custom fetch function.
      const loadFetch = options.loadOptions?.fetch;
      if (typeof loadFetch === 'function') {
        if (!options.fetch) this.fetchFn = loadFetch as typeof fetch;
      } else if (loadFetch && typeof loadFetch === 'object') {
        const transport = this.fetchFn;
        this.fetchFn = ((input: RequestInfo | URL, init?: RequestInit) =>
          transport(input, mergeRequestInit(loadFetch, init))) as typeof fetch;
      }
      this.decoderOption = options.decoder;
      if (typeof options.coalesceGapBytes === 'number' && options.coalesceGapBytes >= 0) {
        this.coalesceGapBytes = options.coalesceGapBytes;
      }
      if (typeof options.maxConcurrentRequests === 'number' && options.maxConcurrentRequests >= 1) {
        this.maxConcurrentRequests = Math.floor(options.maxConcurrentRequests);
      }
      if (Array.isArray(options.retryDelaysMs)) {
        this.retryDelaysMs = options.retryDelaysMs.filter(
          (d) => typeof d === 'number' && d >= 0,
        );
      }
      if (typeof options.transferTimeoutMs === 'number' && options.transferTimeoutMs >= 0) {
        this.transferTimeoutMs = options.transferTimeoutMs;
      }
      // OPFS defaults to OFF. The cache's warm-reload win only materializes
      // when the archive fits in `opfsCacheMaxBytes` AND users revisit the
      // same viewport across reloads. On the cold path it costs a duplicate
      // main-thread zstd decompress per tile (see `writeOpfsAsync`), which
      // hurts initial pan/zoom — the dominant experience for showcase users
      // and for any dataset bigger than the cache budget (e.g. the multi-GB
      // nyc-taxi-paths packs vs the 512 MB default). Apps that genuinely
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

  /**
   * Resolve a manifest-relative key (e.g. `index/<hash>.sttd`) against the
   * base URL (the manifest URL with its final path segment removed).
   */
  private resolveKey(key: string): string {
    if (this.baseUrl === undefined) {
      throw new Error('STT archive: manifest not loaded (resolveKey before fetchManifest)');
    }
    return this.baseUrl + key;
  }

  /**
   * GET the whole `manifest.json` (NOT a range request) and parse it. Cached;
   * concurrent callers share one in-flight fetch. Also derives the base URL,
   * the pack compression codec and the stable OPFS fingerprint.
   */
  private async fetchManifest(): Promise<PackedManifest> {
    if (this.manifestCache) return this.manifestCache;
    if (this.manifestPromise) return this.manifestPromise;
    this.manifestPromise = (async () => {
      // The manifest GET is the cold-start single point of failure — one
      // transient blip used to fail the whole dataset load. It rides the
      // same jittered backoff + stall timeout as pack range requests.
      const buffer = await this.fetchWholeObjectWithRetry(this.url, 'manifest');
      let manifest: PackedManifest;
      try {
        manifest = JSON.parse(new TextDecoder().decode(buffer));
      } catch (e) {
        throw new Error(`STT manifest: invalid JSON (${(e as Error).message})`);
      }
      if (manifest.format !== PACKED_FORMAT) {
        throw new Error(
          `STT manifest: not a packed manifest (format=${JSON.stringify(manifest.format)}, ` +
            `expected ${JSON.stringify(PACKED_FORMAT)})`,
        );
      }
      if (!manifest.directory || !Array.isArray(manifest.packs)) {
        throw new Error('STT manifest: missing directory pointer or pack table');
      }
      // Base = manifest URL with the final path segment stripped (keep the
      // trailing slash). `index/...` and `packs/...` keys resolve against it.
      const slash = this.url.lastIndexOf('/');
      this.baseUrl = slash >= 0 ? this.url.slice(0, slash + 1) : '';
      switch (manifest.compression) {
        case 'none':
          this.packCompression = Compression.None;
          break;
        case 'gzip':
          this.packCompression = Compression.Gzip;
          break;
        case 'zstd':
        default:
          this.packCompression = Compression.Zstd;
          break;
      }
      // OPFS fingerprint = the content-addressed directory hash. It changes iff
      // the dataset's tiles change, and is stable across the dataset's packs.
      this.archiveFingerprint = manifest.directory.key;
      this.manifestCache = manifest;
      return manifest;
    })();
    try {
      return await this.manifestPromise;
    } finally {
      this.manifestPromise = undefined;
    }
  }

  /**
   * GET a whole (non-range) object — manifest or directory — under the same
   * stall timeout as range requests, validating the body length when the
   * expected size is known (the manifest carries `directory.length`, so a
   * truncated directory is caught here instead of corrupting the decode).
   */
  private async fetchWholeObject(
    url: string,
    what: string,
    expectedLength?: number,
  ): Promise<ArrayBuffer> {
    const { signal, cleanup } = withTransferTimeout(undefined, this.transferTimeoutMs);
    try {
      const response = await raceAbort(this.fetchFn(url, { signal }), signal);
      if (!response.ok) {
        throw new Error(
          `STT ${what} fetch failed: ${response.status} ${response.statusText}`,
        );
      }
      const buffer = await raceAbort(response.arrayBuffer(), signal);
      if (expectedLength !== undefined && buffer.byteLength !== expectedLength) {
        throw new Error(
          `STT ${what} truncated: got ${buffer.byteLength} bytes, expected ${expectedLength}`,
        );
      }
      return buffer;
    } finally {
      cleanup();
    }
  }

  /**
   * {@link fetchWholeObject} with the same jittered backoff as
   * {@link fetchRangeWithRetry}. The manifest and directory GETs used to be
   * single-attempt while every tile range retried — exactly backwards for
   * the two objects nothing else can proceed without.
   */
  private async fetchWholeObjectWithRetry(
    url: string,
    what: string,
    expectedLength?: number,
  ): Promise<ArrayBuffer> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      if (attempt > 0) {
        const base = this.retryDelaysMs[attempt - 1];
        await abortableDelay(base * (0.5 + Math.random()));
      }
      try {
        return await this.fetchWholeObject(url, what, expectedLength);
      } catch (error) {
        if (isAbortError(error)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  /**
   * Fetch a byte range from pack `packIndex`, validating that the server
   * honoured it. A 200 (server ignored Range) would silently corrupt every
   * offset-based read, so it's rejected — as is a 206 whose `Content-Range`
   * or body length disagrees with the request (a truncated body would
   * corrupt every member sliced from a coalesced buffer). The transfer runs
   * under the stall timeout so a TCP-stalled response can't hang forever.
   */
  private async fetchRange(
    packIndex: number,
    start: number,
    end: number,
    signal?: AbortSignal,
    fetchPriority?: 'high' | 'low' | 'auto',
  ): Promise<ArrayBuffer> {
    const manifest = await this.fetchManifest();
    const pack = manifest.packs[packIndex];
    if (!pack) {
      throw new Error(
        `STT archive: tile references pack ${packIndex} but only ${manifest.packs.length} packs exist`,
      );
    }
    const { signal: transferSignal, cleanup } = withTransferTimeout(
      signal,
      this.transferTimeoutMs,
    );
    try {
      const init: RequestInit = {
        headers: { Range: `bytes=${start}-${end}` },
        signal: transferSignal,
      };
      // `RequestInit.priority` is a hint; browsers without it ignore the field.
      if (fetchPriority) (init as RequestInit & { priority?: string }).priority = fetchPriority;
      const response = await raceAbort(
        this.fetchFn(this.resolveKey(pack.key), init),
        transferSignal,
      );
      if (!response.ok) {
        throw new Error(`STT pack fetch failed: ${response.status} ${response.statusText}`);
      }
      if (response.status !== 206) {
        throw new Error(
          `STT pack server ignored Range request (status ${response.status}); ` +
            'HTTP range requests are required.',
        );
      }
      validateContentRange(response, start, end);
      const buffer = await raceAbort(response.arrayBuffer(), transferSignal);
      const expected = end - start + 1;
      if (buffer.byteLength !== expected) {
        throw new Error(
          `STT pack range truncated: got ${buffer.byteLength} bytes, ` +
            `expected ${expected} (bytes=${start}-${end})`,
        );
      }
      return buffer;
    } finally {
      cleanup();
    }
  }

  /**
   * {@link fetchRange} with exponential backoff + full jitter on transient
   * failures (WS-E loader hardening). One transient 5xx / network blip used
   * to silently drop every tile in the affected batch; now the request is
   * retried per {@link ArchiveOptions.retryDelaysMs} (default 250 ms then
   * 1000 ms, each jittered ±50%) before the failure surfaces. A transfer
   * stall timeout counts as a transient failure and is retried the same way.
   *
   * An `AbortError` is NEVER retried — cancellation propagates immediately,
   * including out of a pending backoff delay.
   */
  private async fetchRangeWithRetry(
    packIndex: number,
    start: number,
    end: number,
    signal?: AbortSignal,
    fetchPriority?: 'high' | 'low' | 'auto',
  ): Promise<ArrayBuffer> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      if (attempt > 0) {
        const base = this.retryDelaysMs[attempt - 1];
        await abortableDelay(base * (0.5 + Math.random()), signal);
      }
      const attemptStart = nowMs();
      try {
        return await this.fetchRange(packIndex, start, end, signal, fetchPriority);
      } catch (error) {
        if (isAbortError(error)) throw error;
        // Failure-aware estimation: the estimator is otherwise fed only by
        // COMPLETED responses, so on a dead network `getEstimate()` holds
        // the last healthy rate forever and every ETA built from it lies.
        // A failed attempt burned its wall-clock for ~zero delivered bytes
        // — feed that as a 1-byte sample weighted by the attempt duration,
        // dragging the fast EWMA toward zero (a 20 s stall outweighs a
        // quick 5xx, which is the right proportionality).
        this.throughput.addSample(1, nowMs() - attemptStart);
        lastError = error;
      }
    }
    throw lastError;
  }

  /**
   * Current network throughput estimate, fed by completed coalesced range
   * responses in {@link getTiles}: dual EWMA (3 s fast / 9 s slow half-life,
   * duration-weighted), published as `min(fast, slow)` — reacts fast to
   * drops, rises cautiously. `bytesPerMs` is `null` until the first sample.
   *
   * Wire into `SpatiotemporalTileset`'s `getThroughput` option so the
   * tileset can convert pending-byte counts into honest time-to-ready ETAs.
   */
  getThroughputEstimate(): ThroughputEstimate {
    return this.throughput.getEstimate();
  }

  /**
   * Mark one range transfer in flight for aggregate-window sampling. The
   * first transfer of a busy window anchors the window's wall clock; see
   * {@link endTransferSample} for where the sample lands.
   */
  private beginTransferSample(): void {
    if (this.activeTransferCount === 0) {
      this.transferWindowStart = nowMs();
      this.transferWindowBytes = 0;
    }
    this.activeTransferCount++;
  }

  /**
   * Settle one range transfer (`bytes` = 0 for a failed one). When the LAST
   * in-flight transfer settles, the whole busy window becomes one
   * `(totalBytes, wallClockMs)` sample — the link's aggregate rate, immune
   * to the ~N× per-request underestimate the concurrent pool would cause.
   * Retry backoff inside the window stays counted: time the link spent NOT
   * delivering bytes is honest pessimism.
   */
  private endTransferSample(bytes: number): void {
    this.transferWindowBytes += bytes;
    this.activeTransferCount--;
    if (this.activeTransferCount === 0 && this.transferWindowBytes > 0) {
      this.throughput.addSample(
        this.transferWindowBytes,
        nowMs() - this.transferWindowStart,
      );
    }
  }

  /** Archive metadata, folded into the manifest (no separate fetch). */
  async getMetadata(): Promise<ArchiveMetadata> {
    if (this.metadataCache) return this.metadataCache;
    const manifest = await this.fetchManifest();
    const json = manifest.metadata ?? {};
    this.metadataCache = {
      // The packed format folds metadata into the manifest; surface the
      // manifest schema version (formatVersion) here for callers that branch
      // on it (the legacy single-file `version` is gone).
      version: manifest.formatVersion,
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
      heatmapDomain: parseHeatmapDomain(json.heatmap_domain),
    };
    return this.metadataCache;
  }

  /** Archive directory (the v5 tile index). One whole-object GET, cached. */
  async getIndex(): Promise<ArchiveIndex> {
    if (this.indexCache) return this.indexCache;
    if (this.indexPromise) return this.indexPromise;
    this.indexPromise = this.fetchAndBuildIndex();
    try {
      return await this.indexPromise;
    } finally {
      this.indexPromise = undefined;
    }
  }

  private async fetchAndBuildIndex(): Promise<ArchiveIndex> {
    const manifest = await this.fetchManifest();
    // Whole-object GET of the immutable content-addressed directory, with
    // the same retry/backoff + stall timeout as range requests. The body is
    // validated against the manifest's `directory.length` — a truncated
    // response is a retryable transport failure, not a decode-time mystery.
    const buffer = await this.fetchWholeObjectWithRetry(
      this.resolveKey(manifest.directory.key),
      'directory',
      manifest.directory.length,
    );
    // Unwrap the at-rest encoding (manifests written before the field
    // existed carry raw codec bytes and no `encoding` key).
    let dirBytes: Uint8Array = new Uint8Array(buffer);
    const encoding = manifest.directory.encoding;
    if (encoding === 'zstd') {
      dirBytes = unzstdSync(dirBytes);
    } else if (encoding !== undefined) {
      throw new Error(
        `STT manifest: unknown directory encoding ${JSON.stringify(encoding)} ` +
          "(this reader supports absent or 'zstd')",
      );
    }
    // Decode the compact v5 directory (columnar varint + run-length + per-run
    // pack_id). The crc32c integrity tag is read but not verified client-side —
    // a decode failure throws a clear error instead.
    const raw = decodeDirectory(dirBytes);
    const tiles: TileEntry[] = raw.map((e) => ({
      zoom: e.zoom,
      x: e.x,
      y: e.y,
      timeStart: e.timeStart,
      timeEnd: e.timeEnd,
      packId: e.packId,
      offset: e.offset,
      length: e.length,
      featureCount: e.featureCount,
      compression: this.packCompression,
      uncompressedSize: e.uncompressedSize,
      temporalBucketMs: e.temporalBucketMs,
      coverTMin: e.coverTMin,
    }));
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

  /**
   * Compressed byte size of a tile from the already-decoded directory, or
   * `undefined` if the tile isn't indexed (or the index isn't loaded yet).
   * Synchronous, no I/O — the directory is resident once `getTileIdsInBounds`
   * has run. Wire into `SpatiotemporalTileset.getTileByteSize` so the tileset
   * can skip giant low-zoom parent-fallback tiles before fetching them.
   */
  getTileByteSize(id: TileId): number | undefined {
    return this.findTileEntry(id)?.length;
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
    // The packed format has NO shared zstd dictionary: every blob is
    // independently zstd-compressed (`compress_zstd_with_dict(_, None)` on the
    // writer), so the fzstd browser path decodes every tile. There's nothing
    // to guard against here.
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
    const compressed = await this.fetchRangeWithRetry(
      entry.packId,
      entry.offset,
      entry.offset + entry.length - 1,
      options?.signal,
      options?.fetchPriority
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

    // Incremental delivery: store + announce a decoded tile in one place so
    // every fill path (byte cache, OPFS, coalesced group, per-member
    // fallback) reaches the caller the moment ITS bytes are decoded — not
    // when the slowest range request of the whole batch settles.
    const deliver = (index: number, tile: Tile | null): void => {
      results[index] = tile;
      if (tile) options?.onTileReady?.(index, tile);
    };

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
            deliver(idx, t);
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
              deliver(p.index, t);
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
      interface Group {
        packId: number;
        start: number;
        end: number;
        members: Pending[];
      }
      // Coalescing is PER-PACK: a single HTTP range request addresses exactly
      // one pack object, so a range may never bridge two packs. Group the
      // pending tiles by pack first, then within each pack sort by offset and
      // coalesce neighbours within `coalesceGapBytes`.
      const byPack = new Map<number, Pending[]>();
      for (const p of pending) {
        let list = byPack.get(p.entry.packId);
        if (!list) {
          list = [];
          byPack.set(p.entry.packId, list);
        }
        list.push(p);
      }
      const groups: Group[] = [];
      for (const [packId, members] of byPack) {
        members.sort((a, b) => a.entry.offset - b.entry.offset);
        let current: Group | undefined;
        for (const p of members) {
          const pStart = p.entry.offset;
          const pEnd = p.entry.offset + p.entry.length - 1;
          if (current && pStart - (current.end + 1) <= this.coalesceGapBytes) {
            current.end = Math.max(current.end, pEnd);
            current.members.push(p);
          } else {
            current = { packId, start: pStart, end: pEnd, members: [p] };
            groups.push(current);
          }
        }
      }
      // Fire one HTTP range request per coalesced group. Decode all members of
      // a group concurrently (a previous serial decode made `getTiles()` slower
      // than per-tile `getTile()` calls). After coalescing a viewport×window
      // usually collapses to a few groups; the concurrency pool below bounds
      // in-flight requests across the groups of ALL packs so a pathological
      // sparse batch can't exceed an object store's per-connection stream cap.
      //
      // WS-E hardening: the group fetch retries transient failures with
      // backoff (see fetchRangeWithRetry); if the WHOLE coalesced range still
      // fails, fall back to fetching its member tiles individually (single
      // attempt each) so one bad range can't drop an entire batch — only the
      // tiles that still fail stay `null` in the results. Every completed
      // range response also feeds the throughput estimator, at busy-window
      // granularity (see beginTransferSample / endTransferSample) so the
      // concurrent pool can't make each request look like 1/Nth of the link.
      const fetchGroup = async (group: Group): Promise<void> => {
        let buffer: ArrayBuffer;
        this.beginTransferSample();
        try {
          buffer = await this.fetchRangeWithRetry(
            group.packId,
            group.start,
            group.end,
            options?.signal,
            options?.fetchPriority,
          );
          this.endTransferSample(buffer.byteLength);
        } catch (error) {
          this.endTransferSample(0);
          if (isAbortError(error)) throw error;
          // Coalesced range failed after retries → per-member fallback.
          await Promise.all(
            group.members.map(async (m) => {
              let single: ArrayBuffer;
              this.beginTransferSample();
              try {
                single = await this.fetchRange(
                  m.entry.packId,
                  m.entry.offset,
                  m.entry.offset + m.entry.length - 1,
                  options?.signal,
                  options?.fetchPriority,
                );
                this.endTransferSample(single.byteLength);
              } catch (memberError) {
                this.endTransferSample(0);
                if (isAbortError(memberError)) throw memberError;
                // Tile-level failure: leave `null`. Callers that know the
                // tile exists in the directory surface this per-tile (the
                // tileset reports it through `onTileError`).
                return;
              }
              try {
                this.storeBytes(this.tileIdToKey(m.id), single);
                deliver(m.index, await this.decodeBytes(m.id, m.entry, single));
                if (this.opfsCache) {
                  void this.writeOpfsAsync(m.id, m.entry, single.slice(0));
                }
              } catch (decodeError) {
                if (isAbortError(decodeError)) throw decodeError;
                // Decode failure: same per-tile `null` semantics as a fetch
                // failure (the bytes arrived but the payload is unusable).
              }
            }),
          );
          return;
        }
        await Promise.all(
          group.members.map(async (m) => {
            const rel = m.entry.offset - group.start;
            const slice = buffer.slice(rel, rel + m.entry.length);
            this.storeBytes(this.tileIdToKey(m.id), slice);
            deliver(m.index, await this.decodeBytes(m.id, m.entry, slice));
            if (this.opfsCache) {
              void this.writeOpfsAsync(m.id, m.entry, slice.slice(0));
            }
          })
        );
      };

      const limit = Math.max(1, this.maxConcurrentRequests);
      if (groups.length <= limit) {
        for (const group of groups) jobs.push(fetchGroup(group));
      } else {
        // More groups than the concurrency budget: `limit` runners pull from a
        // shared cursor so at most `limit` range requests are ever in flight.
        let next = 0;
        const runner = async (): Promise<void> => {
          for (;;) {
            const i = next++;
            if (i >= groups.length) return;
            await fetchGroup(groups[i]);
          }
        };
        jobs.push(
          Promise.all(Array.from({ length: limit }, () => runner())).then(() => undefined)
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
        // Window overlap. Upper bound uses the tight `timeEnd`; lower bound uses
        // the tight covering `coverTMin` when present (falling back to the
        // bucket-edge `timeStart`), so a tile whose data is entirely AFTER the
        // window is skipped without a fetch. The pushed TileId still addresses
        // by `timeStart` (the bucket boundary) — covering tightens the *filter*,
        // not the *address*.
        if (e.timeEnd >= timeRange.start && (e.coverTMin ?? e.timeStart) <= timeRange.end) {
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
        // Window overlap. Upper bound uses the tight `timeEnd`; lower bound uses
        // the tight covering `coverTMin` when present (falling back to the
        // bucket-edge `timeStart`), so a tile whose data is entirely AFTER the
        // window is skipped without a fetch. The pushed TileId still addresses
        // by `timeStart` (the bucket boundary) — covering tightens the *filter*,
        // not the *address*.
        if (e.timeEnd >= timeRange.start && (e.coverTMin ?? e.timeStart) <= timeRange.end) {
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
 * camelCase TS shape. Returns `undefined` for archives that don't carry one.
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
  const subBuckets = Math.max(1, Math.floor(Number(r.sub_buckets ?? 1)));
  return {
    scheme,
    minZoom,
    maxZoom,
    cellResolutionPerZoom,
    columns: cols,
    layerName,
    subBuckets,
  };
}

/**
 * Parse the `heatmap_domain` block from an archive's JSON metadata into the
 * camelCase TS shape. Returns `undefined` for archives that don't carry one.
 * Each class entry surfaces the bake-time `[min, max]` splat-intensity
 * domain that HeatmapLayer uses as its pinned `colorDomain` default.
 */
function parseHeatmapDomain(raw: unknown): HeatmapDomain | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.classes)) return undefined;
  const classes: HeatmapClassDomain[] = (r.classes as unknown[])
    .map((c) => {
      if (!c || typeof c !== 'object') return null;
      const cc = c as Record<string, unknown>;
      const id = typeof cc.id === 'string' ? cc.id : '';
      const min = Number(cc.min);
      const max = Number(cc.max);
      if (!id || !Number.isFinite(min) || !Number.isFinite(max)) return null;
      const out: HeatmapClassDomain = { id, min, max };
      if (typeof cc.property === 'string') out.property = cc.property;
      return out;
    })
    .filter((c): c is HeatmapClassDomain => c !== null);
  if (classes.length === 0) return undefined;
  return { classes };
}

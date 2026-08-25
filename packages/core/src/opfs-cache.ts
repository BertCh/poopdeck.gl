// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * OPFS-backed persistent tile cache.
 *
 * The in-memory `byteCache` on `STTArchive` is wiped every time a tab reloads,
 * so a returning visitor pays the full cost (network range request + zstd
 * decompress + Arrow IPC parse) for every tile that scrolls back into view.
 * Caching the DECOMPRESSED tile payload in the Origin Private File System lets
 * us short-circuit both the network round-trip and the zstd step on the
 * second visit — only the Arrow IPC parse + binary-feature extraction stays.
 *
 * OPFS is the right tool for this:
 *   - Origin-scoped, no permission prompts, no quota dialog
 *   - 3-4x faster ops than IndexedDB for large blobs
 *   - >1 GB allowed in Chromium / Firefox; Safari 17+ supports it (slightly
 *     more restricted, no `createWritable` on the main thread until 17.4)
 *
 * If OPFS isn't available (Node, very old browsers, Safari < 16) the cache
 * silently degrades into a no-op so callers never need to feature-detect.
 *
 * Layout under the chosen directory ("stt-cache" by default):
 *   stt-cache/
 *     <safeKey1>.bin    — raw decompressed tile bytes
 *     <safeKey2>.bin
 *     index.json        — { entries: { safeKey: { bytes, lastAccess, hits } },
 *                           totalBytes, lFloor? }
 *
 * The cache key is opaque to this module — `STTArchive` builds it from
 * `(archive-url, tile-id, archive-fingerprint)` so a re-deployed archive
 * (different ETag or size) invalidates automatically without us needing to
 * walk and delete stale files.
 */

/**
 * A persisted entry in the OPFS index. `bytes` is duplicated here so eviction
 * doesn't need to stat every file (which would defeat the speed advantage
 * over IndexedDB).
 */
export interface OpfsIndexEntry {
  bytes: number;
  lastAccess: number;
  /**
   * Lifetime cache HITS on this key (P0-2). Additive JSON field: an index
   * written before it existed loads with `hits` defaulted to 0 and every
   * other field untouched — the format version does NOT move, and no entry
   * is dropped or rewritten on account of it.
   *
   * Its purpose is a re-access-probability estimate at ZERO I/O: the
   * GreedyDual-Size / admission work needs to know whether a key has ever
   * been read back, and `lastAccess` alone cannot distinguish "written once,
   * never re-read" from "read on every visit". Preserved across an overwrite
   * of the same key (the key identifies the same tile) and reset only by
   * `clear()` / eviction.
   *
   * Read by {@link OpfsTileCache.evict}'s GreedyDual-Size ranking (BH-9) as
   * the frequency term; `0` there means "written but never read back", which
   * is precisely the entry a byte budget should spend first.
   */
  hits: number;
}

interface OpfsIndex {
  /** Map of safeKey → entry metadata. */
  entries: Record<string, OpfsIndexEntry>;
  /** Sum of `entry.bytes` across the directory. Kept in sync on set/evict. */
  totalBytes: number;
  /** Format version so we can wipe + rebuild on a breaking change. */
  v: number;
  /**
   * The floating GreedyDual-Size baseline `L` (BH-9), carried across sessions.
   * ADDITIVE and OPTIONAL: absent (every index written before this existed)
   * reads as `0`, the index version does NOT move, and a fresh cache still
   * serializes the exact legacy shape because the key is only written once a
   * non-zero baseline exists.
   *
   * `L` is the classical GDS aging term: each eviction raises it to the
   * victim's own `H`, so a long-lived entry cannot stay resident purely
   * because it was admitted when the cache was cheap. It enters every `H` as
   * a SHARED additive offset, so within one eviction pass it does not reorder
   * candidates — its job is to keep the `H` scale comparable across passes
   * and across sessions, which is why it is persisted rather than recomputed.
   */
  lFloor?: number;
}

const INDEX_FILE = 'index.json';
/**
 * NOT MOVED BY BH-9, deliberately: `hits` and `lFloor` are both additive and
 * optional, so an index written by any earlier build loads with its bytes,
 * its LRU stamps and its entry set intact. Bumping this would wipe every
 * returning visitor's cache — the exact cost the additive shape avoids.
 */
const INDEX_VERSION = 1;

/**
 * Assumed round-trip time, in ms, saved by a cache hit (BH-9). Used only to
 * price a hit in bytes — `cHit(b) = RTT_EST_MS × linkBytesPerMs + b` — so it
 * never needs to be exact, only to be the right order of magnitude relative
 * to the transfer term. 80 ms is a mid-range mobile/last-mile RTT to a CDN
 * edge; the cold-start bench arbitrates it.
 */
const RTT_EST_MS = 80;

/**
 * Fallback link rate (bytes per ms ≈ 5 Mbit/s) used when no throughput hook
 * is wired or the estimator is still cold. Fixed and nominal on purpose: the
 * ranking only needs a stable exchange rate between "one saved round trip"
 * and "bytes transferred", and a wrong-but-constant rate keeps eviction
 * deterministic.
 */
const DEFAULT_LINK_BYTES_PER_MS = 625;

/**
 * Tiles at or below this zoom are ALWAYS admitted (BH-9). Overview tiles are
 * the cross-session hot set — every revisit, from any viewport, starts by
 * drawing them — and there are only a handful of them, so the byte cost of
 * an unconditional admit is negligible next to the round trips it saves.
 */
const ADMIT_ALWAYS_MAX_ZOOM = 2;

/**
 * Minimum payload size for first-touch admission (BH-9). Below it a tile must
 * earn its slot with a SECOND touch (the {@link OpfsTileCache} doorkeeper) —
 * a TinyLFU-lite gate that keeps tiny-but-hot tiles while one-touch tiny
 * tiles skip both the file write and the index churn they would cause.
 */
const ADMIT_MIN_BYTES = 4096;

/**
 * Upper bound on the session doorkeeper set. Bounded so a long pan over a
 * large archive cannot grow it without limit; the oldest remembered key is
 * dropped first (insertion order), which is the standard doorkeeper decay.
 */
const DOORKEEPER_MAX_ENTRIES = 4096;

/**
 * Fraction of the byte budget an over-budget `set()` evicts DOWN TO.
 *
 * Evicting to exactly the budget left every steady-state `set()` over budget
 * again, and each one paid a full ranking pass over all N entries to free one
 * tile's worth: 58 ms per set at 128k entries, 1.8 s for a 200-tile pan.
 * Ranking once and evicting the extra 10 % lets the next ~10 % of sets land
 * under budget for free. The victim ORDER is unchanged — the pass walks
 * further down the same ranked sequence — so which tiles survive long-term
 * does not move. Per-instance override: {@link OpfsTileCacheOptions.evictLowWater};
 * `1` is the evict-to-the-budget rollback.
 */
export const OPFS_EVICT_LOW_WATER = 0.9;

/**
 * Sanitize a cache key into something OPFS will accept as a filename.
 *
 * `getFileHandle` rejects `/`, `:`, `?`, etc. — which is exactly what shows
 * up in tile keys (`8/12/34/1700000000000`) and archive URLs. Hex-encoding
 * the bytes is unambiguous and length-stable, so collisions are impossible
 * for distinct inputs.
 */
function safeFileName(key: string): string {
  // TextEncoder is universally available in browsers and the supported Node 24+ runtime.
  const bytes = new TextEncoder().encode(key);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return `${hex}.bin`;
}

/**
 * Detect whether the runtime exposes a usable OPFS API. Chromium/Firefox
 * expose `navigator.storage.getDirectory`; Safari 16+ does too but historically
 * lacked `createWritable` on the main thread — we treat the missing method as
 * "not available" rather than crashing on the first `set()`.
 *
 * Returns `true` only when the directory root is reachable AND a writable
 * stream can be opened on a probe file. We pay this once on construction.
 */
export function isOpfsAvailable(): boolean {
  if (typeof navigator === 'undefined') return false;
  const storage: any = (navigator as any).storage;
  if (!storage || typeof storage.getDirectory !== 'function') return false;
  // We can't await here, so the actual writability check happens lazily
  // inside `open()`. This sync probe just rules out clearly-missing API.
  return true;
}

/**
 * Options for {@link OpfsTileCache}.
 */
export interface OpfsTileCacheOptions {
  /** Subdirectory name under the OPFS root. Defaults to `"stt-cache"`. */
  directory?: string;
  /**
   * Soft byte budget. When exceeded after a `set()`, entries are deleted
   * until the cache fits `evictLowWater × maxBytes` (see
   * {@link OpfsTileCache.evict}). Defaults to 512 MB.
   */
  maxBytes?: number;
  /**
   * Low-water mark, as a fraction of the budget in (0, 1], that an
   * over-budget `set()` evicts down to. Defaults to
   * {@link OPFS_EVICT_LOW_WATER}; `1` restores evict-to-exactly-the-budget.
   * Out-of-range or non-finite values fall back to the default. A manual
   * {@link OpfsTileCache.evict} call is unaffected — it stops at the target
   * it was given.
   */
  evictLowWater?: number;
  /**
   * Live link-rate estimate in BYTES PER MILLISECOND, or `null` when the
   * estimator is still cold (BH-9). Normally wired to the owning archive's
   * `ThroughputEstimator.getConservativeRate()`. Only used to price a saved
   * round trip in bytes for the eviction ranking; a `null` return (or a
   * missing hook) falls back to {@link DEFAULT_LINK_BYTES_PER_MS}.
   */
  getThroughput?: () => number | null;
  /**
   * GreedyDual-Size eviction (BH-9). `true` (default) ranks victims by
   * `H = L + (1 + hits) × cHit(b) / b`; `false` is the documented rollback —
   * the pre-BH-9 strict `lastAccess` LRU sort, unchanged.
   */
  gdsEviction?: boolean;
  /**
   * Admission filter (BH-9). When `true`, a `set()` that DECLARES its tile's
   * zoom (`opts.zoom`) is admitted only if the tile is an overview tile
   * (`zoom ≤ 2`), is at least {@link admitMinBytes} long, is already resident
   * under this key, or has been offered before in this session (the
   * doorkeeper). Calls that declare no zoom are always admitted, so a caller
   * driving the cache directly is never affected.
   *
   * DEFAULT `false` — an instance handed to `STTArchive` via
   * `opfsCacheImpl` keeps the incumbent admit-everything policy unless its
   * owner asks otherwise. `STTArchive` turns it on for the cache it
   * constructs itself (`opfsCache: true`), which is the production path.
   */
  admissionFilter?: boolean;
  /**
   * First-touch admission threshold in bytes; defaults to
   * {@link ADMIT_MIN_BYTES}. `0` admits every size on first touch (the
   * documented rollback constant) while leaving the rest of the filter in
   * place.
   */
  admitMinBytes?: number;
}

/**
 * Persistent decompressed-tile cache stored under the Origin Private File
 * System. Safe to construct in any environment — calls degrade to no-ops
 * when OPFS isn't reachable.
 */
export class OpfsTileCache {
  /** Whether OPFS is reachable. `false` collapses every method to a no-op. */
  private available: boolean;
  private readonly directoryName: string;
  /** Configured byte-budget ceiling (the `maxBytes` option / 512 MB default). */
  private readonly maxBytes: number;
  /**
   * Effective byte budget: `min(maxBytes, 0.5 × storage quota)` once
   * `navigator.storage.estimate()` resolves in `init()`. A fixed 512 MB on a
   * quota-constrained device (or an origin already holding other data) would
   * drive every `set()` into QuotaExceeded; halving the quota leaves room
   * for the rest of the origin. Equals `maxBytes` where `estimate()` is
   * unavailable.
   */
  private budgetBytes: number;

  /**
   * Lazy initialisation promise. The first `get` / `set` triggers
   * `getDirectory()` + `index.json` read; later calls await the same promise.
   * Splitting this off the constructor keeps construction synchronous so
   * callers don't need to `await new OpfsTileCache()`.
   */
  private initPromise?: Promise<void>;
  private dirHandle?: FileSystemDirectoryHandle;
  private index: OpfsIndex = { entries: {}, totalBytes: 0, v: INDEX_VERSION };
  /**
   * Live entry count kept in sync with `index.entries`. `getStats()` runs
   * on every frame in the perf HUD path; reading `Object.keys(...).length`
   * there allocates an N-string array per call, which at 60 Hz × hundreds
   * of entries shows up in flamegraphs as a real chunk of frame time.
   */
  private entryCount = 0;

  /**
   * Index writes are batched: every mutation marks the index dirty and
   * schedules a microtask flush. A burst of `set()` calls during initial
   * tile load only writes the index file once. This keeps OPFS happy on
   * Chromium (which serialises index.json contention behind a single
   * writable lock).
   */
  private indexDirty = false;
  private flushTimer?: ReturnType<typeof setTimeout>;

  /**
   * Monotonic counter used in place of Date.now() for `lastAccess`. Wall-clock
   * time has 1ms granularity, which can tie several entries that were
   * written in the same millisecond and make LRU eviction non-deterministic.
   * The counter is seeded from Date.now() so the order survives across
   * cache instances (the persisted index stores the counter value).
   */
  private accessCounter = Date.now();
  private tick(): number {
    return ++this.accessCounter;
  }

  /** Live link-rate hook for the GDS hit price; see the option's docs. */
  private readonly getThroughput?: () => number | null;
  /** GreedyDual-Size ranking on (`false` = the pre-BH-9 LRU rollback). */
  private readonly gdsEviction: boolean;
  /** Admission filter on; see {@link OpfsTileCacheOptions.admissionFilter}. */
  private readonly admissionFilter: boolean;
  /** First-touch admission threshold in bytes. */
  private readonly admitMinBytes: number;
  /** Fraction of the budget an automatic (set-triggered) eviction stops at. */
  private readonly evictLowWater: number;
  /**
   * SESSION-ONLY second-touch gate: keys offered to {@link set} and turned
   * away. The next offer of the same key is admitted, so a tile that is
   * genuinely re-fetched inside a session gets in while a one-touch tile
   * never costs a write. Never persisted (a doorkeeper that survived reloads
   * would degrade into "admit everything" over time) and bounded to
   * {@link DOORKEEPER_MAX_ENTRIES}.
   */
  private readonly doorkeeper = new Set<string>();

  constructor(options: OpfsTileCacheOptions = {}) {
    this.directoryName = options.directory ?? 'stt-cache';
    this.maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
    this.budgetBytes = this.maxBytes;
    this.available = isOpfsAvailable();
    this.getThroughput = options.getThroughput;
    this.gdsEviction = options.gdsEviction !== false;
    this.admissionFilter = options.admissionFilter === true;
    this.admitMinBytes =
      typeof options.admitMinBytes === 'number' &&
      Number.isFinite(options.admitMinBytes) &&
      options.admitMinBytes >= 0
        ? options.admitMinBytes
        : ADMIT_MIN_BYTES;
    this.evictLowWater =
      typeof options.evictLowWater === 'number' &&
      Number.isFinite(options.evictLowWater) &&
      options.evictLowWater > 0 &&
      options.evictLowWater <= 1
        ? options.evictLowWater
        : OPFS_EVICT_LOW_WATER;
  }

  /** Whether this cache will actually persist anything. */
  isAvailable(): boolean {
    return this.available;
  }

  /** Current total bytes across cached entries. Cheap (read from the in-memory index). */
  getBytes(): number {
    return this.index.totalBytes;
  }

  /** Number of cached entries. */
  getEntryCount(): number {
    return this.entryCount;
  }

  /**
   * Open the OPFS directory, load the index. Memoised; subsequent calls
   * return the same promise.
   */
  private init(): Promise<void> {
    if (!this.available) {
      // Resolve once and stay no-op forever.
      return (this.initPromise ??= Promise.resolve());
    }
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      try {
        const root: FileSystemDirectoryHandle = await (
          navigator as any
        ).storage.getDirectory();
        this.dirHandle = await root.getDirectoryHandle(this.directoryName, {
          create: true,
        });
        // Quota-aware budget: never let the cache claim more than half the
        // origin's storage quota. Best-effort — `estimate()` failing (or
        // missing, e.g. the Node test shim) keeps the configured budget.
        try {
          const estimate = await (navigator as any).storage?.estimate?.();
          if (
            estimate &&
            typeof estimate.quota === 'number' &&
            estimate.quota > 0
          ) {
            this.budgetBytes = Math.min(
              this.maxBytes,
              Math.floor(estimate.quota / 2),
            );
          }
        } catch {
          /* keep the configured budget */
        }
        await this.loadIndex();
        await this.sweepOrphans();
      } catch (err) {
        // Any failure (denied, sandboxed iframe, Safari quirk) -> permanent
        // no-op. We log once so it's diagnosable without spamming the console
        // on every getTile().
        console.warn(
          '[stt] OPFS cache unavailable, running without persistence:',
          err,
        );
        this.available = false;
      }
    })();
    return this.initPromise;
  }

  /**
   * Read `index.json` if it exists, otherwise start with an empty index.
   * Corrupt index files are wiped (rare, but better to lose the cache than
   * crash on every page load).
   */
  private async loadIndex(): Promise<void> {
    if (!this.dirHandle) return;
    try {
      const handle = await this.dirHandle.getFileHandle(INDEX_FILE, {
        create: false,
      });
      const file = await handle.getFile();
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.v === INDEX_VERSION &&
        parsed.entries &&
        typeof parsed.totalBytes === 'number'
      ) {
        this.index = parsed as OpfsIndex;
        // Seed the monotonic access counter past every persisted entry so
        // new tiles always look "newer" than rehydrated ones. Also seed the
        // entry counter — this is the one place we still pay an O(n) walk,
        // amortized across the entire session.
        let count = 0;
        for (const e of Object.values(this.index.entries)) {
          if (e.lastAccess > this.accessCounter)
            this.accessCounter = e.lastAccess;
          // ADDITIVE FIELD (P0-2): an index written before `hits` existed —
          // or one carrying a mangled value — defaults to 0 here. Nothing
          // else about the entry is touched, and the index version does not
          // move, so an older index round-trips with its bytes/LRU intact.
          if (!Number.isFinite(e.hits) || e.hits < 0) e.hits = 0;
          count++;
        }
        this.entryCount = count;
        // Same additive treatment for the GDS baseline: absent (every
        // pre-BH-9 index) or mangled reads as "no baseline yet", and the key
        // is dropped rather than written back as 0 so an untouched legacy
        // index round-trips in its original shape.
        if (
          this.index.lFloor !== undefined &&
          (!Number.isFinite(this.index.lFloor) || this.index.lFloor < 0)
        ) {
          delete this.index.lFloor;
        }
      } else {
        // Older or mangled index — start fresh. Leave any orphan .bin files
        // alone; they'll be overwritten / left to OPFS's quota manager.
        this.index = { entries: {}, totalBytes: 0, v: INDEX_VERSION };
        this.entryCount = 0;
        this.markDirty();
      }
    } catch {
      // NotFoundError is the common case (first run). Anything else falls
      // through to the same empty-index initialisation.
      this.index = { entries: {}, totalBytes: 0, v: INDEX_VERSION };
      this.entryCount = 0;
    }
  }

  /**
   * Schedule a write of the in-memory index back to OPFS. Coalesces bursts
   * of mutations into a single I/O.
   */
  private markDirty(): void {
    this.indexDirty = true;
    if (this.flushTimer) return;
    // setTimeout(0) is intentional — we want the rest of the current
    // microtask batch (e.g. `Promise.all(tiles.map(set))`) to complete before
    // we serialise the index.
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushIndex();
    }, 0);
  }

  /** Force an immediate flush. Used by tests and as a shutdown helper. */
  async flushIndex(): Promise<void> {
    if (!this.available || !this.dirHandle || !this.indexDirty) return;
    this.indexDirty = false;
    const write = async (): Promise<void> => {
      const handle = await this.dirHandle!.getFileHandle(INDEX_FILE, {
        create: true,
      });
      const writable = await (handle as any).createWritable();
      await writable.write(JSON.stringify(this.index));
      await writable.close();
    };
    try {
      // Two tabs share one origin-scoped index.json; without a lock their
      // createWritable() streams interleave and the last writer clobbers
      // the other's accounting mid-write. Web Locks serialise the writers
      // (keyed per cache directory). Environments without `navigator.locks`
      // (Node shim, very old browsers) write unserialised as before.
      const locks =
        typeof navigator !== 'undefined' ? (navigator as any).locks : undefined;
      if (locks && typeof locks.request === 'function') {
        await locks.request(`stt-opfs:${this.directoryName}`, write);
      } else {
        await write();
      }
    } catch (err) {
      // Failing to persist the index isn't fatal — the entries themselves are
      // on disk; we just lose LRU ordering on the next page load.
      console.warn('[stt] OPFS index flush failed:', err);
    }
  }

  /**
   * Remove `.bin` files not referenced by the index. A tab that crashed
   * between writing a payload and flushing `index.json` — or one that lost
   * the last-writer-wins index race to a concurrent tab — leaves orphan
   * files that no eviction pass can ever reclaim (they're invisible to the
   * byte accounting). Swept once per init; directory iteration is guarded
   * for handles that don't implement it.
   */
  private async sweepOrphans(): Promise<void> {
    const dir = this.dirHandle as
      | (FileSystemDirectoryHandle & {
          keys?: () => AsyncIterableIterator<string>;
        })
      | undefined;
    if (!dir || typeof dir.keys !== 'function') return;
    try {
      const orphans: string[] = [];
      for await (const name of dir.keys()) {
        if (!name.endsWith('.bin')) continue; // never touch index.json etc.
        if (!this.index.entries[name]) orphans.push(name);
      }
      for (const name of orphans) {
        try {
          await dir.removeEntry(name);
        } catch {
          // Already gone (concurrent tab's sweep) — that's the goal anyway.
        }
      }
    } catch {
      // Best-effort: a sweep failure must never break cache init.
    }
  }

  /**
   * Look up a key. Returns the decompressed payload or `null` for a miss.
   *
   * A hit bumps `lastAccess`; the index is flushed on the same coalesced
   * timer as `set()` so a series of reads doesn't pin the writer.
   */
  async get(key: string): Promise<Uint8Array | null> {
    await this.init();
    if (!this.available || !this.dirHandle) return null;
    const entry = this.index.entries[safeFileName(key)];
    if (!entry) return null;
    try {
      const handle = await this.dirHandle.getFileHandle(safeFileName(key), {
        create: false,
      });
      const file = await handle.getFile();
      const buffer = await file.arrayBuffer();
      entry.lastAccess = this.tick();
      // A HIT is only counted once the payload actually came back — a stale
      // index entry whose file is gone falls into the catch below and is
      // forgotten, so it must not inflate the re-access estimate.
      entry.hits++;
      this.markDirty();
      return new Uint8Array(buffer);
    } catch {
      // The index claims this key exists but the file is gone. Forget it so
      // we don't keep retrying. The next `set()` for the same key will work.
      delete this.index.entries[safeFileName(key)];
      this.entryCount = Math.max(0, this.entryCount - 1);
      this.index.totalBytes = Math.max(0, this.index.totalBytes - entry.bytes);
      this.markDirty();
      return null;
    }
  }

  /**
   * Admission decision for one `set()` (BH-9). Returns `true` when the
   * payload is worth a file write plus its index churn.
   *
   * The order of the tests is the contract:
   *  1. filter off, or the caller declared no zoom → admit (incumbent);
   *  2. the key is ALREADY resident → admit. Load-bearing: the archive
   *     overwrites a corrupt OPFS payload at the same key to self-heal, and
   *     a rejected overwrite would leave the poison in place forever;
   *  3. overview tile (`zoom ≤ 2`) → admit, always;
   *  4. big enough on its own (`≥ admitMinBytes`) → admit;
   *  5. seen before this session (doorkeeper) → admit, and free the slot;
   *  6. otherwise → reject, and remember the key so a second offer gets in.
   */
  private shouldAdmit(
    fileName: string,
    byteLength: number,
    zoom: number | undefined,
  ): boolean {
    if (!this.admissionFilter) return true;
    if (typeof zoom !== 'number' || !Number.isFinite(zoom)) return true;
    if (this.index.entries[fileName]) return true;
    if (zoom <= ADMIT_ALWAYS_MAX_ZOOM) return true;
    if (byteLength >= this.admitMinBytes) return true;
    if (this.doorkeeper.has(fileName)) {
      this.doorkeeper.delete(fileName);
      return true;
    }
    if (this.doorkeeper.size >= DOORKEEPER_MAX_ENTRIES) {
      // Insertion-ordered decay: drop the oldest remembered key.
      const oldest = this.doorkeeper.values().next().value as
        | string
        | undefined;
      if (oldest !== undefined) this.doorkeeper.delete(oldest);
    }
    this.doorkeeper.add(fileName);
    return false;
  }

  /**
   * Persist a decompressed tile payload under `key`.
   *
   * Triggers eviction if writing this entry pushes us past `maxBytes`. The
   * write is best-effort: a quota or I/O failure logs once and is swallowed
   * — the caller still has the in-memory `byteCache` to fall back on.
   *
   * `opts.zoom` declares the tile's zoom so the admission filter (BH-9) can
   * apply; omitting it admits unconditionally, exactly as before. A REJECTED
   * write is a silent no-op — same observable shape as a swallowed I/O
   * failure, and the caller still holds the bytes it was going to persist.
   */
  async set(
    key: string,
    payload: Uint8Array,
    opts?: { zoom?: number },
  ): Promise<void> {
    await this.init();
    if (!this.available || !this.dirHandle) return;

    const fileName = safeFileName(key);
    if (!this.shouldAdmit(fileName, payload.byteLength, opts?.zoom)) return;
    try {
      const handle = await this.dirHandle.getFileHandle(fileName, {
        create: true,
      });
      // `createWritable` is the OPFS happy path. Some sandboxed Safari builds
      // expose `getDirectory` without it — we fall back to no-op there.
      if (typeof (handle as any).createWritable !== 'function') {
        this.available = false;
        return;
      }
      const writable = await (handle as any).createWritable();
      // Write the bytes via a fresh slice. A view backed by a shared buffer
      // (e.g. the decoder's worker-transferred ArrayBuffer) is fine; the
      // writable copies internally.
      await writable.write(payload);
      await writable.close();

      // Update index accounting.
      const prev = this.index.entries[fileName];
      if (prev) this.index.totalBytes -= prev.bytes;
      else this.entryCount++;
      this.index.entries[fileName] = {
        bytes: payload.byteLength,
        lastAccess: this.tick(),
        // Re-writing a key is the SAME logical tile (the cache key carries
        // the archive fingerprint), so its re-access history carries over. A
        // fresh key starts at 0.
        hits: prev?.hits ?? 0,
      };
      this.index.totalBytes += payload.byteLength;
      this.markDirty();

      if (this.index.totalBytes > this.budgetBytes) {
        // One ranked pass down to the LOW-WATER mark, not to the budget
        // itself, so the next ~10 % of sets do not each pay a pass again.
        await this.evict(Math.floor(this.budgetBytes * this.evictLowWater));
      }
    } catch (err) {
      // Most likely cause: quota exceeded. Eviction inside the catch lets a
      // future `set` succeed once enough room frees up. We don't rethrow so
      // a fragile filesystem doesn't poison the data path.
      console.warn('[stt] OPFS set failed:', err);
    }
  }

  /** Link rate in bytes/ms for the hit price: the hook, else the nominal. */
  private linkBytesPerMs(): number {
    const measured = this.getThroughput?.();
    return typeof measured === 'number' &&
      Number.isFinite(measured) &&
      measured > 0
      ? measured
      : DEFAULT_LINK_BYTES_PER_MS;
  }

  /**
   * GreedyDual-Size value of one entry (BH-9):
   *
   *   `H = L + (1 + hits) × cHit(b) / b`,  `cHit(b) = RTT × link + b`
   *
   * `cHit` is what a hit on this entry SAVES, in bytes: one round trip priced
   * at the current link rate, plus the transfer that no longer happens. Per
   * byte of residency that makes a small entry far more valuable than a large
   * one — the fixed round-trip term dominates it — which is the whole point:
   * a single 17 MB tile and a thousand 5 KB tiles cost the same budget, but
   * the thousand small ones save a thousand round trips.
   *
   * `(1 + hits)` is the frequency term (GDSF). `hits` comes free out of the
   * persisted index, so it survives reloads and is what separates "written
   * once, never read" from "read on every visit" — a distinction `lastAccess`
   * cannot make. `+1` keeps a never-yet-hit entry's value non-zero.
   */
  private gdsValue(entry: OpfsIndexEntry, linkBytesPerMs: number): number {
    const bytes = entry.bytes > 0 ? entry.bytes : 1;
    const cHit = RTT_EST_MS * linkBytesPerMs + bytes;
    const hits = Number.isFinite(entry.hits) && entry.hits > 0 ? entry.hits : 0;
    return (this.index.lFloor ?? 0) + ((1 + hits) * cHit) / bytes;
  }

  /**
   * Evict until the total fits in `maxBytes`. Safe to call manually — the
   * cache is also evicted automatically on `set()` when it grows past its
   * budget, down to {@link OpfsTileCacheOptions.evictLowWater} × budget.
   *
   * Victims are taken in ASCENDING GreedyDual-Size value ({@link gdsValue}),
   * ties broken by ascending `lastAccess` and then by file name, so a given
   * index state always produces the same victim sequence (the monotonic
   * access counter makes `lastAccess` unique within a session; the name
   * tiebreak covers a rehydrated index that somehow carries duplicates).
   * Each eviction raises the floating baseline `L` to the victim's own value.
   *
   * With `gdsEviction: false` every entry scores 0 and the sort degenerates
   * to the pre-BH-9 strict `lastAccess` LRU — the documented rollback.
   */
  async evict(maxBytes: number): Promise<void> {
    await this.init();
    if (!this.available || !this.dirHandle) return;
    if (this.index.totalBytes <= maxBytes) return;

    const link = this.linkBytesPerMs();
    const ranked = Object.entries(this.index.entries)
      .map(([fileName, entry]) => ({
        fileName,
        entry,
        value: this.gdsEviction ? this.gdsValue(entry, link) : 0,
      }))
      .sort(
        (a, b) =>
          a.value - b.value ||
          a.entry.lastAccess - b.entry.lastAccess ||
          (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0),
      );
    for (const { fileName, entry, value } of ranked) {
      if (this.index.totalBytes <= maxBytes) break;
      try {
        await this.dirHandle.removeEntry(fileName);
      } catch {
        // File already gone (concurrent eviction, manual cleanup) — drop the
        // index entry anyway so accounting stays honest.
      }
      delete this.index.entries[fileName];
      this.entryCount = Math.max(0, this.entryCount - 1);
      this.index.totalBytes = Math.max(0, this.index.totalBytes - entry.bytes);
      // GDS aging: the baseline never falls, so value earned under an older,
      // cheaper baseline decays relative to freshly-admitted entries. Reset
      // rather than let it inflate past the point where `L + value` loses the
      // value term to float precision (unreachable in practice — it would
      // take ~1e14 evictions — but a silent collapse to LRU is not a failure
      // mode worth leaving open).
      if (this.gdsEviction && value > (this.index.lFloor ?? 0)) {
        if (value > Number.MAX_SAFE_INTEGER / 2) delete this.index.lFloor;
        else this.index.lFloor = value;
      }
    }
    this.markDirty();
  }

  /** Drop every cached file. Mostly useful for tests / "clear cache" UI. */
  async clear(): Promise<void> {
    await this.init();
    if (!this.available || !this.dirHandle) return;
    for (const fileName of Object.keys(this.index.entries)) {
      try {
        await this.dirHandle.removeEntry(fileName);
      } catch {
        /* ignore */
      }
    }
    this.index = { entries: {}, totalBytes: 0, v: INDEX_VERSION };
    this.entryCount = 0;
    // An empty cache has no residency history, so the GDS baseline and the
    // session doorkeeper both start over with it.
    this.doorkeeper.clear();
    this.markDirty();
    await this.flushIndex();
  }

  /**
   * The persisted GreedyDual-Size baseline `L` (BH-9); `0` when no eviction
   * has ever run under this index. Diagnostics / tests only — nothing in the
   * data path reads it.
   */
  getEvictionBaseline(): number {
    return this.index.lFloor ?? 0;
  }

  /**
   * Read one persisted index entry WITHOUT touching the filesystem — the
   * "re-access probability estimated from the persisted index at zero I/O"
   * surface (P0-2 / §9.5). Returns a copy, or `null` when the key isn't
   * indexed (or the cache never initialised). Pure: does NOT bump
   * `lastAccess` and does NOT count a hit.
   */
  peekEntry(key: string): OpfsIndexEntry | null {
    const entry = this.index.entries[safeFileName(key)];
    if (!entry) return null;
    return {
      bytes: entry.bytes,
      lastAccess: entry.lastAccess,
      hits: entry.hits ?? 0,
    };
  }

  /** Stats for the perf HUD / probe consumers. `maxBytes` is the EFFECTIVE
   * (quota-clamped) budget, which is what eviction actually enforces. */
  getStats(): {
    available: boolean;
    bytes: number;
    entries: number;
    maxBytes: number;
  } {
    return {
      available: this.available,
      bytes: this.index.totalBytes,
      entries: this.entryCount,
      maxBytes: this.budgetBytes,
    };
  }
}

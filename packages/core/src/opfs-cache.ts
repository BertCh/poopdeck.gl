// @stt/core
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/core contributors

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
 *     index.json        — { entries: { safeKey: { bytes, lastAccess } }, totalBytes }
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
interface OpfsIndexEntry {
  bytes: number;
  lastAccess: number;
}

interface OpfsIndex {
  /** Map of safeKey → entry metadata. */
  entries: Record<string, OpfsIndexEntry>;
  /** Sum of `entry.bytes` across the directory. Kept in sync on set/evict. */
  totalBytes: number;
  /** Format version so we can wipe + rebuild on a breaking change. */
  v: number;
}

const INDEX_FILE = 'index.json';
const INDEX_VERSION = 1;

/**
 * Sanitize a cache key into something OPFS will accept as a filename.
 *
 * `getFileHandle` rejects `/`, `:`, `?`, etc. — which is exactly what shows
 * up in tile keys (`8/12/34/1700000000000`) and archive URLs. Hex-encoding
 * the bytes is unambiguous and length-stable, so collisions are impossible
 * for distinct inputs.
 */
function safeFileName(key: string): string {
  // TextEncoder is universally available in browsers and Node 18+.
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
   * Soft byte budget. When exceeded after a `set()`, the oldest entries are
   * deleted until the cache fits. Defaults to 512 MB.
   */
  maxBytes?: number;
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

  constructor(options: OpfsTileCacheOptions = {}) {
    this.directoryName = options.directory ?? 'stt-cache';
    this.maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
    this.budgetBytes = this.maxBytes;
    this.available = isOpfsAvailable();
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
          if (estimate && typeof estimate.quota === 'number' && estimate.quota > 0) {
            this.budgetBytes = Math.min(this.maxBytes, Math.floor(estimate.quota / 2));
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
        console.warn('[stt] OPFS cache unavailable, running without persistence:', err);
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
          if (e.lastAccess > this.accessCounter) this.accessCounter = e.lastAccess;
          count++;
        }
        this.entryCount = count;
      } else {
        // Older or mangled index — start fresh. Leave any orphan .bin files
        // alone; they'll be overwritten / left to OPFS's quota manager.
        this.index = { entries: {}, totalBytes: 0, v: INDEX_VERSION };
        this.entryCount = 0;
        this.markDirty();
      }
    } catch (err: any) {
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
      | (FileSystemDirectoryHandle & { keys?: () => AsyncIterableIterator<string> })
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
      this.markDirty();
      return new Uint8Array(buffer);
    } catch (err: any) {
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
   * Persist a decompressed tile payload under `key`.
   *
   * Triggers eviction if writing this entry pushes us past `maxBytes`. The
   * write is best-effort: a quota or I/O failure logs once and is swallowed
   * — the caller still has the in-memory `byteCache` to fall back on.
   */
  async set(key: string, payload: Uint8Array): Promise<void> {
    await this.init();
    if (!this.available || !this.dirHandle) return;

    const fileName = safeFileName(key);
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
      };
      this.index.totalBytes += payload.byteLength;
      this.markDirty();

      if (this.index.totalBytes > this.budgetBytes) {
        await this.evict(this.budgetBytes);
      }
    } catch (err) {
      // Most likely cause: quota exceeded. Eviction inside the catch lets a
      // future `set` succeed once enough room frees up. We don't rethrow so
      // a fragile filesystem doesn't poison the data path.
      console.warn('[stt] OPFS set failed:', err);
    }
  }

  /**
   * Remove least-recently-used entries until the total fits in `maxBytes`.
   * Safe to call manually — the cache is also evicted automatically on
   * `set()` when it grows past its budget.
   */
  async evict(maxBytes: number): Promise<void> {
    await this.init();
    if (!this.available || !this.dirHandle) return;
    if (this.index.totalBytes <= maxBytes) return;

    const sorted = Object.entries(this.index.entries).sort(
      (a, b) => a[1].lastAccess - b[1].lastAccess,
    );
    for (const [fileName, entry] of sorted) {
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
    this.markDirty();
    await this.flushIndex();
  }

  /** Stats for the perf HUD / probe consumers. `maxBytes` is the EFFECTIVE
   * (quota-clamped) budget, which is what eviction actually enforces. */
  getStats(): { available: boolean; bytes: number; entries: number; maxBytes: number } {
    return {
      available: this.available,
      bytes: this.index.totalBytes,
      entries: this.entryCount,
      maxBytes: this.budgetBytes,
    };
  }
}

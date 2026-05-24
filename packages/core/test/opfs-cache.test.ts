/**
 * Tests for the OPFS-backed tile cache.
 *
 * Real OPFS is Chromium-only (and only inside a browser). To exercise the
 * code paths in Node we stand up a tiny in-memory shim that implements the
 * subset of the FileSystemDirectoryHandle / FileSystemFileHandle APIs that
 * `OpfsTileCache` calls. The shim is wired in by overwriting
 * `navigator.storage.getDirectory()` for the duration of each test.
 *
 * This is intentionally NOT a mock library — the goal is to drive the same
 * code paths a Chromium browser would, so a future refactor of the cache
 * (e.g. switching to `createSyncAccessHandle`) is forced to update both the
 * production code and the shim together.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OpfsTileCache, isOpfsAvailable } from '../src/opfs-cache';

/** In-memory file: a Uint8Array plus a `getFile()`-shaped accessor. */
class MemFile {
  constructor(public bytes: Uint8Array) {}
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.buffer.slice(
      this.bytes.byteOffset,
      this.bytes.byteOffset + this.bytes.byteLength,
    );
  }
  async text(): Promise<string> {
    return new TextDecoder().decode(this.bytes);
  }
}

/** A `createWritable()` handle that buffers chunks until `close()`. */
class MemWritable {
  private chunks: Uint8Array[] = [];
  constructor(private commit: (bytes: Uint8Array) => void) {}
  async write(data: Uint8Array | string | ArrayBuffer): Promise<void> {
    let bytes: Uint8Array;
    if (typeof data === 'string') bytes = new TextEncoder().encode(data);
    else if (data instanceof Uint8Array) bytes = data;
    else bytes = new Uint8Array(data as ArrayBuffer);
    // Copy because the caller may reuse the buffer.
    this.chunks.push(new Uint8Array(bytes));
  }
  async close(): Promise<void> {
    const total = this.chunks.reduce((s, c) => s + c.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    this.commit(out);
  }
}

class MemFileHandle {
  constructor(private dir: MemDirectoryHandle, public name: string) {}
  async getFile(): Promise<MemFile> {
    const bytes = this.dir._files.get(this.name);
    if (!bytes) {
      const err: any = new Error(`NotFoundError: ${this.name}`);
      err.name = 'NotFoundError';
      throw err;
    }
    return new MemFile(bytes);
  }
  async createWritable(): Promise<MemWritable> {
    return new MemWritable((bytes) => {
      this.dir._files.set(this.name, bytes);
    });
  }
}

class MemDirectoryHandle {
  /** Public for the test shim only. */
  _files = new Map<string, Uint8Array>();
  _subdirs = new Map<string, MemDirectoryHandle>();

  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<MemFileHandle> {
    if (!this._files.has(name)) {
      if (options?.create) {
        this._files.set(name, new Uint8Array());
      } else {
        const err: any = new Error(`NotFoundError: ${name}`);
        err.name = 'NotFoundError';
        throw err;
      }
    }
    return new MemFileHandle(this, name);
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<MemDirectoryHandle> {
    let sub = this._subdirs.get(name);
    if (!sub) {
      if (!options?.create) {
        const err: any = new Error(`NotFoundError: ${name}`);
        err.name = 'NotFoundError';
        throw err;
      }
      sub = new MemDirectoryHandle();
      this._subdirs.set(name, sub);
    }
    return sub;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this._files.has(name)) {
      const err: any = new Error(`NotFoundError: ${name}`);
      err.name = 'NotFoundError';
      throw err;
    }
    this._files.delete(name);
  }
}

/**
 * Install the shim onto globalThis.navigator.storage.
 *
 * Node 20 exposes `navigator` as a read-only accessor on globalThis, so a
 * direct assignment throws. We override the property via `Object.defineProperty`
 * (configurable so `uninstallShim` can restore the original).
 */
let originalNavigatorDescriptor: PropertyDescriptor | undefined;
function installShim(): MemDirectoryHandle {
  const root = new MemDirectoryHandle();
  originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'navigator',
  );
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      ...(originalNavigatorDescriptor?.value ?? {}),
      storage: { getDirectory: async () => root },
    },
  });
  return root;
}

function uninstallShim() {
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
    originalNavigatorDescriptor = undefined;
  } else {
    try {
      delete (globalThis as any).navigator;
    } catch {
      /* ignore */
    }
  }
}

describe('OpfsTileCache', () => {
  afterEach(() => {
    uninstallShim();
  });

  it('reports unavailable when navigator.storage is missing', async () => {
    uninstallShim();
    expect(isOpfsAvailable()).toBe(false);
    const cache = new OpfsTileCache();
    expect(cache.isAvailable()).toBe(false);
    // No-op set / get.
    await cache.set('k', new Uint8Array([1, 2, 3]));
    expect(await cache.get('k')).toBeNull();
  });

  it('persists and reads back a payload (warm hit)', async () => {
    installShim();
    expect(isOpfsAvailable()).toBe(true);
    const cache = new OpfsTileCache();
    expect(cache.isAvailable()).toBe(true);
    const payload = new Uint8Array([10, 20, 30, 40, 50]);
    await cache.set('tile-A', payload);
    const got = await cache.get('tile-A');
    expect(got).not.toBeNull();
    expect(Array.from(got!)).toEqual([10, 20, 30, 40, 50]);
  });

  it('returns null for a key that was never written (cold miss)', async () => {
    installShim();
    const cache = new OpfsTileCache();
    expect(await cache.get('missing')).toBeNull();
  });

  it('survives across cache instances (index is rehydrated)', async () => {
    const root = installShim();
    const a = new OpfsTileCache();
    await a.set('shared', new Uint8Array([1, 1, 2, 3, 5, 8]));
    // Force the index flush to disk.
    await a.flushIndex();
    // A fresh cache pointed at the same OPFS root should see the entry.
    const b = new OpfsTileCache();
    const got = await b.get('shared');
    expect(got).not.toBeNull();
    expect(Array.from(got!)).toEqual([1, 1, 2, 3, 5, 8]);
    // And the directory itself contains the index + one .bin file.
    const dir = await root.getDirectoryHandle('stt-cache');
    expect(dir._files.size).toBeGreaterThanOrEqual(2);
  });

  it('evicts least-recently-used entries when over budget', async () => {
    installShim();
    // 100-byte budget; every entry is 40 bytes, so we can only fit two.
    const cache = new OpfsTileCache({ maxBytes: 100 });
    const a = new Uint8Array(40).fill(1);
    const b = new Uint8Array(40).fill(2);
    const c = new Uint8Array(40).fill(3);
    await cache.set('A', a);
    await cache.set('B', b);
    // Touch A so B becomes least-recently-used.
    await cache.get('A');
    await cache.set('C', c);

    // B should have been evicted.
    expect(await cache.get('B')).toBeNull();
    expect(await cache.get('A')).not.toBeNull();
    expect(await cache.get('C')).not.toBeNull();
    expect(cache.getBytes()).toBeLessThanOrEqual(100);
  });

  it('clear() removes every entry', async () => {
    installShim();
    const cache = new OpfsTileCache();
    await cache.set('x', new Uint8Array([1]));
    await cache.set('y', new Uint8Array([2]));
    await cache.clear();
    expect(await cache.get('x')).toBeNull();
    expect(await cache.get('y')).toBeNull();
    expect(cache.getEntryCount()).toBe(0);
    expect(cache.getBytes()).toBe(0);
  });

  it('safely handles keys with characters illegal in filenames', async () => {
    installShim();
    const cache = new OpfsTileCache();
    // The archive uses keys like "https://cdn/a.stt::8/12/34/170::W/abc".
    const key = 'https://cdn/a.stt::8/12/34/170::W/"abc:def"';
    await cache.set(key, new Uint8Array([9, 9, 9]));
    const got = await cache.get(key);
    expect(got).not.toBeNull();
    expect(Array.from(got!)).toEqual([9, 9, 9]);
  });

  it('getStats reports availability, bytes, and entry count', async () => {
    installShim();
    const cache = new OpfsTileCache({ maxBytes: 1024 });
    await cache.set('k1', new Uint8Array(100));
    await cache.set('k2', new Uint8Array(50));
    const stats = cache.getStats();
    expect(stats.available).toBe(true);
    expect(stats.entries).toBe(2);
    expect(stats.bytes).toBe(150);
    expect(stats.maxBytes).toBe(1024);
  });
});

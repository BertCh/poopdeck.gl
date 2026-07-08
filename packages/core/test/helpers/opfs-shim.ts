/**
 * In-memory OPFS shim shared by the OPFS-backed cache tests.
 *
 * Real OPFS is Chromium-only (and only inside a browser). To exercise the
 * `OpfsTileCache` code paths in Node we stand up a tiny in-memory shim that
 * implements the subset of the FileSystemDirectoryHandle / FileSystemFileHandle
 * APIs the cache calls, wired in by overwriting `navigator.storage.getDirectory`
 * for the duration of each test.
 *
 * This is intentionally NOT a mock library — the goal is to drive the same
 * code paths a Chromium browser would, so a future refactor of the cache (e.g.
 * switching to `createSyncAccessHandle`) is forced to update both the
 * production code and the shim together. It is the single copy: previously
 * `opfs-cache.test.ts` carried the full version and `archive-opfs.test.ts` a
 * condensed, drift-prone duplicate.
 */

/** In-memory file: a Uint8Array plus a `getFile()`-shaped accessor. */
export class MemFile {
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
export class MemWritable {
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

export class MemFileHandle {
  constructor(
    private dir: MemDirectoryHandle,
    public name: string,
  ) {}
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

export class MemDirectoryHandle {
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

  /** Directory iteration (file names; subset of the real API the sweep uses). */
  async *keys(): AsyncIterableIterator<string> {
    for (const name of Array.from(this._files.keys())) {
      yield name;
    }
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
export function installShim(): MemDirectoryHandle {
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

export function uninstallShim(): void {
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

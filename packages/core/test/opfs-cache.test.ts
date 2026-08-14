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

import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpfsTileCache, isOpfsAvailable } from '../src/opfs-cache';
import { installShim, uninstallShim } from './helpers/opfs-shim';

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

  it('sweeps orphan .bin files not referenced by the index on init', async () => {
    const root = installShim();
    // A first cache writes one legitimate entry and persists its index.
    const a = new OpfsTileCache();
    await a.set('real', new Uint8Array([1, 2, 3]));
    await a.flushIndex();

    // Simulate a crashed tab / lost index race: a payload file exists on
    // disk but no index entry references it. Eviction can never reclaim it.
    const dir = await root.getDirectoryHandle('stt-cache');
    dir._files.set('deadbeef.bin', new Uint8Array(64));

    // A fresh cache's init must sweep the orphan and keep everything else.
    const b = new OpfsTileCache();
    expect(await b.get('real')).not.toBeNull(); // triggers init + sweep
    expect(dir._files.has('deadbeef.bin')).toBe(false);
    expect(dir._files.has('index.json')).toBe(true);
    expect(Array.from(dir._files.keys()).some((n) => n.endsWith('.bin'))).toBe(
      true,
    );
  });

  it('serialises index flushes through navigator.locks when available', async () => {
    installShim();
    const order: string[] = [];
    const request = vi.fn(async (_name: string, cb: () => Promise<void>) => {
      order.push('lock');
      await cb();
      order.push('unlock');
    });
    (globalThis.navigator as any).locks = { request };

    const cache = new OpfsTileCache();
    await cache.set('k', new Uint8Array([7]));
    await cache.flushIndex();
    expect(request).toHaveBeenCalledWith(
      'stt-opfs:stt-cache',
      expect.any(Function),
    );
    expect(order).toEqual(['lock', 'unlock']);

    // The write went through the lock and still persisted: a fresh cache
    // over the same root rehydrates the entry.
    const b = new OpfsTileCache();
    expect(await b.get('k')).not.toBeNull();
  });

  // ── BH-9: GreedyDual-Size eviction + the admission filter ──────────────
  //
  // The gap this closes (§9.5): a byte budget spent by RECENCY alone treats a
  // 17 MB satellite overview and a 5 KB leaf tile as equally worth keeping,
  // even though the small one saves a whole round trip for 0.03% of the
  // budget — and it has no way to notice that one of them has been read on
  // every visit while the other never was.

  /** Ten small hot tiles + one huge cold one, at the same recency class. */
  async function mixedSizeCache(
    options: ConstructorParameters<typeof OpfsTileCache>[0] = {},
  ) {
    const cache = new OpfsTileCache({ maxBytes: 64 * 1024 * 1024, ...options });
    const SMALL = 5 * 1024;
    const BIG = 17 * 1024 * 1024;
    for (let i = 0; i < 10; i++) {
      await cache.set(`small-${i}`, new Uint8Array(SMALL).fill(i + 1));
    }
    // Each small tile is read back on three visits; the big one just once.
    for (let visit = 0; visit < 3; visit++) {
      for (let i = 0; i < 10; i++)
        expect(await cache.get(`small-${i}`)).not.toBeNull();
    }
    await cache.set('big', new Uint8Array(BIG));
    expect(await cache.get('big')).not.toBeNull();
    return { cache, SMALL, BIG };
  }

  it('GDS evicts one huge one-hit entry before ten small multi-hit ones', async () => {
    installShim();
    const { cache, SMALL, BIG } = await mixedSizeCache({ directory: 'gds' });
    // A target reachable EITHER by dropping the one big entry or by dropping
    // six small ones — so the choice, not the arithmetic, decides.
    await cache.evict(BIG + 4 * SMALL);
    expect(await cache.get('big')).toBeNull();
    for (let i = 0; i < 10; i++) {
      expect(await cache.get(`small-${i}`)).not.toBeNull();
    }
    expect(cache.getBytes()).toBe(10 * SMALL);
    // Each eviction raises the floating baseline `L`, which is persisted.
    expect(cache.getEvictionBaseline()).toBeGreaterThan(0);
  });

  it('the gdsEviction:false rollback is the incumbent lastAccess LRU', async () => {
    installShim();
    const { cache, SMALL, BIG } = await mixedSizeCache({
      directory: 'lru',
      gdsEviction: false,
    });
    await cache.evict(BIG + 4 * SMALL);
    // Recency-only: the small tiles were last read BEFORE the big one was
    // written, so LRU spends the hot set six tiles deep and keeps the cold
    // 17 MB blob — the §9.5 pathology, reproduced by the rollback path.
    expect(await cache.get('big')).not.toBeNull();
    expect(await cache.get('small-0')).toBeNull();
    expect(await cache.get('small-5')).toBeNull();
    expect(await cache.get('small-6')).not.toBeNull();
    expect(cache.getEvictionBaseline()).toBe(0);
  });

  it('prices a saved round trip off the throughput hook when one is wired', async () => {
    installShim();
    // On a very fast link the round-trip term shrinks, so size matters less
    // and the frequency term decides; the ranking must move with the hook.
    const fast = new OpfsTileCache({
      directory: 'fast',
      getThroughput: () => 1e9,
    });
    const slow = new OpfsTileCache({
      directory: 'slow',
      getThroughput: () => null, // cold estimator → nominal fallback
    });
    for (const c of [fast, slow]) {
      await c.set('tiny-hot', new Uint8Array(1024));
      await c.get('tiny-hot');
      await c.set('big-cold', new Uint8Array(1024 * 1024));
    }
    // Under the nominal rate the big cold entry is by far the cheapest.
    await slow.evict(900 * 1024);
    expect(await slow.get('big-cold')).toBeNull();
    expect(await slow.get('tiny-hot')).not.toBeNull();
    // Under an effectively-infinite link the round trip is worth ~nothing,
    // so per-byte value is dominated by frequency — the hot entry still
    // survives, i.e. the hook feeds the formula rather than being ignored.
    await fast.evict(900 * 1024);
    expect(await fast.get('tiny-hot')).not.toBeNull();
  });

  it('keeps the resident byte sum inside the budget after every evict', async () => {
    installShim();
    const BUDGET = 40 * 1024;
    const cache = new OpfsTileCache({ maxBytes: BUDGET });
    const sizes = [7000, 1500, 12000, 3000, 9000, 500, 21000, 4000, 6500];
    for (let i = 0; i < sizes.length; i++) {
      await cache.set(`k${i}`, new Uint8Array(sizes[i]).fill(i));
      expect(cache.getBytes()).toBeLessThanOrEqual(BUDGET);
      // Accounting stays exact: the index total equals what is readable.
      let live = 0;
      for (let j = 0; j <= i; j++) {
        const got = await cache.get(`k${j}`);
        if (got) live += got.byteLength;
      }
      expect(cache.getBytes()).toBe(live);
    }
  });

  it('evicts deterministically: identical index states pick identical victims', async () => {
    installShim();
    const run = async (dir: string): Promise<string[]> => {
      const cache = new OpfsTileCache({ directory: dir, maxBytes: 1 << 20 });
      // Deliberate ties: same size, same hit count. Only the monotonic
      // lastAccess counter separates them.
      for (let i = 0; i < 8; i++) {
        await cache.set(`t${i}`, new Uint8Array(4096).fill(i));
      }
      await cache.evict(4096 * 4);
      const survivors: string[] = [];
      for (let i = 0; i < 8; i++) {
        if (await cache.get(`t${i}`)) survivors.push(`t${i}`);
      }
      return survivors;
    };
    const a = await run('det-a');
    const b = await run('det-b');
    expect(a).toEqual(b);
    // Ties resolve by ascending lastAccess, so the four newest survive.
    expect(a).toEqual(['t4', 't5', 't6', 't7']);
  });

  it('ADMISSION: a sub-4 KiB tile is skipped on first touch and admitted on the second', async () => {
    installShim();
    const cache = new OpfsTileCache({ admissionFilter: true });
    const tiny = new Uint8Array(1024).fill(3);
    await cache.set('leaf', tiny, { zoom: 11 });
    expect(await cache.get('leaf')).toBeNull();
    expect(cache.getEntryCount()).toBe(0); // no file, no index churn
    // Second offer of the SAME key: the doorkeeper lets it in.
    await cache.set('leaf', tiny, { zoom: 11 });
    const got = await cache.get('leaf');
    expect(got).not.toBeNull();
    expect(got!.byteLength).toBe(1024);
  });

  it('ADMISSION: overview tiles and big tiles are always admitted first touch', async () => {
    installShim();
    const cache = new OpfsTileCache({ admissionFilter: true });
    for (const z of [0, 1, 2]) {
      await cache.set(`ov-${z}`, new Uint8Array(64).fill(z), { zoom: z });
      expect(await cache.get(`ov-${z}`)).not.toBeNull();
    }
    // Above the overview band, size alone is enough.
    await cache.set('fat', new Uint8Array(4096), { zoom: 12 });
    expect(await cache.get('fat')).not.toBeNull();
    // …one byte short of it is not.
    await cache.set('lean', new Uint8Array(4095), { zoom: 12 });
    expect(await cache.get('lean')).toBeNull();
  });

  it('ADMISSION: a re-write of a RESIDENT key is always admitted (self-heal)', async () => {
    installShim();
    const cache = new OpfsTileCache({ admissionFilter: true });
    await cache.set('k', new Uint8Array(8192), { zoom: 9 }); // admitted on size
    // The archive overwrites a corrupt payload at the same key to self-heal.
    // A rejected overwrite would strand the poison forever.
    await cache.set('k', new Uint8Array(64).fill(9), { zoom: 9 });
    const got = await cache.get('k');
    expect(got).not.toBeNull();
    expect(got!.byteLength).toBe(64);
    expect(cache.getBytes()).toBe(64);
  });

  it('ADMISSION: off by default, and never engages for a caller that declares no zoom', async () => {
    installShim();
    // Default instance (what `opfsCacheImpl` callers construct): admit-all.
    const incumbent = new OpfsTileCache({ directory: 'incumbent' });
    await incumbent.set('tiny', new Uint8Array(16), { zoom: 14 });
    expect(await incumbent.get('tiny')).not.toBeNull();
    // Filter on, but no zoom declared → unknown provenance → admit.
    const filtered = new OpfsTileCache({
      directory: 'filtered',
      admissionFilter: true,
    });
    await filtered.set('tiny', new Uint8Array(16));
    expect(await filtered.get('tiny')).not.toBeNull();
    // admitMinBytes: 0 is the documented rollback constant.
    const openDoor = new OpfsTileCache({
      directory: 'open',
      admissionFilter: true,
      admitMinBytes: 0,
    });
    await openDoor.set('tiny', new Uint8Array(16), { zoom: 14 });
    expect(await openDoor.get('tiny')).not.toBeNull();
  });

  it('carries hits and the GDS baseline across cache instances', async () => {
    installShim();
    const a = new OpfsTileCache({ maxBytes: 16 * 1024 });
    await a.set('warm', new Uint8Array(2048));
    await a.get('warm');
    await a.get('warm');
    await a.set('cold', new Uint8Array(8192));
    await a.evict(4096); // drop `cold`: same recency class, far less value/byte
    const baseline = a.getEvictionBaseline();
    expect(baseline).toBeGreaterThan(0);
    await a.flushIndex();

    const b = new OpfsTileCache({ maxBytes: 16 * 1024 });
    expect(await b.get('warm')).not.toBeNull(); // triggers init + rehydrate
    expect(b.peekEntry('warm')!.hits).toBe(3); // 2 before the reload, 1 after
    expect(b.getEvictionBaseline()).toBe(baseline);
    expect(await b.get('cold')).toBeNull();
  });

  it('keeps totalBytes exact across a lock-serialised handover between tabs', async () => {
    installShim();
    const order: string[] = [];
    (globalThis.navigator as any).locks = {
      request: async (name: string, cb: () => Promise<void>) => {
        order.push(name);
        await cb();
      },
    };
    const tabA = new OpfsTileCache();
    await tabA.set('a1', new Uint8Array(1000));
    await tabA.set('a2', new Uint8Array(2000));
    await tabA.get('a1'); // a hit → the new fields ride the same flush
    await tabA.flushIndex();

    const tabB = new OpfsTileCache();
    expect(await tabB.get('a1')).not.toBeNull();
    await tabB.set('b1', new Uint8Array(3000));
    await tabB.flushIndex();

    const reader = new OpfsTileCache();
    expect(await reader.get('a2')).not.toBeNull();
    expect(reader.getEntryCount()).toBe(3);
    expect(reader.getBytes()).toBe(6000);
    expect(reader.peekEntry('a1')!.hits).toBe(2);
    expect(order.every((n) => n === 'stt-opfs:stt-cache')).toBe(true);
  });

  it('loads a legacy index that predates BOTH additive fields, without a wipe', async () => {
    const root = installShim();
    // The regression pin for `INDEX_VERSION` staying 1: no `hits`, no
    // `lFloor`, and nothing may be dropped or renumbered on load.
    const dir = await root.getDirectoryHandle('stt-cache', { create: true });
    const name = (key: string): string => {
      const bytes = new TextEncoder().encode(key);
      let hex = '';
      for (let i = 0; i < bytes.length; i++)
        hex += bytes[i].toString(16).padStart(2, '0');
      return `${hex}.bin`;
    };
    const legacy = {
      v: 1,
      totalBytes: 12,
      entries: {
        [name('legacy-a')]: { bytes: 5, lastAccess: 11 },
        [name('legacy-b')]: { bytes: 7, lastAccess: 12 },
      },
    };
    const idx = await dir.getFileHandle('index.json', { create: true });
    const w = await idx.createWritable();
    await w.write(JSON.stringify(legacy));
    await w.close();
    for (const [key, size] of [
      ['legacy-a', 5],
      ['legacy-b', 7],
    ] as Array<[string, number]>) {
      const h = await dir.getFileHandle(name(key), { create: true });
      const fw = await h.createWritable();
      await fw.write(new Uint8Array(size));
      await fw.close();
    }

    const cache = new OpfsTileCache();
    expect(await cache.get('legacy-a')).not.toBeNull();
    expect(cache.getEntryCount()).toBe(2);
    expect(cache.getBytes()).toBe(12);
    expect(cache.getEvictionBaseline()).toBe(0);
    // The rewritten index is still v1 and gains no per-entry field; `lFloor`
    // is absent until an eviction actually floats it.
    await cache.flushIndex();
    const persisted = JSON.parse(
      await (await (await dir.getFileHandle('index.json')).getFile()).text(),
    );
    expect(persisted.v).toBe(1);
    expect('lFloor' in persisted).toBe(false);
    expect(persisted.entries[name('legacy-b')]).toEqual({
      bytes: 7,
      lastAccess: 12,
      hits: 0,
    });
  });

  it('ignores a mangled lFloor rather than wiping the index', async () => {
    const root = installShim();
    const dir = await root.getDirectoryHandle('stt-cache', { create: true });
    const idx = await dir.getFileHandle('index.json', { create: true });
    const w = await idx.createWritable();
    await w.write(
      JSON.stringify({
        v: 1,
        totalBytes: 0,
        entries: {},
        lFloor: 'huge' as unknown as number,
      }),
    );
    await w.close();
    const cache = new OpfsTileCache();
    await cache.set('x', new Uint8Array(4));
    expect(await cache.get('x')).not.toBeNull();
    expect(cache.getEvictionBaseline()).toBe(0);
  });

  it('set() still never throws to the data path when the write fails', async () => {
    const root = installShim();
    const cache = new OpfsTileCache();
    await cache.set('seed', new Uint8Array(4)); // forces init()
    const dir = await root.getDirectoryHandle('stt-cache');
    (dir as any).getFileHandle = async () => {
      throw new Error('QuotaExceededError');
    };
    await expect(
      cache.set('boom', new Uint8Array(8), { zoom: 4 }),
    ).resolves.toBeUndefined();
    // …and eviction over a failing directory is equally non-fatal.
    await expect(cache.evict(0)).resolves.toBeUndefined();
  });

  it('clamps the byte budget to half the storage quota', async () => {
    installShim();
    (globalThis.navigator as any).storage.estimate = async () => ({
      quota: 100,
      usage: 0,
    });
    const cache = new OpfsTileCache(); // default 512 MB budget → clamped to 50
    const a = new Uint8Array(40).fill(1);
    const b = new Uint8Array(40).fill(2);
    await cache.set('A', a);
    await cache.set('B', b); // 80 bytes > 50 → LRU eviction kicks in
    expect(cache.getStats().maxBytes).toBe(50);
    expect(await cache.get('A')).toBeNull();
    expect(await cache.get('B')).not.toBeNull();
    expect(cache.getBytes()).toBeLessThanOrEqual(50);
  });
});

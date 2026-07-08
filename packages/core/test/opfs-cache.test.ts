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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

/**
 * Tile identity: one producer, three flavours, no cross-tier collisions.
 *
 * The failure these guard against is silent: a temporal-LOD tile and the
 * base tile whose bucket starts at the same instant share `z/x/y/t`, so any
 * key that drops the tier merges them and one tier is served the other's
 * bytes. The keys are also cache addresses — `tileKey` reaches OPFS — so
 * "equal ids produce an identical string" is a correctness requirement, not
 * a stylistic one.
 */

import { describe, it, expect } from 'vitest';
import {
  tileKey,
  tileEntryKey,
  tileCellKey,
  type TileKey,
} from '../src/tile-key';
import type { TileId } from '../src/types';

const BASE: TileId = { z: 8, x: 12, y: 34, t: 1_700_000_000_000 };
const LOD: TileId = { ...BASE, bucketMs: 6 * 3600 * 1000 };

describe('tileKey', () => {
  it('separates a temporal-LOD tile from the base tile at the same address', () => {
    expect(tileKey(LOD)).not.toBe(tileKey(BASE));
  });

  it('separates two LOD tiers that share an address', () => {
    const sixHour = tileKey({ ...BASE, bucketMs: 6 * 3600 * 1000 });
    const dayLong = tileKey({ ...BASE, bucketMs: 24 * 3600 * 1000 });
    expect(sixHour).not.toBe(dayLong);
  });

  it('is stable for equal ids regardless of property order or extra keys', () => {
    const a = tileKey({ z: 8, x: 12, y: 34, t: 1_700_000_000_000 });
    const b = tileKey({ t: 1_700_000_000_000, y: 34, x: 12, z: 8 });
    expect(a).toBe(b);
    expect(tileKey({ ...LOD })).toBe(tileKey(LOD));
  });

  it('treats an explicitly undefined bucketMs as the base tier', () => {
    expect(tileKey({ ...BASE, bucketMs: undefined })).toBe(tileKey(BASE));
  });

  it('holds the persisted OPFS spelling', () => {
    // Changing either string orphans every tile already cached in OPFS.
    expect(tileKey(BASE)).toBe('8/12/34/1700000000000#0');
    expect(tileKey(LOD)).toBe('8/12/34/1700000000000#0@21600000');
  });

  it('separates raw and summary at the exact same space/time address', () => {
    const summary = { ...BASE, variantId: 1 };
    expect(tileKey(summary)).not.toBe(tileKey(BASE));
    const cache = new Map([
      [tileKey(BASE), 'raw'],
      [tileKey(summary), 'summary'],
    ]);
    expect(cache.size).toBe(2);
  });

  it('distinguishes ids that differ in exactly one coordinate', () => {
    const keys = new Set<TileKey>([
      tileKey(BASE),
      tileKey({ ...BASE, z: 9 }),
      tileKey({ ...BASE, x: 13 }),
      tileKey({ ...BASE, y: 35 }),
      tileKey({ ...BASE, t: BASE.t + 1 }),
      tileKey(LOD),
    ]);
    expect(keys.size).toBe(6);
  });

  it('keeps both tiers addressable in one map', () => {
    const cache = new Map<TileKey, string>();
    cache.set(tileKey(BASE), 'base bytes');
    cache.set(tileKey(LOD), 'lod bytes');
    expect(cache.size).toBe(2);
    expect(cache.get(tileKey(BASE))).toBe('base bytes');
    expect(cache.get(tileKey(LOD))).toBe('lod bytes');
  });
});

describe('tileEntryKey', () => {
  it('gives an untagged entry a slot no bucket width can occupy', () => {
    // A directory entry with no `temporal_bucket_ms` column is a third
    // state: it satisfies a base-tier lookup, but the resolver probes for
    // it separately, so it must not collide with the base bucket width.
    const untagged = tileEntryKey(8, 12, 34, BASE.t, 0, undefined);
    const tagged = tileEntryKey(8, 12, 34, BASE.t, 0, 3600 * 1000);
    expect(untagged).not.toBe(tagged);
  });

  it('separates tiers sharing an address', () => {
    expect(tileEntryKey(8, 12, 34, BASE.t, 0, 3600 * 1000)).not.toBe(
      tileEntryKey(8, 12, 34, BASE.t, 0, 6 * 3600 * 1000),
    );
  });

  it('is stable for the same arguments', () => {
    expect(tileEntryKey(8, 12, 34, BASE.t, 0, 3600 * 1000)).toBe(
      tileEntryKey(8, 12, 34, BASE.t, 0, 3600 * 1000),
    );
  });

  it('cannot be confused with a tileKey for the same tile', () => {
    expect(tileEntryKey(LOD.z, LOD.x, LOD.y, LOD.t, 0, LOD.bucketMs)).not.toBe(
      tileKey(LOD),
    );
  });

  it('separates raw and summary entries with identical bucket widths', () => {
    expect(tileEntryKey(8, 12, 34, BASE.t, 0, 3_600_000)).not.toBe(
      tileEntryKey(8, 12, 34, BASE.t, 1, 3_600_000),
    );
  });
});

describe('tileCellKey', () => {
  it('names the cell, not the tile: time and tier are absent by design', () => {
    expect(tileCellKey(8, 12, 34)).toBe('8/12/34');
    expect(tileCellKey(BASE.z, BASE.x, BASE.y)).toBe(
      tileCellKey(LOD.z, LOD.x, LOD.y),
    );
  });

  it('separates distinct cells', () => {
    const keys = new Set([
      tileCellKey(8, 12, 34),
      tileCellKey(9, 12, 34),
      tileCellKey(8, 13, 34),
      tileCellKey(8, 12, 35),
    ]);
    expect(keys.size).toBe(4);
  });

  it('is not a prefix that can alias a deeper cell', () => {
    // "8/1" + "2/34" must not reach the same string as "8/12" + "/34".
    expect(tileCellKey(8, 1, 234)).not.toBe(tileCellKey(8, 12, 34));
  });
});

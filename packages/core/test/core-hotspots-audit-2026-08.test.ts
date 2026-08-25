/**
 * Core hot-spot audit (2026-08-24) — benchmarks-as-tests.
 *
 * Three node-measured main-thread hot spots in core, each pinned with a
 * STRUCTURAL assertion that always runs and a TIMING assertion that is skipped
 * under CI (`process.env.CI`), where wall-clock is noise:
 *
 *   H1  `TrackIndexMaintainer.sync` ordered every dirty track's groups by
 *       scanning EVERY resident tile-layer key (854 tile-layers × 30k tracks →
 *       313 ms in that loop alone on a cold sync). Now each dirty track sorts
 *       only its own groups by a per-sync rank map ({@link orderGroups}).
 *   H2  `decodeDirectory` accumulated every varint as a BigInt (42 vs 6 ns per
 *       varint ⇒ ~4.9 ms of synchronous decode per 4,096-entry leaf; a pan
 *       pulls 4–8 leaves). Now a Number fast path below 2^53, keeping the exact
 *       BigInt read for the reject path. The pre-change decoder is reproduced
 *       VERBATIM below as the oracle both the fixture and the fuzz run against.
 *   H3  `OpfsTileCache.set` ranked all N entries and evicted to exactly the
 *       budget, so every steady-state set paid a full ranking pass. Now an
 *       over-budget set evicts to a low-water mark (0.9 × budget).
 *
 * Functional pins live next to the code they cover (`track-kernel.test.ts`,
 * `directory.test.ts`, `paged-directory.test.ts`, `opfs-cache.test.ts`).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as nodeFs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { makePointTile, categorical } from './helpers/track-tiles';
import {
  TrackIndexMaintainer,
  orderGroups,
  tileLayerKey,
} from '../src/render/track-kernel';
import type { TrackFieldConfig } from '../src/render/track-kernel';
import type { Tile } from '../src/types';
import {
  DIRECTORY_VERSION,
  MIN_DIRECTORY_VERSION,
  decodeDirectory,
  decodePagedRoot,
  encodeDirectory,
} from '../src/directory';
import type { DirectoryEncodeEntry, DirectoryEntry } from '../src/directory';
import { unzstdSync } from '../src/compression';
import {
  OBJECT_MAGIC_LEN,
  loadPackedDatasetFromDisk,
  type InMemoryPackedDataset,
} from './helpers/packed-fixture';
import { OpfsTileCache } from '../src/opfs-cache';
import { installShim, uninstallShim } from './helpers/opfs-shim';

const TIMING = !process.env.CI;

// ─── H1: dirty-track ordering ───────────────────────────────────────────────

const CFG: TrackFieldConfig = {
  trackIdProperty: 'track_id',
  colorProperty: '',
  labelProperty: 'category',
  headingProperty: 'heading',
  lengthProperty: 'length',
  widthProperty: 'width',
  heightProperty: 'height',
  speedProperty: 'speed',
  colorMapping: null,
  colorMappingDefault: [160, 160, 160, 255],
};

/**
 * `tileLayers` point tiles holding `tracks` two-keyframe tracks: track j starts
 * (t=0) in tile j % tileLayers and ends (t=1000) in tile (j+1) % tileLayers,
 * so every track spans exactly two tile-layers and every tile-layer holds
 * 2 × tracks / tileLayers features.
 */
function trackChurnFixture(tileLayers: number, tracks: number): Tile[] {
  const ids: string[][] = Array.from({ length: tileLayers }, () => []);
  const times: number[][] = Array.from({ length: tileLayers }, () => []);
  for (let j = 0; j < tracks; j++) {
    const a = j % tileLayers;
    const b = (j + 1) % tileLayers;
    ids[a].push(`T${j}`);
    times[a].push(0);
    ids[b].push(`T${j}`);
    times[b].push(1000);
  }
  return ids.map((trackIds, i) => {
    const tile = makePointTile({
      positions: trackIds.map((_, f) => [i, f]),
      startTimes: times[i],
      endTimes: times[i],
      timeOffset: 0,
      tileId: { z: 10, x: i % 64, y: Math.floor(i / 64), t: 0 },
    });
    tile.layers[0].features.categoricalProps['track_id'] =
      categorical(trackIds);
    return tile;
  });
}

/** The per-track group maps the maintainer keeps, for `tracks` tracks over `keys`. */
function perTrackGroups(keys: string[], tracks: number): Map<string, object>[] {
  const out: Map<string, object>[] = [];
  for (let j = 0; j < tracks; j++) {
    const g = new Map<string, object>();
    // Absorbed later-first, so ordering by rank has real work to do.
    g.set(keys[(j + 1) % keys.length], { j, end: true });
    g.set(keys[j % keys.length], { j, end: false });
    out.push(g);
  }
  return out;
}

/** The pre-change inner loop: walk EVERY resident key for one dirty track. */
function residentKeyScan(g: Map<string, object>, keys: string[]): object[] {
  const ordered: object[] = [];
  for (const key of keys) {
    const x = g.get(key);
    if (x) ordered.push(x);
  }
  return ordered;
}

describe('H1: TrackIndexMaintainer dirty-track ordering', () => {
  it('orderGroups yields exactly the resident-key-scan order for every track', () => {
    const tiles = trackChurnFixture(800, 2_000);
    const keys = tiles.map((t) => tileLayerKey(t.id, t.layers[0].name));
    const rank = new Map<string, number>();
    keys.forEach((k, i) => rank.set(k, i));
    for (const g of perTrackGroups(keys, 2_000)) {
      expect(orderGroups(g, rank)).toEqual(residentKeyScan(g, keys));
    }
    // A group whose key is not resident this sync is dropped, as the scan did.
    const stray = new Map<string, object>([
      ['not-resident', { j: -1 }],
      [keys[3], { j: 3 }],
    ]);
    expect(orderGroups(stray, rank)).toEqual([{ j: 3 }]);
  });

  it.skipIf(!TIMING)(
    'rank-sorting each track’s own groups beats the resident-key scan ≥ 5× (800 tile-layers × 20k tracks)',
    () => {
      const TILE_LAYERS = 800;
      const TRACKS = 20_000;
      const tiles = trackChurnFixture(TILE_LAYERS, TRACKS);
      const m = new TrackIndexMaintainer();
      const t0 = performance.now();
      const r = m.sync(tiles, CFG);
      const syncMs = performance.now() - t0;
      expect(r.tracks.size).toBe(TRACKS);

      const keys = tiles.map((t) => tileLayerKey(t.id, t.layers[0].name));
      const rank = new Map<string, number>();
      keys.forEach((k, i) => rank.set(k, i));
      const groups = perTrackGroups(keys, TRACKS);

      let t1 = performance.now();
      let produced = 0;
      for (const g of groups) produced += orderGroups(g, rank).length;
      const rankMs = performance.now() - t1;

      t1 = performance.now();
      let scanned = 0;
      for (const g of groups) scanned += residentKeyScan(g, keys).length;
      const scanMs = performance.now() - t1;

      expect(produced).toBe(scanned);
      console.log(
        `H1 cold sync ${syncMs.toFixed(1)} ms; ordering ${TRACKS} dirty tracks over ${TILE_LAYERS} tile-layers: ` +
          `rank-sort ${rankMs.toFixed(1)} ms vs resident-key scan ${scanMs.toFixed(1)} ms (${(scanMs / rankMs).toFixed(1)}×)`,
      );
      expect(scanMs).toBeGreaterThanOrEqual(5 * rankMs);
    },
  );
});

// ─── H2: directory varint decode ────────────────────────────────────────────

/** Tag of the optional trailing covering section (mirrors directory.ts). */
const COVER_SECTION_TMIN = 1;

// ── BEGIN ORACLE: the pre-change BigInt decoder, verbatim from directory.ts ──
function safeBigInt(value: bigint, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(
      `STT directory: ${field} ${value} is outside JavaScript's safe integer range`,
    );
  }
  return number;
}

class OracleCursor {
  pos = 0;
  constructor(public readonly bytes: Uint8Array) {}

  uvarint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.bytes.length) {
        throw new Error('STT directory: truncated varint');
      }
      const byte = this.bytes[this.pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
      if (shift >= 64n) {
        throw new Error('STT directory: varint exceeds 64 bits');
      }
    }
    return result;
  }

  /** Signed (zig-zag) varint. */
  ivarint(): bigint {
    const v = this.uvarint();
    return (v >> 1n) ^ -(v & 1n);
  }

  u32le(): number {
    if (this.pos + 4 > this.bytes.length) {
      throw new Error('STT directory: truncated crc');
    }
    const b = this.bytes;
    const v =
      (b[this.pos] |
        (b[this.pos + 1] << 8) |
        (b[this.pos + 2] << 16) |
        (b[this.pos + 3] << 24)) >>>
      0;
    this.pos += 4;
    return v;
  }
}

/** ORACLE — `decodeDirectory` as it was before the Number fast path. */
function decodeDirectoryBigInt(bytes: Uint8Array): DirectoryEntry[] {
  if (bytes.length === 0) {
    throw new Error('STT directory: empty buffer');
  }
  const version = bytes[0];
  if (version < MIN_DIRECTORY_VERSION || version > DIRECTORY_VERSION) {
    throw new Error(
      `STT directory: unsupported version ${version} ` +
        `(expected ${MIN_DIRECTORY_VERSION}..${DIRECTORY_VERSION})`,
    );
  }
  // The `variantId` column exists only from v6. Older buffers stop after
  // `temporalBucketMs` and mean "raw".
  const hasVariantColumn = version >= 6;
  const c = new OracleCursor(bytes);
  c.pos = 1;

  const n = safeBigInt(c.uvarint(), 'entry count');
  const runCount = safeBigInt(c.uvarint(), 'run count');
  // Every key consumes at least eight one-byte varints. Reject an impossible
  // count before allocating attacker-sized arrays.
  if (n > Math.floor((bytes.length - c.pos) / 8)) {
    throw new Error(
      `STT directory: header claims ${n} entries but only ${bytes.length - c.pos} bytes remain`,
    );
  }
  if (runCount > n || (n > 0 && runCount === 0)) {
    throw new Error(
      `STT directory: invalid run count ${runCount} for ${n} entries`,
    );
  }

  interface Key {
    zoom: number;
    x: number;
    y: number;
    timeStart: bigint;
    timeEnd: bigint;
    featureCount: number;
    temporalBucketMs?: number;
    variantId: number;
  }
  const keys: Key[] = new Array(n);

  // Delta accumulators (BigInt). `hilbert` is delta-coded too and must be
  // consumed to stay aligned even though the reader never surfaces it.
  let pz = 0n;
  let ph = 0n;
  let px = 0n;
  let py = 0n;
  let pt = 0n;
  for (let i = 0; i < n; i++) {
    pz += c.ivarint();
    ph += c.ivarint(); // hilbert delta — consumed, not stored
    px += c.ivarint();
    py += c.ivarint();
    pt += c.ivarint();
    const duration = c.ivarint();
    const featureCount = safeBigInt(c.uvarint(), `entry ${i} featureCount`);
    const bucketPresent = c.uvarint();
    let temporalBucketMs: number | undefined;
    if (bucketPresent !== 0n) {
      temporalBucketMs = safeBigInt(c.uvarint(), `entry ${i} temporalBucketMs`);
    }
    const variantId = hasVariantColumn
      ? safeBigInt(c.uvarint(), `entry ${i} variantId`)
      : 0;
    const zoom = safeBigInt(pz, `entry ${i} zoom`);
    const x = safeBigInt(px, `entry ${i} x`);
    const y = safeBigInt(py, `entry ${i} y`);
    const timeStart = safeBigInt(pt, `entry ${i} timeStart`);
    const timeEnd = safeBigInt(pt + duration, `entry ${i} timeEnd`);
    if (zoom < 0 || x < 0 || y < 0 || timeEnd < timeStart) {
      throw new Error(`STT directory: entry ${i} has invalid coordinates/time`);
    }
    keys[i] = {
      zoom,
      x,
      y,
      timeStart: pt,
      timeEnd: pt + duration,
      featureCount,
      temporalBucketMs,
      variantId,
    };
  }

  const entries: DirectoryEntry[] = new Array(n);
  let cursor = 0;
  let expectedOffset = 0n;
  let prevPackId = 0n;
  for (let r = 0; r < runCount; r++) {
    const runLen = safeBigInt(c.uvarint(), `run ${r} length`);
    // Δpack_id (zig-zag) precedes the offset sentinel. Reset the offset
    // contiguity expectation when the pack changes, so the first run of each
    // pack hits the cheap `0` sentinel (offsets are pack-relative).
    const packId = prevPackId + c.ivarint();
    if (packId !== prevPackId) {
      expectedOffset = 0n;
    }
    prevPackId = packId;
    const offFlag = c.uvarint();
    const offset = offFlag === 0n ? expectedOffset : c.uvarint();
    const length = safeBigInt(c.uvarint(), `run ${r} length bytes`);
    const uncompressedSize = safeBigInt(
      c.uvarint(),
      `run ${r} uncompressedSize`,
    );
    const crc32c = c.u32le();

    if (cursor + runLen > n) {
      throw new Error('STT directory: run length exceeds entry count');
    }
    const packIdNum = safeBigInt(packId, `run ${r} packId`);
    const offsetNum = safeBigInt(offset, `run ${r} offset`);
    if (packIdNum < 0 || length < 0 || uncompressedSize < 0 || offsetNum < 0) {
      throw new Error(`STT directory: run ${r} has invalid blob fields`);
    }
    for (let k = 0; k < runLen; k++) {
      const key = keys[cursor];
      entries[cursor] = {
        zoom: key.zoom,
        x: key.x,
        y: key.y,
        timeStart: safeBigInt(key.timeStart, `entry ${cursor} timeStart`),
        timeEnd: safeBigInt(key.timeEnd, `entry ${cursor} timeEnd`),
        variantId: key.variantId,
        packId: packIdNum,
        offset: offsetNum,
        length,
        uncompressedSize,
        featureCount: key.featureCount,
        crc32c,
        temporalBucketMs: key.temporalBucketMs,
      };
      cursor++;
    }
    expectedOffset = offset + BigInt(length);
    safeBigInt(expectedOffset, `run ${r} ending offset`);
  }

  if (cursor !== n) {
    throw new Error(
      `STT directory: runs covered ${cursor} entries, expected ${n}`,
    );
  }

  // Optional trailing covering section(s). A pre-covering archive's buffer ends
  // here; if bytes remain, read tagged sections (unknown tags stop the scan).
  let parsedKnownTrailingSection = false;
  if (c.pos < bytes.length) {
    const tag = bytes[c.pos++];
    if (tag === COVER_SECTION_TMIN) {
      parsedKnownTrailingSection = true;
      for (let i = 0; i < n; i++) {
        const delta = safeBigInt(c.ivarint(), `entry ${i} coverTMin delta`);
        const coverTMin = entries[i].timeStart + delta;
        if (!Number.isSafeInteger(coverTMin)) {
          throw new Error(
            `STT directory: entry ${i} coverTMin is outside JavaScript's safe integer range`,
          );
        }
        entries[i].coverTMin = coverTMin;
      }
    }
  }
  if (parsedKnownTrailingSection && c.pos !== bytes.length) {
    throw new Error(
      `STT directory: ${bytes.length - c.pos} trailing bytes after known sections`,
    );
  }
  return entries;
}
// ── END ORACLE ───────────────────────────────────────────────────────────────

/** Unsigned LEB128 bytes of `v` (any width the wire format allows, and beyond). */
function leb(v: bigint): number[] {
  const out: number[] = [];
  let x = v;
  for (;;) {
    const byte = Number(x & 0x7fn);
    x >>= 7n;
    if (x !== 0n) out.push(byte | 0x80);
    else {
      out.push(byte);
      break;
    }
  }
  return out;
}

const SLOTS = [
  'zoom',
  'hilbert',
  'x',
  'y',
  'timeStart',
  'duration',
  'featureCount',
  'variantId',
  'packId',
  'offset',
  'length',
  'uncompressedSize',
  'cover',
] as const;
type Slot = (typeof SLOTS)[number];

/**
 * A one-entry, one-run directory whose every varint is `0` except `slot`,
 * which carries the RAW wire value `raw` (so a signed slot decodes to
 * unzigzag(raw)). Lets one wire value be pushed through each decode path.
 */
function oneSlotDirectory(slot: Slot, raw: bigint): Uint8Array {
  const b: number[] = [DIRECTORY_VERSION, 1, 1];
  const put = (s: Slot | 'bucketPresent'): void => {
    for (const byte of leb(s === slot ? raw : 0n)) b.push(byte);
  };
  put('zoom');
  put('hilbert');
  put('x');
  put('y');
  put('timeStart');
  put('duration');
  put('featureCount');
  put('bucketPresent');
  put('variantId');
  b.push(1); // run length
  put('packId');
  if (slot === 'offset') {
    b.push(1);
    put('offset');
  } else {
    b.push(0);
  }
  put('length');
  put('uncompressedSize');
  b.push(0, 0, 0, 0); // crc32c
  if (slot === 'cover') {
    b.push(COVER_SECTION_TMIN);
    put('cover');
  }
  return Uint8Array.from(b);
}

/** Deterministic PRNG so a fuzz failure reproduces. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Wire values: every byte-length boundary, the 2^53 edge, u64 limits, and random values per bit-length. */
function fuzzValues(): bigint[] {
  const vals: bigint[] = [];
  for (const e of [7, 14, 21, 28, 32, 35, 42, 49, 52, 53, 54, 56, 63, 64]) {
    vals.push((1n << BigInt(e)) - 1n, 1n << BigInt(e), (1n << BigInt(e)) + 1n);
  }
  vals.push(0n, 1n, 2n, 3n, (1n << 70n) - 1n);
  const rnd = mulberry32(0x5717);
  for (let bits = 1; bits <= 64; bits++) {
    for (let k = 0; k < 13; k++) {
      let v = 0n;
      for (let i = 0; i < bits; i += 16) {
        v = (v << 16n) | BigInt(Math.floor(rnd() * 65536));
      }
      vals.push(v & ((1n << BigInt(bits)) - 1n));
    }
  }
  return vals;
}

function outcome(fn: () => DirectoryEntry[]): string {
  try {
    return JSON.stringify(fn());
  } catch (e) {
    return `throw: ${(e as Error).message}`;
  }
}

const PAGED_DIR = fileURLToPath(
  new URL('./fixtures/paged-golden', import.meta.url),
);
const SINGLE_DIR = fileURLToPath(
  new URL('./fixtures/paged-golden-single', import.meta.url),
);

/**
 * Every raw (unframed) directory codec payload in a packed dataset: the leaves
 * of a paged `.sttd` located through its root, or the one whole-load payload.
 */
function directoryPayloads(ds: InMemoryPackedDataset): Uint8Array[] {
  const manifest = JSON.parse(
    new TextDecoder().decode(ds.objects.get('manifest.json')!),
  );
  const d = manifest.directory;
  const obj = ds.objects.get(d.key)!.subarray(OBJECT_MAGIC_LEN);
  const unframe = (b: Uint8Array): Uint8Array =>
    d.encoding === 'zstd' ? unzstdSync(b) : b;
  if (typeof d.pageCount !== 'number') return [unframe(obj)];
  const root = decodePagedRoot(unframe(obj.subarray(0, d.rootLength)));
  return root.pages.map((p) =>
    unframe(
      obj.subarray(
        d.rootLength + p.relOffset,
        d.rootLength + p.relOffset + p.length,
      ),
    ),
  );
}

/** A realistic 4,096-entry leaf: z12 grid, hourly buckets, contiguous ~4–13 KB blobs, pack rollover every 1,024. */
function syntheticLeaf(n: number): Uint8Array {
  const HOUR = 3_600_000;
  const T0 = 1_700_000_000_000;
  const entries: DirectoryEncodeEntry[] = [];
  let off = 0;
  for (let i = 0; i < n; i++) {
    const len = 4000 + ((i * 7919) % 9000);
    const ts = T0 + (i % 24) * HOUR;
    entries.push({
      zoom: 12,
      x: 2000 + (i % 64),
      y: 1300 + ((i >> 6) % 64),
      hilbert: i * 3,
      timeStart: ts,
      timeEnd: ts + HOUR,
      packId: i >> 10,
      offset: off,
      length: len,
      uncompressedSize: len * 3,
      featureCount: 100 + (i % 900),
      crc32c: Math.imul(i, 2654435761) >>> 0,
      temporalBucketMs: HOUR,
      coverTMin: ts + 1234,
    });
    off = (i & 1023) === 1023 ? 0 : off + len;
  }
  return encodeDirectory(entries);
}

describe('H2: decodeDirectory Number fast path vs the BigInt oracle', () => {
  it('decodes every paged-golden leaf and the whole-load single directory byte-identically to the oracle', () => {
    const paged = loadPackedDatasetFromDisk(
      nodeFs,
      PAGED_DIR,
      'mem://data/paged/manifest.json',
    );
    const single = loadPackedDatasetFromDisk(
      nodeFs,
      SINGLE_DIR,
      'mem://data/single/manifest.json',
    );
    const leaves = directoryPayloads(paged);
    expect(leaves.length).toBe(32);
    let total = 0;
    for (const leaf of leaves) {
      const got = decodeDirectory(leaf);
      expect(got).toEqual(decodeDirectoryBigInt(leaf));
      total += got.length;
    }
    expect(total).toBe(252);
    const [whole] = directoryPayloads(single);
    const got = decodeDirectory(whole);
    expect(got.length).toBe(252);
    expect(got).toEqual(decodeDirectoryBigInt(whole));
  });

  it('agrees with the oracle on ~11k fuzzed wire values in every varint slot (accept AND reject paths)', () => {
    const values = fuzzValues();
    let cases = 0;
    let accepted = 0;
    let acceptedAbove53 = 0;
    for (const slot of SLOTS) {
      for (const raw of values) {
        const bytes = oneSlotDirectory(slot, raw);
        const want = outcome(() => decodeDirectoryBigInt(bytes));
        const got = outcome(() => decodeDirectory(bytes));
        if (got !== want) {
          throw new Error(
            `slot=${slot} raw=${raw}: production ${got} ≠ oracle ${want}`,
          );
        }
        cases++;
        if (!want.startsWith('throw')) {
          accepted++;
          if (raw >= 1n << 53n) acceptedAbove53++;
        }
      }
    }
    expect(cases).toBeGreaterThanOrEqual(10_000);
    expect(accepted).toBeGreaterThan(0);
    expect(cases - accepted).toBeGreaterThan(0);
    // The exact fallback is exercised on values the fast path cannot hold:
    // a zig-zag delta in [2^53, 2^54) whose signed value is still safe, and
    // the never-surfaced Hilbert column at any width.
    expect(acceptedAbove53).toBeGreaterThan(0);
  });

  it.skipIf(!TIMING)(
    'decodes a 4,096-entry leaf ≥ 2× faster than the BigInt oracle',
    () => {
      const leaf = syntheticLeaf(4096);
      expect(decodeDirectory(leaf)).toEqual(decodeDirectoryBigInt(leaf));
      const ITER = 40;
      const time = (fn: (b: Uint8Array) => DirectoryEntry[]): number => {
        for (let i = 0; i < 5; i++) fn(leaf); // warm-up
        const t0 = performance.now();
        for (let i = 0; i < ITER; i++) fn(leaf);
        return (performance.now() - t0) / ITER;
      };
      const oracleMs = time(decodeDirectoryBigInt);
      const prodMs = time(decodeDirectory);
      console.log(
        `H2 4,096-entry leaf: oracle ${oracleMs.toFixed(2)} ms (${((oracleMs * 1e6) / 4096).toFixed(0)} ns/entry) ` +
          `vs production ${prodMs.toFixed(2)} ms (${((prodMs * 1e6) / 4096).toFixed(0)} ns/entry), ${(oracleMs / prodMs).toFixed(1)}×`,
      );
      expect(prodMs).toBeLessThanOrEqual(oracleMs / 2);
    },
  );
});

// ─── H3: OPFS eviction low-water mark ───────────────────────────────────────

describe('H3: OpfsTileCache steady-state set() cost', () => {
  afterEach(() => {
    uninstallShim();
  });

  it.skipIf(!TIMING)(
    '200 sets over a full 8k-entry cache are ≥ 5× cheaper with the low-water mark than evicting to exactly the budget',
    async () => {
      installShim();
      const N = 8_000;
      const SIZE = 512;
      const fill = async (cache: OpfsTileCache): Promise<void> => {
        for (let i = 0; i < N; i++) {
          await cache.set(`k${i}`, new Uint8Array(SIZE));
        }
      };
      const steady = async (cache: OpfsTileCache): Promise<number> => {
        const t0 = performance.now();
        for (let i = 0; i < 200; i++) {
          await cache.set(`s${i}`, new Uint8Array(SIZE));
        }
        return performance.now() - t0;
      };
      const exact = new OpfsTileCache({
        directory: 'exact',
        maxBytes: N * SIZE,
        evictLowWater: 1, // the documented rollback: evict to the budget itself
      });
      const lowWater = new OpfsTileCache({
        directory: 'low',
        maxBytes: N * SIZE,
      });
      await fill(exact);
      await fill(lowWater);
      const exactMs = await steady(exact);
      const lowMs = await steady(lowWater);
      console.log(
        `H3 200 steady-state sets over ${N} entries: exact-budget ${exactMs.toFixed(1)} ms ` +
          `(${(exactMs / 200).toFixed(2)} ms/set) vs low-water ${lowMs.toFixed(1)} ms (${(lowMs / 200).toFixed(2)} ms/set), ${(exactMs / lowMs).toFixed(1)}×`,
      );
      expect(exact.getBytes()).toBeLessThanOrEqual(N * SIZE);
      expect(lowWater.getBytes()).toBeLessThanOrEqual(N * SIZE);
      expect(exactMs).toBeGreaterThanOrEqual(5 * lowMs);
    },
  );
});

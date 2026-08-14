/**
 * Test helpers for the STT **packed format**.
 *
 * `packedFromGolden` re-cuts the committed `fixtures/packed-golden/` dataset
 * (written by the Rust `make-golden-fixture` example, so it is real writer
 * output) into an in-memory object map, with control over pack size and the
 * directory key so tests can exercise coalescing, dedup and redeploy paths.
 * `packedFetch` serves such a dataset (whole GET → 200, Range → 206).
 *
 * Objects carry their `STTP`/`STTD` magic prelude and record OBJECT-ABSOLUTE
 * blob offsets, matching the writer (packed spec §9.2).
 */

import { readFileSync } from 'node:fs';
import { unzstdSync } from '../../src/compression';
import { blake3Hex128 } from '../../src/blake3';
import { fileURLToPath } from 'node:url';

import {
  decodeDirectory,
  decodePagedRoot,
  encodeDirectory,
  type DirectoryEncodeEntry,
} from '../../src/directory';

function bufferToArrayBuffer(buf: Uint8Array): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** A minimal in-memory packed dataset: the three object kinds, keyed by path. */

/** Byte length of an object magic prelude (tag + version + 3 reserved zeros). */
export const OBJECT_MAGIC_LEN = 8;
const PACK_MAGIC = 'STTP';
const DIRECTORY_MAGIC = 'STTD';

/** `"STTP"`/`"STTD"` + u8 version(3) + 3 zero bytes (packed spec §9.2). */
function objectMagic(tag: string): Uint8Array {
  const out = new Uint8Array(OBJECT_MAGIC_LEN);
  out.set(new TextEncoder().encode(tag), 0);
  out[4] = 3;
  return out;
}

export interface InMemoryPackedDataset {
  /** Path → bytes for every object (`manifest.json`, `index/...`, `packs/...`). */
  objects: Map<string, Uint8Array>;
  /** The manifest URL a reader should be pointed at. */
  manifestUrl: string;
}

/** Production-shaped content-addressed test object keys. */
export function directoryKey(bytes: Uint8Array): string {
  return `index/${blake3Hex128(bytes)}.sttd`;
}

export function packKey(bytes: Uint8Array): string {
  return `packs/${blake3Hex128(bytes)}.sttp`;
}

function addPagedFrameHashes(
  manifest: any,
  directoryBytes: Uint8Array,
): boolean {
  if (
    manifest.directory?.layout !== 'paged' ||
    manifest.directory.rootHash !== undefined ||
    typeof manifest.directory.rootLength !== 'number'
  ) {
    return false;
  }
  const rootLength = manifest.directory.rootLength;
  const payload = directoryBytes.subarray(OBJECT_MAGIC_LEN);
  const rootFrame = payload.subarray(0, rootLength);
  const rootRaw =
    manifest.directory.encoding === 'zstd' ? unzstdSync(rootFrame) : rootFrame;
  const root = decodePagedRoot(rootRaw);
  manifest.directory.rootHash = blake3Hex128(rootFrame);
  manifest.directory.pageHashes = root.pages.map((page) =>
    blake3Hex128(
      payload.subarray(
        rootLength + page.relOffset,
        rootLength + page.relOffset + page.length,
      ),
    ),
  );
  return true;
}

/**
 * Parse a single-file v4 `.stt` buffer's directory + blob region (just enough
 * to repack). Mirrors the (now-removed) v4 header + v4 directory codec.
 */
function parseV4(bytes: Uint8Array): {
  compressionByte: number;
  metadataJson: any;
  entries: Array<{
    zoom: number;
    x: number;
    y: number;
    timeStart: number;
    timeEnd: number;
    offset: number;
    length: number;
    uncompressedSize: number;
    featureCount: number;
    hilbert: number;
    crc32c: number;
    temporalBucketMs?: number;
    coverTMin?: number;
  }>;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const compressionByte = view.getUint8(5);
  const indexOffset = Number(view.getBigUint64(6, true));
  const indexLength = Number(view.getBigUint64(14, true));
  const metadataOffset = Number(view.getBigUint64(22, true));
  const metadataLength = Number(view.getBigUint64(30, true));

  const metadataJson = JSON.parse(
    new TextDecoder().decode(
      bytes.subarray(metadataOffset, metadataOffset + metadataLength),
    ),
  );

  // Decode the v4 directory inline (the production decoder is v4/v5-capable, but
  // it doesn't surface hilbert/crc which we need to faithfully repack a run).
  const dir = bytes.subarray(indexOffset, indexOffset + indexLength);
  let pos = 0;
  const uvarint = (): bigint => {
    let r = 0n;
    let s = 0n;
    for (;;) {
      const b = dir[pos++];
      r |= BigInt(b & 0x7f) << s;
      if ((b & 0x80) === 0) break;
      s += 7n;
    }
    return r;
  };
  const ivarint = (): bigint => {
    const v = uvarint();
    return (v >> 1n) ^ -(v & 1n);
  };
  const u32le = (): number => {
    const v =
      (dir[pos] |
        (dir[pos + 1] << 8) |
        (dir[pos + 2] << 16) |
        (dir[pos + 3] << 24)) >>>
      0;
    pos += 4;
    return v;
  };

  const version = dir[pos++];
  if (version !== 4)
    throw new Error(
      `packed-fixture: expected v4 source directory, got ${version}`,
    );
  const n = Number(uvarint());
  const runCount = Number(uvarint());
  interface Key {
    zoom: number;
    hilbert: number;
    x: number;
    y: number;
    timeStart: number;
    timeEnd: number;
    featureCount: number;
    temporalBucketMs?: number;
  }
  const keys: Key[] = new Array(n);
  let pz = 0n,
    ph = 0n,
    px = 0n,
    py = 0n,
    pt = 0n;
  for (let i = 0; i < n; i++) {
    pz += ivarint();
    ph += ivarint();
    px += ivarint();
    py += ivarint();
    pt += ivarint();
    const dur = ivarint();
    const fc = Number(uvarint());
    const bp = uvarint();
    let tb: number | undefined;
    if (bp !== 0n) tb = Number(uvarint());
    keys[i] = {
      zoom: Number(pz),
      hilbert: Number(ph),
      x: Number(px),
      y: Number(py),
      timeStart: Number(pt),
      timeEnd: Number(pt + dur),
      featureCount: fc,
      temporalBucketMs: tb,
    };
  }
  const entries: ReturnType<typeof parseV4>['entries'] = new Array(n);
  let cursor = 0;
  let expected = 0n;
  for (let r = 0; r < runCount; r++) {
    const runLen = Number(uvarint());
    const offFlag = uvarint();
    const offset = offFlag === 0n ? expected : uvarint();
    const length = Number(uvarint());
    const unc = Number(uvarint());
    const crc = u32le();
    for (let k = 0; k < runLen; k++) {
      const key = keys[cursor];
      entries[cursor] = {
        zoom: key.zoom,
        x: key.x,
        y: key.y,
        timeStart: key.timeStart,
        timeEnd: key.timeEnd,
        offset: Number(offset),
        length,
        uncompressedSize: unc,
        featureCount: key.featureCount,
        hilbert: key.hilbert,
        crc32c: crc,
        temporalBucketMs: key.temporalBucketMs,
      };
      cursor++;
    }
    expected = offset + BigInt(length);
  }
  // Optional cover section.
  if (pos < dir.length) {
    const tag = dir[pos++];
    if (tag === 1) {
      for (let i = 0; i < n; i++) {
        entries[i].coverTMin = entries[i].timeStart + Number(ivarint());
      }
    }
  }

  return { compressionByte, metadataJson, entries };
}

/**
 * Transcode a single-file v4 `.stt` buffer into an in-memory packed dataset.
 *
 * The compressed blobs are copied verbatim (they're per-blob zstd already, no
 * shared dict in the eager fixture build) into pack objects. `packTargetBytes`
 * caps each pack so the test corpus can be spread across multiple packs to
 * exercise per-pack coalescing; a single blob bigger than the cap still gets
 * its own pack (never split).
 */
export function packedFromSingleFile(
  v4: Uint8Array,
  opts: {
    manifestUrl?: string;
    packTargetBytes?: number;
    directoryKey?: string;
  } = {},
): InMemoryPackedDataset {
  const manifestUrl = opts.manifestUrl ?? 'mem://data/sample/manifest.json';
  const packTargetBytes = opts.packTargetBytes ?? Number.MAX_SAFE_INTEGER;
  const { compressionByte, metadataJson, entries } = parseV4(v4);

  // Dedup blobs by their (offset,length) in the source file → one physical
  // blob each, preserving the fixture's own dedup.
  const blobKey = (e: { offset: number; length: number }) =>
    `${e.offset}:${e.length}`;
  const blobOrder: string[] = [];
  const blobBytes = new Map<string, Uint8Array>();
  for (const e of entries) {
    const k = blobKey(e);
    if (!blobBytes.has(k)) {
      blobOrder.push(k);
      blobBytes.set(k, v4.subarray(e.offset, e.offset + e.length));
    }
  }

  // Cut blobs into packs of ≤ packTargetBytes (never split a blob).
  // Offsets are OBJECT-ABSOLUTE (packed spec §9.2), so the first blob in a
  // pack starts after that object's 8-byte `STTP` magic prelude.
  const placement = new Map<string, { packId: number; offset: number }>();
  const packBlobKeys: string[][] = [];
  let curPack: string[] = [];
  let curOffset = OBJECT_MAGIC_LEN;
  let packId = 0;
  for (const k of blobOrder) {
    const len = blobBytes.get(k)!.length;
    if (curPack.length > 0 && curOffset + len > packTargetBytes) {
      packBlobKeys.push(curPack);
      curPack = [];
      curOffset = OBJECT_MAGIC_LEN;
      packId++;
    }
    placement.set(k, { packId, offset: curOffset });
    curPack.push(k);
    curOffset += len;
  }
  if (curPack.length > 0) packBlobKeys.push(curPack);

  // Assemble pack object bytes.
  const objects = new Map<string, Uint8Array>();
  const packRefs: Array<{ key: string; length: number }> = [];
  for (let p = 0; p < packBlobKeys.length; p++) {
    let total = OBJECT_MAGIC_LEN;
    for (const k of packBlobKeys[p]) total += blobBytes.get(k)!.length;
    const buf = new Uint8Array(total);
    buf.set(objectMagic(PACK_MAGIC), 0);
    let o = OBJECT_MAGIC_LEN;
    for (const k of packBlobKeys[p]) {
      const b = blobBytes.get(k)!;
      buf.set(b, o);
      o += b.length;
    }
    const key = packKey(buf);
    objects.set(key, buf);
    packRefs.push({ key, length: buf.length });
  }

  // Encode the v6 directory with pack ids + pack-relative offsets.
  const encEntries: DirectoryEncodeEntry[] = entries.map((e) => {
    const pl = placement.get(blobKey(e))!;
    return {
      zoom: e.zoom,
      x: e.x,
      y: e.y,
      timeStart: e.timeStart,
      timeEnd: e.timeEnd,
      packId: pl.packId,
      offset: pl.offset,
      length: e.length,
      uncompressedSize: e.uncompressedSize,
      featureCount: e.featureCount,
      hilbert: e.hilbert,
      crc32c: e.crc32c,
      temporalBucketMs: e.temporalBucketMs,
      coverTMin: e.coverTMin,
    };
  });
  const dirCodecBytes = encodeDirectory(encEntries);
  const dirBytes = new Uint8Array(OBJECT_MAGIC_LEN + dirCodecBytes.length);
  dirBytes.set(objectMagic(DIRECTORY_MAGIC), 0);
  dirBytes.set(dirCodecBytes, OBJECT_MAGIC_LEN);
  // The directory key is content-addressed in production; tests can override it
  // to simulate a redeploy whose tiles changed (→ a new directory hash → a
  // distinct OPFS namespace).
  const dirKey = opts.directoryKey ?? directoryKey(dirBytes);
  objects.set(dirKey, dirBytes);

  const compression =
    compressionByte === 0 ? 'none' : compressionByte === 1 ? 'gzip' : 'zstd';
  const manifest = {
    format: 'stt-packed',
    formatVersion: 3,
    variants: [{ id: 0, kind: 'raw' }],
    compression,
    directory: { key: dirKey, length: dirBytes.length, directoryVersion: 6 },
    packs: packRefs,
    metadata: metadataJson,
  };
  objects.set(
    'manifest.json',
    new TextEncoder().encode(JSON.stringify(manifest)),
  );

  return { objects, manifestUrl };
}

/**
 * Load a real on-disk packed dataset (a directory containing `manifest.json`,
 * `index/*.sttd`, `packs/*.sttp`) into an in-memory dataset servable by
 * {@link packedFetch}. Used by the paged-directory cross-impl tests, which read
 * Rust-produced fixtures (`paged-golden/`, `paged-golden-single/`).
 */
export function loadPackedDatasetFromDisk(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fs: { readFileSync: (p: string) => any },
  dir: string,
  manifestUrl = 'mem://data/fixture/manifest.json',
): InMemoryPackedDataset {
  const objects = new Map<string, Uint8Array>();
  const manifestBytes = new Uint8Array(fs.readFileSync(`${dir}/manifest.json`));
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  const directoryBytes = new Uint8Array(
    fs.readFileSync(`${dir}/${manifest.directory.key}`),
  );
  manifest.directory.key = directoryKey(directoryBytes);
  objects.set(manifest.directory.key, directoryBytes);
  addPagedFrameHashes(manifest, directoryBytes);
  for (const p of manifest.packs) {
    const bytes = new Uint8Array(fs.readFileSync(`${dir}/${p.key}`));
    p.key = packKey(bytes);
    objects.set(p.key, bytes);
  }
  objects.set(
    'manifest.json',
    new TextEncoder().encode(JSON.stringify(manifest)),
  );
  return { objects, manifestUrl };
}

/** Records what a packed-fetch shim served (for coalescing assertions). */
export interface PackedFetchLog {
  /** Every requested object path (relative to the dataset root). */
  paths: string[];
  /** Range requests only, as `{ path, range }`. */
  ranges: Array<{ path: string; range: string }>;
}

/**
 * Upgrade hand-built synthetic datasets to the production content-addressed
 * key grammar before the strict reader sees them. This is test infrastructure,
 * not a reader escape hatch.
 */
function normalizeContentAddressedKeys(ds: InMemoryPackedDataset): void {
  const manifestBytes = ds.objects.get('manifest.json');
  if (!manifestBytes) return;
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  let changed = false;
  const oldDirectoryKey = manifest.directory?.key;
  const directoryBytes = ds.objects.get(oldDirectoryKey);
  if (directoryBytes && !/^index\/[0-9a-f]{32}\.sttd$/.test(oldDirectoryKey)) {
    const key = directoryKey(directoryBytes);
    ds.objects.set(key, directoryBytes);
    ds.objects.delete(oldDirectoryKey);
    manifest.directory.key = key;
    changed = true;
  }
  if (directoryBytes && addPagedFrameHashes(manifest, directoryBytes)) {
    changed = true;
  }
  for (const pack of manifest.packs ?? []) {
    const oldKey = pack.key;
    const bytes = ds.objects.get(oldKey);
    if (bytes && !/^packs\/[0-9a-f]{32}\.sttp$/.test(oldKey)) {
      const key = packKey(bytes);
      ds.objects.set(key, bytes);
      ds.objects.delete(oldKey);
      pack.key = key;
      changed = true;
    }
  }
  if (changed) {
    ds.objects.set(
      'manifest.json',
      new TextEncoder().encode(JSON.stringify(manifest)),
    );
  }
}

/**
 * A `fetch` shim that serves an in-memory packed dataset. The base is the
 * manifest URL minus its final path segment; a requested URL's tail after that
 * base is the object key. Whole GET → 200, Range → 206 via Uint8Array slicing.
 */
export function packedFetch(
  ds: InMemoryPackedDataset,
  log?: PackedFetchLog,
): typeof fetch {
  normalizeContentAddressedKeys(ds);
  const slash = ds.manifestUrl.lastIndexOf('/');
  const base = slash >= 0 ? ds.manifestUrl.slice(0, slash + 1) : '';
  return (async (url: string, init?: RequestInit) => {
    const key = url.startsWith(base) ? url.slice(base.length) : url;
    log?.paths.push(key);
    const bytes = ds.objects.get(key);
    if (!bytes) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    const m = /bytes=(\d+)-(\d+)/.exec(range ?? '');
    if (!m) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => bufferToArrayBuffer(bytes),
      };
    }
    log?.ranges.push({ path: key, range: range! });
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), bytes.length - 1);
    const slice = bytes.subarray(start, end + 1);
    // Carry a real Content-Range so the reader's 206 validation is exercised
    // (it tolerates header-less shims, but this shim should act like a server).
    const contentRange = `bytes ${start}-${end}/${bytes.length}`;
    return {
      ok: true,
      status: 206,
      statusText: 'Partial Content',
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-range' ? contentRange : null,
      },
      arrayBuffer: async () => bufferToArrayBuffer(slice),
    };
  }) as unknown as typeof fetch;
}

/**
 * Assemble a pack object from its blobs: the 8-byte `STTP` prelude followed by
 * the blobs back to back. Returns the object bytes plus each blob's
 * OBJECT-ABSOLUTE offset (packed spec §9.2 — offsets include the prelude), which
 * is what a directory entry records.
 */
export function packObject(blobs: Uint8Array[]): {
  bytes: Uint8Array;
  offsets: number[];
} {
  const total = OBJECT_MAGIC_LEN + blobs.reduce((n, b) => n + b.byteLength, 0);
  const bytes = new Uint8Array(total);
  bytes.set(objectMagic(PACK_MAGIC), 0);
  const offsets: number[] = [];
  let o = OBJECT_MAGIC_LEN;
  for (const b of blobs) {
    offsets.push(o);
    bytes.set(b, o);
    o += b.byteLength;
  }
  return { bytes, offsets };
}

/** Wrap encoded directory bytes in their `STTD` object prelude. */
export function directoryObject(codecBytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(OBJECT_MAGIC_LEN + codecBytes.byteLength);
  out.set(objectMagic(DIRECTORY_MAGIC), 0);
  out.set(codecBytes, OBJECT_MAGIC_LEN);
  return out;
}

/** Decoded shape of one golden pack/directory entry, as re-cut below. */
interface GoldenSource {
  compressionByte: number;
  metadataJson: unknown;
  entries: Array<{
    zoom: number;
    x: number;
    y: number;
    timeStart: number;
    timeEnd: number;
    length: number;
    uncompressedSize: number;
    featureCount: number;
    hilbert: number;
    crc32c: number;
    temporalBucketMs?: number;
    coverTMin?: number;
    /** The blob bytes themselves, lifted out of their source pack. */
    blob: Uint8Array;
  }>;
}

/** Read the committed v2 golden dataset and lift out every blob. */
function readGolden(dir = 'packed-golden'): GoldenSource {
  const root = fileURLToPath(new URL(`../fixtures/${dir}/`, import.meta.url));
  const manifest = JSON.parse(readFileSync(`${root}manifest.json`, 'utf8'));
  const dirBytes = new Uint8Array(
    readFileSync(`${root}${manifest.directory.key}`),
  );
  // Strip the STTD prelude, then inflate: the writer ships the directory
  // zstd-compressed at rest (declared via `directory.encoding`).
  const codec = dirBytes.subarray(OBJECT_MAGIC_LEN);
  const entries = decodeDirectory(
    manifest.directory.encoding === 'zstd' ? unzstdSync(codec) : codec,
  );
  const packs: Uint8Array[] = manifest.packs.map(
    (p: { key: string }) => new Uint8Array(readFileSync(`${root}${p.key}`)),
  );
  return {
    compressionByte: manifest.compression === 'zstd' ? 2 : 0,
    metadataJson: manifest.metadata,
    entries: entries.map((e) => ({
      zoom: e.zoom,
      x: e.x,
      y: e.y,
      timeStart: e.timeStart,
      timeEnd: e.timeEnd,
      length: e.length,
      uncompressedSize: e.uncompressedSize,
      featureCount: e.featureCount,
      hilbert: e.hilbert ?? 0,
      crc32c: e.crc32c ?? 0,
      temporalBucketMs: e.temporalBucketMs,
      coverTMin: e.coverTMin,
      // Offsets are object-absolute, so they index straight into the pack.
      blob: packs[e.packId].subarray(e.offset, e.offset + e.length),
    })),
  };
}

/**
 * Build an in-memory packed dataset from the committed v2 golden fixture,
 * re-cutting its blobs into packs of at most `packTargetBytes` (never splitting
 * a blob). Identical blobs collapse to one physical copy, preserving the
 * fixture's own dedup.
 */
export function packedFromGolden(
  opts: {
    manifestUrl?: string;
    packTargetBytes?: number;
    directoryKey?: string;
    fixture?: string;
  } = {},
): InMemoryPackedDataset {
  const manifestUrl = opts.manifestUrl ?? 'mem://data/sample/manifest.json';
  const packTargetBytes = opts.packTargetBytes ?? Number.MAX_SAFE_INTEGER;
  const src = readGolden(opts.fixture);

  // Dedup identical blobs → one physical copy each.
  const keyOf = (b: Uint8Array) => b.join(',');
  const order: string[] = [];
  const bytesByKey = new Map<string, Uint8Array>();
  for (const e of src.entries) {
    const k = keyOf(e.blob);
    if (!bytesByKey.has(k)) {
      order.push(k);
      bytesByKey.set(k, e.blob);
    }
  }

  // Cut into packs; offsets are object-absolute (after the STTP prelude).
  const placement = new Map<string, { packId: number; offset: number }>();
  const packKeys: string[][] = [];
  let cur: string[] = [];
  let curOffset = OBJECT_MAGIC_LEN;
  let packId = 0;
  for (const k of order) {
    const len = bytesByKey.get(k)!.byteLength;
    if (cur.length > 0 && curOffset + len > packTargetBytes) {
      packKeys.push(cur);
      cur = [];
      curOffset = OBJECT_MAGIC_LEN;
      packId++;
    }
    placement.set(k, { packId, offset: curOffset });
    cur.push(k);
    curOffset += len;
  }
  if (cur.length > 0) packKeys.push(cur);

  const objects = new Map<string, Uint8Array>();
  const packRefs: Array<{ key: string; length: number }> = [];
  for (let p = 0; p < packKeys.length; p++) {
    const { bytes } = packObject(packKeys[p].map((k) => bytesByKey.get(k)!));
    const key = packKey(bytes);
    objects.set(key, bytes);
    packRefs.push({ key, length: bytes.byteLength });
  }

  const encEntries: DirectoryEncodeEntry[] = src.entries.map((e) => {
    const pl = placement.get(keyOf(e.blob))!;
    return {
      zoom: e.zoom,
      x: e.x,
      y: e.y,
      timeStart: e.timeStart,
      timeEnd: e.timeEnd,
      packId: pl.packId,
      offset: pl.offset,
      length: e.length,
      uncompressedSize: e.uncompressedSize,
      featureCount: e.featureCount,
      hilbert: e.hilbert,
      crc32c: e.crc32c,
      temporalBucketMs: e.temporalBucketMs,
      coverTMin: e.coverTMin,
    };
  });
  const dirObject = directoryObject(encodeDirectory(encEntries));
  const dirKey = opts.directoryKey ?? directoryKey(dirObject);
  objects.set(dirKey, dirObject);

  objects.set(
    'manifest.json',
    new TextEncoder().encode(
      JSON.stringify({
        format: 'stt-packed',
        formatVersion: 3,
        variants: [{ id: 0, kind: 'raw' }],
        compression: src.compressionByte === 0 ? 'none' : 'zstd',
        directory: {
          key: dirKey,
          length: dirObject.byteLength,
          directoryVersion: 6,
        },
        packs: packRefs,
        metadata: src.metadataJson,
      }),
    ),
  );
  return { objects, manifestUrl };
}

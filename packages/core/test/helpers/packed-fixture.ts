/**
 * Test helpers for the STT **packed format**.
 *
 * The committed `fixtures/sample.stt` is a single-file v4 archive (the old
 * canonical format). The reader now consumes the packed format (manifest +
 * `index/<hash>.sttd` + `packs/<hash>.sttp`). These helpers transcode a v4
 * single-file buffer into an in-memory packed dataset so the existing
 * cross-impl tests can keep exercising the real fixture's tiles through the
 * new reader, and expose a `fetch` shim that serves a packed dataset (whole
 * GET → 200, Range → 206) from in-memory objects.
 */

import { encodeDirectory, type DirectoryEncodeEntry } from '../../src/directory';

function bufferToArrayBuffer(buf: Uint8Array): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** A minimal in-memory packed dataset: the three object kinds, keyed by path. */
export interface InMemoryPackedDataset {
  /** Path → bytes for every object (`manifest.json`, `index/...`, `packs/...`). */
  objects: Map<string, Uint8Array>;
  /** The manifest URL a reader should be pointed at. */
  manifestUrl: string;
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
    new TextDecoder().decode(bytes.subarray(metadataOffset, metadataOffset + metadataLength)),
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
      (dir[pos] | (dir[pos + 1] << 8) | (dir[pos + 2] << 16) | (dir[pos + 3] << 24)) >>> 0;
    pos += 4;
    return v;
  };

  const version = dir[pos++];
  if (version !== 4) throw new Error(`packed-fixture: expected v4 source directory, got ${version}`);
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
  opts: { manifestUrl?: string; packTargetBytes?: number; directoryKey?: string } = {},
): InMemoryPackedDataset {
  const manifestUrl = opts.manifestUrl ?? 'mem://data/sample/manifest.json';
  const packTargetBytes = opts.packTargetBytes ?? Number.MAX_SAFE_INTEGER;
  const { compressionByte, metadataJson, entries } = parseV4(v4);

  // Dedup blobs by their (offset,length) in the source file → one physical
  // blob each, preserving the fixture's own dedup.
  const blobKey = (e: { offset: number; length: number }) => `${e.offset}:${e.length}`;
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
  const placement = new Map<string, { packId: number; offset: number }>();
  const packBlobKeys: string[][] = [];
  let curPack: string[] = [];
  let curOffset = 0;
  let packId = 0;
  for (const k of blobOrder) {
    const len = blobBytes.get(k)!.length;
    if (curPack.length > 0 && curOffset + len > packTargetBytes) {
      packBlobKeys.push(curPack);
      curPack = [];
      curOffset = 0;
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
    let total = 0;
    for (const k of packBlobKeys[p]) total += blobBytes.get(k)!.length;
    const buf = new Uint8Array(total);
    let o = 0;
    for (const k of packBlobKeys[p]) {
      const b = blobBytes.get(k)!;
      buf.set(b, o);
      o += b.length;
    }
    const key = `packs/pack-${p}.sttp`;
    objects.set(key, buf);
    packRefs.push({ key, length: buf.length });
  }

  // Encode the v5 directory with pack ids + pack-relative offsets.
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
  const dirBytes = encodeDirectory(encEntries);
  // The directory key is content-addressed in production; tests can override it
  // to simulate a redeploy whose tiles changed (→ a new directory hash → a
  // distinct OPFS namespace).
  const dirKey = opts.directoryKey ?? 'index/directory.sttd';
  objects.set(dirKey, dirBytes);

  const compression =
    compressionByte === 0 ? 'none' : compressionByte === 1 ? 'gzip' : 'zstd';
  const manifest = {
    format: 'stt-packed',
    formatVersion: 1,
    compression,
    directory: { key: dirKey, length: dirBytes.length, directoryVersion: 5 },
    packs: packRefs,
    metadata: metadataJson,
  };
  objects.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));

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
  objects.set('manifest.json', manifestBytes);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  const add = (key: string): void => {
    objects.set(key, new Uint8Array(fs.readFileSync(`${dir}/${key}`)));
  };
  add(manifest.directory.key);
  for (const p of manifest.packs) add(p.key);
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
 * A `fetch` shim that serves an in-memory packed dataset. The base is the
 * manifest URL minus its final path segment; a requested URL's tail after that
 * base is the object key. Whole GET → 200, Range → 206 via Uint8Array slicing.
 */
export function packedFetch(
  ds: InMemoryPackedDataset,
  log?: PackedFetchLog,
): typeof fetch {
  const slash = ds.manifestUrl.lastIndexOf('/');
  const base = slash >= 0 ? ds.manifestUrl.slice(0, slash + 1) : '';
  return (async (url: string, init?: RequestInit) => {
    const key = url.startsWith(base) ? url.slice(base.length) : url;
    log?.paths.push(key);
    const bytes = ds.objects.get(key);
    if (!bytes) {
      return { ok: false, status: 404, statusText: 'Not Found', arrayBuffer: async () => new ArrayBuffer(0) };
    }
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    const m = /bytes=(\d+)-(\d+)/.exec(range ?? '');
    if (!m) {
      return { ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => bufferToArrayBuffer(bytes) };
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
      headers: { get: (name: string) => (name.toLowerCase() === 'content-range' ? contentRange : null) },
      arrayBuffer: async () => bufferToArrayBuffer(slice),
    };
  }) as unknown as typeof fetch;
}

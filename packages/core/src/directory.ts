// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
//
// Decoder for the STT directory — the compact columnar run-length tile index
// for the packed format. Mirrors the Rust codec in
// `crates/stt-core/src/directory.rs`. The client is packed-only: it reads v5
// directories (per-run `pack_id` column + pack-relative offsets). The retired
// single-file v4 layout (one implicit pack, no `pack_id`) is never handed to
// the client and is no longer decoded here.
//
//   u8      version_tag = 5
//   uvarint N            entry count
//   uvarint R            run count
//   per-entry × N:  Δzoom Δhilbert Δx Δy Δtime_start (zig-zag), duration
//                   (zig-zag), feature_count (uvarint), bucket presence flag
//                   (+ value uvarint when present)
//   per-run × R:    run_length (uvarint), Δpack_id (zig-zag),
//                   offset flag (+ raw offset uvarint when non-contiguous),
//                   length, uncompressed_size, crc32c (u32 LE)
//
// Each run's blob lives in a specific pack object. `pack_id` is delta+zig-zag
// coded against the previous run; the offset contiguity expectation
// (`expectedOffset`) resets to 0 whenever the pack changes, so offsets are
// pack-relative and the first run of each pack rides the cheap `0` sentinel.
//
// Varints are LEB128; signed columns use zig-zag. Values are accumulated as
// BigInt for exactness, then narrowed to JS numbers for the fields the reader
// uses (offsets/timestamps within 2^53, as elsewhere in the reader).

/** Directory codec version the TS encoder emits (matches the Rust writer). */
export const DIRECTORY_VERSION = 5;
/**
 * Tag for the optional trailing covering section: one signed varint per entry
 * (in directory order) giving `coverTMin - timeStart`. Backward-compatible — a
 * pre-covering directory ends after the per-run blob columns and decodes with
 * `coverTMin` undefined. Mirrors `COVER_SECTION_TMIN` in directory.rs.
 */
const COVER_SECTION_TMIN = 1;

// ----------------------------------------------------------------------------
// Paged directory — root page (Wave 2). Mirrors the Rust
// `crates/stt-core/src/directory_page.rs` container: a `.sttd` is
// `[root frame][leaf 0 frame]...`, each an independent (zstd) frame. The root is
// a fixed-width table of page descriptors carrying each leaf's byte range plus
// its pruning bounds (geographic bbox, zoom range, temporal [t_min, t_max]).
// The reader decodes the root, prunes leaves by viewport/zoom/time, and fetches
// only the survivors. The leaf codec is the unchanged v5 directory below.
// ----------------------------------------------------------------------------

/** Root container version (first byte of the decoded root page). */
const PAGED_ROOT_VERSION = 1;
/** Descriptor-kind tag: geographic bbox + zoom range + temporal bounds. */
const DESCRIPTOR_GEO_BBOX = 0;
/** Fixed-width root header bytes: version, kind, reserved u16, P u32, pageEntries u32. */
const ROOT_HEADER_LEN = 12;
/** Fixed-width per-page descriptor bytes (see field order below). */
const DESCRIPTOR_LEN = 52;

/**
 * One leaf page's pruning descriptor, decoded from the root page. Byte offsets
 * are **relative to the end of the root page** (absolute = `rootLength +
 * relOffset`). The geographic bbox is stored on the wire as lon/lat × 1e7 and
 * surfaced here as float degrees (the encoder floored/ceiled the fixed point
 * outward, so this bbox conservatively *covers* every tile in the leaf — a
 * reader never prunes a leaf that holds a matching tile).
 */
export interface PageDescriptor {
  /** Leaf byte offset relative to `rootLength`. Absolute = rootLength + relOffset. */
  relOffset: number;
  /** At-rest (framed) byte length of the leaf. */
  length: number;
  /** Entries in this leaf (Σ over pages == N). */
  entryCount: number;
  minZoom: number;
  maxZoom: number;
  /** Geographic bbox in degrees (covers every tile in the leaf). */
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  /** Subtree temporal bounds: min(coverTMin ?? timeStart) .. max(timeEnd). */
  tMin: number;
  tMax: number;
}

/** The decoded root page. */
export interface PagedRoot {
  /** Nominal entries-per-page used at build (informational). */
  pageEntries: number;
  pages: PageDescriptor[];
}

/**
 * Decode the paged-directory root page from its raw (already-unframed) bytes.
 * Mirrors `directory_page::decode_root`. Throws on an unknown version /
 * descriptor kind or a truncated buffer.
 */
export function decodePagedRoot(bytes: Uint8Array): PagedRoot {
  if (bytes.length < ROOT_HEADER_LEN) {
    throw new Error('STT paged root: truncated header');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint8(0);
  if (version !== PAGED_ROOT_VERSION) {
    throw new Error(
      `STT paged root: unsupported version ${version} (expected ${PAGED_ROOT_VERSION})`,
    );
  }
  const kind = dv.getUint8(1);
  if (kind !== DESCRIPTOR_GEO_BBOX) {
    throw new Error(`STT paged root: unsupported descriptor kind ${kind}`);
  }
  const pageCount = dv.getUint32(4, true);
  const pageEntries = dv.getUint32(8, true);
  const need = ROOT_HEADER_LEN + pageCount * DESCRIPTOR_LEN;
  if (bytes.length < need) {
    throw new Error(
      `STT paged root: truncated (${bytes.length} B, need ${need} for ${pageCount} pages)`,
    );
  }
  const pages: PageDescriptor[] = new Array(pageCount);
  for (let i = 0; i < pageCount; i++) {
    let o = ROOT_HEADER_LEN + i * DESCRIPTOR_LEN;
    const relOffset = Number(dv.getBigUint64(o, true));
    o += 8;
    const length = dv.getUint32(o, true);
    o += 4;
    const entryCount = dv.getUint32(o, true);
    o += 4;
    const minZoom = dv.getUint8(o);
    o += 1;
    const maxZoom = dv.getUint8(o);
    o += 1;
    o += 2; // reserved
    const minLon = dv.getInt32(o, true) / 1e7;
    o += 4;
    const minLat = dv.getInt32(o, true) / 1e7;
    o += 4;
    const maxLon = dv.getInt32(o, true) / 1e7;
    o += 4;
    const maxLat = dv.getInt32(o, true) / 1e7;
    o += 4;
    const tMin = Number(dv.getBigInt64(o, true));
    o += 8;
    const tMax = Number(dv.getBigInt64(o, true));
    pages[i] = {
      relOffset,
      length,
      entryCount,
      minZoom,
      maxZoom,
      minLon,
      minLat,
      maxLon,
      maxLat,
      tMin,
      tMax,
    };
  }
  return { pageEntries, pages };
}

/**
 * A decoded directory entry. The Hilbert key is read (to advance the cursor)
 * but not surfaced — the reader addresses tiles by (zoom, x, y, time), not by
 * Hilbert index. `encodeDirectory` therefore defaults Hilbert to 0; the TS
 * codec is decode-for-reading / encode-for-synthetic-tests, not a faithful
 * re-encoder of a Rust archive's Hilbert column.
 */
export interface DirectoryEntry {
  zoom: number;
  x: number;
  y: number;
  timeStart: number;
  timeEnd: number;
  /**
   * Packed-format pack index (`manifest.packs[packId]`) holding this blob.
   * `offset`/`length` are pack-relative.
   */
  packId: number;
  offset: number;
  length: number;
  uncompressedSize: number;
  featureCount: number;
  /**
   * CRC-32C (Castagnoli) of the blob's compressed bytes, as written by the
   * Rust encoder (`crc32c_tag(&compressed)`). Verified by the decode path
   * before decompression. `0`
   * means "no checksum recorded" — the `encodeDirectory` default for
   * synthetic test archives (a real CRC of 0 is a 2⁻³² coincidence, and the
   * consequence is merely a skipped verification, never a false failure).
   */
  crc32c: number;
  temporalBucketMs?: number;
  /**
   * Tight lower covering bound — the earliest feature *start* time actually in
   * the tile (vs `timeStart`, the addressable bucket edge). `undefined` when the
   * archive carries no covering section; clients then fall back to `timeStart`.
   */
  coverTMin?: number;
}

class Cursor {
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

/** Decode a v5 (packed) directory buffer into tile entries (in directory order). */
export function decodeDirectory(bytes: Uint8Array): DirectoryEntry[] {
  if (bytes.length === 0) {
    throw new Error('STT directory: empty buffer');
  }
  const version = bytes[0];
  if (version !== DIRECTORY_VERSION) {
    throw new Error(
      `STT directory: unsupported version ${version} (expected ${DIRECTORY_VERSION}; ` +
        `retired single-file v4 directories are no longer read — the client is packed-only)`,
    );
  }
  const c = new Cursor(bytes);
  c.pos = 1;

  const n = Number(c.uvarint());
  const runCount = Number(c.uvarint());

  interface Key {
    zoom: number;
    x: number;
    y: number;
    timeStart: bigint;
    timeEnd: bigint;
    featureCount: number;
    temporalBucketMs?: number;
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
    const featureCount = Number(c.uvarint());
    const bucketPresent = c.uvarint();
    let temporalBucketMs: number | undefined;
    if (bucketPresent !== 0n) {
      temporalBucketMs = Number(c.uvarint());
    }
    keys[i] = {
      zoom: Number(pz),
      x: Number(px),
      y: Number(py),
      timeStart: pt,
      timeEnd: pt + duration,
      featureCount,
      temporalBucketMs,
    };
  }

  const entries: DirectoryEntry[] = new Array(n);
  let cursor = 0;
  let expectedOffset = 0n;
  let prevPackId = 0n;
  for (let r = 0; r < runCount; r++) {
    const runLen = Number(c.uvarint());
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
    const length = Number(c.uvarint());
    const uncompressedSize = Number(c.uvarint());
    const crc32c = c.u32le();

    if (cursor + runLen > n) {
      throw new Error('STT directory: run length exceeds entry count');
    }
    const packIdNum = Number(packId);
    for (let k = 0; k < runLen; k++) {
      const key = keys[cursor];
      entries[cursor] = {
        zoom: key.zoom,
        x: key.x,
        y: key.y,
        timeStart: Number(key.timeStart),
        timeEnd: Number(key.timeEnd),
        packId: packIdNum,
        offset: Number(offset),
        length,
        uncompressedSize,
        featureCount: key.featureCount,
        crc32c,
        temporalBucketMs: key.temporalBucketMs,
      };
      cursor++;
    }
    expectedOffset = offset + BigInt(length);
  }

  if (cursor !== n) {
    throw new Error(
      `STT directory: runs covered ${cursor} entries, expected ${n}`,
    );
  }

  // Optional trailing covering section(s). A pre-covering archive's buffer ends
  // here; if bytes remain, read tagged sections (unknown tags stop the scan).
  if (c.pos < bytes.length) {
    const tag = bytes[c.pos++];
    if (tag === COVER_SECTION_TMIN) {
      for (let i = 0; i < n; i++) {
        entries[i].coverTMin = entries[i].timeStart + Number(c.ivarint());
      }
    }
  }
  return entries;
}

// ----------------------------------------------------------------------------
// Encode (mirror of the Rust encoder — used by tests / tooling that build
// synthetic archives; the production writer is the Rust `stt-core`).
// ----------------------------------------------------------------------------

/** A directory entry to encode. `hilbert`/`packId` default to 0. */
export interface DirectoryEncodeEntry {
  zoom: number;
  x: number;
  y: number;
  timeStart: number;
  timeEnd: number;
  /** Packed-format pack index. Defaults to 0 (single implicit pack). */
  packId?: number;
  offset: number;
  length: number;
  uncompressedSize: number;
  featureCount: number;
  hilbert?: number;
  /**
   * CRC-32C of the compressed blob. REQUIRED — pass the real CRC (the
   * `crc32c()` helper) for decodable blobs, or an explicit `0` to mean "no
   * checksum recorded" (the reader skips verification for 0). Required
   * rather than defaulted so a synthetic-archive author cannot silently opt
   * a test out of the default-on verification path by omission.
   */
  crc32c: number;
  temporalBucketMs?: number;
  /** Tight lower covering bound (see `DirectoryEntry.coverTMin`). */
  coverTMin?: number;
}

function putUvarint(out: number[], value: bigint): void {
  let v = value;
  for (;;) {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) {
      out.push(byte | 0x80);
    } else {
      out.push(byte);
      break;
    }
  }
}

function zigzag(v: bigint): bigint {
  return v < 0n ? (-v << 1n) - 1n : v << 1n;
}

function putIvarint(out: number[], value: bigint): void {
  putUvarint(out, zigzag(value));
}

/** Encode tile entries into a v5 directory buffer. Round-trips with `decodeDirectory`. */
export function encodeDirectory(entries: DirectoryEncodeEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => {
    if (a.zoom !== b.zoom) return a.zoom - b.zoom;
    const ah = a.hilbert ?? 0;
    const bh = b.hilbert ?? 0;
    if (ah !== bh) return ah < bh ? -1 : 1;
    return a.timeStart < b.timeStart ? -1 : a.timeStart > b.timeStart ? 1 : 0;
  });
  const n = sorted.length;

  // Group consecutive entries that point at the same blob into runs. Two
  // entries collapse only when same pack AND same blob (pack_id is part of the
  // run identity in v5), matching the Rust encoder.
  interface Run {
    runLen: number;
    packId: bigint;
    offset: bigint;
    length: number;
    uncompressed: number;
    crc: number;
  }
  const runs: Run[] = [];
  let i = 0;
  while (i < n) {
    const head = sorted[i];
    const crc = (head.crc32c ?? 0) >>> 0;
    const packId = head.packId ?? 0;
    let j = i + 1;
    while (
      j < n &&
      (sorted[j].packId ?? 0) === packId &&
      sorted[j].offset === head.offset &&
      sorted[j].length === head.length &&
      sorted[j].uncompressedSize === head.uncompressedSize &&
      (sorted[j].crc32c ?? 0) >>> 0 === crc
    ) {
      j++;
    }
    runs.push({
      runLen: j - i,
      packId: BigInt(packId),
      offset: BigInt(head.offset),
      length: head.length,
      uncompressed: head.uncompressedSize,
      crc,
    });
    i = j;
  }

  const out: number[] = [];
  out.push(DIRECTORY_VERSION);
  putUvarint(out, BigInt(n));
  putUvarint(out, BigInt(runs.length));

  let pz = 0n;
  let ph = 0n;
  let px = 0n;
  let py = 0n;
  let pt = 0n;
  for (const e of sorted) {
    // The Rust decoder narrows these columns to u8 / u32; reject out-of-range
    // values here instead of silently truncating on the other side.
    if (!Number.isInteger(e.zoom) || e.zoom < 0 || e.zoom > 0xff) {
      throw new Error(`encodeDirectory: zoom ${e.zoom} out of u8 range`);
    }
    if (!Number.isInteger(e.x) || e.x < 0 || e.x > 0xffffffff) {
      throw new Error(`encodeDirectory: x ${e.x} out of u32 range`);
    }
    if (!Number.isInteger(e.y) || e.y < 0 || e.y > 0xffffffff) {
      throw new Error(`encodeDirectory: y ${e.y} out of u32 range`);
    }
    if (
      !Number.isInteger(e.featureCount) ||
      e.featureCount < 0 ||
      e.featureCount > 0xffffffff
    ) {
      throw new Error(
        `encodeDirectory: featureCount ${e.featureCount} out of u32 range`,
      );
    }
    const z = BigInt(e.zoom);
    const h = BigInt(e.hilbert ?? 0);
    const x = BigInt(e.x);
    const y = BigInt(e.y);
    const ts = BigInt(e.timeStart);
    putIvarint(out, z - pz);
    pz = z;
    putIvarint(out, h - ph);
    ph = h;
    putIvarint(out, x - px);
    px = x;
    putIvarint(out, y - py);
    py = y;
    putIvarint(out, ts - pt);
    pt = ts;
    putIvarint(out, BigInt(e.timeEnd) - ts); // duration
    putUvarint(out, BigInt(e.featureCount));
    if (e.temporalBucketMs !== undefined) {
      putUvarint(out, 1n);
      putUvarint(out, BigInt(e.temporalBucketMs));
    } else {
      putUvarint(out, 0n);
    }
  }

  let expectedOffset = 0n;
  let prevPackId = 0n;
  for (const r of runs) {
    putUvarint(out, BigInt(r.runLen));
    // Δpack_id (zig-zag). Reset the offset contiguity expectation on a pack
    // change so this run's first blob is "contiguous from 0" (pack-relative).
    if (r.packId !== prevPackId) {
      expectedOffset = 0n;
    }
    putIvarint(out, r.packId - prevPackId);
    prevPackId = r.packId;
    if (r.offset === expectedOffset) {
      putUvarint(out, 0n);
    } else {
      putUvarint(out, 1n);
      putUvarint(out, r.offset);
    }
    putUvarint(out, BigInt(r.length));
    putUvarint(out, BigInt(r.uncompressed));
    out.push(
      r.crc & 0xff,
      (r.crc >>> 8) & 0xff,
      (r.crc >>> 16) & 0xff,
      (r.crc >>> 24) & 0xff,
    );
    expectedOffset = r.offset + BigInt(r.length);
  }

  // Optional trailing covering section — emitted only when every entry carries
  // a tight lower bound (mirrors the Rust encoder).
  if (n > 0 && sorted.every((e) => e.coverTMin !== undefined)) {
    out.push(COVER_SECTION_TMIN);
    for (const e of sorted) {
      putIvarint(out, BigInt(e.coverTMin!) - BigInt(e.timeStart));
    }
  }

  return Uint8Array.from(out);
}

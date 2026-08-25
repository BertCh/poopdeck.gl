// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
//
// Decoder for the STT directory — the compact columnar run-length tile index
// for the packed format. Mirrors the Rust codec in
// `crates/stt-core/src/directory.rs`. The client is packed-only: it writes v6
// and reads v5/v6. v5 introduced per-run `pack_id` + pack-relative offsets; v6
// adds per-entry `variant_id`. The retired single-file v4 layout (one implicit
// pack, no `pack_id`) is never handed to the client and is no longer decoded.
//
//   u8      version_tag = 6
//   uvarint N            entry count
//   uvarint R            run count
//   per-entry × N:  Δzoom Δhilbert Δx Δy Δtime_start (zig-zag), duration
//                   (zig-zag), feature_count (uvarint), bucket presence flag
//                   (+ value uvarint when present), variant_id (uvarint)
//   per-run × R:    run_length (uvarint), Δpack_id (zig-zag),
//                   offset flag (+ raw offset uvarint when non-contiguous),
//                   length, uncompressed_size, crc32c (u32 LE)
//
// Each run's blob lives in a specific pack object. `pack_id` is delta+zig-zag
// coded against the previous run; the offset contiguity expectation
// (`expectedOffset`) resets to 0 whenever the pack changes, so offsets are
// pack-relative and the first run of each pack rides the cheap `0` sentinel.
//
// Varints are LEB128; signed columns use zig-zag. Values decode as JS Numbers,
// exact below 2^53 — which every surfaced field (offsets/timestamps) must
// satisfy anyway; a wider value is re-read exactly as a BigInt so it can be
// rejected with its true value. See `Cursor`.

/** Directory codec version the TS encoder emits (matches the Rust writer). */
export const DIRECTORY_VERSION = 6;
/**
 * Oldest directory codec {@link decodeDirectory} accepts.
 *
 * v5 buffers carry no `variantId` column; every entry reads back as variant 0,
 * which is exactly what those archives meant — the variant axis did not exist,
 * so all payloads were raw.
 *
 * Read-only: {@link encodeDirectory} always writes {@link DIRECTORY_VERSION}, so
 * no new pre-v6 bytes can be produced here. It exists because several published
 * archives have no reproducible source, and a read-side cutover would strand
 * them rather than migrate them.
 */
export const MIN_DIRECTORY_VERSION = 5;
/**
 * Tag for the optional trailing covering section: one signed varint per entry
 * (in directory order) giving `coverTMin - timeStart`. Backward-compatible — a
 * pre-covering directory ends after the per-run blob columns and decodes with
 * `coverTMin` undefined. Mirrors `COVER_SECTION_TMIN` in directory.rs.
 */
const COVER_SECTION_TMIN = 1;

// ----------------------------------------------------------------------------
// Paged directory — root page. Mirrors the Rust
// `crates/stt-core/src/directory_page.rs` container: a `.sttd` is
// `[root frame][leaf 0 frame]...`, each an independent (zstd) frame. The root is
// a fixed-width table of page descriptors carrying each leaf's byte range plus
// its pruning bounds (geographic bbox, zoom range, temporal [t_min, t_max]).
// The reader decodes the root, prunes leaves by viewport/zoom/time, and fetches
// only the survivors. The leaf codec is the unchanged v6 directory below.
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

export interface PagedRootValidation {
  /** Total post-magic at-rest directory bytes (root frame + all leaves). */
  payloadLength?: number;
  /** At-rest root-frame length from the manifest. */
  rootLength?: number;
  /** Manifest-declared leaf count. */
  pageCount?: number;
  /** Manifest-declared nominal entries per page. */
  pageEntries?: number;
}

function safeBigInt(value: bigint, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(
      `STT directory: ${field} ${value} is outside JavaScript's safe integer range`,
    );
  }
  return number;
}

/**
 * Decode the paged-directory root page from its raw (already-unframed) bytes.
 * Mirrors `directory_page::decode_root`. Throws on an unknown version /
 * descriptor kind or a truncated buffer.
 */
export function decodePagedRoot(
  bytes: Uint8Array,
  validation: PagedRootValidation = {},
): PagedRoot {
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
  if (dv.getUint16(2, true) !== 0) {
    throw new Error('STT paged root: reserved header bytes must be zero');
  }
  const pageCount = dv.getUint32(4, true);
  const pageEntries = dv.getUint32(8, true);
  const availableDescriptors = Math.floor(
    (bytes.length - ROOT_HEADER_LEN) / DESCRIPTOR_LEN,
  );
  if (pageCount > availableDescriptors) {
    const need = ROOT_HEADER_LEN + pageCount * DESCRIPTOR_LEN;
    throw new Error(
      `STT paged root: truncated (${bytes.length} B, need ${need} for ${pageCount} pages)`,
    );
  }
  const need = ROOT_HEADER_LEN + pageCount * DESCRIPTOR_LEN;
  if (bytes.length !== need) {
    throw new Error(
      `STT paged root: trailing bytes (${bytes.length} B, expected exactly ${need})`,
    );
  }
  if (
    validation.pageCount !== undefined &&
    pageCount !== validation.pageCount
  ) {
    throw new Error(
      `STT paged root: page count ${pageCount} disagrees with manifest ${validation.pageCount}`,
    );
  }
  if (
    validation.pageEntries !== undefined &&
    pageEntries !== validation.pageEntries
  ) {
    throw new Error(
      `STT paged root: pageEntries ${pageEntries} disagrees with manifest ${validation.pageEntries}`,
    );
  }
  const pages: PageDescriptor[] = new Array(pageCount);
  let previousEnd = 0;
  for (let i = 0; i < pageCount; i++) {
    let o = ROOT_HEADER_LEN + i * DESCRIPTOR_LEN;
    const relOffset = safeBigInt(
      dv.getBigUint64(o, true),
      `page ${i} relative offset`,
    );
    o += 8;
    const length = dv.getUint32(o, true);
    o += 4;
    const entryCount = dv.getUint32(o, true);
    o += 4;
    const minZoom = dv.getUint8(o);
    o += 1;
    const maxZoom = dv.getUint8(o);
    o += 1;
    if (dv.getUint16(o, true) !== 0) {
      throw new Error(`STT paged root: page ${i} reserved bytes must be zero`);
    }
    o += 2;
    const minLon = dv.getInt32(o, true) / 1e7;
    o += 4;
    const minLat = dv.getInt32(o, true) / 1e7;
    o += 4;
    const maxLon = dv.getInt32(o, true) / 1e7;
    o += 4;
    const maxLat = dv.getInt32(o, true) / 1e7;
    o += 4;
    const tMin = safeBigInt(dv.getBigInt64(o, true), `page ${i} tMin`);
    o += 8;
    const tMax = safeBigInt(dv.getBigInt64(o, true), `page ${i} tMax`);
    if (length === 0 || entryCount === 0) {
      throw new Error(
        `STT paged root: page ${i} must have non-zero length and entryCount`,
      );
    }
    if (minZoom > maxZoom) {
      throw new Error(
        `STT paged root: page ${i} has inverted zoom range ${minZoom}..${maxZoom}`,
      );
    }
    if (minLon > maxLon || minLat > maxLat) {
      throw new Error(`STT paged root: page ${i} has inverted geographic bbox`);
    }
    if (tMin > tMax) {
      throw new Error(`STT paged root: page ${i} has inverted time range`);
    }
    const end = relOffset + length;
    if (!Number.isSafeInteger(end)) {
      throw new Error(`STT paged root: page ${i} byte range overflows`);
    }
    if (relOffset < previousEnd) {
      throw new Error(
        `STT paged root: page ${i} overlaps or precedes the previous page`,
      );
    }
    if (
      validation.payloadLength !== undefined &&
      validation.rootLength !== undefined &&
      end > validation.payloadLength - validation.rootLength
    ) {
      throw new Error(
        `STT paged root: page ${i} range ${relOffset}..${end} exceeds ` +
          `directory leaf bytes ${validation.payloadLength - validation.rootLength}`,
      );
    }
    previousEnd = end;
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
  /** Independently addressable payload representation. */
  variantId: number;
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

/** 2^53 — the first integer a double cannot represent exactly. */
const TWO_POW_53 = 9007199254740992;

function safeNumber(value: number, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `STT directory: ${field} ${value} is outside JavaScript's safe integer range`,
    );
  }
  return value;
}

/** Zig-zag → signed. Exact for `v` < 2^53 (`v + 1` ≤ 2^53 is still exact). */
function unzigzag(v: number): number {
  return v % 2 === 1 ? -(v + 1) / 2 : v / 2;
}

function unzigzagBig(v: bigint): bigint {
  return (v >> 1n) ^ -(v & 1n);
}

/**
 * Byte cursor over one directory payload.
 *
 * Varints decode as JS Numbers, not BigInts. This is the per-entry hot loop of
 * every leaf decode — 4,096 entries per leaf, 4–8 leaves per viewport settle,
 * on the main thread — and BigInt accumulation cost ~7× Number arithmetic per
 * varint, about a third of the decode. A Number is exact below 2^53, and every
 * field the reader surfaces must be a safe integer anyway (the BigInt path
 * narrowed each with `safeBigInt`), so the fast path cannot accept a value the
 * old path rejected or vice versa: a wire value at or above 2^53 is re-read
 * exactly as a BigInt (`readBig`) and then accumulated or rejected with the
 * same message the narrowing produced.
 */
class Cursor {
  pos = 0;
  constructor(public readonly bytes: Uint8Array) {}

  /** Unsigned varint. A value ≥ 2^53 is rejected, with its exact value, as `field`. */
  uvarint(field: string): number {
    const start = this.pos;
    const v = this.readNumber();
    if (v < TWO_POW_53) return v;
    this.pos = start;
    return safeBigInt(this.readBig(), field);
  }

  /** Signed (zig-zag) varint standing alone; rejected as `field` when unsafe. */
  ivarint(field: string): number {
    const start = this.pos;
    const v = this.readNumber();
    if (v < TWO_POW_53) return unzigzag(v);
    this.pos = start;
    return safeBigInt(unzigzagBig(this.readBig()), field);
  }

  /**
   * `prev` plus a signed (zig-zag) varint — a delta-coded column's running
   * value. Only the SUM is range-checked, as the BigInt accumulators were: a
   * delta too wide for the fast path is added exactly, so a swing that lands
   * back inside the safe range is accepted as before. On the fast path the sum
   * comes back unchecked for the caller to narrow with {@link safeNumber}; it
   * is never silently wrong, because a sum of two safe integers that leaves
   * the safe range is not a safe integer either.
   */
  delta(prev: number, field: string): number {
    const start = this.pos;
    const v = this.readNumber();
    if (v < TWO_POW_53) return prev + unzigzag(v);
    this.pos = start;
    return safeBigInt(BigInt(prev) + unzigzagBig(this.readBig()), field);
  }

  /** A presence / contiguity flag: non-zero at any width, never narrowed. */
  flag(): boolean {
    return this.readNumber() !== 0;
  }

  /**
   * Consume a varint whose value is never used — the Hilbert column, a 2·zoom
   * bit key that exceeds 2^53 from zoom 27. Same truncation and 64-bit width
   * checks as a read, no accumulation.
   */
  skip(): void {
    for (let k = 0; ; k++) {
      if (this.pos >= this.bytes.length) {
        throw new Error('STT directory: truncated varint');
      }
      const byte = this.bytes[this.pos++];
      if ((byte & 0x80) === 0) return;
      if (k >= 9) {
        throw new Error('STT directory: varint exceeds 64 bits');
      }
    }
  }

  /**
   * LEB128 → Number. Exact below 2^53; at or above it the result is only
   * guaranteed to compare ≥ 2^53 (each 7-bit group is added at an exact
   * power-of-two scale, so rounding cannot pull a wide value under the edge),
   * which is all a caller needs to divert to {@link readBig}.
   */
  private readNumber(): number {
    const bytes = this.bytes;
    let pos = this.pos;
    // Single-byte values are the bulk of a delta-coded directory.
    if (pos < bytes.length && bytes[pos] < 0x80) {
      this.pos = pos + 1;
      return bytes[pos];
    }
    let result = 0;
    let scale = 1;
    for (let k = 0; ; k++) {
      if (pos >= bytes.length) {
        throw new Error('STT directory: truncated varint');
      }
      const byte = bytes[pos++];
      result += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) break;
      scale *= 128;
      if (k >= 9) {
        throw new Error('STT directory: varint exceeds 64 bits');
      }
    }
    this.pos = pos;
    return result;
  }

  /** LEB128 → BigInt, exact up to 64 bits. The wide / reject path only. */
  private readBig(): bigint {
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

/** Decode a v6 (packed) directory buffer into tile entries (in directory order). */
export function decodeDirectory(bytes: Uint8Array): DirectoryEntry[] {
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
  const c = new Cursor(bytes);
  c.pos = 1;

  const n = c.uvarint('entry count');
  const runCount = c.uvarint('run count');
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
    timeStart: number;
    timeEnd: number;
    featureCount: number;
    temporalBucketMs?: number;
    variantId: number;
  }
  const keys: Key[] = new Array(n);

  // Delta accumulators. `hilbert` is delta-coded too and must be consumed to
  // stay aligned, but the reader never surfaces it, so it is skipped rather
  // than accumulated.
  let pz = 0;
  let px = 0;
  let py = 0;
  let pt = 0;
  for (let i = 0; i < n; i++) {
    pz = c.delta(pz, `entry ${i} zoom`);
    c.skip(); // hilbert delta — consumed, not stored
    px = c.delta(px, `entry ${i} x`);
    py = c.delta(py, `entry ${i} y`);
    pt = c.delta(pt, `entry ${i} timeStart`);
    const timeEndRaw = c.delta(pt, `entry ${i} timeEnd`); // pt + duration
    const featureCount = c.uvarint(`entry ${i} featureCount`);
    const bucketPresent = c.flag();
    let temporalBucketMs: number | undefined;
    if (bucketPresent) {
      temporalBucketMs = c.uvarint(`entry ${i} temporalBucketMs`);
    }
    const variantId = hasVariantColumn ? c.uvarint(`entry ${i} variantId`) : 0;
    const zoom = safeNumber(pz, `entry ${i} zoom`);
    const x = safeNumber(px, `entry ${i} x`);
    const y = safeNumber(py, `entry ${i} y`);
    const timeStart = safeNumber(pt, `entry ${i} timeStart`);
    const timeEnd = safeNumber(timeEndRaw, `entry ${i} timeEnd`);
    if (zoom < 0 || x < 0 || y < 0 || timeEnd < timeStart) {
      throw new Error(`STT directory: entry ${i} has invalid coordinates/time`);
    }
    keys[i] = {
      zoom,
      x,
      y,
      timeStart,
      timeEnd,
      featureCount,
      temporalBucketMs,
      variantId,
    };
  }

  const entries: DirectoryEntry[] = new Array(n);
  let cursor = 0;
  let expectedOffset = 0;
  let prevPackId = 0;
  for (let r = 0; r < runCount; r++) {
    const runLen = c.uvarint(`run ${r} length`);
    // Δpack_id (zig-zag) precedes the offset sentinel. Reset the offset
    // contiguity expectation when the pack changes, so the first run of each
    // pack hits the cheap `0` sentinel (offsets are pack-relative).
    const packId = c.delta(prevPackId, `run ${r} packId`);
    if (packId !== prevPackId) {
      expectedOffset = 0;
    }
    prevPackId = packId;
    const offset = c.flag() ? c.uvarint(`run ${r} offset`) : expectedOffset;
    const length = c.uvarint(`run ${r} length bytes`);
    const uncompressedSize = c.uvarint(`run ${r} uncompressedSize`);
    const crc32c = c.u32le();

    if (cursor + runLen > n) {
      throw new Error('STT directory: run length exceeds entry count');
    }
    const packIdNum = safeNumber(packId, `run ${r} packId`);
    const offsetNum = safeNumber(offset, `run ${r} offset`);
    if (packIdNum < 0 || length < 0 || uncompressedSize < 0 || offsetNum < 0) {
      throw new Error(`STT directory: run ${r} has invalid blob fields`);
    }
    for (let k = 0; k < runLen; k++) {
      const key = keys[cursor];
      entries[cursor] = {
        zoom: key.zoom,
        x: key.x,
        y: key.y,
        timeStart: key.timeStart,
        timeEnd: key.timeEnd,
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
    expectedOffset = safeNumber(offsetNum + length, `run ${r} ending offset`);
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
        const delta = c.ivarint(`entry ${i} coverTMin delta`);
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
  /** Independently addressable payload representation. Defaults to raw (0). */
  variantId?: number;
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

/** Encode tile entries into a v6 directory buffer. Round-trips with `decodeDirectory`. */
export function encodeDirectory(entries: DirectoryEncodeEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => {
    if (a.zoom !== b.zoom) return a.zoom - b.zoom;
    const ah = a.hilbert ?? 0;
    const bh = b.hilbert ?? 0;
    if (ah !== bh) return ah < bh ? -1 : 1;
    if (a.timeStart !== b.timeStart) return a.timeStart < b.timeStart ? -1 : 1;
    return (a.variantId ?? 0) - (b.variantId ?? 0);
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
    putUvarint(out, BigInt(e.variantId ?? 0));
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

// @stt/core
// SPDX-License-Identifier: MIT
//
// Decoder for the STT v4 directory — the compact columnar run-length tile
// index that replaces the old Arrow-IPC index. Mirrors the Rust encoder in
// `crates/stt-core/src/directory.rs`:
//
//   u8      version_tag = 4
//   uvarint N            entry count
//   uvarint R            run count
//   per-entry × N:  Δzoom Δhilbert Δx Δy Δtime_start (zig-zag), duration
//                   (zig-zag), feature_count (uvarint), bucket presence flag
//                   (+ value uvarint when present)
//   per-run × R:    run_length (uvarint), offset flag (+ raw offset uvarint
//                   when non-contiguous), length, uncompressed_size, crc32c (u32 LE)
//
// Varints are LEB128; signed columns use zig-zag. Values are accumulated as
// BigInt for exactness, then narrowed to JS numbers for the fields the reader
// uses (offsets/timestamps within 2^53, as elsewhere in the reader).

const DIRECTORY_VERSION = 4;

/**
 * A decoded directory entry. The integrity crc32c and the Hilbert key are read
 * (to advance the cursor) but not surfaced — the reader addresses tiles by
 * (zoom, x, y, time), not by Hilbert index. `encodeDirectory` therefore
 * defaults Hilbert to 0; the TS codec is decode-for-reading /
 * encode-for-synthetic-tests, not a faithful re-encoder of a Rust archive's
 * Hilbert column.
 */
export interface DirectoryEntry {
  zoom: number;
  x: number;
  y: number;
  timeStart: number;
  timeEnd: number;
  offset: number;
  length: number;
  uncompressedSize: number;
  featureCount: number;
  temporalBucketMs?: number;
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

/** Decode a v4 directory buffer into tile entries (in directory order). */
export function decodeDirectory(bytes: Uint8Array): DirectoryEntry[] {
  if (bytes.length === 0) {
    throw new Error('STT directory: empty buffer');
  }
  const version = bytes[0];
  if (version !== DIRECTORY_VERSION) {
    throw new Error(
      `STT directory: unsupported version ${version} (expected ${DIRECTORY_VERSION})`,
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
  for (let r = 0; r < runCount; r++) {
    const runLen = Number(c.uvarint());
    const offFlag = c.uvarint();
    const offset = offFlag === 0n ? expectedOffset : c.uvarint();
    const length = Number(c.uvarint());
    const uncompressedSize = Number(c.uvarint());
    c.u32le(); // crc32c integrity tag — not verified client-side

    if (cursor + runLen > n) {
      throw new Error('STT directory: run length exceeds entry count');
    }
    for (let k = 0; k < runLen; k++) {
      const key = keys[cursor];
      entries[cursor] = {
        zoom: key.zoom,
        x: key.x,
        y: key.y,
        timeStart: Number(key.timeStart),
        timeEnd: Number(key.timeEnd),
        offset: Number(offset),
        length,
        uncompressedSize,
        featureCount: key.featureCount,
        temporalBucketMs: key.temporalBucketMs,
      };
      cursor++;
    }
    expectedOffset = offset + BigInt(length);
  }

  if (cursor !== n) {
    throw new Error(`STT directory: runs covered ${cursor} entries, expected ${n}`);
  }
  return entries;
}

// ----------------------------------------------------------------------------
// Encode (mirror of the Rust encoder — used by tests / tooling that build
// synthetic archives; the production writer is the Rust `stt-core`).
// ----------------------------------------------------------------------------

/** A directory entry to encode. `hilbert`/`crc32c` default to 0. */
export interface DirectoryEncodeEntry {
  zoom: number;
  x: number;
  y: number;
  timeStart: number;
  timeEnd: number;
  offset: number;
  length: number;
  uncompressedSize: number;
  featureCount: number;
  hilbert?: number;
  crc32c?: number;
  temporalBucketMs?: number;
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

/** Encode tile entries into a v4 directory buffer. Round-trips with `decodeDirectory`. */
export function encodeDirectory(entries: DirectoryEncodeEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => {
    if (a.zoom !== b.zoom) return a.zoom - b.zoom;
    const ah = a.hilbert ?? 0;
    const bh = b.hilbert ?? 0;
    if (ah !== bh) return ah < bh ? -1 : 1;
    return a.timeStart < b.timeStart ? -1 : a.timeStart > b.timeStart ? 1 : 0;
  });
  const n = sorted.length;

  // Group consecutive entries that point at the same blob into runs.
  interface Run {
    runLen: number;
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
    let j = i + 1;
    while (
      j < n &&
      sorted[j].offset === head.offset &&
      sorted[j].length === head.length &&
      sorted[j].uncompressedSize === head.uncompressedSize &&
      ((sorted[j].crc32c ?? 0) >>> 0) === crc
    ) {
      j++;
    }
    runs.push({
      runLen: j - i,
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
    if (!Number.isInteger(e.featureCount) || e.featureCount < 0 || e.featureCount > 0xffffffff) {
      throw new Error(`encodeDirectory: featureCount ${e.featureCount} out of u32 range`);
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
  for (const r of runs) {
    putUvarint(out, BigInt(r.runLen));
    if (r.offset === expectedOffset) {
      putUvarint(out, 0n);
    } else {
      putUvarint(out, 1n);
      putUvarint(out, r.offset);
    }
    putUvarint(out, BigInt(r.length));
    putUvarint(out, BigInt(r.uncompressed));
    out.push(r.crc & 0xff, (r.crc >>> 8) & 0xff, (r.crc >>> 16) & 0xff, (r.crc >>> 24) & 0xff);
    expectedOffset = r.offset + BigInt(r.length);
  }

  return Uint8Array.from(out);
}

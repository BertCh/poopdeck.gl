// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * Reader for the layer-frame `PATH_CODEC` section (tag `0x06`, manifest
 * capability `path-codec`): a LineString layer's coordinates and per-vertex
 * times stored as per-feature predictor residuals instead of Arrow leaf
 * buffers. The wire contract is upstream
 * (`stt:docs/roadmap/path-codec-wire-2026-11.md`, moving into
 * `docs/spec/stt-packed-format.md`); this module is its TypeScript decoder.
 *
 * The codec is lossless. {@link decodePathCodec} returns exactly the buffers a
 * non-codec layer would have carried — list offsets, the `Float64` (decimal
 * mode) or `Int32` world-grid (`stt:quant`) coordinate leaf, and absolute
 * `Int64` Unix-ms vertex times — and `tile.ts` substitutes them for the CORE
 * batch's empty `geometry` / `vertex_time` columns before anything downstream
 * sees the layer.
 *
 * Validation is strict and total: every rejection the spec lists throws a
 * named `Error`, no read goes past the section, and every allocation is
 * bounded by the SECTION LENGTH (a vertex costs at least two bytes of residual)
 * or by the CORE batch's row count, never by a count the section merely
 * claims.
 *
 * Exactness. Every integer is held in a double, which is exactly what the
 * spec's normative integer bound (§5.2.7) is for: every varint value (after
 * zigzag), `q`, `q * U`, `t`, predictor, `TIME_VEL` term and `k` must lie
 * within ±(2^53 − 1), and a section where one does not is rejected rather than
 * rounded. Varints are accumulated without 32-bit shifts, and a zigzag value
 * is bounded before it is formed (its unsigned form can reach 2^54), so every
 * check is exact. The encoder rules (`|k| < 2^50`, `|t| < 2^52` ms) keep every
 * valid section well inside the bound.
 */

/** Layer-frame section tag of the path codec. */
export const SECTION_PATH_CODEC = 0x06;

/** The only `version` byte this reader decodes. */
const PATH_CODEC_VERSION = 1;
const FLAG_TIME = 0x01;
const FLAG_DECIMAL = 0x02;
const FLAGS_KNOWN = FLAG_TIME | FLAG_DECIMAL;

/** Per-feature predictor tags. */
const TAG_DELTA = 0;
const TAG_CONST_VEL = 1;
const TAG_TIME_VEL = 2;

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const TWO_26 = 67108864;
const TWO_27 = 134217728;
const TWO_32 = 4294967296;
const INV_TWO_32 = 1 / TWO_32;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
/** `10^e` for the spec's exponent range `0..=15`, every entry exact. */
const POW10 = [
  1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14,
  1e15,
];

const LITTLE_ENDIAN =
  new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 0x04;

/** What the CORE schema says the section must agree with. */
export interface PathCodecExpectation {
  /** The CORE batch's row count (`feature_count` MUST equal it). */
  featureCount: number;
  /** Whether the layer has a `vertex_time` column (the TIME flag). */
  hasTime: boolean;
  /** Whether the geometry leaf is `Float64` (the DECIMAL flag). */
  decimal: boolean;
}

/** The reconstructed column buffers of one codec layer. */
export interface DecodedPathCodec {
  vertexCount: number;
  /** List offsets, `featureCount + 1` entries (shared by both columns). */
  offsets: Int32Array;
  /**
   * Interleaved `[x, y]` leaf, `2 * vertexCount` values: `Float64Array`
   * lon/lat in decimal mode, `Int32Array` grid indices in world-grid mode.
   */
  coords: Float64Array | Int32Array;
  /** Absolute Unix-ms vertex times; present exactly when TIME is set. */
  times: BigInt64Array | undefined;
}

// ─── Varint cursor ──────────────────────────────────────────────────────────
//
// Module-level cursor so the readers return a plain number without allocating
// a result object. Decoding is synchronous and non-reentrant, so one cursor
// per realm (one per worker) is enough. The single-byte case is inlined at the
// hot call sites; these functions are the general path.

let cur = 0;

function fail(what: string, message: string): never {
  throw new Error(`${what}: PATH_CODEC ${message}`);
}

/**
 * Read one unsigned LEB128 varint at {@link cur}. Accumulates in doubles
 * (`byte * 128^n`), so it is exact while the value is at most 2^53; anything
 * larger is rejected, as is a varint longer than ten bytes.
 */
function readUvarint(buf: Uint8Array, end: number, what: string): number {
  let p = cur;
  let result = 0;
  let mul = 1;
  for (let n = 0; n < 10; n++) {
    if (p >= end) fail(what, 'section truncated inside a varint');
    const b = buf[p++];
    result += (b & 0x7f) * mul;
    if (b < 0x80) {
      if (result > MAX_SAFE) {
        fail(what, `varint ${result} exceeds 2^53 - 1`);
      }
      cur = p;
      return result;
    }
    mul *= 128;
  }
  return fail(what, 'varint longer than 10 bytes');
}

/**
 * Read one zigzag (`svarint`) value at {@link cur}. The varint is split into
 * its low 28 bits (an exact int) and the rest (`hi`, an exact double), so the
 * zigzag magnitude `floor(u / 2) = hi·2^27 + (lo >>> 1)` is bounded in integer
 * terms BEFORE it is formed and is never rounded — even though the unsigned
 * form of an in-bound value reaches 2^54 — and the decoded value must lie
 * within the spec's ±(2^53 − 1).
 */
function readSvarint(buf: Uint8Array, end: number, what: string): number {
  let p = cur;
  let lo = 0;
  let hi = 0;
  let mul = 1;
  let b = 0x80;
  for (let n = 0; b >= 0x80; n++) {
    if (n === 10) fail(what, 'varint longer than 10 bytes');
    if (p >= end) fail(what, 'section truncated inside a varint');
    b = buf[p++];
    if (n < 4) {
      lo |= (b & 0x7f) << (7 * n);
    } else {
      hi += (b & 0x7f) * mul;
      mul *= 128;
    }
  }
  const neg = lo & 1;
  // hi < 2^26 keeps half <= 2^53 - 1 (exact); a negative value is
  // -(half + 1), so it additionally needs half < 2^53 - 1.
  const half = hi < TWO_26 ? hi * TWO_27 + (lo >>> 1) : MAX_SAFE + 1;
  if (half > MAX_SAFE - neg) {
    fail(what, 'svarint value outside ±(2^53 - 1)');
  }
  cur = p;
  return neg ? -half - 1 : half;
}

/**
 * Decode and validate one `PATH_CODEC` section. Throws a named `Error` on
 * every rejection of spec §4 (and on any value it cannot hold exactly); on
 * success the returned buffers are fresh and owned by the caller.
 */
export function decodePathCodec(
  sec: Uint8Array,
  expect: PathCodecExpectation,
  what: string,
): DecodedPathCodec {
  const end = sec.length;
  if (end < 2) fail(what, 'section truncated (no version/flags)');
  const version = sec[0];
  if (version !== PATH_CODEC_VERSION) {
    fail(
      what,
      `version ${version} is not supported (this reader knows ${PATH_CODEC_VERSION})`,
    );
  }
  const flags = sec[1];
  if ((flags & ~FLAGS_KNOWN) !== 0) {
    fail(what, `reserved flag bits set (flags 0x${flags.toString(16)})`);
  }
  const hasTime = (flags & FLAG_TIME) !== 0;
  const decimal = (flags & FLAG_DECIMAL) !== 0;
  if (hasTime !== expect.hasTime) {
    fail(
      what,
      hasTime
        ? 'TIME flag is set but the layer has no vertex_time column'
        : 'TIME flag is clear but the layer has a vertex_time column',
    );
  }
  if (decimal !== expect.decimal) {
    fail(
      what,
      decimal
        ? 'DECIMAL flag is set but the geometry leaf is Int32 (world grid)'
        : 'DECIMAL flag is clear but the geometry leaf is Float64',
    );
  }
  cur = 2;
  const featureCount = readUvarint(sec, end, what);
  if (featureCount !== expect.featureCount) {
    fail(
      what,
      `feature_count ${featureCount} does not match the CORE batch row count ${expect.featureCount}`,
    );
  }
  const vertexCount = readUvarint(sec, end, what);
  // Allocation bound: every vertex costs at least two residual bytes (two
  // more with TIME), every feature one count byte and one tag byte. A count
  // the remaining bytes cannot hold is rejected BEFORE anything is sized
  // from it.
  const perVertex = hasTime ? 4 : 2;
  if (
    vertexCount > INT32_MAX ||
    featureCount * 2 + vertexCount * perVertex > end - cur
  ) {
    fail(
      what,
      `vertex_count ${vertexCount} with feature_count ${featureCount} cannot fit ` +
        `in the ${end - cur} bytes that remain`,
    );
  }

  let p10 = 1;
  if (decimal) {
    if (cur >= end) fail(what, 'section truncated (no decimal exponent)');
    const e = sec[cur++];
    if (e > 15) fail(what, `decimal exponent ${e} is outside 0..=15`);
    p10 = POW10[e];
  }
  let unit = 1;
  let qbase = 0;
  if (hasTime) {
    unit = readUvarint(sec, end, what);
    if (unit < 1) fail(what, 'time unit U must be at least 1');
    qbase = readSvarint(sec, end, what);
  }

  // counts → list offsets.
  const offsets = new Int32Array(featureCount + 1);
  let total = 0;
  let p = cur;
  for (let f = 0; f < featureCount; f++) {
    let c: number;
    const b = p < end ? sec[p] : 0x80;
    if (b < 0x80) {
      p++;
      c = b;
    } else {
      cur = p;
      c = readUvarint(sec, end, what);
      p = cur;
    }
    total += c;
    if (total > vertexCount) {
      fail(what, `feature vertex counts exceed vertex_count ${vertexCount}`);
    }
    offsets[f + 1] = total;
  }
  if (total !== vertexCount) {
    fail(
      what,
      `feature vertex counts sum to ${total}, not vertex_count ${vertexCount}`,
    );
  }

  // tags.
  if (end - p < featureCount) fail(what, 'section truncated in the tags');
  const tagsAt = p;
  for (let f = 0; f < featureCount; f++) {
    const tag = sec[tagsAt + f];
    if (tag > TAG_TIME_VEL) {
      fail(what, `unknown predictor tag ${tag} on feature ${f}`);
    }
    if (tag === TAG_TIME_VEL && !hasTime) {
      fail(what, `TIME_VEL predictor on feature ${f} of a layer without TIME`);
    }
  }
  cur = p + featureCount;

  // The three per-vertex streams are decoded in ONE pass with a cursor
  // each, so no time array is ever materialised beyond the Int64 output:
  // a terminator scan finds where `r` and `res` begin. (Measured: this beats
  // a q-array pass per stream, and the per-byte bounds checks it could also
  // retire cost less than scanning `res` to retire them.)
  const dqAt = cur;
  let rAt = dqAt;
  let resAt = dqAt;
  if (hasTime) {
    rAt = skipVarints(sec, dqAt, end, vertexCount, what);
    resAt = skipVarints(sec, rAt, end, vertexCount, what);
  }
  const times = hasTime ? new BigInt64Array(vertexCount) : undefined;
  const n2 = vertexCount * 2;
  const outF = decimal ? new Float64Array(n2) : undefined;
  const outI = decimal ? undefined : new Int32Array(n2);
  decodeVertices(
    sec,
    end,
    offsets,
    featureCount,
    tagsAt,
    dqAt,
    rAt,
    resAt,
    unit,
    qbase,
    times,
    outF,
    outI,
    p10,
    what,
  );

  // decimal-mode exceptions: XOR patches over the IEEE bit patterns.
  if (outF) applyExceptions(sec, end, outF, what);

  if (cur !== end) {
    fail(what, `${end - cur} trailing byte(s) after the section's last field`);
  }

  return { vertexCount, offsets, coords: (outF ?? outI)!, times };
}

/**
 * Advance past `count` varints from `p` and return the position after them
 * (a terminator scan: every varint ends at its first byte below 0x80).
 * Rejects a stream that runs out first. The ten-byte limit is enforced by
 * the decode pass, which reads exactly these varints.
 */
function skipVarints(
  sec: Uint8Array,
  p: number,
  end: number,
  count: number,
  what: string,
): number {
  // Branch-free: a byte below 0x80 ends a varint.
  while (count > 0 && p < end) count -= (sec[p++] >>> 7) ^ 1;
  if (count > 0) fail(what, 'section truncated inside a per-vertex stream');
  return p;
}

/**
 * Decode the per-vertex streams — `dq` and `r` (with TIME) and `res` — in
 * one pass, a cursor each, features in row order.
 *
 * Times: `q[0] = anchor + dq`, `q[j] = q[j-1] + dq`, `t = q * U + r`, and
 * `anchor` moves to each non-empty feature's `q[0]`. Coordinates: vertex 0
 * against `first` (the previous non-empty feature's `k[0]`), vertex 1 against
 * vertex 0 for every tag, `pred(tag)` from vertex 2 on. `k` is written
 * divided by `10^e` into `outF` (decimal) or verbatim into `outI` (grid); `t`
 * into `times`, as `lo` / `hi` words on a little-endian host.
 *
 * The one- and two-byte varint forms are inlined; longer ones (and every
 * truncation) go through {@link readUvarint} / {@link readSvarint}.
 */
function decodeVertices(
  sec: Uint8Array,
  end: number,
  offsets: Int32Array,
  featureCount: number,
  tagsAt: number,
  dqAt: number,
  rAt: number,
  resAt: number,
  unit: number,
  qbase: number,
  times: BigInt64Array | undefined,
  outF: Float64Array | undefined,
  outI: Int32Array | undefined,
  p10: number,
  what: string,
): void {
  const hasTime = times !== undefined;
  const halves =
    times && LITTLE_ENDIAN ? new Uint32Array(times.buffer) : undefined;
  const kMin = outF ? -MAX_SAFE : INT32_MIN;
  const kMax = outF ? MAX_SAFE : INT32_MAX;
  let pq = dqAt;
  let pr = rAt;
  let pc = resAt;
  let anchor = qbase;
  let fx = 0;
  let fy = 0;
  for (let f = 0; f < featureCount; f++) {
    const lo = offsets[f];
    const hi = offsets[f + 1];
    if (lo === hi) continue;
    const tag = sec[tagsAt + f];
    // k[i-1], k[i-2]; t[i-1], t[i-2]. Vertex 0 predicts from `first`.
    let x1 = fx;
    let y1 = fy;
    let x2 = 0;
    let y2 = 0;
    let q = anchor;
    let t1 = 0;
    let t2 = 0;
    for (let i = lo; i < hi; i++) {
      let b: number;
      let b1: number;
      let t = 0;
      if (hasTime) {
        // dq (svarint)
        let d: number;
        b = pq < end ? sec[pq] : 0x80;
        if (b < 0x80) {
          pq++;
          d = (b >>> 1) ^ ((b << 31) >> 31);
        } else if ((b1 = pq + 1 < end ? sec[pq + 1] : 0x80) < 0x80) {
          const u = (b & 0x7f) | (b1 << 7);
          pq += 2;
          d = (u >>> 1) ^ ((u << 31) >> 31);
        } else {
          cur = pq;
          d = readSvarint(sec, end, what);
          pq = cur;
        }
        q += d;
        if (!(q >= -MAX_SAFE && q <= MAX_SAFE)) {
          fail(what, `time quotient exceeds 2^53 - 1 at vertex ${i}`);
        }
        // r (uvarint)
        let r: number;
        b = pr < end ? sec[pr] : 0x80;
        if (b < 0x80) {
          pr++;
          r = b;
        } else if ((b1 = pr + 1 < end ? sec[pr + 1] : 0x80) < 0x80) {
          r = (b & 0x7f) | (b1 << 7);
          pr += 2;
        } else {
          cur = pr;
          r = readUvarint(sec, end, what);
          pr = cur;
        }
        if (r >= unit) {
          fail(what, `time remainder ${r} is not below the unit ${unit}`);
        }
        const qu = q * unit;
        t = qu + r;
        if (!(qu >= -MAX_SAFE && qu <= MAX_SAFE && t <= MAX_SAFE)) {
          fail(what, `vertex time q*U + r exceeds 2^53 - 1 at vertex ${i}`);
        }
        if (halves) {
          // Two's complement words of an exact integer (2^-32 is exact).
          const th = Math.floor(t * INV_TWO_32);
          halves[i * 2] = t - th * TWO_32;
          halves[i * 2 + 1] = th;
        } else {
          times![i] = BigInt(t);
        }
      }

      // res: x then y (svarints)
      let rx: number;
      let ry: number;
      b = pc < end ? sec[pc] : 0x80;
      if (b < 0x80) {
        pc++;
        rx = (b >>> 1) ^ ((b << 31) >> 31);
      } else if ((b1 = pc + 1 < end ? sec[pc + 1] : 0x80) < 0x80) {
        const u = (b & 0x7f) | (b1 << 7);
        pc += 2;
        rx = (u >>> 1) ^ ((u << 31) >> 31);
      } else {
        cur = pc;
        rx = readSvarint(sec, end, what);
        pc = cur;
      }
      b = pc < end ? sec[pc] : 0x80;
      if (b < 0x80) {
        pc++;
        ry = (b >>> 1) ^ ((b << 31) >> 31);
      } else if ((b1 = pc + 1 < end ? sec[pc + 1] : 0x80) < 0x80) {
        const u = (b & 0x7f) | (b1 << 7);
        pc += 2;
        ry = (u >>> 1) ^ ((u << 31) >> 31);
      } else {
        cur = pc;
        ry = readSvarint(sec, end, what);
        pc = cur;
      }

      // Vertices 0 and 1 (and every DELTA vertex) predict k[i-1].
      let px = x1;
      let py = y1;
      if (tag !== TAG_DELTA && i - lo >= 2) {
        const vx = x1 - x2;
        const vy = y1 - y2;
        // CONST_VEL, and TIME_VEL's `dt0 <= 0` fallback.
        px = x1 + vx;
        py = y1 + vy;
        if (tag !== TAG_CONST_VEL) {
          // TIME_VEL.
          const dt0 = t1 - t2;
          if (dt0 > 0) {
            const dt1 = t - t1;
            // Spec §5: binary64, multiply, divide, add 0.5, floor — in that
            // order (JS never fuses the multiply-add).
            const sx = Math.floor((vx * dt1) / dt0 + 0.5);
            const sy = Math.floor((vy * dt1) / dt0 + 0.5);
            if (
              !(
                sx >= -MAX_SAFE &&
                sx <= MAX_SAFE &&
                sy >= -MAX_SAFE &&
                sy <= MAX_SAFE
              )
            ) {
              fail(what, `TIME_VEL term outside ±(2^53 - 1) at vertex ${i}`);
            }
            px = x1 + sx;
            py = y1 + sy;
          }
        }
        // The spec's integer bound (§5.2.7): a predictor past 2^53 - 1 could
        // only round, so it is refused (no valid encoder output gets near:
        // |k| < 2^50, |v * dt1| <= 2^52).
        if (
          !(
            px >= -MAX_SAFE &&
            px <= MAX_SAFE &&
            py >= -MAX_SAFE &&
            py <= MAX_SAFE
          )
        ) {
          fail(what, `predictor exceeds 2^53 - 1 at vertex ${i}`);
        }
      }
      const x = px + rx;
      const y = py + ry;
      if (!(x >= kMin && x <= kMax && y >= kMin && y <= kMax)) {
        badCoordinate(x, y, i, outF !== undefined, what);
      }
      if (outF) {
        outF[i * 2] = x / p10;
        outF[i * 2 + 1] = y / p10;
      } else {
        outI![i * 2] = x;
        outI![i * 2 + 1] = y;
      }
      x2 = x1;
      y2 = y1;
      x1 = x;
      y1 = y;
      t2 = t1;
      t1 = t;
      if (i === lo) {
        fx = x;
        fy = y;
        anchor = q;
      }
    }
  }
  // The scan put `r` right after `dq` and `res` right after `r`.
  if (hasTime && (pq !== rAt || pr !== resAt)) {
    fail(what, 'per-vertex streams do not end where their scan did');
  }
  cur = pc;
}

function badCoordinate(
  x: number,
  y: number,
  i: number,
  decimal: boolean,
  what: string,
): never {
  return fail(
    what,
    `coordinate integer (${x}, ${y}) at vertex ${i} does not fit the ` +
      (decimal ? 'exact-double range' : 'Int32 grid'),
  );
}

/**
 * The decimal-mode exception list: `exc_count`, the delta-coded flat value
 * indices (`2n + axis`; first absolute, later ones `>= 1` apart), then one
 * `(lo, hi)` XOR patch per index, applied to the value's IEEE-754 bits.
 */
function applyExceptions(
  sec: Uint8Array,
  end: number,
  outF: Float64Array,
  what: string,
): void {
  const count = readUvarint(sec, end, what);
  const n2 = outF.length;
  // Bounded by the bytes: one index byte plus two patch bytes per exception.
  if (count > n2 || count * 3 > end - cur) {
    fail(
      what,
      `exc_count ${count} cannot fit (${n2} values, ${end - cur} bytes remain)`,
    );
  }
  if (count === 0) return;
  const indices = new Uint32Array(count);
  let idx = 0;
  for (let k = 0; k < count; k++) {
    const d = readUvarint(sec, end, what);
    if (k === 0) {
      idx = d;
    } else {
      if (d < 1) {
        fail(
          what,
          `exception indices are not strictly increasing (entry ${k})`,
        );
      }
      idx += d;
    }
    if (idx >= n2) {
      fail(what, `exception index ${idx} is out of range (${n2} values)`);
    }
    indices[k] = idx;
  }
  const halves = LITTLE_ENDIAN
    ? new Uint32Array(outF.buffer, outF.byteOffset, n2 * 2)
    : undefined;
  const view = LITTLE_ENDIAN
    ? undefined
    : new DataView(outF.buffer, outF.byteOffset, outF.byteLength);
  for (let k = 0; k < count; k++) {
    const lo = readUvarint(sec, end, what);
    const hi = readUvarint(sec, end, what);
    if (lo > 0xffffffff || hi > 0xffffffff) {
      fail(what, `exception patch half above 2^32 - 1 (entry ${k})`);
    }
    const at = indices[k];
    if (halves) {
      halves[at * 2] ^= lo;
      halves[at * 2 + 1] ^= hi;
    } else {
      // Big-endian host: the high word sits at the lower address.
      const off = at * 8;
      view!.setUint32(off, view!.getUint32(off, false) ^ hi, false);
      view!.setUint32(off + 4, view!.getUint32(off + 4, false) ^ lo, false);
    }
  }
}

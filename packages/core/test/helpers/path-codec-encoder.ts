/**
 * Test-only reference ENCODER for the layer-frame `PATH_CODEC` section (tag
 * 0x06), written from the wire spec (`stt:docs/roadmap/path-codec-wire-2026-11.md`
 * §§4–6), independently of `src/path-codec.ts`: every integer here is a
 * `bigint`, so it is exact where the decoder relies on double arithmetic, and
 * the round-trip tests compare the two.
 *
 * Two layers, so the must-throw matrix can corrupt any single field:
 * {@link buildPathCodecFields} turns features into the section's fields,
 * {@link serializePathCodec} writes them. Kept free of imports (and of
 * non-erasable TypeScript) so the decode bench can load it under Node's type
 * stripping as well.
 */

export const TAG_DELTA = 0;
export const TAG_CONST_VEL = 1;
export const TAG_TIME_VEL = 2;

/** One feature: interleaved `[x, y]` (grid integers, or doubles in decimal mode). */
export interface CodecFeatureInput {
  xy: ArrayLike<number>;
  /** Absolute Unix-ms vertex times (integers), one per vertex, with TIME. */
  t?: ArrayLike<number>;
}

export interface CodecEncodeOptions {
  /** DECIMAL flag: `xy` are doubles reconstructed as `k / 10^e` + patches. */
  decimal: boolean;
  /** Decimal exponent (default 7). */
  e?: number;
  /** TIME flag. */
  hasTime: boolean;
  /** Time unit U in ms (default: spec §6's recommended choice). */
  unit?: number;
  /** `qbase` (default: the first non-empty feature's first quotient). */
  qbase?: number;
  /** Force a predictor per feature (default: the smallest varint total). */
  tags?: number[];
}

/** Every field of a section, in wire order — mutate one to craft a reject. */
export interface PathCodecFields {
  version: number;
  flags: number;
  featureCount: bigint;
  vertexCount: bigint;
  e?: number;
  unit?: bigint;
  qbase?: bigint;
  counts: bigint[];
  tags: number[];
  dq: bigint[];
  r: bigint[];
  res: bigint[];
  /** Decimal only: the `exc_count` written (default: `excIdx.length`). */
  excCount?: bigint;
  /** Delta-coded flat indices, as written. */
  excIdx: bigint[];
  /** `(lo, hi)` XOR patch halves, as written. */
  excPatch: Array<[bigint, bigint]>;
  /** Extra bytes after the last field (must be rejected). */
  trailing?: number[];
}

const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);

function bitsOf(x: number): bigint {
  f64[0] = x;
  return u64[0];
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

function uvarintLen(v: bigint): number {
  let n = 1;
  while (v >= 0x80n) {
    v >>= 7n;
    n++;
  }
  return n;
}

function zigzag(v: bigint): bigint {
  return v >= 0n ? v * 2n : -v * 2n - 1n;
}

const TWO_52 = 2n ** 52n;

/** Spec §6's recommended unit: the coarsest candidate >= 80 % of times divide. */
export function recommendedUnit(times: number[]): number {
  const candidates = [86400000, 3600000, 60000, 10000, 1000, 100, 10, 1];
  if (times.length === 0) return 1;
  for (const u of candidates) {
    let hit = 0;
    for (const t of times) if (((t % u) + u) % u === 0) hit++;
    if (hit >= 0.8 * times.length) return u;
  }
  return 1;
}

/**
 * Residuals of one feature under `tag`, given its grid integers `kx/ky`
 * and absolute times. `null` when `tag` is not allowed for it (TIME_VEL
 * without times, or a `|v * dt1| > 2^52` vertex).
 */
function featureResiduals(
  kx: bigint[],
  ky: bigint[],
  t: bigint[] | undefined,
  tag: number,
  first: [bigint, bigint],
): bigint[] | null {
  const n = kx.length;
  const out: bigint[] = [];
  for (let i = 0; i < n; i++) {
    let px: bigint;
    let py: bigint;
    if (i === 0) {
      px = first[0];
      py = first[1];
    } else if (i === 1 || tag === TAG_DELTA) {
      px = kx[i - 1];
      py = ky[i - 1];
    } else {
      const vx = kx[i - 1] - kx[i - 2];
      const vy = ky[i - 1] - ky[i - 2];
      if (tag === TAG_CONST_VEL) {
        px = kx[i - 1] + vx;
        py = ky[i - 1] + vy;
      } else {
        if (!t) return null;
        const dt0 = t[i - 1] - t[i - 2];
        const dt1 = t[i] - t[i - 1];
        const abs = (v: bigint) => (v < 0n ? -v : v);
        if (abs(vx * dt1) > TWO_52 || abs(vy * dt1) > TWO_52) return null;
        if (dt0 > 0n) {
          const sx = Math.floor((Number(vx) * Number(dt1)) / Number(dt0) + 0.5);
          const sy = Math.floor((Number(vy) * Number(dt1)) / Number(dt0) + 0.5);
          px = kx[i - 1] + BigInt(sx);
          py = ky[i - 1] + BigInt(sy);
        } else {
          px = kx[i - 1] + vx;
          py = ky[i - 1] + vy;
        }
      }
    }
    out.push(kx[i] - px, ky[i] - py);
  }
  return out;
}

/** Encode features into section fields (spec §§4–6). */
export function buildPathCodecFields(
  features: CodecFeatureInput[],
  opts: CodecEncodeOptions,
): PathCodecFields {
  const e = opts.e ?? 7;
  const p10 = 10 ** e;
  const allTimes: number[] = [];
  if (opts.hasTime)
    for (const f of features) allTimes.push(...Array.from(f.t ?? []));
  const unit = BigInt(opts.unit ?? recommendedUnit(allTimes));

  const counts: bigint[] = [];
  const tags: number[] = [];
  const res: bigint[] = [];
  const excFlat: Array<[number, bigint]> = [];
  const qs: bigint[][] = [];
  const rs: bigint[][] = [];
  let first: [bigint, bigint] = [0n, 0n];
  let flatBase = 0;

  for (let fi = 0; fi < features.length; fi++) {
    const f = features[fi];
    const n = f.xy.length / 2;
    counts.push(BigInt(n));
    const kx: bigint[] = [];
    const ky: bigint[] = [];
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < 2; a++) {
        const x = f.xy[i * 2 + a];
        let k: bigint;
        if (opts.decimal) {
          const scaled = Math.round(x * p10);
          k =
            Number.isFinite(scaled) && Math.abs(scaled) < 2 ** 50
              ? BigInt(scaled)
              : 0n;
          const patch = bitsOf(Number(k) / p10) ^ bitsOf(x);
          if (patch !== 0n) excFlat.push([flatBase + i * 2 + a, patch]);
        } else {
          k = BigInt(x);
        }
        (a === 0 ? kx : ky).push(k);
      }
    }
    flatBase += n * 2;
    let t: bigint[] | undefined;
    if (opts.hasTime) {
      t = Array.from(f.t ?? [], (v) => BigInt(v));
      const q = t.map((v) => floorDiv(v, unit));
      qs.push(q);
      rs.push(t.map((v, i) => v - q[i] * unit));
    }
    let tag = opts.tags?.[fi];
    let best: bigint[] | null = null;
    if (tag !== undefined) {
      best = featureResiduals(kx, ky, t, tag, first);
      if (!best)
        throw new Error(`forced tag ${tag} not encodable on feature ${fi}`);
    } else {
      let bestLen = Infinity;
      for (const cand of [TAG_DELTA, TAG_CONST_VEL, TAG_TIME_VEL]) {
        if (cand === TAG_TIME_VEL && !opts.hasTime) continue;
        const r = featureResiduals(kx, ky, t, cand, first);
        if (!r) continue;
        const len = r.reduce((s, v) => s + uvarintLen(zigzag(v)), 0);
        if (len < bestLen) {
          bestLen = len;
          best = r;
          tag = cand;
        }
      }
    }
    tags.push(tag!);
    res.push(...best!);
    if (n > 0) first = [kx[0], ky[0]];
  }

  // Times: dq against the previous vertex, or the anchor for vertex 0.
  const dq: bigint[] = [];
  const r: bigint[] = [];
  let qbase: bigint | undefined;
  if (opts.hasTime) {
    const firstQ = qs.find((q) => q.length > 0)?.[0] ?? 0n;
    qbase = opts.qbase !== undefined ? BigInt(opts.qbase) : firstQ;
    let anchor = qbase;
    for (let fi = 0; fi < qs.length; fi++) {
      const q = qs[fi];
      for (let j = 0; j < q.length; j++) {
        dq.push(q[j] - (j === 0 ? anchor : q[j - 1]));
      }
      r.push(...rs[fi]);
      if (q.length > 0) anchor = q[0];
    }
  }

  const excIdx: bigint[] = [];
  const excPatch: Array<[bigint, bigint]> = [];
  let prev = 0;
  excFlat.forEach(([idx, patch], k) => {
    excIdx.push(BigInt(k === 0 ? idx : idx - prev));
    prev = idx;
    excPatch.push([patch & 0xffffffffn, patch >> 32n]);
  });

  return {
    version: 1,
    flags: (opts.hasTime ? 1 : 0) | (opts.decimal ? 2 : 0),
    featureCount: BigInt(features.length),
    vertexCount: counts.reduce((s, c) => s + c, 0n),
    e: opts.decimal ? e : undefined,
    unit: opts.hasTime ? unit : undefined,
    qbase,
    counts,
    tags,
    dq,
    r,
    res,
    excIdx,
    excPatch,
  };
}

/** Write section fields to bytes. Optional fields follow `flags`. */
export function serializePathCodec(f: PathCodecFields): Uint8Array {
  const out: number[] = [];
  const u = (v: bigint) => {
    if (v < 0n) throw new Error(`uvarint of negative ${v}`);
    while (v >= 0x80n) {
      out.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    out.push(Number(v));
  };
  const s = (v: bigint) => u(zigzag(v));
  out.push(f.version, f.flags);
  u(f.featureCount);
  u(f.vertexCount);
  const hasTime = (f.flags & 1) !== 0;
  const decimal = (f.flags & 2) !== 0;
  if (decimal) out.push(f.e ?? 7);
  if (hasTime) {
    u(f.unit ?? 1n);
    s(f.qbase ?? 0n);
  }
  for (const c of f.counts) u(c);
  for (const t of f.tags) out.push(t);
  if (hasTime) {
    for (const d of f.dq) s(d);
    for (const r of f.r) u(r);
  }
  for (const v of f.res) s(v);
  if (decimal) {
    u(f.excCount ?? BigInt(f.excIdx.length));
    for (const i of f.excIdx) u(i);
    for (const [lo, hi] of f.excPatch) {
      u(lo);
      u(hi);
    }
  }
  if (f.trailing) out.push(...f.trailing);
  return Uint8Array.from(out);
}

/** Convenience: features → section bytes. */
export function encodePathCodec(
  features: CodecFeatureInput[],
  opts: CodecEncodeOptions,
): Uint8Array {
  return serializePathCodec(buildPathCodecFields(features, opts));
}

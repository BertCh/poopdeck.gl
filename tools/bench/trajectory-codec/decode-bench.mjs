// Decode-cost bench for the per-feature trajectory codec (branch `trajectory`).
//
// The question the size win has to survive: what does decoding a per-feature
// predictor + zigzag-varint stream cost in the reader, against today's
// quantized path (an Int32 world-grid leaf reconstructed through the
// `stt:quant` affine into a fresh Float64Array — `readCoordRun`'s quantized
// branch)? Both produce the same Float64Array of lon/lat plus absolute
// vertex times.
//
//   node decode-bench.mjs <traj.bin from prep.py export> [quant_m=1]
//
// Encoding here mirrors stt:crates/stt-core/examples/trajectory-codec.rs:
// per feature one predictor tag byte (0 delta, 1 const-velocity, 2
// time-scaled velocity), then x/y residuals interleaved, then time deltas.

import { readFileSync } from 'node:fs';

const [path, qArg] = process.argv.slice(2);
const QUANT_M = Number(qArg ?? 1);
const STEP = QUANT_M / 111320;

function load(file) {
  const buf = readFileSync(file);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const nt = Number(dv.getBigUint64(0, true));
  const nv = Number(dv.getBigUint64(8, true));
  const offs = new Array(nt + 1);
  for (let i = 0; i <= nt; i++)
    offs[i] = Number(dv.getBigUint64(16 + i * 8, true));
  const base = 16 + (nt + 1) * 8;
  const lon = new Float64Array(
    buf.buffer.slice(buf.byteOffset + base, buf.byteOffset + base + nv * 8),
  );
  const lat = new Float64Array(
    buf.buffer.slice(
      buf.byteOffset + base + nv * 8,
      buf.byteOffset + base + nv * 16,
    ),
  );
  const t = new BigInt64Array(
    buf.buffer.slice(
      buf.byteOffset + base + nv * 16,
      buf.byteOffset + base + nv * 24,
    ),
  );
  return { nt, nv, offs, lon, lat, t };
}

// ---- encode (build-time side, here only to produce test input) ----------
class Writer {
  constructor(n) {
    this.b = new Uint8Array(n);
    this.n = 0;
  }
  u(v) {
    while (v >= 0x80) {
      this.b[this.n++] = (v & 0x7f) | 0x80;
      v = Math.floor(v / 128);
    }
    this.b[this.n++] = v;
  }
  s(v) {
    this.u(v >= 0 ? v * 2 : -v * 2 - 1);
  }
}

function encode(d) {
  const qx = new Int32Array(d.nv),
    qy = new Int32Array(d.nv),
    tq = new Float64Array(d.nv);
  for (let i = 0; i < d.nv; i++) {
    qx[i] = Math.round((d.lon[i] + 180) / STEP);
    qy[i] = Math.round((d.lat[i] + 90) / STEP);
    tq[i] = Number(d.t[i] / 1000n); // whole seconds in this data
  }
  const w = new Writer(d.nv * 16);
  const resid = (s, e, p, a, out) => {
    let cost = 0;
    for (let i = s; i < e; i++) {
      let px, py;
      if (i === s) {
        px = 0;
        py = 0;
      } else if (i === s + 1 || p === 0) {
        px = qx[i - 1];
        py = qy[i - 1];
      } else {
        const vx = qx[i - 1] - qx[i - 2],
          vy = qy[i - 1] - qy[i - 2];
        if (p === 1) {
          px = qx[i - 1] + vx;
          py = qy[i - 1] + vy;
        } else {
          const dt0 = tq[i - 1] - tq[i - 2],
            dt1 = tq[i] - tq[i - 1];
          const r = dt0 > 0 ? dt1 / dt0 : 1;
          px = qx[i - 1] + Math.round(vx * r);
          py = qy[i - 1] + Math.round(vy * r);
        }
      }
      const rx = qx[i] - px,
        ry = qy[i] - py;
      if (out) {
        out.s(rx);
        out.s(ry);
      } else cost += Math.abs(rx) + Math.abs(ry);
    }
    return cost;
  };
  const featOff = new Uint32Array(d.nt + 1);
  for (let f = 0; f < d.nt; f++) {
    const s = d.offs[f],
      e = d.offs[f + 1];
    let best = 0,
      bc = Infinity;
    for (let p = 0; p < 3; p++) {
      const c = resid(s, e, p);
      if (c < bc) {
        bc = c;
        best = p;
      }
    }
    featOff[f] = w.n;
    w.b[w.n++] = best;
    let prev = 0;
    for (let i = s; i < e; i++) {
      w.s(tq[i] - prev);
      prev = tq[i];
    }
    resid(s, e, best, 0, w);
  }
  featOff[d.nt] = w.n;
  return { bytes: w.b.subarray(0, w.n), featOff, qx, qy, tq };
}

// ---- decode: the reader-side cost ------------------------------------------
function decodeCodec(bytes, offs, nt, nv, outXY, outT) {
  // Single pass, integer-only varint reads (residuals fit in int32).
  let pos = 0;
  for (let f = 0; f < nt; f++) {
    const s = offs[f],
      e = offs[f + 1];
    const p = bytes[pos++];
    let tAcc = 0;
    for (let i = s; i < e; i++) {
      let b = bytes[pos++],
        v = b & 0x7f;
      if (b & 0x80) {
        b = bytes[pos++];
        v |= (b & 0x7f) << 7;
        if (b & 0x80) {
          b = bytes[pos++];
          v |= (b & 0x7f) << 14;
          if (b & 0x80) {
            b = bytes[pos++];
            v |= (b & 0x7f) << 21;
            if (b & 0x80) {
              b = bytes[pos++];
              v += (b & 0x7f) * 268435456;
            }
          }
        }
      }
      tAcc += v & 1 ? -((v + 1) / 2) : v / 2;
      outT[i] = tAcc * 1000;
    }
    let x1 = 0,
      y1 = 0,
      x2 = 0,
      y2 = 0;
    for (let i = s; i < e; i++) {
      let b = bytes[pos++],
        v = b & 0x7f;
      if (b & 0x80) {
        b = bytes[pos++];
        v |= (b & 0x7f) << 7;
        if (b & 0x80) {
          b = bytes[pos++];
          v |= (b & 0x7f) << 14;
          if (b & 0x80) {
            b = bytes[pos++];
            v |= (b & 0x7f) << 21;
            if (b & 0x80) {
              b = bytes[pos++];
              v += (b & 0x7f) * 268435456;
            }
          }
        }
      }
      const rx = v & 1 ? -((v + 1) / 2) : v / 2;
      b = bytes[pos++];
      v = b & 0x7f;
      if (b & 0x80) {
        b = bytes[pos++];
        v |= (b & 0x7f) << 7;
        if (b & 0x80) {
          b = bytes[pos++];
          v |= (b & 0x7f) << 14;
          if (b & 0x80) {
            b = bytes[pos++];
            v |= (b & 0x7f) << 21;
            if (b & 0x80) {
              b = bytes[pos++];
              v += (b & 0x7f) * 268435456;
            }
          }
        }
      }
      const ry = v & 1 ? -((v + 1) / 2) : v / 2;
      let px = x1,
        py = y1;
      if (i === s) {
        px = 0;
        py = 0;
      } else if (i > s + 1 && p !== 0) {
        const vx = x1 - x2,
          vy = y1 - y2;
        if (p === 1) {
          px = x1 + vx;
          py = y1 + vy;
        } else {
          const dt0 = outT[i - 1] - outT[i - 2],
            dt1 = outT[i] - outT[i - 1];
          const r = dt0 > 0 ? dt1 / dt0 : 1;
          px = x1 + Math.round(vx * r);
          py = y1 + Math.round(vy * r);
        }
      }
      const x = px + rx,
        y = py + ry;
      x2 = x1;
      y2 = y1;
      x1 = x;
      y1 = y;
      outXY[i * 2] = -180 + x * STEP;
      outXY[i * 2 + 1] = -90 + y * STEP;
    }
  }
}

function decodeToday(gridXY, vt16, origin, step, outXY, outT) {
  // Today's quantized path: affine over the Int32 leaf; vertex_time as
  // origin + u16 * step.
  for (let i = 0; i < outT.length; i++) {
    outXY[i * 2] = -180 + gridXY[i * 2] * STEP;
    outXY[i * 2 + 1] = -90 + gridXY[i * 2 + 1] * STEP;
    outT[i] = origin + vt16[i] * step;
  }
}

function bench(label, fn, reps = 7) {
  fn();
  const ts = [];
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  ts.sort((a, b) => a - b);
  return ts[reps >> 1];
}

const d = load(path);
const enc = encode(d);
const outXY = new Float64Array(d.nv * 2),
  outT = new Float64Array(d.nv);

// Lossless round-trip check before timing anything.
decodeCodec(enc.bytes, d.offs, d.nt, d.nv, outXY, outT);
let bad = 0;
for (let i = 0; i < d.nv; i++) {
  const ex = -180 + enc.qx[i] * STEP,
    ey = -90 + enc.qy[i] * STEP;
  if (
    outXY[i * 2] !== ex ||
    outXY[i * 2 + 1] !== ey ||
    outT[i] !== enc.tq[i] * 1000
  )
    bad++;
}
if (bad) throw new Error(`round-trip mismatch on ${bad} vertices`);

const grid = new Int32Array(d.nv * 2);
for (let i = 0; i < d.nv; i++) {
  grid[i * 2] = enc.qx[i];
  grid[i * 2 + 1] = enc.qy[i];
}
const vt16 = new Uint16Array(d.nv).map((_, i) => i & 0xffff);

const msCodec = bench('codec', () =>
  decodeCodec(enc.bytes, d.offs, d.nt, d.nv, outXY, outT));
const msToday = bench('today', () =>
  decodeToday(grid, vt16, 0, 1000, outXY, outT));
const ns = (ms) => ((ms * 1e6) / d.nv).toFixed(2);
console.log(
  `${path}: ${d.nt} features, ${d.nv} vertices, stream ${(enc.bytes.length / d.nv).toFixed(2)} B/vtx raw (pre-zstd), round-trip exact`,
);
console.log(
  `  today (i32 affine + u16 time):    ${msToday.toFixed(1)} ms  ${ns(msToday)} ns/vtx`,
);
console.log(
  `  codec (predictor + varint):       ${msCodec.toFixed(1)} ms  ${ns(msCodec)} ns/vtx`,
);
console.log(
  `  extra decode per 1M vertices:     ${(((msCodec - msToday) / d.nv) * 1e6).toFixed(1)} ms`,
);

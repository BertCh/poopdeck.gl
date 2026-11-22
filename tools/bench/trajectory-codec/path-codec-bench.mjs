// Decode cost of the SHIPPED `path-codec` reader (packages/core/src/path-codec.ts,
// via its build in dist/) on real trajectories, against the classic layer
// shapes it replaces. Sibling of decode-bench.mjs, which timed a prototype
// codec; this one times the real decoder and the real `decodeTile`.
//
//   pnpm --filter @poopdeck.gl/core build
//   node path-codec-bench.mjs <traj.bin from prep.py export> [max_vertices=2000000] [quant_m=1]
//
// The trajectories are cut into tile-sized layers (whole features, ~20 k
// vertices each), then each layer is written four ways:
//
//   plain f64   List<FixedSizeList<2, Float64>>, vertex_time List<UInt32> (`vt`, exact ms)
//   plain quant the same with an Int32 world-grid leaf + `stt:quant` affine
//   codec dec   empty CORE lists + PATH_CODEC, DECIMAL (k / 10^e + XOR patches)
//   codec grid  empty CORE lists + PATH_CODEC, world grid (the same Int32 grid)
//
// and timed two ways: the column stage alone (what the codec changes: leaf +
// vertex times to the BinaryFeatures arrays) and the whole `decodeTile` of the
// layer frame. The sections are written by the test-only reference encoder
// (packages/core/test/helpers/path-codec-encoder.ts, loaded under Node's type
// stripping); every codec layer is checked against its plain twin before
// anything is timed.

import { readFileSync } from 'node:fs';
import { decodeTile } from '@poopdeck.gl/core';
import { decodePathCodec } from '../../../packages/core/dist/path-codec.js';
import { encodePathCodec } from '../../../packages/core/test/helpers/path-codec-encoder.ts';
import {
  Field,
  FixedSizeList,
  Float64,
  Int32,
  Int64,
  List,
  RecordBatch,
  Schema,
  Struct,
  Table,
  Uint32,
  Uint64,
  makeData,
  tableToIPC,
} from '../../../packages/core/node_modules/apache-arrow/Arrow.node.mjs';

const [path, maxArg, qArg] = process.argv.slice(2);
const MAX_V = Number(maxArg ?? 2_000_000);
const QUANT_M = Number(qArg ?? 1);
const STEP = QUANT_M / 111320;
const LAYER_V = 20_000;

function load(file) {
  const buf = readFileSync(file);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const nt = Number(dv.getBigUint64(0, true));
  const nv = Number(dv.getBigUint64(8, true));
  const offs = new Array(nt + 1);
  for (let i = 0; i <= nt; i++)
    offs[i] = Number(dv.getBigUint64(16 + i * 8, true));
  const base = 16 + (nt + 1) * 8;
  const f64 = (at, n) =>
    new Float64Array(
      buf.buffer.slice(buf.byteOffset + at, buf.byteOffset + at + n * 8),
    );
  const lon = f64(base, nv);
  const lat = f64(base + nv * 8, nv);
  const t = new BigInt64Array(
    buf.buffer.slice(
      buf.byteOffset + base + nv * 16,
      buf.byteOffset + base + nv * 24,
    ),
  );
  return { nt, nv, offs, lon, lat, t };
}

/** Spec §6's recommended e: smallest of 3..=8 within 2 % of the best exact count. */
function chooseE(values) {
  const exact = [];
  for (let e = 3; e <= 8; e++) {
    const p = 10 ** e;
    let n = 0;
    for (const v of values) if (Math.round(v * p) / p === v) n++;
    exact.push([e, n]);
  }
  const best = Math.max(...exact.map(([, n]) => n));
  if (best === 0) return 7;
  return exact.find(([, n]) => n >= best * 0.98)[0];
}

// ---- layers ----------------------------------------------------------------

function cutLayers(d) {
  const layers = [];
  let f = 0;
  let used = 0;
  while (f < d.nt && used < MAX_V) {
    const feats = [];
    let nv = 0;
    while (f < d.nt && nv < LAYER_V) {
      const s = d.offs[f];
      const e = d.offs[f + 1];
      f++;
      if (e - s < 1) continue;
      const lon = d.lon.subarray(s, e);
      const lat = d.lat.subarray(s, e);
      const t = Array.from(d.t.subarray(s, e), Number);
      feats.push({ lon, lat, t });
      nv += e - s;
    }
    used += nv;
    layers.push({ feats, nv });
  }
  return layers;
}

const linestring = new Map([['ARROW:extension:name', 'geoarrow.linestring']]);

/** One layer's v2 frame, classic or codec, decimal or grid. */
function buildFrame(layer, { codec, decimal, e }) {
  const n = layer.feats.length;
  const offsets = new Int32Array(n + 1);
  layer.feats.forEach((f, i) => (offsets[i + 1] = offsets[i] + f.t.length));
  const vc = offsets[n];
  const leafType = decimal ? new Float64() : new Int32();
  const coordType = new FixedSizeList(2, new Field('xy', leafType, false));
  const geomType = new List(new Field('vertices', coordType, false));
  const geomMeta = new Map(linestring);
  if (!decimal)
    geomMeta.set(
      'stt:quant',
      JSON.stringify({ x0: -180, y0: -90, sx: STEP, sy: STEP }),
    );
  const leaf = decimal
    ? new Float64Array(codec ? 0 : vc * 2)
    : new Int32Array(codec ? 0 : vc * 2);
  const grid = (lonOrLat, axis) =>
    Math.round((lonOrLat + (axis ? 90 : 180)) / STEP);
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const f of layer.feats)
    for (const t of f.t) {
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
  const features = [];
  let w = 0;
  for (const f of layer.feats) {
    const xy = new Array(f.t.length * 2);
    for (let i = 0; i < f.t.length; i++) {
      xy[i * 2] = decimal ? f.lon[i] : grid(f.lon[i], 0);
      xy[i * 2 + 1] = decimal ? f.lat[i] : grid(f.lat[i], 1);
    }
    if (!codec) for (const v of xy) leaf[w++] = v;
    features.push({ xy, t: f.t });
  }
  const useVt = tMax - tMin <= 0xffffffff;
  const vtType = codec || !useVt ? new Int64() : new Uint32();
  const vtList = new List(new Field('item', vtType, false));
  const vtValues = codec
    ? new BigInt64Array(0)
    : useVt
      ? Uint32Array.from(features.flatMap((f) => f.t.map((t) => t - tMin)))
      : BigInt64Array.from(features.flatMap((f) => f.t.map((t) => BigInt(t))));
  const listOffsets = codec ? new Int32Array(n + 1) : offsets;

  const fields = [
    new Field('id', new Uint64(), false),
    new Field('start_time', new Int64(), false),
    new Field('end_time', new Int64(), false),
    new Field('geometry', geomType, false, geomMeta),
    new Field('vertex_time', vtList, false),
  ];
  const children = [
    makeData({
      type: new Uint64(),
      length: n,
      data: BigUint64Array.from(features, (_, i) => BigInt(i)),
    }),
    makeData({
      type: new Int64(),
      length: n,
      data: BigInt64Array.from(features, (f) => BigInt(f.t[0])),
    }),
    makeData({
      type: new Int64(),
      length: n,
      data: BigInt64Array.from(features, (f) => BigInt(f.t[f.t.length - 1])),
    }),
    makeData({
      type: geomType,
      length: n,
      nullCount: 0,
      valueOffsets: listOffsets,
      child: makeData({
        type: coordType,
        length: codec ? 0 : vc,
        nullCount: 0,
        child: makeData({ type: leafType, length: leaf.length, data: leaf }),
      }),
    }),
    makeData({
      type: vtList,
      length: n,
      nullCount: 0,
      // Its own copy: arrow-js 21's IPC writer emits a short body when two
      // columns share one all-zero offsets buffer (odd row counts).
      valueOffsets: listOffsets.slice(),
      child: makeData({
        type: vtType,
        length: vtValues.length,
        data: vtValues,
      }),
    }),
  ];
  const schema = new Schema(fields);
  const ipc = tableToIPC(
    new Table([
      new RecordBatch(
        schema,
        makeData({ type: new Struct(fields), length: n, children }),
      ),
    ]),
    'stream',
  );
  const tileMeta = { t0: tMin };
  if (!codec && useVt) tileMeta.vt = [tMin, 1];
  const section = codec
    ? encodePathCodec(features, { decimal, e, hasTime: true })
    : undefined;
  return { frame: v2Frame(ipc, tileMeta, section), section, vc, n };
}

/** A single-layer, self-contained v2 frame (packed spec §5.2). */
function v2Frame(ipc, tileMeta, section) {
  const dv0 = new DataView(ipc.buffer, ipc.byteOffset, ipc.byteLength);
  const cut = 8 + dv0.getInt32(4, true);
  const sections = [
    [0x01, ipc.subarray(0, cut)],
    [0x02, new TextEncoder().encode(JSON.stringify(tileMeta))],
    [0x03, ipc.subarray(cut)],
  ];
  if (section) sections.push([0x06, section]);
  const name = new TextEncoder().encode('tracks');
  const pad8 = (x) => (x + 7) & ~7;
  let total = pad8(11 + name.length + 5 * sections.length);
  for (const [, b] of sections) total = pad8(total + b.length);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let p = 0;
  dv.setUint16(p, 0xffff, true); // escape
  out[p + 2] = 2; // frame_version
  out[p + 3] = 0; // flags
  dv.setUint16(p + 4, 1, true); // one layer
  dv.setUint16(p + 6, name.length, true);
  p = 8;
  out.set(name, p);
  p += name.length;
  out[p++] = 0; // core: inline schema
  out[p++] = 2; // props: none
  out[p++] = sections.length;
  for (const [tag, b] of sections) {
    out[p++] = tag;
    dv.setUint32(p, b.length, true);
    p += 4;
  }
  p = pad8(p);
  for (const [, b] of sections) {
    out.set(b, p);
    p = pad8(p + b.length);
  }
  return out;
}

// ---- the column stage alone -------------------------------------------------
//
// Mirrors tile.ts: `readCoordRun`'s affine (quantized leaf → Float64Array) and
// `extractVertexTimes`' arms (UInt32 deltas, or the BigInt-free Int64 halves).

function columnsPlainQuant(leaf, vt32, origin, step, timeOffset) {
  const pos = new Float64Array(leaf.length);
  for (let i = 0; i < leaf.length; i += 2) {
    pos[i] = -180 + leaf[i] * STEP;
    pos[i + 1] = -90 + leaf[i + 1] * STEP;
  }
  const out = new Float32Array(vt32.length);
  for (let i = 0; i < vt32.length; i++)
    out[i] = origin + vt32[i] * step - timeOffset;
  return [pos, out];
}

function int64Times(times, timeOffset) {
  const halves = new Uint32Array(
    times.buffer,
    times.byteOffset,
    times.length * 2,
  );
  const out = new Float32Array(times.length);
  for (let i = 0; i < times.length; i++)
    out[i] = (halves[i * 2 + 1] | 0) * 4294967296 + halves[i * 2] - timeOffset;
  return out;
}

function columnsCodec(section, n, decimal, timeOffset) {
  const d = decodePathCodec(
    section,
    { featureCount: n, hasTime: true, decimal },
    'bench',
  );
  let pos = d.coords;
  if (!decimal) {
    pos = new Float64Array(d.coords.length);
    const leaf = d.coords;
    for (let i = 0; i < leaf.length; i += 2) {
      pos[i] = -180 + leaf[i] * STEP;
      pos[i + 1] = -90 + leaf[i + 1] * STEP;
    }
  }
  return [pos, int64Times(d.times, timeOffset)];
}

function bench(fn, reps = 9) {
  fn();
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

// ---- run --------------------------------------------------------------------

const d = load(path);
const layers = cutLayers(d);
const sample = [];
for (const l of layers)
  for (const f of l.feats)
    for (let i = 0; i < f.t.length; i++) sample.push(f.lon[i], f.lat[i]);
const e = chooseE(sample.length > 400_000 ? sample.slice(0, 400_000) : sample);

const tileId = { z: 0, x: 0, y: 0, t: 0 };
const built = layers.map((l) => ({
  f64: buildFrame(l, { codec: false, decimal: true }),
  quant: buildFrame(l, { codec: false, decimal: false }),
  dec: buildFrame(l, { codec: true, decimal: true, e }),
  grid: buildFrame(l, { codec: true, decimal: false }),
}));
const V = built.reduce((s, b) => s + b.f64.vc, 0);

// Correctness before timing: each codec layer decodes to its plain twin.
const bitsOf = (a) => new BigUint64Array(a.buffer, a.byteOffset, a.length);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
for (const b of built) {
  const [pf, pq, cd, cg] = [b.f64, b.quant, b.dec, b.grid].map(
    (x) => decodeTile(x.frame, tileId).layers[0].features,
  );
  if (!same(bitsOf(cd.positions), bitsOf(pf.positions)))
    throw new Error('decimal positions differ');
  if (!same(bitsOf(cg.positions), bitsOf(pq.positions)))
    throw new Error('grid positions differ');
  for (const x of [cd, cg, pq])
    if (!same(x.vertexTimestamps, pf.vertexTimestamps))
      throw new Error('vertex times differ');
}

const bytes = (k) =>
  built.reduce(
    (s, b) => s + (k === 'dec' || k === 'grid' ? b[k].section.length : 0),
    0,
  );
console.log(
  `${path}: ${layers.length} layers, ${V} vertices (${(V / layers.length) | 0}/layer), e=${e}, ` +
    `section ${(bytes('dec') / V).toFixed(2)} B/vtx decimal, ${(bytes('grid') / V).toFixed(2)} B/vtx grid (pre-zstd); round trip exact`,
);

// Column stage. Inputs prepared outside the timed region.
const quantCols = built.map((b) => {
  const t = decodeTile(b.quant.frame, tileId).layers[0].arrowTable;
  const leaf = t.getChild('geometry').data[0].children[0].children[0].values;
  const vt = t.getChild('vertex_time').data[0].children[0].values;
  return {
    leaf,
    vt,
    origin: Number(t.schema.metadata.get('stt:vertex_time_origin_ms') ?? 0),
    t0: Number(t.schema.metadata.get('stt:time_offset_ms') ?? 0),
  };
});
const tOffsets = quantCols.map((q) => q.t0);
const ns = (ms) => ((ms * 1e6) / V).toFixed(2);
const col = {
  quant: bench(() => {
    for (const q of quantCols)
      columnsPlainQuant(q.leaf, q.vt, q.origin, 1, q.t0);
  }),
  dec: bench(() => {
    built.forEach((b, i) =>
      columnsCodec(b.dec.section, b.dec.n, true, tOffsets[i]),
    );
  }),
  grid: bench(() => {
    built.forEach((b, i) =>
      columnsCodec(b.grid.section, b.grid.n, false, tOffsets[i]),
    );
  }),
  decodeOnlyDec: bench(() => {
    for (const b of built)
      decodePathCodec(
        b.dec.section,
        { featureCount: b.dec.n, hasTime: true, decimal: true },
        'bench',
      );
  }),
  decodeOnlyGrid: bench(() => {
    for (const b of built)
      decodePathCodec(
        b.grid.section,
        { featureCount: b.grid.n, hasTime: true, decimal: false },
        'bench',
      );
  }),
};
const tile = {};
for (const k of ['f64', 'quant', 'dec', 'grid']) {
  tile[k] = bench(() => {
    for (const b of built) decodeTile(b[k].frame, tileId);
  });
}
console.log(
  '  column stage (leaf + vertex times → BinaryFeatures arrays), ns/vertex:',
);
console.log(`    plain quant  (i32 affine + u32 vt)       ${ns(col.quant)}`);
console.log(
  `    codec decimal                            ${ns(col.dec)}   (decodePathCodec alone ${ns(col.decodeOnlyDec)})`,
);
console.log(
  `    codec grid   (+ the same affine)         ${ns(col.grid)}   (decodePathCodec alone ${ns(col.decodeOnlyGrid)})`,
);
console.log('  whole decodeTile of the layer frame, ns/vertex:');
console.log(`    plain f64    ${ns(tile.f64)}`);
console.log(`    plain quant  ${ns(tile.quant)}`);
console.log(
  `    codec dec    ${ns(tile.dec)}   (${(tile.dec / tile.quant).toFixed(2)}x plain quant)`,
);
console.log(
  `    codec grid   ${ns(tile.grid)}   (${(tile.grid / tile.quant).toFixed(2)}x plain quant)`,
);

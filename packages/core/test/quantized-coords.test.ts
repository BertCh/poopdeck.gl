/**
 * Coordinate quantization (opt-in `stt-build --quantize-coords`): the geometry
 * `xy` leaf ships as fixed-point `i32` grid indices plus a reconstruction
 * affine in the geometry field metadata (`stt:quant`), instead of Float64
 * lon/lat. This pins that the TS reader detects the affine and reconstructs
 * Float64 positions, so every downstream deck.gl layer is unaffected.
 *
 * The encoder side (Rust `arrow_tile.rs`) is round-tripped in its own unit
 * tests; here we build the exact wire shape it emits and prove the decoder
 * inverts it within the grid precision.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Field,
  FixedSizeList,
  Int32,
  Int64,
  List,
  Schema,
  Struct,
  Uint64,
  makeData,
} from 'apache-arrow';
import { decodeTile, _resetQuantWarnings } from '../src/tile';
import { GeometryType, type TileId } from '../src/types';
import { frameLayer } from './helpers/fixtures';

const tileId: TileId = { z: 0, x: 0, y: 0, t: 0 };

// The malformed-meta warning dedups on a module-level Set; reset it so the
// "warns ONCE" case is isolated from any earlier case tripping the same key.
beforeEach(() => {
  _resetQuantWarnings();
});

interface Affine {
  x0: number;
  y0: number;
  sx: number;
  sy: number;
}

/** Wrap a single layer's struct data into the STT layer-frame payload. */

function commonColumns(featureCount: number) {
  const ids = makeData({
    type: new Uint64(),
    length: featureCount,
    data: BigUint64Array.from({ length: featureCount }, (_, i) => BigInt(i + 1)),
  });
  const startTime = makeData({
    type: new Int64(),
    length: featureCount,
    data: BigInt64Array.from({ length: featureCount }, () => 0n),
  });
  const endTime = makeData({
    type: new Int64(),
    length: featureCount,
    data: BigInt64Array.from({ length: featureCount }, () => 1000n),
  });
  return { ids, startTime, endTime };
}

function geomMeta(ext: string, affine: Affine | string): Map<string, string> {
  return new Map<string, string>([
    ['ARROW:extension:name', ext],
    ['stt:quant', typeof affine === 'string' ? affine : JSON.stringify(affine)],
  ]);
}

/** Build a quantized Point tile: FixedSizeList<Int32,2> + affine. */
function buildQuantizedPointTile(qcoords: number[], affine: Affine | string): Uint8Array {
  const featureCount = qcoords.length / 2;
  const coordValues = makeData({ type: new Int32(), data: Int32Array.from(qcoords) });
  const geomData = makeData({
    type: new FixedSizeList(2, new Field('xy', new Int32(), false)),
    length: featureCount,
    nullCount: 0,
    child: coordValues,
  });
  const { ids, startTime, endTime } = commonColumns(featureCount);
  const fields: Field[] = [
    new Field('id', new Uint64(), false),
    new Field('start_time', new Int64(), false),
    new Field('end_time', new Int64(), false),
    new Field('geometry', geomData.type, false, geomMeta('geoarrow.point', affine)),
  ];
  const schema = new Schema(fields, new Map([['stt:geometry', 'geoarrow.point']]));
  const structData = makeData({
    type: new Struct(fields),
    length: featureCount,
    nullCount: 0,
    children: [ids, startTime, endTime, geomData],
  });
  return frameLayer('pts', schema, structData);
}

/** Build a quantized LineString tile: List<FixedSizeList<Int32,2>> + affine. */
function buildQuantizedLineTile(features: number[][], affine: Affine): Uint8Array {
  const featureCount = features.length;
  const flat: number[] = [];
  const offsets: number[] = [0];
  for (const f of features) {
    flat.push(...f);
    offsets.push(offsets[offsets.length - 1] + f.length / 2);
  }
  const totalVerts = offsets[offsets.length - 1];
  const coordValues = makeData({ type: new Int32(), data: Int32Array.from(flat) });
  const coordList = makeData({
    type: new FixedSizeList(2, new Field('xy', new Int32(), false)),
    length: totalVerts,
    nullCount: 0,
    child: coordValues,
  });
  const geomData = makeData({
    type: new List(new Field('vertices', coordList.type, false)),
    length: featureCount,
    nullCount: 0,
    valueOffsets: Int32Array.from(offsets),
    child: coordList,
  });
  const { ids, startTime, endTime } = commonColumns(featureCount);
  const fields: Field[] = [
    new Field('id', new Uint64(), false),
    new Field('start_time', new Int64(), false),
    new Field('end_time', new Int64(), false),
    new Field('geometry', geomData.type, false, geomMeta('geoarrow.linestring', affine)),
  ];
  const schema = new Schema(fields, new Map([['stt:geometry', 'geoarrow.linestring']]));
  const structData = makeData({
    type: new Struct(fields),
    length: featureCount,
    nullCount: 0,
    children: [ids, startTime, endTime, geomData],
  });
  return frameLayer('tracks', schema, structData);
}

describe('coordinate quantization decode', () => {
  const affine: Affine = { x0: -122.0, y0: 37.0, sx: 1e-4, sy: 2e-4 };
  const deq = (q: number, base: number, step: number) => base + q * step;

  it('reconstructs Float64 lon/lat for quantized points', () => {
    const q = [10, 20, 300, 400, 0, 0];
    const tile = decodeTile(buildQuantizedPointTile(q, affine), tileId);
    const f = tile.layers[0].features;
    expect(f.geometryType).toBe(GeometryType.Point);
    expect(f.featureCount).toBe(3);
    expect(f.positions).toBeInstanceOf(Float64Array);
    for (let i = 0; i < q.length; i += 2) {
      expect(f.positions[i]).toBeCloseTo(deq(q[i], affine.x0, affine.sx), 9);
      expect(f.positions[i + 1]).toBeCloseTo(deq(q[i + 1], affine.y0, affine.sy), 9);
    }
  });

  it('reconstructs quantized linestrings with correct startIndices', () => {
    const features = [
      [0, 0, 100, 50, 200, 100],
      [9000, 8000, 9001, 8002],
    ];
    const tile = decodeTile(buildQuantizedLineTile(features, affine), tileId);
    const f = tile.layers[0].features;
    expect(f.geometryType).toBe(GeometryType.LineString);
    expect(f.featureCount).toBe(2);
    expect(f.startIndices).toEqual(new Uint32Array([0, 3, 5]));
    const flat = features.flat();
    for (let i = 0; i < flat.length; i += 2) {
      expect(f.positions[i]).toBeCloseTo(deq(flat[i], affine.x0, affine.sx), 9);
      expect(f.positions[i + 1]).toBeCloseTo(deq(flat[i + 1], affine.y0, affine.sy), 9);
    }
  });

  it('warns ONCE on a malformed stt:quant affine, then falls back to raw coords', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const q = [10, 20];
      const decode = () => decodeTile(buildQuantizedPointTile(q, '{not json'), tileId);
      const f = decode().layers[0].features;
      // Fallback: the leaf ships through as raw fixed-point grid indices.
      expect(Array.from(f.positions)).toEqual(q);
      // A corrupt archive decodes many tiles — the warning must not repeat.
      decode();
      const quantWarns = warn.mock.calls.filter((c) => String(c[0]).includes('stt:quant'));
      expect(quantWarns).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

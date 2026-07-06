/**
 * Numeric-attribute quantization (opt-in `stt-build --quantize-attr name=prec`):
 * a numeric property column (e.g. LiDAR `z` elevation) ships as fixed-point
 * integers (`UInt16`/`Int32`) plus a reconstruction affine in the property
 * field metadata (`stt:qa` = `{o,s}`), instead of raw Float64. This pins that
 * the TS reader detects the affine and reconstructs `value = o + q*s` into the
 * `numericProps` Float32 the renderer consumes, so a quantized `z` elevates
 * points exactly as a Float64 `z` did.
 *
 * The encoder side (Rust `arrow_tile.rs::build_quantized_numeric`) is
 * round-tripped in its own unit test; here we build the exact wire shape it
 * emits and prove the decoder inverts it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Field,
  FixedSizeList,
  Float64,
  Int64,
  Schema,
  Struct,
  Uint16,
  Uint64,
  makeData,
} from 'apache-arrow';
import { decodeTile, _resetQuantWarnings } from '../src/tile';
import { type TileId } from '../src/types';
import { frameLayer } from './helpers/fixtures';

const tileId: TileId = { z: 0, x: 0, y: 0, t: 0 };

// The malformed-meta warning dedups on a module-level Set; reset it so the
// "warns ONCE" case is isolated from any earlier case tripping the same key.
beforeEach(() => {
  _resetQuantWarnings();
});

/** Wrap a single layer's struct data into the STT layer-frame payload. */

/** Build a Float64-geometry Point tile carrying a quantized UInt16 `z` column. */
function buildPointTileWithQuantZ(
  coords: number[],
  zq: number[],
  o: number,
  s: number,
  qaRaw?: string,
): Uint8Array {
  const featureCount = coords.length / 2;
  const coordValues = makeData({ type: new Float64(), data: Float64Array.from(coords) });
  const geomData = makeData({
    type: new FixedSizeList(2, new Field('xy', new Float64(), false)),
    length: featureCount,
    nullCount: 0,
    child: coordValues,
  });
  const ids = makeData({
    type: new Uint64(),
    length: featureCount,
    data: BigUint64Array.from({ length: featureCount }, (_, i) => BigInt(i)),
  });
  const startTime = makeData({
    type: new Int64(),
    length: featureCount,
    data: BigInt64Array.from({ length: featureCount }, () => 0n),
  });
  const endTime = makeData({
    type: new Int64(),
    length: featureCount,
    data: BigInt64Array.from({ length: featureCount }, () => 1n),
  });
  const zData = makeData({
    type: new Uint16(),
    length: featureCount,
    nullCount: 0,
    data: Uint16Array.from(zq),
  });
  const fields: Field[] = [
    new Field('id', new Uint64(), false),
    new Field('start_time', new Int64(), false),
    new Field('end_time', new Int64(), false),
    new Field(
      'geometry',
      geomData.type,
      false,
      new Map([['ARROW:extension:name', 'geoarrow.point']]),
    ),
    new Field('z', new Uint16(), true, new Map([['stt:qa', qaRaw ?? JSON.stringify({ o, s })]])),
  ];
  const schema = new Schema(fields, new Map([['stt:geometry', 'geoarrow.point']]));
  const structData = makeData({
    type: new Struct(fields),
    length: featureCount,
    nullCount: 0,
    children: [ids, startTime, endTime, geomData, zData],
  });
  return frameLayer('pts', schema, structData);
}

describe('numeric attribute quantization decode', () => {
  it('reconstructs Float32 z from a quantized UInt16 column + stt:qa affine', () => {
    const o = -2.4;
    const s = 0.05;
    // Exact grid points (o + k*s) so reconstruction is lossless to compare.
    const real = [-2.4, 1.05, 15.9, 40.0];
    const zq = real.map((v) => Math.round((v - o) / s));
    const coords = [0, 0, 1, 1, 2, 2, 3, 3];

    const tile = decodeTile(buildPointTileWithQuantZ(coords, zq, o, s), tileId);
    const f = tile.layers[0].features;
    expect(f.featureCount).toBe(4);
    expect(f.numericProps.z).toBeInstanceOf(Float32Array);
    for (let i = 0; i < real.length; i++) {
      expect(f.numericProps.z[i]).toBeCloseTo(real[i], 5);
    }
  });

  it('warns ONCE on a malformed stt:qa affine, then falls back to raw ints', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const zq = [3, 7, 11];
      const coords = [0, 0, 1, 1, 2, 2];
      const decode = () =>
        decodeTile(buildPointTileWithQuantZ(coords, zq, 0, 1, '{not json'), tileId);
      const f = decode().layers[0].features;
      // Fallback: identity affine (o=0, s=1) — raw fixed-point values.
      expect(Array.from(f.numericProps.z)).toEqual(zq);
      // A corrupt archive decodes many tiles — the warning must not repeat.
      decode();
      const qaWarns = warn.mock.calls.filter((c) => String(c[0]).includes('stt:qa'));
      expect(qaWarns).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * 3D point geometry (`stt-build --point-elevation-column`): a point cloud folds
 * its altitude into the geometry's 3rd coordinate (`FixedSizeList<_,3>`) so the
 * renderer binds 3D positions ZERO-COPY — no per-point pad-to-3D on the main
 * thread. The decoder must report `positionDimensions: 3` and lay positions out
 * as `[lon,lat,alt, …]`, dequantizing the z axis with the affine's `z0`/`sz`.
 *
 * The encoder side is round-tripped in `arrow_tile.rs`; here we build the exact
 * wire shape it emits (both Float64 and quantized Int32) and prove the decoder
 * inverts it.
 */

import { describe, it, expect } from 'vitest';
import {
  Field,
  FixedSizeList,
  Float64,
  Int32,
  Int64,
  Schema,
  Struct,
  Uint64,
  makeData,
} from 'apache-arrow';
import { decodeTile } from '../src/tile';
import { type TileId } from '../src/types';
import { frameLayer } from './helpers/fixtures';

const tileId: TileId = { z: 0, x: 0, y: 0, t: 0 };


function buildPointTile(
  coords3: number[], // [lon,lat,alt, …] OR i32 grid indices
  quant: { x0: number; y0: number; sx: number; sy: number; z0: number; sz: number } | null,
): Uint8Array {
  const featureCount = coords3.length / 3;
  const leafType = quant ? new Int32() : new Float64();
  const coordChild = quant
    ? makeData({ type: new Int32(), data: Int32Array.from(coords3) })
    : makeData({ type: new Float64(), data: Float64Array.from(coords3) });
  const geomData = makeData({
    type: new FixedSizeList(3, new Field('xyz', leafType, false)),
    length: featureCount,
    nullCount: 0,
    child: coordChild,
  });
  const ids = makeData({
    type: new Uint64(),
    length: featureCount,
    data: BigUint64Array.from({ length: featureCount }, (_, i) => BigInt(i)),
  });
  const t = (v: bigint) =>
    makeData({ type: new Int64(), length: featureCount, data: BigInt64Array.from({ length: featureCount }, () => v) });
  const geomMeta = new Map<string, string>([['ARROW:extension:name', 'geoarrow.point']]);
  if (quant) geomMeta.set('stt:quant', JSON.stringify(quant));
  const fields: Field[] = [
    new Field('id', new Uint64(), false),
    new Field('start_time', new Int64(), false),
    new Field('end_time', new Int64(), false),
    new Field('geometry', geomData.type, false, geomMeta),
  ];
  const schema = new Schema(fields, new Map([['stt:geometry', 'geoarrow.point']]));
  const structData = makeData({
    type: new Struct(fields),
    length: featureCount,
    nullCount: 0,
    children: [ids, t(0n), t(1n), geomData],
  });
  return frameLayer('cloud', schema, structData);
}

describe('3D point geometry decode', () => {
  it('Float64 3D points decode zero-copy with positionDimensions 3', () => {
    const coords = [-122.4, 37.7, 3.5, -122.5, 37.8, 9.0];
    const tile = decodeTile(buildPointTile(coords, null), tileId);
    const f = tile.layers[0].features;
    expect(f.featureCount).toBe(2);
    expect(f.positionDimensions).toBe(3);
    expect(Array.from(f.positions)).toEqual(coords);
    // Zero-copy: the positions are a view, not a re-packed copy.
    expect(f.positions.length).toBe(6);
  });

  it('quantized Int32 3D points reconstruct lon/lat/alt via the z affine', () => {
    const quant = { x0: -180, y0: -90, sx: 1e-6, sy: 1e-6, z0: 0, sz: 0.05 };
    // Exact grid points so reconstruction is lossless to compare.
    const real = [-122.4, 37.7, 5.0, -122.5, 37.8, 12.5];
    const grid: number[] = [];
    for (let i = 0; i < real.length; i += 3) {
      grid.push(Math.round((real[i] - quant.x0) / quant.sx));
      grid.push(Math.round((real[i + 1] - quant.y0) / quant.sy));
      grid.push(Math.round((real[i + 2] - quant.z0) / quant.sz));
    }
    const tile = decodeTile(buildPointTile(grid, quant), tileId);
    const f = tile.layers[0].features;
    expect(f.positionDimensions).toBe(3);
    expect(f.positions[2]).toBeCloseTo(5.0, 6); // feature 0 alt
    expect(f.positions[5]).toBeCloseTo(12.5, 6); // feature 1 alt
    expect(f.positions[0]).toBeCloseTo(-122.4, 4);
  });
});

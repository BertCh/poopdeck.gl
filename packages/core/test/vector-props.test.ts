/**
 * Interleaved vector property columns (`stt-build --vector-group`): the Rust
 * encoder fuses several scalar columns into one `FixedSizeList<Float32|UInt8, N>`
 * (e.g. a `[qx,qy,qz,qw]` surfel quaternion, an `[r,g,b,a]` colour) so the
 * renderer binds the contiguous child buffer to a deck.gl instanced attribute
 * with NO per-point re-interleave on the main thread.
 *
 * This pins that the TS decoder surfaces such a column on `features.vectorProps`
 * **zero-copy**: the `value` typed array is the row-major child run (feature `i`
 * occupies `[i*size, (i+1)*size)`) with the right element type (Float32 vs
 * Uint8). The encoder side is round-tripped in `arrow_tile.rs`; here we build the
 * exact wire shape it emits and prove the decoder reads it back.
 */

import { describe, it, expect } from 'vitest';
import {
  Field,
  FixedSizeList,
  Float32,
  Float64,
  Int64,
  Schema,
  Struct,
  Uint8,
  Uint64,
  makeData,
} from 'apache-arrow';
import { decodeTile, getFeatureProperties } from '../src/tile';
import { type TileId } from '../src/types';
import { frameLayer } from './helpers/fixtures';

const tileId: TileId = { z: 0, x: 0, y: 0, t: 0 };

/** Point tile carrying a Float32 `quat` (size 4) + UInt8 `rgba` (size 4) FSL. */
function buildSurfelTile(
  coords: number[],
  quat: number[],
  rgba: number[],
): Uint8Array {
  const featureCount = coords.length / 2;
  const geomData = makeData({
    type: new FixedSizeList(2, new Field('xy', new Float64(), false)),
    length: featureCount,
    nullCount: 0,
    child: makeData({ type: new Float64(), data: Float64Array.from(coords) }),
  });
  const ids = makeData({
    type: new Uint64(),
    length: featureCount,
    data: BigUint64Array.from({ length: featureCount }, (_, i) =>
      BigInt(i + 1),
    ),
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
  const quatData = makeData({
    type: new FixedSizeList(4, new Field('item', new Float32(), false)),
    length: featureCount,
    nullCount: 0,
    child: makeData({ type: new Float32(), data: Float32Array.from(quat) }),
  });
  const rgbaData = makeData({
    type: new FixedSizeList(4, new Field('item', new Uint8(), false)),
    length: featureCount,
    nullCount: 0,
    child: makeData({ type: new Uint8(), data: Uint8Array.from(rgba) }),
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
    new Field('surfel_quat', quatData.type, true),
    new Field('surfel_rgba', rgbaData.type, true),
  ];
  const schema = new Schema(
    fields,
    new Map([['stt:geometry', 'geoarrow.point']]),
  );
  const structData = makeData({
    type: new Struct(fields),
    length: featureCount,
    nullCount: 0,
    children: [ids, startTime, endTime, geomData, quatData, rgbaData],
  });
  return frameLayer('surfels', schema, structData);
}

describe('vector property decode', () => {
  const coords = [0, 0, 1, 1];
  const quat = [0, 0, 0, 1, 0.5, 0.5, 0.5, 0.5];
  const rgba = [255, 0, 0, 128, 0, 255, 0, 255];

  it('surfaces FixedSizeList columns on vectorProps with element type + size', () => {
    const tile = decodeTile(buildSurfelTile(coords, quat, rgba), tileId);
    const f = tile.layers[0].features;
    expect(f.featureCount).toBe(2);

    const q = f.vectorProps?.surfel_quat;
    expect(q?.size).toBe(4);
    expect(q?.value).toBeInstanceOf(Float32Array);
    expect(Array.from(q!.value)).toEqual(quat);

    const c = f.vectorProps?.surfel_rgba;
    expect(c?.size).toBe(4);
    expect(c?.value).toBeInstanceOf(Uint8Array);
    expect(Array.from(c!.value)).toEqual(rgba);

    // Vector columns must NOT leak into numericProps.
    expect(f.numericProps.surfel_quat).toBeUndefined();
  });

  it('picking reconstructs the per-feature component slice', () => {
    const tile = decodeTile(buildSurfelTile(coords, quat, rgba), tileId);
    const props = getFeatureProperties(tile.layers[0].features, 1);
    expect(props?.surfel_quat).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(props?.surfel_rgba).toEqual([0, 255, 0, 255]);
  });
});

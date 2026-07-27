/**
 * `BinaryFeatures.featureIds` — the masked low-32 mirror of the archive's
 * UInt64 `id` column, and its laziness.
 *
 * Two things are pinned here:
 *
 *  1. **Masking.** The mirror must be `id & 0xffffffff`. The natural
 *     `Number(raw[i])` rounds the u64 to the nearest f64 BEFORE the
 *     `Uint32Array` store takes it mod 2³², so above 2⁵³ the stored low half
 *     is not a truncation but garbage — an H3 r7 cell came back off by one,
 *     an H3 r15 cell off by 37, and a Quadbin cell whose low half is all-ones
 *     came back as 0. The vectors below are exactly those three cases.
 *
 *  2. **Laziness.** The mirror has no reader on the render path, so it is
 *     built on first access rather than during decode. That has to be
 *     invisible: the field must still read as a `Uint32Array`, survive a
 *     structured clone (the worker→main hand-off), and stay assignable.
 *
 * Arrow IPC is fabricated in TS so the test runs without the Rust toolchain,
 * the same approach as `polygon-ring-indices.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  Field,
  FixedSizeList,
  Float64,
  Int64,
  RecordBatch,
  Schema,
  Struct,
  Table,
  Uint64,
  makeData,
  tableToIPC,
} from 'apache-arrow';

import { decodeTile, getFeatureProperties } from '../src/tile';
import { estimateTileSize } from '../src/archive';
import { forEachBufferView } from '../src/tile-transferables';
import { frameFromIpc } from './helpers/fixtures';
import type { TileId } from '../src/types';

/**
 * The three ids whose low halves `Number(bigint)` corrupts, with the answer
 * the mask must produce. Verified against the raw u64 bit patterns:
 *   0x872830828ffffff  → low = 0x28ffffff = 687865855  (was 687865856)
 *   0x8f2830828052d25  → low = 0x8052d25  = 671427877  (was 671427840)
 *   0x4CFFFFFFFFFFFFFF → low = 0xffffffff = 4294967295 (was 0)
 */
const ID_VECTORS: Array<{ id: bigint; low: number; what: string }> = [
  { id: 0x872830828ffffffn, low: 687865855, what: 'H3 res-7 cell' },
  { id: 0x8f2830828052d25n, low: 671427877, what: 'H3 res-15 cell' },
  { id: 0x4cffffffffffffffn, low: 4294967295, what: 'Quadbin cell' },
];

const tileId: TileId = { z: 0, x: 0, y: 0, t: 0 };

/** A point tile whose `id` column carries `ids` verbatim as UInt64. */
function buildPointTile(ids: bigint[]): Uint8Array {
  const n = ids.length;
  const coords = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    coords[i * 2] = -122.4 + i * 0.01;
    coords[i * 2 + 1] = 37.7;
  }
  const coordValues = makeData({ type: new Float64(), data: coords });
  const geomData = makeData({
    type: new FixedSizeList(2, new Field('xy', new Float64(), false)),
    length: n,
    nullCount: 0,
    child: coordValues,
  });

  const idData = makeData({
    type: new Uint64(),
    length: n,
    data: new BigUint64Array(ids),
  });
  const startTime = makeData({
    type: new Int64(),
    length: n,
    data: new BigInt64Array(n).fill(0n),
  });
  const endTime = makeData({
    type: new Int64(),
    length: n,
    data: new BigInt64Array(n).fill(1000n),
  });

  const fields: Field[] = [
    new Field('id', new Uint64(), false),
    new Field('start_time', new Int64(), false),
    new Field('end_time', new Int64(), false),
    new Field(
      'geometry',
      geomData.type,
      false,
      new Map<string, string>([['ARROW:extension:name', 'geoarrow.point']]),
    ),
  ];
  const schema = new Schema(
    fields,
    new Map<string, string>([
      ['stt:layer', 'cells'],
      ['stt:geometry', 'geoarrow.point'],
    ]),
  );
  const structData = makeData({
    type: new Struct(fields),
    length: n,
    nullCount: 0,
    children: [idData, startTime, endTime, geomData],
  });
  const ipc = tableToIPC(new Table([new RecordBatch(schema, structData)]));
  return frameFromIpc('cells', ipc);
}

const decodeIds = (ids: bigint[]) =>
  decodeTile(buildPointTile(ids), tileId).layers[0].features;

describe('featureIds: masked low-32 mirror of the u64 id column', () => {
  it('stores the TRUE low 32 bits for ids that Number(bigint) corrupts', () => {
    const f = decodeIds(ID_VECTORS.map((v) => v.id));
    expect(Array.from(f.featureIds)).toEqual(ID_VECTORS.map((v) => v.low));
  });

  it.each(ID_VECTORS)(
    'masks $what (0x$id) to $low rather than rounding through f64',
    ({ id, low }) => {
      const f = decodeIds([id]);
      expect(f.featureIds[0]).toBe(low);
      // The bug this pins: `Number(id)` rounds to the nearest f64 first, so
      // the naive mirror differs from the true low half.
      expect(f.featureIds[0]).not.toBe(new Uint32Array([Number(id)])[0]);
    },
  );

  it('keeps the full u64 column verbatim on featureIds64', () => {
    const f = decodeIds(ID_VECTORS.map((v) => v.id));
    expect(f.featureIds64).toBeInstanceOf(BigUint64Array);
    expect(Array.from(f.featureIds64!)).toEqual(ID_VECTORS.map((v) => v.id));
  });

  it('leaves small ids (< 2^32) exactly as written', () => {
    const f = decodeIds([0n, 1n, 4294967295n, 100n]);
    expect(Array.from(f.featureIds)).toEqual([0, 1, 4294967295, 100]);
  });

  it('masks — not truncates-to-max — ids just above the u32 ceiling', () => {
    // 2^32 → 0, 2^32 + 5 → 5. A saturating or clamping conversion would give
    // 4294967295 for both.
    const f = decodeIds([4294967296n, 4294967301n]);
    expect(Array.from(f.featureIds)).toEqual([0, 5]);
  });

  it('getFeatureProperties reports the exact u64 id, never the mirror', () => {
    const f = decodeIds(ID_VECTORS.map((v) => v.id));
    for (let i = 0; i < ID_VECTORS.length; i++) {
      expect(getFeatureProperties(f, i)!.id).toBe(ID_VECTORS[i].id);
    }
  });
});

describe('featureIds: lazy materialisation', () => {
  it('is an accessor until first read, then a plain data property', () => {
    const f = decodeIds(ID_VECTORS.map((v) => v.id));
    const before = Object.getOwnPropertyDescriptor(f, 'featureIds')!;
    expect(typeof before.get).toBe('function');
    expect(before.value).toBeUndefined();

    const ids = f.featureIds; // force

    const after = Object.getOwnPropertyDescriptor(f, 'featureIds')!;
    expect(after.get).toBeUndefined();
    expect(after.value).toBe(ids);
    // Memoised: the second read is the same array, not a rebuild.
    expect(f.featureIds).toBe(ids);
  });

  it('reads, spreads and enumerates exactly like a data property', () => {
    const f = decodeIds([7n, 8n]);
    expect(Object.keys(f)).toContain('featureIds');
    expect(f.featureIds).toBeInstanceOf(Uint32Array);
    expect(f.featureIds.length).toBe(f.featureCount);
    expect(Array.from({ ...f }.featureIds)).toEqual([7, 8]);
  });

  it('stays assignable (an accessor without a setter throws in strict mode)', () => {
    const f = decodeIds([7n, 8n]);
    const replacement = new Uint32Array([70, 80]);
    expect(() => {
      f.featureIds = replacement;
    }).not.toThrow();
    expect(f.featureIds).toBe(replacement);
  });

  it('survives the worker hand-off: structuredClone carries the values', () => {
    // The worker calls collectTransferables (which walks featureIds) and then
    // postMessage structured-clones the tile. Both legs must see real values.
    const f = decodeIds(ID_VECTORS.map((v) => v.id));
    const clone = structuredClone(f);
    expect(clone.featureIds).toBeInstanceOf(Uint32Array);
    expect(Array.from(clone.featureIds)).toEqual(ID_VECTORS.map((v) => v.low));
    expect(Array.from(clone.featureIds64!)).toEqual(
      ID_VECTORS.map((v) => v.id),
    );
  });

  it('is reachable through the shared buffer enumeration', () => {
    // forEachBufferView is the single list backing both collectTransferables
    // and estimateTileSize — the mirror must not go missing from it.
    const f = decodeIds([1n, 2n, 3n]);
    const views: ArrayBufferView[] = [];
    forEachBufferView(f, (v) => views.push(v));
    expect(views).toContain(f.featureIds);
  });

  it('does not force the mirror when only featureIds64 is read', () => {
    // A summary-tier picking hit resolves entirely from featureIds64, so the
    // mirror must still be unbuilt afterwards.
    const f = decodeIds(ID_VECTORS.map((v) => v.id));
    expect(getFeatureProperties(f, 0)!.id).toBe(ID_VECTORS[0].id);
    expect(typeof Object.getOwnPropertyDescriptor(f, 'featureIds')!.get).toBe(
      'function',
    );
  });

  it('accounts for the mirror in estimateTileSize once it exists', () => {
    // estimateTileSize walks featureIds (forcing it), so the byte estimate is
    // unchanged from the eager decoder — no cache under-count.
    const tile = decodeTile(buildPointTile([1n, 2n, 3n]), tileId);
    const size = estimateTileSize(tile);
    const f = tile.layers[0].features;
    expect(size).toBeGreaterThanOrEqual(f.featureIds.buffer.byteLength);
    expect(estimateTileSize(tile)).toBe(size);
  });
});

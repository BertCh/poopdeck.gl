/**
 * Compact feature times (`TILE_META.st` / `.et`, the `time-delta` capability)
 * and the `List<UInt32>` `vertex_time` delta tier.
 *
 * The encoder picks these forms per layer from that layer's own data; the
 * reader MUST branch on the TILE_META keys, never on the Arrow DataType alone.
 * The Rust round-trip lives in `arrow_tile/tests.rs`; here we build the exact
 * wire shapes it emits and prove the TS decoder recovers the same absolute
 * times — including the ABSENT-`end_time` case, and including the historical
 * absolute `Int64` pair that every already-shipped archive uses.
 */

import { describe, it, expect } from 'vitest';
import {
  Field,
  FixedSizeList,
  Float64,
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
} from 'apache-arrow';
import { decodeTile, getFeatureProperties } from '../src/tile';
import { type TileId } from '../src/types';
import { frameFromIpc } from './helpers/fixtures';

const tileId: TileId = { z: 0, x: 0, y: 0, t: 0 };

/** `[lon,lat]` pairs for `n` synthetic points. */
function pointGeometry(n: number) {
  const coords = Float64Array.from({ length: n * 2 }, (_, i) =>
    i % 2 === 0 ? -122 + i * 0.01 : 37.5,
  );
  return makeData({
    type: new FixedSizeList(2, new Field('xy', new Float64(), false)),
    length: n,
    nullCount: 0,
    child: makeData({ type: new Float64(), data: coords }),
  });
}

function i64Column(values: number[]) {
  return makeData({
    type: new Int64(),
    length: values.length,
    data: BigInt64Array.from(values, (v) => BigInt(v)),
  });
}

function u32Column(values: number[]) {
  return makeData({
    type: new Uint32(),
    length: values.length,
    data: Uint32Array.from(values),
  });
}

/**
 * Build a single-layer point tile whose time columns take the given form.
 *
 * `start`/`end` are the RAW column contents (offsets/durations for the compact
 * forms); `end === null` is the `et: 'zero'` shape where the column is absent
 * from the batch entirely.
 */
function buildTimeTile(opts: {
  start: { kind: 'i64' | 'u32'; values: number[] };
  end: { kind: 'i64' | 'u32'; values: number[] } | null;
  tileMeta: Record<string, unknown>;
  vertexTime?: { deltas: number[]; perFeature: number };
}): Uint8Array {
  const n = opts.start.values.length;
  const fields: Field[] = [
    new Field('id', new Uint64(), false),
    new Field(
      'start_time',
      opts.start.kind === 'u32' ? new Uint32() : new Int64(),
      false,
    ),
  ];
  const children = [
    makeData({
      type: new Uint64(),
      length: n,
      data: BigUint64Array.from({ length: n }, (_, i) => BigInt(i + 1)),
    }),
    opts.start.kind === 'u32'
      ? u32Column(opts.start.values)
      : i64Column(opts.start.values),
  ];
  if (opts.end) {
    fields.push(
      new Field(
        'end_time',
        opts.end.kind === 'u32' ? new Uint32() : new Int64(),
        false,
      ),
    );
    children.push(
      opts.end.kind === 'u32'
        ? u32Column(opts.end.values)
        : i64Column(opts.end.values),
    );
  }
  const geomMeta = new Map<string, string>([
    ['ARROW:extension:name', 'geoarrow.point'],
  ]);
  fields.push(
    new Field(
      'geometry',
      new FixedSizeList(2, new Field('xy', new Float64(), false)),
      false,
      geomMeta,
    ),
  );
  children.push(pointGeometry(n));

  if (opts.vertexTime) {
    const { deltas, perFeature } = opts.vertexTime;
    const item = new Field('item', new Uint32(), true);
    const vtData = makeData({
      type: new List(item),
      length: n,
      nullCount: 0,
      valueOffsets: Int32Array.from(
        { length: n + 1 },
        (_, i) => i * perFeature,
      ),
      child: makeData({ type: new Uint32(), data: Uint32Array.from(deltas) }),
    });
    fields.push(new Field('vertex_time', vtData.type, true));
    children.push(vtData);
  }

  const schema = new Schema(
    fields,
    new Map([['stt:geometry', 'geoarrow.point']]),
  );
  const structData = makeData({
    type: new Struct(fields),
    length: n,
    nullCount: 0,
    children,
  });
  const ipc = tableToIPC(
    new Table([new RecordBatch(schema, structData as never)]),
    'stream',
  );
  return frameFromIpc('t', ipc, opts.tileMeta);
}

/** Absolute Unix ms per feature, as the render path reconstructs them. */
function absoluteTimes(payload: Uint8Array) {
  const features = decodeTile(payload, tileId).layers[0].features;
  const { timeOffset, startTimes, endTimes, featureCount } = features;
  return {
    features,
    starts: Array.from({ length: featureCount }, (_, i) =>
      Math.round(timeOffset + startTimes[i]),
    ),
    ends: Array.from({ length: featureCount }, (_, i) =>
      Math.round(timeOffset + endTimes[i]),
    ),
  };
}

const T0 = 1_700_000_000_000;

describe('compact feature times (TILE_META st / et)', () => {
  it('reads absolute Int64 columns — the shape every shipped archive uses', () => {
    const { starts, ends } = absoluteTimes(
      buildTimeTile({
        start: { kind: 'i64', values: [T0, T0 + 1000, T0 + 5000] },
        end: { kind: 'i64', values: [T0 + 100, T0 + 1000, T0 + 9000] },
        tileMeta: { sorted: true, t0: T0 },
      }),
    );
    expect(starts).toEqual([T0, T0 + 1000, T0 + 5000]);
    expect(ends).toEqual([T0 + 100, T0 + 1000, T0 + 9000]);
  });

  it('reads a u32 start offset column against t0', () => {
    const { starts, ends } = absoluteTimes(
      buildTimeTile({
        start: { kind: 'u32', values: [0, 1000, 5000] },
        end: { kind: 'i64', values: [T0 + 100, T0 + 1000, T0 + 9000] },
        tileMeta: { sorted: true, st: 'u32', t0: T0 },
      }),
    );
    expect(starts).toEqual([T0, T0 + 1000, T0 + 5000]);
    expect(ends).toEqual([T0 + 100, T0 + 1000, T0 + 9000]);
  });

  it('reads u32 durations against each feature’s own start', () => {
    const { starts, ends } = absoluteTimes(
      buildTimeTile({
        start: { kind: 'u32', values: [0, 1000, 5000] },
        end: { kind: 'u32', values: [100, 0, 4000] },
        tileMeta: { sorted: true, et: 'dur32', st: 'u32', t0: T0 },
      }),
    );
    expect(starts).toEqual([T0, T0 + 1000, T0 + 5000]);
    expect(ends).toEqual([T0 + 100, T0 + 1000, T0 + 9000]);
  });

  it('synthesizes end_time from start_time when the column is omitted', () => {
    for (const st of ['u32', undefined] as const) {
      const { starts, ends } = absoluteTimes(
        buildTimeTile({
          start:
            st === 'u32'
              ? { kind: 'u32', values: [0, 1000, 5000] }
              : { kind: 'i64', values: [T0, T0 + 1000, T0 + 5000] },
          end: null,
          tileMeta: { sorted: true, et: 'zero', ...(st ? { st } : {}), t0: T0 },
        }),
      );
      expect(starts).toEqual([T0, T0 + 1000, T0 + 5000]);
      expect(ends).toEqual(starts);
    }
  });

  it('feeds getFeatureProperties the same absolute times', () => {
    const { features } = absoluteTimes(
      buildTimeTile({
        start: { kind: 'u32', values: [0, 250] },
        end: { kind: 'u32', values: [10, 0] },
        tileMeta: { sorted: true, et: 'dur32', st: 'u32', t0: T0 },
      }),
    );
    expect(getFeatureProperties(features, 0)).toMatchObject({
      start_time: T0,
      end_time: T0 + 10,
    });
    expect(getFeatureProperties(features, 1)).toMatchObject({
      start_time: T0 + 250,
      end_time: T0 + 250,
    });
  });

  it('rejects a compact declaration it cannot honour', () => {
    // `t0` is the u32 offsets' anchor — load-bearing, so its absence must fail
    // loudly rather than decode every feature into January 1970.
    expect(() =>
      decodeTile(
        buildTimeTile({
          start: { kind: 'u32', values: [0, 1] },
          end: null,
          tileMeta: { et: 'zero', st: 'u32' },
        }),
        tileId,
      ),
    ).toThrow(/requires a finite 't0' anchor/);

    // An unknown VALUE of a known key is a hard error, not a silent misread.
    for (const [meta, pattern] of [
      [{ st: 'u64', t0: T0 }, /'st' must be the string/],
      [{ et: 'i32', t0: T0 }, /'et' must be the string/],
    ] as const) {
      expect(() =>
        decodeTile(
          buildTimeTile({
            start: { kind: 'i64', values: [T0] },
            end: { kind: 'i64', values: [T0] },
            tileMeta: meta,
          }),
          tileId,
        ),
      ).toThrow(pattern);
    }
  });
});

describe('vertex_time List<UInt32> delta tier', () => {
  it('reconstructs absolute vertex times from u32 deltas', () => {
    // A day-wide layer: too wide for the u16 tier at 1 s precision, held
    // EXACTLY by u32 at step 1 (the `nyc-taxi-flows` case).
    const step = 1;
    const origin = T0;
    const deltas = [0, 43_200_000, 86_400_000, 10, 20, 30];
    const tile = decodeTile(
      buildTimeTile({
        start: { kind: 'u32', values: [0, 0] },
        end: null,
        tileMeta: {
          sorted: true,
          et: 'zero',
          st: 'u32',
          t0: T0,
          vt: [origin, step],
        },
        vertexTime: { deltas, perFeature: 3 },
      }),
      tileId,
    );
    const vt = tile.layers[0].features.vertexTimestamps;
    expect(vt).toBeDefined();
    expect(Array.from(vt!).map((v) => Math.round(T0 + v))).toEqual(
      deltas.map((d) => origin + d * step),
    );
  });

  it('honours a widened step exactly like the u16 tier', () => {
    const step = 2;
    const deltas = [0, 100, 250, 1, 2, 3];
    const tile = decodeTile(
      buildTimeTile({
        start: { kind: 'i64', values: [T0, T0] },
        end: null,
        tileMeta: { sorted: true, et: 'zero', t0: T0, vt: [T0, step] },
        vertexTime: { deltas, perFeature: 3 },
      }),
      tileId,
    );
    const vt = tile.layers[0].features.vertexTimestamps!;
    expect(Array.from(vt).map((v) => Math.round(T0 + v))).toEqual(
      deltas.map((d) => T0 + d * step),
    );
  });
});

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
  Uint16,
  Uint32,
  Uint64,
  makeData,
  tableToIPC,
} from 'apache-arrow';
import {
  decodeTile,
  getFeatureProperties,
  readTemporalColumnInfo,
  toGeoArrowTable,
} from '../src/tile';
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
  vertexTime?: {
    deltas: number[];
    perFeature: number;
    /**
     * Wire width of the list child. Defaults to `u32` (the original harness).
     * `i64` is the ABSOLUTE fallback tier — no `TILE_META.vt` anchor, the
     * values are whole Unix ms.
     */
    width?: 'u16' | 'u32' | 'i64';
  };
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
    const { deltas, perFeature, width } = opts.vertexTime;
    const leaf =
      width === 'u16'
        ? new Uint16()
        : width === 'i64'
          ? new Int64()
          : new Uint32();
    const item = new Field('item', leaf, true);
    const vtData = makeData({
      type: new List(item),
      length: n,
      nullCount: 0,
      valueOffsets: Int32Array.from(
        { length: n + 1 },
        (_, i) => i * perFeature,
      ),
      child:
        width === 'u16'
          ? makeData({ type: new Uint16(), data: Uint16Array.from(deltas) })
          : width === 'i64'
            ? makeData({
                type: new Int64(),
                data: BigInt64Array.from(deltas.map(BigInt)),
              })
            : makeData({ type: new Uint32(), data: Uint32Array.from(deltas) }),
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

// ── TB-11 extension 2 — feature-anchored vertex times (`TILE_META.vtf`) ──────

describe('vertex_time feature-anchored tier (vtf)', () => {
  it('anchors each feature run to its own start_time', () => {
    // Two features 12 hours apart — far past the u16 tier's 65.5 s reach from a
    // layer-wide origin — each holding a 60 s trip that fits u16 at step 1.
    const twelveHours = 12 * 3600_000;
    const deltas = [0, 30_000, 60_000, 0, 30_000, 60_000];
    const tile = decodeTile(
      buildTimeTile({
        start: { kind: 'i64', values: [T0, T0 + twelveHours] },
        end: null,
        tileMeta: { sorted: true, et: 'zero', t0: T0, vtf: 1 },
        vertexTime: { deltas, perFeature: 3, width: 'u16' },
      }),
      tileId,
    );
    const f = tile.layers[0].features;
    const absolute = Array.from(f.vertexTimestamps!).map((v) =>
      Math.round(f.timeOffset + v),
    );
    expect(absolute).toEqual([
      T0,
      T0 + 30_000,
      T0 + 60_000,
      T0 + twelveHours,
      T0 + twelveHours + 30_000,
      T0 + twelveHours + 60_000,
    ]);
  });

  it('applies the step, and never a layer origin', () => {
    // With `vtf` present there is no origin to apply. If the decoder fell back
    // to the layer-anchored arm it would add `vertexTimeOrigin` (0 here) and
    // every second feature's times would collapse onto the first's — which is
    // exactly the silent misdecode the capability exists to prevent.
    const step = 4;
    const deltas = [0, 10, 25, 0, 10, 25];
    const tile = decodeTile(
      buildTimeTile({
        start: { kind: 'i64', values: [T0, T0 + 900_000] },
        end: null,
        tileMeta: { sorted: true, et: 'zero', t0: T0, vtf: step },
        vertexTime: { deltas, perFeature: 3, width: 'u16' },
      }),
      tileId,
    );
    const f = tile.layers[0].features;
    const absolute = Array.from(f.vertexTimestamps!).map((v) =>
      Math.round(f.timeOffset + v),
    );
    expect(absolute).toEqual([
      T0,
      T0 + 40,
      T0 + 100,
      T0 + 900_000,
      T0 + 900_000 + 40,
      T0 + 900_000 + 100,
    ]);
  });

  it('leaves the layer-anchored form untouched when vtf is absent', () => {
    // The same bytes, read as the incumbent form: both features resolve
    // against ONE origin. Pins that the new branch is entered only on `vtf`.
    const deltas = [0, 10, 25, 0, 10, 25];
    const tile = decodeTile(
      buildTimeTile({
        start: { kind: 'i64', values: [T0, T0 + 900_000] },
        end: null,
        tileMeta: { sorted: true, et: 'zero', t0: T0, vt: [T0, 4] },
        vertexTime: { deltas, perFeature: 3, width: 'u16' },
      }),
      tileId,
    );
    const f = tile.layers[0].features;
    const absolute = Array.from(f.vertexTimestamps!).map((v) =>
      Math.round(f.timeOffset + v),
    );
    expect(absolute).toEqual([T0, T0 + 40, T0 + 100, T0, T0 + 40, T0 + 100]);
  });
});

/**
 * The `visgl:temporal-*` descriptor across every compact wire form.
 *
 * These are the shapes that make the descriptor non-trivial. `start_time` and
 * `end_time` reach the hand-off RE-INFLATED to absolute, so they can state
 * `origin: 0` however they were written; `vertex_time` is the one column decode
 * leaves compact, so its delta forms must advertise the domain and stay SILENT
 * about origin — their anchor is `stt:vertex_time_origin_ms`, which is per-tile
 * and therefore not a property of the column at all.
 */
describe('vis.gl temporal metadata across the compact forms', () => {
  const cases = [
    {
      label: 'absolute Int64 pair',
      opts: {
        start: { kind: 'i64' as const, values: [T0, T0 + 1000, T0 + 5000] },
        end: { kind: 'i64' as const, values: [T0 + 100, T0 + 1000, T0 + 9000] },
        tileMeta: { sorted: true },
      },
    },
    {
      label: 'u32 start offsets against t0',
      opts: {
        start: { kind: 'u32' as const, values: [0, 1000, 5000] },
        end: { kind: 'i64' as const, values: [T0 + 100, T0 + 1000, T0 + 9000] },
        tileMeta: { sorted: true, st: 'u32', t0: T0 },
      },
    },
    {
      label: 'u32 durations against each start',
      opts: {
        start: { kind: 'u32' as const, values: [0, 1000, 5000] },
        end: { kind: 'u32' as const, values: [100, 0, 4000] },
        tileMeta: { sorted: true, et: 'dur32', st: 'u32', t0: T0 },
      },
    },
    {
      label: 'omitted end_time (et=zero)',
      opts: {
        start: { kind: 'u32' as const, values: [0, 1000, 5000] },
        end: null,
        tileMeta: { sorted: true, et: 'zero', st: 'u32', t0: T0 },
      },
    },
  ];

  for (const { label, opts } of cases) {
    it(`describes ${label} as absolute Unix ms`, () => {
      const layer = decodeTile(buildTimeTile(opts), tileId).layers[0];
      const table = toGeoArrowTable(layer);
      for (const column of ['start_time', 'end_time']) {
        const info = readTemporalColumnInfo(table, column);
        expect(info, `${column} must be described`).not.toBeNull();
        expect(info!.unit).toBe('millisecond');
        expect(info!.timezone).toBe('UTC');
        expect(info!.origin, `${column} origin`).toBe(0);
        expect(info!.originPolicy).toBe('zero');
      }
      // The descriptor is only worth anything if it is TRUE: the column must
      // hold the same absolute instants the render path reconstructs.
      const { timeOffset, startTimes } = layer.features;
      expect(Number(table.getChild('start_time')!.get(0))).toBe(
        Math.round(timeOffset + startTimes[0]),
      );
    });
  }

  it('describes an absolute List<Int64> vertex_time as origin 0', () => {
    // The fallback tier: no `TILE_META.vt`, so the list already holds whole
    // Unix ms. This is the positive branch of the same check the delta case
    // below pins negatively.
    const layer = decodeTile(
      buildTimeTile({
        start: { kind: 'i64', values: [T0, T0 + 1000] },
        end: { kind: 'i64', values: [T0 + 500, T0 + 1500] },
        tileMeta: { sorted: true },
        vertexTime: {
          deltas: [T0, T0 + 500, T0 + 1000, T0 + 1500],
          perFeature: 2,
          width: 'i64',
        },
      }),
      tileId,
    ).layers[0];
    const info = readTemporalColumnInfo(toGeoArrowTable(layer), 'vertex_time')!;
    expect(info.origin).toBe(0);
    expect(info.originPolicy).toBe('zero');
  });

  it('never claims an origin for delta-encoded vertex_time', () => {
    const layer = decodeTile(
      buildTimeTile({
        start: { kind: 'i64', values: [T0, T0 + 1000] },
        end: { kind: 'i64', values: [T0 + 500, T0 + 1500] },
        tileMeta: {
          sorted: true,
          vt: [T0, 1000] as [number, number],
        },
        vertexTime: { deltas: [0, 1, 2, 3], perFeature: 2, width: 'u16' },
      }),
      tileId,
    ).layers[0];
    const table = toGeoArrowTable(layer);

    const info = readTemporalColumnInfo(table, 'vertex_time');
    expect(info, 'the domain is still worth stating').not.toBeNull();
    expect(info!.unit).toBe('millisecond');
    // A per-tile anchor is not a column origin: claiming one here would place
    // every vertex of every OTHER tile at the wrong instant.
    expect(info!.origin).toBeUndefined();
    expect(info!.originPolicy).toBeUndefined();

    // The anchor a consumer MUST use instead is right there on the schema.
    expect(table.schema.metadata.get('stt:vertex_time_origin_ms')).toBe(
      String(T0),
    );
  });
});

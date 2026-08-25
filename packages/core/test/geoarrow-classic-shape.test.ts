/**
 * **The public GeoArrow hand-off is shape-stable across the compact
 * encodings.**
 *
 * `toGeoArrowTable()` is documented as the hand to generic GeoArrow consumers
 * — `@geoarrow/deck.gl-layers`, Lonboard, anything that reads
 * `ARROW:extension:name` — and those consumers know nothing about STT's
 * `TILE_META`. So the table it returns MUST be the classic shape no matter
 * which of the 2026-07 payload encodings the tile happened to use:
 *
 *   - `TILE_META.st = "u32"` — `start_time` on the wire is a `UInt32` offset
 *     from `t0`, and must come back as absolute `Int64` milliseconds;
 *   - `TILE_META.et = "dur32"` — `end_time` is a `UInt32` duration, and must
 *     come back as absolute `Int64`;
 *   - `TILE_META.et = "zero"` — the `end_time` column is ABSENT from the wire
 *     entirely, and must come back synthesized (`end === start`) **at its
 *     canonical index**, immediately after `start_time` rather than appended
 *     after the property columns;
 *   - `TILE_META.vq` — `vertex_value` / `vertex_value_matrix` ship as
 *     `UInt16` indices under an affine, and must come back as
 *     `List<Float32>` with the reserved `0xFFFF` index restored to `NaN`.
 *
 * Rust has never had a gap here: `merge_v2_layer` re-inflates at the batch
 * level, so every downstream Rust consumer sees the classic shape. This file
 * pins the TS equivalent, and pins it the strongest way available — by
 * building the SAME data twice, once in the classic wire shape and once in
 * the compact one, and demanding the two hand-offs be indistinguishable.
 *
 * Both decode routes are covered: the inline `decodeTile` table and the
 * worker route, where the `Table` is stripped before `postMessage` and
 * `toGeoArrowTable()` rehydrates from `arrowIpc` + `arrowIpcProps` +
 * `tileMeta`.
 */

import { describe, it, expect } from 'vitest';
import {
  Field,
  FixedSizeList,
  Float32,
  Float64,
  Int64,
  List,
  RecordBatch,
  Schema,
  Struct,
  Table,
  Type as ArrowType,
  Uint16,
  Uint32,
  Uint64,
  makeData,
  tableFromIPC,
  tableToIPC,
  type Data,
} from 'apache-arrow';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STTArchive } from '../src/archive';
import { unzstdSync } from '../src/compression';
import { decodeTile, toGeoArrowTable } from '../src/tile';
import { type TileId } from '../src/types';
import {
  loadPackedDatasetFromDisk,
  packedFetch,
} from './helpers/packed-fixture';
import {
  buildV2Frame,
  REF_KIND_INLINE,
  REF_KIND_NO_PROPS,
  SECTION_CORE_BATCH,
  SECTION_INLINE_SCHEMA_CORE,
  SECTION_INLINE_SCHEMA_PROPS,
  SECTION_PROPS_BATCH,
  SECTION_TILE_META,
  splitIpcTemplate,
  tileMetaBytes,
} from './helpers/v2-frame';

const tileId: TileId = { z: 0, x: 0, y: 0, t: 0 };
const T0 = 1_700_000_000_000;
/** The reserved no-value index, mirroring Rust's `VERTEX_VALUE_QUANT_SENTINEL`. */
const SENTINEL = 0xffff;

// The three features' absolute times, and the compact forms of the same.
const STARTS = [T0, T0 + 1000, T0 + 5000];
const ENDS = [T0 + 100, T0 + 1000, T0 + 9000];
const START_OFFSETS = [0, 1000, 5000];
const DURATIONS = [100, 0, 4000];

// Two vertices per feature. The affine is chosen so every dequantized value
// is EXACT in f32 — the classic and compact tables must agree bit for bit,
// not merely to within half a step (that tolerance is tested elsewhere).
const VQ_AFFINE: [number, number] = [0, 0.5];
const VERTEX_INDICES = [0, 2, 4, 6, SENTINEL, 10];
const VERTEX_VALUES = [0, 1, 2, 3, NaN, 5];

const SPEEDS = [12.5, 0, -3.25];

type Column = { field: Field; data: Data };

function idColumn(n: number): Column {
  return {
    field: new Field('id', new Uint64(), false),
    data: makeData({
      type: new Uint64(),
      length: n,
      data: BigUint64Array.from({ length: n }, (_, i) => BigInt(i + 1)),
    }),
  };
}

function i64Column(name: string, values: number[]): Column {
  return {
    field: new Field(name, new Int64(), false),
    data: makeData({
      type: new Int64(),
      length: values.length,
      data: BigInt64Array.from(values, (v) => BigInt(v)),
    }),
  };
}

function u32Column(name: string, values: number[]): Column {
  return {
    field: new Field(name, new Uint32(), false),
    data: makeData({
      type: new Uint32(),
      length: values.length,
      data: Uint32Array.from(values),
    }),
  };
}

/** Three 2-vertex linestrings, `geoarrow.linestring`-tagged. */
function geometryColumn(): Column {
  const vertices = VERTEX_VALUES.length;
  const coords = Float64Array.from({ length: vertices * 2 }, (_, i) =>
    i % 2 === 0 ? -122 + i * 0.01 : 37.5,
  );
  const coordList = makeData({
    type: new FixedSizeList(2, new Field('xy', new Float64(), false)),
    length: vertices,
    nullCount: 0,
    child: makeData({ type: new Float64(), data: coords }),
  });
  const data = makeData({
    type: new List(new Field('vertices', coordList.type, false)),
    length: 3,
    nullCount: 0,
    valueOffsets: Int32Array.from([0, 2, 4, 6]),
    child: coordList,
  });
  return {
    field: new Field(
      'geometry',
      data.type,
      false,
      new Map([['ARROW:extension:name', 'geoarrow.linestring']]),
    ),
    data,
  };
}

/** `vertex_value` as either a raw `List<Float32>` or `vq` `List<UInt16>`. */
function vertexValueColumn(kind: 'f32' | 'u16'): Column {
  const flat = kind === 'f32' ? VERTEX_VALUES : VERTEX_INDICES;
  const leafType = kind === 'f32' ? new Float32() : new Uint16();
  const child =
    kind === 'f32'
      ? makeData({ type: new Float32(), data: Float32Array.from(flat) })
      : makeData({ type: new Uint16(), data: Uint16Array.from(flat) });
  const data = makeData({
    type: new List(new Field('item', leafType, true)),
    length: 3,
    nullCount: 0,
    valueOffsets: Int32Array.from([0, 2, 4, 6]),
    child,
  });
  return { field: new Field('vertex_value', data.type, true), data };
}

function speedColumn(): Column {
  return {
    field: new Field('speed', new Float32(), false),
    data: makeData({
      type: new Float32(),
      length: SPEEDS.length,
      data: Float32Array.from(SPEEDS),
    }),
  };
}

function ipcOf(columns: Column[], metadata?: Map<string, string>): Uint8Array {
  const fields = columns.map((c) => c.field);
  const schema = new Schema(fields, metadata);
  const struct = makeData({
    type: new Struct(fields),
    length: columns[0].data.length,
    nullCount: 0,
    children: columns.map((c) => c.data),
  });
  return tableToIPC(new Table([new RecordBatch(schema, struct)]), 'stream');
}

/**
 * A single-layer v2 frame. `props` — when given — rides its OWN schema +
 * batch sections, the split a real v2 archive uses, so the merge order
 * (CORE columns then PROPS columns) is what the assertions see.
 */
function frame(
  core: Column[],
  tileMeta: Record<string, unknown>,
  props?: Column[],
): Uint8Array {
  const schemaMeta = new Map([['stt:geometry', 'geoarrow.linestring']]);
  const c = splitIpcTemplate(ipcOf(core, schemaMeta));
  const sections: Array<[number, Uint8Array]> = [
    [SECTION_INLINE_SCHEMA_CORE, c.template],
    [SECTION_TILE_META, tileMetaBytes(tileMeta)],
    [SECTION_CORE_BATCH, c.tail],
  ];
  if (props) {
    const p = splitIpcTemplate(ipcOf(props));
    sections.push([SECTION_INLINE_SCHEMA_PROPS, p.template]);
    sections.push([SECTION_PROPS_BATCH, p.tail]);
  }
  return buildV2Frame([
    {
      name: 'vv',
      refCore: { kind: REF_KIND_INLINE },
      refProps: { kind: props ? REF_KIND_INLINE : REF_KIND_NO_PROPS },
      sections,
    },
  ]);
}

/** The CLASSIC wire shape: absolute Int64 times, raw Float32 vertex values. */
function classicFrame(props?: Column[]): Uint8Array {
  return frame(
    [
      idColumn(3),
      i64Column('start_time', STARTS),
      i64Column('end_time', ENDS),
      geometryColumn(),
      vertexValueColumn('f32'),
    ],
    { sorted: true, t0: T0 },
    props,
  );
}

/** The COMPACT wire shape carrying exactly the same data. */
function compactFrame(et: 'dur32' | 'zero', props?: Column[]): Uint8Array {
  const core: Column[] = [
    idColumn(3),
    u32Column('start_time', START_OFFSETS),
    ...(et === 'dur32' ? [u32Column('end_time', DURATIONS)] : []),
    geometryColumn(),
    vertexValueColumn('u16'),
  ];
  return frame(
    core,
    { et, sorted: true, st: 'u32', t0: T0, vq: { vertex_value: VQ_AFFINE } },
    props,
  );
}

/** A structural + value fingerprint of a table, comparable across shapes. */
function fingerprint(table: Table) {
  return {
    fields: table.schema.fields.map((f) => ({
      name: f.name,
      type: String(f.type),
      extension: f.metadata.get('ARROW:extension:name') ?? null,
    })),
    startTime: Array.from(table.getChild('start_time')!.toArray(), Number),
    endTime: Array.from(table.getChild('end_time')!.toArray(), Number),
    vertexValue: Array.from(
      table.getChild('vertex_value')!.data[0].children[0]
        .values as Float32Array,
    ),
    numRows: table.numRows,
  };
}

/** Reproduce the worker hop: strip the Table, structured-clone the rest. */
function viaWorker(payload: Uint8Array) {
  const layer = decodeTile(payload, tileId).layers[0];
  delete layer.arrowTable;
  const cloned = structuredClone(layer);
  expect(cloned.arrowTable).toBeUndefined();
  return toGeoArrowTable(cloned);
}

describe('toGeoArrowTable: the compact encodings are invisible', () => {
  it('hands a compact tile back in the classic column types and values', () => {
    const table = toGeoArrowTable(
      decodeTile(compactFrame('dur32'), tileId).layers[0],
    );

    // Column identity and ORDER — a GeoArrow consumer indexes by name, but a
    // reordered batch is still a silent breaking change.
    expect(table.schema.fields.map((f) => f.name)).toEqual([
      'id',
      'start_time',
      'end_time',
      'geometry',
      'vertex_value',
    ]);

    // start/end are absolute Int64 milliseconds — NOT UInt32 offsets.
    for (const name of ['start_time', 'end_time']) {
      const field = table.schema.fields.find((f) => f.name === name)!;
      expect(field.typeId, `${name} type id`).toBe(ArrowType.Int);
      expect(String(field.type), `${name} type`).toBe('Int64');
    }
    expect(Array.from(table.getChild('start_time')!.toArray(), Number)).toEqual(
      STARTS,
    );
    expect(Array.from(table.getChild('end_time')!.toArray(), Number)).toEqual(
      ENDS,
    );

    // vertex_value is List<Float32> holding real values, with the reserved
    // 0xFFFF index restored to NaN — not a raw UInt16 index column.
    const vv = table.getChild('vertex_value')!;
    expect(vv.type.typeId).toBe(ArrowType.List);
    expect(String((vv.type as List).children[0].type)).toBe('Float32');
    const leaf = vv.data[0].children[0].values as Float32Array;
    expect(leaf).toBeInstanceOf(Float32Array);
    expect(Array.from(leaf)).toEqual(VERTEX_VALUES);

    // …and per-feature list slicing still lines up.
    expect(Array.from(vv.get(0)!)).toEqual([0, 1]);
    expect(Array.from(vv.get(2)!)).toEqual([NaN, 5]);
  });

  it('is byte-identical to the classic tile carrying the same data', () => {
    const classic = fingerprint(
      toGeoArrowTable(decodeTile(classicFrame(), tileId).layers[0]),
    );
    for (const et of ['dur32', 'zero'] as const) {
      const compact = fingerprint(
        toGeoArrowTable(decodeTile(compactFrame(et), tileId).layers[0]),
      );
      // `et: 'zero'` means end === start on the wire, so line the expectation
      // up with what that tile actually encodes.
      const want =
        et === 'zero' ? { ...classic, endTime: classic.startTime } : classic;
      expect(compact, `et=${et}`).toEqual(want);
    }
  });

  it('hands back a table a consumer can re-serialize', () => {
    // A re-inflated column must be a NORMAL Arrow column, not merely one that
    // reads correctly. In particular the `et: "zero"` `end_time` must own its
    // buffer: apache-arrow's JS IPC WRITER cannot serialize a record batch
    // whose two columns alias one `ArrayBuffer` — it double-counts the body
    // length, writes the buffer once, and every reader then rejects the short
    // stream. Sharing the start column (which is what Rust's `Arc` clone does,
    // free) would therefore hand Lonboard / a `tableToIPC` consumer a table
    // they cannot write back out.
    for (const et of ['dur32', 'zero'] as const) {
      const table = toGeoArrowTable(
        decodeTile(compactFrame(et, [speedColumn()]), tileId).layers[0],
      );
      const roundTripped = tableFromIPC(tableToIPC(table, 'stream'));
      expect(
        roundTripped.schema.fields.map((f) => f.name),
        `et=${et}`,
      ).toEqual(table.schema.fields.map((f) => f.name));
      expect(
        Array.from(roundTripped.getChild('start_time')!.toArray(), Number),
        `et=${et}`,
      ).toEqual(STARTS);
      expect(
        Array.from(roundTripped.getChild('end_time')!.toArray(), Number),
        `et=${et}`,
      ).toEqual(et === 'zero' ? STARTS : ENDS);
      expect(
        Array.from(roundTripped.getChild('speed')!.toArray()),
        `et=${et}`,
      ).toEqual(SPEEDS);
      expect(
        Array.from(
          roundTripped.getChild('vertex_value')!.data[0].children[0]
            .values as Float32Array,
        ),
        `et=${et}`,
      ).toEqual(VERTEX_VALUES);
    }
  });

  it('inserts a synthesized end_time at its canonical index, not after the props', () => {
    // The whole reason re-inflation runs on the CORE prefix: appending the
    // synthesized column would put `end_time` after `speed`, which is a
    // different record batch from the classic one even though every value
    // matches.
    const layer = decodeTile(compactFrame('zero', [speedColumn()]), tileId)
      .layers[0];
    const table = toGeoArrowTable(layer);
    expect(table.schema.fields.map((f) => f.name)).toEqual([
      'id',
      'start_time',
      'end_time',
      'geometry',
      'vertex_value',
      'speed',
    ]);
    expect(Array.from(table.getChild('end_time')!.toArray(), Number)).toEqual(
      STARTS,
    );
    expect(Array.from(table.getChild('speed')!.toArray())).toEqual(SPEEDS);
    // The classic tile with the same property column agrees on order.
    const classicTable = toGeoArrowTable(
      decodeTile(classicFrame([speedColumn()]), tileId).layers[0],
    );
    expect(table.schema.fields.map((f) => f.name)).toEqual(
      classicTable.schema.fields.map((f) => f.name),
    );
  });

  it('re-inflates on the worker rehydrate path too', () => {
    // `toGeoArrowTable()` re-parses `arrowIpc` (+ `arrowIpcProps`) here — a
    // second, independent merge site. If only the inline path re-inflated,
    // every worker-decoded tile would still hand out the compact shape.
    for (const et of ['dur32', 'zero'] as const) {
      const table = viaWorker(compactFrame(et, [speedColumn()]));
      expect(
        table.schema.fields.map((f) => f.name),
        `et=${et}`,
      ).toEqual([
        'id',
        'start_time',
        'end_time',
        'geometry',
        'vertex_value',
        'speed',
      ]);
      expect(
        Array.from(table.getChild('start_time')!.toArray(), Number),
        `et=${et}`,
      ).toEqual(STARTS);
      expect(
        Array.from(table.getChild('end_time')!.toArray(), Number),
        `et=${et}`,
      ).toEqual(et === 'zero' ? STARTS : ENDS);
      expect(
        Array.from(
          table.getChild('vertex_value')!.data[0].children[0]
            .values as Float32Array,
        ),
        `et=${et}`,
      ).toEqual(VERTEX_VALUES);
    }
  });

  it('leaves a tile that declares no compact encoding strictly untouched', () => {
    // The no-op fast path: same `Table` instance out as in, so the classic
    // archives that are 100 % of what is published today pay nothing.
    const layer = decodeTile(classicFrame([speedColumn()]), tileId).layers[0];
    const table = toGeoArrowTable(layer);
    expect(table).toBe(layer.arrowTable);
    expect(Array.from(table.getChild('start_time')!.toArray(), Number)).toEqual(
      STARTS,
    );
  });

  it('does not double-apply: the binary features match the classic decode', () => {
    // The other half of "move it to the table level" — `tableToBinaryFeatures`
    // must not ALSO undo `st`/`et`/`vq`, which would offset every time by a
    // second `t0` and re-scale every vertex value.
    const classic = decodeTile(classicFrame(), tileId).layers[0].features;
    for (const et of ['dur32', 'zero'] as const) {
      const f = decodeTile(compactFrame(et), tileId).layers[0].features;
      expect(f.timeOffset, `et=${et}`).toBe(classic.timeOffset);
      expect(
        Array.from(f.startTimes).map((v) => f.timeOffset + v),
        `et=${et}`,
      ).toEqual(STARTS);
      expect(
        Array.from(f.endTimes).map((v) => f.timeOffset + v),
        `et=${et}`,
      ).toEqual(et === 'zero' ? STARTS : ENDS);
      expect(Array.from(f.vertexValues!), `et=${et}`).toEqual(VERTEX_VALUES);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The same claim, against bytes this reader did not construct.
// ───────────────────────────────────────────────────────────────────────────

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

/**
 * Lift each layer's TILE_META out of a v2 layer frame. An independent
 * re-implementation of the section walk in `src/tile.ts` (the same technique
 * `legacy-shape-backcompat.test.ts` uses) — so the assertion "the writer
 * really did ship the compact shape" does not go through the very code under
 * test.
 */
function tileMetaOf(blob: Uint8Array): Array<Record<string, unknown> | null> {
  const raw = unzstdSync(blob);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  expect(dv.getUint16(0, true), 'v2 frame escape').toBe(0xffff);
  let p = 2;
  expect(raw[p++], 'frame_version').toBe(2);
  p++; // flags
  const layerCount = dv.getUint16(p, true);
  p += 2;
  const out: Array<Record<string, unknown> | null> = [];
  for (let l = 0; l < layerCount; l++) {
    const nameLen = dv.getUint16(p, true);
    p += 2 + nameLen;
    if (raw[p++] === 1) p += 16; // ref_kind_core (+ blake3-128 template hash)
    if (raw[p++] === 1) p += 16; // ref_kind_props
    const sectionCount = raw[p++];
    const toc: Array<{ tag: number; len: number }> = [];
    for (let s = 0; s < sectionCount; s++) {
      const tag = raw[p++];
      toc.push({ tag, len: dv.getUint32(p, true) });
      p += 4;
    }
    p = (p + 7) & ~7;
    let meta: Record<string, unknown> | null = null;
    for (const s of toc) {
      if (s.tag === 0x02) {
        meta = JSON.parse(new TextDecoder().decode(raw.subarray(p, p + s.len)));
      }
      p = (p + s.len + 7) & ~7;
    }
    out.push(meta);
  }
  return out;
}

describe('toGeoArrowTable: real Rust writer output, not hand-built frames', () => {
  // `test/fixtures/packed-golden/` is regenerated by
  // `crates/stt-core/examples/make-golden-fixture.rs`, and today's encoder
  // ships it in the compact time shape. That makes it the end-to-end proof:
  // bytes produced by the Rust writer, read through the real `STTArchive`
  // container path, handed to a GeoArrow consumer.
  const goldenDataset = () =>
    loadPackedDatasetFromDisk(
      fs,
      FIXTURES + 'packed-golden',
      'mem://data/packed-golden/manifest.json',
    );

  it('the fixture really is compact on the wire (declared, and per-tile)', async () => {
    const ds = goldenDataset();
    const manifest = JSON.parse(
      new TextDecoder().decode(ds.objects.get('manifest.json')!),
    );
    // The manifest's must-understand declaration…
    expect(manifest.capabilities).toContain('time-delta');
    // …and the per-tile TILE_META that backs it, in EVERY tile.
    const packs: Uint8Array[] = manifest.packs.map((p: { key: string }) =>
      ds.objects.get(p.key)!,
    );
    const archive = new STTArchive({
      url: ds.manifestUrl,
      fetch: packedFetch(ds),
    });
    const index = await archive.getIndex();
    let walked = 0;
    for (const e of index.tiles) {
      const blob = packs[e.packId ?? 0].subarray(e.offset, e.offset + e.length);
      for (const meta of tileMetaOf(blob)) {
        expect(meta, `tile ${e.zoom}/${e.x}/${e.y}`).not.toBeNull();
        expect(meta!.st, `tile ${e.zoom}/${e.x}/${e.y} st`).toBe('u32');
        expect(meta!.et, `tile ${e.zoom}/${e.x}/${e.y} et`).toBe('dur32');
      }
      walked++;
    }
    expect(walked).toBe(12);
  });

  it('hands those tiles to a GeoArrow consumer as absolute Int64 times', async () => {
    const ds = goldenDataset();
    const archive = new STTArchive({
      url: ds.manifestUrl,
      fetch: packedFetch(ds),
    });
    await archive.getIndex();

    for (const k of [0, 1, 3, 4, 8, 9, 11]) {
      const tile = await archive.getTile({ z: 10, x: k, y: 0, t: 1000 * k });
      expect(tile, `tile k=${k}`).not.toBeNull();
      const table = toGeoArrowTable(tile!.layers[0]);

      // Classic column types — a consumer that knows nothing of TILE_META
      // must not meet a UInt32 offset column where it expects milliseconds.
      const typeOf = (name: string) =>
        String(table.schema.fields.find((f) => f.name === name)!.type);
      expect(typeOf('start_time'), `k=${k}`).toBe('Int64');
      expect(typeOf('end_time'), `k=${k}`).toBe('Int64');
      expect(
        table.schema.fields.map((f) => f.name),
        `k=${k}`,
      ).toEqual(['id', 'start_time', 'end_time', 'geometry', 'speed', 'kind']);

      // …carrying ABSOLUTE epoch milliseconds. `t0` is the PAYLOAD's, and
      // k=4 / k=9 deliberately reuse k=0's blob (that trio is the fixture's
      // content-address dedup coverage), so the expectation follows the seed,
      // not the tile coordinate — exactly as `packed-golden.test.ts` does.
      const s = k === 4 || k === 9 ? 0 : k;
      const starts = Array.from(
        table.getChild('start_time')!.toArray(),
        Number,
      );
      const ends = Array.from(table.getChild('end_time')!.toArray(), Number);
      expect(starts, `k=${k} starts`).toEqual([1000 * s, 1000 * s, 1000 * s]);
      expect(ends, `k=${k} ends`).toEqual([
        1000 * s + 100,
        1000 * s + 100,
        1000 * s + 100,
      ]);
      // The non-deduped tiles additionally agree with the DIRECTORY's own
      // interval — an authority outside the payload, so a re-inflation that
      // forgot `t0`, or applied it twice, cannot match it by construction.
      if (s === k) {
        expect(starts[0], `k=${k} vs directory`).toBe(tile!.timeRange.start);
        expect(ends[0], `k=${k} vs directory`).toBe(tile!.timeRange.end);
      }
      // And every k is genuinely re-based: the wire column is a u32 offset
      // from the payload's own t0, so a reader that skipped re-inflation
      // would report 0/100 for all twelve tiles.
      expect(starts[0] === 0, `k=${k} offset-vs-absolute`).toBe(s === 0);

      // The property columns still ride along untouched — re-inflation
      // rebuilds the CORE prefix, it does not rebuild the batch.
      expect(table.getChild('speed')!.toArray().length, `k=${k}`).toBe(3);
      expect(table.numRows, `k=${k}`).toBe(3);
    }
  });

  it('the worker rehydrate path agrees, on the same real bytes', async () => {
    const ds = goldenDataset();
    const archive = new STTArchive({
      url: ds.manifestUrl,
      fetch: packedFetch(ds),
      retainArrowIpc: true,
    });
    await archive.getIndex();
    const tile = await archive.getTile({ z: 10, x: 3, y: 0, t: 3000 });
    const layer = tile!.layers[0];
    expect(
      layer.arrowIpc,
      'retainArrowIpc: true keeps the bytes',
    ).toBeDefined();
    delete layer.arrowTable;
    const table = toGeoArrowTable(layer);
    expect(String(table.schema.fields[1].type)).toBe('Int64');
    expect(Array.from(table.getChild('start_time')!.toArray(), Number)).toEqual(
      [3000, 3000, 3000],
    );
    expect(Array.from(table.getChild('end_time')!.toArray(), Number)).toEqual([
      3100, 3100, 3100,
    ]);
  });
});

/**
 * The two additive payload columns this file pins:
 *
 * 1. **Per-vertex value quantization** (`TILE_META.vq`, the
 *    `vertex-value-quant` capability) — `vertex_value` /
 *    `vertex_value_matrix` ship as `List<UInt16>` indices under a
 *    range-adaptive affine instead of raw `List<Float32>`. The reader MUST
 *    branch on `vq`, never on the Arrow child type, and must turn the
 *    reserved index `0xFFFF` back into `NaN` (the format's "no value at this
 *    vertex" marker, which `UInt16` cannot represent).
 * 2. **`part_offsets`** — the MultiPolygon PART boundaries `geoarrow.polygon`
 *    cannot express, surfaced as `BinaryFeatures.partIndices` in the same
 *    units and convention as `ringIndices` (global, layer-rebased vertex
 *    indices with a total-count terminator).
 *
 * Arrow IPC is fabricated in TS so the test runs without the Rust toolchain,
 * the same approach `polygon-ring-indices.test.ts` and `compact-times.test.ts`
 * take. The Rust round-trips live in `arrow_tile/tests.rs`.
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
  Uint16,
  Uint32,
  Uint64,
  makeData,
  tableToIPC,
} from 'apache-arrow';
import { _decodeTableForTest, decodeTile } from '../src/tile';
import { frameFromIpc } from './helpers/fixtures';
import { GeometryType, type TileId } from '../src/types';

const tileId: TileId = { z: 0, x: 0, y: 0, t: 0 };

/** The reserved no-value index, mirroring Rust's `VERTEX_VALUE_QUANT_SENTINEL`. */
const SENTINEL = 0xffff;

function idColumn(n: number) {
  return makeData({
    type: new Uint64(),
    length: n,
    data: BigUint64Array.from({ length: n }, (_, i) => BigInt(i + 1)),
  });
}

function i64Column(values: number[]) {
  return makeData({
    type: new Int64(),
    length: values.length,
    data: BigInt64Array.from(values, (v) => BigInt(v)),
  });
}

/** A `List<Float32>` or `List<UInt16>` column, one list per feature. */
function valueListColumn(
  perFeature: number[][],
  kind: 'f32' | 'u16',
): ReturnType<typeof makeData> {
  const offsets = new Int32Array(perFeature.length + 1);
  for (let i = 0; i < perFeature.length; i++) {
    offsets[i + 1] = offsets[i] + perFeature[i].length;
  }
  const flat = perFeature.flat();
  const child =
    kind === 'f32'
      ? makeData({ type: new Float32(), data: Float32Array.from(flat) })
      : makeData({ type: new Uint16(), data: Uint16Array.from(flat) });
  const item = new Field(
    'item',
    kind === 'f32' ? new Float32() : new Uint16(),
    true,
  );
  return makeData({
    type: new List(item),
    length: perFeature.length,
    nullCount: 0,
    valueOffsets: offsets,
    child,
  });
}

/**
 * A LINE tile whose features carry per-vertex values (and optionally a matrix)
 * in the requested wire shape. Geometry is synthesized 1:1 with the values.
 */
function buildVertexValueTile(opts: {
  values: number[][];
  matrix?: number[][];
  kind: 'f32' | 'u16';
  /** Leaf of the MATRIX column, when it differs from `kind`. */
  matrixKind?: 'f32' | 'u16';
  tileMeta: Record<string, unknown>;
}): Uint8Array {
  const n = opts.values.length;
  const counts = opts.values.map((v) => v.length);
  const total = counts.reduce((a, b) => a + b, 0);
  const coords = new Float64Array(total * 2);
  for (let i = 0; i < total; i++) {
    coords[i * 2] = -122 + i * 0.01;
    coords[i * 2 + 1] = 37.5;
  }
  const coordList = makeData({
    type: new FixedSizeList(2, new Field('xy', new Float64(), false)),
    length: total,
    nullCount: 0,
    child: makeData({ type: new Float64(), data: coords }),
  });
  const lineOffsets = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) lineOffsets[i + 1] = lineOffsets[i] + counts[i];
  const geomData = makeData({
    type: new List(new Field('vertices', coordList.type, false)),
    length: n,
    nullCount: 0,
    valueOffsets: lineOffsets,
    child: coordList,
  });

  const fields: Field[] = [
    new Field('id', new Uint64(), false),
    new Field('start_time', new Int64(), false),
    new Field('end_time', new Int64(), false),
    new Field(
      'geometry',
      geomData.type,
      false,
      new Map<string, string>([
        ['ARROW:extension:name', 'geoarrow.linestring'],
      ]),
    ),
  ];
  const children: Array<ReturnType<typeof makeData>> = [
    idColumn(n),
    i64Column(new Array(n).fill(0)),
    i64Column(new Array(n).fill(0)),
    geomData,
  ];

  const vv = valueListColumn(opts.values, opts.kind);
  fields.push(new Field('vertex_value', vv.type, true));
  children.push(vv);
  if (opts.matrix) {
    const vm = valueListColumn(opts.matrix, opts.matrixKind ?? opts.kind);
    fields.push(new Field('vertex_value_matrix', vm.type, true));
    children.push(vm);
  }

  const schema = new Schema(
    fields,
    new Map<string, string>([
      ['stt:layer', 'vv'],
      ['stt:geometry', 'geoarrow.linestring'],
    ]),
  );
  const structData = makeData({
    type: new Struct(fields),
    length: n,
    nullCount: 0,
    children,
  });
  const ipc = tableToIPC(new Table([new RecordBatch(schema, structData)]));
  return frameFromIpc('vv', ipc, opts.tileMeta);
}

/**
 * A POLYGON layer table from an explicit ring layout, optionally carrying the
 * `part_offsets` column.
 *
 * `rings` is the flat, part-major ring list exactly as the geometry column
 * stores it; `ringsPerFeature` splits it into features; `parts` (when given)
 * is the per-feature list of ring indices each part starts at, relative to
 * that feature's own first ring.
 *
 * `partChildPad` prepends N junk entries to the `part_offsets` CHILD buffer
 * and starts that column's `valueOffsets` past them — a chunk whose run does
 * not begin at index 0. Only reachable via {@link _decodeTableForTest}: the
 * IPC writer normalizes exactly this shape away.
 */
function polygonPartsTable(opts: {
  rings: number[][]; // each ring: flat [x,y,x,y,…]
  ringsPerFeature: number[];
  parts?: number[][];
  partChildPad?: number;
}): Table {
  const coords = new Float64Array(opts.rings.flat());
  const vertexCount = coords.length / 2;
  const coordList = makeData({
    type: new FixedSizeList(2, new Field('xy', new Float64(), false)),
    length: vertexCount,
    nullCount: 0,
    child: makeData({ type: new Float64(), data: coords }),
  });

  const ringOffsets = new Int32Array(opts.rings.length + 1);
  for (let r = 0; r < opts.rings.length; r++) {
    ringOffsets[r + 1] = ringOffsets[r] + opts.rings[r].length / 2;
  }
  const ringList = makeData({
    type: new List(new Field('vertices', coordList.type, false)),
    length: opts.rings.length,
    nullCount: 0,
    valueOffsets: ringOffsets,
    child: coordList,
  });

  const n = opts.ringsPerFeature.length;
  const featureOffsets = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    featureOffsets[i + 1] = featureOffsets[i] + opts.ringsPerFeature[i];
  }
  const geomData = makeData({
    type: new List(new Field('rings', ringList.type, false)),
    length: n,
    nullCount: 0,
    valueOffsets: featureOffsets,
    child: ringList,
  });

  const fields: Field[] = [
    new Field('id', new Uint64(), false),
    new Field('start_time', new Int64(), false),
    new Field('end_time', new Int64(), false),
    new Field(
      'geometry',
      geomData.type,
      false,
      new Map<string, string>([['ARROW:extension:name', 'geoarrow.polygon']]),
    ),
  ];
  const children: Array<ReturnType<typeof makeData>> = [
    idColumn(n),
    i64Column(new Array(n).fill(0)),
    i64Column(new Array(n).fill(1000)),
    geomData,
  ];

  if (opts.parts) {
    const pad = opts.partChildPad ?? 0;
    const partOffsets = new Int32Array(n + 1);
    partOffsets[0] = pad;
    for (let i = 0; i < n; i++) {
      partOffsets[i + 1] = partOffsets[i] + opts.parts[i].length;
    }
    // Junk that a rebased-index read would pick up instead of the real
    // values: ring 7 does not exist in any of these fixtures.
    const junk = new Array(pad).fill(7);
    const partData = makeData({
      type: new List(new Field('item', new Uint32(), true)),
      length: n,
      nullCount: 0,
      valueOffsets: partOffsets,
      child: makeData({
        type: new Uint32(),
        data: Uint32Array.from([...junk, ...opts.parts.flat()]),
      }),
    });
    fields.push(new Field('part_offsets', partData.type, false));
    children.push(partData);
  }

  const schema = new Schema(
    fields,
    new Map<string, string>([
      ['stt:layer', 'zones'],
      ['stt:geometry', 'geoarrow.polygon'],
    ]),
  );
  const structData = makeData({
    type: new Struct(fields),
    length: n,
    nullCount: 0,
    children,
  });
  return new Table([new RecordBatch(schema, structData)]);
}

/** {@link polygonPartsTable}, serialized into a single-layer v2 frame. */
function buildPolygonPartsTile(
  opts: Parameters<typeof polygonPartsTable>[0],
): Uint8Array {
  return frameFromIpc('zones', tableToIPC(polygonPartsTable(opts)));
}

/** A closed square ring at `(x, y)` with side `s`, as flat coordinates. */
function square(x: number, y: number, s: number): number[] {
  return [x, y, x + s, y, x + s, y + s, x, y + s, x, y];
}

describe('per-vertex value quantization (TILE_META vq)', () => {
  it('reads a raw List<Float32> column when no affine is declared', () => {
    const tile = decodeTile(
      buildVertexValueTile({
        values: [
          [-2.5, 0, 12.25],
          [31.75, 7.5],
        ],
        kind: 'f32',
        tileMeta: { sorted: true, t0: 0 },
      }),
      tileId,
    );
    expect(Array.from(tile.layers[0].features.vertexValues!)).toEqual([
      -2.5, 0, 12.25, 31.75, 7.5,
    ]);
  });

  it('dequantizes a UInt16 column through the vq affine', () => {
    // The affine the Rust encoder would derive for [-2.5 … 31.75].
    const o = -2.5;
    const s = (31.75 - -2.5) / 65534;
    const want = [-2.5, 0, 12.25, 31.75, 7.5];
    const indices = want.map((v) => Math.round((v - o) / s));
    const tile = decodeTile(
      buildVertexValueTile({
        values: [indices.slice(0, 3), indices.slice(3)],
        kind: 'u16',
        tileMeta: { sorted: true, t0: 0, vq: { vertex_value: [o, s] } },
      }),
      tileId,
    );
    const got = Array.from(tile.layers[0].features.vertexValues!);
    expect(got).toHaveLength(5);
    for (let i = 0; i < want.length; i++) {
      // Within half a step — the whole precision claim of the encoding.
      expect(Math.abs(got[i] - want[i])).toBeLessThanOrEqual(s / 2 + 1e-3);
    }
  });

  it('turns the reserved sentinel index back into NaN', () => {
    const tile = decodeTile(
      buildVertexValueTile({
        values: [[0, SENTINEL, 65534]],
        kind: 'u16',
        tileMeta: { sorted: true, t0: 0, vq: { vertex_value: [10, 0.5] } },
      }),
      tileId,
    );
    const got = tile.layers[0].features.vertexValues!;
    expect(got[0]).toBeCloseTo(10, 6);
    expect(Number.isNaN(got[1])).toBe(true);
    expect(got[2]).toBeCloseTo(10 + 65534 * 0.5, 2);
  });

  it('quantizes the two per-vertex value columns independently', () => {
    const tile = decodeTile(
      buildVertexValueTile({
        values: [[0, 65534]],
        matrix: [[0, 65534]],
        kind: 'u16',
        tileMeta: {
          sorted: true,
          t0: 0,
          vb: 2,
          vq: {
            vertex_value: [0, 1 / 65534],
            vertex_value_matrix: [0, 4000 / 65534],
          },
        },
      }),
      tileId,
    );
    const f = tile.layers[0].features;
    expect(Array.from(f.vertexValues!)).toEqual([0, 1]);
    expect(Array.from(f.vertexValueMatrix!)).toEqual([0, 4000]);
    expect(f.vertexValueBuckets).toBe(2);
  });

  it('leaves a column with no vq entry on the raw float path', () => {
    // `vertex_value` is quantized, the MATRIX is NOT — a mixed tile must not
    // apply one column's affine to the other, which is exactly what branching
    // on the Arrow child type instead of on `vq` would do.
    const tile = decodeTile(
      buildVertexValueTile({
        values: [[0, 100]],
        matrix: [[-1.5, 2.5]],
        kind: 'u16',
        matrixKind: 'f32',
        tileMeta: {
          sorted: true,
          t0: 0,
          vb: 1,
          vq: { vertex_value: [5, 0.25] },
        },
      }),
      tileId,
    );
    const f = tile.layers[0].features;
    expect(Array.from(f.vertexValues!)).toEqual([5, 30]);
    expect(Array.from(f.vertexValueMatrix!)).toEqual([-1.5, 2.5]);
  });

  it('rejects a malformed or out-of-set vq entry rather than misreading it', () => {
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ vq: [1, 2] }, "'vq' must be an object"],
      [{ vq: { speed: [0, 1] } }, 'not a per-vertex value column'],
      [{ vq: { vertex_value: [0] } }, 'must be an [o, s] pair'],
      [{ vq: { vertex_value: [0, null] } }, 'must be an [o, s] pair'],
    ];
    for (const [tileMeta, message] of bad) {
      expect(() =>
        decodeTile(
          buildVertexValueTile({
            values: [[0, 1]],
            kind: 'u16',
            tileMeta: { sorted: true, t0: 0, ...tileMeta },
          }),
          tileId,
        ),
      ).toThrow(message);
    }
  });

  it('refuses a vq whose column did not actually ship UInt16 indices', () => {
    // A crafted or corrupt tile: `vq` names `vertex_value`, but the column on
    // the wire is a raw `List<Float32>`. Reinterpreting those bytes as u16
    // indices would decode to plausible-looking garbage, so — exactly like
    // Rust's `reinflate_quantized_vertex_values` — the reader must refuse.
    expect(() =>
      decodeTile(
        buildVertexValueTile({
          values: [[1.5, 2.5]],
          kind: 'f32',
          tileMeta: { sorted: true, t0: 0, vq: { vertex_value: [0, 0.5] } },
        }),
        tileId,
      ),
    ).toThrow(
      /TILE_META\.vq declares 'vertex_value' quantized but its list leaf is Float32 \(expected UInt16\)/,
    );

    // Same for the matrix column, and for a `vq` naming a column the layer
    // does not carry at all.
    expect(() =>
      decodeTile(
        buildVertexValueTile({
          values: [[0, 1]],
          matrix: [[1.5, 2.5]],
          kind: 'u16',
          matrixKind: 'f32',
          tileMeta: {
            sorted: true,
            t0: 0,
            vb: 1,
            vq: {
              vertex_value: [0, 0.5],
              vertex_value_matrix: [0, 0.5],
            },
          },
        }),
        tileId,
      ),
    ).toThrow(
      /'vertex_value_matrix' quantized but its list leaf is Float32 \(expected UInt16\)/,
    );

    expect(() =>
      decodeTile(
        buildVertexValueTile({
          values: [[0, 1]],
          kind: 'u16',
          tileMeta: {
            sorted: true,
            t0: 0,
            vq: {
              vertex_value: [0, 0.5],
              vertex_value_matrix: [0, 0.5],
            },
          },
        }),
        tileId,
      ),
    ).toThrow(
      /carries an affine for 'vertex_value_matrix' but the layer has no such column/,
    );
  });
});

describe('decodeTile: MultiPolygon part boundaries (part_offsets)', () => {
  /**
   * Two features, 4 rings, 20 vertices:
   *   feature 0 — part 0 = [exterior, hole], part 1 = [exterior]  → parts [0,2]
   *   feature 1 — a plain single-part square                      → parts [0]
   */
  function twoFeatureMultiPart(withParts: boolean): Uint8Array {
    return buildPolygonPartsTile({
      rings: [
        square(0, 0, 4), // f0 part 0 exterior
        square(1, 1, 2), // f0 part 0 hole
        square(10, 10, 4), // f0 part 1 exterior
        square(20, 20, 4), // f1 exterior
      ],
      ringsPerFeature: [3, 1],
      parts: withParts ? [[0, 2], [0]] : undefined,
    });
  }

  it('surfaces per-part vertex offsets in the ringIndices convention', () => {
    const f = decodeTile(twoFeatureMultiPart(true), tileId).layers[0].features;
    expect(f.geometryType).toBe(GeometryType.Polygon);
    // 20 vertices, 5 per ring.
    expect(Array.from(f.startIndices!)).toEqual([0, 15, 20]);
    expect(Array.from(f.ringIndices!)).toEqual([0, 5, 10, 15, 20]);
    // 3 parts total → 4 entries, the last being the total position count.
    expect(f.partIndices).toBeInstanceOf(Uint32Array);
    expect(Array.from(f.partIndices!)).toEqual([0, 10, 15, 20]);
  });

  it('nests feature ⊇ part ⊇ ring: every coarser boundary is also a finer one', () => {
    const f = decodeTile(twoFeatureMultiPart(true), tileId).layers[0].features;
    const rings = new Set(f.ringIndices!);
    const parts = new Set(f.partIndices!);
    for (const p of parts) expect(rings.has(p)).toBe(true);
    for (const s of f.startIndices!) expect(parts.has(s)).toBe(true);
  });

  it('omits partIndices when the column is absent (every feature single-part)', () => {
    const f = decodeTile(twoFeatureMultiPart(false), tileId).layers[0].features;
    expect(f.partIndices).toBeUndefined();
    // …and the unknown-column tolerance that makes the addition safe: the
    // decoder must not publish `part_offsets` as a numeric property either.
    const withCol = decodeTile(twoFeatureMultiPart(true), tileId).layers[0]
      .features;
    expect(Object.keys(withCol.numericProps)).not.toContain('part_offsets');
    expect(Object.keys(withCol.categoricalProps)).not.toContain('part_offsets');
  });

  it('rebases part offsets onto the tile’s own vertex run, per feature', () => {
    // Three single-ring parts in ONE feature, plus a following feature: the
    // second feature's `[0]` must resolve against ITS first ring, not ring 0.
    const f = decodeTile(
      buildPolygonPartsTile({
        rings: [
          square(0, 0, 1),
          square(2, 2, 1),
          square(4, 4, 1),
          square(6, 6, 1),
        ],
        ringsPerFeature: [3, 1],
        parts: [[0, 1, 2], [0]],
      }),
      tileId,
    ).layers[0].features;
    expect(Array.from(f.partIndices!)).toEqual([0, 5, 10, 15, 20]);
    expect(Array.from(f.startIndices!)).toEqual([0, 15, 20]);
  });

  it('reads the part values through the chunk base, not the rebased index', () => {
    // The `childValues[base + i]` convention `extractVertexTimes` /
    // `extractVertexFloats` both follow. The part walk rebases its loop
    // bounds by `partBase = valueOffsets[offset]` and must therefore index
    // the child buffer by `partBase + p` — indexing by the rebased `p` reads
    // whatever precedes the column's own run.
    //
    // Unreachable through a serialized fixture: the Arrow IPC writer rebases
    // a list column's offsets to start at 0 and re-slices the child to match
    // (verified — round-tripping `valueOffsets: [2, 4, 5]` yields `[0, 2, 3]`
    // with a 3-element child). So the shape is built by hand and pushed
    // through `_decodeTableForTest`, the same per-layer pipeline `decodeTile`
    // runs.
    const PAD = 2;
    const table = polygonPartsTable({
      rings: [
        square(0, 0, 4), // f0 part 0 exterior
        square(1, 1, 2), // f0 part 0 hole
        square(10, 10, 4), // f0 part 1 exterior
        square(20, 20, 4), // f1 exterior
      ],
      ringsPerFeature: [3, 1],
      parts: [[0, 2], [0]],
      // Prepend `PAD` junk entries to the part child buffer and start the
      // offsets past them — a chunk whose run does not begin at index 0.
      partChildPad: PAD,
    });
    const f = _decodeTableForTest(table);
    // Identical to the offset-0 fixture above: the pad must be invisible.
    expect(Array.from(f.partIndices!)).toEqual([0, 10, 15, 20]);
    expect(Array.from(f.ringIndices!)).toEqual([0, 5, 10, 15, 20]);
    expect(Array.from(f.startIndices!)).toEqual([0, 15, 20]);
    // And the nesting invariant still holds, which is what a wrong read
    // would break first (the junk indices resolve to arbitrary rings).
    const rings = new Set(f.ringIndices!);
    for (const p of f.partIndices!) expect(rings.has(p)).toBe(true);
  });
});

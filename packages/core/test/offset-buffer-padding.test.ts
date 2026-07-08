/**
 * Regression guard for the GeoArrow padded-offset-buffer bug class
 * (geoarrow/deck.gl-geoarrow#214).
 *
 * Arrow IPC pads buffers to an alignment boundary, so a List array's offset
 * buffer can be physically LONGER than `logicalLength + 1`. A reader that sizes
 * the feature count from the offset buffer's `.length` (instead of the Arrow
 * `FieldNode.length`) then invents a phantom trailing feature and reads garbage
 * offsets into the geometry — which is exactly what #214 documents (outer
 * geometry corrupted, polygon strokes black).
 *
 * STT's reader sizes everything from the logical length (`geom.length` in
 * `tile.ts`'s `extractGeometry`), so it is immune. These tests pin that
 * invariant: they hand `decodeTile` a geometry whose offset buffer carries
 * extra trailing entries and assert the decoded feature count + every feature's
 * vertex slice are correct. If anyone refactors the extractor to size from
 * `valueOffsets.length - 1`, an over-long offset buffer makes these fail.
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
  Uint64,
  makeData,
  tableToIPC,
} from 'apache-arrow';
import { decodeTile } from '../src/tile';
import { GeometryType, type TileId } from '../src/types';

/**
 * Build a single-layer LineString tile whose geometry offset buffer is
 * deliberately over-allocated with `padEntries` trailing junk values beyond the
 * logical `featureCount + 1`. Returns the layer-frame payload.
 *
 * `features` is a list of vertex runs; each inner array is `[x0,y0,x1,y1,...]`.
 */
function buildLineStringTile(
  features: number[][],
  padEntries: number,
): Uint8Array {
  const featureCount = features.length;
  const flat: number[] = [];
  const offsets: number[] = [0];
  for (const f of features) {
    if (f.length % 2 !== 0) throw new Error('coords must be xy pairs');
    flat.push(...f);
    offsets.push(offsets[offsets.length - 1] + f.length / 2);
  }
  const totalVerts = offsets[offsets.length - 1];

  const coordValues = makeData({
    type: new Float64(),
    data: new Float64Array(flat),
  });
  const coordList = makeData({
    type: new FixedSizeList(2, new Field('xy', new Float64(), false)),
    length: totalVerts,
    nullCount: 0,
    child: coordValues,
  });

  // The crux: pad the offset buffer past `featureCount + 1`. The junk repeats
  // the final offset so a naive reader would invent empty phantom features
  // rather than crash — making a silent miscount the failure mode we guard.
  const last = offsets[offsets.length - 1];
  const paddedOffsets = new Int32Array(offsets.length + padEntries);
  paddedOffsets.set(offsets);
  for (let i = offsets.length; i < paddedOffsets.length; i++)
    paddedOffsets[i] = last;

  const geomData = makeData({
    type: new List(new Field('vertices', coordList.type, false)),
    length: featureCount, // <-- logical length; the extractor must trust THIS
    nullCount: 0,
    valueOffsets: paddedOffsets,
    child: coordList,
  });

  const ids = makeData({
    type: new Uint64(),
    length: featureCount,
    data: BigUint64Array.from(features.map((_, i) => BigInt(i + 1))),
  });
  const startTime = makeData({
    type: new Int64(),
    length: featureCount,
    data: BigInt64Array.from(features.map(() => 0n)),
  });
  const endTime = makeData({
    type: new Int64(),
    length: featureCount,
    data: BigInt64Array.from(features.map(() => 1000n)),
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

  const schema = new Schema(
    fields,
    new Map<string, string>([
      ['stt:layer', 'tracks'],
      ['stt:geometry', 'geoarrow.linestring'],
    ]),
  );
  const structData = makeData({
    type: new Struct(fields),
    length: featureCount,
    nullCount: 0,
    children: [ids, startTime, endTime, geomData],
  });
  const ipc = tableToIPC(
    new Table([new RecordBatch(schema, structData)]),
    'stream',
  );

  const name = new TextEncoder().encode('tracks');
  const frame = new Uint8Array(2 + 2 + name.length + 4 + ipc.length);
  const view = new DataView(frame.buffer);
  view.setUint16(0, 1, true); // layer count
  view.setUint16(2, name.length, true);
  frame.set(name, 4);
  view.setUint32(4 + name.length, ipc.length, true);
  frame.set(ipc, 4 + name.length + 4);
  return frame;
}

const tileId: TileId = { z: 0, x: 0, y: 0, t: 0 };

/** Expected per-feature vertex counts from the input runs. */
function vertexCounts(features: number[][]): number[] {
  return features.map((f) => f.length / 2);
}

describe('decodeTile: padded offset buffers (geoarrow#214 guard)', () => {
  // Even feature count makes (N+1)*4 bytes non-8-byte-aligned, the case most
  // likely to surface alignment padding in a real archive; we force it anyway.
  const cases: Array<{ name: string; features: number[][]; pad: number }> = [
    {
      name: '2 features, 2 padding entries',
      features: [
        [0, 0, 1, 1, 2, 2], // 3 verts
        [5, 5, 6, 6], // 2 verts
      ],
      pad: 2,
    },
    {
      name: '3 features, 1 padding entry',
      features: [
        [0, 0, 1, 0], // 2 verts
        [2, 2, 3, 3, 4, 4], // 3 verts
        [9, 9, 9, 8], // 2 verts
      ],
      pad: 1,
    },
  ];

  for (const c of cases) {
    it(`reports the logical feature count, not the buffer length — ${c.name}`, () => {
      const tile = decodeTile(buildLineStringTile(c.features, c.pad), tileId);
      const f = tile.layers[0].features;

      expect(f.geometryType).toBe(GeometryType.LineString);
      // Phantom features from the padding must NOT appear.
      expect(f.featureCount).toBe(c.features.length);
      expect(f.startIndices).toBeDefined();
      expect(f.startIndices!.length).toBe(c.features.length + 1);

      // Per-feature vertex spans match the input exactly.
      const counts = vertexCounts(c.features);
      for (let i = 0; i < counts.length; i++) {
        expect(f.startIndices![i + 1] - f.startIndices![i]).toBe(counts[i]);
      }

      // The LAST feature's coordinates are intact (the #214 corruption site).
      const dims = f.positionDimensions ?? 2;
      const lastStart = f.startIndices![counts.length - 1];
      const expectedLast = c.features[c.features.length - 1];
      for (let k = 0; k < expectedLast.length; k++) {
        expect(f.positions[lastStart * dims + k]).toBe(expectedLast[k]);
      }
      // No trailing garbage: positions hold exactly the total vertex count.
      const totalVerts = counts.reduce((a, b) => a + b, 0);
      expect(f.positions.length).toBe(totalVerts * dims);
    });
  }
});

/**
 * Polygon ring boundaries on the decode path (`BinaryFeatures.ringIndices`).
 *
 * `startIndices` collapses a feature's rings into one flat vertex run, which
 * is all the FILL needs (exterior/hole structure rides the pre-baked
 * triangles). Consumers that walk EDGES — extruded side walls, per-ring
 * outlines — need the ring breaks as well, or they stitch a spurious edge
 * from the last vertex of one ring to the first vertex of the next. This pins
 * that the two-level GeoArrow offsets survive decode, rebased onto the tile's
 * own vertex run.
 *
 * Arrow IPC is fabricated in TS so the test runs without the Rust toolchain,
 * the same approach as `pre-tessellated.test.ts`.
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
import { frameFromIpc } from './helpers/fixtures';
import { GeometryType, type TileId } from '../src/types';

/**
 * Two polygon features, ring counts 2 and 1:
 *   feature 0 — a square exterior (5 verts, closed) + a square hole (5 verts)
 *   feature 1 — a square exterior (5 verts, closed)
 * Total 15 vertices across 3 rings.
 */
function buildMultiRingPolygonTile(): Uint8Array {
  const square = (x: number, y: number, s: number): number[] => [
    x,
    y,
    x + s,
    y,
    x + s,
    y + s,
    x,
    y + s,
    x,
    y,
  ];
  const coords = new Float64Array([
    ...square(0, 0, 4), // f0 exterior
    ...square(1, 1, 2), // f0 hole
    ...square(10, 10, 4), // f1 exterior
  ]);
  const vertexCount = coords.length / 2;

  const coordValues = makeData({ type: new Float64(), data: coords });
  const coordList = makeData({
    type: new FixedSizeList(2, new Field('xy', new Float64(), false)),
    length: vertexCount,
    nullCount: 0,
    child: coordValues,
  });

  // Ring level: 3 rings of 5 vertices each.
  const ringList = makeData({
    type: new List(new Field('vertices', coordList.type, false)),
    length: 3,
    nullCount: 0,
    valueOffsets: new Int32Array([0, 5, 10, 15]),
    child: coordList,
  });

  // Feature level: feature 0 owns rings [0, 2), feature 1 owns ring [2, 3).
  const geomData = makeData({
    type: new List(new Field('rings', ringList.type, false)),
    length: 2,
    nullCount: 0,
    valueOffsets: new Int32Array([0, 2, 3]),
    child: ringList,
  });

  const ids = makeData({
    type: new Uint64(),
    length: 2,
    data: new BigUint64Array([1n, 2n]),
  });
  const startTime = makeData({
    type: new Int64(),
    length: 2,
    data: new BigInt64Array([0n, 0n]),
  });
  const endTime = makeData({
    type: new Int64(),
    length: 2,
    data: new BigInt64Array([1000n, 1000n]),
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
  const schema = new Schema(
    fields,
    new Map<string, string>([
      ['stt:layer', 'zones'],
      ['stt:geometry', 'geoarrow.polygon'],
    ]),
  );
  const structData = makeData({
    type: new Struct(fields),
    length: 2,
    nullCount: 0,
    children: [ids, startTime, endTime, geomData],
  });
  const ipc = tableToIPC(new Table([new RecordBatch(schema, structData)]));

  return frameFromIpc('zones', ipc);
}

const tileId: TileId = { z: 0, x: 0, y: 0, t: 0 };

describe('decodeTile: polygon ring boundaries', () => {
  it('surfaces per-ring vertex offsets alongside the per-feature ones', () => {
    const tile = decodeTile(buildMultiRingPolygonTile(), tileId);
    const f = tile.layers[0].features;
    expect(f.geometryType).toBe(GeometryType.Polygon);
    // 2 features, 3 rings, 15 vertices.
    expect(Array.from(f.startIndices!)).toEqual([0, 10, 15]);
    expect(Array.from(f.ringIndices!)).toEqual([0, 5, 10, 15]);
    expect(f.ringIndices).toBeInstanceOf(Uint32Array);
  });

  it('keeps every feature boundary present in the ring offsets', () => {
    const f = decodeTile(buildMultiRingPolygonTile(), tileId).layers[0]
      .features;
    const rings = new Set(Array.from(f.ringIndices!));
    for (const s of f.startIndices!) expect(rings.has(s)).toBe(true);
  });
});

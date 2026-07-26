/**
 * Pre-tessellated polygon tiles: decode path for the `triangles` sidecar.
 *
 * The Rust writer emits a `List<UInt32>` triangles column (one feature, one
 * flat triangle-index list) and tags the schema with `stt:has_triangles=true`.
 * Indices are FEATURE-LOCAL on disk; the TS decoder shifts them by each
 * feature's `startIndices[i]` so the renderer sees GLOBAL indices it can
 * upload directly as a WebGL element-array buffer.
 *
 * These tests fabricate an Arrow IPC stream in TS — encoding via apache-arrow
 * keeps them runnable without invoking the Rust toolchain. The cross-language
 * contract is exercised end-to-end by `archive.test.ts` whenever the Rust
 * fixture is regenerated with `--pre-tessellate`.
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
import { decodeTile } from '../src/tile';
import { frameFromIpc } from './helpers/fixtures';
import { GeometryType, type TileId } from '../src/types';

/**
 * Build an Arrow IPC stream for a single polygon layer with two features.
 * Each feature is a unit-square ring at distinct corners; the triangles
 * column carries each feature's 2-triangle tessellation as 6 UInt32 indices
 * in feature-local coordinates.
 *
 * Returns the layer-frame payload (`[u16 count] [u16 nameLen] [name] [u32 ipcLen] [ipc]`).
 */
function buildPolygonTileWithTriangles(opts: {
  /** When true, write the `stt:has_triangles` schema metadata + column. */
  withTriangles: boolean;
  /**
   * Wire width of the `triangles` list's child array. The Rust encoder picks
   * UInt16 when every feature-local index fits (the common case, half the
   * bytes) and UInt32 otherwise; the schema is self-describing, so the TS
   * decoder must handle both. Defaults to 'u32' to match the original fixture.
   */
  triangleWireWidth?: 'u16' | 'u32';
}): Uint8Array {
  // Two square polygons: feature 0 at (0,0)-(1,1), feature 1 at (5,5)-(6,6).
  // Each ring is 5 verts (closing duplicate of vert 0).
  const featureCount = 2;
  const ringSize = 5;
  const coords = new Float64Array(featureCount * ringSize * 2);
  const writeRing = (fi: number, x: number, y: number) => {
    const base = fi * ringSize * 2;
    coords[base + 0] = x;
    coords[base + 1] = y;
    coords[base + 2] = x + 1;
    coords[base + 3] = y;
    coords[base + 4] = x + 1;
    coords[base + 5] = y + 1;
    coords[base + 6] = x;
    coords[base + 7] = y + 1;
    coords[base + 8] = x;
    coords[base + 9] = y;
  };
  writeRing(0, 0, 0);
  writeRing(1, 5, 5);

  // Coordinate-level FixedSizeList<Float64, 2>.
  const coordValues = makeData({
    type: new Float64(),
    data: coords,
  });
  const coordList = makeData({
    type: new FixedSizeList(2, new Field('xy', new Float64(), false)),
    length: featureCount * ringSize,
    nullCount: 0,
    child: coordValues,
  });

  // Ring-level List<FixedSizeList<...>>: 1 ring per feature.
  const ringOffsets = new Int32Array([0, ringSize, ringSize * 2]);
  const ringList = makeData({
    type: new List(new Field('vertices', coordList.type, false)),
    length: featureCount,
    nullCount: 0,
    valueOffsets: ringOffsets,
    child: coordList,
  });

  // Feature-level List<List<FixedSizeList<...>>>: 1 ring per feature, so
  // the feature offsets step by 1.
  const featureOffsets = new Int32Array([0, 1, 2]);
  const geomData = makeData({
    type: new List(new Field('rings', ringList.type, false)),
    length: featureCount,
    nullCount: 0,
    valueOffsets: featureOffsets,
    child: ringList,
  });

  // Per-feature scalars.
  const ids = makeData({
    type: new Uint64(),
    length: featureCount,
    data: new BigUint64Array([1n, 2n]),
  });
  const startTime = makeData({
    type: new Int64(),
    length: featureCount,
    data: new BigInt64Array([0n, 0n]),
  });
  const endTime = makeData({
    type: new Int64(),
    length: featureCount,
    data: new BigInt64Array([1000n, 1000n]),
  });

  // Per-feature triangle indices (feature-LOCAL — 0..4 referencing each
  // feature's own 5 ring vertices). Square earcuts into 2 triangles, 6 idx.
  // (one valid earcut for a CCW square: [3,0,1, 3,1,2])
  const wireWidth = opts.triangleWireWidth ?? 'u32';
  const triFlatValues = [3, 0, 1, 3, 1, 2, 3, 0, 1, 3, 1, 2];
  const triType = wireWidth === 'u16' ? new Uint16() : new Uint32();
  const triFlat =
    wireWidth === 'u16'
      ? new Uint16Array(triFlatValues)
      : new Uint32Array(triFlatValues);
  const triValues = makeData({ type: triType, data: triFlat });
  const triData = makeData({
    type: new List(new Field('item', triType, false)),
    length: featureCount,
    nullCount: 0,
    valueOffsets: new Int32Array([0, 6, 12]),
    child: triValues,
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
  const columns: any[] = [ids, startTime, endTime, geomData];
  if (opts.withTriangles) {
    fields.push(new Field('triangles', triData.type, false));
    columns.push(triData);
  }

  const schemaMeta = new Map<string, string>([
    ['stt:layer', 'zones'],
    ['stt:geometry', 'geoarrow.polygon'],
  ]);
  if (opts.withTriangles) {
    schemaMeta.set('stt:has_triangles', 'true');
  }
  const schema = new Schema(fields, schemaMeta);

  // Build a RecordBatch and serialise as an IPC stream.
  const structData = makeData({
    type: new Struct(fields),
    length: featureCount,
    nullCount: 0,
    children: columns,
  });
  const batch = new RecordBatch(schema, structData);
  const table = new Table([batch]);
  const ipc = tableToIPC(table, 'stream');

  return frameFromIpc('zones', ipc);
}

const tileId: TileId = { z: 0, x: 0, y: 0, t: 0 };

describe('decodeTile: pre-tessellated polygon column', () => {
  it('does not surface triangles when the layer omits the metadata flag', () => {
    const payload = buildPolygonTileWithTriangles({ withTriangles: false });
    const tile = decodeTile(payload, tileId);
    const features = tile.layers[0].features;
    expect(features.geometryType).toBe(GeometryType.Polygon);
    // Backwards-compat: existing tiles must still decode, just without the
    // sidecar — renderers fall back to their own earcut path.
    expect(features.triangles).toBeUndefined();
    expect(features.triangleOffsets).toBeUndefined();
  });

  it('exposes triangles + triangleOffsets when the metadata flag is set', () => {
    const payload = buildPolygonTileWithTriangles({ withTriangles: true });
    const tile = decodeTile(payload, tileId);
    const features = tile.layers[0].features;
    expect(features.triangles).toBeInstanceOf(Uint32Array);
    expect(features.triangleOffsets).toBeInstanceOf(Uint32Array);

    // Two features × 6 indices each.
    expect(features.triangles!.length).toBe(12);
    expect(features.triangleOffsets!.length).toBe(3);
    expect(features.triangleOffsets![0]).toBe(0);
    expect(features.triangleOffsets![1]).toBe(6);
    expect(features.triangleOffsets![2]).toBe(12);
  });

  it("shifts feature-local indices by each feature's startIndex", () => {
    // The Rust writer stores LOCAL indices ([0..4] for a 5-vert ring); the
    // TS decoder must shift them by `startIndices[i]` so the renderer sees
    // GLOBAL indices it can pass to gl.drawElements without a second pass.
    const payload = buildPolygonTileWithTriangles({ withTriangles: true });
    const tile = decodeTile(payload, tileId);
    const f = tile.layers[0].features;
    expect(f.startIndices).toBeDefined();
    // Feature 0 starts at vertex 0, feature 1 starts at vertex 5.
    expect(f.startIndices![0]).toBe(0);
    expect(f.startIndices![1]).toBe(5);

    // Source indices were [3,0,1, 3,1,2] for each feature, local.
    // After shifting: feature 0 stays [3,0,1, 3,1,2], feature 1 becomes
    // [8,5,6, 8,6,7] (each +5).
    expect(Array.from(f.triangles!.subarray(0, 6))).toEqual([3, 0, 1, 3, 1, 2]);
    expect(Array.from(f.triangles!.subarray(6, 12))).toEqual([
      8, 5, 6, 8, 6, 7,
    ]);

    // Every triangle index now maps into the global `positions` buffer.
    const positionCount = f.positions.length / (f.positionDimensions ?? 2);
    for (let i = 0; i < f.triangles!.length; i++) {
      expect(f.triangles![i]).toBeLessThan(positionCount);
    }
  });

  it('decodes a UInt16-width triangles column identically to UInt32 (the common small-feature case)', () => {
    const payload = buildPolygonTileWithTriangles({
      withTriangles: true,
      triangleWireWidth: 'u16',
    });
    const tile = decodeTile(payload, tileId);
    const f = tile.layers[0].features;

    // Decoded/shifted output is always widened to Uint32Array regardless of
    // the wire width — only the on-disk child array narrows.
    expect(f.triangles).toBeInstanceOf(Uint32Array);
    expect(Array.from(f.triangles!.subarray(0, 6))).toEqual([3, 0, 1, 3, 1, 2]);
    expect(Array.from(f.triangles!.subarray(6, 12))).toEqual([
      8, 5, 6, 8, 6, 7,
    ]);
  });
});

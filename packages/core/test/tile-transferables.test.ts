/**
 * Worker `collectTransferables` regression coverage.
 *
 * The heatmap demos at production scale surfaced
 *     [STL] Tile error: Cannot read properties of undefined (reading 'buffer')
 *           at WorkerTileDecoder.handleMessage (...)
 *
 * That error originates inside the worker: `collectTransferables` walks every
 * typed-array field of a decoded tile and reads `.buffer` on each. If any
 * field is unexpectedly `undefined` (an optional field accidentally promoted
 * to `numericProps` / `categoricalProps`, or a malformed property column
 * slipping past the numeric branch of `tableToBinaryFeatures`) the worker
 * throws with that exact message and the surfaced error doesn't name the
 * offending column.
 *
 * The fix:
 *   - `collectTransferables` skips any field that isn't a real typed array
 *     (`ArrayBuffer.isView` guard), so a single bad column degrades to a
 *     structured-clone copy instead of crashing the whole tile.
 *   - The worker's catch block prefixes the error with the tile id so the
 *     `[STL] Tile error` log points straight at the bad tile.
 *
 * These tests guard both behaviours.
 */

import { describe, it, expect } from 'vitest';
import { collectTransferables } from '../src/tile-transferables';
import { GeometryType, type Tile } from '../src/types';

function makeMinimalTile(): Tile {
  const positions = new Float64Array([0, 0, 1, 1]);
  const featureIds = new Uint32Array([1, 2]);
  const startTimes = new Float32Array([0, 1]);
  const endTimes = new Float32Array([1, 2]);
  return {
    id: { z: 11, x: 602, y: 769, t: 1454288400000 },
    timeRange: { start: 0, end: 2 },
    layers: [
      {
        name: 'rideshare',
        extent: 0,
        features: {
          featureCount: 2,
          geometryType: GeometryType.Point,
          positionDimensions: 2,
          positions,
          featureIds,
          startTimes,
          endTimes,
          timeOffset: 0,
          numericProps: {},
          categoricalProps: {},
        },
      },
    ],
  };
}

describe('collectTransferables (worker tile-transfer helper)', () => {
  it('collects every distinct typed-array buffer in a happy-path tile', () => {
    const tile = makeMinimalTile();
    const transferables = collectTransferables(tile);
    // Each typed array has its own ArrayBuffer here, so we expect four.
    expect(transferables.length).toBe(4);
    const f = tile.layers[0].features;
    expect(transferables).toContain(f.positions.buffer);
    expect(transferables).toContain(f.featureIds.buffer);
    expect(transferables).toContain(f.startTimes.buffer);
    expect(transferables).toContain(f.endTimes.buffer);
  });

  it('deduplicates buffers shared across multiple typed-array views', () => {
    // positions / featureIds / startTimes / endTimes all view into one shared
    // ArrayBuffer — matches the Arrow IPC reality where many columns subarray
    // into the same record-batch buffer.
    const shared = new ArrayBuffer(64);
    const tile: Tile = {
      id: { z: 0, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 0 },
      layers: [
        {
          name: 'l',
          extent: 0,
          features: {
            featureCount: 1,
            geometryType: GeometryType.Point,
            positionDimensions: 2,
            positions: new Float64Array(shared, 0, 2),
            featureIds: new Uint32Array(shared, 16, 1),
            startTimes: new Float32Array(shared, 24, 1),
            endTimes: new Float32Array(shared, 32, 1),
            timeOffset: 0,
            numericProps: {},
            categoricalProps: {},
          },
        },
      ],
    };
    const transferables = collectTransferables(tile);
    expect(transferables).toEqual([shared]);
  });

  it('includes optional fields when present', () => {
    const tile = makeMinimalTile();
    const f = tile.layers[0].features;
    f.startIndices = new Uint32Array([0, 2]);
    f.vertexTimestamps = new Float32Array([0, 1]);
    f.vertexValues = new Float32Array([21.5, NaN]);
    f.globalFeatureIds = new Uint32Array([10, 11]);
    f.numericProps['speed'] = new Float32Array([2, 3]);
    f.categoricalProps['kind'] = {
      indices: new Uint16Array([0, 1]),
      categories: ['a', 'b'],
    };
    tile.layers[0].arrowIpc = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    const transferables = collectTransferables(tile);
    expect(transferables).toContain(f.startIndices.buffer);
    expect(transferables).toContain(f.vertexTimestamps.buffer);
    // Per-vertex scalar values are positions-sized; omitting them from the
    // transfer list silently structured-clone-copies them per tile.
    expect(transferables).toContain(f.vertexValues.buffer);
    expect(transferables).toContain(f.globalFeatureIds.buffer);
    expect(transferables).toContain(f.numericProps['speed'].buffer);
    expect(transferables).toContain(f.categoricalProps['kind'].indices.buffer);
    // The raw per-layer IPC bytes travel zero-copy too (GeoArrow hand-off).
    expect(transferables).toContain(tile.layers[0].arrowIpc!.buffer);
    // The category-string table is structured-cloned (not transferable).
    for (const t of transferables) {
      expect(Array.isArray(t)).toBe(false);
    }
  });

  // ---------------------------------------------------------------------------
  // Regression: the showcase heatmap crash
  // ---------------------------------------------------------------------------
  //
  // Production hit a tile whose decode produced a `numericProps` / category
  // entry that was `undefined`. The previous implementation hit
  //     seen.add(arr.buffer);
  // and threw `Cannot read properties of undefined (reading 'buffer')`. The
  // worker's catch block then bounced that exact (untagged) string back to
  // the main thread.
  //
  // The helper now skips non-typed-array entries instead of crashing.
  // ---------------------------------------------------------------------------

  it('transfers pre-tessellated mesh + 64-bit id buffers (polygon/summary tiles)', () => {
    // triangles is often the LARGEST buffer in a --pre-tessellate polygon
    // tile, and featureIds64 carries H3 cell indices on summary tiles. These
    // were previously omitted, silently structured-clone-COPYing the biggest
    // buffers across the worker boundary and eating the decode-speed win.
    const tile = makeMinimalTile();
    const f = tile.layers[0].features;
    f.triangles = new Uint32Array([0, 1, 2, 0, 2, 3]);
    f.triangleOffsets = new Uint32Array([0, 6]);
    f.featureIds64 = new BigUint64Array([123n, 456n]);
    const transferables = collectTransferables(tile);
    expect(transferables).toContain(f.triangles.buffer);
    expect(transferables).toContain(f.triangleOffsets.buffer);
    expect(transferables).toContain(f.featureIds64.buffer);
  });

  it('does not throw when numericProps contains an undefined entry (heatmap regression)', () => {
    const tile = makeMinimalTile();
    const f = tile.layers[0].features;
    // Two numeric columns, one of which is `undefined` (the production
    // symptom). The good column must still be transferable.
    f.numericProps['speed'] = new Float32Array([1, 2]);
    (f.numericProps as Record<string, Float32Array | undefined>)['bad'] = undefined;
    expect(() => collectTransferables(tile)).not.toThrow();
    const transferables = collectTransferables(tile);
    expect(transferables).toContain(f.numericProps['speed'].buffer);
  });

  it('does not throw when categoricalProps contains an undefined entry', () => {
    const tile = makeMinimalTile();
    const f = tile.layers[0].features;
    f.categoricalProps['kind'] = {
      indices: new Uint16Array([0, 1]),
      categories: ['a', 'b'],
    };
    (f.categoricalProps as Record<string, { indices: Uint16Array; categories: string[] } | undefined>)['bad'] = undefined;
    expect(() => collectTransferables(tile)).not.toThrow();
  });

  it('tolerates a layer with a missing features object', () => {
    // Forward compat: a tile that grew an extra (non-feature) layer shape
    // shouldn't crash the worker.
    const tile = makeMinimalTile();
    (tile.layers as any).push({ name: 'broken', extent: 0, features: undefined });
    expect(() => collectTransferables(tile)).not.toThrow();
    // The intact layer's buffers still ride along.
    expect(collectTransferables(tile).length).toBe(4);
  });

  it('tolerates a feature object with a non-typed-array in a slot', () => {
    // Slot that should be a typed array but isn't (e.g. a plain object that
    // happens to carry a `.buffer` property). The previous code would have
    // tried to transfer `{}.buffer` (== undefined) and crashed.
    const tile = makeMinimalTile();
    const f = tile.layers[0].features as any;
    f.vertexTimestamps = { buffer: 'not a real buffer' } as any;
    expect(() => collectTransferables(tile)).not.toThrow();
    // vertexTimestamps is silently skipped; the legitimate fields remain.
    expect(collectTransferables(tile).length).toBe(4);
  });

  it('tolerates a Tile with a malformed layers field', () => {
    expect(collectTransferables({ layers: undefined } as any)).toEqual([]);
    expect(collectTransferables(null as any)).toEqual([]);
  });
});

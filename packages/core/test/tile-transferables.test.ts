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
import {
  collectTransferables,
  forEachBufferView,
} from '../src/tile-transferables';
import { estimateTileSize } from '../src/archive';
import { GeometryType, type BinaryFeatures, type Tile } from '../src/types';

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
    tile.layers[0].arrowIpcProps = new Uint8Array([0xee, 0xee, 0xee, 0xee]);
    const transferables = collectTransferables(tile);
    expect(transferables).toContain(f.startIndices.buffer);
    expect(transferables).toContain(f.vertexTimestamps.buffer);
    // Per-vertex scalar values are positions-sized; omitting them from the
    // transfer list silently structured-clone-copies them per tile.
    expect(transferables).toContain(f.vertexValues.buffer);
    expect(transferables).toContain(f.globalFeatureIds.buffer);
    expect(transferables).toContain(f.numericProps['speed'].buffer);
    expect(transferables).toContain(f.categoricalProps['kind'].indices.buffer);
    // The raw per-layer IPC bytes travel zero-copy too (GeoArrow hand-off),
    // as do the v2 spliced-props bytes (Layer.arrowIpcProps).
    expect(transferables).toContain(tile.layers[0].arrowIpc!.buffer);
    expect(transferables).toContain(tile.layers[0].arrowIpcProps!.buffer);
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

  it('transfers the polygon boundary arrays (ringIndices / partIndices)', () => {
    // `partIndices` shipped with the `part_offsets` column but was never
    // added to `forEachBufferView`, so the worker structured-CLONE-COPIED it
    // for every multi-part polygon tile — the exact regression that
    // enumeration exists to prevent — and `estimateTileSize` undercounted
    // each such tile by 4 * (totalParts + 1) bytes against the memory budget.
    const tile = makeMinimalTile();
    const f = tile.layers[0].features;
    f.startIndices = new Uint32Array([0, 15, 20]);
    f.ringIndices = new Uint32Array([0, 5, 10, 15, 20]);
    f.partIndices = new Uint32Array([0, 10, 15, 20]);
    const transferables = collectTransferables(tile);
    expect(transferables).toContain(f.startIndices.buffer);
    expect(transferables).toContain(f.ringIndices.buffer);
    expect(transferables).toContain(f.partIndices.buffer);
  });

  it('counts partIndices toward the tile byte estimate', () => {
    // `estimateTileSize` is `forEachBufferView` + a per-layer constant, and
    // it feeds the cache budget / eviction: an unlisted column is a tile the
    // tileset believes is smaller than it is.
    const tile = makeMinimalTile();
    const before = estimateTileSize(tile);
    tile.layers[0].features.partIndices = new Uint32Array([0, 10, 15, 20]);
    expect(estimateTileSize(tile) - before).toBe(4 * 4);
  });

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
    (f.numericProps as Record<string, Float32Array | undefined>)['bad'] =
      undefined;
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
    (
      f.categoricalProps as Record<
        string,
        { indices: Uint16Array; categories: string[] } | undefined
      >
    )['bad'] = undefined;
    expect(() => collectTransferables(tile)).not.toThrow();
  });

  it('tolerates a layer with a missing features object', () => {
    // Forward compat: a tile that grew an extra (non-feature) layer shape
    // shouldn't crash the worker.
    const tile = makeMinimalTile();
    (tile.layers as any).push({
      name: 'broken',
      extent: 0,
      features: undefined,
    });
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

/**
 * EVERY field of {@link BinaryFeatures}, each buffer on its own backing
 * `ArrayBuffer`.
 *
 * The `Required<>` annotation is the load-bearing part: it is a COMPILE-TIME
 * exhaustiveness check, so adding an optional field to the interface — the
 * way `ringIndices` and then `partIndices` were added — fails `tsc` here
 * until the fixture is extended, at which point the runtime assertion below
 * fails until `forEachBufferView` learns about it too. Between them, the
 * "can never drift when a new column lands" claim in that function's doc is
 * enforced rather than merely asserted (both `ringIndices` and `partIndices`
 * were in fact missing from the hand-written enumeration this replaces).
 */
function everyFieldPopulated(): Required<BinaryFeatures> {
  return {
    featureCount: 2,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions: new Float64Array(4),
    featureIds: new Uint32Array(2),
    startTimes: new Float32Array(2),
    endTimes: new Float32Array(2),
    startIndices: new Uint32Array(3),
    ringIndices: new Uint32Array(4),
    partIndices: new Uint32Array(3),
    coordQuantStep: [1e-6, 1e-6],
    vertexTimestamps: new Float32Array(2),
    vertexValues: new Float32Array(2),
    vertexValueMatrix: new Float32Array(4),
    vertexValueBuckets: 2,
    globalFeatureIds: new Uint32Array(2),
    triangles: new Uint32Array(3),
    triangleOffsets: new Uint32Array(2),
    featureIds64: new BigUint64Array(2),
    timeOffset: 0,
    timesSorted: true,
    numericProps: { speed: new Float32Array(2) },
    vectorProps: { quat: { value: new Float32Array(8), size: 4 } },
    categoricalProps: {
      kind: { indices: new Uint16Array(2), categories: ['a'] },
    },
  };
}

describe('forEachBufferView (shared buffer enumeration)', () => {
  it('visits exactly the buffer set collectTransferables transfers (drift guard)', () => {
    const features = everyFieldPopulated();
    const tile: Tile = {
      id: { z: 0, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1 },
      layers: [{ name: 'l', extent: 0, features, geometryExtensionName: '' }],
    };
    const visited = new Set<ArrayBufferLike>();
    forEachBufferView(features, (v) => visited.add(v.buffer));
    const transferred = new Set(collectTransferables(tile));
    // collectTransferables = forEachBufferView + the Layer-level arrowIpc /
    // arrowIpcProps (absent on this synthetic layer), so the sets must be
    // identical.
    expect(new Set(transferred)).toEqual(visited);
    // And nothing was silently skipped: one buffer per populated field.
    expect(visited.size).toBe(17);
  });

  it('leaves no typed-array field of BinaryFeatures unvisited', () => {
    // The structural half of the guard: walk the fully-populated fixture and
    // demand that every value that IS a typed array was visited. A new
    // buffer column added to the interface (and therefore to the fixture,
    // which `Required<>` forces) fails here until it is enumerated.
    const features = everyFieldPopulated();
    const visited = new Set<ArrayBufferLike>();
    forEachBufferView(features, (v) => visited.add(v.buffer));
    const missed = Object.entries(features)
      .filter(([, v]) => ArrayBuffer.isView(v) && !visited.has(v.buffer))
      .map(([name]) => name);
    expect(missed).toEqual([]);
    // The nested record-valued fields, which the walk has to descend into.
    expect(visited.has(features.numericProps['speed'].buffer)).toBe(true);
    expect(visited.has(features.vectorProps['quat'].value.buffer)).toBe(true);
    expect(visited.has(features.categoricalProps['kind'].indices.buffer)).toBe(
      true,
    );
  });
});

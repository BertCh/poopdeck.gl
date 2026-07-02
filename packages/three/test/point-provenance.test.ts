import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile, TileId } from '@poopdeck.gl/core';
import { buildPointBuffers, pointTileKey } from '../src/layers/point-buffers';
import { resolvePointPick, parsePointTileKey } from '../src/lib/point-pick';
import { LocalEnuProjection } from '../src/projection/local-enu';
import type { RGBA } from '../src/lib/color';

const anchor = { longitude: -71.05, latitude: 42.35 };
const proj = new LocalEnuProjection(anchor);

function pointTile(
  id: TileId,
  layerName: string,
  positions: number[],
  partial: Partial<BinaryFeatures> = {},
): Tile {
  const count = positions.length / 2;
  const features: BinaryFeatures = {
    featureCount: count,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions: new Float64Array(positions),
    featureIds: new Uint32Array(count),
    startTimes: new Float32Array(count),
    endTimes: new Float32Array(count),
    timeOffset: id.t,
    numericProps: {},
    categoricalProps: {},
    vectorProps: {},
    ...partial,
  };
  return {
    id,
    timeRange: { start: id.t, end: id.t + 1000 },
    layers: [{ name: layerName, extent: 0, features, geometryExtensionName: 'geoarrow.point' }],
  };
}

const SEG: Record<string, RGBA> = { road: [80, 90, 120, 255], vehicle: [255, 158, 0, 255] };
const OPTS = {
  colorMode: { type: 'categorical' as const, property: 'seg_class', mapping: SEG, fallback: [0, 0, 0, 0] as RGBA },
  elevationProperty: 'z',
  elevationScale: 1,
};

// Two tiles, distinct ids/layer names. Merged order: tile A (2 pts, indices
// 0..1) then tile B (3 pts, indices 2..4). total = 5.
const idA: TileId = { z: 18, x: 1, y: 2, t: 0 };
const idB: TileId = { z: 18, x: 3, y: 4, t: 1000 };
const tileA = pointTile(idA, 'lidar', [anchor.longitude, anchor.latitude, anchor.longitude + 0.001, anchor.latitude], {
  numericProps: { z: new Float32Array([0, 0]) },
  categoricalProps: { seg_class: { indices: new Uint16Array([0, 1]), categories: ['road', 'vehicle'] } },
});
const tileB = pointTile(
  idB,
  'lidar',
  [
    anchor.longitude + 0.002, anchor.latitude + 0.002,
    anchor.longitude + 0.003, anchor.latitude + 0.003,
    anchor.longitude + 0.004, anchor.latitude + 0.005, // the last (merged index 4)
  ],
  {
    numericProps: { z: new Float32Array([0, 0, 0]), mag: new Float32Array([1, 2, 9]) },
    featureIds: new Uint32Array([100, 101, 102]),
  },
);

describe('buildPointBuffers provenance', () => {
  it('records one provenance entry per merged instance, in emit order', () => {
    const buf = buildPointBuffers([tileA, tileB], proj, 0, OPTS);
    expect(buf.count).toBe(5);
    expect(buf.provenance.length).toBe(5);

    // First point → tile A feature 0.
    expect(buf.provenance.resolve(0)).toEqual({ tileKey: pointTileKey(idA, 'lidar'), featureIndex: 0 });
    // Boundary: last of tile A, first of tile B.
    expect(buf.provenance.resolve(1)).toEqual({ tileKey: pointTileKey(idA, 'lidar'), featureIndex: 1 });
    expect(buf.provenance.resolve(2)).toEqual({ tileKey: pointTileKey(idB, 'lidar'), featureIndex: 0 });
    // Last point → tile B feature 2.
    expect(buf.provenance.resolve(4)).toEqual({ tileKey: pointTileKey(idB, 'lidar'), featureIndex: 2 });
    // Out of range → null.
    expect(buf.provenance.resolve(5)).toBeNull();
    expect(buf.provenance.resolve(-1)).toBeNull();
  });

  it('exposes tileKey → source BinaryFeatures for join-back', () => {
    const buf = buildPointBuffers([tileA, tileB], proj, 0, OPTS);
    expect(buf.binaryByTileKey.get(pointTileKey(idA, 'lidar'))).toBe(tileA.layers[0].features);
    expect(buf.binaryByTileKey.get(pointTileKey(idB, 'lidar'))).toBe(tileB.layers[0].features);
    expect(buf.binaryByTileKey.size).toBe(2);
  });

  it('returns empty (non-null) pick buffers when no points merge', () => {
    const buf = buildPointBuffers([], proj, 0, OPTS);
    expect(buf.count).toBe(0);
    expect(buf.provenance.length).toBe(0);
    expect(buf.provenance.resolve(0)).toBeNull();
    expect(buf.binaryByTileKey.size).toBe(0);
  });
});

describe('resolvePointPick', () => {
  it('resolves a merged index to feature props, coordinate, and tileId (last point)', () => {
    const buf = buildPointBuffers([tileA, tileB], proj, 0, OPTS);
    const hit = resolvePointPick({
      index: 4, // last merged instance → tile B feature 2
      provenance: buf.provenance,
      binaryByTileKey: buf.binaryByTileKey,
      layerId: 'points',
      screen: [12, 34],
    });
    expect(hit).not.toBeNull();
    // index is the FEATURE index within its (tile, layer), not the merged index.
    expect(hit!.index).toBe(2);
    expect(hit!.layerId).toBe('points');
    expect(hit!.tileId).toEqual(idB);
    expect(hit!.screen).toEqual([12, 34]);
    // Coordinate = the feature's own lon/lat.
    expect(hit!.coordinate![0]).toBeCloseTo(anchor.longitude + 0.004, 9);
    expect(hit!.coordinate![1]).toBeCloseTo(anchor.latitude + 0.005, 9);
    // Feature properties joined back through getFeatureProperties.
    expect(hit!.object).not.toBeNull();
    expect(hit!.object!.id).toBe(102);
    expect(hit!.object!.mag).toBeCloseTo(9, 5);
  });

  it('resolves the first point of the first tile', () => {
    const buf = buildPointBuffers([tileA, tileB], proj, 0, OPTS);
    const hit = resolvePointPick({
      index: 0,
      provenance: buf.provenance,
      binaryByTileKey: buf.binaryByTileKey,
      layerId: 'points',
    });
    expect(hit!.index).toBe(0);
    expect(hit!.tileId).toEqual(idA);
    expect(hit!.coordinate![0]).toBeCloseTo(anchor.longitude, 9);
    expect(hit!.object!.seg_class).toBe('road');
    expect(hit!.screen).toBeUndefined();
  });

  it('returns null for an out-of-range index (background / stale pick)', () => {
    const buf = buildPointBuffers([tileA, tileB], proj, 0, OPTS);
    expect(
      resolvePointPick({ index: 99, provenance: buf.provenance, binaryByTileKey: buf.binaryByTileKey, layerId: 'points' }),
    ).toBeNull();
  });

  it('returns null when the tileKey is absent from the binary map', () => {
    const buf = buildPointBuffers([tileA], proj, 0, OPTS);
    // Provenance from a 2-point layer, but an empty binary map → unresolvable.
    expect(
      resolvePointPick({ index: 0, provenance: buf.provenance, binaryByTileKey: new Map(), layerId: 'points' }),
    ).toBeNull();
  });
});

describe('parsePointTileKey', () => {
  it('round-trips pointTileKey', () => {
    expect(parsePointTileKey(pointTileKey(idB, 'lidar'))).toEqual(idB);
  });

  it('returns undefined for a malformed key', () => {
    expect(parsePointTileKey('not/a/key')).toBeUndefined();
    expect(parsePointTileKey('a/b/c/d::layer')).toBeUndefined();
  });
});

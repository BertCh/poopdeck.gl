// @poopdeck.gl/three
// SPDX-License-Identifier: MIT

/**
 * Pure-logic tests for the point-cloud pick chain, over ONE merged two-tile
 * fixture. Two seams share it:
 *
 *  - PROVENANCE — `buildPointBuffers` records one provenance entry per merged
 *    instance (in emit order), exposes `tileKey → source BinaryFeatures`, and
 *    `resolvePointPick` / `parsePointTileKey` join a merged index back to a
 *    feature's props, coordinate, and tileId.
 *  - HOVER/CLICK — the tail that turns a GPU id-buffer readback into an
 *    `STTIdPickInfo`. We exercise the WHOLE pure chain: merged buffers →
 *    `buildIdColors` (the exact per-instance id the id material paints) →
 *    `decodeId` (what `GpuPicker` reads back from a texel) → the generalised
 *    `resolveIdPick` (kind `'point'`). The GPU render +
 *    `readRenderTargetPixelsAsync` readback itself needs a live device and is
 *    BROWSER-VERIFY per this package's test policy (see `vitest.config.ts`);
 *    here we substitute the readback with the same `buildIdColors`/`decodeId`
 *    math the shader uses.
 */

import { describe, it, expect } from 'vitest';
import type { BinaryFeatures, TileId } from '@poopdeck.gl/core';
import { buildPointBuffers, pointTileKey } from '../src/layers/point-buffers';
import { resolvePointPick, parsePointTileKey } from '../src/lib/point-pick';
import { resolveIdPick } from '../src/lib/id-pick';
import { buildIdColors, decodeId } from '../src/lib/gpu-pick';
import { LocalEnuProjection } from '../src/projection/local-enu';
import type { RGBA } from '../src/lib/color';
import { makePointTile } from './_support/features';

const anchor = { longitude: -73.98, latitude: 40.75 };
const proj = new LocalEnuProjection(anchor);

const pointTile = (
  id: TileId,
  layerName: string,
  positions: number[],
  partial: Partial<BinaryFeatures> = {},
) =>
  makePointTile(positions.length / 2, positions, partial, {
    id,
    layerName,
    timeOffset: id.t,
  });

const CLASS: Record<string, RGBA> = {
  ground: [80, 90, 120, 255],
  veg: [40, 200, 80, 255],
};
const OPTS = {
  colorMode: {
    type: 'categorical' as const,
    property: 'cls',
    mapping: CLASS,
    fallback: [0, 0, 0, 0] as RGBA,
  },
  elevationProperty: 'z',
  elevationScale: 1,
};

// One merged fixture: tile A (2 pts → merged 0,1) then tile B (3 pts → merged
// 2,3,4). total = 5. A carries BOTH categorical columns the two seams read back
// (`seg_class` for provenance, `cls` for hover); B carries both numeric columns
// (`mag` for provenance, `intensity` for hover) plus explicit featureIds.
const idA: TileId = { z: 16, x: 5, y: 6, t: 0 };
const idB: TileId = { z: 16, x: 7, y: 8, t: 500 };
const tileA = pointTile(
  idA,
  'lidar',
  [
    anchor.longitude,
    anchor.latitude,
    anchor.longitude + 0.001,
    anchor.latitude,
  ],
  {
    numericProps: { z: new Float32Array([0, 0]) },
    categoricalProps: {
      seg_class: {
        indices: new Uint16Array([0, 1]),
        categories: ['road', 'vehicle'],
      },
      cls: { indices: new Uint16Array([0, 1]), categories: ['ground', 'veg'] },
    },
  },
);
const tileB = pointTile(
  idB,
  'lidar',
  [
    anchor.longitude + 0.002,
    anchor.latitude + 0.001,
    anchor.longitude + 0.003,
    anchor.latitude + 0.002,
    anchor.longitude + 0.004,
    anchor.latitude + 0.003, // the last (merged index 4)
  ],
  {
    numericProps: {
      z: new Float32Array([0, 0, 0]),
      mag: new Float32Array([1, 2, 9]),
      intensity: new Float32Array([10, 20, 30]),
    },
    featureIds: new Uint32Array([200, 201, 202]),
  },
);

/** Simulate one GPU readback texel for merged instance `i`: the exact id colour
 *  the shader paints (`buildIdColors`) fed through the picker's `decodeId`. */
function decodeMergedTexel(idColors: Float32Array, i: number): number {
  const r = Math.round(idColors[i * 3] * 255);
  const g = Math.round(idColors[i * 3 + 1] * 255);
  const b = Math.round(idColors[i * 3 + 2] * 255);
  return decodeId([r, g, b]);
}

describe('buildPointBuffers provenance', () => {
  it('records one provenance entry per merged instance, in emit order', () => {
    const buf = buildPointBuffers([tileA, tileB], proj, 0, OPTS);
    expect(buf.count).toBe(5);
    expect(buf.provenance.length).toBe(5);

    // First point → tile A feature 0.
    expect(buf.provenance.resolve(0)).toEqual({
      tileKey: pointTileKey(idA, 'lidar'),
      featureIndex: 0,
    });
    // Boundary: last of tile A, first of tile B.
    expect(buf.provenance.resolve(1)).toEqual({
      tileKey: pointTileKey(idA, 'lidar'),
      featureIndex: 1,
    });
    expect(buf.provenance.resolve(2)).toEqual({
      tileKey: pointTileKey(idB, 'lidar'),
      featureIndex: 0,
    });
    // Last point → tile B feature 2.
    expect(buf.provenance.resolve(4)).toEqual({
      tileKey: pointTileKey(idB, 'lidar'),
      featureIndex: 2,
    });
    // Out of range → null.
    expect(buf.provenance.resolve(5)).toBeNull();
    expect(buf.provenance.resolve(-1)).toBeNull();
  });

  it('exposes tileKey → source BinaryFeatures for join-back', () => {
    const buf = buildPointBuffers([tileA, tileB], proj, 0, OPTS);
    expect(buf.binaryByTileKey.get(pointTileKey(idA, 'lidar'))).toBe(
      tileA.layers[0].features,
    );
    expect(buf.binaryByTileKey.get(pointTileKey(idB, 'lidar'))).toBe(
      tileB.layers[0].features,
    );
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
    expect(hit!.coordinate![1]).toBeCloseTo(anchor.latitude + 0.003, 9);
    // Feature properties joined back through getFeatureProperties.
    expect(hit!.object).not.toBeNull();
    expect(hit!.object!.id).toBe(202);
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
      resolvePointPick({
        index: 99,
        provenance: buf.provenance,
        binaryByTileKey: buf.binaryByTileKey,
        layerId: 'points',
      }),
    ).toBeNull();
  });

  it('returns null when the tileKey is absent from the binary map', () => {
    const buf = buildPointBuffers([tileA], proj, 0, OPTS);
    // Provenance from a 2-point layer, but an empty binary map → unresolvable.
    expect(
      resolvePointPick({
        index: 0,
        provenance: buf.provenance,
        binaryByTileKey: new Map(),
        layerId: 'points',
      }),
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

describe('end-to-end id readback → STTIdPickInfo (pure chain, kind:"point")', () => {
  it('resolves every merged instance through encode → decode → resolveIdPick', () => {
    const buf = buildPointBuffers([tileA, tileB], proj, 0, OPTS);
    expect(buf.count).toBe(5);
    const idColors = buildIdColors(buf.provenance.length);

    // Merged 0 → tile A feature 0 (ground).
    const hit0 = resolveIdPick({
      index: decodeMergedTexel(idColors, 0),
      provenance: buf.provenance,
      binaryByTileKey: buf.binaryByTileKey,
      kind: 'point',
      layerId: 'points',
    })!;
    expect(hit0.kind).toBe('point');
    expect(hit0.featureIndex).toBe(0);
    expect(hit0.index).toBe(0); // back-compat alias of featureIndex
    expect(hit0.tileKey).toBe(pointTileKey(idA, 'lidar'));
    expect(hit0.tileId).toEqual(idA);
    expect(hit0.object!.cls).toBe('ground');
    expect(hit0.coordinate![0]).toBeCloseTo(anchor.longitude, 9);

    // Merged 4 → tile B feature 2 (last point). Its id colour must decode back to 4.
    expect(decodeMergedTexel(idColors, 4)).toBe(4);
    const hit4 = resolveIdPick({
      index: decodeMergedTexel(idColors, 4),
      provenance: buf.provenance,
      binaryByTileKey: buf.binaryByTileKey,
      kind: 'point',
      layerId: 'points',
      screen: [7, 8],
    })!;
    expect(hit4.featureIndex).toBe(2); // FEATURE index within its (tile, layer)
    expect(hit4.tileKey).toBe(pointTileKey(idB, 'lidar'));
    expect(hit4.tileId).toEqual(idB);
    expect(hit4.object!.id).toBe(202);
    expect(hit4.object!.intensity).toBeCloseTo(30, 5);
    expect(hit4.coordinate![0]).toBeCloseTo(anchor.longitude + 0.004, 9);
    expect(hit4.coordinate![1]).toBeCloseTo(anchor.latitude + 0.003, 9);
    expect(hit4.screen).toEqual([7, 8]);
  });

  it('reports a background / out-of-range readback as a miss (null resolution)', () => {
    const buf = buildPointBuffers([tileA, tileB], proj, 0, OPTS);
    // A sentinel background texel decodes to MAX_PICK_ID ≫ featureCount.
    const bgIndex = decodeId([255, 255, 255]);
    expect(bgIndex).toBeGreaterThan(buf.provenance.length);
    const miss = resolveIdPick({
      index: bgIndex,
      provenance: buf.provenance,
      binaryByTileKey: buf.binaryByTileKey,
      kind: 'point',
      layerId: 'points',
    });
    expect(miss).toBeNull(); // → the controller reports `null`
  });

  it('keeps merged index 0 a valid feature (black texel is NOT a background sentinel)', () => {
    const buf = buildPointBuffers([tileA, tileB], proj, 0, OPTS);
    // Feature 0 encodes to black (0,0,0); the sentinel-clear picker path (not
    // black) is what distinguishes it from an empty pixel, so index 0 resolves.
    expect(decodeMergedTexel(buildIdColors(buf.provenance.length), 0)).toBe(0);
    const hit = resolveIdPick({
      index: 0,
      provenance: buf.provenance,
      binaryByTileKey: buf.binaryByTileKey,
      kind: 'point',
      layerId: 'points',
    });
    expect(hit).not.toBeNull();
    expect(hit!.tileId).toEqual(idA);
  });
});

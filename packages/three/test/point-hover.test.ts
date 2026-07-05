// @poopdeck.gl/three
// SPDX-License-Identifier: MIT

/**
 * Pure-logic tests for the point-cloud hover/click resolution chain: the tail
 * that turns a GPU id-buffer readback into an `SttPointPickInfo` for `onPick` /
 * `onHover`. We exercise the WHOLE pure chain — build merged buffers →
 * `buildIdColors` (the exact per-instance id the id material paints) → `decodeId`
 * (what `GpuPicker` reads back from a texel) → `resolvePointPick` → `pointPickToInfo`
 * — so a break anywhere in the encode/decode/provenance/mapping seam is caught.
 *
 * The GPU render + `readRenderTargetPixelsAsync` readback itself needs a live
 * device and is BROWSER-VERIFY per this package's test policy (see
 * `vitest.config.ts`); here we substitute the readback with the same
 * `buildIdColors`/`decodeId` math the shader uses, which is unit-testable.
 */

import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile, TileId } from '@poopdeck.gl/core';
import { buildPointBuffers, pointTileKey } from '../src/layers/point-buffers';
import { resolvePointPick, pointPickToInfo } from '../src/lib/point-pick';
import { buildIdColors, decodeId } from '../src/lib/gpu-pick';
import { LocalEnuProjection } from '../src/projection/local-enu';
import type { RGBA } from '../src/lib/color';
import type { SttPickResult } from '@poopdeck.gl/core/picking';

const anchor = { longitude: -73.98, latitude: 40.75 };
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

const CLASS: Record<string, RGBA> = { ground: [80, 90, 120, 255], veg: [40, 200, 80, 255] };
const OPTS = {
  colorMode: { type: 'categorical' as const, property: 'cls', mapping: CLASS, fallback: [0, 0, 0, 0] as RGBA },
  elevationProperty: 'z',
  elevationScale: 1,
};

// Two tiles: A (2 pts → merged 0,1), B (3 pts → merged 2,3,4). total = 5.
const idA: TileId = { z: 16, x: 5, y: 6, t: 0 };
const idB: TileId = { z: 16, x: 7, y: 8, t: 500 };
const tileA = pointTile(idA, 'lidar', [anchor.longitude, anchor.latitude, anchor.longitude + 0.001, anchor.latitude], {
  numericProps: { z: new Float32Array([0, 0]) },
  categoricalProps: { cls: { indices: new Uint16Array([0, 1]), categories: ['ground', 'veg'] } },
});
const tileB = pointTile(
  idB,
  'lidar',
  [
    anchor.longitude + 0.002, anchor.latitude + 0.001,
    anchor.longitude + 0.003, anchor.latitude + 0.002,
    anchor.longitude + 0.004, anchor.latitude + 0.003,
  ],
  {
    numericProps: { z: new Float32Array([0, 0, 0]), intensity: new Float32Array([10, 20, 30]) },
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

describe('pointPickToInfo', () => {
  const base: SttPickResult = {
    object: { intensity: 30, id: 202 },
    index: 2,
    layerId: 'points',
    coordinate: [anchor.longitude + 0.004, anchor.latitude + 0.003],
    tileId: idB,
    screen: [12, 34],
  };

  it('maps a resolved SttPickResult into a kind:"point" SttPointPickInfo', () => {
    const info = pointPickToInfo(base);
    expect(info.kind).toBe('point');
    expect(info.layerId).toBe('points');
    expect(info.index).toBe(2);
    expect(info.object).toEqual({ intensity: 30, id: 202 });
    expect(info.coordinate).toEqual([anchor.longitude + 0.004, anchor.latitude + 0.003]);
    expect(info.tileId).toEqual(idB);
  });

  it('omits coordinate/tileId when the result lacks them', () => {
    const info = pointPickToInfo({ object: null, index: -1, layerId: 'points' });
    expect(info.kind).toBe('point');
    expect(info.object).toBeNull();
    expect(info.index).toBe(-1);
    expect('coordinate' in info).toBe(false);
    expect('tileId' in info).toBe(false);
  });
});

describe('end-to-end id readback → SttPointPickInfo (pure chain)', () => {
  it('resolves every merged instance through encode → decode → resolve → map', () => {
    const buf = buildPointBuffers([tileA, tileB], proj, 0, OPTS);
    expect(buf.count).toBe(5);
    const idColors = buildIdColors(buf.provenance.length);

    // Merged 0 → tile A feature 0 (ground).
    let hit = pointPickToInfo(
      resolvePointPick({
        index: decodeMergedTexel(idColors, 0),
        provenance: buf.provenance,
        binaryByTileKey: buf.binaryByTileKey,
        layerId: 'points',
      })!,
    );
    expect(hit.kind).toBe('point');
    expect(hit.index).toBe(0);
    expect(hit.tileId).toEqual(idA);
    expect(hit.object!.cls).toBe('ground');
    expect(hit.coordinate![0]).toBeCloseTo(anchor.longitude, 9);

    // Merged 4 → tile B feature 2 (last point). Its id colour must decode back to 4.
    expect(decodeMergedTexel(idColors, 4)).toBe(4);
    const result = resolvePointPick({
      index: decodeMergedTexel(idColors, 4),
      provenance: buf.provenance,
      binaryByTileKey: buf.binaryByTileKey,
      layerId: 'points',
      screen: [7, 8],
    })!;
    hit = pointPickToInfo(result);
    expect(hit.index).toBe(2); // FEATURE index within its (tile, layer)
    expect(hit.tileId).toEqual(idB);
    expect(hit.object!.id).toBe(202);
    expect(hit.object!.intensity).toBeCloseTo(30, 5);
    expect(hit.coordinate![0]).toBeCloseTo(anchor.longitude + 0.004, 9);
    expect(hit.coordinate![1]).toBeCloseTo(anchor.latitude + 0.003, 9);
  });

  it('reports a background / out-of-range readback as a miss (null resolution)', () => {
    const buf = buildPointBuffers([tileA, tileB], proj, 0, OPTS);
    // A sentinel background texel decodes to MAX_PICK_ID ≫ featureCount.
    const bgIndex = decodeId([255, 255, 255]);
    expect(bgIndex).toBeGreaterThan(buf.provenance.length);
    const miss = resolvePointPick({
      index: bgIndex,
      provenance: buf.provenance,
      binaryByTileKey: buf.binaryByTileKey,
      layerId: 'points',
    });
    expect(miss).toBeNull(); // → the controller reports `null`, never calls pointPickToInfo
  });

  it('keeps merged index 0 a valid feature (black texel is NOT a background sentinel)', () => {
    const buf = buildPointBuffers([tileA, tileB], proj, 0, OPTS);
    // Feature 0 encodes to black (0,0,0); the sentinel-clear picker path (not
    // black) is what distinguishes it from an empty pixel, so index 0 resolves.
    expect(decodeMergedTexel(buildIdColors(buf.provenance.length), 0)).toBe(0);
    const hit = resolvePointPick({
      index: 0,
      provenance: buf.provenance,
      binaryByTileKey: buf.binaryByTileKey,
      layerId: 'points',
    });
    expect(hit).not.toBeNull();
    expect(hit!.tileId).toEqual(idA);
  });
});

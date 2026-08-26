// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// The GPU id-buffer picking CATALOG contract — the kind-agnostic seam every
// instanced layer shares (`../src/lib/id-pick.ts`). Covers the three pieces a
// fanout agent relies on:
//   • `isIdPickable` — the auto-registration signal (structural `pick()` test).
//   • `featureTileKey` / `parseIdTileKey` — the provenance key round-trip.
//   • `resolveIdPick` — merged index → kind-tagged `STTIdPickInfo`, including the
//     geometry-aware coordinate (Point vs indexed) and the miss paths.
// The per-kind proofs (column + arc: provenance emission, id materials, full
// `layer.pick()` dispatch) live in `column-arc-pick.test.ts`.

import { describe, it, expect } from 'vitest';
import type { BinaryFeatures, TileId } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import { InstanceProvenance } from '@poopdeck.gl/core/picking';
import {
  isIdPickable,
  featureTileKey,
  parseIdTileKey,
  resolveIdPick,
} from '../src/lib/id-pick';
import { STTColumnLayer } from '../src/layers/column-layer';
import { STTArcLayer } from '../src/layers/arc-layer';
import { STTPointLayer } from '../src/layers/point-layer';
import { STTPolygonLayer } from '../src/layers/polygon-layer';
import { STTIsoLayer } from '../src/layers/iso-layer';

describe('isIdPickable (auto-registration signal)', () => {
  it('is true for anything exposing a pick() method', () => {
    expect(isIdPickable({ pick() {} })).toBe(true);
    // The real instanced layers all satisfy it (constructor-only, no GPU).
    expect(isIdPickable(new STTPointLayer())).toBe(true);
    expect(
      isIdPickable(
        new STTColumnLayer({
          colorMode: { type: 'constant', color: [1, 2, 3, 255] },
        }),
      ),
    ).toBe(true);
    expect(isIdPickable(new STTArcLayer())).toBe(true);
    // The MERGED-mesh kinds satisfy it too, so the r3f mount auto-registers them
    // with no per-kind wiring (they never touch r3f/index.tsx).
    expect(isIdPickable(new STTPolygonLayer())).toBe(true);
    expect(isIdPickable(new STTIsoLayer())).toBe(true);
  });

  it('is false for box pickables (getPickBoxes) and non-pickables', () => {
    expect(isIdPickable({ getPickBoxes() {} })).toBe(false);
    expect(isIdPickable({})).toBe(false);
    expect(isIdPickable(null)).toBe(false);
    expect(isIdPickable(undefined)).toBe(false);
    expect(isIdPickable({ pick: 42 })).toBe(false); // a `pick` field, not a method
  });
});

describe('featureTileKey / parseIdTileKey', () => {
  it('round-trips a (tile, layer) key', () => {
    const id: TileId = { z: 14, x: 3, y: 9, t: 500 };
    const key = featureTileKey(id, 'flows');
    // `#0` is the raw variant the canonical key always spells out (v3's
    // variant axis); parsing therefore reports it back explicitly.
    expect(key).toBe('14/3/9/500#0::flows');
    expect(parseIdTileKey(key)).toEqual({ ...id, variantId: 0 });
  });

  it('returns undefined for a malformed key', () => {
    expect(parseIdTileKey('not/a/key')).toBeUndefined();
    expect(parseIdTileKey('a/b/c/d::layer')).toBeUndefined();
    expect(parseIdTileKey('1/2/3::layer')).toBeUndefined(); // only 3 coords
  });
});

// A hand-built provenance + binary map isolates `resolveIdPick`'s resolution and
// its geometry-aware coordinate (Point → vertex i; indexed → startIndices[i]).
function pointBinary(): BinaryFeatures {
  return {
    featureCount: 2,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions: new Float64Array([-73.98, 40.75, -73.9, 40.8]),
    featureIds: new Uint32Array([7, 8]),
    startTimes: new Float32Array([0, 0]),
    endTimes: new Float32Array([1, 1]),
    timeOffset: 0,
    numericProps: { mag: new Float32Array([3, 9]) },
    categoricalProps: {},
    vectorProps: {},
  };
}

function lineBinary(): BinaryFeatures {
  // 2 LineStrings, 2 vertices each. Feature 1's SOURCE (first) vertex is index 2.
  return {
    featureCount: 2,
    geometryType: GeometryType.LineString,
    positionDimensions: 2,
    positions: new Float64Array([
      -73.98,
      40.75,
      -73.9,
      40.8, // feature 0: src, tgt
      -74.1,
      40.6,
      -74.0,
      40.65, // feature 1: src (idx 2), tgt (idx 3)
    ]),
    featureIds: new Uint32Array([100, 101]),
    startTimes: new Float32Array([0, 0]),
    endTimes: new Float32Array([1, 1]),
    startIndices: new Uint32Array([0, 2, 4]),
    timeOffset: 0,
    numericProps: {},
    categoricalProps: {},
    vectorProps: {},
  };
}

describe('resolveIdPick', () => {
  it('resolves a Point-geometry hit to feature i vertex + kind/tileKey/index', () => {
    const key = featureTileKey({ z: 12, x: 1, y: 2, t: 0 }, 'quakes');
    const prov = new InstanceProvenance();
    prov.push(key, 0);
    prov.push(key, 1);
    const map = new Map([[key, pointBinary()]]);

    const hit = resolveIdPick({
      index: 1,
      provenance: prov,
      binaryByTileKey: map,
      kind: 'column',
      layerId: 'columns',
    })!;
    expect(hit.kind).toBe('column');
    expect(hit.layerId).toBe('columns');
    expect(hit.tileKey).toBe(key);
    expect(hit.featureIndex).toBe(1);
    expect(hit.index).toBe(1);
    expect(hit.tileId).toEqual({ z: 12, x: 1, y: 2, t: 0, variantId: 0 });
    // Point geometry → coordinate is feature i's own vertex.
    expect(hit.coordinate).toEqual([-73.9, 40.8]);
    expect(hit.object!.mag).toBeCloseTo(9, 5);
    expect(hit.object!.id).toBe(8);
  });

  it('resolves an indexed (LineString) hit to the feature FIRST vertex (source)', () => {
    const key = featureTileKey({ z: 14, x: 5, y: 6, t: 0 }, 'flows');
    const prov = new InstanceProvenance();
    prov.push(key, 0);
    prov.push(key, 1);
    const map = new Map([[key, lineBinary()]]);

    const hit = resolveIdPick({
      index: 1, // arc feature 1
      provenance: prov,
      binaryByTileKey: map,
      kind: 'arc',
      layerId: 'arc',
    })!;
    expect(hit.kind).toBe('arc');
    expect(hit.featureIndex).toBe(1);
    // Indexed geometry → coordinate is the feature's first vertex (startIndices[1] = 2).
    expect(hit.coordinate).toEqual([-74.1, 40.6]);
    expect(hit.object!.id).toBe(101);
  });

  it('returns null for out-of-range, unknown tileKey, and echoes screen', () => {
    const key = featureTileKey({ z: 12, x: 1, y: 2, t: 0 }, 'quakes');
    const prov = new InstanceProvenance();
    prov.push(key, 0);
    const map = new Map([[key, pointBinary()]]);

    expect(
      resolveIdPick({
        index: 9,
        provenance: prov,
        binaryByTileKey: map,
        kind: 'column',
        layerId: 'c',
      }),
    ).toBeNull(); // out of range
    expect(
      resolveIdPick({
        index: 0,
        provenance: prov,
        binaryByTileKey: new Map(),
        kind: 'column',
        layerId: 'c',
      }),
    ).toBeNull(); // unknown tileKey

    const hit = resolveIdPick({
      index: 0,
      provenance: prov,
      binaryByTileKey: map,
      kind: 'column',
      layerId: 'c',
      screen: [11, 22],
    })!;
    expect(hit.screen).toEqual([11, 22]);
  });
});

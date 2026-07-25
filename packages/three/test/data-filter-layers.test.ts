// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// End-to-end LAYER wiring gate for the DataFilter feature family (arc, line,
// od-line, trips, column, polygon). GPU compilation is browser-verified; here we
// assert the LAYER glue: with a `filterProperty` set each layer (1) feeds it to
// its buffer builder → binds a per-instance / per-vertex `sttFilterValue`
// attribute carrying the column values, and (2) constructs a filter-ENABLED
// material (its bundle owns a `DataFilterUniforms`). With NO `filterProperty` the
// attribute is absent and no filter is installed — the static path is unchanged.
// The range math is proven in `data-filter-math.test.ts`, the material graphs in
// `data-filter-materials.test.ts`, and the builders in `data-filter-buffers.test.ts`.

import { describe, it, expect } from 'vitest';
import { Mesh } from 'three';
import type { BufferGeometry } from 'three';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { STTArcLayer } from '../src/layers/arc-layer';
import { STTWideLineLayer } from '../src/layers/wide-line-layer';
import { STTOdLineLayer } from '../src/layers/od-line-layer';
import { STTTripsLayer } from '../src/layers/trips-layer';
import { STTColumnLayer } from '../src/layers/column-layer';
import { STTPolygonLayer } from '../src/layers/polygon-layer';
import { DataFilterUniforms } from '../src/tsl/data-filter';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { makeLineTile, makePointTile } from './_support/features';

const anchor = { longitude: -71.05, latitude: 42.35 };
const proj = new LocalEnuProjection(anchor);
const ctx = { projection: proj, timeOrigin: 0 };
const CONST = { type: 'constant', color: [200, 200, 200, 255] } as const;

// Two 2-vertex LineString features (one segment / one OD pair / one arc each)
// carrying a `mag` numeric column [3, 7].
function twoFlows(): Partial<BinaryFeatures> {
  const d = 0.001;
  return {
    featureCount: 2,
    positions: new Float64Array([
      anchor.longitude,
      anchor.latitude,
      anchor.longitude + d,
      anchor.latitude,
      anchor.longitude,
      anchor.latitude,
      anchor.longitude,
      anchor.latitude + d,
    ]),
    startIndices: new Uint32Array([0, 2, 4]),
    startTimes: new Float32Array([0, 0]),
    endTimes: new Float32Array([1000, 1000]),
    numericProps: { mag: new Float32Array([3, 7]) },
  };
}
const lineTile = (): Tile => makeLineTile(twoFlows(), { layerName: 'lines' });

// A 4-vertex Polygon (square) with one feature carrying `mag` = 9.
function squarePoly(): Tile {
  const d = 0.0001;
  return makeLineTile(
    {
      positions: new Float64Array([
        anchor.longitude - d,
        anchor.latitude - d,
        anchor.longitude + d,
        anchor.latitude - d,
        anchor.longitude + d,
        anchor.latitude + d,
        anchor.longitude - d,
        anchor.latitude + d,
      ]),
      startIndices: new Uint32Array([0, 4]),
      startTimes: new Float32Array([0]),
      endTimes: new Float32Array([1000]),
      numericProps: { mag: new Float32Array([9]) },
    },
    {
      layerName: 'poly',
      geometryType: GeometryType.Polygon,
      geometryExtensionName: 'geoarrow.polygon',
    },
  );
}

// Two Point features with a `mag` column [3, 7].
function pointTile(): Tile {
  return makePointTile(
    2,
    [
      anchor.longitude,
      anchor.latitude,
      anchor.longitude + 0.001,
      anchor.latitude,
    ],
    {
      startTimes: new Float32Array([0, 0]),
      endTimes: new Float32Array([1000, 1000]),
      numericProps: { mag: new Float32Array([3, 7]) },
    },
  );
}

/** The private material bundle — the only place the installed filter is observable. */
function bundleFilter(layer: unknown): unknown {
  return (layer as { bundle: { filter?: unknown } }).bundle.filter;
}

function attr(geom: BufferGeometry, name: string) {
  return geom.getAttribute(name);
}

describe('STTArcLayer — DataFilter end-to-end', () => {
  it('binds sttFilterValue + a filter-enabled material when filterProperty is set', () => {
    const layer = new STTArcLayer({
      sourceColor: CONST,
      filterProperty: 'mag',
    });
    layer.setTiles([lineTile()], ctx);
    const geom = layer.object.geometry as BufferGeometry;
    const a = attr(geom, 'sttFilterValue');
    expect(a).toBeTruthy();
    expect(Array.from(a!.array)).toEqual([3, 7]); // per-arc value
    expect(bundleFilter(layer)).toBeInstanceOf(DataFilterUniforms);
    layer.dispose();
  });
  it('binds nothing + installs no filter without filterProperty', () => {
    const layer = new STTArcLayer({ sourceColor: CONST });
    layer.setTiles([lineTile()], ctx);
    expect(
      attr(layer.object.geometry as BufferGeometry, 'sttFilterValue'),
    ).toBeUndefined();
    expect(bundleFilter(layer)).toBeUndefined();
    layer.dispose();
  });
});

describe('STTWideLineLayer — DataFilter end-to-end', () => {
  it('binds sttFilterValue + a filter-enabled material when filterProperty is set', () => {
    const layer = new STTWideLineLayer({
      colorMode: CONST,
      mode: 'window',
      filterProperty: 'mag',
    });
    layer.setTiles([lineTile()], ctx);
    const a = attr(layer.object.geometry as BufferGeometry, 'sttFilterValue');
    expect(a).toBeTruthy();
    expect(Array.from(a!.array)).toEqual([3, 7]); // one segment per feature
    expect(bundleFilter(layer)).toBeInstanceOf(DataFilterUniforms);
    layer.dispose();
  });
  it('binds nothing + installs no filter without filterProperty', () => {
    const layer = new STTWideLineLayer({ colorMode: CONST, mode: 'window' });
    layer.setTiles([lineTile()], ctx);
    expect(
      attr(layer.object.geometry as BufferGeometry, 'sttFilterValue'),
    ).toBeUndefined();
    expect(bundleFilter(layer)).toBeUndefined();
    layer.dispose();
  });
});

describe('STTOdLineLayer — DataFilter end-to-end', () => {
  it('binds sttFilterValue + a filter-enabled material when filterProperty is set', () => {
    const layer = new STTOdLineLayer({
      colorMode: CONST,
      filterProperty: 'mag',
    });
    layer.setTiles([lineTile()], ctx);
    const a = attr(layer.object.geometry as BufferGeometry, 'sttFilterValue');
    expect(a).toBeTruthy();
    expect(Array.from(a!.array)).toEqual([3, 7]); // one OD pair per feature
    expect(bundleFilter(layer)).toBeInstanceOf(DataFilterUniforms);
    layer.dispose();
  });
  it('binds nothing + installs no filter without filterProperty', () => {
    const layer = new STTOdLineLayer({ colorMode: CONST });
    layer.setTiles([lineTile()], ctx);
    expect(
      attr(layer.object.geometry as BufferGeometry, 'sttFilterValue'),
    ).toBeUndefined();
    expect(bundleFilter(layer)).toBeUndefined();
    layer.dispose();
  });
});

describe('STTTripsLayer — DataFilter end-to-end', () => {
  it('binds sttFilterValue + a filter-enabled material when filterProperty is set', () => {
    const layer = new STTTripsLayer({
      colorMode: CONST,
      filterProperty: 'mag',
    });
    layer.setTiles([lineTile()], ctx);
    const a = attr(layer.object.geometry as BufferGeometry, 'sttFilterValue');
    expect(a).toBeTruthy();
    expect(Array.from(a!.array)).toEqual([3, 7]); // one segment per 2-vertex trip
    expect(bundleFilter(layer)).toBeInstanceOf(DataFilterUniforms);
    layer.dispose();
  });
  it('binds nothing + installs no filter without filterProperty', () => {
    const layer = new STTTripsLayer({ colorMode: CONST });
    layer.setTiles([lineTile()], ctx);
    expect(
      attr(layer.object.geometry as BufferGeometry, 'sttFilterValue'),
    ).toBeUndefined();
    expect(bundleFilter(layer)).toBeUndefined();
    layer.dispose();
  });
});

describe('STTColumnLayer — DataFilter end-to-end', () => {
  it('binds sttFilterValue + a filter-enabled material when filterProperty is set', () => {
    const layer = new STTColumnLayer({
      colorMode: CONST,
      filterProperty: 'mag',
    });
    layer.setTiles([pointTile()], ctx);
    const a = attr(layer.object.geometry as BufferGeometry, 'sttFilterValue');
    expect(a).toBeTruthy();
    expect(Array.from(a!.array)).toEqual([3, 7]); // per-column value
    expect(bundleFilter(layer)).toBeInstanceOf(DataFilterUniforms);
    layer.dispose();
  });
  it('binds nothing + installs no filter without filterProperty', () => {
    const layer = new STTColumnLayer({ colorMode: CONST });
    layer.setTiles([pointTile()], ctx);
    expect(
      attr(layer.object.geometry as BufferGeometry, 'sttFilterValue'),
    ).toBeUndefined();
    expect(bundleFilter(layer)).toBeUndefined();
    layer.dispose();
  });
});

describe('STTPolygonLayer — DataFilter end-to-end', () => {
  // The polygon material is built once in the ctor; its bundle is the layer field.
  function meshGeom(layer: STTPolygonLayer): BufferGeometry {
    return (layer.object.children[0] as Mesh).geometry;
  }
  it('binds per-vertex sttFilterValue + a filter-enabled material when filterProperty is set', () => {
    const layer = new STTPolygonLayer({
      colorMode: CONST,
      mode: 'none',
      filterProperty: 'mag',
    });
    layer.setTiles([squarePoly()], ctx);
    const a = attr(meshGeom(layer), 'sttFilterValue');
    expect(a).toBeTruthy();
    // A feature's value is written to every one of its mesh vertices (square → 4).
    expect(Array.from(a!.array)).toEqual([9, 9, 9, 9]);
    expect(bundleFilter(layer)).toBeInstanceOf(DataFilterUniforms);
    layer.dispose();
  });
  it('binds nothing + installs no filter without filterProperty (static map-decal path)', () => {
    const layer = new STTPolygonLayer({ colorMode: CONST, mode: 'none' });
    layer.setTiles([squarePoly()], ctx);
    expect(attr(meshGeom(layer), 'sttFilterValue')).toBeUndefined();
    expect(bundleFilter(layer)).toBeUndefined();
    layer.dispose();
  });
});

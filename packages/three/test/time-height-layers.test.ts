// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// End-to-end LAYER wiring gate for the time-as-height ("space-time cube") lift
// on the column + polygon kinds. GPU compilation is browser-verified; here we
// assert the LAYER glue: with `timeHeightScale` set each layer (1) feeds
// `timeHeight` to its buffer builder → binds a per-instance / per-vertex
// `sttLift` attribute (local up ÷ metersPerWorldUnit), and (2) constructs a
// lift-installed material (its bundle owns a `TimeHeightUniforms`) whose
// heightOrigin uniform is the ABSOLUTE timeHeightOrigin relativized against the
// layer timeOrigin. With NO `timeHeightScale` the attribute is absent and no
// lift is installed — the flat path is byte-identical. `timeHeightScale: 0`
// still installs the path (animatable) but renders flat (scale uniform 0). The
// lift geometry math is proven in `time-height-buffers.test.ts`, the material
// graphs in `time-height-materials.test.ts`.

import { describe, it, expect } from 'vitest';
import { Mesh } from 'three';
import type { BufferGeometry } from 'three';
import { GeometryType } from '@poopdeck.gl/core';
import type { Tile } from '@poopdeck.gl/core';
import { STTColumnLayer } from '../src/layers/column-layer';
import { STTPolygonLayer } from '../src/layers/polygon-layer';
import { TimeHeightUniforms as ColumnTimeHeightUniforms } from '../src/tsl/column-material';
import { TimeHeightUniforms as PolygonTimeHeightUniforms } from '../src/tsl/polygon-material';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { makeLineTile, makePointTile } from './_support/features';

const anchor = { longitude: -71.05, latitude: 42.35 };
const proj = new LocalEnuProjection(anchor);
const ctx = { projection: proj, timeOrigin: 0 };
const CONST = { type: 'constant', color: [200, 200, 200, 255] } as const;

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
    },
    {
      layerName: 'poly',
      geometryType: GeometryType.Polygon,
      geometryExtensionName: 'geoarrow.polygon',
    },
  );
}

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
    },
  );
}

/** The private material bundle — the only place the installed lift is observable. */
function bundleTimeHeight(layer: unknown): unknown {
  return (layer as { bundle: { timeHeight?: unknown } }).bundle?.timeHeight;
}

function attr(geom: BufferGeometry, name: string) {
  return geom.getAttribute(name);
}

describe('STTColumnLayer — time-as-height end-to-end', () => {
  it('binds sttLift + a lift-installed material when timeHeightScale is set', () => {
    const layer = new STTColumnLayer({
      colorMode: CONST,
      timeHeightScale: 0.5,
    });
    layer.setTiles([pointTile()], ctx);
    const geom = layer.object.geometry as BufferGeometry;
    const a = attr(geom, 'sttLift');
    expect(a).toBeTruthy();
    expect(a!.itemSize).toBe(3);
    // ENU up → +Z unit per instance.
    expect(Array.from(a!.array).slice(0, 3)).toEqual([0, 0, 1]);
    expect(bundleTimeHeight(layer)).toBeInstanceOf(ColumnTimeHeightUniforms);
    layer.dispose();
  });

  it('installs the lift even at timeHeightScale 0 (animatable), rendering flat', () => {
    const layer = new STTColumnLayer({ colorMode: CONST, timeHeightScale: 0 });
    layer.setTiles([pointTile()], ctx);
    expect(
      attr(layer.object.geometry as BufferGeometry, 'sttLift'),
    ).toBeTruthy();
    const th = bundleTimeHeight(layer) as ColumnTimeHeightUniforms;
    expect(th).toBeInstanceOf(ColumnTimeHeightUniforms);
    expect(th.heightScale.value).toBe(0); // flat until the caller animates it
    layer.dispose();
  });

  it('binds nothing + installs no lift without timeHeightScale', () => {
    const layer = new STTColumnLayer({ colorMode: CONST });
    layer.setTiles([pointTile()], ctx);
    expect(
      attr(layer.object.geometry as BufferGeometry, 'sttLift'),
    ).toBeUndefined();
    expect(bundleTimeHeight(layer)).toBeUndefined();
    layer.dispose();
  });

  it('relativizes timeHeightOrigin against the layer timeOrigin', () => {
    const layer = new STTColumnLayer({
      colorMode: CONST,
      timeHeightScale: 1,
      timeHeightOrigin: 5000,
    });
    layer.setTiles([pointTile()], { projection: proj, timeOrigin: 2000 });
    const th = bundleTimeHeight(layer) as ColumnTimeHeightUniforms;
    // heightOrigin uniform = absolute 5000 − timeOrigin 2000.
    expect(th.heightOrigin.value).toBe(3000);
    expect(th.heightScale.value).toBe(1);
    layer.dispose();
  });
});

describe('STTPolygonLayer — time-as-height end-to-end', () => {
  // The polygon material is built once in the ctor; its bundle is the layer field.
  function meshGeom(layer: STTPolygonLayer): BufferGeometry {
    return (layer.object.children[0] as Mesh).geometry;
  }

  it('binds per-vertex sttLift + a lift-installed material when timeHeightScale is set', () => {
    const layer = new STTPolygonLayer({
      colorMode: CONST,
      mode: 'window',
      timeHeightScale: 0.5,
    });
    layer.setTiles([squarePoly()], ctx);
    const a = attr(meshGeom(layer), 'sttLift');
    expect(a).toBeTruthy();
    expect(a!.itemSize).toBe(3);
    // A feature vector is written to every one of its mesh vertices (square → 4).
    expect(a!.count).toBe(4);
    expect(Array.from(a!.array).slice(0, 3)).toEqual([0, 0, 1]);
    expect(bundleTimeHeight(layer)).toBeInstanceOf(PolygonTimeHeightUniforms);
    layer.dispose();
  });

  it('lifts a static (none-mode) polygon too — the space-time-cube map decal', () => {
    const layer = new STTPolygonLayer({
      colorMode: CONST,
      mode: 'none',
      timeHeightScale: 0.25,
    });
    layer.setTiles([squarePoly()], ctx);
    expect(attr(meshGeom(layer), 'sttLift')).toBeTruthy();
    expect(bundleTimeHeight(layer)).toBeInstanceOf(PolygonTimeHeightUniforms);
    layer.dispose();
  });

  it('binds nothing + installs no lift without timeHeightScale (flat map-decal path)', () => {
    const layer = new STTPolygonLayer({ colorMode: CONST, mode: 'none' });
    layer.setTiles([squarePoly()], ctx);
    expect(attr(meshGeom(layer), 'sttLift')).toBeUndefined();
    expect(bundleTimeHeight(layer)).toBeUndefined();
    layer.dispose();
  });

  it('relativizes timeHeightOrigin against the layer timeOrigin', () => {
    const layer = new STTPolygonLayer({
      colorMode: CONST,
      mode: 'window',
      timeHeightScale: 1,
      timeHeightOrigin: 5000,
    });
    layer.setTiles([squarePoly()], { projection: proj, timeOrigin: 2000 });
    const th = bundleTimeHeight(layer) as PolygonTimeHeightUniforms;
    expect(th.heightOrigin.value).toBe(3000);
    expect(th.heightScale.value).toBe(1);
    layer.dispose();
  });
});

// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// The column + polygon buffer builders emit a per-instance / per-vertex `lift`
// array (the `sttLift` attribute the space-time-cube materials bind) sourced
// from the projection: local up ÷ metersPerWorldUnit = WORLD units per metre of
// altitude. The shader multiplies this by `(start − heightOrigin) × heightScale`
// to raise each feature by its time. One vec3 per column instance; per polygon
// VERTEX (a feature's vector repeated to every mesh vertex, base + top). A
// 0-length array when `timeHeight` is off (the attribute is simply not bound).

import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures } from '@poopdeck.gl/core';
import { buildColumnBuffers } from '../src/lib/column-buffers';
import { buildPolygonBuffers } from '../src/layers/polygon-buffers';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { MercatorProjection } from '../src/projection/mercator';

const anchor = { longitude: -71.05, latitude: 42.35 };
const proj = new LocalEnuProjection(anchor);
const CONST = { type: 'constant', color: [200, 200, 200, 255] } as const;

function square(d = 0.0001): number[] {
  return [
    anchor.longitude - d,
    anchor.latitude - d,
    anchor.longitude + d,
    anchor.latitude - d,
    anchor.longitude + d,
    anchor.latitude + d,
    anchor.longitude - d,
    anchor.latitude + d,
  ];
}

function polyTile(partial: Partial<BinaryFeatures>) {
  const base: Partial<BinaryFeatures> = {
    positions: new Float64Array(square()),
    startIndices: new Uint32Array([0, 4]),
    ...partial,
  };
  return {
    id: { z: 12, x: 0, y: 0, t: 0 },
    timeRange: { start: 0, end: 1000 },
    layers: [
      {
        name: 'poly',
        extent: 0,
        features: {
          featureCount: 1,
          geometryType: GeometryType.Polygon,
          positionDimensions: 2,
          featureIds: new Uint32Array(1),
          startTimes: new Float32Array(1),
          endTimes: new Float32Array(1),
          timeOffset: 0,
          numericProps: {},
          categoricalProps: {},
          vectorProps: {},
          ...base,
        } as BinaryFeatures,
        geometryExtensionName: 'geoarrow.polygon',
      },
    ],
  };
}

function pointTile(count: number, positions: number[]) {
  return {
    id: { z: 12, x: 0, y: 0, t: 0 },
    timeRange: { start: 0, end: 1000 },
    layers: [
      {
        name: 'points',
        extent: 0,
        features: {
          featureCount: count,
          geometryType: GeometryType.Point,
          positionDimensions: 2,
          positions: new Float64Array(positions),
          featureIds: new Uint32Array(count),
          startTimes: new Float32Array(count),
          endTimes: new Float32Array(count),
          timeOffset: 0,
          numericProps: {},
          categoricalProps: {},
          vectorProps: {},
        } as BinaryFeatures,
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
}

describe('column buffers — lift (per column instance)', () => {
  it('emits one world-up-per-metre vec3 per feature (ENU → +Z unit)', () => {
    const buf = buildColumnBuffers(
      [
        pointTile(2, [
          anchor.longitude,
          anchor.latitude,
          anchor.longitude,
          anchor.latitude,
        ]),
      ],
      proj,
      0,
      { colorMode: CONST, timeHeight: true },
    );
    expect(buf.count).toBe(2);
    expect(buf.lift.length).toBe(6); // 2 instances × vec3
    // ENU: up = [0,0,1], metersPerWorldUnit = 1 → lift = +Z unit.
    expect(Array.from(buf.lift.slice(0, 3))).toEqual([0, 0, 1]);
    expect(Array.from(buf.lift.slice(3, 6))).toEqual([0, 0, 1]);
  });

  it('scales lift by 1/metersPerWorldUnit under mercator latitude', () => {
    // cos(60°) = 0.5 → one metre of altitude = 2 world units.
    const mproj = new MercatorProjection({ longitude: 0, latitude: 60 });
    const buf = buildColumnBuffers([pointTile(1, [0, 60])], mproj, 0, {
      colorMode: CONST,
      timeHeight: true,
    });
    expect(buf.lift[0]).toBeCloseTo(0, 6);
    expect(buf.lift[1]).toBeCloseTo(0, 6);
    expect(buf.lift[2]).toBeCloseTo(2, 5); // 1 / cos(60°)
  });

  it('is 0-length when timeHeight is off', () => {
    const buf = buildColumnBuffers(
      [pointTile(1, [anchor.longitude, anchor.latitude])],
      proj,
      0,
      {
        colorMode: CONST,
      },
    );
    expect(buf.lift.length).toBe(0);
  });
});

describe('polygon buffers — lift (per vertex, feature vector on every vertex)', () => {
  it('writes the lift vector to each of a feature mesh vertex (ENU → +Z unit)', () => {
    const buf = buildPolygonBuffers([polyTile({})], proj, 0, {
      colorMode: CONST,
      timeHeight: true,
    });
    expect(buf.vertexCount).toBe(4);
    expect(buf.lift.length).toBe(12); // 4 vertices × vec3
    for (let i = 0; i < buf.lift.length; i += 3) {
      expect(buf.lift[i]).toBeCloseTo(0, 6);
      expect(buf.lift[i + 1]).toBeCloseTo(0, 6);
      expect(buf.lift[i + 2]).toBeCloseTo(1, 5);
    }
  });

  it('covers the extruded cap + top vertices too', () => {
    const buf = buildPolygonBuffers(
      [polyTile({ numericProps: { h: new Float32Array([5]) } })],
      proj,
      0,
      { colorMode: CONST, timeHeight: true, extrusionProperty: 'h' },
    );
    expect(buf.vertexCount).toBe(8); // base 4 + top 4
    expect(buf.lift.length).toBe(24);
    for (let i = 2; i < buf.lift.length; i += 3)
      expect(buf.lift[i]).toBeCloseTo(1, 5);
  });

  it('scales lift by 1/metersPerWorldUnit under mercator latitude', () => {
    const mproj = new MercatorProjection();
    const buf = buildPolygonBuffers([polyTile({})], mproj, 0, {
      colorMode: CONST,
      timeHeight: true,
    });
    // mercator up is +Z; the z factor is 1/cos(lat) at the feature's latitude.
    const expected =
      1 / mproj.metersPerWorldUnit(anchor.longitude, anchor.latitude);
    expect(buf.lift[2]).toBeCloseTo(expected, 4);
    expect(buf.lift[0]).toBeCloseTo(0, 6);
  });

  it('is 0-length when timeHeight is off', () => {
    const buf = buildPolygonBuffers([polyTile({})], proj, 0, {
      colorMode: CONST,
    });
    expect(buf.lift.length).toBe(0);
  });
});

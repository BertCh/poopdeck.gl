// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// The buffer builders emit a per-instance / per-vertex `filterValues` array
// (the `sttFilterValue` attribute the DataFilter materials bind) sourced from a
// configurable `filterProperty`, mirroring deck's `getFilterValue` accessor:
// one value per feature, repeated to every primitive/vertex a feature owns; 0
// where a tile lacks the column (deck's constant fallback); a 0-length array
// when no `filterProperty` is set (the attribute is simply not bound).

import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures } from '@poopdeck.gl/core';
import { buildArcBuffers } from '../src/lib/arc-buffers';
import { buildLineSegmentBuffers } from '../src/lib/geo-line-buffers';
import { buildOdLineSegmentBuffers } from '../src/lib/od-positions';
import { buildTripsBuffers } from '../src/lib/trips-buffers';
import { buildColumnBuffers } from '../src/lib/column-buffers';
import { buildPolygonBuffers } from '../src/layers/polygon-buffers';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { makeLineTile, makePointTile } from './_support/features';

const anchor = { longitude: -71.05, latitude: 42.35 };
const proj = new LocalEnuProjection(anchor);
const CONST = { type: 'constant', color: [200, 200, 200, 255] } as const;

const lineTile = (partial: Partial<BinaryFeatures>, timeOffset = 0) =>
  makeLineTile(partial, { timeOffset, layerName: 'lines' });
const polyTile = (partial: Partial<BinaryFeatures>) =>
  makeLineTile(partial, {
    layerName: 'poly',
    geometryType: GeometryType.Polygon,
    geometryExtensionName: 'geoarrow.polygon',
  });

// Two 2-vertex LineString features (one segment each) with a `mag` column.
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

// One 3-vertex LineString (→ 2 segments) with a single `mag` value.
function oneMultiSeg(): Partial<BinaryFeatures> {
  const d = 0.001;
  return {
    featureCount: 1,
    positions: new Float64Array([
      anchor.longitude,
      anchor.latitude,
      anchor.longitude + d,
      anchor.latitude,
      anchor.longitude + 2 * d,
      anchor.latitude,
    ]),
    startIndices: new Uint32Array([0, 3]),
    startTimes: new Float32Array([0]),
    endTimes: new Float32Array([1000]),
    numericProps: { mag: new Float32Array([5]) },
  };
}

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

describe('arc buffers — filterValues (per arc)', () => {
  it('emits one value per feature from filterProperty', () => {
    const buf = buildArcBuffers([lineTile(twoFlows())], proj, 0, {
      filterProperty: 'mag',
    });
    expect(buf.count).toBe(2);
    expect(Array.from(buf.filterValues)).toEqual([3, 7]);
  });
  it('is 0-length when no filterProperty is set', () => {
    const buf = buildArcBuffers([lineTile(twoFlows())], proj, 0, {});
    expect(buf.filterValues.length).toBe(0);
  });
  it('falls back to 0 where a tile lacks the column', () => {
    const noCol = twoFlows();
    delete (noCol as { numericProps?: unknown }).numericProps;
    const buf = buildArcBuffers([lineTile(noCol)], proj, 0, {
      filterProperty: 'mag',
    });
    expect(Array.from(buf.filterValues)).toEqual([0, 0]);
  });
});

describe('line buffers — filterValues (per segment, feature value repeated)', () => {
  it('repeats a feature value across each of its segments', () => {
    const buf = buildLineSegmentBuffers([lineTile(oneMultiSeg())], proj, 0, {
      colorMode: CONST,
      filterProperty: 'mag',
    });
    expect(buf.count).toBe(2); // 3 verts → 2 segments
    expect(Array.from(buf.filterValues)).toEqual([5, 5]);
  });
  it('is 0-length when no filterProperty is set', () => {
    const buf = buildLineSegmentBuffers([lineTile(oneMultiSeg())], proj, 0, {
      colorMode: CONST,
    });
    expect(buf.filterValues.length).toBe(0);
  });
});

describe('od-line buffers — filterValues (per OD pair)', () => {
  it('emits one value per feature (one segment per OD pair)', () => {
    const buf = buildOdLineSegmentBuffers([lineTile(twoFlows())], proj, 0, {
      colorMode: CONST,
      filterProperty: 'mag',
    });
    expect(buf.count).toBe(2);
    expect(Array.from(buf.filterValues)).toEqual([3, 7]);
  });
});

describe('trips buffers — filterValues (per segment)', () => {
  it('repeats a trip value across each of its segments', () => {
    const buf = buildTripsBuffers([lineTile(oneMultiSeg())], proj, 0, {
      colorMode: CONST,
      filterProperty: 'mag',
    });
    expect(buf.count).toBe(2);
    expect(Array.from(buf.filterValues)).toEqual([5, 5]);
  });
});

describe('column buffers — filterValues (per column instance)', () => {
  it('emits one value per point feature', () => {
    const tile = makePointTile(
      2,
      [
        anchor.longitude,
        anchor.latitude,
        anchor.longitude + 0.001,
        anchor.latitude,
      ],
      { numericProps: { mag: new Float32Array([3, 7]) } },
    );
    const buf = buildColumnBuffers([tile], proj, 0, {
      colorMode: CONST,
      filterProperty: 'mag',
    });
    expect(buf.count).toBe(2);
    expect(Array.from(buf.filterValues)).toEqual([3, 7]);
  });
  it('is 0-length when no filterProperty is set', () => {
    const tile = makePointTile(1, [anchor.longitude, anchor.latitude]);
    const buf = buildColumnBuffers([tile], proj, 0, { colorMode: CONST });
    expect(buf.filterValues.length).toBe(0);
  });
});

describe('polygon buffers — filterValues (per vertex, feature value on every vertex)', () => {
  it('writes a feature value to each of its mesh vertices', () => {
    const tile = polyTile({
      positions: new Float64Array(square()),
      startIndices: new Uint32Array([0, 4]),
      numericProps: { mag: new Float32Array([9]) },
    });
    const buf = buildPolygonBuffers([tile], proj, 0, {
      colorMode: CONST,
      filterProperty: 'mag',
    });
    expect(buf.vertexCount).toBe(4);
    expect(buf.filterValues.length).toBe(4);
    expect(Array.from(buf.filterValues)).toEqual([9, 9, 9, 9]);
  });
  it('covers the extruded cap + top vertices too', () => {
    const tile = polyTile({
      positions: new Float64Array(square()),
      startIndices: new Uint32Array([0, 4]),
      numericProps: { mag: new Float32Array([9]), h: new Float32Array([5]) },
    });
    const buf = buildPolygonBuffers([tile], proj, 0, {
      colorMode: CONST,
      filterProperty: 'mag',
      extrusionProperty: 'h',
    });
    expect(buf.vertexCount).toBe(8); // base 4 + top 4
    expect(buf.filterValues.length).toBe(8);
    for (const v of buf.filterValues) expect(v).toBe(9);
  });
  it('is 0-length when no filterProperty is set', () => {
    const tile = polyTile({
      positions: new Float64Array(square()),
      startIndices: new Uint32Array([0, 4]),
    });
    const buf = buildPolygonBuffers([tile], proj, 0, { colorMode: CONST });
    expect(buf.filterValues.length).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { buildLineSegmentBuffers } from '../src/lib/geo-line-buffers';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { MercatorProjection } from '../src/projection/mercator';

const anchor = { longitude: -71.05, latitude: 42.35 };

function lineTile(
  partial: Partial<BinaryFeatures>,
  timeOffset = 0,
): Tile {
  const features: BinaryFeatures = {
    featureCount: 1,
    geometryType: GeometryType.LineString,
    positionDimensions: 2,
    positions: new Float64Array(0),
    featureIds: new Uint32Array(1),
    startTimes: new Float32Array(1),
    endTimes: new Float32Array(1),
    startIndices: new Uint32Array([0, 0]),
    timeOffset,
    numericProps: {},
    categoricalProps: {},
    vectorProps: {},
    ...partial,
  };
  return {
    id: { z: 14, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [{ name: 'lines', extent: 0, features, geometryExtensionName: 'geoarrow.linestring' }],
  };
}

describe('buildLineSegmentBuffers', () => {
  const proj = new LocalEnuProjection(anchor);

  it('emits one segment instance per consecutive vertex pair, RTC-relative', () => {
    // 3-vertex line at the anchor going east → 2 segments.
    const dLon = 0.001;
    const tile = lineTile({
      positions: new Float64Array([
        anchor.longitude, anchor.latitude,
        anchor.longitude + dLon, anchor.latitude,
        anchor.longitude + 2 * dLon, anchor.latitude,
      ]),
      startIndices: new Uint32Array([0, 3]),
      startTimes: new Float32Array([100]),
      endTimes: new Float32Array([200]),
    }, 500);

    const buf = buildLineSegmentBuffers([tile], proj, 200, {
      colorMode: { type: 'constant', color: [255, 0, 0, 255] },
    });

    expect(buf.count).toBe(2);
    // origin = first vertex projected (≈ the anchor → ~0).
    expect(buf.origin[0]).toBeCloseTo(0, 4);
    // First segment A is at the origin (relative → ~0), B is one dLon east.
    expect(buf.posA[0]).toBeCloseTo(0, 4);
    expect(buf.posB[0]).toBeGreaterThan(0);
    // Times rebased by (timeOffset 500 − timeOrigin 200) = +300.
    expect(buf.starts[0]).toBe(400);
    expect(buf.ends[0]).toBe(500);
    // Constant colour on both endpoints.
    expect(buf.colorA[0]).toBeCloseTo(1, 6);
    expect(buf.colorB[3]).toBeCloseTo(1, 6);
  });

  it('keeps RTC offsets tiny under mercator while origin carries the magnitude', () => {
    const merc = new MercatorProjection();
    const tile = lineTile({
      positions: new Float64Array([
        anchor.longitude, anchor.latitude,
        anchor.longitude + 0.001, anchor.latitude + 0.001,
      ]),
      startIndices: new Uint32Array([0, 2]),
    });
    const buf = buildLineSegmentBuffers([tile], merc, 0, {
      colorMode: { type: 'constant', color: [10, 20, 30, 255] },
    });
    expect(buf.count).toBe(1);
    expect(Math.abs(buf.origin[0])).toBeGreaterThan(1e6); // huge absolute mercator x
    expect(Math.abs(buf.posA[0])).toBeLessThan(1); // A is the origin → ~0
    expect(Math.abs(buf.posB[0])).toBeLessThan(500); // B within a few hundred metres
  });

  it('returns empty for a tile with no line features', () => {
    const tile = lineTile({ featureCount: 0, startIndices: new Uint32Array([0]) });
    const buf = buildLineSegmentBuffers([tile], proj, 0, {
      colorMode: { type: 'constant', color: [0, 0, 0, 255] },
    });
    expect(buf.count).toBe(0);
    expect(buf.bbox).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { buildPolygonBuffers } from '../src/layers/polygon-buffers';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { MercatorProjection } from '../src/projection/mercator';
import type { RGBA } from '../src/lib/color';

const anchor = { longitude: -71.05, latitude: 42.35 };
const proj = new LocalEnuProjection(anchor);

function polyTile(partial: Partial<BinaryFeatures>, timeOffset = 0): Tile {
  const features: BinaryFeatures = {
    featureCount: 1,
    geometryType: GeometryType.Polygon,
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
    layers: [{ name: 'poly', extent: 0, features, geometryExtensionName: 'geoarrow.polygon' }],
  };
}

// A small CCW square ~10 m on a side, centred near the anchor.
function square(d = 0.0001): number[] {
  return [
    anchor.longitude - d, anchor.latitude - d,
    anchor.longitude + d, anchor.latitude - d,
    anchor.longitude + d, anchor.latitude + d,
    anchor.longitude - d, anchor.latitude + d,
  ];
}

const RED: RGBA = [255, 0, 0, 255];

describe('buildPolygonBuffers', () => {
  it('earcuts a single ring into 2 triangles, RTC-relative, with rebased times', () => {
    const tile = polyTile(
      {
        positions: new Float64Array(square()),
        startIndices: new Uint32Array([0, 4]),
        startTimes: new Float32Array([100]),
        endTimes: new Float32Array([200]),
      },
      500,
    );
    const buf = buildPolygonBuffers([tile], proj, 200, {
      colorMode: { type: 'constant', color: RED },
    });
    expect(buf.vertexCount).toBe(4); // one mesh vertex per ring vertex
    expect(buf.indices.length).toBe(6); // a quad → 2 triangles
    // origin = first ring vertex projected; positions are relative to it.
    expect(buf.origin).toHaveLength(3);
    // Constant colour, straight (not premultiplied).
    expect(buf.colors[0]).toBeCloseTo(1, 6);
    expect(buf.colors[3]).toBeCloseTo(1, 6);
    // Times rebased by (timeOffset 500 − timeOrigin 200) = +300 (per vertex).
    expect(buf.starts[0]).toBe(400);
    expect(buf.ends[0]).toBe(500);
    expect(buf.starts[3]).toBe(400); // every vertex of the feature shares it
    // Every index references a real vertex.
    for (const idx of buf.indices) expect(idx).toBeLessThan(buf.vertexCount);
  });

  it('honours pre-baked triangles verbatim (the multi-ring/hole-correct path)', () => {
    // Two-feature tile with GLOBAL pre-baked triangles. Indices are already
    // shifted by startIndices, so feature 1's triangle references vertex >= 4.
    const tile = polyTile({
      featureCount: 2,
      positions: new Float64Array([...square(), ...square(0.0002)]),
      startIndices: new Uint32Array([0, 4, 8]),
      startTimes: new Float32Array([0, 0]),
      endTimes: new Float32Array([1, 1]),
      // feature 0: tri (0,1,2); feature 1: tri (4,5,6) — GLOBAL indices.
      triangles: new Uint32Array([0, 1, 2, 4, 5, 6]),
      triangleOffsets: new Uint32Array([0, 3, 6]),
    });
    const buf = buildPolygonBuffers([tile], proj, 0, {
      colorMode: { type: 'constant', color: RED },
    });
    expect(buf.vertexCount).toBe(8);
    expect(buf.indices.length).toBe(6);
    // Feature 1's triangle must land on its own mesh vertices (4,5,6), not 0.
    expect(Math.max(...buf.indices)).toBeGreaterThanOrEqual(4);
    for (const idx of buf.indices) expect(idx).toBeLessThan(8);
  });

  it('keeps RTC offsets tiny under mercator while origin carries the magnitude', () => {
    const merc = new MercatorProjection();
    const tile = polyTile({
      positions: new Float64Array(square()),
      startIndices: new Uint32Array([0, 4]),
    });
    const buf = buildPolygonBuffers([tile], merc, 0, {
      colorMode: { type: 'constant', color: RED },
    });
    expect(buf.vertexCount).toBe(4);
    expect(Math.abs(buf.origin[0])).toBeGreaterThan(1e6); // huge absolute mercator x
    for (let i = 0; i < buf.positions.length; i++) {
      expect(Math.abs(buf.positions[i])).toBeLessThan(100); // ~10 m square, RTC-local
    }
  });

  it('extrudes a feature into a prism (cap + top + side walls)', () => {
    const tile = polyTile({
      positions: new Float64Array(square()),
      startIndices: new Uint32Array([0, 4]),
      numericProps: { h: new Float32Array([5]) },
    });
    const flat = buildPolygonBuffers([tile], proj, 0, {
      colorMode: { type: 'constant', color: RED },
    });
    const prism = buildPolygonBuffers([tile], proj, 0, {
      colorMode: { type: 'constant', color: RED },
      extrusionProperty: 'h',
    });
    // base 4 + top 4 vertices.
    expect(prism.vertexCount).toBe(8);
    // cap(6) + top(6) + 4 walls × 2 tris × 3 = 24 → 36 indices.
    expect(prism.indices.length).toBe(flat.indices.length * 2 + 24);
    // top cap is lifted ~5 m in +Z (ENU world unit == metre).
    const maxZ = Math.max(...prism.positions.filter((_, i) => i % 3 === 2));
    expect(maxZ).toBeCloseTo(5, 1);
  });

  it('skips sub-triangle rings and non-polygon layers, returns empty', () => {
    const degenerate = polyTile({
      positions: new Float64Array([anchor.longitude, anchor.latitude, anchor.longitude, anchor.latitude]),
      startIndices: new Uint32Array([0, 2]),
    });
    const buf = buildPolygonBuffers([degenerate], proj, 0, {
      colorMode: { type: 'constant', color: RED },
    });
    expect(buf.vertexCount).toBe(0);
    expect(buf.indices.length).toBe(0);

    const line = polyTile({
      geometryType: GeometryType.LineString,
      positions: new Float64Array(square()),
      startIndices: new Uint32Array([0, 4]),
    });
    const buf2 = buildPolygonBuffers([line], proj, 0, {
      colorMode: { type: 'constant', color: RED },
    });
    expect(buf2.vertexCount).toBe(0);
    expect(buf2.bbox).toBeNull();
  });
});

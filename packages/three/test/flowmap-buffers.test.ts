import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { buildFlowmapBuffers } from '../src/lib/flowmap-buffers';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { MercatorProjection } from '../src/projection/mercator';

const anchor = { longitude: -71.05, latitude: 42.35 };

function flowTile(partial: Partial<BinaryFeatures>, timeOffset = 0): Tile {
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
    id: { z: 11, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [{ name: 'flows', extent: 0, features, geometryExtensionName: 'geoarrow.linestring' }],
  };
}

/**
 * One OD flow at the anchor → one dLon east, carrying a 4-bucket per-vertex value
 * matrix. Bucket axis spans [start=0, end=4000] over 4 buckets ⇒ 1000 ms/bucket.
 * The SOURCE vertex (global index 0) carries the flow series; we set bucket
 * values [4, 16, 0, 64] so we can probe blend + squelch behaviour.
 */
function oneFlowTile(srcSeries: number[]): Tile {
  const nb = srcSeries.length;
  const dLon = 0.001;
  // 2 vertices (src, tgt); matrix is vertex-major: src row then tgt row.
  const matrix = new Float32Array(2 * nb);
  for (let b = 0; b < nb; b++) matrix[b] = srcSeries[b]; // src vertex 0
  return flowTile({
    positions: new Float64Array([
      anchor.longitude, anchor.latitude,
      anchor.longitude + dLon, anchor.latitude,
    ]),
    startIndices: new Uint32Array([0, 2]),
    startTimes: new Float32Array([0]),
    endTimes: new Float32Array([nb * 1000]),
    vertexValueMatrix: matrix,
    vertexValueBuckets: nb,
  });
}

describe('buildFlowmapBuffers', () => {
  const proj = new LocalEnuProjection(anchor);

  it('collapses each feature to source/target endpoints, RTC-relative', () => {
    const tile = oneFlowTile([16, 16, 16, 16]);
    const buf = buildFlowmapBuffers([tile], proj, 0, { widthScale: 1, minFlow: 0 });
    expect(buf.count).toBe(1);
    // origin = source vertex projected (≈ anchor → ~0).
    expect(buf.origin[0]).toBeCloseTo(0, 4);
    // Source at origin (~0); target one dLon east.
    expect(buf.posSource[0]).toBeCloseTo(0, 4);
    expect(buf.posTarget[0]).toBeGreaterThan(0);
  });

  it('maps the bucket-0 source flow to width = widthScale·√flow', () => {
    // time 0 → bucket 0 (flow 16) → width = 1.5·√16 = 6.
    const tile = oneFlowTile([16, 1, 1, 1]);
    const buf = buildFlowmapBuffers([tile], proj, 0, { widthScale: 1.5, minFlow: 0 });
    expect(buf.widths[0]).toBeCloseTo(6, 5);
  });

  it('linearly blends across a sub-step between two buckets', () => {
    // buckets [start=0, end=4000], 4 buckets → 1000 ms each.
    // time 500 → pos 0.5 → blend bucket0(16)·0.5 + bucket1(64)·0.5 = 40.
    const tile = oneFlowTile([16, 64, 0, 0]);
    const buf = buildFlowmapBuffers([tile], proj, 500, { widthScale: 1, minFlow: 0 });
    expect(buf.widths[0]).toBeCloseTo(Math.sqrt(40), 5);
  });

  it('squelches a flow below minFlow to width 0 (invisible)', () => {
    const tile = oneFlowTile([0.1, 0, 0, 0]);
    const buf = buildFlowmapBuffers([tile], proj, 0, { widthScale: 1, minFlow: 0.25 });
    expect(buf.widths[0]).toBe(0);
    // No node circles when nothing is active.
    expect(buf.nodeCount).toBe(0);
  });

  it('aggregates incident flow into node circles at both endpoints', () => {
    const tile = oneFlowTile([16, 0, 0, 0]);
    const buf = buildFlowmapBuffers([tile], proj, 0, {
      widthScale: 1,
      minFlow: 0,
      nodeRadiusScale: 2,
      nodeRadiusMinPixels: 0,
      nodeRadiusMaxPixels: 100,
    });
    // Two distinct docks (source + target).
    expect(buf.nodeCount).toBe(2);
    // Each node sees flow 16 once → radius = 2·√16 = 8.
    expect(buf.nodeRadii[0]).toBeCloseTo(8, 5);
    expect(buf.nodeRadii[1]).toBeCloseTo(8, 5);
    // Per-flow endpoint insets = the endpoints' node radii.
    expect(buf.endpointOffsets[0]).toBeCloseTo(8, 5);
    expect(buf.endpointOffsets[1]).toBeCloseTo(8, 5);
  });

  it('collapses a shared dock across flows into one node and sums its flow', () => {
    // Two flows that both ORIGINATE at the anchor (shared source dock).
    const tile = flowTile({
      featureCount: 2,
      positions: new Float64Array([
        anchor.longitude, anchor.latitude, anchor.longitude + 0.001, anchor.latitude,
        anchor.longitude, anchor.latitude, anchor.longitude, anchor.latitude + 0.001,
      ]),
      startIndices: new Uint32Array([0, 2, 4]),
      startTimes: new Float32Array([0, 0]),
      endTimes: new Float32Array([1000, 1000]),
      // vertex-major matrix, 1 bucket, 4 vertices (src0,tgt0,src1,tgt1).
      vertexValueMatrix: new Float32Array([9, 0, 9, 0]),
      vertexValueBuckets: 1,
    });
    const buf = buildFlowmapBuffers([tile], proj, 0, {
      widthScale: 1,
      minFlow: 0,
      nodeRadiusScale: 1,
      nodeRadiusMinPixels: 0,
      nodeRadiusMaxPixels: 1000,
    });
    expect(buf.count).toBe(2);
    // 3 distinct docks: shared origin + two distinct targets.
    expect(buf.nodeCount).toBe(3);
    // The shared origin saw flow 9 + 9 = 18 → radius √18; targets saw 9 → √9.
    const radii = Array.from(buf.nodeRadii).sort((a, b) => a - b);
    expect(radii[0]).toBeCloseTo(3, 5); // √9
    expect(radii[2]).toBeCloseTo(Math.sqrt(18), 5);
  });

  it('keeps RTC offsets tiny under mercator while origin carries the magnitude', () => {
    const merc = new MercatorProjection();
    const tile = oneFlowTile([16, 0, 0, 0]);
    const buf = buildFlowmapBuffers([tile], merc, 0, { widthScale: 1, minFlow: 0 });
    expect(buf.count).toBe(1);
    expect(Math.abs(buf.origin[0])).toBeGreaterThan(1e6); // huge absolute mercator x
    expect(Math.abs(buf.posSource[0])).toBeLessThan(1); // source is the origin → ~0
    expect(Math.abs(buf.posTarget[0])).toBeLessThan(500); // target within a few hundred m
  });

  it('returns empty for a tile with no line features', () => {
    const tile = flowTile({ featureCount: 0, startIndices: new Uint32Array([0]) });
    const buf = buildFlowmapBuffers([tile], proj, 0, {});
    expect(buf.count).toBe(0);
    expect(buf.nodeCount).toBe(0);
    expect(buf.bbox).toBeNull();
  });
});

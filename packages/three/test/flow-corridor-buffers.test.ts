import { describe, it, expect } from 'vitest';
import type { BinaryFeatures } from '@poopdeck.gl/core';
import {
  buildFlowCorridorBuffers,
  bucketPosFromTime,
} from '../src/lib/flow-corridor-buffers';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { MercatorProjection } from '../src/projection/mercator';
import { makeLineTile } from './_support/features';
import { expectEmptyBuffers, expectRtcMercator } from './_support/rtc';

const anchor = { longitude: -73.57, latitude: 45.5 };

const flowTile = (partial: Partial<BinaryFeatures>, timeOffset = 0) =>
  makeLineTile(partial, { timeOffset, layerName: 'flow', z: 12 });

describe('buildFlowCorridorBuffers', () => {
  const proj = new LocalEnuProjection(anchor);

  it('emits one segment per vertex pair and packs the per-endpoint value matrix', () => {
    // 3-vertex line east → 2 segments. 2 buckets per vertex.
    // matrix is globally vertex-major: matrix[vertex*nb + bucket].
    const dLon = 0.001;
    const nb = 2;
    // vertices 0,1,2; bucket values per vertex:
    //   v0: [10, 20]   v1: [30, 40]   v2: [50, 60]
    const matrix = new Float32Array([10, 20, 30, 40, 50, 60]);
    const tile = flowTile(
      {
        positions: new Float64Array([
          anchor.longitude, anchor.latitude,
          anchor.longitude + dLon, anchor.latitude,
          anchor.longitude + 2 * dLon, anchor.latitude,
        ]),
        startIndices: new Uint32Array([0, 3]),
        startTimes: new Float32Array([0]),
        endTimes: new Float32Array([1000]),
        vertexValueMatrix: matrix,
        vertexValueBuckets: nb,
      },
      0,
    );

    const buf = buildFlowCorridorBuffers([tile], proj, 0, {});

    expect(buf.count).toBe(2);
    expect(buf.numBuckets).toBe(2);
    expect(buf.valueMatrix.length).toBe(2 * nb * 2); // count*buckets*2 channels

    // Segment 0 = (v0→v1). Row layout: [(seg*nb+bucket)*2 + ch], R=A, G=B.
    // bucket0: A=v0[0]=10, B=v1[0]=30 ; bucket1: A=v0[1]=20, B=v1[1]=40
    expect(buf.valueMatrix[0]).toBe(10); // seg0 b0 A
    expect(buf.valueMatrix[1]).toBe(30); // seg0 b0 B
    expect(buf.valueMatrix[2]).toBe(20); // seg0 b1 A
    expect(buf.valueMatrix[3]).toBe(40); // seg0 b1 B

    // Segment 1 = (v1→v2). bucket0: A=30,B=50 ; bucket1: A=40,B=60
    const r1 = 1 * nb * 2;
    expect(buf.valueMatrix[r1 + 0]).toBe(30); // seg1 b0 A
    expect(buf.valueMatrix[r1 + 1]).toBe(50); // seg1 b0 B
    expect(buf.valueMatrix[r1 + 2]).toBe(40); // seg1 b1 A
    expect(buf.valueMatrix[r1 + 3]).toBe(60); // seg1 b1 B

    // rowV centres
    expect(buf.rowV[0]).toBeCloseTo(0.5 / 2, 6);
    expect(buf.rowV[1]).toBeCloseTo(1.5 / 2, 6);

    // RTC: origin ≈ anchor → first segment A ≈ 0, B east > 0.
    expect(buf.origin[0]).toBeCloseTo(0, 4);
    expect(buf.posA[0]).toBeCloseTo(0, 4);
    expect(buf.posB[0]).toBeGreaterThan(0);

    // axis derived from feature-0 [start,end] over nb buckets
    expect(buf.axis).not.toBeNull();
    expect(buf.axis!.numBuckets).toBe(2);
    expect(buf.axis!.bucket0Abs).toBe(0);
    expect(buf.axis!.bucketWidth).toBe(500);
  });

  it('rebases window times by (timeOffset − timeOrigin) and carries the axis abs base', () => {
    const matrix = new Float32Array([1, 2, 3, 4]); // 2 verts × 2 buckets
    const tile = flowTile(
      {
        positions: new Float64Array([
          anchor.longitude, anchor.latitude,
          anchor.longitude + 0.001, anchor.latitude,
        ]),
        startIndices: new Uint32Array([0, 2]),
        startTimes: new Float32Array([100]),
        endTimes: new Float32Array([900]),
        vertexValueMatrix: matrix,
        vertexValueBuckets: 2,
      },
      500, // timeOffset
    );
    const buf = buildFlowCorridorBuffers([tile], proj, 200, {});
    expect(buf.count).toBe(1);
    // start/end rebased by (500 − 200) = +300
    expect(buf.starts[0]).toBe(400); // 100 + 300
    expect(buf.ends[0]).toBe(1200); // 900 + 300
    // axis is in ABSOLUTE time: bucket0Abs = timeOffset + rel0 = 500 + 100 = 600
    expect(buf.axis!.bucket0Abs).toBe(600);
    expect(buf.axis!.bucketWidth).toBe(400); // (900-100)/2
  });

  it('keeps RTC offsets tiny under mercator while origin carries the magnitude', () => {
    const merc = new MercatorProjection();
    const tile = flowTile({
      positions: new Float64Array([
        anchor.longitude, anchor.latitude,
        anchor.longitude + 0.001, anchor.latitude + 0.001,
      ]),
      startIndices: new Uint32Array([0, 2]),
      startTimes: new Float32Array([0]),
      endTimes: new Float32Array([1000]),
      vertexValueMatrix: new Float32Array([5, 6]),
      vertexValueBuckets: 1,
    });
    const buf = buildFlowCorridorBuffers([tile], merc, 0, {});
    expectRtcMercator(buf, { a: buf.posA[0], b: buf.posB[0] });
    expect(buf.numBuckets).toBe(1);
  });

  it('returns empty for a non-matrix line tile (no vertexValueMatrix)', () => {
    const tile = flowTile({
      positions: new Float64Array([
        anchor.longitude, anchor.latitude,
        anchor.longitude + 0.001, anchor.latitude,
      ]),
      startIndices: new Uint32Array([0, 2]),
      // no vertexValueMatrix / buckets
    });
    const buf = buildFlowCorridorBuffers([tile], proj, 0, {});
    expectEmptyBuffers(buf);
    expect(buf.numBuckets).toBe(0);
    expect(buf.axis).toBeNull();
  });

  it('ignores tiles whose bucket count disagrees with the first matrix tile', () => {
    const a = flowTile({
      positions: new Float64Array([
        anchor.longitude, anchor.latitude,
        anchor.longitude + 0.001, anchor.latitude,
      ]),
      startIndices: new Uint32Array([0, 2]),
      startTimes: new Float32Array([0]),
      endTimes: new Float32Array([1000]),
      vertexValueMatrix: new Float32Array([1, 2, 3, 4]),
      vertexValueBuckets: 2,
    });
    const b = flowTile({
      positions: new Float64Array([
        anchor.longitude, anchor.latitude + 0.002,
        anchor.longitude + 0.001, anchor.latitude + 0.002,
      ]),
      startIndices: new Uint32Array([0, 2]),
      startTimes: new Float32Array([0]),
      endTimes: new Float32Array([1000]),
      vertexValueMatrix: new Float32Array([1, 2, 3]), // 3 buckets — mismatched
      vertexValueBuckets: 3,
    });
    const buf = buildFlowCorridorBuffers([a, b], proj, 0, {});
    expect(buf.numBuckets).toBe(2);
    expect(buf.count).toBe(1); // only tile `a`
  });
});

describe('bucketPosFromTime', () => {
  const axis = { numBuckets: 4, bucket0Abs: 1000, bucketWidth: 500 };

  it('maps absolute time onto a continuous bucket position', () => {
    expect(bucketPosFromTime(axis, 1000)).toBe(0);
    expect(bucketPosFromTime(axis, 1250)).toBe(0.5);
    expect(bucketPosFromTime(axis, 1500)).toBe(1);
    expect(bucketPosFromTime(axis, 2500)).toBe(3); // last bucket
  });

  it('clamps to the axis ends', () => {
    expect(bucketPosFromTime(axis, 0)).toBe(0); // before
    expect(bucketPosFromTime(axis, 99999)).toBe(3); // after → numBuckets-1
  });
});

import { describe, it, expect } from 'vitest';
import type { BinaryFeatures } from '@poopdeck.gl/core';
import { buildArcBuffers } from '../src/lib/arc-buffers';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { MercatorProjection } from '../src/projection/mercator';
import { makeLineTile } from './_support/features';
import { expectEmptyBuffers, expectRtcMercator } from './_support/rtc';

const anchor = { longitude: -71.05, latitude: 42.35 };

const arcTile = (partial: Partial<BinaryFeatures>, timeOffset = 0) =>
  makeLineTile(partial, { timeOffset, layerName: 'flows' });

describe('buildArcBuffers', () => {
  const proj = new LocalEnuProjection(anchor);

  it('collapses each LineString to source/target endpoints, one arc per feature', () => {
    const dLon = 0.001;
    // 3-vertex polyline → ONE arc instance, source=v0, target=v2 (intermediate dropped).
    const tile = arcTile(
      {
        positions: new Float64Array([
          anchor.longitude, anchor.latitude,
          anchor.longitude + dLon, anchor.latitude,
          anchor.longitude + 2 * dLon, anchor.latitude,
        ]),
        startIndices: new Uint32Array([0, 3]),
        startTimes: new Float32Array([100]),
        endTimes: new Float32Array([200]),
      },
      500,
    );

    const buf = buildArcBuffers([tile], proj, 200, {
      sourceColor: { type: 'constant', color: [255, 0, 0, 255] },
      targetColor: { type: 'constant', color: [0, 0, 255, 255] },
    });

    expect(buf.count).toBe(1);
    // origin = first source vertex projected (≈ the anchor → ~0).
    expect(buf.origin[0]).toBeCloseTo(0, 4);
    // Source is at the origin (relative → ~0); target is 2·dLon east.
    expect(buf.posSource[0]).toBeCloseTo(0, 4);
    expect(buf.posTarget[0]).toBeGreaterThan(0);
    // target endpoint is twice the per-segment span east of source.
    expect(buf.posTarget[0]).toBeGreaterThan(buf.posSource[0]);
    // Times rebased by (timeOffset 500 − timeOrigin 200) = +300.
    expect(buf.starts[0]).toBe(400);
    expect(buf.ends[0]).toBe(500);
    // Gradient endpoints: source red, target blue.
    expect(buf.colorSource[0]).toBeCloseTo(1, 6);
    expect(buf.colorSource[2]).toBeCloseTo(0, 6);
    expect(buf.colorTarget[2]).toBeCloseTo(1, 6);
    expect(buf.colorTarget[0]).toBeCloseTo(0, 6);
    // default height multiplier.
    expect(buf.heights[0]).toBe(1);
  });

  it('emits one arc per feature across multiple features', () => {
    const d = 0.002;
    const tile = arcTile({
      featureCount: 3,
      positions: new Float64Array([
        anchor.longitude, anchor.latitude, anchor.longitude + d, anchor.latitude,
        anchor.longitude, anchor.latitude + d, anchor.longitude + d, anchor.latitude + d,
        anchor.longitude + d, anchor.latitude, anchor.longitude, anchor.latitude + d,
      ]),
      startIndices: new Uint32Array([0, 2, 4, 6]),
      startTimes: new Float32Array([0, 0, 0]),
      endTimes: new Float32Array([1000, 1000, 1000]),
    });
    const buf = buildArcBuffers([tile], proj, 0, {});
    expect(buf.count).toBe(3);
    expect(buf.posSource.length).toBe(9);
    expect(buf.posTarget.length).toBe(9);
  });

  it('reads a per-feature height column when heightProperty is set', () => {
    const tile = arcTile({
      featureCount: 2,
      positions: new Float64Array([
        anchor.longitude, anchor.latitude, anchor.longitude + 0.001, anchor.latitude,
        anchor.longitude, anchor.latitude, anchor.longitude, anchor.latitude + 0.001,
      ]),
      startIndices: new Uint32Array([0, 2, 4]),
      startTimes: new Float32Array([0, 0]),
      endTimes: new Float32Array([1000, 1000]),
      numericProps: { flow: new Float32Array([2.5, 0.75]) },
    });
    const buf = buildArcBuffers([tile], proj, 0, { heightProperty: 'flow', height: 1 });
    expect(buf.heights[0]).toBeCloseTo(2.5, 5);
    expect(buf.heights[1]).toBeCloseTo(0.75, 5);
  });

  it('resolves source/target colours through a ramp', () => {
    const tile = arcTile({
      positions: new Float64Array([
        anchor.longitude, anchor.latitude, anchor.longitude + 0.001, anchor.latitude,
      ]),
      startIndices: new Uint32Array([0, 2]),
      numericProps: { mag: new Float32Array([5]) },
    });
    const buf = buildArcBuffers([tile], proj, 0, {
      sourceColor: {
        type: 'ramp',
        property: 'mag',
        domain: [0, 10],
        range: [
          [0, 0, 0, 255],
          [255, 255, 255, 255],
        ],
        fallback: [0, 0, 0, 255],
      },
      targetColor: { type: 'constant', color: [10, 20, 30, 255] },
    });
    // mag 5 → halfway up a black→white ramp → ~0.5.
    expect(buf.colorSource[0]).toBeCloseTo(0.5, 2);
    expect(buf.colorTarget[0]).toBeCloseTo(10 / 255, 5);
  });

  it('keeps RTC offsets tiny under mercator while origin carries the magnitude', () => {
    const merc = new MercatorProjection();
    const tile = arcTile({
      positions: new Float64Array([
        anchor.longitude, anchor.latitude,
        anchor.longitude + 0.001, anchor.latitude + 0.001,
      ]),
      startIndices: new Uint32Array([0, 2]),
    });
    const buf = buildArcBuffers([tile], merc, 0, {});
    expectRtcMercator(buf, { a: buf.posSource[0], b: buf.posTarget[0] });
  });

  it('returns empty for a tile with no line features', () => {
    const tile = arcTile({ featureCount: 0, startIndices: new Uint32Array([0]) });
    const buf = buildArcBuffers([tile], proj, 0, {});
    expectEmptyBuffers(buf);
  });
});

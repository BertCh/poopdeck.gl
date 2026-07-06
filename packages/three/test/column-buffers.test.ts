import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures } from '@poopdeck.gl/core';
import { buildColumnBuffers } from '../src/lib/column-buffers';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { MercatorProjection } from '../src/projection/mercator';
import type { RGBA } from '../src/lib/color';
import { makePointTile } from './_support/features';
import { expectEmptyBuffers } from './_support/rtc';

const anchor = { longitude: -71.05, latitude: 42.35 };
const proj = new LocalEnuProjection(anchor);

const pointTile = (
  count: number,
  positions: number[],
  partial: Partial<BinaryFeatures>,
  timeOffset = 0,
  geometryType = GeometryType.Point,
) => makePointTile(count, positions, partial, { timeOffset, geometryType, layerName: 'quakes' });

const CAT: Record<string, RGBA> = {
  minor: [80, 90, 120, 255],
  major: [255, 0, 0, 255],
};

describe('buildColumnBuffers', () => {
  it('projects bases (RTC), scales height from numeric column, rebases times', () => {
    const tile = pointTile(
      2,
      [anchor.longitude, anchor.latitude, anchor.longitude, anchor.latitude],
      {
        numericProps: { mag: new Float32Array([3, 5]) },
        startTimes: new Float32Array([10, 20]),
        endTimes: new Float32Array([15, 25]),
      },
      3000,
    );
    const buf = buildColumnBuffers([tile], proj, 1000, {
      colorMode: { type: 'constant', color: [255, 140, 0, 255] },
      elevationProperty: 'mag',
      elevationScale: 1000,
      radius: 100,
    });
    expect(buf.count).toBe(2);
    // First feature is the RTC origin → base is (0,0,0).
    expect(buf.bases[0]).toBeCloseTo(0, 5);
    expect(buf.bases[1]).toBeCloseTo(0, 5);
    expect(buf.bases[2]).toBeCloseTo(0, 5);
    // ENU: metersPerWorldUnit = 1, so basisZ.z = height = mag*scale.
    expect(buf.basisZ[2]).toBeCloseTo(3 * 1000, 3); // up × 3000
    expect(buf.basisZ[5]).toBeCloseTo(5 * 1000, 3);
    // radius 100 m → basisX.x = 100 (east × radius), basisY.y = 100.
    expect(buf.basisX[0]).toBeCloseTo(100, 3);
    expect(buf.basisY[1]).toBeCloseTo(100, 3);
    // basis are orthogonal axis-aligned in ENU.
    expect(buf.basisX[2]).toBeCloseTo(0, 6);
    expect(buf.basisZ[0]).toBeCloseTo(0, 6);
    // Time rebased by (3000 - 1000) = +2000.
    expect(buf.starts[0]).toBeCloseTo(10 + 2000, 3);
    expect(buf.ends[1]).toBeCloseTo(25 + 2000, 3);
  });

  it('falls back to defaultElevation when the column is absent', () => {
    const tile = pointTile(1, [anchor.longitude, anchor.latitude], {});
    const buf = buildColumnBuffers([tile], proj, 0, {
      colorMode: { type: 'constant', color: [1, 2, 3, 255] },
      elevationProperty: 'mag',
      defaultElevation: 250,
      elevationScale: 1,
      radius: 10,
    });
    expect(buf.basisZ[2]).toBeCloseTo(250, 5);
  });

  it('colours via a categorical mapping', () => {
    const tile = pointTile(
      2,
      [anchor.longitude, anchor.latitude, anchor.longitude, anchor.latitude],
      {
        categoricalProps: {
          severity: { indices: new Uint16Array([0, 1]), categories: ['minor', 'major'] },
        },
      },
    );
    const buf = buildColumnBuffers([tile], proj, 0, {
      colorMode: { type: 'categorical', property: 'severity', mapping: CAT, fallback: [0, 0, 0, 0] },
      defaultElevation: 1,
      radius: 1,
    });
    expect(buf.colors[0]).toBeCloseTo(80 / 255, 6); // minor r
    expect(buf.colors[4]).toBeCloseTo(1, 6); // major r
    expect(buf.colors[6]).toBeCloseTo(0, 6); // major b
  });

  it('colours via a continuous ramp on a numeric column', () => {
    const tile = pointTile(1, [anchor.longitude, anchor.latitude], {
      numericProps: { depth: new Float32Array([50]) },
    });
    const buf = buildColumnBuffers([tile], proj, 0, {
      colorMode: {
        type: 'ramp',
        property: 'depth',
        domain: [0, 100],
        range: [[0, 0, 0, 255], [255, 255, 255, 255]],
        fallback: [0, 0, 0, 255],
      },
      defaultElevation: 1,
      radius: 1,
    });
    // midpoint of a black→white ramp.
    expect(buf.colors[0]).toBeCloseTo(0.5, 2);
  });

  it('scales metric radius/height by 1/metersPerWorldUnit (mercator latitude)', () => {
    // Mercator: metersPerWorldUnit = cos(lat); at lat 60° that is 0.5, so a metric
    // size doubles in world units.
    const mlat = 60;
    const mproj = new MercatorProjection({ longitude: 0, latitude: mlat });
    const mpwu = mproj.metersPerWorldUnit(0, mlat);
    const tile = pointTile(1, [0, mlat], { numericProps: { h: new Float32Array([200]) } });
    const buf = buildColumnBuffers([tile], mproj, 0, {
      colorMode: { type: 'constant', color: [1, 1, 1, 255] },
      elevationProperty: 'h',
      elevationScale: 1,
      radius: 100,
    });
    // basisZ is up × heightWorld; |up| = 1 (planar), so its length = height/mpwu.
    const zlen = Math.hypot(buf.basisZ[0], buf.basisZ[1], buf.basisZ[2]);
    expect(zlen).toBeCloseTo(200 / mpwu, 2);
    const xlen = Math.hypot(buf.basisX[0], buf.basisX[1], buf.basisX[2]);
    expect(xlen).toBeCloseTo(100 / mpwu, 2);
  });

  it('skips non-point geometry layers', () => {
    const tile = pointTile(1, [anchor.longitude, anchor.latitude], {}, 0, GeometryType.LineString);
    const buf = buildColumnBuffers([tile], proj, 0, {
      colorMode: { type: 'constant', color: [1, 1, 1, 255] },
      defaultElevation: 1,
      radius: 1,
    });
    expectEmptyBuffers(buf);
  });
});

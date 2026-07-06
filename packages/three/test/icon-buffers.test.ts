import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures } from '@poopdeck.gl/core';
import { buildIconBuffers, type IconMappingEntry } from '../src/lib/icon-buffers';
import { LocalEnuProjection } from '../src/projection/local-enu';
import type { RGBA } from '../src/lib/color';
import { makePointTile } from './_support/features';
import { expectEmptyBuffers } from './_support/rtc';

const anchor = { longitude: -71.05, latitude: 42.35 };
const proj = new LocalEnuProjection(anchor);
const DEG2RAD = Math.PI / 180;

const pointTile = (
  count: number,
  positions: number[],
  partial: Partial<BinaryFeatures>,
  timeOffset = 0,
  geometryType = GeometryType.Point,
) => makePointTile(count, positions, partial, { timeOffset, geometryType, layerName: 'vessels' });

// 256x128 atlas, a centred 'marker' rect + an off-centre-anchor 'pin'.
const ATLAS_W = 256;
const ATLAS_H = 128;
const MAPPING: Record<string, IconMappingEntry> = {
  marker: { x: 0, y: 0, width: 64, height: 64 }, // anchor defaults to centre
  pin: { x: 128, y: 0, width: 64, height: 128, anchorX: 32, anchorY: 128 }, // tip-bottom
};

const VESSEL_COLORS: Record<string, RGBA> = {
  cargo: [10, 20, 30, 255],
  tanker: [200, 100, 50, 255],
};

describe('buildIconBuffers', () => {
  it('projects centres (RTC), bakes angle→radians, size, uv rect, rebases times', () => {
    const tile = pointTile(
      2,
      [anchor.longitude, anchor.latitude, anchor.longitude, anchor.latitude],
      {
        numericProps: {
          heading: new Float32Array([0, 90]),
          marker_size: new Float32Array([20, 40]),
        },
        startTimes: new Float32Array([10, 20]),
        endTimes: new Float32Array([15, 25]),
      },
      3000,
    );
    const buf = buildIconBuffers([tile], proj, 1000, {
      atlasWidth: ATLAS_W,
      atlasHeight: ATLAS_H,
      iconMapping: MAPPING,
      icon: 'marker',
      angleProperty: 'heading',
      sizeProperty: 'marker_size',
      colorMode: { type: 'constant', color: [255, 255, 255, 255] },
      elevationProperty: null,
      elevationScale: 1,
    });

    expect(buf.count).toBe(2);
    // RTC: origin is the first feature, so its center is (0,0,0).
    expect(buf.centers[0]).toBeCloseTo(0, 6);
    expect(buf.centers[1]).toBeCloseTo(0, 6);
    expect(buf.origin[0]).toBeCloseTo(0, 4); // anchor projects ~0
    // angle: degrees → radians.
    expect(buf.angles[0]).toBeCloseTo(0, 6);
    expect(buf.angles[1]).toBeCloseTo(90 * DEG2RAD, 6);
    // per-instance pixel size from the column.
    expect(buf.sizes[0]).toBe(20);
    expect(buf.sizes[1]).toBe(40);
    // uv rect normalized 0..1 (centred 64x64 in 256x128 atlas).
    expect(buf.uvRects[0]).toBeCloseTo(0, 6); // u0
    expect(buf.uvRects[1]).toBeCloseTo(0, 6); // v0
    expect(buf.uvRects[2]).toBeCloseTo(64 / 256, 6); // u1
    expect(buf.uvRects[3]).toBeCloseTo(64 / 128, 6); // v1
    // centred anchor → zero offset.
    expect(buf.anchors[0]).toBeCloseTo(0, 6);
    expect(buf.anchors[1]).toBeCloseTo(0, 6);
    // times rebased by (3000 - 1000).
    expect(buf.starts[0]).toBe(10 + 2000);
    expect(buf.ends[1]).toBe(25 + 2000);
  });

  it('applies a constant angle/size when no column is set', () => {
    const tile = pointTile(1, [anchor.longitude, anchor.latitude], {});
    const buf = buildIconBuffers([tile], proj, 0, {
      atlasWidth: ATLAS_W,
      atlasHeight: ATLAS_H,
      iconMapping: MAPPING,
      icon: 'marker',
      angleProperty: null,
      angleConstant: 45,
      sizeProperty: null,
      sizeConstant: 18,
      colorMode: { type: 'constant', color: [255, 255, 255, 255] },
    });
    expect(buf.angles[0]).toBeCloseTo(45 * DEG2RAD, 6);
    expect(buf.sizes[0]).toBe(18);
  });

  it('resolves categorical tint and bakes an off-centre anchor offset', () => {
    const tile = pointTile(
      2,
      [anchor.longitude, anchor.latitude, anchor.longitude, anchor.latitude],
      {
        categoricalProps: {
          ship_type: { indices: new Uint16Array([0, 1]), categories: ['cargo', 'tanker'] },
        },
      },
    );
    const buf = buildIconBuffers([tile], proj, 0, {
      atlasWidth: ATLAS_W,
      atlasHeight: ATLAS_H,
      iconMapping: MAPPING,
      icon: 'pin',
      angleProperty: null,
      sizeProperty: null,
      colorMode: {
        type: 'categorical',
        property: 'ship_type',
        mapping: VESSEL_COLORS,
        fallback: [0, 0, 0, 0],
      },
    });
    // cargo tint 0..1.
    expect(buf.colors[0]).toBeCloseTo(10 / 255, 6);
    expect(buf.colors[4]).toBeCloseTo(200 / 255, 6); // tanker r
    // pin anchorX=32 of width 64 → centre horizontally → ax = 0.
    expect(buf.anchors[0]).toBeCloseTo(0, 6);
    // pin anchorY=128 (bottom) of height 128 → ay = 2*(128/128)-1 = 1 (quad pushed up).
    expect(buf.anchors[1]).toBeCloseTo(1, 6);
  });

  it('elevates from a z column and reports a bbox', () => {
    const tile = pointTile(
      1,
      [anchor.longitude, anchor.latitude],
      { numericProps: { z: new Float32Array([5]) } },
    );
    const buf = buildIconBuffers([tile], proj, 0, {
      atlasWidth: ATLAS_W,
      atlasHeight: ATLAS_H,
      iconMapping: MAPPING,
      icon: 'marker',
      angleProperty: null,
      sizeProperty: null,
      colorMode: { type: 'constant', color: [255, 255, 255, 255] },
      elevationProperty: 'z',
      elevationScale: 1,
    });
    // single feature is the RTC origin (incl. its z), so its center z is 0 but the
    // origin carries the 5m lift.
    expect(buf.origin[2]).toBeCloseTo(5, 6);
    expect(buf.centers[2]).toBeCloseTo(0, 6);
    expect(buf.bbox).not.toBeNull();
  });

  it('skips non-point geometry layers', () => {
    const tile = pointTile(1, [anchor.longitude, anchor.latitude], {}, 0, GeometryType.LineString);
    const buf = buildIconBuffers([tile], proj, 0, {
      atlasWidth: ATLAS_W,
      atlasHeight: ATLAS_H,
      iconMapping: MAPPING,
      icon: 'marker',
      angleProperty: null,
      sizeProperty: null,
      colorMode: { type: 'constant', color: [255, 255, 255, 255] },
    });
    expectEmptyBuffers(buf);
  });
});

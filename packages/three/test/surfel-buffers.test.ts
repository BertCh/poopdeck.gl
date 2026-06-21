import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { buildSurfelBuffers, type SurfelBufferOptions } from '../src/layers/surfel-buffers';
import { LocalEnuProjection } from '../src/projection/local-enu';

const OPTS: SurfelBufferOptions = {
  quatVectorColumn: 'surfel_quat',
  scaleVectorColumn: 'surfel_scale',
  colorVectorColumn: 'surfel_color',
  quaternionColumns: ['qx', 'qy', 'qz', 'qw'],
  scaleColumns: ['s_major', 's_minor'],
  rgbColumns: ['r', 'g', 'b'],
  opacityColumn: 'surfel_opacity',
  elevationProperty: 'z',
  elevationScale: 1,
  fallbackColor: [200, 205, 215],
};

const anchor = { longitude: -122.4, latitude: 37.77 };
const proj = new LocalEnuProjection(anchor);

/** Build a minimal one-layer Tile holding the given numeric columns. */
function makeTile(
  count: number,
  positions: number[],
  numericProps: Record<string, number[]>,
  startTimes: number[],
  timeOffset: number,
): Tile {
  const num: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(numericProps)) num[k] = new Float32Array(v);
  const features: BinaryFeatures = {
    featureCount: count,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions: new Float64Array(positions),
    featureIds: new Uint32Array(count),
    startTimes: new Float32Array(startTimes),
    endTimes: new Float32Array(startTimes),
    timeOffset,
    numericProps: num,
    categoricalProps: {},
    vectorProps: {},
  };
  return {
    id: { z: 18, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [{ name: 'lidar', extent: 0, features, geometryExtensionName: 'geoarrow.point' }],
  };
}

describe('buildSurfelBuffers', () => {
  it('wires unpacked quaternions, scales, rgb+opacity, and projects centres', () => {
    const tile = makeTile(
      1,
      [anchor.longitude, anchor.latitude],
      {
        qx: [0],
        qy: [0],
        qz: [0],
        qw: [1],
        s_major: [0.4],
        s_minor: [0.2],
        r: [255],
        g: [128],
        b: [0],
        surfel_opacity: [0.5],
        z: [3],
      },
      [0],
      1_000_000,
    );
    const buf = buildSurfelBuffers([tile], proj, 1_000_000, OPTS);
    expect(buf.count).toBe(1);
    expect(buf.packed).toBe(false);
    // centre = anchor -> origin, z from elevation column
    expect(buf.centers[0]).toBeCloseTo(0, 5);
    expect(buf.centers[1]).toBeCloseTo(0, 5);
    expect(buf.centers[2]).toBe(3);
    expect([...buf.quats]).toEqual([0, 0, 0, 1]);
    expect(buf.scales[0]).toBeCloseTo(0.4, 6);
    expect(buf.scales[1]).toBeCloseTo(0.2, 6);
    expect(buf.colors[0]).toBeCloseTo(1, 6);
    expect(buf.colors[1]).toBeCloseTo(128 / 255, 6);
    expect(buf.colors[2]).toBe(0);
    expect(buf.colors[3]).toBe(0.5); // confidence -> alpha
    expect(buf.starts[0]).toBe(0); // timeOffset == timeOrigin
    expect(buf.dynamic[0]).toBe(0);
  });

  it('detects smallest-three packed quaternions via q_imax', () => {
    const tile = makeTile(
      1,
      [anchor.longitude, anchor.latitude],
      {
        q_a: [0.1],
        q_b: [0.2],
        q_c: [0.3],
        q_imax: [3],
        s_major: [0.5],
        s_minor: [0.5],
        z: [0],
      },
      [0],
      0,
    );
    const buf = buildSurfelBuffers([tile], proj, 0, OPTS);
    expect(buf.packed).toBe(true);
    expect([...buf.quats]).toEqual([
      expect.closeTo(0.1, 6),
      expect.closeTo(0.2, 6),
      expect.closeTo(0.3, 6),
      3,
    ]);
  });

  it('skips layers missing surfel orientation/scale columns', () => {
    const tile = makeTile(
      2,
      [anchor.longitude, anchor.latitude, anchor.longitude, anchor.latitude],
      { height_band: [1, 2] }, // a points layer, not surfels
      [0, 0],
      0,
    );
    const buf = buildSurfelBuffers([tile], proj, 0, OPTS);
    expect(buf.count).toBe(0);
    expect(buf.bbox).toBeNull();
  });

  it('flags dynamic surfels from is_dynamic', () => {
    const tile = makeTile(
      2,
      [anchor.longitude, anchor.latitude, anchor.longitude, anchor.latitude],
      {
        qx: [0, 0],
        qy: [0, 0],
        qz: [0, 0],
        qw: [1, 1],
        s_major: [0.3, 0.3],
        s_minor: [0.3, 0.3],
        is_dynamic: [0, 1],
        z: [0, 0],
      },
      [0, 0],
      0,
    );
    const buf = buildSurfelBuffers([tile], proj, 0, OPTS);
    expect([...buf.dynamic]).toEqual([0, 1]);
  });

  it('rebases start times to the common time origin', () => {
    // tile timeOffset 5000 ahead of origin 2000 -> +3000 added to each start.
    const tile = makeTile(
      1,
      [anchor.longitude, anchor.latitude],
      { qx: [0], qy: [0], qz: [0], qw: [1], s_major: [0.3], s_minor: [0.3], z: [0] },
      [100],
      5000,
    );
    const buf = buildSurfelBuffers([tile], proj, 2000, OPTS);
    expect(buf.starts[0]).toBe(100 + (5000 - 2000));
  });

  it('merges multiple tiles and reports the combined bbox', () => {
    const t1 = makeTile(
      1,
      [anchor.longitude, anchor.latitude],
      { qx: [0], qy: [0], qz: [0], qw: [1], s_major: [0.3], s_minor: [0.3], z: [1] },
      [0],
      0,
    );
    const t2 = makeTile(
      1,
      [anchor.longitude + 0.001, anchor.latitude + 0.001],
      { qx: [0], qy: [0], qz: [0], qw: [1], s_major: [0.3], s_minor: [0.3], z: [5] },
      [0],
      0,
    );
    const buf = buildSurfelBuffers([t1, t2], proj, 0, OPTS);
    expect(buf.count).toBe(2);
    expect(buf.bbox).not.toBeNull();
    expect(buf.bbox!.min[2]).toBe(1);
    expect(buf.bbox!.max[2]).toBe(5);
    expect(buf.bbox!.min[0]).toBeCloseTo(0, 5);
    expect(buf.bbox!.max[0]).toBeGreaterThan(0);
  });

  it('reads the interleaved vector layout (surfel_quat/scale/color) when present', () => {
    const features: BinaryFeatures = {
      featureCount: 2,
      geometryType: GeometryType.Point,
      positionDimensions: 2,
      positions: new Float64Array([anchor.longitude, anchor.latitude, anchor.longitude, anchor.latitude]),
      featureIds: new Uint32Array(2),
      startTimes: new Float32Array([0, 0]),
      endTimes: new Float32Array([0, 0]),
      timeOffset: 0,
      numericProps: { z: new Float32Array([2, 4]), is_dynamic: new Float32Array([0, 1]) },
      categoricalProps: {},
      vectorProps: {
        surfel_quat: { value: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]), size: 4 },
        surfel_scale: { value: new Float32Array([0.4, 0.2, 0.5, 0.3]), size: 2 },
        surfel_color: { value: new Uint8Array([255, 128, 0, 200, 10, 20, 30, 255]), size: 4 },
      },
    };
    const tile: Tile = {
      id: { z: 18, x: 0, y: 0, t: 0 },
      timeRange: { start: 0, end: 1000 },
      layers: [{ name: 'lidar', extent: 0, features, geometryExtensionName: 'geoarrow.point' }],
    };
    const buf = buildSurfelBuffers([tile], proj, 0, OPTS);
    expect(buf.count).toBe(2);
    expect(buf.packed).toBe(false); // vector path = full quats
    expect([...buf.quats.slice(0, 4)]).toEqual([0, 0, 0, 1]);
    expect(buf.scales[0]).toBeCloseTo(0.4, 6);
    expect(buf.scales[3]).toBeCloseTo(0.3, 6);
    expect(buf.colors[0]).toBeCloseTo(1, 6); // 255/255
    expect(buf.colors[1]).toBeCloseTo(128 / 255, 6);
    expect(buf.colors[3]).toBeCloseTo(200 / 255, 6); // confidence in alpha
    expect(buf.centers[2]).toBe(2); // z from elevation
    expect([...buf.dynamic]).toEqual([0, 1]);
  });

  it('falls back to fallbackColor when rgb columns are absent', () => {
    const tile = makeTile(
      1,
      [anchor.longitude, anchor.latitude],
      { qx: [0], qy: [0], qz: [0], qw: [1], s_major: [0.3], s_minor: [0.3], z: [0] },
      [0],
      0,
    );
    const buf = buildSurfelBuffers([tile], proj, 0, { ...OPTS, rgbColumns: null });
    expect(buf.colors[0]).toBeCloseTo(200 / 255, 6);
    expect(buf.colors[3]).toBe(1); // no opacity column -> opaque
  });
});

// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * The pure density field behind `STTHeatmapLayer` — no Cesium, no GPU.
 *
 * The load-bearing group is "ordering: accumulate, THEN ramp". A heatmap that
 * samples the palette per point and blends the resulting COLOURS is summing
 * colours instead of density; it looks plausible on sparse data and blows out
 * to white everywhere the data is actually interesting. These tests pin the
 * correct order AND pin how far the naive order diverges, so the difference
 * cannot be re-introduced as a "simplification".
 */

import { describe, expect, it } from 'vitest';
import {
  GeometryType,
  type BinaryFeatures,
  type Tile,
} from '@poopdeck.gl/core';
import {
  DEFAULT_COLOR_RANGE,
  accumulateDensity,
  buildHeatmapSamples,
  cellCenterLonLat,
  fieldGridForBounds,
  kernelWeight,
  metresPerCell,
  nearestSample,
  padHeatmapBounds,
  peakCell,
  rampDensityField,
  renderHeatmapRaster,
  sampleColorRange,
  type HeatmapBounds,
  type HeatmapSample,
} from '../src/lib/heatmap-field.js';

function pointTile(
  positions: number[],
  startTimes: number[],
  endTimes: number[],
  timeOffset = 0,
  numericProps: Record<string, Float32Array> = {},
): Tile {
  const featureCount = startTimes.length;
  const features: BinaryFeatures = {
    featureCount,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions: new Float64Array(positions),
    featureIds: new Uint32Array(featureCount),
    startTimes: new Float32Array(startTimes),
    endTimes: new Float32Array(endTimes),
    timeOffset,
    numericProps,
    categoricalProps: {},
    vectorProps: {},
  };
  return {
    id: { z: 5, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: 'points',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
}

// A 64x64 field over a 2x2 degree box. These two coordinates land EXACTLY on
// the centre of cell (32, 32), so the kernel there evaluates at t = 0 and
// deposits the sample's full weight — which is what lets the ordering tests
// assert exact arithmetic instead of approximate blobs.
const BOUNDS: HeatmapBounds = { west: -1, south: -1, east: 1, north: 1 };
const GRID = { width: 64, height: 64 };
const CENTRE_LON = 0.015625;
const CENTRE_LAT = -0.015625;
const CENTRE_CELL = 32 * 64 + 32;

function sampleAt(
  lon: number,
  lat: number,
  weight = 1,
  featureIndex = 0,
): HeatmapSample {
  return {
    lon,
    lat,
    x: 0,
    y: 0,
    z: 0,
    start: 0,
    end: 100,
    weight,
    binary: null as unknown as BinaryFeatures,
    featureIndex,
  };
}

const DENSITY = {
  bounds: BOUNDS,
  width: GRID.width,
  height: GRID.height,
  radiusPixels: 8,
} as const;

describe('buildHeatmapSamples', () => {
  it('extracts lon/lat, rebases times to the first layer origin, and boxes the extent', () => {
    const build = buildHeatmapSamples([
      pointTile([10, 20, 12, 24], [0, 100], [50, 300], 1_700_000_000_000),
    ]);
    expect(build.timeOrigin).toBe(1_700_000_000_000);
    expect(build.samples).toHaveLength(2);
    expect(build.samples[0].lon).toBe(10);
    expect(build.samples[0].lat).toBe(20);
    expect(build.samples[1].start).toBe(100);
    expect(build.samples[1].end).toBe(300);
    expect(build.bounds).toEqual({ west: 10, south: 20, east: 12, north: 24 });
  });

  it('rebases a SECOND layer against the first layer timeOffset', () => {
    const build = buildHeatmapSamples([
      pointTile([0, 0], [10], [20], 1000),
      pointTile([1, 1], [10], [20], 1500),
    ]);
    expect(build.timeOrigin).toBe(1000);
    expect(build.samples[0].start).toBe(10);
    expect(build.samples[1].start).toBe(510); // 10 + (1500 - 1000)
  });

  it('projects each sample to absolute f64 ECEF metres (wgs84, no RTC anchor)', () => {
    const build = buildHeatmapSamples([pointTile([0, 0], [0], [1])]);
    const s = build.samples[0];
    // On the equator at lon 0 the wgs84 semi-major axis is the whole vector.
    expect(Math.hypot(s.x, s.y, s.z)).toBeCloseTo(6378137, 0);
  });

  it('takes weight from a baked column, and 1 where it is unset or unusable', () => {
    const weighted = buildHeatmapSamples(
      [
        pointTile([0, 0, 1, 1, 2, 2], [0, 0, 0], [1, 1, 1], 0, {
          mag: new Float32Array([2.5, Number.NaN, 7]),
        }),
      ],
      { weightProperty: 'mag' },
    );
    expect(weighted.samples.map((s) => s.weight)).toEqual([2.5, 1, 7]);

    const unset = buildHeatmapSamples([
      pointTile([0, 0, 1, 1], [0, 0], [1, 1]),
    ]);
    expect(unset.samples.map((s) => s.weight)).toEqual([1, 1]);
  });

  it('honours defaultWeight for features with no usable value', () => {
    const build = buildHeatmapSamples([pointTile([0, 0], [0], [1])], {
      defaultWeight: 4,
    });
    expect(build.samples[0].weight).toBe(4);
  });

  it('returns an empty build (origin 0, no bounds) when no Point layers exist', () => {
    const build = buildHeatmapSamples([]);
    expect(build).toEqual({ samples: [], timeOrigin: 0, bounds: null });
  });

  it('skips non-finite coordinates rather than poisoning the extent', () => {
    const build = buildHeatmapSamples([
      pointTile([0, 0, Number.NaN, 5, 3, 3], [0, 0, 0], [1, 1, 1]),
    ]);
    expect(build.samples).toHaveLength(2);
    expect(build.bounds).toEqual({ west: 0, south: 0, east: 3, north: 3 });
  });
});

describe('kernelWeight', () => {
  it('peaks at 1 in the centre and is exactly 0 at and beyond the radius', () => {
    for (const kind of ['epanechnikov', 'gaussian'] as const) {
      expect(kernelWeight(kind, 0)).toBeCloseTo(1, 12);
      expect(kernelWeight(kind, 1)).toBe(0);
      expect(kernelWeight(kind, 4)).toBe(0);
    }
  });

  it('decreases monotonically across the support', () => {
    for (const kind of ['epanechnikov', 'gaussian'] as const) {
      let prev = Infinity;
      for (let t = 0; t < 1; t += 0.05) {
        const k = kernelWeight(kind, t);
        expect(k).toBeLessThan(prev);
        expect(k).toBeGreaterThanOrEqual(0);
        prev = k;
      }
    }
  });

  it('gives the gaussian a sharper core than the epanechnikov', () => {
    expect(kernelWeight('gaussian', 0.25)).toBeLessThan(
      kernelWeight('epanechnikov', 0.25),
    );
  });
});

describe('accumulateDensity — additive, colour-free', () => {
  it('deposits a sample’s full weight at the cell it sits on', () => {
    const f = accumulateDensity(
      [sampleAt(CENTRE_LON, CENTRE_LAT)],
      null,
      DENSITY,
    );
    expect(f.values[CENTRE_CELL]).toBeCloseTo(1, 6);
    expect(f.max).toBeCloseTo(1, 6);
  });

  it('THE ORDERING INVARIANT: two coincident points are exactly twice as hot as one', () => {
    const p = sampleAt(CENTRE_LON, CENTRE_LAT);
    const one = accumulateDensity([p], null, DENSITY);
    const two = accumulateDensity(
      [p, sampleAt(CENTRE_LON, CENTRE_LAT, 1, 1)],
      null,
      DENSITY,
    );
    expect(two.values[CENTRE_CELL]).toBeCloseTo(2 * one.values[CENTRE_CELL], 6);
    expect(two.max).toBeGreaterThan(one.max);
    // ...and additivity holds cell-by-cell across the whole splat, not just at
    // the peak — otherwise the shoulder would be a max(), not a sum.
    for (let i = 0; i < one.values.length; i++) {
      expect(two.values[i]).toBeCloseTo(2 * one.values[i], 6);
    }
  });

  it('scales linearly with weight', () => {
    const a = accumulateDensity(
      [sampleAt(CENTRE_LON, CENTRE_LAT, 1)],
      null,
      DENSITY,
    );
    const b = accumulateDensity(
      [sampleAt(CENTRE_LON, CENTRE_LAT, 3)],
      null,
      DENSITY,
    );
    expect(b.values[CENTRE_CELL]).toBeCloseTo(3 * a.values[CENTRE_CELL], 6);
  });

  it('gives an OUT-OF-WINDOW sample exactly zero density, not a faded one', () => {
    const p = sampleAt(CENTRE_LON, CENTRE_LAT);
    const f = accumulateDensity([p, p], [1, 0], DENSITY);
    const solo = accumulateDensity([p], null, DENSITY);
    expect(f.values[CENTRE_CELL]).toBeCloseTo(solo.values[CENTRE_CELL], 6);
    expect(f.contributing).toBe(1);

    const none = accumulateDensity([p, p], [0, 0], DENSITY);
    expect(none.max).toBe(0);
    expect(none.contributing).toBe(0);
    expect(Array.from(none.values).every((v) => v === 0)).toBe(true);
  });

  it('scales a FADING sample by its alpha', () => {
    const p = sampleAt(CENTRE_LON, CENTRE_LAT);
    const half = accumulateDensity([p], [0.5], DENSITY);
    const full = accumulateDensity([p], [1], DENSITY);
    expect(half.values[CENTRE_CELL]).toBeCloseTo(
      0.5 * full.values[CENTRE_CELL],
      6,
    );
  });

  it('falls to zero at the kernel radius and stays zero outside it', () => {
    const f = accumulateDensity(
      [sampleAt(CENTRE_LON, CENTRE_LAT)],
      null,
      DENSITY,
    );
    // Cell (32, 32) is the centre; radius is 8 cells.
    expect(f.values[32 * 64 + 39]).toBeGreaterThan(0);
    expect(f.values[32 * 64 + 40]).toBe(0);
    expect(f.values[32 * 64 + 60]).toBe(0);
  });

  it('never loses a point to a sub-cell radius', () => {
    const f = accumulateDensity([sampleAt(CENTRE_LON, CENTRE_LAT)], null, {
      ...DENSITY,
      radiusPixels: 0.01,
    });
    expect(f.max).toBeGreaterThan(0);
    expect(f.contributing).toBe(1);
  });

  it('MEAN aggregation averages weights instead of summing density', () => {
    const p = sampleAt(CENTRE_LON, CENTRE_LAT, 4);
    const q = sampleAt(CENTRE_LON, CENTRE_LAT, 4, 1);
    const mean = accumulateDensity([p, q], null, {
      ...DENSITY,
      aggregation: 'MEAN',
    });
    const sum = accumulateDensity([p, q], null, DENSITY);
    expect(mean.values[CENTRE_CELL]).toBeCloseTo(4, 5); // the shared weight
    expect(sum.values[CENTRE_CELL]).toBeCloseTo(8, 5); // 2 x 4
  });

  it('returns an empty field for a degenerate box rather than dividing by zero', () => {
    const f = accumulateDensity([sampleAt(0, 0)], null, {
      bounds: { west: 0, south: 0, east: 0, north: 0 },
      width: 16,
      height: 16,
    });
    expect(f.max).toBe(0);
    expect(Number.isFinite(f.values[0])).toBe(true);
  });

  it('resolves radiusMeters through wgs84 geometry, anisotropically', () => {
    const f = accumulateDensity([sampleAt(CENTRE_LON, CENTRE_LAT)], null, {
      bounds: BOUNDS,
      width: 64,
      height: 64,
      radiusMeters: 50_000,
    });
    // 1 cell of this box is ~3.5 km wide, so 50 km is ~14 cells.
    expect(f.radiusX).toBeGreaterThan(10);
    expect(f.radiusX).toBeLessThan(20);
    expect(f.max).toBeGreaterThan(0);
  });
});

describe('ORDERING: the ramp is applied AFTER accumulation', () => {
  const p = sampleAt(CENTRE_LON, CENTRE_LAT);
  const q = sampleAt(CENTRE_LON, CENTRE_LAT, 1, 1);
  const one = accumulateDensity([p], null, DENSITY);
  const two = accumulateDensity([p, q], null, DENSITY);
  // A FIXED domain, so the two rasters are comparable: with the default
  // auto-domain each field renormalises to its own peak and the difference
  // between one point and two would be invisible.
  const domain: [number, number] = [0, 2];

  it('maps the SUMMED density through the palette', () => {
    const hot = rampDensityField(two, { colorDomain: domain, threshold: 0 });
    const o = CENTRE_CELL * 4;
    const expected = sampleColorRange(DEFAULT_COLOR_RANGE, 1); // summed value 2 / domain 2
    expect(hot.rgba[o]).toBe(Math.round(expected[0]));
    expect(hot.rgba[o + 1]).toBe(Math.round(expected[1]));
    expect(hot.rgba[o + 2]).toBe(Math.round(expected[2]));
    expect(hot.rgba[o + 3]).toBe(255);
  });

  it('puts two coincident points at the HOT end and one at the middle of the ramp', () => {
    const o = CENTRE_CELL * 4;
    const warm = rampDensityField(one, { colorDomain: domain, threshold: 0 });
    const hot = rampDensityField(two, { colorDomain: domain, threshold: 0 });
    // The default range runs pale yellow -> deep red: hotter means less green.
    expect(hot.rgba[o + 1]).toBeLessThan(warm.rgba[o + 1]);
    expect(hot.rgba[o]).toBeLessThan(warm.rgba[o]);
    expect(hot.rgba[o + 3]).toBeGreaterThan(warm.rgba[o + 3]);
  });

  it('DIVERGES from the naive per-splat colour sum, which blows out to white', () => {
    const o = CENTRE_CELL * 4;
    const hot = rampDensityField(two, { colorDomain: domain, threshold: 0 });
    // The bug this file exists to prevent: ramp each point on its own, then add
    // the COLOURS. Both points ramp at 1/2 of the domain, and the sum clips.
    const perSplat = sampleColorRange(DEFAULT_COLOR_RANGE, 0.5);
    const naive = [
      Math.min(255, 2 * perSplat[0]),
      Math.min(255, 2 * perSplat[1]),
      Math.min(255, 2 * perSplat[2]),
    ];
    expect(naive[0]).toBe(255); // clipped
    expect(naive[1]).toBe(255); // clipped -> the "everything goes white" symptom
    // The correct answer is the deep-red hot end, nowhere near that.
    expect(hot.rgba[o]).toBeLessThan(200);
    expect(hot.rgba[o + 1]).toBeLessThan(40);
    expect(Math.abs(hot.rgba[o + 1] - naive[1])).toBeGreaterThan(200);
  });

  it('is what renderHeatmapRaster composes, in that order', () => {
    const out = renderHeatmapRaster([p, q], null, DENSITY, {
      colorDomain: domain,
      threshold: 0,
    });
    const direct = rampDensityField(two, { colorDomain: domain, threshold: 0 });
    expect(out.field.values[CENTRE_CELL]).toBeCloseTo(2, 6);
    expect(Array.from(out.rgba)).toEqual(Array.from(direct.rgba));
  });
});

describe('rampDensityField', () => {
  const p = sampleAt(CENTRE_LON, CENTRE_LAT);
  const field = accumulateDensity([p], null, DENSITY);

  it('writes fully transparent cells at or below the threshold', () => {
    const r = rampDensityField(field, { threshold: 0.5 });
    // The kernel shoulder is below half the peak well before the radius.
    const shoulder = (32 * 64 + 38) * 4;
    expect(r.rgba[shoulder + 3]).toBe(0);
    expect(r.rgba[CENTRE_CELL * 4 + 3]).toBe(255);
  });

  it('leaves the whole raster transparent outside every kernel', () => {
    const r = rampDensityField(field);
    expect(r.rgba[0]).toBe(0);
    expect(r.rgba[3]).toBe(0);
  });

  it('auto-scales to the field max when no colorDomain is given', () => {
    const hotter = accumulateDensity(
      [sampleAt(CENTRE_LON, CENTRE_LAT, 9)],
      null,
      DENSITY,
    );
    const a = rampDensityField(field, { threshold: 0 });
    const b = rampDensityField(hotter, { threshold: 0 });
    // Both peak at u = 1, so auto-scaling makes the peak colour identical.
    expect(
      Array.from(a.rgba.slice(CENTRE_CELL * 4, CENTRE_CELL * 4 + 4)),
    ).toEqual(Array.from(b.rgba.slice(CENTRE_CELL * 4, CENTRE_CELL * 4 + 4)));
    expect(a.domain).toEqual([0, field.max]);
  });

  it('applies opacity as a multiplier on the ramped alpha', () => {
    const full = rampDensityField(field, { threshold: 0 });
    const half = rampDensityField(field, { threshold: 0, opacity: 0.5 });
    expect(half.rgba[CENTRE_CELL * 4 + 3]).toBeCloseTo(
      full.rgba[CENTRE_CELL * 4 + 3] / 2,
      -1,
    );
  });

  it('pushes more of the field over the threshold as intensity rises', () => {
    const dim = rampDensityField(field, { intensity: 1, threshold: 0.5 });
    const bright = rampDensityField(field, { intensity: 3, threshold: 0.5 });
    const lit = (r: Uint8ClampedArray): number => {
      let n = 0;
      for (let i = 3; i < r.length; i += 4) if (r[i] > 0) n++;
      return n;
    };
    expect(lit(bright.rgba)).toBeGreaterThan(lit(dim.rgba));
  });

  it('returns a blank raster (not NaN) for an all-zero field', () => {
    const empty = accumulateDensity([], null, DENSITY);
    const r = rampDensityField(empty);
    expect(r.rgba.every((v) => v === 0)).toBe(true);
    expect(r.domain).toEqual([0, 0]);
  });
});

describe('sampleColorRange', () => {
  it('interpolates linearly between stops, matching deck’s filtered ramp texture', () => {
    const range = [
      [0, 0, 0, 0],
      [100, 200, 40, 255],
    ] as const;
    expect(sampleColorRange(range as never, 0)).toEqual([0, 0, 0, 0]);
    expect(sampleColorRange(range as never, 1)).toEqual([100, 200, 40, 255]);
    expect(sampleColorRange(range as never, 0.5)).toEqual([50, 100, 20, 127.5]);
  });

  it('clamps outside 0..1 and survives degenerate ranges', () => {
    expect(sampleColorRange(DEFAULT_COLOR_RANGE, -5)).toEqual([
      255, 255, 178, 255,
    ]);
    expect(sampleColorRange(DEFAULT_COLOR_RANGE, 5)).toEqual([189, 0, 38, 255]);
    expect(sampleColorRange([], 0.5)).toEqual([0, 0, 0, 0]);
    expect(sampleColorRange([[1, 2, 3, 4]], 0.5)).toEqual([1, 2, 3, 4]);
  });

  it('defaults a missing alpha channel to opaque', () => {
    expect(sampleColorRange([[1, 2, 3] as never], 0)).toEqual([1, 2, 3, 255]);
  });
});

describe('geodesy helpers', () => {
  it('metresPerCell is anisotropic even at the equator (wgs84, not a sphere)', () => {
    const { mx, my } = metresPerCell(
      { west: -0.5, south: -0.5, east: 0.5, north: 0.5 },
      100,
      100,
    );
    // 0.01 degrees: ~1113 m along the equator, ~1106 m along the meridian.
    expect(mx).toBeGreaterThan(1105);
    expect(mx).toBeLessThan(1120);
    expect(my).toBeGreaterThan(1100);
    expect(my).toBeLessThan(1112);
    expect(mx).toBeGreaterThan(my); // the flattening, visible
  });

  it('shrinks the east/west cell by cos(lat) at 60 degrees north', () => {
    const { mx, my } = metresPerCell(
      { west: -0.5, south: 59.5, east: 0.5, north: 60.5 },
      100,
      100,
    );
    expect(mx / my).toBeGreaterThan(0.48);
    expect(mx / my).toBeLessThan(0.52);
  });

  it('fieldGridForBounds keeps cells near-square in METRES and clamps the size', () => {
    const wide = fieldGridForBounds(
      { west: -10, south: -1, east: 10, north: 1 },
      256,
    );
    expect(wide.width).toBe(256);
    expect(wide.height).toBeLessThan(64);

    const tall = fieldGridForBounds(
      { west: -1, south: -10, east: 1, north: 10 },
      256,
    );
    expect(tall.height).toBe(256);
    expect(tall.width).toBeLessThan(64);

    const clamped = fieldGridForBounds(BOUNDS, 99_999);
    expect(clamped.width).toBeLessThanOrEqual(1024);
    expect(fieldGridForBounds(BOUNDS, 1).width).toBeGreaterThanOrEqual(8);
  });

  it('padHeatmapBounds never returns a degenerate box for a single point', () => {
    const b = padHeatmapBounds({ west: 5, south: 5, east: 5, north: 5 });
    expect(b.east).toBeGreaterThan(b.west);
    expect(b.north).toBeGreaterThan(b.south);
  });

  it('padHeatmapBounds grows by a fraction of the span and clamps to the globe', () => {
    const b = padHeatmapBounds({ west: 0, south: 0, east: 10, north: 10 }, 0.1);
    expect(b.west).toBeCloseTo(-1, 6);
    expect(b.east).toBeCloseTo(11, 6);
    const polar = padHeatmapBounds(
      { west: -179, south: 80, east: 179, north: 89 },
      0.5,
    );
    expect(polar.north).toBe(90);
    expect(polar.west).toBe(-180);
    expect(polar.east).toBe(180);
  });
});

describe('field readout', () => {
  const p = sampleAt(CENTRE_LON, CENTRE_LAT);
  const field = accumulateDensity(
    [p, sampleAt(-0.5, 0.5, 0.2, 1)],
    null,
    DENSITY,
  );

  it('peakCell finds the hottest cell and reports its centre coordinate', () => {
    const peak = peakCell(field);
    expect(peak).not.toBeNull();
    expect(peak?.x).toBe(32);
    expect(peak?.y).toBe(32);
    expect(peak?.lon).toBeCloseTo(CENTRE_LON, 9);
    expect(peak?.lat).toBeCloseTo(CENTRE_LAT, 9);
  });

  it('peakCell returns null for an empty field', () => {
    expect(peakCell(accumulateDensity([], null, DENSITY))).toBeNull();
  });

  it('cellCenterLonLat puts row 0 on the NORTH edge (image convention)', () => {
    const [, topLat] = cellCenterLonLat(field, 0, 0);
    const [, bottomLat] = cellCenterLonLat(field, 0, 63);
    expect(topLat).toBeGreaterThan(bottomLat);
    expect(topLat).toBeCloseTo(1 - 0.5 / 32, 9);
  });

  it('nearestSample resolves the closest CONTRIBUTING sample', () => {
    const samples = [sampleAt(0, 0, 1, 7), sampleAt(10, 10, 1, 9)];
    expect(nearestSample(samples, null, 0.1, 0.1)?.featureIndex).toBe(7);
    expect(nearestSample(samples, null, 9.9, 9.9)?.featureIndex).toBe(9);
    // A zeroed alpha means "not in the picture" — skip it entirely.
    expect(nearestSample(samples, [0, 1], 0.1, 0.1)?.featureIndex).toBe(9);
    expect(nearestSample(samples, [0, 0], 0, 0)).toBeNull();
    expect(nearestSample([], null, 0, 0)).toBeNull();
  });
});

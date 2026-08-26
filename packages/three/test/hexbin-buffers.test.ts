// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// The RUNTIME hexbin's two pure halves: `buildHexbinBuffers` (the lattice, the
// geometry-kind guard, the weight column, the CSR membership table) and
// `aggregateHexbins` (the play-head reduction). Both are Three-free, so this
// suite is plain Node — see the package test policy.
//
// The load-bearing claims under test:
//   • the lattice is EXACT — a cell centroid bins back to its own address over a
//     dense sweep, which is the property that makes the partition a partition;
//   • it is DETERMINISTIC and world-anchored — same input, byte-identical
//     output, and two tiles sharing a hexagon collapse into ONE cell;
//   • the geometry-kind guard: Point tiles bin per FEATURE, LineString tiles bin
//     per VERTEX, Polygon tiles are skipped with one named warning;
//   • the weight column resolves through the accessor-alias precedence, and a
//     function-valued alias warns once and falls through;
//   • the aggregate genuinely RE-AGGREGATES as the window moves (it is not a
//     cross-fade and not a static aggregate), and is a pure function of its
//     inputs so an unmoved play head is cacheable.
//
// The last block closes that loop on `STTHexbinLayer` itself: the three-part
// aggregate cache key (build generation × window bucket × aggregation epoch) is
// what turns "pure function" into "not recomputed per frame", and
// `getStats().aggregateGeneration` is the observable that proves it.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import {
  aggregateHexbins,
  buildHexbinBuffers,
  hexbinCentroidMercator,
  hexbinKey,
  hexbinKeyI,
  hexbinKeyJ,
  hexbinKeyForPoint,
  hexbinRadiusFromMeters,
  hexbinValueDomain,
  hexbinWindowBucket,
  lngLatToMercatorUnit,
  mercatorUnitToLngLat,
  pointToHexbinAxial,
  resetHexbinWarnings,
  resolveHexbinLatitude,
  resolveHexbinWeightProperty,
  DEFAULT_HEXBIN_COLOR_RANGE,
} from '../src/lib/hexbin-buffers';
import { STTHexbinLayer } from '../src/layers/hexbin-layer';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { MercatorProjection } from '../src/projection/mercator';
import { featureTileKey } from '../src/lib/id-pick';
import { makeLineTile, makePointTile } from './_support/features';
import { expectEmptyBuffers, expectRtcMercator } from './_support/rtc';

const anchor = { longitude: 0, latitude: 0 };
const proj = new LocalEnuProjection(anchor);

/** 1 km cells resolved at the equator — the pitch every fixture below uses. */
const RADIUS_M = 1000;
const R_MERC = hexbinRadiusFromMeters(RADIUS_M, 0);

// Four lon/lat probes whose cells were derived from the lattice kernel itself:
// A and B share one hexagon, C is one ROW north of it, D one COLUMN east.
const A: [number, number] = [0, 0];
const B: [number, number] = [0.0122788, -0.0045665];
const C: [number, number] = [0.013057, 0.008908];
const D: [number, number] = [0.020836, -0.004567];
const CELL_AB: [number, number] = [11569, 13358];
const CELL_C: [number, number] = [11569, 13359];
const CELL_D: [number, number] = [11570, 13358];

/** The four probes as one point tile, optionally weighted / timed. */
function probeTile(
  partial: Parameters<typeof makePointTile>[2] = {},
  opts: Parameters<typeof makePointTile>[3] = {},
) {
  return makePointTile(
    4,
    [A[0], A[1], B[0], B[1], C[0], C[1], D[0], D[1]],
    partial,
    opts,
  );
}

beforeEach(() => {
  resetHexbinWarnings();
});

// ── The lattice ─────────────────────────────────────────────────────────────

describe('hexbin lattice', () => {
  it('bins a cell centroid back to its own axial address (dense sweep)', () => {
    // The partition property: if a centroid ever rounded into a neighbour, cells
    // would overlap and points would be double-counted at the seam.
    let mismatches = 0;
    for (let i = -40; i <= 40; i++) {
      for (let j = -40; j <= 40; j++) {
        const [mx, my] = hexbinCentroidMercator(i, j, R_MERC);
        const [bi, bj] = pointToHexbinAxial(mx, my, R_MERC);
        if (bi !== i || bj !== j) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  });

  it('packs and unpacks an axial address losslessly, incl. negatives', () => {
    for (const [i, j] of [
      [0, 0],
      [11569, 13358],
      [-1, -1],
      [-33_554_431, 33_554_431],
    ] as Array<[number, number]>) {
      const key = hexbinKey(i, j);
      expect(hexbinKeyI(key)).toBe(i);
      expect(hexbinKeyJ(key)).toBe(j);
    }
    // Outside the packable range the key is NaN, so the caller DROPS the entry
    // rather than letting every out-of-range point collapse into one bucket.
    expect(Number.isNaN(hexbinKey(1 << 25, 0))).toBe(true);
    expect(Number.isNaN(hexbinKey(0, -(1 << 25) - 1))).toBe(true);
  });

  it('round-trips the mercator unit square', () => {
    const [x, y] = lngLatToMercatorUnit(-71.05, 42.35);
    const [lon, lat] = mercatorUnitToLngLat(x, y);
    expect(lon).toBeCloseTo(-71.05, 9);
    expect(lat).toBeCloseTo(42.35, 9);
  });

  it('resolves the metric radius at ONE latitude (deck data-bounds rule)', () => {
    // The pitch must NOT be re-derived per tile: cos(lat) stretches mercator, so
    // a per-tile latitude makes neighbouring tiles disagree about the lattice.
    expect(resolveHexbinLatitude(10, 20)).toBe(15);
    expect(resolveHexbinLatitude(10, 20, 42)).toBe(42);
    expect(resolveHexbinLatitude(NaN, NaN)).toBe(0);
    // Same metres, higher latitude ⇒ a LARGER mercator radius (1/cos lat).
    expect(hexbinRadiusFromMeters(1000, 60)).toBeCloseTo(R_MERC * 2, 12);
  });

  it('places the probe fixtures in the expected axial cells', () => {
    const cellOf = (p: [number, number]): [number, number] =>
      pointToHexbinAxial(...lngLatToMercatorUnit(p[0], p[1]), R_MERC);
    expect(cellOf(A)).toEqual(CELL_AB);
    expect(cellOf(B)).toEqual(CELL_AB);
    expect(cellOf(C)).toEqual(CELL_C);
    expect(cellOf(D)).toEqual(CELL_D);
    // A and B are 1.3 km apart yet share a cell; B and D are 0.9 km apart and do
    // not — the partition is the hexagon, not a radius around a point.
    expect(hexbinKeyForPoint(...lngLatToMercatorUnit(...A), R_MERC)).toBe(
      hexbinKeyForPoint(...lngLatToMercatorUnit(...B), R_MERC),
    );
  });
});

// ── Binning ─────────────────────────────────────────────────────────────────

describe('buildHexbinBuffers', () => {
  it('bins POINT tiles one entry per FEATURE and merges shared cells', () => {
    const buf = buildHexbinBuffers([probeTile()], proj, 0, {
      radius: RADIUS_M,
      radiusLatitude: 0,
    });
    expect(buf.entryCount).toBe(4);
    expect(buf.droppedEntries).toBe(0);
    expect(buf.count).toBe(3); // A+B collapse into one cell
    expect([buf.cellIJ[0], buf.cellIJ[1]]).toEqual(CELL_AB);
    expect([buf.cellIJ[2], buf.cellIJ[3]]).toEqual(CELL_C);
    expect([buf.cellIJ[4], buf.cellIJ[5]]).toEqual(CELL_D);
    // CSR: cell 0 has two members, the other two have one each.
    expect(Array.from(buf.memberOffsets)).toEqual([0, 2, 3, 4]);
    // The cell's reported centroid is the LATTICE centroid, not a point.
    const [clon, clat] = mercatorUnitToLngLat(
      ...hexbinCentroidMercator(CELL_AB[0], CELL_AB[1], R_MERC),
    );
    expect(buf.cellLngLat[0]).toBeCloseTo(clon, 12);
    expect(buf.cellLngLat[1]).toBeCloseTo(clat, 12);
  });

  it('is deterministic — the same tiles rebuild byte-identical buffers', () => {
    const opts = { radius: RADIUS_M, radiusLatitude: 0 };
    const a = buildHexbinBuffers([probeTile()], proj, 0, opts);
    const b = buildHexbinBuffers([probeTile()], proj, 0, opts);
    expect(Array.from(a.cellKeys)).toEqual(Array.from(b.cellKeys));
    expect(Array.from(a.bases)).toEqual(Array.from(b.bases));
    expect(Array.from(a.basisX)).toEqual(Array.from(b.basisX));
    expect(a.radiusMerc).toBe(b.radiusMerc);
  });

  it('collapses a hexagon fed by TWO tiles into ONE cell (no tile seam)', () => {
    // The lattice is world-anchored, so the same hexagon addressed from two
    // different tiles is the same key — one cell with both tiles' members, not
    // two half-weight cells at the boundary.
    const t1 = makePointTile(
      1,
      [A[0], A[1]],
      {},
      { id: { z: 12, x: 0, y: 0, t: 0 } },
    );
    const t2 = makePointTile(
      1,
      [B[0], B[1]],
      {},
      { id: { z: 12, x: 1, y: 0, t: 0 } },
    );
    const buf = buildHexbinBuffers([t1, t2], proj, 0, {
      radius: RADIUS_M,
      radiusLatitude: 0,
    });
    expect(buf.count).toBe(1);
    expect(buf.memberOffsets[1]).toBe(2);
    expect(buf.binaryByTileKey.size).toBe(2);
  });

  it('bins LINESTRING tiles one entry per VERTEX, not per feature', () => {
    // A trip archive must hexbin TRACK DENSITY. One feature, four vertices ⇒
    // four entries in three cells; reading `positions[i]` per feature would have
    // produced one entry sitting on the first vertex.
    const line = makeLineTile(
      {
        featureCount: 1,
        positions: new Float64Array([
          A[0],
          A[1],
          B[0],
          B[1],
          C[0],
          C[1],
          D[0],
          D[1],
        ]),
        startIndices: new Uint32Array([0, 4]),
        startTimes: new Float32Array([0]),
        endTimes: new Float32Array([1000]),
      },
      { layerName: 'trips' },
    );
    const buf = buildHexbinBuffers([line], proj, 0, {
      radius: RADIUS_M,
      radiusLatitude: 0,
    });
    expect(buf.entryCount).toBe(4);
    expect(buf.count).toBe(3);
    expect(Array.from(buf.memberOffsets)).toEqual([0, 2, 3, 4]);
    // Every entry belongs to feature 0, so every cell's representative is it.
    for (let c = 0; c < buf.count; c++) {
      expect(buf.provenance.resolve(c)!.featureIndex).toBe(0);
    }
  });

  it('gates path vertices by vertexTimestamps when the tile carries them', () => {
    const line = makeLineTile(
      {
        featureCount: 1,
        positions: new Float64Array([A[0], A[1], C[0], C[1], D[0], D[1]]),
        startIndices: new Uint32Array([0, 3]),
        startTimes: new Float32Array([0]),
        endTimes: new Float32Array([1000]),
        vertexTimestamps: new Float32Array([0, 500, 1000]),
      },
      { layerName: 'trips' },
    );
    const buf = buildHexbinBuffers([line], proj, 0, {
      radius: RADIUS_M,
      radiusLatitude: 0,
    });
    expect(Array.from(buf.memberStarts)).toEqual([0, 500, 1000]);
    expect(Array.from(buf.memberEnds)).toEqual([0, 500, 1000]);
  });

  it('SKIPS polygon tiles with ONE named warning instead of mis-reading them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const poly = makeLineTile(
      {
        featureCount: 2,
        positions: new Float64Array([
          A[0],
          A[1],
          C[0],
          C[1],
          D[0],
          D[1],
          A[0],
          A[1],
        ]),
        startIndices: new Uint32Array([0, 4, 4]),
        startTimes: new Float32Array([0, 0]),
        endTimes: new Float32Array([1000, 1000]),
      },
      { geometryType: GeometryType.Polygon, layerName: 'zones' },
    );
    const buf = buildHexbinBuffers([poly, probeTile()], proj, 0, {
      radius: RADIUS_M,
      radiusLatitude: 0,
    });
    expect(buf.skippedLayers).toBe(1);
    // The polygon contributed nothing; the point tile still binned normally.
    expect(buf.entryCount).toBe(4);
    expect(buf.count).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('Polygon');
    // Named + one-shot: a second build does not re-warn.
    buildHexbinBuffers([poly], proj, 0, {
      radius: RADIUS_M,
      radiusLatitude: 0,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('emits the empty (non-null) shape when nothing merges', () => {
    const buf = buildHexbinBuffers([], proj, 0, { radius: RADIUS_M });
    expectEmptyBuffers(buf);
    expect(buf.provenance.length).toBe(0);
    expect(buf.binaryByTileKey.size).toBe(0);
    expect(Array.from(buf.memberOffsets)).toEqual([0]);
    expect(buf.origin).toEqual([0, 0, 0]);
  });

  it('scales the footprint by coverage and lifts it by zLift', () => {
    const full = buildHexbinBuffers([probeTile()], proj, 0, {
      radius: RADIUS_M,
      radiusLatitude: 0,
    });
    const half = buildHexbinBuffers([probeTile()], proj, 0, {
      radius: RADIUS_M,
      radiusLatitude: 0,
      coverage: 0.5,
      zLift: 25,
    });
    // The unit prism has an INCIRCLE of 1 while deck's radius is the
    // CIRCUMRADIUS, so the ground scale is `radius · cos(30°) · coverage`.
    expect(full.basisX[0]).toBeCloseTo(RADIUS_M * Math.cos(Math.PI / 6), 3);
    expect(half.basisX[0]).toBeCloseTo(full.basisX[0] / 2, 3);
    // RTC: the lift rides on the ORIGIN, so the relative bases are unchanged.
    expect(half.origin[2] - full.origin[2]).toBeCloseTo(25, 9);
    expect(half.bases[2]).toBeCloseTo(full.bases[2], 9);
    // basisZ is world units per METRE of elevation (ENU world units ARE metres).
    expect(half.basisZ[2]).toBeCloseTo(1, 9);
  });

  it('keeps RTC offsets tiny under mercator', () => {
    const merc = new MercatorProjection();
    const buf = buildHexbinBuffers(
      [makePointTile(1, [-71.05, 42.35])],
      merc,
      0,
      { radius: 200 },
    );
    expectRtcMercator(buf, { a: buf.bases[0], b: buf.basisX[0] });
    // metric → world divides by cos(lat) — resolved at the CELL CENTROID, which
    // is the latitude the cell is actually drawn at, not the sample point's.
    const cellLat = buf.cellLngLat[1];
    expect(buf.basisX[0]).toBeCloseTo(
      (200 * Math.cos(Math.PI / 6)) / Math.cos((cellLat * Math.PI) / 180),
      3,
    );
  });
});

// ── Weight resolution ───────────────────────────────────────────────────────

describe('resolveHexbinWeightProperty (accessor-alias convention)', () => {
  it('applies the documented precedence', () => {
    expect(
      resolveHexbinWeightProperty({
        colorWeight: 'fare',
        elevationWeight: 'tip',
        weightProperty: 'legacy',
      }),
    ).toBe('fare');
    expect(
      resolveHexbinWeightProperty({
        elevationWeight: 'tip',
        weightProperty: 'legacy',
      }),
    ).toBe('tip');
    expect(resolveHexbinWeightProperty({ weightProperty: 'legacy' })).toBe(
      'legacy',
    );
    // Unset ⇒ a pure COUNT hexbin (every entry weighs 1).
    expect(resolveHexbinWeightProperty({})).toBeNull();
    expect(resolveHexbinWeightProperty({ weightProperty: null })).toBeNull();
  });

  it('warns ONCE on a function accessor and falls through to the next alias', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = (d: unknown) => d;
    expect(
      resolveHexbinWeightProperty(
        { colorWeight: fn, elevationWeight: 'tip' },
        'hexbin',
      ),
    ).toBe('tip');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('colorWeight');
    // Every alias a function ⇒ a COUNT hexbin, not a crash.
    expect(
      resolveHexbinWeightProperty(
        { colorWeight: fn, elevationWeight: fn, weightProperty: null },
        'hexbin',
      ),
    ).toBeNull();
    // colorWeight already warned; only elevationWeight adds a second line.
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('weights every entry by the resolved column (and by 1 when unset)', () => {
    const weighted = buildHexbinBuffers(
      [probeTile({ numericProps: { fare: new Float32Array([2, 3, 5, 7]) } })],
      proj,
      0,
      { radius: RADIUS_M, radiusLatitude: 0, colorWeight: 'fare' },
    );
    expect(weighted.weightProperty).toBe('fare');
    expect(Array.from(weighted.memberWeights)).toEqual([2, 3, 5, 7]);

    const counted = buildHexbinBuffers([probeTile()], proj, 0, {
      radius: RADIUS_M,
      radiusLatitude: 0,
    });
    expect(counted.weightProperty).toBeNull();
    expect(Array.from(counted.memberWeights)).toEqual([1, 1, 1, 1]);
  });
});

// ── Aggregation ─────────────────────────────────────────────────────────────

const WEIGHTED = () =>
  buildHexbinBuffers(
    [
      probeTile({
        numericProps: { fare: new Float32Array([2, 3, 5, 7]) },
        startTimes: new Float32Array([0, 0, 500, 1000]),
        endTimes: new Float32Array([0, 0, 500, 1000]),
      }),
    ],
    proj,
    0,
    { radius: RADIUS_M, radiusLatitude: 0, colorWeight: 'fare' },
  );

describe('aggregateHexbins', () => {
  it('reduces one weight column into BOTH the colour and elevation channels', () => {
    const buf = WEIGHTED();
    const agg = aggregateHexbins(buf, {
      relativeCurrentTime: 0,
      timeFiltered: false,
    });
    expect(Array.from(agg.values)).toEqual([5, 5, 7]); // 2+3, 5, 7
    expect(Array.from(agg.elevationValues)).toEqual([5, 5, 7]);
    expect(Array.from(agg.contributors)).toEqual([2, 1, 1]);
    expect(agg.occupiedCells).toBe(3);
    expect(agg.colorDomain).toEqual([5, 7]);
    // Extrusion: the domain floor sits on the ground, the ceiling at the top of
    // `elevationRange`.
    expect(agg.heights[0]).toBe(0);
    expect(agg.heights[2]).toBe(1000);
    // Quantize (deck's default) buckets the domain across the 6-stop ramp.
    expect(agg.colors[0]).toBeCloseTo(
      DEFAULT_HEXBIN_COLOR_RANGE[0][0] / 255,
      6,
    );
    expect(agg.colors[8]).toBeCloseTo(
      DEFAULT_HEXBIN_COLOR_RANGE[5][0] / 255,
      6,
    );
  });

  it('honours every aggregation operation (no MIN/MAX degradation here)', () => {
    const buf = WEIGHTED();
    const at = (op: 'SUM' | 'MEAN' | 'MIN' | 'MAX' | 'COUNT') =>
      Array.from(
        aggregateHexbins(buf, {
          relativeCurrentTime: 0,
          timeFiltered: false,
          colorAggregation: op,
        }).values,
      );
    expect(at('SUM')).toEqual([5, 5, 7]);
    expect(at('COUNT')).toEqual([2, 1, 1]);
    expect(at('MEAN')).toEqual([2.5, 5, 7]);
    expect(at('MIN')).toEqual([2, 5, 7]);
    expect(at('MAX')).toEqual([3, 5, 7]);
  });

  it('RE-AGGREGATES as the window moves — cells appear and vanish', () => {
    // The three cells hold members at t = 0/0, 500 and 1000. A 200 ms half-window
    // sliding across them must hand back a DIFFERENT reduction each time; a
    // cross-fade or a static aggregate would not.
    const buf = WEIGHTED();
    const at = (t: number) =>
      aggregateHexbins(buf, {
        relativeCurrentTime: t,
        params: { windowHalf: 200 },
      });

    const t0 = at(0);
    expect(Array.from(t0.contributors)).toEqual([2, 0, 0]);
    expect(t0.values[0]).toBe(5);
    expect(Array.from(t0.visible)).toEqual([1, 0, 0]);

    const t500 = at(500);
    expect(Array.from(t500.contributors)).toEqual([0, 1, 0]);
    expect(Array.from(t500.visible)).toEqual([0, 1, 0]);

    const t1000 = at(1000);
    expect(Array.from(t1000.contributors)).toEqual([0, 0, 1]);
    expect(t1000.values[2]).toBe(7);

    // An EMPTY cell is absence, not a zero sample: it neither draws nor drags
    // the auto domain down to 0.
    expect(t1000.colorDomain).toEqual([7, 7]);
    expect(t1000.occupiedCells).toBe(1);
  });

  it('weights a half-faded member by its own alpha (Σ gate is the denominator)', () => {
    const buf = WEIGHTED();
    // fadeOut 400 with the window trailing edge 200 behind t=200 ⇒ the two t=0
    // members are half out: alpha = (0 − 0) ... exercise a partial gate.
    const agg = aggregateHexbins(buf, {
      relativeCurrentTime: 100,
      params: { windowHalf: 200, fadeOut: 400 },
      colorAggregation: 'COUNT',
    });
    // Both t=0 members are inside the hard window but on the fade-out ramp, so
    // COUNT is FRACTIONAL — a half-faded point counts a half.
    expect(agg.contributors[0]).toBe(2);
    expect(agg.values[0]).toBeGreaterThan(0);
    expect(agg.values[0]).toBeLessThan(2);
  });

  it('is a PURE function of its inputs (which is what makes it cacheable)', () => {
    const buf = WEIGHTED();
    const params = { relativeCurrentTime: 250, params: { windowHalf: 400 } };
    const a = aggregateHexbins(buf, params);
    const b = aggregateHexbins(buf, params);
    expect(Array.from(a.values)).toEqual(Array.from(b.values));
    expect(Array.from(a.colors)).toEqual(Array.from(b.colors));
    expect(Array.from(a.visible)).toEqual(Array.from(b.visible));
  });

  it('clips by percentile band and honours a pinned colour domain', () => {
    const buf = WEIGHTED();
    const clipped = aggregateHexbins(buf, {
      relativeCurrentTime: 0,
      timeFiltered: false,
      upperPercentile: 50,
    });
    // Values [5, 5, 7]; the 50th percentile of the occupied cells is 5, so the
    // 7-cell falls outside the band and stops drawing.
    expect(Array.from(clipped.visible)).toEqual([1, 1, 0]);
    const pinned = aggregateHexbins(buf, {
      relativeCurrentTime: 0,
      timeFiltered: false,
      colorDomain: [0, 100],
    });
    expect(pinned.colorDomain).toEqual([0, 100]);
    expect(Array.from(pinned.visible)).toEqual([1, 1, 1]);
  });

  it('pins every height to 0 when extruded is false', () => {
    const buf = WEIGHTED();
    const flat = aggregateHexbins(buf, {
      relativeCurrentTime: 0,
      timeFiltered: false,
      extruded: false,
    });
    expect(Array.from(flat.heights)).toEqual([0, 0, 0]);
    expect(Array.from(flat.visible)).toEqual([1, 1, 1]); // still drawn, just flat
  });

  it('degrades quantile/ordinal to quantize with ONE warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const buf = WEIGHTED();
    const base = { relativeCurrentTime: 0, timeFiltered: false } as const;
    const quantized = aggregateHexbins(buf, base);
    const degraded = aggregateHexbins(buf, {
      ...base,
      colorScaleType: 'quantile',
    });
    expect(Array.from(degraded.colors)).toEqual(Array.from(quantized.colors));
    expect(warn).toHaveBeenCalledTimes(1);
    aggregateHexbins(buf, { ...base, colorScaleType: 'quantile' });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('holds the domain (returns null) when nothing is occupied', () => {
    const values = [1, 2, 3];
    const none = [0, 0, 0];
    expect(hexbinValueDomain(values, none, 3)).toBeNull();
    expect(hexbinValueDomain(values, [1, 1, 1], 3)).toEqual([1, 3]);
    expect(hexbinValueDomain(values, [1, 0, 1], 3)).toEqual([1, 3]);
  });
});

// ── The cache key's time component ──────────────────────────────────────────

describe('hexbinWindowBucket', () => {
  it('quantises the play head so an unmoved frame is a cache hit', () => {
    expect(hexbinWindowBucket(0, 400)).toBe(0);
    expect(hexbinWindowBucket(399, 400)).toBe(0);
    expect(hexbinWindowBucket(400, 400)).toBe(1);
    expect(hexbinWindowBucket(-1, 400)).toBe(-1);
    // step <= 0 opts out of re-aggregation entirely (one aggregate per build).
    expect(hexbinWindowBucket(12_345, 0)).toBe(0);
  });
});

// ── Provenance is per CELL ──────────────────────────────────────────────────

describe('buildHexbinBuffers provenance (per CELL, not per feature)', () => {
  it('records the cell REPRESENTATIVE — its first contributing feature', () => {
    const id = { z: 12, x: 1, y: 2, t: 0 };
    const buf = buildHexbinBuffers(
      [probeTile({}, { id, layerName: 'rides' })],
      proj,
      0,
      { radius: RADIUS_M, radiusLatitude: 0 },
    );
    const key = featureTileKey(id, 'rides');
    // Cell 0 aggregates features 0 AND 1; the provenance names feature 0, the
    // first in merge order — a deterministic representative, not "what you
    // clicked". The real contributor count rides on memberOffsets.
    expect(buf.provenance.length).toBe(buf.count);
    expect(buf.provenance.resolve(0)).toEqual({
      tileKey: key,
      featureIndex: 0,
    });
    expect(buf.provenance.resolve(1)).toEqual({
      tileKey: key,
      featureIndex: 2,
    });
    expect(buf.provenance.resolve(2)).toEqual({
      tileKey: key,
      featureIndex: 3,
    });
    expect(buf.memberOffsets[1] - buf.memberOffsets[0]).toBe(2);
  });
});

// ── The layer's aggregate cache ─────────────────────────────────────────────

describe('STTHexbinLayer aggregate cache (build × bucket × epoch)', () => {
  const ctx = { projection: proj, timeOrigin: 0 };
  /** Members at t = 0/0, 500, 1000; a 200 ms half-window stepped every 400 ms. */
  const timedTile = () =>
    probeTile({
      startTimes: new Float32Array([0, 0, 500, 1000]),
      endTimes: new Float32Array([0, 0, 500, 1000]),
    });
  const makeLayer = () =>
    new STTHexbinLayer({
      id: 'rides',
      radius: RADIUS_M,
      radiusLatitude: 0,
      timeWindow: 400,
      aggregationStep: 400,
    });

  it('aggregates once on setTiles and fills the per-cell attributes', () => {
    const layer = makeLayer();
    layer.setTiles([timedTile()], ctx);
    const stats = layer.getStats();
    expect(stats.cellCount).toBe(3);
    expect(stats.aggregateGeneration).toBe(1);
    expect(stats.bucket).toBe(0);
    // Bucket 0 is evaluated at its CENTRE (200 ms), whose window [0, 400] holds
    // only the two t = 0 members.
    expect(Array.from(layer.getAggregate()!.contributors)).toEqual([2, 0, 0]);
    expect(stats.visibleCells).toBe(1);
    const visible = layer.object.geometry.getAttribute('sttVisible');
    expect(Array.from(visible.array as Float32Array)).toEqual([1, 0, 0]);
    layer.dispose();
  });

  it('does NOT recompute for a frame inside the same window bucket', () => {
    const layer = makeLayer();
    layer.setTiles([timedTile()], ctx);
    layer.setTime(1);
    layer.setTime(200);
    layer.setTime(399);
    // Three frames, one aggregate — the whole point of the bucket.
    expect(layer.getStats().aggregateGeneration).toBe(1);
    expect(layer.getStats().bucket).toBe(0);
    layer.dispose();
  });

  it('RE-AGGREGATES when the window centre crosses the aggregation step', () => {
    const layer = makeLayer();
    layer.setTiles([timedTile()], ctx);

    layer.setTime(400); // bucket 1, centre 600, window [400, 800]
    expect(layer.getStats().aggregateGeneration).toBe(2);
    expect(layer.getStats().bucket).toBe(1);
    expect(Array.from(layer.getAggregate()!.contributors)).toEqual([0, 1, 0]);

    layer.setTime(1000); // bucket 2, centre 1000, window [800, 1200]
    expect(layer.getStats().aggregateGeneration).toBe(3);
    expect(Array.from(layer.getAggregate()!.contributors)).toEqual([0, 0, 1]);
    // The GPU attributes moved with it — this is a real re-aggregation, not a
    // cross-fade over a frozen one.
    const visible = layer.object.geometry.getAttribute('sttVisible');
    expect(Array.from(visible.array as Float32Array)).toEqual([0, 0, 1]);
    // The SAME attribute object is re-filled and flagged for upload — the
    // geometry, the bases and the material are never rebuilt (audit E5).
    expect(visible.version).toBeGreaterThan(0);

    // Scrubbing BACK into bucket 1 reproduces bucket 1 exactly (the aggregate is
    // evaluated at the bucket centre, so it is a pure function of the bucket).
    layer.setTime(410);
    expect(layer.getStats().aggregateGeneration).toBe(4);
    expect(Array.from(layer.getAggregate()!.contributors)).toEqual([0, 1, 0]);
    layer.dispose();
  });

  it('invalidates on a new tile set and on an aggregation-config change', () => {
    const layer = makeLayer();
    layer.setTiles([timedTile()], ctx);
    expect(layer.getStats().buildGeneration).toBe(1);

    layer.setTiles([timedTile()], ctx);
    const afterRebuild = layer.getStats();
    expect(afterRebuild.buildGeneration).toBe(2);
    expect(afterRebuild.aggregateGeneration).toBe(2); // rebuilt, not reused

    layer.setAggregationOptions({ colorAggregation: 'COUNT' });
    const afterRestyle = layer.getStats();
    expect(afterRestyle.aggregateEpoch).toBe(1);
    expect(afterRestyle.aggregateGeneration).toBe(3);
    expect(afterRestyle.buildGeneration).toBe(2); // the lattice was NOT rebuilt
    layer.dispose();
  });

  it('honours aggregationStep: 0 as "never re-aggregate"', () => {
    const layer = new STTHexbinLayer({
      radius: RADIUS_M,
      radiusLatitude: 0,
      timeWindow: 400,
      aggregationStep: 0,
    });
    layer.setTiles([timedTile()], ctx);
    layer.setTime(500);
    layer.setTime(5000);
    expect(layer.getStats().aggregateGeneration).toBe(1);
    layer.dispose();
  });
});

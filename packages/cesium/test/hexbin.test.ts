// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Unit tests for `src/lib/hexbin.ts` — the PURE, Cesium-free runtime hexbin
 * builder. Everything here runs in plain Node with no GPU and no `Scene`;
 * `test/cesium-hexbin-layer.test.ts` covers the layer that consumes it.
 */

import { describe, expect, it } from 'vitest';
import {
  GeometryType,
  type BinaryFeatures,
  type Tile,
} from '@poopdeck.gl/core';
import {
  DEFAULT_HEXBIN_RAMP,
  aggregationBucket,
  axialFromPlane,
  axialRound,
  buildHexbins,
  collectHexbinLayers,
  configToken,
  hexRingLonLat,
  hexbinCacheKey,
  hexbinWindowFor,
  lonLatToPlane,
  makeHexLattice,
  meanLatitude,
  planeFromAxial,
  planeToLonLat,
  resolveRadiusMeters,
  resolveWeightProperty,
  tileSetToken,
} from '../src/lib/hexbin.js';

// ── fixtures ────────────────────────────────────────────────────────────────

function pointTile(
  positions: number[],
  startTimes: number[],
  endTimes: number[],
  {
    timeOffset = 0,
    numericProps = {},
    x = 0,
  }: {
    timeOffset?: number;
    numericProps?: Record<string, Float32Array>;
    x?: number;
  } = {},
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
    id: { z: 5, x, y: 0, t: timeOffset },
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

function lineTile(
  positions: number[],
  startIndices: number[],
  startTimes: number[],
  endTimes: number[],
  numericProps: Record<string, Float32Array> = {},
): Tile {
  const featureCount = startTimes.length;
  const features: BinaryFeatures = {
    featureCount,
    geometryType: GeometryType.LineString,
    positionDimensions: 2,
    positions: new Float64Array(positions),
    startIndices: new Uint32Array(startIndices),
    featureIds: new Uint32Array(featureCount),
    startTimes: new Float32Array(startTimes),
    endTimes: new Float32Array(endTimes),
    timeOffset: 0,
    numericProps,
    categoricalProps: {},
    vectorProps: {},
  };
  return {
    id: { z: 5, x: 0, y: 0, t: 0 },
    timeRange: { start: 0, end: 1000 },
    layers: [
      {
        name: 'paths',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.linestring',
      },
    ],
  };
}

function polygonTile(): Tile {
  const features: BinaryFeatures = {
    featureCount: 1,
    geometryType: GeometryType.Polygon,
    positionDimensions: 2,
    positions: new Float64Array([0, 0, 0.01, 0, 0.01, 0.01, 0, 0.01]),
    startIndices: new Uint32Array([0, 4]),
    featureIds: new Uint32Array(1),
    startTimes: new Float32Array([0]),
    endTimes: new Float32Array([100]),
    timeOffset: 0,
    numericProps: {},
    categoricalProps: {},
    vectorProps: {},
  };
  return {
    id: { z: 5, x: 0, y: 0, t: 0 },
    timeRange: { start: 0, end: 1000 },
    layers: [
      {
        name: 'areas',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.polygon',
      },
    ],
  };
}

/** Metres between two ECEF triples. */
function ecefDistance(p: Float64Array, i: number, j: number): number {
  const dx = p[i * 3] - p[j * 3];
  const dy = p[i * 3 + 1] - p[j * 3 + 1];
  const dz = p[i * 3 + 2] - p[j * 3 + 2];
  return Math.hypot(dx, dy, dz);
}

// ── the lattice ─────────────────────────────────────────────────────────────

describe('hex lattice', () => {
  it('makes longitude and latitude scales equal at the equator', () => {
    const l = makeHexLattice(1000, 0);
    expect(l.mPerDegLon).toBeCloseTo(l.mPerDegLat, 6);
  });

  it('shrinks the longitude scale by cos(latRef)', () => {
    const l = makeHexLattice(1000, 60);
    expect(l.mPerDegLon / l.mPerDegLat).toBeCloseTo(
      Math.cos((60 * Math.PI) / 180),
      9,
    );
  });

  it('clamps the reference latitude away from the poles', () => {
    // cos(90°) is 0: the plane collapses and every point on Earth lands in one
    // bin. The clamp is what keeps the lattice a lattice.
    const l = makeHexLattice(1000, 90);
    expect(l.latitudeReference).toBe(85);
    expect(l.mPerDegLon).toBeGreaterThan(0);
  });

  it('falls back to sane defaults for a non-finite radius or latitude', () => {
    expect(makeHexLattice(Number.NaN, 0).radiusMeters).toBe(1000);
    expect(makeHexLattice(-5, 0).radiusMeters).toBe(1000);
    expect(makeHexLattice(1000, Number.NaN).latitudeReference).toBe(0);
  });

  it('round-trips lon/lat through the metre plane', () => {
    const l = makeHexLattice(1000, 40);
    const [x, y] = lonLatToPlane(l, -73.9, 40.75);
    const [lon, lat] = planeToLonLat(l, x, y);
    expect(lon).toBeCloseTo(-73.9, 10);
    expect(lat).toBeCloseTo(40.75, 10);
  });
});

describe('axialRound', () => {
  it('keeps the cube invariant q + r + s === 0 exactly', () => {
    for (let i = 0; i < 200; i++) {
      const qf = ((i * 7919) % 97) / 13 - 3.5;
      const rf = ((i * 6151) % 89) / 11 - 4.5;
      const [q, r] = axialRound(qf, rf);
      expect(Number.isInteger(q)).toBe(true);
      expect(Number.isInteger(r)).toBe(true);
      // s is derived, so the invariant holds by construction — the point of the
      // test is that the TIE-BREAK never leaves a non-integer behind.
      expect(Number.isInteger(-q - r)).toBe(true);
    }
  });

  it('is the identity on exact lattice coordinates', () => {
    expect(axialRound(3, -5)).toEqual([3, -5]);
    expect(axialRound(0, 0)).toEqual([0, 0]);
  });
});

describe('axial ↔ plane', () => {
  const lattice = makeHexLattice(1000, 0);

  it('round-trips every axial coordinate through its centre', () => {
    for (let q = -4; q <= 4; q++) {
      for (let r = -4; r <= 4; r++) {
        const [x, y] = planeFromAxial(lattice, q, r);
        expect(axialFromPlane(lattice, x, y)).toEqual([q, r]);
      }
    }
  });

  it('bins a point near a centre into that centre, and a far one elsewhere', () => {
    const [cx, cy] = planeFromAxial(lattice, 2, -1);
    // Well inside the inradius (sqrt(3)/2 × R ≈ 866 m).
    expect(axialFromPlane(lattice, cx + 200, cy - 150)).toEqual([2, -1]);
    // Two full rows away — cannot be the same hex.
    expect(axialFromPlane(lattice, cx, cy + 3000)).not.toEqual([2, -1]);
  });

  it('tiles the plane with no gaps: every sampled point lands in some hex', () => {
    const seen = new Set<string>();
    for (let x = -5000; x <= 5000; x += 137) {
      for (let y = -5000; y <= 5000; y += 149) {
        const [q, r] = axialFromPlane(lattice, x, y);
        const [cx, cy] = planeFromAxial(lattice, q, r);
        // Every point must lie within the CIRCUMradius of the hex it was
        // assigned to — the defining property of a correct rounding.
        expect(Math.hypot(x - cx, y - cy)).toBeLessThanOrEqual(1000 + 1e-6);
        seen.add(`${q}:${r}`);
      }
    }
    expect(seen.size).toBeGreaterThan(20);
  });
});

describe('hexRingLonLat', () => {
  it('returns six corners at the circumradius from the centre', () => {
    const lattice = makeHexLattice(1000, 0);
    const ring = hexRingLonLat(lattice, 0, 0);
    expect(ring.length).toBe(12);
    for (let i = 0; i < 6; i++) {
      const [x, y] = lonLatToPlane(lattice, ring[i * 2], ring[i * 2 + 1]);
      expect(Math.hypot(x, y)).toBeCloseTo(1000, 6);
    }
  });

  it('produces a ring whose adjacent corners are one radius apart', () => {
    // A regular hexagon's SIDE equals its circumradius; that is the geometric
    // identity that makes a hex lattice tile.
    const lattice = makeHexLattice(2500, 0);
    const ring = hexRingLonLat(lattice, 3, -2);
    for (let i = 0; i < 6; i++) {
      const a = lonLatToPlane(lattice, ring[i * 2], ring[i * 2 + 1]);
      const j = (i + 1) % 6;
      const b = lonLatToPlane(lattice, ring[j * 2], ring[j * 2 + 1]);
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeCloseTo(2500, 5);
    }
  });
});

// ── time ────────────────────────────────────────────────────────────────────

describe('hexbinWindowFor', () => {
  it('centres a window on the playhead and widens it by the fades', () => {
    expect(hexbinWindowFor('window', 1000, { windowHalf: 200 })).toEqual({
      start: 800,
      end: 1200,
    });
    expect(
      hexbinWindowFor('window', 1000, {
        windowHalf: 200,
        fadeIn: 50,
        fadeOut: 75,
      }),
    ).toEqual({ start: 750, end: 1275 });
  });

  it('trails behind the playhead for wake and trail', () => {
    expect(hexbinWindowFor('wake', 1000, { wakeLength: 300 })).toEqual({
      start: 700,
      end: 1000,
    });
    expect(hexbinWindowFor('trail', 1000, { trailLength: 400 })).toEqual({
      start: 600,
      end: 1000,
    });
  });

  it('reaches back forever for cumulative and everywhere for none', () => {
    expect(hexbinWindowFor('cumulative', 1000, {})).toEqual({
      start: -Infinity,
      end: 1000,
    });
    expect(hexbinWindowFor('none', 1000, {})).toEqual({
      start: -Infinity,
      end: Infinity,
    });
  });

  it('degrades to "everything" when the mode has no usable span', () => {
    expect(hexbinWindowFor('window', 1000, {})).toEqual({
      start: -Infinity,
      end: Infinity,
    });
    expect(hexbinWindowFor('window', 1000, {}, 600)).toEqual({
      start: 700,
      end: 1300,
    });
  });
});

describe('aggregationBucket', () => {
  it('quantises the playhead and only changes at a step boundary', () => {
    expect(aggregationBucket(0, 100)).toBe(0);
    expect(aggregationBucket(99, 100)).toBe(0);
    expect(aggregationBucket(100, 100)).toBe(1);
    expect(aggregationBucket(-1, 100)).toBe(-1);
  });

  it('freezes at bucket 0 for a non-finite or non-positive step', () => {
    expect(aggregationBucket(12345, Infinity)).toBe(0);
    expect(aggregationBucket(12345, 0)).toBe(0);
    expect(aggregationBucket(Number.NaN, 100)).toBe(0);
  });
});

describe('the cache key', () => {
  it('is order-independent across the resident tile set', () => {
    const a = pointTile([0, 0], [0], [10], { x: 1 });
    const b = pointTile([0.1, 0.1], [0], [10], { x: 2 });
    expect(tileSetToken([a, b])).toBe(tileSetToken([b, a]));
  });

  it('changes when the population changes', () => {
    const one = pointTile([0, 0], [0], [10]);
    const two = pointTile([0, 0, 0.1, 0.1], [0, 0], [10, 10]);
    expect(tileSetToken([one])).not.toBe(tileSetToken([two]));
  });

  it('changes when what a bin MEANS changes', () => {
    const base = configToken({ radiusMeters: 1000 });
    expect(configToken({ radiusMeters: 2000 })).not.toBe(base);
    expect(configToken({ radiusMeters: 1000, colorWeight: 'mag' })).not.toBe(
      base,
    );
    expect(configToken({ radiusMeters: 1000, aggregation: 'mean' })).not.toBe(
      base,
    );
    expect(configToken({ radiusMeters: 1000, coverage: 0.8 })).not.toBe(base);
  });

  it('composes tiles, config and bucket into one key', () => {
    expect(hexbinCacheKey('T', 'C', 3)).toBe('T#C#3');
    expect(hexbinCacheKey('T', 'C', 3)).not.toBe(hexbinCacheKey('T', 'C', 4));
  });
});

// ── weight resolution ───────────────────────────────────────────────────────

describe('weight resolution', () => {
  it('prefers colorWeight, then elevationWeight, then the legacy name', () => {
    expect(
      resolveWeightProperty({
        colorWeight: 'a',
        elevationWeight: 'b',
        weightProperty: 'c',
      }),
    ).toBe('a');
    expect(
      resolveWeightProperty({ elevationWeight: 'b', weightProperty: 'c' }),
    ).toBe('b');
    expect(resolveWeightProperty({ weightProperty: 'c' })).toBe('c');
    expect(resolveWeightProperty({})).toBeNull();
  });

  it('lets radiusMeters win over deck’s cellSize spelling', () => {
    expect(resolveRadiusMeters({ radiusMeters: 500, cellSize: 900 })).toBe(500);
    expect(resolveRadiusMeters({ cellSize: 900 })).toBe(900);
    expect(resolveRadiusMeters({})).toBe(1000);
    expect(resolveRadiusMeters({ radiusMeters: 0 })).toBe(1000);
  });
});

// ── the geometry-kind guard ─────────────────────────────────────────────────

describe('geometry-kind guard', () => {
  it('bins ONE entry per FEATURE for a point tile', () => {
    // Three points inside one 5 km hex.
    const tile = pointTile(
      [0, 0, 0.002, 0.001, -0.001, 0.002],
      [0, 0, 0],
      [9, 9, 9],
    );
    const build = buildHexbins([tile], { radiusMeters: 5000 });
    expect(build.bins.length).toBe(1);
    expect(build.bins[0].count).toBe(3);
    expect(build.diagnostics.pointEntries).toBe(3);
    expect(build.diagnostics.vertexEntries).toBe(0);
  });

  it('bins ONE entry per VERTEX for a LineString tile', () => {
    // Two tracks, 3 and 2 vertices, all inside one 50 km hex. Per-FEATURE
    // binning would report 2 — the head of each track — and call it density.
    const tile = lineTile(
      [0, 0, 0.01, 0.01, 0.02, 0.02, 0.03, 0.01, 0.02, 0],
      [0, 3],
      [0, 0],
      [9, 9],
    );
    const build = buildHexbins([tile], { radiusMeters: 50_000 });
    expect(build.bins.length).toBe(1);
    expect(build.bins[0].count).toBe(5);
    expect(build.diagnostics.vertexEntries).toBe(5);
    expect(build.diagnostics.pointEntries).toBe(0);
  });

  it('spreads a long track across the hexes it actually crosses', () => {
    // Vertices 0.2° apart at the equator ≈ 22 km, so a 5 km lattice must not
    // collapse them into one bin.
    const tile = lineTile([0, 0, 0.2, 0, 0.4, 0, 0.6, 0], [0], [0], [9]);
    const build = buildHexbins([tile], { radiusMeters: 5000 });
    expect(build.bins.length).toBe(4);
    for (const bin of build.bins) expect(bin.count).toBe(1);
  });

  it('SKIPS polygon layers and says so, rather than binning ring vertices', () => {
    const build = buildHexbins([polygonTile()], { radiusMeters: 5000 });
    expect(build.bins).toEqual([]);
    expect(build.diagnostics.skippedPolygonLayers).toBe(1);
    expect(collectHexbinLayers([polygonTile()]).layers).toEqual([]);
  });

  it('still bins the point layers of a mixed tile set', () => {
    const build = buildHexbins([polygonTile(), pointTile([0, 0], [0], [9])], {
      radiusMeters: 5000,
    });
    expect(build.bins.length).toBe(1);
    expect(build.diagnostics.skippedPolygonLayers).toBe(1);
  });
});

// ── aggregation ─────────────────────────────────────────────────────────────

describe('aggregation', () => {
  const weighted = () =>
    pointTile([0, 0, 0.002, 0.001, -0.001, 0.002], [0, 0, 0], [9, 9, 9], {
      numericProps: { mag: new Float32Array([2, 4, 12]) },
    });

  it('counts when no weight column is configured', () => {
    const build = buildHexbins([weighted()], { radiusMeters: 5000 });
    expect(build.bins[0].weight).toBe(3);
    expect(build.bins[0].count).toBe(3);
  });

  it('sums the weight column by default', () => {
    const build = buildHexbins([weighted()], {
      radiusMeters: 5000,
      colorWeight: 'mag',
    });
    expect(build.bins[0].weight).toBe(18);
  });

  it('honours mean, max, min and count', () => {
    const opts = { radiusMeters: 5000, colorWeight: 'mag' as const };
    expect(
      buildHexbins([weighted()], { ...opts, aggregation: 'mean' }).bins[0]
        .weight,
    ).toBe(6);
    expect(
      buildHexbins([weighted()], { ...opts, aggregation: 'max' }).bins[0]
        .weight,
    ).toBe(12);
    expect(
      buildHexbins([weighted()], { ...opts, aggregation: 'min' }).bins[0]
        .weight,
    ).toBe(2);
    expect(
      buildHexbins([weighted()], { ...opts, aggregation: 'count' }).bins[0]
        .weight,
    ).toBe(3);
  });

  it('reports a missing weight column instead of silently counting', () => {
    const build = buildHexbins([weighted()], {
      radiusMeters: 5000,
      colorWeight: 'nope',
    });
    expect(build.diagnostics.weightPropertyMissing).toBe(true);
    expect(build.bins[0].weight).toBe(3); // fell back to a COUNT hexbin
  });

  it('drives BOTH colour and elevation from the one weight', () => {
    const build = buildHexbins([weighted()], {
      radiusMeters: 5000,
      colorWeight: 'mag',
      elevationScale: 10,
    });
    expect(build.bins[0].height).toBe(180); // 18 × 10
  });
});

// ── colour ──────────────────────────────────────────────────────────────────

describe('colour', () => {
  const spread = () =>
    // Two hexes 22 km apart with 1 and 3 members: a real domain to fit.
    pointTile(
      [0, 0, 0.2, 0, 0.201, 0.001, 0.199, -0.001],
      [0, 0, 0, 0],
      [9, 9, 9, 9],
    );

  it('fits the domain from the aggregates and paints the ramp ends', () => {
    const build = buildHexbins([spread()], { radiusMeters: 5000 });
    expect(build.domain).toEqual([1, 3]);
    const low = build.bins.find((b) => b.count === 1)!;
    const high = build.bins.find((b) => b.count === 3)!;
    expect([low.r255, low.g255, low.b255]).toEqual([
      DEFAULT_HEXBIN_RAMP[0][0],
      DEFAULT_HEXBIN_RAMP[0][1],
      DEFAULT_HEXBIN_RAMP[0][2],
    ]);
    const lastStop = DEFAULT_HEXBIN_RAMP[DEFAULT_HEXBIN_RAMP.length - 1];
    expect([high.r255, high.g255, high.b255]).toEqual([
      lastStop[0],
      lastStop[1],
      lastStop[2],
    ]);
  });

  it('WIDENS a seeded domain and never narrows it', () => {
    const build = buildHexbins([spread()], {
      radiusMeters: 5000,
      domainSeed: [0, 100],
    });
    expect(build.domain).toEqual([0, 100]);
  });

  it('widens a degenerate fit UPWARD rather than dividing by zero', () => {
    // One bin → min === max. Widening upward puts the single value at the
    // BOTTOM of the span, which paints the ramp's low stop — the honest
    // reading of "there is no variation to show".
    const build = buildHexbins([pointTile([0, 0], [0], [9])], {
      radiusMeters: 5000,
    });
    expect(build.domain).toEqual([1, 1]);
    expect([
      build.bins[0].r255,
      build.bins[0].g255,
      build.bins[0].b255,
    ]).toEqual([
      DEFAULT_HEXBIN_RAMP[0][0],
      DEFAULT_HEXBIN_RAMP[0][1],
      DEFAULT_HEXBIN_RAMP[0][2],
    ]);
  });

  it('emits ramp channels as integral bytes, ready for the u8 batch table', () => {
    const build = buildHexbins([spread()], {
      radiusMeters: 5000,
      colorDomain: [0, 7],
    });
    for (const bin of build.bins) {
      for (const ch of [bin.r255, bin.g255, bin.b255]) {
        expect(Number.isInteger(ch)).toBe(true);
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThanOrEqual(255);
      }
    }
  });

  it('honours a pinned colorDomain over the fit', () => {
    const pinned = buildHexbins([spread()], {
      radiusMeters: 5000,
      colorDomain: [0, 1000],
    });
    // Everything sits at the very bottom of a huge pinned domain.
    for (const bin of pinned.bins) {
      expect(bin.r255).toBe(DEFAULT_HEXBIN_RAMP[0][0]);
    }
  });

  it('normalizes the ramp alpha to 0..1 so setTime never re-divides', () => {
    const build = buildHexbins([spread()], { radiusMeters: 5000 });
    expect(build.bins[0].a).toBeCloseTo(1, 6);
  });
});

// ── time filtering / re-aggregation ─────────────────────────────────────────

describe('re-aggregation over a moving window', () => {
  // Four points in ONE hex, one per 1000 ms — the aggregate has to move.
  const tile = () =>
    pointTile(
      [0, 0, 0.001, 0, 0, 0.001, 0.001, 0.001],
      [0, 1000, 2000, 3000],
      [10, 1010, 2010, 3010],
    );

  it('counts only the members inside the window', () => {
    const early = buildHexbins([tile()], {
      radiusMeters: 5000,
      window: { start: -500, end: 500 },
    });
    expect(early.bins[0].count).toBe(1);

    const late = buildHexbins([tile()], {
      radiusMeters: 5000,
      window: { start: 1500, end: 3500 },
    });
    expect(late.bins[0].count).toBe(2);
  });

  it('genuinely re-counts as the window moves — not a cross-fade', () => {
    const at0 = buildHexbins([tile()], {
      radiusMeters: 5000,
      window: hexbinWindowFor('window', 0, { windowHalf: 600 }),
    });
    const at3000 = buildHexbins([tile()], {
      radiusMeters: 5000,
      window: hexbinWindowFor('window', 3000, { windowHalf: 600 }),
    });
    expect(at0.bins[0].count).toBe(1);
    expect(at3000.bins[0].count).toBe(1);
    // Same hex, same lattice — but a different underlying member, so the
    // reported window moved with it.
    expect(at0.bins[0].q).toBe(at3000.bins[0].q);
    expect(at0.bins[0].start).not.toBe(at3000.bins[0].start);
  });

  it('accumulates under a cumulative window', () => {
    const build = buildHexbins([tile()], {
      radiusMeters: 5000,
      window: hexbinWindowFor('cumulative', 2500, {}),
    });
    expect(build.bins[0].count).toBe(3);
  });

  it('reports an empty aggregate when the window misses everything', () => {
    const build = buildHexbins([tile()], {
      radiusMeters: 5000,
      window: { start: 900_000, end: 901_000 },
    });
    expect(build.bins).toEqual([]);
    expect(build.diagnostics.skippedOutOfWindow).toBe(4);
  });

  it('carries the union of member windows, rebased to the time origin', () => {
    const offset = 1_700_000_000_000;
    const t = pointTile([0, 0, 0.001, 0], [0, 500], [100, 600], {
      timeOffset: offset,
    });
    const build = buildHexbins([t], { radiusMeters: 5000 });
    expect(build.timeOrigin).toBe(offset);
    expect(build.bins[0].start).toBe(0);
    expect(build.bins[0].end).toBe(600);
  });
});

// ── ECEF output ─────────────────────────────────────────────────────────────

describe('ECEF rings', () => {
  it('projects onto the WGS84 ellipsoid, in absolute metres (no RTC)', () => {
    const build = buildHexbins([pointTile([0, 0], [0], [9])], {
      radiusMeters: 5000,
    });
    const p = build.bins[0].positions;
    expect(p.length).toBe(18); // six corners × xyz
    for (let i = 0; i < 6; i++) {
      const mag = Math.hypot(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      // WGS84 semi-minor 6 356 752 m … semi-major 6 378 137 m. A sphere datum
      // would land on 6 371 008 m at the equator — ~7 km short, the bug the
      // explicit `{datum:'wgs84'}` exists to prevent.
      expect(mag).toBeGreaterThan(6_356_000);
      expect(mag).toBeLessThan(6_378_200);
    }
    // Near the equator/prime meridian, x dominates.
    expect(p[0]).toBeGreaterThan(6_000_000);
  });

  it('keeps the hex edge length at the requested radius on the ellipsoid', () => {
    const build = buildHexbins([pointTile([0, 0], [0], [9])], {
      radiusMeters: 5000,
    });
    const p = build.bins[0].positions;
    for (let i = 0; i < 6; i++) {
      // Chord ≈ arc for 5 km on a 6371 km sphere; 1% tolerance covers the
      // ellipsoid's own departure from the plane approximation.
      expect(ecefDistance(p, i, (i + 1) % 6)).toBeGreaterThan(4900);
      expect(ecefDistance(p, i, (i + 1) % 6)).toBeLessThan(5100);
    }
  });

  it('shrinks the ring toward the centre under coverage', () => {
    const full = buildHexbins([pointTile([0, 0], [0], [9])], {
      radiusMeters: 5000,
    }).bins[0].positions;
    const half = buildHexbins([pointTile([0, 0], [0], [9])], {
      radiusMeters: 5000,
      coverage: 0.5,
    }).bins[0].positions;
    expect(ecefDistance(half, 0, 1)).toBeCloseTo(
      ecefDistance(full, 0, 1) / 2,
      -1,
    );
  });
});

// ── build-level behaviour ───────────────────────────────────────────────────

describe('buildHexbins', () => {
  it('returns an empty build with timeOrigin 0 for no tiles', () => {
    const build = buildHexbins([]);
    expect(build.bins).toEqual([]);
    expect(build.timeOrigin).toBe(0);
  });

  it('drops non-finite coordinates and reports them', () => {
    const build = buildHexbins(
      [pointTile([0, 0, Number.NaN, 0, 0.001, 0.001], [0, 0, 0], [9, 9, 9])],
      { radiusMeters: 5000 },
    );
    expect(build.bins[0].count).toBe(2);
    expect(build.diagnostics.skippedNonFinite).toBe(1);
  });

  it('pins the lattice before binning, so the window filter cannot move it', () => {
    const t = pointTile(
      [10, 50, 10.001, 50, 10, 20],
      [0, 0, 5000],
      [9, 9, 5009],
    );
    const all = buildHexbins([t], { radiusMeters: 5000 });
    const windowed = buildHexbins([t], {
      radiusMeters: 5000,
      latitudeReference: all.lattice.latitudeReference,
      window: { start: -100, end: 100 },
    });
    expect(windowed.lattice.latitudeReference).toBe(
      all.lattice.latitudeReference,
    );
    const before = all.bins.find((b) => b.count === 2)!;
    const after = windowed.bins.find((b) => b.count === 2)!;
    expect([after.q, after.r]).toEqual([before.q, before.r]);
  });

  it('emits bins in a deterministic axial order regardless of tile order', () => {
    const a = pointTile([0, 0], [0], [9], { x: 1 });
    const b = pointTile([0.5, 0.5], [0], [9], { x: 2 });
    const forward = buildHexbins([a, b], { radiusMeters: 5000 });
    const reverse = buildHexbins([b, a], { radiusMeters: 5000 });
    expect(forward.bins.map((x) => `${x.q}:${x.r}`)).toEqual(
      reverse.bins.map((x) => `${x.q}:${x.r}`),
    );
  });

  it('normalizes the pick longitude back into [-180, 180)', () => {
    const build = buildHexbins([pointTile([179.99, 0], [0], [9])], {
      radiusMeters: 5000,
    });
    expect(build.bins[0].lon).toBeGreaterThanOrEqual(-180);
    expect(build.bins[0].lon).toBeLessThan(180);
  });

  it('carries picking provenance for a representative member', () => {
    const t = pointTile([0, 0, 0.001, 0], [0, 0], [9, 9]);
    const build = buildHexbins([t], { radiusMeters: 5000 });
    expect(build.bins[0].binary).toBe(t.layers[0].features);
    expect(build.bins[0].featureIndex).toBe(0);
  });
});

describe('meanLatitude', () => {
  it('averages the first coordinate of every feature, to a whole degree', () => {
    const t = pointTile([0, 10, 0, 20, 0, 31], [0, 0, 0], [9, 9, 9]);
    expect(meanLatitude([t.layers[0].features])).toBe(20);
  });

  it('uses each track’s FIRST vertex, not every vertex', () => {
    const t = lineTile([0, 40, 0, 41, 0, 42, 0, 10], [0, 3], [0, 0], [9, 9]);
    expect(meanLatitude([t.layers[0].features])).toBe(25); // (40 + 10) / 2
  });

  it('returns 0 for no usable latitude', () => {
    expect(meanLatitude([])).toBe(0);
  });
});

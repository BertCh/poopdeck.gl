// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * `lib/columns.ts` — the PURE, Cesium-free prism builder behind `STTColumnLayer`.
 *
 * Everything here runs in plain Node with no GPU and no `Scene`, which is the
 * whole point of the purity rule: the column kind's real content is arithmetic
 * (height resolution, metric radius, the space-time-cube lift), and arithmetic
 * should not need a canvas to be believed.
 *
 * The load-bearing case is `time-as-height is GEODETIC`: it pins the lift to the
 * local ellipsoid normal at four latitudes and proves it is NOT a Z add, which
 * is the failure that looks perfect at the equator and lies down at 65° N.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import type { RGBA255 } from '@poopdeck.gl/core/style';
import {
  buildColumnEntries,
  columnAxisOffsetMeters,
  prismSlices,
  timeHeightLiftMeters,
} from '../src/lib/columns';

// The same globe the builder constructs — an independent instance, so this is a
// real cross-check of the datum and not a shared-object tautology.
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

const DEG2RAD = Math.PI / 180;

/** The WGS84 ellipsoid normal (unit "local up") at a geodetic lon/lat. */
function geodeticUp(lon: number, lat: number): [number, number, number] {
  const la = lat * DEG2RAD;
  const lo = lon * DEG2RAD;
  return [
    Math.cos(la) * Math.cos(lo),
    Math.cos(la) * Math.sin(lo),
    Math.sin(la),
  ];
}

function pointFeatures(
  positions: number[],
  startTimes: number[],
  endTimes: number[],
  partial: Partial<BinaryFeatures> = {},
  timeOffset = 0,
): BinaryFeatures {
  const featureCount = startTimes.length;
  return {
    featureCount,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions: new Float64Array(positions),
    featureIds: new Uint32Array(featureCount),
    startTimes: new Float32Array(startTimes),
    endTimes: new Float32Array(endTimes),
    timeOffset,
    numericProps: {},
    categoricalProps: {},
    vectorProps: {},
    ...partial,
  };
}

function pointTile(
  positions: number[],
  startTimes: number[],
  endTimes: number[],
  partial: Partial<BinaryFeatures> = {},
  timeOffset = 0,
): Tile {
  const features = pointFeatures(
    positions,
    startTimes,
    endTimes,
    partial,
    timeOffset,
  );
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

describe('buildColumnEntries — shape and defaults', () => {
  it('returns an empty build with origin 0 when there is no Point layer', () => {
    expect(buildColumnEntries([])).toEqual({ columns: [], timeOrigin: 0 });
  });

  it('emits one prism per Point feature at deck-matching defaults', () => {
    const build = buildColumnEntries([
      pointTile([10, 45, 11, 46], [0, 100], [50, 200]),
    ]);
    expect(build.columns).toHaveLength(2);
    expect(build.timeOrigin).toBe(0);
    for (const c of build.columns) {
      expect(c.height).toBe(1000); // defaultElevation
      expect(c.radius).toBe(100);
      expect(c.lift).toBe(0); // flat map until timeHeightScale is set
      expect(c.color).toEqual([255, 140, 0, 255]); // deck ColumnLayer fill
    }
    expect(build.columns[0].lon).toBe(10);
    expect(build.columns[0].lat).toBe(45);
    expect(build.columns[1].featureIndex).toBe(1);
  });

  it('carries picking provenance: the source BinaryFeatures plus the index', () => {
    const tile = pointTile([10, 45, 11, 46], [0, 100], [50, 200]);
    const src = tile.layers[0].features;
    const build = buildColumnEntries([tile]);
    expect(build.columns.map((c) => c.featureIndex)).toEqual([0, 1]);
    expect(build.columns.every((c) => c.binary === src)).toBe(true);
  });

  it('places the foot at the projected lon/lat, at ground altitude by default', () => {
    const [c] = buildColumnEntries([pointTile([10, 45], [0], [50])]).columns;
    const [x, y, z] = GLOBE.project(10, 45, 0);
    expect(c.x).toBeCloseTo(x, 9);
    expect(c.y).toBeCloseTo(y, 9);
    expect(c.z).toBeCloseTo(z, 9);
  });
});

describe('buildColumnEntries — height resolution', () => {
  it('drives height from elevationProperty, scaled by elevationScale', () => {
    const tile = pointTile([10, 45, 11, 46], [0, 0], [1, 1], {
      numericProps: { mag: new Float32Array([2, 7]) },
    });
    const build = buildColumnEntries([tile], {
      elevationProperty: 'mag',
      elevationScale: 500,
    });
    expect(build.columns.map((c) => c.height)).toEqual([1000, 3500]);
  });

  it('falls back to defaultElevation when the named column is absent', () => {
    const build = buildColumnEntries([pointTile([10, 45], [0], [1])], {
      elevationProperty: 'missing',
      defaultElevation: 250,
    });
    expect(build.columns[0].height).toBe(250);
  });

  it('scales the constant fallback too, so the two paths stay comparable', () => {
    const build = buildColumnEntries([pointTile([10, 45], [0], [1])], {
      defaultElevation: 250,
      elevationScale: 4,
    });
    expect(build.columns[0].height).toBe(1000);
  });

  it("SKIPS a feature whose height is not > 0 (deck's shouldRender)", () => {
    const tile = pointTile(
      [10, 45, 11, 46, 12, 47, 13, 48],
      [0, 0, 0, 0],
      [1, 1, 1, 1],
      {
        numericProps: { mag: new Float32Array([5, -3, 0, NaN]) },
      },
    );
    const build = buildColumnEntries([tile], { elevationProperty: 'mag' });
    // Only the positive one survives — a negative elevation must not punch a
    // prism through the ground, and NaN/0 are degenerate for CylinderGeometry.
    expect(build.columns).toHaveLength(1);
    expect(build.columns[0].featureIndex).toBe(0);
    expect(build.columns[0].height).toBe(5);
  });
});

describe('buildColumnEntries — metric radius', () => {
  it('multiplies radius by coverage', () => {
    const build = buildColumnEntries([pointTile([10, 45], [0], [1])], {
      radius: 800,
      coverage: 0.25,
    });
    expect(build.columns[0].radius).toBe(200);
  });

  it('emits nothing for a non-positive radius but KEEPS the time origin', () => {
    const build = buildColumnEntries(
      [pointTile([10, 45], [0], [1], {}, 7_000)],
      { radius: 0 },
    );
    expect(build.columns).toEqual([]);
    // Origin still reported: the layer's empty-bail is what protects the
    // previous frame, and it keys off `columns.length`, not off the origin.
    expect(build.timeOrigin).toBe(7_000);
  });
});

describe('buildColumnEntries — base altitude', () => {
  it('reads the tile geometry z on 3-D tiles', () => {
    const tile = pointTile([10, 45, 900], [0], [1], {
      positionDimensions: 3,
      positions: new Float64Array([10, 45, 900]),
    });
    const [c] = buildColumnEntries([tile]).columns;
    expect(c.x).toBeCloseTo(GLOBE.project(10, 45, 900)[0], 9);
    expect(c.z).toBeCloseTo(GLOBE.project(10, 45, 900)[2], 9);
  });

  it('prefers baseElevationProperty over the geometry z, and adds zLift', () => {
    const tile = pointTile([10, 45, 900], [0], [1], {
      positionDimensions: 3,
      positions: new Float64Array([10, 45, 900]),
      numericProps: { deck: new Float32Array([120]) },
    });
    const [c] = buildColumnEntries([tile], {
      baseElevationProperty: 'deck',
      zLift: 30,
    }).columns;
    const [x, y, z] = GLOBE.project(10, 45, 150);
    expect(c.x).toBeCloseTo(x, 9);
    expect(c.y).toBeCloseTo(y, 9);
    expect(c.z).toBeCloseTo(z, 9);
  });
});

describe('buildColumnEntries — time rebase', () => {
  it('rebases every tile onto the FIRST Point layer time offset', () => {
    const build = buildColumnEntries([
      pointTile([10, 45], [100], [200], {}, 5_000),
      pointTile([11, 46], [0], [50], {}, 6_000),
    ]);
    expect(build.timeOrigin).toBe(5_000);
    expect(build.columns.map((c) => [c.start, c.end])).toEqual([
      [100, 200], // rebase 0
      [1000, 1050], // rebase +1000
    ]);
  });
});

describe('buildColumnEntries — colour', () => {
  it('honours a constant colour', () => {
    const color: RGBA255 = [1, 2, 3, 4];
    const build = buildColumnEntries([pointTile([10, 45], [0], [1])], {
      color: { type: 'constant', color },
    });
    expect(build.columns[0].color).toEqual([1, 2, 3, 4]);
  });

  it('honours a categorical colour, with the fallback for unmapped labels', () => {
    const tile = pointTile([10, 45, 11, 46], [0, 0], [1, 1], {
      categoricalProps: {
        kind: {
          categories: ['a', 'b'],
          indices: new Int32Array([0, 1]),
        },
      } as unknown as BinaryFeatures['categoricalProps'],
    });
    const build = buildColumnEntries([tile], {
      color: {
        type: 'categorical',
        property: 'kind',
        colorMapping: { a: [10, 20, 30, 255] },
        fallback: [9, 9, 9, 255],
      },
    });
    expect(build.columns[0].color).toEqual([10, 20, 30, 255]);
    expect(build.columns[1].color).toEqual([9, 9, 9, 255]);
  });

  it('honours a ramp colour over a numeric column', () => {
    const tile = pointTile([10, 45, 11, 46], [0, 0], [1, 1], {
      numericProps: { v: new Float32Array([0, 10]) },
    });
    const build = buildColumnEntries([tile], {
      color: {
        type: 'ramp',
        property: 'v',
        domain: [0, 10],
        range: [
          [0, 0, 0, 255],
          [255, 255, 255, 255],
        ],
        fallback: [1, 1, 1, 255],
      },
    });
    expect(build.columns[0].color).toEqual([0, 0, 0, 255]);
    expect(build.columns[1].color).toEqual([255, 255, 255, 255]);
  });
});

describe('timeHeightLiftMeters', () => {
  it('is a plain affine map from relative start time to metres', () => {
    expect(timeHeightLiftMeters(1000, 0, 0.5)).toBe(500);
    expect(timeHeightLiftMeters(1000, 1000, 0.5)).toBe(0);
    expect(timeHeightLiftMeters(0, 1000, 0.5)).toBe(-500); // below the anchor
    expect(timeHeightLiftMeters(1234, 0, 0)).toBe(0);
  });
});

describe('buildColumnEntries — time as height (the space-time cube)', () => {
  it('reports lift = (start - origin) x scale, anchored at the build origin', () => {
    const build = buildColumnEntries(
      [pointTile([10, 45, 11, 46], [0, 400], [1, 401], {}, 9_000)],
      { timeHeightScale: 2 },
    );
    // timeHeightOrigin defaults to null → altitude 0 sits at the build origin.
    expect(build.columns.map((c) => c.lift)).toEqual([0, 800]);
  });

  it('relativizes an ABSOLUTE timeHeightOrigin against the build origin', () => {
    const build = buildColumnEntries(
      [pointTile([10, 45], [400], [401], {}, 9_000)],
      { timeHeightScale: 2, timeHeightOrigin: 9_200 },
    );
    // start is 400 relative; the origin is 200 relative → (400-200)*2.
    expect(build.columns[0].lift).toBe(400);
  });

  it('honours a LITERAL 0 origin as the Unix epoch (documented deck deviation)', () => {
    // deck reinterprets 0 as "unset" because its shader differences f32 times.
    // This backend differences f64 on the CPU, so 0 IS the epoch and is obeyed.
    const build = buildColumnEntries(
      [pointTile([10, 45], [0], [1], {}, 1_700_000_000_000)],
      { timeHeightScale: 1e-6, timeHeightOrigin: 0 },
    );
    expect(build.columns[0].lift).toBeCloseTo(1_700_000, 3);
  });

  it('is a no-op at scale 0 — the flat map is the same build', () => {
    const tiles = [pointTile([10, 45], [400], [401], {}, 9_000)];
    const flat = buildColumnEntries(tiles, { timeHeightScale: 0 });
    const alsoFlat = buildColumnEntries(tiles);
    expect(flat.columns[0].lift).toBe(0);
    expect(flat.columns[0].x).toBe(alsoFlat.columns[0].x);
    expect(flat.columns[0].z).toBe(alsoFlat.columns[0].z);
  });

  it('LIFTS ALONG THE LOCAL ELLIPSOID NORMAL, not along ECEF +Z', () => {
    // The regression this exists for: adding the lift to the Cartesian z looks
    // perfect at the equator and tilts every column by the co-latitude
    // elsewhere. Pin the displacement to the geodetic up vector at each site.
    const sites: Array<[number, number]> = [
      [0, 0], // equator — where a Z add would ALSO pass
      [10, 45],
      [-21.9, 64.1], // Reykjavik: a Z add points the prism out to sea
      [151.2, -33.9], // southern hemisphere
    ];
    for (const [lon, lat] of sites) {
      const scale = 3; // m per ms
      const start = 500;
      const build = buildColumnEntries(
        [pointTile([lon, lat], [start], [start + 1])],
        { timeHeightScale: scale },
      );
      const c = build.columns[0];
      expect(c.lift).toBe(1500);

      const ground = GLOBE.project(lon, lat, 0);
      const d = [c.x - ground[0], c.y - ground[1], c.z - ground[2]];
      const up = geodeticUp(lon, lat);
      // The displacement is exactly `lift` metres along the local normal…
      expect(d[0]).toBeCloseTo(up[0] * 1500, 6);
      expect(d[1]).toBeCloseTo(up[1] * 1500, 6);
      expect(d[2]).toBeCloseTo(up[2] * 1500, 6);
      // …and its LENGTH is the lift, which a Z add only achieves at a pole.
      expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1500, 6);
    }
  });

  it('a Z add would be measurably WRONG at latitude — negative control', () => {
    const [lon, lat] = [-21.9, 64.1];
    const build = buildColumnEntries([pointTile([lon, lat], [1000], [1001])], {
      timeHeightScale: 1,
    });
    const c = build.columns[0];
    const ground = GLOBE.project(lon, lat, 0);
    // What the naive implementation would have produced.
    const naiveZ = ground[2] + 1000;
    // The real geodetic foot differs from it by hundreds of metres, and its
    // horizontal components moved (a Z add leaves x and y untouched).
    expect(Math.abs(c.z - naiveZ)).toBeGreaterThan(100);
    expect(Math.abs(c.x - ground[0])).toBeGreaterThan(100);
  });

  it('composes with zLift and the base column rather than replacing them', () => {
    const tile = pointTile([10, 45], [400], [401], {
      numericProps: { deck: new Float32Array([100]) },
    });
    const [c] = buildColumnEntries([tile], {
      baseElevationProperty: 'deck',
      zLift: 25,
      timeHeightScale: 0.5,
    }).columns;
    expect(c.lift).toBe(200);
    const [x, y, z] = GLOBE.project(10, 45, 100 + 25 + 200);
    expect(c.x).toBeCloseTo(x, 9);
    expect(c.y).toBeCloseTo(y, 9);
    expect(c.z).toBeCloseTo(z, 9);
  });
});

describe('columnAxisOffsetMeters', () => {
  it('is half the height — the foot-to-centre raise a centred cylinder needs', () => {
    expect(columnAxisOffsetMeters(1000)).toBe(500);
    expect(columnAxisOffsetMeters(1)).toBe(0.5);
    expect(columnAxisOffsetMeters(0)).toBe(0);
  });
});

describe('prismSlices', () => {
  it("defaults to deck's diskResolution of 20", () => {
    expect(prismSlices()).toBe(20);
    expect(prismSlices(undefined)).toBe(20);
  });

  it('floors a fractional resolution (a slider bound to a number input)', () => {
    expect(prismSlices(6.9)).toBe(6);
  });

  it('CLAMPS to 3 rather than letting Cesium throw DeveloperError', () => {
    expect(prismSlices(2)).toBe(3);
    expect(prismSlices(0)).toBe(3);
    expect(prismSlices(-8)).toBe(3);
    expect(prismSlices(NaN)).toBe(3);
    expect(prismSlices(Infinity)).toBe(3);
  });
});

describe('purity', () => {
  it('imports NOTHING from cesium — the builder must run in plain Node', () => {
    const src = readFileSync(
      new URL('../src/lib/columns.ts', import.meta.url),
      'utf8',
    );
    expect(src).not.toMatch(/from\s+['"]cesium/);
    expect(src).not.toMatch(/from\s+['"]@cesium\//);
  });

  it('constructs its globe on the wgs84 datum, never the sphere default', () => {
    const src = readFileSync(
      new URL('../src/lib/columns.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/datum:\s*'wgs84'/);
  });
});

// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * `lib/polygons.ts` — the PURE (Cesium-free) polygon builder behind
 * `STTPolygonLayer`. Plain Node, no stub scene needed: the module imports only
 * `@poopdeck.gl/core` sub-paths, which is the property that makes this file
 * possible and is itself asserted at the bottom.
 *
 * The weight is on the three nested index arrays — `startIndices` (feature) ⊇
 * `partIndices` (MultiPolygon member) ⊇ `ringIndices` (exterior, then holes) —
 * because every way of collapsing them is a rendering bug that looks plausible:
 * welded archipelagos, holes stitched to their exteriors, or a cursor that
 * desynchronises after the first feature.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import {
  buildPolygonEntries,
  polygonTimeOrigin,
  type FeaturePolygon,
} from '../src/lib/polygons';

const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

function polygonTile(
  positions: number[],
  startIndices: number[],
  startTimes: number[],
  endTimes: number[],
  partial: Partial<BinaryFeatures> = {},
  timeOffset = 0,
): Tile {
  const featureCount = startTimes.length;
  const features: BinaryFeatures = {
    featureCount,
    geometryType: GeometryType.Polygon,
    positionDimensions: 2,
    positions: new Float64Array(positions),
    startIndices: new Uint32Array(startIndices),
    featureIds: new Uint32Array(featureCount),
    startTimes: new Float32Array(startTimes),
    endTimes: new Float32Array(endTimes),
    timeOffset,
    numericProps: {},
    categoricalProps: {},
    vectorProps: {},
    ...partial,
  };
  return {
    id: { z: 5, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: 'polygons',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.polygon',
      },
    ],
  };
}

/** A CLOSED ring (last vertex repeats the first), as the wire format writes it. */
function closedRing(
  lon: number,
  lat: number,
  size: number,
): [number[], number] {
  const ring = [
    lon,
    lat,
    lon + size,
    lat,
    lon + size,
    lat + size,
    lon,
    lat + size,
    lon,
    lat, // the repeat
  ];
  return [ring, 5];
}

const [SQUARE] = closedRing(10, 45, 2);
const [HOLE] = closedRing(10.5, 45.5, 1);
const [FAR] = closedRing(-70, -30, 2);

/** One simple polygon, no holes, no parts, no finer index arrays. */
const SIMPLE = [polygonTile(SQUARE, [0, 5], [0], [500])];

function len(ring: Float64Array): number {
  return ring.length / 3;
}

function radius(ring: Float64Array, v = 0): number {
  return Math.hypot(ring[v * 3], ring[v * 3 + 1], ring[v * 3 + 2]);
}

describe('buildPolygonEntries — feature/part/ring structure', () => {
  it('builds one entry per feature and OPENS the closed ring', () => {
    const build = buildPolygonEntries(SIMPLE);
    expect(build.polygons).toHaveLength(1);
    const p = build.polygons[0];
    expect(p.parts).toHaveLength(1);
    expect(p.parts[0].holes).toHaveLength(0);
    // 5 wire vertices, 4 distinct — the repeat is a degenerate edge to Cesium.
    expect(len(p.parts[0].outer)).toBe(4);
    // ...and the survivor is the 4th corner, not a second copy of the 1st.
    const [x, y, z] = GLOBE.project(10, 47, 0);
    expect(p.parts[0].outer[9]).toBeCloseTo(x, 3);
    expect(p.parts[0].outer[10]).toBeCloseTo(y, 3);
    expect(p.parts[0].outer[11]).toBeCloseTo(z, 3);
  });

  it('keeps an ALREADY-OPEN ring intact', () => {
    const open = SQUARE.slice(0, 8); // drop the repeat
    const build = buildPolygonEntries([polygonTile(open, [0, 4], [0], [500])]);
    expect(len(build.polygons[0].parts[0].outer)).toBe(4);
  });

  it('splits interior rings out as HOLES on the same part', () => {
    const build = buildPolygonEntries([
      polygonTile([...SQUARE, ...HOLE], [0, 10], [0], [500], {
        ringIndices: new Uint32Array([0, 5, 10]),
        partIndices: new Uint32Array([0, 10]),
      }),
    ]);
    expect(build.polygons).toHaveLength(1);
    const p = build.polygons[0];
    expect(p.parts).toHaveLength(1);
    expect(p.parts[0].holes).toHaveLength(1);
    expect(len(p.parts[0].holes[0])).toBe(4);
    // The hole is the SECOND ring, not the first: exterior order is preserved.
    const [ox] = GLOBE.project(10, 45, 0);
    const [hx] = GLOBE.project(10.5, 45.5, 0);
    expect(p.parts[0].outer[0]).toBeCloseTo(ox, 3);
    expect(p.parts[0].holes[0][0]).toBeCloseTo(hx, 3);
  });

  it('splits a MultiPolygon into one part per member', () => {
    const build = buildPolygonEntries([
      polygonTile([...SQUARE, ...FAR], [0, 10], [0], [500], {
        ringIndices: new Uint32Array([0, 5, 10]),
        partIndices: new Uint32Array([0, 5, 10]),
      }),
    ]);
    // ONE feature (one colour, one time window) with TWO disjoint exteriors —
    // never one exterior stitched across the Atlantic.
    expect(build.polygons).toHaveLength(1);
    const p = build.polygons[0];
    expect(p.parts).toHaveLength(2);
    expect(p.parts[0].holes).toHaveLength(0);
    expect(p.parts[1].holes).toHaveLength(0);
    const [fx, fy] = GLOBE.project(-70, -30, 0);
    expect(p.parts[1].outer[0]).toBeCloseTo(fx, 3);
    expect(p.parts[1].outer[1]).toBeCloseTo(fy, 3);
  });

  it('reads the SAME ring array correctly for the second and later features', () => {
    // The boundary walk carries a moving cursor across features; a cursor that
    // fails to advance would hand feature 1 feature 0's rings.
    const build = buildPolygonEntries([
      polygonTile([...SQUARE, ...FAR], [0, 5, 10], [0, 100], [500, 600], {
        ringIndices: new Uint32Array([0, 5, 10]),
        partIndices: new Uint32Array([0, 5, 10]),
      }),
    ]);
    expect(build.polygons).toHaveLength(2);
    expect(build.polygons[0].lon).toBe(10);
    expect(build.polygons[1].lon).toBe(-70);
    expect(build.polygons[1].lat).toBe(-30);
    const [fx] = GLOBE.project(-70, -30, 0);
    expect(build.polygons[1].parts[0].outer[0]).toBeCloseTo(fx, 3);
  });

  it('degrades to one part / one ring when the finer arrays are absent', () => {
    // Tiles written before ringIndices/partIndices existed carry only
    // startIndices; "one part, one ring" is the correct reading of those.
    const build = buildPolygonEntries(SIMPLE);
    expect(build.polygons[0].parts).toHaveLength(1);
    expect(build.polygons[0].parts[0].holes).toHaveLength(0);
  });

  it('drops a feature whose rings cannot bound an area', () => {
    const build = buildPolygonEntries([
      polygonTile([10, 45, 11, 45], [0, 2], [0], [500]),
    ]);
    expect(build.polygons).toHaveLength(0);
  });

  it('drops a ring that is degenerate only AFTER the closing vertex is removed', () => {
    // 3 wire vertices, but the last repeats the first → 2 distinct → no area.
    const build = buildPolygonEntries([
      polygonTile([10, 45, 11, 45, 10, 45], [0, 3], [0], [500]),
    ]);
    expect(build.polygons).toHaveLength(0);
  });

  it('ignores non-polygon layers and tiles with no startIndices', () => {
    const noIdx = polygonTile(SQUARE, [0, 5], [0], [500]);
    delete noIdx.layers[0].features.startIndices;
    expect(buildPolygonEntries([noIdx]).polygons).toHaveLength(0);

    const lines = polygonTile(SQUARE, [0, 5], [0], [500], {
      geometryType: GeometryType.LineString,
    });
    expect(buildPolygonEntries([lines]).polygons).toHaveLength(0);
  });

  it('returns an empty build (and origin 0) for no tiles', () => {
    expect(buildPolygonEntries([])).toEqual({ polygons: [], timeOrigin: 0 });
  });
});

describe('buildPolygonEntries — positions', () => {
  it('projects to ABSOLUTE WGS84 ECEF metres (not a sphere, no RTC)', () => {
    const ring = buildPolygonEntries(SIMPLE).polygons[0].parts[0].outer;
    // WGS84 geocentric radius at 45°N ≈ 6367.5 km; a 'sphere' datum would put
    // every vertex on 6371.0 km, which is ~3.5 km wrong here.
    expect(radius(ring)).toBeGreaterThan(6_360_000);
    expect(radius(ring)).toBeLessThan(6_372_000);
    const [x, y, z] = GLOBE.project(10, 45, 0);
    expect(ring[0]).toBeCloseTo(x, 6);
    expect(ring[1]).toBeCloseTo(y, 6);
    expect(ring[2]).toBeCloseTo(z, 6);
  });

  it('applies zLift to every vertex AND to baseHeight', () => {
    const flat = buildPolygonEntries(SIMPLE).polygons[0];
    const lifted = buildPolygonEntries(SIMPLE, { zLift: 1000 }).polygons[0];
    expect(lifted.baseHeight).toBe(1000);
    expect(lifted.topHeight).toBe(1000); // still flat: no extrusion asked for
    // The lift is a GEODETIC height (along the ellipsoid normal), not a radial
    // one — the two differ by ~6 mm per km at 45°, which is exactly why the
    // altitude goes through GlobeProjection rather than scaling the ECEF vector.
    const corners = [10, 45, 12, 45, 12, 47, 10, 47];
    for (let v = 0; v < 4; v++) {
      const [x, y, z] = GLOBE.project(corners[v * 2], corners[v * 2 + 1], 1000);
      expect(lifted.parts[0].outer[v * 3]).toBeCloseTo(x, 6);
      expect(lifted.parts[0].outer[v * 3 + 1]).toBeCloseTo(y, 6);
      expect(lifted.parts[0].outer[v * 3 + 2]).toBeCloseTo(z, 6);
    }
    expect(
      radius(lifted.parts[0].outer) - radius(flat.parts[0].outer),
    ).toBeCloseTo(1000, 1);
  });

  it('uses per-vertex altitude from a 3-D tile', () => {
    const build = buildPolygonEntries([
      polygonTile(
        [10, 45, 500, 11, 45, 500, 11, 46, 900, 10, 45, 500],
        [0, 4],
        [0],
        [500],
        { positionDimensions: 3 },
      ),
    ]);
    const p = build.polygons[0];
    expect(p.baseHeight).toBe(500); // first vertex
    expect(len(p.parts[0].outer)).toBe(3); // closed → opened
    // The third vertex carries ITS OWN 900 m, not the feature's 500.
    const [x, y, z] = GLOBE.project(11, 46, 900);
    expect(p.parts[0].outer[6]).toBeCloseTo(x, 6);
    expect(p.parts[0].outer[7]).toBeCloseTo(y, 6);
    expect(p.parts[0].outer[8]).toBeCloseTo(z, 6);
    // ...which puts it 400 m further out than the same lon/lat at 500 m.
    const at500 = GLOBE.project(11, 46, 500);
    expect(radius(p.parts[0].outer, 2) - Math.hypot(...at500)).toBeCloseTo(
      400,
      1,
    );
  });
});

describe('buildPolygonEntries — time rebasing', () => {
  it('rebases every layer onto the FIRST polygon layer timeOffset', () => {
    const a = polygonTile(SQUARE, [0, 5], [10], [200], {}, 1000);
    const b = polygonTile(FAR, [0, 5], [10], [200], {}, 1600);
    const build = buildPolygonEntries([a, b]);
    expect(build.timeOrigin).toBe(1000);
    expect(build.polygons[0].start).toBe(10);
    expect(build.polygons[0].end).toBe(200);
    // Layer b sits 600 ms later on the absolute clock, so its window shifts.
    expect(build.polygons[1].start).toBe(610);
    expect(build.polygons[1].end).toBe(800);
  });

  it('polygonTimeOrigin agrees with the build, and is 0 with no polygon layers', () => {
    const tiles = [polygonTile(SQUARE, [0, 5], [0], [500], {}, 7000)];
    expect(polygonTimeOrigin(tiles)).toBe(7000);
    expect(polygonTimeOrigin(tiles)).toBe(
      buildPolygonEntries(tiles).timeOrigin,
    );
    expect(polygonTimeOrigin([])).toBe(0);
  });
});

describe('buildPolygonEntries — colour', () => {
  it('defaults to one constant translucent colour per feature', () => {
    const c = buildPolygonEntries(SIMPLE).polygons[0].color;
    expect(c).toHaveLength(4);
    expect(c[3]).toBeLessThan(255); // translucent by default — polygons overlap
  });

  it('honours a constant FeatureColorMode', () => {
    const build = buildPolygonEntries(SIMPLE, {
      color: { type: 'constant', color: [1, 2, 3, 4] },
    });
    expect(build.polygons[0].color).toEqual([1, 2, 3, 4]);
  });

  it('honours a ramp over a numeric column, and falls back when it is absent', () => {
    const opts = {
      color: {
        type: 'ramp' as const,
        property: 'v',
        domain: [0, 10] as const,
        range: [
          [0, 0, 0, 255],
          [255, 255, 255, 255],
        ] as const,
        fallback: [9, 9, 9, 9] as const,
      },
    };
    const withCol = buildPolygonEntries(
      [
        polygonTile([...SQUARE, ...FAR], [0, 5, 10], [0, 0], [500, 500], {
          numericProps: { v: new Float32Array([0, 10]) },
        }),
      ],
      opts,
    );
    expect(withCol.polygons[0].color[0]).toBeLessThan(
      withCol.polygons[1].color[0],
    );
    expect(buildPolygonEntries(SIMPLE, opts).polygons[0].color).toEqual([
      9, 9, 9, 9,
    ]);
  });
});

describe('buildPolygonEntries — extrusion', () => {
  const two = (heights?: number[]): Tile[] => [
    polygonTile(
      [...SQUARE, ...FAR],
      [0, 5, 10],
      [0, 0],
      [500, 500],
      heights ? { numericProps: { h: new Float32Array(heights) } } : {},
    ),
  ];

  function span(p: FeaturePolygon): number {
    return p.topHeight - p.baseHeight;
  }

  it('is flat by default — top === base', () => {
    const p = buildPolygonEntries(SIMPLE).polygons[0];
    expect(p.topHeight).toBe(p.baseHeight);
    expect(span(p)).toBe(0);
  });

  it('extrudes by a constant', () => {
    expect(
      span(buildPolygonEntries(SIMPLE, { extrudedHeight: 2500 }).polygons[0]),
    ).toBe(2500);
  });

  it('extrudes per feature from a numeric column', () => {
    const build = buildPolygonEntries(two([300, 900]), {
      extrudedHeightProperty: 'h',
    });
    expect(span(build.polygons[0])).toBe(300);
    expect(span(build.polygons[1])).toBe(900);
  });

  it('applies heightScale to whichever height resolved', () => {
    expect(
      span(
        buildPolygonEntries(two([300]), {
          extrudedHeightProperty: 'h',
          heightScale: 3,
        }).polygons[0],
      ),
    ).toBe(900);
    expect(
      span(
        buildPolygonEntries(SIMPLE, { extrudedHeight: 100, heightScale: 2.5 })
          .polygons[0],
      ),
    ).toBe(250);
  });

  it('falls back to the constant when the column is missing', () => {
    const build = buildPolygonEntries(SIMPLE, {
      extrudedHeightProperty: 'nope',
      extrudedHeight: 400,
    });
    expect(span(build.polygons[0])).toBe(400);
  });

  it('clamps a negative or non-finite height to FLAT', () => {
    // Cesium reads a roof below its floor as a swap, which would sink the
    // polygon through the globe rather than dig a pit.
    const neg = buildPolygonEntries(two([-500, Number.NaN]), {
      extrudedHeightProperty: 'h',
    });
    expect(span(neg.polygons[0])).toBe(0);
    expect(span(neg.polygons[1])).toBe(0);
    expect(
      span(buildPolygonEntries(SIMPLE, { extrudedHeight: -1 }).polygons[0]),
    ).toBe(0);
  });

  it('stacks the extrusion ON TOP of zLift, not from the ellipsoid', () => {
    const p = buildPolygonEntries(SIMPLE, {
      zLift: 50,
      extrudedHeight: 200,
    }).polygons[0];
    expect(p.baseHeight).toBe(50);
    expect(p.topHeight).toBe(250);
  });
});

describe('lib/polygons.ts purity', () => {
  it('imports NO cesium — that is what makes this whole file runnable', () => {
    const src = readFileSync(
      new URL('../src/lib/polygons.ts', import.meta.url),
      'utf8',
    );
    expect(src).not.toMatch(/from ['"]cesium['"]/);
    expect(src).not.toMatch(/from ['"]@cesium\//);
  });
});

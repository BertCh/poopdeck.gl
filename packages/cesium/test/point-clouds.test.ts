// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * The pure builder behind `STTPointCloudLayer` — no Cesium anywhere in this
 * file, which is the point: `lib/point-clouds.ts` imports only
 * `@poopdeck.gl/core`, so every decision it makes (elevation, the four-way
 * colour resolution, the normal contract, the baked Lambert term, the time
 * rebase) is testable in plain Node without a GPU.
 *
 * What these tests are really pinning is the set of choices a future edit could
 * silently invert: which altitude source wins, which colour path outranks which,
 * what an unusable normal column falls back to, and — the one that would be
 * invisible on screen until someone looked hard — that the shade multiplies RGB
 * and never A.
 */

import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import { buildPointCloudEntries, lambertShade } from '../src/lib/point-clouds';

// Same globe the builder uses — WGS84, not the class default sphere.
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

const AMBIENT = 0.35;
const DIFFUSE = 0.65;

function cloudFeatures(
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

function cloudTile(
  positions: number[],
  startTimes: number[],
  endTimes: number[],
  partial: Partial<BinaryFeatures> = {},
  timeOffset = 0,
): Tile {
  const features = cloudFeatures(
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
        name: 'cloud',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
}

/** A `FixedSizeList<Float32,3>` normal column for `n` features. */
function normalColumn(values: number[]): {
  value: Float32Array;
  size: number;
} {
  return { value: new Float32Array(values), size: 3 };
}

describe('lambertShade', () => {
  it('is ambient + diffuse for a normal facing the light, i.e. exactly 1 by default', () => {
    // The two defaults sum to 1 on purpose: a fully-lit point IS its source
    // colour, so a cloud without normals renders identically to `point`.
    expect(lambertShade([0, 0, 1], [0, 0, 1])).toBe(1);
    expect(AMBIENT + DIFFUSE).toBe(1);
  });

  it('normalizes both vectors, so column magnitude never leaks into the shade', () => {
    expect(lambertShade([0, 0, 0.5], [0, 0, 9])).toBeCloseTo(1, 12);
    expect(lambertShade([0, 0, 17], [0, 0, 0.001])).toBeCloseTo(1, 12);
  });

  it('clamps a back-facing normal to the ambient floor rather than going negative', () => {
    expect(lambertShade([0, 0, -1], [0, 0, 1])).toBeCloseTo(AMBIENT, 12);
    expect(lambertShade([1, 0, 0], [0, 0, 1])).toBeCloseTo(AMBIENT, 12); // perpendicular
  });

  it('ramps with the cosine between the two directions', () => {
    const s = lambertShade([1, 0, 1], [0, 0, 1]);
    expect(s).toBeCloseTo(AMBIENT + DIFFUSE * Math.SQRT1_2, 12);
    expect(s).toBeGreaterThan(AMBIENT);
    expect(s).toBeLessThan(1);
  });

  it('falls back to ambient for a zero-length normal or light instead of emitting NaN', () => {
    // Cesium would render a NaN channel as an undefined colour, not as an
    // error — so a degenerate direction must resolve, not propagate.
    expect(lambertShade([0, 0, 0], [0, 0, 1])).toBeCloseTo(AMBIENT, 12);
    expect(lambertShade([0, 0, 1], [0, 0, 0])).toBeCloseTo(AMBIENT, 12);
    expect(Number.isNaN(lambertShade([0, 0, 0], [0, 0, 0]))).toBe(false);
  });

  it('honours custom ambient/diffuse and clamps their sum into 0..1', () => {
    expect(lambertShade([0, 0, 1], [0, 0, 1], 0.2, 0.5)).toBeCloseTo(0.7, 12);
    expect(lambertShade([1, 0, 0], [0, 0, 1], 0.2, 0.5)).toBeCloseTo(0.2, 12);
    expect(lambertShade([0, 0, 1], [0, 0, 1], 0.8, 0.8)).toBe(1); // 1.6 → clamped
    expect(lambertShade([0, 0, -1], [0, 0, 1], -1, 0.5)).toBe(0); // −1 → clamped
  });
});

describe('buildPointCloudEntries — geometry and elevation', () => {
  it('returns the all-empty shape when no tile carries Point features', () => {
    const line = cloudTile([0, 0, 1, 1], [0], [1], {
      geometryType: GeometryType.LineString,
    });
    const build = buildPointCloudEntries([line]);
    expect(build.points).toEqual([]);
    expect(build.timeOrigin).toBe(0);
    expect(build.hasNormals).toBe(false);
  });

  it('projects to absolute WGS84 ECEF and carries lon/lat + provenance', () => {
    const tile = cloudTile([10, 20, 30, 40], [5, 6], [900, 901]);
    const build = buildPointCloudEntries([tile]);
    expect(build.points).toHaveLength(2);

    const [p0, p1] = build.points;
    const e0 = GLOBE.project(10, 20, 0);
    expect(p0.x).toBeCloseTo(e0[0], 6);
    expect(p0.y).toBeCloseTo(e0[1], 6);
    expect(p0.z).toBeCloseTo(e0[2], 6);
    expect(p0.lon).toBe(10);
    expect(p0.lat).toBe(20);
    expect(p0.start).toBe(5);
    expect(p0.end).toBe(900);
    expect(p0.binary).toBe(tile.layers[0].features);
    expect(p0.featureIndex).toBe(0);
    expect(p1.featureIndex).toBe(1);
    expect(p1.x).toBeCloseTo(GLOBE.project(30, 40, 0)[0], 6);
  });

  it('lifts each point by the tile geometry z when the tile is 3-D', () => {
    // This is the whole difference from `point`: on a globe the altitude is
    // just the third argument to `project`, so elevation is free.
    const tile = cloudTile([0, 0, 500], [0], [1], {
      positionDimensions: 3,
      positions: new Float64Array([0, 0, 500]),
    });
    const p = buildPointCloudEntries([tile]).points[0];
    expect(p.x).toBeCloseTo(GLOBE.project(0, 0, 500)[0], 6);
    // At (0,0) the +X axis carries the altitude verbatim.
    expect(p.x).toBeCloseTo(GLOBE.project(0, 0, 0)[0] + 500, 6);
  });

  it('lets a named elevationProperty × elevationScale WIN over the geometry z', () => {
    const tile = cloudTile([0, 0, 111], [0], [1], {
      positionDimensions: 3,
      positions: new Float64Array([0, 0, 111]),
      numericProps: { agl: new Float32Array([20]) },
    });
    const p = buildPointCloudEntries([tile], {
      elevationProperty: 'agl',
      elevationScale: 25,
    }).points[0];
    expect(p.x).toBeCloseTo(GLOBE.project(0, 0, 500)[0], 6); // 20 × 25, not 111
  });

  it('defaults elevationScale to 1 and ignores an absent elevation column', () => {
    const tile = cloudTile([0, 0], [0], [1], {
      numericProps: { agl: new Float32Array([300]) },
    });
    const scaled = buildPointCloudEntries([tile], {
      elevationProperty: 'agl',
    }).points[0];
    expect(scaled.x).toBeCloseTo(GLOBE.project(0, 0, 300)[0], 6);
    const missing = buildPointCloudEntries([tile], {
      elevationProperty: 'nope',
    }).points[0];
    expect(missing.x).toBeCloseTo(GLOBE.project(0, 0, 0)[0], 6);
  });

  it('rebases every later layer onto the FIRST Point layer timeOffset', () => {
    const t0 = cloudTile([0, 0], [0], [100], {}, 5000);
    const t1 = cloudTile([1, 1], [0], [100], {}, 8000);
    const build = buildPointCloudEntries([t0, t1]);
    expect(build.timeOrigin).toBe(5000);
    expect(build.points[0].start).toBe(0);
    expect(build.points[1].start).toBe(3000);
    expect(build.points[1].end).toBe(3100);
  });
});

describe('buildPointCloudEntries — normals and the baked Lambert term', () => {
  it('shades a normal-less cloud at full brightness and reports hasNormals false', () => {
    const build = buildPointCloudEntries([cloudTile([0, 0], [0], [1])]);
    expect(build.hasNormals).toBe(false);
    const p = build.points[0];
    expect(p.shade).toBe(1);
    expect(p.r).toBeCloseTo(200 / 255, 12); // the default grey, undimmed
  });

  it('reads a FixedSizeList<Float32,3> normal column and varies the shade per point', () => {
    const tile = cloudTile([0, 0, 1, 1, 2, 2], [0, 0, 0], [1, 1, 1], {
      vectorProps: {
        // up (lit), east (perpendicular), down (back-facing)
        normal: normalColumn([0, 0, 1, 1, 0, 0, 0, 0, -1]),
      },
    });
    const build = buildPointCloudEntries([tile]);
    expect(build.hasNormals).toBe(true);
    const shades = build.points.map((p) => p.shade);
    expect(shades[0]).toBeCloseTo(1, 12);
    expect(shades[1]).toBeCloseTo(AMBIENT, 12);
    expect(shades[2]).toBeCloseTo(AMBIENT, 12);
  });

  it('multiplies the shade into RGB and leaves ALPHA untouched', () => {
    // Lighting darkens a surface; it does not dissolve it. The A channel
    // belongs to the per-frame time filter alone.
    const tile = cloudTile([0, 0], [0], [1], {
      vectorProps: { normal: normalColumn([1, 0, 0]) }, // perpendicular → ambient
    });
    const p = buildPointCloudEntries([tile], {
      color: { type: 'constant', color: [255, 255, 255, 128] },
    }).points[0];
    expect(p.shade).toBeCloseTo(AMBIENT, 12);
    expect(p.r).toBeCloseTo(AMBIENT, 12);
    expect(p.g).toBeCloseTo(AMBIENT, 12);
    expect(p.b).toBeCloseTo(AMBIENT, 12);
    expect(p.a).toBeCloseTo(128 / 255, 12);
  });

  it('ignores a u8 normal leaf rather than rescaling it', () => {
    // No rescale convention makes a u8 normal valid, so the column is treated
    // as absent and the point falls back to deck's default up-normal.
    const tile = cloudTile([0, 0], [0], [1], {
      vectorProps: { normal: { value: new Uint8Array([0, 0, 255]), size: 3 } },
    });
    const build = buildPointCloudEntries([tile]);
    expect(build.hasNormals).toBe(false);
    expect(build.points[0].shade).toBe(1);
  });

  it('ignores a normal column that is too short for the tile, and one of the wrong width', () => {
    const short = cloudTile([0, 0, 1, 1], [0, 0], [1, 1], {
      vectorProps: { normal: normalColumn([1, 0, 0]) }, // 1 of 2 features
    });
    expect(buildPointCloudEntries([short]).hasNormals).toBe(false);
    expect(buildPointCloudEntries([short]).points[0].shade).toBe(1);

    const wide = cloudTile([0, 0], [0], [1], {
      vectorProps: {
        normal: { value: new Float32Array([1, 0, 0, 0]), size: 4 },
      },
    });
    expect(buildPointCloudEntries([wide]).hasNormals).toBe(false);
  });

  it('distinguishes an unset normalColumn (default name) from an explicit null (disabled)', () => {
    const tile = cloudTile([0, 0], [0], [1], {
      vectorProps: { normal: normalColumn([1, 0, 0]) },
    });
    expect(buildPointCloudEntries([tile]).points[0].shade).toBeCloseTo(
      AMBIENT,
      12,
    );
    expect(
      buildPointCloudEntries([tile], { normalColumn: null }).points[0].shade,
    ).toBe(1);
    expect(
      buildPointCloudEntries([tile], { normalColumn: null }).hasNormals,
    ).toBe(false);
  });

  it('honours a custom normal column name', () => {
    const tile = cloudTile([0, 0], [0], [1], {
      vectorProps: { surface_n: normalColumn([1, 0, 0]) },
    });
    expect(buildPointCloudEntries([tile]).points[0].shade).toBe(1); // wrong name → absent
    expect(
      buildPointCloudEntries([tile], { normalColumn: 'surface_n' }).points[0]
        .shade,
    ).toBeCloseTo(AMBIENT, 12);
  });

  it('reads the light in the ENU frame by default — the same direction everywhere', () => {
    // A [1,0,0] ENU light is "from the east" at BOTH poles of this fixture, so
    // two points half a world apart get the same shade for the same normal.
    const tile = cloudTile([0, 0, 170, 60], [0, 0], [1, 1], {
      vectorProps: { normal: normalColumn([1, 0, 0, 1, 0, 0]) },
    });
    const build = buildPointCloudEntries([tile], {
      lighting: { direction: [1, 0, 0] },
    });
    expect(build.points[0].shade).toBeCloseTo(1, 12);
    expect(build.points[1].shade).toBeCloseTo(1, 12);
  });

  it("rotates ENU normals into ECEF under frame:'ecef', which is a genuinely different light", () => {
    // At (0,0) the local UP is the ECEF +X axis, so an up-normal lit by an
    // ECEF +X sun is fully lit — while the same light read as ENU would be
    // "from the east", i.e. perpendicular to that normal.
    const tile = cloudTile([0, 0], [0], [1], {
      vectorProps: { normal: normalColumn([0, 0, 1]) },
    });
    const ecef = buildPointCloudEntries([tile], {
      lighting: { direction: [1, 0, 0], frame: 'ecef' },
    }).points[0];
    const enu = buildPointCloudEntries([tile], {
      lighting: { direction: [1, 0, 0], frame: 'enu' },
    }).points[0];
    expect(ecef.shade).toBeCloseTo(1, 9);
    expect(enu.shade).toBeCloseTo(AMBIENT, 12);
  });

  it("under frame:'ecef' a fixed sun shades two far-apart points differently", () => {
    // The whole reason the mode exists: an ECEF sun is a real distant light,
    // so the far side of the globe is dark. The ENU headlamp cannot do this.
    const tile = cloudTile([0, 0, 180, 0], [0, 0], [1, 1], {
      vectorProps: { normal: normalColumn([0, 0, 1, 0, 0, 1]) },
    });
    const build = buildPointCloudEntries([tile], {
      lighting: { direction: [1, 0, 0], frame: 'ecef' },
    });
    expect(build.points[0].shade).toBeCloseTo(1, 9); // facing the sun
    expect(build.points[1].shade).toBeCloseTo(AMBIENT, 9); // antipode, in shadow
  });

  it('honours custom ambient/diffuse weights through the build', () => {
    const tile = cloudTile([0, 0, 1, 1], [0, 0], [1, 1], {
      vectorProps: { normal: normalColumn([0, 0, 1, 1, 0, 0]) },
    });
    const build = buildPointCloudEntries([tile], {
      lighting: { ambient: 0.1, diffuse: 0.4 },
      color: { type: 'constant', color: [255, 255, 255, 255] },
    });
    expect(build.points[0].shade).toBeCloseTo(0.5, 12);
    expect(build.points[1].shade).toBeCloseTo(0.1, 12);
    expect(build.points[0].r).toBeCloseTo(0.5, 12);
  });

  it('reports hasNormals as a WHOLE-BUILD verdict — true when any resident tile carries them', () => {
    const withN = cloudTile([0, 0], [0], [1], {
      vectorProps: { normal: normalColumn([1, 0, 0]) },
    });
    const withoutN = cloudTile([1, 1], [0], [1]);
    const build = buildPointCloudEntries([withoutN, withN]);
    expect(build.hasNormals).toBe(true);
    // …and the normal-less tile still shades, at the default up-normal.
    expect(build.points[0].shade).toBe(1);
    expect(build.points[1].shade).toBeCloseTo(AMBIENT, 12);
  });
});

describe('buildPointCloudEntries — the four-way colour resolution', () => {
  const RED_MODE = {
    type: 'constant' as const,
    color: [255, 0, 0, 255] as const,
  };

  it('(4) falls back to a constant — the default opaque grey — with nothing configured', () => {
    const p = buildPointCloudEntries([cloudTile([0, 0], [0], [1])]).points[0];
    expect(p.r).toBeCloseTo(200 / 255, 12);
    expect(p.g).toBeCloseTo(205 / 255, 12);
    expect(p.b).toBeCloseTo(215 / 255, 12);
    expect(p.a).toBe(1);
  });

  it('(3) resolves a categorical column through featureColor', () => {
    const tile = cloudTile([0, 0, 1, 1, 2, 2], [0, 0, 0], [1, 1, 1], {
      categoricalProps: {
        kind: {
          indices: new Uint16Array([0, 1, 0xffff]),
          categories: ['a', 'b'],
        },
      },
    });
    const build = buildPointCloudEntries([tile], {
      color: {
        type: 'categorical',
        property: 'kind',
        colorMapping: { a: [255, 0, 0, 255], b: [0, 255, 0, 255] },
        fallback: [0, 0, 255, 255],
      },
    });
    expect(build.points[0].r).toBe(1);
    expect(build.points[1].g).toBe(1);
    expect(build.points[2].b).toBe(1); // NULL category → fallback
  });

  it('(3) also accepts a numeric RAMP — one more mode than deck offers on this kind', () => {
    const tile = cloudTile([0, 0, 1, 1], [0, 0], [1, 1], {
      numericProps: { intensity: new Float32Array([0, 100]) },
    });
    const build = buildPointCloudEntries([tile], {
      color: {
        type: 'ramp',
        property: 'intensity',
        domain: [0, 100],
        range: [
          [0, 0, 0, 255],
          [255, 255, 255, 255],
        ],
        fallback: [0, 0, 255, 255],
      },
    });
    expect(build.points[0].r).toBe(0);
    expect(build.points[1].r).toBe(1);
  });

  it('(2) prefers three numeric [r,g,b] columns over the colour mode, honouring rgbAlpha', () => {
    const tile = cloudTile([0, 0], [0], [1], {
      numericProps: {
        red: new Float32Array([255]),
        green: new Float32Array([128]),
        blue: new Float32Array([0]),
      },
    });
    const p = buildPointCloudEntries([tile], {
      rgbColorColumns: ['red', 'green', 'blue'],
      rgbAlpha: 64,
      color: RED_MODE,
    }).points[0];
    expect(p.r).toBeCloseTo(1, 6);
    expect(p.g).toBeCloseTo(128 / 255, 6);
    expect(p.b).toBe(0);
    expect(p.a).toBeCloseTo(64 / 255, 6);
  });

  it('(2) falls THROUGH to the colour mode when any of the three columns is missing', () => {
    // Not to the kernel fallback grey: a half-configured RGB triple is a
    // configuration that does not apply to this tile, not a colour.
    const tile = cloudTile([0, 0], [0], [1], {
      numericProps: {
        red: new Float32Array([10]),
        green: new Float32Array([10]),
      },
    });
    const p = buildPointCloudEntries([tile], {
      rgbColorColumns: ['red', 'green', 'blue'],
      color: RED_MODE,
    }).points[0];
    expect(p.r).toBe(1);
    expect(p.g).toBe(0);
    expect(p.b).toBe(0);
  });

  it('(1) lets an interleaved RGBA vector column outrank BOTH of the paths below it', () => {
    const tile = cloudTile([0, 0], [0], [1], {
      numericProps: {
        red: new Float32Array([0]),
        green: new Float32Array([0]),
        blue: new Float32Array([255]),
      },
      vectorProps: {
        point_rgba: { value: new Uint8Array([255, 128, 0, 255]), size: 4 },
      },
    });
    const p = buildPointCloudEntries([tile], {
      rgbColorColumns: ['red', 'green', 'blue'],
      color: RED_MODE,
    }).points[0];
    expect(p.r).toBeCloseTo(1, 6);
    expect(p.g).toBeCloseTo(128 / 255, 6);
    expect(p.b).toBe(0);
    expect(p.a).toBe(1);
  });

  it('(1) reads an f32 leaf on the same 0–255 scale, and honours a custom column name', () => {
    const tile = cloudTile([0, 0], [0], [1], {
      vectorProps: {
        cam_rgba: { value: new Float32Array([255, 0, 51, 255]), size: 4 },
      },
    });
    const p = buildPointCloudEntries([tile], {
      colorVectorColumn: 'cam_rgba',
      color: RED_MODE,
    }).points[0];
    expect(p.r).toBeCloseTo(1, 6);
    expect(p.b).toBeCloseTo(51 / 255, 6);
  });

  it('(1) is disabled by an explicit null colorVectorColumn', () => {
    const tile = cloudTile([0, 0], [0], [1], {
      vectorProps: {
        point_rgba: { value: new Uint8Array([0, 0, 255, 255]), size: 4 },
      },
    });
    const p = buildPointCloudEntries([tile], {
      colorVectorColumn: null,
      color: RED_MODE,
    }).points[0];
    expect(p.r).toBe(1);
    expect(p.b).toBe(0);
  });

  it('resolves colour PER TILE, so a mixed archive uses each tile own best path', () => {
    const camera = cloudTile([0, 0], [0], [1], {
      vectorProps: {
        point_rgba: { value: new Uint8Array([0, 255, 0, 255]), size: 4 },
      },
    });
    const plain = cloudTile([1, 1], [0], [1]);
    const build = buildPointCloudEntries([camera, plain], { color: RED_MODE });
    expect(build.points[0].g).toBe(1); // camera colour
    expect(build.points[1].r).toBe(1); // the constant
  });

  it('shades every colour path identically — a categorical cloud is lit, not flat', () => {
    // The mistake deck avoids by refusing its GPU CategoryColorExtension on a
    // lit kind: colour applied AFTER lighting renders categorical points flat.
    const vp = {
      normal: normalColumn([1, 0, 0]), // perpendicular → ambient
    };
    const cat = cloudTile([0, 0], [0], [1], {
      categoricalProps: {
        kind: { indices: new Uint16Array([0]), categories: ['a'] },
      },
      vectorProps: vp,
    });
    const catP = buildPointCloudEntries([cat], {
      color: {
        type: 'categorical',
        property: 'kind',
        colorMapping: { a: [255, 255, 255, 255] },
        fallback: [0, 0, 0, 255],
      },
    }).points[0];
    const vecP = buildPointCloudEntries(
      [
        cloudTile([0, 0], [0], [1], {
          vectorProps: {
            ...vp,
            point_rgba: {
              value: new Uint8Array([255, 255, 255, 255]),
              size: 4,
            },
          },
        }),
      ],
      {},
    ).points[0];
    expect(catP.r).toBeCloseTo(AMBIENT, 12);
    expect(vecP.r).toBeCloseTo(AMBIENT, 12);
  });
});

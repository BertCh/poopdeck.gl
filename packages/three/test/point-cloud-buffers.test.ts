// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// The merged-buffer contract for the LIT point-cloud kind (`pointCloud`), the
// middle ground between the flat billboards of `point-buffers.test.ts` and the
// oriented gaussians of `surfel-buffers.test.ts`. What is specific to this kind
// and therefore pinned here:
//   • the OPTIONAL normal column — `hasNormals` is a whole-build verdict (it
//     selects the material's node-graph variant), a u8 leaf is refused, a
//     normal-less tile inside a build that HAS normals takes deck's [0,0,1],
//     and `forceNormals` keeps the buffer populated once the layer has PINNED
//     that variant (the resident tiles' normal coverage is not the archive's);
//   • all FOUR colour paths, in deck's precedence order;
// plus the invariants every merged builder shares: projected + RTC-relative
// centres, timeOrigin-rebased times, the empty short-circuit, and silently
// skipping non-Point geometry.

import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures } from '@poopdeck.gl/core';
import { buildPointCloudBuffers } from '../src/lib/point-cloud-buffers';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { MercatorProjection } from '../src/projection/mercator';
import type { RGBA } from '../src/lib/color';
import { makePointTile } from './_support/features';
import { expectEmptyBuffers } from './_support/rtc';

const anchor = { longitude: -71.05, latitude: 42.35 };
const proj = new LocalEnuProjection(anchor);

const cloudTile = (
  count: number,
  positions: number[],
  partial: Partial<BinaryFeatures> = {},
  timeOffset = 0,
  geometryType = GeometryType.Point,
) =>
  makePointTile(count, positions, partial, {
    timeOffset,
    geometryType,
    layerName: 'lidar',
    z: 18,
  });

const CLASS: Record<string, RGBA> = {
  ground: [80, 90, 120, 255],
  building: [255, 158, 0, 255],
};
const CATEGORICAL = {
  type: 'categorical' as const,
  property: 'classification',
  mapping: CLASS,
  fallback: [0, 0, 0, 0] as RGBA,
};
/** The colour-agnostic half of the options, for the geometry/time assertions. */
const GEOM_OPTS = { elevationProperty: 'z', elevationScale: 1 };

describe('buildPointCloudBuffers', () => {
  it('projects centres, expands categorical colour, rebases times', () => {
    const tile = cloudTile(
      2,
      [anchor.longitude, anchor.latitude, anchor.longitude, anchor.latitude],
      {
        categoricalProps: {
          classification: {
            indices: new Uint16Array([0, 1]),
            categories: ['ground', 'building'],
          },
        },
        numericProps: { z: new Float32Array([1, 2]) },
        startTimes: new Float32Array([10, 20]),
        endTimes: new Float32Array([15, 25]),
      },
      3000,
    );
    const buf = buildPointCloudBuffers([tile], proj, 1000, {
      colorMode: CATEGORICAL,
      ...GEOM_OPTS,
    });
    expect(buf.count).toBe(2);
    expect(buf.centers[0]).toBeCloseTo(0, 5);
    // The RTC origin takes the FIRST point's elevation too (origin = that
    // point's full projection), so point 0 sits at the origin and point 1 (z=2)
    // is 1 m above it.
    expect(buf.centers[2]).toBe(0);
    expect(buf.centers[5]).toBe(1);
    expect(buf.colors[0]).toBeCloseTo(80 / 255, 6); // ground
    expect(buf.colors[4]).toBeCloseTo(255 / 255, 6); // building r
    expect(buf.starts[0]).toBe(10 + (3000 - 1000)); // rebased +2000
    expect(buf.ends[1]).toBe(25 + 2000);
    // 3D bounds come from the merged instances, not the unit quad.
    expect(buf.bbox!.min[2]).toBeCloseTo(0, 5);
    expect(buf.bbox!.max[2]).toBeCloseTo(1, 5);
  });
});

// ── NORMALS (the lit kind's own column) ───────────────────────────────────────

describe('buildPointCloudBuffers normals', () => {
  const twoPoints = [
    anchor.longitude,
    anchor.latitude,
    anchor.longitude + 0.001,
    anchor.latitude,
  ];

  it('binds a FixedSizeList<Float32,3> normal column zero-copy-equivalent', () => {
    const tile = cloudTile(2, twoPoints, {
      vectorProps: {
        normal: {
          value: new Float32Array([0, 0, 1, 1, 0, 0]),
          size: 3,
        },
      },
      numericProps: { z: new Float32Array([0, 0]) },
    });
    const buf = buildPointCloudBuffers([tile], proj, 0, {
      colorMode: CATEGORICAL,
      ...GEOM_OPTS,
    });
    expect(buf.hasNormals).toBe(true);
    expect(buf.normals.length).toBe(6);
    expect(Array.from(buf.normals.slice(0, 3))).toEqual([0, 0, 1]);
    expect(Array.from(buf.normals.slice(3, 6))).toEqual([1, 0, 0]);
  });

  it('emits NO normal buffer at all when no tile carries the column', () => {
    const tile = cloudTile(2, twoPoints, {
      numericProps: { z: new Float32Array([0, 0]) },
    });
    const buf = buildPointCloudBuffers([tile], proj, 0, {
      colorMode: CATEGORICAL,
      ...GEOM_OPTS,
    });
    // The material's impostor variant declares no `sttNormal`, so the buffer
    // would be a wasted upload — it must be zero-length, not zero-FILLED.
    expect(buf.hasNormals).toBe(false);
    expect(buf.normals.length).toBe(0);
    expect(buf.count).toBe(2);
  });

  it('gives a normal-less tile deck’s default [0,0,1] inside a build that has normals', () => {
    const withNormals = cloudTile(1, [anchor.longitude, anchor.latitude], {
      vectorProps: { normal: { value: new Float32Array([0, 1, 0]), size: 3 } },
      numericProps: { z: new Float32Array([0]) },
    });
    const without = makePointTile(
      1,
      [anchor.longitude + 0.002, anchor.latitude],
      { numericProps: { z: new Float32Array([0]) } },
      { layerName: 'lidar', z: 18, id: { z: 18, x: 1, y: 0, t: 0 } },
    );
    const buf = buildPointCloudBuffers([withNormals, without], proj, 0, {
      colorMode: CATEGORICAL,
      ...GEOM_OPTS,
    });
    expect(buf.hasNormals).toBe(true);
    expect(buf.count).toBe(2);
    expect(Array.from(buf.normals.slice(0, 3))).toEqual([0, 1, 0]);
    // Straight up in the ENU frame ⇒ uniform lighting, never a dropped point.
    expect(Array.from(buf.normals.slice(3, 6))).toEqual([0, 0, 1]);
  });

  it('ignores a u8 normal leaf (no rescale convention makes it valid)', () => {
    const tile = cloudTile(1, [anchor.longitude, anchor.latitude], {
      vectorProps: { normal: { value: new Uint8Array([0, 0, 255]), size: 3 } },
      numericProps: { z: new Float32Array([0]) },
    });
    const buf = buildPointCloudBuffers([tile], proj, 0, {
      colorMode: CATEGORICAL,
      ...GEOM_OPTS,
    });
    expect(buf.hasNormals).toBe(false);
    expect(buf.normals.length).toBe(0);
  });

  it('forceNormals fills the buffer when NO resident tile carries the column', () => {
    // The layer pins the lit-by-normal variant once it has seen normals (audit
    // E5). That graph DECLARES `sttNormal`, so a later build whose resident
    // tiles happen to carry none must still emit a full, index-aligned buffer:
    // an unbound attribute reads (0,0,0) → N·L = 0 → the whole cloud drops to
    // the ambient floor. Deck's default [0,0,1] is what keeps it lit.
    const tile = cloudTile(2, twoPoints, {
      numericProps: { z: new Float32Array([0, 0]) },
    });
    const loose = buildPointCloudBuffers([tile], proj, 0, {
      colorMode: CATEGORICAL,
      ...GEOM_OPTS,
    });
    expect(loose.hasNormals).toBe(false);
    expect(loose.normals.length).toBe(0);

    const pinned = buildPointCloudBuffers([tile], proj, 0, {
      colorMode: CATEGORICAL,
      forceNormals: true,
      ...GEOM_OPTS,
    });
    expect(pinned.hasNormals).toBe(true);
    expect(pinned.normals.length).toBe(2 * 3);
    expect(Array.from(pinned.normals)).toEqual([0, 0, 1, 0, 0, 1]);
    // Nothing else about the build changes.
    expect(pinned.count).toBe(loose.count);
    expect(Array.from(pinned.centers)).toEqual(Array.from(loose.centers));
  });

  it('forceNormals still prefers a real column where one exists', () => {
    const withCol = cloudTile(1, [anchor.longitude, anchor.latitude], {
      vectorProps: { normal: { value: new Float32Array([0, 1, 0]), size: 3 } },
      numericProps: { z: new Float32Array([0]) },
    });
    const without = makePointTile(
      1,
      [anchor.longitude + 0.002, anchor.latitude],
      { numericProps: { z: new Float32Array([0]) } },
      { layerName: 'lidar', z: 18, id: { z: 18, x: 1, y: 0, t: 0 } },
    );
    const buf = buildPointCloudBuffers([withCol, without], proj, 0, {
      colorMode: CATEGORICAL,
      forceNormals: true,
      ...GEOM_OPTS,
    });
    expect(Array.from(buf.normals.slice(0, 3))).toEqual([0, 1, 0]);
    expect(Array.from(buf.normals.slice(3, 6))).toEqual([0, 0, 1]);
  });

  it('forceNormals does NOT resurrect the empty short-circuit', () => {
    // Nothing merged ⇒ nothing to bind, and the layer keeps its live variant
    // while the mesh is hidden. Allocating here would be a pure waste.
    const buf = buildPointCloudBuffers([], proj, 0, {
      colorMode: CATEGORICAL,
      forceNormals: true,
      ...GEOM_OPTS,
    });
    expect(buf.count).toBe(0);
    expect(buf.hasNormals).toBe(false);
    expect(buf.normals.length).toBe(0);
  });

  it('honours an explicit normalColumn name, and null to ignore the column', () => {
    const tile = cloudTile(1, [anchor.longitude, anchor.latitude], {
      vectorProps: {
        surface_n: { value: new Float32Array([1, 0, 0]), size: 3 },
      },
      numericProps: { z: new Float32Array([0]) },
    });
    const named = buildPointCloudBuffers([tile], proj, 0, {
      colorMode: CATEGORICAL,
      normalColumn: 'surface_n',
      ...GEOM_OPTS,
    });
    expect(named.hasNormals).toBe(true);
    expect(Array.from(named.normals)).toEqual([1, 0, 0]);
    // Default name ('normal') doesn't match this archive → impostor variant.
    expect(
      buildPointCloudBuffers([tile], proj, 0, {
        colorMode: CATEGORICAL,
        ...GEOM_OPTS,
      }).hasNormals,
    ).toBe(false);
    expect(
      buildPointCloudBuffers([tile], proj, 0, {
        colorMode: CATEGORICAL,
        normalColumn: null,
        ...GEOM_OPTS,
      }).hasNormals,
    ).toBe(false);
  });
});

// ── COLOUR — the four-way resolution, in precedence order ─────────────────────

describe('buildPointCloudBuffers colour resolution', () => {
  const pos = [anchor.longitude, anchor.latitude];

  it('(1) an interleaved rgba(u8) vector column outranks every other path', () => {
    const tile = cloudTile(1, pos, {
      vectorProps: {
        point_rgba: { value: new Uint8Array([255, 128, 0, 255]), size: 4 },
      },
      // Both lower-precedence paths are ALSO present and must lose.
      numericProps: {
        r: new Float32Array([0]),
        g: new Float32Array([0]),
        b: new Float32Array([255]),
        z: new Float32Array([0]),
      },
    });
    const buf = buildPointCloudBuffers([tile], proj, 0, {
      colorMode: { type: 'rgb', columns: ['r', 'g', 'b'] },
      ...GEOM_OPTS,
    });
    expect(buf.colors[0]).toBeCloseTo(1, 6);
    expect(buf.colors[1]).toBeCloseTo(128 / 255, 6);
    expect(buf.colors[2]).toBe(0);
    expect(buf.colors[3]).toBeCloseTo(1, 6);
  });

  it('(2) three numeric rgb columns', () => {
    const tile = cloudTile(1, pos, {
      numericProps: {
        r: new Float32Array([255]),
        g: new Float32Array([0]),
        b: new Float32Array([0]),
        z: new Float32Array([0]),
      },
    });
    const buf = buildPointCloudBuffers([tile], proj, 0, {
      colorMode: { type: 'rgb', columns: ['r', 'g', 'b'] },
      ...GEOM_OPTS,
    });
    expect(buf.colors[0]).toBeCloseTo(1, 6);
    expect(buf.colors[1]).toBe(0);
    expect(buf.colors[3]).toBe(1);
  });

  it('(3) a categorical column through the CPU palette / colorMapping', () => {
    const tile = cloudTile(2, [...pos, ...pos], {
      categoricalProps: {
        classification: {
          indices: new Uint16Array([1, 0xffff]),
          categories: ['ground', 'building'],
        },
      },
      numericProps: { z: new Float32Array([0, 0]) },
    });
    const buf = buildPointCloudBuffers([tile], proj, 0, {
      colorMode: {
        ...CATEGORICAL,
        fallback: [10, 20, 30, 255] as RGBA,
      },
      ...GEOM_OPTS,
    });
    expect(buf.colors[0]).toBeCloseTo(255 / 255, 6); // building
    expect(buf.colors[1]).toBeCloseTo(158 / 255, 6);
    // Null category → the explicit fallback, never a mapped colour.
    expect(buf.colors[4]).toBeCloseTo(10 / 255, 6);
    expect(buf.colors[6]).toBeCloseTo(30 / 255, 6);
  });

  it('(4) a constant colour when nothing else resolves', () => {
    const tile = cloudTile(1, pos, {
      numericProps: { z: new Float32Array([0]) },
    });
    const buf = buildPointCloudBuffers([tile], proj, 0, {
      colorMode: { type: 'constant', color: [12, 34, 56, 128] },
      ...GEOM_OPTS,
    });
    expect(buf.colors[0]).toBeCloseTo(12 / 255, 6);
    expect(buf.colors[1]).toBeCloseTo(34 / 255, 6);
    expect(buf.colors[2]).toBeCloseTo(56 / 255, 6);
    expect(buf.colors[3]).toBeCloseTo(128 / 255, 6);
  });

  it('lets colorVectorColumn: null disable the interleaved probe', () => {
    const tile = cloudTile(1, pos, {
      vectorProps: {
        point_rgba: { value: new Uint8Array([255, 128, 0, 255]), size: 4 },
      },
      numericProps: { z: new Float32Array([0]) },
    });
    const buf = buildPointCloudBuffers([tile], proj, 0, {
      colorMode: { type: 'constant', color: [0, 0, 255, 255] },
      colorVectorColumn: null,
      ...GEOM_OPTS,
    });
    expect(buf.colors[2]).toBeCloseTo(1, 6); // the constant blue, not the column
  });
});

// ── RTC / empty / geometry-type ───────────────────────────────────────────────

describe('buildPointCloudBuffers RTC + short-circuits', () => {
  it('returns an RTC origin (~0 for the ENU frame, centres stay absolute)', () => {
    const tile = cloudTile(1, [anchor.longitude, anchor.latitude], {
      numericProps: { z: new Float32Array([3]) },
    });
    const buf = buildPointCloudBuffers([tile], proj, 0, {
      colorMode: CATEGORICAL,
      ...GEOM_OPTS,
    });
    // ENU anchored at the point → origin ≈ [0,0,3] (the origin takes the
    // elevation too), so the single centre is exactly at it.
    expect(buf.origin[0]).toBeCloseTo(0, 5);
    expect(buf.origin[1]).toBeCloseTo(0, 5);
    expect(buf.origin[2]).toBeCloseTo(3, 5);
    expect(buf.centers[2]).toBeCloseTo(0, 5);
  });

  it('subtracts the RTC origin so f32 centres stay small under mercator', () => {
    const mproj = new MercatorProjection(anchor);
    // Two points: the first defines the origin; the second is offset slightly.
    const tile = cloudTile(
      2,
      [
        anchor.longitude,
        anchor.latitude,
        anchor.longitude + 0.001,
        anchor.latitude + 0.001,
      ],
      { numericProps: { z: new Float32Array([0, 0]) } },
    );
    const buf = buildPointCloudBuffers([tile], mproj, 0, {
      colorMode: CATEGORICAL,
      ...GEOM_OPTS,
    });
    const abs0 = mproj.project(anchor.longitude, anchor.latitude, 0);
    expect(Math.abs(buf.origin[0])).toBeGreaterThan(1e6); // huge absolute mercator x
    expect(buf.origin[0]).toBeCloseTo(abs0[0], 3);
    expect(buf.centers[0]).toBeCloseTo(0, 3); // first centre IS the origin
    expect(buf.centers[1]).toBeCloseTo(0, 3);
    const abs1 = mproj.project(
      anchor.longitude + 0.001,
      anchor.latitude + 0.001,
      0,
    );
    expect(buf.centers[3]).toBeCloseTo(abs1[0] - abs0[0], 3);
    expect(buf.centers[4]).toBeCloseTo(abs1[1] - abs0[1], 3);
    expect(Math.abs(buf.centers[3])).toBeLessThan(500); // f32-small offset
  });

  it('short-circuits to the empty (never null) shape when nothing merges', () => {
    const buf = buildPointCloudBuffers([], proj, 0, {
      colorMode: CATEGORICAL,
      ...GEOM_OPTS,
    });
    expectEmptyBuffers(buf);
    expect(buf.centers.length).toBe(0);
    expect(buf.normals.length).toBe(0);
    expect(buf.hasNormals).toBe(false);
    expect(buf.colors.length).toBe(0);
    expect(buf.starts.length).toBe(0);
    expect(buf.ends.length).toBe(0);
    expect(buf.origin).toEqual([0, 0, 0]);
    // The pick-identity pair is present-but-empty, so a stale pick after a
    // reload resolves to null rather than to an old feature.
    expect(buf.provenance.length).toBe(0);
    expect(buf.binaryByTileKey.size).toBe(0);
  });

  it('skips non-point geometry layers', () => {
    const tile = cloudTile(
      1,
      [anchor.longitude, anchor.latitude],
      {},
      0,
      GeometryType.LineString,
    );
    const buf = buildPointCloudBuffers([tile], proj, 0, {
      colorMode: CATEGORICAL,
      ...GEOM_OPTS,
    });
    expectEmptyBuffers(buf);
    expect(buf.binaryByTileKey.size).toBe(0);
  });
});

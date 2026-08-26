// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Unit gate for the heatmap's CONSOLIDATED splat buffers.
 *
 * The GPU half of this kind (an additive splat pass into a float render target,
 * then a full-screen ramp resolve) cannot run in node — `vitest.config.ts` has
 * no WebGPU device — so everything that CAN be pinned headlessly is pinned here:
 * the merge order across tiles, the rebased times, the weight-column resolution
 * and its per-tile fallback, the non-finite guard, the RTC origin, and the fact
 * that non-point geometry is skipped rather than mis-splatted.
 *
 * The load-bearing property is the CONSOLIDATION itself: one buffer set across
 * every visible tile. A splat is ~`radiusPixels` wide on screen, so per-tile
 * accumulation would cut every splat straddling a tile border and paint a
 * lattice of brightness seams over the map.
 */

import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures } from '@poopdeck.gl/core';
import { buildHeatmapBuffers } from '../src/lib/heatmap-buffers';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { MercatorProjection } from '../src/projection/mercator';
import { makePointTile, makeLineTile } from './_support/features';
import { expectEmptyBuffers, expectRtcMercator } from './_support/rtc';

const anchor = { longitude: -71.05, latitude: 42.35 };
const proj = new LocalEnuProjection(anchor);

/** `count` points, all at the anchor unless `positions` says otherwise. */
const pointTile = (
  count: number,
  positions: number[],
  partial: Partial<BinaryFeatures> = {},
  timeOffset = 0,
  geometryType = GeometryType.Point,
) =>
  makePointTile(count, positions, partial, {
    timeOffset,
    geometryType,
    layerName: 'quakes',
  });

const at = (n: number) =>
  Array.from({ length: n }, () => [anchor.longitude, anchor.latitude]).flat();

describe('buildHeatmapBuffers — consolidation', () => {
  it('merges every visible tile into ONE buffer set, in tile order', () => {
    const a = pointTile(2, at(2), {}, 0);
    const b = pointTile(3, at(3), {}, 0);
    const buf = buildHeatmapBuffers([a, b], proj, 0);
    expect(buf.count).toBe(5);
    expect(buf.centers.length).toBe(5 * 3);
    expect(buf.weights.length).toBe(5);
    expect(buf.starts.length).toBe(5);
    expect(buf.ends.length).toBe(5);
  });

  it('rebases each tile’s times by its OWN timeOffset', () => {
    // Two tiles with different offsets merged against one scene origin: the
    // per-tile delta is what keeps both comparable to a single `currentTime`.
    const a = pointTile(
      1,
      at(1),
      {
        startTimes: new Float32Array([10]),
        endTimes: new Float32Array([15]),
      },
      3000,
    );
    const b = pointTile(
      1,
      at(1),
      {
        startTimes: new Float32Array([20]),
        endTimes: new Float32Array([25]),
      },
      5000,
    );
    const buf = buildHeatmapBuffers([a, b], proj, 1000);
    expect(buf.starts[0]).toBe(10 + (3000 - 1000));
    expect(buf.ends[0]).toBe(15 + (3000 - 1000));
    expect(buf.starts[1]).toBe(20 + (5000 - 1000));
    expect(buf.ends[1]).toBe(25 + (5000 - 1000));
  });

  it('projects centres RTC-relative and bounds them', () => {
    const buf = buildHeatmapBuffers(
      [
        pointTile(2, [
          anchor.longitude,
          anchor.latitude,
          anchor.longitude + 0.001,
          anchor.latitude,
        ]),
      ],
      proj,
      0,
    );
    // The first feature IS the RTC origin → (0,0,0).
    expect(buf.centers[0]).toBeCloseTo(0, 5);
    expect(buf.centers[1]).toBeCloseTo(0, 5);
    expect(buf.centers[2]).toBeCloseTo(0, 5);
    // ENU east of it by ~82 m at this latitude.
    expect(buf.centers[3]).toBeGreaterThan(50);
    expect(buf.bbox).not.toBeNull();
    expect(buf.bbox!.min[0]).toBeCloseTo(0, 5);
    expect(buf.bbox!.max[0]).toBeCloseTo(buf.centers[3], 5);
  });

  it('keeps RTC offsets tiny under mercator while origin carries the magnitude', () => {
    const merc = new MercatorProjection();
    const buf = buildHeatmapBuffers(
      [pointTile(1, [anchor.longitude, anchor.latitude])],
      merc,
      0,
    );
    expectRtcMercator(buf, { a: buf.centers[0], b: buf.centers[1] });
  });

  it('keeps the baked altitude of 3D positions', () => {
    const buf = buildHeatmapBuffers(
      [
        pointTile(
          2,
          [
            anchor.longitude,
            anchor.latitude,
            0,
            anchor.longitude,
            anchor.latitude,
            400,
          ],
          {
            positionDimensions: 3,
          },
        ),
      ],
      proj,
      0,
    );
    // Second splat sits 400 m above the first (the RTC origin).
    expect(buf.centers[5]).toBeCloseTo(400, 3);
  });
});

describe('buildHeatmapBuffers — weights', () => {
  it('weighs every point 1 when no weightProperty is set (count heatmap)', () => {
    const buf = buildHeatmapBuffers([pointTile(3, at(3))], proj, 0);
    expect(Array.from(buf.weights)).toEqual([1, 1, 1]);
  });

  it('reads the named weight column', () => {
    const tile = pointTile(3, at(3), {
      numericProps: { mag: new Float32Array([2, 4.5, 7]) },
    });
    const buf = buildHeatmapBuffers([tile], proj, 0, {
      weightProperty: 'mag',
    });
    expect(buf.weights[0]).toBeCloseTo(2, 5);
    expect(buf.weights[1]).toBeCloseTo(4.5, 5);
    expect(buf.weights[2]).toBeCloseTo(7, 5);
  });

  it('falls back to 1 for a tile that LACKS the weight column', () => {
    // deck's consolidator does the same (`weightSrc ? weightSrc[i] : 1`): a tile
    // predating the column contributes its count instead of punching a hole in
    // the density field.
    const withCol = pointTile(1, at(1), {
      numericProps: { mag: new Float32Array([6]) },
    });
    const without = pointTile(2, at(2));
    const buf = buildHeatmapBuffers([withCol, without], proj, 0, {
      weightProperty: 'mag',
    });
    expect(buf.weights[0]).toBeCloseTo(6, 5);
    expect(buf.weights[1]).toBe(1);
    expect(buf.weights[2]).toBe(1);
  });

  it('folds the archive weightScale into every weight', () => {
    const tile = pointTile(2, at(2), {
      numericProps: { mag: new Float32Array([4, 8]) },
    });
    const buf = buildHeatmapBuffers([tile], proj, 0, {
      weightProperty: 'mag',
      weightScale: 0.25,
    });
    expect(buf.weights[0]).toBeCloseTo(1, 5);
    expect(buf.weights[1]).toBeCloseTo(2, 5);
  });

  it('scales the constant weight too when no column is named', () => {
    const buf = buildHeatmapBuffers([pointTile(2, at(2))], proj, 0, {
      weightScale: 3,
    });
    expect(Array.from(buf.weights)).toEqual([3, 3]);
  });

  it('zeroes a non-finite weight instead of poisoning the accumulator', () => {
    // The target is ADDITIVE, so one NaN texel never washes out again.
    const tile = pointTile(3, at(3), {
      numericProps: { mag: new Float32Array([NaN, Infinity, 2]) },
    });
    const buf = buildHeatmapBuffers([tile], proj, 0, {
      weightProperty: 'mag',
    });
    expect(buf.weights[0]).toBe(0);
    expect(buf.weights[1]).toBe(0);
    expect(buf.weights[2]).toBeCloseTo(2, 5);
  });
});

describe('buildHeatmapBuffers — rejection + empty', () => {
  it('returns the empty SHAPE (never null) for no tiles', () => {
    const buf = buildHeatmapBuffers([], proj, 0);
    expectEmptyBuffers(buf);
    expect(buf.centers.length).toBe(0);
    expect(buf.weights.length).toBe(0);
    expect(buf.origin).toEqual([0, 0, 0]);
  });

  it('silently SKIPS non-point geometry', () => {
    // maplibre's heatmap renders POINT tiles only; a line tile is skipped, not
    // an error — a scene may mount the heatmap over a mixed-kind archive.
    const line = makeLineTile({
      featureCount: 1,
      positions: new Float64Array([
        anchor.longitude,
        anchor.latitude,
        anchor.longitude + 0.01,
        anchor.latitude,
      ]),
      startIndices: new Uint32Array([0, 2]),
    });
    expectEmptyBuffers(buildHeatmapBuffers([line], proj, 0));

    // …and mixing one in next to real points leaves the point count untouched.
    const buf = buildHeatmapBuffers([line, pointTile(2, at(2))], proj, 0);
    expect(buf.count).toBe(2);
  });

  it('skips a zero-feature point layer', () => {
    expectEmptyBuffers(buildHeatmapBuffers([pointTile(0, [])], proj, 0));
  });

  it('takes the RTC origin from the first NON-EMPTY layer', () => {
    const empty = pointTile(0, []);
    const real = pointTile(1, [anchor.longitude + 0.01, anchor.latitude]);
    const buf = buildHeatmapBuffers([empty, real], proj, 0);
    expect(buf.count).toBe(1);
    // Origin is that first real feature, so its own centre is the zero vector.
    expect(buf.centers[0]).toBeCloseTo(0, 5);
    expect(buf.centers[1]).toBeCloseTo(0, 5);
    expect(buf.origin[0]).toBeGreaterThan(500); // ~825 m east of the anchor
  });
});

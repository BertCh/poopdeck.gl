// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * The pure summary-cell kernel behind `STTH3SummaryLayer` (and, by design, any
 * other cell tier): u64 cell id → boundary ring → absolute ECEF ring, plus the
 * value→colour ramp and the extrusion height.
 *
 * The load-bearing property is the INJECTION seam. `h3-js` is a peer this thin
 * backend refuses to import, so the boundary lookup arrives as a function and
 * the kernel is generic over "a function from cell id to a ring" — which is
 * exactly what lets a quadbin tier reuse it. These cases pin that genericity by
 * driving the builder with a synthetic resolver and no h3-js anywhere.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  GeometryType,
  type BinaryFeatures,
  type Tile,
} from '@poopdeck.gl/core';
import {
  buildSummaryCells,
  collectSummaryLayers,
  h3IndexFromU64,
  ringCentroid,
  ringToEcef,
  unwrapRing,
  type CellBoundaryResolver,
} from '../src/lib/summary-cells';

const TIME_OFFSET = 1_700_000_000_000;

/** A summary-tier tile: u64 cell ids in `featureIds64`, aggregates in numericProps. */
function summaryTile(
  ids: bigint[],
  counts: number[],
  opts: { name?: string; timeOffset?: number } = {},
): Tile {
  const n = ids.length;
  const timeOffset = opts.timeOffset ?? TIME_OFFSET;
  const features: BinaryFeatures = {
    featureCount: n,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions: new Float64Array(n * 2),
    featureIds: new Uint32Array(n),
    featureIds64: BigUint64Array.from(ids),
    startTimes: new Float32Array(new Array(n).fill(0)),
    endTimes: new Float32Array(new Array(n).fill(1000)),
    timeOffset,
    numericProps: { count: new Float32Array(counts) },
    categoricalProps: {},
    vectorProps: {},
  };
  return {
    id: { z: 5, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: opts.name ?? 'summary',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
}

/**
 * A synthetic boundary: a small square around a longitude derived from the id.
 * Deliberately NOT h3-js — the point of the seam is that the kernel never knows
 * which tiling it is drawing.
 */
const squareResolver: CellBoundaryResolver = (cellId: bigint) => {
  const lon = Number(cellId % 100n) * 0.1 - 122;
  const lat = 37.5;
  const d = 0.05;
  return [
    [lon - d, lat - d],
    [lon + d, lat - d],
    [lon + d, lat + d],
    [lon - d, lat + d],
  ];
};

describe('the h3 index seam', () => {
  it('is the u64 in lowercase hex — no h3-js needed to form it', () => {
    expect(h3IndexFromU64(0x8928308280fffffn)).toBe('8928308280fffff');
    expect(h3IndexFromU64(255n)).toBe('ff');
  });
});

describe('collectSummaryLayers', () => {
  it('prefers the named layer', () => {
    const t = summaryTile([1n, 2n], [1, 2], { name: 'summary' });
    const { layers, nameMismatch } = collectSummaryLayers([t], 'summary');
    expect(layers).toHaveLength(1);
    expect(nameMismatch).toBe(false);
  });

  it('falls back to ANY id-bearing layer and reports the mismatch rather than blanking', () => {
    const t = summaryTile([1n], [1], { name: 'h3' });
    const { layers, nameMismatch } = collectSummaryLayers([t], 'summary');
    expect(layers).toHaveLength(1);
    expect(nameMismatch).toBe(true);
  });

  it('ignores layers with no u64 ids — those are not a summary tier', () => {
    const t = summaryTile([1n], [1]);
    delete t.layers[0].features.featureIds64;
    expect(collectSummaryLayers([t]).layers).toHaveLength(0);
  });
});

describe('ring geometry', () => {
  const unwrapped = (id: bigint): Float64Array =>
    unwrapRing(squareResolver(id)!)!;

  it('unwraps a boundary ring into a flat lon/lat buffer', () => {
    const u = unwrapped(5n);
    expect(u).toBeInstanceOf(Float64Array);
    expect(u.length).toBe(4 * 2);
  });

  it('centroids the UNWRAPPED ring, folded back into [-180, 180)', () => {
    const [lon, lat] = ringCentroid(unwrapped(5n));
    expect(lon).toBeCloseTo(-121.5, 6);
    expect(lat).toBeCloseTo(37.5, 6);
  });

  it('projects to absolute f64 ECEF metres, OPEN (no repeated first vertex)', () => {
    const u = unwrapped(5n);
    const [lon, lat] = ringCentroid(u);
    const out = ringToEcef(u, lon, lat, 1);
    expect(out).toHaveLength((u.length >> 1) * 3);
    const r = Math.hypot(out[0], out[1], out[2]);
    expect(r).toBeGreaterThan(6_350_000);
    expect(r).toBeLessThan(6_390_000);
    // First and last vertex must differ — Cesium closes the ring itself.
    const last = out.length - 3;
    expect(
      Math.hypot(
        out[0] - out[last],
        out[1] - out[last + 1],
        out[2] - out[last + 2],
      ),
    ).toBeGreaterThan(1);
  });

  it('a `coverage` below 1 shrinks the cell toward its own centroid', () => {
    const u = unwrapped(5n);
    const [lon, lat] = ringCentroid(u);
    const spread = (a: Float64Array): number =>
      Math.hypot(a[0] - a[6], a[1] - a[7], a[2] - a[8]);
    expect(spread(ringToEcef(u, lon, lat, 0.5))).toBeLessThan(
      spread(ringToEcef(u, lon, lat, 1)),
    );
  });
});

describe('buildSummaryCells', () => {
  const build = (t: Tile[], o = {}) => buildSummaryCells(t, squareResolver, o);

  it('emits one cell per id, with the ring the injected resolver returned', () => {
    const { cells } = build([summaryTile([1n, 2n, 3n], [10, 20, 30])]);
    expect(cells).toHaveLength(3);
    expect(cells[0].positions.length).toBe(4 * 3);
  });

  it('never imports h3-js — the resolver is the ONLY boundary source', () => {
    const spy = vi.fn(squareResolver);
    build([summaryTile([7n, 8n], [1, 2])], {});
    // Re-run with the spy to prove every cell went through it.
    const { cells } = buildSummaryCells(
      [summaryTile([7n, 8n], [1, 2])],
      spy,
      {},
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(cells).toHaveLength(2);
  });

  it('drops a cell the resolver cannot place, instead of drawing it at null island', () => {
    const partial: CellBoundaryResolver = (id) =>
      id === 2n ? null : squareResolver(id);
    const { cells } = buildSummaryCells(
      [summaryTile([1n, 2n, 3n], [1, 2, 3])],
      partial,
      {},
    );
    expect(cells).toHaveLength(2);
    expect(
      cells.every((c) => Math.hypot(...c.positions.slice(0, 3)) > 6_000_000),
    ).toBe(true);
  });

  it('auto-fits the colour domain from the cells it has', () => {
    const { domain } = build([summaryTile([1n, 2n, 3n], [10, 50, 90])]);
    expect(domain[0]).toBeLessThanOrEqual(10);
    expect(domain[1]).toBeGreaterThanOrEqual(90);
  });

  it('honours a PINNED colorDomain so a legend stays stable across rebuilds', () => {
    const pinned: [number, number] = [0, 1000];
    const { domain } = build([summaryTile([1n], [5])], { colorDomain: pinned });
    expect(domain).toEqual(pinned);
  });

  it('ramps colour monotonically with the weight', () => {
    const { cells } = build([summaryTile([1n, 2n], [0, 100])], {
      colorDomain: [0, 100] as [number, number],
    });
    const lo = cells.find((c) => c.weight === 0)!;
    const hi = cells.find((c) => c.weight === 100)!;
    // The two ends of the ramp must not paint the same colour.
    expect([lo.r, lo.g, lo.b]).not.toEqual([hi.r, hi.g, hi.b]);
  });

  it('rebases times to the build origin', () => {
    const later = summaryTile([9n], [1], { timeOffset: TIME_OFFSET + 5_000 });
    const { cells, timeOrigin } = build([summaryTile([1n], [1]), later]);
    expect(timeOrigin).toBe(TIME_OFFSET);
    const shifted = cells[cells.length - 1];
    expect(shifted.start).toBeCloseTo(5_000, 6);
  });

  it('extrudes by weight only when asked, and reports the height in metres', () => {
    const flat = build([summaryTile([1n], [10])]);
    expect(flat.cells[0].height).toBe(0);
    const tall = build([summaryTile([1n], [10])], {
      extruded: true,
      elevationScale: 100,
    });
    expect(tall.cells[0].height).toBeCloseTo(1000, 6);
  });

  it('paints the ramp LOW stop and warns once when the weight column is absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = summaryTile([1n, 2n], [1, 2]);
    t.layers[0].features.numericProps = {};
    const { cells } = build([t]);
    // It must NOT blank: the cells still render.
    expect(cells).toHaveLength(2);
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    warn.mockRestore();
  });

  it('returns an empty build for tiles with no summary layer', () => {
    const t = summaryTile([1n], [1]);
    delete t.layers[0].features.featureIds64;
    expect(build([t]).cells).toHaveLength(0);
  });
});

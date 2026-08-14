import { describe, it, expect } from 'vitest';
import { cellToLatLng, h3IndexToSplitLong } from 'h3-js';
import { h3IndexFromTile, cellBoundaryFromTile } from '../src/lib/h3-cell';
import { buildH3Buffers, DEFAULT_H3_COLOR_RANGE } from '../src/lib/h3-buffers';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { makeVectorTile as summaryTile } from './_support/features';
import { onScreen } from './_support/color-space';

// ── Reference H3 cell ids ────────────────────────────────────────────────────
// `8928308280fffff` — the res-9 SF cell from h3-js's README, centroid
// ≈ (-122.4183, 37.7765). Its 64-bit index packs to the u64 below; the builder
// ships exactly this u64 in the Arrow `id` column / `featureIds64`.
const SF_RES9_HEX = '8928308280fffff';
const SF_RES9_U64 = 617700169958293503n; // (upper<<32)|lower of the split index
// `8075fffffffffff` — a res-0 base cell, centroid ≈ (-5.2454, 2.3009).
const RES0_HEX = '8075fffffffffff';
const RES0_U64 = 578536630256664575n;

describe('h3-cell decode', () => {
  it('h3IndexFromTile: splits a u64 column row back to its H3 index string', () => {
    const ids = new BigUint64Array([SF_RES9_U64, RES0_U64]);
    expect(h3IndexFromTile(ids, 0)).toBe(SF_RES9_HEX);
    expect(h3IndexFromTile(ids, 1)).toBe(RES0_HEX);
    expect(h3IndexFromTile(ids, 2)).toBeNull(); // out of range
    expect(h3IndexFromTile(undefined, 0)).toBeNull();
  });

  it('cellBoundaryFromTile: decodes a column row to its lon/lat ring', () => {
    const ids = new BigUint64Array([SF_RES9_U64]);
    const b = cellBoundaryFromTile(ids, 0);
    expect(b).not.toBeNull();
    expect(b!.hex).toBe(SF_RES9_HEX);
    // h3-js boundaries are 5 (pentagon) / 6 (hexagon) / 7 (distorted) verts.
    expect(b!.ring.length).toBeGreaterThanOrEqual(5);
    expect(b!.ring.length).toBeLessThanOrEqual(7);
    // Ring is GeoJSON [lng, lat]; its centroid sits at the cell centre.
    const [clat, clng] = cellToLatLng(SF_RES9_HEX);
    let cx = 0,
      cy = 0;
    for (const [lng, lat] of b!.ring) {
      cx += lng;
      cy += lat;
    }
    cx /= b!.ring.length;
    cy /= b!.ring.length;
    expect(cx).toBeCloseTo(clng, 2);
    expect(cy).toBeCloseTo(clat, 2);
    // Sanity: the SF cell is around (-122.42, 37.78).
    expect(cx).toBeCloseTo(-122.418, 2);
    expect(cy).toBeCloseTo(37.776, 2);
  });

  it('cellBoundaryFromTile: guards range and undefined column', () => {
    const ids = new BigUint64Array([SF_RES9_U64]);
    expect(cellBoundaryFromTile(ids, 1)).toBeNull();
    expect(cellBoundaryFromTile(undefined, 0)).toBeNull();
  });
});

// ── buffer builder ──────────────────────────────────────────────────────────
const anchor = { longitude: -122.418, latitude: 37.776 };
const proj = new LocalEnuProjection(anchor);

// Two adjacent res-9 SF cells (neighbours of SF_RES9_HEX), for multi-cell tests.
const NEIGHBOR_A = '8928308280bffff';
const NEIGHBOR_B = '89283082873ffff';
function hexToU64(hex: string): bigint {
  // h3IndexToSplitLong is the inverse of splitLongToH3Index; rebuild the u64.
  const [lower, upper] = h3IndexToSplitLong(hex);
  return (BigInt(upper >>> 0) << 32n) | BigInt(lower >>> 0);
}

describe('buildH3Buffers', () => {
  it('emits one triangle fan per decodable cell, RTC origin set', () => {
    const tile = summaryTile([SF_RES9_U64], [5]);
    const buf = buildH3Buffers([tile], proj, { colorDomain: [0, 10] });
    expect(buf.count).toBe(1);
    // The cell's ring has N verts → N positions and (N-2)*3 indices.
    const verts = buf.positions.length / 3;
    expect(verts).toBeGreaterThanOrEqual(5);
    expect(verts).toBeLessThanOrEqual(7);
    expect(buf.indices.length).toBe((verts - 2) * 3);
    expect(buf.colors.length).toBe(verts * 4);
    // First fan triangle references vertex 0.
    expect(buf.indices[0]).toBe(0);
    expect(buf.indices[1]).toBe(1);
    expect(buf.indices[2]).toBe(2);
    // RTC: first ring vertex sits at the origin (offset ~0).
    expect(buf.positions[0]).toBeCloseTo(0, 3);
    expect(buf.positions[1]).toBeCloseTo(0, 3);
    expect(buf.bbox).not.toBeNull();
  });

  it('colours each cell by the count ramp over the pinned domain', () => {
    const tile = summaryTile(
      [hexToU64(NEIGHBOR_A), hexToU64(NEIGHBOR_B)],
      [0, 100],
    );
    const buf = buildH3Buffers([tile], proj, {
      colorDomain: [0, 100],
      colorRange: DEFAULT_H3_COLOR_RANGE,
    });
    expect(buf.count).toBe(2);
    const low = DEFAULT_H3_COLOR_RANGE[0];
    const high = DEFAULT_H3_COLOR_RANGE[DEFAULT_H3_COLOR_RANGE.length - 1];
    // cell 0 (count 0) → first stop; cell 1 (count 100 ≥ hi) → last stop.
    // cell 0's first vertex is at colors[0..]; cell 1 starts after cell 0's verts.
    // The buffer holds LINEAR-light values (the summary mesh shades through a
    // classic `vertexColors` material, so it decodes on the CPU); the ramp byte
    // is what Three's sRGB output pass puts back on screen — assert THAT.
    expect(onScreen(buf.colors[0])).toBeCloseTo(low[0] / 255, 5);
    expect(onScreen(buf.colors[1])).toBeCloseTo(low[1] / 255, 5);
    // Find a vertex belonging to cell 1 by scanning for the high color.
    let foundHigh = false;
    for (let i = 0; i < buf.colors.length; i += 4) {
      if (Math.abs(onScreen(buf.colors[i]) - high[0] / 255) < 1e-5) {
        foundHigh = true;
        break;
      }
    }
    expect(foundHigh).toBe(true);
  });

  it('coverage shrinks the hexagon toward its centroid', () => {
    const full = buildH3Buffers([summaryTile([SF_RES9_U64], [1])], proj, {
      colorDomain: [0, 1],
      coverage: 1,
    });
    const half = buildH3Buffers([summaryTile([SF_RES9_U64], [1])], proj, {
      colorDomain: [0, 1],
      coverage: 0.5,
    });
    const fullW = full.bbox!.max[0] - full.bbox!.min[0];
    const halfW = half.bbox!.max[0] - half.bbox!.min[0];
    expect(halfW).toBeCloseTo(fullW * 0.5, 2);
  });

  it('auto-domain uses visible cells when colorDomain is null', () => {
    const tile = summaryTile(
      [hexToU64(NEIGHBOR_A), hexToU64(NEIGHBOR_B)],
      [2, 8],
    );
    const buf = buildH3Buffers([tile], proj, {});
    // Lowest count maps to first stop (compared as displayed — see above).
    expect(onScreen(buf.colors[0])).toBeCloseTo(
      DEFAULT_H3_COLOR_RANGE[0][0] / 255,
      5,
    );
    const last = DEFAULT_H3_COLOR_RANGE[DEFAULT_H3_COLOR_RANGE.length - 1];
    let foundLast = false;
    for (let i = 0; i < buf.colors.length; i += 4) {
      if (Math.abs(onScreen(buf.colors[i]) - last[0] / 255) < 1e-5) {
        foundLast = true;
        break;
      }
    }
    expect(foundLast).toBe(true);
  });

  it('falls back to a layer carrying id64+weight when summary name absent', () => {
    const tile = summaryTile([SF_RES9_U64], [3], 'lidar');
    const buf = buildH3Buffers([tile], proj, { colorDomain: [0, 3] });
    expect(buf.count).toBe(1);
  });

  it('returns empty when no decodable cells', () => {
    const tile = summaryTile([], []);
    const buf = buildH3Buffers([tile], proj, {});
    expect(buf.count).toBe(0);
    expect(buf.origin).toEqual([0, 0, 0]);
  });
});

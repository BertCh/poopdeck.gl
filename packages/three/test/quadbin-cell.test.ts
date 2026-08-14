import { describe, it, expect } from 'vitest';
import {
  quadbinToTile,
  tileToBounds,
  cellBoundsFromTile,
} from '../src/lib/quadbin-cell';
import {
  buildQuadbinBuffers,
  rampBucketColor,
  DEFAULT_QUADBIN_COLOR_RANGE,
} from '../src/lib/quadbin-buffers';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { makeVectorTile as summaryTile } from './_support/features';
import { onScreen } from './_support/color-space';

// ── Reference Quadbin encoder (1:1 port of crates/stt-build/src/quadbin.rs) ──
// so the test generates valid u64 cell ids the decoder must invert.
const QUADBIN_HEADER = 0x4800_0000_0000_0000n;

function interleave(v: number): bigint {
  let x = BigInt(v >>> 0) & 0x0000_0000_03ff_ffffn;
  x = (x | (x << 16n)) & 0x0000_ffff_0000_ffffn;
  x = (x | (x << 8n)) & 0x00ff_00ff_00ff_00ffn;
  x = (x | (x << 4n)) & 0x0f0f_0f0f_0f0f_0f0fn;
  x = (x | (x << 2n)) & 0x3333_3333_3333_3333n;
  x = (x | (x << 1n)) & 0x5555_5555_5555_5555n;
  return x;
}

function tileToQuadbin(z: number, x: number, y: number): bigint {
  const zb = BigInt(z);
  const interleaved = interleave(x) | (interleave(y) << 1n);
  const mortonShift = BigInt(52 - 2 * z);
  const payload = (interleaved << mortonShift) & 0x000f_ffff_ffff_ffffn;
  const fill = mortonShift === 0n ? 0n : (1n << mortonShift) - 1n;
  return QUADBIN_HEADER | (zb << 52n) | payload | fill;
}

describe('quadbin-cell decode', () => {
  it('matches CARTO reference: tile_to_quadbin(0,0,0) === 0x480fffffffffffff', () => {
    expect(tileToQuadbin(0, 0, 0)).toBe(0x480f_ffff_ffff_ffffn);
  });

  it('round-trips (z,x,y) -> u64 -> (z,x,y) across zooms', () => {
    const cases: [number, number, number][] = [
      [0, 0, 0],
      [1, 1, 0],
      [4, 5, 11],
      [10, 512, 300],
      [14, 8000, 5400],
      [26, 1234567, 7654321],
    ];
    for (const [z, x, y] of cases) {
      const id = tileToQuadbin(z, x, y);
      expect(quadbinToTile(id)).toEqual({ z, x, y });
    }
  });

  it('tileToBounds: root cell spans the whole mercator world', () => {
    const b = tileToBounds({ z: 0, x: 0, y: 0 });
    expect(b.west).toBeCloseTo(-180, 6);
    expect(b.east).toBeCloseTo(180, 6);
    expect(b.north).toBeCloseTo(85.051129, 4);
    expect(b.south).toBeCloseTo(-85.051129, 4);
  });

  it('tileToBounds: zoom-1 NW quadrant covers (-180..0, 0..85)', () => {
    const b = tileToBounds({ z: 1, x: 0, y: 0 });
    expect(b.west).toBeCloseTo(-180, 6);
    expect(b.east).toBeCloseTo(0, 6);
    expect(b.north).toBeCloseTo(85.051129, 4);
    expect(b.south).toBeCloseTo(0, 6);
  });

  it('cellBoundsFromTile decodes a column row, guards range/zoom', () => {
    const ids = new BigUint64Array([tileToQuadbin(2, 1, 2)]);
    const b = cellBoundsFromTile(ids, 0);
    expect(b).not.toBeNull();
    // (z=2,x=1) → lon band [-90, 0]; (y=2) → upper-mid lat band.
    expect(b!.west).toBeCloseTo(-90, 6);
    expect(b!.east).toBeCloseTo(0, 6);
    expect(cellBoundsFromTile(ids, 1)).toBeNull(); // out of range
    expect(cellBoundsFromTile(undefined, 0)).toBeNull();
  });
});

describe('rampBucketColor', () => {
  const range = DEFAULT_QUADBIN_COLOR_RANGE;
  it('buckets the domain into colorRange.length stops', () => {
    expect(rampBucketColor(0, [0, 6], range)).toBe(range[0]);
    expect(rampBucketColor(6, [0, 6], range)).toBe(range[range.length - 1]); // >= hi clamps to last
    expect(rampBucketColor(100, [0, 6], range)).toBe(range[range.length - 1]);
    expect(rampBucketColor(-5, [0, 6], range)).toBe(range[0]); // below lo
  });
  it('degenerate domain returns first stop', () => {
    expect(rampBucketColor(5, [3, 3], range)).toBe(range[0]);
    expect(rampBucketColor(NaN, [0, 1], range)).toBe(range[0]);
  });
});

// ── buffer builder ──────────────────────────────────────────────────────────
const anchor = { longitude: 0, latitude: 0 };
const proj = new LocalEnuProjection(anchor);

describe('buildQuadbinBuffers', () => {
  it('emits 4 verts + 6 indices per decodable cell, RTC origin set', () => {
    const tile = summaryTile(
      [tileToQuadbin(4, 5, 6), tileToQuadbin(4, 5, 7)],
      [1, 9],
    );
    const buf = buildQuadbinBuffers([tile], proj, { colorDomain: [0, 10] });
    expect(buf.count).toBe(2);
    expect(buf.positions.length).toBe(2 * 4 * 3);
    expect(buf.indices.length).toBe(2 * 6);
    expect(buf.colors.length).toBe(2 * 4 * 4);
    // First triangle of first cell references its own 4 verts.
    expect(Array.from(buf.indices.slice(0, 6))).toEqual([0, 1, 2, 0, 2, 3]);
    // RTC: first cell SW corner sits at the origin (offset ~0).
    expect(buf.positions[0]).toBeCloseTo(0, 3);
    expect(buf.positions[1]).toBeCloseTo(0, 3);
    expect(buf.bbox).not.toBeNull();
  });

  it('colours each cell by the count ramp over the pinned domain', () => {
    const tile = summaryTile(
      [tileToQuadbin(4, 5, 6), tileToQuadbin(4, 5, 7)],
      [0, 100],
    );
    const buf = buildQuadbinBuffers([tile], proj, {
      colorDomain: [0, 100],
      colorRange: DEFAULT_QUADBIN_COLOR_RANGE,
    });
    const low = DEFAULT_QUADBIN_COLOR_RANGE[0];
    const high =
      DEFAULT_QUADBIN_COLOR_RANGE[DEFAULT_QUADBIN_COLOR_RANGE.length - 1];
    // cell 0 (count 0) → first stop; cell 1 (count 100 ≥ hi) → last stop.
    // The buffer holds LINEAR-light values (the summary mesh shades through a
    // classic `vertexColors` material, so it decodes on the CPU); the ramp byte
    // is what Three's sRGB output pass puts back on screen — assert THAT.
    expect(onScreen(buf.colors[0])).toBeCloseTo(low[0] / 255, 5);
    const c1 = 4 * 4; // cell 1, vert 0
    expect(onScreen(buf.colors[c1])).toBeCloseTo(high[0] / 255, 5);
  });

  it('coverage shrinks the quad toward its centroid', () => {
    const id = tileToQuadbin(4, 5, 6);
    const full = buildQuadbinBuffers([summaryTile([id], [1])], proj, {
      colorDomain: [0, 1],
      coverage: 1,
    });
    const half = buildQuadbinBuffers([summaryTile([id], [1])], proj, {
      colorDomain: [0, 1],
      coverage: 0.5,
    });
    // origin is the SW corner; with coverage<1 the SW corner moves inward (toward centroid),
    // so its offset magnitude from the full-quad origin grows positive in x.
    const fullW = full.bbox!.max[0] - full.bbox!.min[0];
    const halfW = half.bbox!.max[0] - half.bbox!.min[0];
    expect(halfW).toBeCloseTo(fullW * 0.5, 2);
  });

  it('auto-domain uses visible cells when colorDomain is null', () => {
    const tile = summaryTile(
      [tileToQuadbin(4, 5, 6), tileToQuadbin(4, 5, 7)],
      [2, 8],
    );
    const buf = buildQuadbinBuffers([tile], proj, {});
    // Lowest count maps to first stop, highest (== hi) to last stop — compared
    // as displayed (see above).
    expect(onScreen(buf.colors[0])).toBeCloseTo(
      DEFAULT_QUADBIN_COLOR_RANGE[0][0] / 255,
      5,
    );
    const last =
      DEFAULT_QUADBIN_COLOR_RANGE[DEFAULT_QUADBIN_COLOR_RANGE.length - 1];
    expect(onScreen(buf.colors[16])).toBeCloseTo(last[0] / 255, 5);
  });

  it('falls back to a layer carrying id64+weight when summary name absent', () => {
    const tile = summaryTile([tileToQuadbin(4, 5, 6)], [3], 'lidar');
    const buf = buildQuadbinBuffers([tile], proj, { colorDomain: [0, 3] });
    expect(buf.count).toBe(1);
  });

  it('returns empty when no decodable cells', () => {
    const tile = summaryTile([], []);
    const buf = buildQuadbinBuffers([tile], proj, {});
    expect(buf.count).toBe(0);
    expect(buf.origin).toEqual([0, 0, 0]);
  });
});

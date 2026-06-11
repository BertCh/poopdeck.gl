/**
 * Verifies the CARTO Quadbin u64 → (z, x, y) → Bing-quadkey-string conversion
 * at the heart of QuadbinSummaryLayer.prepareTile. The full layer is hard to
 * instantiate in a vitest environment (no WebGL context, no real archive), but
 * the pure conversion + weight pickup is what we actually need to assert — the
 * Quadbin counterpart of h3-summary-layer.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  quadbinToTile,
  tileToQuadkey,
  quadkeyFromTile,
  type QuadbinTile,
} from '../src/lib/quadbin-cell';

/**
 * Canonical CARTO `tile → quadbin u64` encode, kept INDEPENDENT of the
 * decoder under test (interleave is the mirror of the decoder's deinterleave).
 * Reference hex values below are cross-checked against CARTO's quadbin-js
 * (e.g. `(0,0,0)` → `0x480fffffffffffff` = 5192650370358181887).
 */
function tileToQuadbin({ x, y, z }: QuadbinTile): bigint {
  const interleave = (value: number): bigint => {
    let v = BigInt(value) & 0xffffffffn;
    v = (v | (v << 16n)) & 0x0000ffff0000ffffn;
    v = (v | (v << 8n)) & 0x00ff00ff00ff00ffn;
    v = (v | (v << 4n)) & 0x0f0f0f0f0f0f0f0fn;
    v = (v | (v << 2n)) & 0x3333333333333333n;
    v = (v | (v << 1n)) & 0x5555555555555555n;
    return v;
  };
  const interleaved = interleave(x) | (interleave(y) << 1n);
  const shift = BigInt(52 - 2 * z);
  const morton = (interleaved << shift) & ((1n << 52n) - 1n);
  const fill = (1n << shift) - 1n;
  return 0x4000000000000000n | (1n << 59n) | (BigInt(z) << 52n) | morton | fill;
}

describe('quadbin-cell: CARTO Quadbin u64 → tile', () => {
  it('decodes the canonical CARTO reference ids', () => {
    // CARTO quadbin-js published values. (0,0,0)=0x480f… is CARTO's canonical
    // reference; the others follow from the documented bit layout — note the
    // morton interleave puts x in even bits / y in odd bits, so (1,0,1)
    // encodes to 0x481b…, NOT 0x4813… (which is (1,0,0)).
    expect(quadbinToTile(0x480fffffffffffffn)).toEqual({ z: 0, x: 0, y: 0 });
    expect(quadbinToTile(0x481fffffffffffffn)).toEqual({ z: 1, x: 1, y: 1 });
    expect(quadbinToTile(0x481bffffffffffffn)).toEqual({ z: 1, x: 0, y: 1 });
    expect(quadbinToTile(0x4813ffffffffffffn)).toEqual({ z: 1, x: 0, y: 0 });
  });

  it('round-trips tile → quadbin → tile across zooms and edges', () => {
    const cases: QuadbinTile[] = [
      { z: 0, x: 0, y: 0 },
      { z: 1, x: 1, y: 0 },
      { z: 2, x: 3, y: 2 },
      { z: 5, x: 9, y: 4 },
      { z: 15, x: 10330, y: 25295 },
      { z: 25, x: (1 << 25) - 1, y: (1 << 25) - 1 }, // max zoom, max coord
    ];
    for (const t of cases) {
      const q = tileToQuadbin(t);
      expect(quadbinToTile(q)).toEqual(t);
    }
  });
});

describe('quadbin-cell: tile → Bing quadkey string', () => {
  it('matches the known base-4 path digits', () => {
    expect(tileToQuadkey({ z: 0, x: 0, y: 0 })).toBe(''); // root tile
    expect(tileToQuadkey({ z: 1, x: 0, y: 0 })).toBe('0');
    expect(tileToQuadkey({ z: 1, x: 1, y: 0 })).toBe('1');
    expect(tileToQuadkey({ z: 1, x: 0, y: 1 })).toBe('2');
    expect(tileToQuadkey({ z: 1, x: 1, y: 1 })).toBe('3');
    // A multi-level path (standard Bing-quadkey worked example).
    expect(tileToQuadkey({ z: 3, x: 3, y: 5 })).toBe('213');
  });

  it('produces a Bing quadkey that round-trips back to the source tile', () => {
    // QuadkeyLayer geolocates a cell by parsing its quadkey back to (x, y, z).
    // Assert our quadkey reproduces the exact tile address via the inverse
    // base-4 walk — self-contained, no dependence on deck internals (the
    // `quadkeyToWorldBounds` util is not a public @deck.gl/geo-layers export).
    const z = 4;
    const tile: QuadbinTile = { z, x: 9, y: 4 };
    const quadkey = tileToQuadkey(tile);
    expect(quadkey).toHaveLength(z);
    expect(/^[0-3]+$/.test(quadkey)).toBe(true);
    let x = 0;
    let y = 0;
    for (let i = 0; i < quadkey.length; i++) {
      const bit = 1 << (quadkey.length - 1 - i);
      const digit = quadkey.charCodeAt(i) - 48; // '0'..'3' → 0..3
      if (digit & 1) x |= bit;
      if (digit & 2) y |= bit;
    }
    expect({ z: quadkey.length, x, y }).toEqual(tile);
  });
});

describe('quadbin-cell: quadkeyFromTile (the layer read path)', () => {
  it('recovers the quadkey from the featureIds64 column at row i', () => {
    const ids = new BigUint64Array([
      tileToQuadbin({ z: 3, x: 3, y: 5 }),
      tileToQuadbin({ z: 3, x: 0, y: 0 }),
    ]);
    expect(quadkeyFromTile(ids, 0)).toBe('213');
    expect(quadkeyFromTile(ids, 1)).toBe('000');
  });

  it('returns null for a missing column or out-of-range index', () => {
    expect(quadkeyFromTile(undefined, 0)).toBeNull();
    const ids = new BigUint64Array([tileToQuadbin({ z: 1, x: 0, y: 0 })]);
    expect(quadkeyFromTile(ids, 1)).toBeNull();
    expect(quadkeyFromTile(ids, 99)).toBeNull();
  });

  it('rejects an id whose decoded zoom is out of the Quadbin band', () => {
    // Force a zoom field of 31 (0x1f) — outside the valid 0..26 band.
    const bogus = 0x4000000000000000n | (1n << 59n) | (0x1fn << 52n);
    expect(quadkeyFromTile(new BigUint64Array([bogus]), 0)).toBeNull();
  });
});

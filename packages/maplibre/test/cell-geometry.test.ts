/**
 * Cell-geometry kernel tests (maplibre parity campaign, Wave M4).
 *
 * The point of this suite is that NONE of the reference values are produced by
 * the code under test:
 *
 * - **H3** boundaries and cell areas are literals lifted straight out of
 *   `h3-js@4` — the same library `@poopdeck.gl/layers` and `@poopdeck.gl/three`
 *   resolve cells with. Regenerate with, from `packages/three`:
 *   ```
 *   node --input-type=module -e "import {cellToBoundary, cellArea} from 'h3-js';
 *     console.log(cellToBoundary('8928308280fffff', true), cellArea('8928308280fffff','m2'))"
 *   ```
 *   (h3-js is not a dependency of `@poopdeck.gl/maplibre` — see the module doc
 *   and this wave's concerns — so the fixture doubles as the injected
 *   `cellToBoundary` the kernel takes.)
 * - **Quadbin** ids are built by an INDEPENDENT encoder (the mirror of the
 *   decoder under test, ported from `crates/stt-build/src/quadbin.rs`) and
 *   anchored on CARTO's published `(0,0,0) → 0x480fffffffffffff`.
 * - **hexbin** bins are cross-checked against `@deck.gl/aggregation-layers`'
 *   `pointToHexbin` / `getHexbinCentroid`, copied VERBATIM from
 *   `src/hexagon-layer/hexbin.ts` and evaluated in deck's own 512-unit common
 *   space via `@math.gl/web-mercator`'s `lngLatToWorld`. If the kernel's
 *   mercator-space lattice ever drifts from deck's, this fails.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSummaryCellRings,
  cellRingToTriangles,
  h3CellToMercatorRing,
  h3IndexFromU64,
  hexBinCentroidMercator,
  hexBinKey,
  hexBinKeyForPoint,
  hexBinKeyI,
  hexBinKeyJ,
  hexBinRadiusFromMeters,
  hexBinToMercatorRing,
  orientRingPositive,
  pointToHexBin,
  quadbinCellToMercatorRing,
  quadbinTileToMercatorBounds,
  quadbinToTile,
  ringSignedArea2,
  triangulateCellRings,
  type QuadbinTile,
} from '../src/lib/cell-geometry';
import {
  lngLatToMercator,
  metersPerMercatorUnit,
  metersToMercatorUnits,
} from '../src/lib/projection';

// ── h3-js fixtures (verbatim library output, see the file header) ───────────

/** `cellToBoundary(index, true)` → GeoJSON [lng, lat], ring CLOSED by h3-js. */
const H3_BOUNDARIES: Record<string, [number, number][]> = {
  // res 9, San Francisco — the canonical H3 documentation cell.
  '8928308280fffff': [
    [-122.41719971841658, 37.775197782893386],
    [-122.41612835779266, 37.77688044840227],
    [-122.41738797617619, 37.77838500493093],
    [-122.41971895414808, 37.77820687262238],
    [-122.4207902454188, 37.776524206993216],
    [-122.41953062807342, 37.77501967379261],
    [-122.41719971841658, 37.775197782893386],
  ],
  // res 0 PENTAGON (5 distinct vertices + h3-js's closing repeat).
  '8009fffffffffff': [
    [-10.444977544778336, 63.09505407752544],
    [5.523646549290319, 55.70676846515226],
    [25.08272232670788, 58.40154487035269],
    [31.831280499087388, 68.92995788193984],
    [0.32561035194326043, 73.31022368544396],
    [-10.444977544778336, 63.09505407752544],
  ],
  // res 5 straddling the antimeridian — `latLngToCell(20, -179.99, 5)`.
  '855ab3cffffffff': [
    [-179.9366031180495, 19.979620696385894],
    [-179.92297040310055, 20.068963974365744],
    [179.9999432403449, 20.121291067273578],
    [179.9092294384495, 20.08415580289762],
    [179.89574875211053, 19.994748008387237],
    [179.97282966754992, 19.942539889218345],
    [-179.9366031180495, 19.979620696385894],
  ],
  // res 3 straddling the antimeridian at the equator — `latLngToCell(0, 179.9, 3)`.
  '837eb5fffffffff': [
    [179.56029804461528, 0.23643774835235576],
    [179.45971970280297, -0.29591509173461567],
    [179.83979656305476, -0.7197982113704025],
    [-179.67521794977583, -0.6139394292019404],
    [-179.57089214102933, -0.0790111580310489],
    [-179.9553093540479, 0.3474977589047076],
    [179.56029804461528, 0.23643774835235576],
  ],
  // res 3 cell CONTAINING the north pole — `latLngToCell(89.99, 0, 3)`.
  // Every vertex is poleward of the mercator cutoff (±85.0511°).
  '830326fffffffff': [
    [68.57108041025946, 89.12460007946186],
    [106.89856902087111, 88.97311885755303],
    [146.0083972433273, 89.07414908971177],
    [-169.59042023262222, 89.37403016692109],
    [-89.47705535283792, 89.72256283941209],
    [21.59964913759069, 89.49570229280711],
    [68.57108041025946, 89.12460007946186],
  ],
  // res 2 cell CONTAINING the south pole — `latLngToCell(-89.9, 0, 2)`.
  '82f297fffffffff': [
    [145.04876414224043, -87.58500991616788],
    [101.81683545801552, -87.80824356139675],
    [52.289931334303844, -88.47700143144088],
    [-33.991602756673394, -89.07414908971177],
    [-121.61555094370388, -88.49939324217596],
    [-171.6156393252593, -87.82361750161158],
    [145.04876414224043, -87.58500991616788],
  ],
  // res 0 cell containing the north pole — `latLngToCell(90, 0, 0)`. Big
  // enough that most of it IS inside the mercator world.
  '8001fffffffffff': [
    [31.831280499087402, 68.92995788193984],
    [62.345344956509784, 69.3935964899183],
    [94.14309010184775, 76.16304283019099],
    [145.5581976913369, 87.3646953231962],
    [-34.75841798028471, 81.27137179020501],
    [0.32561035194326043, 73.31022368544396],
    [31.831280499087402, 68.92995788193984],
  ],
};

/** `cellArea(index, 'm2')`, straight from h3-js. */
const H3_AREA_M2: Record<string, number> = {
  '8928308280fffff': 109398.18864716178,
  '855ab3cffffffff': 264781731.26655012,
};

/** The injected resolver: h3-js's `cellToBoundary`, replayed from fixtures. */
function cellToBoundary(
  h3Index: string,
  formatAsGeoJson?: boolean,
): number[][] {
  const ring = H3_BOUNDARIES[h3Index];
  // h3-js THROWS on a non-cell index; the kernel must degrade, so the fake
  // has to throw too.
  if (!ring) throw new Error(`not a valid cell: ${h3Index}`);
  if (!formatAsGeoJson) return ring.map(([lng, lat]) => [lat, lng]);
  return ring.map((v) => [...v]);
}

const SF = '8928308280fffff';
const PENTAGON = '8009fffffffffff';
const SEAM_R5 = '855ab3cffffffff';
const SEAM_R3 = '837eb5fffffffff';
const NORTH_POLE_R3 = '830326fffffffff';
const NORTH_POLE_R0 = '8001fffffffffff';
const SOUTH_POLE_R2 = '82f297fffffffff';

const u64 = (hex: string): bigint => BigInt(`0x${hex}`);

// ── helpers ─────────────────────────────────────────────────────────────────

function ringIsClosed(ring: Float64Array): boolean {
  const n = ring.length >> 1;
  return ring[0] === ring[(n - 1) * 2] && ring[1] === ring[(n - 1) * 2 + 1];
}

function xRange(ring: Float64Array): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    if (ring[i] < lo) lo = ring[i];
    if (ring[i] > hi) hi = ring[i];
  }
  return [lo, hi];
}

/** Signed area of one triangle in the mercator frame; positive = canonical. */
function triangleArea2(
  pos: Float64Array,
  i0: number,
  i1: number,
  i2: number,
): number {
  const ax = pos[i0 * 2];
  const ay = pos[i0 * 2 + 1];
  const bx = pos[i1 * 2];
  const by = pos[i1 * 2 + 1];
  const cx = pos[i2 * 2];
  const cy = pos[i2 * 2 + 1];
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

// ── H3 ──────────────────────────────────────────────────────────────────────

describe('h3IndexFromU64', () => {
  it('reproduces h3-js splitLongToH3Index for the fixture cells', () => {
    // Literal pairs printed by h3-js itself:
    //   splitLongToH3Index(lower, upper) === BigInt(u64).toString(16)
    expect(h3IndexFromU64(617700169958293503n)).toBe('8928308280fffff');
    expect(h3IndexFromU64(576636674163867647n)).toBe('8009fffffffffff');
    expect(h3IndexFromU64(592200673571897343n)).toBe('837eb5fffffffff');
    expect(h3IndexFromU64(576495936675512319n)).toBe('8001fffffffffff');
  });

  it('round-trips every fixture index through its u64', () => {
    for (const hex of Object.keys(H3_BOUNDARIES)) {
      expect(h3IndexFromU64(u64(hex))).toBe(hex);
    }
  });
});

describe('h3CellToMercatorRing', () => {
  it('projects each h3-js boundary vertex, closed, 6 + 1 for a hexagon', () => {
    const ring = h3CellToMercatorRing(SF, cellToBoundary)!;
    expect(ring).not.toBeNull();
    expect(ring.length).toBe(7 * 2); // 6 distinct + closing repeat
    expect(ringIsClosed(ring)).toBe(true);

    // Every emitted vertex must be lngLatToMercator() of a fixture vertex.
    const expected = H3_BOUNDARIES[SF]
      .slice(0, 6)
      .map(([lng, lat]) => lngLatToMercator(lng, lat));
    for (let i = 0; i < 6; i++) {
      const hit = expected.some(
        ([x, y]) =>
          Math.abs(x - ring[i * 2]) < 1e-15 &&
          Math.abs(y - ring[i * 2 + 1]) < 1e-15,
      );
      expect(hit).toBe(true);
    }
  });

  it('emits 5 + 1 vertices for a pentagon', () => {
    const ring = h3CellToMercatorRing(PENTAGON, cellToBoundary)!;
    expect(ring.length).toBe(6 * 2);
    expect(ringIsClosed(ring)).toBe(true);
  });

  it('accepts the u64 form as well as the index string', () => {
    const fromString = h3CellToMercatorRing(SF, cellToBoundary)!;
    const fromU64 = h3CellToMercatorRing(u64(SF), cellToBoundary)!;
    expect(Array.from(fromU64)).toEqual(Array.from(fromString));
  });

  it('returns null for an index h3-js rejects', () => {
    expect(h3CellToMercatorRing('not-a-cell', cellToBoundary)).toBeNull();
  });

  it('winds positive in the mercator frame', () => {
    for (const hex of [SF, PENTAGON, SEAM_R5, SEAM_R3]) {
      const ring = h3CellToMercatorRing(hex, cellToBoundary)!;
      expect(ringSignedArea2(ring)).toBeGreaterThan(0);
    }
  });

  it('reproduces h3-js cellArea once mercator distortion is undone', () => {
    // Cross-check against the LIBRARY's own spherical area: for a cell small
    // enough that the mercator scale is ~constant across it, ground area =
    // mercator area x metersPerMercatorUnit(lat)^2.
    for (const [hex, areaM2] of Object.entries(H3_AREA_M2)) {
      const ring = h3CellToMercatorRing(hex, cellToBoundary)!;
      const lat =
        H3_BOUNDARIES[hex].slice(0, -1).reduce((acc, [, la]) => acc + la, 0) /
        (H3_BOUNDARIES[hex].length - 1);
      const scale = metersPerMercatorUnit(lat);
      const measured = (ringSignedArea2(ring) / 2) * scale * scale;
      expect(measured / areaM2).toBeGreaterThan(0.99);
      expect(measured / areaM2).toBeLessThan(1.01);
    }
  });

  it('shrinks toward the centroid under coverage', () => {
    const full = h3CellToMercatorRing(SF, cellToBoundary)!;
    const half = h3CellToMercatorRing(SF, cellToBoundary, { coverage: 0.5 })!;
    // Area scales with coverage^2; the centroid is unmoved.
    expect(ringSignedArea2(half) / ringSignedArea2(full)).toBeCloseTo(0.25, 9);
    const cx = (r: Float64Array): number => {
      let s = 0;
      const n = (r.length >> 1) - 1;
      for (let i = 0; i < n; i++) s += r[i * 2];
      return s / n;
    };
    expect(cx(half)).toBeCloseTo(cx(full), 12);
  });
});

describe('h3CellToMercatorRing: antimeridian', () => {
  it('keeps a seam-crossing cell contiguous instead of smearing it', () => {
    for (const hex of [SEAM_R5, SEAM_R3]) {
      // What a naive per-vertex projection does: x lands on BOTH edges of the
      // world and the cell spans it. This is the failure mode being prevented.
      const naive = H3_BOUNDARIES[hex]
        .slice(0, -1)
        .map(([lng, lat]) => lngLatToMercator(lng, lat)[0]);
      expect(Math.max(...naive) - Math.min(...naive)).toBeGreaterThan(0.99);

      const ring = h3CellToMercatorRing(hex, cellToBoundary)!;
      const [lo, hi] = xRange(ring);
      expect(hi - lo).toBeLessThan(0.01);
      // ...and it straddles the seam rather than being shoved to one side.
      expect(hi).toBeGreaterThan(1 - 1e-3);
    }
  });

  it('places the ring centroid inside the primary world copy', () => {
    const ring = h3CellToMercatorRing(SEAM_R5, cellToBoundary)!;
    const n = (ring.length >> 1) - 1;
    let cx = 0;
    for (let i = 0; i < n; i++) cx += ring[i * 2];
    cx /= n;
    expect(cx).toBeGreaterThanOrEqual(0);
    expect(cx).toBeLessThan(1);
  });

  it('leaves a non-crossing cell strictly inside the unit square', () => {
    const [lo, hi] = xRange(h3CellToMercatorRing(SF, cellToBoundary)!);
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeLessThan(1);
  });
});

describe('h3CellToMercatorRing: poles', () => {
  it('turns a pole-enclosing cell into a full-width band, not a smear', () => {
    const ring = h3CellToMercatorRing(NORTH_POLE_R0, cellToBoundary)!;
    expect(ring.length).toBe(5 * 2); // 4 corners + close
    const [lo, hi] = xRange(ring);
    expect(lo).toBe(0);
    expect(hi).toBe(1);
    // Band runs from the north edge (y = 0) to the cell's equatorward-most
    // vertex — lat 68.93 in the fixture.
    let maxY = -Infinity;
    let minY = Infinity;
    for (let i = 1; i < ring.length; i += 2) {
      if (ring[i] > maxY) maxY = ring[i];
      if (ring[i] < minY) minY = ring[i];
    }
    expect(minY).toBe(0);
    expect(maxY).toBeCloseTo(lngLatToMercator(0, 68.92995788193984)[1], 12);
    expect(ringSignedArea2(ring)).toBeGreaterThan(0);
  });

  it('bands the south-pole cell against y = 1', () => {
    const ring = h3CellToMercatorRing(SOUTH_POLE_R2, cellToBoundary)!;
    let maxY = -Infinity;
    for (let i = 1; i < ring.length; i += 2) maxY = Math.max(maxY, ring[i]);
    expect(maxY).toBe(1);
  });

  it('collapses a cell entirely poleward of the mercator cutoff', () => {
    // Every vertex of the res-3 pole cell is above 85.0511, so mercator has
    // literally no room for it: the band is zero-height (nothing draws) rather
    // than a wrong-but-visible rectangle.
    const ring = h3CellToMercatorRing(NORTH_POLE_R3, cellToBoundary)!;
    for (let i = 1; i < ring.length; i += 2) expect(ring[i]).toBe(0);
    expect(ringSignedArea2(ring)).toBe(0);
  });

  it('drops the cell entirely under poleMode: skip', () => {
    expect(
      h3CellToMercatorRing(NORTH_POLE_R0, cellToBoundary, {
        poleMode: 'skip',
      }),
    ).toBeNull();
    expect(
      h3CellToMercatorRing(SOUTH_POLE_R2, cellToBoundary, {
        poleMode: 'skip',
      }),
    ).toBeNull();
  });

  it('does not mistake a merely seam-crossing cell for a pole cell', () => {
    for (const hex of [SEAM_R5, SEAM_R3, SF, PENTAGON]) {
      const ring = h3CellToMercatorRing(hex, cellToBoundary, {
        poleMode: 'skip',
      });
      expect(ring).not.toBeNull();
    }
  });
});

// ── Quadbin ─────────────────────────────────────────────────────────────────

/**
 * Independent CARTO Quadbin ENCODER (1:1 port of `crates/stt-build/src/quadbin.rs`,
 * the mirror of the decoder under test), anchored on CARTO's published
 * `(0,0,0) → 0x480fffffffffffff`.
 */
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
  const interleaved = interleave(x) | (interleave(y) << 1n);
  const mortonShift = BigInt(52 - 2 * z);
  const payload = (interleaved << mortonShift) & 0x000f_ffff_ffff_ffffn;
  const fill = mortonShift === 0n ? 0n : (1n << mortonShift) - 1n;
  return QUADBIN_HEADER | (BigInt(z) << 52n) | payload | fill;
}

/** The lon/lat path the deck + three ports take, for the equivalence check. */
function tileToLonLatBounds({ z, x, y }: QuadbinTile): {
  west: number;
  east: number;
  north: number;
  south: number;
} {
  const n = Math.pow(2, z);
  const lng = (xx: number): number => (xx / n) * 360 - 180;
  const lat = (yy: number): number => {
    const r = Math.PI - (2 * Math.PI * yy) / n;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(r) - Math.exp(-r)));
  };
  return { west: lng(x), east: lng(x + 1), north: lat(y), south: lat(y + 1) };
}

describe('quadbinToTile', () => {
  it('matches CARTO reference: (0,0,0) === 0x480fffffffffffff', () => {
    expect(tileToQuadbin(0, 0, 0)).toBe(0x480f_ffff_ffff_ffffn);
    expect(quadbinToTile(0x480f_ffff_ffff_ffffn)).toEqual({ z: 0, x: 0, y: 0 });
  });

  it('round-trips (z, x, y) across the whole zoom band', () => {
    const cases: [number, number, number][] = [
      [0, 0, 0],
      [1, 1, 0],
      [1, 0, 1],
      [4, 5, 11],
      [10, 512, 300],
      [14, 8000, 5400],
      [26, 1234567, 7654321],
    ];
    for (const [z, x, y] of cases) {
      expect(quadbinToTile(tileToQuadbin(z, x, y))).toEqual({ z, x, y });
    }
  });
});

describe('quadbinTileToMercatorBounds', () => {
  it('makes the root cell the whole unit square', () => {
    expect(quadbinTileToMercatorBounds({ z: 0, x: 0, y: 0 })).toEqual({
      west: 0,
      east: 1,
      north: 0,
      south: 1,
    });
  });

  it('agrees with the deck/three lon/lat path to double precision', () => {
    const cases: QuadbinTile[] = [
      { z: 1, x: 0, y: 0 },
      { z: 4, x: 5, y: 11 },
      { z: 9, x: 87, y: 200 },
      { z: 14, x: 8000, y: 5400 },
    ];
    for (const tile of cases) {
      const merc = quadbinTileToMercatorBounds(tile);
      const ll = tileToLonLatBounds(tile);
      const nw = lngLatToMercator(ll.west, ll.north);
      const se = lngLatToMercator(ll.east, ll.south);
      expect(merc.west).toBeCloseTo(nw[0], 12);
      expect(merc.north).toBeCloseTo(nw[1], 12);
      expect(merc.east).toBeCloseTo(se[0], 12);
      expect(merc.south).toBeCloseTo(se[1], 12);
    }
  });
});

describe('quadbinCellToMercatorRing', () => {
  it('emits a closed, positively-wound quad', () => {
    const ring = quadbinCellToMercatorRing(tileToQuadbin(4, 5, 11))!;
    expect(ring.length).toBe(5 * 2);
    expect(ringIsClosed(ring)).toBe(true);
    expect(ringSignedArea2(ring)).toBeGreaterThan(0);
    // Exactly the cell's quad: area = (1/2^z)^2.
    expect(ringSignedArea2(ring) / 2).toBeCloseTo((1 / 16) ** 2, 15);
  });

  it('never leaves the unit square (quadbin cannot cross the seam)', () => {
    for (const [z, x, y] of [
      [0, 0, 0],
      [1, 0, 0],
      [3, 7, 7],
      [12, 0, 4095],
      [12, 4095, 0],
    ] as [number, number, number][]) {
      const [lo, hi] = xRange(
        quadbinCellToMercatorRing(tileToQuadbin(z, x, y))!,
      );
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThanOrEqual(1);
    }
  });

  it('accepts decimal and 0x string ids', () => {
    const id = tileToQuadbin(4, 5, 11);
    const fromBigint = Array.from(quadbinCellToMercatorRing(id)!);
    expect(Array.from(quadbinCellToMercatorRing(id.toString())!)).toEqual(
      fromBigint,
    );
    expect(
      Array.from(quadbinCellToMercatorRing(`0x${id.toString(16)}`)!),
    ).toEqual(fromBigint);
    expect(quadbinCellToMercatorRing('not-a-number')).toBeNull();
    // `BigInt('')` is 0n — an empty id must not decode as the root cell.
    expect(quadbinCellToMercatorRing('')).toBeNull();
    expect(quadbinCellToMercatorRing('   ')).toBeNull();
  });

  it('rejects an out-of-band zoom', () => {
    // Zoom field 27..31 is outside the Quadbin band.
    const bogus = QUADBIN_HEADER | (31n << 52n);
    expect(quadbinCellToMercatorRing(bogus)).toBeNull();
  });

  it('shrinks under coverage without moving the cell', () => {
    const id = tileToQuadbin(6, 20, 30);
    const full = quadbinCellToMercatorRing(id)!;
    const half = quadbinCellToMercatorRing(id, { coverage: 0.5 })!;
    expect(ringSignedArea2(half) / ringSignedArea2(full)).toBeCloseTo(0.25, 12);
  });
});

// ── hexbin ──────────────────────────────────────────────────────────────────

/*
 * VERBATIM from `@deck.gl/aggregation-layers` src/hexagon-layer/hexbin.ts
 * (itself adapted from d3-hexbin) + `@math.gl/web-mercator`'s lngLatToWorld.
 * deck bins in a 512-unit, y-UP common space; the kernel bins in the mercator
 * unit square. Same lattice, different units — that is what these assert.
 */
const DECK_TILE_SIZE = 512;
const DECK_THIRD_PI = Math.PI / 3;
const DECK_DIST_X = 2 * Math.sin(DECK_THIRD_PI);
const DECK_DIST_Y = 1.5;

function deckLngLatToWorld([lng, lat]: [number, number]): [number, number] {
  const lambda2 = (lng * Math.PI) / 180;
  const phi2 = (lat * Math.PI) / 180;
  const x = (DECK_TILE_SIZE * (lambda2 + Math.PI)) / (2 * Math.PI);
  const y =
    (DECK_TILE_SIZE *
      (Math.PI + Math.log(Math.tan(Math.PI / 4 + phi2 * 0.5)))) /
    (2 * Math.PI);
  return [x, y];
}

function deckPointToHexbin(
  [px, py]: [number, number],
  radius: number,
): [number, number] {
  let pj = Math.round((py = py / radius / DECK_DIST_Y));
  let pi = Math.round((px = px / radius / DECK_DIST_X - (pj & 1) / 2));
  const py1 = py - pj;
  if (Math.abs(py1) * 3 > 1) {
    const px1 = px - pi;
    const pi2 = pi + (px < pi ? -1 : 1) / 2;
    const pj2 = pj + (py < pj ? -1 : 1);
    const px2 = px - pi2;
    const py2 = py - pj2;
    if (px1 * px1 + py1 * py1 > px2 * px2 + py2 * py2) {
      pi = pi2 + (pj & 1 ? 1 : -1) / 2;
      pj = pj2;
    }
  }
  return [pi, pj];
}

function deckHexbinCentroid(
  [i, j]: [number, number],
  radius: number,
): [number, number] {
  return [(i + (j & 1) / 2) * radius * DECK_DIST_X, j * radius * DECK_DIST_Y];
}

/** deck's `unitsPerMeter` (math.gl web-mercator), rounded circumference and all. */
function deckUnitsPerMeter(latitude: number): number {
  return DECK_TILE_SIZE / 40.03e6 / Math.cos((latitude * Math.PI) / 180);
}

describe('hexbin lattice vs deck.gl', () => {
  it("bins every sample point into deck.gl's own bin", () => {
    const samples: [number, number][] = [
      [-122.4, 37.78],
      [-0.12, 51.5],
      [139.69, 35.69],
      [151.2, -33.87],
      [-46.63, -23.55],
      [18.42, -33.92],
      [0, 0],
      [179.9, 61.2],
      [-179.9, -61.2],
    ];
    for (const radiusMeters of [250, 1000, 25000]) {
      for (const [lng, lat] of samples) {
        // Both sides resolve the metre radius at the SAME latitude, exactly as
        // a layer must (deck resolves it once at its data centroid).
        const radiusCommon = deckUnitsPerMeter(lat) * radiusMeters;
        const expected = deckPointToHexbin(
          deckLngLatToWorld([lng, lat]),
          radiusCommon,
        );

        const radiusMerc = radiusCommon / DECK_TILE_SIZE;
        const [mx, my] = lngLatToMercator(lng, lat);
        expect(pointToHexBin(mx, my, radiusMerc)).toEqual(expected);
      }
    }
  });

  it("puts hexBinRadiusFromMeters on deck's radiusCommon / 512", () => {
    for (const lat of [0, 23.5, 45, 60, 78]) {
      const ours = hexBinRadiusFromMeters(1000, lat);
      const deck = (deckUnitsPerMeter(lat) * 1000) / DECK_TILE_SIZE;
      // The only difference is the earth circumference constant: deck rounds
      // to 40.03e6 m, this backend uses maplibre's 40 030 228.884 m.
      expect(Math.abs(ours / deck - 1)).toBeLessThan(1e-5);
      expect(ours).toBe(metersToMercatorUnits(1000, lat));
    }
  });

  it('places bin centroids where deck places them', () => {
    const radiusMerc = hexBinRadiusFromMeters(2000, 40);
    const radiusCommon = radiusMerc * DECK_TILE_SIZE;
    for (const [i, j] of [
      [0, 0],
      [3, 4],
      [-7, 5],
      [12, -9],
      [-1, -1],
    ] as [number, number][]) {
      const [cx, cy] = hexBinCentroidMercator(i, j, radiusMerc);
      const [dx, dy] = deckHexbinCentroid([i, j], radiusCommon);
      expect(cx).toBeCloseTo(dx / DECK_TILE_SIZE, 15);
      expect(1 - cy).toBeCloseTo(dy / DECK_TILE_SIZE, 15);
    }
  });

  it('re-bins a bin centroid to that same bin', () => {
    const radiusMerc = hexBinRadiusFromMeters(1500, 35);
    for (const [i, j] of [
      [0, 0],
      [5, 2],
      [-4, 7],
      [9, -3],
    ] as [number, number][]) {
      const [cx, cy] = hexBinCentroidMercator(i, j, radiusMerc);
      expect(pointToHexBin(cx, cy, radiusMerc)).toEqual([i, j]);
    }
  });
});

describe('hexBinKey', () => {
  it('packs and unpacks a bin address losslessly', () => {
    for (const [i, j] of [
      [0, 0],
      [1, -1],
      [-1, 1],
      [1234567, -7654321],
      [(1 << 25) - 1, -(1 << 25)],
    ] as [number, number][]) {
      const key = hexBinKey(i, j);
      expect(Number.isFinite(key)).toBe(true);
      expect(hexBinKeyI(key)).toBe(i);
      expect(hexBinKeyJ(key)).toBe(j);
    }
  });

  it('is NaN outside the packable range instead of colliding', () => {
    expect(hexBinKey(1 << 25, 0)).toBeNaN();
    expect(hexBinKey(0, -(1 << 25) - 1)).toBeNaN();
  });

  it('hexBinKeyForPoint agrees with pointToHexBin + hexBinKey', () => {
    const radiusMerc = hexBinRadiusFromMeters(800, 48);
    for (const [lng, lat] of [
      [2.35, 48.85],
      [2.36, 48.86],
      [-73.98, 40.75],
    ] as [number, number][]) {
      const [mx, my] = lngLatToMercator(lng, lat);
      const [i, j] = pointToHexBin(mx, my, radiusMerc);
      expect(hexBinKeyForPoint(mx, my, radiusMerc)).toBe(hexBinKey(i, j));
    }
  });
});

describe('hexBinToMercatorRing', () => {
  it('is a closed, positively-wound regular hexagon of circumradius r', () => {
    const radiusMerc = hexBinRadiusFromMeters(5000, 30);
    const ring = hexBinToMercatorRing(4, -3, radiusMerc);
    expect(ring.length).toBe(7 * 2);
    expect(ringIsClosed(ring)).toBe(true);
    expect(ringSignedArea2(ring)).toBeGreaterThan(0);
    // Regular hexagon area = (3 sqrt(3) / 2) r^2.
    expect(ringSignedArea2(ring) / 2).toBeCloseTo(
      ((3 * Math.sqrt(3)) / 2) * radiusMerc * radiusMerc,
      18,
    );
    const [cx, cy] = hexBinCentroidMercator(4, -3, radiusMerc);
    for (let i = 0; i < 6; i++) {
      const dx = ring[i * 2] - cx;
      const dy = ring[i * 2 + 1] - cy;
      // Absolute, not relative: the mercator y of a bin is `1 - j·r·DIST_Y`,
      // so every hex vertex carries the ~1e-16 rounding of an order-1
      // subtraction. In ground terms that is ~4 nanometres.
      expect(Math.hypot(dx, dy)).toBeCloseTo(radiusMerc, 15);
    }
  });

  it('tiles the plane: neighbouring bins share their edge length', () => {
    const radiusMerc = hexBinRadiusFromMeters(4000, 10);
    const [ax] = hexBinCentroidMercator(0, 0, radiusMerc);
    const [bx] = hexBinCentroidMercator(1, 0, radiusMerc);
    // Column pitch is 2 sin(60) r — the deck lattice constant.
    expect(bx - ax).toBeCloseTo(2 * Math.sin(Math.PI / 3) * radiusMerc, 18);
  });
});

// ── triangulation ───────────────────────────────────────────────────────────

describe('cellRingToTriangles', () => {
  it('fans a hexagon from its centroid: n triangles, n + 1 vertices', () => {
    const ring = h3CellToMercatorRing(SF, cellToBoundary)!;
    const tri = cellRingToTriangles(ring)!;
    expect(tri.positions.length).toBe(7 * 2); // centroid + 6 ring vertices
    expect(tri.indices.length).toBe(6 * 3);
    // The closing duplicate must NOT become a seventh, degenerate triangle.
    for (let t = 0; t < tri.indices.length; t += 3) {
      const area = triangleArea2(
        tri.positions,
        tri.indices[t],
        tri.indices[t + 1],
        tri.indices[t + 2],
      );
      expect(area).toBeGreaterThan(0);
    }
  });

  it('conserves area exactly (fan area === ring area)', () => {
    for (const ring of [
      h3CellToMercatorRing(SF, cellToBoundary)!,
      h3CellToMercatorRing(PENTAGON, cellToBoundary)!,
      quadbinCellToMercatorRing(tileToQuadbin(5, 9, 12))!,
      hexBinToMercatorRing(2, 3, hexBinRadiusFromMeters(3000, 20)),
    ]) {
      const tri = cellRingToTriangles(ring)!;
      let sum = 0;
      for (let t = 0; t < tri.indices.length; t += 3) {
        sum += triangleArea2(
          tri.positions,
          tri.indices[t],
          tri.indices[t + 1],
          tri.indices[t + 2],
        );
      }
      expect(sum / ringSignedArea2(ring)).toBeCloseTo(1, 9);
    }
  });

  it('treats an open ring and its closed form identically', () => {
    const closed = quadbinCellToMercatorRing(tileToQuadbin(3, 2, 6))!;
    const open = closed.subarray(0, closed.length - 2);
    const a = cellRingToTriangles(closed)!;
    const b = cellRingToTriangles(open)!;
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  });

  it('returns null below three distinct vertices', () => {
    expect(cellRingToTriangles(new Float64Array([0, 0, 1, 1]))).toBeNull();
    expect(
      cellRingToTriangles(new Float64Array([0, 0, 1, 1, 0, 0])),
    ).toBeNull();
  });

  it('keeps every index inside the position buffer', () => {
    const tri = cellRingToTriangles(
      hexBinToMercatorRing(0, 0, hexBinRadiusFromMeters(1000, 0)),
    )!;
    const vertexCount = tri.positions.length >> 1;
    for (const idx of tri.indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(vertexCount);
    }
  });
});

describe('orientRingPositive / ringSignedArea2', () => {
  it('flips a negatively-wound ring and leaves a positive one alone', () => {
    const ccw = new Float64Array([0, 0, 1, 0, 1, 1, 0, 1]);
    const before = ringSignedArea2(ccw);
    expect(orientRingPositive(Float64Array.from(ccw))).toEqual(ccw);
    const reversed = new Float64Array([0, 1, 1, 1, 1, 0, 0, 0]);
    expect(ringSignedArea2(reversed)).toBe(-before);
    expect(ringSignedArea2(orientRingPositive(reversed))).toBe(before);
  });

  it('ignores a trailing closing vertex', () => {
    const open = new Float64Array([0, 0, 1, 0, 1, 1, 0, 1]);
    const closed = new Float64Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0]);
    expect(ringSignedArea2(closed)).toBeCloseTo(ringSignedArea2(open), 15);
  });
});

// ── batch builders ──────────────────────────────────────────────────────────

describe('buildSummaryCellRings', () => {
  const h3Ids = new BigUint64Array([u64(SF), u64(PENTAGON), u64(SEAM_R5)]);

  it('packs one ring per decodable cell with a row mapping', () => {
    const batch = buildSummaryCellRings('h3', h3Ids, undefined, {
      cellToBoundary,
    });
    expect(batch.ringCount).toBe(3);
    expect(Array.from(batch.sourceIndices)).toEqual([0, 1, 2]);
    expect(batch.ringOffsets.length).toBe(4);
    expect(batch.ringOffsets[0]).toBe(0);
    expect(batch.ringOffsets[3]).toBe(batch.positions.length >> 1);
    // Ring 0 is exactly what the single-cell entry point produces.
    const solo = h3CellToMercatorRing(SF, cellToBoundary)!;
    expect(
      Array.from(batch.positions.subarray(0, batch.ringOffsets[1] * 2)),
    ).toEqual(Array.from(solo));
    expect(batch.diagnostics.cells).toBe(3);
    expect(batch.diagnostics.skipped).toBe(0);
    expect(batch.diagnostics.seamCells).toBe(1);
    expect(batch.diagnostics.duplicated).toBe(0);
  });

  it('skips undecodable rows and keeps sourceIndices honest', () => {
    const ids = new BigUint64Array([u64(SF), 0xdeadbeefn, u64(PENTAGON)]);
    const batch = buildSummaryCellRings('h3', ids, undefined, {
      cellToBoundary,
    });
    expect(batch.ringCount).toBe(2);
    expect(Array.from(batch.sourceIndices)).toEqual([0, 2]);
    expect(batch.diagnostics.skipped).toBe(1);
  });

  it('honours the row count and a missing id column', () => {
    const batch = buildSummaryCellRings('h3', h3Ids, 2, { cellToBoundary });
    expect(batch.ringCount).toBe(2);
    expect(
      buildSummaryCellRings('h3', undefined, 0, { cellToBoundary }).ringCount,
    ).toBe(0);
    expect(
      buildSummaryCellRings('quadbin', new BigUint64Array(0)).ringCount,
    ).toBe(0);
  });

  it('throws when the h3 scheme is wired without a resolver', () => {
    expect(() => buildSummaryCellRings('h3', h3Ids)).toThrow(/cellToBoundary/);
  });

  it('emits the ±1 twin for a seam cell under seamMode: duplicate', () => {
    const ids = new BigUint64Array([u64(SF), u64(SEAM_R5)]);
    const batch = buildSummaryCellRings('h3', ids, undefined, {
      cellToBoundary,
      seamMode: 'duplicate',
    });
    expect(batch.ringCount).toBe(3);
    expect(Array.from(batch.sourceIndices)).toEqual([0, 1, 1]);
    expect(batch.diagnostics.duplicated).toBe(1);
    // The twin is the original shifted by exactly -1 in x (it overhung x = 1).
    const start1 = batch.ringOffsets[1];
    const start2 = batch.ringOffsets[2];
    const end2 = batch.ringOffsets[3];
    expect(end2 - start2).toBe(start2 - start1);
    for (let k = 0; k < end2 - start2; k++) {
      expect(batch.positions[(start2 + k) * 2]).toBeCloseTo(
        batch.positions[(start1 + k) * 2] - 1,
        15,
      );
      expect(batch.positions[(start2 + k) * 2 + 1]).toBe(
        batch.positions[(start1 + k) * 2 + 1],
      );
    }
  });

  it('counts pole cells and respects poleMode', () => {
    const ids = new BigUint64Array([u64(NORTH_POLE_R0), u64(SF)]);
    const banded = buildSummaryCellRings('h3', ids, undefined, {
      cellToBoundary,
    });
    expect(banded.ringCount).toBe(2);
    expect(banded.diagnostics.poleCells).toBe(1);
    expect(banded.diagnostics.poleSkipped).toBe(0);

    const skipped = buildSummaryCellRings('h3', ids, undefined, {
      cellToBoundary,
      poleMode: 'skip',
    });
    expect(skipped.ringCount).toBe(1);
    expect(Array.from(skipped.sourceIndices)).toEqual([1]);
    expect(skipped.diagnostics.poleCells).toBe(1);
    expect(skipped.diagnostics.poleSkipped).toBe(1);
    // A pole cell is NOT an undecodable row — keep the two counters separate.
    expect(skipped.diagnostics.skipped).toBe(0);
  });

  it('builds quadbin batches without any resolver', () => {
    const ids = new BigUint64Array([
      tileToQuadbin(4, 5, 11),
      tileToQuadbin(4, 6, 11),
    ]);
    const batch = buildSummaryCellRings('quadbin', ids);
    expect(batch.ringCount).toBe(2);
    expect(batch.diagnostics.seamCells).toBe(0);
    expect(batch.diagnostics.poleCells).toBe(0);
    for (let r = 0; r < batch.ringCount; r++) {
      const start = batch.ringOffsets[r];
      const end = batch.ringOffsets[r + 1];
      expect(end - start).toBe(5);
      expect(
        ringSignedArea2(batch.positions.subarray(start * 2, end * 2)),
      ).toBeGreaterThan(0);
    }
  });
});

describe('triangulateCellRings', () => {
  it('merges a batch into one mesh with a per-vertex row mapping', () => {
    const ids = new BigUint64Array([u64(SF), u64(PENTAGON)]);
    const batch = buildSummaryCellRings('h3', ids, undefined, {
      cellToBoundary,
    });
    const mesh = triangulateCellRings(batch);
    // hexagon (6 + 1) + pentagon (5 + 1) vertices, 6 + 5 triangles.
    expect(mesh.positions.length >> 1).toBe(13);
    expect(mesh.vertexSourceIndex.length).toBe(13);
    expect(mesh.indices.length).toBe(11 * 3);
    expect(Array.from(mesh.vertexSourceIndex)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1,
    ]);
    for (let t = 0; t < mesh.indices.length; t += 3) {
      expect(
        triangleArea2(
          mesh.positions,
          mesh.indices[t],
          mesh.indices[t + 1],
          mesh.indices[t + 2],
        ),
      ).toBeGreaterThan(0);
    }
  });

  it('keeps the duplicated seam ring pointing at its source row', () => {
    const ids = new BigUint64Array([u64(SEAM_R5)]);
    const batch = buildSummaryCellRings('h3', ids, undefined, {
      cellToBoundary,
      seamMode: 'duplicate',
    });
    const mesh = triangulateCellRings(batch);
    expect(batch.ringCount).toBe(2);
    for (const source of mesh.vertexSourceIndex) expect(source).toBe(0);
  });

  it('produces an empty mesh for an empty batch', () => {
    const mesh = triangulateCellRings(
      buildSummaryCellRings('quadbin', undefined),
    );
    expect(mesh.positions.length).toBe(0);
    expect(mesh.indices.length).toBe(0);
    expect(mesh.vertexSourceIndex.length).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import {
  type Cell,
  bitsFor,
  curveBits,
  hilbert2,
  hilbert3,
  morton3,
  linearize,
  orderKey,
  simulateQuery,
  seeks,
  WALKS,
} from '../src/lib/spaceCurve.ts';

const cell = (
  sx: number,
  sy: number,
  tb: number,
  count = 1,
  bytes = 10,
): Cell => ({
  sx,
  sy,
  tb,
  count,
  bytes,
  h2: hilbert2(3, sx, sy),
});

describe('curve math', () => {
  it('bitsFor / curveBits match the Rust ports', () => {
    expect(bitsFor(1)).toBe(0);
    expect(bitsFor(24)).toBe(5);
    expect(bitsFor(2281)).toBe(12);
    // flights-like: 10 space bits dominate 24 buckets; drifters-like: time wins.
    expect(curveBits(10, 24)).toBe(10);
    expect(curveBits(4, 2281)).toBe(12);
  });

  it('hilbert2 is a bijection whose consecutive cells are grid-adjacent', () => {
    const bits = 3;
    const n = 1 << bits;
    const pts: { d: number; x: number; y: number }[] = [];
    const seen = new Set<number>();
    for (let x = 0; x < n; x++)
      for (let y = 0; y < n; y++) {
        const d = hilbert2(bits, x, y);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThan(n * n);
        expect(seen.has(d)).toBe(false);
        seen.add(d);
        pts.push({ d, x, y });
      }
    expect(seen.size).toBe(n * n);
    pts.sort((a, b) => a.d - b.d);
    for (let i = 1; i < pts.length; i++) {
      const m =
        Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
      expect(m).toBe(1);
    }
  });

  it('hilbert3 is a bijection with adjacent consecutive cells; morton3 is a bijection', () => {
    const bits = 3;
    const n = 1 << bits;
    const seenH = new Set<number>();
    const seenM = new Set<number>();
    const pts: { d: number; x: number; y: number; t: number }[] = [];
    for (let x = 0; x < n; x++)
      for (let y = 0; y < n; y++)
        for (let t = 0; t < n; t++) {
          const h = hilbert3(x, y, t, bits);
          const mo = morton3(x, y, t, bits);
          seenH.add(h);
          seenM.add(mo);
          pts.push({ d: h, x, y, t });
        }
    expect(seenH.size).toBe(n * n * n);
    expect(seenM.size).toBe(n * n * n);
    pts.sort((a, b) => a.d - b.d);
    for (let i = 1; i < pts.length; i++) {
      const m =
        Math.abs(pts[i].x - pts[i - 1].x) +
        Math.abs(pts[i].y - pts[i - 1].y) +
        Math.abs(pts[i].t - pts[i - 1].t);
      expect(m).toBe(1);
    }
  });
});

describe('linearize', () => {
  const cells: Cell[] = [];
  for (let x = 0; x < 2; x++)
    for (let y = 0; y < 2; y++)
      for (let t = 0; t < 3; t++) cells.push(cell(x, y, t));

  it('each walk is a permutation of the cells', () => {
    for (const w of WALKS) {
      const out = linearize(cells, w, 1, 3);
      expect(out.length).toBe(cells.length);
      expect(new Set(out).size).toBe(cells.length);
    }
  });

  it("spatial-major keeps a cell's whole timeline contiguous", () => {
    const out = linearize(cells, 'spatial', 1, 3);
    // positions of the (x=0,y=0) column's three time buckets must be consecutive.
    const idx = out
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.sx === 0 && c.sy === 0)
      .map(({ i }) => i)
      .sort((a, b) => a - b);
    expect(idx).toEqual([idx[0], idx[0] + 1, idx[0] + 2]);
  });

  it("time-major keeps one instant's whole map contiguous", () => {
    const out = linearize(cells, 'time', 1, 3);
    const idx = out
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.tb === 1)
      .map(({ i }) => i)
      .sort((a, b) => a - b);
    // 4 map cells at t=1 must be a contiguous block.
    expect(idx.length).toBe(4);
    expect(idx[3] - idx[0]).toBe(3);
  });

  it('orderKey never collides on distinct cells', () => {
    for (const w of WALKS) {
      const keys = new Set(cells.map((c) => orderKey(w, c, 1, 3)));
      expect(keys.size).toBe(cells.length);
    }
  });
});

describe('simulateQuery range coalescing', () => {
  const ordered = Array.from({ length: 10 }, (_, i) => cell(i % 8, 0, 0));
  const hitSet = new Set([ordered[1], ordered[2], ordered[5], ordered[9]]);
  const isHit = (c: Cell) => hitSet.has(c);
  const w = (c: Cell) => c.count;

  it('gap 0 fuses only adjacent hits', () => {
    const r = simulateQuery(ordered, isHit, 0, w);
    expect(r.reads).toBe(3); // [1,2], [5], [9]
    expect(r.weightNeeded).toBe(4);
    expect(r.weightRead).toBe(4); // nothing over-read
  });

  it('a wider gap fuses across small holes and over-reads the gap bytes', () => {
    const r = simulateQuery(ordered, isHit, 2, w);
    expect(r.reads).toBe(2); // [1..5], [9]
    expect(r.weightRead).toBe(6); // 5 cells in [1,5] + 1 at [9]
    expect(r.weightRead).toBeGreaterThan(r.weightNeeded);
  });

  it('a big enough gap collapses to a single read', () => {
    const r = simulateQuery(ordered, isHit, 3, w);
    expect(r.reads).toBe(1);
    expect(r.runs).toEqual([[1, 9]]);
  });
});

describe('seeks', () => {
  it('counts non-neighbour hops', () => {
    // (0,0,0)->(0,0,1) adjacent, ->(3,3,0) a hop, ->(3,3,1) adjacent.
    const ordered = [
      cell(0, 0, 0),
      cell(0, 0, 1),
      cell(3, 3, 0),
      cell(3, 3, 1),
    ];
    expect(seeks(ordered)).toBe(1);
  });
});

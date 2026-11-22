/**
 * Equality helpers for the path-codec suites: a codec layer must decode to
 * EXACTLY what its classic twin decodes to, through both surfaces —
 * `BinaryFeatures` (positions compared as raw IEEE bits) and the
 * `toGeoArrowTable()` hand-off (schema, metadata and every value).
 */

import { expect } from 'vitest';
import type { Table } from 'apache-arrow';
import type { BinaryFeatures } from '../../src/types';

/** A `Float64Array`'s IEEE-754 bit patterns. */
export function bits(a: Float64Array): BigUint64Array {
  return new BigUint64Array(a.buffer, a.byteOffset, a.length);
}

export function expectSameFeatures(a: BinaryFeatures, b: BinaryFeatures): void {
  expect(a.featureCount).toBe(b.featureCount);
  expect(bits(a.positions)).toEqual(bits(b.positions));
  expect(a.positionDimensions ?? 2).toBe(b.positionDimensions ?? 2);
  expect(a.startIndices).toEqual(b.startIndices);
  expect(a.timeOffset).toBe(b.timeOffset);
  expect(a.startTimes).toEqual(b.startTimes);
  expect(a.endTimes).toEqual(b.endTimes);
  expect(a.vertexTimestamps).toEqual(b.vertexTimestamps);
  expect(a.featureIds64).toEqual(b.featureIds64);
  expect(Array.from(a.featureIds)).toEqual(Array.from(b.featureIds));
  expect(a.numericProps).toEqual(b.numericProps);
  expect(a.vertexValues).toEqual(b.vertexValues);
}

/** Column-by-column equality of two decoded GeoArrow hand-off tables. */
export function expectSameTable(a: Table, b: Table): void {
  expect(a.schema.fields.map((f) => `${f.name}:${f.type}`)).toEqual(
    b.schema.fields.map((f) => `${f.name}:${f.type}`),
  );
  for (const f of b.schema.fields) {
    const fa = a.schema.fields.find((x) => x.name === f.name)!;
    expect([...fa.metadata]).toEqual([...f.metadata]);
  }
  expect([...a.schema.metadata]).toEqual([...b.schema.metadata]);
  expect(a.numRows).toBe(b.numRows);
  for (const name of a.schema.fields.map((f) => f.name)) {
    const ca = a.getChild(name)!;
    const cb = b.getChild(name)!;
    for (let i = 0; i < a.numRows; i++) {
      const va = ca.get(i);
      const vb = cb.get(i);
      const flat = (v: unknown): unknown =>
        v && typeof v === 'object' && 'toArray' in (v as object)
          ? Array.from((v as { toArray(): ArrayLike<unknown> }).toArray(), flat)
          : v;
      expect(flat(va)).toEqual(flat(vb));
    }
  }
  // LineString: List<FixedSizeList<2>>; a point layer is FixedSizeList<2>.
  const leaf = (t: Table) => {
    const coords = t.getChild('geometry')!.data[0].children[0];
    return (coords.children[0] ?? coords).values as Float64Array | Int32Array;
  };
  const la = leaf(a);
  const lb = leaf(b);
  expect(la.constructor).toBe(lb.constructor);
  if (la instanceof Float64Array) {
    expect(bits(la)).toEqual(bits(lb as Float64Array));
  } else {
    expect(la).toEqual(lb);
  }
}

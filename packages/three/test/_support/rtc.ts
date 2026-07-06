// @poopdeck.gl/three — test support
// SPDX-License-Identifier: MIT
//
// Two assertions the RTC buffer builders repeat verbatim across ~10 files:
//  - the "no matching features → empty" tail (count/vertexCount 0 + null bbox), and
//  - the "keeps RTC offsets tiny under mercator" invariant (origin carries the
//    huge absolute magnitude while the near/far endpoints stay metre-scale).
// Builder-specific extras (nodeCount, numBuckets, axis, timeA, indices) stay
// inline at each call site — only the shared shell lives here.

import { expect } from 'vitest';

/**
 * Asserts an empty buffer result: whichever of `count`/`vertexCount` the builder
 * exposes is 0, and its bbox is null. Extra empty-state fields (e.g. `nodeCount`,
 * `numBuckets`, `axis`, `timeA.length`) remain the caller's responsibility.
 */
export function expectEmptyBuffers(buf: {
  count?: number;
  vertexCount?: number;
  bbox: unknown;
}): void {
  if (typeof buf.count === 'number') expect(buf.count).toBe(0);
  if (typeof buf.vertexCount === 'number') expect(buf.vertexCount).toBe(0);
  expect(buf.bbox).toBeNull();
}

/**
 * Asserts the mercator RTC contract for a single-feature buffer: one instance,
 * the origin carries a huge absolute mercator x (> 1e6), and the two relative
 * endpoint offsets `a` (source/A, ~0) and `b` (target/B, within a few hundred
 * metres) stay f32-small. Callers pass the concrete offset scalars because the
 * near/far field names differ per builder (posSource/posTarget vs posA/posB).
 */
export function expectRtcMercator(
  buf: { count: number; origin: ArrayLike<number> },
  { a, b }: { a: number; b: number },
): void {
  expect(buf.count).toBe(1);
  expect(Math.abs(buf.origin[0])).toBeGreaterThan(1e6); // huge absolute mercator x
  expect(Math.abs(a)).toBeLessThan(1); // near endpoint is the origin → ~0
  expect(Math.abs(b)).toBeLessThan(500); // far endpoint within a few hundred m
}

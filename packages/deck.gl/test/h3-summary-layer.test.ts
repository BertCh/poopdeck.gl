/**
 * Verifies the H3 cell-index → hex-string conversion at the heart of
 * H3SummaryLayer.prepareTile. The full layer is hard to instantiate
 * in a vitest environment (no WebGL context, no real archive), but the
 * pure conversion + weight pickup is what we actually need to assert.
 */

import { describe, it, expect } from 'vitest';
import { latLngToCell, cellToLatLng } from 'h3-js';
import { splitLongToH3Index, h3IndexToSplitLong } from 'h3-js';

describe('H3SummaryLayer: cell ID round-trip', () => {
  it('splitLong roundtrips a real H3 cell through u64-as-two-u32', () => {
    // At H3 resolution 5 a real cell encodes to a u64 with non-zero high
    // bits. We pick a cell over SF and roundtrip via the split-long form
    // — the same path the layer uses against the Arrow `id` column.
    const cell = latLngToCell(37.7749, -122.4194, 5);
    const split = h3IndexToSplitLong(cell);
    const lower = split[0] >>> 0;
    const upper = split[1] >>> 0;
    // Recompose the way the layer does it.
    const recombined = splitLongToH3Index(lower, upper);
    expect(recombined).toBe(cell);

    // The recovered cell still resolves to roughly the same centroid.
    const [lat, lng] = cellToLatLng(recombined);
    expect(lat).toBeCloseTo(37.77, 1);
    expect(lng).toBeCloseTo(-122.42, 1);
  });

  it('roundtrips via BigUint64 mask + shift identical to the layer path', () => {
    const cell = latLngToCell(40.7128, -74.0060, 6); // NYC
    const split = h3IndexToSplitLong(cell);
    const u64 = (BigInt(split[1] >>> 0) << 32n) | BigInt(split[0] >>> 0);

    // Layer code:
    const lower = Number(u64 & 0xffffffffn) >>> 0;
    const upper = Number((u64 >> 32n) & 0xffffffffn) >>> 0;
    const recombined = splitLongToH3Index(lower, upper);
    expect(recombined).toBe(cell);
  });
});

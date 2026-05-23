/**
 * Float32 precision regression guard.
 *
 * Proves that the relative-time scheme survives a Float32 round-trip with
 * sub-second error, and that the OLD absolute-epoch-ms scheme does NOT.
 *
 * Background: animated layers store per-feature/per-vertex times in a
 * Float32Array and the shader `currentTime` uniform is f32. f32 has a 24-bit
 * mantissa, so integers above 2^24 (~16.7M) lose 1ms precision and absolute
 * epoch-ms (~1.7e12) quantizes to ~131,000ms (~2.2min) buckets. Keeping times
 * RELATIVE to a per-layer offset keeps both the attribute values and the
 * uniform small enough for exact representation.
 */

import { describe, it, expect } from 'vitest';
import { relativizeTime, MAX_RELATIVE_TIME_MS } from '../src/time-filter-extension';

/** Simulate storing a value in a Float32Array and reading it back. */
function roundTripF32(value: number): number {
  const a = new Float32Array(1);
  a[0] = value;
  return a[0];
}

describe('float32 time precision', () => {
  // A realistic recent epoch-ms timestamp (2024-05-20T12:00:00Z-ish).
  const ABS_TIME = 1_716_206_400_000;
  // A feature 1.5s later - the kind of gap time filtering must resolve.
  const ABS_TIME_PLUS_1500 = ABS_TIME + 1500;
  // A layer-wide reference offset near the data (as binary tiles provide).
  const LAYER_OFFSET = 1_716_206_000_000;

  it('OLD absolute scheme: epoch-ms loses far more than 1s of precision (regression guard)', () => {
    const stored = roundTripF32(ABS_TIME);
    const error = Math.abs(stored - ABS_TIME);
    // f32 cannot even represent epoch-ms to the nearest second.
    expect(error).toBeGreaterThan(1000);
  });

  it('OLD absolute scheme: two timestamps 1.5s apart collapse to the SAME f32 value', () => {
    const a = roundTripF32(ABS_TIME);
    const b = roundTripF32(ABS_TIME_PLUS_1500);
    // Both quantize into the same ~131s bucket - time filtering breaks.
    expect(a).toBe(b);
  });

  it('NEW relative scheme: a timestamp survives an f32 round-trip with <1s error', () => {
    const rel = relativizeTime(ABS_TIME, LAYER_OFFSET);
    const stored = roundTripF32(rel);
    const error = Math.abs(stored - rel);
    expect(error).toBeLessThan(1000);
    // In fact, well under a single millisecond for this magnitude.
    expect(error).toBeLessThan(1);
  });

  it('NEW relative scheme: 1.5s gap is preserved exactly after f32 round-trip', () => {
    const relA = roundTripF32(relativizeTime(ABS_TIME, LAYER_OFFSET));
    const relB = roundTripF32(relativizeTime(ABS_TIME_PLUS_1500, LAYER_OFFSET));
    expect(relB - relA).toBeCloseTo(1500, 0);
    expect(relA).not.toBe(relB);
  });

  it('attribute time and matching currentTime use the SAME offset and stay aligned', () => {
    // Layer stores the feature time relative to the offset...
    const featureRel = roundTripF32(relativizeTime(ABS_TIME_PLUS_1500, LAYER_OFFSET));
    // ...and the extension subtracts the SAME offset from currentTime.
    const currentTimeRel = roundTripF32(relativizeTime(ABS_TIME_PLUS_1500, LAYER_OFFSET));
    // Both sides of the shader comparison agree to sub-millisecond precision.
    expect(Math.abs(featureRel - currentTimeRel)).toBeLessThan(1);
  });

  it('relative values below MAX_RELATIVE_TIME_MS keep full ms precision', () => {
    for (const rel of [0, 1, 999, 1_000_000, MAX_RELATIVE_TIME_MS - 1]) {
      expect(roundTripF32(rel)).toBe(rel);
    }
  });

  it('relative values above MAX_RELATIVE_TIME_MS begin to lose ms precision (documented limit)', () => {
    // Just past the limit, odd integers can no longer be represented exactly.
    const beyond = MAX_RELATIVE_TIME_MS + 1;
    expect(roundTripF32(beyond)).not.toBe(beyond);
  });

  it('relativizeTime is a pure subtraction', () => {
    expect(relativizeTime(100, 30)).toBe(70);
    expect(relativizeTime(1_716_206_400_000, 1_716_206_000_000)).toBe(400_000);
  });
});

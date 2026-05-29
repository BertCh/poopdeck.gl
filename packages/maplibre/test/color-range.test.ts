/**
 * `toRgba01` range-normalizer tests.
 *
 * The maplibre adapter historically took constant `color` in 0–1 while its
 * `colorPalette` used 0–255 (and the deck.gl adapter uses 0–255 `Color`). That
 * made a deck.gl-style `[255, 128, 0, 255]` clamp to solid white on maplibre.
 * `toRgba01` auto-detects the range so both conventions work, removing the
 * cross-adapter foot-gun without breaking existing 0–1 callers.
 */

import { describe, it, expect } from 'vitest';
import { toRgba01 } from '../src/base-layer';

describe('toRgba01', () => {
  it('passes through a 0–1 colour unchanged', () => {
    expect(toRgba01([0.31, 0.76, 0.97, 1.0])).toEqual([0.31, 0.76, 0.97, 1.0]);
  });

  it('normalizes a 0–255 (deck.gl-style) colour to 0–1', () => {
    const out = toRgba01([255, 128, 0, 255]);
    expect(out[0]).toBeCloseTo(1.0, 5);
    expect(out[1]).toBeCloseTo(128 / 255, 5);
    expect(out[2]).toBeCloseTo(0, 5);
    expect(out[3]).toBeCloseTo(1.0, 5);
  });

  it('treats pure-white 0–1 [1,1,1,1] as already normalized (not near-black)', () => {
    // The one ambiguous tuple: [1,1,1,1] is white in 0–1 and a transparent
    // near-black in 0–255 (alpha 1/255). Treating it as 0–1 white is correct.
    expect(toRgba01([1, 1, 1, 1])).toEqual([1, 1, 1, 1]);
  });

  it('detects 0–255 from any channel exceeding 1 (incl. alpha)', () => {
    // A fully-opaque dark colour: rgb < 1 but alpha 255 ⇒ 0–255 convention.
    const out = toRgba01([0, 0, 0, 255]);
    expect(out).toEqual([0, 0, 0, 1]);
  });
});

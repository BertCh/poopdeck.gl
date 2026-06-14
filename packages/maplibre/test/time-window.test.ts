/**
 * Parity tests for the time-window shader math.
 *
 * The whole point of `shaders/time-window.glsl.ts` is that the maplibre
 * adapter computes alpha for a `(startTime, endTime, currentTime,
 * timeWindow, fadeIn, fadeOut)` triplet *bit-identically* to
 * @poopdeck.gl/layers's TimeFilterExtension. We replicate the deck.gl formula
 * in-line (so the test is self-contained and doesn't import from deck.gl)
 * and assert each branch matches.
 */

import { describe, it, expect } from 'vitest';
import {
  timeWindowAlphaJS,
  trailAlphaJS,
} from '../src/shaders/time-window.glsl';

/**
 * Reference re-implementation of the deck.gl TimeFilterExtension window
 * branch. Pulled from packages/layers/src/time-filter-extension.js, kept
 * verbatim. If this ever drifts, the maplibre adapter and the deck.gl
 * adapter no longer agree and we want a loud test failure.
 */
function deckWindowAlpha(
  instanceStartTime: number,
  instanceEndTime: number,
  currentTime: number,
  timeWindow: number,
  fadeIn: number,
  fadeOut: number,
): number {
  const windowHalf = timeWindow / 2;
  const timeStart = currentTime - windowHalf;
  const timeEnd = currentTime + windowHalf;
  let vTimeAlpha = 1.0;
  if (instanceEndTime < timeStart || instanceStartTime > timeEnd) {
    return 0;
  }
  if (vTimeAlpha > 0 && fadeIn > 0) {
    const age = timeEnd - instanceStartTime;
    if (age < fadeIn) vTimeAlpha *= age / fadeIn;
  }
  if (vTimeAlpha > 0 && fadeOut > 0) {
    const remaining = instanceEndTime - timeStart;
    if (remaining < fadeOut) vTimeAlpha *= remaining / fadeOut;
  }
  return Math.max(0, Math.min(1, vTimeAlpha));
}

/** Reference deck.gl trail branch. */
function deckTrailAlpha(
  vertexTime: number,
  currentTime: number,
  trailLength: number,
): number {
  if (trailLength <= 0) return 1;
  const trailStart = currentTime - trailLength;
  if (vertexTime > currentTime) return 0;
  if (vertexTime < trailStart) return 0;
  const age = currentTime - vertexTime;
  return Math.max(0, Math.min(1, 1 - age / trailLength));
}

describe('window-mode parity vs @poopdeck.gl/layers TimeFilterExtension', () => {
  const currentTime = 1000;
  const timeWindow = 200; // half = 100, so window = [900, 1100]

  it('matches when feature is fully inside the window', () => {
    const ml = timeWindowAlphaJS(950, 1050, 900, 1100, 0, 0);
    const dk = deckWindowAlpha(950, 1050, currentTime, timeWindow, 0, 0);
    expect(ml).toBe(dk);
    expect(ml).toBe(1);
  });

  it('matches when feature is entirely before the window', () => {
    const ml = timeWindowAlphaJS(0, 800, 900, 1100, 0, 0);
    const dk = deckWindowAlpha(0, 800, currentTime, timeWindow, 0, 0);
    expect(ml).toBe(dk);
    expect(ml).toBe(0);
  });

  it('matches when feature is entirely after the window', () => {
    const ml = timeWindowAlphaJS(1200, 1300, 900, 1100, 0, 0);
    const dk = deckWindowAlpha(1200, 1300, currentTime, timeWindow, 0, 0);
    expect(ml).toBe(dk);
    expect(ml).toBe(0);
  });

  it('matches across fade-in ramp at the leading edge', () => {
    const fadeIn = 50;
    // age = windowEnd - startTime; startTime = 1080 → age = 20 → 20/50 = 0.4.
    const ml = timeWindowAlphaJS(1080, 1090, 900, 1100, fadeIn, 0);
    const dk = deckWindowAlpha(1080, 1090, currentTime, timeWindow, fadeIn, 0);
    expect(ml).toBeCloseTo(dk, 10);
    expect(ml).toBeCloseTo(0.4, 8);
  });

  it('matches across fade-out ramp at the trailing edge', () => {
    const fadeOut = 50;
    // remaining = endTime - windowStart; endTime=910 → remaining=10 → 10/50 = 0.2.
    const ml = timeWindowAlphaJS(800, 910, 900, 1100, 0, fadeOut);
    const dk = deckWindowAlpha(800, 910, currentTime, timeWindow, 0, fadeOut);
    expect(ml).toBeCloseTo(dk, 10);
    expect(ml).toBeCloseTo(0.2, 8);
  });

  it('matches when both fade-in and fade-out apply simultaneously', () => {
    // Very short feature inside the window: both edges apply.
    const fadeIn = 30;
    const fadeOut = 40;
    const ml = timeWindowAlphaJS(1085, 1095, 900, 1100, fadeIn, fadeOut);
    const dk = deckWindowAlpha(1085, 1095, currentTime, timeWindow, fadeIn, fadeOut);
    expect(ml).toBeCloseTo(dk, 10);
  });

  it('agrees on a randomized sweep across the parameter space', () => {
    // Sample 200 cases; each must match within float epsilon.
    let rng = 1;
    const next = () => {
      // tiny LCG so the test is deterministic without depending on Math.random
      rng = (rng * 1103515245 + 12345) & 0x7fffffff;
      return rng / 0x7fffffff;
    };
    for (let i = 0; i < 200; i++) {
      const start = next() * 2000;
      const dur = next() * 500 + 1;
      const end = start + dur;
      const cur = next() * 2000;
      const win = next() * 1000 + 1;
      const fi = next() * 200;
      const fo = next() * 200;
      const half = win / 2;
      const ml = timeWindowAlphaJS(start, end, cur - half, cur + half, fi, fo);
      const dk = deckWindowAlpha(start, end, cur, win, fi, fo);
      expect(ml).toBeCloseTo(dk, 8);
    }
  });
});

describe('trail-mode parity vs @poopdeck.gl/layers TimeFilterExtension', () => {
  it('matches when vertex is inside the trail', () => {
    const ml = trailAlphaJS(900, 1000, 200, 1);
    const dk = deckTrailAlpha(900, 1000, 200);
    expect(ml).toBeCloseTo(dk, 10);
    expect(ml).toBeCloseTo(0.5, 8);
  });

  it('matches when vertex is in the future (>currentTime)', () => {
    const ml = trailAlphaJS(1500, 1000, 200, 1);
    const dk = deckTrailAlpha(1500, 1000, 200);
    expect(ml).toBe(dk);
    expect(ml).toBe(0);
  });

  it('matches when vertex is older than trailLength', () => {
    const ml = trailAlphaJS(500, 1000, 200, 1);
    const dk = deckTrailAlpha(500, 1000, 200);
    expect(ml).toBe(dk);
    expect(ml).toBe(0);
  });

  it('treats trailLength=0 as always-on (deck.gl reference also returns 1.0)', () => {
    const ml = trailAlphaJS(500, 1000, 0, 1);
    const dk = deckTrailAlpha(500, 1000, 0);
    expect(ml).toBe(dk);
    expect(ml).toBe(1);
  });
});

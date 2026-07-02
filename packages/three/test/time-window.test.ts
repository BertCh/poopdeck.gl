// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Time-window vocabulary bridge (renderer parity, audit Theme 4).
 *
 * Every three layer routes its time-filter options through `resolveTimeWindow`,
 * so this pins the deck/maplibre full-width ↔ three half-width conversion and
 * the documented alias precedence in one place.
 */

import { describe, it, expect } from 'vitest';
import { resolveTimeWindow } from '../src/lib/time-window';

describe('resolveTimeWindow — full-width → half-width conversion', () => {
  it('converts deck/maplibre full-width timeWindow to windowHalf = timeWindow / 2', () => {
    // The canonical case from the audit: a 1-day full window.
    expect(resolveTimeWindow({ timeWindow: 86_400_000 })).toEqual({
      windowHalf: 43_200_000,
      fadeIn: 0,
      fadeOut: 0,
    });
  });

  it('maps fadeInDuration / fadeOutDuration to fadeIn / fadeOut', () => {
    expect(
      resolveTimeWindow({
        timeWindow: 1000,
        fadeInDuration: 120,
        fadeOutDuration: 80,
      }),
    ).toEqual({ windowHalf: 500, fadeIn: 120, fadeOut: 80 });
  });

  it('falls back to the per-layer default when neither timeWindow nor windowHalf is set', () => {
    expect(resolveTimeWindow({}, 250)).toEqual({
      windowHalf: 250,
      fadeIn: 0,
      fadeOut: 0,
    });
    // Default 0 (instantaneous) when omitted.
    expect(resolveTimeWindow({})).toEqual({ windowHalf: 0, fadeIn: 0, fadeOut: 0 });
  });
});

describe('resolveTimeWindow — alias precedence (lower-level three-native wins)', () => {
  it('windowHalf wins over timeWindow when both are supplied', () => {
    expect(resolveTimeWindow({ timeWindow: 86_400_000, windowHalf: 250 }).windowHalf).toBe(
      250,
    );
  });

  it('fadeIn / fadeOut win over fadeInDuration / fadeOutDuration', () => {
    const r = resolveTimeWindow({
      fadeInDuration: 1000,
      fadeOutDuration: 1000,
      fadeIn: 10,
      fadeOut: 20,
    });
    expect(r.fadeIn).toBe(10);
    expect(r.fadeOut).toBe(20);
  });

  it('honors an explicit windowHalf of 0 over timeWindow (0 is a real value, not "unset")', () => {
    // Guards the nullish-coalescing choice: windowHalf:0 must NOT fall through
    // to timeWindow.
    expect(resolveTimeWindow({ timeWindow: 5000, windowHalf: 0 }).windowHalf).toBe(0);
  });
});

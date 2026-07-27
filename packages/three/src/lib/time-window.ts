// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Time-window vocabulary bridge for renderer parity.
 *
 * deck's `TimeFilterExtension` and the maplibre adapter both expose a
 * FULL-width `timeWindow` (ms) plus `fadeInDuration` / `fadeOutDuration`. The
 * Three layers filter internally against a HALF-width `windowHalf` and
 * `fadeIn` / `fadeOut`. Without a bridge, `timeWindow: 86_400_000` copied from a
 * deck demo onto a three layer is an unknown prop → a silent fall-back to the
 * default window (a 2× magnitude trap).
 *
 * {@link resolveTimeWindow} therefore lets every three layer ALSO accept the
 * deck/maplibre full-width vocabulary, converting exactly as deck does
 * (`windowHalf = timeWindow / 2`, `fadeIn = fadeInDuration`), while the
 * three-native `windowHalf` / `fadeIn` / `fadeOut` keep working as documented
 * lower-level aliases.
 *
 * Precedence when BOTH forms are supplied: the lower-level three-native knob
 * wins (`windowHalf` over `timeWindow`, `fadeIn` over `fadeInDuration`,
 * `fadeOut` over `fadeOutDuration`) — it is the more explicit control, and this
 * keeps existing three callers byte-identical even if they later also pass the
 * full-width name.
 */

import { resolveTimeFilterParams } from '@poopdeck.gl/core/time-filter';

export interface ThreeTimeWindowOptions {
  /**
   * FULL-width time-filter window in ms (deck `TimeFilterExtension` /
   * maplibre `timeWindow` parity). Converted internally to
   * `windowHalf = timeWindow / 2`. Ignored if {@link windowHalf} is set.
   */
  timeWindow?: number;
  /**
   * Leading-edge fade ramp in ms (deck/maplibre `fadeInDuration` parity).
   * Ignored if the lower-level {@link fadeIn} is set.
   */
  fadeInDuration?: number;
  /**
   * Trailing-edge fade ramp in ms (deck/maplibre `fadeOutDuration` parity).
   * Ignored if the lower-level {@link fadeOut} is set.
   */
  fadeOutDuration?: number;
  /**
   * Lower-level HALF-width window in ms (three-native). Takes precedence over
   * {@link timeWindow} when both are supplied.
   */
  windowHalf?: number;
  /**
   * Lower-level leading-edge fade in ms (three-native). Takes precedence over
   * {@link fadeInDuration} when both are supplied.
   */
  fadeIn?: number;
  /**
   * Lower-level trailing-edge fade in ms (three-native). Takes precedence over
   * {@link fadeOutDuration} when both are supplied.
   */
  fadeOut?: number;
}

/** Resolved half-width filter params consumed by the TSL time-filter. */
export interface ResolvedTimeWindow {
  windowHalf: number;
  fadeIn: number;
  fadeOut: number;
}

/**
 * Resolve the {@link ThreeTimeWindowOptions} vocabulary into the internal
 * half-width params. `defaultWindowHalf` is the layer's own default (used only
 * when neither `windowHalf` nor `timeWindow` is supplied).
 */
export function resolveTimeWindow(
  o: ThreeTimeWindowOptions,
  defaultWindowHalf = 0,
): ResolvedTimeWindow {
  // Delegate to the shared kernel resolver (one copy across backends). With no
  // `softDefaultFraction` policy the fades default to 0 and half-width wins over
  // full-width, which is exactly the three-native semantics.
  const p = resolveTimeFilterParams(o, { defaultWindowHalf });
  return {
    windowHalf: p.windowHalf ?? 0,
    fadeIn: p.fadeIn ?? 0,
    fadeOut: p.fadeOut ?? 0,
  };
}

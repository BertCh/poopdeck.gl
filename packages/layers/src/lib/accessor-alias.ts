// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * Accessor-named prop aliases.
 *
 * Upstream deck.gl styles through `getFillColor`/`getRadius`/`getColor`-style
 * accessors; the STT layers style through constant-or-column-name props
 * (`fillColor`, `pathColor`, …) because tiles arrive as binary Arrow columns
 * and per-feature JS accessors never run. To reconcile the vocabularies, each
 * layer accepts the upstream accessor NAME as an alias of its legacy prop —
 * with the SAME value domain (a constant or a property-column-name string,
 * NOT a function).
 *
 * Resolution contract:
 * - alias set (non-null) → alias wins;
 * - alias unset → legacy prop;
 * - alias is a function (an upstream-style accessor) → warn once and fall
 *   back to the legacy prop / constant default — never crash. Function
 *   accessors cannot run against binary tiles.
 *
 * The resolved value feeds the same style digests as the legacy prop, so an
 * alias change invalidates cached tiles/sublayers exactly like a legacy-prop
 * change.
 */

import { warnOnce } from './log.js';
import type { Color } from '@deck.gl/core';

/**
 * Value domain of color-accessor aliases (`getFillColor`, `getColor`,
 * `getLineColor`): a constant {@link Color} or a property-column name.
 * The function member exists only so upstream-shaped code compiles — a
 * function value warns once at runtime and is ignored.
 */
export type ColorAccessorValue = Color | string | ((d: unknown) => unknown);

/**
 * Value domain of numeric-accessor aliases (`getRadius`, `getWidth`,
 * `getElevation`): a constant number or a property-column name. Function
 * values warn once and are ignored (see {@link ColorAccessorValue}).
 */
export type NumericAccessorValue = number | string | ((d: unknown) => unknown);

/**
 * Value domain of the heatmap `getWeight` alias: a property-column name.
 * Function values warn once and are ignored.
 */
export type WeightAccessorValue = string | ((d: unknown) => unknown);

/**
 * Resolve an accessor-named alias against its legacy prop. Returns the alias
 * value when set, the legacy value otherwise; a function-valued alias warns
 * once (per layer+prop) and falls back to the legacy value.
 */
export function resolveAccessorAlias<T>(
  layerName: string,
  aliasName: string,
  aliasValue: T | ((d: unknown) => unknown) | null | undefined,
  legacyValue: T,
): T {
  if (aliasValue === null || aliasValue === undefined) return legacyValue;
  if (typeof aliasValue === 'function') {
    warnOnce(
      `${layerName}:${aliasName}:functionAccessor`,
      `[${layerName}] ${aliasName} received a function accessor. STT tiles ` +
        'are binary columns — per-feature accessors cannot run. Pass a ' +
        'constant or a property-column name instead; falling back to the ' +
        'legacy prop / default.',
    );
    return legacyValue;
  }
  return aliasValue as T;
}

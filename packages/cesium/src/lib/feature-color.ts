// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Per-feature colour dispatch for the Cesium polyline/trip layers — the same
 * constant / categorical / ramp trichotomy three's buffer builders use, with
 * every scalar lookup delegated to the kernel (`core/style`
 * `resolveCategoryColor` / `rampColorAt`). Pure (no Cesium import).
 */

import type { BinaryFeatures } from '@poopdeck.gl/core';
import {
  NULL_CATEGORY_INDEX,
  resolveCategoryColor,
  rampColorAt,
  type RGBA255,
} from '@poopdeck.gl/core/style';

/** Colour mode for a per-feature (one colour per instance) Cesium layer. */
export type FeatureColorMode =
  | { type: 'constant'; color: RGBA255 }
  | {
      type: 'categorical';
      /** Categorical property name in `binary.categoricalProps`. */
      property: string;
      colorMapping?: Record<string, RGBA255> | null;
      /** Colour for unmapped / NULL categories. */
      fallback: RGBA255;
    }
  | {
      type: 'ramp';
      /** Numeric property name in `binary.numericProps`. */
      property: string;
      domain: readonly [number, number];
      range: readonly RGBA255[];
      /** Colour when the property is absent. */
      fallback: RGBA255;
    };

/** Resolve feature `f`'s base colour (0–255 channels) under `mode`. */
export function featureColor(
  b: BinaryFeatures,
  f: number,
  mode: FeatureColorMode,
): RGBA255 {
  if (mode.type === 'constant') return mode.color;
  if (mode.type === 'ramp') {
    const col = b.numericProps[mode.property];
    return col ? rampColorAt(col[f], mode.domain, mode.range) : mode.fallback;
  }
  const cat = b.categoricalProps[mode.property];
  const label =
    cat && cat.indices[f] !== NULL_CATEGORY_INDEX
      ? cat.categories[cat.indices[f]]
      : undefined;
  return resolveCategoryColor(label, mode.colorMapping, mode.fallback);
}

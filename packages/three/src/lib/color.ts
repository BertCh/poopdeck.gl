// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Per-feature colour resolution, mirroring the showcase's deck `colorMapping`
 * convention: a categorical property (e.g. `height_band`, `seg_class`,
 * `category`, `map_layer`) is looked up in a `{ categoryLabel → RGBA(0–255) }`
 * map, falling back to a default colour. Surfel/point RGB columns bypass this.
 *
 * Output is always packed **0..1 float RGBA** ready for a Three vertex attribute.
 *
 * The categorical / ramp algorithms now live in the framework-free
 * `@poopdeck.gl/core/style` kernel (Phase 2 dedup — see
 * docs/roadmap/renderer-abstraction-2026-06.md); the functions below are thin
 * three-side adapters that preserve three's exact public API (mutable `RGBA`,
 * `.mapping`/`.fallback` spec shapes, f32 0..1 output). `expandRgbColumns` keeps
 * its own local body because its alpha semantics differ (it writes the 0..1
 * `alpha` param directly into the A channel).
 */

import type { BinaryFeatures } from '@poopdeck.gl/core';
import * as core from '@poopdeck.gl/core/style';

export type RGBA = [number, number, number, number];

/** Map a category label through `mapping`, falling back to `fallback`. */
export function resolveCategoryColor(
  label: string | undefined,
  mapping: Record<string, RGBA>,
  fallback: RGBA,
): RGBA {
  return core.resolveCategoryColor(label, mapping, fallback) as RGBA;
}

export interface CategoricalColorSpec {
  /** Categorical property name in `binary.categoricalProps`. */
  property: string;
  /** `{ categoryLabel → [r,g,b,a] (0–255) }`. */
  mapping: Record<string, RGBA>;
  /** Colour for null / unmapped categories. */
  fallback: RGBA;
}

/**
 * Expand a categorical property into a per-feature `Float32Array` RGBA (0..1).
 * If the property is absent, every feature gets `fallback`.
 */
export function expandCategoricalColors(
  binary: BinaryFeatures,
  spec: CategoricalColorSpec,
): Float32Array {
  return core.expandCategoricalColors(
    binary,
    {
      property: spec.property,
      colorMapping: spec.mapping,
      colorMappingDefault: spec.fallback,
      onMissing: 'fill',
    },
    'f32',
  ) as Float32Array;
}

/** Expand three RGB numeric columns (0–255) into per-feature `Float32Array` RGBA (0..1). */
export function expandRgbColumns(
  binary: BinaryFeatures,
  columns: [string, string, string],
  alpha = 1,
  fallback: RGBA = [200, 205, 215, 255],
): Float32Array {
  const count = binary.featureCount;
  const out = new Float32Array(count * 4);
  const r = binary.numericProps[columns[0]];
  const g = binary.numericProps[columns[1]];
  const b = binary.numericProps[columns[2]];
  for (let i = 0; i < count; i++) {
    if (r && g && b) {
      out[i * 4] = r[i] / 255;
      out[i * 4 + 1] = g[i] / 255;
      out[i * 4 + 2] = b[i] / 255;
    } else {
      out[i * 4] = fallback[0] / 255;
      out[i * 4 + 1] = fallback[1] / 255;
      out[i * 4 + 2] = fallback[2] / 255;
    }
    out[i * 4 + 3] = alpha;
  }
  return out;
}

/**
 * Sample a multi-stop colour ramp. `value` is mapped through `domain` to `[0,1]`
 * (clamped), then linearly interpolated across the evenly-spaced `range` stops —
 * the Three analogue of deck's continuous `getColor` ramp (e.g. drifters SST,
 * earthquake magnitude). Returns 0–255 RGBA.
 */
export function rampColorAt(value: number, domain: [number, number], range: RGBA[]): RGBA {
  return core.rampColorAt(value, domain, range) as RGBA;
}

export interface RampColorSpec {
  /** Numeric property name in `binary.numericProps`. */
  property: string;
  /** `[min, max]` value range mapped to the ramp's ends. */
  domain: [number, number];
  /** Evenly-spaced gradient stops (≥1), each `[r,g,b,a]` (0–255). */
  range: RGBA[];
  /** Colour when the property is absent. */
  fallback: RGBA;
}

/**
 * Expand a numeric property into a per-feature `Float32Array` RGBA (0..1) via the
 * continuous {@link rampColorAt} ramp. If the property is absent, every feature
 * gets `fallback`.
 */
export function expandRampColors(binary: BinaryFeatures, spec: RampColorSpec): Float32Array {
  return core.expandRampColors(binary, spec, 'f32') as Float32Array;
}

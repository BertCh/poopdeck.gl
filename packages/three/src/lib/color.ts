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
 */

import type { BinaryFeatures } from '@poopdeck.gl/core';

export type RGBA = [number, number, number, number];

const NULL_INDEX = 0xffff;

/** Map a category label through `mapping`, falling back to `fallback`. */
export function resolveCategoryColor(
  label: string | undefined,
  mapping: Record<string, RGBA>,
  fallback: RGBA,
): RGBA {
  if (label !== undefined) {
    const c = mapping[label];
    if (c) return c;
  }
  return fallback;
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
  const count = binary.featureCount;
  const out = new Float32Array(count * 4);
  const cat = binary.categoricalProps[spec.property];
  for (let i = 0; i < count; i++) {
    let rgba: RGBA;
    if (cat) {
      const idx = cat.indices[i];
      const label = idx === NULL_INDEX ? undefined : cat.categories[idx];
      rgba = resolveCategoryColor(label, spec.mapping, spec.fallback);
    } else {
      rgba = spec.fallback;
    }
    out[i * 4] = rgba[0] / 255;
    out[i * 4 + 1] = rgba[1] / 255;
    out[i * 4 + 2] = rgba[2] / 255;
    out[i * 4 + 3] = rgba[3] / 255;
  }
  return out;
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
  if (range.length === 0) return [0, 0, 0, 255];
  if (range.length === 1) return range[0];
  const [lo, hi] = domain;
  const t = hi > lo ? Math.min(1, Math.max(0, (value - lo) / (hi - lo))) : 0;
  const scaled = t * (range.length - 1);
  const i = Math.min(range.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = range[i];
  const b = range[i + 1];
  const aa = a[3] ?? 255;
  const ba = b[3] ?? 255;
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
    aa + (ba - aa) * f,
  ];
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
  const count = binary.featureCount;
  const out = new Float32Array(count * 4);
  const col = binary.numericProps[spec.property];
  for (let i = 0; i < count; i++) {
    const rgba = col ? rampColorAt(col[i], spec.domain, spec.range) : spec.fallback;
    out[i * 4] = rgba[0] / 255;
    out[i * 4 + 1] = rgba[1] / 255;
    out[i * 4 + 2] = rgba[2] / 255;
    out[i * 4 + 3] = (rgba[3] ?? 255) / 255;
  }
  return out;
}

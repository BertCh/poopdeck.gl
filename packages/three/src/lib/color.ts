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
 * The categorical / ramp algorithms live in the framework-free
 * `@poopdeck.gl/core/style` kernel, one copy shared by every backend (see
 * docs/roadmap/renderer-architecture.md); the functions below are thin
 * three-side adapters that preserve three's exact public API (mutable `RGBA`,
 * `.mapping`/`.fallback` spec shapes, f32 0..1 output). `expandRgbColumns` keeps
 * its own local body because its alpha semantics differ (it writes the 0..1
 * `alpha` param directly into the A channel).
 */

import type { BinaryFeatures } from '@poopdeck.gl/core';
import * as core from '@poopdeck.gl/core/style';

export type RGBA = [number, number, number, number];

/**
 * One sRGB channel (0..1) → linear-light (0..1) — the CPU mirror of the
 * `srgbToWorking` TSL node (`../tsl/color-space.ts`), which carries the full
 * rationale: STT colours are authored as sRGB bytes, and Three's output pass
 * re-encodes linear→sRGB, so a value handed over undecoded is encoded twice and
 * washes out toward white.
 *
 * The TSL materials convert in the shader (deck-parity interpolation); the few
 * layers that shade through a classic `vertexColors` material have no colour
 * node to hook, so they call this once per cell/feature — NOT once per vertex —
 * as they pack their colour buffer. Same transfer function as three's
 * `sRGBTransferEOTF`, so the two paths agree bit-for-bit within f32.
 *
 * Feed it whatever the layer intends to SEE, premultiplied fade included: the
 * output OETF inverts this exactly, so `srgbToLinear(c * alpha)` lands `c *
 * alpha` on screen, which is what those layers draw today.
 */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

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
export function rampColorAt(
  value: number,
  domain: [number, number],
  range: RGBA[],
): RGBA {
  return core.rampColorAt(value, domain, range) as RGBA;
}

/**
 * The one ramp `property` that names a PER-VERTEX channel instead of a
 * per-feature `numericProps` column — deck's `gradientProperty` sentinel (see
 * `AnimatedTripsLayer.gradientValuesFor`). It selects
 * `BinaryFeatures.vertexValues`: one scalar per path vertex (drifter SST, storm
 * temperature), which is what shades a single track along its length rather
 * than flat.
 */
export const VERTEX_VALUES_CHANNEL = 'vertexValues';

/**
 * The per-vertex scalar array a ramp mode names, or `null` when the ramp is an
 * ordinary per-feature column (or the channel is absent / short on this tile,
 * in which case the caller falls back to the per-feature path).
 *
 * `vertexValues` lives on `BinaryFeatures` itself, NOT in `numericProps` — a
 * ramp that looked it up by name found nothing and painted the whole archive
 * one flat fallback colour. Length-guarded exactly like the `vertexTimestamps`
 * lookups next to the call sites.
 */
export function vertexRampValues(
  binary: BinaryFeatures,
  property: string,
  totalVerts: number,
): Float32Array | null {
  if (property !== VERTEX_VALUES_CHANNEL) return null;
  const values = binary.vertexValues;
  return values && values.length >= totalVerts ? values : null;
}

/**
 * Ramp colour for one scalar, with deck's documented NaN contract: a vertex or
 * feature carrying no value (`NaN` — a drifter fix with no SST reading) takes
 * `fallback` (deck's `colorMappingDefault`) rather than clamping onto the
 * ramp's low stop. Guarding here also keeps `NaN` out of {@link rampColorAt},
 * whose bucket index would come out `NaN` and read past the stop list.
 */
export function rampOrFallback(
  value: number,
  domain: [number, number],
  range: RGBA[],
  fallback: RGBA,
): RGBA {
  return Number.isFinite(value) ? rampColorAt(value, domain, range) : fallback;
}

/**
 * Write one vertex's ramp colour into slot `i` of a packed 0..1 RGBA
 * `Float32Array` — the per-endpoint writer for the along-track gradient shared
 * by the trip and line builders.
 */
export function writeVertexRampColor(
  out: Float32Array,
  i: number,
  value: number,
  spec: { domain: [number, number]; range: RGBA[]; fallback: RGBA },
): void {
  const c = rampOrFallback(value, spec.domain, spec.range, spec.fallback);
  const o = i * 4;
  out[o] = c[0] / 255;
  out[o + 1] = c[1] / 255;
  out[o + 2] = c[2] / 255;
  out[o + 3] = (c[3] ?? 255) / 255;
}

export interface RampColorSpec {
  /**
   * Numeric property name in `binary.numericProps`, or
   * {@link VERTEX_VALUES_CHANNEL} for the per-vertex scalar channel (the
   * line/trip builders resolve that one per vertex; see
   * {@link vertexRampValues}).
   */
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
export function expandRampColors(
  binary: BinaryFeatures,
  spec: RampColorSpec,
): Float32Array {
  return core.expandRampColors(binary, spec, 'f32') as Float32Array;
}

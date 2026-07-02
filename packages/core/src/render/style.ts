// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * STT styling kernel — the framework-free color-resolution the renderer backends
 * share. This collapses FOUR hand-copied implementations that had already
 * drifted (see docs/roadmap/renderer-abstraction-2026-06.md §1.4 #2):
 *   - three `lib/color.ts`            (Float32 0..1 output, fill-on-missing)
 *   - maplibre `base-layer.ts`        (Uint8 output, keyed-OR-palette, null-on-missing)
 *   - deck `animated-point-layer.ts`  (Uint8 output, keyed-only; GPU palette stays deck-side)
 *   - three `box-tracks.ts`           (scalar resolveColor)
 *
 * The single `expandCategoricalColors` is a SUPERSET: the `out` argument absorbs
 * the u8-vs-f32 split, and `onMissing` / `requireMappingOrPalette` / the optional
 * positional `palette` reproduce each call site's exact behavior so nothing
 * changes on screen. `colorMappingDefault` is a PER-CALL argument on purpose —
 * it is legitimately per-layer (deck point transparent, deck path grey, three
 * box its own); unifying it to one value would regress deck's own path layer.
 *
 * deck's GPU `CategoryColorExtension` fast path (palette texture sampled by
 * `instanceCategoryIndex`) is NOT part of this kernel — only the palette DATA and
 * the category-index attribute builder are shared; the CPU path here is deck's
 * `colorMapping` fallback, not its hot path.
 */

import type { BinaryFeatures } from '../types';

/** RGBA in the 0–255 int range (user-supplied palettes / colorMapping values). */
export type RGBA255 = readonly [number, number, number, number];

/** Sentinel category index meaning "no category" in `categoricalProps.indices`. */
export const NULL_CATEGORY_INDEX = 0xffff;

/** Output element type: `'u8'` → Uint8Array 0–255, `'f32'` → Float32Array 0..1. */
export type ColorOut = 'u8' | 'f32';

/**
 * Map a category label through `mapping`, falling back to `fallback`. A `null`/
 * `undefined`/empty label (unmapped or NULL category) resolves to `fallback`.
 * The shared scalar lookup behind three's `resolveCategoryColor` and box-tracks'
 * `resolveColor`.
 */
export function resolveCategoryColor(
  label: string | undefined,
  mapping: Record<string, RGBA255> | null | undefined,
  fallback: RGBA255,
): RGBA255 {
  if (label != null && label !== '' && mapping) {
    const c = mapping[label];
    if (c) return c;
  }
  return fallback;
}

export interface CategoricalColorSpec {
  /** Categorical property name in `binary.categoricalProps`. */
  property: string;
  /** `{ categoryLabel → [r,g,b,a] (0–255) }`. Empty/absent ⇒ no keyed lookup. */
  colorMapping?: Record<string, RGBA255> | null;
  /**
   * Positional fallback palette (maplibre). Used when a keyed lookup misses (if
   * present) and as the sole color source when no `colorMapping` is supplied.
   */
  palette?: readonly RGBA255[];
  /** Color for unmapped / NULL categories. Left undefined ⇒ transparent `[0,0,0,0]`. */
  colorMappingDefault?: RGBA255;
  /**
   * Behavior when the categorical property is ABSENT from the tile:
   *  - `'null'` (maplibre): return null so the caller skips / uses another path.
   *  - `'fill'` (three): fill every feature with `colorMappingDefault`.
   * @default 'null'
   */
  onMissing?: 'null' | 'fill';
  /**
   * maplibre guard: when true and there is neither a keyed `colorMapping` nor a
   * non-empty `palette`, return null (nothing to paint). @default false
   */
  requireMappingOrPalette?: boolean;
}

function alloc(out: ColorOut, n: number): Uint8Array | Float32Array {
  return out === 'u8' ? new Uint8Array(n * 4) : new Float32Array(n * 4);
}

function write(
  buf: Uint8Array | Float32Array,
  o: number,
  c: RGBA255,
  out: ColorOut,
): void {
  const a = c[3] ?? 255;
  if (out === 'u8') {
    buf[o] = c[0];
    buf[o + 1] = c[1];
    buf[o + 2] = c[2];
    buf[o + 3] = a;
  } else {
    buf[o] = c[0] / 255;
    buf[o + 1] = c[1] / 255;
    buf[o + 2] = c[2] / 255;
    buf[o + 3] = a / 255;
  }
}

/**
 * Expand a categorical property into a per-feature RGBA buffer. Returns the
 * chosen typed array, or `null` when there is nothing to paint (see
 * `onMissing` / `requireMappingOrPalette`).
 *
 * Keyed-branch semantics match maplibre's original exactly (the most general of
 * the four): `colorMapping[label] ?? colorMappingDefault`, then the positional
 * `palette[idx % len]` if still unset, then transparent `[0,0,0,0]`.
 */
export function expandCategoricalColors(
  binary: BinaryFeatures,
  spec: CategoricalColorSpec,
  out: ColorOut,
): Uint8Array | Float32Array | null {
  const n = binary.featureCount;
  const cat = binary.categoricalProps[spec.property];
  const mapping = spec.colorMapping ?? null;
  const keyed = !!mapping && Object.keys(mapping).length > 0;
  const palette = spec.palette ?? [];
  const def = spec.colorMappingDefault;
  const transparent: RGBA255 = [0, 0, 0, 0];

  if (!cat) {
    if (spec.onMissing !== 'fill') return null;
    const buf = alloc(out, n);
    const fill = def ?? transparent;
    for (let i = 0; i < n; i++) write(buf, i * 4, fill, out);
    return buf;
  }

  if (spec.requireMappingOrPalette && !keyed && palette.length === 0) return null;

  const buf = alloc(out, n);
  for (let i = 0; i < n; i++) {
    const idx = cat.indices[i];
    let c: RGBA255 | undefined;
    if (keyed) {
      const name = idx === NULL_CATEGORY_INDEX ? undefined : cat.categories[idx];
      c = (name !== undefined ? mapping![name] : undefined) ?? def;
      if (!c && palette.length > 0) c = palette[idx % palette.length];
      if (!c) c = transparent;
    } else {
      c = palette.length > 0 ? palette[idx % palette.length] : (def ?? transparent);
    }
    write(buf, i * 4, c, out);
  }
  return buf;
}

/**
 * Expand three RGB numeric columns (0–255) into a per-feature RGBA buffer. When
 * any column is absent, every feature gets `fallback`. `alpha` is applied as the
 * constant A channel (0–255).
 */
export function expandRgbColumns(
  binary: BinaryFeatures,
  columns: readonly [string, string, string],
  out: ColorOut,
  alpha = 255,
  fallback: RGBA255 = [200, 205, 215, 255],
): Uint8Array | Float32Array {
  const n = binary.featureCount;
  const buf = alloc(out, n);
  const r = binary.numericProps[columns[0]];
  const g = binary.numericProps[columns[1]];
  const b = binary.numericProps[columns[2]];
  const have = !!(r && g && b);
  for (let i = 0; i < n; i++) {
    const c: RGBA255 = have ? [r![i], g![i], b![i], alpha] : fallback;
    write(buf, i * 4, c, out);
  }
  return buf;
}

/**
 * Sample a multi-stop color ramp: `value` mapped through `domain` to `[0,1]`
 * (clamped), then linearly interpolated across evenly-spaced `range` stops.
 * Returns 0–255 RGBA. The continuous-`getColor` analogue (SST, magnitude, …).
 */
export function rampColorAt(
  value: number,
  domain: readonly [number, number],
  range: readonly RGBA255[],
): RGBA255 {
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
  domain: readonly [number, number];
  /** Evenly-spaced gradient stops (≥1), each `[r,g,b,a]` (0–255). */
  range: readonly RGBA255[];
  /** Color when the property is absent. */
  fallback: RGBA255;
}

/**
 * Expand a numeric property into a per-feature RGBA buffer via {@link rampColorAt}.
 * When the property is absent, every feature gets `fallback`.
 */
export function expandRampColors(
  binary: BinaryFeatures,
  spec: RampColorSpec,
  out: ColorOut,
): Uint8Array | Float32Array {
  const n = binary.featureCount;
  const buf = alloc(out, n);
  const col = binary.numericProps[spec.property];
  for (let i = 0; i < n; i++) {
    const c = col ? rampColorAt(col[i], spec.domain, spec.range) : spec.fallback;
    write(buf, i * 4, c, out);
  }
  return buf;
}

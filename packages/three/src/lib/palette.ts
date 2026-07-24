// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free) **stable categorical palette** assembly — the Three analogue
 * of deck's `CategoryColorExtension` GPU palette path. The point deck's extension
 * makes and three's per-tile CPU colour-expand does NOT: a given category value
 * resolves to the SAME colour in every tile, regardless of which tile it appears
 * in or the order tiles load / evict.
 *
 * Two things live here (both framework-free, unit-tested — the repo's PURE-core
 * convention; the GPU palette-lookup NODE + the `DataTexture` live in
 * `../tsl/palette.ts` and the layers respectively):
 *
 *  1. STABLE category → palette-SLOT assignment. Each tile carries its own
 *     category dictionary (`categoricalProps[prop].categories` + per-feature
 *     `indices`), so the raw local index is first-seen order and flickers across
 *     tiles. {@link buildStablePalette} instead assigns a slot from the category
 *     LABEL by one of three deterministic, load-order-independent rules:
 *       • explicit `colorMapping` (deck prop)  → sorted-key position (the label's
 *         own colour; the CPU path is already stable here — this is the GPU
 *         parity + uniform-swap recolour path);
 *       • a global `categoryOrder` list        → the label's position in it
 *         (mod the palette length), for a known archive/global category space;
 *       • otherwise                            → a stable FNV-1a hash of the
 *         label (mod the palette length) — deck's positional `colorPalette` but
 *         assigned by content instead of per-tile first-seen.
 *
 *  2. The GPU palette DATA: a colour list whose last slot is the null / unmapped
 *     "default" colour ({@link StablePalette.nullIndex}, deck's
 *     `colorMappingDefault` / `appendNullCategorySlot`), ready to upload as a
 *     `width × 1` palette texture ({@link paletteTextureData}), and the
 *     per-feature slot the shader indexes it by ({@link featureCategorySlot} /
 *     {@link assignCategoryIndices}).
 *
 * NULL handling matches the shared kernel (`@poopdeck.gl/core/style`): a feature
 * whose category index is `NULL_CATEGORY_INDEX` (or whose column is absent, or an
 * unmapped label under an explicit mapping / global order) resolves to the
 * trailing default slot — never clamps onto a real category's colour.
 */

import type { BinaryFeatures } from '@poopdeck.gl/core';
import { DEFAULT_CATEGORICAL_PALETTE } from '@poopdeck.gl/core';
import { NULL_CATEGORY_INDEX } from '@poopdeck.gl/core/style';
import type { RGBA } from './color.js';

/** Sentinel category index meaning "no category" (mirror of the core kernel's). */
export { NULL_CATEGORY_INDEX };

/**
 * Default positional palette when neither an explicit `colorMapping` nor a
 * caller `palette` is supplied — the shared `tab10` categorical palette (single
 * source of truth in `@poopdeck.gl/core`, also deck's point default).
 */
export const DEFAULT_CATEGORY_PALETTE: readonly RGBA[] =
  DEFAULT_CATEGORICAL_PALETTE as readonly RGBA[];

/** Default null / unmapped colour: transparent (unknown values disappear rather
 *  than mislead), matching deck's `appendNullCategorySlot`. */
const TRANSPARENT: RGBA = [0, 0, 0, 0];

/**
 * FNV-1a 32-bit hash of a category label → an unsigned int. Deterministic and
 * dependency-free, so the same label maps to the same palette slot in every tile
 * and across process runs — the load-order-independent replacement for deck's
 * positional per-tile first-seen index.
 */
export function stableCategoryHash(label: string): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime (32-bit)
  }
  return h >>> 0; // unsigned
}

/** How {@link buildStablePalette} assigns and colours category slots. */
export interface StablePaletteOptions {
  /**
   * Explicit `{ label → [r,g,b,a] (0–255) }` (deck `colorMapping`). When
   * non-empty this wins: each mapped label takes a deterministic slot (sorted-key
   * position) holding its colour; an unmapped label resolves to the default slot.
   */
  colorMapping?: Record<string, RGBA> | null;
  /**
   * Optional global category ordering (an archive/global category list). Used
   * only when there is no explicit `colorMapping`: a label takes its position in
   * this list (mod the palette length) so a known category space colours the same
   * everywhere. A label absent from the list resolves to the default slot.
   */
  categoryOrder?: readonly string[] | null;
  /**
   * Positional palette for auto assignment (deck `colorPalette`). Used with
   * `categoryOrder` (positional) or, absent both a mapping and an order, with the
   * stable hash. Defaults to {@link DEFAULT_CATEGORY_PALETTE}.
   */
  palette?: readonly RGBA[] | null;
  /**
   * Colour for null / unmapped / missing categories (deck `colorMappingDefault`).
   * @default transparent `[0,0,0,0]`
   */
  colorMappingDefault?: RGBA;
}

/** A stable category palette: the GPU colour list + the label→slot resolver. */
export interface StablePalette {
  /**
   * The palette colours (0–255), slot-indexed. Slots `0 .. nullIndex-1` are the
   * real category slots; `colors[nullIndex]` is the null / default colour. Upload
   * as a `colors.length × 1` texture (see {@link paletteTextureData}).
   */
  colors: RGBA[];
  /** Index of the trailing null / default slot (`=== colors.length - 1`). */
  nullIndex: number;
  /**
   * The stable slot for a category label. `undefined` / `''` and any label the
   * chosen rule cannot place resolve to {@link nullIndex}. Deterministic — the
   * same label always returns the same slot.
   */
  slotForLabel(label: string | undefined): number;
}

/**
 * Build a {@link StablePalette} from deck-shaped colour props. See
 * {@link StablePaletteOptions} for the three assignment rules; whichever applies,
 * the same label always lands on the same slot, so colours are stable across
 * tiles.
 */
export function buildStablePalette(
  opts: StablePaletteOptions = {},
): StablePalette {
  const def = opts.colorMappingDefault ?? TRANSPARENT;
  const mapping = opts.colorMapping ?? null;
  const mappingKeys = mapping ? Object.keys(mapping) : [];

  let slotColors: RGBA[];
  let slotForLabel: (label: string | undefined) => number;

  if (mappingKeys.length > 0) {
    // Explicit mapping: deterministic slot = sorted-key position (independent of
    // object insertion order), colour = the mapped value.
    const keys = mappingKeys.slice().sort();
    const keyMap = new Map<string, number>();
    keys.forEach((k, i) => keyMap.set(k, i));
    slotColors = keys.map((k) => mapping![k]);
    const nullIndex = slotColors.length;
    slotForLabel = (label) =>
      label != null && keyMap.has(label) ? keyMap.get(label)! : nullIndex;
  } else {
    const palette =
      opts.palette && opts.palette.length > 0
        ? opts.palette
        : DEFAULT_CATEGORY_PALETTE;
    const len = palette.length;
    slotColors = palette.slice() as RGBA[];
    const nullIndex = slotColors.length;
    const order = opts.categoryOrder ?? null;
    if (order && order.length > 0) {
      // Global category list: positional slot (first occurrence wins), wrapped
      // into the palette range.
      const orderMap = new Map<string, number>();
      order.forEach((c, i) => {
        if (!orderMap.has(c)) orderMap.set(c, i);
      });
      slotForLabel = (label) =>
        label != null && orderMap.has(label)
          ? orderMap.get(label)! % len
          : nullIndex;
    } else {
      // Stable hash: content-addressed, load-order independent.
      slotForLabel = (label) =>
        label != null && label !== ''
          ? stableCategoryHash(label) % len
          : nullIndex;
    }
  }

  const colors = [...slotColors, def];
  return { colors, nullIndex: colors.length - 1, slotForLabel };
}

/**
 * The stable palette slot for feature `f`'s value in categorical `property`. A
 * NULL category (`NULL_CATEGORY_INDEX`) or an absent column resolves to the
 * palette's null slot; otherwise the label is placed by the palette's rule.
 */
export function featureCategorySlot(
  binary: BinaryFeatures,
  f: number,
  property: string,
  palette: StablePalette,
): number {
  const cat = binary.categoricalProps[property];
  if (!cat) return palette.nullIndex;
  const idx = cat.indices[f];
  if (idx === NULL_CATEGORY_INDEX) return palette.nullIndex;
  return palette.slotForLabel(cat.categories[idx]);
}

/**
 * Per-feature stable slot indices (one per feature) for a categorical column —
 * the `sttCategoryIndex` attribute the GPU palette path binds. Builders that emit
 * one instance per feature (arc / column / icon / od-line) use this directly; the
 * per-segment wide-line builder calls {@link featureCategorySlot} per feature.
 */
export function assignCategoryIndices(
  binary: BinaryFeatures,
  property: string,
  palette: StablePalette,
): Float32Array {
  const n = binary.featureCount;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = featureCategorySlot(binary, i, property, palette);
  }
  return out;
}

/**
 * Flatten a {@link StablePalette}'s colours into an RGBA `Float32Array` (0..1),
 * row-major — the `width × 1` palette-texture payload the shader samples by slot.
 */
export function paletteTextureData(palette: StablePalette): Float32Array {
  const n = palette.colors.length;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const c = palette.colors[i];
    out[i * 4] = c[0] / 255;
    out[i * 4 + 1] = c[1] / 255;
    out[i * 4 + 2] = c[2] / 255;
    out[i * 4 + 3] = (c[3] ?? 255) / 255;
  }
  return out;
}

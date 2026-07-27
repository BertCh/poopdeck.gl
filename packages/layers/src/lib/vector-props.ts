// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * Type-safe binding of `BinaryFeatures.vectorProps` columns to deck attributes.
 *
 * A `FixedSizeList<Float32|UInt8, N>` column arrives as
 * `{value: Float32Array | Uint8Array, size: N}` — the leaf type is whatever the
 * archive baked, and it is NOT implied by `size`. deck derives the GPU buffer
 * format from the typed array (`DataColumn.setData` →
 * `dataTypeFromTypedArray`), upgrading `uint8` to `unorm8` only when
 * `normalized` is set; `'float32'.replace('int','norm')` is a no-op. So binding
 * by `size` alone silently produces a `float32x4` (16-byte stride) buffer where
 * the shader declared `unorm8x4` (4-byte stride) — values of 0–255 read as
 * floats, every point blown out to white, with `_checkExternalBuffer` silenced
 * by the very `normalized` flag that caused it.
 *
 * These helpers make the leaf type load-bearing: a colour column must be `u8`
 * (or is converted once, with a warning), and a float column must be `f32`.
 */

import { warnOnce } from './log.js';

/** One decoded `FixedSizeList` column, as surfaced on `BinaryFeatures`. */
export interface VectorColumn {
  value: Float32Array | Uint8Array;
  size: number;
}

/** A deck binary-attribute descriptor. */
export interface BoundVector {
  value: Float32Array | Uint8Array;
  size: number;
  normalized?: boolean;
}

/**
 * Bind a colour column (`u8` RGBA/RGB) as a `normalized` attribute.
 *
 * `Uint8Array` binds ZERO-COPY, which is the intended shape. A `Float32Array`
 * leaf is accepted but converted once per tile — its values are assumed to be
 * in 0–255 like the `u8` form, since that is the only interpretation under
 * which the column was usable at all — and warns so the archive can be rebuilt
 * with a `u8` leaf to get the zero-copy path back.
 *
 * @returns the descriptor, or `null` when the column is absent or mis-sized.
 */
export function bindColorVector(
  vec: VectorColumn | undefined,
  size: number,
  layerId: string,
  column: string,
): BoundVector | null {
  if (!vec || vec.size !== size) return null;

  if (vec.value instanceof Uint8Array) {
    return { value: vec.value, size, normalized: true };
  }

  warnOnce(
    `vector-color-f32:${layerId}:${column}`,
    `[${layerId}] colour column ${JSON.stringify(column)} has a float32 leaf; ` +
      `colour attributes bind as normalized u8. Converting per tile (values ` +
      `read as 0-255). Rebuild the archive with a u8 leaf ` +
      `(e.g. --vector-group ${column}=...:u8) to restore the zero-copy path.`,
  );
  const src = vec.value;
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return { value: out, size, normalized: true };
}

/**
 * Bind a float-semantics column (pixel offsets, normals, quaternions, scales).
 *
 * Only a `Float32Array` leaf is bindable: a `u8` leaf would produce a
 * `uint8x{N}` vertex buffer against a float attribute — a format mismatch
 * (WebGPU validation error, garbage values in WebGL2) — and there is no
 * scale convention that would let us reinterpret it.
 *
 * @returns the descriptor, or `null` when the column is absent, mis-sized, or
 *          carries the wrong leaf type (warned once).
 */
export function bindFloatVector(
  vec: VectorColumn | undefined,
  size: number,
  layerId: string,
  column: string,
): BoundVector | null {
  if (!vec || vec.size !== size) return null;

  if (vec.value instanceof Float32Array) {
    return { value: vec.value, size };
  }

  warnOnce(
    `vector-float-u8:${layerId}:${column}`,
    `[${layerId}] column ${JSON.stringify(column)} has a u8 leaf, but this ` +
      `attribute is float-valued. Ignoring it — binding a u8 buffer to a float ` +
      `attribute is a format mismatch, not a rescale. Rebuild the archive with ` +
      `an f32 leaf for this column.`,
  );
  return null;
}

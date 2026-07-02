// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * Compression utilities for TypeScript.
 *
 * The packed format is zstd-only, plus uncompressed `none` for blobs that don't
 * benefit from compression. zstd is decoded with `fzstd` (pure JS, ~30 KB, no
 * WASM) since browsers do not (yet) expose a zstd `DecompressionStream`.
 *
 * gzip was retired with the legacy single-file `.stt` format and is no longer
 * decodable here — the reader rejects it. Byte 1 in the {@link Compression}
 * enum stays permanently reserved so it is never reused.
 */

import { decompress as fzstdDecompress } from 'fzstd';
import { Compression } from './types.js';

/**
 * Decompress zstd data synchronously via fzstd (pure JS, ~30 KB, no WASM).
 * Used for both the sync and async paths since browsers do not (yet) expose
 * a zstd DecompressionStream.
 */
export function unzstdSync(data: Uint8Array): Uint8Array {
  return fzstdDecompress(data);
}

/**
 * Decompress data (async). Both supported codecs (`zstd`, `none`) resolve
 * synchronously under the hood; the async signature is kept for callers that
 * `await` decompression.
 */
export async function decompress(
  data: Uint8Array,
  compression: Compression
): Promise<Uint8Array> {
  return decompressSync(data, compression);
}

/**
 * Decompress data synchronously. `zstd` via fzstd; `none` is a passthrough.
 * Throws on any other (unknown or retired) codec.
 */
export function decompressSync(
  data: Uint8Array,
  compression: Compression
): Uint8Array {
  switch (compression) {
    case Compression.None:
      return data;
    case Compression.Zstd:
      return unzstdSync(data);
    default:
      throw new Error(`Unknown or retired compression type: ${compression}`);
  }
}

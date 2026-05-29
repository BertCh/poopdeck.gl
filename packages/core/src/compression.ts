// @stt/core
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/core contributors

/**
 * Compression utilities for TypeScript
 *
 * Decompression prefers the platform-native `DecompressionStream` (available
 * in all modern browsers and Node 18+), which runs off the JS heap and is
 * much faster than any pure-JS implementation.
 *
 * The pure-JS fallback is `fflate` rather than `pako`: fflate is ~1.5x
 * faster on representative tile payloads and adds ~10 KB to the bundle
 * versus pako's ~45 KB. The fallback only runs in two cases —
 * `DecompressionStream` missing entirely, or the native call throwing —
 * neither of which is hot on modern targets, so the bundle-size win is
 * the bigger value here.
 */

import { gunzipSync as fflateGunzipSync } from 'fflate';
import { decompress as fzstdDecompress } from 'fzstd';
import { Compression } from './types';

/** Whether the platform-native gzip DecompressionStream is available. */
export const NATIVE_DECOMPRESSION_AVAILABLE =
  typeof DecompressionStream !== 'undefined' && typeof Response !== 'undefined';

/**
 * Decompress gzip data using the native DecompressionStream API.
 * Throws if the API is unavailable.
 */
async function gunzipNative(data: Uint8Array): Promise<Uint8Array> {
  // A fresh ArrayBuffer-backed copy guarantees Response/Blob accept the input
  // even when `data` is a view into a larger (possibly shared) buffer.
  const stream = new Response(data.slice().buffer).body!.pipeThrough(
    new DecompressionStream('gzip')
  );
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Decompress gzip data synchronously using the pure-JS fallback (fflate).
 *
 * Re-exported under the historic `gunzipSync` name so existing call sites
 * (and the bench harness) keep working when we swapped pako out.
 */
export function gunzipSync(data: Uint8Array): Uint8Array {
  return fflateGunzipSync(data);
}

/**
 * Decompress zstd data synchronously via fzstd (pure JS, ~30 KB, no WASM).
 * Used for both the sync and async paths since browsers do not (yet) expose
 * a zstd DecompressionStream.
 */
export function unzstdSync(data: Uint8Array): Uint8Array {
  return fzstdDecompress(data);
}

/** Decompress data (async, prefers native DecompressionStream). */
export async function decompress(
  data: Uint8Array,
  compression: Compression
): Promise<Uint8Array> {
  switch (compression) {
    case Compression.None:
      return data;
    case Compression.Gzip:
      if (NATIVE_DECOMPRESSION_AVAILABLE) {
        try {
          return await gunzipNative(data);
        } catch {
          // Fall back to pako if the native path fails for any reason.
          return gunzipSync(data);
        }
      }
      return gunzipSync(data);
    case Compression.Zstd:
      // No native DecompressionStream('zstd') in browsers yet; fzstd is pure
      // JS and fast enough that running it inside the decoder worker keeps
      // the main thread free.
      return unzstdSync(data);
    default:
      throw new Error(`Unknown compression type: ${compression}`);
  }
}

/**
 * Decompress data synchronously. Uses pako for gzip, fzstd for zstd.
 * Only suitable for the synchronous code paths (e.g. `parseSync`).
 */
export function decompressSync(
  data: Uint8Array,
  compression: Compression
): Uint8Array {
  switch (compression) {
    case Compression.None:
      return data;
    case Compression.Gzip:
      return gunzipSync(data);
    case Compression.Zstd:
      return unzstdSync(data);
    default:
      throw new Error(`Unknown compression type: ${compression}`);
  }
}

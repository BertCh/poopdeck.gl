/**
 * Compression utilities for TypeScript
 *
 * Decompression prefers the platform-native `DecompressionStream` (available in
 * all modern browsers and Node 18+), which runs off the JS heap and is much
 * faster than the pure-JS `pako` implementation. `pako` is used only as a
 * fallback when `DecompressionStream` is unavailable.
 */

import * as pako from 'pako';
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
 * Decompress gzip data synchronously using pako.
 */
export function gunzipSync(data: Uint8Array): Uint8Array {
  return pako.ungzip(data);
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

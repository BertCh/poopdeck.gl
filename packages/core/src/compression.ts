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
 * A packed archive names its codec as a **string** in `manifest.json` —
 * `"zstd"` or `"none"`, enumerated in `docs/spec/manifest.schema.json`. No live
 * STT format encodes the codec as a byte; the numbers in {@link Compression}
 * are a package-local tag (see `types.ts`).
 *
 * ## gzip
 *
 * The canonical account for this package; `types.ts` and `archive.ts` defer
 * here. Three claims that are easy to conflate are kept apart:
 *
 * - **It was a real codec, not merely an accepted flag value.** The single-file
 *   `.stt` archive that preceded the packed format defaulted to gzip and wrote
 *   true DEFLATE frames, tagged `1` in that header's compression byte.
 * - **No release and no packed archive ever carried it.** That format is gone,
 *   its codec with it. No packed writer has ever put anything but `"zstd"` in a
 *   manifest, and this package has no DEFLATE decoder to offer one.
 * - **It cannot reappear silently.** A manifest claiming `"gzip"` is refused at
 *   open (`archive.ts`) rather than assumed to be zstd, which would fail late
 *   and opaquely inside fzstd.
 *
 * The codec number `1` stays unassigned: reusing it would let a byte salvaged
 * from a single-file archive decode as a live codec. Mirrors the Rust account
 * in `crates/stt-core/src/compression.rs`.
 */

import { Decompress as ZstdDecompress } from 'fzstd';
import { Compression } from './types.js';

/**
 * Absolute ceiling on the output of a single zstd decode when the caller
 * declares no expected size — the decompression-bomb backstop the spec
 * mandates (§11). Far above any legitimate tile or directory payload, yet it
 * bounds a hostile frame that would otherwise expand unchecked into memory.
 */
export const MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;

/**
 * Decompress zstd data synchronously via fzstd (pure JS, ~30 KB, no WASM).
 * Used for both the sync and async paths since browsers do not (yet) expose
 * a zstd DecompressionStream.
 *
 * Spec §11: the output MUST be bounded. When the caller knows the directory's
 * declared `expectedSize` (`uncompressedSize`), decoding is capped at it and a
 * frame that tries to produce more — a decompression bomb, or a blob whose
 * bytes disagree with the directory — is rejected mid-stream, before it can
 * exhaust memory. Absent a declared size the {@link MAX_DECOMPRESSED_BYTES}
 * ceiling still applies (and a declared size larger than the ceiling is clamped
 * to it, so a lying `uncompressedSize` can't unlock an unbounded allocation).
 *
 * fzstd's one-shot `decompress()` already accumulates the decoded blocks in an
 * array and concatenates at the end (it only pre-sizes when handed an output
 * buffer, which we can't do safely under a cap), so driving the streaming
 * `Decompress` here is performance-neutral for valid data while letting us
 * stop the moment the running total crosses the cap.
 */
export function unzstdSync(
  data: Uint8Array,
  expectedSize?: number,
): Uint8Array {
  const cap =
    typeof expectedSize === 'number' &&
    Number.isFinite(expectedSize) &&
    expectedSize >= 0
      ? Math.min(expectedSize, MAX_DECOMPRESSED_BYTES)
      : MAX_DECOMPRESSED_BYTES;

  const chunks: Uint8Array[] = [];
  let total = 0;
  const sink = new ZstdDecompress((chunk) => {
    total += chunk.length;
    if (total > cap) {
      throw new Error(
        `zstd: decompressed output exceeds ${cap} bytes (declared ` +
          `uncompressedSize ${expectedSize ?? 'none'}) — refusing a ` +
          `possible decompression bomb`,
      );
    }
    // fzstd hands back a freshly sliced block each call (no reused backing
    // buffer), so retaining the views to concatenate is safe.
    chunks.push(chunk);
  });
  sink.push(data, true);

  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Decompress data (async). Both supported codecs (`zstd`, `none`) resolve
 * synchronously under the hood; the async signature is kept for callers that
 * `await` decompression. `expectedSize`, when known, bounds the zstd output
 * (see {@link unzstdSync}).
 */
export async function decompress(
  data: Uint8Array,
  compression: Compression,
  expectedSize?: number,
): Promise<Uint8Array> {
  return decompressSync(data, compression, expectedSize);
}

/**
 * Decompress data synchronously. `zstd` via fzstd (bounded by `expectedSize` /
 * the absolute ceiling); `none` is a passthrough. Throws on any other (unknown
 * or retired) codec.
 */
export function decompressSync(
  data: Uint8Array,
  compression: Compression,
  expectedSize?: number,
): Uint8Array {
  switch (compression) {
    case Compression.None:
      // Uncompressed already — the input IS the payload, so there is no
      // expansion to bound (returned by identity, as callers rely on).
      return data;
    case Compression.Zstd:
      return unzstdSync(data, expectedSize);
    default:
      throw new Error(`Unknown or retired compression type: ${compression}`);
  }
}

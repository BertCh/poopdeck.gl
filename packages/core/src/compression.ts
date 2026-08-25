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
 * Counters for the single-segment header rewrite
 * ({@link synthesizeSingleSegmentFrame}). `rewritten` counts frames handed to
 * fzstd behind a synthesized header; `fallbacks` counts the ones whose
 * rewritten decode threw or came back the wrong length and were decoded again
 * from the original bytes. Diagnostics only: a non-zero `fallbacks` on data
 * the directory describes truthfully means the rewrite is unsound for that
 * frame and is worth a look.
 */
export const zstdHeaderRewriteStats = { rewritten: 0, fallbacks: 0 };

/**
 * Rewrite a zstd frame header to `Single_Segment=1` with a `Frame_Content_Size`
 * sized for `contentSize`, or return `null` when the rewrite does not apply.
 *
 * Why: fzstd sizes its history window from the FRAME HEADER, not from the
 * caller. The fleet's writer (`zstd::stream::encode_all`, no pledged size)
 * emits every frame as `Single_Segment=0`, no content size, and the level's
 * default window — 8 MiB at level 19 — so fzstd zero-fills an 8 MiB window
 * per frame and `copyWithin`s all of it once per block, even for a 500-byte
 * tile (audit D1: 69–92 % of in-worker decode time; 2.3–12.6× on real
 * frames). The directory already tells the reader the exact payload size, and
 * without a dictionary no match can reach before the frame start, so a window
 * of the payload's size is always sufficient (RFC 8878 §3.1.1.1.2). A header
 * that says so makes fzstd size everything to the payload instead.
 *
 * Applies only when the header is `Single_Segment=0`, `Frame_Content_Size_flag
 * =0`, `Dictionary_ID_flag=0` and the declared window is larger than the new
 * one (a rewrite that GREW the window would cost more per block, not less).
 * The Content_Checksum flag and the reserved/unused descriptor bits are
 * preserved; the `Window_Descriptor` byte is dropped (a single-segment frame
 * has none); the smallest FCS field that holds the value is written
 * (§3.1.1.1.1: 1 byte below 256, 2 bytes with the −256 bias up to 65791,
 * else 4, else 8). Block bytes are copied verbatim — the cost is one concat
 * of the compressed bytes.
 *
 * The FCS written is `contentSize + 1`, not `contentSize`. fzstd decodes each
 * block into a buffer of `min(128 KiB, window)` bytes and silently CLAMPS a
 * block that does not fit (indexed stores past the end are dropped, the
 * literal region overlaps the output). With an exact FCS, a directory that
 * under-declares the size would therefore not fail the length check — it
 * would hand back exactly the declared number of garbled bytes. One byte of
 * slack keeps the window strictly larger than the declared size, so any
 * frame whose true content exceeds it produces at least `contentSize + 1`
 * bytes and trips the cap in {@link unzstdSync}. fzstd does not validate the
 * FCS against the decoded length, and the rewritten frame is never persisted
 * or handed to any other decoder.
 */
export function synthesizeSingleSegmentFrame(
  data: Uint8Array,
  contentSize: number,
): Uint8Array | null {
  // Magic (4) + Frame_Header_Descriptor (1) + Window_Descriptor (1).
  if (data.length < 6) return null;
  if (
    data[0] !== 0x28 ||
    data[1] !== 0xb5 ||
    data[2] !== 0x2f ||
    data[3] !== 0xfd
  ) {
    return null;
  }
  const fhd = data[4];
  const singleSegment = (fhd >> 5) & 1;
  const fcsFlag = fhd >> 6;
  const dictIdFlag = fhd & 3;
  if (singleSegment || fcsFlag || dictIdFlag) return null;

  const fcs = contentSize + 1;
  // Window_Descriptor → Window_Size (§3.1.1.1.2). `2 **` rather than `<<`:
  // the exponent runs to 31 and the shift would wrap.
  const wd = data[5];
  const windowBase = 2 ** (10 + (wd >> 3));
  const windowSize = windowBase + (windowBase / 8) * (wd & 7);
  if (fcs >= windowSize) return null;

  let fcsBytes: number;
  let newFcsFlag: number;
  if (fcs < 256) {
    fcsBytes = 1;
    newFcsFlag = 0;
  } else if (fcs <= 65791) {
    fcsBytes = 2;
    newFcsFlag = 1;
  } else if (fcs <= 0xffffffff) {
    fcsBytes = 4;
    newFcsFlag = 2;
  } else {
    fcsBytes = 8;
    newFcsFlag = 3;
  }

  const body = data.subarray(6);
  const out = new Uint8Array(5 + fcsBytes + body.length);
  out[0] = 0x28;
  out[1] = 0xb5;
  out[2] = 0x2f;
  out[3] = 0xfd;
  // Bits 2–4 (Content_Checksum, Reserved, Unused) carry over; Single_Segment
  // set; Dictionary_ID_flag is known to be 0.
  out[4] = (fhd & 0x1c) | 0x20 | (newFcsFlag << 6);
  let v = fcsBytes === 2 ? fcs - 256 : fcs;
  for (let i = 0; i < fcsBytes; i++) {
    out[5 + i] = v % 256;
    v = Math.floor(v / 256);
  }
  out.set(body, 5 + fcsBytes);
  return out;
}

/**
 * Drive fzstd's streaming `Decompress` over one frame, refusing to accumulate
 * more than `cap` bytes. The streaming API (rather than one-shot
 * `decompress()`) is what lets us stop the moment the running total crosses
 * the cap; fzstd's per-frame cost is set by the window the header declares,
 * not by which API drives it — see {@link synthesizeSingleSegmentFrame}.
 */
function decodeBounded(
  data: Uint8Array,
  cap: number,
  declared: number | undefined,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const sink = new ZstdDecompress((chunk) => {
    total += chunk.length;
    if (total > cap) {
      throw new Error(
        `zstd: decompressed output exceeds ${cap} bytes (declared ` +
          `uncompressedSize ${declared ?? 'none'}) — refusing a ` +
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
 * A known `expectedSize` also pays for itself: the frame is handed to fzstd
 * behind a synthesized single-segment header so its window is sized to the
 * payload rather than the 8 MiB the fleet's frames declare
 * ({@link synthesizeSingleSegmentFrame}). Only an exact, positive size within
 * the ceiling qualifies — the rewritten frame's window is the size, so a
 * value above the ceiling would let a lying directory drive the allocation.
 * If the rewritten decode throws or yields any other length, the original
 * bytes are decoded once more and their result (or error) stands.
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

  if (
    typeof expectedSize === 'number' &&
    Number.isInteger(expectedSize) &&
    expectedSize > 0 &&
    expectedSize <= MAX_DECOMPRESSED_BYTES
  ) {
    const rewritten = synthesizeSingleSegmentFrame(data, expectedSize);
    if (rewritten) {
      zstdHeaderRewriteStats.rewritten++;
      try {
        const out = decodeBounded(rewritten, cap, expectedSize);
        if (out.length === expectedSize) return out;
      } catch {
        // The original bytes are authoritative; decode them below.
      }
      zstdHeaderRewriteStats.fallbacks++;
    }
  }
  return decodeBounded(data, cap, expectedSize);
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

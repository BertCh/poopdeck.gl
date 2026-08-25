/**
 * The decoded-length contract between the zstd frame-header rewrite (audit D1,
 * `synthesizeSingleSegmentFrame`) and the decode worker's length check.
 *
 * These two live in different files, were written by different passes, and are
 * coupled by an invariant neither states locally:
 *
 *   - `synthesizeSingleSegmentFrame` deliberately writes a `Frame_Content_Size`
 *     of `contentSize + 1`. The slack is a SAFETY margin: fzstd sizes its
 *     decode buffer from the FCS and silently clamps a block that overruns, so
 *     an exact FCS would let a directory that UNDER-declares a tile's size hand
 *     back exactly the declared number of garbled bytes instead of failing.
 *   - `tile-decoder.worker.ts` then asserts
 *     `payload.byteLength !== expectedUncompressedSize` and throws.
 *
 * So the rewrite over-declares by one byte while the worker demands an exact
 * match. That is only safe because fzstd returns the bytes it actually decoded
 * rather than an FCS-sized buffer — an implementation detail of a third-party
 * decoder, load-bearing for the entire fleet, and invisible from either file.
 * If it ever stopped holding, EVERY tile decode would throw
 * `tile payload length mismatch` and no single-file test would catch it.
 */

import { describe, it, expect } from 'vitest';
import { zstdCompress } from 'node:zlib';
import { promisify } from 'node:util';
import {
  synthesizeSingleSegmentFrame,
  decompressSync,
} from '../src/compression.js';
import { Compression } from '../src/types.js';

const deflate = promisify(zstdCompress);

describe('decoded-length contract (D1 frame rewrite ↔ decode worker)', () => {
  it('returns EXACTLY contentSize even though the rewritten FCS declares contentSize + 1', async () => {
    // Spans the FCS field-width boundaries the rewrite selects between
    // (1 byte < 256, 2 bytes with the −256 bias up to 65791, else 4).
    for (const size of [500, 4096, 65_000, 200_000]) {
      const payload = new Uint8Array(size);
      for (let i = 0; i < size; i++) payload[i] = (i * 31) & 0xff;

      const compressed = new Uint8Array(await deflate(payload));
      const rewritten = synthesizeSingleSegmentFrame(compressed, size);
      // A frame the rewrite declines must still round-trip untouched.
      const frame = rewritten ?? compressed;

      const out = decompressSync(frame, Compression.Zstd, size);

      expect(
        out.byteLength,
        `size=${size} rewritten=${rewritten !== null}`,
      ).toBe(size);
      expect(out).toEqual(payload);
    }
  });
});

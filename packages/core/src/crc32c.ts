// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * CRC-32C (Castagnoli) — the integrity checksum the Rust writer stamps on
 * every directory run (`crc32c_tag` in `stt-core::pack`, computed over the
 * blob's COMPRESSED bytes as stored in the pack object). The TS reader
 * verifies it before decompressing a fetched blob so middlebox corruption,
 * a truncating proxy, or a cache gone bad surfaces as a loud per-tile error
 * instead of a garbled decode.
 *
 * Table-based, reflected polynomial 0x82F63B78 (the bit-reversed form of
 * 0x1EDC6F41) — byte-identical to the `crc32c` Rust crate and RFC 3720
 * Appendix B. Known-answer: crc32c of ASCII "123456789" is 0xE3069283.
 */

/** 256-entry lookup table for the reflected CRC-32C polynomial. */
const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32C (Castagnoli) of `bytes`, as an unsigned 32-bit integer. */
export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ CRC32C_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Verify `bytes` against the directory's expected CRC-32C, throwing a
 * distinctive error on mismatch. Shared by the worker and inline decode
 * paths so the two surface the identical message (tests and error triage
 * match on "crc32c mismatch").
 */
export function verifyCrc32c(bytes: Uint8Array, expected: number): void {
  const actual = crc32c(bytes);
  if (actual !== expected >>> 0) {
    const hex = (v: number): string => `0x${v.toString(16).padStart(8, '0')}`;
    throw new Error(
      `STT tile crc32c mismatch: computed ${hex(actual)} over ${bytes.length} ` +
        `compressed bytes, directory says ${hex(expected >>> 0)} — the blob was ` +
        'corrupted in transit or at rest (set ArchiveOptions.verifyChecksums: ' +
        'false to bypass verification)',
    );
  }
}

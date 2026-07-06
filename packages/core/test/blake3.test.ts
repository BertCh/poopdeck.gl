/**
 * BLAKE3 cross-impl vectors: the pure-TS port must agree with the Rust
 * `blake3` crate the packed writer content-addresses with — that agreement
 * is what makes the TS reader's `manifest.schemas` hash validation (packed
 * spec §3.2) meaningful.
 *
 * Vectors were generated with the Rust crate (`blake3::hash`) over the
 * official test-vector input pattern (byte `i` = `i % 251`), at lengths that
 * cross every structural boundary: sub-block, exact block (64), block+1,
 * sub-chunk, exact chunk (1024), chunk+1 (first parent node), multi-chunk
 * powers of two and odd sizes (uneven tree shapes), and a 31-chunk input
 * (multi-level tree). The 0-length entry is also the official empty-input
 * vector.
 */

import { describe, it, expect } from 'vitest';
import { blake3, blake3Hex128 } from '../src/blake3';

/** `len → blake3 hex (256-bit)` from the Rust `blake3` crate. */
const VECTORS: Array<[number, string]> = [
  [0, 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'],
  [1, '2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213'],
  [2, '7b7015bb92cf0b318037702a6cdd81dee41224f734684c2c122cd6359cb1ee63'],
  [3, 'e1be4d7a8ab5560aa4199eea339849ba8e293d55ca0a81006726d184519e647f'],
  [63, 'e9bc37a594daad83be9470df7f7b3798297c3d834ce80ba85d6e207627b7db7b'],
  [64, '4eed7141ea4a5cd4b788606bd23f46e212af9cacebacdc7d1f4c6dc7f2511b98'],
  [65, 'de1e5fa0be70df6d2be8fffd0e99ceaa8eb6e8c93a63f2d8d1c30ecb6b263dee'],
  [127, 'd81293fda863f008c09e92fc382a81f5a0b4a1251cba1634016a0f86a6bd640d'],
  [128, 'f17e570564b26578c33bb7f44643f539624b05df1a76c81f30acd548c44b45ef'],
  [129, '683aaae9f3c5ba37eaaf072aed0f9e30bac0865137bae68b1fde4ca2aebdcb12'],
  [1023, '10108970eeda3eb932baac1428c7a2163b0e924c9a9e25b35bba72b28f70bd11'],
  [1024, '42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7'],
  [1025, 'd00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444'],
  [2048, 'e776b6028c7cd22a4d0ba182a8bf62205d2ef576467e838ed6f2529b85fba24a'],
  [2049, '5f4d72f40d7a5f82b15ca2b2e44b1de3c2ef86c426c95c1af0b6879522563030'],
  [3072, 'b98cb0ff3623be03326b373de6b9095218513e64f1ee2edd2525c7ad1e5cffd2'],
  [3073, '7124b49501012f81cc7f11ca069ec9226cecb8a2c850cfe644e327d22d3e1cd3'],
  [4096, '015094013f57a5277b59d8475c0501042c0b642e531b0a1c8f58d2163229e969'],
  [5000, 'ee78d92070de3df1c57c37002abf0a6b1a6589acdeef4d8ffac7cf3d9e8f2836'],
  [8192, 'aae792484c8efe4f19e2ca7d371d8c467ffb10748d8a5a1ae579948f718a2a63'],
  [10000, '5f81f9e4ab67627b6b036d5d4e3bc40d9d3daa6fcc2b6dd07ab2bbf0a877da54'],
  [31744, '62b6960e1a44bcc1eb1a611a8d6235b6b4b78f32e7abc4fb4c6cdcce94895c47'],
];

function officialInput(len: number): Uint8Array {
  const input = new Uint8Array(len);
  for (let i = 0; i < len; i++) input[i] = i % 251;
  return input;
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

describe('blake3 (pure-TS port vs the Rust writer crate)', () => {
  for (const [len, expected] of VECTORS) {
    it(`hashes the ${len}-byte official-pattern input`, () => {
      expect(toHex(blake3(officialInput(len)))).toBe(expected);
    });
  }

  it('blake3Hex128 is the 32-hex-char (128-bit) truncation — the packed content-address form', () => {
    for (const [len, expected] of VECTORS) {
      expect(blake3Hex128(officialInput(len))).toBe(expected.slice(0, 32));
    }
  });

  it('truncated outputs are prefixes of the full hash', () => {
    const input = officialInput(1025);
    const full = blake3(input, 32);
    expect(Array.from(blake3(input, 16))).toEqual(Array.from(full.subarray(0, 16)));
    expect(Array.from(blake3(input, 1))).toEqual([full[0]]);
  });

  it('rejects extended output lengths (not needed by the format)', () => {
    expect(() => blake3(new Uint8Array(0), 33)).toThrow(/not supported/);
  });
});

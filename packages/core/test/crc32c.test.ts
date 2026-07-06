/**
 * Known-answer tests for the CRC-32C (Castagnoli) implementation — the
 * vectors are the RFC 3720 (iSCSI) Appendix B set plus the classic CRC
 * check string, so a table/polynomial mistake (e.g. plain CRC-32) cannot
 * pass. The cross-implementation proof against the Rust writer's
 * `crc32c_tag` lives in the archive tests (the sample fixture's directory
 * CRCs are verified on every decode).
 */

import { describe, it, expect } from 'vitest';
import { crc32c, verifyCrc32c } from '../src/crc32c';

describe('crc32c', () => {
  it('matches the classic check value for ASCII "123456789"', () => {
    expect(crc32c(new TextEncoder().encode('123456789'))).toBe(0xe3069283);
  });

  it('returns 0 for empty input', () => {
    expect(crc32c(new Uint8Array(0))).toBe(0x00000000);
  });

  it('matches the RFC 3720 vector: 32 bytes of zeros', () => {
    expect(crc32c(new Uint8Array(32))).toBe(0x8a9136aa);
  });

  it('matches the RFC 3720 vector: 32 bytes of 0xFF', () => {
    expect(crc32c(new Uint8Array(32).fill(0xff))).toBe(0x62a8ab43);
  });

  it('matches the RFC 3720 vector: 32 incrementing bytes 0x00..0x1F', () => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = i;
    expect(crc32c(bytes)).toBe(0x46dd794e);
  });

  it('matches the RFC 3720 vector: 32 decrementing bytes 0x1F..0x00', () => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = 31 - i;
    expect(crc32c(bytes)).toBe(0x113fdb5c);
  });
});

describe('verifyCrc32c', () => {
  it('passes silently on a match', () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(() => verifyCrc32c(bytes, 0xe3069283)).not.toThrow();
  });

  it('throws the distinctive mismatch message on disagreement', () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(() => verifyCrc32c(bytes, 0xdeadbeef)).toThrow(/crc32c mismatch/);
  });
});

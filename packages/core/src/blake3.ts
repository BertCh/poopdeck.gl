// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * Minimal pure-TypeScript BLAKE3 (hash mode only).
 *
 * The packed format content-addresses objects and schema templates with
 * blake3-128 (the first 16 bytes / 32 hex chars of the 256-bit hash — see
 * `docs/spec/stt-packed-format.md`). A formatVersion-3 manifest embeds its
 * Arrow schema templates as `{hash, data}` pairs, and the reader MUST verify
 * `blake3_128(data) == hash` for every entry at open (spec §3.2) — so the TS
 * reader needs BLAKE3 without dragging in a WASM bundle or a native dep for
 * a handful of ~1 KB inputs per dataset open.
 *
 * This is a straight port of the official reference implementation
 * (https://github.com/BLAKE3-team/BLAKE3, `reference_impl.rs`): the full
 * chunk/parent tree, so inputs of any length hash correctly (templates are
 * usually <1 KiB but can exceed the 1024-byte chunk size). Keyed hashing and
 * key derivation are intentionally omitted — the format only uses plain
 * hashing. Verified against vectors produced by the Rust `blake3` crate the
 * writer uses (`test/blake3.test.ts`), including the official empty-input
 * vector.
 */

/** Initialization vector (identical to SHA-256's IV, per the BLAKE3 spec). */
const IV = Uint32Array.from([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
]);

/** Message word permutation applied between rounds. */
const MSG_PERMUTATION = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];

const CHUNK_LEN = 1024;
const BLOCK_LEN = 64;

// Domain-separation flags (subset used by plain hashing).
const CHUNK_START = 1 << 0;
const CHUNK_END = 1 << 1;
const PARENT = 1 << 2;
const ROOT = 1 << 3;

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** The quarter-round mixing function. */
function g(
  state: Uint32Array,
  a: number,
  b: number,
  c: number,
  d: number,
  mx: number,
  my: number,
): void {
  state[a] = (state[a] + state[b] + mx) >>> 0;
  state[d] = rotr(state[d] ^ state[a], 16);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rotr(state[b] ^ state[c], 12);
  state[a] = (state[a] + state[b] + my) >>> 0;
  state[d] = rotr(state[d] ^ state[a], 8);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rotr(state[b] ^ state[c], 7);
}

function round(state: Uint32Array, m: Uint32Array): void {
  // Columns.
  g(state, 0, 4, 8, 12, m[0], m[1]);
  g(state, 1, 5, 9, 13, m[2], m[3]);
  g(state, 2, 6, 10, 14, m[4], m[5]);
  g(state, 3, 7, 11, 15, m[6], m[7]);
  // Diagonals.
  g(state, 0, 5, 10, 15, m[8], m[9]);
  g(state, 1, 6, 11, 12, m[10], m[11]);
  g(state, 2, 7, 8, 13, m[12], m[13]);
  g(state, 3, 4, 9, 14, m[14], m[15]);
}

/**
 * The BLAKE3 compression function. Returns the full 16-word state; a
 * chaining value is its first 8 words.
 */
function compress(
  cv: Uint32Array,
  blockWords: Uint32Array,
  counter: number,
  blockLen: number,
  flags: number,
): Uint32Array {
  const state = new Uint32Array(16);
  state.set(cv.subarray(0, 8), 0);
  state.set(IV.subarray(0, 4), 8);
  // Counter is a u64 split into two u32 lanes. Chunk indices stay far below
  // 2^53, so plain number math is exact.
  state[12] = counter >>> 0;
  state[13] = Math.floor(counter / 0x1_0000_0000) >>> 0;
  state[14] = blockLen;
  state[15] = flags;

  let m = Uint32Array.from(blockWords);
  for (let r = 0; r < 7; r++) {
    round(state, m);
    if (r < 6) {
      const p = new Uint32Array(16);
      for (let i = 0; i < 16; i++) p[i] = m[MSG_PERMUTATION[i]];
      m = p;
    }
  }
  for (let i = 0; i < 8; i++) {
    state[i] = (state[i] ^ state[i + 8]) >>> 0;
    state[i + 8] = (state[i + 8] ^ cv[i]) >>> 0;
  }
  return state;
}

/** Read up to 64 input bytes at `off` into 16 little-endian words (zero-padded). */
function blockToWords(
  input: Uint8Array,
  off: number,
  len: number,
): Uint32Array {
  const words = new Uint32Array(16);
  for (let i = 0; i < len; i++) {
    words[i >> 2] |= input[off + i] << ((i & 3) * 8);
  }
  return words;
}

/**
 * A node's pending final compression — kept unapplied so the ROOT flag can be
 * OR'd in if the node turns out to be the tree root (mirrors the reference
 * implementation's `Output` struct).
 */
interface NodeOutput {
  cv: Uint32Array;
  block: Uint32Array;
  counter: number;
  blockLen: number;
  flags: number;
}

/** Chaining value of a non-root node. */
function chainingValue(o: NodeOutput): Uint32Array {
  return compress(o.cv, o.block, o.counter, o.blockLen, o.flags).slice(0, 8);
}

/** Process one ≤1024-byte chunk (index `chunkIndex`) up to its final block. */
function chunkOutput(
  input: Uint8Array,
  off: number,
  len: number,
  chunkIndex: number,
): NodeOutput {
  let cv = Uint32Array.from(IV);
  const blockCount = Math.max(1, Math.ceil(len / BLOCK_LEN));
  for (let b = 0; b < blockCount - 1; b++) {
    const words = blockToWords(input, off + b * BLOCK_LEN, BLOCK_LEN);
    const flags = b === 0 ? CHUNK_START : 0;
    cv = compress(cv, words, chunkIndex, BLOCK_LEN, flags).slice(0, 8);
  }
  const lastLen = len - (blockCount - 1) * BLOCK_LEN;
  const lastWords = blockToWords(
    input,
    off + (blockCount - 1) * BLOCK_LEN,
    lastLen,
  );
  return {
    cv,
    block: lastWords,
    counter: chunkIndex,
    blockLen: lastLen,
    flags: (blockCount === 1 ? CHUNK_START : 0) | CHUNK_END,
  };
}

/**
 * Hash the subtree over `input[off, off+len)` whose first chunk is
 * `chunkIndex`, returning the subtree root's pending output. The left
 * subtree takes the largest power-of-two number of whole chunks that leaves
 * at least one byte for the right (the BLAKE3 tree-shape rule).
 */
function subtreeOutput(
  input: Uint8Array,
  off: number,
  len: number,
  chunkIndex: number,
): NodeOutput {
  if (len <= CHUNK_LEN) return chunkOutput(input, off, len, chunkIndex);
  let leftChunks = 1;
  while (leftChunks * 2 * CHUNK_LEN < len) leftChunks *= 2;
  const leftLen = leftChunks * CHUNK_LEN;
  const left = subtreeOutput(input, off, leftLen, chunkIndex);
  const right = subtreeOutput(
    input,
    off + leftLen,
    len - leftLen,
    chunkIndex + leftChunks,
  );
  const block = new Uint32Array(16);
  block.set(chainingValue(left), 0);
  block.set(chainingValue(right), 8);
  return {
    cv: Uint32Array.from(IV),
    block,
    counter: 0,
    blockLen: BLOCK_LEN,
    flags: PARENT,
  };
}

/**
 * BLAKE3 hash of `input`, truncated to `outLen` bytes (≤ 32; default 32).
 * The packed format's blake3-128 addresses are the first 16 bytes.
 */
export function blake3(input: Uint8Array, outLen = 32): Uint8Array {
  if (outLen > 32) {
    // Extended output would need the output-block counter loop; nothing in
    // the packed format asks for more than 256 bits.
    throw new Error(`blake3: outLen ${outLen} > 32 not supported`);
  }
  const root = subtreeOutput(input, 0, input.length, 0);
  const words = compress(
    root.cv,
    root.block,
    0,
    root.blockLen,
    root.flags | ROOT,
  );
  const out = new Uint8Array(outLen);
  for (let i = 0; i < outLen; i++) {
    out[i] = (words[i >> 2] >>> ((i & 3) * 8)) & 0xff;
  }
  return out;
}

/**
 * blake3-128 as 32 lowercase hex chars — the packed format's content-address
 * form (`manifest.schemas[].hash`, `index/<hash>.sttd`, `packs/<hash>.sttp`).
 */
export function blake3Hex128(input: Uint8Array): string {
  const bytes = blake3(input, 16);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

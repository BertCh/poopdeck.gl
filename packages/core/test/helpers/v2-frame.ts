/**
 * Test helpers for the packed formatVersion-2 **layer frame** (spec §5.2):
 * split an Arrow IPC stream into its schema template + tail at the exact
 * boundary the Rust writer uses, and assemble sectioned v2 frames — inline
 * or hash-referencing — so the unit suite can exercise the TS reader's
 * splice guards, TOC skipping, TILE_META plumbing and registry errors
 * without a Rust round-trip per case. (Cross-impl truth for real writer
 * bytes lives in `packed-v2-golden.test.ts` against committed fixtures.)
 */

import { blake3 } from '../../src/blake3';

// Wire constants (mirror `src/tile.ts` / the Rust `arrow_tile.rs`).
export const FRAME_V2_ESCAPE = 0xffff;
export const FRAME_V2_VERSION = 2;
export const SECTION_INLINE_SCHEMA_CORE = 0x01;
export const SECTION_TILE_META = 0x02;
export const SECTION_CORE_BATCH = 0x03;
export const SECTION_INLINE_SCHEMA_PROPS = 0x04;
export const SECTION_PROPS_BATCH = 0x05;
export const REF_KIND_INLINE = 0;
export const REF_KIND_TEMPLATE_HASH = 1;
export const REF_KIND_NO_PROPS = 2;

/**
 * Split an Arrow IPC stream at the end of its encapsulated Schema message
 * (`[0xFFFFFFFF][i32 metadata_len][flatbuffer]`, bodyLength 0) — the
 * template/tail boundary of spec §3.2. Deterministic; proven by the v2
 * spike against both arrow-rs 59 and apache-arrow 17.
 */
export function splitIpcTemplate(ipc: Uint8Array): { template: Uint8Array; tail: Uint8Array } {
  const view = new DataView(ipc.buffer, ipc.byteOffset, ipc.byteLength);
  if (ipc.byteLength < 8 || view.getUint32(0, true) !== 0xffffffff) {
    throw new Error('splitIpcTemplate: stream does not start with a continuation marker');
  }
  const metadataLen = view.getInt32(4, true);
  const boundary = 8 + metadataLen;
  return { template: ipc.subarray(0, boundary), tail: ipc.subarray(boundary) };
}

/** blake3-128 of template bytes, as the 16 raw bytes a v2 frame embeds. */
export function templateHashBytes(template: Uint8Array): Uint8Array {
  return blake3(template, 16);
}

/** blake3-128 of template bytes, as the 32-hex-char registry key. */
export function templateHashHex(template: Uint8Array): string {
  return Array.from(blake3(template, 16))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** A per-layer schema reference: inline section, 16-byte hash, or no-props. */
export type V2Ref =
  | { kind: typeof REF_KIND_INLINE }
  | { kind: typeof REF_KIND_TEMPLATE_HASH; hash: Uint8Array }
  | { kind: typeof REF_KIND_NO_PROPS };

export interface V2LayerSpec {
  name: string;
  refCore: V2Ref;
  refProps: V2Ref;
  /** Sections in TOC order: `[tag, bytes]`. */
  sections: Array<[number, Uint8Array]>;
}

export interface BuildV2FrameOptions {
  /** Override the `frame_version` byte (default 2). */
  frameVersion?: number;
  /** Override the reserved flags byte (MUST be 0 on the wire; default 0). */
  flags?: number;
}

/** Assemble a v2 sectioned layer frame (spec §5.2) from layer specs. */
export function buildV2Frame(layers: V2LayerSpec[], options: BuildV2FrameOptions = {}): Uint8Array {
  const parts: number[] = [];
  const pushU16 = (v: number) => parts.push(v & 0xff, (v >> 8) & 0xff);
  const pushU32 = (v: number) =>
    parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const pushBytes = (b: Uint8Array) => {
    for (const x of b) parts.push(x);
  };
  const padTo8 = () => {
    while (parts.length % 8 !== 0) parts.push(0);
  };
  const pushRef = (ref: V2Ref) => {
    parts.push(ref.kind);
    if (ref.kind === REF_KIND_TEMPLATE_HASH) pushBytes(ref.hash);
  };

  pushU16(FRAME_V2_ESCAPE);
  parts.push(options.frameVersion ?? FRAME_V2_VERSION);
  parts.push(options.flags ?? 0);
  pushU16(layers.length);
  for (const layer of layers) {
    const nameBytes = new TextEncoder().encode(layer.name);
    pushU16(nameBytes.length);
    pushBytes(nameBytes);
    pushRef(layer.refCore);
    pushRef(layer.refProps);
    parts.push(layer.sections.length);
    for (const [tag, bytes] of layer.sections) {
      parts.push(tag);
      pushU32(bytes.length);
    }
    padTo8();
    for (const [, bytes] of layer.sections) {
      pushBytes(bytes);
      padTo8();
    }
  }
  return Uint8Array.from(parts);
}

/** Canonical-ish TILE_META bytes (sorted keys, no whitespace). */
export function tileMetaBytes(meta: Record<string, unknown>): Uint8Array {
  const sorted = Object.fromEntries(Object.entries(meta).sort(([a], [b]) => (a < b ? -1 : 1)));
  return new TextEncoder().encode(JSON.stringify(sorted));
}

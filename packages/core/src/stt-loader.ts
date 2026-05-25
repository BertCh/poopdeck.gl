/**
 * SttLoader — loaders.gl-conformant Loader for STT archives.
 *
 * Structurally matches `LoaderWithParser` from `@loaders.gl/loader-utils`
 * (v4.x) without taking a hard dep on it, so consumers using deck.gl /
 * loaders.gl can do `TileLayer({ loaders: [SttLoader] })` while consumers
 * that just want `STTArchive` directly pay nothing extra.
 *
 * `parse(arrayBuffer)` returns a `ParsedSTT` containing the parsed metadata
 * and index plus an `STTArchive` instance that reads tiles from the in-memory
 * buffer (via a synthetic Range-aware fetch). This is the right shape for
 * Node-side tools, drag-drop workflows, and tests — code that already has
 * the whole archive in memory. Production streaming consumers should
 * instantiate `STTArchive` against a URL instead.
 *
 * See loaders.gl's loader-object-format spec for the field contract:
 *   https://loaders.gl/docs/specifications/loader-object-format
 */

import { STTArchive } from './archive';
import type { ArchiveIndex, ArchiveMetadata } from './types';

/** STT magic prefix used for `tests` content-sniffing. */
const STT_MAGIC = new Uint8Array([0x53, 0x54, 0x54]); // "STT"

/** Result of `SttLoader.parse(arrayBuffer)`. */
export interface ParsedSTT {
  metadata: ArchiveMetadata;
  index: ArchiveIndex;
  /**
   * Reader bound to the in-memory archive bytes. Use it to pull individual
   * tile payloads — same API as a URL-backed `STTArchive`.
   */
  archive: STTArchive;
}

/**
 * Minimal structural shape of a loaders.gl `LoaderWithParser`. Kept in-tree
 * so we don't pull `@loaders.gl/loader-utils` into `@stt/core`. The fields
 * are the v4.x required + commonly-set optional set.
 */
export interface SttLoaderShape<DataT = unknown> {
  name: string;
  id: string;
  module: string;
  version: string;
  extensions: string[];
  mimeTypes: string[];
  category?: string;
  binary?: boolean;
  text?: boolean;
  tests?: (ArrayBuffer | string | ((buf: ArrayBuffer) => boolean))[];
  options: Record<string, unknown>;
  parse: (
    arrayBuffer: ArrayBuffer,
    options?: unknown,
    context?: { url?: string },
  ) => Promise<DataT>;
  parseSync?: (
    arrayBuffer: ArrayBuffer,
    options?: unknown,
    context?: { url?: string },
  ) => DataT;
}

/** Build a synthetic `fetch` that serves Range requests from `bytes`. */
function bufferRangeFetch(bytes: Uint8Array): typeof fetch {
  const total = bytes.byteLength;
  const body = (start: number, end: number): ArrayBuffer => {
    // Copy into a fresh ArrayBuffer — `bytes.buffer` may be a
    // SharedArrayBuffer (newer TS lib defs reject that for `Response`).
    const len = end - start;
    const out = new ArrayBuffer(len);
    new Uint8Array(out).set(bytes.subarray(start, end));
    return out;
  };
  return async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const range = headers.get('Range') || headers.get('range');
    if (!range) {
      return new Response(body(0, total), { status: 200 });
    }
    const m = /bytes=(\d+)-(\d+)/.exec(range);
    if (!m) return new Response(body(0, total), { status: 200 });
    const start = Number(m[1]);
    const endExclusive = Math.min(Number(m[2]) + 1, total);
    const buf = body(start, endExclusive);
    return new Response(buf, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${endExclusive - 1}/${total}`,
        'Content-Length': String(buf.byteLength),
      },
    });
  };
}

async function parseSttArchive(
  arrayBuffer: ArrayBuffer,
  url?: string,
): Promise<ParsedSTT> {
  const bytes = new Uint8Array(arrayBuffer);
  if (
    bytes.byteLength < STT_MAGIC.length ||
    bytes[0] !== STT_MAGIC[0] ||
    bytes[1] !== STT_MAGIC[1] ||
    bytes[2] !== STT_MAGIC[2]
  ) {
    throw new Error('SttLoader: not an STT archive (bad magic)');
  }
  const archive = new STTArchive({
    url: url ?? 'memory://stt-archive',
    fetch: bufferRangeFetch(bytes),
  });
  const [metadata, index] = await Promise.all([
    archive.getMetadata(),
    archive.getIndex(),
  ]);
  return { metadata, index, archive };
}

/**
 * loaders.gl-conformant Loader for STT archives.
 *
 * Use with deck.gl's `loaders` prop:
 * ```ts
 * import { SttLoader } from '@stt/core';
 * new TileLayer({ data: url, loaders: [SttLoader] });
 * ```
 */
export const SttLoader: SttLoaderShape<ParsedSTT> = {
  name: 'STT',
  id: 'stt',
  module: 'stt',
  // Kept in lock-step with the package version — no build-time replacement
  // because @stt/core ships pre-bundled types and that machinery would add
  // a tsc plugin for ~zero user-visible value.
  version: '0.1.0',
  extensions: ['stt'],
  mimeTypes: ['application/x-stt', 'application/octet-stream'],
  category: 'geometry',
  binary: true,
  options: { stt: {} },
  tests: [STT_MAGIC.buffer.slice(0)],
  parse: (arrayBuffer, _options, context) =>
    parseSttArchive(arrayBuffer, context?.url),
};

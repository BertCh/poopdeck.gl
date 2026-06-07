// @stt/core
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/core contributors

/**
 * SttLoader — loaders.gl-conformant Loader for STT datasets.
 *
 * Structurally matches `LoaderWithParser` from `@loaders.gl/loader-utils`
 * (v4.x) without taking a hard dep on it, so consumers using deck.gl /
 * loaders.gl can do `TileLayer({ loaders: [SttLoader] })` while consumers
 * that just want `STTArchive` directly pay nothing extra.
 *
 * IMPORTANT — packed format: STT is no longer a single `.stt` blob. A dataset
 * is now a multi-object packed directory (`manifest.json` + `index/<hash>.sttd`
 * + `packs/<hash>.sttp`; see `docs/spec/stt-packed-format.md`). A lone
 * `ArrayBuffer` therefore does NOT map to a readable dataset — the reader needs
 * a manifest URL, not one buffer. So the whole-buffer `parse(arrayBuffer)` path
 * is obsolete and throws a clear, actionable error directing callers to
 * `new STTArchive(manifestUrl)`. The remaining value of this object is the
 * loaders.gl Loader *shape* (name/id/extensions/mimeTypes) for registration;
 * actual reading goes through `STTArchive` / `STTArchive.asTileSource()`.
 *
 * See loaders.gl's loader-object-format spec for the field contract:
 *   https://loaders.gl/docs/specifications/loader-object-format
 */

import { STTArchive } from './archive';
import type { ArchiveIndex, ArchiveMetadata } from './types';

/** STT magic prefix used for `tests` content-sniffing. */
const STT_MAGIC = new Uint8Array([0x53, 0x54, 0x54]); // "STT"

/**
 * Result shape retained for type compatibility. The packed format no longer
 * produces this from a single buffer (`parse` throws — see the file docstring);
 * it's kept so downstream type imports don't break and so a future packed-aware
 * loader could populate it from a manifest URL.
 */
export interface ParsedSTT {
  metadata: ArchiveMetadata;
  index: ArchiveIndex;
  /**
   * Reader bound to the packed dataset. Same API as a URL-backed `STTArchive`.
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

/**
 * Error thrown by the obsolete whole-buffer `parse(arrayBuffer)` path.
 *
 * Under the packed format a single buffer is NOT a dataset — the reader needs
 * a `manifest.json` URL that resolves its `index/` + `packs/` siblings. The
 * message is deliberately actionable: it names the replacement API so a caller
 * porting from the single-file format knows exactly what to do.
 */
const PACKED_PARSE_ERROR =
  'SttLoader.parse(arrayBuffer) is no longer supported: STT is now a packed ' +
  'multi-object format (manifest.json + index/ + packs/), so a single buffer ' +
  'is not a readable dataset. Construct `new STTArchive(manifestUrl)` ' +
  '(pointing at the dataset\'s manifest.json) instead of parsing a single buffer.';

/**
 * loaders.gl-conformant Loader for STT datasets.
 *
 * The Loader OBJECT (name/id/extensions/mimeTypes/binary/tests) is still useful
 * for registration with deck.gl / loaders.gl, but reading goes through
 * `STTArchive` against a manifest URL:
 * ```ts
 * import { STTArchive } from '@stt/core';
 * const archive = new STTArchive('/data/<stem>/manifest.json');
 * new TileLayer({ ...archive.asTileSource() });
 * ```
 *
 * `parse(arrayBuffer)` REJECTS: a lone buffer can't represent the packed
 * multi-object format (see {@link PACKED_PARSE_ERROR}).
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
  // The packed format has no single-buffer representation. Reject clearly
  // instead of silently mis-reading bytes. (async so callers `await`/`.catch`
  // uniformly.)
  parse: async () => {
    throw new Error(PACKED_PARSE_ERROR);
  },
};

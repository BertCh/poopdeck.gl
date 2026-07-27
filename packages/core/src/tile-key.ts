// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * The only place a tile's string identity is written.
 *
 * THE INVARIANT. A temporal-LOD tile shares `z/x/y/t` with the base tile
 * whose bucket starts at the same instant, but the two carry different
 * payloads (a coarser bucket spans more time). A key that omits `bucketMs`
 * therefore COLLIDES the two tiers in any map keyed by it: whichever tier
 * is stored second wins, and the loser is silently served the other's
 * bytes. Every function here folds the tier into the key; none of them may
 * be reimplemented at a call site.
 *
 * Keys come in three flavours because they answer three different
 * questions. They are separately branded so one cannot be passed where
 * another is expected.
 */

import type { TileId } from './types.js';

/**
 * Identity of one tile as ADDRESSED by a reader — `z/x/y/t` plus the tier
 * the id asks for. Produced only by {@link tileKey}.
 */
export type TileKey = string & { readonly __tileKey: unique symbol };

/**
 * Identity of one directory entry as RECORDED by the writer — `z/x/y/t`
 * plus the entry's own tier tag, where "untagged" is a third state
 * distinct from any bucket width. Produced only by {@link tileEntryKey}.
 */
export type TileEntryKey = string & { readonly __tileEntryKey: unique symbol };

/**
 * Identity of a spatial cell — `z/x/y`, deliberately free of both time and
 * tier, so it names the whole column of entries at that cell. Produced
 * only by {@link tileCellKey}.
 */
export type TileCellKey = string & { readonly __tileCellKey: unique symbol };

/**
 * The address a reader looks a tile up by: byte caches, OPFS entries, and
 * the tileset's cache / needed / priority / prefetch registries.
 *
 * An absent `bucketMs` IS the base tier — the two are one key, so a base
 * id built by hand and one round-tripped through the archive agree.
 * A present `bucketMs` appends `@<width>`, which is what keeps a
 * temporal-LOD (scrub-preview) tile from aliasing its base twin. The
 * coverage index is built from the base-tier enumeration and so is
 * base-keyed; a resident LOD tile therefore can never satisfy base
 * coverage, which is what makes LOD tiles preview-only.
 *
 * PERSISTENCE CONTRACT. `STTArchive` embeds this string in its OPFS cache
 * key. The format is written to disk and read back on the next page load:
 * changing it does not corrupt anything, but it orphans every previously
 * cached tile (a cold cache, not a wrong answer). The archive fingerprint
 * in the surrounding key handles content changes; this part must stay
 * byte-stable across releases for the cache to survive them.
 */
export function tileKey(id: TileId): TileKey {
  return (
    id.bucketMs !== undefined
      ? `${id.z}/${id.x}/${id.y}/${id.t}@${id.bucketMs}`
      : `${id.z}/${id.x}/${id.y}/${id.t}`
  ) as TileKey;
}

/**
 * The key of one archive-directory entry, qualified by the tier tag the
 * writer stamped on it (`temporalBucketMs`).
 *
 * Distinct from {@link tileKey} in what "absent" means. Here `undefined`
 * is a real, separately addressable state: an entry with no tier column
 * (archives built without a temporal-LOD pyramid). Such an entry satisfies
 * a base-tier lookup, but the resolver has to probe for it under its own
 * key rather than conflate it with the base bucket width — so `'base'`
 * occupies a slot no numeric width can produce. In-memory only; no
 * persistence contract.
 */
export function tileEntryKey(
  z: number,
  x: number,
  y: number,
  t: number,
  bucketMs: number | undefined,
): TileEntryKey {
  return `${z}/${x}/${y}/${t}/${bucketMs ?? 'base'}` as TileEntryKey;
}

/**
 * The key of a spatial cell, naming every temporal entry at `z/x/y`.
 *
 * Time and tier are omitted BY DESIGN: this keys the list an interval scan
 * walks when no exact {@link tileEntryKey} matches, so folding either in
 * would defeat its purpose. Callers must filter the returned list by time
 * and tier themselves.
 */
export function tileCellKey(z: number, x: number, y: number): TileCellKey {
  return `${z}/${x}/${y}` as TileCellKey;
}

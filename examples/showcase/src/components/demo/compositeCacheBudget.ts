/**
 * Per-archive decoded-cache budget for COMPOSITE demos (several tilesets on
 * one playhead). Single-archive demos keep the layer defaults untouched.
 *
 * Only the BYTE budget is split by archive count. The tile-COUNT cap stays at
 * the layer default for every archive: a count cap exists for per-tile
 * overhead, and dividing it by N starved small-tile archives while the byte
 * split already bounded memory — `rain-flood-2019` (3 KB tiles) planned a
 * 2,002-tile horizon against a `max(600, ⌊2000/2⌋) = 1,000` split, i.e. 6 MB
 * of payload, and looped evict/refetch forever; `mrms-precip` planned 696
 * against 666. Tile-loading audit 2026-08, findings A2 / A4 / F2 / F11.
 *
 * TODO(core A4): once `maxCacheByteSize` is a process-wide budget shared
 * across tilesets (sized from `deviceMemory`), delete this arithmetic — the
 * per-N byte split exists only because per-tileset budgets have no
 * cross-dataset view.
 */

/** `SpatioTemporalLayer.defaultProps.maxCacheSize` — mirrored, not imported,
 * so the reconcile gate can reason about it without constructing a layer. */
export const LAYER_DEFAULT_MAX_CACHE_SIZE = 2000;
/** `SpatioTemporalLayer.defaultProps.maxCacheByteSize` (2 GiB). */
export const LAYER_DEFAULT_MAX_CACHE_BYTES = 2 * 2 ** 30;
/** Floor of a composite member's byte slice (512 MiB). */
export const COMPOSITE_MIN_CACHE_BYTES = 512 * 2 ** 20;

/**
 * The tile-count cap every archive of a demo actually runs with. Independent
 * of the archive count by design (see the module doc); kept as a function so
 * the reconcile gate and the builder read ONE definition.
 */
export function perArchiveTileCap(_archiveCount: number): number {
  return LAYER_DEFAULT_MAX_CACHE_SIZE;
}

/**
 * Cache props a composite member spreads over its layer props. Returns
 * `undefined` for single-archive demos so the spread is a no-op there.
 */
export function compositeCacheProps(
  archiveCount: number,
): { maxCacheByteSize: number } | undefined {
  if (!(archiveCount > 1)) return undefined;
  return {
    maxCacheByteSize: Math.max(
      COMPOSITE_MIN_CACHE_BYTES,
      Math.floor(LAYER_DEFAULT_MAX_CACHE_BYTES / archiveCount),
    ),
  };
}

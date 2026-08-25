/**
 * Tile-loading props for the scrubber HOVER PREVIEW's layer tree.
 *
 * The preview is a second full render stack: a second archive + tileset per
 * layer, opened with the LIVE demo's cache caps and request budget, that plans
 * the live speed-scaled prefetch from a frozen clock — ~165 MB per hover
 * position on `satellites`, 58 MB on `nyc-taxi-paths`, all competing with the
 * live playback for the 24 shared request slots (tile-loading audit 2026-08,
 * E6 / F6). A preview needs exactly the tiles under the hovered instant and
 * nothing ahead of it, so it gets its own recipe:
 *
 * - `refinementStrategy: 'no-overlap'` — one representation per frame, never a
 *   parent stack held "just in case";
 * - `enablePrefetch: false` (+ `prefetchSteps: 1`) — nothing ahead of a clock
 *   that does not move;
 * - `maxRequests: 4` — a sliver of the shared slots; the live demo keeps the
 *   bandwidth;
 * - `maxCacheSize` / `maxCacheByteSize` — a bounded scratch cache, not a
 *   second copy of the live one;
 * - `overviewPreload: false` — the storyboard tier is the live viewer's.
 *
 * Not expressible today: a lower scheduler weight — the archive has
 * `schedulerWeight` but the layer exposes no prop for it
 * (TODO(owner:packages/layers/src/layers/spatiotemporal-layer.ts): forward a
 * `schedulerWeight` prop into `new STTArchive({...})`).
 *
 * Applied AFTER `buildDemoLayers` returns (via `Layer.clone`) so it lands on
 * top of every composite's per-overlay override — the same recipe for every
 * chassis layer, whatever the demo type.
 */
import type { Layer } from '@deck.gl/core';

export const PREVIEW_TILE_PROPS = {
  refinementStrategy: 'no-overlap',
  enablePrefetch: false,
  prefetchSteps: 1,
  maxRequests: 4,
  maxCacheSize: 200,
  maxCacheByteSize: 128 * 2 ** 20,
  overviewPreload: false,
} as const;

/** Prop keys the preview is allowed to differ from the live tree in. */
export const PREVIEW_TILE_PROP_KEYS = Object.keys(
  PREVIEW_TILE_PROPS,
) as (keyof typeof PREVIEW_TILE_PROPS)[];

/**
 * Whether a layer is an STT tile chassis (owns a tileset + cache). Non-tile
 * overlays (static polygons, ego footprints, …) have no `maxCacheSize` on
 * their default props and are passed through untouched.
 */
export function isTileChassisLayer(layer: Layer): boolean {
  return 'maxCacheSize' in (layer.props as object);
}

/**
 * Re-instantiate every tile chassis layer with the preview recipe on top of
 * its live props. `Layer.clone` is deck's public "same layer, new props" path
 * (it re-applies async-prop originals), so ids, styling and the frozen
 * controller carry over unchanged.
 */
export function withPreviewTileProps<L extends Layer>(layers: L[]): L[] {
  return layers.map((layer) =>
    isTileChassisLayer(layer)
      ? (layer.clone(PREVIEW_TILE_PROPS as unknown as Partial<L['props']>) as L)
      : layer,
  );
}

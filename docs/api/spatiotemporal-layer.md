# SpatioTemporalLayer

The `SpatioTemporalLayer` is the base layer for visualizing spatiotemporal data from STT archives. It handles data loading, caching, time synchronization, and coordinate decoding, allowing subclasses to focus purely on rendering.

It follows the deck.gl [TileLayer](https://deck.gl/docs/api-reference/geo-layers/tile-layer) architecture: a [`SpatioTemporalTileset`](./spatiotemporal-tileset.md) (from `@poopdeck.gl/core`) manages tile selection and request scheduling, while the layer turns visible tiles into sublayers.

## Installation

```typescript
import { SpatioTemporalLayer } from '@poopdeck.gl/layers';
```

## Usage

This is an abstract base layer. Typically, you would use a subclass like [`AnimatedPointLayer`](./animated-point-layer.md) or extend it yourself.

```typescript
class MyCustomLayer extends SpatioTemporalLayer {
  renderLayers() {
    const { tiles } = this.state;
    const currentTime = this.getCurrentTime();
    // ... implementation ...
  }
}
```

Note there is no `DataT` generic, unlike upstream composite layers: tiles are binary (Arrow-backed columnar buffers), so there is no per-row datum type for accessors to receive — `data` is always the archive URL string. Third parties subclass via `class My extends SpatioTemporalLayer<MyExtraProps>`.

The constructor drops own props explicitly set to `undefined` before deck.gl sees them, so `undefined` always means "use the default". (deck.gl resolves defaults through the prototype chain, where an own `undefined` key would otherwise shadow its default — e.g. `new AnimatedPointLayer({ strokeColor: cfg.strokeColor })` with an absent config field would silently disable the default and hand sublayers `undefined` accessors.) This applies to every layer in the family.

## Properties

Inherits from all [CompositeLayer](https://deck.gl/docs/api-reference/core/composite-layer) properties.

### Data Properties

| Property         | Type                             | Default    | Description                                                                                |
| :--------------- | :------------------------------- | :--------- | :----------------------------------------------------------------------------------------- |
| `data`           | `string`                         | `""`       | URL to the STT archive (the packed manifest URL).                                          |
| `currentTime`    | `number`                         | `0`        | Current timestamp in Unix milliseconds.                                                    |
| `timeWindow`     | `number`                         | `86400000` | Time window duration in milliseconds (1 day default).                                      |
| `timeRange`      | `{ start: number; end: number }` | `null`     | Full time range of the dataset (for precision handling).                                   |
| `timeController` | `TimeController`                 | `null`     | Optional [`TimeController`](./time-controller.md) instance to synchronize animation state. |

### Tile Loading Options

| Property           | Type     | Default      | Description                                                                                                                                                                                                                                                                                                                                                                                                        |
| :----------------- | :------- | :----------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxRequests`      | `number` | `24`         | Maximum concurrent in-flight HTTP Range requests. This is the SINGLE concurrency knob: it is threaded into the archive's range coalescer as `maxConcurrentRequests`, so it bounds actual fetch concurrency. 24 is tuned for HTTP/2/3 multiplexing against object storage (R2 caps ~75 streams/connection) — high enough to fill a viewport in one round-trip, low enough to stay under per-connection stream caps. |
| `debounceTime`     | `number` | `0`          | Debounce time (ms) for viewport updates. 0 keeps animation responsive.                                                                                                                                                                                                                                                                                                                                             |
| `maxCacheSize`     | `number` | `2000`       | Maximum number of tiles to keep in the LRU cache.                                                                                                                                                                                                                                                                                                                                                                  |
| `maxCacheByteSize` | `number` | `2147483648` | Maximum decoded cache size in bytes (2 GiB).                                                                                                                                                                                                                                                                                                                                                                       |

### Prefetch Options

| Property         | Type      | Default | Description                                                                                                                                                                        |
| :--------------- | :-------- | :------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enablePrefetch` | `boolean` | `true`  | Enable predictive prefetching for smooth animation playback.                                                                                                                       |
| `prefetchAhead`  | `number`  | `30000` | How far ahead to prefetch in animation time (milliseconds). Sized for a few real-time seconds of buffer; the tileset additionally scales lookahead by the measured playback speed. |
| `prefetchSteps`  | `number`  | `4`     | Number of time-window steps to prefetch ahead.                                                                                                                                     |

### Tier dispatch

| Property | Type                           | Default  | Description                        |
| :------- | :----------------------------- | :------- | :--------------------------------- |
| `tier`   | `'auto' \| 'summary' \| 'raw'` | `'auto'` | Which tier the tileset draws from. |

Applies only to archives carrying a server-aggregated summary tier
(`stt-build --summary-tier`); on any other archive the prop has no effect.
`'auto'` uses the summary tier at zooms inside its `[minZoom, maxZoom]` band and
the raw tier above it, so a wide low-zoom view streams a few thousand aggregated
cells instead of millions of raw features. `'summary'` and `'raw'` pin one tier.

### Level of detail

| Property  | Type                              | Default             | Description                           |
| :-------- | :-------------------------------- | :------------------ | :------------------------------------ |
| `lodMode` | `'parent-fallback' \| 'additive'` | `'parent-fallback'` | How tiles compose across zoom levels. |

`'parent-fallback'` renders the single best zoom for the current viewport,
keeping coarser parents only as a transient fallback until matching detail
streams in.

`'additive'` renders the union of zoom levels `[minZoom..cameraZoom]` and keeps
every level resident. Use it for additive-octree point clouds built with
`stt-build --min-zoom-field=--max-zoom-field=<home_zoom column>`, where each
point lives at exactly one zoom: coarse tiles are a sparse overview and finer
tiles add only the residual, so zooming in streams new detail without re-fetching
the coarse cloud.

Threaded straight to `SpatioTemporalTilesetOptions.lodMode`.

### Scrub-LOD (motion tier)

| Property   | Type                                                                          | Default | Description                        |
| :--------- | :---------------------------------------------------------------------------- | :------ | :--------------------------------- |
| `scrubLod` | `{ spatial?: boolean; spatialZoomDrop?: number; temporal?: boolean } \| null` | `null`  | Opt-in scrub-time LOD degradation. |

While the user drags the timeline, tile selection may drop to a cheaper preview
tier:

- `spatial` requests a coarser zoom — `spatialZoomDrop` levels, default 2,
  clamped to `[0, 4]` — usually tiles the parent-fallback path already fetched.
- `temporal` routes selection through the archive's temporal-LOD pyramid. It
  requires an archive built with `stt-build --temporal-lod` and silently no-ops
  otherwise. The axis auto-wires the tileset's `temporalLodLevels` and
  `getAvailableTemporalLodTiles` from `ArchiveMetadata.temporalLod` when the
  archive carries the pyramid.

The degraded tier is preview-only: the buffered-runway and gate math and the
prefetch planner keep tracking the fine tier, and release restores it. `null`
(the default) is the kill switch — scrub state is stored but changes nothing.

Threaded straight to `SpatioTemporalTilesetOptions.scrubLod`; see the tileset's
[`ScrubLodOptions`](./spatiotemporal-tileset.md#scrub-lod-motion-tier) for exact
field semantics.

### GlobeView / projection helpers

| Property          | Type             | Default | Description                                                                                                              |
| :---------------- | :--------------- | :------ | :----------------------------------------------------------------------------------------------------------------------- |
| `zoomOverride`    | `number \| null` | `null`  | Force a specific tile zoom level (useful for `GlobeView` to load low-zoom tiles). `null` derives zoom from the viewport. |
| `useGlobalBounds` | `boolean`        | `false` | Use whole-world bounds instead of viewport bounds (for `GlobeView`).                                                     |

### Time-as-height (space-time cube)

| Property           | Type     | Default | Description                                                                                                                                                                                                                                                                                                                                                                           |
| :----------------- | :------- | :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `timeHeightScale`  | `number` | `0`     | Meters of altitude per simulation millisecond. When non-zero, the trips/path/point layers lift each vertex by `(featureTime - timeHeightOrigin) * timeHeightScale` meters — per-vertex time on trail-mode trips (threads climb along their length, slope = speed), per-feature start time elsewhere. Animating this value morphs between the flat map (0) and the cube. MapView only. |
| `timeHeightOrigin` | `number` | `0`     | Absolute time (Unix ms) rendered at altitude 0, typically `timeRange.start`.                                                                                                                                                                                                                                                                                                          |

### Overview (storyboard) preload

| Property            | Type                                                    | Default | Description                                   |
| :------------------ | :------------------------------------------------------ | :------ | :-------------------------------------------- |
| `overviewPreload`   | `boolean \| { budgetBytes?: number; maxZoom?: number }` | `false` | Preload and pin the coarsest tiles.           |
| `onOverviewPreload` | `(result: OverviewPreloadResult) => void`               | `null`  | Fires once per tileset init with the outcome. |

When `overviewPreload` is truthy the layer calls `tileset.preloadOverviewTier()`
right after tileset init: the coarsest tiles (z0..`maxZoom`, default 1) across the
full dataset time range are loaded at the lowest request tier and pinned. Scrubbing
then always renders a coarse preview through the parent-zoom fallback — the data
analog of a video player's thumbnail strip.

The preload is budget-gated per dataset (default 20 MiB of directory bytes), so
datasets with giant coarse tiles are rejected without fetching anything. Init is
never blocked on it.

`onOverviewPreload` reports what happened: whether it loaded, the candidate tile
count, the directory byte sum, and the rejection reason when skipped. It fires
only when `overviewPreload` is truthy.

### Callbacks

| Property         | Type                                                      | Description                                                                                                                                                                                                                                                                                   |
| :--------------- | :-------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onViewportLoad` | `(tiles: Tile[]) => void`                                 | Called when all tiles in the current viewport×window selection have finished loading (the `TileLayer.onViewportLoad` moment). Fires once per selection settle — again only after the selection itself changes (pan/zoom or the time window crossing a bucket) and re-settles, never per tile. |
| `onTileLoad`     | `(tile: Tile) => void`                                    | Called when a single tile successfully loads.                                                                                                                                                                                                                                                 |
| `onTileUnload`   | `(tile: Tile) => void`                                    | Called when a tile is evicted from the cache.                                                                                                                                                                                                                                                 |
| `onTileError`    | `(error: Error, tileId?: TileId) => void`                 | Called when a tile's fetch/decode fails after the loader's retries. `tileId` is `undefined` for dataset-level failures (a selection pass that could not query the directory). Default (`null`) logs via `console.error`, matching TileLayer.                                                  |
| `onTilesetReady` | `(tileset: SpatioTemporalTileset & BufferSource) => void` | Fired ONCE per archive/tileset initialization (and again if `data` changes), with the live tileset. The tileset satisfies the [`BufferSource`](./playback-governor.md) readiness contract, so apps hand it straight to a `PlaybackGovernor` via `governor.setSource(tileset)`.                |
| `onBufferChange` | `(runway: BufferedRunway) => void`                        | Forwarded from the tileset's buffer bookkeeping: fires when the buffered runway around the playhead crosses a threshold (not per tile load). Forward this to `PlaybackGovernor.notifyBufferChange(runway)` so gating reacts immediately instead of waiting for the governor's poll cadence.   |

### Advanced Options

| Property      | Type             | Default | Description                                                                                                                                                                                                                                                                                                                                 |
| :------------ | :--------------- | :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `loadOptions` | `SttLoadOptions` | `{}`    | loaders.gl-style options. Only `loadOptions.fetch` is consumed: the OBJECT form (`RequestInit`) is merged into every HTTP request the archive makes (manifest, directory, pack ranges) — auth headers, credentials, CORS mode; per-request fields like the `Range` header always win. A fetch-like FUNCTION replaces the transport instead. |

## Methods

### `getCurrentTime(): number`

Get the current animation time. Subclasses should use this instead of accessing state directly for performance (avoids setState overhead during animation).

### `isLoaded: boolean`

Property indicating whether the layer currently has visible tiles.

### `getPickingInfo(params): SpatioTemporalPickingInfo`

TileLayer-convention picking enrichment. A hit fills `info.tile` / `info.sourceTile` with the source tile and decodes ONE feature's binary columns into a plain `info.object` (via `getFeatureProperties` from `@poopdeck.gl/core`) at event rate, so the render path stays free of per-feature objects.

### Subclass hooks

| Hook                                                | Description                                                                                                                                                                   |
| :-------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `renderLayers()`                                    | Override to render visualization sublayers from `this.state.tiles`.                                                                                                           |
| `onMetadataLoaded(metadata)`                        | Called once per archive init, right after metadata arrives (and after the supersession race guard).                                                                           |
| `getTilesetOptionOverrides(metadata)`               | Partial `SpatioTemporalTilesetOptions` spread over the base tileset wiring at construction time (overrides win). How `H3SummaryLayer` swaps zoom range / refinement strategy. |
| `getEffectiveTimeWindow()`                          | The time window used for tile loading. `AnimatedTripsLayer` overrides it to `max(timeWindow, 2 × trailLength)`.                                                               |
| `composeSubLayerProps(shortId, instanceKey, props)` | Composes one sublayer's props through deck's `CompositeLayer.getSubLayerProps()` so inherited composite props and the user's `_subLayerProps[shortId]` overrides apply.       |
| `composeExtensions(internal)`                       | Appends the user's top-level `extensions` after the layer's internal extension list — the hook that makes custom deck.gl extensions work (see below).                         |

## Custom deck.gl extensions

Every animated layer carries internal, load-bearing extensions on its
sublayers (`TimeFilterExtension` + `CategoryColorExtension`; the heatmap a
deck's own `DataFilterExtension`). Extensions you pass via the standard top-level
`extensions` prop are **appended after** the internal ones and reach every
sublayer:

```typescript
new AnimatedPointLayer({
  // ...,
  extensions: [new CollisionFilterExtension()],
  // sublayers receive [timeFilter, categoryColor, collisionFilter]
});
```

Adding/removing an extension rebuilds the cached sublayers; equal extensions
re-instantiated each render (`extensions: [new Ext()]` inline) are digested by
constructor + options and do NOT thrash the caches. Keep the list short — the
extension set participates in deck.gl's shader-pipeline cache key.

A `_subLayerProps.<shortId>.extensions` override still REPLACES the whole
list (deck's contract) and emits a one-time warning when it drops an internal
extension class, since that silently disables time filtering / categorical
color. Prefer the top-level prop unless you really mean to replace.

Sublayer short ids for `_subLayerProps` / `getSubLayerClass` overrides:
`points`, `paths`, `trips` (also FlowCorridorLayer), `polygons`, `heatmap`,
`hexagons`.

## Performance

The layer is optimized for high-performance animation:

- **Single concurrency knob**: `maxRequests` (24) bounds the archive's
  in-flight HTTP Range requests; viewport fills are sent as ONE
  globally-coalesced batch (`STTArchive.getTiles`), so Hilbert-adjacent
  tiles collapse into a handful of range requests with incremental
  per-tile delivery.
- **Prefetching**: tiles are loaded ahead of playback time in
  throughput-sized slices, aligned with the archive's temporal bucket
  boundaries; prefetch requests carry `fetchpriority: low`.
- **Parent-tile gating**: oversized low-zoom fallback tiles (> 2 MB by
  default) are skipped before fetching — a 14 MB z10 tile is a
  near-useless placeholder under a z14 view.
- **LRU caching**: 2000-tile / 2 GiB cache; eviction respects the active
  time window so tiles needed by the current animation frame aren't
  dropped.
- **Time updates via getter**: passing `timeController` avoids React
  re-renders during animation — sublayers read time in `draw()` through
  the extension's `getTime` callback, and tick-driven tileset refreshes
  are capped at ~10 Hz wall-clock regardless of playback speed.
- **Coalesced tile arrivals**: many tiles finishing within one frame are
  batched into a single rAF-deferred `setState`, and a
  reordered-but-identical tile set never triggers a rebuild.

## Source

[packages/layers/src/layers/spatiotemporal-layer.ts](../../packages/layers/src/layers/spatiotemporal-layer.ts)

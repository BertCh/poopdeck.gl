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

| Property             | Type                             | Default    | Description                                                                                                                                                                                                                                                                                                                                                                                               |
| :------------------- | :------------------------------- | :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data`               | `string`                         | `""`       | URL to the STT archive (the packed manifest URL).                                                                                                                                                                                                                                                                                                                                                         |
| `currentTime`        | `number`                         | `0`        | Current timestamp in Unix milliseconds.                                                                                                                                                                                                                                                                                                                                                                   |
| `timeWindow`         | `number`                         | `86400000` | Total width of the render window, CENTRED on `currentTime`: a feature is lit when its `[start, end]` overlaps `currentTime ± timeWindow/2`. 1 day default.                                                                                                                                                                                                                                                |
| `tileLoadTimeWindow` | `number`                         | `0`        | Widens the tile-SELECTION window without widening the render window (`0` = follow `timeWindow`). Selection refreshes at most once per 100 ms of wall clock, so a frame-sequence archive whose `timeWindow` is a single frame renders nothing for most of playback unless this is set to a few hundred ms. Extra resident tiles are cheap — features outside `timeWindow` are still discarded per feature. |
| `timeRange`          | `{ start: number; end: number }` | `null`     | Full time range of the dataset (for precision handling).                                                                                                                                                                                                                                                                                                                                                  |
| `timeController`     | `TimeController`                 | `null`     | Optional [`TimeController`](./time-controller.md) instance to synchronize animation state.                                                                                                                                                                                                                                                                                                                |

### Tile Loading Options

| Property             | Type                               | Default            | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| :------------------- | :--------------------------------- | :----------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxRequests`        | `number`                           | `24`               | Maximum concurrent in-flight HTTP Range requests. This is the SINGLE concurrency knob: it is threaded into the archive's range coalescer as `maxConcurrentRequests`, so it bounds actual fetch concurrency. 24 is tuned for HTTP/2/3 multiplexing against object storage (R2 caps ~75 streams/connection) — high enough to fill a viewport in one round-trip, low enough to stay under per-connection stream caps.                                                                                                                  |
| `debounceTime`       | `number`                           | `0`                | Debounce time (ms) for viewport updates. 0 keeps animation responsive.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `maxCacheSize`       | `number`                           | `2000`             | Maximum number of tiles to keep in the LRU cache.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `maxCacheByteSize`   | `number`                           | `2147483648`       | Maximum decoded cache size in bytes (2 GiB).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `refinementStrategy` | `'best-available' \| 'no-overlap'` | `'best-available'` | Parent-fallback fetch policy (deck.gl `TileLayer` vocabulary). `'best-available'` also fetches parent tiles up to 4 zooms back so coarse data shows while the primary tiles stream. `'no-overlap'` fetches EXACTLY the viewport zoom — the right choice for full-duplication archives (the no-thinning default), where each parent level is a complete extra copy of the visible data: 4 fallback levels ≈ 5× the fetch, decode and vertex load for zero information gain, at the cost of blank tiles until their own zoom arrives. |
| `tileCommitBudgetMs` | `number`                           | `6`                | Upper bound, in wall ms, on the per-tile prepare (`warmTile`) work committed per animation frame; the rest is carried to later frames, nearest-to-playhead first, while committed tiles keep drawing. `0` commits the whole batch at once.                                                                                                                                                                                                                                                                                          |
| `schedulerWeight`    | `number`                           | `1`                | This layer's share of the process-shared request scheduler's weighted-fair (DRR) slot budget when several archives composite into one scene. Work-conserving — a lone archive gets the whole budget whatever its weight. Construction-only.                                                                                                                                                                                                                                                                                         |

### Prefetch Options

| Property         | Type      | Default | Description                                                                                                                                                                        |
| :--------------- | :-------- | :------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enablePrefetch` | `boolean` | `true`  | Enable predictive prefetching for smooth animation playback.                                                                                                                       |
| `prefetchAhead`  | `number`  | `30000` | How far ahead to prefetch in animation time (milliseconds). Sized for a few real-time seconds of buffer; the tileset additionally scales lookahead by the measured playback speed. |
| `prefetchSteps`  | `number`  | `4`     | Number of time-window steps to prefetch ahead.                                                                                                                                     |

### Tier dispatch

**`tier`** — `'auto' | 'summary' | 'raw'`, default `'auto'`. Which tier the
tileset draws from.

Applies only to archives carrying a server-aggregated summary tier
(`stt-build --summary-tier`); on any other archive the prop has no effect.
`'auto'` uses the summary tier at zooms inside its `[minZoom, maxZoom]` band and
the raw tier above it, so a wide low-zoom view streams a few thousand aggregated
cells instead of millions of raw features. `'summary'` and `'raw'` pin one tier.

### Level of detail

**`lodMode`** — `'parent-fallback' | 'additive'`, default `'parent-fallback'`.
How tiles compose across zoom levels.

`'parent-fallback'` renders the single best zoom for the current viewport,
keeping coarser parents only as a transient fallback until matching detail
streams in.

`'additive'` renders the union of zoom levels `[minZoom..cameraZoom]` and keeps
every level resident. Use it for additive-octree point clouds — archives whose
features each live at exactly one zoom. Build them with `stt-build
--additive-lod` (which declares `metadata.partition = "home-zoom"` and the
must-understand `additive-partition` capability), or hand-confine each feature
to one zoom with `--min-zoom-field <col> --max-zoom-field <col>` pointed at the
same home-zoom column. Coarse tiles are then a sparse overview and finer tiles
add only the residual, so zooming in streams new detail without re-fetching the
coarse cloud.

Threaded straight to `SpatioTemporalTilesetOptions.lodMode`.

### Scrub-LOD (motion tier)

**`scrubLod`** — `{ spatial?: boolean; spatialZoomDrop?: number; temporal?: boolean } | null`,
default `null`. Opt-in scrub-time LOD degradation.

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

**`temporalTierPolicy`** — `'zoom-threshold' | 'cost-argmin'`, default
`'zoom-threshold'`. Which tier the temporal axis addresses: the incumbent zoom
threshold, or an argmin over every tier priced exactly off the archive directory
(zero network), falling back to the threshold when a tier cannot be priced.
Inert unless `scrubLod.temporal` is on. Construction-only, like `scrubLod`.

### GlobeView / projection helpers

| Property          | Type             | Default | Description                                                                                                              |
| :---------------- | :--------------- | :------ | :----------------------------------------------------------------------------------------------------------------------- |
| `zoomOverride`    | `number \| null` | `null`  | Force a specific tile zoom level (useful for `GlobeView` to load low-zoom tiles). `null` derives zoom from the viewport. |
| `useGlobalBounds` | `boolean`        | `false` | Use whole-world bounds instead of viewport bounds (for `GlobeView`).                                                     |

### Viewport and camera

| Property             | Type                       | Default  | Description                                                                                                                                                                                                                                                                                                    |
| :------------------- | :------------------------- | :------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zRange`             | `[number, number] \| null` | `null`   | Altitude slab the viewport box is dilated over (upstream `TileLayer.zRange`). Set it for extruded, volumetric or time-as-height content whose geometry sits above z=0 under pitch — nothing is derived automatically. Requires a viewport exposing `getBounds({z})`.                                           |
| `viewportCellBudget` | `number`                   | `256`    | Cap on the tile CELLS the viewport box may enumerate at the selected zoom; over it, the zoom steps DOWN (never below the archive's `minZoom`) — the selection stays complete, only its resolution drops. Inert below roughly pitch 65. `Infinity` disables it; `useGlobalBounds` and `zoomOverride` bypass it. |
| `selectionMode`      | `'aabb' \| 'frustum'`      | `'aabb'` | How the camera becomes a tile selection. `'aabb'` is the incumbent four-corner lon/lat box at one integer zoom. `'frustum'` walks the tile quadtree against the real frustum planes and selects the mixed-zoom cut, and falls back to `'aabb'` on its own for any viewport it cannot vouch for.                |

### Time-as-height (space-time cube)

| Property           | Type             | Default | Description                                                                                                                                                                                                                                                                                                                                                                           |
| :----------------- | :--------------- | :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `timeHeightScale`  | `number`         | `0`     | Meters of altitude per simulation millisecond. When non-zero, the trips/path/point layers lift each vertex by `(featureTime - timeHeightOrigin) * timeHeightScale` meters — per-vertex time on trail-mode trips (threads climb along their length, slope = speed), per-feature start time elsewhere. Animating this value morphs between the flat map (0) and the cube. MapView only. |
| `timeHeightOrigin` | `number \| null` | `null`  | Absolute time (Unix ms) rendered at altitude 0. `null` (the default) anchors altitude 0 at each tile's own `timeOffset`, which is what keeps the lift f32-representable; a literal `0` is the Unix epoch and is ignored as if unset. Pass a value near the data (e.g. `timeRange.start`) only when a dataset-wide anchor is required.                                                 |

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

| Property         | Type                                                      | Description                                                                                                                                                                                                                                                                                                                                                                                  |
| :--------------- | :-------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onViewportLoad` | `(tiles: Tile[]) => void`                                 | Called when all tiles in the current viewport×window selection have finished loading (the `TileLayer.onViewportLoad` moment). Fires once per selection settle — again only after the selection itself changes (pan/zoom or the time window crossing a bucket) and re-settles, never per tile.                                                                                                |
| `onTileLoad`     | `(tile: Tile) => void`                                    | Called when a single tile successfully loads.                                                                                                                                                                                                                                                                                                                                                |
| `onTileUnload`   | `(tile: Tile) => void`                                    | Called when a tile is evicted from the cache.                                                                                                                                                                                                                                                                                                                                                |
| `onTileError`    | `(error: Error, tileId?: TileId) => void`                 | Called when a tile's fetch/decode fails after the loader's retries. `tileId` is `undefined` for dataset-level failures (a selection pass that could not query the directory). Default (`null`) logs via `console.error`, matching TileLayer.                                                                                                                                                 |
| `onMetadataLoad` | `(meta: ArchiveMetadata) => void`                         | Fired ONCE per archive init (and again if `data` changes), with the archive's decoded metadata — time range, bounds, zoom range, temporal bucket, summary tier, style hints, and `layers[].properties`, the column inventory. This is how you find out which column names a dataset accepts for `radius` / `fillColor` / `elevationProperty` without fetching a tile or installing the CLIs. |
| `onTilesetReady` | `(tileset: SpatioTemporalTileset & BufferSource) => void` | Fired ONCE per archive/tileset initialization (and again if `data` changes), with the live tileset. The tileset satisfies the [`BufferSource`](./playback-governor.md) readiness contract, so apps hand it straight to a `PlaybackGovernor` via `governor.setSource(tileset)`.                                                                                                               |
| `onBufferChange` | `(runway: BufferedRunway) => void`                        | Forwarded from the tileset's buffer bookkeeping: fires when the buffered runway around the playhead crosses a threshold (not per tile load). Forward this to `PlaybackGovernor.notifyBufferChange(runway)` so gating reacts immediately instead of waiting for the governor's poll cadence.                                                                                                  |

### Advanced Options

| Property      | Type             | Default | Description                                                                                                                                                                                                                                                                                                                                 |
| :------------ | :--------------- | :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `loadOptions` | `SttLoadOptions` | `{}`    | loaders.gl-style options. Only `loadOptions.fetch` is consumed: the OBJECT form (`RequestInit`) is merged into every HTTP request the archive makes (manifest, directory, pack ranges) — auth headers, credentials, CORS mode; per-request fields like the `Range` header always win. A fetch-like FUNCTION replaces the transport instead. |

## Methods and getters

### `getCurrentTime(): number`

Get the current animation time. Subclasses should use this instead of accessing state directly for performance (avoids setState overhead during animation).

### `isLoaded: boolean` (getter)

deck's `TileLayer` readiness contract: true once the current viewport×window
selection has settled AND deck's own async props/sublayers are resolved
(`tileset.isLoaded && super.isLoaded`). An empty-but-settled selection — panned
over open ocean — IS loaded, and failed tiles count as settled. False until the
tileset exists. `state.tiles.length > 0` is NOT this predicate.

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

Which internal, load-bearing extensions a layer installs on its sublayers
varies by layer. `TimeFilterExtension` (GPU time window + fade) is carried by
the point, path, polygon, arc, line, column, icon, point-cloud and trips
families — `FlowCorridorLayer` and `FlowStrokeLayer` included.
`CategoryColorExtension` (GPU palette lookup) is carried by the point, polygon,
arc, line, column and icon layers, and by `AnimatedTripsLayer` only while no
`filterProperty` is set (`FlowStrokeLayer` also drops it at its default
`offsetWidths`, to pay for the path offset instead);
`AnimatedPathLayer` and `AnimatedPointCloudLayer` deliberately never
install it — paths resolve categorical color per vertex on the CPU (PathLayer
instances are segments, so a per-feature category index would under-size the
draw), and point clouds are lit, where the extension would write color after
lighting. On top of those, `STTDataFilterExtension` is added when
`filterProperty` is set, and `SplatExtension` when `splat` is on. The heatmap
and hexbin layers instead carry deck's own `DataFilterExtension`; the summary,
text, trip-heads, mesh, scenegraph, bounding-box and splat layers install none
at all (their visibility is a CPU membership test, or the tier is
pre-aggregated), and the flowmap composites ignore a forwarded `extensions`
prop entirely. Extensions you pass via the standard top-level `extensions` prop
are **appended after** the internal ones and reach every sublayer:

```typescript
new AnimatedPointLayer({
  // ...,
  extensions: [new CollisionFilterExtension()],
  // sublayers receive [timeFilter, categoryColor, collisionFilter]
});
```

An extension whose CLASS the layer already applies internally is dropped, with
a one-time warning: passing your own `TimeFilterExtension`,
`CategoryColorExtension`, `STTDataFilterExtension` or `SplatExtension` cannot
work, because deck copies its class `defaultProps` off the composite onto every
sublayer and they would overwrite the per-tile wiring the chassis installed
(`getTime: null`, `timeOffset: 0`) — absolute epoch ms compared against
tile-RELATIVE f32 time attributes, and the layer renders blank. Configure those
through the layer's own props instead.

Adding/removing an extension rebuilds the cached sublayers; equal extensions
re-instantiated each render (`extensions: [new Ext()]` inline) are digested by
constructor + options and do NOT thrash the caches. Keep the list short — the
extension set participates in deck.gl's shader-pipeline cache key.

A `_subLayerProps.<shortId>.extensions` override still REPLACES the whole
list (deck's contract) and emits a one-time warning when it drops an internal
extension class, since that silently disables time filtering / categorical
color. Prefer the top-level prop unless you really mean to replace.

Sublayer short ids for `_subLayerProps` / `getSubLayerClass` overrides, by
owning layer:

| Short id                               | Owner                                                        |
| :------------------------------------- | :----------------------------------------------------------- |
| `points`                               | `AnimatedPointLayer` (incl. cumulative slabs, interp)        |
| `paths`                                | `AnimatedPathLayer`                                          |
| `trips`                                | `AnimatedTripsLayer`, `FlowCorridorLayer`, `FlowStrokeLayer` |
| `heads`                                | `AnimatedTripHeadsLayer`                                     |
| `polygons`, `outline`                  | `AnimatedPolygonLayer`                                       |
| `lines`                                | `AnimatedLineLayer`                                          |
| `arcs`                                 | `AnimatedArcLayer`                                           |
| `icons`                                | `AnimatedIconLayer`                                          |
| `text`                                 | `AnimatedTextLayer`                                          |
| `columns`                              | `AnimatedColumnLayer`                                        |
| `pointCloud`                           | `AnimatedPointCloudLayer`                                    |
| `splats`                               | `SplatLayer`                                                 |
| `mesh`                                 | `AnimatedMeshLayer`                                          |
| `scenegraph`                           | `AnimatedScenegraphLayer`                                    |
| `boxes`, `edges`, `labels`, `velocity` | `AnimatedBoundingBoxLayer`                                   |
| `heatmap`                              | `AnimatedHeatmapLayer` (one per channel)                     |
| `hexbin`                               | `AnimatedHexagonLayer`                                       |
| `hexagons`                             | `H3SummaryLayer`                                             |
| `quadbins`                             | `QuadbinSummaryLayer`                                        |
| `flows`, `nodes`                       | `FlowmapLayer`, `BundledFlowmapLayer`                        |

## Performance

The layer is optimized for high-performance animation:

- **Single concurrency knob**: `maxRequests` (24) bounds in-flight HTTP
  Range requests; viewport fills are sent as ONE globally-coalesced batch
  (`STTArchive.getTiles`), so Hilbert-adjacent tiles collapse into a
  handful of range requests with incremental per-tile delivery.
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

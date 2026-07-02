# How `@poopdeck.gl/layers` relates to TileLayer

If you already use deck.gl, the natural question is: why isn't
`SpatioTemporalLayer` just a
[`TileLayer`](https://deck.gl/docs/api-reference/geo-layers/tile-layer) with a
custom `getTileData`? This page answers that for someone evaluating STT — what
maps 1:1, what is deliberately different and why, and where the layer family
departs from stock deck.gl conventions.

The short version: `SpatioTemporalLayer` is a `CompositeLayer` that plays the
same role as `TileLayer` (viewport-driven tile streaming feeding sublayers),
keeps its prop vocabulary deliberately close, but replaces `Tileset2D` +
`RequestScheduler` with a time-aware tileset — because a temporal axis changes
the request scheduling problem, not just the tile address.

## Prop mapping

| `SpatioTemporalLayer` prop | `TileLayer` analog | Notes |
| --- | --- | --- |
| `data` (a `manifest.json` URL) | `data` (URL template) | One manifest per dataset, not a `{z}/{x}/{y}` template; tiles are range-read out of packs. |
| `maxRequests` (default **24**) | `maxRequests` (default 6) | Same meaning. The single concurrency knob, threaded into the range-request pool. |
| `maxCacheSize` (default 2000 tiles) | `maxCacheSize` | Same meaning (tile-count LRU cap). |
| `maxCacheByteSize` (default 2 GiB) | `maxCacheByteSize` | Same meaning; a persistent OPFS cache sits below the memory LRU. |
| `onTileLoad` / `onTileUnload` | `onTileLoad` / `onTileUnload` | Same contract. `onTileLoad`-driven re-renders are coalesced via rAF. |
| `onViewportLoad` | `onViewportLoad` | Same contract: fired once per viewport×window selection settle, with the loaded tiles. Re-fires only after the selection changes and re-settles. |
| `onTileError` | `onTileError` | Same contract, plus the failing tile's id. Default logs to `console.error`, like TileLayer. |
| — | `refinementStrategy` | No equivalent prop. The tileset pins a low-zoom overview tier and renders best-available data while finer tiles stream — closest in spirit to `'best-available'`, but not configurable. |
| `loadOptions` | `loadOptions` | loaders.gl-style: `loadOptions.fetch` as a `RequestInit` object is merged into every archive request (manifest, directory, pack ranges); a fetch-like function replaces the transport. Other keys are ignored. |
| `_subLayerProps` | `renderSubLayers` / `_subLayerProps` | Class swapping + prop overrides via `_subLayerProps` (incl. `type`), deck's CompositeLayer contract. No `renderSubLayers` callback — each animated layer class owns its (cache-gated) sublayer stack; see "Known departures". |
| `currentTime`, `timeWindow`, `timeController` | — | The temporal axis; no TileLayer analog exists. |

## Why the tileset is custom

`Tileset2D` + `RequestScheduler` is strictly **one `getTileData` call per
tile**, prioritized by viewport distance. Everything STT needs beyond that has
no home in that model:

- **Batch range-request coalescing.** STT tiles are byte ranges inside packed
  objects, ordered for spatial locality (Hilbert). The loader batches the
  tiles a viewport+window needs, groups them per pack, and coalesces adjacent
  ranges into single HTTP requests — flights load with ~89% fewer requests
  than per-tile fetching. A per-tile `getTileData` callback cannot express a
  cross-tile request plan.
- **Three-tier temporal scheduling.** Requests are tiered (visible window /
  playback lookahead / pinned overview) and prioritized by *playhead* distance,
  not just viewport distance. `RequestScheduler` knows nothing about time.
- **Byte-budgeted prefetch.** Lookahead prefetch ships small, nearest-first
  slices sized to measured network throughput (~1 s of data per slice), so a
  seek never waits behind a thousand-tile speculative batch.
- **Buffered-runway and cost APIs.** The tileset reports how far ahead of the
  playhead data is buffered and what a window costs to load; the
  `PlaybackGovernor` consumes these to hold, resume, and auto-speed playback
  (video-player-style buffering). This is a tileset↔playback contract with no
  upstream counterpart.

## The time hot path is imperative

deck.gl's idiom for animation is prop updates — but a prop change re-runs the
composite `renderLayers()` diff, and at 60 fps that is pure overhead for a
value that only a shader uniform needs (upstream `TripsLayer` users hit the
same wall with a 60 Hz `currentTime` prop).

STT's hot path bypasses props entirely: the playback tick mutates internal
time and calls `setNeedsRedraw()`, and sublayers read time through a stable
`getTime()` closure evaluated inside `TimeFilterExtension`'s `draw()` — the
uniform updates every frame with **zero prop churn** and zero sublayer
re-creation. This is the headline departure from declarative deck.gl, and it
is deliberate: deck has no per-frame-uniform prop idiom.

The declarative path still exists: set the `currentTime` prop (e.g. from a
scrubber) for casual, non-animated use. Use a `TimeController` for playback.

## When stock `DataFilterExtension` is enough

Be honest about the overlap: plain time-window filtering **is** expressible
with upstream's
[`DataFilterExtension`](https://deck.gl/docs/api-reference/extensions/data-filter-extension)
— `filterSize: 2` per-channel ranges, `fp64: true` for epoch-millisecond
values, `filterSoftRange` for edge fades. If all you need is "show features
whose timestamp is in [t0, t1]" on your own layers, use that; STT's own
heatmap layer builds on upstream aggregation layers plus `DataFilterExtension`
for exactly this reason.

`TimeFilterExtension` earns its existence on what `DataFilterExtension`
cannot do (its `getFilterValue` is per-object):

- **Per-vertex / per-segment time** — trail gradients along a trajectory,
  where each vertex carries its own timestamp.
- **Time-as-height** — offsetting geometry by time in
  `DECKGL_FILTER_GL_POSITION` (the space-time cube).
- **Wake mode** — a shaped falloff behind the time window, not a linear fade.
- **Cumulative reveal** — everything before the playhead stays visible.
- **Zero-prop-churn time** — the `getTime()` hot path above; upstream filter
  ranges are props.

## Known departures

Differences a deck.gl user will notice, beyond the tileset:

- **Column-name styling props, not function accessors.** Tiles arrive as
  binary Arrow columns and per-feature JS accessors never run, so styling
  props take a constant *or a property-column name* (e.g.
  `pathColor: 'speed'`) instead of deck's `getFillColor`-style
  `Accessor<DataT>` functions. The upstream accessor *names* also exist as
  aliases with the same constant-or-column-name semantics — point
  `getFillColor`/`getRadius`/`getLineColor`, path/trips `getColor`/`getWidth`,
  polygon `getFillColor`/`getElevation`, heatmap `getWeight` — and take
  precedence over the column-name prop when set. Passing a function accessor
  warns once and falls back to the column-name prop (it cannot run against
  binary tiles).
  User-supplied `updateTriggers` ARE honored: a trigger bump invalidates the
  cached prepared tiles and sublayer instances and the triggers forward into
  sublayers. `H3SummaryLayer` uses real accessors throughout.
- **No `DataT` generic on the layer classes.** The family follows upstream's
  extension pattern (`class My extends AnimatedPathLayer<MyExtraProps>` types
  `this.props` with the extra props plus the `Required<>`-typed defaults)
  but drops upstream's `DataT` parameter: tiles are binary Arrow columns, so
  there is no per-row datum type for accessors to receive — `data` is always
  the archive URL string. The temporal heatmap is exported as
  `AnimatedHeatmapLayer` (named to avoid shadowing deck.gl's own `HeatmapLayer`).
- **No attribute transitions.** Binary pass-through plus per-tile sublayers
  makes deck's `transitions` unsupportable; tiles appear with a time-window
  fade instead.
- **Picking works, with one path/trips caveat.** Every layer follows the
  TileLayer enrichment convention (`info.tile`/`info.sourceTile`) and decodes
  the picked feature's binary columns into a plain `info.object` (property
  name → value, plus reconstructed `start_time`/`end_time`/`id`). Path/trips
  sublayers normally strip picking attributes to stay within WebGL2's
  16-attribute floor; `pickable: true` swaps in the stock `PathLayer`, which
  can exceed that floor on GPUs that report exactly 16 (a one-time warning
  fires). Cumulative point slabs resolve picks through per-tile provenance;
  a pick whose source tile has since been evicted reports `tile: null`.
- **Sublayer overrides go through `_subLayerProps`, not `renderSubLayers`.**
  Every composite builds its sublayers through deck's standard
  `getSubLayerProps()`, so composite-level `opacity`, `pickable`, `visible`,
  `coordinateSystem`, `modelMatrix`, `autoHighlight`, `highlightColor`,
  `wrapLongitude` etc. inherit into sublayers, and the CompositeLayer-native
  `_subLayerProps` override map works — including `type` substitution, which
  is the `renderSubLayers`-equivalent class-swapping point. Sublayer short
  ids: `points` (AnimatedPointLayer, incl. cumulative slabs), `paths`,
  `trips`, `polygons`, `heads` (AnimatedTripHeadsLayer), `heatmap` (per
  channel), `hexagons` (H3SummaryLayer). A TileLayer-style `renderSubLayers`
  *callback* is still not offered — per-tile sublayer construction is
  cache-gated for perf, and `_subLayerProps` covers the class/props
  customization upstream users reach for.

Utilities that are *not* deck-coupled at all: `TimeController` (playback
clock, zero deck imports) and `PlaybackGovernor` (buffering state machine over
a structural `BufferSource` interface) can be used with any renderer,
including the `@poopdeck.gl/maplibre` adapter.

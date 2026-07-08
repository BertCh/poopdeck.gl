# @poopdeck.gl/layers

**deck.gl layers for SpatioTemporal Tiles (STT)** — stream a packed STT
dataset into animated points, paths, polygons, trips, OD flows, splats, and
server-aggregated summary tiers, with GPU time filtering driven by a shared
playback clock.

## Install

```bash
npm install @poopdeck.gl/layers deck.gl
```

**Peers**: deck.gl 9.3+ (`@deck.gl/core`, `@deck.gl/layers`,
`@deck.gl/geo-layers`, `@deck.gl/aggregation-layers`, `@deck.gl/extensions`,
`@deck.gl/mesh-layers`, `@luma.gl/core`, `@luma.gl/engine` — all
`>=9.3.0 <10`). Installing the `deck.gl` umbrella package satisfies them all.

## Hello world — SttPlayer + an animated layer

```ts
import { Deck } from '@deck.gl/core';
import { AnimatedPointLayer } from '@poopdeck.gl/layers';
import { SttPlayer } from '@poopdeck.gl/playback';

const player = new SttPlayer({
  timeRange: { start, end },
  baseRate: (end - start) / 60_000, // dataset plays in ~60 s at 1×
  loop: true,
});

const layer = new AnimatedPointLayer({
  id: 'events',
  data: 'https://tiles.example.com/earthquakes/manifest.json',
  timeController: player.timeController, // layers READ the clock; the player drives it
  timeWindow: 86_400_000,
  onTilesetReady: (tileset) => player.setSource(tileset), // buffering gates playback
  onBufferChange: (runway) => player.notifyBufferChange(runway),
});

new Deck({ layers: [layer] });
player.play();
```

Every layer extends `SpatioTemporalLayer` (tile lifecycle + time wiring +
binary-attribute plumbing); the catalog spans core layers
(`AnimatedPoint/Path/Polygon/Column/Icon/BoundingBox`, `SplatLayer`), trips
(`AnimatedTrips`, `AnimatedTripHeads`, `FlowCorridor`, `FlowStroke`), OD flow
(`AnimatedArc/Line`, `Flowmap`, `BundledFlowmap`), summary tiers
(`H3Summary`, `QuadbinSummary`, `AnimatedHeatmap`), and extensions
(`TimeFilter`, `CategoryColor`, `ChevronFlow`, `Splat`).

## Docs

Start at the [docs index](../../docs/README.md#api-reference) — every layer
and extension has its own reference page, beginning with
[SpatioTemporalLayer](../../docs/api/spatiotemporal-layer.md); the player is
documented at [SttPlayer](../../docs/api/stt-player.md).

MIT.

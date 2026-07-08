# @poopdeck.gl/maplibre

A **MapLibre GL custom-layer adapter for SpatioTemporal Tiles** — animated
STT rendering with no deck.gl dependency. Five layer classes (point / line /
polygon / trips / heatmap) implement MapLibre's `CustomLayerInterface` and
draw with raw WebGL2 inside MapLibre's own render loop, so they interleave
between native style layers.

## Install

```bash
npm install @poopdeck.gl/maplibre maplibre-gl
```

**Peers**: `maplibre-gl` **`^3 || ^4` only**. MapLibre v5 replaced the
custom-layer `render(gl, matrix)` signature with an args object (and changed
the mercator matrix semantics), which this adapter does not support yet —
stay on v4 for STT.

## Hello world — add the custom layer to a map

```ts
import { STTPointLayer } from '@poopdeck.gl/maplibre';

const layer = new STTPointLayer({
  id: 'events',
  url: 'https://tiles.example.com/earthquakes/manifest.json',
  currentTime: Date.UTC(2023, 0, 1),
  timeWindow: 86_400_000, // 1 day
  color: [255, 120, 40, 220],
});
map.addLayer(layer, 'waterway-label'); // interleave under labels
layer.setCurrentTime(t); // drive from any clock
```

Uses the same `@poopdeck.gl/core` reader/tileset as the deck.gl renderer —
same archives, same streaming behavior, much smaller bundle. Deck-only layer
kinds (arcs, flowmaps, summary tiers, …) are listed in the
[backend capability matrix](../../docs/spec/backend-capabilities.md).

## Docs

- [@poopdeck.gl/maplibre reference](../../docs/api/stt-maplibre.md)

MIT.

# @poopdeck.gl/maplibre

> **Status: preview.** Published and tested, with a narrower compatibility
> surface than the primary deck.gl renderer. See the
> [support policy](../../docs/intro/status-and-support.md).

A **MapLibre GL custom-layer adapter for SpatioTemporal Tiles** — animated
STT rendering with no deck.gl dependency. Fifteen layer classes implement
MapLibre's `CustomLayerInterface` and draw with raw WebGL inside MapLibre's
own render loop, so they interleave between native style layers.

## Install

```bash
npm install @poopdeck.gl/maplibre maplibre-gl
```

**Peers**: `maplibre-gl` `^3 || ^4 || ^5 || ^6` — the render path detects the
host's custom-layer signature at runtime (v3/v4 `render(gl, matrix)`, v5's
args object, v6's per-tile projection data), so one build runs on every
version. Mapbox GL JS `>=3.9.1` also works, mercator-only. `h3-js` is an
optional peer, needed only by `STTH3SummaryLayer`.

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
layer.attach(map, { beforeId: 'waterway-label' }); // interleave under labels
layer.setCurrentTime(t); // drive from any clock
```

## Layer classes

- **Core geometry** — `STTPointLayer`, `STTLineLayer`, `STTPolygonLayer`,
  `STTHeatmapLayer`
- **Motion & 3D** — `STTTripsLayer`, `STTTripHeadsLayer`, `STTIconLayer`,
  `STTColumnLayer`, `STTArcLayer`
- **Summary tiers** — `STTH3SummaryLayer`, `STTQuadbinSummaryLayer`,
  `STTHexbinLayer`
- **Flow** — `STTFlowCorridorLayer`, `STTFlowStrokeLayer`, `STTFlowmapLayer`

All extend the abstract `STTBaseLayer`; `STTLayerGroup` drives several of them
behind one custom layer. Four time-filter modes, DataFilter column ranges,
stable categorical colour, id-FBO picking (every kind except heatmap), and
globe on v5+ hosts. The remaining deck-only kinds (text, mesh, point cloud,
bounding box, iso-lines, …) are listed in the
[backend capability matrix](../../docs/spec/backend-capabilities.md).

Uses the same `@poopdeck.gl/core` reader/tileset as the deck.gl renderer —
same archives, same streaming behavior, much smaller bundle.

## Docs

- [@poopdeck.gl/maplibre reference](../../docs/api/stt-maplibre.md)

MIT.

# @poopdeck.gl/cesium

A **CesiumJS backend for SpatioTemporal Tiles** — renders animated STT data
on a true WGS84 globe. Ships the movement layer catalog —
`CesiumPointLayer`, `CesiumPathLayer` (paths + OD lines), `CesiumArcLayer`
(raised great-circle flow arcs), `CesiumTripsLayer` (trimmed vehicle
trails), `CesiumTripHeadsLayer` (moving head dots) — plus a `ViewState` ⇄
Cesium camera bridge and a render-loop clock hook. CesiumJS is Apache-2.0;
rendering STT needs no Cesium ion token.

## Install

> **Not yet published to npm** — today, consume it from the monorepo:

```bash
git clone https://github.com/BertCh/spatiotemporal-tiles
cd spatiotemporal-tiles
pnpm install && pnpm build
```

Inside the workspace, depend on `"@poopdeck.gl/cesium": "workspace:*"`; from
an external app, point a `file:` dependency at `packages/cesium`.

Once published:

```bash
npm install @poopdeck.gl/cesium cesium
```

**Peers**: `cesium` `^1`.

## Hello world — attachCesiumClock + CesiumPointLayer

```ts
import { STTArchive, SpatiotemporalTileset } from "@poopdeck.gl/core";
import { makeTilesetCallbacks } from "@poopdeck.gl/core/tileset-adapter";
import { CesiumPointLayer, attachCesiumClock } from "@poopdeck.gl/cesium";

const layer = new CesiumPointLayer(viewer.scene, { pixelSize: 6 });
const archive = new STTArchive({ url: manifestUrl });
const meta = await archive.getMetadata();

const tileset = new SpatiotemporalTileset({
  minZoom: meta.minZoom,
  maxZoom: meta.maxZoom,
  temporalBucketMs: meta.temporalBucketMs,
  ...makeTilesetCallbacks(archive),
  onTileLoad: () => layer.setTiles(tileset.getVisibleTiles()),
  onTileUnload: () => layer.setTiles(tileset.getVisibleTiles()),
});

// drive the playhead from Cesium's render loop:
const detach = attachCesiumClock(viewer.scene, timeController, (t) => {
  layer.setTime(t);
  tileset.update({ bounds, zoom, time: t, timeWindow }, true);
});
```

Every layer class has the same surface — swap `CesiumPointLayer` for
`CesiumTripsLayer({ trailLength })`, `CesiumTripHeadsLayer`,
`CesiumPathLayer`, or `CesiumArcLayer({ height })` and the wiring above is
unchanged.

Consumes the same `@poopdeck.gl/core` tiles and render kernel as the deck /
three / maplibre backends; its supported traits are in the
[backend capability matrix](../../docs/spec/backend-capabilities.md).

## Docs

- [@poopdeck.gl/cesium reference](../../docs/api/stt-cesium.md)

MIT.

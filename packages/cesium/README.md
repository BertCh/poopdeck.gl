# @poopdeck.gl/cesium

> **⚠️ Experimental — no longer published to npm.** This package is `"private":
true` in the workspace: `0.5.0` stays on npm, but no new versions ship. It is a
> fourth-backend spike we keep in-tree as the honest price tag on "just add
> another renderer" — ~2,000 lines for **6 of the 23** layer kinds
> (`point`/`path`/`line`/`arc`/`trips`/`tripHeads`); the other 17 degrade to a
> fallback kind via the capability descriptor. Use `@poopdeck.gl/layers` (deck),
> `@poopdeck.gl/three`, or `@poopdeck.gl/maplibre` for real work. To use this
> anyway, build it from source in a workspace checkout.

A **CesiumJS backend for SpatioTemporal Tiles** — renders animated STT data
on a true WGS84 globe. Ships the movement layer catalog —
`CesiumPointLayer`, `CesiumPathLayer` (paths + OD lines), `CesiumArcLayer`
(raised great-circle flow arcs), `CesiumTripsLayer` (trimmed vehicle
trails), `CesiumTripHeadsLayer` (moving head dots) — plus a `ViewState` ⇄
Cesium camera bridge and a render-loop clock hook. CesiumJS is Apache-2.0;
rendering STT needs no Cesium ion token.

## Install

Not on npm past `0.5.0` — build it from a workspace checkout:

```bash
pnpm --filter @poopdeck.gl/cesium build
```

**Peers**: `cesium` `^1`.

## Hello world — attachCesiumClock + CesiumPointLayer

```ts
import { STTArchive, SpatiotemporalTileset } from '@poopdeck.gl/core';
import { makeTilesetCallbacks } from '@poopdeck.gl/core/tileset-adapter';
import { CesiumPointLayer, attachCesiumClock } from '@poopdeck.gl/cesium';

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

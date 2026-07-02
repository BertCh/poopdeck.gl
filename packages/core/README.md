# @poopdeck.gl/core

The framework-free TypeScript core for **SpatioTemporal Tiles (STT)**: the
packed-archive reader, the tile decoder, the viewport + time-aware tileset,
and the render kernel every renderer backend
(`@poopdeck.gl/{layers,three,maplibre,cesium}`) is built on.

## Install

> **Not yet published to npm** — today, consume it from the monorepo:

```bash
git clone https://github.com/BertCh/spatiotemporal-tiles
cd spatiotemporal-tiles
pnpm install && pnpm build
```

Inside the workspace, depend on `"@poopdeck.gl/core": "workspace:*"`; from an
external app, point a `file:` dependency at `packages/core`.

Once published:

```bash
npm install @poopdeck.gl/core
```

No peer dependencies — the only runtime deps are `apache-arrow`, `earcut`,
and `fzstd`.

## Hello world — open an archive, decode a tile

```ts
import { STTArchive } from "@poopdeck.gl/core";

const archive = new STTArchive("https://tiles.example.com/earthquakes/manifest.json");
const meta = await archive.getMetadata();

// Tile ids are {z, x, y, t} — t is the temporal-bucket start (Unix ms).
const ids = await archive.getTileIdsInBounds(meta.bounds, meta.minZoom, meta.timeRange);
const tile = await archive.getTile(ids[0]); // fetched, decompressed, decoded
for (const layer of tile?.layers ?? []) {
  console.log(layer.name, layer.features.featureCount, "features");
}
```

For streaming a live viewport + playhead (selection, prefetch, eviction,
buffered-runway events), wrap the archive in a `SpatiotemporalTileset`:

```ts
import { SpatiotemporalTileset } from "@poopdeck.gl/core";
import { makeTilesetCallbacks } from "@poopdeck.gl/core/tileset-adapter";

const tileset = new SpatiotemporalTileset({
  minZoom: meta.minZoom,
  maxZoom: meta.maxZoom,
  temporalBucketMs: meta.temporalBucketMs,
  ...makeTilesetCallbacks(archive),
  onTileLoad: (tile) => render(tile.layers), // BinaryFeatures: GPU-ready columns
});
tileset.update({ bounds, zoom, time, timeWindow });
```

## What's in the box

- **Reader** — `STTArchive` (packed manifest + paged directory + per-pack
  Range requests), `SpatiotemporalTileset` (selection, prefetch, eviction,
  buffered-runway events), `TileDecoder` (inline or worker-pool).
- **`BinaryFeatures`** — the decoded, columnar, zero-copy tile payload
  (positions, times, per-vertex values, vector groups, triangles).
- **Render kernel** — framework-free subpaths (`core/time-filter`,
  `core/style`, `core/geometry`, `core/geo`, `core/picking`,
  `core/tileset-adapter`, `core/shader-codegen`, `core/capabilities`) shared
  by all four renderer backends.

## Docs

- [Tile decoding](../../docs/api/stt-loader.md)
- [SpatiotemporalTileset](../../docs/api/spatiotemporal-tileset.md)
- [Binary features](../../docs/api/binary-features.md)
- [Render kernel](../../docs/api/render-kernel.md)
- [Format spec](../../docs/spec/stt-packed-format.md)

MIT.

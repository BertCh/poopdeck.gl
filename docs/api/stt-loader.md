# Tile decoding

`@poopdeck.gl/core` exposes a small surface for decoding STT tile payloads. In normal
use you don't call it directly — `STTArchive` and
[`SpatiotemporalTileset`](./spatiotemporal-tileset.md) do — but the pieces are
documented here for tests, custom integrations, and GeoArrow hand-offs.

> **No single-buffer loader.** The packed multi-object format has no
> single-buffer representation, so there is no loaders.gl-style
> `parse(arrayBuffer)` entry point. Construct `new STTArchive(manifestUrl)`
> instead; for a loaders.gl-conformant surface use `createSttTileSource()` /
> `STTArchive.asTileSource()`, which match the loaders.gl v4 `TileSource`
> interface structurally (no `@loaders.gl/*` runtime dependency).

## TileDecoder

```typescript
import {
  type TileDecoder,
  type DecodeArgs,
  InlineTileDecoder,
  WorkerTileDecoder,
  createDefaultTileDecoder,
} from "@poopdeck.gl/core";

interface TileDecoder {
  decode(args: {
    id: TileId;
    timeRange: TimeRange;
    compressed: ArrayBuffer;
    compression: Compression;
  }): Promise<Tile>;

  /** Release worker resources, if any. */
  finalize(): void;
}
```

Implementations:

- **`InlineTileDecoder`** — synchronous decode on the calling thread.
  Used in Node tests and as the fallback in browsers when module workers
  fail to construct.
- **`WorkerTileDecoder`** — pool of 2–4 module workers (sized from
  `navigator.hardwareConcurrency - 1`, capped at 4; override via the
  constructor's `{ poolSize?, workerUrl? }`) that runs
  decompression, Arrow IPC parsing, and binary-feature extraction off the
  main thread. Requests dispatch to the least-pending worker; decoded
  typed-array buffers transfer (zero copy) back to the main thread.
  Workers that crash are replaced; their in-flight requests are rejected.
- **`createDefaultTileDecoder()`** — picks `WorkerTileDecoder` when the
  environment supports module workers, otherwise falls back to inline.

The worker path is the only way to sustain 60 fps while streaming a
many-thousand-tile dataset — inline decode of one tile is ~5–20 ms of
`tableFromIPC` + binary extraction, a full frame budget.

`STTArchive` constructs the default decoder automatically. Pass
`decoder: new InlineTileDecoder()` in `ArchiveOptions` to force inline
decoding (useful in tests or environments that block workers).

## decodeTile()

```typescript
import { decodeTile } from "@poopdeck.gl/core";

const tile = decodeTile(payloadBytes, id, timeRange);
```

Decodes an **uncompressed** tile payload (the layer frame) into a `Tile`.
`timeRange` is optional — when omitted it defaults to a zero-width range at
the tile's own `t` (the worker / loaders.gl paths have no directory at hand).
The frame is `[u16 layerCount | flags]` followed by, per layer,
`[u16 nameLen][name][u32 ipcLen][pad][Arrow IPC stream]`. The leading u16's
top bit marks the *aligned* frame (every IPC stream starts 8-byte aligned,
which is what lets apache-arrow wrap its buffers zero-copy); frames
without the flag carry no padding and parse identically.

## What the decoder returns

```typescript
interface Tile {
  id: TileId;                 // { z, x, y, t }
  timeRange: TimeRange;       // { start, end } in Unix ms
  layers: Layer[];
}

interface Layer {
  name: string;
  extent: number;                  // always 0 — coordinates are real lon/lat, no quantization
  features: BinaryFeatures;        // GPU-ready typed arrays
  geometryExtensionName: string;   // 'geoarrow.point' | 'geoarrow.linestring' | 'geoarrow.polygon'
                                   // ('' only for pre-v2 archives — treat as unknown)
  arrowTable?: Table;              // the decoded GeoArrow record batch (absent after a worker hop)
  arrowIpc?: Uint8Array;           // raw per-layer Arrow IPC bytes (cloneable; survives workers)
}
```

`BinaryFeatures` is described in [Binary Features](./binary-features.md) —
including numeric properties as `Float32Array` and categorical properties as
a `{ indices: Uint16Array; categories: string[] }` dictionary ready for
`CategoryColorExtension`.

## GeoArrow hand-off

```typescript
import { toGeoArrowTable } from "@poopdeck.gl/core";
import { GeoArrowPathLayer } from "@geoarrow/deck.gl-layers";

const table = toGeoArrowTable(tile.layers[0]);
new GeoArrowPathLayer({ id: "paths", data: table, getPath: table.getChild("geometry")! });
```

`toGeoArrowTable(layer)` returns an Arrow `Table` whose `geometry` field
carries the standard `ARROW:extension:name` GeoArrow metadata — a valid
input for `@geoarrow/deck.gl-layers` or Lonboard. It works on
worker-decoded tiles too: the worker strips the non-cloneable `Table`
before postMessage but ships the raw `arrowIpc` bytes, and
`toGeoArrowTable()` rehydrates (and memoizes) the Table lazily on first
call. The returned Table shares buffers with the decoded tile — don't
mutate it or hold it past the tile's lifetime.

## Per-feature reads

`getFeatureProperties(features, index)` decodes ONE feature's property
columns into a plain JS object — the event-driven counterpart to the
columnar layout, used by deck.gl picking (`info.object`), tooltips, and
debugging. Returns `null` for an out-of-range index.

## Float32 precision

The decoder relativizes `start_time` / `end_time` / `vertex_time` against the
tile's `timeOffset` so the resulting `Float32Array`s fit within the f32
exactly-representable integer range. The
[`TimeFilterExtension`](./time-filter-extension.md) applies the same offset
to its `currentTime` shader uniform. If you build a custom layer, pass
`features.timeOffset` through unchanged.

## Source

- `packages/core/src/tile-decoder.ts` — pool implementation and inline fallback.
- `packages/core/src/tile-decoder.worker.ts` — the worker entry point.
- `packages/core/src/tile.ts` — `decodeTile()`, `getFeatureProperties()`, `toGeoArrowTable()`.
- `packages/core/src/tile-source.ts` — the loaders.gl-shaped `TileSource` adapter.

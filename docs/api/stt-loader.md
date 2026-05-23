# Tile decoding

`@stt/core` exposes a small surface for decoding STT tile blobs. In normal
use you don't call it directly — `STTArchive` and `SpatiotemporalTileset` do
— but the pieces are documented here for tests, custom integrations, and
loaders.gl-style adapters.

> A previous version of this document described an `STTLoader` for
> loaders.gl that decoded protobuf payloads on a worker. STT v2 dropped
> protobuf in favour of Apache Arrow IPC; the public surface is now the
> `TileDecoder` interface described below.

## TileDecoder

```typescript
import {
  type TileDecoder,
  InlineTileDecoder,
  WorkerTileDecoder,
  createDefaultTileDecoder,
} from "@stt/core";

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
  `navigator.hardwareConcurrency`, capped at 4) that runs decompression,
  Arrow IPC parsing, and binary-feature extraction off the main thread.
  Workers that crash are replaced; their in-flight requests are rejected.
- **`createDefaultTileDecoder()`** — picks `WorkerTileDecoder` when the
  environment supports module workers, otherwise falls back to inline.

`STTArchive` constructs the default decoder lazily on first `getTile()`.
Pass `decoder: new InlineTileDecoder()` to the archive constructor to force
inline decoding (useful in tests).

## What the decoder returns

```typescript
interface Tile {
  id: TileId;                 // { z, x, y, t }
  timeRange: TimeRange;       // { start, end } in Unix ms
  timeOffset: number;         // see "Float32 precision" below
  layers: Array<{
    name: string;
    features: BinaryFeatures; // GPU-ready typed arrays
  }>;
}
```

`BinaryFeatures` is described in [Binary Features](./binary-features.md).
The decoder also extracts numeric properties as `Float32Array` and
categorical properties as a `{ indices: Uint32Array; categories: string[] }`
dictionary, ready for `CategoryColorExtension`.

## Float32 precision

The decoder relativizes `start_time` / `end_time` / `vertex_time` against the
tile's `timeOffset` so the resulting `Float32Array`s fit within the f32
exactly-representable integer range. The layer extension applies the same
offset to its `currentTime` shader uniform — see `time-filter-extension.ts`.
If you build a custom layer, pass through `tile.timeOffset` unchanged.

## Source

- `packages/core/src/tile-decoder.ts` — pool implementation and inline fallback.
- `packages/core/src/tile-decoder.worker.ts` — the worker entry point.
- `packages/core/src/tile.ts` — `decodeTile()` (the actual Arrow → binary pass).

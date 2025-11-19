# STTLoader

A [loaders.gl](https://loaders.gl/) compatible loader for parsing Spatiotemporal Tile (`.stt`) data. It handles decompression (Gzip/Brotli) and Protocol Buffer decoding.

## Installation

```typescript
import { STTLoader } from '@stt/core';
import { load } from '@loaders.gl/core';
```

## Usage

The loader is typically used internally by `STTArchive` or `SpatioTemporalLayer`, but can be used standalone with `loaders.gl`.

```typescript
import { load } from '@loaders.gl/core';
import { STTLoader } from '@stt/core';

const tileData = await load(url, STTLoader, {
  stt: {
    tileId: { z: 0, x: 0, y: 0, t: 1234567890 }
  }
});
```

## Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `stt.tileId` | `TileId` | `null` | **Required**. The tile ID `{z, x, y, t}` associated with the data being loaded. This is needed to decode delta-encoded coordinates which are relative to the tile origin. |
| `stt.compression` | `Compression` | `0` | Compression method used: `0` (None), `1` (Gzip), `2` (Brotli). |
| `worker` | `boolean` | `false` | Whether to decode in a web worker (not yet fully implemented). |

## Output

Returns a `Tile` object:

```typescript
interface Tile {
  id: TileId;
  layers: Layer[];
  timeStart: number;
  timeEnd: number;
  // ...
}
```

## Source

[packages/core/src/stt-loader.ts](../../packages/core/src/stt-loader.ts)


# STTLoader

A [loaders.gl](https://loaders.gl/) compatible loader for parsing Spatiotemporal Tile (`.stt`) data. It handles decompression (Gzip/Brotli) and Protocol Buffer decoding.

## Features

- **Worker Support**: Offloads decoding to worker threads for better main thread performance
- **Binary Output**: GPU-ready binary columnar format with typed arrays for zero-copy GPU upload
- **Object Output**: Standard Tile objects for backward compatibility

## Installation

```typescript
import { STTLoader } from "@stt/core";
import { load } from "@loaders.gl/core";
```

## Usage

The loader is typically used internally by `STTArchive` or `SpatioTemporalLayer`, but can be used standalone with `loaders.gl`.

### Standard Object Output

```typescript
import { load } from "@loaders.gl/core";
import { STTLoader } from "@stt/core";

const tile = await load(url, STTLoader, {
  stt: {
    tileId: { z: 0, x: 0, y: 0, t: 1234567890 },
    compression: 1, // Gzip
  },
});
```

### Binary Output (GPU-Optimized)

```typescript
import { load } from "@loaders.gl/core";
import { STTLoader } from "@stt/core";
import type { BinaryTile } from "@stt/core";

const binaryTile = (await load(url, STTLoader, {
  stt: {
    tileId: { z: 0, x: 0, y: 0, t: 1234567890 },
    compression: 1,
    outputFormat: "binary", // GPU-ready typed arrays
  },
})) as BinaryTile;

// Access binary data directly
const { positions, startTimes, endTimes } = binaryTile.layers[0].features;
```

## Options

The loader accepts `STTLoaderOptions`, which extends the standard loaders.gl `LoaderOptions`:

```typescript
import type { STTLoaderOptions } from "@stt/core";
```

### STT-specific Options

| Option              | Type                   | Default    | Description                                                                                                                                                               |
| :------------------ | :--------------------- | :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stt.tileId`        | `TileId`               | `null`     | **Required**. The tile ID `{z, x, y, t}` associated with the data being loaded. This is needed to decode delta-encoded coordinates which are relative to the tile origin. |
| `stt.compression`   | `Compression`          | `0`        | Compression method used: `0` (None), `1` (Gzip), `2` (Brotli).                                                                                                            |
| `stt.outputFormat`  | `'object' \| 'binary'` | `'object'` | Output format: `'object'` for standard Tile objects, `'binary'` for GPU-ready typed arrays.                                                                               |
| `stt.disableWorker` | `boolean`              | `false`    | Force main thread decoding (disables worker threading).                                                                                                                   |

### Standard loaders.gl Options

All standard loaders.gl options are also supported:

| Option    | Type           | Description            |
| :-------- | :------------- | :--------------------- |
| `fetch`   | `typeof fetch` | Custom fetch function  |
| `nothrow` | `boolean`      | Do not throw on errors |

## Loader Properties

| Property     | Value                                                 |
| :----------- | :---------------------------------------------------- |
| `id`         | `'stt'`                                               |
| `name`       | `'STT'`                                               |
| `module`     | `'stt'`                                               |
| `extensions` | `['stt']`                                             |
| `mimeTypes`  | `['application/vnd.stt', 'application/octet-stream']` |
| `category`   | `'geometry'`                                          |
| `binary`     | `true`                                                |

## Output

Returns a `Tile` object:

```typescript
interface Tile {
  id: TileId;
  timeRange: TimeRange;
  layers: Layer[];
}

interface TileId {
  z: number; // Zoom level (0-22)
  x: number; // X coordinate
  y: number; // Y coordinate
  t: number; // Timestamp (Unix milliseconds)
}

interface Layer {
  name: string;
  extent: number;
  features: Feature[];
}
```

## TypeScript

The loader exports proper TypeScript types:

```typescript
import { STTLoader, STTLoaderOptions, STTOptions } from "@stt/core";
import type { Tile } from "@stt/core";

// Type-safe usage
const options: STTLoaderOptions = {
  stt: {
    tileId: { z: 5, x: 10, y: 20, t: Date.now() },
    compression: 0,
  },
};

const tile: Tile = await load(url, STTLoader, options);
```

## Source

[packages/core/src/stt-loader.ts](../../packages/core/src/stt-loader.ts)

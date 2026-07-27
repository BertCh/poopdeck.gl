# Tile decoding

`@poopdeck.gl/core` exposes a small surface for decoding STT tile payloads. In normal
use you don't call it directly — `STTArchive` and
[`SpatioTemporalTileset`](./spatiotemporal-tileset.md) do — but the pieces are
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
} from '@poopdeck.gl/core';

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
import { decodeTile, type DecodeTileOptions } from "@poopdeck.gl/core";

const tile = decodeTile(payloadBytes, id, timeRange, options?);
```

Decodes an **uncompressed** tile payload (the layer frame) into a `Tile`.
`timeRange` is optional — when omitted it defaults to a zero-width range at
the tile's own `t` (the worker / loaders.gl paths have no directory at hand).

The reader understands two frame shapes, discriminated by
`manifest.formatVersion` (see [Packed format versions](#packed-format-versions-v1--v2)):

- **v1** — `[u16 layerCount | flags]` followed by, per layer,
  `[u16 nameLen][name][u32 ipcLen][pad][Arrow IPC stream]`. The leading u16's
  top bit marks the _aligned_ frame (every IPC stream starts 8-byte aligned,
  which is what lets apache-arrow wrap its buffers zero-copy); frames without
  the flag carry no padding and parse identically. Needs no `options`.
- **v2** — the sectioned, template-referencing frame (leading `0xFFFF`
  escape). Each layer references a shared Arrow schema template by 16-byte
  blake3-128 hash and carries only the IPC stream _tail_; the reader splices
  `concat(template, tail)` back into a stock stream. Decoding a v2 frame that
  references a template by hash **requires** the dataset's template registry
  via `options.templates` — so a v2 dataset MUST be opened through its
  manifest (where the registry is built and validated). Calling `decodeTile`
  on a raw v2 payload without it throws a descriptive error.

`options` is `DecodeTileOptions` (both fields optional — v1 decoding needs none):

| Field           | Type               | Description                                                                                                                                                                                                                     |
| :-------------- | :----------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `templates`     | `TemplateRegistry` | The `hash → template bytes` map built from `manifest.schemas` at archive open. Required to decode v2 frames that reference a template by hash; v1 and self-contained (inline-schema) v2 frames decode without it.               |
| `formatVersion` | `number`           | The manifest's declared version. When set, it is enforced against the payload (spec §5.2 authority rule): a v2 frame reached through a v1-declared manifest — or vice versa — is a hard error. Omitted, the payload is sniffed. |

`TemplateRegistry` is `Map<string, Uint8Array>`.

## What the decoder returns

```typescript
interface Tile {
  id: TileId; // { z, x, y, t }
  timeRange: TimeRange; // { start, end } in Unix ms
  layers: Layer[];
}

interface Layer {
  name: string;
  extent: number; // always 0 — coordinates are real lon/lat, no quantization
  features: BinaryFeatures; // GPU-ready typed arrays
  geometryExtensionName: string; // 'geoarrow.point' | 'geoarrow.linestring' | 'geoarrow.polygon'
  // ('' only for pre-v2 archives — treat as unknown)
  arrowTable?: Table; // the decoded GeoArrow record batch (absent after a worker hop)
  arrowIpc?: Uint8Array; // raw per-layer Arrow IPC bytes (cloneable; survives workers)
  arrowIpcProps?: Uint8Array; // v2 only: the spliced PROPS IPC stream (present iff the layer has property columns)
  tileMeta?: TileMetaJson; // v2 only: parsed TILE_META (plain JSON; survives workers; re-injected on rehydrate)
  arrowIpcDropped?: boolean; // set when retainArrowIpc dropped the IPC bytes — toGeoArrowTable() then throws
  coordinatesQuantized?: boolean; // true when the geometry leaf is stt:quant Int32 grid indices, not lon/lat
}
```

`BinaryFeatures` is described in [Binary Features](./binary-features.md) —
including numeric properties as `Float32Array` and categorical properties as
a `{ indices: Uint16Array; categories: string[] }` dictionary ready for
`CategoryColorExtension`. v2 tiles may additionally set `features.timesSorted`
when the frame's `TILE_META.sorted` flag declares the rows are stable-sorted
by `start_time` (`undefined` for v1 tiles and synthetic fixtures — per the
spec, readers MUST NOT assume sortedness without the flag).

## GeoArrow hand-off

```typescript
import { toGeoArrowTable } from '@poopdeck.gl/core';
import { GeoArrowPathLayer } from '@geoarrow/deck.gl-layers';

const table = toGeoArrowTable(tile.layers[0]);
new GeoArrowPathLayer({
  id: 'paths',
  data: table,
  getPath: table.getChild('geometry')!,
});
```

`toGeoArrowTable(layer)` returns an Arrow `Table` whose `geometry` field
carries the standard `ARROW:extension:name` GeoArrow metadata — a valid
input for `@geoarrow/deck.gl-layers` or Lonboard. It works on
worker-decoded tiles too: the worker strips the non-cloneable `Table`
before postMessage but ships the raw `arrowIpc` bytes, and
`toGeoArrowTable()` rehydrates (and memoizes) the Table lazily on first
call — re-merging the spliced core/props streams for v2 layers. The returned
Table shares buffers with the decoded tile — don't mutate it or hold it past
the tile's lifetime.

Whether those raw bytes are retained at all is governed by
[`ArchiveOptions.retainArrowIpc`](#archive-options-integrity--memory) (default
`'auto'`, which drops them for coordinate-quantized layers). Calling
`toGeoArrowTable()` on a layer whose bytes were dropped throws an error naming
the option.

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

## Packed format versions (v1 / v2)

The reader is transparent across both packed layouts and discriminates on
`manifest.formatVersion`:

- **1** — the frozen 0.3.x layout: v1 layer frames, no object magic.
- **2** — the 2026-07 byte break: `STTD`/`STTP` object magic and the
  sectioned, template-referencing v2 layer frame.

A v2 dataset MUST be opened through its `manifest.json` — both the schema
template registry (built from `manifest.schemas`) and the declared
`formatVersion` live there, and every decode forwards them (see
[`decodeTile`'s options](#decodetile)). At open the reader:

- **blake3-128-validates every `manifest.schemas[]` template**
  (`blake3_128(data) === hash`) — a corrupt manifest fails loudly,
  dataset-level, before any tile fetch.
- **hard-refuses a dataset declaring a `manifest.capabilities[]` entry it does
  not implement.** Each capability re-types existing tile columns, so an
  unimplemented one would silently misdecode rather than fail — the reader
  rejects at open instead. The implemented set is exported as
  `KNOWN_MANIFEST_CAPABILITIES` (currently `'coord-quant'`, `'attr-quant'`,
  `'elevation-fold'`).
- rejects any unrecognized `formatVersion` or `directoryVersion`.

## Archive options: integrity & memory

`STTArchive` (constructed from a manifest URL, or `new STTArchive(options)`)
accepts these `ArchiveOptions` fields governing checksum verification and the
raw-IPC memory trade-off. All are optional.

| Option            | Type                | Default  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| :---------------- | :------------------ | :------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verifyChecksums` | `boolean`           | `true`   | Verify each fetched blob's CRC-32C (from the directory) over its **compressed** bytes BEFORE decompression, on both the worker and inline decode paths. A mismatch rejects that tile's decode with a distinctive `crc32c mismatch` error through the normal per-tile error surface. Entries whose directory CRC is `0`/absent (synthetic archives) and OPFS-decompressed warm hits (no compressed bytes to check) skip verification. Pass `false` as a kill switch (the CRC cost is trivial next to zstd). |
| `retainArrowIpc`  | `boolean \| 'auto'` | `'auto'` | Whether decoded layers keep their raw Arrow IPC bytes (`arrowIpc` / `arrowTable`) for lazy `toGeoArrowTable()`. `'auto'` drops the reference only for coordinate-quantized (`stt:quant`) layers — whose tables are not literal GeoArrow anyway — and keeps it everywhere `toGeoArrowTable()` is valid. `true` always keeps; `false` always drops (smallest memory). `toGeoArrowTable()` on a dropped layer throws an error naming this option.                                                             |
| `opfsCache`       | `boolean`           | `false`  | Enable the OPFS-backed persistent tile cache. **Now defaults to `false` everywhere** (including browsers exposing `navigator.storage.getDirectory`) — persistence is strictly opt-in. On the cold path it costs a duplicate main-thread zstd decompress per tile, so leave it off unless the archive fits in `opfsCacheMaxBytes` AND users revisit the same viewport across reloads.                                                                                                                       |
| `cache`           | `boolean`           | —        | **Deprecated, never read.** The in-memory compressed-byte cache is always on and device-aware.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `maxCacheSize`    | `number`            | —        | **Deprecated, never read.** The byte-cache budget is device-aware (512 MB desktop / 256 MB low-memory) and not configurable through this field.                                                                                                                                                                                                                                                                                                                                                            |

## Integrity & content-addressing primitives

The checksum and content-address functions the reader uses internally are also
exported for tests and custom pipelines:

```typescript
import { crc32c, verifyCrc32c, blake3, blake3Hex128 } from '@poopdeck.gl/core';
```

| Export         | Signature                                            | Description                                                                                                                                                            |
| :------------- | :--------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crc32c`       | `(bytes: Uint8Array) => number`                      | CRC-32C (Castagnoli) as an unsigned 32-bit int — the directory's per-blob checksum, computed over the blob's compressed bytes.                                         |
| `verifyCrc32c` | `(bytes: Uint8Array, expected: number) => void`      | Throws a distinctive `crc32c mismatch` error when `crc32c(bytes) !== expected`. Shared by the worker and inline decode paths so the two surface the identical message. |
| `blake3`       | `(input: Uint8Array, outLen?: number) => Uint8Array` | BLAKE3 hash truncated to `outLen` bytes (≤ 32, default 32). The packed format's blake3-128 object/template addresses are the first 16 bytes.                           |
| `blake3Hex128` | `(input: Uint8Array) => string`                      | blake3-128 as 32 lowercase hex chars — the content-address form (`manifest.schemas[].hash`, `index/<hash>.sttd`, `packs/<hash>.sttp`).                                 |

Related exported types: `DecodeTileOptions`, `TemplateRegistry`,
`ManifestSchemaTemplate` (a `{ hash, data }` entry of a v2 manifest's `schemas`
table), and `TileMetaJson` (the parsed v2 `TILE_META` section).

## Source

- `packages/core/src/tile-decoder.ts` — pool implementation and inline fallback.
- `packages/core/src/tile-decoder.worker.ts` — the worker entry point.
- `packages/core/src/tile.ts` — `decodeTile()`, `getFeatureProperties()`, `toGeoArrowTable()`, `DecodeTileOptions`, `TemplateRegistry`.
- `packages/core/src/archive.ts` — `STTArchive`, `ArchiveOptions`, manifest parsing, `KNOWN_MANIFEST_CAPABILITIES`, `ManifestSchemaTemplate`.
- `packages/core/src/crc32c.ts` — `crc32c()`, `verifyCrc32c()`.
- `packages/core/src/blake3.ts` — `blake3()`, `blake3Hex128()`.
- `packages/core/src/tile-source.ts` — the loaders.gl-shaped `TileSource` adapter.

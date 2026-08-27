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
  decode(args: DecodeArgs): Promise<Tile>;

  /** Release worker resources, if any. */
  finalize(): void;

  /**
   * OPTIONAL: install the dataset's schema-template registry (built and
   * blake3-validated from `manifest.schemas` at archive open).
   *
   * Distribution contract (NORMATIVE): the archive calls this once per
   * decoder; a pool implementation MUST (re)send the registry to every worker
   * on EVERY spawn AND respawn, BEFORE dispatching decodes to it. A decode
   * that reaches a hash reference without the registry rejects descriptively
   * — never a silently empty tile.
   */
  setTemplates?(templates: TemplateRegistry): void;
}
```

`DecodeArgs`:

| Field                      | Type                            | Description                                                                                                                                                                                                                           |
| :------------------------- | :------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                       | `TileId`                        | The tile identity.                                                                                                                                                                                                                    |
| `timeRange`                | `TimeRange`                     | The tile's temporal span, from the directory.                                                                                                                                                                                         |
| `compressed`               | `ArrayBuffer`                   | The compressed blob bytes.                                                                                                                                                                                                            |
| `compression`              | `Compression`                   | Its codec.                                                                                                                                                                                                                            |
| `expectedUncompressedSize` | `number`                        | Directory-declared decompressed length. MANDATORY — it is both the decompression-bomb output cap and the authority checked after decode. Callers starting from an already-decompressed payload pass the same directory-declared size. |
| `expectedCrc32c`           | `number`                        | Directory CRC-32C of `compressed`, verified BEFORE decompression (off the main thread on the worker path). Omitted when the directory recorded no checksum, or when the input is already decompressed (OPFS warm hits).               |
| `onPayload`                | `(payload: Uint8Array) => void` | Hand-back of the DECOMPRESSED bytes, invoked before the decode promise resolves, so a following OPFS write reuses them instead of re-decompressing. Decoders that skip it just cost one extra decompress.                             |
| `signal`                   | `AbortSignal`                   | Abort. `WorkerTileDecoder` keeps queued work on the host, so an abort before worker dispatch spends no decode CPU and copies no payload.                                                                                              |
| `formatVersion`            | `number`                        | The manifest's declared packed version, threaded through for the spec §5.2 authority check. Accepted and forwarded, but `decodeTile` does not currently read it — the frame escape is what discriminates.                             |
| `priority`                 | `number`                        | Decode priority, LOWER = more urgent. Defaults to `DEFAULT_DECODE_PRIORITY` (`0`, the most urgent class — the uninstrumented callers are the warm/interactive paths). `InlineTileDecoder` ignores it.                                 |

Implementations:

- **`InlineTileDecoder`** — synchronous decode on the calling thread.
  Used in Node tests and as the fallback in browsers when module workers
  fail to construct.
- **`WorkerTileDecoder`** — pool of module workers running decompression,
  Arrow IPC parsing, and binary-feature extraction off the main thread. The
  pool STARTS at `min(4, cores − 1)` and adapts upward to a hard ceiling of
  `cores − 1` (cores read from `navigator.hardwareConcurrency`, clamped to
  1..64; one core stays reserved for the render loop). Pass `poolSize` to the
  constructor's `{ poolSize?, workerUrl? }` to pin it and disable adaptation.
  There is ONE pool-wide host queue, served by decode priority
  (`DecodeArgs.priority`, lower = more urgent), so a slow decode never strands
  work behind it and the fetch stage's priority survives into decode. Payloads
  stay on the host until a worker is free, so an aborted queued tile costs no
  worker CPU and no payload copy. Decoded typed-array buffers transfer (zero
  copy) back to the main thread. Workers that crash are replaced; their
  in-flight requests are rejected.
- **`createDefaultTileDecoder()`** — picks `WorkerTileDecoder` when the
  environment supports module workers, otherwise falls back to inline. Browser
  archives receive lightweight leases over one process-shared pool; the pool is
  finalized when its final archive lease is released.

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

`decodeTile` requires a v2 sectioned layer frame — the payload MUST open with
the `0xFFFF` escape or it throws
`payload is not a layer frame (missing the frame escape)`.

Inside that frame each layer references a shared Arrow schema template by
16-byte blake3-128 hash and carries only the IPC stream _tail_; the reader
splices `concat(template, tail)` back into a stock stream. Decoding a frame
that references a template by hash **requires** the dataset's template registry
via `options.templates` — so such a dataset MUST be opened through its manifest
(where the registry is built and validated). Calling `decodeTile` on a raw
payload without it throws a descriptive error.

`options` is `DecodeTileOptions` (both fields optional):

| Field           | Type               | Description                                                                                                                                                                                          |
| :-------------- | :----------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `templates`     | `TemplateRegistry` | The `hash → template bytes` map built from `manifest.schemas` at archive open. Required to decode frames that reference a template by hash; self-contained (inline-schema) frames decode without it. |
| `formatVersion` | `number`           | The manifest's declared packed version, accepted and threaded through for the spec §5.2 authority check. `decodeTile` does not currently read it — the frame escape is what discriminates.           |

`TemplateRegistry` is `Map<string, Uint8Array>`.

## What the decoder returns

```typescript
interface Tile {
  id: TileId; // { z, x, y, t, variantId?, bucketMs? }
  timeRange: TimeRange; // { start, end } in Unix ms
  layers: STTTileLayer[];
}

interface STTTileLayer {
  name: string;
  extent: number; // always 0 — coordinates are real lon/lat, no quantization
  features: BinaryFeatures; // GPU-ready typed arrays
  geometryExtensionName: string; // 'geoarrow.point' | 'geoarrow.linestring' | 'geoarrow.polygon'
  // ('' means UNKNOWN — never default it to 'point')
  arrowTable?: Table; // the decoded GeoArrow record batch (absent after a worker hop)
  arrowIpc?: Uint8Array; // raw per-layer Arrow IPC bytes (cloneable; survives workers)
  arrowIpcProps?: Uint8Array; // the spliced PROPS IPC stream (present iff the layer has property columns)
  tileMeta?: TileMetaJson; // parsed TILE_META (plain JSON; survives workers; re-injected on rehydrate)
  arrowIpcDropped?: boolean; // set when retainArrowIpc dropped the IPC bytes — toGeoArrowTable() then throws
  coordinatesQuantized?: boolean; // true when the geometry leaf is stt:quant Int32 grid indices, not lon/lat
}
```

The decoded-layer type is `STTTileLayer`, not `Layer` — `@deck.gl/core` exports
a `Layer` class, and the two cannot be imported into one module. `variantId`
and `bucketMs` are part of tile IDENTITY (raw vs. summary payload; temporal-LOD
tier), so derive registry keys with `tileKey()` rather than from `z/x/y/t`.

`BinaryFeatures` is described in [Binary Features](./binary-features.md) —
including numeric properties as `Float32Array` and categorical properties as
a `{ indices: Uint16Array; categories: string[] }` dictionary ready for
`CategoryColorExtension`. A tile may additionally set `features.timesSorted`
when the frame's `TILE_META.sorted` flag declares the rows are stable-sorted
by `start_time` (`undefined` for synthetic fixtures — per the spec, readers
MUST NOT assume sortedness without the flag).

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
input for `@geoarrow/deck.gl-layers` or Lonboard. Every time column
(`start_time`, `end_time`, `vertex_time`) also carries the vis.gl
`visgl:temporal-*` descriptor — the luma.gl vocabulary — completed here at
hand-off for EVERY archive, including ones written before the encoder emitted
any of it, and only here, because the compact time forms are not absolute
until `mergeV2Layer` re-inflates them. Read it back with
`readTemporalColumnInfo(table, column) → TemporalColumnInfo | null`.

It works on worker-decoded tiles too: the worker strips the non-cloneable
`Table` before postMessage but ships the raw `arrowIpc` bytes, and
`toGeoArrowTable()` rehydrates (and memoizes) the Table lazily on first
call — re-merging the spliced core/props streams for layers with property
columns. Repeat calls return an IDENTICAL instance (deck.gl's shallow
`data`-prop comparison depends on it). The returned Table shares buffers with
the decoded tile — don't mutate it or hold it past the tile's lifetime.

Whether those raw bytes are retained at all is governed by
[`ArchiveOptions.retainArrowIpc`](#archive-options) (default
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

## Packed archive version

The archive reader OPENS `formatVersion` 2..3
(`MIN_PACKED_FORMAT_VERSION..PACKED_FORMAT_VERSION`) and decodes directory
codec 5..6; every writer emits 3 / 6, and `formatVersion: 1` is refused. The v2
window is read-only and exists because several published archives have no
reproducible source: v2 differs in the CONTAINER only (no `variants` registry,
directory v5 with no per-entry `variantId`), and the tile payload is the same
layer frame. A dataset MUST be opened through its `manifest.json` — both the
schema template registry (built from `manifest.schemas`) and the declared
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
  `'elevation-fold'`, `'time-delta'`, `'vertex-value-quant'`,
  `'triangles-partial'`, and `'vertex-time-feature-anchor'`).
- rejects any unrecognized `formatVersion` or `directoryVersion`.

## Archive options

`STTArchive` is constructed from a manifest URL, or from an `ArchiveOptions`
object whose only required field is `url`.

Every fetched blob's CRC-32C (from the directory) is verified over its
**compressed** bytes BEFORE decompression, on both the worker and inline decode
paths — unconditionally, with no opt-out. A mismatch rejects that tile's decode
with a distinctive `crc32c mismatch` error through the normal per-tile error
surface. Entries whose directory CRC is `0`/absent (synthetic archives) and
OPFS-decompressed warm hits have no compressed bytes to check and skip it.

| Option                        | Type                | Default                                                 | Description                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| :---------------------------- | :------------------ | :------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retainArrowIpc`              | `boolean \| 'auto'` | `'auto'`                                                | Whether decoded layers keep their raw Arrow IPC bytes (`arrowIpc` / `arrowTable`) for lazy `toGeoArrowTable()`. `'auto'` drops the reference only for coordinate-quantized (`stt:quant`) layers — whose tables are not literal GeoArrow anyway — and keeps it everywhere `toGeoArrowTable()` is valid. `true` always keeps; `false` always drops (smallest memory). `toGeoArrowTable()` on a dropped layer throws an error naming this option. |
| `maxCacheTiles`               | `number`            | 500 desktop / 250 at `deviceMemory ≤ 4 GB` / 100 mobile | Maximum compressed tile entries retained by this archive. The cache is insertion-ordered LRU; pass `0` to disable it.                                                                                                                                                                                                                                                                                                                          |
| `maxCacheBytes`               | `number`            | 512 MiB desktop / 256 MiB low-memory                    | Maximum compressed bytes retained by this archive. A process-wide LRU applies the same device-aware byte ceiling across all archives, so multi-source maps cannot multiply it. Pass `0` to disable the compressed cache.                                                                                                                                                                                                                       |
| `opfsCache`                   | `boolean`           | `false`                                                 | Enable the OPFS-backed persistent tile cache. **`false` everywhere**, including browsers exposing `navigator.storage.getDirectory` — persistence is strictly opt-in. On the cold path it costs a duplicate main-thread zstd decompress per tile, so leave it off unless the archive fits in `opfsCacheMaxBytes` AND users revisit the same viewport across reloads.                                                                            |
| `opfsCacheMaxBytes`           | `number`            | 512 MB                                                  | Soft byte budget for the OPFS cache.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `opfsCacheDirectory`          | `string`            | `'stt-cache'`                                           | Subdirectory name under the OPFS root.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `coalesceGapBytes`            | `number`            | 2 MiB                                                   | Max gap between two tile byte-ranges that `getTiles` still bridges into ONE coalesced HTTP range request. On free-egress storage (R2) the gap bytes are free, so a wider gap fuses more neighbours into fewer billed GETs; lower it on metered-egress hosts or very sparse archives. Supplying it PINS the gap (no adaptation).                                                                                                                |
| `maxConcurrentRequests`       | `number`            | `24`                                                    | Concurrent HTTP range requests kept in flight for one batch, after coalescing. Bounds the pathological sparse case so it cannot exceed an object store's per-connection stream cap (R2 closes at ~75).                                                                                                                                                                                                                                         |
| `transferTimeoutMs`           | `number`            | `20000`                                                 | Per-transfer stall watchdog on every fetch (manifest, directory, pack ranges). A response that neither completes nor errors in the window is aborted with a `TimeoutError` and retried as a TRANSIENT failure; caller aborts propagate immediately and are never retried. `0` disables the watchdog.                                                                                                                                           |
| `retryDelaysMs`               | `number[]`          | `[250, 1000]`                                           | Backoff schedule for a failed range request; the array length IS the retry count and each delay is jittered ±50%. `[]` disables retries.                                                                                                                                                                                                                                                                                                       |
| `directoryPageThresholdBytes` | `number`            | `262144`                                                | Paged-directory whole-load cutoff. A paged `.sttd` at or under this size is fetched in one GET and fully decoded; above it only the root page is fetched up front and leaf pages stream in on demand. `0` always pages. No effect on single directories.                                                                                                                                                                                       |
| `schedulerWeight`             | `number`            | `1`                                                     | Relative weight of this archive in the process-shared request scheduler's weighted-fair (DRR) slot share when several archives composite into one scene. Work-conserving — a single archive gets the whole budget regardless of weight.                                                                                                                                                                                                        |
| `decoder`                     | `TileDecoder`       | worker pool where module workers work                   | Override the tile decoder; pass `new InlineTileDecoder()` to force inline decoding.                                                                                                                                                                                                                                                                                                                                                            |
| `fetch`                       | `typeof fetch`      | `globalThis.fetch`                                      | Custom fetch (auth headers, instrumentation).                                                                                                                                                                                                                                                                                                                                                                                                  |

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
`ManifestSchemaTemplate` (a `{ hash, data }` entry of a manifest's `schemas`
table), and `TileMetaJson` (the parsed `TILE_META` section).

## Source

- `packages/core/src/tile-decoder.ts` — pool implementation and inline fallback.
- `packages/core/src/tile-decoder.worker.ts` — the worker entry point.
- `packages/core/src/tile.ts` — `decodeTile()`, `getFeatureProperties()`, `toGeoArrowTable()`, `DecodeTileOptions`, `TemplateRegistry`.
- `packages/core/src/archive.ts` — `STTArchive`, `ArchiveOptions`, manifest parsing, `KNOWN_MANIFEST_CAPABILITIES`, `ManifestSchemaTemplate`.
- `packages/core/src/crc32c.ts` — `crc32c()`, `verifyCrc32c()`.
- `packages/core/src/blake3.ts` — `blake3()`, `blake3Hex128()`.
- `packages/core/src/tile-source.ts` — the loaders.gl-shaped `TileSource` adapter.

# SpatioTemporal Tiles (STT)

> **A single-file tile format for interactive spatiotemporal data visualization**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Rust](https://img.shields.io/badge/rust-1.70+-orange.svg)](https://www.rust-lang.org/)
[![TypeScript](https://img.shields.io/badge/typescript-5.4+-blue.svg)](https://www.typescriptlang.org/)

---

## What is STT?

STT is a **single-file archive format** for spatiotemporal data. It combines a
spatial tile pyramid with a temporal axis — each tile is addressed by
`(zoom, x, y, time-bucket)` — so a deck.gl client can stream only the tiles in
the current viewport *and* time window, and animate over time.

Tile payloads are **Apache Arrow IPC** with **GeoArrow**-encoded geometry — a
standard, columnar, GPU-friendly representation that interops directly with
`@geoarrow/deck.gl-layers`, Lonboard, and kepler.gl 3.x.

### Key features

- 📦 **Single-file archives** — deploy to a CDN, no tile server needed.
- 🌐 **HTTP Range Requests** — the header, index, and each tile are fetched
  with independent range requests.
- 🗜️ **Apache Arrow payloads** — GeoArrow geometry + columnar properties,
  zstd-compressed per tile, with a CRC32C integrity tag per tile. (A shared
  zstd-dictionary header slot is reserved but not currently used.)
- 🕒 **Temporal tiling** — features are bucketed into fixed time intervals for
  predictable, animation-friendly loading. Optional coarser-bucket pyramid
  (`--temporal-lod`) for multi-scale animation.
- 🎯 **Hilbert-ordered directory** — tiles are stored in spatial-locality order
  for better CDN cacheability and smaller seek footprints during pans.
- 🧭 **H3 summary tier** — optional pre-aggregated low-zoom tier for
  100M+ scale point datasets.
- 🔧 **Stack** — Rust (`arrow`, `geo`, `geozero`) builder + TypeScript
  (`apache-arrow`, deck.gl, MapLibre) reader and layers.

---

## Quick start

### 1. Build the CLI

```bash
git clone https://github.com/robertchristie/spatiotemporal-tiles.git
cd spatiotemporal-tiles
cargo build --release
```

### 2. Build an STT archive from GeoParquet

```bash
./target/release/stt-build \
  --input data.parquet \
  --output tiles.stt \
  --time-field timestamp \
  --time-format unix-ms \
  --min-zoom 0 --max-zoom 8 \
  --temporal-bucket 1h
```

The input must be a Parquet file with either a WKB/GeoArrow geometry column or
separate `lon`/`lat` columns, plus a timestamp column. Convert other formats
first, e.g. `ogr2ogr -f Parquet data.parquet data.geojson`.

### 3. Visualize with deck.gl

```typescript
import { AnimatedPointLayer, TimeController } from "@stt/deck.gl";

const layer = new AnimatedPointLayer({
  id: "earthquakes",
  data: "/data/earthquakes.stt",
  currentTime: Date.now(),
});
```

### …or with native MapLibre GL

```typescript
import maplibregl from "maplibre-gl";
import { STTPointLayer } from "@stt/maplibre";

const map = new maplibregl.Map({ container: "map", style: "..." });
const layer = new STTPointLayer({
  id: "earthquakes",
  url: "/data/earthquakes.stt",
  currentTime: Date.now(),
  timeWindow: 24 * 60 * 60 * 1000,
});
map.on("load", () => map.addLayer(layer));
```

See [`docs/api/stt-maplibre.md`](./docs/api/stt-maplibre.md) for the full
adapter API.

---

## Archive format

```
┌──────────────────┐
│ Header (64 B)    │  Magic "STT\x03", compression, dict/index/metadata offsets
├──────────────────┤
│ Tile blobs       │  zstd(Arrow IPC layer frame), CRC32C-tagged
├──────────────────┤
│ Dictionary       │  Reserved zstd-dictionary slot (currently unused)
├──────────────────┤
│ Index            │  Arrow IPC table — one row per tile (the directory)
├──────────────────┤
│ Metadata         │  UTF-8 JSON — bounds, time range, zoom levels, schemas
└──────────────────┘
```

Each tile blob is a small *layer frame* (`[u16 count]` then per-layer
`[name][Arrow IPC]`); every layer is one Arrow `RecordBatch` whose `geometry`
column is GeoArrow-encoded. The directory is itself an Arrow table, so the
Rust writer and the TypeScript reader use one Arrow implementation throughout.

---

## Repository structure

```
spatiotemporal-tiles/
├── crates/                 # Rust
│   ├── stt-core/           # Archive + Arrow tile format library
│   ├── stt-build/          # CLI: GeoParquet -> .stt
│   ├── stt-generate/       # Bundled showcase-dataset generators
│   ├── stt-optimize/       # Input analysis + recommendations (powers --auto)
│   └── stt-validate/       # CRC32C-check + decode every tile in an archive
├── packages/               # TypeScript
│   ├── core/               # Archive reader, decoder pool, OPFS cache
│   ├── deck.gl/            # deck.gl layers + extensions
│   └── maplibre/           # MapLibre GL custom-layer adapter
├── examples/showcase/      # Interactive demo app (deck.gl + MapLibre)
├── tools/
│   ├── bench/              # @stt/core load + decode benchmark (Node)
│   ├── perf/               # Real-WebGL Playwright perf harness
│   └── render-test/        # Playwright fidelity sweep (baselines + diffs)
└── docs/                   # Format spec, API reference, guides
```

---

## Development

```bash
cargo test --workspace          # Rust tests
cargo build --release           # CLI binaries (stt-build, stt-generate, ...)

pnpm install
pnpm --filter @stt/core build
pnpm --filter @stt/core test    # TS reader tests against a real archive
pnpm --filter @stt/deck.gl build
pnpm --filter @stt/maplibre build

pnpm --filter @stt/showcase dev # Run the showcase locally
```

Tooling:

```bash
pnpm --filter @stt/bench bench                   # @stt/core load/decode benchmark
pnpm --filter @stt/render-test sweep             # fidelity + perf sweep
pnpm --filter @stt/perf perf -- <demo-id>        # real-WebGL perf harness
```

---

## License

MIT © Robert Christie

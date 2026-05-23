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

Tile payloads are **Apache Arrow IPC** with **GeoArrow**-encoded geometry, so
they are a standard, columnar, GPU-friendly format rather than a bespoke
encoding.

### Key features

- 📦 **Single-file archives** — deploy to a CDN, no tile server needed.
- 🌐 **HTTP Range Requests** — the header, index, and each tile are fetched
  with independent range requests.
- 🗜️ **Apache Arrow payloads** — GeoArrow geometry + columnar properties,
  gzip-compressed per tile, content-addressed and de-duplicated.
- 🕒 **Temporal tiling** — features are bucketed into fixed time intervals for
  predictable, animation-friendly loading.
- 🎯 **Hilbert-ordered directory** — tiles are stored in spatial-locality order.
- 🔧 **Modern stack** — Rust (`arrow`, `geo`, `geozero`) builder + TypeScript
  (`apache-arrow`, deck.gl) reader.

> **Status:** the build pipeline, archive format, and TypeScript reader are
> implemented and tested end-to-end (Rust ↔ browser). The deck.gl layers
> render from the Arrow format; GPU-accelerated time filtering for the
> point/path/trip layers is driven by a shader uniform via
> `TimeFilterExtension`.

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

---

## Archive format

```
┌──────────────────┐
│ Header (64 B)    │  Magic "STT\x02", compression, index/metadata offsets
├──────────────────┤
│ Tile blobs       │  gzip(Arrow IPC layer frame), content-addressed
├──────────────────┤
│ Index            │  Arrow IPC table — one row per tile (the directory)
├──────────────────┤
│ Metadata         │  UTF-8 JSON — bounds, time range, zoom levels
└──────────────────┘
```

Each tile blob is a small *layer frame* (`[u16 count]` then per-layer
`[name][Arrow IPC]`); every layer is one Arrow `RecordBatch` whose `geometry`
column is GeoArrow-encoded. The directory is itself an Arrow table, so both the
Rust writer and the TypeScript reader use one Arrow implementation throughout.

---

## Repository structure

```
spatiotemporal-tiles/
├── crates/                 # Rust
│   ├── stt-core/           # Archive + Arrow tile format library
│   ├── stt-build/          # CLI: GeoParquet -> .stt
│   ├── stt-generate/       # Sample dataset generators
│   └── stt-optimize/       # Archive/dataset analysis CLI
├── packages/               # TypeScript
│   ├── core/               # Archive reader (apache-arrow)
│   └── deck.gl/            # deck.gl layers + extensions
└── examples/showcase/      # Interactive demo app
```

---

## Development

```bash
cargo test --workspace          # Rust tests
cargo build --release           # CLI binaries

pnpm install
pnpm --filter @stt/core test     # TypeScript reader tests (vs a real archive)
pnpm --filter @stt/core build
```

---

## License

MIT © Robert Christie

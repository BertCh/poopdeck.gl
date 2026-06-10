# SpatioTemporal Tiles (STT)

> **A cloud-native, edge-cacheable tile format for interactive spatiotemporal data visualization**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Rust](https://img.shields.io/badge/rust-1.70+-orange.svg)](https://www.rust-lang.org/)
[![TypeScript](https://img.shields.io/badge/typescript-5.4+-blue.svg)](https://www.typescriptlang.org/)

---

## What is STT?

STT is a **cloud-native tile format** for spatiotemporal data. A dataset is a
tiny `manifest.json` plus many immutable, content-addressed **pack** objects, so
it deploys to any static host or CDN and every object edge-caches natively — no
tile server, no Worker. It combines a spatial tile pyramid with a temporal axis
— each tile is addressed by `(zoom, x, y, time-bucket)` — so a deck.gl client
streams only the tiles in the current viewport *and* time window, and animates
over time.

Tile payloads are **Apache Arrow IPC** with **GeoArrow**-encoded geometry — a
standard, columnar, GPU-friendly representation that interops directly with
`@geoarrow/deck.gl-layers`, Lonboard, and kepler.gl 3.x.

### Key features

- 📦 **Packed, content-addressed** — a dataset is `manifest.json` + many
  immutable `packs/*.sttp` (each ≤64 MiB) + a directory object. Deploy to
  R2 / S3 / GCS / nginx; no tile server needed.
- 🌐 **Edge-cacheable by construction** — immutable packs cache forever on a
  plain CDN; only the tiny manifest is mutable. Cacheability is a property of
  the *format*, not the deploy.
- 🌐 **HTTP Range Requests** — tiles are fetched with per-pack range requests,
  coalesced within each pack.
- 🗜️ **Apache Arrow payloads** — GeoArrow geometry + columnar properties,
  per-blob zstd-compressed (no shared dictionary), with a CRC32C integrity tag
  per tile.
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

### 2. Build a packed dataset from GeoParquet

```bash
./target/release/stt-build \
  --input data.parquet \
  --output tiles \
  --time-field timestamp \
  --time-format unix-ms \
  --min-zoom 0 --max-zoom 8 \
  --temporal-bucket 1h
```

This writes a `tiles/` directory (`manifest.json` + `index/*.sttd` +
`packs/*.sttp`). The input must be a Parquet file with either a WKB/GeoArrow
geometry column or separate `lon`/`lat` columns, plus a timestamp column.
Convert other formats first, e.g. `ogr2ogr -f Parquet data.parquet data.geojson`.
Then sync the `tiles/` tree to any static host (`scripts/r2-sync.sh` sets the
immutable-pack / short-TTL-manifest cache headers).

### 3. Visualize with deck.gl

```typescript
import { AnimatedPointLayer, TimeController } from "@stt/deck.gl";

const layer = new AnimatedPointLayer({
  id: "earthquakes",
  data: "/data/earthquakes/manifest.json",
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
  url: "/data/earthquakes/manifest.json",
  currentTime: Date.now(),
  timeWindow: 24 * 60 * 60 * 1000,
});
map.on("load", () => map.addLayer(layer));
```

See [`docs/api/stt-maplibre.md`](./docs/api/stt-maplibre.md) for the full
adapter API.

---

## Dataset format

A dataset is a directory of small, immutable, content-addressed objects plus a
tiny manifest:

```
data/<dataset>/
  manifest.json          # metadata + directory pointer + pack table (mutable, short TTL)
  index/<blake3>.sttd    # the directory: one run-length row per tile (immutable)
  packs/<blake3>.sttp    # tile-blob data, ≤64 MiB each (immutable)
  packs/<blake3>.sttp
  ...
```

The reader fetches `manifest.json`, then the directory object, then each tile via
a Range request against the right pack — a cold load is 1 manifest + 1 directory
+ N pack ranges; warm is all served from edge cache. Full spec:
[`docs/spec/stt-packed-format.md`](./docs/spec/stt-packed-format.md) (machine-
checkable manifest schema: [`manifest.schema.json`](./docs/spec/manifest.schema.json)).

Each tile blob is a small *layer frame* (`[u16 count]` then per-layer
`[name][Arrow IPC]`); every layer is one Arrow `RecordBatch` whose `geometry`
column is GeoArrow-encoded. The directory and every tile decode with one Arrow
implementation across the Rust writer and the TypeScript reader.

---

## Repository structure

```
spatiotemporal-tiles/
├── crates/                 # Rust
│   ├── stt-core/           # Archive + Arrow tile format library
│   ├── stt-build/          # CLI: GeoParquet -> packed dataset
│   ├── stt-generate/       # Bundled showcase-dataset generators
│   ├── stt-optimize/       # Input analysis + recommendations (powers --auto)
│   └── stt-validate/       # Content-address + CRC32C + decode check (packed or legacy .stt)
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

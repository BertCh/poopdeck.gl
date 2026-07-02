# SpatioTemporal Tiles (STT)

> **A cloud-native, edge-cacheable tile format for interactive spatiotemporal data visualization**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Rust](https://img.shields.io/badge/rust-1.85+-orange.svg)](https://www.rust-lang.org/)
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

**See it live:** the showcase app (`examples/showcase`, deployed on Cloudflare)
carries dozens of real-dataset demos, the rendered docs at `/docs`, an AV LIDAR
cockpit at `/drive`, and a scrollytelling data story at `/story/drifters`.

**Scope:** STT is for temporally-tiled **vector** data — trajectories, events,
and time-varying features. Time-varying rasters and datacubes are out of scope;
use [GeoZarr](https://github.com/zarr-developers/geozarr-spec) or COG for those.

### Key features

- 📦 **Packed, content-addressed** — a dataset is `manifest.json` + many
  immutable `packs/*.sttp` (≤64 MiB each by default) + a directory object.
  Deploy to R2 / S3 / GCS / nginx; no tile server needed.
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
- 🎯 **Locality-aware layout** — directory entries are Hilbert-sorted, and tile
  blobs are packed in locality-preserving order (`--blob-ordering auto` picks
  3D-Hilbert or spatial-major per dataset) so a viewport touches few packs.
- 🧭 **H3 summary tier** — optional pre-aggregated low-zoom tier for
  100M+ scale point datasets.
- 🔧 **Stack** — Rust (`arrow`, `geo`, `geozero`) builder + TypeScript
  (`apache-arrow`, deck.gl, MapLibre) reader and layers.

---

## Quick start

### 1. Build the CLI

```bash
git clone https://github.com/BertCh/spatiotemporal-tiles.git
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

> The `@poopdeck.gl/*` packages are **not published to npm yet**. To use them
> today, build them from this repo (`pnpm install && pnpm build`) and depend on
> them through a pnpm workspace or `pnpm link` — `npm install @poopdeck.gl/…`
> will 404 until they ship.

```typescript
import { AnimatedPointLayer } from "@poopdeck.gl/layers";
import { TimeController } from "@poopdeck.gl/playback";

const controller = new TimeController({ speed: 3600 }); // 1h of data per second
controller.play();

const layer = new AnimatedPointLayer({
  id: "earthquakes",
  data: "/data/earthquakes/manifest.json",
  currentTime: Date.now(),
  timeWindow: 24 * 60 * 60 * 1000,
  timeController: controller,
});
```

See [`docs/api/`](./docs/api/) for the full layer catalog
(paths, trips, polygons, heatmap, H3 summary).

### …or with native MapLibre GL

```typescript
import maplibregl from "maplibre-gl";
import { STTPointLayer } from "@poopdeck.gl/maplibre";

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
  index/<blake3>.sttd    # the directory: varint tile index, RLE over shared blobs (immutable)
  packs/<blake3>.sttp    # tile-blob data, ≤64 MiB each by default (immutable)
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
│   ├── stt-validate/       # Content-address + CRC32C + decode check (packed or single-file .stt)
│   └── stt-serve/          # Dynamic per-request STT tile server over PostGIS/DuckDB
├── packages/               # TypeScript
│   ├── core/               # Archive reader, decoder pool, OPFS cache + the
│   │                       #   framework-free RENDER KERNEL every backend shares:
│   │                       #   core/{time-filter,style,geometry,geo,picking,
│   │                       #   tileset-adapter,shader-codegen,capabilities}
│   ├── layers/             # deck.gl backend (layers + extensions)
│   ├── three/              # Three.js + TSL (WebGPU) backend
│   ├── maplibre/           # MapLibre GL custom-layer backend
│   ├── cesium/             # CesiumJS (WGS84 globe) backend
│   ├── playback/           # Time controller + playback governor (zero-dep)
│   └── react/              # React playback hooks + UI controls
├── examples/showcase/      # Interactive demo app (deck.gl + MapLibre + Three)
├── tools/
│   ├── bench/              # @poopdeck.gl/core load + decode benchmark (Node)
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
pnpm --filter @poopdeck.gl/core build
pnpm --filter @poopdeck.gl/core test    # TS reader tests against a real archive
pnpm --filter @poopdeck.gl/layers build
pnpm --filter @poopdeck.gl/three build
pnpm --filter @poopdeck.gl/maplibre build
pnpm --filter @poopdeck.gl/cesium build

pnpm --filter @poopdeck.gl/showcase dev # Run the showcase locally
```

### Rendering backends

STT renders through multiple, interchangeable backends (deck.gl, Three.js+TSL,
MapLibre, CesiumJS) that all consume the same decoded tiles and playback clock.
Shared logic (time-filter, color, projection, geometry, picking, tileset glue,
shader-alpha codegen) lives in a framework-free **render kernel** under
`@poopdeck.gl/core` sub-paths; each backend is a thin adapter that publishes a
capability `BackendDescriptor`. See
[docs/roadmap/renderer-abstraction-2026-06.md](docs/roadmap/renderer-abstraction-2026-06.md)
for the design and [docs/spec/backend-capabilities.md](docs/spec/backend-capabilities.md)
for the generated capability matrix.

Tooling:

```bash
pnpm --filter @poopdeck.gl/bench bench                   # @poopdeck.gl/core load/decode benchmark
pnpm --filter @poopdeck.gl/render-test sweep             # fidelity + perf sweep
pnpm --filter @poopdeck.gl/perf perf -- <demo-id>        # real-WebGL perf harness
```

---

## License

MIT © Robert Christie

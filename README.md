# SpatioTemporal Tiles (STT)

> **A cloud-native, edge-cacheable tile format for interactive spatiotemporal data visualization**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MSRV](https://img.shields.io/crates/msrv/spatiotemporal-tiles?label=msrv)](./Cargo.toml)
[![TypeScript](https://img.shields.io/badge/typescript-5.4+-blue.svg)](https://www.typescriptlang.org/)

**→ [poopdeck.gl](https://poopdeck.gl)** — the live showcase: dozens of
real-dataset demos, the rendered docs, and the AV cockpit.

| Live surface                                                     | What it is                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------- |
| [poopdeck.gl/demos](https://poopdeck.gl/demos)                   | Demo gallery — every dataset below, animating         |
| [poopdeck.gl/how-it-works](https://poopdeck.gl/how-it-works)     | Illustrated explainer of the space×time tile model    |
| [poopdeck.gl/docs](https://poopdeck.gl/docs)                     | This repo's `docs/` tree, rendered                    |
| [poopdeck.gl/drive](https://poopdeck.gl/drive)                   | AV cockpit — nuScenes / Argoverse 2 LIDAR scenes      |
| [poopdeck.gl/story/drifters](https://poopdeck.gl/story/drifters) | Scrollytelling data story: 40 years of ocean drifters |
| [poopdeck.gl/worlds](https://poopdeck.gl/worlds)                 | NVIDIA Cosmos Drive Dreams world-model scenarios      |

**Three names, one project:** **STT** is the format; **`spatiotemporal-tiles`**
is the Rust toolchain that writes it; **`@poopdeck.gl/*`** are the TypeScript
packages that render it.

---

> **For AI coding agents:** start with [`AGENTS.md`](./AGENTS.md) — repo map,
> the build→render pipeline, a routing table to the CLIs/packages/docs, and the
> ground rules (no-thinning, the manifest is the contract, deck.gl pinned 9.3.x).

## What is STT?

STT is a tile format for spatiotemporal data. A dataset is a small
`manifest.json` plus many immutable, content-addressed **pack** objects, so it
deploys to any static host or CDN — no tile server, no Worker. It adds a temporal
axis to a spatial tile pyramid: each tile is addressed by
`(zoom, x, y, time-bucket)`, so a client streams only the tiles in the current
viewport _and_ time window, and animates over time.

Tile payloads are Apache Arrow IPC with GeoArrow-encoded geometry, which
interops directly with `@geoarrow/deck.gl-layers`, Lonboard, and kepler.gl 3.x.

**Scope:** temporally-tiled _vector_ data — trajectories, events, and
time-varying features. Time-varying rasters and datacubes are out of scope; use
[GeoZarr](https://github.com/zarr-developers/geozarr-spec) or COG for those.

**See it live:** everything in the table above is one app —
`examples/showcase`, deployed to [poopdeck.gl](https://poopdeck.gl) on
Cloudflare — running against the same packed archives this repo builds.

### Key features

- **Packed, content-addressed** — `manifest.json` + immutable `packs/*.sttp`
  (≤64 MiB each by default) + a directory object. Deploy to R2 / S3 / GCS /
  nginx. Immutable packs cache forever on a plain CDN; only the manifest is
  mutable.
- **HTTP Range reads** — tiles are fetched by range request, coalesced within
  each pack.
- **Apache Arrow payloads** — GeoArrow geometry + columnar properties, per-blob
  zstd-compressed (no shared dictionary), CRC32C integrity tag per tile.
- **Temporal tiling** — features are bucketed into fixed time intervals, with an
  optional coarser-bucket pyramid (`--temporal-lod`) for multi-scale animation.
- **Locality-aware layout** — directory entries are Hilbert-sorted and tile blobs
  are packed in locality-preserving order (`--blob-ordering auto` picks
  3D-Hilbert or spatial-major per dataset), so a viewport touches few packs.
- **H3 summary tier** — optional pre-aggregated low-zoom tier for 100M+ point
  datasets.
- **Stack** — Rust (`arrow`, `geo`, `geozero`) builder; TypeScript
  (`apache-arrow`, deck.gl, MapLibre) reader and layers.

---

## Quick start

Starting from a CSV? The [CSV → animated map guide](./docs/guides/csv-quickstart.md)
is the fastest end-to-end path (DuckDB one-liner included).

### 1. Install the CLIs

```bash
cargo install spatiotemporal-tiles
```

`cargo install spatiotemporal-tiles` installs five binaries — `stt-build`,
`stt-optimize`, `stt-validate`, `stt-bundle`, `stt-serve` — and **not**
`stt-generate`, which is `publish = false` and builds only from a repo
checkout. (Or build the whole toolchain from a checkout with
`cargo build --release` and use `./target/release/stt-build`.) The minimum
supported Rust version is whatever `rust-version` says in
[`Cargo.toml`](./Cargo.toml) — that field is the single source of truth and CI
enforces it.

### 2. Build a packed dataset from GeoParquet

```bash
stt-build \
  --input data.parquet \
  --output tiles \
  --time-field timestamp \
  --time-format unix-ms \
  --min-zoom 0 --max-zoom 8 \
  --temporal-bucket 1h
```

Not sure about the knobs? `--auto` analyzes the input and picks the zoom
range, temporal bucket, and compression for you (explicit flags still win).
Keep `--max-zoom` honest for dense point data — deep zooms multiply tile
counts fast. Check the result with `stt-validate tiles`.

This writes a `tiles/` directory (`manifest.json` + `index/*.sttd` +
`packs/*.sttp`). The input must be a Parquet file with either a WKB/GeoArrow
geometry column or separate `lon`/`lat` columns, plus a timestamp column.
Convert other formats first, e.g. `ogr2ogr -f Parquet data.parquet data.geojson`.
Then sync the `tiles/` tree to any static host (`scripts/r2-sync.sh` sets the
immutable-pack / short-TTL-manifest cache headers).

### 3. Visualize with deck.gl

```bash
npm install @poopdeck.gl/layers @poopdeck.gl/playback deck.gl   # renderer + clock + peer
```

```typescript
import { Deck } from '@deck.gl/core';
import { AnimatedPointLayer } from '@poopdeck.gl/layers';
import { SttPlayer } from '@poopdeck.gl/playback';

const player = new SttPlayer({
  timeRange: { start, end },
  baseRate: (end - start) / 60_000, // dataset plays in ~60 s at 1×
  loop: true,
});

const layer = new AnimatedPointLayer({
  id: 'earthquakes',
  data: 'https://tiles.example.com/earthquakes/manifest.json',
  timeController: player.timeController, // layers READ the clock; the player drives it
  timeWindow: 86_400_000,
  onTilesetReady: (tileset) => player.setSource(tileset), // buffering gates playback
  onBufferChange: (runway) => player.notifyBufferChange(runway),
});

new Deck({ layers: [layer] });
player.play();
```

[`SttPlayer`](./docs/api/stt-player.md) is the recommended entry point — an
`HTMLMediaElement`-style facade that owns the clock _and_ the buffering
governor, so playback stalls instead of skipping over tiles that have not
arrived. Reach for the bare [`TimeController`](./docs/api/time-controller.md)
only when you are driving the clock from something else.

See [`docs/api/`](./docs/api/) for the full layer catalog
(paths, trips, polygons, heatmap, H3 summary).

React apps get the clock, buffering governor, and a ready-made transport bar
from [`@poopdeck.gl/react`](./packages/react) (`usePlayback` +
`<PlaybackControls {...pb} />` + one CSS import).

### …or with native MapLibre GL

```typescript
import maplibregl from 'maplibre-gl';
import { STTPointLayer } from '@poopdeck.gl/maplibre';

const map = new maplibregl.Map({ container: 'map', style: '...' });
const layer = new STTPointLayer({
  id: 'earthquakes',
  url: '/data/earthquakes/manifest.json',
  currentTime: Date.now(),
  timeWindow: 24 * 60 * 60 * 1000,
});
map.on('load', () => map.addLayer(layer));
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
a Range request against the right pack. A cold load is one manifest, one
directory, and N pack ranges; a warm load is served entirely from edge cache.
Full spec: [`docs/spec/stt-packed-format.md`](./docs/spec/stt-packed-format.md)
(machine-checkable manifest schema:
[`manifest.schema.json`](./docs/spec/manifest.schema.json)).

Each tile blob is a small _layer frame_ (`[u16 count]` then per-layer
`[name][Arrow IPC]`); every layer is one Arrow `RecordBatch` whose `geometry`
column is GeoArrow-encoded. The directory and every tile decode with one Arrow
implementation across the Rust writer and the TypeScript reader.

---

## Repository structure

```
spatiotemporal-tiles/
├── crates/                 # Rust workspace — the 4 PUBLISHED crates
│   ├── stt-core/           # Archive + Arrow tile format library
│   ├── stt-build/          # Library: GeoParquet / PostGIS / DuckDB -> packed dataset
│   ├── stt-optimize/       # Input analysis + recommendations (powers --auto)
│   └── spatiotemporal-tiles/  # Umbrella crate: re-exports the libraries above and
│       └── src/bin/           #   ships every other CLI: stt-build, stt-optimize,
│                              #   stt-validate (content-address + CRC32C + decode check over
│                              #   packed dirs or .sttb bundles), stt-bundle (pack/unpack
│                              #   single-file .sttb interchange bundles), stt-serve (dynamic
│                              #   per-request STT tile server over PostGIS/DuckDB)
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
│   ├── stt-generate/       # Bundled showcase-dataset generators (+ the stt-generate
│   │                       #   CLI). Repo-only (publish = false) and its OWN cargo
│   │                       #   workspace, so its dep tree's MSRV never reaches the
│   │                       #   published crates.
│   ├── bench/              # @poopdeck.gl/core load + decode benchmark (Node)
│   ├── perf/               # Real-WebGL Playwright perf harness
│   └── render-test/        # Playwright fidelity sweep (baselines + diffs)
└── docs/                   # Format spec, API reference, guides
```

---

## Development

```bash
cargo test --workspace          # Rust tests (the 4 published crates)
cargo build --release           # CLI binaries (stt-build, stt-validate, ...)
cargo test --manifest-path tools/stt-generate/Cargo.toml   # the generator's own workspace

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
[docs/roadmap/renderer-architecture.md](docs/roadmap/renderer-architecture.md)
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

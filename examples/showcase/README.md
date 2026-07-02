# Showcase

Interactive demo of the SpatioTemporal Tile (`.stt`) format, deck.gl
layers (`@poopdeck.gl/layers`), and MapLibre adapters (`@poopdeck.gl/maplibre`) across
dozens of real and synthetic datasets.

## Pages

- `/` — landing page
- `/demos` — dataset gallery; `/demos/:datasetId` — per-dataset detail page
- `/demo/:datasetId` — single-dataset deck.gl demo with the time
  controller, the perf HUD, and the `__sttProbe` channel tap
- `/maplibre/:datasetId` — same data rendered through `@poopdeck.gl/maplibre`
- `/cesium/:datasetId` — same data rendered through `@poopdeck.gl/cesium`
- `/docs` — the repo's `docs/` rendered as the documentation site
  (nav manifest: `src/docs/manifest.ts`)
- `/drive/:sceneId?` — the AV LIDAR cockpit (nuScenes / Argoverse / Waymo /
  comma scene bundles)
- `/story/drifters` — scrollytelling ocean-drifter story

## Data Pipeline

Datasets are built by `stt-generate`, which fetches the source,
normalises it into GeoParquet, and shells out to `stt-build`. The
generators share `crates/stt-generate/src/common.rs` for coordinate
transforms, chrono-based temporal bucketing, and latitude-adjusted
distance math. CSV sources are ingested directly; HTTP sources are
cached under `data/`.

## Registered Datasets

The demo catalog is defined in [`src/datasets.ts`](./src/datasets.ts) — that
file is the single source of truth (id, layer kind, source, and per-demo
config). It's the list that drives the `/` gallery and `/demo/:id` routes, so
consult it directly rather than a copy here. The demos span every layer kind
the project ships, grouped roughly as:

- **Points** — earthquakes, ship traffic, flights, satellites, NYC taxi points
- **Paths & trips** — flight paths/trips, hurricane tracks, NYC taxi
  paths/trips/heads, ocean drifters, ECCO currents, animal migration
- **Polygons & cumulative** — wildfire perimeters, OSM edit "draw"
- **OD & flow** — NYC taxi flows (flow corridors), OD arcs, OD quadbin /
  H3 summary, OD heatmap, BIXI flowmaps (clustered / edge-bundled)
- **3D & space-time cube** — earthquake columns, the NYC taxi cube
- **Composite & domain** — NEXRAD storm radar, the AV cockpit
  (nuScenes / Argoverse / comma / synthetic)

## Building Locally

```bash
cd examples/showcase
pnpm install
pnpm dev
```

Datasets must be present under `public/data/`. They are NOT committed —
regenerate locally with `stt-generate`.

## Regenerating Datasets

```bash
# Build the toolchain once
cargo build --release

# `all` builds ONLY the no-setup datasets — earthquakes, hurricanes,
# wildfires — into the showcase's data directory.
./target/release/stt-generate all \
  --output-dir examples/showcase/public/data --skip-existing

# The rest need per-run parameters and must be run individually, e.g.:
./target/release/stt-generate ais --date 2024-01-01 \
  --output examples/showcase/public/data/ais-traffic.stt
./target/release/stt-generate flights --date 2020-01-06 \
  --output examples/showcase/public/data/flights.stt
./target/release/stt-generate nyc-rideshare --synthetic \
  --osrm-url http://localhost:5000 \
  --output examples/showcase/public/data/nyc-rideshare.stt
./target/release/stt-generate satellites \
  --output examples/showcase/public/data/satellites.stt
```

Per-dataset flags vary — run `stt-generate <subcommand> --help`. See the
[Data Generation Guide](../../docs/guides/data-generation.md) for the full
recipes.

## Tech Stack

- **React 18** + **TypeScript** + **Vite**
- **deck.gl 9.x** via `@poopdeck.gl/layers`
- **MapLibre GL 3+** via `@poopdeck.gl/maplibre`
- **`@poopdeck.gl/core`** for the archive reader, decoder pool, and tileset

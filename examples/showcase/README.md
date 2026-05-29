# Showcase

Interactive demo of the SpatioTemporal Tile (`.stt`) format, deck.gl
layers (`@stt/deck.gl`), and MapLibre adapters (`@stt/maplibre`) across
16 real and synthetic datasets.

## Pages

- `/` — landing page + dataset gallery
- `/demo/:datasetId` — single-dataset deck.gl demo with the time
  controller, the perf HUD, and the `__sttProbe` channel tap
- `/maplibre/:datasetId` — same data rendered through `@stt/maplibre`
- `/format` — annotated walk-through of the `.stt` archive layout
- `/layers` — gallery of every layer kind with an inline code example

## Data Pipeline

Datasets are built by `stt-generate`, which fetches the source,
normalises it into GeoParquet, and shells out to `stt-build`. The
generators share `crates/stt-generate/src/common.rs` for coordinate
transforms, chrono-based temporal bucketing, and latitude-adjusted
distance math. CSV sources are ingested directly; HTTP sources are
cached under `data/`.

## Registered Datasets (`src/datasets.ts`)

| Dataset id                   | Layer kind     | Source |
| ---------------------------- | -------------- | ------ |
| `earthquake-activity`        | point          | USGS M4.0+ global (2020–2024) |
| `flights`                    | point          | OpenSky ADS-B (24 h sample) |
| `flight-paths`               | path           | OpenSky, derived per-flight polylines |
| `flight-trips`               | trips          | OpenSky, per-vertex timed paths |
| `hurricanes`                 | path           | NOAA IBTrACS (Atlantic 2020–2023) |
| `nyc-rideshare`              | point          | NYC TLC + OSRM routed |
| `nyc-taxi-points`            | point          | derived from rideshare paths |
| `nyc-taxi-paths`             | path           | OSRM-routed taxi routes |
| `nyc-taxi-trips`             | trips          | per-vertex timed taxi routes |
| `nyc-taxi-vat`               | vat-trips      | vertex-animation-texture variant |
| `nyc-taxi-od-heatmap`        | heatmap        | OD pickups / dropoffs as GPU splats |
| `nyc-taxi-od-summary`        | h3 summary     | server-aggregated H3 hex bins |
| `ship-traffic`               | point          | NOAA Marine Cadastre AIS |
| `wildfires`                  | polygon        | NIFC perimeters (1000+ acres) |
| `satellites`                 | point          | CelesTrak TLE + SGP4 propagation |
| `satellite-trips-flat`       | trips          | satellites rendered as trip trails |

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

# Generate every dataset into the showcase's data directory
./target/release/stt-generate all \
  --output-dir examples/showcase/public/data --skip-existing

# Or one at a time
./target/release/stt-generate earthquakes \
  --output examples/showcase/public/data/earthquakes.stt
```

Per-dataset flags vary — run `stt-generate <subcommand> --help`.

## Tech Stack

- **React 18** + **TypeScript** + **Vite**
- **deck.gl 9.x** via `@stt/deck.gl`
- **MapLibre GL 3+** via `@stt/maplibre`
- **`@stt/core`** for the archive reader, decoder pool, and tileset

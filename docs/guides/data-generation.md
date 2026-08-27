# Data Generation Guide

This guide walks you through generating spatiotemporal tile **datasets** either
with the bundled `stt-generate` (for the showcase datasets) or with `stt-build`
directly (for your own data).

> **Output is a packed dataset directory.** `stt-build` (and `stt-generate`,
> which wraps it) writes the packed format — `manifest.json` + `index/*.sttd` +
> `packs/*.sttp`. The `--output name.stt` forms below are accepted for
> convenience: the `.stt` extension is **stripped to a `name/` directory**. The
> commands work as written; just expect a directory, not a single file. Deploy
> the directory with `scripts/r2-sync.sh` (immutable packs + short-TTL manifest).

For getting your own data into GeoParquet — the primary `stt-build` input
this guide assumes — see [Building from Python](./python.md); it covers
GeoPandas, DuckDB, and pyarrow. `stt-build` can also read straight from a
live **PostGIS** or **DuckDB** query with no GeoParquet export step at all;
see [Custom Data](#custom-data-using-stt-build) below.

## Prerequisites

1. **Install Rust:** [rustup.rs](https://rustup.rs/)
2. **Build the tools:**
   ```bash
   cargo install --path tools/stt-generate             # repo-only; its own workspace
   cargo install --path crates/spatiotemporal-tiles   # stt-build + the other CLIs
   ```
   `stt-generate` is `publish = false` — `cargo install spatiotemporal-tiles`
   does not give it to you, and it lives outside the root workspace (its dep
   tree carries a higher MSRV), so `cargo build -p stt-generate` from the repo
   root does not resolve it either.

## Quick Start

Every dataset is its own subcommand — there is no batch mode. Three of them need
no extra parameters and fetch everything they need:

```bash
stt-generate earthquakes --output data-fleet/earthquakes.stt
stt-generate hurricanes  --output data-fleet/hurricanes.stt
stt-generate wildfires   --output data-fleet/wildfires.stt
```

The rest need per-run parameters (a download date, an OSRM server, a GTFS feed,
an existing source archive) or long downloads — see [Available
Datasets](#available-datasets) below. The generated subcommand inventory lives
in [`../spec/stt-generate-datasets.json`](../spec/stt-generate-datasets.json).

## Available Datasets

Each section below carries the dataset's prose and its end-to-end recipe. For
the per-dataset flag list, run `stt-generate <subcommand> --help` or see the
[CLI reference](../api/cli-reference.md#stt-generate).

### Earthquakes (USGS)

Downloads earthquake data from the USGS API.

```bash
stt-generate earthquakes \
  --start-date 2020-01-01 \
  --end-date 2024-12-31 \
  --min-magnitude 4.5 \
  --output earthquakes.stt
```

### AIS Maritime Traffic (NOAA Marine Cadastre)

Processes AIS vessel tracking data from NOAA.

**Step 1:** Download raw data from [NOAA Marine Cadastre](https://marinecadastre.gov/ais/):

```bash
curl -o AIS_2024_01_01.zip \
  https://coast.noaa.gov/htdata/CMSP/AISDataHandler/2024/AIS_2024_01_01.zip
unzip AIS_2024_01_01.zip
```

**Step 2:** Process with stt-generate:

```bash
stt-generate ais \
  --input AIS_2024_01_01.csv \
  --output ais-traffic.stt \
  --sample-minutes 10 \
  --bounds "25.0,-80.0,45.0,-65.0"
```

Temporal sampling is opt-in: `--sample-minutes` here (and `--sample-seconds` on
`flights`) defaults to `0`, so every usable row is preserved.

### Flight Traffic (OpenSky Network)

Downloads historical flight data from OpenSky Network.

```bash
stt-generate flights \
  --date 2020-01-06 \
  --hours 0-23 \
  --bounds "25,-125,50,-65" \
  --output flights.stt
```

**Note:** OpenSky data is only available for Mondays from 2017-2020.

### Hurricane Tracks (NOAA IBTrACS)

Downloads historical hurricane track data.

```bash
stt-generate hurricanes \
  --start-year 2020 \
  --end-year 2024 \
  --output hurricanes.stt
```

### Wildfire Perimeters (NIFC)

Downloads wildfire perimeter polygons from NIFC.

```bash
stt-generate wildfires \
  --start-year 2020 \
  --end-year 2023 \
  --min-acres 1000 \
  --output wildfires.stt
```

### NYC Rideshare (TLC + OSRM)

Generates NYC taxi trajectories using real TLC data and OSRM routing.

**Synthetic mode (no external data required):**

```bash
stt-generate nyc-rideshare \
  --synthetic \
  --num-trips 1000 \
  --date 2024-01-15 \
  --output nyc-rideshare.stt
```

**With real TLC data:**

```bash
# Requires OSRM server with NYC data
./setup-osrm.sh

stt-generate nyc-rideshare \
  --input yellow_tripdata_2015-01.csv \
  --output nyc-rideshare.stt
```

The output geometry mode is chosen by flag: points by default, `--paths` for
routed LineStrings, `--od` for one straight 2-vertex origin→destination arc per
trip (no OSRM needed — the `AnimatedArcLayer`/`AnimatedLineLayer` overview
geometry), and `--flows` for pre-aggregated corridor flows.

`--flows` aggregates the routed trips onto the **real OSM street network**, so
it requires `--osm-pbf <file.osm.pbf>` — use the same extract OSRM was built
from (e.g. `osrm-data/new-york-latest.osm.pbf`) so routed vertices land on its
ways. Each corridor then traces exact street geometry and carries per-vertex
`vertex_values` traversal counts per `--flow-bin` (default `15m`) plus a
road-class `min_zoom` for vector-tile-style LOD.

### Montréal BIXI Flowmap (`bixi`)

Aggregates real [BIXI open-data](https://bixi.com/en/open-data/) bike-share
trips into directed **origin→destination station-pair flows**, each emitted as a
single 2-vertex `origin → destination` arc carrying a per-time-bucket count time
series. The size on the wire is bounded by _(kept pairs) × (buckets)_, not the
~13M raw trips/year, so a long span fits comfortably. The input CSV schema is
auto-detected (the 2022+ embedded-coordinate family and the 2014–2021 station-code
family).

```bash
stt-generate bixi \
  --input data/bixi-2024.zip \
  --from 2024-06-01 --to 2024-09-01 \
  --bin 1h \
  --output data-fleet/bixi-flowmap.stt
```

### GTFS Transit Ballet (`gtfs`)

Expands a static [GTFS](https://gtfs.org/) feed for **one service date** into a
paths dataset: every scheduled vehicle journey (trip) becomes a LineString
along its `shapes.txt` geometry with per-vertex timestamps interpolated in
shape-distance between consecutive `stop_times.txt` entries. It is the transit
counterpart of `bixi --paths` / `nyc-rideshare --paths` but needs **no routing
server** — the feed already carries both the geometry and the timetable.
Rendered with `type: 'trip-heads'`, a whole country's timetable animates as a
Mini-Tokyo-3D-style ballet of gliding vehicles.

A trip is included iff its `service_id` is active on `--date` (weekly
`calendar.txt` plus `calendar_dates.txt` exceptions). GTFS times past `24:00:00`
are anchored at local midnight of the service date in the feed's agency
timezone, then emitted as absolute Unix ms. `route_type` is emitted as a string
label (`bus`/`rail`/`tram`/…), not the numeric GTFS code, so categorical
`colorMapping` works.

```bash
# The busiest fully-defined NL OVapi service date (Friday, ~121k trips):
stt-generate gtfs \
  --feed data/gtfs-nl/feed \
  --date 20260703 \
  --output data-fleet/gtfs-nl
```

`--bake-elevation` samples the AWS Terrarium DEM along each trip and bakes
per-vertex terrain elevation (metres) into the archive's `vertex_values`
channel, so the fleet rides a 3D terrain basemap with no runtime DEM queries
(the renderer lifts each head dot via `elevationFromVertexValues`). Ground
modes get a max-grade clamp so a base tunnel does not climb the massif; aerial
modes (gondolas) span station-to-station. `--dem-zoom` (default 12) and
`--dem-cache` (default `data/dem/terrarium`) tune and cache the sampling.

### NYC Taxi Points (`nyc-taxi-points`)

Derives a Point dataset from an already-built `nyc-taxi-paths` LineString
dataset by interpolating each trip's polyline at a fixed time interval — no
OSRM re-run, the routed geometries baked into the packed dataset are reused
as-is.

```bash
stt-generate nyc-taxi-points \
  --input data-fleet/nyc-taxi-paths \
  --interval-seconds 15 \
  --output nyc-taxi-points.stt
```

### Ocean Drifters (NOAA Global Drifter Program)

Downloads 6-hourly drifting-buoy trajectories (positions + sea-surface
temperature as per-vertex values).

```bash
stt-generate drifters \
  --start 2021-01-01 --end 2022-01-01 \
  --output drifters.stt
```

`drifters-hourly` is the EXPERIMENTAL hourly-product variant
(`drifter_hourly_qc`) with the same flags (cache default
`data/gdp-hourly-cache`) — 6× the temporal resolution and volume of
`drifters`, same end-date coverage.

### Animal Migrations (GBIF)

Downloads animal-tracking occurrence datasets from GBIF and builds
migration trajectories.

```bash
stt-generate animals --output animals.stt
```

### Satellite Orbits (CelesTrak TLE + SGP4)

Downloads the current CelesTrak "active satellites" TLE set and propagates every
object with SGP4 into ground-track trajectories with per-vertex timestamps.

```bash
stt-generate satellites \
  --duration-hours 24 \
  --step-seconds 60 \
  --orbit-type all \
  --output satellites.stt
```

Those three flags are the propagation window: `--duration-hours` (default 24)
and `--step-seconds` (default 60) set the span and its resolution, and
`--orbit-type` (default `all`) narrows the set to `LEO`, `MEO` or `GEO`.

### OSM Editing History (`osm-edits`)

A time-series animation of _OpenStreetMap being edited_, scoped to one metro
(default: New York City via `--bounds`). Two complementary signals; both
sources are downloaded as a prerequisite and passed via `--input`. All output
is **© OpenStreetMap contributors (ODbL)** — keep that attribution in any
showcase config or published render.

#### Signal A — node creation ("watch the metro draw itself")

Every node's _first version_ (its creation) placed at its lon/lat at its
creation time. Played back cumulatively in the showcase (`cumulative: true`),
the street grid and buildings ink in over ~18 years.

**Step 1 — get a full-history extract.** Download a regional `.osh.pbf` for the
region containing your metro from Geofabrik's _internal_ server
(<https://osm-internal.download.geofabrik.de/>, free OSM login). Optionally
shrink it to the metro first with [osmium](https://osmcode.org/osmium-tool/):

```bash
osmium extract --with-history -b -74.27,40.49,-73.68,40.92 \
  us-northeast-internal.osh.pbf -o nyc.osh.pbf
```

**Step 2 — build.** (The reader bbox-filters too, so the pre-clip is optional.)

```bash
stt-generate osm-edits \
  --source nodes \
  --input nyc.osh.pbf \
  --bounds 40.49,-74.27,40.92,-73.68 \
  --tagged-only \
  --summary-tier \
  --output data-fleet/osm-nyc-nodes.stt
```

- `--tagged-only` keeps real features (buildings/POIs/roads) and drops untagged
  geometry vertices — ~5-10× smaller, recommended for the showcase.
- Builds zooms 8-16 with monthly (`30d`) temporal buckets (no LOD pyramid —
  the points render raw and cumulative) plus an optional H3 count summary
  tier (zooms 8-11) for the zoomed-out overview.

#### Signal B — changeset activity ("who maps, with what, when")

Every changeset near the metro as a timestamped point (bbox centroid), coloured
by editor era, with an edit-volume H3 summary tier.

**Step 1 — get the changeset dump** (public, no login; ~6 GB bz2, stream-parsed):

```bash
curl -O https://planet.openstreetmap.org/planet/changesets-latest.osm.bz2
```

**Step 2 — build:**

```bash
stt-generate osm-edits \
  --source changesets \
  --input changesets-latest.osm.bz2 \
  --bounds 40.49,-74.27,40.92,-73.68 \
  --max-bbox-deg 1.0 \
  --summary-tier \
  --output data-fleet/osm-nyc-changesets.stt
```

- `--max-bbox-deg` drops planet-spanning import/bot changesets so their centroid
  doesn't smear onto Null Island. `0` disables the filter.

The archives are large and are **kept local** — they're git-ignored and not
hosted. They land under `data-fleet/`; the matching showcase configs
(`osm-nyc-draw`, `osm-nyc-changesets-summary`, `osm-nyc-changesets-editors`)
live in the separate poopdeck.gl repository.

To target a different metro, swap `--bounds` (and pick the right region
extract for `nodes`). For example, Berlin: `--bounds 52.34,13.09,52.68,13.76`.

### Storm Radar (`storms`)

NEXRAD Level II storm-radar tiles for the **2020-08-10 Iowa derecho**.
Downloads archived Level II volumes from the public `unidata-nexrad-level2`
AWS bucket for a set of radar sites over the event window, decodes the base
reflectivity sweep of each volume, reprojects every gate to lon/lat, and
mosaics all sites onto one analysis grid per ~5-minute scan. All polar
reprojection, mosaicking, contouring, and cell tracking happen at build time;
the browser only renders finished vector geometry.

Unlike the other generators, `storms` bakes **three** packed archives under the
`--output` directory:

- `storm-field` — filled reflectivity contour bands (polygons, `dbz_band`)
- `storm-cells` — storm-cell centroids (points, `max_dbz` + `area_km2`)
- `storm-tracks` — cells linked across scans into tracks (LineStrings with
  per-vertex intensity over time, so they animate as growing/decaying trails)

```bash
stt-generate storms \
  --sites KOAX,KDMX,KDVN \
  --date 2020-08-10 \
  --start-hour 16 --end-hour 23 \
  --output data-fleet
```

### NWM River Discharge (`nwm`)

Animates hourly/daily modeled discharge from the NOAA **National Water Model**
v3.0 retrospective (`chrtout.zarr` on anonymous S3) over the NHDPlusV2 CONUS
river network as `vertex_value_matrix` flow corridors — the continental-scale
sibling of `bixi --streets`, with zero new tile-format features. Chunk fetch,
reduce, and assemble stages are all resumable via on-disk caches, so the March
hourly window reuses the year's downloaded chunks and daily medians.

```bash
# Demo 1 — full-year daily flow, each reach self-scaled to its own annual range:
stt-generate nwm --window 2019 --bin 1d --value self-scaled \
  --output data-fleet/nwm-rivers-2019

# Demo 2 — March hourly flood anomaly (reuses the 2019 daily pass for medians):
stt-generate nwm --window 2019-03 --bin 1h --value log-anomaly \
  --output data-fleet/nwm-rivers-flood-2019-03
```

## Custom Data (Using stt-build)

This page covers `stt-generate`, which rebuilds _this repo's_ bundled showcase
datasets. Building an archive from your **own** data is `stt-build`, documented
in full elsewhere — nothing here is generator-specific:

- [CSV → animated map](./csv-quickstart.md) — the shortest end-to-end path.
- [Building from Python](./python.md) — GeoPandas / DuckDB / pyarrow recipes
  for getting other formats into GeoParquet.
- [CLI reference — `stt-build`](../api/cli-reference.md#stt-build) — every flag,
  including [GeoParquet input requirements](../api/cli-reference.md#input-requirements-geoparquet),
  [database sources](../api/cli-reference.md#database-input-sources-opt-in),
  [time formats and strictness](../api/cli-reference.md#time),
  [temporal bucketing & LOD](../api/cli-reference.md#temporal-bucketing--lod),
  [the summary tier](../api/cli-reference.md#summary-tier-server-aggregated-low-zoom-tier)
  and [auto-tuning](../api/cli-reference.md#auto-tuning).
- [`stt-serve` protocol](../spec/stt-serve-protocol.md) — serving the same tiles
  per-request from PostGIS/DuckDB instead of pre-baking an archive.

## AV Scene Bundles (Python extractors)

The `/drive` cockpit scenes are **scene bundles** — multi-stream datasets
(lidar / ego / objects / tracks / HD-map / telemetry / camera sidecars) whose
format is specified in [Sidecar assets](../spec/sidecar-assets.md). They are
built by Python extractors in `scripts/data-generation/`, not by
`stt-generate`:

- `nuscenes_extract.py`, `argoverse_extract.py`, `waymo_extract.py`,
  `comma_extract.py` (plus `av_synthetic.py`) — one per source dataset. All
  share `av_common.py`, which normalizes each stream to GeoParquet, shells out
  to `stt-build` per stream, and writes the `scene.json` envelope
  (`write_scene_json`, the reference producer for
  [`scene.schema.json`](../spec/scene.schema.json)).
- `argoverse_batch.sh` / `waymo_batch.sh` build one cockpit scene per city /
  per curated segment end-to-end (download → extract → build → clean up).
- Optional modes: `--surfel` (oriented-Gaussian surfel columns),
  `--scene-split` (static "stage" + animated "actors" pair), `--colorize`
  (camera-projected RGB), `--contours` (density iso-lines).

Each source needs its own Python environment and license acceptance — nuScenes
and Argoverse 2 are CC-BY-NC-SA; the Waymo Open Dataset license forbids
redistribution, so Waymo bundles stay local. Per-source setup lives in
[`scripts/data-generation/README.md`](../../scripts/data-generation/README.md).

## Best Practices

### Memory Management

For large inputs, `stt-build --streaming` writes tiles as each zoom level
completes and streams them straight into the `PackWriter`, instead of
generating every tile up front — which trims peak RAM at the cost of some
parallelism:

```bash
stt-build -i huge-input.parquet -o out.stt \
  --time-field timestamp --time-format unix-ms \
  --streaming
```

`--streaming` is ignored when `--temporal-lod` is set (the temporal-LOD
pyramid runs through the in-memory pipeline), and `--style-hints` is skipped
under it. The summary tier, heatmap domain, and `--metadata-output` still
apply — they run over the loaded features after the raw tier is written.

## Validating Output

Run `stt-validate` after every build — pass the packed dataset directory
(or its `manifest.json`). It blake3-verifies every pack and the directory
object against their content-addressed names, content-hash-checks every
tile blob, decodes each payload, and reports schema or feature-count
anomalies:

```bash
stt-validate my-data/            # the directory stt-build wrote
stt-validate my-data/ --json     # for CI
```

`stt-generate` writes its archives under `data-fleet/`. The showcase that
renders them lives in the separate poopdeck.gl repository, where each dataset
is wired up in the showcase app's dataset config.

## Troubleshooting

### stt-build Not Found

```bash
cargo install --path crates/spatiotemporal-tiles
```

(The `stt-build` binary lives in the `spatiotemporal-tiles` facade crate;
`crates/stt-build` is the library only. If an old source install owns the
binary name, add `--force`.)

### Out of Memory

Switch to the `--streaming` pipeline (above) and raise
`--min-features-per-tile` to drop tiny deep-zoom tiles. The TS reader's
`'best-available'` refinement surfaces dropped features from their
parent tiles.

### Validation Fails

`stt-validate` exits non-zero on integrity or decode errors. Common
causes: building an older archive with a newer CLI (rebuild), or a
truncated download. Pass `--fail-fast` to stop on the first failure
when iterating on a fix.

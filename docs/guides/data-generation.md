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

For getting your own data into the GeoParquet input `stt-build` requires,
see [Building from Python](./python.md) — it covers GeoPandas, DuckDB,
and pyarrow.

## Prerequisites

1. **Install Rust:** [rustup.rs](https://rustup.rs/)
2. **Build the tools:**
   ```bash
   cargo install --path crates/stt-generate
   cargo install --path crates/stt-build
   ```

## Quick Start

### Generate the no-setup datasets (`all`)

`stt-generate all` builds **only the three datasets that need no extra
parameters**: `earthquakes`, `hurricanes`, and `wildfires`. It writes
`earthquakes.stt`, `hurricanes.stt`, and `wildfires.stt` into the output
directory (default `examples/showcase/public/data`).

```bash
# Builds earthquakes.stt, hurricanes.stt, wildfires.stt only.
stt-generate all --output-dir examples/showcase/public/data --skip-existing
```

The remaining datasets (`ais`, `flights`, `nyc-rideshare`, `bixi`,
`nyc-taxi-points`, `satellites`, `drifters`, `drifters-hourly`, `animals`,
`osm-edits`, `storms`) require per-run parameters (download dates, an OSRM
server, an existing source archive, etc.) or long downloads and are NOT
built by `all` — run them individually.

### Generate Individual Datasets

```bash
# Earthquake data from USGS → earthquakes.stt
stt-generate earthquakes --output earthquakes.stt

# Hurricane tracks from NOAA IBTrACS → hurricanes.stt
stt-generate hurricanes --output hurricanes.stt

# Wildfire perimeters from NIFC → wildfires.stt
stt-generate wildfires --output wildfires.stt

# AIS maritime traffic from NOAA Marine Cadastre → ais-traffic.stt
# (default output is ais-traffic.stt; pass --date or --input)
stt-generate ais --date 2024-01-01 --output ais-traffic.stt

# Flight traffic from OpenSky (Mondays 2017–2020) → flights.stt
stt-generate flights --date 2020-01-06 --output flights.stt

# NYC rideshare trajectories from TLC + OSRM → nyc-rideshare.stt
# (needs an OSRM server; --synthetic routes random Manhattan trips)
stt-generate nyc-rideshare --synthetic --num-trips 1000 \
  --osrm-url http://localhost:5000 --output nyc-rideshare.stt

# NYC taxi POINTS derived from an existing path archive → nyc-taxi-points.stt
# (--input defaults to examples/showcase/public/data/nyc-taxi-paths.stt)
stt-generate nyc-taxi-points \
  --input examples/showcase/public/data/nyc-taxi-paths.stt \
  --output nyc-taxi-points.stt

# Satellite orbits from CelesTrak TLE + SGP4 → satellites.stt
stt-generate satellites --output satellites.stt

# Ocean drifter trajectories from NOAA's Global Drifter Program → drifters.stt
stt-generate drifters --start 2021-01-01 --end 2022-01-01 --output drifters.stt

# Animal migration trajectories from GBIF tracking datasets → animals.stt
stt-generate animals --output animals.stt
```

## Available Datasets

### Earthquakes (USGS)

Downloads earthquake data from the USGS API.

```bash
stt-generate earthquakes \
  --start-date 2020-01-01 \
  --end-date 2024-12-31 \
  --min-magnitude 4.5 \
  --output earthquakes.stt
```

**Options:**
- `--start-date`: Start date (YYYY-MM-DD), default: 2020-01-01
- `--end-date`: End date (YYYY-MM-DD), default: 2024-12-31
- `--min-magnitude`: Minimum magnitude, default: 4.0
- `--summary-tier`: Emit a server-aggregated H3 summary tier alongside the raw tier

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

**Options:**
- `--input`: Input CSV file (or pass `--date` / `--start-date`+`--end-date` to download from NOAA directly)
- `--sample-minutes`: Temporal sampling (1 position per vessel per N minutes)
- `--bounds`: Geographic filter (min_lat,min_lon,max_lat,max_lon)
- `--max-vessels`: Limit number of vessels (0 = unlimited)

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

**Options:**
- `--date`: Date to download (YYYY-MM-DD, must be a Monday)
- `--hours`: Hours to download (e.g., "0-23" for full day)
- `--bounds`: Geographic filter
- `--sample-seconds`: Temporal sampling interval
- `--paths`: Output LineString trajectories instead of points
- `--min-points`: Path mode — drop flights with fewer points, default: 5
- `--max-gap-seconds`: Path mode — split a track at gaps longer than this, default: 300

### Hurricane Tracks (NOAA IBTrACS)

Downloads historical hurricane track data.

```bash
stt-generate hurricanes \
  --start-year 2020 \
  --end-year 2024 \
  --output hurricanes.stt
```

**Options:**
- `--start-year`: Start year, default: 2020
- `--end-year`: End year, default: 2024
- `--synthetic`: Create synthetic year from multiple years

### Wildfire Perimeters (NIFC)

Downloads wildfire perimeter polygons from NIFC.

```bash
stt-generate wildfires \
  --start-year 2020 \
  --end-year 2023 \
  --min-acres 1000 \
  --output wildfires.stt
```

**Options:**
- `--start-year`: Start year, default: 2020
- `--end-year`: End year, default: 2023
- `--min-acres`: Minimum fire size in acres, default: 1000
- `--wildfires-only`: Exclude prescribed burns (default: true)

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

**Options:**
- `--synthetic`: Generate synthetic trips
- `--num-trips`: Number of synthetic trips
- `--download`: Download TLC data for a month (YYYY-MM; pre-2017 months carry real lat/lon)
- `--paths`: Output LineString paths instead of points
- `--flows`: Output pre-aggregated corridor flows (segment counts per time bin)
- `--flow-bin`: Time bin for `--flows` aggregation, default `15m`
- `--flow-snap-meters`: `--flows` snap grid (metres) that merges nearby road nodes into fewer corridors, default `30` (0 = exact OSRM geometry, heavy)
- `--from-intermediate`: Re-build from a kept intermediate Parquet (e.g. re-bin `--flows` from a `--paths` intermediate without re-routing through OSRM)
- `--od`: Output one straight origin→destination LineString per trip (2 vertices, no OSRM needed) — feeds the `AnimatedArcLayer` / `AnimatedLineLayer` flow layers, which read the first vertex as source and the last as target. Mutually exclusive with `--paths` / `--flows`
- `--with-bearing`: Add a per-feature `bearing` numeric column (degrees, 0 = N, clockwise) — origin→destination initial azimuth in `--od` mode, heading toward the next point otherwise. Drives `AnimatedIconLayer` marker rotation
- `--osrm-url`: OSRM server URL
- `--skip-routing`: Skip OSRM routing (pickup/dropoff only)

### Montréal BIXI Flowmap (`bixi`)

Aggregates real [BIXI open-data](https://bixi.com/en/open-data/) bike-share
trips into directed **origin→destination station-pair flows**, each emitted as a
single 2-vertex `origin → destination` arc carrying a per-time-bucket count time
series. The size on the wire is bounded by *(kept pairs) × (buckets)*, not the
~13M raw trips/year, so a long span fits comfortably. The input CSV schema is
auto-detected (the 2022+ embedded-coordinate family and the 2014–2021 station-code
family).

```bash
stt-generate bixi \
  --input data/bixi-2024.zip \
  --from 2024-06-01 --to 2024-09-01 \
  --bin 1h \
  --output examples/showcase/public/data/bixi-flowmap.stt
```

**Options:**
- `--input`: BIXI open-data input (required) — the downloaded `.zip`, an extracted `.csv`, or a directory of either (plus an optional `Stations_*.csv` for pre-2022 code-based files)
- `--bin`: Time bucket for the flow matrix, default `1h` (e.g. `30m`, `3h`, `1d`)
- `--from` / `--to`: Inclusive lower / exclusive upper date bound `YYYY-MM-DD` (UTC), default: unbounded
- `--min-trips`: Drop OD pairs with fewer than this many total trips across the span (legibility threshold, not temporal thinning — kept pairs keep every bucket), default: 30
- `--min-zoom` / `--max-zoom`: Build pyramid zoom range, default 10–13
- `--cluster-radius`: Cluster merge radius in screen pixels at tile extent 512 (larger = coarser hubs), default 40. Build-time per-zoom station clustering is **on by default** (flowmap.gl-style)
- `--no-cluster`: Disable clustering and fall back to a volume-based LOD (minor pairs dropped at low zoom)
- `--bake-bundling`: Bake KDEEB edge bundling into the tile geometry (smooth multi-vertex "rivers" rendered with `BundledFlowmapLayer({ preBundled: true })`); requires clustering. Tuned with `--bundle-points` (default 24), `--bundle-kernel` (0.05), `--bundle-iterations` (15), `--bundle-smoothing` (0.5)
- `--streets`: Route OD pairs onto the Montréal OSM **bicycle** network instead of straight arcs (per-segment street corridors, the BIXI counterpart of `nyc-rideshare --flows`). Requires `--osm-pbf <file.osm.pbf>` and a bicycle-profile `--osrm-url` (default `http://localhost:5001`). Incompatible with `--bake-bundling`/`--no-cluster`/`--cluster-radius`
- `--skip-build`: Write only the intermediate GeoParquet (no stt-build)

### NYC Taxi Points (`nyc-taxi-points`)

Derives a Point dataset from an already-built `nyc-taxi-paths` LineString
archive by interpolating each trip's polyline at a fixed time interval — no
OSRM re-run, the routed geometries baked into the `.stt` are reused as-is.

```bash
stt-generate nyc-taxi-points \
  --input examples/showcase/public/data/nyc-taxi-paths.stt \
  --interval-seconds 15 \
  --output nyc-taxi-points.stt
```

**Options:**
- `--input`: Source LineString `.stt` archive, default `examples/showcase/public/data/nyc-taxi-paths.stt`
- `--interval-seconds`: Time spacing between interpolated points (smaller = smoother animation, larger output), default: 15
- `--max-trips`: Cap on trips processed (for quick iteration), default: all
- `--temporal-bucket`: Output archive tile bucket, default `30m`
- `--min-zoom` / `--max-zoom`: Output archive zoom range, default 10–16
- `--skip-build`: Emit the intermediate Parquet only
- `--keep-intermediate`: Keep the intermediate Parquet after build

### Ocean Drifters (NOAA Global Drifter Program)

Downloads 6-hourly drifting-buoy trajectories (positions + sea-surface
temperature as per-vertex values).

```bash
stt-generate drifters \
  --start 2021-01-01 --end 2022-01-01 \
  --output drifters.stt
```

**Options:**
- `--start` / `--end`: Time window (YYYY-MM-DD), default 2021-01-01 → 2022-01-01
- `--bounds`: Geographic filter (min_lat,min_lon,max_lat,max_lon)
- `--min-points`: Drop trajectories shorter than this, default: 4
- `--max-gap-hours`: Split a trajectory at gaps longer than this, default: 120
- `--max-zoom`: Max tile zoom, default: 6 (the globe demo only loads z0 — keep low for multi-decade pulls)
- `--temporal-bucket`: Tile bucket size, default: `1d` (coarsen for long spans)
- `--cache-dir`: Download cache, default: `data/gdp-cache`

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

**Options:**
- `--licenses`: Comma-separated license allowlist, default: `CC0_1_0,CC_BY_4_0,CC_BY_NC_4_0`
- `--max-datasets`: Limit number of GBIF datasets (0 = unlimited)
- `--ref-year`: Reference year every track is season-folded onto, default: 2024
- `--min-points`: Drop trajectories shorter than this, default: 5
- `--max-gap-days`: Split a trajectory at gaps longer than this, default: 21
- `--cache-dir`: Download cache, default: `data/gbif-cache`

### OSM Editing History (`osm-edits`)

A time-series animation of *OpenStreetMap being edited*, scoped to one metro
(default: New York City via `--bounds`). Two complementary signals; both
sources are downloaded as a prerequisite and passed via `--input`. All output
is **© OpenStreetMap contributors (ODbL)** — keep that attribution in any
showcase config or published render.

#### Signal A — node creation ("watch the metro draw itself")

Every node's *first version* (its creation) placed at its lon/lat at its
creation time. Played back cumulatively in the showcase (`cumulative: true`),
the street grid and buildings ink in over ~18 years.

**Step 1 — get a full-history extract.** Download a regional `.osh.pbf` for the
region containing your metro from Geofabrik's *internal* server
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
  --output examples/showcase/public/data/osm-nyc-nodes.stt
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
  --output examples/showcase/public/data/osm-nyc-changesets.stt
```

- `--max-bbox-deg` drops planet-spanning import/bot changesets so their centroid
  doesn't smear onto Null Island. `0` disables the filter.

**Options (both sources):**
- `--source`: `nodes` or `changesets` (default `nodes`)
- `--input`: source file (required)
- `--bounds`: metro bbox `min_lat,min_lon,max_lat,max_lon` (default NYC)
- `--start-date` / `--end-date`: clip the time range (YYYY-MM-DD)
- `--summary-tier`: emit the server-aggregated H3 tier
- `--tagged-only` (nodes): drop untagged geometry vertices
- `--max-bbox-deg` (changesets): giant-bbox filter degrees (default 1.0)

The archives are large and are **kept local** — they're git-ignored and not
hosted. The matching showcase configs (`osm-nyc-draw`,
`osm-nyc-changesets-summary`, `osm-nyc-changesets-editors` in
`examples/showcase/src/datasets.ts`) expect them under
`examples/showcase/public/data/`.

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
  --output examples/showcase/public/data
```

**Options:**
- `--sites`: Radar sites (WSR-88D ICAO ids) along the derecho path, west→east, default `KOAX,KDMX,KDVN`
- `--date`: UTC date of the event, default `2020-08-10`
- `--start-hour` / `--end-hour`: Inclusive start / exclusive end hour (UTC), default 16–23
- `--scan-stride`: Keep only every Nth volume per site (1 = every scan), default: 2
- `--dbz-thresholds`: Ascending dBZ thresholds for the filled contour bands, default `20,25,…,65`
- `--cell-dbz`: Storm-cell detection floor in dBZ, default: 50
- `--min-cell-km2`: Drop storm cells smaller than this (km², removes speckle), default: 12
- `--min-band-km2`: Drop contour-band polygons smaller than this (km²), default: 9
- `--grid-km`: Analysis-grid spacing in km, default: 2.0
- `--bounds`: Analysis bbox `min_lat,min_lon,max_lat,max_lon`, default = derecho corridor
- `--max-cell-speed`: Max track-association speed (m/s) for nearest-centroid matching, default: 45
- `--min-zoom` / `--max-zoom`: Build pyramid zoom range, default 4–9
- `--cache-dir`: Cache directory for downloaded V06 volumes, default `radar-data`
- `--no-download`: Use cached downloaded volumes only; never hit S3
- `--skip-build`: Write only the intermediate parquet for each archive

## Custom Data (Using stt-build)

`stt-build` accepts **GeoParquet only** (`.parquet` / `.geoparquet`). For
other formats, convert first — see [Building from Python](./python.md) for
GeoPandas / DuckDB / pyarrow recipes, or use `ogr2ogr -f Parquet
out.parquet in.geojson`.

Two input constraints are enforced from the GeoParquet `geo` footer:

- **Coordinates must be lon/lat degrees** (`OGC:CRS84` / `EPSG:4326`).
  Any other declared CRS — e.g. an export in Web Mercator — fails the
  build with a reproject hint (`gdf.to_crs(4326).to_parquet(...)`).
- **Line/polygon geometry must be WKB-encoded.** The native geoarrow
  `linestring`/`polygon`/`multi*` encodings fail with a re-export hint
  (`gdf.to_parquet(..., geometry_encoding='WKB')`). WKB is the GeoPandas
  default, so most exports just work.

### From GeoParquet

```bash
stt-build \
  --input my-custom-data.parquet \
  --output my-custom-data.stt \
  --time-field timestamp \
  --time-format unix-ms \
  --auto
```

`--auto` runs `stt-optimize` over the input and fills in zoom range and
temporal bucket based on the data's spatial density and temporal
distribution. Any flag you pass explicitly still wins. (Compression is
not auto-tuned — the packed format is zstd-only.)

### Adding a temporal LOD pyramid

For multi-year datasets you'd otherwise animate at hour-scale, build a
coarser-bucket pyramid so the reader can pick a tier per zoom:

```bash
stt-build -i quakes.parquet -o quakes.stt \
  --time-field time --time-format unix-ms \
  --temporal-bucket 1h \
  --temporal-lod 1d@8,30d@4
```

Each LOD entry must be a strict multiple of `--temporal-bucket`; the
`@N` suffix clamps the level to zooms ≤ N.

### Adding an H3 summary tier

For 100M+ point datasets, server-aggregate the low zooms so the raw tier
doesn't ship hundreds of millions of points per frame:

```bash
stt-build -i quakes.parquet -o quakes.stt \
  --time-field time --time-format unix-ms \
  --summary-tier h3 \
  --summary-min-zoom 0 --summary-max-zoom 4 \
  --summary-columns magnitude:mean,magnitude:max
```

The summary tier runs in the in-memory pipeline only — combining it with
`--streaming-arrow` is an error (see Memory Management below).

### Time Format Options

`--time-format` is a closed vocabulary (a typo is a clap error):

- `iso8601` (default): e.g., `2024-01-15T12:30:00Z`
- `unix-ms`: milliseconds since epoch
- `unix-sec`: seconds since epoch

The flag is only consulted for integer (Int64) time columns — Arrow
Timestamp columns are self-describing and String columns are always
parsed as ISO 8601. An Int64 column under the default `iso8601` logs a
warning and is interpreted as unix-ms; pass `unix-ms`/`unix-sec` to make
the intent explicit.

Pass `--strict-times` to fail the build on any null or unparseable
timestamp instead of coercing it to epoch with a warning. Pre-1970
(negative) timestamps always fail the build in both modes — the temporal
index stores unsigned ms-since-epoch and cannot represent them.

### Bad geometry

Rows with null or unparseable geometry are **skipped** with a count
warning (they have no position to tile at — they are never placed at
(0,0)). Pass `--strict-geometry` to fail the build on the first such row
instead.

## Best Practices

### 1. Choose Appropriate Zoom Levels

- **Global datasets** (earthquakes, hurricanes): `--min-zoom 0 --max-zoom 10`
- **Regional datasets** (AIS, flights): `--min-zoom 0 --max-zoom 12`
- **City-level datasets** (taxis, rideshare): `--min-zoom 10 --max-zoom 16`

### 2. Use Temporal Sampling for Dense Data

For high-frequency data (GPS tracks, vessel positions):
```bash
stt-generate ais --sample-minutes 10  # 1 position per vessel per 10 min
stt-generate flights --sample-seconds 60  # 1 position per aircraft per minute
```

### 3. Memory Management

For multi-GB inputs, switch `stt-build` to its Arrow-native streaming
pipeline so peak RSS stays bounded by one Parquet batch plus the active
spill budget:

```bash
stt-build -i huge-input.parquet -o out.stt \
  --time-field timestamp --time-format unix-ms \
  --streaming-arrow
```

The standard `--streaming` flag is an older path that writes tiles per
zoom level — fine for medium inputs but holds the per-zoom feature set
in RAM (and is ignored when `--temporal-lod` is set). `--streaming-arrow`
is the right answer for >10 GB inputs.

`--streaming-arrow` has restrictions: it **errors** when combined with
`--summary-tier`, `--heatmap-weight`, `--heatmap-class`, or
`--metadata-output` (those passes run after the in-memory pipeline's
finalize), ignores `--temporal-lod` with a warning, and is
single-threaded (`--workers` is ignored). Use the in-memory pipeline for
those features.

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

Then try the dataset in the showcase:

```bash
cp -R my-data examples/showcase/public/data/
# Update examples/showcase/src/datasets.ts with your dataset config
cd examples/showcase && pnpm dev
```

## Troubleshooting

### stt-build Not Found

```bash
cargo install --path crates/stt-build
```

### Out of Memory

Switch to the streaming Arrow pipeline (above) and raise
`--min-features-per-tile` to drop tiny deep-zoom tiles. The TS reader's
`'best-available'` refinement surfaces dropped features from their
parent tiles.

### Validation Fails

`stt-validate` exits non-zero on integrity or decode errors. Common
causes: building an older archive with a newer CLI (rebuild), or a
truncated download. Pass `--fail-fast` to stop on the first failure
when iterating on a fix.

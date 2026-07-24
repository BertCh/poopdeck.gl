---
name: generating-stt-datasets
description: >-
  Download and build one of the bundled REFERENCE / showcase SpatioTemporal Tiles
  datasets (earthquakes, hurricanes, wildfires, drifters, flights, AIS, GTFS transit,
  NWM rivers, satellites, animal migration, OSM edits, NEXRAD storms, BIXI/NYC trips)
  with stt-generate. Use when a user wants example/demo data, "generate the showcase
  datasets", a specific public dataset by name, or something to test the renderer with —
  NOT for turning a user's OWN data into a .stt (that's building-stt-datasets / stt-build).
license: MIT
metadata:
  version: '0.5.0'
---

# Generating reference STT datasets

`stt-generate` downloads a public data source, processes it, and builds a packed
`.stt` — one subcommand per bundled dataset, each with sensible defaults. This is
for the **curated reference datasets**. For a user's own GeoParquet/PostGIS/DuckDB,
use the **building-stt-datasets** skill (`stt-build`) instead.

> **Doc paths** are repo-relative. With no repo on disk, use the MCP
> `get_doc`/`search_docs` tools (or the `stt://docs/<path>` resource), or fetch
> `https://poopdeck.gl/llms/<path>` — full chain in **poopdeck-overview**.
> Everything load-bearing below is inlined.

## How to run it

- **In an MCP session:** call the `generate_dataset` tool (from the `stt` server)
  with `dataset` (the subcommand), an optional `output` path, and any
  source-specific flags via `extraArgs`. It shells out to `stt-generate`, so it
  needs the server started with `--allow-cli`, which is **off by default** —
  including in the bundled plugin (see `poopdeck-ai/README.md`).
- **From a shell:** `stt-generate <dataset> --output <name>.stt [flags]`.

Generation is **network-bound and can be slow** (it downloads source data); the
MCP tool defaults to a 15-minute timeout (`timeoutMs` to change).

**One dataset per invocation.** There is no `all` fan-out subcommand — loop over
the no-parameter ones yourself if you want a batch:

```
for d in earthquakes hurricanes wildfires; do
  stt-generate "$d" --output "examples/showcase/public/data/$d.stt"
done
```

## The catalog

| dataset           | source                      | notes / key flags                                                        |
| ----------------- | --------------------------- | ------------------------------------------------------------------------ |
| `earthquakes`     | USGS                        | no params                                                                |
| `hurricanes`      | NOAA IBTrACS                | no params                                                                |
| `wildfires`       | NIFC perimeters             | no params                                                                |
| `ais`             | NOAA Marine Cadastre        | `--date YYYY-MM-DD` (or `--input`)                                       |
| `flights`         | OpenSky Network             | `--date` — **Mondays 2017–2020 only**                                    |
| `nyc-rideshare`   | NYC TLC + OSRM              | `--synthetic` (no server) or `--download YYYY-MM` (needs an OSRM server) |
| `nyc-taxi-points` | derived                     | `--input` an existing path `.stt`                                        |
| `bixi`            | Montreal open data          | origin→destination flowmap                                               |
| `gtfs`            | a static GTFS feed          | one service date (transit "ballet")                                      |
| `nwm`             | NOAA NWM on NHDPlus         | river-discharge corridors, CONUS                                         |
| `satellites`      | CelesTrak TLE (SGP4)        | orbit propagation                                                        |
| `drifters`        | NOAA Global Drifter Program | `--start`/`--end` YYYY-MM-DD                                             |
| `drifters-hourly` | GDP hourly QC               | **experimental**                                                         |
| `animals`         | GBIF tracking               | migration trajectories                                                   |
| `osm-edits`       | OSM history                 | node creations / changesets                                              |
| `storms`          | NEXRAD                      | fixed event: 2020-08-10 Iowa derecho                                     |

Run `stt-generate <dataset> --help` for the exact flag set — forward those flags
through the MCP tool's `extraArgs` (e.g. `["--date","2024-01-01"]`,
`["--synthetic","--num-trips","1000"]`).

## Examples

```
# Three no-param datasets into the showcase data dir
generate_dataset  dataset=all  output=examples/showcase/public/data  extraArgs=["--skip-existing"]

# A dated AIS slice
generate_dataset  dataset=ais  output=ais-traffic.stt  extraArgs=["--date","2024-01-01"]

# Synthetic NYC rideshare (no OSRM server needed)
generate_dataset  dataset=nyc-rideshare  output=nyc-rideshare.stt  extraArgs=["--synthetic","--num-trips","1000"]
```

## Verify

`stt-generate` already emits a publish-quality packed archive (it builds with the
`--publish` encoding). Confirm it before wiring a demo:

- `validate_dataset` (MCP) / `stt-validate out.stt --json` — integrity + decode.
- `describe_dataset` (MCP) — time range, bounds, capabilities, summary tier.

If a render comes up blank, see the **debugging-blank-renders** skill. To shrink
or re-tune the result for deploy, see **tuning-stt-tiles**.

Guides: `docs/guides/data-generation.md` (per-dataset detail),
`docs/api/cli-reference.md` (`stt-generate` reference).

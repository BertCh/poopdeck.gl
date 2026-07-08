---
name: building-stt-datasets
description: >-
  Build a packed SpatioTemporal Tiles (.stt) archive from GeoParquet, PostGIS, or
  DuckDB with stt-build. Use when a user wants to turn spatiotemporal data (points,
  tracks, trips, polygons, events with timestamps) into a time-aware tile archive,
  asks about stt-build flags, temporal bucketing, zoom ranges, summary tiers, or
  "how do I convert my parquet/CSV/database into a .stt". Recommends running
  recommend_build (or stt-optimize recommend) FIRST to get an evidence-backed recipe.
license: MIT
metadata:
  version: "0.4.0"
---

# Building an STT dataset

Goal: source data → a packed `.stt` archive (`manifest.json` + `index/` + `packs/`).

> **Reading the doc paths below.** Citations like `docs/api/cli-reference.md` are
> repo-relative (`<path>` = the part after `docs/`). No repo on disk? Use the MCP
> `get_doc`/`search_docs` tools (or the `stt://docs/<path>` resource), or fetch
> `https://poopdeck.gl/llms/<path>` — the full fallback chain is in
> **poopdeck-overview**. The canonical flags and rules here are inlined, so this
> skill is correct even with no doc reachable.

## Step 1 — Get a recipe before hand-writing flags

`stt-build` has a large flag surface; the right zoom range, temporal bucket, and
encoding levers depend on the data's density and time distribution. **Do not guess.**

- **In an MCP session:** call the `recommend_build` tool (from the `stt` server)
  with the source GeoParquet path. It runs `stt-optimize analyze` + `recommend
  --explain` and returns a suggested `stt-build` command plus an evidence table
  (with confidence and any LOSSY markers).
- **From a shell:** `stt-optimize recommend -i data.parquet --command --explain`.

Read the rationale, then run the suggested command. Only deviate with a reason.

## Step 2 — Run stt-build

Minimal build (canonical flags — see `docs/api/cli-reference.md` for the full set):

```
stt-build -i input.parquet -o out \
  -t timestamp \                 # --time-field: the timestamp column
  --temporal-bucket 1h \         # byte-level time binning granularity
  --min-zoom 0 --max-zoom 14
```

Key decisions:

- **`-t/--time-field`** (+ `--end-time-field`, `--time-format iso8601|unix-ms|unix-sec`)
  — the time axis is first-class; get this right first.
- **`--temporal-bucket`** (`30m`, `1h`, `6h`, `1d`) — coarser buckets = smaller,
  chunkier playback; finer = smoother, larger. Add **`--temporal-lod "1d,30d"`**
  to keep coarse zooms cheap without dropping the fine tier.
- **Zoom range** — clamp `--min-zoom`/`--max-zoom` (default `0`/`14`) to what
  you'll actually view. **This is how you control size — NOT by dropping features.**
- **`--summary-tier h3|quadbin`** (+ `--summary-columns "magnitude:mean,depth:sum"`)
  — opt-in pre-aggregated coarse-zoom tier for density/choropleth at low zoom.
  Independent of the raw tier; the raw features are still there at high zoom.
- **`--style-hints`** — bake per-property percentiles/cardinality into the
  manifest. **Recommend always passing this** — it's what `describe_dataset`,
  `view_map` layer inference, and client color-domain auto-tuning read.
- **`--publish`** — deploy build (bumps zstd to level 19). Use for the final
  artifact, not iteration.
- **`--auto`** / **`--auto encode`** — hands-off tuning: runs the analyzer inline
  and applies non-lossy byte levers. Good default when you don't want to think.

## Step 3 — Build from a live database

Same tool, DB input (feature-gated builds):

```
stt-build --postgres "$PG_URI" --table trips --geom-column geom \
  --source-srid 4326 -t ts -o out --style-hints
```

`--duckdb <path>` and `--sql "<query>"` work the same way. stt-serve shares these
flags for offline/online parity.

## Step 4 — Verify

Always validate the result (see the **debugging-blank-renders** skill for the
failure modes): `stt-validate out --json`, or the `validate_dataset` MCP tool.
Then `describe_dataset` to confirm the time range, bounds, capabilities, and
summary tier are what you expect.

## Fragile levers — copy the recipe, don't improvise

The lossy encoding flags (`--quantize-coords <m>`, `--quantize-attr NAME=PREC`,
`--pre-tessellate`, `--vertex-time-precision`) change bytes on disk and can drop
precision. Prefer the exact values from `recommend_build`/`stt-optimize recommend`
(they're evidence-derived) over hand-tuning. See **tuning-stt-tiles** for the
post-build optimize loop.

Guides: `docs/guides/csv-quickstart.md`, `docs/guides/data-generation.md`,
`docs/api/cli-reference.md`.

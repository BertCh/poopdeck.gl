---
name: poopdeck-overview
description: >-
  Orienting map for working with poopdeck.gl / SpatioTemporal Tiles (STT) — the
  time-aware vector-tile toolkit. Use when a user mentions poopdeck.gl, stt-build,
  stt-optimize, stt-serve, a .stt / .sttb / packed archive, SpatioTemporalLayer,
  or asks "how do I turn my spatiotemporal data into an animated map." Explains
  the pieces and, critically, which CLI, package, MCP tool, or sibling skill to
  reach for.
license: MIT
metadata:
  version: '0.5.0'
---

# poopdeck.gl / SpatioTemporal Tiles — orientation & routing

STT turns large spatiotemporal datasets (points, paths, polygons, trips, flows)
into **packed, time-aware vector-tile archives** (`.stt`) that stream and animate
in a browser. This skill is the router: it tells you which part of the toolkit
does what, and points you at the focused skill for each job.

## How to read the docs referenced here (the fallback chain)

Every poopdeck skill cites repo-relative doc paths like `docs/api/cli-reference.md`.
Let `<path>` be the part after `docs/` (e.g. `api/cli-reference.md`). To read a
referenced doc, resolve **in this order** — this is the convention the sibling
skills point back to:

1. **Repo checkout** — open `docs/<path>` on disk.
2. **MCP** — call the `get_doc` tool with `<path>` (or `search_docs` to locate it),
   or read the `stt://docs/<path>` resource.
3. **Web** — fetch `https://poopdeck.gl/llms/<path>` (e.g.
   `https://poopdeck.gl/llms/api/cli-reference.md`). Whole corpus in one file:
   `https://poopdeck.gl/llms-full.txt`.

The load-bearing, must-not-guess facts are **inlined** in each skill body, so the
skill stays correct even with **no** doc reachable; the links are for depth only.

## The mental model (the pipeline)

```
GeoParquet / PostGIS / DuckDB
        │  stt-build            → packed .stt archive (manifest.json + index/ + packs/)
        │  stt-optimize         → analyze/tune/lint/diff the archive
        │  stt-serve            → dynamic tile server (or publish the static dir to R2)
        ▼
  @poopdeck.gl/layers  SpatioTemporalLayer (deck.gl)   ← the renderer
  @poopdeck.gl/{three,maplibre,cesium}                  ← alternate backends
  @poopdeck.gl/playback + /react                        ← scrub / play UI
```

## The two surfaces

- **The `stt-*` Rust CLIs are the workhorses** (think `wrangler`): `stt-build`
  (ingest → `.stt`), `stt-optimize` (analyze/recommend/inspect/doctor/diff/
  order-audit), `stt-serve` (dynamic tiles),
  `stt-validate` (integrity/decode/schema/temporal), `stt-bundle` (`.sttb`),
  `stt-generate` (reference datasets). Canonical flags:
  `docs/api/cli-reference.md`.
- **The `stt` MCP server** (this plugin's `@poopdeck.gl/mcp`) is the live agent
  surface over those CLIs + the packed archives. Prefer its tools when you have
  a running MCP session — they return structured JSON you can reason over:
  - `list_datasets` / `describe_dataset` — discover + inspect archives (manifest
    only; cheap).
  - `recommend_build` — analyze a **source** GeoParquet and get a suggested
    `stt-build` command with rationale. **Call this before writing a build by hand.**
  - `dataset_report` — `stt-optimize inspect`+`doctor`(+`order-audit`) verdicts on
    a **built** archive.
  - `diff_datasets` — before/after regression gate.
  - `view_map` — compose a `@deck.gl/json` spec (STT layers) for one or more datasets.
  - `build_dataset` / `validate_dataset` / `generate_dataset` (bundled reference
    datasets) — registered **only** when the server runs with `--allow-cli`,
    which is **off by default and not enabled by this plugin** (the user opts in
    by adding the flag; see `poopdeck-ai/README.md`). Those three plus
    `dataset_report` / `recommend_build` / `diff_datasets` (which always
    register, then self-gate) are the six tools that shell out to the `stt-*`
    binaries; `generate_dataset` is the only one that touches the network. With
    the flag off, reach for the CLIs directly instead.

## Which skill / tool for which job

| You want to…                                                         | Go to                                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Install the tools** / scaffold a project from scratch              | skill **installing-poopdeck** → `cargo install spatiotemporal-tiles`, `@poopdeck.gl/*` + deck.gl peers |
| Turn **your own** source data into a `.stt`                          | skill **building-stt-datasets** → `recommend_build` then `stt-build`                                   |
| Get a **bundled / example** dataset (earthquakes, drifters, GTFS, …) | skill **generating-stt-datasets** → `generate_dataset`                                                 |
| Make an archive smaller / publish-ready / lint it                    | skill **tuning-stt-tiles** → `dataset_report`, `diff_datasets`                                         |
| Choose a renderer backend (deck / maplibre / three / cesium)         | skill **choosing-a-renderer** → `docs/spec/backend-capabilities.md`                                    |
| Put a layer on a map / pick the right layer                          | skill **wiring-deckgl-layers** → `view_map`                                                            |
| Add play / pause / scrub / a timeline                                | skill **adding-playback** → `SttPlayer`, `usePlayback`                                                 |
| Serve or publish tiles (static CDN or `stt-serve`)                   | skill **serving-and-publishing** → `scripts/r2-sync.sh`, `stt-serve`                                   |
| A map renders blank / empty                                          | skill **debugging-blank-renders** → `validate_dataset`                                                 |

## Ground rules that shape every recommendation

- **Never thin or aggregate data just to hit a byte budget.** STT's philosophy is
  comprehensive data; clamp the **zoom range** and use **temporal bucketing**
  instead. Summary (H3/Quadbin) and raster tiers are _opt-in_ coarse-zoom aids,
  not a substitute for the raw tier. (See tuning-stt-tiles.)
- **The archive is the contract.** `manifest.json` carries capabilities, the
  temporal block, and (if built with `--style-hints`) per-property percentiles.
  Read it (`describe_dataset`) before guessing.
- deck.gl is pinned to the `9.3.x` line across the repo.

Key docs: `docs/intro/concepts.md`, `docs/intro/choosing.md`,
`docs/architecture/system-overview.md`, `docs/api/cli-reference.md`,
`docs/spec/stt-packed-format.md`.

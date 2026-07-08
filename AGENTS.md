# AGENTS.md

Orientation for any AI coding agent (Claude Code, Codex, Cursor, Gemini CLI, …)
dropped into this checkout. `AGENTS.md` is the cross-harness convention that
Cursor, Codex, and Gemini CLI read automatically; Claude Code users additionally
get the `poopdeck-ai` plugin (see [How agents get help](#how-agents-get-help)).
Read this first, then follow the routing table to the canonical docs.

## What this repo is

**poopdeck.gl / SpatioTemporal Tiles (STT)** is a toolkit for **time-aware
vector tiles**. A dataset is a tiny `manifest.json` plus many immutable,
content-addressed **pack** objects (`.stt` archive) that combine a spatial tile
pyramid with a temporal axis — each tile is addressed by `(zoom, x, y,
time-bucket)`. Rust CLIs (`stt-build`, `stt-optimize`, `stt-serve`,
`stt-validate`, `stt-bundle`, `stt-generate`) build / analyze / serve those
archives; TypeScript packages (`@poopdeck.gl/*`) read and render them into
deck.gl (plus Three.js/WebGPU, MapLibre, and Cesium backends), with a playback
clock for animation. A showcase site (`examples/showcase`) carries dozens of
real-dataset demos. Scope is **vector** spatiotemporal data (points, paths,
polygons, trips, flows, events); time-varying rasters/datacubes are out of scope.

## Mental model (the pipeline)

```
GeoParquet / PostGIS / DuckDB
        │  stt-build      → packed .stt archive (manifest.json + index/*.sttd + packs/*.sttp)
        │  stt-optimize   → analyze / recommend / inspect / doctor / diff / lint the archive
        │  stt-serve      → dynamic per-request tile server (or publish the static dir to R2/CDN)
        ▼
  @poopdeck.gl/core       → STTArchive reader (HTTP Range) + decoder pool + tileset + render kernel
  @poopdeck.gl/layers     → SpatioTemporalLayer (deck.gl)   ← the primary renderer
  @poopdeck.gl/{three,maplibre,cesium}                       ← alternate backends
  @poopdeck.gl/playback + /react                             ← scrub / play clock + UI
```

A cold client load is 1 `manifest.json` + 1 directory object + N pack Range
requests; warm is served entirely from edge cache. Tile payloads are Apache
Arrow IPC with GeoArrow-encoded geometry.

## Ground rules (read before recommending anything)

- **NO THINNING.** Never thin, sample, or aggregate data just to hit a byte
  budget — STT's whole philosophy is comprehensive data. To manage size, **clamp
  the zoom range** (keep `--max-zoom` honest) and use **temporal bucketing**
  (`--temporal-bucket`). The **summary** (H3/Quadbin) and **raster** tiers are
  *opt-in coarse-zoom aids* for very large datasets, **not** a substitute for the
  raw tier.
- **The archive/manifest is the contract.** `manifest.json` carries capabilities,
  the temporal block, the pack table, and (if built with `--style-hints`)
  per-property percentiles. Read it before guessing (`describe_dataset`, or open
  the file).
- **deck.gl is pinned to the `9.3.x` line** across the repo. Do not bump it.
- Packs and the directory are **immutable and content-addressed** (blake3 =
  filename); only the small `manifest.json` is mutable. Never rewrite a pack in
  place.

## Routing table — "to do X, look here"

| You want to… | Tool / package | Canonical docs |
|---|---|---|
| Turn **your own** GeoParquet / PostGIS / DuckDB into a `.stt` | `stt-build` (`--auto` to infer knobs) | `docs/guides/csv-quickstart.md`, `docs/api/cli-reference.md` |
| Get build knobs recommended from a source file | `stt-optimize` (powers `stt-build --auto`) | `docs/api/cli-reference.md`, `docs/guides/tuning-tiles.md` |
| Shrink / lint / diff / audit a **built** archive | `stt-optimize inspect`/`doctor`/`diff`/`order-audit` | `docs/guides/tuning-tiles.md` |
| Serve tiles dynamically off a live DB | `stt-serve` (PostGIS/DuckDB, axum) | `docs/api/cli-reference.md`, `docs/spec/stt-serve-protocol.md` |
| Publish a static archive to a CDN/R2 | sync the dir tree; `scripts/r2-sync.sh` sets cache headers | `docs/guides/deploying.md` |
| Check integrity / decode / schema / temporal consistency | `stt-validate` (CI-suitable) | `docs/api/cli-reference.md` |
| Pack/unpack a single-file `.sttb` interchange bundle | `stt-bundle` | `docs/api/cli-reference.md` |
| Generate a **bundled reference** dataset (earthquakes, drifters, GTFS, …) | `stt-generate` | `docs/guides/data-generation.md` |
| Read an archive in TS (Range fetch + decode + cache) | `@poopdeck.gl/core` (`STTArchive`, tileset) | `docs/api/stt-loader.md`, `docs/api/spatiotemporal-tileset.md` |
| Render on a deck.gl map / pick a layer | `@poopdeck.gl/layers` (`SpatioTemporalLayer`, `Animated*Layer`) | `docs/api/spatiotemporal-layer.md`, `docs/architecture/deckgl-integration.md` |
| Render on Three.js (WebGPU) / MapLibre / Cesium | `@poopdeck.gl/{three,maplibre,cesium}` | `docs/api/stt-three.md`, `docs/api/stt-maplibre.md`, `docs/api/stt-cesium.md` |
| Add a shader extension (TimeFilter, DataFilter, CategoryColor, …) | `@poopdeck.gl/layers` extensions | `docs/api/extensions.md` |
| Wire the play/scrub clock + React UI | `@poopdeck.gl/playback` + `@poopdeck.gl/react` | `docs/api/stt-player.md`, `docs/api/stt-react.md` |

The `stt-*` CLIs are the workhorses (think `wrangler`); their canonical flag
surface is **`docs/api/cli-reference.md`**. This table intentionally mirrors the
routing in `poopdeck-ai/skills/poopdeck-overview/SKILL.md` and `llms.txt` — keep
them consistent.

## Where the code lives

```
crates/                 # Rust workspace (5 crates)
  stt-core/             # archive + Arrow tile format library (every CLI links it)
  stt-build/            # GeoParquet / PostGIS / DuckDB → packed .stt (library)
  stt-optimize/         # input analysis + archive inspect/doctor/diff (powers --auto)
  stt-generate/         # bundled showcase-dataset generators
  spatiotemporal-tiles/ # umbrella crate: re-exports the libs + ships every CLI
    src/bin/            #   stt-build, stt-optimize, stt-validate, stt-bundle, stt-serve
packages/               # TypeScript (@poopdeck.gl/*)
  core/                 # STTArchive reader, decoder pool, OPFS cache, render kernel
  layers/               # deck.gl backend (primary)
  three/ maplibre/ cesium/   # alternate renderer backends
  playback/ react/      # clock + governor + React UI
examples/showcase/      # interactive demo app (deck.gl + MapLibre + Three)
docs/                   # spec, API reference, guides, architecture
poopdeck-ai/            # Claude Code plugin (MCP server + Agent Skills)
```

## Where the docs live — key entry points

- `docs/intro/concepts.md` — the space×time tile model, packed archives, playback.
- `docs/intro/choosing.md` — static vs served; which renderer.
- `docs/architecture/system-overview.md` — how the pieces fit end to end.
- `docs/api/cli-reference.md` — canonical flags for every `stt-*` CLI.
- `docs/spec/stt-packed-format.md` — the on-disk format (manifest + packs +
  directory v5; machine-checkable schema: `docs/spec/manifest.schema.json`).
- `docs/architecture/data-format.md` — the per-tile Arrow layer-frame encoding.
- `docs/guides/` — task guides (`csv-quickstart`, `tuning-tiles`, `deploying`,
  `python`, `data-generation`, `ai-suite`).

## Build / test basics

TypeScript is a **pnpm** workspace; Rust is a **cargo** workspace. Infer exact
flags from `package.json` / `Cargo.toml`; the verified commands are:

```bash
# Rust
cargo build --release          # CLI binaries → target/release/{stt-build,stt-optimize,...}
cargo test --workspace

# TypeScript
pnpm install
pnpm --filter @poopdeck.gl/core build
pnpm --filter @poopdeck.gl/core test        # reader tests against a real archive
pnpm --filter @poopdeck.gl/layers build

# Showcase (runs locally)
pnpm --filter @poopdeck.gl/showcase dev
```

The published CLIs also install via `cargo install spatiotemporal-tiles`. Only
run commands you can verify from the manifests — do not invent scripts.

## How agents get help

- **Claude Code:** install the **`poopdeck-ai` plugin** from this repo root — it
  wires an **MCP server** (`@poopdeck.gl/mcp`, live dataset discovery / analysis /
  `@deck.gl/json` map composition / gated build+validate) *and* a set of **Agent
  Skills** that route between the CLIs and MCP tools. Start with the
  `poopdeck-overview` skill (the router). See `poopdeck-ai/README.md`.
- **Other harnesses (Cursor / Codex / Gemini CLI):** the Skills are authored to
  the [agentskills.io](https://agentskills.io) open standard (portable frontmatter)
  and load in any skill-aware harness. The MCP server also exposes
  `stt://docs/*` **resources** plus `search_docs` / `get_doc` tools.
- **Published docs for retrieval:** <https://poopdeck.gl/llms.txt> (index) and
  <https://poopdeck.gl/llms-full.txt> (full corpus). The in-repo `llms.txt`
  mirrors the index.
- This `AGENTS.md` is the cross-harness entry point; it complements the plugin
  rather than replacing it.

## Working conventions

- Prefer the routing table over guessing; open the referenced doc before writing
  code against an API.
- Respect the ground rules above — they are load-bearing invariants, not style
  preferences.
- The showcase honors `prefers-reduced-motion`; any new animated surface must gate
  on it.

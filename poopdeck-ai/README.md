# poopdeck-ai — Claude Code plugin

The AI-assisted suite for poopdeck.gl / SpatioTemporal Tiles: the
`@poopdeck.gl/mcp` server plus a set of Agent Skills, packaged as one Claude Code
plugin so a single install wires both.

- **MCP server** (`.mcp.json`, auto-registered on enable) — the live surface:
  discover datasets, search and read the STT docs, analyze/lint archives, compose
  `@deck.gl/json` map specs, and (CLI-gated) build, validate, and generate bundled
  datasets. See [`../packages/mcp/README.md`](../packages/mcp/README.md).
- **Skills** (`skills/`, auto-loaded) — the procedural surface: the workflow, the
  opinions, and which CLI or MCP tool to reach for.

The arrangement follows Cloudflare's `wrangler` skill, which routes between its
MCP server and its CLI: here the `stt-*` Rust CLIs are the CLI, the MCP server is
the live surface, and the skills route between them. Design record:
[`../docs/roadmap/ai-suite.md`](../docs/roadmap/ai-suite.md).

## Install

From a checkout of this repo (the repo root is the plugin marketplace):

```
/plugin marketplace add /path/to/spatiotemporal-tiles
/plugin install poopdeck-ai
```

Then **build the MCP server — this step is required, not optional:**

```bash
pnpm --filter @poopdeck.gl/mcp build
```

> **Do not skip that.** `@poopdeck.gl/mcp` is **not published to npm yet**, so the
> bundled `.mcp.json` runs a local build artifact, `packages/mcp/dist/bin.js`. If
> that file is missing the plugin still installs and the skills still load, but
> the MCP server **silently fails to start** — every tool below is simply absent,
> with nothing in the UI pointing at the cause. Confirm with
> `ls packages/mcp/dist/bin.js` before enabling the plugin, and re-run the build
> after any edit under `packages/mcp/src/`. If the `stt` tools don't show up,
> check this first.

The server runs over stdio, scanning `examples/showcase/public/data` for
datasets. Once `@poopdeck.gl/mcp` is published to npm you can switch the command
in `.mcp.json` to `npx -y @poopdeck.gl/mcp` and drop the build step entirely.

## What you get out of the box

The bundled `.mcp.json` launches the server with **`--allow-cli`** — a locally
installed, stdio-only plugin the user deliberately enabled — so the full tool set
is live. Always-on, read-only tools:

- `list_datasets`, `describe_dataset` — discover + inspect archives (manifest only).
- `search_docs` / `get_doc` — search the published STT documentation and read a
  page in-band. The corpus is **bundled with the package**, so this works with no
  repo on disk (point elsewhere with `--docs-root`).
- `view_map` — compose a `@deck.gl/json` spec (STT layers) for one or more datasets.
- `set_time` / `play_pause` — structured playback intents.
- `stt://datasets/<name>` **resources** — the manifest payload, enumerable/cacheable.
- `stt://docs/<path>` **resources** — the same doc corpus, enumerable and
  addressable as context without a tool call.

CLI-gated tools (enabled by the `--allow-cli` in `.mcp.json`) — these shell out to
the `stt-*` binaries (resolved from `target/release/` or `PATH`):

- `recommend_build` — analyze a source GeoParquet → an evidence-backed build recipe.
- `dataset_report` — `stt-optimize inspect`/`doctor`/`order-audit` on a built archive.
- `diff_datasets` — before/after regression gate.
- `build_dataset` — `stt-build` from a GeoParquet input (PostGIS/DuckDB sources
  go through `extraArgs`).
- `generate_dataset` — `stt-generate` one of the bundled reference datasets.
- `validate_dataset` — `stt-validate` integrity/decode/schema/temporal.

> **Security:** `--allow-cli` lets the MCP client spawn the `stt-*` binaries (which
> read/write the filesystem and, for `generate_dataset`, the network). That's the
> intended behavior for a trusted local stdio session. **Remove `--allow-cli` from
> `.mcp.json` for a read-only, no-shell-out setup** (the gated tools then return an
> "enable --allow-cli" hint instead of running). Do **not** pair `--allow-cli` with
> a non-localhost HTTP transport on an untrusted network.

## Skills

| Skill                     | When it fires                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `poopdeck-overview`       | Any poopdeck.gl / STT work — the router: which CLI, package, MCP tool, or skill to use.                         |
| `installing-poopdeck`     | Cold start — install the `stt-*` CLIs, add `@poopdeck.gl/*` + the deck.gl 9.3.x peers, scaffold a first render. |
| `building-stt-datasets`   | Turn **your own** GeoParquet / PostGIS / DuckDB into a `.stt` (recommends `recommend_build` first).             |
| `generating-stt-datasets` | Download + build a **bundled reference** dataset (earthquakes, drifters, GTFS, …) via `generate_dataset`.       |
| `tuning-stt-tiles`        | Shrink / lint / publish an archive (the no-thinning rule; `dataset_report` + `diff_datasets`).                  |
| `wiring-deckgl-layers`    | Pick the right STT layer and compose a `@deck.gl/json` spec (pairs with `view_map`).                            |
| `debugging-blank-renders` | A map renders blank/empty — the failure classes + `validate_dataset`.                                           |
| `choosing-a-renderer`     | Which backend — deck.gl vs three (TSL/WebGPU) vs MapLibre/Mapbox vs Cesium; sharing camera + clock.             |
| `adding-playback`         | Add time playback — `SttPlayer` / `TimeController` / `PlaybackGovernor`, the React hooks, scrubber UI.          |
| `serving-and-publishing`  | Ship it — `stt-serve` dynamic tiles vs static publish to R2/S3/GCS/nginx; cache regimes, Range CORS.            |

Skills are authored to the [agentskills.io](https://agentskills.io) open standard
(portable `name` + `description` frontmatter), so they also load in Codex, Gemini
CLI, Cursor, and other skill-aware harnesses.

## Reading the docs the skills cite (offline / no-repo fallback)

Skills reference repo-relative doc paths like `docs/api/cli-reference.md`. When the
repo `docs/` tree isn't on disk (a portable harness or a published plugin), the same
corpus is reachable two other ways, so a citation never dangles. Let `<path>` be the
part after `docs/`; resolve **in this order**:

1. **Repo checkout** — `docs/<path>` on disk.
2. **MCP** — the `get_doc` tool (pass `<path>`) or `search_docs`, or the
   `stt://docs/<path>` **resource** the `stt` server exposes.
3. **Web** — `https://poopdeck.gl/llms/<path>` (e.g.
   `https://poopdeck.gl/llms/api/cli-reference.md`); the whole corpus in one file is
   `https://poopdeck.gl/llms-full.txt`.

Each skill also **inlines** its load-bearing, must-not-guess facts (the no-thinning /
zoom-clamp + temporal-bucket rule, canonical `stt-build` flags, the deck.gl `9.3.x`
pin, the blank-render failure classes), so it stays correct even with **no** doc
reachable. The convention is defined once in the **poopdeck-overview** skill and
referenced briefly from the others.

MIT.

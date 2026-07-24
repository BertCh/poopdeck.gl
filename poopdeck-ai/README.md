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

That's the whole install. The bundled `.mcp.json` runs the **published** server:

```json
{
  "mcpServers": {
    "stt": { "command": "npx", "args": ["-y", "@poopdeck.gl/mcp"] }
  }
}
```

No repo checkout, no build step, no `dist/` on disk — `npx` fetches
[`@poopdeck.gl/mcp`](https://www.npmjs.com/package/@poopdeck.gl/mcp) and the
documentation corpus rides inside that tarball, so `search_docs`/`get_doc` work
immediately.

### Pointing it at your datasets

The plugin sets **no dataset root**. It can't: a plugin installed from the
marketplace has no idea where your archives live, and the old config guessed a
path inside a repo checkout (`examples/showcase/public/data`) that exists on
exactly one machine. With none set, the server falls back to
`$STT_DATA_ROOT`, else `<cwd>/examples/showcase/public/data` — so
`list_datasets` returns an empty catalog rather than failing, and every
docs/compose tool still works.

To see your own archives, either export `STT_DATA_ROOT=/path/to/archives`
before launching Claude Code, or add an explicit flag to the server args
(a project-scoped `.mcp.json`, `claude mcp add`, or by editing the plugin's own
`.mcp.json`):

```json
{
  "mcpServers": {
    "stt": {
      "command": "npx",
      "args": ["-y", "@poopdeck.gl/mcp", "--data-root", "/path/to/archives"]
    }
  }
}
```

A "dataset" is any directory containing a `manifest.json`, found up to six
levels under the root.

## What you get out of the box

The bundled `.mcp.json` runs the server in its **default, read-only mode** — no
`--allow-cli`, so nothing this plugin registers can spawn a process or write a
file (see [Enabling the CLI tools](#enabling-the-cli-tools-allow-cli)).
Always-on, read-only tools:

- `list_datasets`, `describe_dataset` — discover + inspect archives (manifest only).
- `search_docs` / `get_doc` — search the published STT documentation and read a
  page in-band. The corpus is **bundled with the package**, so this works with no
  repo on disk (point elsewhere with `--docs-root`).
- `view_map` — compose a `@deck.gl/json` spec (STT layers) for one or more datasets.
- `set_time` / `play_pause` — structured playback intents.
- `stt://datasets/<name>` **resources** — the manifest payload, enumerable/cacheable.
- `stt://docs/<path>` **resources** — the same doc corpus, enumerable and
  addressable as context without a tool call.

Six more tools are CLI-gated. Without `--allow-cli`, three of them still appear
in `tools/list` but decline to shell out — `dataset_report` answers from the
manifest alone, `recommend_build` and `diff_datasets` return an "enable
`--allow-cli`" hint — and `build_dataset` / `validate_dataset` /
`generate_dataset` are not registered at all, so a default server never even
advertises them.

## Enabling the CLI tools (`--allow-cli`)

**Opt in deliberately, and only for a local stdio server you trust.** The flag
is off by default in `@poopdeck.gl/mcp` and this plugin does not turn it on.

What it unlocks — six tools that **shell out to the `stt-*` Rust binaries**
(resolved from `target/release/` walking up from the data root and CWD, else
`PATH`) with arguments chosen by the agent:

- `recommend_build` — `stt-optimize recommend` over a source GeoParquet → an
  evidence-backed build recipe.
- `dataset_report` — `stt-optimize inspect`/`doctor`/`order-audit` on a built
  archive. Also unlocks its `path` argument, which addresses an archive
  **outside** `--data-root` (rejected without the flag).
- `diff_datasets` — `stt-optimize diff`, a before/after regression gate.
- `build_dataset` — `stt-build` from a GeoParquet input (PostGIS/DuckDB sources
  go through `extraArgs`); **writes** to the output directory you name.
- `generate_dataset` — `stt-generate` a bundled reference dataset; **writes**
  to disk and **downloads over the network**.
- `validate_dataset` — `stt-validate` integrity/decode/schema/temporal.

The honest summary: with `--allow-cli`, an MCP tool call can spawn a
subprocess and read or write any path the server process can reach — the input
and output paths are tool arguments, and they ultimately come from whatever
model is driving the session. That is the intended power of a local build agent,
and it is also why it is not the default. Turn it on by adding the flag to the
server args:

```json
{
  "mcpServers": {
    "stt": {
      "command": "npx",
      "args": [
        "-y",
        "@poopdeck.gl/mcp",
        "--allow-cli",
        "--data-root",
        "/path/to/archives"
      ]
    }
  }
}
```

Two hard rules:

- **Never** pair `--allow-cli` with `--transport http` on a non-localhost bind.
  (The HTTP transport enforces DNS-rebinding protection precisely because that
  combination turns a browser tab into a remote shell.)
- Without the flag, the read-only tools stay read-only: `list_datasets`,
  `describe_dataset`, `search_docs`, `get_doc`, `view_map`, `set_time`, and
  `play_pause` never spawn anything, and every path they accept is checked for
  containment (lexically **and** after `realpath`, so a symlink can't escape).

This repo's own root `.mcp.json` — the one contributors get when they open the
checkout in Claude Code — **does** pass `--allow-cli` and points at the local
`packages/mcp/dist/bin.js` build. That config is deliberately different: it
serves people who already run `cargo build` and `pnpm test` in this tree, so the
CLIs are the workflow and no new trust boundary is crossed. A marketplace plugin
installed by a stranger has neither that context nor those binaries.

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

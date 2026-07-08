# @poopdeck.gl/mcp

An **MCP (Model Context Protocol) server** for SpatioTemporal Tiles. It gives an
AI assistant a live, temporal-native surface over a directory of packed STT
archives: discover datasets, analyze/lint them, compose `@deck.gl/json` map
specs, and — when explicitly enabled — build and validate.

It is open and self-hostable: plain TypeScript, MIT, and runs entirely against a
local directory of packed datasets. No account, and no network dependency beyond
the datasets themselves. The command line binary is **`stt-mcp`**.

This page is the tool/flag reference. For how the server fits with the Agent
Skills and how to install the whole thing as a Claude Code plugin, see the
[AI Suite guide](../guides/ai-suite.md).

## Install

```bash
npm install -g @poopdeck.gl/mcp
# or run it without installing:
npx @poopdeck.gl/mcp --data-root ./examples/showcase/public/data
```

## The `stt-mcp` command

```
stt-mcp — MCP server for spatiotemporal tiles (@poopdeck.gl/mcp)

Usage: stt-mcp [options]

  --data-root <dir>          Directory scanned for packed datasets
                             (default: $STT_DATA_ROOT, else
                             ./examples/showcase/public/data)
  --docs-root <dir>          Directory holding the published docs corpus,
                             served via stt://docs/<path> resources and the
                             search_docs / get_doc tools (default:
                             $STT_DOCS_ROOT, else the docs/ bundled beside the
                             installed package, else ./docs)
  --allow-cli                Enable shell-out tools (build_dataset,
                             validate_dataset, dataset_report's CLI mode,
                             recommend_build, diff_datasets). Off by default.
  --transport <stdio|http>   Transport to serve (default: stdio)
  --host <host>              HTTP transport bind host (default: 127.0.0.1)
  --port <port>              HTTP transport bind port (default: 3900)
  --public-base-url <url>    Base URL datasets are served from, used by
                             view_map to build manifest URLs
  --allowed-host <host>      Extra Host allowed on the HTTP transport
                             (repeatable; DNS-rebinding allow-list)
  --allowed-origin <origin>  Extra Origin allowed on the HTTP transport
                             (repeatable)
  --stt-optimize-bin <path>  Override the stt-optimize binary path
  --stt-build-bin <path>     Override the stt-build binary path
  --stt-validate-bin <path>  Override the stt-validate binary path
  -h, --help                 Show this help
```

`--data-root` is scanned for packed datasets: any directory containing a
`manifest.json` counts as one dataset. [Scene bundles](../spec/sidecar-assets.md)
(the AV-cockpit case) nest one level deep — `<scene-id>/lidar/manifest.json`,
`<scene-id>/objects/manifest.json`, etc. — and each stream is its own dataset.
Discovery reads only that one JSON file per dataset; tile/pack bytes are never
read by this server.

## MCP client config

**Claude Code** (`.mcp.json` at the repo root, or `claude mcp add`):

```json
{
  "mcpServers": {
    "stt": {
      "command": "npx",
      "args": ["-y", "@poopdeck.gl/mcp", "--data-root", "./examples/showcase/public/data"]
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "stt": {
      "command": "stt-mcp",
      "args": ["--data-root", "/absolute/path/to/examples/showcase/public/data"]
    }
  }
}
```

For Streamable HTTP instead of stdio: `stt-mcp --transport http --port 3900`,
then point an HTTP-capable MCP client at `http://127.0.0.1:3900/`. HTTP mode is
**stateless** (no session IDs) — fine for a single local/dev client; front it
with a session-aware proxy for multi-client production use.

## Tools

Few, consolidated, opinionated, **read-only by default**. Tools that shell out to
the `stt-*` binaries are gated behind `--allow-cli` (see [below](#the---allow-cli-safety-note)).

### Discovery (always registered)

| Tool | Params | Returns |
|---|---|---|
| `list_datasets` | `search?` | `{dataRoot, count, datasets: [{name, path, format, formatVersion, boundingBox, timeRange, minZoom, maxZoom, featureCount, hasSummaryTier, summaryScheme}]}` — compact metadata only |
| `describe_dataset` | `name` | The full parsed `manifest.json`: metadata, temporal block, capabilities, compression/blob-ordering, directory layout, pack count + total bytes, summary tier, style hints, and a best-effort `columns` list. `featureCount`/`tileCount` report **absent (unknown)** rather than `0` when the manifest never populated them |
| `dataset_report` | `name, include?: ('inspect'\|'doctor'\|'order-audit')[], sample?, exact?` | With `--allow-cli`: parsed `stt-optimize inspect`/`doctor`/`order-audit` JSON. Decode-dependent stats **default to a 256-tile sample** (`sampledDefault` in the payload) so the first call doesn't exceed the client's request timeout — pass `exact: true` for a full decode. Without `--allow-cli`: a manifest-only summary |

### Docs (always registered)

Read-only access to the published STT documentation corpus — `docs/README.md`
plus every `*.md` directly under `docs/{intro,architecture,spec,api,guides}` (the
same set the docs site renders; `docs/roadmap/` is **excluded**). These are pure
in-process file reads — they never shell out, so they are **not** gated behind
`--allow-cli`. The corpus is **bundled beside the package** at build time, so a
published `npx @poopdeck.gl/mcp` / global install serves docs with **no repo on
disk** (override the location with `--docs-root` / `$STT_DOCS_ROOT`).

| Tool | Params | Returns |
|---|---|---|
| `search_docs` | `query, limit?` | Case-insensitive substring search across the whole corpus: `{query, count, results: [{path, title, score, snippets: [{line, text}]}]}`, ranked by `score` (occurrence count) then `path`, snippet count bounded so the response stays token-bounded |
| `get_doc` | `path, maxBytes?` | The markdown text of one corpus doc, addressed by its docs-relative `path` (e.g. `api/cli-reference.md`, `README.md`). Truncated at `maxBytes` (default 40000) with a `...[truncated]` marker reporting the true byte length. An invalid/unknown/traversing path errors with a pointer to `search_docs` / the `stt://docs` list |

### Analysis (always registered; self-gate on `--allow-cli`)

Each shells out to `stt-optimize`, the only reader of raw parquet / built
archives, so they register but return an "enable `--allow-cli`" message until it
is set.

| Tool | Params | Returns |
|---|---|---|
| `recommend_build` | `input, timeField?, timeFormat?, output?` | An evidence-backed build recipe from `stt-optimize recommend` over a **source** GeoParquet: `{recommendation: {min_zoom, max_zoom, temporal_bucket_ms, confidence, explanations}, suggestedCommand, buildDatasetArgs}`. `suggestedCommand` is a ready-to-run `stt-build` string; `buildDatasetArgs` is the same recipe shaped for handoff to `build_dataset`. **Call this before hand-writing a build** |
| `diff_datasets` | `before, after, sample?, exact?` | Parsed `stt-optimize diff` between two **built** archives: total / per-zoom / per-column byte + feature deltas, plus `beforePhysicalBytes`/`afterPhysicalBytes` (on-disk sizes). Use the physical bytes to answer "did it shrink?"— the Rust report's `compressed_bytes` is a logical addressed-byte sum. A regression gate for re-encodes |

### Interactive (always registered)

| Tool | Params | Returns |
|---|---|---|
| `view_map` | `datasets: string \| string[], layer?, viewState?, time?` | A `@deck.gl/json`-shaped spec (`{layers: [{"@@type": …, data: <manifest URL>, …}], initialViewState}`) as text, plus a self-contained HTML spec-preview resource. Emits `warnings` when a layer's geometry can't be inferred or the manifest URL is a local filesystem path (set `--public-base-url`). `viewState` is validated strictly |
| `set_time` | `time` | `{intent: 'set_time', time}` — a structured intent (this server has no live renderer to drive) |
| `play_pause` | `playing, speed?` | `{intent: 'play_pause', playing, speed}` |

### Execution (only registered with `--allow-cli`)

| Tool | Params | Returns |
|---|---|---|
| `build_dataset` | `input, output, timeField?, minZoom?, maxZoom?, temporalBucket?, summaryTier?, styleHints?, publish?, …` | Shells out to `stt-build`; returns stdout/stderr/exit code + the resulting manifest summary. The **only mutating tool** |
| `validate_dataset` | `name? \| path, sample?, skipDecode?, failFast?` | Shells out to `stt-validate --json`; returns the parsed report. `name` and `path` are mutually exclusive |

All five shell-out tools (`build_dataset`, `validate_dataset`, `diff_datasets`,
`dataset_report`, `recommend_build`) set the MCP **`isError` flag** when the
subprocess exits nonzero, times out, or fails to spawn — an agent branching on
`isError` can trust it. The spawned child is killed when the client cancels or
times out the request, so no orphaned `stt-*` processes linger.

## Resources

Datasets are also exposed as read-only MCP **resources** (0 tokens until read;
enumerable and cacheable without a tool call):

| URI | Content |
|---|---|
| `stt://datasets/<name>` | The same full parsed-manifest payload as `describe_dataset`, as `application/json`. `resources/list` enumerates datasets under `--data-root` (capped at 100 with a `_meta` pointer to `list_datasets`); `<name>` is URL-encoded |
| `stt://docs/<path>` | One published documentation page as `text/markdown`. `resources/list` enumerates the corpus (README + `intro`/`architecture`/`spec`/`api`/`guides`, `docs/roadmap/` excluded) with a human `title` per page; `<path>` is URL-encoded (multi-segment paths like `api/cli-reference.md` become a single `%2F`-encoded segment). Path traversal / non-corpus / non-`.md` paths are rejected. Same corpus the `search_docs` / `get_doc` tools serve |

## `view_map` layer inference

`view_map`'s `@@type` values are STT layer class names (e.g.
`SpatioTemporalLayer`, `AnimatedTripsLayer`) exported from `@poopdeck.gl/layers`.
A client that wants to actually render the spec registers those classes in a
`@deck.gl/json` `JSONConfiguration` (see the
[deck.gl integration](../architecture/deckgl-integration.md) doc):

```ts
import { JSONConfiguration, JSONConverter } from '@deck.gl/json';
import * as sttLayers from '@poopdeck.gl/layers';

const converter = new JSONConverter({
  configuration: new JSONConfiguration({ layers: sttLayers }),
});
const { layers } = converter.convert(spec);
new Deck({ layers, initialViewState: spec.initialViewState });
```

When the `layer` param is omitted, `@@type` is inferred in order:

1. the dataset's build-time `style_hints.layer_hint`
   (`'points'|'paths'|'trips'|'polygons'`, confidence `'hint'`),
2. its summary-tier scheme (`H3SummaryLayer` / `QuadbinSummaryLayer`, confidence
   `'summary'`),
3. a blind `AnimatedPointLayer` (confidence `'default'`).

`layer_hint` only exists on archives built with `--style-hints`, so a dataset
without it (and without a summary tier) hits the blind default — `view_map` then
returns a `warnings` entry telling the caller to set `layer` explicitly for
path/trip/polygon data. `buildSystemPrompt()` (also exported) renders the scanned
catalog into the server's `instructions` field at startup, so an agent knows
what's available before its first `list_datasets` call.

## The `--allow-cli` safety note

`dataset_report`'s CLI mode, `recommend_build`, `diff_datasets`, `build_dataset`,
and `validate_dataset` shell out to the `stt-*` binaries — arbitrary local
process execution driven by MCP tool-call arguments (which ultimately come from
whatever agent is talking to this server). **`--allow-cli` is off by default** for
exactly that reason. Of these, only `build_dataset` mutates the filesystem; the
rest are read-only analyses (still opt-in, because any subprocess execution is).
`list_datasets` / `describe_dataset` / `view_map` / `set_time` / `play_pause` /
`search_docs` / `get_doc` never shell out at all — they only read `manifest.json`
files and the bundled docs corpus.

Only enable `--allow-cli` when the MCP client is trusted and the server isn't
exposed beyond a single trusted operator (e.g. local stdio to your own coding
agent). `build_dataset` can write anywhere the process has filesystem access, and
`--transport http --allow-cli` on a non-localhost bind is a real risk.

**Binary resolution** (`--stt-optimize-bin` / `--stt-build-bin` /
`--stt-validate-bin`): an explicit override always wins; otherwise the server
searches `target/release/<name>` walking up from `--data-root` and the process
CWD (this repo's Cargo workspace output); otherwise it falls back to the bare
command name resolved via `PATH` (works once the binaries are `cargo install`ed).

## Where it fits

This server is the **live** tier of the AI suite. It is bundled with a set of
Agent Skills as the **`poopdeck-ai`** Claude Code plugin, whose `.mcp.json`
auto-registers it and whose `skills/` teach the workflow and route between these
tools and the `stt-*` CLIs. See the [AI Suite guide](../guides/ai-suite.md) for
install and usage, the [CLI reference](./cli-reference.md) for the underlying
commands, and the [`@poopdeck.gl/mcp` package README](../../packages/mcp/README.md)
for the source-of-truth details.

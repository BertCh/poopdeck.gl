# @poopdeck.gl/mcp

An **MCP (Model Context Protocol) server** for SpatioTemporal Tiles. It gives an
AI assistant a live, temporal-native surface over a directory of packed STT
archives: discover datasets, analyze/lint them, compose `@deck.gl/json` map
specs, and — when explicitly enabled — build, generate, and validate.

It is open and self-hostable: plain TypeScript, MIT, and runs entirely against a
local directory of packed datasets. No account, and — across the default
read-only surface — no network dependency beyond the datasets themselves. The
one exception is the opt-in `generate_dataset` tool, which downloads public
source data; see the [safety note](#the---allow-cli-safety-note). The command
line binary is **`stt-mcp`**.

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
                              search_docs/get_doc tools (default:
                              $STT_DOCS_ROOT, else the docs/ bundled beside the
                              package, else ./docs)
  --allow-cli                Enable shell-out tools (build_dataset,
                              validate_dataset, generate_dataset, and the
                              CLI mode of
                              dataset_report/recommend_build/diff_datasets).
                              Off by default.
  --transport <stdio|http>   Transport to serve (default: stdio)
  --host <host>              HTTP transport bind host (default: 127.0.0.1)
  --port <port>              HTTP transport bind port (default: 3900)
  --allowed-host <host>      Add a Host header value (host:port) to the
                              DNS-rebinding allow-list (repeatable). The bind
                              host plus 127.0.0.1/localhost on the bind port
                              are always allowed.
  --allowed-origin <origin>  Add an Origin header value to the DNS-rebinding
                              allow-list (repeatable).
  --public-base-url <url>    Base URL datasets are served from, used by
                              view_map to build manifest URLs
  --stt-optimize-bin <path>  Override the stt-optimize binary path
  --stt-build-bin <path>     Override the stt-build binary path
  --stt-validate-bin <path>  Override the stt-validate binary path
  --stt-generate-bin <path>  Override the stt-generate binary path
  -h, --help                 Show this help

Security: the HTTP transport enforces DNS-rebinding protection using the
Host/Origin allow-lists above. Binding a non-localhost --host together with
--allow-cli exposes browser-driven arbitrary file read/write and subprocess
spawn — only do so on a trusted, access-controlled network.
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
      "args": [
        "-y",
        "@poopdeck.gl/mcp",
        "--data-root",
        "./examples/showcase/public/data"
      ]
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

Thirteen tools, read-only by default. Ten always register; the three execution
tools register only with `--allow-cli`, and the three analysis tools register
unconditionally but self-gate on it (see [below](#the---allow-cli-safety-note)).

### Discovery (always registered)

| Tool               | Params                                                                             | Returns                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `list_datasets`    | `search?`                                                                          | Compact per-dataset metadata: name, path, format, bbox, time range, zoom range, feature count, summary tier |
| `describe_dataset` | `name`                                                                             | The full parsed `manifest.json`                                                                             |
| `dataset_report`   | `name? \| path, include?: ('inspect'\|'doctor'\|'order-audit')[], sample?, exact?` | Parsed `stt-optimize` output for a built archive                                                            |

`describe_dataset` returns metadata, the temporal block, capabilities,
compression and blob-ordering, directory layout, pack count and total bytes,
summary tier, style hints, and a best-effort `columns` list. `featureCount` and
`tileCount` report as absent (unknown) rather than `0` when the manifest never
populated them.

`dataset_report` needs `--allow-cli` for its CLI mode; without it you get a
manifest-only summary. Decode-dependent stats default to a 256-tile sample
(flagged as `sampledDefault` in the payload) so the first call doesn't exceed the
client's request timeout — pass `exact: true` for a full decode. `name` (under
`--data-root`) and `path` (an explicit archive path, itself requiring
`--allow-cli`) are mutually exclusive.

### Docs (always registered)

| Tool          | Params            | Returns                                    |
| ------------- | ----------------- | ------------------------------------------ |
| `search_docs` | `query, limit?`   | Ranked matches with line-windowed snippets |
| `get_doc`     | `path, maxBytes?` | One corpus document, verbatim              |

The corpus is `docs/README.md`, every `*.md` directly under
`docs/{intro,architecture,spec,api,guides}` — the same set the docs site renders
— plus the direct `*.json` children of `docs/spec/`: the normative machine-
readable schemas (`manifest.schema.json`, `scene.schema.json`,
`tile-matrix-set.json`, `render-spec.json`), served verbatim so an agent can
`JSON.parse` a contract instead of reading prose about it. `docs/roadmap/` is
excluded, as is every other extension and any nested path.

These are in-process file reads and never shell out, so they are not gated behind
`--allow-cli`. The corpus is bundled beside the package at build time, so an
`npx @poopdeck.gl/mcp` or global install serves docs with no repo on disk
(override with `--docs-root` / `$STT_DOCS_ROOT`).

`search_docs` is a case-insensitive substring search across prose and the
`spec/*.json` schemas alike, so a property name like `temporalBucketMs` is
findable in the schema that defines it. Results carry `{path, title, score,
snippets}`, ranked by occurrence count then path. Snippets are windowed around
the match rather than head-truncated, so a hit on a near-minified JSON line still
contains the query; the snippet count is bounded to keep the response
token-bounded.

`get_doc` takes a docs-relative `path` (e.g. `api/cli-reference.md`,
`spec/manifest.schema.json`, `README.md`) and truncates at `maxBytes` (default 40000) with a `...[truncated]` marker reporting the true byte length. An invalid,
unknown, or traversing path errors with a pointer to `search_docs` and the
`stt://docs` list.

### Analysis (always registered; self-gate on `--allow-cli`)

Each shells out to `stt-optimize`, the only reader of raw parquet and built
archives, so they register but return an "enable `--allow-cli`" message until it
is set.

| Tool              | Params                                    | Returns                                    |
| ----------------- | ----------------------------------------- | ------------------------------------------ |
| `recommend_build` | `input, timeField?, timeFormat?, output?` | An evidence-backed build recipe            |
| `diff_datasets`   | `before, after, sample?, exact?`          | Byte and feature deltas between two builds |

**Call `recommend_build` before hand-writing a build.** Over a source
GeoParquet it returns `{recommendation: {min_zoom, max_zoom,
temporal_bucket_ms, confidence, explanations, advice}, dominantType,
suggestedCommand, evidence, buildDatasetArgs}`. `suggestedCommand` is a
ready-to-run `stt-build` string; `buildDatasetArgs` is the same recipe shaped for
handoff to `build_dataset`; `evidence` stamps each advisor lever with
`autoApplied`, since lossy and suggestion-only levers are surfaced but never
auto-applied.

`diff_datasets` reports total, per-zoom, and per-column byte and feature deltas
between two built archives, plus `beforePhysicalBytes`/`afterPhysicalBytes`. Use
the physical bytes to answer "did it shrink?" — the Rust report's
`compressed_bytes` is a logical addressed-byte sum.

### Interactive (always registered)

| Tool         | Params                                                                                                                 | Returns                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `view_map`   | `datasets?: string \| string[], paths?: string \| string[], layer?, intent?, colorBy?, timeWindow?, viewState?, time?` | A `@deck.gl/json` spec plus an HTML preview |
| `set_time`   | `time`                                                                                                                 | `{intent: 'set_time', time}`                |
| `play_pause` | `playing, speed?`                                                                                                      | `{intent: 'play_pause', playing, speed}`    |

`view_map` returns `{layers: [{"@@type": …, data: <manifest URL>, …}],
initialViewState}` as text, plus a self-contained HTML spec-preview resource.
Pass `datasets` (names under `--data-root`) and/or `paths` (explicit archive
paths, which require `--allow-cli`). `intent`
(`density`/`tracking`/`flow`/`magnitude`/`choropleth`/`exploratory`) together
with `colorBy` and `timeWindow` drives a data-derived presentation and can
promote the layer to `AnimatedArcLayer` or `AnimatedColumnLayer` where the
geometry supports it. It emits `warnings` when a layer's geometry can't be
inferred or the manifest URL is a local filesystem path (set `--public-base-url`).
The whole input is validated strictly — an unknown key such as `viewstate` errors
rather than being dropped.

`set_time` and `play_pause` return structured intents; this server has no live
renderer to drive.

### Execution (only registered with `--allow-cli`)

| Tool               | Params                                                                                                   | Returns                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `build_dataset`    | `input, output, timeField?, minZoom?, maxZoom?, temporalBucket?, summaryTier?, styleHints?, publish?, …` | `stt-build` stdout/stderr/exit code + manifest summary    |
| `validate_dataset` | `name? \| path, sample?, skipDecode?, failFast?`                                                         | The parsed `stt-validate --json` report                   |
| `generate_dataset` | `dataset, output?, extraArgs?, timeoutMs?`                                                               | `stt-generate` stdout/stderr/exit code + manifest summary |

`build_dataset` builds an archive from your own GeoParquet and **writes to the
filesystem** (10-minute default timeout, `timeoutMs` to change).
`validate_dataset` takes `name` and `path` as mutually exclusive.

`generate_dataset` **downloads** and builds one of the bundled reference
datasets: network-bound, long-running, and writes to the filesystem (15-minute
default timeout). `dataset` is an enum of 17 subcommands — 16 generators
(`earthquakes`, `ais`, `flights`, `hurricanes`, `wildfires`, `nyc-rideshare`,
`bixi`, `gtfs`, `nwm`, `nyc-taxi-points`, `satellites`, `drifters`,
`drifters-hourly`, `animals`, `osm-edits`, `storms`) plus `all`, which builds the
three no-parameter datasets into `output` as a directory. Source-specific flags
(`--date`, `--start`/`--end`, `--synthetic`, …) pass through `extraArgs`
verbatim.

All six shell-out tools (`build_dataset`, `validate_dataset`, `generate_dataset`,
`diff_datasets`, `dataset_report`, `recommend_build`) set the MCP `isError` flag
when the subprocess exits nonzero, times out, or fails to spawn, so an agent
branching on `isError` can trust it. The spawned child is killed when the client
cancels or times out the request, leaving no orphaned `stt-*` processes.

## Resources

Datasets and docs are also exposed as read-only MCP resources — 0 tokens until
read, and enumerable and cacheable without a tool call.

| URI                     | Content                                     |
| ----------------------- | ------------------------------------------- |
| `stt://datasets/<name>` | One dataset's full parsed manifest, as JSON |
| `stt://docs/<path>`     | One published documentation page            |

`stt://datasets/<name>` returns the same payload as `describe_dataset`.
`resources/list` enumerates datasets under `--data-root`, capped at 100 with a
`_meta` pointer to `list_datasets`; `<name>` is URL-encoded.

`stt://docs/<path>` serves `text/markdown` for prose and `application/json` for a
`spec/*.json` schema, with the mime type set per entry on both `resources/list`
and the read. Listing enumerates the corpus (README plus
`intro`/`architecture`/`spec`/`api`/`guides`, plus `spec/*.json`, with
`docs/roadmap/` excluded) and gives each page a human `title` — an H1 for
markdown, the schema's own top-level `title` for JSON. `<path>` is URL-encoded, so
a multi-segment path like `api/cli-reference.md` becomes a single `%2F`-encoded
segment. Path traversal, non-corpus, and non-admitted-extension paths are
rejected. This is the same corpus `search_docs` and `get_doc` serve.

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

Every current `stt-build` bakes a `layer_hint` (`--style-hints` only adds the
fuller percentile/cardinality profile on top), but archives built before it
became a default carry none — those, absent a summary tier, hit the blind
default, and `view_map` returns a `warnings` entry telling the caller to set
`layer` explicitly for path/trip/polygon data (or rebuild). `buildSystemPrompt()`
(also exported) renders the scanned catalog into the server's `instructions`
field at startup, so an agent knows what's available before its first
`list_datasets` call.

## The `--allow-cli` safety note

`dataset_report`'s CLI mode, `recommend_build`, `diff_datasets`, `build_dataset`,
`validate_dataset`, and `generate_dataset` shell out to the `stt-*` binaries —
arbitrary local process execution driven by MCP tool-call arguments (which
ultimately come from whatever agent is talking to this server). **`--allow-cli`
is off by default** for exactly that reason. Two of the six write to the
filesystem — `build_dataset` (the archive it builds) and `generate_dataset` (the
archive it generates); the other four are read-only analyses (still opt-in,
because any subprocess execution is).

`generate_dataset` is the most privileged tool on the server, and the **only
one that touches the network**: it shells out to `stt-generate`, which fetches
public source data (USGS, NOAA, GTFS feeds, …) over the wire and then writes a
packed archive to disk. So `--allow-cli` grants the agent outbound fetches _and_
disk writes, not just local analysis — everything else here, docs corpus
included, is a local file read.

`list_datasets` / `describe_dataset` / `view_map` / `set_time` / `play_pause` /
`search_docs` / `get_doc` never shell out at all — they only read `manifest.json`
files and the bundled docs corpus. Two of them still consult the gate for one
param each: `view_map`'s `paths` and `dataset_report`'s `path` take an explicit
archive path, which escapes the `--data-root` sandbox, so both require
`--allow-cli`.

Only enable `--allow-cli` when the MCP client is trusted and the server isn't
exposed beyond a single trusted operator (e.g. local stdio to your own coding
agent). `build_dataset` and `generate_dataset` can write anywhere the process
has filesystem access, and `--transport http --allow-cli` on a non-localhost
bind is a real risk — the server's own `--help` says as much.

**Binary resolution** (`--stt-optimize-bin` / `--stt-build-bin` /
`--stt-validate-bin` / `--stt-generate-bin`): an explicit override always wins;
otherwise the server searches `target/release/<name>` walking up from
`--data-root` and the process CWD (this repo's Cargo workspace output);
otherwise it falls back to the bare command name resolved via `PATH` (works once
the binaries are `cargo install`ed).

## Where it fits

This server is the **live** tier of the AI suite. It is bundled with a set of
Agent Skills as the **`poopdeck-ai`** Claude Code plugin, whose `.mcp.json`
auto-registers it and whose `skills/` teach the workflow and route between these
tools and the `stt-*` CLIs. See the [AI Suite guide](../guides/ai-suite.md) for
install and usage, the [CLI reference](./cli-reference.md) for the underlying
commands, and the [`@poopdeck.gl/mcp` package README](../../packages/mcp/README.md)
for the source-of-truth details.

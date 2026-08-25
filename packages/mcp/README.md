# @poopdeck.gl/mcp

> **Status: preview.** Published and supported on a best-effort basis while its
> pre-1.0 tool surface evolves. See the
> [support policy](../../docs/intro/status-and-support.md).

**An MCP (Model Context Protocol) server for SpatioTemporal Tiles (STT).**
Open and self-hostable: plain TypeScript, MIT, and runs entirely against a
local directory of packed STT datasets — no account, no network dependency
beyond the datasets themselves. See the [MCP reference](../../docs/api/stt-mcp.md)
and [AI Suite guide](../../docs/guides/ai-suite.md).

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
  --public-base-url <url>    Base URL datasets are served from, used by
                              view_map to build manifest URLs
  --allowed-host <host>      Add a Host header value (host:port) to the
                              DNS-rebinding allow-list (repeatable). The bind
                              host plus 127.0.0.1/localhost on the bind port
                              are always allowed.
  --allowed-origin <origin>  Add an Origin header value to the DNS-rebinding
                              allow-list (repeatable).
  --stt-optimize-bin <path>  Override the stt-optimize binary path
  --stt-build-bin <path>     Override the stt-build binary path
  --stt-validate-bin <path>  Override the stt-validate binary path
  --stt-generate-bin <path>  Override the stt-generate binary path
  -h, --help                 Show this help
```

The HTTP transport enforces DNS-rebinding protection with these Host and Origin
allow-lists. Do not combine a non-localhost `--host` with `--allow-cli` outside
a trusted, access-controlled network.

`--data-root` is scanned for packed datasets: any directory containing a
`manifest.json` counts as one dataset (AV-cockpit bundles nest one level
deep — `<scene-id>/lidar/manifest.json`, `<scene-id>/objects/manifest.json`,
etc. — each stream is its own dataset). Nothing is fetched beyond that one
JSON file for discovery; tile/pack bytes are never read by this server.

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

Streamable HTTP instead of stdio: `stt-mcp --transport http --port 3900`,
then point an HTTP-capable MCP client at `http://127.0.0.1:3900/`. HTTP mode
runs in **stateless** mode (no session IDs) — fine for a single local/dev
client; front it with a session-aware proxy for multi-client production use.

## Tools

**Discovery** (always registered):

| Tool               | Params                                                                                             | Returns                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_datasets`    | `search?: string`                                                                                  | `{dataRoot, count, datasets: [{name, path, format, formatVersion, boundingBox, timeRange, minZoom, maxZoom, featureCount, hasSummaryTier, summaryScheme}]}`                                                                                                                                                                                                                                                                                                                    |
| `describe_dataset` | `name: string`                                                                                     | The full parsed `manifest.json`: metadata, temporal block, capabilities, compression/blob-ordering, directory layout, pack count + total bytes, summary tier, style hints, and a best-effort `columns` list derived from style hints **or, when absent, from the summary tier's aggregated columns**. `featureCount`/`tileCount` are reported as **absent (unknown)** rather than `0` when the manifest never populated them but the archive has content                       |
| `dataset_report`   | `name: string, include?: ('inspect'\|'doctor'\|'order-audit')[], sample?: number, exact?: boolean` | With `--allow-cli`: parsed `stt-optimize inspect`/`doctor`/`order-audit` JSON. The decode-dependent stats **default to a 256-tile sample** (payload carries `sampledDefault`) so the first call doesn't exceed the client's request timeout — pass `exact: true` for a full unsampled decode, or a larger `sample`. An unknown name returns a distinct "not found" error (not the `--allow-cli` hint). Without `--allow-cli`: a manifest-only summary + a message to enable it |

**Analysis** (always registered; each self-gates on `--allow-cli` since it shells out to `stt-optimize`, which is the only reader of the raw parquet / built archives they analyze):

| Tool              | Params                                                            | Returns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recommend_build` | `input: string, timeField?, timeFormat?, output?`                 | An evidence-backed build recipe from `stt-optimize recommend` over a **source** GeoParquet: `{recommendation: {min_zoom, max_zoom, temporal_bucket_ms, confidence, explanations}, suggestedCommand, buildDatasetArgs}` — `suggestedCommand` is a ready-to-run `stt-build` string, `buildDatasetArgs` is the same recipe shaped for direct handoff to the `build_dataset` tool. Call this _before_ hand-writing a build                                                                                                                                                                             |
| `diff_datasets`   | `before: string, after: string, sample?: number, exact?: boolean` | Parsed `stt-optimize diff` between two **built** archives (names under `--data-root` or explicit paths): total / per-zoom / per-column byte + feature deltas, **plus** `requestedBefore`/`requestedAfter` (the args you passed) and `beforePhysicalBytes`/`afterPhysicalBytes` (on-disk sizes from each manifest). Note: the Rust report's `compressed_bytes` is a _logical addressed-byte sum_ and can differ in sign from on-disk size — use the physical bytes to answer "did it shrink?". Decode stats default to a 256-tile sample (`exact: true` for full). A regression gate for re-encodes |

**Interactive** (always registered):

| Tool         | Params                                                                                                             | Returns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `view_map`   | `datasets: string \| string[], layer?: string, viewState?: {longitude,latitude,zoom,pitch,bearing}, time?: number` | A `@deck.gl/json`-shaped spec (`{layers: [{"@@type": ..., data: <manifest URL>, ...}], initialViewState}`) as text, plus a self-contained HTML spec-preview resource. **Emits `warnings`** when a layer's geometry can't be inferred (see below — it then defaults to `AnimatedPointLayer`; set `layer` for path/trip/polygon data) or when the manifest URL is a local filesystem path (set `--public-base-url` for a browser-fetchable URL). `viewState` is validated strictly — a misspelled key errors rather than being silently dropped |
| `set_time`   | `time: number`                                                                                                     | `{intent: 'set_time', time}` — a structured intent; this server has no live renderer to drive                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `play_pause` | `playing: boolean, speed?: number`                                                                                 | `{intent: 'play_pause', playing, speed}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**Execution** (only registered with `--allow-cli`, off by default):

| Tool               | Params                                                                                                                                                           | Returns                                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build_dataset`    | `input, output, timeField?, minZoom?, maxZoom?, temporalBucket?, summaryTier?, styleHints?, publish?, name?, description?, attribution?, extraArgs?, timeoutMs?` | Shells out to `stt-build`; returns stdout/stderr/exit code + the resulting manifest summary                                                                                                                                  |
| `generate_dataset` | `dataset: <subcommand>, output?, extraArgs?, timeoutMs?`                                                                                                         | Shells out to `stt-generate <dataset>` to DOWNLOAD + build ONE bundled reference dataset into `output` (a single `.stt` via `--output`). Source-specific flags go through `extraArgs`. Network-bound; 15-min default timeout |
| `validate_dataset` | `name? \| path, sample?, skipDecode?, failFast?`                                                                                                                 | Shells out to `stt-validate --json`; returns the parsed report. `name` and `path` are mutually exclusive (supplying both errors)                                                                                             |

All six shell-out tools (`build_dataset`, `validate_dataset`, `generate_dataset`,
`diff_datasets`, `dataset_report`, `recommend_build`) set the MCP
**`isError` flag** when the
underlying subprocess exits nonzero, times out, or fails to spawn — an agent
branching on `isError` can trust it. The spawned child is also killed when the
client cancels or times out the request (no orphaned `stt-optimize`/`stt-build`
processes).

The always-available `search_docs` and `get_doc` tools search and read the
published documentation corpus configured by `--docs-root`. They perform
in-process file reads and do not require `--allow-cli`.

## Resources

Datasets are also exposed as read-only MCP **resources** (0 tokens until read;
enumerable and cacheable without a tool call):

| URI                     | Content                                                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stt://datasets/<name>` | The same full parsed-manifest payload as `describe_dataset`, as `application/json`. `resources/list` enumerates datasets under `--data-root` (capped at 100 entries with a `_meta` note pointing at `list_datasets` for the full catalog); `<name>` is URL-encoded |
| `stt://docs/<path>`     | One published Markdown page or machine-readable `spec/*.json` schema from `--docs-root`; use `search_docs` when the capped resource list does not show the desired path                                                                                            |

`view_map`'s `@@type` values are the STT layer class names (e.g.
`SpatioTemporalLayer`, `AnimatedTripsLayer`) exported from
`@poopdeck.gl/layers` — a client wanting to actually render the spec
registers those classes in a `@deck.gl/json` `JSONConfiguration`:

```ts
import { JSONConfiguration, JSONConverter } from '@deck.gl/json';
import * as sttLayers from '@poopdeck.gl/layers';

const configuration = new JSONConfiguration({ layers: sttLayers });
const converter = new JSONConverter({ configuration });
const { layers } = converter.convert(spec);
new Deck({ layers, initialViewState: spec.initialViewState });
```

`@@type` inference (when the `layer` param is omitted) prefers a dataset's
build-time `style_hints.layer_hint` (`'points'|'paths'|'trips'|'polygons'`,
confidence `'hint'`), then falls back to its summary-tier scheme
(`H3SummaryLayer` / `QuadbinSummaryLayer`, confidence `'summary'`), then a blind
`AnimatedPointLayer` (confidence `'default'`). **`layer_hint` only exists on
archives built with `--style-hints`** — datasets without it (and without a
summary tier) hit the blind default, so `view_map` returns a `warnings` entry
telling the caller to set `layer` explicitly for path/trip/polygon data (there
is no geometry-kind field in the base manifest to infer from). The `layer` param
overrides inference outright and suppresses that warning.

`buildSystemPrompt()` (also exported for programmatic embedding) renders the
scanned catalog as a short, model-readable block wired into the server's
`instructions` field at startup — so an agent knows what's
available before calling `list_datasets`.

## The `--allow-cli` safety note

`dataset_report`'s CLI mode, `recommend_build`, `diff_datasets`,
`build_dataset`, `generate_dataset`, and `validate_dataset`
shell out to `stt-optimize`/`stt-build`/`stt-generate`/`stt-validate` —
arbitrary local process execution driven by MCP tool-call arguments (which
ultimately come from whatever agent/LLM is talking to this server).
**`--allow-cli` is off by default** for exactly that reason. Of these,
`build_dataset` / `generate_dataset` mutate the filesystem
(and `generate_dataset` also hits the network); the rest are read-only
analyses (still opt-in, because any subprocess execution is). Only enable it
when the MCP client is trusted and the server isn't exposed beyond a single
trusted operator (e.g. local stdio to your own coding agent) — the write tools
in particular can touch anywhere the process has filesystem access, and
`--transport http` with `--allow-cli` on a non-localhost bind is a real risk.
`dataset_report` shells out only when `--allow-cli` is set.
`list_datasets`/`describe_dataset`/`view_map`/`set_time`/`play_pause` and the two
docs tools never shell out at all.

Binary resolution (`--stt-optimize-bin`/`--stt-build-bin`/
`--stt-validate-bin`/`--stt-generate-bin`): an explicit override always wins;
otherwise the server searches `target/release/<name>` walking up from
`--data-root` and the process CWD (this repo's Cargo workspace build output);
otherwise it falls back to the bare command name, resolved via `PATH` (works
once the binaries are `cargo install`ed or otherwise on `PATH`).

## The `poopdeck-ai` plugin (MCP + Skills together)

This server is bundled with a set of Agent Skills as the **`poopdeck-ai`** Claude
Code plugin ([`../../poopdeck-ai/`](../../poopdeck-ai/)). The plugin's `.mcp.json`
auto-registers this server, and `skills/` teaches the workflow — which layer to
use, how to build/tune/serve, and **when to reach for these MCP tools vs the
`stt-*` CLIs**. Install it from the repo-root marketplace
(`/plugin marketplace add <this repo>` → `/plugin install poopdeck-ai`).

The plugin runs `npx -y @poopdeck.gl/mcp` with **no `--allow-cli` and no
`--data-root`**: an installed plugin can't know where a stranger's archives
live, and it must not enable subprocess spawn on their behalf. Point it at data
with `STT_DATA_ROOT`/`--data-root`, and add `--allow-cli` yourself if you want
the build tools (see `poopdeck-ai/README.md`).

**The two configs in this repo differ on purpose:**

| Config                  | Command                         | `--allow-cli` | Why                                                                                                                                               |
| ----------------------- | ------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `poopdeck-ai/.mcp.json` | `npx -y @poopdeck.gl/mcp`       | **no**        | Ships to strangers through the marketplace; must work with no checkout, and must not enable subprocess spawn without a deliberate opt-in.         |
| `.mcp.json` (repo root) | `node packages/mcp/dist/bin.js` | **yes**       | Serves contributors to this tree, who already run `cargo build`/`pnpm test` here — the `stt-*` CLIs _are_ the workflow, so no new trust boundary. |

The repo-root config uses **repo-relative** paths (it is only discovered when
Claude Code is launched from the repo root, so the CWD is the repo root by
construction) and requires `pnpm --filter @poopdeck.gl/mcp build` first, since
`packages/mcp/dist/` is gitignored.

## Docs

- [MCP tools, resources, configuration, and security](../../docs/api/stt-mcp.md)
- [MCP + Agent Skills workflow](../../docs/guides/ai-suite.md)

MIT.

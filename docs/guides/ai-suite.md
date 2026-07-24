# AI Suite: MCP + Agent Skills

The **poopdeck-ai** suite gives an AI coding assistant a surface over the STT
toolchain, so requests like "turn this parquet into an animated map", "why is my
tileset so big", or "my map renders blank" can be acted on and diagnosed rather
than only described.

It ships as one Claude Code plugin bundling two tiers:

- **[`@poopdeck.gl/mcp`](../api/stt-mcp.md)** — an MCP server: the live surface.
  Discover datasets, analyze/lint archives, compose `@deck.gl/json` map specs,
  and (gated) build/validate. Returns structured JSON the agent reasons over.
- **Agent Skills** — the procedural surface: the workflow, the opinions, and
  which CLI or MCP tool to reach for.

## The two surfaces (and why both)

The usual split: if you're explaining how to do something, that's a skill; if the
model needs to access something, that's MCP. Both are here because they carry
different things:

|          | **Skills**                                                                 | **MCP server**                    | **Static (`llms.txt` / docs)** |
| -------- | -------------------------------------------------------------------------- | --------------------------------- | ------------------------------ |
| Carries  | procedure, opinion, guardrails, **routing**                                | live introspection, actions, data | frozen reference               |
| Invoked  | model-invoked by its `description`                                         | tool call                         | manually pointed-at            |
| Cost     | ~100 tok idle, <5k on trigger                                              | tool defs load up front           | crawl-time                     |
| Best for | multi-step workflows, "which layer / which tool", consistency-critical ops | real-time state, mutating actions | cheap fallback                 |

The arrangement follows Cloudflare's `wrangler` skill, which routes between its
MCP server and its CLI: here the `stt-*` Rust CLIs are the CLI, the MCP server is
the live surface, and the skills route between them.

## Install (Claude Code plugin)

The repo root is a plugin marketplace. From a checkout:

```
/plugin marketplace add /path/to/spatiotemporal-tiles
/plugin install poopdeck-ai
```

The bundled `.mcp.json` launches the built server over stdio, scanning
`examples/showcase/public/data` for datasets. Build the server once first:

```bash
pnpm --filter @poopdeck.gl/mcp build
```

Once `@poopdeck.gl/mcp` is published to npm you can switch the command in
`.mcp.json` to `npx -y @poopdeck.gl/mcp` and drop the local build step.

### What you get out of the box

The bundled `.mcp.json` launches the server with **`--allow-cli`** — a locally
installed, stdio-only plugin the user deliberately enabled — so all thirteen
tools are live. Seven of them are read-only and shell nothing out:

- `list_datasets`, `describe_dataset` — discover + inspect archives (manifest only).
- `view_map` — compose a `@deck.gl/json` spec for one or more datasets.
- `set_time` / `play_pause` — structured playback intents.
- `stt://datasets/<name>` **resources** — the manifest payload, enumerable/cacheable.
- `search_docs` / `get_doc` + `stt://docs/<path>` **resources** — the published
  STT documentation, searchable and readable in-band. The corpus is **bundled with
  the package**, so an `npx @poopdeck.gl/mcp` install serves docs with no repo on
  disk (point elsewhere with `--docs-root`).

The other six — `recommend_build`, `diff_datasets`, `dataset_report`,
`validate_dataset`, `build_dataset`, `generate_dataset` — shell out to the
`stt-*` binaries (resolved from `target/release/` or `PATH`); of those only
`generate_dataset` touches the network.

> **Security:** `--allow-cli` lets the MCP client spawn the `stt-*` binaries,
> which read and write the filesystem (and, for `generate_dataset`, fetch over
> the network). That's the intended behavior for a trusted local stdio session.
> **Remove `--allow-cli` from the server args in `.mcp.json` for a read-only,
> no-shell-out setup** — the three execution tools (`build_dataset`,
> `validate_dataset`, `generate_dataset`) then don't register at all, and the
> three analysis tools return an "enable `--allow-cli`" hint (or, for
> `dataset_report`, a manifest-only summary) instead of running. Do **not**
> pair `--allow-cli` with a non-localhost HTTP transport on an untrusted
> network.

See the [MCP reference](../api/stt-mcp.md#the---allow-cli-safety-note) for the
full tool table and the safety model.

## The skills

Ten skills ship in the plugin, each mapped to a job-to-be-done. They fire on
their `description` (model-invoked), pull deeper reference from this `docs/` tree
on demand, and route to the matching MCP tool or CLI.

| Skill                     | Fires when…                                                   | Routes to                                            |
| ------------------------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| `poopdeck-overview`       | any poopdeck.gl / STT work — the **router**                   | the right CLI, package, MCP tool, or sibling skill   |
| `installing-poopdeck`     | cold start — no CLIs, no packages, no first render            | the `stt-*` CLIs, `@poopdeck.gl/*` + deck.gl `9.3.x` |
| `building-stt-datasets`   | turn **your own** GeoParquet / PostGIS / DuckDB into a `.stt` | `recommend_build` → `stt-build`                      |
| `generating-stt-datasets` | you want a bundled **reference** dataset to test with         | `generate_dataset` → `stt-generate`                  |
| `tuning-stt-tiles`        | shrink / lint / publish an archive                            | `dataset_report`, `diff_datasets`                    |
| `wiring-deckgl-layers`    | pick the right STT layer, compose a `@deck.gl/json` spec      | `view_map`                                           |
| `debugging-blank-renders` | a map renders blank / empty                                   | `describe_dataset`, `validate_dataset`               |
| `choosing-a-renderer`     | deck vs three vs maplibre vs cesium — which backend?          | `@poopdeck.gl/{three,maplibre,cesium}`               |
| `adding-playback`         | add a clock, scrubber, or autoplay to a render                | `@poopdeck.gl/playback` + `/react`, `set_time`       |
| `serving-and-publishing`  | ship it — dynamic tile server vs static object store          | `stt-serve`, R2 / S3 / GCS / nginx                   |

Three of them carry project rules that are not derivable from the code:

- `tuning-stt-tiles` — the no-thinning rule: never drop or aggregate features to
  hit a byte budget; clamp the zoom range and coarsen the temporal bucket
  instead.
- `debugging-blank-renders` — the failure taxonomy for empty maps: the
  time-window trap, the summary-tier cell-id defect, capability mismatches.
- `serving-and-publishing` — the hosting rules: cross-origin Range requests need
  CORS exposing `Content-Range`; content-addressed packs cache forever while the
  manifest must not; a republish copies and never sync-with-deletes, with the old
  packs garbage-collected later behind a retention window.

## Using it — worked flows

**Build a dataset.** "Turn `storm-tracks.parquet` into an animated `.stt`." →
the `building-stt-datasets` skill fires and calls `recommend_build` first, which
runs `stt-optimize recommend` and returns an evidence-backed recipe (e.g.
`--min-zoom 9 --max-zoom 10 --temporal-bucket 1m --style-hints`) plus a ready-to-
run `stt-build` command. With `--allow-cli` on, `build_dataset` then runs it and
`validate_dataset` confirms the result.

**Tune for publish.** "This tileset is 40 MB — make it smaller." →
`tuning-stt-tiles` runs `dataset_report` (`inspect` + `doctor` severity-ranked
findings + `order-audit`), re-encodes with the evidence-backed levers, and gates
the change with `diff_datasets` — checking bytes went _down_ and the feature
count did **not** (a negative feature delta is a regression, not a win).

**Put it on a map.** "Show me the hurricanes dataset." → `wiring-deckgl-layers`
→ `view_map` composes a `@deck.gl/json` spec, inferring `AnimatedTripsLayer` from
the archive's `style_hints.layer_hint`, with `currentTime` inside the dataset's
real time range.

**Debug a blank render.** "My STT map is blank." → `debugging-blank-renders`
walks the failure classes: `describe_dataset` for the time range and
capabilities, `validate_dataset` for archive integrity, and the summary-tier /
layer-`@@type` checks — most are diagnosable from the archive alone, before
touching renderer code.

## Beyond Claude Code

**Standalone MCP server.** `@poopdeck.gl/mcp` runs on its own against any MCP
client (Claude Desktop, or a remote Streamable-HTTP host) — see the
[MCP reference](../api/stt-mcp.md#mcp-client-config). No plugin required.

**Portable skills.** The skills are authored to the
[agentskills.io](https://agentskills.io) open standard (portable `name` +
`description` frontmatter), so they also load in Codex, Gemini CLI, Cursor, and
other skill-aware harnesses — not just Claude Code.

**Static tier.** [`llms.txt`](https://github.com/BertCh/spatiotemporal-tiles/blob/main/llms.txt)
at the repo root is the cheap fallback: a curated index of the docs for any agent
that can only be pointed at a URL.

## Security model

Field defaults, enforced by the _server/operator_, not the model:

- **Read-only by default.** Mutating and shell-out tools are absent (or inert)
  until `--allow-cli`.
- **Least privilege.** `--data-root <dir>` roots the server to one tree; no
  arbitrary filesystem or shell.
- **Gated shell-outs.** Execution tools run known `stt-*` binaries with validated
  argument arrays — no shell string interpolation — and the child is killed on
  client cancel/timeout.
- **HTTP hardening.** DNS-rebinding Host/Origin allow-lists; stateless sessions.
  Don't expose `--transport http --allow-cli` on a non-localhost bind.

## Further reading

- [`@poopdeck.gl/mcp` reference](../api/stt-mcp.md) — the full tool/flag surface.
- [CLI reference](../api/cli-reference.md) — the `stt-*` commands the suite drives.
- [Tuning your tiles](./tuning-tiles.md) and [Deploying a dataset](./deploying.md)
  — the workflows the skills encode.
- [Choosing a layer & backend](../intro/choosing.md) and the
  [SpatioTemporalLayer](../api/spatiotemporal-layer.md) doc — what `view_map`
  composes.
- Design record (rationale, SoTA survey, phased plan):
  [`ai-suite-skills-mcp-2026-07.md`](https://github.com/BertCh/spatiotemporal-tiles/blob/main/docs/roadmap/ai-suite-skills-mcp-2026-07.md).

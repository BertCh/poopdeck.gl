# @poopdeck.gl/mcp

## 0.7.0

## 0.6.0

### Minor Changes

- Understand packed `formatVersion: 3` manifests and their required variant
  registry when inspecting datasets and composing views. The server retains the
  reader-facing v2 compatibility behavior documented by the core toolchain.

### Patch Changes

- Generate the MCP `serverInfo.version` from `package.json` at build time. This
  fixes the 0.5.0 tarball reporting `0.4.0` during initialization and adds a
  contract test so the generated value cannot drift again.

## 0.5.0

The first published tarball. This package had lived in the monorepo since the AI
suite landed (2026-07-07), versioned in lockstep with its `@poopdeck.gl` siblings
(the changesets `fixed` group), but nothing was released until 0.5.0 — so this
file starts here rather than inventing a history. The entry below describes the
surface as it stands, not a shipped diff.

> Known defect in the 0.5.0 tarball: the server reports `0.4.0` in its MCP
> `initialize` response (`serverInfo.version`) — a hand-written constant that was
> never bumped. Fixed for the next release: the version is now generated from
> `package.json` at build time (`scripts/gen-version.mjs`) and gated by
> `test/version.test.ts`.

### Minor Changes

- Initial release of `@poopdeck.gl/mcp` and its `stt-mcp` binary: an open,
  self-hostable MCP (Model Context Protocol) server for SpatioTemporal Tiles.
  It runs against a local directory of packed STT archives — no account, no
  hosted service, no network dependency beyond the datasets themselves.
  Dependencies are `@modelcontextprotocol/sdk` and `zod`, nothing else.

- **13 tools**, in five families:
  - _Discovery / analysis_ — `list_datasets`, `describe_dataset`,
    `dataset_report`.
  - _Documentation_ — `search_docs`, `get_doc`.
  - _Build advice_ — `recommend_build`, `diff_datasets`.
  - _Presentation_ — `view_map`, `set_time`, `play_pause`.
  - _Execution_ — `build_dataset`, `validate_dataset`, `generate_dataset`.

- **`--allow-cli` gate, off by default.** Six tools shell out to the Rust CLIs.
  `build_dataset` / `validate_dataset` / `generate_dataset` are registered
  _only_ under `--allow-cli`, so a default server never advertises them;
  `dataset_report` / `recommend_build` / `diff_datasets` always register (they
  are the discoverable entry points) and self-gate at call time —
  `dataset_report` degrades to a manifest-only summary, the other two return an
  explanatory error. `generate_dataset` is the only tool that touches the
  network. The flag also gates the escape hatch for archives outside
  `--data-root` (`view_map`'s `paths`, `dataset_report`'s `path`).

- **`view_map` composes a `@deck.gl/json` spec** for one or more datasets —
  `{layers: [{"@@type": …, data: <manifest URL>, …}], initialViewState}`. The
  `@@type` is inferred from the manifest's `style_hints.layer_hint` or its
  summary-tier scheme; an optional `intent`
  (density/tracking/flow/magnitude/choropleth/exploratory) plus
  `colorBy`/`timeWindow` derive the presentation from measured percentiles and
  the archive's temporal grain. The input schema is strict, so a misspelled
  parameter errors instead of being silently dropped. `set_time` /
  `play_pause` return structured playback _intents_ for a client to apply —
  this server drives no renderer of its own.

- **Resources.** Datasets and docs are also addressable as read-only,
  enumerable URIs — `stt://datasets/<name>` (the parsed manifest, same payload
  as `describe_dataset`) and `stt://docs/<path>` — costing zero tokens until
  read. Both `list` callbacks are capped; `list_datasets` and `search_docs` are
  the paging-capable paths to the full catalog.

- **Two transports.** `stdio` (default, for a client-spawned server) and
  stateless Streamable HTTP (`--transport http`), the latter behind a
  DNS-rebinding guard with `Host`/`Origin` allow-lists that default to the bind
  host plus loopback and extend via `--allowed-host` / `--allowed-origin`.

- **Bundled documentation corpus.** The build copies `docs/README.md` plus every
  `*.md` directly under `docs/{intro,architecture,spec,api,guides}` into the
  package, so an `npx @poopdeck.gl/mcp` install serves `search_docs` / `get_doc`
  / `stt://docs/*` with no repo on disk. `docs/roadmap/` is excluded.

- **Dataset discovery reads `manifest.json` only.** Any directory under
  `--data-root` containing one counts as a dataset (AV-cockpit bundles nest a
  level deeper — `<scene-id>/lidar/`, `<scene-id>/objects/`, each its own
  dataset). Pack and tile bytes are never opened by this server.

- **Programmatic entry point.** `createSttMcpServer` plus the catalog
  (`scanDatasets`, `describeDataset`, `readManifest`), docs (`listCorpusDocs`,
  `searchDocs`, `readDoc`), and view-map (`buildViewMap`, `inferLayerType`)
  helpers are exported for embedding the server or reusing its pieces.

- Ships as the MCP half of the `poopdeck-ai` Claude Code plugin, alongside the
  Agent Skills in `poopdeck-ai/skills/`. Requires Node >= 20.

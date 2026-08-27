# SpatioTemporal Tiles documentation

SpatioTemporal Tiles (STT) is an open format and toolchain for streaming vector
features by map viewport and time window. The Rust tools build, inspect,
validate, bundle, and serve STT data. The `@poopdeck.gl/*` packages read,
render, and work with it in web applications and AI tools.

The two live in separate repositories — [spatiotemporal-tiles][stt-repo] for the
format and the toolchain, [poopdeck.gl][pd-repo] for the renderers and this
site — and meet at the archive on disk. This index covers both, because a reader
needs both. Many pages are authored upstream and vendored here — the format
specification, the CLI reference, the format architecture pages, and most of the
intro and guides — so there is exactly one copy to read and one to edit.
`.stt-sync.json` is the exact list; the two `docs/spec/` files it omits, the
capability matrix and the render-kernel contract, are owned here.

[stt-repo]: https://github.com/BertCh/spatiotemporal-tiles
[pd-repo]: https://github.com/BertCh/poopdeck.gl

New to the project? Follow these in order:

1. Get an animated map running in five minutes with the
   [quickstart](./intro/quickstart.md) — React or vanilla JS, against a hosted
   dataset.
2. [Choose whether STT fits](./intro/choosing.md).
3. Read the [core concepts](./intro/concepts.md).
4. Build and display your own data with the
   [CSV quickstart](./guides/csv-quickstart.md).
5. Check [status, support, and compatibility](./intro/status-and-support.md)
   before adopting a pre-1.0 API or alternate renderer.

The [glossary](./intro/glossary.md) defines project names and format terms.

## Build data

- [CLI reference](./api/cli-reference.md) — canonical commands and flags for
  `stt-build`, `stt-optimize`, `stt-validate`, `stt-bundle`, `stt-serve`, and
  the repository-only `stt-generate`.
- [CSV quickstart](./guides/csv-quickstart.md) — CSV → GeoParquet → archive →
  animated React map.
- [Python guide](./guides/python.md) — GeoPandas, DuckDB, and pyarrow input
  workflows.
- [Data generation](./guides/data-generation.md) — `stt-generate` for the
  bundled reference datasets (it builds only from the [STT
  repository][stt-repo]) and `stt-build` for your own;
  [`stt-generate-datasets.json`](./spec/stt-generate-datasets.json) is its
  machine-readable dataset list.
- [Tile tuning](./guides/tuning-tiles.md) — measure, interpret, and decide with
  `stt-optimize`, without silently dropping data.

Default and `--auto` builds preserve every usable feature. A summary tier is an
explicit coarse-zoom addition, not a replacement for the raw tier — those are
the only two variant kinds the manifest schema admits.

## Render and play

- [SpatioTemporalLayer](./api/spatiotemporal-layer.md) — primary deck.gl layer,
  tile lifecycle, and the base class the whole layer catalog extends;
  [extension compatibility](./api/extensions.md) routes into the deck.gl
  catalog.
- [Choose a backend and layer](./intro/choosing-a-renderer.md) — short decision tables for
  deck.gl, Three.js, MapLibre, and the experimental Cesium source tree.
- [Backend capability matrix](./spec/backend-capabilities.md) — generated from
  each backend's `BackendDescriptor`; authoritative for which layer kinds and
  capabilities a backend actually has.
- [Tile decoding](./api/stt-loader.md) and
  [SpatioTemporalTileset](./api/spatiotemporal-tileset.md) — Range loading,
  decoding, selection, caching, and prefetch.
- [SttPlayer](./api/stt-player.md) — recommended clock and buffering facade.
- [React integration](./api/stt-react.md) — playback hooks and controls.
- Coarse-zoom aggregation — [H3SummaryLayer](./api/h3-summary-layer.md) and
  [QuadbinSummaryLayer](./api/quadbin-summary-layer.md) render an archive's
  built summary tier;
  [AnimatedHexagonLayer](./api/animated-hexagon-layer.md) bins raw features in
  the client.

The deck.gl packages target the repository-pinned 9.3.x line.

## Deploy and operate

- [Deploying archives](./guides/deploying.md) — object storage, cache policy,
  CORS, and safe publication order.
- [`stt-serve` protocol](./spec/stt-serve-protocol.md) — dynamic service routes,
  response headers, and metadata.
- [Export](./guides/export.md) — read a built archive back out to GeoParquet 1.1
  with `stt-optimize export`.
- [WebAssembly](./guides/wasm.md) — optional decoder build and integration.

## Architecture

- [System overview](./architecture/system-overview.md) — end-to-end build,
  storage, loading, and rendering pipeline.
- [Packed archive performance](./architecture/archive-format-performance.md) —
  layout and generation decisions.
- [deck.gl integration](./architecture/deckgl-integration.md) — how
  `SpatioTemporalLayer` maps onto, and departs from, deck.gl's `TileLayer`.
- [Render kernel](./api/render-kernel.md) — shared renderer-independent logic;
  [`render-spec.json`](./spec/render-spec.json) freezes the time-filter op-set
  every backend's hand-written shader must reproduce.

## Normative specification

- [Packed format](./spec/stt-packed-format.md) and
  [manifest schema](./spec/manifest.schema.json)
- [Time model](./spec/time-model.md) and
  [tile matrix set](./spec/tile-matrix-set.json)
- [Tile payload](./architecture/data-format.md)
- [Sidecar assets](./spec/sidecar-assets.md), the
  [scene schema](./spec/scene.schema.json), and the
  [AV palette contract](./spec/av-palettes.json)
- [Conformance](./spec/conformance.md)

The specification is authoritative for wire behavior. Current writers emit
packed format v3 and directory codec v6. Reference readers additionally accept
format v2 with directory v5 read-only.

## AI integration

- [AI suite guide](./guides/ai-suite.md) — the `poopdeck-ai` plugin, its ten
  skills, the MCP server, and the security model.
- [`@poopdeck.gl/mcp`](./api/stt-mcp.md) — dataset discovery, analysis, map
  composition, and gated CLI operations.

The repository's [`AGENTS.md`](../AGENTS.md) is the orientation and routing
document for coding agents. Published retrieval indexes are available at
[poopdeck.gl/llms.txt](https://poopdeck.gl/llms.txt) and
[poopdeck.gl/llms-full.txt](https://poopdeck.gl/llms-full.txt).

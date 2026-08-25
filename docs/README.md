# SpatioTemporal Tiles documentation

SpatioTemporal Tiles (STT) is an open format and toolchain for streaming vector
features by map viewport and time window. The Rust tools build, inspect,
validate, bundle, and serve STT data. The `@poopdeck.gl/*` packages read,
render, and work with it in web applications and AI tools.

New to the project? Follow these in order:

1. [Choose whether STT fits](./intro/choosing.md).
2. Read the [core concepts](./intro/concepts.md).
3. Build and display data with the
   [CSV quickstart](./guides/csv-quickstart.md).
4. Check [status, support, and compatibility](./intro/status-and-support.md)
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
- [Data generation](./guides/data-generation.md) — rebuild the bundled showcase
  datasets with `tools/stt-generate`.
- [Tile tuning](./guides/tuning-tiles.md) — analyze and improve archive layout
  without silently dropping data.

Default and `--auto` builds preserve every usable feature. Summary and raster
tiers are explicit coarse-zoom additions, not replacements for the raw tier.

## Render and play

- [SpatioTemporalLayer](./api/spatiotemporal-layer.md) — primary deck.gl layer
  and tile lifecycle.
- [Choose a backend and layer](./intro/choosing.md) — short decision tables for
  deck.gl, Three.js, MapLibre, and the experimental Cesium source tree.
- [Backend capability matrix](./spec/backend-capabilities.md) — generated,
  authoritative feature comparison.
- [STT archive reader](./api/stt-loader.md) and
  [SpatioTemporalTileset](./api/spatiotemporal-tileset.md) — Range loading,
  decoding, selection, caching, and prefetch.
- [SttPlayer](./api/stt-player.md) — recommended clock and buffering facade.
- [React integration](./api/stt-react.md) — playback hooks and controls.
- [Layer base class](./api/spatiotemporal-layer.md) and
  [extension compatibility](./api/extensions.md) — routes into the complete
  deck.gl catalog.

The deck.gl packages target the repository-pinned 9.3.x line.

## Deploy and operate

- [Deploying archives](./guides/deploying.md) — object storage, cache policy,
  CORS, and safe publication order.
- [`stt-serve` protocol](./spec/stt-serve-protocol.md) — dynamic service routes,
  response headers, and metadata.
- [Export](./guides/export.md) — move data out of STT-compatible workflows.
- [WebAssembly](./guides/wasm.md) — optional decoder build and integration.

## Architecture

- [System overview](./architecture/system-overview.md) — end-to-end build,
  storage, loading, and rendering pipeline.
- [Packed archive performance](./architecture/archive-format-performance.md) —
  layout and generation decisions.
- [Tile payload](./architecture/data-format.md) — Arrow IPC and GeoArrow layer
  frames.
- [deck.gl integration](./architecture/deckgl-integration.md) — relationship to
  deck.gl's tile lifecycle.
- [Render kernel](./api/render-kernel.md) — shared renderer-independent logic.

## Normative specification

- [Packed format](./spec/stt-packed-format.md) and
  [manifest schema](./spec/manifest.schema.json)
- [Time model](./spec/time-model.md) and
  [tile matrix set](./spec/tile-matrix-set.json)
- [Tile payload](./architecture/data-format.md)
- [Sidecar assets](./spec/sidecar-assets.md) and
  [scene schema](./spec/scene.schema.json)
- [Conformance](./spec/conformance.md)

The specification is authoritative for wire behavior. Current writers emit
packed format v3 and directory codec v6. Reference readers additionally accept
format v2 with directory v5 read-only.

## AI integration

- [AI suite guide](./guides/ai-suite.md) — the `poopdeck-ai` plugin, MCP server,
  skills, and security model.
- [`@poopdeck.gl/mcp`](./api/stt-mcp.md) — dataset discovery, analysis, map
  composition, and gated CLI operations.

The repository's [`AGENTS.md`](../AGENTS.md) is the orientation and routing
document for coding agents. Published retrieval indexes are available at
[poopdeck.gl/llms.txt](https://poopdeck.gl/llms.txt) and
[poopdeck.gl/llms-full.txt](https://poopdeck.gl/llms-full.txt).

# SpatioTemporal Tiles (STT)

> Stream full-fidelity vector data by map viewport **and** time window from a
> static host or live database.

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)
[![MSRV](https://img.shields.io/crates/msrv/spatiotemporal-tiles?label=msrv)](./Cargo.toml)

**STT** is the open format and Rust toolchain. **poopdeck.gl** is the TypeScript
rendering ecosystem and [live showcase](https://poopdeck.gl). Together they
turn GeoParquet, PostGIS, or DuckDB data into interactive points, paths,
polygons, trips, flows, and events over time.

An archive is a small `manifest.json`, a compact directory, and immutable,
content-addressed packs. A client requests only the spatial tiles and time
buckets it needs; ordinary HTTP Range support and CDN caching are enough for a
static deployment.

## Is STT a fit?

Choose STT when you need to:

- animate or scrub large **vector** datasets without loading the full history;
- publish immutable data to object storage or a CDN;
- serve the same archive to deck.gl, Three.js, or MapLibre applications; or
- build tiles dynamically from PostGIS or DuckDB with the same client contract.

Choose another format when your data is a time-varying raster or datacube (use
GeoZarr or COG), a small GeoJSON file already performs well, or you need edits
to individual records rather than immutable published snapshots. See
[Choosing STT](./docs/intro/choosing.md) for a fuller decision guide.

## Quick start

The fastest complete tutorial is
[CSV to an animated map](./docs/guides/csv-quickstart.md).

### Build and validate an archive

```bash
cargo install spatiotemporal-tiles

stt-build \
  --input data.parquet \
  --output tiles \
  --time-field timestamp \
  --time-format unix-ms \
  --min-zoom 0 \
  --max-zoom 8 \
  --temporal-bucket 1h

stt-validate tiles
```

Use `stt-build --auto` when you want the toolchain to recommend the zoom range,
temporal bucket, and compression. Explicit flags still win.

Builds preserve every usable feature by default. STT does **not** silently
sample, thin, or aggregate data to meet a byte target. Control size first with
an honest maximum zoom and temporal bucketing. Summary and raster tiers are
explicit, coarse-zoom additions; they do not replace the raw tier.

The installed package provides five CLIs:

| Command        | Purpose                                                |
| -------------- | ------------------------------------------------------ |
| `stt-build`    | Build packed archives from GeoParquet/PostGIS/DuckDB   |
| `stt-optimize` | Analyze inputs and inspect, lint, or compare archives  |
| `stt-validate` | Verify integrity, schemas, decoding, and time metadata |
| `stt-bundle`   | Pack or unpack a single-file `.sttb` interchange file  |
| `stt-serve`    | Serve STT tiles dynamically from a live database       |

`stt-generate` is a separate, repository-only tool for rebuilding showcase
datasets; it lives in [`tools/stt-generate`](./tools/stt-generate).

### Render it

```bash
npm install @poopdeck.gl/layers @poopdeck.gl/playback deck.gl
```

```typescript
import { Deck } from '@deck.gl/core';
import { AnimatedPointLayer } from '@poopdeck.gl/layers';
import { SttPlayer } from '@poopdeck.gl/playback';

const player = new SttPlayer({
  timeRange: { start, end },
  baseRate: (end - start) / 60_000,
  loop: true,
});

const layer = new AnimatedPointLayer({
  id: 'events',
  data: 'https://tiles.example.com/events/manifest.json',
  timeController: player.timeController,
  timeWindow: 86_400_000,
  onTilesetReady: (tileset) => player.setSource(tileset),
  onBufferChange: (runway) => player.notifyBufferChange(runway),
});

new Deck({ layers: [layer] });
player.play();
```

`SttPlayer` connects the clock to the loading runway so playback buffers instead
of skipping unloaded time. See the
[player](./docs/api/stt-player.md) and
[layer](./docs/api/spatiotemporal-layer.md) references for the complete API.

## How the pieces fit

```text
GeoParquet / PostGIS / DuckDB
            │
            ├─ stt-build ──────> static packed archive ──> CDN/object storage
            └─ stt-serve ──────> dynamic tile endpoint
                                      │
                                      v
                            @poopdeck.gl/core
                                      │
                    deck.gl / Three.js / MapLibre
                                      │
                              playback + React UI
```

The archive manifest is the contract. It declares the temporal model,
capabilities, pack table, and optional style hints; clients should inspect it
rather than infer dataset behavior. Packs and directories are content-addressed
and must never be rewritten in place.

## Project status

The current release line is **0.6.0** and remains pre-1.0. Writers produce
packed format v3 with directory codec v6; reference readers also open published
format-v2/directory-v5 archives read-only. The deck.gl integration targets the
pinned 9.3.x line.

Seven `@poopdeck.gl/*` packages are published: `core`, `layers`, `playback`,
`react`, `three`, `maplibre`, and `mcp`. The Cesium backend is private,
source-only, and experimental. See
[Status, support, and compatibility](./docs/intro/status-and-support.md) before
depending on a pre-1.0 API or alternate renderer, and the
[project changelog](./CHANGELOG.md) before upgrading.

## Documentation

- [Documentation index](./docs/README.md)
- [Core concepts](./docs/intro/concepts.md)
- [Choose a deployment, backend, and layer](./docs/intro/choosing.md)
- [System overview](./docs/architecture/system-overview.md)
- [CLI reference](./docs/api/cli-reference.md)
- [Packed-format specification](./docs/spec/stt-packed-format.md)
- [Deployment guide](./docs/guides/deploying.md)
- [Live demos](https://poopdeck.gl/demos)

AI coding agents should start with [`AGENTS.md`](./AGENTS.md). It contains the
repository map, invariant rules, and routing table to canonical documentation.

## Development and contributing

The root is a Cargo and pnpm workspace. The common verification commands are:

```bash
cargo test --workspace
pnpm install
pnpm --filter @poopdeck.gl/core build
pnpm --filter @poopdeck.gl/core test
pnpm --filter @poopdeck.gl/layers build
```

The showcase generator has its own Rust workspace:

```bash
cargo test --manifest-path tools/stt-generate/Cargo.toml
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before submitting a change. Project
policies cover [support](./SUPPORT.md), [governance](./GOVERNANCE.md), the
[Code of Conduct](./CODE_OF_CONDUCT.md), and private
[security reporting](./SECURITY.md).

## License

MIT © Robert Christie

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

The fastest thing that moves is the
[five-minute Quickstart](./docs/intro/quickstart.md): a hosted dataset, half a
million streaming earthquakes, and an animated map inside an ordinary app — no
account, no tile server, and no Rust toolchain. It comes in React and
vanilla-JS variants, and is the recommended front door.

### Render a hosted dataset

`@poopdeck.gl/*` peer-depends on deck.gl and does **not** install it for you.
Pin the whole deck.gl + luma.gl graph to one 9.3.x minor:

```bash
npm install @poopdeck.gl/layers @poopdeck.gl/playback \
  @deck.gl/core@^9.3 @deck.gl/layers@^9.3 @deck.gl/geo-layers@^9.3 \
  @deck.gl/mesh-layers@^9.3 @deck.gl/aggregation-layers@^9.3 \
  @deck.gl/extensions@^9.3 \
  @luma.gl/core@^9.3 @luma.gl/engine@^9.3
```

```typescript
import { Deck } from '@deck.gl/core';
import { AnimatedPointLayer } from '@poopdeck.gl/layers';
import { SttPlayer } from '@poopdeck.gl/playback';

// A public, CORS-enabled archive: USGS M4.0+ events, 2020-2024.
const DATA = 'https://tiles.poopdeck.gl/data/earthquakes-v2/manifest.json';
const TIME_RANGE = {
  start: Date.parse('2020-01-01T00:00:00Z'),
  end: Date.parse('2024-12-30T23:56:29Z'),
};

const player = new SttPlayer({
  timeRange: TIME_RANGE,
  baseRate: (TIME_RANGE.end - TIME_RANGE.start) / 60_000, // 5 years in ~60 s
  loop: true,
});

const layer = new AnimatedPointLayer({
  id: 'events',
  data: DATA,
  timeController: player.timeController,
  timeWindow: 30 * 86_400_000,
  radius: 'magnitude', // any prop that takes a constant also takes a column
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

### Build your own archive

Your own data is where the Rust toolchain comes in;
[From CSV to an Animated Map](./docs/guides/csv-quickstart.md) is the complete
tutorial. The short version:

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

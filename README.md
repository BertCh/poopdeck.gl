# poopdeck.gl

> Render time-aware vector tiles — points, paths, polygons, trips, flows and
> events over time — in deck.gl, Three.js, MapLibre, or Cesium.

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/@poopdeck.gl/layers?label=%40poopdeck.gl)](https://www.npmjs.com/package/@poopdeck.gl/layers)

**poopdeck.gl** is the TypeScript rendering ecosystem for
[SpatioTemporal Tiles (STT)](https://github.com/BertCh/spatiotemporal-tiles),
the open archive format and Rust toolchain. STT packs a dataset into a static,
content-addressed archive; poopdeck.gl streams the tiles a viewport and time
window actually need, and animates them. This repository is the renderer, the
playback engine, the React bindings, and the [live showcase](https://poopdeck.gl).

The two live apart on purpose. The seam between them is the archive on disk —
a `manifest.json`, a compact directory, and immutable packs — which means a
renderer change never needs a format release, and a format change reaches every
backend at once. See
[the split record](./docs/roadmap/repo-split-2026-08.md) for what that costs and
what it bought.

## Quick start

The fastest thing that moves is the
[five-minute Quickstart](./docs/intro/quickstart.md): a hosted dataset, half a
million streaming earthquakes, and an animated map inside an ordinary app — no
account, no tile server, and no Rust toolchain. It comes in React and
vanilla-JS variants.

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

Your own data is where the **STT toolchain** comes in — a separate install, from
a separate repository:

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

[From CSV to an Animated Map](./docs/guides/csv-quickstart.md) is the complete
tutorial, and the [CLI reference](./docs/api/cli-reference.md) covers all five
commands. Both pages are authored upstream and vendored here (§ below), so the
docs site serves one corpus even though the code lives in two places.

## The packages

| Package                 | What it is                                                             |
| ----------------------- | ---------------------------------------------------------------------- |
| `@poopdeck.gl/core`     | Reads an archive: decode, tileset, prefetch, scheduling, render kernel |
| `@poopdeck.gl/layers`   | The deck.gl backend — the primary renderer                             |
| `@poopdeck.gl/three`    | The Three.js / TSL / WebGPU backend                                    |
| `@poopdeck.gl/maplibre` | Native MapLibre / Mapbox custom layers, with no deck dependency        |
| `@poopdeck.gl/cesium`   | The Cesium backend (private, source-only, experimental)                |
| `@poopdeck.gl/playback` | The clock, the buffer governor, and multi-source coordination          |
| `@poopdeck.gl/react`    | React bindings and playback UI                                         |
| `@poopdeck.gl/mcp`      | An MCP server for dataset discovery and map composition                |

## How the pieces fit

```text
        ─── STT repository ──────────────┐  ─── this repository ───────────
                                         │
GeoParquet / PostGIS / DuckDB            │
            │                            │
            ├─ stt-build ──> packed archive ──> CDN/object storage
            └─ stt-serve ──> dynamic tile endpoint
                                         │            │
                                         │            v
                                         │    @poopdeck.gl/core
                                         │            │
                                         │  deck.gl / Three.js / MapLibre / Cesium
                                         │            │
                                         │    playback + React UI
```

The archive manifest is the contract. It declares the temporal model,
capabilities, pack table, and optional style hints; clients inspect it rather
than infer dataset behavior. Packs and directories are content-addressed and are
never rewritten in place.

## Project status

The current release line is **0.7.0** and remains pre-1.0. Readers open packed
format v3 with directory codec v6, and published format-v2/directory-v5 archives
read-only. The deck.gl integration targets the pinned 9.3.x line.

Seven `@poopdeck.gl/*` packages are published: `core`, `layers`, `playback`,
`react`, `three`, `maplibre`, and `mcp`. The Cesium backend is private,
source-only, and experimental. See
[Status, support, and compatibility](./docs/intro/status-and-support.md) before
depending on a pre-1.0 API or alternate renderer, and the
[project changelog](./CHANGELOG.md) before upgrading.

> Since the 2026-08-26 split, the npm and crates.io version numbers are **not**
> in lockstep. They agree at 0.7.0 by history, not by promise. What relates the
> two stacks is the archive's `formatVersion`, declared in `project-status.json`
> on both sides.

## Documentation

- [Documentation index](./docs/README.md)
- [Core concepts](./docs/intro/concepts.md)
- [Choose a deployment, backend, and layer](./docs/intro/choosing.md)
- [System overview](./docs/architecture/system-overview.md)
- [CLI reference](./docs/api/cli-reference.md)
- [Packed-format specification](./docs/spec/stt-packed-format.md)
- [Deployment guide](./docs/guides/deploying.md)
- [Live demos](https://poopdeck.gl/demos)

Some of those pages are **authored in the STT repository** and vendored here so
poopdeck.gl serves one complete corpus; `.stt-sync.json` is the list, and
`pnpm stt:check` fails if a vendored copy is edited locally. Change them
upstream.

AI coding agents should start with [`AGENTS.md`](./AGENTS.md). It contains the
repository map, invariant rules, and routing table to canonical documentation.

## Development and contributing

The root is a pnpm workspace; there is no Rust toolchain requirement to develop
here.

```bash
pnpm install
pnpm build                 # turbo run build across packages + examples
pnpm test
pnpm typecheck
pnpm lint && pnpm format:check
pnpm project:check         # project-status.json vs the manifests
pnpm stt:check             # vendored artifacts vs upstream (needs STT_REPO or a pinned ref)
```

To co-develop a format change, clone the STT repository beside this one and
point the sync at it:

```bash
git clone https://github.com/BertCh/spatiotemporal-tiles ../spatiotemporal-tiles
STT_REPO=../spatiotemporal-tiles pnpm stt:sync
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before submitting a change. Project
policies cover [support](./SUPPORT.md), [governance](./GOVERNANCE.md), the
[Code of Conduct](./CODE_OF_CONDUCT.md), and private
[security reporting](./SECURITY.md).

## License

MIT © Robert Christie

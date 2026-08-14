---
name: installing-poopdeck
description: >-
  Install the poopdeck.gl / SpatioTemporal Tiles toolchain and scaffold a project
  from scratch — get the stt-* CLIs, add the @poopdeck.gl npm packages with the
  correct deck.gl peer dependencies, and render a first .stt on a map. Use when a
  user is starting fresh, asks "how do I install poopdeck / stt-build", how to add
  @poopdeck.gl/layers to a React/Vite/Next app, which packages to install, how to
  get the CLIs, hits a deck.gl / luma.gl peer-dependency or version mismatch, or
  wants a minimal working setup before wiring layers or building datasets.
license: MIT
metadata:
  version: '0.6.0'
---

# Installing poopdeck.gl & scaffolding a project

Two independent toolchains — install whichever the task needs (usually both):

- **`stt-*` Rust CLIs** — build/optimize/validate/serve `.stt` archives (the
  producer side). Native binaries; installed with `cargo`.
- **`@poopdeck.gl/*` npm packages** — render an archive in the browser (the
  consumer side). Peer-depend on deck.gl.

You do **not** need the CLIs to _render_ an existing/hosted `.stt`, and you don't
need the npm packages to _build_ one. Install for the side you're on.

## Install the CLIs

Everything is behind one crates.io facade crate:

```
cargo install spatiotemporal-tiles
```

That installs five binaries with the light, pure-Rust dependency set:
`stt-build`, `stt-optimize`, `stt-validate`, `stt-bundle`, `stt-serve`
(the PostGIS DB backend is included). Opt-ins:

- **DuckDB input** — heavy C++ build, off by default:
  `cargo install spatiotemporal-tiles --features duckdb`.
- **`stt-generate`** (the bundled reference datasets — earthquakes, drifters,
  GTFS, …) is a **dev/from-source** binary, _not_ part of the facade. Run it from
  a repo checkout: `cargo run -p stt-generate --release -- <dataset>`. See
  **generating-stt-datasets**.

**From-source alternative** (for a repo checkout / unreleased changes):
`cargo build --release` puts the binaries in `target/release/`. The MCP server and
the skills resolve the CLIs from `target/release/` **or** `PATH`, so either works.

Sanity check: `stt-build --help` (or `./target/release/stt-build --help`).

## Install the npm packages

Add the poopdeck package for your job **plus its deck.gl peers** — this is the step
people get wrong.

| You want to…                                        | Package                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| Render STT layers on a deck.gl map                  | `@poopdeck.gl/layers`                                                             |
| React playback UI (scrub/play controls, clock hook) | `@poopdeck.gl/react`                                                              |
| Framework-free playback engine (governor, prefetch) | `@poopdeck.gl/playback`                                                           |
| Read an archive directly (`STTArchive`, manifest)   | `@poopdeck.gl/core`                                                               |
| Non-deck backends                                   | `@poopdeck.gl/three` (WebGPU/TSL), `@poopdeck.gl/maplibre`, `@poopdeck.gl/cesium` |

`@poopdeck.gl/layers` re-exports what it needs from `core`, so for a deck.gl app you
usually install just `layers` + the deck.gl peers.

### The deck.gl peer matrix (the load-bearing part)

`@poopdeck.gl/layers` declares deck.gl and luma.gl as **peer dependencies**, all
pinned **`>=9.3.0 <10.0.0`**. They are not installed for you. A missing or
out-of-range peer is the #1 cause of a build error or a silently blank map.

```
npm install @poopdeck.gl/layers \
  @deck.gl/core@^9.3 @deck.gl/layers@^9.3 @deck.gl/geo-layers@^9.3 \
  @deck.gl/mesh-layers@^9.3 @deck.gl/aggregation-layers@^9.3 @deck.gl/extensions@^9.3 \
  @luma.gl/core@^9.3 @luma.gl/engine@^9.3
```

For a React app add the React bindings too:
`npm install @poopdeck.gl/react @deck.gl/react@^9.3 react react-dom` (React ≥18).

Rules:

- **Pin the whole deck.gl/luma.gl graph to one 9.3.x minor.** Mixing e.g.
  `@deck.gl/core@9.3` with `@deck.gl/layers@9.2` breaks at runtime, not at install.
- The umbrella `deck.gl@^9.3` package is a convenient shortcut (it pulls the scoped
  `@deck.gl/*` packages), but you still need `@luma.gl/core`/`@luma.gl/engine` in
  range — check `npm ls @luma.gl/core` if anything renders blank.
- pnpm/yarn workspaces: peers resolve from the app, so install the deck.gl set in
  the **app** package, not a shared lib.

If a map renders blank _after_ install, go to **debugging-blank-renders** —
"peer/version mismatch" is one of its first checks.

## Minimal working scaffold (deck.gl)

Point `data` at a `manifest.json` URL. `currentTime` **must fall inside the
dataset's `timeRange`** or nothing draws.

```ts
import { Deck } from '@deck.gl/core';
import { AnimatedPointLayer } from '@poopdeck.gl/layers';

new Deck({
  initialViewState: { longitude: -122.4, latitude: 37.8, zoom: 6 },
  controller: true,
  layers: [
    new AnimatedPointLayer({
      id: 'quakes',
      data: 'https://tiles.example.com/earthquakes/manifest.json', // manifest URL
      currentTime: 1700000000000, // Unix ms, inside the archive's timeRange
      timeWindow: 86_400_000, // 1 day of data around currentTime
    }),
  ],
});
```

Reading the archive object directly (e.g. to discover its `timeRange`/bounds before
picking a `currentTime`):

```ts
import { STTArchive } from '@poopdeck.gl/core';
const archive = new STTArchive({ url: manifestUrl });
```

Which layer + which time/tier/style props → **wiring-deckgl-layers** (or the
`view_map` MCP tool, which composes a `@deck.gl/json` spec for you). Add
scrub/play UI with `@poopdeck.gl/react` (`PlaybackControls`, `usePlayback`,
`useDeckClock`).

## Wire the MCP server / plugin

The `poopdeck-ai` plugin auto-registers the `stt` MCP server via its `.mcp.json`,
which runs the published package (`npx -y @poopdeck.gl/mcp`) — no repo checkout
and no build step. In Claude Code:
`/plugin marketplace add /path/to/spatiotemporal-tiles` →
`/plugin install poopdeck-ai`.

Two things it does **not** do, both deliberate, both fixable with one arg:

- **No dataset root.** Set `STT_DATA_ROOT`, or add
  `"--data-root", "/path/to/archives"` to the server args, or `list_datasets`
  stays empty (the docs tools work regardless — the corpus is bundled).
- **No `--allow-cli`.** The build/generate/validate tools and the CLI mode of
  `dataset_report`/`recommend_build`/`diff_datasets` shell out to the `stt-*`
  binaries, i.e. agent-directed subprocess spawn plus file read/write, so they
  are off until the user adds `"--allow-cli"` themselves. See
  `poopdeck-ai/README.md` § "Enabling the CLI tools".

Working ON this repo is the other case: its root `.mcp.json` runs the local
build with `--allow-cli`, which needs `pnpm --filter @poopdeck.gl/mcp build`
first (`packages/mcp/dist/` is gitignored) and Claude Code launched from the
repo root.

## You're set up when…

- `stt-build --help` runs (CLI side), and/or
- `npm ls @deck.gl/core @luma.gl/core` shows a single `9.3.x` for each (render
  side), and a first layer draws with a `currentTime` inside the archive's range.

Next: **building-stt-datasets** (your data → `.stt`),
**generating-stt-datasets** (bundled demo data), or **wiring-deckgl-layers**
(render it). CLI flag reference: `docs/api/cli-reference.md`.

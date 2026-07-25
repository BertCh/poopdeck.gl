# Minimal poopdeck.gl example

The smallest thing that shows what the format does: **one hosted `.stt` archive,
one animated deck.gl layer, a play button** — about 60 lines of app code in
[`src/App.tsx`](./src/App.tsx).

No dataset to build, no server to run, no API key. The archive is already
deployed at `tiles.poopdeck.gl` and is streamed with HTTP range requests
straight into the browser.

## Run it

```bash
cd examples/minimal
pnpm install --ignore-workspace
pnpm dev            # http://localhost:5180
```

`--ignore-workspace` matters. This directory sits inside the
`spatiotemporal-tiles` pnpm workspace, and without the flag pnpm would fold it
into the monorepo install. The flag makes it resolve `@poopdeck.gl/*` from the
**npm registry**, exactly as it would in your own project — which is the point
of this example. Its own `pnpm-lock.yaml` is committed so the resolution is
reproducible.

With npm or yarn, or from a copy of this folder outside the repo, the plain
`npm install` / `yarn` works with no flag.

To check the production build:

```bash
pnpm build          # tsc --noEmit && vite build
pnpm preview
```

## What you should see

A black world map at zoom 2 centred on the Pacific, sprinkled with orange dots:
every M4.0+ earthquake USGS recorded between 2020 and 2024, drawn in a rolling
30-day window. Within a second or two the Ring of Fire, the Indonesian arc and
the mid-Atlantic ridge draw themselves out of the point cloud — the plate
boundaries are the dataset.

Press **Play** and the five-year catalogue runs past in about a minute. Drag the
scrubber to jump anywhere in the span; tiles for the new playhead stream in on
demand. Pan and zoom while it plays — only the tiles for the current viewport
and time window are ever fetched.

Open the network panel and you will see the whole protocol: one `manifest.json`,
a few `206 Partial Content` reads against `index/…​.sttd` (the tile directory),
then `206`s against `packs/…​.sttp` for the tile blobs themselves. The archive is
46 MB on the server; a first frame costs a small fraction of that.

One console warning is expected and harmless:
`[stt/time-filter] relative time … exceeds 16777216 ms`. This archive is bucketed
by day, so in-tile relative times exceed what a float32 holds to the millisecond;
at a 30-day window the resulting precision is far finer than a visible frame.

## What the code does

| Piece                                  | Role                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `data: '…/manifest.json'`              | The archive URL. The layer opens it, reads the directory, and range-fetches only the tiles it needs.                              |
| `usePlayback()` (`@poopdeck.gl/react`) | Clock + playback governor. The governor holds the playhead back until tiles are buffered, so playback never runs into empty time. |
| `onTilesetReady` / `onBufferChange`    | Hands the layer's tileset to that governor. Without them the clock runs regardless of what has loaded.                            |
| `radius: 'magnitude'`                  | Names a column in the tile; `radiusTransform` maps its value to pixels.                                                           |
| `timeWindow: 30 * DAY`                 | How long a feature stays on screen, in **simulated** time.                                                                        |

## Swapping the dataset

Any packed archive works — point `data` at its `manifest.json` and set
`TIME_RANGE` to the archive's own `metadata.time_range`:

```bash
curl -s https://tiles.poopdeck.gl/data/earthquakes-v2/manifest.json | jq .metadata
```

Other layer types (`AnimatedPathLayer`, `AnimatedTripsLayer`,
`AnimatedPolygonLayer`, `H3SummaryLayer`, …) take the same time props; see
[`examples/showcase`](../showcase/) for one of each, and
[`docs/`](../../docs/) for the full API.

## The one piece of build config

[`vite.config.ts`](./vite.config.ts) keeps the `@poopdeck.gl/*` packages out of
Vite's **dev** dependency pre-bundler. `@poopdeck.gl/core` spawns its tile-decode
web worker with `new Worker(new URL('./tile-decoder.worker.js', import.meta.url))`;
if the pre-bundler rewrites the package into `node_modules/.vite/deps/`, that
relative URL stops resolving and every tile decode fails with `worker crashed`.
Excluding them means their deck.gl imports are discovered late, so the deck.gl
graph is pinned into the first optimize pass alongside. `vite build` needs
neither adjustment.

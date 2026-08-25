# Showcase

Interactive demo of the SpatioTemporal Tile (`.stt`) format, deck.gl
layers (`@poopdeck.gl/layers`), and MapLibre adapters (`@poopdeck.gl/maplibre`) across
dozens of real and synthetic datasets.

## Pages

The route tree is `src/routes.ts` (react-router framework mode).

- `/` — landing page
- `/demos` — the curated gallery; `/demos/:datasetId` — per-demo detail page
  (live embed + editorial body). A dataset with no gallery card redirects to
  the fullscreen viewer.
- `/demo/:datasetId` — single-dataset deck.gl viewer with the time
  controller, the perf HUD, and the `__sttProbe` channel tap
- `/maplibre/:datasetId` — same data rendered through `@poopdeck.gl/maplibre`
- `/cesium/:datasetId` — same data rendered through `@poopdeck.gl/cesium`
- `/how-it-works` — the format/renderer explainer, with live figures
- `/docs` — the repo's `docs/` rendered as the documentation site
  (nav manifest: `src/docs/manifest.ts`)
- `/drive/:sceneId?` — the AV LIDAR cockpit (nuScenes / Argoverse / Waymo /
  comma scene bundles); no `:sceneId` opens `av-synthetic`
- `/worlds/:worldId?` — the world-model scenario gallery (300
  Cosmos-Drive-Dreams scenarios, generated video synced to the playhead)
- `/story/drifters` — scrollytelling ocean-drifter story

`/demo`, `/drive`, `/worlds` and `/story` render outside `SiteChrome`, so they
are chrome-free and never prerendered.

## Data Pipeline

Datasets are built by `stt-generate`, which fetches the source,
normalises it into GeoParquet, and shells out to `stt-build`. The
generators share `tools/stt-generate/src/common.rs` for coordinate
transforms, chrono-based temporal bucketing, and latitude-adjusted
distance math. CSV sources are ingested directly; HTTP sources are
cached under `data/`.

## Registered Datasets

Two files, two jobs — don't confuse them:

- [`src/datasets.ts`](./src/datasets.ts) is the runtime **registry**: id, layer
  kind, source, and per-demo config for every dataset. It drives `/demo/:id`,
  `/drive/:id`, `/maplibre/:id` and `/cesium/:id`, so any id here resolves.
- [`src/content/demoMeta.ts`](./src/content/demoMeta.ts) is the **curation**:
  a dataset gets a `/demos` card if and only if it has a `DEMO_META` entry.
  The gallery is deliberately small (twelve cards, one per idea); the other
  cuts of the same archives are linked from the headline demo's prose and
  still stream at `/demo/:id`. `SHIPPED_DATASET_IDS` in `datasets.ts` is the
  same twelve in navigation order (its first six are the home-page grid), and
  `test/demo-meta-contract.test.ts` fails if the two lists disagree.

Consult those files directly rather than a copy here. The registry spans every
layer kind the project ships, grouped roughly as:

- **Points** — earthquakes, ship traffic, flights, satellites, NYC taxi points
- **Paths & trips** — flight paths/trips, hurricane tracks, NYC taxi
  paths/trips/heads, ocean drifters, ECCO currents, animal migration
- **Polygons & cumulative** — wildfire perimeters, OSM edit "draw"
- **OD & flow** — NYC taxi flows (flow corridors), OD arcs, OD quadbin /
  H3 summary, OD heatmap, BIXI flowmaps (clustered / edge-bundled)
- **3D & space-time cube** — earthquake columns, the NYC taxi cube
- **Composite & domain** — NEXRAD storm radar, the weather suite, the
  volumetric storm-4D composites, the AV cockpit (nuScenes / Argoverse /
  Waymo / comma / synthetic), and the world-model scenario gallery

## Building Locally

```bash
cd examples/showcase
pnpm install
pnpm dev
```

Datasets must be present under `public/data/`. They are NOT committed —
regenerate locally with `stt-generate`.

## Regenerating Datasets

`stt-generate` is a repo-only tool with its own Cargo workspace. Install it
separately from the published CLI bundle; building the root Cargo workspace
does not build the generator.

```bash
# From the repository root, install the published CLIs (including stt-build)
# and the repo-only showcase generator.
cargo install --path crates/spatiotemporal-tiles
cargo install --path tools/stt-generate

# Each dataset is generated explicitly; there is no `all` subcommand.
stt-generate earthquakes \
  --output examples/showcase/public/data/earthquakes.stt
stt-generate hurricanes \
  --output examples/showcase/public/data/hurricanes.stt
stt-generate wildfires \
  --output examples/showcase/public/data/wildfires.stt

# Other generators need per-run parameters, for example:
stt-generate ais --date 2024-01-01 \
  --output examples/showcase/public/data/ais-traffic.stt
stt-generate flights --date 2020-01-06 \
  --output examples/showcase/public/data/flights.stt
stt-generate nyc-rideshare --synthetic \
  --osrm-url http://localhost:5000 \
  --output examples/showcase/public/data/nyc-rideshare.stt
stt-generate satellites \
  --output examples/showcase/public/data/satellites.stt
```

Per-dataset flags vary — run `stt-generate <subcommand> --help`. See the
[Data Generation Guide](../../docs/guides/data-generation.md) for the full
recipes.

## Tech Stack

- **React 19** + **TypeScript** + **Vite** + **react-router** (framework mode)
- **deck.gl 9.3.x** via `@poopdeck.gl/layers`
- **MapLibre GL 3–6** via `@poopdeck.gl/maplibre`
- **`@poopdeck.gl/core`** for the archive reader, decoder pool, and tileset

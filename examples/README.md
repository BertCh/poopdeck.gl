# Example Applications

Two examples, at opposite ends of the scale.

|                             |                                                                             |
| --------------------------- | --------------------------------------------------------------------------- |
| [**minimal**](./minimal/)   | ~60 lines. One hosted archive, one layer, a play button. **Start here.**    |
| [**showcase**](./showcase/) | The full gallery — every layer type, every dataset, every renderer backend. |

---

## [Minimal](./minimal/) — start here

The smallest thing that shows what the format does: one `.stt` archive streamed
from `tiles.poopdeck.gl`, one `AnimatedPointLayer`, playback controls. No
dataset to build, no server to run, no API key.

```bash
cd minimal
pnpm install --ignore-workspace
pnpm dev            # http://localhost:5180
```

Five years of global M4.0+ earthquakes (USGS) animating out of a 46 MB archive
on a CDN bucket. The plate boundaries draw themselves. Press play and the
catalogue runs past in about a minute; pan, zoom or scrub and only the tiles for
that viewport and time window are fetched.

It depends on the **published** `@poopdeck.gl` packages by version, not on
workspace path deps, so it is a faithful copy-paste starting point for your own
project. `--ignore-workspace` is what makes that resolution honest inside this
monorepo — see [`minimal/README.md`](./minimal/README.md) for why, and for the
one piece of Vite config the worker-based tile decoder needs in dev.

---

## [Showcase](./showcase/)

**The full demonstration of STT capabilities.**

An interactive web application showcasing dozens of real and synthetic
datasets across every layer type the project ships. Two files, two jobs: the
full runtime registry (every dataset id, layer kind, source and per-demo
config) is [`showcase/src/datasets.ts`](./showcase/src/datasets.ts), and the
curated twelve-card gallery at `/demos` is
[`showcase/src/content/demoMeta.ts`](./showcase/src/content/demoMeta.ts).
Everything in the registry still renders at `/demo/:id` whether or not it has
a gallery card. Broadly, the registry spans:

- **Points**: earthquakes, ship traffic, flights, satellites, NYC taxi points
- **Paths & trips**: flight paths/trips, hurricane tracks, NYC taxi
  paths/trips/heads, ocean drifters, ECCO currents, animal migration
- **Polygons & cumulative**: wildfire perimeters, OSM edit "draw"
- **OD & flow**: NYC taxi flows, OD arcs, OD quadbin / H3 summary, OD heatmap,
  BIXI flowmaps (clustered / edge-bundled)
- **3D & space-time cube**: earthquake columns, the NYC taxi cube
- **Composite & domain demos**: NEXRAD storm radar, the volumetric storm-4D
  composite, the AV cockpit at `/drive` (nuScenes / Argoverse / Waymo / comma /
  synthetic), and the world-model scenario gallery at `/worlds`

Each demo can also be rendered through the `@poopdeck.gl/maplibre` adapter via
the `/maplibre/:datasetId` route, for the no-deck.gl path.

**Tech stack**: React 19, deck.gl 9.x, TypeScript, Vite,
`@poopdeck.gl/core`, `@poopdeck.gl/layers`, `@poopdeck.gl/maplibre`.

```bash
cd showcase
pnpm install
pnpm dev
```

See [`showcase/README.md`](./showcase/README.md) for dataset details.

---

## Dataset Generation

Datasets are produced by `stt-generate`, which fetches the source,
normalises it into GeoParquet, and shells out to `stt-build`.

```bash
# Build the toolchain
cargo install --path ../tools/stt-generate
cargo install --path ../crates/spatiotemporal-tiles   # stt-build + the other CLIs

# Generate everything into the showcase's public/data
stt-generate all --output-dir showcase/public/data --skip-existing

# Or one at a time
stt-generate earthquakes \
  --start-date 2020-01-01 --end-date 2024-12-31 \
  --min-magnitude 4.0 \
  --output showcase/public/data/earthquakes.stt
```

For arbitrary GeoParquet input, use `stt-build` directly. See the
[Data Generation Guide](../docs/guides/data-generation.md) and
[Building from Python](../docs/guides/python.md).

## Creating Your Own App

Copy [`minimal/`](./minimal/) out of the repo and edit it — that is the fastest
path, and it already carries the correct peer-dependency set. To start from
nothing instead, seven `@poopdeck.gl/*` packages are actively published at
`0.6.0`: `core`, `layers`, `playback`, `react`, `three`, `maplibre`, and `mcp`.
The Cesium backend is experimental: its last npm release is `0.5.0`, and current
development builds only from a workspace checkout.

```bash
mkdir ~/my-stt-app && cd ~/my-stt-app
npm init -y
npm install @poopdeck.gl/layers @poopdeck.gl/react \
  @deck.gl/core@^9.3 @deck.gl/layers@^9.3 @deck.gl/react@^9.3 \
  @deck.gl/geo-layers@^9.3 @deck.gl/mesh-layers@^9.3 \
  @deck.gl/aggregation-layers@^9.3 @deck.gl/extensions@^9.3 \
  @luma.gl/core@^9.3 @luma.gl/engine@^9.3 \
  react react-dom
```

The deck.gl/luma.gl packages are **peer** dependencies of
`@poopdeck.gl/layers`, all pinned `>=9.3.0 <10.0.0`, and are not installed for
you. A missing or out-of-range peer is the most common cause of a blank map.

To work against unreleased changes instead, build the monorepo and link the
workspace packages:

```bash
git clone https://github.com/BertCh/spatiotemporal-tiles
cd spatiotemporal-tiles
pnpm install && pnpm build
# then, from your app:
npm install <path-to>/spatiotemporal-tiles/packages/{core,layers,playback}
```

```typescript
import DeckGL from '@deck.gl/react';
import { AnimatedPointLayer } from '@poopdeck.gl/layers';
import { usePlayback } from '@poopdeck.gl/react';

const TIME_RANGE = { start: 1577836800000, end: 1735602989977 };

function App() {
  const pb = usePlayback({ timeRange: TIME_RANGE });

  const layer = new AnimatedPointLayer({
    id: 'points',
    data: 'https://tiles.poopdeck.gl/data/earthquakes-v2/manifest.json',
    timeController: pb.timeController,
    currentTime: TIME_RANGE.start,
    timeRange: TIME_RANGE,
    timeWindow: 30 * 86_400_000,
  });

  return <DeckGL controller layers={[layer]} />;
}
```

Build your own dataset:

```bash
stt-build \
  --input your-data.parquet \
  --output your-data.stt \
  --time-field timestamp --time-format unix-ms \
  --auto
```

## Resources

- [Main README](../README.md)
- [Documentation](../docs/README.md)
- [API Reference](../docs/api/)
- [Cold-start measurements](../docs/roadmap/measurements-2026-07.md) — what a
  client actually fetches before the first frame
- [deck.gl docs](https://deck.gl)

## License

All examples are MIT licensed.

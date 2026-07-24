# Example Applications

This directory contains example applications demonstrating the
SpatioTemporal Tiles (STT) format.

## [Showcase](./showcase/)

**The primary demonstration of STT capabilities.**

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

## Dataset Generation

Datasets are produced by `stt-generate`, which fetches the source,
normalises it into GeoParquet, and shells out to `stt-build`.

```bash
# Build the toolchain
cargo install --path ../crates/stt-generate
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

All eight `@poopdeck.gl/*` packages are published to npm (0.5.0):
`core`, `layers`, `playback`, `react`, `three`, `maplibre`, `cesium`, `mcp`.

```bash
mkdir ~/my-stt-app && cd ~/my-stt-app
npm init -y
npm install @poopdeck.gl/core @poopdeck.gl/layers @poopdeck.gl/playback @deck.gl/react react react-dom
```

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
import { useState } from 'react';
import DeckGL from '@deck.gl/react';
import { AnimatedPointLayer } from '@poopdeck.gl/layers';
import { TimeController } from '@poopdeck.gl/playback';

function App() {
  const [timeController] = useState(() => new TimeController());

  const layer = new AnimatedPointLayer({
    id: 'points',
    data: 'https://example.com/data.stt',
    timeController,
    timeWindow: 86_400_000,
  });

  return <DeckGL layers={[layer]} />;
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
- [deck.gl docs](https://deck.gl)

## License

All examples are MIT licensed.

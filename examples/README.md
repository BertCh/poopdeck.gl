# Example Applications

This directory contains example applications demonstrating the
SpatioTemporal Tiles (STT) format.

## [Showcase](./showcase/)

**The primary demonstration of STT capabilities.**

An interactive web application showcasing 16 real and synthetic datasets
across every layer type the project ships:

- **Point visualizations**: earthquake activity, ship traffic, flights,
  satellites, NYC taxi points
- **Path & trajectory**: NYC taxi paths, flight paths, hurricane tracks,
  satellite trips, flight trips
- **Animated trips (per-vertex timing)**: NYC taxi trips, NYC taxi VAT
  (vertex-animation-texture variant)
- **Polygon coverage**: wildfire perimeters
- **GPU-splat heatmap**: NYC taxi OD heatmap
- **Server-aggregated H3 summary tier**: NYC taxi OD summary

Each demo can also be rendered through the `@stt/maplibre` adapter via
the `/maplibre/:datasetId` route, for the no-deck.gl path.

**Tech stack**: React 18, deck.gl 9.x, TypeScript, Vite,
`@stt/core`, `@stt/deck.gl`, `@stt/maplibre`.

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
cargo install --path ../crates/stt-build

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

```bash
mkdir my-stt-app && cd my-stt-app
npm init -y
npm install @stt/core @stt/deck.gl @deck.gl/react react react-dom
```

```typescript
import { useState } from 'react';
import DeckGL from '@deck.gl/react';
import { AnimatedPointLayer, TimeController } from '@stt/deck.gl';

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

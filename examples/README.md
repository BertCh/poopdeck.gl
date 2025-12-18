# Example Applications

This directory contains example applications demonstrating the SpatioTemporal Tiles (STT) format.

## Available Examples

### 🎨 [Showcase](./showcase/)

**The primary demonstration of STT capabilities**

An interactive web application showcasing 8+ real-world datasets across different visualization types:

- **Point Visualizations**: Earthquake activity, flight traffic, maritime AIS
- **Path & Trajectory**: Flight paths, NYC taxi routes, hurricane tracks
- **Area Coverage**: Wildfire perimeters

**Tech Stack**: React, deck.gl, TypeScript, Vite

```bash
cd showcase
npm install
npm run dev
```

### 🚀 Coming Soon

#### Climate Visualizer (Vue + deck.gl)
Multi-decade climate data visualization with temporal interpolation.

#### Fleet Manager (React + Mapbox GL)
Real-time vehicle fleet tracking with historical playback.

#### Earthquake Monitor (Vanilla JS)
Minimal implementation showing earthquake activity over time.

## Dataset Generation

Each example includes scripts to generate STT archives from source data:

### Example: Earthquake Dataset

```bash
# Generate earthquake data using stt-generate
stt-generate earthquakes \
  --start-date 2020-01-01 \
  --end-date 2024-12-31 \
  --min-magnitude 4.5 \
  --output earthquakes.stt
```

### Example: AIS Maritime Traffic

```bash
# Download AIS data from NOAA Marine Cadastre
curl -O https://coast.noaa.gov/htdata/CMSP/AISDataHandler/2024/AIS_2024_01_01.zip
unzip AIS_2024_01_01.zip

# Process with stt-generate
stt-generate ais \
  --input AIS_2024_01_01.csv \
  --output ais-traffic.stt \
  --sample-minutes 10
```

## Performance Comparison

| Example | Dataset Size | STT Archive | Initial Load | Animation FPS |
|---------|--------------|-------------|--------------|---------------|
| Earthquake Monitor | 77K features | 119 MB | 200ms | 60 |
| Flight Traffic | 3.96M features | 1 GB | 500ms | 60 |
| AIS Maritime | 1.17M features | 548 MB | 400ms | 60 |
| NYC Taxi | 1.14M features | 142 MB | 250ms | 60 |

*All measurements on Chrome 120, M1 MacBook Pro*

## Development

Each example is a standalone application with its own dependencies:

```bash
# Navigate to example
cd showcase

# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build
```

## Deployment

Examples can be deployed as static sites:

```bash
# Build
npm run build

# Deploy to Vercel
vercel deploy

# Or to Netlify
netlify deploy --prod

# Or to any static host
aws s3 sync dist/ s3://your-bucket --acl public-read
```

## Creating Your Own Example

### 1. Set Up Project

```bash
mkdir my-stt-app
cd my-stt-app
npm init -y
npm install @stt/core @stt/deck.gl @deck.gl/react react react-dom
```

### 2. Create Basic App

```typescript
import { AnimatedPointLayer, TimeController } from '@stt/deck.gl';
import DeckGL from '@deck.gl/react';

function App() {
  const [timeController] = useState(new TimeController());

  const layer = new AnimatedPointLayer({
    id: 'points',
    data: 'https://example.com/data.stt',
    currentTime: timeController.getTime(),
    timeController,
  });

  return <DeckGL layers={[layer]} />;
}
```

### 3. Generate Your Data

```bash
stt-build \
  --input your-data.geojson \
  --output your-data.stt \
  --time-field timestamp \
  --max-zoom 14
```

## Resources

- [STT Documentation](../README.md)
- [API Reference](../docs/api/)
- [Performance Guide](../PERFORMANCE.md)
- [deck.gl Docs](https://deck.gl)

## Contributing

We welcome new examples! Please submit a PR with:

1. Complete, runnable application
2. README with setup instructions
3. Sample dataset or generation script
4. Screenshots/demo GIF

## License

All examples are MIT licensed.

---

**Ready to build your own spatiotemporal visualization? Start with the [Showcase](./showcase/)!**


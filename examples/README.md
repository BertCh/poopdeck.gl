# Example Applications

This directory contains example applications demonstrating the SpatioTemporal Tiles (STT) format.

## Available Examples

### 🎨 [Showcase](./showcase/)

**The primary demonstration of STT capabilities**

An interactive web application showcasing 8+ real-world datasets across different visualization types:

- **Point Visualizations**: COVID-19 cases, earthquake activity
- **Path & Trajectory**: Taxi movements, hurricane tracks, ship routes
- **Density Heatmaps**: Flight density, bike share trips
- **Area Coverage**: Wildfire spread

**Tech Stack**: React, deck.gl, TypeScript, Vite

```bash
cd showcase
npm install
npm run dev
```

### 🚀 Coming Soon

#### COVID Tracker (React + deck.gl)
Real-time COVID-19 case tracking with temporal animation.

#### Climate Visualizer (Vue + deck.gl)
Multi-decade climate data visualization with temporal interpolation.

#### Fleet Manager (React + Mapbox GL)
Real-time vehicle fleet tracking with historical playback.

#### Earthquake Monitor (Vanilla JS)
Minimal implementation showing earthquake activity over time.

## Dataset Generation

Each example includes scripts to generate STT archives from source data:

### Example: COVID-19 Dataset

```bash
# Download source data
curl -O https://github.com/nytimes/covid-19-data/raw/master/us-counties.csv

# Convert to GeoJSON with temporal data
python scripts/covid-to-geojson.py us-counties.csv > covid.geojson

# Generate STT archive
stt-build \
  --input covid.geojson \
  --output covid-cases.stt \
  --time-field date \
  --min-zoom 0 \
  --max-zoom 14 \
  --compression brotli
```

### Example: Taxi Trajectories

```bash
# Download SF taxi data
curl -O https://data.sfgov.org/resource/taxis.json

# Process to trajectory format
python scripts/taxis-to-paths.py taxis.json > sf-taxis.geojson

# Generate STT archive with path optimization
stt-build \
  --input sf-taxis.geojson \
  --output sf-taxis.stt \
  --time-field timestamp \
  --min-zoom 10 \
  --max-zoom 16 \
  --simplification 0.5 \
  --compression brotli
```

## Performance Comparison

| Example | Dataset Size | STT Archive | Compression | Initial Load | Animation FPS |
|---------|--------------|-------------|-------------|--------------|---------------|
| COVID Tracker | 450 MB | 145 MB | 3.6x | 320ms | 60 |
| Taxi Trajectories | 280 MB | 67 MB | 4.2x | 280ms | 60 |
| Earthquake Monitor | 120 MB | 23 MB | 5.1x | 180ms | 60 |
| Climate Viz | 890 MB | 234 MB | 3.8x | 450ms | 58 |

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


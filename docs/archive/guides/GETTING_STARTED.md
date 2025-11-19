# Getting Started with SpatioTemporal Tiles

This guide will help you set up and start using STT.

## Prerequisites

- **Rust** 1.70+ - [Install](https://rustup.rs/)
- **Node.js** 18+ & pnpm - For TypeScript packages
- **Protocol Buffers** (optional) - Only if modifying `.proto` files

```bash
# macOS
brew install protobuf

# Ubuntu/Debian
apt-get install protobuf-compiler
```

---

## Installation

### 1. Clone and Build

```bash
git clone https://github.com/robertchristie/spatiotemporal-tiles.git
cd spatiotemporal-tiles

# Build Rust CLI tools
cargo build --release

# Build TypeScript packages
pnpm install
pnpm build
```

### 2. Verify Installation

```bash
./target/release/stt-build --help
```

---

## Your First STT Archive

### Step 1: Prepare Data

Create `earthquakes.geojson`:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": {
        "type": "Point",
        "coordinates": [-118.2437, 34.0522]
      },
      "properties": {
        "timestamp": "2024-01-01T12:00:00Z",
        "magnitude": 4.5,
        "place": "Los Angeles, CA"
      }
    }
  ]
}
```

### Step 2: Build Tiles

```bash
./target/release/stt-build \
  --input earthquakes.geojson \
  --output earthquakes.stt \
  --time-field timestamp \
  --time-format iso8601 \
  --temporal-resolution sparse-events \
  --compression gzip \
  --max-zoom 6
```

### Step 3: Visualize

```typescript
import { AnimatedPointLayer, TimeController } from "@stt/deck.gl";

const timeController = new TimeController({
  initialTime: Date.parse("2024-01-01"),
  speed: 86400000, // 1 day per second
  loop: true,
});

const layer = new AnimatedPointLayer({
  id: "earthquakes",
  data: "/earthquakes.stt",
  currentTime: timeController.getTime(),
  timeController,
  getFillColor: [255, 0, 0],
  getRadius: 5000,
  radiusUnits: "meters",
});
```

---

## CLI Options

### stt-build

```bash
stt-build \
  --input <FILE>                    # Input file (GeoJSON or CSV)
  --output <FILE>                   # Output STT archive
  --time-field <NAME>               # Field name for timestamp
  --time-format <FORMAT>            # unix-ms, unix-sec, or iso8601
  --temporal-resolution <PROFILE>   # See below
  --compression <TYPE>              # gzip (recommended) or brotli
  --min-zoom <NUM>                  # Default: 0
  --max-zoom <NUM>                  # Default: 14
```

### Temporal Resolution Profiles

| Profile            | Use Case                | Bucket Sizes                           |
| ------------------ | ----------------------- | -------------------------------------- |
| `high-frequency`   | Ships, planes, vehicles | second → minute → hour                 |
| `sparse-events`    | Earthquakes, incidents  | day → week → month                     |
| `daily-aggregates` | Weather, COVID cases    | day → week → month                     |
| Fixed buckets      | Custom intervals        | `hour`, `day`, `week`, `month`, `year` |

---

## Run the Showcase

```bash
cd examples/showcase
pnpm install
pnpm dev
# Open http://localhost:3000
```

The showcase includes earthquake, COVID-19, and hurricane visualizations.

---

## Generate Example Data

```bash
cd scripts/data-generation
cargo build --release

# Earthquakes (USGS API)
../../target/release/generate-earthquake-data

# Convert to STT
../../target/release/stt-build \
  --input data/earthquakes.geojson \
  --output ../../examples/showcase/public/data/earthquakes.stt \
  --time-field timestamp \
  --time-format iso8601 \
  --temporal-resolution sparse-events \
  --compression gzip
```

---

## Next Steps

- Read [ARCHITECTURE.md](./ARCHITECTURE.md) for technical details
- Check [PERFORMANCE.md](./PERFORMANCE.md) for benchmarks
- Explore [examples/showcase/](./examples/showcase/) for code examples
- Review [proto/README.md](./proto/README.md) for format specification

---

## Troubleshooting

### "Error: Time field not found"

Make sure `--time-field` matches your data. Use `timestamp` for GeoJSON from our generators.

### "Tiles load but show at (0,0)"

Check that coordinates are in [lon, lat] order (WGS84). STT expects standard GeoJSON format.

### "No tiles loading in browser"

1. Check browser console for HTTP errors
2. Verify STT file is accessible (check dev server is running)
3. Ensure compression format matches (use gzip for easiest browser support)

---

## Getting Help

- **Issues:** [GitHub Issues](https://github.com/robertchristie/spatiotemporal-tiles/issues)
- **Documentation:** See markdown files in repo root

---

Built with ❤️ using Rust and TypeScript

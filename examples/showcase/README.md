# Showcase Examples

This showcase demonstrates spatiotemporal tile format (STT) with various real and synthetic datasets.

## Updated for Latest Pipeline (Oct 2025)

All datasets have been regenerated with the improved data pipeline:

- ✅ **Standardized projections** - Uses `projection` module for accurate coordinate transformations
- ✅ **Proper temporal bucketing** - chrono-based month/week/year calculations
- ✅ **CSV support** - Can now ingest CSV files directly
- ✅ **Improved coordinate math** - Latitude-adjusted distance calculations for synthetic data

## Available Datasets

### Real Data

**Earthquakes (101 MB)** - USGS seismic events

- 34,521 features, 1,826 temporal frames
- Built with `sparse-events` temporal profile
- Magnitude 4.0+ from Dec 2023 - Oct 2024

**COVID-19 Cases (5.2 MB)** - NYT county data (5 sample counties)

- 3,238 features, 730 temporal frames
- Daily aggregates profile
- Feb 2020 - May 2022

**Hurricane Tracks (4.4 MB)** - NOAA IBTrACS

- 5,219 features, 15,011 temporal frames
- Atlantic hurricanes 2020-2023

### Synthetic Data

**Ships (4.1 MB)** - Simulated AIS maritime traffic

- 84,000 features, 1,246 frames
- High-frequency temporal profile

**Flights (345 KB)** - Simulated ADS-B aircraft positions

- 1,104 features, 831 frames

**SF Taxis (21 MB)** - Simulated taxi trajectories

- 10,000 features, 24 frames
- Improved coordinate math with latitude adjustment

## Building Locally

```bash
# From the project root
cd examples/showcase
pnpm install
pnpm dev
```

Datasets are pre-built and included in `public/data/`.

## Regenerating Datasets

To rebuild with the latest pipeline:

```bash
# Earthquakes (real data)
cd scripts/data-generation
cargo run --bin generate-earthquake-data -- --output earthquakes.geojson
cd ../..
./target/release/stt-build \\
  --input scripts/data-generation/earthquakes.geojson \\
  --output examples/showcase/public/data/earthquakes.stt \\
  --time-field timestamp \\
  --temporal-resolution sparse-events \\
  --compression gzip

# SF Taxis (synthetic)
cd scripts/data-generation
cargo run --bin generate-taxi-data -- --output sf-taxis.geojson
cd ../..
./target/release/stt-build \\
  --input scripts/data-generation/sf-taxis.geojson \\
  --output examples/showcase/public/data/sf-taxis.stt \\
  --time-field timestamp \\
  --temporal-resolution high-frequency \\
  --compression gzip
```

## Performance

All datasets load with HTTP Range Requests:

- Initial metadata: <100ms
- First frame: <200ms
- Frame switching: <16ms (60 FPS)
- Memory: ~180 MB for all datasets

## Tech Stack

- **React 18** - UI framework
- **deck.gl 9.0** - WebGL visualization
- **@stt/core** - Archive reader
- **@stt/deck.gl** - Custom layers
- **Vite** - Build tool

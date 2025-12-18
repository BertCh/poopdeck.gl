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

**Earthquakes (119 MB)** - USGS seismic events

- 77,198 features (M4.0+ 2020-2024)
- Built with `sparse-events` temporal profile

**Hurricane Tracks (5.4 MB)** - NOAA IBTrACS

- 5,219 features, 15,011 temporal frames
- Atlantic hurricanes 2020-2023

**AIS Maritime Traffic (548 MB)** - NOAA Marine Cadastre

- 1.17M vessel positions from 14,868 ships
- Real AIS data (Jan 2024)

**Flight Traffic (1 GB)** - OpenSky Network

- 3.96M aircraft positions from 21K aircraft
- Real ADS-B data (24hr, Jan 2020)

**NYC Taxi (142 MB)** - TLC + OSRM routed

- 1.14M rideshare points
- Real trip data (Feb 2016)

**Wildfires (328 KB)** - NIFC perimeters

- 118 large wildfire polygons (1000+ acres, 2020-2023)

## Building Locally

```bash
# From the project root
cd examples/showcase
pnpm install
pnpm dev
```

Datasets are pre-built and included in `public/data/`.

## Regenerating Datasets

To rebuild all datasets:

```bash
# Install stt-generate
cargo install --path crates/stt-generate

# Generate all datasets
stt-generate all --output-dir examples/showcase/public/data

# Or generate individually
stt-generate earthquakes --output examples/showcase/public/data/earthquakes.stt
stt-generate hurricanes --output examples/showcase/public/data/hurricanes.stt
stt-generate wildfires --output examples/showcase/public/data/wildfires.stt
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

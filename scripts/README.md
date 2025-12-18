# Scripts

Utility scripts for the SpatioTemporal Tiles project.

## Data Generation

Located in [`data-generation/`](./data-generation/), these Rust scripts download and process real-world datasets for the showcase application.

### Quick Start

```bash
# Install the unified stt-generate tool
cargo install --path ../crates/stt-generate

# Generate all datasets
stt-generate all --output-dir ../examples/showcase/public/data

# Or generate individually
stt-generate earthquakes --output earthquakes.stt
stt-generate hurricanes --output hurricanes.stt
stt-generate wildfires --output wildfires.stt
stt-generate ais --input ais.csv --output ais.stt
```

### Available Datasets

- **Earthquakes**: Global seismic activity (USGS API)
- **Hurricanes**: Atlantic hurricane tracks (NOAA IBTrACS)
- **Wildfires**: US wildfire perimeters (NIFC)
- **AIS Maritime**: Ship traffic (NOAA Marine Cadastre)
- **Flights**: Historical flight data (OpenSky Network)
- **NYC Rideshare**: Taxi trajectories (TLC + OSRM)

See [data-generation/README.md](./data-generation/README.md) for detailed documentation.

## Other Scripts *(Coming Soon)*

### Benchmarking

- `benchmark-generation.sh`: Benchmark tile generation performance
- `benchmark-rendering.sh`: Benchmark client-side rendering
- `compare-formats.sh`: Compare STT vs MVT vs PMTiles

### CI/CD

- `check-format.sh`: Verify code formatting
- `run-tests.sh`: Run all test suites
- `generate-docs.sh`: Build documentation

### Deployment

- `deploy-showcase.sh`: Deploy showcase to Vercel
- `upload-datasets.sh`: Upload STT archives to CDN

## Development

All scripts are written in Rust for consistency with the main project. Common utilities are shared in `data-generation/src/common.rs`.

### Adding a New Script

1. Create `src/your-script.rs`
2. Add binary entry to `data-generation/Cargo.toml`
3. Use common utilities for downloads, GeoJSON, etc.
4. Document in README.md

### Testing Scripts

```bash
# Dry run (don't actually download)
cargo run --bin your-script -- --dry-run

# Use cached data
cargo run --bin your-script -- --cached
```

---

**See also**: [Main Documentation](../README.md) | [Architecture](../ARCHITECTURE.md)


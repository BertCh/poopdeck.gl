# Scripts

Utility scripts for the SpatioTemporal Tiles project.

## Data Generation

Located in [`data-generation/`](./data-generation/), these Rust scripts download and process real-world datasets for the showcase application.

### Quick Start

```bash
cd data-generation

# Generate all datasets
./generate-all.sh

# Or generate individually
cargo run --release --bin generate-covid-data
cargo run --release --bin generate-earthquake-data
cargo run --release --bin generate-taxi-data
```

### Available Scripts

- **`generate-covid-data`**: COVID-19 county-level cases (NYT data)
- **`generate-earthquake-data`**: Global seismic activity (USGS)
- **`generate-taxi-data`**: Synthetic taxi trajectories (SF)
- **`generate-hurricane-data`**: Hurricane tracks *(coming soon)*
- **`generate-flight-data`**: Flight density *(coming soon)*
- **`generate-wildfire-data`**: Wildfire perimeters *(coming soon)*
- **`generate-ship-data`**: Maritime traffic *(coming soon)*
- **`generate-bikeshare-data`**: Bike share trips *(coming soon)*

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


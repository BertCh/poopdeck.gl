# Scripts

Utility scripts for the SpatioTemporal Tiles project.

## Data Generation

Located in [`data-generation/`](./data-generation/), with helper scripts for generating showcase datasets.

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

---

**See also**: [Main Documentation](../README.md) | [Data Generation Guide](../docs/guides/data-generation.md)

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

`stt-generate <subcommand>` covers earthquakes, AIS ship traffic, flights,
hurricanes, wildfires, NYC rideshare (+ taxi points/paths/trips/flows),
BIXI flowmaps, satellites, ocean drifters, animal migration, OSM edits, and
NEXRAD storm radar. Run `stt-generate --help` for the full registered list.

See [data-generation/README.md](./data-generation/README.md) and the
[Data Generation Guide](../docs/guides/data-generation.md) for per-dataset
recipes and flags.

---

**See also**: [Main Documentation](../README.md) | [Data Generation Guide](../docs/guides/data-generation.md)

# Data Generation Guide

This guide walks you through the process of converting raw geospatial data into a Spatiotemporal Tile (`.stt`) archive.

## Prerequisites

1.  **Install Rust:** [rustup.rs](https://rustup.rs/)
2.  **Build the tools:**
    ```bash
    cargo install --path crates/stt-build
    ```

## Scenario 1: CSV Data (Points with Timestamps)

Imagine you have a CSV file `earthquakes.csv`:

```csv
time,latitude,longitude,magnitude,depth
2023-01-01T05:00:00Z,35.1,-120.5,4.5,10
2023-01-01T06:30:00Z,35.2,-120.4,3.2,8
...
```

### Command
```bash
stt-build \
  --input earthquakes.csv \
  --output earthquakes.stt \
  --time-field "time" \
  --temporal-resolution sparse-events \
  --min-zoom 0 \
  --max-zoom 10 \
  --layer "earthquakes"
```

**Explanation:**
- We use `--temporal-resolution sparse-events` because earthquakes are discrete events, not continuous tracks.
- We cap `max-zoom` at 10 because high-precision street-level views aren't usually needed for earthquake visualization.

## Scenario 2: GeoJSON Tracks (Vehicles/Ships)

Imagine a GeoJSON file `ships.geojson` containing Point features representing ship positions over time.

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "mmsi": 123456789,
        "timestamp": 1672531200000
      },
      "geometry": {
        "type": "Point",
        "coordinates": [-122.4, 37.8]
      }
    }
  ]
}
```

### Command
```bash
stt-build \
  --input ships.geojson \
  --output ships.stt \
  --time-field "timestamp" \
  --time-format unix-ms \
  --temporal-resolution high-frequency \
  --delta-encoding \
  --layer "ships"
```

**Explanation:**
- `--time-format unix-ms` tells the parser the `timestamp` field is milliseconds since epoch.
- `--temporal-resolution high-frequency` ensures we get second-level precision at high zoom levels (street view) but aggregated buckets at low zoom levels.
- `--delta-encoding` is **crucial** here. It tracks the `mmsi` (or similar ID) and only stores the movement vectors, significantly compressing the file.

## Best Practices

### 1. Sort your Input (Optional but Helpful)
While `stt-build` handles unsorted data, sorting your input CSV/GeoJSON by time can slightly improve processing speed for massive datasets.

### 2. Choose the Right Temporal Profile
- **Sparse Events:** Use for discrete events (crimes, sales, earthquakes).
- **High Frequency:** Use for continuous movement (GPS tracks, sensors).
- **Daily Aggregates:** Use for pre-aggregated stats (COVID counts per county).

### 3. Memory Management
For massive datasets (GBs of GeoJSON), ensure you have enough RAM. `stt-build` streams data, but building the final index requires tracking active tiles.
- Use `--workers` to balance CPU usage vs. memory.
- If you hit memory limits, try processing smaller time chunks and merging (feature coming soon).

## Validating the Output

You can use the example showcase app to inspect your generated file:

1.  Copy `your-data.stt` to `examples/showcase/public/data/`.
2.  Add an entry to `examples/showcase/src/datasets.ts`.
3.  Run the showcase:
    ```bash
    cd examples/showcase
    npm run dev
    ```


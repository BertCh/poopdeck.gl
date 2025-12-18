# Data Generation Guide

This guide walks you through the process of generating spatiotemporal tile (`.stt`) archives from various data sources.

## Prerequisites

1. **Install Rust:** [rustup.rs](https://rustup.rs/)
2. **Build the tools:**
   ```bash
   cargo install --path crates/stt-generate
   cargo install --path crates/stt-build
   ```

## Quick Start

### Generate All Showcase Datasets

```bash
# Generate all built-in datasets (earthquakes, hurricanes, wildfires)
stt-generate all --output-dir examples/showcase/public/data
```

### Generate Individual Datasets

```bash
# Earthquake data from USGS
stt-generate earthquakes --output earthquakes.stt

# Hurricane tracks from NOAA IBTrACS
stt-generate hurricanes --output hurricanes.stt

# Wildfire perimeters from NIFC
stt-generate wildfires --output wildfires.stt
```

## Available Datasets

### Earthquakes (USGS)

Downloads earthquake data from the USGS API.

```bash
stt-generate earthquakes \
  --start-date 2020-01-01 \
  --end-date 2024-12-31 \
  --min-magnitude 4.5 \
  --output earthquakes.stt
```

**Options:**
- `--start-date`: Start date (YYYY-MM-DD), default: 2020-01-01
- `--end-date`: End date (YYYY-MM-DD), default: 2024-12-31
- `--min-magnitude`: Minimum magnitude, default: 4.0

### AIS Maritime Traffic (NOAA Marine Cadastre)

Processes AIS vessel tracking data from NOAA.

**Step 1:** Download raw data from [NOAA Marine Cadastre](https://marinecadastre.gov/ais/):
```bash
curl -o AIS_2024_01_01.zip \
  https://coast.noaa.gov/htdata/CMSP/AISDataHandler/2024/AIS_2024_01_01.zip
unzip AIS_2024_01_01.zip
```

**Step 2:** Process with stt-generate:
```bash
stt-generate ais \
  --input AIS_2024_01_01.csv \
  --output ais-traffic.stt \
  --sample-minutes 10 \
  --bounds "25.0,-80.0,45.0,-65.0"
```

**Options:**
- `--input`: Input CSV file (required)
- `--sample-minutes`: Temporal sampling (1 position per vessel per N minutes)
- `--bounds`: Geographic filter (min_lat,min_lon,max_lat,max_lon)
- `--max-vessels`: Limit number of vessels (0 = unlimited)

### Flight Traffic (OpenSky Network)

Downloads historical flight data from OpenSky Network.

```bash
stt-generate flights \
  --date 2020-01-06 \
  --hours 0-23 \
  --bounds "25,-125,50,-65" \
  --output flights.stt
```

**Note:** OpenSky data is only available for Mondays from 2017-2020.

**Options:**
- `--date`: Date to download (YYYY-MM-DD, must be a Monday)
- `--hours`: Hours to download (e.g., "0-23" for full day)
- `--bounds`: Geographic filter
- `--sample-seconds`: Temporal sampling interval

### Hurricane Tracks (NOAA IBTrACS)

Downloads historical hurricane track data.

```bash
stt-generate hurricanes \
  --start-year 2020 \
  --end-year 2024 \
  --output hurricanes.stt
```

**Options:**
- `--start-year`: Start year, default: 2020
- `--end-year`: End year, default: 2024
- `--synthetic`: Create synthetic year from multiple years

### Wildfire Perimeters (NIFC)

Downloads wildfire perimeter polygons from NIFC.

```bash
stt-generate wildfires \
  --start-year 2020 \
  --end-year 2023 \
  --min-acres 1000 \
  --output wildfires.stt
```

**Options:**
- `--start-year`: Start year, default: 2020
- `--end-year`: End year, default: 2023
- `--min-acres`: Minimum fire size in acres, default: 1000
- `--wildfires-only`: Exclude prescribed burns

### NYC Rideshare (TLC + OSRM)

Generates NYC taxi trajectories using real TLC data and OSRM routing.

**Synthetic mode (no external data required):**
```bash
stt-generate nyc-rideshare \
  --synthetic \
  --num-trips 1000 \
  --date 2024-01-15 \
  --output nyc-rideshare.stt
```

**With real TLC data:**
```bash
# Requires OSRM server with NYC data
./setup-osrm.sh

stt-generate nyc-rideshare \
  --input yellow_tripdata_2015-01.csv \
  --output nyc-rideshare.stt
```

**Options:**
- `--synthetic`: Generate synthetic trips
- `--num-trips`: Number of synthetic trips
- `--paths`: Output LineString paths instead of points
- `--osrm-url`: OSRM server URL
- `--skip-routing`: Skip OSRM routing (pickup/dropoff only)

## Custom Data (Using stt-build)

For arbitrary data not covered by built-in datasets, use `stt-build` directly:

### From GeoJSON

```bash
stt-build \
  --input my-custom-data.geojson \
  --output my-custom-data.stt \
  --time-field timestamp \
  --min-zoom 0 \
  --max-zoom 14 \
  --compression gzip
```

### From CSV (Points with Timestamps)

```bash
stt-build \
  --input sensor-readings.csv \
  --output sensors.stt \
  --time-field recorded_at \
  --time-format unix-ms
```

**Required columns for CSV:** `lon`, `lat`, and the timestamp field.

### Time Format Options

- `iso8601`: ISO 8601 format (default), e.g., `2024-01-15T12:30:00Z`
- `unix-ms`: Unix timestamp in milliseconds
- `unix-sec`: Unix timestamp in seconds

## Best Practices

### 1. Choose Appropriate Zoom Levels

- **Global datasets** (earthquakes, hurricanes): `--min-zoom 0 --max-zoom 10`
- **Regional datasets** (AIS, flights): `--min-zoom 0 --max-zoom 12`
- **City-level datasets** (taxis, rideshare): `--min-zoom 10 --max-zoom 16`

### 2. Use Temporal Sampling for Dense Data

For high-frequency data (GPS tracks, vessel positions):
```bash
stt-generate ais --sample-minutes 10  # 1 position per vessel per 10 min
stt-generate flights --sample-seconds 60  # 1 position per aircraft per minute
```

### 3. Memory Management

For massive datasets (GBs of data), use streaming CSV output:
```bash
stt-generate earthquakes --output earthquakes.csv --skip-build
stt-build --input earthquakes.csv --output earthquakes.stt
```

## Validating Output

Test your generated files with the showcase app:

```bash
# Copy to showcase data directory
cp my-data.stt examples/showcase/public/data/

# Update datasets.ts with your dataset config

# Run the showcase
cd examples/showcase
npm run dev
```

## Troubleshooting

### Download Fails

Use cached data if available:
```bash
stt-generate hurricanes --cached
```

### Out of Memory

Process in smaller chunks or use streaming mode:
```bash
stt-generate ais --input large-file.csv --output ais.csv --skip-build
```

### stt-build Not Found

Install it first:
```bash
cargo install --path crates/stt-build
```

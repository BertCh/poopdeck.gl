# Data Sources Guide

This document lists the real-world data sources used in STT example datasets.

## Available Data Generators

All generators are in `scripts/data-generation/src/`:

### 1. Earthquakes (USGS)

**Generator:** `earthquakes.rs`  
**API:** [USGS Earthquake Catalog](https://earthquake.usgs.gov/fdsnws/event/1/)  
**Coverage:** 2020-01-01 to 2024-12-31  
**Filter:** Magnitude 4.0+  
**Features:** ~77,000 global seismic events

**Properties:**

- `magnitude` (float) - Richter scale
- `depth` (float) - Depth in km
- `place` (string) - Location description
- `timestamp` (ISO 8601)
- `title` (string) - Event summary

**Build:**

```bash
cd scripts/data-generation
cargo run --release --bin generate-earthquake-data
```

---

### 2. COVID-19 Cases (New York Times)

**Generator:** `covid.rs`  
**Source:** [NYT COVID-19 Dataset](https://github.com/nytimes/covid-19-data)  
**Coverage:** 2020-02-02 to 2022-05-13  
**Filter:** 5 sample US counties (high population)  
**Features:** ~3,200 daily records

**Properties:**

- `value` (int) - Daily new cases
- `timestamp` (ISO 8601) - Date
- `county` (string)
- `state` (string)

**Build:**

```bash
cargo run --release --bin generate-covid-data
```

---

### 3. Hurricane Tracks (NOAA)

**Generator:** `hurricanes.rs`  
**API:** [IBTrACS](https://www.ncdc.noaa.gov/ibtracs/)  
**Coverage:** Atlantic basin, 2020-2023  
**Features:** ~5,200 6-hourly positions

**Properties:**

- `storm_name` (string)
- `category` (int) - Saffir-Simpson scale (0-5)
- `wind_speed` (float) - Max sustained winds (kt)
- `timestamp` (ISO 8601)

**Build:**

```bash
cargo run --release --bin generate-hurricane-data
```

---

### 4. Ships (Synthetic)

**Generator:** `ships.rs`  
**Type:** Simulated AIS (Automatic Identification System)  
**Coverage:** Red Sea + Mediterranean, 7 days  
**Features:** ~84,000 positions

**Properties:**

- `vessel_type` (string) - Cargo, Tanker, Passenger, Fishing
- `speed` (float) - Knots
- `heading` (float) - Degrees
- `timestamp` (ISO 8601)

---

## Usage

### Generate All Datasets

```bash
cd scripts/data-generation
./generate-all.sh
```

This script:

1. Downloads data from APIs
2. Converts to GeoJSON
3. Builds STT archives with optimal settings
4. Copies to `examples/showcase/public/data/`

### Manual Build

```bash
# 1. Generate GeoJSON
cargo run --release --bin generate-earthquake-data

# 2. Convert to STT
../../target/release/stt-build \
  --input data/earthquakes.geojson \
  --output ../../examples/showcase/public/data/earthquakes.stt \
  --time-field timestamp \
  --time-format iso8601 \
  --temporal-resolution sparse-events \
  --compression gzip \
  --max-zoom 6
```

---

## Data Attribution

When using these datasets, please attribute the sources:

- **Earthquakes:** U.S. Geological Survey (USGS)
- **COVID-19:** The New York Times
- **Hurricanes:** NOAA National Centers for Environmental Information
- **Ships:** Synthetic data for demonstration purposes

---

## Adding New Data Sources

To add a new data source:

1. Create generator in `scripts/data-generation/src/your_source.rs`
2. Add binary target to `scripts/data-generation/Cargo.toml`
3. Implement data fetching + GeoJSON conversion
4. Document properties and attribution here
5. Add to `generate-all.sh` script

Example template:

```rust
use anyhow::Result;
use geojson::{Feature, FeatureCollection, Geometry, Value};
use serde_json::json;

pub fn generate() -> Result<FeatureCollection> {
    let mut features = Vec::new();

    // Fetch data from API
    // ...

    // Convert to GeoJSON features
    for record in data {
        features.push(Feature {
            geometry: Some(Geometry::new(Value::Point(vec![lon, lat]))),
            properties: Some(json!({
                "timestamp": timestamp,
                "value": value,
            }).as_object().unwrap().clone()),
            ..Default::default()
        });
    }

    Ok(FeatureCollection {
        features,
        ..Default::default()
    })
}
```

---

## License Notes

- All generators fetch publicly available data
- USGS data is public domain
- NYT COVID data is freely available with attribution
- NOAA data is public domain
- Always check source licenses before redistribution

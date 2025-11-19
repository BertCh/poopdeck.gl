# Data Download and Processing Scripts - Comprehensive Review

**Date:** October 25, 2025  
**Reviewer:** AI Assistant  
**Scope:** Full review of `scripts/data-generation/` directory

---

## Executive Summary

The spatiotemporal-tiles project includes a comprehensive suite of Rust-based data generation scripts that download, process, and prepare real-world geospatial datasets for conversion to STT format. The architecture is well-designed with shared utilities, consistent patterns, and good documentation. However, there are areas for improvement in error handling, performance optimization, and real data integration.

### Overall Assessment: **B+ (Good, with room for improvement)**

**Strengths:**

- ✅ Well-structured modular architecture with shared utilities
- ✅ Comprehensive README with detailed data source documentation
- ✅ Consistent patterns across all generators
- ✅ Good CLI interface using clap
- ✅ Progress indicators for long-running operations
- ✅ Real data sources identified and documented

**Areas for Improvement:**

- ⚠️ Several generators use synthetic data instead of real sources
- ⚠️ Limited error handling and data validation
- ⚠️ Memory efficiency concerns for large datasets
- ⚠️ Inconsistent temporal resolution recommendations
- ⚠️ Missing comprehensive testing
- ⚠️ No rate limiting for API calls

---

## 1. Architecture Review

### 1.1 Project Structure

```
scripts/data-generation/
├── Cargo.toml              # Dependencies and binary definitions
├── README.md               # Comprehensive documentation
├── generate-all.sh         # Master pipeline script
├── download-ais.sh         # Specialized AIS download script
├── rebuild-earthquakes.sh  # Earthquake rebuild script
├── generate-datasets-config.js  # TypeScript config generator
├── data/                   # Data directory (runtime)
└── src/
    ├── common.rs          # Shared utilities ⭐
    ├── covid.rs           # COVID-19 (real data) ✅
    ├── earthquakes.rs     # USGS earthquakes (real data) ✅
    ├── taxis.rs           # SF taxis (synthetic) ⚠️
    ├── ais.rs             # AIS maritime (real data processor) ✅
    ├── ships.rs           # Maritime traffic (synthetic fallback) ⚠️
    ├── flights.rs         # Flight density (synthetic fallback) ⚠️
    ├── hurricanes.rs      # Hurricane tracks (real data) ✅
    ├── wildfires.rs       # Wildfire perimeters (synthetic) ⚠️
    ├── bikeshare.rs       # Bike share trips (synthetic) ⚠️
    └── lib.rs             # Stub implementations (unused?)
```

**Score: 8/10**

**Strengths:**

- Clear separation of concerns
- Shared utilities in `common.rs`
- Each generator is a separate binary
- Good use of Rust workspace pattern

**Issues:**

- `lib.rs` contains stub implementations that appear to duplicate actual implementations
- No test directory
- Data directory not in `.gitignore` (potential for large files in repo)

### 1.2 Dependency Management

From `Cargo.toml`:

```toml
[dependencies]
stt-core = { path = "../../crates/stt-core" }
anyhow.workspace = true
thiserror.workspace = true
serde.workspace = true
serde_json.workspace = true
geojson.workspace = true
geo.workspace = true
geo-types.workspace = true
reqwest = { version = "0.11", features = ["blocking", "json"] }
csv = "1.3"
chrono = { version = "0.4", features = ["serde"] }
rayon.workspace = true
clap.workspace = true
indicatif.workspace = true
tracing.workspace = true
tracing-subscriber.workspace = true
zip = "0.6"
flate2.workspace = true
rand = "0.8"
```

**Score: 9/10**

**Strengths:**

- Good selection of dependencies
- Uses workspace-level dependency management
- Includes async HTTP, CSV parsing, compression
- Progress bars and tracing for observability

**Issues:**

- Missing: retry logic (e.g., `reqwest-retry`)
- Missing: rate limiting (e.g., `governor`)
- `zip` version 0.6 is older (current is 2.x)

**Recommendation:** Add `reqwest-retry` and `governor` for production robustness.

---

## 2. Shared Utilities Review (`common.rs`)

### 2.1 File Download Function

```rust
pub fn download_file(url: &str, output_path: &Path) -> Result<()>
```

**Score: 6/10**

**Issues:**

1. **No retry logic:** Network failures will abort immediately
2. **Manual chunking:** Uses manual `loop` instead of `std::io::copy`
3. **No timeout:** Can hang indefinitely
4. **No checksum verification:** Can't verify file integrity
5. **Progress bar for 0-byte files:** Doesn't handle unknown content-length gracefully

**Recommended improvements:**

```rust
use std::time::Duration;
use reqwest::blocking::ClientBuilder;

pub fn download_file(url: &str, output_path: &Path) -> Result<()> {
    const MAX_RETRIES: u32 = 3;
    const TIMEOUT_SECS: u64 = 300;

    // Ensure parent directory exists
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let client = ClientBuilder::new()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .build()?;

    for attempt in 1..=MAX_RETRIES {
        match download_with_progress(&client, url, output_path) {
            Ok(_) => return Ok(()),
            Err(e) if attempt < MAX_RETRIES => {
                eprintln!("Download failed (attempt {}/{}): {}", attempt, MAX_RETRIES, e);
                std::thread::sleep(Duration::from_secs(2u64.pow(attempt)));
            }
            Err(e) => return Err(e),
        }
    }

    unreachable!()
}

fn download_with_progress(client: &reqwest::blocking::Client, url: &str, output_path: &Path) -> Result<()> {
    use std::io::copy;

    println!("Downloading: {}", url);
    let mut response = client.get(url).send()?;
    let total_size = response.content_length().unwrap_or(0);

    let pb = if total_size > 0 {
        let pb = ProgressBar::new(total_size);
        pb.set_style(/* ... */);
        Some(pb)
    } else {
        println!("Downloading (size unknown)...");
        None
    };

    let mut file = File::create(output_path)?;
    let mut downloaded: u64 = 0;
    let mut buffer = vec![0; 8192];

    loop {
        match response.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                file.write_all(&buffer[..n])?;
                downloaded += n as u64;
                if let Some(pb) = &pb {
                    pb.set_position(downloaded);
                }
            }
            Err(e) => return Err(e.into()),
        }
    }

    if let Some(pb) = pb {
        pb.finish_with_message("Download complete");
    }

    Ok(())
}
```

### 2.2 GeoJSON Creation Functions

```rust
pub fn create_point_feature(lon: f64, lat: f64, timestamp: DateTime<Utc>,
                            properties: Map<String, JsonValue>) -> Feature
pub fn create_linestring_feature(coordinates: Vec<[f64; 2]>, timestamp: DateTime<Utc>,
                                  properties: Map<String, JsonValue>) -> Feature
```

**Score: 8/10**

**Strengths:**

- Clean API
- Automatically adds timestamp to properties
- Uses standard GeoJSON types

**Issues:**

1. **No coordinate validation:** Doesn't check for valid lat/lon ranges
2. **Mutates input:** Modifies the properties map (could clone instead)
3. **No polygon support:** Missing `create_polygon_feature`

**Recommended improvements:**

```rust
pub fn create_point_feature(
    lon: f64,
    lat: f64,
    timestamp: DateTime<Utc>,
    mut properties: Map<String, JsonValue>,
) -> Result<Feature> {
    // Validate coordinates
    if !(-180.0..=180.0).contains(&lon) {
        anyhow::bail!("Invalid longitude: {}", lon);
    }
    if !(-90.0..=90.0).contains(&lat) {
        anyhow::bail!("Invalid latitude: {}", lat);
    }

    properties.insert("timestamp".to_string(), json!(timestamp.to_rfc3339()));

    Ok(Feature {
        bbox: None,
        geometry: Some(Geometry::new(Value::Point(vec![lon, lat]))),
        id: None,
        properties: Some(properties),
        foreign_members: None,
    })
}
```

### 2.3 GeoJSON Writing Function

```rust
pub fn write_geojson(features: Vec<Feature>, output_path: &Path) -> Result<()>
```

**Score: 5/10**

**Issues:**

1. **Memory inefficiency:** Loads all features into memory, serializes all at once
2. **No streaming:** Can't handle datasets larger than available RAM
3. **No compression:** Writes uncompressed JSON
4. **Pretty printing:** Wastes space with `to_string_pretty`

**For large datasets, consider streaming:**

```rust
use std::io::BufWriter;

pub fn write_geojson_streaming<I>(features: I, output_path: &Path) -> Result<()>
where
    I: Iterator<Item = Feature>,
{
    let file = File::create(output_path)?;
    let mut writer = BufWriter::new(file);

    // Write header
    write!(writer, r#"{{"type":"FeatureCollection","features":["#)?;

    let mut first = true;
    let mut count = 0;

    for feature in features {
        if !first {
            write!(writer, ",")?;
        }
        first = false;

        let json = serde_json::to_string(&feature)?;
        write!(writer, "{}", json)?;

        count += 1;
        if count % 10000 == 0 {
            println!("  Wrote {} features...", count);
        }
    }

    // Write footer
    write!(writer, "]}}")?;

    println!("✓ Wrote {} features", count);
    Ok(())
}
```

### 2.4 Date Utilities

**Score: 9/10**

Simple and correct. No issues.

### 2.5 Unzip Function

**Score: 7/10**

**Issues:**

- No error handling for corrupted archives
- Doesn't preserve permissions
- Vulnerable to zip bomb attacks (no size limits)

---

## 3. Individual Generator Review

### 3.1 COVID-19 Generator (`covid.rs`)

**Status:** ✅ Uses real data (NYT COVID-19 dataset)  
**Score: 6/10**

**Data Source:**

- URL: `https://raw.githubusercontent.com/nytimes/covid-19-data/master/us-counties.csv`
- License: CC BY-NC 4.0
- Format: CSV

**Strengths:**

- Real data from authoritative source
- Good progress reporting
- Handles missing coordinates gracefully

**Issues:**

1. **Hardcoded sample coordinates:**

```rust
fn generate_county_coordinates(path: &PathBuf) -> Result<()> {
    let sample_data = r#"fips,county,state,lat,lon
06001,Alameda,California,37.6017,-121.7195
06013,Contra Costa,California,37.9161,-121.9511
06075,San Francisco,California,37.7749,-122.4194
36061,New York,New York,40.7128,-74.0060
48201,Harris,Texas,29.7604,-95.3698"#;

    std::fs::write(path, sample_data)?;
    // ...
}
```

**CRITICAL ISSUE:** Only 5 counties have coordinates! This severely limits the dataset.

**Solution:** Download real county coordinates:

```rust
// US Census Bureau Gazetteer Files
const COUNTY_COORDS_URL: &str =
    "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_gaz_counties_national.zip";

fn download_county_coordinates(path: &PathBuf) -> Result<()> {
    let zip_path = PathBuf::from("data/county_coords.zip");
    common::download_file(COUNTY_COORDS_URL, &zip_path)?;
    common::unzip_file(&zip_path, &PathBuf::from("data/"))?;

    // Parse the gazetteer file and extract FIPS, lat, lon
    // ...
}
```

2. **Memory inefficiency:** Loads all records into memory

3. **No date filtering:** Processes entire dataset (2020-present)

**Recommendations:**

- Implement proper county coordinate download
- Add date range filtering options
- Consider streaming for large datasets
- Add data quality checks (negative cases, outliers)

### 3.2 Earthquake Generator (`earthquakes.rs`)

**Status:** ✅ Uses real data (USGS Earthquake Catalog)  
**Score: 8/10**

**Data Source:**

- API: `https://earthquake.usgs.gov/fdsnws/event/1/query`
- License: Public Domain
- Format: GeoJSON

**Strengths:**

- Clean API integration
- Yearly chunking to respect API limits
- Good parameter validation
- Direct GeoJSON response (no parsing needed)

**Issues:**

1. **No rate limiting:**

```rust
for year in start_year..=end_year {
    // ...
    let response = reqwest::blocking::get(&url)?;  // No delay between requests
    // ...
}
```

**Solution:**

```rust
use std::time::Duration;
use std::thread::sleep;

for year in start_year..=end_year {
    if year > start_year {
        sleep(Duration::from_millis(500)); // Rate limit
    }
    // ...
}
```

2. **No error recovery:** If one year fails, entire process aborts

3. **Hardcoded API limits:** Assumes API returns all results (10K limit exists)

4. **Temporal resolution mismatch:** README says "sparse-events" but code doesn't configure this

**Recommendations:**

- Add rate limiting
- Implement pagination for large results
- Add retry logic for failed requests
- Better error messages for API failures
- Consider caching downloaded data

### 3.3 Taxi Generator (`taxis.rs`)

**Status:** ⚠️ Synthetic data only  
**Score: 7/10**

**Strengths:**

- Realistic simulation with proper coordinate math
- Status transitions (available/occupied/enroute)
- Proper Web Mercator calculations
- Configurable parameters

**Issues:**

1. **Overly simplistic movement:**

```rust
// Random direction
let angle = rng.gen_range(0.0..std::f64::consts::TAU);
let dx = angle.cos() * distance_deg_lon;
let dy = angle.sin() * distance_deg_lat;
```

Random walk doesn't follow streets or realistic routes.

2. **No real data integration:** NYC has open taxi data available

**Real Data Source Available:**

- NYC Taxi & Limousine Commission
- URL: `https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page`
- Format: Parquet files
- Coverage: 2009-present
- License: Public domain

**Recommendation:** Implement real NYC taxi data processor using Arrow/Parquet libraries.

### 3.4 AIS Maritime Traffic Processor (`ais.rs`)

**Status:** ✅ Real data processor (NOAA Marine Cadastre)  
**Score: 9/10**

**Data Source:**

- Provider: NOAA Marine Cadastre
- URL: `https://coast.noaa.gov/htdata/CMSP/AISDataHandler/{YEAR}/AIS_{YEAR}_{MM}_{DD}.zip`
- License: Public Domain (US Government)
- Format: ZIP compressed CSV (~200-300 MB/day)

**Strengths:**

- ⭐ **Best implementation in the codebase**
- Comprehensive data validation
- Geographic filtering
- Temporal sampling
- Vessel count limits
- Progress reporting
- Good error handling for malformed CSV rows
- Vessel type categorization

**Example usage:**

```bash
cargo run --release --bin generate-ais-data -- \
  --input data/AIS_2024_01_01.csv \
  --output ais-traffic.geojson \
  --sample-minutes 10 \
  --bounds "25.0,-80.0,45.0,-65.0" \
  --max-vessels 5000
```

**Minor Issues:**

1. **Timestamp parsing hardcoded:**

```rust
let timestamp = match NaiveDateTime::parse_from_str(&record.base_date_time, "%Y-%m-%dT%H:%M:%S") {
    Ok(dt) => dt.and_utc().timestamp_millis(),
    Err(_) => continue,  // Silently skips bad timestamps
};
```

Should log warnings for skipped records.

2. **Memory-based deduplication:** `HashMap<String, i64>` for vessels could grow large

**Recommendations:**

- Add logging for skipped records
- Consider bloom filter for memory-efficient vessel tracking
- Add optional output compression (gzip)
- Document expected file sizes and processing times

### 3.5 Ships Generator (`ships.rs`)

**Status:** ⚠️ Synthetic fallback (real data available via `ais.rs`)  
**Score: 5/10**

**Purpose:** Provides synthetic data when real AIS data isn't available.

**Issues:**

- Duplicates functionality of `ais.rs`
- Overly simplistic routing
- Not clear when to use this vs `ais.rs`

**Recommendation:**

- Merge with `ais.rs` as fallback mode
- Add `--synthetic` flag to `ais.rs` generator

```rust
#[derive(Parser, Debug)]
struct Args {
    #[arg(short, long)]
    input: Option<PathBuf>,  // If None, use synthetic

    #[arg(long)]
    synthetic: bool,
    // ...
}
```

### 3.6 Flights Generator (`flights.rs`)

**Status:** ⚠️ Synthetic data only  
**Score: 4/10**

**Real Data Source Identified but Not Implemented:**

- Provider: ADSBExchange
- URL: `https://samples.adsbexchange.com/hires-traces/{YEAR}/{MM}/{DD}/{BUCKET}/trace_full_~{ICAO}.json`
- Format: Gzip JSON traces
- Limitation: Only 1st of each month freely available
- Coverage: Global

**Issues:**

1. **Unrealistic distribution:**

```rust
let num_this_interval = (num_flights as f64 * flight_multiplier / intervals as f64) as usize;
```

All flights distributed evenly across airports.

2. **No altitude variation over time:** Fixed altitude throughout flight

3. **No real data integration:** Real data source documented but not implemented

**Recommendation:** Implement ADS-B trace processor:

```rust
#[derive(Deserialize)]
struct AdsbTrace {
    icao: String,
    r: String,           // Registration
    t: String,           // Aircraft type
    trace: Vec<Vec<f64>>, // [timestamp, lat, lon, alt, gs, track]
}

fn process_adsb_trace(trace_path: &Path) -> Result<Vec<Feature>> {
    let file = File::open(trace_path)?;
    let reader = BufReader::new(GzDecoder::new(file));
    let trace: AdsbTrace = serde_json::from_reader(reader)?;

    let features = trace.trace.iter()
        .map(|point| {
            let timestamp = DateTime::from_timestamp(point[0] as i64, 0).unwrap();
            let mut props = Map::new();
            props.insert("icao".to_string(), json!(trace.icao));
            props.insert("altitude".to_string(), json!(point[3]));
            props.insert("speed".to_string(), json!(point[4]));

            common::create_point_feature(point[2], point[1], timestamp, props)
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(features)
}
```

### 3.7 Hurricane Generator (`hurricanes.rs`)

**Status:** ✅ Uses real data (NOAA IBTrACS)  
**Score: 7/10**

**Data Source:**

- Provider: NOAA IBTrACS
- URL: `https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r00/access/csv/ibtracs.NA.list.v04r00.csv`
- License: Public Domain
- Format: CSV (~100 MB)

**Strengths:**

- Real authoritative data
- Basin filtering (Atlantic)
- Year range filtering
- Category classification

**Issues:**

1. **Silent error handling:**

```rust
let record: IbtracsRecord = match result {
    Ok(r) => r,
    Err(_) => continue,  // Silently skips bad records
};
```

2. **Large file download:** 100+ MB CSV downloaded every time unless `--cached`

3. **Inconsistent temporal resolution:** Code mentions "hour" buckets but data is 6-hourly

4. **No trajectory generation:** Treats each position as separate point, not connected tracks

**Recommendations:**

- Add trajectory/track generation (group by storm_id)
- Cache downloaded file with timestamp
- Log warnings for skipped records
- Add `--min-category` filter option

### 3.8 Wildfire Generator (`wildfires.rs`)

**Status:** ⚠️ Synthetic data only  
**Score: 3/10**

**Real Data Sources Available:**

- **CAL FIRE:** Fire perimeter data (California)
  - URL: `https://www.fire.ca.gov/what-we-do/fire-resource-assessment-program/fire-perimeters`
  - Format: GeoJSON
- **NIFC (National):** Historical fire perimeters
  - URL: `https://data-nifc.opendata.arcgis.com/`
  - Format: GeoJSON/Shapefile

**Current Implementation Issues:**

- Point-based fires (should be polygons)
- Unrealistic growth patterns
- Limited to California
- Random walk expansion

**Recommendation:** Implement real fire perimeter data:

```rust
use geo_types::Polygon;

#[derive(Deserialize)]
struct FirePerimeter {
    fire_name: String,
    fire_year: u32,
    gis_acres: f64,
    geometry: Polygon<f64>,
    // ...
}

// Download from CAL FIRE or NIFC
// Process polygon perimeters
// Generate time series as fire grows
```

### 3.9 Bikeshare Generator (`bikeshare.rs`)

**Status:** ⚠️ Synthetic data only  
**Score: 4/10**

**Real Data Sources Available:**

- **NYC Citi Bike:** Trip data
  - URL: `https://s3.amazonaws.com/tripdata/index.html`
  - Format: CSV
  - License: CC BY-NC 4.0
- **Bay Area Bike Share:** Trip data
  - URL: `https://www.lyft.com/bikes/bay-wheels/system-data`
  - Format: CSV

**Current Implementation Issues:**

- Only 10 hardcoded stations
- Unrealistic demand patterns
- No real trip data

**Recommendation:** Implement real bike share data processor:

```rust
#[derive(Deserialize)]
struct CitiBikeTrip {
    #[serde(rename = "started_at")]
    start_time: String,
    #[serde(rename = "ended_at")]
    end_time: String,
    #[serde(rename = "start_lat")]
    start_lat: f64,
    #[serde(rename = "start_lng")]
    start_lon: f64,
    #[serde(rename = "end_lat")]
    end_lat: f64,
    #[serde(rename = "end_lng")]
    end_lon: f64,
    // ...
}
```

---

## 4. Shell Scripts Review

### 4.1 Master Pipeline (`generate-all.sh`)

**Score: 8/10**

**Strengths:**

- Comprehensive pipeline for all datasets
- Good progress indicators
- Creates output directories
- Runs stt-build after each generator
- Includes metadata generation

**Issues:**

1. **No error handling:**

```bash
set -e  # Good: exits on error
```

But doesn't clean up partial files or report which step failed.

2. **Sequential execution:** Could parallelize independent steps

3. **Hardcoded compression:** Uses `gzip` (README mentions `brotli`)

4. **No resume capability:** If it fails halfway, must restart from beginning

**Recommended improvements:**

```bash
#!/bin/bash
set -euo pipefail  # Add unset variable check

# Logging
LOG_FILE="data-generation-$(date +%Y%m%d-%H%M%S).log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1

# Error handler
trap 'echo "❌ Pipeline failed at line $LINENO. Check $LOG_FILE for details." >&2; exit 1' ERR

# Check prerequisites
command -v cargo >/dev/null || { echo "❌ Cargo not found"; exit 1; }
command -v stt-build >/dev/null || { echo "❌ stt-build not found"; exit 1; }
command -v node >/dev/null || { echo "❌ Node.js not found"; exit 1; }

# Function to generate dataset
generate_dataset() {
    local name=$1
    local binary=$2
    local args=$3
    local output=$4

    if [ -f "$output" ]; then
        echo "⏭️  Skipping $name (already exists)"
        return 0
    fi

    echo "🔄 Generating $name..."
    cargo run --release --bin "$binary" -- $args
    echo "✅ $name complete"
}

# Parallel execution of independent datasets
generate_dataset "COVID-19" "generate-covid-data" "--output data/covid-cases.geojson" "data/covid-cases.geojson" &
generate_dataset "Earthquakes" "generate-earthquake-data" "--output data/earthquakes.geojson" "data/earthquakes.geojson" &
wait

# ... etc
```

### 4.2 AIS Download Script (`download-ais.sh`)

**Score: 7/10**

**Strengths:**

- Interactive region selection
- Geographic filtering
- File size reporting
- Checks for existing files

**Issues:**

1. **Assumes `generate-ais-data` binary exists:**

```bash
../../target/release/generate-ais-data  # No existence check
```

2. **No validation of date input:**

```bash
YEAR=${1:-2024}  # What if user passes "abc"?
```

3. **Interactive in automated environments:** `read -p` won't work in CI/CD

**Improvements:**

```bash
# Validate date
if ! [[ "$YEAR" =~ ^[0-9]{4}$ ]] || [ "$YEAR" -lt 2009 ] || [ "$YEAR" -gt 2025 ]; then
    echo "❌ Invalid year: $YEAR (must be 2009-2025)"
    exit 1
fi

# Check binary exists
if [ ! -f "../../target/release/generate-ais-data" ]; then
    echo "❌ generate-ais-data binary not found"
    echo "   Run: cargo build --release --bin generate-ais-data"
    exit 1
fi

# Non-interactive mode
if [ ! -t 0 ]; then
    REGION=${REGION:-4}  # Default to "all" in non-interactive
fi
```

### 4.3 Earthquake Rebuild Script (`rebuild-earthquakes.sh`)

**Score: 9/10**

Simple and effective. Only minor issue:

```bash
stt-build  # No path check

# Should be:
if ! command -v stt-build >/dev/null; then
    echo "❌ stt-build not found. Build it first:"
    echo "   cd ../.. && cargo build --release --bin stt-build"
    exit 1
fi
```

---

## 5. TypeScript Config Generator (`generate-datasets-config.js`)

**Score: 7/10**

**Strengths:**

- Generates TypeScript from metadata
- Consistent dataset configuration
- Auto-generated warnings in output

**Issues:**

1. **No error handling:**

```javascript
const metadata = loadMetadata(); // What if directory doesn't exist?
```

2. **Hardcoded configurations:** `DATASET_CONFIGS` object

3. **Template literal in generated code:**

```javascript
timeRange: {
  start: Date.parse('${new Date(...).toISOString()}'),  // Ugly
  end: Date.parse('${new Date(...).toISOString()}'),
}
```

**Improvement:**

```javascript
// Use milliseconds directly
timeRange: {
  start: ${meta.timeRange.start},
  end: ${meta.timeRange.end},
}
```

4. **No schema validation:** Doesn't verify metadata structure

**Recommendation:** Add JSON schema validation:

```javascript
const Ajv = require("ajv");
const ajv = new Ajv();

const metadataSchema = {
  type: "object",
  required: ["filename", "timeRange"],
  properties: {
    filename: { type: "string" },
    timeRange: {
      type: "object",
      required: ["start", "end"],
      properties: {
        start: { type: "number" },
        end: { type: "number" },
      },
    },
  },
};

const validate = ajv.compile(metadataSchema);

for (const [datasetId, meta] of Object.entries(metadata)) {
  if (!validate(meta)) {
    console.error(`Invalid metadata for ${datasetId}:`, validate.errors);
    process.exit(1);
  }
}
```

---

## 6. Documentation Review

### 6.1 README.md

**Score: 9/10**

**Strengths:**

- ⭐ **Excellent documentation**
- Comprehensive data source information
- Clear usage examples
- Real data source URLs and limitations
- Performance tips
- Troubleshooting section
- License information

**Minor Issues:**

- Some examples use `brotli`, others use `gzip` compression (inconsistent)
- Missing: estimated processing times
- Missing: storage requirements table
- Missing: data quality notes

**Recommendation:** Add performance benchmarks:

```markdown
## Performance Benchmarks

Tested on Apple M1 Max, 32GB RAM:

| Dataset     | Raw Size | Processing Time | Output Size | Compression |
| ----------- | -------- | --------------- | ----------- | ----------- |
| COVID-19    | 45 MB    | ~8s             | 12 MB       | gzip        |
| Earthquakes | 8 MB     | ~15s (network)  | 2 MB        | gzip        |
| AIS (1 day) | 800 MB   | ~45s            | 80 MB       | gzip        |
| Flights     | N/A      | ~12s (synth)    | 15 MB       | gzip        |
| Hurricanes  | 120 MB   | ~20s            | 5 MB        | gzip        |

_Processing time includes download, parse, and GeoJSON output_
```

---

## 7. Critical Issues Summary

### 7.1 Security Concerns

1. **No input validation on URLs:** Could be exploited for SSRF attacks
2. **Zip bomb vulnerability:** `unzip_file` doesn't check extracted sizes
3. **Path traversal in ZIP:** Malicious ZIP could write outside target directory

**Fix for ZIP vulnerability:**

```rust
pub fn unzip_file(zip_path: &Path, output_dir: &Path) -> Result<()> {
    const MAX_EXTRACTED_SIZE: u64 = 10 * 1024 * 1024 * 1024; // 10 GB
    let mut total_extracted: u64 = 0;

    let file = File::open(zip_path)?;
    let mut archive = ZipArchive::new(file)?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;

        // Prevent path traversal
        let filepath = file.name();
        if filepath.contains("..") {
            anyhow::bail!("ZIP contains path traversal: {}", filepath);
        }

        let outpath = output_dir.join(filepath);

        // Verify outpath is within output_dir
        if !outpath.starts_with(output_dir) {
            anyhow::bail!("ZIP attempts to write outside target: {}", filepath);
        }

        if file.name().ends_with('/') {
            std::fs::create_dir_all(&outpath)?;
        } else {
            if let Some(p) = outpath.parent() {
                std::fs::create_dir_all(p)?;
            }

            let mut outfile = File::create(&outpath)?;
            let extracted = std::io::copy(&mut file, &mut outfile)?;
            total_extracted += extracted;

            // Prevent zip bombs
            if total_extracted > MAX_EXTRACTED_SIZE {
                anyhow::bail!("ZIP extraction exceeded size limit");
            }
        }
    }

    Ok(())
}
```

### 7.2 Data Quality Issues

1. **COVID-19:** Only 5 counties have coordinates (should be 3,000+)
2. **No deduplication:** Multiple generators could produce duplicate features
3. **No data validation:** Coordinates, timestamps, and values not validated
4. **Inconsistent time zones:** Some use UTC, others don't specify

### 7.3 Performance Issues

1. **Memory inefficiency:** All generators load full datasets into memory
2. **No streaming:** Large files (800+ MB) processed as Vec<Feature>
3. **No parallelization:** Multi-year downloads happen sequentially
4. **Pretty printing:** Wastes time and space with `to_string_pretty`

### 7.4 Missing Features

1. **No resume capability:** Failed downloads must restart from scratch
2. **No caching strategy:** Re-downloads data even if recently fetched
3. **No incremental updates:** Must regenerate entire dataset
4. **No data versioning:** Can't track which version of source data was used

---

## 8. Recommendations by Priority

### High Priority (Fix Now)

1. ✅ **Fix COVID-19 county coordinates** - Download real census data
2. ✅ **Add coordinate validation** - Prevent invalid lat/lon values
3. ✅ **Implement retry logic for downloads** - Network resilience
4. ✅ **Fix ZIP security vulnerabilities** - Path traversal and zip bombs
5. ✅ **Add error logging** - Don't silently skip bad records

### Medium Priority (Next Sprint)

6. ⚠️ **Implement streaming for large datasets** - Memory efficiency
7. ⚠️ **Add rate limiting for APIs** - Respect API quotas
8. ⚠️ **Implement real data sources** - Replace synthetic generators
9. ⚠️ **Add caching layer** - Avoid re-downloading
10. ⚠️ **Parallelize independent operations** - Faster generation

### Low Priority (Future)

11. 📋 **Add comprehensive tests** - Unit and integration tests
12. 📋 **Implement incremental updates** - Update existing STT files
13. 📋 **Add data quality reports** - Statistics and validation
14. 📋 **Create Docker container** - Reproducible environment
15. 📋 **Add CI/CD pipeline** - Automated testing and deployment

---

## 9. Testing Recommendations

Currently **no tests exist**. Recommended test structure:

```
scripts/data-generation/
├── src/
│   ├── ...
│   └── tests/
│       ├── common_tests.rs
│       ├── covid_tests.rs
│       ├── earthquakes_tests.rs
│       └── integration_tests.rs
└── tests/
    └── end_to_end_tests.rs
```

**Example test:**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_create_point_feature_valid() {
        let props = Map::new();
        let timestamp = Utc::now();

        let feature = create_point_feature(-122.4, 37.8, timestamp, props).unwrap();

        assert!(feature.geometry.is_some());
        assert!(feature.properties.is_some());
        assert!(feature.properties.as_ref().unwrap().contains_key("timestamp"));
    }

    #[test]
    fn test_create_point_feature_invalid_lon() {
        let props = Map::new();
        let timestamp = Utc::now();

        let result = create_point_feature(200.0, 37.8, timestamp, props);
        assert!(result.is_err());
    }

    #[test]
    fn test_download_file_with_retry() {
        let temp_dir = TempDir::new().unwrap();
        let output = temp_dir.path().join("test.txt");

        // Use httpbin for testing
        let result = download_file("https://httpbin.org/status/200", &output);
        assert!(result.is_ok());
        assert!(output.exists());
    }
}
```

---

## 10. Conclusion

The data generation scripts are **well-architected** with a solid foundation but need improvements in several areas:

### What's Working Well ✅

- Modular design with shared utilities
- Good documentation
- Real data sources identified
- CLI interface with progress indicators
- Comprehensive README

### What Needs Improvement ⚠️

- Several generators use synthetic data when real data is available
- No streaming support for large datasets
- Limited error handling and recovery
- Security vulnerabilities in ZIP handling
- No test coverage
- Memory inefficiency
- Missing caching layer

### Recommended Action Plan

**Week 1-2:** Fix critical issues

- Implement proper county coordinates for COVID-19
- Add coordinate validation
- Fix security vulnerabilities
- Add retry logic for downloads

**Week 3-4:** Improve reliability

- Implement streaming for large datasets
- Add comprehensive error handling
- Implement rate limiting
- Add caching layer

**Week 5-6:** Expand real data coverage

- Implement NYC taxi data processor
- Implement ADS-B flight data processor
- Implement wildfire perimeter processor
- Implement bikeshare data processor

**Week 7-8:** Testing and polish

- Add unit tests (80%+ coverage target)
- Add integration tests
- Performance benchmarking
- Documentation updates

### Overall Score: **B+ (Good, with room for improvement)**

The scripts are production-ready for small datasets but need hardening for large-scale use. Priority should be fixing critical issues (county coordinates, security) and implementing real data sources for synthetic generators.

---

**End of Review**  
_Generated: October 25, 2025_

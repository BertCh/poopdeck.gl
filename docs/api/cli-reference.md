# CLI Reference

## stt-build

The `stt-build` command is the primary tool for generating Spatiotemporal Tile archives from source data. It ingests CSV or GeoJSON and produces an optimized `.stt` archive.

### Usage

```bash
stt-build [OPTIONS] --input <INPUT> --output <OUTPUT>
```

### Required Arguments

| Argument | Description |
| :--- | :--- |
| `-i, --input <INPUT>` | Path to the source file. Supports `.csv` (comma-separated values) and `.geojson` (FeatureCollection or newline-delimited). |
| `-o, --output <OUTPUT>` | Path to the output `.stt` archive. |

### Configuration Options

| Option | Default | Description |
| :--- | :--- | :--- |
| `-t, --time-field` | `timestamp` | Name of the column (CSV) or property (GeoJSON) containing the timestamp. |
| `--time-format` | `iso8601` | Format of the timestamp. Options: `iso8601`, `unix-ms`, `unix-sec`. |
| `--min-zoom` | `0` | Minimum zoom level to generate. |
| `--max-zoom` | `14` | Maximum zoom level to generate. |
| `--layer` | `default` | Name of the layer in the output tile. |

### Optimization & Tuning

| Option | Default | Description |
| :--- | :--- | :--- |
| `--temporal-resolution` | `sparse-events` | Temporal bucketing profile. <br> **Profiles**: `high-frequency`, `sparse-events`, `daily-aggregates` <br> **Fixed**: `second`, `minute`, `hour`, `day`, `week`, `month`, `year` |
| `--delta-encoding` | `false` | Enable delta encoding. Reduces file size for moving entities but requires sequential decoding. |
| `--simplification` | `0.0001` | Douglas-Peucker simplification tolerance in degrees. |
| `--max-tile-size` | `500000` | Target maximum size for a single tile in bytes. Features may be dropped to meet this budget. |
| `--compression` | `gzip` | Compression algorithm. Options: `gzip`, `none`. |

### Metadata

| Option | Description |
| :--- | :--- |
| `--name` | Dataset name. |
| `--description` | Dataset description. |
| `--attribution` | Data source attribution. |
| `--metadata-output` | Write a JSON summary of the metadata to a specific file (useful for frontend config). |

### Performance

| Option | Default | Description |
| :--- | :--- | :--- |
| `-w, --workers` | `4` | Number of parallel threads to use for processing. |

## stt-analyze

*Note: The analysis tool is currently under development.*

Intended to profile existing `.stt` archives to report:
- Tile size distribution
- Temporal density
- Compression ratios

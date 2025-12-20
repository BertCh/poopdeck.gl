# CLI Reference

## stt-build

The `stt-build` command is the primary tool for generating Spatiotemporal Tile archives from source data. It ingests CSV or GeoJSON and produces an optimized `.stt` archive.

### Usage

```bash
stt-build [OPTIONS] --input <INPUT> --output <OUTPUT>
```

### Required Arguments

| Argument              | Description                                                                                 |
| :-------------------- | :------------------------------------------------------------------------------------------ |
| `-i, --input <INPUT>` | Path to the source file. Supports `.csv` and `.geojson` (FeatureCollection or newline-delimited). |
| `-o, --output <OUTPUT>` | Path to the output `.stt` archive.                                                        |

### Time Configuration

| Option                 | Default     | Description                                                            |
| :--------------------- | :---------- | :--------------------------------------------------------------------- |
| `-t, --time-field`     | `timestamp` | Field name containing timestamps (Unix ms or ISO 8601).                |
| `--end-time-field`     | `null`      | Optional field for end timestamps (creates time ranges per feature).   |
| `--time-format`        | `iso8601`   | Format of timestamps: `iso8601`, `unix-ms`, or `unix-sec`.             |

### Zoom Configuration

| Option        | Default | Description                     |
| :------------ | :------ | :------------------------------ |
| `--min-zoom`  | `0`     | Minimum zoom level to generate. |
| `--max-zoom`  | `14`    | Maximum zoom level to generate. |

### Tile Options

| Option            | Default  | Description                                                              |
| :---------------- | :------- | :----------------------------------------------------------------------- |
| `--extent`        | `4096`   | Tile extent (coordinate precision within tile).                          |
| `--chunk-size`    | `500000` | Target chunk size in bytes. Features grouped into tiles of ~this size.  |
| `--compression`   | `gzip`   | Compression algorithm: `gzip` or `none`.                                 |
| `--simplification`| `0.0001` | Douglas-Peucker simplification tolerance in degrees (0 = no simplification). |
| `--layer`         | `default`| Name of the layer in the output tiles.                                   |

### Metadata

| Option              | Description                                                    |
| :------------------ | :------------------------------------------------------------- |
| `--name`            | Dataset name (stored in archive metadata).                     |
| `--description`     | Dataset description.                                           |
| `--attribution`     | Data source attribution.                                       |
| `--metadata-output` | Write JSON metadata to file (useful for frontend config).      |

### Performance

| Option          | Default | Description                                   |
| :-------------- | :------ | :-------------------------------------------- |
| `-w, --workers` | `4`     | Number of parallel threads for processing.    |
| `-v, --verbose` | `false` | Enable verbose debug output.                  |

### Examples

#### Basic GeoJSON Conversion

```bash
stt-build -i earthquakes.geojson -o earthquakes.stt
```

#### CSV with Custom Time Field

```bash
stt-build -i ships.csv -o ships.stt \
  --time-field observed_at \
  --time-format unix-ms
```

#### High-Resolution with Time Ranges

```bash
stt-build -i flights.geojson -o flights.stt \
  --time-field departure_time \
  --end-time-field arrival_time \
  --max-zoom 12 \
  --workers 8
```

#### With Metadata

```bash
stt-build -i hurricanes.geojson -o hurricanes.stt \
  --name "Hurricane Tracks" \
  --description "NOAA hurricane tracking data" \
  --attribution "NOAA" \
  --metadata-output hurricanes-meta.json
```

# CLI Reference

## stt-build

The `stt-build` command is the primary tool for generating Spatiotemporal Tile archives from GeoParquet files. It uses a memory-efficient streaming architecture that processes ~50MB per 1M features.

### Usage

```bash
stt-build [OPTIONS] --input <INPUT> --output <OUTPUT>
```

### Required Arguments

| Argument              | Description                                                                                 |
| :-------------------- | :------------------------------------------------------------------------------------------ |
| `-i, --input <INPUT>` | Path to the source GeoParquet file (`.parquet` or `.geoparquet`). |
| `-o, --output <OUTPUT>` | Path to the output `.stt` archive.                                                        |

### Input Format

The `stt-build` tool accepts **GeoParquet** files only. GeoParquet is an efficient columnar format that enables:

- **Memory-efficient streaming**: Process 1M+ features using only ~50MB of RAM
- **Fast random access**: Read specific features without loading the entire file
- **Standard geometry encoding**: WKB or GeoArrow native encoding supported

To convert other formats to GeoParquet, use tools like:

```bash
# From GeoJSON using ogr2ogr (GDAL)
ogr2ogr -f Parquet output.parquet input.geojson

# From CSV with geometry using DuckDB
duckdb -c "COPY (SELECT *, ST_Point(lon, lat) as geometry FROM 'input.csv') TO 'output.parquet' (FORMAT PARQUET)"

# From Shapefile
ogr2ogr -f Parquet output.parquet input.shp
```

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

### Memory Usage

The streaming architecture uses a two-pass approach:

1. **Pass 1**: Build lightweight spatial index (~40 bytes per feature)
2. **Pass 2**: Generate tiles by reading features on demand

For a dataset with 1M features:
- Index memory: ~38 MB
- Peak memory during tile generation: ~200 MB per worker batch
- **Total peak memory: ~500 MB** (vs 30+ GB with in-memory processing)

### Examples

#### Basic GeoParquet Conversion

```bash
stt-build -i earthquakes.parquet -o earthquakes.stt
```

#### With Custom Time Fields (Unix Milliseconds)

```bash
stt-build -i taxi-trips.parquet -o taxi-trips.stt \
  --time-field timestamp \
  --end-time-field end_timestamp \
  --time-format unix-ms
```

#### High-Resolution with Multiple Workers

```bash
stt-build -i flights.parquet -o flights.stt \
  --time-field departure_time \
  --end-time-field arrival_time \
  --max-zoom 12 \
  --workers 8
```

#### With Metadata

```bash
stt-build -i hurricanes.parquet -o hurricanes.stt \
  --name "Hurricane Tracks" \
  --description "NOAA hurricane tracking data" \
  --attribution "NOAA" \
  --metadata-output hurricanes-meta.json
```

### Supported Geometry Types

The tool automatically detects and processes all standard geometry types:

| Geometry Type | Description | Example Use Case |
| :------------ | :---------- | :--------------- |
| Point | Single coordinate | Events, sensors, vehicles |
| LineString | Path with multiple vertices | Trajectories, routes, tracks |
| Polygon | Closed area | Boundaries, perimeters, zones |
| MultiPoint | Multiple points | Clusters, groups |
| MultiLineString | Multiple paths | Complex routes |
| MultiPolygon | Multiple polygons | Islands, fragmented areas |

### Geometry Column Detection

The tool looks for geometry in the following order:

1. Standard GeoParquet column names: `geometry`, `geom`, `wkb_geometry`, `the_geom`, `shape`
2. Binary columns (WKB encoding)
3. Struct columns (GeoArrow native encoding)
4. Separate `lon`/`lat` or `longitude`/`latitude` columns (creates Point geometries)

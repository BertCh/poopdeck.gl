# Building STT archives from Python

The common Python path into `stt-build` is **GeoParquet**. This guide shows
three ways to produce that GeoParquet from data you already have in Python:
GeoPandas, plain DuckDB, and a small mixed pipeline. (`stt-build` can also
read PostGIS or DuckDB directly with no export step — see the note in §2.)

The pattern is always: get your data into Arrow / Parquet with a geometry
column and a timestamp column, then shell out to `stt-build`.

## Requirements

- A built `stt-build` binary (`cargo build --release -p stt-build`).
- Either GeoPandas, pyarrow, or DuckDB. They install cleanly with pip:
  `pip install geopandas pyarrow duckdb`.

## 1. GeoPandas → GeoParquet

```python
import geopandas as gpd

# Any GeoDataFrame with a geometry column and a timestamp column will do.
gdf = gpd.read_file("earthquakes.geojson")

# stt-build requires lon/lat degrees (OGC:CRS84 / EPSG:4326). Reproject
# projected data BEFORE export — the build hard-fails on any other
# declared CRS:
gdf = gdf.to_crs(4326)

# stt-build expects timestamps as Unix-ms (Int64), Unix-s (Int64), or ISO
# 8601 strings. Convert if needed:
gdf["timestamp"] = (
    gdf["time"].astype("datetime64[ms]").astype("int64")
)

# Write GeoParquet. GeoPandas uses pyarrow + WKB by default — that is what
# stt-build's input loader expects.
gdf.to_parquet("earthquakes.parquet", compression="snappy")
```

Two export pitfalls the build catches with a hard error:

- **Wrong CRS.** A GeoParquet file whose geometry column declares any CRS
  other than `OGC:CRS84` / `EPSG:4326` (e.g. a Web Mercator export) fails
  with: *"GeoParquet geometry column 'geometry' declares CRS EPSG:3857
  (WGS 84 / Pseudo-Mercator), but stt-build requires lon/lat degrees
  (OGC:CRS84 / EPSG:4326). Reproject the input before export…"* — the
  `to_crs(4326)` line above is the fix.
- **Native geoarrow encoding.** `gdf.to_parquet(...,
  geometry_encoding="geoarrow")` writes line/polygon geometry in a layout
  the build cannot ingest and fails with a re-export hint. Keep the
  default WKB encoding (or pass `geometry_encoding="WKB"` explicitly).
- **Nanosecond timestamps.** Native Arrow Timestamp columns are read
  directly, but only at ms/µs precision — pandas `datetime64[ns]` exports
  as a nanosecond Timestamp and fails with *"Unsupported timestamp column
  type"*. The Int64 conversion above sidesteps it.

Pre-1970 timestamps are rejected in all modes — the STT temporal index
stores unsigned ms-since-epoch. Filter or re-epoch historical rows before
building.

```bash
stt-build \
  --input earthquakes.parquet \
  --output earthquakes.stt \
  --time-field timestamp \
  --time-format unix-ms \
  --auto
```

> `stt-build` writes the **packed format** — `--output earthquakes.stt` produces
> an `earthquakes/` directory (`manifest.json` + `index/*.sttd` + `packs/*.sttp`),
> not a single file. The `.stt` extension is stripped for convenience.

`--auto` runs `stt-optimize` over the input to pick a sensible zoom range
and temporal bucket. Any flag you also pass explicitly wins. (Compression
is not auto-tuned — the packed format is zstd-only.)

## 2. DuckDB → GeoParquet (no Python deps beyond duckdb)

DuckDB's spatial extension can read CSVs, GeoJSON, Shapefiles, even PostGIS,
and write GeoParquet directly. This is the lowest-overhead path for large
datasets.

```python
import duckdb

con = duckdb.connect()
con.execute("INSTALL spatial; LOAD spatial;")

# Example: a CSV with lon/lat and a timestamp column.
con.execute("""
    COPY (
      SELECT
        ST_AsWKB(ST_Point(lon, lat)) AS geometry,
        CAST(EPOCH_MS(strptime(time, '%Y-%m-%dT%H:%M:%SZ')) AS BIGINT) AS timestamp,
        mag, place
      FROM read_csv_auto('earthquakes.csv')
    )
    TO 'earthquakes.parquet' (FORMAT 'parquet', COMPRESSION 'snappy');
""")
```

Then `stt-build --input earthquakes.parquet --output earthquakes.stt
--time-field timestamp --time-format unix-ms --auto`.

> **Skip the export entirely.** A `stt-build` built with `--features duckdb`
> reads from DuckDB directly — point it at a `.duckdb` file, or use `:memory:`
> to scan the source file in place:
>
> ```bash
> stt-build --duckdb :memory: \
>   --sql "SELECT ST_Point(lon, lat) AS geom,
>                 CAST(EPOCH_MS(strptime(time, '%Y-%m-%dT%H:%M:%SZ')) AS BIGINT) AS timestamp,
>                 mag, place
>          FROM read_csv_auto('earthquakes.csv')" \
>   --geom-column geom --time-field timestamp --time-format unix-ms \
>   --output earthquakes.stt
> ```
>
> See [docs/roadmap/db-input-adaptors.md](../roadmap/db-input-adaptors.md) for
> the DuckDB (and PostGIS) input source and the `stt-serve --duckdb` dynamic tile
> server.

## 3. pyarrow only (no GeoPandas)

If you already have Arrow tables in memory and don't want a GeoPandas
dependency, write the WKB column manually:

```python
import pyarrow as pa
import pyarrow.parquet as pq
from shapely.geometry import Point
from shapely import wkb

points = [Point(lon, lat) for lon, lat in coords]
wkb_col = pa.array([wkb.dumps(p) for p in points], type=pa.binary())

table = pa.table({
    "geometry": wkb_col,
    "timestamp": pa.array(ts_ms, type=pa.int64()),
    "mag": pa.array(magnitudes, type=pa.float64()),
})

pq.write_table(table, "earthquakes.parquet", compression="snappy")
```

stt-build's `find_geometry_column` heuristic picks up a column named
`geometry` containing WKB bytes, no extra metadata required.

## Trajectory data (LineString with duration)

For trip-like data — a moving thing with per-vertex timestamps — emit
LineString geometries and supply both a start and an end time field:

```python
# vertices: list[list[(lon, lat)]] — one polyline per trip
# trip_starts, trip_ends: Unix-ms scalars
gdf = gpd.GeoDataFrame({
    "geometry": [LineString(v) for v in vertices],
    "start_time": trip_starts,
    "end_time": trip_ends,
    "vehicle_id": vehicle_ids,
})
gdf.to_parquet("trips.parquet")
```

```bash
stt-build \
  --input trips.parquet \
  --output trips.stt \
  --time-field start_time \
  --end-time-field end_time \
  --time-format unix-ms \
  --simplify \
  --auto
```

`--simplify` enables per-zoom Visvalingam simplification; the trajectory
clipper splits trips at tile boundaries while preserving per-vertex
timestamps so the deck.gl `AnimatedTripsLayer` can interpolate position
at any time within the trip's duration.

Without more information the build interpolates per-vertex times by
cumulative distance between `start_time` and `end_time`. If you have real
per-segment timing (e.g. from OSRM annotations), supply it as a
`vertex_timestamps` list column (`List<Timestamp>` or `List<Int64>`
unix-ms, one entry per vertex); an optional `vertex_values` column
(`List<Float32>`/`List<Float64>`) carries a per-vertex scalar such as
sea-surface temperature.

## Verifying the result

```bash
stt-validate trips/
```

This opens the packed dataset (pass the directory `stt-build` wrote, or
its `manifest.json`), blake3-verifies every object against its
content-addressed name, content-hash-checks and decodes every tile, and
prints schema + feature counts. Use `--json` for a machine-readable report
suitable for CI.

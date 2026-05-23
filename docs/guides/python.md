# Building STT archives from Python

`stt-build` requires its input as **GeoParquet**. This guide shows three
ways to produce that GeoParquet from data you already have in Python:
GeoPandas, plain DuckDB, and a small mixed pipeline.

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

# stt-build expects timestamps as Unix-ms (Int64), Unix-s (Int64), or ISO
# 8601 strings. Convert if needed:
gdf["timestamp"] = (
    gdf["time"].astype("datetime64[ms]").astype("int64")
)

# Write GeoParquet. GeoPandas uses pyarrow + WKB by default — that is what
# stt-build's input loader expects.
gdf.to_parquet("earthquakes.parquet", compression="snappy")
```

```bash
stt-build \
  --input earthquakes.parquet \
  --output earthquakes.stt \
  --time-field timestamp \
  --time-format unix-ms \
  --auto
```

`--auto` runs `stt-optimize` over the input to pick a sensible zoom range,
temporal bucket, and compression. Any flag you also pass explicitly wins.

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

## Verifying the result

```bash
stt-validate trips.stt
```

This opens the archive, content-hash-checks every tile, decodes each, and
prints schema + feature counts. Use `--json` for a machine-readable report
suitable for CI.

# Exporting an Archive Back to GeoParquet

Data flows _into_ the packed format from GeoParquet, PostGIS and DuckDB.
`stt-optimize export` is the way back out: it reads a built archive and writes
**GeoParquet 1.1**, so an archive is a render tier over your lakehouse rather
than a place data goes to die.

```bash
stt-optimize export --archive my-dataset/ --output my-dataset.parquet
```

```
GeoParquet export
  archive:  my-dataset/manifest.json
  zoom:     12 (91 of 91 base tiles selected)
  encoding: GeoParquet 1.1.0 / wkb

  default → my-dataset.parquet
    400 row(s) from 91 tile(s); types [Point]
    bbox [-73.90000, 45.40000, -73.33000, 45.78000]
```

The tiles are already Arrow with interleaved GeoArrow coordinates, so the export
is mostly a geometry re-encode to WKB plus the file metadata that makes the
result self-describing to DuckDB, GeoPandas, Sedona and Iceberg.

## What one row is

A row is a **tile-local feature record**, not a source feature. Two facts about
how archives are built drive everything below — read them before you trust a
`COUNT(*)`.

**Features are re-tiled at every zoom.** The same feature exists at z8 and at
z14, simplified differently. Exporting the whole directory would emit it once
per level, at mixed generalization. So an export is always **one zoom** —
`--zoom`, defaulting to the deepest one present, which is the least-simplified
tier.

**Temporal-LOD archives carry extra aggregate tiles** at those same zooms with a
coarser bucket. Only base-tier tiles are exported; the LOD pyramid is a read
optimization, not extra data.

**Features that span a tile boundary are clipped**, and every piece keeps the
parent's feature `id`. This exporter therefore never deduplicates on `id` —
doing so would silently delete geometry. Instead every row carries the tile it
came from:

| column     | meaning                 |
| ---------- | ----------------------- |
| `stt_zoom` | zoom of the source tile |
| `stt_x`    | tile column             |
| `stt_y`    | tile row                |

For point data one `id` is one row and you can ignore these. For polygons and
long paths, reassemble with `GROUP BY id` and a union aggregate before treating
a row as a feature.

## Output schema

| column                     | type                          | notes                                            |
| -------------------------- | ----------------------------- | ------------------------------------------------ |
| `stt_zoom`/`stt_x`/`stt_y` | `UINT8` / `UINT32` / `UINT32` | source-tile provenance (above)                   |
| `id`                       | `UINT64`                      | feature id, shared by clipped pieces             |
| `start_time`, `end_time`   | `TIMESTAMP(MILLIS, UTC)`      | not bare integers — see below                    |
| `geometry`                 | `BYTE_ARRAY` (WKB)            | the GeoParquet primary column                    |
| `bbox`                     | struct of 4 `FLOAT`           | GeoParquet 1.1 `covering`, for row-group pruning |
| _your properties_          | as stored                     | dequantized back to `DOUBLE` where applicable    |

Times land as real **`TIMESTAMP(MILLIS, UTC)`**, not `INT64`. That is deliberate
and pinned by a test: an export whose time column arrives as an anonymous
integer is the one round-trip failure that silently ruins the artifact, because
nothing downstream reads it as time.

Three classes of column are reconstructed on the way out, because their at-rest
form is meaningless outside this format:

- **Quantized coordinates.** An archive built with `--quantize-coords` stores
  `i32` grid indices plus an affine. The exporter reconstructs lon/lat before
  writing WKB. (Reconstruction is lossy to at most half a quantum — the
  precision you asked for at build time.)
- **Quantized attributes.** `--quantize-attr` / `--quantize-attrs-auto` columns
  are stored as integer indices and come back as `DOUBLE`.
- **Per-vertex times.** `vertex_time` ships as `u16` or `u32` deltas — against
  either a tile-wide origin/step or each feature's own `start_time` — and is
  exported as absolute Unix-ms `LIST<INT64>`. A `LIST<INT64>` vertex_time is
  already absolute and passes through.

Two columns are deliberately dropped: `triangles`, the pre-baked earcut
tessellation of the polygon in the same row — derived renderer state that any
tessellator regenerates, and no GeoParquet reader can use it — and
`part_offsets`, the multi-part ring index, whose numbers would name nothing a
Parquet consumer can address because the WKB written here flattens the parts.
Dropped columns are named in the run report.

## Filtering

```bash
# A metro-area, one-day slice
stt-optimize export -a my-dataset/ -o slice.parquet \
  --bbox -74.05,40.65,-73.85,40.85 \
  --start 2024-03-01 --end 2024-03-02
```

`--bbox` is `min_lon,min_lat,max_lon,max_lat` in WGS84. Tiles are pruned by
their footprint first, then **each row** is tested against its own geometry
bounds, so the result is a true subset rather than "every tile that touched the
box".

`--start` / `--end` accept ISO-8601 (`2024-03-01`, `2024-03-01T12:00:00Z`) or
Unix milliseconds. A feature is kept when its own `[start_time, end_time]` span
_overlaps_ the window — a trip that began before the window and is still running
inside it is in the result, which is what you want and what a naive
`start_time >= ?` would miss.

Both filters compose as an intersection.

## Files and layers

Output is **one Parquet file per layer**, never one per tile. The `geo`
metadata that makes a file GeoParquet is file-level, so a file-per-tile export
would repeat that header tens of thousands of times and hand you an object-store
anti-pattern instead of an artifact. The pruning that file-per-tile would buy is
recovered _inside_ the file: directory entries arrive in `(zoom, hilbert,
time_start)` order, so rows land in spatially and temporally coherent row
groups, and the `covering` bbox column plus the `start_time` statistics let a
reader skip row groups on both axes.

Separate _layers_ do get separate files — a point layer and a linestring layer
have different schemas and cannot share one. With several layers and no
`--layer`, `--output city.parquet` produces `city.<layer>.parquet` per layer;
with `--layer` it writes exactly the path you gave.

## Geometry encoding

| `--geometry-encoding` | What it writes                                                      |
| --------------------- | ------------------------------------------------------------------- |
| `wkb` (default)       | `BYTE_ARRAY` of WKB, described by the GeoParquet 1.1 `geo` metadata |
| `native`              | the same bytes, plus Parquet's native `GEOMETRY` logical type       |

`native` is additive: the GeoParquet metadata is still written, so a 1.1 reader
sees exactly the same file, while a reader that understands Parquet's geospatial
types (Iceberg v3, GeoParquet 2.0, recent DuckDB) picks up the logical type.

One caveat worth knowing before you standardise on `native`: this build pins
`parquet` with the `geospatial` feature **off**, so the writer does not emit
Parquet's geospatial _column statistics_ (the per-column bbox/geometry-type
summary the native type can carry). The emitted `covering` bbox column gives
equivalent row-group pruning to any reader, native-aware or not, which is why
`wkb` remains the default.

The `crs` key is deliberately **omitted** from the `geo` metadata. GeoParquet
defines an absent `crs` as OGC:CRS84 — longitude/latitude on WGS84, exactly what
tile coordinates are. An explicit `null` would instead assert that the CRS is
_unknown_, which is the opposite of true.

## Reading it back

```sql
-- DuckDB
SELECT id, start_time, ST_AsText(geometry) FROM 'my-dataset.parquet' LIMIT 5;
```

```python
import geopandas
gdf = geopandas.read_parquet("my-dataset.parquet")
```

## Performance notes

The export decodes the selected tiles **twice**. `stt-build` seals a layer's
property column set from the values present in each tile, so for inputs without
a declared schema the column set can legitimately differ between tiles of one
layer — while the Parquet writer needs its schema up front. The first pass
unions the output schemas; the second writes. The alternative (lock the schema
from the first tile) would silently drop a column that first appears late in the
directory, which is exactly the class of loss an export must not have.

If two tiles disagree on a column's _type_, the export stops and names the
column: rebuild with a declared input schema (which pins one type per column
across every tile) rather than let the exporter guess.

## Flags

The flag surface is documented once, in the
[CLI reference](../api/cli-reference.md#stt-optimize-export) — that copy is
gated against the binary's own `--help`, so it cannot drift.

## See also

- [Tuning tiles](./tuning-tiles.md) — the other side of `stt-optimize`
- [CLI reference](../api/cli-reference.md)

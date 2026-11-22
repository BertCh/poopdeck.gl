"""Turn raw point observations into trajectory GeoParquet for stt-build.

One row per (object, contiguous run): a WKB LineString, start/end time, and a
`vertex_timestamps` list aligned with the vertices. A run is split wherever
the gap between consecutive fixes exceeds --max-gap-s, so a gap is never
silently bridged by a straight line.

    python prep.py ais      <AIS_YYYY_MM_DD.csv>        <out.parquet>
    python prep.py drifters <drifters-hourly-*.csv ...>  <out.parquet>
    python prep.py adsb     <heatmap/NN.bin.ttf ...>     <out.parquet>
    python prep.py export   <in.parquet> <out.bin> [--underway]

`export` writes the flat binary the Rust `trajectory-lossy` example reads:
u64 n_traj, u64 n_vtx, u64 offsets[n_traj+1], f64 lon[n_vtx], f64 lat[n_vtx],
i64 t_ms[n_vtx] (little-endian). `--underway` keeps only trajectories whose
median ground speed exceeds 4 m/s (~8 kn): smooth, densely sampled motion.

Dependencies: duckdb, pyarrow, numpy (no GDAL).
"""

import json
import struct
import sys

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq


def wkb_linestring(xs, ys):
    n = len(xs)
    head = struct.pack("<BII", 1, 2, n)
    body = np.empty(n * 2, dtype="<f8")
    body[0::2] = xs
    body[1::2] = ys
    return head + body.tobytes()


def runs(ids, t_ms, max_gap_ms):
    """Yield (start, end) index ranges of contiguous runs (input sorted by id, t)."""
    n = len(ids)
    if n == 0:
        return
    brk = np.ones(n, dtype=bool)
    brk[1:] = (ids[1:] != ids[:-1]) | ((t_ms[1:] - t_ms[:-1]) > max_gap_ms)
    starts = np.flatnonzero(brk)
    ends = np.append(starts[1:], n)
    for s, e in zip(starts, ends):
        yield s, e


def write(out, rows):
    ids, geoms, t0, t1, vts, extra = rows
    table = pa.table(
        {
            "id": pa.array(ids, pa.string()),
            "geometry": pa.array(geoms, pa.binary()),
            "start_time": pa.array(t0, pa.timestamp("ms", tz="UTC")),
            "end_time": pa.array(t1, pa.timestamp("ms", tz="UTC")),
            "vertex_timestamps": pa.array(vts, pa.list_(pa.timestamp("ms", tz="UTC"))),
            **{k: pa.array(v) for k, v in extra.items()},
        }
    )
    geo = {
        "version": "1.0.0",
        "primary_column": "geometry",
        "columns": {"geometry": {"encoding": "WKB", "geometry_types": ["LineString"]}},
    }
    table = table.replace_schema_metadata({b"geo": json.dumps(geo).encode()})
    pq.write_table(table, out, compression="zstd")
    nv = sum(len(v) for v in vts)
    print(f"{out}: {len(ids):,} trajectories, {nv:,} vertices")


def build(con, sql, max_gap_ms, min_vertices, extra_cols):
    df = con.execute(sql).fetchnumpy()
    oid = df["oid"]
    t = df["t_ms"].astype(np.int64)
    x = df["x"].astype(np.float64)
    y = df["y"].astype(np.float64)
    out_ids, geoms, t0, t1, vts = [], [], [], [], []
    extra = {k: [] for k in extra_cols}
    for s, e in runs(oid, t, max_gap_ms):
        if e - s < min_vertices:
            continue
        out_ids.append(f"{oid[s]}-{t[s]}")
        geoms.append(wkb_linestring(x[s:e], y[s:e]))
        t0.append(int(t[s]))
        t1.append(int(t[e - 1]))
        vts.append(t[s:e].tolist())
        for k, f in extra_cols.items():
            extra[k].append(f(df, s, e))
    return out_ids, geoms, t0, t1, vts, extra


def ais(src, out):
    con = duckdb.connect()
    # One fix per (vessel, second); AIS repeats are common. Drop impossible
    # coordinates (the feed carries 91/181 sentinels).
    sql = f"""
      SELECT MMSI::VARCHAR AS oid,
             epoch_ms(BaseDateTime::TIMESTAMP) AS t_ms,
             any_value(LON) AS x, any_value(LAT) AS y,
             any_value(VesselType) AS vtype
      FROM read_csv_auto('{src}')
      WHERE LAT BETWEEN -90 AND 90 AND LON BETWEEN -180 AND 180
      GROUP BY 1, 2 ORDER BY 1, 2
    """
    rows = build(
        con, sql, max_gap_ms=30 * 60_000, min_vertices=2,
        extra_cols={"vessel_type": lambda d, s, e: int(d["vtype"][s]) if d["vtype"][s] == d["vtype"][s] else -1},
    )
    write(out, rows)


def drifters(srcs, out):
    con = duckdb.connect()
    files = ", ".join(f"'{s}'" for s in srcs)
    # Row 2 of each GDP CSV is a units row; skip it.
    sql = f"""
      SELECT ID::VARCHAR AS oid, epoch_ms(time::TIMESTAMP) AS t_ms,
             longitude AS x, latitude AS y
      FROM read_csv([{files}], skip=2, header=false,
                    columns={{'ID':'VARCHAR','WMO':'VARCHAR','time':'VARCHAR',
                              'longitude':'DOUBLE','latitude':'DOUBLE','sst':'DOUBLE',
                              've':'DOUBLE','vn':'DOUBLE'}})
      WHERE latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180
      QUALIFY row_number() OVER (PARTITION BY ID, time ORDER BY time) = 1
      ORDER BY 1, 2
    """
    rows = build(con, sql, max_gap_ms=3 * 3600_000, min_vertices=2, extra_cols={})
    write(out, rows)


def adsb(srcs, out, bbox=(-125.0, 25.0, -65.0, 50.0)):
    """readsb `heatmap/NN.bin.ttf` half-hour files (adsb.lol globe_history).

    Each file is gzip'd little-endian int32 quads. A leading index block, then
    10 s slices: a magic row (0x0e7f7c9d, now_ms hi, now_ms lo, interval_ms)
    followed by (hex, lat*1e6, lon*1e6, alt|gs) rows. Rows whose lat field is
    >= 2^30 carry callsign/type info, not a position. Kept to a bbox (CONUS
    by default) so the archive stays comparable in size to the AIS day.
    """
    import gzip

    MAGIC = 0x0E7F7C9D
    hx, ts, xs, ys = [], [], [], []
    for src in sorted(srcs):
        a = np.frombuffer(gzip.decompress(open(src, "rb").read()), dtype="<i4").reshape(-1, 4)
        u = a.view("<u4")
        is_magic = a[:, 0] == MAGIC
        first = np.flatnonzero(is_magic)[0]
        a, u, is_magic = a[first:], u[first:], is_magic[first:]
        now = (u[:, 1].astype(np.int64) << 32) | u[:, 2].astype(np.int64)
        # Each row takes the timestamp of the last magic row before it.
        slice_id = np.cumsum(is_magic) - 1
        t = now[is_magic][slice_id]
        keep = ~is_magic & (a[:, 1] < (1 << 30))
        lat = a[keep, 1] / 1e6
        lon = a[keep, 2] / 1e6
        inb = (lon >= bbox[0]) & (lon <= bbox[2]) & (lat >= bbox[1]) & (lat <= bbox[3])
        hx.append(a[keep, 0][inb]); ts.append(t[keep][inb]); xs.append(lon[inb]); ys.append(lat[inb])
    hx = np.concatenate(hx); t = np.concatenate(ts); x = np.concatenate(xs); y = np.concatenate(ys)
    order = np.lexsort((t, hx))
    hx, t, x, y = hx[order], t[order], x[order], y[order]
    dup = np.zeros(len(hx), dtype=bool)
    dup[1:] = (hx[1:] == hx[:-1]) & (t[1:] == t[:-1])
    hx, t, x, y = hx[~dup], t[~dup], x[~dup], y[~dup]
    out_ids, geoms, t0, t1, vts = [], [], [], [], []
    # 120 s = 12 missed slices: bridges a short reception dropout, splits a
    # missing half-hour file or a coverage hole.
    for s, e in runs(hx, t, 120_000):
        if e - s < 2:
            continue
        out_ids.append(f"{int(hx[s]) & 0xFFFFFFFF:07x}-{t[s]}")
        geoms.append(wkb_linestring(x[s:e], y[s:e]))
        t0.append(int(t[s])); t1.append(int(t[e - 1])); vts.append(t[s:e].tolist())
    write(out, (out_ids, geoms, t0, t1, vts, {}))


def export(src, out, underway=False):
    t = pq.read_table(src, columns=["geometry", "vertex_timestamps"])
    offs, xs, ys, ts = [0], [], [], []
    for g, vt in zip(t.column("geometry").to_pylist(), t.column("vertex_timestamps").to_pylist()):
        n = struct.unpack_from("<I", g, 5)[0]
        xy = np.frombuffer(g, dtype="<f8", offset=9, count=n * 2)
        x, y = xy[0::2], xy[1::2]
        tm = np.array([int(v.timestamp() * 1000) for v in vt], dtype=np.int64)
        if underway:
            if n < 3:
                continue
            dx = np.diff(x) * np.cos(np.radians(y[:-1])) * 111320.0
            dy = np.diff(y) * 111320.0
            dt = np.diff(tm) / 1000.0
            ok = dt > 0
            if not ok.any() or np.median(np.hypot(dx, dy)[ok] / dt[ok]) < 4.0:
                continue
        xs.append(x); ys.append(y); ts.append(tm)
        offs.append(offs[-1] + n)
    x = np.concatenate(xs); y = np.concatenate(ys); tm = np.concatenate(ts)
    with open(out, "wb") as f:
        f.write(np.array([len(offs) - 1, len(x)], dtype="<u8").tobytes())
        f.write(np.array(offs, dtype="<u8").tobytes())
        f.write(x.astype("<f8").tobytes()); f.write(y.astype("<f8").tobytes())
        f.write(tm.astype("<i8").tobytes())
    print(f"{out}: {len(offs) - 1:,} trajectories, {len(x):,} vertices")


if __name__ == "__main__":
    kind, *args = sys.argv[1:]
    if kind == "ais":
        ais(args[0], args[1])
    elif kind == "export":
        export(args[0], args[1], underway="--underway" in args)
    elif kind == "drifters":
        drifters(args[:-1], args[-1])
    elif kind == "adsb":
        adsb(args[:-1], args[-1])
    else:
        sys.exit(f"unknown kind {kind}")

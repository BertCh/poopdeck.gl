#!/usr/bin/env bash
# Regenerate the committed packed formatVersion-3 cross-impl golden fixtures
# under packages/core/test/fixtures/ with the REAL Rust writer (stt-build,
# which emits the only supported packed format, v2):
#
#   v2-golden/         points — numeric `speed` (+null) and two dictionary
#                      columns `kind`/`agency` (+nulls), coord-quant 1 m,
#                      --quantize-attrs-auto (per-tile `qa` affines in
#                      TILE_META), 2 zooms × 2 time buckets, paged directory.
#   v2-golden-tracks/  LineString trajectories with duration (interpolated
#                      u16-delta vertex_time, TILE_META `vt`), Float64 coords,
#                      single directory.
#
# Builds are byte-reproducible, so re-running is a no-op diff unless the
# writer's bytes intentionally changed. Packed format v1 was withdrawn; this
# generator must never recreate retired `*-v1` fixtures or pass a version
# override to the writer.
#
# The synthetic source lives in this script as SQL VALUES (DuckDB :memory: +
# the spatial extension — a one-time `INSTALL spatial` needs network, cached
# under ~/.duckdb afterward). No input files, no extra tooling.
#
# NOTE: stt-build's tiler never emits an EMPTY tile (a bucket with no
# features simply has no tile), so the empty-bucket v2 decode path (0 rows,
# dictionary columns still carrying a DictionaryBatch each) is covered by
# the TS-synthesized inline-schema frames in test/tile-v2-frame.test.ts
# instead, mirroring the Rust writer's empty-tile shape from
# crates/stt-core/tests/v1_golden.rs.
#
# Usage: packages/core/scripts/make-v2-golden.sh
# Requires: cargo (builds spatiotemporal-tiles with `--features duckdb`).

set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
FIXTURES="$REPO/packages/core/test/fixtures"
BUILD=(cargo run --quiet --release -p spatiotemporal-tiles --features duckdb --bin stt-build --)

# Deterministic synthetic points: 18 rows over 2 time buckets (1h) and a few
# zoom-5 cells; numeric `speed` + categoricals `kind`/`agency`, each with a
# NULL row (validity bitmaps + dictionary nulls on the wire).
POINTS_SQL="
SELECT * FROM (VALUES
  (TIMESTAMP '2026-01-01 00:05:00', ST_Point(-122.4194, 37.7749), 12.5,  'car',  'muni'),
  (TIMESTAMP '2026-01-01 00:10:00', ST_Point(-122.4300, 37.7800), 30.25, 'bus',  'muni'),
  (TIMESTAMP '2026-01-01 00:15:00', ST_Point(-122.4100, 37.7700), NULL,  'tram', 'muni'),
  (TIMESTAMP '2026-01-01 00:20:00', ST_Point(-122.4000, 37.7600), 44.0,  NULL,   'bart'),
  (TIMESTAMP '2026-01-01 00:25:00', ST_Point(-122.3900, 37.7500), 18.75, 'car',  NULL),
  (TIMESTAMP '2026-01-01 00:30:00', ST_Point(-122.3800, 37.7400), 22.0,  'bus',  'bart'),
  (TIMESTAMP '2026-01-01 00:35:00', ST_Point(-121.8863, 37.3382), 15.5,  'tram', 'vta'),
  (TIMESTAMP '2026-01-01 00:40:00', ST_Point(-121.9000, 37.3300), 61.25, 'car',  'vta'),
  (TIMESTAMP '2026-01-01 00:45:00', ST_Point(-121.8800, 37.3400), 9.0,   'bus',  'vta'),
  (TIMESTAMP '2026-01-01 01:05:00', ST_Point(-122.4194, 37.7749), 33.5,  'car',  'muni'),
  (TIMESTAMP '2026-01-01 01:10:00', ST_Point(-122.4210, 37.7755), 27.75, 'tram', 'muni'),
  (TIMESTAMP '2026-01-01 01:15:00', ST_Point(-122.4400, 37.7900), NULL,  'bus',  'muni'),
  (TIMESTAMP '2026-01-01 01:20:00', ST_Point(-121.8863, 37.3382), 40.0,  'car',  'vta'),
  (TIMESTAMP '2026-01-01 01:25:00', ST_Point(-121.8900, 37.3350), 12.25, NULL,   NULL),
  (TIMESTAMP '2026-01-01 01:30:00', ST_Point(-121.8850, 37.3390), 55.5,  'tram', 'vta'),
  (TIMESTAMP '2026-01-01 01:35:00', ST_Point(-118.2437, 34.0522), 20.0,  'bus',  'metro'),
  (TIMESTAMP '2026-01-01 01:40:00', ST_Point(-118.2500, 34.0500), 35.75, 'car',  'metro'),
  (TIMESTAMP '2026-01-01 01:45:00', ST_Point(-118.2400, 34.0550), 48.5,  'tram', 'metro')
) AS t(iso_time, geom, speed, kind, agency)"

# Deterministic synthetic trajectories: LineStrings with duration (start/end
# times) → stt-build interpolates per-vertex times → the u16-delta
# `vertex_time` column + the TILE_META `vt` [origin, step] pair.
TRACKS_SQL="
SELECT * FROM (VALUES
  (TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:30:00',
   ST_GeomFromText('LINESTRING(-122.40 37.70, -122.41 37.71, -122.42 37.72, -122.43 37.73)'), 12.5),
  (TIMESTAMP '2026-01-01 00:05:00', TIMESTAMP '2026-01-01 00:47:00',
   ST_GeomFromText('LINESTRING(-122.50 37.75, -122.51 37.76, -122.52 37.77)'), 30.0),
  (TIMESTAMP '2026-01-01 01:02:00', TIMESTAMP '2026-01-01 01:41:00',
   ST_GeomFromText('LINESTRING(-121.88 37.33, -121.89 37.34, -121.90 37.35, -121.91 37.36, -121.92 37.37)'), 21.25)
) AS t(iso_time, end_time, geom, speed)"

build_fixture() { # $1 = out-dir name, remaining args = stt-build args
  local name="$1"; shift
  local out="$FIXTURES/$name"
  rm -rf "$out"
  "${BUILD[@]}" -o "$out" "$@"
  # cargo/stt-build may drop a metadata sidecar; the fixture is only the
  # dataset directory (manifest + index/ + packs/).
}

echo "==> points (v2-golden)"
build_fixture v2-golden \
  --duckdb ":memory:" --sql "$POINTS_SQL" \
  --time-field iso_time \
  --temporal-bucket 1h \
  --min-zoom 4 --max-zoom 5 \
  --paged-directory-min-entries 1 \
  --blob-ordering spatial \
  --quantize-coords 1 --quantize-attrs-auto \
  --name v2-golden --layer default

echo "==> tracks (v2-golden-tracks)"
build_fixture v2-golden-tracks \
  --duckdb ":memory:" --sql "$TRACKS_SQL" \
  --time-field iso_time --end-time-field end_time \
  --temporal-bucket 1h \
  --min-zoom 5 --max-zoom 5 \
  --blob-ordering spatial \
  --single-directory \
  --name v2-golden-tracks --layer tracks

echo "==> validating both datasets (stt-validate)"
for d in v2-golden v2-golden-tracks; do
  cargo run --quiet --release -p spatiotemporal-tiles --bin stt-validate -- \
    "$FIXTURES/$d/manifest.json" >/dev/null
  echo "    $d OK"
done
echo "done: fixtures under $FIXTURES/v2-golden*"

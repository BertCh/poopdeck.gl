# Static packed archives vs DB-backed serving — decision record (2026-07-05)

Question investigated: is the packed format "rolling a custom DB", and would a
DuckDB/PostGIS-backed serve path beat it on performance? Full benchmark data
lives in [`db-input-adaptors.md`](./db-input-adaptors.md) §6; this records the
architectural verdict.

## Verdict

The packed format **is** half a database — deliberately the read-only half:
clustered `(zoom, hilbert, time)` index, zone-map page pruning, per-blob zstd,
baked statistics, LOD. It skips the hard half (writes, concurrency, recovery,
query planning). Same trade PMTiles/COPC/Parquet made; not NIH.

**Raw single-node latency is a tie, not a static win**: warm dynamic PostGIS
serves a tile in ~2–3 ms p50 vs ~1–3 ms for static files (~5 ms DuckDB, 87 ms
p99). Static wins structurally, not on the hot path:

1. **Fan-out economics.** `stt-serve` is correctly `no-store` (live source) —
   every tile is origin compute forever. Packs are immutable + content-addressed
   → CDN-cached indefinitely; only the manifest is mutable. Prior art is blunt:
   under load the DB is always the bottleneck (Martin's own maintainer:
   "PMTiles is always a much faster choice").
2. **Scaling with data.** Dynamic cost ∝ rows-per-tile; low-zoom tiles are the
   industry-documented pathological case, and the no-thinning principle makes
   ours comprehensive. Static pays once at build (and DB *ingest* is as fast as
   file ingest — 0.98×/0.66×).
3. **The directory is the client's planner.** Byte-budgeted prefetch slices and
   runway readiness run on per-tile byte lengths from the directory; a dynamic
   server can't know tile sizes before generating them, and can't coalesce
   ranges across tiles.

Every "clever DB thing" (page cache, matviews-per-zoom, R-tree, Varnish in
front) is a per-request reconstruction of what the build does once — and DuckDB
serving is read-only multi-process anyway, i.e. an immutable snapshot.

**Where the DB genuinely wins** — and why `stt-serve` stays: freshness
(live/mutating tables), ad-hoc attribute predicates (format has no attribute
pushdown, whole-blob decode only), zero-build local exploration. The current
split (DB = live tier + input source with byte-parity via the shared encoder;
packed archive = published read-many default) is exactly the hybrid Felt /
Wikimedia / OSM / CARTO converged on. The temporal directory has **no**
off-the-shelf substitute — PMTiles has no time axis.

## Counted out / revival triggers

- **Serve-side cache (`--immutable-source` ETag/LRU)** — revive if a static DB
  file gets public traffic (already sketched in
  [`data-sources-and-encoder.md`](./data-sources-and-encoder.md) §4).
- **Zoom-dependent short TTLs** (60 s low zoom / 5 s high, Sourcepole pattern)
  — revive if a genuinely live dataset ships publicly.

# STT Time Model — Specification

> **Scope:** the normative model for STT's *temporal* axis — how time is
> represented on a feature, how features are bucketed into tiles, how the
> coarser-bucket pyramid works, and how a reader prunes by time. The spatial
> axis (WebMercator tile pyramid) and the byte container are specified in
> [`stt-packed-format.md`](./stt-packed-format.md); the per-tile payload is in
> [`../architecture/data-format.md`](../architecture/data-format.md). This page
> makes normative what those documents reference in passing.

STT is a spatial tile pyramid crossed with a temporal axis: a tile is addressed
by `(zoom, x, y, bucket)`. This document specifies the `bucket` half.

The Rust authorities are `crates/stt-build/src/tiler.rs` (bucketing,
covering bounds, LOD validation) and `crates/stt-core/src/metadata.rs`
(`time_range`, `temporal_lod`); the TS authority is
`packages/core/src/archive.ts` (LOD selection, time-window pruning) and
`packages/playback/src/time-controller.ts` (the playhead). If this document and
the code disagree, the code wins — please open a PR.

## 1. Time base — Unix milliseconds, UTC

All times in STT are **`i64` Unix epoch milliseconds, UTC**. There is no
timezone field and no local-time concept anywhere in the format: the directory
key columns, the per-feature `start_time` / `end_time` columns, the metadata
`time_range`, every `temporal_bucket_ms`, and the playhead clock are all the
same scalar. A producer MUST convert wall-clock / calendar input to Unix-ms UTC
at build time; a consumer that wants local time applies the offset at the
presentation edge only.

This single-scalar choice is what lets the directory delta-code the time column
to ~1 byte per entry (§4 of the packed spec) and lets the GPU do per-frame time
filtering with one `f64`/`i64` uniform.

## 2. Feature time — instants and intervals

Every feature carries two absolute timestamps in its tile payload (see the
[payload schema](../architecture/data-format.md#per-layer-arrow-schema)):

| column       | type    | meaning                                  |
| ------------ | ------- | ---------------------------------------- |
| `start_time` | `Int64` | inclusive start of the feature's validity |
| `end_time`   | `Int64` | inclusive end of the feature's validity   |

- An **interval** feature (a trip, a storm cell's lifetime, a feature edit
  window) has `start_time < end_time`.
- An **instantaneous** feature (an earthquake, a single ping, a dropoff) is
  represented as `start_time == end_time`. When the input has no end-time field,
  the builder sets `end_time = start_time` (`crates/stt-build/src/columnar.rs`).

For LineStrings built with an end-time field, each *vertex* additionally carries
its own timestamp (the `vertex_time` column) so a trip animates along its path;
that per-vertex encoding is specified in the
[payload spec](../architecture/data-format.md#vertex_time-per-vertex-timestamps).
`start_time` / `end_time` remain the feature's overall span and are what
bucketing and pruning use.

## 3. Buckets — fixed-width, start-anchored

A **bucket** is a half-open interval `[b, b + temporal_bucket_ms)` on the
Unix-ms line. Buckets are **fixed-width** (the same `temporal_bucket_ms`
everywhere in a tier) and **anchored to the epoch**, not to any calendar unit:

```
bucket(t) = floor(t / temporal_bucket_ms) * temporal_bucket_ms
```

> **Calendar caveat (normative).** Buckets are fixed millisecond widths, never
> calendar-aware. A "1 month" LOD is `2_592_000_000 ms` = exactly **30 days**,
> *not* a calendar month; "1 year" would be `31_536_000_000 ms` = 365 days, with
> no leap-year handling. Producers that need calendar-aligned aggregation must
> pre-aggregate upstream and present the result as fixed-width buckets, or use
> the (future) [summary tier](../architecture/data-format.md). A reader MUST NOT
> assume bucket boundaries fall on calendar units.

### 3.1 Feature → bucket assignment

At build time a feature is placed in **exactly one** base-tier bucket — the
bucket containing its `start_time` (`tiler.rs`, `chunk_by_temporal_bucket`):

```
feature_bucket = floor(start_time / temporal_bucket_ms) * temporal_bucket_ms
```

A feature is **not** duplicated into every bucket its `[start_time, end_time]`
interval overlaps. This keeps the format lossless and compact (one physical copy
per feature), and pushes interval-overlap handling to read time via the covering
bound (§5). The consequence a reader MUST account for: a long-lived interval
feature lives in the tile of its *start* bucket, so a query window that opens
*after* the feature started must look *back* far enough to find it — which is
exactly what `cover_t_min` (§5) and the directory's per-leaf `t_min`/`t_max`
(§4.1 of the packed spec) make cheap.

### 3.2 The dataset bucket size

`metadata.temporal_bucket_ms` records the base-tier bucket width (set by
`stt-build --temporal-bucket`, default `1h`). It is **load-bearing for
prefetch**: the client enumerates exactly these bucket boundaries when looking
ahead in time during animation, so the chosen width is also the animation cache
granularity. Smaller buckets = finer scrub + more directory entries; larger
buckets = coarser scrub + fewer, fatter tiles.

```mermaid
flowchart LR
  subgraph Time["temporal_bucket_ms = 1h"]
    direction LR
    B0["bucket 00:00\n[t0, t0+1h)"]
    B1["bucket 01:00\n[t0+1h, t0+2h)"]
    B2["bucket 02:00\n[t0+2h, t0+3h)"]
  end
  F1["feature A\nstart 00:12"] --> B0
  F2["feature B (interval)\nstart 00:50 → end 02:30"] --> B0
  F3["feature C\nstart 02:05"] --> B2
```

Feature B spans three buckets but is stored once, in its start bucket (00:00).

## 4. Temporal LOD — the coarser-bucket pyramid

A multi-year dataset animated at the base bucket would stream an impractical
number of fine tiles when zoomed out. `stt-build --temporal-lod` emits one or
more **coarser-bucket tiers** alongside the base, each a strict aggregation of
the base buckets.

**Invariants (enforced at build, `tiler.rs`):**

- Each LOD level's `bucket_ms` MUST be **strictly greater than the base** and an
  **exact integer multiple** of `temporal_bucket_ms`.
- Levels are stored **sorted ascending** by `bucket_ms`.
- Each level carries a `max_zoom_level`: the deepest spatial zoom at which that
  coarse tier is still the right choice.

Recorded in metadata as:

```jsonc
"temporal_lod": [
  { "bucket_ms": 86400000,   "max_zoom_level": 8 },  // 1 day,  used up to z8
  { "bucket_ms": 2592000000, "max_zoom_level": 4 }   // 30 days, used up to z4
]
```

LOD tiles are tagged in the directory by their `temporal_bucket_ms` field, so a
base tile and its coarse-tier counterpart for the same cell are distinct
directory entries (and distinct blobs). A tile whose directory entry has no
`temporal_bucket_ms` belongs to the base tier (readers fall back to
`metadata.temporal_bucket_ms`).

### 4.1 Reader LOD selection

LOD tiers are **opt-in via the reader API** — unlike the summary tier, the
tileset does not switch to them automatically. An application calls
`STTArchive.pickTemporalLodForZoom(zoom)` (`archive.ts`), which returns:

> the **coarsest** level (largest `bucket_ms`) whose `max_zoom_level >= zoom`,
> or `undefined` if the zoom is deeper than every level (→ use the base tier).

then reads with `getTilesInBoundsForTemporalLod(...)`. The contract: zoomed out
and scrubbing a decade, read 30-day aggregates; zoomed in, read per-hour base
tiles.

```mermaid
flowchart TD
  Z{"current zoom"} -->|"z ≤ 4"| L30["30-day tier\n(bucket 2,592,000,000 ms)"]
  Z -->|"4 < z ≤ 8"| L1["1-day tier\n(bucket 86,400,000 ms)"]
  Z -->|"z > 8"| B["base tier\n(bucket 3,600,000 ms)"]
```

## 5. Read-time temporal pruning — `cover_t_min`

Because a feature lives only in its start bucket (§3.1), a query needs a tight
*lower* bound per tile to know whether to look at it. The directory carries one
per entry:

- **`time_start`** — the tile's bucket boundary (the entry's nominal start).
- **`cover_t_min`** — the **earliest `start_time` of any feature actually in the
  tile** (`tiler.rs`). It may be `<` or `>` `time_start` and is `≤ time_end`.
  Stored as a signed delta against `time_start` in the directory's covering
  section (§4 of the packed spec); `None` on pre-covering archives, where readers
  fall back to `time_start`.
- **`time_end`** — the tile's inclusive upper temporal bound.

A reader keeps a tile for a query window `[w_start, w_end]` iff:

```
time_end >= w_start  AND  (cover_t_min ?? time_start) <= w_end
```

(`archive.ts`, `getTileIdsInBounds`). The upper test uses the tight `time_end`;
the lower test uses the tight `cover_t_min`, so a tile whose data lies **entirely
after** the window is skipped without a fetch. At the page level, the paged
directory lifts the same idea to per-leaf `[t_min, t_max]` descriptors (§4.1 of
the packed spec) so a cold reader prunes whole leaf pages by time before
fetching them.

## 6. The playhead

Playback is driven by `TimeController` (`packages/playback`). Its time model:

- **`currentTime`** — the playhead, a single Unix-ms scalar.
- **`speed`** — a *signed effective rate* in **sim-ms per wall-ms** (direction ×
  magnitude). `speed: 3600` plays one hour of data per wall-clock second;
  negative plays backward.
- **`timeRange`** — optional `{ start, end }` (Unix-ms) clamp; the playhead
  loops, bounces, or clamps within it.
- **Frame-delta clamp** — a wall-clock gap is capped at `MAX_FRAME_DELTA_MS`
  (250 ms) before being scaled by `speed`, so a backgrounded tab resumes without
  teleporting the playhead. A longer gap is treated as dropped frames, never as a
  seek.

The clock advances `currentTime`; layers GPU-filter their resident tiles against
a window around it (no re-decode per frame); and the
[`PlaybackGovernor`](../api/playback-governor.md) gates the clock on a buffered
runway so the playhead never silently outruns loaded data. Those mechanics are
loading concerns, documented with the governor; the time *semantics* above are
what every consumer shares.

## 7. Mapping to OGC Tile Matrix Sets (normative)

STT's `(zoom, x, y, bucket)` addressing is an OGC **WebMercatorQuad** tile matrix
set with one additional, regularly-spaced **`time` dimension** — the shape
sketched (informatively) in Annex J of the *OGC Two Dimensional Tile Matrix Set*
standard. STT makes that shape concrete and normative. The machine-readable
definition ships as
[`tile-matrix-set.json`](./tile-matrix-set.json) (the standard WebMercatorQuad
matrices plus an STT `dimensions` block); the mapping is:

| STT concept | OGC TMS concept |
| --- | --- |
| `zoom` | `tileMatrix` identifier within the TileMatrixSet (WebMercatorQuad, z0–z24) |
| `x`, `y` | `tileCol`, `tileRow` (WebMercatorQuad, top-left origin) |
| `bucket` start, width `temporal_bucket_ms` | an extra dimension `{ "id": "time", "unitSymbol": "ms", "resolution": temporal_bucket_ms, "default": metadata.time_range.start }` |
| `metadata.time_range` | the dimension's `[start, end]` interval |
| `--temporal-lod` level | a per-`tileMatrix` coarser dimension `resolution` (bigger step at lower zoom) |

```json
{
  "id": "time",
  "unitSymbol": "ms",
  "resolution": 3600000,
  "interval": [1577836800000, 1735689599000],
  "default": 1577836800000
}
```

This is a *documentation and convergence* mapping, not a compliance claim: OGC
API – Tiles has no normative multi-dimensional conformance class today (its only
temporal hook is a `datetime` *filter parameter*, not an addressed axis). If one
is ratified, STT's directory is already expressible in its terms; until then the
[`tile-matrix-set.json`](./tile-matrix-set.json) artifact and this table are how
an external tool can reason about STT addressing in OGC vocabulary. See also
[OGC Moving Features](./stt-packed-format.md#102-ogc-moving-features-mf-json) for
the per-vertex trajectory lineage.

## 8. Summary of normative requirements

- **MUST** represent all times as `i64` Unix-ms UTC; no timezone or calendar
  semantics are carried by the format.
- **MUST** represent instantaneous features as `start_time == end_time`.
- **MUST** place each feature in exactly one base bucket
  (`floor(start_time / temporal_bucket_ms) * temporal_bucket_ms`); a writer MUST
  NOT silently duplicate a feature across buckets.
- LOD levels **MUST** be strictly-increasing exact multiples of the base bucket,
  stored sorted ascending, each with a `max_zoom_level`.
- A reader **MUST** prune by `time_end >= w_start AND (cover_t_min ?? time_start)
  <= w_end`, and **MUST** fall back to `time_start` when `cover_t_min` is absent.
- A reader **MUST NOT** assume bucket boundaries align to calendar units.
- A reader **SHOULD** select temporal LOD via `max_zoom_level` (coarsest level
  covering the zoom) when the application opts into the pyramid.

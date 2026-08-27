# STT Time Model — Specification

> **Scope:** the normative model for STT's _temporal_ axis — how time is
> represented on a feature, how features are bucketed into tiles, how the
> coarser-bucket pyramid works, and how a reader prunes by time. The spatial
> axis (WebMercator tile pyramid) and the byte container are specified in
> [`stt-packed-format.md`](./stt-packed-format.md); the per-tile payload is in
> [`../architecture/data-format.md`](../architecture/data-format.md). This page
> makes normative what those documents reference in passing.

STT is a spatial tile pyramid crossed with a temporal axis: a tile is addressed
by `(zoom, x, y, bucket)`. This document specifies the `bucket` half.

**This document is normative.** The reference implementations are
`crates/stt-build/src/tiler.rs` (bucketing, covering bounds, LOD validation)
and `crates/stt-core/src/metadata.rs` (`time_range`, `temporal_lod`) on the
Rust side, and `packages/core/src/archive.ts` (LOD selection, time-window
pruning) plus `packages/playback/src/time-controller.ts` (the playhead) on the
TS side. If an implementation and this document disagree, that divergence is a
**bug in one of them** — resolved by an erratum to whichever is wrong, never by
silently redefining the spec to match the code. Spec revisions follow the
stability promise in
[packed spec §9.1](./stt-packed-format.md#91-stability--versioning-promise).

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

> **Leap seconds (normative).** Times are Unix milliseconds, which have **no
> representation for a leap second** (there is no `23:59:60`). Whether an
> upstream feed smeared or stepped across a leap second is the **producer's
> presentation concern**: STT stores the Unix-ms scalar it is given and never
> reinterprets or adjusts it.

> **Non-negativity (normative).** Every _absolute_ feature and metadata time MUST
> be **non-negative** ms-since-epoch (`t ≥ 0`); the reference builder **rejects
> pre-1970 (negative) timestamps** in both strictness modes, because the
> in-memory temporal index is **unsigned** (`TimeRange.start`/`end` and
> `TileId.t` are `u64`). This narrows — it does not contradict — the `i64`
> payload/wire representation: the tile `start_time`/`end_time` columns are
> `Int64` and the directory codec stores **signed `i64`** values, so a
> `cover_t_min` _delta_ against `time_start` and a per-leaf `t_min`/`t_max`
> descriptor may be negative even though the absolute times they encode are not.

## 2. Feature time — instants and intervals

Every feature carries two absolute timestamps in its tile payload (see the
[payload schema](../architecture/data-format.md#per-layer-arrow-schema)):

| column       | type    | meaning                                   |
| ------------ | ------- | ----------------------------------------- |
| `start_time` | `Int64` | inclusive start of the feature's validity |
| `end_time`   | `Int64` | inclusive end of the feature's validity   |

- An **interval** feature (a trip, a storm cell's lifetime, a feature edit
  window) has `start_time < end_time`.
- An **instantaneous** feature (an earthquake, a single ping, a dropoff) MUST
  be represented as `start_time == end_time`. When the input has no end-time
  field, the builder sets `end_time = start_time`
  (`crates/stt-build/src/columnar.rs`).

For LineStrings built with an end-time field, each _vertex_ additionally carries
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

`temporal_bucket_ms` MUST be **> 0** — a zero or negative width makes
`bucket(t)` undefined — so a writer MUST NOT emit `temporal_bucket_ms == 0`.
The reference builder enforces this only when a temporal-LOD pyramid is
declared (`validate_temporal_lod`, `metadata.rs`); on the plain path a zero
width is silently **coerced to 1 ms** (`chunk_by_temporal_bucket`, `tiler.rs`)
rather than rejected, so a conformant reader MUST NOT rely on the builder to
catch it.

§3, §3.1 and §3.2 specify **fixed-bucket mode** — the default, and the only
mode a reader may assume. `stt-build --adaptive-temporal` replaces the grid
with data-driven windows; see §3.3.

> **Boundary semantics (normative).** Bucket _assignment_ is half-open;
> feature _validity_ is inclusive. An instant exactly on a bucket boundary
> (`start_time == b`) belongs to bucket `b` — never to the preceding bucket —
> because assignment is the floor formula above over half-open
> `[b, b + temporal_bucket_ms)`. Meanwhile a feature's `[start_time,
end_time]` interval is inclusive at **both** ends (§2), so an interval
> feature from an earlier bucket whose `end_time == b` is still _valid_ at
> the boundary instant even though no feature is ever _assigned_ to a bucket
> by its end. The two rules never conflict: assignment places bytes,
> validity drives pruning and rendering.

> **Calendar caveat (normative).** Buckets are fixed millisecond widths, never
> calendar-aware. A "1 month" LOD is `2_592_000_000 ms` = exactly **30 days**,
> _not_ a calendar month; "1 year" would be `31_536_000_000 ms` = 365 days, with
> no leap-year handling. Producers that need calendar-aligned aggregation must
> pre-aggregate upstream and present the result as fixed-width buckets, or use
> the [summary tier](../architecture/data-format.md#summary-tier-layers)
> (shipped — `stt-build --summary-tier`). A reader MUST NOT
> assume bucket boundaries fall on calendar units.

### 3.1 Feature → bucket assignment

At build time a feature is placed in **exactly one** base-tier bucket — the
bucket containing its `start_time` (`tiler.rs`, `chunk_by_temporal_bucket`):

```
feature_bucket = floor(start_time / temporal_bucket_ms) * temporal_bucket_ms
```

A writer MUST NOT duplicate a feature into every bucket its `[start_time,
end_time]` interval overlaps. This keeps the format lossless and compact (one
physical copy per feature), and pushes interval-overlap handling to read time
via the covering bound (§5). The consequence a reader MUST account for: a
long-lived interval feature lives in the tile of its _start_ bucket, so a query
window that opens _after_ the feature started must look _back_ far enough to
find it — which is exactly what `cover_t_min` (§5) and the directory's per-leaf
`t_min`/`t_max` (§4.1 of the packed spec) make cheap.

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

`metadata.time_range.start` is the first event time **floored to the coarsest
declared bucket width** (the base, or the largest `temporal_lod[].bucket_ms`
when a pyramid exists), so the range bounds the bucket-aligned tile _starts_
rather than naming the earliest feature; `time_range.end` is not aligned.
Adaptive-window builds (§3.3) apply no alignment.

### 3.3 Adaptive temporal windows (`--adaptive-temporal`)

`stt-build --adaptive-temporal <N>` replaces the fixed grid, **per spatial
cell**, with contiguous windows of ~`N` features each — dense periods get fine
windows, sparse periods coarse ones. In-memory (non-streaming) builds only. In
this mode the grid of §3 does not apply, and the following holds instead:

- A tile's `t` address is the window's **first feature timestamp**, not a
  multiple of any width. With `--adaptive-boundary-count <N>` (default `256`)
  that timestamp is snapped **down** onto a dataset-wide candidate set derived
  as quantiles of the timestamp distribution, so adjacent spatial cells land on
  the same fetch instants; `0` disables snapping, and a window whose snap would
  collide with the previous window's key keeps its exact timestamp.
- Features sharing one exact timestamp within a cell are **inseparable** — a
  window is never closed mid-run — so every `(z, x, y, t)` key stays distinct
  (`chunk_adaptive_dp` / `chunk_adaptive_by_count`, `tiler.rs`).
- The shared candidate instants are published as the additive manifest field
  `adaptiveBoundaries` (an ascending `i64` array, omitted when empty). That is
  how a client keeps §3.2's enumerate-ahead prefetch contract with no fixed
  width to step by. A reader that ignores the field still decodes every tile
  correctly; it merely prefetches less well.
- `metadata.temporal_bucket_ms` still records the `--temporal-bucket` value but
  does **not** describe the emitted windows; no `time_range` alignment is
  applied (§3.2); and trajectories are not sliced at bucket boundaries — a
  segment is assigned to a window by its start time. A bucket pyramid has no
  base width to multiply here, so the auto-tuner refuses to apply a budgeted
  `--temporal-lod` spec in this mode.
- `stt-serve` **rejects** `--adaptive-temporal` per request: a window is sized
  across a cell's whole time range, which a single-tile request cannot see.
  Pre-bake it with `stt-build`.

> **Status (normative scoping).** This mode is a shipped builder flag whose
> relationship to the fixed-grid model above is **under adjudication** — it is
> the highest-priority open semantic verdict in the project's formal-semantics
> register (`docs/roadmap/formal-semantics-2026-08.md` §5.5), whose candidate
> resolutions are to declare it as a tier variant or to withdraw it. Until that
> resolves, the fixed-grid MUSTs in §3 and §3.1 are scoped to fixed-bucket
> mode, and a reader MUST NOT assume an adaptive archive's `t` values are
> multiples of `metadata.temporal_bucket_ms`.

## 4. Temporal LOD — the coarser-bucket pyramid

A multi-year dataset animated at the base bucket would stream an impractical
number of fine tiles when zoomed out. `stt-build --temporal-lod` emits one or
more **coarser-bucket tiers** alongside the base, each a strict aggregation of
the base buckets.

**Invariants (enforced at build, `tiler.rs`):**

- Each LOD level's `bucket_ms` MUST be **strictly greater than the base** and an
  **exact integer multiple** of `temporal_bucket_ms`.
- Levels MUST be stored **sorted ascending** by `bucket_ms`.
- Each level MUST carry a `max_zoom_level`: the deepest spatial zoom at which
  that coarse tier is still the right choice.

**Content contract (normative).** Each level declares what a reader may assume
about its tiles in `temporal_lod[].contract`:

| `contract`            | a tile at this level contains                                           |
| --------------------- | ----------------------------------------------------------------------- |
| `"union"` (or absent) | exactly the base features, re-bucketed at the coarser width — lossless  |
| `"reduced"`           | **fewer** features than the base tier, derived by the declared `method` |

`contract` is optional and **absent means `"union"`**, so a manifest written
before the field existed stays valid and unchanged.

A `"union"` level MUST hold, for a given spatial cell, the union of the
features of every base bucket the coarse bucket `[B, B + bucket_ms)` spans —
identical features, identical geometry and times, **no reduction, aggregation,
or thinning**. It trades request count for bytes and nothing else, and a reader
may rely on feature identity between tiers (the same feature `id` resolves to
the same feature in every tier that contains it). A `"union"` level MUST NOT
carry `method` — a method there is a category error.

A `"reduced"` level is explicitly **not** lossless; the base tier stays
complete and addressable beside it. It MUST name `method`, one of `"m4"` or
`"minmaxlttb"`. A reduced level with no method is unreadable, because a reader
cannot know what was dropped. Both rules are enforced by
`validate_temporal_lod` (`metadata.rs`).

**Reader negotiation (normative).** A reader MUST NOT substitute any non-base
tier for base content unless it understands the declared `contract` (and
`method`, when reduced). An unrecognised contract or method is simply never
substituted — the reader falls back to the base tier — which keeps the
conservative-superset guarantee as the vocabulary grows.

Recorded in metadata as:

```jsonc
"temporal_lod": [
  { "bucket_ms": 86400000,   "max_zoom_level": 8 },  // 1 day, up to z8 (absent = union)
  { "bucket_ms": 2592000000, "max_zoom_level": 4,    // 30 days, up to z4
    "contract": "reduced", "method": "minmaxlttb" }  // fewer features, by MinMaxLTTB
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
tiles. A reader that opts into the pyramid SHOULD select its tier that way — the
coarsest level whose `max_zoom_level` covers the current zoom.

```mermaid
flowchart TD
  Z{"current zoom"} -->|"z ≤ 4"| L30["30-day tier\n(bucket 2,592,000,000 ms)"]
  Z -->|"4 < z ≤ 8"| L1["1-day tier\n(bucket 86,400,000 ms)"]
  Z -->|"z > 8"| B["base tier\n(bucket 3,600,000 ms)"]
```

## 5. Read-time temporal pruning — `cover_t_min`

Because a feature lives only in its start bucket (§3.1), a query needs a tight
_lower_ bound per tile to know whether to look at it. The directory carries one
per entry:

- **`time_start`** — the tile's bucket boundary (the entry's nominal start).
- **`cover_t_min`** — the **earliest `start_time` of any feature actually in the
  tile** (`tiler.rs`). It may be `<` or `>` `time_start` and is `≤ time_end`.
  Stored as a signed delta against `time_start` in the directory's covering
  section (§4 of the packed spec); `None` on pre-covering archives, where a
  reader MUST fall back to `time_start`.
- **`time_end`** — the tile's inclusive upper temporal bound. A writer MUST
  set it to the **maximum feature `end_time` actually in the tile** — the
  _tight_ bound, not the nominal bucket end `time_start +
temporal_bucket_ms - 1`. This is load-bearing for correctness, not an
  optimization: an interval feature lives only in its _start_ bucket (§3.1),
  so it is findable by a later query window **only because** `time_end` was
  widened to cover it. A writer emitting nominal bucket ends would produce a
  dataset that decodes cleanly yet silently loses every interval feature from
  queries after its start bucket — the reader's prune below would discard the
  tile. (When every feature ends inside the bucket, the tight bound is _below_
  the nominal end and additionally saves wasted fetches.)

A reader MUST keep a tile for a query window `[w_start, w_end]` iff:

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
- **`speed`** — a _signed effective rate_ in **sim-ms per wall-ms** (direction ×
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
loading concerns, documented with the governor; the time _semantics_ above are
what every consumer shares.

## 7. Mapping to OGC Tile Matrix Sets (normative)

STT's `(zoom, x, y, bucket)` addressing is an OGC **WebMercatorQuad** tile matrix
set with one additional, regularly-spaced **`time` dimension** — the shape
sketched (informatively) in Annex J of the _OGC Two Dimensional Tile Matrix Set_
standard. STT makes that shape concrete and normative. The machine-readable
definition ships as
[`tile-matrix-set.json`](./tile-matrix-set.json) (the standard WebMercatorQuad
matrices plus an STT `dimensions` block); the mapping is:

| STT concept                                | OGC TMS concept                                                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `zoom`                                     | `tileMatrix` identifier within the TileMatrixSet (WebMercatorQuad, z0–z22 — `MAX_ZOOM`, `tile.rs`)                                |
| `x`, `y`                                   | `tileCol`, `tileRow` (WebMercatorQuad, top-left origin)                                                                           |
| `bucket` start, width `temporal_bucket_ms` | an extra dimension `{ "id": "time", "unitSymbol": "ms", "resolution": temporal_bucket_ms, "default": metadata.time_range.start }` |
| `metadata.time_range`                      | the dimension's `[start, end]` interval (`start` is bucket-aligned, §3.2)                                                         |
| `--temporal-lod` level                     | a per-`tileMatrix` coarser dimension `resolution` (bigger step at lower zoom)                                                     |

```json
{
  "id": "time",
  "unitSymbol": "ms",
  "resolution": 3600000,
  "interval": [1577836800000, 1735689599000],
  "default": 1577836800000
}
```

This is a _documentation and convergence_ mapping, not a compliance claim: OGC
API – Tiles has no normative multi-dimensional conformance class today (its only
temporal hook is a `datetime` _filter parameter_, not an addressed axis). If one
is ratified, STT's directory is already expressible in its terms; until then the
[`tile-matrix-set.json`](./tile-matrix-set.json) artifact and this table are how
an external tool can reason about STT addressing in OGC vocabulary. See also
[OGC Moving Features](./stt-packed-format.md#102-ogc-moving-features-mf-json) for
the per-vertex trajectory lineage.

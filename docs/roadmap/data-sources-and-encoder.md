# Data sources & encoder architecture — learnings + roadmap

*Cross-cutting design record distilled from the 2026-06 PostGIS + DuckDB parity
work. It captures the architectural learnings that surfaced while making
file / PostGIS / DuckDB ingest **and** dynamic serve produce identical STT across
every generation variation, and turns them into a prioritized roadmap for the
DB path and the packages it touches (`stt-core` encoder, `stt-build`,
`stt-serve`, `stt-validate`, the Python extractors, and the TS packages).*

Pairs with [db-input-adaptors.md](./db-input-adaptors.md) (the shipped PostGIS +
DuckDB work) and [preprocessing-framework.md](./preprocessing-framework.md) (the
analytics-baking design that several items below feed into). **This doc is the
single owner of the open DB-path + encoder backlog** (§4) — the DB adaptor doc
points here rather than re-listing follow-ups.

---

## 1. What the parity work taught us

The reason comprehensive DB parity was *concentrated, not sprawling* is one good
seam and a few recurring smells:

1. **`ParsedFeature` is the source-agnostic boundary, and that's the whole game.**
   Everything downstream (tiler → encoder) reads only `ParsedFeature`, so a new
   input adaptor is "produce the same struct" and nothing else changes. Keeping
   pipeline stages reading from a well-defined intermediate representation is what
   made the work tractable. **Corollary:** the Python extractors are a *fourth*
   input adaptor (they emit GeoParquet, then shell to `stt-build`) — they ride the
   same seam, but their flag-construction logic lives outside it (see #5).

2. **Process-wide mutable globals are a silent-divergence + concurrency footgun.**
   The encoder reads six process-wide statics (`stt-core/src/arrow_tile.rs:607–791`:
   vertex-time precision, coord quantization, attr quantization, attrs-auto,
   vector groups, point-elevation). The *original* serve bug was exactly this:
   `stt-serve` never called the setters, so quantized/vector-grouped datasets
   served subtly wrong tiles with **no error**. The same globals also blocked
   running two configs in one process — which is why the parity suite couldn't
   vary quantization across parallel tests, and why `stt-serve` was structurally
   single-dataset-per-process until the P0 `EncoderConfig` threading (§4) removed
   the constraint.

3. **Silent degradation is the dangerous failure mode.** The DB readers dropped
   per-vertex columns to `None` with no warning — an entire dataset class lost
   fidelity invisibly. The codebase already has the *right* antidote in places
   (geometry-skip and timestamp-coercion emit counted warnings); the lesson is to
   apply it everywhere data is dropped.

4. **Parity is provable at the intermediate representation, not the bytes.** Raw
   byte comparison is fragile (non-deterministic encoding/dedup, Arrow-metadata
   `HashMap` order, within-tile feature order). The robust contract is exact
   `ParsedFeature` equality + per-tile `(zoom,x,y,t_start,t_end,feature_count)`
   key-sets, order-independent (`crates/stt-build/tests/common/mod.rs`).

5. **Any spec interpreted in two places drifts.** `stt-serve` had silently drifted
   from the CLI (ignored most flags) until `build_options.rs` made one source of
   truth. The coordinate/vertex name sets were triplicated across the three
   readers (now deduped — §3). The Python extractors construct `stt-build` flags
   independently of the Rust CLI; the showcase keeps dual-copy palettes
   (`av_common` py ⇄ `datasets.ts`) that "must match".

6. **WKB is the ingest lingua franca; bundled/in-process is the CI win.** All
   readers bridge geometry through WKB → `parse_wkb_geometry` (GeoArrow-native
   encodings are rejected on input). DuckDB-bundled let parity run in CI with zero
   infra (we even sidestepped the spatial-extension network install via
   `read_parquet` + a BLOB WKB column); PostGIS needs a live server, so it's gated.

7. **Factoring the smallest reusable unit enables online + offline reuse.**
   `encode_single_tile_counted` sharing the full `build_tile`/`encode_tile` path
   is the *only* reason serve parity was "set the config", not "reimplement the
   tiler". The summary tier and preprocessing analytics aren't factored that way
   yet — doing so is what would let them be served dynamically.

---

## 2. Shipped in this pass

- Per-vertex columns (`vertex_timestamps`/`vertex_values`/`vertex_value_matrix`)
  bridge through both DB readers; NaN-float and coordinate-name divergences closed
  (lessons #1, #3). file ≡ DuckDB ≡ PostgreSQL pinned by `source_parity.rs`
  (lesson #4).
- `stt-serve` full generation parity via the shared `build_options.rs` (lesson #5);
  µs/ns vertex-timestamp acceptance unified in the file reader (lesson #1/#4);
  serve advertises `temporal_lod` in `/metadata.json`.

## 3. Shipped alongside this roadmap (the cheap wins)

- **Deduped the coordinate/vertex name sets** into shared `crate::input`
  predicates (`is_coordinate_column_name`, `is_vertex_metadata_column`,
  `VERTEX_METADATA_COLUMNS`) used by all three readers — removes the
  triplication that this very work introduced (lesson #5).
- **`stt-serve` logs its active parity-affecting tile config at startup** so an
  operator can confirm it matches the offline build (observability against
  lesson #2's silent drift).

---

## 4. Roadmap

Priority = impact × how much it unblocks. Effort is rough. Status is *planned*
unless noted.

### P0 — thread encoder settings instead of globals  ·  flagship  ·  **SHIPPED (contained cut)**
**Lesson #2.** Done: `stt-core` gained an explicit `EncoderConfig` value type plus
`encode_tile_with` / `encode_layer_with` — a private `encode_{tile,layer}_cfg`
now drives all encoding from an explicit config (the six global-read sites read
from it). Every existing public fn (`encode_tile`, `encode_layer`,
`encode_tile_quantized`) is kept as a thin back-compat wrapper that snapshots the
globals via `EncoderConfig::from_globals()`, so the ~35 test/example/validate
callers are untouched. `stt-serve` now `resolve()`s an explicit `EncoderConfig`
(via `build_options::EncoderSettings::resolve`, **no global mutation**) and
threads it per request through `encode_single_tile_counted` — so it can host
several datasets/configs concurrently without touching shared state. Regression
test `arrow_tile::encode_tile_with_is_config_driven_not_global` proves two
configs in one process yield distinct, config-driven tiles; verified live
(`--quantize-coords` shrinks the served tile's geometry column via the explicit
path). stt-core 130 tests + all encode consumers (stt-validate/stt-optimize)
green.

**Follow-up (retire the globals entirely) — COUNTED OUT 2026-07-01:** the offline
`stt-build` CLI still uses the global setters (`EncoderSettings::apply`) — fine
for a one-shot process (one archive = one config). Plumbing `EncoderConfig`
through the config-agnostic `TileWriter::write_tile` impls is cleanliness with
no correctness payoff; the globals are vestigial and single-writer. Revive only
if the offline builder ever needs multiple configs in one process.

**Surfaced along the way:** the multi-config test reproduced the **known
non-deterministic Arrow-metadata ordering** — two logically-identical encodes
differ byte-wise (map iteration order). That's the P1 reproducible-build guard
below; the test deliberately asserts config-driven *inequality* (wire column
type changes), not byte-equality.

### P1 — multi-dataset serve + packed-manifest facade  ·  effort: M  ·  **multi-dataset serve SHIPPED**
**Lessons #2, #7.** Done — `stt-serve --config <file.json>` hosts a registry of
datasets, each `{source, TileConfig, EncoderConfig, backend pool}`, routed
`/{dataset}/tiles/…` + `/{dataset}/metadata.json`, with `/datasets` as the
catalog. The config file's per-dataset schema reuses the CLI `Args` (made
`Deserialize` with `Default` = the clap defaults, so config-file and CLI share
one source of default truth; keys are the kebab-case flag names;
`deny_unknown_fields` catches typos). Single-dataset flag mode still serves at
the root, backward-compatible. This is the concrete P0 payoff: each dataset
carries its OWN explicit `EncoderConfig`, so datasets with different quantization
coexist concurrently in one process — **live-verified**: the same tile served
from a plain vs a `quantize-coords` dataset in one process returns a stable
384-byte-smaller geometry column for the quantized one, which the old
process-wide globals made impossible.

**Packed-manifest facade — COUNTED OUT 2026-07-01 (stays deferred):** a
`/manifest.json` + range-served packs so the existing TS `ArchiveReader` can
point at `stt-serve` directly (the dynamic `/metadata.json` is a bespoke
camelCase descriptor; the packed reader expects the snake_case manifest +
content-addressed packs). Orthogonal to the dynamic-serve path, and no consumer
asks for it — the showcase talks to R2-hosted packed datasets, and dynamic
clients use `/metadata.json`. Revive when a client genuinely needs one reader
across both static and live sources.

### P1 — loud degradation + `stt-validate` "dropped" accounting  ·  effort: S–M  ·  **DB readers SHIPPED**
**Lesson #3.** Done for the DB ingest path (both readers, symmetric): the
streaming loop tracks which property columns produced a value in ANY row and
warns once at the end about columns that carried nothing — the silent-drop cases
(unmappable column type, or entirely NULL) — naming them. Sidesteps the
PostGIS-types-vs-DuckDB-`ValueRef` asymmetry by tracking *observed values*, not
schema types (so no false positives about "was data actually dropped"), with an
early-stop once all columns are seen. Ingest-only: the per-tile serve decoders
don't call it, so a live server never spams. Live-verified (a `uuid` + a
`float8[]` column ⇒ "2 … columns carried no value … dropped: uid, windarr").

**File reader — SHIPPED 2026-07-01:** the GeoParquet reader now carries the same
end-of-read accounting (`warn_dropped_property_columns` in
`crates/stt-build/src/input.rs`) — tracks which property columns produced a value
in ANY row across all batches and warns once at EOF naming the silent-drop
columns as `name (ArrowType)`. All three input adaptors now degrade equally
loudly. (Length-mismatched vertex arrays were already logged once at the reader.)

**`stt-validate` surfacing — COUNTED OUT 2026-07-01:** rolling build-time drop
counts into one validate report requires the builder to persist them into the
manifest/metadata first — a small format addition that shouldn't ride along
casually. The build log now names every drop loudly; revive the validate
surfacing together with the next manifest-schema rev.

### P1 — determinism / reproducible-build guard  ·  **CLOSED 2026-07-04 (arrow ≥59 shipped)**
**Lesson #4** + the **non-deterministic-encoding/dedup bug** (Arrow metadata
`HashMap` ordering), which undermined content-addressed pack dedup and
reproducible builds. Closed end-to-end:

- **Encoder side DONE:** field/schema metadata is assembled from sorted
  `BTreeMap`s (`arrow_tile.rs`), removing our own contribution.
- **Upstream fix SHIPPED:** the workspace arrow upgrade (54 → 59, landed with
  the 2026-07 transcode-removal batch) brought arrow-ipc 59's sorted
  `metadata_to_fb` (`ordered_keys.sort()` — verified against the arrow-rs
  source 2026-07-01), closing the serialize-time ordering gap. No local
  flatbuffer canonicalization was ever written, per the recorded plan.
- **Acceptance gate ACTIVE:** `crates/stt-core/tests/reproducible_build.rs`
  now runs `same_tile_encodes_byte_identically` un-`#[ignore]`d alongside the
  logical-fingerprint reproducibility (500 reps) + stable-length guards —
  builds are byte-reproducible cross-process; see
  `docs/spec/stt-packed-format.md` §7 D6 for the normative statement.

### P2 — single source of truth for build flags across the language boundary  ·  **COUNTED OUT 2026-07-01**
**Lesson #5.** The Python extractors (`av_common.run_stt_build` + batch scripts)
hand-assemble `stt-build` flags; the showcase palettes are dual-copied. Counted
out because the drift risk is now mechanically guarded without codegen:
`test_av_palette_parity.py` value/key-locks the palettes, and the F9 CLI gates
(`cli_flags_are_documented_in_cli_reference` per binary) catch flag-surface rot.
A cross-language flag *spec* would add build machinery for a low-churn surface.
Revive if the flag surface churns enough that the parity tests become the
bottleneck.

### P2 — DB serve hardening  ·  triaged 2026-07-01
Carried over from the DB integration docs, now that the generation surface is at
parity:
- **TLS** for the PostGIS reader — **COUNTED OUT**: NoTls/localhost is the
  documented posture (the error text says so); the deadpool/tokio-postgres stack
  takes `postgres-native-tls` cleanly whenever a non-localhost deployment
  actually appears.
- **Reverse-proxy cache guidance + in-process LRU** — **COUNTED OUT**: an app
  cache needs a staleness policy the server can't infer (the source is a LIVE
  table — cached tiles silently go stale on writes). The documented answer stays
  "put a reverse proxy with an explicit TTL in front"; revive the LRU only with
  a user-supplied freshness contract (e.g. an `--immutable-source` flag).
- **Integer-epoch time column in the serve tile-query filter** — **SHIPPED.**
  `build_tile_query` / `build_metadata_query` (both readers) + the PostGIS
  metadata aggregate now take `--time-format` and switch the time predicate
  between the timestamp path (`to_timestamp`/`epoch_ms`, the `iso8601` default)
  and a numeric path for integer columns (`UnixMs` direct, `UnixSec` scaled ×1000
  so the ms bucket bounds stay exact). Unit-tested (both readers) + live-verified:
  serving `hurricane_obs` through a computed `bigint` epoch-ms column
  (`--time-field t_ms --time-format unix-ms`) yields a byte-identical tile + the
  same advertised `timeRange` as the timestamp column.
- **`--source-srid` reproject in serve** — documented out-of-scope today (a
  per-tile transform defeats the spatial index); revisit with a generated 4326
  column or functional index.
- **Whole-dataset passes under `--streaming-arrow`** (summary tier, heatmap
  domain, metadata-output) — **COUNTED OUT**: the combination is rejected loudly
  at startup (never a silent drop), and every current dataset that needs those
  passes fits the in-memory pipeline. Revive with the first DB table that is both
  too big for memory and needs a summary tier.

### P2 — factor summary / preprocessing to a per-unit core  ·  **COUNTED OUT 2026-07-01**
**Lesson #7.** Give the summary tier (and, later, the
[preprocessing-framework](./preprocessing-framework.md) operators) an
`encode_single_cell`-style core so a dynamic server can compute one aggregated
cell per request, exactly as `encode_single_tile_counted` does for raw tiles.
Counted out: sequenced behind the preprocessing framework (whose Plan-IR would
reshape exactly this seam) — building it now means building it twice. Revive
with that framework's Phase 1–2, or with a concrete dynamic-analytics-serve ask.

### P3 — WKB ↔ GeoArrow output alignment  ·  **COUNTED OUT (decision-blocked)**
**Lesson #6** + the deck-ext friendliness audit (P2 "strategic fork =
GeoArrow-align geometry"). Ingest standardizing on WKB is fine; the open question
is the *output* tile geometry encoding. Track here so the ingest-side WKB choice
and the output-side GeoArrow question stay connected in one place.

---

## 5. Quick reference — where each lesson lives in code

| Lesson | Anchor |
|---|---|
| `ParsedFeature` seam | `crates/stt-build/src/input.rs` (struct + the three readers) |
| Encoder globals | `crates/stt-core/src/arrow_tile.rs:607–791` (statics + setters) |
| Shared flag→config | `crates/stt-build/src/build_options.rs` |
| Per-tile reuse | `crates/stt-build/src/tiler.rs` `encode_single_tile_counted` |
| Parity comparator | `crates/stt-build/tests/common/mod.rs`, `source_parity.rs` |
| Shared name predicates | `crates/stt-build/src/input.rs` `is_coordinate_column_name` / `is_vertex_metadata_column` |

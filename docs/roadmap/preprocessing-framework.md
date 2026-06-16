# STT Preprocessing Framework — "Bake the analytics into the tiles"

*Design synthesis, 2026-06-16. Grounds a SoTA survey (tiling pipelines, spatiotemporal
cube theory, dataframe engines, build-systems, declarative config, incremental computation,
determinism) against the current `stt-generate` → `stt-build` → packed-format pipeline.*

---

## 0. The one principle everything follows from

> **Read-time cost should depend on output resolution (cells × time-buckets × dimensions),
> never on N (record count).** Anything expensive that can be made a pure function of the
> input — layouts, clusters, aggregations, trend statistics, tessellation, ordering — is
> *baked once at build time* and shipped as a cheap-to-read artifact.

Every system we surveyed (tippecanoe, Planetiler, PMTiles, COPC, Datashader, Nanocubes,
imMens, Gaussian Cubes, Supercluster, flowmap.gl) is one realization of this. STT already
lives here for a few datasets (BIXI clustering, flow-corridor value-matrix, summary tiers).
The framework's job is to make this the *default, reusable* path for every dataset instead
of bespoke per-generator code.

Two corollaries that shape the whole design:

1. **Conserve, don't discard** (your existing "no-thinning" principle). The build's job is to
   *aggregate and reorganize* so the GPU sees a tractable number of primitives — not to throw
   data away. Dropping stays strictly opt-in; **aggregation/coalescing is the conserving
   alternative** and becomes a first-class operator.
2. **Determinism is load-bearing, not cosmetic.** Content-addressed packs only dedup, edge-cache,
   and incrementally rebuild if identical logical input → identical bytes. The known
   *non-reproducible-packs bug* (Arrow-metadata HashMap iteration order) silently breaks all
   three. **This is the prerequisite, fixed first.**

---

## 1. What exists today (the seams we plug into)

```
raw data ──► stt-generate (per-dataset Rust) ──► GeoParquet intermediate ──► stt-build ──► packed format
             ▲ 40–50% copy-paste drift           ▲ explicit PropertyColumn   ▲ tiler+summary  ▲ manifest + CAS packs
             │ no shared Dataset trait              typing, vertex_value_matrix  +quantize+pack   + paged directory v5
```

**Strong foundations already in place** — the framework *formalizes* these, it does not replace them:

- **Columnar intermediate** (GeoParquet, streaming writers, explicit `PropertyColumn::numeric/string`).
- **`vertex_value_matrix`** = a per-vertex × per-bucket grid. *This is already a space-time cube /
  OLAP cuboid.* It is the single most important existing primitive; the framework generalizes it.
- **Build-time levers wired**: temporal LOD, summary tier (H3/Quadbin), coordinate + vertex-time
  quantization, Visvalingam + TD-TR simplification, pre-tessellation, per-feature LOD bands,
  opt-in budget/drop, blob-ordering (`Auto`/Hilbert3/spatial/morton).
- **Content-addressed packs + paged directory** (bounds + `[t_min,t_max]` on page pointers).
- **`SttBuildOptions`** — the one launcher bridging every generator to the CLI.

**The seams (where the framework lands):**

| Pain point (from audits) | Framework answer |
|---|---|
| Per-dataset generator drift; no `Dataset` trait | **§4 Recipes**: declarative spec + thin trait escape hatch |
| Aggregators bespoke (`BixiAggregator`, `FlowAggregator`) | **§3 Operator library**: one generic aggregation/cluster/cube layer |
| `budget.rs` shipped unused; features bolted on | **§2 Plan IR**: operators compose; budget is just another stage |
| Non-reproducible packs; fleet re-transcode is all-or-nothing | **§5 Determinism + CAS + incremental**: byte-stable, early-cutoff rebuilds |
| Average-of-averages risk in summaries | **§3.3 OLAP measure classification** |
| Count-only summary tiles | **§3.3 Sufficient statistics** (mean/variance/trend free at read time) |

---

## 2. Architecture: the build as a declarative dataflow DAG

Every idiomatic engine we looked at (DataFusion `LogicalPlan→ExecutionPlan`, Polars `LazyFrame`,
DuckDB parser→optimizer→exec) builds a **plan first, executes later**. Adopt the same shape for
the tile build. This is the spine.

### 2.1 The Plan IR

A dataset's build is a **`Vec<Stage>`** — an ordered, serde-tagged operator pipeline over an
Arrow-columnar dataflow, with a logical/physical split:

```
Source ─► Normalize ─► Transform* ─► SpatialIndex ─► TemporalBin ─► Aggregate/Cluster/Analyze* ─► Encode ─► Pack
 (bronze)   (silver: CRS, dateline,                  (the "where")   (the "when")   (the bake — §3)        (gold)
            dedup, schema-validate)
```

- **Logical** layer says *what* ("cluster stations per zoom band", "roll up counts to parent cells").
- **Physical** layer picks *how* (Supercluster greedy-merge vs. grid bin; in-RAM vs. streaming).
- Stages are **internally-tagged enum variants** (`#[serde(tag="op")]`): `Filter`, `Reproject`,
  `Quantize`, `Simplify`, `Index`, `Bin`, `Aggregate`, `Cluster`, `Hotspot`, `Bundle`, `Encode`,
  `Pack`. Free serde (de)serialization, exhaustive `match`, diffable specs.

This buys, for free, what bespoke generators don't have:

- **`stt-build explain <recipe>`** — print the optimized DAG before running anything (cf. `EXPLAIN`).
- **Optimizer passes** as composable named tree-rewrites (DataFusion's `OptimizerRule` template):
  *fuse* reproject+quantize; *push* a bbox/time filter into the scan (predicate pushdown → skip
  Parquet row-groups, directly attacking the 180× over-fetch class); *common-subplan elimination*
  so the shared scan/reproject is computed **once** and forked into detail + summary + raster tiers
  (today each tier re-scans).
- **Validation before I/O** — reject unknown ops/fields eagerly (`deny_unknown_fields`).

### 2.2 Engine choice: native operators, DataFusion-shaped

Build the operators as native Rust over Arrow `RecordBatch` (keep the zero-copy story to the GPU
intact). Borrow DataFusion's **extension contracts** rather than its engine:

- **`Source` trait = `TableProvider` analogue.** `scan()` is lightweight (describe), real work
  streams in a `SendableRecordBatchStream`. One contract ingests Parquet, CSV, and bespoke `.sttp`
  packs. Advertise pushdown as **Exact / Inexact / Unsupported** (tri-state) so a source says what
  it can skip vs. what the builder must re-filter.
- **Pull-based streaming Arrow** end-to-end → bounded memory (fixes the "buffers all tiles in RAM,
  fails >10GB" gap; the in-memory path becomes the small-data special case of the streaming path).

> If we ever want SQL-defined transforms, embedding DataFusion as the *Transform* stage executor is
> the clean path (it brings pushdown, UDFs, custom nodes). Recommendation: **start native**, keep the
> door open. Decision D1 below.

### 2.3 Medallion staging — formalize the intermediates

Name the three artifact tiers (Databricks medallion; matches your existing "keep paths intermediate
enables OSRM-free re-binning" instinct):

- **Bronze** — raw ingested rows, unmodified + provenance (source URL, fetch epoch from *config*,
  not wall-clock — §5).
- **Silver** — cleaned/conformed: CRS-normalized, dateline-clipped, deduped, schema-validated,
  map-matched routes, typed `PropertyColumn`s. **The expensive-but-reusable layer.** OSRM routing,
  particle advection, GBIF taxonomy lookups all materialize here once.
- **Gold** — binned, quantized, packed tiles.

Payoff (proven at Databricks): **any layer is recreatable from raw at any time**, and cheap
re-binning/re-packing happens without re-ingesting or re-routing. Re-bucketing nyc-taxi-paths
becomes a silver→gold step, not a from-scratch rebuild.

---

## 3. The operator library — *what to bake*

This is the heart. Grouped by axis. Each is a reusable `Stage`, replacing today's per-dataset code.

### 3.1 Spatial operators

| Operator | What it bakes | SoTA lesson |
|---|---|---|
| **Reproject / Quantize** | fixed-point integer coords on a tile-local grid | Quantize *before* dedup/topology — a **correctness prerequisite** (near-identical floats must become bit-identical for shared-edge/dedup), not just a size win. Your `--quantize-coords` exists; make it a pipeline stage and run it pre-dedup. |
| **Index (DGGS)** | hierarchical cell ID per feature (Quadbin / H3 / S2) | **Prefer perfect-nesting quadtrees (Quadbin/S2) for roll-up** — parent = exact union of 4 children, so multi-zoom aggregation is one bottom-up pass. H3 is *index-exact but geometry-approximate* (children cross parent edges) — fine for neighbor/flow, wrong for exact roll-up. Quadbin is cheapest for STT: its IDs are 1:1 with the XYZ tiles deck.gl already requests. Encode level in the ID's lowest-set-bit → "all descendants" = an integer `BETWEEN` range (feeds the paged-directory bounds work). |
| **Simplify (one ranking, many zooms)** | per-vertex Visvalingam **effective-area** stored *inline* | **The highest-value multi-res trick.** Run VW once, store each vertex's effective area as a z-value; every zoom is then a pure *filter* (`drop vertices with area < threshold-at-zoom`) — no per-zoom geometry materialization. (cf. 3D-Tiles geometric error.) You already use VW; today it re-simplifies per zoom. Prefer VW over Douglas-Peucker precisely because DP's ranking is recursive, not a flat per-vertex weight. |
| **Cluster (per-zoom, Supercluster)** | one greedy weighted-centroid clustering pass per zoom; flat stride array + index per zoom; zoom-packed cluster IDs | Steal Supercluster wholesale; generalizes your BIXI `ClusterHierarchy`. **Add a temporal radius to the merge predicate** (ST-DBSCAN's two-eps idea, applied *greedily not transitively*) → spatiotemporal clusters without the global cost. Cluster radius is a **screen-space pixel** budget. |
| **bbox covering** | per-feature xmin..ymax scalar columns | GeoParquet 1.1 covering: plain columns the container already keeps min/max stats on → row-group skipping / spatial pushdown with no bespoke index. |

### 3.2 Temporal operators

| Operator | What it bakes | SoTA lesson |
|---|---|---|
| **Bin / Temporal LOD** | fixed or adaptive time-bucket assignment + coarse pyramid levels | You have `--temporal-bucket` / `--temporal-lod`. Make adaptive chunking (density-targeted bucket width) a first-class stage, not a flag. |
| **Time-series codec** | per-cell value-over-time array with a per-array codec | Choose codec per column from data shape: **delta-of-delta** on regular timesteps, **Gorilla XOR** on floats, **RLE** on constant runs, dict on low-cardinality — and **fall back to raw when a codec would expand**. Store sparse (only non-empty entries), never the dense `cells×steps` upper bound. *Validate vendor compression numbers on real tiles.* |
| **Cumulative prefix-sum** | running totals along the time axis | Any `[t_min,t_max]` window becomes **two subtractions** at read time. Pairs with the `[t_min,t_max]` page-pointer bounds. |

### 3.3 Aggregation & analytics operators — *the cube*

This is where STT's `vertex_value_matrix` gets its theoretical backbone and its biggest cheap win.

**(a) Classify every measure (OLAP rule — prevents the average-of-averages bug):**
- **Distributive** (SUM/COUNT/MIN/MAX) → roll up freely, bake at every zoom.
- **Algebraic** (AVG/STD/covariance) → **store the distributive *components*** (sum, sum², count),
  derive on read. Never store the derived average and re-average it at the parent.
- **Holistic** (MEDIAN/distinct-count/MODE) → can't roll up; compute per-zoom from raw at build, or skip.

**(b) Bake sufficient statistics, not just counts (Gaussian Cubes — the cheap high-leverage upgrade).**
For each cell store `{ n, Σx, Σx² }` (and `Σxy` for pairs) as a few extra additive channels alongside
count. At read time you reconstruct **mean, variance, correlation, linear trend, even PCA** in O(d³),
*independent of N, with no rebuild* — the client can switch what it visualizes without touching the
build. This is a handful of f32 columns on the summary tier; it is the single best ROI add to a
count-only tile system.

**(c) The zoom pyramid IS a partial OLAP cuboid lattice — don't full-materialize.** Materialize only
the tiers you serve (shell-fragment); below a min-support count, fold cells (iceberg-cube — your
`--drop-densest` knob, now justified by anti-monotonicity). This *is* the "summary tier is opt-in"
principle in OLAP terms.

**(d) Separate aggregation from shading (Datashader).** Bake the aggregate grid once (count + sum +
min/max in one pass); all colormapping/spreading/normalization is O(pixels) and re-runnable at read
time. The client recolors / rescales without a rebuild.

**(e) Decompose to ≤4-D dense data tiles for GPU roll-up (imMens).** For brushing/linked views you
never need the full cross-product — ≤4 dimensions suffice; dense-over-sparse is branch-free for GPU.

**(f) Spatiotemporal analytics that bake cleanly:**

| Analysis | Verdict | How |
|---|---|---|
| **KDE density raster** | ✅ bake | tiled per-zoom KDE (+ bandwidth halo); quantized u8/u16 raster tier; GPU samples one texture. The principled, deterministic heatmap. |
| **Getis-Ord Gi\* hotspots** | ✅ bake (with a caveat) | one global stats pass → per-(cell, t-bucket) z-score + bin(−3..+3). Emerging-Hot-Spot maps *exactly* onto the space×time tile cube. Caveat: valid only for the baked grid/bandwidth/window — changing them needs a rebuild (fine under this model). |
| **Mann-Kendall / linear trend** | ✅ bake | per-cell trend statistic from the sufficient stats; ESRI ships exactly this in its space-time cube. |
| **TRACLUS trajectory** | ⚠️ split | bake the MDL **partition** phase (per-trajectory, local; complements OSRM vertex-times); skip the global grouping — use the flow-corridor matrix instead. |
| **ST-DBSCAN / HDBSCAN** | ❌ don't tile | density-connectivity / MST is whole-dataset; tile-local results are *wrong*. Run **offline once** on the full dataset, bake the resulting **cluster labels** as a per-point property. The algorithm stays global; only its output enters a tile. |

### 3.4 Trajectory / flow operators (generalize the BIXI + nyc-flows work)

- **Map-match** (HMM, σ_z ≈ 4.07 m; OSRM/Valhalla) into silver; store road polyline + per-vertex
  timestamps; **dedup shared corridor geometry across trips** (big content-addressed-pack win).
  30 s GPS sampling is provably sufficient (0.11% error) — no need for dense fixes.
- **OD aggregation** keyed by hierarchical cells → sparse flow edge list (not a dense matrix);
  `O(trips) → O(cell-pairs)`, and re-binning to parent cells for the next zoom-out is free.
- **Edge bundling** → precompute Bézier control points at build time (your `edge-bundler`), never
  per-frame.
- **Wire vocabulary**: align the intermediate with **OGC Moving Features / MF-JSON** — record an
  explicit **interpolation mode** (`Linear` / `Step` / `Discrete`) per trajectory as a first-class
  field, since it changes GPU interpolation and is currently an assumption.

### 3.5 The accumulator contract (ties drop-budget to the no-thinning principle)

When *any* operator removes/merges a feature (cluster, coalesce, budget-drop), fold its named scalar
attributes into the survivor via a **per-attribute reduction** (`sum`/`mean`/`max`/`min`/`count`),
and auto-emit `point_count` + `sqrt_point_count` (marker area ∝ count). Make it a **format-level
property** reusable across the build pass *and* any later merge pass (tippecanoe's tile-join lesson).
This is exactly your `vertex_value_matrix` aggregation generalized — and it's what makes "drop" safe:
totals survive as aggregates instead of vanishing.

---

## 4. The interface — Recipes (declarative core + Rust escape hatch)

Every mature system converges on **declarative front door + documented path to code** (Planetiler
YAML→Java Profile, Vega-Lite→Vega, dbt YAML→SQL/Jinja, tippecanoe JSON→shell, deck.gl JSON→`@@function`).
Do the same. A dataset becomes a **recipe**.

### 4.1 The recipe (the 80% case — no Rust)

```yaml
version: 1                      # schema version — migrated forward on load (kepler.gl lesson)
name: bixi-flowmap
source: { op: parquet, path: bronze/bixi-2024.parquet, time: started_at, end_time: ended_at }
normalize: { crs: EPSG:4326, dedup_on: [trip_id], dateline_split: true }
pipeline:
  - op: index        scheme: quadbin   level: "@zoom+3"
  - op: bin          width: 1h
  - op: aggregate    by: [origin_cell, dest_cell, bucket]
                     measures: { count: sum, duration: {mean: true, sufficient_stats: true} }
  - op: cluster      scheme: supercluster  radius_px: 80  temporal_radius: 1h  per_zoom: true
  - op: simplify     method: visvalingam   inline_area: true        # one ranking, many zooms
  - op: encode       quantize_coords: 1m   vertex_time_precision: 1s
  - op: pack         zstd: 19   ordering: auto
```

- **Ordered array of typed stages** (Vega-Lite's exact shape) — predictable top-to-bottom dataflow.
- **A small sandboxed expression language** for the common "tiny bit of logic" case
  (`include_when`, computed attributes, `@zoom`-varying params). Planetiler uses CEL; in Rust use
  `cel-interpreter`/`rhai`/`evalexpr`. Absorbs most needs before anyone writes Rust.
- **Cascading defaults** (dbt): project-level → per-recipe → per-stage, "most specific wins".
- **Versioned + JSON-Schema-validated** (you already ship `manifest.schema.json`); editors get
  autocomplete, CI validates, `deny_unknown_fields` rejects typos instead of silently ignoring them.

### 4.2 The escape hatch (the 20% — Rust)

Copy Planetiler's `Profile`: a small trait with a **parallel-safe per-feature** method and a
**per-tile post-process** method.

```rust
trait Recipe: Send + Sync {                          // Send+Sync = Planetiler's "must be thread-safe"
    fn process_feature(&self, f: &SourceFeature, out: &mut FeatureCollector);   // on N workers
    fn post_process_tile(&self, layer: &str, z: u8, feats: &mut Vec<TileFeature>); // after grouping
    fn finish(&mut self) {}
}
```

This is the missing **`Dataset` trait** the generation audit kept asking for. `run_all()` becomes a
generic loop over recipes. The hot per-feature path stays on parallel workers; merge/reorder logic
runs on the single-threaded per-tile stage (Planetiler's split → preserves deterministic output order).

For "reference a custom Rust transform from a YAML recipe", use deck.gl's **named-capability
registry** (`{op: compute, fn: "my_binner"}` resolves against a `HashMap<String, Box<dyn TransformFn>>`
the binary registers at startup). Keeps the recipe pure data (diffable, hashable, cacheable) while
allowing a programmable escape, and bounds what a recipe can invoke.

> Prefer the in-process Rust trait over tippecanoe's shell-out prefilter — you avoid the
> GeoJSON serialize/deserialize tax at every tile boundary while keeping the same pre/post staging.

---

## 5. Determinism, content-addressing & incremental rebuild

This section is what turns "a cleaner generator" into "**incremental fleet rebuilds and a shared
cache**" — and it is gated on fixing determinism first.

### 5.1 Determinism (the prerequisite — fix before anything else)

The tile/pack hash must be a **pure function of logical input only**. Concrete Rust rules:

1. **Never serialize a `HashMap`/`HashSet`** — Rust re-seeds the hasher every process for HashDoS
   resistance, so iteration order is randomized per run. Use `BTreeMap`, or collect→`sort()` by key
   before encoding. **This is the direct fix for the Arrow-metadata-HashMap non-reproducible-packs
   bug**: sort schema/field metadata entries by key immediately before writing the IPC schema.
2. **Sort everything enumerated from the filesystem** — `readdir()` order is unspecified (the
   most-patched reproducibility bug in OSS). Sort input parquet globs / pack candidates by a
   canonical key.
3. **Total sort keys** — within a tile, extend the feature sort key until total
   (spatial → time → feature-id → original-index) so even `sort_unstable` yields one layout.
4. **Zero wall-clock in output** — no "generated at", mtimes, build dates. Provenance derives from
   a `SOURCE_DATE_EPOCH`-style value taken from the recipe/source, never `SystemTime::now()`.
5. **Order-independent float reduction** — FP addition is non-associative, so parallel sums vary
   run-to-run. Quantize to integers before summing, or reduce in a fixed sequential order. (Matters
   for every aggregation measure in §3.3.)
6. **Parallelize compute, not output order** — `par_iter().map().collect()` into index-keyed slots,
   emit in sorted-key order. Forbid "append to shared buffer as workers finish" in the output path.
7. **Regression test**: build a small dataset **twice in separate processes** (so HashMap re-seeds)
   plus once with shuffled input-file order and a different thread count; assert byte-identical packs.
   This catches exactly the class of bug unit tests inside one process miss.

### 5.2 Content-addressed constructive trace (you already half-have this)

Your packs are already content-addressed. Lift the whole DAG to a **constructive trace** (Build
Systems à la Carte): a CAS keyed by `hash(content)`, plus a manifest of
`{ stage-key → input-fingerprint, output-hash, dep-edges }`. The stage key hashes **(input bytes +
full config + code/tool version)** — and *config* includes quantization grid, zstd level, zoom range,
cluster radius, snap radius. Anything that affects output but isn't in the key is the "$PATH hazard"
that silently corrupts a cache.

Constructive traces are the *only* strategy that gives **both** cloud/shared cache **and** early
cutoff (verifying traces give early cutoff but no shared store).

### 5.3 Incremental rebuild — Salsa-style, with early cutoff

A build tool runs to completion against a static snapshot, so the right model is **demand-driven
memoized queries with cross-run persistence** (Salsa / rustc), *not* streaming IVM (differential
dataflow is the wrong tool — its one transferable insight, "work proportional to the change", is
delivered here by early cutoff).

- **Memoized query DAG**: input queries = source parquet + recipe; tracked queries =
  normalize → index → bin → aggregate → encode-leaf → pack. Persist the dep-graph + result cache
  between runs.
- **Early cutoff (the biggest win for "config changed a little")**: after recomputing a leaf tile,
  compare its content hash to the previous build; if equal, **do not invalidate** the pack/directory
  that contains it. A recipe edit that only touches color-domain metadata → *zero* tile rebuilds.
- **Projection firewall (rustc's pattern)**: don't let one monolithic input (the whole parquet, one
  global config struct) be a single edge into every tile. Partition source spatially/temporally up
  front; each tile depends only on the slice + the config *fields* it reads. Editing the zstd level
  invalidates only encode/pack; editing one city's rows invalidates only that region's tiles.
- **Durability tiers** (Salsa): mark rarely-changing inputs (base coastline, fixed CRS) high-durability
  so the verifier skips re-checking their subgraph; mark I/O-bound stages `eval_always`.

**The payoff in your terms**: the recurring "fleet re-transcode + R2 re-sync" open item stops being
all-or-nothing. Change one recipe → rebuild that dataset's affected tiles → the directory/manifest
churns, the unchanged content-addressed packs stay put → R2 re-syncs only the diff. Share the CAS
(the R2 pack store *is* the CAS) so CI and local builds hit the same cache, and re-transcoding a
dataset that overlaps an existing one reuses silver/gold artifacts.

---

## 6. Mapping to the codebase & phased roadmap

Nothing here is a rewrite. It is: (1) fix determinism, (2) extract today's bespoke code into a
shared operator library behind a plan IR, (3) put a recipe spec in front, (4) add a cache layer.

### Phase 0 — Determinism (blocking, do first)
- Sort Arrow metadata before IPC write (`BTreeMap`/sort-keys); kill HashMap-order leaks in the
  pack/dedup path. Sort filesystem enumerations. Total sort keys in the tiler. Integer-or-ordered
  float reduction in aggregation.
- Add the build-twice-in-separate-processes byte-identity regression test.
- *Unblocks* CAS dedup, edge-cache correctness, and all of Phase 4.

### Phase 1 — Plan IR + operator extraction (no behavior change)
- Define `Stage` enum + `BuildPlan`; reimplement the *current* `stt-build` flow as a fixed plan.
- Extract `BixiAggregator` / `FlowAggregator` into one generic `Aggregate` + `Cluster` operator.
- Lift `--quantize-coords`, simplify, summary tier into named stages. Wire `budget.rs` as a `Budget`
  stage with the accumulator contract (§3.5).
- Ship `stt-build explain`.

### Phase 2 — Recipes (kills generator drift)
- `Recipe` trait (the `Dataset` trait the audit wanted); `run_all()` → generic loop.
- YAML/JSON recipe parser (serde-tagged, versioned, JSON-Schema, `deny_unknown_fields`) + a sandboxed
  expression language. Port 2–3 datasets (bixi, earthquakes, drifters) to recipes; keep the Rust
  escape hatch for OSRM/advection-heavy ones.
- Formalize bronze/silver/gold artifact directories.

### Phase 3 — The cube upgrades (the visible product wins)
- **Sufficient statistics** `{n, Σx, Σx²}` on the summary tier → mean/variance/trend at read time.
- OLAP measure classification on every aggregation (distributive/algebraic/holistic) — no more
  average-of-averages risk.
- VW **inline effective-area** → every zoom a filter, not a re-simplify.
- KDE raster tier + Gi\* hotspot tier as opt-in stages. Per-cell time-series codec + cumulative
  prefix-sum.

### Phase 4 — Incremental engine
- Salsa-style memoized query DAG over the Plan IR; persist dep-graph + result manifest; CAS for leaf
  tiles + packs (R2 as shared CAS). Early cutoff + projection firewalls.
- Incremental fleet rebuild + diff-only R2 sync.

### Phase 5 — Streaming-first
- Pull-based Arrow streaming as the default execution path (in-RAM becomes the small-data case);
  unbounded-dataset support; `Source`-trait pushdown (Exact/Inexact/Unsupported) feeding the
  paged-directory bounds.

---

## 7. Open decisions

- **D1 — Native operators vs. embed DataFusion** for the `Transform` stage. Recommendation: native
  first (preserves zero-copy-to-GPU control, fewer deps), embed DataFusion later if SQL-defined
  transforms or heavy relational ops (joins) become common. *Reversible.*
- **D2 — Primary DGGS.** Recommendation: **Quadbin** as the default roll-up index (tile-aligned, 1:1
  with deck.gl requests, perfect nesting, `quadbin.rs` already exists); H3 retained for
  neighbor/flow analytics where its grid is preferable; S2 only if exact equal-ish-area roll-up
  matters. Avoid A5 for now (cells ~2% area-variant despite the equal-area projection claim; new).
- **D3 — Expression language.** `cel-interpreter` (portable, Google CEL, matches Planetiler) vs.
  `rhai` (richer, Rust-native). Lean CEL for portability + sandboxing.
- **D4 — How far to take incremental in v1.** Early cutoff at the pack boundary is cheap and high-ROI;
  full projection-firewall partitioning is more work. Could ship Phase 4 in two sub-steps.

---

## 8. The five things to take first

1. **Fix determinism** (§5.1) — it's the prerequisite for CAS dedup, edge-cache, *and* incremental
   rebuilds; it fixes a known live bug; it's cheap.
2. **Sufficient statistics on the summary tier** (§3.3b) — a few f32 columns buys
   mean/variance/correlation/trend at read time with no rebuild. Best ROI in the whole design.
3. **OLAP measure classification** (§3.3a) — the rule that prevents average-of-averages across
   every zoom roll-up.
4. **The Plan IR + recipe spec** (§2, §4) — collapses the 40–50% generator drift into one
   declarative surface with a Rust escape hatch (the long-requested `Dataset` trait).
5. **Constructive-trace CAS + early cutoff** (§5.2–5.3) — turns the all-or-nothing "fleet
   re-transcode + R2 re-sync" into diff-only incremental rebuilds.
```

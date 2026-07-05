# stt-optimize: from zoom-range guesser to pipeline profiler + advisor

**Status: SHIPPED through P2.5 (2026-07-02, same day). P0 hygiene, the P1
profiler (`inspect`/`diff`), the P1.5 advisor layer (`recommend --explain`,
`--auto encode`), P2 viz (`--style-hints` baked + TS `metadata.styleHints`
parse; FE layer auto-wiring still future), and the P2.5 doctor
(`stt-optimize doctor`, `--strict` CI gate) are all implemented — see §6.
P3 remains scheduled with its trigger. User-facing docs:
[`cli-reference.md` §stt-optimize](../api/cli-reference.md#stt-optimize) and
the [Tuning your tiles guide](../guides/tuning-tiles.md).**
Companion to `rust-audit-2026-06.md` (which first flagged stt-optimize as "real algorithms,
advisory-only"), `av-cockpit.md` §3 (the measurement-driven compression pass), and
`preprocessing-framework.md` (the long-horizon home for build intelligence).

Goal: make tile generation user-friendly and *intelligent* — let users analyze datasets
**and built tilesets** so parameter tuning, tile generation, and visualization configuration
are informed decisions instead of folklore.

---

## 1. Current state (verified in-tree 2026-07-02)

### 1.1 Shape

- `crates/stt-optimize` is a **library-only crate (~3.0k LOC)**: `loader.rs` (GeoParquet →
  `AnalyzableFeature`), `analysis/{spatial,temporal,geometry,density}.rs`, `recommend.rs`,
  `report.rs`. The CLI binary lives in the facade:
  `crates/spatiotemporal-tiles/src/bin/stt-optimize.rs` (feature `optimize-cli`).
- CLI surface: `stt-optimize analyze` (text/JSON report) and `stt-optimize recommend`
  (build-config JSON, `--show-command`). Flags: `--input`, `--time-field`, `--time-format`,
  `--format`, `--output`, `--verbose`. Doc-gated against `docs/api/cli-reference.md`.
- One programmatic consumer: **`stt-build --auto`** → `stt_optimize::recommend_for`
  (`stt-build.rs:1657-1699`), which folds in exactly **three values** — `min_zoom`,
  `max_zoom`, `temporal_bucket_ms` — and only for flags the user didn't set explicitly.

### 1.2 What it analyzes today

| Analyzer | What it computes | Consumed by a build? |
|---|---|---|
| `spatial.rs` | z0–14 tile occupancy; tippecanoe `-zg`-style density max-zoom (`z = log2(world·cosφ/√(area/n))`); min-zoom (avg ≥2/tile); 10°-grid hotspots; distribution class | min/max zoom via `--auto` |
| `temporal.rs` | duration, unique timestamps, hour/day/month histograms, events/day stats, distribution class (Uniform/Bursty/Periodic/Sparse/Instantaneous); bucket ladder targeting ~1500 buckets | bucket via `--auto` |
| `geometry.rs` | type mix, vertex/size percentiles (p95/p99), property counts, complexity class | no |
| `density.rs` | chunk-size simulation over {64KB…2MB} across the recommended zoom range; oversized/undersized counts; estimated tile count / archive size; issue list with severities | no |
| `recommend.rs` | `Recommendations { min_zoom, max_zoom, temporal_bucket_ms/_human, confidence, explanations }`; `to_command` | zoom + bucket only |

### 1.3 The core problem: it predicts, it never measures

- Feature size is a fixed formula: `estimated_size = 100 + vertex_count*16 + property_count*20`
  (`loader.rs:152`). Compressed size is a hardcoded `uncompressed / 3` (`density.rs:243-245`).
  Neither ever touches the real encoder.
- **The density simulation models a build that doesn't exist.** `simulate_zoom_chunks`
  (`density.rs:161-214`) cuts each spatial tile's time-sorted features into *byte-size-bounded*
  chunks. The real build cuts tiles by **fixed `--temporal-bucket` duration** (or
  `--adaptive-temporal` feature-count targets). There is no `--chunk-size` flag;
  `recommended_chunk_size` maps to nothing a user can set.
- Meanwhile every optimization decision that actually shipped in this repo came from
  **measured** tooling that lives *outside* stt-optimize as unshipped cargo examples/scripts:
  - `stt-core/examples/point_column_stats.rs` — per-column compressed bytes/point. Twice
    overturned research-derived plans (AV: `id` 40% + `z` 38% ≫ geometry 12.7%; lightweight
    column encodings measured NO-GO).
  - `stt-core/examples/simulate_layout.rs` — the request-cost oracle for blob ordering.
  - `stt-core/examples/reoptimize.rs` — the fleet transcoder (21 datasets, 20.4→13.2 GB, wins
    **dataset-shaped 1.07–1.99×**, up to 21× with zoom-floor fixes — unpredictable by static
    heuristics, only measurable).
  - `scripts/data-generation/lidar_summarize_eval.py` — decimation-strategy bake-off.

### 1.4 Coverage gap: 3 of ~25 knobs

`--auto` advises zoom + bucket. It says nothing about the levers that produced the real wins
(all documented in `cli-reference.md`):

- **Encoding**: `--quantize-coords` (the confirmed #1 size lever, −25..47%),
  `--quantize-attr NAME=PREC`, `--quantize-attrs-auto`, `--vector-group`,
  `--point-elevation-column`, `--vertex-time-precision`, `--zstd-level`/`--publish`.
- **Layout**: `--pack-size`, `--blob-ordering` (auto/spatial/time-major/hilbert3/morton3),
  `--page-entries`, `--single-directory`.
- **LOD/aggregation**: `--temporal-lod`, `--adaptive-temporal`, `--summary-tier` (+ columns/
  sub-buckets), `--min/max-zoom-field`, `--simplify`.
- **Budgets/attributes** (opt-in per no-thinning): `--maximum-tile-bytes/-features`,
  `--drop-densest-as-needed`, `--exclude/--include/--exclude-all`.

Born-optimized defaults (0.1 m coord quant + auto attr quant + seq ids) exist only inside the
`stt-generate` funnel — a third-party `stt-build` user gets **none of them** unless they
already know the flags. That is the opposite of the friendliness goal.

### 1.5 Other verified defects / limitations

1. **Bounds bug**: `report.rs:23-29` prints hardcoded `[-180,-90]..[180,90]`
   (`zoom_coverage.first().map(|_| -180.0)`); `AnalysisResult` doesn't even carry the bounds
   the loader computes (`LoadedData.bounds` is dropped).
2. **Hand-rolled WKB parser** (`loader.rs:428-639`), zero tests, third duplicate in the repo;
   non-point centroids are mean-of-first-ring, not true centroids.
3. **`MAX_SUPPORTED_ZOOM = 14`** (`spatial.rs:177`) — the analyzer can't reason about the
   z14–18 regimes the AV/LiDAR fleet actually uses.
4. `--auto` unsupported for `--postgres`/`--duckdb` (analyzer reads GeoParquet only;
   `stt-build.rs:1659-1661`).
5. Stale docs: `csv-quickstart.md:72` claims `--auto` picks "compression" (it never applies
   it — format is zstd-only); `lib.rs:5` references a `main.rs` that no longer exists.
6. `full-ecosystem-audit-2026-07.md:199-202` is partly stale: `Recommendations.chunk_size` /
   `compression` / `recommend_compression` and the unused deps are already removed. Still
   live from that audit: the WKB parser, and the linear-Mercator inverse-latitude
   approximation feeding spatial stats.

### 1.6 The visualization gap (nobody advises the front end)

- The **only** automated measured-stat→viz path in the whole pipeline is
  `--heatmap-weight` → `[min, p95]` baked into `metadata.heatmap_domain`
  (`stt-build.rs:1566-1653`), consumed as a default by
  `packages/layers/.../heatmap-layer.ts:424-446`. The pattern is proven end-to-end.
- Everything else is a **manual measure-percentile-then-hand-edit loop** in
  `examples/showcase/src/datasets.ts` (4.3k lines). Grep evidence: `:1257` "p97≈15 → domain
  [0,16]"; `:1406` "p97≈96 → [0,90]"; `:1962` "p97≈55 → [0,50]"; `:4012` "p99≈1345 →
  [1,600]". `temporalSigma` tuned to sweep interval by hand; playback speed derived in
  showcase code (`types.ts:958-963`); layer type chosen by the author.
- Per-instance guidance for the whole ecosystem exists (percentiles are one pass over the
  data the analyzer already makes) — it just has no output channel.

---

## 2. Why the fix is "measure, don't model" (repo-native evidence)

1. Measure-first **overturned** expert plans twice (§1.3). A heuristic advisor would have
   recommended the octree/geometry work that measurement killed.
2. Wins are **dataset-shaped** (1.07×–21×). No formula predicts which lever pays for a given
   dataset; a 30-second sample-encode does.
3. The counted-out rust-audit item — *"full measure-and-correct loop… revive with the first
   real consumer"* — has its revival trigger now: **the user-friendliness initiative is the
   consumer.** Third-party users can't be expected to hand-run cargo examples.
4. `preprocessing-framework.md` makes "Measure first" **non-negotiable** (§ "Measure first")
   and defines the seam: *LOD changes the resolution of the answer; encoding changes the
   price per unit.* An advisor that measures per-column costs and recommends per-lever flags
   is the natural precursor of that framework's recipe bake-off — same analyses, different
   packaging. Build the measurement core once, in stt-optimize.

---

## 3. Target design: three roles

**stt-optimize = Profiler + Advisor + Doctor.** Same library core, three CLI verbs, spanning
the lifecycle: *before build* (source analysis — exists today), *at build* (`--auto`),
*after build* (tileset profiling — missing entirely).

```
             ┌────────────┐    profile    ┌──────────────┐
  source ───▶│  analyze    │──────────────▶│ recommend     │──▶ stt-build flags
 (parquet/DB)│ (exists)    │   sample-     │ (all levers)  │    + confidence + why
             └────────────┘   encode      └──────────────┘
             ┌────────────┐               ┌──────────────┐
  tileset ──▶│  inspect    │──────────────▶│ doctor        │──▶ issues + remediation
 (packed dir)│ (NEW)       │  per-column  │ (NEW linter)  │    flags + projected win
             └────────────┘  real bytes   └──────────────┘
```

---

## 4. Proposal

### 4.1 Profiler — analyze built tilesets and measure real bytes (P1)

- **`DataSource::Packed`** — read a packed tileset via `ArchiveReader` (revives the
  counted-out "packed awareness" item from `stt-packed.md` §"counted out"; trigger met).
- **`stt-optimize inspect <tileset>`** — absorb `point_column_stats.rs` (generalized beyond
  points: it already handles any geometry) + `packed-stats.rs`: per-column compressed
  bytes/feature and share%, per-zoom entry/blob stats, dedup ratio, compression ratio
  (stt-validate already computes payload compressed/uncompressed — reuse, don't duplicate).
- **Sample-encode instead of the size formula**: for source analysis, push a deterministic
  sample of features through the real `stt-core` columnar+`arrow_tile` encoder (+zstd at the
  target level) to get true bytes. Kills `estimated_size = 100+16v+20p` and the `/3` guess.
- **`stt-optimize diff <a> <b>`** — per-column/per-zoom deltas between two tilesets;
  formalizes the size gate from the fleet-reprocess script (`after ≤ before×1.02`).

### 4.2 Advisor — recommend across the full knob set, with measured evidence (P1–P2)

Each advisor emits: suggested flag(s), **measured** projected win (trial-encode on the
sample), confidence, and a one-line *why*. `recommend --show-command` grows to the full
flag set; new `recommend --explain` prints the evidence table.

- **Quantization advisor**: coords — derive precision from max-zoom ground resolution
  (half-quantum error ≪ pixel at maxzoom) and *verify* by sample-encoding at candidate
  precisions; attrs — per-column range/precision detection → `--quantize-attr`/
  `--quantize-attrs-auto`, flag incompressible hash-like id columns (the 40% AV lesson).
- **Temporal advisors**: keep the bucket ladder; add `--temporal-lod` tier suggestion (from
  duration vs bucket count), `--adaptive-temporal` target (from burstiness CoV), and
  `--vertex-time-precision` (from observed per-vertex deltas when present).
- **Layout advisor**: absorb `simulate_layout` — recommend `--blob-ordering` + `--pack-size`
  from access-pattern simulation on the actual tile set.
- **Budget advisor**: with real per-tile encoded sizes at the recommended zooms, report the
  true oversized-tile list (bytes, z/x/y) and suggest `--maximum-tile-*` / zoom clamps /
  `--min-zoom-field` — replacing the fictional chunk simulation (delete
  `recommended_chunk_size`; map density issues onto real knobs).
- **Extended `--auto`, tiered for the no-thinning principle**:
  - `--auto` (unchanged semantics): zoom + bucket.
  - `--auto=encode` (NEW): additionally applies **lossless-in-practice, reversible** levers —
    seq ids, zstd/publish level, blob ordering, pack size, vertex-time precision.
  - Quantization is lossy → **suggest loudly, never silently apply**; user opts in per flag
    or via `--auto=encode+quantize` with the chosen precisions echoed.
  - Budgets/thinning: never auto-applied, ever (product principle).

### 4.3 Visualization advisor — close the datasets.ts loop (P2)

- Per-property percentile profile (p50/p90/p95/p97/p99/max) for numeric columns; cardinality
  for categoricals. This generalizes the proven `heatmap_domain` p95 bake.
- **`style_hints` manifest block** (versioned, sibling of `heatmap_domain` in
  `metadata.rs`): suggested `colorDomain` per numeric property (p97-clamped by default),
  categorical palettes-by-cardinality, suggested playback duration (time-range × density →
  target seconds), point-sweep `temporalSigma` hint (≈1–2× median inter-timestamp delta),
  and a **layer-type hint** derived from structure (per-vertex times → trips/trip-heads;
  end_time → intervals; dense points + weight column → heatmap/summary; etc.).
- FE consumption mirrors `archiveHeatmapDomain`: hints are **defaults, always overridable**
  by the layer spec; precedence documented in `data-format.md`. Outcome: a third-party
  `stt-build` output renders sensibly with zero showcase-style hand-tuning.
- Keep hints *advisory data*, not behavior: the schema is additive, ignorable by old readers.

### 4.4 Doctor — the linter + measure-and-correct loop (P2–P3)

- **`stt-optimize doctor <tileset>`**: severity-ranked findings, each with a concrete
  remediation flag and a measured projected win (sample re-encode). Seed rules — all
  productized from manual sessions:
  - raw Float64 numeric columns (→ quantize-attr; show B/pt before/after)
  - hash-like incompressible id column (→ seq ids on rebuild / reoptimize)
  - constant or all-null columns (→ `--exclude`)
  - z0 pyramid on locally-dense data ("z0 bomb" → `--min-zoom` / `--min-zoom-field`)
  - stale uncompressed directory; single-directory on large tilesets (→ repack paged)
  - oversized tiles by real bytes (→ budgets/zoom, opt-in)
  - missing summary tier on large point sets with numeric weight columns
  - dedup ratio ≪ expected (→ determinism bug exposure; ties to arrow ≥59 upgrade)
- **Closed loop (optional, last)**: `stt-build --auto-measure` — build a sampled z-slice,
  measure, adjust flags, then full build. This is the rust-audit counted-out loop; ship it
  only after doctor/inspect prove demand, since it multiplies build cost.

---

## 5. Engineering notes

- **Dependency direction**: `stt-build → stt-optimize → stt-core`. The advisor must not
  depend on stt-build. Sample-encoding needs only `stt-core` (`columnar` + `arrow_tile` +
  `compression`) — already a legal dependency. Anything needing the full tiler orchestrates
  in the **facade bin** (which sees both crates), not in the library.
- **Preprocessing-framework alignment**: stt-optimize's measured profiles become the inputs
  to the future recipe bake-off ("promoted default-off→on only when the measured win
  justifies it"). Do not grow a parallel Plan-IR here; keep stt-optimize = measurement +
  recommendation, framework = execution.
- **DB sources**: support `--auto`/analyze for `--postgres`/`--duckdb` by sampling through
  the existing readers (`TABLESAMPLE` / reservoir over the cursor) — removes wart §1.5(4).
- **JSON-first output**: `analyze --format json` already exists; keep every new verb
  machine-readable so a future showcase "dataset inspector" page or CI size-regression gate
  can consume it directly.
- **Docs**: the per-binary `cli_flags_are_documented_in_cli_reference` gates mean each new
  flag self-documents; add a "Tuning your tiles" guide (measure → interpret → flag table)
  and fix the stale `--auto`-picks-compression claim in `csv-quickstart.md:72`.

## 6. Phasing (ROI order)

| Phase | Work | Why first | Status |
|---|---|---|---|
| **P0 hygiene** | Fix bounds bug (thread `LoadedData.bounds` through `AnalysisResult`); delete/replace fictional chunk sim outputs; WKB parser → shared/tested path (geozero or stt-build's reader); lift z14 cap; fix stale docs + `lib.rs` comment | Small, verified defects; unblocks trust in reports | **SHIPPED 2026-07-02** |
| **P1 profiler** | `DataSource::Packed`; `inspect` (absorb point_column_stats + packed-stats); sample-encode replacing size formulas; `diff` | The measurement core everything else consumes; immediately useful standalone | **SHIPPED 2026-07-02** (`PackedTileset` + `inspect`/`diff` verbs, `--fail-on-growth` gate) |
| **P1.5 advisor** | Quantization + temporal + layout + budget advisors; `--auto=encode` tier; full `to_command` + `--explain` | Puts the proven wins (−25..47%, up to 21×) in reach of users who don't read roadmap docs | **SHIPPED 2026-07-02** |
| **P2 viz** | Property percentiles; `style_hints` manifest block + FE default consumption; layer-type hints | Closes the last manual loop (datasets.ts hand-tuning); biggest onboarding win | **SHIPPED 2026-07-02** — hints baked (`--style-hints`) + TS parse (`metadata.styleHints`, `suggestedDomainFor`); FE **layer auto-wiring** of the hints is still future work |
| **P2.5 doctor** | `doctor` linter with measured remediations | Productizes the recurring manual fleet passes | **SHIPPED 2026-07-02** (7 rules, `--strict` CI gate; projections estimated from measured column costs, no re-encode) |
| **P3 loop** | `--auto-measure` closed loop; DB-source sampling | Rebuild-cost multiplier; ship after demand proven | Scheduled — trigger unchanged: ship only after doctor/inspect prove demand |

**Counted-out (with triggers)**: GPU/render-time perf advice (belongs to tools/perf +
renderer work, not the build advisor); auto-applied thinning (never — product principle);
compression-codec recommendation (format is zstd-only by design).

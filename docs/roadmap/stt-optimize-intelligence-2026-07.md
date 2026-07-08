# stt-optimize: from zoom-range guesser to pipeline profiler + advisor

**Status: SHIPPED through P2.5 (2026-07-02, same day). P0 hygiene, the P1
profiler (`inspect`/`diff`), the P1.5 advisor layer (`recommend --explain`,
`--auto encode`), P2 viz (`--style-hints` baked + TS `metadata.styleHints`
parse; FE layer auto-wiring still future), and the P2.5 doctor
(`stt-optimize doctor`, `--strict` CI gate) are all implemented — see §6.
P3 remains scheduled with its trigger. User-facing docs:
[`cli-reference.md` §stt-optimize](../api/cli-reference.md#stt-optimize) and
the [Tuning your tiles guide](../guides/tuning-tiles.md).**
Companion to the 2026-06 rust audit — now folded into `stt-packed-format-decisions.md` —
(which first flagged stt-optimize as "real algorithms,
advisory-only"), `av-cockpit.md` §3 (the measurement-driven compression pass), and
`preprocessing-framework.md` (the long-horizon home for build intelligence).

Goal: make tile generation user-friendly and *intelligent* — let users analyze datasets
**and built tilesets** so parameter tuning, tile generation, and visualization configuration
are informed decisions instead of folklore.

---

## 1. Where this started — and the core problem

> The pre-ship "current state" inventory (crate shape, analyzer table) and the verified-defect
> list this section used to carry are superseded: P0–P2.5 shipped 2026-07-02, and current CLI
> surface + behavior live in [`cli-reference.md` §stt-optimize](../api/cli-reference.md#stt-optimize)
> and the [Tuning your tiles guide](../guides/tuning-tiles.md). Detail in this file's git history.
> What follows is the durable rationale.

### 1.3 The core problem: it predicted, it never measured

- Feature size was a fixed formula: `estimated_size = 100 + vertex_count*16 + property_count*20`
  (`loader.rs:152`). Compressed size was a hardcoded `uncompressed / 3` (`density.rs:243-245`).
  Neither ever touched the real encoder.
- **The density simulation modeled a build that doesn't exist.** `simulate_zoom_chunks` cut each
  spatial tile's time-sorted features into *byte-size-bounded* chunks; the real build cuts tiles by
  **fixed `--temporal-bucket` duration** (or `--adaptive-temporal` feature-count targets). There is
  no `--chunk-size` flag; `recommended_chunk_size` mapped to nothing a user can set.
- Meanwhile every optimization decision that actually shipped in this repo came from **measured**
  tooling that lived *outside* stt-optimize as unshipped cargo examples/scripts:
  - `stt-core/examples/point_column_stats.rs` — per-column compressed bytes/point. Twice
    overturned research-derived plans (AV: `id` 40% + `z` 38% ≫ geometry 12.7%; lightweight
    column encodings measured NO-GO).
  - `stt-core/examples/simulate_layout.rs` — the request-cost oracle for blob ordering.
  - the since-removed reoptimize pass (transcoding removed entirely 2026-07-04; historical
    measurement: 21 datasets, 20.4→13.2 GB, wins **dataset-shaped 1.07–1.99×**, up to 21× with
    zoom-floor fixes — unpredictable by static heuristics, only measurable).
  - `scripts/data-generation/lidar_summarize_eval.py` — decimation-strategy bake-off.

### 1.4 Coverage at the start: 3 of ~25 knobs

`--auto` advised zoom + bucket only — nothing about the levers that produced the real wins:
encoding (`--quantize-coords`, the confirmed #1 size lever, −25..47%; `--quantize-attr`;
`--vector-group`; `--vertex-time-precision`; `--zstd-level`/`--publish`), layout (`--pack-size`,
`--blob-ordering`, `--page-entries`), LOD/aggregation (`--temporal-lod`, `--adaptive-temporal`,
`--summary-tier`), and the opt-in budgets. Born-optimized defaults (0.1 m coord quant + auto attr
quant + seq ids) existed only inside the `stt-generate` funnel — a third-party `stt-build` user got
**none of them** unless they already knew the flags: the opposite of the friendliness goal, and the
gap the P1.5 advisor closed.

### 1.6 The visualization gap (nobody advised the front end)

The **only** automated measured-stat→viz path was `--heatmap-weight` → `[min, p95]` baked into
`metadata.heatmap_domain`, consumed as a default by `heatmap-layer.ts` — the pattern proven
end-to-end. Everything else was a **manual measure-percentile-then-hand-edit loop** in the
4.3k-line `datasets.ts` (grep evidence: `:1257` "p97≈15 → domain [0,16]"; `:4012` "p99≈1345 →
[1,600]"; `temporalSigma` and layer type hand-picked). Percentiles are one pass over data the
analyzer already made — the guidance just had no output channel. P2 `style_hints` generalized the
pattern; FE layer auto-wiring is the remaining open slice (§6).

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

## 4. Design rationale (as built)

### 4.1 Profiler — analyze built tilesets and measure real bytes (P1)

- **`DataSource::Packed`** — read a packed tileset via `ArchiveReader` (revived the counted-out
  "packed awareness" item now registered in `stt-packed-format-decisions.md` §9; trigger met).
- **`inspect`** absorbed `point_column_stats.rs` (generalized beyond points) + `packed-stats.rs`:
  per-column compressed bytes/feature and share%, per-zoom entry/blob stats, dedup ratio,
  compression ratio (reusing stt-validate's payload computation, not duplicating it).
- **Sample-encode replaced the size formula**: a deterministic feature sample through the real
  `stt-core` columnar+`arrow_tile` encoder (+zstd at target level) → true bytes. Killed
  `estimated_size = 100+16v+20p` and the `/3` guess.
- **`diff <a> <b>`** — per-column/per-zoom deltas; formalizes the fleet-reprocess size gate
  (`after ≤ before×1.02`).

### 4.2 Advisor — the full knob set, with measured evidence (P1.5)

Each advisor emits: suggested flag(s), **measured** projected win (trial-encode on the sample),
confidence, and a one-line *why*; `recommend --show-command` covers the full flag set,
`recommend --explain` prints the evidence table. Quantization (coord precision from max-zoom
ground resolution, verified by sample-encode; per-column attr detection; hash-like id flagging —
the 40% AV lesson), temporal (`--temporal-lod` tier, `--adaptive-temporal` from burstiness CoV,
`--vertex-time-precision`), layout (absorbed `simulate_layout` → `--blob-ordering`/`--pack-size`),
and budget (true oversized-tile list by real bytes → `--maximum-tile-*`/zoom clamps, replacing the
fictional chunk simulation).

- **Extended `--auto`, tiered for the no-thinning principle**:
  - `--auto` (unchanged semantics): zoom + bucket.
  - `--auto=encode` (NEW): additionally applies **lossless-in-practice, reversible** levers —
    seq ids, zstd/publish level, blob ordering, pack size, vertex-time precision.
  - Quantization is lossy → **suggest loudly, never silently apply**; user opts in per flag
    or via `--auto=encode+quantize` with the chosen precisions echoed.
  - Budgets/thinning: never auto-applied, ever (product principle).

### 4.3 Visualization advisor — close the datasets.ts loop (P2)

Per-property percentile profiles (p50…p99/max; cardinality for categoricals) generalize the proven
`heatmap_domain` p95 bake into a versioned **`style_hints` manifest block** (sibling of
`heatmap_domain` in `metadata.rs`): suggested `colorDomain` (p97-clamped), palettes-by-cardinality,
playback duration, `temporalSigma` (≈1–2× median inter-timestamp delta), and a structure-derived
**layer-type hint**. FE consumption mirrors `archiveHeatmapDomain`: hints are **defaults, always
overridable** by the layer spec — advisory data, not behavior; the schema is additive and ignorable
by old readers. Outcome: a third-party `stt-build` output renders sensibly with zero
showcase-style hand-tuning.

### 4.4 Doctor — the linter + measure-and-correct loop (P2–P3)

- **`stt-optimize doctor <tileset>`**: severity-ranked findings, each with a concrete
  remediation flag and a measured projected win (sample re-encode). Seed rules — all
  productized from manual sessions:
  - raw Float64 numeric columns (→ quantize-attr; show B/pt before/after)
  - hash-like incompressible id column (→ seq ids on rebuild)
  - constant or all-null columns (→ `--exclude`)
  - z0 pyramid on locally-dense data ("z0 bomb" → `--min-zoom` / `--min-zoom-field`)
  - stale uncompressed directory; single-directory on large tilesets (→ repack paged)
  - oversized tiles by real bytes (→ budgets/zoom, opt-in)
  - missing summary tier on large point sets with numeric weight columns
  - dedup ratio ≪ expected (determinism is now fixed — arrow ≥59, byte-reproducible builds — so the
    rule still catches producer bugs)
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
  the existing readers (`TABLESAMPLE` / reservoir over the cursor) — closes the original
  GeoParquet-only `--auto` gap (part of P3).
- **JSON-first output**: `analyze --format json` already exists; keep every new verb
  machine-readable so a future showcase "dataset inspector" page or CI size-regression gate
  can consume it directly.
- **Docs**: the per-binary `cli_flags_are_documented_in_cli_reference` gates mean each new
  flag self-documents; the "Tuning your tiles" guide (measure → interpret → flag table) shipped.

## 6. Phasing — shipped ledger

All of P0–P2.5 shipped 2026-07-02 (same day):

- **P0 hygiene** — bounds bug fixed (`LoadedData.bounds` threaded through); fictional chunk-sim
  outputs deleted; WKB parser → shared/tested path; z14 cap lifted; stale docs + `lib.rs` fixed.
- **P1 profiler** — `PackedTileset`; `inspect`/`diff` verbs (absorbed point_column_stats +
  packed-stats); sample-encode replaced the size formulas; `--fail-on-growth` gate.
- **P1.5 advisor** — quantization/temporal/layout/budget advisors; `--auto=encode` tier; full
  `to_command` + `--explain` (puts the proven −25..47%, up-to-21× wins in reach of users who
  don't read roadmap docs).
- **P2 viz** — property percentiles; `style_hints` baked (`--style-hints`) + TS parse
  (`metadata.styleHints`, `suggestedDomainFor`).
- **P2.5 doctor** — 7 rules, `--strict` CI gate; projections estimated from measured column
  costs, no re-encode.

**OPEN**: (1) **FE layer auto-wiring of `style_hints`** — hints are baked and parsed but no layer
consumes them as defaults yet; the last slice of the §4.3 loop. (2) **P3 `--auto-measure` closed
loop + DB-source sampling** — trigger unchanged: ship only after doctor/inspect prove demand (it
multiplies build cost).

**Counted-out (with triggers)**: GPU/render-time perf advice (belongs to tools/perf +
renderer work, not the build advisor); auto-applied thinning (never — product principle);
compression-codec recommendation (format is zstd-only by design).

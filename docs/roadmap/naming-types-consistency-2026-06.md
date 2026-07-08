# Naming / Concepts / Types / Formats — Consistency Audit & Formalization Plan

> **Date:** 2026-06-30 · **Scope:** the whole monorepo — Rust crates (`stt-core`, `stt-build`,
> `stt-generate`, `stt-optimize`, `stt-validate`, `stt-serve`), the TS packages
> (`@poopdeck.gl/{core,layers,three,maplibre,playback,react}`), the Python data-generation
> scripts, and the normative spec/docs.
>
> **Method:** a multi-agent audit inventoried every region's vocabulary across eight
> cross-cutting axes, then adversarially verified each candidate against source to separate
> intentional per-language idiom from real drift. 49 candidates → **27 verified findings**.

## Status — Phases 0–4 IMPLEMENTED (uncommitted)

**Phases 0–4 landed and verified on `feat/db-parity-comprehensive` (working tree, uncommitted).**
Full workspace green: `cargo test --workspace` (+ `--features duckdb`), `pnpm -r build && pnpm -r
test`, Python parity tests. A diff review confirmed every HARD INVARIANT held (no wire renames, no
API deletions, no `u64→i64`, aliases kept). Verified against source, the shipped work is:

- **Phase 0 (docs truth-up):** gzip dropped/RETIRED in `manifest.schema.json` + `data-format.md`;
  `intensity` marked legacy; `encode_single_tile` comments corrected to "uncompressed frame"; four
  encoder flags + quadbin + `sub_buckets` added to `cli-reference.md`; `vectorProps`/`vector-group`
  documented; non-negative-time sentence in `time-model.md`; per-vertex input→wire→decoded rename
  table; three-renderer parity table; stale Rust comments.
- **Phase 1 (correctness + defaults):** shared timestamp normalizer + `TimestampSecondArray` import
  across the scalar/vertex/DuckDB readers (closes the one real bug — the scalar `--time-field`
  rejecting `ns`/`sec` that `--duckdb` accepted); a 4th reader (`stt-optimize/loader.rs`) found with
  the same bug and fixed; `stt-serve --time-field` `ts`→`timestamp`; `/metadata.json` uniform casing.
- **Phase 2 (retire duplicated constants):** `SPEED_STEPS` exported from playback (react imports it);
  shared palette module `@poopdeck.gl/core/palettes.ts` (+ cross-package parity test); AV palettes
  guarded by a Python↔TS parity test; dead `MAP_COLORS`→key-frozenset.
- **Phase 3 (renderer vocab, additive):** three accepts full-width `timeWindow`/`fadeInDuration`
  (→ internal `windowHalf`/`fadeIn`, aliases kept); maplibre gained keyed `colorMapping`;
  Splat↔Surfel docstring xref.
- **Phase 4 (enforcement) — COMPLETE in its landed form.** Parity/conformance **tests** landed
  (`spec_conformance.rs` Vector/`sub_buckets`/quadbin, compression byte-set freeze,
  palette/colorMapping/timeWindow, schema⇄Compression, Python palette), plus the F9
  flag-documentation gates (2026-07-01, below). Full codegen was counted out (below).

## Open-item disposition (triaged 2026-07-01)

Each former open item was either **made** or **counted out** with rationale:

- **F9 — MADE (enforcement slice).** Instead of full clap→markdown codegen (which would
  restructure a good hand-written doc), the enforceable core shipped: per-binary unit tests
  (`cli_flags_are_documented_in_cli_reference` in `stt-build`, `stt-serve`, `stt-validate`,
  `stt-optimize` `main.rs`) introspect the clap `Command` and fail if any visible long flag is
  missing from **that binary's section** of `docs/api/cli-reference.md` — a new flag now fails
  `cargo test` until documented. First run immediately caught 6 undocumented flags
  (`stt-serve` budgets ×3, `stt-optimize --output`/`--verbose` ×3), now documented. Full
  codegen stays counted out: the gate delivers the anti-rot property without the churn.
- **DONE — `normalize_timestamp_to_ms` hoisted into `stt-core`** (`crates/stt-core/src/timestamp.rs`,
  re-exported from `lib.rs`); all four readers (scalar/vertex/DuckDB/`stt-optimize/loader.rs`)
  route through it and the shared negative-timestamp guard.
- **DONE (resolved by design) — AV_MAP_COLORS guard.** `scripts/data-generation/test_av_palette_parity.py`
  value-locks OBJECT/LIDARSEG/HEIGHT_BAND (RGBA per key) and key-locks
  `MAP_LAYERS`⇄`AV_MAP_COLORS` — the map **colors** live only in TS by design (the Python copy was
  reduced to a key-frozenset), so key-parity IS the whole cross-language contract; a TS-side
  value snapshot of its own constants would guard nothing.
- **COUNTED OUT — F12** (unified cross-language golden-fixture harness + glossary). Partial
  coverage already exists (`spec_conformance.rs`, compression byte-set freeze, palette/colorMapping/
  timeWindow parity tests, Python palette gate, and now the F9 flag gates); a unified harness is
  consolidation, not new protection. Revisit if the piecemeal tests become hard to keep aligned.
- **COUNTED OUT — Phase 5 `u64→i64`** on `TimeRange.start/end` + `TileId.t`. Breaking `stt-core`
  change; the documented non-negative invariant shipped instead. Defer to a semver-major.
- **COUNTED OUT — `getFillColor` (deck) vs `colorProperty` (three/maplibre) accessor fork.**
  Decided: per-backend idiom stays (matches renderer-abstraction Decision 5's deck-shaped
  capability canon — deck keeps accessor functions as its native surface; three/maplibre keep
  scalar props). The capabilities table records the vocabulary; no alias layer unless a
  maplibre-idiom consumer demands one.
- **COUNTED OUT — F4 tail** (in-memory `ColumnarLayer.vertex_times`→`vertex_timestamps`, ~83 sites,
  4 crates). Permanent: a mechanical rename of a public in-memory field with zero wire effect;
  the input→wire→decoded rename table in the docs is the durable fix.

## Executive summary (why this mattered)

The codebase is structurally healthy and the wire format is sound. The dominant weakness was that
**consistency across the Rust ↔ TS ↔ Python ↔ docs boundary was maintained by hand and by prose**
(`// MUST stay in lockstep`) with almost no mechanical enforcement — so drift was a matter of *when*,
not *if*, and had already happened (the AV `MAP_COLORS` palette silently diverged in hue between the
Python generator and the TS showcase). Three risk clusters drove the plan: duplicated constants with
no parity test; spec↔implementation drift (shipped features never reaching the normative docs); and
renderer vocabulary forks (`timeWindow` vs `windowHalf`, `SplatLayer` vs `SurfelLayer`, keyed vs
positional palettes). Phases 0–4 closed all of these; the re-rot risk is now held by the parity
tests plus the F9 flag-documentation gates. Nothing on this audit remains scheduled.

## Risks / invariants to respect (still binding)

- **Wire tokens are frozen** by deployed R2 archives + the published spec: do **not** rename wire
  columns (`vertex_time`/`vertex_value`), the `.stt` suffix, or renumber compression bytes. Fix docs
  + in-memory names; add aliases only.
- **`u64`→`i64`** on `TimeRange`/`TileId` is a breaking `stt-core` change — counted out (Phase 5,
  above): the documented non-negative invariant shipped instead; revisit only at a semver-major, and
  it must not contradict the `Int64` payload columns.
- **Don't delete** TS `Compression.Gzip`/`gunzipSync` — public API used by the bench harness;
  deprecate and keep the dormant decode path.
- **`PlaybackControls.speedPresets`** is a distinct 5-button quick-pick — don't fold it into the
  shared 13-step ladder.
- **Scope the AV palette parity test** to OBJECT/LIDARSEG/HEIGHT_BAND value-equality only.
- **`stt-serve` core keys** (`boundingBox`/`minZoom`/`maxZoom`) deliberately mirror the loaders.gl
  `TileSource` shape — pick which schema wins before unifying casing.
- **Aligning three's window option** to full-width `timeWindow` must keep `windowHalf` working as an
  alias with correct halving, or existing three users silently get a 2×-wider window.
- **Codegen/spec-table generation must be CI-diff-gated** — generated docs that aren't enforced
  re-rot exactly like the hand-maintained ones.

---

*Historical detail — the full 27-finding catalog, the F1–F12 formalization table, and the 13-item
quick-wins list — is executed history as of Phases 0–4; recover it from the working-tree diff and
git history rather than re-reading it here.*

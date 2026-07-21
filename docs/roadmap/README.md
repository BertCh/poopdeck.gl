# Roadmap & decision records

Internal design and decision docs. **These are not part of the published docs
site** — the showcase `/docs` viewer bundles only `docs/{intro,architecture,spec,api,guides}`.
Once a design ships, its user-facing documentation moves to `docs/api/` and
`docs/spec/`; the doc here is kept as a decision record — rationale, measured
baselines, negative results, and counted-out items with revival triggers — not
as a description of current behavior.

**Consolidated 2026-07-07** (27 files → 14, ~7.7k → ~3.9k lines): every doc was
re-verified against the tree, stale statuses corrected (0.3.0 shipped both
registries 2026-07-05, tree at 0.4.0; packed v2 complete; transcoding removed;
determinism closed via arrow ≥59), fully-closed audits deleted, and overlapping
records merged. The mapping from retired files is in the ledger at the bottom;
git history preserves everything verbatim.

## The open register (single source — stop restating these per-doc)

1. **The user-run rollout/verify ops gate** — demo-fleet republish to packed v2
   → R2 sync (prune-grace ready) → in-browser verify. One combined pass closes
   the open tails of the format record, av-cockpit, playback (multi-source
   4-part verify), scrub-LOD QoE, the three/deck-parity visual checks, and the
   GTFS-NL / NWM demos (verify + R2 push).
2. **GitHub Actions is dead** — blocks renderer Decision 6 (GPU-conformance
   CI, which gates the Phase-1 shader rewire), verification of the rewritten
   CI/release gates, and the ecosystem audit's one live §1 item.
3. **three backend integration tail** — 3d-tiles-renderer integration,
   `SttThreeGeoViewer` showcase wiring, maplibre camera-sync basemap
   ([renderer-architecture.md](./renderer-architecture.md) §5).
4. **Format tail** — serve-v2, lazy-props client materialization, temporal-LOD
   beyond scrub P0–P2
   ([stt-packed-format-decisions.md](./stt-packed-format-decisions.md) §10);
   plus the two temporal-deltas follow-ups — geometry-blob sharing across
   temporal chunks and the quantized-int path-delta experiment (§11; chains
   themselves are NO-GO).
5. **scrub-LOD P3 baked tier + P4 polish**
   ([scrub-lod-2026-07.md](./scrub-lod-2026-07.md)).
6. **stt-optimize** — FE auto-wiring of `style_hints`; P3 `--auto-measure`
   stays trigger-gated
   ([stt-optimize-intelligence-2026-07.md](./stt-optimize-intelligence-2026-07.md)).
7. **Ecosystem-audit backlog** — §2 correctness, §4 hand-copy drift, §5 dead
   code, §6 naming, §9 showcase/Python remain untriaged
   ([full-ecosystem-audit-2026-07.md](./full-ecosystem-audit-2026-07.md)).
8. **Fired triggers needing re-triage** — `stt-tools` promotion and the hosted
   validate/inspect adoption kit (both were gated on "when we publish";
   publishing happened 2026-07-05) — see
   [stt-packed-format-decisions.md](./stt-packed-format-decisions.md) §9.

## Forward-looking (not built)

- [**kind-parity-campaign-2026-07.md**](./kind-parity-campaign-2026-07.md) —
  the geometry-kind & layer parity campaign (2026-07-21): four-agent survey
  baseline (polygons weakest end-to-end, moving-marker interpolation gap,
  orphan layers, `view_map` points-fallback) → four tracks (polygon parity,
  motion parity, adopt-or-cut, AI-surface reach) executed as wave-by-wave
  agent workflows with a target capability matrix. Plan only; Wave-2+ fleet
  republish folds into register item 1.
- [**space-time-lod-2026-07.md**](./space-time-lod-2026-07.md) — the space×time
  LOD master plan (2026-07-10): dual codebase audit + verified external SOTA →
  six phases (measure → resolution-true simplification → declared reduced
  temporal tiers → additive home-zoom decomposition → SSE + global budget →
  joint space-time policy). Absorbs scrub-LOD P3/P4 (register item 5) and the
  temporal-LOD tail of item 4. Plan only, nothing implemented.
- [**dataset-candidates-2026-07.md**](./dataset-candidates-2026-07.md) — the
  standing demo-datasets register: license-verified shortlist with per-section
  status (GTFS-NL and NWM rivers **SHIPPED** locally, with absorbed build
  notes; HRRR wind / GLM lightning / asteroids etc. still analysis-only),
  the blocked list (OpenSky, GFW, Gaia…), and the operational time-bombs.
- [**preprocessing-framework.md**](./preprocessing-framework.md) — bake
  analytics into tiles at build time via a Plan-IR operator DAG + declarative
  Recipes; read-cost ∝ output-resolution, not N. Design synthesis only,
  deliberately counted out as a whole; its Phase-0 determinism prerequisite is
  now fully closed (arrow ≥59).
- [**full-ecosystem-audit-2026-07.md**](./full-ecosystem-audit-2026-07.md) —
  seven-slice audit (2026-07-01), re-verified 2026-07-07: §1 criticals 6/7
  resolved (publishes, hygiene, dist ESM, path-deps), §7 resolved; the open
  backlog is §2/§4/§5/§6/§9 plus the CI item once Actions revives. Keeps the
  backend parity matrix, the hand-copy-drift thesis, and the do-not-delete
  false-positive list.

## Live decision records (shipped core + open tail)

- [**stt-packed-format-decisions.md**](./stt-packed-format-decisions.md) — the
  packed-format record: positioning (five defended contributions), measured
  baselines (schema tax, v2 campaign −44.8%), design decisions (paged directory
  D1–D6, v2 template/manifest choices, serve-stays-v1), negative results
  (lightweight encodings NO-GO, rel-times32/narrow-ids skips, transforms NO-GO,
  blob-ordering proxy lesson), prior art (COPC/MLT/PMTiles), E1 scale numbers,
  the counted-out register, and the temporal-deltas verdict (§11: inter-timestep
  chains NO-GO; geometry-blob sharing + path-delta experiment survive). Live spec:
  [`stt-packed-format.md`](../spec/stt-packed-format.md).
- [**renderer-architecture.md**](./renderer-architecture.md) — the
  multi-backend renderer record: kernel thesis (Decision 5: no shared chassis),
  locked decisions & negative results (TSL interleave trap, ECEF globe, RTC,
  op-set = linear alpha only, Cesium green-field proof), deck.gl-parity
  posture + skip-list, reusable gotchas, and the open tail (Decision 6 GPU-CI,
  three integration). User-facing:
  [`render-kernel.md`](../api/render-kernel.md),
  [`backend-capabilities.md`](../spec/backend-capabilities.md).
- [**scrub-lod-2026-07.md**](./scrub-lod-2026-07.md) — motion-tier LOD while
  scrubbing: P0–P2 shipped 2026-07-05 (`setInteractive` → `scrubLod`, DEFAULT
  OFF, kill-switched; temporal axis wired but inert); the five-domain SoTA
  survey; P3 baked tier + P4 polish + QoE verify open.
- [**stt-optimize-intelligence-2026-07.md**](./stt-optimize-intelligence-2026-07.md)
  — profiler + advisor + doctor ("measure, don't model"); P0–P2.5 shipped;
  the measure-first evidence (expert plans overturned twice; wins are
  dataset-shaped 1.07×–21×). User docs: [Tuning your tiles](../guides/tuning-tiles.md).
- [**db-input-adaptors.md**](./db-input-adaptors.md) — PostGIS/DuckDB as
  stt-build inputs + the stt-serve backends, landed on main; now also carries
  the encoder-seam lessons and the static-vs-DB architectural verdict
  (absorbed 2026-07-07). Benchmarks: ingest 0.98×/0.66× vs file, serve
  ~2 ms/~5 ms. Spec: [`stt-serve-protocol.md`](../spec/stt-serve-protocol.md).
- [**rain-flood-demo-2026-07.md**](./rain-flood-demo-2026-07.md) — the
  `rain-flood-2019` weather-drives-water composite (CMORPH isoband rain +
  NWM river overlay): design, data pipeline, and build recipe. Built + wired
  locally; replaces the standalone `nwm-rivers-flood-2019-03` demo; R2 push
  of the `rainfall-2019` archive open.

## Shipped decision records (rationale only)

- [**playback-and-loading.md**](./playback-and-loading.md) — clock↔buffer
  coupling (the genuinely new piece vs video players), multi-source SoTA
  verdicts (cadence tolerance band, EDF/WFQ shared scheduler), frontier hold,
  and the adversarial-review bug log. Shipped `86bbb0f`; open: the multi-source
  browser-verify (register item 1).
- [**av-cockpit.md**](./av-cockpit.md) — the `/drive` AV cockpit: georef
  gotchas (nuScenes local frame, AV2 UTM), license verdicts (the Waymo
  no-redistribution lesson), palette lockstep rule, and the measurement-driven
  LiDAR compression story (3.84 GB → 633 MB) with counted-out levers.
- [**shipping-2026-07.md**](./shipping-2026-07.md) — distribution record,
  SHIPPED 2026-07-05 (crates.io facade + 8 npm packages, lockstep at 0.4.0):
  naming rationale, feature/install matrix, version/tag + MSRV, auth lifecycle,
  non-goals with triggers. CI release gates exist as config but are unverified
  (Actions dead).
- [**naming-types-consistency-2026-06.md**](./naming-types-consistency-2026-06.md)
  — CLOSED audit whose **binding invariants block** stays load-bearing (frozen
  wire tokens, `Compression.Gzip` bench dependency, `windowHalf` alias,
  codegen CI-diff gate) plus counted-out items with triggers.

## Consolidation ledger (2026-07-07)

Retired files → where their durable content lives now (full text in git history):

| Retired                                                                                                                           | Now in                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `stt-packed.md`, `stt-format-review-2026-07.md`, `stt-packed-v2-design-2026-07.md`, `blob-ordering-heuristic-2026-07.md`          | [stt-packed-format-decisions.md](./stt-packed-format-decisions.md)                  |
| `rust-audit-2026-06.md`                                                                                                           | format decisions §2/§5/§9 (positioning, transforms NO-GO, triggers)                 |
| `renderer-abstraction-2026-06.md`, `three-renderer-parity.md`, `three-renderer-sota-2026-07.md`, `deckgl-parity-audit-2026-07.md` | [renderer-architecture.md](./renderer-architecture.md)                              |
| `fe-hotpath-audit-2026-06.md`                                                                                                     | closed; reference patterns + MED-3 trigger → renderer-architecture §4               |
| `data-sources-and-encoder.md`, `static-vs-db-2026-07.md`                                                                          | [db-input-adaptors.md](./db-input-adaptors.md) §4/§7/§8                             |
| `nwm-rivers-demo-2026-07.md`                                                                                                      | [dataset-candidates-2026-07.md](./dataset-candidates-2026-07.md) §D build notes     |
| `doc-coverage-audit-2026-07.md`                                                                                                   | deleted — executed 2026-07-01; residuals were folded into the ecosystem audit §2/§7 |

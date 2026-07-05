# Roadmap & decision records

Internal design and decision docs. **These are not part of the published docs
site** — the showcase `/docs` viewer bundles only `docs/{intro,architecture,spec,api,guides}`.
Once a design ships, its user-facing documentation moves to `docs/api/` and
`docs/spec/`; the doc here is kept as a decision record for the rationale, not
as a description of current behavior.

These docs were consolidated 2026-07-01: overlapping records were merged
(PostGIS+DuckDB, the three AV docs, the two playback docs, the two Three.js
renderer docs) and the shipped-work walls were trimmed down to rationale +
genuinely-open follow-ups. Where a doc says "uncommitted", the work lives in the
working tree on `feat/db-parity-comprehensive`.

**Full open-item triage, 2026-07-01 (same day, later):** every open/deferred item
across all docs was code-verified and then either **made** (implemented +
tested), **marked done** (already implemented, doc was stale), or **counted out**
(explicitly declined/deferred, with the rationale and a revival trigger recorded
inline in the owning doc). Made in the triage pass: file-reader dropped-column
accounting, the F9 CLI-flag↔`cli-reference.md` doc gates (caught 6 undocumented
flags), `docs/spec/render-spec.json` + its enforcement test, the runway-nub
min-width fix. The recurring cross-doc items that remain genuinely open are:
**(1)** the user-run rollout/verify ops gate (fleet re-transcode + R2 re-sync +
browser-verify, shared by stt-packed §3 / playback §7 / av-cockpit §4),
**(2)** the three-renderer general showcase wiring (the one open engineering
keystone), **(3)** renderer-abstraction **Decision 6** (GPU-conformance CI —
gates the whole Phase-1 shader rewire), and **(4)** the workspace **arrow
upgrade to ≥59** (restores byte-reproducible packs; arrow-ipc ≥59 sorts IPC
metadata). Plus the freshly-landed ecosystem audit below.

## Shipped — decision records (kept for rationale)

Fully implemented. Read them for the "why", not "what's planned" — the current
behavior lives in the spec and API docs.

- [**stt-packed.md**](./stt-packed.md) — the packed container (manifest +
  content-addressed packs). Format shipped 2026-06-07; live spec
  [`stt-packed-format.md`](../spec/stt-packed-format.md). Now a deferred-work
  register, re-triaged 2026-07-01: the paged `.sttd` directory (shipped
  `92dc0d1`/`b503e24`, decisions D1–D6 recorded here; only the user-run
  re-transcode/R2/verify rollout remains), the global pack store + streaming
  `PackWriter`/D3 bets (counted out with triggers), the MLT lightweight-column
  **negative** result (with the world-grid `--quantize-coords` cross-reference),
  and the COPC/MLT prior-art study.
- [**playback-and-loading.md**](./playback-and-loading.md) — coupling the
  playback clock to data loading, single- and multi-source: the `PlaybackGovernor`
  gate + the N-source registry (min-over-required, AND-complete, cadence tolerance
  band) + `SharedRequestScheduler` (EDF/weighted-fair, `configureSharedScheduler`
  kill-switch). Shipped 2026-06-09 / `86bbb0f`; live docs
  [`stt-player`](../api/stt-player.md), [`playback-governor`](../api/playback-governor.md),
  [`time-controller`](../api/time-controller.md). Merges the former
  `player-buffering.md` + `multi-source-coordination.md`. Follow-ups triaged
  2026-07-01: teardown-hook was already done, runway-nub fixed; maplibre-player /
  exposure-knob / StrictMode counted out; only the user-run multi-source
  browser-verify remains.
- [**av-cockpit.md**](./av-cockpit.md) — the AV `/drive` telemetry cockpit:
  build contract, fidelity refinement (both rounds), and the LiDAR tile-compression
  pass. All shipped (`86bbb0f` … `17789f7`); live docs
  [`sidecar-assets`](../spec/sidecar-assets.md),
  [`AnimatedBoundingBoxLayer`](../api/animated-bounding-box-layer.md), and the
  `--quantize-attr(s-auto)` flags in [`cli-reference`](../api/cli-reference.md).
  Merges the former `av-refinement.md` + `av-lidar-compression.md`.
- [**db-input-adaptors.md**](./db-input-adaptors.md) — PostGIS + DuckDB as
  first-class `stt-build` **input sources** (feature-gated, WKB→`ParsedFeature`
  seam) **and** the two backends of `stt-serve`, a dynamic per-request STT tile
  server at full offline-generation parity via shared `build_options`. Base
  shipped `17789f7`; parity layer uncommitted. IBTrACS: DB ingest byte-equivalent
  + as-fast/faster than file; serve ~2 ms (PostGIS) / ~5 ms (DuckDB) per tile.
  CLI in [`cli-reference`](../api/cli-reference.md). Merges the former
  `postgis-integration.md` + `duckdb-integration.md`. §8 re-pointed 2026-07-01 at
  the triaged backlog (several "open" items there had already shipped).
- [**naming-types-consistency-2026-06.md**](./naming-types-consistency-2026-06.md)
  — cross-language (Rust/TS/Python/docs) naming/types/formats consistency audit.
  Phases 0–4 implemented (fixed the one real bug: scalar `--time-field`
  rejecting ns/sec). **CLOSED 2026-07-01** — the F9 doc-gate slice shipped
  (per-binary clap↔`cli-reference.md` tests), the normalizer hoist + palette
  guard were verified already-done, and F12 / Phase-5 `u64→i64` / the accessor
  fork / the F4 rename are counted out with rationale.
- [**rust-audit-2026-06.md**](./rust-audit-2026-06.md) — Rust CLI/crate audit vs.
  tippecanoe / PMTiles / COPC / MLT. Waves 0–1 shipped (`f1e4a8c`); paged directory
  + `stt-validate --sample` shipped. **CLOSED 2026-07-01** — the quantized-coord
  re-measurement is DONE (shipped as `--quantize-coords`, the confirmed size
  lever); `-zg` confirmed absent and counted out; measure-loop / bbox column /
  `stt-tools` / `Dataset` trait counted out with triggers.
- [**fe-hotpath-audit-2026-06.md**](./fe-hotpath-audit-2026-06.md) — frontend
  GPU-layer hot-path audit (`packages/layers`, `packages/core`). **CLOSED
  2026-07-01** — all 7 actionable findings verified fixed in the working tree
  (bbox tick gate, single-pass track-index merge, fused elevation copy, baked
  `stt:time_offset_ms`, zero-copy numeric columns, single style-key); 2 rows
  explicitly accepted as non-issues.
- [**doc-coverage-audit-2026-07.md**](./doc-coverage-audit-2026-07.md) — full
  audit of `docs/api`, `docs/architecture`, `docs/spec`, `docs/intro`,
  `docs/guides`, `docs/README.md`, and top-level `README.md` against current
  source: ~15 stale post-reorg source links, several prop-table gaps
  (`colorMapping`, elevation, AV-box outline/label/velocity, `lodMode`), one
  doc with a broken runtime example (`stt-react.md`), a `stt-build`
  GeoParquet-only/DB-input contradiction between two guides, `@poopdeck.gl/cesium`
  (a whole shipped renderer) having zero API docs, and `crates/stt-serve`
  having no architecture/spec home. **Executed 2026-07-01** — the punch list
  was applied, including the new
  [`stt-cesium.md`](../api/stt-cesium.md),
  [`stt-serve-protocol.md`](../spec/stt-serve-protocol.md),
  [`render-kernel.md`](../api/render-kernel.md),
  [`backend-descriptor.md`](../api/backend-descriptor.md), and four new
  layer/extension pages (`flow-stroke-layer`, `chevron-flow-extension`,
  `splat-layer`, `splat-extension`). Not exhaustive, though: the
  [full-ecosystem audit](./full-ecosystem-audit-2026-07.md) §2/§7 subsequently
  caught residual doc-fact errors (three post-reorg source links needed a
  second fix; wrong defaults in `stt-maplibre.md` and the line/column/
  trip-heads prop tables), corrected in that follow-up.

## Implemented, with open work

Landed but not fully closed — each lists what remains.

- [**shipping-2026-07.md**](./shipping-2026-07.md) — NEW (2026-07-02):
  distribution decision record + publish backlog owner. One public crate name
  (`spatiotemporal-tiles` facade owning all four `stt-*` CLI bins) over three
  internal lib crates; npm `@poopdeck.gl` via changesets + `release-npm.yml`;
  release-plz + cargo-dist for Rust; DB extensions/Python/Docker counted out.
  OPEN: execute the first publishes (npm + crates.io + `v0.1.0` tag).
- [**stt-optimize-intelligence-2026-07.md**](./stt-optimize-intelligence-2026-07.md)
  — NEW (2026-07-02): stt-optimize from zoom-range guesser to **profiler +
  advisor + doctor** ("measure, don't model"). Shipped same day through P2.5:
  `inspect`/`diff` (measured per-column costs, `--fail-on-growth`), the
  evidence-based advisor layer (`recommend --explain`, `--auto encode`,
  lossy-never-auto-applied), the `style_hints` metadata block
  (`stt-build --style-hints` + TS `metadata.styleHints` parse), and the
  `doctor` linter (`--strict` CI gate). User docs:
  [Tuning your tiles](../guides/tuning-tiles.md). OPEN: FE layer auto-wiring
  of style hints; P3 `--auto-measure` loop stays trigger-gated.
- [**full-ecosystem-audit-2026-07.md**](./full-ecosystem-audit-2026-07.md) — NEW
  (landed 2026-07-01, after the triage pass): seven-slice multi-agent audit of the
  whole repo, ~140 verified findings. Headline criticals: 63 untracked
  load-bearing files (commit hygiene), CI/publish broken end-to-end (no build
  step before typecheck, extensionless ESM in dist, `cargo publish` path-only
  deps, react's non-optional "optional" peer), install docs pointing at
  unpublished packages. Its P0 "stt-build does not compile" is already resolved
  (it snapshotted a mid-edit tree). **This is now the top of the open backlog** —
  not yet triaged item-by-item.
- [**renderer-abstraction-2026-06.md**](./renderer-abstraction-2026-06.md) —
  multi-backend "STT Render Kernel": a framework-free kernel in `@poopdeck.gl/core`
  (time-filter, style, geometry, geo, picking, tileset-adapter, shader-codegen,
  capabilities) that deck / three / maplibre / **cesium** all consume, + per-backend
  `BackendDescriptor`s with an over-claim gate and the generated
  [`backend-capabilities.md`](../spec/backend-capabilities.md). Tier-1 + most of
  Tier-2 implemented + unit-tested but **uncommitted**. Triaged 2026-07-01: the
  op-set contract is now declared + CI-enforced (`docs/spec/render-spec.json`);
  §7 decisions 1–5 are settled/recorded; **Decision 6 (GPU-conformance CI) is the
  one live decision** and gates the deferred Phase-1 shader rewire; small
  leftovers counted out with triggers in §7.
- [**three-renderer-parity.md**](./three-renderer-parity.md) — engine +
  all geo layers committed (`5d0a9c6`/`17789f7`); §6(a) **general non-AV showcase
  wiring is the open item** (it also wires the built-but-unwired streaming /
  basemap-overlay / globe-camera modules); zoom-pixel-match + per-tile-group time
  origin fold into it; heatmap/bundled-flowmap/live-KDEEB/terrain/GPU-pick-wiring
  counted out with triggers.
- [**data-sources-and-encoder.md**](./data-sources-and-encoder.md) — cross-cutting
  learnings distilled from the DB-parity work; the **single owner of the
  DB-path/encoder backlog**, now **fully triaged 2026-07-01**. SHIPPED:
  `EncoderConfig` threading (P0), multi-dataset serve, int-epoch serve filter,
  dropped-data accounting on all three input adaptors (DB readers + the
  GeoParquet file reader). Resolved-by-path: the reproducible-build guard —
  encoder side deterministic + guard tests in place; strict byte-identity waits
  on the **workspace arrow upgrade to ≥59** (verified: arrow-ipc ≥59 sorts IPC
  metadata keys), which is the one remaining scheduled item. Counted out with
  triggers: packed-manifest facade, `stt-validate` drop surfacing, retiring the
  offline globals, flag-spec codegen, TLS, serve LRU, streaming-arrow
  whole-dataset passes, `encode_single_cell`, WKB↔GeoArrow (decision-blocked).

## Forward-looking design (not built)

Genuine future work — nothing implemented yet.

- [**dataset-candidates-2026-07.md**](./dataset-candidates-2026-07.md) — NEW
  (2026-07-01, analysis-only): license-verified shortlist of new large showcase
  datasets that would force genuinely new rendering/representation techniques
  (top 5: HRRR wind → particle advection, GLM lightning → density LOD, NL GTFS
  CC0 transit, NWM rivers, analytic satellite/asteroid motion), plus the
  code-verified list of format gaps they would exercise. Redistribution-safe
  licenses only (the Waymo lesson); OpenSky/GFW/Gaia recorded as blocked.
- [**preprocessing-framework.md**](./preprocessing-framework.md) — bake analytics
  (clustering / aggregation / space-time cube / trend) into tiles at build time via
  a Plan-IR operator DAG + declarative Recipes. Principle: read-cost ∝
  output-resolution, not N. Includes a dataset-bigness archetype playbook, a unified
  spatial × temporal × attribute LOD model (four baked couplings + "one ranking,
  many zooms"), and the representation ladder (overview vs. detail as *different*
  zoom-dispatched techniques). Design synthesis only — every operator exists
  bespoke, none wired to zoom; **verified accurate against source 2026-07-01 and
  deliberately counted out as a whole** (its Phase-0 determinism prerequisite is
  half-closed via the arrow-upgrade path; `Mean`→`{Sum,Count}` noted as the
  smallest Phase-4 slice). The `vertex_value_matrix` payload it builds on is
  specified in [`data-format.md` §Space-time cube](../architecture/data-format.md#space-time-cube-payload-vertex_value_matrix).

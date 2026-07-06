# Full ecosystem audit — 2026-07-01

Multi-agent audit of the entire repo (working tree on `feat/db-parity-comprehensive`, uncommitted state
audited as-is). Seven parallel slices: Rust workspace, `@poopdeck.gl/core`+`layers`, renderer packages
(three/maplibre/cesium/react/playback), cross-language contracts, docs-vs-reality, infra/CI/publishing,
showcase + Python data-generation. ~140 verified findings, deduplicated and ranked below. Every finding
carries file:line evidence; "verified" means confirmed in source (or by running the named command), not
inferred.

**Headline:** the format core is in genuinely good shape — wire constants match across Rust/TS, the CLI
reference is near-1:1 with clap, and most prior-audit fixes verifiably landed. The three systemic problems
are: (1) the working tree currently does not compile; (2) the release story (CI, publish, dist artifacts)
is broken end-to-end; (3) drift keeps re-appearing exactly where logic is hand-copied instead of enforced
— renderers, DB readers, palettes, Python helpers.

---

## 1. Critical — fix before anything else

- ~~**[P0] stt-build does not compile.**~~ **RESOLVED same day (2026-07-01 evening)** — the audit
  snapshotted a mid-edit working tree: the dropped-column accounting was being wired in a parallel
  session at audit time. `parse_batch` now takes `seen_props: &mut [bool]` and populates it in the
  property loop; `warn_dropped_property_columns` reports at EOF. Verified after completion:
  `cargo test --workspace` green (exit 0).
- **[P0] 63 untracked files include load-bearing source.** `packages/cesium/` (entire package),
  `packages/core/src/render/` + `src/geo/` (which the *tracked, modified* core `exports` map points at),
  `crates/stt-core/src/timestamp.rs`, `crates/stt-build/src/build_options.rs`, ~25 test files. A commit
  that misses them produces an unbuildable tree — showcase's tracked package.json already depends on
  `@poopdeck.gl/cesium: workspace:*` and `git ls-files packages/core/src/render` returns nothing.
- **[P0] CI cannot pass on a clean runner.** `.github/workflows/ci.yml:36-41` typechecks/tests with no
  build step, but cross-package imports resolve through `exports` → gitignored `dist/`; turbo `typecheck`
  has no `dependsOn: ["^build"]` (`turbo.json:27`). Additionally `ci.yml:30,55,83` pins
  `pnpm/action-setup version: 10` while `package.json:6` pins `packageManager: pnpm@10.19.0` — the dual
  spec errors at setup.
- **[P0] Published dist is broken under plain Node.** Compiled ESM uses extensionless relative imports
  (`packages/*/dist/index.js:4` → `from './types'`); verified live with a `node -e "import(...)"` probe
  → `Cannot find module`. The repo's own bench harness ships a workaround loader
  (`tools/bench/src/index.mjs:4-18`). Fix at the source: `moduleResolution: NodeNext` (or a bundler step).
- **[P0] `cargo publish` hard-fails for 5 of 6 crates.** All intra-workspace deps are `path`-only with no
  `version` (`crates/stt-build/Cargo.toml:19-20`, same in generate/serve/validate/optimize) and no crate
  sets `publish = false`.
- **[P0] `@poopdeck.gl/react` is unusable without its "optional" peers.**
  `packages/react/src/components/HoverPreview.tsx:22` value-imports `@deck.gl/react` and the barrel
  re-exports it unconditionally (`src/index.ts:34`), so `import { usePlayback }` fails without deck
  installed — contradicting `peerDependenciesMeta` optional and the barrel's own "zero rendering deps"
  comment. Needs a `./hover-preview` subpath or lazy import.
- **[P0 docs] Install instructions point at unpublished packages.** `examples/README.md:68,74-75` and
  `packages/three/README.md:37-40` say `npm install @poopdeck.gl/*`; `npm view` returns E404 (verified
  live). A newcomer's first command fails.

## 2. Correctness bugs (shipped behavior is wrong)

### Rust
- `crates/stt-optimize/src/loader.rs:223` — feature latitude derived with a **linear** Mercator inverse
  instead of `atan(sinh(...))` (contrast `stt-core/src/projection.rs:120-133`), skewing every
  `stt-optimize --stt` spatial/zoom/hotspot result.
- `crates/stt-serve/src/main.rs:609` — `metadata_json` hardcodes `"/tiles/{z}/{x}/{y}/{t}.stt"` in
  `--config` multi-dataset mode, where tiles are only routed at `/:dataset/tiles/...` (`main.rs:1246`);
  clients following the advertised template 404.
- `crates/stt-build/src/duckdb_input.rs:122` vs `postgres_input.rs:110` — serve prefilter divergence:
  DuckDB `ST_Intersects` vs PG bbox `&&`. Centroid-placed features (`tiler.rs:461-466`) can be omitted by
  the DuckDB backend in tiles the offline build populates (PG's bbox is a safe superset; exact intersect
  is not).
- `crates/stt-optimize/src/loader.rs:222` — `1u32 << entry.zoom` on an unvalidated archive byte: corrupt
  `zoom ≥ 32` panics (debug) / wraps (release).

### Renderers
- **Elevation units unreconciled** — maplibre `DEFAULT_ALTITUDE_SCALE = 1e-7`
  (`packages/maplibre/src/lib/projection.ts:59`) vs deck true-metre `project_size` vs three
  1-unit=1-metre: maplibre extrusions render ~4.0× too tall at the equator (~2.8× at 45°) for identical
  data. (Explicitly flagged in the renderer-abstraction doc §5.5, never fixed.)
- **Globe datum split** — three's `GlobeProjection` defaults `datum:'sphere'`
  (`packages/core/src/geo/globe.ts:60`, `three/src/scene/globe-basemap.ts:7` literal `SphereGeometry`)
  while cesium hardcodes `wgs84` (`cesium/src/cesium-point-layer.ts:79`). Up to ~21 km misregistration
  between the two globe backends for the same lon/lat/alt.
- **`trailFade` semantics diverge** — maplibre treats it as a boolean threshold
  (`maplibre/src/shaders/time-window.glsl.ts:101`) while core/deck/three blend continuously
  (`core/src/render/time-filter.ts:109`, `layers/.../time-filter-extension.ts:360`,
  `three/src/tsl/time-filter.ts:102`). Live risk: three exposes `trailFade?: number`
  (`three/src/layers/trips-layer.ts:54`), maplibre can't express it. Same knob is also named `fadeTrail?:
  boolean` in deck/maplibre but `trailFade?: number` in three.
- **Unmapped-category color differs per backend** for the same `point` kind: deck transparent
  (`animated-point-layer.ts:527`), three `[150,160,175,220]` (`three/src/layers/point-cloud-layer.ts:94`),
  cesium `[200,205,215,255]` (`cesium/src/cesium-point-layer.ts:62`).
- maplibre `trailLength <= 0` returns alpha 1 (whole past visible, `time-window.glsl.ts:98`) where deck
  falls through to window mode — different degenerate behavior.

### TS decoder
- `packages/core/src/tile.ts:165-171` and `:570-575` — malformed `stt:quant` / `stt:qa` affine JSON is
  swallowed (`catch { return undefined }` / fall-through-as-identity): quantized tiles render raw
  fixed-point ints as lon/lat/values with **no warning**. Rust's re-reader panics on the same input
  (`reoptimize.rs:200,209`) — silent-wrong vs loud, cross-language error-model fork.

### Docs stating wrong facts (P0-wrong class)
- `docs/api/cli-reference.md:371` documents `stt-generate nyc-rideshare --flow-snap-meters` — flag does
  not exist anywhere (`nyc_rideshare_flows.rs:10` says "no snap lattice"; feature removed, doc kept).
- `docs/api/stt-maplibre.md:150-152` — three wrong defaults on one page: `softTimeWindow` documented
  `true` but effective default is false (`base-layer.ts:831`), `fadeInDuration`/`fadeOutDuration`
  documented "10% of timeWindow" but default 0.
- `docs/api/animated-line-layer.md:33` width default documented 2, actual 1
  (`animated-line-layer.ts:178`); `docs/api/animated-column-layer.md:34` elevation documented 0, actual
  1000 (`animated-column-layer.ts:367`).

## 3. Cross-language contract gaps (file ⇄ PostGIS ⇄ DuckDB ⇄ TS ⇄ validator ⇄ spec)

No P0 wire-format breaks: archive/directory/pack constants, paged manifest fields, and compression
byte-sets all match Rust⇄TS, with golden fixtures. The gaps are at the edges:

- **Int32/unsigned epoch time columns**: file reader hard-rejects (`input.rs:1020,1059-1064`, Int64
  only) while both DB readers accept (`postgres_input.rs:597` INT4; `duckdb_input.rs:694-696`
  Int/UInt/UBigInt). Recurrence of the exact bug class the naming/types Phase 1 fixed for ns/sec units;
  `db-input-adaptors.md:152` documents no width caveat.
- **NULL `--end-time-field` in Warn mode**: file coerces `Some(0)` (widening time_range to epoch 0,
  `input.rs:305-307,995,542`) while PG/DuckDB yield `None` (`postgres_input.rs:518-521`,
  `duckdb_input.rs:608-611`). Same data → different archive time_range.
- **JSON properties**: PG maps JSON/JSONB (`postgres_input.rs:818`), DuckDB has no JSON arm at all
  (`duckdb_input.rs:821-848`) — despite "stay in lockstep" comments on both sides.
- **`stt:time_offset_ms` is a shipped wire key with zero spec presence** (written
  `arrow_tile.rs:1573-1574`, read `tile.ts:356-361`, grep of docs/ → nothing).
- **Validator blind spots** (`stt-validate/src/schema.rs`): accepts Int32-leaf geometry without requiring
  `stt:quant` (`schema.rs:162-167` vs the `stt:qa` gate that DOES exist at `:190-192`); never checks
  `stt:vertex_time_origin_ms`/`step_ms` (TS silently decodes with origin=0/step=1 defaults,
  `tile.ts:394-395` → wrong timestamps, no error on either side); never validates
  `stt:vertex_value_buckets`, `stt:has_triangles` values, or the CRS84 `ARROW:extension:metadata` that
  `conformance.md:143-144` makes a writer MUST; paged-directory validation is only transitive through
  `verify_packed_objects`.
- **Reference TS reader violates a published reader-MUST** — `conformance.md:169` requires rejecting
  unrecognized `format`/`formatVersion`/`directoryVersion`; `archive.ts:667-668` rejects `format` only.
- **Spec-conformance blind spots** (`spec_conformance.rs`): zero coverage of `stt:qa`, `stt:quant`, the
  paged directory, `encode_single_tile` (the stt-serve hot path — one in-module unit test,
  `tiler.rs:1394`), and `vertex_value_matrix` bucket counts.
- **PostGIS parity is CI-dormant**: `source_parity.rs:97,120` are `#[ignore]`d behind `STT_TEST_PG_DSN`
  while the DuckDB twins run by default — the branch's headline "db-parity" claim has no default
  enforcement on the PG side.
- **Wire bytes reproducible — CLOSED 2026-07-04** (was open at audit time: arrow-54 serialized schema
  metadata in HashMap order, byte-identity canary `#[ignore]`d): the workspace arrow upgrade to ≥59
  shipped; `same_tile_encodes_byte_identically` (`reproducible_build.rs`) is active and
  content-addressed dedup is byte-exact cross-process — see `docs/spec/stt-packed-format.md` §7 D6.
- Sec→ms overflow forks: file `checked_mul` errors (`timestamp.rs:70-74`) vs DB `saturating_mul`
  silently saturates (`postgres_input.rs:621`, `duckdb_input.rs:723`).
- File reader silently drops Dictionary/LargeUtf8/Utf8View/Int16/unsigned property columns
  (`input.rs:1105-1124`, warn-only) that the equivalent DB column keeps — dictionary-encoded Parquet
  categoricals are common.
- `stt:layer` is write-only (emitted `arrow_tile.rs:1563`, zero TS reads) — dead metadata for consumers.
- stt-serve cannot reproject (no `--source-srid`, raw `ST_AsEWKB`/`ST_AsWKB`) while stt-build does —
  documented, but a build⇄serve parity break; serve also lacks `--where`.
- `--streaming-arrow` silently cannot emit summary-tier/heatmap-domain/budgets/attribute-filters/
  temporal-lod (`stt-build/src/main.rs:884-940`) — a per-input capability fork absent from parity docs.

## 4. Hand-copy drift — the systemic theme

Every slice found the same failure mode: logic duplicated by hand with comment-only ("MUST match",
"lockstep") enforcement, already drifted or one edit away from it.

**Rust**
- `tiler.rs:428-470` vs `:650-691` — `encode_single_tile_counted` hand-copies `process_zoom_level`'s
  placement/clip/bucket loop (the serve↔offline byte-parity contract); error handling already diverges
  (offline warns-and-skips a failed `build_tile`, single-tile propagates → HTTP 500).
- `postgres_input.rs:309-364,619-626,748-752` vs `duckdb_input.rs:358-412,721-728,804-808` — ~200 lines
  of duplicated decode logic (`VertexCoercions`, `warn_dropped_columns`, `apply_int_time_format`, …).
- Pre-1970 guard hand-rolled in both DB readers instead of calling `reject_negative_timestamp`
  (`timestamp.rs:48-56`).
- `drifters_hourly.rs` is a near-total clone of `drifters.rs` (13 identical fns); 3× `parse_time_ms`
  in stt-generate; 5 hand-rolled reqwest client builders despite `common::download_file`.
- A third hand-rolled WKB parser in `stt-optimize/src/loader.rs:507-717` with **zero tests**, duplicating
  stt-build's geozero path.

**TS layers**
- vertexValueMatrix two-bucket blend hand-copied ≥4× (`flow-corridor-layer.ts:144-180`,
  `flowmap-layer.ts:249-286`, `bundled-flowmap-layer.ts:351,448`, `flow-stroke-layer.ts`).
- 8 hand-rolled styleKey assemblies across three idioms (`computeStyleKey` method vs inline template vs
  `computePropsKey`) over the shared `lib/style-digest.ts` primitives.

**Renderers**
- The Phase-1 "single source of truth" fade resolver has a live contradiction: core
  `resolveTimeFilterParams` gates soft-fade opt-out (`core/src/render/time-filter.ts:289`,
  `!== false`) while maplibre kept its own `resolveFadeDurations` gating opt-in (`base-layer.ts:831`,
  `=== true`), with different floors. Dormant today; re-seeds the exact drift Phase 1 resolved.
- `assertRelTimeInRange` (`core/src/render/time-filter.ts:200`) — the hoisted f32 precision guard — has
  **zero call sites**; deck re-implements the same warn inline (`time-filter-extension.ts:535-543`);
  three's scene-wide f32 rebase and maplibre's window relativization have no diagnostic.
- three re-hardcodes shared palettes with comment-only sync (`three/src/lib/h3-buffers.ts:40`,
  `quadbin-buffers.ts:33`, `arc-buffers.ts:87-88`); the palette-parity test covers deck+maplibre only.

**Python**
- `mat3_to_quat` triplicated — the two extractor copies are byte-identical AND dead
  (`argoverse_extract.py:511`, `waymo_extract.py:654`; only `av_common.py:1931` is called).
- `derive_telemetry` duplicated (argoverse:418 / waymo:476), `FALLBACK_RGB` quadruplicated,
  `copy_camera_frames` duplicated, `_yaw_of` in three drifted forms, `SURFEL_K=12` hand-synced ×4.
- `AV_MAP_COLORS` values unguarded (key-only test) and `AV_ISO_DENSITY_COLORS` untested
  (`datasets.ts:122,201`, `test_av_palette_parity.py:30,159`).
- **None of the three Python test files run in CI** — `test_av_palette_parity.py:11-13` literally claims
  "so the next drift fails CI", and nothing invokes it. The palette-drift guarantee is currently false.

## 5. Dead code

**Rust**
- Unused deps (zero `use` references): stt-core `anyhow`,`wkt`; stt-build
  `thiserror`,`crossbeam`,`earcutr`,`geo-types`; stt-generate `thiserror`,`geo`,`geo-types`; stt-optimize
  `thiserror`,`geo`,`geo-types`,`geojson`,`rayon`,`arrow-schema`,`arrow-array`; stt-serve `chrono`.
- `Recommendations.{chunk_size,compression,confidence,explanations}` + `recommend_compression`
  (hard-returns "zstd", `geometry.rs:282`) have no consumer — `stt-build --auto` reads only zoom/bucket.
- `build_tile_budget` passes `max_bytes` into both uncompressed AND compressed caps; only the
  uncompressed estimate is enforced (`build_options.rs:248`, `tiler.rs:865-868`) — compressed cap dead.
- `AnalyzableFeature.end_timestamp`, `LoadedData.source_name` written-never-read
  (`loader.rs:45,93`).

**TS**
- `getSharedSchedulerMaxRequests` (`core/src/shared-scheduler.ts:126`) — fully dead export.
- The loaders.gl `TileSource` surface (`core/src/tile-source.ts:73`, `archive.ts:2300`) — zero consumers,
  zero tests.
- three `GpuPicker` (`three/src/lib/gpu-pick.ts:85`) — zero instantiations; its only consumer
  `PointCloudLayer.pick` is itself never called. Live picking = CPU ray-OBB only.
- three `StreamingTileSource` + companions test-only; `StandaloneViewer` + `SttScene` dead cluster (the
  showcase uses only `/r3f`).
- maplibre `earcut` + `@types/earcut` dead dependencies (tessellation moved to core's
  `tessellateFeature`).
- `EdgeBundler` public surface, `NoPickingPathLayer`, `CATEGORY_PALETTE_SIZE`, `disableProbe` — no
  external consumers; ~15 core barrel exports are test-only (public surface ≈2× what anything uses).
- Showcase: `MetricGauges.tsx` and `CubeControls.tsx` never imported (DemoViewer uses an inline copy);
  `prefersReducedMotion`, `DATASETS`, `defaultDatasetId` dead exports.
- **Do NOT delete**: `deckBackend` + the `capabilities-doc` subpath look unused to TS grep but are
  consumed by `scripts/gen-capabilities-doc.mjs:10-12` via dist imports.

## 6. API-consistency debt (naming/props)

- Same-concept constant-color prop named 6 ways: `fillColor` (point/column/polygon), `pathColor`,
  `tripColor`, `headColor`, bare `color` (line/icon), `fallbackColor` (splat).
- Outline: `strokeColor`/`strokeWidth` (point) vs `lineColor`/`lineWidth` (column) — both alias the same
  upstream `getLineColor`/`getLineWidth`.
- Accessor-alias (honor-or-reject) adopted by 9 layers but NOT SplatLayer, AnimatedBoundingBox,
  TripHeads, FlowCorridor/FlowStroke, Flowmap, H3/QuadbinSummary — a user's `getFillColor` on summary
  layers is silently dropped; the alias path itself has zero direct test coverage.
- Brand capitalization drift: `SpatiotemporalTileset` (core) vs `SpatioTemporalLayer` (layers).
- `timeWindow` default: 86,400,000 ms on SpatioTemporalLayer vs 0 on standalone TimeFilterExtension.
- Core exports a `Layer` type colliding with deck's `Layer` → 12 rename-imports across consumers.
- `FlowCorridorLayer` reads props through untyped casts (`flow-corridor-layer.ts:69-84`), no declared
  props type, no `FlowCorridorLayerProps` export while every sibling has one.
- Playback integration is a different idiom per backend: deck prop-or-`userData.stt`; three imperative
  `setTime()`; maplibre manual `setCurrentTime()`+`triggerRepaint`; cesium duck-typed clock bridge. A
  host driving all four writes four glue paths.

### Backend parity matrix (from the frozen capability vocabulary; fb→X = declared fallback)

| kind | deck | three | maplibre | cesium |
|---|---|---|---|---|
| point | yes | yes | yes | yes |
| path / icon / column / tripHeads / boundingBox | yes | yes | no | no |
| polygon | yes | yes | yes | no |
| arc | yes | yes | fb→line | no |
| line (OD) | yes | yes | yes | no |
| trips | yes | yes | yes | no |
| surfel/splat | yes | yes | no | fb→point |
| heatmap | yes | fb→point | yes | no |
| h3/quadbin summary | yes | yes | no | no |
| flowmap / flowCorridor | yes | yes | no | no |
| flowStroke | yes | fb→flowCorridor | no | no |
| isoLines | fb→path | yes | no | no |
| ego | no | yes | no | no |
| time modes | all 4 | all 4 | window+trail only | all 4 (CPU) |
| picking | gpu-id all | cpu-ray boxes | none | host scene.pick |

## 7. Docs & onboarding

Verified healthy: cli-reference vs clap is otherwise exhaustive and 1:1 across all five binaries (~50
stt-build flags checked both directions); every previously-undocumented shipped feature now has a page;
zero stale `@stt/` scope references; format-version claims match code.

> **Re-verified 2026-07-01 evening:** most of this section was fixed the same day by the parallel
> docs-verification pass + the roadmap-triage pass. Statuses inline below; the only still-open items
> are the npm/crate **publish metadata** (fold into the §1/§8 publish workstream).

- ~~stt-serve `--config` multi-dataset mode undocumented~~ **RESOLVED** — `cli-reference.md` documents
  `--config`/`--name` + the `/{name}/…` + `/datasets` routes, and the new per-binary
  `cli_flags_are_documented_in_cli_reference` gates keep it that way mechanically.
- Package READMEs: **RESOLVED** — all 7 packages now have READMEs (docs-verification pass). Still open:
  no package.json carries `repository`/`homepage`/`bugs`, and no crate has
  `keywords`/`categories`/`readme`/`rust-version` or a `crates/*/README.md` — publish-metadata work.
  The wrong-org URLs are **RESOLVED** (root `package.json` + workspace `Cargo.toml` now point at
  `github.com/BertCh/spatiotemporal-tiles`).
- ~~3 stale source links from the bucketing reorg~~ **RESOLVED** — heatmap/quadbin/point Source links
  now point at the `layers/{summary,core}` paths and the targets exist.
- ~~`backend-descriptor.md` claims no three reference page~~ **RESOLVED** — now links
  [`stt-three.md`](../api/stt-three.md). `packages/three/README.md` points at
  `three-renderer-parity.md`, which exists.
- ~~maintenance examples don't exist~~ **FINDING WAS WRONG** — `repack.rs`, `verify-packed.rs`,
  `simulate_layout.rs` (and 12 more) all exist under `crates/stt-core/examples/`; no doc change needed.
- ~~Showcase README route list stale~~ **RESOLVED** — README describes the `/docs` viewer; no
  `/format`//`/layers` routes remain.

## 8. Infra / CI / publishing (beyond the criticals)

- CI covers only core/layers/maplibre — playback, react, three, cesium have zero CI; showcase vitest
  never runs; `cargo test` runs default features only, so postgres/duckdb adaptors and
  `source_parity.rs` (this branch's headline) never execute in CI, while `--all-features` is built but
  never tested (and would need libproj + bundled-DuckDB anyway).
- Whole `stt-generate` crate excluded from CI over one flaky GMST test — every dataset generator
  untested in CI.
- `lint` is broken end-to-end: `eslint src` scripts everywhere, but eslint isn't a devDependency
  anywhere and no config exists; maplibre/cesium lack the script (silent turbo skip).
- No `prepublishOnly`/`prepack` anywhere — publish ships stale or absent dist silently.
- maplibre/cesium test scripts use `--passWithNoTests` despite real suites — a collection failure passes
  silently.
- Showcase-probe CI job is decorative (bare `break`, `continue-on-error: true` — always green).
- Fixture-frozen cross-language tests: no CI step regenerates golden fixtures from the current Rust
  encoder; drift surfaces only on manual re-bless.
- Duplicate divergent workspace defs: `pnpm-workspace.yaml` includes `tools/*`, the (pnpm-ignored)
  `package.json#workspaces` doesn't — misleading for non-pnpm tooling.
- Root tsconfig `composite: true` with no project references — inert machinery; tools/render-test TS is
  typechecked by nothing; showcase has no `typecheck` script (largest TS surface skipped by root
  typecheck).
- No `LICENSE` file in any package dir (tarballs ship `"license": "MIT"` with no text); no fmt/clippy/
  prettier in CI; push-trigger CI is main/master only; no release/publish workflows.
- maplibre peer range `^3 || ^4` excludes maplibre-gl v5 — known API break, but undocumented (no README).
- `@poopdeck.gl/three` declares `@poopdeck.gl/playback` as a runtime dep but both imports are
  `import type` — compile-time erased; should be dev/peer.
- Verified clean: `.gitignore` correctly covers `data/` (17GB), `target/` (77GB), `scratch-duckdb/`,
  logs, `.env` (real secrets untracked); shell scripts are NOT rotten (all referenced binaries/examples
  exist; flags match current CLIs); wrangler configs in sync; per-package tsconfigs consistent.

## 9. Showcase & Python pipeline

- **[P1] Dead-on-prod demos, live in the registry** (verified by live HTTPS probes against
  `tiles.poopdeck.gl`): all 6 `argoverse-*-lod` variants are registered and un-gated, so the prod
  cockpit shows a "Zoom LOD" pill whose tiles 404 remotely (add `-lod` to `HELD_BACK_AV_MODES` or sync
  the archives); likewise `bixi-streets-flow`, `bixi-corridors`, `bixi-points`, `bixi-live`
  (`datasets.ts:1309,1384,1464,1517`) — local archives exist, R2 sync never ran, nothing marks them
  local-only, so prod deep links fail. Two entries are dead even in dev (`argoverse-02a00399-scan`,
  `waymo-sf-day-world` — no local archives either).
- **[P1] `scripts/r2-sync.sh:238-239` — default all-datasets mode has no `waymo-*` exclusion**, so one
  default invocation publishes the no-redistribution Waymo bundles; the license gate lives only in the
  FE filter (`datasets.ts:4255`) and operator discipline (currently holding — waymo manifests 404 on
  R2, curl-verified). Also `.argoverse-02a00399-iso3d.bak` (81MB) in `public/data/` matches the sync
  globs and would be uploaded.
- **No error boundaries anywhere** in showcase; a manifest 404 renders a blank map with live controls
  and no message (`DemoPage.tsx` 176 lines, zero error handling; `buildDemoLayers.ts:110` exposes only
  `onTilesetReady`). This is what makes the dead-on-prod demos invisible. AvCockpit surfaces only a
  failed `scene.json`; a lidar-manifest 404 shows an empty cloud (`AvCockpit.tsx:298-316`,
  `.catch(() => null)` at :307,313).
- Orphaned payloads in `public/data/`: superseded `earthquakes` (72MB) + `earthquakes-summary` (29MB),
  the 81MB `.bak` above, and `nyc-taxi-points.new.parquet` (539MB) + 0-byte `.stt` build leftovers.
- `scripts/data-generation/generate-datasets-config.js` — stale generator whose documented default
  output would clobber the 4,324-line hand-maintained `datasets.ts` registry.
- Third-layer palette copy already drifted: `AV_HEIGHT_BAND_LEGEND` hex `#28a8a8` vs its RGBA source
  `[38,168,168]` = `#26a8a8` (`datasets.ts:189` vs `:60`) — imperceptible, but proves the hand-derived
  hex layer is unenforced (the Python⇄TS parity test itself passes 4/4 today, executed during audit).
- **Hard-coded personal Mapbox token committed as fallback in 3 files** (`DemoViewer.tsx:25`,
  `previewBasemap.ts:8`, `AvDeck.tsx:48`); `VITE_MAPBOX_TOKEN` undocumented; no `.env.example`;
  `VITE_GOOGLE_MAPS_API_KEY` / `VITE_DATA_BASE_URL` also undocumented (the Google key itself is
  correctly gitignored).
- Feature gates (inventory): `HELD_BACK_AV_MODES = /-(scan|world)$/` (hides in dev AND prod — gated
  code testable only by editing the regex) and `WAYMO_LOCAL_ONLY = /^waymo-/` (FE-only, active only
  when `VITE_DATA_BASE_URL` set) at `datasets.ts:4243,4255`; `STAGE_LOCAL_ONLY` removed as intended;
  `SHIPPED_DATASET_IDS`/`navDatasets` trims nav to 8 demos but everything else stays deep-linkable
  (which is what exposes the dead-on-prod entries); Google 3D Tiles toggle gated on
  `dataset.tiles3d && VITE_GOOGLE_MAPS_API_KEY`.
- `waymo_surfel_batch.sh` / `waymo_world_batch.sh` rely on the component cache from `waymo_batch.sh`,
  whose COMPONENTS list omits `camera_calibration` — but `--surfel`/`--worldbuild` force the colorizer,
  which hard-aborts on the missing parquet (`waymo_extract.py:1020-1067`). Only the stage batch fetches
  it.
- All 14 batch scripts consume pre-built `target/release/stt-build` with no freshness check (the known
  stale-binary gotcha, still unmitigated); `set -euo pipefail` aborts a whole city loop on one transient
  network error (no per-scene `|| continue`); `setup-osrm.sh` DATA_DIR is CWD-relative unlike every
  batch script.
- Silent excepts: `comma_extract.py:158-160` swallows missing frame_velocities;
  `argoverse_extract.py:1124-1127` drops lane centerlines on ANY error unlogged; missing nuScenes JPGs
  silently degrade all coloring to FALLBACK_RGB.
- Venv reproducibility: only `requirements-ecco.txt` exists; 5 of 7 venvs reproducible only by
  reverse-engineering imports.
- Positive: determinism is sound (all RNGs seeded, sorted iteration, insertion-ordered accumulators);
  reduced-motion coverage comprehensive (one gap: CesiumRenderer lacks the hook, mitigated by
  paused-by-default playback); router complete; all extractor/stt-build flags in batch scripts match
  clap/argparse exactly.

## 10. Verified healthy (calibration)

Prior fixes that verifiably landed: worker decode fallback now warns (`tile-decoder.ts:320-323`);
`@deprecated` aliases all removed (test-enforced); playback re-export from layers cleanly gone;
accessor-alias adopted on 9 layers; palettes single-sourced within layers; `wakeTailScale` unified at
0.15 across 4 copies; window/wake/cumulative alpha math converged across all four renderer copies;
surfel Gaussian parity holds deck⇄three; `SPEED_STEPS` single-sourced; manifest schema tri-pinned;
paged codec mirrored with golden fixtures; shared timestamp normalizer real and called; timestamp hoist
that `naming-types-consistency-2026-06.md:47` still lists as open actually shipped. All five peripheral
package test suites run green (514 tests).

## Recommended sequence

1. **Unbreak the tree**: fix the `parse_batch` arity mismatch (wire `seen_props` through), run the
   suites, then commit the 63 untracked load-bearing files.
2. **Make CI real**: build-before-typecheck (turbo `dependsOn: ["^build"]`), drop the pnpm version
   input, extend filters to all 7 packages + showcase, add a `duckdb`-feature test job and a
   Postgres service container to un-`#[ignore]` `source_parity.rs`, add the 3 Python test files, remove
   `--passWithNoTests`, either fix or delete the lint scripts.
3. **Publish hygiene batch** (mostly mechanical): READMEs ×6 packages + crates, `repository` fields
   (correct org), versioned path-deps in Cargo.tomls, `prepublishOnly: build`, NodeNext/extension fix
   for dist ESM, react barrel decoupled from deck, per-package LICENSE.
4. **Enforcement over duplication** (the recurring root cause): extend palette-parity to three; delete
   maplibre's fade resolver in favor of core's (they contradict); extract the vertexValueMatrix blend
   helper; wire or delete `assertRelTimeInRange`; share the DB-reader decode core; collapse
   `drifters_hourly`; hoist the Python helpers into av_common and put the Python tests in CI.
5. **Close the format loop**: validator checks for `stt:quant` + vertex-time origin/step + bucket
   counts; spec_conformance tests for quantization/paged-dir/`encode_single_tile`; document
   `stt:time_offset_ms`; decide the Int32-epoch and NULL-end-time semantics once and apply to all three
   readers.
6. **Registry/R2 hygiene**: gate or sync the dead-on-prod demos (`-lod`, four bixi ids), add a
   `waymo-*` exclusion to `r2-sync.sh` so the license gate isn't FE-only, prune the ~720MB of orphaned
   `public/data/` payloads, add an error surface to the demo path so a 404 manifest is visible.
7. **Dead-code sweep**: the §5 list, minus the `gen-capabilities-doc.mjs` consumers.

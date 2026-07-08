# Full ecosystem audit — 2026-07-01

Multi-agent audit of the entire repo (working tree on `feat/db-parity-comprehensive`, uncommitted state
audited as-is). Seven parallel slices: Rust workspace, `@poopdeck.gl/core`+`layers`, renderer packages
(three/maplibre/cesium/react/playback), cross-language contracts, docs-vs-reality, infra/CI/publishing,
showcase + Python data-generation. ~140 verified findings, deduplicated and ranked below. Every finding
carries file:line evidence; "verified" means confirmed in source (or by running the named command), not
inferred.

**Status 2026-07-07 — still the top of the open backlog, with a narrower scope.** The release-story
criticals resolved with the 0.3.0 publish (both registries, 2026-07-05 — see `shipping-2026-07.md`).
What stays open here: **§2** (correctness bugs, untriaged), **§4** (hand-copy drift, the systemic
thesis), **§5** (dead code), **§6** (API debt + the backend parity matrix), **§9** (showcase/Python)
— plus the one live **§1** item, CI, which becomes actionable only when GitHub Actions revives. The
thesis stands: drift keeps re-appearing exactly where logic is hand-copied instead of enforced —
renderers, DB readers, palettes, Python helpers.

---

## 1. Critical — resolved ledger + one live item

Six of the seven criticals are **resolved** (full detail in this file's git history):

- stt-build compile failure — a mid-edit working-tree snapshot; fixed same day, `cargo test --workspace` green.
- 63 untracked load-bearing files — committed; untracked count now 8 (2026-07-07), none load-bearing.
- Published dist broken under plain Node (extensionless ESM imports) — fixed at the source via `moduleResolution: NodeNext`.
- `cargo publish` hard-fail on path-only deps — versioned; facade + internal crates published 2026-07-05.
- `@poopdeck.gl/react` unusable without "optional" peers — fixed via the `./hover-preview` subpath.
- Install docs pointing at unpublished packages — now point at the published packages (0.3.0 live on npm).

Still live:

- **[P0] CI cannot pass on a clean runner — now unverifiable.** `ci.yml` was rewritten 2026-07-02
  (build-before-typecheck, pnpm pin fix), but GitHub Actions is dead for this repo: nothing runs or
  enforces, so the rewritten config has never been demonstrated green on a clean runner. Re-verify the
  moment Actions revives.

## 2. Correctness bugs (shipped behavior is wrong)

### Rust
- `crates/stt-optimize/src/loader.rs:223` — feature latitude uses a **linear** Mercator inverse instead
  of `atan(sinh(...))` (contrast `projection.rs:120-133`), skewing every `stt-optimize --stt`
  spatial/zoom/hotspot result.
- stt-serve `metadata_json` (now at `crates/spatiotemporal-tiles/src/bin/stt-serve/`) hardcodes
  `"/tiles/{z}/{x}/{y}/{t}.stt"` in `--config` multi-dataset mode where tiles are only routed at
  `/:dataset/tiles/...` — clients following the advertised template 404.
- `duckdb_input.rs:122` vs `postgres_input.rs:110` — serve prefilter divergence: DuckDB `ST_Intersects`
  vs PG bbox `&&`; centroid-placed features (`tiler.rs:461-466`) can be omitted by DuckDB in tiles the
  offline build populates (bbox is a safe superset; exact intersect is not).
- `stt-optimize/src/loader.rs:222` — `1u32 << entry.zoom` on an unvalidated archive byte: corrupt
  `zoom ≥ 32` panics (debug) / wraps (release).

### Renderers
- **Elevation units unreconciled** — maplibre `DEFAULT_ALTITUDE_SCALE = 1e-7` (`lib/projection.ts:59`)
  vs deck true-metre `project_size` vs three 1-unit=1-metre: maplibre extrusions ~4.0× too tall at the
  equator (~2.8× at 45°) for identical data. (Flagged in the renderer-abstraction doc §5.5, never fixed.)
- **Globe datum split** — three defaults `datum:'sphere'` (`core/src/geo/globe.ts:60`, literal
  `SphereGeometry` in `globe-basemap.ts:7`) while cesium hardcodes `wgs84`
  (`cesium-point-layer.ts:79`) — up to ~21 km misregistration for the same lon/lat/alt.
- **`trailFade` semantics diverge** — maplibre boolean threshold (`time-window.glsl.ts:101`) vs
  core/deck/three continuous blend (`time-filter.ts:109`, `time-filter-extension.ts:360`,
  `tsl/time-filter.ts:102`); three exposes `trailFade?: number` (`trips-layer.ts:54`), maplibre can't
  express it; also named `fadeTrail?: boolean` in deck/maplibre but `trailFade?: number` in three.
- **Unmapped-category color differs per backend** for `point`: deck transparent
  (`animated-point-layer.ts:527`), three `[150,160,175,220]` (`point-cloud-layer.ts:94`), cesium
  `[200,205,215,255]` (`cesium-point-layer.ts:62`).
- maplibre `trailLength <= 0` returns alpha 1 (whole past visible, `time-window.glsl.ts:98`) where deck
  falls through to window mode — different degenerate behavior.

### TS decoder
- `core/src/tile.ts:165-171`, `:570-575` — malformed `stt:quant`/`stt:qa` affine JSON is swallowed
  (`catch { return undefined }` / identity fall-through): quantized tiles render raw fixed-point ints as
  lon/lat/values with **no warning**; Rust panics on the same input — silent-wrong vs loud,
  cross-language error-model fork.

### Docs stating wrong facts (P0-wrong class)
- `cli-reference.md:371` documents `stt-generate nyc-rideshare --flow-snap-meters` — the flag does not
  exist (`nyc_rideshare_flows.rs:10`: "no snap lattice"; feature removed, doc kept).
- `stt-maplibre.md:150-152` — three wrong defaults on one page: `softTimeWindow` documented `true`,
  effective default false (`base-layer.ts:831`); `fadeInDuration`/`fadeOutDuration` documented
  "10% of timeWindow", actual default 0.
- `animated-line-layer.md:33` width documented 2, actual 1 (`animated-line-layer.ts:178`);
  `animated-column-layer.md:34` elevation documented 0, actual 1000 (`animated-column-layer.ts:367`).

## 3. Cross-language contract gaps (file ⇄ PostGIS ⇄ DuckDB ⇄ TS ⇄ validator ⇄ spec)

No P0 wire-format breaks: archive/directory/pack constants, paged manifest fields, and compression
byte-sets all match Rust⇄TS, with golden fixtures. The gaps are at the edges:

- **Int32/unsigned epoch time columns**: file reader hard-rejects (`input.rs:1020,1059-1064`, Int64
  only); both DB readers accept (`postgres_input.rs:597` INT4; `duckdb_input.rs:694-696`
  Int/UInt/UBigInt) — the exact bug class naming/types Phase 1 fixed for ns/sec units.
- **NULL `--end-time-field` in Warn mode**: file coerces `Some(0)` (widening time_range to epoch 0,
  `input.rs:305-307,995,542`); PG/DuckDB yield `None` — same data → different archive time_range.
- **JSON properties**: PG maps JSON/JSONB (`postgres_input.rs:818`), DuckDB has no JSON arm
  (`duckdb_input.rs:821-848`) — despite "stay in lockstep" comments on both sides.
- **`stt:time_offset_ms` is a shipped wire key with zero spec presence** (written
  `arrow_tile.rs:1573-1574`, read `tile.ts:356-361`, grep of docs/ → nothing).
- **Validator blind spots** (`stt-validate/src/schema.rs`): accepts Int32-leaf geometry without
  `stt:quant` (`schema.rs:162-167`, vs the `stt:qa` gate at `:190-192`); never checks
  `stt:vertex_time_origin_ms`/`step_ms` (TS silently decodes with origin=0/step=1 → wrong timestamps,
  no error either side), `stt:vertex_value_buckets`, `stt:has_triangles`, or the CRS84
  `ARROW:extension:metadata` writer-MUST (`conformance.md:143-144`); paged-directory validation only
  transitive via `verify_packed_objects`.
- **Reference TS reader violates a published reader-MUST** — `conformance.md:169` requires rejecting
  unrecognized `format`/`formatVersion`/`directoryVersion`; `archive.ts:667-668` rejects `format` only.
- **Spec-conformance blind spots** (`spec_conformance.rs`): zero coverage of `stt:qa`/`stt:quant`, the
  paged directory, `encode_single_tile` (the stt-serve hot path — one unit test, `tiler.rs:1394`), and
  `vertex_value_matrix` bucket counts.
- **PostGIS parity is CI-dormant**: `source_parity.rs:97,120` `#[ignore]`d behind `STT_TEST_PG_DSN`
  while the DuckDB twins run by default — no default enforcement on the PG side.
- **Wire bytes reproducible — CLOSED 2026-07-04**: workspace arrow ≥59 shipped;
  `same_tile_encodes_byte_identically` active; content-addressed dedup byte-exact cross-process — see
  `docs/spec/stt-packed-format.md` §7 D6.
- Sec→ms overflow forks (file `checked_mul` errors vs DB `saturating_mul` saturates) — **closed; see
  `naming-types-consistency-2026-06.md`**: shared `normalize_timestamp_to_ms` + negative-timestamp
  guard in `stt-core/src/timestamp.rs` own the conversion for all four readers.
- File reader silently drops Dictionary/LargeUtf8/Utf8View/Int16/unsigned property columns
  (`input.rs:1105-1124`, warn-only) that the equivalent DB column keeps.
- `stt:layer` is write-only (emitted `arrow_tile.rs:1563`, zero TS reads) — dead metadata.
- stt-serve reproject gap — **closed 2026-07-05**: `--source-srid` shipped in the DB deep-review
  batch; serve still lacks `--where`.
- `--streaming-arrow` capability fork — **moot 2026-07-04**: flag removed with the transcode removal.

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
- `drifters_hourly.rs` a near-total clone of `drifters.rs` (13 identical fns); 3× `parse_time_ms` in
  stt-generate; 5 hand-rolled reqwest client builders despite `common::download_file`.
- A third hand-rolled WKB parser in `stt-optimize/src/loader.rs:507-717`, **zero tests**, duplicating
  stt-build's geozero path.

**TS layers**
- vertexValueMatrix two-bucket blend hand-copied ≥4× (`flow-corridor-layer.ts:144-180`,
  `flowmap-layer.ts:249-286`, `bundled-flowmap-layer.ts:351,448`, `flow-stroke-layer.ts`).
- 8 hand-rolled styleKey assemblies across three idioms over the shared `lib/style-digest.ts` primitives.

**Renderers**
- The Phase-1 "single source of truth" fade resolver has a live contradiction: core
  `resolveTimeFilterParams` gates soft-fade opt-out (`time-filter.ts:289`, `!== false`) while maplibre
  kept its own `resolveFadeDurations` gating opt-in (`base-layer.ts:831`, `=== true`), different floors —
  dormant today; re-seeds the exact drift Phase 1 resolved.
- `assertRelTimeInRange` (`time-filter.ts:200`) — the hoisted f32 precision guard — has **zero call
  sites**; deck re-implements the warn inline (`time-filter-extension.ts:535-543`); three's f32 rebase
  and maplibre's window relativization have no diagnostic.
- three re-hardcodes shared palettes with comment-only sync (`h3-buffers.ts:40`, `quadbin-buffers.ts:33`,
  `arc-buffers.ts:87-88`); the palette-parity test covers deck+maplibre only.

**Python**
- `mat3_to_quat` triplicated — the two extractor copies byte-identical AND dead
  (`argoverse_extract.py:511`, `waymo_extract.py:654`; only `av_common.py:1931` is called).
- `derive_telemetry` duplicated (argoverse:418 / waymo:476), `FALLBACK_RGB` quadruplicated,
  `copy_camera_frames` duplicated, `_yaw_of` in three drifted forms, `SURFEL_K=12` hand-synced ×4.
- `AV_MAP_COLORS` values unguarded (key-only test), `AV_ISO_DENSITY_COLORS` untested
  (`datasets.ts:122,201`, `test_av_palette_parity.py:30,159`).
- **None of the three Python test files run in CI** — `test_av_palette_parity.py:11-13` claims "so the
  next drift fails CI"; nothing invokes it. The palette-drift guarantee is currently false.

## 5. Dead code

**Rust**
- Unused deps (zero `use`): stt-core `anyhow`,`wkt`; stt-build `thiserror`,`crossbeam`,`earcutr`,
  `geo-types`; stt-generate `thiserror`,`geo`,`geo-types`; stt-optimize `thiserror`,`geo`,`geo-types`,
  `geojson`,`rayon`,`arrow-schema`,`arrow-array`; stt-serve `chrono`.
- `Recommendations.{chunk_size,compression,confidence,explanations}` + `recommend_compression`
  (hard-returns "zstd", `geometry.rs:282`) have no consumer — `stt-build --auto` reads only zoom/bucket.
- `build_tile_budget` passes `max_bytes` into both uncompressed AND compressed caps; only the
  uncompressed estimate is enforced (`build_options.rs:248`, `tiler.rs:865-868`) — compressed cap dead.
- `AnalyzableFeature.end_timestamp`, `LoadedData.source_name` written-never-read (`loader.rs:45,93`).

**TS**
- `getSharedSchedulerMaxRequests` (`core/src/shared-scheduler.ts:126`) — fully dead export.
- The loaders.gl `TileSource` surface (`tile-source.ts:73`, `archive.ts:2300`) — zero consumers/tests.
- three `GpuPicker` (`gpu-pick.ts:85`) — zero instantiations; its only consumer `PointCloudLayer.pick`
  is itself never called. Live picking = CPU ray-OBB only.
- three `StreamingTileSource` + companions test-only; `StandaloneViewer` + `SttScene` dead cluster (the
  showcase uses only `/r3f`).
- maplibre `earcut` + `@types/earcut` dead deps (tessellation moved to core's `tessellateFeature`).
- `EdgeBundler` public surface, `NoPickingPathLayer`, `CATEGORY_PALETTE_SIZE`, `disableProbe` — no
  external consumers; ~15 core barrel exports test-only (public surface ≈2× what anything uses).
- Showcase: `MetricGauges.tsx` and `CubeControls.tsx` never imported (DemoViewer uses an inline copy);
  `prefersReducedMotion`, `DATASETS`, `defaultDatasetId` dead exports.
- **Do NOT delete**: `deckBackend` + the `capabilities-doc` subpath look unused to TS grep but are
  consumed by `scripts/gen-capabilities-doc.mjs:10-12` via dist imports.

## 6. API-consistency debt (naming/props)

- Same-concept constant-color prop named 6 ways: `fillColor` (point/column/polygon), `pathColor`,
  `tripColor`, `headColor`, bare `color` (line/icon), `fallbackColor` (splat) — *counted out; see
  `naming-types-consistency-2026-06.md`*.
- Outline: `strokeColor`/`strokeWidth` (point) vs `lineColor`/`lineWidth` (column) — both alias the same
  upstream `getLineColor`/`getLineWidth`.
- Accessor-alias (honor-or-reject) adopted by 9 layers but NOT SplatLayer, AnimatedBoundingBox,
  TripHeads, FlowCorridor/FlowStroke, Flowmap, H3/QuadbinSummary — a user's `getFillColor` on summary
  layers is silently dropped; the alias path itself has zero direct test coverage — *the accessor fork
  is counted out; see naming-types (per-backend/per-layer idiom stays)*.
- Brand capitalization drift: `SpatiotemporalTileset` (core) vs `SpatioTemporalLayer` (layers).
- `timeWindow` default: 86,400,000 ms on SpatioTemporalLayer vs 0 on standalone TimeFilterExtension —
  *counted out; see naming-types*.
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

## 7. Docs & onboarding — RESOLVED

All §7 findings fixed same-day (docs-verification + roadmap-triage passes); the trailing npm/crate
publish-metadata items shipped with the 0.3.0 publish hygiene. Detail in this file's git history.

## 8. Infra / CI / publishing (beyond the criticals)

**Addressed by the 2026-07-02 `ci.yml` rewrite — in config only, unverified while Actions is dead
(§1):** all 7 packages + showcase typecheck/test; the 3 Python test files run; a Postgres service
container runs the `#[ignore]`d `source_parity.rs` tests; duckdb-feature and `--all-features` test
jobs; MSRV check; `cargo package` dry-run; the smoke-pack tarball import matrix; `cargo test
--workspace` now includes stt-generate; the showcase-probe job is real (fails on server/probe
failure). Verifiably fixed at package level: `--passWithNoTests` and the broken `lint` scripts are
gone; `prepublishOnly`, per-package LICENSE, and the release workflows shipped with 0.3.0.

Still open:
- Fixture-frozen cross-language tests: no CI step regenerates golden fixtures from the current Rust
  encoder; drift surfaces only on manual re-bless.
- Duplicate divergent workspace defs: `pnpm-workspace.yaml` includes `tools/*`, the (pnpm-ignored)
  `package.json#workspaces` doesn't — misleading for non-pnpm tooling.
- Root tsconfig `composite: true` with no project references — inert machinery; tools/render-test TS is
  typechecked by nothing; showcase has no `typecheck` script (largest TS surface skipped).
- No fmt/clippy/prettier in CI; push-trigger CI is main/master only.
- maplibre peer range `^3 || ^4` excludes maplibre-gl v5 — known API break (port tracked in
  `shipping-2026-07.md` non-goals).
- `@poopdeck.gl/three` declares `@poopdeck.gl/playback` as a runtime dep but both imports are
  `import type` — compile-time erased; should be dev/peer.
- Verified clean: `.gitignore` covers `data/` (17GB), `target/` (77GB), `scratch-duckdb/`, logs, `.env`
  (real secrets untracked); shell scripts NOT rotten; wrangler configs in sync; per-package tsconfigs
  consistent.

## 9. Showcase & Python pipeline

- **[P1] Dead-on-prod demos, live in the registry** (live HTTPS probes against `tiles.poopdeck.gl`):
  all 6 `argoverse-*-lod` variants are registered and un-gated — the prod cockpit shows a "Zoom LOD"
  pill whose tiles 404 remotely (add `-lod` to `HELD_BACK_AV_MODES` or sync); likewise
  `bixi-streets-flow`, `bixi-corridors`, `bixi-points`, `bixi-live`
  (`datasets.ts:1309,1384,1464,1517`) — local archives exist, R2 sync never ran, nothing marks them
  local-only. Two entries dead even in dev (`argoverse-02a00399-scan`, `waymo-sf-day-world`).
- **[P1] `scripts/r2-sync.sh:238-239` — default all-datasets mode has no `waymo-*` exclusion**: one
  default invocation publishes the no-redistribution Waymo bundles; the license gate lives only in the
  FE filter (`datasets.ts:4255`) + operator discipline (holding — waymo manifests 404 on R2,
  curl-verified). The 81MB `.argoverse-02a00399-iso3d.bak` in `public/data/` also matches the sync globs.
- **No error boundaries anywhere** in showcase: a manifest 404 renders a blank map with live controls
  and no message (`DemoPage.tsx`, zero error handling; `buildDemoLayers.ts:110` exposes only
  `onTilesetReady`) — this is what makes the dead-on-prod demos invisible. AvCockpit: lidar-manifest
  404 shows an empty cloud (`.catch(() => null)`, `AvCockpit.tsx:307,313`).
- Orphaned `public/data/` payloads: superseded `earthquakes` (72MB) + `earthquakes-summary` (29MB), the
  81MB `.bak`, `nyc-taxi-points.new.parquet` (539MB), 0-byte `.stt` leftovers.
- `generate-datasets-config.js` — stale generator whose documented default output would clobber the
  4,324-line hand-maintained `datasets.ts` registry.
- Third-layer palette copy already drifted: `AV_HEIGHT_BAND_LEGEND` hex `#28a8a8` vs RGBA source
  `[38,168,168]` = `#26a8a8` (`datasets.ts:189` vs `:60`) — imperceptible, but proves the hand-derived
  hex layer is unenforced.
- **Hard-coded personal Mapbox token committed as fallback in 3 files** (`DemoViewer.tsx:25`,
  `previewBasemap.ts:8`, `AvDeck.tsx:48`); `VITE_MAPBOX_TOKEN` / `VITE_GOOGLE_MAPS_API_KEY` /
  `VITE_DATA_BASE_URL` undocumented; no `.env.example` (the Google key itself correctly gitignored).
- Feature-gate inventory: `HELD_BACK_AV_MODES = /-(scan|world)$/` (hides in dev AND prod) and
  `WAYMO_LOCAL_ONLY = /^waymo-/` (FE-only, active only with `VITE_DATA_BASE_URL`) at
  `datasets.ts:4243,4255`; `SHIPPED_DATASET_IDS`/`navDatasets` trims nav to 8 demos but everything
  stays deep-linkable (which exposes the dead-on-prod entries).
- `waymo_surfel_batch.sh`/`waymo_world_batch.sh` rely on `waymo_batch.sh`'s component cache, whose
  COMPONENTS list omits `camera_calibration` — `--surfel`/`--worldbuild` force the colorizer, which
  hard-aborts on the missing parquet (`waymo_extract.py:1020-1067`).
- All 14 batch scripts consume pre-built `target/release/stt-build` with no freshness check (the known
  stale-binary gotcha); `set -euo pipefail` aborts a whole city loop on one transient network error;
  `setup-osrm.sh` DATA_DIR is CWD-relative unlike every batch script.
- Silent excepts: `comma_extract.py:158-160` swallows missing frame_velocities;
  `argoverse_extract.py:1124-1127` drops lane centerlines on ANY error unlogged; missing nuScenes JPGs
  silently degrade coloring to FALLBACK_RGB.
- Venv reproducibility: only `requirements-ecco.txt` exists; 5 of 7 venvs reproducible only by
  reverse-engineering imports.
- Positive: determinism sound (RNGs seeded, sorted iteration); reduced-motion coverage comprehensive
  (one gap: CesiumRenderer lacks the hook, mitigated by paused-by-default playback); router complete;
  batch-script flags match clap/argparse exactly.

## 10. Verified healthy (calibration)

Prior fixes that verifiably landed: worker decode fallback now warns (`tile-decoder.ts:320-323`);
`@deprecated` aliases all removed (test-enforced); playback re-export from layers cleanly gone;
accessor-alias adopted on 9 layers; palettes single-sourced within layers; `wakeTailScale` unified at
0.15 across 4 copies; window/wake/cumulative alpha math converged across all four renderer copies;
surfel Gaussian parity holds deck⇄three; `SPEED_STEPS` single-sourced; manifest schema tri-pinned;
paged codec mirrored with golden fixtures; shared timestamp normalizer real and called; the
`normalize_timestamp_to_ms` hoist shipped (recorded DONE in `naming-types-consistency-2026-06.md`).
All five peripheral package test suites run green (514 tests).

## Recommended sequence (updated 2026-07-07)

1. ~~Unbreak the tree~~ — **done** (compile fix + untracked files committed).
2. **Make CI real** — config rewritten 2026-07-02 (coverage, service containers, Python tests,
   smoke-pack all present in config — §8) but **blocked on reviving GitHub Actions** (§1).
3. ~~Publish hygiene batch~~ — **done** (0.3.0 shipped to both registries 2026-07-05; see
   `shipping-2026-07.md`).
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

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

**Today the directory holds 21 records** (this README aside): those 14 survivors
plus seven written since — the AI suite, kind-parity, maplibre-parity, the
three-backend SoTA campaign, storm-4D, cosmos/`/worlds`, and SedonaDB. Every one
is indexed in a section below; a doc that is not listed here is not findable, so
new records get an entry in the same pass that creates them.

[`evaluations/`](./evaluations/) sits apart from that count: archived,
reference-only third-party model reviews of the format and the deck.gl
integration from December 2025, written against a tree that predates the
`packages/layers` rename, packed-v2, and the render-kernel abstraction. Prior
art, not a record — see its own README before citing anything in it.

## The open register (single source — stop restating these per-doc)

1. **The user-run rollout/verify ops gate** — the R2 half is now mostly
   discharged: the weather suite synced 2026-07-22 and `3cf6f2c` synced the
   storm-4d / storm-3d / cosmos stems and emptied `LOCAL_ONLY_DATASETS`, so the
   public deploy serves every registered non-Waymo demo. What still remains is
   (a) the **in-browser verify pass**, which is what actually closes the open
   tails of the format record, av-cockpit, playback (multi-source 4-part),
   scrub-LOD QoE, the deck / three / maplibre visual checks, kind-parity
   aesthetics, and storm-4d / `/worlds`; (b) the **demo-fleet republish to
   packed v2** (prune-grace ready); and (c) two registered-but-unsynced stems —
   `rainfall-2019` (the rain-flood composite's rain field) and `gtfs-ch` still
   404 on tiles.poopdeck.gl and are not gated, so the live catalog links them.
2. **GitHub Actions is dead** — blocks renderer Decision 6 (GPU-conformance
   CI, which gates the Phase-1 shader rewire), verification of the rewritten
   CI/release gates, and the ecosystem audit's one live §1 item.
3. **three backend SoTA campaign** — the 2026-07-22 four-agent research synthesis
   absorbed the old "three integration tail" (3d-tiles-renderer integration,
   `SttThreeGeoViewer` wiring, basemap) into a full parity + engine campaign
   ([three-backend-sota-campaign-2026-07.md](./three-backend-sota-campaign-2026-07.md)).
   **In execution:** Waves 0 + 1 and the Wave-2 picking catalog landed in
   `9f52804`; open are Wave 3 (the 3DTilesRendererJS globe/basemap track — the
   old tail proper), the held residency + upload-throttle work (trigger-gated on
   a measurement spike, not a blind rewrite), and the `compileAsync` pre-warm.
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

- [**sedona-integration-2026-07.md**](./sedona-integration-2026-07.md) — adding
  **Apache SedonaDB** (the embedded Rust/DataFusion engine, not the classic
  distributed JVM Sedona) as a third `stt-build` input source and `stt-serve`
  backend beside PostGIS and DuckDB. It is an architectural twin of the DuckDB
  adaptor, so it reuses the `ParsedFeature` seam wholesale and extends
  [db-input-adaptors.md](./db-input-adaptors.md) rather than reopening it.
  Records the pinned facts (sedona 0.3.0 is on crates.io, so an optional feature
  _can_ ship in the published facade — that gate is cleared), the one hard
  constraint (sedona's arrow 57 against the workspace's arrow 59, contained by
  keeping every arrow type inside `sedona_input.rs` and bridging through
  `ST_AsBinary`/WKB), the strict-CRS set-then-transform rule, the
  async→`block_on` seam, and a four-phase plan (spike → ingest → serve →
  close-out).
  Proposed 2026-07-23, scope ratified, **not started**.
- [**space-time-lod-2026-07.md**](./space-time-lod-2026-07.md) — the space×time
  LOD master plan (2026-07-10): dual codebase audit + verified external SOTA →
  six phases (measure → resolution-true simplification → declared reduced
  temporal tiers → additive home-zoom decomposition → SSE + global budget →
  joint space-time policy). Absorbs scrub-LOD P3/P4 (register item 5) and the
  temporal-LOD tail of item 4. Plan only, nothing implemented.
- [**dataset-candidates-2026-07.md**](./dataset-candidates-2026-07.md) — the
  standing demo-datasets register: license-verified shortlist with per-section
  status (GTFS-NL and NWM rivers **SHIPPED** and now live on R2, with absorbed
  build notes; the GTFS-CH sibling is built but unsynced; HRRR wind / GLM
  lightning / asteroids etc. still analysis-only),
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
- [**maplibre-parity-campaign-2026-07.md**](./maplibre-parity-campaign-2026-07.md)
  — the MapLibre/Mapbox native-backend parity campaign (2026-07-22), **COMPLETE**
  (M0–M5, `3a56756`…`4acc537`): a three-agent research pass (custom-layer APIs
  across maplibre v3→v6 and mapbox v3 from source; deck 9.3 interleaved
  internals + ecosystem patterns; whole-repo backend audit) reversed the
  "5-of-23 subset is intentional" posture into **fifteen** native layer kinds,
  all four time modes, DataFilter, latitude-correct metric sizing (with the
  BREAKING D10 reconciliation — `altitudeScale` is now a dimensionless
  exaggeration), id-FBO picking on every kind but heatmap, native globe on v5+
  hosts via the injected projection prelude, a shared tileset, the
  `STTLayerGroup` composite host, and Mapbox v3 mercator + Standard-style slots
  — all as custom layers with zero deck/luma dependency. Keeps the declared
  fallbacks (`liveBundling` permanent, mapbox globe deferred, `text → icon`,
  `pointCloud → point`) and the delivered-vs-plan close-out (§8). Showcase
  wiring landed in `9f52804`; only the user's browser verify (aesthetic +
  globe + fps) remains.
- [**three-backend-sota-campaign-2026-07.md**](./three-backend-sota-campaign-2026-07.md)
  — the three.js backend SoTA campaign (2026-07-22), **in execution**: four-agent
  research pass (deck-vs-three gap audit; geo-ecosystem survey; TSL/WebGPU deep
  dive; large-scale rendering techniques) → four tracks in five waves, against
  headline gaps of 0/6 feature families, points-only picking, replace-all
  residency, fragment-discard time filtering. Landed in `9f52804`: Wave 0
  streaming-knob parity (debounce / prefetch / overviewPreload /
  summaryZoomRange / scrubLod forwarded, summary-tier auto-dispatch), Wave 1's
  vertex-stage time collapse across eight materials and all six feature families
  flipped `supported: true` (motion glide, dataFilter incl. icon,
  `timeHeightScale`, `iconWake`, `pathReveal`, stable colour mapping — each
  opt-in and byte-identical when off), and the Wave-2 picking catalog: ten kinds
  GPU-pickable through a structural `isIdPickable` auto-register, every
  id-material reusing its colour material's gates so picking stays
  time/filter-correct (glide-pick returns null, deferred). Absorbs register
  item 3; see it for what is open.
- [**kind-parity-campaign-2026-07.md**](./kind-parity-campaign-2026-07.md) —
  the geometry-kind & layer parity campaign (2026-07-21): four-agent survey
  baseline (polygons weakest end-to-end, moving-marker interpolation gap,
  orphan layers, `view_map` points-fallback) → four tracks (polygon parity,
  motion parity, adopt-or-cut, AI-surface reach) executed wave-by-wave against
  a target capability matrix. Waves 1–3 ran 2026-07-21/22: antimeridian-aware
  polygon clipping (`b8718ce`), the CPU motion-glide engine and its incremental
  `TrackIndexMaintainer` perf fix, DataFilter + `colorMapping` across all six
  feature families (icon included, closing the §5 matrix), path-reveal
  capability, and a widened `view_map` inference (`fd1a50f`). The doc carries
  the per-wave results, the ratified adopt-or-cut table, the A3 seam-overdraw
  design record, and the adversarial-review bug log. Open last-mile: A3
  implementation (ratify the design first), the C3 path-reveal demo (needs a
  window-fix rebuild), the earthquakes DataFilter slider UI, a B4 icon flagship
  demo, and the user's aesthetic verify. Its header banner still reads "PLAN
  ONLY" — the results sections below it are the truth.
- [**scrub-lod-2026-07.md**](./scrub-lod-2026-07.md) — motion-tier LOD while
  scrubbing: P0–P2 shipped 2026-07-05 (`setInteractive` → `scrubLod`, DEFAULT
  OFF, kill-switched; temporal axis wired but inert); the five-domain SoTA
  survey; P3 baked tier + P4 polish + QoE verify open.
- [**stt-optimize-intelligence-2026-07.md**](./stt-optimize-intelligence-2026-07.md)
  — profiler + advisor + doctor ("measure, don't model"); P0–P2.5 shipped;
  the measure-first evidence (expert plans overturned twice; wins are
  dataset-shaped 1.07×–21×). User docs: [Tuning your tiles](../guides/tuning-tiles.md).
- [**ai-suite-skills-mcp-2026-07.md**](./ai-suite-skills-mcp-2026-07.md) — the
  AI-assisted-suite record (2026-07-07): SoTA reads on Agent Skills and MCP, the
  complementarity split that shaped the product (MCP = connectivity, Skills =
  procedural know-how, shipped as one plugin), the comparables survey behind the
  "the `stt-*` CLIs are our wrangler" posture, the security model (arg-array
  `spawn`, output caps, timeouts, path containment, subprocess opt-in), and the
  phased plan. As built, `@poopdeck.gl/mcp` (`stt-mcp`) registers **thirteen**
  tools — discovery (`list_datasets`, `describe_dataset`), analysis
  (`dataset_report`, `recommend_build`, `diff_datasets`), docs (`search_docs`,
  `get_doc` — this record had deferred them), interactive (`view_map`,
  `set_time`, `play_pause`), and three `--allow-cli`-only execution tools
  (`build_dataset`, `validate_dataset`, `generate_dataset`, the only
  network-touching one) — over stdio + stateless Streamable HTTP, beside the
  `poopdeck-ai` plugin, `llms.txt`, and ten skills. The CARTO tier it grew out
  of was expunged the same day (see its header); layer classes for `view_map`
  specs come from `@poopdeck.gl/layers`. Open: publishing `@poopdeck.gl/mcp` to
  npm (the one unpublished package, so `.mcp.json` still can't `npx` it), remote
  Streamable-HTTP + OAuth hosting, per-skill evals, a registry `server.json`,
  and the deferred `compose_layer`. User docs:
  [AI-assisted workflows](../guides/ai-suite.md).
- [**db-input-adaptors.md**](./db-input-adaptors.md) — PostGIS/DuckDB as
  stt-build inputs + the stt-serve backends, landed on main; now also carries
  the encoder-seam lessons and the static-vs-DB architectural verdict
  (absorbed 2026-07-07). Benchmarks: ingest 0.98×/0.66× vs file, serve
  ~2 ms/~5 ms. Spec: [`stt-serve-protocol.md`](../spec/stt-serve-protocol.md).
- [**rain-flood-demo-2026-07.md**](./rain-flood-demo-2026-07.md) — the
  `rain-flood-2019` weather-drives-water composite (CMORPH isoband rain +
  NWM river overlay): design, data pipeline, and build recipe. Built + wired
  locally; replaces the standalone `nwm-rivers-flood-2019-03` demo; R2 push
  of the `rainfall-2019` archive open (still 404 — register item 1).
- [**storm-4d-greenfield-2026-07.md**](./storm-4d-greenfield-2026-07.md) — the
  "storm as a 4D object" campaign (2026-07-22): the Greenfield, Iowa EF4 of
  2024-05-21 as one volumetric scene — NEXRAD Level II gates stacked by
  elevation with dealiased velocity, the mesocyclone couplet, warning prisms
  rising on VTEC clocks, damage reports and county outages arriving behind the
  storm, cloud-top isobands lifted to brightness-temperature height, stations
  and multi-level winds — the depth-first sibling of `severe-weather-2024` on
  the same clock. Carries the §9 execution contract binding on every build
  agent, the no-thinning reading of the demo's filters (dBZ floor + 150 km crop
  are semantic and declared; gate decimation is a Waymo-class reduced tier over
  a citable raw base), the Py-ART-not-Rust generator rationale, the
  request-only DOW verdict (narrative, not a layer), and the two renderer fixes
  full-duplication pyramids forced (`refinementStrategy: 'no-overlap'`, the
  parent-cover viewport clamp). All nine `storm4d-*` archives are built, synced
  and un-gated (`3cf6f2c`) — the demo is live. Open: the Wave-C stretch tail
  (KOAX second viewpoint, OpenSky aircraft blocked on research-account
  approval, a three-backend variant, a Rust port of the volume generator), the
  optional `--min-zoom 6` volume rebuild, and the user's browser verify. Its
  header still reads "in execution".

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
- [**cosmos-drive-dreams.md**](./cosmos-drive-dreams.md) — the `/worlds` World
  Model Scenario Explorer (2026-07-23): ~300 Cosmos-Drive-Dreams scenarios on a
  synthetic equatorial grid, four COMBINED cross-scenario archives on one shared
  loop, generated video locked to the STT playhead. Carries the split-tar video
  streaming constraint and the measurement that reshaped the demo (variants are
  scattered, so the corpus gives a weather mosaic across worlds, not a carousel
  per world), plus the three layer-side constraints (no box DataFilter,
  hide-only filtering, `filterSize: 1`). Synced and un-gated 2026-07-24
  (`3cf6f2c`, which also taught `scripts/r2-sync.sh` a `[worlds]` sidecar pass —
  the packed passes never covered `worlds.json` or the 266 videos, so the
  gallery would have animated over dead panels); the demo is live. Open: the
  user's in-browser pass.
- [**shipping-2026-07.md**](./shipping-2026-07.md) — distribution record,
  SHIPPED 2026-07-05 (crates.io facade + 7 published npm packages —
  `@poopdeck.gl/mcp` is the eighth in the tree and is still unpublished —
  versions in lockstep): naming rationale, feature/install matrix,
  version/tag + MSRV, auth lifecycle,
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

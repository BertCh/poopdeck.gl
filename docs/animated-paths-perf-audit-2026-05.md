# Animated-Path Layer Family — Performance Audit (2026-05-29)

> Multi-agent audit: 4 subsystem maps → 8 audit dimensions → adversarial verification
> (44 findings, 41 survived, 3 refuted) → synthesis. Branch `audit-fixes-2026-05`.

## 1. Verdict

The animated-path family is **architecturally healthy on the sparse datasets and
structurally over-provisioned on the dense ones**. `flight-trips` (21K aircraft,
AnimatedTripsLayer) is genuinely fast — 120fps / 8.3ms p50 — and needs nothing.
Every demonstrable performance problem traces to **one root cause: a
temporal-bucket / playback-window mismatch**. The producer buckets trips at
**1 hour** (`crates/stt-build/src/tiler.rs:99`, `nyc_rideshare.rs:98`) while the
demos animate a **12.5–60 second** window (`datasets.ts:407,440,457`), so every
loaded tile carries 60–288× more trip-time than the playhead ever shows. The
PathLayer path then tessellates and discards ~91% of that geometry in-shader
(vbudget-1); the VAT path dispatches a VS instance for all ~163 trips/tile when
only ~28 are active (sota-1).

**Critically, the severity ranking is inverted relative to the evidence.** The
only datasets with hard baselines are `flight-trips` (healthy) and
`nyc-taxi-trips` (22.8fps — but that baseline *predates the VAT migration* and
measures dead code). The two highest-severity findings (vbudget-1 on
`nyc-taxi-paths`, vbudget-2 on `satellites`) rest entirely on hand-computed
vertex counts with **zero empirical corroboration** — neither demo has ever been
run through the harness. **The single highest-leverage move is a producer
rebuild: re-bucket the dense datasets to a window-aligned granularity (≈1–5
min).** It is one CLI argument, touches ~7 findings at once, and must be paired
with the first-ever VAT baseline measurement so we stop reasoning about
arithmetic instead of frames.

## 2. The One Big Thing

**Re-bucket the dense trip archives at a temporal granularity that matches the
playback window, and decimate low zooms.**

- **Mechanism.** The 1h `temporal_bucket_ms` (`tiler.rs:99`) is the upstream
  cause of: (a) PathLayer drawing 60× the visible geometry (vbudget-1,
  `time-filter-extension.ts:295–331` discards in-shader only); (b) VAT carrying
  ~163 trips/tile when ~28 are active and dispatching a VS instance for all of
  them (sota-1, `vat-trips-layer.ts:514,820,1034`); (c) the prefetcher staging
  ~10–37MB of future-bucket tiles ahead of a 60s window (tilepipe-4). A 5-min
  bucket drops trips-per-tile ~12× (~163→~14), shrinking VAT instance dispatch,
  texture height, decode CPU, and tile bytes proportionally, with **near-zero
  visual loss** because the window only ever shows the active slice. Stack it
  with line decimation (`simplify.rs` is fully implemented and tested but
  unreachable — `common.rs:946` has no `simplify` field, producer-1) to cut
  another 50–90% of vertices at z10–14 where street detail is sub-pixel.
- **Expected win.** ~12× reduction in VAT per-tile instance/texture/decode cost
  on `nyc-taxi-*`; the bucket fix dissolves the mechanism behind
  vbudget-1/-2/-6, sota-1/-4, tilepipe-1/-4 simultaneously. This is the move
  that converts the unverified "closed the 15× gap" claim (`datasets.ts:431`)
  into a measured reality.
- **Effort / risk.** **Producer change: S** (change the `--temporal-bucket` base
  arg in `nyc_rideshare.rs:98` — NOT the LOD sidecar, which `tiler.rs:278–280`
  hard-restricts to *coarser*-than-base). Decimation plumbing: **M** (add
  `simplify`/`simplify_max_zoom` to `SttBuildOptions`, `common.rs:946`). **Risk:
  low** — smaller buckets mean more tiles/HTTP, but per-tile decode shrinks
  proportionally and the range-coalescer already merges adjacent tiles
  (`archive.ts:689–730`). Set `simplify_max_zoom≈14` so z15–16 stay full-res.

## 3. Ranked Roadmap

### Quick wins (S/M effort, high confidence)

| Action | Affected datasets | Mechanism / expected win | Effort | Risk | Conf |
|---|---|---|---|---|---|
| **Re-bucket dense archives to ~5 min** (`nyc_rideshare.rs:98`, base `--temporal-bucket`) | nyc-taxi-paths, nyc-taxi-trips, nyc-taxi-vat | ~12× fewer trips/tile → ~12× less VAT instance dispatch + texture height + decode; collapses the 60–288× window mismatch behind vbudget-1/sota-1/tilepipe-4 | S | Low (more tiles, but coalesced) | 0.85 |
| **Write the first VAT baseline** (`perf -- nyc-taxi-trips --baseline write`) + baseline `nyc-taxi-vat`, `nyc-taxi-paths`, `satellites` | all struggling | Existing baseline is pre-VAT dead code (`baselines/nyc-taxi-trips-gpu.json` vs `datasets.ts:433`); two highest-severity findings have zero measurement. Establishes ground truth before any fix | S | None (read-only) | 0.95 |
| **Add `lastTilesRef` guard to `VatTripsLayer.renderLayers`** (`vat-trips-layer.ts:937–946`, mirror `animated-trips-layer.ts:365`) | nyc-taxi-trips, nyc-taxi-vat | Stops O(tiles+cache) prune walk on prop-only renders; the only animated layer missing the guard 5 siblings have (cpuframe-3) | S | None | 0.95 |
| **VAT texture → `rg32float`** (`vat-trips-layer.ts:1025,550,853`; resample stride `219–223`; sample `.xy` `312/607`) | nyc-taxi-trips, nyc-taxi-vat | B/A channels are always 0; halves host alloc + VRAM + texture-fetch bandwidth (134MB→67MB worst case). luma's `render:false` flag is irrelevant (texture is VS-sampled only) (attribmem-2, shader-3) | S | Low (touch both head+trail format strings) | 0.90 |
| **Strip the dead `picking` module from VAT** (`VAT_SHADER_MODULES`, `vat-trips-layer.ts:411`) | nyc-taxi-trips, nyc-taxi-vat | VAT is `pickable:false` with zero `picking_` calls in either shader, yet bundles `instancePickingColors` + picking varyings on every model — the exact cost NoPickingPathLayer exists to avoid (**critique gap #3, missed finding**) | S | Low (verify picking varyings unreferenced) | 0.8 |
| **Throttle tileset-update cadence to wall-clock** (`spatiotemporal-layer.ts:390–410`; add `_lastTilesetUpdateWall` floor ≥100ms) | nyc-taxi-paths (primary), other path | Sim-time threshold `timeWindow/20` opens ~every frame at 238×-speed playback → ~60 synchronous `selectAndLoadTiles` passes/sec on the render thread (tilepipe-1). Wall-clock floor makes cadence speed-invariant | S | Low (shader reads live time via `getTime()`, unaffected) | 0.85 |
| **VAT trail: 3-tap → 2-tap forward-difference tangent** (`vat-trips-layer.ts:645–653`) | nyc-taxi-trips | Drops `pPrev`; 6→4 texture fetches/vertex (~33%). Per-side duplication is structural (VS ribbon extrusion) — do not chase it (shader-2) | M | Low (tangent at head needs clamp) | 0.8 |
| **Hoist VAT per-draw uniform object + early-return CategoryColorExtension.draw** (`vat:491–516,799–822`; `category-color-extension.ts:216`) | nyc-taxi-* (VAT alloc), flight-* + nyc-taxi-paths (category dead-draw) | Kills per-sublayer-per-frame object churn; category half is pure waste on 3 of 4 path/trips demos (`useCategoryColor` always false) (cpuframe-1, cpuframe-2). CPU/GC only — not the 42ms frame cause | S | Low (must still write uniform on toggle flip) | 0.6 |
| **Correct stale slot-count comments** (`time-filter-extension.ts:348–352`, `animated-trips-layer.ts:283–292`, `animated-path-layer.ts:167–173`) | all path/trips | All 3 time attrs are always registered; comments claim 2 (attribmem-4, shader-6). Do NOT resurrect mode-aware registration — it was tried and "tanked FPS" (`time-filter-extension.ts:207–222`) | S | None (comments only) | 0.9 |

### Structural (L/XL effort — measure first)

| Action | Affected datasets | Mechanism / expected win | Effort | Risk | Conf |
|---|---|---|---|---|---|
| **Wire i16 tile-relative coords into the producer + consumer** (`projection.rs:88` already implemented, zero non-test callers; `arrow_tile.rs:225–253`) | flight-paths, nyc-taxi-paths, flight-trips, satellites (PathLayer demos) | 16B→4B/vertex; drops PathLayer fp64 hi/lo split (8→4 attr slots), relieves the WebGL2-16 floor, lets **NoPickingPathLayer be retired** + picking re-enabled (attribmem-1, producer-2). ~30–50% compressed archive shrink. **Does NOT help VAT** (fp32 texture already) | XL | Med (Rust encode + decode branch + CARTESIAN/origin plumb; i32 for cross-tile buffer) | 0.85 |
| **Add VRAM-aware eviction + a VRAM probe** (`estimateTileSize` `archive.ts:96–117` counts host bytes only; VAT `positionsTexture` invisible to `maxCacheByteSize` `tileset.ts:262`) | nyc-taxi-trips, nyc-taxi-vat | **No cache budget anywhere counts texture VRAM.** Dense pan can leave dozens of large VAT textures resident → `WEBGL_lose_context` risk on 500K trips (**critique gap #2, unexamined failure mode**). Account texture bytes; add a VRAM line to `page-probe.mjs` (currently JS heap only) | M | Med (accounting + harness) | 0.7 |
| **VAT active-slice instanced draw** (`vat-trips-layer.ts:514,820`; needs producer time-sort) | nyc-taxi-trips, nyc-taxi-vat | Makes `setInstanceCount` track active (~28) not total (~163) trips (sota-1, sota-4). **Caveat:** features are stored in insertion order (`columnar.rs:159–207`), so requires a producer-side per-tile start-time sort; WebGL2 has no `baseInstance`, so option (b) range-draw is unavailable — only CPU-compacted re-upload works, partly defeating reference-stable caching. **Re-bucketing (quick win) achieves most of this for free** | M | Med (rebuild + per-frame re-upload) | 0.6 |
| **Hoist zoom-invariant producer work above the zoom loop** (`tiler.rs:253/317/355`, `clip.rs:619–680`) | all (build-time only) | Project source polyline once, scale by 2^zoom (`clip.rs:153–156`). **Note:** for OSRM nyc-taxi the timestamp pass is a clone, not a recompute (`clip.rs:664–672`) — redundancy is narrower than 7×/11× headline (producer-3). Build wall-clock only, no frame win | L | Low | 0.78 |

**Explicitly NOT recommended:** cross-tile draw-call consolidation
(drawcall-1/-3) — the project already abandoned this approach (3.6GB disaster,
`animated-point-layer.ts` comment); the baseline disproves draw-call submission
as the bottleneck (paused-idle 117fps/8.4ms with identical draw calls vs
playback 22.8fps, `longTaskCount:0` = GPU-bound, not CPU-submission-bound).
cpuframe-4/drawcall-2 texture-reupload storm — deck.gl transfers GPU state on
cache-clear rebuilds (`_transferState`, not `initializeState`), so the feared
re-upload does not occur; **the one real trigger is a summary-tier toggle**
(`activeSummaryToggle` in the DemoPage useMemo deps), which the slider-focused
findings missed (**critique gap #6**) — but no slider exists to fire it during
playback.

## 4. Measurement Plan

Prereq: `pnpm --filter @stt/showcase dev` running; then
`pnpm --filter @stt/perf perf -- <demo> --backend gpu --scenarios playback,zoom,paused-idle [--baseline write|check]`.
Metrics that gate regressions (`report.mjs:109–115`): fps_p50/fps_p5 (higher
better), frame_p95_ms/longTaskCount/longTaskMaxMs (lower better); jank flag at
fps_p5<30 OR frame_p95>33 OR longTaskMaxMs>100.

**Tier 0 — establish ground truth (do FIRST, before any code change).**
- `--baseline write` for **`nyc-taxi-trips`** (the current baseline is pre-VAT
  dead code), **`nyc-taxi-vat`**, **`nyc-taxi-paths`**, **`satellites`**. None
  has ever been measured on its current layer.
- **`nyc-taxi-vat` (head-dot) is the control experiment** (critique gap #4):
  4-vert quad, 1 fetch/vertex, none of shader-2's tangent cost. If head-dot is
  fast and trail is slow on the *identical* 500K archive, the VAT
  vertex-scaling thesis is proven and the remaining trail cost is isolated to
  fetch/fragment. This single comparison answers "is VAT working?" — and it is
  currently never proposed.
- Expected: if VAT closed the gap, `nyc-taxi-trips` should now land far below
  the stale 42.3ms p50. If it plateaus high with low GPU vertex work, the
  residual is fragment/fill, not vertex count.

**Tier 1 — quick wins.**
- After **re-bucketing**: re-baseline `nyc-taxi-trips`/`nyc-taxi-vat`/`nyc-taxi-paths`.
  Expect frame_p50 to fall toward budget on the playback scenario and `.stt`
  bytes/tile to drop ~12× (page-probe records range-request bytes). Watch tile
  *count* rise — confirm the coalescer keeps request count bounded.
- After **rg32float** + **dead-picking strip**: expect heapDelta to fall and
  per-tile texture VRAM to halve. **Caveat (critique gap #7):** `page-probe.mjs`
  has no VRAM probe (JS heap only) — add one (Tier-2 structural) or this win is
  invisible to the harness.
- After **wall-clock throttle**: expect frame_p95 and longTask risk to drop on
  `nyc-taxi-paths` playback specifically (this is the demo where ~60 selection
  passes/sec land on the render thread).

**Tier 2 — structural.** Re-baseline the four PathLayer demos after i16 (expect
~2× position-attribute bandwidth drop + archive shrink). For VRAM eviction, the
new VRAM probe is the validation instrument — there is currently no way to see
the aggregate texture ceiling.

**Harness caveats to respect:** the 6s playback window after 2s warmup
(`scenarios.mjs:52–61`) can *miss* the tile-stream + texture-build burst that
produces the felt hitch — for dense datasets, also inspect the `zoom` scenario
(the only one exercising tile-churn). The harness **cannot meaningfully measure
globe demos** (GlobeView + swiftshader is worst-case unrepresentative; use
`--backend gpu`). Use `tools/bench` (offline, no GPU) to validate the producer
re-bucket's decode-throughput and compression-ratio deltas without a browser.

## 5. Risks & Non-Goals

- **Do NOT go to WebGPU or geometry-shader/transform-feedback rewrites.** Per
  research memory (things-not-to-do) and shader-2's verdict, the per-side ribbon
  duplication is structural to VS extrusion; the win does not justify the
  rewrite at current scale.
- **Do NOT resurrect mode-aware TimeFilterExtension registration**
  (attribmem-4/shader-6 fix option (a)). It was tried, "interacted badly with
  deck.gl 9.3's accessor fallback machinery and tanked FPS on the per-tile
  sublayer demos" (`time-filter-extension.ts:207–222`). Only correct the stale
  comments.
- **Do NOT pursue cross-tile consolidation** (drawcall-1/-3). The baseline
  proves the bottleneck is animation-specific GPU work (5× slowdown only when
  the time uniform advances, `longTaskCount:0`), not draw-call submission. The
  codebase already abandoned consolidation after a 3.6GB disaster.
- **VAT correctness caveats (do not deprecate AnimatedTripsLayer — sota-2):**
  VAT is fp32-only (`world64Low=vec3(0)`, `vat:320`) → ~m jitter at z≥16; VAT
  has **no GlobeView trail support** (the screen-space ribbon extrusion
  `vat:655–668` was authored for flat mercator); and VAT has **no categorical
  color or per-feature width** (sota-3, `vat:26` TODO). Satellites/flights need
  globe + fp64 + have active≈total, so VAT's instance-cull win evaporates there.
  **Keep both renderers; document the selection rule** (VAT for
  dense-short-flat trips, PathLayer-trips for sparse-long-globe paths). No such
  README exists today.
- **`rg32float` trap:** linear hardware filtering on the packed texture would
  bleed across adjacent trips (sota-6) — keep the manual nearest-filter 2-tap
  lerp; the format change to `rg32float` is independent of and compatible with
  that.
- **Uncommitted working-tree footguns to revert before any baseline**
  (`datasets.ts`, untracked `_shot-sats.mjs`): `satellites trailLength 1000→10`
  and `satellite-trips-flat 300000→1000` render a near-zero trail (debugging
  leftovers); `ship-traffic timeWindow 3600000→60000000` (16.7h on a 24h
  dataset) defeats temporal tiling and would collapse FPS via the prefetch math
  the DemoPage comment was written to fix. These are not in the family but will
  corrupt any comparative measurement run from this branch.
- **Non-goal: chasing the 118MB heapDelta as a VAT problem.** It is host heap
  and most likely predates the VAT migration; the real unbounded resource is
  **VRAM**, which nothing in the stack accounts for or caps (critique gap #2).
  Measure VRAM before attributing memory cost to any single texture finding.

---

### Refuted findings (did not survive verification)
- **vbudget-5** — claimed trips/path layers default `capRounded`+`jointRounded`
  to true; the runtime construction path in DemoPage forces them false, so the
  consequence is wrong.
- **producer-4** — claimed the per-vertex `vertex_time` column doubles storage
  with a reachable i64 fallback; the i64 fallback is not span-reachable and the
  u16-delta path is already used.
- **sota-5** — VAT texture cache key only including `timeSlots` is accurate
  descriptively, but the central 134MB worst-case impact claim was mis-sized
  for the actual workload.

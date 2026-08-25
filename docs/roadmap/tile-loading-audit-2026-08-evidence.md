# Tile loading audit (2026-08-24) — evidence appendix

Raw per-subsystem reports from the ten auditors, verbatim, plus the shared brief they were given. The consolidated audit is [tile-loading-audit-2026-08.md](./tile-loading-audit-2026-08.md); finding IDs there (A1…G4) cite the IDs used here (CS-/CE-/PR-/G/NS-/D/SEL-/LC-/F/TO-). Line numbers are as of the 2026-08-24 working tree.

Contents: 0 shared brief · 1 selection & LOD · 2 prefetch & runway · 3 governor coupling · 4 cache & eviction · 5 network & scheduler · 6 decode · 7 layer consumption · 8 cold start & small archives · 9 tests & observability · 10 showcase config

---

# Appendix 0 — brief-common

## Tile-loading audit — common brief (2026-08-24)

Repo: `/Users/robertchristie/Documents/GitHub/spatiotemporal-tiles` (pnpm monorepo, TS + Rust).
You are ONE of ten parallel auditors. **READ-ONLY. Do not edit any file, do not run
`git checkout` / `git stash` / `git reset` (the tree carries large uncommitted work).**
You may run `pnpm --filter @poopdeck.gl/core test -- <file>` style test runs and
node scripts in the scratchpad dir
`/private/tmp/claude-501/-Users-robertchristie-Documents-GitHub-spatiotemporal-tiles/a58aa049-4720-403a-afe7-b3cd0e4c45fc/scratchpad/`
if that helps you PROVE a claim. A dev server is on http://localhost:3000 (showcase,
`/demo/<id>`), and `stt-serve` on :8787 — you may use Playwright from
`tools/render-test/` to measure, but do not spend more than ~10 minutes on browser runs.

## The user's goal (what "good" means)

"Fully optimized for VERY LARGE datasets, functional for SMALLER ones, and the PLAYBACK
experience must be seamless." Judge every finding against those three axes:

- **Large**: local fleet tops out at `nyc-taxi-paths` 3.1 GB / 429k tiles / 60 s buckets /
  z10-14; `gtfs-ch` 2.4 GB / 558k tiles; `drifters` 2.4 GB / 256k tiles / z0-4 (huge coarse
  tiles); `satellites` 1.8 GB / 24k tiles / z0-3 (tiles of ~70 KB avg); `flights` 804 MB /
  43.5M features; `ais-all-us` 498 MB / 560k tiles z0-14; `earthquakes` 23 MB but 350k tiles
  (tiny tiles — per-tile overhead dominates).
- **Small**: `storm4d-reports` 80 tiles, `lines-v2` 492 tiles/0.2 MB, `bixi-flowmap`
  59 tiles, `storm4d-sounding` 4 tiles. Whole archive fits in memory trivially; the
  question is whether the large-dataset machinery adds latency/overhead/complexity
  (debounce, prefetch passes, eviction scans, coverage-index rebuilds, worker pool
  spin-up, gating that can never fail) or breaks (e.g. gates never satisfiable, runway
  math with a single bucket, zoom ranges outside camera zoom).
- **Playback seamless**: no stalls, no flashing/pop, no re-fetch churn, no visible
  LOD swap while playing, clock never runs ahead of data, bounded memory, works at
  high playback speeds (e.g. 157× sim on gtfs-ch, 288× storm-4d) and on slow links.

## Architecture (so you don't have to rediscover it)

- `packages/core/src/spatiotemporal-tileset.ts` (6196 lines) = THE loader. Key
  methods: `update()` :2475 → `selectAndLoadTiles()` :2825 → `processRequestQueue()`
  :3612 → `startTileBatch()` :3881; `prefetchFutureTiles()` :3305 (+ `prefetch-policy.ts`);
  `evictUnusedTiles()` :5233 (4-tier playhead-relative); `getVisibleTiles()` :5592 with
  `coverWithAncestorDp` :5899; runway: `getBufferedRunway` :4429, `getBufferedRanges`
  :4531, `estimateCost` :4577, `maybeRebuildCoverageIndex` :5113; overview preload
  :4840-5095; `cancelSupersededRequests` :4319; retry ladder :4102-4290;
  `setAnimationState` :2006, `setInteractive`(scrub) :2055, `setLoopWindow` :2112.
  Options interface at :956, defaults at :1328-1364 (maxRequests 24, maxCacheSize 2000
  tiles, maxCacheByteSize 2 GiB, prefetchAhead 30000 ms, prefetchSteps 4,
  refinementStrategy 'best-available', lodMode 'parent-fallback', placeholderPolicy
  'expected-value', coverSearch 'dp', temporalTierPolicy 'zoom-threshold'). Constants
  :49-460 (PARENT_FALLBACK_LEVELS 4, CHILD_LOOKAHEAD_LEVELS 2, RUNWAY_HORIZON_REAL_MS
  10 s, MAX_COALESCE_BATCH 1024, DEFAULT_OVERVIEW_BUDGET_BYTES 20 MiB …).
- `packages/core/src/archive.ts` (5886 lines) = `STTArchive`: manifest + directory
  (paged when > SMALL_DIR_THRESHOLD 256 KiB), `getTiles`/`getTileDataBatch` :4205,
  range coalescing (`DEFAULT_RANGE_COALESCE_GAP` 2 MiB, adaptive 256 KiB–4 MiB),
  shared byte cache (500 tiles / 512 MiB, playhead-aware score BH-8), OPFS cache
  (`opfs-cache.ts`), retries/timeouts (transfer timeout 20 s), `getTileIdsInBounds`
  :4797, summary/temporal-LOD id queries, `estimateSelectionCost` :3509,
  `asTileSource` :5333 (the bridge to the tileset).
- `packages/core/src/request-scheduler.ts` + `shared-scheduler.ts`: DRR + EDF shared
  scheduler, 24 slots across all archives; `throughput.ts` dual-EWMA link estimator.
- `packages/core/src/tile-decoder.ts` + `tile-decoder.worker.ts`: worker pool
  (grow/shrink), `tile.ts` (`decodeTile`, `tableToBinaryFeatures`),
  `tile-transferables.ts`.
- `packages/core/src/tile-budget.ts` (viewport cell budget 256 + hysteresis),
  `geo/frustum-cover.ts` (549 lines — check whether it is WIRED into selection or dead),
  `geo/viewport-bounds.ts` (the 2026-07 3D bounds fix).
- `packages/playback/src/playback-governor.ts` (3305 lines): clock↔buffer gate,
  frontier hold, low watermark, degraded creep, multi-source min-gate + fairness +
  run-ahead cap, auto-speed; `time-controller.ts`; `stt-player.ts`.
- `packages/core/src/render/tileset-adapter.ts` (88 lines) bridges tileset → layers
  (`makeTilesetCallbacks`). `packages/layers/src/layers/spatiotemporal-layer.ts`
  (3033 lines) is the deck chassis: `tileset.update()` :1442/:1672,
  `getVisibleTiles()` :1456/:1511/:1685, `setAnimationState` :1119/:1285/:2145,
  `setOptions` :1368. three/maplibre/cesium backends have their own consumers.
- Showcase wiring: `examples/showcase/src/components/demo/buildDemoLayers.ts`
  (`tileLoadingProps` from `src/types.ts:1844` = prefetchAhead max(window, speed×5 s),
  prefetchSteps 4, maxRequests 12; composites split caches 2000/N tiles, 2 GiB/N),
  `DemoViewer.tsx`, `src/datasets.ts` (per-demo config incl. `tileLoadTimeWindow`,
  `headsOverlayTimeWindow`, `overlayGatesPlayback`, `tier`, `zRange`).
- Docs that describe intent: `docs/roadmap/playback-and-loading.md`,
  `docs/roadmap/tile-loading-3d-2026-07.md`, `docs/roadmap/optimization-conformance-2026-08.md`
  (§5-6 open defects), `docs/roadmap/measurements-2026-08.md`, `docs/roadmap/README.md`
  "The backlog". Treat docs as CLAIMS; the code is the truth. Report doc↔code drift.
- Tests: `packages/core/test/*` (prefetch-_, eviction-_, buffered-runway, cost-oracle,
  frustum-cover, tile-budget, request-scheduler, selection-hardening …),
  `packages/playback/test/*`, `packages/layers/test/chassis-*`.
- Telemetry: `packages/core/src/telemetry.ts` channels → `globalThis.__sttProbe`.
  Bench: `tools/bench/src/{cold-start,frame-cost,policy-record,policy-replay,scrub-cost}.mjs`,
  `tools/render-test/probe-*.mjs` (Playwright, `STT_URL=` env).

## Already known — do NOT re-report as new (cite as context only if relevant)

- 3D viewport bounds bug (fixed 2026-07 via `viewport.getBounds()` + `viewport-bounds.ts`);
  `maxPitch` 70 ceiling is deliberate (unproject inverts ≥71.57°).
- Prefetch supersession policy (in-flight prefetch exempt from `cancelSupersededRequests`),
  prefetch slicing (byte-budgeted slices, nearest-first), per-batch dispatch accounting.
- 4-tier playhead-relative eviction + `prefetchPressureScale` ladder; run-ahead fairness;
  `overlayGatesPlayback` default true; per-archive cache split in composites.
- Fine-bucket overlay must not inherit primary `timeWindow` (`headsOverlayTimeWindow`);
  `best-available` double-draw fixed with `no-overlap` on overlays; trip-heads cull by
  `tile.timeRange`; `prefetchAhead` double-counts speed in the shared showcase helper
  (left alone on purpose).
- F5 retry ladder (attempts cap = readiness write-off only; fetch follows exp backoff).
- `blobOrdering: spatial` breaks multi-cell playback (build-side; time-major mandated).
- `metadata.bounds` is a centroid bbox (K11). Axis rebasing measured to LOSE (don't propose).
- luma.gl UBO re-upload bug (patched); `/drive` + earthquakes are draw-call bound
  (cross-tile consolidation is the named fix); temporal culling ruled out there.
- `archive.stats` byte cache shows 0% hit rate under the decoded-tile cache (noted, open).
- Read amplification via `coalesceGapBytes` 2 MiB default not plumbed to layer props (open).
- M2 dictionary-hoist 39× resident-memory regression partially fixed (open: array-identity
  sharing in `tile.ts`, manifest growth to 291 KB).
- Scrub-LOD exists, default OFF, wired in zero showcase call sites (deliberate DT-4 decision
  in measurements-2026-08 §10.7 — read it before proposing scrub changes).
- Uncommitted in-flight change in the tree (DO NOT flag as a bug; assess it): CO-7 —
  `prefetchFutureTiles` now prefetches PRIMARY ZOOM ONLY (parents excluded) except under
  `lodMode:'additive'`; plus worker decode timing split (`decompressMs`/`parseMs`) on the
  `decode` probe.

## What to produce

1. A full report written to the scratchpad file named in your task
   (`audit-<dimension>.md`), in this exact structure:
   - `## Findings` — each finding as:
     `### <ID> [<critical|high|medium|low>] <title>` then fields: **Where** (file:line, several
     if the mechanism spans sites), **Mechanism** (precise, in terms of the actual code — quote
     the decisive lines), **Scenario** (which dataset shape triggers it: large / small /
     playback / all; name a concrete local demo when possible), **Consequence** (what the user
     sees or pays: stalls, flashes, bytes, ms, MB, missed tiles — with numbers when you can
     compute them from constants), **Evidence** (what you did to convince yourself; a
     computation, a test you ran, a grep proving no caller, a probe reading), **Fix** (concrete,
     smallest sound change; note the blast radius and any test that pins current behavior),
     **Confidence** (high/medium/low + why), **How to verify** (a test or measurement that
     would fail today and pass after).
   - `## Checked and correct` — mechanisms you examined that are sound (one line each with
     file:line), so nobody re-audits them.
   - `## Doc ↔ code drift` — claims in docs/comments that the code does not do (or vice versa).
   - `## Needs measurement` — hypotheses you could not settle from code alone, with the exact
     measurement that would settle each.
2. Return as your final message: a compact summary — the finding IDs with severity + one-line
   title each, the count of checked-correct items, and the path of your report file.

Standards: read the actual code paths end-to-end; do not report from comments or docs alone.
Before writing a finding, try to refute it (find the guard you missed, the test that pins it,
the caller that compensates). Prefer fewer, verified findings over many plausible ones. Give
`file:line` for every claim. Distinguish "the code does X" from "I think X". Where a constant
or default is the problem, show the arithmetic for a named local dataset. Do not propose
format/byte-layout changes or thinning of data (project rules: base tier stays lossless;
reductions must be declared tiers). Do not restate the known list above as findings.

---

# Appendix 1 — audit-selection-lod

## Audit — Tile SELECTION and LOD (2026-08-24)

Scope: which tiles `SpatioTemporalTileset` decides it needs for a camera + time, how it
chooses zoom levels, the parent-fallback band, the render-side cover (`getVisibleTiles`),
summary-tier / temporal-LOD dispatch, the viewport cell budget, the frustum-cut path, and
the directory bounds query behind all of it. Read-only; all evidence is from code reads,
the repo's own tests (7 files / 99 tests green at HEAD), a directory-only
`stt-optimize inspect` on `gtfs-ch` and `drifters`, a node measurement against the
live directories on `localhost:3000` (`scratchpad/measure-selection.mjs`), and a
scratchpad vitest run against the TS sources (`scratchpad/selproof/selection.test.ts`,
7/7 pass — each test is a proof of the mechanism it is named for).

All paths below are under `/Users/robertchristie/Documents/GitHub/spatiotemporal-tiles/`.
`tileset.ts` = `packages/core/src/spatiotemporal-tileset.ts`; `chassis` =
`packages/layers/src/layers/spatiotemporal-layer.ts`.

## Measured baseline (used throughout)

Directory-only facts for `gtfs-ch` (557,899 tiles, 2.57 GB, z6-14, 1 h buckets, 35 buckets,
`partition: replicated`, paged directory: 137 pages × 4096 entries):

| zoom | entries | bytes  | avg/tile | max/tile | tiles/bucket | bytes/bucket |
| ---- | ------- | ------ | -------- | -------- | ------------ | ------------ |
| z6   | 180     | 244 MB | 1.35 MB  | 16.1 MB  | 5.1          | 7.0 MB       |
| z7   | 378     | 239 MB | 631 KB   | 5.6 MB   | 10.8         | 6.8 MB       |
| z10  | 8,054   | 252 MB | 31 KB    | 1.17 MB  | 230          | 7.2 MB       |
| z12  | 56,336  | 290 MB | 5.1 KB   | 254 KB   | 1,610        | 8.3 MB       |
| z13  | 138,849 | 341 MB | 2.5 KB   | 138 KB   | 3,967        | 9.7 MB       |
| z14  | 328,453 | 450 MB | 1.4 KB   | 70 KB    | 9,384        | 12.9 MB      |

Every zoom level carries roughly the SAME bytes per bucket (full duplication); the coarse
levels are not cheap placeholders in this archive, they are ~1 MB tiles.

Box-path selection at the shipped cameras (1440×900, chassis derivation replicated:
`viewport.getBounds({z})` for the `zRange` slab → `boundsFromCorners` → `normalizeViewportBounds`
→ `floor(zoom)` → archive clamp → `fitZoomToCellBudget`):

| camera                                          | primary                     | cells                              | tiles / bytes per pass (20 s window, mid-bucket)           | parent band                                     |
| ----------------------------------------------- | --------------------------- | ---------------------------------- | ---------------------------------------------------------- | ----------------------------------------------- |
| gtfs-ch shipped z7.6 p52 b-10, zRange 0-7000    | z7 (budget inert: 12 cells) | z7:12 z6:6                         | z7: 8 tiles / 15.0 MB (max 5.5 MB)                         | z6: 4 tiles / 16.1 MB (max 16.1 MB)             |
| same, window straddling a bucket edge           |                             |                                    | z7: 16 tiles / 28.5 MB                                     | z6: 8 / 30.4 MB                                 |
| gtfs-ch Zürich z14.3 p52 b-10                   | z14 (117 cells)             | z13:35 z12:12 z11:6 z10:2          | z14: 105 tiles / 1.02 MB                                   | z13-z10: 55 tiles / 5.5 MB (5.4× the primaries) |
| gtfs-ch Zürich z14.3 flat                       | z14 (9 cells)               |                                    | z14: 9 / 0.32 MB                                           | 8 tiles / 2.5 MB (7.9×)                         |
| drifters globe z1.5 (`useGlobalBounds`)         | z1                          | z1:4 z0:1                          | z1: 116 tiles / 4.96 MB (29 buckets in the 200-day window) | z0: 29 / 4.83 MB                                |
| storm4d-sounding z9 p60 (archive z3-6)          | clamped to z6               | 4                                  | z6: 1 tile / 0.10 MB                                       | (overlay runs `no-overlap`)                     |
| nyc-taxi-paths world camera z2 (archive z10-14) | clamped to z10              | 325,171 (> `MAX_QUERY_SCAN_CELLS`) | occupied-index path, 1 warn, 8 tiles / 0.29 MB, 45 ms      | —                                               |

Warm directory scan cost: 0.05–0.33 ms per selection pass (2–5 zoom scans). Cold (first
touch after a pan) 25–80 ms per zoom = paged-directory leaf faults, and the parent band
faults leaves at 4 extra zooms.

---

## Findings

### SEL-1 [high] The expected-value placeholder rule buys parents that arrive AFTER the children they stand in for, and they ride the same priority batch as those children

**Where**

- `tileset.ts:2720-2796` `placeholderWorthFetching`: decisive lines
  `:2778 if (this.tiles.get(tileKey(childId))?.isLoaded) continue;` (in-flight children count as
  missing), `:2793 const avertedValueMs = this.options.placeholderValueLambda * visibleCells * coverMs;`,
  `:2795 return arrivalMs < avertedValueMs;`
- `tileset.ts:2685` `shouldSkipParentFetch` (the gate), `:216` `DEFAULT_PLACEHOLDER_VALUE_LAMBDA = 1/16`,
  `:234` `PLACEHOLDER_COVER_HORIZON_MS`.
- `tileset.ts:3137/3140, 3182/3184` primaries `unshift`, parents `push` onto the ONE priority
  queue; `:3688 this.startTileBatch(candidates)` drains up to `MAX_COALESCE_BATCH` (1024, `:59`)
  into ONE coalesced batch.
- `tileset.ts:3351` CO-7 `prefetchZoomLevels = [primaryZoom]` — parents are never pre-warmed, so
  every bucket edge re-runs this rule with the new bucket's children not yet loaded.

**Mechanism** The rule fetches parent `u` iff `bytes(u)/θ < λ·A(u)·min(C_missing/θ, 10 s)`,
i.e. iff `P < A·C_missing/16` (θ cancels below the horizon). `A` is the count of visible primary
cells under `u`, `C_missing` their byte sum. Two consequences that fall straight out of the
arithmetic:

1. For `A > 16` the rule admits `P > C_missing`: a parent whose download takes LONGER than all of
   the children it is placeholding. A placeholder that lands after the detail is worth zero
   (pass 2 of `getVisibleTiles` drops it on arrival), but it has already spent link time.
2. In a full-duplication archive `P ≈ (4^d/A)·C_missing·s` (d = levels up, s ≤ 1
   simplification), so the rule reduces to `A² > 16·4^d·s`: a 1-level parent (A ≤ 4) or a
   2-level parent (A ≤ 16) is NEVER bought; 3- and 4-level ancestors are bought exactly when
   they cover > ¼ of their block — i.e. when they are largest. The rule is biased toward the
   most expensive placeholder and against the cheap near ones.

Because parents are pushed to the same priority queue and drained into the same coalesced
batch, the admitted parent's ranges compete with the children's for the 12 (`maxRequests`)
connections; it does not wait for them.

**Scenario** Large / playback. Any `best-available` demo at city zooms where the primary
tiles for a bucket are not yet resident when selection runs: every bucket edge where the
prefetch runway is behind (bandwidth-bound routes; `gtfs-ch` at 157× spends 23 real seconds
per 1 h bucket and needs ~15 MB/bucket at z7 nationwide, ~1 MB + parents at z14), seeks,
and the first frames after a pan. At the shipped national camera the rule correctly skips
(z6 tiles are 16 MB); it bites at z11–z14.

**Consequence** Measured on the Zürich z14 pitched camera shape (105 primaries / 1.02 MB;
parents z13 28 KB, z12 98 KB, z11 272 KB, z10 850 KB; warm 4 MB/s link; children in flight):
the EV rule enqueued z10×1 (850 KB) + z11×2 (544 KB) + z12×4 (392 KB) = **1.79 MB of parents
against 1.0 MB of primaries** and skipped all 25 z13s. The z10 tile takes 212 ms to download
against 92 ms for its 37 missing children — it lands after them and is dropped unseen. On a
slower link the ratio is the same (θ cancels). The flat rule on the same inputs enqueues all
40 parents / 4.37 MB, so EV is an improvement on cold-start bytes but still spends 1.8× the
primary bytes on tiles that cannot be drawn, at exactly the moment (runway behind) when
bandwidth is the binding constraint for "clock never runs ahead of data".

**Evidence** `scratchpad/selproof/selection.test.ts` "Q3 … policy=expected-value" prints
`{"10":{"n":1,"bytes":850000},"11":{"n":2,"bytes":544000},"12":{"n":4,"bytes":392000},"14":{"n":100,…}}`;
`policy=flat` prints all four parent levels. Repo pins (`packages/core/test/prefetch-runway.test.ts:891-938`)
cover a parent FASTER than its children (4 MB parent / 16 MB children → 200 ms < 800 ms), a
slow link, and a cheap parent with near-resident children — none covers a parent slower than
its own child set.

**Fix** Add the missing precondition: a placeholder is only worth fetching if it lands
before the detail it covers — `if (arrivalMs >= coverMs) return false;` ahead of the λ·A
weighting in `placeholderWorthFetching` (`coverMs` uncapped for this comparison). All three
pinned EV cases keep their verdicts (200 < 800 fetch; 40 s vs 10 s skip; 50 ms vs 0.8 ms skip).
Optionally also cap the total parent bytes admitted per pass to a fraction of the primary
bytes (nearest level first). Blast radius: `prefetch-runway.test.ts` EV block only.

**Confidence** high — arithmetic + executed proof; the "same batch" claim is from
`processRequestQueue` structure (whether the archive starts parent range-groups concurrently
with primary groups is the fetch auditor's to confirm — see Needs measurement).

**How to verify** Add the Q3 scratchpad case to `prefetch-runway.test.ts` asserting z10/z11 are
NOT enqueued when `arrivalMs > coverMs`; fails today, passes after. Runtime: on `/demo/gtfs-ch`
zoomed to Zürich at 157× with the link throttled to ~4 MB/s, the `batches` probe's
priority-tier entries should carry zero z≤z11 ids at bucket edges after the fix.

---

### SEL-2 [high] `best-available` pass 2 keeps a parent forever over its loaded children when any in-box primary cell has NO tile in the archive — the core double-draw was not fixed, only the flow-riders demo config was

**Where** `tileset.ts:5745-5770` (pass 2 of `getVisibleTiles`):

```
if (primaryCover.has(cell)) continue;                       // :5753
if ((inRowBand && cx >= vpMinX && cx <= vpMaxX) || primaryPending.has(cell)) { needed = true; }  // :5760-5762
```

An in-box cell counts as "uncovered" whether or not the directory has a tile there; the
directory's answer (`neededTileKeys`) is only consulted for the slack ring. The comment at
`:5755` says so explicitly ("including a cell the archive has no tile for at all") and
justifies it by the `--min-features-per-tile` sparse-archive contract.

**Mechanism** For a replicated (full-duplication) archive an empty primary cell means the
parent has no features there either, so keeping the parent for that cell covers nothing —
but the parent is then drawn ON TOP of its loaded siblings' children for as long as the
viewport is unchanged. The viewport clamp added in 2026-07 fixed the "children outside the
box" case only; the in-box-empty case is untouched.

**Scenario** All / large. Every `best-available` demo whose primary coverage has holes inside
the frame: water (`nyc-*`, `ais-all-us` coasts), rural/Alpine cells at night
(`gtfs-ch` z12–14: 9,384 z14 tiles/bucket at rush hour over ~10.5k Swiss z14 cells; far fewer
at 03:00), sparse point sets (`earthquakes`, `wildfires`). The parent is also pinned in
`neededTileKeys` (never evictable) while it is kept.

**Consequence** The whole parent block is rendered twice (translucent layers show doubled
density, trip heads double dots, draw calls double) — the exact symptom the flow-riders
campaign measured at z10/z11 and worked around with `refinementStrategy: 'no-overlap'` on
overlays (`buildDemoLayers.ts:990,1735,1887`). Every other `best-available` route (the
default for the primary layer, `chassis:702`) still carries it.

**Evidence** `scratchpad/selproof/selection.test.ts` "Q4": archive has 3 of 4 z11 children +
the z10 parent; all four load; `getVisibleTiles` delivers `10/512/511` alongside the three
children. The repo pin `parent-fallback-clamp.test.ts:127-190` ("never delivers a parent
alongside its own loaded children") only exercises the 4-of-4 case, so this is unpinned.

**Fix** Treat an in-box cell as uncovered only if the directory says a tile exists there
and it is not loaded (`primaryPending.has(cell)`), and keep the "any in-box cell" rule only
when the archive declares a sparse partition (`metadata.partition === 'home-zoom'` /
`ArchivePartition`, `packages/core/src/types.ts`, or a min-features > 1 capability). Blast
radius: `parent-fallback-clamp.test.ts` (all cases use pending cells — pass), the sparse
contract (preserved by the gate). Pin with the Q4 case.

**Confidence** high (executed proof; code path unambiguous).

**How to verify** The Q4 case fails today (`expect(ids).not.toContain(parent)`) and passes
after. Runtime: on `/demo/gtfs-ch` at z13 over Lake Geneva at night, count delivered tiles
with z < primary whose block has zero pending cells (a one-line probe counter in pass 2).

---

### SEL-3 [medium] `tier: 'auto'` under `best-available` hands raw sublayers SUMMARY-variant tiles as parent fallbacks (centroid points with count columns) for four zooms above the summary range; no hysteresis at the tier edge

**Where** `tileset.ts:1952` `pickTierForZoom` is per-zoom; `:3037` dispatches each parent
level independently (`zoomLevels.map(z => fetchSelectionTilesForZoom(bounds, z, …))`); the
summary ids carry `variantId: tier.variantId` so they key separately (`tile-key.ts`). Summary
tiles carry cell-centroid Point geometry (`crates/stt-build/src/summary.rs:360`) and raw
point sublayers iterate `tile.layers` with no variant filter
(`packages/layers/src/layers/core/animated-point-layer.ts:1500,1527`). Only the dedicated
summary layers force `tier: 'summary'` + `no-overlap` (`h3-summary-layer.ts:645-655`,
`quadbin-summary-layer.ts:669`).

**Mechanism** At camera zoom `summary.maxZoom + 1 … + 4` the primary is raw and every parent
level lies inside the summary range, so the fallback band is the aggregated tier: H3/Quadbin
cell centroids with `count`/`bucket_i` columns are delivered to the raw layer as if they
were features, drawn until every in-box raw cell is covered — and under SEL-2, forever where
a raw cell is empty. The tier boundary itself has no hysteresis (`chassis:2707 floor(zoom)`),
so a camera hovering on `maxZoom + 1` flips primary tier each throttled pass (each flip is a
`zoom !== lastSpatialZoom` spatial flush + needed-set change → renderer re-consolidation).
The flip does NOT refetch the other tier wholesale: the parent band already holds the summary
tiles (verified), so the cost is the flush + the mixed delivery, not bytes.

**Scenario** Small / medium archives with a summary tier rendered by a raw layer:
`goes-glm-lightning` (summary z0-4, raw z0-7, `AnimatedPointLayer`, shipped camera z4 = pure
summary; any zoom to 5–8 gets summary parents), the storm-4d lightning overlays, and any
user archive built with `--summary-tier`. `osm-nyc-nodes` pins `tier: 'raw'`
(`datasets.ts:5013`) precisely because the hexbin overlay "obscures" the raw story.

**Consequence** Aggregated cells rendered with raw styling (a count cell as a lightning
flash), doubled with the raw points once they land, and persisting under SEL-2.

**Evidence** `scratchpad/selproof/selection.test.ts` "Q5": at zoom 5 the needed set is
`['5/1/1/0#0','4/1/1/0#7','3/1/1/0#7','2/1/1/0#7','1/1/1/0#7']`; at zoom 4 it is all `#7`.
`summary-tier-dispatch.test.ts` (4 tests) pins the primary dispatch only.

**Fix** In `selectAndLoadTiles`, keep only parent levels whose tier equals the primary's
tier (`pickTierForZoom(z) === pickTierForZoom(primaryZoom)`), or run summary-tier parents
as `no-overlap`. Add a one-zoom hysteresis to the tier edge in `pickTierForZoom` (or reuse
the budget's `previousZoom` idea) if flapping is observed. Blast radius: none of the 4
dispatch tests cover parents.

**Confidence** high on mechanism; medium on visual severity (not viewed in-browser).

**How to verify** Assert in `summary-tier-dispatch.test.ts` that at `summaryMax + 1` no
`#<summaryVariant>` key enters `neededTileKeys`; fails today.

---

### SEL-4 [medium] The maplibre backend runs a full selection pass at display refresh during playback; its comment relies on a fast path that cannot fire while time advances

**Where** `packages/maplibre/src/base-layer.ts:1370-1392` builds
`{ zoom: floor(map.getZoom()), time: this.opts.currentTime, … }` every frame and says
(`:1385`) "the core tileset short-circuits identical-param selections via lastSelectKey".
`tileset.ts:2838` `timeRange = { start: time - w/2, end: time + w/2 }` and `:2906-2910` fold
the exact range into `selectKey`. The deck chassis, by contrast, throttles the tick path to
≤10 Hz AND ≥ timeWindow/20 of sim travel (`chassis:1416,1421`) and the viewport path to
100 ms (`chassis:1594-1625`, pinned by `packages/layers/test/viewport-throttle.test.ts`).
`packages/three/src/scene/streaming-tile-source.ts:393` is likewise unthrottled (cadence is
the caller's).

**Mechanism** Every `update()` with a new `time` misses the fast path and runs: 5 awaited
directory scans (each walking the 137-entry page table in `ensurePagesForBounds`,
`archive.ts:3235-3268`), `priorityKeys`/`prefetchKeys` Set rebuilds over both queues,
`neededTileKeys` rebuild + `setsEqual`, `cancelSupersededRequests`'s per-header sweep
(`tileset.ts:4319-4370`), `evictUnusedTiles`'s grace sweep over every header
(`:5233-5290`), `processRequestQueue`. The comment at `tileset.ts:2860` ("a TimeController
tick that hasn't crossed a bucket boundary … is the common case") is not true of the key as
written — only an IDENTICAL time hits it.

**Scenario** Playback on maplibre-backed routes (and any three consumer that pumps per frame).

**Consequence** Measured 3.5 ms per pass with 2,356 resident headers (scratchpad "Q7 cost";
5 fake scans, eviction sweep, queues) → ~210 ms/s at 60 Hz per layer, multiplied by sibling
layers in per-layer mode. On deck this is bounded to ≤35 ms/s by the 10 Hz throttle.

**Evidence** scratchpad "Q7 scans": 20 updates with advancing time → 100 directory scans
(5 per update); 20 identical updates → 5. `grep` shows no throttle in the maplibre call site.

**Fix** Smallest: in `base-layer.ts` quantize `time` to the deck chassis's rule (skip
`tileset.update` unless `|Δt| > timeWindow/20` and ≥100 ms wall) — mirrors
`_handleTimeUpdate`. Core-level alternative (bigger blast radius): key the fast path on the
bucket indices of `timeRange.start/end` rather than the raw values; note `coverTMin`
filtering (`archive.ts:4830`) means a tile can enter the needed set mid-bucket, so a
bucket-keyed key must still re-run when the window's edges move by more than the smallest
`coverTMin` granularity — the chassis throttle is the safer place.

**Confidence** high on mechanism; medium on user impact (no maplibre route measured).

**How to verify** A maplibre test driving 60 `beginFrame`s with advancing `currentTime` and
counting `getAvailableTiles` calls (300 today; ≤ 50 after).

---

### SEL-5 [medium] Frustum selection (FS-1/FS-2) is built and wired but off everywhere; FS-3 is not implemented; the conformance doc reports FS-1…FS-3 as 3/3 while six tests carry `it.fails('PENDING FS-3 REPAIR')`

**Where**

- `packages/core/src/geo/frustum-cover.ts` (549 lines) — exported via `core/src/index.ts:68-76`;
  1,062-line oracle test (`frustum-cover.test.ts`, 432 cameras) passes.
- Wired ONLY into the deck chassis behind `selectionMode` (`chassis:526`, default `'aabb'`
  `:720`, gate `:2507`, cut built `:2579`, cells slice wired `:2070-2077`). No showcase call
  site sets `selectionMode` (grep over `examples/showcase/src`: none).
  `makeTilesetCallbacks` (`core/src/render/tileset-adapter.ts`) does NOT wire
  `getAvailableTilesForCells`, so three/maplibre/cesium cannot take the cut path even if
  they built one (`tileset.ts:2835 hasCut = tileCells !== null && cellSlice !== null`).
- FS-3 (render-side mixed-zoom cover) is pending: `mixed-zoom-cover.test.ts:600,668,676`
  and `parent-fallback-clamp.test.ts:308,338` are `it.fails`; companion tests RECORD the
  defect's size ("142 of 432 cameras drop a loaded cut member, worst 14"; "worst 985
  ancestor/descendant pairs, 2.0× overdraw"; both shipped pitched cameras double-cover).
- Docs: `docs/roadmap/optimization-conformance-2026-08.md:28` "§8 frustum selection FS-1 … FS-3
  **3 / 3**"; `docs/roadmap/tile-loading-3d-2026-07.md:290,347` "Wave 3 has not [landed] …
  NOT built" (stale the other way — FS-1/FS-2 landed 2026-08-11).

**Consequence** Not a runtime bug — nothing ships on the cut path. What ships is the AABB +
256-cell budget. Note also the budget is inert on every showcase camera: it engages only
above ~pitch 75 (`tile-budget.ts:80-89`, "the four `maxPitch: 85` volumetric demos") and no
`datasets.ts` entry declares `maxPitch` above 70 any more (grep: none). Measured: 12 cells
at the gtfs-ch shipped camera, 117 at Zürich z14 p52, both under 256.

**Fix** Either finish FS-3 (key pass 2 on the cut's per-cell zoom so a cut member is never
judged as a "parent", and drop `cutAncestors` stand-ins over cut members) or record the cut
path as experimental and stop counting FS-3 as done. Wire `getAvailableTilesForCells` in
`makeTilesetCallbacks` if the other backends are ever meant to use it.

**Confidence** high.

**How to verify** Remove the `.fails` on the six pending tests; they must pass.

---

### SEL-6 [low] Every selection pass enumerates all four parent levels even when every parent is then skipped, and the paged directory faults leaves for five zooms on each pan

**Where** `tileset.ts:2614-2652` `getZoomLevelsToLoad` always returns `[z, z-1 … z-4]` under
`best-available`; `:3037` queries all of them in parallel BEFORE the placeholder rule runs
(`:3103` onwards); `archive.ts:3235-3268` `ensurePagesForBounds` runs per zoom and walks the
whole page table (137 entries for gtfs-ch) each time.

**Mechanism / consequence** At the shipped gtfs-ch camera the z6 parents (16 MB tiles) are
always skipped, yet the z6 scan runs every pass, and after each pan the z6..z10 leaves are
faulted in addition to the primary's (cold 25–80 ms per zoom measured on first touch; warm
0.05–0.2 ms). During steady playback with a healthy runway every primary is already
resident, so the parent enumeration is pure overhead: 4 of the 5 scans per pass.

**Fix** Enumerate parents lazily: after the primary scan, skip parent levels when every
primary is `isLoaded` (steady state), and stop walking coarser levels once a level's
candidates are all skipped by the placeholder rule. Blast radius: `selection-hardening`
FS-2 tests count scans per zoom (`:458`), adjust expectations.

**Confidence** medium (cost is small warm; the cold page-fault half is the directory
auditor's to weigh).

---

### SEL-7 [low] Cold start (throughput estimator empty) falls back to the flat 2 MiB rule, which buys the ENTIRE parent band for full-duplication archives — 4.4× the primary bytes at Zürich z14, ≈1× at the drifters globe

**Where** `tileset.ts:2685-2696` (`worth === null` → `isOversizedParent`), `:190`
`DEFAULT_MAX_PARENT_TILE_BYTES = 2 MiB`; `placeholderWorthFetching` abstains while
`bytesPerMs === null` (`:2731-2734`).

**Consequence** First paint of Zürich z14 requests 1.0 MB of primaries + 4.37 MB of parents
(40 tiles, all < 2 MiB) in one batch; drifters at z1 requests 4.96 MB of primaries + 4.83 MB
of z0 parents (29 buckets × 206 KB). Whether that helps or hurts first paint depends on
range-group ordering inside the batch (Needs measurement); the doc's premise
(`tile-loading-3d §4.4`: "2 MiB default against a ~42 KB average tile") does not hold for
this fleet (gtfs-ch z6/z7 average 1.35 MB / 631 KB).

**Fix** Only after measurement: cap cold-start parent bytes per pass (e.g. ≤ primary bytes,
nearest level first), or seed the throughput estimator from the manifest fetch so the EV
rule is live on the first selection.

**Confidence** medium.

---

## Answers to the eight questions (condensed)

1. **Tile count scaling (gtfs-ch).** Shipped camera: 8 z7 tiles/bucket (15 MB) + 4 z6
   parents (16 MB, skipped by both rules). Straddling a bucket edge: 16 + 8. Zürich z14
   pitched: 105 primaries + 55 parents = 160 ids/pass, 0.18 ms warm. Per-tile fixed cost
   (Map/Set/key strings/sort) is NOT the binding thing anywhere measured (3.5 ms/pass only
   with 2.3k headers + queues); at z7 the binding quantity is bytes (1.9 MB avg z7 tile,
   5.5 MB max), at z14 it is directory page faults on pan and the parent band's bytes.
2. **Zoom choice.** `chassis:2707 floor(viewport.zoom)` → clamp to `[minZoom,maxZoom]`
   (`:2716`) → `fitZoomToCellBudget` (`:2729`) → `getZoomLevelsToLoad` clamps again
   (`tileset.ts:2618`). `storm4d-sounding` at camera z9 → z6, 1 tile — correct (measured).
   `nyc-taxi-paths` at a world camera → z10, 325k-cell grid → occupied-index path, one
   `console.warn`, 8 tiles — correct. `drifters` at z1.5: 145 ids / 9.8 MB per pass; selection
   knows per-tile bytes (`getTileByteSize` wired) but has NO byte gate for primaries — it
   always loads what it draws; only parents are priced.
3. **Parent fallback with CO-7.** The priority path still ENUMERATES 4 ancestor levels every
   pass (SEL-6). On a bucket edge with the runway healthy (children `isLoaded`),
   `missingChildBytes = 0` → `coverMs = 0` → every parent skipped, zero parent fetch. With the
   runway behind (children in flight in a prefetch slice, `isLoading`), parents are re-priced
   with in-flight children counted as missing → SEL-1: 3-/4-level ancestors are bought,
   pushed to the back of the priority queue, batched with whatever primaries are not yet in
   flight, and compete with the prefetch slice carrying the children. They are dropped by
   pass 2 as soon as the children land — fetched, not drawn.
4. **`best-available` double draw.** Core is only fixed for the "children outside the box"
   case; the in-box-empty case still double-draws (SEL-2). `no-overlap` returns exactly one
   zoom (`getZoomLevelsToLoad:2624`) and pass 3 stand-ins cannot overlap (verified by the
   repo's DP tests), so the demo config fix is sound — it just means every default
   `best-available` layer still carries the defect.
5. **Summary tier.** Switch zoom = integer `floor(zoom)` vs `summaryZoomRange` — sound for
   the primary, no hysteresis, no wholesale refetch on the flip, but summary tiles serve as
   raw parents for 4 zooms (SEL-3).
6. **Temporal LOD.** No archive in `examples/showcase/public/data/*/manifest.json` declares
   `temporalLod` (65 manifests checked, all `None`); `temporalTierPolicy` is only consulted
   inside `scrubTemporalLodBucketMs` (`tileset.ts:2192-2226`), gated on
   `isInteractive && scrubLod.temporal`; the chassis wires the cost oracles only when
   `temporalLodLevels` exist (`chassis:2005-2040`). So the temporal axis and `cost-argmin`
   are unreachable in the fleet; `flights` at z4 during playback gets base 1 h tiles at z4
   plus the z3..z0 parent band on the priority path (the 67 % ancestor-bytes measurement in
   the CO-7 comment) — checked, not a defect.
7. **Cadence.** Deck: tick path ≤10 Hz and ≥timeWindow/20 (`_handleTimeUpdate`), viewport
   path 100 ms, prop changes immediate; every throttled pass is a FULL selection (fast path
   only for identical time). `debounceTime` 0 → `update()` selects synchronously. maplibre:
   per frame (SEL-4). Per-pass cost ~3.5 ms at 2.3k headers; directory scans 0.05–0.3 ms warm.
8. **frustum-cover / A1.** Built, tested, exported, wired into deck behind a default-off prop,
   enabled nowhere, incomplete on the render side (FS-3 pending) — effectively dead in
   production (SEL-5).

## Tests: what is pinned, what is vacuous

- `parent-fallback-clamp.test.ts` — pins slack ring, empty-intersection keep, 4-of-4
  double-draw under dp/capped. Does NOT pin the in-box-empty case (SEL-2). `:308,338` are
  `it.fails` (FS-3 pending) and `:329,370` record the pending defect's shape.
- `mixed-zoom-cover.test.ts` — clause 1 (zero blank samples at 432 cameras) is real; clause
  1b/2 acceptance is `it.fails` ×4; the "records HOW BAD" tests assert bands (≤200 cameras,
  ≤1200 pairs, ≤2.5× overdraw) and would pass if the defect grew to those bands. The O5
  "≥10× at pitch ≥70" tests measure a path nothing ships.
- `selection-hardening.test.ts` — sound: generation guard, failure surfacing, FS-2 flag-off
  regression pin, cut flush signature.
- `zoom-out-child-standin.test.ts`, `ancestor-standin-overlap.test.ts` — sound property
  tests over the DP cover (antichain, ≥ capped greedy, determinism); depth-2 descendant cap
  pinned.
- `tile-budget.test.ts` — sound, but the module is inert on every showcase camera (no
  pitch > 70).
- `frustum-cover.test.ts` — sound oracle for an unused primitive.
- `summary-tier-dispatch.test.ts` — primary dispatch only (4 tests); parents and renderer
  consumption unpinned (SEL-3).
- `prefetch-runway.test.ts:835-938` — EV rule: parent-faster-than-children, slow link, cheap
  parent; the parent-slower-than-children case is unpinned (SEL-1).
- `viewport-throttle.test.ts` — pins the viewport-only throttle; the tick-path throttle
  (`_handleTimeUpdate` 100 ms / window÷20) has no dedicated test (`chassis-lifecycle.test.ts:649`
  calls it once).

## Checked and correct

- `getZoomLevelsToLoad` clamp into `[minZoom, maxZoom]` and parent band bounded by `minZoom` — `tileset.ts:2614-2652` (measured storm4d-sounding z9→z6, nyc-taxi z2→z10).
- `MAX_QUERY_SCAN_CELLS` = warn-once-per-zoom + occupied-index, never truncates — `archive.ts:790, 4715-4770` (measured 325k-cell grid → 8 tiles, 45 ms).
- `update()` rejects a non-finite box and keeps the previous viewport; repairs via `normalizeViewportBounds` — `tileset.ts:2487-2503`, `geo/viewport-bounds.ts` (known 2026-07 fix, pinned).
- Selection generation guard drops a stale late-resolving pass — `tileset.ts:2965-3020`; directory failure clears `lastSelectKey` and surfaces the `{x:-1,y:-1}` sentinel — `:3010-3030`.
- Spatial flush tolerance ⅛ viewport, seam-aware span/centre — `:177, 2917-2960`; coverage-index rebuild keyed by `quantizedSpatialKey` — `:2811, 5113-5130`.
- Promote-from-prefetch is O(N+Q) with batched filter — `:3020-3110, 3193-3199`; `priorityQueueDirty` gates the O(Q log Q) sort — `:3739-3765`.
- `getVisibleTiles`: primary from needed (not loaded) so pass 3 works mid-flight — `:5612-5625`; slack ring qualified by `primaryPending` — `:5690-5700, 5760-5762`; empty-intersection fail-open — `:5670-5675`; descendants-before-ancestors and `emitted` de-dup — `:5790-5850`; `coverWithAncestorDp` level-major single cover with `blocked` propagation — `:5899-5985`; base-tier-only stand-ins (no `bucketMs` in synthesized ids).
- `tile-budget.ts`: descent judged on the plain cap, hysteresis on release only, `minZoom` floor, NaN → keep requested — `:180-295`; `viewportCellCount` shares `tileXSpanForLonRange`/`latToTileY` with the archive scan — `:157-178`.
- `getZoomLevel` floor + clamp + budget with `previousZoom` memory; `zoomOverride`/`useGlobalBounds` bypass — `chassis:2699-2742`.
- Deck tick cadence ≤10 Hz / ≥window÷20 — `chassis:1403-1430`; viewport-only 100 ms throttle with trailing settle — `:1594-1625, 1760-1774`.
- `pickTierForZoom` policy and the H3/Quadbin layers forcing `tier: 'summary'` + `no-overlap` + tier zoom band — `tileset.ts:1952-1964`, `h3-summary-layer.ts:645-663`.
- Scrub/temporal-LOD gates: inert without `scrubLod`; `cost-argmin` abstains on `unknownTiles > 0` and unwired oracles — `tileset.ts:2161-2294`; selection-only (coverage index and prefetch use the undegraded zoom — `:5119, 3315`).
- CO-7 prefetch primary-only with `shouldSkipParentFetch` retained — `:3315-3352, 3446` (consistent with the priority path still walking parents).
- Frustum cut normalization/antichain/zoom-drop/ancestor helpers fail open to the box path — `tileset.ts:606-760`; cut path requires both the cut and the cells slice — `:2835`.
- `tileKey` folds `variantId` and `bucketMs` so tiers never alias — `packages/core/src/tile-key.ts`.
- `cancelSupersededRequests` batch-wise judgment with prefetch exemption — `:4319-4370` (known).

## Doc ↔ code drift

1. `optimization-conformance-2026-08.md:28` "§8 frustum selection FS-1 … FS-3 **3/3**" vs six `it.fails('PENDING FS-3 REPAIR')` tests; `tile-loading-3d-2026-07.md:290,347` "Wave 3 … NOT built" vs FS-1/FS-2 landed 2026-08-11. Both stale, in opposite directions.
2. `archive.ts:771` "the tileset's selection key folds in the time range — so during playback it re-runs at display refresh, not at 10 Hz" — true for maplibre, false for deck (throttled to ≤10 Hz at `chassis:1416-1421`).
3. `tileset.ts:2857-2862` "Running on a TimeController tick that hasn't crossed a bucket boundary, this is the common case" — the key folds the exact `timeRange`; only an identical time hits the fast path (proved: 100 scans / 20 advancing updates).
4. `tileset.ts:253` "Higher numbers don't add load pressure (each lower zoom has 4× fewer cells)" — bytes per bucket are ~flat across zooms in a replicated archive (gtfs-ch z6 7.0 MB … z14 12.9 MB per bucket); the parent band is 5.4× the primary bytes at Zürich z14.
5. `tileset.ts:5561` "the inner cover-check is 4^(maxZoomDiff) which in practice is 16 (zDiff ≤ 2)" — band is 4 levels (`COVER_DP_ANCESTOR_LEVELS = PARENT_FALLBACK_LEVELS`, `:420`).
6. `tile-budget.ts:88` "engages where the audit measured the blow-up: the four `maxPitch: 85` volumetric demos" — no demo declares `maxPitch` > 70; the budget is inert on the shipped fleet.
7. `tile-loading-3d-2026-07.md §4.4` "`maxParentTileBytes` (2 MiB default against a ~42 KB average tile) already bounds the parent-fallback downside" — default policy is now `expected-value` (`tileset.ts:1349`), and fleet parents average 631 KB–1.35 MB at z7/z6 (gtfs-ch), 206 KB at drifters z0.
8. `maplibre/base-layer.ts:1385` "the core tileset short-circuits identical-param selections via lastSelectKey" — not during playback (SEL-4).
9. `tileset.ts:216-225` λ fit note "a 300 KB z13 parent under a z14 view is fetched" — under the rule as written a 1-level parent is fetched only when `P < C_missing/4`, i.e. its four children must total > 1.2 MB; the comment's example is not reproducible from the rule without its unstated child sizes.

## Needs measurement

- **Batch-internal ordering:** within one coalesced priority batch (`startTileBatch`), do parent-zoom range groups start concurrently with primary groups under `maxConcurrentRequests = 12`, or after them? Settles how much of SEL-1's 1.79 MB delays the children. Measure with the `batches` probe + per-range-group start times on `/demo/gtfs-ch` Zürich at 157× on a 4 MB/s throttle.
- **Parent bytes never drawn per session:** add a counter to pass 2 for parents dropped on the SAME frame their last child landed; run the fleet's `best-available` routes at speed. Quantifies SEL-1 + SEL-7 in bytes.
- **Double-draw prevalence (SEL-2):** count pass-2-kept parents whose block has zero `primaryPending` cells, per demo, at the shipped cameras and at z12–14; expect non-zero on `gtfs-ch` night hours and every coastal demo.
- **Cold-start first paint with vs without the flat-rule parents (SEL-7):** time-to-first-primary-tile on Zürich z14 cold, `placeholderPolicy: 'flat'` vs a variant that skips parents while `bytesPerMs === null`.
- **maplibre per-frame selection CPU (SEL-4):** main-thread ms/s attributable to `selectAndLoadTiles` on a maplibre route at 60 fps with ≥1,000 resident headers.
- **Directory page faults per pan at z14 (SEL-6):** number of leaf pages fetched per pan with the parent band on vs off; each zoom's leaves are faulted separately today.

---

# Appendix 2 — audit-prefetch-runway

## Audit — PREFETCH, RUNWAY and PLAYBACK CONTINUITY inside the tileset (2026-08-24)

Scope: `packages/core/src/prefetch-policy.ts` (996 lines, read in full) and the prefetch /
runway / buffer-tracking surface of `packages/core/src/spatiotemporal-tileset.ts`
(constants :49-460, :1900-2145, :2415-2560, :2795-3240, :3260-4100, :4230-4850, :5095-5500).
Proofs were run with `tsx` against the source (`scratchpad/proof-runway.mts`,
`proof-runway-a2.mts`); the full core suite was run (99/100 files green — the one red file is
`tile-decoder.test.ts`, 6 tests, from the uncommitted worker-timing change, not this dimension).
Directory statistics for the fleet come from `target/release/stt-optimize inspect --sample 0`
(JSON saved as `scratchpad/inspect-<archive>.json`).

Showcase speed model (used everywhere below): `baseSpeed = span / targetPlaybackSeconds / 1000`
sim-ms per real-ms (`examples/showcase/src/components/demo/buildDemoLayers.ts:524`), speed
multipliers up to 10× (`packages/playback/src/auto-speed.ts:114`), loop defaults to TRUE
(`packages/react/src/hooks/use-playback.ts:122`). `tileLoadingProps` = prefetchAhead
`max(timeWindow, speed × 5 s)`, prefetchSteps 4, maxRequests 12 (`src/types.ts:1844`);
maxCacheSize 2000 / maxCacheByteSize 2 GiB are the tileset defaults (:1330-1331).

## Fleet numbers (directory-exact, compressed bytes)

| archive        | bucket | tiles   | Σ pack bytes | mean tile | primary zoom in showcase | avg tile @ that zoom                        | tiles/bucket @zoom (whole bbox) |
| -------------- | ------ | ------- | ------------ | --------- | ------------------------ | ------------------------------------------- | ------------------------------- |
| nyc-taxi-paths | 60 s   | 429,389 | 3.30 GB      | 7.7 KB    | z14 (initial 14) / z12   | 3.4 KB / 16.0 KB                            | 110 / 16.5                      |
| gtfs-ch        | 1 h    | 557,899 | 2.57 GB      | 4.6 KB    | z7 (initial 7.6)         | 631 KB (max 5.6 MB); z6 1.35 MB (max 16 MB) | 10.8                            |
| drifters       | 7 d    | 256,061 | 2.58 GB      | 10.1 KB   | z1 (initial 1.5)         | 57 KB; z0 206 KB                            | 3.7                             |
| satellites     | 5 min  | 24,480  | 1.86 GB      | 76 KB     | z0 (initial 0.5)         | 1.32 MB                                     | 1                               |
| storm-tracks   | 5 min  | 1,042   | 265 KB       | 254 B     | z6 (radar demo)          | 577 B                                       | 1.8                             |
| earthquakes    | 1 h    | 350,594 | 24.3 MB      | 69 B      | —                        | —                                           | —                               |

Speeds at 1×: nyc-taxi-paths 2,383×; gtfs-ch 157×; drifters 11.49 M×; satellites 1,440×;
storm-radar (storm-tracks sidecar) 288×.

## Runway arithmetic per dataset (Question 1)

Formulae (`prefetch-policy.ts:695-727`): `windowAhead = prefetchAhead × 4`;
`effectiveAhead = max(windowAhead, speed × 8 s)`; cap `min(·, max(64 × bucket, speed × 5 s))`;
`gateFloor = max(bucket, timeWindow, speed × 5 s)`. Count budget/pass = `max(64, 0.5 × 2000)` =
1000 tiles (:899-904); byte budget/pass = `0.5 × 2 GiB / expansion` (128 MiB cold, :943-952).

| dataset                           | horizon (sim) | = buckets | = wall    | gateFloor           | horizon tiles (viewport est.) | horizon bytes | per-pass 1000-tile budget covers | 2000-tile cache holds | start gate (2 s wall) needs | resume gate (4 s wall) needs |
| --------------------------------- | ------------- | --------- | --------- | ------------------- | ----------------------------- | ------------- | -------------------------------- | --------------------- | --------------------------- | ---------------------------- |
| nyc-taxi z14, 15–30 tiles/bucket  | 11,915 s      | 199       | **5.0 s** | == horizon          | 3.0k–6.0k                     | 10–20 MB      | 0.8–1.7 s wall                   | 1.7–3.4 s wall        | 1.2k–2.4k tiles             | **2.4k–4.8k tiles > cache**  |
| nyc-taxi z12, 10–14 tiles/bucket  | 11,915 s      | 199       | 5.0 s     | == horizon          | 2.0k–2.8k                     | 32–44 MB      | 1.8–2.5 s wall                   | 3.6–5.0 s wall        | 0.8k–1.1k                   | 1.6k–2.2k (marginal)         |
| gtfs-ch z7, 8–11 tiles/bucket     | 3,146 s       | **0.9**   | 20 s      | 3,600 s (> horizon) | 7–10                          | 4–6 MB        | hours                            | hours                 | <1 tile                     | <1 tile                      |
| drifters z1, 3–4 tiles/bucket     | 57.5 M s      | 95        | 5.0 s     | == horizon          | 285–380                       | 16–22 MB      | 13–18 s wall                     | 26–35 s wall          | 141 tiles                   | 282                          |
| satellites z0, 1 tile/bucket      | 19,200 s      | 64        | 13.3 s    | 7,200 s             | 64                            | 84 MB         | 208 s wall                       | 417 s wall            | 10 tiles (13 MB)            | 19 (25 MB)                   |
| storm-tracks z6, 1–2 tiles/bucket | 5,760 s       | 19        | 20 s      | 1,440 s             | 19–38                         | 20 KB         | minutes                          | minutes               | 2 tiles                     | 4                            |

Readings:

- Whenever `speed × 5 s ≥ 64 × bucket` (nyc-taxi and drifters at 1×; every dataset at a high
  enough multiplier) the cap and the gate floor are the SAME number, so the horizon is pinned at
  exactly 5 s of wall runway and neither the CO-2 solve (`:865 if (effectiveAhead <= gateFloor)
return`) nor the pressure ladder (`:776 max(effectiveAhead × pressure, gateFloor)`) can shrink
  it. See PR-1.
- nyc-taxi at z14 is where the horizon becomes UNSATISFIABLE by residency: 3–6k tiles wanted,
  2,000-tile cap; the resume gate alone wants 2.4–4.8k tiles resident at the primary zoom. The byte
  cap (2 GiB) is irrelevant there (6k × 3.4 KB × expansion ≈ 60–160 MB); the tile-COUNT cap binds.
- gtfs-ch is the opposite regime: the horizon is less than one bucket (20 s wall vs a 22.9 s wall
  bucket), so the next hour's 4–6 MB is planned ~20 s before the boundary; fine on any link above
  ~300 KB/s, a stall at every hour boundary below that.
- satellites at z0 is link-bound by data, not by the code: sustaining 1,440× needs one 1.32 MB tile
  per 208 ms wall = 6.3 MB/s; the CO-2 solve is live there (horizon 64 buckets > gateFloor 24) and
  the 84 MB horizon fits the 128 MiB cold budget.
- storm-tracks: 19–38 tiles / 20 KB per horizon — everything rides in one cold 4 MiB slice;
  gates are satisfiable with 2–4 tiles. Small datasets are functional (see "Checked").

## Findings

### PR-1 [high] At fast playback the horizon equals the gate floor, so the feasibility solve and the pressure ladder are inert while the runway over-runs the cache and refetches its own far edge

**Where**

- `packages/core/src/prefetch-policy.ts:707-715` (cap = `max(64 × bucket, speed × 5 s)`),
  `:723-727` (`gateFloor` includes `speed × 5 s`), `:865` (`if (effectiveAhead <= gateFloor) return
effectiveAhead` — solve skipped), `:775-777` (`max(effectiveAhead × pressure, gateFloor)` — ladder
  cannot cut).
- `packages/core/src/spatiotemporal-tileset.ts:3502-3569` (budget counts only NEW tiles; resident
  ahead-of-head tiles fall to the `else if (header !== undefined) header.lastUsed = now` branch and
  the pass walks past them), `:3390-3391` + `prefetch-policy.ts:787` (`pipelineIdle` bypasses the
  reload throttle), `:4286-4290` (`extendPrefetchIfDrained` re-plans whenever the queue drains),
  `:5346-5347` (`protectedAhead = max(timeWindow, 2 × bucket)`), `:5388-5389` (tier C = furthest-ahead
  first), `:5484` (`noteRunwayEviction`).
  **Mechanism** The per-pass budget is a per-pass ADMISSION cap, not a residency bound: each pass adds
  up to 1000 new tiles beyond whatever is already resident, and the pass re-runs as soon as its slice
  drains. Residency therefore converges on the whole horizon. When `horizon × tiles/bucket >
maxCacheSize − needed`, the over-limit pass evicts tier C (the furthest-ahead tiles just fetched),
  the eviction deletes the header, the next pass sees `header === undefined` at `:3532` and enqueues
  the same id again. The ladder fires (`pressure → 0.25`) but the pressured horizon is floored at
  `gateFloor`, which at this speed IS the horizon; the CO-2 solve returned early for the same reason.
  `protectedAhead` is 2 buckets (= 50 ms wall on nyc-taxi), so nothing in the runway is protected.
  **Scenario** Large + playback: nyc-taxi-paths at the showcase 1× (2,383×, 199-bucket horizon, 3–6k
  tiles at z14 / 2–2.8k at z12 against a 2,000-tile cap); any demo at a ≥4–5× multiplier; composites
  split the count cap by N and hit it sooner.
  **Consequence** Continuous fetch → evict → refetch of the far runway: measured 18 % read
  amplification in the synthetic (3,350 requests for 2,835 distinct tiles, 515 ids fetched twice, 555
  runway evictions, pressure pinned at 0.25 with the far edge still dispatched 94 buckets ahead of an
  80-bucket cache). The wasted fetches share the 12-slot scheduler with priority work. Second
  consequence, same root: with the count cap binding, the governor's resume gate (4 s wall × speed =
  159 buckets × 15–30 tiles = 2.4–4.8k tiles at nyc-taxi z14) can never be satisfied by residency; after
  any stall the governor waits `maxStartWaitMs` 8 s (`playback-governor.ts:2499-2502`) and enters
  degraded creep unless `predictsPlaythrough` (`:2980-3016`, ETA = missing bytes / throughput ≤
  max(runway wall, 250 ms)) rescues it — 159 buckets × 25 × 3.4 KB = 13.5 MB in ≤ ~2.5 s needs a
  ≥ 5.4 MB/s link.
  **Evidence** `scratchpad/proof-runway-a2.mts` (speed 40 sim-ms/real-ms ⇒ 200-bucket horizon =
  gateFloor; 5 tiles/bucket; maxCacheSize 400): `distinct 2835 requests 3350 refetched 515
runwayEvictions 555 pressure(first,min,last) 1 0.25 0.25 furthest dispatch 94 buckets`. The same
  script with 20 tiles/bucket (PR-5 regime) shows 0 refetches only because the head outran the
  enqueue rate. Arithmetic above from the constants and directory stats.
  **Fix** (a) Make the budget a RESIDENCY bound: in `prefetchFutureTiles` count loaded headers whose
  `plan.aheadDistance(id.t) ≤ effectiveAhead` toward `newTilesAdded`/`enqueuedBytes` before admitting
  new ones (about 6 lines in the candidate loop). (b) Let the floor bend when the gate is provably
  unsatisfiable: `gateFloor = min(gateFloor, residencyCapacitySimMs)` where capacity =
  `PREFETCH_CACHE_FRACTION × maxCacheSize / (keys per bucket from the coverage index) × bucketMs` —
  the governor already has the 8 s escape hatch, so over-committing "to keep the gate satisfiable"
  buys nothing when the cache cannot hold the gate. (c) The count cap itself (2000 tiles regardless of
  tile size) is the eviction auditor's; note it as the shared root — for 3.4 KB tiles the byte cap would
  allow ~150k tiles. Blast radius: `prefetch-runway.test.ts:50` (pins the per-pass count),
  `prefetch-policy.test.ts:250, :930, :944` (pin the floor semantics), `prefetch-runahead-cap.test.ts:108`.
  **Confidence** high on mechanism (reproduced; every line read); medium on the exact live tiles/bucket
  at nyc-taxi z14 (15–30 is a geometric estimate; 110 populated cells per bucket over the whole bbox).
  **How to verify** Turn `proof-runway-a2.mts` into a test: at `speed × 5 s > 64 × bucket` and
  `horizon × tiles/bucket > maxCacheSize`, assert `refetched === 0 && runwayEvictions === 0` (fails
  today: 515 / 555). Live: `tools/bench/src/policy-record.mjs nyc-taxi-paths 30` and count duplicate
  tile ids in the `requests` channel and tier-c entries in `evict`.

### PR-2 [high] Sub-tolerance camera drift leaves phantom trailing-edge tiles in the coverage index; the buffered runway decays to 0 while everything on screen is resident

**Where** `spatiotemporal-tileset.ts:5113-5131` (index rebuilt only when `quantizedSpatialKey`
changes, but built from the EXACT `bounds`), `:2811-2820` (key = bounds rounded to 1/8 of the
span), `:4488-4499` (a bucket is ready iff EVERY index key is ready), `:2828` / `:3308` (selection
and prefetch address the exact current bounds), `:5377` (keys outside the index → eviction tier A).
**Mechanism** After a drift smaller than 1/8 of the viewport the key is unchanged, so the index still
lists the tile column that the trailing edge has left. Nobody addresses that column any more
(selection and prefetch use the new bounds), so for every bucket beyond the last pre-drift prefetch
pass the index holds a key that will never load; `firstMissing` lands there and the runway shrinks to
0 as the head advances, staying 0 until the camera moves > 1/8 of the viewport. Symmetrically the
leading-edge column is NOT in the index: invisible to the runway (optimism) and ranked tier A
("stale viewport") by eviction, i.e. evicted first under pressure.
**Scenario** All sizes; any smooth camera during playback: `/drive` ego-follow, the auto-rotating
globes (`ocean-drifters` "the globe slowly spins via the auto-rotate loop", HomeGlobe, StoryGlobe),
eased pans, the interleaved terrain camera on `gtfs-ch`.
**Consequence** The governor reads `simMs: 0, complete: false` → low watermark → `'buffering'` gate at
`resumeFactor` 2 → unsatisfiable (no fetch will ever be issued for the phantom) → 8 s
`maxStartWaitMs` freeze → degraded creep, with every tile the viewport needs already resident. This
confirms the "coverage-index quantisation staleness" item left unconfirmed in
`docs/roadmap/tile-loading-3d-2026-07.md:478-479`.
**Evidence** `scratchpad/proof-runway.mts` experiment B (2°-wide tile columns, bounds [0,80] →
[3,83] = 3.75 % drift, same quantized key): runway 14,900 before the drift; after it, 14,300 → 11,300 →
… → 0 by step 25 and 0 through step 39, with `headBucketTilesNeverRequested = 0` at every step;
after a > 1/8 pan the index rebuilt and the runway recovered to 13,100. The eight requests for
"phantom" column 0 at t > 10,000 all came from pre-drift passes (the runway had been planned to
t = 19,000).
**Fix** Rebuild on the invariant that actually matters — the primary-zoom TILE BOX of the bounds —
instead of a 1/8-span rounding of lon/lat: key = `(xmin,xmax,ymin,ymax at primaryZoom)` from the
same `viewportTileXIntervals`/`latToTileClamped` the placeholder gate uses (:2740-2742). That keeps
the "don't re-run the full-time directory slice per frame" property (the box changes only when a tile
boundary is crossed) and removes phantoms exactly. Cheaper stop-gap: in the three readiness walks,
skip keys whose `(x, y)` fall outside the current bounds' tile box. Blast radius: `buffered-runway.test.ts`
(no drift case), `prefetch-flush.test.ts:268` (sub-viewport drift keeps prefetch — unaffected).
**Confidence** high (reproduced against the real class).
**How to verify** Unit: experiment B as a test — after a sub-tolerance drift that crosses a tile
boundary, `getBufferedRunway(time).simMs` must stay ≥ the planned runway (fails today: 0). Live:
`/drive` with `__sttProbe` playback channel — look for `'buffering'` gates with `runway 0` and an
empty priority queue during ego-follow.

### PR-3 [medium] A loop wrap is always a cold seek: nothing warms the loop start, and every showcase demo loops by default

**Where** `spatiotemporal-tileset.ts:2112-2123` (`setLoopWindow` is storage only; `loopRange` is
read solely by eviction at `:5362`), `:2533-2538` (the wrap delta `≈ −loopSpan` exceeds the seek
threshold → `flushPrefetch()`), `playback-governor.ts:942-955` (wrapHandler → `flushPrefetch()` on
every source → `enterGate('seeking', 1)`), `prefetch-policy.ts:779` (`endTime = time + direction ×
effectiveAhead` — no modular wrap) and `:809-812` (loop-start buckets are "behind head" and sort
last), `packages/react/src/hooks/use-playback.ts:122` (`loop = true`).
**Mechanism** The plan runs past `loop.end` into empty directory time; on the wrap the queue and all
in-flight prefetch are aborted and the governor re-gates at 2 s wall from `loop.start`. The only
thing that can make lap N+1 warm is BH-7 loop-modular EVICTION keeping lap N's tiles, which requires
the whole loop to fit the cache (`loopSpan > protectedAhead + keepBehind` and count/byte caps).
**Scenario** All demos; worst for loops ≫ cache: nyc-taxi (2,384 buckets vs ~80–100 buckets of cache),
drifters (2,281 buckets), gtfs-ch fits by bytes (35 buckets × 10 × 631 KB ≈ 220 MB) so laps ≥ 2 are
warm there.
**Consequence** Per lap on nyc-taxi z14: ~80 buckets × 25 × 3.4 KB ≈ 6.8 MB before the 2 s-wall gate
passes (≈ 1.7 s at 4 MB/s + RTT + decode); drifters z1 ≈ 8 MB. A visible freeze at every wrap on
ordinary links; the governor's own comment ("seamless loops stay seamless") holds only for loops that
fit the cache.
**Fix** Prefetch side only, ~25 lines: in `prefetchFutureTiles`, when `this.loopRange` is set and
`plan.endTime > loop.end`, issue a second `fetchAvailableTilesForZoom` for
`[loop.start, loop.start + (plan.endTime − loop.end)]` and rank those candidates by
`(loop.end − time) + (t − loop.start)` instead of the behind-head sentinel. In `update()` recognise the
wrap (`Math.abs(simTimeDelta + direction × loopSpan) < bucketMs`) and call `flushPrefetch(true)`-style
preservation for in-flight records whose keys lie in `[loop.start, loop.start + horizon]`. Blast radius:
`prefetch-flush.test.ts:130` (seek flush), governor `wrapHandler` semantics, `eviction-buffered-timeline.test.ts:151`.
**Confidence** high on mechanism; medium on stall magnitude (needs the live number).
**How to verify** Probe `playback` channel on `/demo/nyc-taxi-paths`: time from `wrap` to the first
`playing` state and the count of `'seeking'` gate entries per lap; expect ≥ 1 s today, ≈ 0 after.

### PR-4 [medium] The spatial flush aborts the in-flight prefetch slice on every 1/8-viewport move, so a continuous pan faster than viewport/8 per second keeps the runway at ≤ one slice

**Where** `spatiotemporal-tileset.ts:2955-2966` (`flushPrefetch(true)` on any > 1/8 centre/span/zoom
change), `:4774-4795` (aborts every in-flight prefetch record unless one of ITS keys is in the
PREVIOUS needed set), `:4758-4765` (drops the whole queue), `:4803` (`invalidatePlan` → the next pass
runs immediately with a fresh full-horizon directory walk + sort).
**Mechanism** After a 1/8 pan 7/8 of the viewport is unchanged, so most tiles in the in-flight slice
are still wanted; they are aborted anyway (bytes wasted, headers deleted at `:4792`) and re-planned
and re-fetched by the next pass. `preserveNeeded` only spares a slice the head has already ENTERED.
**Scenario** User pans while playing on any large archive; ego-follow cameras that move > 1/8
viewport per second (`/drive` at z17–18); a slice is 1–16 MiB (1 s of measured download).
**Consequence** At pan rate ≥ 1/8 viewport/s every slice is aborted before it lands: the runway never
exceeds one slice, the priority path serves the head, and each flush also costs one full-horizon
directory walk + sort (≈ 5k ids for nyc-taxi z14) on the main thread. Wasted bytes ≤ 1 slice per flush.
**Fix** On the spatial path abort only records none of whose keys intersect the NEW bounds' tile box
at their zoom, and filter (not clear) the queue by the same box. Blast radius:
`prefetch-flush.test.ts:294` and `prefetch-supersede.test.ts:166` assert the abort on a real pan; both
would need the assertion changed to "aborts only the tiles that left the viewport".
**Confidence** high on mechanism; medium on live magnitude.
**How to verify** Probe `batches` channel while scripting a 0.2-viewport/s pan on
`/demo/nyc-taxi-paths`: count prefetch-tier batches that settle with `aborted` per second (expect ≈ 1.6/s
today, 0 after) and the prefetch-tier bytes that never delivered.

### PR-5 [medium] The prefetch enqueue RATE is capped at `PREFETCH_CACHE_FRACTION × maxCacheSize / PREFETCH_DEBOUNCE_MS` (= 4,000 tiles/s at defaults, 4,000/N in composites); above that consumption rate the runway cannot build on any link

**Where** `prefetch-policy.ts:326` (250 ms debounce), `:899-904` (per-pass count budget),
`spatiotemporal-tileset.ts:2423-2439` (one pass per debounce window), `:3503` (per-pass cap).
**Mechanism** Each pass admits ≤ 1000 new tiles and passes are ≥ 250 ms apart, so enqueue ≤ 4,000
tiles/s. Consumption = `tiles/bucket × speed / bucketMs`. When consumption ≥ enqueue, the head
outruns the planner regardless of bandwidth.
**Scenario** Small-tile, fine-bucket archives at high multipliers: nyc-taxi z14 at 1× consumes ≈ 25 ×
39.7 = 990 tiles/s (4× headroom); at the 4× step ≈ 3,970 tiles/s (parity); 5×–10× exceed it. A
composite split (2000/N) halves or thirds the ceiling.
**Consequence** Runway pinned near the per-pass budget's worth of buckets (0.25 s wall in the
synthetic) even with an unlimited link; the governor gates on it → auto-speed backs the multiplier
down, i.e. the speed ceiling is set by this constant, not by the network.
**Evidence** `proof-runway.mts` experiment A (20 tiles/bucket, cache 400 ⇒ 200 tiles/pass ⇒ 800
tiles/s; consumption 800 tiles/s): `furthest prefetch dispatch ahead of head 11 buckets` with an
instantaneous fake link, 0 refetches, pressure 1.
**Fix** Falls out of PR-1(a): once the budget is a residency bound, admit `residencyCap − residentAhead`
tiles per pass instead of a fixed fraction, and skip the count budget entirely when `getTileByteSize`
is wired (the byte budget is the honest one). Blast radius: `prefetch-runway.test.ts:50`.
**Confidence** high (derivable from constants; reproduced).
**How to verify** Test: at 20 tiles/bucket and `speed` chosen so consumption = 2 × enqueue cap with an
instant fake link, assert the furthest prefetched bucket reaches the horizon (fails today: 11 of 200).

### PR-6 [low] CO-7 (primary-zoom-only prefetch) is sound, but its sparse-archive fallback claim holds only until the first throughput sample

**Where** uncommitted `spatiotemporal-tileset.ts:3319-3352`; the fallback it relies on is
`shouldSkipParentFetch` → `placeholderWorthFetching` `:2776-2795`, in particular
`missingChildBytes += getSize(childId) ?? 0` (:2779) and `coverMs = missingChildBytes / bytesPerMs` (:2789).
**Mechanism** Assessment of the change: (1) `no-overlap` is byte-identical (`getZoomLevelsToLoad`
returns one level either way, :2620-2623); (2) summary tiers unchanged (`pickTierForZoom` is per zoom,
:1952-1963, and the primary is still queried); (3) camera below `minZoom` / above `maxZoom` clamps in
`:2618`, so "primary" is the clamped level and the runway warms exactly what is drawn; (4) the
coverage index and every readiness API are already primary-only (`:5118`), so CO-7 makes the
runway the governor gates on and the runway prefetch fills the SAME set — an improvement in
consistency; (5) all 99 prefetch/runway/eviction test files pass with it, including the two new
tests. The caveat: over a region with NO directory children (a `--min-features-per-tile > 1` archive),
`missingChildBytes` is 0, so `avertedValueMs` is 0 and `arrivalMs < 0` is false — the covering ancestor
is judged worthless and skipped on the PRIORITY path too, once `getThroughput` has a sample. The
comment's "the priority path still walks PARENT_FALLBACK_LEVELS" is therefore true only while the
estimator is cold. This is a CO-6 gate defect (cross-reference the placeholder/selection auditor); CO-7
does not create it (pre-CO-7 the prefetch path applied the same gate at :3506) but its comment
relies on it.
**Scenario** Sparse archives only; none in the local fleet is built with `--min-features-per-tile > 1`
as far as the manifests show.
**Consequence** In such an archive a low-density region renders blank rather than coarse after the
first throughput sample.
**Fix** In `placeholderWorthFetching`, when no child under `u` exists in the directory
(`getSize(childId) === undefined` for every visible cell) return `null` (abstain → flat rule), or
treat the parent as primary for that region. Correct the CO-7 comment either way.
**Confidence** high on the code path; medium on whether any real archive triggers it.
**How to verify** Test: a directory with a parent and zero children in the viewport, throughput
wired; assert the parent is enqueued at priority (fails today).

### PR-7 [low] `estimateTimeToReadyMs` returns 0 (not `null`) on a byte-blind index, so a blind source passes the governor's playthrough prediction with nothing loaded

**Where** `spatiotemporal-tileset.ts:4722-4728` (`estimateCost(range).bytes / bytesPerMs`),
`:4574-4575` (`bytes` is 0 when `getTileByteSize` is unwired), `playback-governor.ts:3009-3015`
(`etaMs == null` is the only conservative branch; `0 ≤ max(runwayWall, 250)` passes).
**Mechanism** `getByteDensityProfile` abstains (`null`) when `!idx.bytesKnown` (:4642) but the
ETA does not; the governor treats 0 ms as "already there".
**Scenario** Only consumers that wire `getAvailableTiles` without `getTileByteSize` (custom
sources, render-test fakes); the fleet path is never blind — `tileset-adapter.ts:66` wires it and both
the index build (:5131 → :5152) and the prefetch pass (:3416 → :3538) await the directory slice, so
paged leaves are resident before any size is read.
**Consequence** For a blind source the gate can release into unloaded time.
**Fix** `if (!this.coverageIndex?.bytesKnown) return null;` at the top of `estimateTimeToReadyMs`.
Blast radius: `buffered-runway.test.ts:338` (expects a number when throughput is wired — its
harness wires sizes, so unaffected).
**Confidence** high.
**How to verify** Test: unwired `getTileByteSize`, wired throughput → `estimateTimeToReadyMs` must
be `null` (returns 0 today).

### PR-8 [low] A prefetch slice the head has entered is never promoted: it stays `fetchPriority: 'low'` and is not re-issued at priority, so the bucket completes only when the low-priority slice does

**Where** `spatiotemporal-tileset.ts:3169-3172` (`!header.isLoading` guard — no re-request),
`:3898-3905` (batch skips loading headers), `:3980` (`fetchPriority: tier === 'priority' ? 'auto' :
'low'` fixed at dispatch), `:4743-4746` (the comment acknowledges "a request's tier is stamped once
at dispatch and never promoted").
**Mechanism** Question 5 settled: there is NO duplicate fetch (good), but also no promotion. The
hostage window is bounded by slice sizing (≈ 1 s of measured download, ≤ 16 MiB), and on a
congested link the browser's `low` hint de-prioritises exactly the slice the head is waiting on
relative to concurrent `auto` priority batches for the same bucket's other tiles.
**Scenario** Playback on a contended link when the head catches the slice (fast playback, PR-4/PR-5
regimes make it common).
**Consequence** Up to one slice of extra latency before a bucket is complete; the governor's low
watermark (600 ms) can fire meanwhile.
**Fix** Cheapest: dispatch prefetch slices with `fetchPriority: 'auto'` when `prefetch.isAnimating`
(the shared scheduler's EDF already orders by playhead distance); fuller: allow the priority path to
abort-and-reissue an in-flight prefetch record whose keys are now ALL needed.
**Confidence** medium (mechanism certain; the latency cost depends on transport behaviour).
**How to verify** Render-test with throttled network: measure time from "head enters bucket B" to
"bucket B complete" when B's tiles were in an in-flight prefetch slice vs a priority batch.

## Checked and correct

- Direction hysteresis + immediate flip on a signed speed + flush on flip — `prefetch-policy.ts:491-505,
:525-543`; `spatiotemporal-tileset.ts:1988-1989, :2013-2021`. Reverse playback is fully supported
  (plan :797-812, eviction :5383-5384, runway :4466-4515).
- Speed-aware seek detection and the frozen-clock guard — `:2533-2538, :2550-2552` (per-frame step at
  2,383× is 40 s sim vs a 2,383 s threshold; a tab hidden > 1 s correctly reads as a seek).
- Wall-clock debounce and the single deferred timer — `:2423-2439`; `prefetch-policy.ts:606-622`.
- Pass supersession after the directory await — `:3413, :3429`; `prefetch-policy.ts:632-648`.
- Nearest-first ordering with the behind-head sentinel — `prefetch-policy.ts:809-812`; `:3448-3450`.
- Byte-currency conversion and the bounded expansion measurement — `prefetch-policy.ts:943-952`,
  `:3272-3292, :3375-3378`.
- Dead-header revival gated by the retry backoff — `:3525-3530`.
- `anchorTruncatedRunway` corrects only its own claim — `prefetch-policy.ts:966-974`; `:3575-3577`.
- Slice sizing, one slice in flight, priority first, MAX_COALESCE_BATCH — `:3674-3724`;
  `prefetch-policy.ts:985-995`.
- No duplicate request for a tile already in flight — `:3169-3172, :3784-3792, :3898-3905`.
- Tier-aware supersession (prefetch exempt; priority judged per batch; per-tile sweep) — `:4319-4377`.
- `releaseActiveRequest` ownership check — `:4079-4087`.
- `getBufferedRunway` semantics (Question 2): buckets with no viewport tiles are absent from
  `bucketStarts` and therefore trivially ready (:4481-4487); a viewport with no tiles at any time
  (camera outside the data) is `complete: true, simMs = horizon` (:4454-4461); an unbuilt index is
  `simMs 0, complete false` (:4444-4452); a single-bucket archive with the head past the data edge is
  `complete: true, simMs 0` (probe clamped at `idx.timeRange.end`, :4467-4470) and the governor passes on
  `complete` (`playback-governor.ts:2476`); probe clamps at the data edge in either direction.
- `estimateCost` / `getByteDensityProfile` / `bytesForHorizon` share one bucket-intersection rule and
  the prefix sums are monotone (bisection valid) — `:4577-4712`; pinned by `cost-oracle.test.ts:582-647`.
- `onBufferChange` trailing-edge throttle ≤ 10 Hz — `:5208-5223`.
- Coverage-index build discards superseded builds and reports `bytesKnown` honestly — `:5127-5153`.
- CO-2 solve abstentions and floor keeping — `prefetch-policy.ts:851-869, :889-890`.
- Run-ahead cap with its safety floor — `prefetch-policy.ts:733-738`; `:2080-2082`.
- `setLoopWindow` degenerate ranges → null — `:2112-2123`.
- Paged-directory sizes: `archive.getTileByteSize` (:3470-3472) is `undefined` for a non-resident leaf,
  but every charge site runs after the async directory slice has paged the leaf in, so the 64 KiB prior
  (`PREFETCH_UNKNOWN_TILE_BYTES`) is effectively unused on the fleet path (Question 6). Where a
  byte-blind consumer does hit it, it is 8× (taxi) to ~1000× (earthquakes 69 B, storm-tracks 254 B)
  too high and roughly right only for satellites (76 KB); the effect is a 64-tile-per-pass count cap
  (4 MiB / 64 KiB), which is conservative, not dangerous.
- Cost at scale (Question 7): `getBufferedRunway` walks only the probe horizon (nyc-taxi 397 buckets ×
  ~25 keys ≈ 10k `Map.get` per call at 5 Hz governor probe + ≤ 10 Hz `onBufferChange` ≈ 150k lookups/s,
  ≈ 1–2 ms/s); `getBufferedRanges` walks EVERY bucket (worst case all loaded: 2,384 × 25 ≈ 60k lookups
  ≈ 1–3 ms) and is called per scrub-preview frame (`playback-governor.ts:1424`) and by
  `stt-player.getBufferedRanges` (:264) — acceptable; `bytesForHorizon` is O(log n). The
  64-range truncation only bites with > 64 disjoint buffered spans.
- Small datasets (storm-tracks 1,042 tiles; storm4d-reports 80; lines-v2 492; bixi-flowmap 59): horizon
  19–38 tiles / 20 KB rides in one cold 4 MiB slice; coverage index = one 108-id query; gates need 2–4
  tiles; every mechanism converges (a pass that finds nothing enqueues nothing). The 250 ms debounce
  and 200 ms probe add no user-visible latency beyond the first slice's RTT.

## Doc ↔ code drift

- `docs/roadmap/playback-and-loading.md:237-240` "instead of letting fetch→evict→refetch continue,
  the speculative prefetch horizon degrades" — false whenever `speed × 5 s ≥ 64 × bucket` (the
  showcase 1× for nyc-taxi and drifters): the pressured horizon is floored at `gateFloor`, which is the
  horizon (PR-1, measured: pressure 0.25, thrash continues).
- `prefetch-policy.ts:123-141` (`PREFETCH_CACHE_FRACTION`): "Capping the prefetch working set to a
  fraction of the cache keeps the runway RESIDENT" — the code caps the per-PASS enqueue, not the
  working set; residency converges on the horizon (PR-1).
- `prefetch-policy.ts:100-103` "the ladder shrinks speculation, never the playhead's own data" — at
  the floor it shrinks nothing at all.
- Uncommitted `spatiotemporal-tileset.ts:3345-3350` "the covering ancestor is resolved on the
  PRIORITY path when the head arrives … the priority path still walks PARENT_FALLBACK_LEVELS" — only
  while the throughput estimator is cold (PR-6).
- `playback-governor.ts:939-940` "A wrap into fully-cached time passes the gate synchronously, so
  seamless loops stay seamless" — accurate, but nothing makes the loop start cached unless the loop fits
  the cache; `setLoopWindow`'s own doc (:2084-2096) correctly scopes it to eviction (PR-3).
- `spatiotemporal-tileset.ts:4410-4413` "the same `getAvailableTiles` universe that
  `selectAndLoadTiles` fetches from" — not after a sub-tolerance drift (PR-2), and not under
  `selectionMode: 'frustum'` (index is box-addressed, selection cut-addressed; frustum is opt-in,
  default `'aabb'`, `spatiotemporal-layer.ts:720`).
- `docs/roadmap/tile-loading-3d-2026-07.md:478-479` lists "the coverage-index quantisation
  staleness" as unconfirmed — now confirmed (PR-2), with a second consequence the item did not
  anticipate (leading-edge tiles ranked tier A by eviction).
- `prefetch-policy.ts:56-61` (MAX_PREFETCH_BUCKETS comment) is consistent with the code.

## Test assessment (Question 8)

Pinned and real: direction hysteresis, horizon caps, run-ahead floor, solve bisection/monotonicity/
determinism, ladder constants and recovery pacing, throttle/re-anchor, slice sizing, byte-currency
conversion, tier-aware supersession, seek-vs-step detection, spatial-flush tolerance, runway walk
semantics, cost/profile equality, `onBufferChange` throttle, CO-7 zoom fan-out (the +74 lines are
real: the batch spy sees the zooms actually dispatched).
Vacuous or near-vacuous: `prefetch-runway.test.ts:636-760` (feasibility solve at tileset level)
advances the head 1 ms per 300 ms of wall clock, so it never enters the regime where the floor
dominates — it cannot fail for PR-1; `prefetch-policy.test.ts:930, :944` and
`prefetch-runahead-cap.test.ts:108` PIN the floor behaviour that causes PR-1 (not vacuous, but they
lock the defect); `eviction-buffered-timeline.test.ts:151` asserts a no-op.
No test exists for: residency bound across passes (PR-1); runway under sub-tolerance drift (PR-2);
loop-wrap warming (PR-3); spatial-flush waste when most of the slice is still in view (PR-4); the
enqueue-rate ceiling (PR-5); sparse-parent skip after a throughput sample (PR-6); blind
`estimateTimeToReadyMs` (PR-7); promotion of an in-flight prefetch slice (PR-8); prefetch at a
camera zoom clamped to `minZoom`/`maxZoom`; summary-tier parity between prefetch and selection.

## Needs measurement

- Live tiles/bucket in the nyc-taxi-paths z14 viewport and the duplicate-request rate / tier-C
  eviction count over 30 s of 1× playback (`tools/bench/src/policy-record.mjs nyc-taxi-paths 30`,
  then count repeated ids in `requests` and `tier: 'c'` in `evict`). Settles PR-1's live magnitude.
- Wrap stall: time from the clock's `wrap` event to the next `playing` state on nyc-taxi-paths,
  drifters, gtfs-ch (playback channel). Settles PR-3's magnitude (predicted ≥ 1 s on a 4 MB/s link).
- `/drive` ego-follow: count `'buffering'` gate entries whose `runway.simMs === 0` while the priority
  queue is empty (PR-2 in the wild) and prefetch-tier aborts per second (PR-4).
- Hostage latency (PR-8): with a throttled network, bucket-complete latency when the head enters a
  bucket served by an in-flight `low` slice vs by a priority batch.
- Whether any deployed archive is built with `--min-features-per-tile > 1` (PR-6 reach).

---

# Appendix 3 — audit-governor

## Audit — CLOCK ↔ LOADER COUPLING (PlaybackGovernor / TimeController / SttPlayer / consumer wiring)

Auditor scope: `packages/playback/src/{playback-governor,time-controller,stt-player,auto-speed,fairness}.ts`,
`packages/core/src/render/tileset-adapter.ts`, the BufferSource half of `packages/core/src/spatiotemporal-tileset.ts`,
`packages/layers/src/layers/spatiotemporal-layer.ts` (tick/playState/onBufferChange wiring),
`packages/react/src/hooks/use-playback.ts`, `packages/react/src/components/PlaybackControls.tsx`,
`examples/showcase/src/components/demo/{DemoViewer.tsx,buildDemoLayers.ts,useDemoPlayback.ts,DemoEmbed.tsx}`,
`examples/showcase/src/datasets.ts`, `examples/showcase/src/types.ts`, the five playback test files,
`docs/roadmap/playback-and-loading.md` §3–§6, `docs/api/{stt-player,playback-governor}.md`. Read-only; all line
numbers are from the current working tree (2026-08-24).

Reference numbers used throughout (from `datasets.ts` + the archive manifests under `examples/showcase/public/data`):

| demo                        | span                    | target s       | speed (sim-ms / wall-ms) | bucket               | wall-s per bucket | sources                                                   | tiles             |
| --------------------------- | ----------------------- | -------------- | ------------------------ | -------------------- | ----------------- | --------------------------------------------------------- | ----------------- |
| gtfs-ch                     | 122,700,000 ms (34.1 h) | 780            | **157.3**                | 3,600,000 (1 h)      | 22.9              | 1 (`tripHeads`, no heads overlay)                         | 557,899 z6–14     |
| storm-4d-greenfield         | 34,200,000 ms (9.5 h)   | 120            | **285**                  | 300,000 (5 min)      | 1.05              | ~10 (all `required`, `overlayGatesPlayback` unset ⇒ true) | volume 5,407 z4–9 |
| storm-radar (+storm-tracks) | 21,600,000 ms (6 h)     | 75             | **288**                  | 300,000              | 1.04              | 3                                                         | tracks 1,042      |
| nyc-taxi-paths              | 24 h                    | (see datasets) | ~720                     | 60,000               | 0.083             | 1                                                         | 429,389 z10–14    |
| lines-v2 ("flight-paths")   | 126,272,000,000 ms      | 60             | **2.10e6**               | 2,592,000,000 (30 d) | 1.23              | 1                                                         | 492 z0–4          |
| drifters                    | 1.379e12 ms (43.7 y)    | 120            | **1.15e7**               | 604,800,000 (1 wk)   | 0.053             | 1                                                         | 256,061 z0–4      |
| satellites                  | 24 h                    | 60             | 1,440                    | 300,000              | 0.21              | 1                                                         | 24k z0–3          |

Governor defaults (`playback-governor.ts:969-1000`, start gate at `:974`): start gate 2000 wall-ms × |speed|, low watermark 600, resumeFactor 2
(⇒ resume gate = 4000 wall-ms × |speed|), maxStartWaitMs 8000, runwayToleranceMs unauthored ⇒ BH-4 per-source band,
EVAL_INTERVAL_MS 250 (:547), TICK_PROBE_INTERVAL_MS 200 (:556), CLAMP_MAX_OVERRUN_REAL_MS 1000 (:565),
PLAYTHROUGH_MIN_WALL_MS 250 (:577), RUN_AHEAD_SLACK_WALL_MS 3000 (:586). Tileset side: RUNWAY_HORIZON_REAL_MS 10 s (:286),
BUFFER_CHANGE_THROTTLE_MS 100 (:427), FAILED_TILE_MAX_ATTEMPTS 3 (:318), FAILED_TILE_RETRY_COOLDOWN_MS 500 (:345),
FAILED_TILE_READINESS_WRITEOFF_SETTLES 8 (:376). Layer side: MIN_TILESET_UPDATE_WALL_MS 100 (:1420). Every shipped
consumer constructs the governor with NO `getThroughput` and NO `baseSpeed`
(`use-playback.ts:171`, `StoryGlobe.tsx:338`, `HomeGlobe.tsx:88` (`maxStartWaitMs: 4000`), `stt-player.ts:150-153`).

---

## Findings

### G1 [high] A committed seek (timeline click / arrow key / drag release) issued while the layer's tick-path wall throttle is closed never re-selects tiles for the target; the post-seek gate then has nothing loading its window and resolves only through the 8 s escape hatch (degraded creep) on any link where the one-window predictor cannot pass

**Where**

- `packages/layers/src/layers/spatiotemporal-layer.ts:1125-1129` — the ONLY path by which the tileset learns the playhead: `tickHandler = (time) => { if (Math.abs(time - this._currentTime) > 1) this._handleTimeUpdate(time); }`.
- `spatiotemporal-layer.ts:1403-1430` — `_handleTimeUpdate`: `if (timeDelta > updateThreshold && nowWall - this._lastTilesetUpdateWall >= MIN_TILESET_UPDATE_WALL_MS /*100*/) { … tileset.update(…) }`; the blocked branch (:1479-1481) only calls `setNeedsRedraw()` — there is no trailing re-run (contrast `_scheduleViewportSettle` :1757-1775, which exists precisely for the viewport path).
- `packages/playback/src/playback-governor.ts:2283-2305` — `commitSeek`: `pauseClock()` THEN `timeController.setTime(time)` THEN `enterGate('seeking', 1)`. After this the clock is frozen, so no further `tick` can reach the layer until the gate passes.
- `playback-governor.ts:1330-1335` (`scrubTo`) and `:1337-1375` (`endScrub` `alreadyCommitted` path) and `PlaybackControls.tsx:629-640, 651-660` — the release value is the last `onChange` value, so `endScrub(value)` → `setTime(value)` hits `|time − _currentTime| > 1 === false` in the tick handler and calls nothing at all.
- `playback-governor.ts:2434-2530` — `evaluateGate` only reads `getBufferedRunway`/`estimateTimeToReadyMs`; the `BufferSource` contract has no "seek"/"update" verb, so the governor cannot re-drive selection.
- `spatiotemporal-tileset.ts:2006-2040` — the gate's `setAnimationState(true, speed)` only calls `schedulePrefetch()`, and `prefetchFutureTiles` (:3305-3310) plans from `this.currentViewport.time` — the STALE time — in the committed (forward) direction.

**Mechanism**

1. While playing, the tick path calls `tileset.update()` exactly every ≥100 ms wall (at 157× the sim threshold `timeWindow/20 = 1 s` is crossed in 6 ms, so the wall floor is the binding one). A `seekTo` at a uniformly random instant therefore lands 0–100 ms after the last passing update: the throttle blocks it with probability ≈ 1. `_currentTime` is updated, `_lastTilesetUpdateTime` is not, `tileset.currentViewport.time` stays at the pre-seek playhead.
2. `commitSeek` has already paused the clock, so no tick follows. `enterGate('seeking')` → `evaluateGate`: `combinedRequiredRunway(target)` walks the coverage index (correct, viewport-wide, full time range) → the target bucket's keys have no headers (`isCoverageReady` → `tiles.get(key)` undefined, :4400-4404) → `simMs 0, complete false`. `predictsPlaythrough` → fluid path returns `null` (no governor `getThroughput`, :3047-3060) → one-window: `estimateTimeToReadyMs(window)` = `estimateCost(window).bytes / bytesPerMs` compared with `max(0, 250 ms)`.
3. Nothing selects the target bucket: the only two `tileset.update` callers are the blocked tick path and `_updateTileset` (`updateState`, props/viewport-driven — DemoViewer's `layers` memo does not depend on time, :303-340). The prefetch planned from the stale time covers `[T_stale, T_stale + max(prefetchAhead×4, speed×8 s)]` = 0.87 bucket forward on gtfs-ch (`types.ts:1844-1856` → 786,550 × 4 = 3,146,200 sim-ms), so only a seek forward by < 1 bucket is rescued.
4. Drag release: previews update the tileset at ≤10 Hz (same throttle), so the tileset's time is the last PASSED preview — up to 100 ms of drag distance behind the thumb (a 300 px/s drag on gtfs-ch's ~600 px slider = 30 px ≈ 2 buckets). `endScrub(value)` with `value === _currentTime` calls nothing; the 200 ms settle-commit (`seekTo`) is the same `commitSeek` → same `setTime(value)` no-op.
5. Resolution: after `maxStartWaitMs` (8000 ms) the hatch fires (`:2499-2503`), `setDegradedCreep(true)`, `playClock()`; the first frame's tick finally passes the throttle (`_lastTilesetUpdateWall` is now ≥100 ms old) → `update()` → seek detection (`:2533-2538`) → `flushPrefetch` → `selectAndLoadTiles` → priority fetch → the clamp pins the playhead at `bufferedUntil = target` until the bucket lands → creep clears at the resume gate (`refreshFrontier` :2546-2599).
6. Fast-link variant (local `stt-serve`, ETA ≪ 250 ms): the predictor passes immediately, `playClock()`, next frame: layer tick still inside the 100 ms window (blocked again); governor tick → `refreshFrontier` → runway 0 → `bufferedUntil = time`; `checkLowWatermark` → predictor passes; the FOLLOWING frame overruns by one frame → `setClockTime(frontier)` + `enterGate('buffering', 2)` (`:919-928`) → gate's predictor (4 s window) may pass → `playing` → … one `buffering`/`playing` cycle per frame (≤6 frames) until the throttle window elapses and `update()` runs. Each cycle is a `stallCount++`, a `waiting`+`ready` pair, and a `pauseClock`/`playClock` that makes the layer call `setAnimationState(false)` → `selectAndLoadTiles()` at the STALE time (`:2029-2038`) — which does not help.

**Scenario** All demos; worst on large archives with coarse buckets over R2 (gtfs-ch, storm-4d, nyc-taxi, drifters). Trigger = seek during playback (any), or a drag release whose last preview was throttled (~85–90 % of releases at pointer rate 60–120 Hz vs 10 Hz updates) landing in a bucket other than the last passed preview's.

**Consequence** On R2-class links: every timeline click during playback costs up to **8000 ms frozen in `seeking`**, then a `ready {degraded:true}` + creep; `degradedResumeCount` and `startupMs`/`stallCount` QoE counters are polluted. On the local dev server the 8 s is masked by the predictor and replaced by ≤100 ms of `buffering`/`playing` flapping (spurious stalls with ~0 ms duration). Neither is "seamless".

**Evidence** Code trace above; no other `tileset.update` caller exists (`grep -n "tileset.update(" spatiotemporal-layer.ts` → :1442, :1672 only; `_updateTileset` is reached from `updateState`/`_scheduleViewportSettle` only). `BufferSource` (governor :60-190) has no seek verb. The chassis tests never exercise a seek inside the throttle window (`chassis-lifecycle.test.ts:633-660` drives `_handleTimeUpdate` once). The measured scrub run in `measurements-2026-08.md §10.6` reports `settle 0 ms` — on a local server where the predictor masks this. The `TimeController.setTime` TEMP-DIAGNOSTIC `backjumps` probe (`time-controller.ts:126-146`, "flash repro") is consistent with the fast-link flapping variant being observed but not root-caused.

**Fix** Smallest sound change, in the layer: when the wall throttle blocks a tick whose `timeDelta` exceeds the seek threshold — or simpler, whenever it blocks at all while `!timeController.isPlaying()` (a `setTime` on a paused clock is by definition a seek/scrub) — arm a trailing `setTimeout(remainingMs)` that re-runs `_handleTimeUpdate(this._currentTime)` (mirror `_scheduleViewportSettle`; cancel in `_cancelPendingUpdates`). Also make the tick handler not require `|Δ| > 1` when the clock is paused, so `endScrub(sameValue)` can land the update. Blast radius: one chassis method; no test pins the blocked branch. (A governor-side alternative — a `BufferSource.noteSeek?(time)` hook — is larger and crosses the package boundary.)

**Confidence** High on mechanism (both sides read end-to-end, no compensating caller); medium on how often the 8 s hatch vs the predictor is what the user sees on R2 (throughput-dependent).

**How to verify** Chassis unit test (fake timers): play, `_handleTimeUpdate(t0)`; 40 ms later pause the controller and `setTime(t0 + 10 buckets)`; assert `tileset.update` was called with the new time within 100 ms — fails today. Browser: on `/demo/gtfs-ch` with CDP throttling ≈ 4 Mbit/s, click the timeline 10× during playback and read `__sttProbe.snapshots['playback.state'].degradedResumeCount` — expect it to climb by ~1 per click today, 0 after.

---

### G2 [medium] With the unauthored BH-4 band, the low-watermark min-gate degenerates to a MAX-gate for every bucket-coarse composite: a starved required laggard can never trip the watermark while any peer holds one bucket; stall protection falls to the frontier clamp (later, and without the predictor), and a laggard within one bucket of the leader is played through its missing bucket. The test that claims to guard this is vacuous.

**Where**

- `playback-governor.ts:2116-2131` `liftBandSimMs`: unauthored ⇒ `τ_i = max(Δ_i, Δ_L) + 200 ms × |speed|`.
- `playback-governor.ts:2916-2957` `checkLowWatermark` → `combinedRequiredRunway(time, dir, horizonSimMs = watermarkSimMs = 600 ms × |speed|, …)`.
- `spatiotemporal-tileset.ts:4433-4441` `getBufferedRunway`: `horizon = max(horizonSimMs ?? …, bucketMs)` and `:4517-4520` `simMs = min(reach − time, horizon)` — every source's reported runway is capped at `max(0.6 s × |speed|, Δ)`.
- `playback-governor.ts:2134-2210` fold, decisive line `:2194`: `effective = leadSimMs − simMs <= τ ? leadSimMs : simMs`.

**Mechanism** In the watermark probe, `lead ≤ max(0.6·s, Δ_L)` (the cap) while `τ_i ≥ Δ_L + 0.2·s`. Case Δ ≥ 0.6·s: `lead ≤ Δ < τ` ⇒ every incomplete source is lifted to the leader, unconditionally. Case Δ < 0.6·s: with `lag = 0`, `lead = 0.6·s`, lifted iff `0.6·s ≤ Δ + 0.2·s` ⇔ `Δ ≥ 0.4·s`. So whenever **one bucket lasts ≥ 0.4 wall-seconds of playback**, `checkLowWatermark` reports `min = lead` and cannot stall on a starved laggard. That is every shipped composite: storm-4d (Δ = 300 s vs 0.4 × 285 = 114 s), storm-radar (300 s vs 115 s), storm-3d-conus, the weather suite; a gtfs-style 1 h bucket at 157× (3600 s vs 63 s) trivially. Only fine-bucket sources (nyc-taxi 60 s vs 288 s) keep a working watermark — and nyc-taxi is single-source.
The gate path (`evaluateGate`, horizon 2 s/4 s × |speed| = 570 s/1140 s on storm-4d) is NOT blind (lead can exceed τ = 357 s), and the clamp path (`refreshFrontier`, default horizon `max(4×timeWindow, 10 s × speed)` = 2850 s) catches a laggard at 0 when the leader is > τ ahead — but (a) it fires only after the playhead has crossed the laggard's frontier (≤ 1 frame overrun, snapped back), (b) it never consults `predictsPlaythrough`, and (c) it charges the RESUME gate (4 s × |speed|). When the leader is ALSO within τ of the laggard (both near their frontiers — the normal state under load), nothing stops the clock: the laggard's overlay renders nothing for up to one full bucket (storm-4d: ~1 wall-s per event).

**Scenario** All multi-source demos (storm-4d ×2, storm-radar, storm-3d-conus, weather suite, bixi-live), under any load where the required overlays are not all comfortably ahead.

**Consequence** Overlay "pop" (warnings prism / wind3d / couplet vanish for a bucket then reappear) instead of an early hold; when the clamp does catch it, the stall lands with a backward snap and the 4 s resume gate rather than the sub-second predictor decision. The doc claim "absorbs jitter WITHOUT lowering the actual low-watermark stall protection" (`playback-and-loading.md` §5, `playback-governor.md` "Cadence tolerance band", governor :270-308) is false for coarse buckets.

**Evidence** Pure arithmetic from the two files. `playback-governor.test.ts:2805-2830` ("does not mask a genuine laggard between two FINE-bucket sources") passes ONLY because `makeCadenceSource` (`:2697-2720`) echoes `state.runwaySimMs` (100_000) regardless of `horizonSimMs` — the real tileset would report `min(100_000, max(6_000, 60_000)) = 60_000`, gap 59_000 ≤ τ 62_000 ⇒ lifted ⇒ no stall. The BH-4 "safety bound" property test (`:2907`) also uses horizon-blind mocks.

**Fix** Make the band aware of the probe horizon: lift only if `lead − lag ≤ τ` AND `lead < horizonSimMs` (a leader pinned at the cap carries no information about how far ahead it really is); or probe the watermark check at `max(watermarkSimMs, τ + watermarkSimMs)` so a leader can exceed τ; or cap `τ_i` at `horizonSimMs − watermarkSimMs`. Any of these is a ≤10-line change in `foldRequiredRunways`/`checkLowWatermark`. Also fix the mock to honour `horizonSimMs` (then the existing test turns red and pins the repair).

**Confidence** High (arithmetic); the visible-frequency claim is medium and needs measurement.

**How to verify** Unit: two required sources with a real horizon-capping mock, Δ = 300 s, speed 285, lead runway = cap, lag = 0 → expect `buffering` today it stays `playing`. Browser: on `/demo/storm-4d-greenfield` under throttling, count frames with `state==='playing'` where the warnings tileset's runway (`getSourceRunways()`) is 0.

---

### G3 [medium] The frontier clamp gates on a frontier that can be up to 200 ms stale and never re-probes before entering `buffering`; when the frontier bucket lands inside that window the clock takes a spurious 1-frame stall (with a backward snap of one frame × |speed|), and the RESUME gate — not the predictor — decides how long it lasts. This is the "micro-stutter at bucket edges when throughput ≈ demand" case, and the governor header's "never oscillates" promise does not hold for it.

**Where** `playback-governor.ts:896-929` (`tickHandler`: probe only when `now − lastFrontierProbeWall ≥ 200`; clamp uses the cached `bufferedUntil`; `enterGate('buffering', resumeFactor)` with no re-probe and no `predictsPlaythrough`); `:2546-2599` (`refreshFrontier` sets `bufferedUntil = time + runway.simMs` at the default horizon); `:2916-2957` (`checkLowWatermark` lets a thin runway sail when the one-window ETA ≤ `max(runwayWall, 250 ms)`); `time-controller.ts:126-146` (the `backjumps` "flash repro" diagnostic recording exactly these backward `setTime`s).

**Mechanism** Near a bucket edge E with bucket k+1 in flight, the watermark check passes via the predictor (ETA small). `bufferedUntil = E` is cached at the last probe. The bucket's last tile lands at `E − x` (0 < x < 200 ms wall) → no probe has seen it. The playhead crosses E → `overrun > 0`, ≤ `|speed| × 1000` → `setClockTime(E)` (backward jump of ≤ 1 frame × |speed|: 2.6 s sim on gtfs-ch, 4.8 s on storm-4d, 2.2 days on drifters) → `enterGate('buffering', 2)` → `pauseClock()` (layer: `setAnimationState(false)` → `selectAndLoadTiles()`) → `evaluateGate` with fresh probe → passes only if runway ≥ 4 s × |speed| (gtfs-ch: the just-landed hour ⇒ 3600 s ≥ 629 s, passes; nyc-taxi at 720×: needs 48 buckets ahead — the prefetch steady state is 32–64 buckets, so ~half the time this becomes a REAL 1–2 s stall caused only by probe staleness) → `playClock()`. Every occurrence: `stallCount++`, `waiting`/`ready` events, spinner flicker, an extra selection pass, a visible backward jump.

**Scenario** Playback on any link where buckets arrive just-in-time (throughput ≈ demand): gtfs-ch over R2 at 157× (1 edge / 23 s), storm-4d/storm-radar (1 edge / s), drifters (19 edges / s — here the window is essentially always open).

**Consequence** Bounded per-event (≤ 1 frame snap + ≤ 1 frame stall on coarse buckets), but periodic, and it inflates QoE `stallCount` so the CI "stallCount stays bounded" probe measures the wrong thing. On fine-bucket fast demos it escalates to genuine hysteresis stalls.

**Evidence** Code; `playback-governor.test.ts:234-250` pins the clamp with a STATIC runway (the frontier never moves between probe and clamp) — the moving-frontier case has no test. The `backjumps` diagnostic exists because backward jumps were observed in a flash repro (git `92dc0d1`).

**Fix** In `tickHandler`, before `setClockTime(frontier)`: call `refreshFrontier()` once (one probe, only on a crossing) and recompute the overrun; only gate if the playhead is still past the fresh frontier. Optionally consult `predictsPlaythrough` on the clamp path with the watermark window so the gate factor matches the watermark's decision. ~10 lines; the static-runway test still passes.

**Confidence** High on mechanism; medium on frequency (needs measurement).

**How to verify** Unit: play with runway 100_000; advance 150 ms wall; raise `state.runwaySimMs` to 200_000 WITHOUT `notifyBufferChange`; `tc.setTime(100_400)`; today: `buffering` + `stallCount 1`; after: stays `playing`. Browser: 5-min throttled run on `/demo/gtfs-ch`, count stalls whose `totalStallMs` delta < 20 ms and `__sttProbe.backjumps.length`.

---

### G4 [medium] Loop wraps on large archives always pay a start-gate stall: the prefetch planner is not loop-aware, so the loop start is never pre-warmed; `setLoopWindow` only protects tiles that happen to be resident.

**Where** `playback-governor.ts:942-960` (`wrapHandler`: `flushPrefetch()` on every source, `enterGate('seeking', 1)`); `spatiotemporal-tileset.ts:3305-3390` (`prefetchFutureTiles` plans `[time, time + horizon]` along `prefetch.direction` — no wrap; `loopRange` is read only by eviction, `:5362`); `prefetch-policy.ts` contains no loop/wrap handling (grep); `use-playback.ts:129` (`loop` defaults TRUE in every showcase demo).

**Mechanism** Approaching the range end, the planner's horizon runs past the dataset end into nothing. The wrap teleports the playhead to `range.start`; the loop-start bucket(s) are resident only if they survived eviction since lap 1 — impossible when the timeline's viewport tiles exceed `maxCacheSize` (nyc-taxi: 1440 buckets × ~100 keys ≫ 2000; gtfs-ch at z8: ~35 × 20–40 ≈ 700–1400, borderline; at z10+ no). The gate then requires `2 s × |speed|` of runway from the loop start: gtfs-ch 314 s sim (the whole first hour bucket), nyc-taxi 24 buckets, storm-4d 570 s (2 buckets) — a network round trip + transfer per lap.

**Scenario** Every looping large demo, every lap.

**Consequence** A `seeking` freeze of one gate-fill at every lap (typically 0.5–3 s on R2; up to 8 s + creep on slow links), with the spinner. Not seamless by construction; the API doc calls this "intended".

**Evidence** `playback-governor.test.ts:868-916` pins the two extremes (unbuffered ⇒ gate; fully-buffered ⇒ seamless) but the loader never makes the fully-buffered case true on large archives. `setLoopWindow` (tileset :2112-2123) is storage for eviction only.

**Fix** Loader-side: when `loopRange` is set and the planned horizon crosses `loopRange.end`, wrap the remainder to `[loopRange.start, …]` (the planner already produces bucket lists; this is a second segment). Governor-side no change. Blast radius: `prefetchFutureTiles` + `PrefetchPolicy.plan`; `prefetch-runway.test.ts` pins the current non-wrapping horizon and would need a loop case.

**Confidence** High.

**How to verify** `/demo/nyc-taxi-paths` and `/demo/gtfs-ch`, loop on, measure `seeking` duration per lap from the `playback` probe channel; expect > 0 today, ≈ 0 after (warm loop start).

---

### G5 [medium] M5/CO-3 (fluid feasibility, dispersion-scaled watermark) and CO-4 (auto-speed ladder) are unreachable from every shipped consumer — the governor is never given `getThroughput` or `baseSpeed`, so it always takes the incumbent one-window / single-point paths. The conformance doc counts them as landed.

**Where** `use-playback.ts:171` `new PlaybackGovernor(timeController)`; `StoryGlobe.tsx:338`; `HomeGlobe.tsx:88`; `stt-player.ts:150-153` (passes `options.governor ?? {}` — does NOT wire `baseSpeed: () => this._baseRate` despite governor :365-386 naming `SttPlayer.baseRate` as the intended supplier). Governor gates: `predictsPlaythroughFluid` :3047-3060 `rate === null ⇒ return null`; `conservativeRateBytesPerMs` :3139-3150 reads `this.getThroughput?.()`; `effectiveLowWatermarkWallMs` :1679-1700 via `getThroughputDispersionCv` :1657-1677 (`!estimate ⇒ 0`); `autoSpeedCandidates` :1869-1880 (`raw == null ⇒ null`).

**Mechanism** The tileset does expose `getThroughput` (adapter `tileset-adapter.ts:57`) and `getByteDensityProfile`, and `estimateTimeToReadyMs` works — but the governor's own `getThroughput` option is what the fluid check, the dispersion re-fit and the conservative rate consume, and nobody passes it. Result in the product: predictor = one-window (`:2980-3020`), watermark = flat 600 ms, auto-speed = single-point at the current speed.

**Scenario** All demos; the byte-cliff case the plan motivates (storm-4d cell entry, multi-source composites).

**Consequence** The "thin now, wall later" pass-through the fluid check exists to refuse still passes; Auto-speed still upshifts into a density spike it never priced. No stall is caused by this directly, but the shipped behaviour is not what `optimization-conformance-2026-08.md` §1 ("M5 CO-1…CO-7 **7/7** landed") and `optimization-implementation-plan-2026-08.md:247-287` describe.

**Evidence** `grep -rn "getThroughput\|baseSpeed:" packages/react/src examples/showcase/src packages/three/src packages/maplibre/src` → no governor option sites. 4751 lines of governor tests exercise these paths with explicit options.

**Fix** `use-playback.ts`: after `setSource`/`registerSource`, construct the governor with `getThroughput: () => tilesetRef.current?.getThroughput?.() ?? …` — but `BufferSource` has no throughput getter, so add an optional `getThroughputEstimate?()` to `BufferSource` (the tileset can forward `options.getThroughput`) and have the governor fall back to the required sources' max/aggregate when its own option is absent (the docstring's "aggregate" assumption already accepts one archive's estimator as the proxy). `SttPlayer`: pass `baseSpeed: () => this._baseRate`. Blast radius: small, additive; the `runwayToleranceMs`-style precedence (authored option wins) keeps tests bit-identical.

**Confidence** High.

**How to verify** Add a `playback.state` snapshot field `predictorPath: 'fluid' | 'one-window'` (or probe-emit it) and read it on `/demo/storm-4d-greenfield` — `'one-window'` today.

---

### G6 [low] `notifyBufferChange` → `evaluateNow` → `refreshFrontier` is unthrottled on the playing path, so N sources × ≤10 Hz buffer events cost O(N²) runway probes per second; the 200 ms throttle exists but only on the tick path.

**Where** `playback-governor.ts:1444-1462` (`notifyBufferChange` → `evaluateNow()`), `:2411-2425` (`evaluateNow`: playing ⇒ `refreshFrontier()` + `checkLowWatermark()`), `:2546-2560` (`refreshFrontier` → `probeAllRunways` = N × `getBufferedRunway` at the default horizon + fairness pass), `:2916-2947` (`checkLowWatermark` → N × `getBufferedRunway` at the watermark horizon). The gated path IS rate-limited (`applyMultiSourceFairness` :2670-2680 `lastFairnessSelfProbeWall`), the playing path is not; `lastFrontierProbeWall` (class field) is consulted only in `tickHandler` (:906-910).

**Mechanism / arithmetic** Each tileset throttles its own `onBufferChange` to 10 Hz (`:5208-5222`), but the governor sums them. storm-4d (N ≈ 10): ≤100 `evaluateNow`/s × 20 walks = ≤2,000 `getBufferedRunway`/s; each walk = `max(4×360 s, 10 s×285)/300 s ≈ 9.5` buckets × in-viewport keys (~10–20 at the primary zoom) ≈ 100–200 `Map.get` ⇒ 2–4 × 10⁵ lookups/s plus per-call allocations (`probeAllRunways` array, `foldRequiredRunways`, `computeFairnessWeights` sort of 10) ≈ 3–6 ms/s of main thread during load bursts — exactly when decode/upload also want it. gtfs-ch (N = 1): ≤10 × 2 walks × ~40–80 lookups — negligible.

**Scenario** Composites with many sources during tile bursts (storm-4d, weather suite).

**Consequence** Low: a few ms/s, no functional effect.

**Fix** In `evaluateNow`'s playing branch, skip `refreshFrontier()` if `nowWall() − lastFrontierProbeWall < TICK_PROBE_INTERVAL_MS` (keep `checkLowWatermark`, which is the honest part; the frontier only feeds the clamp). One line; the creep re-arm (:2588-2593) still runs on the next probe ≤200 ms later.

**Confidence** High on the count; the ms figure is an estimate (needs a CPU profile).

**How to verify** CPU profile on `/demo/storm-4d-greenfield` during the first 30 s, filter to `getBufferedRunway` self-time before/after.

---

### G7 [low] Readiness write-off holds exceed the escape hatch: one permanently-404 tile in the playhead bucket pins the runway for ~8–17 s; a stalled-origin (transfer-timeout) tile for ~6 min; the governor hatches at 8 s into creep, which then sits pinned at the same frontier with the UI reading `playing`.

**Where** `archive.ts:2305-2309` (any non-2xx ⇒ throw), `:2473-2540` (`fetchObjectRangeWithRetry`: every non-abort error retried over `DEFAULT_RANGE_RETRY_DELAYS_MS [250, 1000]` × jitter 0.5–1.5; `TimeoutError` is NOT an `AbortError` ⇒ retried), `:4408` ("Coalesced range failed after retries → per-member fallback" ⇒ a second 3-attempt ladder per tile), `spatiotemporal-tileset.ts:4102-4185` (`noteSettledWithoutTile`: `attempts++` only for non-aborts; `isFailed` at 3; cooldown 500·2^(n−1) ms; abort-only sessions written off at 8 settles), `:4400-4404` (`isCoverageReady` = loaded OR failed), governor `:2499-2503` (hatch), `:896-929` (creep clamp).

**Mechanism / arithmetic** 404: one settle = archive ladder (3 attempts, 0.4–1.9 s of delays + 3 RTT) + per-member fallback ladder (same) ≈ 2–5 s; three settles + cooldowns 0.5 + 1.0 s ⇒ **≈ 7.5–16.5 s** from first need to `isFailed`. Timeout (origin accepts and stalls): each attempt 20 s (`DEFAULT_TRANSFER_TIMEOUT_MS` :765), 6 attempts per settle ⇒ ~120 s per settle, `TimeoutError` charges `attempts` ⇒ 3 settles ≈ **~6 min**. In both cases the governor stalls at the watermark, hatches at 8 s, enters creep, and the clamp pins the playhead at the bucket edge for the remainder; `isCreeping` is the only signal. After write-off the bucket reads "ready" with the tile absent — the clock plays through the hole (by design; readiness ≠ presence). A missing PACK on R2 (all tiles of that pack 404) writes off every tile in it the same way; buckets then read ready with the pack's contribution blank.

**Scenario** Large archives on R2 with a missing/failed pack (the memory notes v1/v2 stems still on R2); any origin behind a stalling proxy.

**Consequence** Rare, but a multi-second (or multi-minute) freeze with no honest UI state after the first 8 s.

**Fix** Do not retry 404/410 in `fetchObjectRangeWithRetry` (classify 4xx as permanent; keep 5xx/timeouts retryable) — cuts a 404 settle to 1 RTT and the write-off to ~1.5 s + 3 RTT; and expose `isCreeping` in PlaybackControls (it already reads it, `:738`) as the explicit "waiting for a tile that will not arrive" state. Blast radius: `archive-retry.test.ts` pins the ladder count for transient errors; add a 404 case.

**Confidence** High on the ladders (read both); medium on the jitter-averaged totals.

**How to verify** `stt-serve` with one pack renamed; play `/demo/gtfs-ch` into the affected bucket; measure wall time from `waiting` to `getBufferedRunway().simMs > 0`.

---

### G8 [low] `requestPlay` before the tileset registers (embed visibility autoplay) can hatch into a source-less `playing`: the clock free-runs with no clamp until `onTilesetReady`, then pins wherever it got to.

**Where** `DemoEmbed.tsx:62-72` (IntersectionObserver `play()` on ≥40 % visibility), `use-playback.ts:166-176` (governor created in an effect; `tilesetRef` handed over later), `playback-governor.ts:2434-2503` (`hasAnySource()` false ⇒ `passed` stays false ⇒ hatch at 8 s), `:896-902` (`tickHandler` returns before any clamp when `!hasAnySource()`).

**Mechanism** If manifest + directory root + first `getAvailableTiles` take > `maxStartWaitMs` (8 s; HomeGlobe 4 s) on a cold slow link, the hatch fires with zero sources; the clock plays into the timeline unclamped; when `addSource` finally runs, `refreshFrontier` computes `bufferedUntil = now + 0` and creep pins THERE — the embed starts N seconds into the story, and `startupMs`/`degradedResumeCount` are polluted.

**Scenario** `/demos/:id` embeds and the home globe on slow cold links; gtfs-ch's paged directory root is 3 KB so this needs a genuinely slow link.

**Consequence** Low; cosmetic mis-start + QoE pollution.

**Fix** In `evaluateGate`, do not let the hatch fire while `sources.size === 0` AND a source is expected (e.g. `expectSource` flag set by `usePlayback` once a layer has been built), or re-base `gateStartedAtWall` in `addSource` when the state is `starting` and no source existed before.

**Confidence** Medium (needs a slow-link repro).

---

## Answers to the eight questions (with the trace)

**Q1 — one playback second on gtfs-ch (157×, 1 h buckets, N = 1, viewport z≈8 ⇒ ~20–40 keys per bucket).**

- Clock: deck `onBeforeRender` → `advanceFrame` → `_step` (60/s, 2.6 s sim per frame). Tick listeners: (a) layer `tickHandler` (60/s, O(1)) → `_handleTimeUpdate` → `tileset.update(skipDebounce)` at exactly 10/s (wall floor 100 ms; the sim threshold `timeWindow/20 = 1 s` is crossed every 6 ms) — that pass is the tileset's own selection/eviction/queue work and is O(resident tiles) for `evictUnusedTiles` (not the governor's cost); (b) governor `tickHandler` (60/s): every 200 ms `refreshFrontier` (1 × `getBufferedRunway(time, dir)` at horizon `max(4×20 s, 10 s×157)=1573 s` → floored to the 1 h bucket ⇒ walks 1–2 buckets ⇒ ~40–80 `Map.get`; `getTemporalBucketMs`; `foldRequiredRunways`; `applyMultiSourceFairness` ⇒ `sources.size < 2 ⇒ deactivateFairness()` O(1)) + `checkLowWatermark` (1 × `getBufferedRunway` at horizon `600×157=94 s` → floored to 1 h ⇒ same walk) ⇒ 5 × 2 = 10 walks/s; other 55 ticks/s: one subtraction and compare.
- Buffer events: each tile landing → tileset `notifyBufferChange()` (trailing throttle 100 ms) → `getBufferedRunway(viewport.time, prefetch.direction)` (1 walk) → layer `onBufferChange` → registry → `governor.notifyBufferChange` → `emit('progress')` (PlaybackControls `onProgress`, self-throttled 250 ms → `getBufferedRanges({maxRanges:64})` = O(35 buckets + ready keys, early-break per bucket) + `getSourceRunways` (1 walk)) → `evaluateNow` → `syncLoopWindows` (2 getters + 1 Map entry) + `refreshFrontier` (1 walk) + `checkLowWatermark` (1 walk) → `publishStateSnapshot` only with a probe bag. ≤10/s × 3 walks + 4/s × 2 = ~38 walks/s.
- UI: buffered bar 1 Hz poll (`getBufferedRanges` + `getSourceRunways`), HUD 2 Hz `getSourceRunways` only when expanded.
- Total ≈ 50 `getBufferedRunway` walks/s ≈ 2–4 k `Map.get`/s + ~5 `getBufferedRanges`/s. **Nothing on the governor path is O(resident tiles) or O(buckets × tiles) at 200 ms cadence**: `getBufferedRunway`/`estimateCost`/`getByteDensityProfile` are O(buckets in the probe horizon × in-viewport keys per bucket at the primary zoom); `getBufferedRanges` is O(all index buckets + ready keys) where ready keys ≤ `maxCacheSize` (2000) — bounded by the cache, not the archive. `predictsPlaythrough` (only when runway < watermark, i.e. the last 0.6 s before an edge) adds one `estimateCost` over 1–2 buckets; the fluid path never runs (G5). The only O(N²) term is G6 in composites.

**Q2 — stall semantics.** Freeze iff `!complete && simMs < effectiveLowWatermarkWallMs(=600 on a calm/blind link) × |speed|` sim-ms AND `predictsPlaythrough` (one-window: ETA of missing bytes in `[t, t+0.6 s×speed]` ≤ `max(runwayWall, 250 ms)`) is false (`:2916-2957`). Thresholds are wall-ms × |speed| ⇒ speed-scaled sim spans; a speed change re-evaluates (`playStateHandler` :852-880). Release: `evaluateGate` with `gateFactor = resumeFactor = 2` ⇒ runway ≥ 4 s × |speed| (gtfs-ch 629 s sim < 1 bucket ⇒ "the next bucket fully loaded"; nyc-taxi 48 buckets), or `complete`, or the predictor on the 4 s window, or 8 s hatch ⇒ creep. Hysteresis is 0.6 s → 4 s wall, so a bucket-quantized runway cannot oscillate through the watermark path (the next bucket lands ⇒ +1 bucket ≫ 4 s on coarse buckets). Oscillation exists only through the clamp path (G3) — and, in composites, the watermark itself is blind (G2). Rate modulation before a hard stall: none — no creep/rate-down precedes a stall; degraded creep is post-hatch only (`:2499-2520`, `setDegradedCreep` :2259), and Auto-speed is an opt-in UI mode (`use-playback.ts:330-358`, 5 s cadence + on `waiting`). Creep is reachable in every demo on any link where a gate fails to fill in 8 s (cold start, seek — G1, loop wrap — G4, 404 — G7); no dataset config enables/disables it; HomeGlobe shortens the hatch to 4 s.

**Q3 — frontier hold.** Yes: a bucket is ready only when EVERY coverage-index key at that bucket is `isLoaded || isFailed` (`:4485-4495`), so one in-flight viewport-edge tile pins `bufferedUntil` at the bucket's start; the clock stalls 0.6 s before it (single source) or via the clamp (composites, G2). Partially-loaded buckets never count. `isCoverageReady` (`:4400-4404`) treats a written-off tile as ready — readiness is monotone by design so the ladder's retries cannot re-stall the clock once per backoff. `FAILED_TILE_READINESS_WRITEOFF_SETTLES = 8` (`:376`) is the abort-only bound (aborts never charge `attempts`); a 404 is charged and writes off at 3. Worst-case holds: 404 ≈ 7.5–16.5 s, stalled origin ≈ 6 min, abort-only transport ≈ 8 settles × transfer time + 123.5 s of backoff (G7). Missing pack on R2 ⇒ every member tile follows the 404 path in parallel ⇒ same ~8–17 s, then the bucket plays with the pack's content absent.

**Q4 — small datasets.** lines-v2: 492 tiles ≤ `maxCacheSize`, 49 buckets, all resident after the first pass ⇒ `getBufferedRunway` reaches the dataset end ⇒ `complete: true` ⇒ never gates again; cold start needs the start gate = 4.2e9 sim-ms = 1.6 buckets (one coalesced batch). storm-tracks / storm4d-reports / storm4d-sounding: same shape; in storm-4d they read `complete` almost immediately and drop out of the min/lead (`:2207-2213`). `getAutoSpeedSuggestion` ⇒ `sumTiles === 0 ⇒ Infinity` (`:1928`), consumer clamps to 10× (`auto-speed.ts:151`); `estimateCost` ⇒ `{0,0}`. The 5 Hz probe + 60 Hz clamp compare keep running while playing (two ≤9-bucket walks of a few keys — sub-microsecond) and stop on pause (`stopEvalTimer` + no ticks); there is no idle timer. No `>1 bucket` assumption found: `getBufferedRunway` floors the horizon at one bucket (`:4438-4441`), `frontierByteDensity` keys per bucket, the fold handles N = 1. One observation: an archive with `temporal_bucket_ms = 0` reads every bucket as `b + 0 <= spanStart ⇒ continue` (`:4478`) ⇒ always complete ⇒ gating silently off (none in the local fleet). The large-dataset machinery that DOES run for tiny archives is the coverage-index build (one full-range `getAvailableTiles`, trivial on a 5 KB directory) and the overview preload (z0–1 pinned; ≤20 MiB).

**Q5 — seek/scrub.** Sequence for `seekTo(T)`: `commitSeek` ⇒ `flushPrefetch()` on all sources (queued + in-flight PREFETCH aborted, priority untouched, `:4752-4815`) ⇒ `pauseClock` (layer: `setAnimationState(false)` ⇒ `selectAndLoadTiles()` at the OLD time) ⇒ `setTime(T)` (layer tick ⇒ `tileset.update(T)` IF the 100 ms wall throttle is open — G1) ⇒ `enterGate('seeking', 1)` ⇒ `setAnimationState(true, speed)` ⇒ `schedulePrefetch` ⇒ `evaluateGate` (+250 ms timer). When the update does run: tileset seek detection (`|Δ| > max(timeWindow, speed×1 s)`, `:2533-2538`) ⇒ second `flushPrefetch` ⇒ selection ⇒ priority batch for the bucket at T at the primary zoom plus up to 4 coarser parents (`best-available`) — there is no coarse-FIRST ladder in the governor; "coarse first" is whatever the pinned overview tier (z0–1, ≤20 MiB budget, `:4840+`) and resident parents provide, and the render shows them immediately while the CLOCK stays frozen until the PRIMARY-zoom bucket (and enough of the next) is ready (gate = 2 s × |speed|: gtfs-ch 314 s sim ⇒ the current hour; nyc-taxi 24 buckets). Time-to-first-frame ≈ directory page fetch for the new bucket (paged, 137 pages on gtfs-ch) + one coalesced range batch + worker decode ⇒ ~2–3 RTT + transfer; clock resume ≈ full bucket transfer, or ≤250 ms-ETA predictor pass. Scrub at 60 Hz: `PlaybackControls.tsx:629-640` re-arms one 200 ms settle timer per input (correct debounce ⇒ exactly one `seekTo` after the thumb rests, and `endScrub` on the same value skips the second commit, governor `:1337-1375`). Previews are NOT fetch-free (doc drift): each preview that passes the layer throttle (≤10 Hz) runs `tileset.update` ⇒ priority fetches, superseded by the next (`cancelSupersededRequests` `:4319`), measured at 0.3–2.2 MiB/drag in `measurements-2026-08.md §10.6`.

**Q6 — multi-source.** Gate = N × `getBufferedRunway` per probe, folded (`:2084-2100`, `:2134-2210`); `getBufferedRanges` intersection (`:1544-1570`, O(N × ranges)) is called only by the buffered bar (≤4 Hz) and the scrub QoE probe per preview (`:1423-1430` — bounded by `maxCacheSize` ready keys) — not on the gate path. Optional (`required:false`) sources: never fold into the gate, but receive `setAnimationState(true)` keep-alive and the run-ahead cap (`:2715-2750`); they keep base weight 1 while required contenders are re-weighted 0.25–4× base (`fairness.ts:117-160`) — so an optional overlay BEHIND the laggard competes at base share (not starved, not shed); the required laggard gets 4× base. In the showcase every overlay is required (`overlayGatesPlayback ?? true`). The run-ahead cap is released on: laggard removal / <2 sources (`removeSource` :1139-1190), pause (`:1267-1290`), external pause (`:852-870`), all-complete or kill switch (`applyMultiSourceFairness` :2657-2665, :2700-2705), `setSource`/`dispose`, and when a capped source becomes the laggard (`sendRunAheadCap(null)` :2837-2845). The cap only binds above the policy's own floor `max(Δ, timeWindow, 5 s × speed)` (`prefetch-policy.ts:96-101`) ⇒ on storm-4d leaders may still run ~5 buckets ahead. Cost: the β `estimateCost` walk is memoized per (frontier bucket, Δ) (`:2808-2835`) — one directory walk per source per bucket crossing.

**Q7 — TimeController.** `_step` advances `min(elapsed, 250 ms) × |speed| × direction` per host frame (`time-controller.ts:353-365`); no bucket awareness. Buckets per 60 fps frame: storm-4d 4.8 s sim / 300 s = 0.016 (63 frames per bucket); gtfs-ch 2.6 s / 3600 s (1,370 frames); satellites 24 s / 300 s (12.5 frames); lines-v2 0.4 d / 30 d (74 frames); **drifters 2.2 d / 7 d = 0.32 (3.2 frames per weekly bucket at 60 fps, 1.6 at 30 fps, and a single 250 ms hitch skips 4.7 buckets that are never rendered)**. `toleranceSimMs = runwayToleranceMs × |speed|` (`:2055`) and the BH-4 residue `200 ms × |speed|` (`:2130`) both scale with speed; so do all gates. The governor never checks that a bucket was drawn — it only guarantees the bucket at the playhead is resident at ≥5 Hz — so at drifters-class speeds the clock does skip loaded buckets on every dropped frame (a frame-paced/bucket-quantized clock would be a design change; noted, not filed).

**Q8 — tests.** Pinned (`playback-governor.test.ts`): start gate/complete/notifyBufferChange/hatch (:121-185); watermark + resume hysteresis with scripted runways (:186-220); clamp with a static frontier (:234-250); external-seek exemption (:252); clock-only stall (:264); creep + re-arm (:281-331); backward clamp (:332); sticky pause (:348); scrub preview/commit, settle-commit, hatch suspension under a held thumb (:368-540); interactive bit (:541-698); loop wrap ⇒ plain gate / seamless when buffered (:844-916); ended/replay (:919-1000); QoE (:1001-1100); N-source min/AND/optional/zero-required, ETA/cost/auto-speed contention, broadcasts, `getSourceRunways`, `getBufferedRanges` intersection (:1103-1795); cold-start N-source (:1797-1870); Phase-1 band + BH-4 band (:1872-2020, :2694-3000); fairness caps/weights/throttle/hysteresis/deactivation (:2021-2340, :2340-2690); loop-window plumbing (:3002-3160); scrub QoE (:3164-3470); state snapshot (:3474-3720); fluid check (:3729-4010); jitter re-fit shape (:4015-4165); calm-link parity pin (:4169-4450); ladder (:4454-4725); dispose (:4741). `time-controller.test.ts`: tick math, loop/bounce/ended, throttle, 250 ms clamp, visibility re-anchor, wrap listeners, re-entrancy. `external-clock.test.ts`: advanceFrame semantics incl. wrap. `auto-speed.test.ts`: policy + dispersion. `stt-player.test.ts`: facade routing, timeupdate throttle, ended/replay, multiplier conversion.
Vacuous/misleading: BH-4 "does not mask a genuine laggard" (:2805) and the BH-4 property test (:2907) — mocks ignore `horizonSimMs` (G2). The "clamps an overrun playhead" test (:234) uses a frontier that never moves between probe and clamp (G3 untested). Every stall test scripts `runwaySimMs` directly — no test derives a runway from bucket edges on a wall clock, so bucket-quantized hysteresis/oscillation is untested. Untested entirely: seek/endScrub against a real layer throttle (G1 — cross-package); loop wrap against a loader that must fetch the loop start (G4); `evaluateNow` fan-in cost (G6); source-less hatch then late `addSource` (G8); `syncLoopWindows` under `bounce` (documented gap, :2353-2365); the predictor→clamp interplay; `setAnimationState` ordering across the layer's playState listener; degraded creep at a bucket-quantized frontier (creep "advances at data-arrival rate" is really "jumps one bucket at a time").

---

## Checked and correct

- Gate thresholds are wall-ms × |speed| everywhere; `effectiveLowWatermarkWallMs` can never climb into the start gate (`playback-governor.ts:1679-1700`, `WATERMARK_GATE_HEADROOM` :603).
- `requestPause` clears intent, timers, creep, frontier, broadcasts `setAnimationState(false)` and deactivates fairness (`:1267-1290`); a pause during a gate sticks (test :348).
- `commitSeek` pauses BEFORE `setTime`, nulls the frontier and creep, flushes every source (`:2283-2305`); `endScrub` on the settle-committed position re-bases the hatch clock instead of re-committing (`:1337-1375`).
- Frontier clamp refuses overruns > 1 s × |speed| (external seeks) (`:919-923`); `MAX_FRAME_DELTA_MS = 250` (`time-controller.ts:59`) guarantees a real frame can never be misclassified.
- Wrap routes through `seeking` at the PLAIN gate, pushes the loop window first (`:942-960`); `play()` re-entrancy guard prevents a second rAF loop (`time-controller.ts:243-247`).
- External-driver mode (`useDeckClock`): single frame clock, `advanceFrame` no-ops while paused, re-anchors on attach/detach (`time-controller.ts:255-300`).
- Timers: eval timer only while gated (`:3165-3175`), tick probe throttled to 200 ms, nothing runs when idle.
- `enterGate` ordering: `pauseClock()` (layer sets animating=false) precedes the governor's `setAnimationState(true, speed)` broadcast, so the loader ends up animating-at-speed during the gate (`:2307-2320`); `evaluateGate` clears `bufferedUntil` on pass so a stale frontier cannot clamp a fresh resume (`:2506-2512`).
- Tileset `update()` ignores zero sim-deltas for speed estimation so a frozen gate does not collapse the prefetch span (`spatiotemporal-tileset.ts:2545-2552`).
- `getBufferedRunway`/`estimateCost`/`getByteDensityProfile` share one bucket-intersection rule and are bounded by the probe horizon (`:4429-4670`); `getBufferedRanges` early-breaks per bucket so its cost is bounded by `maxCacheSize` (`:4531-4570`).
- Coverage-index tiles are exempt from the wall-clock grace eviction, so "buffered" cannot evaporate while paused (`:5257-5268`); write-off is monotone (`:4400-4404`) and advances the runway via `notifyBufferChange` (`:4152, :4177`).
- β memo per (bucket, Δ) (`:2808-2835`); cap/weight writes throttled at 20 % with laggard-identity hysteresis (`:2715-2750`, `:2837-2880`); `addSource` on an existing id drops its memos (`:1088-1125`); `removeSource` clears caps/weights/loop window on the way out (`:1139-1190`); `dispose` stands everything down (`:1998-2030`).
- `getAutoSpeedSuggestion`: contended aggregate rate, `Infinity` only when all required sources are clear, `null` when bytes/ETA-blind (`:1798-1960`); consumer policy asymmetric and clamped (`auto-speed.ts:123-160`).
- `getSourceRunways` is a pure read (`:1602-1625`); HUD polls it at 2 Hz only when expanded (`PerformanceMonitor.tsx:101-113`).
- `PlaybackControls` settle debounce re-arms per input at `seekSettleMs` and clears on release (`:629-660`); keyboard seeks debounce the same way (`:606-616`).
- `SttPlayer` never drives the controller directly; `timeupdate` throttled to 4 Hz with immediate emit on freeze/seek (`stt-player.ts:392-425`).
- `foldRequiredRunways` with zero required sources reports complete/unbounded (optional-only compositions free-run) (`:2140-2150`).

## Doc ↔ code drift

1. `docs/roadmap/playback-and-loading.md` §6.1 "Dynamic weights — `base × clamp((slack + laggard)/(slack + runway_i), 0.25, 4)`": the shipped default is the BH-3 progressive fill by byte need (`fairness.ts:117-160`, `USE_PROGRESSIVE_FILL_WEIGHTS = true` at governor :625); the 1/x shed is the retained fallback.
2. `playback-and-loading.md` §5 and `docs/api/playback-governor.md` ("Constructor" table row and "Cadence tolerance band"): "`runwayToleranceMs` default 200 (the tick-probe interval)". Unauthored, the band is the per-source BH-4 derivation `τ_i = max(Δ_i, Δ_L) + 200 ms × |speed|` (governor :2116-2131); 200 ms is only the residue. Both docs also claim the band absorbs jitter "without lowering genuine stall protection" — false for bucket-coarse composites (G2).
3. Governor `scrubTo` docstring (:1326-1329, "no tileset update storm, no fetches") and `docs/api/stt-player.md` ("previews are free"): the layer's tick path updates the tileset at ≤10 Hz during previews and issues priority fetches (`spatiotemporal-layer.ts:1410-1442`; measured 0.3–2.2 MiB per drag, `measurements-2026-08.md §10.6`). What is true: no PREFETCH flush per preview.
4. `docs/roadmap/optimization-conformance-2026-08.md` §1 "M5 CO-1…CO-7 **7/7** landed" and `optimization-implementation-plan-2026-08.md:247-287`: CO-3's fluid check + dispersion re-fit and CO-4's ladder are unreachable from every shipped consumer (G5). Governor :365-386 says `baseSpeed` "i.e. `SttPlayer.baseRate`" — `SttPlayer` does not pass it (`stt-player.ts:150-153`).
5. Governor header (:9-16) and `playback-governor.md` "Gates and hysteresis": "resume hysteresis so stall/resume never oscillates" — the clamp path can oscillate 1-frame stalls (G3); "Low watermark … tick-driven (every ~200 ms)" — it is also event-driven, unthrottled, on every buffer change (G6).
6. `playback-governor.md` "Loop wraps": "A wrap into fully-cached time passes the gate synchronously, so seamless loops stay seamless" — true of the governor, never true of the loader on large archives (G4); the doc should say every lap on a large archive gates.
7. `BufferSource.setPrefetchRunAheadLimit` docstring (governor :128-142) says the loader "may enforce its own internal safety floor" — the floor `max(Δ, timeWindow, 5 s × speed)` (`prefetch-policy.ts:96-101`) exceeds the cap `laggard + 3 s × speed` whenever the laggard is < 2 s × speed ahead, i.e. the cap is inert in exactly the starved case it targets. (Documented behaviour, but the doc's "Shaka caps ~1 segment past the neediest" framing overstates what ships.)
8. `playback-and-loading.md` §3 says stall detection is "tick-driven every ~200 ms" and the API doc says `runwayToleranceMs` "ties to TICK_PROBE_INTERVAL_MS" — consistent with code; no drift.

## Needs measurement

1. **G1 on R2.** `/demo/gtfs-ch`, CDP throttle ≈ 4 Mbit/s, 10 timeline clicks during playback: wall time from `waiting{state:'seeking'}` to `ready`, and `degradedResumeCount`. Expect ≈ 8000 ms and +1 per click today; fast local server: count `buffering`/`playing` transitions within 120 ms of each click.
2. **G3 frequency.** 5-min run on `/demo/gtfs-ch` and `/demo/storm-radar` at throughput ≈ demand: number of stalls with `totalStallMs` delta < 20 ms, and `__sttProbe.backjumps` length/magnitudes.
3. **G2 visibility.** `/demo/storm-4d-greenfield` throttled: per frame, `state === 'playing'` while any required source's `getSourceRunways()[i].runwaySimMs === 0` — count and duration.
4. **G4 per-lap cost.** `seeking` duration at each wrap on `/demo/nyc-taxi-paths` and `/demo/gtfs-ch` (loop on).
5. **G6 CPU.** Chrome profile of the first 30 s of `/demo/storm-4d-greenfield`, self-time of `getBufferedRunway` + `probeAllRunways`.
6. **Seek time-to-first-frame** on gtfs-ch over R2 (directory page + batch + decode) vs time-to-clock-resume, to size whether a coarse-first fetch order would help the scrub UX.
7. **Overview tier budget** for gtfs-ch (`preloadOverviewTier` result: z6–7 × 35 buckets vs 20 MiB) — determines whether any preview exists during a far seek.
8. **Drifters frame pacing**: fraction of weekly buckets that receive zero rendered frames at 30/60 fps (Q7), to decide whether a bucket-paced clock is worth a design item.

---

# Appendix 4 — audit-cache-eviction

## Audit — CACHES, EVICTION and MEMORY (2026-08-24)

Scope: decoded tile cache (`packages/core/src/spatiotemporal-tileset.ts`), compressed byte cache
and OPFS (`packages/core/src/archive.ts`, `opfs-cache.ts`), hoisted-category residency
(`packages/core/src/tile.ts`, worker path), showcase per-archive split
(`examples/showcase/src/components/demo/buildDemoLayers.ts`), layer-side release (deck / three /
maplibre). Everything below was read end-to-end in code; numbers come from three scratchpad scripts
(`pin-count.mjs`, `bytesize-structural.mjs`, `evict-bench.mjs`, `cat-identity.mjs`, `sat-z3.mjs`)
run against the local archives through the dev server, and two Playwright runs
(`probe-evict.mjs`) against `/demo/hurricanes` and `/demo/nyc-taxi-paths`.

## Findings

### CE-1 [critical] The overview pin set has no COUNT gate, pins count against `maxCacheSize`, so `hurricanes` / `earthquakes-v2` run permanently over the cap and evict their whole runway every frame

**Where**

- `packages/core/src/spatiotemporal-tileset.ts:4917-4945` (`startOverviewPreload`: the only gate is
  `bytes > budgetBytes`, bytes = `Σ getTileByteSize` = COMPRESSED directory length);
  `:4956-4965` (`header.isPinned = true`, enqueued);
- `:3963-3966` / `:3821-3825` (`deliverTile` — every loaded tile, pinned or not, does
  `this.currentCacheBytes += byteSize; this.loadedTileCount++`);
- `:5248-5249` (`overSizeLimit = loadedCount > maxCacheSize`), `:5270-5280` (pinned excluded from
  candidates), `:5457-5475` (the plan loop evicts until `!stillOverSize && !stillOverBytes`, which
  can never become true when pinned alone > cap);
- `:5042-5070` (`finishOverviewLoad` only WARNS once);
- `examples/showcase/src/components/demo/DemoViewer.tsx:324` (`overviewPreload: true` for every
  demo) → `buildDemoLayers.ts:639`; `packages/layers/src/layers/spatiotemporal-layer.ts:2192-2198`.
- Constants `:451` `DEFAULT_OVERVIEW_BUDGET_BYTES` 20 MiB, `:454` `DEFAULT_OVERVIEW_MAX_ZOOM` 1,
  `:1330` `maxCacheSize` 2000.

**Mechanism** The byte gate is the only gate, and it is denominated in compressed bytes. At z0–z1
over the FULL time range a dataset with many temporal buckets has thousands of tiny tiles: they pass
the 20 MiB byte gate and get pinned. Pinned headers are exempt from eviction but still counted in
`loadedTileCount`, so once pins > 2000 the cache is over `maxCacheSize` forever. From then on every
`selectAndLoadTiles()` pass (every frame during playback — `selectKey` at `:2907-2909` includes the
exact `timeRange`, so no dedupe while the clock moves) takes the over-limit branch, builds and sorts
the candidate list, and evicts EVERY loaded tile that is not currently needed and not pinned —
tiers A, B, C and D alike, because the stop condition is never met. Tier D ("the near-playhead
protected window") is not protected. Each pass reaching C/D calls `prefetch.noteRunwayEviction()`
(`:5488`), so `prefetchPressureScale` sits at its 0.25 floor permanently; but the gate floor
(CE-2) keeps the horizon ≥ `speed × 5 s`, so the prefetch keeps re-enqueueing what was just evicted.

**Scenario** Large / playback. Any archive whose z0–z1 tile count over the full range exceeds
`maxCacheSize` (2000 single archive; `max(600, ⌊2000/N⌋)` in composites) while its compressed
z0–z1 bytes stay under 20 MiB. Measured over the local directories (`pin-count.mjs`, same
`getTileIdsInBounds(WORLD, z, fullRange)` call `startOverviewPreload` makes):

| archive                  | z0 tiles | z1 tiles | pin tiles  | pin MiB (compressed) | gate result      | vs cap 2000 |
| ------------------------ | -------- | -------- | ---------- | -------------------- | ---------------- | ----------- |
| hurricanes               | 8,949    | 8,950    | **17,899** | 10.02                | accepted         | **8.9×**    |
| earthquakes-v2           | 1,822    | 7,105    | **8,927**  | 10.86                | accepted         | **4.5×**    |
| earthquakes (350k tiles) | 22,893   | 29,544   | 52,437     | 25.88                | rejected (bytes) | —           |
| drifters                 | 2,281    | 8,437    | 10,718     | 909                  | rejected         | —           |
| satellites               | 288      | 1,152    | 1,440      | 770                  | rejected         | —           |
| ais-all-us               | 24       | 48       | 72         | 46.9                 | rejected         | —           |

Note the inversion: the gate accepts the two datasets where pinning is ruinous (count) and rejects
`ais-all-us`, whose 72-tile overview would be harmless in count.

**Consequence** Browser-measured on `/demo/hurricanes` (Playwright, `probe-evict.mjs`, 35 s settle,
24 s of play):

- cold: `tileset.stats.tileCount` 18,206 after the pin; console
  `[Tileset] Pinned overview tier (17899 tiles, 24194758 bytes) alone exceeds the cache limits
(maxCacheSize=2000 …)` (the once-only warning at `:5064`);
- play: **19,831 evictions in 24 s = 826/s**, tiers c 13,477 / d 6,354 (ZERO tier A/B — every
  eviction reaches into the runway or the protected window); cumulative `runwayEvictions` 37,587 of
  37,804; `prefetchPressureScale` 0.25 (floor);
- **168 pack range responses / 39.1 MB in 24 s** for an archive whose packs total 29.9 MB — the
  archive is re-downloaded ~1.3× per 24 s of playback; `archive.stats.hitRate` 0.188 (the compressed
  cache only hits BECAUSE of the thrash), `archive.stats.evictions` 44,726;
- `tileset.stats.hitRate` reads 0.99 throughout — it counts needed-and-resident per pass, not
  fetch avoidance, so it hides the loop.
  Node replay (`evict-bench.mjs`, hurricanes-shaped directory, 240 frames): pins over cap →
  23,718 runway evictions, pressure 0.25; control with `maxCacheSize` 30,000 (pins fit) → 0 runway
  evictions, pressure 1.0. Same code, only the cap differs.

**Evidence** The scripts and probe output are in the scratchpad; `overview-preload.test.ts:173-191`
("pinned tiles survive eviction pressure (over maxCacheSize) and warn once") constructs exactly this
state (40 pins, cap 10) and asserts the churn is evicted and a warning fires — i.e. the test PINS
the pathology rather than a cap. `getCacheStats()` (`:6101-6116`, interface `TilesetCacheStats`)
exposes no `pinnedCount`, so the "one-line measurement" in `docs/roadmap/tile-loading-3d-2026-07.md`
§8 cannot be run as written.

**Fix (smallest sound)** Two changes, both in `spatiotemporal-tileset.ts`:

1. `startOverviewPreload` gates on COUNT as well as bytes: reject with
   `reason: 'over-budget'` (add `'over-count'`) when `candidates.length > OVERVIEW_MAX_TILE_FRACTION ×
this.options.maxCacheSize` (¼ is a sane default: the storyboard must never own more than a quarter
   of the working set). Hurricanes/earthquakes-v2 then lose the storyboard (8,949 z0 tiles alone
   exceed 500), which is correct — a storyboard of 17,899 tiles is not "tiny".
2. Make pinned residency ADDITIVE to the cache limits instead of consuming them: track
   `pinnedLoadedCount`/`pinnedBytes` incrementally (increment in `deliverTile` when
   `header.isPinned`, decrement in `evictTiles`/`clear`) and compare
   `loadedCount − pinnedCount > maxCacheSize` / `cacheBytes − pinnedBytes > maxCacheByteSize` at
   `:5248-5249` and `:5460-5461`. Expose both in `getCacheStats()`.
   Blast radius: `overview-preload.test.ts:173` must be rewritten (its assertion is the bug);
   `eviction-*.test.ts` unaffected (they don't pin). Showcase: add `overviewPreload:
{ maxZoom: 0 }` is NOT enough for hurricanes (8,949 > 500) — accept the rejection.

**Confidence** High — reproduced in the browser on the shipped demo, in Node with the real
directory counts, and the mechanism is pinned by an existing test.

**How to verify** A test that pins N > maxCacheSize tiles, then plays 10 buckets with prefetch on,
and asserts `getCacheStats().runwayEvictions === 0` and `prefetchPressureScale === 1` fails today
(23k runway evictions) and passes after (2). Browser: `probe-evict.mjs` on `/demo/hurricanes` must
show tier c/d evictions ≈ 0 during play and pack bytes per 24 s ≪ 30 MB.

### CE-2 [high] At high sim-speeds the prefetch "gate floor" (`speed × 5 s`) exceeds the cache cap, the ladder is forbidden to cut below it, and the per-pass enqueue budget ignores what is already resident — a second, pin-independent evict/refetch loop

**Where**

- `packages/core/src/prefetch-policy.ts:722-727` (`gateFloor = max(bucketMs, timeWindow,
speed × PREFETCH_CAP_FLOOR_REAL_MS)`; `PREFETCH_CAP_FLOOR_REAL_MS` = 5000 at `:75`);
  `:745-749` (feasibility solve clamped to `gateFloor`); `:779-781` (ladder: `max(effectiveAhead ×
pressure, gateFloor)`);
- `:enqueueBudget()` (shown at the `PREFETCH_CACHE_FRACTION` site): `max(64, ⌊maxCacheSize × 0.5⌋)`
  NEW tiles per pass — never `maxCacheSize − resident`;
- `spatiotemporal-tileset.ts:3446-3452` (budgets applied), `:5305-5340` (tier C = coverage tiles
  `ahead > max(timeWindow, 2×bucketMs)`, furthest first).
- Showcase speed: `examples/showcase/src/types.ts:1844-1856` (`prefetchAhead = max(window,
speed × 5 s)`), `datasets.ts` `targetPlaybackSeconds`.

**Mechanism** `gateFloor` is meant to keep the horizon at least as long as the governor's
speed-scaled wall-clock gate consumes. It is a floor on SIM-TIME, with no relation to how many
tiles that span addresses. When `(gateFloor / bucketMs) × tilesPerBucketInView > maxCacheSize −
needed`, the prefetch enqueues up to 1000 tiles per pass into a cache that cannot hold them, tier C
evicts the far end, the pressure ladder decays to 0.25 but `max(…, gateFloor)` restores the same
horizon, and the next pass (re-issued when the head has consumed half the span, `:786-789`)
re-enqueues the evicted buckets. The enqueue budget is a per-pass constant, so residency never
back-pressures the plan; only eviction does, after the fact.

**Scenario** Playback of whole-range-in-a-minute demos:

- `nyc-taxi-paths`: 142,985 s of sim in 60 s = **2,383×**; gateFloor = 2,383 × 5 s = 3.3 h =
  **199 one-minute buckets**; a 1440×900 z14 viewport is ~12 cells → ~2,400 tiles per horizon vs
  cap 2000 (1000 with the heads overlay, N=2).
- `hurricanes`: 1,843,560× → gateFloor 106.7 days = 2,561 hourly buckets (on top of CE-1).
- `earthquake-activity` (earthquakes-v2): 2.63M× with 1-day buckets → 152 buckets × ~16 world
  cells at z2 ≈ 2,400 tiles (on top of CE-1's 8,927 pins).
- Not affected: `gtfs-ch` 157× → 786 s < one 1-h bucket → floor = 1 bucket; `storm-4d` 288×;
  `flights` 1,440× → 2 h = 6 buckets × ~20 cells = 120 tiles.

**Consequence** Browser, `/demo/nyc-taxi-paths` (no pins: minZoom 10 > overview maxZoom 1 →
`reason: 'no-tiles'`), 24 s of play: **21,068 evictions = 878/s** — tier b 10,948 (fine, back
buffer) but **tier c 10,119** (runway); cumulative c 13,777; `prefetchPressureScale` 0.25;
`tileCount` 2,478 over a 2000 cap; `archive.stats.hitRate` 0.031; **139 pack responses / 1,177 MB
in 24 s (49 MB/s)** against ~4–6 MB/s of genuinely new tiles at that speed (40 buckets/s × ~12
cells × 7.7 KB). Part of that amplification is the known 2 MiB coalescing gap (not re-reported);
the tier-C churn is the part this finding owns. Node replay without pins, hurricanes shape:
20,772 runway evictions / 240 frames at 1.84M×; still 10,952 at 36k×, because the 14-day window ×
parents already fills the cap in the synthetic directory (density caveat noted in "Needs
measurement").

**Evidence** Code path read end-to-end; `eviction-playhead-tiers.test.ts:263-326` pins the ladder
reaching 0.25 but never asserts the loop terminates; the floor comment at `prefetch-policy.ts:716-721`
says the floor exists so the source "deadlocks at the start-wait rather than degrading" — it chose
deadlock-avoidance over cache feasibility and got permanent thrash instead.

**Fix** Make the cache the hard ceiling and let the governor (not the loader) absorb the deficit:
(a) `enqueueBudget` = `max(0, ⌊maxCacheSize × 0.5⌋ − residentPrefetchedCount)` where
`residentPrefetchedCount` = loaded tiles in coverage but not needed (the tileset already
classifies these for tiers B/C); (b) in `plan()`, when the feasibility solve or the ladder is
clamped BY `gateFloor` and the last pass reported tier-C evictions, cap `effectiveAhead` at the
largest bucket-aligned horizon whose tile count fits `maxCacheSize − needed` (the coverage index
already has per-bucket counts) and surface it as a `horizonInfeasible` flag the governor can turn
into auto-speed reduction (it already has `AUTO_SPEED_HORIZON_WALL_MS`, `playback-governor.ts:567`).
Blast radius: `prefetch-*.test.ts` horizon literals under pressure; the governor gate tests.

**Confidence** Medium-high: the browser numbers are real, the arithmetic is from constants, but
the split of the 1.18 GB between coalescing amplification and refetch is not isolated (see Needs
measurement), and the flow-riders memory shows an overlapping fix already landed for the overlay.

**How to verify** `probe-evict.mjs` on `/demo/nyc-taxi-paths`: tier-c evictions per second must
drop from ~420 to ≈0 and pack bytes per 24 s must approach the unique-tile volume. A unit test:
directory with 40 cells/bucket, speed such that gateFloor = 100 buckets, cap 2000, 200 update()
frames → assert `runwayEvictions === 0` (fails today).

### CE-3 [high] The M2 hoisted-category identity fix is inert on the production (worker) decode path: every tile still lands on the main thread with its own `string[]` copy

**Where**

- `packages/core/src/tile.ts:196-301` (`hoistedCategoryCaches` is a `WeakMap<TemplateRegistry, …>`;
  `sharedCategoryTable` returns the SAME `string[]` per `${templateHash} ${column}`);
- `packages/core/src/tile-decoder.worker.ts:143` (`let templates: TemplateRegistry` — the worker's
  OWN registry, one per worker; `:249` it is rebuilt from a `templates` message), `:193-205`
  (`decodeTile(payload, id, timeRange, { templates … })` then `postMessage({ tile }, transferables)`
  — `collectTransferables` transfers ArrayBuffers only; `categories: string[]` is structured-CLONED);
- `packages/core/src/tile-decoder.ts` — no occurrence of `categor` (no receive-side dedupe);
  `packages/core/src/archive.ts` — no `.categories` access after decode;
- `packages/core/src/tile-decoder.ts:1072-1087` (`createDefaultTileDecoder`: `WorkerTileDecoder`
  whenever `Worker` exists — i.e. every browser);
- `packages/core/test/hoisted-category-sharing.test.ts:41` imports `decodeTile` and tests the
  inline path only.

**Mechanism** Identity is a per-realm property. The share happens inside the worker realm; the
structured clone that carries the decoded tile to the main thread allocates a fresh array and fresh
strings per tile. With K workers there are K worker-side copies plus one main-thread copy PER TILE.
`estimateTileSize` (`archive.ts:1704-1706`) charges `c.length × 2 + 16` per category per tile, which
is therefore CORRECT on this path — the bytes are real.

**Scenario** Large; any archive with a hoisted dictionary column. Measured with `cat-identity.mjs`
(inline path, so `sameInstanceAcrossTiles` = what the worker sees, not what the page sees):
`gtfs-ch` `agency_id` 360 categories, 8,084 B/copy, shared in-worker → on the main thread
**8.3 KB of duplicated strings per tile** (measured `bytesize-structural.mjs`: gtfs-ch z10 tiles
are 93 B of buffers + 8,331 B of category strings — 90 % of the tile). At the 2000-tile cap that is
16.6 MB of duplicates; the 14,653-category column cited in `optimization-conformance-2026-08.md`
§6.1 (~527 KB/copy) would be ~1 GB at 2000 resident. Non-hoisted (tile-local) dictionaries are
unaffected and are the bigger absolute cost today: `satellites` `object_name`+`intl_designator`
4,610–4,713 categories per tile, **454 KB of strings per z1 tile, 1.5 MB per z0 tile**.

**Consequence** The 39× regression `optimization-conformance-2026-08.md` §6.1 describes is still the
browser's behaviour for hoisted columns; only Node tests see the fix. Heap, not ArrayBuffer memory
— V8 heap strings trigger GC pauses and iOS Safari's tab budget earlier than typed arrays.

**Evidence** greps above (no `categor` in `tile-decoder.ts`, none in the worker after decode);
`tile-transferables.test.ts` only checks that `categories` are NOT in the transfer list. No test
routes a hoisted tile through `WorkerTileDecoder` and asserts identity on the receiving side.

**Fix** Receive-side dedupe in `WorkerTileDecoder` (main thread, `tile-decoder.ts`): keep a
per-decoder `Map<string, string[]>` keyed by `${column}|${categories.length}|${hash of first/last +
sampled entries}` (or have the worker post a `categoriesRef: string` token — the same
`${templateHash} ${column}` key it already computes — instead of the array when the table is
hoisted, and let the main thread materialise it ONCE per token from a separate `categories`
message). The token variant is exact and removes the clone cost too. Add
`hoisted-category-sharing.test.ts` cases that go through `WorkerTileDecoder` with the fake worker
used in `tile-decoder.test.ts:164+` and assert `toBe` on the receiving side. Blast radius: the
worker message shape (`tile-decoder.worker.ts` `TileMessage`), OPFS warm path unaffected.

**Confidence** High on mechanism (structured clone semantics + no receive-side code); medium on
magnitude for the showcase fleet (only gtfs-ch/satellites/flights were sampled).

**How to verify** In the browser on `/demo/gtfs-ch`, a heap snapshot after 2000 resident tiles
counts `categories` arrays: today ≈ 2000 per hoisted column; after the fix ≈ 1. Unit: the
worker-path identity test above.

### CE-4 [high] "Bounded client memory" is not what the defaults implement: 2 GiB decoded PER TILESET with no device awareness, composite floors that SUM past the budget, plus a 512 MiB compressed cache on top

**Where**

- `spatiotemporal-tileset.ts:1330-1331` (`maxCacheSize: 2000`, `maxCacheByteSize: 2 GiB` —
  constants, no `navigator.deviceMemory`, no UA check; the ONLY device-aware code in the repo is
  `archive.ts:971-989`, which sizes the COMPRESSED cache: 100/250/500 tiles, 256/512 MiB);
- `examples/showcase/src/components/demo/buildDemoLayers.ts:626-632`
  (`maxCacheSize: max(600, ⌊2000/N⌋)`, `maxCacheByteSize: max(512 MiB, ⌊2 GiB/N⌋)`), `:537-575`
  (`archiveCount`: storm4d up to 10, weather up to 7);
- `archive.ts:1013` (`SHARED_BYTE_CACHE_MAX_BYTES` process-wide 512/256 MiB) + per-archive
  `maxCacheTiles` 500 / `maxCacheBytes` 512 MiB (`:2011-2012`);
- no grep hit for `performance.memory`, `MemoryPressure`, `onmemorywarning`, `QuotaExceeded`
  anywhere in `packages/*/src` or `examples/showcase/src`.

**Mechanism / arithmetic** Multiply out the caps a tab may legitimately reach:

- single archive: 2 GiB decoded + 512 MiB compressed (shared) + worker-side in-flight buffers
  (pool ≤ cores−1, each holding one compressed+decoded tile) + GPU copies of every visible tile.
- `storm4d` (N=10): 10 × max(512 MiB, 204.8 MiB) = **5 GiB decoded cap** and 10 × 600 = 6,000
  tiles; `weather` (N=7): **3.5 GiB / 4,200 tiles**. The floor turns "2 GiB / N" into "512 MiB
  each" for every N ≥ 4, so the composite budget GROWS with N.
- In practice the COUNT cap binds first, and what 2000 tiles weigh is set by the archive, not the
  option: measured decoded estimate per tile (`sat-z3.mjs`, `bytesize-structural.mjs`) —
  `satellites` z2 419 KB (→ **818 MB at 2000 resident**, 305 MB of it JS strings), z3 89 KB
  (174 MB), z0 4.4 MB per tile; `flights` z6 168 KB (328 MB); `nyc-taxi-paths` z12 31 KB (62 MB);
  `gtfs-ch` z12 22 KB (42 MB); `drifters` z4 7 KB (13 MB). So the byte cap never engages on any
  local archive before the count cap — except that it is the number that would matter on a device
  that cannot hold 800 MB.
- iOS Safari kills tabs around 1–1.5 GB; Android low-end at ~1 GB. `getDeviceAwareCacheSize`
  knows this (it halves the COMPRESSED cache at `deviceMemory ≤ 4`), the decoded cache does not.

**Scenario** Large (satellites/flights/drifters at low zoom), composites (storm4d, weather),
any mobile client.

**Consequence** No mechanism bounds the tab below the OS kill threshold on mobile; on desktop the
composite budgets are 2.5× what the comment claims ("each tileset's slice of the ~2 GiB budget").

**Evidence** Constants and arithmetic above; grep for memory signals empty.

**Fix** (1) Default `maxCacheByteSize` from the device: `min(2 GiB, ⌊deviceMemory GB × 192 MiB⌋)`
with the same UA fallback `archive.ts:977-982` uses (256 MiB on mobile); expose the derived value.
(2) In `buildDemoLayers.ts:626-632` divide ONE budget: `maxCacheByteSize = ⌊budget / N⌋`,
`maxCacheSize = ⌊2000 / N⌋`, floors only if `N × floor ≤ budget` (i.e. drop them, or make the floor
`min(600, ⌊2000/N⌋)`). (3) Optional: a `MemoryPressure`/`deviceMemory`-driven `setOptions({
maxCacheByteSize })` hook — `setOptions` already evicts immediately on a cut (`:1875-1887`).
Blast radius: `measurements-2026-08.md:1369-1370` documents the current split arithmetic.

**Confidence** High for the arithmetic and the absence of device awareness; medium for the
mobile survivability claim (no device measured).

**How to verify** `getCacheStats().cacheBytes` on `/demo/satellites` zoomed to z2 for 2 minutes
reaches ~800 MB today; with (1) on a `deviceMemory: 4` emulation it must plateau ≤ 768 MiB.

### CE-5 [medium] The compressed byte cache is structurally unable to hit under the decoded cache in steady state, and `clearCache()` leaks the shared-LRU accounting

**Where**

- `archive.ts:219-220` (500 / 100 tiles), `:2011-2012`, `:4576-4600` (`storeBytes` on EVERY fetch —
  `:3775`, `:4431`, `:4459` — registers a `SharedByteCacheEntry` with two closures per tile),
  `:3823-3829` / `:4241-4258` (hit path), `:1077-1100` (shared LRU with `EVICT_SCAN_LIMIT` 8);
- `spatiotemporal-tileset.ts:1330` (decoded cache 2000 tiles);
- `archive.ts:5273-5276` (`clearCache()` clears `byteCache` and `currentCacheBytes` but does NOT
  `unregisterSharedCacheEntry` — compare `clearByteCache()` `:4637-4643` which does);
- `types.ts:962-966` ("Pass `0` to disable the compressed cache when a decoded tileset cache already
  owns the working set") — grep: NO caller in `packages/layers`, `three`, `maplibre`, `cesium`,
  `core/src/render`, or the showcase sets `maxCacheTiles`.

**Mechanism** The tileset never asks the archive for a tile it holds decoded. A tile is re-requested
only after decoded eviction, i.e. after at least (`maxCacheSize` − needed) ≈ 1,300+ other requests
have gone through the archive — far more than the 500-entry LRU. So the compressed cache can hit
ONLY when the decoded cache is thrashing faster than 500 requests (CE-1/CE-2) or when a second
tileset shares the archive. Cost per request in the healthy case: a Map delete/set + `Date.now()`
(`touchCachedBytes`), a `sharedCacheToken` string alloc, two closures, and 500 × avg compressed
bytes of retention: 4 MB for nyc-taxi-paths (7.7 KB avg), 16–50 MB for satellites (31–99 KB),
~100 MB for drifters z0 (200 KB).

**Scenario** All. Measured: `/demo/nyc-taxi-paths` `archive.stats.hitRate` 0.031 during play;
`/demo/hurricanes` 0.188 (only because of CE-1's thrash); cold hurricanes: 2,981 byte-cache
evictions during the 17,899-tile pin load — pure churn.

**Consequence** Memory and per-request overhead with no benefit in the healthy state; after a
`clearCache()` the process-wide `sharedByteCacheBytes` stays inflated by the cleared entries'
bytes (their `evict` closures are now no-ops), so OTHER archives' entries are evicted early until
the stale tokens age out of the scan window — a silent cross-archive capacity loss.

**Evidence** Reasoning above from the two cache sizes; probe hit rates; code at `:5273`.

**Fix** (1) `clearCache()` → call `this.clearByteCache()`. (2) `makeTilesetCallbacks` / the
chassis pass `maxCacheTiles: 0` unless OPFS is enabled (the byte cache is the OPFS write source),
or size the byte cache by BYTES to ≥ the decoded cap's compressed equivalent so it can actually
absorb decoded-eviction refetches (then it becomes a real second level: ~2000 × avg compressed).
Blast radius: `archive-*.test.ts` hit-rate assertions.

**Confidence** High (structural argument + two probe readings).

**How to verify** Steady-state `archive.stats.hitRate` must be 0 on any healthy demo today (it is);
after (2)-bytes-sizing it should become > 0 exactly when the decoded cache evicts.

### CE-6 [medium] OPFS cache: opt-in with zero callers (dead in every backend and the showcase), and not playback-safe if enabled — whole-index JSON rewrite per touch, O(N log N) sort per over-budget write, quota errors only logged

**Where**

- `archive.ts:1994-2004` (`opfsRequested = options.opfsCache === true`); grep across
  `packages/*/src`, `examples/showcase/src`: no `opfsCache: true` anywhere (only `opfs-cache.ts`
  and its `.d.ts`);
- `opfs-cache.ts` (`markDirty` → `setTimeout(0)` → `flushIndex` = `JSON.stringify(this.index)` of
  EVERY entry; `get()` calls `markDirty()` on every hit; `set()` on every write; `evict()` does
  `Object.entries(...).sort(...)` over all entries; `set()` catches every error incl.
  `QuotaExceededError` with `console.warn` only; admission constants `ADMIT_ALWAYS_MAX_ZOOM` 2,
  `ADMIT_MIN_BYTES` 4096, `DOORKEEPER_MAX_ENTRIES` 4096; budget = `min(maxBytes, quota/2)`).

**Mechanism** If enabled on a large archive: each entry is `"<hex-of-key>.bin":{"bytes":n,
"lastAccess":n,"hits":n}` ≈ 110–150 B; at 100k entries ≈ 11–15 MB of JSON re-serialised on the
main thread once per macrotask that touched the cache (during playback: every tile batch), and
written through `createWritable` each time; at 500k entries ≈ 55–75 MB per flush. `evict()` sorts
all entries on every write that crosses the budget — with GDS the budget is crossed continuously
once full. A quota failure leaves `available = true`, so every subsequent write retries and fails.

**Scenario** Not live (no caller). Relevant only because the how-it-works page
(`DecodePipeline.tsx:242-250`) and `types.ts:926-943` present it as a storage tier.

**Consequence** None today; a footgun for anyone who flips it on for a 500k-tile archive.

**Evidence** greps; `opfs-cache.test.ts` (26 cases) never exceeds a few dozen entries and never
measures flush size or count.

**Fix** Either delete the tier or, before enabling anywhere: per-entry files with a compact binary
index (or IndexedDB metadata), flush coalescing on an interval (not per touch), a partial-sort
victim selection, and `QuotaExceededError` → `evict(budget × 0.8)` then `available = false` after
two consecutive failures. Keep it opt-in.

**Confidence** High that it is dead and that the flush is whole-index; medium on the per-entry
byte estimate (key = hex of `opfsKey(id)`, exact length not measured).

**How to verify** Enable `opfsCache: true` on `ais-all-us` (560k tiles) and count `createWritable`
calls and bytes per second during playback.

## Checked and correct

- `estimateTileSize` (`archive.ts:1674-1710`) is an honest DECODED estimate: dedups by backing
  `ArrayBuffer` via the same `forEachBufferView` the transfer list uses (`tile-transferables.ts:47-84`,
  drift-guarded by `tile-transferables.test.ts`), adds `arrowIpc`/`arrowIpcProps`, and category
  strings. Structural walk on real tiles: backing bytes == view bytes on every sampled archive, 0
  buffers shared across tiles (per-tile bytes are `.slice()` copies, `archive.ts:4459`, and the
  worker transfers per-tile buffers), 11–32 typed arrays per tile; decoded/compressed ratio
  2.3–3.6× (hurricanes 2.28, earthquakes-v2 2.96, nyc-taxi-paths 3.59, satellites 3.63, drifters
  2.41; gtfs-ch 22.9× because 90 % of a tiny tile is category strings). Misses only JS object
  overhead (~1–2 KB/tile, partly covered by the 1000 B base). The byte cap is real, not fiction —
  it is just never the binding cap (CE-4).
- Worker strips `arrowTable` before posting (`tile-decoder.worker.ts:198`); `retainArrowIpc:
'auto'` drops IPC for quantized layers (`archive.ts:3791-3806`) — sampled tiles all had
  `arrowIpc`/`arrowTable` absent, so no hidden Arrow-table residency.
- Incremental accounting (`loadedTileCount`/`currentCacheBytes`) is symmetric: `deliverTile`
  `:3963-3966`/`:3821-3825` ↔ `evictTiles` `:5516-5522` ↔ `clear()` `:6121-6160`; in-flight headers
  are never deleted (`:5280`, `:5311`), late delivery is latched by `isCancelled` (`:5507-5512`);
  pinned by `eviction-inflight.test.ts`.
- Tier A→B→C→D ordering, band sort (BH-7b) and loop rotation (BH-7a) match
  `docs/roadmap/playback-and-loading.md:222-240` line for line (`:5300-5450`).
- Grace path (`:5251-5290`): coverage-index keys, pinned and loading headers exempt; 120 s animating
  / 30 s paused; `Date.now()` once per pass, no sort.
- Per-frame eviction cost is negligible: `update()` (which runs `evictUnusedTiles` every frame the
  clock moves) measured in Node at ~20k headers p50 0.14 ms / p95 0.84 ms / max 4.65 ms (over-limit
  branch with sort), 0.05 ms for a 4-tile archive. No small-archive fast path exists and none is
  needed.
- Overview budget arithmetic (`:4917-4935`) correctly rejects the genuinely huge storyboards
  (drifters 909 MiB, satellites 770 MiB, earthquakes 25.9 MiB).
- Pinned tiles do not count toward primary-zoom readiness (`overview-preload.test.ts:277`) and are
  served only as parent fallback (`:3098`, test `:220`).
- Deck chassis releases promptly: `getVisibleTiles()` re-read every draw with a set diff
  (`spatiotemporal-layer.ts:1452-1465`), evicted tiles leave `state.tiles` next frame, prepared/
  sublayer caches pruned against the live key set (`animated-trips-layer.ts:1177-1180`, pinned by
  `trips-cache-hardening.test.ts:272`). maplibre sweeps GPU on `onTileUnload`
  (`base-layer.ts:2681-2683`). three republishes on every `update()` (`streaming-tile-source.ts:399,
:425-431`). No double residency past one frame found.
- Shared byte-cache cap is process-wide (`archive.ts:1013`, 512/256 MiB) and BH-8's playhead IS
  threaded (`spatiotemporal-tileset.ts:3986-3987` → `tileset-adapter.ts:62-63` → `archive.ts:4211`).
- Worker pool bounded to `[1, cores − 1]` (`tile-decoder.ts:288, :469-483`); no byte cap on
  in-flight decode, but the request scheduler's 24 slots bound it.
- OPFS budget clamps to `quota / 2` and `set()` never throws into the data path.
- `setOptions` cuts to `maxCacheSize`/`maxCacheByteSize` evict immediately (`:1875-1887`) and
  re-arm the pinned warning when headroom returns.

## Doc ↔ code drift

- `docs/roadmap/tile-loading-3d-2026-07.md` §8: "check `getCacheStats().pinnedCount` first — one-line
  measurement" — `TilesetCacheStats` (`spatiotemporal-tileset.ts` interface) has no `pinnedCount`;
  the counts (17,899 / 8,927) are confirmed here by directory scan and browser console.
- `docs/roadmap/optimization-conformance-2026-08.md` §6.1: "_Still open:_ reader-side array-identity
  sharing in `packages/core/src/tile.ts` (`sharedArrayIdentityHits` was 0)" — the sharing HAS landed
  (`tile.ts:196-301`, `hoisted-category-sharing.test.ts`), but only for the inline decoder; the
  browser path is still unshared (CE-3). The doc is stale in both directions.
- Code comment `spatiotemporal-tileset.ts:5264-5268` ("their bytes still count against the limits —
  the preload byte budget keeps that contribution small") and the warning text at `:5064-5067`
  ("lower the overview budget") — the budget bounds bytes; the failure is COUNT, which no budget
  bounds (CE-1).
- `overview-preload.test.ts:173` title "pinned tiles survive eviction pressure (over maxCacheSize)
  and warn once" documents the CE-1 state as intended behaviour.
- `buildDemoLayers.ts:622-625` "composites scale each tileset's slice of the ~2 GiB budget" — the
  floors make the aggregate 3.5–5 GiB for weather/storm4d (CE-4).
- `types.ts:962-966` advises `maxCacheTiles: 0` under a decoded cache; no shipped consumer does it
  (CE-5).
- `playback-and-loading.md:230` "Never candidates: … pinned overview" is accurate, but the doc does
  not say pins consume the cap; the tiered table's "D — last resort" is void when pins exceed it.
- how-it-works `DecodePipeline.tsx:242-250`: "OPFS on-disk (opt-in)" — accurate; "device-aware cap
  (scales w/ deviceMemory)" — accurate for the COMPRESSED cache only.

## Needs measurement

- CE-2 amplification split on `/demo/nyc-taxi-paths`: 1,177 MB / 24 s — count re-decodes of the
  same `tileKey` from the `decode` probe channel (`__sttProbe.decode[].key`) vs unique keys, and
  compare pack bytes with `coalesceGapBytes: 0` to separate coalescing from refetch.
- CE-2 density caveat: the Node replay's synthetic directory has data in every cell of every
  bucket; a replay driven by the real hurricanes directory (`policy-record.mjs` → `policy-replay`)
  would give the true no-pin tier-C rate at 1.84M×.
- CE-3 magnitude in the browser: heap snapshot on `/demo/gtfs-ch` after 2000 resident tiles —
  count of `categories` array instances and their retained size (expected ≈ 2000 × 8 KB for
  `agency_id`).
- CE-4 survivability: `/demo/satellites` at z2 on an iOS Safari device or Chrome with
  `--js-flags=--max-old-space-size=1024`; does the tab survive 2000 resident z2 tiles (818 MB
  estimated)?
- Steady-state byte-cache hit rate on a composite where two tilesets share one `STTArchive`
  instance (the only healthy hit path left for CE-5) — does any showcase composite share an
  archive object? (`buildDemoLayers` passes URLs, so probably not.)
- Whether the prefetch enqueue over-shoot (`tileCount` 2,478 vs cap 2000 on nyc-taxi-paths)
  is bounded by the byte budget on heavier tiles or only by the next eviction pass.

---

# Appendix 5 — audit-network-scheduler

## Audit — network, range reads, directory, request scheduler (2026-08-24)

Scope: `packages/core/src/archive.ts` (open → directory → `getTiles` → `fetchObjectRange`), `directory.ts`, `request-scheduler.ts`, `shared-scheduler.ts`, `throughput.ts`, the tileset's dispatch/retry edges, the governor's use of the estimators, the live CDN, and the tests named in the brief. All line numbers are from the working tree. Measurements were taken by driving the built reader (`packages/core/dist`, Aug 24 12:16, newer than `src/archive.ts` and containing CO-7) against the local dev server (`http://localhost:3000/data/…`, HTTP/1.1, Range honoured) with an instrumented `fetch`; scripts are in this scratchpad (`amp-measure.mjs`, `dir-memory.mjs`, `big-tiles.mjs`, `drr-arrears3.mjs`).

## Answers to the dimension questions (evidence in the findings)

**Q1 — cold start.** Sequential round trips for a paged archive: (1) `manifest.json` whole GET (`fetchManifest` :2169 → `fetchWholeObjectWithRetry` :2333, un-ranged); (2) directory ROOT prefix range `bytes=0-(8+rootLength-1)` (:2801) — paged iff `layout==='paged' && length > SMALL_DIR_THRESHOLD 256 KiB` (:2793-2797), else the whole `.sttd` is one un-ranged GET (:2830) with blake3 verification; (3) surviving LEAF pages, pruned by bbox∩zoom∩time (`ensurePagesForBounds` :3235), coalesced with the same 2 MiB gap (:3075) and dispatched **in parallel** (`runGroupFetches` :4166 `Promise.all` when ≤ `maxConcurrentRequests`); (4) tile ranges. So 4 RTTs before the first tile byte, 3 for a ≤256 KiB directory. Both named archives page: `gtfs-ch` directory 8,602,296 B / 137 pages of 4096 entries / root 3,021 B; `nyc-taxi-paths` 5,692,030 B / 105 pages / root 1,812 B. Measured on the local tree (`amp-measure.mjs`, flat 1280×800 viewport): `nyc-taxi-paths` at its own demo camera (z14, 60 s window) = **7 requests / 3.68 MB: manifest 13.6 KB, directory 4 req / 1,985,799 B (35 % of the object), packs 2 req / 1,679,785 B for 451,853 B of tiles**; at z12 = 6 req, directory 715,769 B. `gtfs-ch` (uncommitted terrain build) at z7 = 4 req, directory 65,532 B, packs **1 req / 14,981,853 B** (4 tiles); at z14 Zürich = 4 req, directory 123,945 B, packs 479,272 B. `measurements-2026-08.md` §9 matches the code path (4 requests, root then leaves) but measured `gtfs-ch` only at z7 on the 460 MB fleet build; the doc's "leaf share 4.6 %" does not describe the 60 s-bucket `nyc-taxi-paths` at z14, where the directory is 54 % of cold-start bytes (NS-5). During 10 minutes of z14 playback no further page fetches occurred (all needed leaves resident after the first frame).

**Q2 — read amplification.** No `bytesUseful|bytesRequested|bytesWasted` exists anywhere in `packages/` or `examples/` (grep); only `tools/bench/src/policy-replay.mjs:731-744` has a `bytesFetched` counter in an offline replay. The `requests` probe channel (`telemetry.ts:102-115`) carries the range size only, not the members' useful bytes, so amplification cannot be derived from telemetry. Measured (`amp-measure.mjs`, 2 MiB gap, `source: 'no-build-gap'` on every fleet archive): steady-state per-bucket playback `nyc-taxi-paths` z14 **1.88×** (2 req/bucket, ~140 KB useful → ~265 KB), z12 **1.01×**; `gtfs-ch` z14 1.50×, z7 1.00×; `drifters` z2 1.20×; first frames 3.72× (nyc z14), 1.69× (nyc z12), 1.53×, 1.00×, 1.21×, 1.60× (earthquakes z2, 381 tiles). Worst case found: `earthquakes` z10, one hourly bucket, 10 tiles / 5,235 B useful → **one 4,690,110 B request (~900×)** (NS-6). With `coalesceGapBytes: 0` every case is 1.00× at 2–7× the request count.

**Q3 — concurrency.** Live deployment is Cloudflare in front of R2: ALPN `h2` accepted, `alt-svc: h3`, `accept-ranges: bytes`, `access-control-allow-origin: *`, `access-control-expose-headers: Content-Range,Content-Length,Accept-Ranges,ETag,Last-Modified` (curl 2026-08-24). `Range: bytes=N-M` is a CORS-safelisted simple value, so no preflight. The scheduler assumes one slot = one in-flight request, never one connection, which is correct under h2. The local dev server is HTTP/1.1 (browser cap 6 connections/host), so 12/24 slots queue in the browser's socket pool there — a measurement caveat for every localhost Playwright number, not a production bug. A 16 MiB prefetch slice (`PREFETCH_SLICE_MAX_BYTES`, prefetch-policy.ts:312) holds ONE slot, not 24; it cannot block dispatch, and its `fetchPriority: 'low'` (tileset :3980 → :2424) lowers its h2 stream weight in Chrome. The real head-of-line effects are NS-2 (DRR arrears) and NS-4 (no intra-group streaming); the per-member fallback breaks the slot budget outright (NS-3).

**Q4 — timeouts/retries.** `withTransferTimeout` (:849-887) starts the 20 s timer BEFORE `fetchFn` and the same signal races `response.arrayBuffer()` (:2447): it is a total-transfer deadline, not a stall timeout. On `TimeoutError` (name ≠ `AbortError`) `fetchObjectRangeWithRetry` (:2512-2540) re-issues the **identical** `(url,start,end)` after 250 ms and 1000 ms (±50 % jitter), never re-splitting; each failed attempt feeds `throughput.addSample(1, attemptMs)` (:2535). After 3 failures `getTiles`' `fetchGroup` (:4408-4450) fetches every member individually, in parallel, single attempt each, same 20 s deadline. Survivors are `null`; the tileset counts a null priority tile as a non-aborted failure (`startTileBatch` finally :4051 → `noteSettledWithoutTile(key, header, false)`), advances the ladder `500 ms × 2^(settles-1)` capped at 60 s (:4163, constants :345/:354), writes readiness off after 3 attempts (:318) but keeps re-enqueueing forever (`retryFailedTiles` :4230). A 404 pack takes the same path (NS-9). See NS-1.

**Q5 — small archives.** `storm4d-sounding` (4 tiles, 101 KB pack, 153 B directory): open = manifest GET + whole-directory GET; first frame = 1 range (all 4 tiles are one bucket, z3–z6 parents included, pack < gap); playback = 0 more. `lines-v2` (492 tiles, 180 KB pack): any batch from the pack fuses into ONE range (pack < 2 MiB gap), so requests = number of batches the prefetch runway does not cover, not tiles. There is no "tiny archive → fetch each pack whole" path. Such a path would be sound: packs are content-addressed and served `cache-control: public, max-age=31536000, immutable` (r2-sync.sh:108; verified live), so a 200 GET of a whole pack is browser-cacheable and the byte cache (500 tiles / 512 MiB) can hold every blob. Overhead of the large-dataset machinery on small archives is small on this side: `ensurePagesForTiles` is a no-op when not paged (:3379), OPFS lookups only when an OPFS cache is configured (none in the showcase), scheduler enqueue is synchronous.

**Q6 — fairness.** DRR currency is bytes: quantum `weight × 512 KiB` per round (:827-830, :871-880), admission `deficit ≥ min(costBytes, quantum)` (:856-860), spend `deficit −= costBytes` (:796-800), deficit clamped to ≤ one quantum at crediting (:878) but never clamped from below, pruned only when the source has nothing queued AND nothing running (:726-731). Trace for a required source R and three optional overlays O1–O3, all weight 1: R dispatches a 15 MiB group → deficit = 0.5 − 15 = −14.5 MiB; each round adds 0.5 MiB (`min(−14 MiB, 0.5 MiB) = −14 MiB`), so R needs ~29 rounds to re-admit, and in every round each overlay is admitted for ~512 KiB of groups regardless of tier, because `pickEligible` (:887-901) applies the deficit gate BEFORE the priority comparison. Measured on the real scheduler (`drr-arrears3.mjs`): optional PREFETCH groups (priority ≥ 1e15) dispatched while R's NEED-NOW group (priority 1000) waited — 0 after a 512 KiB group, **17 (4.3 MB) after a 2 MiB group, 173 (43 MB) after a 15 MiB group**, 30 (7.5 MB) with R re-weighted to 4×, 0 once R is fully idle (prune forgives arrears). The governor's fairness pass only re-weights incomplete REQUIRED sources within [0.25×, 4×] (`fairness.ts:33-35`, governor :2622-2790); optional sources keep weight 1 and are never de-weighted. EDF term = sim-ms `timeStart − playhead` (:3948-3956), not speed-scaled — consistent across sources sharing one clock, but keyed on `timeStart` only (NS-7).

**Q7 — throughput estimator.** θ̂: one sample per busy window — `beginTransferSample` (:2683) anchors the wall clock when the first group transfer of THIS archive starts, `endTransferSample` (:2699) adds `(Σ bytes, window ms)` when the last one settles; TTFB, retries and backoff are inside the window. Directory page fetches are not sampled. L̂: `LatencyEstimator` sample per range request at header arrival (:2434), including 4xx/5xx. Concurrency within one archive is therefore handled; across N archives each estimator sees only its own share of the link. `getThroughputEstimate` is wired per tileset (`tileset-adapter.ts:67`); no call site in `examples/showcase/src` passes `getThroughput` to a governor (grep), so the governor takes the ETA-implied path (`max_i bytes_i/eta_i`, :1938-1990), which under N concurrent archives underestimates the link by up to N× (pessimistic). A 3× wrong rate maps linearly: `estimateTimeToReadyMs = bytes / bytesPerMs` (tileset :4722-4728), auto-speed `= rate / bytesPerSimMs × safety` (governor :1997-2002); 3× low ⇒ 3× slower auto-speed and 3× longer "starting" waits; 3× high ⇒ the runway drains and the buffer gate stalls (safe, but stalls). The failure-aware sample `addSample(1, 20000)` after a timeout collapses the fast EWMA to ~0 in one sample (NS-1).

**Q8 — tests.** See NS-T.

## Findings

### NS-1 [critical] The 20 s transfer timeout is a total deadline over unbounded-size coalesced groups; a group the link cannot move in 20 s is retried identically, then per-member, then forever by the tileset ladder — and every attempt zeroes the throughput estimate

**Where** `archive.ts:765` (`DEFAULT_TRANSFER_TIMEOUT_MS = 20_000`, comment says "stall timeout"), `:849-887` (`withTransferTimeout`: timer armed before `fetchFn`), `:2426-2447` (`raceAbort(fetchFn)` then `raceAbort(response.arrayBuffer(), transfer.signal)` on the same signal), `:2512-2540` (`fetchObjectRangeWithRetry`: identical range re-issued; `throughput.addSample(1, …)` per failure), `:4340-4368` (coalescing loop: no cap on `current.end − current.start`), `:4408-4450` (per-member fallback, single attempt, same deadline); `prefetch-policy.ts:312` (`PREFETCH_SLICE_MAX_BYTES` 16 MiB); tileset `:4051`, `:4130-4190`, `:318/:345/:354`.
**Mechanism** The deadline is wall time from request issue to the last body byte. Group size is bounded only by the pack (67 MB) and the batch (1024 tiles). A single tile larger than `link × 20 s` can never complete: attempt 1 downloads 20 s of bytes and discards them, backoff, attempt 2 same, attempt 3 same, per-member fallback re-requests the same single blob for another 20 s, `null` is returned, the tileset counts a failure, quarantines for ≤60 s, re-enqueues (`retryFailedTiles` :4230 explicitly retries written-off tiles), and the cycle repeats indefinitely. Each attempt feeds `addSample(1, ~20000)` — a 20 s-weighted sample at 5e-5 B/ms — which drags `min(fast, slow)` to ~0 (fast half-life is 3 s of weight), so `estimateTimeToReadyMs` becomes astronomically large and auto-speed collapses even while the other streams are healthy.
**Scenario** Large / playback / slow links. Concrete: the uncommitted `gtfs-ch` build (`big-tiles.mjs`): 15 tiles > 8 MiB, 33 > 4 MiB, 251 > 1 MiB; z6 p90 6.9 MB, max **16,087,177 B** (`z6/33/22` 16:00); z7 p90 3.1 MB. At the demo's own camera (z7.6 → z7) every bucket step is 4–8 tiles fused into **one 6.9–15.0 MB request** (`amp-measure.mjs`). Completing 15 MB in 20 s needs ≥ 6.0 Mbit/s on that one stream with nothing else in flight; with a concurrent prefetch slice (up to 16 MiB) sharing the link, ≥ 12 Mbit/s. A 16 MB single tile needs ≥ 6.4 Mbit/s and cannot be split by the fallback. `satellites` max tile 1.33 MB and `drifters` 487 KB are safe at ≥ 1 Mbit/s.
**Consequence** On a 4 Mbit/s link the gtfs-ch demo at its default camera never draws a frame: ~80 s per cycle (3×20 s + fallback 20 s, minus overlaps) of link time discarded, repeated at the 60 s ladder cap for the whole session; the governor reports an ETA of hours and a near-zero rate. On a 10 Mbit/s link it is borderline (11 s per 14 MB step alone, > 20 s once prefetch shares the link).
**Evidence** Code trace above; `archive-transport-hardening.test.ts:67-92` pins exactly "3 attempts, identical range, TimeoutError" and `:94-114` pins a never-resolving first attempt retrying; no test exercises a slowly-progressing body. Tile sizes and request sizes measured on the local tree (scripts in scratchpad).
**Fix** Make the watchdog an idle/progress timeout: read `response.body` with `getReader()` and re-arm the timer on every chunk (`archive.ts:2447` → streaming loop; `fetchWholeObject` :2310 same). A never-progressing response still times out after 20 s; a progressing one never does. Second, on a `TimeoutError` skip the two identical retries and go straight to the per-member fallback (re-split is the only thing that can change the outcome). Third, a tile whose `length > conservativeRate × transferTimeoutMs` should not be re-attempted until the estimate improves (surface via `onTileError`). Blast radius: `fetchObjectRange`/`fetchWholeObject` only; all existing hardening tests still pass (they use hung promises, i.e. zero progress). NS-4 falls out of the same streaming read.
**Confidence** high — the deadline semantics are explicit in the code; the tile sizes are measured from the local directory.
**How to verify** Test: a transport that streams a 1 MB body at 100 KB every 200 ms (total 2 s) with `transferTimeoutMs: 500` must resolve today's code rejects with `TimeoutError`. Browser: Chrome DevTools throttling "Fast 3G" (1.6 Mbit/s) on `/demo/gtfs-ch` — count `bytes=` requests to the same range on the Network tab and watch `archive.getThroughputEstimate()`.

### NS-2 [high] DRR byte arrears let OPTIONAL PREFETCH run ahead of a required source's NEED-NOW groups after any group larger than one quantum

**Where** `request-scheduler.ts:856-860` (`admissionThreshold`), `:871-880` (`creditRound`, clamp `min(next, q)` only from above), `:796-800` (spend, deficit goes negative), `:722-731` (arrears pruned only when the source has no survivor AND nothing running), `:887-901` (`pickEligible`: deficit gate evaluated before the priority compare); `archive.ts:737-745` (`SCHEDULER_PREFETCH_TIER_BASE` comment: "ALWAYS ranks below any need-now group GLOBALLY across sources").
**Mechanism** A group costing more than `weight × 512 KiB` leaves its source in arrears that are repaid at one quantum per round. While the source still has anything running or queued (the normal state during playback: prefetch slices and priority batches overlap), the arrears are not pruned. In every round each other source is admitted for a quantum of its groups whatever their tier, because `pickEligible` skips inadmissible sources before comparing priorities. The tier base only orders admissible candidates; it does not gate admission.
**Scenario** Playback in composites — every showcase composite (weather suite, storm-4d + overlays, flow-and-riders, drive cockpit); the primary's groups are routinely 0.25–15 MB (measured p50 240–400 KB at z12–z14, 7–15 MB at gtfs-ch z7).
**Consequence** Measured on the real `SharedRequestScheduler` (`drr-arrears3.mjs`, 3 overlays with 250 KB prefetch groups queued): optional prefetch groups dispatched while R's need-now group waited = 0 after a 512 KiB group, **17 (4.3 MB) after 2 MiB, 173 (43 MB) after 15 MiB**, 30 (7.5 MB) with R at weight 4, 57 (14 MB) with a single overlay, 0 once R is idle. At 50 Mbit/s, 43 MB is ~7 s during which the gating source's next bucket is not even on the wire: a buffer stall the governor attributes to the network.
**Evidence** Simulation on the built scheduler; code trace; `request-scheduler.test.ts:1034-1060` pins the progress guarantee (an over-quantum group dispatches) but no test covers what its arrears do to the source's NEXT request against other sources' lower-tier work.
**Fix** Gate admission per tier: run the DRR gate only among candidates of the globally most-urgent tier present (need-now vs prefetch), i.e. in `selectNext` compute `minTier = min(priority ≥ TIER_BASE ? 1 : 0)` over survivors and let `pickEligible` consider only sources whose best candidate is in that tier, topping up from the existing top-up path if none is admissible. Alternatively cap arrears at `−quantum` in the spend step (a 15 MiB group then costs one round, not 29). Either keeps the byte-share property for same-tier contention. Blast radius: `selectNext`/`pickEligible`; the recorded-order pins in `request-scheduler.test.ts:986-1330` need re-blessing where over-quantum groups appear.
**Confidence** high — reproduced on the shipped implementation with the shipped constants.
**How to verify** The `drr-arrears3.mjs` script as a vitest: after R runs a 15 MiB group with R still in flight, R's priority-0 request must dispatch before any priority ≥ 1e15 request of another source. Fails today (173 dispatch first).

### NS-3 [medium] The per-member fallback fans out every member of a failed group in parallel, outside the scheduler and both concurrency caps

**Where** `archive.ts:4408-4450` (`Promise.all(group.members.map(async (m) => { … this.fetchRange(…) }))` inside `fetchGroup`, which runs in ONE scheduler slot).
**Mechanism** A group can hold up to `MAX_COALESCE_BATCH` (tileset :59, 1024) members; on failure all are fetched concurrently with `fetchRange` (no scheduler, no `perArchiveCap`, no global 24). Each is a fresh 20 s-deadline request.
**Scenario** Large; any transient 5xx/timeout on a big group (NS-1 makes this common on slow links). `gtfs-ch` z14 whole-bucket groups reach 20,384 members (`dir-memory.mjs`, world view); a normal z14 viewport batch is 16–24.
**Consequence** Bursts of N requests that exceed the h2 stream limit queue in the browser; the DRR/EDF ordering and the 24-slot budget are void for the duration; on the slow link that caused the failure, N parallel streams each get link/N and all time out together (NS-1).
**Evidence** Code; `archive-retry.test.ts:108-131` pins the fallback semantics with a 4-tile fixture and never checks concurrency.
**Fix** Run the fallback members through `runGroupFetches` (one group each, same priority, `costBytes = length`) instead of a raw `Promise.all`; that reuses the slot budget and abort wiring already in place. Blast radius: `fetchGroup` catch branch only.
**Confidence** high.
**How to verify** Fixture: a 40-member group whose coalesced fetch 500s; a counting `fetch` must never see more than `maxConcurrentRequests` pack ranges in flight. Today it sees 40.

### NS-4 [medium] No intra-group incremental delivery: the first tile of a coalesced range is decodable only after the whole range body arrives

**Where** `archive.ts:2447` (`response.arrayBuffer()`), `:4456-4480` (members sliced from the complete buffer), `onTileReady` delivered per member after the group resolves; no `getReader`/`ReadableStream` anywhere in `archive.ts` (grep).
**Mechanism** `archive-incremental-delivery.test.ts:101` pins delivery per GROUP; within a group, members whose byte extent completed early wait for the last byte of the range.
**Scenario** Large / playback. `gtfs-ch` z7: one 15 MB request per bucket; `nyc-taxi` first frame: one 1.05 MB request. A 16 MiB prefetch slice is one group when contiguous.
**Consequence** On a 20 Mbit/s link the first z7 gtfs-ch tile is drawable after ~6 s instead of ~1.5 s; at 157× a 1 h bucket is 23 s of wall, so the runway hostage window is the whole group, not the first tile. It also makes NS-1's deadline bite harder: a partial body is thrown away in full.
**Evidence** Code and the pinning test.
**Fix** Same streaming read as NS-1: accumulate chunks and, when the cursor passes `member.offset + member.length`, slice and `decodeBytes` that member immediately (members are already sorted by offset :4353). Blast radius: `fetchObjectRange` returns chunks via a callback for the group path; the existing `validateContentRange`/length checks stay.
**Confidence** high (mechanism), medium (magnitude, link-dependent).
**How to verify** Streaming transport fixture (100 KB chunks, 50 ms apart) with a 3-member group: `onTileReady` for member 0 must fire before the last chunk is delivered. Today it fires after.

### NS-5 [medium] Directory leaf pages are fused with the 2 MiB tile gap, so the nyc-taxi z14 cold start transfers 1.99 MB of directory (35 % of the object) where 0.78 MB is needed — and saves no round trip

**Where** `archive.ts:3062-3085` (`fetchAndMergePages`: `coalesceGap = this.effectiveCoalesceGap()`, groups fused when `start − (cur.end + 1) ≤ coalesceGap`), `:4166` (page groups dispatched with `Promise.all` — parallel).
**Mechanism** Leaves are `(zoom, hilbert, time)`-sorted, 4096 entries each. With 60 s buckets a leaf spans ~1.7 z14 cells for the whole day, so a viewport needs non-adjacent leaf indices; every inter-leaf gap under 2 MiB is fetched and discarded (`fetchGroup` :3085-3118 decodes members only). Because page groups are dispatched in parallel, fusing them saves requests but not latency.
**Scenario** Large, short buckets, high zoom: the `nyc-taxi-paths` demo camera IS z14.
**Consequence** Measured: 2 MiB gap → 4 directory requests / 1,985,799 B; gap 0 → 10 requests / 777,558 B. +1.21 MB on the critical path to save 6 parallel requests; at 20 Mbit/s that is ~0.5 s added to first paint. The directory is 54 % of that cold start (3.68 MB total). `gtfs-ch` z14 is unaffected (124 KB, adjacent leaves) — leaf granularity, not directory size, decides it, exactly as §9.3 of the measurements doc observed for `rainfall-2019`.
**Evidence** `amp-measure.mjs` with and without `GAP=0`; `paged-directory.test.ts:230-241` only asserts "less than the whole directory".
**Fix** Use a page-scale gap in `fetchAndMergePages` (e.g. `min(effectiveCoalesceGap(), 2 × median leaf length)` or simply adjacent-only fusion) — pages are ~55 KB and the fetches are parallel. Do not touch the tile path here (that is the open `coalesceGapBytes` plumbing item). Blast radius: one function; `tile-batch-coalescing` plan pins cover pack ranges, not page ranges.
**Confidence** high.
**How to verify** Bench: `cold-start-bench.mjs` row for `nyc-taxi-paths` at `{-73.98, 40.75, 14}`; assert directory bytes ≤ Σ needed leaf lengths + one leaf. Today 1.99 MB vs 0.78 MB.

### NS-6 [medium] The 2 MiB gap has no amplification bound: a sparse dataset's one-bucket batch fuses 10 tiles / 5 KB into a 4.69 MB request (~900×) because blob dedup breaks time-major locality

**Where** `archive.ts:4358` (fuse rule compares the gap to a constant, never to the useful bytes accumulated so far), `directory.ts:449-497` (runs point at shared blobs), `:253-262` (the constant's rationale assumes a saved RTT per fuse).
**Mechanism** `earthquakes` z10 bucket `1675688400000` (`big-tiles.mjs`): ten 474–575 B tiles at offsets 19,395,405 → 24,085,030 with inter-tile gaps of 1,085,983 / 1,953,615 / 963,046 / 682,294 B — each under 2 MiB — so the batch is one 4,690,110 B range. The same blob is referenced by many entries (`z0..z4` all at offset 9,745,636), i.e. the writer deduplicated identical blobs and a bucket's entries point wherever the blob was first written; "time-major" holds for the writer's runs, not for what a bucket's entries resolve to.
**Scenario** Large sparse event archives (`earthquakes` 350k tiles p50 484 B) at z ≥ 7 with hourly buckets; `estimateSelectionCost` prices such a batch at 5 KB while the wire carries 4.7 MB, so the governor's ETA is off by the same factor.
**Consequence** ~900× amplification for that batch; at the earthquakes demo camera (z2, 30-day window) it is a benign 1.6×, so the exposure is zoom-in during playback.
**Evidence** Directory dump above; all steady-state amplifications in Q2.
**Fix** Bound the fuse by useful bytes: fuse only when `gap ≤ min(coalesceGap, k × usefulSoFar + MIN_ADAPTIVE_COALESCE_GAP)` with `k ≈ 4`. Blast radius: the two fuse sites; `tile-batch-coalescing.test.ts:703-733` ("FLEET-SHAPED archive issues exactly the ranges a 2 MiB-pinned reader would") pins the current plan and must be re-blessed. Builder-side: `stt-optimize order-audit` should report dedup-induced scatter (not proposed here — reader change is sufficient).
**Confidence** high (measured), medium on how often real cameras hit it.
**How to verify** Synthetic pack: 10 × 500 B tiles 1 MiB apart; `getTiles` must issue ≤ 10 requests totalling < 100 KB. Today: one 9 MiB request.

### NS-7 [medium] EDF distance is keyed on `timeStart` only, so the bucket that CONTAINS the playhead is ranked as "already passed" — behind every future bucket — and a test pins it

**Where** `archive.ts:3948-3956` (`ahead = timeStart − t; dist = ahead ≥ 0 ? ahead : BEHIND_OFFSET + |ahead|`), vs tileset `:3759` (`|a.t − time|`, symmetric); `scheduler-group-priority.test.ts:211-222`.
**Mechanism** For a forward playhead at `t = bucketStart + 30 s` inside a 60 s bucket, the current bucket's groups get `5e14 + 30 s` and the next bucket's get `30 s`: the frame being drawn ranks after the frame 30 s away. The test at :211 asserts bucket `[2000, 3000]` with playhead 2500 is "passed" — it pins the inversion. The tileset sorts its queue the other way, and `runGroupFetches` re-sorts groups (:4075-4091), so the archive's order wins.
**Scenario** Playback, whenever groups > `perArchiveCap` (12 in the showcase) or under cross-source contention: after a pan mid-bucket, the visible bucket's tiles dispatch last.
**Consequence** Visible hole in the current frame while future buckets load; on the shared scheduler the current bucket also loses to other sources' next-bucket need-now groups.
**Evidence** Code; test text.
**Fix** `const passed = dir > 0 ? e.timeEnd < t : e.timeStart > t;` distance 0 for a containing interval, `BEHIND_OFFSET + (t − timeEnd)` when passed. Re-bless the test's third case (it should assert 2000 first, then 3000, 4000, 1000). Blast radius: one function + one test.
**Confidence** high.
**How to verify** The corrected test.

### NS-8 [low] Resident directory pages are never evicted: a fully-paged `gtfs-ch` costs 276 MB of heap (518 B/entry), `earthquakes` 66 MB, `drifters` 49 MB

**Where** `archive.ts:3113-3116` (`residentPages.add`, `indexCache.tiles.push(...entries)`), `residentPages` only cleared in `fetchAndBuildIndex` :2817 (grep: no `delete`).
**Mechanism** Every leaf ever needed stays: three maps (`tileEntryIndex`, `tileEntryByKey` with string keys, `occupiedCellListsByZoom`) plus the `tiles` array. Paging bounds cold-start bytes, not session memory; the byte/tile caches are budgeted, the directory is not.
**Scenario** Large; a long session panning at z14 over `nyc-taxi-paths` (leaves ≈ 1.7 cells each, so most of the 105 pages become resident) or `gtfs-ch`.
**Consequence** Up to the full directory in main-thread heap, on top of the 2 GiB tile budget; `entryListsInBounds`' oversized-scan path (:4723-4790) walks all resident cells.
**Evidence** `dir-memory.mjs` (`--expose-gc`, heap delta after paging every leaf).
**Fix** Track `lastUsed` per page and evict pages not touched for N selection passes when resident entries exceed a budget (e.g. 200k); re-fault is one range GET. Or cut per-entry cost (the `tileEntryByKey` string keys and duplicated `tiles` array are most of the 518 B). Blast radius: `mergeEntries`/`fetchAndMergePages`; `estimateSelectionCost`'s `unknownTiles` already models non-resident leaves.
**Confidence** high on the numbers; medium on realistic session exposure (a z14 nyc viewport reached 35 % after one frame).
**How to verify** Heap delta test with a synthetic 100-page directory: after paging all in and then querying a small box for N passes, resident pages must drop below the budget.

### NS-9 [low] A permanently missing (404) pack is treated as transient: 3 attempts + N per-member requests per cycle, forever at the 60 s ladder, and each failure is also charged to the throughput estimator

**Where** `archive.ts:2435-2439` (`!response.ok` → generic `Error`, no status classification), `:2512-2540` (retry regardless of status), `:4408-4450` (fallback), `:2535` (`addSample(1, …)`); tileset ladder as in Q4.
**Mechanism** Only `AbortError` is exempt from retry; 404/403/416 are retried and fallen back. Cost per cycle for a viewport whose tiles live in the missing pack: 3 + N requests (~1.3 s of a slot), repeated every ≤ 60 s for the session (the "R2 serves formatVersion:1 for un-gated stems" deploy hazard in the memory is exactly this shape).
**Consequence** Wasted requests and a slot; the estimator effect is small (60 ms samples).
**Fix** Classify 4xx (except 408/429) as permanent in `fetchObjectRangeWithRetry` and skip both retries and the per-member fallback; honour `Retry-After` on 429/503. Blast radius: one function; `archive-retry.test.ts` uses 500s only.
**Confidence** high.
**How to verify** Fixture returning 404 for a pack: exactly 1 request per group, no fallback fan-out.

### NS-10 [low] Estimators are per-archive but the governor treats one reading as the aggregate link rate; the showcase wires no `getThroughput` at all

**Where** `archive.ts:2683-2708` (busy window per archive), governor `:1754-1770` (assumption stated), `:1938-1990` (ETA-implied fallback), `tileset-adapter.ts:67`; grep `getThroughput` in `examples/showcase/src` → none.
**Mechanism** In a composite each archive's window measures its own share of the link; the ETA-implied path takes `max_i(bytes_i / eta_i)`, each ≈ share_i × link, so the aggregate is under-read by up to N× when shares are equal.
**Consequence** Pessimistic: auto-speed up to N× slower than the link allows and longer "starting" waits in composites. Safe direction, so low.
**Fix** Sample the busy window on the shared scheduler (it already sees every group's `costBytes` and settle times) and expose `getSharedSchedulerThroughput()` for the governor. Blast radius: additive.
**Confidence** medium (mechanism clear; magnitude depends on overlap of loading across archives).
**How to verify** Two archives loading concurrently through the same throttled transport: each `getThroughputEstimate()` must be ~half the transport's rate; a shared-scheduler estimate must be ~the full rate.

### NS-T [low] Test coverage: what is pinned, vacuous, or missing on this dimension

- **Vacuous**: `paged-scheduler-supersede.test.ts:362` "disabled (kill-switch) path" and every `configureSharedScheduler({ enabled: … })` call (`shared-scheduler-archive.test.ts:316,384,488`, `paged-scheduler-supersede.test.ts:267,365`) — `ConfigureSharedSchedulerOptions` has no `enabled` field (`shared-scheduler.ts:100-134` reads only `maxRequests`/`byteQuantum`; vitest does not type-check), and `runGroupFetches` calls `getSharedScheduler()` unconditionally (`archive.ts:4047`). Both "enabled" and "disabled" tests exercise the same path.
- **Pins the wrong semantics**: `scheduler-group-priority.test.ts:211` (NS-7).
- **Pinned and correct**: retry count/backoff/abort-not-retried (`archive-retry.test.ts:81-153`), 3-attempt timeout with zero progress (`archive-transport-hardening.test.ts:67-114`), Content-Range/length validation (`:229-290`), busy-window sampling (`:292-321`), failure-aware decay (`:323-353`), DRR share/progress/no-starvation/rollback exactness (`request-scheduler.test.ts:484-700, 986-1517`), dynamic weight (`scheduler-dynamic-weight.test.ts`), incremental delivery per group (`archive-incremental-delivery.test.ts:101`), CO-7 gap precedence/band/determinism (`tile-batch-coalescing.test.ts:311-899`), paged root/leaf hashing and point-query pruning (`paged-directory.test.ts:392-826`), page-fetch dedup on abort (`paged-scheduler-supersede.test.ts:264`), estimators (`throughput.test.ts`).
- **Missing**: a progressing-body-under-timeout test (NS-1); arrears-vs-tier across sources (NS-2); fallback concurrency bound (NS-3); intra-group delivery (NS-4); directory-page over-fetch bound (NS-5); an amplification bound (NS-6); page eviction (NS-8); 4xx classification (NS-9); any test that a `getTiles` batch above `perArchiveCap` keeps ≤ cap groups queued on the shared scheduler under a real (non-zero) coalesce gap.

## Checked and correct

- `fetchManifest` :2169-2280 — single-flight (`manifestPromise`), format/version/capability/variant validation before any tile fetch, retried with the same ladder; manifest is a plain GET with default cache mode (R2 serves `max-age=60, must-revalidate` per `scripts/r2-sync.sh:109`).
- `fetchAndBuildIndex` :2772-2846 — paged/whole decision `layout==='paged' && length > 256 KiB && rootLength && rootHash && pageHashes`; whole-load path verifies the blake3 content address (:2851-2866); paged path verifies root + every leaf hash before decompression (:2803, :3100).
- `decodePagedRoot` (directory.ts:132-269) — validates page count/entries against the manifest, monotone non-overlapping leaf ranges, bounds within payload; `decodeDirectory` :358-530 guards entry count vs remaining bytes before allocating.
- `ensurePagesForBounds` :3235-3271 — wrap-aware longitude intervals, ordered latitude band, shares `pageOverlapsQuery` with `unknownEntriesInBounds` :3349; `ensurePagesForTiles` :3373-3452 has a sound upper temporal prune (`tMin > t + maxBucketMs`).
- `fetchAndMergePages` dedup :3134-3232 — one in-flight promise per page, leftovers rejected in `finally` so waiters never hang (pinned by `paged-scheduler-supersede.test.ts:264`).
- `runGroupFetches` :4032-4200 — groups ranked by priority before dispatch (F10 fix); `perArchiveCap` runner keeps ≤ cap queued; caller-abort → scheduled-request abort, listeners detached on settle; first real error surfaces before an abort.
- `getTiles` :4205-4520 — coalescing is per pack (:4340-4368), members decoded concurrently, poisoned cache entries evicted on decode failure, `onTileReady` per member on both the group and fallback paths; `estimateSelectionCost` :3509-3560 mirrors the id-query filters exactly.
- `fetchObjectRange` :2402-2456 — rejects 200-for-Range, validates `Content-Range` and body length; latency sampled at header arrival including error statuses; lifetime + caller + timeout signals composed and cleaned up (:803-846, :849-887).
- `SharedRequestScheduler` — slot freed exactly once (`dispatch`/`done` :904-954), negative/NaN/throwing `getPriority` cancels without deadlock, `abortEntry` prunes bookkeeping for never-dispatched sources (:522-544), `clear` leaves the instance usable; `setSourceWeight` :511-514 applies immediately to queued work.
- `shared-scheduler.ts` — lazy singleton; `configureSharedScheduler` rebuilds on change (old instance drains); default 24 = per-archive default so a single archive is unchanged.
- `throughput.ts` — bias-corrected duration-weighted dual EWMA, dispersion tracked against the post-fold slow mean, `conservativeRateFromEstimate` is the one shared definition; `LatencyEstimator` sample-weighted (half-life 8 samples).
- `setMaxConcurrentRequests` :2089-2098 / `tileset-adapter.ts:76` — both halves of `maxRequests` reach the wire; layer constructs the archive with `maxConcurrentRequests: props.maxRequests` (spatiotemporal-layer.ts:1900).
- `setLoopWindow` :4533-4545 — storage only, degenerate ranges → null; `getTileByteSize` :3470 synchronous, `undefined` for non-resident pages.
- `MIN_DIRECTORY_VERSION` is defined twice (archive.ts:121 and directory.ts:44), both 5 — consistent today; worth collapsing to one export.
- Live CDN: h2 + h3, `accept-ranges: bytes`, CORS `*` with `Content-Range` exposed, packs `immutable`; `validateContentRange` is therefore live cross-origin.
- Coalesce gap on the fleet: every local manifest lacks `metadata.ordering_workload.coalesce_gap_bytes`, so `getCoalesceGapEstimate().source === 'no-build-gap'` and the gap is the 2 MiB constant everywhere (measured), exactly as CO-7's co-versioning guard intends.

## Doc ↔ code drift

- `archive.ts:757-765` calls `DEFAULT_TRANSFER_TIMEOUT_MS` a "per-transfer stall timeout" for "a TCP-stalled response"; the implementation is a total deadline from issue to last byte (NS-1). hls.js's `fragLoadingTimeOut` is comparable only because fragments are ABR-sized; STT groups are unbounded.
- `archive.ts:737-745`: a `'low'` group "ALWAYS ranks below any need-now group GLOBALLY across sources". False under DRR arrears (NS-2, measured).
- `archive.ts:229-232` ("The downside (larger single requests) is bounded separately by the per-fetch size cap"): no per-fetch size cap exists (grep `MAX_RANGE|sizeCap|maxRange` → none).
- `archive.ts:3944-3947` ("Data BEHIND the play-head … it's already been passed"): uses `timeStart`, so a bucket containing the playhead is "passed" (NS-7).
- `docs/api/playback-governor.md:282-291` and `docs/roadmap/playback-and-loading.md:164,358` describe `configureSharedScheduler({ enabled: false })` as the rollback kill-switch; no such option exists and there is no legacy runner (`archive.ts:4047` always uses the shared scheduler). The tests that pass `enabled` are vacuous (NS-T).
- `archive.ts:3133-3134` comment "shared scheduler when enabled, legacy cursor runner otherwise" — same nonexistent path.
- `spatiotemporal-tileset.ts:4031-4035` says the `AbortError` branch "also covers a timeout raised inside the transport"; a timeout that exhausts the archive's retries resolves to a `null` tile, not a rejection, so it is charged as a failure (`aborted=false` at :4051). Only a caller abort takes the exempt path.
- `measurements-2026-08.md` §9.1 "3–5 requests in every case" holds for the cases measured; it does not cover `nyc-taxi-paths` at its z14 demo camera (7 requests, directory-dominated) — the K10 harness (`cold-start-bench.mjs:67`) still lacks that row.
- `spatiotemporal-tileset.ts:1326` "R2 ~75 per-connection stream cap": unverified; Cloudflare's edge advertises its own `SETTINGS_MAX_CONCURRENT_STREAMS`, and the browser, not R2, terminates the h2 connection.

## Needs measurement

- **Busy-window closure during continuous playback on a throttled link.** If a priority batch always overlaps a prefetch slice, `activeTransferCount` never hits 0 and θ̂ goes stale for the whole stretch. Measure: install `__sttProbe`, run `/demo/nyc-taxi-paths` at 4× under Chrome "Fast 3G", and log `getThroughputEstimate().samples` per second; a flat counter for > 5 s while `requests` samples keep completing confirms it.
- **How often real cameras hit NS-6 scatter.** Replay `tools/bench/src/policy-record.mjs` traces for `earthquakes` and `ais-all-us` through `getTiles` with a counting fetch and report per-batch `packBytes / Σ length`; the `requests` probe cannot answer this today (no useful-bytes field — adding `usefulBytes` to `RequestProbeSample` is the cheap fix).
- **Session directory residency on the flagship demos.** Record `archive.getIndex().tiles.length` and `performance.memory` every 30 s over a 10-minute `/demo/nyc-taxi-paths` and `/demo/gtfs-ch` session with panning; this decides whether NS-8 needs eviction or only the per-entry diet.
- **HTTP/1.1 dev-server distortion of prior loading measurements.** Every `tools/render-test/probe-*.mjs` and `frame-cost.mjs` run defaults to `http://localhost:3000` (6-connection cap). Re-run one loading-sensitive probe against `https://tiles.poopdeck.gl` (h2) and compare request wall-time distributions before trusting any localhost queueing conclusion.
- **Manifest cache TTL on the live edge.** A HEAD of `gtfs-ch/manifest.json` returned `cache-control: max-age=60` while a GET returned `max-age=14400, must-revalidate` (`cf-cache-status: MISS`). If GETs really carry 4 h, `shipping.md`'s 60 s republish-visibility assumption is wrong; verify with two GETs from a fresh PoP.
- **Governor ETA under composites.** Wire `getThroughput` from each archive and log `getEtaMs()` vs observed time-to-ready on the weather suite; expected ETA over-estimate ≈ number of concurrently loading sources (NS-10).

---

# Appendix 6 — audit-decode

## Audit — DECODE PIPELINE (bytes → renderable tile, and the main-thread cost of it)

Date 2026-08-24. Read-only. All paths under `/Users/robertchristie/Documents/GitHub/spatiotemporal-tiles`.
Bench scripts used for evidence live in the scratchpad dir: `scan-zstd-headers.mjs`,
`bench-fzstd.mjs`, `bench-decode-phases.mjs`, `bench-mainthread.mjs`, `bench-clone.mjs`,
`bench-crc.mjs`, `bench-inline-decode.mjs` (all run against the REAL local fleet packs via the
core `dist/`, which is newer than `src/` for every file involved).

Note on the in-flight tree: `packages/core/src/tile-decoder.ts` / `tile-decoder.worker.ts` /
`test/tile-decoder.test.ts` are UNCOMMITTED and contain not only the `decompressMs/parseMs`
timing split the brief names but a full **BH-7 decode-batching** change (`decodeBatch`, 32 tiles /
512 KiB per message; `git show HEAD:packages/core/src/tile-decoder.ts | grep -c decodeBatch` → 0).
Findings D2 and D5 assess that in-flight work; they are not "bugs in main".

## Findings

### D1 [high] Every zstd frame in the fleet declares an 8 MiB window and no content size, so fzstd allocates + memmoves 8 MiB per tile — 69–92 % of decode service time across the fleet

**Where**

- Writer: `crates/stt-core/src/compression.rs:63-64` (`zstd::stream::encode_all(data, ZSTD_LEVEL)`) and `:134-146` (`compress_zstd_with_dict_level` → same `encode_all` when no dict). Streaming `Encoder` without `set_pledged_src_size` → frame header has `Single_Segment=0`, `Frame_Content_Size` absent, `Window_Descriptor` = the level's default window. `stt-build.rs:1325-1326` bumps publish builds to level 19 (windowLog 23 = 8 MiB).
- Reader: `packages/core/src/compression.ts:67-103` (`unzstdSync` drives fzstd's streaming `Decompress`); fzstd 0.1.1 `lib/index.js:95-116` (`rzfh`: `ws = window descriptor` when `!ss`; `buf = new u8(ws + 12)` for the streaming path; `m: Math.min(131072, ws)`), `:445` (`new u8(st.m)` per block), `:739` (`cpw(this.s.w, 0, blk.length)` = `copyWithin` over the whole 8 MiB window per block).
- Both decode paths go through it: `tile-decoder.worker.ts:176-180` and `tile-decoder.ts:177-181`.

**Mechanism** The directory gives the reader the exact payload size (`DecodeArgs.expectedUncompressedSize` is mandatory, `tile-decoder.ts:34-40`), but that size is only used as a bomb cap on the running total (`compression.ts:80-92`). fzstd sizes its history window from the FRAME HEADER, not from the caller, so with `ss=0 / fcf=0 / WD=8 MiB` it (a) allocates a zero-filled `8 MiB + 12` window for every frame, (b) allocates a 128 KiB block buffer per block, and (c) `copyWithin`s the whole 8 MiB window once per block. For a 529-byte earthquake frame that is ~16 000× the payload.

**Scenario** All (every archive). Dominant on small/medium tiles (earthquakes, goes-glm, ais, nyc-taxi-paths, gtfs-ch), still 2–4.6× on large tiles (satellites, storm4d-volume, drifters).

**Consequence** Measured with `bench-fzstd.mjs` / `bench-decode-phases.mjs` on real pack frames (Node 22, M-series laptop; production path = `unzstdSync`; "ss=1 header" = the same bytes with a synthesized single-segment header carrying the directory's size, decoding byte-identically 100 % of the time):

| archive (real frames)            | compressed → payload | production zstd | ss=1 header        | ratio | zstd share of whole in-thread decode     |
| -------------------------------- | -------------------- | --------------- | ------------------ | ----- | ---------------------------------------- |
| earthquakes                      | 529 B → 4.5 KB       | 0.211–0.315 ms  | 0.017 ms           | 12.6× | 69 %                                     |
| gtfs-ch                          | 112 KB → 374 KB      | 5.6 ms          | 2.5 ms             | 2.3×  | 87 % (on 17 KB frames)                   |
| satellites (large pack)          | 369 KB → 745 KB      | 26.6 ms         | 5.8 ms             | 4.6×  | 92 %                                     |
| storm4d-volume                   | 62 KB → 270 KB       | 4.2 ms          | 1.5 ms             | 2.8×  | 80 % (23 ms/tile total on 336 KB frames) |
| drifters (482 KB payload frames) | 255 KB → 482 KB      | 13.5 ms         | (presized: 8.0 ms) | ≥1.7× | —                                        |

`new Uint8Array(8 MiB+12)` alone = 160–215 µs; the 8 MiB `copyWithin` alone = 145–160 µs — i.e. ~0.35 ms of pure window overhead per BLOCK before any real decoding, which is exactly why a 1 KB tile costs ~3 ms "in-worker" in the BH-7 comment (`tile-decoder.ts:332-334`). Worker throughput today: earthquakes ≈ 2 170 tiles/s/worker (could be ≈ 6 000), storm4d-volume ≈ 43 tiles/s/worker (could be ≈ 130). The O1 "decode p95 191–553 ms" figures in `measurements-2026-08.md §10.5` include this term in their service component.

**Evidence** `scan-zstd-headers.mjs` over one pack each of earthquakes (5000 frames), drifters (2000), satellites (181), gtfs-ch (1866), nyc-taxi-paths (1235), storm4d-volume (637), ais-all-us (2000): **100 % `ss=0 fcf=0 window=8.00MiB`**. Rust source confirms no pledged size. fzstd source confirms window-sized allocation and per-block `copyWithin`. Benchmarks above.

**Fix** Two independent halves, both small:

1. READER (immediate, covers the shipped fleet, no rebuild): in `compression.ts:unzstdSync`, when `expectedSize` is known and the frame header has `ss=0`, `fcf=0`, `df=0`, synthesize a single-segment header (`FHD = 0x20 | fcf<<6`, preserve the checksum bit, 1/2/4/8-byte FCS = `expectedSize`) in front of the original block stream and hand THAT to fzstd. Semantically safe: without a dictionary no match offset can precede the frame start, so `Window_Size = Frame_Content_Size` is always sufficient; a wrong `expectedSize` fails the existing length check (`tile-decoder.ts:182-187`, `worker.ts:181-186`). Cost: one small concat of the compressed bytes. Blast radius: `compression.ts` only; `compression.test.ts:78-97` keeps pinning exact-size decode + bomb rejection.
2. WRITER (rides B2 republish): pledge the source size — `zstd::bulk::compress` or `Encoder::new(..)` + `set_pledged_src_size(Some(len))` + `include_contentsize(true)` — so frames carry `ss=1`/FCS natively. Not a format change (still plain zstd frames; spec says "zstd").
   Alternative reader-only lever: pass a presized output buffer to fzstd's one-shot `decompress(data, out)` — measured 3.3× on tiny tiles but only 1.2–1.7× on large ones; the header rewrite is strictly better.

**Confidence** high — header bytes read off every fleet pack, fzstd allocation sites read, decode timings measured on real frames, rewrite verified byte-identical on 400+ frames.

**How to verify** A `compression.test.ts` case that decodes a real fleet frame with a synthesized header and asserts identical bytes (fails today: no such path); a bench gate: `unzstdSync` on the earthquakes fixture frame ≤ 50 µs (today 210–315 µs). In-browser: `__sttProbe.decode[].decompressMs` p50 on `/demo/earthquakes` before/after.

---

### D2 [medium] BH-7 batches settle as a unit and are capped in COMPRESSED bytes, so first-tile decode latency on mid-size tiles grows ~8× (storm4d-volume: 23 ms → ~184 ms)

**Where** `packages/core/src/tile-decoder.ts:344` (`DECODE_BATCH_MAX_TILES = 32`), `:353` (`DECODE_BATCH_MAX_BYTES = 512*1024`, measured against `costBytes = compressed.byteLength` at `:646`, `:770`), `:741-771` (batch assembly), `:784-802` (slot frees only when the LAST member settles); worker `tile-decoder.worker.ts:263-268` (one synchronous loop, ONE reply per batch).

**Mechanism** The byte cap is meant to "bound FIRST-TILE latency" (`:347-352`) but is denominated in compressed bytes, while service time scales with payload bytes × decode rate. For storm4d-volume (66 KB compressed → 336 KB payload, 23 ms/tile measured) a batch holds 8 tiles = 184 ms before the most-urgent member resolves; for mrms-storm3d (11 k features/tile) similar or worse. The reply is a single message, so the host cannot deliver member 1 before member 8 decodes. Before BH-7 the same tile resolved after its own 23 ms.

**Scenario** Playback/seek/pan on volumetric and path archives with 20–100 KB compressed tiles (`storm4d-volume`, `mrms-storm3d-volume`, `satellites`, `gtfs-ch` 17 KB frames → 30-tile batches of ~1.2 ms = 36 ms). Tiny-tile archives are the intended win and are fine.

**Consequence** Seek/pan time-to-first-tile +160 ms on storm4d-volume; during playback the runway fills in coarser steps (nothing renders from a batch until all of it is parsed). Also the reply's structured-clone deserialization is concentrated in one main-thread task: 30 gtfs-ch tiles × ~50 µs ≈ 1.5 ms, 32 satellites tiles × ~120 µs ≈ 4 ms per message (see D3 for the string share).

**Evidence** Decode-phase timings (`bench-decode-phases.mjs`): storm4d-volume 23.1 ms/tile in-thread, 66 KB compressed → 512 KiB/66 KB = 7.8 tiles per batch. Test `tile-decoder.test.ts:1615-1638` pins the cap in compressed bytes (256 KiB tiles → ≤3 per batch) — it would pass unchanged with a payload-based cap only if the fixture's `expectedUncompressedSize` is used.

**Fix** Cap the batch by ESTIMATED SERVICE TIME rather than compressed bytes: `Σ expectedUncompressedSize` (already on every job message, `:632`) against a budget of ~256 KiB payload, or better `serviceEwmaMs`-per-payload-byte × Σ payload ≤ ~16 ms. Optionally have the worker reply per member (or flush a partial `responses[]` whenever accumulated `handlerMs` exceeds ~16 ms): the host→worker hop stays batched (that is where the courier cost was) and first-tile latency returns to single-tile service. Blast radius: `tile-decoder.ts:741-771` + worker `:263-268`; update `tile-decoder.test.ts:1615-1638`.

**Confidence** medium-high — arithmetic from measured service time and the constants; not yet observed in-browser (see Needs measurement).

**How to verify** `__sttProbe.decode[]` on `/demo/storm4d-volume` after a seek: distribution of `ms − queueWaitMs` (service+batch wait) — today's p50 should be ≈ N×23 ms; after the fix ≈ 23 ms. A unit test: 8 jobs each `expectedUncompressedSize = 336 KiB`, `compressed = 66 KiB` → first batch must contain ≤ 2 items.

---

### D3 [medium] Hoisted category tables are shared by identity only INSIDE the worker; structured clone re-materialises every `categories: string[]` per tile on the main thread (M2 sharing defeated), costing 30–70 µs/tile of deserialization and ~90 KB/tile resident on `satellites`

**Where** `packages/core/src/tile.ts:203-216` (cache keyed on the TEMPLATE REGISTRY object — the worker's own copy), `:274-303` (`sharedCategoryTable` returns the same `string[]` instance per `(templateHash, column)`), `:2099-2123` (used by `tableToBinaryFeatures`); the worker strips only `arrowTable` before `postMessage` (`tile-decoder.worker.ts:204`) and `collectTransferables` transfers buffers only (`tile-transferables.ts:78-84`: "category-string table is plain JS strings"); host `settleResponse` resolves the cloned tile as-is (`tile-decoder.ts:937`). `estimateTileSize` charges every tile for its private copy (`archive.ts:1695-1697`).

**Mechanism** Structured clone has no identity sharing across messages, so each tile's `categories` array (satellites: `intl_designator` 1 146 + `object_name` 1 146 + `orbit_type` 4 = 2 296 strings per tile; gtfs-ch: 371) is serialized in the worker and deserialized into fresh string objects on the main thread, per tile. The WeakMap cache in `tile.ts` therefore saves time in the worker but nothing on the main thread, which is where residency is paid.

**Scenario** Large archives with hoisted (dataset-global) dictionaries: `satellites`, `gtfs-ch`, `nyc-taxi-paths` (`agency_id`, `route_*`, `object_name`...). Small archives unaffected.

**Consequence** Measured (`bench-clone.mjs`, no transfer so buffer copies are included but tiny): gtfs-ch clone 52 µs/tile → 21 µs with categories emptied; satellites 120 µs → 48 µs. Resident: `estimateTileSize` values it at ~92 KB/tile on satellites (`c.length*2+16` per string); at the 2000-tile cache cap that is ≈ 180 MB of duplicated strings on the main thread, plus GC pressure per batch reply (32 tiles × 2 296 strings). `hoisted-category-sharing.test.ts` pins the inline path only (no `postMessage`/`structuredClone` reference anywhere in the file).

**Evidence** Code reads above; clone bench; category counts read off decoded fleet tiles.

**Fix** Re-share on the host: have the worker send, for a hoisted column, `{ indices, categoriesRef: `${templateHash}:${column}` , categories? }` where `categories` is included only the FIRST time a worker sees a ref (worker keeps a `sent` set per ref), and the host keeps `Map<ref, string[]>` and patches `entry.categories` before `resolve`. Because refs are content-hash-derived and workers are re-spawned, the host must accept a repeated full copy and keep the first. Blast radius: `tile.ts` (attach `propsTemplateHash` to the entry — it is already known at `:2112`), `worker.ts:204-206`, `tile-decoder.ts:937`; `estimateTileSize` should then skip strings for shared entries. Add a worker-path test using the `FakeWorker` harness that asserts identity across two settled tiles.

**Confidence** high on mechanism; medium on the exact resident number (V8 string layout; `estimateTileSize` is an estimate).

**How to verify** `tiles[0].layers[0].features.categoricalProps.object_name.categories === tiles[1]...categories` on two worker-decoded satellites tiles (false today). Heap snapshot on `/demo/satellites` at 2000 resident tiles: string count.

---

### D4 [medium] The pool-wide host queue is fully re-sorted (O(n log n), Map-lookup comparator) on every pull, and every enqueue marks it dirty — up to ~1.5 ms per pull at 1 000 queued, i.e. ~25–35 % of the main thread while a tiny-tile burst drains

**Where** `packages/core/src/tile-decoder.ts:648-651` (every `decode()` pushes + sets `hostQueueDirty`), `:696-710` (`sortHostQueue`: `Array.prototype.sort` over ALL ids with two `Map.get` per compare), `:731-733` (called at every `pullNext`), `:659-668` (`removeFromHostQueue`: `indexOf` + `splice`, O(n) per cancel).

**Mechanism** Under load workers are busy, so enqueues accumulate (up to `MAX_COALESCE_BATCH` 1024 per `getTiles` call, `spatiotemporal-tileset.ts:59,3674-3680`, and prefetch slices of the same size, `:3686-3703`); each worker completion triggers `pumpQueue → pullNext → sortHostQueue`, which sorts the whole backlog again even though only the head is consumed and only the newly pushed ids are unordered.

**Scenario** Large tiny-tile archives on pan/seek: `earthquakes` (350 k tiles), `hurricanes`, `ais-all-us`, `goes-glm-lightning`. With BH-7 a pull happens every ~16 ms per worker (32 × 0.46 ms), i.e. every ~4 ms across 4 workers.

**Consequence** Measured (`bench-mainthread.mjs`): sorting 1 000 queued ids with the production comparator = 0.2–1.45 ms per pull (JIT-state dependent). At one pull per ~4 ms that is 5–35 % of the main thread for the ~130 ms it takes to drain a 1 024-tile batch, repeated per batch during a z10 pan. A mass cancel of a 1 000-deep queue costs O(n²) splices (~1–3 ms) — tolerable.

**Evidence** Code; bench.

**Fix** Replace `hostQueue: number[]` + lazy sort with a binary heap ordered by the same `(priority, costBytes, requestId)` total order; lazy deletion on cancel (the pull loop already skips ids missing from `queuedDecodes`, `:750`). Keeps the DETERMINISM test (`tile-decoder.test.ts:728`) and (2)/(3)/(3b) green since the order is unchanged. Blast radius: `tile-decoder.ts` only.

**Confidence** medium — the per-pull cost is measured; the queue depth of ~1 000 is inferred from the batch constants, not observed.

**How to verify** `performance.measure` around `sortHostQueue` in a dev build on `/demo/earthquakes` while panning at z10 (`decodeQueue` snapshot `pending` shows depth). Unit bench: 1 000 enqueues + 32 pulls under 1 ms total after the change.

---

### D5 [low] The worker-side mid-flight cancel checkpoint (M6/BH-5) is unreachable by construction; every mid-flight cancel leaks an entry in `cancelledRequestIds`; the tests pin it through a `FakeWorker` that can emit a cancel ACK the real worker never produces

**Where** `packages/core/src/tile-decoder.ts:753-775` (`activeRequestIds.add` + `postMessage(batch)` in the same synchronous call), `:677-682` (`postCancel` only for ACTIVE requests → the cancel is always posted AFTER the batch message), worker `tile-decoder.worker.ts:187-192, 228-232` (checks the set after decompress), `:252-255` (adds to the set), `:132-140` (comment: "harmless, never-revisited entry ... not worth pruning"), `:257-262` (comment admits cancels during a batch are unobservable). Tests `tile-decoder.test.ts:591` ("the worker's cancel ACK frees its slot") and `:565`.

**Mechanism** A worker's inbox is FIFO and the batch handler is one synchronous task. The `cancel` message is necessarily enqueued behind the `decodeBatch` message that carries the request, so the worker always finishes the batch (and posts the normal response) before it reads the cancel. The `cancelledRequestIds.delete(requestId)` checks are therefore always false; the set grows by one integer per mid-flight cancel for the worker's lifetime. This was already true before BH-7 (single job per worker, same ordering).

**Scenario** All; cost is negligible per event (bounded by `activeRequestIds`), so severity is documentation/test hygiene plus a slow leak on long sessions with many pans.

**Consequence** No decode work is ever saved by the mid-flight cancel; "in-flight decode is cancelled mid-pool" (`DecodePipeline.tsx:424`) is false; the host-queue cancel (real, `:601-617`) is the only cancel that saves work. Host side remains correct: late results for aborted requests are dropped (`:919-945`) and the slot is freed by the normal response, not the ACK.

**Evidence** Ordering argument above; no `await`/yield in the worker handler; `FakeWorker.respondCancelled` (`test:81-85`) is the only producer of a cancel ACK.

**Fix** Delete the worker-side set and ACK path (and the `postCancel` message), keep host-queue removal; or, if a real mid-batch cancel is wanted, publish cancelled ids through a `SharedArrayBuffer` flag the worker polls between members. Rewrite the docs/tests accordingly.

**Confidence** high.

**How to verify** A real-worker integration test (node `worker_threads` with a `Worker` shim) that aborts an active request and asserts the worker's normal response arrives (never `cancelled:true`).

---

### D6 [low] Warm-path decodes (byte-cache hit, OPFS hit, single `getTile`) carry no priority and default to 0 = most urgent, ahead of every network tile the play-head needs

**Where** `packages/core/src/tile-decoder.ts:93-99` (`DEFAULT_DECODE_PRIORITY = 0`), `archive.ts:4236-4249` (byte-cache hit `decodeBytes(..., signal)` — no priority), `:3708-3737` (`decodeDecompressed` has no priority parameter at all), `:3826-3833` (`getTile`), versus network members `:4456-4471` which pass the group's EDF priority (`tierBase + distance-to-playhead`, `groupSchedulerPriority`).

**Mechanism** A prefetch-tier batch whose bytes are already warm decodes at 0 while a cold priority-tier tile arriving later sorts behind it (`priority` ascending, `:706`). Under OPFS the warm payload is the DEcompressed size, so the secondary shortest-job-first key also orders by payload rather than by the play-head.

**Scenario** Mixed warm/cold sessions on large archives (second visit with OPFS on; byte-cache hits after a loop wrap). The showcase does not enable `opfsCache` (no `opfsCache` prop anywhere in `examples/showcase/src` or `packages/layers/src`) and the byte cache is documented at ~0 % hit rate, so this is LATENT in the showcase today.

**Consequence** Up to one prefetch slice (≤ 1 024 tiles) of warm decodes ahead of the needed tile: e.g. 1 024 × 0.46 ms / 4 workers ≈ 120 ms on earthquakes, several seconds on storm4d-sized payloads.

**Evidence** Code reads above; `DecodeArgs.priority` doc (`:75-89`) explicitly calls the warm callers "the interactive class", which is only true for `getTile`.

**Fix** Thread the same `groupSchedulerPriority`-style value (distance-to-playhead from `options.playheadTime`) through the two warm branches in `getTiles` and add a `priority` parameter to `decodeDecompressed`; keep 0 for the single-tile `getTile`. Blast radius: `archive.ts` two call sites.

**Confidence** high on mechanism, low on showcase impact (OPFS off).

**How to verify** Unit test on `WorkerTileDecoder` with a byte-cache-hit decode (no priority) enqueued after a network decode with priority 5 000 while the pool is busy: today the warm one is pulled first.

---

### D7 [low] `InlineTileDecoder` telemetry reports `decompressMs` as wall time across an `await`, so under concurrent `getTiles` it is queue time, not service time

**Where** `packages/core/src/tile-decoder.ts:169-189` (`t0` before `await decompress(...)`, `tDecompress` after), `compression.ts:111-117` (`decompress` is `async` over a sync body).

**Mechanism** Every `await` yields to the microtask queue; with `getTiles` issuing all member decodes in one loop (`archive.ts:4453-4479`), each tile's `decompressMs` includes every other pending tile's synchronous work.

**Consequence** Misattribution in Node tooling / SSR / worker-less fallback: `bench-inline-decode.mjs` on earthquakes via `archive.getTiles` (64-way) reported `decompressMs` mean **34.3 ms** (p95 60 ms) for work that is 0.3 ms per tile when measured synchronously. Anyone reading the `decode` probe on the inline path will diagnose "zstd is slow" for the wrong reason (it is — see D1 — but 100× less so).

**Fix** Call `decompressSync` in `InlineTileDecoder` (no behavioural change; the function is already sync underneath) or stamp `t0` after the await.

**Confidence** high.

**How to verify** Same script; `decompressMs` mean should fall to ≈ 0.3 ms.

---

### D8 [low] Small-archive first-decode cliff and steady-state pool shrink: four 477 KB worker boots gate the first tile, with no inline path while they boot; the controller can retire workers mid-playback and re-pay spawns on the next seek

**Where** `packages/core/src/archive.ts:2105-2110` (decoder created lazily on the first decode), `tile-decoder.ts:479-492` (initial size `min(4, cores−1)`, all spawned synchronously), `:495-513` (`spawnWorker` + registry broadcast per spawn), `:391-400` + `:363` (shrink after 5 s idle when `queueWait < 0.25 × service`, one per 8 completions, floor 1), `:808-833` (resize evaluated only on completions; grow one per evaluation), `:1051-1068` (inline fallback ONLY when `Worker` is undefined/throws). Bundle: `packages/core/dist/tile-decoder.worker.js` = 477 418 bytes (apache-arrow + fzstd + tile.ts).

**Mechanism** For `storm4d-sounding` (4 tiles) or `bixi-flowmap` (59 tiles) the first decode waits for worker #1 to fetch/parse ~0.5 MB of module JS; the other three spawns compete for CPU on 2–4-core devices. During light steady playback the most-idle worker exceeds 5 s idle and queue-wait is ~0, so the pool shrinks one worker per 8 completions toward 1; the next seek burst then grows one worker per ≥ 8 completions, each paying a fresh boot + registry clone.

**Scenario** Small demos (time-to-first-frame) and any demo after a quiet stretch followed by a seek.

**Consequence** Estimated 50–150 ms (desktop) / 200–500 ms (mobile) before the first tile of a small demo can resolve; seek bursts served by a 1-worker pool for the first ~100–400 ms. Not measured in-browser (see Needs measurement).

**Fix** (a) Decode inline on the main thread while `pending.size === 0 && workers not yet booted` for payloads under ~64 KB, or spawn one worker eagerly at archive open (`getIndex`) so the boot overlaps the directory fetch; (b) do not shrink while `isAnimating` (the tileset already knows), or raise `POOL_SHRINK_IDLE_MS` to ~30 s. Blast radius: `tile-decoder.ts` controller inputs; tests `:973-999` (idle shrink) would need the new input.

**Confidence** medium (mechanism certain; magnitudes estimated).

**How to verify** `__sttProbe.decode[0].ms` vs median on `/demo/storm4d-sounding` cold; `getPoolStats().poolSize` sampled every second on `/demo/gtfs-ch` playback then a seek.

---

### D9 [low] CRC-32C is a byte-at-a-time table loop (~160 MB/s), adding ~10 % serial service time on large tiles (32 ms for a 5 MiB frame)

**Where** `packages/core/src/crc32c.ts:32-38`; called before every decompress on both paths (`worker.ts:173-175`, `tile-decoder.ts:174-176`).

**Consequence** Measured (`bench-crc.mjs`): 5 µs @ 512 B, 79 µs @ 33 KB, 4.7 ms @ 745 KB, 32 ms @ 5 MiB. In the worker, so no main-thread cost, but serial per tile: satellites' 369 KB frames pay 2.3 ms on top of 26.6 ms (D1); drifters' largest tiles pay tens of ms.

**Fix** Slicing-by-8 tables (~3–4× in JS) — 40 lines, same known-answer test (`crc32c.test.ts`). Only worth doing after D1.

**Confidence** high (measured).

---

### D10 [low] Compressed bytes are copied twice on the main thread per tile (`buffer.slice` for the byte cache, then `slice(0)` for transfer) — the second copy only protects a cache with a known ~0 % hit rate

**Where** `archive.ts:4457-4458` (`buffer.slice(rel, rel+len)` + `storeBytes`), `tile-decoder.ts:764-769` (`queued.compressed.slice(0)` at pull, "keep its byte cache intact"), worker header comment `worker.ts:12-14`.

**Consequence** 0.3 µs (earthquakes) … 3 µs (satellites) … ~1–2 ms per multi-MB drifters tile of main-thread memcpy, and 3 transient copies of every compressed tile (range buffer, cache slice, transfer copy). Minor; recorded because "is any array sliced before transfer?" was an explicit question — yes, exactly this one, and nothing on the worker side.

**Fix** If the byte cache stays ineffective under the decoded-tile cache (known open item), transfer the cache's own buffer and drop the entry (or store nothing) — a loader-dimension decision; the decoder change is one line.

**Confidence** high.

## Answers to the brief's numbered questions (with numbers)

1. **Per-tile fixed overhead (earthquakes, 529 B → 4.5 KB, 1–2 features).** Worker: CRC 5 µs; zstd 211–315 µs (≈ 300 µs of it is the 8 MiB window, D1); `decodeTile` 143 µs (`tableFromIPC` 49 µs + merge + binary extraction 94 µs); `collectTransferables` 3 µs; clone serialize ≈ 7 µs. Host (main thread): enqueue ≈ 3–5 µs; pull `slice(0)` 0.3 µs + amortised sort 6–45 µs/tile at 1 000 queued (D4); reply deserialize ≈ 7–14 µs; settle/telemetry/microtasks ≈ 5 µs; archive `deliver`/`storeBytes` ≈ 3 µs; tileset `deliverTile` + `estimateTileSize` 5 µs (measured) + rAF-coalesced `onTileLoad`. **≈ 30–70 µs/tile ⇒ at 300 tiles/s ≈ 9–21 ms/s of main thread (1–2 %)** plus the transient sort spikes of D4. Batching: YES in the uncommitted tree (BH-7, 32 tiles / 512 KiB compressed per message, `tile-decoder.ts:322-353`); the BH-7 comment's "22 ms transit" is per-message host event-loop latency, which is why batching helps; it is not host CPU. The decoder host side is therefore NOT where the main thread goes on tiny-tile archives; per-tile sublayer creation in the layers is (known, out of scope).
2. **Large tiles.** Measured in-thread decode: storm4d-volume 23.1 ms/tile (336 KB payload, 9.4 k features; 80 % zstd), satellites large-pack frames 26.6 ms (745 KB), drifters 482 KB-payload frames 13.5 ms (+ CRC 2–5 ms). No prior recorded numbers exist: `pre-tessellated-bench.test.ts` only asserts triangle-count parity and a size bound, `cost-oracle.bench` does not time decode, `measurements-2026-08.md` records only queue-wait p95 (191–553 ms). A 50–100 ms decode blocks nothing on the main thread; it holds one worker, one fetch slot (`archive.ts:4456-4479` awaits member decodes inside the group) and — under BH-7 — every batch-mate (D2). Transfer IS zero-copy: `collectTransferables` returns the deduped buffer set (`tile-transferables.ts:87-119`), the worker dedups across the batch (`worker.ts:162-166`), and no worker-side array is sliced before transfer. The only pre-transfer copy is the host `slice(0)` of COMPRESSED bytes (D10). `featureIds` is materialised in the worker by `forEachBufferView` reading the lazy accessor (`tile.ts:1741-1776`), so it rides the transfer list too.
3. **Main-thread work after the worker.** O(1)/O(fields) per tile: `settleResponse` (`tile-decoder.ts:902-945`), `applyIpcRetention` (`archive.ts:3790-3810`, O(layers)), `estimateTileSize` (`archive.ts:1674-1701`, O(buffers) + O(category strings) — 2–5 µs), `deliverTile` (`tileset:3947-3958`), `_scheduleTileLoadUpdate` (rAF-coalesced, `spatiotemporal-layer.ts:1493-1521`), `notifyBufferChange` (throttled). O(features) per tile, ONCE per (tile, styleKey) and cached (`animated-point-layer.ts:1772-1790` `preparedTileCache`): `padPositionsTo3D` (fresh Float64Array(count×3), `:1851-1857`, def `:3189`), `categoryIndicesToFloat32` (Uint16→Float32, `category-color-extension.ts:83-110`), CPU colour expansion (`coreExpandCategoricalColors` / rgb columns / ramp, `:1930-2040`), `radiusTransform` loop (`:2047-2052`), plus deck's own fp64 split of Float64 positions at upload. Interp/glide mode additionally runs `getFeatureProperties` per feature once per tile (`:2820-2832`). Nothing O(features) runs per FRAME on the decode/prepare side; the per-render `prepareTile` hit path is O(1) but allocates a `tilePrepare` probe payload per tile per render (`:1781-1786`) even with the probe off (`emit` gates AFTER the literal is built, `telemetry.ts:212-214`). `arrowTable` is never rehydrated on the render path: `toGeoArrowTable` has zero callers outside `core` (grep over `packages/*/src`, `examples/showcase/src`), and `applyIpcRetention` 'auto' drops the IPC for quantized layers anyway. Candidates to move into the worker: 3-D position padding and the Uint16→Float32 category cast (both pure functions of the tile); low value because they are once-per-tile.
4. **Pool sizing.** Initial `min(4, cores−1)` (8-core laptop → 4, 2-core mobile → 1, `hardwareConcurrency` absent → 4 → 3), adaptive within `[1, cores−1]` (`tile-decoder.ts:467-484`, `:381-401`): grow when `queueWait > 1.5 × service` (≥ 1 ms), shrink after 5 s idle when `queueWait < 0.25 × service`, ≥ 8 completions between decisions, one worker per decision. Never shrinks to 0, so no re-spawn on the next seek unless it shrank toward 1 (D8). fzstd is pure JS (no WASM compile); per-spawn cost is the 477 KB module load + a structured clone of the template registry (`:509-511`), paid per spawn AND per crash-respawn.
5. **Priority + cancel.** Host-queued decodes for stale buckets are removed BEFORE dispatch with no worker traffic (`:601-622`, tests `:394`, `:703`); active ones cannot be preempted and the worker-side checkpoint is dead (D5). Host drops late results (`:919-945`), tileset guards `isCancelled`/`isLoaded` on delivery (`:3947-3950`, `:3819`), archive rethrows AbortError instead of caching a null (`:4472-4479`) — no zombie insert.
6. **Backpressure.** In-flight decodes are bounded by the 24 shared scheduler slots × members per group because a group's slot is held until its member decodes settle (`archive.ts:4456-4479`), and by `MAX_COALESCE_BATCH` 1024 per `getTiles`; the decode queue orders by the SAME EDF value the network stage used (`groupSchedulerPriority`, `archive.ts:~4392`, forwarded at `:4083`/`:4467` → `tile-decoder.ts:643-645`, sort `:696-710`), so a head-adjacent tile arriving behind 400 prefetch decodes waits at most one batch (≤ 32 tiles / 512 KiB) — except for the warm paths (D6) and the sort cost (D4). The coupling also means decode throughput throttles fetch throughput on decode-bound archives (storm4d-volume: ~170 tiles/s ≈ 11 MB/s compressed on 4 workers) — correct for memory, and D1 raises that ceiling ~3×.
7. **Small datasets.** A pool IS created (lazily, at the first decode) for a 4-tile archive: 4 workers on ≥ 5 cores, each booting the 477 KB bundle; the sync fallback is used only when `Worker` is undefined or its constructor throws (`:1051-1068`; tests `:1515`, `:1521`) — never on size. No WASM cliff; the module-boot cliff is D8.
8. **Tests.** Pinned: host-queue ordering/determinism, crash isolation, registry distribution, batching by count/bytes, per-member settle, CRC gate + length gate, bomb cap, transferables list drift-guard, hoisted identity (inline path). Vacuous/misleading: `:591` cancel-ACK slot free and `:565` (real worker never ACKs — D5); `:1615` pins the compressed-byte cap (D2). Missing: any real-worker integration test (all decoder tests use `FakeWorker`, so zero-copy transfer, structured-clone shape and the categories identity loss are untested — D3); no decode-time/perf gate on a real fleet frame (D1 went unnoticed); no test that inline `decompressMs` is service time (D7); no test that warm-path decodes carry the play-head priority (D6).

## Checked and correct

- Zero-copy return path: `collectTransferables` dedups by buffer and enumerates every `BinaryFeatures` buffer via the shared `forEachBufferView` (`tile-transferables.ts:49-119`); drift guard `tile-transferables.test.ts:303-339`.
- Worker batch reply dedups transferables across members and returns the payload buffer without a second copy (`tile-decoder.worker.ts:154-166, 219-225`).
- `arrowTable` stripped before `postMessage` (`worker.ts:204`); rehydration exists but has no render-path caller; `applyIpcRetention` is O(layers) (`archive.ts:3790-3810`).
- Cancel-before-dispatch removes the job with no copy and no worker message (`tile-decoder.ts:601-622, 659-668`); copy-at-pull not copy-at-enqueue (`:764-769`, test `:665`).
- Late/aborted responses never double-settle and always free the slot (`:919-945`); tileset delivery guards (`spatiotemporal-tileset.ts:3819-3822, 3947-3958`).
- Worker crash fails only the active batch; host-queued jobs survive and the replacement gets the registry first (`:947-988`, `:505-511`).
- Pool bounds `[1, cores−1]`, one spawn per decision, EWMA controller pure and tested (`:381-401, 808-849`).
- Decode priority = fetch-stage EDF priority for network members (`archive.ts:4456-4471`), sort key `(priority, costBytes, requestId)` deterministic (`:696-710`).
- Fetch slot held until member decodes settle ⇒ bounded in-flight decode memory (`archive.ts:4453-4479`).
- CRC verified before decompress on both paths, identical error text (`crc32c.ts:46-56`; `worker.ts:173-175`; `tile-decoder.ts:174-176`).
- Decompression-bomb cap honours `expectedUncompressedSize` and the 512 MiB ceiling (`compression.ts:67-93`); exact-length authority check after decode (`tile-decoder.ts:182-187`, `worker.ts:181-186`).
- v2 frame parse: `tableFromIPC` is only 0.05–0.4 ms/tile even on 9 k-feature tiles (measured); TB-12 earcut backfill runs in the worker inside `tableToBinaryFeatures` (`tile.ts:1936-2010`), not on the main thread.
- `featureIds` lazy accessor is forced in the worker by `forEachBufferView` and transferred (`tile.ts:1741-1776`, `tile-transferables.ts:57`); `featureIds64` is a copy so it does not pin the IPC buffer (`tile.ts:1836-1837`).
- `estimateTileSize` dedups buffers and counts the retained IPC (`archive.ts:1674-1701`); incremental cache byte accounting (`tileset:3823-3826, 3950-3952`).
- Layer-side `prepareTile` is cached per `(tile, styleKey)`; `buildTileData` runs once per tile, not per frame (`animated-point-layer.ts:1772-1790, 1802-2124`); `onTileLoad` → `setState` is rAF-coalesced (`spatiotemporal-layer.ts:1493-1521`).
- Telemetry `emit`/`recordDecodeWait` are no-ops with the probe off and the wait ring is throttled (`telemetry.ts:197-214, 270-272`).
- Template registry union-merged on host and worker; re-sent on every spawn/respawn (`tile-decoder.ts:108-115, 523-529`; `worker.ts:243-251`).
- Shared process-wide pool via leases; finalized only when the last archive releases (`tile-decoder.ts:1001-1068`).
- Inline fallback shape (`createDefaultTileDecoder`) and the `DOMException('AbortError')` cancellation contract (`request-scheduler.ts:153-161`).

## Doc ↔ code drift

- `examples/showcase/src/components/how/DecodePipeline.tsx:9-19, 307-310, 447`: "pool sized max(2, min(4, cores−1)), least-pending pick" — code: initial `min(4, cores−1)` with floor 1, adaptive `[1, cores−1]`, ONE pool-wide host queue (BH-5), no per-worker assignment.
- Same file `:341-359` "OPFS hit → straight back to UI (skips workers)" — code: OPFS payloads go through the worker pool via `decodeDecompressed` (`archive.ts:3708-3737`); only the zstd step is skipped.
- Same file `:416-424` and `tile-decoder.worker.ts:132-140, 187-192` "in-flight decode is cancelled mid-pool / skips the expensive half" — unreachable (D5).
- `docs/roadmap/optimization-implementation-plan-2026-08.md:426` names **BH-7** "Loop-aware eviction rotation + byte-density scoring"; the uncommitted code uses **BH-7** for decode batching (`tile-decoder.ts:325-353`). ID collision.
- `tile-decoder.ts:325-338` attributes ~22 ms per message to "pure cross-thread latency"; the host-side per-message CPU measured here is tens of µs — the 22 ms is almost certainly main-thread event-loop occupancy (rAF work) delaying the reply's task. The conclusion (batch) still holds; the attribution should say so (see Needs measurement).
- `compression.ts:5-10, 49-51` "fzstd ... no WASM" is true, but `compression.ts:60-65` claims driving the streaming `Decompress` is "performance-neutral for valid data" — false for this fleet's frames: streaming cannot presize and pays the 8 MiB window per block (D1).
- `DecodeArgs.priority` doc (`tile-decoder.ts:75-98`) calls byte-cache/OPFS hits "the interactive path"; for batch prefetch they are not (D6).
- `tile-decoder.ts:12-14` "inline decode of one tile is ~5–20 ms" — measured 0.46–1.3 ms for typical fleet tiles, 23 ms for storm4d-volume; the range is stale but not wrong in spirit.
- `measurements-2026-08.md` O1 row (`:1201`, `:1290`) reports queue-wait p95 only; the service component that D1 removes (~70–90 %) is not separated there — the new `decompressMs/parseMs` split will show it.

## Needs measurement

- In-browser worker service time per archive before/after the header rewrite (D1): `__sttProbe.decode[].decompressMs` p50/p95 on `/demo/earthquakes`, `/demo/storm4d-volume`, `/demo/satellites` — expect ~12× / ~3× / ~4.6× drops respectively.
- The "22 ms transit" attribution: record Long Tasks (`PerformanceObserver`) alongside `decode` samples; if `ms − handlerMs − queueWaitMs` correlates with main-thread task length, batching's benefit is bounded by rAF occupancy and per-member replies (D2) cost nothing extra.
- BH-7 first-tile latency on `/demo/storm4d-volume` after a seek: distribution of `ms − queueWaitMs` per tile (expect ≈ 184 ms today vs 23 ms single-tile).
- Host-queue depth during a z10 pan on `/demo/earthquakes`: `decodeQueue` snapshot `pending` and time in `sortHostQueue` (D4) — settles whether the ~1 000-deep backlog assumed there is real.
- Pool dynamics: `getPoolStats().poolSize` every 1 s across a `/demo/gtfs-ch` play → seek sequence; time from spawn to first completion per worker (D8).
- Main-thread resident strings for hoisted categories at 2 000 tiles on `/demo/satellites` (heap snapshot; D3).
- Whether the showcase's production Vite build ships the same ~477 KB worker chunk (affects D8's cliff estimate).

---

# Appendix 7 — audit-layer-consumption

## Audit — how the render layers consume the tileset (deck chassis + three / maplibre / cesium)

Scope: `packages/layers/src/layers/spatiotemporal-layer.ts` (chassis), the per-kind
`renderLayers` in `packages/layers/src/layers/{core,trips,summary}/*`, the
`TimeFilterExtension`, the cache-key helpers, and the three / maplibre / cesium
consumers. Read-only; one bounded Playwright measurement (script + JSON in this
scratchpad: `probe-layer-consumption.mjs`, `probe-storm4d-iso.json`,
`probe-flow-riders.json`). deck internals cited from
`node_modules/.pnpm/@deck.gl+core@9.3.2/node_modules/@deck.gl/core/src/lib/*` and
`@deck.gl+layers@9.3.2…/src/solid-polygon-layer/polygon-tesselator.ts`.

Repo root abbreviated as `R/`. Chassis = `R/packages/layers/src/layers/spatiotemporal-layer.ts`.

## Answers to the eight questions (evidence-backed summary; findings below carry the detail)

1. **Per-frame cost, playback, no camera change (deck).** A tick that does not cross
   `getEffectiveTimeWindow()/20` of sim time AND 100 ms of wall clock costs exactly
   `_currentTime = t` + `setNeedsRedraw()` (chassis :1403-1481). deck then draws every
   cached sublayer: per model one `TimeFilterExtension.draw()` that pushes ONLY
   `currentTime` after the first full push (`R/packages/layers/src/extensions/time-filter-extension.ts`
   :876-919) plus the luma draw. **No `getVisibleTiles()`, no `renderLayers()`, no
   O(features) CPU work** on that path. At most 10×/s the throttled block runs
   `tileset.update()` (a full `selectAndLoadTiles` — the identical-params fast path
   never hits while time moves, see F2) + `getVisibleTiles()` (cover pass over the
   needed set, `R/packages/core/src/spatiotemporal-tileset.ts` :5592-5860) + the
   O(visible) `_tilesChanged` set diff (:1558-1571). Exceptions that force a
   `renderLayers()` per tick: `AnimatedTripHeadsLayer` (:482-487 of
   `R/packages/layers/src/layers/trips/animated-trip-heads-layer.ts`; O(resident tiles
   in range) + `computeHeads` O(active trips)), bounding-box / mesh (per advanced tick),
   point / icon glide (only when interpolation is on), heatmap / hexagon (30 Hz),
   flowmap (5 Hz), h3 / quadbin (per sub-bucket crossing). Any composite `setState`
   makes deck re-match the WHOLE layer tree next frame (composite-layer.ts :50-58 →
   layer-manager.ts :206-218, :300-345) — same-instance sublayers early-return in
   `_transferState` (layer.ts :937-944) and `_update` returns on `!needsUpdate()`
   (layer.ts :961-969), so that walk is O(total sublayers) cheap calls, not O(features).
2. **Tile arrival → first draw.** `onTileLoad` (chassis :2091-2099) → rAF-coalesced
   `_scheduleTileLoadUpdate` (:1493-1529) → `getVisibleTiles()` + `_tilesChanged` →
   `setState({tiles, frameNumber+1})` → deck's next `_onRenderFrame` runs
   `layerManager.updateLayers()` (deck.ts :1456) → `renderLayers()` → `prepareTile` for
   the new tile(s) → NEW sublayer instances are `_initializeLayer`'d → `_update()` →
   `updateState` (PathLayer tessellator / SolidPolygonLayer earcut when the tile has no
   pre-baked `triangles`) → `_updateAttributes()` → fp64 hi/lo split + `buffer.write`
   (data-column.ts :451/:469/:503). All synchronous, main thread, inside one frame, for
   EVERY tile that landed in the same rAF batch. Cached sublayers are untouched
   (same instance → `_transferState` early return). Latency: ≤1 frame to the chassis
   rAF + 1 frame to deck's update ≈ 16-33 ms. Hitch size scales with the coalesced
   batch, not the single tile (F5).
3. **Placeholder semantics under `best-available`.** Parent removal and child insertion
   happen in the SAME `getVisibleTiles()` result (pass 1 emits loaded primaries,
   pass 2 keeps a parent only while an in-box primary cell is uncovered, tileset
   :5646-5780), and the chassis commits that array in one `setState` → one
   `renderLayers()` → one deck update in which the child sublayer is initialized and
   the parent sublayer finalized (layer-manager.ts `_updateLayers` :258-284 →
   `_finalizeOldLayers` :348-353). **No frame with both, no frame with neither.** While
   3 of 4 children are in, parent + 3 children draw (the known translucent
   double-paint; `no-overlap` fixes it for overlays).
4. **Load window vs render window.** `tileLoadTimeWindow` is consumed ONLY by
   `getEffectiveTimeWindow()` (chassis :1823-1829), i.e. it widens the tileset's
   selection window `[t − w/2, t + w/2]` (tileset :2838-2841). The sublayers always get
   `timeWindow: this.props.timeWindow` (trips :1791, :1938) → `windowHalf` uniform, and
   the shader discards per feature. Features live in ONE bucket (the trip-heads
   comment :806-815 and the archive overlap test on covering bounds
   `[coverTMin, timeEnd]`, `R/packages/core/src/archive.ts` :4830-4831), so a trip
   spanning buckets is drawn/picked once. What the layer does NOT do is skip a resident
   tile whose covering range cannot intersect the render window — every selected tile
   is a live draw call (F1).
5. **Eviction → GPU.** Evictions happen only inside `tileset.update()` (callers :1884,
   :3232) and the chassis always re-reads `getVisibleTiles()` right after (:1456,
   :1685); `onTileUnload` is merely forwarded (:2100-2103). The evicted tile leaves the
   next `state.tiles`, the kind's prune drops its cache entry (trips :1168-1183, point
   :1497-1510, heads :735-745), deck finalizes the orphaned sublayer
   (`finalizeState` layer.ts :517-531: `model.destroy()` + `attributeManager.finalize()`
   → `DataColumn.delete()` :222-224) — GPU buffers are freed on the NEXT
   `renderLayers`, never retained until GC. GPU memory is bounded by the VISIBLE set,
   not the 2000-tile resident cache (resident-but-not-visible tiles are CPU only).
   Estimate: ScatterplotLayer ≈ 55 B/point (fp64 position 24 + radius/fill/line/width
   16 + start/end 8 + category 4 + picking 3); NoPickingPathLayer ≈ 120 B/segment
   (4 fp64 positions 96 + type/width/color/vertexTime/start/end/category ≈ 24);
   SolidPolygonLayer ≈ 41 B/vertex (×2 extruded). Storm-4d isolines run: 21 visible
   tiles / 420 resident (probe `tileset.stats`), i.e. the GPU holds 5 % of residency.
6. **Requests the tileset did not select.** Picking never fetches (`getPickingInfo`
   decodes one feature from `sttFeatures`, :2978-2999). The scrubber hover preview,
   however, is a SECOND deck with a second archive + tileset per layer (F4).
7. **three / maplibre residency.** three: decoded `BinaryFeatures` (tileset cache) +
   packed Float32 CPU arrays kept by `InstancedBufferAttribute.array` + the GPU copy —
   three copies of every resident-visible point, rebuilt from scratch on every
   publish (F3). maplibre: tileset cache + lazily built per-tile GL buffers
   (`ensureTileGpuCache` base-layer :2715-2723), freed synchronously on `onTileUnload`
   (:2681-2690); the visible set is re-derived only when the tileset frame number
   moved (`syncVisibleTiles` :1451-1459) — but `tileset.update()` itself runs every
   frame (F2).
8. **Tests** — see the dedicated section at the end.

---

## Findings

### LC-1 [high] Every selected tile is a live draw call: no kind except trip-heads culls by `tile.timeRange`, so the widened load window (2×trailLength, `tileLoadTimeWindow`) is paid in draw calls and vertex work every frame

**Where**

- Chassis `getEffectiveTimeWindow()` :1823-1829 (only widens selection); `tileLoadTimeWindow` prop doc :159-173.
- Trips window widening `R/packages/layers/src/layers/trips/animated-trips-layer.ts` :1143-1147 (`max(base, trailLength × 2)`), `renderLayers` :1149-1240 (no time test), `buildSublayer` :1774-1990.
- Path `R/packages/layers/src/layers/core/animated-path-layer.ts` :1025-1029 (`revealDuration × 2`), `renderLayers` :1102-1160.
- Point `R/packages/layers/src/layers/core/animated-point-layer.ts` :1472-1590; Polygon :1249-1259 / :1264+.
- The ONE cull that exists: `R/packages/layers/src/layers/trips/animated-trip-heads-layer.ts` :806-822 (`if (tr && (absTime < tr.start || absTime > tr.end)) skip`).
- Selection window is symmetric: tileset `selectAndLoadTiles` :2838-2841 (`start: time − w/2, end: time + w/2`).
- Showcase constants: `R/examples/showcase/src/components/demo/buildDemoLayers.ts` :191 (`STORM4D_ISO_TIME_WINDOW_MS = 1000`), :207 (`STORM4D_ISO_TILE_WINDOW_MS = 1_200_000`), :848 (trips `trailLength ?? 60000`); `R/examples/showcase/src/datasets.ts` :3147 (`timeWindow: 10800000 // 3-h window = 2 × trailLength (the loader minimum)` for `mrms-precip`, trailLength 60 min at :3120), :2998 (`storm-radar` trailLength 30 min).

**Mechanism** `grep -n "tile.timeRange\|\.timeRange\b" packages/layers/src/layers/{core,trips,summary}/*.ts` returns exactly one consumer (trip-heads :819). Every other kind iterates `this.state.tiles` (= `getVisibleTiles()` output) and emits one sublayer per (tile, layer). The tileset selects `[t − w/2, t + w/2]` with `w = getEffectiveTimeWindow()`. Two shipped shapes turn that into dead sublayers:

- **Trail trips**: `w = 2 × trailLength`. A trip is bucketed by its START (trip-heads :806-815; archive overlap on covering bounds :4830-4831), so a tile whose bucket starts after `t` holds no vertex with time ≤ t; the whole forward half of the selection cannot draw a trail vertex. The vertex stage collapses those segments (time-filter-extension.ts :636-646) and the fragment stage discards, but the draw call and the vertex shader run for every segment.
- **`tileLoadTimeWindow`**: storm-4d-isolines selects ±600 s over 300 s buckets (`storm4d-isolines/manifest.json` `temporal_bucket_ms: 300000`) for a 1 s render window → 4-5 buckets resident and DRAWN per cell, ≤1-2 of which can intersect the window.

**Scenario** Large + playback. Every trips demo (nyc-taxi-paths: 60 s buckets, 60 s window, trailLength 60 s → load 120 s → 2-3 buckets/cell, the future 1 is dead ≈ 33-50 %); `mrms-precip` (3 h window for a 60-min trail: with B-minute buckets the past needs ≈ 60/B+1 of ≈ 180/B+1 resident buckets → ≈ 64 % dead); storm-4d-isolines (≈ 60-80 % dead). gtfs-ch is nearly immune (1 h buckets, 120 s load window → 1-2 tiles/cell).

**Consequence** Draw calls and vertex-shader work scale with the LOAD window, not the render window. On the draw-call-bound surfaces the measurements doc identifies (`/drive`, earthquakes), this is direct frame time; on the others it is the headroom that keeps playback at vsync when the viewport grows. It also inflates `tileset.isLoaded`/`onViewportLoad` and `neededTileKeys` with tiles that will never draw (gating stays correct because the governor uses the runway, not `isLoaded`).

**Evidence** Probe on `/demo/storm-4d-isolines` (20 s of playback, `probe-storm4d-iso.json`): the trip-heads overlay reported `tiles 18, skippedTiles 9, sublayers 9` on every one of 17 `renderLayers` calls — exactly half of its resident-visible tiles lie outside the playhead's covering range — while the sibling `AnimatedPathLayer` on the same page reported `sublayers == tiles` (12.75 avg) and `AnimatedPolygonLayer` 23.8 sublayers for 17.9 tiles (fill + outline), i.e. they draw every resident tile. `docs/roadmap/measurements-2026-08.md` :254-259 ruled temporal culling out for `earthquakes-v2`/`av-synthetic` explicitly because "the two [windows] match" there; for every trips demo and every `tileLoadTimeWindow` demo they do not.

**Fix** Generalize the trip-heads cull into the chassis, with a wake-up so it cannot go stale: (1) in each kind's `renderLayers`, skip tiles whose covering range cannot intersect the render window — trail kinds: `tr.start > now || tr.end < now − trailLength`; window kinds: `tr.end < now − w/2 || tr.start > now + w/2` (reverse playback: symmetric). Record `nextWakeMs = min(tr.start of skipped future tiles)` and `prevWakeMs = max(tr.end of skipped past tiles)` on state. (2) In the UNTHROTTLED part of `_handleTimeUpdate` (:1403-1411) add `if (time >= nextWakeMs || time <= prevWakeMs) this.setState({frameNumber+1})` — O(1) per tick, and the tile-set change paths already re-run `renderLayers`. Blast radius: the per-kind `renderLayers` loops (8 files) + one chassis hook; `chassis-driver.test.ts` "builds one sublayer per tile" fixtures must carry times inside the window (they do — `bigPathTile` etc. are synthetic). Do NOT change the selection window (the forward half is what prefetch/runway math and `no-overlap` overlays rely on).

**Confidence** high — mechanism is a one-line grep; the storm-4d probe measured the 50 % on the one layer that reports it.

**How to verify** Add `liveTiles` to the `renderLayers` probe payload of the path/trips/polygon kinds (count of tiles whose `timeRange` intersects the render window) and assert `sublayers ≈ liveTiles` after; `tools/bench/src/frame-cost.mjs storm-4d-isolines` / `nyc-taxi-paths` draws-per-frame should drop by the fractions above with no change in the rendered pixels (the culled tiles contribute no fragments today).

---

### LC-2 [high] maplibre and Cesium drive `tileset.update()` at frame rate, and the tileset's identical-params fast path keys on RAW `timeRange`, so during playback every frame is a full selection pass; deck is protected only by its own throttle

**Where**

- Fast-path key: tileset :2906-2912 (`…|${timeRange.start}|${timeRange.end}|…`), comment :2856-2862 claiming it is "the common case" on a tick.
- maplibre `R/packages/maplibre/src/base-layer.ts` `beginFrame` :1352-1393 → `this.tileset.update(viewport)` :1392 every `render()` (:1530-1536); `currentTime` is pushed per tick by `R/examples/showcase/src/components/MaplibreRenderer.tsx` :244-248 (`setCurrentTime` :748-751 triggers repaint).
- Cesium showcase `R/examples/showcase/src/components/CesiumRenderer.tsx` :163-176 — `attachCesiumClock` calls `tileset.update(…, true)` on every `preRender`; `R/packages/cesium/README.md` :53 documents the same.
- deck's guard: chassis :1416-1428 (`timeWindow/20` sim AND 100 ms wall). three r3f guard: `R/packages/three/src/r3f/index.tsx` :222 (`STREAM_UPDATE_MS = 100`); `R/packages/three/src/scene/stt-three-scene.ts` :186-194 `updateStreaming` has none.

**Mechanism** Past the key, `selectAndLoadTiles` (tileset :2825-3245) awaits `getAvailableTiles` (a directory scan per zoom level in the parent ladder), rebuilds `neededTileKeys`, runs `cancelSupersededRequests`, `schedulePrefetch`, `evictUnusedTiles` (O(resident)), `processRequestQueue`. Because `timeRange.start/end` are raw ms, the key changes on every tick during playback; the only time the fast path hits is a frozen clock. maplibre's `beginFrame` has no sim/wall floor, so at 60 fps it runs 60 selection passes per second per layer; the Cesium hook likewise per drawn frame.

**Scenario** maplibre/cesium renderers on large paged-directory archives (gtfs-ch 558k tiles, nyc-taxi-paths 429k) during playback; N layers over a private tileset each multiply it (the shared source dedupes by frame token only when armed, `streaming-source.ts` :492-548).

**Consequence** Main-thread selection cost at frame rate (directory enumeration + set rebuild + eviction sweep) instead of ≤10 Hz; on the showcase maplibre path this competes with the per-frame draw loop for the same 16 ms.

**Evidence** Code read of the key and both callers; the tileset comment's own premise ("a tick that hasn't crossed a bucket boundary") is contradicted by the key's contents. Not measured (the probe script only drives deck demos).

**Fix** Consumer-side, smallest: mirror deck's throttle in maplibre `beginFrame` (skip the `tileset.update` when `|t − lastT| ≤ w/20 && now − lastWall < 100`, still drawing from `loadedTiles`) and in `attachCesiumClock`'s apply callback. Core-side (optional, riskier): quantize the key's time terms to the archive bucket grid — sound only because the deck chassis already tolerates that staleness, but the archive overlap test uses covering `[coverTMin, timeEnd]` (:4830-4831), so an in-bucket change CAN alter the needed set; keep the consumer throttle as the primary fix and fix the comment. Pinning test: none today.

**Confidence** high on the mechanism; medium on the magnitude (needs the counter below).

**How to verify** Add `selections` (passes that got past the key) to `tileset.getCacheStats()`; on `/demo/<maplibre demo>` during playback it reads ≈ fps × layers today and ≤ 10 × layers after.

---

### LC-3 [medium] three `StreamingTileSource` republishes synchronously on EVERY `onTileLoad` and every `update()`, and each publish is a replace-all `setTiles` that rebuilds all resident points' CPU buffers and recreates the GPU geometry

**Where**

- `R/packages/three/src/scene/streaming-tile-source.ts` :339-342 (`onTileLoad: () => this.publishIfChanged()`), :386-400 (`update()` always calls `publishIfChanged()` at :399), :425-431 (`getVisibleTiles()` + `residentSetEqual` + `onTilesChanged`), no `onTileUnload` wired.
- `R/packages/three/src/scene/stt-three-scene.ts` :130-142 (`onTilesChanged → layer.setTiles(tiles, …)`), :186-194.
- `R/packages/three/src/layers/point-cloud-layer.ts` `setTiles` :309-372 (`buildPointBuffers` over ALL tiles, `disposeGpu()` :327, new `InstancedBufferAttribute`s :339-351); `R/packages/three/src/layers/point-buffers.ts` :118-200 (fresh `Float32Array(total×3/4/1/1)` per call).
- Contrast: deck rAF coalescing chassis :1493-1529; maplibre microtask coalescing `R/packages/maplibre/src/lib/streaming-source.ts` :435-436, :601-610; Cesium showcase preRender + gate (`CesiumRenderer.tsx` :225-260).

**Mechanism** The archive delivers tiles incrementally per coalesced range (`onTileReady` hooks via `makeTilesetCallbacks`, `R/packages/core/src/render/tileset-adapter.ts` :55-63); the tileset fires `onTileLoad` per tile. three re-runs the cover pass, the O(resident) set diff, and — because the set DID change — a full `setTiles`: O(N resident points) CPU packing + GPU re-upload, once per arriving tile. A range delivering M tiles costs O(N·M) in one task. `update()` additionally runs `getVisibleTiles()` + a Set of every key unconditionally on every call (the maplibre source gates the same walk on the frame number, :534-540).

**Scenario** Large point clouds / trips streamed on the three renderer (`SttThreeGeoViewer`, AV clouds with `streaming: true`); worst on cold pans where a burst of 20-50 tiles lands in one range.

**Consequence** Frame hitches proportional to resident size × burst size (e.g. 2 M resident points × 20 arrivals = 40 M point-copies + 20 GPU re-uploads of ~50 MB in one task); eviction is only reflected at the next `update()` (harmless, but the merged buffers keep evicted points until then).

**Evidence** Code read; `streaming-tile-source.test.ts` :145 pins "fires onTilesChanged only when the resident set changes" — it does not pin how many times per task, and there is no arrival-burst test.

**Fix** In `_load`, `onTileLoad: () => this.schedulePublish()` with a `queueMicrotask` flush (copy `streaming-source.ts` :601-618), wire `onTileUnload` to the same, and gate `update()`'s diff on the frame number `tileset.update()` returns (copy :534-548). Layer-side incremental residency is the larger follow-up (the glide path already has `TrackIndexMaintainer`). Blast radius: three only; add a test "N `onTileLoad` in one task → one `onTilesChanged`".

**Confidence** high on mechanism, medium on magnitude (not measured).

**How to verify** Count `onTilesChanged` invocations per second during a cold pan on a three streaming demo; today ≈ tiles/s, after ≤ 1 per task.

---

### LC-4 [medium] The scrubber hover preview is a second full render stack — a second `STTArchive` + `SpatioTemporalTileset` per layer with the live cache caps and request budget, sharing the 24-slot scheduler at equal weight, and it stays mounted once enabled

**Where**

- `R/examples/showcase/src/components/demo/DemoHoverPreview.tsx` :85-90 (`buildDemoLayers({... timeController: controller ...})`); `R/packages/react/src/components/HoverPreview.tsx` :67-72 (frozen `TimeController`, speed 0), :76-78 (`setTime` per settled hover), :84-88, :121-127 (second `<DeckGL>`).
- `R/packages/react/src/components/PlaybackControls.tsx` :81 (`PREVIEW_SETTLE_MS = 120`), :896-897 ("The card stays mounted while enabled so its deck/archive stays warm"), :908-920, :1110-1137, :1408 (opt-in toggle).
- Per-layer archive/tileset construction: chassis :1892-1901, :2043-2132; showcase caps `buildDemoLayers.ts` :620-627 (`tileLoadingProps`, `maxCacheSize = max(600, 2000/N)`), `R/examples/showcase/src/types.ts` :1868-1885 (`maxRequests: 12`, `prefetchAhead = max(window, speed × 5 s)`).
- Mitigations present: tileset :4287 (`if (!this.prefetch.isAnimating || !enablePrefetch) return` — the frozen controller never plays, so the preview never prefetches); shared decoder pool `R/packages/core/src/tile-decoder.ts` :1022; shared byte cache `R/packages/core/src/archive.ts` :1010-1097.

**Mechanism** Each settled hover (cursor at rest ≥120 ms) → `previewController.setTime(t)` → the preview layers' `tickHandler` (chassis :1125-1130) → `_handleTimeUpdate` → the `w/20` sim gate is trivially exceeded by a scrub jump → `tileset.update(…, true)` → a fresh viewport×window selection at the hovered time with `best-available` (4 parent levels) → priority fetches through `archive.getTiles` on the process-shared scheduler (`shared-scheduler.ts`, DRR, weight 1 per archive). The preview's tileset also holds its own decoded cache (same caps as the live one) for as long as the card is enabled.

**Scenario** Large archives (gtfs-ch, nyc-taxi-paths, satellites) with the preview toggled on, user sweeps the scrubber during playback, especially on a slow link.

**Consequence** One viewport-sized selection fetch per 120 ms of cursor rest, in bandwidth contention with the live playback's runway (the governor may hold the clock → a stall caused by hovering); up to a second `maxCacheByteSize` of decoded tiles in memory; a second directory/manifest fetch per layer per demo mount.

**Evidence** Code read of the three files; `previewEnabled` is a persistent toggle (:1408), the seeding effect (:903-906) fires a selection at the live playhead the moment it is enabled.

**Fix** Give the preview layers a preview-tuned prop bag from `buildDemoLayers` (a `preview: true` arg): `refinementStrategy: 'no-overlap'`, `enablePrefetch: false`, `maxCacheSize: 200`, `maxCacheByteSize: 128 MiB`, `maxRequests: 4`, and call `tileset.setBandwidthWeight(0.25)` from `onTilesetReady` (adapter `setSchedulerWeight`, tileset-adapter.ts :67). Sharing the live archive between the two decks is the larger, better fix (the maplibre `SharedTilesetSource` shape). Blast radius: showcase only.

**Confidence** high (structure), medium (user-visible impact — depends on link speed).

**How to verify** With the preview enabled on `/demo/gtfs-ch`, count pack-range responses and bytes per hover-settle (the probe script's `net` counter split by archive instance) and the governor's hold events while sweeping; both should drop by the cache/weight ratio after.

---

### LC-5 [medium] Tile-arrival work (prepare + deck tessellation + attribute upload) is done synchronously for the WHOLE coalesced batch in one frame, so the hitch scales with how many tiles landed together, not with tile size

**Where**

- Chassis rAF coalescing :1493-1529 (one `setState` for all tiles that arrived since the last rAF).
- deck: `Deck._onRenderFrame` :1435-1456 → `layerManager.updateLayers()` → `_updateSublayersRecursively` :300-345 (`_initializeLayer` for every new id) → `Layer._update` :961-1010 (`updateState` then `_updateAttributes` :657-687) → `DataColumn` `buffer.write` :451/:469/:503.
- Per-kind prepare: point `padPositionsTo3D` :1874-1897 + color expansion; polygon `expandPerVertex` ×2 :1372-1390 and earcut when no pre-baked triangles (`hasPreBakedTriangles` :1690-1695; deck `polygon-tesselator.ts` :127-133 falls to `super.getGeometryFromBuffer` → `_updateIndices` :156-187 → `Polygon.getSurfaceIndices`); trips `synthesizeVertexTimesMemo` when the tile lacks `vertexTimestamps` (:1644-1660); PathLayer's own tessellator per new sublayer.

**Mechanism** `_scheduleTileLoadUpdate` deliberately coalesces per frame so `renderLayers()` runs once per batch (:1485-1492) — correct for the number of `renderLayers` passes, but every tile in the batch becomes a new sublayer in that ONE deck update, and deck's update is synchronous: N prepares + N `initializeState` + N tessellations + N uploads in a single `_onRenderFrame`. Range coalescing on the archive side (2 MiB gap, incremental `onTileReady`) makes bursts of 10-50 tiles per task common on cold pans.

**Scenario** Cold pan / zoom-in / seek on tile-heavy demos: storm-4d volume (11k-feature polygon tiles), nyc-taxi-paths (PathLayer tessellation per tile), any archive without pre-baked `triangles`.

**Consequence** A long task on the main thread while the clock keeps running (the governor gates on the runway, which IS buffered) — read by the user as a stutter rather than a buffering pause.

**Evidence** Code path above. The bounded probe on `/demo/storm-4d-isolines` (small tiles) recorded `tilePrepare` p95 0.4 ms / max 0.9 ms and **0 long tasks** in 20 s of playback — consistent with "small tiles are fine"; the batch-sized hitch was NOT reproduced because that run had no cold pan. Rated medium with medium confidence for that reason.

**Fix** Budget the batch in `_scheduleTileLoadUpdate`: commit at most K un-prepared tiles per rAF (e.g. K = 8 or a 4 ms `tilePrepare` budget) and re-arm the rAF for the remainder — the tileset already holds them, `getVisibleTiles()` returns them again, and parents keep covering the still-uncommitted children (pass 2). Larger follow-up: move the per-vertex expansions into the decode worker (`tile.ts`), and bake `triangles` for the polygon archives that lack them.

**Confidence** medium — the chain is certain, the ms are not measured.

**How to verify** `probe-layer-consumption.mjs` with a scripted pan (add `page.mouse` drag) on `/demo/storm-4d-greenfield` and `/demo/nyc-taxi-paths`: `longTasks.maxMs` and `renderLayers.msMax` per batch before/after the cap.

---

### LC-6 [low] Cesium's shipped consumer does O(features) CPU per drawn frame and a replace-all primitive rebuild per changed visible set

**Where** `R/packages/cesium/src/cesium-point-layer.ts` `setTime` :155-170 (per-entry `timeFilterAlpha` + colour write per frame), `setTiles` :100-150 (`removeAll` + one primitive per feature); `R/examples/showcase/src/components/CesiumRenderer.tsx` :225-260 (preRender flush + `TilePublishGate`); `R/packages/cesium/README.md` :46-53 (per-tile `setTiles(tileset.getVisibleTiles())` recipe — worse than the showcase's gated form).

**Mechanism / Consequence** By design a "worked example" (file header :13-21 says the GPU-appearance path is unwired). It caps the Cesium path at small datasets; the README recipe (`onTileLoad: () => layer.setTiles(...)`) is O(N·M) on bursts unless the gate is used.

**Fix** README: show the gate + preRender flush the showcase uses. Otherwise accept as documented scope.

**Confidence** high. **How to verify** n/a (documented limitation).

---

## Checked and correct (do not re-audit)

- Tick path is redraw-only; `getVisibleTiles()`/`renderLayers()` never run per frame on the base kinds (chassis :1403-1481).
- Tick-path throttle = `getEffectiveTimeWindow()/20` sim AND 100 ms wall; playback-speed-invariant (:1416-1428).
- `_tilesChanged` is an order-insensitive membership diff on the canonical `tileKey` (bucketMs-aware) (:1558-1592).
- rAF coalescing of tile loads, one `setState` per batch, bails on a torn-down tileset (:1493-1529).
- Viewport-only reselection throttled to 100 ms with one trailing settle pass; prop/data changes never throttled (:1594-1626, :1763-1783).
- `frameChanged` compares the tileset counter to its OWN mirror, never to the layer epoch (:1701-1712).
- `getViewportBounds` memoised on camera + `zRange`, returns the same reference; non-finite box keeps the previous one (:2304-2392).
- `getZoomLevel` clamps to archive range then applies the cell budget with hysteresis (:2699-2740).
- `isLoaded` = `tileset.isLoaded && super.isLoaded`, correct for an empty settled selection (:2758-2762).
- Eviction callback-before-delete (tileset :5517-5524) is harmless for deck: it never reads inside the callback (:2100-2103) and re-reads after `update()` (:1456, :1685); maplibre (base-layer :1461-1475 microtask + sync flush :1536-1541) and its shared source (:601-618) defer correctly; three re-reads on the next `update()`.
- Parent→child handoff is atomic per `getVisibleTiles()` (tileset :5592-5860) and per `renderLayers()` (LC answer 3).
- Sublayers leaving the visible set are finalized by deck (layer-manager.ts :284, :348-353 → layer.ts :517-531) and their cache entries pruned (trips :1168-1183; point :1497-1510; heads :735-745; path :1112-1125).
- Style invalidation: `buildLayerPropsKey` over a TOTAL `PropEffects<P>` classification (`R/packages/layers/src/lib/layer-props-key.ts` :131-182) clears the sublayer cache; `styleKey` re-prepares; `inheritedPropsDigest` covers composite pass-through, extensions, extension pass-through props and `updateTriggers` (`style-digest.ts` :199-240). A style change re-prepares tiles from the CPU `BinaryFeatures` — it never re-fetches.
- `TimeFilterExtension.draw()` pushes only `currentTime` after the first full push, with the model-swap guard (:876-919); `staticUniformsEqual` is compile-time exhaustive (:940-979).
- `_pushTilesetOptions` on every `propsChanged` is cheap: `setOptions` diffs with `Object.is` and only re-selects on real changes (chassis :1338-1375; tileset :1768-1940).
- `composeSubLayerProps` only runs on cache-miss paths; `_reassertSubLayerPrecedence` repairs deck's extension pass-through clobber (:2796-2899).
- Picking: `getPickingInfo` decodes ONE feature from `sttFeatures` references (:2978-2999); `_updateAutoHighlight` targets the source sublayer (:3013-3020); no fetch on pick.
- Trips: `data`/`getPath` identity + `dataComparator` + `dynamicVersion` triggers keep sub-step swaps to attribute re-uploads, no re-tessellation (:1576-1600, :1888-1911).
- Point sparse grouping (`buildWindowGroups` :1596-1680) re-merges only the bucket group whose membership changed.
- Features are drawn/picked once: one bucket per feature (by start), archive overlap on covering bounds (`archive.ts` :4830-4831, :3675), trip-heads test :940 pins the covering semantics.
- maplibre per-layer mode draws the VISIBLE set (`loadedTiles`, base-layer :511-540), GPU buffers freed on residency (`onTileUnload` :2681-2690, `deleteCacheBuffers` :1327-1338), shared-source fan-out replace-all with variant-suffixed GPU sweep (:2620-2629).
- three r3f throttles selection to 100 ms and keeps the previous viewport on a null camera box (`r3f/index.tsx` :548-580); `cameraToViewport` horizon clip (streaming-tile-source.ts :600-632).
- Cesium showcase coalesces publishes to `preRender` and gates on key-set change with a bounded empty hold (`CesiumRenderer.tsx` :225-260; `tile-publish-gate.ts`).
- Hover preview never prefetches (frozen controller → `isAnimating` false, tileset :4287) and shares the decoder pool + byte cache.

## Doc ↔ code drift

- Chassis `tileLoadTimeWindow` prop doc :167-169: "Extra resident tiles are cheap: TimeFilterExtension still discards every feature outside timeWindow, per feature, not per tile" — true for fragments, false for draw calls / vertex work (LC-1). Same claim in `animated-path-layer.ts` :359-362 and `buildDemoLayers.ts` :203-206.
- Tileset :2856-2862: "Running on a TimeController tick that hasn't crossed a bucket boundary, this is the common case" — the key at :2906-2912 contains raw `timeRange.start/end`, so a moving tick never hits (LC-2).
- `docs/roadmap/measurements-2026-08.md` :259 "A wider load window than render window. Not the case here; the two match." — true for the two measured surfaces, false for every trips demo (2×trailLength) and every `tileLoadTimeWindow` demo (LC-1).
- `streaming-tile-source.ts` :143-146 `onTilesChanged` "Fired (async, after the tileset's getVisibleTiles changes)" — fired synchronously inside `onTileLoad` (LC-3).
- `stt-three-scene.ts` :186-189 "the underlying tileset also debounces" — `debounceTime` defaults to 0 (streaming-tile-source.ts :100-104), so it does not.
- Chassis :949, :1489 and :2097 mention `buildConsolidatedData()`; no such function exists in `packages/layers/src` (grep) — the trips consolidation path was removed; the comments survive.
- `docs/roadmap/tile-loading-3d-2026-07.md` :344 (A6) says maplibre "today `render()` walks the resident map ⇒ up to 5 zoom levels composited" — base-layer :511-540 now draws the visible set; the row reads as still open. Confirm its status in the README backlog.
- `R/packages/cesium/README.md` :46-47 recipe (`onTileLoad: () => layer.setTiles(tileset.getVisibleTiles())`) is the O(N·M) pattern the showcase deliberately replaced with the gate (LC-6).

## Needs measurement

- **LC-1 fraction per demo**: add `liveTiles` to the path/trips/polygon `renderLayers` probe payload (tiles whose `timeRange` intersects the render window) and read it on `/demo/nyc-taxi-paths`, `/demo/mrms-precip`, `/demo/storm-4d-isolines` — settles the dead-draw-call share (predicted 33-50 %, ~64 %, 60-80 %).
- **LC-2 selections/s**: a `selections` counter in `tileset.getCacheStats()`; read it on a maplibre demo during playback (predicted ≈ fps × layers).
- **LC-3 burst cost**: `onTilesChanged` calls/s and `setTiles` ms during a cold pan on a three streaming demo.
- **LC-5 hitch size**: `probe-layer-consumption.mjs` + scripted pan on `/demo/storm-4d-greenfield` and `/demo/nyc-taxi-paths`, reading `longTasks.maxMs`, `renderLayers.msMax`, and the number of new sublayers per batch (add `newSublayers` to the emit).
- **GPU bytes for the visible set**: read luma's `device.statsManager` "Memory Usage → GPU Memory" from the page on the heaviest demos to replace the per-vertex arithmetic above with a number.
- **Out-of-scope observation for the loader auditors** (from `probe-flow-riders.json`, 20 s on `/demo/nyc-flow-and-riders`, headless SwiftShader): the heads overlay's `tileset.stats` read `tileCount 13741, cacheBytes 1.67 GB, activeRequests 500, evictions 0` with 837 MB fetched over 83 pack requests while the trips layer re-rendered only twice and trip-heads never (the clock appears gated). The overlay's cap is `max(600, 2000/N)` tiles, so either the cap is not enforced during the cold fill or the snapshot is the wrong tileset; not a layer-side mechanism.

## Tests — what is pinned, what is vacuous, what is missing

Pinned (`R/packages/layers/test/`):

- `viewport-throttle.test.ts` — 100 ms viewport floor, one trailing settle, prop/data never throttled, finalize bail (3 tests, drive `_updateTileset` directly with a mocked clock).
- `chassis-driver.test.ts` — per-tile sublayer contract across every kind: one sublayer per tile, per-tile `timeOffset`, stable `PreparedTile` identity, same instance across renders, rebuild on a `'sublayer'` prop, prune on leaving the set, `dataComparator` identity; `stateSlot` adoption/transfer.
- `chassis-lifecycle.test.ts` — archive swap generation guard, state-not-fields, rAF bail on torn-down tileset (:387-410), init failure routing, mutable options push + subclass override re-apply, `frameNumber` authority (:612-660), debounce bypass, `isLoaded` on an empty settled selection.
- `picking.test.ts` — `onViewportLoad` once-per-settle latch; picking enrichment.
- `state-backed-caches.test.ts`, `trips-cache-hardening.test.ts` — caches survive `_transferState`; archive-keyed tile keys; sub-step reference stability + `dynamicVersion` trigger; trip-heads pooled buffers; trip-heads `timeRange` cull incl. covering-bounds semantics (:877-950).
- `temporal-lod-tile-key.test.ts` — per-tier prepared registry (arc layer only).
- three `streaming-tile-source.test.ts` — diff-by-address, knob forwarding, summary dispatch, overview preload; `scene-streaming.test.ts` — drive path.
- maplibre `streaming-source.test.ts` — fan-out, address-equal suppression, microtask coalescing (:549), eviction-after-callback ordering (:526), frame-token dedupe; `base-shared-source.test.ts` — GPU sweep on eviction, `beginFrame` routes through the source; `tileset-wiring.test.ts` — adapter hooks.

Missing / vacuous:

- No test drives the TICK-path throttle (`MIN_TILESET_UPDATE_WALL_MS`, `timeWindow/20`): `chassis-lifecycle.test.ts` :649 calls `_handleTimeUpdate` once for frame authority only. A burst of ticks → one `tileset.update` is unpinned.
- No test pins the rAF coalescing itself (N `onTileLoad` in one frame → ONE `setState`); only the bail-out is covered.
- No test pins "a time-only tick calls `setNeedsRedraw`, never `setState`" on the base kinds — the central perf contract of the chassis.
- No layer-level test of the parent→child handoff atomicity (a `getVisibleTiles` sequence `[P] → [C]` producing a single `renderLayers` with neither a both- nor a neither-frame); core tests cover `getVisibleTiles`, not the chassis commit.
- No test that a tile leaving the visible set is FINALIZED (GPU released) — the prune tests inspect the cache maps, not deck's `_finalizeOldLayers`; a fake-deck-core assertion on `finalizeState` calls would pin it.
- `tileLoadTimeWindow` semantics: `path-line-hardening.test.ts` :619-660 pins "never narrows" and the persist warning; nothing pins that the RENDER window handed to sublayers stays `props.timeWindow` while the LOAD window widens.
- three: no burst/coalescing test (LC-3), no `onTileUnload` behaviour test.
- maplibre: no cadence test for `beginFrame`'s per-frame `tileset.update` (LC-2).
- Cesium: `tile-publish-gate.test.ts` covers the gate; nothing exercises the README recipe.

---

# Appendix 8 — audit-coldstart-small

## Audit — cold start, time-to-first-frame, and the small-dataset path (2026-08-24)

Scope: `STTArchive` construction → first `onTileLoad`; `SpatioTemporalTileset` init, first `update()`, `preloadOverviewTier`; the deck chassis init path; `usePlayback` + `DemoViewer`; measurements §9 and `tools/bench/src/cold-start*.mjs`. All measurements below were taken against the local dev server (`http://localhost:3000/data`) with the real `@poopdeck.gl/core` `dist/` reader (v3, `PACKED_FORMAT_VERSION = 3` at `dist/archive.js:55`) behind an instrumented `fetch`. Scripts: `scratchpad/coldstart-probe.mjs` (modes `critical`, `overview`, `order`, `pagedebug`) and `scratchpad/pin-thrash-repro.mjs`. Bytes/request counts are durable; wall times are LAN and only indicative.

Local fleet facts used throughout (from `manifest.json`):

| archive                                     | packs                      | tiles   | dir object                            | layout | minZ–maxZ | bucket | buckets |
| ------------------------------------------- | -------------------------- | ------- | ------------------------------------- | ------ | --------- | ------ | ------- |
| storm-tracks                                | 265,045 B (1 pack)         | 1,042   | 6,591 B, single (whole GET)           | —      | 4–9       | 5 min  | 70      |
| storm4d-sounding                            | 101,046 B                  | 4       | 153 B, 1 page (whole GET)             |        | 3–6       | 2 h    | 1       |
| bixi-flowmap                                | 1.54 MB                    | 59      | 955 B, 1 page                         |        | 10–13     | 1 h    | 744     |
| lines-v2                                    | 180 KB                     | 492     | 5,514 B, 1 page                       |        | 0–4       | 30 d   | 48      |
| earthquakes-v2 (demo `earthquake-activity`) | 44.95 MiB                  | ~91k    | 2.07 MB, 25 pages                     | paged  | 0–10      | 1 d    | 1,826   |
| earthquakes                                 | 24.3 MB                    | 350,594 | 5,496,211 B, 86 pages (root 1,416 B)  | paged  | 0–10      | 1 h    | 43,824  |
| hurricanes                                  | 29.9 MB                    | 170,592 | 1,699,261 B, 42 pages                 | paged  | 0–10      | 1 h    | 30,726  |
| gtfs-ch (rebuilt 2026-08-23)                | 2,568,269,535 B (39 packs) | 557,899 | 8,602,296 B, 137 pages (root 3,021 B) | paged  | 6–14      | 1 h    | 34      |
| drifters                                    | 2.58 GB                    | 256,061 | 3,379,062 B, 63 pages                 | paged  | 0–4       | 7 d    | 2,281   |
| nyc-taxi-paths                              | 3.30 GB                    | 429,389 | 5,692,030 B, 105 pages                | paged  | 10–14     | 60 s   | 2,383   |

(`ls -la examples/showcase/public/data/{storm-tracks,gtfs-ch,earthquakes,drifters}/{manifest.json,index}`: manifests 2,981 / 18,551 / 6,638 / 15,677 B; `index/*.sttd` 6,591 / 8,602,296 / 5,496,211 (+ a stale 5,481,433 sibling) / 3,379,062 (+ stale 3,379,813) B.)

## Findings

### CS-1 [critical] Pinned overview tiles count against `maxCacheSize` → permanent over-limit eviction of the WHOLE non-pinned cache on every selection pass (earthquake-activity, earthquake-columns, hurricanes)

**Where**

- `packages/core/src/spatiotemporal-tileset.ts:5248` — `const overSizeLimit = loadedCount > this.options.maxCacheSize;` with `loadedCount = this.loadedTileCount` (:5243), which `deliverTile` increments for EVERY tile including overview-tier deliveries (:3967).
- `:5290-5298` — over-limit candidates exclude `header.isPinned`, so pinned tiles are never in `plan`.
- `:5457-5473` — the eviction loop runs `for (i < plan.length)` and only breaks when `stillOverSize`/`stillOverBytes` become false (`:5460 const stillOverSize = loadedCount > this.options.maxCacheSize;`). When pinned tiles alone exceed `maxCacheSize`, that never happens → every entry of `plan` (tiers A→B→C→**D**, the protected near-playhead window) is evicted, every pass.
- `:4926-4940` — the overview budget gate is BYTES only (`if (bytes > budgetBytes)`, default `DEFAULT_OVERVIEW_BUDGET_BYTES` 20 MiB of DIRECTORY bytes, :403). `maxCacheSize` is a COUNT (2000; layer default `spatiotemporal-layer.ts:676`, pushed at :2045). 20 MiB of ~1.2 KB tiles is ~17k tiles.
- `:5046-5070` `finishOverviewLoad` warns once ("Pinned overview tier … alone exceeds the cache limits") and carries on.
- Showcase: `DemoViewer.tsx:324` passes `overviewPreload: true`; `buildDemoLayers.ts:639` puts it in `baseProps`, spread by `case 'point'` (:677) and `case 'column'` (:1305-1309); single-archive demos keep `maxCacheSize` 2000.

**Mechanism** The tileset's cache limit is enforced against a count that includes tiles the policy has declared un-evictable. `evictUnusedTiles` is called from every `selectAndLoadTiles` pass (:3232), i.e. ≤10 Hz during playback (`_handleTimeUpdate` :1403, `MIN_TILESET_UPDATE_WALL_MS` 100). Each pass evicts every loaded tile that is not in `neededTileKeys`, including the prefetch runway just fetched (tier C) and the protected window (tier D); the prefetch pass 250 ms later refetches it; `noteRunwayEviction` collapses the pressure ladder to its floor. The archive byte cache (500 tiles / 512 MiB shared) absorbs some refetches as memory hits, but every tile is re-DECODED and re-uploaded.

**Scenario** Any archive with `minZoom ≤ 1` whose z0–z1 × all-time slice is under 20 MiB but over 2000 tiles. Measured on the local fleet: `earthquakes-v2` → 8,927 tiles (z0 1,822 + z1 7,105; 11,382,650 dir bytes; 41,147,766 B decoded after pin); `hurricanes` → 17,899 tiles (10,507,301 dir bytes; 24,194,758 B decoded). Demos: `earthquake-activity`, `earthquake-columns` (both `/data/earthquakes-v2`), `hurricanes`. (`goes-glm-lightning` pins 1,140 < 2000 → not affected by this finding; `lines-v2` 111.)

**Consequence** Continuous evict→refetch churn during playback, the exact "flashing tiles" thrash the tiered policy exists to prevent; decode/upload CPU burned per pass; runway oscillates instead of building; `prefetchPressureScale` pinned low. Memory: pinned decoded footprint 41 MB (earthquakes-v2) / 24 MB (hurricanes) exempt from eviction, on top of a 2000-tile budget that is then unusable.

**Evidence** `scratchpad/pin-thrash-repro.mjs` — real `SpatioTemporalTileset` + `STTArchive` over the local server, showcase params (maxCacheSize 2000, best-available, prefetchAhead = max(window, speed×5 s), prefetchSteps 4, maxRequests 12), demo camera, demo speed (span/60 s), 60 updates at 10 Hz (6 real s):

- earthquakes-v2 WITH overview: evictions **11,105** in 6 s, ALL runway (tier C 9,255, tier D 1,850), `onTileLoad` 20,133 (11,206 non-pinned), `getBufferedRunway` oscillating 12.6 → 161 → 11.7 → 11.3 → 163 → 12.4 sim-days.
- earthquakes-v2 WITHOUT overview (control): evictions **0**, loads 1,141, runway steady 155–162 sim-days.
- hurricanes WITH overview: evictions **29,036** (C 23,864, D 5,163), loads 48,522 (30,623 non-pinned); runway 15 → 24 → 4.9 → 4.9 → 21 → 49 sim-days.
- The existing test `packages/core/test/overview-preload.test.ts:173` ("pinned tiles survive eviction pressure (over maxCacheSize) and warn once") PINS this behaviour as expected: it asserts `unloaded.length > 0` for the z6 churn.

**Fix** (a) Account pins outside the LRU budget: track `pinnedLoadedCount`/`pinnedBytes` incrementally (bump in `deliverTile` when `header.isPinned`, in `startOverviewPreload` when pinning an already-loaded header, reset in `clear()`), and use `loadedCount - pinnedLoadedCount` / `cacheBytes - pinnedBytes` at :5248-5249 and :5460-5461. (b) Add a COUNT gate to `startOverviewPreload` next to the byte gate (:4933): reject with `reason: 'over-budget'` when `candidates.length > Math.floor(maxCacheSize / 4)` (or a new `budgetTiles` option). Blast radius: eviction accounting only; `overview-preload.test.ts:173` must flip to "no non-needed churn when the non-pinned working set fits" and a new test pins the count gate. The eviction telemetry (`evictionsByTier`) is unchanged.

**Confidence** high — reproduced with the shipped reader over the shipped archives, with a clean control.

**How to verify** Unit: pin 40 overview tiles with `maxCacheSize: 10`, then load 5 primary tiles across two buckets → `getCacheStats().evictions === 0` (fails today, passes after). Integration: `pin-thrash-repro.mjs earthquakes-v2` → `runwayEvictions` must stay 0 and runway monotone.

### CS-2 [high] Overview budget prices DIRECTORY bytes; the coalescer fetches RANGES — 33× read amplification on `goes-glm-lightning` (22.2 MB fetched to pin 0.64 MiB), dispatched at cold start alongside the first viewport

**Where**

- `spatiotemporal-tileset.ts:4926-4933` — budget = Σ `getTileByteSize(id)` over candidates.
- `:4980-5033` `drainOverviewQueue` → `startTileBatch(candidates, 'overview')` (≤ `MAX_COALESCE_BATCH` 1024 per drain) → `archive.getTiles` `:4205`, which coalesces members within `effectiveCoalesceGap()` (2 MiB while cold / no build-gap, `archive.ts` `getCoalesceGapEstimate`).
- `:4982` — the only starvation guard is `if (this.priorityQueue.length > 0) return;` evaluated at dispatch time.
- `spatiotemporal-layer.ts:2198` — `preloadOverviewTier` is kicked synchronously in `_attachArchiveAndTileset`, BEFORE the first `tileset.update()` (which only runs on deck's next update pass via `_updateTileset` :1594), so the priority queue is empty by construction when the overview drains.

**Mechanism** The world × all-time z0–z1 slice is the most SCATTERED selection an archive can receive: under `time-major` ordering the z0/z1 blobs of every bucket sit next to that bucket's fine tiles, so consecutive overview members are a few hundred KB apart and the 2 MiB gap fuses the entire pack span into one range. The budget gate never sees this. The batch is dispatched with `fetchPriority: 'low'` (browser hint) and scheduler tier `SCHEDULER_PREFETCH_TIER_BASE` (`archive.ts:746`) — but a group that is already RUNNING when the viewport batch arrives is not preempted; the two share the link.

**Scenario** Sparse archives with `minZoom ≤ 1` and a small coarse tier: `goes-glm-lightning` (demo of the same id, `case 'lightning'` spreads `baseProps` → overview on), `earthquakes-v2`, `hurricanes`, `lines-v2`.

**Consequence** Measured (`coldstart-probe.mjs overview`, FETCH=1): goes-glm-lightning: 1,140 tiles / 668,160 directory bytes → `getTiles` issued **1 range of 22,237,927 B** (33.3×). earthquakes-v2: 8,927 tiles / 11,382,650 B → 1 range of 11,382,650 B (1.0×, contiguous) but 11.4 MB of pack bytes + 8,927 decodes (4.7 s inline in node) + 41 MB pinned decoded. hurricanes: 17,899 tiles / 10.0 MiB, 8.6 s node. Against the first-frame critical path from measurements §9.1 (goes-glm 250.9 KiB, earthquakes-v2 348.1 KiB), the overview adds 22.2 MB / 11.4 MB of concurrent transfer: 5.5 s / 2.85 s of a 4 MB/s link, plus decoder-pool time, in the first seconds — and it also delays the prefetch runway the start gate is waiting on.

**Evidence** Instrumented fetch log (`kind:pack` rows) in the overview probe; `packRequests: 1, packBytes: 22237927` for goes-glm-lightning; for earthquakes-v2 `packBytes: 11382650`.

**Fix** Smallest sound: gate on PLANNED bytes, not directory bytes — add to the archive a pure planner (`planRangeBytes(ids): number` = Σ coalesced group lengths using the same `effectiveCoalesceGap()` as `getTiles`; ~20 lines, reuse the per-pack grouping loop at `:4300-4330`), expose it through `makeTilesetCallbacks` as `estimateFetchBytes`, and in `startOverviewPreload` reject when `estimateFetchBytes(candidates) > budgetBytes` (fall back to the directory sum when unwired). Second: defer `preloadOverviewTier` until the layer's first `_maybeFireViewportLoad` settles (move the kick from `_attachArchiveAndTileset` :2198 to the viewport-load path, once), so the overview never shares the first frame's link. Optional: slice the overview like prefetch (`prefetch.sliceBytes`) instead of one 1024-tile batch.

**Confidence** high on the amplification (measured); medium on the wall-clock impact in a browser (unmeasured; browser `priority:'low'` H2 weighting will help but not remove it).

**How to verify** Fixture with coarse tiles interleaved between fine ones (time-major), `preloadOverviewTier()` with an instrumented `getTileDataBatch` → assert Σ fetched range bytes ≤ 2× directory bytes (fails today). Browser: `__sttProbe.batches` — the first `overview` batch must not precede the first `priority` batch's completion.

### CS-3 [medium] The overview ENUMERATION (world × all time at z0–z1) is paid on every low-`minZoom` cold start, before the first viewport's leaf pages, even when the tier is then rejected

**Where** `spatiotemporal-tileset.ts:4870-4890` (`startOverviewPreload` → `fetchAvailableTilesForZoom(WORLD_BOUNDS, z, FULL_TIME_RANGE)` for z0..1) → `archive.getTileIdsInBounds` :4797 → `ensurePagesForBounds` :3235 → `fetchAndMergePages` :3037 → `runGroupFetches` :4032 (shared scheduler, `sourceId` = url, priority = enqueue `seq` because page fetches carry no playhead). Kicked at `spatiotemporal-layer.ts:2198`, synchronously before deck's next update pass runs the first selection.

**Mechanism** Directory pages are partitioned by zoom × space (see the page descriptors dumped in `pagedebug`: `minZoom == maxZoom == 2`, hemisphere bboxes, `tMin..tMax` = whole dataset), so the z0/z1 slice faults in every z0/z1 leaf; the ids are materialised (`tileKey` per id, a `Set`, an array) and only then compared to the byte budget.

**Scenario** Every archive with `minZoom ≤ 1`: measured directory bytes + ids for the enumeration alone — earthquakes 656,890 B (3 requests) + 52,437 ids (202 ms in node) → rejected; drifters 166,594 B + 10,718 ids → rejected; rainfall-2019 144,935 B + 8,760 ids → rejected; satellites 59,414 B; animals 59,653 B; ecco-currents 56,329 B; flights 66,399 B; adsb-paths 63,458 B; ais-all-us 64,483 B; earthquakes-v2 229,257 B; hurricanes 113,101 B; goes-glm 478,702 B (its whole 1-page directory).

**Consequence** On sparse archives the first frame is already 54–92 % directory bytes (§9.3); the overview enumeration adds 0.5–1× that again (earthquakes-v2: first frame needs 238,340 B of leaves; the overview adds 229,257 B), enqueued FIRST on the same source's FIFO-within-tier scheduler order, sharing the 12-per-archive / 24-global slots and the link with the first frame's own leaf fetch.

**Evidence** `coldstart-probe.mjs overview` `directoryFetch` column; attach-order read from `_attachArchiveAndTileset` (:2177-2210).

**Fix** (1) Reject cheaply from the ROOT page before touching leaves: the root descriptors already carry `entryCount` and `[minZoom,maxZoom]` (`pageTable[i]`), and `unknownEntriesInBounds` :3340 already walks them — add `archive.countEntriesForZooms(zooms)` (Σ `entryCount` of pages whose zoom range intersects z0–1) and reject when that exceeds a count budget (CS-1b) before any leaf fetch. (2) Defer the kick to after the first viewport load (same change as CS-2). Neither needs a format change.

**Confidence** high (measured bytes; ordering from code).

**How to verify** Instrumented fetch on a paged fixture: between `new STTArchive` and the first `onViewportLoad`, the only directory requests are the root + the viewport's leaves (fails today when `overviewPreload` is on).

### CS-4 [medium] Per-pass overhead scales with `this.tiles.size`, and pinned headers inflate it (8.9k–17.9k header visits per 100 ms); no "whole archive resident" short-circuit exists

**Where**

- `spatiotemporal-tileset.ts:5270` — under-limit grace sweep `for (const [tileKey, header] of this.tiles)` on EVERY `selectAndLoadTiles` pass (:3232); with CS-1 unfixed it is the over-limit branch instead (:5290 candidate build + 4 sorts).
- `:3305` `prefetchFutureTiles` — `prefetchByteExpansion` (:3260) scans up to 4,096 headers per plan; `prefetch-policy.ts:787` `if (this.lastPlannedEndTime !== undefined && !pipelineIdle)` — the throttle is BYPASSED whenever the prefetch pipeline is idle, i.e. exactly when everything is already resident, so a fully-resident archive re-runs the directory slice + sort every `PREFETCH_DEBOUNCE_MS` 250 ms (:326) while playing.
- Per pass (≤10 Hz): 1 primary + ≤4 parent `getTileIdsInBounds` awaits (:2880-2900), `cancelSupersededRequests` (:3224), `evictUnusedTiles`, `processRequestQueue` (+ `sortPriorityQueueByPlayhead`), `getVisibleTiles` :5592 (DP cover); governor tick probe every 200 ms (`playback-governor.ts:896`, `TICK_PROBE_INTERVAL_MS` :556) → `getBufferedRunway` walk.

**Mechanism / Scenario** Small (storm4d-sounding 4 tiles, bixi 59, lines-v2 492, storm-tracks 1,042): all of the above runs, but each step is O(needed) or O(occupied cells) — sub-millisecond; the awaited directory queries are in-memory after the first page fault. There is no path that says "all buckets resident → skip". Large-with-pins (hurricanes 17.9k pinned headers, earthquakes-v2 8.9k): the grace sweep visits every pinned header 10×/s for nothing (pins are skipped by `!header.isPinned` only after the `lastUsed`/`isNeeded` tests).

**Consequence** Small datasets: negligible CPU, but nonzero microtask churn (5 awaited queries + 1 prefetch query per pass); the cost that actually shows up is the pinned scan on large sparse demos (≈90–180k header visits/s on the main thread).

**Evidence** Code reading; storm4d-sounding probe (1 bucket, 4 tiles): selection 0 ms, coverage 0 ms — confirms the per-pass work is trivially small there. The pinned scan cost is inferred from `tiles.size` (8,927 / 17,899 measured) × the 10 Hz cadence; not profiled.

**Fix** Cheapest short-circuit, in `prefetchFutureTiles`: when a pass enqueued nothing AND every candidate was already loaded, record `this.prefetch.lastPlannedEndTime = plan.endTime` and let `plan()` throttle on it regardless of `pipelineIdle` (a one-line change to the condition at `prefetch-policy.ts:787`: `!pipelineIdle || this.lastPassWasResident`). For the pinned scan: keep pinned headers in a separate `Map` (or maintain `unpinnedKeys`) and iterate only that in the grace sweep. Blast radius: prefetch-policy tests that pin "idle pipeline re-plans"; check `packages/core/test/prefetch-*.test.ts`.

**Confidence** medium (mechanism certain; magnitude unmeasured).

**How to verify** Count `getAvailableTiles` calls over 5 s of playback on a 4-tile archive with everything resident: today ≈ 20 prefetch queries + 50×(1+parents) selection queries; after: 0 prefetch queries.

### CS-5 [low] Decoder worker pool is created lazily on the FIRST decode and torn down on every route change — worker boot is serialized behind the first pack bytes

**Where** `archive.ts:2105` `getDecoder()` (lazy), called only via `getPreparedDecoder` :2120 from `decodeBytes` :3659 / `decodeDecompressed` (:3728); `tile-decoder.ts:1072` `createDefaultTileDecoder` → `new WorkerTileDecoder()` spawns `min(4, cores−1)` module workers (:485-497, `dist/tile-decoder.worker.js` = 477,418 B); `archive.finalize` :2140 → lease release → `tile-decoder.ts:1059` `if (this.state.leases === 0) { this.state.decoder.finalize(); … }` terminates the pool.

**Mechanism** The first `decode` message is posted immediately (no readiness handshake) and waits for the worker's module evaluation; that time lands after manifest → directory → pack RTTs instead of overlapping them. On navigation between demos the old layer's `finalizeState` (:1175) drops the last lease before the new demo's archive exists, so the pool is re-created cold every time.

**Scenario** Every cold start and every demo-to-demo navigation.

**Consequence** One worker boot (parse/evaluate ~0.5 MB) on the TTFF critical path; unmeasured here (browser-only).

**Fix** Warm the pool during the network phase: call `this.getPreparedDecoder()` at the end of `fetchManifest`'s continuation (:2260, after `templateRegistry` is built, so `setTemplates` rides the spawn). Keep a lease-less shared pool alive for a short grace (e.g. 5 s `setTimeout` before `finalize()` in `SharedWorkerDecoderLease.finalize`, cancelled by the next lease). Blast radius: node tests never spawn workers (`Worker` undefined → inline decoder), so the change is browser-only.

**Confidence** medium (code certain; latency magnitude unmeasured).

**How to verify** Browser: `performance.mark` around the first `decode` round trip vs the second on the same demo; after the fix the first should be within ~2× of steady state.

### CS-6 [medium] `gtfs-ch` (rebuilt 2026-08-23) first frame at midday is 13.2 MB for a 20 s window, with NOTHING coarser drawable; measurements §9's gtfs-ch row is the retired archive (×11 smaller)

**Where** Build shape (`minZoom` 6, 1 h buckets, whole-country z7 tiles of 3–10 MB) meets: `spatiotemporal-tileset.ts:2648` `isOversizedParent` (`DEFAULT_MAX_PARENT_TILE_BYTES` 2 MiB, :142) — the z6 parent (13,542,904 B) is skipped while throughput is cold (`shouldSkipParentFetch` :2676 abstains → flat cutoff); `startOverviewPreload` → `'no-tiles'` because `minZoom` 6 > `DEFAULT_OVERVIEW_MAX_ZOOM` 1 (:406).

**Mechanism / Evidence** `coldstart-probe.mjs critical`, camera (8.23, 46.75, z7.6→7), 20 s window: t = range start (Mon 00:00 local): 2 tiles / 26,750 B, 15 features; t = 0.35 (≈12:00): **4 tiles / 13,186,509 B**, 20,200 features, 2 coalesced ranges (2,993,119 + 10,193,390 B); z6 parent 1 tile / 13,542,904 B; the hour bucket at z7 = 8 tiles / 25.6 MB counting the previous hour's covering overlap. Directory: root 3,029 B + one 62,503 B leaf range, and the coverage / z6 / prefetch queries needed **0** additional directory bytes (`order` mode: full-time z7 query = same 65,532 B).

**Consequence** At 4 MB/s: first partial frame ≈ first range group (3.0 MB) ≈ 0.75 s + decode; full window ≈ 3.3 s; start gate (`startGateWallMs` 2000 × 157× = 314.6 k sim-ms, bucket-granular `getBufferedRunway` → needs the whole hour's 4 z7 tiles; `predictsPlaythrough` :2980 only shortcuts when ≤ rate×250 ms ≈ 1 MB remains) → time-to-first-PLAY ≈ 3.3 s + 4 RTTs on a midday seek/start. Sustained: each sim-hour = 22.9 real-s at 157×, 13–26 MB/hour → 0.6–1.1 MB/s needed; fine at 4 MB/s, marginal at 1 MB/s. The showcase demo actually starts at 00:00 (26 KB), so its cold start is cheap; any seek into the day pays the above with a blank map.

**Fix** Loader side (build side is out of scope): a first-paint exception in `shouldSkipParentFetch` — when NO tile at any zoom is currently drawable for the viewport (`getVisibleTiles().length === 0`), allow ONE oversized parent whose bytes are below the primary selection's Σ bytes (13.5 MB vs 13.2 MB here it would still lose; so the honest answer is a summary/coarser tier for gtfs-ch, or `min_zoom` 4–5 with time-binned z4/z5). Report as data-shape + doc drift; no loader change recommended beyond incremental delivery (already in place).

**Confidence** high on the numbers; the browser TTFF is unmeasured.

**How to verify** Playwright on `/demo/gtfs-ch`, seek to 12:00 with CDP throttling at 4 MB/s, read `__sttProbe` `batches`/`decode` timestamps for the first `priority` tile delivered.

### CS-7 [low] `getTiles` → `ensurePagesForTiles` faults in neighbouring pages the bounds query never needed (+117,530 B, +22 % directory bytes on earthquakes), and runs even for ids the archive itself just resolved

**Where** `archive.ts:3373-3410` — per-id page walk with closed-interval tests `:3398 if (p.maxLon < minLon || maxLon < p.minLon) continue;` / `:3399` (lat); no check that `findTileEntry(id)` already resolves before walking the page table. Called unconditionally from `getTiles` :4216.

**Mechanism / Evidence** `pagedebug` mode: after `getTileIdsInBounds` (z2, bbox lon 27.5..180) had faulted its pages, `getTiles(ids)` fetched pages 13 and 14 (`minLon −180, maxLon 0`, z2) because tile x=2 at z2 has `minLon == 0 == page.maxLon` → one extra `bytes=656890-774419` (117,530 B) range. Every tile on a page-bbox boundary drags in the neighbour.

**Consequence** +22 % directory bytes on the earthquakes first frame (526,238 → 643,768 B); one extra request on the critical path (it is awaited before the pack range is issued).

**Fix** In `ensurePagesForTiles`, filter `ids` to those with no `tileEntryByKey` hit first (O(1) each); only walk the page table for unresolved ids. Independently, make the page-vs-tile bbox overlap half-open on the max side. Blast radius: `paged-directory.test.ts:505-795` point-query tests (they assert a found tile, unaffected).

**Confidence** high.

**How to verify** Paged fixture: `getTiles(await getTileIdsInBounds(...))` must issue zero directory requests (fails today for a bbox-boundary tile).

### CS-8 [low] The directory root is not requested until the first selection; without the overview kick it waits a full deck frame after the manifest

**Where** `archive.ts:2759` `getIndex()` is only reached from `getTileIdsInBounds` :4802 (first selection), never from `getMetadata` :2711 or the layer's `_initArchiveAndTileset` :1846 (grep: no `getIndex` in the layer). First selection runs from `_updateTileset` :1594 on deck's next update pass after `setState({archive, tileset})` :2175. The overview kick at :2198 happens to start `getIndex()` at attach time (via :4880) — so showcase primaries get the root fetch early only as a side effect of the overview; overlays with `overviewPreload: false` (buildDemoLayers :992/:1162/:1380/:1480/:1737/:2200), `DemoHoverPreview` (no plumbing) and non-deck consumers do not.

**Consequence** One serial RTT (61 ms warm CF TTFB per §9.4; 200–400 ms cold edge) + ≥1 rAF added to TTFF on those paths. Critical path today: manifest → [construct tileset, setState, next deck frame] → root → leaves → pack → decode(worker boot) — five dependent hops where three (root, worker boot, small whole-directory GET) could overlap the manifest.

**Fix** In `_initArchiveAndTileset` right after `metadata = await archive.getMetadata()` (:1912): `void archive.getIndex().catch(() => {})`. For whole-load directories (storm-tracks 6.6 KB, wpc-fronts 52 KB) this fetches the entire index in parallel with tileset construction; for paged ones only the root (≤3 KB).

**Confidence** high.

**How to verify** Instrumented fetch: the `index/` root request must start before the first `tileset.update()` (today, with `overviewPreload: false`, it starts after).

### CS-9 [low] The 8 s start-gate escape hatch is timed from `play()`, not from the first source registration — embed autoplay can enter "degraded creep" on a slow cold start before any runway was ever probed

**Where** `DemoEmbed.tsx:62-70` calls `play()` from an IntersectionObserver on visibility (before the tileset exists); `playback-governor.ts:1261` `requestPlay` → `enterGate('starting', 1)` :2307 stamps `gateStartedAtWall`; `evaluateGate` :2434 with `!hasAnySource()` never passes; `:2482` fires the hatch after `maxStartWaitMs` 8 s (:978) → `setDegradedCreep(true)` + `'playing'`; `tickHandler` :896 → `refreshFrontier` :2546 → `bufferedUntil = time + runway.simMs` where `getBufferedRunway` returns `simMs 0` until the coverage index exists → the clock is clamped to `time` every tick.

**Scenario** Large archive on a slow link (gtfs-ch at midday ≈ 13 MB, or any cold start > 8 s incl. directory + coverage build).

**Consequence** UI shows "playing", clock frozen at the frontier, `qoeDegradedResumeCount++` and `qoeStartupMs` recorded as a degraded resume that was really a cold start; creep only exits when the runway ≥ 2× the resume gate.

**Fix** Re-stamp `gateStartedAtWall` in `addSource` when the governor is gated and `sources.size` was 0 (first source), or exclude `!hasAnySource()` time from the hatch clock.

**Confidence** medium (code path certain; whether 8 s is exceeded in practice depends on link).

**How to verify** Governor unit test: `requestPlay()` with no source, advance 9 s, `addSource(...)` with an incomplete runway → state must be `'starting'`, not `'playing'`+degraded (fails today).

## Checked and correct

- `archive.ts:2169-2260` `fetchManifest`: single in-flight promise, format/version/capability/schema-hash validation at open, base URL + fingerprint derived once.
- `archive.ts:2770-2820` paged root-only prefix range (`length > SMALL_DIR_THRESHOLD` 256 KiB) with root hash verify; whole-object GET + content-address verify for small directories (storm-tracks 6,591 B, lines-v2 5,514 B, storm4d-sounding 153 B, bixi 955 B) — measured 1 request each.
- `archive.ts:3037` `fetchAndMergePages` dedups per page via `pageFetchPromises` and awaits only ITS pages, not every in-flight page; a query whose pages are all in flight blocks only on those groups.
- `archive.ts:3235` `ensurePagesForBounds` + `pageOverlapsQuery` (shared predicate with `unknownEntriesInBounds` :3340); measured: the FULL-time coverage-index query needs **0** extra leaf bytes over the window query on earthquakes-v2, rainfall-2019, gtfs-ch, nyc-taxi-paths, ais-all-us, drifters (pages are zoom×space partitioned), so `maybeRebuildCoverageIndex` :5113 is directory-free after the first selection.
- `spatiotemporal-tileset.ts:5113` coverage index is signature-quantized (1/8 viewport) and built once per spatial viewport; `getBufferedRunway` :4429 abstains (`complete:false, simMs:0`) until built rather than guessing.
- Layer `debounceTime` default 0 (:675) → the first selection is not debounced; `_updateTileset` :1594 throttles only viewport-only passes; `_handleTimeUpdate` :1403 caps tick-driven reselection at 10 Hz.
- Camera below `minZoom`: `getZoomLevelsToLoad` :2626 clamps into `[minZoom,maxZoom]` so bixi-flowmap at a z5 camera selects z10 as PRIMARY (measured: 2 tiles / 21,797 B / 0.4 ms) — the "z7 → nothing" worry is refuted; `CHILD_LOOKAHEAD_LEVELS` only bounds the zoom-OUT stand-in search in `getVisibleTiles`; `fitZoomToCellBudget` (layer :2699) cannot go below `minZoom`; `entryListsInBounds` :4723 switches to the occupied-cell index above `MAX_QUERY_SCAN_CELLS` 8192 (one-shot warn per zoom :4690).
- `pickTierForZoom` :1952 → `'raw'` when no summary callback; `makeTilesetCallbacks` (`render/tileset-adapter.ts:74`) only wires `getAvailableSummaryTiles` when `metadata.summaryTier` — `tier:'auto'` is inert on summary-less archives.
- `temporalBucketMs` undefined → 3,600,000 in both `getMetadata` :2734 and `normalizeTilesetOptions` :1335.
- Single-bucket / 4-tile archive (storm4d-sounding, measured 1 bucket): `getBufferedRunway` clamps the probe at `idx.timeRange.end` → `complete:true`; horizon floored at `bucketMs`; `getBufferedRanges` :4531 yields one range; `MAX_PREFETCH_BUCKETS` cap never undercuts `gateFloor` (`prefetch-policy.ts:700-760`); `setLoopWindow` rejects degenerate ranges and loop rotation is disabled when `loopSpan ≤ protectedAhead + keepBehind` (:5335).
- `estimateTimeToReadyMs` :4722 returns `null` with zero throughput samples; the governor treats `null` as blind → conservative (:3010), never as instant; `predictsPlaythrough` keeps a 250 ms floor.
- `startOverviewPreload` with `minZoom > 1` → empty zoom list → `'no-tiles'`, zero requests (gtfs-ch, nyc-taxi-paths, bixi, storm-tracks, storm4d-reports, wildfires, osm-nyc, gtfs-nl — measured).
- Overview byte gate correctly REJECTS drifters (909 MiB), satellites (770 MiB), animals (212 MiB), rainfall-2019 (155 MiB), flights (136 MiB), ecco-currents (92 MiB), adsb-paths (64 MiB), ais-all-us (47 MiB), earthquakes (25.9 MiB) before any pack fetch (measured).
- Pinned overview headers are exempt from `flushPrefetch`, `cancelSupersededRequests`, LRU (tested :193/:173); `clear()` :6155 settles a pending preload with `'disabled'`; `preloadOverviewTier` is idempotent.
- `_pushTilesetOptions` :1338 pushes 11 scalar/structural keys only; `setOptions` :1790 compares with `Object.is` (+ structural `scrubAxes`) → `DemoViewer`'s `layers` memo churn (`terrainRevision`, `timeHeightScale`, `activeSummaryToggle`) triggers no reselect/coverage drop; there is NO `tileset.clear()` call site in the showcase (grep) — the "memo identity churn → clear()" risk in memory is refuted.
- Route change teardown: `finalizeState` :1175 → `tileset.finalize()` :6179 (clears debounce/prefetch/bufferChange timers, `clear()` aborts every in-flight batch controller → `runGroupFetches` :4032 `callerSignal` listener → `req.abort()` drops queued scheduler entries and signals running ones, `cleanupSourceIfDrained`), `archive.finalize()` :2140 (lifetime abort, decoder lease release, byte-cache entries `unregisterSharedCacheEntry` :1015); governor disposed by the `usePlayback` effect cleanup; no leaked prefetch loop found. (A queued directory-page group carries no caller signal, so it stays queued until dispatch and then aborts on the lifetime signal — harmless.)
- `usePlayback` (`use-playback.ts:170-190`): governor created in an effect; a tileset that arrives before the governor is parked in `tilesetRef` and handed over on creation; `registry` :382 is a stable `useMemo`.
- OPFS is default OFF (`archive.ts:1986-2010`) and not enabled by any layer/react/showcase code (grep) → the second visit is HTTP-cache only; even when on, OPFS stores tile payloads only (never manifest/directory), so there is no "index.json" cost to worry about — the paged root is ≤3 KB and only the viewport's leaves are fetched (gtfs-ch: 65 KB of an 8.6 MB directory).
- Incremental delivery: `getTiles` :4205 `onTileReady` → `deliverTile` :3956 → `onTileLoad` → rAF-coalesced `setState` (:1486) — the first frame is the first coalesced range group decoded, not the whole batch (gtfs-ch: 3.0 MB group before the 10.2 MB one).
- `isOversizedParent` 2 MiB cutoff protected gtfs-ch from a 13.5 MB z6 placeholder (measured); primary zoom is never skipped.
- `drainOverviewQueue` is reached on both request-queue paths (:3670 per-tile, :3729 batched) only after priority work drained on that pass.
- `enterGate` :2307 re-asserts `setAnimationState(true, speed)` on every source so prefetch runs during the start gate; `addSource` → `evaluateNow` re-checks the gate on registration.
- `cold-start-bench.mjs` drives the real `STTArchive` and its viewport math matches `getViewportBounds` at pitch 0 (two-corner box; §9.5 already flags pitched cameras).

## Doc ↔ code drift

- `docs/roadmap/measurements-2026-08.md` §9.1/§9.3/§9.4 `gtfs-ch` row (459.65 MiB archive, 5,777,483 features, 138 pages, 1.19 MiB first frame at z7.4) describes the archive retired on 2026-08-23. Local `gtfs-ch` is 2,568,269,535 B of packs / 6,275,668 features / 557,899 tiles / 137 pages; first frame measured 26,750 B (t = start) and 13,186,509 B (t = 0.35) at the same camera — ~11× the documented figure at midday.
- §9.6 says the harness "fails on the current working tree with `unsupported formatVersion 2 (expected 3)`" — the whole local fleet is now `formatVersion 3` and `dist/` reads v3; the note is stale. The five `DATASETS` rows §9.6 says to fold in are still absent from `tools/bench/src/cold-start-bench.mjs` (3 entries at :53-80).
- §9.5 / `cold-start-bench.mjs` header claim the bench "mirrors what SpatioTemporalTileset fetches on its first selection pass at the primary zoom": the first pass also fetches up to 4 parent levels under the default `best-available` (:2648) — earthquakes: 154 primary + 148 z1 + 200 z0 tiles, +375 KB of directory and +181 KB of tiles — and, on showcase demos, the overview tier and the coverage slice. This audit quantifies those extras (CS-2/3/7).
- `preloadOverviewTier` docblock (:4840-4868): "Pinned bytes still count in cache accounting; the budget gate keeps that contribution small" — false for tiny-tile archives (count vs bytes, CS-1); "dispatched only when the priority queue is idle, so viewport work is never starved" — true only at the dispatch instant (CS-2).
- `SpatioTemporalLayer.overviewPreload` prop doc (:366-380): "datasets with giant coarse tiles are rejected without fetching anything" — the opposite shape (thousands of tiny coarse tiles) is not gated at all.
- `docs/roadmap/measurements-2026-08.md` §9.3 finding 1 ("single-page directories are fetched whole") still holds; note that even multi-page directories are zoom×space partitioned, so time pruning never removes leaves (measured: full-time vs window queries fetch identical leaf sets).

## Needs measurement

- Browser TTFF and time-to-first-play on `/demo/gtfs-ch` after a seek to ~12:00 under CDP throttling at 4 MB/s (expected ≈0.8 s / ≈3.5 s from the byte counts); read `__sttProbe.batches` (first `priority` batch) and the governor `playback` channel (`waiting` → `ready` wall delta).
- Worker-pool boot latency: `performance.mark` around the first `decode` round trip vs. the tenth, on `/demo/storm-radar` (small) and `/demo/gtfs-ch`.
- In-browser contention of the overview range with the first frame: `/demo/goes-glm-lightning` first `priority` tile wall time with `overviewPreload` true vs. false (expect the 22.2 MB 'low' stream to roughly double the first frame at 4 MB/s).
- Main-thread cost per selection pass on `/demo/hurricanes` with 17,899 pinned headers (`evictUnusedTiles` :5233) — Chrome profile over 10 s of playback, before/after CS-1's fix.
- Decoded pinned footprint in the browser (node estimates: 41.1 MB earthquakes-v2, 24.2 MB hurricanes) including GPU buffers.
- Whether CS-9 is reached in practice: fraction of embed autoplays whose `qoeStartupMs` hits 8,000 (the `playback` probe channel already records `degraded: true` on `ready`).

---

# Appendix 9 — audit-tests-observability

## Tile-loading audit — tests, telemetry, benches, gaps (2026-08-24)

Dimension: what the loader can PROVE about itself. Read-only. Repo root
`/Users/robertchristie/Documents/GitHub/spatiotemporal-tiles`; all paths below are relative
to it unless absolute. Line numbers are against the working tree at ~12:10–12:25 EDT; note
that `packages/core/src/tile-decoder*.ts` and `packages/core/test/tile-decoder.test.ts` were
being edited by ANOTHER session during this audit (mtimes 12:10–12:16), see TO-4.

## Baseline runs (recorded today)

| suite                                                                   | command                                                                                      | result                                                                                                                                                                                                                                                                                                              | time                        |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| core (12:12, mid-edit)                                                  | `cd packages/core && pnpm exec vitest run`                                                   | 100 files: **1 failed / 99 passed**; tests **8 failed / 1346 passed** (all 8 in `test/tile-decoder.test.ts`: BH-5 "(6) host-queued jobs SURVIVE a worker crash", BH-6 "(1) sustained queue-wait dominance GROWS the pool", "(3) a GROWN worker receives the template registry", + 5 more in the same two describes) | vitest 26.0 s / wall 26.4 s |
| core (12:22, re-run after the other session's test-file rewrite landed) | same                                                                                         | **100 files / 1358 tests passed, 0 failed**                                                                                                                                                                                                                                                                         | vitest 6.7 s / wall 7.1 s   |
| playback                                                                | `cd packages/playback && pnpm exec vitest run`                                               | 6 files / **308 passed**                                                                                                                                                                                                                                                                                            | vitest 0.55 s / wall 0.9 s  |
| layers                                                                  | `cd packages/layers && pnpm exec vitest run`                                                 | 86 files / **1592 passed**                                                                                                                                                                                                                                                                                          | vitest 12.1 s / wall 12.6 s |
| bench harness self-tests                                                | `cd tools/bench && pnpm test`                                                                | **27 pass / 0 fail**                                                                                                                                                                                                                                                                                                | 0.42 s                      |
| cold-start (real HTTP, working-tree dist, deployed fleet)               | `cd tools/bench && node src/cold-start.mjs earthquakes-v2 --json`                            | **5 requests, 357,642 B (349.3 KiB)** to first frame: manifest 1×4,225 B, directory 2×238,341 B, packs 2×115,076 B; 45 tiles / 369 features drawn; `cf-cache-status: HIT`                                                                                                                                           | ~3 s                        |
| policy-replay (offline)                                                 | `cd tools/bench && node src/policy-replay.mjs test/fixtures/micro-loop-boundary.jsonl --all` | incumbent 20.12 MiB blended / 126 KiB / 10 reads / 2 refetch / 2 runwayEv / 4 evict; lru 22.14; loop-aware 18.12; belady 18.12                                                                                                                                                                                      | <1 s                        |

The 8 red tests at 12:12 were a mid-edit snapshot, not a regression — see TO-4 for the proof.

## Findings

### TO-1 [high] There is no regression gate on any loading/playback-QoE metric, and the one "deterministic replay" that exists never executes the loader

**Where** `.github/workflows/ci.yml:252-331` (`typescript` job), `:333-368` (retired `bench-regression` block), `:370-419` (`showcase-probe`); `tools/render-test/probe-all-demos.mjs:52-53, :126-147, :180-195`; `tools/render-test/tests/sweep.spec.ts:359-394`; `tools/render-test/tests/render.spec.ts:308-315`; `tools/bench/src/policy-replay.mjs:1-60, :533-560, :808-870, :1040-1105`; `tools/bench/test/policy-replay.test.mjs:265-338, :374-420`; `docs/roadmap/README.md:350-363` (T2).
**Mechanism** Four layers, each of which sounds like a gate and is not:

1. `ci.yml` `typescript` job (:308-325) runs the unit suites and `pnpm --filter @poopdeck.gl/bench test`. The bench tests are the replayer's OWN determinism/conservation tests; they pin the simulator, not the product.
2. `showcase-probe` (:370-419) runs `probe-all-demos.mjs`: 12 demos, `waitForTimeout(8000)` (:132), then a single screenshot classified `blank` if non-background pixels < 0.5 % (:52, :140) plus a fatal-console regex (:28-37). Fail-closed (:183-192) but asserts nothing about time-to-first-tile, stalls, bytes, evictions, fps. A loader that stalls every 2 s or fetches 10× the bytes passes.
3. `sweep.spec.ts` (NOT in CI) records fps/heap/long-tasks/probe channels but its only `expect` is a pixel `diffRatio` gate (:385-394) that is documented as "a no-op when no baselines are present (e.g. on CI, which ships none)" (:364-366). `render.spec.ts` asserts `fps > 8` (:308-315).
4. `policy-replay.mjs` is described as "the arbiter for the program's named QoE metrics" (:34-36) and its determinism is genuinely tested (`policy-replay.test.mjs:374-420`, byte-identical JSON). But its `incumbent` variant is "a faithful PORT of `evictUnusedTiles`'s over-limit branch" (:533-560) — a re-implementation. The file never imports `SpatioTemporalTileset`, `PlaybackGovernor` or `TimeController` (grep: zero hits; the only core import is `STTArchive` at :1170, used solely for `getTileByteSize` under `--archive`). Demand is derived at the primary zoom only (`buildSteps` :455-461 `if (m.z !== step.zoom) continue`), the time window is `[playhead, playhead+timeWindow]` (:428-434; the tileset centres it), transport is instant (:16-20), and the report carries no stall figure (grep `stall` → 0 matches in 1391 lines). Its pinned "baseline" numbers (`policy-replay.test.mjs:274-301`: 10 reads, 129,000 B, 2 refetch cycles, byTier `{a:0,b:2,c:2,d:0}`) therefore cannot move when `spatiotemporal-tileset.ts` regresses.
5. And per `docs/roadmap/README.md:350-363` (T2) GitHub Actions has never executed in this repo; every gate above is hand-run.
   **Scenario** all; most acute for playback on the large sets (nyc-taxi-paths, gtfs-ch at 157×) where the failure modes are stalls/refetch churn that no screenshot can see.
   **Consequence** A regression in prefetch, eviction, runway, gating or scheduling ships silently. Concretely, the campaigns in memory (double-draw at z10/z11; unsatisfiable 4×timeWindow runway; 20–44 % tile misses at pitch>0) were each found by hand in the browser, not by a red job.
   **Evidence** Read the four files end to end; ran `policy-replay` and the 27 harness tests; grep for tileset/governor imports in `tools/bench/src/policy-replay.mjs` (none); the playback reader confirmed there is no tileset→governor integration test anywhere (`new PlaybackGovernor(` appears only in `packages/playback/test/playback-governor.test.ts`, `src/stt-player.ts:152`, `packages/react/src/hooks/use-playback.ts:171`, two showcase globe pages).
   **Fix** A "loading-QoE" vitest gate that runs the REAL objects deterministically. Everything needed already exists:

- trajectory input: reuse the trace format + `buildSteps()` from `policy-replay.mjs` (or a 20-line scripted ramp: playhead 0→N at 157× over a 60 s-bucket archive);
- real `SpatioTemporalTileset` with `helpers/fixtures.ts` `makeAvailableTiles(n, xFromBounds)` + `fakeTile`, OR real `STTArchive` over `helpers/packed-fixture.ts` `packedFromGolden()` + `packedFetch(ds, log)` — the `PackedFetchLog` (`:403-408`) already counts every path and every `Range` header, i.e. requests and bytes for free;
- real `PlaybackGovernor` + real `TimeController` driven by `attachExternalClock()/advanceFrame()` (`packages/playback/test/external-clock.test.ts` shows the harness) under `vi.useFakeTimers({toFake:[…,'performance']})`;
- a deferred fake source whose `getTileDataBatch` resolves after a fixed fake-ms latency (pattern: `eviction-inflight.test.ts:52-80` gated pending promises);
- assert, at the end of the scripted run, exact pinned integers: `governor.getQoeStats().stallCount`, `totalStallMs`, `log.ranges.length`, `Σ bytes`, `tileset.getCacheStats().evictions/runwayEvictions`, and at EVERY frame `tc.getTime() <= frontier` and `cacheBytes <= maxCacheByteSize`.
  Blast radius: test-only. Add it to the `typescript` job. The replayer keeps its role as the policy-variant A/B tool; it is not the gate.
  **Confidence** high — the absence is a grep-level fact and the replayer's non-import is explicit in its own header.
  **How to verify** Introduce a one-line regression (e.g. make `evictUnusedTiles` skip tier B) and run CI: today nothing goes red except, possibly, a unit test that pins tier order; the proposed gate turns red on `runwayEvictions`/refetch bytes.

### TO-2 [low] 13 of 15 layer files build probe payloads (and call `performance.now()`) unconditionally, contradicting the telemetry contract; per-frame only on the heatmap / glide-interpolation paths

**Where** `packages/layers/src/layers/core/animated-point-layer.ts:1487, :1526-1531, :1780-1786, :2115-2122, :1566-1579`; the same pattern at `animated-path-layer.ts:1157, :1247`; `animated-polygon-layer.ts:1214, :1346`; `animated-column-layer.ts:892, :967`; `animated-mesh-layer.ts:1099, :1282, :1327`; `animated-icon-layer.ts:1344, :1432, :1619, :2161`; `animated-line-layer.ts:499, :566`; `animated-arc-layer.ts:634, :705`; `animated-bounding-box-layer.ts:677, :731`; `animated-point-cloud-layer.ts:542, :622`; `splat-layer.ts:426, :593`; `summary/flowmap-layer.ts:748`; `summary/bundled-flowmap-layer.ts:1047`. Gated correctly: `trips/animated-trips-layer.ts:1152-1153, :1226-1233`; `trips/animated-trip-heads-layer.ts:720-721, :930-942`. Contract: `packages/core/src/telemetry.ts:47-50` ("PROBE-OFF DISCIPLINE … the allocation itself never happens"), `packages/layers/src/lib/telemetry.ts:161-172` (the layers shim's own `isProbeEnabled` doc says exactly this). Decoder: `packages/core/src/tile-decoder.ts:197-211` (inline) and `:573-590` (worker).
**Mechanism** `emit()` is a single property read when the bag is absent (`layers/src/lib/telemetry.ts:76-80`), but its ARGUMENT is evaluated first. `prepareTile` (`animated-point-layer.ts:1772-1793`) is called for every resident tile on every `renderLayers()` pass (:1526-1531); on the cached path (:1780-1786) it allocates `{layer, tileKey, cached:true, ms:0}` per tile per pass. `renderLayers()` also does `const t0 = performance.now()` at :1487 unconditionally and at :1566-1579 allocates the summary object plus `residentTimeOffsetCount(tiles)` (:1578), a scan over the resident set done ONLY for the probe. Tally (`grep -c "emit('"` vs `grep -c "isProbeEnabled()"` per file): 13 files with 1–5 emits and 0 gates; the two trips layers gate. In the decoder the inline path calls `performance.now()` three times and builds a 7-field object per tile (:197-211) under a comment that says "Emit telemetry only when the probe is enabled" (:199) — the emit is gated, the work is not; the worker path (:573-590) likewise builds a 12-field object per decoded tile.
**Scenario** all datasets; cost scales with resident tile count × `renderLayers` frequency. In the showcase, time-only ticks go through `context.userData.stt.timeController` → `_handleTimeUpdate` → `setNeedsRedraw()` (`spatiotemporal-layer.ts:1377-1400, :1476-1484`), so `renderLayers()` re-runs only when the tile SET changes (each rAF-coalesced batch landing, `:1490-1500`) — NOT per frame. Exceptions where it IS per frame: `HeatmapLayer` (documented at `:1388-1396`, forces throttled `renderLayers` via `setState`) and `AnimatedPointLayer.renderInterpolated` (`animated-point-layer.ts:1460-1467, :2933-2934`; glide/interpolation mode re-renders every tick).
**Consequence** Arithmetic for gtfs-ch at 157× with 60 s buckets: a window boundary every 0.38 s wall → ~2.6 `renderLayers` passes/s × ~600 resident tiles ≈ 1,600 short-lived objects/s (~100 KB/s garbage) plus one `performance.now()` and one O(N) offset scan per pass. Negligible against the frame budget; not a user-visible cost. It does mean the claim in `telemetry.ts:47-50` and the "probe on vs off within run-to-run noise" acceptance (`telemetry.ts:247-249`) are not what ships, and the per-frame paths (heatmap, glide) pay it 60×/s.
**Evidence** Read the call sites; tallied gates per file; traced the showcase time path (`DemoViewer.tsx:169-171, :310-311`, `buildDemoLayers.ts:398-403`) to confirm `renderLayers` cadence.
**Fix** Mirror the trips-layer pattern in the 13 files: `const probe = isProbeEnabled(); const t0 = probe ? performance.now() : 0;` and `if (probe) emit(...)`; in the decoder, gate `tDecompress/t1` and the payload behind `isProbeEnabled()` and fix the :199 comment. Zero behaviour change; the existing `tools/render-test/tests/lib/metrics.ts:134-137` consumers keep working because they install the bag first. A guard test: install no bag, spy `performance.now`, run one `renderLayers` on a 10-tile fixture, assert zero calls.
**Confidence** high on the mechanism; low severity by measurement (see Needs measurement).
**How to verify** The guard test above fails today on all 13 layers and passes after.

### TO-3 [medium] No always-on network counters exist; the only per-request byte signal is probe-gated and lead-key-labelled, and nothing on the HUD shows bytes, requests, stalls, evictions or decode wait

**Where** grep `bytesRequested|bytesUseful|bytesWasted|requestCount|rangeRequests|bytesFetched|bytesDownloaded|readAmplification` over `packages/core/src` → **zero hits**. What exists: `packages/core/src/request-scheduler.ts:471-478` (probe object only when `isProbeEnabled()`), `:960-975` (`requests` sample), `:245-280` (`SchedulerStats.dispatchedBytesBySource`); `packages/core/src/archive.ts:3199` and `:4509` (`bytes: group.end - group.start + 1`), `:2683-2705` (`beginTransferSample/endTransferSample` → EWMA only); `packages/core/src/spatiotemporal-tileset.ts:1450-1493` (`TilesetCacheStats`), `:6101-6116`; `packages/core/src/archive.ts:5289-5320` (`getCacheStats`); HUD `examples/showcase/src/components/PerformanceMonitor.tsx:61-75, :136-161, :226-327`.
**Mechanism** The wire is observable in exactly three places: (a) the `requests` probe channel — one sample per settled scheduler entry, `bytes` = the coalesced group's range length (a correct wire figure) but keyed by the LEAD tile only (`archive.ts:4017-4020`), present only when a probe bag is installed; (b) `SchedulerStats.dispatchedBytesBySource` — cumulative DRR credit "in the scheduler's currency … requests that declared no `costBytes` are counted at one quantum" (:268-273), consumed by nobody (grep over layers/playback/showcase/tools: zero readers); (c) the throughput estimator receives `(bytes, elapsedMs)` per busy window (`:2699-2705`) and discards the totals. Nothing sums range bytes vs. Σ entry lengths (read amplification from `coalesceGapBytes`), nothing counts requests per tileset, and `TilesetCacheStats`/`archive.getCacheStats()` carry no network field. The HUD (`PerformanceMonitor.tsx`) reads `tileset.stats`/`archive.stats` snapshots and shows FPS, frame ms, JS heap, visible/total tiles, active requests, `priority+prefetch` queue lengths, storyboard, decoded MB, byte-cache MB, hit rate, and per-source runway rows (`REQ/OPT`, `✓` complete, `runwaySimMs/1000` s, red when `runwaySimMs===0 && !complete`, :304-325). It reads `evictions` into its type (:68) and never renders it; it shows none of `runwayEvictions`, `evictionsByTier`, `bytesEvicted`, `prefetchPressureScale`, `stallCount/totalStallMs/creepMs`, `decodeQueue` p95, scheduler occupancy, throughput estimate, or bytes/requests.
**Scenario** all; the large sets are where read amplification and refetch churn matter (nyc-taxi-paths 429k tiles, earthquakes 350k tiny tiles where per-request overhead dominates).
**Consequence** The memory's "T2: no network-level counters as of 2026-07-26" is now HALF true: P0-2 (2026-08-10) added the probe-gated per-request samples, so a harness can price bytes; but a user, the HUD, the MCP tools, and any always-on QoE report still cannot answer "how many bytes/requests did this session cost, and how many were useful". The `archive.stats` 0 % hit-rate oddity (known) is the only byte-cache number on screen.
**Evidence** the greps above; read `getCacheStats` on both classes; read the HUD render tree.
**Fix** (1) Add always-on integer counters to `STTArchive` next to `cacheStats` and expose them in `getCacheStats()`: `requests` (increment at `:4099` dispatch), `bytesFetched` (Σ `g.end-g.start+1` at settle), `bytesUseful` (Σ entry lengths of the group's members — both numbers are in hand at `:3199/:4509`), giving amplification = `bytesFetched/bytesUseful`. Cost: three `+=`. (2) Surface `runwayEvictions`, `prefetchPressureScale`, `stallCount`/`totalStallMs` (from `getSourceRunways`' sibling `getQoeStats`, already threaded into `DemoViewer.tsx:615-616` as a callback pattern) and `bytesFetched/requests` as HUD rows. (3) Optionally publish `dispatchedBytesBySource` on a `scheduler.stats` snapshot so it has one reader. Blast radius: additive fields; `TilesetCacheStats` consumers unaffected.
**Confidence** high.
**How to verify** After (1), `archive-transport-hardening`/`tile-batch-coalescing` style test: fetch a 3-tile coalesced group through `packedFetch(ds, log)` and assert `stats.bytesFetched === Σ(range lengths in log.ranges)` and `stats.bytesUseful === Σ(entry.length)`.

### TO-4 [low] The 8 red `tile-decoder` tests at 12:12 were a concurrent-edit artefact; the current tree is green — but the working tree is being edited under the auditors

**Where** `packages/core/test/tile-decoder.test.ts` (mtime 12:16:29 today; 1567 → 1671 lines during this audit), `packages/core/src/tile-decoder.ts` (mtime 12:14:30, +180 lines uncommitted), `packages/core/src/tile-decoder.worker.ts` (12:10:03, +180 lines uncommitted). `git diff --stat` (read-only) confirms all three modified; `git log -3 --oneline -- packages/core/test/tile-decoder.test.ts` = `d5163aa e084ccd 5f5a693`.
**Mechanism** The uncommitted BH-7 change makes `pullNext` post one `{type:'decodeBatch', items:[…]}` envelope (`tile-decoder.ts:792`) instead of per-tile `{type:'decode'}` messages. The decoder reader ran HEAD's test file against the current source: 23/48 fail, all because `FakeWorker` pushed the envelope verbatim and `decodeMessages()` filtered `type==='decode'` → `[]`. The uncommitted test diff is the adaptation (`FakeWorker.postMessage` unwraps `decodeBatch` :71-77, new `settleAll()` :145-157, BH-6 `answerOne` :900-910). The 8-failure snapshot is the intermediate state where the unwrap had landed but `settleAll`/`answerOne` had not (the six BH-5 order tests + BH-6 (1) grow + (3) templates = 8). Not `hardwareConcurrency` (every BH-6 test injects `cores` via the constructor seam :924 → `src:467-476`); not the `decompressMs/parseMs` split (additive, asserted nowhere: grep `decompressMs|parseMs|queueWaitMs|__sttProbe` in the test → none); not a real regression (52/52 ×3 at 12:16+, 1358/1358 in my 12:22 full re-run).
**Scenario** n/a (process).
**Consequence** Any "baseline" number recorded by the ten parallel auditors between 12:10 and 12:17 for `tile-decoder*` is from a moving target. The BH-7 batch-envelope change is real, uncommitted, and — per the decoder reader — the worker module `tile-decoder.worker.ts` is executed by NO test (its batch reply assembly, cancel-ACK, timing object and transferable dedupe at `:150-166` run only in a browser).
**Evidence** the two suite runs above (12:12 red / 12:22 green), the reader's HEAD-test-vs-current-source experiment, file mtimes.
**Fix** None for the tests. For the gap: a single vitest that imports `tile-decoder.worker.ts` with a stubbed `self`/`ctx.postMessage` and pushes one `decodeBatch` of two real v2 frames (`helpers/v2-frame.ts`) through `onmessage`, asserting the reply shape, `timing` fields and that `transfer` contains each payload buffer exactly once.
**Confidence** high.
**How to verify** `git stash`-free: `git show HEAD:packages/core/test/tile-decoder.test.ts` into the scratchpad and run it against the current source — 23 failures reproduce; the current file passes.

### TO-5 [medium] Ten loader invariants the playback experience depends on have no test; two more are pinned only at a single instant or with the oracle stubbed

**Where** `packages/core/test/*`, `packages/playback/test/*`, `packages/layers/test/*` (greps and full reads, per-file table below). Key sites: `packages/core/src/spatiotemporal-tileset.ts:4429-4472` (runway clamps at `idx.timeRange.end/start`, no loop handling), `packages/playback/src/playback-governor.ts:555, :905-913` (`TICK_PROBE_INTERVAL_MS = 200`), `:2585-2587` (`bufferedUntil = time + direction * runway.simMs`).
**Mechanism / status of each requested invariant**

| #   | invariant                                                                      | status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | evidence                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | same tile key never fetched twice across priority + prefetch queues            | **NOT pinned.** Production guards exist (`:3485-3487` `queuedKeys` over both queues; `:3525-3532` revivable check; `:3169-3178` promotion removes the key from the prefetch queue) but no test counts per-key fetch multiplicity across the promote-while-in-flight case. `prefetch-flush-needed.test.ts:97-104` constructs exactly that case and asserts only `signal.aborted===false`; `prefetch-runway.test.ts:666-669, :757` has the only per-key counter (`refetched===0`) but its trace keeps priority at bucket 0 and runway at t≥1000 so a cross-queue duplicate is unreachable; `prefetch-slicing.test.ts:279-281` is no double-DELIVERY. Counter-evidence pinned as intended: `archive-transport-hardening.test.ts:316-317` — two concurrent identical `getTiles` ⇒ **2 range requests** (the archive does not dedup)                                                                                                                                                                                | prefetch + scheduler readers                                                                                                                                                                                                                                                                                                                                                                                      |
| 2   | `cacheBytes ≤ maxCacheByteSize` when the runway demand exceeds the cache       | **Pinned only per-pass, never over a session.** `prefetch-runway.test.ts:438-541` asserts `admitted×decoded ≤ 0.5×BYTE_CACHE` (:522) for ONE pass with the animation bit deliberately OFF (:349-353) because `extendPrefetchIfDrained` (`:4286-4290`) stacks passes while animating; the `runwayEvictions===0` headlines (:413, :748) run where `estimateTileSize(fakeTile)≈0` so the COUNT cache evicts. The eight eviction files set `enablePrefetch:false` and cap by tile COUNT only (`eviction-buffered-timeline.test.ts:186`, `eviction-playhead-tiers.test.ts:141,154,530`); `:184-203` concedes the cap is violated for one pass. No test asserts `cacheBytes ≤ maxCacheByteSize` after EVERY settle of an animated multi-pass run                                                                                                                                                                                                                                                                     | eviction + prefetch readers                                                                                                                                                                                                                                                                                                                                                                                       |
| 3   | loop-wrap continuity                                                           | **half, and the prefetch half is not implemented**: governor pins both halves with a real rAF wrap (`playback-governor.test.ts:868-896` stall-not-lurch, `:898-916` seamless) but with a CONSTANT `1_000_000` runway, so "loop start buffered while loop end was not" is indistinguishable; tileset side pins only eviction rotation (`eviction-playhead-tiers.test.ts:354-480`). `setLoopWindow` (`:2112-2123`) is read at exactly ONE site — the BH-7a eviction rotation (`:5362-5364`); the prefetch plan is linear (`prefetch-policy.ts:779` `endTime = time + direction × effectiveAhead`, no modulo) and `getBufferedRunway` clamps at `idx.timeRange.end` (`:4468-4472`). At a wrap the playhead jump exceeds `seekThreshold` (`:2533-2538`) → total `flushPrefetch()` — by code reading a looping demo discards its runway every lap and rebuilds from the loop start. Zero `loop` matches in the seven prefetch files, `buffered-runway.test.ts`, `cost-oracle.test.ts`                               | prefetch + eviction readers (mechanism belongs to the loop auditor; recorded here because it is UNTESTED)                                                                                                                                                                                                                                                                                                         |
| 4   | clock never advances past `bufferedUntil` on a required source                 | **single-instant only, never as a timeline property**: `playback-governor.test.ts:234-250` (`tc.setTime(100_400) → 100_000`), `:332-346` backward, `:1952-1975`; every stub's `getBufferedRunway` returns a fixed number independent of `time` (`:49-56` and 8 other makers), so a moving frontier is never modelled and the ≤ `                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | speed                                                                                                                                                                                                                                                                                                                                                                                                             | ×200 ms` overrun window between tick probes (`src:905-913`) is uncharacterised | playback reader |
| 5   | evicted tile's resources released                                              | **core: yes** — `onTileUnload` is the exact-list oracle in `eviction-playhead-tiers.test.ts:198-443`, one `evict` probe sample per unload (`:779`), `cacheBytes→0` on `finalize/clear` (`eviction-inflight.test.ts:121-139`); `cacheBytes === Σ resident` only for a one-tile cache (`:118`). **layers side: no.** Prepared/sublayer caches are pruned by diffing against `state.tiles` on render (`animated-point-layer.ts:1497-1509`, `animated-trips-layer.ts:1168-1182`), not via `onTileUnload` (the chassis only forwards it to the prop, `spatiotemporal-layer.ts:2100-2103`); the only pin is `sublayerCache.size` 2→1 in `chassis-driver.test.ts:401-405` — `preparedTileCache` pruning is unpinned, the mocked deck classes have no `finalize` so GPU release is unobservable, and `chassis-lifecycle.test.ts` mocks `tileset.finalize` so `onTileUnload`-per-resident-tile at finalize is unobservable; `state-backed-caches.test.ts` checks prototype descriptor shape only                        | eviction + layers readers                                                                                                                                                                                                                                                                                                                                                                                         |
| 6   | worker transfer is zero-copy                                                   | **ABSENT** — `FakeWorker.postMessage(msg, _transfer?)` discards the transfer list (`tile-decoder.test.ts:65`); nothing asserts `byteLength===0`/detachment; `:664-700` pins the opposite direction (exactly one `slice(0)` at pull); `tile-transferables.test.ts:63-192` pins the LIST `collectTransferables` builds, not that it is passed or detaches; the worker module is never executed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | decoder reader                                                                                                                                                                                                                                                                                                                                                                                                    |
| 7   | 404 pack does not hold the clock forever                                       | **write-off pinned at the tileset seam, never via HTTP 404.** `failed-tile-retry.test.ts:128-135` (`getBufferedRunway(0,1).simMs` 0 → >0 after three null settles, `estimateCost().tiles→0`), `:321-327` (5 min), `:464-469` (all-abort) — but the failure is a `getTileDataBatch` stub returning `null`/throwing. No test threads an HTTP 404 through `STTArchive`; `archive-retry.test.ts:120-131` degrades a dead host to `null` tiles with `status:500` and `retryDelaysMs:[0,0]`. Since `archive.ts:2305-2308` throws the same `Error` for every `!ok` and `:2512-2539` retries anything non-abort, a real 404 costs the full `[250,1000]` jittered ladder + per-member fallback (~1.25 s) before `null` reaches the tileset, then the tileset's own 500/1000/2000 ms ladder (~3.5 s) — that ~4.75 s end-to-end latency-to-write-off is measured by no test                                                                                                                                               | scheduler reader                                                                                                                                                                                                                                                                                                                                                                                                  |
| 8   | small single-bucket archive plays without gating                               | **ABSENT** — no test builds a 1-bucket archive (bucket counts used: 4, 6, 20, 21, 30, 37, 50, 60, 2000); the governor pins "complete ⇒ playing" at one instant with a stub flag (`:151-158, :221-232`) and never plays through a range asserting `stallCount===0`; core pins `complete:true` on a fully-resident index (`buffered-runway.test.ts:139-185`) but never composes it with the governor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | both readers                                                                                                                                                                                                                                                                                                                                                                                                      |
| 9   | prefetch bytes ≤ `maxCacheByteSize × PREFETCH_CACHE_FRACTION`                  | **pinned, but narrower than the sentence.** The mock at `prefetch-runway.test.ts:476-479` is in the A/B CONTROL arm (the pre-repair formula), not the assertion arm — not vacuous. What is pinned: the pure budget math (`prefetch-policy.test.ts:288-320, :333-373`), the per-pass F3 bound `fixed×DECODED ≤ 0.5×BYTE_CACHE` (`prefetch-runway.test.ts:522`). What the code guarantees (`prefetch-policy.ts:899-904, :943-952`; tileset `:3471-3477, :3534-3542, :3575-3577`) is a PER-PASS bound on COMPRESSED directory bytes with a 4 MiB floor that wins below `8 MiB × expansion` of cache (cold expansion 8 → any cache under 64 MiB), the first tile admitted unconditionally, and `extendPrefetchIfDrained` stacking passes while animating — so "never exceeds" over a session is neither implemented as a resident-byte ceiling nor tested. The 4-tile / 8-tile numbers in `runway:232` and `slicing:131-134` are floor-driven, not fraction-driven (contrary to comments at `slicing:62/:112`)     | prefetch reader                                                                                                                                                                                                                                                                                                                                                                                                   |
| 10  | no selection at pitch>0 drops on-screen tiles — does it drive a real viewport? | **real viewport yes, but the chain is split at the layer/tileset boundary**: `chassis-viewport-3d.test.ts:117-129` and `chassis-viewport-bounds.test.ts:190-201` construct a REAL `WebMercatorViewport` (pitch 0/30/55/70/85 × bearing 0/45/135/270; 23,328-camera sweep at `:787-793`) and assert zero misses against an exact convex-clip ground truth (`:604-620`) — but the "selected set" is a test-local transcription of `boundsToTiles` (`:132-136`, admitted) and neither file ever constructs `SpatioTemporalTileset` or calls `getVisibleTiles`. The only core test that pushes a pitched camera through the real selection path, `mixed-zoom-cover.test.ts:486-500`, hands `update()` the AABB of its OWN oracle samples (`boundsOf(points)`, :488) with a test-built camera — production `getViewportBounds`/`_deriveFrustumCut` are never on the path to `getVisibleTiles`. Three of its contracts are `it.fails` (`:599, :660, :668`) and two in `parent-fallback-clamp.test.ts` (`:309, :345`) | selection reader                                                                                                                                                                                                                                                                                                                                                                                                  |
| 11  | cold-start round-trip count                                                    | **no test.** `packedFetch` records every path in `log.paths` (`packed-fixture.ts:465`) but no file asserts on `paths` at all (grep `paths.length                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | paths).to`across the 14 transport files: zero). Nearest:`tile-batch-coalescing.test.ts:755` `log.ranges.length toBe(1)`(ranges only, after`getIndex`), `archive-retry.test.ts:91`(pack-range attempts only),`paged-directory.test.ts:220`(directory BYTES, not calls),`archive-opfs.test.ts:46-78` ("zero new HTTP calls" on a warm OPFS). The bench measures it (5 requests / 349.3 KiB today) but is not a gate | scheduler reader                                                               |

**Consequence** The invariants most tied to "seamless playback" (1, 2, 3, 4, 7, 8) are the ones with no deterministic pin over a session; the 3D-selection fix of 2026-07 is pinned on both sides of the layer/tileset seam but not across it; and the one invariant that IS asserted per-pass (9) is floor-dominated for every cache under 64 MiB. Corpus-wide vacuity tally from the seven full reads: VACUOUS — `prefetch-flush.test.ts:209-242`, `paged-scheduler-supersede.test.ts:362-406`, `mixed-zoom-cover.test.ts:822-827`, `eviction-buffered-timeline.test.ts:178-182`, `tile-decoder.test.ts:321-348`, `auto-speed.test.ts:173-184`, `playback-governor.test.ts:689-697, :746-771, :1576-1590, :3105`; `it.fails` ×5 (`mixed-zoom-cover:599,660,668`, `parent-fallback-clamp:309,345` — FS-3 pending, green by failing); WEAK headline claims — `chassis-viewport-bounds.test.ts:244-259` (horizon-blind sampler), `viewport-throttle.test.ts` (never asserts the trailing viewport), `state-backed-caches.test.ts` (descriptor shape only), `summary-tier-dispatch.test.ts` (spy counts only), `shared-scheduler-archive.test.ts:377-482` (fairness qualitative at budget 4). Everything else is SOLID against its own stated claim.
**Fix — smallest deterministic test per gap** (helpers from `packages/core/test/helpers`):

- (1) dedup: `makeAvailableTiles(20)` + a `getTileDataBatch` spy that records every id; `update()` at bucket 0 with `prefetchAhead` covering buckets 1-4 and NO settle; then `update()` to bucket 2 (now a priority need for a tile already in the prefetch queue); settle; assert every id appears exactly once across all batch calls (`Map<key,count>` all 1).
- (2) bound: `maxCacheByteSize: 8×MiB`, `getTileByteSize = () => 2×MiB`, `prefetchAhead` = 10 buckets, `sizedTile` (pattern `eviction-playhead-tiers.test.ts`) so decoded size ≈ 2 MiB; drive 30 buckets with `setAnimationState(true, speed)`; after EVERY `settle()` assert `getCacheStats().cacheBytes <= 8×MiB` (not just at the end).
- (3) loop: `setLoopWindow({start:0,end:10×BUCKET})`, load buckets 8-9, leave 0-1 unloaded; assert `getBufferedRunway(9×BUCKET, 1)` reports `complete:false` and `bytesPending>0` (today it reports `complete:true` at the dataset end — this test FAILS today, which is the point); governor twin: `makeLoopingClock` with a runway stub that is a FUNCTION of time (`runway(t) = t < 9000 ? 1000 : 0`) and assert `state==='seeking'` at the wrap.
- (4) clock ≤ frontier: governor + real `TimeController.attachExternalClock()`; source stub `getBufferedRunway(time) => max(0, frontier(time) - time)` where `frontier` is a scripted step function; `advanceFrame(16)` × 600 at speed 157; after every frame assert `tc.getTime() <= frontier + |speed|×TICK_PROBE_INTERVAL_MS` and record the max overrun as the pinned number.
- (7) 404: real `STTArchive` over `packedFromGolden` with `packedFetch` returning `{ok:false,status:404}` for one pack path; tileset `update()` over a bucket in that pack; `settle()`; assert `getBufferedRunway` treats the bucket as written off (`complete` or `bytesPending===0`) within the retry ladder's fake-timer horizon, and `onTileError` fired once per tile.
- (8) single bucket: `makeAvailableTiles(1)` with `BUCKET_MS = timeRange span`; `update()` once; `settle()`; hand the tileset to a real governor as the required source; `requestPlay()`; advance 5 s of frames; assert `getQoeStats()` is `{stallCount:0,totalStallMs:0,degradedResumeCount:0,creepMs:0}` and `state==='playing'` within one gate.
- (10) cross-seam: in `packages/layers/test`, instantiate a real `SpatioTemporalTileset` with `getAvailableTiles` = a bounds-honouring enumerator, call the chassis's real `getViewportBounds(v)` for a pitch-70/bearing-135 `WebMercatorViewport`, feed it to `tileset.update()`, and assert `getVisibleTiles()` ⊇ the convex-clip ground-truth set from `chassis-viewport-3d.test.ts:604-620`.
- (11) round trips: real `STTArchive` over `packedFromGolden` with `packedFetch(ds, log)`; `getTilesInBounds(bounds, z, range)`; assert `log.paths.length === 5` (or whatever the golden's paged layout yields) and `log.ranges.length === N` — a pinned integer the paged-directory work can move deliberately.
  **Confidence** high on absence (grep + full reads); medium on the sketches' exact assertions (some depend on retry-ladder timing constants).
  **How to verify** each sketch fails today either because the assertion has no producer or (for 3) because the behaviour is absent.

### TO-7 [low] Prefetch/eviction suites are coupled to real wall-clock timers against the real 250 ms debounce, and one `installClock` is installed after the object that captured `Date.now`

**Where** `packages/core/test/prefetch-runway.test.ts:673, :698, :706` (tileset built at :673, `installClock()` at :698, `advanceClock(300)` at :706); `packages/core/src/prefetch-policy.ts:458-459` (`constructor(clock: Clock = Date.now)` captured by reference at construction; tileset `:1557` `new PrefetchPolicy()`); `helpers/clock.ts:19-24` (spies `Date.now`, timers stay real); `prefetch-runway.test.ts:84, :88` (`settle(80)` must stay < 250 ms `PREFETCH_DEBOUNCE_MS`, `prefetch-policy.ts:326`, or `extendPrefetchIfDrained` `:4286-4290` stacks a second pass); `prefetch-flush.test.ts:202-204` (25 ms settle vs 250 ms debounce); `buffered-runway.test.ts:393-418` (throttle bounds on real timers); `tileset-set-options.test.ts:328-335` ("nothing fired in 25 ms" vs a 5 s debounce); `active-request-ownership.test.ts:46-56` (5/20/60 ms real margins). No prefetch file uses `vi.useFakeTimers` (grep: none in the seven).
**Mechanism** The CO-2 session at `prefetch-runway.test.ts:636-760` reads as a stepped-clock scenario (`advanceClock(300)`), but the `PrefetchPolicy` inside the tileset captured the real `Date.now` before the spy was installed, so its debounce/ladder/recovery see ≈560 ms of REAL elapsed time; the test passes on wall-clock coincidence, not on the clock it claims to drive. The other sites pass because a settle of 20–80 ms is shorter than 250 ms on a fast machine.
**Scenario** CI (which has never run, T2) or a loaded laptop: a 250 ms+ stall in a `settle(80)` flips `:84/:88` (second pass stacked) and `prefetch-flush:202-204` (queue refilled).
**Consequence** Flaky pins on exactly the runway/eviction invariants that matter most; and one "stepped-clock" test that is not stepped.
**Evidence** prefetch reader traced the capture site and the install order; `helpers/clock.ts` header documents "WITHOUT faking timers".
**Fix** In `prefetch-runway.test.ts` move `installClock()` above the tileset construction (as `prefetch-runahead-cap.test.ts:75, :157` already do — this is the one-line fix); longer term, switch the prefetch suites to `vi.useFakeTimers({toFake:[…,'Date','performance']})` + `advanceTimersByTimeAsync` (the pattern `failed-tile-retry.test.ts` already uses successfully against the retry ladder).
**Confidence** high on the capture-order defect (code reading); medium on flake likelihood (not observed in today's runs).
**How to verify** Insert `await settle(300)` before `:84` — the assertion at :84/:88 changes outcome; or assert inside the CO-2 session that `policy['clock']() - realStart >= 300` (fails today).

### TO-8 [low] One transport test is vacuous by construction: it "disables" a scheduler kill-switch option that does not exist

**Where** `packages/core/test/paged-scheduler-supersede.test.ts:362-406` (`configureSharedScheduler({ enabled: false, … })` at :365, titled/commented as the "disabled (kill-switch) / legacy path"); the same non-option `enabled:` passed at `shared-scheduler-archive.test.ts:316, :384, :488, :529, :581, :647` and `spatial-scheduler-tiebreak.test.ts`; `packages/core/src/request-scheduler.ts:283-306` (`SharedRequestSchedulerOptions` = `{maxRequests, byteQuantum}`), `shared-scheduler.ts:100-134`; `archive.ts:4047` (singleton used unconditionally); stale comment `archive.ts:3134` ("enabled, legacy cursor runner otherwise").
**Mechanism** The option is silently ignored (object spread onto a typed option bag in a `.mjs`-style loose call), so test 2 re-runs test 1's path with `maxRequests: 24` and `maxConcurrentRequests: 1` under a false name. Nine call sites carry the dead flag; eight are harmless.
**Scenario** n/a (test hygiene).
**Consequence** A reader of the suite believes a legacy non-scheduler path is covered; there is none.
**Evidence** scheduler reader cross-checked the option types and the archive call site.
**Fix** Delete test 2 (or retitle it as the per-archive-cap variant) and drop the `enabled:` keys; fix the `archive.ts:3134` comment.
**Confidence** high.
**How to verify** TypeScript with `exactOptionalPropertyTypes`/excess-property checks on that literal would already reject it.

### TO-6 [low] Probe-ON ring maintenance in the core and playback shims is O(4096) per sample once a channel fills; the layers shim already fixed this

**Where** `packages/core/src/telemetry.ts:220-221` and `packages/playback/src/telemetry.ts:71-72` (`if (arr.length > MAX_SAMPLES) arr.shift()`), vs `packages/layers/src/lib/telemetry.ts:67-73, :87-89` (`splice(0, 1024)` batch trim, with the rationale "the old `shift()` path copied ~4k array slots every frame forever once a channel had filled").
**Mechanism** Once `requests`/`decode`/`evict` reach 4096 samples, every further `emit` shifts the whole array. `policy-record.mjs:110-130` drains by `splice` every 250 ms precisely because "a busy composite route overflows them in seconds" (:97-98); a HUD/consumer that does not drain (e.g. `frame-cost.mjs`, which reads at the end) runs the shift path for the rest of the session.
**Scenario** probe-ON measurement runs only (frame-cost, scrub-cost); never production.
**Consequence** Measurement bias in exactly the harnesses meant to measure frame cost: after ~4096 decodes the probe itself adds a 4096-element `shift` per decode/request/evict.
**Evidence** read all three shims.
**Fix** Copy the layers shim's `SAMPLE_TRIM_BATCH` splice into the two others (3 lines each). `telemetry.test.ts:95-120` pins "MAX_SAMPLES+1 shifts exactly one" and would need its expectation changed to "length stays within (MAX−BATCH, MAX]".
**Confidence** high.
**How to verify** microbench: 20,000 emits with the bag installed, before/after.

## Test corpus

Verdict rubric used by all readers: VACUOUS if the oracle is stubbed to the asserted value, only `toBeDefined`/`not.toThrow`/`>=0`, the function under test is mocked, a private method is called with inputs no caller builds, an instant fake where the invariant is about ordering/latency/cancellation, fake timers never advanced past the deadline, or the expected value is a constant copied from the implementation; WEAK if it would still pass under a plausible regression; else SOLID. No `.skip/.todo/.only` anywhere in the corpus; `it.fails` ×5 (listed). Helpers: `packages/core/test/helpers/{fixtures,clock,packed-fixture,opfs-shim,v2-frame,track-tiles}.ts`.

### core — prefetch family

Shared fixture facts: `helpers/fixtures.ts:73-93` `makeAvailableTiles(n)` is a single-cell archive (one tile per 1 s bucket at x=0,y=0 regardless of bounds → a pan never changes the needed SET, only time does); `helpers/clock.ts` spies `Date.now` but timers stay real, and `PrefetchPolicy` captures `Date.now` by reference at construction (`prefetch-policy.ts:458-459`), so `installClock()` only reaches the policy if called BEFORE the tileset is built; no prefetch file uses `vi.useFakeTimers` — every file waits real 20–400 ms settles against the real 250 ms `PREFETCH_DEBOUNCE_MS`.

| file                            | lines | #tests | invariant pinned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | fake / helper                                                                                                                                                                                                                                                                                                                | verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ----- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prefetch-flush-needed.test.ts` | 162   | 2      | a spatial pan (>1/8 viewport) must NOT abort an in-flight prefetch slice the playhead has walked into (`flushPrefetch(true)` → `:4781-4786` needed-key exemption), while a seek (`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Δt                                                                                                                                                                                                                                                                                                                           | > max(timeWindow, speed×SEEK_DETECTION_REAL_MS)`, `:2533-2538`) and the governor's no-arg flush stay total; the seek step at :100 is exactly one threshold                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `makeAvailableTiles(200)`; controllable `GatedBatch` (:57-67) rejecting on abort; real settles 30/300 ms | SOLID (exact booleans on live `AbortSignal` :95-123, :151-158). Only the SPARED side is asserted — the lookahead slices that should still die are never checked, so "spare everything" passes |
| `prefetch-flush.test.ts`        | 335   | 8      | `flushPrefetch()` aborts in-flight prefetch batches/singles, empties queue, never touches priority tier; auto-flush on >1-window jump, not on half-window; spatial flush keyed on 1/8-viewport quantised bounds and zoom; flushed tile re-loadable                                                                                                                                                                                                                                                                                                                                                                                                  | `makeAvailableTiles(100)`; `gatedBatchFn` (:35-43) rejects on abort; never-resolving `getTileData` recording signals; test 5 instant fakes                                                                                                                                                                                   | Mostly SOLID. **VACUOUS :209-242 (e)**: instant fakes + 64-bucket horizon = one cold slice already resident by :228, so `flushPrefetch()` finds nothing unloaded (`:4758-4764` deletes only `!isLoaded`) and :239 is satisfied by the prefetch load itself. **WEAK :87**: "nothing from aborted batches landed" holds only because the fake REJECTS on abort — the `isCancelled` late-resolution latch (`:4787-4793`) is never exercised by a batch that resolves after abort (true across all seven files). :202-204 tolerance `> queuedBefore − 4` relies on the 250 ms debounce vs a 25 ms settle                                                                                                                                                                                                                          |
| `prefetch-policy.test.ts`       | 1124  | 67     | pure `PrefetchPolicy`: flip at exactly `DIRECTION_FLIP_THRESHOLD`; horizon `max(window×steps, speed×8 s)` capped `max(64 buckets, speed×5 s)`; count budget `max(64, floor(0.5×cache))`, byte budget `max(4 MiB, 0.5×cap÷clamp(expansion))`; `byteExpansionRatio` byte-weighted, cold <4 samples, clamped [1,64]; run-ahead cap + gate floor; byte-feasibility bisection (≤8 probes, floor when infeasible, byte-identical to legacy on all kill-switch spellings); AIMD ladder 0.7ⁿ floored 0.25 with pinned 4480/3136/2195.2/1600, recovery gated 5 s quiet + 1 s pacing; runway throttle/re-anchor; pass generation, 250 ms pacing, slice clamps | no tileset; injected `fakeClock()` (:40-48) advanced PAST every deadline (:823-912); linear oracle `bytes(h)=10·h` recording probes                                                                                                                                                                                          | SOLID (numbers derived in-line). (g) :730-736 asserts the five ladder constants as literals — an explicit tripwire, pins no behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `prefetch-runahead-cap.test.ts` | 266   | 6      | `setPrefetchRunAheadLimit` bounds dispatched frontier at 3 buckets; `null` re-extends; lowering evicts nothing; speed-scaled floor lifts a 3-bucket cap; window floor under 1 ms cap; `setBandwidthWeight` pass-through; ladder decays `prefetchPressureScale` and steps +0.1 after 5 s quiet; CO-2 inert with oracle withheld/blind                                                                                                                                                                                                                                                                                                                | `makeAvailableTiles(600)`; instant `async` batch fake; `installClock` BEFORE ctor (:75, :157 — correct)                                                                                                                                                                                                                      | SOLID overall. **WEAK :126-137**: `prefetched.has(1000)` is equally true if the cap is ignored (uncapped horizon contains bucket 1). **WEAK :120**: bound 40 vs true floor 50 buckets. :204 `>= 0` no-op. Ladder test asserts `scale<1` and `evictions>0`, not rung count                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `prefetch-runway.test.ts`       | 1084  | 18     | per-pass enqueue ≤ floor(0.5×maxCacheSize) nearest-first; backward direction after hysteresis; count budget binds when byte-blind; byte budget stops at exactly [1k..4k] and re-anchors; 100×-skew A/B: byte arm 0 runway evictions, count arm >0; F3 `admitted×decoded ≤ 0.5×cache` while the pre-repair formula overshoots (:522-531); expansion cold=8 → measured=4; CO-2 A/B: solved arm 0 evictions ∧ ≤ bytes ∧ ≤ requests ∧ 0 refetches (:744-758); parent-skip flat / expected-value rules incl. cold bit-for-bit sweep; runway warms primary zoom only under parent-fallback, full union under additive                                     | `makeAvailableTiles(600)`; production `estimateTileSize`; `vi.spyOn(anchorTruncatedRunway)` observation-only; `enqueueBudgetBytes` mocked ONLY in the A/B control arms (:316-319, :473-481 — the assertion arm is real); instant batch fakes; `installClock` at :569 before ctor (correct) but at **:698 AFTER ctor (:673)** | Mostly SOLID. **WEAK :137-139**: passes with ZERO backward prefetch (direction flag + priority buckets already satisfy it; bound 200 vs budget 150). **WEAK :389-391**: bound 20 MiB vs an actual ≈2 MiB runway (4 MiB floor → 2 tiles); :396-399 self-admittedly non-straining (fakeTile has no buffers). **Fixture defect :698/:706**: `advanceClock(300)` cannot reach the policy's captured clock — the CO-2 session passes on ≈560 ms of REAL elapsed time. :84/:88 depend on `settle(80) < 250 ms` debounce. :349-353 turns the animation bit OFF to stay single-pass, so the resident runway over a SESSION vs the cache fraction is never pinned. `runwayEvictions===0` headlines (:413, :748) run where `estimateTileSize(fakeTile)≈0` — the COUNT cache evicts, not bytes. 7 of 18 tests are `enablePrefetch:false` |
| `prefetch-slicing.test.ts`      | 285   | 6      | slices at throughput×1 s: every slice ≤4 tiles, first two exactly [1000..4000],[5000..8000]; slice budget nests in enqueue byte budget; `fetchPriority` low/auto; cold slice = 4 MiB/64 KiB = 64 tiles; oversize tile ships alone in order; `onTileReady` marks loaded before settle, no double-delivery                                                                                                                                                                                                                                                                                                                                            | `makeAvailableTiles(600)`; instant spies; injected `getThroughput`/`getTileByteSize`; test 6 controllable gate                                                                                                                                                                                                               | SOLID (exact sequences). Header's "one slice in flight at a time" (:17-18) never asserted — instant fakes make parallel dispatch invisible. The 4/8-tile numbers are FLOOR-driven (`PREFETCH_MIN_BUDGET_BYTES` 4 MiB), not the 0.5× fraction the comments at :62/:112 cite                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `prefetch-supersede.test.ts`    | 375   | 8      | `cancelSupersededRequests` (`:4319`): in-flight prefetch batch survives an ordinary step and later delivers; priority batch survives partial supersession, dies only when every member is gone; pan auto-flushes prefetch; seek threshold speed-aware; byte-truncated runway same semantics; per-BATCH dispatch accounting (bucket 51 000 dispatches while a 51-tile batch > `maxRequests` 24 is pending, not aborted)                                                                                                                                                                                                                              | `makeAvailableTiles(200)`; controllable `gatedBatchFn`; every `update(…, true)` skips debounce                                                                                                                                                                                                                               | SOLID. **WEAK :220/:229**: seek threshold pinned only to "between 5 000 and 5 000 000" (actual 100 000). Never a prefetch record AND a priority request for the SAME key; per-tile (non-batch) supersession untested; direction-flip flush untested in all seven                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### core — eviction, runway, cost, budget, settle, overview

| file                                 | lines | #tests | invariant pinned                                                                                                                                                                                                                                                                                                                                                                                       | fake / helper                                                                                                                                                                                | verdict                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ----- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eviction-buffered-timeline.test.ts` | 204   | 5      | grace sweep (`:5238-5300`) skips tiles in `coverageIndex.keySet` past the 30 s paused grace; stale-viewport tiles still age out; loop does not change it; over-limit still reclaims index-protected tiles                                                                                                                                                                                              | `makeAvailableTiles(60)`+`fakeTile`, `installClock/advanceClock`; microtask batches; count cap only (`maxCacheSize:2` :186)                                                                  | SOLID :99-176; WEAK :200 `≤2` names no survivors and admits a one-pass violation (:193-194); VACUOUS :178-182 `getTemporalBucketMs()` echoes the option                                                                                                                                            |
| `eviction-inflight.test.ts`          | 232   | 4      | grace sweep skips `isLoading`; `clear()` latches `isCancelled` so a late delivery cannot re-inflate counters; over-limit plan excludes in-flight + needed under loop rotation (evicts `[29,28]`) and without (`[26,27]`)                                                                                                                                                                               | manually gated pending batches (`:52-80`) — real in-flight state                                                                                                                             | SOLID; :108 `headerBytes=1000` copies `estimateTileSize` base overhead                                                                                                                                                                                                                             |
| `eviction-playhead-tiers.test.ts`    | 914   | 22     | A→B→C→D plan order with exact `onTileUnload` sequences; `runwayEvictions` = C+D; pressure ladder; no-coverage → LRU; loop rotation protects tiles past loop start; `setLoopWindow(null)` restores; byte-density tiebreak within band + kill switch byte-for-byte; per-tier attribution = unload log 1:1; `evict` probe 1 sample per unload; stats snapshot is a copy                                   | fixtures + clock; `onTileUnload` label log as oracle; `__sttProbe` bag; `sizedTile` with `arrowIpc`; seeded LCG                                                                              | SOLID (exact `toEqual` at :198,:213,:230-239,:256,:372,:389,:410,:426,:443,:675-680,:715,:720,:779-787); WEAK :278-293 ladder rungs 0.7/0.49/0.343/0.25 transcribed from `PRESSURE_SCALE_DECAY/MIN`; WEAK :486-495 property asserts nothing unless ≥2 samples share tier b/c; WEAK :874 `length>0` |
| `buffered-runway.test.ts`            | 419   | 13     | runway walks fwd/back over `bucketStarts`, stops at first hole, floors at one bucket, clamps to `timeRange`, `complete`; `bytesPending` = Σ directory bytes; `estimateCost` counts in-flight as missing; density profile = `estimateCost.bytes` over 7 edge ranges; `bytesForHorizon`; abstain w/o index; `estimateTimeToReadyMs`; `getBufferedRanges` merges + `maxRanges`; `onBufferChange` throttle | fixtures, `getTileByteSize = 100×(i+1)`, microtask or `gateBatches`                                                                                                                          | SOLID :97-390 (independent `bytesAt` formula); WEAK :393-418 throttle on real timers with `>=1 && <=2` / `<=4` bounds. NO loop, NO single bucket, NO multi-cell, default `horizonSimMs` path never hit                                                                                             |
| `cost-oracle.test.ts`                | 726   | 12     | `estimateSelectionCost` = Σ `entry.length` over exactly the ids the real id queries return (zoom / temporal-LOD tier / summary / `Infinity` before index / purity); density profile & prefix sums = brute-force over 24 random windows, monotone, byte-identical rebuild                                                                                                                               | REAL encoded directory (`encodeDirectory`→`directoryObject`+`packObject`+`packedFetch`) → real `STTArchive`; tileset half uses seeded `getTileByteSize` table checked against `bruteTotal()` | SOLID :143-685; WEAK :696-725 "0.1 ms walk" pinned at `<1 ms`/`<0.05 ms` — a linear walk also passes. Not a golden fixture; halves never cross-checked against each other                                                                                                                          |
| `tile-budget.test.ts`                | 409   | 17     | `viewportCellCount` = row/col enumeration for 9 boxes × z0-10 incl. antimeridian/polar; `fitZoomToCellBudget` inert for unpitched 1600×900 at every zoom, steps down to first fit, monotone, `minZoom`, disabled by ∞/NaN; hysteresis holds/releases/stops 40-frame flapping; pitch-85 fixed point `[7×8]`; 7×3×13 static cameras converge frame 1                                                     | pure functions; `enumerateCells` (:37-74) is a hand transcription of `archive.ts` `boundsToTiles`; constants imported                                                                        | SOLID :110-407; WEAK :37-74/:87-108 — pins `viewportCellCount ≡ transcription`, not ≡ the live archive scan                                                                                                                                                                                        |
| `viewport-settle.test.ts`            | 123   | 2      | `isLoaded` vacuous at version 0; selection bumps version, gated batch keeps it false; identical `update` keeps version; window slide → 2; all-null batch still settles                                                                                                                                                                                                                                 | `makeAvailableTiles(50)`; gated batches with resolve/fail                                                                                                                                    | SOLID; abort listener :55-57 is dead (nothing supersedes)                                                                                                                                                                                                                                          |
| `overview-preload.test.ts`           | 303   | 8      | over-budget rejected from directory bytes with zero batch calls; z0+z1 pinned across all buckets via coalesced batch; idempotent; pinned never in `onTileUnload` under `maxCacheSize:10` + one warn; `flushPrefetch`/viewport change never abort pinned batch; `getVisibleTiles` serves pinned z1 under `best-available` even with `maxParentTileBytes:10`; pinned excluded from runway/cost/ranges    | fixtures, `getTileByteSize`, `Promise.resolve`/`gateBatches`, spies                                                                                                                          | SOLID :113-171, :193-302; WEAK :130 "default 20 MiB" only proves >42 KB; WEAK :187 `unloaded.length>0`                                                                                                                                                                                             |

### core — selection & LOD

| file                               | lines | #tests            | invariant pinned                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | fake / helper (pitch?)                                                                                                                                                                                                                                     | verdict                                                                                                                                                                                                            |
| ---------------------------------- | ----- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `selection-hardening.test.ts`      | 966   | 25                | coverage-index rebuild only on >1/8 pan or zoom change; out-of-order directory slice cannot mutate needed set; rejected slice → `onTileError`; superseded prefetch enqueues nothing; FS-2 cut semantics (absent/malformed cut ⇒ box path byte-identical; per-zoom deepest-first queries; best-available ancestors z7..z4; additive union; per-cell tier; scrub drop −k floored at minZoom; cut in select-key, order-independent; cut identity replaces `zoom!==lastSpatialZoom` in flush) | fixtures; hand-rolled deferreds; cuts HAND-BUILT (never from `coverFrustumQuadtree`); boxes only, no pitch                                                                                                                                                 | SOLID; WEAK :451 `>0`, :697-702 tolerates unspecified earlier passes; measures FETCH set, `getVisibleTiles` under a cut out of scope (:359-371)                                                                    |
| `mixed-zoom-cover.test.ts`         | 956   | 25 (3 `it.fails`) | real `coverFrustumQuadtree` cut through real `update({..., tileCells})` → `getVisibleTiles()` covers every ray-traced ground sample at 432 pitched/rotated cameras both strategies; antichain under no-overlap; pitch sweep 0→85→0 never blanks; cut budget-inert; O5 fetch ratios ≥10× at pitch≥70                                                                                                                                                                                       | own deck-shaped camera arithmetic + planes + 49×49 ray oracle; `bounds` = AABB of the oracle's OWN samples (:488); real tileset; pitch 0..85 × bearing 0..345 but NOT a deck `WebMercatorViewport`, NOT production `getViewportBounds`/`_deriveFrustumCut` | SOLID for clause 1/2-no-overlap/sweep; VACUOUS :822-827 constant pins (256, 0.25); WEAK :607-617, :679-699 pin the DEFECT as a band (`dropping ≤ 200`, `overdraw ≤ 2.5`); :599,:660,:668 `it.fails` (FS-3 pending) |
| `parent-fallback-clamp.test.ts`    | 390   | 9 (2 `it.fails`)  | pass-2 slack ring keeps a parent while a needed primary just outside the clamp is pending, drops it when all arrive; z10/z11 double-draw: delivered == exactly 4 children under both `coverSearch`; zero-width seam box disables clamp and keeps parent; mixed-zoom cut: far member kept in-box, dropped out-of-box (pins defect)                                                                                                                                                         | `fakeTile`, never-resolving `getTileData`; bounds-blind directory; boxes only                                                                                                                                                                              | SOLID; :309, :345 `it.fails`; :81-109 `toContainEqual` not exact                                                                                                                                                   |
| `zoom-out-child-standin.test.ts`   | 591   | 10                | finer resident descendant (depth ≤2) stands in for pending coarser primary, replaced exactly when it lands; depth-3 not; under no-overlap; ancestor stands in on zoom-in never over a loaded primary; 16 seeded random sets ×2 regimes: DP antichain, covers ≥ capped, capped has cross-ancestor violations and DP none, deterministic order                                                                                                                                              | gated per-tile resolvers; mulberry32; bounds-blind directory (`FINE` outside `BOUNDS`)                                                                                                                                                                     | SOLID; pass-2 viewport clamp never exercised here                                                                                                                                                                  |
| `ancestor-standin-overlap.test.ts` | 309   | 7                 | ancestor stand-in not drawn over a sibling filled by a descendant; DP reuses ancestor 3 levels up where capped returns `[]`; seam viewport does not withhold; grandparent not over nearer parent                                                                                                                                                                                                                                                                                          | never-resolving primary; zoom walks z7→z9→z8, z8→z11                                                                                                                                                                                                       | SOLID; :202-211, :296-308 pin `coverSearch:'capped'` legacy behaviour                                                                                                                                              |
| `frustum-cover.test.ts`            | 1062  | 42                | flat camera == box enumeration exactly; zero misses vs 33×33 ray oracle at 432 cameras + corners + shipped; in-world; antichain; ≤ AABB+4, strictly cheaper ≥32, >10× at pitch≥70, <256; determinism incl. plane order/rescale; seam cols 511 and 0; `null` never `[]` on wrap/degenerate/non-finite/cap/empty; elevation slab superset; zoom clamps                                                                                                                                      | pure function, own camera/planes/rays, no deck                                                                                                                                                                                                             | SOLID; WEAK :1013 / :1046-1050 disjunction (`null                                                                                                                                                                  |     | length>0`); oracle and cut share `makeCamera`so a deck-convention error is invisible here. Production: wired via`spatiotemporal-layer.ts:36, :2506-2531, :2579-2586`→`tileset.update(tileCells)`:1443-1452 but gated on`selectionMode==='frustum'`(:2507); default`'aabb'` (:720); NO showcase caller opts in |
| `additive-lod.test.ts`             | 212   | 7                 | additive queries `[minZoom..cameraZoom]` vs parent-fallback `[z-4..z]`; additive keeps covered z14 parent (5 tiles) while parent-fallback drops it; placeholder pricing cannot suppress additive coarse fetches; union under both `coverSearch`                                                                                                                                                                                                                                           | local `fakeTile` w/o `timeRange`; one tile per zoom                                                                                                                                                                                                        | SOLID; `[16..20]` derived from `PARENT_FALLBACK_LEVELS`                                                                                                                                                            |
| `summary-tier-dispatch.test.ts`    | 114   | 4                 | `tier:'auto'`+`summaryZoomRange` routes z2 to summary only / z10 to raw only; `'raw'` never summary; `'summary'` at z10; auto w/o callback → raw                                                                                                                                                                                                                                                                                                                                          | `vi.fn` spies; `getTileData → null` (nothing loads)                                                                                                                                                                                                        | **WEAK** — spy counts only; summary ids never checked to reach needed set / `getVisibleTiles`; :84 `>0`; range boundary untested                                                                                   |
| `temporal-lod.test.ts`             | 1560  | 36                | archive reads `temporal_lod` metadata + per-entry `temporalBucketMs`; `getTileIdsInBoundsForTemporalLod` exact ids stamped with `bucketMs`; no aliasing of HOUR/DAY entries; `pickTemporalLodForZoom`; default query excludes LOD tiers only with a pyramid; CO-5 argmin (addressable set, over-fetch→base, under-aggregation→coarse, ties→coarser, abstains, request price `L̂×θ̂` never the 2 MiB constant, paged-leaf fallback, 500-trial property)                                      | `packed-fixture` + `encodeDirectory`/`decodePagedRoot`; real `STTArchive`; `scriptClock` spies `performance.now` (+1000 ms/read)                                                                                                                           | SOLID; archive-level only (no tileset, no viewport)                                                                                                                                                                |
| `scrub-lod.test.ts`                | 739   | 19                | kill switch (no reselect w/o `scrubLod`); spatial drop `[10,8,10]` clamped at 4; temporal axis queries coarsest applicable level, base restored on release; composes; no-op w/o pyramid; G7 (coverage queries stay at z10, runway ignores preview tile); eviction probe accounting; CO-5 on the tileset (default never consults oracle; argmin picks; abstains unpriced; inert w/o temporal axis; deterministic); readiness never reports coarse tier                                     | fixtures; real tileset via `update(bucketIndex, zoom)` + `setInteractive`; `estimateSelectionCost` STUBBED with injected per-tier costs (:110-122)                                                                                                         | SOLID; CO-5 tests decide from stub prices (the DECISION is computed, so not rubric a); :465-466 `>0`                                                                                                               |

### core — scheduler & transport

| file                                   | lines | #tests        | invariant pinned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | fake / helper                                                                                                                                                                                                                                                                                                                                     | verdict                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------- | ----- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request-scheduler.test.ts`            | 1517  | 41            | fresh `SharedRequestScheduler`: `active ≤ maxRequests` at every step; dispatch picks lowest `getPriority()` AT DISPATCH TIME; `priority<0` → cancellation, never executed; slot freed on resolve/reject/sync-throw; `abort` queued vs running, `abortSource`, `clear`; DRR light source first dispatch ≤2 vs 8-deep flooder, 3:1 weight ≥5 of 8; work-conserving; bookkeeping reclaimed (`trackedSources` 2→1→0); byte-DRR share ratio 0.8–1.25 under 10× skew vs <0.2 under `byteQuantum:null`; over-quantum groups still dispatch; deficit clamp; LCG share ratio ≤2.5; exact rollback sequences at weights 0.25/0.5/0.9/1.0 | `controllable()` deferreds recording `started()` + signal (:35-55); `flush()` macrotask; no timers/network — genuine interleaving                                                                                                                                                                                                                 | SOLID. (g) :133-136 `24`, :1304 `512*1024`; :1326-1330 rollback sequences "recorded by running the HEAD scheduler" (golden-master, mitigated by derivations :1316-1324). **Every fairness/byte test uses `maxRequests:1`** — 24-slot round crediting never asserted for share                                                                                                                         |
| `scheduler-dynamic-weight.test.ts`     | 231   | 4             | `setSourceWeight` re-shares work ALREADY queued (exact before/after sequence); byte-quantum re-weight ratio ∈ (2,4); weight 0.25 under `byteQuantum:null` yields then drains, 1 slot/dispatch; NaN/negative → 1; unknown source adds no bookkeeping                                                                                                                                                                                                                                                                                                                                                                            | `held()` deferreds; `drain()`                                                                                                                                                                                                                                                                                                                     | SOLID; :194-207 HEAD-recorded sequence; idle-then-return re-weight untested                                                                                                                                                                                                                                                                                                                           |
| `scheduler-group-priority.test.ts`     | 222   | 3             | archive runner (per-archive cap 1, 8 free global slots) pulls range-groups in playhead-distance order: exact 4-group order; no playhead → stable byte order; forward direction ahead-first                                                                                                                                                                                                                                                                                                                                                                                                                                     | `tracingFetch` over `packedFetch` (microtask); real singleton `configureSharedScheduler({maxRequests:8})`                                                                                                                                                                                                                                         | SOLID for pull order (cap 1 makes it the pre-sorted order, not a race). **WEAK :220** only `slice(0,2)` pinned; the scheduler itself never contends                                                                                                                                                                                                                                                   |
| `shared-scheduler-archive.test.ts`     | 841   | 9             | through the REAL singleton: gated in-flight ≤ GLOBAL at every flush, peak >1; two archives both dispatch; single archive draws whole budget; per-archive `maxConcurrentRequests:3` binds under GLOBAL 12; two caps under GLOBAL 4; caller abort drops queued, `active/queued→0`; `costBytes` = blob length uncoalesced, `end−start+1` fused, present with probe OFF                                                                                                                                                                                                                                                            | `gatedFetch` parking range requests on resolver array (controllable); `memFetch`; `vi.spyOn(scheduleRequest)` (spy, not stub). `enabled:true` at :316/:384/:488/:529/:581/:647 is NOT an option (`SharedRequestSchedulerOptions` = `{maxRequests, byteQuantum}`)                                                                                  | SOLID for caps/abort/costBytes. **WEAK fairness :377-482**: budget 4 not 24; `firstB < lastA` and `>0` in first K pass if B gets ONE of the first ten dispatches — no share ratio; `schedulerWeight≠1` across two archives unpinned                                                                                                                                                                   |
| `spatial-scheduler-tiebreak.test.ts`   | 357   | 2             | among three EDF-tied groups the tile nearest `viewportCenter` dispatches first despite being last in request/byte order; without center → enqueue order `[blocker,x49,x51,x50]`                                                                                                                                                                                                                                                                                                                                                                                                                                                | `gatedFetchByPath`; real singleton `maxRequests:1`; `withBlockerSlot` parks an unrelated archive's fetch so candidates queue together (:227-264)                                                                                                                                                                                                  | SOLID. A spatial term that OUTRANKED time would also pass (all three are tied)                                                                                                                                                                                                                                                                                                                        |
| `active-request-ownership.test.ts`     | 104   | 2             | a superseded per-tile request settling after `clear()`+re-dispatch must not delete its replacement's `activeRequests` entry (stays 1); with no replacement releases to 0                                                                                                                                                                                                                                                                                                                                                                                                                                                       | real tileset, per-tile path only; never-resolving `getTileData` rejecting 20 ms after abort (real timers)                                                                                                                                                                                                                                         | SOLID (async abort delivery is the needed interleaving). Batched path (`getTileDataBatch`, what the showcase uses) has NO ownership test; only `clear()` — not `flushPrefetch`/`evictTiles`                                                                                                                                                                                                           |
| `failed-tile-retry.test.ts`            | 481   | 9             | retry ladder 500→1000→2000 ms exact counts 1/1/2/3/3/4; **write-off**: `getBufferedRunway(0,1).simMs` 0 → >0 after three settles (:128-132), `estimateCost().tiles→0` (:135); prefetch tier shares ladder (≤5 in 5 s, ≤10 in 125 s); no revival off-viewport; transient `NetworkError` heals; permanently absent 3<probes≤12 over 5 min; `AbortError` not charged; all-abort backstop cost 1→0 past ceiling                                                                                                                                                                                                                    | real tileset; `getTileDataBatch` stubs returning `null`/throwing; `vi.useFakeTimers` + `advanceTimersByTimeAsync` advanced PAST every rung                                                                                                                                                                                                        | SOLID. Failure injected at the batch seam, never as HTTP status through `STTArchive`; rungs beyond 2 s only bounded                                                                                                                                                                                                                                                                                   |
| `archive-retry.test.ts`                | 154   | 6             | coalesced group 2×500 then success ⇒ exactly 3 pack-range attempts; group exhausts 3 ⇒ one single-attempt fallback per member (`3+N`); dead host ⇒ all `null`, no throw; thrown `AbortError` rejects after exactly 1 attempt; `getTile` retries; throughput fed                                                                                                                                                                                                                                                                                                                                                                | `faultyFetch` over `packedFetch` injecting `{status:500}` / `AbortError`; `retryDelaysMs:[0,0]`                                                                                                                                                                                                                                                   | SOLID on counts/null-degrade. **WEAK**: title says "backoff" but `[0,0]` never observes delay/jitter (`archive.ts:2515`); default `[250,1000]` unpinned; injects 500 only — no test says 404/416 should not burn the ladder (`archive.ts:2305-2308` throws the same for every `!ok`)                                                                                                                  |
| `archive-transport-hardening.test.ts`  | 484   | 15            | stall watchdog (`transferTimeoutMs:25`, real timers): never-resolving pack ⇒ `TimeoutError` after exactly 3 attempts <2 s; one stall then success ⇒ 2; caller abort beats a 60 s watchdog; stalled manifest times out; manifest/directory 5xx retried; truncated directory / 206 / wrong `Content-Range` retried; two concurrent `getTiles` ⇒ **2 range requests, 1 busy-window sample** (:316-319 — concurrent identical fetches are NOT deduped, pinned as intended); failure samples drag `bytesPerMs`; already-aborted signal leaks no unhandled rejection; `finalize()` aborts all transport signals, idempotent          | `packedFetch` + `hangForever()`; real `setTimeout`; `waitForSignal` polls; `process.on('unhandledRejection')`                                                                                                                                                                                                                                     | SOLID (deadline shortened to 25 ms, mechanism fires). **The 20 s default (`DEFAULT_TRANSFER_TIMEOUT_MS`, `archive.ts:765`) is never asserted**; body-stall after headers (`arrayBuffer()` hang) never modelled                                                                                                                                                                                        |
| `archive-incremental-delivery.test.ts` | 201   | 3             | two range groups in one batch: ungated group's tile reaches `onTileReady` while the other is gated and the batch unsettled; after release both delivered exactly once with array identity; every network decode gets a finite priority; `fetchPriority:'low'` strictly larger                                                                                                                                                                                                                                                                                                                                                  | `twoPackDataset()` from golden; single deferred gate on pack B; `RecordingDecoder extends InlineTileDecoder`                                                                                                                                                                                                                                      | SOLID for incremental delivery. **WEAK :183-190** "finite number"; :199 relative only — tier bases unpinned; no abort-mid-batch delivery test                                                                                                                                                                                                                                                         |
| `tile-batch-coalescing.test.ts`        | 899   | 30 (43 cases) | multi-tile pass goes through `getTileDataBatch` with >1 tile; 30 tiles with `maxRequests:12` ⇒ ONE batch; no batch cb ⇒ 3 singles; CO-7 pure function hand-derived 250 000/1 250 000/2 500 000 + clamps, no build gap ⇒ 2 MiB, cold/NaN ⇒ 2 MiB, monotone; archive `getCoalesceGapEstimate()` source cold/adaptive/pinned/no-build-gap exact `gapBytes`; fleet-shaped archive plans byte-identical ranges to a 2 MiB-pinned reader; warm gap changes plan 1→2 requests; request count monotone in G, never crosses a pack; every fused member decodes; determinism ×3                                                          | `vi.fn` spies + real `setTimeout`; `gapDataset` (real golden blob, synthetic spacing) via `packedFetch` with `PackedFetchLog`; `freezeClock()`                                                                                                                                                                                                    | SOLID (constants derived from the stated [G/2, 2G] rule). Tileset half (stub) and archive half (`getTiles` direct) NEVER meet: the production wiring `getTileDataBatch → STTArchive.getTiles({playheadTime,…})` (`:3985`) is not exercised end-to-end                                                                                                                                                 |
| `paged-directory.test.ts`              | 826   | 13            | paged `getTileIdsInBounds` == whole-load oracle for 7 queries (>100-tile guard); empty viewport fetches exactly `OBJECT_MAGIC_LEN + rootLength` directory bytes and no leaf; small viewport strictly between root and whole; payloads byte-equal; `estimateSelectionCost` exact + `unknownTiles>0` while partial, closes to oracle; tampered root/leaf rejected by content hash; `coverTMin` point query, decoy leaf never fetched; point query near start fetches only leaves `[0,1]` of 8                                                                                                                                    | real Rust fixtures via `loadPackedDatasetFromDisk`; `packedFetch` with `PackedFetchLog`; hand `encodePagedRootBytes` cross-checked vs `decodePagedRoot`; private `fetchAndMergePages` at :441-449 (scoped)                                                                                                                                        | SOLID (byte-level range accounting from the log is independent). :250 `≥` loose by design                                                                                                                                                                                                                                                                                                             |
| `paged-scheduler-supersede.test.ts`    | 407   | 2             | budget 1, 5 page groups: 1 gated in flight + 4 queued; caller abort empties queue at once, rejects, private `pageFetchPromises` empty, `active/queued` 0; follow-up fetch of an aborted page settles inside a 2 s race and becomes resident                                                                                                                                                                                                                                                                                                                                                                                    | hand-encoded paged root; `gatedFetch` on leaf ranges; real singleton `maxRequests:1`; calls PRIVATE `fetchAndMergePages` with hand-built index lists (:288-292, :337-341, :381-385), reads private state; real 2 s race                                                                                                                           | Test 1 **WEAK (d)** but the deadlock check is genuine. **Test 2 :362-406 VACUOUS**: `configureSharedScheduler({ enabled: false, … })` sets a field that does not exist (`shared-scheduler.ts:100-134`, `request-scheduler.ts:283-306`); `archive.ts:4047` uses the singleton unconditionally — the "kill-switch / legacy path" it claims to test does not exist; it re-runs test 1 under a false name |
| `throughput.test.ts`                   | 495   | 27            | dual-EWMA first sample exact; zero-duration clamp; drop reacts/recovers cautiously; duration weighting; dispersion closed-form to 9 places; `stdDev` exactly 0 flat; conservative rate `max(0, point−z·sd)` for z∈{0,1,2,3,1000}, monotone over 400 LCG samples; NaN/negative z clamped; `LatencyEstimator` closed form, half-life, convergence, price `L̂·θ̂`; bit-identical traces + order-sensitivity guard                                                                                                                                                                                                                   | pure — `handComputable()` half-lives=1000 ms so each fold is ½; `lcg()`. **No clock**: `addSample(bytes, elapsedMs)` takes durations; timestamps come from `nowMs()=performance.now()` upstream (`archive.ts:968`), exercised only with REAL clock in transport-hardening :292-352 / archive-retry :94-106 and frozen to 0 in coalescing :303-305 | SOLID (every expected value has a written derivation)                                                                                                                                                                                                                                                                                                                                                 |

### core — decoder, caches, telemetry, options

| file                                              | lines | #tests | invariant pinned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | fake / helper                                                                                                                                                             | verdict                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | ----- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tile-decoder.test.ts` (post-rewrite, 1671 lines) | 1671  | 52     | crash → reject active + respawn; pre-/mid-flight abort (host-queue splice vs one targeted `cancel`); pool-wide host queue ordered `(priority, costBytes, requestId)`; `slice(0)` at PULL not enqueue; `decidePoolResize` thresholds/hysteresis; live grow to `cores−1` / shrink ≥1; template registry first on spawn+respawn; `returnPayload` iff `onPayload`; BH-7 batch envelope (fair share, 512 KiB cap, per-member settle); inline: CRC gate, length mismatch, two-archive template merge with real v2 frames; `createDefaultTileDecoder` fallbacks | hand-rolled `FakeWorker` (:48-128) — **ignores the transfer list** (:65), synchronous `respond()`; BH-6 uses injected clock + injected `cores` (:869-876); real v2 frames | SOLID; VACUOUS :321-348 `not.toThrow` only; (g) :802-849, :1035, :1062, :1622-1632 mirror `POOL_*` constants; WEAK :1052-1108 re-implements the pool loop, accepts `2..4`. **`tile-decoder.worker.ts` is never executed by any test**                                                                 |
| `opfs-cache.test.ts`                              | 517   | 25     | unavailable → no-op; round trip; rehydrate; LRU vs GDS victim; admission doorkeeper (<4 KiB skipped first touch; z≤2/≥4096 B/rewrite admitted; off by default); byte sum ≤ budget after every evict; deterministic tie-break; `hits`+`lFloor` persisted; legacy v1 index; mangled fields non-fatal; budget clamps to quota/2                                                                                                                                                                                                                             | `helpers/opfs-shim.ts` `MemDirectoryHandle`; `navigator.locks` passthrough `vi.fn`                                                                                        | SOLID; (e) :146-169 "serialises flushes through locks" is single-writer with an instant lock — serialisation never exercised; WEAK :384-410 sequential "handover"; WEAK :255-256                                                                                                                      |
| `archive-opfs.test.ts`                            | 549   | 12     | cold `getTile` writes OPFS; second archive over same cache → **zero new HTTP calls** + `opfs.hits===1`; fingerprint = content-addressed directory key → miss + refetch; `opfsCache:true` threads `id.z` into admission; BYO cache admit-all; Node default off; `hits` exact, `lastAccess` monotone, persisted, survives rewrite, resets on clear                                                                                                                                                                                                         | OPFS shim + real `STTArchive` over `packedFromGolden` with a **counting range fetch** (:46-78)                                                                            | SOLID; minor `>=1` at :110-111, :234. No golden for the persisted OPFS key string (`archive.ts:3581`); `opfs-cache.test.ts:104-105` carries a STALE key shape (`::W/abc`, no `#variant`)                                                                                                              |
| `telemetry-channels.test.ts`                      | 753   | 41     | `requests/evict/scrub` no-op unset, gated `enabled:false` (array never created), 4096 FIFO, independent rings; `recordDecodeWait` bag-scoped ring, p50/p95 nearest-rank, warm-up then every 16th; scheduler emits one `requests` per settle with `enqueue≤dispatch≤complete`, cancelled → `dispatchedAt===0`; real archive batch labelled `tileKey(lead)`; `tileset.viewport` six fields, latest-value, REPAIRED bounds, non-finite box keeps previous; the real `policy-record.mjs` sampler records 3 viewport events                                   | real scheduler, real `STTArchive` over golden + range shim (:403-426), real tileset with stubs, real recorder with `setInterval` stubbed                                  | SOLID; (b) :103-108 `probeNow` `>=` only; (g) :55/:57 mirror constants; WEAK :447 `bytes >= e.length` (lower bound — `requests.bytes` is a caller LABEL, never tied to the fetched Range); WEAK claim :271-292/:539-549 proves "bag never created", NOT "zero allocations" (no `performance.now` spy) |
| `telemetry.test.ts`                               | 127   | 7      | unset → no bag; `enabled:false` → no arrays/snapshots; lazy array reused (`toBe`); exactly `MAX_SAMPLES` no shift; +1 shifts one; snapshot overwrites                                                                                                                                                                                                                                                                                                                                                                                                    | direct calls on `globalThis.__sttProbe`                                                                                                                                   | SOLID; (g) :18 `4096` mirrored                                                                                                                                                                                                                                                                        |
| `tileset-set-options.test.ts`                     | 522   | 23     | `setOptions` without `update()`: `tier` re-runs selection and reuses residents; `additive` widens `[0..8]`, `no-overlap` drops parents; `scrubLod` degrades live to `z−2`; structural no-op; lowering `maxCacheSize/ByteSize` evicts synchronously, raising does not; raising `maxRequests` dispatches 4 more hanging loads immediately; debounce re-arms; prefetch runway widens/multiplies/stops/resumes with exact `range.end`; `STTArchive.setLoadOptions` header rotation via recording fetch; `setMaxConcurrentRequests`                           | real tileset + fixtures (`settle` 25 ms REAL); real `STTArchive` over golden                                                                                              | SOLID; (g) :415 `24`, :167/:180 `[4..8]`; WEAK :509-521 getter/setter only; WEAK :328-335 "nothing in 25 ms" vs 5 s debounce (deadline never reached)                                                                                                                                                 |

### playback

| file                        | lines | #tests | invariant pinned                                                                                                                                                                                                                                                                                                                                       | fake / helper                                                       | verdict                                                                                                                                             |
| --------------------------- | ----- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `playback-governor.test.ts` | 4751  | 180    | start gate `startGateWallMs×                                                                                                                                                                                                                                                                                                                           | speed                                                               | `at 19,999/20,000; complete short-circuits; watermark stall +`resumeFactor×`hysteresis; single-instant frontier clamp fwd/back; no-clamp on seek >` | speed | ×1s`; clock-driven stall after 250 ms; degraded creep after `maxStartWaitMs`(timers advanced past deadline,`degradedResumeCount/creepMs`asserted :171-184, :281-330, :1042-1073); pause stickiness; scrub preview vs commit; scrub hold (no gate under held thumb; hatch suspended/re-based);`setInteractive`broadcast order incl. G7; auto-speed`throughput/bytesPerSimMs×0.7`+ Infinity/null; loop wrap into unbuffered →`'seeking'`(:868-896) / buffered → seamless (:898-916) via real rAF; range end/replay both directions; QoE counters + probe channel; multi-source min-gate, AND-complete, optional never gates (:1189-1223, single instant), ETA=max, cost=sum, contended auto-speed, broadcast/flush,`getSourceRunways`, ranges=intersection; bad-source; cold-start; cadence band; fairness cap/weights/throttle/kill switch/hysteresis; BH-3 progressive fill; BH-4 per-source τ + 40-vector safety bound; BH-7 `setLoopWindow` push/clear; scrub QoE; snapshot; fluid feasibility; gate shape; calm-link parity with per-step literal states; ladder | hand-written `BufferSource` stubs (9 makers); **every `getBufferedRunway` ignores `time`/`direction` and returns a fixed number** (:49-56 etc.); `rAF` stubbed to no-op (:99) except `makeLoopingClock` :845-866 / `makeClampingClock` :920-941; fake timers incl. `performance`; `notifyBufferChange(x)` ignores its argument for gating (`src:1444-1459`) so it is only a trigger | Mostly SOLID (121, 186, 264, 505, 868, 898, 943, 1150-1258, 1292-1445, 1629-1696, 2068-2336, 2907-2957, 3751-3790, 4347-4452, 4491-4543). VACUOUS: :689-697 `not.toThrow`; :746-753, :755-771, :1576-1590 pass-throughs (stub value = asserted value); :3105 calls private `notifyWrapListeners()`; :1719-1722 spies private `evaluateNow`. WEAK: :234-250, :332-346 clamp at one instant from stub arithmetic; :281-330 "creeps at data-arrival rate" pinned at a constant 5000; :1500-1548 expected = stub inputs; :1042-1073 `>=` on fake-timer-exact values. **No timeline property `time ≤ frontier`; no moving frontier anywhere; no real tileset as a source** |
| `stt-player.test.ts`        | 333   | 11     | gated `play()`; intent-shaped `paused`; `currentTime` setter = committed seek + flush + `'seeking'`; `baseRate×playbackRate`; `timeupdate` throttle; `ended`/replay via real rAF (:198-239); buffered/seekable/duration; auto-speed unit conversion; scrub mirror; unsubscribe; idempotent destroy                                                     | same stub; real governor + real `TimeController` inside `SttPlayer` | SOLID; :241-255 pass-through; no loop-mode, no `addSource`, `waiting/ready/progress` forwarding never asserted                                      |
| `time-controller.test.ts`   | 507   | 30     | play/pause/toggle; `elapsed×speed`; clamp+pause at end; loop wrap; live `setLoop`; bounce; signed speed; tick throttle; visibility re-anchor; wrap events fwd/back; re-entrant `pause();play()` from a wrap listener; `ended` semantics                                                                                                                | real `performance.now` spy + rAF queue harness (:13-41)             | SOLID; WEAK :165-183 bounce-at-start only `0 ≤ t ≤ 100`; :352-385 loose upper bound                                                                 |
| `auto-speed.test.ts`        | 185   | 18     | asymmetric step policy (downshift immediate, upshift held inside 25 %, never on `'waiting'`), clamp [0.25,10], Infinity → max step damped, custom steps; `dispersionScale` identity/monotone/ceiling; widened deadband                                                                                                                                 | pure functions                                                      | SOLID except :173-184 VACUOUS (copies `SPEED_STEPS` + `not.toBe(undefined)`)                                                                        |
| `derive-params.test.ts`     | 961   | 61     | `deriveFrameCount`, `deriveTrailLength`, metadata-only resolution, override precedence + purity, timeRange reconciliation a-e with warning text, wake invariant, `deriveViewStateFromBounds`, BH-10 hint precedence/clamp/fallthrough, `Proxy`-recorded key reads (snake_case NOT read), 20-row `NO_HINT_PIN` golden with `toStrictEqual` + self-check | pure; `warnSink`; `Proxy`                                           | SOLID; golden table is by construction "expected copied from implementation" (documented regression pin :553-564)                                   |
| `external-clock.test.ts`    | 145   | 8      | `attachExternalClock` suppresses internal rAF; `advanceFrame = elapsed×speed×direction`; no-op paused/unattached; detach restarts rAF; bounce + loop wrap under `advanceFrame`                                                                                                                                                                         | rAF/cAF harness with observable `pendingFrames()`                   | SOLID. **This is the harness a deterministic loader-QoE gate should drive**                                                                         |

### layers — chassis

| file                                  | lines | #tests                  | invariant pinned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | fake / helper                                                                                                                                                                                                              | verdict                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | ----- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chassis-auto-highlight.test.ts`      | 87    | 4                       | `getPickingInfo` stamps `info.sourceTileSubLayer` on hit and miss; `_updateAutoHighlight` calls `updateAutoHighlight` ONLY on the emitting sublayer, once; missing provenance falls back to deck's broadcast                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | real STL prototype via `Object.create`; hand sublayer objects on `internalState.subLayers`                                                                                                                                 | SOLID (narrow). `info.tile/object` on a HIT never asserted                                                                                                                                                                                                                                                                                                                    |
| `chassis-compose-extensions.test.ts`  | 118   | 5                       | empty user list returns the SAME internal array; distinct class appended; duplicate class: exactly one instance survives and it is the INTERNAL one; `warnOnce` once across two layers; order preserved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | real STL prototype; stand-in extension classes (not deck `LayerExtension`)                                                                                                                                                 | SOLID (:76-83 load-bearing). That any subclass's `buildSublayer` actually routes through `composeExtensions` is asserted nowhere                                                                                                                                                                                                                                              |
| `chassis-driver.test.ts`              | 593   | 59 (13 bodies × layers) | per layer (Point/Trips/Polygon/Arc/Icon/Column/PointCloud): one sublayer per tile; `timeOffset` not rebased; `prepareTile` identity for same tile; `renderLayers()` returns identical sublayer instances when nothing changed; baked prop change → NEW sublayer; `sublayerCache.size` 2→1 when a tile leaves `state.tiles` (:401-405); `dataComparator` is `===`; detached `stateSlot` adopted with identity, survives `next.state = previous.state`, per-instance                                                                                                                                                                                                                                                                                                   | real layer prototypes; `@deck.gl/layers` MOCKED to prop-stashing classes; `@deck.gl/core` mocked (`fake-deck-core.ts`); tiles from `fake-tile.ts`. No tileset/viewport                                                     | SOLID. Eviction pin checks `sublayerCache` only — **`preparedTileCache` pruning is unpinned**; mocked deck classes have no `finalize`, so GPU/decoded release on eviction is unobservable; `_transferState` simulated by assignment                                                                                                                                           |
| `chassis-lifecycle.test.ts`           | 726   | 25                      | `dataChanged`-only triggers `_initArchiveAndTileset`; A→B→A supersession finalises stale archives, no tileset until the last resolves; live source detached before replacement; `loadOptions/maxRequests` pushed to a loading archive; state-backed accessors; in-flight init bails when the post-transfer instance is finalized; `finalizeState` → `tileset.finalize()`+`archive.finalize()`, handles nulled (:377-384); rAF tile-load callback bails when tileset nulled; `getMetadata` rejection → `onTileError`, retry on next prop change; `setOptions` bag semantics; `tilesetFrameNumber` mirrors `update()` return, `frameNumber` +1 only when tiles change; `skipDebounce` true for prop-driven time, false when viewport moved; `isLoaded` mirrors tileset | real STL prototype but `@poopdeck.gl/core` MOCKED: `MockSpatioTemporalTileset` with `update=vi.fn(()=>0)`, `getVisibleTiles=vi.fn(()=>[])`, `finalize=vi.fn()`, `setAnimationState=vi.fn()`; viewport plain object pitch 0 | SOLID for lifecycle. **`onTileUnload` per resident tile at finalize is unobservable** (mock finalize); `setAnimationState` never asserted; `tileset.update()` args (`bounds/zoom/timeWindow/tileCells`) never inspected — only `calls[0][1]` (skipDebounce); `initializeState` never invoked                                                                                  |
| `chassis-public-type-exports.test.ts` | 84    | 14                      | six names appear in an `export type {…}` block of `src/index.ts` and match `export (interface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | type)` in the named module                                                                                                                                                                                                 | regex over source text, no runtime                                                                                                                                                                                                                                                                                                                                            | WEAK (source-grep proxy: the two checks are independent; never type-checks a consumer). Not vacuous |
| `chassis-viewport-3d.test.ts`         | 1318  | 31                      | see selection section — real `WebMercatorViewport` (:117-129) pitch {0,30,55,70,85} × bearing {0,45,135,270}; exact convex-clip oracle (:291-376) self-checked vs `viewport.project`; selection ⊇ truth at 20 cameras (:604-620), ratio ≤3 (:632-637); mutation guard (:654-686: a selector dropping 175 drawn tiles is invisible to a 128² ray grid but caught by the exact oracle); 23,328-camera sweep `clean=23328, emptySelection=0, partialMiss=0` (:787-792); pitch-0 `Object.is`-identical to retired body where the clamp did not bite; seam camera; `getZoomLevel` budget engages only past pitch 55; NaN latitude band repaired                                                                                                                           | real viewports; real STL prototype calling `getViewportBounds`/`getZoomLevel` directly; **NO tileset** — tile rects from a local transcription of `boundsToTiles` (:132-211)                                               | SOLID (§2/§3/§4/§6). (g) §1 GOLDEN_RECTS/GOLDEN_TRUTH "generated from the live `getViewportBounds`" (:459-461); §5 `256` and `toBe(6)/toBe(7)` snapshots                                                                                                                                                                                                                      |
| `chassis-viewport-bounds.test.ts`     | 1222  | 52                      | 432 real cameras (z9): box never inverted; every drawn 21×21 sample's tile ∈ `tilesFor(box)` (:244-259); corners inside box below horizon; no old-box tile lost; old derivation selects 0 at b60/p75 while ≥9 drawn; antimeridian unwrapped/ordered; foreign inverted `getBounds` repaired + one warn; NaN camera keeps previous box; zRange slab; frustum path (`getViewportTileCells`) cut at all 432, covers drawn samples, antichain, deterministic, equals box at p0, ≥8× fewer at p≥70; default `selectionMode==='aabb'` → null cut; refuses non-mercator / NaN plane; memo keyed on camera+zRange                                                                                                                                                             | real viewports; stub pitch-0 viewports for seam/repair cases; **NO tileset**; local `tilesFor` transcription; oracle = 21×21 `unproject` grid + clip filter (:156-176)                                                     | **WEAK for the headline containment above the horizon**: the 21×21 sampler is the oracle family the sibling file proves BLIND near the horizon (resolves ~24 % of drawn tiles at p85; a selector dropping 175 tiles scores zero misses), and :244-259 / :848-863 are one-sided with `break` on first miss. SOLID elsewhere. Stub pass-through tests (:423-463) are (a)-shaped |
| `viewport-throttle.test.ts`           | 139   | 3                       | 8 viewport-only `_updateTileset` calls at one instant → `update` 1×, `setNeedsRedraw` 7×, one settle timer; after `clock=1100`+`advanceTimersByTime(100)` → `update` 2×, timer null; prop change not throttled; trailing pass bails when `_finalized`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | real STL prototype; tileset hand stub; `getViewportBounds` stubbed to a CONSTANT box (:56-61); manual `performance.now` clock; fake timers advanced past the window                                                        | **WEAK**: `update` asserted by call COUNT only — never its `bounds` argument; camera never changes, so "the LAST viewport is never dropped" is not pinned (a trailing pass re-reading a stale cached box passes); burst dt=0 only, no `≤ ceil(N·dt/100)` bound                                                                                                                |
| `state-backed-caches.test.ts`         | 162   | 47                      | for 11 layer classes / 46 members (`preparedTileCache`, `sublayerCache`, `lastTilesRef`, Icon glide buffers, Text caches, H3/Quadbin prune keys, Heatmap channel cache, Hexagon caches, Flowmap `geomCache/arcCache/nodeTable`, BundledFlowmap `bundle` GPU + `fallbackCache`): `Object.getOwnPropertyDescriptor(prototype, member).get` is a function; control: class field → undefined                                                                                                                                                                                                                                                                                                                                                                             | prototype-shape check, no instance                                                                                                                                                                                         | **WEAK**: a structural PROXY for "cache survives `_transferState`" — a getter returning a module-level Map (cross-instance sharing, a worse bug) passes; pins nothing about identity across renders, eviction on unload, or GPU release                                                                                                                                       |

Cross-seam note (invariant 10): NO file in `packages/layers/test` or `packages/core/test` runs _deck viewport → chassis `getViewportBounds` → real `tileset.update()` → `getVisibleTiles()`_ at pitch > 0. `chassis-lifecycle` mocks the tileset (`getVisibleTiles = vi.fn(() => [])`), `viewport-throttle` stubs it, the two viewport files never construct one, and `core/test/mixed-zoom-cover.test.ts:486-494` (the only pitched camera through a real tileset) hands `update()` the AABB of its own oracle samples from a hand-rolled camera.

## Checked and correct

- `packages/core/src/telemetry.ts:212-222, :225-234` — `emit`/`snapshot` are one property read + early return with no bag; `isProbeEnabled` :197-200; `recordViewport` :304-327 gates BEFORE building the bounds array (the call in `update()` :2575-2582 passes the existing box object, no allocation); `recordDecodeWait` :270-291 throttles the sort to every 16th sample.
- `packages/core/src/request-scheduler.ts:471-478` — probe object allocated only when `isProbeEnabled()`; `:906` and `:960-975` only touch `entry.probe` when present; `dispatchedAt===0` sentinel for cancelled-while-queued is honoured (`telemetry-channels.test.ts` pins it).
- `packages/core/src/spatiotemporal-tileset.ts:5498-5502` — `evictTiles` resolves `probeOn` once per pass and gates the `EvictProbeSample` allocation; `getCacheStats()` :6101-6116 copies `evictionsByTier` so callers cannot mutate live accounting.
- `packages/core/src/archive.ts:4050, :4099` — `groupProbeMeta` evaluated only when `probeOn`; `costBytes` (a DECISION input) is separate from the probe label (:4017-4022) and always computed.
- `packages/playback/src/playback-governor.ts:1467-1487` — `publishStateSnapshot` skips `getQoeStats()` (which allocates) unless a probe bag exists; `noteScrubCoverageProbe` :1489-1510 is deliberately unconditional and bounded at one null read off-drag (documented); `getQoeStats` :1627-1642 includes in-progress stall/creep spans; `getScrubQoeStats` :1704-1735 all-zero/null before first drag so the HUD can read unconditionally.
- `examples/showcase/src/components/PerformanceMonitor.tsx:104-113, :115-121, :166-173` — HUD acquires the probe with `samples:false` (snapshots only), polls at 500 ms, and ONLY while expanded; released on collapse — the collapsed chip is inert.
- `packages/layers/src/layers/spatiotemporal-layer.ts:1715-1739` — `tileset.stats`/`archive.stats`/`overview.preload` snapshots are gated on `isProbeEnabled()` so `getCacheStats()` is not called per update in production.
- `packages/layers/src/lib/telemetry.ts:66-73, :87-89, :194-216` — batch trim on the ring; `acquireProbe` reference counting so a HUD unmount does not disable a running bench probe.
- `tools/bench/src/policy-replay.mjs:152-188, :205-260, :1112-1140` — canonical JSON with total key order, no `Date.now`/`performance.now`, integer mock clock, five conservation invariants; pinned by 27 tests incl. process-boundary determinism (`policy-replay.test.mjs:506`). Sound as a policy A/B simulator (its stated fidelity boundary is honest).
- `tools/bench/src/policy-record.mjs:100-174` — drains rings by `splice` every 250 ms (defeats the 4096 cap), refuses to write a trajectory-less trace (exit 3), records `trajectorySource`/`configSource` provenance in the header.
- `tools/bench/src/cold-start-bench.mjs:150-200, :205-275` — instrumented `fetch` counts every request and every response byte through the REAL `STTArchive`; viewport derived as the layer derives it (pitch 0 only, documented). Runs today against the deployed v3 fleet from the working-tree dist (5 requests / 349.3 KiB for `earthquakes-v2` at z2, matching §9.1's "5 / 348.1 KiB").
- `packages/core/src/archive.ts:101, :114, :2194-2200` — reader accepts `formatVersion ∈ [2, 3]` (a range check, not strict equality); 12/12 sampled local showcase manifests and the deployed `earthquakes-v2`/`flights`/`ais-all-us` are `formatVersion: 3`. The v2/v3 "cold-start needs a HEAD build" skew is gone.
- `tools/render-test/probe-all-demos.mjs:180-195` — the CI probe is fail-closed (it used to always exit 0); its blank-render heuristic (:52-93) is sound for what it claims.
- `packages/playback/test/external-clock.test.ts` + `TimeController.attachExternalClock/advanceFrame` — a deterministic clock seam already exists for driving the governor without rAF.
- `packages/core/src/geo/frustum-cover.ts` is WIRED, not dead: exported at `core/src/index.ts:62-76`, consumed by `spatiotemporal-layer.ts:36, :2506-2531, :2579-2586`, passed as `tileCells` into `tileset.update()` at `:1443-1452/:1672-1681`, normalised at `spatiotemporal-tileset.ts:2509-2516` and used by `selectAndLoadTiles` `:2828-2895` — but gated on `selectionMode==='frustum'` (`:2507`), default `'aabb'` (`:720`), and no showcase/tool caller opts in (grep `selectionMode|frustum` over `examples/showcase/src` and `tools`: only a Cesium comment and a `zRange` doc comment). Dormant by configuration, with 42 + 25 tests behind it.
- `packages/core/test/failed-tile-retry.test.ts` — the one loader suite that uses `vi.useFakeTimers` + `advanceTimersByTimeAsync` past every ladder rung (:78-84, :131, :182, :190, :276, :283, :320, :418, :427, :463, :468, :474); the pattern the other timer-coupled suites should adopt (TO-7).
- `packages/core/test/helpers/packed-fixture.ts:403-408, :456-504` — `PackedFetchLog` records every object path and every `Range` header served; a ready-made request/byte counter for the tests proposed in TO-1/TO-5.

## Doc ↔ code drift

- `tools/bench/README.md:393-410` "Standing blocker as of 2026-08-10 … reader gates on strict equality … all 64 under `examples/showcase/public/data` and the whole live fleet are `formatVersion: 2` … a working-tree showcase build opens nothing" — FALSE today: `archive.ts:114` `MIN_PACKED_FORMAT_VERSION = 2`, check at `:2194-2200` is a range; local + deployed manifests are v3; `cold-start` ran cleanly (table above).
- `docs/roadmap/measurements-2026-08.md:538-556` (§8.4 R1 "cold-start cannot run on the working tree"; ":1397 is strict equality") and `:874-878` (§9 "run against a HEAD-committed v2 build") — superseded by the same facts; the `:382` instrument table row "Cold start — cannot run on the working tree" is stale.
- `.github/workflows/ci.yml:361-363` "anything minted now is formatVersion 3 and unreadable by a HEAD checkout" — HEAD reads 2..3.
- `docs/roadmap/README.md:157` "the fleet is still v2 on the wire (B4)" and `:161-165` "The published fleet is still `formatVersion: 2`" — contradicted by the deployed manifests (v3) and by HEAD's own commit title `934f0c0 docs(roadmap): discharge B4 — the fleet is v3`; the B4 body was not rewritten to match.
- `tools/bench/src/index.mjs:10-11` "`@poopdeck.gl/core` no longer ships a tile-decoding web-worker pool — tile decoding is now inline/synchronous" — FALSE: `packages/core/src/tile-decoder.worker.ts` + `WorkerTileDecoder` pool (grow/shrink, BH-5/6/7) exist and are the production path. (`bench.mjs` itself is dead — retired fixture + single-buffer `createFileFetch`, `ci.yml:333-368`.)
- `tools/bench/src/policy-record.mjs:132-136` "No package publishes one today (`tileset.stats` carries cache counters only)" and the error text `:270-277` "no package publishes a 'tileset.viewport' probe snapshot yet" — stale: `telemetry.ts:136, :304-327` + `spatiotemporal-tileset.ts:2575` publish it (and `telemetry-channels.test.ts` proves the recorder sees it).
- `packages/core/src/tile-decoder.ts:199` "Emit telemetry only when the probe is enabled" — the emit is gated inside `emit`, the three `performance.now()` reads and the payload object are not (TO-2).
- `packages/core/src/telemetry.ts:47-50` "PROBE-OFF DISCIPLINE … the allocation itself never happens when the probe is off" — true for core's own sites, false for 13/15 layer files that import the layers shim with the same documented contract (TO-2).
- `packages/layers/src/lib/telemetry.ts:15-26` contract block lists channels `consolidations/renderLayers/tilePrepare/decode/playback` — omits `requests/evict/scrub` and the `snapshots` keys `tileset.viewport/decodeQueue/playback.state`; harmless but the "single coherent bag" has three partially overlapping type unions.
- `packages/core/test/opfs-cache.test.ts:104-105` example key `"https://cdn/a.stt::8/12/34/170::W/abc"` does not match the persisted shape `archive.ts:3581` (`${url}::${tileKey(id)}::${fingerprint}`, `tileKey` = `z/x/y/t#variant[@bucketMs]`).
- `docs/roadmap/optimization-implementation-plan-2026-08.md:81` P0-2 "Guard test: probe disabled ⇒ zero allocations on the request path (assert bag untouched)" — what landed asserts "bag untouched" (`telemetry-channels.test.ts:271-292`), which does not test allocation; the comment at `:290` claims more than the assertion proves.
- `docs/roadmap/measurements-2026-08.md:1201` "Priority inversions: NO INSTRUMENT" — still true; `policy-replay` reports no inversion counter and no stall counter.
- `packages/core/src/archive.ts:3134` comment "enabled, legacy cursor runner otherwise" — there is no `enabled` option and no legacy runner (`:4047` always uses the singleton); nine test call sites pass the dead flag (TO-8).
- `packages/core/test/prefetch-slicing.test.ts:62, :112` comments attribute the 4-tile/8-tile slices to `0.5 × 8 MiB`; the actual binding term is the `PREFETCH_MIN_BUDGET_BYTES` 4 MiB floor (`prefetch-policy.ts:943-952`; with cold expansion 8 the fraction would give 512 KiB).
- `packages/core/test/prefetch-slicing.test.ts:17-18` header "one slice in flight at a time" — not asserted anywhere in the file (instant fakes make sequential vs parallel dispatch indistinguishable).
- `packages/core/test/archive-retry.test.ts:81` title says "backoff" — with `retryDelaysMs:[0,0]` no delay or jitter is ever observed; the default `[250, 1000]` (`archive.ts:734`) and the 20 s `DEFAULT_TRANSFER_TIMEOUT_MS` (`archive.ts:765`) are asserted nowhere.
- `packages/core/test/tile-budget.test.ts:13-17, :32-35` header claims it pins "the count the archive's scan actually enumerates"; the oracle is a frozen transcription of `boundsToTiles`, so the test pins `viewportCellCount ≡ transcription`, not ≡ the live archive scan (same pattern in `chassis-viewport-3d.test.ts:132-136` and `chassis-viewport-bounds.test.ts:77-81`, both admitted in-file).

## Needs measurement

- Probe-OFF frame cost of the ungated layer emits (TO-2): run `tools/bench/src/frame-cost.mjs` on `gtfs-ch` (157×) and `/demo/nyc-taxi-paths` twice — once as-is, once with the 13 files' `emit` sites guarded — and compare p95 frame time and GC count from the CPU profile. Expected: within noise on the point/path layers; measurable only on `HeatmapLayer` routes and glide-interpolation routes (which re-run `renderLayers` per frame).
- Overrun of the play-head past the buffered frontier between tick probes (invariant 4): instrument a build with a per-tick assertion `tc.getTime() <= bufferedUntil` in `tickHandler` (`playback-governor.ts:896-928`) and run `frame-cost.mjs` on `severe-weather`; report the max overrun in sim-ms and whether it ever reaches a not-yet-decoded bucket. Today no number exists.
- Read amplification (TO-3): with the `requests` probe on, record `Σ bytes` on the `requests` channel vs `Σ entry.length` over the same keys for a 60 s `nyc-taxi-paths` run (a 30-line addition to `policy-record.mjs`); the current `coalesceGapBytes` default of 2 MiB is untested against measured waste.
- Whether `SchedulerStats.dispatchedBytesBySource` tracks wire bytes: compare it against the `requests` channel's `Σ bytes` per source in the same run; if they diverge (quantum billing for `costBytes`-less requests) the field is not a byte counter and should be renamed.
- The BH-7 `decodeBatch` envelope (uncommitted) has no worker-side test; measure `transferables` count and `handlerMs` on the `decode` channel on `storm-4d-greenfield` to check the batch is actually amortising per-message overhead as its comment claims (`tile-decoder.ts:581-584`).

---

# Appendix 10 — audit-showcase-config

## Audit — the configuration surface (showcase ↔ loader)

Auditor dimension: how `examples/showcase` parameterizes loading per demo, what is hand-tuned vs
derived, and which demos are misconfigured against the loader's actual arithmetic.
Read-only; all numbers below come from the code paths cited, the local manifests under
`examples/showcase/public/data/`, one run of the reconcile gate, and one node script that
queried the REAL archive directories through `STTArchive.getTileIdsInBounds` at each demo's
shipped camera (1440×900, deck `WebMercatorViewport.getBounds()`), script at
`<scratchpad>/viewport-tiles.mjs`, manifest summary at `<scratchpad>/manifest-summary.mjs`.

## 0. The loader arithmetic the findings are judged against (verified in code)

| term                                        | value                                                                                                                                                                                                             | where                                                                                                                                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| clock speed `s` (sim-ms per real-ms)        | `span / targetPlaybackSeconds / 1000`                                                                                                                                                                             | `packages/playback/src/derive-params.ts:365` via `useDemoPlayback.ts:14` (`TimeController` speed 1.0 = real time, `time-controller.ts:12,409`)                                                                                         |
| prefetch speed used by the showcase recipe  | same formula with `targetPlaybackSeconds \|\| 60`                                                                                                                                                                 | `buildDemoLayers.ts:521-528` — inert today, every one of the 142 registered demos authors `targetPlaybackSeconds` (50 literal + 92 via the AV helpers, `datasets.ts` helper at the `argoverseScene` block `targetPlaybackSeconds: 16`) |
| `prefetchAhead`                             | `max(timeWindow, s × 5 000)`                                                                                                                                                                                      | `examples/showcase/src/types.ts:1848-1851`                                                                                                                                                                                             |
| `prefetchSteps` / `maxRequests`             | 4 / 12                                                                                                                                                                                                            | `types.ts:1852,1856`                                                                                                                                                                                                                   |
| planned horizon                             | `effectiveAhead = max(prefetchAhead×4, s×8 000)`, then `min(·, max(64×bucket, s×5 000))`, then `min(·, max(runAheadLimit, gateFloor))`, then feasibility solve, then pressure `×[0.25..1]` floored at `gateFloor` | `packages/core/src/prefetch-policy.ts:690-741`; `PREFETCH_LOOKAHEAD_REAL_MS` 8000 `:44`, `MAX_PREFETCH_BUCKETS` 64 `:63`, `PREFETCH_CAP_FLOOR_REAL_MS` 5000 `:75`                                                                      |
| **gate floor** (no mechanism may cut below) | `max(bucket, timeWindow, s × 5 000)`                                                                                                                                                                              | `prefetch-policy.ts:722-726`                                                                                                                                                                                                           |
| runway probe horizon                        | `max(4 × loadWindow, s × 10 000, bucket)` — `loadWindow` is the EFFECTIVE window the layer hands `tileset.update()`                                                                                               | `spatiotemporal-tileset.ts:4436-4441` (`RUNWAY_HORIZON_REAL_MS` `:286`); window source `spatiotemporal-layer.ts:1414,1442-1449`                                                                                                        |
| effective load window                       | `max(tileLoadTimeWindow, timeWindow)`; trips `max(·, 2×trailLength)`; points `max(·, 2×wakeLength)`, cumulative `max(·, 2×span)`                                                                                  | `spatiotemporal-layer.ts:1823-1828`, `animated-trips-layer.ts:1143-1147`, `animated-point-layer.ts:1407-1428`                                                                                                                          |
| tileset refresh cadence                     | when `                                                                                                                                                                                                            | Δt                                                                                                                                                                                                                                     | > loadWindow/20` AND ≥100 ms wall | `spatiotemporal-layer.ts:1415-1429` |
| governor gates                              | start 2 000 ms×s, low-water 600 ms×s, resume 2×, escape hatch 8 000 ms wall                                                                                                                                       | `playback-governor.ts:974-978`                                                                                                                                                                                                         |
| caches                                      | 2000 tiles / 2 GiB per tileset; composites `max(600, ⌊2000/N⌋)` tiles and `max(512 MiB, ⌊2 GiB/N⌋)`                                                                                                               | `spatiotemporal-tileset.ts:1330-1331`, `buildDemoLayers.ts:626-632`                                                                                                                                                                    |
| global request slots                        | 24, DRR-shared across every archive instance (the layer's `maxRequests: 12` only caps each archive's own batch)                                                                                                   | `shared-scheduler.ts:30`, `archive.ts:1957-1960`                                                                                                                                                                                       |

"Link budget" below = 4 MB/s (32 MB per 8 real s), as the brief specifies.

## 1. The measured table (12 largest archives + 6 smallest)

`tiles/bkt` and `KB/bkt` = tiles/bytes returned by `getTileIdsInBounds(viewportBox, clampedZoom,
[bucketStart, bucketEnd))` averaged over three buckets at 25/50/75 % of the span. `bkts/s` =
buckets the playhead crosses per real second at the authored target. `gate-floor tiles` =
`⌈max(bucket, window, s×5 s)/bucket⌉ × tiles/bkt` (the minimum the loader insists on holding).
`MB/s` = steady-state bytes the playhead consumes.

| demo (archive)                       | packs    | bucket | window (effective)            | target s | s (sim-ms/ms)                    | cam z→tile z   | tiles/bkt                                                    | KB/bkt | bkts/s          | gate-floor tiles                            | cache cap                                 | MB/s                           | verdict             |
| ------------------------------------ | -------- | ------ | ----------------------------- | -------- | -------------------------------- | -------------- | ------------------------------------------------------------ | ------ | --------------- | ------------------------------------------- | ----------------------------------------- | ------------------------------ | ------------------- |
| nyc-taxi-paths                       | 3 147 MB | 60 s   | 60 s                          | 60       | 2 383                            | 14→14          | 36                                                           | 294    | **39.7**        | 199 bkts → **7 164**                        | 2000                                      | **11.7**                       | ✗ F1                |
| ocean-drifters (drifters)            | 2 463 MB | 7 d    | 200 d (200 d; trail 90 d)     | 120      | 11.49 M                          | globe→0        | 2.3                                                          | 460    | 19.0            | 95 bkts → 219                               | 2000                                      | **8.7**                        | ✗ F3                |
| gtfs-ch                              | 2 449 MB | 1 h    | 20 s                          | 780      | 157                              | 7.6→7 (z6 min) | 14.7 (16 with zRange)                                        | 20 791 | 0.044           | 1 → 16                                      | 2000                                      | 0.9 (burst 21–30 MB / 23 s)    | ✓ (see NM-1)        |
| gtfs-nl                              | 2 085 MB | 1 h    | 20 s                          | 780      | 157                              | 7.3→7          | 11                                                           | 18 659 | 0.044           | 1 → 11                                      | 2000                                      | 0.8                            | ✓                   |
| satellites                           | 1 779 MB | 5 min  | 10 min (trail 60 s)           | 60       | 1 440                            | globe→0        | 2                                                            | 2 576  | 4.8             | 24 bkts → 48                                | 2000                                      | **12.4**                       | ✗ F3                |
| animal-migration (animals)           | 891 MB   | 1 d    | 4 d (8 d; trail 4 d)          | 60       | 527 040                          | globe→0        | 118 (overlapping)                                            | 33 317 | 6.1             | window sel = 139 tiles / 37.8 MB            | 2000                                      | ~1.7 steady                    | ✗ cold start, F9    |
| flights                              | 804 MB   | 1 h    | 20 min                        | 60       | 1 440                            | 4→4            | 8                                                            | 2 223  | 0.4             | 2 → 16                                      | 2000                                      | 0.9                            | ✓                   |
| mrms-precip (mrms-precip-field)      | 649 MB   | 10 min | 15 min                        | 150      | 1 728                            | 4.2→4          | 12                                                           | 376    | 2.9             | 15 → 180; planned horizon 58 bkts → **696** | 666 (N=3)                                 | 1.1                            | ~ F11               |
| rain-flood-2019 (rainfall-2019)      | 572 MB   | 2 h    | 2 h                           | 120      | 262 800                          | 4.3→4          | 11                                                           | 33     | **36.5**        | 182 bkts → **2 002**                        | 1000 (N=2)                                | 1.2 but **400 tile decodes/s** | ✗ F2                |
| flight-trips (adsb-paths)            | 543 MB   | 1 h    | 1 h (trail 2 min)             | 60       | 1 437                            | 4→4 (pitch 60) | 11.7                                                         | 1 230  | 0.4             | 2 → 24                                      | 2000                                      | 0.5                            | ✓                   |
| ship-traffic (ais-all-us)            | 498 MB   | 1 h    | 2 h (=2×wake)                 | 60       | 1 440                            | 4→4            | 9.3                                                          | 991    | 0.4             | 2 → 19                                      | 2000                                      | 0.4                            | ✓                   |
| neural-atlas-trace-wikitext (/atlas) | 434 MB   | 2 min  | 1 token = 1 s                 | —        | **1 000** (see F12) / intended 1 | 3→3            | 4                                                            | 980    | 8.3 / 0.008     | 64 bkts → 256                               | 1600/N (atlas: `buildAtlasLayers.ts:195`) | 8.2 / 0.008                    | F12                 |
| storm4d-sounding                     | 0.1 MB   | 2 h    | 360 s                         | 120      | 285                              | 8→6            | 1 (z6; camera box [−96.29,39.97,−89.30,45.27] overlaps bbox) | tiny   | —               | 1                                           | 600 (N=10)                                | ~0                             | ✓ (retracted F8)    |
| storm4d-reports                      | 0.1 MB   | 1 h    | 360 s                         | 120      | 285                              | 8→6            | ≤8 (80 tiles/10 bkts)                                        | tiny   | 0.08            | 1 → ≤8                                      | 600                                       | ~0                             | ✓                   |
| flight-paths (lines-v2)              | 0.2 MB   | 30 d   | 30 d                          | 60       | 2.1 M                            | 1→1            | ~4–10 (492 tiles/49 bkts)                                    | tiny   | 0.8             | 4 bkts                                      | 2000                                      | ~0                             | ✓                   |
| storm-radar tracks (storm-tracks)    | 0.4 MB   | 5 min  | 10 min (60 min; trail 30 min) | 75       | 288                              | 6→6            | ~3 (1042/70 across z4-9)                                     | tiny   | 0.96            | 5 → ~15                                     | 666 (N=3)                                 | ~0                             | ✓                   |
| bixi-flowmap                         | 1 MB     | 1 h    | 1 h                           | 90       | 29 760                           | 11.2→11        | static (59 tiles carry the whole month)                      | —      | 8.3             | bounded by 59                               | 2000                                      | ~0                             | ✓                   |
| wildfires                            | 7 MB     | 1 h    | 30 d                          | 60       | 1.86 M                           | 4→4            | sparse (1 224 tiles / 30 936 bkts)                           | tiny   | 516 (8.6/frame) | bounded by 1 224                            | 2000                                      | ~0                             | ✓ (sparse polygons) |

Raw script output (per-bucket triples, bounds, window selections) is in the tool log; the
key lines: nyc-taxi-paths `{tiles:36, bytes:266819/513386/123064}`, animals
`{tiles:76/133/144, bytes:20.0/36.9/45.5 MB}` and `windowSel {tiles:139, KB:37842}`, satellites
`{tiles:2, bytes:2.63 MB}` per 5-min bucket, gtfs-ch `{tiles:16, bytes:28.9/30.0 MB}` at the
daytime samples and `{12, 5.0 MB}` at the 75 % (night) sample.

## Findings

### F1 [critical] `nyc-taxi-paths` is configured so the loader's own gate floor is 3.6× its tile cache and the link needs 11.7 MB/s

**Where** `examples/showcase/src/datasets.ts:2411-2435` (`timeWindow: 60000 // 1 min window for 1.5 day dataset`, `targetPlaybackSeconds: 60`, `zoom: 14`); recipe `types.ts:1844-1857`; floor `prefetch-policy.ts:722-726`; cache `spatiotemporal-tileset.ts:1330`.
**Mechanism** span = 142 985 000 ms, target 60 s ⇒ s = 2 383. Bucket = window = 60 s, so `prefetchAhead = max(60 000, 2 383×5 000) = 11.9 M ms` (199 buckets); `windowAhead = 47.7 M`, `s×8 000 = 19.1 M`; the bucket cap `max(64×60 000, s×5 000) = 11.9 M` binds; the **gate floor is also `s×5 000` = 11.9 M ms = 199 buckets**, and nothing (run-ahead cap, feasibility solve, pressure ladder — all `Math.max(..., gateFloor)`) may cut below it. At the shipped camera the directory returns 36 z14 tiles per bucket ⇒ 7 164 tiles must be resident vs `maxCacheSize` 2000. The runway probe horizon is `max(240 000, 2 383×10 000) = 23.8 M ms` = 397 buckets = 14 300 tiles. The playhead crosses 39.7 buckets per real second; a 60 s path is on screen for 25 ms (1.5 frames); every 100 ms tileset refresh is 4 buckets stale.
**Scenario** large / playback — the largest archive in the fleet (3.1 GB, 429 k tiles). Reachable at `/demo/nyc-taxi-paths` (dev index; not in `SHIPPED_DATASET_IDS`). The same archive is the heads overlay of `nyc-flow-and-riders`, where it IS correctly sized (`headsOverlayTimeWindow: 240000`, target 900 s, `no-overlap`) — the standalone entry never received that pass.
**Consequence** 11.7 MB/s sustained (2.9× the 4 MB/s budget), and independent of bandwidth a permanent evict/refetch loop: eviction is playhead-distance ordered (`evictUnusedTiles` 4-tier), so it discards exactly the far end of the horizon the policy just planned, the pressure ladder records the runway eviction, shrinks to `gateFloor` — still 7 164 tiles — and the loop never converges. Expect the governor's 8 s escape hatch and degraded creep on every link.
**Evidence** arithmetic above with measured tiles/bucket (script); `prefetch-policy.ts:722-741` shows every shrinking path floored at `gateFloor`; the identical pathology was measured on the flow-riders overlay (`types.ts:851-858` records 854 resident tiles, 5.7 k evictions / 8 s, 43 MB/s) before `headsOverlayTimeWindow` fixed that site only.
**Fix** In `datasets.ts` set `targetPlaybackSeconds` to the ~900 s the composite uses (s = 159 ⇒ floor 13 buckets = 468 tiles, 0.8 MB/s) and widen `timeWindow` to a few minutes so a path outlives one refresh; add `refinementStrategy: 'no-overlap'` for a path archive whose z10–13 parents are placeholders only. Blast radius: this one demo. No test pins the current values (the reconcile gate only checks range/window-positivity, see F17 in F2's fix).
**Confidence** high — pure arithmetic on shipped constants and a directory query at the shipped camera.
**How to verify** `tools/bench/src/policy-record.mjs` on `/demo/nyc-taxi-paths` for 10 s: today `evict` count ≫ 0 with the same keys re-fetched; after the change zero runway evictions and ≤1 MB/s.

### F2 [high] `rain-flood-2019`: 1 year in 120 s over 2-h buckets makes the gate floor 2 002 tiles against a 1 000-tile per-archive cap

**Where** `datasets.ts:1986-2010` (`timeWindow: 7200000`, `targetPlaybackSeconds: 120`, primary `rainfall-2019` + `riversUrl`); split `buildDemoLayers.ts:626-632` (`archiveCount` = 2 for `polygon`+rivers, `:537-545`); floor `prefetch-policy.ts:722-726`.
**Mechanism** s = 31 536 000 000 / 120 / 1 000 = 262 800 ⇒ the playhead crosses 36.5 two-hour buckets per real second. `prefetchAhead = max(7.2 M, 262 800×5 000 = 1.314 G ms)` = 15.2 days; gate floor = same 15.2 d = 182 buckets; the directory returns 11 z4 tiles per bucket in the CONUS box ⇒ **2 002 tiles**, cap = `max(600, ⌊2000/2⌋) = 1 000`. Bytes are trivial (3 KB tiles, 6 MB per plan) — the byte split (1 GiB) is not the limiter; the tile-COUNT split is.
**Scenario** large / playback (composite; in the dev index, and the rivers half is shipped elsewhere).
**Consequence** the same never-converging evict/refetch loop as F1 (every shrink path is floored at 2 002 > 1 000), plus ~400 tile decodes per second on the worker pool for 33 KB/bucket of payload — per-tile overhead, not bytes, is the cost. The governor start gate (2 s×s = 73 buckets = 803 tiles) is satisfiable, so playback starts and then churns.
**Evidence** measured 10/12/11 tiles per bucket at three samples; cap arithmetic; `gateFloor` code.
**Fix** Smallest sound change: stop splitting `maxCacheSize` in composites (keep the byte split): tile-count caps exist for per-tile overhead, but a composite's overlays are usually tiny archives; at 3 KB/tile a 2 000-tile cap costs 6 MB. Alternatively raise the demo's `targetPlaybackSeconds` ≥ 300 (floor 73 buckets = 803 tiles). Add to `test/dataset-archive-reconcile.test.ts` a feasibility assertion: `⌈max(bucket, window, s×5 s)/bucket⌉ × tilesPerBucket(profile) ≤ maxCacheSize(N)` using the density sidecar's per-zoom cube (`public/density/*.json`, `cube`/`spaceExtent` at the profiled zoom) — today the gate cannot fail on F1/F2 (it passed 288/288 with these values).
**Confidence** high (arithmetic); medium on the exact churn rate (needs the probe).
**How to verify** `__sttProbe` eviction channel on `/demo/rain-flood-2019`: runway evictions per 8 s > 0 today; 0 after.

### F3 [high] The two globe-at-z0 flagships demand more than the link budget: `satellites` 12.4 MB/s, `ocean-drifters` 8.7 MB/s

**Where** `datasets.ts:4735-4767` (`satellites`: `timeWindow: 600000`, `targetPlaybackSeconds: 60`, `zoomOverride: 0`, `useGlobalBounds`), `:4849-4905` (`ocean-drifters`: 200-day window, 90-day trail, target 120, `zoomOverride: 0`); `buildDemoLayers.ts:659-664`.
**Mechanism** With `zoomOverride: 0` every frame selects the z0 tier for the whole planet. satellites: 2 tiles × 1.29 MB per 5-min bucket; s = 1 440 ⇒ 4.8 buckets/s ⇒ **12.4 MB/s** (the whole z0 tier, 743 MB, in 60 s). drifters: 2.3 tiles × 197 KB per 7-day bucket; s = 11.49 M ⇒ 19 buckets/s ⇒ **8.7 MB/s** (z0 tier ≈ 1.05 GB in 120 s). Prefetch plans: satellites `min(8 h, max(64×5 min, 2 h)) = 5.3 h` = 64 buckets = 165 MB per plan; drifters `min(2 662 d, max(448 d, 665 d)) = 665 d` = 95 buckets = 44 MB per plan. Runway probes: satellites 4 h (124 MB), drifters 1 330 d (87 MB).
**Scenario** large / playback — `ocean-drifters` is the first card in `SHIPPED_DATASET_IDS` and the home-hero (`HomeGlobe.tsx:44-58` reuses its speed).
**Consequence** on a 4 MB/s link satellites starves 3.1× and drifters 2.2×: the governor gates (start 2 s×s = satellites 48 min = 25 MB → 6 s at 4 MB/s, inside the 8 s hatch; low-water 600 ms) then stalls every few seconds; on fibre it is fine. Memory is not the problem (tile caps 2000 / 2 GiB hold the whole z0 tiers: 288 and 2 281 tiles).
**Evidence** per-bucket bytes measured from the directory; speed from the authored targets; z0 tile sizes 1.29 MB / 197 KB average.
**Fix** Config-only: raise `targetPlaybackSeconds` (satellites ≥ 190 s ⇒ ≤ 4 MB/s; drifters ≥ 265 s) or let `autoSpeed` be the default on these two (the governor's auto-speed exists, `use-playback.ts:139`). No thinning: the z0 tier stays lossless. Blast radius: two demos' pacing.
**Confidence** high on demand; medium on the user-visible outcome (depends on link; the governor may make it "slow but seamless").
**How to verify** `tools/bench/src/cold-start.mjs` / `policy-record.mjs` with a throttled 4 MB/s link: stall count and creep ms > 0 today.

### F4 [medium] Derived playback params are not safe to adopt: the resolver's defaults would over-select 12–4 320× on 11 of the 12 large demos, and the fleet's `suggested_playback_seconds` is a constant 20

**Where** `packages/playback/src/derive-params.ts:180` (`DEFAULT_TIME_WINDOW_BUCKETS = 24`), `:376-387` (window precedence), `:365` (`suggestedPlaybackSeconds` precedence); consumers `useDemoPlayback.ts:14-25` (passes archive metadata + every authored override) and `buildDemoLayers.ts:521-528` (passes NO metadata).
**Mechanism** Every registered demo authors `timeWindow` and `targetPlaybackSeconds`, so the resolver's derivations are dead paths today. If a demo dropped them: window → `min(24×bucket, span)`; duration → `styleHints.suggestedPlaybackSeconds` (present on 32 local archives; value 20 on 31 of them, 48 on drifters — the Rust emitter's `clamp(round(sqrt(bucket_count)), 20, 90)` per `optimization-implementation-plan-2026-08.md:464`).
Hand-set vs derived (>2× rows):

| demo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | hand window    | derived window | ratio           | hand target | hinted target   | which is right                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------- | --------------- | ----------- | --------------- | ------------------------------------------------------------------- |
| nyc-taxi-paths                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 1 min          | 24 min         | 24×             | 60 s        | —               | derived window, neither target (F1)                                 |
| gtfs-ch / gtfs-nl                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 20 s           | 24 h           | 4 320×          | 780 s       | 20 s (⇒ 6 135×) | hand (heads filter by playhead; 24 h = 16 tiles×1.4 MB×24 resident) |
| satellites                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 10 min         | 2 h            | 12×             | 60 s        | —               | hand window; neither target (F3)                                    |
| animals                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 4 d (8 d eff.) | 24 d           | 6×              | 60 s        | 20 s            | hand                                                                |
| flights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 20 min         | 24 h           | 72×             | 60 s        | 20 s            | hand                                                                |
| mrms-precip                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 15 min         | 4 h            | 16×             | 150 s       | —               | hand                                                                |
| rainfall-2019                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 2 h            | 48 h           | 24×             | 120 s       | —               | hand window; neither target (F2)                                    |
| adsb-paths                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 1 h            | 24 h           | 24×             | 60 s        | —               | hand                                                                |
| ais-all-us                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 2 h            | 24 h           | 12×             | 60 s        | 20 s (⇒ 4 320×) | hand                                                                |
| lines-v2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 30 d           | 720 d          | 24×             | 60 s        | —               | hand                                                                |
| wildfires                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 30 d           | 24 h           | 30× (other way) | 60 s        | —               | hand (aesthetic smear)                                              |
| storm4d-*                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 6 min          | 2 h            | 20×             | 120 s       | 20 s            | hand                                                                |
| **Scenario** all — any future demo (or MCP `view_map` user) that trusts the resolver.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Consequence** a derived window is a residency multiplier on the loader: for gtfs-ch it is 24 buckets × 16 tiles × 1.4 MB ≈ 540 MB compressed resident and a 4-day runway probe; a hinted 20 s target on gtfs-ch is 6 135× real time.                                                                                                                                                                                                                                                                           |
| **Evidence** table; `style_hints` scan of 205 local manifests (32 hinted, value distribution above); `useDemoPlayback` override set.                                                                                                                                                                                                                                                                                                                                                                             |
| **Fix** Make the window default kind-aware (points/heads: `max(bucket, s×100 ms) + bucket`; trips: `2×trail`; frames: `tileLoadTimeWindow`), or cap the default at 2–3 buckets and let `wakeLength`/`trailLength` widen (the layers already do). Stop treating a constant-20 hint as a duration; the implementation plan's BH-10 refit is the right fix — until it lands, the resolver should ignore hints equal to the emitter's clamp floor. Blast radius: `derive-params.test.ts` pins the 24-bucket default. |
| **Confidence** high that the defaults are wrong for this fleet; the "single source of truth" claim in the header (`derive-params.ts:6-24`) is aspirational.                                                                                                                                                                                                                                                                                                                                                      |
| **How to verify** a unit test resolving gtfs-ch's manifest with no overrides and asserting the window ≤ 3 buckets fails today.                                                                                                                                                                                                                                                                                                                                                                                   |

### F5 [medium] `nwm-rivers-2019` ships `blobOrdering: hilbert3` although the standing rule is time-major and the docs say the build path was fixed; the reconcile gate only rejects `spatial`

**Where** `public/data/nwm-rivers-2019/manifest.json` (`blobOrdering: "hilbert3"`, 13 monthly buckets, 11 453 tiles, 180 MB); rule `docs/roadmap/demos-and-datasets.md:384`; "landed" claim `docs/roadmap/tile-loading-3d-2026-07.md:367`; gate `examples/showcase/test/dataset-archive-reconcile.test.ts` check (f) (`blobOrdering !== 'spatial'`).
**Mechanism** The archive plays (`nwm-rivers-2019` target 120 s, and as `riversUrl` under `rain-flood-2019`); each bucket transition (every 9 s standalone, every 0.03 real-s in rain-flood... no: rivers keep their own 30-day bucket, so 13 transitions per play) re-reads the visible network's tiles for the new bucket. Under a 3-D Hilbert layout one bucket's tiles across the viewport are interleaved with the other 12 buckets' bytes, so the coalescer (2 MiB gap) either issues many ranges or over-reads. The gate cannot see it: it tests string equality with `'spatial'`.
**Scenario** large / playback (FlowCorridor rivers; the same archive whose 13× geometry duplication is already known).
**Consequence** more range requests / read amplification per bucket flip than a time-major layout; unquantified (NM-4).
**Evidence** manifest field; the two doc lines; the test predicate. `comma-280-1641/ego` is also hilbert3 (1 feature — irrelevant).
**Fix** Rebuild nwm with `--blob-ordering time-major` (the doc's own recipe) and change the gate predicate to `blobOrdering === 'time-major'` for any dataset with >1 bucket. Blast radius: one archive rebuild; the test would newly fail on this manifest.
**Confidence** high on the drift, low-medium on the magnitude.
**How to verify** `stt-optimize order-audit --format json` on the archive with a 13-bucket playback workload; `archive.stats` range-request count per bucket transition before/after rebuild.

### F6 [medium] Hover preview = a second Deck, a second archive per URL (N for composites), zero cache sharing, and it plans the LIVE demo's speed-scaled prefetch from a frozen clock

**Where** `packages/react/src/components/PlaybackControls.tsx:898-916,1110-1137` (opt-in `previewEnabled`, card stays mounted while enabled, `opacity: hover ? 1 : 0`); `packages/react/src/components/HoverPreview.tsx:67-85,121` (own `DeckGL`, `TimeController({speed: 0})`, `buildLayers` once per mount); `examples/showcase/src/components/demo/DemoHoverPreview.tsx:83-91` (calls `buildDemoLayers` with no `plumbing`); `buildDemoLayers.ts:521-528,620-622` (prefetch budget from the DATASET target, not the controller); `packages/layers/src/layers/spatiotemporal-layer.ts:1892-1900` (`new STTArchive` per layer); `packages/core/src/archive.ts:1705,4610-4612` (shared byte cache keyed by per-INSTANCE `cacheOwnerId`); `shared-scheduler.ts:30` (24 slots shared by DRR).
**Mechanism** Enabling "Preview" on the scrubber mounts a second Deck whose layer tree opens its own `STTArchive` for every URL the demo mounts (storm4d: 10). The preview's tileset receives `prefetchAhead = max(window, s_live×5 s)` and `prefetchSteps 4`; its measured speed is 0, so `effectiveAhead = windowAhead = 4×prefetchAhead` = 20 real-seconds of the LIVE speed, capped at `max(64×bucket, 0)`. Each settled hover (`PREVIEW_SETTLE_MS`) is a seek → `flushPrefetch` → a fresh plan. The byte cache token is `${cacheOwnerId}:${key}`, so nothing the live archive has fetched is reusable; both archives draw from the same 24 slots.
**Scenario** playback — any deck demo while Preview is on (it is off by default).
**Consequence** per hover position: satellites 64 buckets × 2 tiles × 1.29 MB ≈ 165 MB; nyc-taxi-paths 199 × 294 KB ≈ 58 MB; drifters 95 × 460 KB ≈ 44 MB; gtfs-ch 1 bucket ≈ 21–30 MB — all competing with live playback for slots and bandwidth, doubling memory for the resident window.
**Evidence** code paths above; `cacheOwnerId = nextArchiveCacheId++`.
**Fix** In `DemoHoverPreview` pass a `preview: true` plumbing flag and have `buildDemoLayers` emit `enablePrefetch: false` (or `prefetchAhead: timeWindow, prefetchSteps: 1`) and `maxRequests: 4` for preview trees; longer term share the archive by URL (a refcounted registry in the layer) so the preview reads the live byte cache. Blast radius: preview only; `chassis-*` tests do not cover the preview.
**Confidence** high on mechanism; medium on user impact (opt-in).
**How to verify** enable Preview on `/demo/satellites`, hover three positions, watch `archive.stats` bytes fetched on the second archive instance (≈500 MB today; ≈16 MB after).

### F7 [low] Lightning overlays leave `tier` at `'auto'`, so the weather suite opens on H3 summary cells and flips representation when zoom crosses 5

**Where** `buildDemoLayers.ts:1660-1683` (weather lightning `AnimatedPointLayer` spreads `overlayBase` = `baseProps`, `tier: selectedDataset.tier` = undefined); `spatiotemporal-layer.ts:1988-1998` (summary range from metadata); `spatiotemporal-tileset.ts:1952-1961` (`pickTierForZoom`: auto ⇒ summary when `zoom ∈ [0,4]`); `public/data/goes-glm-lightning/manifest.json` `summary_tier {min_zoom 0, max_zoom 4, columns _count, energy_fj(sum)}`; cameras `datasets.ts:3218` (z 4.2) and `:3033` (z 4).
**Mechanism** floor(4.2) = 4 ∈ [0,4] ⇒ the overlay selects the H3 summary tier at the opening camera; `radius: 'energy_fj'` then reads the per-cell SUM. At z ≥ 5 the same layer switches to raw flashes (14.4 M).
**Scenario** playback (weather suite is shipped; standalone `goes-glm-lightning` likewise).
**Consequence** the description ("every GOES-16 GLM lightning flash") is not what the opening frame draws, and a zoom across 5 during playback is a visible LOD swap. Not a loading fault — the tier machinery is doing what `auto` says.
**Evidence** code + manifest.
**Fix** `tier: 'raw'` on the lightning overlay if raw z4 tile counts are acceptable (NM-6), else document the swap. Blast radius: one prop on two sites.
**Confidence** high on mechanism; whether it is intended is a product call.
**How to verify** `__sttProbe` tier channel on `/demo/severe-weather-2024` at z4.2 reports `summary` today.

### F9 [medium] `animal-migration` at z0 needs 139 tiles / 37.8 MB resident for ANY single frame, so a 4 MB/s cold start exceeds the governor's 8 s escape hatch; the `zoomOverride: 0` justification in `buildDemoLayers` is false for this archive

**Where** `datasets.ts:4785-4846` (`zoomOverride: 0`, `useGlobalBounds`, window 4 d, trail 4 d); `buildDemoLayers.ts:653-658` ("each is a full-duplication archive whose single z0 tile per bucket already carries the complete feature set"); `animated-trips-layer.ts:1143-1147` (effective window 8 d); `playback-governor.ts:978` (`maxStartWaitMs` 8 000).
**Mechanism** the animals directory returns 76–144 z0 tiles for a ONE-DAY query (average 118) and 139 for the 8-day effective window: its z0 tiles are addressed by start bucket but their features (multi-month tracks folded into one year) span far past it, so `timeEnd` overlap pulls ~117 tiles into every window. First correct frame therefore needs ≈37.8 MB compressed; at 4 MB/s that is 9.5 s > 8 s ⇒ playback starts in degraded creep. Steady state is cheap (≈1 new tile per day-bucket, 1.7 MB/s) because successive windows overlap.
**Scenario** large / cold start (in the dev index; the pattern applies to any un-sliced track archive).
**Consequence** degraded start on modest links; the `buildDemoLayers` comment that makes `zoomOverride: 0` "safe" ("single z0 tile per bucket") does not describe animals (nor drifters: 2–3 tiles/bucket).
**Evidence** directory query at z0 world box: `perBucket [{76},{133},{144}]`, `windowSel {139 tiles, 37 842 KB}`.
**Fix** config: `overviewPreload` cannot help (z0 tier 104 MB > 20 MiB budget, `spatiotemporal-tileset.ts:451`). Either let the 4-day trail come from a `tileLoadTimeWindow` narrower than 8 d (renders the trail from resident buckets only) or accept and document; fix the comment. Build-side (out of scope here): slice tracks at bucket boundaries as `stt-build` does, which would make a day's window ≈ 1–2 tiles.
**Confidence** high on the numbers; medium on the 8 s outcome (needs the cold-start bench).
**How to verify** `tools/bench/src/cold-start.mjs ROUTE=/demo/animal-migration` at 4 MB/s: `degradedResumeCount ≥ 1` today.

### F10 [low] The terrain (`MapboxOverlay`) path defaults the map to `maxPitch 85`, contradicting the doc's "85 → 70 on DemoViewer's default"

**Where** `examples/showcase/src/components/demo/DemoViewer.tsx:735` (`maxPitch={(initialViewState as any)?.maxPitch ?? 85}`); `docs/roadmap/tile-loading-3d-2026-07.md:365-366`.
**Mechanism** only `gtfs-ch` uses `basemapTerrain` today and it authors `maxPitch: 70` (`datasets.ts:1885`), so the default is latent; the next terrain demo without `maxPitch` can be pitched past 71.57°, where `viewport.getBounds()` inverts (known class).
**Fix** `?? 70`. Reconcile check (g) reads the registry only, so it would not catch a map-level default.
**Confidence** high (one-line read).

### F11 [low] Composite cache-split arithmetic: `mrms-precip` plans 696 tiles against a 666 cap; the floors make storm4d's aggregate byte budget 5 GiB

**Where** `buildDemoLayers.ts:626-632`, `:537-579` (`archiveCount`).
**Mechanism** mrms (N=3): field horizon `min(9.6 h, max(10.7 h, 2.4 h)) = 9.6 h` = 58 buckets × 12 tiles = 696 > `max(600, 666)` — the pressure ladder will shrink it (floor 15 buckets = 180) and recover, oscillating. Weather (N=7): 48 buckets × 12 = 576 vs 600 — 24 tiles of headroom. storm4d (N=10): tile floor 600 ×10 and byte floor 512 MiB ×10 = 5 GiB nominal (harmless in practice: nine of the ten archives total < 60 MB).
**Consequence** mild fetch/evict oscillation on mrms; no starvation elsewhere (nyc-flow-and-riders heads ≈ 26 buckets ≈ 600 tiles vs 1 000; bixi-live points ≈ 160 vs 1 000; storm4d volume ≈ 380–570 vs 600).
**Fix** as F2: split bytes, not tile counts (or floor tiles at 1 000).
**Confidence** medium (tiles/bucket at z8 for the storm4d volume were not measured).

### F12 [medium] `/atlas` sets `baseSpeed = ms_per_token × tokensPerSecond` = 1 000 sim-ms per real-ms at the default "1 token/s"

**Where** `examples/showcase/src/pages/NeuralAtlasImpl.tsx:186-191`; `public/data/neural-atlas.json` `frame.ms_per_token: 1000`; `packages/playback/src/time-controller.ts:12` ("1.0 = real-time"), `:409`; `AtlasReadingStrip.tsx:55` ("60 tokens/s — the whole session in ~2 min").
**Mechanism** TimeController speed is sim-ms per real-ms. 1 token = 1 000 sim-ms; "1 token per wall second" is speed 1, but the code computes 1 000. At the "60 tokens/s" preset the formula gives 60 000, i.e. the 8 128-token trace (8 128 s sim) in 0.14 s — the strip's own label says ~2 min, which is speed 60.
**Scenario** local-only surface (`ATLAS_ARCHIVES_SYNCED = false`, `datasets.ts:5453`).
**Consequence** if real, the trace tileset (2-min buckets, 4 tiles ≈ 1 MB per bucket at z3) is asked for 8.3 buckets/s ≈ 8 MB/s instead of 8 KB/s, and `tokensInWindowFor` sizes the window for 1–4 tokens while ~16 tokens pass per frame. Confidence is only medium because the user has visually verified this surface; the unit mismatch may be compensated somewhere I did not read.
**Fix** `baseSpeed = ms_per_token × tokensPerSecond / 1000`.
**How to verify** open `/atlas`, time 60 tokens on the reading strip at the default rate.

## Checked and correct

- `tileLoadingProps` ÷60 fallback vs the clock's ÷30 is inert: all 142 registered demos author `targetPlaybackSeconds` (text parse: 50 literal; the 92 AV/waymo/nuscenes entries get 16 s from their helper) — `buildDemoLayers.ts:521-528`, `datasets.ts` helper block.
- `getBufferedRunway` horizon is `max(4×loadWindow, s×10 s, bucket)` with the EFFECTIVE window (trail/wake-widened), `spatiotemporal-tileset.ts:4436-4441`; `getEffectiveTimeWindow` chain `spatiotemporal-layer.ts:1823-1828` → trips `animated-trips-layer.ts:1143-1147` → points `animated-point-layer.ts:1407-1428` — verified for animals (8 d), storm-radar tracks (60 min), mrms tracks (2 h), ship-traffic (2 h).
- `tier` unset on archives without a summary tier is inert: `pickTierForZoom` returns `'raw'` when `getAvailableSummaryTiles` is undefined, `spatiotemporal-tileset.ts:1954-1955`; only earthquakes-summary, nyc-taxi-od-summary and goes-glm-lightning carry `summary_tier` locally.
- Overview preload cost is bounded: zoom list `[minZoom .. min(1, maxZoom)]` is EMPTY for minZoom ≥ 2 (nyc-taxi-paths, gtfs-_, bixi-_, nyc-taxi-flows, nwm) → `no-tiles`; z0-archives sum directory bytes and reject `over-budget` (20 MiB) before any tile fetch; paged directories only pull pages overlapping z0/z1, `spatiotemporal-tileset.ts:4869-4940`, `archive.ts:3235-3265`. Overlays pass `overviewPreload: false` (`buildDemoLayers.ts:991-992`, `overlayBase`).
- `useGlobalBounds` ⇒ `zoomOverride` pairing is applied for every layer type (`buildDemoLayers.ts:659-664`); `getZoomLevel` clamps to `[minZoom, maxZoom]` and bypasses the 256-cell budget under global bounds (`spatiotemporal-layer.ts:2707-2720`).
- `zRange` forwarded generically (`buildDemoLayers.ts:669`); gtfs-ch's `[0, 7000]` adds 0–4 tiles at z7 (measured 12–16 vs 12–16 without at the daytime samples).
- Interleaved `MapboxOverlay` path (gtfs-ch): cadence is unchanged — deck `_animate` redraws each frame → `_customRender` → `map.triggerRepaint()` → `deck-utils.js:259 onBeforeRender` → `timeController.advanceFrame()` (`use-deck-clock.ts`); the chassis throttle (100 ms wall / window÷20) and `viewport.getBounds()` source are the same code; `elevationFromVertexValues` short-circuits `terrainRevision` rebuilds (`DemoViewer.tsx:695-698`).
- `heads` overlay wiring (`buildDemoLayers.ts:938-993`): passes `headsOverlayTimeWindow` as both `timeWindow` and `prefetchAhead`, `no-overlap`, no overview preload — matches the documented intent; nyc-flow-and-riders horizon ≈ 26.5 buckets (the `s×10 s` term, not 4×window) ≈ 600 tiles < 1 000.
- Composite `archiveCount` per family is correct against the layers each branch instantiates (`buildDemoLayers.ts:537-579`); heatmap channels count once.
- Reconcile gate ran green: 288 tests, 142/142 datasets reconciled, 0 inconsistencies, 0 camera findings; warnings captured verbatim in §"Reconcile output".
- Shared scheduler budget is 24 regardless of the layer's `maxRequests: 12` (`shared-scheduler.ts:30`); the 12 is the archive's own per-batch cap (`archive.ts:1957-1960`) — consistent with the `types.ts:1853-1856` intent.
- `useArchiveMetadata` opens a third `STTArchive` per primary URL but manifests are 7–19 KB (nyc-taxi-paths 13.6 KB; the 5.7 MB paged directory is a separate `.sttd` never fetched by `getMetadata`) and results are module-cached — negligible.
- `goes-glm-lightning` is `formatVersion 2`; the reader accepts `[2, 3]` (`archive.ts:101,114,2194-2197`).
- `neural-atlas-anatomy` / `-manifolds` are `blobOrdering: spatial` but have ONE 24-h bucket over a 2.3-h span (no multi-bucket reads); `-trace-wikitext` is time-major. Deliberate and harmless for playback.
- `DemoViewer` layer memo deps (`DemoViewer.tsx:275-297`) do not include `currentTime`; time reaches layers via the controller tick — no 60 Hz prop churn.
- Hover preview is opt-in (`previewEnabled` default `false`, `PlaybackControls.tsx:898`) and deck-only (`DemoPageImpl.tsx:321-333`).
- storm4d-sounding IS in frame despite the reconcile note (camera centre outside its extent): the z8/pitch 55/bearing 25 ground box is [−96.29, 39.97, −89.30, 45.27], overlaps the bbox, and `getTileIdsInBounds` returns 1 z6 tile — an earlier draft finding (F8) was refuted by this query; the reconcile note's "flagged not failed" classification is right.
- Small demos: prefetch horizons larger than the archive (storm4d-sounding 1 bucket, atlas anatomy 1 bucket, lines-v2 49 buckets) are clamped at `idx.timeRange.end` in the runway probe (`spatiotemporal-tileset.ts:4467-4471`) and the plan query is one directory call per pass; wildfires' 30-day window over hourly buckets is bounded by its 1 224 sparse tiles; bixi-flowmap's 59 static tiles satisfy any horizon.

## Doc ↔ code drift

- `types.ts:1832-1834` ("The underlying tileset freezes these options when it is created") — stale: `prefetchAhead`/`prefetchSteps` changes re-plan via `setOptions` (`spatiotemporal-tileset.ts:1852-1853`, layer `:1368`).
- `types.ts:851-853` ("the governor's buffered-runway horizon is `4 × timeWindow`") — incomplete: `max(4×window, s×10 s, bucket)`; at 159× the speed term (26.5 min) beats 4×240 s (16 min), so the window knob cannot shrink the probe below `s×10 s`.
- `datasets.ts:2425` (`zoom: 14, // Higher zoom = fewer tiles loaded`) — false: tiles per screen are ~constant with zoom (36 z14 tiles at pitch 45 measured); deeper zoom means smaller tiles, not fewer.
- `buildDemoLayers.ts:653-658` ("each is a full-duplication archive whose single z0 tile per bucket already carries the complete feature set") — false for animals (76–144 z0 tiles overlap a single day) and drifters (2–3 per bucket).
- `datasets.ts:1690-1691` bixi-live ("1h window comfortably covers the current 10-min flow bucket") vs `:1681-1683` ("Built at 5-MINUTE buckets") — manifest says 5 min.
- `docs/roadmap/tile-loading-3d-2026-07.md:365-367` ("maxPitch 85 → 70 on … DemoViewer's default", "`--blob-ordering time-major` on the nwm/GTFS build paths" — landed) — DemoViewer's terrain map default is still 85 (F10); the nwm archive in the tree is hilbert3 (F5).
- `derive-params.ts:6-24` ("the single source of truth … so every consumer resolves identically") — no showcase consumer takes its window or duration (all overridden); `buildDemoLayers` passes no metadata at all (`:521-528`).
- Reconcile test header (f) claims to catch the blob-ordering hazard; the predicate only rejects the literal `'spatial'` (F5).
- `types.ts:1840-1843` (old DemoPage math note) is accurate history; `types.ts:1853-1856` ("12 is enough for HTTP/2") is true per archive but the global budget is 24 shared — worth one sentence.

## Reconcile output (verbatim, `pnpm exec vitest run test/dataset-archive-reconcile.test.ts`, 288 passed)

```
[reconcile] 142 reconciled (39 via density sidecar, 103 via manifest fallback), 0 skipped (no local fixture) of 142 datasets
[reconcile] 17 informational note(s) (6 deliberate sub-window(s), 11 sub-bucket window note(s)):
    · nyc-rideshare / nyc-taxi-od-heatmap / nyc-taxi-cube: deliberate sub-window authored=[1420070400000, 1420080391000] inside archive=[1420070400000, 1422750678000]
    · osm-nyc-draw: deliberate sub-window authored=[1181952000000, 1767225600000] inside archive=[1181952000000, 1779059839000]
    · osm-nyc-changesets-summary / -editors: deliberate sub-window authored=[1167609600000, 1767225600000] inside archive=[1132704000000, 1779666225000]
    · sub-bucket timeWindow < bucketMs, "fine for point/trip-heads demos, flagged for review":
      nyc-od-arcs 1800000<3600000 · bixi-points 20000<3600000 · gtfs-nl 20000<3600000 · gtfs-ch 20000<3600000 ·
      nwm-rivers-2019 86400000<2592000000 · flights 1200000<3600000 · nyc-rideshare 120000<3600000 ·
      nyc-taxi-od-heatmap 1800000<3600000 · nyc-taxi-points 20000<60000 · nyc-taxi-cube 1800000<3600000 · nyc-taxi-heads 20000<60000
[reconcile] 0 inconsistencies — every reconciled demo agrees with its archive
[archives] 580/591 archive urls resolve on disk; 11 unresolved: waymo-sf-day-surfel-adaptive + nuscenes-0061/0103/0553/0655/0757/0796/0916/1077/1094/1100 `avTracksUrl`
[camera] 18 informational note(s): storm-4d-greenfield / storm-4d-isolines floor(camera)=8 > max_zoom=6 on warnings/reports/stations/cloudTop/wind3d/sounding, > max_zoom=7 on lightning and (isolines) url;
         storm-4d-*: camera centre (-94.46, 41.4) outside soundingUrl extent [-96.386, 41.32, -95.733, 41.954] — "opens on empty map — overlay, flagged not failed";
         cosmos-drive-dreams: floor(camera)=11 < min_zoom=13 on avObjectsUrl — "overlay, flagged not failed"
[camera] 0 findings — every demo's camera agrees with every archive it mounts
```

Note the gate has no assertion relating `timeWindow`/`targetPlaybackSeconds` to bucket count, tiles per bucket or cache caps — F1/F2 pass it.

## Needs measurement

- NM-1 gtfs-ch/gtfs-nl bucket-transition burst: 16 tiles × 1.4 MB (21–30 MB) must land in the ≈20 wall-s the prefetch (52 sim-min ahead) allows; fine at 4 MB/s, a stall per hour bucket at ≤1.5 MB/s. Measure: `policy-record.mjs` on `/demo/gtfs-ch` with a 1.5 MB/s throttle; expect one `buffering` per hour boundary.
- NM-2 rain-flood churn magnitude (F2): runway evictions/s and worker decode rate via `__sttProbe`.
- NM-3 satellites/drifters at 4 MB/s (F3): stall count, creep ms, and whether `autoSpeed` converges.
- NM-4 nwm hilbert3 cost (F5): range requests and bytes per bucket flip vs a time-major rebuild (`stt-optimize order-audit`).
- NM-5 animals cold start (F9): `cold-start.mjs` at 4 MB/s, `degradedResumeCount`.
- NM-6 raw lightning tile count at z4 per 15-min bucket (to decide F7's `tier: 'raw'`): one `getTileIdsInBounds` call on the raw tier.
- NM-7 terrain path bounds: with mapbox terrain the camera is elevated over the Alps at pitch 52; deck's synced viewport (`getViewState(map)`) feeds `getBounds({z: 7000})` — confirm the near-edge z7 tiles are selected (probe `tileset.viewport` snapshot vs drawn tiles) on `/demo/gtfs-ch`.
- NM-8 Atlas real speed (F12): time the reading strip.

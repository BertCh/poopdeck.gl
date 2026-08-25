# Tile loading — full audit (2026-08-24)

Scope: everything between "the camera and clock are here" and "these tiles are drawn" —
selection and LOD, prefetch and the buffered runway, the clock↔loader governor, caches and
eviction, network and the request scheduler, the decode pipeline, the render-side consumers
(deck / three / maplibre / cesium), cold start and the small-archive path, the showcase
configuration surface, and what the tests and telemetry can prove about any of it.

Goal it was judged against, verbatim from the ask: **fully optimized for very large datasets,
functional for smaller ones, and the playback experience must be seamless.**

Method: ten parallel read-only auditors, one per subsystem, each required to refute its own
findings before reporting and to cite `file:line`; every critical/high finding below was then
re-verified first-hand (code read, the auditor's proof re-executed, or a live probe). In
parallel, 21 showcase demos were probed on the local dev server (10 s of playback each,
1440×900, ANGLE/Metal) for resident tiles, evictions, network bytes, decode counts and clock
advance. The raw per-subsystem reports — ~3,000 lines of line-referenced evidence, per-file test
verdicts and drift lists — are in
[tile-loading-audit-2026-08-evidence.md](./tile-loading-audit-2026-08-evidence.md). Probe
scripts and proofs live in the session scratchpad; the reusable ones are named in §8.

Two things were in flight while this ran and are **not** findings: the uncommitted CO-7 change
(`prefetchFutureTiles` primary-zoom-only — assessed sound, see §5) and a peer session landing
BH-7 decode batching in `tile-decoder.ts` / `tile-decoder.worker.ts` (one caveat recorded as
D2).

---

## 1. Headline

The loader is architecturally right — playhead-relative eviction, an EDF/DRR scheduler, a
byte-priced runway, a clock that waits for data — and on **small and medium archives it is
already clean**: `bixi-flowmap`, `wildfires`, `gtfs-ch`/`gtfs-nl` at their shipped cameras,
`flights`, `ship-traffic`, `hrrr-wind`, `nyc-rideshare` all play at the vsync ceiling with zero
evictions and single-digit requests per 10 s. The small-dataset machinery is not the problem.

On the **large and long** archives the same code is spending most of its effort fighting
itself, and four of the shipped flagship demos are in a permanent fetch → evict → refetch loop
that no user can see except as jank and bandwidth:

| demo (10 s of playback, local server)      | fps | evictions | runway evictions | re-decodes | play bytes | pressure | root cause                                           |
| ------------------------------------------ | --: | --------: | ---------------: | ---------: | ---------: | -------: | ---------------------------------------------------- |
| `earthquake-activity` (earthquakes-v2)     |  52 |     8,023 |            8,023 |     2,624+ |    12.8 MB |     0.25 | A1 (8,927 pinned overview tiles vs a 2,000-tile cap) |
| `earthquake-columns` (earthquakes-v2)      | 110 |     8,133 |            7,940 |     3,733+ |     5.5 MB |     0.25 | A1                                                   |
| `hurricanes`                               |  67 |     4,580 |            4,249 |        453 |    11.4 MB |     0.25 | A1 (17,899 pinned)                                   |
| `rain-flood-2019` (rainfall-2019 + rivers) | 109 |    27,111 |           25,557 |     2,931+ |    63.2 MB |     0.25 | A1 (4,380 pinned vs a 1,000 split cap) + A2          |
| `nyc-taxi-paths`                           |  84 |     9,509 |                0 |          0 | **719 MB** |     1.00 | A2 (horizon 7,164 tiles vs a 2,000 cap at 2,383×)    |

("+" = the decode probe channel caps at 4,096 samples, so those counts are floors. Full table
in §7.)

Three mechanisms explain all five rows, and each was reproduced in isolation:

- **A1.** The overview storyboard pin is budgeted in **bytes** (20 MiB of directory bytes) but the
  cache cap that matters on long archives is the **tile count** (2,000). Pinned tiles count
  against the cap and can never be evicted, so once the pin set exceeds it the cache is
  permanently over-limit and every selection pass evicts _every_ non-pinned loaded tile — tiers
  A→D, the protected playhead window included. The code already detects this case and prints a
  warning (`spatiotemporal-tileset.ts` `finishOverviewLoad`); it then proceeds. Both earthquake
  demos, `hurricanes` and `rain-flood-2019` print that warning on every load.
- **A2.** At high playback speed the prefetch horizon's floor is `speed × 5 s`, which the
  pressure ladder and the feasibility solve are forbidden to cut below; the per-pass budget is an
  admission cap, not a residency bound. When `horizon × tiles-per-bucket > maxCacheSize` the far
  edge of the runway is fetched, evicted (tier B/C) and re-fetched forever, with the ladder pinned
  at 0.25 and no effect. `nyc-taxi-paths` at its shipped 60 s target is 2,383× real time =
  39.7 buckets/s.
- **A3.** Eviction only runs inside `selectAndLoadTiles`, and that returns early on an unchanged
  selection key. A gated (frozen) clock with a still camera therefore means **no eviction while
  prefetch keeps landing** — the heads-overlay tileset on `/demo/nyc-flow-and-riders` was observed
  at 13,741 headers / 1.67 GB against a 1 GiB split cap during a start gate.

The second cluster is **playback continuity**: five independent, reproduced mechanisms each turn a
healthy loader into a stall or a visible pop — a sub-⅛-viewport camera drift that decays the
runway to zero with everything resident (B1), a committed seek that never reaches the tileset
(B2), an EDF distance that ranks the bucket under the playhead _behind_ every future bucket
(B3), DRR arrears that let optional prefetch jump a required source's need-now request (B4), and
a loop wrap that is always a cold seek (B5).

The third is **bandwidth and decode efficiency** on large archives, where the biggest single lever
is not the loader at all: **every zstd frame in the fleet declares an 8 MiB window and no content
size**, so the pure-JS decoder allocates and memmoves 8 MiB per tile — 69–92 % of decode service
time, 12.6× on `earthquakes` tiles. A reader-side header rewrite fixes it on the shipped fleet with
no rebuild (D1).

Memory is **not bounded** as the program's spine claims: 2 GiB of decoded tiles per tileset with
zero device awareness (only the compressed cache reads `deviceMemory`), composite floors that sum
to 3.5–5 GiB, and the M2 dictionary-hoist fix inert in browsers because identity sharing dies at
the structured-clone boundary (C1–C3).

---

## 2. Findings — ranked

Verification column: **live** = reproduced on the dev server in this audit; **repro** = the
auditor's proof script was re-executed by the consolidator against the real classes; **code** =
consolidator read the decisive lines; **agent** = auditor-measured, not independently re-run.
IDs in parentheses are the per-subsystem report IDs in the evidence appendix.

### A — Cache residency (the fetch/evict/refetch loops)

**A1 [critical] The overview pin set has no COUNT gate.** (CS-1 / CE-1) — live + code.
`preloadOverviewTier` accepts every z0–z1 tile across the full time range whose _directory_ bytes
sum ≤ 20 MiB (`spatiotemporal-tileset.ts:4926-4933`); `evictUnusedTiles` then tests
`loadedCount > maxCacheSize` with pinned tiles included in the count and excluded from the
candidates (`:5244-5249`, `:5290-5305`, `:5455-5470`). Hourly-bucket archives over years pin
thousands of tiny tiles: `earthquakes-v2` 8,927 (11.4 MB), `hurricanes` 17,899 (10.5 MB),
`rainfall-2019` 4,380 against a 1,000 split cap. Controlled repro (real reader, local archives):
earthquakes-v2 with the pin → 11,105 runway evictions / 11,206 refetches in 6 s of playback;
**0** evictions in the no-pin control. `overview-preload.test.ts:173` pins the churn as expected
behaviour; `getCacheStats().pinnedCount` (named in tile-loading-3d §8 as the one-line check)
does not exist.
_Fix:_ gate the pin on count as well as bytes (`candidates.length ≤ maxCacheSize × PIN_FRACTION`
with the fraction ≈ 0.25, or a `PINNED_CACHE_FRACTION` option), and exclude pinned tiles from the
size test (`overSizeLimit = loadedCount − pinnedCount > maxCacheSize`) so a legal pin can never
push the working set over. Expose `pinnedCount` in `getCacheStats()`. Blast radius:
`overview-preload.test.ts` (re-bless :173), `eviction-*` untouched.

**A2 [critical] At fast playback the runway horizon exceeds the cache and the shrink paths are
forbidden to shrink it.** (PR-1 / CE-2 / F1 / F2) — live + repro. `prefetch-policy.ts:707-727`
sets cap `= max(64 × bucket, speed × 5 s)` and `gateFloor` includes `speed × 5 s`; `:865` skips
the CO-2 solve when `effectiveAhead ≤ gateFloor`; `:775-777` floors the pressured horizon at
`gateFloor`. `prefetchFutureTiles` (`spatiotemporal-tileset.ts:3502-3569`) counts only NEW tiles
against the per-pass budget, and re-plans as soon as the slice drains. Result: residency
converges on the whole horizon; the over-limit pass evicts tier C (furthest ahead, just fetched);
the next pass sees `header === undefined` and enqueues it again. Repro: 3,350 requests for 2,835
distinct tiles, 555 runway evictions, pressure pinned 0.25 with the far edge still dispatched 94
buckets ahead of an 80-bucket cache. Live: `nyc-taxi-paths` 9,509 tier-B evictions and 719 MB in
10 s. The showcase side is the same defect from the other end: at 2,383× the gate floor is 199
buckets × 36 z14 tiles = 7,164 tiles vs 2,000; `rain-flood-2019` 182 buckets × 11 = 2,002 vs a
1,000 split; `satellites` 12.4 MB/s and `ocean-drifters` up to ~8 MB/s in the dense decades
(measured 0.19 MB/s in the sparse 1979 opening) at their shipped targets. The reconcile gate
cannot fail on any of these (288/288 green).
_Fix (loader):_ make the prefetch budget a **residency** bound — count loaded headers within
`effectiveAhead` toward the pass budget before admitting new ones; bend `gateFloor` to
`min(gateFloor, residencyCapacitySimMs)` where capacity = `PREFETCH_CACHE_FRACTION × maxCacheSize
/ keysPerBucket × bucketMs` (the governor already has the 8 s escape hatch, so over-committing
buys nothing). _Fix (config):_ a horizon-feasibility assertion in the dataset↔archive reconcile
test (`horizonBuckets × tilesPerBucket ≤ maxCacheSize`), raise `targetPlaybackSeconds` on
`nyc-taxi-paths` / `rain-flood-2019` / `satellites` / `ocean-drifters` or default `autoSpeed` on
them, and split composite caches by **bytes** rather than count (3 KB tiles make a 1,000-tile
split the wrong limiter). Blast radius: `prefetch-runway.test.ts:50`,
`prefetch-policy.test.ts:250,:930,:944`, `prefetch-runahead-cap.test.ts:108`.

**A3 [high] Eviction is reachable only from a selection pass that got past the fast path.** —
code + agent-observed. `evictUnusedTiles` has two callers (`:1884` setOptions, `:3232` inside
`selectAndLoadTiles`); `update()` returns at `:2906-2912` when the select key (which folds the raw
`timeRange`) is unchanged. A frozen clock + still camera = tiles landing with no eviction. Observed
as 13,741 headers / 1.67 GB on the flow-and-riders heads overlay (cap 1 GiB) during a start gate.
_Fix:_ run the over-limit branch of `evictUnusedTiles` from `deliverTile` when
`currentCacheBytes > maxCacheByteSize || loadedTileCount > maxCacheSize` (cheap: it is the
existing tiered plan), or from a rAF-coalesced hook after each batch settles.

**A4 [high] The count cap is the wrong limiter and the byte cap is the wrong size.** (CE-4 / F11)
— code. Decoded cache defaults: 2,000 tiles / 2 GiB **per tileset**, no `deviceMemory`, no
`hardwareConcurrency`, no reaction to `QuotaExceededError`; only the compressed cache is
device-aware (`archive.ts:971-990`). Composite floors (`buildDemoLayers.ts:626-632`:
`max(600, 2000/N)` tiles, `max(512 MiB, 2 GiB/N)` bytes) **sum** past the budget: storm-4d N=10
→ 5 GiB nominal, weather N=7 → 3.5 GiB. On 3 KB tiles the count cap binds at ~6 MB; on
`satellites` z0 tiles (4.5 MB decoded each) 2,000 tiles would be ~9 GB — the byte cap binds
first there, and 640 MB were resident after 10 s. `estimateTileSize` itself is honest (decoded
bytes, 2.3–3.6× compressed, verified).
_Fix:_ one process-wide decoded-byte budget shared across tilesets (the pattern the compressed
cache already uses, `sharedByteCacheLru`), sized from `deviceMemory` with a 512 MiB floor / 1.5 GiB
ceiling, and drop the count cap to a sanity ceiling (e.g. 50,000) so small-tile archives are
bounded by bytes. Composites then need no per-N arithmetic.

**A5 [high] The M2 hoisted-category identity fix is inert in browsers.** (CE-3 / D3) — code.
`sharedCategoryTable` shares one `string[]` per `${templateHash} ${column}` inside the realm that
decodes (`tile.ts:196-301`); the production path decodes in a worker and structured-clones the
tile to the main thread (`tile-decoder.worker.ts:193-205`), which allocates a fresh array and
fresh strings per tile; `tile-decoder.ts` has no receive-side dedupe. `gtfs-ch` `agency_id`: 8.3 KB
of duplicated strings per tile (90 % of a z10 tile's resident bytes); the 14,653-category column
the conformance record cites would be ~1 GB at 2,000 resident. `hoisted-category-sharing.test.ts`
tests the inline path only.
_Fix:_ have the worker post a `categoriesRef` token for hoisted tables and materialise once on the
host (exact, also removes the clone cost); coordinate with the in-flight BH-7 message-shape change.
Add a `WorkerTileDecoder` identity test with the existing `FakeWorker`.

**A6 [medium] The compressed byte cache is pure overhead under the decoded cache.** (CE-5) —
live. `archive.stats` hit rate: 0 % on every healthy demo probed; hits only appear under the A1
thrash (23 % on `earthquake-activity`, 60 % on `rain-flood-2019`), i.e. it is a shock absorber for
a bug. 500-entry / 512 MiB structure, an extra `buffer.slice` + `slice(0)` per tile on the main
thread (D10), and `clearCache()` leaks shared-LRU accounting (does not unregister, unlike
`clearByteCache()`).
_Fix:_ once A1/A2 land, default `maxCacheTiles: 0` (documented, no caller) and transfer the
range buffer's slice directly; or keep it only as the OPFS write staging.

**A7 [medium] OPFS persistence is dead code with sharp edges.** (CE-6) — code. Opt-in, zero
callers anywhere; if enabled it rewrites the whole `index.json` on every touch, sorts all entries
per over-budget write, and only logs `QuotaExceededError`. Not a playback risk today; a footgun for
the first consumer.

### B — Playback continuity

**B1 [high] Sub-tolerance camera drift leaves phantom keys in the coverage index; the runway
decays to 0 with everything on screen resident.** (PR-2) — repro. The index is rebuilt only when
`quantizedSpatialKey` (bounds rounded to ⅛ of the span, `:2811-2820`) changes, but is built from
the **exact** bounds (`:5113-5131`); a bucket is ready only if _every_ index key is ready
(`:4488-4499`). After a drift < ⅛ viewport that crosses a tile boundary the trailing-edge column
stays in the index and nobody ever requests it again. Re-executed: runway 14,900 → 0 over 25
steps with `headBucketTilesNeverRequested = 0` throughout; recovery only after a > ⅛ pan. The
governor reads `simMs 0` → low watermark → `buffering` → unsatisfiable → 8 s hatch → degraded
creep. Trigger: any smoothly moving camera — `/drive` ego-follow, the auto-rotating globes
(`ocean-drifters`, HomeGlobe, StoryGlobe), eased pans, the terrain camera. This settles the
"coverage-index quantisation staleness" item left unconfirmed in tile-loading-3d §8: confirmed.
_Fix:_ key the index on the primary-zoom **tile box** of the bounds (the same
`viewportTileXIntervals`/`latToTileClamped` the placeholder gate uses) — it changes exactly when a
tile boundary is crossed; stop-gap: skip index keys whose `(x,y)` fall outside the current bounds'
tile box in the three readiness walks. Pin with experiment B as a test.

**B2 [high] A committed seek inside the layer's 100 ms wall throttle never reaches the tileset.**
(G1) — code. `_handleTimeUpdate` (`spatiotemporal-layer.ts:1403-1430`) runs `tileset.update()`
only if `timeDelta > window/20 && wall ≥ 100 ms`; the blocked branch (`:1479-1481`) only calls
`setNeedsRedraw()` — no trailing update (contrast `_scheduleViewportSettle` for the viewport
path). `commitSeek` (`playback-governor.ts:2283-2305`) pauses the clock **first**, so no later
tick arrives; the gate's `setAnimationState(true)` plans prefetch from the **stale** time. During
playback the throttle blocks with probability ≈ 1; on drag release `endScrub(value)` with
`value === _currentTime` calls nothing at all (the `|Δ| > 1` guard in the tick handler
`:1125-1129`). Resolution is the 8 s `maxStartWaitMs` hatch → degraded creep on R2-class links;
on the local server the predictor masks it as ≤ 100 ms of `buffering`/`playing` flapping (the
`backjumps` "flash repro" diagnostic in `time-controller.ts:126-146` is consistent with exactly
this).
_Fix:_ when the wall throttle blocks and the clock is paused (a `setTime` on a paused clock is by
definition a seek), arm a trailing `setTimeout(remaining)` that re-runs `_handleTimeUpdate`
(mirror `_scheduleViewportSettle`, cancel in `_cancelPendingUpdates`); drop the `|Δ| > 1` guard
when paused. One chassis method; no test pins the blocked branch today.

**B3 [medium] EDF distance is keyed on `timeStart`, so the bucket containing the playhead ranks
as "already passed".** (NS-7) — code. `archive.ts:3948-3956`: `ahead = timeStart − t; dist = ahead
≥ 0 ? ahead : BEHIND_OFFSET + |ahead|`. A playhead 30 s into a 60 s bucket puts the frame being
drawn behind the frame 30 s away, and `runGroupFetches` re-sorts by this value so the archive's
order wins over the tileset's symmetric one. `scheduler-group-priority.test.ts:211-222` pins the
inversion. _Fix:_ `passed = dir > 0 ? timeEnd < t : timeStart > t`, distance 0 for a containing
interval; re-bless the test's third case.

**B4 [high] DRR byte arrears let optional prefetch jump a required source's need-now request.**
(NS-2) — repro. `request-scheduler.ts:856-901`: the deficit gate runs _before_ the priority
compare; a group larger than one quantum (512 KiB) leaves its source in arrears repaid one quantum
per round and pruned only when the source is fully idle. Re-executed on the shipped scheduler:
optional prefetch groups dispatched while the required source's need-now group waited — 0 after a
512 KiB group, 12 (3 MB) after 2 MiB, **168 (42 MB) after 15 MiB**, 30 with the required source
at weight 4. Primary groups are routinely 0.25–15 MB. _Fix:_ gate admission per tier (run the DRR
gate only among candidates of the most urgent tier present), or cap arrears at `−quantum` in the
spend step. Re-bless the recorded-order pins in `request-scheduler.test.ts:986-1330`.

**B5 [medium] A loop wrap is always a cold seek.** (PR-3 / G4) — code. `loopRange` is consumed
only by the eviction tiering (`:5362`); the prefetch plan never crosses `loop.end`; the wrap is a
seek that flushes everything. Every showcase demo loops by default (`use-playback.ts:122`).
_Fix:_ let `PrefetchPolicy.plan` wrap the horizon modulo the loop window (the eviction tiering
already does this arithmetic) and mark the wrap as a non-flushing "continuation" in the seek
detector.

**B6 [medium] The frontier clamp gates on a ≤ 200 ms-stale frontier.** (G3) — agent. Spurious
one-frame stalls and a backward snap at bucket edges when throughput ≈ demand; escalates to real
hysteresis stalls on fine-bucket fast demos. _Fix:_ re-probe the runway before clamping when the
frontier is older than one frame.

**B7 [medium] With the unauthored BH-4 band the low-watermark min-gate degenerates to a max-gate
on bucket-coarse composites.** (G2) — agent. Whenever one bucket lasts ≥ 0.4 wall-s (every shipped
composite) a starved required laggard cannot trip the watermark while any peer holds one bucket;
the laggard plays through its missing bucket (overlay pop). The test at `playback-governor.test.ts
:2805` is vacuous (mock ignores `horizonSimMs`).

**B8 [low] 404 packs hold the clock 7.5–16.5 s and are retried forever.** (NS-9 / G7) — code.
The archive retries a 404 twice with backoff, fans out per member, and the tileset re-enqueues
written-off tiles at the 60 s ladder cap. _Fix:_ classify 4xx as permanent at `fetchObjectRange`;
readiness write-off on the first permanent failure.

### C — Bandwidth on large archives

**C1 [critical] The 20 s transfer timeout is a total deadline over unbounded coalesced groups,
retried identically, then per-member, then forever.** (NS-1) — code. `withTransferTimeout`
(`archive.ts:849-887`) arms one timer before `fetch` and races `response.arrayBuffer()` on the
same signal (`:2426-2447`) — nothing re-arms on progress. Group size is bounded only by the pack
and `MAX_COALESCE_BATCH` 1024. A tile or group larger than `link × 20 s` can **never** complete:
three identical attempts, a per-member fallback with the same deadline, `null`, ladder, re-enqueue
— and every attempt feeds `throughput.addSample(1, ~20000)`, collapsing the estimate to ~0. The
uncommitted `gtfs-ch` build has a 16 MB single tile (z6) and 7–15 MB one-request bucket steps at
its own camera: ≥ 6 Mbit/s per stream or unloadable. `archive-transport-hardening.test.ts` pins
"3 attempts, identical range" and never a slowly-progressing body.
_Fix:_ read `response.body` with `getReader()` and re-arm the watchdog per chunk (a stalled
response still dies at 20 s; a progressing one never does); on `TimeoutError` skip straight to the
per-member split; do not re-attempt a tile whose `length > conservativeRate × timeout` until the
estimate improves. Intra-group streaming (C2) falls out of the same read loop.

**C2 [medium] No intra-group incremental delivery.** (NS-4) — code. Members are sliced from the
complete buffer; the first tile of a 15 MB `gtfs-ch` z7 range is decodable only after the last
byte (~6 s at 20 Mbit/s instead of ~1.5 s). Fix rides C1.

**C3 [medium] The 2 MiB coalesce gap has no amplification bound.** (NS-6) — agent. One
`earthquakes` z10 bucket: 10 tiles / 5 KB useful fused into one 4.69 MB request (~900×), because
blob dedup breaks time-major locality (the same blob is referenced from z0..z4). Steady-state
playback amplification measured with the real reader: `nyc-taxi-paths` z14 1.88×, z12 1.01×;
`gtfs-ch` z14 1.5×, z7 1.0×; `drifters` z2 1.2×. _Fix:_ fuse only when `gap ≤ min(coalesceGap,
k × usefulSoFar + MIN_ADAPTIVE_COALESCE_GAP)`; `tile-batch-coalescing.test.ts:703-733` pins the
current plan and must be re-blessed.

**C4 [high] The overview pin is budgeted in directory bytes but fetched as ranges.** (CS-2) —
live + agent. The world × all-time z0–z1 slice is the most scattered selection an archive can
receive; the 2 MiB gap fuses it into one range: `goes-glm-lightning` fetches **22.2 MB to pin
0.64 MiB** (33×), dispatched at attach time _before_ the first viewport selection exists and
sharing the link and decoder pool with the first frame (live: 23.4 MB cold, 5 pack requests).
_Fix:_ budget on planned range bytes (a pure `planRangeBytes(ids)` on the archive, exposed via
`makeTilesetCallbacks`), and defer the overview kick until the first viewport load settles.

**C5 [high] The expected-value placeholder rule buys parents that land after the children they
stand in for, in the same priority batch.** (SEL-1) — repro. `placeholderWorthFetching`
(`:2720-2796`) fetches parent `u` iff `bytes(u)/θ < λ·A·min(C_missing/θ, 10 s)`; for `A > 16` this
admits a parent slower than all its children and is biased toward 3–4-level ancestors. Zürich z14
pitched: 1.79 MB of z10–z12 parents enqueued against 1.0 MB of primaries; the z10 lands at 212 ms
vs 92 ms for its own children and is dropped unseen. _Fix:_ require `arrivalMs < coverMs` before
the λ·A weighting; all three pinned EV cases keep their verdicts.

**C6 [medium] Directory leaf pages are fused with the 2 MiB tile gap.** (NS-5) — agent.
`nyc-taxi-paths` z14 cold start pulls 1.99 MB of directory where 0.78 MB is needed; pages are
dispatched in parallel so the fuse saves no round trip. _Fix:_ page-scale gap (adjacent-only) in
`fetchAndMergePages`.

**C7 [medium] Per-member fallback fans out every member (≤ 1024) in parallel outside both
concurrency caps.** (NS-3) — code. _Fix:_ route fallback members through `runGroupFetches`.

**C8 [low] Cold start buys the whole parent band under the flat 2 MiB rule.** (SEL-7) — agent.
4.4× the primary bytes at Zürich z14 while the throughput estimator is empty.

### D — Decode

**D1 [high] Every fleet zstd frame declares an 8 MiB window and no content size; fzstd
allocates + memmoves 8 MiB per tile.** — repro. Header scan: **4,000/4,000** frames in an
`earthquakes` pack and 4,000/4,000 in a `gtfs-ch` pack are `ss=0 fcf=0 window=8 MiB` (the Rust
writer uses `zstd::stream::encode_all` without a pledged size; level 19 ⇒ windowLog 23). fzstd
0.1.1 sizes its window from the header (`lib/index.js:104 new u8(ws + 12)`) and `copyWithin`s it
per block (`:739`). Measured on real frames: `earthquakes` 529 B → 4.5 KB tile 0.21–0.32 ms vs
0.017 ms with a synthesized single-segment header (**12.6×**); `gtfs-ch` 2.3×; `satellites` 4.6×;
`storm4d-volume` 2.8×; 69–92 % of in-worker decode time. The directory already gives the reader
the exact payload size (`expectedUncompressedSize`), used today only as a bomb cap.
_Fix (reader, no rebuild):_ in `compression.ts:unzstdSync`, when the header is `ss=0/fcf=0/df=0`
and `expectedSize` is known, synthesize a single-segment header carrying that size and hand the
rewritten frame to fzstd — byte-identical output verified on 400+ frames; a wrong size fails the
existing length check. _Fix (writer, rides the next republish):_ `set_pledged_src_size` /
`include_contentsize(true)`. Not a format change.

**D2 [medium] BH-7 (in flight) caps batches in COMPRESSED bytes and settles them as a unit.** —
agent. First-tile latency on `storm4d-volume` ≈ 8 × 23 ms = 184 ms (was 23 ms). Record for the
peer session: cap by expected _decoded_ bytes or by count × service-time EWMA, and settle members
as they finish.

**D3 [medium] The host decode queue is fully re-sorted on every pull.** (D4) — agent. 0.2–1.5 ms at
1,000 queued; up to ~30 % of a main-thread second during tiny-tile burst drains. A heap fixes it.

**D4 [low] Worker-side mid-flight cancel is unreachable by construction** (cancel trails the batch
in the worker's FIFO; tests pin it via a `FakeWorker` ACK the real worker never emits); the
CRC-32C byte loop runs ~160 MB/s (32 ms serial per 5 MiB tile); warm-path decodes carry no
priority; small archives pay 4 × 477 KB worker boots serialized behind the first pack bytes.
(D5–D9, CS-5.)

### E — Render-side consumption

**E1 [high] Every selected tile is a live draw call; only trip-heads culls by `tile.timeRange`.**
(LC-1) — code. `grep` over `packages/layers/src/layers` finds one consumer of `tile.timeRange`
(`animated-trip-heads-layer.ts:806-822`). Trail kinds widen the load window to `2 × trailLength`
and `tileLoadTimeWindow` demos widen it further; the forward half can never draw a trail vertex,
yet each tile is a sublayer with its own draw and vertex work. Measured on `storm-4d-isolines`:
the one layer that reports it skipped exactly 50 % of its resident-visible tiles; its siblings drew
all of theirs. This is direct frame time on the draw-call-bound surfaces (`/drive`, earthquakes)
and the headroom everywhere else. _Fix:_ generalize the trip-heads cull into each kind's
`renderLayers` with an O(1) wake check (`nextWakeMs`/`prevWakeMs`) on the unthrottled tick path;
do **not** narrow the selection window (prefetch and `no-overlap` rely on it).

**E2 [high] maplibre and Cesium drive `tileset.update()` every drawn frame, and the fast path
cannot fire while time advances.** (SEL-4 / LC-2) — code. The select key folds the raw
`timeRange.start/end` (`:2906-2912`), so during playback every frame is a full
`selectAndLoadTiles` — directory scans for the primary + 4 parent levels, `neededTileKeys`
rebuild, supersession, eviction sweep, queue processing. deck is protected only by its own
`window/20` + 100 ms throttle; three r3f by `STREAM_UPDATE_MS`. Measured: 5 directory scans per
update, ~3.5 ms/pass at 2.3k headers. _Fix:_ mirror deck's throttle in `base-layer.ts beginFrame`
and `attachCesiumClock`; correct the tileset comment at `:2856-2862`.

**E3 [high] `best-available` pass 2 keeps a parent over its loaded children whenever any in-box
primary cell has no tile in the archive.** (SEL-2) — repro. `getVisibleTiles` (`:5745-5762`)
counts an in-box cell as uncovered whether or not the directory has a tile there. Re-executed:
3 of 4 children loaded + the fourth cell empty → the z10 parent is delivered alongside all three
children, forever, on a still camera. The flow-riders campaign's double-draw was worked around in
demo config (`no-overlap` on overlays); the core mechanism is untouched for every primary layer
(water, night-time transit, sparse events). `parent-fallback-clamp.test.ts` pins only the 4-of-4
case. _Fix:_ treat an in-box cell as uncovered only if the directory says a tile exists there and
it is pending; keep the any-cell rule only for archives declaring a sparse partition.

**E4 [medium] `tier:'auto'` under `best-available` hands raw sublayers SUMMARY-variant tiles as
parent fallbacks.** (SEL-3 / F7) — repro. At `summary.maxZoom + 1 … + 4` every parent level lies
in the summary range; H3/Quadbin centroid cells with `count` columns are delivered to the raw
point layer as features (and persist under E3). No hysteresis at the tier edge. Live on the
lightning overlays at z4.2 → z5. _Fix:_ keep only parent levels whose tier equals the primary's.

**E5 [medium] three `StreamingTileSource` republishes synchronously on every `onTileLoad` and
every `update()` with a replace-all `setTiles`** — O(N·M) on arrival bursts, no `onTileUnload`.
(LC-3.) Cesium's shipped consumer is O(features) per frame + replace-all rebuilds (LC-6).

**E6 [medium] The scrubber hover preview is a second full render stack** — second archive +
tileset per layer with the live cache caps and request budget, equal scheduler weight, byte cache
keyed per instance so nothing is shared, and it plans the **live** speed-scaled prefetch from a
frozen clock: ~165 MB per hover position on `satellites`, 58 MB on `nyc-taxi-paths`. Opt-in.
(LC-4 / F6.)

**E7 [medium] Tile-arrival work (prepare + tessellation + attribute upload) runs synchronously for
the whole rAF-coalesced batch in one frame** — hitch size scales with tiles-per-batch. Not
reproduced in the bounded probe; a per-rAF commit budget is the fix. (LC-5.)

### F — Small archives, cold start, config surface

**F1 [medium] No whole-archive-resident short-circuit; `plan()` bypasses its throttle exactly when
the pipeline is idle.** (CS-4) — code. A fully resident archive re-runs the directory slice + sort
every 250 ms while playing; the grace sweep visits every pinned header at 10 Hz (8.9k–17.9k visits
per pass on the A1 demos). Small archives measure sub-millisecond per pass — the cost is
microtask churn, not CPU. _Fix:_ when a pass enqueued nothing and every candidate was resident,
throttle on `lastPlannedEndTime` regardless of `pipelineIdle`; keep pinned headers in their own
map.

**F2 [medium] The z0–z1 world × all-time enumeration is paid on every low-`minZoom` cold start,
before the first viewport's leaf pages, even when the tier is then rejected.** (CS-3) — agent.

**F3 [medium] `gtfs-ch` (rebuilt 2026-08-23) first frame is 13.2 MB at midday for a 20 s window
with nothing coarser drawable** (13.5 MB z6 parent skipped, no overview); measurements-2026-08 §9's
`gtfs-ch` row describes the retired ~11× smaller archive. (CS-6.) `animal-migration`: z0 tiles are
not bucket-sliced, so any one-day window pulls 139 tiles / 37.8 MB ⇒ ≥ 9.5 s at 4 MB/s, past the
8 s hatch; the `zoomOverride: 0` comment is false; live fps 35 with zero loader churn — it is
render-bound (10.6 M features at z0). (F9.)

**F4 [medium] Derived playback params are unsafe to adopt** — `DEFAULT_TIME_WINDOW_BUCKETS = 24`
over-selects 12–4,320× on 11 of the 12 large demos (gtfs-ch: a 24 h window ≈ 540 MB resident) and
`suggested_playback_seconds` is a constant 20 on 31/32 hinted archives. Zero demos consume derived
values today. (F4.)

**F5 [medium] `nwm-rivers-2019` is `blobOrdering: hilbert3`** while the docs mandate time-major and
the reconcile check only rejects the literal `'spatial'`. (F5.) `/atlas` `baseSpeed` looks 1,000×
off (`ms_per_token × tokensPerSecond` vs TimeController speed 1.0 = real time) — local-only,
verify in browser. (F12.)

**F6 [low]** Directory pages are never evicted (276 MB heap for a fully-paged `gtfs-ch`, 518 B/entry;
NS-8) · per-archive throughput estimators are read as the aggregate link rate in composites and the
showcase wires no `getThroughput` (NS-10 / G5 — the M5/CO-3 fluid predictor and CO-4 ladder are
therefore inert in every shipped consumer, while the conformance record counts them 7/7 landed) ·
`notifyBufferChange` → `refreshFrontier` is unthrottled, O(N²) runway walks/s in composites (G6) ·
embed autoplay can `requestPlay` before any source registers (G8 / CS-9) · the terrain map path
defaults `maxPitch ?? 85` (F10, latent).

### G — Tests and observability

**G1 [high] There is no regression gate on any loading or QoE metric.** (TO-1) —
`policy-replay.mjs` is deterministic but re-implements `evictUnusedTiles` in JS and never imports
the tileset or governor; CI's only browser gate is "12 demos non-blank after 8 s"; Actions has never
run (README T2). Every one of A1–A3, B1–B5 shipped green.

**G2 [medium] No always-on network counters.** (TO-3) — `bytesRequested` / `bytesUseful` /
request counts exist nowhere in `packages/` or `examples/`; only the probe-gated `requests`
channel (range size, not members' useful bytes) and an unconsumed `dispatchedBytesBySource`. The
HUD shows no bytes, requests, stalls, evictions or decode wait. This is the T2 item from the
blob-ordering analysis, still open.

**G3 [medium] Invariants with no test** (TO-5): no double fetch across priority+prefetch; memory
bound under a runway larger than the cache; loop-wrap continuity; clock ≤ frontier as a timeline
property; evicted tile's GPU resources released; worker transfer is zero-copy (all decoder tests
use `FakeWorker`; `tile-decoder.worker.ts` is executed by no test); a 404 pack does not hold the
clock; single-bucket archive plays without gating; cold-start round-trip count. Smallest
deterministic test for each is sketched in the evidence appendix.

**G4 [low] Vacuous or wrong-pinning tests** — `overview-preload.test.ts:173` (asserts the A1 churn),
`scheduler-group-priority.test.ts:211-222` (pins the B3 inversion), `playback-governor.test.ts:2805`
(mock ignores `horizonSimMs`), `paged-scheduler-supersede.test.ts:362-406` and nine call sites use a
`configureSharedScheduler({enabled:false})` kill-switch that **does not exist** (the function
accepts only `maxRequests`; `docs/api/playback-governor.md` and `playback-and-loading.md` document
it), `mixed-zoom-cover.test.ts` "records how bad" bands (≤ 200 cameras / ≤ 2.5× overdraw) would pass
if the defect grew to those bands, `tile-decoder.test.ts:565,:591` cancel-ACK the real worker cannot
emit, `prefetch-runway.test.ts:698` installs its clock spy after the policy captured `Date.now`.
13 of 15 layer files build probe payloads and call `performance.now()` per resident tile per
`renderLayers` pass with the probe off (TO-2).

---

## 3. Verified correct — do not re-audit

Consolidated from the ten reports (≈ 180 items in the appendix); the ones a future reader is most
likely to re-suspect:

- Viewport bounds at pitch/bearing (`viewport-bounds.ts`, `viewport.getBounds()` on deck, the
  432-camera matrix), zoom clamp into `[minZoom, maxZoom]` (storm4d-sounding z9 → z6, nyc-taxi z2 →
  z10 — the "camera below `minZoom` selects nothing" worry is refuted), `MAX_QUERY_SCAN_CELLS`
  warns without truncating, selection generation guard, spatial flush tolerance, `tile-key.ts`
  variant/bucket folding.
- `getVisibleTiles` DP cover (antichain, ≥ capped greedy, deterministic), descendants-before-
  ancestors, atomic parent→child handoff (no frame draws both or neither on the 4-of-4 path),
  `tile-budget.ts` descent/hysteresis (inert on the fleet: no demo exceeds pitch 70).
- Prefetch: supersession is tier-aware and batch-wise, slicing is byte-budgeted and nearest-first,
  no duplicate dispatch when the head enters an in-flight slice (though it is not promoted, PR-8),
  direction hysteresis, seek detection, debounce, dead-header revival, byte currency, cost oracles,
  sparse/outside-bounds/single-bucket runway semantics, CO-7 sound.
- Eviction: accounting symmetric with in-flight protection; per-pass cost negligible (p95 0.84 ms at
  20k headers; 0.05 ms for a 4-tile archive); all three backends release evicted tiles within one
  frame; `estimateTileSize` is an honest decoded estimate.
- Governor: nothing on its path is O(resident tiles); ≈ 50 bounded runway walks/s on gtfs-ch; the
  200 ms probe, frontier hold semantics, scrub bracket, multi-source min-gate over required sources
  only, `getAutoSpeedSuggestion` Infinity/null contracts, small-archive behaviour (never gates once
  resident).
- Network: 3–5 round trips to first frame across the fleet (re-measured today: earthquakes-v2 5 req
  / 349 KiB), root-only paged directory fetch, page dedup, coverage query costs zero extra leaf
  bytes, live CDN is h2/h3 with CORS `*` and `Content-Range` exposed (range validation is live),
  one scheduler slot = one request (correct under h2; the local dev server is HTTP/1.1, a caveat on
  every localhost number), a 16 MiB slice holds one slot and cannot block dispatch.
- Decode: zero-copy transfer with buffer dedup (the only pre-transfer copy is the host `slice(0)`
  of compressed bytes), cancel-before-dispatch, no zombie inserts, crash isolation, pool bounds
  `[1, cores−1]`, decode priority = fetch-stage EDF, fetch slot held until member decodes settle
  (bounded in-flight decode memory), CRC/bomb gates, earcut backfill in the worker, layer
  `prepareTile` once per (tile, styleKey).
- Render side: tick path is redraw-only, style-key/`PropEffects` invalidation, delta uniform push,
  picking, maplibre visible-vs-resident set + GPU sweep, features drawn once per bucket, the
  preview never prefetches.
- Showcase: the `÷60/÷30` fallback is inert for all 142 demos; runway horizon formula and effective-
  window chain; interleaved `MapboxOverlay` cadence unchanged; `tier` inert without a summary tier;
  the neural-atlas `spatial` archives are single-bucket and harmless; storm4d-sounding is in frame.

## 4. Doc ↔ code drift (consolidated)

- `optimization-conformance-2026-08.md:28` "FS-1…FS-3 3/3" vs six `it.fails('PENDING FS-3 REPAIR')`;
  `tile-loading-3d-2026-07.md:290,347` "Wave 3 NOT built" vs FS-1/FS-2 landed 2026-08-11 (behind a
  default-off `selectionMode`, enabled nowhere, not wired for non-deck backends). Stale in opposite
  directions. Same doc counts M5/CO-3/CO-4 as landed; no consumer wires them.
- `spatiotemporal-tileset.ts:2857-2862` "a tick that hasn't crossed a bucket boundary is the
  common case" for the select-key fast path — the key folds the exact `timeRange`; only an
  identical time hits it. `maplibre/base-layer.ts:1385` relies on the same false premise.
- `spatiotemporal-tileset.ts:253` "higher numbers don't add load pressure (each lower zoom has 4×
  fewer cells)" — bytes per bucket are ~flat across zooms in a replicated archive (gtfs-ch z6
  7.0 MB … z14 12.9 MB per bucket); `:5561` "zDiff ≤ 2" — the band is 4 levels; `:216-225` the λ
  fit note's example is not reproducible from the rule as written.
- `tile-budget.ts:88` "engages on the four `maxPitch: 85` volumetric demos" — no demo declares
  `maxPitch > 70`. `tile-loading-3d §4.4` "`maxParentTileBytes` 2 MiB against a ~42 KB average tile
  bounds the downside" — default policy is now `expected-value` and fleet parents average 631 KB–
  1.35 MB at gtfs-ch z7/z6.
- `playback-and-loading.md §6.2` and the `PREFETCH_CACHE_FRACTION` comment claim the ladder /
  fraction "keeps the runway resident" — neither can at fast playback (A2). `docs/api/playback-
governor.md` + `playback-and-loading.md` document a `configureSharedScheduler({enabled:false})`
  kill-switch that does not exist. `archive.ts:737-745` "prefetch always ranks below need-now
  globally" — false under DRR arrears (B4). `archive.ts:765` calls the 20 s deadline a "stall
  timeout".
- `archive.ts:771` "selection re-runs at display refresh, not 10 Hz" — true for maplibre, false for
  deck. The overview docblock's "budget keeps the pinned contribution small / never starved" — A1,
  C4. `SpatioTemporalLayer` prop doc "extra resident tiles are cheap" — E1.
- `measurements-2026-08.md §9` gtfs-ch row is the retired archive; §5 "windows match" holds only for
  the two demos it measured; §8.4 R1 and the bench README "standing blocker" describe a v2/v3 skew
  that is resolved (reader accepts 2..3, local + deployed fleet v3, cold-start harness runs today).
- `how/DecodePipeline.tsx` pool size / least-pending / "OPFS skips workers" / "cancelled mid-pool"
  — none match the code; `optimization-implementation-plan-2026-08.md:426` names BH-7 "loop-aware
  eviction rotation" while the tree uses BH-7 for decode batching (ID collision);
  `compression.ts:60-65` "performance-neutral streaming" — D1.
- `datasets.ts` `animal-migration` "single z0 tile per bucket" — 139 tiles per one-day window;
  `demos-and-datasets.md` claims the time-major build path landed for `nwm-rivers-2019` (hilbert3
  in the tree); README B4 body vs its discharge commit; `index.mjs` "no worker pool";
  `policy-record.mjs` "no package publishes `tileset.viewport`"; `tile-decoder.ts:12-14` inline
  timing range (measured 0.46–1.3 ms typical, 23 ms storm4d-volume).

## 5. The uncommitted CO-7 change — assessed

`prefetchFutureTiles` now warms the primary zoom only (parents excluded except under
`lodMode:'additive'`). Sound: it aligns prefetch with the primary-only runway, is fine under
`no-overlap`, summary tiers and a camera clamped past `maxZoom` (there "primary" _is_ the coarse
level and is still warmed), and breaks no test. Two notes: (1) its sparse-archive fallback claim
holds only while the throughput estimator is cold — once warm, `placeholderWorthFetching` prices a
childless parent at `coverMs = 0` and skips it on the priority path too (PR-6, CO-6 gate), which is
the conservative outcome the comment wants anyway; (2) because parents are never pre-warmed, every
bucket edge on a `best-available` primary re-runs the EV rule with the new bucket's children
missing — which is exactly where C5 bites. Land CO-7; land C5 with it.

## 6. Plan — five waves, ordered by what unblocks what

Each item names its blast radius and the test that fails today. Nothing here changes the packed
format, thins data, or touches the byte layout; D1's writer half rides the next republish as a
plain zstd option.

**Wave 1 — stop the loops (2 days, all in `packages/core`, no config change).**
A1 count-gate the pin + exclude pins from the size test + `pinnedCount` · A2 residency-bounded
prefetch budget + bendable `gateFloor` · A3 eviction on delivery when over cap · B3 EDF containing-
interval · B4 tier-gated DRR admission · C1 progress watchdog + skip-to-split · C5 `arrivalMs <
coverMs`. Acceptance: the §1 table re-run shows `runwayEvictions = 0` and `pressure = 1.0` on all
five rows, `nyc-taxi-paths` play bytes ≤ 2× useful; the four "warns then proceeds" demos no longer
print the pin warning; the A2/B4/C1 proof scripts become vitest cases and go green.

**Wave 2 — continuity (2 days, core + layers chassis).**
B1 tile-box coverage-index key · B2 trailing seek update in the chassis · B5 loop-aware prefetch
plan + non-flushing wrap · B6 re-probe before clamp · B8 permanent-4xx classification · E3 in-box-
empty cells are not "uncovered" · E4 tier-consistent parents. Acceptance: experiment B and the
G1 fake-timer test green; `/drive` and `ocean-drifters` play 60 s with zero `buffering` gates while
the camera moves; a lap boundary on `flights` shows no `seeking` gate; `getVisibleTiles` never
returns a parent whose block has zero pending cells.

**Wave 3 — bytes and decode (2–3 days).**
D1 reader header rewrite (measure `decompressMs` p50 on `/demo/earthquake-activity` before/after;
expect ≥ 5×) · C2 intra-group streaming (rides C1) · C3 amplification-bounded fuse · C4 planned-
bytes overview budget + deferred kick · C6 page-scale directory gap · C7 fallback through the
scheduler · D3 heap for the host queue · A5 `categoriesRef` token (coordinate with BH-7; record D2
for it). Acceptance: `goes-glm-lightning` cold ≤ 2 MB; `earthquakes` z10 bucket ≤ 10 requests
< 100 KB; `nyc-taxi-paths` z14 cold directory ≤ Σ needed leaves + one.

**Wave 4 — memory and render side (3 days).**
A4 process-wide decoded-byte budget from `deviceMemory`, count cap demoted to a sanity ceiling,
composite arithmetic deleted · A6 byte cache off by default · E1 generalized `timeRange` cull +
wake · E2 throttle in maplibre/cesium + comment fix · E5 coalesced three publish · E7 per-rAF
commit budget · E6 preview-tuned props (`no-overlap`, small caps, low weight, no live-speed
prefetch) · F1 idle-pipeline throttle + separate pinned map. Acceptance: heap snapshot on
`/demo/gtfs-ch` at 2,000 resident counts one `categories` array per hoisted column; `frame-cost.mjs`
draws/frame on `storm-4d-isolines` and `nyc-taxi-paths` drop by the dead fractions with identical
pixels; a 5-archive composite on a `deviceMemory: 4` profile stays under 1 GiB decoded.

**Wave 5 — make it stay fixed (2 days).**
G1 a real-object loading QoE gate: drive `SpatioTemporalTileset` + `PlaybackGovernor` with
`attachExternalClock` over a recorded `PackedFetchLog` for three shapes (small / long-sparse /
fast-fine) and assert stall count, runway evictions, refetched ids, bytes ≤ k × useful, clock ≤
frontier, memory ≤ cap · G2 always-on counters (`requests`, `bytesRequested`, `bytesUseful`,
`stalls`, `evictionsByTier`, `decodeWaitP95`) in `getCacheStats()`/`getQoeStats()` and on the HUD ·
G3 the nine missing invariant tests · G4 re-bless or delete the vacuous ones and remove the dead
`enabled` flag from nine call sites and two docs · F5 reconcile gate: horizon feasibility +
ordering ≠ time-major is an error · config: `targetPlaybackSeconds` on the four A2 demos, bytes-not-
count composite splits, `tier:'raw'` on the lightning overlays, fix the `animal-migration` comment.

Deferred, with the reason: frustum selection (SEL-5 — built, dormant, FS-3 pending; enable after
Wave 2 so its tests stop being `it.fails`), OPFS (A7 — no consumer), Cesium consumer rewrite (E5b
— not a shipped player surface), derived-params adoption (F4 — the resolver defaults must change
first), directory page eviction (F6 — 276 MB only on a fully-paged world view).

## 7. Live probe evidence (all 21 demos)

10 s of playback after an 8 s settle + 6 s start-gate discard; `tools/render-test/probe-flow-
riders.mjs` with `STT_URL`/`STT_ARCHIVES`; local dev server (HTTP/1.1); ANGLE/Metal; 1440×900.
`simAdv` = sim-hours the clock advanced in the 10 s window; `resMB` = decoded bytes resident;
`pinned` = overview tiles actually pinned (0 = not attempted, rejected over-budget, or no tiles);
`dqP95` = decode queue wait p95 ms. Composite rows report the last-written tileset's stats and
their "re-decode" counts include cross-archive key collisions (the decode channel key omits the
archive id) — only single-archive re-decode counts are meaningful.

| demo                | fps | p95 ms |   simAdv | play MB | play req | decodes | re-dec |  evict | runway ev | press | headers | res MB | pinned | dqP95 |
| ------------------- | --: | -----: | -------: | ------: | -------: | ------: | -----: | -----: | --------: | ----: | ------: | -----: | -----: | ----: |
| animal-migration    |  35 |   58.4 |  1475.7h |    33.2 |       62 |      81 |      0 |      0 |         0 |  1.00 |     185 |    141 |      0 |   214 |
| bixi-flowmap        | 120 |    9.2 |    83.3h |     0.0 |        0 |       0 |      0 |      0 |         0 |  1.00 |       9 |      6 |      0 |    67 |
| bixi-live (3)       | 120 |    9.0 |     0.4h |     0.3 |        3 |      13 |      0 |      0 |         0 |  1.00 |     101 |     28 |      0 |   709 |
| earthquake-activity |  52 |   33.4 |  5700.2h |    12.8 |       85 |   4096+ |  2624+ |  8,023 |     8,023 |  0.25 |   9,655 |     42 |  8,927 |  1359 |
| earthquake-columns  | 110 |   16.7 |  7454.2h |     5.5 |      207 |   4096+ |  3733+ |  8,133 |     7,940 |  0.25 |   9,114 |     41 |  8,927 |    19 |
| flights             | 115 |    9.3 |     4.0h |    39.0 |        8 |      41 |      0 |      0 |         0 |  1.00 |     171 |    217 |      0 |   577 |
| goes-glm-lightning  | 120 |    9.8 |     4.9h |     3.2 |       40 |     101 |      0 |      0 |         0 |  1.00 |     922 |      2 |    570 |    96 |
| gtfs-ch             | 120 |    9.0 |     0.4h |     0.0 |        2 |       0 |      0 |      0 |         0 |  1.00 |      11 |      1 |      0 |    26 |
| gtfs-nl             | 120 |    9.0 |     0.4h |     0.1 |        1 |       2 |      0 |      0 |         0 |  1.00 |       6 |      1 |      0 |     0 |
| hrrr-wind (2)       | 120 |    9.7 |     4.9h |     3.2 |        4 |      16 |      0 |      0 |         0 |  1.00 |      96 |     25 |      0 |    87 |
| hurricanes          |  67 |   58.3 |  4178.3h |    11.4 |      179 |   3,732 |    453 |  4,580 |     4,249 |  0.25 |  20,863 |     25 | 17,899 |  4168 |
| mrms-precip (3)     | 120 |    9.5 |     4.8h |    12.7 |      147 |     294 |  (123) |      0 |         0 |  1.00 |     326 |      1 |      0 |   131 |
| nyc-flow-and-riders | 117 |    9.9 |     0.5h |    35.1 |       60 |     260 |      0 |      0 |         0 |  1.00 |     651 |    124 |      0 |  1041 |
| nyc-rideshare       | 120 |    9.0 |     0.5h |     0.1 |        2 |       0 |      0 |      0 |         0 |  1.00 |      23 |      0 |      0 |    23 |
| nyc-taxi-paths      |  84 |   33.2 |     6.8h |   718.8 |       49 |   4096+ |      0 |  9,509 |         0 |  1.00 |   3,000 |    114 |      0 |   775 |
| ocean-drifters      | 120 |    9.0 | 32185.4h |     1.9 |       34 |     179 |      0 |      0 |         0 |  1.00 |     411 |      6 |      0 |    30 |
| rain-flood-2019 (2) | 109 |   16.7 |   473.0h |    63.2 |      176 |   4096+ |  2931+ | 27,111 |    25,557 |  0.25 |   4,914 |    408 |  4,380 |   120 |
| satellites          | 120 |    9.0 |     4.0h |   100.0 |       62 |      48 |      0 |      0 |         0 |  1.00 |     141 |    641 |      0 |   226 |
| ship-traffic        | 120 |    9.2 |     4.0h |     7.0 |       13 |      36 |      0 |      0 |         0 |  1.00 |     164 |    101 |      0 |   782 |
| storm-radar (3)     | 119 |    9.2 |     0.8h |     2.7 |       39 |      76 |   (32) |      0 |         0 |  1.00 |      98 |      0 |      0 |  1444 |
| wildfires           | 120 |    9.3 |  5135.4h |     3.8 |       13 |       9 |      0 |      0 |         0 |  1.00 |      62 |      5 |      0 |    61 |

Other live readings used above: `archive.stats` (compressed byte cache) hit rate 0 % on every
healthy row; `earthquake-activity` also logs nine `deck: initialization of ScatterplotLayer(...
1/0/0/<t>...)` assertion failures per 10 s alongside `bufferSubData: no buffer` warnings — z1
overview-tier sublayers initialising against tiles the A1 churn is evicting underneath them; not
root-caused here, expected to vanish with A1, re-check after. Overview rejections (over-budget) seen
on `flights` (48 tiles / 142 MB decoded-equivalent), `ship-traffic`, `satellites` (1,440 / 808 MB),
`ocean-drifters` (10,718 / 953 MB), `animals` (1,829 / 222 MB), `hrrr-wind`, `mrms-precip` — the byte
gate works; the count gate is the missing half.

## 8. Method, caveats, reusable pieces

- Ten auditors, each given the same brief (`brief-common.md` in the evidence appendix), the
  architecture map, the known-and-fixed list (so nothing already closed was re-reported), and the
  instruction to refute before reporting. ~3.3 M tokens; ~4 h wall.
- Consolidator re-verification: A1 (code + live + the pin warning in console), A3, A4, A5, B2, B3,
  B5, C1, E1, E2, F6/G5, G4 (code); E3, B1, B4, C5, D1 (the proof scripts re-executed against the
  real classes: `selproof/selection.test.ts` 7/7, `proof-runway.mts`, `drr-arrears3.mjs`,
  `scan-zstd-headers.mjs` + fzstd source); A2/C4 (live corroboration). Not independently re-run:
  C3, C6–C8, D2–D4, E4–E7, F2–F5, B6–B7, and all `agent`-tagged magnitudes.
- Caveats: the dev server is HTTP/1.1 (6 connections/host — request-count and latency numbers are
  pessimistic vs the h2 CDN); the `decode` probe channel caps at 4,096 samples; composite
  `tileset.stats` snapshots are last-writer-wins; `gtfs-ch` was probed at its shipped national
  camera only (cheap by construction — the Zürich z14 numbers are directory-derived);
  `ocean-drifters` was probed in its sparse 1979 opening (0.19 MB/s), not the dense decades the
  directory average implies (up to ~8 MB/s); no browser measurement was taken on a throttled link
  (C1's 4 Mbit/s consequence is arithmetic).
- Reusable: `tools/render-test/probe-flow-riders.mjs` is archive-agnostic (`STT_URL`,
  `STT_ARCHIVES`, `STT_SAMPLE_MS`); the summariser and the per-demo `.out` JSONs are in the session
  scratchpad; the scratch proofs are described with their assertions in each report's "How to
  verify" so they can be re-authored as tests without the scratchpad.

---

## 9. Implementation record (2026-08-24, same day)

Every wave in §6 was implemented the same day by nine file-owner implementers working in one tree
(disjoint file sets, each fix landed test-first with a run that failed before the change), one
integration pass for the cross-package wiring, and a real-object QoE gate. Nothing changed the
packed format, the byte layout, or thinned data. Two things ran alongside and are not part of this
record: the peer session's BH-7 decode batching (now capped by worker-side service time, D2 closed
with both tables in its docstring) and the CO-7 primary-zoom prefetch (landed as assessed in §5).

### 9.1 What landed, by finding

| id     | change (file · symbol)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | pinned by                                                                                                                                                        | before → after (the test's own numbers)                                                                 |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A1     | `startOverviewPreload` count gate (`PIN_COUNT_FRACTION` 0.25, reason `over-count`, `preloadOverviewTier({maxTiles})`); `evictUnusedTiles` / `setOptions` size test is `loaded − pinnedLoaded > maxCacheSize`; `pinnedCount`/`pinnedBytes` on `getCacheStats()`                                                                                                                                                                                                                                                                                                                                                              | `overview-preload.test.ts` A1 ×3 + pin-thrash port; `:173` re-blessed                                                                                            | 159 runway evictions / 20 steps → 0                                                                     |
| A2     | `prefetchFutureTiles` charges resident/in-flight/queued headers inside the horizon to the pass budget (residency bound); `PrefetchPolicy.plan` bends `gateFloor` to `min(speed×5 s, residencyCapacitySimMs)` from `keysPerBucket`; window terms never bend                                                                                                                                                                                                                                                                                                                                                                  | `prefetch-runway.test.ts` A2 (proof-runway-a2 port), `prefetch-policy.test.ts` A2 ×5; two pins re-blessed                                                        | 195 refetched / 555 runway evictions → 0 / 0, pressure 1.0                                              |
| A3     | `scheduleOverLimitEviction` — 16 ms-coalesced tiered pass from both delivery paths when over cap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `eviction-playhead-tiers.test.ts` A3                                                                                                                             | 65 KB against a 20 KB cap with no `update()` → trimmed                                                  |
| A4     | `memory-budget.ts` `DecodedMemoryBudget` singleton (device tiers 384 MiB / 768 MiB / 1.5 GiB, 1 GiB unknown, mobile UA 384 MiB); tileset registers/unregisters, `effectiveMaxCacheBytes = min(maxCacheByteSize, max(share, limit − Σ others))`; `maxCacheSize` default 2,000 → 20,000                                                                                                                                                                                                                                                                                                                                       | `memory-budget.test.ts` ×6, `tileset-audit-2026-08.test.ts` A4 ×2                                                                                                | two 2 GiB tilesets under 256 MiB: 576 MiB → 192 MiB; 5,000 × 3 KB tiles: evicted by count → 0 evictions |
| A5     | **not landed** — the worker message shape is owned by the in-flight BH-7 change; the `categoriesRef` token rides its next pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —                                                                                                                                                                | —                                                                                                       |
| A6     | `clearCache()` unregisters shared-LRU entries; `maxCacheTiles: 0` stores and copies nothing; default unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `archive-audit-2026-08.test.ts` A6 ×2                                                                                                                            | leak → 0 bytes after clear                                                                              |
| B1     | coverage index keyed on the primary-zoom **tile box** (`coverageTileBoxKey`), seam-aware; ⅛-span rule kept only for the prefetch flush                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `buffered-runway.test.ts` B1 (experiment-B port); `selection-hardening.test.ts:38` re-blessed (it pinned the defect)                                             | runway 14,900 → 0 over 40 steps → min ≥ 4 s, one rebuild                                                |
| B2     | chassis `_handleTimeUpdate` arms one trailing `_scheduleSeekSettle(wallRemaining)` when the wall throttle blocks; paused-clock repeats are not swallowed                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `chassis-seek-throttle.test.ts` ×5                                                                                                                               | second `tileset.update` never arrived → within 100 ms                                                   |
| B3     | archive EDF: containing interval = distance 0, passed = `timeEnd < t`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `scheduler-group-priority.test.ts:211` re-blessed + backward case                                                                                                | `[3000,…]` → `[2000, 3000, 4000, 1000]`                                                                 |
| B4     | `request-scheduler.ts` `urgentTierContenders()` — DRR admission runs only among the most urgent tier present                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `request-scheduler.test.ts` B4 ×2 (drr-arrears3 port); 41 recorded-order pins unchanged                                                                          | 173 optional prefetch groups before need-now → 0                                                        |
| B5     | `PrefetchPolicy.plan` wraps the horizon modulo the loop (`wrapQueryRange`, loop-modular `aheadDistance`); tileset `update()` treats an end→start jump within a bucket as a continuation (no flush / flip / generation bump); governor `wrapHandler` no longer flushes loop-aware sources                                                                                                                                                                                                                                                                                                                                    | `tileset-audit-2026-08.test.ts` B5 fwd/back, `prefetch-policy.test.ts` B5, `playback-governor.test.ts` B5                                                        | warmed `[]` → `[0,1000,2000,3000]` before the wrap; no key fetched twice                                |
| B6     | governor `reprobeFrontierFrom` — a crossing outside creep re-probes the required fold **at the cached frontier** before snapping/gating                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `playback-governor.test.ts` B6 ×3                                                                                                                                | spurious snap `100000 → 100400` → stays `playing`                                                       |
| B7     | derived BH-4 band applies only while the leader is inside the requested probe horizon (`leadCapped`); capped leader → 200 ms wall default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | vacuous `:2805` replaced; `:2837`, `:2876`, `:2964` re-vectored; storm-4d vector added                                                                           | laggard at 0 masked → `buffering`                                                                       |
| B8     | archive `PermanentFetchError` (403/404/410, no retry, no fan-out) delivered per member via `onTileError`; tileset `writeOffPermanently` (`retryAfter = ∞`), `BufferedRunway.blockedPermanently`; governor folds it as buffered and counts it                                                                                                                                                                                                                                                                                                                                                                                | `archive-audit-2026-08.test.ts` B8 ×2, `buffered-runway.test.ts` B8, `playback-governor.test.ts` B8 ×2                                                           | 7 requests per 404 group → 1                                                                            |
| C1+C2  | `readBodyWithWatchdog` streams the body and re-arms the 20 s watchdog per chunk; `fetchGroup` delivers/decodes each member as its extent completes; timeout on a multi-member group skips the identical retries and splits; failed attempts no longer feed the throughput EWMA (`getTransferFailureStats`)                                                                                                                                                                                                                                                                                                                  | `archive-audit-2026-08.test.ts` C1 ×4, C2; hardening test re-blessed                                                                                             | slow-but-progressing 1 MB body: `TimeoutError` → resolves; member 0 delivered before the last chunk     |
| C3     | `planCoalescedRanges` — fuse iff `gap ≤ min(G, 4 × usefulSoFar + 256 KiB)` (`COALESCE_AMPLIFICATION_K`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `archive-audit-2026-08.test.ts` C3 ×2; fleet-shaped coalescing pin re-blessed (3 → 6 ranges)                                                                     | 10 × 500 B tiles 1 MiB apart: one ~9 MiB request → 10 requests < 100 KB                                 |
| C4     | archive `planRangeBytes(ids)` → adapter `estimateFetchBytes` → `startOverviewPreload` budgets on **planned range bytes** (`plannedBytes`); chassis kicks the overview after the first viewport load, not at attach                                                                                                                                                                                                                                                                                                                                                                                                          | `overview-preload.test.ts` C4 ×3, `chassis-lifecycle.test.ts` C4 ×3, `tileset-adapter.test.ts` ×5                                                                | 0.5 MiB directory / 25 MiB planned: pinned → rejected                                                   |
| C5     | `placeholderWorthFetching`: `arrivalMs ≥ missingMs → false` before the λ·A weighting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `prefetch-runway.test.ts` C5 (Q3 port); 3 EV cases unchanged                                                                                                     | z10 at 212 ms vs 200 ms of children bought → not bought                                                 |
| C6     | `fetchAndMergePages` fuses leaves at `2 × median leaf length`, capped by an explicit `coalesceGapBytes`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `archive-audit-2026-08.test.ts` C6                                                                                                                               | one fused request → 2, bytes = Σ needed                                                                 |
| C7     | fallback members run as one-member groups through `runGroupFetches`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `archive-audit-2026-08.test.ts` C7                                                                                                                               | 40 in flight → ≤ `maxConcurrentRequests`                                                                |
| D1     | `compression.ts` `synthesizeSingleSegmentFrame` — rewrites `ss=0/fcf=0/df=0` frames to single-segment with FCS = `expectedSize + 1` (fzstd silently **clamps** an under-declared FCS, so the +1 lets the existing length check catch a wrong directory); falls back once; `zstdHeaderRewriteStats`                                                                                                                                                                                                                                                                                                                          | `compression-frame-header.test.ts` (real fleet frames, byte-identical, ≥ 3× timing); peer's `decode-length-contract.test.ts` pins the +1 ↔ exact-length coupling | Node µs/frame: earthquakes 203 → 17, gtfs-ch 409 → 80, satellites 4,263 → 877                           |
| D3     | **not landed** (host decode queue heap) — decoder file owned by BH-7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                                                                                                                                                | —                                                                                                       |
| E1     | chassis `cullTilesByTimeRange` + `getRenderReach` with `nextWakeMs`/`prevWakeMs`; nine kinds iterate `liveTiles` (splat, CPU-track kinds, cumulative point and the summary kinds deliberately not culled — each reason recorded in the report)                                                                                                                                                                                                                                                                                                                                                                              | `chassis-driver.test.ts` E1 ×4 across all kinds                                                                                                                  | 3 sublayers → 1; wake → 2                                                                               |
| E2     | maplibre `TilesetUpdateThrottle` + trailing pass in `beginFrame`; cesium `createThrottledTilesetUpdate` helper (README recipe + showcase wired)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | maplibre throttle test ×5, cesium ×7                                                                                                                             | 60 `update`/s → ≤ 11                                                                                    |
| E3     | pass 2 keeps a parent only for a **pending** in-box cell (or `sparsePrimary`, wired from `metadata.partition === 'home-zoom'`); cut-path stand-ins judged per node (`selectionCutKeys`) — which repaired FS-3: five `it.fails('PENDING FS-3 REPAIR')` pins flipped to `it`                                                                                                                                                                                                                                                                                                                                                  | `parent-fallback-clamp.test.ts` E3 ×3, `mixed-zoom-cover.test.ts`                                                                                                | 3-of-4 children: parent delivered → dropped; O5 cameras `doubleCovers === 0`                            |
| E4     | `getZoomLevelsToLoad` keeps only parent zooms whose tier equals the primary's                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `summary-tier-dispatch.test.ts` E4                                                                                                                               | summary parents `[4,3,2,1]` under a raw z5 → `[]`                                                       |
| E5     | three `StreamingTileSource` microtask-coalesced publish + frame-number gate + `onTileUnload`; nine layers build their material once (no dispose per `setTiles`); bounding-box layer skips repeated times, uploads only the touched range, no per-frame `computeBoundingSphere`                                                                                                                                                                                                                                                                                                                                              | three streaming ×6, `layer-gpu-churn-audit-2026-08.test.ts` ×9                                                                                                   | 50 arrivals → 50 publishes → 1                                                                          |
| E6     | showcase `previewTileProps.ts` applied via `Layer.clone` (`no-overlap`, no prefetch, 200 tiles / 128 MiB, `maxRequests` 4, no overview)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `demo-layer-props-audit-2026-08.test.ts`                                                                                                                         | —                                                                                                       |
| E7     | chassis `_admitTiles` — `tileCommitBudgetMs` (default 6, 0 = unlimited) per rAF/tick/viewport commit, nearest-to-playhead first, parents keep standing in                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `chassis-lifecycle.test.ts` E7 ×4, driver wiring                                                                                                                 | 50 tiles in one frame → 5–7 per frame, all ≤ 10 frames                                                  |
| F1     | `PrefetchPolicy.noteResidentPass` throttles the idle-pipeline re-plan; `unpinnedTiles` map keeps pinned headers out of the grace sweep                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `tileset-audit-2026-08.test.ts` F1 ×2, `prefetch-policy.test.ts` F1                                                                                              | 7 wide directory queries → 0; 400 pinned `lastUsed` reads → 0                                           |
| F5     | `nwm-rivers-2019` rebuilt with the recorded recipe (generator default `time-major`; 11,453 tiles, same buckets, 180 → 192 MB), validated, old copy kept as `.nwm-rivers-2019.bak-ordering`; reconcile gate requires `time-major` on any multi-bucket archive (`ORDERING_EXEMPT` register for the one-trajectory AV ego)                                                                                                                                                                                                                                                                                                     | `dataset-archive-reconcile.test.ts` (f)                                                                                                                          | 2 red → 432/432                                                                                         |
| G1     | `loading-qoe-gate.test.ts` — real tileset + governor over a recorded source, three shapes (small / long-sparse / fast-fine)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | see §9.3                                                                                                                                                         | —                                                                                                       |
| G2     | tileset `requests`, `bytesRequested`, `bytesUseful`, `refetches`, `overLimitEvictionsScheduled`, `selectionPasses`, `coverageRebuilds`; governor `stallMs`, `seekCount`, `seekSettleMsP50`, `gateEntriesByReason`, `frontierSnapBacks`, `blockedPermanentlyCount`, all on the probe snapshots                                                                                                                                                                                                                                                                                                                               | `tileset-audit-2026-08.test.ts` G2 ×3, `playback-governor.test.ts` G2 ×2                                                                                         | —                                                                                                       |
| G4     | `configureSharedScheduler({enabled})` removed from nine call sites and two docs, `enabled?: never` guard; layer probe payloads and `performance.now()` gated behind `isProbeEnabled()` in 13 files                                                                                                                                                                                                                                                                                                                                                                                                                          | `chassis-driver.test.ts` TO-2                                                                                                                                    | 202 `performance.now` calls on 100 tiles → 0                                                            |
| G6/G8  | governor coalesces buffer-event frontier walks to the 200 ms probe cadence; start-gate hatch armed only once a source is registered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `playback-governor.test.ts` G6 ×2, G8 ×3                                                                                                                         | 100 probes / 100 ms → ≤ 10                                                                              |
| config | `targetPlaybackSeconds`: `nyc-taxi-paths` 60 → 900, `rain-flood-2019` 120 → 300, `satellites` 60 → 180, `ocean-drifters` 120 → 300, `osm-nyc-changesets-editors` 60 → 120 (each with its arithmetic in the comment); composite cache split by bytes only; `tier:'raw'` on the weather/storm-4d lightning overlays; `maxPitch ?? MAX_SAFE_PITCH` (70) on the terrain path; reconcile gate (h) horizon feasibility from the real directory at the shipped camera; `/drive` `AvDeck` tick throttled to 10 Hz (headroom, not fps — measured by the peer session), `MetricCharts` memoized/decimated, `resolveFrameUrl` memoized | `dataset-archive-reconcile.test.ts`, `av-churn-audit-2026-08.test.ts` ×7                                                                                         | 4 horizon findings → 0                                                                                  |
| wiring | chassis passes `sparsePrimary` and `schedulerWeight` (new prop) to the archive/tileset; adapter forwards `onTileError` (it was dropped on the floor); `usePlayback({ initialAutoSpeed })`                                                                                                                                                                                                                                                                                                                                                                                                                                   | `chassis-lifecycle.test.ts` ×6, `tileset-adapter.test.ts` ×5, `use-playback.test.tsx`                                                                            | —                                                                                                       |

### 9.1a Landed after the after-run (same day)

| id      | change                                                                                                                                                                                                                                                                                                                                                                                                                              | pinned by                                                                                      | before → after                                                                                                    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| G3-2    | `PrefetchPolicy` residency capacity = `min(count, bytes)` with `PREFETCH_CACHE_FRACTION × effectiveMaxCacheBytes ÷ (expansion × bytesPerBucket)`; `enqueueBudgetBytes` = the cache share (4 MiB floor only for an unpriceable cap); `sliceBytes` capped by it; tileset passes `maxCacheBytes` / `bytesPerBucket` / `byteExpansion`                                                                                                  | gate G3-2 flipped to `it`; `prefetch-policy.test.ts` ×6; four floor-pins re-blessed            | 2 MiB tiles under 8 MiB: 32 MiB resident / 344 runway evictions / 333 refetches → 10 MiB peak / 0 / 0, ratio 1.03 |
| G3-4    | governor `predictsPlaythrough` refuses below `min(finest bucket, 200 ms × speed)` of runway; zero-runway `refreshFrontier` anchors at the last resident range end behind the head; `gateHoldsByReason` (a synchronously-passing gate is an entry, not a hold)                                                                                                                                                                       | gate G3-4 flipped; `playback-governor.test.ts` ×8; `:1873` re-blessed (pinned the defect)      | 467 zero-length gates, head 688 wall-ms past resident data → 0 overruns, never past                               |
| ETA     | `estimateCost` reports `unknown: true` and `estimateTimeToReadyMs` returns `null` before the coverage index exists                                                                                                                                                                                                                                                                                                                  | `buffered-runway.test.ts`                                                                      | start gate passing onto nothing → held                                                                            |
| B5      | gate `F loop wrap` green (`seeking` entries 1, holds 0, runway 60 s at the wrap, 0 pauses); **G3-3 stays `it.fails`**: `getBufferedRunway` is not loop-aware — with loop `[0, 10 s)` and buckets 0–1 unloaded it still reads `complete: true` at the lap boundary                                                                                                                                                                   | gate                                                                                           | open (follow-up)                                                                                                  |
| H1      | `track-kernel.ts` — dirty tracks assembled from their own `byTile` groups ordered by a per-sync rank map (`orderGroups`) instead of scanning every resident tile-layer                                                                                                                                                                                                                                                              | `track-kernel.test.ts` ×4, `core-hotspots-audit-2026-08.test.ts`                               | inner loop 157–176 → 8–18 ms (10–19×); cold sync 246 → 123–166 ms                                                 |
| H2      | `directory.ts` — LEB128 varints decode as Numbers (exact < 2^53) with an exact BigInt rewind above; `delta()` range-checks the sum; Hilbert column skipped                                                                                                                                                                                                                                                                          | oracle = the verbatim old decoder over all 32 golden leaves; 11,505-value fuzz × 13 slots      | 1,343 → 254–286 ns/entry; 5.5 → 1.1 ms per 4,096-entry leaf                                                       |
| H3      | `opfs-cache.ts` — `OPFS_EVICT_LOW_WATER` 0.9 (option `evictLowWater`); victim order unchanged; default-off, no showcase effect                                                                                                                                                                                                                                                                                                      | `opfs-cache.test.ts` ×5                                                                        | 100 ranking passes per 100 sets → 1; 1.61 → 0.01 ms per set                                                       |
| preview | `PlaybackControls.tsx` hover-preview settle effect depended on `renderPreview`'s IDENTITY; callers pass a fresh arrow per render and the parent re-renders ~10×/s during playback, so the cleanup killed the 120 ms timer before it fired — **the scrubber preview never advanced while playing** (peer measurement: playing 40 arms / 0 fires over a 4 s motionless hover; paused 2 / 1). Now depends on whether a renderer exists | `playback-controls.test.tsx` (parent re-renders every 100 ms with a fresh arrow; fails before) | preview stuck at the seed time → advances to the hovered time                                                     |
| ring    | core + playback probe shims trim a quarter buffer per overflow; decode-wait ring is a 512-sample window                                                                                                                                                                                                                                                                                                                             | `telemetry.test.ts`, `telemetry-channels.test.ts` (four exact-cap pins re-blessed)             | saturated `recordDecodeWait` 89.9 → 3.0 µs (peer-verified)                                                        |

Final counts after these: core **1,479** (from 1,358), playback **330** (308), layers 1,673 (1,592),
three 695, maplibre 1,325, cesium 113, react 64, showcase 811 (645); every package typecheck,
`oxlint` and `oxfmt` clean on the touched files. The 1 GiB device budget prices `flights`' horizon
at ~3 buckets (≈ 30 MB compressed) and `animal-migration`'s 49-day horizon at ≈ 38 MB — the
deeper runway §9.3.1 noted is the lookahead filling within budget, not a byte overrun; bytes bind
below ~160–380 MiB of budget.

### 9.2 Corrections the implementers made to the audit

- **G3/B6:** "call `refreshFrontier()` at the playhead" is wrong for a static runway (the frontier would follow the playhead into the void); the re-probe must be taken **at the cached frontier**.
- **B7:** the honest mock exposed a _second_ vacuous BH-4 expectation ("absorbs coarse-bucket quantization") that was asserting the defect.
- **D1:** "a wrong `expectedSize` fails the existing length check" is false with an exact FCS — fzstd clamps; hence FCS = size + 1.
- **E3:** the blast radius ("all cases use pending cells — pass") missed four clamp cases and nine `mixed-zoom-cover` pins that lived on the any-cell rule via the frustum-cut path; fixing them properly repaired FS-3.
- **B1:** the test that pinned the ⅛-span defect was `selection-hardening.test.ts:38`, not the two files the audit named.
- **C1:** "re-split is the only thing that can change the outcome" holds for a total deadline, not for a progress watchdog — a single-range stall is connection-bound, so single ranges keep their retries.
- **F3:** the showcase report's per-bucket bytes double-counted tiles spanning two buckets; the union-based gate measures `satellites` at 6.0 MB/s (not 12.4), `drifters` 2.2–6.0 by decade (not 8.7), `nyc-taxi-paths` 8.3 (not 11.7). The conclusions stand; the constants moved.
- **/drive:** the repo's "28 fps" figure does not reproduce on a real GPU (116 fps; peer session, `--use-angle`); the `AvDeck` throttle removes ~52k component renders/s but changes no fps on an M3 Pro — it is headroom for weaker hardware. The peer's fleet-wide fps table is single runs with an ~8 fps run-to-run band (`earthquake-activity` 109–119 over 12 runs), so read every row as "at or near the display cap", not a point value. The luma UBO patch **is committed and wired** (`patches/@luma.gl__core@9.3.3.patch`, `d5163aa`); only its 2× headline is unverified on a real GPU — its mechanism is real.
- **B4:** capping arrears at `−quantum` was rejected — it bounds the inversion at ~2 rounds instead of removing it.

### 9.3 Measured result

The after-run repeats §7's protocol exactly (same probe, same 21 demos, 10 s of playback after
an 8 s settle + 6 s start-gate discard, 1440×900, ANGLE/Metal) against the rebuilt dists on a
private dev server (`:3077`, forced dependency re-optimize) on a **quiet machine** — the peer
session stood down its browsers and dev servers for the window after a first attempt was found
to be contended (its decode sweep and this run overlapped; that attempt was discarded).
Before = §7 (18:1x–18:3x local, before any fix). "b → a" = before → after.

**Caveat on the before side.** The audit's own probe shim paid one `Array.shift()` per sample
once a channel held 4,096 entries (found by the peer session's core audit: ~90 µs per decode,
~18 ms/s at 200 decodes/s, switching on mid-run). Every "before" row whose decode count reads
`4096+` therefore ran the back half of its window under a materially heavier probe than the
after-run, which was measured with the fixed shim (batched trims, 512-sample decode-wait
window — landed in `telemetry.ts` for core and playback, pinned in `telemetry-channels.test.ts`).
That asymmetry **flatters** fps / frame-p95 / decode-wait on those four rows, so the headline
below rests on the loader counters — evictions, runway evictions, pressure, stalls, refetches,
bytes — which are counts the loader keeps, not timings the probe pays for. The decode-timing
deltas are corroborated independently by the peer session's own harness on `:3000`.

### 9.3.1 The five thrashing demos, and the rest of the fleet

| demo                | evictions b→a | runway evictions b→a | pressure b→a | stalls b→a | stall ms b→a | play MB/10 s b→a | MB per sim-hour b→a |    decodes b→a | pinned b→a | resident MB b→a | refetches (a) |
| ------------------- | ------------: | -------------------: | -----------: | ---------: | -----------: | ---------------: | ------------------: | -------------: | ---------: | --------------: | ------------: |
| animal-migration    |         0 → 0 |                0 → 0 |  1.00 → 1.00 |      0 → 0 |        0 → 0 |      33.2 → 92.1 |       0.023 → 0.062 |       81 → 261 |      0 → 0 |       141 → 329 |             0 |
| bixi-flowmap        |         0 → 0 |                0 → 0 |  1.00 → 1.00 |      0 → 0 |        0 → 0 |        0.0 → 0.0 |       0.000 → 0.000 |          0 → 0 |      0 → 0 |           6 → 6 |             0 |
| bixi-live           |         0 → 0 |                0 → 0 |  1.00 → 1.00 |      0 → 0 |        0 → 0 |        0.3 → 0.0 |       0.807 → 0.000 |         13 → 0 |      0 → 0 |         28 → 26 |             0 |
| earthquake-activity |   8,023 → 906 |            8,023 → 0 |  0.25 → 1.00 |    286 → 0 |       29 → 0 |       12.8 → 4.3 |       0.002 → 0.001 | 4,096+ → 1,420 |  8,927 → 0 |          42 → 5 |             0 |
| earthquake-columns  |     8,133 → 0 |            7,940 → 0 |  0.25 → 1.00 |      0 → 0 |        0 → 0 |        5.5 → 5.1 |       0.001 → 0.001 |   4,096+ → 292 |  8,927 → 0 |          41 → 1 |             0 |
| flights             |         0 → 0 |                0 → 0 |  1.00 → 1.00 |      0 → 0 |        0 → 0 |      39.0 → 52.0 |      9.674 → 13.059 |        41 → 66 |      0 → 0 |       217 → 265 |             0 |
| goes-glm-lightning  |         0 → 0 |                0 → 0 |  1.00 → 1.00 |      0 → 0 |        0 → 0 |        3.2 → 2.3 |       0.645 → 0.476 |      101 → 129 |    570 → 0 |           2 → 1 |             0 |
| gtfs-ch             |         0 → 0 |                0 → 0 |  1.00 → 1.00 |      0 → 0 |        0 → 0 |        0.0 → 0.0 |       0.049 → 0.049 |          0 → 4 |      0 → 0 |           1 → 1 |             0 |
| gtfs-nl             |         0 → 0 |                0 → 0 |  1.00 → 1.00 |      0 → 0 |        0 → 0 |        0.1 → 0.1 |       0.318 → 0.318 |          2 → 2 |      0 → 0 |           1 → 1 |             0 |
| hrrr-wind           |         0 → 0 |                0 → 0 |  1.00 → 1.00 |      0 → 0 |        0 → 0 |        3.2 → 2.4 |       0.660 → 0.496 |        16 → 24 |      0 → 0 |         25 → 23 |             0 |
| hurricanes          | 4,580 → 2,560 |            4,249 → 0 |  0.25 → 1.00 |    126 → 0 |      408 → 0 |       11.4 → 3.9 |       0.003 → 0.001 |  3,732 → 1,357 | 17,899 → 0 |          25 → 2 |             0 |
| mrms-precip         |         0 → 0 |                0 → 0 |  1.00 → 1.00 |      0 → 0 |        0 → 0 |      12.7 → 11.2 |       2.664 → 2.346 |      294 → 336 |      0 → 0 |           1 → 1 |             0 |
| nyc-flow-and-riders |         0 → 0 |                0 → 0 |  1.00 → 1.00 |      0 → 0 |        0 → 0 |      35.1 → 36.3 |     73.522 → 76.164 |      260 → 210 |      0 → 0 |       124 → 129 |             0 |
| nyc-rideshare       |         0 → 0 |                0 → 0 |  1.00 → 1.00 |      0 → 0 |        0 → 0 |        0.1 → 0.1 |       0.257 → 0.257 |         0 → 13 |      0 → 0 |           0 → 0 |             0 |
| nyc-taxi-paths      |     9,509 → 0 |                0 → 0 |  1.00 → 1.00 |    176 → 0 |       52 → 0 |     718.8 → 22.2 |    105.218 → 46.683 |   4,096+ → 406 |      0 → 0 |       114 → 134 |             0 |
| ocean-drifters      |         0 → 0 |                0 → 0 |  1.00 → 1.00 |      0 → 0 |        0 → 0 |        1.9 → 0.6 |       0.000 → 0.000 |       179 → 76 |      0 → 0 |           6 → 3 |             0 |
| rain-flood-2019     |    27,111 → 0 |           25,557 → 0 |  0.25 → 1.00 |  1,123 → 0 |      155 → 0 |       63.2 → 6.6 |       0.134 → 0.022 |   4,096+ → 890 |  4,380 → 0 |        408 → 22 |             0 |
| satellites          |         0 → 0 |                0 → 0 |  1.00 → 1.00 |      0 → 0 |        0 → 0 |     100.0 → 21.0 |     25.108 → 15.647 |        48 → 16 |      0 → 0 |       641 → 227 |             0 |
| ship-traffic        |         0 → 0 |                0 → 0 |  1.00 → 1.00 |      0 → 0 |        0 → 0 |        7.0 → 4.3 |       1.739 → 1.092 |        36 → 40 |      0 → 0 |        101 → 92 |             0 |
| storm-radar         |         0 → 0 |                0 → 0 |  1.00 → 1.00 |      0 → 0 |        0 → 0 |        2.7 → 1.7 |       3.371 → 2.152 |        76 → 59 |      0 → 0 |           0 → 0 |             0 |
| wildfires           |         0 → 0 |                0 → 0 |  1.00 → 1.00 |      0 → 0 |        0 → 0 |        3.8 → 2.7 |       0.001 → 0.001 |          9 → 8 |      0 → 0 |           5 → 5 |             0 |

`decodes` `+` = the 4,096-sample probe cap (a floor). `refetches` is the new G2 counter (a key
loaded again after being evicted; 0 on every row). `pinned` 8,927 / 17,899 / 4,380 → 0 is A1's
count gate **rejecting** the overview storyboard on those archives (`reason: 'over-count'`) —
the scrub storyboard is gone there until `preloadOverviewTier({ maxTiles })` is raised per demo,
which is the right call for a 2,000-tile working set and is recorded as a follow-up below.

Reading the rows:

- **The three loops are closed.** Runway evictions 8,023 / 7,940 / 4,249 / 25,557 → **0**,
  pressure 0.25 → **1.0**, stalls 286 / 126 / 176 / 1,123 → **0**, refetches **0**, on every one
  of the five §1 rows. `nyc-taxi-paths` 719 → 22 MB per 10 s, of which the honest split is: the
  playback target 60 → 900 s (sim advance 6.8 → 0.5 h per 10 s) and the refetch loop each
  account for about half — per sim-hour it is 105 → 47 MB. `rain-flood-2019` 0.134 → 0.022 MB
  per sim-hour (6×); `satellites` 25 → 16 MB per sim-hour.
- **Two rows fetch more per sim-hour, by design and worth watching:** `animal-migration`
  0.023 → 0.062 and `flights` 9.7 → 13.1 MB per sim-hour. Both are budget-limited prefetch that
  now reaches further ahead: A4 demoted the tile-count cap (2,000 → 20,000) and the per-pass
  enqueue budget is `PREFETCH_CACHE_FRACTION × maxCacheSize`, so the runway fills deeper within
  the same byte cap. Refetches 0 and amplification ≈ 1.0 on both, i.e. it is a deeper resident
  runway, not waste — but on a 4 MB/s link a deeper speculative runway competes with the head.
  The QoE gate's G3-2 finding (below) prices the same budget in bytes and is the fix.
- **Small and medium archives are unchanged**, as the audit predicted: `bixi-*`, `wildfires`,
  `gtfs-*`, `hrrr-wind`, `nyc-rideshare`, `storm-radar`, `mrms-precip`, `ship-traffic` read the
  same fps, evictions and bytes before and after (bytes down 10–40 % where the C3/C6 fuse
  bounds bit).
- `earthquake-activity` fps 52 → 117 and `hurricanes` 67 → 116 are consistent with the loops
  closing (no more per-frame eviction sweeps over 9–21k headers and no re-decode churn), but see
  the caveat above — they are not claimed as measured render wins.

### 9.3.2 Decode (worker-side, in-browser, play phase; p50 ms)

| demo                |  decodes b → a | decompress p50 b → a | decompress p95 b → a | service p50 b → a | queue+service p50 b → a |
| ------------------- | -------------: | -------------------: | -------------------: | ----------------: | ----------------------: |
| earthquake-activity | 4,096+ → 1,607 |      2.30 → **0.10** |          4.60 → 0.20 |      111.2 → 14.2 |            183.9 → 16.8 |
| hurricanes          | 4,096+ → 1,090 |      2.40 → **0.10** |          8.60 → 0.20 |      114.9 → 20.2 |            177.1 → 32.0 |
| nyc-taxi-paths      |   4,096+ → 378 |      4.00 → **0.60** |           13.1 → 2.2 |      151.7 → 17.3 |            189.5 → 18.3 |
| ship-traffic        |        36 → 40 |       15.8 → **3.3** |          65.7 → 20.6 |       34.9 → 10.3 |             34.9 → 10.3 |
| storm-4d-greenfield |      317 → 449 |      3.00 → **0.20** |          40.6 → 20.2 |        17.8 → 9.1 |             18.3 → 16.0 |
| goes-glm-lightning  |      101 → 129 |          0.50 → 0.10 |          0.80 → 0.40 |        1.1 → 10.1 |              1.2 → 12.1 |
| satellites          |        48 → 16 |          47.9 → 41.8 |          52.7 → 52.1 |       58.4 → 77.7 |             58.5 → 93.1 |

D1 reproduces in the browser at the ratios the Node bench predicted for small and medium tiles
(10–23×); on the 1.3 MB `satellites` z0 tiles the window allocation was already amortized
(1.15×; n = 16, noisy). "service" now includes BH-7 batch-mates (the peer's decode batching
landed in the same window), which is why `goes-glm-lightning`'s service p50 rose while its
decompress fell — a batch settles together by design; its decode-queue p95 is unchanged.
Independent corroboration (peer session, own harness, `:3000`): earthquake-activity decompress
2.6 → 0.1 ms, decode-queue p50 152 → 16 ms.

### 9.3.3 Moving camera (30 s, ego-drag or auto-rotate; the B1 trigger)

| demo                            | stalls b → a | stall ms b → a | evictions b → a | runway evictions b → a | min pressure b → a |
| ------------------------------- | -----------: | -------------: | --------------: | ---------------------: | -----------------: |
| hurricanes (still camera, auto) |   42 → **0** |      1,079 → 0 |  30,438 → 4,294 |        30,430 → **21** |        0.25 → 0.70 |
| nyc-taxi-paths (drag)           |        1 → 0 |          0 → 0 |  33,397 → **0** |         10,458 → **0** |        0.25 → 1.00 |
| flights (drag)                  |        0 → 0 |          0 → 0 |           0 → 0 |                  0 → 0 |              1 → 1 |
| ship-traffic (drag)             |        0 → 0 |          0 → 0 |           0 → 0 |                  0 → 0 |              1 → 1 |
| ocean-drifters (auto-rotate)    |        0 → 0 |          0 → 0 |           0 → 0 |                  0 → 0 |              1 → 1 |

`hurricanes` under a **still** camera evicting 30k tiles per 30 s is the single most
pathological number the audit produced, and it never showed as fps; it reads 21 now. The
auto-rotating `ocean-drifters` did not reproduce B1's decay in either run (its z0 runway is
hours deep at that zoom); B1 is pinned by the experiment-B port instead.

### 9.3.4 The QoE gate's own reading (real tileset + real governor, fake timers, 4 MB/s link)

| shape                                       | runway evictions | refetches | duplicate requests | stalls |                bytes requested / useful | clock past frontier |                 cache over cap |
| ------------------------------------------- | ---------------: | --------: | -----------------: | -----: | --------------------------------------: | ------------------: | -----------------------------: |
| S — 4 tiles, 1 bucket                       |                0 |         0 |                  0 |      0 |                                  1.000× |                   0 |                          never |
| L — 3,000 hourly buckets × 40 + 12,000 z0–1 |                0 |         0 |                  0 |      0 | 1.020× (overview rejected `over-count`) |                   0 |                          never |
| F — 60 s buckets × 30 at 2,400×             |                0 |         0 |                  0 |      0 |                                  1.013× |                   0 | never (one transient A3 frame) |

Runs in < 5 s and is in the core suite (`loading-qoe-gate.test.ts`,
`loading-invariants-audit-2026-08.test.ts`, harness `helpers/recorded-source.ts`). It also
caught three residuals on the first day, each pinned as `it.fails` with the measured numbers:
**G3-2** A2's residency capacity bends on tile _count_ only — 2 MiB tiles under an 8 MiB cap:
32 MiB resident, 344 runway evictions, 333 refetches; **G3-4** on a bursty link the governor's
predictor passes a gate with `runway.simMs === 0` and `refreshFrontier` then anchors the
frontier at the head, so the clock ratchets one frame per two ticks into unloaded data (467
zero-length gates, 688 wall-ms past resident data in 60 s); and `estimateCost` reports
`{bytes: 0}` before the coverage index exists, so a warm estimator passes the start gate onto
nothing. These are the next implementer's list, not open questions.

### 9.3.5 Follow-ups recorded

- Byte-priced residency capacity in `PrefetchPolicy` (`PREFETCH_CACHE_FRACTION ×
effectiveMaxCacheBytes ÷ (expansion × bytesPerBucket)`) and `enqueueBudgetBytes` /
  `sliceBytes` bounded by the effective byte cap — closes G3-2 and the deeper-runway growth
  on `animal-migration` / `flights`.
- Governor: no predictor pass on `runway.simMs === 0`; zero-runway `refreshFrontier` anchors
  behind the head (`getBufferedRanges`), not at it; `gateHoldsByReason` alongside
  `gateEntriesByReason` (a synchronously-passing gate is not a hold); `estimateTimeToReadyMs`
  → `null` while the coverage index is unbuilt.
- A5 `categoriesRef` token — rides the BH-7 message shape (peer session).
- D3 host decode-queue heap — same file.
- The overview storyboard on `earthquakes-v2` / `hurricanes` / `rainfall-2019` is now
  rejected `over-count`; raise `preloadOverviewTier({ maxTiles })` per demo if the scrub
  storyboard is wanted back (it costs the working set exactly that many tiles).
- The luma.gl UBO patch is committed and wired (`d5163aa`); its 2× headline is unverified on
  real GPU (mechanism real). The `/drive` 28 fps note does not reproduce (116 fps on
  ANGLE/Metal) — peer session's fleet-wide check; the render-side changes here are headroom on
  this hardware.
- `/demo/:id` React path (peer session, measured): **no defect** — 10.6–13.5 commits/s at
  234–310 fibers per commit, because `use-deck-clock.ts` resolves time from
  `context.userData.stt.timeController` inside `onBeforeRender`, so the render clock never
  passes through React; the 10 Hz throttle at `use-playback.ts:281` is load-bearing (patched
  to 16 ms → 60 commits/s). Two negative results worth keeping: `React.memo` on the 80-div
  density strip is worth nothing (element allocation, not host reconciliation, is the cost —
  `exports.jsx` 527 → 191 ms in a differential profile), and `usePlayback` returning a fresh
  object costs 2 fps / −4 ms p95 on the heaviest demo and zero elsewhere; deck's `setProps` was
  unchanged across that A/B (1,195 → 1,191 ms). Lower priority, unmeasured: four `Intl` format
  calls per render in `PlaybackControls` (three avoidable), and a `getBoundingClientRect()`
  ahead of the rAF gate.
- Peer-found core hot spots (node-measured): `track-kernel.ts` per-dirty-track scan of all
  resident tile-layers (1,102 ms cold sync at 854 × 30k, 33× available), `directory.ts` BigInt
  varint on the leaf decode path (20–39 ms settle jank), `opfs-cache.ts` eviction with no
  low-water mark (1,830 → 14 ms per 200-tile pan; latent, default-off) — implemented in the
  same pass, see §9.1 addendum when it lands.

### 9.4 The lesson, for the next measurement pass

Every defect in this record that mattered most was invisible to frame rate. A still camera
evicting 30,430 runway tiles per 30 s read 120 fps; the loops that fetched `nyc-taxi-paths` 719 MB
per 10 s read 84; the 5.5 ms-per-leaf BigInt varint decode only ever appeared as settle jank
after a pan; the audit's own probe paid 90 µs per decode once a channel was full and skewed the
run it was taken in; two sessions benchmarking on one box produced 10–30× run-to-run variance
that looked like signal until someone checked `uptime`. What found them was, in every case,
**counting the thing the claim is about** — evictions, refetches, bytes requested vs useful,
stalls, synchronous main-thread work per operation, probe overhead per sample — on a quiet
machine, with the GPU flags a headless browser needs, and with a second harness disagreeing
before a number was quoted. The fleet sits at the display cap on this hardware; fps is the last
metric to move and the first to be reached for. The QoE gate (§9.3.4) exists so the counters
are asserted on every core test run, and the turn-taking rule (ask before any browser
measurement; stand down browsers and servers for the other session's window) is the one
process change this day produced.

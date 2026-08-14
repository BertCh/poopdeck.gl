# Optimization-informed design: the coherence program (2026-08)

_2026-08-10 · companion to [optimization problems §13.5](./optimization-problems-2026-08.md), which formalized 66
decisions across 13 subsystems. That document is the diagnosis; this one is the treatment plan: what the
formalization implies for the **design** of poopdeck + STT, stated as a small set of shared mechanisms rather than
66 patches, plus a sequenced adoption plan._

_House-rules note: this is a decision record — rationale and an adoption map. Nothing here is scheduled until its
line lands in [the backlog](./README.md); §7 below carries the proposed lines for that pass. Counted-out items keep
their revival triggers in the records that own them._

---

## 1. What the formalization actually says

The headline is **not** "66 things are suboptimal." Read across subsystems, three findings dominate:

1. **The constraint spine is the asset.** Determinism, no-thinning, random access, and bounded client memory
   (optimization problems §13.1–§13.5) are why greedy incumbents are safe, why dedup and incremental deploys work,
   and why every measurement is noise-free. Nothing below relaxes the spine. The recorded rejections (delta chains,
   request-count ranking, analytic size models, sample-dependent type decisions, silent thinning, per-tile
   quantization grids) are constraint documentation, and §5 consolidates the do-not-repropose register so future
   work stops re-litigating them.
2. **Most incumbents are optimal _within their family_; the family is the gap.** The doc says this verbatim for the
   compact-time menu (§2.6), the numeric leaf/step menus (§3.3), the range-coalescing threshold (§6.2), the pack
   cut (§6.5), the fallback cover (§8.3), the eviction tiering (§9.4), and the gating hysteresis shape (§11.1).
   The productive attack is the menu, the objective, or the constant — almost never the search algorithm.
3. **The 66 gaps collapse into six systemic defects.** A fix at defect level discharges whole rows of problems at
   once. That is the design thesis of this document: build **eight shared mechanisms** (§3), not 66 point fixes.

### The six systemic defects

**D1 — Constants where fitted functions should be.** The control _shape_ is repeatedly right (two-threshold
hysteresis is provably optimal for its queueing family, §11.1) while the constant was transplanted or hand-set and
never fit: ExoPlayer's 2.5 s/5 s gates (§11.1), the 200 ms runway tolerance tied to the probe interval instead of
the bucket cadences that generate the jitter (§11.2), the 2 MiB coalesce gap spanning an order of magnitude of
optimal values across sessions (§6.2), `pageEntries = 4096` from one 2026-07 simulation (§7.2), `s_px = 0.4` from
one Miami sweep (§4.5), 30 s target playback ignoring frame count entirely (§11.5), the 500 ms×2ⁿ retry ladder
treating 404 and 503 identically (§8.4). In nearly every case the statistic to fit against is _already measured_.

**D2 — The oracle exists but is not consulted.** STT's structural advantage over generic streaming is that the
directory prices any future sim-window in exact bytes — and six independent controllers ignore it: the prefetch
horizon is discovered by an AIMD ladder instead of a one-shot feasibility solve (§9.1), auto-speed samples byte
density only at the current speed (§11.4), the governor lookahead truncates to one window (§11.1), the temporal-LOD
tier pick never compares costs across the addressable set (§7.5), placeholder fetch uses a flat 2 MiB cutoff with
the throughput estimator already wired (§8.3), and `stt-optimize` never computes `addedTierBytes` though the density
model could (§12.4). Same defect, telemetry side: queue-wait samples (§10.1), per-decode splits (§10.2), and OPFS
per-entry hit counts (§9.5) are emitted and never fed back.

**D3 — Information established upstream is erased downstream.** The network scheduler assigns priorities that the
decode pool discards (FIFO, count-balanced — §10.2); DRR meters slots while range-group sizes vary by orders of
magnitude (§9.3); the fairness controller omits bytes-per-sim-ms from its weights (§11.3); prefetch and enqueue
budgets count tiles while the constrained resource is bytes (§9.1, §9.2); eviction tiers rank by time-distance
while the freed resource is bytes (§9.4).

**D4 — Pre-zstd surrogates for post-zstd objectives.** The dict-vs-utf8 comparison, numeric-width selection, the
compact-time menu, the feature-budget byte cap, and the zstd level itself all optimize proxies for a wire-bytes
objective nobody measures per decision (§3.3, §3.4, §2.6, §4.3, §5.1) — and the measurement corpus proves the
surfaces invert under compression (compact times +3.4 % wire / −13.1 % uncompressed; delta encodings collapsing
post-zstd, §13.4).

**D5 — Per-tile greed where a dataset-global pin is wanted.** Per-tile affine offsets decode the same value
differently across tiles (§3.3); per-tile dictionary verdicts and width flips fork schema templates (§3.4, §3.8);
per-tile row-index ids forfeit delta-codability (§3.6); and the validator drift noise users see (backlog K2) is
this defect surfacing as a symptom. All of it wants the same missing **two-pass build**, which §3.8 names with two
customers already ("one investment, two customers") — there are at least five.

**D6 — One physical quantity, several independently chosen constants; couplings priced nowhere.** The zoom-flip
cost, the flush tolerance, and the prefetch-invalidation cost are one physical cost with three constants (§8.2,
§8.5, §9.1). The reader's coalesce gap is baked into build-time `measured` orderings with no co-versioning, so a
reader-side change silently invalidates fleet layouts (§6.2). The LOD-grid bucket in the generation scripts must
equal `--temporal-bucket` and nothing asserts it (§4.4). Advisors measure levers one-at-a-time against one baseline
while zstd×quantize×ordering×bucket interactions are "silently assumed away" (§12.2). Every per-tile encoder is
blind to the schema-template count it forks (§3.8).

---

## 2. Design principles the program adopts

These generalize what the incumbents already got right, and they bound every mechanism in §3:

- **P1 — Constants become functions of measured statistics.** Any threshold defended only by "it worked" gets
  either a derivation from a measured distribution or a recorded reason it must stay fixed.
- **P2 — Decisions consult the cheapest sufficient oracle.** Directory byte sums, the dual-EWMA estimator, and the
  sample encoder are the three oracles; a controller that ignores an oracle it could consult for free is a defect.
- **P3 — Bytes are the unit of account end to end.** Budgets, fairness quanta, eviction ranks, and enqueue caps
  meter bytes (or byte-derived value), not tiles/slots/entries, wherever the constrained resource is bytes.
- **P4 — Dataset-global before per-tile.** Any encoding verdict that can flip tile-to-tile must factor through
  domain statistics (the conformance invariance rule, §13.2); the two-pass build is the enabling mechanism.
- **P5 — The spine is inviolable.** Determinism (pure functions of the blob set; no RNG, no arrival-order
  dependence), the lexicographic no-thinning partition (auto touches Θ₀ only; lossy levers are human-gated,
  loudly), random access, and conservative-superset soundness (blank map = −∞) are constraints on every solver.
- **P6 — Byte-changing work batches into rebuild windows.** A fleet republish costs ~29.3 GiB / 1,324 objects
  (§13.1); builder changes that move archive bytes ride a shared window with a single republish, never dribble.

---

## 3. The eight mechanisms

Ordered so that each mechanism's prerequisites appear before it. Each entry: what it is, which formal problems it
discharges, the objective it measurably moves, and the constraints it must respect.

### M1 — One measurement oracle, upgraded (stt-optimize)

Make §12.1's sampled measurement the _universal_ objective evaluator, then point every byte decision at it.

- **Stratified deterministic sampling** by zoom (and time bucket), proportional to blob bytes — strata are free
  from the directory, aliasing dies, variance drops at the same n, and sampling stays deterministic (contractual,
  §12.1). **Dispersion published** with every per-column share so doctor's 3 % threshold and `diff`'s per-column
  deltas read against noise. **Leave-one-out attribution** (m+1 oracle calls) replaces the singleton proxy that
  violates efficiency. Synthetic-tile count follows the observed features-per-tile distribution.
- **Post-zstd trial-encode as the decision objective** for the five D4 sites: dict-vs-utf8 boundary calls, numeric
  width/step selection, compact-time menu extensions, the feature-budget byte cap, and a per-dataset zstd level
  sweep (the machinery in `measure.rs` already runs the production encoder + zstd).
- Discharges/serves: §12.1, §12.2, §12.4, §12.5, §3.3, §3.4, §2.6, §4.3, §5.1, and it is the size oracle M3 needs.
- Objective moved: share-estimate error vs exhaustive decode at fixed n; advisor decisions that flip when measured
  post-zstd; bytes reclaimed per doctor finding vs projected.
- Constraints: deterministic sampling; `COLUMN_ZSTD_LEVEL = 19` stays fixed for cross-dataset comparability; the
  diff gate's exact directory metric is already sound — do not touch it.

### M2 — The two-pass build (dataset-global pins)

One added build phase that computes dataset-global column statistics before the first tile encodes, discharging at
least five recorded wants in one investment:

1. **Global attribute-range pin** (§3.3, already PLANNED in the format decisions): one affine per column — fixes
   cross-tile decode inconsistency, converts the K2 drift _warnings_ into silence, and unlocks true per-column
   rate selection beyond the {U16, I32} menu.
2. **Global dictionary hoist** (§3.8, DEFERRED — "the biggest measured win left on the table"): per-tile dictionary
   batches re-ship each categorical column's category list at 43.9 % (earthquakes-v2) / 33.6 % (hurricanes) of
   uncompressed tile bytes. Reader-transparent by construction; writer-blocked on exactly this pass. Partial hoist
   is worse than none — all-or-nothing per column.
3. **Global dict-vs-utf8 verdict** per column (§3.4) — kills template forking from boundary flips.
4. **Global dense id renumbering** (§3.6) and **row-index ids assigned after the start-time sort** (§3.5/§3.6) —
   makes every id column delta-codable; the ordering-of-passes fix is free.
5. **A schema-template cost term** (|T|) visible to every per-tile encoder (§3.8 gap 1), pricing the externality D6
   leaves unpriced.

- Objective moved: pack bytes (the packed-v2 precedent for template work was −44.8 % E2E on hurricanes);
  `manifest.schemas` count; K2 warning volume → 0.
- Constraints: byte-breaking ⇒ rides rebuild window R1 (§6 plan); determinism; the TEMPLATE/TILE_META partition
  itself is already exactly optimal — extend it, don't redesign it.

### M3 — `--target-size B`: the flagship solver (§5.2)

The single most user-facing coherence move: today no target archive size exists anywhere in the CLI, and a human
closes the loop over ~10 coupled knobs. Ship a budget mode in `stt-optimize` that runs a Lagrangian / MCKP sweep
over the admissible levers against M1's sample oracle:

- Feasible set: Θ₀ (zoom clamp, bucket width, LOD tiers, zstd, ordering, pack size) searched automatically;
  Θ₁ (quantization family) _proposed_ with shadow prices — the marginal bytes each lossy lever would buy — never
  auto-applied. The lexicographic no-thinning filter is inherited intact.
- Subsumes the recorded §12 gaps as side effects: composed-recipe re-measurement and 2–3 coordinate-descent rounds
  (§12.2), zoom-range chosen as a Pareto point instead of constraint equality (§12.3), summary-tier decisions as a
  measured cost comparison with `addedTierBytes` actually computed (§12.4), temporal-LOD (width, cutoff) pairs
  picked by budgeted greedy instead of the fixed 4×-step ladder (§2.4), and the per-dataset zstd/quantization
  ladder sweeps (§5.1, §3.1).
- Objective moved: archive bytes at fixed lexicographic distortion class; human build iterations to reach a
  publish size → ~1.
- Constraints: `--auto` still applies only reversible levers; every lossy proposal echoed loudly; advisor
  acceptance thresholds (0.05/0.03) retire in favor of shadow prices rather than accreting alongside them.

### M4 — A real workload model (the §6.4 gate, then everything else)

The ordering picker's surrogate workload is the _named_ gate on making `measured` the default (§6.3 PLANNED,
"gated solely on the workload-weighting question of §6.4") — and the fixed heuristic mis-picked 12 of 36 fleet
archives. One mechanism unblocks it and then feeds five more problems:

- Add the **third canonical query — playback**: a sliding window advanced sequentially over the band, costed with a
  buffered-runway term. This turns the order-audit's prose caveat (spatial ordering silently stalls playback —
  observed in production) into a ranked cost term. Weight the three queries per dataset from `layer_hint` / demo
  type, later from telemetry.
- Then: promote `measured` ordering to default; and reuse the same simulator to price **directory page breakpoints**
  (§7.2's DP over zoom-boundary/byte-balanced cuts — leaves are 54–69 % of cold-start bytes on sparse datasets),
  **pack-boundary nudging** (§6.5's shortest-path DP, keeping hot coalesced runs whole), **descriptor design**
  (§7.3's 8-byte min-bucket-start column), and eventually bucket width (§2.1) and tier cutoffs (§2.4/§7.5).
- Constraints: queries must be client-realizable (the whole-map-instant pan bias is a recorded corrected design);
  the simulator stays deterministic; never rank by request count alone (anti-lesson: the 669 MiB "2 reads =
  cheapest" incident).

### M5 — The client cost-oracle pass ("consult the directory")

One shared utility — _bytes required for (cell set × time window), from resident directory entries_ — consumed by
six controllers that currently guess. Pure client-side; no format change; ships incrementally.

- **Prefetch horizon as a feasibility solve** (§9.1): compute the largest horizon whose byte sum fits the cache
  fraction, replacing the AIMD ladder's fetch-evict-refetch transient (ladder stays as fallback). Metric:
  `cacheStats.runwayEvictions` → 0.
- **Governor fluid feasibility in one directory walk** (§11.1): catches "thin now, byte-cliff two windows ahead";
  gate constants re-fit from the estimator's variance (a quantile, not a point min).
- **Auto-speed evaluates the ladder** (§11.4): byte density per candidate speed, not only the current one.
- **Temporal-tier pick as a 1-D argmin** (§7.5): compare actual cost across the addressable tier set per
  (viewport, window) — losslessness makes any choice correct, so this is pure cost.
- **Placeholder fetch as expected value** (§8.3): size vs covered-area × expected-usefulness from the wired
  throughput estimator, replacing the flat 2 MiB cutoff. The cover DP also drops its depth caps (full bottom-up
  DP is O(|L|) and raises covered area at zero fetch cost).
- **Adaptive coalesce gap** (§6.2): G ← L̂·θ̂ from the dual-EWMA estimator, with the build-assumed gap co-versioned
  in the manifest (M7) so order-audit can flag reader/layout drift.

### M6 — Byte-honest budgets and priority continuity (client)

The D3 repair, in three clusters:

- **Scheduling:** DRR meters bytes, not slots (§9.3 mechanism; policy stays in §11); fairness weights gain β_i
  (bytes per sim-ms of runway) and move from the 1/x shed toward exact progressive filling (§11.3); enqueue budgets
  count bytes (§9.1); runway tolerance τ derives from per-source `temporalBucketMs`, not the probe interval
  (§11.2).
- **Decode:** a single pool-wide host queue with pull-on-idle ("strictly dominates immediate dispatch"), priority/
  deadline propagated into `DecodeArgs`, least-pending-bytes balancing, and wiring the dormant mid-pipeline cancel
  the worker already implements (§10.2); pool size adapts from the queue-wait telemetry the pool already emits
  (§10.1). The two recorded rejections (copy-at-enqueue; worker-side cancel queues) stay rejected.
- **Caches:** loop-aware eviction — rotate the distance metric at the loop boundary the governor already knows,
  fixing the "exact inverse of Belady" wrap pathology — plus byte-density scoring within tiers (§9.4); a
  playhead-aware score in the compressed LRU (looping playback is LRU's pathological worst case, §7.6); OPFS gains
  GreedyDual-Size eviction and an admission filter, with re-access probability estimated from the persisted index
  at zero I/O (§9.5).
- **Derived playback params** (§11.5): target duration from frame count K (12–30 data-fps band), window from
  per-bucket byte density — both computable at build time and emitted via `styleHints`, closing the §11.5↔§12
  wiring gap. Metric: hand overrides in the showcase → 0.

### M7 — Semantic honesty: validation and metadata

- **Semantic conformance invariants** in `stt-validate` (§13.2 gap): decoded-content fingerprints (bbox, count,
  simple statistical signatures) per archive. The recorded motivation: a defect that flattened and scrambled 106 AV
  archives _passed_ structural validation; the catch came from comparing export bboxes. This class must be caught
  by the validator, not by a human with an export tool.
- **Honest manifest bounds + z_range** (backlog K11): the builder computes the real geometry bbox (today a centroid
  bbox that provably under-states extent), and `z_range` lands as an additive field so volumetric datasets are
  discoverable. Also unblocks safe query-box pre-intersection in tile selection (§8.1's secondary note).
- **Coupling assertions:** record the build-assumed coalesce gap in the manifest next to `blobOrdering` (§6.2);
  assert script-side LOD bucket ≡ `--temporal-bucket` at build (§4.4's load-bearing constraint, currently two
  constants in two codebases); enforce or delete the dead `max_compressed_size` (§4.3's silent spec/behavior gap).

### M8 — Declared-tier unification (spec track)

Four _planned_ features are all the same spec concept — a **declared tier with a stated content contract** — and
should be designed once, not grown as four mechanisms:

1. Exact re-bucketed temporal-LOD tiers (exists today; contract = union).
2. **Additive home-zoom decomposition** (§1.1/§4.5): each feature at exactly one deterministic home zoom, reader
   unions — the O(N) corner of the assignment polytope vs today's O(|Z|·N) full replication (earthquakes: 523 K
   stored rows for 47.5 K quakes; the doctrine's recorded cost is "up to 11×"). Reader support (`lodMode:
'additive'`) already ships; the build-side assignment is the counted-out half. Trigger stands: per-zoom
   duplication dominating a dataset that matters.
3. **M4/MinMaxLTTB reduced tiers** (§13.3): the declared-variant escape that cuts zoomed-out playback bytes up to
   ~100× while the base tier stays lossless. Trigger stands: base-tier bandwidth-bound wide-window playback.
4. **The scrub temporal tier** (§11.6's G5): counted out until a genuinely byte-cheaper feature-_reducing_ tier
   exists — which is exactly (3).

Also on this track, as a spec erratum candidate rather than a tier: **long-lived interval segregation** (§2.2) —
one decade-long feature in a busy tile makes that tile a permanent fetch for every window; a per-bucket long-lived
sibling tile needs a relaxation of the no-duplication MUST. Heavy-tailed-duration datasets (trips, storm cells)
are the trigger.

---

## 4. Smaller builder items that batch with the next rebuild window

Each is independently recorded in the optimization doc; none justifies its own republish (P6):

- **Tile-relative line clip buffer** b(z) ∝ 2⁻ᶻ (§1.2): closed-form once stated; cuts deep-zoom seam duplication
  ~10–100× with zero new artifacts. Polygon side stays 0 — it is pinned optimal.
- **Metric simplification as default** (§1.3, DEFERRED explicitly awaiting a fleet republish): latitude-consistent
  generalization; the legacy degree table is up to ~2× inconsistent at 60°.
- **Temporal-LOD default zoom cutoffs** (§2.4): stop emitting every coarse tier at every zoom (today's default =
  maximal duplication); default the cutoff from the per-zoom byte mass stt-optimize already measures.
- **Adaptive-temporal exact DP + shared boundary snapping** (§2.3): the min-max partition is exactly solvable per
  cell; snapping window edges to a shared candidate set restores the enumerable-boundary contract that adaptive
  mode currently breaks for multi-cell prefetch (a recorded production gotcha).
- **Vertex-time menu extensions** (§2.5): an intermediate tier and bucket-anchored origins rescue wide temporal-LOD
  layers from the 2–4× exact-i64 fallback; ceiling coupled to playback speed rather than a flat 1000 ms.
- **Decoder-side single-ring earcut backfill** (§3.7): named in code comments as the cheapest fix; unlocks
  per-feature triangle omission worth a large share of the 40–45 % triangle bytes on polygon-heavy tiles. Reader
  change first, builder flag second.
- **Encode/flush double-buffering** (§1.4): byte-neutral (batch boundaries cannot change output), so it may ship
  any time — it just matters most during the R1 rebuild itself (the 9.5 h national storm build is the yardstick).

---

## 5. The do-not-touch register (consolidated)

Standing rejections and pinned optima the program must not re-litigate. Rationale lives in the cited sections.

**Do not repropose:** inter-timestep delta chains (§6.1, NO-GO, three guarantees broken at once); axis rebasing of
curve inputs (§6.3, lost three times); ranking orderings by request count or adjacency alone (§6.3); analytic size
models in place of sample measurement (§12.1's founding doctrine — wins ranged 1.07×–21× with no predictive
formula); sample-dependent type decisions (§13.2 — the conformance invariance rule); silent thinning anywhere
automated (§13.3); per-tile quantization grids (+61 % measured, §3.1); zstd 22 (19 ≈ 22 measured, §5.1);
copy-at-enqueue and worker-side cancel queueing (§10.2); the 3-attempt hard fetch gate (§8.4); Hilbert-key-range
leaf descriptors (§7.3); whole-map-instant surrogate queries (§6.4).

**Already optimal / load-bearing — extend, never replace:** the TEMPLATE/TILE_META partition (§3.8); the
observe/seal type lattice (§3.2); FNV-1a-64 ids and first-seen dictionary order (§3.6, §3.4); `part_offsets`
emission (§3.7); the coalescing fuse rule and the next-fit pack cut for their own cost models (§6.2, §6.5); the
fallback cover greedy given its caps (§8.3); B→C→D tiering under one-directional playback (§9.4); DRR's crediting
scheme (§9.3 — the prior variant is a recorded broken design); the two-threshold gating shape (§11.1); the
aggregate-rate recovery formula (§11.4 — the alternative is the recorded racing-ahead bug); irreversible readiness
write-off and camera-independent probing (§8.4); prefetch exemption from per-selection supersession and
all-members-superseded batch abort (§9.2); exact-selection/quantized-side-effects two-tier split (§8.5); authored
range semantics (§11.5); preview-never-gates and the restore invariant (§11.6); bucket-keyed LOD grids (§4.4 —
13 % → 65 % visible-bucket coverage; never revert to space-only).

---

## 6. The plan

Sequencing rationale: **(a)** B3 — the 0.6.0 cut — ships first and is untouched by this program; **(b)** client-side
mechanisms (M5, M6) carry no byte risk and ship continuously behind the existing test + browser-verify gates;
**(c)** measurement precedes controllers wherever the doc demands it (K10; the §11.6 deletion clause); **(d)** all
byte-changing builder work lands in **one rebuild window (R1)** with one fleet republish under the standing
packs → frontend → manifests procedure; **(e)** spec-track work (M8) is designed early but implemented
trigger-gated.

### Phase 0 — Baseline and hygiene (days)

- Commit the optimization-problems doc and this record; graduate the adopted items into the backlog (§7).
- **Re-run the cold-start capture (K10)** against the republished fleet — it is both a stale-claim repair and the
  baseline every §7 (directory) decision in M4 prices against.
- Inventory the metric harnesses each later phase cites: `tools/bench/src/frame-cost.mjs`, `getQoeStats()`,
  `ordering_sim`, `stt-optimize inspect/diff`, the pitch×bearing selection matrix.
- Run the §11.6 scrub measurements (time-to-first-pixel, fresh-frame fraction, bytes-during-scrub) — the recorded
  keep-vs-delete decision for the scrub-LOD wiring hinges on them, and they are cheap.

### Phase 1 — Client-side wins (M5 + M6; weeks, incremental)

No format changes; every item lands with its named metric. Suggested order by measured pain: prefetch horizon
feasibility + byte-metered budgets (§9.1/§9.2/§9.3) → loop-aware + byte-aware eviction (§9.4/§7.6) → decode
priority continuity + cancel wiring (§10.2) → cadence-derived runway tolerance (§11.2, metric: stallCount on the
radar+fronts composite) → governor/auto-speed oracle consults (§11.1/§11.4) → tier argmin (§7.5) → placeholder
value rule + cover DP de-capping (§8.3) → adaptive coalesce gap (§6.2, needs M7's manifest co-versioning for the
build-assumed gap) → derived playback params via styleHints (§11.5, cross-package wiring with stt-optimize) →
OPFS admission/GDS (§9.5). Acceptance: QoE counters and frame-cost benches on the storm, AV (`/drive`), and
multi-source composite routes; no regression on the single-source demos.

### Phase 2 — Oracle and advisor upgrades (M1 + M4; weeks)

Stratified sampling + dispersion + leave-one-out attribution; composed-recipe re-measurement and 2–3
coordinate-descent rounds in `recommend`; doctor moves to byte-ranked joint what-ifs with measured (not 0.6-prior)
shrink estimates; the playback query + per-dataset weights land in the ordering surrogate; **`measured` ordering
becomes the default** once the weighting question closes (the recorded gate). Acceptance: recommended-recipe bytes
vs best-of-grid on fixture datasets; re-ranked fleet ordering audit; zero nondeterminism (byte-identical re-runs).

### Phase 3 — The flagship (M3; after M1)

`--target-size B` in `stt-optimize recommend` + `stt-build --auto` handshake. Acceptance: hits publish budgets on
the showcase fleet within one build; shadow-price report for lossy levers; no-thinning filter demonstrably intact
(attempting to reach an infeasible B reports the lexicographic floor instead of dropping features).

### Phase 4 — The two-pass build and rebuild window R1 (M2 + §4 batch + M7)

Everything byte-breaking in one window: global attribute-range pin + dictionary hoist + dict verdict + id
renumbering (M2); honest bounds + `z_range` (K11); metric simplification default; tile-relative clip buffer;
temporal-LOD cutoff defaults; vertex-time menu; compact-time menu extensions. Semantic-fingerprint validation (M7)
lands _first_ and is the acceptance gate for the rebuild. Golden byte pins change once, intentionally, reviewed.
Fleet republish once (`--no-prune`, standing 15-second-exposure ordering), then **re-run the K10 capture** so the
cold-start record describes the fleet that exists. Expected headline: pack-byte reduction of packed-v2 magnitude on
categorical-heavy datasets (the 33.6–43.9 % dictionary share bounds the prize), K2 noise → 0.

### Phase 5 — Selection and spec track (parallel, trigger-gated)

- **Frustum-quadtree tile selection** (Wave 3/A1, §8.1/§8.2): the per-tile-zoom walk (47 vs 754 tiles at equal
  coverage; ~10–16× pitched-view fetch reduction). Client-side but large; subsumes §8.2, so no §8.2 tuning happens
  before it.
- **Declared-tier spec design** (M8): one declaration mechanism reviewed once; home-zoom and M4 tiers implement
  behind their recorded triggers; the scrub tier decision follows the Phase 0 measurements.
- **Interval-segregation erratum** (§2.2) drafted only if a heavy-tailed-duration dataset shows the
  read-amplification in the K10-refreshed numbers.

### What this program explicitly does not schedule

Respecting recorded triggers and counted-outs: per-region adaptive summary resolution (§4.1), sketch-backed
percentile aggregates (§4.2), `--auto-measure` closed-loop builds (§12.1 — deferred until doctor/inspect prove
demand), the Funkhouser–Séquin scrub controller (§11.6 — measure first), and anything in §5's register.

---

## 7. Proposed backlog graduation (for the adopting pass)

Per the house rule that open work lives only in [the backlog](./README.md), adoption means adding lines like:

- **O1 (Phase 0/1).** Client oracle + byte-honest budgets: §9.1 horizon feasibility, §9.3 byte metering, §9.4 loop
  rotation, §10.2 priority continuity, §11.2 cadence tolerance. _Accept:_ named QoE metrics move on the composite,
  storm, and `/drive` routes; `runwayEvictions → 0` under looped playback.
- **O2 (Phase 2).** Measurement oracle v2 + workload model; `measured` ordering default. _Accept:_ stratified
  sampling with dispersion shipped; ordering re-audit shows ≥ the 12/36 correction; deterministic re-runs
  byte-identical.
- **O3 (Phase 3).** `--target-size`. _Accept:_ one-build publish-budget hit on three showcase datasets; lossy
  levers surface as shadow prices only.
- **O4 (Phase 4).** Two-pass build + rebuild window R1 (with K11). _Accept:_ semantic-fingerprint validate green
  fleet-wide; K2 warnings zero; K10 re-captured post-republish.
- **O5 (Phase 5).** Frustum selection Wave 3/A1; declared-tier spec. _Accept:_ pitched-camera fetch bytes ~10×
  down at verified coverage; one reviewed tier-declaration mechanism.

# The spatiotemporal semantics of STT: formal-model review and plan

_2026-08-11 · derived from a six-track whole-repo read of the geospatial and
spatiotemporal logic: the Rust format core (`stt-core`), the build pipeline
(`stt-build`, `stt-optimize`), the TypeScript delivery layer
(`@poopdeck.gl/core`), the playback layer (`@poopdeck.gl/playback`), the four
renderer backends, and every existing spec/conformance surface. File:line
citations were read from real code at HEAD on 2026-08-11 — re-verify before
acting on them later._

> **Audit snapshot.** This document preserves findings as they were observed.
> C2 and C3 were resolved in the August 24 launch documentation pass; current
> format truth lives in `docs/spec/stt-packed-format.md` and
> `docs/architecture/data-format.md`.

This is the fourth document in the formalization family. The trilogy —
[optimization-problems](./optimization-problems-2026-08.md),
[optimization-informed-design](./optimization-informed-design-2026-08.md),
[optimization-implementation-plan](./optimization-implementation-plan-2026-08.md)
— formalizes the project's **decisions**: 66 optimization problems whose
objectives and constraints quantify over tile grids, temporal buckets,
encodings, coverage relations, and playback states. Those objects themselves
are defined today only by code and partial prose. This document is the plan for
the missing layer beneath the trilogy: **a single formal mathematical model of
the geospatial and spatiotemporal logic itself** — the spaces, the mappings
between them, and the invariants they must satisfy — stated so that (a) every
optimization problem becomes well-posed over defined objects, and (b) the
logic becomes checkable: laws bound to tests, implementations bound to oracles,
validity bound to semantics rather than structure.

**Why this matters for the product.** The product thesis is a simple UX backed
by sophisticated solutions for space+time visualization. The review found the
sophistication to be real and unusually deep — 84 distinct laws already
enforced by tests, byte-deterministic builds, a two-oracle render kernel, a
one-ulp numerical-analysis argument sitting in a doc comment. But the
sophistication is currently **ahead of its own specification**: it is scattered
across code comments, test names, five spec documents of very different rigor,
and one JSON contract. Every failure mode that threatens the simple UX —
silently wrong pixels (the 106-archive coordinate scramble that _passed_
`stt-validate`), silently divergent renderers (two incompatible arc-height
formulas shipping today), silently stalled playback (`blobOrdering=spatial`) —
is a place where a real invariant existed in someone's head and nowhere
checkable. The formal model is how "works because the author is careful"
becomes "works because the contract is machine-checked."

---

## 0. Scope and relation to the trilogy

- **In scope:** the semantics — coordinate systems and projections, tile and
  cell address algebras, space-filling curves, quantization mappings, the time
  model (instants, intervals, buckets, windows, LOD), dataset/archive
  semantics (tiling, clipping, encoding, determinism, aggregation), delivery
  semantics (selection, cover, coverage/runway, eviction), playback control
  semantics (clock, gate, fairness), and the renderer-side interpretation
  kernels that must agree across backends.
- **Out of scope:** the optimization problems themselves (owned by the
  problems doc), GPU plumbing and frame pacing (owned by the render backends),
  and the schedule (owned by the backlog — this document proposes work but
  does not edit the backlog).
- **Division of labor with the implementation plan:** where a gap identified
  here already has an owner in the implementation plan (notably M7 "semantic
  conformance + honest metadata" = SH-1..6), this document supplies the
  _definitions_ those items need and cross-references them; it does not
  re-propose the work. Anything byte-changing that falls out of this program
  batches into the R1 rebuild window per the informed-design sequencing rules
  — never dribbles.

---

## 1. State of the estate — what the review found

### 1.1 The ten mathematical domains

The geospatial/spatiotemporal logic decomposes into ten domains. For each: its
home, its exemplar objects, and its current formalization level.

| #   | Domain                   | Home                                                                                          | Exemplar objects                                                                                                                          | Current rigor                                                                                                                                                                                                                           |
| --- | ------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Projection & tile grid   | `stt-core/src/projection.rs`, `packages/core/src/geo/mercator.ts`, `archive.ts`               | Web-Mercator forward/inverse, `MERCATOR_MAX_LAT`, slippy `(z,x,y)`                                                                        | **High in code** (one-ulp lemma with pinning test), scattered; two lat→row copies with different guards                                                                                                                                 |
| 2   | Address algebra & curves | `tile.rs`, `curve.rs`, `pack/mod.rs`                                                          | `TileId`, 2D Hilbert (normative vectors), 3D Hilbert/Morton, sort keys                                                                    | **Highest**: spec §4 pseudocode + 24 vectors + reference reimplementation; but three different "directory orders" coexist                                                                                                               |
| 3   | Quantization             | `arrow_tile/quantize.rs`, `columns.rs`, `tile.ts`                                             | World-anchored coord affine, attr affine `v = o + q·s`, vertex-value 0xFFFF sentinel, vertex-time delta tiers                             | **Good**: decision tables in `data-format.md`, `{:.17e}` byte-pinned; rounding modes inconsistent across maps (round vs floor vs truncate) and unstated                                                                                 |
| 4   | Time model               | `timestamp.rs`, `docs/spec/time-model.md`, `tiler.rs`                                         | Unix-ms wire unit, `bucket(t)=⌊t/Δ⌋·Δ`, LOD pyramid divisibility, interval semantics                                                      | **Mixed**: bucket algebra is the most mathematical spec text in the repo; but `timeWindow = [t±w/2]` — the single most load-bearing temporal fact — appears in no normative doc, and `--adaptive-temporal` violates the spec's own MUST |
| 5   | Archive semantics        | `pack/`, `directory*.rs`, `encode.rs`, golden fixtures                                        | Content addressing, determinism, canonical orders, round-trip laws                                                                        | **Strong via tests** (L1–L33 below); encode is one-oracle everywhere; `t0 = min(start)` is test-pinned but spec-unstated                                                                                                                |
| 6   | Build geometry           | `stt-build/src/{tiler,clip,simplify,summary,quadbin}.rs`                                      | Multi-zoom assignment, Liang–Barsky/Sutherland–Hodgman clipping, antimeridian split, per-zoom simplification ladder, H3/Quadbin anchoring | **Test-strong, spec-absent**: the antimeridian suite asserts area conservation and ring simplicity — the only end-to-end numeric conservation law in the pipeline — yet none of it is written down outside the tests                    |
| 7   | Delivery/selection       | `packages/core/src/{archive,spatiotemporal-tileset,tile-budget}.ts`, `geo/viewport-bounds.ts` | Viewport repair, tile-cover lattice, coverage index, runway, 4-tier eviction, EV parent gate                                              | **Code-formal**: dense in-source derivations (the `p.tMin` prune bound has a written proof) but zero spec presence; three different "covered" predicates                                                                                |
| 8   | Playback control         | `packages/playback/src/*`                                                                     | Clock dynamics, gate conditions, watermark re-fit, fluid feasibility, DRR fairness, auto-speed ladder                                     | **Test-strong** (a 3,917-line governor suite), spec-weak: time-model §6 documents a fraction of the shipped surface; the roadmap doc describes the _legacy_ fairness formula                                                            |
| 9   | Presentation kernels     | `packages/core/src/render/*`, four backends                                                   | Time-filter α (two oracles), trips interpolation, cells, arcs, heatmaps, seam masks, picking                                              | **Bimodal**: the α kernel is the best-specified math in the repo (`render-spec.json`, 12-op algebra, two independent derivations); everything else is prose with measured divergences                                                   |
| 10  | Estimators & measurement | `stt-optimize/src/*`, `ordering_sim.rs`, `throughput.ts`                                      | Leave-one-out attribution, ratio-estimator stderr, sample-encode oracle, EWMA throughput/latency                                          | **Discipline-formal**: the MO-4 one-layout invariant and one-sided noise gates are stated and enforced; the estimators' semantics (what is measured vs estimated vs prior) is labeled in code, unlabeled in any spec                    |

### 1.2 What is already formal — build on it, do not duplicate it

The audit of existing formal surfaces found more than most projects ever
accumulate. The model should **harvest** these, not restate them:

- **Laws enforced by tests.** The review catalogued **84 distinct laws** the
  test suite already enforces, spanning: encoder determinism (byte-identity
  across runs, insertion orders, and thread schedules — `reproducible_build.rs`,
  `reproducible_pipeline.rs`), round-trip exactness modulo canonical row order
  (proptests in `adversarial_decode.rs`), decoder totality under byte soup and
  mutation, schema locks (`spec_conformance.rs`), golden byte pins
  (`v2_golden.rs` + five TS fixture families), cross-language pins (capability
  registry and manifest schema as 3-way fixed points; Hilbert triple-pinned
  against a from-spec-text reference implementation), validator laws
  (`stt-validate`: covering descriptors admit false positives only; the drift
  classifier's invariance rule "decisions factor through the column's domain,
  never the tile's sample"), the render-kernel two-oracle equivalence (2000
  randomized samples × 4 modes), antimeridian area conservation and ring
  simplicity, and optimizer measurement invariants (MO-4; attribution bounds
  `0 ≤ marginal ≤ whole`).
- **In-code lemmas.** Several code comments are genuine theorem statements
  with proofs-by-test: the `MERCATOR_MAX_LAT` one-ulp-inward argument
  (`projection.rs:36–45`, pinned by `f64::from_bits(nearest−1)` equality);
  the near-pole cancellation analysis in `latToTileY`
  (`archive.ts:5095–5119`); the paged-prune upper bound
  `p.tMin ≤ coverTMin < timeStart + bucketMs` with its written proof
  (`archive.ts:3084–3105`); the `ordering_sim` coalescer fast-path equivalence
  argument, cross-validated against brute force.
- **The two-oracle render contract.** `docs/spec/render-spec.json` freezes a
  12-op expression algebra (`step`, `clamp01`, lazy `select`, …) with two
  independently derived oracles (`time-filter.ts` if-form vs `shader-codegen.ts`
  branchless AST) and four per-backend conformance obligations. It has already
  caught two real specification ambiguities (`wakeLength ≤ 0`, negative
  `fadeIn`). This is the template the rest of the presentation layer needs.
- **Spec documents with real formal content.** `stt-packed-format.md` §4
  (normative Hilbert pseudocode + vectors) and the byte grammars;
  `time-model.md`'s bucket formulas and 10-item MUST list; `conformance.md`'s
  executable check list; `manifest.schema.json` as a machine-checked 3-way
  fixed point; the §13.1–13.3 mathematics in the problems doc (build
  determinism `∀π,π',σ,σ'`, descriptor covering `D(p) ⊇ ⋃`, the lexicographic
  no-thinning program over `Θ = Θ₀ ⊔ Θ₁ ⊔ Θ₂ ⊔ Θ_∞`).

### 1.3 The five gap classes

Everything wrong with the current state falls into five classes. These drive
the plan's structure.

**A. Scattering and non-uniform statement.** The same fact is stated in three
places or zero. `M_PER_DEG_LAT = 111 320` has three copies (Rust quantizer, TS
ENU, TS track kernel); the seam-span constant 350° has two TS copies (pinned
to each other, but only by comment); four different Earth radii coexist
(6 371 000, 6 371 008.8, 6 378 137, and deck's rounded circumference), each
individually justified, nowhere reconciled as a policy. Meanwhile
`timeWindow`'s centered semantics, the buffered-ranges conjunction, the tile
cover lattice, and the entire playback gate have **zero** spec presence.
Interval-boundary conventions (closed vs half-open, `≤` vs `<`) differ across
adjacent APIs (four readiness APIs disagree about the bucket ending exactly at
the probe start).

**B. The one-author oracle problem.** Format _decode_ is genuinely two-oracle
(the TS reader independently implements LEB128/zig-zag, BLAKE3, CRC-32C, the
paged root, the frame walker) — but both implementations have one author, and
the WASM crate is explicitly the Rust reader compiled small, not a third
implementation. Format _encode_ is one-oracle everywhere, compensated only by
byte pins and determinism tests. The reader-side prune predicate, LOD
selection, and playhead semantics are TS-only — WASM/Python consumers get no
reference. "Independently implementable from the spec" is an untested claim.

**C. Structural validity ≠ semantic correctness.** The single largest recorded
gap (problems doc §13.2): a v1→v2 `reoptimize` defect flattened and scrambled
coordinates in 106 AV archives and **passed `stt-validate`**; the catch came
from comparing exported bboxes. The validator checks structure (schemas, CRCs,
covering, drift) but no property of the decoded _content_. The implementation
plan's M7/SH items own the fix; what they lack is the formal definition of
_which_ semantic invariants pin an archive — exactly what the model supplies.

**D. Divergences and hazards awaiting adjudication.** The review consolidated
~90 concrete findings: 18 cross-backend math divergences (§5.2), 16
client-delivery hazards (§5.3), 18 core-format asymmetries (§5.4), 15
playback drift items (§5.5), plus build-pipeline anomalies and
known-approximate quantities (§5.6). Each needs one of three verdicts —
**bless** (state it as intended semantics), **fix** (it is a defect), or
**document** (acceptable divergence, declared). None of these verdicts exist
today; the formal model is where they get recorded and enforced.

**E. Unformalized subsystems.** Whole domains have no spec at all: the
playhead/clock (loop, bounce, external-clock), the selection/cover lattice
(three "covered" predicates), aggregation-cell geometry (three quadbin decode
copies, divergent coverage-inset spaces), presentation kernels beyond the α
scalar (arcs, heatmaps, splats, interpolation, elevation, picking, color
space), and the build-side geometry operators (clip buffers, antimeridian
split, simplification ladder) whose laws currently live only in tests.

### 1.4 Live contradictions found (fix before anything builds on them)

The review also caught outright defects in the formal surfaces themselves —
these are not gaps but contradictions, and they are cheap to fix:

1. **Three vacuous adversarial tests.** `adversarial_decode.rs:443,457,471`
   construct doctored directories with version byte `5`; `DIRECTORY_VERSION`
   is `6` and the version check precedes the guards under test, so all three
   allocation/overflow-guard regressions pass vacuously on the version
   mismatch. One byte per test restores them.
2. **Spec §4 v5/v6 drift.** `stt-packed-format.md` §4's heading and body say
   directory v5 while its own layout block, `manifest.schema.json`,
   `directory.rs:126`, and `directory.ts:31` all say 6 — and §9.1 describes
   "the planned v6" as future work that is not what shipped.
3. **Stale single-file container spec.** ~60 lines of byte-exact spec in
   `data-format.md` for a container `conformance.md` says was removed.
4. **Broken fixture generator.** `make-v2-golden.sh` still passes the removed
   `--format-version` flag; two TS golden families are unregenerable until it
   is fixed.

---

## 2. The formal model — architecture

The model is a layered semantics. Each layer defines objects and total
functions over the previous layers, states its laws as numbered invariants,
and names its binding tests. The layering rule: **a layer may only mention
objects defined at or below it** — which is precisely what makes the
optimization problems (which live above) well-posed.

### 2.0 Notation and authoring conventions

- One notation file, shared with the problems doc's conventions ($F$ features,
  $z$ zoom, $T_z$ tile grid, $\Delta$ bucket width, …), extended with the
  symbols defined below. KaTeX in markdown, consistent with the trilogy.
- Every definition carries: (i) the mathematical statement, (ii) the exact
  floating-point/rounding realization (rounding mode, bit width, clamp
  behavior — these are part of the semantics, not implementation detail),
  (iii) `file:line` of each implementation, (iv) the agreement class between
  implementations (see §2.7), (v) the binding tests.
- Every law gets a stable ID (`SEM-<layer>-<n>`) and a status:
  **proven-by-test** (cite), **asserted** (code comment/assert only),
  **implicit** (relied on, nowhere stated), or **violated-once** (with the
  incident). The law registry (§2.8) is the index.

### 2.1 Layer 0 — spaces and carriers

Defined sets, with their machine carriers:

- Geographic space $S = [-180,180] \times [-\varphi_{max}, \varphi_{max}]$,
  $\varphi_{max} = \arctan(\sinh \pi)$, machine representative the one-ulp-inward
  f64 `85.051_128_779_806_59`. Law SEM-0-1: every pipeline site **clamps**
  latitude to $\pm\varphi_{max}$ and never rejects (no-thinning at the poles);
  longitude outside $[-180,180]$ is a _wrap_ problem owned by the antimeridian
  operators, not a clamp. (Status: proven-by-test in Rust; the clamp constant
  is bit-identical in TS.)
- Mercator unit square $M = [0,1)^2$; world-tile space $M_z = 2^z \cdot M$;
  tile lattice $T_z = \{0,\dots,2^z-1\}^2$; the address space
  $A = \{(z,x,y,t,v) : z \le 22,\ (x,y) \in T_z,\ t \in \mathbb{T},\ v \in V\}$
  with variant set $V$ (raw = 0, summary = 1) **part of identity**.
- Time axis $\mathbb{T} = $ Unix milliseconds carried as u64 (wire) /
  f64-safe-integer (TS); pre-1970 excluded from the index domain (hard error,
  not clamp). Bucket lattice $B_\Delta = \{k\Delta\}$.
- Quantized lattices: the world coordinate grid $Q_m$ with origin
  $(-180,-90)$ and step $m/111320$ degrees (world-anchored — Law SEM-0-2: the
  grid origin is global, never per-tile; the recorded justification is
  content-address dedup, measured +61 % loss under a per-tile grid); attribute
  lattices $(o, s)$; the vertex-value lattice with sentinel $\mathtt{0xFFFF}
  \mapsto \mathrm{NaN}$; cell spaces $H3_r$ ($r \le 15$) and $QB_z$
  ($z \le 26$, header/Morton layout as pinned constants).

### 2.2 Layer 1 — the coordinate and address algebra

The total functions between Layer-0 spaces, each with its exact rounding
realization:

- $\mathrm{proj}_z : S \to M_z$ (forward Mercator in world-tile units) and its
  inverse; the **agreement caveat** that the TS render-side Mercator is the
  mathematically-equivalent-but-not-bit-identical metres form
  ($R\ln\tan(\pi/4+\varphi/2)$) — an agreement-class fact the spec must state.
- Tile assignment $\tau_z = \lfloor \mathrm{proj}_z \rfloor$ with saturation
  at the world edge (`.min(n−1)`, negative-cast saturation) and the NaN
  guard ordering (finite-check before clamp, because `clamp` propagates NaN
  and `NaN as u32` files features into tile (0,0)).
- The parent/child lattice $\pi(z,x,y) = (z{-}1, \lfloor x/2 \rfloor,
  \lfloor y/2 \rfloor)$; Law SEM-1-1: $t$ and $v$ are $\pi$-invariant (spatial
  coarsening never re-buckets time).
- Curves: $h_2 : T_z \to [0, 4^z)$ the discrete Hilbert curve at order $z$
  (bijection; unit-step adjacency; the 24 normative vectors; the f64-curve
  collision failure mode at $z \ge 14$ recorded as a rejected design);
  $h_3, m_3 : T_z \times B \to [0, 2^{3b})$ Skilling/Morton on the capped cube
  ($b \le 21$), with the per-tile `tbits` recomputation in `scale_axes`
  flagged for adjudication (it makes the scaled time axis non-monotone in
  degenerate regimes — §5.4).
- Sort keys as lexicographic products, with the finding that **three distinct
  "directory orders" coexist** (`directory.rs` `(z,h,t,variant)`;
  `directory_page.rs` `(z,h,t,bucket)`; `pack/mod.rs` 5-tuple) — the model
  defines _the_ canonical order and the others become derived projections or
  get fixed (§5.4 item 1).
- Quantization maps $q_{(o,s)}(x) = \mathrm{round}((x-o)/s)$ and
  $dq(k) = o + k s$, with the **rounding-mode table** as first-class law
  content: coordinate/attribute quantization rounds half-away-from-zero and
  clamps (silently for x/y, error for z); vertex-time deltas **truncate**
  (error biased downward in $[0, \mathrm{step})$); timestamp unit scaling
  truncates toward zero while bucket indexing floors (`div_euclid`) —
  divergent for the signed property path. Round-trip laws with explicit error
  bounds: $|dq(q(x)) - x| \le s/2$ (round) vs $[0, s)$ (truncate), and the
  derived **geodesic error bound** per zoom/latitude that §3 needs for
  distortion objectives.
- Content addressing: $h = \mathrm{blake3}_{128}$ over whole objects
  (prelude included), CRC-32C over compressed blobs; the identity laws that
  make dedup sound.

### 2.3 Layer 2 — the time algebra

- Instants, intervals, and the **interval-convention catalog** as normative
  content: feature validity $[t_0, t_1]$ closed; bucket assignment
  $[k\Delta, (k{+}1)\Delta)$ half-open by start time; render window
  $[t - w/2,\ t + w/2]$ **centered** (three implementations agree; no spec
  states it — this law, SEM-2-1, is the single highest-value one-liner the
  spec adds); wake asymmetric past-only; trail $[t-L, t]$; the documented
  reconciliation "assignment places bytes, validity drives pruning".
- Bucketing $\beta_\Delta(t) = \lfloor t/\Delta \rfloor \Delta$, epoch-aligned,
  equal-width — and the finding that `--adaptive-temporal` produces
  variable-width windows keyed to the first feature's timestamp, violating
  the time-model MUST and silently corrupting the TS coverage index's uniform
  `b + Δ` arithmetic. Verdict needed: either adaptive becomes a **declared
  tier variant** with its own bucket-edge table, or it is withdrawn (§5.5).
- The temporal-LOD pyramid as a divisibility chain: $\Delta_i \mid \Delta_{i+1}$,
  strictly ascending, all multiples of the base; selection = coarsest level
  with $z \le \mathrm{maxZoomLevel}$; the **losslessness law**
  $\mathrm{content}(\text{coarse bucket}) = \bigcup \mathrm{content}(\text{base buckets})$
  (time-model's normative content contract).
- Entry temporal metadata: $t_{start}$ = bucket edge; $t_{end}$ = max feature
  end (tightness validated); $\mathrm{coverTMin}$ = min feature start (**no
  writer-side tightness MUST exists today** — a too-late value silently loses
  tiles; the model states the law, SH implements the check).
- The prune predicate as _the_ two-sided law:
  $\mathrm{overlap}(e, W) \iff t_{end}(e) \ge W_{start} \wedge
  (\mathrm{coverTMin}(e)\,\text{??}\,t_{start}(e)) \le W_{end}$ — currently
  TS-only; the model makes it implementation-neutral so the Rust/WASM side can
  grow a reference (§4).
- The f32 relativization scheme as a stated precision contract:
  $|t - \mathrm{offset}| \le 2^{24}$ ms for exactness, offset per temporal
  chunk, `NEVER_ENDS` = exact f32 max (with the recorded deck rewrite-to-0
  hazard for actual `Infinity`).

### 2.4 Layer 3 — dataset and archive semantics

- A dataset $D$ is a finite set of features
  $f = (\mathrm{id}, g, [t_0,t_1], \mathrm{vt}, p)$ with $g$ a geometry over
  $S$, optional per-vertex times $\mathrm{vt}$, and typed properties $p$. The
  archive is a representation $\rho(D)$; the base tier is **exact**:
  $\mathrm{decode}(\rho(D))$ reproduces every feature (round-trip laws L9/L10,
  modulo the canonical row order — stable sort by start time — which the model
  states as the quotient the equality lives in).
- Tiling as a **multi-zoom cover, not a partition**: the clip operator
  $C_{z,x,y}$ with per-kind buffers (lines 0.001°, polygons exactly 0 — the
  watertightness precondition for seam masks), feature identity preserved
  across copies. The completeness law (no-thinning) in Layer-3 form: for every
  query box, decode∘fetch ⊇ the true answer — the same constraint §13.3 of
  the problems doc states lexicographically.
- The **antimeridian split operator** with its (currently test-only) laws
  promoted to spec: net-area conservation (asserted at z1 to $10^{-9}$), ring
  simplicity, no surviving wrap edge ($|\Delta\lambda| \le 180$), split pieces
  land on both edge columns and no interior column, the `±360` unwrap
  accumulator and the unsplittable test $|\mathrm{offset}| > 180$.
- Build determinism as the Layer-3 headline law (already formal in §13.1):
  $\mathrm{Build}(D,\pi,\sigma)$ independent of permutation and schedule,
  byte-for-byte per object — the model records which sub-laws compose into it
  (total tiebreak orders, BTreeMap canonicalization, pinned degenerate
  affines, pure-integer simulator).
- **Aggregation semantics** (summary tiers) as monoid pushforwards: cell
  assignment (H3 anchors by _centroid's_ tile, resolution $\min(z,15)$;
  Quadbin by feature tile, zoom $\min(z{+}3, 26)$), aggregate functions with
  their algebra (count/sum/min/max additive; **mean not re-aggregable** —
  stated so nobody ever tries), sub-bucket assignment
  $i = \min(\lfloor (t-b)/w \rfloor, N{-}1)$ with $w = \max(\lfloor \Delta/N
  \rfloor, 1)$ (currently untested — a one-liner property test, §6 FM-5), and
  the additivity doctrine: summary is a _declared additional_ representation,
  never a replacement (variant coexistence law).
- Conformance as the constraint system (§13.2 restated over these objects),
  now extended with **semantic invariants**: the decoded-content fingerprint
  family (bbox of decoded coordinates, time-range, feature counts, per-column
  moments/percentiles) that would have caught the coordinate scramble. The
  model defines the fingerprint functions; SH-1..6 implement recording and
  checking; byte-affecting parts ride R1.

### 2.5 Layer 4 — query and delivery semantics

- A query $q = (V, z, W)$: viewport, zoom, time window. Selection
  $S(q) \subseteq A$ with the **soundness law**: every feature intersecting
  $V \times W$ lies in some selected tile. Stated with its two current
  caveats, both adjudicated in §5: `metadata.bounds` is a centroid bbox that
  provably does not bound the data (the reader compensates by never
  intersecting against it; the builder fix rides B2/R1), and the two
  lat→row implementations differ in pre-clamping (H1).
- The viewport-repair function `normalizeViewportBounds` as a specified
  total function (ordered rules, idempotence, the 350° seam discriminant, the
  never-wrap-longitude contract) — it is the load-bearing fix from the 3D
  tile-loading campaign and deserves spec text next to the campaign's binding
  bounds contract.
- The **cover lattice**: parent/child fallback as an order-theoretic
  structure, with the finding that three different "covered" predicates
  coexist (fetch-side expected-value gate; render pass 2's clamped
  any-uncovered-cell rule with slack ring; the ancestor DP's wholly-blank
  rule). The model states all three and their intended relationship
  (deliberately monotone: fetch ⊆ retain ⊆ draw), plus the additive mode's
  deliberate antichain violation (disjoint home-zoom sets).
- Coverage/readiness semantics: the coverage index, `isCoverageReady` as a
  monotone latch, the runway walk and buffered-ranges conjunction — including
  the boundary-bucket `≤`/`<` asymmetry across four APIs (H4) and the
  **stall theorem**: under spatial-major byte order the conjunction never
  completes a bucket, hence empty ranges, hence a permanently gated clock —
  the formal statement of the `blobOrdering=spatial` playback gotcha, which
  turns a folklore rule into a checkable precondition (and motivates WM-1/2's
  playback query in the simulator).
- Eviction as a priority relation (4 tiers, playhead-relative, loop-modular
  arithmetic with its degeneracy clamp), prefetch as a bounded-horizon policy
  (gate-floor law: no mechanism may cut below
  $\max(\Delta, w, |s| \cdot 5000)$), the DRR byte-fairness invariants
  (progress guarantee via $\min(\mathrm{cost}, \mathrm{quantum})$ admission;
  bounded deficits; share convergence to $w_i/\sum w$), and the scheduler
  price/priority algebra.

### 2.6 Layer 5 — playback control semantics

- The clock as a hybrid system: $\dot t = \mathrm{speed}$ with the frame-delta
  clamp, boundary maps (loop teleport / bounce reflection-with-saturation /
  clamp+ended, bounce precedence), and the explicit non-laws (monotonicity NOT
  guaranteed; seek paths never clamp — range enforcement only inside the step
  function). Names the three loop modes formally (they are named but undefined
  in the spec today).
- The governor as a guarded automaton: states, the gate condition
  ($\mathrm{runway} \ge \mathrm{gate}\cdot|s|\cdot\mathrm{factor}$ ∨ predicted
  playthrough ∨ timeout→degraded), watermark with the jitter re-fit and its
  never-into-the-start-gate invariant, the frontier clamp with the
  external-seek reclassification bound ($|s|\times 1000$ ms), fluid
  feasibility as a deadline-sweep feasibility check with an abstention
  discipline, the multi-source runway fold (min over incomplete with the
  leader lift band), fairness caps/weights with hysteresis, and the two
  standing do-not-touch results (the $\max_i(b_i/\mathrm{eta}_i)$ recovery;
  request-count ranking rejection).
- **Safety properties** stated as such: the playhead never travels beyond the
  buffered frontier except by reclassified external seek; a gate freeze keeps
  prefetch alive (`setAnimationState(true)` re-assertion — the recorded
  deadlock otherwise); scrub previews never pass gates; degraded creep is
  entered loudly and re-armed only on measured recovery.
- The units discipline (wall-ms vs sim-ms vs bucket counts, conversions by
  $|s|$) as a typed dimension system — half the historical playback bugs in
  the record are unit or fold-rule confusions (four different multi-source
  fold rules across four adjacent APIs).

### 2.7 Layer 6 — presentation kernels and the parity contract

The α kernel already has the right structure; the model generalizes its
machinery to the rest of the render math. Two moves:

1. **Agreement classes as a type system.** Every cross-implementation quantity
   gets one of five declared classes: `bit-identical` (e.g. the lat clamp,
   `{:.17e}` affine JSON, frame tags), `ulp-bounded` (the fadeTrail fma-form
   divergence, ≤1 ulp), `tolerance(ε)` (numeric sweeps, 1e-6), `structural`
   (shader-source string locks — with the honest caveat that this class
   cannot detect semantic drift), and `declared-divergent` (with the reason:
   e.g. cesium's arc-length fadeTrail, maplibre's camera-owner Earth radius).
   The review's divergence catalog (§5.2) is the input; every entry ends up
   in a class or in a fix.
2. **Spec entries per kernel**, on the render-spec template (definition +
   oracle + obligations): trips/track interpolation (two distance metrics
   today — adjudicate), arcs (**two incompatible height families ship today**:
   $\sqrt{t(1-t)}\cdot d$ vs $4t(1-t)\cdot\mathrm{chord}$ — a factor-2 apex;
   this is a fix, not a class), heatmap kernels (different Gaussians and
   normalization — bless-or-fix), cell geometry (one quadbin decode in core
   instead of three copies; coverage-inset space; pole/antimeridian handling
   currently maplibre-only), seam/wall masks (the eps = half-quantum + slop
   rule and its two suppression classes), elevation/metric sizing (the Earth
   radius policy: _agree with whoever owns the camera_, stated once),
   picking id conventions (three origin conventions today), color-space rules
   (three's convert-last policy), and the excluded-op-set exponentials
   (splat/surfel Gaussians) which currently have no shared oracle at all.

### 2.8 The invariant catalog and law registry

The connective tissue: one table, `SEM-*` law ID × statement × status ×
binding tests × implementations × agreement class × consuming optimization
problems. Two properties make it more than documentation:

- **Executability:** every `proven-by-test` row cites the test; every
  `implicit` row is a work item (write the test or demote the claim). The
  registry is the TODO list for §6 FM-5, and a CI lint can check that cited
  tests still exist (the vacuous-test incident in §1.4 is exactly the failure
  mode this prevents — a law whose pin silently stopped pinning).
- **Traceability into the trilogy:** each law lists the problems-doc sections
  that assume it, so when an incumbent is replaced by a solver, the laws it
  must preserve are enumerable rather than rediscovered.

---

## 3. Conducive to optimization — how the model feeds the 66 problems

The problems doc's formulations currently borrow their objects informally.
With the model in place, three things become mechanical:

1. **Feasible regions become predicates over defined objects.** The
   conformance MUSTs (drift invariance, covering, frame-only encodings,
   exactness, capability closure) are Layer-3/4 laws; every encoder-side
   problem's constraint set is then _literally_ a conjunction of registry
   laws. The no-thinning partition $\Theta = \Theta_0 \sqcup \Theta_1 \sqcup
   \Theta_2 \sqcup \Theta_\infty$ classifies exactly the Layer-1/2 map
   parameters (which $\theta$ coordinates parameterize semantics-preserving
   maps vs declared-lossy ones).
2. **Distortion functionals get definitions.** The flagship §5.2 byte-budget
   problem needs $d(\theta)$ per lever; Layer 1 supplies them: coordinate
   quantization → worst-case geodesic error $\frac{s}{2}\cdot 111320\,\mathrm{m}$
   (lat) / $\cos\varphi$-scaled (lon); vertex-time precision → $[0,
   \mathrm{step})$ downward-biased error; attribute quantization → $s/2$ per
   column with the domain-invariance constraint. A solver allocating bytes
   across levers is optimizing over _these_ functions; today they are folklore.
3. **Couplings become visible in the type structure.** Ordering × dedup
   couple because both are functions of the Layer-1 address algebra; quantize
   × zstd couple because the quantized lattice changes the byte process the
   entropy coder sees. The model does not solve these but states them where
   the problems doc can cite them precisely.

Worked example the spec will include: restating §6's blob-ordering problem
entirely over the model (curve keys from Layer 1, the workload's query types
from Layer 4's selection semantics, the blend cost from the coalescer law) —
demonstrating that an incumbent, its constraints, and its objective can be
expressed with zero informal residue. The §8 selection problems get the same
treatment over the cover lattice.

---

## 4. Conducive to formalization — rigor tiers and the oracle strategy

Three deliberately separated rigor tiers, so effort lands where it pays:

- **Tier A — the spec itself** (`docs/spec/semantics/` or a single
  `semantic-model.md`; decided at FM-1): numbered definitions and laws per
  §2's layers, KaTeX, harvesting the existing formal surfaces by reference
  (never duplicating the Hilbert vectors, the byte grammars, or the JSON
  schema — they are already pinned).
- **Tier B — executable laws.** Every law that can be a property test becomes
  one, closing the recorded asymmetry that Rust has 3 proptest blocks in one
  file and the browser-facing TS decoder has **zero** property/fuzz coverage
  (spec §11's own SHOULD, violated in-repo). Priority targets are the
  currently-unpinned laws: bucket algebra, the prune predicate, LOD
  selection, quantization round-trips per rounding mode, sub-bucket
  assignment, pack cutting, the paged↔single query-equivalence differential
  (today pinned only in TS — add the Rust twin), tileKey/parse round-trip,
  and the interval-boundary catalog. Plus the semantic fingerprints (defined
  Layer 3, implemented by SH) as conformance-grade checks.
- **Tier C — scoped mechanization (optional spike).** A small, pure,
  I/O-free core is genuinely mechanizable at reasonable cost: the curve
  algebra (bijectivity, locality), the quantization round-trip bounds, the
  bucket/LOD divisibility algebra, and the ancestor-cover DP's one-cover
  property. A Lean4 spike (FM-6) is worth one time-boxed attempt **only after
  Tiers A/B exist**; it is explicitly not on any critical path, and the
  honest expected value is (a) forcing definitional precision, (b) a public
  artifact of seriousness — not bug discovery, which Tier B does cheaper.

**Oracle strategy** (addresses gap class B):

- Keep decode two-oracle and strengthen the _differential_ surface: the
  paged↔whole-load equivalence and the prune/LOD-selection laws get Rust-side
  reference implementations (small — they are pure functions over the
  directory), making the WASM/Python story real.
- Encode stays one-oracle (a second writer is not worth its cost); the model
  compensates by tightening what the byte pins mean: the `t0 = min(start)`
  anchor and blob-ordering `choose()` become **specified functions** (today
  they are unstated, so a conforming-but-different writer would re-address
  the fleet — G3/G4).
- The render kernels extend the two-oracle pattern where math is shared
  (interpolation, cells) and use declared-divergence where it is not.
- The "spec implementable by a stranger" claim gets one cheap honest test:
  scope a clean-room exercise to a single codec (the v6 directory), written
  from Tier-A text alone, diffed against golden bytes. Success criterion is
  binary and the exercise is disposable.

---

## 5. The adjudication register

The review's consolidated findings. Every entry needs one verdict during
FM-2..FM-4: **bless** (intended semantics — state it as a law), **fix**
(defect — file/ride the appropriate window), or **document** (acceptable
divergence — declare it with its agreement class and reason). Verdicts land
in the law registry; nothing here edits the backlog. Citations verified
2026-08-11; re-verify before acting.

### 5.1 Contradictions (fix first; they undermine the surfaces the model builds on)

| #   | Finding                                                                                                                           | Where                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| C1  | Three adversarial-decode regression tests vacuous (version byte 5 vs `DIRECTORY_VERSION = 6`; guards under test never reached)    | `crates/stt-core/tests/adversarial_decode.rs:443,457,471`                        |
| C2  | Packed spec §4 says directory v5 in heading/body; layout, schema, both decoders say 6; §9.1 describes v6 as unshipped future work | `docs/spec/stt-packed-format.md:267,271,1007`                                    |
| C3  | ~60 lines of byte-exact spec for the removed single-file container                                                                | `docs/architecture/data-format.md` (container sections)                          |
| C4  | `make-v2-golden.sh` passes a removed flag; two TS golden families unregenerable                                                   | `packages/core/scripts/make-v2-golden.sh`                                        |
| C5  | `docs/roadmap/playback-and-loading.md` documents the _legacy_ fairness weight formula; shipped default is the progressive fill    | `playback-and-loading.md:196-199` vs `packages/playback/src/fairness.ts:101-139` |

### 5.2 Cross-backend math divergences (renderer parity)

| #       | Finding                                                                                                                                                | Likely verdict                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| S1      | Arc height: deck/maplibre $\sqrt{t(1-t)}\cdot d$ vs three/cesium $4t(1-t)\cdot\mathrm{chord}$ — different profile AND 2× apex for the same `arcHeight` | **fix** (pick one family)                                           |
| S2      | Heatmap kernels: deck normalized $e^{-72d^2}$ vs maplibre unnormalized $e^{-26.67d^2}$; no obligation covers them                                      | bless-or-fix, then spec entry                                       |
| S3      | Cesium `fadeTrail` ramps by arc length, not time (equal only at constant speed)                                                                        | document (declared-divergent)                                       |
| S4      | Trip vertex-time synthesis uses haversine-degrees in one path, projected-3D `hypot` in another, for the same rule                                      | fix (one metric)                                                    |
| S5      | Cell `coverage` inset shrinks in mercator (maplibre) vs lon/lat (three, deck) vs deck-upstream NW-anchor                                               | document + spec entry                                               |
| S6      | Cell triangulation: centroid fan vs fan-from-vertex-0                                                                                                  | document                                                            |
| S7      | Antimeridian/pole cell handling exists only in maplibre                                                                                                | fix (promote to shared kernel)                                      |
| S8–S10  | Fade-degenerate guards (`≤0` cases), NaN filter-value guard: maplibre-only; core produces NaN at measure-zero points                                   | bless maplibre semantics into the oracle contract                   |
| S11     | `'linear'` motion preserves a shipped antimeridian lerp bug via `wrapLongitude:false` default                                                          | fix (or document loudly)                                            |
| S12–S13 | Hexbin lattice latitude anchor (data-centroid vs per-tile); metric sizing reference latitude (per-tile vs per-frame)                                   | document with error bounds                                          |
| S14     | Four Earth radii/circumferences in play, each locally justified                                                                                        | bless as a stated policy ("agree with the camera owner"), one table |
| S15     | Three picking id-origin conventions over one 24-bit packing                                                                                            | document + one spec entry                                           |
| S16     | `instanceEndTime` attribute overloaded (next-vertex time under `segmentTime`)                                                                          | bless + spec statement                                              |
| S17     | Quadbin decode exists in three copies; maplibre's is the exact-mercator variant                                                                        | fix (one copy in core — the code says so itself)                    |
| S18     | `trimTrail` admits $t \le end + L$ while `sampleHead` culls at $t > end$                                                                               | bless (trail outliving head is intended) + state                    |

### 5.3 Client-delivery hazards

| #     | Finding                                                                                                                                                                                                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1    | `latToTileClamped` (tileset copy) lacks the pre-clamp that fixes the near-pole NaN; safe only because `update()` normalizes first; the pass-2 fail-open does not fire on NaN (`NaN>NaN` false) → parent silently dropped. Defense-in-depth fix or a stated precondition |
| H2–H3 | Slack ring not seam-aware; wrap intervals adjacent mod n at the one-world cap                                                                                                                                                                                           |
| H4    | Boundary-bucket `≤` vs `<` disagrees across `getBufferedRunway` / `estimateCost` / profile / `bytesForHorizon` — pin one convention                                                                                                                                     |
| H5    | Horizon floored at `bucketMs` in the runway walk but deliberately unfloored in `bytesForHorizon` (bisect monotonicity) — bless + state                                                                                                                                  |
| H6–H7 | Behind-playhead sentinel and 1e15/5e14 tier separation are unstated arithmetic bounds                                                                                                                                                                                   |
| H8    | Three "covered" predicates (fetch EV / render pass-2 / ancestor DP) — bless the monotone hierarchy, state all three                                                                                                                                                     |
| H9    | During scrub, coverage/readiness measure the undegraded set while selection runs degraded — bless (preview-honesty) + state                                                                                                                                             |
| H10   | The `4×timeWindow` runway horizon multiplier has no recorded derivation                                                                                                                                                                                                 |
| H11   | Parent-gate λ = 1/16 is derived-not-measured (needs the blank-frame harness; already NEEDS-HARNESS in the implementation plan)                                                                                                                                          |
| H12   | Cell budget is a stopgap for frustum selection; its inertness claim fails for `--min-features-per-tile` archives                                                                                                                                                        |
| H13   | `metadata.bounds` = centroid bbox does not bound the data (builder fix rides B2/R1); reader compensates by never intersecting                                                                                                                                           |
| H14   | `parseTileKey` accepts negative/fractional parts; `@0` is a distinct nonsensical tier                                                                                                                                                                                   |
| H15   | `estimateTileSize` sums whole `ArrayBuffer`s — over-counts subarray views, varying with quantization settings                                                                                                                                                           |
| H16   | Eviction band function applied across mixed metric spaces (sim-ms vs wall-ms) sharing one field                                                                                                                                                                         |

### 5.4 Core-format asymmetries (from the stt-core inventory)

1. Three "directory orders" (`variant_id` omitted from the paged sort key) — pick the canonical order.
2. Dead projection API (`lonlat_to_tile_coords` family, extent-4096 MVT grid, zero callers) — delete or quarantine; it must not be specced.
3. Attr-quant overflow: auto path silently clamps, explicit path errors — one behavior or a stated reason.
4. `qz` errors where `qx/qy` clamp — documented; state it.
5. Vertex-time truncating division vs `.round()` everywhere else — state the error-bound difference as law.
6. `scale_axes` per-tile `tbits` recomputation → non-monotone scaled time in degenerate regimes — bless or fix.
7. `TimeRange::duration()` unguarded underflow; no `start ≤ end` invariant.
8. `BoundingBox` expand/center/tilejson-center have no antimeridian handling.
9. `TileId::validate` does not bound `z`; unguarded `1u32 << z` in two sites (vs the guarded `powi` in a third).
10. Two legitimate "max latitudes" (serialized placeholder `85.0511` vs the true clamp) — state why both exist.
11. Stored `hilbert` never validated against `(z,x,y)` on decode.
12. Directory cover-section round-trip not idempotent for mixed corpora.
13. Dead `max_compressed_size` budget field.
14. NaN scores compare `Equal` in the (default-off) budget scorer.
15. Config-path precision quantized to 1 µm via u32 round-trip; direct path not — two effective precisions.
16. `AUTO_QUANT_MAX_ABS` uncovered case: magnitudes straddling `i32::MAX` can still flip type across tiles (needs the dataset-global range pin already PLANNED in §3 of the problems doc).
17. µs/ns→ms truncates toward zero while bucketing floors — divergent for negative property-path timestamps.
18. Pre-1970 sort keys collapse to 0 under `max(0)` — consistent with the unsigned index, but a silent collapse worth stating.

### 5.5 Playback/time drift

1. `--adaptive-temporal` violates the normative bucket model and would corrupt the TS coverage index — declare as a tier variant or withdraw. **Highest-priority semantic verdict in this register.**
2. `timeWindow` centered semantics absent from `time-model.md` (SEM-2-1).
3. time-model §6 omits bounce, the speed split, throttling, the external clock, wrap/ended events — a normative doc under-describing its named reference implementation.
4. No `bounce` getter → `{loop, bounce}` pushes a loop window for a boundary never crossed.
5. `dispersionK` not plumbed to the auto-speed deadband (three knobs documented as moving together; two wired).
6. No clamping on any seek path (enforcement only inside `_step`).
7. Four multi-source fold rules (min/AND, Σ, intersection, max) across four adjacent APIs; zero-required-sources behavior inconsistent between runway (`complete`) and ranges (`[]`).
8. Strict-inequality intersection drops exactly-abutting ranges.
9. Tick throttle not boundary-exempt at the controller level.
10. Ended-replay reads current speed, not clamp-time direction.
11. Degraded creep suppresses the watermark but not the frontier clamp (bless — pinned-at-frontier is the intent) — state it.
12. Two speed sources for one runway quantity (loader-observed vs governor `|s|`).
13. Governor API doc missing the fluid check, dispersion re-fit, ladder, fairness knobs; external-clock API undocumented.
14. `t0` anchor (min-start) test-pinned but spec-unstated (G4) — specify.
15. `BlobOrdering::choose` — the function that fixes every content address — exists only in code (G3) — specify.

### 5.6 Build-pipeline items (from the pipeline inventory; the full working

notes are session artifacts — the spec pass re-derives from code)

- **Known-approximate quantities to label as such:** archive bounds from
  representative points; density/ordering models assigning non-points by
  centroid; the `100 + 16v + 20p` size formula (plus two sibling formulas);
  `FALLBACK_ZSTD_RATIO = 3.0` and `RAW_F64_SHRINK = 0.6` priors; sample
  measurement omitting sidecar columns.
- **Estimator semantics to state:** leave-one-out marginals and their
  normalization; ratio-estimator stderr with no finite-population correction;
  one-sided noise gates (stderr only ever _suppresses_ advice); `lossy: true`
  levers excluded from `--auto` and `to_command`; provenance labels
  (measured / estimated / directory-exact) as a required output type.
- **Anomalies flagged for verdicts:** `GeometryCollection` silently routed to
  the polygon builder then dropped; `geojson_vertex_count` under-charging
  collections; unclamped `interpolate_alt` (unreachable today); un-length-checked
  matrix-row zip truncation; ragged-matrix flatten misalignment; the lon
  reject-vs-clamp divergence between `projection.rs` and `quadbin/clip.rs`.
- **Laws to promote from tests to spec:** the antimeridian suite (AM1–AM7:
  validity, simplicity, area conservation, both-edges); watertight polygon
  seams (buffer 0 + identical `TileBounds` + inclusive Sutherland–Hodgman +
  world-anchored grid); FNV-1a synthetic-id definition; equal-mass adaptive
  windowing never splitting identical-timestamp runs; matrix corridors
  timeless; `vertex_times` attachment conditions; the property-type lattice
  (declared > sniffed, dataset-wide); per-tile row-index ids not stable
  across tiles.

---

## 6. The plan — phases FM-0 … FM-6

Ground rules: citations re-verified at writing time; no backlog edits (this
section proposes graduation lines for the user's adopting pass, as the
informed-design did); anything byte-changing rides R1; anything already owned
by SH/BH/MO items is cross-referenced, not duplicated. Phases FM-1..FM-4 are
writing + adjudication (no behavior change); FM-5 is tests; FM-0 and parts of
FM-5 touch code.

**FM-0 — Repair the formal surfaces (small, immediate, independent).**
Fix C1 (three one-byte test fixes — restores three regression guards), C2
(v5→v6 spec pass), C3 (delete the dead container spec), C4 (fixture
generator), C5 (fairness formula in the roadmap doc). Add the registry lint
skeleton (a script asserting law-cited test names exist). Acceptance: the
three adversarial tests fail when their guards are removed; spec greps for
"v5" return only the changelog.

**FM-1 — Notation + the closed core (Layers 0–2).**
One spec document (proposed `docs/spec/semantic-model.md`; splitting into a
`docs/spec/semantics/` directory is FM-1's first decision) covering spaces,
the coordinate/address algebra, quantization with the rounding-mode table and
error bounds, and the time algebra with the interval-convention catalog
(SEM-2-1 centered window included). Harvest the in-code lemmas; cite, don't
duplicate, the Hilbert §4 and byte grammars. Wire into the docs-manifest so
it renders on /docs. Acceptance: every Layer-0..2 law has an ID, a status,
and either a binding-test cite or an FM-5 backlog row.

**FM-2 — Dataset/archive semantics + the semantic-invariant definitions
(Layer 3).**
Tiling-as-cover, clip and antimeridian laws promoted from tests, determinism
sub-law decomposition, aggregation pushforward algebra, and — the
highest-leverage deliverable — the **fingerprint function family** for
semantic conformance, handed to SH-1..6 as their definition input (closing
the class-C gap that let 106 scrambled archives validate). Adjudicate §5.4
and §5.6. Specify `t0` and `BlobOrdering::choose` (5.5 items 14–15).
Acceptance: SH items can cite definitions by law ID; every §5.4 row has a
verdict.

**FM-3 — Delivery + control semantics (Layers 4–5).**
Selection soundness with its stated caveats, the viewport-repair function,
the cover lattice with the blessed three-predicate hierarchy, the
coverage/runway conjunction semantics including the stall theorem, eviction
and prefetch laws, the governor automaton, and the units discipline.
Adjudicate §5.3 and §5.5. This is also where time-model.md gets its §6
completion and the `timeWindow` law lands. Acceptance: every §5.3/§5.5 row
has a verdict; time-model.md's MUST list covers the shipped clock surface.

**FM-4 — Presentation-kernel contract (Layer 6).**
Agreement-class declarations for every §5.2 row; per-kernel spec entries on
the render-spec template; the S1 arc fix and S17 quadbin consolidation as the
two code changes worth making immediately (both byte-neutral, renderer-side).
Acceptance: `render-spec.json` (or successors) covers every kernel with a
declared class; S1 resolved; no undeclared cross-backend divergence remains
in the catalog.

**FM-5 — Executable laws (Tier B).**
The property-test wave from §4: bucket algebra, prune predicate, LOD
selection, quantization round-trips per rounding mode, sub-bucket assignment,
paged↔single differential in Rust, tileKey round-trip, interval-boundary
catalog; TS decode fuzzing (closing the in-repo violation of the spec's own
SHOULD); the registry lint in CI. Sequenced after FM-1/FM-2 supply the law
statements the tests implement. Acceptance: no law in the registry remains
`implicit`; TS decoder has a property/fuzz suite.

**FM-6 — Mechanization spike (optional, time-boxed).**
Lean4, scoped to the curve algebra + quantization bounds + bucket
divisibility + cover-DP one-cover property. One time-box; outcome is a
recommendation, not a dependency. Explicitly last and skippable.

**Dependencies:** FM-0 independent; FM-1 → FM-2 → FM-5; FM-3 and FM-4
parallel after FM-1; FM-6 after FM-2. Nothing here blocks or is blocked by
B1–B3; the only backlog interaction is that FM-2's fingerprint definitions
feed SH, and SH's byte-changing parts already ride R1.

---

## 7. The product thesis: what this buys the simple UX

The state-of-project evaluation, through the lens _simple UX backed by
sophisticated space+time solutions_:

**The sophistication is real.** Byte-deterministic content-addressed archives
with 4–5 requests to first frame at any size; a measured-not-modeled
optimizer; a control-theoretic playback governor; viewport repair that made
3D selection correct; a two-oracle render kernel; 84 test-enforced laws. Few
systems in this space carry this much verified machinery.

**The simple UX is real.** One manifest + immutable packs on any static host;
`--auto` builds; `stt-optimize recommend`; `derive-params` turning archive
stats into playback defaults; the MCP/skills surface composing maps from a
dataset name. The surface a newcomer touches is genuinely small.

**The risk is the seam between them.** Every recorded incident where the
simple UX broke — wrong pixels that validated (the scramble), renderers that
disagree (arcs, heatmaps), playback that silently stalls (spatial ordering),
a wrong opening camera (centroid bounds) — is a place where the backing
sophistication had an invariant that existed only in code or in one person's
head. A simple UX cannot ask its user to debug a semantic gap; it fails
worst exactly where validity is structural, parity is unspecified, and
defaults encode unstated theorems.

**The model is the treatment, and it is the highest-leverage one available:**
it converts the seam into a contract. Semantic fingerprints make "the data on
screen is the data you built" checkable (class C). Agreement classes make
"same archive, any renderer" enforceable (class D→S). Specified selection and
gating semantics make "press play and it plays" a theorem with stated
preconditions instead of folklore (the stall theorem). And the law registry
makes the sophistication _legible_ — to the optimization program that wants
to replace incumbents safely, to a future second implementer, and to the AI
surfaces that increasingly mediate the simple UX and can cite laws instead of
guessing.

The estate is unusually ready for this: most of the model's content already
exists as tests, lemmas, and partial specs. The work is consolidation and
adjudication far more than invention — which is exactly why it is cheap
relative to what it closes.

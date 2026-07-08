# STT Preprocessing Framework — "Bake the analytics into the tiles"

_Design synthesis (2026-06-16, revised 2026-06-22 against the AV/LiDAR exploration). **Forward-looking
design — nothing here is built.** It reorganizes the ~116 preprocessing operators that have emerged
bespoke across the codebase (Python AV extractors, `stt-generate`→`stt-build`, the render path) around
three findings: (1) a dataset-bigness archetype playbook, (2) a unified spatial × temporal × attribute
LOD model, and (3) the representation ladder — overview and detail as different, zoom-dispatched
techniques. The full operator catalog is condensed to an appendix; this body keeps the load-bearing
model._

> **Verified 2026-07-01 against source — the self-assessment holds, and the whole
> framework stays COUNTED OUT (future work) as designed.** Everything labelled
> "already present" (BIXI clustering, `vertex_value_matrix`, KDEEB bundling,
> summary tier, temporal-LOD, `budget.rs`) exists in code as described;
> everything labelled unbuilt (Plan-IR, Recipes, rung registry, ladder
> descriptor, sufficient stats) is genuinely absent. Two updates to the Phase-0
> prerequisite and the cheapest Phase-4 slice:
> (1) **Determinism (§7.1/Phase 0) is FULLY CLOSED (2026-07-04)** — the
> workspace arrow upgrade landed (arrow-ipc ≥59 sorts IPC metadata) and builds
> are byte-reproducible (`same_tile_encodes_byte_identically` active); no fleet
> re-transcode was needed — the transcode pipeline itself was removed 2026-07-04.
> (2) **The summary tier stores `Mean` as a materialized column**
> (`crates/stt-core/src/metadata.rs`) — exactly the avg-of-avgs trap §3.4 warns
> about. Nothing re-aggregates cells client-side today, so it is not a live bug;
> when Phase 4 starts, migrating `Mean` → `{Sum, Count}` (derive on read,
> additive so deployed archives keep working) is the smallest first slice.

---

## 0. The one principle

> **Read-time cost should depend on output resolution (cells × time-buckets × dimensions), never on N
> (record count).** Anything expensive that is a pure function of the input — layouts, clusters,
> aggregations, trend statistics, tessellation, ordering — is _baked once at build time_ and shipped
> as a cheap-to-read artifact.

Every system surveyed (tippecanoe, Planetiler, PMTiles, COPC, Datashader, Nanocubes, imMens, Gaussian
Cubes, Supercluster, flowmap.gl) is one realization of this. STT already lives here for many datasets
(BIXI clustering, flow-corridor value-matrix, summary tiers, additive-octree LiDAR); the framework's
job is to make it the _default, reusable_ path instead of bespoke per-generator code.

Three corollaries:

1. **Conserve, don't discard** (no-thinning). Aggregate/coalesce so the GPU sees a tractable number of
   primitives; dropping stays strictly opt-in. The strongest form is _lossless union_: a single baked
   ranking whose union over all levels reconstructs N exactly (the additive-octree).
2. **Determinism is load-bearing.** Content-addressed packs only dedup, edge-cache, and incrementally
   rebuild if identical logical input → identical bytes. The formerly-live non-reproducible-packs bug
   (Arrow-metadata `HashMap` iteration order) silently broke all three — **the prerequisite, now
   closed 2026-07-04 (§7).**
3. **LOD changes the _resolution_ of the answer; encoding changes the _price per unit_.**
   `--quantize-attr`, `--vector-group`, blob-ordering, `--quantize-coords` are bytes-per-unit
   multipliers, not LOD. They compose with LOD and never substitute for it — a clean seam that lets STT
   apply born-optimized encoding universally at the `run_stt_build` boundary. (Caveat: a few encoding
   levers conflict with _each other_ — §1.4.)

---

## 1. The reframe — two orthogonal classification axes

The ~116 operators collapse onto a few decisions. The key upgrade: **two decisions the codebase tangles
together are actually orthogonal**, and separating them predicts byte cost, the hand-off contract, and
the determinism burden of every operator.

**Axis 1 — same primitive, or a different one?**

- **Continuous LOD** (same-primitive, coarser fidelity): decimate points, simplify a polyline, roll a
  value-matrix to a coarser bucket, snap to a coarser grid. Reconstruction = sampling the _same_ data
  type. One layer class, one shader, a `level` parameter.
- **Representation switch** (different-primitive, different-algorithm — "semantic LOD"): raw returns →
  density iso-lines; points → H3/Quadbin cells; trips → flow corridors; reflectivity → isobands / storm
  tracks. You **cannot** recover the overview by sampling the detail — a different operator answers a
  different question ("how dense" vs "where exactly").

**Axis 2 — surviving sub-unit, or synthesized? (the materialize-vs-filter predictor)**

- **Surviving sub-unit** (a real point/vertex/feature) → **bake ONE ranking, filter at read.** If each
  unit carries a monotone _r_ = "coarsest level at which I appear," level L is served by `r ≤ L`. No
  per-level copies; union reconstructs N (lossless). This is the additive-octree `home_zoom`.
- **Synthesized unit** (cluster centroid, contour ring, holistic aggregate like median) → **must
  materialize each level.** No per-fine-unit threshold reconstructs a synthesized object.

The two axes are **independent**, and the codebase conflates them. Per-zoom flowmap clustering is the
clarifying case: Axis 1 says "same primitive, looks cheap," Axis 2 says "synthesized centroids, must
materialize." Treating Axis 1 as if it implied Axis 2 produced the dead **5-fixed-density-tier** approach
(5 strided copies, ~2× storage) where one ranking would do — which is exactly what `--lod` now does,
lossless, at ~½ the bytes. Axis 2 lines up with OLAP measure classification (§3.4): distributive/algebraic
over surviving units → filterable from one ranking; holistic or synthesized geometry → materialize.

### 1.4 The encoding lever bites back only against other encoding

Encoding levers compose with LOD freely, but two documented cases show them conflicting with _each other_:
**dedup vs. blob-locality** (byte-identical-tile dedup _hurt_ range locality on earthquakes, repack +116%
worse), and **`--pack-quat` vs. `--vector-group`** (smallest-three quat packing was superseded by the
zero-copy vector-column bind — a _resolved_ tension, vector-group won). Lesson: LOD axes couple (§3.5);
encoding doesn't couple with LOD but can couple with other encoding. The framework should own this matrix.

### 1.5 A third operator category: always-on correctness

Not every non-default operator is opt-in. **Pre-tessellation** (baked earcut triangles) and
**wildfire/radar multipolygon splitting** are _always-on_ for multi-ring polygons — they fix the
spanning-triangle / streak artifact. They are not LOD, not encoding, not opt-in: they are **correctness
preprocessing**, a distinct category.

---

## 2. Dataset-bigness archetypes → the onboarding playbook

Different "bigness" demands different preprocessing, and the codebase's _measurements_ prove which lever
wins — usually counter to intuition.

**Measure first (non-negotiable).** Run `point_column_stats.rs` (per-column post-zstd bytes) and, for
point clouds, `lidar_summarize_eval.py` (fidelity bake-off) before any playbook. Two overturns on record:
the "octree geometry" plan **died** when the stats showed AV LiDAR geometry was only 12.7% of bytes while
id-hash (40%) and raw-f64 z (38%) dominated (the win was seq-ids + `--quantize-attr` on z); and
lightweight column encodings (delta-varint/RLE/byte-shuffle) were **measured-no-go** (byte-shuffle +31–68%
on the dominant coord column — zstd already models raw LE f64 better).

| Archetype          | Definition                                        | Axis that blows up                                          | Diagnostic                                                    |
| ------------------ | ------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| **Temporally-big** | Same geometry over many timesteps                 | timesteps × features                                        | a 1 h base bucket pulls **180×** a 60 s window                |
| **Spatially-big**  | One instant already too dense                     | point count + near-incompressible per-point bytes           | z14 tile is **20 B/pt**                                       |
| **Metadata-big**   | Directory and/or per-feature attr width dominates | dir bytes grow with N not viewport; wide/high-entropy attrs | id-hash is **40%** of a point; cold-start whole-dir load wall |
| **Both-big** (AV)  | Dense instants _and_ many of them                 | point-count × sweeps at once                                | a ~15 s LiDAR log ≈ **180 M** returns                         |

Most real data is a hybrid. The hybrid rule: layer the playbooks **temporal → spatial → attribute** (each
stage changes what the next sees). One exception — the `--lod` path _fuses_ spatial and temporal (C2) and
is an alternative whole pipeline, not a late step.

### 2.6 Quick lookup (the compressed playbook)

| "My data is mostly…"                              | Do this, in order                                                                                                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **temporally-big** (taxi/flows/satellites)        | finer `--temporal-bucket` → (value-matrix for flows) → temporal-LOD / adaptive tiers → suppress dead time cols → paged t-bounds                                                                                    |
| **temporally-big w/ static substrate** (AV stage) | scene-split / worldbuild collapse → `erasor_scrub` → quantize → `STAGE_MIN_ZOOM` floor                                                                                                                             |
| **spatially-big** (dense LiDAR, one instant)      | seq-ids + drop dead cols → (`--adaptive-decimate` only if you truly need fewer pts) → **`--quantize-attr` (primary, ~6×)** → colorize(linear-light) → surfel/iso → vector-group + world-grid coord-quant → `--lod` |
| **spatially-big + wide attrs**                    | above + `--exclude` dead cols + (`--vector-group`, not `--pack-quat`)                                                                                                                                              |
| **metadata-big (directory)**                      | seq-ids → zstd-19 → **paged directory w/ geo+zoom+t bounds (primary)**                                                                                                                                             |
| **metadata-big (attr width/entropy)**             | id-de-entropy → `--exclude` → quantize-auto-u16                                                                                                                                                                    |
| **both-big** (AV LiDAR)                           | georef → **scene-split (primary)** → [stage: spatial-big + `static_full_range`] ∥ [actors: temporal, conserve-all] → universal byte levers → paged t-bounds                                                        |

_Two hard steers on record:_ the durable spatial lever is **bytes-per-point, not fewer points** (users
vetoed decimate-12 as "too low res" even though adaptive-voxel proves 3–4× fewer at equal fidelity — keep
decimation opt-in); and coord-quant must be a **world grid, never per-tile** (per-tile origin breaks
cross-tile dedup, measured +61%). Full per-archetype operator ordering → Appendix A.

### 2.7 Cross-archetype invariants the framework should own

Today each operator re-hand-rolls these:

1. **Determinism** (world-grid coord-quant; per-column-min affine; commutative reductions; pinned
   constants; no RNG). The one systemic hole — arrow-ipc serializing Field metadata in `HashMap`
   order — closed 2026-07-04 via arrow ≥59 (§7).
2. **Quantize/aggregate before dedup, on a global grid** (per-tile-relative encoding is punished +61%).
3. **Global-per-zoom, never per-tile** for any aggregation/bundling/clustering (tile-local subsets seam).
4. **Conserve > discard** — lossy levers opt-in and default-inert; prefer a zoom clamp over aggregation.
5. **Line/path archives:** never `--quantize-coords` (mis-sizes PathLayer's instanced draw), never
   `--simplify` (breaks vertex↔coord/time alignment), expand instanced attrs per-vertex not per-feature.
6. **Categorical columns must carry non-numeric string labels** or stt-build promotes them to Numeric and
   no-ops the color map.
7. **Always-on correctness operators** (pre-tessellation, multipolygon split) are mandatory, not opt-in.

---

## 3. The unified spatial × temporal × attribute LOD model

STT treats LOD as 1-D (mercator zoom) while actually operating in 3-D. Naming the axes turns "a zoo of
flags" into a model.

- **Axis S — spatial resolution** (vertices/linestring, points/voxel, cells/km², features-at-zoom). Unit:
  _cells_ (or screen-space-error px).
- **Axis T — temporal resolution / window** (bucket width, pyramid tier, per-sweep grain, static-collapse,
  how much time a tile pulls). Unit: _time-buckets_.
- **Axis A — attribute / dimension detail** (measures, numeric precision, semantic granularity). Unit:
  _dimensions × precision_.

**Read cost ∝ VOLUME(S × T × A) · bytes-per-unit.** A tile request is a _box_ in this cube; the LOD axes
set the box volume, the encoding lever sets bytes-per-unit. The classic mercator pyramid only ever moved
you along S; STT's frontier is that **T and A are first-class LOD axes with no prior art to copy.**

The per-axis operator tables (S: reproject/quantize, DGGS index, VW-inline simplify, voxel decimation,
Supercluster, additive-octree, min/max-zoom band, bbox covering; T: bin/temporal-LOD, static/dynamic
collapse, per-sweep `home_zoom`, time-series codec, cumulative prefix-sum, value-matrix corridor) are in
**Appendix A**. Three A-axis points are load-bearing enough to keep here:

- **Classify every measure (OLAP rule — prevents average-of-averages).** _Distributive_ (SUM/COUNT/MIN/MAX)
  → roll up freely at every zoom. _Algebraic_ (AVG/STD/covariance) → store the distributive _components_
  (sum, sum², count), derive on read — never store the derived average and re-average it. _Holistic_
  (MEDIAN/distinct/MODE) → can't roll up; materialize per-zoom or skip.
- **Bake sufficient statistics, not just counts (Gaussian Cubes — the cheap high-leverage upgrade).** Per
  cell store `{ n, Σx, Σx² }` (and `Σxy` for pairs) as additive channels. At read time reconstruct mean,
  variance, correlation, linear trend, even PCA in O(d³), **independent of N, no rebuild** — the client
  switches what it visualizes without touching the build. A handful of f32 columns; the single best ROI
  add to a count-only tile system. _(Named-but-unbuilt today.)_
- **The zoom pyramid IS a partial OLAP cuboid lattice** — materialize only tiers you serve; below a
  min-support count, fold cells (iceberg-cube, `--drop-densest` justified by anti-monotonicity). Separate
  aggregation from shading (Datashader): bake count+sum+min/max once; colormap/spread/normalize is
  O(pixels), re-runnable at read time. Spatiotemporal analytics that bake cleanly: KDE density raster ✅,
  Getis-Ord Gi\* hotspots ✅ (valid only for the baked grid/window), Mann-Kendall/linear-trend ✅ (from
  sufficient stats — ESRI's space-time cube), TRACLUS ⚠️ (bake the local partition, skip global grouping),
  ST-DBSCAN/HDBSCAN ❌ (whole-dataset connectivity — run offline once, bake cluster _labels_ per point).

### 3.5 The four genuine couplings (the axes are orthogonal to _request_ but coupled in four baked places)

A recipe that declares them independent will silently break.

- **C1 — spatial overview _forces_ temporal collapse (the big one).** Zoom out on a temporally-big cloud
  and one coarse tile packs every-sweep density into a megatile (`STAGE_MIN_ZOOM=17`, the 62 MB tile).
  S × T must stay under the per-tile decode budget — model it as a **joint budget on the substrate**.
  _That is what the static/dynamic split is._
- **C2 — additive-octree `home_zoom` is assigned PER-SWEEP** → the spatial rank is parameterized by the
  temporal grain. You can't bake the S-filter without first choosing sweep grouping — so `--lod` _fuses_
  S and T and is an alternative whole-pipeline, not a late spatial step.
- **C3 — value-matrix / sufficient-stats: the T-axis lives _inside_ A.** A `[vertex][bucket]` grid
  relocates time into an attribute column; the read-time T-filter is literally an A-axis column read. For
  flow/corridor layers, T-strategy and A-strategy are **one decision.**
- **C4 — LOD strategy ↔ multi-source governor.** A static-collapse rung is an OPTIONAL governor source
  (loads once, never gates); per-sweep actors are REQUIRED; the build-time bucket width sets the read-time
  EDF deadline. A recipe's `temporal.strategy` silently determines scheduler behavior.
- **A fifth, aesthetic coupling** (blocks §4's headline win): _render-window ↔ representation._ iso-lines
  narrow the time window to ~260 ms, starving the box layer (needs ≥2 keyframes) → a defensive
  `Math.max(timeWindow, 2000)`. An automatic ladder (§4) must reconcile per-rung windows with co-resident
  layers.

_Genuinely independent:_ the encoding levers compose freely with the LOD axes — the clean architectural
seam that lets STT quantize universally at `run_stt_build`.

### 3.6 "One ranking, many zooms" — the unifying idea

**A single baked, monotone ranking can serve every LOD level as a pure read-time threshold filter**, instead
of materializing a separate artifact per level. If each unit carries r = "coarsest level at which I appear,"
level L is `r ≤ L`; union reconstructs N (lossless). This is the structural form of no-thinning: a clamp,
not a drop.

Candidate rankings, all already present in the codebase: VW effective-area per vertex; octree `home_zoom`
per point (the exemplar); cluster level per station (Supercluster); surface-variation σ = λ₀/(λ₀+λ₁+λ₂)
per LiDAR return; sufficient-stats per cell (the A-axis analog); importance-per-byte (`budget.rs`);
`cover_t_min` per tile. **Where STT still re-materializes** (consolidation targets): the dead
5-fixed-density-tiers (retire for `--lod`); per-zoom clustering (synthesized centroids — a genuine _limit_
of the ranking idea); the temporal-LOD pyramid; summary cells; **line simplify** (the VW effective-area is
_already computed_ — bake it per-vertex and filter at read time = the clearest unexploited vector win,
gated by the line-archive constraints).

**Boundary condition (the precise materialize-vs-filter predictor):** ranking-filter works exactly when the
coarse output unit is a **real surviving sub-unit** of the fine one _and_ its measures are
**distributive/algebraic**. It breaks when the coarse unit is **synthesized** — there the level must be
materialized. This is Axis 2 (§1), and it lines up with OLAP measure classification.

### 3.8 The accumulator contract

When _any_ operator removes/merges a feature (cluster, coalesce, budget-drop), fold its named scalar
attributes into the survivor via a per-attribute reduction (`sum`/`mean`/`max`/`min`/`count`) and auto-emit
`point_count` + `sqrt_point_count`. Make it a **format-level property** reusable across the build pass and
any later merge pass (tippecanoe's tile-join lesson). This is `vertex_value_matrix` aggregation generalized
— it's what makes "drop" safe (totals survive as aggregates) and it is the **consistency backbone for the
representation ladder** (§4): every rung must be a _projection of the same conserved accumulator_, so a
monotone invariant (total count, total flow) is identical across rungs.

---

## 4. The representation ladder — overview and detail as _different techniques_

The sharpest product question: _"does it make sense for a high-level and a zoomed-in view to be different
techniques?"_ **Yes** — with a precise rule, and a striking finding: **STT has already built every operator
a representation ladder needs, but almost none of it is wired to zoom.**

### 4.1 When a switch beats continuous LOD

> **Switch when the detail primitive's _legibility_ collapses faster than its information content as you
> zoom out. Stay continuous when sampling the same primitive still reads correctly, just sparser.**

Prefer a switch when **any** hold: (1) **sub-pixel collapse** — the detail primitive is smaller than a
pixel, so decimation renders as noise (the `radiusMinPixels:0` bug; satellites z0); (2) **over-plot
saturation** — the honest overview is an aggregate and individuals paint a blob; (3) **read-cost must
decouple from N** — even a decimated subset is too expensive, only cells×buckets scales; (4) **the overview
answers a different question** (storm tracks vs reflectivity field; flow corridors vs individual trips).
Stay continuous when the primitive is self-explanatory when sparse (a simplified road, a gap-fillable
surfel surface) and the aesthetic demands raw density — continuous LOD is almost always cheaper to build
and keep consistent (a `level` knob, lossless union, one accumulator); a switch is a second baked artifact
with its own operator/determinism/hand-off cost, so it should pay for that via one of the four triggers.

### 4.2 The critical finding — the switches exist but aren't zoom-wired

Two mechanisms are conflated under "LOD": **genuine zoom-driven switches** (only the summary tier's
`pickTierForZoom` H3/Quadbin swap, and the additive-octree union — which is continuous, not a swap); and
**user-toggled mode switches** (the AV cockpit pill row — iso-lines, surfels, stage/actors, scan, worldbuild,
cube). Each mode is a _separately baked sibling archive_ (`-iso`, `-surfel`, `-stage`…) selected by a
frontend flag — a different abstraction of the _same instant_, NOT an automatic overview/detail handoff.
You pick one mode and it's that mode at every zoom. The 13 catalogued switches (summary tier, density
iso-lines/iso-3D, surfels-vs-points, scene-split, worldbuild, flow-corridor value-matrix, per-zoom flowmap
clustering, baked edge bundling, radar isobands, SCIT storm tracks, object tracks, space-time cube) are
enumerated in **Appendix B**. _Note the clustering case: same primitive yet synthesized units — the clean
illustration that §1's two axes are independent._

### 4.3 The systematization — a declarative representation ladder

The missing abstraction: **one ordered descriptor** saying _this dataset has N representations across scale
bands; each rung names its own preprocessing operator AND its own render primitive; the engine picks
automatically by zoom (and optionally time-window); rungs are guaranteed consistent._

```yaml
representation_ladder:
  dataset: argoverse-miami
  consistency: { accumulator: voxel_real_rep, totals_invariant: count } # §3.8
  rungs:
    - {
        id: city_overview,
        scale: { zoom: [0, 13] },
        operator: density_grid_contours,
        primitive: iso_lines,
        conserve: aggregate,
      }
    - {
        id: block_scale,
        scale: { zoom: [14, 16] },
        operator: home_zoom_octree(curvature),
        primitive: surfels,
        conserve: lossless_union,
      }
    - {
        id: street_scale,
        scale: { zoom: [17, 22] },
        operator: identity(full_density),
        primitive: surfels,
        conserve: lossless_union,
      }
  handoff: { '14->13': crossfade(zoom, 0.4), '17<-16': additive_union }
  temporal: { static_dynamic_split: true }
  time_window_policy: per_rung_clamp_with_floor # reconciles the §3.5 fifth coupling
```

Two things make this more than config: **each rung binds an operator to a primitive** (the build planner
walks the ladder, runs each operator once, emits a tagged tier/archive) — collapsing the frontend
mode/flag/layer/suffix/heldBack that is **currently declared in 4+ places that drift** (the `renderModes`
existence-probe in `AvCockpit.tsx`, the `datasets.ts` memo, the route regex, the `buildDemoLayers`
if/else, _plus_ the deck↔three parity copy) into **one registry row per rung** (§6.1); and **the ladder is
the boundary between continuous and switch LOD** — adjacent same-primitive `lossless_union` rungs are
continuous (octree levels), adjacent different-primitive rungs are switches, and the hand-off rule differs.

### 4.4 Hand-off and the consistency contract

Three hand-off modes, chosen by the two rungs' conserve declarations: **additive union** (no fade; same
primitive `lossless_union` — client loads `[minZoom..cameraZoom]`, **no parent de-dup** — coarse points
exist nowhere else, so `lossless_union` must be a **typed property the reader honors**); **crossfade**
(different primitives that both read in a transition band, e.g. iso ⇄ surfels around z13–14); **hard
switch** (overview meaningless at detail scale — generalizes the existing `no-overlap` refinement).

**Consistency — same totals, no double-count — is the hard part**, and ties to §3.8:

> **Every rung must be derivable from the SAME conserved accumulator, so a monotone invariant (total count,
> total flow) is identical across rungs.**

No rung _invents_ totals — each is a projection of the conserved set (proven for the octree: 39440 pts
placed once not ×6). This is why **sufficient statistics** matter: a rung carrying `{n,Σx,Σx²}` (not a
baked mean) lets a coarser rung be re-derived from a finer one at read time without avg-of-avgs,
guaranteeing the invariant by construction. Every rung operator must also be byte-reproducible (no RNG —
which is why the RNG-using bake-off winners were _not_ shipped), commutative-reduced, sorted-emit.

### 4.5 The gaps — and the meta-gap

Datasets that force one primitive across all zooms but shouldn't: **AV cockpit LiDAR at city scale (the
headline gap)** — the cockpit forces a single primitive across all zooms; a dense cloud is a saturated blob
at region scale, yet the iso-lines _already are_ the correct city-scale representation, just as a parallel
manual mode. **Make iso the auto z0–13 rung, additive-octree surfels z14–16, full surfels z17+, of ONE
dataset** (blocked by the §3.5 fifth coupling — needs the `time_window_policy`). Also: trips/paths without a
flow-matrix overview (the 180× over-plot blob); point datasets without a summary tier (fall back to
`min_safe_zoom` clamp instead of showing an aggregate); radar field with no zoom-driven track handoff;
cumulative "draw" datasets (sub-pixel-dot bug); wide-time ocean/drifter data (a KDE-raster overview rung).

**The meta-gap:** the codebase has _built every operator a representation ladder would need_ (contours,
surfels, octree, summary cells, flow matrix, sufficient-stat accumulators) but **never wired any of them to
zoom as an automatic overview→detail handoff on a single dataset.** The systematization is not new operators
— it's a **ladder descriptor + a zoom-driven dispatcher + the conserved-accumulator consistency contract.**

---

## 5. The build as a declarative dataflow DAG (the Plan IR)

Every idiomatic engine (DataFusion `LogicalPlan→ExecutionPlan`, Polars `LazyFrame`, DuckDB) builds a plan
first, executes later. A dataset's build becomes a **`Vec<Stage>`** — an ordered, serde-tagged operator
pipeline over an Arrow-columnar dataflow, logical/physical split:

```
Source ─► Normalize ─► Transform* ─► SpatialIndex ─► TemporalBin ─► Aggregate/Cluster/Analyze* ─► Encode ─► Pack
 (bronze)  (silver: CRS, dateline,                   (the "where")   (the "when")   (the bake — §3)       (gold)
           dedup, schema-validate)
```

Stages are internally-tagged enum variants (`#[serde(tag="op")]`): `Filter`, `Reproject`, `Quantize`,
`Simplify`, `Index`, `Bin`, `Aggregate`, `Cluster`, `Hotspot`, `Bundle`, `Encode`, `Pack`. This buys, for
free: **`stt-build explain <recipe>`** (print the optimized DAG); **optimizer passes** as named tree-rewrites
(fuse reproject+quantize; push a bbox/time filter into the scan → skip Parquet row-groups → attacks the 180×
over-fetch; common-subplan elimination so the shared scan/reproject forks into detail + summary + raster tiers
once — **this is also the mechanism for the §4 ladder**, each rung a sub-plan off the shared silver scan);
and **validation before I/O** (`deny_unknown_fields`).

Build operators as native Rust over Arrow `RecordBatch` (keep zero-copy-to-GPU), borrowing DataFusion's
_extension contracts_ (a `Source` trait with tri-state pushdown; pull-based streaming → bounded memory,
fixes "buffers all tiles in RAM, fails >10 GB") rather than its engine. Formalize the **medallion
intermediates**: bronze (raw + provenance), **silver** (CRS-normalized, dateline-clipped, deduped,
map-matched routes — the expensive-but-reusable layer; any ladder rung reads from silver), gold (binned,
quantized, packed tiles per rung). Re-bucketing nyc-taxi-paths becomes a silver→gold step, no re-routing.

---

## 6. The interface — the rung registry (MVP) first, Recipes later

Every mature system converges on a declarative front door + a documented path to code. But the adversarial
review was emphatic: **the full declarative recipe with an engine that _derives_ materialize-vs-filter is
over-built for v1** — it depends on the unbuilt sufficient-stats / OLAP / Plan-IR layer. Build the registry
first; the recipe is v2.

**6.1 BUILD FIRST — the shared rung registry (the 80% MVP).** One Rust+TS source of truth (`rungs.json` or a
generated const), one row per representation rung:
`{ id, suffix, datasetFlag, deckLayer, threeLayer, label, heldBack, license, conserve, read, scale, handoff }`
— where `read: union | parent-fallback | materialized` is **hand-declared in v1, not derived**. Pure
consolidation of existing behavior, highest-leverage/lowest-risk: it kills the 4-place mode drift _plus_ the
deck↔three parity copy; subsumes the `HELD_BACK_AV_MODES` / `WAYMO_LOCAL_ONLY` / `STAGE_LOCAL_ONLY` regex
gates into structured `heldBack`/`license` fields; gives the dual-copy palette a single source of truth; and
is the prerequisite that makes the §4 zoom-driven ladder possible to wire.

**6.2 The recipe (v2 — the 80% case, no Rust).** A versioned, JSON-Schema-validated YAML (`deny_unknown_fields`)
with ordered typed stages (Vega-Lite's shape), a small sandboxed expression language for `@zoom`-varying
params, cascading defaults, a per-axis `lod:` block that declares C1/C2/C3, and an orthogonal `encoding:` block.
The framework **owns the leaky invariants** (§2.7) rather than each operator re-documenting them, and **recipe
validation includes the bake-off** (`lidar_summarize_eval.py` / `point_column_stats.rs` become a first-class
validator; a strategy is promoted default-off→default-on only when the measured win justifies it _and_ output
stays byte-identical until flagged).

**6.3 The escape hatch (the 20% — Rust).** Copy Planetiler's `Profile` — the missing **`Dataset` trait** the
generation audit keeps asking for:

```rust
trait Recipe: Send + Sync {
    fn process_feature(&self, f: &SourceFeature, out: &mut FeatureCollector);   // on N workers
    fn post_process_tile(&self, layer: &str, z: u8, feats: &mut Vec<TileFeature>); // after grouping
    fn finish(&mut self) {}
}
```

`run_all()` becomes a generic loop over recipes: hot per-feature path on parallel workers, merge/reorder on
the single-threaded per-tile stage (deterministic output order).

---

## 7. Determinism, content-addressing & incremental rebuild

This is what turns "a cleaner generator" into "**incremental fleet rebuilds + a shared cache**" — gated on
fixing determinism first.

**7.1 Determinism (the prerequisite — closed 2026-07-04).** The tile/pack hash must be a pure function of
logical input only: never serialize a `HashMap`/`HashSet` (Rust re-seeds the hasher per process — this was
the Arrow-metadata non-reproducible-packs bug, **closed 2026-07-04** by the arrow ≥59 upgrade, which sorts
IPC metadata; determinism landed via that upgrade and no fleet re-transcode was needed — transcoding was
removed the same day); sort filesystem enumerations; total per-tile sort keys (spatial → time → feature-id
→ original-index); zero wall-clock in output (`SOURCE_DATE_EPOCH`-style config, never `SystemTime::now()`);
order-independent float reduction (quantize-then-sum, or fixed sequential order — why RNG bake-off winners
were not shipped); parallelize compute, not output order; regression-test by building twice in separate
processes (HashMap re-seeds) + shuffled file order + different thread count → assert byte-identical packs.

**7.2–7.3 CAS + incremental (Salsa-style).** Lift the DAG to a content-addressed constructive trace (a CAS
keyed by `hash(content)` + a manifest of `{stage-key → input-fingerprint, output-hash, dep-edges}`; the stage
key hashes input bytes + full config + tool version). Then memoized query DAG with cross-run persistence +
**early cutoff** (after recomputing a leaf tile, if its content hash equals the previous build, don't
invalidate its pack/directory) + **projection firewalls** (each tile depends only on its slice + the config
fields it reads). Payoff: the recurring "fleet rebuild + R2 re-sync" stops being all-or-nothing — the R2
pack store _is_ the CAS. Transcoding was removed 2026-07-04; if a reoptimize transcoder path is ever
reintroduced (operate on existing packs, not re-ingest), its use case is OSRM / live-API datasets that
drift and can't be regenerated from source.

---

## 8. Phased roadmap (nothing here is a rewrite)

The revised sequencing puts the **registry MVP before the recipe engine** (the adversarial review's main
correction).

0. **Determinism — ✅ CLOSED 2026-07-04.** Landed via the arrow ≥59 upgrade (sorted IPC metadata) plus the
   build-twice byte-identity test (`same_tile_encodes_byte_identically`); no fleet re-transcode was needed
   (transcoding removed 2026-07-04). CAS dedup, edge-cache correctness, and Phase 6 are unblocked.
1. **The rung registry + primitive consolidation (highest ROI).** Ship the shared registry (§6.1); retire
   the 4-place drift + regex gates + dual-copy palettes. Consolidate the σ planarity estimator and the
   real-representative voxel reducer (each reimplemented 3–4× in `av_common.py` + `lidar_summarize_eval.py`)
   into one operator apiece. Encode C1–C4 as build validation checks. Promote the bake-off tools to a
   documented "run this first" entrypoint.
2. **Plan IR + operator extraction (no behavior change).** Define `Stage` enum + `BuildPlan`; reimplement
   the current flow as a fixed plan; extract `BixiAggregator`/`FlowAggregator` into one generic
   `Aggregate`+`Cluster`; wire `budget.rs` as a `Budget` stage with the accumulator contract; ship
   `stt-build explain`.
3. **The representation ladder (the visible product win).** Wire the AV-LiDAR ladder (§4.5): iso z0–13 →
   octree-surfels z14–16 → full surfels z17+ on ONE dataset, zoom-dispatched, with `time_window_policy`
   resolving the fifth coupling. Generalize `no-overlap` into the three hand-off modes; make `lossless_union`
   a typed read-side property.
4. **The cube upgrades.** Sufficient statistics `{n,Σx,Σx²}` on the summary tier; OLAP classification on
   every aggregation; VW inline effective-area → every zoom a filter; KDE raster + Gi\* hotspot tiers;
   per-cell time-series codec + cumulative prefix-sum.
5. **Recipes (kills generator drift).** `Recipe` trait + generic `run_all()`; YAML parser + sandboxed
   expression language; port 2–3 datasets; keep the Rust escape hatch. Materialize-vs-filter stays
   hand-declared until sufficient-stats ship, then derived.
6. **Incremental engine.** Salsa-style memoized query DAG; persist dep-graph + result manifest; CAS for
   leaf tiles + packs (R2 as shared CAS); early cutoff + projection firewalls; diff-only R2 sync;
   reintroduce a `reoptimize` pack-transcode path only if a real need re-emerges (removed 2026-07-04).
7. **Streaming-first.** Pull-based Arrow streaming as the default (in-RAM becomes the small-data case);
   unbounded-dataset support; `Source`-trait pushdown feeding the paged-directory bounds.

## 9. Open decisions

- **D1 — Native operators vs. embed DataFusion** for the `Transform` stage. _Native first_ (zero-copy-to-GPU
  control, fewer deps); embed later if SQL-defined transforms/heavy joins become common. Reversible.
- **D2 — Primary DGGS.** _Quadbin_ default (tile-aligned, 1:1 with deck.gl, perfect nesting, `quadbin.rs`
  exists); H3 retained for neighbor/flow; S2 only if exact equal-area roll-up matters.
- **D3 — Expression language.** Lean **CEL** (`cel-interpreter`) for portability + sandboxing over `rhai`.
- **D4 — How far to take incremental in v1.** Early cutoff at the pack boundary is cheap/high-ROI; full
  projection-firewall partitioning is more work. Ship Phase 6 in two sub-steps.
- **D5 — Materialize-vs-filter: hand-declared vs engine-derived.** _Hand-declared in v1_; engine derivation
  depends on the unbuilt sufficient-stats layer — defer to Phase 4+.
- **D6 — Time-window reconciliation in the ladder.** When an automatic rung (iso) changes the global time
  window, co-resident layers (boxes, tracks) break. Options: per-rung window clamp with a floor; decouple
  per-layer windows; or forbid switches that change the window while incompatible layers are resident.
  _Needs a decision before Phase 3 ships the AV ladder._

## 10. The things to take first

1. ~~Fix determinism~~ (§7.1) — **✅ CLOSED 2026-07-04** (arrow ≥59, byte-reproducible builds); the
   CAS/edge-cache/incremental prerequisite is met.
2. **Ship the rung registry** (§6.1) — pure consolidation, zero new machinery, kills the 4-place drift +
   dual-copy palettes; the prerequisite for a zoom-driven ladder. _Highest-leverage, lowest-risk._
3. **Consolidate the σ estimator + voxel-real reducer** (§3.6) — one planarity operator + one reducer
   replace 3–4 copies each; the shared "geometry-aware budget" every spatial rung parameterizes.
4. **Wire the AV-LiDAR representation ladder** (§4.5) — the proof that "high-level and zoomed-in are
   different techniques" can be automatic. (Resolve D6 first.)
5. **Sufficient statistics on the summary tier** (§3.4) — a few f32 columns buy mean/variance/correlation/
   trend at read time with no rebuild; best ROI in the cube layer + the key to ladder-rung consistency.

**The two conceptual distinctions to get right:** (1) continuous-LOD vs representation-switch (same
primitive vs different primitive+algorithm) and (2) surviving-sub-unit vs synthesized-unit (the
materialize-vs-filter predictor) are _orthogonal_ axes — a same-primitive operation can still require
materialization (per-zoom clustering). And **LOD changes the resolution of the answer; encoding changes the
price per unit** — keep that seam clean, but remember encoding levers can still conflict with each other
(dedup vs locality; pack-quat vs vector-group).

---

## Appendix A — operator catalog (names + one-liners)

The ~116 emergent operators, by axis. Detailed per-archetype ordering and SoTA lessons live in git history
(the pre-condense revision); this is the reference index.

**Spatial (S).** reproject/quantize (world-grid fixed-point, pre-dedup); DGGS index (Quadbin/H3/S2 — prefer
perfect-nesting quadtrees for roll-up); Visvalingam simplify with **inline effective-area** (one ranking,
many zooms — the unexploited win); voxel decimation (uniform / adaptive-curvature `adaptive_lidar_select`);
Supercluster per-zoom clustering (synthesized → materialize); additive-octree `home_zoom` (surviving →
filter); min/max-zoom band + `min_safe_zoom`; bbox covering column (GeoParquet-1.1 pruning).

**Temporal (T).** temporal-bucket / temporal-LOD pyramid + adaptive chunking; static/dynamic collapse
(`--scene-split` / worldbuild / `erasor_scrub` → `static_full_range`); per-sweep `home_zoom`; time-series
codec (delta-of-delta / Gorilla-XOR / RLE, raw fallback); cumulative prefix-sum (window = two subtractions);
value-matrix corridor (T lives in A); paged directory `[t_min,t_max]` + `cover_t_min` page pruning.

**Attribute (A).** OLAP measure classification (distributive/algebraic/holistic); sufficient statistics
`{n,Σx,Σx²}` (Gaussian Cubes); partial-cuboid pyramid + iceberg fold; aggregation-vs-shading split
(Datashader); analytics (KDE raster, Getis-Ord Gi\*, Mann-Kendall trend, TRACLUS partition, offline
ST-DBSCAN labels); `--quantize-attr` / auto-u16 (encoding, not LOD); category coarsen (32→9 lidarseg);
`--exclude`/`--include`/`--exclude-all`; sequential ids; `--vector-group` FixedSizeList; `--pack-quat`
(superseded by vector-group).

**Trajectory / flow (span axes).** map-match (HMM, OSRM/Valhalla) into silver + shared-corridor dedup; OD
aggregation → sparse flow edge list; edge bundling (deterministic CPU KDEEB, global per-zoom); OGC Moving
Features / MF-JSON interpolation-mode field.

**Correctness (always-on).** pre-tessellation (baked earcut); multipolygon splitting (radar/wildfire).

**Encoding (orthogonal).** coord quantization (world grid); attribute quantization; time-delta codec;
vector-group; blob-ordering; zstd level; content-addressed dedup.

## Appendix B — the 13 representation switches already in the codebase

Enumerated as (overview technique → detail technique, trigger): summary tier (H3/Quadbin cells → raw
features, **zoom band** — the one truly automatic switch); density iso-lines (LineStrings → points, user
mode `-iso`); density iso-3D (stacked LineStrings → points, `-iso3d`); surfels vs points (oriented disks →
billboard dots, `-surfel`); scene-split stage+actors (static surfel stage → per-sweep actors, `-stage` —
the real split is _temporal_); worldbuild (cumulative voxel-deduped cloud → per-sweep, `-world`, held back);
flow-corridor value-matrix (static corridors + `[vertex][bucket]` → individual trips, dataset config);
per-zoom flowmap clustering (hub-pair corridors → full-res, zoom band, same layer, **synthesized → must
materialize**); baked edge bundling (KDEEB rivers → straight arcs, `--bake-bundling`); radar isobands
(marching-squares polygons → dBZ raster, composite); SCIT storm tracks (centroid trajectories → reflectivity
field, composite overlay); object tracks (per-track polylines → object points, co-emitted archive);
space-time cube (climbing 3D ribbons, read-time mode, no detail rung). **Almost none are zoom-triggered** —
they're wired to a pill the user clicks or a separate dataset entry (§4.2).

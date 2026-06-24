# STT Preprocessing Framework — "Bake the analytics into the tiles"

*Design synthesis, 2026-06-16; comprehensively revised 2026-06-22 against the AV/LiDAR
exploration (surfels, scene-split, additive-octree zoom-LOD, density iso-lines, adaptive
decimation). The 2026-06-22 pass harvested **116 distinct preprocessing operators** that
have emerged across the codebase — the Python AV extractors, the Rust `stt-generate` →
`stt-build` crates, the roadmap docs, and the render path — and reorganizes the framework
around three findings the original draft didn't have: (1) a **dataset-bigness archetype
playbook**, (2) a **unified spatial × temporal × attribute LOD model**, and (3) the
**representation ladder** — the answer to "should the high-level and zoomed-in views be
different techniques?" (yes; you already built all the pieces, none of it is wired to zoom).*

---

## 0. The one principle everything follows from

> **Read-time cost should depend on output resolution (cells × time-buckets × dimensions),
> never on N (record count).** Anything expensive that can be made a pure function of the
> input — layouts, clusters, aggregations, trend statistics, tessellation, ordering — is
> *baked once at build time* and shipped as a cheap-to-read artifact.

Every system we surveyed (tippecanoe, Planetiler, PMTiles, COPC, Datashader, Nanocubes,
imMens, Gaussian Cubes, Supercluster, flowmap.gl) is one realization of this. STT already
lives here for many datasets (BIXI clustering, flow-corridor value-matrix, summary tiers,
additive-octree LiDAR). The framework's job is to make this the *default, reusable* path for
every dataset instead of bespoke per-generator code.

Three corollaries shape the whole design:

1. **Conserve, don't discard** (the "no-thinning" principle). The build's job is to *aggregate
   and reorganize* so the GPU sees a tractable number of primitives — not to throw data away.
   Dropping stays strictly opt-in; **aggregation/coalescing is the conserving alternative** and
   becomes a first-class operator. The strongest form is *lossless union*: a single baked
   ranking where the union over all levels reconstructs N exactly (the additive-octree).
2. **Determinism is load-bearing, not cosmetic.** Content-addressed packs only dedup, edge-cache,
   and incrementally rebuild if identical logical input → identical bytes. The known
   *non-reproducible-packs bug* (Arrow-metadata `HashMap` iteration order) silently breaks all
   three. **This is the prerequisite, fixed first** (§7).
3. **LOD changes the *resolution* of the answer; encoding changes the *price per unit* of answer.**
   `--quantize-attr`, `--vector-group`, blob-ordering, `--quantize-coords` are *not* LOD — they
   are bytes-per-output-unit multipliers. They compose with LOD; they never substitute for it.
   Keeping this seam clean is what lets STT apply born-optimized encoding universally at the
   `run_stt_build` boundary without per-axis coordination. (Caveat: a *few* encoding levers
   conflict with **each other** — see §1.4.)

---

## 1. The reframe — two orthogonal classification axes

The 116 emergent operators collapse onto a small number of decisions. The single most
important conceptual upgrade in this revision: **two decisions that the codebase currently
tangles together are actually orthogonal.** Getting them separated predicts byte cost, the
hand-off contract, and the determinism burden of every operator.

### 1.1 Axis 1 — same primitive, or a different one?

- **Continuous LOD** (*same-primitive, different-fidelity*). Overview and detail are the same
  visual+algorithmic object, sampled coarser. Decimate points (`--lod`, adaptive-voxel),
  simplify a polyline (Visvalingam / TD-TR), roll a value-matrix to a coarser bucket, snap to a
  coarser grid (`--quantize-coords`). Reconstruction = interpolation/sampling of the *same* data
  type. Rides the existing chassis — one layer class, one shader, a `level` parameter. A point is
  a point at every zoom.
- **Representation switch** (*different-primitive, different-algorithm* — "semantic LOD"). The
  overview is a categorically different object from a different operator, drawn by a different
  primitive. Raw returns → density iso-line LineStrings (marching squares). Points → H3/Quadbin
  cells (binning). Trips → flow corridors (sparse-edge aggregation). Reflectivity grid → isoband
  polygons or storm-cell tracks (contouring / connected-components). You **cannot** recover the
  overview by sampling the detail — you recompute it with a fundamentally different operator. A
  point at z18 becomes a *hexagon* at z8, and the hexagon answers a different question
  ("how many / how dense" vs "where exactly").

### 1.2 Axis 2 — surviving sub-unit, or synthesized? (the materialize-vs-filter predictor)

This is the axis that actually predicts cost:

- **Surviving sub-unit** (a real point, vertex, feature) → **bake ONE ranking, filter at read.**
  If each output unit carries a single monotone number *r* = "the coarsest level at which I
  appear," any level L is served by the predicate `r ≤ L`. No per-level copies; union
  reconstructs N (lossless). This is exactly the additive-octree `home_zoom`.
- **Synthesized unit** (a cluster centroid, a contour ring, a *holistic* aggregate like median)
  → **must materialize each level.** No per-fine-unit threshold reconstructs a synthesized object.

The predictor lines up with OLAP measure classification (§3.4a): *distributive/algebraic*
measures over *surviving units* → filterable from one baked ranking; *holistic* measures or
*synthesized geometry* → materialize.

### 1.3 The two axes are independent — and the codebase conflates them

The classic trap, made concrete by the inventory:

| | **Surviving sub-unit** → filter | **Synthesized unit** → materialize |
|---|---|---|
| **Continuous LOD** (same primitive) | additive-octree `--lod`; min/max-zoom bands; VW inline-area *(if baked)* | **per-zoom clustering** (same FlowmapLayer, but centroids are synthesized → must materialize per zoom); 5-fixed-density-tiers |
| **Representation switch** (diff primitive) | — *(rare: a switch usually synthesizes)* | summary cells; iso-lines; flow corridors; storm tracks; surfels-as-overview |

Per-zoom flowmap clustering is the clarifying case: Axis 1 says "same primitive, looks
continuous/cheap," but Axis 2 says "synthesized centroids, must materialize." Both are true.
Treating Axis 1 as if it implied Axis 2 is what produced the dead **5-fixed-density-tier**
approach (5 strided copies, ~2× storage) where the data was surviving sub-units and one ranking
would do — which is exactly what `--lod` now does, lossless, at ~½ the bytes.

### 1.4 The encoding lever (third, mostly-orthogonal) and where it bites back

Encoding levers (`--quantize-coords`, `--quantize-attr`, time-delta codec, `--vector-group`,
blob-ordering) are bytes-per-unit multipliers; they compose with LOD freely and never change
output resolution. **But two documented cases show encoding levers conflicting with *each
other*** — the "encoding never couples" claim is false at the encoding↔encoding boundary:

- **Dedup vs. blob-locality.** Byte-identical-tile dedup *hurt* range locality on earthquakes
  (76% identical tiles → repack **+116% worse** request locality). You cannot maximize both.
- **`--pack-quat` vs. `--vector-group`.** Smallest-three quaternion packing (3 components + 2-bit
  largest-index, ~12% off a surfel tile, lossless to ~0.16°) was **superseded** by the zero-copy
  vector-column work, which binds *full* quats for a zero-copy GPU bind and undid the packing.
  This is a *resolved* tension in the shipped code — vector-group won — not a live either/or.

The lesson: LOD axes couple (§3.5); encoding generally doesn't couple with LOD but *can* couple
with other encoding. The framework should own this matrix rather than let each operator
re-discover it.

### 1.5 The third operator category the original draft missed: correctness-mandatory

Not every non-default operator is opt-in. **Pre-tessellation** (baked earcut triangles) and
**wildfire/radar multipolygon splitting** are *always-on* for multi-ring polygons — they fix the
spanning-triangle / streak artifact (storm-radar isoband streaks, wildfire spikes). They are not
LOD, not encoding, and not opt-in: they are **correctness preprocessing**. A framework that
declares "every non-default operator is opt-in and default-inert" is simply wrong about these.
Give them their own category: *always-on correctness operators*, distinct from the
conserve/discard-graded LOD operators.

---

## 2. Dataset bigness archetypes → the onboarding playbook

Different "bigness" demands different preprocessing, and the codebase's measurements prove
*which lever wins for which bigness* — usually counter to intuition. This section is a lookup
table you consult when onboarding a new dataset.

### 2.1 Measure first (this is non-negotiable)

The single most-repeated lesson: **intuition and deep research both lose to per-column byte
attribution.** Before any playbook, run `point_column_stats.rs` (per-column post-zstd bytes) on
a representative tile, and for point clouds run `scripts/data-generation/lidar_summarize_eval.py`
(fidelity bake-off). Two overturns on record:

- The "port uint16-RTC + octree geometry" plan **died** when `point_column_stats` showed AV
  LiDAR geometry was only **12.7%** of bytes while id-hash (**40%**) and raw-f64 z (**38%**)
  dominated. The win was sequential ids + `--quantize-attr` on z, *not* the researched geometry
  lever.
- "Lightweight column encodings" (delta-varint / RLE / byte-shuffle) were **measured-no-go**:
  they win *relatively* on time columns that are <1% of payload, and make the dominant coordinate
  column *worse* (byte-shuffle **+31–68%**) because zstd already models raw LE f64 better.

Your dominant column tells you your archetype.

| Archetype | One-line definition | The axis that blows up | Diagnostic signal |
|---|---|---|---|
| **Temporally-big** | Same geometry observed over many timesteps | timesteps × features (per-instant replication) | a 1h base bucket pulls **180×** a 60s window; static structure stored per-sweep |
| **Spatially-big** | One instant already too dense; N dominates | point/vertex count + near-incompressible per-point geometry/attrs | z14 tile is **20 B/pt**; a single sweep is millions of returns |
| **Metadata-big** | The *directory* and/or per-feature attribute width dominates | directory bytes grow with N not viewport; wide/high-entropy attr columns | id-hash is **40%** of a point; cold-start whole-directory load wall |
| **Both-big** | Dense instants *and* many of them (the AV case) | point-count × sweeps simultaneously | a ~15s LiDAR log ≈ **180M** returns across hundreds of sweeps |

The archetypes are **not exclusive** — most real data is a hybrid. The hybrid rule: layer the
playbooks **temporal → spatial → attribute**, because each stage changes what the next sees
(collapsing time removes sweeps before you spatial-LOD the survivors; decimating points removes
rows before you quantize their columns). **One exception** — the `--lod` path *fuses* spatial and
temporal (§3.5, C2) and is an *alternative whole pipeline*, not a late step.

### 2.2 Archetype 1 — temporally-big

*Examples:* NYC taxi paths/trips (1h base → 180× over-fetch vs 60s window); satellites (z0 is
one world cell, can't split spatially — 17 MB for a 1 s slice); the static substrate of any AV
log; BIXI OD flows over hourly bins. *Bottleneck:* timesteps × features → **over-fetch**.

| # | Operator | Why this order |
|---|---|---|
| 1 | **Temporal bucketing** (`--temporal-bucket`) — finer base window | The PRIMARY lever; the no-thinning-compliant fix. Defines the time grid every later temporal op is a multiple of. satellites z0 17MB→~1–2MB; nyc-taxi-paths 180×→~10–20s. |
| 2 | **Static/dynamic temporal collapse** (`--scene-split` / worldbuild / `erasor_scrub`) — *iff a static substrate exists* | Collapse "many sweeps of the same wall" into ONE timeless full-range bucket (`static_full_range`) while keeping movers per-sweep. The single highest-leverage idea against temporally-big AV data. Do it before re-bucketing the dynamic remainder. |
| 3 | **Value-matrix aggregation** (FlowAggregator / `--flows`) — *for trips/flows* | Emit geometry ONCE, carry a `[vertex][bucket]` count matrix; animation is a column read, not per-instant streaming. Read-cost ∝ corridors × buckets. Flow-snap took 410K→28K corridors, 980MB→70MB. Keep the `--paths` intermediate so you can re-bin without re-routing (silver layer). |
| 4 | **Temporal-LOD pyramid / adaptive chunking** | Coarser tiers (strict multiples of base) for zoomed-out scrubbing, or equalize features-per-window for bursty data. |
| 5 | **Dead-column suppression + vertex-time delta** (`--vertex-time-precision`) | Timeless value-matrix corridors carry dead per-vertex-time columns — suppress them. |
| 6 | **Paged directory** (geo/zoom/`[t_min,t_max]` pointers) + `cover_t_min` | Read-side: prune whole pages whose `[t_min,t_max]` is entirely after the playhead. Earns its keep on bursty data (wildfires). |

*Avoid:* lightweight time-column encodings (measured-no-go — negligible absolute). For
value-matrix line archives, **never** `--simplify` or `--quantize-coords` (breaks vertex↔coord/
time alignment, trips the PathLayer instanced vertex-buffer bug).

### 2.3 Archetype 2 — spatially-big

*Examples:* AV LiDAR single sweeps (z14 tile 20 B/pt pre-optimization); radar reflectivity
fields; dense point datasets at hero zoom. *Bottleneck:* **bytes-per-point vs point-count — you
must measure which.** For AV, id-hash 40% + raw-f64 z 38% ≫ geometry 12.7%, so it was
bytes-per-point.

| # | Operator | Why this order |
|---|---|---|
| 1 | **Sequential point ids** + **drop dead columns** (`intensity`) | Cheapest, lossless, born-optimized default. id-hash was the biggest LiDAR column (40%, 8.04→1.07 B/pt). intensity = −1.66 B/pt (8.3%), read by nobody. |
| 2 | **Point-count reduction** (`adaptive_lidar_select` / `--adaptive-decimate`) — *only if you genuinely need fewer points* | Geometry-aware: keep top-curvature returns as REAL points + one real voxel-representative per flat region. Bake-off winner: ~2–4× fewer points at equal/better point-to-plane RMS (8.7 cm @ ¼ budget vs uniform stride 29.7 cm). Keeps REAL points so attributes ride along → run before quantize/colorize. **Strong user veto, see below.** |
| 3 | **Attribute quantization** (`--quantize-attr` / `--quantize-attrs-auto`) | THE measured byte winner. z 7.58→0.69 B/pt; whole Waymo bundle 3.84GB→633MB (**6.07×**); z14 20→4.4 B/pt (4.55×). Affine offset pinned to per-column min → deterministic, dedup-safe. |
| 4 | **Camera colorize** (`CameraColorizer.colorize`) — *if photographic color wanted* | Bake per-point RGB. Write Int64 not Int16 (stt-build silently drops Int16). Fuse multi-observation color in **linear light** (`srgb_to_linear` → weighted mean → grade), not sRGB, or you darken/desaturate. Then quantize r/g/b step=1 (lossless u16). |
| 5 | **Representation decoration / switch** (`--surfel` covariance fit, or `--contours` iso-lines) | Different *primitive*, build-time. Fit AFTER count reduction so surfel disks auto-grow to fill decimated gaps. |
| 6 | **Vector-group zero-copy columns** (`--vector-group`) + **coord quantization** (world grid) | Fuse quat/scale/rgba into FixedSizeList for zero-copy GPU bind (kills main-thread re-pack stutter). Coord-quant to a **world grid, NOT per-tile** (per-tile origin breaks cross-tile dedup, measured +61%). |
| 7 | **Additive-octree zoom-LOD** (`--lod`, `lod_home_zoom`) | The genuine spatial LOD: each point materialized at exactly ONE per-sweep `home_zoom`; FE loads union `[minZoom..cameraZoom]` with no parent de-dup. Lossless (union = full cloud), ~½ bytes vs 5 fixed density tiers. Built by reusing `--min-zoom-field`=`--max-zoom-field`=home_zoom (zero new Rust). Mutually exclusive with surfel/world/scan/contours/scene-split in one build. |

*Avoid:* **Point-count reduction when the user values density** — hard steer on record: decimate-12
read "too low res," they preferred decimate-4 (denser than baseline). The durable lever is
bytes-per-point, NOT fewer points, even though adaptive-voxel *proves* 3–4× fewer at equal
fidelity. Default to byte-shrink, keep decimation opt-in. Also avoid uint16-RTC per-tile geometry
quantization (breaks dedup for ~1 B/pt) and the dead 5-fixed-density-tier approach (retire for
additive `--lod`).

### 2.4 Archetype 3 — metadata-big

*Examples:* earthquakes (title/place strings ≈46% of payload, unquantizable; the directory
whole-load wall); osm-changesets (high-entropy ids); AV per-point quaternion columns (~46% of a
quantized surfel tile, near-incompressible). *Bottleneck:* attribute **width/entropy** per feature
**and/or** directory size at cold start.

| # | Operator | Why this order |
|---|---|---|
| 1 | **Sequential ids / feature-id de-entropy** | Replace high-entropy hash ids with a monotonic per-tile row index (points never split across tiles → need no global id). Biggest column on many datasets. Lossless, decode-free. |
| 2 | **Attribute filter** (`--exclude` / `--include` / `--exclude-all`) | Drop columns no consumer reads. **Guard** against dropping a heatmap/summary/min-zoom *source* column. Early → fewer columns downstream. |
| 3 | **Attribute quantization** (`--quantize-attr` / auto u16) | Float64→u16 + affine. Note the determinism split: world-grid coords are globally index-stable; auto-attr-quant is range-adaptive per-tile (same value → different index across tiles) — both dedup-safe, only the former cross-tile comparable. |
| 4 | **Smallest-three quaternion packing** (`--pack-quat`) — *orientation columns* | Drops the ~46% near-incompressible quat column ~12%. **Superseded by `--vector-group`** in the shipped path; documented here as a *lesson* (byte-lever vs stutter-lever conflict), not a live knob. |
| 5 | **zstd level 19** | Free ~2× on the wire if stale dirs shipped uncompressed; decode-level-independent (free on client). |
| 6 | **Paged directory** w/ geo-bbox + zoom + t-bounds pointers | THE directory-big lever. Root page-table + leaf pages; pointers carry bounds → reader prunes whole pages without fetching. First-frame directory bytes → 1–14% of whole-load (eval 3.38→2.41 MB, root 524 B). +6–19% at-rest, paid once by the CDN. Sweet spot 1024–4096 entries/page. |

*Avoid:* a shared zstd dictionary across pages (the TS reader throws on shared-dict archives).
Per-page encoding that breaks the whole-dir zstd window (earthquakes anomaly +117% from losing
cross-blob dedup). Promising big wins on text-heavy datasets without measuring (earthquakes only
−12% — strings are a hard floor).

### 2.5 Archetype 4 — both-big (the AV case)

*Examples:* Argoverse 2 / Waymo LiDAR logs (~180M returns across a ~15s drive). *Bottleneck:*
point-count × sweeps, at once. *Key insight:* the static substrate is spatially-big but
temporally-redundant; the dynamic returns are temporally-essential but spatially-sparse — so
**decompose, then apply the matching playbook to each half.**

| # | Operator | Why this order |
|---|---|---|
| 1 | **Local-frame georeferencing** (`local_to_lonlat` / `utm_to_lonlat`) | Not a bigness lever but the metric frame every later op depends on. Use UTM/equirectangular, **NOT mercator** (deflation shifted Boston ~450 m). |
| 2 | **Scene-graph decomposition** (`--scene-split`: stage + actors) | THE both-big move. STATIC timeless stage (all sweeps accumulated, movers removed via in-box + `erasor_scrub`) + DYNAMIC per-sweep actors. Collapses the time axis for everything that doesn't move; preserves motion. Do this *before* any per-point optimization. |
| 3a | **STAGE → spatial-big playbook + temporal collapse**: `adaptive_stage_select` → `CameraColorizer` (linear light) → surfel fit *per-archive* → quantize → `static_full_range` (1 bucket) + `STAGE_MIN_ZOOM=17` | Stage is now a single timeless cloud → apply Archetype 2. **Fit surfels PER-archive** (fitting on the union distorts both). `STAGE_MIN_ZOOM` floor prevents a low-zoom megatile (root cause: per-tile *decode* memory — the 62 MB tile). Stage conserve contract is **three-way**: conserve-geometry + discard-redundant-observations + collapse-time. |
| 3b | **ACTORS → temporal playbook, conserve-all**: per-sweep time, `--actor-denoise` (SOR, opt-in) only if noisy, temporal-bucket, surfel fit per-archive | Actors keep per-sweep time so a car doesn't smear into a streak. Denoise is OPT-IN (only the rain highway needs SOR). |
| 4 | **Shared byte levers on both**: seq-ids, `--quantize-attr` (auto), `--vector-group`, world-grid coord-quant, `LIDAR_MIN_ZOOM=14` | Born-optimized defaults via `run_stt_build`. The measured 4–6× win, applied uniformly. |
| 5 | **(Optional) the two-archive split feeds the multi-source governor** | Stage = OPTIONAL governor source (loads once, never gates); actors = REQUIRED/animated. *This is coupling C4 — see §3.5.* |

*Avoid:* fitting surfels/normals on the *union* of stage+actors. Running spatial decimation/quant
*before* the temporal collapse (you'd optimize rows the stage-merge dedups away). Bare-numeric
categorical columns (`world_class`, label-as-number) — stt-build promotes all-numeric-string to
Numeric and silently no-ops categorical color maps; use `'static'`/`'dynamic'` strings, keep
`is_dynamic` as a separate numeric 0/1. nuScenes worldbuild/surfel (32-beam too sparse).

### 2.6 Quick lookup

| "My data is mostly…" | Do this, in order |
|---|---|
| **temporally-big** (taxi/flows/satellites) | finer `--temporal-bucket` → (value-matrix for flows) → temporal-LOD / adaptive tiers → suppress dead time cols → paged t-bounds |
| **temporally-big w/ static substrate** (AV stage) | scene-split / worldbuild collapse → erasor_scrub → quantize → `STAGE_MIN_ZOOM` floor |
| **spatially-big** (dense LiDAR, one instant) | seq-ids + drop dead cols → (`--adaptive-decimate` only if you truly need fewer pts) → **`--quantize-attr` (primary, 6×)** → colorize(linear-light) → surfel/iso → vector-group + world-grid coord-quant → `--lod` |
| **spatially-big + wide attrs** | above + `--exclude` dead cols + (`--vector-group`, not `--pack-quat`) |
| **metadata-big (directory)** | seq-ids → zstd-19 → **paged directory w/ geo+zoom+t bounds (primary)** |
| **metadata-big (attr width/entropy)** | id-de-entropy → `--exclude` → quantize-auto-u16 |
| **both-big** (AV LiDAR) | georef → **scene-split (primary)** → [stage: spatial-big + `static_full_range`] ∥ [actors: temporal, conserve-all] → universal byte levers → paged t-bounds |

### 2.7 Cross-archetype invariants (the framework should own these)

These bite in every archetype; today each operator re-hand-rolls them:

1. **Determinism is load-bearing** (packs are content-addressed). World-grid (not per-tile) coord
   quant; per-column-min affine offsets; commutative reductions (max-combine mosaic, summed flows,
   ERASOR); pinned non-parameter constants (KDEEB resolution/iterations, no RNG). **Known systemic
   hole:** arrow-ipc serializes Field metadata in `HashMap` iteration order → identical tiles
   encode byte-differently ~50% of the time, silently capping dedup + blocking incremental re-sync.
   Fix is a one-time fleet re-transcode sequenced with the next format bump (§7).
2. **Quantize/aggregate before dedup, on a global grid.** Any per-tile-relative encoding is
   punished by cross-tile dedup (+61% on a per-tile coord grid).
3. **Global-per-zoom, never per-tile** for any spatial aggregation/bundling/clustering — tile-local
   subsets seam. Collect the whole per-zoom set → process → band per zoom.
4. **Conserve > discard.** Lossy levers (`--simplify`, `--drop-densest`, summary tiers, point
   decimation) are opt-in and default-inert (byte-identical). Prefer a zoom clamp
   (`min/max-zoom-field`, `min_safe_zoom`) over aggregation; when you must aggregate, keep full-res
   at the deepest zoom.
5. **Line/path archives have a sharp constraint cluster:** never `--quantize-coords` (dequant
   mis-sizes PathLayer's instanced draw → GL vertex-buffer-too-small), never `--simplify` (breaks
   vertex↔coord/time alignment), expand instanced attrs **per-vertex** not per-feature.
6. **Categorical columns must carry non-numeric string labels** (`'-2-0'` not `0`) or stt-build
   promotes them to Numeric and no-ops the color map.
7. **Always-on correctness operators** (pre-tessellation, multipolygon split) are mandatory for
   multi-ring polygons and are *not* opt-in (§1.5).

---

## 3. The unified spatial × temporal × attribute LOD model

STT has been treating LOD as 1-D (mercator zoom) while actually operating in 3-D. Naming the axes
and the operators that move along each is what turns "a zoo of flags" into a model. (This section
subsumes and reframes the original draft's separate spatial/temporal/aggregation operator
sections; the SoTA per-operator detail is preserved inline.)

### 3.1 The cube

- **Axis S — spatial resolution.** Vertices per linestring, points per voxel, cells per km²,
  features admitted at a zoom. Unit: *cells* (or screen-space-error px).
- **Axis T — temporal resolution / window.** Bucket width, pyramid tier, per-sweep grain,
  static-collapse, how much time a tile pulls. Unit: *time-buckets*.
- **Axis A — attribute / dimension detail.** Measures, numeric precision, semantic granularity per
  output unit: full per-record fields → sufficient-stats → quantized scalar → coarsened categorical
  → dropped. Unit: *dimensions × precision*.

The product **S × T × A is the output-resolution volume** read-cost is proportional to. A tile
request is a *box* in this cube; cost ≈ box-volume × bytes-per-unit (the encoding lever).

```
                          ATTRIBUTE detail  A
                          (dims × precision × semantic granularity)
                          ▲
              full record │           ┌─────────────────────────────┐
              per-feature  │          ╱│                            ╱│
                           │         ╱ │   raw detail tile          ╱ │
              quantize-attr│        ╱  │   (deep zoom, fine bucket, ╱  │
              vector-group │       ╱   │    full attrs)            ╱   │
                           │      ┌─────────────────────────────┐    │
              suff-stats   │      │    │                         │    │
              {n,Σx,Σx²}   │      │    └────────────────────────│────┘
                           │      │   ╱                          │   ╱
              OLAP measure │      │  ╱   summary/overview tile    │  ╱
              (Sum/Mean..) │      │ ╱    (shallow zoom, wide      │ ╱
                           │      │╱     bucket, rolled-up dims)  │╱
              coarsened    │      └─────────────────────────────┘
              categorical  └──────────────────────────────────────────▶ SPATIAL  S
                          ╱                                            (cells / SSE px)
                         ╱  coarse cells ──────────────── fine vertices
                        ╱   quadbin roll-up    additive-octree home_zoom
                       ▼     per-zoom cluster   VW simplify   voxel decimate
              TEMPORAL  T
              (time-buckets / window)
              static-collapse → LOD-pyramid → base-bucket → per-sweep grain

   READ COST ∝ VOLUME(S × T × A) · bytes-per-unit
              └────────── LOD axes ──────────┘   └ encoding lever ┘
```

The classic mercator pyramid only ever moved you along S. STT's frontier is that **T and A are
first-class tiling/LOD axes with no prior art to copy.**

### 3.2 Axis S — spatial operators

| Operator | What it bakes | Surviving/synth | SoTA lesson |
|---|---|---|---|
| **Reproject / Quantize** | fixed-point integer coords on a tile-local **world** grid | — (encoding) | Quantize *before* dedup/topology — a **correctness prerequisite** (near-identical floats must become bit-identical), not just size. Run it pre-dedup on a world grid. |
| **Index (DGGS)** | hierarchical cell id per feature (Quadbin / H3 / S2) | synth | **Prefer perfect-nesting quadtrees (Quadbin/S2) for roll-up** — parent = exact union of 4 children. H3 is index-exact but geometry-approximate (children cross parent edges) — fine for neighbor/flow, wrong for exact roll-up. Quadbin is 1:1 with the XYZ tiles deck.gl already requests; encode level in the id's lowest-set-bit → "all descendants" is an integer `BETWEEN` range (feeds paged-directory bounds). |
| **Simplify (one ranking, many zooms)** | per-vertex Visvalingam **effective-area** stored *inline* | surviving | **The highest-value unexploited vector trick.** Run VW once, store each vertex's effective area as a z-value; every zoom is then a pure *filter* (`drop vertices with area < threshold-at-zoom`) — no per-zoom geometry. STT currently re-simplifies per zoom. Prefer VW over Douglas-Peucker (DP's ranking is recursive, not a flat per-vertex weight). Gated by the line-archive constraint cluster (§2.7.5). |
| **Voxel decimation** (uniform / adaptive-curvature) | a subset of REAL returns | surviving | `adaptive_lidar_select` / `adaptive_stage_select`: keep top-curvature returns + one real voxel-representative per flat region. The **real-representative voxel reducer** is reimplemented ≥3× (`_voxel_real_indices:1579`, `WorldVoxelAccumulator:2093`, `lidar_summarize_eval.py:63`) — a textbook consolidation target. |
| **Cluster (per-zoom, Supercluster)** | one greedy weighted-centroid clustering per zoom | **synth → materialize** | Steal Supercluster wholesale; generalizes BIXI `ClusterHierarchy`. Add a temporal radius to the merge predicate (ST-DBSCAN's two-eps, greedily). Cluster radius is a **screen-space pixel** budget. Centroids are synthesized → cannot be a ranking-filter (§1.2); materialize per zoom. |
| **Additive-octree zoom-LOD** (`home_zoom`) | per-point coarsest-zoom rank | **surviving → filter** | The exemplar of "one ranking, many zooms": one `home_zoom` per point, read-time `union[minZoom..cameraZoom]`, no parent de-dup, lossless. Built by reusing `--min/max-zoom-field`. |
| **Min/max-zoom band + min_safe_zoom** | per-feature zoom band / floor | surviving → filter | Pure baked-band skip — a read-time predicate, no re-materialization. Additive-octree is implemented *as* a degenerate `min==max` band. |
| **bbox covering** | per-feature xmin..ymax scalar columns | — | GeoParquet 1.1 covering: plain columns the container keeps min/max stats on → row-group skipping / spatial pushdown, no bespoke index. |

### 3.3 Axis T — temporal operators

| Operator | What it bakes | Surviving/synth | SoTA lesson |
|---|---|---|---|
| **Bin / temporal LOD** | fixed or adaptive bucket assignment + coarse pyramid | surviving (sizing) | The fundamental T-knob. Make adaptive chunking (density-targeted bucket width) a first-class stage, not a flag. |
| **Static/dynamic temporal collapse** | a timeless stage (1 full-range bucket) + per-sweep actors | stage = collapse; actors = conserve | The cleanest temporal LOD: store the wall *once*, not ×180 sweeps. Re-expressed **three ways** (`worldbuild is_dynamic`, scene-split two-archive, ERASOR drop-mask) that share `point_in_moving_boxes` but diverge — unify. |
| **Per-sweep `home_zoom`** | the octree's spatial rank, computed per-sweep | surviving | A *spatial* rank parameterized by *temporal* grain (a global voxel claim would let sweep 1 steal sweep 2's overview points; `test_per_sweep_independence`). This is coupling C2 (§3.5). |
| **Time-series codec** | per-cell value-over-time array, per-column codec | — (encoding) | Choose per column: **delta-of-delta** on regular timesteps, **Gorilla XOR** on floats, **RLE** on constant runs, dict on low-cardinality; **fall back to raw when a codec would expand**. Store sparse. *Validate vendor numbers on real tiles.* |
| **Cumulative prefix-sum** | running totals along time | surviving → filter | Any `[t_min,t_max]` window → **two subtractions** at read time. Pairs with the page-pointer t-bounds. |
| **Value-matrix corridor** (T lives in A) | static geometry + `[vertex][bucket]` series | surviving → filter | Geometry materialized once, active time-bucket selected as a column read at the playhead. Read-cost ∝ buckets, not trips. This relocates T *into* A — coupling C3. |

### 3.4 Axis A — attribute / dimension operators (and the cube)

This is where the `vertex_value_matrix` gets its theoretical backbone. **Crucial split the
original draft and the inventory both blur:** A has two sub-moves —

- **(A1) dimension count / semantic granularity** = *true LOD* (drop a measure, coarsen 32→9
  lidarseg classes, roll up to Sum). Changes the answer resolution; can be lossy-at-the-semantic-
  level.
- **(A2) numeric precision** (`--quantize-attr`) = *encoding*. Changes bytes-per-unit, never the
  number of units. **File it under encoding (§1.4), not attribute-LOD** (the inventory's single
  `attribute-lod` tag conflates these two).

**(a) Classify every measure (OLAP rule — prevents average-of-averages):**
- **Distributive** (SUM/COUNT/MIN/MAX) → roll up freely, bake at every zoom.
- **Algebraic** (AVG/STD/covariance) → store the distributive *components* (sum, sum², count),
  derive on read. Never store the derived average and re-average it at the parent.
- **Holistic** (MEDIAN/distinct-count/MODE) → can't roll up; compute per-zoom from raw at build, or
  skip. **Holistic ⇒ must materialize** (Axis 2).

**(b) Bake sufficient statistics, not just counts (Gaussian Cubes — the cheap high-leverage
upgrade).** Per cell store `{ n, Σx, Σx² }` (and `Σxy` for pairs) as additive channels. At read
time reconstruct **mean, variance, correlation, linear trend, even PCA** in O(d³), independent of
N, no rebuild — the client switches what it visualizes without touching the build. A handful of
f32 columns; the single best ROI add to a count-only tile system. *(Named-but-unbuilt today.)*

**(c) The zoom pyramid IS a partial OLAP cuboid lattice — don't full-materialize.** Materialize
only tiers you serve (shell-fragment); below a min-support count, fold cells (iceberg-cube —
`--drop-densest`, now justified by anti-monotonicity).

**(d) Separate aggregation from shading (Datashader).** Bake the aggregate grid once
(count+sum+min/max in one pass); all colormapping/spreading/normalization is O(pixels) and
re-runnable at read time.

**(e) Decompose to ≤4-D dense data tiles for GPU roll-up (imMens)** for brushing/linked views.

**(f) Spatiotemporal analytics that bake cleanly:**

| Analysis | Verdict | How |
|---|---|---|
| **KDE density raster** | ✅ bake | tiled per-zoom KDE (+ bandwidth halo); quantized u8/u16 raster tier; GPU samples one texture. The principled, deterministic heatmap. |
| **Getis-Ord Gi\* hotspots** | ✅ bake (caveat) | one global pass → per-(cell, t-bucket) z-score + bin. Emerging-Hot-Spot maps exactly onto the space×time cube. Valid only for the baked grid/bandwidth/window — changing them needs a rebuild. |
| **Mann-Kendall / linear trend** | ✅ bake | per-cell trend from sufficient stats; ESRI ships exactly this in its space-time cube. |
| **TRACLUS trajectory** | ⚠️ split | bake the MDL *partition* phase (per-trajectory, local); skip the global grouping — use the flow-corridor matrix. |
| **ST-DBSCAN / HDBSCAN** | ❌ don't tile | density-connectivity/MST is whole-dataset; tile-local results are wrong. Run **offline once** on the full dataset, bake the resulting **cluster labels** as a per-point property. |

### 3.5 Independent or coupled? The four genuine couplings

The axes are **orthogonal to *request*** but **coupled in four baked places.** A recipe that
declares them independently when they're coupled will silently break.

- **C1 — spatial overview *forces* temporal collapse (the big one).** Zoom out on a temporally-big
  cloud and a single coarse tile packs the whole drive's every-sweep density into one megatile
  (`STAGE_MIN_ZOOM=17`, the 62 MB tile). S × T must stay under the per-tile decode budget, so
  pushing S out forces T in. *That is what the static/dynamic split is.* Model it as a **joint
  budget on the substrate**, not two independent dials.
- **C2 — additive-octree `home_zoom` is assigned PER-SWEEP** → the *spatial* rank is parameterized
  by the *temporal* grain. You cannot bake the S-filter without first choosing the sweep grouping.
  This is why the `--lod` path *fuses* S and T (§2.1) and is an alternative whole-pipeline, not a
  late spatial step on top of scene-split.
- **C3 — value-matrix / sufficient-stats: the T-axis lives *inside* A.** A `[vertex][bucket]` grid
  relocates time into an attribute column; the read-time T-filter (pick active bucket) is literally
  an A-axis column read. For flow/corridor layers, the T-strategy and A-strategy are **one
  decision.**
- **C4 — LOD strategy ↔ multi-source governor classification.** A static-collapse rung becomes an
  OPTIONAL governor source (loads once, never gates); per-sweep actors are REQUIRED. The build-time
  bucket width directly sets the read-time EDF deadline. So a recipe's `temporal.strategy` silently
  determines scheduler behavior — the framework must surface this, not hide it.

**A fifth, aesthetic coupling worth flagging because it blocks §4's headline win:** *render-window
↔ representation.* iso-lines narrow the time window to ~260 ms, which starves the box layer (needs
≥2 keyframes), forcing a defensive `Math.max(timeWindow, 2000)`. The chosen *representation* (an
S/A choice) silently constrains the viable *T-window*. Today it's patched defensively; an
automatic representation ladder (§4) must reconcile per-rung windows with co-resident layers.

**What is genuinely independent:** the *encoding* levers compose freely with the LOD axes (they're
bytes-per-unit multipliers that never touch resolution) — which is why STT applies born-optimized
quantization universally at `run_stt_build`. The LOD axes couple; encoding doesn't couple *with
LOD* (it can couple with other encoding, §1.4). That's a clean architectural seam.

### 3.6 "One ranking, many zooms" — the unifying idea

The deepest simplification available: **a single baked, monotone ranking can serve every LOD
level as a pure read-time threshold filter**, instead of materializing a separate artifact per
level. If each output unit carries one number r — "the coarsest level at which I appear" — then any
level L is served by `r ≤ L`. No per-level copies; union reconstructs N (lossless). This is the
structural form of the no-thinning principle: a clamp, not a drop.

Candidate rankings, all already present:

- **VW effective-area** per vertex (line simplify).
- **Octree / `home_zoom`** per point (the exemplar).
- **Cluster level** per station (Supercluster).
- **Surface-variation σ = λ₀/(λ₀+λ₁+λ₂)** per LiDAR return — the recurring k=12-NN curvature
  primitive that grades flats→coarse, edges→fine across `adaptive_lidar_select`,
  `adaptive_stage_select`, `lod_home_zoom`, `_surfel_frame`. **Reimplemented ≥3×**
  (`_surface_variation:1563`, `lidar_summarize_eval.py:45`, inline in `compute_surfels`) — a single
  "planarity estimator" operator is a clear consolidation.
- **Sufficient-stats** per cell — the A-axis analog (one `{n,Σx,Σx²}` serves Mean/Var/Sum + any
  re-roll).
- **Importance-per-byte** (`budget.rs`) — already a ranking; budget just thresholds it.
- **`cover_t_min`** per tile — a temporal ranking ("don't fetch me if my earliest datum is after
  your window").

**Where STT already filters from one ranking:** additive-octree `--lod`; `min/max-zoom-field`
bands; `min_safe_zoom` / `cover_t_min` / paged-directory bounds; value-matrix corridors;
summary-tier dispatch (one archive, `pickTierForZoom` threshold).

**Where STT still re-materializes (consolidation targets):** the dead 5-fixed-density-tiers (retire
for `--lod`); per-zoom clustering (synthesized centroids — a genuine *limit* of the ranking idea);
the temporal-LOD pyramid (re-buckets; a sufficient-stats representation would let one fine tier
serve coarse windows by read-time re-roll *if* measures are distributive/algebraic); summary cells
(materialized per-res; nested ids + sufficient-stats could collapse to one); **line simplify** (the
VW effective-area is *already computed* — bake it per-vertex and filter at read time → the single
clearest unexploited vector win, gated by the line-archive constraints).

**The boundary condition (the precise materialize-vs-filter predictor):** ranking-filter works
exactly when the coarse output unit is a **real surviving sub-unit** of the fine one (vertex,
point, feature) *and* its measures are **distributive/algebraic**. It breaks when the coarse unit
is **synthesized** (cluster centroid, contour ring, holistic aggregate) — there the level must be
materialized. This is Axis 2 (§1.2), and it lines up exactly with OLAP measure classification.

### 3.7 Trajectory / flow operators (span the axes)

- **Map-match** (HMM, σ_z ≈ 4.07 m; OSRM/Valhalla) into silver; store road polyline + per-vertex
  timestamps; **dedup shared corridor geometry across trips** (big content-addressed-pack win).
  30 s GPS sampling is provably sufficient (0.11% error).
- **OD aggregation** keyed by hierarchical cells → sparse flow edge list (not a dense matrix);
  `O(trips) → O(cell-pairs)`; re-binning to parent cells for the next zoom-out is free.
- **Edge bundling** → precompute Bézier control points at build (deterministic CPU KDEEB,
  `edge_bundle.rs`); never per-frame; **global per-zoom, never per-tile** (seams).
- **Wire vocabulary:** align the intermediate with **OGC Moving Features / MF-JSON** — record an
  explicit **interpolation mode** (`Linear`/`Step`/`Discrete`) per trajectory as a first-class
  field, since it changes GPU interpolation and is currently an assumption.

### 3.8 The accumulator contract (ties drop-budget to no-thinning)

When *any* operator removes/merges a feature (cluster, coalesce, budget-drop), fold its named
scalar attributes into the survivor via a **per-attribute reduction** (`sum`/`mean`/`max`/`min`/
`count`), and auto-emit `point_count` + `sqrt_point_count` (marker area ∝ count). Make it a
**format-level property** reusable across the build pass *and* any later merge pass (tippecanoe's
tile-join lesson). This is the `vertex_value_matrix` aggregation generalized — and it's what makes
"drop" safe: totals survive as aggregates instead of vanishing. It is also the **consistency
backbone for the representation ladder** (§4.4): every rung must be a *projection of the same
conserved accumulator*, so a monotone invariant (total count, total flow) is identical across
rungs.

---

## 4. The representation ladder — overview and detail as *different techniques*

The user's sharpest question: *"Some datasets — does it make sense to have a high-level and a
zoomed-in view be different techniques even?"* **Yes** — with a precise rule for *when*, and a
striking finding: **STT has already built every operator a representation ladder needs, but almost
none of it is wired to zoom.**

### 4.1 When a switch beats continuous LOD

> **Switch when the detail primitive's *legibility* — not just its byte cost — collapses faster
> than its information content as you zoom out. Stay continuous when sampling the same primitive
> still reads correctly, just sparser.**

Prefer a representation switch when **any** of these hold:

1. **Sub-pixel collapse.** At the overview scale the detail primitive is smaller than a pixel, so
   continuous decimation renders as noise or "nothing" (the `radiusMinPixels:0` sub-pixel-dot bug;
   satellites z0). A density contour or a hex cell *is* the legible object at that scale.
2. **Over-plot saturation.** The honest overview answer is an *aggregate* (count, density, flow
   volume) and drawing individuals paints a solid blob. Show the aggregate directly (heatmap cell,
   isoband, corridor thickness).
3. **Read-cost must decouple from N.** Even a decimated subset is too expensive; only cells×buckets
   scales. The switch buys read-cost ∝ output-resolution, which continuous LOD of the raw primitive
   cannot.
4. **The overview answers a different question.** Storm *tracks* (where it's going) vs reflectivity
   *field* (how intense, where). Flow *corridors* (which routes carry volume) vs individual *trips*.

Conversely **stay continuous** when the primitive is self-explanatory when sparse (a simplified
road network, a trajectory with fewer vertices, a LiDAR surface surfels can gap-fill) and when the
aesthetic demands raw density (the decimate-12 veto). There the durable lever is *bytes-per-
primitive*, not a switch. Continuous LOD is almost always cheaper to build and to keep consistent
(a `level` knob, lossless union, one accumulator); a representation switch is a second baked
artifact with its own operator, determinism contract, and hand-off problem — so it should pay for
that overhead via one of the four triggers.

### 4.2 The catalog of switches already in the codebase — and the critical finding

**Almost none of STT's representation switches are zoom-triggered today.** Two mechanisms are
conflated under "LOD":

- **Genuine zoom-driven switches** (camera zoom crosses a band, the tileset swaps primitive
  automatically): only the **summary tier** (`pickTierForZoom` → H3/Quadbin cells below the band,
  raw features above) and the **additive-octree union** (which is continuous, not a primitive swap).
- **User-toggled mode switches** (the AV cockpit pill row): iso-lines, surfels, stage/actors, scan,
  worldbuild, cube. Each is a *separately baked sibling archive* (`-iso`, `-surfel`, `-stage`…)
  selected by a frontend flag — a different abstraction of the *same instant*, NOT an automatic
  overview/detail handoff. You pick one mode and it's that mode at every zoom.

| # | Switch | Overview technique | Detail technique | Trigger | Build/read | Conserve |
|---|--------|--------------------|------------------|---------|-----------|----------|
| 1 | **Summary tier** | H3/Quadbin **cells** (count + sum/mean/min/max) | raw per-feature points/lines | **zoom band** (`pickTierForZoom`) — the one truly automatic switch | build tier + read dispatch | aggregate, opt-in |
| 2 | **Density iso-lines (flat)** | **LineStrings** (2D density grid → gaussian → `find_contours` @5 levels) | raw points / surfels | user mode (`-iso`) | build (`--contours`) | aggregate |
| 3 | **Density iso-3D** | stacked per-slab **LineStrings** lifted to `z_layer` | raw points / surfels | user mode (`-iso3d`) | build (`--contour-z-step`) | aggregate |
| 4 | **Surfels vs points** | oriented Gaussian **disks** (k-NN covariance → quat+extents) | billboard **dots** | user mode (`-surfel`) | build (covariance fit) | conserve (appearance, not aggregation) |
| 5 | **Scene-split stage + actors** | static surfel **stage** (all sweeps, movers removed, 1 timeless bucket, σ=1e9) | per-sweep animated **actors** (short σ) | user mode (`-stage`); the *temporal* axis is the real split | build (2 archives) | stage=collapse+conserve-geom; actors=conserve-all |
| 6 | **Worldbuild** | one cumulative surfel cloud (voxel-deduped static, `is_dynamic` branch) | per-sweep cloud | user mode (`-world`, held back) | build (streaming voxel accumulator) | static=collapse; dynamic=conserve |
| 7 | **Flow-corridor value-matrix** | static **corridors** carrying `[vertex][bucket]` matrix | individual animated **trips** | dataset config (`flowMatrix`) — not zoom | build (`--flows`) | aggregate; cost ∝ corridors×buckets |
| 8 | **Per-zoom flowmap clustering** | **hub-pair corridors** (Supercluster merge) | full-res per-station corridors | zoom band (`min==max`), same layer | build (`ClusterHierarchy`, global per-zoom) | aggregate; **synthesized → must materialize** |
| 9 | **Baked edge bundling** | smooth **P-vertex rivers** (KDEEB) | straight 2-vertex arcs | mode (`--bake-bundling`) | build (deterministic CPU KDEEB) | conserve (reshape) |
| 10 | **Radar isobands** | filled **isoband polygons** (marching squares) | raw per-cell **dBZ raster** | composite (the field layer) | build (`stt-generate storms`) | aggregate + value quantization |
| 11 | **SCIT storm tracks** | storm-cell **centroid trajectories** | raw reflectivity field | composite overlay | build (CC + nearest-centroid) | aggregate |
| 12 | **Object tracks** | per-track **polylines** | per-sample object **points** | co-emitted archive (`tracks/`) | build (`build_tracks`) | reshape |
| 13 | **Space-time cube** | track trajectories as climbing **3D ribbons** (time=height) | standalone — no detail rung | mode (`avCube:true`, read-time) | read (reuses `tracks/`) | view remap |

The "high-level + zoomed-in = different techniques" idea is **implemented bespoke and mostly NOT
wired to zoom** — it's wired to a pill the user clicks or to a separate dataset entry. *Note the
clustering row (#8): same primitive yet synthesized units — the clean illustration that §1's two
axes are independent.*

### 4.3 The systematization — a declarative representation ladder

The missing abstraction: a single ordered descriptor that says *this dataset has N representations
across scale bands; each rung names its own preprocessing operator AND its own render primitive;
the engine picks automatically by zoom (and optionally time-window); rungs are guaranteed
consistent.*

```yaml
representation_ladder:
  dataset: argoverse-miami
  consistency: { accumulator: voxel_real_rep, totals_invariant: count }   # §4.4
  rungs:
    - id: city_overview
      scale: { zoom: [0, 13] }
      operator: density_grid_contours          # build: ground-density → find_contours
      primitive: iso_lines                      # render: AnimatedPathLayer / SttIsoLayer
      conserve: aggregate
    - id: block_scale
      scale: { zoom: [14, 16] }
      operator: home_zoom_octree(curvature)     # build: additive-octree sparse overview
      primitive: surfels                        # render: SplatLayer
      conserve: lossless_union                  # union over [min..cam] = full cloud
    - id: street_scale
      scale: { zoom: [17, 22] }
      operator: identity(full_density)
      primitive: surfels
      conserve: lossless_union
  handoff:
    14->13: crossfade(zoom, 0.4)                # iso overview ⇄ octree detail
    17<-16: additive_union                      # octree rungs compose, no fade
  temporal:
    static_dynamic_split: true                  # stage(timeless) + actors(per-sweep)
  time_window_policy: per_rung_clamp_with_floor # reconciles the §3.5 fifth coupling
```

Two things make this more than config:

- **Each rung binds an operator to a primitive.** The build planner walks the ladder, runs each
  rung's operator once over the source, emits a tagged tier/archive. The frontend's
  mode/flag/layer/suffix/heldBack — **currently declared in 4+ places that drift** (the
  `renderModes` existence-probe in `AvCockpit.tsx`, the dataset memo in `datasets.ts`, the route
  regex `-(splat|surfel|iso3d|iso|world|stage|scan|lod)`, the `buildDemoLayers` `case 'av'`
  if/else, *plus* the deck↔three parity copy) — collapse to **one registry row per rung** (§6.1).
  The "is this variant baked?" existence-probe becomes "does the manifest list this rung?".
- **The ladder is the boundary between continuous and switch LOD.** Adjacent rungs with the *same*
  primitive and `lossless_union` are continuous LOD (octree levels). Adjacent rungs with *different*
  primitives are representation switches. The hand-off rule differs accordingly (§4.4).

### 4.4 Hand-off and the consistency contract

Three hand-off modes, chosen by the conserve declarations of the two rungs:

1. **Additive union (no fade).** Same-primitive `lossless_union` rungs (the octree). Client loads
   `[minZoom..cameraZoom]`, **no parent de-dup** — coarse points exist nowhere else, so they must
   persist. This is the one mode needing an explicit "no parent de-dup" read-side contract;
   currently encoded only in tests, and a reader treating it as ordinary parent-fallback silently
   drops the overview. Make `lossless_union` a **typed property the reader honors**.
2. **Crossfade.** Different-primitive rungs that both read acceptably in a transition band
   (iso-lines ⇄ surfels around z13–14). A zoom-parameterized opacity crossfade avoids a pop. Needs
   both rungs resident in the band — a cost the ladder budgets.
3. **Hard switch.** Different-primitive rungs where the overview is meaningless at detail scale or
   vice-versa (summary cells vs raw features). The existing `no-overlap` refinement (prevent
   parent-summary double-draw) is exactly this; generalize it.

**Consistency — same totals, no double-count — is the hard part**, and it ties to the accumulator
contract (§3.8):

> **Every rung must be derivable from the SAME conserved accumulator, so a monotone invariant
> (total count, total flow) is identical across rungs.**

The inventory already has the right primitive and reinvents it 3–4×: the real-representative voxel
reducer (`_voxel_real_indices`, `WorldVoxelAccumulator`, the cell-centre tie-break) and the
commutative reductions (ERASOR min/max/sum, flow SUM, mosaic max-combine). If every rung reduces
from one canonical accumulator: the octree rung's union = the detail set exactly (proven: 39440 pts
placed once not ×6); summary cell counts = the sum of raw features they cover; the flow matrix =
the sum of contributing trips. No rung *invents* totals — each is a *projection* of the conserved
set. This is why the named-but-unbuilt **sufficient-statistics** matter: a rung carrying
`{n,Σx,Σx²}` (not a baked mean) lets a coarser rung be re-derived from a finer one at read time
without avg-of-avgs, guaranteeing the invariant by construction. The single planarity/σ estimator
and the single voxel reducer become the shared "geometry-aware budget" operator every spatial rung
parameterizes (decimate count / voxel ladder / surfel extent / contour grid).

The **determinism contract** rides along: every rung operator must be byte-reproducible (no RNG —
which is exactly why the RNG-using bake-off winners were *not* shipped; only deterministic
adaptive-vox-real was), commutative-reduced, sorted-emit, global-per-zoom.

### 4.5 The gaps — datasets that force one primitive across all zooms but shouldn't

1. **AV cockpit LiDAR at city scale — the headline gap.** The cockpit forces a *single* primitive
   (points OR surfels OR iso, by pill) across *all* zooms. At city/region scale a dense cloud is a
   saturated blob (triggers #1 + #2). The iso-lines/iso-3D *already are* the correct city-scale
   representation — but they're a parallel manual mode, not the automatic overview rung of the
   point cloud. **Make iso the auto z0–13 rung, additive-octree surfels z14–16, full surfels z17+,
   of ONE dataset** — exactly "high-level and zoomed-in are different techniques." The single
   clearest place the switch should be wired to zoom and isn't. *(Blocked by the §3.5 fifth coupling
   — iso's narrow time window starves co-resident box/track layers; the ladder needs the
   `time_window_policy` to resolve it.)*
2. **Trips/paths without a flow-matrix overview.** Any `trips` dataset lacking `flowMatrix` renders
   individual trails at every zoom; zoomed out that's the over-plot blob (nyc-taxi-paths 180×). The
   flow-corridor matrix is the right low-zoom rung but is a separate dataset config, not an
   auto-rung.
3. **Point datasets without a summary tier.** Most point/trip datasets don't bake one (the audit
   flagged several heavy ones). Any spatially-big point dataset that reads as a blob at low zoom is
   a candidate for an H3/Quadbin overview rung — currently they fall back to `min_safe_zoom` clamp
   (refuse to zoom out) instead of *showing an aggregate*. The clamp is the no-thinning-safe
   stopgap; a summary rung is the better answer.
4. **Radar field with no zoom-driven track handoff.** The composite stacks field + cells + tracks
   simultaneously (painter order). At continental zoom the dense field is the blob and the *tracks*
   are legible; at metro zoom the field is right. Should be a zoom ladder (tracks-overview →
   field-detail), not a fixed stack.
5. **OSM-edits / cumulative "draw" datasets.** Cumulative slab rendering forces points at all zooms
   (sub-pixel-dot bug at metro zoom). A density/heatmap overview rung fixes the "renders empty"
   failure.
6. **Drifters / wide-time ocean datasets.** Wide-time data wins least from paging/temporal-LOD and
   renders the same ribbon everywhere. A coarse-scale density/flow-field overview (KDE raster of
   where drifters cluster) vs ribbon detail would be a true temporal-LOD switch they currently lack.

**The meta-gap:** the codebase has *built every operator a representation ladder would need*
(contours, surfels, octree, summary cells, flow matrix, sufficient-stat accumulators) but **never
wired any of them to zoom as an automatic overview→detail handoff on a single dataset.** The
systematization is not new operators — it's a **ladder descriptor + a zoom-driven dispatcher + the
conserved-accumulator consistency contract.**

---

## 5. The build as a declarative dataflow DAG (the Plan IR)

Every idiomatic engine (DataFusion `LogicalPlan→ExecutionPlan`, Polars `LazyFrame`, DuckDB
parser→optimizer→exec) builds a **plan first, executes later**. Adopt the same shape for the tile
build. This is the spine that the §2 playbook, §3 LOD model, and §4 ladder all serialize into.

### 5.1 The Plan IR

A dataset's build is a **`Vec<Stage>`** — an ordered, serde-tagged operator pipeline over an
Arrow-columnar dataflow, logical/physical split:

```
Source ─► Normalize ─► Transform* ─► SpatialIndex ─► TemporalBin ─► Aggregate/Cluster/Analyze* ─► Encode ─► Pack
 (bronze)   (silver: CRS, dateline,                  (the "where")   (the "when")   (the bake — §3)        (gold)
            dedup, schema-validate)
```

- **Logical** says *what* ("cluster stations per zoom band", "roll counts to parent cells").
- **Physical** picks *how* (Supercluster greedy-merge vs grid bin; in-RAM vs streaming).
- Stages are **internally-tagged enum variants** (`#[serde(tag="op")]`): `Filter`, `Reproject`,
  `Quantize`, `Simplify`, `Index`, `Bin`, `Aggregate`, `Cluster`, `Hotspot`, `Bundle`, `Encode`,
  `Pack`. Free serde (de)serialization, exhaustive `match`, diffable specs.

This buys, for free:

- **`stt-build explain <recipe>`** — print the optimized DAG before running (cf. `EXPLAIN`).
- **Optimizer passes** as composable named tree-rewrites (DataFusion's `OptimizerRule`): *fuse*
  reproject+quantize; *push* a bbox/time filter into the scan (predicate pushdown → skip Parquet
  row-groups → directly attacks the 180× over-fetch class); *common-subplan elimination* so the
  shared scan/reproject is computed **once** and forked into detail + summary + raster tiers (today
  each tier re-scans). **This is also the mechanism for the §4 ladder** — each rung is a sub-plan
  forked off the shared silver scan.
- **Validation before I/O** — reject unknown ops/fields eagerly (`deny_unknown_fields`).

### 5.2 Engine choice: native operators, DataFusion-shaped

Build operators as native Rust over Arrow `RecordBatch` (keep the zero-copy-to-GPU story intact).
Borrow DataFusion's **extension contracts** rather than its engine: a `Source` trait
(`TableProvider` analogue) with tri-state pushdown (Exact/Inexact/Unsupported); pull-based streaming
Arrow end-to-end → bounded memory (fixes "buffers all tiles in RAM, fails >10GB"). If we ever want
SQL-defined transforms, embedding DataFusion as the *Transform* executor is the clean path (Decision
D1).

### 5.3 Medallion staging — formalize the intermediates

- **Bronze** — raw ingested rows + provenance (source URL, fetch epoch from *config*, not
  wall-clock).
- **Silver** — cleaned/conformed: CRS-normalized, dateline-clipped, deduped, schema-validated,
  map-matched routes, typed `PropertyColumn`s. **The expensive-but-reusable layer.** OSRM routing,
  particle advection, GBIF lookups materialize here once. *Any representation-ladder rung reads from
  silver.*
- **Gold** — binned, quantized, packed tiles (per rung).

Payoff: any layer is recreatable from raw at any time, and cheap re-binning/re-packing happens
without re-ingesting or re-routing. Re-bucketing nyc-taxi-paths becomes a silver→gold step.

---

## 6. The interface — the rung registry (MVP) and Recipes

Every mature system converges on a **declarative front door + documented path to code** (Planetiler
YAML→Java Profile, Vega-Lite→Vega, dbt YAML→SQL/Jinja, tippecanoe JSON→shell, deck.gl JSON→
`@@function`). But the adversarial review was emphatic: **the full declarative recipe with an
engine that *derives* materialize-vs-filter is over-built for v1, because it depends on the
unbuilt sufficient-stats / OLAP-classification / Plan-IR layer.** Build the registry first; the
recipe is v2.

### 6.1 BUILD FIRST — the shared rung registry (the 80% MVP)

One source of truth (a Rust + TS shared artifact, e.g. `rungs.json` or a generated const) with one
row per representation rung:

```
{ id, suffix, datasetFlag, deckLayer, threeLayer, label, heldBack, license,
  conserve,          # aggregate | lossless_union | collapse+conserve-geom | reshape
  read,              # union | parent-fallback | materialized   (hand-declared in v1, NOT derived)
  scale: {zoom:[min,max]}, handoff }
```

This is pure consolidation of existing behavior and it is the highest-leverage, lowest-risk build
because it:

- kills the **4-place mode drift** (`renderModes` probe, dataset memo, route regex, `buildDemoLayers`
  if/else) **plus** the deck↔three parity copy that "WILL drift";
- subsumes the `HELD_BACK_AV_MODES` / `WAYMO_LOCAL_ONLY` / `STAGE_LOCAL_ONLY` regex gates into
  structured per-rung `heldBack`/`license` fields;
- gives a home for the **dual-copy palette** source-of-truth (emit one artifact consumed by both
  `av_common.py` and `datasets.ts`, instead of `OBJECT_COLORS` ⇄ `AV_OBJECT_COLORS` drifting);
- is the prerequisite that makes the §4 zoom-driven ladder *possible* to wire.

`read:` is **hand-declared** in v1 (`union | parent-fallback | materialized`). Deriving it
automatically from a ranking + OLAP classification is a v2 optimization once sufficient-stats
actually ship.

### 6.2 The recipe (v2 — the 80% case, no Rust)

```yaml
version: 1
name: bixi-flowmap
source: { op: parquet, path: bronze/bixi-2024.parquet, time: started_at, end_time: ended_at }
normalize: { crs: EPSG:4326, dedup_on: [trip_id], dateline_split: true }
pipeline:
  - op: index        scheme: quadbin   level: "@zoom+3"
  - op: bin          width: 1h
  - op: aggregate    by: [origin_cell, dest_cell, bucket]
                     measures: { count: sum, duration: {mean: true, sufficient_stats: true} }
  - op: cluster      scheme: supercluster  radius_px: 80  temporal_radius: 1h  per_zoom: true
  - op: simplify     method: visvalingam   inline_area: true        # one ranking, many zooms
  - op: encode       quantize_coords: 1m   vertex_time_precision: 1s
  - op: pack         zstd: 19   ordering: auto
lod:                                   # the per-axis LOD declaration (§3)
  spatial:   { strategy: additive-octree, rank: home_zoom, screen_error_px: 0.4, read: union }
  temporal:  { strategy: static-dynamic-split, base_bucket_ms: 200,
               static: { collapse: erasor, min_zoom: 17 }, grain: per-sweep }   # declares C1, C2
  attribute: { measures: { density: {agg: sufficient-stats}, class: {coarsen: 32->9} },
               classification: auto }                                            # A1 vs A2 (§3.4)
encoding:                              # ORTHOGONAL — never couples the LOD axes
  coords: { quantize_m: 0.1 }
  attrs:  { auto_u16: true, overrides: { z: 0.001 } }
  layout: { vector_group: [surfel_quat, surfel_rgba] }   # NOT pack_quat — superseded (§1.4)
  determinism: content-addressed       # forces world-grid, per-column-min, stable-sort-emit
contract:
  conserve: true                       # asserts union==N (lossless) or aggregate-not-drop
  categorical_columns: [class, density_band, world_class]   # framework OWNS "never bare-numeric"
```

Discipline this encodes: ordered typed stages (Vega-Lite's shape); a small sandboxed expression
language for the "tiny bit of logic" case (`include_when`, `@zoom`-varying params — CEL/`rhai`);
cascading defaults (project → recipe → stage); versioned + JSON-Schema-validated with
`deny_unknown_fields`. **The framework owns the leaky invariants** (§2.7) rather than each operator
re-documenting them: categorical-not-bare-numeric, the line-archive constraint cluster, the
dual-copy palette, global-per-zoom, the conserve/discard contract as an asserted property. And
**recipe validation includes the bake-off** — `lidar_summarize_eval.py` / `point_column_stats.rs` /
`simulate_layout.rs` become a first-class recipe validator; a strategy is promoted from default-off
to default-on only when the measured win justifies it *and* output stays byte-identical until
flagged.

### 6.3 The escape hatch (the 20% — Rust)

Copy Planetiler's `Profile`: a small trait with a **parallel-safe per-feature** method and a
**per-tile post-process** method — the missing **`Dataset` trait** the generation audit keeps
asking for.

```rust
trait Recipe: Send + Sync {
    fn process_feature(&self, f: &SourceFeature, out: &mut FeatureCollector);   // on N workers
    fn post_process_tile(&self, layer: &str, z: u8, feats: &mut Vec<TileFeature>); // after grouping
    fn finish(&mut self) {}
}
```

`run_all()` becomes a generic loop over recipes. Hot per-feature path on parallel workers;
merge/reorder on the single-threaded per-tile stage (preserves deterministic output order). For
"reference a custom Rust transform from YAML," use deck.gl's named-capability registry
(`{op: compute, fn: "my_binner"}` → `HashMap<String, Box<dyn TransformFn>>`). Prefer the in-process
Rust trait over tippecanoe's shell-out prefilter (avoids the GeoJSON serialize tax per tile).

---

## 7. Determinism, content-addressing & incremental rebuild

This is what turns "a cleaner generator" into "**incremental fleet rebuilds + a shared cache**" —
gated on fixing determinism first.

### 7.1 Determinism (the prerequisite — fix before anything else)

The tile/pack hash must be a **pure function of logical input only**:

1. **Never serialize a `HashMap`/`HashSet`** — Rust re-seeds the hasher per process, so iteration
   order is randomized per run. Use `BTreeMap`, or collect→`sort()` by key before encoding. **This
   is the direct fix for the Arrow-metadata-HashMap non-reproducible-packs bug**: sort schema/field
   metadata by key immediately before writing the IPC schema. *(This bug is upstream of every
   recipe — a declarative `determinism:` block cannot force it away. The framework must be sequenced
   **after** the one-time fleet re-transcode that fixes the two `HashMap::new()` sites; none of the
   convenience above changes that ordering requirement.)*
2. **Sort everything enumerated from the filesystem** — `readdir()` order is unspecified.
3. **Total sort keys** — extend the per-tile feature sort key until total (spatial → time →
   feature-id → original-index).
4. **Zero wall-clock in output** — provenance from a `SOURCE_DATE_EPOCH`-style config value, never
   `SystemTime::now()`.
5. **Order-independent float reduction** — FP addition is non-associative; quantize to integers
   before summing, or reduce in a fixed sequential order. (Matters for every §3.4 measure, and is
   why RNG-using bake-off winners were not shipped.)
6. **Parallelize compute, not output order** — `par_iter().map().collect()` into index-keyed slots,
   emit in sorted-key order.
7. **Regression test** — build a small dataset **twice in separate processes** (so HashMap re-seeds)
   plus once with shuffled input-file order and a different thread count; assert byte-identical
   packs.

### 7.2 Content-addressed constructive trace

Lift the whole DAG to a **constructive trace** (Build Systems à la Carte): a CAS keyed by
`hash(content)`, plus a manifest of `{ stage-key → input-fingerprint, output-hash, dep-edges }`.
The stage key hashes **(input bytes + full config + code/tool version)** — and *config* includes
quantization grid, zstd level, zoom range, cluster radius, snap radius. Constructive traces are the
only strategy giving **both** a shared/cloud cache **and** early cutoff.

### 7.3 Incremental rebuild — Salsa-style, with early cutoff

A build runs to completion against a static snapshot, so the right model is **demand-driven
memoized queries with cross-run persistence** (Salsa / rustc), *not* streaming IVM. Memoized query
DAG over the Plan IR; persist dep-graph + result cache. **Early cutoff** (the biggest win for
"config changed a little"): after recomputing a leaf tile, compare its content hash to the previous
build; if equal, don't invalidate the pack/directory containing it. **Projection firewall**:
partition source spatially/temporally up front so each tile depends only on its slice + the config
*fields* it reads (editing the zstd level invalidates only encode/pack; editing one city's rows
invalidates only that region). **Durability tiers**: mark rarely-changing inputs high-durability.

**The payoff:** the recurring "fleet re-transcode + R2 re-sync" stops being all-or-nothing. Change
one recipe → rebuild that dataset's affected tiles → unchanged content-addressed packs stay put →
R2 re-syncs only the diff. The R2 pack store *is* the CAS, shared by CI and local builds. **This is
also what makes the ~50 GB already-built fleet tractable** — but note: OSRM / login / live-API
datasets *drift and can't be regenerated from source*, so a `reoptimize` transcoder path (operate on
existing packs, not re-ingest) must remain a first-class citizen alongside forward generation.

---

## 8. What exists today (the seams we plug into)

```
raw data ──► stt-generate (per-dataset Rust) ──► GeoParquet intermediate ──► stt-build ──► packed format
             ▲ 40–50% copy-paste drift           ▲ explicit PropertyColumn   ▲ tiler+summary  ▲ manifest + CAS packs
             │ no shared Dataset trait              typing, vertex_value_matrix  +quantize+pack   + paged directory v5
```

**Strong foundations the framework *formalizes*, not replaces:** columnar GeoParquet intermediate
with streaming writers + typed `PropertyColumn`s; `vertex_value_matrix` (already a space-time cube /
OLAP cuboid — the most important existing primitive); build-time levers wired (temporal LOD, summary
tier H3/Quadbin, coord + vertex-time quantization, attribute quantization, Visvalingam + TD-TR
simplify, pre-tessellation, per-feature LOD bands, **additive-octree zoom-LOD**, opt-in
budget/drop, blob-ordering); content-addressed packs + paged directory with `[t_min,t_max]` page
bounds; `SttBuildOptions` (the one launcher bridging every generator to the CLI); and the
**Python AV preprocessing core** (`av_common.py`) where most of the §2–§4 operators currently live
as bespoke functions.

| Pain point | Framework answer |
|---|---|
| Per-dataset generator drift; no `Dataset` trait | **§6 Recipes** + the rung registry |
| 4-place render-mode drift + dual-copy palettes | **§6.1 rung registry** (one source of truth) |
| σ estimator / voxel-real reducer reimplemented 3–4× | **§3.6 one planarity estimator + one voxel reducer** |
| Aggregators bespoke (`BixiAggregator`, `FlowAggregator`) | **§3.7 one generic aggregation/cluster layer** |
| `budget.rs` shipped unused; features bolted on | **§5 Plan IR**: budget is just another stage |
| Non-reproducible packs; fleet re-transcode all-or-nothing | **§7 determinism + CAS + incremental** |
| Average-of-averages risk; count-only summaries | **§3.4 OLAP classification + sufficient statistics** |
| Overview/detail as bespoke pills, not zoom | **§4 representation ladder** |

---

## 9. Mapping to the codebase & phased roadmap

Nothing here is a rewrite. The revised sequencing puts the **registry MVP before the recipe
engine** (the adversarial review's main correction).

### Phase 0 — Determinism (blocking, do first)
Sort Arrow metadata before IPC write (`BTreeMap`/sort-keys); kill HashMap-order leaks in the
pack/dedup path; sort filesystem enumerations; total sort keys in the tiler; integer-or-ordered
float reduction in aggregation. Add the build-twice-in-separate-processes byte-identity regression
test. Sequence the one-time fleet re-transcode that fixes the metadata-order bug. *Unblocks* CAS
dedup, edge-cache correctness, and all of Phase 4.

### Phase 1 — The rung registry + primitive consolidation (the highest-ROI build)
- Ship the **shared rung registry** (§6.1): one Rust+TS artifact, one row per representation rung;
  retire the 4-place drift, the regex gates, the dual-copy palettes.
- Consolidate the **σ planarity estimator** and the **real-representative voxel reducer** (each
  reimplemented 3–4× in `av_common.py` + `lidar_summarize_eval.py`) into one operator apiece.
- Encode the four couplings (C1–C4) as **build validation checks** (`--scene-split` requires
  `static.min_zoom`; `--lod` requires per-sweep grouping), not a general engine.
- Promote `point_column_stats.rs` / `lidar_summarize_eval.py` to a documented "run this first"
  entrypoint.

### Phase 2 — Plan IR + operator extraction (no behavior change)
Define `Stage` enum + `BuildPlan`; reimplement the current `stt-build` flow as a fixed plan. Extract
`BixiAggregator` / `FlowAggregator` into one generic `Aggregate` + `Cluster`. Lift
`--quantize-coords`, simplify, summary tier into named stages; wire `budget.rs` as a `Budget` stage
with the accumulator contract (§3.8). Ship `stt-build explain`.

### Phase 3 — The representation ladder (the visible product win)
- Wire the **AV-LiDAR ladder** (the headline gap §4.5.1): iso z0–13 → octree-surfels z14–16 →
  full surfels z17+ on ONE dataset, dispatched by zoom, with the `time_window_policy` resolving the
  fifth coupling. This is the proof-of-concept that turns the registry rows into auto rungs.
- Generalize the `no-overlap` refinement into the three hand-off modes; make `lossless_union` a
  typed read-side property.

### Phase 4 — The cube upgrades
**Sufficient statistics** `{n, Σx, Σx²}` on the summary tier → mean/variance/trend at read time.
OLAP measure classification on every aggregation. VW **inline effective-area** → every zoom a
filter (the clearest unexploited vector win). KDE raster + Gi\* hotspot tiers as opt-in stages.
Per-cell time-series codec + cumulative prefix-sum.

### Phase 5 — Recipes (kills generator drift)
`Recipe` trait + `run_all()` generic loop. YAML/JSON recipe parser (serde-tagged, versioned,
JSON-Schema, `deny_unknown_fields`) + sandboxed expression language. Port 2–3 datasets (bixi,
earthquakes, drifters) to recipes; keep the Rust escape hatch for OSRM/advection-heavy ones.
**Materialize-vs-filter stays hand-declared** until sufficient-stats ship; then make it derived.

### Phase 6 — Incremental engine
Salsa-style memoized query DAG over the Plan IR; persist dep-graph + result manifest; CAS for leaf
tiles + packs (R2 as shared CAS); early cutoff + projection firewalls; incremental fleet rebuild +
diff-only R2 sync; keep the `reoptimize` path for un-regenerable datasets.

### Phase 7 — Streaming-first
Pull-based Arrow streaming as the default execution path (in-RAM becomes the small-data case);
unbounded-dataset support; `Source`-trait pushdown feeding the paged-directory bounds.

---

## 10. Open decisions

- **D1 — Native operators vs. embed DataFusion** for the `Transform` stage. *Native first*
  (preserves zero-copy-to-GPU control, fewer deps); embed DataFusion later if SQL-defined transforms
  or heavy joins become common. *Reversible.*
- **D2 — Primary DGGS.** *Quadbin* as the default roll-up index (tile-aligned, 1:1 with deck.gl
  requests, perfect nesting, `quadbin.rs` exists); H3 retained for neighbor/flow analytics; S2 only
  if exact equal-area roll-up matters. Avoid A5 for now (~2% area-variant).
- **D3 — Expression language.** `cel-interpreter` (portable, Google CEL, matches Planetiler) vs
  `rhai` (richer, Rust-native). Lean CEL for portability + sandboxing.
- **D4 — How far to take incremental in v1.** Early cutoff at the pack boundary is cheap and
  high-ROI; full projection-firewall partitioning is more work. Ship Phase 6 in two sub-steps.
- **D5 (NEW) — Materialize-vs-filter: hand-declared vs engine-derived.** *Hand-declared in v1*
  (`read: union | parent-fallback | materialized` per rung). Engine derivation (from a per-unit
  ranking + OLAP classification) depends on the unbuilt sufficient-stats layer — defer to Phase 4+.
- **D6 (NEW) — Time-window reconciliation in the ladder.** When an automatic rung (iso) changes the
  global time window, co-resident layers (boxes, tracks) break. Options: per-rung window clamp with
  a floor (the `Math.max(timeWindow, 2000)` generalized); decouple per-layer windows; or forbid
  representation switches that change the window while incompatible layers are resident. *Needs a
  decision before Phase 3 ships the AV ladder.*

---

## 11. The things to take first

1. **Fix determinism** (§7.1) — the prerequisite for CAS dedup, edge-cache, *and* incremental
   rebuilds; it fixes a known live bug; sequence the one-time fleet re-transcode with it.
2. **Ship the rung registry** (§6.1) — pure consolidation, zero new machinery, kills the 4-place
   drift + dual-copy palettes, and is the prerequisite for a zoom-driven ladder. *The single
   highest-leverage, lowest-risk build.*
3. **Consolidate the σ estimator + voxel-real reducer** (§3.6) — one planarity operator and one
   real-representative reducer replace 3–4 copies each; they become the shared "geometry-aware
   budget" every spatial rung parameterizes.
4. **Wire the AV-LiDAR representation ladder** (§4.5.1) — iso → octree-surfels → full-surfels on one
   dataset, the proof that "high-level and zoomed-in are different techniques" can be automatic, not
   a manual pill. (Resolve D6 first.)
5. **Sufficient statistics on the summary tier** (§3.4b) — a few f32 columns buy
   mean/variance/correlation/trend at read time with no rebuild; the best ROI in the cube layer and
   the key to ladder-rung consistency by construction.

**The two conceptual distinctions to get right** (everything else follows): **(1) continuous-LOD vs
representation-switch** (same primitive vs different primitive+algorithm) is one axis; **(2)
surviving-sub-unit vs synthesized-unit** (the materialize-vs-filter predictor) is a *second,
orthogonal* axis. A same-primitive operation can still require materialization (per-zoom clustering).
And **LOD changes the resolution of the answer; encoding changes the price per unit** — keep that
seam clean, but remember encoding levers can still conflict with *each other* (dedup vs locality;
pack-quat vs vector-group).

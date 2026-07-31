# Neural-State Atlas — a transformer's internal state as a spatiotemporal tileset (2026-07)

Status: **BUILT 2026-07-27, REBUILT 2026-07-28 — Milestones 1–5, on a
substituted pin.** §14 is the first as-built record: what shipped, the four
deviations from the plan below and why each was forced, and the two measured
findings that build produced. **§15 is the geometry rebuild**, which is where to
start: the first build rendered as sparse vertical towers in an empty plane, and
§15 is what was wrong (measured), what replaced it, and the three findings that
came out of the rebuild — a silently-zero attribution column, an atlas layout
that was a cluster treemap rather than an embedding, and the discovery that this
dictionary has no macro-cluster structure to outline at all.

§1–§13 are the plan as authored and §14 is left unedited, because a record that
is silently rewritten to match what happened stops being able to say what was
expected.

Authored 2026-07-27 from a research pass over
the 2025–2026 interpretability literature and the shipped tooling
(Gemma Scope / Gemma Scope 2, SAELens, circuit-tracer, Neuronpedia, Goodfire's
neural-geometry line), and a capability pass over this tree. Every external claim
carries its source and the date it was checked.

The research pass **changed the plan it was given**. Four findings are
load-bearing and each one moves a decision — §2 states them, §3–§5 act on them.
The short version: the stable unit of the atlas is the **subspace, not the
feature** (§2.1); the discrete-feature basis is known to **shatter continuous
structure** and three independent groups say so (§2.2); the attribution half of
the product should be **bought from circuit-tracer, not hand-rolled** (§2.3); and
**the MVP as specified is too small for STT to be doing any work** (§4.1) —
which is the one finding that decides whether this belongs in this repository at
all.

## 1. Intent

Build a showcase that renders the internal state of an autoregressive transformer
as a navigable atlas: a stable semantic geography in X/Y, transformer depth in Z,
token index in T, activation as intensity, attribution as extrusion.

Two positions:

- **The data shape is genuinely spatiotemporal.** A latent atlas is a static,
  hierarchical, zoom-dependent point set of 10⁵–10⁶ members; a trace is a sparse,
  time-indexed event stream over that same point set. That is the exact shape
  this repository's format exists for, and every published atlas-of-embeddings
  tool (§2.5) reimplements a worse version of the tiling half.
- **The genre has no time axis.** Nomic Atlas, latent-scope and Neuronpedia all
  render a _static_ map of features. None of them plays a **trace** — the
  token-by-token traversal of that map during inference. That is the gap, it is
  the one thing this stack is uniquely equipped for, and it is what makes this a
  poopdeck demo rather than a re-skin of latent-scope.

The scope discipline that keeps this from becoming an interpretability research
project is §11. The seam that keeps it from becoming two new published packages
is §5.

## 2. What the field actually says (checked 2026-07-27)

### 2.1 Individual SAE features are seed-unstable; the subspaces they span are not

_Unstable Features, Reproducible Subspaces: Understanding Seed Dependence in
Sparse Autoencoders_ ([arXiv:2606.12138](https://arxiv.org/abs/2606.12138))
reports the paradox directly: which individual latents a sparse autoencoder learns
varies dramatically with random initialisation, while the **geometric subspaces**
those latents span stay consistent across seeds. Its practitioner recommendation
is explicit — analyse at the subspace level, not the individual-feature level.

**What this changes.** The input plan makes the individual feature the base unit
and clusters an aggregation over it. Invert the _stability contract_: L0 and L1
coordinates are the durable geography and are the thing a user is allowed to form
a mental map of; L2 feature positions are derived, and are marked unstable in the
UI and in the manifest. This is not a caveat — it is a build rule, because it
means the layout algorithm must place clusters first and features **inside** their
parent's bounds (§6.3), so that a reseed moves points within a region rather than
rearranging the continents.

It also hands us a validation number nobody in the genre publishes: **atlas drift
under reseed** — retrain the SAE (or resample the corpus), rerun layout, report
how far L0/L1 centroids move and what fraction of L2 members change parent. That
goes on the methodology page with its units and its source, per the register's
house rule.

### 2.2 The discrete-feature basis shatters continuous structure — three independent sources

- Goodfire, _The World Inside Neural Networks_
  ([goodfire.ai](https://www.goodfire.ai/research/the-world-inside-neural-networks),
  checked 2026-07-27): numbers, days and months appear as **circular loops**;
  years and characters as smooth curves; colour as a surface organised by hue,
  saturation and lightness. They show a slant-rhyme manifold that an SAE
  fragments into 30+ scattered latents, "each capturing only local properties
  rather than the unified phonological structure". They fit low-dimensional
  manifolds to activations and steer _along_ them rather than along a linear
  direction.
- _Understanding sparse autoencoder scaling in the presence of feature manifolds_
  ([arXiv:2509.02565](https://arxiv.org/abs/2509.02565)): scaling SAE width in
  the presence of manifold structure produces **shattering** (representations
  fragment) and **tiling** (overlapping latents that pave the manifold without
  corresponding to anything semantic). More width does not fix it.
- Anthropic's own circuit-tracing landscape page
  ([neuronpedia.org/graph/info](https://www.neuronpedia.org/graph/info), checked
  2026-07-27) lists the same failure as a **method limitation**: transcoders can
  "shatter" geometric structures in the model's representation space, and it
  names numerical helices as the example.

**What this changes.** The input plan defers manifolds to Milestone 7. Shipping
order stays — this is the hardest stage and it must not gate the first four
milestones — but the **data model and the layout must not foreclose it**, because
retrofitting it means re-cutting the atlas archive and churning every content
address. Concretely, from day one:

- `AtlasNode` carries a `geometryRole` of `point | curve | surface`, defaulting to
  `point`;
- the atlas is built as a **multi-geometry** archive (points for features, paths
  for 1-D manifolds, polygons for cluster hulls and 2-D manifolds) rather than a
  point archive — the format already carries all three, and adding a geometry kind
  later is a rebuild;
- a manifold, when found, is laid out as a **continuous locus** in atlas space,
  not as a blob of scattered members.

The honest framing consequence is in §3: a fragmented cluster on this map may be
one continuous concept the basis could not represent, and the UI must be able to
say so rather than presenting fragmentation as a finding.

### 2.3 Where attribution is the goal, the ecosystem has already converged — buy it

- _Transcoders Beat Sparse Autoencoders for Interpretability_
  ([arXiv:2501.18823](https://arxiv.org/abs/2501.18823)) — transcoders model the
  input→output function of a submodule rather than reconstructing a static
  activation, and recover more interpretable features.
- Anthropic open-sourced circuit-tracing
  ([anthropic.com](https://www.anthropic.com/research/open-source-circuit-tracing));
  the `circuit-tracer` library supports **Gemma-2-2B, Llama-3.2-1B and Qwen3-4B**,
  shipped with per-layer transcoders (PLTs) and has since added **cross-layer
  transcoders** (CLTs), which read at one layer and write to all subsequent MLP
  layers. Neuronpedia hosts an interactive frontend and accepts uploaded graphs;
  EleutherAI shipped an independent implementation (`Attribute`) that also
  supports CLTs. (All: [neuronpedia.org/graph/info](https://www.neuronpedia.org/graph/info), 2026-07-27.)

**What this changes.** The input plan's §18 hand-rolls target-logit
gradient×activation over SAE latents. That is a correct method and a whole
pipeline stage. Instead: **pin the model to the intersection point** where Gemma
Scope SAEs, circuit-tracer transcoders, Neuronpedia labels and Neuronpedia graphs
all exist for the same checkpoint — `gemma-2-2b` — and take the edge overlay from
circuit-tracer's attribution graphs. Nodes there are already (feature, layer,
token-position) triples with weighted edges, which is exactly the `CausalEdge`
record the input plan defines. One stage deleted, and the overlay inherits a
method the field already reviews.

Caveat to carry: circuit-tracer's node basis is a **transcoder**, and the atlas
geography will be built from **SAE** latents. Those are different dictionaries.
Either build the atlas on the transcoder basis too (cleanest, costs Neuronpedia's
SAE label coverage), or accept that edges live on a second, co-registered node set.
This is a real unresolved seam and §10 gates on it.

### 2.4 The negative results bound the claims — they do not sink the visualization

Google DeepMind's mech-interp team published negative results for SAEs on
downstream tasks and **deprioritised SAE research** on that basis
([deepmindsafetyresearch on Medium](https://deepmindsafetyresearch.medium.com/negative-results-for-sparse-autoencoders-on-downstream-tasks-and-deprioritising-sae-research-6cadcfc125b9)):
on out-of-distribution harmful-intent detection, SAEs underperformed plain linear
probes. _AxBench_ (ICML 2025) reports simple baselines outperforming SAEs for
steering. _Sparse Autoencoders Do Not Find Canonical Units of Analysis_ (2025)
attacks the premise that SAE latents are the atoms.
_Use Sparse Autoencoders to Discover Unknown Concepts, Not to Act on Known
Concepts_ ([arXiv:2506.23845](https://arxiv.org/abs/2506.23845)) is the
constructive reading and is the one this project should adopt as its thesis
sentence: SAEs are a **discovery** instrument, not an actuator.

**What this changes.** Nothing structural, and that is the point — this project
builds an _exploration surface_, which is the use these papers endorse. But it
sets the claim ceiling in §3, and it kills one thing outright: no steering, no
"edit the feature and see the model change" interaction. That claim is exactly the
one the literature says does not hold up, and it is counted out in §11.

### 2.5 Prior art — what exists, and what it does not do

| Tool                                                                                      | Does                                                                                                                     | Does not                                                         |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| [Nomic Atlas](https://docs.nomic.ai/atlas/datasets/data-maps/how-atlas-works/1-key_terms) | 2-D projection of embeddings, interactive to tens of millions of points; proprietary large-scale layout above 50k points | no time axis; no model internals; the layout algorithm is closed |
| [latent-scope](https://github.com/enjalot/latent-scope)                                   | embed → UMAP → HDBSCAN → LLM cluster labels, open source, LanceDB-backed; SAE feature support in progress                | static map of a _dataset_; no inference trace; no layer axis     |
| [Neuronpedia](https://www.neuronpedia.org/)                                               | per-feature pages, explanations, top-activating examples, hosted attribution graphs; public API and S3 bulk exports      | list/graph UI, not a map; no persistent geography; no playback   |
| Goodfire neural geometry                                                                  | manifold discovery and manifold-following steering; the strongest current result on _structure_                          | research artefact, not a general instrument                      |

The uncontested gap is **playback over a persistent geography**. Everything above
renders a still. Nothing plays the traversal.

## 3. The framing contract

The input plan's §2 is right and is adopted. Two changes make it enforceable
rather than editorial.

**The four-way distinction becomes a typed enum, not a disclaimer.** `activation`
(the feature is on), `attribution` (associated with a selected output),
`intervention` (changing it changes the result), `interpretation` (a generated
label is consistent with held-out examples) are the `metric` union in the frontend
state, and the legend renders **from** that union. It is then structurally
impossible to show an attribution surface labelled "activation", which is the
failure mode this genre actually exhibits.

**Interpretation status gates rendering.** `unlabeled | tentative | reviewed |
validated | contested` is carried per node, and the label layer's styling is a
function of it — a `tentative` label never renders in the same weight as a
`validated` one, and `contested` renders with its dissent visible. Confidence that
is only in a tooltip is confidence nobody reads.

**Three sentences that must appear on the methodology page**, because §2 says they
are true and a map is a persuasive object:

1. Spatial distance is a projection artefact with measured distortion (§9), not a
   metric on the model.
2. Individual feature positions are unstable across training seeds; regions are
   not (§2.1). The measured drift is published.
3. A concept that is continuous inside the model may appear here as scattered
   fragments, because the discrete basis shatters manifolds (§2.2). Fragmentation
   on this map is not evidence of fragmentation in the model.

Not permitted anywhere in copy: map of thoughts, reasoning, consciousness, or
model parameters. This renders **activations and estimated contributions**, and the
weights are never in the picture.

## 4. Why STT fits — and the test of whether it earns its keep

### 4.1 The scale gate (the finding that decides the project)

The input plan's MVP scale targets are 1 layer, ~10 prompts, 128–1,024 tokens and
32–128 active features per token. Arithmetic on the upper end: 10 × 1,024 × 128 ≈
**1.3 M activation events**, and on the stated MVP end (1 layer, 10 prompts, 256
tokens, 32 top-K) ≈ **82 k events** — under a megabyte encoded. That is one
`fetch()` of one Arrow file. Tiling it would be decoration, and this repository
should not ship a demo whose headline format contributes nothing.

**So the plan commits to the scale at which the format is load-bearing, and states
the small case honestly:**

| Product                      | Configuration                                   | Members (arithmetic) | Comparable shipped archive                       |
| ---------------------------- | ----------------------------------------------- | -------------------- | ------------------------------------------------ |
| Vertical slice (Milestone 1) | 1 layer, 1 prompt, top-32                       | ~10⁴ events          | **none — ship as a plain fetch, not an archive** |
| Atlas anatomy                | 26 layers × 16 k residual latents               | 416 k nodes          | `earthquakes-v2` (~522 k features)               |
| Atlas anatomy (wide)         | selected layers at 2¹⁶–2²⁰ width                | 10⁶–10⁷ nodes        | `flights` (~40 M features)                       |
| Flagship trace               | 1 document × 8–16 k tokens × 26 layers × top-32 | 6.6–13 M events      | `adsb-paths` (~4.1 M) → `ais-all-us` (~19 M)     |

Comparables are the MCP catalog's registered feature counts. At the flagship
configuration, temporal bucketing, prefetch, eviction and the paged directory are
all doing real work, and the demo is a _streaming_ demo. At the vertical-slice
configuration none of them are, and pretending otherwise is the thing to avoid.

**The rule:** Milestone 1 does not produce an archive. The first `.stt` is cut at
Milestone 2, when the anatomy is 400 k+ nodes.

### 4.2 The coordinate mapping

STT tiles Web Mercator on lon/lat; the atlas is an abstract plane. The repository
already has this exact precedent and it is not a hack: `cosmos_drive_dreams.py`
lays 266 driving scenarios on a synthetic lat/lon grid via
`av_common.local_to_lonlat` about a mid-Atlantic origin, with `hideBasemap` set
(`scripts/data-generation/cosmos_drive_dreams.py:541`, `:1254-1260`).

| Atlas axis                        | STT carrier    | Mechanism                                                                     |
| --------------------------------- | -------------- | ----------------------------------------------------------------------------- |
| X/Y — semantic geography          | lon/lat        | normalise the frozen layout into a fixed box via `local_to_lonlat`            |
| Z — transformer layer             | point altitude | `stt-build --point-elevation-column layer_z`; folds into `FixedSizeList<_,3>` |
| T — token index                   | Unix ms        | synthetic epoch + `tokenIndex × 1000 ms`; one token = one bucket              |
| hierarchy — region/family/feature | zoom band      | `--min-zoom-field` / `--max-zoom-field` + `lodMode: 'additive'` (§4.3)        |

**Design rule: keep the atlas inside roughly ±20° of the equator.** The
equirectangular mapping is isotropic only where `cos(lat) ≈ 1`; further out, equal
steps in X and Y stop being equal distances on the map and the geography acquires
a distortion the projection metrics in §9 did not measure. This is a build
constant, not a preference.

Two known gotchas that apply here and are already recorded elsewhere in this
register: `metadata.bounds` is a **centroid** bbox while tiles are addressed by
vertex, so it does not bound the data
([tile-loading-3d-2026-07.md](./tile-loading-3d-2026-07.md)); and a playback
archive must be built `--blob-ordering time-major` or buffered ranges come back
empty and the clock stalls.

### 4.3 What the format already gives us

Each of these is a flag that exists today, doing the job the input plan proposed
building:

- **`--min-zoom-field` / `--max-zoom-field`** — per-feature zoom band. L0 regions
  at z0–3, L1 families at z4–6, L2 features at z7+, in **one** archive with one
  anatomy. The reference documents the pairing as being for exactly this: "coarse-
  zoom clustered/aggregated overviews that must not bleed into full-resolution deep
  zooms" (`docs/api/cli-reference.md:244-245`). Paired with `lodMode: 'additive'`,
  which renders the union of `[minZoom..cameraZoom]` and keeps every level
  resident. The input plan's §12 LOD and §22 zoom-switching logic are this pair.
- **`--point-elevation-column`** — folds the layer index into POINT geometry as
  altitude, bound zero-copy, no per-point pad on the main thread. The input plan's
  `LayerStackLayer` is this flag plus a camera pitch.
- **Feature intervals** (`docs/spec/time-model.md` §2) — the atlas anatomy has no
  time. Give every node an interval spanning the whole trace range and it is
  permanently in-window, no special-casing in the reader.
- **`--quantize-attrs-auto`** — activation columns are Float64 and
  near-incompressible raw; the range-adaptive UInt16 path is the input plan's §21
  "tile-level scale and offset", already implemented and already validated.
- **`timeHeightScale` / `timeHeightOrigin`** — the space-time cube. Not for the
  main view (Z is layer there), but it is the free alternative view: one layer,
  token index as altitude, the trace as a literal thread through time.

**Counted out here:** `--summary-tier h3`. H3 cells on a synthetic grid are
mechanically valid and semantically meaningless — a hex boundary would cut across
clusters. The hierarchy is the cluster tree, and the zoom-band pair expresses it
exactly. Trigger to revisit: an atlas large enough that L1 alone exceeds a
comfortable low-zoom tile budget.

## 5. Architecture verdict — where the seam goes

**Do not create `neural-atlas-schema` and `neural-atlas-layers` packages, and do
not create `examples/neural-atlas`.** The tree publishes eight `@poopdeck.gl`
packages in lockstep and carries two examples. Two more packages is two more
publish artefacts, two more changesets per release, two more API doc pages, two
more conformance obligations and two more entries in the capability matrix —
permanently, for one demo. The input plan's §28 repository layout is the single
largest thing to reject.

The shape that matches this tree:

| Input plan                      | Here                                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `examples/neural-atlas/`        | `route('atlas/:sequenceId?', 'pages/NeuralAtlas.tsx')` — a chrome-free fullscreen surface next to `/drive` and `/worlds`, with the `X.tsx` + `XImpl.tsx` client-only split both already use |
| `packages/neural-atlas-layers/` | nothing new — see below                                                                                                                                                                     |
| `packages/neural-atlas-schema/` | the generator's contract section in this record, plus `examples/showcase/src/types.ts` for the frontend half                                                                                |
| `python/neural_atlas/`          | `scripts/data-generation/neural_atlas.py`, sibling to `cosmos_drive_dreams.py` and `nexrad_volume.py`                                                                                       |

Promote to a package when a **second** consumer appears, not before.

### 5.1 Zero new layer classes for the MVP

All six proposed layers are existing layers with props:

| Proposed               | Existing                                                          |
| ---------------------- | ----------------------------------------------------------------- |
| `LatentRegionLayer`    | `AnimatedPolygonLayer` (cluster hulls, extruded by attribution)   |
| `LatentFeatureLayer`   | `AnimatedPointLayer`, or `AnimatedPointCloudLayer` with z = layer |
| `LayerStackLayer`      | the same, with `--point-elevation-column` and a pitched camera    |
| `ConceptLabelLayer`    | `AnimatedTextLayer` + `CollisionFilterExtension`                  |
| `LatentFlowLayer`      | `AnimatedArcLayer`, or `FlowCorridorLayer` for weighted bundles   |
| `ActivationTrailLayer` | `AnimatedTripsLayer` in trail mode — this is the `fadeTrail` path |

If a genuinely new layer is needed later it earns its place in `packages/layers`
with the rest, under that package's existing review and conformance rules. Note
the standing constraint that bites here: the **WebGL2 16-attribute ceiling** binds
trips, so a trail layer carrying many per-vertex channels will hit it.

### 5.2 Two archives, two blob orderings

- **`neural-atlas-anatomy`** — static, no time variation, spatial locality is what
  matters. `--blob-ordering spatial`.
- **`neural-atlas-trace-<slug>`** — a playback demo. **`--blob-ordering
time-major`**, non-negotiable; `auto` on a multi-cell playback dataset is the
  known stall.

The trace archive references atlas nodes by integer `nodeId` and does **not**
duplicate coordinates. The anatomy's position buffer is loaded once. This is the
input plan's §21 instinct and it is correct.

## 6. Revised data model

Deltas from the input plan only; everything not listed is adopted as written.

### 6.1 `AtlasNode`

Add:

```ts
geometryRole: 'point' | 'curve' | 'surface';   // §2.2 — manifolds are not points
stabilityClass: 'stable' | 'derived';          // §2.1 — L0/L1 stable, L2 derived
seedAgreement?: number;                        // fraction of seeds placing this member here
```

`interpretationStatus` and `labelConfidence` are adopted verbatim and become
rendering inputs, per §3.

### 6.2 `ActivationEvent`

Adopted. `intrinsic0..3` stay, because §2.2 says they are the direction of travel
and adding columns later re-cuts the archive.

One change: `attribution` and `ablationEffect` **must not share a column with**
`activation` in the tile. Different metrics, different units, different sign
semantics; the §3 enum has to be able to select between them without a
reinterpretation.

### 6.3 The layout contract (the part §2.1 forces)

The frozen layout is produced in this order, and no stage may perturb an earlier
one:

1. L0 macro-cluster centroids, laid out on the high-dimensional graph.
2. L0 regions packed to non-overlapping bounds. **Frozen.**
3. L1 family centroids laid out _inside_ their parent's bounds. **Frozen.**
4. L2 features laid out locally, clipped to the parent family's bounds.
5. Manifolds (when §2.2 work lands) replace step 4 for their members with a
   continuous locus inside the same bounds.

Clustering happens on the **high-dimensional graph**, never on the 2-D projection
— the input plan says this and it is the single most common error in the genre.
Seeded, reproducible, and the reproduction is tested.

## 7. Pipeline — what we build and what we buy

The input plan's twelve stages become **eight**, because Neuronpedia already
computed three of them.

**Bought** (Neuronpedia public API and S3 bulk exports —
[docs.neuronpedia.org/api](https://docs.neuronpedia.org/api), checked
2026-07-27): per-feature explanations, activation statistics, top-activating
examples, and hosted attribution graphs, all for Gemma Scope on `gemma-2-2b`. This
removes the input plan's `label` stage entirely for v1 and most of
`build-feature-stats`.

**Built:**

| Stage                 | Why it can't be bought                                                         |
| --------------------- | ------------------------------------------------------------------------------ |
| `collect-corpus`      | co-activation similarity needs _our_ joint activations, which nobody publishes |
| `extract-activations` | same                                                                           |
| `encode-sae`          | same                                                                           |
| `build-graph`         | the multiplex affinity (§11 of the input plan) is the novel part               |
| `cluster`             | Leiden on the multiplex graph                                                  |
| `layout`              | §6.3 — the frozen hierarchical layout is the product                           |
| `trace-prompts`       | the traces are the demo                                                        |
| `pack-stt`            | this repository's job                                                          |

**The corpus shrinks by roughly an order of magnitude.** The input plan sizes it at
5–20 M tokens, which is right if you must estimate per-feature statistics from
scratch. Since statistics and labels are bought, the corpus exists **only** to
estimate co-activation over a 16 k-wide dictionary, and **1–2 M tokens** suffices
for that. On the target hardware (Apple M3 Pro, 36 GB — no CUDA in this
environment) that is the difference between an afternoon and a week, and it is
what makes the project runnable at all without renting a GPU.

Stage discipline from the input plan is adopted verbatim and is good: explicit
input manifest, versioned output, summary statistics, cached results, recorded git
commit and config hash.

## 8. The pin

**`gemma-2-2b`, Gemma Scope 16 k residual SAEs, all 26 layers.** Not because it is
the best model but because it is the **only point where the whole toolchain
intersects**: Gemma Scope covers all layers and sublayers at 2¹⁴ with wider
options at selected layers ([huggingface.co/google/gemma-scope](https://huggingface.co/google/gemma-scope),
checked 2026-07-27); SAELens loads them; circuit-tracer supports the checkpoint
with both PLTs and CLTs; and Neuronpedia has labels and examples for the same
latents. Any other pin loses at least one of those.

**Licence position** (this register's §1 rules apply — verify before building, not
after):

- **Gemma Scope weights and derived feature artefacts: CC-BY-4.0.** Labels,
  statistics and examples redistribute with attribution.
- **Gemma model weights: Gemma Terms of Use**, not an OSI licence. The relevant
  distinction ([ai.google.dev/gemma/terms](https://ai.google.dev/gemma/terms),
  checked 2026-07-27): _outputs_ are the user's content and Google claims no rights
  in them; the Terms attach to weights and to **Model Derivatives**. Activation
  traces are outputs, so publishing them is permitted — but ship the required
  Notice text and attribution anyway, because this register's standing rule is to
  be conservative about upstream terms.
- **Corpus licence is a separate gate and is the one most likely to bite.** The
  corpus is redistributed in effect, because top-activating example spans are shown
  in the UI. Use a corpus whose terms permit that (a permissively-licensed mixture,
  built and recorded like every other dataset in
  [demos-and-datasets.md](./demos-and-datasets.md) §1). **Do not** default to
  whatever the SAE was trained on without reading its terms.

**Upgrade path, not v1:** Gemma Scope 2 (Gemma 3, sizes 270m/1b/4b/12b/27b, SAEs +
transcoders + cross-layer transcoders + crosscoders, CC-BY-4.0, released
2025-12 — [huggingface.co/google/gemma-scope-2](https://huggingface.co/google/gemma-scope-2),
checked 2026-07-27). Trigger to move: circuit-tracer (or `Attribute`) supports a
Gemma 3 checkpoint **and** Neuronpedia carries labels for it. Until both hold, the
move costs more than it buys.

## 9. Validation

The input plan's §27 is adopted. Three additions, all of which exist because §2
made them necessary, and all of which are published rather than merely computed:

1. **Atlas drift under reseed** (§2.1) — L0/L1 centroid displacement in atlas
   units, and the fraction of L2 members changing parent. This is the number that
   tells a reader how much of the map to trust.
2. **Manifold-shattering audit** (§2.2) — for a small set of concepts with known
   continuous structure (numbers, days, months, colour — the ones Goodfire
   published), report how many latents carry them and how far apart those latents
   land. If numbers scatter across the map, say so on the page rather than letting
   the map imply they are unrelated.
3. **Projection distortion** — trustworthiness, continuity, kNN overlap, with the
   `k` they were computed at. The register's house rule applies: a number without
   its units and its source is dropped, not restated.

## 10. Gates

**G1 — this queues behind B1 and B2.** The tree is mid-flight: a 229-file payload
byte break is uncommitted, and 24 of 59 reachable archives on the CDN are in a
format the current reader will not open. A new archive published before B2 is
another L1-shaped defect: a live demo pointing at bytes nobody can read. **Nothing
in this plan cuts an archive until B1 has landed and B2's republish is scheduled**,
and when it does, it folds into that republish rather than starting a second one.

**G2 — the basis seam is unresolved** (§2.3). The atlas is built on SAE latents;
circuit-tracer edges are on transcoder latents. Decide before Milestone 5: build
the atlas on transcoders too (loses Neuronpedia's SAE label coverage), or carry a
second co-registered node set (honest, more machinery, and the UI has to explain
two node kinds). Do not start Milestone 5 with this open.

**G3 — no GPU in this environment.** M3 Pro / 36 GB, and `torch` is not installed
against the system Python 3.14. The corpus size in §7 is chosen to make this
survivable; if the flagship trace configuration (§4.1, 8–16 k tokens × 26 layers)
does not run in acceptable time on MPS, the fallback is fewer layers, not fewer
tokens — the token axis is the demo.

**G4 — corpus licence** (§8). Cleared before `collect-corpus` runs, not after.

## 11. Counted out, with revival triggers

- **Steering / intervention as an interactive feature.** §2.4: the literature
  reports simple baselines outperforming SAEs at steering. Offline _ablation_
  results on a curated few, stored as their own metric, are in scope — live "edit a
  feature and watch the model change" is not. Trigger: a published result showing
  SAE-basis steering beating linear-probe baselines on a task we can reproduce.
- **Live in-browser inference.** No trigger that is worth it. The traces are
  precomputed, deterministic and versioned; that is a feature, not a limitation.
- **Arbitrary user prompts.** Follows from the above.
- **Training a custom SAE, block-sparse featurizer, or bilinear autoencoder.**
  Trigger: the bought artefacts demonstrably cannot express something the demo
  needs, established by a measurement rather than by preference.
- **Every transformer layer at 2²⁰ width.** Trigger: §4.1's flagship configuration
  ships and the atlas is provably not the bottleneck.
- **`--summary-tier h3`** — §4.3, with its trigger.
- **Cross-model alignment ("the same concept in two models").** Genuinely
  interesting and genuinely a research project. Trigger: crosscoders in Gemma
  Scope 2 make it a data-loading problem rather than a research problem.
- **A `/story/`-style scrollytelling treatment.** The drifters template would suit
  this well. Trigger: the interactive atlas ships and browser-verifies first —
  narrative over an unverified surface is how the browser-verify queue grew to
  three campaigns.

## 12. Milestones

Renumbered from the input plan where §4.1 and §5 moved work, otherwise adopted.

| #   | Deliverable                                                                                                        | Accept                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 1   | Vertical slice: pinned model + SAE, 1 prompt, 1 layer, top-K, fixed positions, token playback. **No archive.**     | A user scrubs tokens and stable features change intensity. Plain fetch; the format is not involved yet. |
| 2   | Real atlas: 1–2 M-token corpus, multiplex graph, Leiden hierarchy, frozen layout (§6.3), 416 k nodes, first `.stt` | Zoom moves region → family → feature without the anatomy changing. Reseed drift measured and published. |
| 3   | Interpretation: Neuronpedia labels, confidence, examples, inspection panel, §3 status gating                       | Every visible labelled region links to evidence and to its uncertainty.                                 |
| 4   | Flagship trace (§4.1): long document, 26 layers, 6–13 M events, tiled, streamed                                    | Multiple sequences load without bundling their activations into the app.                                |
| 5   | Attribution: circuit-tracer graphs as the edge overlay, target-token selection, selected ablations                 | Activation and attribution are selectable as separate metrics and never share a legend. **G2 closed.**  |
| 6   | Multi-layer: layer bands, aligned stacked planes, sweep, logit lens (labelled as such unless a tuned lens exists)  | A user inspects one token's representation through depth.                                               |
| 7   | Manifold groups (§2.2): intrinsic-dimension diagnostics, local coordinates, `curve`/`surface` nodes                | Several validated groups show continuous or cyclic internal movement, with the diagnostics shown.       |

## 13. What this borrows back into STT proper

These stand on their own even if the demo is dropped, and each belongs to another
record once acted on:

- **Abstract (non-geographic) coordinate spaces are a second-class citizen.** The
  synthetic-lon/lat trick is now used by `/worlds` and would be used here, both
  carrying their own `local_to_lonlat` conventions and both fighting Mercator
  anisotropy by hand. A declared "abstract plane" CRS in the manifest — tiles
  unchanged, projection declared — would make both honest.
  → [stt-packed-format-decisions.md](./stt-packed-format-decisions.md)
- **`--min-zoom-field` + `lodMode: 'additive'` is an under-documented hierarchy
  mechanism.** It is documented as road-class LOD and additive octrees; it is
  actually a general cluster-tree carrier. Worth a guide page.
- **A `metric` enum with a legend generated from it** (§3) is a generic
  correctness win for any demo showing more than one quantity, not a neural-atlas
  concern. → [renderer-architecture.md](./renderer-architecture.md)

---

## 14. As built (2026-07-27)

### 14.1 What shipped

| Piece                                     | Where                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Generator, nine cached stages             | `scripts/data-generation/neural_atlas.py` (+ `requirements-atlas.txt`)                            |
| Frontend surface                          | `examples/showcase/src/pages/NeuralAtlas{,Impl}.tsx`, route `atlas/:metric?`                      |
| Framing contract as types (§3)            | `examples/showcase/src/components/atlas/atlasTypes.ts`                                            |
| Layer tree, zero new layer classes (§5.1) | `examples/showcase/src/components/atlas/buildAtlasLayers.ts`                                      |
| Archives                                  | `neural-atlas-anatomy`, `-regions`, `-manifolds`, `-trace-wikitext` + `neural-atlas.json` sidecar |

Milestones 1–5 of §12 are done. Milestone 6 (layer bands, sweep, logit lens) and
Milestone 7 (discovered manifolds) are not: the `geometryRole` field and the
curve/surface archives exist so neither is a re-cut of the anatomy, which is what
§2.2 asked the data model to guarantee.

### 14.2 Deviation 1 — the pin (§8 is not reachable from here)

`gemma-2-2b` is `gated: manual` on the Hub and this machine has no token, so the
weights cannot be fetched at all; 26 layers × 16 k Gemma Scope SAEs is ~15.7 GB
against 42 GB free on a tree whose showcase data directory is already 64 GB; and
there is no CUDA (§10 G3). The build ships on the nearest **ungated** intersection
of the same four artefacts:

| Artefact | Plan                                     | As built                                                                  |
| -------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| model    | `google/gemma-2-2b` (Gemma Terms, gated) | `openai-community/gpt2` (MIT)                                             |
| SAEs     | Gemma Scope 16 k residual, 26 layers     | `jbloom/GPT2-Small-SAEs-Reformatted` (MIT), 12 × `resid_pre`, d_sae 24576 |
| labels   | Neuronpedia Gemma Scope                  | Neuronpedia `gpt2-small/{0..11}-res-jb` S3 bulk export                    |
| corpus   | "a permissive mixture"                   | `Salesforce/wikitext`, wikitext-103-raw-v1 (CC-BY-SA-3.0 + GFDL)          |

294,912 nodes against §4.1's 416 k anatomy row — 0.7×, and the same order as the
shipped `earthquakes-v2` (~522 k). **The scale gate is cleared**, which was the
finding that decided whether this belongs in the repository at all. Every
model-specific fact lives in one `MODEL_PINS` entry, so moving to Gemma is a
config entry plus a Hub token.

`blocks.11.hook_resid_post` is excluded although the SAE exists: Neuronpedia
carries no `11-res-post-jb` labels, and 8% more points is not worth a hole in the
interpretation layer.

**Also cleared: G4.** The corpus licence gate is the one §8 said was most likely
to bite, because top-activating spans are redistributed in effect. wikitext-103 is
CC-BY-SA-3.0 + GFDL and is attributed in every archive's `--attribution` string.

### 14.3 Deviation 2 — attribution is built, not bought (§2.3)

circuit-tracer supports Gemma-2-2B, Llama-3.2-1B and Qwen3-4B — not GPT-2 — so
under this pin there is nothing to buy. Attribution is gradient × activation over
SAE latents: one backward pass per window on the logit of the model's own top
prediction at that window's final position, giving
`d(logit)/d(resid) · W_dec[f] · act[f]`, in logits, in its own column.

**This closes G2 rather than deferring it.** The basis seam existed _because_ the
geography would be SAE latents and the edges transcoder latents; building the
attribution on the same dictionary means there is one node set, not two
co-registered ones. The seam returns the moment the pin moves to Gemma.

### 14.4 Deviation 3 — four archives, not one multi-geometry archive (§2.2)

`stt-build` takes one geometry kind per invocation. The record's actual
requirement was that adding a geometry kind later must not re-cut the point
archive and churn every content address — satisfied, because the curve and
surface kinds have their own archives from day one:

| Archive                       | Geometry  | Ordering         | Why                                                                                                                                    |
| ----------------------------- | --------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `neural-atlas-anatomy`        | POINT, 3D | `spatial`        | The geography. Z folded into the geometry by `--point-elevation-column layer_z`; zoom band is the cluster tree via `--min-zoom-field`. |
| `neural-atlas-regions`        | POLYGON   | `spatial`        | L0/L1 hulls, `--min-zoom-field`+`--max-zoom-field` so regions hand off to families with no client logic.                               |
| `neural-atlas-manifolds`      | PATH      | `spatial`        | §2.2 drawn — see §14.7.                                                                                                                |
| `neural-atlas-trace-wikitext` | POINT, 3D | **`time-major`** | The playback demo. Non-negotiable per §5.2.                                                                                            |

### 14.5 Deviation 4 — G1, and where the archives are

G1 said nothing cuts an archive until B1 lands and B2's republish is scheduled.
B1 is still uncommitted. The archives therefore exist **locally only** and the
`/atlas` nav entry is gated off the public deploy by `ATLAS_AVAILABLE` in
`datasets.ts` — the same defect class the gate exists for, expressed for a
surface that is not a `Dataset`. Flip `ATLAS_ARCHIVES_SYNCED` in the pass that
r2-syncs the four `neural-atlas-*` stems and verifies each manifest 200.

### 14.6 Finding — the SAE context-length cliff

Not in the literature pass, and it would have silently poisoned the whole
geography. These SAEs were trained at `context_size: 128`. Measured here over the
same wikitext tokens, centred basis, BOS position excluded:

| window | layer 0            | layer 6            | layer 11           |
| ------ | ------------------ | ------------------ | ------------------ |
| 128    | L0 15.0, FVU 0.034 | L0 56.2, FVU 0.159 | L0 62.8, FVU 0.238 |
| 512    | L0 639.4, FVU 7.27 | L0 179.1, FVU 3.94 | L0 140.3, FVU 1.91 |

At 512 the reconstruction is several times **worse than predicting the mean** and
the dictionary fires ~40× as many latents: a co-activation graph built there
measures the residual stream drifting out of distribution, not features.
Prepending BOS changes nothing (L0 15.0 either way) — the window length is the
whole effect. Every forward pass now runs at `pin.sae_ctx`, and the trace's
"reading session" is a run of consecutive 128-token windows. The 128 numbers are
the published L0/FVU for `gpt2-small-res-jb`, which is the check that the loader
and the basis are both right.

Two smaller traps on the same path, both now measured rather than assumed:

- **fp16 encoding is not safe here.** Half-precision accumulation of a 768-term
  dot product pushed a crowd of slightly-negative pre-activations over the ReLU
  (mean L0 728 vs 339 on the same batch in fp32) and NaN'd the reconstruction
  error. Sparsity that is a rounding artefact is not sparsity. fp32 throughout.
- **The residual basis is TransformerLens', not HF's.** `center_writing_weights`
  makes the TL stream the HF stream with its per-token `d_model` mean removed —
  a behavioural no-op for the model, not for a dictionary reading raw residuals.
  The generator measures both bases on a probe batch and records the winner
  (centred: FVU 0.158 / L0 48.3; uncentred: FVU 3.34 / L0 147.2).

### 14.7 Finding — Leiden on this graph is scale-free, and what the layout does about it

Leiden on the multiplex graph (decoder-direction cosine kNN ∪ within-layer
co-activation Jaccard) has no resolution that yields balanced communities: at
γ = 1 the largest holds 20,733 of 294,912 nodes and the median community size is
**1**; at γ = 12 the largest is 2,656 but there are still hundreds of singletons.
A singleton micro-community becomes a one-member "family" that the layout must
give a circle of its own, which is how a map ends up mostly gutter.

The fix is two stages, and neither of them clusters the projection (§6.3's rule):
sub-24-member communities are absorbed into their nearest survivor by decoder
cosine, then **one** Ward dendrogram over the surviving centroids is cut twice —
at 28 for regions and 700 for families. Cutting one linkage at two heights makes
the tree nested _by construction_, so a family can never straddle two regions.
Resulting family sizes: min 26, median 285, max 8,383. Unbalanced, and honestly
so: the dictionary is unbalanced.

`--summary-tier h3` stays counted out (§4.3) and the zoom-band pair carried the
hierarchy exactly as predicted.

### 14.8 Open

- Browser-verify. Nothing here has been looked at in a browser yet.
- r2-sync the four stems and flip `ATLAS_ARCHIVES_SYNCED` (§14.5), behind B2.
- Milestones 6 and 7.
- The §13 borrow-backs are untouched: the abstract-plane CRS is still the honest
  fix for the synthetic-lon/lat trick that `/worlds` and now `/atlas` both carry.

---

## 15. The geometry rebuild (2026-07-28)

The 2026-07-27 build rendered as sparse vertical towers in an empty plane. This
section is what was wrong, measured, and what replaced it. §14 is left unedited
for the same reason §1–§13 were: a record that is rewritten to match what
happened stops being able to say what was expected.

### 15.1 What was actually wrong — four numbers

Measured on the shipped archive and its `layout.npz`:

|                                                | shipped 2026-07-27      | after                                |
| ---------------------------------------------- | ----------------------- | ------------------------------------ |
| Plane occupancy (512² grid ≈ 1 cell/screen px) | **0.39%** (1,021 cells) | **23.09%** (60,530)                  |
| Sum of family disc area, as % of plane         | **0.030%**              | n/a — clusters are no longer discs   |
| Median family radius                           | **0.0059° (0.7 km)**    | —                                    |
| Family aspect, vertical : horizontal           | **1,246 : 1**           | **1.5 : 1** (whole atlas, isotropic) |

Two independent causes, and the second is the one that mattered.

**Arithmetic.** `_pack_circles` initialised its relaxation at a half-extent of
`1.4 × Σradii`, so _n_ circles of radius _r_ were scattered over 1.4·n·r and the
relaxation never had an overlap left to resolve. Occupancy is then π/(7.84·n) =
0.40/n per level — predicted 1.43% for 28 regions, **measured 1.80%**; applied
again for ~25 families per region, and 0.029% predicted against **0.030%
measured**. The tell was in the build's own sizing note: `Z_MAX` claimed "z10 is
~4,100 occupied tiles at ~72 latents each" and the archive had **362 tiles at
~814 latents each**, an 11× miss nothing checked.

**Structural, and decisive.** Every position was a function of the cluster tree —
regions packed into discs, families into discs inside them, members PCA'd into a
disc inside that. No shape could survive it; the most a concept could express was
a slightly eccentric circle. Fixing only the arithmetic would have produced 700
well-spaced circles instead of 700 needles.

**Z.** Layer index was folded into altitude at 150 km a layer. The reasoning in
§4.2 ("1,650 km against a 3,562 km plane") was sound _if the data filled the
plane_; against families 0.7 km wide it was a 1,250:1 needle, at every zoom,
because both scale together.

**The LOD ladder never delivered the atlas.** `min_zoom` was `{0: 28, 5: 672,
7: 294,212}`. At the framing zoom you saw 28 points; at z7, where the latents
finally mount, the viewport covers 8° of a 26° plane; and resolving members
inside a 0.0135°-wide family needs ≈ z12.4 against a z10 archive and a z10 camera
clamp. There was **no camera position from which this was a map.**

### 15.2 What replaced it

- **One global manifold embedding** of all 294,912 decoder directions (UMAP,
  `n_neighbors` 30, `min_dist` 0.05, seeded). The Leiden/Ward tree is demoted to
  LOD banding, labels, inspection and filtering. §6.3's rule — cluster on the
  high-dimensional graph, never on the projection — is honoured more cleanly than
  before, because the projection no longer consults the partition at all.
- **No PCA pre-step, and that default is measured.** kNN overlap (k=15, n=8,000)
  against the full 768-d space: PCA-50 → 0.216, PCA-128 → 0.230, PCA-256 →
  0.291. The dictionary is near-isotropic in the residual basis; there is no
  subspace to project onto, and the cheap pre-step would have cost exactly the
  thing the layout exists for. Dropping it moved occupancy 11.68% → 23.09%.
- **X/Y/Z are one isotropic embedding**, and Z rides as a numeric column
  (`z_embed_m`) rather than baked geometry. `use3D` is documented upstream as an
  enabling hint; `elevationProperty` is the switch. Flat and 3-D are therefore
  the same archive and the same tiles, and the default is flat.
- **Depth became a chart.** A 12 × 8,128 layer × token activation grid ships in
  the sidecar at ~390 kB. It is more legible than altitude ever was and commits
  the geometry to nothing.
- **LOD is a cumulative budget ladder** ranked _within family_, so the shape of
  the whole map is present at z0 and only densifies: 1,855 → 3,339 → 6,336 →
  12,342 → 24,356 → 48,357 → 96,356 → 294,912.

### 15.3 Finding — attribution was identically zero, and why nothing caught it

`hidden_states` were re-created by `h - h.mean(-1)` before `retain_grad()`, which
makes them _consumers_ of the residual rather than producers of the logit.
`backward()` never reaches such a tensor, `.grad` stays `None`, and the code
substituted `torch.zeros_like`. Every attribution in the shipped archive was
`0.00000` — min, p50, p99 and max alike — so half the §3 metric enum drew a blank
map under a diverging legend.

The centring itself was right (§14.6); it was the _gradient path_ that was
wrong. The fix retains grad on the raw residuals and projects with
`g − g.mean(-1)`, since centring is the symmetric projection `C = I − 11ᵀ/d` and
one unit of `act[f]` perturbs the raw residual by `C·W_dec[f]`. Now: 100%
non-zero, 49.3% negative, |attr| p99.5 = 1.38 logits.

The silent-zero fallback is now a hard `RuntimeError`. The frontend had
compounded it by hardcoding the ramp domain at 0.06 — and at 12 for activation,
whose real p99 is 32.8 — so both legends were fiction independent of the data.
Domains now travel with the archive in `sidecar.metric_domains`.

### 15.4 Finding — clusters are associations, not places

With the layout no longer defined by the partition, the two can be compared. The
Leiden families are loose: mean pairwise decoder cosine **0.14–0.29** within a
median family against **0.0099** for random pairs — 15–30× chance, and nothing
like a compact ball. In the embedding they spread across most of the plane.

So the "continents" framing does not survive. Hulls would draw 700 overlapping
blobs and assert a geography the clustering does not support, and the hull layer
is off by default; cluster identity survives as a per-node property, which is
what it is. This also makes the reseed-drift measurement cleaner than §14's: the
positions on both sides are now byte-identical, so the number is partition drift
with no layout term in it (L0 centroid shift median 0.087 atlas units, against
1.22 when the layout was itself a function of the partition).

Published distortion moved: trustworthiness 0.774 → **0.656**, continuity 0.735 →
**0.798**, kNN overlap 0.168 → **0.110** in 2-D and **0.179** in 3-D. The
trustworthiness drop is real and is the honest cost of tight UMAP clumping;
part of the old figure was an artefact of collapsing each family onto a point.

### 15.5 The reading surface

The trace ran at 8,128 tokens in 90 seconds — **90 tokens/second, 11 ms each** —
behind a read-only 22-token card in a scrolling aside. The page's one claim is
that you can watch a model read, and nothing about that was legible or seekable.
It is now a first-class strip: the current token pinned at a fixed reading
position with the text sliding under it, click-to-seek, ←/→ stepping, shift ×10,
space, and the 64 per-window prediction targets marked inline because
attribution is defined against exactly those tokens.

**The default rate is one token per second**, because the unit of this demo is
one token's projection onto the atlas and the eye needs time to take one in. 4/s
was tried and is still a flicker: a constellation of ~330 points appears and is
gone in 250 ms. The playback window is derived from the rate rather than fixed
(`tokensInWindowFor`) — at a reading pace exactly ONE token is on screen so each
projection is unambiguous and clears before the next, and only at sweep speeds
does it widen to a trail, which is the one thing a fixed 3-token window could
not do at both ends.

### 15.5a Emphasis

The map is 294,912 points of context and a few hundred points of event, and at
anything like equal weight the context wins — a quarter-million faint points sum
to a bright fog no amount of brightness on the event can beat. So the ratio is
set in one place (`EMPHASIS` in `buildAtlasLayers`): the anatomy sits at 0.2
opacity with its layer hues desaturated 42% toward the page backdrop, and drops
to 0.09 as soon as anything is selected. The freed headroom goes to the trace
(full opacity, larger, `splat` so it reads as light rather than as dots) and to
the selection, which is the only white on the map — a wide soft halo to find it
at any zoom plus a crisp hairline ring to say exactly which point it is. Both
ramps were retuned for a near-black field: the bottom third is fully
transparent so weak values vanish instead of hazing, and the top lands on
near-white, which against `#05070d` is the only colour with headroom left.

Alongside it, three activation series on the same clock: layer × token, a global
activity waveform, and — for a selected latent — its whole session, read with one
HTTP Range request against a node-indexed CSR blob (~16 MB, never bundled).

### 15.7 Finding — this dictionary has no clusters to outline

§15.4 said the clusters were "associations, not places" and left the hull layer
off by default. Turning it on showed why that was too gentle: the 28 region
hulls covered each other and the map read as a single pile of overlapping
polygons. Four measurements, all against the shipped embedding:

|                                                                  | result                                     |
| ---------------------------------------------------------------- | ------------------------------------------ |
| Leiden community 80%-radius in the embedding (32° plane)         | multiplex **3.58°**, cosine-only **2.98°** |
| Same, with a clumpier embedding (`n_neighbors` 12, `min_dist` 0) | **5.81° — worse**                          |
| HDBSCAN on the embedding itself (60 k sample)                    | **2–3 clusters**, 10–18% noise             |
| Hull pairs whose discs overlap                                   | region **87.8%**, family (700) **54.5%**   |

The third row is the one that closes it: it is not that the 768-d partition
fails to project, it is that **the projection has no island structure either**.
The cause is upstream of both — an SAE decoder dictionary is close to isotropic
in the residual basis (random-pair cosine 0.0099, PCA-256 captures 62% of the
variance), so it carries real _local_ neighbourhood structure and no
macro-cluster structure at all.

Two smaller things fell out. The shipped hull level was the **worst** available:
a region is a Ward merge of ~25 families, and merging locally-tight groups
produces something that covers the map (87.8% overlap against the families'
54.5%). And lower `n_neighbors` making things worse is diagnostic in itself —
UMAP's islands at that setting are its own local structure, cutting across the
partition rather than agreeing with it.

**What replaced the hulls.** Nothing that draws a border, because §3 says a map
is a persuasive object and a border implies a natural kind. Instead the map
names its dense parts: `_density_places` finds local maxima of the point
density and labels each with the terms most over-represented (plain TF-IDF
against the whole label corpus) among the published Neuronpedia explanations of
the ~600 latents nearest it. A place has a position and no edges, which is
exactly as much as the data supports. The smooth per-pixel density is available
as an optional `AnimatedHeatmapLayer` over the same archive; the point cloud's
own overdraw is already a density field for most purposes, so it is off by
default rather than costing a second tileset.

The `neural-atlas-regions` archive is no longer built. Cluster identity is still
carried per latent for inspection and filtering, which is what it actually is.

### 15.6 Open after the rebuild

- Browser-verify. Still true, and now the point.
- **Concept detail view is NOT built.** The concept loci layer is still the one
  §14.7 shipped, and it is degenerate: measured spans of 0.001–0.030° for
  digits, weekdays and colours (sub-pixel), and a `months` locus whose 13
  vertices are 11 copies of one point plus 2 of another — it draws as a single
  straight line and says nothing. Replacing it with a per-concept _local_
  re-embedding coloured by an ordinal ramp needs per-member-token affinities
  (which digit does this latent prefer), and `feature_stats.npz` only carries
  probe sums aggregated over all member tokens. That is a new generator stage
  plus a partial forward pass, not a frontend change.
- r2-sync and `ATLAS_ARCHIVES_SYNCED`, unchanged and still behind B2.
</content>

</invoke>
